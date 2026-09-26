import os from 'node:os';
import path from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import {
  createIncidentRemediationTools,
  simulateRemediation,
  type RemediationRequest,
} from '../container/agent-runner/src/incident-remediation-tools.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

const actions = ['restart_service', 'rollback_config', 'modify_config'];

function parseResult(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  expect(result.content[0].type).toBe('text');
  return JSON.parse(result.content[0].text ?? '') as Record<string, unknown>;
}

describe('simulated incident remediation tools', () => {
  test('are registered separately from the read-only evidence tools', () => {
    const registered = createMcpTools({
      chatJid: 'test:incident',
      groupFolder: 'test',
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      workspaceIpc: path.join(os.tmpdir(), 'unused-remediation-ipc'),
      workspaceGroup: path.join(os.tmpdir(), 'unused-remediation-group'),
    });
    expect(registered.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'query_logs',
        'query_metrics',
        'query_trace',
        'query_git_diff',
      ]),
    );
    for (const action of actions)
      expect(registered.some((tool) => tool.name === action)).toBe(true);
    expect(registered.some((tool) => tool.name === 'delete_database')).toBe(
      true,
    );
  });

  test('all three definitions stop at the approval gate', async () => {
    const executor = vi.fn(async (request: RemediationRequest) =>
      simulateRemediation(request),
    );
    const tools = createIncidentRemediationTools(
      new IncidentApprovalGate({ executor }),
    );
    expect(tools.map((tool) => tool.name)).toEqual(actions);
    for (const tool of tools) {
      const result = await tool.handler(
        {
          incident_id: 'INC-001',
          target: 'payment-service',
          config_key: 'max_connections',
          proposed_value: '50',
        },
        {},
      );
      expect(parseResult(result)).toMatchObject({
        action: tool.name,
        incident_id: 'INC-001',
        target: 'payment-service',
        status: 'approval_required',
        approval_state: 'AWAITING_APPROVAL',
      });
    }
    expect(executor).not.toHaveBeenCalled();
  });

  test('Pi adapter reaches simulation only after trusted host approval', async () => {
    const executor = vi.fn(async (request: RemediationRequest) =>
      simulateRemediation(request),
    );
    const gate = new IncidentApprovalGate({ executor });
    const definitions = createIncidentRemediationTools(gate);
    const piTools = adaptClaudeMcpToolsToPi(definitions, {
      namespace: 'mcp__miniclaw',
    });
    for (const action of actions) {
      const tool = piTools.find(
        (item) => item.name === `mcp__miniclaw__${action}`,
      );
      expect(tool).toBeDefined();
      const result = await tool!.execute(
        `test-${action}`,
        {
          incident_id: 'INC-001',
          target: 'payment-service',
          ...(action === 'modify_config'
            ? { config_key: 'max_connections', proposed_value: '50' }
            : {}),
        },
        new AbortController().signal,
      );
      const body = parseResult(result);
      expect(body.status).toBe('approval_required');
      expect(executor).toHaveBeenCalledTimes(actions.indexOf(action));
      const approved = parseResult(
        await gate.allow(String(body.approval_id), 'human:test'),
      );
      expect(approved).toMatchObject({
        action,
        incident_id: 'INC-001',
        target: 'payment-service',
        status: 'simulated_success',
      });
      expect(approved.message).toContain('No real action was performed.');
    }
    expect(executor).toHaveBeenCalledTimes(3);
    expect(executor).toHaveBeenNthCalledWith(3, {
      action: 'modify_config',
      incident_id: 'INC-001',
      target: 'payment-service',
      config_key: 'max_connections',
      proposed_value: '50',
    });
  });
});
