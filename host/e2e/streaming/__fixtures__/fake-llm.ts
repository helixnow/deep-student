import type {
  LlmAdapterService, ProviderAdapter, ProviderKind, StreamEvent,
} from '../../../plugins/llm-providers/api.ts';

/** Test-only public llmAdapters injection. No fetch, provider or pipeline mocks. */
export const scripts = {
  answer: [[{ type: 'ContentChunk', value: '固定' }, { type: 'ContentChunk', value: '回答' },
    { type: 'Usage', value: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } }, { type: 'Done' }]],
  thinking: [[{ type: 'ReasoningChunk', value: '先分析' }, { type: 'ContentChunk', value: '再回答' },
    { type: 'Usage', value: { prompt_tokens: 9, completion_tokens: 6, total_tokens: 15,
      completion_tokens_details: { reasoning_tokens: 2 } } }, { type: 'Done' }]],
  tool: [[{ type: 'ToolCall', value: { id: 'call_fixed', type: 'function', function: {
    name: 'builtin-web_search', arguments: '{"query":"fixed"}',
  } } }, { type: 'Done' }], [{ type: 'ContentChunk', value: '工具结果已收到' }, { type: 'Done' }]],
  error: [[{ type: 'ContentChunk', value: '部分回答' }]],
  cancel: [[{ type: 'ContentChunk', value: '取消前内容' }]],
  retry: [[{ type: 'ContentChunk', value: '重试回答' }, { type: 'Done' }]],
  variant: [[{ type: 'ReasoningChunk', value: '变体思考' }, { type: 'ContentChunk', value: '变体回答' }, { type: 'Done' }]],
} satisfies Record<string, StreamEvent[][]>;

export type Scenario = keyof typeof scripts;

export class FakeLlmAdapters implements LlmAdapterService {
  readonly created: ProviderKind[] = [];
  readonly parsed: string[] = [];
  /** EOF finalization reached by the real transport, not called from the test. */
  readonly finished: number[] = [];
  /** Actual provider buildRequest inputs, for checking tool-result replay on round two. */
  readonly requests: Array<{ round: number; model: string; body: unknown }> = [];
  constructor(public scenario: Scenario, private readonly endpoint = 'http://127.0.0.1:9/x5-never-network') {}

  createAdapter(kind: ProviderKind): ProviderAdapter {
    const round = this.created.length;
    this.created.push(kind);
    const events = scripts[this.scenario][round] ?? [];
    let cursor = 0;
    return {
      buildRequest: (_baseUrl, _key, model, body) => {
        this.requests.push({ round, model, body: structuredClone(body) });
        return { url: this.endpoint, headers: [['content-type', 'application/json']], body };
      },
      requiresExplicitStreamCompletion: () => true,
      parseStream: line => {
        this.parsed.push(line);
        if (this.scenario === 'error' && cursor === events.length) throw new Error('X5 deterministic LLM error');
        const event = events[cursor++];
        return event ? [structuredClone(event)] : [];
      },
      finishStream: () => { this.finished.push(round); return []; },
    };
  }
}
