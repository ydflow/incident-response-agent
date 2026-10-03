import { expect, test } from 'vitest';
import { investigationDb } from './helpers/incident-investigation-db.js';
import {
  IncidentConsoleLive,
  consoleLiveQuery,
  consoleRedact,
  consoleEvent,
} from '../src/incident-console-live.js';
test('large event projection preserves recorded identity/state, labels omitted bodies and bounds pages', () => {
  const event = {
    event_id: 'recorded',
    event_type: 'ToolResult',
    timestamp: '2026-10-03T00:00:00Z',
    payload: {
      tool: 'query_live_metrics',
      status: 'returned',
      tool_call_id: 'actual-call',
      tool_output: 'x'.repeat(100000),
    },
  };
  const view = consoleEvent(event);
  expect(view.event_id).toBe(event.event_id);
  expect(view.event_type).toBe(event.event_type);
  expect(view.timestamp).toBe(event.timestamp);
  expect(view.payload.status).toBe('returned');
  expect(view.payload.tool_call_id).toBe('actual-call');
  expect(view).toHaveProperty('payload_truncated', true);
  expect(view.payload).not.toHaveProperty('tool_output');
  expect(() => consoleRedact(Array(20).fill(view))).not.toThrow();
  expect(event.payload.tool_output.length).toBe(100000);
});

test('paginated list and occurrences expose real queued/failed states without synthetic observations', () => {
  const f = investigationDb();
  try {
    const id = f.send().items[0].incident_id;
    for (let i = 0; i < 12; i++) f.send({ external_id: `extra-${i}` });
    const second = f.send({ fingerprint: 'second', external_id: 'second' })
      .items[0].incident_id;
    f.store.scanPending();
    const now = Date.now(),
      first = f.store.claim('first', { incident_id: second }, now)!;
    f.store.retry(first, 'transport_failure', now);
    const last = f.store.claim('second', { incident_id: second }, now + 10001)!;
    f.store.retry(last, 'transport_failure', now + 10001);
    const reader = new IncidentConsoleLive(f.alerts, f.store),
      access = { all: true, grants: [] };
    const list = reader.list(
      access,
      consoleLiveQuery.parse({ limit: 1 }),
    ) as any;
    expect(list.items).toHaveLength(1);
    expect(list.has_more).toBe(true);
    const page = reader.list(
      access,
      consoleLiveQuery.parse({ limit: 1, offset: 1 }),
    ) as any;
    expect(page.items[0].incident_id).not.toBe(list.items[0].incident_id);
    expect(page.has_more).toBe(false);
    const detail = reader.detail(access, id, { limit: 5, offset: 10 }) as any;
    expect(detail.alerts.total).toBe(13);
    expect(detail.alerts.items).toHaveLength(3);
    expect(detail.job.state).toBe('queued');
    expect(detail.source_mode).toBe('unbound');
    expect(detail.observation_count).toBe(0);
    expect(detail.latest_run).toBeNull();
    const failed = reader.detail(access, second, {
      limit: 10,
      offset: 0,
    }) as any;
    expect(failed.job.state).toBe('failed');
    expect(failed.job.attempt).toBe(2);
    expect(failed.jobs[0].runs).toHaveLength(2);
    expect(failed.latest_run.error_code).toBe('transport_failure');
  } finally {
    f.db.close();
  }
});
test('output sanitizes private fields and free text while preserving reference content hashes', () => {
  const hash = 'a'.repeat(64);
  const clean = consoleRedact({
    lease_token: 5,
    owner: 'private',
    token: 'hidden',
    base_url: 'private',
    report_json: 'private',
    text: `Bearer secret password=secret sk-private abc@example.com C:\\Users\\private\\log.txt ${hash} eyJabc.def.ghi`,
    version_hash: hash,
    aggregation_key: hash,
    snippet: 'Runbook snippet',
    value: 2,
  }) as any;
  expect(clean).not.toHaveProperty('lease_token');
  expect(clean).not.toHaveProperty('owner');
  expect(clean).not.toHaveProperty('token');
  expect(clean.text).not.toMatch(
    /secret|sk-private|abc@example|Users|private|eyJabc|aaaa/,
  );
  expect(clean.version_hash).toBe(hash);
  expect(clean.aggregation_key).toBe(hash);
  expect(clean.snippet).toBe('Runbook snippet');
  expect(clean.value).toBe(2);
});
test('output rejects excessive nesting, cardinality, a single large string and total bytes', () => {
  expect(() => consoleRedact({ text: 'x'.repeat(65537) })).toThrow(
    'console_output_too_large',
  );
  expect(() => consoleRedact(Array(501).fill(0))).toThrow(
    'console_output_too_large',
  );
  expect(() => consoleRedact(Array(5).fill('x'.repeat(60000)))).toThrow(
    'console_output_too_large',
  );
  let deep: unknown = 0;
  for (let i = 0; i < 14; i++) deep = { nested: deep };
  expect(() => consoleRedact(deep)).toThrow('console_output_too_large');
});
