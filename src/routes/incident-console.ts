import { Hono } from 'hono';
import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import { readIncidentConsole } from '../incident-console-read-model.js';
import { readIncidentRuns } from '../incident-console-artifacts.js';
import { readIncidentEvaluation } from '../incident-console-evaluation.js';
import {
  decideLiveIncidentApproval,
  listLiveIncidentApprovals,
} from '../incident-approval-bridge.js';

const routes = new Hono<{ Variables: Variables }>();
routes.use('*', authMiddleware);
routes.get('/', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    // Local run artifacts have no tenant ownership metadata. Only administrators
    // can read them; members receive the public fixture catalog without history.
    return c.json(
      await readIncidentConsole(process.cwd(), c.get('user').role === 'admin'),
    );
  } catch {
    return c.json({ error: '故障数据暂时不可用，请检查 Fixture 目录' }, 503);
  }
});

function admin(c: { get: (key: 'user') => { role: string } }) {
  return c.get('user').role === 'admin';
}
routes.get('/traces', async (c) => {
  c.header('Cache-Control', 'no-store');
  if (!admin(c)) return c.json({ error: '仅管理员可查看运行事件' }, 403);
  const runs = await readIncidentRuns(process.cwd());
  return c.json({
    runs: runs
      .slice(0, 100)
      .map((run) => ({ ...run, events: run.events.slice(0, 500) })),
  });
});
routes.get('/evaluation', async (c) => {
  c.header('Cache-Control', 'no-store');
  if (!admin(c)) return c.json({ error: '仅管理员可查看评测结果' }, 403);
  try {
    return c.json(await readIncidentEvaluation(process.cwd()));
  } catch {
    return c.json({ error: '评测结果读取失败，请检查评测产物' }, 503);
  }
});
routes.get('/approvals', async (c) => {
  c.header('Cache-Control', 'no-store');
  if (!admin(c)) return c.json({ error: '仅管理员可查看审批记录' }, 403);
  const [live, runs, catalog] = await Promise.all([
    listLiveIncidentApprovals(),
    readIncidentRuns(process.cwd()),
    readIncidentConsole(process.cwd(), false),
  ]);
  const services = new Map(
    catalog.incidents.map((incident) => [incident.id, incident.service]),
  );
  const liveIds = new Set(live.map((item) => item.id));
  const pending = live.map((item) => ({
    id: item.id,
    incident: item.request.incident_id,
    service: services.get(item.request.incident_id) ?? item.request.target,
    action: item.request.action,
    target: item.request.target,
    risk: 'ASK',
    reason: null,
    requestedAt: item.requestedAt,
    parameters: item.request,
    evidence: item.evidence,
    status: 'PENDING',
    groupFolder: item.groupFolder,
  }));
  const history = runs
    .flatMap((run) => {
      const requests = run.events.filter(
        (event) => event.type === 'ApprovalRequested',
      );
      const decisions = run.events.filter(
        (event) => event.type === 'ApprovalDecided',
      );
      const approvals = requests
        .filter(
          (event) =>
            typeof event.payload.approval_id === 'string' &&
            !liveIds.has(event.payload.approval_id),
        )
        .map((event) => {
          const decided = decisions.find(
            (item) => item.payload.approval_id === event.payload.approval_id,
          );
          return {
            id: event.payload.approval_id,
            incident: run.incidentId,
            service: services.get(run.incidentId) ?? '—',
            action: event.payload.action ?? '—',
            target: event.payload.target ?? '—',
            risk: 'ASK',
            reason: null,
            requestedAt: event.timestamp,
            status:
              decided?.payload.decision === 'allow'
                ? 'APPROVED'
                : decided?.payload.decision === 'reject'
                  ? 'REJECTED'
                  : 'EXPIRED',
            decidedAt: decided?.timestamp ?? null,
            runId: run.id,
          };
        });
      const blocked = run.events
        .filter(
          (event) =>
            event.type === 'ToolFailed' &&
            event.payload.tool === 'delete_database',
        )
        .map((event) => ({
          id: `blocked:${event.id}`,
          incident: run.incidentId,
          service: services.get(run.incidentId) ?? '—',
          action: 'delete_database',
          target: '—',
          risk: 'BLOCK',
          reason: '已被安全策略阻止',
          requestedAt: event.timestamp,
          status: 'BLOCKED',
          decidedAt: event.timestamp,
          runId: run.id,
        }));
      return [...approvals, ...blocked];
    })
    .sort((a, b) => Date.parse(b.requestedAt) - Date.parse(a.requestedAt))
    .slice(0, 200);
  return c.json({ pending, history });
});
routes.post('/approvals/:id/decision', async (c) => {
  c.header('Cache-Control', 'no-store');
  if (!admin(c)) return c.json({ error: '仅管理员可执行审批' }, 403);
  const id = c.req.param('id');
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  )
    return c.json({ error: '无效审批 ID' }, 400);
  const body = (await c.req.json().catch(() => null)) as {
    decision?: unknown;
  } | null;
  if (body?.decision !== 'allow' && body?.decision !== 'reject')
    return c.json({ error: '无效审批决定' }, 400);
  const result = await decideLiveIncidentApproval(
    id,
    `web:${c.get('user').id}`,
    body.decision,
  );
  if (result.error === 'unknown_outcome')
    return c.json(
      { error: '审批结果暂未确认，请刷新审批记录后核对', detail: result.error },
      503,
    );
  if (result.accepted !== true)
    return c.json(
      {
        error: '审批请求已失效或安全策略拒绝；未执行操作',
        detail: result.error ?? null,
      },
      409,
    );
  return c.json({
    status: body.decision === 'allow' ? 'APPROVED' : 'REJECTED',
    result: result.result,
  });
});
export default routes;
