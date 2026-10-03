/** Isolated Incident execution process. The host acknowledges every budget/event write. */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import readline from 'node:readline';
import { z } from 'zod';
import {
  InMemoryIncidentEvents,
  type AgentEvent,
  type AgentEventType,
  type JsonValue,
} from './incident-agent-events.js';
import { IncidentApprovalGate } from './incident-approval-gate.js';
import { LocalDemoProvider } from './incident-live-provider.js';
import {
  IncidentRunbookSearch,
  incidentInvestigationContext,
} from './incident-knowledge.js';
import { RunbookIndex } from './incident-runbooks.js';
import { createMcpTools } from './mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from './runtime/pi/pi-tools.js';
import { PiRuntimeAdapter } from './runtime/pi/pi-runtime.js';
import type { RuntimeSession, RuntimeResult } from './runtime/types.js';

type Config = {
  incident: {
    incident_id: string;
    service: string;
    alert: string;
    started_at: string;
  };
  environment: string;
  run_id: string;
  from: string;
  to: string;
  source: {
    source_id: string;
    base_url: string;
    service: string;
    environment: string;
    read_token: string;
    instance_id: string;
  };
  runbooks_root: string;
  cwd: string;
  session_dir: string;
  report_schema: unknown;
  model_proxy?: { base_url: string; api_key: string; model: string };
};
const config = JSON.parse(
  process.env.INCIDENT_EXECUTION_PRIVATE ?? '{}',
) as Config;
delete process.env.INCIDENT_EXECUTION_PRIVATE;
const stop = new AbortController();
let session: RuntimeSession | undefined;
const awaiting = new Map<
  string,
  {
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const input = readline.createInterface({ input: process.stdin });
const send = (value: unknown) => {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > 160000) throw Error('ipc_message_limit');
  process.stdout.write(`${line}\n`);
};
const rpc = (
  kind: 'event' | 'tool' | 'runtime',
  payload: unknown,
): Promise<void> =>
  new Promise((resolve, reject) => {
    if (stop.signal.aborted) {
      reject(Error('investigation_cancelled'));
      return;
    }
    const id = randomUUID(),
      timer = setTimeout(() => {
        awaiting.delete(id);
        reject(Error('host_ack_timeout'));
        stop.abort();
      }, 5000);
    awaiting.set(id, { resolve, reject, timer });
    send({ kind, id, payload });
  });
