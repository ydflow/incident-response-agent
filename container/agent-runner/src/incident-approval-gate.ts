/** Deterministic pre-execution policy and host-only approval for incident tools. */
import { randomUUID } from 'node:crypto';
import type { McpToolResult } from './mcp-tool-types.js';
import {
  InMemoryIncidentEvents,
  JsonlIncidentEvents,
} from './incident-agent-events.js';
import { InMemoryIncidentEvidence } from './incident-evidence-collection.js';
import {
  simulateRemediation,
  type RemediationRequest,
  type RemediationResult,
} from './incident-remediation-tools.js';

export type RiskDecision = 'SAFE' | 'ASK' | 'BLOCK';

const POLICY: Readonly<Record<string, RiskDecision>> = Object.freeze({
  query_logs: 'SAFE',
  query_metrics: 'SAFE',
  query_trace: 'SAFE',
  query_git_diff: 'SAFE',
  restart_service: 'ASK',
  rollback_config: 'ASK',
  modify_config: 'ASK',
  delete_database: 'BLOCK',
});

export type ApprovalRecord = {
  id: string;
  request: RemediationRequest;
  status: 'AWAITING_APPROVAL' | 'APPROVED' | 'REJECTED';
};

/** The trusted host owns this store; it is never exposed as an Agent tool. */
export interface ApprovalStore {
  create(record: ApprovalRecord): Promise<void>;
  allowPending(id: string): Promise<ApprovalRecord | undefined>;
  rejectPending(id: string): Promise<ApprovalRecord | undefined>;
}

export class InMemoryApprovalStore implements ApprovalStore {
  private readonly records = new Map<string, ApprovalRecord>();

  async create(record: ApprovalRecord): Promise<void> {
    if (this.records.has(record.id)) throw new Error('duplicate approval id');
    this.records.set(record.id, { ...record });
  }

  async allowPending(id: string): Promise<ApprovalRecord | undefined> {
    const record = this.records.get(id);
    if (record?.status !== 'AWAITING_APPROVAL') return undefined;
    record.status = 'APPROVED';
    return { ...record };
  }

  async rejectPending(id: string): Promise<ApprovalRecord | undefined> {
    const record = this.records.get(id);
    if (record?.status !== 'AWAITING_APPROVAL') return undefined;
    record.status = 'REJECTED';
    return { ...record };
  }
}

type GateOptions = {
  readPolicy?: (toolName: string) => RiskDecision | undefined;
  approvals?: ApprovalStore;
  executor?: (request: RemediationRequest) => Promise<RemediationResult>;
  events?: InMemoryIncidentEvents;
  evidence?: InMemoryIncidentEvidence;
};

function result(
  action: string,
  target: string,
  status: 'blocked' | 'approval_required' | 'rejected',
  message: string,
  extra: Record<string, string> = {},
): McpToolResult {
  return {
    isError: status === 'blocked',
    content: [
      {
        type: 'text',
        text: JSON.stringify({ action, target, status, message, ...extra }),
      },
    ],
  };
}

function denied(action: string, target: string, reason: string): McpToolResult {
  return result(action, target, 'blocked', reason);
}

/**
 * Tool handlers call this before any executor. Only trusted host code receives
 * allow()/reject(); those methods are never registered as MCP tools.
 */
export class IncidentApprovalGate {
  readonly events: InMemoryIncidentEvents;
  readonly evidence: InMemoryIncidentEvidence;
  private readonly readPolicy: NonNullable<GateOptions['readPolicy']>;
  private readonly approvals: ApprovalStore;
  private readonly executor: NonNullable<GateOptions['executor']>;
  private readonly pendingRequests = new Map<string, RemediationRequest>();

  constructor(options: GateOptions = {}) {
    this.events = options.events ?? new InMemoryIncidentEvents();
    this.evidence = options.evidence ?? new InMemoryIncidentEvidence();
    this.readPolicy = options.readPolicy ?? ((name) => POLICY[name]);
    this.approvals = options.approvals ?? new InMemoryApprovalStore();
    this.executor =
      options.executor ?? (async (request) => simulateRemediation(request));
  }

  private decision(toolName: string): RiskDecision {
    try {
      const value = this.readPolicy(toolName);
      const expected = POLICY[toolName];
      // A broken or changed policy reader may narrow permissions, never widen them.
      return expected && value === expected ? expected : 'BLOCK';
    } catch {
      return 'BLOCK';
    }
  }

  async runSafe(
    toolName: string,
    execute: () => Promise<McpToolResult>,
  ): Promise<McpToolResult> {
    if (this.decision(toolName) !== 'SAFE') {
      return denied(toolName, '', 'Policy denied this tool call.');
    }
    return execute();
  }

