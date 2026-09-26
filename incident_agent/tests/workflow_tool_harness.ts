/** Deterministic bridge: real MiniClaw Tool + Policy + Evidence + Event paths. */
import os from 'node:os';
import path from 'node:path';
import { IncidentApprovalGate } from '../../container/agent-runner/src/incident-approval-gate.js';
import { createMcpTools } from '../../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../../container/agent-runner/src/runtime/pi/pi-tools.js';

const incidentId = process.argv[2];
if (!/^INC-\d{3}$/.test(incidentId ?? '')) {
  throw new Error('Expected an INC-xxx case ID.');
}

const names = ['query_logs', 'query_metrics', 'query_trace', 'query_git_diff'];

async function main(): Promise<void> {
  const gate = new IncidentApprovalGate({
    executor: async () => {
      throw new Error('Workflow acceptance must never invoke remediation.');
    },
  });
  const workspace = path.join(os.tmpdir(), 'miniclaw-workflow-acceptance');
  const definitions = createMcpTools({
    chatJid: `pytest:workflow:${incidentId}`,
    groupFolder: 'pytest',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    workspaceIpc: path.join(workspace, 'unused-ipc'),
    workspaceGroup: workspace,
    incidentApprovalGate: gate,
  }).filter((tool) => names.includes(tool.name));
  if (definitions.length !== names.length) {
    throw new Error('Not all four evidence tools are registered.');
  }
  const tools = adaptClaudeMcpToolsToPi(definitions, {
    namespace: 'mcp__miniclaw',
  });
  for (const name of names) {
    const tool = tools.find((item) => item.name === `mcp__miniclaw__${name}`);
    if (!tool) throw new Error(`Missing Pi tool: ${name}`);
    const outcome = await tool.execute(
      `workflow-${incidentId}-${name}`,
      { incident_id: incidentId },
      new AbortController().signal,
    );
    if ((outcome.details as { isError?: boolean })?.isError) {
      throw new Error(`${name} returned an error for ${incidentId}`);
    }
  }
  process.stdout.write(
    JSON.stringify({
      evidence: gate.evidence.forIncident(incidentId),
      events: gate.events.snapshot(),
    }),
  );
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
