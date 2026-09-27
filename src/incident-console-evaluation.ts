import fs from 'node:fs/promises';
import path from 'node:path';
import { readIncidentConsole } from './incident-console-read-model.js';

type Category = 'Schema' | 'Workflow' | 'Approval' | 'Timeout' | 'Replay';
const categoryByModule: Record<string, Category> = {
  test_models: 'Schema',
  test_workflow_acceptance: 'Workflow',
  test_approval_boundary: 'Approval',
  test_timeout_recovery: 'Timeout',
  test_replay_acceptance: 'Replay',
};
interface TestResult {
  name: string;
  category: Category;
  status: 'passed' | 'failed' | 'skipped';
}
const attributes = (tag: string) =>
  Object.fromEntries(
    [...tag.matchAll(/([a-zA-Z_]+)="([^"]*)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
async function readFile(file: string, max: number): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) return null;
    return fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

/** Reads a pytest JUnit artifact produced by the real core suite; never runs tests on GET. */
export async function readIncidentEvaluation(root: string) {
  const reportFile = path.join(root, 'data', 'evaluation', 'core-results.xml');
  const report = await readFile(reportFile, 2_000_000);
  const tests: TestResult[] = [];
  if (report?.startsWith('<?xml')) {
    for (const match of report.matchAll(
      /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g,
    )) {
      const attr = attributes(match[1]);
      const category =
        categoryByModule[attr.classname?.split('.').at(-1) ?? ''];
      if (!category || !attr.name) continue;
      const body = match[2] ?? '';
      tests.push({
        name: attr.name,
        category,
        status: /<(?:failure|error)\b/.test(body)
          ? 'failed'
          : /<skipped\b/.test(body)
            ? 'skipped'
            : 'passed',
      });
    }
  }
  const categories = (Object.keys(categoryByModule) as string[]).map(
    (module) => {
      const name = categoryByModule[module];
      const items = tests.filter((test) => test.category === name);
      return {
        name,
        total: items.length,
        passed: items.filter((test) => test.status === 'passed').length,
      };
    },
  );
  const catalog = await readIncidentConsole(root, false);
  const incidents = new Map(
    catalog.incidents.map((incident) => [incident.id, incident]),
  );
  const expectedText = await readFile(
    path.join(root, 'evaluation', 'expected_cases.json'),
    100_000,
  );
  const matrix = await readFile(
    path.join(root, 'docs', 'incident-case-matrix.md'),
    500_000,
  );
  const expected = expectedText
    ? (JSON.parse(expectedText) as Record<string, { expected_status?: string }>)
    : {};
  const scenarios = new Map<string, string>();
  for (const match of matrix?.matchAll(
    /^\|\s*(INC-\d+)\s*\|\s*([^|]+)\s*\|/gm,
  ) ?? []) {
    scenarios.set(match[1], match[2].trim());
  }
  const cases = Object.entries(expected)
    .filter(([id]) => /^INC-\d+$/.test(id))
    .map(([id, value]) => {
      const test = tests.find(
        (item) => item.category === 'Workflow' && item.name.includes(`[${id}-`),
      );
      const expectedStatus = value.expected_status ?? 'UNKNOWN';
      // The test asserts the actual workflow status; a pass proves equality with the expected status.
      const actualResult =
        test?.status === 'passed'
          ? expectedStatus
          : test?.status === 'failed'
            ? '断言失败，详见 JUnit'
            : '尚无评测结果';
      const scenario = scenarios.get(id) ?? '场景未记录';
      const kind = /冲突/.test(scenario)
        ? 'conflict'
        : /缺少|不足/.test(scenario)
          ? 'insufficient'
          : 'diagnosable';
      return {
        id,
        service: incidents.get(id)?.service ?? '—',
        scenario,
        expectedResult: expectedStatus,
        actualResult,
        status: test?.status ?? 'not_run',
        kind,
      };
    });
  const stat = report ? await fs.stat(reportFile) : null;
  return {
    available: tests.length > 0,
    source: report ? 'pytest JUnit · data/evaluation/core-results.xml' : null,
    generatedAt: stat?.mtime.toISOString() ?? null,
    total: tests.length,
    passed: tests.filter((test) => test.status === 'passed').length,
    categories,
    dataset: {
      total: cases.length,
      diagnosable: cases.filter((item) => item.kind === 'diagnosable').length,
      conflict: cases.filter((item) => item.kind === 'conflict').length,
      insufficient: cases.filter((item) => item.kind === 'insufficient').length,
    },
    cases,
  };
}
