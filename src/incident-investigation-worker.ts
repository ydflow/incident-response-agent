/** Host orchestrator: private Runner, original Python lifecycle, fenced SQLite writes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { incidentPythonCommand } from './incident-python.js';
import {
  InvestigationStore,
  type IncidentSnapshot,
} from './incident-investigation-store.js';
import {
  boundedJson,
  escalationReport,
  validateReport,
  InvestigationError,
  fail,
  type Lease,
  type InvestigationReport,
} from './incident-investigation-types.js';
import {
  startIncidentModelBudget,
  type IncidentModelConfig,
} from './incident-model-budget.js';

export type HostIncidentSource = {
  source_scope: string;
  source_id: string;
  service: string;
  environment: string;
  base_url: string;
  read_token: string;
  instance_id: string;
};
type Options = {
  repo_root: string;
  sources: HostIncidentSource[];
  model?: IncidentModelConfig | null;
  max_model_requests?: number;
  wall_ms?: number;
  lease_ms?: number;
  owner?: string;
  incident_id?: string;
};
export async function pythonIncidentLifecycle(
  repo: string,
  input: unknown,
): Promise<any> {
  const payload = boundedJson(input, 1048576);
  const python = incidentPythonCommand(repo);
  return new Promise((resolve, reject) => {
    const child = execFile(
      python.executable,
      [...python.prefix, '-B', '-m', 'incident_agent.live_investigation'],
      { cwd: repo, timeout: 10000, maxBuffer: 131072, windowsHide: true },
      (error, stdout) => {
        if (error) {
          reject(new InvestigationError('lifecycle_validation_failed'));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new InvestigationError('lifecycle_validation_failed'));
        }
      },
    );
    child.stdin!.end(payload);
  });
}
const incidentCore = (s: IncidentSnapshot) => ({
  incident_id: s.incident_id,
  service: s.service,
  alert: s.alert,
  started_at: s.started_at,
});
async function terminateOwned(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin?.write(`${JSON.stringify({ kind: 'abort' })}\n`);
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      const last = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill('SIGKILL');
        resolve();
      }, 1000);
      last.unref();
    }, 1000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
export class IncidentInvestigationWorker {
  readonly owner: string;
  constructor(
    private readonly store: InvestigationStore,
    private readonly options: Options,
  ) {
    this.owner = options.owner ?? `worker-${randomUUID()}`;
  }
  async tick(): Promise<{
    job_id: string;
    run_id: string;
    state: string;
    reason: string | null;
  } | null> {
    const lease = this.store.claim(this.owner, {
      lease_ms: this.options.lease_ms,
      wall_ms: this.options.wall_ms,
      incident_id: this.options.incident_id,
    });
    if (!lease) return null;
    return this.execute(lease);
  }
  async execute(lease: Lease) {
    this.store.assertLease(lease);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v030-investigation-'));
    const sandbox = path.join(tmp, 'work'),
      sessions = path.join(tmp, 'sessions');
    fs.mkdirSync(sandbox);
    fs.mkdirSync(sessions);
    const controller = new AbortController();
    let boundary: string | null = null,
      child: ChildProcess | undefined,
      proxy: Awaited<ReturnType<typeof startIncidentModelBudget>> | undefined;
    const run = this.store.run(lease.run_id),
      snapshot = JSON.parse(
        this.store.job(lease.job_id).snapshot_json,
      ) as IncidentSnapshot;
    const stop = (code: string) => {
      boundary ??= code;
      controller.abort();
      child?.stdin?.write(`${JSON.stringify({ kind: 'abort' })}\n`);
    };
    const timer = setTimeout(
      () => stop('wall_budget'),
      Math.max(1, run.deadline_at - Date.now()),
    );
    const heartbeat = setInterval(
      () => {
        try {
          this.store.heartbeat(lease, this.options.lease_ms ?? 30000);
        } catch (e) {
          stop(
            e instanceof InvestigationError ? e.code : 'lease_heartbeat_failed',
          );
        }
      },
      Math.min(
        10000,
        Math.max(20, Math.floor((this.options.lease_ms ?? 30000) / 3)),
      ),
    );
    try {
      const start = await pythonIncidentLifecycle(this.options.repo_root, {
        action: 'start',
        incident: incidentCore(snapshot),
      });
      for (const event of start.events) this.store.append(lease, event);
      const source = this.options.sources.find(
        (s) =>
          s.source_scope === snapshot.source_scope &&
          s.service === snapshot.service &&
          s.environment === snapshot.environment,
      );
      let report: InvestigationReport,
        reason: string | null = null,
        outcome: 'blocked' | 'manual' | 'completed' = 'manual';
      if (!source) {
        reason = 'live_source_not_configured';
        report = escalationReport(reason, []);
        outcome = 'blocked';
      } else {
        this.store.bindSource(
          lease,
          source,
          this.options.model?.mode ?? 'host_no_model',
        );
        if (this.options.model)
          proxy = await startIncidentModelBudget(
            this.store,
            lease,
            this.options.model,
            {
              max_requests: this.options.max_model_requests ?? 6,
              signal: controller.signal,
              onBoundary: stop,
            },
          );
        const { reportSchema } =
          await import('./incident-investigation-types.js');
        const config = {
          incident: incidentCore(snapshot),
          environment: snapshot.environment,
          run_id: lease.run_id,
          from: run.from_at,
          to: run.to_at,
          source: {
            source_id: source.source_id,
            service: source.service,
            environment: source.environment,
            base_url: source.base_url,
            read_token: source.read_token,
            instance_id: source.instance_id,
          },
          runbooks_root: path.join(this.options.repo_root, 'runbooks'),
          cwd: sandbox,
          session_dir: sessions,
          report_schema: z.toJSONSchema(reportSchema),
          ...(proxy
            ? {
                model_proxy: {
                  base_url: proxy.base_url,
                  api_key: proxy.api_key,
                  model: proxy.model,
                },
              }
            : {}),
        };
        const script = path.join(
          this.options.repo_root,
          'container',
          'agent-runner',
          'dist',
          'incident-investigation-runner.js',
        );
        if (!fs.existsSync(script)) fail('incident_runner_not_built');
        const inherited: Record<string, string> = {};
        for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP'])
          if (process.env[key]) inherited[key] = process.env[key]!;
        child = spawn(process.execPath, [script], {
          cwd: sandbox,
          env: {
            ...inherited,
            INCIDENT_EXECUTION_PRIVATE: boundedJson(config, 65536),
            PI_CODING_AGENT_DIR: path.join(tmp, 'agent'),
          },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        child.stderr?.on('data', () => {}); // Never publish raw SDK/provider diagnostics.
        const execution = await this.consume(
          child,
          lease,
          controller.signal,
          stop,
        );
        await terminateOwned(child);
        child = undefined;
        const evidence = this.store.evidence(lease.run_id),
          knowledge = this.store.knowledge(lease.run_id);
        const scope = {
          incident_id: snapshot.incident_id,
          service: snapshot.service,
          environment: snapshot.environment,
          run_id: lease.run_id,
          from: run.from_at,
          to: run.to_at,
        };
        if (boundary) {
          reason = boundary;
          report = escalationReport(reason, evidence);
        } else if (!execution.report_text) {
          reason = String(execution.reason ?? 'model_session_failed');
          report = escalationReport(reason, evidence);
          outcome = reason === 'no_configured_model' ? 'blocked' : 'manual';
        } else {
          try {
            if (
              typeof execution.report_text !== 'string' ||
              Buffer.byteLength(execution.report_text) > 32768
            )
              fail('invalid_model_output');
            report = validateReport(
              JSON.parse(execution.report_text),
              scope,
              evidence,
              knowledge,
            );
            if (report.conflicts.length) {
              reason = 'conflicting_evidence';
              report = {
                ...report,
                outcome: 'ESCALATED',
                diagnosis: null,
                escalation_reason: reason,
                next_evidence_requests: report.next_evidence_requests.length
                  ? report.next_evidence_requests
                  : ['补采相同范围的独立观测并由人工审查冲突。'],
              };
            }
            if (execution.failures?.length) {
              reason = 'partial_evidence_failure';
              report = {
                ...report,
                outcome: 'ESCALATED',
                diagnosis: null,
                escalation_reason: reason,
                next_evidence_requests: report.next_evidence_requests.length
                  ? report.next_evidence_requests
                  : ['补齐失败数据源并检查其服务、环境与时间范围。'],
              };
            }
            outcome = report.outcome === 'DIAGNOSED' ? 'completed' : 'manual';
            reason ??= report.escalation_reason;
          } catch {
            reason = 'invalid_model_report';
            report = escalationReport(reason, evidence);
            outcome = 'manual';
          }
        }
        validateReport(report, scope, evidence, knowledge);
      }
      if (boundary === 'wall_budget' || boundary === 'stale_lease') {
        this.store.reap();
        return {
          job_id: lease.job_id,
          run_id: lease.run_id,
          state: 'lease_lost',
          reason: boundary,
        };
      }
      const lifecycle = await pythonIncidentLifecycle(this.options.repo_root, {
        action: report.outcome === 'DIAGNOSED' ? 'diagnose' : 'escalate',
        incident: incidentCore(snapshot),
        events: this.store.events(lease.run_id),
        diagnosis: report.diagnosis,
        evidence: this.store.evidence(lease.run_id),
      });
      for (const event of lifecycle.events) this.store.append(lease, event);
      // The host supplies verified measurement labels; model prose is never a fact validator.
      const envelope = {
        ...report,
        origin: this.options.model?.mode ?? 'host_no_model',
        reference_checks: 'passed',
        semantic_proof: false,
        measured_facts: report.facts.map((f) => ({
          ...f,
          display: `${f.field} = ${JSON.stringify(f.value)}`,
        })),
        budget: {
          tool_calls: this.store.run(lease.run_id).tool_calls,
          model_http_reservations: this.store.run(lease.run_id).model_requests,
        },
        execution_authorized: false,
      };
      this.store.finish(lease, outcome, envelope, reason);
      return {
        job_id: lease.job_id,
        run_id: lease.run_id,
        state: outcome,
        reason,
      };
    } catch (error) {
      const code =
        boundary ??
        (error instanceof InvestigationError
          ? error.code
          : 'investigation_execution_failed');
      if (child) await terminateOwned(child);
      child = undefined;
      try {
        if (['stale_lease', 'wall_budget'].includes(code)) {
          this.store.reap();
        } else if (
          [
            'incident_runner_failed',
            'host_ack_timeout',
            'incident_runner_not_built',
            'investigation_execution_failed',
            'lifecycle_validation_failed',
          ].includes(code)
        )
          this.store.retry(lease, code);
        else {
          const report = escalationReport(
            code,
            this.store.evidence(lease.run_id),
          );
          const lifecycle = await pythonIncidentLifecycle(
            this.options.repo_root,
            {
              action: 'escalate',
              incident: incidentCore(snapshot),
              events: this.store.events(lease.run_id),
            },
          );
          for (const event of lifecycle.events) this.store.append(lease, event);
          this.store.finish(
            lease,
            'manual',
            {
              ...report,
              origin: 'host_control',
              execution_authorized: false,
              semantic_proof: false,
            },
            code,
          );
        }
      } catch {
        this.store.reap();
      }
      const job = this.store.job(lease.job_id);
      return {
        job_id: lease.job_id,
        run_id: lease.run_id,
        state: job.state,
        reason: code,
      };
    } finally {
      clearTimeout(timer);
      clearInterval(heartbeat);
      controller.abort();
      if (child) await terminateOwned(child);
      await proxy?.close();
      if (
        path.dirname(path.resolve(tmp)) !== path.resolve(os.tmpdir()) ||
        !path.basename(tmp).startsWith('v030-investigation-')
      )
        throw Error('unsafe_task_workspace');
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  private consume(
    child: ChildProcess,
    lease: Lease,
    signal: AbortSignal,
    onBoundary: (code: string) => void,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let buffer = '',
        total = 0,
        settled = false;
      const finish = (error: Error | null, value?: unknown) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () =>
        finish(new InvestigationError('investigation_cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      child.on('error', () =>
        finish(new InvestigationError('incident_runner_failed')),
      );
      child.on('exit', () => {
        if (!settled) finish(new InvestigationError('incident_runner_failed'));
      });
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        total += Buffer.byteLength(chunk);
        if (total > 2097152) {
          onBoundary('ipc_output_limit');
          finish(new InvestigationError('ipc_output_limit'));
          return;
        }
        buffer += chunk;
        if (Buffer.byteLength(buffer) > 160000 && !buffer.includes('\n')) {
          onBoundary('ipc_message_limit');
          return;
        }
        while (buffer.includes('\n')) {
          const index = buffer.indexOf('\n'),
            line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (settled) continue;
          try {
            if (Buffer.byteLength(line) > 160000) fail('ipc_message_limit');
            const m = JSON.parse(line);
            if (m.kind === 'done') {
              finish(null, m);
              continue;
            }
            if (m.kind === 'fatal') {
              finish(new InvestigationError('incident_runner_failed'));
              continue;
            }
            if (
              typeof m.id !== 'string' ||
              m.id.length > 100 ||
              !['tool', 'event', 'runtime'].includes(m.kind)
            )
              fail('ipc_invalid_message');
            try {
              if (m.kind === 'tool')
                this.store.reserveTool(
                  lease,
                  m.payload.tool,
                  Date.now(),
                  m.payload.tool_call_id,
                );
              else if (m.kind === 'runtime')
                this.store.runtimeTrace(lease, m.payload);
              else this.store.append(lease, m.payload.event);
              child.stdin!.write(`${JSON.stringify({ id: m.id, ok: true })}\n`);
            } catch (error) {
              const code =
                error instanceof InvestigationError
                  ? error.code
                  : 'invalid_runner_payload';
              child.stdin!.write(
                `${JSON.stringify({ id: m.id, ok: false, error: code })}\n`,
              );
              onBoundary(code);
            }
          } catch {
            onBoundary('ipc_invalid_message');
            finish(new InvestigationError('ipc_invalid_message'));
          }
        }
      });
      if (signal.aborted) abort();
    });
  }
}
