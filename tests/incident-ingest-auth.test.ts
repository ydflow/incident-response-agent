import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { AuthUser, UserSessionWithUser } from '../src/types.js';
import { createIncidentSchema, IncidentStore } from '../src/incident-store.js';
import {
  createInvestigationSchema,
  InvestigationStore,
} from '../src/incident-investigation-store.js';

const users = new Map<string, AuthUser>();
const sessions = new Map<string, UserSessionWithUser>();
vi.mock('../src/config.js', () => ({
  WEB_SESSION_SECRET: 'isolated-test-secret',
  SESSION_COOKIE_NAME_SECURE: '__Host-miniclaw_session',
  SESSION_COOKIE_NAME_PLAIN: 'miniclaw_session',
  LEGACY_SESSION_COOKIE_NAME_SECURE: '__Host-miniclaw_session',
  LEGACY_SESSION_COOKIE_NAME_PLAIN: 'miniclaw_session',
  DATA_DIR: 'unused-test-dir',
  TRUST_PROXY: false,
}));
vi.mock('../src/db.js', () => ({
  getUserById: (id: string) => users.get(id),
  updateSessionLastActive: vi.fn(),
  deleteUserSession: (id: string) => sessions.delete(id),
}));
vi.mock('../src/web-context.js', () => ({
  lastActiveCache: new Map(),
  LAST_ACTIVE_DEBOUNCE_MS: 300000,
  getCachedSessionWithUser: (id: string) => sessions.get(id),
  invalidateSessionCache: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger: { info: vi.fn() } }));
const { createIncidentAlertRoutes } =
  await import('../src/routes/incident-alerts.js');
