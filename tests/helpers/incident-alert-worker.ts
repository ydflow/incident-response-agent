// Independent process/connection for SQLite concurrency acceptance.
import Database from 'better-sqlite3';
import { IncidentStore } from '../../src/incident-store.js';
import { normalizeAlerts } from '../../src/incident-alert-types.js';
const db = new Database(process.argv[2]);
db.pragma('busy_timeout = 10000');
db.pragma('foreign_keys = ON');
try {
  if (process.argv[3] === '--read') {
    process.stdout.write(
      JSON.stringify(
        new IncidentStore(db).listIncidents(
          { all: true, grants: [] },
          { limit: 100, offset: 0 },
        ),
      ),
    );
  } else {
    const input = JSON.parse(process.argv[3]);
    const normalized = normalizeAlerts('webhook', input);
    const receipt = new IncidentStore(db).ingest(
      'owner',
      { all: true, grants: [] },
      'webhook',
      normalized.alerts,
      0,
      process.argv[4],
    );
    process.stdout.write(JSON.stringify(receipt));
  }
} finally {
  db.close();
}
