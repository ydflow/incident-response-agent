import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, test, vi } from 'vitest';
import { INVESTIGATION_TABLES } from '../src/incident-investigation-store.js';
import { normalizeAlerts } from '../src/incident-alert-types.js';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v70-alerts-'));
const storeDir = path.join(tmp, 'db');
const groupsDir = path.join(tmp, 'groups');
const filename = path.join(storeDir, 'messages.db');
const backups = path.join(tmp, 'migration-backups');
vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const host = await import('../src/db.js');
const { getIncidentStore } = await import('../src/incident-store.js');
afterAll(() => {
  host.closeDatabase();
  delete process.env.MINICLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('v70 → v71 preserves every existing alert row and table definition, backs up before adding jobs', () => {
  host.initDatabase();
  const now = Date.now(),
    receipt = getIncidentStore().ingest(
      'legacy',
      { all: true, grants: [] },
      'webhook',
      normalizeAlerts(
        'webhook',
        {
          source: 'migration-demo',
          service: 'orders',
          environment: 'local',
          severity: 'critical',
          starts_at: new Date(now - 1000).toISOString(),
          status: 'firing',
          summary: 'Connection pool timeout',
        },
        now,
      ).alerts,
      0,
      'preserve-v70',
      now,
    );
  host.closeDatabase();
  const original = new Database(filename);
  for (const table of INVESTIGATION_TABLES)
    original.exec(`DROP TABLE ${table}`);
  original
    .prepare("UPDATE router_state SET value='70' WHERE key='schema_version'")
    .run();
  const oldTables = original
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all();
  const tableNames = [
    'incident_ingest_credentials',
    'incident_live_records',
    'incident_alert_occurrences',
    'incident_alert_deliveries',
    'incident_alert_delivery_items',
  ];
  const oldRows = tableNames.map((t) =>
    original.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
  );
  original.close();
  const backupDir = path.join(tmp, 'v71-backups');
  process.env.MINICLAW_MIGRATION_BACKUP_DIR = backupDir;
  host.initDatabase();
  expect(host.getRouterState('schema_version')).toBe('71');
  expect(
    getIncidentStore().getIncident(
      { all: true, grants: [] },
      receipt.items[0].incident_id,
    )?.metadata.status,
  ).toBe('RECEIVED');
  host.closeDatabase();
  const probe = new Database(filename);
  expect(
    probe
      .prepare(
        `SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT IN (${INVESTIGATION_TABLES.map(() => '?').join(',')}) ORDER BY name`,
      )
      .all(...INVESTIGATION_TABLES),
  ).toEqual(oldTables);
  expect(
    tableNames.map((t) =>
      probe.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
    ),
  ).toEqual(oldRows);
  expect(probe.pragma('foreign_key_check')).toEqual([]);
  probe.close();
  const backups71 = fs.readdirSync(backupDir);
  expect(backups71).toHaveLength(1);
  const backup = new Database(path.join(backupDir, backups71[0]), {
    readonly: true,
  });
  expect(
    backup
      .prepare("SELECT value FROM router_state WHERE key='schema_version'")
      .get(),
  ).toEqual({ value: '70' });
  expect(
    backup
      .prepare(
        "SELECT COUNT(*) n FROM sqlite_master WHERE name='incident_investigation_jobs'",
      )
      .get(),
  ).toEqual({ n: 0 });
  backup.close();
});
test('v69 → current backs up and preserves users, sessions and unrelated data while retaining v70 constrained alert tables', () => {
  host.initDatabase();
  const date = new Date().toISOString();
  host.createUser({
    id: 'legacy',
    username: 'legacy',
    password_hash: 'test-only',
    display_name: 'Legacy',
    role: 'admin',
    status: 'active',
    created_at: date,
    updated_at: date,
  });
  host.createUserSession({
    id: 'test-session',
    user_id: 'legacy',
    ip_address: null,
    user_agent: null,
    created_at: date,
    expires_at: new Date(Date.now() + 86400000).toISOString(),
    last_active_at: date,
  });
  host.setRouterState('unrelated-marker', 'preserve');
  host.closeDatabase();
  // Reconstruct v69: host schema is unchanged by this additive migration.
  const legacy = new Database(filename);
  for (const table of INVESTIGATION_TABLES) legacy.exec(`DROP TABLE ${table}`);
  legacy.exec(`DROP TABLE incident_alert_delivery_items; DROP TABLE incident_alert_deliveries;
    DROP TABLE incident_alert_occurrences; DROP TABLE incident_live_records; DROP TABLE incident_ingest_credentials;
    UPDATE router_state SET value='69' WHERE key='schema_version';`);
  const oldTables = legacy
    .prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all();
  legacy.close();
  process.env.MINICLAW_MIGRATION_BACKUP_DIR = backups;
  host.initDatabase();
  expect(host.getRouterState('schema_version')).toBe('71');
  expect(host.getRouterState('unrelated-marker')).toBe('preserve');
  expect(host.getUserById('legacy')?.display_name).toBe('Legacy');
  expect(host.getSessionWithUser('test-session')?.user_id).toBe('legacy');
  expect(
    getIncidentStore().listAlerts(
      { all: true, grants: [] },
      { limit: 100, offset: 0 },
    ),
  ).toEqual([]);
  host.closeDatabase();
  const probe = new Database(filename);
  probe.pragma('foreign_keys=ON');
  expect(
    probe
      .prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'incident_%' ORDER BY name",
      )
      .all(),
  ).toEqual(oldTables);
  expect(
    probe
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name LIKE 'incident_%'",
      )
      .get(),
  ).toEqual({ n: 5 + INVESTIGATION_TABLES.length });
  expect(probe.pragma('foreign_key_check')).toEqual([]);
  expect(() =>
    probe
      .prepare(
        "INSERT INTO incident_ingest_credentials VALUES ('c','hash','missing','demo','[]','2099',NULL,'2026')",
      )
      .run(),
  ).toThrow(/FOREIGN KEY/);
  probe.close();
  const names = fs.readdirSync(backups);
  expect(names).toHaveLength(1);
  const backup = new Database(path.join(backups, names[0]), { readonly: true });
  expect(
    backup
      .prepare("SELECT value FROM router_state WHERE key='schema_version'")
      .get(),
  ).toEqual({ value: '69' });
  expect(
    backup
      .prepare(
        "SELECT COUNT(*) AS n FROM sqlite_master WHERE name='incident_alert_occurrences'",
      )
      .get(),
  ).toEqual({ n: 0 });
  backup.close();
  host.initDatabase();
  host.closeDatabase();
  expect(fs.readdirSync(backups)).toHaveLength(1);
});
