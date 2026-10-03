/** Observe incident MCP ToolCalls at the handler boundary, including failures. */
import { randomUUID } from 'node:crypto';
import type {
  InMemoryIncidentEvents,
  JsonValue,
} from './incident-agent-events.js';
import type {
  CollectedIncidentEvidence,
  InMemoryIncidentEvidence,
} from './incident-evidence-collection.js';
import type { McpToolDefinition, McpToolResult } from './mcp-tool-types.js';

export class IncidentToolTimeoutError extends Error {
  readonly code = 'tool_timeout';

  constructor(
    readonly toolName: string,
    readonly timeoutMs: number,
  ) {
    super(`${toolName} exceeded its ${timeoutMs}ms deadline.`);
    this.name = 'IncidentToolTimeoutError';
  }
}

type IncidentToolEventOptions = {
  collectsEvidence?: boolean;
  evidence?: InMemoryIncidentEvidence;
  timeoutMs?: number;
  /** Trusted, optional result snapshot; core event keys always take precedence. */
  resultPayload?: (result: McpToolResult) => Record<string, JsonValue>;
};

async function runWithDeadline(
  definition: McpToolDefinition<any>,
  args: any,
  extra: unknown,
  timeoutMs: number,
): Promise<McpToolResult> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('timeoutMs must be positive and finite');
  }
  const controller = new AbortController();
  const upstream = (extra as { signal?: AbortSignal } | null)?.signal;
  const signal = upstream
    ? AbortSignal.any([upstream, controller.signal])
    : controller.signal;
  const handlerExtra =
    extra && typeof extra === 'object' ? { ...extra, signal } : { signal };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new IncidentToolTimeoutError(definition.name, timeoutMs);
      reject(error);
      controller.abort(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      definition.handler(args, handlerExtra),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function evidenceMetadata(
  result: McpToolResult,
): CollectedIncidentEvidence | null {
  const text = result.content.find((item) => item.type === 'text');
  if (!text || text.type !== 'text') return null;
  try {
    const value = JSON.parse(text.text) as Record<string, unknown>;
    if (
      typeof value.evidence_id === 'string' &&
      typeof value.incident_id === 'string' &&
      typeof value.source === 'string' &&
      typeof value.timestamp === 'string' &&
      typeof value.content === 'string' &&
      typeof value.correlation_id === 'string'
    ) {
      return {
        evidence_id: value.evidence_id,
        incident_id: value.incident_id,
        source: value.source,
        timestamp: value.timestamp,
        content: value.content,
        correlation_id: value.correlation_id,
      };
    }
  } catch {
    // An error response or malformed result is not evidence.
  }
  return null;
}

export function withIncidentToolEvents(
  definition: McpToolDefinition<any>,
  events: InMemoryIncidentEvents,
  options: IncidentToolEventOptions = {},
): McpToolDefinition<any> {
  return {
    ...definition,
    handler: async (args: any, extra: unknown) => {
      const incidentId = args.incident_id as string;
      const suppliedId = (extra as { toolCallId?: unknown } | null)?.toolCallId;
      const toolCallId =
        typeof suppliedId === 'string' ? suppliedId : randomUUID();
      events.emit(incidentId, 'ToolCalled', {
        tool: definition.name,
        tool_call_id: toolCallId,
      });
      try {
        const result =
          options.timeoutMs === undefined
            ? await definition.handler(args, extra)
            : await runWithDeadline(definition, args, extra, options.timeoutMs);
        events.emit(incidentId, 'ToolResult', {
          ...options.resultPayload?.(result),
          tool: definition.name,
          tool_call_id: toolCallId,
          status: result.isError ? 'error' : 'returned',
        });
        if (result.isError) {
          events.emit(incidentId, 'ToolFailed', {
            tool: definition.name,
            tool_call_id: toolCallId,
            reason: 'Tool returned an error result.',
          });
        } else if (options.collectsEvidence) {
          const evidence = evidenceMetadata(result);
          if (evidence && evidence.incident_id === incidentId) {
            options.evidence?.collect(evidence);
            events.emit(incidentId, 'EvidenceCollected', {
              tool: definition.name,
              tool_call_id: toolCallId,
              evidence_id: evidence.evidence_id,
              source: evidence.source,
              correlation_id: evidence.correlation_id,
            });
          }
        }
        return result;
      } catch (error) {
        const timedOut = error instanceof IncidentToolTimeoutError;
        events.emit(incidentId, 'ToolResult', {
          tool: definition.name,
          tool_call_id: toolCallId,
          status: timedOut ? 'timeout' : 'threw',
        });
        events.emit(incidentId, 'ToolFailed', {
          tool: definition.name,
          tool_call_id: toolCallId,
          reason: timedOut
            ? error.code
            : error instanceof Error
              ? error.name
              : 'Unknown error',
          ...(timedOut
            ? { timeout_ms: error.timeoutMs, message: error.message }
            : {}),
        });
        if (timedOut) {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  incident_id: incidentId,
                  tool: definition.name,
                  error: error.code,
                  timeout_ms: error.timeoutMs,
                  message: error.message,
                }),
              },
            ],
          };
        }
        throw error;
      }
    },
  };
}
