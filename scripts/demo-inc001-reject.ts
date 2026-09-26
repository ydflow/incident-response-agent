/** A scripted MiniClaw ToolCall followed by a demo-only trusted-host Reject. */
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import { JsonlIncidentEvents } from '../container/agent-runner/src/incident-agent-events.js';
import {
  simulateRemediation,
  type RemediationRequest,
} from '../container/agent-runner/src/incident-remediation-tools.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

function parseResult(value: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = value.content[0]?.text;
  if (!text) throw new Error('Tool result has no text.');
  return JSON.parse(text) as Record<string, unknown>;
}

async function main(): Promise<void> {
  let executorCalled = false;
  const runDirectory = process.env.MINICLAW_INCIDENT_RUNS_DIR;
  const gate = new IncidentApprovalGate({
    events: runDirectory ? new JsonlIncidentEvents(runDirectory) : undefined,
    executor: async (request: RemediationRequest) => {
      executorCalled = true;
      return simulateRemediation(request);
    },
  });
  const definitions = createMcpTools({
    chatJid: 'demo:INC-001:stage4',
    groupFolder: 'demo',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    workspaceIpc: path.join(os.tmpdir(), 'unused-inc001-stage4-ipc'),
    workspaceGroup: path.join(os.tmpdir(), 'unused-inc001-stage4-group'),
    incidentApprovalGate: gate,
  }).filter((tool) => tool.name === 'rollback_config');
  if (definitions.length !== 1)
    throw new Error('rollback_config is unavailable');
  const [tool] = adaptClaudeMcpToolsToPi(definitions, {
    namespace: 'mcp__miniclaw',
  });
  const proposal = parseResult(
    await tool.execute(
      'demo-inc001-rollback',
      { incident_id: 'INC-001', target: 'payment-service' },
      new AbortController().signal,
    ),
  );
  if (
    proposal.status !== 'approval_required' ||
    typeof proposal.approval_id !== 'string' ||
    executorCalled
  ) {
    throw new Error('Rollback did not stop at the approval boundary.');
  }
  const requestEventCount = gate.events.snapshot().length;
  process.stdout.write(
    `${JSON.stringify({ phase: 'requested', proposal, events: gate.events.snapshot(), executor_called: executorCalled })}\n`,
  );

  // The Python demo advances the real IncidentLifecycle before sending Reject.
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let decision: string | undefined;
  for await (const line of input) {
    decision = line.trim();
    break;
  }
  input.close();
  if (decision !== 'reject')
    throw new Error('Explicit reject input is required.');
  const rejection = parseResult(
    await gate.reject(proposal.approval_id, 'demo:scripted-reject'),
  );
  if (rejection.status !== 'rejected' || executorCalled) {
    throw new Error(
      'Reject reached the executor or returned the wrong status.',
    );
  }
  process.stdout.write(
    `${JSON.stringify({ phase: 'rejected', rejection, events: gate.events.snapshot().slice(requestEventCount), executor_called: executorCalled })}\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
