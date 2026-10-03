import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import {
  validateReport,
  escalationReport,
} from '../src/incident-investigation-types.js';
const id = `LIVE-${randomUUID()}`,
  run = `RUN-${randomUUID()}`,
  now = Date.now(),
  scope = {
    incident_id: id,
    run_id: run,
    service: 'orders',
    environment: 'local',
    from: new Date(now - 60000).toISOString(),
    to: new Date(now + 1000).toISOString(),
  };
const body = {
  provider: 'local_demo',
  run_id: run,
  service: 'orders',
  environment: 'local',
  kind: 'metrics',
  window: {
    from: new Date(now - 1000).toISOString(),
    to: new Date(now).toISOString(),
  },
  items: [{ pool_capacity: 2, pool_waiting: 2, acquire_timeouts: 2 }],
};
const evidence = {
  evidence_id: 'actual',
  incident_id: id,
  source: 'metrics' as const,
  timestamp: new Date(now).toISOString(),
  content: JSON.stringify(body),
  correlation_id: randomUUID(),
};
test('literal observed values pass, semantic inference is a separate hypothesis', () => {
  const report = escalationReport('needs_independent_evidence', [evidence]);
  expect(validateReport(report, scope, [evidence], []).facts[0].value).toBe(2);
});
test.each([
  'missing',
  'foreign',
  'environment',
  'service',
  'run',
  'time',
  'invalid_time',
  'kind',
  'value',
  'field',
] as const)('rejects %s reference mismatch', (kind) => {
  const e = { ...evidence },
    c = { ...body, window: { ...body.window } },
    report = escalationReport('needs_evidence', [evidence]);
  if (kind === 'missing') report.facts[0].evidence_id = 'missing';
  if (kind === 'foreign') e.incident_id = `LIVE-${randomUUID()}`;
  if (kind === 'environment') c.environment = 'staging';
  if (kind === 'service') c.service = 'billing';
  if (kind === 'run') c.run_id = `RUN-${randomUUID()}`;
  if (kind === 'time') c.window.from = new Date(now - 120000).toISOString();
  if (kind === 'invalid_time') c.window.from = 'invalid';
  if (kind === 'kind') c.kind = 'logs';
  if (kind === 'value') report.facts[0].value = 99;
  if (kind === 'field') {
    report.facts[0].field = 'message';
    report.facts[0].value = 'invented';
  }
  e.content = JSON.stringify(c);
  expect(() => validateReport(report, scope, [e], [])).toThrow();
});
test('knowledge cannot substitute for observation and confidence cannot grant authority', () => {
  const report = escalationReport('needs_evidence', [evidence]);
  report.handbook_suggestions = [
    { suggestion: 'Inspect pool', knowledge_reference_ids: ['nonexistent'] },
  ];
  expect(() => validateReport(report, scope, [evidence], [])).toThrow(
    'invalid_knowledge_reference',
  );
  const diagnostic = {
    ...escalationReport('needs_evidence', [evidence]),
    outcome: 'DIAGNOSED',
    facts: [],
    escalation_reason: null,
    next_evidence_requests: [],
    diagnosis: {
      incident_id: id,
      root_cause: 'Claim',
      confidence: 1,
      evidence_ids: ['actual'],
      recommendation: 'Review',
    },
  };
  expect(() => validateReport(diagnostic, scope, [evidence], [])).toThrow(
    'diagnosis_without_measurements',
  );
});
