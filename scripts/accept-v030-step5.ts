/** Owned real local resource service + independent SQLite + actual Runner; no fake model answer. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { incidentPythonCommand } from '../src/incident-python.js';
import { investigationDb } from '../tests/helpers/incident-investigation-db.js';
import { sourceScope } from '../src/incident-alert-types.js';
import { IncidentInvestigationWorker } from '../src/incident-investigation-worker.js';
import {
  startLocalIncidentDemo,
  runLocalDemoLoad,
} from '../src/incident-local-demo.js';
import {
  exportInvestigationReplay,
  investigationHistory,
} from '../src/incident-investigation-history.js';
import { resolveConfiguredIncidentModel } from '../src/incident-configured-model.js';
import { Hono } from 'hono';
import { createIncidentAlertRoutes } from '../src/routes/incident-alerts.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v030-step5-'));
const pythonHost = incidentPythonCommand(root);
let demo: Awaited<ReturnType<typeof startLocalIncidentDemo>> | undefined,
  fixture: ReturnType<typeof investigationDb> | undefined;
try {
  fixture = investigationDb(path.join(tmp, 'independent.db'));
  const read = randomBytes(32).toString('hex'),
    control = randomBytes(32).toString('hex');
  demo = await startLocalIncidentDemo({
    source_id: 'step5-pool',
    service: 'orders',
    environment: 'local',
    read_token: read,
    control_token: control,
    sample_interval_ms: 20,
  });
  const config = await fetch(`${demo.base_url}/control/config`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${control}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      capacity: 1,
      hold_ms: 100,
      acquire_timeout_ms: 20,
      query_delay_ms: 0,
    }),
  });
  assert.equal(config.status, 200);
  await config.body?.cancel();
  const load = await runLocalDemoLoad(demo.base_url, read, 6, 6);
  assert.ok(load.resource_failures > 0);
  const app = new Hono();
  app.route(
    '/api/incident-alerts',
    createIncidentAlertRoutes({
      store: () => fixture!.alerts,
      investigations: () => fixture!.store,
      getUser: (id) =>
        id === 'owner'
          ? {
              id,
              username: 'owner',
              display_name: 'Test owner',
              role: 'member',
              status: 'active',
              permissions: ['ingest_alerts'],
              must_change_password: false,
            }
          : undefined,
    }),
  );
  const credential = fixture.alerts.issueCredential({
    owner_user_id: 'owner',
    source: 'step5-demo',
    scopes: [{ service: 'orders', environment: 'local' }],
    expires_at: new Date(Date.now() + 300000).toISOString(),
  });
  const input = {
    source: 'step5-demo',
    external_id: 'pool-1',
    service: 'orders',
    environment: 'local',
    severity: 'critical',
    fingerprint: 'pool',
    starts_at: new Date(Date.now() - 10000).toISOString(),
    status: 'firing',
    summary: 'Connection pool exhausted pool_waiting acquire timeout',
  };
  const post = () =>
    app.request('/api/incident-alerts/webhook', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.token}`,
        'content-type': 'application/json',
        'idempotency-key': 'step5-duplicate',
      },
      body: JSON.stringify(input),
    });
  const response = await post();
  assert.equal(response.status, 201);
  const receipt = (await response.json()) as any,
    id = receipt.items[0].incident_id;
  assert.equal(((await (await post()).json()) as any).duplicate, true);
  assert.equal(fixture.store.list(id).length, 1);
  const configured = process.argv.includes('--configured-model')
    ? resolveConfiguredIncidentModel()
    : { config: null, reason: 'model_not_requested' };
  const worker = new IncidentInvestigationWorker(fixture.store, {
    repo_root: root,
    incident_id: id,
    wall_ms: 60000,
    max_model_requests: 3,
    model: configured.config,
    sources: [
      {
        source_scope: sourceScope('owner', 'step5-demo'),
        source_id: 'step5-pool',
        service: 'orders',
        environment: 'local',
        base_url: demo.base_url,
        read_token: read,
        instance_id: demo.instance_id,
      },
    ],
  });
  let result: Awaited<ReturnType<typeof worker.tick>>;
  if (process.argv.includes('--worker-process')) {
    const sourceFile = path.join(tmp, 'private-source.json');
    fs.writeFileSync(
      sourceFile,
      JSON.stringify([
        {
          source_scope: sourceScope('owner', 'step5-demo'),
          source_id: 'step5-pool',
          service: 'orders',
          environment: 'local',
          base_url: demo.base_url,
          read_token: read,
          instance_id: demo.instance_id,
        },
      ]),
      { flag: 'wx', mode: 0o600 },
    );
    fixture.db.close();
    const child = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        path.join(root, 'scripts', 'incident-investigation-worker.ts'),
        '--db',
        path.join(tmp, 'independent.db'),
        '--source-config',
        sourceFile,
        ...(process.argv.includes('--configured-model')
          ? ['--configured-model']
          : []),
      ],
      { cwd: root, timeout: 80000, windowsHide: true, maxBuffer: 65536 },
    );
    result = JSON.parse(child.stdout.trim().split('\n').at(-1)!);
    fixture = investigationDb(path.join(tmp, 'independent.db'));
    fs.unlinkSync(sourceFile);
  } else result = await worker.tick();
  assert.ok(result);
  assert.equal(fixture.store.claim('accept-late'), null);
  const detail = fixture.store.detail(id, result.run_id);
  assert.ok(
    detail.observed_evidence.length >= 2,
    `evidence count ${detail.observed_evidence.length}; reason ${result.reason}`,
  );
  assert.ok(detail.knowledge_references.length > 0);
  assert.ok(detail.events.some((e) => e.event_type === 'EvidenceCollected'));
  assert.ok(
    detail.observed_evidence.some(
      (e) =>
        e.source === 'metrics' &&
        JSON.parse(e.content).items.some((i: any) => i.acquire_timeouts > 0),
    ),
  );
  assert.equal(detail.report.execution_authorized, false);
  if (!configured.config) {
    assert.equal(result.state, 'blocked');
    assert.equal(detail.run.status, 'ESCALATED');
    assert.equal(detail.run.model_requests, 0);
  }
  await demo.close();
  demo = undefined;
  fixture.db.close();
  fixture = investigationDb(path.join(tmp, 'independent.db'));
  const history = investigationHistory(fixture.store, id, result.run_id);
  assert.deepEqual(history.observed_evidence, detail.observed_evidence);
  const api = await app.request(
    `/api/incident-alerts/incidents/${id}/investigations/${result.run_id}`,
    { headers: { authorization: `Bearer ${credential.token}` } },
  );
  assert.equal(api.status, 200);
  assert.equal(((await api.json()) as any).report.execution_authorized, false);
  const directory = path.join(tmp, 'history');
  exportInvestigationReplay(fixture.store, id, result.run_id, directory);
  const code =
    "from pathlib import Path\nimport sys,json\nfrom incident_agent.replay import load_events,reconstruct_runs\nr=reconstruct_runs(load_events(sys.argv[1],Path(sys.argv[2])))\nassert len(r)==1 and not r[0].executed_actions\nprint(json.dumps({'replay_status':r[0].status.value,'replay_evidence':len(r[0].evidence_ids)}))";
  const replay = JSON.parse(
    execFileSync(
      pythonHost.executable,
      [...pythonHost.prefix, '-B', '-c', code, id, directory],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      },
    ),
  );
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        job_state: result.state,
        reason: result.reason,
        model_configuration: configured.reason,
        mode: detail.run.mode,
        model_http_requests: detail.run.model_requests,
        model_tool_calls: detail.events.filter(
          (e) =>
            e.event_type === 'ToolCalled' &&
            e.payload.origin === 'pi_model_tool_call',
        ).length,
        tool_calls: detail.run.tool_calls,
        evidence: detail.observed_evidence.length,
        knowledge: detail.knowledge_references.length,
        events: detail.events.length,
        authenticated_webhook: true,
        scoped_query_api: true,
        restart_query: true,
        source_stopped_before_replay: true,
        execution_authorized: false,
        production_connected: false,
        ...replay,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    'Step 5 acceptance failed:',
    error instanceof Error ? error.message : 'unknown',
  );
  process.exitCode = 1;
} finally {
  await demo?.close();
  if (fixture?.db.open) fixture.db.close();
  if (
    path.dirname(tmp) !== os.tmpdir() ||
    !path.basename(tmp).startsWith('v030-step5-')
  )
    throw Error('unsafe_test_path');
  fs.rmSync(tmp, { recursive: true, force: true });
}
