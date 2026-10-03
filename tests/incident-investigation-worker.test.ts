import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { expect, test } from 'vitest';
import { investigationDb } from './helpers/incident-investigation-db.js';
import { incidentProtocolStub } from './helpers/incident-model-protocol-stub.js';
import { sourceScope } from '../src/incident-alert-types.js';
import {
  startLocalIncidentDemo,
  runLocalDemoLoad,
} from '../src/incident-local-demo.js';
import { IncidentInvestigationWorker } from '../src/incident-investigation-worker.js';
import { investigationHistory } from '../src/incident-investigation-history.js';

test.each([
  'diagnose',
  'conflict',
  'partial',
  'loop',
  'invalid',
  'bad_report',
] as const)(
  'actual restricted Pi transport with transparent protocol stub: %s',
  async (mode) => {
    const f = investigationDb(),
      stub = await incidentProtocolStub(mode),
      read = randomBytes(32).toString('hex'),
      control = randomBytes(32).toString('hex');
    const demo = await startLocalIncidentDemo({
      source_id: 'test-pool',
      service: 'orders',
      environment: 'local',
      read_token: read,
      control_token: control,
      sample_interval_ms: 20,
    });
    try {
      await runLocalDemoLoad(demo.base_url, read, 2, 2);
      const id = f.send().items[0].incident_id;
      const result = await new IncidentInvestigationWorker(f.store, {
        repo_root: path.resolve('.'),
        incident_id: id,
        model: stub.config,
        max_model_requests: 2,
        wall_ms: 20000,
        sources: [
          {
            source_scope: sourceScope('owner', 'step5-demo'),
            source_id: 'test-pool',
            service: 'orders',
            environment: 'local',
            base_url: demo.base_url,
            read_token: read,
            instance_id: demo.instance_id,
          },
        ],
      }).tick();
      expect(result).not.toBeNull();
      const view = f.store.detail(id, result!.run_id);
      expect(
        stub.requests(),
        JSON.stringify({
          state: result!.state,
          reason: result!.reason,
          events: view.events.map((e) => ({
            type: e.event_type,
            tool: e.payload.tool,
            status: e.payload.status,
          })),
        }),
      ).toBe(2);
      expect(view.run.model_requests).toBe(2);
      expect(view.run.mode).toBe('protocol_stub');
      expect(view.runtime_tool_attempts.length).toBeGreaterThan(0);
      if (mode === 'invalid') {
        expect(
          view.runtime_tool_attempts.some((e: any) => e.is_error === true),
        ).toBe(true);
        expect(view.run.tool_calls).toBe(4);
      }
      expect(view.observed_evidence.length).toBeGreaterThanOrEqual(2);
      expect(view.knowledge_references.length).toBeGreaterThan(0);
      if (mode !== 'invalid')
        expect(
          view.events.some(
            (e) =>
              e.event_type === 'ToolCalled' &&
              e.payload.origin === 'pi_model_tool_call',
          ),
        ).toBe(true);
      expect(view.report.execution_authorized).toBe(false);
      if (mode === 'diagnose') {
        expect(result!.state).toBe('completed');
        expect(view.run.status).toBe('DIAGNOSED');
        expect(view.observed_evidence).toHaveLength(3);
        expect(view.report.facts[0].value).toBe(
          JSON.parse(view.observed_evidence[0].content).items.at(-1)
            .acquire_timeouts,
        );
      } else {
        expect(result!.state).toBe('manual');
        expect(view.run.status).toBe('ESCALATED');
        expect(result!.reason).toBe(
          {
            conflict: 'conflicting_evidence',
            partial: 'partial_evidence_failure',
            loop: 'model_budget',
            invalid: 'partial_evidence_failure',
            bad_report: 'invalid_model_report',
          }[mode],
        );
      }
      expect(investigationHistory(f.store, id, result!.run_id).events).toEqual(
        view.events,
      );
      expect(f.store.claim('late')).toBeNull();
    } finally {
      await demo.close();
      await stub.close();
      f.db.close();
    }
  },
  30000,
);
test('stopped real source persists genuine failures and no invented observations', async () => {
  const f = investigationDb(),
    read = randomBytes(32).toString('hex'),
    control = randomBytes(32).toString('hex');
  const demo = await startLocalIncidentDemo({
    source_id: 'stopped-pool',
    service: 'orders',
    environment: 'local',
    read_token: read,
    control_token: control,
  });
  await demo.close();
  try {
    const id = f.send().items[0].incident_id;
    const result = await new IncidentInvestigationWorker(f.store, {
      repo_root: path.resolve('.'),
      incident_id: id,
      wall_ms: 20000,
      sources: [
        {
          source_scope: sourceScope('owner', 'step5-demo'),
          source_id: 'stopped-pool',
          service: 'orders',
          environment: 'local',
          base_url: demo.base_url,
          read_token: read,
          instance_id: demo.instance_id,
        },
      ],
    }).tick();
    const view = f.store.detail(id, result!.run_id);
    expect(view.observed_evidence).toHaveLength(0);
    expect(
      view.events.filter((e) => e.event_type === 'ToolFailed'),
    ).toHaveLength(2);
    expect(view.run.status).toBe('ESCALATED');
    expect(view.report.next_evidence_requests.length).toBeGreaterThan(0);
  } finally {
    f.db.close();
  }
}, 30000);
test('wall budget kills only owned Runner and converges without model/automatic retry', async () => {
  const f = investigationDb();
  try {
    const id = f.send().items[0].incident_id;
    const r = await new IncidentInvestigationWorker(f.store, {
      repo_root: path.resolve('.'),
      incident_id: id,
      wall_ms: 100,
      sources: [],
    }).tick();
    expect(r!.reason).toBe('wall_budget');
    expect(f.store.list(id)[0].state).toBe('manual');
    expect(f.store.claim('next')).toBeNull();
  } finally {
    f.db.close();
  }
}, 15000);
