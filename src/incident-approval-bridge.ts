/** Host-owned signed bridge to the live runner's existing IncidentApprovalGate. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import { DATA_DIR } from './config.js';

interface Runner {
  instanceId: string;
  groupFolder: string;
  ipcDir: string;
  secret: string;
  process: ChildProcess;
}
export interface LiveApproval {
  id: string;
  request: {
    action: 'restart_service' | 'rollback_config' | 'modify_config';
    incident_id: string;
    target: string;
    config_key?: string;
    proposed_value?: string;
  };
  requestedAt: string | null;
  evidence: Array<{
    id: string;
    source: string;
    correlationId: string;
    preview: string;
  }>;
  groupFolder: string;
}
const runners = new Map<string, Runner>();
const sign = (secret: string, value: unknown) =>
  createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex');
function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
export function registerIncidentApprovalRunner(input: {
  instanceId: string;
  secret: string;
  groupFolder: string;
  agentId?: string;
  taskRunId?: string;
  process: ChildProcess;
}): void {
  const ipcDir = input.agentId
    ? path.join(DATA_DIR, 'ipc', input.groupFolder, 'agents', input.agentId)
    : input.taskRunId
      ? path.join(
          DATA_DIR,
          'ipc',
          input.groupFolder,
          'tasks-run',
          input.taskRunId,
        )
      : path.join(DATA_DIR, 'ipc', input.groupFolder);
  runners.set(input.instanceId, { ...input, ipcDir });
}
export function revokeIncidentApprovalRunner(instanceId: string): void {
  runners.delete(instanceId);
}
async function send(
  runner: Runner,
  operation: 'list' | 'allow' | 'reject',
  approvalId?: string,
  actor?: string,
): Promise<unknown> {
  if (
    runner.process.exitCode !== null ||
    runner.process.signalCode !== null ||
    runner.process.killed
  )
    return null;
  const commandDir = path.join(runner.ipcDir, 'incident-approval-commands');
  const resultDir = path.join(runner.ipcDir, 'incident-approval-results');
  const requestId = randomUUID();
  const command = {
    requestId,
    runnerInstanceId: runner.instanceId,
    issuedAt: Date.now(),
    operation,
    ...(approvalId ? { approvalId } : {}),
    ...(actor ? { actor } : {}),
  };
  try {
    await fs.mkdir(commandDir, { recursive: true, mode: 0o700 });
    await fs.mkdir(resultDir, { recursive: true, mode: 0o700 });
    const target = path.join(commandDir, `${requestId}.json`);
    const temp = `${target}.tmp`;
    await fs.writeFile(
      temp,
      JSON.stringify({ ...command, signature: sign(runner.secret, command) }),
      { mode: 0o600 },
    );
    await fs.rename(temp, target);
    const replyFile = path.join(resultDir, `${requestId}.json`);
    for (let attempt = 0; attempt < 80; attempt++) {
      if (
        runner.process.exitCode !== null ||
        runner.process.signalCode !== null ||
        runner.process.killed
      )
        return null;
      try {
        const stat = await fs.lstat(replyFile);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 100_000)
          return null;
        const reply = JSON.parse(
          await fs.readFile(replyFile, 'utf8'),
        ) as Record<string, unknown>;
        await fs.unlink(replyFile).catch(() => {});
        const { signature, ...unsigned } = reply;
        if (
          reply.requestId !== requestId ||
          reply.runnerInstanceId !== runner.instanceId ||
          typeof signature !== 'string' ||
          !equal(signature, sign(runner.secret, unsigned))
        )
          return null;
        return reply.payload;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  } catch {
    return null;
  }
  return null;
}
function isLiveApproval(
  value: unknown,
): value is Omit<LiveApproval, 'groupFolder'> {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  const request = item.request as Record<string, unknown> | undefined;
  return (
    typeof item.id === 'string' &&
    !!request &&
    ['restart_service', 'rollback_config', 'modify_config'].includes(
      String(request.action),
    ) &&
    typeof request.incident_id === 'string' &&
    typeof request.target === 'string'
  );
}
export async function listLiveIncidentApprovals(): Promise<LiveApproval[]> {
  const responses = await Promise.all(
    [...runners.values()].map(async (runner) => ({
      runner,
      payload: await send(runner, 'list'),
    })),
  );
  return responses.flatMap(({ runner, payload }) =>
    Array.isArray(payload)
      ? payload
          .filter(isLiveApproval)
          .map((item) => ({ ...item, groupFolder: runner.groupFolder }))
      : [],
  );
}
export async function decideLiveIncidentApproval(
  id: string,
  actor: string,
  decision: 'allow' | 'reject',
) {
  const candidates = await Promise.all(
    [...runners.values()].map(async (runner) => ({
      runner,
      pending: await send(runner, 'list'),
    })),
  );
  const owner = candidates.find(
    ({ pending }) =>
      Array.isArray(pending) &&
      pending.some((item) => isLiveApproval(item) && item.id === id),
  )?.runner;
  if (!owner) return { accepted: false, error: 'no_live_pending_request' };
  const result = await send(owner, decision, id, actor);
  if (result && typeof result === 'object')
    return result as Record<string, unknown>;
  return { accepted: false, error: 'unknown_outcome' };
}
