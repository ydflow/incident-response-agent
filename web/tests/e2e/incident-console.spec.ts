import path from 'node:path';
import { expect, test } from '@playwright/test';
import { readIncidentConsole } from '../../../src/incident-console-read-model';
import { readIncidentRuns } from '../../../src/incident-console-artifacts';
import { readIncidentEvaluation } from '../../../src/incident-console-evaluation';

// Browser acceptance uses a synthetic authenticated identity, with incident and
// event responses projected from the actual local catalog. No production login,
// approval, tool call or persistent user is created by these tests.
test('console routes, real catalog, filters and desktop shell', async ({
  page,
}, testInfo) => {
  const snapshot = await readIncidentConsole(
    path.resolve(process.cwd(), '..'),
    true,
  );
  const root = path.resolve(process.cwd(), '..');
  const runs = await readIncidentRuns(root);
  const evaluation = await readIncidentEvaluation(root);
  const history = runs.flatMap((run) =>
    run.events
      .filter((event) => event.type === 'ApprovalRequested')
      .map((event) => {
        const decision = run.events.find(
          (item) =>
            item.type === 'ApprovalDecided' &&
            item.payload.approval_id === event.payload.approval_id,
        );
        return {
          id: event.payload.approval_id,
          incident: run.incidentId,
          service:
            snapshot.incidents.find((item) => item.id === run.incidentId)
              ?.service ?? '—',
          action: event.payload.action,
          target: event.payload.target,
          risk: 'ASK',
          reason: null,
          requestedAt: event.timestamp,
          status:
            decision?.payload.decision === 'reject'
              ? 'REJECTED'
              : decision?.payload.decision === 'allow'
                ? 'APPROVED'
                : 'EXPIRED',
          runId: run.id,
        };
      }),
  );
  const errors: string[] = [];
  const unexpected: string[] = [];
  const mutations: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.route('**/api/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname;
    if (route.request().method() !== 'GET')
      mutations.push(`${route.request().method()} ${endpoint}`);
    const data: Record<string, unknown> = {
      '/api/auth/me': {
        user: {
          id: 'console-test',
          username: 'console-admin',
          display_name: '验收管理员',
          role: 'admin',
          permissions: [],
          must_change_password: false,
        },
        setupStatus: { needsSetup: false },
      },
      '/api/incident-console': snapshot,
      '/api/incident-console/approvals': { pending: [], history },
      '/api/incident-console/traces': { runs: runs.slice(0, 100) },
      '/api/incident-console/evaluation': evaluation,
      '/api/health': {
        status: 'healthy',
        checks: { database: true, queue: true },
      },
    };
    if (!(endpoint in data)) unexpected.push(endpoint);
    await route.fulfill({
      status: endpoint in data ? 200 : 404,
      json: data[endpoint] ?? {},
    });
  });
  await page.goto('/');
  await expect(page).toHaveURL(/\/overview$/);
  await expect(page).toHaveTitle('运行总览 · 故障智巡');
  await expect(page.locator('.ic-kpi').first().locator('strong')).toHaveText(
    String(snapshot.incidents.length),
  );
  await expect(page.locator('.ic-recent tbody tr')).toHaveCount(
    Math.min(snapshot.incidents.length, 5),
  );
  await expect(page.locator('.ic-overview-detail')).toContainText(
    snapshot.incidents[0].id,
  );
  await expect(page.locator('.ic-evaluation-strip')).toContainText(
    evaluation.available
      ? `${evaluation.passed} / ${evaluation.total}`
      : '暂无可核验的评测结果',
  );
  await page
    .getByRole('button', { name: `查看 ${snapshot.incidents[1].id} 首页详情` })
    .click();
  await expect(page.locator('.ic-overview-detail')).toContainText(
    snapshot.incidents[1].id,
  );
  await page.getByRole('tab', { name: '指标' }).click();
  await expect(page.getByRole('tab', { name: '指标' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page
    .getByRole('button', { name: `查看 ${snapshot.incidents[0].id} 首页详情` })
    .click();
  await expect(page.locator('.ic-runtime')).toContainText('未检测');
  await expect(page.locator('.ic-event-list li')).toHaveCount(
    Math.min(snapshot.events.length, 12),
  );
  expect(
    await page
      .locator('.incident-console')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  const sidebar = page.locator('.ic-sidebar');
  const main = page.locator('.ic-main');
  const table = page.locator('.ic-recent .ic-table-scroll');
  await expect(sidebar).toHaveCSS('width', '224px');
  const geometry = await page.evaluate(() => {
    const box = (selector: string) =>
      document.querySelector(selector)!.getBoundingClientRect();
    return {
      mainWidth: box('.ic-main').width,
      topbarHeight: box('.ic-topbar').height,
      firstKpiTop: box('.ic-kpi').top,
      lastKpiTop: box('.ic-kpi:last-child').top,
      recentTop: box('.ic-recent').top,
      eventsTop: box('.ic-events').top,
    };
  });
  expect(geometry.mainWidth).toBeLessThanOrEqual(
    page.viewportSize()!.width - 224,
  );
  expect(geometry.topbarHeight).toBe(56);
  expect(geometry.firstKpiTop).toBe(geometry.lastKpiTop);
  expect(geometry.recentTop).toBe(geometry.eventsTop);
  await expect(table).toHaveCSS('overflow-x', 'auto');
  await page.getByRole('button', { name: '折叠侧栏' }).click();
  await expect(sidebar).toHaveCSS('width', '72px');
  await expect(page.getByRole('button', { name: '展开侧栏' })).toBeVisible();
  expect(
    await page
      .locator('.incident-console')
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  await page.getByRole('button', { name: '展开侧栏' }).click();
  await expect(sidebar).toHaveCSS('width', '224px');
  await page.screenshot({
    path: testInfo.outputPath('overview.png'),
    fullPage: true,
  });
  await page.locator('.incident-console').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.screenshot({ path: testInfo.outputPath('overview-bottom.png') });
  await page.locator('.incident-console').evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.getByRole('link', { name: '查看全部' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(snapshot.incidents.length);
  await expect(page.locator('.ic-table-scroll')).toHaveCSS(
    'overflow-x',
    'auto',
  );
  expect(
    await page
      .locator('.incident-console')
      .evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await page.getByLabel('搜索故障', { exact: true }).fill('INC-001');
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('严重程度过滤').selectOption('P1');
  await expect(page.getByText('没有符合条件的故障')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByLabel('搜索故障', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('严重程度过滤')).toHaveValue('');
  await expect(page.locator('tbody tr')).toHaveCount(snapshot.incidents.length);
  const status =
    snapshot.incidents.find((incident) => incident.status === 'ESCALATED')
      ?.status ?? 'NOT_RUN';
  await page.getByLabel('状态过滤').selectOption(status);
  await expect(page.locator('tbody tr')).toHaveCount(
    snapshot.incidents.filter((incident) => incident.status === status).length,
  );
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByLabel('状态过滤')).toHaveValue('');
  await expect(page.locator('tbody tr')).toHaveCount(snapshot.incidents.length);
  await page.screenshot({
    path: testInfo.outputPath('incidents.png'),
    fullPage: true,
  });
  await page.getByLabel('全局搜索').fill('payment');
  await page.getByLabel('全局搜索').press('Enter');
  await expect(page.getByLabel('搜索故障', { exact: true })).toHaveValue(
    'payment',
  );
  await page.getByLabel('时间范围').selectOption('24');
  await expect(page.locator('tbody tr')).toHaveCount(
    snapshot.incidents.filter(
      (incident) =>
        `${incident.id} ${incident.service} ${incident.alert}`
          .toLowerCase()
          .includes('payment') &&
        Date.parse(incident.startedAt) >= Date.now() - 86400000,
    ).length,
  );
  await page.getByLabel('时间范围').selectOption('all');
  for (const [url, title] of [
    ['investigations', '调查任务'],
    ['services', '服务管理'],
    ['system-settings', '系统设置'],
  ]) {
    await page.goto(`/${url}`);
    await expect(
      page.getByRole('heading', { name: `${title}尚未开放` }),
    ).toBeVisible();
    await page.getByRole('link', { name: '返回运行总览' }).click();
  }
  await page.goto('/approvals');
  await expect(page.getByRole('heading', { name: '审批中心' })).toBeVisible();
  await expect(page.getByText('BLOCK 操作已被安全策略阻止')).toBeVisible();
  await expect(page.getByRole('button', { name: '批准' })).toHaveCount(0);
  await expect(
    page.locator('.ic-approval-table').last().locator('tbody tr'),
  ).toHaveCount(history.length);
  await page.screenshot({
    path: testInfo.outputPath('approvals.png'),
    fullPage: true,
  });
  await page.goto('/traces');
  await expect(page.getByRole('heading', { name: '执行追踪' })).toBeVisible();
  await expect(page.locator('.ic-run-item')).toHaveCount(runs.length);
  await page.screenshot({
    path: testInfo.outputPath('traces.png'),
    fullPage: true,
  });
  if (runs.length) {
    await page.getByRole('button', { name: '下一步' }).click();
    await expect(page.locator('.ic-trace-timeline li')).toHaveCount(1);
    await page.getByRole('button', { name: '重新开始' }).click();
    await expect(page.locator('.ic-trace-timeline li')).toHaveCount(0);
  } else {
    await expect(page.getByText('暂无可访问的追踪记录')).toBeVisible();
  }
  await page.goto('/evaluations');
  await expect(page.getByRole('heading', { name: '评测中心' })).toBeVisible();
  await expect(
    page.locator('.ic-eval-summary .ic-card').first().locator('strong'),
  ).toHaveText(
    evaluation.available
      ? `${evaluation.passed} / ${evaluation.total}`
      : '— / —',
  );
  await expect(page.locator('.ic-case-table tbody tr')).toHaveCount(
    evaluation.dataset.total,
  );
  await page.screenshot({
    path: testInfo.outputPath('evaluations.png'),
    fullPage: true,
  });
  await page.getByLabel('通知', { exact: true }).click();
  await expect(page.getByText('通知服务尚未接入。')).toBeVisible();
  expect(unexpected).toEqual([]);
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('loading, unavailable data, retry and public branding', async ({
  page,
}, testInfo) => {
  await page.route('**/api/auth/me', (route) =>
    route.fulfill({
      json: {
        user: { id: 'test', username: 'test', role: 'admin', permissions: [] },
        setupStatus: { needsSetup: false },
      },
    }),
  );
  await page.route('**/api/health', (route) =>
    route.fulfill({ json: { checks: { database: true } } }),
  );
  await page.route('**/api/incident-console/traces', (route) =>
    route.fulfill({ json: { runs: [] } }),
  );
  await page.route('**/api/incident-console/approvals', (route) =>
    route.fulfill({ json: { pending: [], history: [] } }),
  );
  await page.route('**/api/incident-console/evaluation', (route) =>
    route.fulfill({
      json: {
        available: false,
        generatedAt: null,
        total: 0,
        passed: 0,
        categories: [],
      },
    }),
  );
  let fail = true;
  await page.route('**/api/incident-console', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    await route.fulfill(
      fail
        ? { status: 503, json: { error: 'unavailable' } }
        : {
            json: {
              incidents: [],
              events: [],
              historyAccess: true,
              updatedAt: new Date().toISOString(),
              warnings: [],
            },
          },
    );
  });
  await page.goto('/overview');
  await expect(page.getByLabel('正在加载故障').first()).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('故障数据获取失败');
  await expect(page.locator('.ic-kpi').first().locator('strong')).toHaveText(
    '—',
  );
  fail = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.locator('.ic-kpi').first().locator('strong')).toHaveText(
    '0',
  );
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { initialized: true } }),
  );
  await page.route('**/api/auth/register/status', (route) =>
    route.fulfill({
      json: { allowRegistration: false, requireInviteCode: true },
    }),
  );
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: '管理员登录' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '登录', exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath('login.png'),
    fullPage: true,
  });
});
