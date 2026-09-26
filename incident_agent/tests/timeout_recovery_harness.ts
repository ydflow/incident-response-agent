/** Exercise a delayed incident ToolCall through Pi and the real event wrapper. */
import path from 'node:path';
import { JsonlIncidentEvents } from '../../container/agent-runner/src/incident-agent-events.js';
import { IncidentApprovalGate } from '../../container/agent-runner/src/incident-approval-gate.js';
import { withIncidentToolEvents } from '../../container/agent-runner/src/incident-tool-events.js';
import { createMcpTools } from '../../container/agent-runner/src/mcp-tools.js';
import type { McpToolDefinition } from '../../container/agent-runner/src/mcp-tool-types.js';
import { adaptClaudeMcpToolsToPi } from '../../container/agent-runner/src/runtime/pi/pi-tools.js';

const target = process.argv[2];
const runDirectory = process.argv[3];
if (!['query_logs', 'query_metrics', 'query_trace'].includes(target)) {
  throw new Error('Expected one timeout target.');
}
if (!runDirectory) throw new Error('A JSONL directory is required.');

function parseResult(value: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = value.content[0]?.text;
  if (!text) throw new Error('Tool returned no JSON text.');
  return JSON.parse(text) as Record<string, unknown>;
}

async function invoke(
  definition: McpToolDefinition<any>,
  callId: string,
): Promise<Record<string, unknown>> {
  const [tool] = adaptClaudeMcpToolsToPi([definition], {
    namespace: 'mcp__miniclaw',
  });
  return parseResult(
    await tool.execute(
      callId,
      { incident_id: 'INC-001' },
      new AbortController().signal,
    ),
  );
}

async function delayUntilAborted(signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(resolve, 200);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

async function main(): Promise<void> {
  const events = new JsonlIncidentEvents(runDirectory);
  const gate = new IncidentApprovalGate({ events });
  const definitions = createMcpTools({
    chatJid: `pytest:timeout:${target}`,
    groupFolder: 'pytest',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    workspaceIpc: path.join(runDirectory, 'unused-ipc'),
    workspaceGroup: runDirectory,
    incidentApprovalGate: gate,
  });
  const byName = (name: string) => {
    const definition = definitions.find((tool) => tool.name === name);
    if (!definition) throw new Error(`Missing incident tool: ${name}`);
    return definition;
  };

  const before = await invoke(byName('query_git_diff'), 'before-timeout');
  if (before.evidence_id !== 'INC-001:git_diff') {
    throw new Error('Previous evidence was not collected.');
  }
  const previousEvidence = gate.evidence.forIncident('INC-001')[0];
  if (!previousEvidence?.content) {
    throw new Error('Previous Evidence object was not retained.');
  }
  const priorEventIds = events.snapshot().map((event) => event.event_id);
  const actualTarget = byName(target);
  const delayed = withIncidentToolEvents(
    {
      ...actualTarget,
      handler: async (args, extra) => {
        await delayUntilAborted((extra as { signal: AbortSignal }).signal);
        return actualTarget.handler(args, extra);
      },
    },
    events,
    { collectsEvidence: true, evidence: gate.evidence, timeoutMs: 20 },
  );
  const timeoutResult = await invoke(delayed, 'forced-timeout');
  const subsequentTool =
    target === 'query_logs' ? 'query_metrics' : 'query_logs';
  const after = await invoke(byName(subsequentTool), 'after-timeout');
  const allEvents = events.snapshot();
  const retainedEvidence = gate.evidence.forIncident('INC-001');
  process.stdout.write(
    JSON.stringify({
      target,
      timeout_result: timeoutResult,
      before_evidence_id: before.evidence_id,
      after_evidence_id: after.evidence_id,
      prior_event_ids_preserved: priorEventIds.every(
        (id, index) => allEvents[index]?.event_id === id,
      ),
      previous_evidence_content_preserved:
        retainedEvidence.find(
          (evidence) => evidence.evidence_id === previousEvidence.evidence_id,
        )?.content === previousEvidence.content,
      retained_evidence_ids: retainedEvidence.map(
        (evidence) => evidence.evidence_id,
      ),
      session_continued: typeof after.evidence_id === 'string',
      event_types: allEvents.map((event) => event.event_type),
    }),
  );
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