  async requestRemediation(
    request: RemediationRequest,
  ): Promise<RemediationResult> {
    if (this.decision(request.action) !== 'ASK') {
      return {
        action: request.action,
        incident_id: request.incident_id,
        target: request.target,
        status: 'blocked',
        message: 'Policy denied this tool call.',
      };
    }
    const id = randomUUID();
    const record: ApprovalRecord = {
      id,
      request: { ...request },
      status: 'AWAITING_APPROVAL',
    };
    try {
      await this.approvals.create(record);
      this.pendingRequests.set(id, record.request);
    } catch {
      return {
        action: request.action,
        incident_id: request.incident_id,
        target: request.target,
        status: 'blocked',
        message: 'Approval state is unavailable; action was not executed.',
      };
    }
    this.events.emit(request.incident_id, 'ApprovalRequested', {
      approval_id: id,
      action: request.action,
      target: request.target,
      status: 'AWAITING_APPROVAL',
    });
    return {
      action: request.action,
      incident_id: request.incident_id,
      target: request.target,
      status: 'approval_required',
      approval_id: id,
      approval_state: 'AWAITING_APPROVAL',
      message:
        'Awaiting an explicit decision from the trusted host. No action was executed.',
    };
  }

  /** Called only by trusted human-facing host code, never by the Agent. */
  async allow(approvalId: string, humanActor: string): Promise<McpToolResult> {
    if (!approvalId || !humanActor.trim()) {
      return denied(
        'approval',
        '',
        'A human actor and approval ID are required.',
      );
    }
    const pending = this.pendingRequests.get(approvalId);
    if (!pending) {
      return denied('approval', '', 'No matching pending request exists.');
    }
    let record: ApprovalRecord | undefined;
    try {
      record = await this.approvals.allowPending(approvalId);
    } catch {
      this.pendingRequests.delete(approvalId);
      return denied(
        'approval',
        '',
        'Approval state is unavailable; action was not executed.',
      );
    }
    if (
      !record ||
      record.id !== approvalId ||
      record.status !== 'APPROVED' ||
      JSON.stringify(record.request) !== JSON.stringify(pending) ||
      this.pendingRequests.get(approvalId) !== pending ||
      this.decision(record.request.action) !== 'ASK'
    ) {
      this.pendingRequests.delete(approvalId);
      return denied(
        'approval',
        '',
        'Approval state is invalid; action was not executed.',
      );
    }
    this.pendingRequests.delete(approvalId);
    this.events.emit(record.request.incident_id, 'ApprovalDecided', {
      approval_id: approvalId,
      decision: 'allow',
      actor: humanActor,
      action: record.request.action,
    });
    try {
      const executed = await this.executor(record.request);
      if (executed.status === 'simulated_success') {
        this.events.emit(record.request.incident_id, 'ActionExecuted', {
          approval_id: approvalId,
          action: executed.action,
          target: executed.target,
          status: executed.status,
        });
      } else {
        this.events.emit(record.request.incident_id, 'ToolFailed', {
          approval_id: approvalId,
          tool: record.request.action,
          reason: 'Executor did not report simulated_success.',
        });
      }
      return { content: [{ type: 'text', text: JSON.stringify(executed) }] };
    } catch {
      this.events.emit(record.request.incident_id, 'ToolFailed', {
        approval_id: approvalId,
        tool: record.request.action,
        reason: 'Simulation failed.',
      });
      return denied(
        record.request.action,
        record.request.target,
        'Simulation failed.',
      );
    }
  }

  /** Called only by trusted human-facing host code, never by the Agent. */
  async reject(approvalId: string, humanActor: string): Promise<McpToolResult> {
    if (!approvalId || !humanActor.trim()) {
      return denied(
        'approval',
        '',
        'A human actor and approval ID are required.',
      );
    }
    const pending = this.pendingRequests.get(approvalId);
    if (!pending) {
      return denied('approval', '', 'No matching pending request exists.');
    }
    let record: ApprovalRecord | undefined;
    try {
      record = await this.approvals.rejectPending(approvalId);
    } catch {
      this.pendingRequests.delete(approvalId);
      return denied(
        'approval',
        '',
        'Approval state is unavailable; action was not executed.',
      );
    }
    if (
      !record ||
      record.id !== approvalId ||
      record.status !== 'REJECTED' ||
      JSON.stringify(record.request) !== JSON.stringify(pending) ||
      this.pendingRequests.get(approvalId) !== pending
    ) {
      this.pendingRequests.delete(approvalId);
      return denied(
        'approval',
        '',
        'Approval state is invalid; action was not executed.',
      );
    }
    this.pendingRequests.delete(approvalId);
    this.events.emit(record.request.incident_id, 'ApprovalDecided', {
      approval_id: approvalId,
      decision: 'reject',
      actor: humanActor,
      action: record.request.action,
    });
    return result(
      record.request.action,
      record.request.target,
      'rejected',
      'Human rejected the action.',
    );
  }

  blockProbe(toolName: string, target: string): McpToolResult {
    const risk = this.decision(toolName);
    return denied(
      toolName,
      target,
      `Policy decision ${risk}; no executor exists.`,
    );
  }
}

// Keep pending requests reachable across turns in this runner process. A
// restart drops them and therefore requires a new human decision; it never
// restores an implicit approval.
const gatesByScope = new Map<string, IncidentApprovalGate>();

export function incidentApprovalGateForScope(
  groupFolder: string,
  chatJid: string,
  eventDirectory?: string,
): IncidentApprovalGate {
  const scope = `${groupFolder}\0${chatJid}`;
  let gate = gatesByScope.get(scope);
  if (!gate) {
    gate = new IncidentApprovalGate({
      events: eventDirectory
        ? new JsonlIncidentEvents(eventDirectory)
        : undefined,
    });
    gatesByScope.set(scope, gate);
  }
  return gate;
}
