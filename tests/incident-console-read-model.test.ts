import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readIncidentConsole } from '../src/incident-console-read-model.js';

let root: string;
async function write(relative: string, value: string) {
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, value);
}
function event(type: string, timestamp: string, payload: object) {
  return JSON.stringify({
    event_id: `${type}-${timestamp}`,
    incident_id: 'INC-001',
    event_type: type,
    timestamp,
    payload,
  });
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'incident-console-'));
  await write(
    'incident_agent/fixtures/INC-001/incident.json',
    JSON.stringify({
      incident_id: 'INC-001',
      service: 'payment',
      alert: '5xx',
      started_at: '2026-09-26T00:00:00Z',
    }),
  );
});
afterEach(async () => {
  const target = path.resolve(root);
  if (
    path.dirname(target) !== path.resolve(os.tmpdir()) ||
    !path.basename(target).startsWith('incident-console-')
  ) {
    throw new Error('Unexpected temporary test directory');
  }
  await fs.rm(target, { recursive: true, force: true });
});
describe('read-only incident console projection', () => {
  it('does not turn an evaluation expectation into a run or severity', async () => {
    await write(
      'evaluation/expected_cases.json',
      JSON.stringify({ 'INC-001': { status: 'RESOLVED', severity: 'P1' } }),
    );
    const snapshot = await readIncidentConsole(root, true);
    expect(snapshot.incidents[0]).toMatchObject({
      status: 'NOT_RUN',
      severity: null,
    });
    expect(snapshot.events).toEqual([]);
  });
  it('uses the newest run boundary rather than an old terminal result', async () => {
    await write(
      'data/incident-runs/INC-001.jsonl',
      [
        event('IncidentCreated', '2026-09-25T00:00:00Z', {
          status: 'RECEIVED',
        }),
        event('StatusChanged', '2026-09-25T00:01:00Z', { to: 'RESOLVED' }),
        event('IncidentCreated', '2026-09-26T00:00:00Z', {
          status: 'RECEIVED',
        }),
        event('StatusChanged', '2026-09-26T00:01:00Z', { to: 'DIAGNOSED' }),
      ].join('\n'),
    );
    const snapshot = await readIncidentConsole(root, true);
    expect(snapshot.incidents[0].status).toBe('DIAGNOSED');
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events.some((e) => e.status === 'RESOLVED')).toBe(false);
  });
  it('keeps member history unavailable and does not return private payloads', async () => {
    await write(
      'data/incident-e2e/INC-001-test/INC-001.jsonl',
      [
        event('IncidentCreated', '2026-09-26T00:00:00Z', {
          status: 'RECEIVED',
          secret: 'PRIVATE',
        }),
        event('ToolResult', '2026-09-26T00:01:00Z', {
          tool: 'query_logs',
          result: 'PRIVATE',
        }),
      ].join('\n'),
    );
    const member = await readIncidentConsole(root, false);
    expect(member.historyAccess).toBe(false);
    expect(member.incidents[0].status).toBe('UNAVAILABLE');
    expect(member.events).toEqual([]);
    const admin = await readIncidentConsole(root, true);
    expect(admin.events).toHaveLength(2);
    expect(JSON.stringify(admin)).not.toContain('PRIVATE');
  });
  it('reports malformed lines without changing a diagnosed run into resolved', async () => {
    await write(
      'data/incident-runs/INC-001.jsonl',
      [
        event('IncidentCreated', '2026-09-26T00:00:00Z', {
          status: 'RECEIVED',
        }),
        event('StatusChanged', '2026-09-26T00:01:00Z', { to: 'DIAGNOSED' }),
        '{"partial":',
      ].join('\n'),
    );
    const snapshot = await readIncidentConsole(root, true);
    expect(snapshot.incidents[0].status).toBe('DIAGNOSED');
    expect(snapshot.warnings).not.toHaveLength(0);
  });
  it('does not traverse linked run directories', async () => {
    const external = path.join(root, 'external');
    await write(
      'external/INC-001.jsonl',
      event('IncidentCreated', '2026-09-26T00:00:00Z', { status: 'RESOLVED' }),
    );
    await fs.mkdir(path.join(root, 'data'));
    await fs.symlink(
      external,
      path.join(root, 'data/incident-runs'),
      'junction',
    );
    expect((await readIncidentConsole(root, true)).events).toEqual([]);
  });
  it('reports an absent fixture directory as unavailable, not zero incidents', async () => {
    await expect(
      readIncidentConsole(path.join(root, 'missing'), true),
    ).rejects.toThrow('故障目录不可读取');
  });
});
