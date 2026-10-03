import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  RunbookIndex,
  splitRunbook,
  tokenizeRunbook,
  type RunbookMetadata,
} from '../container/agent-runner/src/incident-runbooks.js';
import {
  IncidentRunbookSearch,
  createIncidentRunbookTool,
  incidentInvestigationContext,
  readRecordedKnowledge,
  knowledgeReferenceSchema,
} from '../container/agent-runner/src/incident-knowledge.js';
import { IncidentApprovalGate } from '../container/agent-runner/src/incident-approval-gate.js';
import { JsonlIncidentEvents } from '../container/agent-runner/src/incident-agent-events.js';
import { FixtureProvider } from '../container/agent-runner/src/incident-provider-tools.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

const root = path.resolve('runbooks');
const catalog = JSON.parse(
  fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'),
);
const grants = catalog.documents.map((d: RunbookMetadata) => d.doc_id);
const id = `LIVE-${randomUUID()}`;
const run = 'runbook-test';
const scope = {
  service: 'orders',
  environment: 'local',
  allowed_doc_ids: grants,
};
const temps: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const tmp of temps.splice(0)) {
    if (
      path.dirname(tmp) !== os.tmpdir() ||
      !path.basename(tmp).startsWith('v030-runbook-test-')
    )
      throw Error('unsafe_temp');
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
function copy() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v030-runbook-test-'));
  temps.push(tmp);
  const destination = path.join(tmp, 'runbooks');
  fs.mkdirSync(destination);
  fs.copyFileSync(
    path.join(root, 'manifest.json'),
    path.join(destination, 'manifest.json'),
  );
  for (const d of catalog.documents)
    fs.copyFileSync(path.join(root, d.file), path.join(destination, d.file));
  return destination;
}
function writeManifest(dir: string, value: unknown) {
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(value));
}
function setup() {
  const index = RunbookIndex.load(root),
    gate = new IncidentApprovalGate();
  const search = new IncidentRunbookSearch(
    index,
    [{ incident_id: id, ...scope }],
    run,
  );
  const tool = createIncidentRunbookTool(search, gate);
  return { index, gate, search, tool };
}
function json(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0].text!);
}

