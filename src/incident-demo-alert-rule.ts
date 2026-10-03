/** Explicit local monitoring rule; no model, fixture answers or production adapter. */
import { scopeName } from './incident-alert-types.js';

export const POOL_ALERT_RULE = Object.freeze({
  min_new_timeouts: 2,
  min_peak_waiting: 1,
});
export async function poolThresholdAlert(
  input: unknown,
  previous: unknown,
  source: string,
) {
  const { localDemoMetricsSchema } = await import(
    new URL(
      '../container/agent-runner/dist/incident-live-provider.js',
      import.meta.url,
    ).href
  );
  const current = localDemoMetricsSchema.parse(input),
    baseline = localDemoMetricsSchema.parse(previous);
  scopeName.parse(source);
  const validWindow = (value: any) => {
    const from = Date.parse(value.window.from),
      to = Date.parse(value.window.to);
    let previousTime = from;
    return (
      from < to &&
      to <= Date.parse(value.observed_at) &&
      (value.status === 'empty') === (value.items.length === 0) &&
      value.items.every((item: any) => {
        const time = Date.parse(item.observed_at),
          valid = time >= previousTime && time <= to;
        previousTime = time;
        return valid;
      })
    );
  };
  if (
    current.source_id !== baseline.source_id ||
    current.instance_id !== baseline.instance_id ||
    current.service !== baseline.service ||
    current.environment !== baseline.environment ||
    Date.parse(current.window.from) !== Date.parse(baseline.window.to) ||
    current.truncated ||
    current.retention_dropped ||
    baseline.truncated ||
    baseline.retention_dropped ||
    !validWindow(current) ||
    !validWindow(baseline) ||
    baseline.status !== 'success' ||
    !baseline.items.length ||
    current.status === 'empty' ||
    !current.items.length
  )
    return { status: 'insufficient_observations' as const, alert: null };
  const base = baseline.items.at(-1)!,
    last = current.items.at(-1)!,
    timeouts = last.acquire_timeouts - base.acquire_timeouts,
    peak = Math.max(
      ...current.items.map((i: { pool_waiting: number }) => i.pool_waiting),
    );
  if (timeouts < 0)
    return { status: 'insufficient_observations' as const, alert: null };
  if (
    timeouts < POOL_ALERT_RULE.min_new_timeouts ||
    peak < POOL_ALERT_RULE.min_peak_waiting
  )
    return { status: 'below_threshold' as const, alert: null };
  const starts_at = current.items.find(
    (i: { pool_waiting: number }) =>
      i.pool_waiting >= POOL_ALERT_RULE.min_peak_waiting,
  )!.observed_at;
  return {
    status: 'firing' as const,
    alert: {
      source,
      external_id: `${current.instance_id}:${starts_at}`,
      service: current.service,
      environment: current.environment,
      severity: 'critical',
      alert_type: 'PROBLEM',
      fingerprint: 'resource-pool-acquisition',
      starts_at,
      status: 'firing',
      summary: `Local demo pool threshold: new acquire_timeouts=${timeouts}, peak pool_waiting=${peak}`,
      description: `Rule: new timeouts >= ${POOL_ALERT_RULE.min_new_timeouts} AND peak waiting >= ${POOL_ALERT_RULE.min_peak_waiting}; action risk is evaluated separately.`,
    },
  };
}
