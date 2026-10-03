export interface LiveRun {
  run_id: string;
  status: string;
  attempt: number;
  started_at: number;
  ended_at: number | null;
  deadline_at: number;
  from_at: string;
  to_at: string;
  source_id: string | null;
  instance_id: string | null;
  mode: string;
  error_code: string | null;
  tool_calls: number;
  model_requests: number;
  search_calls: number;
}
export interface LiveJob {
  job_id: string;
  state: string;
  generation: number;
  attempt: number;
  next_at: number;
  lease_expires_at: number | null;
  error_code: string | null;
  input_revision: number;
  pending_revision: number;
  runs?: LiveRun[];
}
export interface LiveIncident {
  incident_id: string;
  service: string;
  environment: string;
  source: string;
  alert: string;
  severity: string | null;
  unknown_severity_count: number;
  alert_status: string;
  started_at: string;
  last_received_at: string;
  first_received_at: string;
  last_started_at?: string;
  window_end: string;
  fingerprint?: string;
  aggregation_key: string;
  alert_count: number;
  delivery_count: number;
  source_mode: string;
  job: LiveJob | null;
  latest_run: LiveRun | null;
  observation_count: number;
}
export interface Paged<T> {
  items: T[];
  offset: number;
  limit: number;
  total?: number;
  has_more: boolean;
}
export interface LiveDetail {
  incident: { incident_id: string; service: string; alert: string };
  metadata: LiveIncident;
  source_mode: string;
  job: LiveJob | null;
  latest_run: LiveRun | null;
  observation_count: number;
  jobs: LiveJob[];
  alerts: Paged<{
    occurrence_id: string;
    source: string;
    external_id: string;
    severity: string | null;
    severity_raw: string;
    severity_mapping_status: string;
    fingerprint: string;
    status: string;
    starts_at: string;
    ends_at: string | null;
    source_summary: { summary: string; description: string };
  }>;
}
export interface Measurement {
  evidence_id: string;
  item_index: number;
  field: string;
  value: number | string;
}
export interface LiveReport {
  recovery_verification?: {
    manual_action: {
      kind: string;
      performed_at: string;
      reported_result: string;
      restored_capacity: number;
    };
    baseline_run_id: string;
    baseline_evidence_id: string;
    observation_refs: string[];
    result: 'verified' | 'not_recovered' | 'inconclusive';
    incident_final_status: string;
    checks: Array<{ name: string; status: string; detail: string }>;
  };
  outcome: string;
  origin: string;
  diagnosis: {
    root_cause: string;
    confidence: number;
    evidence_ids: string[];
    recommendation: string;
  } | null;
  facts: Measurement[];
  hypotheses: Array<{
    hypothesis: string;
    evidence_ids: string[];
    knowledge_reference_ids: string[];
  }>;
  handbook_suggestions: Array<{
    suggestion: string;
    knowledge_reference_ids: string[];
  }>;
  conflicts: Array<{ description: string; evidence_ids: string[] }>;
  limitations: string[];
  next_evidence_requests: string[];
  escalation_reason: string | null;
  execution_authorized: false;
}
export interface LiveEvent {
  payload_truncated?: boolean;
  event_id: string;
  event_type: string;
  timestamp: string;
  payload: Record<string, unknown>;
}
export interface Observation {
  evidence_id: string;
  source: string;
  timestamp: string;
  correlation_id: string;
  observation: {
    provider: string;
    source_id: string;
    service: string;
    environment: string;
    observed_at: string;
    window: { from: string; to: string };
    status: string;
    items: unknown[];
    truncated: boolean;
    retention_dropped: number;
  };
}
export interface Knowledge {
  reference_id: string;
  doc_id: string;
  section: string;
  version: string;
  version_hash: string;
  snippet: string;
  start_line: number;
  end_line: number;
  start_offset: number;
  end_offset: number;
  retrieved_at: string;
  rank: number;
  query: string;
}
export interface Section<T> extends Paged<T> {
  run: LiveRun;
  report: LiveReport | null;
  readonly: true;
  scope: { service: string; environment: string; impact: string };
  empty_reason: string | null;
}
export const taskStates: Record<string, { label: string; tone: string }> = {
  queued: { label: '排队中', tone: 'neutral' },
  running: { label: '执行中', tone: 'blue' },
  retry_wait: { label: '等待重试', tone: 'amber' },
  blocked: { label: '待补齐接入 / 模型', tone: 'orange' },
  completed: { label: '调查完成', tone: 'green' },
  manual: { label: '需人工处理', tone: 'orange' },
  failed: { label: '最终失败', tone: 'red' },
};
export const sourceLabels: Record<string, string> = {
  local_demo_observed: '本地受控服务实时观测',
  local_demo_unavailable: '本地受控服务 · 暂无有效观测',
  unbound: '未接入数据源 · 尚未绑定',
};
export const reasonLabels: Record<string, string> = {
  no_configured_model: '未配置本次调查模型',
  live_source_not_configured: '现场数据源未绑定',
  model_timeout: '模型请求超时',
  model_budget: '模型调用预算耗尽',
  tool_budget: '工具调用预算耗尽',
  wall_budget: '调查墙钟预算耗尽',
  lease_expired: 'Worker 租约已过期',
  critical_evidence_unavailable: '关键数据源不可用',
  partial_evidence_failure: '部分取证失败',
  conflicting_evidence: '证据存在显式冲突',
  invalid_model_report: '模型报告未通过引用或结构校验',
};