describe('bounded Markdown BM25', () => {
  test('independent corpus has five explicit documents; unlisted/answer files are never read', () => {
    const dir = copy();
    fs.writeFileSync(
      path.join(dir, 'unlisted.md'),
      '# do not read\n\nexpectedDocs answer',
    );
    const spy = vi.spyOn(fs, 'openSync');
    const index = RunbookIndex.load(dir);
    expect(index.document_count).toBe(5);
    expect(index.chunk_count).toBe(45);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('unlisted'))).toBe(
      false,
    );
    expect(
      spy.mock.calls.every((c) => path.dirname(String(c[0])) === dir),
    ).toBe(true);
  });
  test('Chinese bigrams and English identifiers preserve lexical tokens', () => {
    expect(tokenizeRunbook('连接池 pool_waiting ENOSPC')).toEqual([
      '连',
      '接',
      '池',
      '连接',
      '接池',
      'pool_waiting',
      'enospc',
    ]);
  });
  test('title/paragraph positions and content hash point to exact original UTF-16 text', () => {
    const text =
      '# 池💡\r\n\r\n## 症状\r\n\r\n等待与超时。\r\n\r\n## 风险\r\n\r\n先补证据。';
    const chunks = splitRunbook(text, catalog.documents[0]);
    expect(chunks).toHaveLength(5);
    for (const c of chunks) {
      expect(text.slice(c.start_offset, c.end_offset)).toBe(c.snippet);
      expect(c.version_hash).toBe(
        createHash('sha256').update(text).digest('hex'),
      );
      expect(c.start_line).toBe(
        text.slice(0, c.start_offset).split('\n').length,
      );
    }
    expect(chunks[2].section).toBe('池💡 > 症状');
  });
  test('long paragraphs have bounded overlap without splitting surrogate pairs', () => {
    const text = '# Title\n\n' + '等💡'.repeat(800);
    const chunks = splitRunbook(text, catalog.documents[0]);
    const parts = chunks.slice(1);
    expect(parts.length).toBeGreaterThan(2);
    for (const c of parts) {
      expect(c.snippet.length).toBeLessThanOrEqual(1000);
      expect(c.snippet).toBe(text.slice(c.start_offset, c.end_offset));
      expect(c.snippet).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
    }
    expect(parts[0].end_offset - parts[1].start_offset).toBeGreaterThanOrEqual(
      119,
    );
  });
  test('UTF-8 BOM is retained in hashes and original offsets', () => {
    const dir = copy();
    const text = '\uFEFF# Pool\r\n\r\npool_waiting actual text';
    fs.writeFileSync(path.join(dir, 'resource-pool.md'), text, 'utf8');
    const hit = RunbookIndex.load(dir).search('pool_waiting', scope)[0];
    expect(hit.title).toBe('Pool');
    expect(hit.version_hash).toBe(
      createHash('sha256')
        .update(fs.readFileSync(path.join(dir, 'resource-pool.md')))
        .digest('hex'),
    );
    expect(text.slice(hit.start_offset, hit.end_offset)).toBe(hit.snippet);
  });
  test('code fence headings do not change section; unclosed fences reject', () => {
    const text = '# Disk\n\n## Check\n\n```sh\n# not a heading\nx\n```\n';
    const chunks = splitRunbook(text, catalog.documents[3]);
    expect(chunks.at(-1)!.section).toBe('Disk > Check');
    expect(() => splitRunbook('# T\n\n```x\n', catalog.documents[0])).toThrow(
      'invalid_runbook_markdown',
    );
  });
  test('service/environment/permission prefilter prevents denied text affecting rank', () => {
    const dir = copy();
    const manifest = structuredClone(catalog);
    manifest.documents.push({
      ...manifest.documents[0],
      doc_id: 'secret-doc',
      file: 'secret-doc.md',
      services: ['other-service'],
    });
    fs.writeFileSync(
      path.join(dir, 'secret-doc.md'),
      '# pool_waiting\n\npool_waiting '.repeat(500),
    );
    writeManifest(dir, manifest);
    const baseline = RunbookIndex.load(root).search('pool_waiting', scope);
    const extended = RunbookIndex.load(dir).search('pool_waiting', {
      ...scope,
      allowed_doc_ids: [...grants, 'secret-doc'],
    });
    expect(extended.map((h) => [h.chunk_id, h.score])).toEqual(
      baseline.map((h) => [h.chunk_id, h.score]),
    );
    expect(
      RunbookIndex.load(root).search('pool_waiting', {
        ...scope,
        environment: 'production',
      }),
    ).toEqual([]);
    expect(
      RunbookIndex.load(root).search('pool_waiting', {
        ...scope,
        allowed_doc_ids: ['disk-pressure'],
      }),
    ).toEqual([]);
  });
  test('expired/future versions excluded and latest valid semantic version selected', () => {
    const dir = copy();
    const manifest = structuredClone(catalog);
    const base = manifest.documents[0];
    for (const [version, file, from, until] of [
      ['0.1.0', 'old.md', '2019-01-01T00:00:00Z', '2020-01-01T00:00:00Z'],
      ['10.0.0', 'new.md', '2026-01-01T00:00:00Z', null],
      ['11.0.0', 'future.md', '2099-01-01T00:00:00Z', null],
    ] as const) {
      manifest.documents.push({
        ...base,
        version,
        file,
        valid_from: from,
        valid_until: until,
      });
      fs.writeFileSync(
        path.join(dir, file),
        '# Pool\n\npool_waiting version ' + version,
      );
    }
    writeManifest(dir, manifest);
    const index = RunbookIndex.load(dir);
    const hits = index.search(
      'pool_waiting',
      scope,
      5,
      new Date('2026-10-02T00:00:00Z'),
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.version === '10.0.0')).toBe(true);
    expect(
      index.search(
        'pool_waiting',
        scope,
        5,
        new Date('2019-06-01T00:00:00Z'),
      )[0].version,
    ).toBe('0.1.0');
  });
  test('wrong handbook ranked below relevant disk guide and no lexical match is empty', () => {
    const index = RunbookIndex.load(root);
    expect(
      index.search('ENOSPC inode', { ...scope, service: 'api-service' })[0]
        .doc_id,
    ).toBe('disk-pressure');
    expect(index.search('zxqv_unknown', scope)).toEqual([]);
    expect(index.search('backlog', scope)).toEqual([]);
  });
  test('rank, Top-K and ties are deterministic; results cannot mutate index', () => {
    const index = RunbookIndex.load(root);
    const before = index.search('pool_waiting', scope, 5);
    const changed = index.search('pool_waiting', scope, 5);
    changed[0].services.push('evil');
    changed[0].snippet = 'overwrite';
    expect(index.search('pool_waiting', scope, 5)).toEqual(before);
    expect(before.map((h) => h.rank)).toEqual(before.map((_, i) => i + 1));
    expect(index.search('pool_waiting', scope, 1)).toHaveLength(1);
  });
  test.each([
    '../other.md',
    'expected_cases.json',
    'evaluation.md',
    'C:/outside.md',
    '/absolute.md',
  ])('manifest rejects path or unsupported file: %s', (file) => {
    const dir = copy(),
      manifest = structuredClone(catalog);
    manifest.documents[0].file = file;
    writeManifest(dir, manifest);
    expect(() => RunbookIndex.load(dir)).toThrow();
  });
  test.each([
    'INC-001',
    'expectedDocs',
    'expected_terms',
    'incident-case-matrix',
    'evaluation/answer',
  ])('listed knowledge rejects protected content: %s', (bad) => {
    const dir = copy();
    fs.appendFileSync(path.join(dir, 'resource-pool.md'), '\n\n' + bad);
    expect(() => RunbookIndex.load(dir)).toThrow('protected_knowledge');
  });
  test('strict manifest and invalid validity/duplicates reject', () => {
    const dir = copy();
    writeManifest(dir, { ...catalog, unexpected: true });
    expect(() => RunbookIndex.load(dir)).toThrow();
    const manifest = structuredClone(catalog);
    manifest.documents.push({ ...manifest.documents[0] });
    writeManifest(dir, manifest);
    expect(() => RunbookIndex.load(dir)).toThrow('duplicate_runbook_version');
    manifest.documents.pop();
    manifest.documents[0].valid_until = manifest.documents[0].valid_from;
    writeManifest(dir, manifest);
    expect(() => RunbookIndex.load(dir)).toThrow('invalid_runbook_validity');
  });
  test('protected directory roots and JSON-escaped protected names cannot bypass isolation', () => {
    const dir = copy();
    const nested = path.join(path.dirname(dir), 'docs', 'runbooks');
    fs.mkdirSync(nested, { recursive: true });
    expect(() => RunbookIndex.load(nested)).toThrow('unsafe_runbook_root');
    const manifest = structuredClone(catalog);
    manifest.documents[0].file = 'expected-cases.md';
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(manifest).replace(
        'expected-cases',
        '\\u0065xpected-cases',
      ),
    );
    expect(() => RunbookIndex.load(dir)).toThrow('protected_knowledge');
  });
  test('missing directory, wrong root, oversized file and invalid UTF-8 fail distinctly from no_match', () => {
    expect(() => RunbookIndex.load(path.resolve('docs'))).toThrow(
      'unsafe_runbook_root',
    );
    const dir = copy();
    fs.writeFileSync(path.join(dir, 'resource-pool.md'), 'x'.repeat(65537));
    expect(() => RunbookIndex.load(dir)).toThrow('unsafe_runbook_file');
    fs.writeFileSync(
      path.join(dir, 'resource-pool.md'),
      Buffer.from([0xff, 0xfe]),
    );
    expect(() => RunbookIndex.load(dir)).toThrow('runbook_index_unavailable');
    expect(() => RunbookIndex.load(path.join(dir, 'missing'))).toThrow();
  });
  test('linked document and linked root rejected (own temporary hardlinks do not bypass size/content checks)', () => {
    const dir = copy();
    const target = path.join(path.dirname(dir), 'outside.md');
    fs.writeFileSync(target, '# Outside\n\nnot allowed');
    const linkedRoot = path.join(path.dirname(dir), 'linked');
    fs.symlinkSync(dir, linkedRoot, 'junction');
    expect(() => RunbookIndex.load(linkedRoot)).toThrow('unsafe_runbook_root');
    // Directory junction needs no developer mode on Windows; a directory is not a Markdown file.
    const file = path.join(dir, 'resource-pool.md');
    fs.unlinkSync(file);
    fs.symlinkSync(path.dirname(dir), file, 'junction');
    expect(() => RunbookIndex.load(dir)).toThrow();
  });
});

