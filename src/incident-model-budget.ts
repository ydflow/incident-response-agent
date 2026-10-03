/** Fixed Anthropic-compatible transport; quota is reserved before each upstream HTTP request. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { InvestigationStore } from './incident-investigation-store.js';
import {
  InvestigationError,
  fail,
  type Lease,
} from './incident-investigation-types.js';
export type IncidentModelConfig = {
  base_url: string;
  model: string;
  api_key?: string;
  auth_token?: string;
  mode: 'real_pi' | 'protocol_stub';
};
export async function startIncidentModelBudget(
  store: InvestigationStore,
  lease: Lease,
  config: IncidentModelConfig,
  options: {
    max_requests?: number;
    timeout_ms?: number;
    signal?: AbortSignal;
    onBoundary?: (code: string) => void;
  } = {},
) {
  const base = new URL(config.base_url),
    max = options.max_requests ?? 6,
    timeout = options.timeout_ms ?? 30000;
  if (
    !config.model ||
    max < 1 ||
    max > 6 ||
    timeout < 10 ||
    timeout > 30000 ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    !(
      base.protocol === 'https:' ||
      (config.mode === 'protocol_stub' &&
        base.protocol === 'http:' &&
        base.hostname === '127.0.0.1')
    )
  )
    fail('unsupported_model_transport');
  const endpoint = `${base.toString().replace(/\/+$/, '')}/v1/messages`,
    token = randomBytes(32).toString('hex'),
    controllers = new Set<AbortController>();
  const server = createServer(async (req, res) => {
    let requestId: string | undefined,
      received = 0;
    const controller = new AbortController();
    controllers.add(controller);
    const upstreamAbort = () => controller.abort();
    options.signal?.addEventListener('abort', upstreamAbort, { once: true });
    const timer = setTimeout(() => {
      options.onBoundary?.('model_timeout');
      controller.abort();
    }, timeout);
    try {
      if (
        req.method !== 'POST' ||
        req.url !== '/v1/messages' ||
        req.headers['x-api-key'] !== token
      )
        fail('model_proxy_request_denied');
      if (
        req.headers['content-encoding'] ||
        !String(req.headers['content-type']).startsWith('application/json')
      )
        fail('model_proxy_invalid_input');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 262144) fail('model_input_limit');
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const expected = config.model.includes('/')
        ? config.model.slice(config.model.indexOf('/') + 1)
        : config.model;
      if (
        body.model !== expected ||
        !Array.isArray(body.messages) ||
        typeof body.stream !== 'boolean'
      )
        fail('model_proxy_invalid_input');
      body.max_tokens = Math.min(Number(body.max_tokens) || 4096, 4096);
      delete body.thinking; // Isolated investigation output budget, no generic Runtime change.
      const serialized = JSON.stringify(body);
      requestId = store.reserveModel(
        lease,
        config.mode,
        max,
        Buffer.byteLength(serialized),
      );
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        'anthropic-version': '2023-06-01',
      };
      if (config.api_key) headers['x-api-key'] = config.api_key;
      else if (config.auth_token)
        headers.authorization = /^Bearer /i.test(config.auth_token)
          ? config.auth_token
          : `Bearer ${config.auth_token}`;
      else fail('model_credentials_unavailable');
      // Conservative ledger can be one reservation ahead after a crash; never refunds.
      store.modelState(lease, requestId, 'dispatched');
      if (options.signal?.aborted) controller.abort();
      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: serialized,
        redirect: 'error',
        signal: controller.signal,
      });
      const contentType = response.headers.get('content-type') ?? '';
      if (!/^(application\/json|text\/event-stream)/i.test(contentType))
        fail('model_response_invalid_type');
      res.writeHead(response.status, {
        'content-type': contentType,
        'cache-control': 'no-store',
      });
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const reader = response.body?.getReader();
      if (!reader) fail('model_response_missing');
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          received += part.value.byteLength;
          if (received > 1048576) fail('model_output_limit');
          if (controller.signal.aborted) fail('model_cancelled');
          res.write(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      store.modelState(
        lease,
        requestId,
        response.ok ? 'received' : 'failed',
        response.status,
        received,
      );
      res.end();
    } catch (error) {
      const code =
        error instanceof InvestigationError
          ? error.code
          : controller.signal.aborted
            ? 'model_cancelled'
            : 'model_upstream_unavailable';
      if (requestId) {
        try {
          store.modelState(lease, requestId, 'failed', null, received);
        } catch {
          /* lease fencing wins */
        }
      }
      if (
        [
          'model_budget',
          'wall_budget',
          'stale_lease',
          'model_input_limit',
          'model_output_limit',
        ].includes(code)
      )
        options.onBoundary?.(code);
      if (!res.headersSent)
        res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: code },
        }),
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', upstreamAbort);
      controllers.delete(controller);
    }
  });
  server.requestTimeout = 35000;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') fail('model_proxy_start_failed');
  return {
    base_url: `http://127.0.0.1:${address.port}`,
    api_key: token,
    model: config.model,
    async close() {
      for (const c of controllers) c.abort();
      await new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}
