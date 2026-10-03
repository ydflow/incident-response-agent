import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect, test } from 'vitest';
import { investigationDb } from './helpers/incident-investigation-db.js';
import {
  startLocalIncidentDemo,
  runLocalDemoLoad,
} from '../src/incident-local-demo.js';
import { IncidentInvestigationWorker } from '../src/incident-investigation-worker.js';
import { sourceScope } from '../src/incident-alert-types.js';
import { verifyIncidentRecovery } from '../src/incident-recovery-verification.js';
import { investigationHistory } from '../src/incident-investigation-history.js';
import { evaluateRecovery } from '../src/incident-recovery-record.js';
import { poolThresholdAlert } from '../src/incident-demo-alert-rule.js';
import { IncidentConsoleLive } from '../src/incident-console-live.js';

test.each([
  'healthy',
  'below_threshold',
  'empty',
  'unavailable',
  'timeout',
] as const)(
  'actual read-only recovery verification: %s',
  async (mode) => {
    const f = investigationDb(),
      read = randomBytes(32).toString('hex'),
      control = randomBytes(32).toString('hex'),
      demo = await startLocalIncidentDemo({
        source_id: 'recovery-pool',
        service: 'orders',
        environment: 'local',
        read_token: read,
        control_token: control,
        sample_interval_ms: 20,
      });
    let closed = false;
    const configure = async (capacity: number, query_delay_ms = 0) => {
      const r = await fetch(`${demo.base_url}/control/config`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${control}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          capacity,
          hold_ms: capacity === 1 ? 180 : 20,
          acquire_timeout_ms: capacity === 1 ? 30 : 500,
          query_delay_ms,
        }),
      });
      expect(r.status).toBe(200);
      await r.body?.cancel();
    };
    try {
      await configure(1);
      const load = await runLocalDemoLoad(demo.base_url, read, 8, 8);
      expect(load.resource_failures).toBeGreaterThanOrEqual(2);
      const id = f.send().items[0].incident_id,
        source = {
          source_scope: sourceScope('owner', 'step5-demo'),
          source_id: 'recovery-pool',
          service: 'orders',
          environment: 'local',
          base_url: demo.base_url,
          read_token: read,
          instance_id: demo.instance_id,
        },
        baseline = (await new IncidentInvestigationWorker(f.store, {
          repo_root: path.resolve('.'),
          incident_id: id,
          sources: [source],
          wall_ms: 30000,
        }).tick())!;
      const old = JSON.stringify(f.store.detail(id, baseline.run_id)),
        metrics = f.store
          .evidence(baseline.run_id)
          .find((e) => e.source === 'metrics')!;
      await configure(
        mode === 'below_threshold' ? 1 : 4,
        mode === 'timeout' ? 200 : 0,
      );
      const action = {
        kind: 'manual_demo_restore' as const,
        performed_at: new Date().toISOString(),
        reported_result: 'applied' as const,
        restored_capacity: 4,
      };
      if (mode === 'unavailable') {
        await demo.close();
        closed = true;
      } else if (mode !== 'empty')
        await runLocalDemoLoad(demo.base_url, read, 8, 8);
      await new Promise((r) => setTimeout(r, 120));
      const options = {
          repo_root: path.resolve('.'),
          incident_id: id,
          baseline_run_id: baseline.run_id,
          baseline_evidence_id: metrics.evidence_id,
          manual_action: action,
          source,
          timeout_ms: mode === 'timeout' ? 30 : 1500,
        },
        concurrent =
          mode === 'healthy'
            ? await Promise.allSettled([
                verifyIncidentRecovery(f.store, options),
                verifyIncidentRecovery(f.store, options),
              ])
            : null;
      if (concurrent) {
        expect(concurrent.filter((r) => r.status === 'fulfilled')).toHaveLength(
          1,
        );
        expect(concurrent.find((r) => r.status === 'rejected')).toMatchObject({
          reason: new Error('recovery_task_active'),
        });
      }
      const result = concurrent
          ? (
              concurrent.find(
                (r) => r.status === 'fulfilled',
              ) as PromiseFulfilledResult<
                Awaited<ReturnType<typeof verifyIncidentRecovery>>
              >
            ).value
          : await verifyIncidentRecovery(f.store, options),
        view = investigationHistory(f.store, id, result.run_id);
      const projection = new IncidentConsoleLive(f.alerts, f.store).section(
        { all: true, grants: [] },
        id,
        result.run_id,
        { section: 'report', offset: 0, limit: 10 },
      ) as any;
      expect(projection.report.recovery_verification.result).toBe(
        result.record.result,
      );
      expect(
        projection.report.recovery_verification.incident_final_status,
      ).toBe('ESCALATED');
      expect(result.record.result, JSON.stringify(result.record.checks)).toBe(
        mode === 'healthy'
          ? 'verified'
          : mode === 'below_threshold'
            ? 'not_recovered'
            : 'inconclusive',
      );
      expect(view.run.status).toBe('ESCALATED');
      expect(view.run.model_requests).toBe(0);
      expect(view.run.tool_calls).toBe(2);
      expect(
        view.events.filter((e) => e.event_type === 'ToolCalled'),
      ).toHaveLength(2);
      expect(view.events.some((e) => e.event_type === 'ActionExecuted')).toBe(
        false,
      );
      expect(JSON.stringify(f.store.detail(id, baseline.run_id))).toBe(old);
      if (mode === 'timeout' || mode === 'unavailable') {
        expect(view.observed_evidence).toHaveLength(0);
        const errors = view.events
          .filter((e) => e.event_type === 'ToolResult')
          .map((e) => (e.payload.tool_output as any).error);
        expect(errors).toEqual(
          mode === 'timeout'
            ? ['timeout', 'timeout']
            : ['unavailable', 'unavailable'],
        );
      } else {
        expect(view.observed_evidence).toHaveLength(2);
        if (mode === 'empty')
          expect(
            JSON.parse(
              view.observed_evidence.find((e) => e.source === 'logs')!.content,
            ).status,
          ).toBe('empty');
      }
      const count = f.store.list(id).length;
      const again = await verifyIncidentRecovery(f.store, options);
      expect(again.reused).toBe(true);
      expect(again.run_id).toBe(result.run_id);
      expect(f.store.list(id)).toHaveLength(count);
      await expect(
        verifyIncidentRecovery(f.store, {
          ...options,
          manual_action: { ...action, restored_capacity: 3 },
        }),
      ).rejects.toThrow('recovery_request_conflict');
      await expect(
        verifyIncidentRecovery(f.store, {
          ...options,
          source: { ...source, environment: 'other' },
        }),
      ).rejects.toThrow('recovery_scope_denied');
      if (mode === 'healthy') {
        const observations = view.observed_evidence;
        expect(
          evaluateRecovery(
            { ...action, reported_result: 'not_applied' },
            baseline.run_id,
            metrics,
            observations,
          ).result,
        ).toBe('not_recovered');
        expect(
          evaluateRecovery(action, baseline.run_id, metrics, []).result,
        ).toBe('inconclusive');
        const foreign = structuredClone(observations),
          content = JSON.parse(foreign[0].content);
        content.environment = 'other';
        foreign[0].content = JSON.stringify(content);
        expect(
          evaluateRecovery(action, baseline.run_id, metrics, foreign).result,
        ).toBe('inconclusive');
        const expired = structuredClone(metrics),
          c = JSON.parse(expired.content);
        c.items.at(-1).observed_at = new Date(
          Date.parse(action.performed_at) - 121000,
        ).toISOString();
        expired.content = JSON.stringify(c);
        expect(
          evaluateRecovery(action, baseline.run_id, expired, observations)
            .result,
        ).toBe('inconclusive');
        const truncated = structuredClone(observations),
          p = JSON.parse(truncated[0].content);
        p.truncated = true;
        truncated[0].content = JSON.stringify(p);
        expect(
          evaluateRecovery(action, baseline.run_id, metrics, truncated).result,
        ).toBe('inconclusive');
        f.db
          .prepare(
            'UPDATE incident_investigation_runs SET report_json=? WHERE run_id=?',
          )
          .run(
            JSON.stringify({
              ...view.report,
              recovery_verification: {
                ...result.record,
                result: 'not_recovered',
              },
            }),
            result.run_id,
          );
        expect(() => investigationHistory(f.store, id, result.run_id)).toThrow(
          'invalid_recovery_history',
        );
      }
    } finally {
      if (!closed) await demo.close();
      f.db.close();
    }
  },
  30000,
);