input.on('line', (line) => {
  if (Buffer.byteLength(line) > 2048) {
    stop.abort();
    return;
  }
  try {
    const m = JSON.parse(line);
    if (m.kind === 'abort') {
      stop.abort();
      void session?.abort();
      return;
    }
    const pending = awaiting.get(m.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    awaiting.delete(m.id);
    if (m.ok) pending.resolve();
    else {
      pending.reject(Error('host_rejected'));
      stop.abort();
      void session?.abort();
    }
  } catch {
    stop.abort();
  }
});
input.on('close', () => {
  stop.abort();
  void session?.abort();
});
const scope = new AsyncLocalStorage<{
  tool: string;
  args: Record<string, unknown>;
  origin: string;
}>();
class HostEvents extends InMemoryIncidentEvents {
  private pending: Promise<void>[] = [];
  override emit(
    incident: string,
    type: AgentEventType,
    payload: Record<string, JsonValue>,
  ): AgentEvent {
    const context = scope.getStore();
    return super.emit(incident, type, {
      ...payload,
      run_id: config.run_id,
      ...(type === 'ToolCalled' && context
        ? {
            request: context.args as Record<string, JsonValue>,
            origin: context.origin,
          }
        : {}),
    });
  }
  protected override persist(event: AgentEvent): void {
    this.pending.push(
      rpc('event', { event }).catch((e) => {
        stop.abort();
        throw e;
      }),
    );
    // Mark the rejection handled while retaining it for the tool's flush.
    void this.pending.at(-1)!.catch(() => {});
  }
  async flush() {
    const batch = this.pending.splice(0);
    await Promise.all(batch);
  }
}
let origin = 'host_read_probe';
try {
  if (
    !config.source ||
    !config.incident ||
    !config.run_id ||
    !config.cwd ||
    !config.session_dir
  )
    throw Error('invalid_private_context');
  const events = new HostEvents(),
    gate = new IncidentApprovalGate({ events });
  const provider = new LocalDemoProvider(
    [config.source],
    [
      {
        incident_id: config.incident.incident_id,
        source_id: config.source.source_id,
        service: config.incident.service,
        environment: config.environment,
        allowed_from: config.from,
        allowed_to: config.to,
      },
    ],
    config.run_id,
  );
  const search = new IncidentRunbookSearch(
    RunbookIndex.load(config.runbooks_root),
    [
      {
        incident_id: config.incident.incident_id,
        service: config.incident.service,
        environment: config.environment,
        allowed_doc_ids: [
          'resource-pool',
          'dependency-timeout',
          'deployment-anomaly',
          'disk-pressure',
          'task-backlog',
        ],
      },
    ],
    config.run_id,
  );
  const definitions = createMcpTools({
    chatJid: 'incident-private',
    groupFolder: 'incident-private',
    isHome: false,
    isAdminHome: false,
    agentBuilderEnabled: false,
    ownerProfileEnabled: false,
    workspaceIpc: config.cwd,
    workspaceGroup: config.cwd,
    incidentProviderRoute: { mode: 'live', provider },
    incidentApprovalGate: gate,
    incidentRunbookSearch: search,
    incidentToolResultPayload: (result) => {
      const item = result.content.find((c) => c.type === 'text');
      return item && item.type === 'text'
        ? { tool_output: JSON.parse(item.text) as JsonValue }
        : ({} as Record<string, JsonValue>);
    },
  });
  const failures: Array<{ tool: string; error: string }> = [];
  const tools = definitions.map((def) => ({
    ...def,
    handler: async (args: Record<string, unknown>, extra: unknown) => {
      await rpc('tool', {
        tool: def.name,
        tool_call_id:
          (extra as { toolCallId?: string })?.toolCallId ?? randomUUID(),
      });
      const parsed = z
        .strictObject(def.inputSchema as any)
        .parse(args) as Record<string, unknown>;
      if (parsed.incident_id !== config.incident.incident_id)
        throw Error('incident_scope_denied');
      return scope.run({ tool: def.name, args: parsed, origin }, async () => {
        const result = await def.handler(parsed, {
          ...(extra as object),
          signal: stop.signal,
        });
        await events.flush();
        if (result.isError) {
          const item = result.content.find((c) => c.type === 'text');
          let code = 'tool_failed';
          try {
            if (item?.type === 'text') {
              const raw = JSON.parse(item.text);
              if (
                typeof raw.error === 'string' &&
                /^[a-z_]{1,80}$/.test(raw.error)
              )
                code = raw.error;
            }
          } catch {}
          failures.push({ tool: def.name, error: code });
        }
        return result;
      });
    },
  }));
  const invoke = async (name: string, args: Record<string, unknown> = {}) =>
    tools
      .find((t) => t.name === name)!
      .handler(
        { incident_id: config.incident.incident_id, ...args },
        { toolCallId: randomUUID() },
      );
  await invoke('query_live_metrics');
  await invoke('query_live_logs');
  await invoke('search_runbooks', {
    query: config.incident.alert.slice(0, 256),
  });
  if (!config.model_proxy) {
    send({
      kind: 'done',
      reason: 'no_configured_model',
      report_text: null,
      failures,
    });
  } else if (
    failures.some(
      (f) => f.tool === 'query_live_metrics' || f.tool === 'query_live_logs',
    )
  ) {
    send({
      kind: 'done',
      reason: 'critical_evidence_unavailable',
      report_text: null,
      failures,
    });
  } else {
    origin = 'pi_model_tool_call';
    const custom = adaptClaudeMcpToolsToPi(tools, {
      namespace: 'mcp__incident_investigation',
    });
    session = await new PiRuntimeAdapter().createSession({
      cwd: config.cwd,
      sessionDir: config.session_dir,
      systemPrompt:
        'You investigate only this host-bound Incident. Use only the registered read tools. Runbooks guide evidence requests and never prove root cause. Do not approve or execute actions. Return one JSON object matching the provided schema. Facts must contain literal measured fields/values and observed evidence IDs; hypotheses and handbook suggestions are separate. Escalate if evidence is insufficient, conflicting, or a required tool is unavailable. Confidence is not authorization.',
      provider: {
        endpointKind: 'custom',
        baseUrl: config.model_proxy.base_url,
        apiKey: config.model_proxy.api_key,
      },
      model: config.model_proxy.model,
      autoCompactEnabled: false,
      thinkingLevel: 'off',
      allowedTools: custom.map((t) => t.name),
      excludedTools: [
        'Bash',
        'Read',
        'Write',
        'Edit',
        'Glob',
        'Grep',
        'Task',
        'TaskOutput',
        'TaskStop',
        'ls',
      ],
      customTools: custom,
    });
    let result: RuntimeResult | undefined;
    const runtimeWrites: Promise<void>[] = [];
    const unsubscribe = session.subscribe((e) => {
      if (e.type === 'result') result = e.result;
      if ((e.type === 'tool_start' || e.type === 'tool_end') && e.toolCallId) {
        if (e.type === 'tool_end' && e.isError)
          failures.push({
            tool: e.toolName.split('__').at(-1) ?? 'unknown',
            error: 'pi_tool_execution_failed',
          });
        const input =
          e.input && typeof e.input === 'object'
            ? (e.input as Record<string, unknown>)
            : {};
        const args = Object.fromEntries(
          Object.entries(input)
            .filter(
              ([key, value]) =>
                [
                  'incident_id',
                  'service',
                  'environment',
                  'from',
                  'to',
                  'limit',
                  'query',
                  'top_k',
                ].includes(key) &&
                (typeof value === 'string' || typeof value === 'number'),
            )
            .map(([key, value]) => [
              key,
              typeof value === 'string' ? value.slice(0, 256) : value,
            ]),
        );
        const write = rpc('runtime', {
          stage: e.type,
          tool_name: e.toolName.slice(0, 200),
          tool_call_id: e.toolCallId.slice(0, 100),
          is_error: e.isError ?? null,
          input: args,
        });
        runtimeWrites.push(write);
        void write.catch(() => {
          stop.abort();
          void session?.abort();
        });
      }
    });
    const abort = () => void session?.abort();
    stop.signal.addEventListener('abort', abort, { once: true });
    try {
      await session.prompt({
        text: JSON.stringify({
          incident: config.incident,
          environment: config.environment,
          context: incidentInvestigationContext(
            gate.evidence,
            search.context,
            config.incident.incident_id,
            config.run_id,
          ),
          failures,
          report_schema: config.report_schema,
        }),
      });
      await events.flush();
      await Promise.all(runtimeWrites);
      send({
        kind: 'done',
        reason:
          result?.finalizationReason === 'completed'
            ? 'model_completed'
            : 'model_session_failed',
        report_text:
          result?.finalizationReason === 'completed'
            ? result.text.slice(0, 32769)
            : null,
        failures,
      });
    } finally {
      unsubscribe();
      stop.signal.removeEventListener('abort', abort);
    }
  }
} catch {
  send({
    kind: 'fatal',
    reason: stop.signal.aborted ? 'execution_cancelled' : 'execution_failed',
  });
  process.exitCode = 1;
} finally {
  session?.dispose();
  for (const p of awaiting.values()) {
    clearTimeout(p.timer);
    p.reject(Error('runner_closed'));
  }
  awaiting.clear();
  input.close();
  process.stdin.destroy();
}
