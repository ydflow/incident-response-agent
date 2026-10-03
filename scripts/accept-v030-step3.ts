/** Real local HTTP → bounded Provider → SAFE → events/Evidence, no model. */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  startLocalIncidentDemo,
  runLocalDemoLoad,
} from '../src/incident-local-demo.js';
import { IncidentStore, createIncidentSchema } from '../src/incident-store.js';
import { normalizeAlerts } from '../src/incident-alert-types.js';
import { LocalDemoProvider } from '../container/agent-runner/src/incident-live-provider.js';
import { FixtureProvider } from '../container/agent-runner/src/incident-provider-tools.js';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import { JsonlIncidentEvents } from '../container/agent-runner/src/incident-agent-events.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { checkLocalDemoCli } from './incident-local-demo-cli-check.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v030-step3-local-'));
const db = new Database(path.join(tmp, 'acceptance.db'));
db.pragma('foreign_keys=ON');
let demo: Awaited<ReturnType<typeof startLocalIncidentDemo>> | undefined;
const read = randomBytes(32).toString('hex'),
  control = randomBytes(32).toString('hex');
const parseResult = (result: {
  content: Array<{ type: string; text?: string }>;
}) => {
  const part = result.content[0];
  if (part?.type !== 'text' || typeof part.text !== 'string')
    throw new Error('invalid_tool_result');
  return JSON.parse(part.text);
};
try {
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('local-owner');",
  );
  createIncidentSchema(db);
  demo = await startLocalIncidentDemo({
    source_id: 'pool-local',
    service: 'orders',
    environment: 'local',
    read_token: read,
    control_token: control,
    sample_interval_ms: 20,
  });
  const configure = async (config: unknown) => {
    const r = await fetch(`${demo!.base_url}/control/config`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${control}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(config),
    });
    assert.equal(r.status, 200);
    await r.body?.cancel();
  };
  await configure({
    capacity: 1,
    hold_ms: 500,
    acquire_timeout_ms: 50,
    query_delay_ms: 0,
  });
  const faulty = await runLocalDemoLoad(demo.base_url, read, 12, 8);
  assert.ok(faulty.resource_failures > 0);
  // Manual alert input derived from our measured local failure. No rule engine,
  // real Alertmanager or automatic task is claimed at this stage.
  const store = new IncidentStore(db);
  const alert = normalizeAlerts('webhook', {
    source: 'demo',
    service: 'orders',
    environment: 'local',
    severity: 'critical',
    external_id: 'pool-local-probe',
    fingerprint: 'connection-pool',
    starts_at: new Date().toISOString(),
    status: 'firing',
    summary: 'Local resource-slot acquisition failures observed',
  });
  const receipt = store.ingest(
    'local-owner',
    { all: true, grants: [] },
    'webhook',
    alert.alerts,
    0,
    'step3-local-alert',
  );
  const id = receipt.items[0].incident_id;
  const record = store.getIncident({ all: true, grants: [] }, id)!;
  const now = Date.now();
  const source = {
    source_id: 'pool-local',
    service: record.incident.service,
    environment: record.metadata.environment,
    base_url: demo.base_url,
    read_token: read,
    instance_id: demo.instance_id,
  };
  const binding = {
    incident_id: id,
    source_id: 'pool-local',
    service: record.incident.service,
    environment: record.metadata.environment,
    allowed_from: new Date(now - 60000).toISOString(),
    allowed_to: new Date(now + 14 * 60000).toISOString(),
  };
  const provider = new LocalDemoProvider(
    [source],
    [binding],
    `accept-${randomUUID()}`,
  );
  const events = new JsonlIncidentEvents(path.join(tmp, 'events'));
  const gate = new IncidentApprovalGate({ events });
  const tools = adaptClaudeMcpToolsToPi(
    createMcpTools({
      chatJid: 'local:step3',
      groupFolder: 'local-demo',
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      workspaceIpc: tmp,
      workspaceGroup: tmp,
      incidentProviderRoute: { mode: 'live', provider },
      incidentApprovalGate: gate,
    }),
    { namespace: 'mcp__incident_live' },
  );
  const call = async (kind: string, params: Record<string, unknown> = {}) => {
    // SDK has five arguments; our existing Pi adapter reads only the first
    // three. This standalone host probe has no model/ExtensionContext.
    const result = await tools
      .find((t) => t.name === `mcp__incident_live__query_live_${kind}`)!
      .execute(
        `accept-${randomUUID()}`,
        { incident_id: id, ...params },
        new AbortController().signal,
        undefined,
        undefined as never,
      );
    return parseResult(result);
  };
  const first = await call('metrics'),
    second = await call('metrics'),
    logs = await call('logs');
  assert.notEqual(first.evidence_id, second.evidence_id);
  assert.equal(gate.evidence.forIncident(id).length, 3);
  const faultyMetrics = JSON.parse(first.content).items.at(-1);
  assert.ok(faultyMetrics.acquire_timeouts > 0);
  assert.equal(faultyMetrics.pool_capacity, 1);
  assert.ok(
    JSON.parse(logs.content).items.some(
      (item: { message: string }) => item.message === 'pool_timeout',
    ),
  );
  for (const kind of ['trace', 'git_diff'])
    assert.equal((await call(kind)).error, 'unsupported');
  for (const params of [
    { source_id: 'other' },
    { service: 'other' },
    { environment: 'prod' },
  ])
    assert.equal((await call('logs', params)).error, 'scope_denied');
  assert.equal(
    (
      await call('logs', {
        from: new Date(now - 16 * 60000).toISOString(),
        to: new Date().toISOString(),
      })
    ).error,
    'time_window_denied',
  );
  const empty = await call('logs', {
    from: new Date(now - 30000).toISOString(),
    to: new Date(now - 20000).toISOString(),
  });
  assert.equal(JSON.parse(empty.content).status, 'empty');
  await configure({
    capacity: 8,
    hold_ms: 10,
    acquire_timeout_ms: 500,
    query_delay_ms: 0,
  });
  const recovery = await runLocalDemoLoad(demo.base_url, read, 12, 8);
  assert.equal(recovery.success, 12);
  assert.equal(recovery.resource_failures, 0);
  const recovered = JSON.parse((await call('metrics')).content).items.at(-1);
  assert.equal(recovered.requests_success - faultyMetrics.requests_success, 12);
  assert.equal(recovered.acquire_timeouts, faultyMetrics.acquire_timeouts);
  await configure({
    capacity: 8,
    hold_ms: 10,
    acquire_timeout_ms: 500,
    query_delay_ms: 150,
  });
  const short = new LocalDemoProvider(
    [{ ...source, timeout_ms: 20 }],
    [binding],
    'short-timeout',
  );
  assert.equal(
    parseResult(await short.query('metrics', { incident_id: id })).error,
    'timeout',
  );
  const cancelled = new AbortController();
  cancelled.abort();
  assert.equal(
    parseResult(
      await provider.query('metrics', { incident_id: id }, cancelled.signal),
    ).error,
    'cancelled',
  );
  const evidenceBeforeStop = gate.evidence.forIncident(id).length;
  await demo.close();
  assert.equal((await call('logs')).error, 'unavailable');
  assert.equal(gate.evidence.forIncident(id).length, evidenceBeforeStop);
  const fixtureProvider = new FixtureProvider(
    path.resolve('incident_agent/fixtures'),
  );
  for (let i = 1; i <= 12; i++)
    for (const tool of fixtureProvider.tools())
      assert.notEqual(
        (
          await tool.handler(
            { incident_id: `INC-${String(i).padStart(3, '0')}` },
            {},
          )
        ).isError,
        true,
      );
  const persisted = fs
    .readFileSync(path.join(tmp, 'events', `${id}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(persisted.some((e) => e.event_type === 'EvidenceCollected'));
  assert.ok(persisted.some((e) => e.event_type === 'ToolFailed'));
  assert.equal(
    store.getIncident({ all: true, grants: [] }, id)!.metadata.status,
    'RECEIVED',
  );
  const cli = await checkLocalDemoCli();
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        data_source: 'running own loopback Node resource-slot demo',
        fault_requests: 12,
        fault_resource_failures: faulty.resource_failures,
        recovery_requests: 12,
        recovery_successes: 12,
        evidence_collected: evidenceBeforeStop,
        event_count: persisted.length,
        unique_evidence_ids: true,
        empty_result: 'Evidence with bounded empty observations',
        timeout: 'timeout',
        cancelled: 'cancelled',
        stopped_source: 'unavailable',
        trace_git: 'unsupported',
        scope_and_window: 'rejected',
        fixture_queries: 48,
        investigation_status: 'RECEIVED',
        model_calls: 0,
        production_connected: false,
        automatic_investigation_task: false,
        ...cli,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    'Step 3 acceptance failed:',
    error instanceof Error ? error.message : 'unknown_error',
  );
  process.exitCode = 1;
} finally {
  await demo?.close();
  db.close();
  if (
    path.dirname(path.resolve(tmp)) !== path.resolve(os.tmpdir()) ||
    !path.basename(tmp).startsWith('v030-step3-local-')
  )
    throw new Error('unexpected_temporary_path');
  fs.rmSync(tmp, { recursive: true, force: true });
}
