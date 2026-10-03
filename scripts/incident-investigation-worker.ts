/** Bounded standalone host Worker for an explicitly selected independent local demo DB. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { InvestigationStore } from '../src/incident-investigation-store.js';
import { IncidentInvestigationWorker } from '../src/incident-investigation-worker.js';
import { resolveConfiguredIncidentModel } from '../src/incident-configured-model.js';
import { safeId, liveId } from '../src/incident-investigation-types.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const sourceSchema = z
  .array(
    z.strictObject({
      source_scope: z.string().regex(/^[a-f0-9]{64}$/),
      source_id: safeId,
      service: safeId,
      environment: z.literal('local'),
      base_url: z
        .string()
        .url()
        .refine((value) => {
          const u = new URL(value);
          return (
            u.protocol === 'http:' &&
            u.hostname === '127.0.0.1' &&
            !u.username &&
            !u.password &&
            !u.search &&
            !u.hash &&
            u.pathname === '/'
          );
        }),
      read_token: z.string().regex(/^[a-f0-9]{64}$/),
      instance_id: z.uuid(),
    }),
  )
  .max(8);
let db: Database.Database | undefined;
try {
  const filename = arg('--db'),
    configFile = arg('--source-config'),
    ticks = Number(arg('--ticks') ?? 1),
    modelLimit = Number(arg('--max-model-requests') ?? 3),
    incident = arg('--incident-id');
  if (
    !filename ||
    !configFile ||
    !Number.isInteger(ticks) ||
    ticks < 1 ||
    ticks > 10 ||
    !Number.isInteger(modelLimit) ||
    modelLimit < 1 ||
    modelLimit > 3 ||
    (incident !== undefined && !liveId.safeParse(incident).success)
  )
    throw Error(
      'usage: --db independent.db --source-config private.json [--ticks 1..10] [--configured-model]',
    );
  const resolved = fs.realpathSync(filename),
    data = path.join(root, 'data');
  if (resolved.toLowerCase().startsWith(data.toLowerCase() + path.sep))
    throw Error('personal_runtime_database_not_authorized');
  for (const file of [filename, configFile]) {
    const s = fs.lstatSync(file);
    if (
      !s.isFile() ||
      s.isSymbolicLink() ||
      (file === configFile && s.size > 65536)
    )
      throw Error('invalid_host_file');
  }
  const sources = sourceSchema.parse(
    JSON.parse(fs.readFileSync(configFile, 'utf8')),
  );
  db = new Database(resolved, { fileMustExist: true });
  db.pragma('foreign_keys=ON');
  const store = new InvestigationStore(db);
  const schema = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE name='incident_investigation_jobs'",
    )
    .get();
  if (!schema) throw Error('investigation_schema_missing');
  const model = args.includes('--configured-model')
    ? resolveConfiguredIncidentModel()
    : { config: null, reason: 'model_not_requested' };
  console.log(
    JSON.stringify({
      model_configuration: model.reason,
      ticks,
      production_connected: false,
    }),
  );
  store.scanPending();
  const worker = new IncidentInvestigationWorker(store, {
    repo_root: root,
    sources,
    model: model.config,
    max_model_requests: modelLimit,
    incident_id: incident,
    wall_ms: 60000,
  });
  for (let i = 0; i < ticks; i++) {
    const result = await worker.tick();
    console.log(JSON.stringify(result ?? { state: 'idle' }));
    if (!result) break;
  }
} catch {
  console.error(
    'Incident Worker failed: invalid host inputs, schema or bounded execution. No credentials are printed.',
  );
  process.exitCode = 1;
} finally {
  db?.close();
}
