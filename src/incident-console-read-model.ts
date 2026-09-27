import fs from 'node:fs/promises';
import path from 'node:path';

// Read-only projection. No runtime, policy, evaluation answer key or tool imports.
const statuses = new Set([
  'RECEIVED',
  'INVESTIGATING',
  'DIAGNOSED',
  'AWAITING_APPROVAL',
  'RESOLVED',
  'ESCALATED',
  'FAILED',
]);
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
type RecordValue = Record<string, unknown>;
export interface ConsoleIncident {
  id: string;
  service: string;
  alert: string;
  startedAt: string;
  severity: 'P1' | 'P2' | 'P3' | null;
  status: string;
  lastEventAt: string | null;
  source: 'fixture';
}
export interface ConsoleEvent {
  id: string;
  incidentId: string;
  type: string;
  timestamp: string;
  status: string | null;
  tool: string | null;
}
const record = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const string = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 2000;
const date = (value: unknown): value is string =>
  string(value) && Number.isFinite(Date.parse(value));

export async function readIncidentConsole(
  root: string,
  includeHistory: boolean,
) {
  const warnings = new Set<string>();
  // Reject linked files/directories, bound reads, and never accept a request path.
  async function entries(dir: string, required = false): Promise<string[]> {
    try {
      const stat = await fs.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('unsafe directory');
      const names = (await fs.readdir(dir)).sort();
      if (names.length > 500)
        warnings.add('数据目录超过读取上限，当前结果不完整');
      return names.slice(0, 500);
    } catch (error) {
      if (required) throw new Error('故障目录不可读取');
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        warnings.add('部分运行目录无法读取');
      return [];
    }
  }
  async function read(file: string): Promise<string | null> {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2_000_000)
        throw new Error('unsupported file');
      return await fs.readFile(file, 'utf8');
    } catch {
      warnings.add('部分数据文件无法读取或超出大小限制');
      return null;
    }
  }
  const fixtureRoot = path.join(root, 'incident_agent', 'fixtures');
  const incidents: ConsoleIncident[] = [];
  for (const name of await entries(fixtureRoot, true)) {
    if (!/^INC-\d+$/.test(name)) continue;
    const dir = path.join(fixtureRoot, name);
    if (!(await entries(dir)).includes('incident.json')) continue;
    try {
      const value: unknown = JSON.parse(
        (await read(path.join(dir, 'incident.json'))) ?? 'null',
      );
      if (
        !record(value) ||
        value.incident_id !== name ||
        !string(value.service) ||
        !string(value.alert) ||
        !date(value.started_at)
      )
        throw new Error('invalid incident');
      incidents.push({
        id: name,
        service: value.service,
        alert: value.alert,
        startedAt: value.started_at,
        severity: null,
        status: includeHistory ? 'NOT_RUN' : 'UNAVAILABLE',
        lastEventAt: null,
        source: 'fixture',
      });
    } catch {
      warnings.add('部分 Fixture 基本信息格式无效');
    }
  }
  const events: ConsoleEvent[] = [];
  if (includeHistory) {
    // These are the project's explicit offline incident artifact directories.
    // User workspace traces are intentionally outside this catalog's scope.
    const dataDir = path.join(root, 'data');
    const dataEntries = await entries(dataDir);
    const files: string[] = [];
    for (const name of ['incident-runs', 'incident-e2e']) {
      if (!dataEntries.includes(name)) continue;
      const dir = path.join(dataDir, name);
      for (const child of await entries(dir)) {
        if (/^INC-\d+\.jsonl$/.test(child)) files.push(path.join(dir, child));
        else if (name === 'incident-e2e' && /^INC-\d+-[\w-]+$/.test(child)) {
          for (const file of await entries(path.join(dir, child))) {
            if (/^INC-\d+\.jsonl$/.test(file))
              files.push(path.join(dir, child, file));
          }
        }
      }
    }
    const latest = new Map<
      string,
      { createdAt: number; events: ConsoleEvent[] }
    >();
    if (files.length > 500)
      warnings.add('运行记录超过读取上限，当前结果不完整');
    const incidentIds = new Set(incidents.map((i) => i.id));
    for (const file of files.slice(0, 500)) {
      const content = await read(file);
      if (!content) continue;
      let run: { createdAt: number; events: ConsoleEvent[] } | null = null;
      let incidentId = '';
      for (const line of content.split(/\r?\n/).filter(Boolean)) {
        try {
          const value: unknown = JSON.parse(line);
          if (
            !record(value) ||
            !string(value.event_id) ||
            !string(value.incident_id) ||
            !incidentIds.has(value.incident_id) ||
            !string(value.event_type) ||
            !eventTypes.has(value.event_type) ||
            !date(value.timestamp) ||
            !record(value.payload)
          )
            throw new Error('invalid event');
          if (value.event_type === 'IncidentCreated') {
            incidentId = value.incident_id;
            run = { createdAt: Date.parse(value.timestamp), events: [] };
            if (
              run.createdAt > (latest.get(incidentId)?.createdAt ?? -Infinity)
            )
              latest.set(incidentId, run);
          }
          if (!run || incidentId !== value.incident_id)
            throw new Error('missing run boundary');
          const state =
            value.event_type === 'StatusChanged'
              ? value.payload.to
              : value.event_type === 'IncidentCreated'
                ? value.payload.status
                : null;
          // Only whitelisted metadata reaches the browser; never raw tool/model content.
          run.events.push({
            id: value.event_id,
            incidentId,
            type: value.event_type,
            timestamp: value.timestamp,
            status:
              typeof state === 'string' && statuses.has(state) ? state : null,
            tool:
              typeof value.payload.tool === 'string' &&
              /^query_(logs|metrics|trace|git_diff)$/.test(value.payload.tool)
                ? value.payload.tool
                : null,
          });
        } catch {
          warnings.add('部分 AgentEvent 无效，已跳过；状态可能不完整');
        }
      }
    }
    for (const incident of incidents) {
      const run = latest.get(incident.id);
      if (!run) continue;
      // Append order is the event-store order; do not reorder state transitions by producer clocks.
      for (const event of run.events)
        if (event.status) incident.status = event.status;
      incident.lastEventAt = run.events.at(-1)?.timestamp ?? null;
      events.push(...run.events);
    }
  }
  events.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
  incidents.sort(
    (a, b) =>
      Date.parse(b.startedAt) - Date.parse(a.startedAt) ||
      a.id.localeCompare(b.id),
  );
  return {
    incidents,
    events: events.slice(0, 100),
    updatedAt: new Date().toISOString(),
    historyAccess: includeHistory,
    source: 'Fixture 案例 · 本地运行记录',
    warnings: [...warnings],
  };
}
