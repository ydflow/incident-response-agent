/** Simulated incident actions. Agent calls reach only the guarded executor. */
import { z } from 'zod';
import {
  defineMcpTool,
  type McpToolDefinition,
  type McpToolResult,
} from './mcp-tool-types.js';
import type { IncidentApprovalGate } from './incident-approval-gate.js';

export type RemediationRequest =
  | { action: 'restart_service'; incident_id: string; target: string }
  | { action: 'rollback_config'; incident_id: string; target: string }
  | {
      action: 'modify_config';
      incident_id: string;
      target: string;
      config_key: string;
      proposed_value: string;
    };

export type RemediationResult = {
  action: RemediationRequest['action'];
  incident_id: string;
  target: string;
  status: 'approval_required' | 'simulated_success' | 'blocked';
  message: string;
  approval_id?: string;
  approval_state?: 'AWAITING_APPROVAL';
};

/** Pure simulation: no filesystem, process, network, Kubernetes, or server calls. */
export function simulateRemediation(
  request: RemediationRequest,
): RemediationResult {
  const intent =
    request.action === 'restart_service'
      ? 'restart the service'
      : request.action === 'rollback_config'
        ? 'roll back its configuration'
        : `change configuration key ${request.config_key}`;
  return {
    action: request.action,
    incident_id: request.incident_id,
    target: request.target,
    status: 'simulated_success',
    message: `Simulation only: would ${intent} for ${request.target}. No real action was performed.`,
  };
}

function asToolResult(result: RemediationResult): McpToolResult {
  return {
    isError: result.status === 'blocked',
    content: [{ type: 'text', text: JSON.stringify(result) }],
  };
}

/**
 * Define MiniClaw MCP tools. A Policy/Approval Gate is required at creation;
 * ToolCall handlers can only submit requests, never call the simulator directly.
 */
export function createIncidentRemediationTools(
  approvalGate: IncidentApprovalGate,
): McpToolDefinition<any>[] {
  const incidentId = z.string().regex(/^[A-Za-z0-9_-]+$/);
  const target = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const invoke = async (request: RemediationRequest): Promise<McpToolResult> =>
    asToolResult(await approvalGate.requestRemediation(request));

  return [
    defineMcpTool(
      'restart_service',
      'SIMULATED ONLY. Describe a service restart after approval; never restart a real service.',
      { incident_id: incidentId, target },
      async ({ incident_id, target }) =>
        invoke({ action: 'restart_service', incident_id, target }),
    ),
    defineMcpTool(
      'rollback_config',
      'SIMULATED ONLY. Describe a configuration rollback after approval; never change a real file.',
      { incident_id: incidentId, target },
      async ({ incident_id, target }) =>
        invoke({ action: 'rollback_config', incident_id, target }),
    ),
    defineMcpTool(
      'modify_config',
      'SIMULATED ONLY. Describe a configuration change after approval; never change a real file.',
      {
        incident_id: incidentId,
        target,
        config_key: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]*$/),
        proposed_value: z.string().min(1).max(256),
      },
      async ({ incident_id, target, config_key, proposed_value }) =>
        invoke({
          action: 'modify_config',
          incident_id,
          target,
          config_key,
          proposed_value,
        }),
    ),
  ];
}
