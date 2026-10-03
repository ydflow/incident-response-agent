/** Local demo observations only. Host supplies addresses, credentials and scope. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { CollectedIncidentEvidence } from './incident-evidence-collection.js';
import type { McpToolResult } from './mcp-tool-types.js';

export const LIVE_ID_PATTERN =
  /^LIVE-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const LIVE_RESPONSE_BYTES = 64 * 1024;
export const LIVE_RUN_BYTES = 256 * 1024;
const name = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const instant = z.iso.datetime({ offset: true });
export const liveQueryShape = {
  incident_id: z.string().regex(LIVE_ID_PATTERN),
  source_id: name.optional(),
  service: name.optional(),
  environment: name.optional(),
  from: instant.optional(),
  to: instant.optional(),
  limit: z.number().int().min(1).max(200).default(100),
};
const querySchema = z.strictObject(liveQueryShape);
export type LiveQuery = z.input<typeof querySchema>;
export type LiveSource = 'logs' | 'metrics' | 'trace' | 'git_diff';
const hostSourceSchema = z.strictObject({
  source_id: name,
  base_url: z.string().regex(/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/),
  service: name,
  environment: name,
  read_token: z.string().regex(/^[0-9a-f]{64}$/),
  instance_id: z.uuid().optional(),
  timeout_ms: z.number().int().min(10).max(4500).default(4000),
});
export type HostLiveSource = z.input<typeof hostSourceSchema>;
const bindingSchema = z.strictObject({
  incident_id: z.string().regex(LIVE_ID_PATTERN),
  source_id: name,
  service: name,
  environment: name,
  allowed_from: instant,
  allowed_to: instant,
});
export type LiveIncidentBinding = z.infer<typeof bindingSchema>;
const logItem = z.strictObject({
  timestamp: instant,
  level: z.enum(['INFO', 'WARN', 'ERROR']),
  request_id: z.uuid(),
  component: z.literal('resource_pool'),
  message: z.enum([
    'pool_acquired',
    'pool_timeout',
    'request_complete',
    'request_cancelled',
    'queue_overflow',
  ]),
  wait_ms: z.number().finite().nonnegative(),
});
const metricsItem = z.strictObject({
  observed_at: instant,
  pool_capacity: z.number().int().min(1).max(32),
  pool_active: z.number().int().min(0).max(32),
  pool_waiting: z.number().int().min(0).max(128),
  requests_total: z.number().int().nonnegative(),
  requests_success: z.number().int().nonnegative(),
  acquire_timeouts: z.number().int().nonnegative(),
  requests_cancelled: z.number().int().nonnegative(),
  queue_overflows: z.number().int().nonnegative(),
  acquire_wait_ms_total: z.number().finite().nonnegative(),
});
const responseBase = {
  provider: z.literal('local_demo'),
  source_id: name,
  instance_id: z.uuid(),
  service: name,
  environment: name,
  query_id: z.uuid(),
  kind: z.enum(['logs', 'metrics']),
  observed_at: instant,
  window: z.strictObject({ from: instant, to: instant }),
  status: z.enum(['success', 'empty']),
  truncated: z.boolean(),
  retention_dropped: z.number().int().nonnegative(),
};
const logResponse = z.strictObject({
  ...responseBase,
  items: z.array(logItem).max(200),
});
const metricsResponse = z.strictObject({
  ...responseBase,
  items: z.array(metricsItem).max(200),
});
/** Same strict transport parser for the trusted local threshold monitor. */
export const localDemoMetricsSchema = metricsResponse.extend({
  kind: z.literal('metrics'),
});
export class LiveSourceError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function liveErrorResult(
  incidentId: string,
  code: string,
): McpToolResult {
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          incident_id: incidentId,
          error: code,
          provider: 'local_demo',
        }),
      },
    ],
  };
}

