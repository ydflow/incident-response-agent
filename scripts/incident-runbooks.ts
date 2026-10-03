/** Operator query probe: host binding -> MCP SAFE -> events -> separate view. */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { RunbookIndex } from '../container/agent-runner/src/incident-runbooks.js';
import {
  IncidentRunbookSearch,
  incidentInvestigationContext,
} from '../container/agent-runner/src/incident-knowledge.js';
import { FixtureProvider } from '../container/agent-runner/src/incident-provider-tools.js';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const allowed = [
  'resource-pool',
  'dependency-timeout',
  'deployment-anomaly',
  'disk-pressure',
  'task-backlog',
];
try {
  const options: Record<string, string> = {};
  const keys = new Set([
    '--query',
    '--service',
    '--environment',
    '--incident-id',
    '--top-k',
  ]);
  const flags = process.argv.slice(2);
  if (flags.length % 2) throw new Error('expected flag/value pairs');
  for (let i = 0; i < flags.length; i += 2) {
    if (!keys.has(flags[i]) || Object.hasOwn(options, flags[i]))
      throw new Error('invalid or duplicate flag');
    options[flags[i]] = flags[i + 1];
  }
  const incident = options['--incident-id'] ?? `LIVE-${randomUUID()}`;
  const gate = new IncidentApprovalGate();
  const search = new IncidentRunbookSearch(
    RunbookIndex.load(path.join(repo, 'runbooks')),
    [
      {
        incident_id: incident,
        service: options['--service'] ?? 'payment-service',
        environment: options['--environment'] ?? 'local',
        allowed_doc_ids: allowed,
      },
    ],
    `probe-${randomUUID()}`,
  );
  const tools = createMcpTools({
    chatJid: 'runbook-probe',
    groupFolder: 'runbook-probe',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    workspaceIpc: '',
    workspaceGroup: '',
    incidentApprovalGate: gate,
    incidentProviderRoute: { mode: 'fixture', provider: new FixtureProvider() },
    incidentRunbookSearch: search,
  });
  const adapted = adaptClaudeMcpToolsToPi(tools, {
    namespace: 'mcp__incident_probe',
  });
  const tool = adapted.find(
    (t) => t.name === 'mcp__incident_probe__search_runbooks',
  )!;
  const result = await tool.execute(
    randomUUID(),
    {
      incident_id: incident,
      query: options['--query'] ?? '连接池耗尽 获取连接超时',
      top_k: Number(options['--top-k'] ?? 3),
    },
    undefined,
    undefined,
    undefined as never,
  );
  if ((result.details as { isError?: boolean })?.isError) process.exitCode = 1;
  console.log(
    JSON.stringify(
      {
        tool_result: result,
        investigation_context: incidentInvestigationContext(
          gate.evidence,
          search.context,
          incident,
          search.run_id,
        ),
        event_types: gate.events.snapshot().map((e) => e.event_type),
        model_calls: 0,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : 'runbook_probe_failed',
  );
  process.exitCode = 1;
}
