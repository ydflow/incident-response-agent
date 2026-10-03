/** Incident-only storage bound to the existing host SQLite connection. No runtime. */
import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { syncInvestigationIntake } from './incident-investigation-store.js';
import {
  AGGREGATION_WINDOW_MS,
  AlertInputError,
  assertAlertScope,
  digest,
  sourceScope,
  type AlertAccess,
  type CredentialInput,
  type NormalizedAlert,
} from './incident-alert-types.js';

export function createIncidentSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS incident_ingest_credentials (
      id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE,
      owner_user_id TEXT NOT NULL REFERENCES users(id), source TEXT NOT NULL,
      scopes_json TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_incident_credential_owner ON incident_ingest_credentials(owner_user_id);
    CREATE TABLE IF NOT EXISTS incident_live_records (
      incident_id TEXT PRIMARY KEY, source_scope TEXT NOT NULL, source TEXT NOT NULL,
      service TEXT NOT NULL, environment TEXT NOT NULL, alert TEXT NOT NULL,
      started_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'RECEIVED' CHECK(status = 'RECEIVED'),
      aggregation_base TEXT NOT NULL, episode INTEGER NOT NULL, aggregation_key TEXT NOT NULL UNIQUE,
      window_end TEXT NOT NULL, aggregation_closed_at TEXT,
      first_received_at TEXT NOT NULL, last_received_at TEXT NOT NULL,
      alert_count INTEGER NOT NULL DEFAULT 0, delivery_count INTEGER NOT NULL DEFAULT 0,
      late INTEGER NOT NULL DEFAULT 0, orphan_resolution INTEGER NOT NULL DEFAULT 0,
      UNIQUE(aggregation_base, episode)
    );
    CREATE INDEX IF NOT EXISTS idx_incident_aggregation ON incident_live_records(aggregation_base, started_at, window_end);
    CREATE TABLE IF NOT EXISTS incident_alert_occurrences (
      occurrence_id TEXT PRIMARY KEY, occurrence_key TEXT NOT NULL UNIQUE,
      incident_id TEXT NOT NULL REFERENCES incident_live_records(incident_id),
      source_scope TEXT NOT NULL, source TEXT NOT NULL, external_id TEXT NOT NULL,
      service TEXT NOT NULL, environment TEXT NOT NULL,
      severity TEXT CHECK(severity IS NULL OR severity IN ('P0','P1','P2','P3')),
      severity_raw TEXT NOT NULL, severity_mapping_status TEXT NOT NULL CHECK(severity_mapping_status IN ('known','unknown')),
      alert_type TEXT NOT NULL, alert_type_raw TEXT NOT NULL, fingerprint TEXT NOT NULL,
      starts_at TEXT NOT NULL, ends_at TEXT, status TEXT NOT NULL CHECK(status IN ('firing','resolved')),
      source_summary TEXT NOT NULL, first_received_at TEXT NOT NULL, last_received_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_incident_alert_incident ON incident_alert_occurrences(incident_id, status);
    CREATE TABLE IF NOT EXISTS incident_alert_deliveries (
      delivery_id TEXT PRIMARY KEY, delivery_key TEXT NOT NULL UNIQUE,
      canonical_hash TEXT NOT NULL, kind TEXT NOT NULL, received_at TEXT NOT NULL,
      item_count INTEGER NOT NULL, truncated_alerts INTEGER NOT NULL, receipt_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incident_alert_delivery_items (
      delivery_id TEXT NOT NULL REFERENCES incident_alert_deliveries(delivery_id),
      occurrence_id TEXT NOT NULL REFERENCES incident_alert_occurrences(occurrence_id),
      PRIMARY KEY(delivery_id, occurrence_id)
    );
  `);
}
type CredentialRow = {
  id: string;
  owner_user_id: string;
  source: string;
  scopes_json: string;
  expires_at: string;
  revoked_at: string | null;
};
type OccurrenceRow = NormalizedAlert & {
  occurrence_id: string;
  incident_id: string;
  source_scope: string;
  occurrence_key: string;
  first_received_at: string;
  last_received_at: string;
};
export type LiveIncident = {
  incident_id: string;
  source_scope: string;
  source: string;
  service: string;
  environment: string;
  alert: string;
  started_at: string;
  status: 'RECEIVED';
  aggregation_key: string;
  first_received_at: string;
  last_received_at: string;
  window_end: string;
  aggregation_closed_at: string | null;
  alert_count: number;
  delivery_count: number;
  late: number;
  orphan_resolution: number;
};
export type IngestReceipt = {
  delivery_id: string;
  duplicate: boolean;
  truncated_alerts: number;
  items: Array<{
    occurrence_id: string;
    incident_id: string;
    applied: boolean;
  }>;
};
export type AlertQuery = {
  limit: number;
  offset: number;
  source?: string;
  service?: string;
  environment?: string;
};
export class IncidentStore {
  constructor(private readonly db: Database.Database) {}

  issueCredential(input: CredentialInput, now = Date.now()) {
    const expiration = Date.parse(input.expires_at);
    if (expiration <= now || expiration > now + 30 * 86400_000)
      throw new AlertInputError('invalid_credential_expiry');
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    this.db
      .prepare(
        `INSERT INTO incident_ingest_credentials
      (id,token_hash,owner_user_id,source,scopes_json,expires_at,created_at) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        digest(token),
        input.owner_user_id,
        input.source,
        JSON.stringify(input.scopes),
        new Date(expiration).toISOString(),
        new Date(now).toISOString(),
      );
    return {
      id,
      token,
      owner_user_id: input.owner_user_id,
      source: input.source,
      scopes: input.scopes,
      expires_at: new Date(expiration).toISOString(),
    };
  }
  revokeCredential(id: string): boolean {
    return (
      this.db
        .prepare(
          'UPDATE incident_ingest_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL',
        )
        .run(new Date().toISOString(), id).changes === 1
    );
  }
  resolveCredential(token: string, now = Date.now()): CredentialRow | null {
    if (!/^[0-9a-f]{64}$/.test(token)) return null;
    return (
      (this.db
        .prepare(
          `SELECT id,owner_user_id,source,scopes_json,expires_at,revoked_at FROM incident_ingest_credentials
      WHERE token_hash=? AND revoked_at IS NULL AND expires_at>?`,
        )
        .get(digest(token), new Date(now).toISOString()) as
        | CredentialRow
        | undefined) ?? null
    );
  }
  accessForCredential(row: CredentialRow): AlertAccess {
    const pairs = JSON.parse(row.scopes_json) as Array<{
      service: string;
      environment: string;
    }>;
    return {
      all: false,
      grants: pairs.map((pair) => ({
        ...pair,
        source: row.source,
        source_scope: sourceScope(row.owner_user_id, row.source),
      })),
    };
  }
  accessForUser(owner: string, admin: boolean, now = Date.now()): AlertAccess {
    if (admin) return { all: true, grants: [] };
    const rows = this.db
      .prepare(
        `SELECT owner_user_id,source,scopes_json FROM incident_ingest_credentials
      WHERE owner_user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC`,
      )
      .all(owner, new Date(now).toISOString()) as CredentialRow[];
    return {
      all: false,
      grants: rows.flatMap((row) => this.accessForCredential(row).grants),
    };
  }
  ingest(
    owner: string,
    access: AlertAccess,
    kind: 'webhook' | 'alertmanager',
    alerts: NormalizedAlert[],
    truncated: number,
    idempotencyKey?: string,
    now = Date.now(),
  ): IngestReceipt {
    alerts.forEach((alert) => assertAlertScope(alert, access));
    if (
      idempotencyKey !== undefined &&
      !/^[A-Za-z0-9._:-]{1,128}$/.test(idempotencyKey)
    )
      throw new AlertInputError('invalid_idempotency_key');
    const scoped = alerts.map((alert) => ({
      alert,
      scope: sourceScope(owner, alert.source),
    }));
    // Canonical batch order is stable across Alertmanager retries/reordering.
    scoped.sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b), 'en'),
    );
    const canonicalHash = digest(JSON.stringify({ kind, scoped, truncated }));
    const namespaces = [...new Set(scoped.map((item) => item.scope))].sort();
    const deliveryKey = digest(
      JSON.stringify([
        namespaces,
        kind,
        idempotencyKey
          ? ['explicit', idempotencyKey]
          : ['content', canonicalHash],
      ]),
    );
    return this.db
      .transaction(() => {
        const existing = this.db
          .prepare(
            'SELECT canonical_hash,receipt_json FROM incident_alert_deliveries WHERE delivery_key=?',
          )
          .get(deliveryKey) as
          | { canonical_hash: string; receipt_json: string }
          | undefined;
        if (existing) {
          if (existing.canonical_hash !== canonicalHash)
            throw new AlertInputError('idempotency_conflict', 409);
          return {
            ...(JSON.parse(existing.receipt_json) as IngestReceipt),
            duplicate: true,
          };
        }
        const received = new Date(now).toISOString();
        const items: IngestReceipt['items'] = [];
        const seen = new Set<string>();
        const incidents = new Set<string>();
        for (const { alert, scope } of scoped) {
          const occurrenceKey = digest(
            JSON.stringify([
              scope,
              alert.service,
              alert.environment,
              alert.fingerprint,
              alert.starts_at,
              alert.external_id,
            ]),
          );
          if (seen.has(occurrenceKey))
            throw new AlertInputError('duplicate_batch_occurrence');
          seen.add(occurrenceKey);
          const existingAlert = this.db
            .prepare(
              'SELECT * FROM incident_alert_occurrences WHERE occurrence_key=?',
            )
            .get(occurrenceKey) as OccurrenceRow | undefined;
          let incidentId = existingAlert?.incident_id;
          let occurrenceId = existingAlert?.occurrence_id;
          const applied = !(
            existingAlert?.status === 'resolved' && alert.status === 'firing'
          );
          if (!existingAlert) {
            const base = digest(
              JSON.stringify([
                scope,
                alert.service,
                alert.environment,
                alert.fingerprint,
              ]),
            );
            const late = Date.parse(alert.starts_at) < now - 3600_000;
            const candidate =
              alert.status === 'firing' && !late
                ? (this.db
                    .prepare(
                      `SELECT incident_id FROM incident_live_records
            WHERE aggregation_base=? AND aggregation_closed_at IS NULL AND late=0
            AND started_at<=? AND window_end>? ORDER BY started_at DESC LIMIT 1`,
                    )
                    .get(base, alert.starts_at, alert.starts_at) as
                    | { incident_id: string }
                    | undefined)
                : undefined;
            incidentId = candidate?.incident_id;
            if (!incidentId) {
              // Fixed episode end; future occurrences cannot extend it indefinitely.
              this.db
                .prepare(
                  `UPDATE incident_live_records SET aggregation_closed_at=window_end
              WHERE aggregation_base=? AND aggregation_closed_at IS NULL AND window_end<=?`,
                )
                .run(base, alert.starts_at);
              const { episode } = this.db
                .prepare(
                  'SELECT COALESCE(MAX(episode),0)+1 AS episode FROM incident_live_records WHERE aggregation_base=?',
                )
                .get(base) as { episode: number };
              incidentId = `LIVE-${randomUUID()}`;
              const windowEnd = new Date(
                Date.parse(alert.starts_at) + AGGREGATION_WINDOW_MS,
              ).toISOString();
              this.db
                .prepare(
                  `INSERT INTO incident_live_records
              (incident_id,source_scope,source,service,environment,alert,started_at,aggregation_base,episode,aggregation_key,window_end,aggregation_closed_at,first_received_at,last_received_at,late,orphan_resolution)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
                )
                .run(
                  incidentId,
                  scope,
                  alert.source,
                  alert.service,
                  alert.environment,
                  alert.source_summary.summary,
                  alert.starts_at,
                  base,
                  episode,
                  `${base}:${episode}`,
                  windowEnd,
                  alert.status === 'resolved' ? alert.ends_at : null,
                  received,
                  received,
                  Number(late),
                  Number(alert.status === 'resolved'),
                );
            }
            occurrenceId = randomUUID();
            this.db
              .prepare(
                `INSERT INTO incident_alert_occurrences
            (occurrence_id,occurrence_key,incident_id,source_scope,source,external_id,service,environment,severity,severity_raw,severity_mapping_status,alert_type,alert_type_raw,fingerprint,starts_at,ends_at,status,source_summary,first_received_at,last_received_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              )
              .run(
                occurrenceId,
                occurrenceKey,
                incidentId,
                scope,
                alert.source,
                alert.external_id,
                alert.service,
                alert.environment,
                alert.severity,
                alert.severity_raw,
                alert.severity_mapping_status,
                alert.alert_type,
                alert.alert_type_raw,
                alert.fingerprint,
                alert.starts_at,
                alert.ends_at,
                alert.status,
                JSON.stringify(alert.source_summary),
                received,
                received,
              );
            this.db
              .prepare(
                'UPDATE incident_live_records SET alert_count=alert_count+1 WHERE incident_id=?',
              )
              .run(incidentId);
          } else if (applied) {
            this.db
              .prepare(
                `UPDATE incident_alert_occurrences SET severity=?,severity_raw=?,severity_mapping_status=?,alert_type=?,alert_type_raw=?,ends_at=?,status=?,source_summary=?,last_received_at=? WHERE occurrence_id=?`,
              )
              .run(
                alert.severity,
                alert.severity_raw,
                alert.severity_mapping_status,
                alert.alert_type,
                alert.alert_type_raw,
                alert.ends_at,
                alert.status,
                JSON.stringify(alert.source_summary),
                received,
                occurrenceId,
              );
          }
          if (!incidentId || !occurrenceId)
            throw new Error('invalid_incident_storage');
          if (alert.status === 'resolved' && applied) {
            this.db
              .prepare(
                `UPDATE incident_live_records SET aggregation_closed_at=COALESCE(aggregation_closed_at,?)
            WHERE incident_id=? AND NOT EXISTS(SELECT 1 FROM incident_alert_occurrences WHERE incident_id=? AND status='firing')`,
              )
              .run(alert.ends_at, incidentId, incidentId);
          }
          incidents.add(incidentId);
          items.push({
            occurrence_id: occurrenceId,
            incident_id: incidentId,
            applied,
          });
        }
        const receipt: IngestReceipt = {
          delivery_id: randomUUID(),
          duplicate: false,
          truncated_alerts: truncated,
          items,
        };
        this.db
          .prepare(
            `INSERT INTO incident_alert_deliveries (delivery_id,delivery_key,canonical_hash,kind,received_at,item_count,truncated_alerts,receipt_json) VALUES (?,?,?,?,?,?,?,?)`,
          )
          .run(
            receipt.delivery_id,
            deliveryKey,
            canonicalHash,
            kind,
            received,
            alerts.length,
            truncated,
            JSON.stringify(receipt),
          );
        for (const item of items)
          this.db
            .prepare(
              'INSERT INTO incident_alert_delivery_items (delivery_id,occurrence_id) VALUES (?,?)',
            )
            .run(receipt.delivery_id, item.occurrence_id);
        for (const id of incidents)
          this.db
            .prepare(
              'UPDATE incident_live_records SET delivery_count=delivery_count+1,last_received_at=? WHERE incident_id=?',
            )
            .run(received, id);
        syncInvestigationIntake(this.db, [...incidents], now);
        return receipt;
      })
      .immediate();
  }
  private accessSql(access: AlertAccess, alias: string) {
    return access.all
      ? { sql: '', values: [] as string[] }
      : {
          sql: ` AND EXISTS (SELECT 1 FROM json_each(?) grant WHERE json_extract(grant.value,'$.source_scope')=${alias}.source_scope
        AND json_extract(grant.value,'$.service')=${alias}.service AND json_extract(grant.value,'$.environment')=${alias}.environment)`,
          values: [JSON.stringify(access.grants)],
        };
  }
  private querySql(access: AlertAccess, query: AlertQuery, alias: string) {
    const { sql, values } = this.accessSql(access, alias);
    let filters = sql;
    for (const key of ['source', 'service', 'environment'] as const) {
      if (query[key]) {
        filters += ` AND ${alias}.${key}=?`;
        values.push(query[key]!);
      }
    }
    return { sql: filters, values };
  }
  listAlerts(access: AlertAccess, query: AlertQuery) {
    const { sql, values } = this.querySql(access, query, 'a');
    const rows = this.db
      .prepare(
        `SELECT a.* FROM incident_alert_occurrences a WHERE 1=1 ${sql} ORDER BY last_received_at DESC,occurrence_id LIMIT ? OFFSET ?`,
      )
      .all(...values, query.limit, query.offset) as Array<
      Omit<OccurrenceRow, 'source_summary'> & { source_summary: string }
    >;
    return rows.map(
      ({ source_scope: _scope, occurrence_key: _key, ...row }) => ({
        ...row,
        source_summary: JSON.parse(
          row.source_summary,
        ) as NormalizedAlert['source_summary'],
      }),
    );
  }
  listIncidents(access: AlertAccess, query: AlertQuery) {
    return this.readIncidents(access, query);
  }
  private readIncidents(access: AlertAccess, query: AlertQuery, id?: string) {
    const { sql, values } = this.querySql(access, query, 'i');
    if (id) values.push(id);
    const rows = this.db
      .prepare(
        `SELECT i.*, (SELECT COUNT(*) FROM incident_alert_occurrences a WHERE a.incident_id=i.incident_id AND a.status='firing') AS firing_count,
      (SELECT COUNT(*) FROM incident_alert_occurrences a WHERE a.incident_id=i.incident_id AND a.severity_mapping_status='unknown') AS unknown_severity_count,
      (SELECT MIN(severity) FROM incident_alert_occurrences a WHERE a.incident_id=i.incident_id) AS severity
      FROM incident_live_records i WHERE 1=1 ${sql} ${id ? 'AND i.incident_id=?' : ''} ORDER BY last_received_at DESC,incident_id LIMIT ? OFFSET ?`,
      )
      .all(...values, query.limit, query.offset) as Array<
      LiveIncident & {
        firing_count: number;
        unknown_severity_count: number;
        severity: NormalizedAlert['severity'];
        aggregation_base: string;
        episode: number;
      }
    >;
    return rows.map(
      ({ source_scope: _scope, aggregation_base: _base, ...row }) => ({
        ...row,
        alert_status: row.firing_count ? 'firing' : 'resolved',
        source_mode: 'alert_ingest' as const,
      }),
    );
  }
  getIncident(access: AlertAccess, id: string) {
    const record = this.readIncidents(access, { limit: 1, offset: 0 }, id)[0];
    if (!record) return null;
    const alerts = this.db
      .prepare(
        'SELECT * FROM incident_alert_occurrences WHERE incident_id=? ORDER BY starts_at,occurrence_id LIMIT 100',
      )
      .all(id) as Array<
      Omit<OccurrenceRow, 'source_summary'> & { source_summary: string }
    >;
    return {
      incident: {
        incident_id: record.incident_id,
        service: record.service,
        alert: record.alert,
        started_at: record.started_at,
      },
      metadata: record,
      alerts: alerts.map(
        ({ source_scope: _s, occurrence_key: _k, ...row }) => ({
          ...row,
          source_summary: JSON.parse(row.source_summary),
        }),
      ),
      alerts_truncated: record.alert_count > 100,
    };
  }
}
let boundStore: IncidentStore | null = null;
export function bindIncidentDatabase(db: Database.Database | null): void {
  boundStore = db ? new IncidentStore(db) : null;
}
export function getIncidentStore(): IncidentStore {
  if (!boundStore) throw new Error('incident_store_unavailable');
  return boundStore;
}
