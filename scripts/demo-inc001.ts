/** One real Pi Agent turn against the read-only INC-001 tools. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import {
  getDefaultProviderId,
  getEnabledProviders,
} from '../src/runtime-config.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import { JsonlIncidentEvents } from '../container/agent-runner/src/incident-agent-events.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';
import { PiRuntimeAdapter } from '../container/agent-runner/src/runtime/pi/pi-runtime.js';

const names = ['query_metrics', 'query_logs', 'query_trace', 'query_git_diff'];
let stage = 'load_provider';
let observedToolCalls = 0;

async function main(): Promise<void> {
  const providers = getEnabledProviders();
  const selected =
    providers.find((provider) => provider.id === getDefaultProviderId()) ??
    providers[0];
  if (
    !selected?.anthropicModel ||
    !(selected.anthropicApiKey || selected.anthropicAuthToken)
  ) {
    throw new Error(
      'No configured model credential is available for the MiniClaw demo.',
    );
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-inc001-demo-'));
  try {
    stage = 'create_session';
    const runDirectory = process.env.MINICLAW_INCIDENT_RUNS_DIR;
    const incidentGate = new IncidentApprovalGate({
      events: runDirectory ? new JsonlIncidentEvents(runDirectory) : undefined,
    });
    const definitions = createMcpTools({
      chatJid: 'demo:INC-001',
      groupFolder: 'demo',
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      workspaceIpc: path.join(temp, 'ipc'),
      workspaceGroup: temp,
      incidentApprovalGate: incidentGate,
    }).filter((tool) => names.includes(tool.name));
    const customTools = adaptClaudeMcpToolsToPi(definitions, {
      namespace: 'mcp__miniclaw',
    });
    const runtime = new PiRuntimeAdapter();
    const session = await runtime.createSession({
      cwd: temp,
      sessionDir: path.join(temp, '.pi', 'sessions'),
      model: selected.anthropicModel,
      provider: {
        endpointKind: selected.type === 'third_party' ? 'custom' : 'official',
        baseUrl: selected.anthropicBaseUrl || undefined,
        apiKey: selected.anthropicApiKey || selected.anthropicAuthToken,
      },
      systemPrompt:
        'You investigate incidents using only the available read-only evidence tools. Do not guess. Return a JSON object with incident_id, root_cause, confidence (0 to 1), evidence_ids, and recommendation.',
      allowedTools: customTools.map((tool) => tool.name),
      customTools,
    });
    const calls = new Map<
      string,
      { tool: string; tool_call_id: string; evidence_id?: string }
    >();
    let finalText = '';
    const unsubscribe = session.subscribe((event) => {
      if (
        event.type === 'tool_start' &&
        names.some((name) => event.toolName.endsWith(name))
      ) {
        calls.set(event.toolCallId, {
          tool: event.toolName,
          tool_call_id: event.toolCallId,
        });
        observedToolCalls = calls.size;
      }
      if (event.type === 'tool_end' && event.result) {
        const record = calls.get(event.toolCallId);
        const content = (event.result as { content?: Array<{ text?: string }> })
          .content;
        if (record && content?.[0]?.text) {
          try {
            record.evidence_id = (
              JSON.parse(content[0].text) as { evidence_id?: string }
            ).evidence_id;
          } catch {
            /* A failed tool result remains visible through its missing evidence ID. */
          }
        }
      }
      if (event.type === 'result') finalText = event.result.text;
    });
    const timeout = setTimeout(() => void session.abort(), 120_000);
    try {
      stage = 'prompt';
      await session.prompt({
        text: '调查 INC-001 的故障原因。请分别调用 query_metrics、query_logs、query_trace、query_git_diff 读取证据，再根据证据给出诊断。最终只输出 Diagnosis JSON。',
      });
    } finally {
      clearTimeout(timeout);
      unsubscribe();
      session.dispose();
    }
    const toolCalls = [...calls.values()];
    stage = 'verify_tool_calls';
    const calledNames = new Set(
      toolCalls.map((call) => call.tool.replace('mcp__miniclaw__', '')),
    );
    if (
      names.some((name) => !calledNames.has(name)) ||
      toolCalls.some((call) => !call.evidence_id)
    ) {
      throw new Error('Agent did not complete all four evidence ToolCalls.');
    }
    let diagnosis: z.infer<typeof diagnosisSchema>;
    stage = 'parse_diagnosis';
    try {
      diagnosis = parseDiagnosis(finalText);
    } catch {
      const failedResponseFile = path.resolve(
        'data/incident-demo/INC-001-last-failed-response.txt',
      );
      fs.mkdirSync(path.dirname(failedResponseFile), { recursive: true });
      fs.writeFileSync(failedResponseFile, finalText);
      throw new Error('Agent response did not match the Diagnosis contract.');
    }
    const returnedIds = new Set(toolCalls.map((call) => call.evidence_id));
    if (
      diagnosis.incident_id !== 'INC-001' ||
      diagnosis.evidence_ids.some((id) => !returnedIds.has(id))
    ) {
      throw new Error('Agent Diagnosis referenced an unobserved Evidence ID.');
    }
    incidentGate.events.emit('INC-001', 'DiagnosisCreated', {
      evidence_ids: diagnosis.evidence_ids,
      confidence: diagnosis.confidence,
      root_cause: diagnosis.root_cause,
    });
    const output = {
      incident_id: 'INC-001',
      tool_calls: toolCalls,
      diagnosis,
      events: incidentGate.events.snapshot(),
    };
    stage = 'persist';
    const outputFile = path.resolve('data/incident-demo/INC-001-last-run.json');
    fs.mkdirSync(path.dirname(outputFile), { recursive: true });
    fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const diagnosisSchema = z.object({
  incident_id: z.string().min(1),
  root_cause: z.string().min(1),
  confidence: z.number().finite().min(0).max(1),
  evidence_ids: z
    .array(z.string().min(1))
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length),
  recommendation: z.string().min(1),
});

function parseDiagnosis(text: string): z.infer<typeof diagnosisSchema> {
  // Models may add an explanation before a fenced JSON block. Validate each
  // candidate against the same contract instead of trusting the first braces.
  const candidates = [
    text.trim(),
    ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map((match) =>
      match[1].trim(),
    ),
  ];
  for (const candidate of candidates) {
    try {
      return diagnosisSchema.parse(JSON.parse(candidate));
    } catch {
      /* Try the next candidate. */
    }
  }
  throw new Error('No valid Diagnosis JSON was found in the Agent response.');
}

void main().catch(() => {
  // Provider errors can contain endpoints, headers or credentials. Keep diagnostics private.
  process.stderr.write(
    `INC-001 live Agent demo failed at ${stage}; observed_tool_calls=${observedToolCalls}. No verified diagnosis was recorded.\n`,
  );
  process.exitCode = 1;
});
