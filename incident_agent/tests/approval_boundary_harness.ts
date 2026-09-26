/** Called by pytest to exercise the real MiniClaw ToolCall -> Approval Gate path. */
import os from 'node:os';
import path from 'node:path';
import { IncidentApprovalGate } from '../../container/agent-runner/src/incident-approval-gate.js';
import {
  simulateRemediation,
  type RemediationRequest,
} from '../../container/agent-runner/src/incident-remediation-tools.js';
import { createMcpTools } from '../../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../../container/agent-runner/src/runtime/pi/pi-tools.js';

const action = process.argv[2];
const scenario = process.argv[3];
if (!['restart_service', 'rollback_config', 'modify_config'].includes(action)) {
  throw new Error('Unknown test action.');
}
if (scenario !== 'unapproved' && scenario !== 'rejected') {
  throw new Error('Unknown test scenario.');
}

function parseResult(value: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = value.content[0]?.text;
  if (!text) throw new Error('Tool returned no result text.');
  return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  // This spy wraps the real simulated Executor. The assertion is whether the
  // Approval Gate ever calls it, not what message the tool returns.
  let executorCalled = false;
  const gate = new IncidentApprovalGate({
    executor: async (request: RemediationRequest) => {
      executorCalled = true;
      return simulateRemediation(request);
    },
  });
  const definitions = createMcpTools({
    chatJid: 'pytest:approval-boundary',
    groupFolder: 'pytest',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    workspaceIpc: path.join(os.tmpdir(), 'unused-approval-boundary-ipc'),
    workspaceGroup: path.join(os.tmpdir(), 'unused-approval-boundary-group'),
    incidentApprovalGate: gate,
  });
  const selected = definitions.filter((tool) => tool.name === action);
  if (selected.length !== 1)
    throw new Error('Remediation tool registration failed.');
  const [tool] = adaptClaudeMcpToolsToPi(selected, {
    namespace: 'mcp__miniclaw',
  });
  const result = await tool.execute(
    `pytest-${action}-${scenario}`,
    {
      incident_id: 'INC-001',
      target: 'payment-service',
      ...(action === 'modify_config'
        ? { config_key: 'max_connections', proposed_value: '50' }
        : {}),
    },
    new AbortController().signal,
  );
  const proposed = parseResult(result);
  if (typeof proposed.approval_id !== 'string') {
    throw new Error('ASK ToolCall did not create an approval request.');
  }

  let rejection: Record<string, unknown> | undefined;
  let postRejectAllow: Record<string, unknown> | undefined;
  if (scenario === 'rejected') {
    rejection = parseResult(
      await gate.reject(proposed.approval_id, 'human:pytest'),
    );
    postRejectAllow = parseResult(
      await gate.allow(proposed.approval_id, 'human:pytest'),
    );
  }
  process.stdout.write(
    JSON.stringify({
      action,
      scenario,
      tool_status: proposed.status,
      approval_state: proposed.approval_state,
      reject_status: rejection?.status,
      post_reject_allow_status: postRejectAllow?.status,
      executor_called: executorCalled,
    }),
  );
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
