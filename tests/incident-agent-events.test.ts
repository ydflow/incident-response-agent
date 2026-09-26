import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import {
  InMemoryIncidentEvents,
  JsonlIncidentEvents,
} from '../container/agent-runner/src/incident-agent-events.js';
import { simulateRemediation } from '../container/agent-runner/src/incident-remediation-tools.js';
import { withIncidentToolEvents } from '../container/agent-runner/src/incident-tool-events.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

function tools(gate: IncidentApprovalGate) {
  const definitions = createMcpTools({
    chatJid: 'test:agent-events',
    groupFolder: 'test',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    workspaceIpc: path.join(os.tmpdir(), 'unused-agent-events-ipc'),
    workspaceGroup: path.join(os.tmpdir(), 'unused-agent-events-group'),
    incidentApprovalGate: gate,
  }).filter((tool) => ['query_logs', 'rollback_config'].includes(tool.name));
  return adaptClaudeMcpToolsToPi(definitions, { namespace: 'mcp__miniclaw' });
}

async function call(
  selected: ReturnType<typeof tools>,
  name: string,
  incidentId = 'INC-001',
) {
  const tool = selected.find((entry) => entry.name.endsWith(`__${name}`));
  if (!tool) throw new Error(`Missing tool: ${name}`);
  return tool.execute(
    `call-${name}`,
    {
      incident_id: incidentId,
      ...(name === 'rollback_config' ? { target: 'payment-service' } : {}),
    },
    new AbortController().signal,
  );
}

test('a real evidence ToolCall emits before, after, and collected evidence', async () => {
  const gate = new IncidentApprovalGate();
  await call(tools(gate), 'query_logs');
  const events = gate.events.snapshot();
  expect(events.map((event) => event.event_type)).toEqual([
    'ToolCalled',
    'ToolResult',
    'EvidenceCollected',
  ]);
  expect(events[0].payload.tool_call_id).toBe('call-query_logs');
  expect(events[2].payload.evidence_id).toBe('INC-001:logs');
  expect(events.every((event) => event.incident_id === 'INC-001')).toBe(true);
  expect(JSON.parse(JSON.stringify(events))).toEqual(events);
});

test('a failed evidence ToolCall emits ToolFailed without collected evidence', async () => {
  const gate = new IncidentApprovalGate();
  await call(tools(gate), 'query_logs', 'INC-999');
  expect(gate.events.snapshot().map((event) => event.event_type)).toEqual([
    'ToolCalled',
    'ToolResult',
    'ToolFailed',
  ]);
});

test('a throwing ToolCall records its failure and preserves the exception', async () => {
  const events = new InMemoryIncidentEvents();
  const tool = withIncidentToolEvents(
    {
      name: 'query_logs',
      description: 'test failure',
      inputSchema: {},
      handler: async () => {
        throw new Error('fixture unavailable');
      },
    },
    events,
  );
  await expect(tool.handler({ incident_id: 'INC-001' }, {})).rejects.toThrow(
    'fixture unavailable',
  );
  expect(events.snapshot().map((event) => event.event_type)).toEqual([
    'ToolCalled',
    'ToolResult',
    'ToolFailed',
  ]);
});

test('request and Reject are observed without calling the executor', async () => {
  const executor = vi.fn(async (request) => simulateRemediation(request));
  const gate = new IncidentApprovalGate({ executor });
  const proposal = await call(tools(gate), 'rollback_config');
  const body = JSON.parse(proposal.content[0].text ?? '') as {
    approval_id: string;
  };
  expect(gate.events.snapshot().map((event) => event.event_type)).toEqual([
    'ToolCalled',
    'ApprovalRequested',
    'ToolResult',
  ]);
  await gate.reject(body.approval_id, 'human:test');
  expect(gate.events.snapshot().at(-1)?.event_type).toBe('ApprovalDecided');
  expect(gate.events.snapshot().at(-1)?.payload.decision).toBe('reject');
  expect(
    gate.events
      .snapshot()
      .some((event) => event.event_type === 'ActionExecuted'),
  ).toBe(false);
  expect(executor).not.toHaveBeenCalled();
});

test('explicit Allow records simulated execution after the decision', async () => {
  const executor = vi.fn(async (request) => simulateRemediation(request));
  const gate = new IncidentApprovalGate({ executor });
  const proposal = await call(tools(gate), 'rollback_config');
  const body = JSON.parse(proposal.content[0].text ?? '') as {
    approval_id: string;
  };
  await gate.allow(body.approval_id, 'human:test');
  expect(
    gate.events
      .snapshot()
      .slice(-2)
      .map((event) => event.event_type),
  ).toEqual(['ApprovalDecided', 'ActionExecuted']);
  expect(executor).toHaveBeenCalledOnce();
});

test('JSONL appends independent lines for failure, request, and Reject', async () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'incident-jsonl-test-'),
  );
  try {
    const file = path.join(directory, 'INC-001.jsonl');
    const first = new JsonlIncidentEvents(directory).emit(
      'INC-001',
      'IncidentCreated',
      { status: 'RECEIVED' },
    );
    const gate = new IncidentApprovalGate({
      events: new JsonlIncidentEvents(directory),
      readPolicy: (name) => (name === 'rollback_config' ? 'ASK' : undefined),
    });
    await call(tools(gate), 'query_logs');
    const proposal = await call(tools(gate), 'rollback_config');
    const body = JSON.parse(proposal.content[0].text ?? '') as {
      approval_id: string;
    };
    await gate.reject(body.approval_id, 'human:test');
    const secondProposal = await call(tools(gate), 'rollback_config');
    const secondBody = JSON.parse(secondProposal.content[0].text ?? '') as {
      approval_id: string;
    };
    await gate.allow(secondBody.approval_id, 'human:test');

    const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
    const records = lines.map(
      (line) =>
        JSON.parse(line) as {
          event_id: string;
          event_type: string;
        },
    );
    expect(records[0].event_id).toBe(first.event_id);
    expect(records.map((record) => record.event_type)).toEqual([
      'IncidentCreated',
      'ToolCalled',
      'ToolResult',
      'ToolFailed',
      'ToolCalled',
      'ApprovalRequested',
      'ToolResult',
      'ApprovalDecided',
      'ToolCalled',
      'ApprovalRequested',
      'ToolResult',
      'ApprovalDecided',
      'ActionExecuted',
    ]);
    const decisions = lines
      .map(
        (line) =>
          JSON.parse(line) as {
            event_type: string;
            payload: { decision?: string };
          },
      )
      .filter((record) => record.event_type === 'ApprovalDecided')
      .map((record) => record.payload.decision);
    expect(decisions).toEqual(['reject', 'allow']);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
