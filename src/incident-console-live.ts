/** Bounded, sanitized read projection over the existing alert/task store. No execution capability. */
import { z } from 'zod';
import { IncidentStore } from './incident-store.js';
import {
  InvestigationStore,
  type RunRow,
} from './incident-investigation-store.js';
import { investigationHistory } from './incident-investigation-history.js';
import {
  AlertInputError,
  sanitizeAlertText,
  type AlertAccess,
  scopeName,
} from './incident-alert-types.js';
import { liveId, fail } from './incident-investigation-types.js';
export const consoleLiveQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(20).default(10),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  service: scopeName.optional(),
  environment: scopeName.optional(),
  source: scopeName.optional(),
});
export const consoleSectionQuery = z.strictObject({
  section: z
    .enum(['report', 'evidence', 'knowledge', 'events', 'replay', 'attempts'])
    .default('report'),
  limit: z.coerce.number().int().min(1).max(20).default(10),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
  reference: z.string().min(1).max(250).optional(),
});
type Page = { limit: number; offset: number };
// Preserve actual identity/order/state; full tool bodies have separate paginated sections.
export function consoleEvent<T extends { payload: Record<string, unknown> }>(
  event: T,
) {
  if (Buffer.byteLength(JSON.stringify(event.payload)) <= 8192) return event;
  const keys = new Set([
    'tool',
    'tool_call_id',
    'origin',
    'status',
    'from',
    'to',
    'service',
    'source',
    'correlation_id',
    'evidence_id',
    'evidence_ids',
    'reason',
    'error',
    'error_code',
  ]);
  const payload = Object.fromEntries(
    Object.entries(event.payload)
      .filter(([key]) => keys.has(key))
      .map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value.slice(0, 512)
          : Array.isArray(value)
            ? value.slice(0, 20).map((v) => String(v).slice(0, 250))
            : value,
      ]),
  );
  return { ...event, payload, payload_truncated: true };
}
export function consoleRedact(value: unknown): unknown {
  let nodes = 0;
  const walk = (v: unknown, depth = 0, key = ''): unknown => {
    if (++nodes > 30000 || depth > 12)
      throw new AlertInputError('console_output_too_large', 413);
    if (typeof v === 'string') {
      if (v.length > 65536)
        throw new AlertInputError('console_output_too_large', 413);
      const clean = sanitizeAlertText(v)
        .replace(
          /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
          '[REDACTED]',
        )
        .replace(/[A-Z]:[\\/][^\s"']+/gi, '[PATH REDACTED]');
      return ['version_hash', 'catalog_hash', 'aggregation_key'].includes(key)
        ? clean
        : clean.replace(/\b[a-f0-9]{64}\b/gi, '[REDACTED]');
    }
    if (Array.isArray(v)) {
      if (v.length > 500)
        throw new AlertInputError('console_output_too_large', 413);
      return v.map((item) => walk(item, depth + 1, key));
    }
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(
            ([k]) =>
              !/(?:password|passwd|secret|credential|authorization|cookie|api[_-]?key|^token$|session[_-]?token|read[_-]?token|access[_-]?token|refresh[_-]?token|base[_-]?url|source_scope|lease_token|snapshot_json|report_json|runtime_trace_json|tool_reservations_json|owner)/i.test(
                k,
              ),
          )
          .map(([k, item]) => [k, walk(item, depth + 1, k)]),
      );
    return v;
  };
  const result = walk(value);
  if (Buffer.byteLength(JSON.stringify(result)) > 262144)
    throw new AlertInputError('console_output_too_large', 413);
  return result;
}
function page<T>(items: T[], q: Page, total = items.length) {
  return {
    items: items.slice(q.offset, q.offset + q.limit),
    total,
    offset: q.offset,
    limit: q.limit,
    has_more: q.offset + q.limit < total,
  };
}
function runSummary(run: RunRow) {
  return {
    run_id: run.run_id,
    status: run.status,
    attempt: run.attempt,
    started_at: run.started_at,
    ended_at: run.ended_at,
    deadline_at: run.deadline_at,
    from_at: run.from_at,
    to_at: run.to_at,
    source_id: run.source_id,
    instance_id: run.instance_id,
    mode: run.mode,
    error_code: run.error_code,
    tool_calls: run.tool_calls,
    model_requests: run.model_requests,
    search_calls: run.search_calls,
  };
}
export class IncidentConsoleLive {
  constructor(
    private readonly alerts: IncidentStore,
    private readonly tasks: InvestigationStore,
  ) {}
  private require(access: AlertAccess, id: string) {
    liveId.parse(id);
    const value = this.alerts.getIncident(access, id);
    if (!value) fail('incident_not_found');
    return value;
  }
  private summary(id: string) {
    const job = this.tasks.list(id)[0],
      run = job?.runs.at(-1),
      count = run
        ? (
            this.tasks.db
              .prepare(
                'SELECT COUNT(*) n FROM incident_investigation_evidence WHERE run_id=?',
              )
              .get(run.run_id) as { n: number }
          ).n
        : 0;
    const full = run ? this.tasks.run(run.run_id) : null;
    return {
      job: job
        ? {
            job_id: job.job_id,
            state: job.state,
            generation: job.generation,
            attempt: job.attempt,
            next_at: job.next_at,
            lease_expires_at: job.lease_expires_at,
            error_code: job.error_code,
            input_revision: job.input_revision,
            pending_revision: job.pending_revision,
            model_requests: job.model_requests,
            tool_calls: job.tool_calls,
          }
        : null,
      latest_run: full ? runSummary(full) : null,
      observation_count: count,
      source_mode: count
        ? 'local_demo_observed'
        : full?.source_id
          ? 'local_demo_unavailable'
          : 'unbound',
    };
  }
  list(access: AlertAccess, q: z.infer<typeof consoleLiveQuery>) {
    const rows = this.alerts.listIncidents(access, {
      ...q,
      limit: q.limit + 1,
    });
    return consoleRedact({
      items: rows
        .slice(0, q.limit)
        .map((i) => ({ ...i, ...this.summary(i.incident_id) })),
      offset: q.offset,
      limit: q.limit,
      has_more: rows.length > q.limit,
    });
  }
  detail(access: AlertAccess, id: string, q: Page) {
    const value = this.require(access, id),
      recent = this.tasks.db
        .prepare(
          'SELECT MAX(starts_at) last FROM incident_alert_occurrences WHERE incident_id=?',
        )
        .get(id) as { last: string };
    const jobs = this.tasks.list(id).map((job) => ({
      job_id: job.job_id,
      state: job.state,
      generation: job.generation,
      attempt: job.attempt,
      next_at: job.next_at,
      lease_expires_at: job.lease_expires_at,
      error_code: job.error_code,
      input_revision: job.input_revision,
      pending_revision: job.pending_revision,
      runs: job.runs,
    }));
    const rows = this.tasks.db
      .prepare(
        'SELECT occurrence_id,source,external_id,service,environment,severity,severity_raw,severity_mapping_status,alert_type,fingerprint,starts_at,ends_at,status,source_summary,first_received_at,last_received_at FROM incident_alert_occurrences WHERE incident_id=? ORDER BY starts_at,occurrence_id LIMIT ? OFFSET ?',
      )
      .all(id, q.limit, q.offset) as Array<Record<string, unknown>>;
    const alerts = rows.map((row) => ({
      ...row,
      source_summary: JSON.parse(row.source_summary as string),
    }));
    return consoleRedact({
      incident: value.incident,
      metadata: { ...value.metadata, last_started_at: recent.last },
      ...this.summary(id),
      alerts: {
        items: alerts,
        total: value.metadata.alert_count,
        offset: q.offset,
        limit: q.limit,
        has_more: q.offset + q.limit < value.metadata.alert_count,
      },
      jobs,
      history_window: 20,
    });
  }
  section(
    access: AlertAccess,
    id: string,
    runId: string,
    q: z.infer<typeof consoleSectionQuery>,
  ) {
    const incident = this.require(access, id);
    z.string()
      .regex(/^RUN-[0-9a-f-]{36}$/)
      .parse(runId);
    const detail = investigationHistory(this.tasks, id, runId),
      run = runSummary(detail.run);
    let items: unknown[] = [];
    if (q.section === 'evidence')
      items = detail.observed_evidence.map((e) => ({
        evidence_id: e.evidence_id,
        incident_id: e.incident_id,
        source: e.source,
        timestamp: e.timestamp,
        correlation_id: e.correlation_id,
        observation: JSON.parse(e.content),
      }));
    if (q.section === 'knowledge') items = detail.knowledge_references;
    if (q.section === 'events' || q.section === 'replay')
      items = detail.events.map(consoleEvent);
    if (q.section === 'attempts') items = detail.runtime_tool_attempts;
    if (q.reference) {
      if (!['evidence', 'knowledge'].includes(q.section))
        throw new AlertInputError('invalid_console_reference');
      items = items.filter((item) => {
        const r = item as Record<string, unknown>;
        return r.evidence_id === q.reference || r.reference_id === q.reference;
      });
      if (!items.length) fail('reference_not_found');
    }
    return consoleRedact({
      run,
      section: q.section,
      ...page(items, q),
      report: q.section === 'report' ? detail.report : null,
      scope: {
        service: incident.metadata.service,
        environment: incident.metadata.environment,
        impact: '仅确认本次服务与环境；用户、依赖影响范围尚未观测',
      },
      readonly: true,
      replay_source: 'persisted_events',
      empty_reason: detail.events.length
        ? null
        : '本次运行尚无生命周期事件，不补造回放。',
    });
  }
}
