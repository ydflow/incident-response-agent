/** Pure historical verification. No source, control, model or Runbook access. */
import { z } from 'zod';
import type { InvestigationEvidence as Evidence } from './incident-investigation-types.js';

export const manualRecoverySchema = z.strictObject({
  kind: z.literal('manual_demo_restore'),
  performed_at: z.iso.datetime({ offset: true }),
  reported_result: z.enum(['applied', 'not_applied']),
  restored_capacity: z.number().int().min(1).max(32),
});
export type ManualRecovery = z.infer<typeof manualRecoverySchema>;
export const RECOVERY_CRITERIA = Object.freeze({
  min_successful_requests: 4,
  min_observation_ms: 100,
  max_baseline_age_ms: 120000,
  max_new_timeouts: 0,
  max_final_waiting: 0,
});
export type RecoveryCheck = {
  name: string;
  status: 'passed' | 'failed' | 'unknown';
  detail: string;
};
export type RecoveryRecord = {
  version: 1;
  manual_action: ManualRecovery;
  baseline_run_id: string;
  baseline_evidence_id: string;
  observation_refs: string[];
  criteria: typeof RECOVERY_CRITERIA;
  checks: RecoveryCheck[];
  result: 'verified' | 'not_recovered' | 'inconclusive';
  incident_final_status: 'ESCALATED';
  execution_authorized: false;
};

/** A passed bounded observation is never an automatic RESOLVED transition. */
export function evaluateRecovery(
  action: ManualRecovery,
  baselineRun: string,
  baseline: Evidence,
  observations: Evidence[],
): RecoveryRecord {
  const manual = manualRecoverySchema.parse(action),
    before = JSON.parse(baseline.content),
    metric = observations.find((e) => e.source === 'metrics'),
    log = observations.find((e) => e.source === 'logs'),
    metrics = metric ? JSON.parse(metric.content) : null,
    logs = log ? JSON.parse(log.content) : null,
    checks: RecoveryCheck[] = [];
  const check = (name: string, state: boolean | null, detail: string) =>
    checks.push({
      name,
      status: state === null ? 'unknown' : state ? 'passed' : 'failed',
      detail,
    });
  const at = Date.parse(manual.performed_at),
    base = before.items?.at(-1),
    last = metrics?.items?.at(-1);
  const baselineValid =
    before.kind === 'metrics' &&
    before.status === 'success' &&
    base &&
    Date.parse(base.observed_at) <= at &&
    at - Date.parse(base.observed_at) <=
      RECOVERY_CRITERIA.max_baseline_age_ms &&
    Date.parse(before.observed_at) <= at &&
    base.acquire_timeouts >= 2;
  check(
    'manual_declaration',
    manual.reported_result === 'applied',
    '仅记录宿主的人工操作声明，不是 Agent 执行动作或授权。',
  );
  check(
    'recent_fault_baseline',
    baselineValid ? true : null,
    '基线必须是恢复前两分钟内实际故障指标，累计超时至少 2。',
  );
  const complete = (c: any, kind: string) =>
    c &&
    c.kind === kind &&
    c.status === 'success' &&
    c.items.length > 0 &&
    c.provider === 'local_demo' &&
    c.instance_id === before.instance_id &&
    c.source_id === before.source_id &&
    c.service === before.service &&
    c.environment === before.environment &&
    Date.parse(c.window.from) === at &&
    Date.parse(c.window.to) - at >= RECOVERY_CRITERIA.min_observation_ms &&
    !c.truncated &&
    c.retention_dropped === 0 &&
    c.items.every((i: any) => Date.parse(i.timestamp ?? i.observed_at) >= at);
  const metricComplete = !!complete(metrics, 'metrics'),
    logComplete = !!complete(logs, 'logs');
  check(
    'complete_new_metrics',
    metricComplete ? true : null,
    '需同实例、同范围、恢复后非空且未截断的指标窗口。',
  );
  check(
    'complete_new_logs',
    logComplete ? true : null,
    '需恢复后非空且未截断的实际请求日志；空查询不等于恢复。',
  );
  const counters = [
    'requests_success',
    'acquire_timeouts',
    'requests_cancelled',
    'queue_overflows',
  ] as const;
  const comparable =
    baselineValid &&
    metricComplete &&
    counters.every(
      (key) => Number.isInteger(last[key]) && last[key] >= base[key],
    );
  check(
    'monotonic_same_instance_counters',
    comparable ? true : null,
    '实例重启、计数倒退或缺失基线不能作恢复差量。',
  );
  if (comparable) {
    const successes = last.requests_success - base.requests_success,
      timeouts = last.acquire_timeouts - base.acquire_timeouts,
      cancelled = last.requests_cancelled - base.requests_cancelled,
      overflow = last.queue_overflows - base.queue_overflows;
    check(
      'successful_probe_traffic',
      successes >= RECOVERY_CRITERIA.min_successful_requests,
      `实际成功请求增量 ${successes}，要求至少 4。`,
    );
    check(
      'no_new_resource_failures',
      timeouts === 0 && cancelled === 0 && overflow === 0,
      `新增超时 ${timeouts}、取消 ${cancelled}、溢出 ${overflow}。`,
    );
    check(
      'final_pool_recovered',
      last.pool_waiting === 0 &&
        last.pool_active === 0 &&
        last.pool_capacity === manual.restored_capacity,
      `最终 waiting=${last.pool_waiting}, active=${last.pool_active}, capacity=${last.pool_capacity}。`,
    );
  }
  if (logComplete) {
    const successful = logs.items.filter(
        (i: any) => i.message === 'request_complete',
      ).length,
      failed = logs.items.filter((i: any) =>
        ['pool_timeout', 'queue_overflow', 'request_cancelled'].includes(
          i.message,
        ),
      ).length;
    check(
      'successful_request_logs',
      successful >= RECOVERY_CRITERIA.min_successful_requests,
      `实际完成日志 ${successful}，要求至少 4。`,
    );
    check('no_failure_logs', failed === 0, `恢复窗口资源失败日志 ${failed}。`);
  }
  const result = checks.some((c) => c.status === 'unknown')
    ? 'inconclusive'
    : checks.some((c) => c.status === 'failed')
      ? 'not_recovered'
      : 'verified';
  return {
    version: 1,
    manual_action: manual,
    baseline_run_id: baselineRun,
    baseline_evidence_id: baseline.evidence_id,
    observation_refs: observations.map((e) => e.evidence_id),
    criteria: RECOVERY_CRITERIA,
    checks,
    result,
    incident_final_status: 'ESCALATED',
    execution_authorized: false,
  };
}
