import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readIncidentEvaluation } from '../src/incident-console-evaluation.js';

let root: string;
async function write(file: string, data: string) {
  const target = path.join(root, file);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-eval-'));
  for (const id of ['INC-001', 'INC-002']) {
    await write(
      `incident_agent/fixtures/${id}/incident.json`,
      JSON.stringify({
        incident_id: id,
        service: `${id}-service`,
        alert: 'test',
        started_at: '2026-09-26T00:00:00Z',
      }),
    );
  }
  await write(
    'evaluation/expected_cases.json',
    JSON.stringify({
      'INC-001': { expected_status: 'DIAGNOSED' },
      'INC-002': { expected_status: 'ESCALATED' },
    }),
  );
  await write(
    'docs/incident-case-matrix.md',
    '| INC-001 | 可诊断场景 | `DIAGNOSED` |\n| INC-002 | 证据互相冲突 | `ESCALATED` |',
  );
});
afterEach(async () => {
  const target = path.resolve(root);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('incident-eval-')
  )
    throw new Error('Unsafe test cleanup path');
  await fs.rm(target, { recursive: true, force: true });
});
it('shows no invented result before a JUnit report exists', async () => {
  const value = await readIncidentEvaluation(root);
  expect(value.available).toBe(false);
  expect(value.total).toBe(0);
  expect(value.passed).toBe(0);
  expect(value.cases.every((item) => item.status === 'not_run')).toBe(true);
});
it('counts actual JUnit cases and never infers a failed case outcome', async () => {
  await write(
    'data/evaluation/core-results.xml',
    '<?xml version="1.0"?><testsuites><testsuite><testcase classname="incident_agent.tests.test_models" name="test_schema" /><testcase classname="incident_agent.tests.test_workflow_acceptance" name="test_case_workflow_acceptance[INC-001-X-DIAGNOSED]" /><testcase classname="incident_agent.tests.test_workflow_acceptance" name="test_case_workflow_acceptance[INC-002-None-ESCALATED]"><failure message="assertion" /></testcase></testsuite></testsuites>',
  );
  const value = await readIncidentEvaluation(root);
  expect([value.total, value.passed]).toEqual([3, 2]);
  expect(
    value.categories.find((item) => item.name === 'Workflow'),
  ).toMatchObject({ total: 2, passed: 1 });
  expect(value.cases[0]).toMatchObject({
    status: 'passed',
    actualResult: 'DIAGNOSED',
  });
  expect(value.cases[1]).toMatchObject({
    status: 'failed',
    actualResult: '断言失败，详见 JUnit',
    kind: 'conflict',
  });
});