describe('restricted knowledge tool, separate context and historical view', () => {
  test('SAFE registration emits ToolCalled/ToolResult with immutable knowledge and no Evidence', async () => {
    const { tool, gate, search } = setup();
    const response = await tool.handler(
      { incident_id: id, query: 'pool exhausted' },
      { toolCallId: 'safe-call' },
    );
    const value = json(response);
    expect(response.isError).not.toBe(true);
    expect(value.references[0].purpose).toBe('investigation_guidance');
    expect(gate.events.snapshot().map((e) => e.event_type)).toEqual([
      'ToolCalled',
      'ToolResult',
    ]);
    expect(gate.evidence.forIncident(id)).toEqual([]);
    const context = incidentInvestigationContext(
      gate.evidence,
      search.context,
      id,
      run,
    );
    expect(context.observed_evidence).toEqual([]);
    expect(context.knowledge_references.length).toBeGreaterThan(0);
    expect(context.knowledge_references[0].tool_call_id).toBe('safe-call');
    expect(value).not.toHaveProperty('evidence_id');
    expect(json(gate.blockProbe('search_runbooks', id)).message).toContain(
      'Policy decision SAFE',
    );
    expect(json(gate.blockProbe('read_runbook_file', id)).message).toContain(
      'Policy decision BLOCK',
    );
  });
  test('repeated searches have unique references and cloned old snippets', async () => {
    const { tool, search } = setup();
    const first = json(
      await tool.handler({ incident_id: id, query: 'pool exhausted' }, {}),
    );
    const second = json(
      await tool.handler({ incident_id: id, query: 'pool exhausted' }, {}),
    );
    expect(first.references[0].reference_id).not.toBe(
      second.references[0].reference_id,
    );
    const view = search.context.forRun(id, run);
    view[0].snippet = 'changed';
    expect(search.context.forRun(id, run)[0].snippet).toBe(
      first.references[0].snippet,
    );
    expect(search.context.forRun(id, 'other-run')).toEqual([]);
  });
  test('explicit gate denial records failure without search or collection', async () => {
    const index = RunbookIndex.load(root),
      gate = new IncidentApprovalGate({ readPolicy: () => 'BLOCK' }),
      search = new IncidentRunbookSearch(
        index,
        [{ incident_id: id, ...scope }],
        run,
      );
    const spy = vi.spyOn(search, 'search');
    expect(
      (
        await createIncidentRunbookTool(search, gate).handler(
          { incident_id: id, query: 'pool' },
          {},
        )
      ).isError,
    ).toBe(true);
    expect(spy).not.toHaveBeenCalled();
    expect(search.context.forRun(id, run)).toEqual([]);
    expect(gate.events.snapshot().map((e) => e.event_type)).toEqual([
      'ToolCalled',
      'ToolResult',
      'ToolFailed',
    ]);
  });
  test.each([
    { query: '' },
    { query: 'x'.repeat(257) },
    { query: 'pool', top_k: 6 },
    { query: 'pool', top_k: 0 },
    { query: 'pool', top_k: 1.5 },
    { query: 'pool', path: '../answers' },
    { query: 'pool', url: 'https://evil' },
    { query: 'pool', service: 'other' },
    { query: 'pool', environment: 'production' },
  ])('invalid/unregistered input rejected: %j', async (params) => {
    const { search } = setup();
    expect(
      json(await search.search({ incident_id: id, ...params })).error,
    ).toBe('invalid_search');
    expect(search.context.forRun(id, run)).toEqual([]);
  });
  test('unbound Incident and cancellation differ from successful no_match', async () => {
    const { search, tool, gate } = setup();
    expect(
      json(
        await search.search({
          incident_id: `LIVE-${randomUUID()}`,
          query: 'pool',
        }),
      ).error,
    ).toBe('incident_not_bound');
    expect(
      json(
        await search.search(
          { incident_id: id, query: 'pool' },
          { signal: AbortSignal.abort() },
        ),
      ).error,
    ).toBe('cancelled');
    const result = json(
      await tool.handler({ incident_id: id, query: 'zxqv_unknown' }, {}),
    );
    expect(result.status).toBe('no_match');
    expect(result.references).toEqual([]);
    expect(
      gate.events.snapshot().at(-1)!.payload.knowledge_result,
    ).toBeDefined();
  });
  test('16-call local budget includes successful empty results', async () => {
    const { search } = setup();
    for (let i = 0; i < 16; i++)
      expect(
        (await search.search({ incident_id: id, query: 'zxqv_unknown' }))
          .isError,
      ).not.toBe(true);
    expect(
      json(await search.search({ incident_id: id, query: 'pool' })).error,
    ).toBe('runbook_call_budget');
  });
  test('JSONL snapshot survives changed handbooks and history performs no search or disk read', async () => {
    const dir = copy(),
      eventsDir = path.join(path.dirname(dir), 'events');
    const gate = new IncidentApprovalGate({
      events: new JsonlIncidentEvents(eventsDir),
    });
    const index = RunbookIndex.load(dir),
      search = new IncidentRunbookSearch(
        index,
        [{ incident_id: id, ...scope }],
        run,
      );
    await createIncidentRunbookTool(search, gate).handler(
      { incident_id: id, query: 'pool exhausted' },
      {},
    );
    const lines = fs
      .readFileSync(path.join(eventsDir, `${id}.jsonl`), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const recorded = structuredClone(search.context.forRun(id, run));
    fs.writeFileSync(path.join(dir, 'resource-pool.md'), '# New\n\nnew manual');
    const disk = vi.spyOn(fs, 'openSync'),
      query = vi.spyOn(index, 'search');
    expect(readRecordedKnowledge(lines, id, run)).toEqual(recorded);
    expect(disk).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(readRecordedKnowledge(lines, id, 'other')).toEqual([]);
  });
  test('corrupt/foreign scope references and observation fields rejected', async () => {
    const { search, tool, gate } = setup();
    await tool.handler({ incident_id: id, query: 'pool exhausted' }, {});
    const reference = search.context.forRun(id, run)[0];
    expect(() =>
      knowledgeReferenceSchema.parse({
        ...reference,
        evidence_id: 'not-an-observation',
      }),
    ).toThrow();
    expect(() =>
      knowledgeReferenceSchema.parse({
        ...reference,
        environment: 'production',
      }),
    ).toThrow();
    const bad = gate.events.snapshot();
    (bad[1].payload.knowledge_result as any).references[0].tool_call_id =
      'foreign';
    expect(() => readRecordedKnowledge(bad, id, run)).toThrow(
      'invalid_recorded_knowledge',
    );
  });
  test('MCP isolated host context exposes exactly four observation tools plus search; actual Pi adapter executes', async () => {
    const { search, gate } = setup();
    const ctx = {
      chatJid: 'x',
      groupFolder: 'x',
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      workspaceIpc: '',
      workspaceGroup: '',
      incidentApprovalGate: gate,
      incidentProviderRoute: {
        mode: 'fixture' as const,
        provider: new FixtureProvider(),
      },
      incidentRunbookSearch: search,
    };
    const tools = createMcpTools(ctx);
    expect(tools).toHaveLength(5);
    expect(tools.map((t) => t.name)).toContain('search_runbooks');
    expect(
      tools.some((t) => t.name.includes('file') || t.name.includes('write')),
    ).toBe(false);
    const pi = adaptClaudeMcpToolsToPi(tools, { namespace: 'probe' }).find(
      (t) => t.name === 'probe__search_runbooks',
    )!;
    const result = await pi.execute(
      'pi-call',
      { incident_id: id, query: 'pool exhausted' },
      undefined,
      undefined,
      undefined as never,
    );
    expect(json(result).references[0].tool_call_id).toBe('pi-call');
    expect(() =>
      createMcpTools({ ...ctx, incidentProviderRoute: undefined }),
    ).toThrow('runbook_requires_isolated_incident_route');
    expect(() =>
      createMcpTools({ ...ctx, incidentApprovalGate: undefined }),
    ).toThrow('incident_provider_requires_host_gate');
  });
});
