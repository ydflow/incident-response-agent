/** Real HTTP/resource contention demo. No database, production or Agent control. */
import { randomUUID, timingSafeEqual } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';

const name = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const configSchema = z.strictObject({
  capacity: z.number().int().min(1).max(32),
  hold_ms: z.number().int().min(0).max(2000),
  acquire_timeout_ms: z.number().int().min(10).max(2000),
  query_delay_ms: z.number().int().min(0).max(2000),
});
export type DemoPoolConfig = z.infer<typeof configSchema>;
const initialConfig: DemoPoolConfig = {
  capacity: 4,
  hold_ms: 20,
  acquire_timeout_ms: 500,
  query_delay_ms: 0,
};
const optionsSchema = z.strictObject({
  source_id: name,
  service: name,
  environment: name,
  read_token: z.string().regex(/^[0-9a-f]{64}$/),
  control_token: z.string().regex(/^[0-9a-f]{64}$/),
  port: z.number().int().min(0).max(65535).default(0),
  sample_interval_ms: z.number().int().min(20).max(1000).default(500),
});
export type LocalDemoOptions = z.input<typeof optionsSchema>;
type LogItem = {
  timestamp: string;
  level: 'INFO' | 'WARN' | 'ERROR';
  request_id: string;
  component: 'resource_pool';
  message:
    | 'pool_acquired'
    | 'pool_timeout'
    | 'request_complete'
    | 'request_cancelled'
    | 'queue_overflow';
  wait_ms: number;
};
type MetricItem = {
  observed_at: string;
  pool_capacity: number;
  pool_active: number;
  pool_waiting: number;
  requests_total: number;
  requests_success: number;
  acquire_timeouts: number;
  requests_cancelled: number;
  queue_overflows: number;
  acquire_wait_ms_total: number;
};
class DemoError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
class Ring<T> {
  private values: T[] = [];
  dropped = 0;
  push(value: T) {
    this.values.push(value);
    if (this.values.length > 2000) {
      this.values.shift();
      this.dropped++;
    }
  }
  snapshot() {
    return [...this.values];
  }
}
type Waiter = {
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};
class ResourcePool {
  active = 0;
  private queue: Waiter[] = [];
  private stopped = false;
  constructor(
    private capacity: number,
    private timeout: number,
  ) {}
  get waiting() {
    return this.queue.length;
  }
  configure(capacity: number, timeout: number) {
    this.capacity = capacity;
    this.timeout = timeout;
    this.pump();
  }
  private slot() {
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.pump();
    };
  }
  private pump() {
    while (!this.stopped && this.active < this.capacity && this.queue.length) {
      const item = this.queue.shift()!;
      item.cleanup();
      item.resolve(this.slot());
    }
  }
  acquire(signal: AbortSignal): Promise<() => void> {
    if (this.stopped) return Promise.reject(new DemoError('service_stopping'));
    if (signal.aborted) return Promise.reject(new DemoError('cancelled'));
    if (this.active < this.capacity) return Promise.resolve(this.slot());
    if (this.queue.length >= 128)
      return Promise.reject(new DemoError('queue_overflow'));
    return new Promise((resolve, reject) => {
      const remove = (code: string) => {
        const index = this.queue.indexOf(item);
        if (index < 0) return;
        this.queue.splice(index, 1);
        item.cleanup();
        reject(new DemoError(code));
      };
      const aborted = () => remove('cancelled');
      const timer = setTimeout(() => remove('acquire_timeout'), this.timeout);
      const item: Waiter = {
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal.removeEventListener('abort', aborted);
        },
      };
      this.queue.push(item);
      signal.addEventListener('abort', aborted, { once: true });
    });
  }
  stop() {
    this.stopped = true;
    for (const item of this.queue.splice(0)) {
      item.cleanup();
      item.reject(new DemoError('service_stopping'));
    }
  }
}
const querySchema = z.strictObject({
  query_id: z.uuid(),
  source_id: name,
  service: name,
  environment: name,
  from: z.iso.datetime({ offset: true }),
  to: z.iso.datetime({ offset: true }),
  limit: z.coerce.number().int().min(1).max(200),
});
function authorized(req: IncomingMessage, secret: string): boolean {
  const token = /^Bearer ([0-9a-f]{64})$/.exec(
    req.headers.authorization ?? '',
  )?.[1];
  return (
    !!token &&
    timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(secret, 'hex'))
  );
}
function json(res: ServerResponse, status: number, value: unknown) {
  if (res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
async function body(req: IncomingMessage): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? ''))
    throw new DemoError('invalid_json');
  if (Number(req.headers['content-length']) > 4096)
    throw new DemoError('body_too_large');
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const bytes = Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 4096) throw new DemoError('body_too_large');
    chunks.push(bytes);
  }
  try {
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new DemoError('invalid_json');
  }
}

