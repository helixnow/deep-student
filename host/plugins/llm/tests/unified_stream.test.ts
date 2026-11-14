import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flushPendingDebugLogWrites } from '../src/audit_log.ts';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import translation from '../../translation/index.ts';
import { makeConfig } from './support.ts';
import type { LlmStreamHooks, UnifiedModel2StreamInput } from '../api.ts';

let host: Awaited<ReturnType<typeof createTestHost>>;
let handle: (body: unknown, response: ServerResponse) => void;
const server = createServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  handle(JSON.parse(Buffer.concat(chunks).toString()), response);
});
let baseUrl: string;
const settings = new Map<string, string>();
beforeAll(async () => {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  host = await createTestHost({ plugins: [plugin, translation], provide: { settings: {
    get: (key: string) => settings.get(key) ?? null,
    save: (key: string, value: string) => { settings.set(key, value); },
    getSecret: async () => null, saveSecret: async () => {}, deleteSecret: async () => false,
  }, secrets: { isEncryptedFormat: () => false,
    openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) } } });
}, 120_000);
afterAll(async () => { await host.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
function input(streamEvent: string): UnifiedModel2StreamInput {
  return { context: {}, chatHistory: [{ role: 'user', content: 'ping' }], subject: '', enableChainOfThought: true,
    enableThinking: false, taskContext: 'chat_v2', sink: { emit() {} }, streamEvent, disableTools: true };
}
function call(value: UnifiedModel2StreamInput) {
  return host.ctx.llmModel2Streaming.callUnifiedModel2StreamWithConfig(makeConfig({ enabled: true, baseUrl,
    model: 'test-model', apiProtocol: 'openai_chat_completions', supportsTools: true }), 0, value);
}
const data = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
describe('production unified model-2 stream', () => {
  it('R1-TR-05: translation command consumes the real shared LLM HTTP client and stored model configuration', async () => {
    await host.ctx.llm.saveApiConfigurations([makeConfig({ id: 'translation-http', name: 'local translation', enabled: true,
      baseUrl, model: 'test-model', authMode: 'none', apiProtocol: 'openai_chat_completions', supportsTools: true })]);
    await host.ctx.llm.saveModelAssignments({ translation_model_config_id: 'translation-http' });
    let calls = 0;
    handle = (body, response) => {
      calls++; expect(body).toMatchObject({ model: 'test-model', stream: true });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: '共享传输' } }] }) + 'data: [DONE]\n\n');
    };
    expect(await host.invoke('translate_text_stream', { request: { session_id: 'shared-http', text: 'hello', src_lang: 'en', tgt_lang: 'zh' } }))
      .toMatchObject({ translated_text: '共享传输' });
    expect(calls).toBe(1);
  });
  it('preserves Rust Option field precedence for prefetched graph aliases including explicit null', async () => {
    handle = (body, response) => {
      expect(body).toMatchObject({ messages: [{ role: 'system' }, { role: 'user',
        content: 'ping\n\n<injected_context>\n【个人图谱】\n(2) Graph Insight\nkept\n</injected_context>' }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: 'ok' } }] }) + 'data: [DONE]\n\n');
    };
    const result = await call({ ...input('chat_v2_event_graph'), context: { prefetched_graph_sources: [
      { chunk_text: null, snippet: 'ignored', title: 'ignored' }, { file_name: null, title: 'ignored', snippet: 'kept' },
    ] } });
    expect(result.assistant_message).toBe('ok');
  });
  it('selects the configured model through the public unified entry and applies runtime overrides', async () => {
    await host.ctx.llm.saveApiConfigurations([makeConfig({ id: 'unified-live', name: 'local test', enabled: true,
      baseUrl, model: 'test-model', authMode: 'none', apiProtocol: 'openai_chat_completions', supportsTools: true })]);
    await host.ctx.llm.saveModelAssignments({ model2_config_id: 'unified-live' });
    handle = (body, response) => {
      expect(body).toMatchObject({ model: 'test-model', temperature: 0.25, stream: true });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: 'selected' } }] }) + 'data: [DONE]\n\n');
    };
    const result = await host.ctx.llmModel2Streaming.callUnifiedModel2Stream({ ...input('chat_v2_event_selected'),
      paramOverrides: { temperature: 0.25 } });
    expect(result.assistant_message).toBe('selected');
    expect(result.cancelled).toBe(false);
  });
  it('f32 runtime overrides go out as json!(f32) writes them under arbitrary_precision: the shortest f32 decimal', async () => {
    await host.ctx.llm.saveApiConfigurations([makeConfig({ id: 'unified-f32', name: 'local f32', enabled: true,
      baseUrl, model: 'test-model', authMode: 'none', apiProtocol: 'openai_chat_completions', supportsTools: true })]);
    await host.ctx.llm.saveModelAssignments({ model2_config_id: 'unified-f32' });
    const raw: string[] = [];
    handle = (body, response) => {
      raw.push(JSON.stringify(body));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: 'f32' } }] }) + 'data: [DONE]\n\n');
    };
    // Chat options reach the pipeline f32-narrowed (kernel x-float: f32), e.g. 0.3 → Math.fround(0.3).
    const narrowed = { temperature: Math.fround(0.3), topP: Math.fround(0.9), frequencyPenalty: Math.fround(0.1),
      presencePenalty: Math.fround(-0.7) };
    for (const paramOverrides of [narrowed, { temperature: 0.3, topP: 0.9, frequencyPenalty: 0.1, presencePenalty: -0.7 }]) {
      const result = await host.ctx.llmModel2Streaming.callUnifiedModel2Stream({ ...input('chat_v2_event_f32'), paramOverrides });
      expect(result.assistant_message).toBe('f32');
    }
    expect(raw).toHaveLength(2);
    for (const text of raw) {
      expect(text).toContain('"temperature":0.3,');
      expect(text).toContain('"top_p":0.9');
      expect(text).toContain('"frequency_penalty":0.1');
      expect(text).toContain('"presence_penalty":-0.7');
    }
  });
  it('V3.1 tool compat strips thinking fields with serde_json preserve_order Map::remove (swap_remove) key order', async () => {
    const bodies: Record<string, unknown>[] = [];
    handle = (body, response) => {
      bodies.push(body as Record<string, unknown>);
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: 'v31' } }] }) + 'data: [DONE]\n\n');
    };
    const config = makeConfig({ enabled: true, baseUrl, model: 'deepseek-ai/DeepSeek-V3.1', modelAdapter: 'deepseek',
      providerType: 'siliconflow', apiProtocol: 'openai_chat_completions', supportsTools: true, supportsReasoning: true,
      thinkingEnabled: true, thinkingBudget: 2048 });
    const tool = { type: 'function', function: { name: 'lookup', description: 'd', parameters: { type: 'object', properties: {} } } };
    await host.ctx.llmModel2Streaming.callUnifiedModel2StreamWithConfig(config, 0,
      { ...input('chat_v2_event_v31'), context: { custom_tools: [tool] }, disableTools: false, enableThinking: true });
    // model2_pipeline.rs:5840-5878 {model, messages, stream} + enable_thinking, thinking_budget + tools, tool_choice;
    // :6135 max_tokens, temperature; :6216 / :678-684 remove enable_thinking (temperature takes its slot),
    // then thinking_budget (max_tokens takes its slot).
    expect(bodies).toHaveLength(1);
    expect(Object.keys(bodies[0]!)).toEqual(['model', 'messages', 'stream', 'temperature', 'max_tokens', 'tools', 'tool_choice']);
  });
  it('deepseek_chat_audit_toggle_does_not_change_the_final_request', async () => {
    const requests: unknown[] = [];
    handle = (body, response) => {
      requests.push(body); response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: 'audited' } }] }) + 'data: [DONE]\n\n');
    };
    const config = makeConfig({ enabled: true, baseUrl, model: 'tree-deepseek-v4.1-flash', modelAdapter: 'deepseek',
      providerType: 'custom', apiProtocol: 'openai_chat_completions', supportsTools: true, maxOutputTokens: 128 });
    const value = { ...input('chat_v2_event_sess-audit-test'), systemPromptOverride: '<available_skills>exact IDs</available_skills>',
      chatHistory: [{ role: 'user', content: 'Load the skill' }], enableChainOfThought: false };
    try {
      for (const enabled of ['false', 'true']) {
        settings.set('debug.persist_logs', enabled);
        await host.ctx.llmModel2Streaming.callUnifiedModel2StreamWithConfig(config, 0, value);
      }
      expect(requests[0]).toMatchObject({ max_tokens: 128, messages: [
        { role: 'system', content: '<available_skills>exact IDs</available_skills>' }, { role: 'user', content: 'Load the skill' }] });
      expect(requests[1]).toEqual(requests[0]);
      expect(await flushPendingDebugLogWrites()).toBe(true);
      const directory = join(host.ctx.app.dataDir, 'logs', 'debug-logs');
      const files = await readdir(directory);
      expect(files).toHaveLength(1);
      const saved = JSON.parse(await readFile(join(directory, files[0]!), 'utf8'));
      expect(saved.request_body).toEqual(requests[1]);
    } finally { settings.delete('debug.persist_logs'); }
  });
  it('stream_with_noop_sink_completes_without_window', async () => {
    let calls = 0;
    handle = (body, response) => {
      calls++;
      expect(body).toMatchObject({ model: 'test-model', stream: true, messages: [{ role: 'system' }, { role: 'user', content: 'ping' }] });
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: '你好' } }] }) + data({ choices: [{ delta: { content: '世界' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }) + 'data: [DONE]\n\n');
    };
    const out = await call(input('chat_v2_event_noop_sink_test'));
    expect(out.assistant_message).toBe('你好世界');
    expect(out.cancelled).toBe(false);
    expect(calls).toBe(1);
  });
  it('delivers real adapter tool calls and measured zero-cache usage to the current owner before completion', async () => {
    const received: unknown[] = [];
    const hooks: LlmStreamHooks = { onToolCall: message => received.push(message.tool_call), onUsage: usage => received.push(usage),
      onComplete: text => received.push(['complete', text]) };
    const name = 'chat_v2_event_tools';
    host.ctx.llmStreamEvents.registerStreamHooks(name, hooks);
    handle = (_body, response) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }] })
        + data({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } } }));
    };
    try {
      const result = await call(input(name));
      expect(result.cancelled).toBe(false);
      expect(received).toEqual([{ prompt_tokens: 3, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 0 } },
        { id: 'call-1', tool_name: 'lookup', args_json: {} }, ['complete', '']]);
    } finally { expect(host.ctx.llmStreamEvents.unregisterStreamHooksIfOwner(name, hooks)).toBe(true); }
  });
  it('cancels a stalled socket, keeps replacement ownership and suppresses completion', async () => {
    const name = 'chat_v2_event_cancel';
    const received: string[] = [];
    const replacement: LlmStreamHooks = { onComplete: () => received.push('complete') };
    const owner: LlmStreamHooks = { onContentChunk: () => {
      host.ctx.llmStreamEvents.registerStreamHooks(name, replacement);
      void host.ctx.llm.requestCancelStream(name);
    } };
    host.ctx.llmStreamEvents.registerStreamHooks(name, owner);
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    handle = (_body, response) => {
      response.on('close', close); response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(data({ choices: [{ delta: { content: 'partial' } }] }));
    };
    const result = await call(input(name)); await closed;
    expect(result).toMatchObject({ assistant_message: '', cancelled: true });
    expect(received).toEqual([]);
    expect(await host.ctx.llm.consumePendingCancel(name)).toBe(false);
    expect(host.ctx.llmStreamEvents.unregisterStreamHooksIfOwner(name, owner)).toBe(false);
    expect(host.ctx.llmStreamEvents.unregisterStreamHooksIfOwner(name, replacement)).toBe(true);
  });
  it('propagates incomplete terminal errors without final hooks or a retry after content', async () => {
    let calls = 0;
    handle = (_body, response) => {
      calls++; response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(data({ choices: [{ delta: { content: 'partial' } }] }));
    };
    await expect(call(input('chat_v2_event_incomplete'))).rejects.toMatchObject({ error_type: 'LLM', message: expect.stringContaining('未收到完整结束标记') });
    expect(calls).toBe(1);
  });
});
