import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  IncidentApprovalGate,
  incidentApprovalGateForScope,
  type ApprovalRecord,
  type ApprovalStore,
} from '../container/agent-runner/src/incident-approval-gate.js';
import {
  simulateRemediation,
  type RemediationRequest,
} from '../container/agent-runner/src/incident-remediation-tools.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

function body(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text ?? '') as Record<string, unknown>;
}

function piIncidentTools(gate: IncidentApprovalGate) {
  const definitions = createMcpTools({
    chatJid: 'test:incident',
    groupFolder: 'test',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    workspaceIpc: path.join(os.tmpdir(), 'unused-approval-ipc'),
    workspaceGroup: path.join(os.tmpdir(), 'unused-approval-group'),
    incidentApprovalGate: gate,
  });
  return adaptClaudeMcpToolsToPi(
    definitions.filter((tool) =>
      [
        'query_logs',
        'query_metrics',
        'query_trace',
        'query_git_diff',
        'restart_service',
        'rollback_config',
        'modify_config',
        'delete_database',
      ].includes(tool.name),
    ),
    { namespace: 'mcp__miniclaw' },
  );
}

async function invoke(
  tools: ReturnType<typeof piIncidentTools>,
  name: string,
  args: Record<string, unknown>,
) {
  const tool = tools.find((entry) => entry.name === `mcp__miniclaw__${name}`);
  expect(tool).toBeDefined();
  return tool!.execute(`call-${name}`, args, new AbortController().signal);
}

const baseArgs = { incident_id: 'INC-001', target: 'payment-service' };

