import { createServer } from 'node:http';
import { expect, test } from 'vitest';
import { investigationDb } from './helpers/incident-investigation-db.js';
import { startIncidentModelBudget } from '../src/incident-model-budget.js';
test('unauthorized input does not dispatch; HTTP reservations bound actual upstream attempts, retry and stale lease', async () => {
  const f = investigationDb();
  let calls = 0;
  const server = createServer((req, res) => {
    calls++;
    req.resume();
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"error":"fixture_unavailable"}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as any).port;
  const id = f.send().items[0].incident_id,
    lease = f.store.claim('worker')!;
  const boundaries: string[] = [];
  const proxy = await startIncidentModelBudget(
    f.store,
    lease,
    {
      base_url: `http://127.0.0.1:${port}`,
      model: 'test',
      api_key: 'test-only',
      mode: 'protocol_stub',
    },
    { max_requests: 1, onBoundary: (code) => boundaries.push(code) },
  );
  const send = (token: string) =>
    fetch(proxy.base_url + '/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        stream: false,
        messages: [],
        max_tokens: 8192,
      }),
    });
  try {
    const denied = await send('wrong');
    expect(denied.status).toBe(400);
    await denied.body?.cancel();
    expect(calls).toBe(0);
    const first = await send(proxy.api_key);
    expect(first.status).toBe(503);
    await first.text();
    expect(calls).toBe(1);
    const second = await send(proxy.api_key);
    expect(((await second.json()) as any).error.message).toBe('model_budget');
    expect(calls).toBe(1);
    expect(boundaries).toContain('model_budget');
    f.store.retry(lease, 'restart');
    const stale = await send(proxy.api_key);
    expect(((await stale.json()) as any).error.message).toBe('stale_lease');
    expect(calls).toBe(1);
    expect(f.store.list(id)[0].model_requests).toBe(1);
  } finally {
    await proxy.close();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    f.db.close();
  }
});
test('model HTTP timeout aborts owned request with finite wall time', async () => {
  const f = investigationDb(),
    server = createServer((req) => req.resume());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  f.send();
  const lease = f.store.claim('worker')!,
    boundaries: string[] = [];
  const proxy = await startIncidentModelBudget(
    f.store,
    lease,
    {
      base_url: `http://127.0.0.1:${(server.address() as any).port}`,
      model: 'test',
      api_key: 'test-only',
      mode: 'protocol_stub',
    },
    { timeout_ms: 50, onBoundary: (code) => boundaries.push(code) },
  );
  try {
    const res = await fetch(proxy.base_url + '/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': proxy.api_key,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: 'test', stream: false, messages: [] }),
    });
    await res.text();
    expect(boundaries).toContain('model_timeout');
    expect(f.store.run(lease.run_id).model_requests).toBe(1);
  } finally {
    await proxy.close();
    await new Promise<void>((r) => {
      server.close(() => r());
      server.closeAllConnections();
    });
    f.db.close();
  }
});
