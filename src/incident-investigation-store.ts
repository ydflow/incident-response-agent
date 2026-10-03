/** The existing host SQLite connection is the only authority for jobs and runs. */
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { sanitizeAlertText } from './incident-alert-types.js';
import {
  boundedJson,
  evidenceSchema,
  eventSchema,
  fail,
  knowledgeSchema,
  liveId,
  safeId,
  toolNames,
  reportCore,
  validateReport,
  type Lease,
  type JobState,
  type InvestigationEvent,
  type InvestigationEvidence,
  type StoredKnowledge,
} from './incident-investigation-types.js';

export const INVESTIGATION_TABLES = [
  'incident_investigation_model_requests',
  'incident_investigation_approvals',
  'incident_investigation_knowledge',
  'incident_runbook_chunks',
  'incident_investigation_evidence',
  'incident_investigation_events',
  'incident_investigation_runs',
  'incident_investigation_jobs',
] as const;
export function createInvestigationSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS incident_investigation_jobs (
      job_id TEXT PRIMARY KEY,incident_id TEXT NOT NULL REFERENCES incident_live_records(incident_id),
      generation INTEGER NOT NULL CHECK(generation>0),idempotency_key TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK(state IN('queued','running','retry_wait','blocked','completed','manual','failed')),
      attempt INTEGER NOT NULL DEFAULT 0 CHECK(attempt BETWEEN 0 AND 2),next_at INTEGER NOT NULL,
      lease_owner TEXT,lease_token INTEGER NOT NULL DEFAULT 0,lease_expires_at INTEGER,
      run_id TEXT,input_revision INTEGER NOT NULL,pending_revision INTEGER NOT NULL,
      snapshot_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,error_code TEXT,
      model_requests INTEGER NOT NULL DEFAULT 0,tool_calls INTEGER NOT NULL DEFAULT 0,search_calls INTEGER NOT NULL DEFAULT 0,
      UNIQUE(incident_id,generation)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_incident_active_job ON incident_investigation_jobs(incident_id)
      WHERE state IN('queued','running','retry_wait');
    CREATE TABLE IF NOT EXISTS incident_investigation_runs (
      run_id TEXT PRIMARY KEY,job_id TEXT NOT NULL REFERENCES incident_investigation_jobs(job_id),
      attempt INTEGER NOT NULL,lease_token INTEGER NOT NULL,owner TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN('RECEIVED','INVESTIGATING','DIAGNOSED','AWAITING_APPROVAL','RESOLVED','ESCALATED','FAILED')),
      started_at INTEGER NOT NULL,ended_at INTEGER,deadline_at INTEGER NOT NULL,
      from_at TEXT NOT NULL,to_at TEXT NOT NULL,source_id TEXT,instance_id TEXT,
      mode TEXT NOT NULL DEFAULT 'host_no_model',report_json TEXT,error_code TEXT,notification_json TEXT,
      runtime_trace_json TEXT NOT NULL DEFAULT '[]',
      tool_reservations_json TEXT NOT NULL DEFAULT '[]',
      tool_calls INTEGER NOT NULL DEFAULT 0,search_calls INTEGER NOT NULL DEFAULT 0,model_requests INTEGER NOT NULL DEFAULT 0,
      UNIQUE(job_id,attempt)
    );
    CREATE TABLE IF NOT EXISTS incident_investigation_events (
      event_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES incident_investigation_runs(run_id),
      seq INTEGER NOT NULL,event_json TEXT NOT NULL,UNIQUE(run_id,seq)
    );
    CREATE TABLE IF NOT EXISTS incident_investigation_evidence (
      evidence_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES incident_investigation_runs(run_id),
      tool_call_id TEXT NOT NULL,source TEXT NOT NULL CHECK(source IN('logs','metrics')),evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incident_runbook_chunks (
      chunk_id TEXT PRIMARY KEY,doc_id TEXT NOT NULL,version_hash TEXT NOT NULL,chunk_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incident_investigation_knowledge (
      reference_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES incident_investigation_runs(run_id),
      chunk_id TEXT NOT NULL REFERENCES incident_runbook_chunks(chunk_id),reference_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS incident_investigation_approvals (
      approval_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES incident_investigation_runs(run_id),
      lease_token INTEGER NOT NULL,runner_instance TEXT NOT NULL,request_hash TEXT NOT NULL,
      request_json TEXT NOT NULL,expires_at INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN('pending','deciding','approved','rejected','expired','invalidated')),
      created_at INTEGER NOT NULL,decided_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS incident_investigation_model_requests (
      request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL REFERENCES incident_investigation_runs(run_id),
      mode TEXT NOT NULL CHECK(mode IN('real_pi','protocol_stub')),state TEXT NOT NULL CHECK(state IN('reserved','dispatched','received','failed')),
      started_at INTEGER NOT NULL,ended_at INTEGER,status_code INTEGER,input_bytes INTEGER NOT NULL DEFAULT 0,output_bytes INTEGER NOT NULL DEFAULT 0
    );
  `);
}
export type JobRow = {
  job_id: string;
  incident_id: string;
  generation: number;
  state: JobState;
  attempt: number;
  next_at: number;
  lease_owner: string | null;
  lease_token: number;
  lease_expires_at: number | null;
  run_id: string | null;
  input_revision: number;
  pending_revision: number;
  snapshot_json: string;
  error_code: string | null;
  model_requests: number;
  tool_calls: number;
  search_calls: number;
};
export type RunRow = {
  run_id: string;
  job_id: string;
  attempt: number;
  lease_token: number;
  owner: string;
  status: string;
  started_at: number;
  ended_at: number | null;
  deadline_at: number;
  from_at: string;
  to_at: string;
  source_id: string | null;
  instance_id: string | null;
  mode: string;
  report_json: string | null;
  error_code: string | null;
  notification_json: string | null;
  model_requests: number;
  tool_calls: number;
  search_calls: number;
};
export type IncidentSnapshot = {
  task_kind?: 'recovery_verification';
  incident_id: string;
  service: string;
  environment: string;
  source: string;
  source_scope: string;
  alert: string;
  started_at: string;
  window_end: string;
  delivery_count: number;
  alert_count: number;
  alerts: Array<{
    occurrence_id: string;
    status: string;
    severity: string | null;
    alert_type: string;
    source_summary: unknown;
  }>;
};
const allowedTransitions: Record<string, string[]> = {
  RECEIVED: ['INVESTIGATING', 'FAILED'],
  INVESTIGATING: ['DIAGNOSED', 'ESCALATED', 'FAILED'],
  DIAGNOSED: ['AWAITING_APPROVAL', 'ESCALATED', 'FAILED'],
  AWAITING_APPROVAL: ['RESOLVED', 'ESCALATED', 'FAILED'],
  RESOLVED: [],
  ESCALATED: [],
  FAILED: [],
};
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export class InvestigationStore {
  constructor(readonly db: Database.Database) {
    db.pragma('busy_timeout=5000');
  }
  runtimeTrace(lease: Lease, input: unknown, now = Date.now()): void {
    const denial = this.db
      .transaction(() => {
        this.assertLease(lease, now);
        const value = z
          .strictObject({
            stage: z.enum(['tool_start', 'tool_end']),
            tool_name: z.string().min(1).max(200),
            tool_call_id: z.string().min(1).max(100),
            is_error: z.boolean().nullable(),
            input: z.record(z.string(), z.json()).optional(),
          })
          .parse(input);
        const row = this.db
          .prepare(
            'SELECT runtime_trace_json FROM incident_investigation_runs WHERE run_id=?',
          )
          .get(lease.run_id) as { runtime_trace_json: string };
        const trace = JSON.parse(row.runtime_trace_json) as unknown[];
        if (trace.length >= 96) fail('runtime_trace_budget');
        const allowed = [
          'incident_id',
          'service',
          'environment',
          'from',
          'to',
          'limit',
          'query',
          'top_k',
        ];
        const args = Object.fromEntries(
          Object.entries(value.input ?? {})
            .filter(
              ([key, v]) =>
                allowed.includes(key) &&
                (typeof v === 'string' || typeof v === 'number'),
            )
            .map(([key, v]) => [
              key,
              typeof v === 'string' ? sanitizeAlertText(v.slice(0, 256)) : v,
            ]),
        );
        let rejected: string | null = null;
        if (value.stage === 'tool_start')
          try {
            this.reserveTool(
              lease,
              value.tool_name.split('__').at(-1)!,
              now,
              value.tool_call_id,
            );
          } catch (error) {
            rejected =
              error instanceof Error ? error.message : 'runtime_tool_denied';
          }
        trace.push({
          ...value,
          tool_name: sanitizeAlertText(value.tool_name),
          input: args,
          parameters_filtered: true,
          budget_denial: rejected,
          observed_at: new Date(now).toISOString(),
        });
        this.db
          .prepare(
            'UPDATE incident_investigation_runs SET runtime_trace_json=? WHERE run_id=?',
          )
          .run(boundedJson(trace, 65536), lease.run_id);
        return rejected;
      })
      .immediate();
    if (denial) fail(denial);
  }
  snapshot(id: string): IncidentSnapshot {
    liveId.parse(id);
    const row = this.db
      .prepare(
        'SELECT incident_id,service,environment,source,source_scope,alert,started_at,window_end,delivery_count,alert_count FROM incident_live_records WHERE incident_id=?',
      )
      .get(id) as Omit<IncidentSnapshot, 'alerts'> | undefined;
    if (!row) fail('incident_not_found');
    const alerts = this.db
      .prepare(
        'SELECT occurrence_id,status,severity,alert_type,source_summary FROM incident_alert_occurrences WHERE incident_id=? ORDER BY starts_at,occurrence_id LIMIT 100',
      )
      .all(id) as Array<{
      occurrence_id: string;
      status: string;
      severity: string | null;
      alert_type: string;
      source_summary: string;
    }>;
    return {
      ...row,
      alerts: alerts.map((a) => ({
        ...a,
        source_summary: JSON.parse(a.source_summary),
      })),
    };
  }
  enqueue(
    id: string,
    explicitRecheck = false,
    now = Date.now(),
  ): JobRow | null {
    return this.db
      .transaction(() => {
        const snapshot = this.snapshot(id),
          revision = snapshot.delivery_count;
        const latest = this.db
          .prepare(
            'SELECT * FROM incident_investigation_jobs WHERE incident_id=? ORDER BY generation DESC LIMIT 1',
          )
          .get(id) as JobRow | undefined;
        if (
          latest &&
          ['queued', 'running', 'retry_wait'].includes(latest.state)
        ) {
          if (explicitRecheck) fail('investigation_already_active');
          this.db
            .prepare(
              `UPDATE incident_investigation_jobs SET pending_revision=MAX(pending_revision,?),
          input_revision=CASE WHEN state='queued' AND attempt=0 THEN ? ELSE input_revision END,
          snapshot_json=CASE WHEN state='queued' AND attempt=0 THEN ? ELSE snapshot_json END,updated_at=? WHERE job_id=?`,
            )
            .run(revision, revision, boundedJson(snapshot), now, latest.job_id);
          return this.job(latest.job_id);
        }
        if (latest && !explicitRecheck) {
          this.db
            .prepare(
              'UPDATE incident_investigation_jobs SET pending_revision=MAX(pending_revision,?),updated_at=? WHERE job_id=?',
            )
            .run(revision, now, latest.job_id);
          return this.job(latest.job_id);
        }
        if (
          !explicitRecheck &&
          !snapshot.alerts.some((a) => a.status === 'firing')
        )
          return null;
        const generation = (latest?.generation ?? 0) + 1,
          job_id = randomUUID();
        this.db
          .prepare(
            `INSERT INTO incident_investigation_jobs(job_id,incident_id,generation,idempotency_key,state,next_at,input_revision,pending_revision,snapshot_json,created_at,updated_at)
        VALUES(?,?,?,?, 'queued',?,?,?,?,?,?)`,
          )
          .run(
            job_id,
            id,
            generation,
            hash(`${id}:${generation}`),
            now,
            revision,
            revision,
            boundedJson(snapshot),
            now,
            now,
          );
        return this.job(job_id);
      })
      .immediate();
  }
  scanPending(limit = 100, now = Date.now()): number {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail('invalid_scan_limit');
    const records = this.db
      .prepare(
        `SELECT incident_id FROM incident_live_records WHERE NOT EXISTS(SELECT 1 FROM incident_investigation_jobs j WHERE j.incident_id=incident_live_records.incident_id) AND EXISTS(SELECT 1 FROM incident_alert_occurrences a WHERE a.incident_id=incident_live_records.incident_id AND a.status='firing') ORDER BY first_received_at LIMIT ?`,
      )
      .all(limit) as Array<{ incident_id: string }>;
    for (const r of records) this.enqueue(r.incident_id, false, now);
    return records.length;
  }
  job(id: string): JobRow {
    const row = this.db
      .prepare('SELECT * FROM incident_investigation_jobs WHERE job_id=?')
      .get(id) as JobRow | undefined;
    if (!row) fail('job_not_found');
    return row;
  }
  run(id: string): RunRow {
    const row = this.db
      .prepare('SELECT * FROM incident_investigation_runs WHERE run_id=?')
      .get(id) as RunRow | undefined;
    if (!row) fail('run_not_found');
    return row;
  }
  assertLease(lease: Lease, now = Date.now()): { job: JobRow; run: RunRow } {
    const job = this.job(lease.job_id),
      run = this.run(lease.run_id);
    if (
      job.state !== 'running' ||
      job.run_id !== lease.run_id ||
      job.lease_owner !== lease.owner ||
      job.lease_token !== lease.token ||
      !job.lease_expires_at ||
      job.lease_expires_at <= now ||
      run.owner !== lease.owner ||
      run.lease_token !== lease.token
    )
      fail('stale_lease');
    if (run.deadline_at <= now) fail('wall_budget');
    return { job, run };
  }
  claim(
    owner: string,
    options: { lease_ms?: number; wall_ms?: number; incident_id?: string } = {},
    now = Date.now(),
  ): Lease | null {
    safeId.parse(owner);
    const leaseMs = options.lease_ms ?? 30000,
      wallMs = options.wall_ms ?? 180000;
    if (leaseMs < 100 || leaseMs > 30000 || wallMs < 100 || wallMs > 180000)
      fail('invalid_worker_limits');
    return this.db
      .transaction(() => {
        this.reap(now);
        const job = this.db
          .prepare(
            `SELECT * FROM incident_investigation_jobs WHERE state IN('queued','retry_wait') AND next_at<=? ${options.incident_id ? 'AND incident_id=?' : ''} ORDER BY next_at,created_at LIMIT 1`,
          )
          .get(
            ...(options.incident_id
              ? [now, liveId.parse(options.incident_id)]
              : [now]),
          ) as JobRow | undefined;
        if (!job) return null;
        const run_id = `RUN-${randomUUID()}`,
          token = job.lease_token + 1,
          attempt = job.attempt + 1;
        const changed = this.db
          .prepare(
            `UPDATE incident_investigation_jobs SET state='running',attempt=?,run_id=?,lease_owner=?,lease_token=?,lease_expires_at=?,updated_at=?,error_code=NULL WHERE job_id=? AND state IN('queued','retry_wait') AND lease_token=?`,
          )
          .run(
            attempt,
            run_id,
            owner,
            token,
            now + leaseMs,
            now,
            job.job_id,
            job.lease_token,
          ).changes;
        if (!changed) return null;
        const from = new Date(now - 60000).toISOString(),
          to = new Date(now + 14 * 60000).toISOString();
        this.db
          .prepare(
            `INSERT INTO incident_investigation_runs(run_id,job_id,attempt,lease_token,owner,status,started_at,deadline_at,from_at,to_at) VALUES(?,?,?,?,?,'RECEIVED',?,?,?,?)`,
          )
          .run(
            run_id,
            job.job_id,
            attempt,
            token,
            owner,
            now,
            now + wallMs,
            from,
            to,
          );
        return { job_id: job.job_id, run_id, owner, token };
      })
      .immediate();
  }
  heartbeat(lease: Lease, leaseMs = 30000, now = Date.now()): void {
    this.db
      .transaction(() => {
        const { run } = this.assertLease(lease, now);
        if (leaseMs < 100 || leaseMs > 30000) fail('invalid_worker_limits');
        this.db
          .prepare(
            'UPDATE incident_investigation_jobs SET lease_expires_at=?,updated_at=? WHERE job_id=?',
          )
          .run(Math.min(now + leaseMs, run.deadline_at), now, lease.job_id);
      })
      .immediate();
  }
  bindSource(
    lease: Lease,
    source: { source_id: string; instance_id: string },
    mode: string,
    now = Date.now(),
  ): void {
    this.db
      .transaction(() => {
        this.assertLease(lease, now);
        safeId.parse(source.source_id);
        z.uuid().parse(source.instance_id);
        if (!['real_pi', 'host_no_model', 'protocol_stub'].includes(mode))
          fail('invalid_run_mode');
        this.db
          .prepare(
            'UPDATE incident_investigation_runs SET source_id=?,instance_id=?,mode=? WHERE run_id=?',
          )
          .run(source.source_id, source.instance_id, mode, lease.run_id);
      })
      .immediate();
  }
  reserveTool(
    lease: Lease,
    tool: string,
    now = Date.now(),
    callId: string = randomUUID(),
  ): void {
    this.db
      .transaction(() => {
        const { job, run } = this.assertLease(lease, now);
        if (!(toolNames as readonly string[]).includes(tool))
          fail('tool_not_allowed');
        if (!callId || callId.length > 100) fail('tool_call_identity');
        const row = this.db
          .prepare(
            'SELECT tool_reservations_json FROM incident_investigation_runs WHERE run_id=?',
          )
          .get(lease.run_id) as { tool_reservations_json: string };
        const reservations = JSON.parse(row.tool_reservations_json) as Array<{
          id: string;
          tool: string;
        }>;
        const previous = reservations.find((r) => r.id === callId);
        if (previous) {
          if (previous.tool !== tool) fail('tool_call_identity_conflict');
          return;
        }
        if (
          run.tool_calls >= 8 ||
          job.tool_calls >= 16 ||
          (tool === 'search_runbooks' &&
            (run.search_calls >= 2 || job.search_calls >= 4))
        )
          fail('tool_budget');
        const search = Number(tool === 'search_runbooks');
        reservations.push({ id: callId, tool });
        this.db
          .prepare(
            'UPDATE incident_investigation_runs SET tool_reservations_json=? WHERE run_id=?',
          )
          .run(boundedJson(reservations), lease.run_id);
        this.db
          .prepare(
            'UPDATE incident_investigation_jobs SET tool_calls=tool_calls+1,search_calls=search_calls+? WHERE job_id=?',
          )
          .run(search, lease.job_id);
        this.db
          .prepare(
            'UPDATE incident_investigation_runs SET tool_calls=tool_calls+1,search_calls=search_calls+? WHERE run_id=?',
          )
          .run(search, lease.run_id);
      })
      .immediate();
  }
  reserveModel(
    lease: Lease,
    mode: 'real_pi' | 'protocol_stub',
    max = 6,
    bytes = 0,
    now = Date.now(),
  ): string {
    return this.db
      .transaction(() => {
        const { job, run } = this.assertLease(lease, now);
        if (max < 1 || max > 6 || !Number.isInteger(max))
          fail('invalid_model_limit');
        if (run.model_requests >= max || job.model_requests >= 12)
          fail('model_budget');
        const id = randomUUID();
        this.db
          .prepare(
            'UPDATE incident_investigation_jobs SET model_requests=model_requests+1 WHERE job_id=?',
          )
          .run(lease.job_id);
        this.db
          .prepare(
            'UPDATE incident_investigation_runs SET model_requests=model_requests+1 WHERE run_id=?',
          )
          .run(lease.run_id);
        this.db
          .prepare(
            "INSERT INTO incident_investigation_model_requests(request_id,run_id,mode,state,started_at,input_bytes) VALUES(?,?,?,'reserved',?,?)",
          )
          .run(id, lease.run_id, mode, now, bytes);
        return id;
      })
      .immediate();
  }
  modelState(
    lease: Lease,
    id: string,
    state: 'dispatched' | 'received' | 'failed',
    status: number | null = null,
    bytes = 0,
    now = Date.now(),
  ): void {
    this.db
      .transaction(() => {
        this.assertLease(lease, now);
        const changed = this.db
          .prepare(
            'UPDATE incident_investigation_model_requests SET state=?,status_code=?,output_bytes=?,ended_at=? WHERE request_id=? AND run_id=?',
          )
          .run(
            state,
            status,
            bytes,
            state === 'dispatched' ? null : now,
            id,
            lease.run_id,
          ).changes;
        if (changed !== 1) fail('model_request_not_found');
      })
      .immediate();
  }
  append(lease: Lease, input: unknown, now = Date.now()): number {
    return this.db
      .transaction(() => {
        const { job, run } = this.assertLease(lease, now),
          snapshot = JSON.parse(job.snapshot_json) as IncidentSnapshot;
        const event = eventSchema.parse(input),
          serialized = boundedJson(event, 160000);
        if (event.incident_id !== job.incident_id)
          fail('event_incident_mismatch');
        const existing = this.db
          .prepare(
            'SELECT run_id,seq,event_json FROM incident_investigation_events WHERE event_id=?',
          )
          .get(event.event_id) as
          | { run_id: string; seq: number; event_json: string }
          | undefined;
        if (existing) {
          if (
            existing.run_id !== lease.run_id ||
            existing.event_json !== serialized
          )
            fail('event_id_conflict');
          return existing.seq;
        }
        const events = this.events(lease.run_id),
          previous = events.at(-1);
        if (
          previous &&
          Date.parse(event.timestamp) < Date.parse(previous.timestamp)
        )
          fail('event_time_backwards');
        if (
          Date.parse(event.timestamp) > now + 1000 ||
          Date.parse(event.timestamp) < run.started_at - 2000
        )
          fail('event_time_scope');
        const p = event.payload as Record<string, any>,
          type = event.event_type;
        const call =
          typeof p.tool_call_id === 'string'
            ? events.find(
                (e) =>
                  e.event_type === 'ToolCalled' &&
                  e.payload.tool_call_id === p.tool_call_id,
              )
            : undefined;
        if (type === 'IncidentCreated') {
          if (
            events.length ||
            p.status !== 'RECEIVED' ||
            p.service !== snapshot.service
          )
            fail('invalid_incident_created');
        } else if (!events.length) fail('event_before_incident');
        if (type === 'StatusChanged') {
          if (
            p.from !== run.status ||
            !allowedTransitions[run.status]?.includes(p.to)
          )
            fail('invalid_incident_transition');
          this.db
            .prepare(
              'UPDATE incident_investigation_runs SET status=? WHERE run_id=?',
            )
            .run(p.to, lease.run_id);
        }
        if (
          [
            'ToolCalled',
            'ToolResult',
            'ToolFailed',
            'EvidenceCollected',
          ].includes(type)
        ) {
          if (!(toolNames as readonly unknown[]).includes(p.tool))
            fail('tool_not_allowed');
          if (type === 'ToolCalled') {
            if (!p.tool_call_id || call) fail('duplicate_tool_call');
            if (
              events.filter((e) => e.event_type === 'ToolCalled').length >=
              run.tool_calls
            )
              fail('tool_without_budget');
            if (
              !p.request ||
              p.request.incident_id !== job.incident_id ||
              (p.request.service && p.request.service !== snapshot.service) ||
              (p.request.environment &&
                p.request.environment !== snapshot.environment)
            )
              fail('tool_request_scope_mismatch');
          } else {
            if (!call || call.payload.tool !== p.tool)
              fail('tool_result_without_call');
          }
          const result = events.find(
            (e) =>
              e.event_type === 'ToolResult' &&
              e.payload.tool_call_id === p.tool_call_id,
          );
          if (type === 'ToolResult') {
            if (result) fail('duplicate_tool_result');
            if (p.status === 'returned' && p.tool === 'search_runbooks')
              this.saveKnowledge(
                lease,
                p.knowledge_result,
                p.tool_call_id,
                snapshot,
                run,
              );
            if (
              p.status === 'returned' &&
              ['query_live_logs', 'query_live_metrics'].includes(p.tool)
            )
              this.saveEvidence(
                lease,
                p.tool_output,
                p.tool_call_id,
                snapshot,
                run,
              );
          }
          if (type === 'EvidenceCollected') {
            if (
              !result ||
              result.payload.status !== 'returned' ||
              !this.evidence(lease.run_id).some(
                (e) =>
                  e.evidence_id === p.evidence_id &&
                  e.correlation_id === p.correlation_id &&
                  e.source === p.source,
              )
            )
              fail('evidence_without_result');
            const owner = this.db
              .prepare(
                'SELECT tool_call_id FROM incident_investigation_evidence WHERE evidence_id=? AND run_id=?',
              )
              .get(p.evidence_id, lease.run_id) as
              | { tool_call_id: string }
              | undefined;
            if (owner?.tool_call_id !== p.tool_call_id)
              fail('evidence_call_mismatch');
            if (
              events.some(
                (e) =>
                  e.event_type === 'EvidenceCollected' &&
                  e.payload.evidence_id === p.evidence_id,
              )
            )
              fail('duplicate_evidence_event');
          }
          if (
            type === 'ToolFailed' &&
            (!result ||
              !['error', 'timeout', 'threw'].includes(
                String(result.payload.status),
              ))
          )
            fail('invalid_tool_failure');
        }
        if (type === 'DiagnosisCreated') {
          const observed = events
            .filter((e) => e.event_type === 'EvidenceCollected')
            .map((e) => e.payload.evidence_id);
          if (
            events.some((e) => e.event_type === 'DiagnosisCreated') ||
            !Array.isArray(p.evidence_ids) ||
            !p.evidence_ids.length ||
            p.evidence_ids.some((id: string) => !observed.includes(id))
          )
            fail('diagnosis_without_observations');
        }
        if (
          ['ApprovalRequested', 'ApprovalDecided', 'ActionExecuted'].includes(
            type,
          )
        )
          fail('readonly_run_has_no_execution_capability');
        const seq = events.length + 1;
        if (seq > 128) fail('event_limit');
        this.db
          .prepare('INSERT INTO incident_investigation_events VALUES(?,?,?,?)')
          .run(event.event_id, lease.run_id, seq, serialized);
        return seq;
      })
      .immediate();
  }
  private saveEvidence(
    lease: Lease,
    value: unknown,
    callId: string,
    snapshot: IncidentSnapshot,
    run: RunRow,
  ): void {
    const e = evidenceSchema.parse(value),
      c = JSON.parse(e.content);
    if (
      Buffer.byteLength(JSON.stringify(e)) > 65536 ||
      e.incident_id !== snapshot.incident_id ||
      c.run_id !== run.run_id ||
      c.service !== snapshot.service ||
      c.environment !== snapshot.environment ||
      c.source_id !== run.source_id ||
      c.instance_id !== run.instance_id ||
      c.provider !== 'local_demo' ||
      c.kind !== e.source ||
      c.query_id !== e.correlation_id ||
      c.observed_at !== e.timestamp ||
      e.evidence_id !==
        `${snapshot.incident_id}:${run.run_id}:${e.source}:${e.correlation_id}`
    )
      fail('invalid_observation_provenance');
    if (
      !c.window ||
      Date.parse(c.window.from) < Date.parse(run.from_at) ||
      Date.parse(c.window.to) > Date.parse(run.to_at) ||
      !(Date.parse(c.window.from) < Date.parse(c.window.to)) ||
      !Array.isArray(c.items) ||
      c.items.length > 200 ||
      !['success', 'empty'].includes(c.status)
    )
      fail('invalid_observation_range');
    if (
      Date.parse(c.window.to) > Date.parse(e.timestamp) ||
      Date.parse(e.timestamp) < run.started_at - 2000 ||
      Date.parse(e.timestamp) > Date.now() + 1000 ||
      (c.status === 'empty' && c.items.length !== 0) ||
      (c.status === 'success' && c.items.length === 0)
    )
      fail('invalid_observation_time');
    if (
      c.items.some((i: any) => {
        const t = Date.parse(i.timestamp ?? i.observed_at);
        return (
          !Number.isFinite(t) ||
          t < Date.parse(c.window.from) ||
          t > Date.parse(c.window.to)
        );
      })
    )
      fail('invalid_observation_time');
    this.db
      .prepare('INSERT INTO incident_investigation_evidence VALUES(?,?,?,?,?)')
      .run(e.evidence_id, lease.run_id, callId, e.source, boundedJson(e));
  }
  private saveKnowledge(
    lease: Lease,
    value: any,
    callId: string,
    snapshot: IncidentSnapshot,
    run: RunRow,
  ): void {
    if (
      !value ||
      value.kind !== 'runbook_search' ||
      value.incident_id !== snapshot.incident_id ||
      value.run_id !== run.run_id ||
      !Array.isArray(value.references) ||
      value.references.length > 5 ||
      !['matched', 'no_match'].includes(value.status)
    )
      fail('invalid_knowledge_result');
    for (const input of value.references) {
      const k = knowledgeSchema.parse(input);
      if (
        k.incident_id !== snapshot.incident_id ||
        k.run_id !== run.run_id ||
        k.tool_call_id !== callId ||
        k.query !== value.query ||
        k.service !== snapshot.service ||
        k.environment !== snapshot.environment ||
        Date.parse(k.retrieved_at) < run.started_at - 2000
      )
        fail('knowledge_scope_mismatch');
      const chunk = {
        chunk_id: k.chunk_id,
        doc_id: k.doc_id,
        version: k.version,
        version_hash: k.version_hash,
        section: k.section,
        start_offset: k.start_offset,
        end_offset: k.end_offset,
        snippet: k.snippet,
        services: k.services,
        environments: k.environments,
      };
      const existing = this.db
        .prepare(
          'SELECT chunk_json FROM incident_runbook_chunks WHERE chunk_id=?',
        )
        .get(k.chunk_id) as { chunk_json: string } | undefined;
      const serialized = boundedJson(chunk);
      if (existing && existing.chunk_json !== serialized)
        fail('runbook_snapshot_conflict');
      this.db
        .prepare(
          'INSERT OR IGNORE INTO incident_runbook_chunks VALUES(?,?,?,?)',
        )
        .run(k.chunk_id, k.doc_id, k.version_hash, serialized);
      this.db
        .prepare('INSERT INTO incident_investigation_knowledge VALUES(?,?,?,?)')
        .run(k.reference_id, lease.run_id, k.chunk_id, boundedJson(k));
    }
  }
  events(runId: string): InvestigationEvent[] {
    return (
      this.db
        .prepare(
          'SELECT event_json FROM incident_investigation_events WHERE run_id=? ORDER BY seq',
        )
        .all(runId) as Array<{ event_json: string }>
    ).map((e) => eventSchema.parse(JSON.parse(e.event_json)));
  }
  evidence(runId: string): InvestigationEvidence[] {
    return (
      this.db
        .prepare(
          'SELECT evidence_json FROM incident_investigation_evidence WHERE run_id=? ORDER BY rowid',
        )
        .all(runId) as Array<{ evidence_json: string }>
    ).map((e) => evidenceSchema.parse(JSON.parse(e.evidence_json)));
  }
  knowledge(runId: string): StoredKnowledge[] {
    return (
      this.db
        .prepare(
          'SELECT reference_json FROM incident_investigation_knowledge WHERE run_id=? ORDER BY rowid',
        )
        .all(runId) as Array<{ reference_json: string }>
    ).map((e) => knowledgeSchema.parse(JSON.parse(e.reference_json)));
  }
  finish(
    lease: Lease,
    state: 'blocked' | 'completed' | 'manual' | 'failed',
    report: unknown,
    errorCode: string | null,
    now = Date.now(),
  ): void {
    this.db
      .transaction(() => {
        const { job, run } = this.assertLease(lease, now);
        if (!['DIAGNOSED', 'ESCALATED', 'FAILED'].includes(run.status))
          fail('unfinished_lifecycle');
        if (
          state === 'completed' &&
          (run.status !== 'DIAGNOSED' || report === null)
        )
          fail('completed_without_diagnosis');
        if (report !== null) {
          const snapshot = JSON.parse(job.snapshot_json) as IncidentSnapshot,
            core = reportCore(report as Record<string, unknown>);
          validateReport(
            core,
            {
              incident_id: job.incident_id,
              service: snapshot.service,
              environment: snapshot.environment,
              run_id: lease.run_id,
              from: run.from_at,
              to: run.to_at,
            },
            this.evidence(lease.run_id),
            this.knowledge(lease.run_id),
          );
          if (core.outcome !== run.status) fail('report_status_mismatch');
        }
        const notification = {
          kind: 'local_record',
          state,
          error_code: errorCode,
          recorded_at: new Date(now).toISOString(),
        };
        this.db
          .prepare(
            'UPDATE incident_investigation_runs SET ended_at=?,report_json=?,error_code=?,notification_json=? WHERE run_id=?',
          )
          .run(
            now,
            report === null ? null : boundedJson(report),
            errorCode,
            boundedJson(notification),
            lease.run_id,
          );
        this.db
          .prepare(
            'UPDATE incident_investigation_jobs SET state=?,lease_owner=NULL,lease_expires_at=NULL,error_code=?,updated_at=? WHERE job_id=?',
          )
          .run(state, errorCode, now, lease.job_id);
        this.invalidateApprovals(lease.run_id, now);
      })
      .immediate();
  }
  markRecoveryTask(lease: Lease, now = Date.now()): void {
    this.db
      .transaction(() => {
        const { job } = this.assertLease(lease, now);
        const snapshot = JSON.parse(job.snapshot_json) as IncidentSnapshot;
        this.db
          .prepare(
            'UPDATE incident_investigation_jobs SET snapshot_json=? WHERE job_id=?',
          )
          .run(
            boundedJson({ ...snapshot, task_kind: 'recovery_verification' }),
            job.job_id,
          );
      })
      .immediate();
  }
  retry(lease: Lease, reason: string, now = Date.now()): void {
    this.db
      .transaction(() => {
        const { job } = this.assertLease(lease, now);
        this.failRun(job, reason, now);
        this.db
          .prepare(
            'UPDATE incident_investigation_jobs SET state=?,next_at=?,lease_owner=NULL,lease_expires_at=NULL,error_code=?,updated_at=? WHERE job_id=?',
          )
          .run(
            JSON.parse(job.snapshot_json).task_kind === 'recovery_verification'
              ? 'manual'
              : job.attempt < 2
                ? 'retry_wait'
                : 'failed',
            now + 10000,
            reason,
            now,
            job.job_id,
          );
      })
      .immediate();
  }
  reap(now = Date.now()): number {
    return this.db
      .transaction(() => {
        const rows = this.db
          .prepare(
            `SELECT j.* FROM incident_investigation_jobs j JOIN incident_investigation_runs r ON r.run_id=j.run_id WHERE j.state='running' AND (j.lease_expires_at<=? OR r.deadline_at<=?)`,
          )
          .all(now, now) as JobRow[];
        for (const job of rows) {
          const run = this.run(job.run_id!);
          const wall = run.deadline_at <= now;
          this.failRun(job, wall ? 'wall_budget' : 'lease_expired', now);
          this.db
            .prepare(
              'UPDATE incident_investigation_jobs SET state=?,next_at=?,lease_owner=NULL,lease_expires_at=NULL,error_code=?,updated_at=? WHERE job_id=?',
            )
            .run(
              wall ||
                JSON.parse(job.snapshot_json).task_kind ===
                  'recovery_verification'
                ? 'manual'
                : job.attempt < 2
                  ? 'retry_wait'
                  : 'failed',
              now + 10000,
              wall ? 'wall_budget' : 'lease_expired',
              now,
              job.job_id,
            );
        }
        return rows.length;
      })
      .immediate();
  }
  private failRun(job: JobRow, reason: string, now: number): void {
    const run = this.run(job.run_id!),
      events = this.events(run.run_id);
    if (events.length && allowedTransitions[run.status]?.includes('FAILED')) {
      const event = {
        event_id: randomUUID(),
        incident_id: job.incident_id,
        event_type: 'StatusChanged',
        timestamp: new Date(
          Math.max(now, Date.parse(events.at(-1)!.timestamp)),
        ).toISOString(),
        payload: { from: run.status, to: 'FAILED', reason },
      };
      this.db
        .prepare('INSERT INTO incident_investigation_events VALUES(?,?,?,?)')
        .run(event.event_id, run.run_id, events.length + 1, boundedJson(event));
    }
    this.db
      .prepare(
        'UPDATE incident_investigation_runs SET status=?,ended_at=?,error_code=?,notification_json=? WHERE run_id=?',
      )
      .run(
        allowedTransitions[run.status]?.includes('FAILED')
          ? 'FAILED'
          : run.status,
        now,
        reason,
        boundedJson({
          kind: 'local_record',
          state: 'interrupted',
          error_code: reason,
        }),
        run.run_id,
      );
    this.invalidateApprovals(run.run_id, now);
  }
  invalidateApprovals(run: string, now = Date.now()): void {
    this.db
      .prepare(
        "UPDATE incident_investigation_approvals SET state='invalidated',decided_at=? WHERE run_id=? AND state IN('pending','deciding')",
      )
      .run(now, run);
  }
  list(id: string) {
    liveId.parse(id);
    return (
      this.db
        .prepare(
          'SELECT * FROM incident_investigation_jobs WHERE incident_id=? ORDER BY generation DESC LIMIT 20',
        )
        .all(id) as JobRow[]
    ).map(({ snapshot_json: _s, lease_owner: _o, ...job }) => ({
      ...job,
      runs: (
        this.db
          .prepare(
            'SELECT run_id,status,attempt,started_at,ended_at,mode,error_code,notification_json FROM incident_investigation_runs WHERE job_id=? ORDER BY attempt',
          )
          .all(job.job_id) as Array<any>
      ).map((r) => ({
        ...r,
        notification: r.notification_json
          ? JSON.parse(r.notification_json)
          : null,
        notification_json: undefined,
      })),
    }));
  }
  detail(id: string, runId: string) {
    const run = this.run(runId),
      job = this.job(run.job_id);
    if (job.incident_id !== id) fail('run_incident_mismatch');
    const evidence = this.evidence(runId),
      knowledge = this.knowledge(runId),
      events = this.events(runId);
    return {
      run,
      runtime_tool_attempts: JSON.parse(
        (run as RunRow & { runtime_trace_json: string }).runtime_trace_json,
      ),
      report: run.report_json ? JSON.parse(run.report_json) : null,
      observed_evidence: evidence,
      knowledge_references: knowledge,
      events,
    };
  }
}
let bound: InvestigationStore | null = null;
export function bindInvestigationDatabase(db: Database.Database | null): void {
  bound = db ? new InvestigationStore(db) : null;
}
export function getInvestigationStore(): InvestigationStore {
  if (!bound) fail('investigation_store_unavailable');
  return bound;
}
/** Intake outbox runs in the existing ingestion transaction, never starts a model. */
export function syncInvestigationIntake(
  db: Database.Database,
  ids: string[],
  now: number,
): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='incident_investigation_jobs'",
      )
      .get()
  )
    return;
  const store = new InvestigationStore(db);
  for (const id of ids) store.enqueue(id, false, now);
}
