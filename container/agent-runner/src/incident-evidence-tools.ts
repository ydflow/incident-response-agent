/** Read-only incident investigation tools backed by synthetic fixtures. */
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

const incidentSchema = z.strictObject({
  incident_id: z.string().min(1),
  service: z.string().min(1),
  alert: z.string().min(1),
  started_at: z.iso.datetime({ offset: true }),
});
const logSchema = z.object({
  service: z.string().min(1),
  entries: z
    .array(
      z.object({
        timestamp: z.iso.datetime({ offset: true }),
        level: z.string().min(1),
        request_id: z.string().min(1),
        component: z.string().min(1),
        message: z.string().min(1),
      }),
    )
    .min(1),
});
const metricsSchema = z.object({
  service: z.string().min(1),
  samples: z
    .array(
      z.object({ observed_at: z.iso.datetime({ offset: true }) }).passthrough(),
    )
    .min(1),
});
const traceSchema = z.object({
  service: z.string().min(1),
  traces: z.array(
    z
      .object({
        trace_id: z.string().min(1),
        request_id: z.string().min(1),
        spans: z
          .array(
            z
              .object({
                span_id: z.string().min(1),
                name: z.string().min(1),
                started_at: z.iso.datetime({ offset: true }),
                ended_at: z.iso.datetime({ offset: true }),
                duration_ms: z.number().nonnegative(),
                http_status: z.number().optional(),
              })
              .passthrough(),
          )
          .min(1),
      })
      .passthrough(),
  ),
});

type IncidentFixture = {
  incident: z.infer<typeof incidentSchema>;
  logs: z.infer<typeof logSchema>;
  metrics: z.infer<typeof metricsSchema>;
  traces: z.infer<typeof traceSchema>;
  patch: string;
  patchDate: Date;
};

const answerKeyPattern =
  /expected_root_cause|correct_answer|ground_truth|expected_status/i;

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

async function readText(
  file: string,
  missingCode: string,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const text = await readFile(file, { encoding: 'utf8', signal });
    if (!text.trim())
      throw new FixtureError('empty_data', 'Fixture data is empty.');
    if (answerKeyPattern.test(text))
      throw new FixtureError(
        'invalid_fixture',
        'Fixture contains evaluation-only data.',
      );
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new FixtureError(missingCode, 'Fixture file does not exist.');
    }
    throw error;
  }
}

