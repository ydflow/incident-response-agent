/** Actual Console APIs, signed sessions, isolated database, live observations and desktop Chromium. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { incidentPythonCommand } from '../src/incident-python.js';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pythonHost = incidentPythonCommand(root);
const step7 = process.argv.includes('--step7');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'v030-step6-'));
const output = path.resolve(
  process.env.INCIDENT_CONSOLE_QA_OUTPUT ??
    path.join(root, '..', 'output', step7 ? 'v0.3.0-step7' : 'v0.3.0-step6'),
);
assert.ok(
  !output.startsWith(root + path.sep),
  'Screenshots must stay outside the repository',
);
fs.mkdirSync(output, { recursive: true });
process.chdir(temp);
process.env.WEB_SESSION_SECRET = randomBytes(32).toString('hex');
process.env.LOG_LEVEL = 'silent';
const db = await import('../src/db.js');
const { getIncidentStore } = await import('../src/incident-store.js');
const { getInvestigationStore } =
  await import('../src/incident-investigation-store.js');
const { sourceScope } = await import('../src/incident-alert-types.js');
const { consoleRedact } = await import('../src/incident-console-live.js');
const { createIncidentAlertRoutes } =
  await import('../src/routes/incident-alerts.js');
const { default: oldConsole } =
  await import('../src/routes/incident-console.js');
const { authMiddleware } = await import('../src/middleware/auth.js');
const { signSessionToken } = await import('../src/auth.js');
const { IncidentInvestigationWorker } =
  await import('../src/incident-investigation-worker.js');
const { startLocalIncidentDemo, runLocalDemoLoad } =
  await import('../src/incident-local-demo.js');
const { chromium, expect } = createRequire(path.join(root, 'web/package.json'))(
  '@playwright/test',
);
let demo: Awaited<ReturnType<typeof startLocalIncidentDemo>> | undefined;
let browser: any, server: ReturnType<typeof serve> | undefined;
const checks: string[] = [];
let step7Summary: Record<string, unknown> = {};
try {
  db.initDatabase();
  const now = new Date().toISOString(),
    cookies = new Map<string, string>();
  for (const [id, role, permissions] of [
    ['qa-admin', 'admin', []],
    ['qa-basic', 'member', []],
    ['qa-member', 'member', ['ingest_alerts']],
  ] as const) {
    db.createUser({
      id,
      username: id,
      password_hash: 'test-account-disabled-login',
      display_name: role === 'admin' ? '本地验收管理员' : '本地验收用户',
      role,
      status: 'active',
      permissions: [...permissions],
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
    const token = randomBytes(32).toString('hex');
    db.createUserSession({
      id: token,
      user_id: id,
      ip_address: null,
      user_agent: 'local Console acceptance',
      created_at: now,
      expires_at: new Date(Date.now() + 600000).toISOString(),
      last_active_at: now,
    });
    cookies.set(id, signSessionToken(token));
  }
  fs.cpSync(
    path.join(root, 'incident_agent/fixtures'),
    path.join(temp, 'incident_agent/fixtures'),
    { recursive: true },
  );
  // Emit historical Fixture lifecycle through the original Python model/state machine.
  const historyCode = `import json,sys\nfrom pathlib import Path\nfrom incident_agent.models import Incident\nfrom incident_agent.events import JsonlEventStore\nfrom incident_agent.state_machine import IncidentLifecycle,IncidentStatus\np=Path(sys.argv[1])\ni=Incident.model_validate(json.loads((p/'incident_agent/fixtures/INC-001/incident.json').read_text(encoding='utf-8')))\nl=IncidentLifecycle(i,JsonlEventStore(p/'data/incident-runs/INC-001.jsonl'))\nl.transition_to(IncidentStatus.INVESTIGATING)\nl.transition_to(IncidentStatus.ESCALATED)\n`;
  execFileSync(
    pythonHost.executable,
    [...pythonHost.prefix, '-B', '-c', historyCode, temp],
    {
      cwd: temp,
      env: { ...process.env, PYTHONPATH: root },
      timeout: 10000,
      windowsHide: true,
      stdio: 'pipe',
    },
  );
  const app = new Hono();
  app.get('/api/auth/status', (c) =>
    c.json({ initialized: db.getUserCount() > 0 }),
  );
  app.get('/api/auth/me', authMiddleware, (c) =>
    c.json({
      user: c.get('user' as never),
      setupStatus: { needsSetup: false },
    }),
  );
  app.get('/api/health', authMiddleware, (c) => {
    const connection = getInvestigationStore().db;
    const database =
      (connection.prepare('SELECT 1 AS ok').get() as { ok: number }).ok === 1;
    const queue =
      (
        connection
          .prepare('SELECT COUNT(*) AS n FROM incident_investigation_jobs')
          .get() as { n: number }
      ).n >= 0;
    return c.json({
      status: database && queue ? 'healthy' : 'unavailable',
      checks: { database, queue },
    });
  });
  app.route('/api/incident-alerts', createIncidentAlertRoutes());
  app.route('/api/incident-console', oldConsole);
  app.all('/api/*', (c) => c.json({ error: 'not_found' }, 404));
  const dist = path.join(root, 'web/dist');
  app.get('*', (c) => {
    const pathname = decodeURIComponent(new URL(c.req.url).pathname);
    const target = path.resolve(dist, `.${pathname}`);
    if (!target.startsWith(dist + path.sep))
      return c.body(fs.readFileSync(path.join(dist, 'index.html')), 200, {
        'Content-Type': 'text/html',
      });
    if (fs.existsSync(target) && fs.statSync(target).isFile())
      return c.body(fs.readFileSync(target), 200, {
        'Content-Type':
          (
            {
              '.js': 'text/javascript',
              '.css': 'text/css',
              '.svg': 'image/svg+xml',
              '.png': 'image/png',
              '.woff2': 'font/woff2',
              '.html': 'text/html',
            } as Record<string, string>
          )[path.extname(target)] ?? 'application/octet-stream',
      });
    return c.body(fs.readFileSync(path.join(dist, 'index.html')), 200, {
      'Content-Type': 'text/html',
    });
  });
  const url = await new Promise<string>((resolve) => {
    server = serve(
      { fetch: app.fetch, hostname: '127.0.0.1', port: 0 },
      (info) => resolve(`http://127.0.0.1:${info.port}`),
    );
  });
  const alerts = getIncidentStore(),
    tasks = getInvestigationStore();
  const request = (
    suffix: string,
    identity = 'qa-admin',
    options: RequestInit = {},
  ) =>
    fetch(`${url}/api/incident-alerts${suffix}`, {
      ...options,
      headers: {
        cookie: `miniclaw_session=${cookies.get(identity)}`,
        ...options.headers,
      },
    });
  const ingest = async (
    fingerprint: string,
    changes: Record<string, unknown> = {},
  ) => {
    const response = await request('/webhook', 'qa-admin', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        source: 'step6-demo',
        external_id: fingerprint,
        service: 'orders',
        environment: 'local',
        severity: 'critical',
        fingerprint,
        starts_at: new Date(Date.now() - 10000).toISOString(),
        status: 'firing',
        summary: `Connection pool exhausted pool_waiting acquire timeout (${fingerprint})`,
        ...changes,
      }),
    });
    assert.equal(response.status, 201);
    return ((await response.json()) as any).items[0].incident_id as string;
  };
  const read = randomBytes(32).toString('hex'),
    control = randomBytes(32).toString('hex');
  demo = await startLocalIncidentDemo({
    source_id: 'step6-pool',
    service: 'orders',
    environment: 'local',
    read_token: read,
    control_token: control,
    sample_interval_ms: 20,
  });
  let thresholdBaseline: any;
  const monitorQuery = async (from: string, to: string) => {
    const query = new URLSearchParams({
      query_id: randomUUID(),
      source_id: 'step6-pool',
      service: 'orders',
      environment: 'local',
      from,
      to,
      limit: '200',
    });
    const response = await fetch(
      `${demo!.base_url}/observations/metrics?${query}`,
      { headers: { authorization: `Bearer ${read}` } },
    );
    assert.equal(response.status, 200);
    return response.json();
  };
  if (step7) {
    await new Promise((resolve) => setTimeout(resolve, 40));
    thresholdBaseline = await monitorQuery(
      new Date(Date.now() - 1000).toISOString(),
      new Date().toISOString(),
    );
  }
  const config = await fetch(`${demo.base_url}/control/config`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${control}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      capacity: 1,
      hold_ms: step7 ? 180 : 100,
      acquire_timeout_ms: step7 ? 30 : 20,
      query_delay_ms: 0,
    }),
  });
  assert.equal(config.status, 200);
  await config.body?.cancel();
  assert.ok(
    (await runLocalDemoLoad(demo.base_url, read, 6, 6)).resource_failures > 0,
  );
  let live: string;
  if (step7) {
    const { poolThresholdAlert } =
      await import('../src/incident-demo-alert-rule.js');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const threshold = await poolThresholdAlert(
      await monitorQuery(thresholdBaseline.window.to, new Date().toISOString()),
      thresholdBaseline,
      'step6-demo',
    );
    assert.equal(threshold.status, 'firing');
    assert.ok(threshold.alert);
    const credential = alerts.issueCredential({
      owner_user_id: 'qa-admin',
      source: 'step6-demo',
      scopes: [{ service: 'orders', environment: 'local' }],
      expires_at: new Date(Date.now() + 300000).toISOString(),
    });
    const deliver = async (
      input = threshold.alert!,
      key = 'step7-threshold-delivery',
    ) => {
      const response = await fetch(`${url}/api/incident-alerts/webhook`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${credential.token}`,
          'content-type': 'application/json',
          'idempotency-key': key,
        },
        body: JSON.stringify(input),
      });
      assert.ok(response.status === 201 || response.status === 200);
      return response.json() as Promise<any>;
    };
    const receipts = await Promise.all(
      Array.from({ length: 8 }, () => deliver()),
    );
    live = receipts[0].items[0].incident_id;
    assert.equal(receipts.filter((r) => r.duplicate).length, 7);
    assert.ok(receipts.every((r) => r.items[0].incident_id === live));
    const extra = await deliver(
      {
        ...threshold.alert!,
        external_id: `${threshold.alert!.external_id}:second`,
      },
      'step7-second-alert',
    );
    assert.equal(extra.items[0].incident_id, live);
    assert.equal(tasks.list(live).length, 1);
    const denied = await fetch(`${url}/api/incident-alerts/webhook`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credential.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...threshold.alert!, environment: 'other' }),
    });
    assert.equal(denied.status, 403);
    await denied.body?.cancel();
    step7Summary.threshold = {
      rule: 'new timeouts >= 2 AND peak waiting >= 1',
      summary: threshold.alert!.summary,
      concurrent_deliveries: 8,
      duplicates: 7,
      aggregate_alerts: 2,
      scope_escape_http: 403,
    };
    checks.push(
      'actual threshold monitoring -> dedicated authenticated webhook -> eight concurrent identical deliveries / one task; another same-window alert aggregates; cross-environment credential rejected',
    );
  } else live = await ingest('observed');
  const worker = new IncidentInvestigationWorker(tasks, {
    repo_root: root,
    incident_id: live,
    wall_ms: 60000,
    sources: [
      {
        source_scope: sourceScope('qa-admin', 'step6-demo'),
        source_id: 'step6-pool',
        service: 'orders',
        environment: 'local',
        base_url: demo.base_url,
        read_token: read,
        instance_id: demo.instance_id,
      },
    ],
  });
  const result = await worker.tick();
  assert.equal(result?.state, 'blocked');
  assert.equal(result?.reason, 'no_configured_model');
  const view = tasks.detail(live, result!.run_id);
  assert.equal(view.run.model_requests, 0);
  assert.ok(view.observed_evidence.length >= 2);
  assert.ok(view.report.facts.length > 0);
  assert.ok(view.knowledge_references.length > 0);
  assert.ok(view.events.some((e) => e.event_type === 'ToolCalled'));
  checks.push(
    'actual local pool requests -> persisted Evidence/Runbook/events -> blocked escalation without configured model, model HTTP 0',
  );
  const queued = await ingest('queued'),
    failed = await ingest('failed'),
    retry = await ingest('retry'),
    running = await ingest('running');
  let clock = Date.now();
  const first = tasks.claim('qa-first', { incident_id: failed }, clock)!;
  tasks.retry(first, 'transport_failure', clock);
  clock += 10001;
  const last = tasks.claim('qa-second', { incident_id: failed }, clock)!;
  tasks.retry(last, 'transport_failure', clock);
  const wait = tasks.claim('qa-retry', { incident_id: retry })!;
  tasks.retry(wait, 'transport_failure');
  tasks.claim('qa-running', { incident_id: running });
  // Give the scope-limited member an explicit existing source grant, without leaking its credential.
  alerts.issueCredential({
    owner_user_id: 'qa-member',
    source: 'step6-member',
    scopes: [{ service: 'orders', environment: 'local' }],
    expires_at: new Date(Date.now() + 600000).toISOString(),
  });
  for (const [identity, expected] of [
    ['qa-basic', 403],
    ['qa-member', 404],
  ] as const)
    assert.equal(
      (await request(`/console/incidents/${live}`, identity)).status,
      expected,
    );
  assert.equal(
    (await fetch(`${url}/api/incident-alerts/console/incidents`)).status,
    401,
  );
  assert.equal((await request('/console/incidents?limit=21')).status, 400);
  const detail = (await (
    await request(`/console/incidents/${live}`)
  ).json()) as any;
  assert.equal(detail.source_mode, 'local_demo_observed');
  const evidence = (await (
    await request(
      `/console/incidents/${live}/runs/${result!.run_id}?section=evidence&limit=1`,
    )
  ).json()) as any;
  assert.equal(evidence.items.length, 1);
  assert.ok(evidence.has_more);
  const ref = evidence.items[0].evidence_id,
    knowledge = view.knowledge_references[0].reference_id;
  assert.equal(
    (
      await request(
        `/console/incidents/${live}/runs/${result!.run_id}?section=evidence&reference=${ref}`,
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await request(
        `/console/incidents/${live}/runs/${result!.run_id}?section=knowledge&reference=${knowledge}`,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(`/console/incidents/${queued}/runs/${result!.run_id}`))
      .status,
    404,
  );
  assert.equal(
    (
      await request(
        `/console/incidents/${live}/runs/${result!.run_id}?section=evidence&reference=missing`,
      )
    ).status,
    404,
  );
  checks.push(
    'real HTTP: 401/403/scoped 404, invalid query 400, foreign run/reference rejected, Evidence pagination',
  );
  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  browser = await chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await context.addCookies([
    { name: 'miniclaw_session', value: cookies.get('qa-admin')!, url },
  ]);
  const page = await context.newPage(),
    errors: string[] = [],
    writes: string[] = [];
  page.on('pageerror', (error: Error) => errors.push(error.message));
  page.on('console', (message: any) => {
    if (
      message.type() === 'error' &&
      !/status of (401|403|404)/.test(message.text())
    )
      errors.push(message.text());
  });
  page.on('request', (req: any) => {
    if (
      new URL(req.url()).pathname.startsWith('/api/') &&
      req.method() !== 'GET'
    )
      writes.push(req.method());
  });
  const screenshot = async (name: string) =>
    page.screenshot({ path: path.join(output, `${name}.png`), fullPage: true });
  await page.goto(`${url}/investigations`);
  await expect(page).toHaveTitle('调查任务 · 故障智巡');
  await expect(
    page.getByRole('heading', { name: '接入告警列表', exact: true }),
  ).toBeVisible();
  await expect(page.locator('.ic-live-table tbody tr')).toHaveCount(5);
  await expect(page.getByText('排队中', { exact: true })).toBeVisible();
  await expect(page.getByText('执行中', { exact: true })).toBeVisible();
  await expect(page.getByText('等待重试', { exact: true })).toBeVisible();
  await expect(page.getByText('最终失败', { exact: true })).toBeVisible();
  await expect(
    page.getByText('本地受控服务实时观测', { exact: false }),
  ).toBeVisible();
  await screenshot('01-list');
  await page
    .locator('.ic-live-table tbody tr')
    .filter({ hasText: step7 ? 'Local demo pool threshold' : 'observed' })
    .getByRole('link')
    .click();
  await expect(
    page.getByRole('heading', { name: '调查结论与影响范围' }),
  ).toBeVisible();
  await expect(
    page.getByText('尚无已保存诊断；不能从手册或状态推定根因。'),
  ).toBeVisible();
  await expect(
    page.getByText('未使用模型 · 宿主记录观测与升级', { exact: false }),
  ).toBeVisible();
  await screenshot('02-detail');
  await page
    .getByRole('button', { name: /查看证据 · items/ })
    .first()
    .click();
  await expect(page).toHaveURL(/reference=/);
  await expect(page.getByText(ref, { exact: true })).toBeVisible();
  await page
    .getByRole('button', { name: '定位此证据', exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/reference=/);
  await expect(
    page.getByText('原始观测片段与引用位置（items 从 0 开始）'),
  ).toBeVisible();
  await expect(page.locator('.ic-live-block pre')).toContainText(
    'acquire_timeouts',
  );
  await page.locator('.ic-live-block pre').scrollIntoViewIfNeeded();
  await screenshot('03-evidence-reference');
  await page.getByRole('button', { name: 'Runbook 引用', exact: true }).click();
  await expect(
    page.getByText('手册只支持调查步骤，不是当前故障成立的观测证据。').first(),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '定位此手册引用', exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/reference=/);
  await page.locator('.ic-live-block pre').scrollIntoViewIfNeeded();
  await screenshot('04-runbook-reference');
  await page
    .getByRole('link', { name: '在执行追踪页打开', exact: true })
    .click();
  await expect(page).toHaveTitle('执行追踪 · 故障智巡');
  await expect(
    page.getByRole('heading', { name: '真实事件时间线' }),
  ).toBeVisible();
  await expect(
    page.getByText('ToolCalled', { exact: false }).first(),
  ).toBeVisible();
  await screenshot('05-trace');
  const before = JSON.stringify(tasks.detail(live, result!.run_id));
  await page.getByRole('button', { name: '只读回放', exact: true }).click();
  await expect(page.getByRole('button', { name: '开始回放' })).toBeEnabled();
  await page.getByRole('button', { name: '下一事件', exact: true }).click();
  await page.getByRole('button', { name: '开始回放' }).click();
  await expect(page.locator('.ic-live-block strong').last()).not.toContainText(
    '1 /',
    { timeout: 5000 },
  );
  await page.getByRole('button', { name: '暂停回放' }).click();
  await screenshot('06-replay');
  assert.equal(JSON.stringify(tasks.detail(live, result!.run_id)), before);
  assert.deepEqual(writes, []);
  checks.push(
    'desktop 1440x900: list -> detail -> Evidence reference -> Runbook reference -> trace -> read-only Replay; no mutation requests and run unchanged',
  );
  await page.goto(`${url}/investigations?id=${queued}`);
  await expect(
    page.getByText('任务尚未领取，没有运行、取证或结论。'),
  ).toBeVisible();
  await screenshot('07-queued');
  await page.goto(`${url}/investigations?id=${failed}`);
  await expect(
    page.getByText('transport_failure', { exact: false }).first(),
  ).toBeVisible();
  await screenshot('08-failed');
  await page.goto(`${url}/investigations?service=no-such-service`);
  await expect(page.getByText('暂无接入告警', { exact: true })).toBeVisible();
  await screenshot('09-empty');
  await page.goto(`${url}/incidents`);
  await expect(page.locator('.ic-table tbody tr')).toHaveCount(12);
  await expect(
    page.getByRole('link', { name: '查看接入告警与现场调查' }),
  ).toBeVisible();
  await page.goto(`${url}/traces`);
  await expect(
    page.getByText('INC-001', { exact: false }).first(),
  ).toBeVisible();
  await expect(
    page.getByText('incident-runs', { exact: false }).first(),
  ).toBeVisible();
  await screenshot('10-legacy-history');
  await page.goto(`${url}/approvals`);
  await expect(page.getByRole('heading', { name: '审批中心' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '批准', exact: true }),
  ).toHaveCount(0);
  const restricted = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  await restricted.addCookies([
    { name: 'miniclaw_session', value: cookies.get('qa-basic')!, url },
  ]);
  const denied = await restricted.newPage();
  await denied.goto(`${url}/investigations`);
  await expect(denied.getByRole('alert')).toContainText('无权访问现场告警');
  await denied.screenshot({
    path: path.join(output, '11-unauthorized.png'),
    fullPage: true,
  });
  await restricted.close();
  const anonymous = await browser.newContext();
  const login = await anonymous.newPage();
  await login.goto(`${url}/investigations`);
  await expect(login).toHaveURL(/\/login$/);
  await anonymous.close();
  assert.deepEqual(errors, []);
  assert.equal(
    await page.evaluate('document.documentElement.scrollWidth <= innerWidth'),
    true,
  );
  checks.push(
    'desktop: empty/queued/running/retry/final failure, permission denial/anonymous login, 12 Fixtures, original history/approval shell; no unexpected JS errors',
  );
  if (step7) {
    let baselineRun = result!.run_id;
    if (process.argv.includes('--configured-model')) {
      // A separate host process reads the existing Provider at the real repo root.
      // Its only writable DB/source configuration belong to this temporary test harness.
      tasks.enqueue(live, true);
      const sourceFile = path.join(temp, 'step7-private-source.json');
      fs.writeFileSync(
        sourceFile,
        JSON.stringify([
          {
            source_scope: sourceScope('qa-admin', 'step6-demo'),
            source_id: 'step6-pool',
            service: 'orders',
            environment: 'local',
            base_url: demo.base_url,
            read_token: read,
            instance_id: demo.instance_id,
          },
        ]),
        { flag: 'wx', mode: 0o600 },
      );
      const child = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          'tsx',
          path.join(root, 'scripts/incident-investigation-worker.ts'),
          '--db',
          path.join(temp, 'data/db/messages.db'),
          '--source-config',
          sourceFile,
          '--configured-model',
          '--incident-id',
          live,
          '--max-model-requests',
          '2',
        ],
        { cwd: root, windowsHide: true, timeout: 80000, maxBuffer: 65536 },
      );
      const lines = child.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      const last = lines.at(-1)!;
      assert.ok(last.run_id);
      baselineRun = last.run_id;
      const actual = tasks.detail(live, baselineRun);
      assert.ok(actual.run.model_requests <= 2);
      step7Summary.real_model = {
        configuration: lines[0].model_configuration,
        mode: actual.run.mode,
        http_reservations: actual.run.model_requests,
        state: last.state,
        reason: last.reason,
        final_status: actual.run.status,
        final_model_diagnosis_passed:
          actual.run.mode === 'real_pi' && actual.run.status === 'DIAGNOSED',
        evidence: actual.observed_evidence.length,
        knowledge: actual.knowledge_references.length,
        actual_tool_calls: actual.events
          .filter((e) => e.event_type === 'ToolCalled')
          .map((e) => ({ tool: e.payload.tool, origin: e.payload.origin })),
        model_transport: tasks.db
          .prepare(
            'SELECT state,status_code FROM incident_investigation_model_requests WHERE run_id=?',
          )
          .all(baselineRun),
      };
      fs.unlinkSync(sourceFile);
      checks.push(
        'one genuine configured Provider E2E attempt, at most two HTTP reservations, separate process recovery of persisted task; no protocol stub',
      );
    } else step7Summary.real_model = { requested: false, http_reservations: 0 };
    const { verifyIncidentRecovery } =
      await import('../src/incident-recovery-verification.js');
    const { investigationHistory, exportInvestigationReplay } =
      await import('../src/incident-investigation-history.js');
    const baseline = tasks
      .evidence(baselineRun)
      .find((e) => e.source === 'metrics')!;
    assert.ok(baseline);
    const previous = JSON.stringify(tasks.detail(live, baselineRun));
    const restore = await fetch(`${demo.base_url}/control/config`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${control}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        capacity: 4,
        hold_ms: 20,
        acquire_timeout_ms: 500,
        query_delay_ms: 0,
      }),
    });
    assert.equal(restore.status, 200);
    await restore.body?.cancel();
    const manualAction = {
      kind: 'manual_demo_restore' as const,
      performed_at: new Date().toISOString(),
      reported_result: 'applied' as const,
      restored_capacity: 4,
    };
    const recoveredLoad = await runLocalDemoLoad(demo.base_url, read, 8, 8);
    assert.equal(recoveredLoad.success, 8);
    assert.equal(recoveredLoad.resource_failures, 0);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const recovery = await verifyIncidentRecovery(tasks, {
      repo_root: root,
      incident_id: live,
      baseline_run_id: baselineRun,
      baseline_evidence_id: baseline.evidence_id,
      manual_action: manualAction,
      source: {
        source_scope: sourceScope('qa-admin', 'step6-demo'),
        source_id: 'step6-pool',
        service: 'orders',
        environment: 'local',
        base_url: demo.base_url,
        read_token: read,
        instance_id: demo.instance_id,
      },
    });
    assert.equal(
      recovery.record.result,
      'verified',
      JSON.stringify(recovery.record),
    );
    assert.equal(JSON.stringify(tasks.detail(live, baselineRun)), previous);
    await demo.close();
    demo = undefined;
    const persisted = JSON.stringify(tasks.detail(live, recovery.run_id));
    const replayDir = path.join(temp, 'step7-readonly-replay');
    exportInvestigationReplay(tasks, live, recovery.run_id, replayDir);
    const replayCode =
      "import json,sys\nfrom pathlib import Path\nfrom incident_agent.replay import load_events,reconstruct_runs\nr=reconstruct_runs(load_events(sys.argv[1],Path(sys.argv[2])))\nassert len(r)==1 and not r[0].executed_actions\nassert r[0].status.value=='ESCALATED'\nprint(json.dumps({'status':r[0].status.value,'evidence':len(r[0].evidence_ids),'executed_actions':len(r[0].executed_actions)}))";
    const replay = JSON.parse(
      execFileSync(
        pythonHost.executable,
        [...pythonHost.prefix, '-B', '-c', replayCode, live, replayDir],
        {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 10000,
        },
      ),
    );
    db.closeDatabase();
    db.initDatabase();
    const reopened = getInvestigationStore();
    assert.equal(
      JSON.stringify(investigationHistory(reopened, live, recovery.run_id)),
      persisted,
    );
    await page.goto(`${url}/investigations?id=${live}&run=${recovery.run_id}`);
    await expect(page).toHaveTitle('调查任务 · 故障智巡');
    await expect(
      page.getByRole('heading', { name: '只读恢复验证记录' }),
    ).toBeVisible();
    await expect(page.getByText('恢复观测结果：通过')).toBeVisible();
    await expect(page.getByText(/故障最终调查状态：ESCALATED/)).toBeVisible();
    await page.locator('.ic-live-recovery').scrollIntoViewIfNeeded();
    await screenshot('12-recovery-record');
    await page
      .getByRole('button', { name: '查看恢复观测证据', exact: true })
      .first()
      .click();
    await expect(page).toHaveURL(/reference=/);
    await expect(page.locator('.ic-live-block pre')).toContainText(
      'requests_success',
    );
    await page.locator('.ic-live-block pre').scrollIntoViewIfNeeded();
    await screenshot('13-recovery-evidence');
    await page.getByRole('button', { name: '只读回放', exact: true }).click();
    await page.getByRole('button', { name: '下一事件', exact: true }).click();
    await screenshot('14-recovery-replay');
    assert.equal(
      JSON.stringify(reopened.detail(live, recovery.run_id)),
      persisted,
    );
    assert.deepEqual(writes, []);
    assert.deepEqual(errors, []);
    step7Summary.recovery = {
      manual_action: manualAction,
      result: recovery.record.result,
      final_status: 'ESCALATED',
      checks: recovery.record.checks,
      tool_calls: reopened.run(recovery.run_id).tool_calls,
      evidence: reopened.evidence(recovery.run_id).map((e) => ({
        source: e.source,
        timestamp: e.timestamp,
        correlation_id: e.correlation_id,
      })),
      model_http_reservations: 0,
      replay,
      restarted_database: true,
      source_stopped_before_replay: true,
    };
    checks.push(
      'manual controlled demo restore -> eight actual successful requests -> two fresh read tools -> bounded recovery verified, Incident stays ESCALATED; database restart and original Python/UI Replay after source stopped',
    );
  }
  if (process.argv.includes('--legacy-ui')) {
    const result = execFileSync(
      process.execPath,
      [
        path.join(root, 'web/node_modules/@playwright/test/cli.js'),
        'test',
        '--config=playwright.console.config.ts',
        '--project=desktop-1440',
        `--output=${path.join(output, 'legacy-ui')}`,
      ],
      {
        cwd: path.join(root, 'web'),
        env: { ...process.env, INCIDENT_CONSOLE_TEST_ROOT: temp },
        timeout: 60000,
        windowsHide: true,
        stdio: 'pipe',
      },
    );
    console.log(result.toString('utf8'));
    checks.push(
      'original Console Playwright regression on isolated Fixture/history catalog',
    );
  }
  fs.writeFileSync(
    path.join(output, 'acceptance.json'),
    JSON.stringify(
      {
        status: 'passed',
        browser: 'Chromium',
        viewport: '1440x900',
        model_requests:
          (step7Summary.real_model as any)?.http_reservations ?? 0,
        step7: step7Summary,
        checks,
        screenshots: fs.readdirSync(output).filter((n) => n.endsWith('.png')),
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      status: 'passed',
      checks: checks.length,
      model_requests: (step7Summary.real_model as any)?.http_reservations ?? 0,
      step7: step7Summary,
      screenshots: step7 ? 14 : 11,
      artifact_directory: output,
    }),
  );
} catch (error) {
  console.error(consoleRedact({ error: String(error) }));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await demo?.close();
  if (server)
    await new Promise<void>((resolve, reject) =>
      server!.close((error) => (error ? reject(error) : resolve())),
    );
  db.closeDatabase();
  process.chdir(root);
  assert.equal(path.dirname(temp), os.tmpdir());
  assert.ok(path.basename(temp).startsWith('v030-step6-'));
  fs.rmSync(temp, { recursive: true, force: true });
}
