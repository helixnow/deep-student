import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { beforeEach, describe, expect, it } from 'vitest';
import type { JsonValue } from '../../../platform/errors/api.ts';
import { createTestHost } from './host.ts';
import plugin from '../index.ts';
import { makeConfig } from './support.ts';
import {
  applyReasoningConfig, completeJsonPayload, rejectsJsonMode, requestBody,
  resetQuestionAuthoringCompatibilityCache,
  type JsonObject,
} from '../src/question_authoring.ts';

type Body = { [key: string]: unknown };

async function startServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ base: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected TCP address');
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

interface CompletionOptions {
  status: number;
  rejectOnce: boolean;
  finish: string;
  pages: number;
}

interface CompletionOutcome {
  ok: boolean;
  hits: number;
  bodies: Body[];
  error?: unknown;
}

async function completeWithServer(options: CompletionOptions): Promise<CompletionOutcome> {
  const bodies: Body[] = [];
  let hits = 0;

  const server = await startServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body;
      bodies.push(body);
      const index = hits;
      hits += 1;
      if (options.status !== 200 && (!options.rejectOnce || index === 0)) {
        response.writeHead(options.status, { 'content-type': 'application/json' });
        response.end('{"error":{"message":"response_format json_object is not supported"}}');
        return;
      }
      const answer = JSON.stringify({ schema_version: 2, questions: [] });
      const delta = { choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] };
      const terminal = { choices: [{ index: 0, delta: {}, finish_reason: options.finish }] };
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(
        `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(terminal)}\n\ndata: [DONE]\n\n`,
      );
    });
  });

  const host = await createTestHost({ plugins: [plugin], provide: { settings: { get: () => null },
    secrets: { isEncryptedFormat: () => false } } });
  try {
    const config = makeConfig({
      id: `relay-${server.base}`,
      name: 'relay',
      model: 'relay',
      baseUrl: `${server.base}/v1`,
      apiKey: 'relay-key',
      apiProtocol: 'openai_chat_completions',
      enabled: true,
      isMultimodal: true,
      maxOutputTokens: 65_536,
    });
    const input: JsonValue[] = [{ type: 'text', text: 'full source' }];
    for (let page = 1; page <= options.pages; page += 1) {
      input.push({ type: 'text', text: `page=${page}` });
      input.push({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } });
    }
    try {
      await host.ctx.llmQuestionAuthoring.runQuestionJson(config, 'Return JSON', input, null);
      return { ok: true, hits, bodies };
    } catch (error) {
      return { ok: false, hits, bodies, error };
    }
  } finally {
    await host.dispose();
    await server.close();
  }
}

