/** Running observations and knowledge stay separate; Python Replay reads history. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { incidentPythonCommand } from '../src/incident-python.js';
import {
  startLocalIncidentDemo,
  runLocalDemoLoad,
} from '../src/incident-local-demo.js';
import { LocalDemoProvider } from '../container/agent-runner/src/incident-live-provider.js';
import { RunbookIndex } from '../container/agent-runner/src/incident-runbooks.js';
import {
  IncidentRunbookSearch,
  incidentInvestigationContext,
  readRecordedKnowledge,
} from '../container/agent-runner/src/incident-knowledge.js';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import { JsonlIncidentEvents } from '../container/agent-runner/src/incident-agent-events.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonHost = incidentPythonCommand(root);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v030-step4-'));
let demo: Awaited<ReturnType<typeof startLocalIncidentDemo>> | undefined;
try {
  const bookDir = path.join(tmp, 'runbooks');
  fs.mkdirSync(bookDir);
  const manifest = JSON.parse(
    fs.readFileSync(path.join(root, 'runbooks', 'manifest.json'), 'utf8'),
  );
  fs.copyFileSync(
    path.join(root, 'runbooks', 'manifest.json'),
    path.join(bookDir, 'manifest.json'),
  );
  for (const d of manifest.documents)
    fs.copyFileSync(
      path.join(root, 'runbooks', d.file),
      path.join(bookDir, d.file),
    );
  const index = RunbookIndex.load(bookDir),
    id = `LIVE-${randomUUID()}`,
    run = `accept-${randomUUID()}`;
  const read = randomBytes(32).toString('hex'),
    control = randomBytes(32).toString('hex');
  demo = await startLocalIncidentDemo({
    source_id: 'step4-pool',
    service: 'orders',
    environment: 'local',
    read_token: read,
    control_token: control,
    sample_interval_ms: 20,
  });
  const configured = await fetch(`${demo.base_url}/control/config`, {
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
  assert.equal(configured.status, 200);
  await configured.body?.cancel();
  const load = await runLocalDemoLoad(demo.base_url, read, 6, 6);
  assert.ok(load.resource_failures > 0);
  const now = Date.now(),
    provider = new LocalDemoProvider(
      [
        {
          source_id: 'step4-pool',
          base_url: demo.base_url,
          instance_id: demo.instance_id,
          service: 'orders',
          environment: 'local',
          read_token: read,
        },
      ],
      [
        {
          incident_id: id,
          source_id: 'step4-pool',
          service: 'orders',
          environment: 'local',
          allowed_from: new Date(now - 60000).toISOString(),
          allowed_to: new Date(now + 14 * 60000).toISOString(),
        },
      ],
      run,
    );
  const eventsDir = path.join(tmp, 'events'),
    events = new JsonlIncidentEvents(eventsDir),
    gate = new IncidentApprovalGate({ events });
  // Host-created probe Incident, no worker, model, diagnosis or state transition.
  events.emit(id, 'IncidentCreated', {
    status: 'RECEIVED',
    service: 'orders',
    environment: 'local',
    run_id: run,
  });
  const search = new IncidentRunbookSearch(
    index,
    [
      {
        incident_id: id,
        service: 'orders',
        environment: 'local',
        allowed_doc_ids: manifest.documents.map(
          (d: { doc_id: string }) => d.doc_id,
        ),
      },
    ],
    run,
  );
  const tools = adaptClaudeMcpToolsToPi(
    createMcpTools({
      chatJid: 'step4-local',
      groupFolder: 'step4-local',
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      workspaceIpc: tmp,
      workspaceGroup: tmp,
      incidentApprovalGate: gate,
      incidentProviderRoute: { mode: 'live', provider },
      incidentRunbookSearch: search,
    }),
    { namespace: 'step4' },
  );
  const call = async (name: string, params: Record<string, unknown>) => {
    const result = await tools
      .find((t) => t.name === `step4__${name}`)!
      .execute(
        randomUUID(),
        { incident_id: id, ...params },
        undefined,
        undefined,
        undefined as never,
      );
    const text = result.content.find((c) => c.type === 'text');
    if (!text || text.type !== 'text') throw Error('invalid_text_result');
    return JSON.parse(text.text);
  };
  const observation = await call('query_live_metrics', {});
  assert.ok(JSON.parse(observation.content).items.at(-1).acquire_timeouts > 0);
  const found = await call('search_runbooks', {
    query: 'pool_waiting acquire timeout',
    top_k: 3,
  });
  assert.equal(found.references[0].doc_id, 'resource-pool');
  const empty = await call('search_runbooks', { query: 'zxqv_unknown' });
  assert.equal(empty.status, 'no_match');
  const view = incidentInvestigationContext(
    gate.evidence,
    search.context,
    id,
    run,
  );
  assert.equal(view.observed_evidence.length, 1);
  assert.equal(view.knowledge_references.length, 3);
  assert.equal(
    events.snapshot().filter((e) => e.event_type === 'EvidenceCollected')
      .length,
    1,
  );
  const recorded = fs
    .readFileSync(path.join(eventsDir, `${id}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  fs.appendFileSync(
    path.join(bookDir, 'resource-pool.md'),
    '\n\n## Additional note\n\nRetain incident observations independently.\n',
  );
  assert.notEqual(RunbookIndex.load(bookDir).catalog_hash, index.catalog_hash);
  await demo.close();
  demo = undefined;
  index.search = () => {
    throw Error('history_must_not_search');
  };
  const history = readRecordedKnowledge(recorded, id, run);
  assert.deepEqual(history, view.knowledge_references);
  const python = [
    'import json,sys',
    'from pathlib import Path',
    'from incident_agent.replay import load_events,reconstruct_runs',
    'runs=reconstruct_runs(load_events(sys.argv[1],Path(sys.argv[2])))',
    'assert len(runs)==1 and len(runs[0].evidence_ids)==1',
    "assert runs[0].status.value=='RECEIVED' and not runs[0].executed_actions",
    "print(json.dumps({'replay':'PASS','runs':len(runs),'evidence_count':len(runs[0].evidence_ids),'status':runs[0].status.value}))",
  ].join('\n');
  const replay = JSON.parse(
    execFileSync(
      pythonHost.executable,
      [...pythonHost.prefix, '-B', '-c', python, id, eventsDir],
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
        observed_evidence: view.observed_evidence.length,
        knowledge_references: history.length,
        event_count: recorded.length,
        knowledge_not_evidence: true,
        history_survives_changed_documents: true,
        history_search_calls: 0,
        no_match: empty.status,
        source_stopped_before_history: true,
        ...replay,
        model_calls: 0,
        production_connected: false,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    'Step 4 acceptance failed:',
    error instanceof Error ? error.message : 'unknown',
  );
  process.exitCode = 1;
} finally {
  await demo?.close();
  if (
    path.dirname(path.resolve(tmp)) !== path.resolve(os.tmpdir()) ||
    !path.basename(tmp).startsWith('v030-step4-')
  )
    throw Error('unsafe_temp_path');
  fs.rmSync(tmp, { recursive: true, force: true });
}
