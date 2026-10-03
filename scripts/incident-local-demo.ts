/** Trusted operator CLI. Configuration and control are never Agent tools. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  startLocalIncidentDemo,
  runLocalDemoLoad,
} from '../src/incident-local-demo.js';
import { LocalDemoProvider } from '../container/agent-runner/src/incident-live-provider.js';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';

const args = z.strictObject({
  command: z.enum(['serve', 'fault', 'recover', 'load', 'query']),
  incident_id: z.string().optional(),
  kind: z.enum(['logs', 'metrics', 'trace', 'git_diff']).optional(),
  requests: z.coerce.number().int().min(1).max(100).default(12),
  concurrency: z.coerce.number().int().min(1).max(16).default(8),
  ttl_seconds: z.coerce.number().int().min(30).max(600).default(600),
});
function parseArgs() {
  const [command, ...flags] = process.argv.slice(2);
  const values: Record<string, string> = { command };
  for (let i = 0; i < flags.length; i += 2) {
    if (
      !/^--[a-z-]+$/.test(flags[i]) ||
      !flags[i + 1] ||
      flags[i + 1].startsWith('--')
    )
      throw new Error('invalid_cli_arguments');
    const key = flags[i].slice(2).replaceAll('-', '_');
    if (Object.hasOwn(values, key)) throw new Error('duplicate_cli_argument');
    values[key] = flags[i + 1];
  }
  return args.parse(values);
}
function hostConfig(allowZero = false) {
  const port = Number(process.env.FAULT_DEMO_PORT ?? 43210);
  if (
    !Number.isInteger(port) ||
    port < 0 ||
    (!allowZero && port === 0) ||
    port > 65535
  )
    throw new Error('invalid_demo_port');
  const read = process.env.FAULT_DEMO_READ_TOKEN ?? '',
    control = process.env.FAULT_DEMO_CONTROL_TOKEN ?? '';
  const service = process.env.FAULT_DEMO_SERVICE ?? 'payment-service';
  const environment = process.env.FAULT_DEMO_ENVIRONMENT ?? 'local';
  const source_id = process.env.FAULT_DEMO_SOURCE_ID ?? 'pool-local';
  return {
    port,
    read,
    control,
    service,
    environment,
    source_id,
    base_url: `http://127.0.0.1:${port}`,
  };
}
try {
  const input = parseArgs(),
    host = hostConfig(input.command === 'serve');
  if (input.command === 'serve') {
    const demo = await startLocalIncidentDemo({
      source_id: host.source_id,
      service: host.service,
      environment: host.environment,
      read_token: host.read,
      control_token: host.control,
      port: host.port,
    });
    console.log(
      JSON.stringify({
        demo: true,
        port: Number(new URL(demo.base_url).port),
        instance_id: demo.instance_id,
        service: host.service,
        environment: host.environment,
        source_id: host.source_id,
        ttl_seconds: input.ttl_seconds,
      }),
    );
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, input.ttl_seconds * 1000);
      const stop = () => {
        clearTimeout(timer);
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
    await demo.close();
  } else if (input.command === 'load') {
    console.log(
      JSON.stringify(
        await runLocalDemoLoad(
          host.base_url,
          host.read,
          input.requests,
          input.concurrency,
        ),
      ),
    );
  } else if (input.command === 'fault' || input.command === 'recover') {
    if (!/^[0-9a-f]{64}$/.test(host.control))
      throw new Error('missing_demo_control_token');
    const config =
      input.command === 'fault'
        ? {
            capacity: 1,
            hold_ms: 500,
            acquire_timeout_ms: 50,
            query_delay_ms: 0,
          }
        : {
            capacity: 8,
            hold_ms: 10,
            acquire_timeout_ms: 500,
            query_delay_ms: 0,
          };
    const result = await fetch(`${host.base_url}/control/config`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${host.control}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(config),
      signal: AbortSignal.timeout(3000),
      redirect: 'error',
    });
    if (!result.ok) {
      await result.body?.cancel();
      throw new Error('demo_control_unavailable');
    }
    await result.body?.cancel();
    console.log(
      JSON.stringify({ demo: true, operator_action: input.command, config }),
    );
  } else {
    if (!input.incident_id || !input.kind)
      throw new Error('query_requires_incident_id_and_kind');
    const now = Date.now();
    const provider = new LocalDemoProvider(
      [
        {
          source_id: host.source_id,
          service: host.service,
          environment: host.environment,
          base_url: host.base_url,
          read_token: host.read,
          instance_id: process.env.FAULT_DEMO_INSTANCE_ID || undefined,
        },
      ],
      [
        {
          incident_id: input.incident_id,
          source_id: host.source_id,
          service: host.service,
          environment: host.environment,
          allowed_from: new Date(now - 5 * 60000).toISOString(),
          allowed_to: new Date(now + 10 * 60000).toISOString(),
        },
      ],
      `local-probe-${randomUUID()}`,
    );
    const gate = new IncidentApprovalGate();
    const tools = adaptClaudeMcpToolsToPi(
      createMcpTools({
        chatJid: 'local:demo-probe',
        groupFolder: 'local-demo',
        isHome: false,
        isAdminHome: false,
        agentBuilderEnabled: false,
        ownerProfileEnabled: false,
        workspaceIpc: 'unused-demo-ipc',
        workspaceGroup: 'unused-demo-group',
        incidentProviderRoute: { mode: 'live', provider },
        incidentApprovalGate: gate,
      }),
      { namespace: 'mcp__incident_live' },
    );
    const tool = tools.find(
      (t) => t.name === `mcp__incident_live__query_live_${input.kind}`,
    )!;
    // No ExtensionContext in this standalone probe; the existing adapter
    // ignores the SDK's final two arguments. All source validation stays on.
    const result = await tool.execute(
      `probe-${randomUUID()}`,
      { incident_id: input.incident_id },
      new AbortController().signal,
      undefined,
      undefined as never,
    );
    const value = JSON.parse((result.content[0] as { text: string }).text);
    if (value.error || value.status === 'blocked') {
      console.log(
        JSON.stringify({
          demo: true,
          ...value,
          event_types: gate.events.snapshot().map((e) => e.event_type),
        }),
      );
      process.exitCode = 1;
    } else {
      const observed = JSON.parse(value.content);
      console.log(
        JSON.stringify({
          demo: true,
          evidence_id: value.evidence_id,
          incident_id: value.incident_id,
          source: value.source,
          correlation_id: value.correlation_id,
          provider: observed.provider,
          source_id: observed.source_id,
          instance_id: observed.instance_id,
          service: observed.service,
          environment: observed.environment,
          observed_at: observed.observed_at,
          window: observed.window,
          status: observed.status,
          item_count: observed.items.length,
          truncated: observed.truncated,
          retention_dropped: observed.retention_dropped,
          ...(input.kind === 'metrics'
            ? { latest_sample: observed.items.at(-1) ?? null }
            : {
                messages: [
                  ...new Set(
                    observed.items.map(
                      (item: { message: string }) => item.message,
                    ),
                  ),
                ],
              }),
          event_types: gate.events.snapshot().map((e) => e.event_type),
        }),
      );
    }
  }
} catch (error) {
  // No credentials, request bodies, source addresses or raw logs in diagnostics.
  console.error(
    JSON.stringify({
      demo: true,
      error:
        error instanceof z.ZodError
          ? 'invalid_cli_or_host_config'
          : error instanceof Error && /^[a-z_]+$/.test(error.message)
            ? error.message
            : 'demo_command_failed',
    }),
  );
  process.exitCode = 1;
}
