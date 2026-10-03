import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { investigationDb } from './helpers/incident-investigation-db.js';
import { BoundInvestigationApprovals } from '../src/incident-investigation-approval.js';
import { exportInvestigationReplay } from '../src/incident-investigation-history.js';
let tmp: string, f: ReturnType<typeof investigationDb>;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'investigation-store-'));
  f = investigationDb(path.join(tmp, 'test.db'));
});
afterEach(() => {
  if (f.db.open) f.db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
function task(now = Date.now()) {
  const id = f.send({}, 'first', now).items[0].incident_id;
  return { id, job: f.store.list(id)[0], now };
}
test.each(['error', 'expired'] as const)(
  'recovery %s stays manual across restart, never becomes a generic investigation',
  (mode) => {
    const { id, now } = task();
    const lease = f.store.claim(
      'recovery-host',
      { incident_id: id, lease_ms: 100 },
      now,
    )!;
    f.store.markRecoveryTask(lease, now);
    if (mode === 'error')
      f.store.retry(lease, 'recovery_verification_failed', now);
    f.db.close();
    f = investigationDb(path.join(tmp, 'test.db'));
    if (mode === 'expired') f.store.reap(now + 101);
    expect(f.store.job(lease.job_id).state).toBe('manual');
    expect(f.store.claim('ordinary-worker', {}, now + 11000)).toBeNull();
    expect(() =>
      f.store.bindSource(
        lease,
        { source_id: 'stale', instance_id: 'stale' },
        'host_no_model',
        now + 11000,
      ),
    ).toThrow('stale_lease');
  },
);
test('intake outbox is atomic, duplicate deliveries idempotent, queued merge then running freeze', () => {
  const { id, job, now } = task();
  const first = f.send(
    { starts_at: new Date(now - 10000).toISOString() },
    'first',
    now,
  );
  expect(first.duplicate).toBe(true);
  f.send(
    { external_id: 'pool-2', starts_at: new Date(now - 10000).toISOString() },
    'second',
    now,
  );
  expect(f.store.list(id)).toHaveLength(1);
  expect(f.store.job(job.job_id).input_revision).toBe(2);
  const lease = f.store.claim('one', {}, now)!;
  expect(f.store.claim('two', {}, now)).toBeNull();
  f.send(
    { external_id: 'pool-3', starts_at: new Date(now - 10000).toISOString() },
    'third',
    now,
  );
  expect(f.store.job(lease.job_id)).toMatchObject({
    input_revision: 2,
    pending_revision: 3,
  });
  expect(() => f.store.enqueue(id, true, now)).toThrow(
    'investigation_already_active',
  );
});
test('different environments and windows have separate jobs', () => {
  const { id, now } = task();
  const env = f.send({ environment: 'staging' }, 'env', now).items[0]
    .incident_id;
  const later = f.send({}, 'later', now + 16 * 60000).items[0].incident_id;
  expect(new Set([id, env, later]).size).toBe(3);
  expect(f.store.list(later)).toHaveLength(1);
});
test('separate processes atomically compete for one job', async () => {
  task();
  const run = promisify(execFile),
    script = path.resolve('tests/helpers/incident-investigation-claim.ts');
  const result = await Promise.all(
    ['one', 'two'].map((owner) =>
      run(
        process.execPath,
        ['--import', 'tsx', script, path.join(tmp, 'test.db'), owner],
        { timeout: 15000, windowsHide: true },
      ),
    ),
  );
  expect(result.map((r) => JSON.parse(r.stdout)).filter(Boolean)).toHaveLength(
    1,
  );
}, 20000);
test('restart recovers expired lease and fences every old writer', () => {
  const { now, job } = task(),
    lease = f.store.claim('old', { lease_ms: 1000 }, now)!;
  f.store.reserveModel(lease, 'protocol_stub', 1, 0, now);
  f.db.close();
  f = investigationDb(path.join(tmp, 'test.db'));
  expect(f.store.reap(now + 1001)).toBe(1);
  expect(() =>
    exportInvestigationReplay(
      f.store,
      f.store.job(job.job_id).incident_id,
      lease.run_id,
      path.join(tmp, 'history'),
    ),
  ).toThrow('history_has_no_events');
  expect(f.store.job(job.job_id).state).toBe('retry_wait');
  expect(f.store.claim('early', {}, now + 1002)).toBeNull();
  const fresh = f.store.claim('new', {}, now + 11002)!;
  expect(fresh.token).toBe(2);
  expect(fresh.run_id).not.toBe(lease.run_id);
  for (const call of [
    () => f.store.heartbeat(lease, 1000, now + 11002),
    () => f.store.reserveTool(lease, 'query_live_logs', now + 11002),
    () => f.store.reserveModel(lease, 'protocol_stub', 1, 0, now + 11002),
    () =>
      f.store.bindSource(
        lease,
        { source_id: 's', instance_id: 'c3297a7c-7c74-44f1-a097-1e52a75c56be' },
        'host_no_model',
        now + 11002,
      ),
    () => f.store.append(lease, {}, now + 11002),
    () => f.store.finish(lease, 'completed', {}, null, now + 11002),
  ])
    expect(call).toThrow('stale_lease');
  expect(f.store.job(job.job_id).model_requests).toBe(1);
  f.store.retry(fresh, 'runner_failed', now + 11002);
  expect(f.store.job(job.job_id).state).toBe('failed');
  expect(f.store.claim('third', {}, now + 99999)).toBeNull();
});
test('wall deadline converges to manual without repeating', () => {
  const { now, job, id } = task();
  f.store.claim('one', { wall_ms: 100 }, now);
  f.store.reap(now + 101);
  expect(f.store.job(job.job_id)).toMatchObject({
    state: 'manual',
    attempt: 1,
    error_code: 'wall_budget',
  });
  f.send(
    { external_id: 'after', starts_at: new Date(now - 10000).toISOString() },
    'after',
    now + 200,
  );
  expect(f.store.list(id)).toHaveLength(1);
  expect(f.store.enqueue(id, true, now + 201)?.generation).toBe(2);
});
test('tool/model budgets persist and finite retry cannot reset generation totals', () => {
  const { now } = task(),
    lease = f.store.claim('one', {}, now)!;
  for (let i = 0; i < 2; i++)
    f.store.reserveTool(lease, 'search_runbooks', now);
  expect(() => f.store.reserveTool(lease, 'search_runbooks', now)).toThrow(
    'tool_budget',
  );
  for (let i = 0; i < 6; i++)
    f.store.reserveTool(lease, 'query_live_logs', now);
  expect(() => f.store.reserveTool(lease, 'query_live_logs', now)).toThrow(
    'tool_budget',
  );
  expect(() => f.store.reserveTool(lease, 'Bash', now)).toThrow(
    'tool_not_allowed',
  );
  for (let i = 0; i < 6; i++)
    f.store.reserveModel(lease, 'protocol_stub', 6, 0, now);
  expect(() => f.store.reserveModel(lease, 'protocol_stub', 6, 0, now)).toThrow(
    'model_budget',
  );
  f.store.retry(lease, 'retry', now);
  const second = f.store.claim('two', {}, now + 10001)!;
  for (let i = 0; i < 6; i++)
    f.store.reserveModel(second, 'protocol_stub', 6, 0, now + 10001);
  expect(f.store.job(second.job_id).model_requests).toBe(12);
});
const proposal = {
  action: 'modify_config',
  target: 'orders',
  parameters: { capacity: 2 },
  mode: 'pure_simulation',
};
test('approval binds parameters, Incident, run, expiry and live host identity, never authorizes execution', () => {
  const { now } = task(),
    lease = f.store.claim('host', {}, now)!,
    host = new BoundInvestigationApprovals(f.store);
  const id = host.request(lease, proposal, 500, now);
  expect(() =>
    host.decide(
      id,
      'approved',
      { ...proposal, parameters: { capacity: 3 } },
      now,
    ),
  ).toThrow('approval_parameters_changed');
  expect(() =>
    new BoundInvestigationApprovals(f.store).decide(
      id,
      'approved',
      proposal,
      now,
    ),
  ).toThrow('approval_live_handle_missing');
  expect(host.decide(id, 'approved', proposal, now)).toEqual({
    state: 'approved',
    execution_authorized: false,
  });
  expect(() => host.decide(id, 'approved', proposal, now)).toThrow(
    'approval_live_handle_missing',
  );
  expect(() =>
    host.request(lease, { ...proposal, target: 'other' }, 500, now),
  ).toThrow('approval_scope');
  const expired = host.request(lease, proposal, 100, now);
  expect(() => host.decide(expired, 'approved', proposal, now + 101)).toThrow(
    'approval_expired',
  );
  const stale = host.request(lease, proposal, 500, now);
  f.store.retry(lease, 'restart', now);
  expect(() => host.decide(stale, 'approved', proposal, now)).toThrow(
    'stale_lease',
  );
  expect(
    f.db
      .prepare(
        'SELECT state FROM incident_investigation_approvals WHERE approval_id=?',
      )
      .get(stale),
  ).toEqual({ state: 'invalidated' });
});
