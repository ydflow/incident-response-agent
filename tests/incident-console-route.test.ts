import { beforeEach, expect, it, vi } from 'vitest';
const { reader, decide, listLive } = vi.hoisted(() => ({
  reader: vi.fn(),
  decide: vi.fn(),
  listLive: vi.fn(),
}));
vi.mock('../src/incident-console-read-model.js', () => ({
  readIncidentConsole: reader,
}));
vi.mock('../src/incident-approval-bridge.js', () => ({
  decideLiveIncidentApproval: decide,
  listLiveIncidentApprovals: listLive,
}));
// Authentication itself retains the existing shared tests. Exercise this route's
// authorization after an authenticated role is supplied by that middleware.
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    const role = c.req.header('x-test-role');
    if (!role) return c.json({ error: 'Unauthorized' }, 401);
    c.set('user', { role, id: 'admin-id' });
    await next();
  },
}));
import routes from '../src/routes/incident-console.js';
beforeEach(() => {
  reader.mockReset();
  reader.mockResolvedValue({ incidents: [], events: [] });
  decide.mockReset();
  decide.mockResolvedValue({
    accepted: false,
    error: 'no_live_pending_request',
  });
  listLive.mockReset();
  listLive.mockResolvedValue([]);
});
it('does not read files for an unauthenticated request', async () => {
  expect((await routes.request('/')).status).toBe(401);
  expect(reader).not.toHaveBeenCalled();
});
it.each([
  ['member', false],
  ['admin', true],
])('gates unowned run history for %s', async (role, allowed) => {
  const response = await routes.request('/', {
    headers: { 'x-test-role': role as string },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(reader).toHaveBeenCalledWith(process.cwd(), allowed);
});
it('returns service unavailable without leaking filesystem details', async () => {
  reader.mockRejectedValue(new Error('C:/private/path'));
  const response = await routes.request('/', {
    headers: { 'x-test-role': 'admin' },
  });
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain('private');
});
it('requires admin and a live Gate approval; ignores browser-supplied action parameters', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const url = `/approvals/${id}/decision`;
  const body = JSON.stringify({
    decision: 'allow',
    action: 'delete_database',
    target: 'production',
  });
  const member = await routes.request(url, {
    method: 'POST',
    headers: { 'x-test-role': 'member', 'Content-Type': 'application/json' },
    body,
  });
  expect(member.status).toBe(403);
  const blocked = await routes.request('/approvals/blocked:fake/decision', {
    method: 'POST',
    headers: { 'x-test-role': 'admin', 'Content-Type': 'application/json' },
    body,
  });
  expect(blocked.status).toBe(400);
  expect(decide).not.toHaveBeenCalled();
  const response = await routes.request(url, {
    method: 'POST',
    headers: { 'x-test-role': 'admin', 'Content-Type': 'application/json' },
    body,
  });
  expect(response.status).toBe(409);
  expect(decide).toHaveBeenCalledWith(id, 'web:admin-id', 'allow');
});
it('keeps trace, evaluation and approval files admin-only', async () => {
  for (const url of ['/traces', '/evaluation', '/approvals']) {
    expect(
      (await routes.request(url, { headers: { 'x-test-role': 'member' } }))
        .status,
    ).toBe(403);
  }
});
