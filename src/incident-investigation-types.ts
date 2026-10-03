/** Host contracts for persisted investigations; legacy Incident/Evidence remain intact. */
import { z } from 'zod';
export const liveId = z
  .string()
  .regex(
    /^LIVE-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
export const safeId = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
export const instant = z.iso.datetime({ offset: true });
const text = z.string().trim().min(1).max(1000);
const ids = z
  .array(z.string().min(1).max(250))
  .max(20)
  .refine((a) => new Set(a).size === a.length);
export const evidenceSchema = z.strictObject({
  evidence_id: z.string().min(1).max(250),
  incident_id: liveId,
  source: z.enum(['logs', 'metrics']),
  timestamp: instant,
  content: z.string().min(1).max(65536),
  correlation_id: z.uuid(),
});
export type InvestigationEvidence = z.infer<typeof evidenceSchema>;
export const knowledgeSchema = z
  .strictObject({
    reference_id: z.uuid(),
    incident_id: liveId,
    run_id: safeId,
    tool_call_id: z.string().min(1).max(100),
    query: z.string().min(1).max(256),
    doc_id: safeId,
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
    version_hash: z.string().regex(/^[a-f0-9]{64}$/),
    catalog_hash: z.string().regex(/^[a-f0-9]{64}$/),
    section: z.string().min(1).max(1000),
    chunk_id: z.string().min(1).max(200),
    chunk_index: z.number().int().nonnegative(),
    services: z.array(safeId).min(1).max(32),
    environments: z.array(safeId).min(1).max(32),
    service: safeId,
    environment: safeId,
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().positive(),
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    snippet: z.string().min(1).max(1000),
    rank: z.number().int().min(1).max(5),
    score: z.number().finite().positive(),
    retrieved_at: instant,
    purpose: z.literal('investigation_guidance'),
  })
  .refine(
    (r) =>
      r.end_offset - r.start_offset === r.snippet.length &&
      r.end_line >= r.start_line &&
      r.services.includes(r.service) &&
      r.environments.includes(r.environment),
  );
export type StoredKnowledge = z.infer<typeof knowledgeSchema>;
export const observationFields = [
  'pool_capacity',
  'pool_active',
  'pool_waiting',
  'requests_total',
  'requests_success',
  'acquire_timeouts',
  'requests_cancelled',
  'queue_overflows',
  'acquire_wait_ms_total',
  'message',
  'wait_ms',
  'level',
] as const;
export const factSchema = z.strictObject({
  evidence_id: z.string().min(1).max(250),
  item_index: z.number().int().min(0).max(199),
  field: z.enum(observationFields),
  value: z.union([z.number().finite(), z.string().min(1).max(100)]),
});
export const proposalSchema = z.strictObject({
  action: z.enum(['restart_service', 'rollback_config', 'modify_config']),
  target: safeId,
  parameters: z.strictObject({
    capacity: z.number().int().min(1).max(32).optional(),
    hold_ms: z.number().int().min(0).max(2000).optional(),
    acquire_timeout_ms: z.number().int().min(10).max(2000).optional(),
    config_version: safeId.optional(),
  }),
  mode: z.literal('pure_simulation'),
});
export type ApprovalProposal = z.infer<typeof proposalSchema>;
const diagnosis = z.strictObject({
  incident_id: liveId,
  root_cause: text,
  confidence: z.number().min(0).max(1),
  evidence_ids: ids.refine((a) => a.length > 0),
  recommendation: text,
});
export const reportSchema = z
  .strictObject({
    outcome: z.enum(['DIAGNOSED', 'ESCALATED']),
    diagnosis: diagnosis.nullable(),
    facts: z.array(factSchema).max(20),
    hypotheses: z
      .array(
        z.strictObject({
          hypothesis: text,
          evidence_ids: ids,
          knowledge_reference_ids: ids,
        }),
      )
      .max(8),
    handbook_suggestions: z
      .array(
        z.strictObject({
          suggestion: text,
          knowledge_reference_ids: ids.refine((a) => a.length > 0),
        }),
      )
      .max(8),
    conflicts: z
      .array(
        z.strictObject({
          description: text,
          evidence_ids: ids.refine((a) => a.length >= 2),
        }),
      )
      .max(8),
    limitations: z.array(text).max(10),
    next_evidence_requests: z.array(text).max(10),
    escalation_reason: text.nullable(),
    approval_proposals: z.array(proposalSchema).max(3),
  })
  .refine((r) =>
    r.outcome === 'DIAGNOSED'
      ? r.diagnosis !== null && r.escalation_reason === null
      : r.diagnosis === null &&
        r.escalation_reason !== null &&
        r.next_evidence_requests.length > 0,
  );
export type InvestigationReport = z.infer<typeof reportSchema>;
export function reportCore(
  value: Record<string, unknown>,
): InvestigationReport {
  return reportSchema.parse(
    Object.fromEntries(
      Object.keys(reportSchema.shape).map((key) => [key, value[key]]),
    ),
  );
}
export type Lease = {
  job_id: string;
  run_id: string;
  owner: string;
  token: number;
};
export type JobState =
  | 'queued'
  | 'running'
  | 'retry_wait'
  | 'blocked'
  | 'completed'
  | 'manual'
  | 'failed';
export const toolNames = [
  'query_live_logs',
  'query_live_metrics',
  'query_live_trace',
  'query_live_git_diff',
  'search_runbooks',
] as const;
export const eventSchema = z.strictObject({
  event_id: z.uuid(),
  incident_id: liveId,
  event_type: z.enum([
    'IncidentCreated',
    'StatusChanged',
    'ToolCalled',
    'ToolResult',
    'EvidenceCollected',
    'DiagnosisCreated',
    'ApprovalRequested',
    'ApprovalDecided',
    'ActionExecuted',
    'ToolFailed',
  ]),
  timestamp: instant,
  payload: z.record(z.string(), z.json()),
});
export type InvestigationEvent = z.infer<typeof eventSchema>;
export class InvestigationError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
export function fail(code: string): never {
  throw new InvestigationError(code);
}
export function boundedJson(value: unknown, bytes = 131072): string {
  const result = JSON.stringify(value);
  if (!result || Buffer.byteLength(result) > bytes) fail('payload_size_limit');
  return result;
}
export function validateReport(
  input: unknown,
  scope: {
    incident_id: string;
    service: string;
    environment: string;
    run_id: string;
    from: string;
    to: string;
  },
  observations: InvestigationEvidence[],
  knowledge: StoredKnowledge[],
): InvestigationReport {
  const report = reportSchema.parse(input),
    evidence = new Map(observations.map((e) => [e.evidence_id, e])),
    refs = new Map(knowledge.map((k) => [k.reference_id, k]));
  const citeEvidence = (list: string[]) =>
    list.forEach((id) => {
      const e = evidence.get(id);
      if (!e || e.incident_id !== scope.incident_id)
        fail('invalid_evidence_reference');
      const c = JSON.parse(e.content),
        from = Date.parse(c.window?.from),
        to = Date.parse(c.window?.to);
      if (
        c.run_id !== scope.run_id ||
        c.service !== scope.service ||
        c.environment !== scope.environment ||
        c.provider !== 'local_demo' ||
        c.kind !== e.source ||
        !Number.isFinite(from) ||
        !Number.isFinite(to) ||
        from >= to ||
        from < Date.parse(scope.from) ||
        to > Date.parse(scope.to) ||
        Date.parse(e.timestamp) < to
      )
        fail('evidence_scope_mismatch');
    });
  const citeKnowledge = (list: string[]) =>
    list.forEach((id) => {
      const k = refs.get(id);
      if (
        !k ||
        !knowledgeSchema.safeParse(k).success ||
        k.incident_id !== scope.incident_id ||
        k.run_id !== scope.run_id ||
        k.service !== scope.service ||
        k.environment !== scope.environment ||
        Date.parse(k.retrieved_at) < Date.parse(scope.from) ||
        Date.parse(k.retrieved_at) > Date.parse(scope.to)
      )
        fail('invalid_knowledge_reference');
    });
  for (const fact of report.facts) {
    citeEvidence([fact.evidence_id]);
    const e = evidence.get(fact.evidence_id)!;
    const c = JSON.parse(e.content);
    if (
      c.run_id !== scope.run_id ||
      c.service !== scope.service ||
      c.environment !== scope.environment ||
      c.provider !== 'local_demo' ||
      Date.parse(c.window.from) < Date.parse(scope.from) ||
      Date.parse(c.window.to) > Date.parse(scope.to)
    )
      fail('evidence_scope_mismatch');
    const item = c.items?.[fact.item_index];
    if (!item || item[fact.field] !== fact.value)
      fail('unverified_measurement');
    if (
      (e.source === 'metrics' &&
        ['message', 'wait_ms', 'level'].includes(fact.field)) ||
      (e.source === 'logs' &&
        !['message', 'wait_ms', 'level'].includes(fact.field))
    )
      fail('evidence_type_mismatch');
  }
  for (const h of report.hypotheses) {
    citeEvidence(h.evidence_ids);
    citeKnowledge(h.knowledge_reference_ids);
  }
  for (const h of report.handbook_suggestions)
    citeKnowledge(h.knowledge_reference_ids);
  for (const conflict of report.conflicts) citeEvidence(conflict.evidence_ids);
  if (report.diagnosis) {
    if (report.diagnosis.incident_id !== scope.incident_id)
      fail('diagnosis_incident_mismatch');
    citeEvidence(report.diagnosis.evidence_ids);
    if (!report.facts.length) fail('diagnosis_without_measurements');
  }
  for (const p of report.approval_proposals)
    if (p.target !== scope.service) fail('approval_target_mismatch');
  return report;
}
export function escalationReport(
  reason: string,
  evidence: InvestigationEvidence[],
): InvestigationReport {
  const facts: z.infer<typeof factSchema>[] = [];
  for (const e of evidence) {
    const data = JSON.parse(e.content);
    if (e.source === 'metrics' && data.items?.length) {
      const i = data.items.length - 1;
      for (const field of [
        'pool_capacity',
        'pool_waiting',
        'acquire_timeouts',
      ] as const)
        facts.push({
          evidence_id: e.evidence_id,
          item_index: i,
          field,
          value: data.items[i][field],
        });
    }
  }
  return reportSchema.parse({
    outcome: 'ESCALATED',
    diagnosis: null,
    facts,
    hypotheses: [],
    handbook_suggestions: [],
    conflicts: [],
    limitations: [reason],
    next_evidence_requests: [
      '补齐本次故障的因果证据；由有权限的人员审核观测、缺失来源和后续调查。',
    ],
    escalation_reason: reason,
    approval_proposals: [],
  });
}
