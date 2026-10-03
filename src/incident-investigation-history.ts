/** Historical database projection: no Provider, model, or Runbook imports. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { InvestigationStore } from './incident-investigation-store.js';
import { evaluateRecovery } from './incident-recovery-record.js';
import {
  fail,
  validateReport,
  reportCore,
} from './incident-investigation-types.js';

export function investigationHistory(
  store: InvestigationStore,
  incidentId: string,
  runId: string,
) {
  const view = store.detail(incidentId, runId),
    snapshot = store.snapshot(incidentId),
    run = view.run;
  if (view.report)
    validateReport(
      reportCore(view.report),
      {
        incident_id: incidentId,
        service: snapshot.service,
        environment: snapshot.environment,
        run_id: runId,
        from: run.from_at,
        to: run.to_at,
      },
      view.observed_evidence,
      view.knowledge_references,
    );
  if (view.report?.record_kind === 'recovery_verification') {
    const record = view.report.recovery_verification;
    if (!record || record.incident_final_status !== run.status)
      fail('invalid_recovery_history');
    const prior = store.detail(incidentId, record.baseline_run_id),
      baseline = prior.observed_evidence.find(
        (e) => e.evidence_id === record.baseline_evidence_id,
      );
    if (
      !baseline ||
      !prior.run.ended_at ||
      prior.run.ended_at > run.started_at ||
      baseline.source !== 'metrics' ||
      prior.run.source_id !== run.source_id ||
      prior.run.instance_id !== run.instance_id
    )
      fail('invalid_recovery_baseline');
    const recomputed = evaluateRecovery(
      record.manual_action,
      record.baseline_run_id,
      baseline,
      view.observed_evidence,
    );
    if (JSON.stringify(recomputed) !== JSON.stringify(record))
      fail('invalid_recovery_history');
  }
  const collected = view.events
    .filter((e) => e.event_type === 'EvidenceCollected')
    .map((e) => e.payload.evidence_id);
  if (
    collected.some(
      (id) => !view.observed_evidence.some((e) => e.evidence_id === id),
    )
  )
    fail('history_missing_evidence');
  return view;
}
/** Export only to a host-selected private directory; original Python Replay consumes it. */
export function exportInvestigationReplay(
  store: InvestigationStore,
  incidentId: string,
  runId: string,
  directory: string,
): string {
  const view = investigationHistory(store, incidentId, runId);
  if (!view.events.length) fail('history_has_no_events');
  fs.mkdirSync(directory, { recursive: true });
  const target = path.join(directory, `${incidentId}.jsonl`),
    tmp = path.join(directory, `.${randomUUID()}.tmp`);
  if (fs.existsSync(target)) fail('history_export_exists');
  fs.writeFileSync(
    tmp,
    view.events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    { flag: 'wx', mode: 0o600 },
  );
  try {
    // Exclusive publication: a concurrent export cannot replace existing history.
    fs.linkSync(tmp, target);
  } finally {
    fs.unlinkSync(tmp);
  }
  return target;
}