test('strict threshold monitoring uses actual waiting and timeout deltas, never a canned alert', async () => {
  const read = randomBytes(32).toString('hex'),
    control = randomBytes(32).toString('hex'),
    demo = await startLocalIncidentDemo({
      source_id: 'threshold-pool',
      service: 'orders',
      environment: 'local',
      read_token: read,
      control_token: control,
      sample_interval_ms: 20,
    });
  const query = async (from: string, to: string) => {
    const q = new URLSearchParams({
      source_id: 'threshold-pool',
      service: 'orders',
      environment: 'local',
      query_id: randomUUID(),
      from,
      to,
      limit: '200',
    });
    const r = await fetch(`${demo.base_url}/observations/metrics?${q}`, {
      headers: { authorization: `Bearer ${read}` },
    });
    expect(r.status).toBe(200);
    return r.json();
  };
  try {
    await new Promise((r) => setTimeout(r, 40));
    const start = new Date(Date.now() - 1000).toISOString(),
      boundary = new Date().toISOString(),
      baseline = await query(start, boundary);
    await runLocalDemoLoad(demo.base_url, read, 4, 4);
    await new Promise((r) => setTimeout(r, 30));
    expect(
      (
        await poolThresholdAlert(
          await query(boundary, new Date().toISOString()),
          baseline,
          'step7-demo',
        )
      ).status,
    ).toBe('below_threshold');
    const config = await fetch(`${demo.base_url}/control/config`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${control}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        capacity: 1,
        hold_ms: 180,
        acquire_timeout_ms: 30,
        query_delay_ms: 0,
      }),
    });
    await config.body?.cancel();
    await runLocalDemoLoad(demo.base_url, read, 8, 8);
    await new Promise((r) => setTimeout(r, 30));
    const current: any = await query(boundary, new Date().toISOString()),
      fired = await poolThresholdAlert(current, baseline, 'step7-demo');
    expect(fired.status).toBe('firing');
    expect(fired.alert?.environment).toBe('local');
    expect(fired.alert?.summary).toContain('new acquire_timeouts=');
    expect(
      (
        await poolThresholdAlert(
          { ...current, environment: 'other' },
          baseline,
          'step7-demo',
        )
      ).status,
    ).toBe('insufficient_observations');
    expect(
      (
        await poolThresholdAlert(
          { ...current, truncated: true },
          baseline,
          'step7-demo',
        )
      ).alert,
    ).toBeNull();
    const wrongTime = structuredClone(current);
    wrongTime.items[0].observed_at = new Date(
      Date.parse(current.window.from) - 1000,
    ).toISOString();
    expect(
      (await poolThresholdAlert(wrongTime, baseline, 'step7-demo')).alert,
    ).toBeNull();
    await expect(
      poolThresholdAlert({ ...current, kind: 'logs' }, baseline, 'step7-demo'),
    ).rejects.toThrow();
  } finally {
    await demo.close();
  }
});
