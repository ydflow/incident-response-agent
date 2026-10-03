import Database from 'better-sqlite3';
import {
  createIncidentSchema,
  IncidentStore,
} from '../../src/incident-store.js';
import {
  createInvestigationSchema,
  InvestigationStore,
} from '../../src/incident-investigation-store.js';
import { normalizeAlerts } from '../../src/incident-alert-types.js';
export function investigationDb(filename = ':memory:') {
  const db = new Database(filename);
  db.pragma('journal_mode=WAL');
  db.pragma('foreign_keys=ON');
  db.exec(
    "CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY); INSERT OR IGNORE INTO users VALUES('owner');",
  );
  createIncidentSchema(db);
  createInvestigationSchema(db);
  const alerts = new IncidentStore(db),
    store = new InvestigationStore(db);
  const send = (
    changes: Record<string, unknown> = {},
    key?: string,
    now = Date.now(),
  ) =>
    alerts.ingest(
      'owner',
      { all: true, grants: [] },
      'webhook',
      normalizeAlerts(
        'webhook',
        {
          source: 'step5-demo',
          external_id: 'pool-1',
          service: 'orders',
          environment: 'local',
          severity: 'critical',
          fingerprint: 'pool',
          starts_at: new Date(now - 10000).toISOString(),
          status: 'firing',
          summary: 'Connection pool exhausted pool_waiting acquire timeout',
          ...changes,
        },
        now,
      ).alerts,
      0,
      key,
      now,
    );
  return { db, alerts, store, send };
}