/** The sole loader for the five agent-visible files of one synthetic case. */
export async function loadIncidentFixture(
  root: string,
  incidentId: string,
  signal?: AbortSignal,
): Promise<IncidentFixture> {
  if (!/^INC-\d{3}$/.test(incidentId)) {
    throw new FixtureError(
      'invalid_incident_id',
      'Use an INC-xxx incident ID.',
    );
  }
  const folder = path.join(root, incidentId);
  if (!fs.existsSync(folder))
    throw new FixtureError(
      'incident_not_found',
      'Incident fixture does not exist.',
    );
  const rootReal = fs.realpathSync(root);
  const folderReal = fs.realpathSync(folder);
  if (
    path.dirname(folderReal) !== rootReal ||
    fs.lstatSync(folder).isSymbolicLink()
  ) {
    throw new FixtureError(
      'invalid_fixture',
      'Fixture folder must stay inside the fixture root.',
    );
  }
  const file = (name: string): string => {
    const selected = path.join(folder, name);
    if (fs.existsSync(selected) && fs.lstatSync(selected).isSymbolicLink()) {
      throw new FixtureError(
        'invalid_fixture',
        'Fixture file must not be a symbolic link.',
      );
    }
    return selected;
  };
  const [incident, logs, metrics, traces, patch] = await Promise.all([
    readJson(file('incident.json'), incidentSchema, 'fixture_missing', signal),
    readJson(file('logs.json'), logSchema, 'fixture_missing', signal),
    readJson(file('metrics.json'), metricsSchema, 'fixture_missing', signal),
    readJson(file('trace.json'), traceSchema, 'fixture_missing', signal),
    readText(file('git_diff.patch'), 'fixture_missing', signal),
  ]);
  if (
    incident.incident_id !== incidentId ||
    [logs.service, metrics.service, traces.service].some(
      (service) => service !== incident.service,
    )
  ) {
    throw new FixtureError(
      'invalid_fixture',
      'Fixture incident or service does not match.',
    );
  }
  const date = patch.match(/^Date: (.+)$/m)?.[1];
  const patchDate = new Date(date ?? '');
  if (Number.isNaN(patchDate.getTime())) {
    throw new FixtureError(
      'invalid_fixture',
      'Git diff has no valid change date.',
    );
  }
  if (patchDate.getTime() > Date.parse(incident.started_at)) {
    throw new FixtureError(
      'invalid_fixture',
      'Git diff date follows the alert.',
    );
  }
  const sorted = (values: string[]) =>
    values.every(
      (value, index) =>
        Number.isFinite(Date.parse(value)) &&
        (index === 0 || Date.parse(values[index - 1]) <= Date.parse(value)),
    );
  if (
    !sorted(logs.entries.map((entry) => entry.timestamp)) ||
    !sorted(metrics.samples.map((sample) => sample.observed_at))
  ) {
    throw new FixtureError(
      'invalid_fixture',
      'Fixture timeline is not chronological.',
    );
  }
  for (const sample of metrics.samples) {
    const readings = Object.entries(sample).filter(
      ([key]) => key !== 'observed_at',
    );
    if (
      readings.length === 0 ||
      readings.some(
        ([, value]) => typeof value !== 'number' || !Number.isFinite(value),
      )
    ) {
      throw new FixtureError(
        'invalid_fixture',
        'Metric sample must contain finite numeric readings.',
      );
    }
  }
  for (const trace of traces.traces) {
    for (const span of trace.spans) {
      if (
        Date.parse(span.started_at) > Date.parse(span.ended_at) ||
        span.duration_ms !==
          Date.parse(span.ended_at) - Date.parse(span.started_at)
      ) {
        throw new FixtureError(
          'invalid_fixture',
          'Trace span has an invalid timeline.',
        );
      }
    }
  }
  return { incident, logs, metrics, traces, patch, patchDate };
}

async function readJson<T>(
  file: string,
  schema: z.ZodType<T>,
  missingCode = 'fixture_missing',
  signal?: AbortSignal,
): Promise<T> {
  const text = await readText(file, missingCode, signal);
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
  signal?: AbortSignal,
): Promise<McpToolResult> {
  try {
    const { incident, logs, metrics, traces, patch, patchDate } =
      await loadIncidentFixture(root, incidentId, signal);

    let timestamp: string;
    let content: string;
    let correlationId = incidentId;
    if (source === 'logs') {
      const last = logs.entries.at(-1)!;
      timestamp = last.timestamp;
      correlationId = last.request_id;
      content = JSON.stringify(logs.entries);
    } else if (source === 'metrics') {
      timestamp = metrics.samples.at(-1)!.observed_at;
      content = JSON.stringify(metrics.samples);
    } else if (source === 'trace') {
      const failing =
        traces.traces.find((trace) =>
          trace.spans.some((span) => span.http_status === 500),
        ) ?? traces.traces.at(-1);
      timestamp = failing?.spans[0].ended_at ?? incident.started_at;
      correlationId = failing?.request_id ?? incidentId;
      content = JSON.stringify(traces.traces);
    } else {
      timestamp = patchDate.toISOString();
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
      .regex(/^INC-\d{3}$/, 'Use an incident ID such as INC-001.'),
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
    defineMcpTool(name, description, args, async ({ incident_id }, extra) =>
      query(
        root,
        incident_id,
        source,
        (extra as { signal?: AbortSignal } | null)?.signal,
      ),
    ),
  );
}
