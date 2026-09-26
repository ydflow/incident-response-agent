/** One real Pi Agent turn for a synthetic incident; no test model or answer key. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { getDefaultProviderId, getEnabledProviders } from '../src/runtime-config.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import { JsonlIncidentEvents } from '../container/agent-runner/src/incident-agent-events.js';
import { loadIncidentFixture } from '../container/agent-runner/src/incident-evidence-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';
import { PiRuntimeAdapter } from '../container/agent-runner/src/runtime/pi/pi-runtime.js';

const incidentId = process.argv[2];
const evidenceNames = ['query_logs', 'query_metrics', 'query_trace', 'query_git_diff'];
const remediationNames = ['restart_service', 'rollback_config', 'modify_config'];
const names = [...evidenceNames, ...remediationNames];
const decisionSchema = z.object({
  incident_id: z.string(),
  decision: z.enum(['diagnose', 'escalate']),
  root_cause: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  evidence_ids: z.array(z.string()),
  reason: z.string(),
  recommendation: z.string(),
});

function parseDecision(text: string): z.infer<typeof decisionSchema> | null {
  const candidates = [text.trim(), ...[...text.matchAll(/```(?:json)?\s*([\s\S]*?)\s*```/gi)].map(match => match[1].trim())];
  for (const candidate of candidates) {
    try { return decisionSchema.parse(JSON.parse(candidate)); } catch { /* Preserve the raw response. */ }
  }
  return null;
}

async function main(): Promise<void> {
  if (!/^INC-\d{3}$/.test(incidentId ?? '')) throw new Error('invalid_incident_id');
  const fixture = await loadIncidentFixture(path.resolve('incident_agent/fixtures'), incidentId);
  const providers = getEnabledProviders();
  const selected = providers.find(provider => provider.id === getDefaultProviderId()) ?? providers[0];
  if (!selected?.anthropicModel || !(selected.anthropicApiKey || selected.anthropicAuthToken)) {
    throw new Error('no_configured_model_credential');
  }
  const runDirectory = process.env.MINICLAW_INCIDENT_RUNS_DIR;
  if (!runDirectory) throw new Error('missing_event_directory');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `miniclaw-${incidentId}-live-`));
  let executorCalled = false;
  try {
    const gate = new IncidentApprovalGate({
      events: new JsonlIncidentEvents(runDirectory),
      executor: async () => {
        executorCalled = true;
        throw new Error('This demo never approves remediation.');
      },
    });
    const definitions = createMcpTools({
      chatJid: `live-demo:${incidentId}`,
      groupFolder: 'live-demo',
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      workspaceIpc: path.join(temp, 'ipc'),
      workspaceGroup: temp,
      incidentApprovalGate: gate,
    }).filter(tool => names.includes(tool.name));
    const customTools = adaptClaudeMcpToolsToPi(definitions, { namespace: 'mcp__miniclaw' });
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
      systemPrompt: [
        'You are investigating a synthetic service incident. Use only the provided incident tools as evidence.',
        'Read logs, metrics, trace, and git diff before deciding. Normal or empty results are meaningful.',
        'If sources disagree or a causal link cannot be established, escalate for human review instead of guessing.',
        'Remediation tools only submit an approval request; no action may execute without a human decision.',
        'Return one JSON object with incident_id, decision (diagnose or escalate), root_cause (string or null),',
        'confidence (0 to 1), evidence_ids (observed IDs only), reason, and recommendation.',
        'For escalation, use null root_cause. Do not claim that a remediation has been executed.',
      ].join(' '),
      allowedTools: customTools.map(tool => tool.name),
      customTools,
    });
    const calls: Array<{tool: string; tool_call_id: string; evidence_id?: string; result_status?: string; error?: string}> = [];
    let finalText = '';
    const unsubscribe = session.subscribe(event => {
      if (event.type === 'tool_start') {
        if (!calls.some(item => item.tool_call_id === event.toolCallId)) {
          calls.push({tool: event.toolName.replace('mcp__miniclaw__', ''), tool_call_id: event.toolCallId});
        }
      } else if (event.type === 'tool_end') {
        const call = calls.find(item => item.tool_call_id === event.toolCallId);
        if (call) {
          const content = (event.result as {content?: Array<{text?: string}>} | undefined)?.content;
          try {
            const parsed = JSON.parse(content?.[0]?.text ?? '{}') as {evidence_id?: string; status?: string; error?: string};
            call.evidence_id = parsed.evidence_id;
            call.result_status = parsed.status;
            call.error = parsed.error;
          } catch { call.error = 'unreadable_tool_result'; }
        }
      } else if (event.type === 'result') finalText = event.result.text;
    });
    const timeout = setTimeout(() => void session.abort(), 180_000);
    let runtimeError: string | undefined;
    try {
      await session.prompt({text: `调查 ${incidentId}。服务：${fixture.incident.service}。告警：${fixture.incident.alert}。开始时间：${fixture.incident.started_at}。请实际调用工具获取证据，然后按系统约定输出 JSON。`});
    } catch { runtimeError = 'model_turn_failed_or_timed_out'; }
    finally { clearTimeout(timeout); unsubscribe(); session.dispose(); }
    const decision = parseDecision(finalText);
    const evidence = gate.evidence.forIncident(incidentId);
    const observedIds = new Set(evidence.map(item => item.evidence_id));
    const decisionValid = Boolean(decision && decision.incident_id === incidentId && decision.evidence_ids.every(id => observedIds.has(id)) && (decision.decision === 'escalate' ? decision.root_cause === null : Boolean(decision.root_cause && decision.evidence_ids.length)));
    if (decisionValid && decision?.decision === 'diagnose') {
      gate.events.emit(incidentId, 'DiagnosisCreated', {
        root_cause: decision.root_cause!, confidence: decision.confidence, evidence_ids: decision.evidence_ids,
      });
    }
    process.stdout.write(JSON.stringify({
      incident_id: incidentId,
      model: selected.anthropicModel,
      tool_calls: calls,
      collected_evidence: evidence,
      final_text: finalText,
      decision,
      decision_valid: decisionValid,
      runtime_error: runtimeError,
      executor_called: executorCalled,
      events: gate.events.snapshot(),
    }) + '\n');
  } finally {
    fs.rmSync(temp, {recursive: true, force: true});
  }
}

void main().catch(error => {
  // Provider exceptions may contain URLs or credentials: emit only a safe code.
  const code = error instanceof Error && ['invalid_incident_id', 'no_configured_model_credential', 'missing_event_directory'].includes(error.message) ? error.message : 'live_runner_failed';
  process.stderr.write(`${incidentId ?? 'unknown'}: ${code}\n`);
  process.exitCode = 1;
});
