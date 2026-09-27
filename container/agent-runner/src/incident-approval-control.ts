/** Signed host control channel. Commands never enter Agent input or LLM context. */
import fs from 'node:fs';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  decideIncidentApprovalForGroup,
  pendingIncidentApprovalsForGroup,
} from './incident-approval-gate.js';

type Command = {
  requestId: string;
  runnerInstanceId: string;
  issuedAt: number;
  operation: 'list' | 'allow' | 'reject';
  approvalId?: string;
  actor?: string;
  signature: string;
};
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const signed = (secret: string, value: unknown) =>
  createHmac('sha256', secret).update(JSON.stringify(value)).digest('hex');
function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function startIncidentApprovalControl(input: {
  workspaceIpc: string;
  groupFolder: string;
  runnerInstanceId?: string;
  signingSecret?: string;
}): () => void {
  if (!input.runnerInstanceId || !input.signingSecret) return () => {};
  const commandDir = path.join(
    input.workspaceIpc,
    'incident-approval-commands',
  );
  const resultDir = path.join(input.workspaceIpc, 'incident-approval-results');
  fs.mkdirSync(commandDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(resultDir, { recursive: true, mode: 0o700 });
  const seen = new Map<string, number>();
  let busy = false;
  let stopped = false;
  async function poll() {
    if (busy || stopped) return;
    busy = true;
    try {
      for (const [id, time] of seen)
        if (Date.now() - time > 10_000) seen.delete(id);
      for (const name of fs
        .readdirSync(commandDir)
        .filter(
          (item) =>
            uuid.test(item.replace(/\.json$/, '')) && item.endsWith('.json'),
        )
        .slice(0, 50)) {
        const file = path.join(commandDir, name);
        let raw: Command;
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096)
            continue;
          raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Command;
        } catch {
          continue;
        } finally {
          try {
            fs.unlinkSync(file);
          } catch {
            /* best effort */
          }
        }
        if (
          !raw ||
          !uuid.test(raw.requestId) ||
          seen.has(raw.requestId) ||
          seen.size >= 1000 ||
          raw.runnerInstanceId !== input.runnerInstanceId ||
          !Number.isFinite(raw.issuedAt) ||
          Math.abs(Date.now() - raw.issuedAt) > 10_000 ||
          !['list', 'allow', 'reject'].includes(raw.operation) ||
          typeof raw.signature !== 'string'
        )
          continue;
        const { signature, ...unsigned } = raw;
        if (!equal(signature, signed(input.signingSecret!, unsigned))) continue;
        seen.set(raw.requestId, Date.now());
        let payload: unknown;
        if (raw.operation === 'list')
          payload = pendingIncidentApprovalsForGroup(input.groupFolder);
        else if (
          uuid.test(raw.approvalId ?? '') &&
          typeof raw.actor === 'string' &&
          raw.actor.length > 0 &&
          raw.actor.length <= 150
        ) {
          const result = await decideIncidentApprovalForGroup(
            input.groupFolder,
            raw.approvalId!,
            raw.actor,
            raw.operation,
          );
          payload = result
            ? { accepted: !result.isError, result }
            : { accepted: false, error: 'no_live_pending_request' };
        } else payload = { accepted: false, error: 'invalid_command' };
        const response = {
          requestId: raw.requestId,
          runnerInstanceId: input.runnerInstanceId,
          payload,
        };
        const output = {
          ...response,
          signature: signed(input.signingSecret!, response),
        };
        const target = path.join(resultDir, `${raw.requestId}.json`);
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(output), { mode: 0o600 });
        fs.renameSync(tmp, target);
      }
    } finally {
      busy = false;
    }
  }
  const timer = setInterval(() => {
    void poll().catch(() => {});
  }, 300);
  timer.unref();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
