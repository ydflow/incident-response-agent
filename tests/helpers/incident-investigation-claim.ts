import Database from 'better-sqlite3';
import { InvestigationStore } from '../../src/incident-investigation-store.js';
const db = new Database(process.argv[2]);
db.pragma('foreign_keys=ON');
try {
  console.log(
    JSON.stringify(new InvestigationStore(db).claim(process.argv[3])),
  );
} finally {
  db.close();
}
