/** Read-only incident investigation tools backed by committed demo fixtures. */
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  defineMcpTool,
  type McpToolDefinition,
  type McpToolResult,
} from './mcp-tool-types.js';

type Source = 'logs' | 'metrics' | 'trace' | 'git_diff';

type Evidence = {
  evidence_id: string;
  incident_id: string;
  source: Source;
  timestamp: string;
  content: string;
  correlation_id: string;
};

class FixtureError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const incidentSchema = z.object({
  incident_id: z.string().min(1),
  service: z.string().min(1),
  alert: z.string().min(1),
  started_at: z.iso.datetime({ offset: true }),
});
const logSchema = z.object({
  service: z.string(),
  entries: z
    .array(
      z.object({
        timestamp: z.iso.datetime({ offset: true }),
        request_id: z.string(),
        message: z.string(),
      }),
    )
    .min(1),
});
const metricsSchema = z.object({
  service: z.string(),
  samples: z
    .array(
      z.object({ observed_at: z.iso.datetime({ offset: true }) }).passthrough(),
    )
    .min(1),
});
const traceSchema = z.object({
  service: z.string(),
  traces: z
    .array(
      z
        .object({
          request_id: z.string(),
          spans: z
            .array(
              z
                .object({
                  ended_at: z.iso.datetime({ offset: true }),
                  http_status: z.number().optional(),
                })
                .passthrough(),
            )
            .min(1),
        })
        .passthrough(),
    )
    .min(1),
});

function defaultFixtureRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Host build: repository/incident_agent/fixtures. Docker: /app/incident_agent/fixtures.
  const candidates = [
    path.resolve(here, '../../../incident_agent/fixtures'),
    path.resolve(here, '../incident_agent/fixtures'),
  ];
  return (
    candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
  );
}

async function readText(file: string, missingCode: string): Promise<string> {
  try {
    const text = await readFile(file, 'utf8');
    if (!text.trim())
      throw new FixtureError('empty_data', 'Fixture data is empty.');
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FixtureError(missingCode, 'Fixture file does not exist.');
    }
    throw error;
  }
}

async function readJson<T>(
  file: string,
  schema: z.ZodType<T>,
  missingCode = 'fixture_missing',
): Promise<T> {
  const text = await readText(file, missingCode);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FixtureError('invalid_json', 'Fixture JSON cannot be parsed.');
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    const empty =
      parsed &&
      typeof parsed === 'object' &&
      (Object.values(parsed)[0] === undefined ||
        Object.values(parsed).some(
          (value) => Array.isArray(value) && value.length === 0,
        ));
    throw new FixtureError(
      empty ? 'empty_data' : 'invalid_fixture',
      empty ? 'Fixture data is empty.' : 'Fixture JSON has an invalid shape.',
    );
  }
  return result.data;
}

function evidenceResult(evidence: Evidence): McpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(evidence) }] };
}

function errorResult(incidentId: string, error: unknown): McpToolResult {
  const known =
    error instanceof FixtureError
      ? error
      : new FixtureError('fixture_read_failed', 'Fixture could not be read.');
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          incident_id: incidentId,
          error: known.code,
          message: known.message,
        }),
      },
    ],
  };
}

async function query(
  root: string,
  incidentId: string,
  source: Source,
): Promise<McpToolResult> {
  try {
    if (!/^[A-Za-z0-9_-]+$/.test(incidentId)) {
      throw new FixtureError(
        'invalid_incident_id',
        'Incident ID contains unsupported characters.',
      );
    }
    const folder = path.join(root, incidentId);
    if (!fs.existsSync(folder))
      throw new FixtureError(
        'incident_not_found',
        'Incident fixture does not exist.',
      );
    const incident = await readJson(
      path.join(folder, 'incident.json'),
      incidentSchema,
    );
    if (incident.incident_id !== incidentId)
      throw new FixtureError(
        'invalid_fixture',
        'Incident ID in fixture does not match the request.',
      );

    let timestamp: string;
    let content: string;
    let correlationId = incidentId;
    if (source === 'logs') {
      const logs = await readJson(path.join(folder, 'logs.json'), logSchema);
      if (logs.service !== incident.service)
        throw new FixtureError(
          'invalid_fixture',
          'Fixture service does not match incident.',
        );
      const last = logs.entries.at(-1)!;
      timestamp = last.timestamp;
      correlationId = last.request_id;
      content = JSON.stringify(logs.entries);
    } else if (source === 'metrics') {
      const metrics = await readJson(
        path.join(folder, 'metrics.json'),
        metricsSchema,
      );
      if (metrics.service !== incident.service)
        throw new FixtureError(
          'invalid_fixture',
          'Fixture service does not match incident.',
        );
      timestamp = metrics.samples.at(-1)!.observed_at;
      content = JSON.stringify(metrics.samples);
    } else if (source === 'trace') {
      const traces = await readJson(
        path.join(folder, 'trace.json'),
        traceSchema,
      );
      if (traces.service !== incident.service)
        throw new FixtureError(
          'invalid_fixture',
          'Fixture service does not match incident.',
        );
      const failing =
        traces.traces.find((trace) =>
          trace.spans.some((span) => span.http_status === 500),
        ) ?? traces.traces.at(-1)!;
      timestamp = failing.spans[0].ended_at;
      correlationId = failing.request_id;
      content = JSON.stringify(traces.traces);
    } else {
      const patch = await readText(
        path.join(folder, 'git_diff.patch'),
        'fixture_missing',
      );
      const date = patch.match(/^Date: (.+)$/m)?.[1];
      const parsedDate = date ? new Date(date) : new Date(NaN);
      if (Number.isNaN(parsedDate.getTime()))
        throw new FixtureError(
          'invalid_fixture',
          'Git diff has no valid change date.',
        );
      timestamp = parsedDate.toISOString();
      content = patch;
    }
    return evidenceResult({
      evidence_id: `${incidentId}:${source}`,
      incident_id: incidentId,
      source,
      timestamp,
      content,
      correlation_id: correlationId,
    });
  } catch (error) {
    return errorResult(incidentId, error);
  }
}

/** Reuse MiniClaw's existing MCP contract; Pi's adapter registers and executes these. */
export function createIncidentEvidenceTools(
  root = defaultFixtureRoot(),
): McpToolDefinition<any>[] {
  const args = {
    incident_id: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/, 'Use a plain incident ID, such as INC-001.'),
  };
  return (
    [
      [
        'query_logs',
        'logs',
        'Read fixture log entries for an incident. Returns one Evidence object.',
      ],
      [
        'query_metrics',
        'metrics',
        'Read fixture metric samples for an incident. Returns one Evidence object.',
      ],
      [
        'query_trace',
        'trace',
        'Read fixture request traces for an incident. Returns one Evidence object.',
      ],
      [
        'query_git_diff',
        'git_diff',
        'Read the fixture configuration diff for an incident. Returns one Evidence object.',
      ],
    ] as const
  ).map(([name, source, description]) =>
    defineMcpTool(name, description, args, async ({ incident_id }) =>
      query(root, incident_id, source),
    ),
  );
}