/** Reservation bounds parallel queries as well as aggregate received bytes. */
class QueryBudget {
  private spent = 0;
  private reserved = 0;
  private calls = 0;
  reserve() {
    if (
      this.calls >= 16 ||
      this.spent + this.reserved + LIVE_RESPONSE_BYTES > LIVE_RUN_BYTES
    )
      throw new LiveSourceError('query_budget_exhausted');
    this.calls++;
    this.reserved += LIVE_RESPONSE_BYTES;
    let received = 0;
    return {
      received: (bytes: number) => {
        received += bytes;
      },
      output: (bytes: number) => {
        received = Math.max(received, bytes);
      },
      finish: () => {
        this.reserved -= LIVE_RESPONSE_BYTES;
        this.spent += Math.min(received, LIVE_RESPONSE_BYTES);
      },
    };
  }
}

/** No filesystem path, Fixture fallback or arbitrary network target exists here. */
export class LocalDemoProvider {
  private readonly sources = new Map<
    string,
    z.output<typeof hostSourceSchema>
  >();
  private readonly bindings = new Map<string, LiveIncidentBinding>();
  private readonly budget = new QueryBudget();
  constructor(
    sources: HostLiveSource[],
    bindings: LiveIncidentBinding[],
    private readonly runId: string,
  ) {
    if (
      !/^[A-Za-z0-9_-]{1,100}$/.test(runId) ||
      sources.length > 16 ||
      bindings.length > 32
    )
      throw new LiveSourceError('invalid_host_binding');
    for (const value of sources) {
      const parsed = hostSourceSchema.safeParse(value);
      if (!parsed.success || this.sources.has(parsed.data.source_id))
        throw new LiveSourceError('invalid_source_config');
      const port = Number(/:(\d+)\/?$/.exec(parsed.data.base_url)?.[1]);
      if (!Number.isInteger(port) || port > 65535)
        throw new LiveSourceError('invalid_source_config');
      this.sources.set(parsed.data.source_id, parsed.data);
    }
    for (const value of bindings) {
      const parsed = bindingSchema.safeParse(value);
      if (!parsed.success || this.bindings.has(parsed.data.incident_id))
        throw new LiveSourceError('invalid_host_binding');
      const span =
        Date.parse(parsed.data.allowed_to) -
        Date.parse(parsed.data.allowed_from);
      if (span <= 0 || span > 15 * 60000)
        throw new LiveSourceError('invalid_host_binding');
      this.bindings.set(parsed.data.incident_id, parsed.data);
    }
  }
  async query(
    kind: LiveSource,
    args: unknown,
    signal?: AbortSignal,
  ): Promise<McpToolResult> {
    const parsed = querySchema.safeParse(args);
    const id = parsed.success ? parsed.data.incident_id : 'invalid';
    if (!parsed.success) return liveErrorResult(id, 'invalid_query');
    let reservation: ReturnType<QueryBudget['reserve']> | undefined;
    try {
      if (signal?.aborted) throw new LiveSourceError('cancelled');
      const input = parsed.data;
      const binding = this.bindings.get(input.incident_id);
      if (!binding) throw new LiveSourceError('incident_not_bound');
      const source = this.sources.get(binding.source_id);
      if (!source) throw new LiveSourceError('unavailable');
      if (
        binding.service !== source.service ||
        binding.environment !== source.environment ||
        (input.source_id !== undefined &&
          input.source_id !== binding.source_id) ||
        (input.service !== undefined && input.service !== binding.service) ||
        (input.environment !== undefined &&
          input.environment !== binding.environment)
      )
        throw new LiveSourceError('scope_denied');
      const now = Date.now();
      const to = input.to
        ? Date.parse(input.to)
        : Math.min(now, Date.parse(binding.allowed_to));
      const from = input.from
        ? Date.parse(input.from)
        : Math.max(Date.parse(binding.allowed_from), to - 60000);
      if (
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        from >= to ||
        to > now ||
        to - from > 15 * 60000 ||
        from < Date.parse(binding.allowed_from) ||
        to > Date.parse(binding.allowed_to)
      )
        throw new LiveSourceError('time_window_denied');
      if (kind === 'trace' || kind === 'git_diff')
        throw new LiveSourceError('unsupported');
      reservation = this.budget.reserve();
      const queryId = randomUUID();
      const window = {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
      };
      const endpoint = new URL(`/observations/${kind}`, source.base_url);
      for (const [key, value] of Object.entries({
        query_id: queryId,
        source_id: source.source_id,
        service: binding.service,
        environment: binding.environment,
        ...window,
        limit: String(input.limit),
      }))
        endpoint.searchParams.set(key, value);
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), source.timeout_ms);
      const combined = signal
        ? AbortSignal.any([signal, timeout.signal])
        : timeout.signal;
      try {
        const response = await fetch(endpoint, {
          headers: { authorization: `Bearer ${source.read_token}` },
          signal: combined,
          redirect: 'error',
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw new LiveSourceError('unavailable');
        }
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            response.headers.get('content-type') ?? '',
          )
        ) {
          await response.body?.cancel();
          throw new LiveSourceError('invalid_response');
        }
        if (
          Number(response.headers.get('content-length')) > LIVE_RESPONSE_BYTES
        ) {
          await response.body?.cancel();
          throw new LiveSourceError('response_too_large');
        }
        const reader = response.body?.getReader();
        if (!reader) throw new LiveSourceError('invalid_response');
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            reservation.received(part.value.byteLength);
            if (size > LIVE_RESPONSE_BYTES) {
              await reader.cancel();
              throw new LiveSourceError('response_too_large');
            }
            chunks.push(part.value);
          }
        } finally {
          reader.releaseLock();
        }
        if (combined.aborted)
          throw new LiveSourceError(signal?.aborted ? 'cancelled' : 'timeout');
        let value: unknown;
        try {
          value = JSON.parse(
            new TextDecoder('utf-8', { fatal: true }).decode(
              Buffer.concat(chunks),
            ),
          );
        } catch {
          throw new LiveSourceError('invalid_response');
        }
        const observation = (
          kind === 'logs' ? logResponse : metricsResponse
        ).safeParse(value);
        if (!observation.success) throw new LiveSourceError('invalid_response');
        const data = observation.data;
        if (
          data.kind !== kind ||
          data.query_id !== queryId ||
          data.source_id !== source.source_id ||
          data.service !== binding.service ||
          data.environment !== binding.environment ||
          (source.instance_id !== undefined &&
            data.instance_id !== source.instance_id) ||
          data.window.from !== window.from ||
          data.window.to !== window.to ||
          Date.parse(data.observed_at) < now - 2000 ||
          Date.parse(data.observed_at) > Date.now() + 1000 ||
          data.items.length > input.limit ||
          (data.status === 'empty') !== (data.items.length === 0)
        )
          throw new LiveSourceError('invalid_response');
        let previous = from;
        for (const item of data.items) {
          const time = Date.parse(
            'timestamp' in item ? item.timestamp : item.observed_at,
          );
          if (time < from || time > to || time < previous)
            throw new LiveSourceError('invalid_response');
          previous = time;
        }
        const evidence: CollectedIncidentEvidence = {
          evidence_id: `${id}:${this.runId}:${kind}:${queryId}`,
          incident_id: id,
          source: kind,
          timestamp: data.observed_at,
          correlation_id: queryId,
          content: JSON.stringify({ ...data, run_id: this.runId }),
        };
        const text = JSON.stringify(evidence);
        if (Buffer.byteLength(text) > LIVE_RESPONSE_BYTES)
          throw new LiveSourceError('response_too_large');
        reservation.output(Buffer.byteLength(text));
        return { content: [{ type: 'text', text }] };
      } catch (error) {
        if (signal?.aborted) throw new LiveSourceError('cancelled');
        if (timeout.signal.aborted) throw new LiveSourceError('timeout');
        if (error instanceof LiveSourceError) throw error;
        throw new LiveSourceError('unavailable');
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return liveErrorResult(
        id,
        error instanceof LiveSourceError ? error.code : 'invalid_response',
      );
    } finally {
      reservation?.finish();
    }
  }
}