const { signSessionToken } = await import('../src/auth.js');
const { authMiddleware } = await import('../src/middleware/auth.js');
let db: Database.Database;
let store: IncidentStore;
let app: Hono;
function user(id: string, admin = false, permission = true): AuthUser {
  return {
    id,
    username: id,
    display_name: id,
    role: admin ? 'admin' : 'member',
    status: 'active',
    permissions: permission ? ['ingest_alerts'] : [],
    must_change_password: false,
  };
}
const cookie = (id: string) => `miniclaw_session=${signSessionToken(id)}`;
const payload = () => ({
  source: 'demo',
  service: 'orders',
  environment: 'local',
  severity: 'critical',
  fingerprint: 'pool',
  starts_at: new Date(Date.now() - 1000).toISOString(),
  status: 'firing',
  summary: 'Pool exhausted',
});
beforeEach(() => {
  users.clear();
  sessions.clear();
  for (const u of [
    user('admin', true),
    user('member'),
    user('basic', false, false),
  ]) {
    users.set(u.id, u);
    sessions.set(u.id, {
      ...u,
      user_id: u.id,
      ip_address: null,
      user_agent: null,
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 86400000).toISOString(),
      last_active_at: new Date().toISOString(),
    });
  }
  db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('admin'),('member'),('basic');",
  );
  createIncidentSchema(db);
  store = new IncidentStore(db);
  app = new Hono();
  app.route(
    '/api/incident-alerts',
    createIncidentAlertRoutes({ store: () => store }),
  );
  app.use('/api/admin/*', authMiddleware);
  app.get('/api/admin/check', (c) => c.json({ ok: true }));
});
afterEach(() => db.close());
test('Console endpoints enforce signed identity, permission, scope and query bounds', async () => {
  createInvestigationSchema(db);
  const investigations = new InvestigationStore(db);
  app = new Hono();
  app.route(
    '/api/incident-alerts',
    createIncidentAlertRoutes({
      store: () => store,
      investigations: () => investigations,
    }),
  );
  const credential = token(),
    headers = { authorization: `Bearer ${credential.token}` };
  const id = (
    (await (await post('/webhook', payload(), headers)).json()) as any
  ).items[0].incident_id;
  const foreign = (
    (await (
      await post('/webhook', { ...payload(), environment: 'staging' })
    ).json()) as any
  ).items[0].incident_id;
  const base = '/api/incident-alerts/console/incidents';
  expect((await app.request(base)).status).toBe(401);
  expect(
    (await app.request(base, { headers: { cookie: cookie('basic') } })).status,
  ).toBe(403);
  const response = await app.request(base, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const list = (await response.json()) as any;
  expect(list.items.map((i: any) => i.incident_id)).toEqual([id]);
  expect(list.items[0].job.state).toBe('queued');
  expect(list.items[0].source_mode).toBe('unbound');
  expect((await app.request(`${base}/${foreign}`, { headers })).status).toBe(
    404,
  );
  for (const query of [
    'limit=21',
    'limit=0',
    'offset=10001',
    'url=http://localhost',
    'service=../orders',
  ])
    expect((await app.request(`${base}?${query}`, { headers })).status).toBe(
      400,
    );
  expect((await app.request(`${base}/INC-001`, { headers })).status).toBe(400);
});
test('Console run/reference reads reject foreign ownership and do not mutate a lease', async () => {
  createInvestigationSchema(db);
  const investigations = new InvestigationStore(db);
  app = new Hono();
  app.route(
    '/api/incident-alerts',
    createIncidentAlertRoutes({
      store: () => store,
      investigations: () => investigations,
    }),
  );
  const id = ((await (await post('/webhook', payload())).json()) as any)
    .items[0].incident_id;
  const second = (
    (await (
      await post('/webhook', { ...payload(), fingerprint: 'other' })
    ).json()) as any
  ).items[0].incident_id;
  const lease = investigations.claim('console-test', { incident_id: id })!;
  const before = JSON.stringify(investigations.job(lease.job_id));
  const get = (url: string) =>
    app.request(url, { headers: { cookie: cookie('admin') } });
  const url = `/api/incident-alerts/console/incidents/${id}/runs/${lease.run_id}`;
  const view = (await (
    await get(`${url}?section=replay&limit=1`)
  ).json()) as any;
  expect(view.readonly).toBe(true);
  expect(view.items).toEqual([]);
  expect(view.empty_reason).toBeTruthy();
  expect(JSON.stringify(view)).not.toMatch(
    /lease_token|snapshot_json|report_json|runtime_trace_json|"owner"/,
  );
  expect(
    (
      await get(
        `/api/incident-alerts/console/incidents/${second}/runs/${lease.run_id}`,
      )
    ).status,
  ).toBe(404);
  expect((await get(`${url}?section=evidence&reference=absent`)).status).toBe(
    404,
  );
  expect((await get(`${url}?section=report&reference=absent`)).status).toBe(
    400,
  );
  expect((await get(`${url}?section=execute`)).status).toBe(400);
  expect(JSON.stringify(investigations.job(lease.job_id))).toBe(before);
});
test('investigation queries retain credential scope and explicit recheck requires an admin session', async () => {
  createInvestigationSchema(db);
  const investigation = new InvestigationStore(db);
  app = new Hono();
  app.route(
    '/api/incident-alerts',
    createIncidentAlertRoutes({
      store: () => store,
      investigations: () => investigation,
    }),
  );
  const credential = token(),
    headers = { authorization: `Bearer ${credential.token}` };
  const response = await post('/webhook', payload(), headers);
  expect(response.status).toBe(201);
  const id = ((await response.json()) as any).items[0].incident_id;
  const url = `/api/incident-alerts/incidents/${id}/investigations`;
  expect((await app.request(url)).status).toBe(401);
  expect((await app.request(url, { headers })).status).toBe(200);
  const foreign = (
    (await (
      await post('/webhook', { ...payload(), environment: 'staging' })
    ).json()) as any
  ).items[0].incident_id;
  expect(
    (
      await app.request(
        `/api/incident-alerts/incidents/${foreign}/investigations`,
        { headers },
      )
    ).status,
  ).toBe(404);
  expect(
    (await post(`/incidents/${id}/investigations`, {}, headers)).status,
  ).toBe(403);
  expect(
    (
      await post(
        `/incidents/${id}/investigations`,
        {},
        { cookie: cookie('member') },
      )
    ).status,
  ).toBe(403);
  expect((await post(`/incidents/${id}/investigations`, {})).status).toBe(409);
  const lease = investigation.claim('test', { incident_id: id })!;
  investigation.retry(lease, 'test_retry');
  const second = investigation.claim(
    'test2',
    { incident_id: id },
    Date.now() + 10001,
  )!;
  investigation.retry(second, 'final_failure', Date.now() + 10001);
  expect((await post(`/incidents/${id}/investigations`, {})).status).toBe(201);
  expect(investigation.list(id)).toHaveLength(2);
});
function token(owner = 'member', source = 'demo') {
  return store.issueCredential({
    owner_user_id: owner,
    source,
    scopes: [{ service: 'orders', environment: 'local' }],
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  });
}
function post(
  path: string,
  body: unknown,
  auth: Record<string, string> = { cookie: cookie('admin') },
  extra: Record<string, string> = {},
) {
  return app.request(`/api/incident-alerts${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth, ...extra },
    body: JSON.stringify(body),
  });
}
describe('dedicated alert permission over existing signed session/account auth', () => {
  test('anonymous, forged and expired sessions are denied', async () => {
    expect((await post('/webhook', payload(), {})).status).toBe(401);
    expect(
      (await post('/webhook', payload(), { cookie: 'miniclaw_session=forged' }))
        .status,
    ).toBe(401);
    sessions.get('admin')!.expires_at = '2000-01-01T00:00:00Z';
    expect((await post('/webhook', payload())).status).toBe(401);
  });
  test('basic members have no implicit ingest privilege, even with a valid session', async () => {
    expect(
      (await post('/webhook', payload(), { cookie: cookie('basic') })).status,
    ).toBe(403);
    expect(
      (
        await app.request('/api/incident-alerts', {
          headers: { cookie: cookie('basic') },
        })
      ).status,
    ).toBe(403);
  });
  test('credential issuance/revocation requires admin cookie; bearer never gains management access', async () => {
    const body = {
      owner_user_id: 'member',
      source: 'demo',
      scopes: [{ service: 'orders', environment: 'local' }],
      expires_at: new Date(Date.now() + 86400000).toISOString(),
    };
    expect(
      (await post('/credentials', body, { cookie: cookie('member') })).status,
    ).toBe(403);
    expect(
      (await post('/credentials', { ...body, owner_user_id: 'basic' })).status,
    ).toBe(400);
    const result = await post('/credentials', body);
    expect(result.status).toBe(201);
    const issued = await result.json();
    const machine = { authorization: `Bearer ${issued.token}` };
    expect((await post('/webhook', payload(), machine)).status).toBe(201);
    expect((await post('/credentials', body, machine)).status).toBe(403);
    const adminMachine = { authorization: `Bearer ${token('admin').token}` };
    expect((await post('/credentials', body, adminMachine)).status).toBe(403);
    expect(
      (await app.request('/api/admin/check', { headers: adminMachine })).status,
    ).toBe(401);
    expect(
      (await post(`/credentials/${issued.id}/revoke`, {}, machine)).status,
    ).toBe(403);
    expect((await post(`/credentials/${issued.id}/revoke`, {})).status).toBe(
      200,
    );
    expect((await post('/webhook', payload(), machine)).status).toBe(401);
  });
  test.each([
    'disabled',
    'deleted',
    'permission-removed',
    'password-change',
  ] as const)('bearer rechecks current owner: %s', async (change) => {
    const c = token();
    const u = users.get('member')!;
    if (change === 'permission-removed') u.permissions = [];
    else if (change === 'password-change') u.must_change_password = true;
    else u.status = change;
    expect(
      (
        await post('/webhook', payload(), {
          authorization: `Bearer ${c.token}`,
        })
      ).status,
    ).toBe(403);
  });
  test('expired and malformed bearer cannot fall back to a valid admin cookie', async () => {
    const c = token();
    db.prepare('UPDATE incident_ingest_credentials SET expires_at=?').run(
      '2000-01-01T00:00:00Z',
    );
    expect(
      (
        await post('/webhook', payload(), {
          authorization: `Bearer ${c.token}`,
          cookie: cookie('admin'),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await post('/webhook', payload(), {
          authorization: 'Bearer invalid',
          cookie: cookie('admin'),
        })
      ).status,
    ).toBe(401);
  });
  test('exact scope applies to ingest and detail query; member cookie shares its granted scope', async () => {
    const c = token();
    const machine = { authorization: `Bearer ${c.token}` };
    for (const change of [
      { environment: 'prod' },
      { service: 'other' },
      { source: 'other' },
    ])
      expect(
        (await post('/webhook', { ...payload(), ...change }, machine)).status,
      ).toBe(403);
    await post('/webhook', payload(), machine);
    const privateIncident = (
      await (
        await post('/webhook', { ...payload(), environment: 'prod' })
      ).json()
    ).items[0].incident_id;
    const list = await (
      await app.request('/api/incident-alerts', { headers: machine })
    ).json();
    expect(list.alerts).toHaveLength(1);
    expect(
      (
        await app.request(`/api/incident-alerts/incidents/${privateIncident}`, {
          headers: machine,
        })
      ).status,
    ).toBe(404);
    const memberList = await (
      await app.request('/api/incident-alerts', {
        headers: { cookie: cookie('member') },
      })
    ).json();
    expect(memberList.alerts).toHaveLength(1);
  });
  test('body, malformed JSON, idempotency conflict, query and live ID validation return bounded errors', async () => {
    expect(
      (
        await app.request('/api/incident-alerts/webhook', {
          method: 'POST',
          headers: {
            cookie: cookie('admin'),
            'content-type': 'application/json',
          },
          body: '{bad',
        })
      ).status,
    ).toBe(400);
    expect(
      (await post('/webhook', { ...payload(), summary: 'x'.repeat(300000) }))
        .status,
    ).toBe(413);
    expect(
      (
        await post('/webhook', payload(), undefined, {
          'idempotency-key': 'bad space',
        })
      ).status,
    ).toBe(400);
    const b = payload();
    await post('/webhook', b, undefined, { 'idempotency-key': 'fixed' });
    expect(
      (
        await post('/webhook', { ...b, severity: 'warning' }, undefined, {
          'idempotency-key': 'fixed',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.request('/api/incident-alerts?limit=101', {
          headers: { cookie: cookie('admin') },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request('/api/incident-alerts/incidents/INC-001', {
          headers: { cookie: cookie('admin') },
        })
      ).status,
    ).toBe(400);
    const response = await app.request('/api/incident-alerts', {
      headers: { cookie: cookie('admin') },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  test('a disallowed member in an Alertmanager batch rejects the whole delivery', async () => {
    const c = token('member', 'alertmanager');
    const b = payload();
    const item = {
      status: 'firing',
      labels: { service: 'orders', environment: 'local', severity: 'critical' },
      annotations: { summary: b.summary },
      startsAt: b.starts_at,
      fingerprint: 'pool',
    };
    const body = {
      version: '4',
      receiver: 'local',
      status: 'firing',
      groupKey: 'pool',
      alerts: [
        item,
        { ...item, labels: { ...item.labels, environment: 'prod' } },
      ],
    };
    expect(
      (
        await post('/alertmanager', body, {
          authorization: `Bearer ${c.token}`,
        })
      ).status,
    ).toBe(403);
    expect(
      store.listAlerts({ all: true, grants: [] }, { limit: 100, offset: 0 }),
    ).toEqual([]);
    body.alerts = [item];
    expect(
      (
        await post('/alertmanager', body, {
          authorization: `Bearer ${c.token}`,
        })
      ).status,
    ).toBe(201);
  });
  test('storage failure exposes no token or SQL exception', async () => {
    db.close();
    const response = await post('/webhook', payload());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'alert_store_unavailable' });
  });
});
