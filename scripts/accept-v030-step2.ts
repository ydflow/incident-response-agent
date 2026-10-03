/** Local HTTP acceptance. Own temporary host/database, no Runtime or model. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { ServerType } from '@hono/node-server';

const originalCwd = process.cwd();
const originalSecret = process.env.WEB_SESSION_SECRET;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v030-step2-http-'));
// Config resolves DATA_DIR from cwd at import time. Never import host modules
// until our independent working directory and ephemeral signing key are set.
process.chdir(tmp);
process.env.WEB_SESSION_SECRET = randomBytes(32).toString('hex');
let server: ServerType | undefined;
let closeDatabase: (() => void) | undefined;
async function stopServer() {
  if (!server) return;
  const owned = server;
  server = undefined;
  await new Promise<void>((resolve, reject) =>
    owned.close((error) => (error ? reject(error) : resolve())),
  );
}
try {
  const host = await import('../src/db.js');
  closeDatabase = host.closeDatabase;
  const { createIncidentAlertRoutes } =
    await import('../src/routes/incident-alerts.js');
  const { signSessionToken, generateSessionToken } =
    await import('../src/auth.js');
  host.initDatabase();
  const date = new Date().toISOString();
  host.createUser({
    id: 'local-admin',
    username: 'local-admin',
    password_hash: 'test-only-no-login',
    display_name: 'Local Acceptance',
    role: 'admin',
    status: 'active',
    created_at: date,
    updated_at: date,
  });
  const session = generateSessionToken();
  host.createUserSession({
    id: session,
    user_id: 'local-admin',
    ip_address: '127.0.0.1',
    user_agent: 'step2-acceptance',
    created_at: date,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    last_active_at: date,
  });
  const cookie = `miniclaw_session=${signSessionToken(session)}`;
  const startServer = () =>
    new Promise<string>((resolve) => {
      const app = new Hono();
      app.route('/api/incident-alerts', createIncidentAlertRoutes());
      server = serve(
        { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
        (info) => resolve(`http://127.0.0.1:${info.port}/api/incident-alerts`),
      );
    });
  let base = await startServer();
  const credentialResponse = await fetch(`${base}/credentials`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      owner_user_id: 'local-admin',
      source: 'demo',
      scopes: [
        { service: 'orders', environment: 'local' },
        { service: 'orders', environment: 'staging' },
      ],
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    }),
  });
  assert.equal(credentialResponse.status, 201);
  const credential = (await credentialResponse.json()) as { token: string };
  const headers = {
    authorization: `Bearer ${credential.token}`,
    'content-type': 'application/json',
  };
  const payload = {
    source: 'demo',
    external_id: 'pool-1',
    service: 'orders',
    environment: 'local',
    severity: 'critical',
    fingerprint: 'connection-pool',
    starts_at: new Date(Date.now() - 10000).toISOString(),
    status: 'firing',
    summary: 'Connection pool exhausted; token=redact-this',
    description: '本任务本地 POST 接收验收',
  };
  const send = async (body: unknown, key: string, expected = 201) => {
    const result = await fetch(`${base}/webhook`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    assert.equal(result.status, expected);
    return result.json() as Promise<{
      delivery_id: string;
      items: Array<{ incident_id: string }>;
    }>;
  };
  const first = await send(payload, 'delivery-1');
  const retries = await Promise.all(
    Array.from({ length: 6 }, () => send(payload, 'delivery-1', 200)),
  );
  assert.ok(retries.every((r) => r.delivery_id === first.delivery_id));
  const aggregated = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      send({ ...payload, external_id: `pool-extra-${i}` }, `extra-${i}`),
    ),
  );
  assert.ok(
    aggregated.every(
      (r) => r.items[0].incident_id === first.items[0].incident_id,
    ),
  );
  const other = await send({ ...payload, environment: 'staging' }, 'staging');
  assert.notEqual(other.items[0].incident_id, first.items[0].incident_id);
  await send({ ...payload, environment: '' }, 'invalid', 400);
  for (const id of [
    'pool-1',
    ...Array.from({ length: 6 }, (_, i) => `pool-extra-${i}`),
  ])
    await send(
      {
        ...payload,
        external_id: id,
        status: 'resolved',
        ends_at: new Date().toISOString(),
      },
      `resolved-${id}`,
    );
  const read = async () => {
    const response = await fetch(
      `${base}/incidents/${first.items[0].incident_id}`,
      { headers },
    );
    assert.equal(response.status, 200);
    return response.json() as Promise<{
      metadata: {
        status: string;
        alert_status: string;
        alert_count: number;
        delivery_count: number;
      };
      alerts: unknown[];
    }>;
  };
  const before = await read();
  assert.equal(before.metadata.status, 'RECEIVED');
  assert.equal(before.metadata.alert_status, 'resolved');
  assert.equal(before.metadata.alert_count, 7);
  assert.equal(before.metadata.delivery_count, 14);
  assert.ok(!JSON.stringify(before).includes('redact-this'));
  await stopServer();
  host.closeDatabase();
  host.initDatabase();
  base = await startServer();
  assert.deepEqual(await read(), before);
  assert.equal((await fetch(base)).status, 401);
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        http: 'own loopback server, manual POST',
        database: 'independent temporary SQLite, closed and reopened',
        duplicate_retries: 6,
        concurrent_distinct_alerts: 6,
        incidents: 2,
        persisted_alerts: 8,
        investigation_status: 'RECEIVED',
        alert_status: 'resolved',
        actual_alertmanager_connected: false,
        model_calls: 0,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    'Step 2 acceptance failed:',
    error instanceof Error ? error.message : 'unknown_error',
  );
  process.exitCode = 1;
} finally {
  await stopServer();
  closeDatabase?.();
  process.chdir(originalCwd);
  if (originalSecret === undefined) delete process.env.WEB_SESSION_SECRET;
  else process.env.WEB_SESSION_SECRET = originalSecret;
  // Only remove the directory created by this script; never a computed user DB.
  if (
    path.dirname(path.resolve(tmp)) !== path.resolve(os.tmpdir()) ||
    !path.basename(tmp).startsWith('v030-step2-http-')
  )
    throw new Error('unexpected_temporary_path');
  fs.rmSync(tmp, { recursive: true, force: true });
}