describe('question_authoring.rs', () => {
  beforeEach(() => resetQuestionAuthoringCompatibilityCache());

  it('complete_fence_is_transport_only_and_never_repairs_a_prefix', () => {
    expect(completeJsonPayload('```json\n{"questions":[]}\n```')).toBe('{"questions":[]}');
    for (const text of [
      '```json\n{"questions":[',
      'prefix {"questions":[]}',
      '{"questions":[]} trailing',
      '[]',
    ]) {
      expect(() => completeJsonPayload(text)).toThrow();
    }
  });

  it('only_explicit_parameter_incompatibility_disables_json', () => {
    for (const status of [401, 403, 413, 429, 500]) {
      expect(rejectsJsonMode({
        message: 'unsupported response_format',
        details: { status, body: 'unsupported json_object' },
      })).toBe(false);
    }
    expect(rejectsJsonMode({
      message: 'bad request',
      details: { status: 400, body: 'response_format json_object is not supported' },
    })).toBe(true);
    expect(rejectsJsonMode({
      message: 'bad request',
      details: { status: 400, body: 'context length exceeded' },
    })).toBe(false);
  });

  it('configured_output_and_full_input_are_preserved', () => {
    const config = makeConfig({
      maxOutputTokens: 65_536,
      maxTokensLimit: 131_072,
      temperature: 0.6,
    });
    const text = 'complete source'.repeat(10_000);
    const body = requestBody(config, 'JSON', text, true);
    expect(body.max_tokens).toBe(65_536);
    const message = (body.messages as JsonObject[])[1]!;
    expect(String(message.content).startsWith(text)).toBe(true);
    expect((body.response_format as JsonObject).type).toBe('json_object');
    expect(requestBody(config, 'JSON', 'x', false).response_format).toBeUndefined();
  });

  it('sampling removal follows serde_json preserve_order Map::remove (swap_remove) key order', () => {
    // question_authoring.rs:114-128 json!{model, messages, temperature, max_tokens} + response_format, then
    // mod.rs:4891 map.remove("temperature") moves the last key (response_format) into its slot
    // (generic_openai.rs:224-242: an explicit valid effort removes sampling params).
    const config = makeConfig({ model: 'reasoner', isReasoning: true, reasoningEffort: 'high' });
    expect(Object.keys(requestBody(config, 'JSON', 'x', true)))
      .toEqual(['model', 'messages', 'response_format', 'max_tokens', 'reasoning_effort']);
    expect(Object.keys(requestBody({ ...config, topPOverride: 0.9 }, 'JSON', 'x', true)))
      .toEqual(['model', 'messages', 'response_format', 'max_tokens', 'reasoning_effort']);
    expect(Object.keys(requestBody(config, 'JSON', 'x', false))).toEqual(['model', 'messages', 'max_tokens', 'reasoning_effort']);
  });

  it('whole_small_documents_use_one_main_request', async () => {
    for (const pages of [1, 19, 20]) {
      const outcome = await completeWithServer({ status: 200, rejectOnce: false, finish: 'stop', pages });
      expect(outcome.ok).toBe(true);
      expect(outcome.hits).toBe(1);
      expect(outcome.bodies[0]!.max_tokens).toBe(65_536);
      const content = (outcome.bodies[0]!.messages as JsonObject[])[1]!.content;
      expect(Array.isArray(content)).toBe(true);
      expect((content as unknown[]).length).toBe(2 + pages * 2);
    }
  });

  it('deepseek_keeps_model_settings_and_repeats_json_contract_after_all_visual_sources', () => {
    const config = makeConfig({
      model: 'tree-deepseek-v4.1-flash',
      modelAdapter: 'deepseek',
      providerType: 'custom',
      providerScope: 'custom',
      apiProtocol: 'openai_chat_completions',
      baseUrl: 'https://relay.example/v1',
      isMultimodal: true,
      isReasoning: true,
      supportsReasoning: true,
      thinkingEnabled: true,
      enableThinking: true,
      reasoningEffort: 'max',
      maxOutputTokens: 128_000,
    });
    const system = 'Return JSON matching {"schema_version":2,"mode":"extract","questions":[]}';
    const evidence: JsonValue[] = [
      { type: 'text', text: '完整原文' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
    ];
    const body = requestBody(config, system, evidence, true);
    const parts = (body.messages as JsonObject[])[1]!.content as JsonObject[];
    expect(parts.slice(0, 2)).toEqual(evidence);
    expect(String(parts[parts.length - 1]!.text)).toContain(system);

    const adapted: JsonObject = { temperature: config.temperature, max_tokens: 128_000 };
    applyReasoningConfig(adapted, config, null);
    for (const parameter of ['thinking', 'reasoning_effort', 'temperature']) {
      expect(body[parameter]).toEqual(adapted[parameter]);
    }
    expect(body.max_tokens).toBe(128_000);
    expect((body.response_format as JsonObject).type).toBe('json_object');

    const retry = requestBody(config, system, evidence, false);
    expect(body.messages).toEqual(retry.messages);
    expect(retry.response_format).toBeUndefined();
  });

  it('explicit_json_rejection_retries_once_with_identical_evidence', async () => {
    const outcome = await completeWithServer({ status: 400, rejectOnce: true, finish: 'stop', pages: 20 });
    expect(outcome.ok).toBe(true);
    expect(outcome.hits).toBe(2);
    expect(((outcome.bodies[0]!.response_format) as JsonObject).type).toBe('json_object');
    expect(outcome.bodies[1]!.response_format).toBeUndefined();
    expect(outcome.bodies[0]!.messages).toEqual(outcome.bodies[1]!.messages);
  });

  it('auth_rate_and_length_errors_never_become_json_fallback_success', async () => {
    for (const status of [401, 429, 413, 500]) {
      const outcome = await completeWithServer({ status, rejectOnce: false, finish: 'stop', pages: 1 });
      expect(outcome.ok).toBe(false);
      expect(outcome.hits).toBe(1);
    }
    const truncated = await completeWithServer({ status: 200, rejectOnce: false, finish: 'length', pages: 1 });
    expect(truncated.ok).toBe(false);
    expect(truncated.hits).toBe(1);
  });
});
