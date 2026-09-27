import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readIncidentRuns } from '../src/incident-console-artifacts.js';

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-artifacts-'));
});
afterEach(async () => {
  const target = path.resolve(root);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('incident-artifacts-')
  )
    throw new Error('Unsafe test cleanup path');
  await fs.rm(target, { recursive: true, force: true });
});
it('reads recorded order, separates run boundaries and masks sensitive payload fields', async () => {
  const dir = path.join(root, 'data', 'incident-runs');
  await fs.mkdir(dir, { recursive: true });
  const line = (id: string, type: string, payload: object) =>
    JSON.stringify({
      event_id: id,
      incident_id: 'INC-001',
      event_type: type,
      timestamp: '2026-09-26T00:00:00Z',
      payload,
    });
  await fs.writeFile(
    path.join(dir, 'INC-001.jsonl'),
    [
      line('a', 'IncidentCreated', { status: 'RECEIVED' }),
      line('b', 'ToolCalled', {
        tool: 'query_logs',
        api_token: 'private-token',
        nested: { password: 'private-password' },
      }),
      line('c', 'IncidentCreated', { status: 'RECEIVED' }),
      line('d', 'ToolResult', { status: 'returned' }),
    ].join('\n'),
  );
  const runs = await readIncidentRuns(root, path.join(root, 'data', 'groups'));
  expect(runs.map((run) => run.events.map((event) => event.type))).toEqual([
    ['IncidentCreated', 'ToolCalled'],
    ['IncidentCreated', 'ToolResult'],
  ]);
  expect(runs[0].events[1].payload).toMatchObject({
    tool: 'query_logs',
    api_token: '[已隐藏]',
    nested: { password: '[已隐藏]' },
  });
});