describe('incident ToolCall approval boundary', () => {
  test('trusted host can resolve the same pending request across tool registrations', async () => {
    const scope = `approval-test-${Math.random()}`;
    const definitions = createMcpTools({
      chatJid: 'test:human',
      groupFolder: scope,
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      workspaceIpc: path.join(os.tmpdir(), 'unused-approval-ipc'),
      workspaceGroup: path.join(os.tmpdir(), 'unused-approval-group'),
    });
    const selected = definitions.filter(
      (tool) => tool.name === 'restart_service',
    );
    const piTools = adaptClaudeMcpToolsToPi(selected, {
      namespace: 'mcp__miniclaw',
    });
    const requested = body(await invoke(piTools, 'restart_service', baseArgs));
    expect(requested.approval_state).toBe('AWAITING_APPROVAL');
    const hostGate = incidentApprovalGateForScope(scope, 'test:human');
    const allowed = body(
      await hostGate.allow(String(requested.approval_id), 'human:test'),
    );
    expect(allowed.status).toBe('simulated_success');
  });

  test('SAFE evidence calls execute immediately through the gate', async () => {
    const tools = piIncidentTools(new IncidentApprovalGate());
    for (const name of [
      'query_logs',
      'query_metrics',
      'query_trace',
      'query_git_diff',
    ]) {
      const result = await invoke(tools, name, { incident_id: 'INC-001' });
      expect(body(result).evidence_id).toBe(
        `INC-001:${name.replace('query_', '')}`,
      );
    }
  });

  test('ASK waits; reject prevents execution; allow invokes simulator once', async () => {
    const executor = vi.fn(async (request: RemediationRequest) =>
      simulateRemediation(request),
    );
    const gate = new IncidentApprovalGate({ executor });
    const tools = piIncidentTools(gate);

    const requested = body(await invoke(tools, 'restart_service', baseArgs));
    expect(requested).toMatchObject({
      action: 'restart_service',
      target: 'payment-service',
      status: 'approval_required',
      approval_state: 'AWAITING_APPROVAL',
    });
    expect(executor).not.toHaveBeenCalled();
    const rejected = body(
      await gate.reject(String(requested.approval_id), 'human:test'),
    );
    expect(rejected.status).toBe('rejected');
    expect(
      body(await gate.allow(String(requested.approval_id), 'human:test'))
        .status,
    ).toBe('blocked');
    expect(executor).not.toHaveBeenCalled();

    const second = body(await invoke(tools, 'rollback_config', baseArgs));
    expect(executor).not.toHaveBeenCalled();
    const allowed = body(
      await gate.allow(String(second.approval_id), 'human:test'),
    );
    expect(allowed).toMatchObject({
      action: 'rollback_config',
      target: 'payment-service',
      status: 'simulated_success',
    });
    expect(executor).toHaveBeenCalledTimes(1);
    expect(
      body(await gate.allow(String(second.approval_id), 'human:test')).status,
    ).toBe('blocked');
    expect(executor).toHaveBeenCalledTimes(1);
  });

  test('all three ASK tools require approval before executor', async () => {
    const executor = vi.fn(async (request: RemediationRequest) =>
      simulateRemediation(request),
    );
    const tools = piIncidentTools(new IncidentApprovalGate({ executor }));
    for (const name of [
      'restart_service',
      'rollback_config',
      'modify_config',
    ]) {
      const result = await invoke(tools, name, {
        ...baseArgs,
        ...(name === 'modify_config'
          ? { config_key: 'max_connections', proposed_value: '50' }
          : {}),
      });
      expect(body(result).status).toBe('approval_required');
    }
    expect(executor).not.toHaveBeenCalled();
  });

  test('BLOCK delete_database and unknown tools never reach executor', async () => {
    const executor = vi.fn(async (request: RemediationRequest) =>
      simulateRemediation(request),
    );
    const gate = new IncidentApprovalGate({ executor });
    const blocked = body(
      await invoke(piIncidentTools(gate), 'delete_database', baseArgs),
    );
    expect(blocked).toMatchObject({
      action: 'delete_database',
      status: 'blocked',
    });
    const unsafe = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'unsafe' }],
    }));
    expect(body(await gate.runSafe('unknown_tool', unsafe)).status).toBe(
      'blocked',
    );
    expect(
      (
        await gate.requestRemediation({
          action: 'unknown_tool',
          ...baseArgs,
        } as unknown as RemediationRequest)
      ).status,
    ).toBe('blocked');
    expect(unsafe).not.toHaveBeenCalled();
    expect(executor).not.toHaveBeenCalled();
  });

  test('policy read failure and approval store failures deny by default', async () => {
    const executor = vi.fn(async (request: RemediationRequest) =>
      simulateRemediation(request),
    );
    const badPolicy = new IncidentApprovalGate({
      executor,
      readPolicy: () => {
        throw new Error('policy unavailable');
      },
    });
    const safe = vi.fn(async () => ({
      content: [{ type: 'text' as const, text: 'unsafe' }],
    }));
    expect(body(await badPolicy.runSafe('query_logs', safe)).status).toBe(
      'blocked',
    );
    expect(
      (
        await badPolicy.requestRemediation({
          action: 'restart_service',
          ...baseArgs,
        })
      ).status,
    ).toBe('blocked');
    expect(safe).not.toHaveBeenCalled();

    const brokenStore: ApprovalStore = {
      create: async () => {
        throw new Error('write failed');
      },
      allowPending: async () => {
        throw new Error('read failed');
      },
      rejectPending: async () => {
        throw new Error('read failed');
      },
    };
    const badApproval = new IncidentApprovalGate({
      executor,
      approvals: brokenStore,
    });
    expect(
      (
        await badApproval.requestRemediation({
          action: 'restart_service',
          ...baseArgs,
        })
      ).status,
    ).toBe('blocked');
    expect(body(await badApproval.allow('any', 'human:test')).status).toBe(
      'blocked',
    );

    const unreadableStore: ApprovalStore = {
      create: async () => {},
      allowPending: async () => {
        throw new Error('read failed');
      },
      rejectPending: async () => undefined,
    };
    const unreadableGate = new IncidentApprovalGate({
      executor,
      approvals: unreadableStore,
    });
    const pending = await unreadableGate.requestRemediation({
      action: 'restart_service',
      ...baseArgs,
    });
    expect(
      body(
        await unreadableGate.allow(String(pending.approval_id), 'human:test'),
      ).status,
    ).toBe('blocked');
    expect(executor).not.toHaveBeenCalled();
  });

  test('abnormal approval state and missing human actor deny by default', async () => {
    const executor = vi.fn(async (request: RemediationRequest) =>
      simulateRemediation(request),
    );
    const malformedStore: ApprovalStore = {
      create: async () => {},
      allowPending: async (id): Promise<ApprovalRecord> => ({
        id,
        request: { action: 'restart_service', ...baseArgs },
        status: 'REJECTED',
      }),
      rejectPending: async () => undefined,
    };
    const gate = new IncidentApprovalGate({
      executor,
      approvals: malformedStore,
    });
    const requested = await gate.requestRemediation({
      action: 'restart_service',
      ...baseArgs,
    });
    expect(
      body(await gate.allow(String(requested.approval_id), 'human:test'))
        .status,
    ).toBe('blocked');
    expect(
      body(await gate.allow(String(requested.approval_id), '')).status,
    ).toBe('blocked');

    const forgedStore: ApprovalStore = {
      create: async () => {},
      allowPending: async (id): Promise<ApprovalRecord> => ({
        id,
        request: {
          action: 'restart_service',
          incident_id: 'INC-001',
          target: 'other-service',
        },
        status: 'APPROVED',
      }),
      rejectPending: async () => undefined,
    };
    const forgedGate = new IncidentApprovalGate({
      executor,
      approvals: forgedStore,
    });
    const forgedRequest = await forgedGate.requestRemediation({
      action: 'restart_service',
      ...baseArgs,
    });
    expect(
      body(
        await forgedGate.allow(String(forgedRequest.approval_id), 'human:test'),
      ).status,
    ).toBe('blocked');
    expect(executor).not.toHaveBeenCalled();
  });
});
