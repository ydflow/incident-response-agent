import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createIncidentEvidenceTools } from '../container/agent-runner/src/incident-evidence-tools.js';
import { createMcpTools } from '../container/agent-runner/src/mcp-tools.js';
import { adaptClaudeMcpToolsToPi } from '../container/agent-runner/src/runtime/pi/pi-tools.js';

const fixtureRoot = path.resolve('incident_agent/fixtures');
const temporaryRoots: string[] = [];

function resultText(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const first = result.content[0];
  expect(first.type).toBe('text');
  return JSON.parse(first.text ?? '') as Record<string, unknown>;
}

function copyFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'miniclaw-inc-'));
  temporaryRoots.push(root);
  fs.cpSync(path.join(fixtureRoot, 'INC-001'), path.join(root, 'INC-001'), {
    recursive: true,
  });
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe('INC-001 read-only evidence tools', () => {
  test('all four tools return the same Evidence field contract', async () => {
    for (const tool of createIncidentEvidenceTools(fixtureRoot)) {
      const result = await tool.handler({ incident_id: 'INC-001' }, {});
      expect(result.isError).not.toBe(true);
      const evidence = resultText(result);
      expect(Object.keys(evidence).sort()).toEqual([
        'content',
        'correlation_id',
        'evidence_id',
        'incident_id',
        'source',
        'timestamp',
      ]);
      expect(evidence.incident_id).toBe('INC-001');
      expect(evidence.evidence_id).toBe(`INC-001:${evidence.source}`);
      expect(Date.parse(String(evidence.timestamp))).not.toBeNaN();
      expect(String(evidence.content).length).toBeGreaterThan(0);
    }
  });

  test('unknown incident has an explicit error', async () => {
    const tool = createIncidentEvidenceTools(fixtureRoot)[0];
    const result = await tool.handler({ incident_id: 'INC-999' }, {});
    expect(result.isError).toBe(true);
    expect(resultText(result).error).toBe('incident_not_found');
  });

  test.each([
    ['missing file', 'fixture_missing', undefined],
    ['invalid JSON', 'invalid_json', '{broken'],
    ['empty data', 'empty_data', '{"service":"payment-service","entries":[]}'],
  ])('%s returns %s', async (_label, code, replacement) => {
    const root = copyFixture();
    const file = path.join(root, 'INC-001', 'logs.json');
    if (replacement === undefined) fs.rmSync(file);
    else fs.writeFileSync(file, replacement);
    const tool = createIncidentEvidenceTools(root)[0];
    const result = await tool.handler({ incident_id: 'INC-001' }, {});
    expect(result.isError).toBe(true);
    expect(resultText(result).error).toBe(code);
  });

  test('MiniClaw registration and Pi adapter execute the same handler', async () => {
    const definitions = createMcpTools({
      chatJid: 'test:incident',
      groupFolder: 'test',
      isHome: false,
      isAdminHome: false,
      agentBuilderEnabled: false,
      ownerProfileEnabled: false,
      workspaceIpc: path.join(os.tmpdir(), 'unused-incident-ipc'),
      workspaceGroup: path.join(os.tmpdir(), 'unused-incident-group'),
    });
    const selected = definitions.filter((tool) =>
      tool.name.startsWith('query_'),
    );
    expect(selected.map((tool) => tool.name)).toEqual([
      'query_logs',
      'query_metrics',
      'query_trace',
      'query_git_diff',
    ]);
    const piTools = adaptClaudeMcpToolsToPi(selected, {
      namespace: 'mcp__miniclaw',
    });
    const queryMetrics = piTools.find(
      (tool) => tool.name === 'mcp__miniclaw__query_metrics',
    );
    expect(queryMetrics).toBeDefined();
    const result = await queryMetrics!.execute(
      'test-tool-call-1',
      { incident_id: 'INC-001' },
      new AbortController().signal,
    );
    const evidence = resultText(result);
    expect(evidence.source).toBe('metrics');
    expect(evidence.incident_id).toBe('INC-001');
  });
});
