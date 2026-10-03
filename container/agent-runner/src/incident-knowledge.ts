/** Knowledge is a separate context category, never Diagnosis.evidence_ids. */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AgentEvent, JsonValue } from './incident-agent-events.js';
import { IncidentApprovalGate } from './incident-approval-gate.js';
import type { InMemoryIncidentEvidence } from './incident-evidence-collection.js';
import { defineMcpTool, type McpToolResult } from './mcp-tool-types.js';
import { withIncidentToolEvents } from './incident-tool-events.js';
import {
  RunbookIndex,
  RunbookError,
  RUNBOOK_NOTICE,
} from './incident-runbooks.js';

const incidentId = z
  .string()
  .regex(
    /^(?:INC-\d{3}|LIVE-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/,
  );
const name = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
const names = z.array(name).min(1).max(32);
export const knowledgeReferenceSchema = z
  .strictObject({
    reference_id: z.uuid(),
    incident_id: incidentId,
    run_id: name,
    tool_call_id: z.string().min(1).max(100),
    query: z.string().min(1).max(256),
    doc_id: name,
    version: z.string().regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}$/),
    version_hash: z.string().regex(/^[a-f0-9]{64}$/),
    catalog_hash: z.string().regex(/^[a-f0-9]{64}$/),
    section: z.string().min(1).max(1000),
    chunk_id: z.string().min(1).max(200),
    chunk_index: z.number().int().nonnegative(),
    services: names,
    environments: names,
    service: name,
    environment: name,
    start_offset: z.number().int().nonnegative(),
    end_offset: z.number().int().positive(),
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
    snippet: z.string().min(1).max(1000),
    rank: z.number().int().min(1).max(5),
    score: z.number().finite().positive(),
    retrieved_at: z.iso.datetime({ offset: true }),
    purpose: z.literal('investigation_guidance'),
  })
  .superRefine((r, ctx) => {
    if (
      r.end_offset - r.start_offset !== r.snippet.length ||
      r.end_line < r.start_line ||
      !r.services.includes(r.service) ||
      !r.environments.includes(r.environment)
    )
      ctx.addIssue({
        code: 'custom',
        message: 'invalid reference location or scope',
      });
  });
export type KnowledgeReference = z.infer<typeof knowledgeReferenceSchema>;
const bindingSchema = z.strictObject({
  incident_id: incidentId,
  service: name,
  environment: name,
  allowed_doc_ids: names,
});
export type KnowledgeBinding = z.infer<typeof bindingSchema>;
export const runbookQueryShape = {
  incident_id: incidentId,
  query: z.string().trim().min(1).max(256),
  top_k: z.number().int().min(1).max(5).default(3),
};
const querySchema = z.strictObject(runbookQueryShape);
const resultSchema = z.strictObject({
  kind: z.literal('runbook_search'),
  incident_id: incidentId,
  run_id: name,
  query: z.string().min(1).max(256),
  status: z.enum(['matched', 'no_match']),
  notice: z.literal(RUNBOOK_NOTICE),
  references: z.array(knowledgeReferenceSchema).max(5),
});

export class IncidentKnowledgeContext {
  private readonly references = new Map<string, KnowledgeReference>();
  collect(items: KnowledgeReference[]): void {
    const parsed = items.map((item) => knowledgeReferenceSchema.parse(item));
    if (new Set(parsed.map((r) => r.reference_id)).size !== parsed.length)
      throw new RunbookError('duplicate_knowledge_reference');
    if (this.references.size + parsed.length > 256)
      throw new RunbookError('knowledge_context_limit');
    for (const reference of parsed) {
      if (this.references.has(reference.reference_id))
        throw new RunbookError('duplicate_knowledge_reference');
    }
    for (const reference of parsed)
      this.references.set(reference.reference_id, structuredClone(reference));
  }
  forRun(incident: string, run: string): KnowledgeReference[] {
    return structuredClone(
      [...this.references.values()].filter(
        (r) => r.incident_id === incident && r.run_id === run,
      ),
    );
  }
}

