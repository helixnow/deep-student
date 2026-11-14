import { describe, expect, it } from 'vitest';
import {
  aggregateToolCalls, collectContent, collectToolCalls, driveParser, parserForAdapterId,
} from './streaming-harness-support.ts';
import type { JsonValue, StreamEvent } from '../../llm-providers/api.ts';

/**
 * 流式格式回归夹具（llm_manager/adapters/streaming_harness.rs）。
 *
 * 只验证解析层：每个供应商官方 SSE 示例经 `RequestAdapter::id()` 路由到对应
 * ProviderAdapter 后，产出预期的 ContentChunk / ToolCall / Usage / Done 事件。
 */

type Payload = string | { [key: string]: unknown };

/** OpenAI 兼容 SSE：每行一个 `data: <json>` 事件。 */
function openaiFixture(payloads: Payload[]): string {
  return payloads
    .map((payload) => `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n`)
    .join('');
}

/** Anthropic Messages SSE：`event:` + `data:` 成对出现，事件间空行分隔。 */
function anthropicFixture(events: { event: string; data: { [key: string]: unknown } | null }[]): string {
  return events
    .map(({ event, data }) => (data === null
      ? `event: ${event}\n\n`
      : `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
    .join('');
}

const OPENAI_TEXT_FIXTURE = openaiFixture([
  { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ delta: { role: 'assistant' }, index: 0 }] },
  { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ delta: { content: 'Hello' }, index: 0 }] },
  { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ delta: { content: ', ' }, index: 0 }] },
  { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ delta: { content: 'world' }, index: 0 }] },
  {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  },
  '[DONE]',
]);

const OPENAI_TOOL_FIXTURE = openaiFixture([
  {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0, id: 'call_abc', type: 'function',
          function: { name: 'get_weather', arguments: '' },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":' } }] } }] },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"Paris"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);

const DEEPSEEK_TEXT_FIXTURE = openaiFixture([
  { id: 'x', choices: [{ index: 0, delta: { reasoning_content: '思考中...' } }] },
  { id: 'x', choices: [{ index: 0, delta: { content: '答案是 ' } }] },
  { id: 'x', choices: [{ index: 0, delta: { content: '42' } }] },
  {
    id: 'x',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
  },
  '[DONE]',
]);

const DEEPSEEK_TOOL_FIXTURE = openaiFixture([
  {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0, id: 'call_1', type: 'function',
          function: { name: 'search', arguments: '' },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"q":"deepseek"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);

const DOUBAO_TEXT_FIXTURE = openaiFixture([
  {
    id: '021', object: 'chat.completion.chunk', created: 1700000000, model: 'doubao-seed-1-6',
    choices: [{ index: 0, delta: { role: 'assistant', content: '' } }],
  },
  { id: '021', choices: [{ index: 0, delta: { content: '豆' } }] },
  { id: '021', choices: [{ index: 0, delta: { content: '包' } }] },
  { id: '021', choices: [{ index: 0, delta: { content: '你好' } }] },
  {
    id: '021',
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
  },
  '[DONE]',
]);

const DOUBAO_TOOL_FIXTURE = openaiFixture([
  {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0, id: 'call_doubao_1', type: 'function',
          function: { name: 'book_flight', arguments: '' },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Shanghai"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);

const ERNIE_TEXT_FIXTURE = openaiFixture([
  {
    id: 'as-1', object: 'chat.completion.chunk', created: 1700000000,
    choices: [{ index: 0, delta: { role: 'assistant', content: '文心' }, flag: 0 }],
  },
  { id: 'as-1', choices: [{ index: 0, delta: { content: '一言' } }] },
  {
    id: 'as-1',
    choices: [{ index: 0, delta: { content: '，您好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  },
  '[DONE]',
]);

const ERNIE_TOOL_FIXTURE = openaiFixture([
  {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0, id: 'call_ernie_1', type: 'function',
          function: { name: 'check_balance', arguments: '' },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"user_id":12345}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);

const GROK_TEXT_FIXTURE = openaiFixture([
  {
    id: 'grok-1', object: 'chat.completion.chunk',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Grok' } }],
  },
  { id: 'grok-1', choices: [{ index: 0, delta: { content: ' here' } }] },
  {
    id: 'grok-1',
    choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  },
  '[DONE]',
]);

const GROK_TOOL_FIXTURE = openaiFixture([
  {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0, id: 'call_grok_1', type: 'function',
          function: { name: 'web_search', arguments: '' },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"xai news"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);

const MINIMAX_TEXT_FIXTURE = openaiFixture([
  { id: 'mm-1', choices: [{ index: 0, delta: { role: 'assistant', content: '海螺' } }] },
  { id: 'mm-1', choices: [{ index: 0, delta: { content: 'AI' } }] },
  {
    id: 'mm-1',
    choices: [{ index: 0, delta: { content: '问候' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
  },
  '[DONE]',
]);

const MINIMAX_TOOL_FIXTURE = openaiFixture([
  {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0, id: 'call_mm_1', type: 'function',
          function: { name: 'translate', arguments: '' },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"text":"hi"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);

const MISTRAL_TEXT_FIXTURE = openaiFixture([
  {
    id: 'mst-1', object: 'chat.completion.chunk', model: 'mistral-large-latest',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Bon' } }],
  },
  { id: 'mst-1', choices: [{ index: 0, delta: { content: 'jour' } }] },
  {
    id: 'mst-1',
    choices: [{ index: 0, delta: { content: '!' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 },
  },
  '[DONE]',
]);

const MISTRAL_TOOL_FIXTURE = openaiFixture([
  {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0, id: 'call_mst_1', type: 'function',
          function: { name: 'order_baguette', arguments: '' },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"qty":2}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);

const MOONSHOT_TEXT_FIXTURE = openaiFixture([
  {
    id: 'cmpl-kimi', object: 'chat.completion.chunk', model: 'kimi-k2',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'Kimi' } }],
  },
  { id: 'cmpl-kimi', choices: [{ index: 0, delta: { content: ' 上线' } }] },
  {
    id: 'cmpl-kimi',
    choices: [{ index: 0, delta: { content: '。' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  },
  '[DONE]',
]);

const MOONSHOT_TOOL_FIXTURE = openaiFixture([
  {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0, id: 'call_kimi_1', type: 'function',
          function: { name: 'summarize', arguments: '' },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"doc_id":"abc"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);

const QWEN_TEXT_FIXTURE = openaiFixture([
  {
    id: 'qw-1', object: 'chat.completion.chunk', model: 'qwen-max',
    choices: [{ index: 0, delta: { role: 'assistant', content: '通义' } }],
  },
  { id: 'qw-1', choices: [{ index: 0, delta: { content: '千问' } }] },
  {
    id: 'qw-1',
    choices: [{ index: 0, delta: { content: '在此' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
  },
  '[DONE]',
]);

const QWEN_TOOL_FIXTURE = openaiFixture([
  {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0, id: 'call_qwen_1', type: 'function',
          function: { name: 'calc', arguments: '' },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"expr":"1+1"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);

const ZHIPU_TEXT_FIXTURE = openaiFixture([
  {
    id: 'zp-1', object: 'chat.completion.chunk', model: 'glm-4-plus',
    choices: [{ index: 0, delta: { role: 'assistant', content: '智谱' } }],
  },
  { id: 'zp-1', choices: [{ index: 0, delta: { content: 'GLM' } }] },
  {
    id: 'zp-1',
    choices: [{ index: 0, delta: { content: '已就绪' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
  },
  '[DONE]',
]);

const ZHIPU_TOOL_FIXTURE = openaiFixture([
  {
    choices: [{
      index: 0,
      delta: {
        role: 'assistant',
        tool_calls: [{
          index: 0, id: 'call_zp_1', type: 'function',
          function: { name: 'web_browser', arguments: '' },
        }],
      },
    }],
  },
  { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"url":"https://example.com"}' } }] } }] },
  { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  '[DONE]',
]);

const ANTHROPIC_TEXT_FIXTURE = anthropicFixture([
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_01', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4',
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
  },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi ' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'there' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '!' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 10, output_tokens: 3 } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const ANTHROPIC_TOOL_FIXTURE = anthropicFixture([
  {
    event: 'message_start',
    data: {
      type: 'message_start',
      message: {
        id: 'msg_02', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-4',
        usage: { input_tokens: 12, output_tokens: 1 },
      },
    },
  },
  {
    event: 'content_block_start',
    data: {
      type: 'content_block_start', index: 0,
      content_block: { type: 'tool_use', id: 'toolu_01', name: 'get_stock_price', input: {} },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"ticker":' },
    },
  },
  {
    event: 'content_block_delta',
    data: {
      type: 'content_block_delta', index: 0,
      delta: { type: 'input_json_delta', partial_json: '"AAPL"}' },
    },
  },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  {
    event: 'message_delta',
    data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 12, output_tokens: 20 } },
  },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const GEMINI_TEXT_FIXTURE = openaiFixture([
  { candidates: [{ content: { role: 'model', parts: [{ text: 'Hello' }] }, index: 0 }] },
  { candidates: [{ content: { role: 'model', parts: [{ text: ' from ' }] }, index: 0 }] },
  {
    candidates: [{ content: { role: 'model', parts: [{ text: 'Gemini' }] }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 },
  },
]);

const GEMINI_TOOL_FIXTURE = openaiFixture([
  {
    candidates: [{
      content: {
        role: 'model',
        parts: [{ functionCall: { name: 'find_movies', args: { location: 'Mountain View', genre: 'comedy' } } }],
      },
      finishReason: 'STOP',
      index: 0,
    }],
    usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 12, totalTokenCount: 27 },
  },
]);

function eventsFor(adapterId: string, fixture: string): StreamEvent[] {
  return driveParser(parserForAdapterId(adapterId), fixture);
}

function assertStreamingText(adapterId: string, fixture: string, expected: string): void {
  const events = eventsFor(adapterId, fixture);
  expect(collectContent(events), `[${adapterId}] streaming text mismatch`).toBe(expected);
}

function assertStreamingToolCall(
  adapterId: string,
  fixture: string,
  expectedName: string,
  expectedArgs: JsonValue,
): void {
  const events = eventsFor(adapterId, fixture);
  const calls = collectToolCalls(events);
  expect(calls.length, `[${adapterId}] expected at least one tool_call`).toBeGreaterThan(0);
  const aggregated = aggregateToolCalls(calls);
  expect(aggregated).not.toBeNull();
  expect(aggregated!.name, `[${adapterId}] tool name mismatch`).toBe(expectedName);
  expect(aggregated!.parsedArguments, `[${adapterId}] tool arguments mismatch`).toEqual(expectedArgs);
}

describe('src-tauri/crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs', () => {
  it('streaming_text_generic_openai', () => {
    assertStreamingText('general', OPENAI_TEXT_FIXTURE, 'Hello, world');
  });

  it('streaming_tool_call_generic_openai', () => {
    assertStreamingToolCall('general', OPENAI_TOOL_FIXTURE, 'get_weather', { city: 'Paris' });
  });

  it('streaming_text_deepseek', () => {
    assertStreamingText('deepseek', DEEPSEEK_TEXT_FIXTURE, '答案是 42');
  });

  it('streaming_tool_call_deepseek', () => {
    assertStreamingToolCall('deepseek', DEEPSEEK_TOOL_FIXTURE, 'search', { q: 'deepseek' });
  });

  it('streaming_text_doubao', () => {
    assertStreamingText('doubao', DOUBAO_TEXT_FIXTURE, '豆包你好');
  });

  it('streaming_tool_call_doubao', () => {
    assertStreamingToolCall('doubao', DOUBAO_TOOL_FIXTURE, 'book_flight', { city: 'Shanghai' });
  });

  it('streaming_text_ernie', () => {
    assertStreamingText('ernie', ERNIE_TEXT_FIXTURE, '文心一言，您好');
  });

  it('streaming_tool_call_ernie', () => {
    assertStreamingToolCall('ernie', ERNIE_TOOL_FIXTURE, 'check_balance', { user_id: 12345 });
  });

  it('streaming_text_grok', () => {
    assertStreamingText('grok', GROK_TEXT_FIXTURE, 'Grok here!');
  });

  it('streaming_tool_call_grok', () => {
    assertStreamingToolCall('grok', GROK_TOOL_FIXTURE, 'web_search', { query: 'xai news' });
  });

  it('streaming_text_minimax', () => {
    assertStreamingText('minimax', MINIMAX_TEXT_FIXTURE, '海螺AI问候');
  });

  it('streaming_tool_call_minimax', () => {
    assertStreamingToolCall('minimax', MINIMAX_TOOL_FIXTURE, 'translate', { text: 'hi' });
  });

  it('streaming_text_mistral', () => {
    assertStreamingText('mistral', MISTRAL_TEXT_FIXTURE, 'Bonjour!');
  });

  it('streaming_tool_call_mistral', () => {
    assertStreamingToolCall('mistral', MISTRAL_TOOL_FIXTURE, 'order_baguette', { qty: 2 });
  });

  it('streaming_text_moonshot', () => {
    assertStreamingText('moonshot', MOONSHOT_TEXT_FIXTURE, 'Kimi 上线。');
  });

  it('streaming_tool_call_moonshot', () => {
    assertStreamingToolCall('moonshot', MOONSHOT_TOOL_FIXTURE, 'summarize', { doc_id: 'abc' });
  });

  it('streaming_text_qwen', () => {
    assertStreamingText('qwen', QWEN_TEXT_FIXTURE, '通义千问在此');
  });

  it('streaming_tool_call_qwen', () => {
    assertStreamingToolCall('qwen', QWEN_TOOL_FIXTURE, 'calc', { expr: '1+1' });
  });

  it('streaming_text_zhipu', () => {
    assertStreamingText('zhipu', ZHIPU_TEXT_FIXTURE, '智谱GLM已就绪');
  });

  it('streaming_tool_call_zhipu', () => {
    assertStreamingToolCall('zhipu', ZHIPU_TOOL_FIXTURE, 'web_browser', { url: 'https://example.com' });
  });

  it('streaming_text_anthropic', () => {
    assertStreamingText('anthropic', ANTHROPIC_TEXT_FIXTURE, 'Hi there!');
  });

  it('streaming_tool_call_anthropic', () => {
    assertStreamingToolCall('anthropic', ANTHROPIC_TOOL_FIXTURE, 'get_stock_price', { ticker: 'AAPL' });
  });

  it('streaming_text_gemini', () => {
    assertStreamingText('gemini', GEMINI_TEXT_FIXTURE, 'Hello from Gemini');
  });

  it('streaming_tool_call_gemini', () => {
    assertStreamingToolCall('gemini', GEMINI_TOOL_FIXTURE, 'find_movies', {
      location: 'Mountain View',
      genre: 'comedy',
    });
  });

  it('openai_compatible_emits_usage_and_done', () => {
    const events = eventsFor('general', OPENAI_TEXT_FIXTURE);
    expect(events.some((event) => event.type === 'Usage')).toBe(true);
    expect(events.some((event) => event.type === 'Done')).toBe(true);
  });

  it('anthropic_emits_usage_and_done', () => {
    const events = eventsFor('anthropic', ANTHROPIC_TEXT_FIXTURE);
    expect(events.some((event) => event.type === 'Usage')).toBe(true);
    expect(events.some((event) => event.type === 'Done')).toBe(true);
  });

  it('gemini_emits_usage', () => {
    const events = eventsFor('gemini', GEMINI_TEXT_FIXTURE);
    expect(events.some((event) => event.type === 'Usage')).toBe(true);
  });

  it('parsers_silently_ignore_garbage_lines', () => {
    const garbage = [
      ': heartbeat',
      'event: ping',
      'data:',
      'data: this-is-not-json',
      'data: {"choices":[{"delta":{"content":"survived"}}]}',
      '',
    ].join('\n');
    expect(collectContent(eventsFor('general', garbage))).toBe('survived');
    // Anthropic / Gemini parsers must not throw on the same garbage.
    for (const adapterId of ['anthropic', 'gemini']) {
      expect(eventsFor(adapterId, garbage).length).toBeGreaterThanOrEqual(0);
    }
  });
});
