/** Protocol fixture, NEVER a real model evaluation. Output cites incoming real observations. */
import { createServer } from 'node:http';
export async function incidentProtocolStub(
  mode:
    | 'diagnose'
    | 'conflict'
    | 'partial'
    | 'loop'
    | 'invalid'
    | 'bad_report' = 'diagnose',
) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    requests++;
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw),
      first = body.messages.find((m: any) => m.role === 'user');
    const prompt = JSON.parse(
      typeof first.content === 'string'
        ? first.content
        : first.content.find((c: any) => c.type === 'text').text,
    );
    // Only inspect actual transport content, never a case answer or evaluation corpus.
    if (JSON.stringify(body).includes('expected_cases.json'))
      throw Error('protected_prompt');
    const callTool = requests % 2 === 1 || mode === 'loop';
    let block: any, delta: any, reason: string;
    if (callTool) {
      const suffix =
          mode === 'partial' ? 'query_live_trace' : 'query_live_metrics',
        name = body.tools.find((t: any) => t.name.endsWith(suffix)).name;
      block = { type: 'tool_use', id: `tool-${requests}`, name, input: {} };
      delta = {
        type: 'input_json_delta',
        partial_json: JSON.stringify(
          mode === 'invalid'
            ? {}
            : { incident_id: prompt.incident.incident_id },
        ),
      };
      reason = 'tool_use';
    } else {
      const evidence = prompt.context.observed_evidence,
        metrics = evidence.find((e: any) => e.source === 'metrics'),
        items = JSON.parse(metrics.content).items,
        index = items.length - 1;
      const report = {
        outcome: 'DIAGNOSED',
        diagnosis: {
          incident_id: prompt.incident.incident_id,
          root_cause: 'Protocol fixture conclusion; not a model inference.',
          confidence: 0.75,
          evidence_ids: [metrics.evidence_id],
          recommendation: '人工核验资源竞争及恢复指标。',
        },
        facts: [
          {
            evidence_id: metrics.evidence_id,
            item_index: index,
            field: 'acquire_timeouts',
            value: items[index].acquire_timeouts,
          },
        ],
        hypotheses: [
          {
            hypothesis: '资源等待的因果关系仍需额外核验。',
            evidence_ids: [metrics.evidence_id],
            knowledge_reference_ids: [],
          },
        ],
        handbook_suggestions: [],
        conflicts:
          mode === 'conflict'
            ? [
                {
                  description:
                    'Protocol fixture asks for conflict review; no semantic conflict detector is claimed.',
                  evidence_ids: evidence.map((e: any) => e.evidence_id),
                },
              ]
            : [],
        limitations: ['协议桩只验证结构化输出与运行链路，不验证模型推理。'],
        next_evidence_requests: [],
        escalation_reason: null,
        approval_proposals: [],
      };
      block = { type: 'text', text: '' };
      delta = {
        type: 'text_delta',
        text:
          mode === 'bad_report'
            ? '{invalid JSON report'
            : JSON.stringify(report),
      };
      reason = 'end_turn';
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const emit = (type: string, value: unknown) =>
      res.write(`event: ${type}\ndata: ${JSON.stringify(value)}\n\n`);
    emit('message_start', {
      type: 'message_start',
      message: {
        id: `m-${requests}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    });
    emit('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: block,
    });
    emit('content_block_delta', {
      type: 'content_block_delta',
      index: 0,
      delta,
    });
    emit('content_block_stop', { type: 'content_block_stop', index: 0 });
    emit('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: reason, stop_sequence: null },
      usage: { output_tokens: 1 },
    });
    emit('message_stop', { type: 'message_stop' });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    config: {
      base_url: `http://127.0.0.1:${address.port}`,
      model: 'protocol-fixture',
      api_key: 'test-only',
      mode: 'protocol_stub' as const,
    },
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((e) => (e ? reject(e) : resolve()));
        server.closeAllConnections();
      }),
  };
}
