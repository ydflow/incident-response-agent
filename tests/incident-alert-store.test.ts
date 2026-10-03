import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createIncidentSchema, IncidentStore } from '../src/incident-store.js';
import { normalizeAlerts, sourceScope } from '../src/incident-alert-types.js';

const all = { all: true, grants: [] };
const now = Date.now();
const base = {
  source: 'demo',
  external_id: 'pool-1',
  service: 'orders',
  environment: 'local',
  severity: 'critical',
  alert_type: 'PROBLEM',
  fingerprint: 'pool',
  starts_at: new Date(now - 10000).toISOString(),
  status: 'firing',
  summary: 'Connection pool exhausted',
};
let db: Database.Database;
let store: IncidentStore;
let dir: string;
let filename: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'incident-alert-store-'));
  filename = path.join(dir, 'alerts.db');
  db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(
    "CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES ('owner');",
  );
  createIncidentSchema(db);
  store = new IncidentStore(db);
});
afterEach(() => {
  if (db.open) db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
function send(change: Record<string, unknown> = {}, key?: string) {
  return store.ingest(
    'owner',
    all,
    'webhook',
    normalizeAlerts('webhook', { ...base, ...change }, now).alerts,
    0,
    key,
    now,
  );
}
const incident = (result: ReturnType<typeof send>) =>
  result.items[0].incident_id;
const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

describe('independent delivery identity and bounded fault episodes', () => {
  test('same delivery retries return same receipt, leave counters unchanged and persist across reopening', () => {
    const first = send({}, 'retry-1');
    expect(send({}, 'retry-1')).toEqual({ ...first, duplicate: true });
    db.close();
    db = new Database(filename);
    store = new IncidentStore(db);
    expect(send({}, 'retry-1')).toEqual({ ...first, duplicate: true });
    expect(count('incident_alert_deliveries')).toBe(1);
    expect(store.getIncident(all, incident(first))?.metadata).toMatchObject({
      alert_count: 1,
      delivery_count: 1,
      status: 'RECEIVED',
    });
  });
  test('content deduplication works without a caller-supplied key', () => {
    const first = send();
    expect(send()).toMatchObject({
      delivery_id: first.delivery_id,
      duplicate: true,
    });
  });
  test('a fresh process can query persisted records after writer shutdown', async () => {
    const first = send();
    db.close();
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--import',
        'tsx',
        path.resolve('tests/helpers/incident-alert-worker.ts'),
        filename,
        '--read',
      ],
      { timeout: 20000 },
    );
    expect(JSON.parse(result.stdout)).toMatchObject([
      {
        incident_id: incident(first),
        status: 'RECEIVED',
        alert_count: 1,
        delivery_count: 1,
      },
    ]);
  });
  test('same explicit key with changed body conflicts and rolls back', () => {
    send({}, 'same');
    expect(() => send({ severity: 'warning' }, 'same')).toThrow(
      'idempotency_conflict',
    );
    expect(count('incident_alert_deliveries')).toBe(1);
    expect(store.listAlerts(all, { limit: 100, offset: 0 })[0].severity).toBe(
      'P1',
    );
  });
  test('new delivery keys do not create a second occurrence; distinct alerts aggregate', () => {
    const first = send({}, 'a');
    expect(incident(send({}, 'b'))).toBe(incident(first));
    expect(
      incident(send({ external_id: 'pool-2', severity: 'unknown-ext' })),
    ).toBe(incident(first));
    expect(store.getIncident(all, incident(first))?.metadata).toMatchObject({
      alert_count: 2,
      delivery_count: 3,
      severity: 'P1',
      unknown_severity_count: 1,
    });
  });
  test.each([
    { environment: 'staging' },
    { service: 'payments' },
    { fingerprint: 'other' },
    { source: 'other' },
  ])('different aggregation scope stays separate: %j', (change) => {
    expect(incident(send(change))).not.toBe(incident(send()));
  });
  test('fixed half-open 15 minute window does not extend when alerts arrive', () => {
    const start = now - 20 * 60000;
    const first = send({ starts_at: new Date(start).toISOString() });
    expect(
      incident(
        send({
          external_id: 'within',
          starts_at: new Date(start + 14 * 60000).toISOString(),
        }),
      ),
    ).toBe(incident(first));
    expect(
      incident(
        send({
          external_id: 'boundary',
          starts_at: new Date(start + 15 * 60000).toISOString(),
        }),
      ),
    ).not.toBe(incident(first));
    expect(store.getIncident(all, incident(first))?.metadata.window_end).toBe(
      new Date(start + 15 * 60000).toISOString(),
    );
  });
  test('resolution closes aggregation only when all alerts recover, never resolves investigation', () => {
    const first = send();
    send({ external_id: 'pool-2' });
    send({ status: 'resolved', ends_at: new Date(now).toISOString() });
    expect(store.getIncident(all, incident(first))?.metadata).toMatchObject({
      status: 'RECEIVED',
      alert_status: 'firing',
      aggregation_closed_at: null,
    });
    send({
      external_id: 'pool-2',
      status: 'resolved',
      ends_at: new Date(now).toISOString(),
    });
    expect(store.getIncident(all, incident(first))?.metadata).toMatchObject({
      status: 'RECEIVED',
      alert_status: 'resolved',
    });
    const restart = send({
      external_id: 'new-fault',
      starts_at: new Date(now).toISOString(),
    });
    expect(incident(restart)).not.toBe(incident(first));
    const stale = send({}, 'stale-firing');
    expect(stale.items[0].applied).toBe(false);
    expect(store.getIncident(all, incident(first))?.metadata.alert_status).toBe(
      'resolved',
    );
  });
  test('late and orphan resolved alerts are visible isolated records', () => {
    const live = send();
    const orphan = send({
      external_id: 'orphan',
      status: 'resolved',
      ends_at: new Date(now).toISOString(),
    });
    expect(incident(orphan)).not.toBe(incident(live));
    expect(store.getIncident(all, incident(orphan))?.metadata).toMatchObject({
      orphan_resolution: 1,
      status: 'RECEIVED',
    });
    const late = send({
      external_id: 'old',
      starts_at: new Date(now - 7200000).toISOString(),
    });
    expect(store.getIncident(all, incident(late))?.metadata.late).toBe(1);
  });
  test('a rejected batch rolls back already inserted items', () => {
    const alerts = normalizeAlerts('webhook', base, now).alerts;
    expect(() =>
      store.ingest('owner', all, 'alertmanager', [...alerts, ...alerts], 0),
    ).toThrow('duplicate_batch_occurrence');
    expect(count('incident_live_records')).toBe(0);
    expect(count('incident_alert_occurrences')).toBe(0);
    expect(count('incident_alert_deliveries')).toBe(0);
  });
  test('Alertmanager batch order does not change delivery identity', () => {
    const first = normalizeAlerts('webhook', base, now).alerts[0];
    const second = normalizeAlerts(
      'webhook',
      { ...base, external_id: 'batch-second' },
      now,
    ).alerts[0];
    const delivery = store.ingest(
      'owner',
      all,
      'alertmanager',
      [first, second],
      3,
    );
    expect(
      store.ingest('owner', all, 'alertmanager', [second, first], 3),
    ).toEqual({ ...delivery, duplicate: true });
    expect(count('incident_alert_delivery_items')).toBe(2);
    expect(count('incident_live_records')).toBe(1);
  });
  test('two credential owners have independent delivery and aggregation namespaces', () => {
    const first = send({}, 'shared-key');
    const second = store.ingest(
      'other-owner',
      all,
      'webhook',
      normalizeAlerts('webhook', base, now).alerts,
      0,
      'shared-key',
      now,
    );
    expect(second.delivery_id).not.toBe(first.delivery_id);
    expect(incident(second)).not.toBe(incident(first));
  });
  test('query scope cannot discover another owner or environment', () => {
    const first = send();
    const other = send({ environment: 'prod' });
    const access = {
      all: false,
      grants: [
        {
          source: 'demo',
          service: 'orders',
          environment: 'local',
          source_scope: sourceScope('owner', 'demo'),
        },
      ],
    };
    expect(store.listIncidents(access, { limit: 100, offset: 0 })).toHaveLength(
      1,
    );
    expect(store.getIncident(access, incident(other))).toBeNull();
    expect(store.getIncident(access, incident(first))).not.toBeNull();
    expect(
      store.listAlerts(
        {
          all: false,
          grants: [
            { ...access.grants[0], source_scope: sourceScope('other', 'demo') },
          ],
        },
        { limit: 100, offset: 0 },
      ),
    ).toEqual([]);
  });
  test('detail remains complete for incidents outside the first page', () => {
    const first = send();
    for (let i = 0; i < 101; i++) send({ fingerprint: `other-${i}` });
    expect(store.getIncident(all, incident(first))?.metadata).toMatchObject({
      status: 'RECEIVED',
      alert_status: 'firing',
      severity: 'P1',
    });
  });
  test('credential DB contains only a hash; revoke/expiry/scopes are enforced', () => {
    const c = store.issueCredential(
      {
        owner_user_id: 'owner',
        source: 'demo',
        scopes: [{ service: 'orders', environment: 'local' }],
        expires_at: new Date(now + 86400000).toISOString(),
      },
      now,
    );
    expect(
      JSON.stringify(
        db.prepare('SELECT * FROM incident_ingest_credentials').all(),
      ),
    ).not.toContain(c.token);
    expect(store.resolveCredential(c.token, now)).not.toBeNull();
    expect(store.resolveCredential(c.token, now + 86400001)).toBeNull();
    const access = store.accessForCredential(
      store.resolveCredential(c.token, now)!,
    );
    expect(() =>
      store.ingest(
        'owner',
        access,
        'webhook',
        normalizeAlerts('webhook', { ...base, environment: 'prod' }, now)
          .alerts,
        0,
      ),
    ).toThrow('alert_scope_denied');
    expect(store.revokeCredential(c.id)).toBe(true);
    expect(store.resolveCredential(c.token, now)).toBeNull();
  });
  test('parallel independent processes cannot duplicate deliveries or fault records', async () => {
    const worker = path.resolve('tests/helpers/incident-alert-worker.ts');
    const exec = promisify(execFile);
    const invoke = (body: unknown, key: string) =>
      exec(
        process.execPath,
        ['--import', 'tsx', worker, filename, JSON.stringify(body), key],
        { timeout: 20000 },
      ).then((r) => JSON.parse(r.stdout));
    const duplicates = await Promise.all(
      Array.from({ length: 6 }, () => invoke(base, 'parallel')),
    );
    expect(new Set(duplicates.map((r) => r.delivery_id)).size).toBe(1);
    expect(duplicates.filter((r) => !r.duplicate)).toHaveLength(1);
    const distinct = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        invoke({ ...base, external_id: `parallel-${i}` }, `distinct-${i}`),
      ),
    );
    expect(new Set(distinct.map((r) => r.items[0].incident_id)).size).toBe(1);
    expect(count('incident_live_records')).toBe(1);
    expect(count('incident_alert_occurrences')).toBe(7);
    expect(count('incident_alert_deliveries')).toBe(7);
  }, 30000);
});