/** Binds only an owned loopback socket. close() stops only this instance. */
export async function startLocalIncidentDemo(input: LocalDemoOptions) {
  const options = optionsSchema.parse(input);
  if (options.read_token === options.control_token)
    throw new DemoError('separate_tokens_required');
  const instanceId = randomUUID();
  let config = { ...initialConfig };
  const pool = new ResourcePool(config.capacity, config.acquire_timeout_ms);
  const logs = new Ring<LogItem>();
  const metrics = new Ring<MetricItem>();
  const counters = {
    requests_total: 0,
    requests_success: 0,
    acquire_timeouts: 0,
    requests_cancelled: 0,
    queue_overflows: 0,
    acquire_wait_ms_total: 0,
  };
  const controllers = new Set<AbortController>();
  const snapshot = () =>
    metrics.push({
      observed_at: new Date().toISOString(),
      pool_capacity: config.capacity,
      pool_active: pool.active,
      pool_waiting: pool.waiting,
      ...counters,
    });
  const log = (id: string, message: LogItem['message'], wait: number) =>
    logs.push({
      timestamp: new Date().toISOString(),
      level:
        message === 'pool_timeout' || message === 'queue_overflow'
          ? 'ERROR'
          : message === 'request_cancelled'
            ? 'WARN'
            : 'INFO',
      request_id: id,
      component: 'resource_pool',
      message,
      wait_ms: Math.max(0, wait),
    });
  snapshot();
  const sampler = setInterval(snapshot, options.sample_interval_ms);
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    controllers.add(controller);
    const abort = () => {
      if (!res.writableEnded) controller.abort();
    };
    req.once('aborted', abort);
    res.once('close', abort);
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/control/config') {
        if (!authorized(req, options.control_token)) {
          json(res, 401, { error: 'Unauthorized' });
          return;
        }
        if (req.method !== 'POST') {
          json(res, 405, { error: 'method_not_allowed' });
          return;
        }
        const parsed = configSchema.safeParse(await body(req));
        if (!parsed.success) {
          json(res, 400, { error: 'invalid_config' });
          return;
        }
        config = parsed.data;
        pool.configure(config.capacity, config.acquire_timeout_ms);
        snapshot();
        json(res, 200, { demo: true, instance_id: instanceId, config });
        return;
      }
      if (!authorized(req, options.read_token)) {
        json(res, 401, { error: 'Unauthorized' });
        return;
      }
      if (req.method !== 'GET') {
        json(res, 405, { error: 'method_not_allowed' });
        return;
      }
      if (url.pathname === '/health') {
        json(res, 200, {
          demo: true,
          instance_id: instanceId,
          source_id: options.source_id,
          service: options.service,
          environment: options.environment,
        });
        return;
      }
      if (url.pathname === '/work') {
        if (url.searchParams.size) {
          json(res, 400, { error: 'invalid_work_query' });
          return;
        }
        counters.requests_total++;
        const id = randomUUID();
        const start = performance.now();
        let release: (() => void) | undefined;
        snapshot();
        try {
          release = await pool.acquire(controller.signal);
          const waited = performance.now() - start;
          counters.acquire_wait_ms_total += waited;
          log(id, 'pool_acquired', waited);
          snapshot();
          await delay(config.hold_ms, undefined, { signal: controller.signal });
          counters.requests_success++;
          log(id, 'request_complete', waited);
          json(res, 200, { demo: true, request_id: id, status: 'complete' });
        } catch (error) {
          if (error instanceof DemoError && error.code === 'acquire_timeout') {
            counters.acquire_timeouts++;
            log(id, 'pool_timeout', performance.now() - start);
            json(res, 503, {
              demo: true,
              request_id: id,
              error: 'acquire_timeout',
            });
          } else if (
            error instanceof DemoError &&
            error.code === 'queue_overflow'
          ) {
            counters.queue_overflows++;
            log(id, 'queue_overflow', performance.now() - start);
            json(res, 503, {
              demo: true,
              request_id: id,
              error: 'queue_overflow',
            });
          } else {
            counters.requests_cancelled++;
            log(id, 'request_cancelled', performance.now() - start);
            json(res, 503, { demo: true, request_id: id, error: 'cancelled' });
          }
        } finally {
          release?.();
          snapshot();
        }
        return;
      }
      const kind =
        url.pathname === '/observations/logs'
          ? 'logs'
          : url.pathname === '/observations/metrics'
            ? 'metrics'
            : null;
      if (!kind) {
        json(res, 404, { error: 'not_found' });
        return;
      }
      const parsed = querySchema.safeParse(
        Object.fromEntries(url.searchParams),
      );
      if (!parsed.success) {
        json(res, 400, { error: 'invalid_query' });
        return;
      }
      const query = parsed.data;
      if (
        query.source_id !== options.source_id ||
        query.service !== options.service ||
        query.environment !== options.environment
      ) {
        json(res, 403, { error: 'scope_denied' });
        return;
      }
      const from = Date.parse(query.from),
        to = Date.parse(query.to);
      if (from >= to || to > Date.now() || to - from > 15 * 60000) {
        json(res, 400, { error: 'time_window_denied' });
        return;
      }
      await delay(config.query_delay_ms, undefined, {
        signal: controller.signal,
      });
      const ring = kind === 'logs' ? logs : metrics;
      const selected = ring.snapshot().filter((item) => {
        const time = Date.parse(
          'timestamp' in item ? item.timestamp : item.observed_at,
        );
        return time >= from && time <= to;
      });
      // Newest bounded subset, still chronological. Cap actual serialized bytes.
      let items = selected.slice(-query.limit);
      let truncated = items.length < selected.length;
      const envelope = () => ({
        provider: 'local_demo',
        source_id: options.source_id,
        instance_id: instanceId,
        service: options.service,
        environment: options.environment,
        query_id: query.query_id,
        kind,
        observed_at: new Date().toISOString(),
        window: { from: query.from, to: query.to },
        status: items.length ? 'success' : 'empty',
        items,
        truncated,
        retention_dropped: ring.dropped,
      });
      while (
        Buffer.byteLength(JSON.stringify(envelope())) > 48 * 1024 &&
        items.length
      ) {
        items = items.slice(1);
        truncated = true;
      }
      json(res, 200, envelope());
    } catch (error) {
      if (controller.signal.aborted) return;
      json(res, error instanceof DemoError ? 400 : 500, {
        error: error instanceof DemoError ? error.code : 'demo_request_failed',
      });
    } finally {
      controllers.delete(controller);
      req.removeListener('aborted', abort);
      res.removeListener('close', abort);
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.timeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    clearInterval(sampler);
    pool.stop();
    throw error;
  }
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new DemoError('invalid_listen_address');
  let closed = false;
  return {
    base_url: `http://127.0.0.1:${address.port}`,
    instance_id: instanceId,
    source_id: options.source_id,
    service: options.service,
    environment: options.environment,
    close: async () => {
      if (closed) return;
      closed = true;
      clearInterval(sampler);
      pool.stop();
      for (const controller of controllers) controller.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

/** Finite local load, fixed /work route, supplied only by trusted demo CLI. */
export async function runLocalDemoLoad(
  baseUrl: string,
  token: string,
  requests = 12,
  concurrency = 8,
) {
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(baseUrl) ||
    Number(new URL(baseUrl).port) > 65535 ||
    !/^[0-9a-f]{64}$/.test(token) ||
    !Number.isInteger(requests) ||
    requests < 1 ||
    requests > 100 ||
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > 16
  )
    throw new DemoError('invalid_load');
  let index = 0;
  let success = 0;
  let timeout = 0;
  let unavailable = 0;
  const deadline = AbortSignal.timeout(15000);
  await Promise.all(
    Array.from({ length: Math.min(concurrency, requests) }, async () => {
      while (index < requests && !deadline.aborted) {
        index++;
        try {
          const response = await fetch(`${baseUrl}/work`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.any([deadline, AbortSignal.timeout(3000)]),
            redirect: 'error',
          });
          if (response.ok) success++;
          else if (response.status === 503) timeout++;
          else unavailable++;
          await response.body?.cancel();
        } catch {
          unavailable++;
        }
      }
    }),
  );
  return {
    requested: requests,
    attempted: index,
    success,
    resource_failures: timeout,
    unavailable,
  };
}
