/** Trusted host entry point. Only re-queries observations; never restores or executes. */
import { randomUUID } from 'node:crypto';
import { InvestigationStore } from './incident-investigation-store.js';
import { fail, escalationReport } from './incident-investigation-types.js';
import {
  pythonIncidentLifecycle,
  type HostIncidentSource,
} from './incident-investigation-worker.js';
import {
  manualRecoverySchema,
  evaluateRecovery,
  type ManualRecovery,
} from './incident-recovery-record.js';
import { investigationHistory } from './incident-investigation-history.js';

export async function verifyIncidentRecovery(
  store: InvestigationStore,
  options: {
    repo_root: string;
    incident_id: string;
    baseline_run_id: string;
    baseline_evidence_id: string;
    manual_action: ManualRecovery;
    source: HostIncidentSource;
    timeout_ms?: number;
  },
) {
  const action = manualRecoverySchema.parse(options.manual_action),
    snapshot = store.snapshot(options.incident_id),
    source = options.source,
    baselineRun = store.detail(snapshot.incident_id, options.baseline_run_id),
    baseline = baselineRun.observed_evidence.find(
      (e) => e.evidence_id === options.baseline_evidence_id,
    );
  if (
    !baseline ||
    baseline.source !== 'metrics' ||
    !baselineRun.run.ended_at ||
    source.source_scope !== snapshot.source_scope ||
    source.service !== snapshot.service ||
    source.environment !== snapshot.environment ||
    source.source_id !== baselineRun.run.source_id ||
    source.instance_id !== baselineRun.run.instance_id ||
    Date.parse(action.performed_at) > Date.now()
  )
    fail('recovery_scope_denied');
  // Preserve the two existing compilation roots; load only their built read-tool modules.
  const { LocalDemoProvider } = await import(
      new URL(
        '../container/agent-runner/dist/incident-live-provider.js',
        import.meta.url,
      ).href
    ),
    { IncidentApprovalGate } = await import(
      new URL(
        '../container/agent-runner/dist/incident-approval-gate.js',
        import.meta.url,
      ).href
    ),
    { InMemoryIncidentEvents } = await import(
      new URL(
        '../container/agent-runner/dist/incident-agent-events.js',
        import.meta.url,
      ).href
    ),
    { createIncidentProviderTools } = await import(
      new URL(
        '../container/agent-runner/dist/incident-provider-tools.js',
        import.meta.url,
      ).href
    );
  // Check the complete persisted history under the same lock as enqueue/claim.
  // Idempotency does not depend on the Console's twenty-generation display limit.
  const reservation = store.db
    .transaction(() => {
      const existing = store.db
        .prepare(
          `SELECT r.run_id FROM incident_investigation_runs r
      JOIN incident_investigation_jobs j ON j.job_id=r.job_id WHERE j.incident_id=?
      AND json_extract(r.report_json,'$.record_kind')='recovery_verification'
      AND json_extract(r.report_json,'$.recovery_verification.baseline_evidence_id')=?
      AND json_extract(r.report_json,'$.recovery_verification.manual_action.performed_at')=? LIMIT 1`,
        )
        .get(
          snapshot.incident_id,
          baseline.evidence_id,
          action.performed_at,
        ) as { run_id: string } | undefined;
      if (existing) {
        const record = investigationHistory(
          store,
          snapshot.incident_id,
          existing.run_id,
        ).report.recovery_verification;
        if (JSON.stringify(record.manual_action) !== JSON.stringify(action))
          fail('recovery_request_conflict');
        return { previous: { run_id: existing.run_id, record, reused: true } };
      }
      if (
        store
          .list(snapshot.incident_id)
          .some((j) => ['queued', 'running', 'retry_wait'].includes(j.state))
      )
        fail('recovery_task_active');
      store.enqueue(snapshot.incident_id, true);
      const claimed = store.claim(`recovery-${randomUUID()}`, {
        incident_id: snapshot.incident_id,
        wall_ms: 30000,
        lease_ms: 30000,
      });
      if (!claimed) fail('recovery_task_active');
      store.markRecoveryTask(claimed);
      return { lease: claimed };
    })
    .immediate();
  if (reservation.previous) return reservation.previous;
  const lease = reservation.lease!;
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 20000);
  const incident = {
    incident_id: snapshot.incident_id,
    service: snapshot.service,
    alert: snapshot.alert,
    started_at: snapshot.started_at,
  };
  try {
    store.bindSource(lease, source, 'host_no_model');
    const start = await pythonIncidentLifecycle(options.repo_root, {
      action: 'start',
      incident,
    });
    for (const event of start.events) store.append(lease, event);
    const run = store.run(lease.run_id),
      provider = new LocalDemoProvider(
        [
          {
            source_id: source.source_id,
            base_url: source.base_url,
            service: source.service,
            environment: source.environment,
            read_token: source.read_token,
            instance_id: source.instance_id,
            timeout_ms: options.timeout_ms ?? 1500,
          },
        ],
        [
          {
            incident_id: snapshot.incident_id,
            source_id: source.source_id,
            service: source.service,
            environment: source.environment,
            allowed_from: run.from_at,
            allowed_to: run.to_at,
          },
        ],
        lease.run_id,
      ),
      events = new (class extends InMemoryIncidentEvents {
        request: Record<string, unknown> = {};
        emit(id: string, type: string, payload: Record<string, unknown>) {
          return super.emit(id, type, {
            ...payload,
            ...(type === 'ToolCalled'
              ? { request: this.request, origin: 'host_recovery_read_probe' }
              : {}),
          });
        }
      })(),
      gate = new IncidentApprovalGate({ events }),
      tools = createIncidentProviderTools(
        { mode: 'live', provider },
        gate,
        (r: any) => {
          const text = r.content.find((c: any) => c.type === 'text');
          return text ? { tool_output: JSON.parse(text.text) } : {};
        },
      );
    let saved = 0;
    // Shared window excludes fault logs; the two queries retain their own observation/correlation IDs.
    const to = new Date().toISOString();
    for (const name of ['query_live_metrics', 'query_live_logs']) {
      store.assertLease(lease);
      const callId = randomUUID();
      store.reserveTool(lease, name, Date.now(), callId);
      const tool = tools.find((t: any) => t.name === name)!;
      events.request = {
        incident_id: snapshot.incident_id,
        from: action.performed_at,
        to,
        limit: 200,
      };
      await tool.handler(events.request, {
        signal: controller.signal,
        toolCallId: callId,
      });
      for (const event of gate.events.snapshot().slice(saved)) {
        store.append(lease, event);
        saved++;
      }
    }
    const observations = store.evidence(lease.run_id),
      record = evaluateRecovery(
        action,
        options.baseline_run_id,
        baseline,
        observations,
      ),
      reason = `recovery_${record.result}`,
      core = escalationReport(reason, observations);
    core.limitations.push(
      '恢复效果仅验证本地演示服务的有界观测，调查仍待人工复核，不自动 RESOLVED。',
    );
    const finish = await pythonIncidentLifecycle(options.repo_root, {
      action: 'escalate',
      incident,
      events: store.events(lease.run_id),
      evidence: observations,
    });
    for (const event of finish.events) store.append(lease, event);
    store.finish(
      lease,
      'manual',
      {
        ...core,
        origin: 'host_no_model',
        record_kind: 'recovery_verification',
        recovery_verification: record,
        reference_checks: 'passed',
        semantic_proof: false,
        execution_authorized: false,
        budget: {
          tool_calls: store.run(lease.run_id).tool_calls,
          model_http_reservations: 0,
        },
      },
      reason,
    );
    return { run_id: lease.run_id, record, reused: false };
  } catch (error) {
    try {
      store.retry(lease, 'recovery_verification_failed');
    } catch {
      store.reap();
    }
    throw error;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
