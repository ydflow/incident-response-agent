import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  startLocalIncidentDemo,
  runLocalDemoLoad,
} from '../src/incident-local-demo.js';
import {
  LocalDemoProvider,
  LIVE_RESPONSE_BYTES,
  type HostLiveSource,
  type LiveIncidentBinding,
} from '../container/agent-runner/src/incident-live-provider.js';
import {
  createIncidentProviderTools,
  FixtureProvider,
  LIVE_READ_TOOL_NAMES,
} from '../container/agent-runner/src/incident-provider-tools.js';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import { createIncidentEvidenceTools } from '../container/agent-runner/src/incident-evidence-tools.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const stop of close.splice(0).reverse()) await stop();
});
const token = () => randomBytes(32).toString('hex');
const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(result.content[0].text!);
async function local() {
  const read = token(),
    control = token();
  const demo = await startLocalIncidentDemo({
    source_id: 'pool-local',
    service: 'orders',
    environment: 'local',
    read_token: read,
    control_token: control,
    sample_interval_ms: 20,
  });
  close.push(demo.close);
  const id = `LIVE-${randomUUID()}`;
  const now = Date.now();
  const source: HostLiveSource = {
    source_id: 'pool-local',
    service: 'orders',
    environment: 'local',
    base_url: demo.base_url,
    instance_id: demo.instance_id,
    read_token: read,
  };
  const binding: LiveIncidentBinding = {
    incident_id: id,
    source_id: 'pool-local',
    service: 'orders',
    environment: 'local',
    allowed_from: new Date(now - 60000).toISOString(),
    allowed_to: new Date(now + 14 * 60000).toISOString(),
  };
  const provider = new LocalDemoProvider([source], [binding], 'test-run');
  const configure = async (config: unknown) =>
    fetch(`${demo.base_url}/control/config`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${control}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(config),
    });
  return { demo, read, control, source, binding, provider, id, configure };
}
async function fake(reply: (query: URL) => unknown, status = 200) {
  const server = createServer((req, res) => {
    const body = JSON.stringify(reply(new URL(req.url!, 'http://127.0.0.1')));
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no_address');
  close.push(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  );
  return `http://127.0.0.1:${address.port}`;
}
describe('running loopback service observations', () => {
  test('changing resource configuration changes actual request failures, logs and metrics; recovery succeeds', async () => {
    const l = await local();
    const initial = text(
      await l.provider.query('metrics', { incident_id: l.id }),
    );
    expect(JSON.parse(initial.content).items.at(-1)).toMatchObject({
      pool_capacity: 4,
      requests_total: 0,
    });
    expect(
      (
        await l.configure({
          capacity: 1,
          hold_ms: 500,
          acquire_timeout_ms: 50,
          query_delay_ms: 0,
        })
      ).status,
    ).toBe(200);
    const faulty = await runLocalDemoLoad(l.demo.base_url, l.read, 12, 8);
    expect(faulty.resource_failures).toBeGreaterThan(0);
    const faultyMetrics = JSON.parse(
      text(await l.provider.query('metrics', { incident_id: l.id })).content,
    );
    expect(faultyMetrics.items.at(-1)).toMatchObject({
      pool_capacity: 1,
      requests_total: 12,
      pool_active: 0,
      pool_waiting: 0,
    });
    expect(faultyMetrics.items.at(-1).acquire_timeouts).toBeGreaterThan(0);
    expect(
      faultyMetrics.items.some(
        (item: { pool_waiting: number }) => item.pool_waiting > 0,
      ),
    ).toBe(true);
    const logs = JSON.parse(
      text(await l.provider.query('logs', { incident_id: l.id })).content,
    );
    expect(
      logs.items.some(
        (item: { message: string }) => item.message === 'pool_timeout',
      ),
    ).toBe(true);
    expect(logs).toMatchObject({
      provider: 'local_demo',
      source_id: 'pool-local',
      service: 'orders',
      environment: 'local',
      status: 'success',
      instance_id: l.demo.instance_id,
    });
    expect(
      (
        await l.configure({
          capacity: 8,
          hold_ms: 10,
          acquire_timeout_ms: 500,
          query_delay_ms: 0,
        })
      ).status,
    ).toBe(200);
    const recovery = await runLocalDemoLoad(l.demo.base_url, l.read, 12, 8);
    expect(recovery).toMatchObject({
      success: 12,
      resource_failures: 0,
      unavailable: 0,
    });
    const recovered = JSON.parse(
      text(await l.provider.query('metrics', { incident_id: l.id })).content,
    ).items.at(-1);
    expect(
      recovered.requests_success - faultyMetrics.items.at(-1).requests_success,
    ).toBe(12);
    expect(recovered.acquire_timeouts).toBe(
      faultyMetrics.items.at(-1).acquire_timeouts,
    );
  });
  test('empty is successful bounded evidence; offline is an error and never becomes Fixture data', async () => {
    const l = await local();
    const before = text(await l.provider.query('logs', { incident_id: l.id }));
    expect(JSON.parse(before.content)).toMatchObject({
      status: 'empty',
      items: [],
    });
    await l.demo.close();
    const result = await l.provider.query('metrics', { incident_id: l.id });
    expect(result.isError).toBe(true);
    expect(text(result).error).toBe('unavailable');
    expect(text(result)).not.toHaveProperty('evidence_id');
  });
  test('upstream timeout and caller cancellation are different; late completion adds no evidence', async () => {
    const l = await local();
    await l.configure({
      capacity: 1,
      hold_ms: 20,
      acquire_timeout_ms: 500,
      query_delay_ms: 150,
    });
    const timeout = new LocalDemoProvider(
      [{ ...l.source, timeout_ms: 20 }],
      [l.binding],
      'timeout-run',
    );
    const gate = new IncidentApprovalGate();
    const defs = createIncidentProviderTools(
      { mode: 'live', provider: timeout },
      gate,
    );
    expect(text(await defs[0].handler({ incident_id: l.id }, {})).error).toBe(
      'timeout',
    );
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    expect(
      text(
        await l.provider.query(
          'metrics',
          { incident_id: l.id },
          controller.signal,
        ),
      ).error,
    ).toBe('cancelled');
    await delay(200);
    expect(gate.evidence.forIncident(l.id)).toEqual([]);
    expect(gate.events.snapshot().map((e) => e.event_type)).toEqual([
      'ToolCalled',
      'ToolResult',
      'ToolFailed',
    ]);
  });
  test('Trace and Git explicitly unsupported, not fake or empty observations', async () => {
    const l = await local();
    for (const kind of ['trace', 'git_diff'] as const) {
      const result = await l.provider.query(kind, { incident_id: l.id });
      expect(result.isError).toBe(true);
      expect(text(result).error).toBe('unsupported');
    }
  });
  test.each([
    { source_id: 'other' },
    { service: 'payments' },
    { environment: 'prod' },
  ])('rejects scope %j before network', async (change) => {
    const l = await local();
    expect(
      text(await l.provider.query('logs', { incident_id: l.id, ...change }))
        .error,
    ).toBe('scope_denied');
  });
  test.each(['before', 'after', 'future', 'overlong'])(
    'rejects %s time window',
    async (kind) => {
      const l = await local();
      const now = Date.now();
      const query = {
        incident_id: l.id,
        from: new Date(now - 1000).toISOString(),
        to: new Date(now).toISOString(),
      };
      if (kind === 'before')
        query.from = new Date(
          Date.parse(l.binding.allowed_from) - 1,
        ).toISOString();
      if (kind === 'after')
        query.to = new Date(Date.parse(l.binding.allowed_to) + 1).toISOString();
      if (kind === 'future') query.to = new Date(now + 10000).toISOString();
      if (kind === 'overlong')
        query.from = new Date(now - 16 * 60000).toISOString();
      expect(text(await l.provider.query('logs', query)).error).toBe(
        'time_window_denied',
      );
    },
  );
  test.each([
    { incident_id: '../INC-001' },
    { incident_id: 'INC-001' },
    { limit: 201 },
    { url: 'http://example.com' },
    { path: '../evaluation' },
    { credentials: 'not-allowed' },
  ])('rejects invalid Agent input %j', async (change) => {
    const l = await local();
    expect(
      text(await l.provider.query('logs', { incident_id: l.id, ...change }))
        .error,
    ).toBe('invalid_query');
  });
  test('unknown LIVE ID, missing source and inconsistent host binding fail closed', async () => {
    const l = await local();
    expect(
      text(
        await l.provider.query('metrics', {
          incident_id: `LIVE-${randomUUID()}`,
        }),
      ).error,
    ).toBe('incident_not_bound');
    expect(
      text(
        await new LocalDemoProvider([], [l.binding], 'missing').query(
          'metrics',
          { incident_id: l.id },
        ),
      ).error,
    ).toBe('unavailable');
    expect(
      text(
        await new LocalDemoProvider(
          [l.source],
          [{ ...l.binding, environment: 'prod' }],
          'wrong',
        ).query('metrics', { incident_id: l.id }),
      ).error,
    ).toBe('scope_denied');
  });
  test.each([
    'http://localhost:1234',
    'https://127.0.0.1:1234',
    'http://example.com:1234',
    'http://127.0.0.1:1234/private',
    'http://127.0.0.1:1234?token=x',
    'http://127.0.0.1:99999',
  ])('host targets constrained: %s', async (base_url) => {
    const l = await local();
    expect(
      () =>
        new LocalDemoProvider(
          [{ ...l.source, base_url }],
          [l.binding],
          'bad-source',
        ),
    ).toThrow('invalid_source_config');
  });
  test('limits and chronology are honored, provenance is retained and credentials stay out of observations', async () => {
    const l = await local();
    await runLocalDemoLoad(l.demo.base_url, l.read, 4, 2);
    const result = await l.provider.query('logs', {
      incident_id: l.id,
      limit: 1,
    });
    const evidence = text(result),
      observation = JSON.parse(evidence.content);
    expect(Object.keys(evidence).sort()).toEqual([
      'content',
      'correlation_id',
      'evidence_id',
      'incident_id',
      'source',
      'timestamp',
    ]);
    expect(observation.items).toHaveLength(1);
    expect(observation.truncated).toBe(true);
    expect(evidence.correlation_id).toBe(observation.query_id);
    expect(evidence.timestamp).toBe(observation.observed_at);
    expect(
      Buffer.byteLength(
        result.content[0].type === 'text' ? result.content[0].text : '',
      ),
    ).toBeLessThanOrEqual(LIVE_RESPONSE_BYTES);
    expect(JSON.stringify(result)).not.toContain(l.read);
    expect(JSON.stringify(result)).not.toContain(l.control);
    expect(JSON.stringify(result)).not.toContain(l.demo.base_url);
  });
  test('read token cannot control pool and control token cannot read observations', async () => {
    const l = await local();
    expect(
      (
        await fetch(`${l.demo.base_url}/control/config`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${l.read}`,
            'content-type': 'application/json',
          },
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${l.demo.base_url}/health`, {
          headers: { authorization: `Bearer ${l.control}` },
        })
      ).status,
    ).toBe(401);
    expect((await fetch(`${l.demo.base_url}/health`)).status).toBe(401);
    expect(
      (
        await l.configure({
          capacity: 0,
          hold_ms: 500,
          acquire_timeout_ms: 50,
          query_delay_ms: 0,
        })
      ).status,
    ).toBe(400);
  });
  test('one host run is bounded to 16 queries even when responses are small', async () => {
    const l = await local();
    for (let i = 0; i < 16; i++)
      expect(
        (await l.provider.query('metrics', { incident_id: l.id })).isError,
      ).not.toBe(true);
    expect(
      text(await l.provider.query('metrics', { incident_id: l.id })).error,
    ).toBe('query_budget_exhausted');
  });
});

describe('restricted policy/events/Pi routing and Fixture compatibility', () => {
  test('host-selected route in existing MCP entry returns only live read tools and requires an explicit gate', async () => {
    const l = await local();
    const gate = new IncidentApprovalGate();
    const ctx = {
      chatJid: 'test:local-demo',
      groupFolder: 'local-demo',
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      workspaceIpc: 'unused-live-ipc',
      workspaceGroup: 'unused-live-group',
      incidentProviderRoute: { mode: 'live' as const, provider: l.provider },
    };
    expect(() => createMcpTools(ctx)).toThrow(
      'incident_provider_requires_host_gate',
    );
    const definitions = createMcpTools({ ...ctx, incidentApprovalGate: gate });
    expect(definitions.map((d) => d.name)).toEqual([...LIVE_READ_TOOL_NAMES]);
    const pi = adaptClaudeMcpToolsToPi(definitions, {
      namespace: 'mcp__incident_live',
    });
    await pi[1].execute(
      'entry-call',
      { incident_id: l.id },
      new AbortController().signal,
    );
    expect(gate.evidence.forIncident(l.id)).toHaveLength(1);
  });
  test('live factory registers exactly four explicit SAFE tools; repeated collection appends unique evidence', async () => {
    const l = await local(),
      gate = new IncidentApprovalGate();
    const definitions = createIncidentProviderTools(
      { mode: 'live', provider: l.provider },
      gate,
    );
    expect(definitions.map((d) => d.name)).toEqual([...LIVE_READ_TOOL_NAMES]);
    const pi = adaptClaudeMcpToolsToPi(definitions, {
      namespace: 'mcp__incident_live',
    });
    for (const callId of ['first-call', 'second-call'])
      await pi[1].execute(
        callId,
        { incident_id: l.id },
        new AbortController().signal,
      );
    const evidence = gate.evidence.forIncident(l.id);
    expect(evidence).toHaveLength(2);
    expect(new Set(evidence.map((e) => e.evidence_id)).size).toBe(2);
    expect(
      evidence.every((e) =>
        e.evidence_id.startsWith(`${l.id}:test-run:metrics:`),
      ),
    ).toBe(true);
    expect(gate.events.snapshot().map((e) => e.event_type)).toEqual([
      'ToolCalled',
      'ToolResult',
      'EvidenceCollected',
      'ToolCalled',
      'ToolResult',
      'EvidenceCollected',
    ]);
    expect(gate.events.snapshot()[0].payload.tool_call_id).toBe('first-call');
    const unsupported = await pi[2].execute(
      'trace-call',
      { incident_id: l.id },
      new AbortController().signal,
    );
    expect(text(unsupported).error).toBe('unsupported');
    expect(gate.evidence.forIncident(l.id)).toHaveLength(2);
    expect(gate.events.snapshot().at(-1)?.event_type).toBe('ToolFailed');
  });
  test('policy narrowing, missing policy and unknown tools remain BLOCK with no observations', async () => {
    const l = await local();
    for (const readPolicy of [() => 'BLOCK' as const, () => undefined]) {
      const gate = new IncidentApprovalGate({ readPolicy });
      const tool = createIncidentProviderTools(
        { mode: 'live', provider: l.provider },
        gate,
      )[0];
      expect(text(await tool.handler({ incident_id: l.id }, {})).status).toBe(
        'blocked',
      );
      expect(gate.evidence.forIncident(l.id)).toEqual([]);
    }
    const execute = vi.fn();
    const gate = new IncidentApprovalGate();
    expect(text(await gate.runSafe('demo_control', execute)).status).toBe(
      'blocked',
    );
    expect(execute).not.toHaveBeenCalled();
  });
  test('all four new names are explicitly SAFE and preserve original unknown/ASK/BLOCK behavior', async () => {
    const gate = new IncidentApprovalGate();
    for (const name of LIVE_READ_TOOL_NAMES) {
      const execute = vi.fn(async () => ({
        content: [{ type: 'text' as const, text: 'safe' }],
      }));
      await gate.runSafe(name, execute);
      expect(execute).toHaveBeenCalledOnce();
    }
    const execute = vi.fn();
    await gate.runSafe('restart_service', execute);
    await gate.runSafe('delete_database', execute);
    expect(execute).not.toHaveBeenCalled();
  });
  test.each(
    Array.from(
      { length: 12 },
      (_, i) => `INC-${String(i + 1).padStart(3, '0')}`,
    ),
  )(
    '%s uses untouched strict Fixture tools and identical results',
    async (id) => {
      const root = path.resolve('incident_agent/fixtures');
      const fixture = new FixtureProvider(root);
      const original = createIncidentEvidenceTools(root);
      const routed = createIncidentProviderTools(
        { mode: 'fixture', provider: fixture },
        new IncidentApprovalGate(),
      );
      for (let i = 0; i < 4; i++)
        expect(await routed[i].handler({ incident_id: id }, {})).toEqual(
          await original[i].handler({ incident_id: id }, {}),
        );
      expect(
        (
          await fixture
            .tools()[0]
            .handler({ incident_id: `LIVE-${randomUUID()}` }, {})
        ).isError,
      ).toBe(true);
    },
  );
});

describe('host-bound response verification', () => {
  test('aggregate Evidence bytes exhaust a host run before the query count ceiling', async () => {
    const l = await local();
    const base_url = await fake((query) => ({
      provider: 'local_demo',
      source_id: 'pool-local',
      instance_id: l.demo.instance_id,
      service: 'orders',
      environment: 'local',
      query_id: query.searchParams.get('query_id'),
      kind: 'logs',
      observed_at: new Date().toISOString(),
      window: {
        from: query.searchParams.get('from'),
        to: query.searchParams.get('to'),
      },
      status: 'success',
      items: Array.from({ length: 200 }, () => ({
        timestamp: query.searchParams.get('to'),
        level: 'INFO',
        request_id: randomUUID(),
        component: 'resource_pool',
        message: 'pool_acquired',
        wait_ms: 1,
      })),
      truncated: false,
      retention_dropped: 0,
    }));
    const provider = new LocalDemoProvider(
      [{ ...l.source, base_url }],
      [l.binding],
      'bytes-budget',
    );
    let bytes = 0,
      success = 0;
    for (let i = 0; i < 16; i++) {
      const result = await provider.query('logs', {
        incident_id: l.id,
        limit: 200,
      });
      if (result.isError) {
        expect(text(result).error).toBe('query_budget_exhausted');
        break;
      }
      success++;
      bytes += Buffer.byteLength(
        result.content[0].type === 'text' ? result.content[0].text : '',
      );
    }
    expect(success).toBeGreaterThan(0);
    expect(success).toBeLessThan(16);
    expect(bytes).toBeLessThanOrEqual(256 * 1024);
  });
  test.each(['scope', 'query', 'time', 'oversize', 'shape'])(
    'rejects %s response without emitting evidence',
    async (kind) => {
      const l = await local();
      const base_url = await fake((query) => {
        const response = {
          provider: 'local_demo',
          source_id: l.source.source_id,
          instance_id: l.demo.instance_id,
          service: 'orders',
          environment: 'local',
          query_id: query.searchParams.get('query_id'),
          kind: 'logs',
          observed_at: new Date().toISOString(),
          window: {
            from: query.searchParams.get('from'),
            to: query.searchParams.get('to'),
          },
          status: 'empty',
          items: [],
          truncated: false,
          retention_dropped: 0,
        };
        if (kind === 'scope') response.environment = 'prod';
        if (kind === 'query') response.query_id = randomUUID();
        if (kind === 'time') response.observed_at = '2000-01-01T00:00:00Z';
        if (kind === 'oversize') return { body: 'x'.repeat(100000) };
        return kind === 'shape'
          ? { ...response, extra: 'untrusted' }
          : response;
      });
      const provider = new LocalDemoProvider(
        [{ ...l.source, base_url }],
        [l.binding],
        'bad-data',
      );
      const gate = new IncidentApprovalGate();
      const result = await createIncidentProviderTools(
        { mode: 'live', provider },
        gate,
      )[0].handler({ incident_id: l.id }, {});
      expect(text(result).error).toBe(
        kind === 'oversize' ? 'response_too_large' : 'invalid_response',
      );
      expect(gate.evidence.forIncident(l.id)).toEqual([]);
    },
  );
  test('redirect is not followed', async () => {
    const l = await local();
    let targetCalls = 0;
    const target = await fake(() => {
      targetCalls++;
      return {};
    });
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: `${target}/observations/logs` });
      res.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no_address');
    close.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    );
    const provider = new LocalDemoProvider(
      [{ ...l.source, base_url: `http://127.0.0.1:${address.port}` }],
      [l.binding],
      'redirect',
    );
    expect(
      text(await provider.query('logs', { incident_id: l.id })).error,
    ).toBe('unavailable');
    expect(targetCalls).toBe(0);
  });
});