export class IncidentRunbookSearch {
  private readonly bindings = new Map<string, KnowledgeBinding>();
  private calls = 0;
  readonly context = new IncidentKnowledgeContext();
  readonly run_id: string;
  constructor(
    private readonly index: RunbookIndex,
    bindings: KnowledgeBinding[],
    runId: string,
  ) {
    this.run_id = name.parse(runId);
    if (bindings.length > 32)
      throw new RunbookError('invalid_knowledge_bindings');
    for (const input of bindings) {
      const binding = bindingSchema.parse(input);
      if (this.bindings.has(binding.incident_id))
        throw new RunbookError('duplicate_knowledge_binding');
      this.bindings.set(binding.incident_id, structuredClone(binding));
    }
  }
  async search(
    input: unknown,
    extra: { signal?: AbortSignal; toolCallId?: string } = {},
  ): Promise<McpToolResult> {
    const errorResult = (error: string): McpToolResult => ({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ kind: 'runbook_search', error }),
        },
      ],
    });
    try {
      const query = querySchema.safeParse(input);
      if (!query.success) return errorResult('invalid_search');
      const binding = this.bindings.get(query.data.incident_id);
      if (!binding) return errorResult('incident_not_bound');
      if (extra.signal?.aborted) return errorResult('cancelled');
      if (this.calls >= 16) return errorResult('runbook_call_budget');
      this.calls++;
      const at = new Date();
      const toolCallId = z
        .string()
        .min(1)
        .max(100)
        .parse(extra.toolCallId ?? randomUUID());
      const hits = this.index.search(
        query.data.query,
        binding,
        query.data.top_k,
        at,
      );
      const references = hits.map((h) =>
        knowledgeReferenceSchema.parse({
          reference_id: randomUUID(),
          incident_id: binding.incident_id,
          run_id: this.run_id,
          tool_call_id: toolCallId,
          query: query.data.query,
          doc_id: h.doc_id,
          version: h.version,
          version_hash: h.version_hash,
          catalog_hash: this.index.catalog_hash,
          section: h.section,
          chunk_id: h.chunk_id,
          chunk_index: h.chunk_index,
          services: h.services,
          environments: h.environments,
          service: binding.service,
          environment: binding.environment,
          start_offset: h.start_offset,
          end_offset: h.end_offset,
          start_line: h.start_line,
          end_line: h.end_line,
          snippet: h.snippet,
          rank: h.rank,
          score: h.score,
          retrieved_at: at.toISOString(),
          purpose: 'investigation_guidance',
        }),
      );
      const result = resultSchema.parse({
        kind: 'runbook_search',
        incident_id: binding.incident_id,
        run_id: this.run_id,
        query: query.data.query,
        status: references.length ? 'matched' : 'no_match',
        notice: RUNBOOK_NOTICE,
        references,
      });
      const text = JSON.stringify(result);
      if (Buffer.byteLength(text) > 24576)
        return errorResult('runbook_result_limit');
      if (extra.signal?.aborted) return errorResult('cancelled');
      this.context.collect(references);
      return { content: [{ type: 'text', text }] };
    } catch (error) {
      return errorResult(
        error instanceof RunbookError ? error.code : 'runbook_search_failed',
      );
    }
  }
}

function parsedResult(result: McpToolResult) {
  const item = result.content.find((c) => c.type === 'text');
  if (result.isError || !item || item.type !== 'text') return undefined;
  return resultSchema.parse(JSON.parse(item.text));
}

/** The existing event contract carries a frozen snapshot in ToolResult payload. */
export function createIncidentRunbookTool(
  search: IncidentRunbookSearch,
  gate: IncidentApprovalGate,
  resultPayload?: (result: McpToolResult) => Record<string, JsonValue>,
) {
  const definition = defineMcpTool(
    'search_runbooks',
    'Search host-approved Markdown/BM25 guidance for this Incident. Knowledge is not observed Evidence or root-cause proof. No file paths, URLs or actions.',
    runbookQueryShape,
    (args, extra) =>
      gate.runSafe('search_runbooks', () =>
        search.search(
          args,
          extra as { signal?: AbortSignal; toolCallId?: string },
        ),
      ),
  );
  const wrapped = withIncidentToolEvents(definition, gate.events, {
    collectsEvidence: false,
    timeoutMs: 1000,
    resultPayload: (result): Record<string, JsonValue> => {
      const snapshot = parsedResult(result);
      return {
        ...resultPayload?.(result),
        ...(snapshot
          ? { knowledge_result: snapshot as unknown as JsonValue }
          : {}),
      };
    },
  });
  return {
    ...wrapped,
    handler: (args: any, extra: unknown) => {
      const x =
        extra && typeof extra === 'object'
          ? (extra as { toolCallId?: string })
          : {};
      const supplied = z.string().min(1).max(100).safeParse(x.toolCallId);
      return wrapped.handler(args, {
        ...x,
        toolCallId: supplied.success ? supplied.data : randomUUID(),
      });
    },
  };
}

/** Historical projection only: no index, files, clock, search or model calls. */
export function readRecordedKnowledge(
  events: AgentEvent[],
  incident: string,
  runId: string,
): KnowledgeReference[] {
  const collected = new IncidentKnowledgeContext();
  for (const event of events) {
    if (
      event.incident_id !== incident ||
      event.event_type !== 'ToolResult' ||
      event.payload.tool !== 'search_runbooks' ||
      event.payload.status !== 'returned'
    )
      continue;
    const snapshot = resultSchema.parse(event.payload.knowledge_result);
    if (snapshot.incident_id !== incident || snapshot.run_id !== runId)
      continue;
    if (
      snapshot.references.some(
        (r) =>
          r.incident_id !== incident ||
          r.run_id !== runId ||
          r.query !== snapshot.query ||
          r.tool_call_id !== event.payload.tool_call_id,
      )
    )
      throw new RunbookError('invalid_recorded_knowledge');
    collected.collect(snapshot.references);
  }
  return collected.forRun(incident, runId);
}

/** Suitable for an investigation prompt/view; categories remain visibly separate. */
export function incidentInvestigationContext(
  evidence: InMemoryIncidentEvidence,
  knowledge: IncidentKnowledgeContext,
  incident: string,
  runId: string,
) {
  if (!incidentId.safeParse(incident).success || !name.safeParse(runId).success)
    throw new RunbookError('invalid_investigation_context');
  return {
    incident_id: incident,
    run_id: runId,
    observed_evidence: evidence.forIncident(incident),
    knowledge_references: knowledge.forRun(incident, runId),
    knowledge_notice: RUNBOOK_NOTICE,
  };
}
