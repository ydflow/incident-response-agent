/** Host-selected routing; the ordinary MiniClaw Fixture registration is unchanged. */
import { createIncidentEvidenceTools } from './incident-evidence-tools.js';
import { IncidentApprovalGate } from './incident-approval-gate.js';
import { withIncidentToolEvents } from './incident-tool-events.js';
import { defineMcpTool, type McpToolDefinition } from './mcp-tool-types.js';
import { LocalDemoProvider, liveQueryShape } from './incident-live-provider.js';
import type { JsonValue } from './incident-agent-events.js';
import type { McpToolResult } from './mcp-tool-types.js';

export const LIVE_READ_TOOL_NAMES = [
  'query_live_logs',
  'query_live_metrics',
  'query_live_trace',
  'query_live_git_diff',
] as const;
/** Thin wrapper: same handlers/results, same strict five-file Fixture loader. */
export class FixtureProvider {
  constructor(private readonly root?: string) {}
  tools() {
    return createIncidentEvidenceTools(this.root);
  }
}
export type IncidentProviderRoute =
  | { mode: 'fixture'; provider: FixtureProvider }
  | { mode: 'live'; provider: LocalDemoProvider };

/** Returns only the chosen read-only tools; no shell, URL, control or approval tools. */
export function createIncidentProviderTools(
  route: IncidentProviderRoute,
  gate: IncidentApprovalGate,
  resultPayload?: (result: McpToolResult) => Record<string, JsonValue>,
): McpToolDefinition<any>[] {
  const definitions =
    route.mode === 'fixture'
      ? route.provider.tools()
      : (
          [
            ['query_live_logs', 'logs'],
            ['query_live_metrics', 'metrics'],
            ['query_live_trace', 'trace'],
            ['query_live_git_diff', 'git_diff'],
          ] as const
        ).map(([tool, kind]) =>
          defineMcpTool(
            tool,
            `Read bounded ${kind} observations from the host-bound LOCAL DEMO source. Trace/Git are unsupported. No Fixture fallback.`,
            liveQueryShape,
            (args, extra) =>
              route.provider.query(
                kind,
                args,
                (extra as { signal?: AbortSignal } | null)?.signal,
              ),
          ),
        );
  return definitions.map((definition) =>
    withIncidentToolEvents(
      {
        ...definition,
        handler: (args: any, extra: unknown) =>
          gate.runSafe(definition.name, () => definition.handler(args, extra)),
      },
      gate.events,
      {
        collectsEvidence: true,
        evidence: gate.evidence,
        timeoutMs: 5000,
        resultPayload,
      },
    ),
  );
}
