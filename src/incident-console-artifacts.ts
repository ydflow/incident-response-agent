import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { GROUPS_DIR } from './config.js';

type JsonRecord = Record<string, unknown>;
export interface RecordedEvent {
  id: string;
  incidentId: string;
  type: string;
  timestamp: string;
  payload: JsonRecord;
}
export interface RecordedRun {
  id: string;
  incidentId: string;
  source: string;
  events: RecordedEvent[];
}

const eventTypes = new Set([
  'IncidentCreated',
  'StatusChanged',
  'ToolCalled',
  'ToolResult',
  'EvidenceCollected',
  'DiagnosisCreated',
  'ApprovalRequested',
  'ApprovalDecided',
  'ActionExecuted',
  'ToolFailed',
]);
const sensitiveKey = /password|secret|token|credential|api.?key|authorization/i;
const safeName = /^[A-Za-z0-9_-]+$/;

async function list(dir: string): Promise<string[]> {
  try {
    const stat = await fs.lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return [];
    return (await fs.readdir(dir)).slice(0, 500).sort();
  } catch {
    return [];
  }
}
async function readSmall(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
      return null;
    return fs.readFile(file, 'utf8');
  } catch {
    return null;
  }
}
function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[已截断]';
  if (typeof value === 'string') return value.slice(0, 2000);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null)
    return value;
  if (Array.isArray(value))
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .slice(0, 50)
        .map(([key, item]) => [
          key.slice(0, 100),
          sensitiveKey.test(key) ? '[已隐藏]' : sanitize(item, depth + 1),
        ]),
    );
  }
  return null;
}

/** Bounded, read-only scan of explicit incident JSONL artifact directories. */
export async function readIncidentRuns(
  root: string,
  runtimeGroupsRoot = GROUPS_DIR,
): Promise<RecordedRun[]> {
  const data = path.join(root, 'data');
  const files: { file: string; source: string }[] = [];
  for (const name of ['incident-runs', 'incident-e2e']) {
    const dir = path.join(data, name);
    for (const child of await list(dir)) {
      if (/^INC-\d+\.jsonl$/.test(child))
        files.push({ file: path.join(dir, child), source: name });
      else if (name === 'incident-e2e' && /^INC-\d+-[\w-]+$/.test(child)) {
        for (const entry of await list(path.join(dir, child))) {
          if (/^INC-\d+\.jsonl$/.test(entry))
            files.push({ file: path.join(dir, child, entry), source: name });
        }
      }
    }
  }
  // Runtime group traces are admin-only through the API. No user-selected path is accepted.
  for (const group of await list(runtimeGroupsRoot)) {
    if (!safeName.test(group)) continue;
    const groupStat = await fs
      .lstat(path.join(runtimeGroupsRoot, group))
      .catch(() => null);
    if (!groupStat?.isDirectory() || groupStat.isSymbolicLink()) continue;
    const dir = path.join(runtimeGroupsRoot, group, 'runs');
    for (const child of await list(dir)) {
      if (/^INC-[A-Za-z0-9_-]+\.jsonl$/.test(child))
        files.push({ file: path.join(dir, child), source: `runtime/${group}` });
    }
  }
  const runs: RecordedRun[] = [];
  for (const { file, source } of files.slice(0, 500)) {
    const content = await readSmall(file);
    if (!content) continue;
    const fileId = createHash('sha256').update(file).digest('hex').slice(0, 16);
    let current: RecordedRun | null = null;
    let sequence = 0;
    for (const line of content.split(/\r?\n/).filter(Boolean).slice(0, 2000)) {
      try {
        const raw = JSON.parse(line) as JsonRecord;
        if (
          !raw ||
          typeof raw !== 'object' ||
          !safeName.test(String(raw.incident_id)) ||
          typeof raw.event_id !== 'string' ||
          typeof raw.event_type !== 'string' ||
          !eventTypes.has(raw.event_type) ||
          typeof raw.timestamp !== 'string' ||
          !Number.isFinite(Date.parse(raw.timestamp)) ||
          !raw.payload ||
          typeof raw.payload !== 'object' ||
          Array.isArray(raw.payload)
        )
          continue;
        const incidentId = String(raw.incident_id);
        // A file may contain several appended sessions. Preserve append order.
        if (
          !current ||
          raw.event_type === 'IncidentCreated' ||
          current.incidentId !== incidentId
        ) {
          sequence += 1;
          current = {
            id: `${source}:${fileId}:${sequence}`,
            incidentId,
            source,
            events: [],
          };
          runs.push(current);
        }
        current.events.push({
          id: raw.event_id,
          incidentId,
          type: raw.event_type,
          timestamp: raw.timestamp,
          payload: sanitize(raw.payload) as JsonRecord,
        });
      } catch {
        /* Corrupt JSONL line does not create a synthetic event. */
      }
    }
  }
  return runs.sort(
    (a, b) =>
      Date.parse(b.events.at(-1)?.timestamp ?? '') -
      Date.parse(a.events.at(-1)?.timestamp ?? ''),
  );
}
