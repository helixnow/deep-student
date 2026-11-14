/**
 * `AnkiGenerationService` 的生产主流程测试。
 *
 * 只在 L02 传输边界（`llm` / `llmStreaming`）使用替身；prompt、协议、brace-depth
 * 切卡、入库、事件、统计、cancellation 与 critic 均走真实实现。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import type { AnkiGenerationOptions, FieldExtractionRule__De } from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { ApiConfig, LlmAnkiRouting, LLMManager, LlmRawPrompt, LlmStreamingService } from '../../llm/api.ts';
import { regex as nativeRegex } from '../../../platform/native/regex/index.ts';
import { decodeAnkiCardRow } from '../src/anki-cards.ts';
import { cancelStreaming, StreamingAnkiService } from '../src/streaming-anki.ts';
import { createGenerationService } from '../src/document-pipeline.ts';
import {
  AnkiGenerationService,
  cleanAnkiJsonResponse,
  parseAnkiCardsWithFallback,
} from '../src/generation-service.ts';
import { insertDocumentTask } from '../repository/document-processing.ts';
import { listCardsForTask, listTasksForDocument } from '../repository/anki-cards.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function makeRule(
  isRequired: boolean,
  fieldType: FieldExtractionRule__De['field_type'],
  description: string,
): FieldExtractionRule__De {
  return {
    field_type: fieldType,
    is_required: isRequired,
    default_value: null,
    validation_pattern: null,
    description,
  };
}

function options(overrides: Partial<AnkiGenerationOptions> = {}): AnkiGenerationOptions {
  return {
    deck_name: '默认',
    note_type: 'Basic',
    enable_images: false,
    max_cards_per_mistake: 5,
    template_fields: ['front', 'back', 'tags'],
    field_extraction_rules: {
      front: makeRule(true, 'Text', 'front'),
      back: makeRule(true, 'Text', 'back'),
      tags: makeRule(false, 'Array', 'tags'),
    },
    ...overrides,
  };
}

function config(): ApiConfig {
  return {
    id: 'cfg', name: 'cfg', vendorId: null, vendorName: null, providerType: 'openai',
    providerScope: null, authMode: null, apiProtocol: 'openai_chat',
    supportsOpenaiResponses: null, apiKey: 'key', baseUrl: 'https://example.test/v1',
    model: 'model', isMultimodal: false, isReasoning: false, isEmbedding: false,
    isReranker: false, isImageGeneration: false, enabled: true, modelAdapter: 'openai',
    maxOutputTokens: 4096, temperature: 0.3, supportsTools: false,
    geminiApiVersion: 'v1beta', isBuiltin: true, isReadOnly: false, reasoningEffort: null,
    reasoningMode: null, thinkingEnabled: false, thinkingBudget: null, includeThoughts: false,
    minP: null, topK: null, enableThinking: null, supportsReasoning: false, headers: null,
    topPOverride: null, frequencyPenaltyOverride: null, presencePenaltyOverride: null,
    repetitionPenalty: null, reasoningSplit: null, effort: null, verbosity: null,
    isFavorite: false, maxTokensLimit: null, contextWindow: null, extraBody: null,
    resolvedAdapterId: null,
  };
}

interface CallRecord {
  label: string;
  body: unknown;
  maxRetries: number;
  headerTimeoutMs: number;
}

interface StreamControl {
  calls: CallRecord[];
  decryptError: unknown;
  handler: (body: unknown, label: string, opts: { cancel?: AbortSignal }, onDelta?: ((delta: string) => boolean) | null) => Promise<{
    content: string;
    aborted: boolean;
    interrupted: string | null;
  }>;
}

const control: StreamControl = {
  calls: [],
  decryptError: null,
  handler: async () => ({ content: '', aborted: false, interrupted: null }),
};

const llm = {
  async getApiConfigs() { return [config()]; },
  async getModelAssignments() { return { anki_card_model_config_id: 'cfg' }; },
  async getModel2Config() { return config(); },
  async decryptApiKey(key: string) {
    if (control.decryptError !== null) throw control.decryptError;
    return `decrypted:${key}`;
  },
} as unknown as LLMManager;

const streaming: LlmStreamingService = {
  async singleShotCompletion(_config, body, _apiKey, _sessionId, _context, opts, onDelta) {
    control.calls.push({ label: opts.label, body, maxRetries: opts.maxRetries, headerTimeoutMs: opts.headerTimeoutMs });
    const result = await control.handler(body, opts.label, opts, onDelta);
    return {
      content: result.content,
      reasoningBytes: 0,
      finishReason: 'stop',
      usage: null,
      mode: 'stream',
      attempts: 1,
      interrupted: result.interrupted,
      aborted: result.aborted,
    };
  },
};

type RoutedRawPromptCall = Parameters<LlmRawPrompt['callAnkiRoutedRawPrompt']>;
let rawPromptCalls: RoutedRawPromptCall[] = [];
const rawPrompt = {
  async callAnkiRoutedRawPrompt(...args: RoutedRawPromptCall) {
    rawPromptCalls.push(args);
    return {
      assistant_message: JSON.stringify({ verdicts: [] }),
      raw_response: null,
      chain_of_thought_details: null,
      cancelled: false,
    };
  },
} as unknown as LlmRawPrompt;

let env: AnkiTestEnv;
let captured: Array<{ event: string; payload: unknown }> = [];

beforeAll(async () => {
  env = await createAnkiTestEnv({ provide: { llm, llmStreaming: streaming } });
}, 120_000);

afterAll(async () => {
  await env.dispose();
});

beforeEach(() => {
  env.host.events.length = 0;
  captured = [];
  control.calls = [];
  rawPromptCalls = [];
  control.decryptError = null;
  control.handler = async () => ({ content: '', aborted: false, interrupted: null });
});

function seedTask(documentId: string, taskId: string, optionOverrides: Partial<AnkiGenerationOptions> = {}): DocumentTask {
  const now = '2026-08-24T00:00:00+00:00';
  const task: DocumentTask = {
    id: taskId,
    document_id: documentId,
    original_document_name: 'generation doc',
    segment_index: 0,
    content_segment: '第一段。',
    status: 'Pending',
    created_at: now,
    updated_at: now,
    error_message: null,
    anki_generation_options_json: JSON.stringify(options(optionOverrides)),
  };
  insertDocumentTask(env.storage.database('mistakes'), task);
  return task;
}

function service(routing: LlmAnkiRouting | null = null, routedRawPrompt: LlmRawPrompt | null = rawPrompt): AnkiGenerationService {
  const stream = new StreamingAnkiService({
    db: env.storage.database('mistakes'),
    regex: nativeRegex,
    logger,
  });
  return new AnkiGenerationService(
    {
      db: env.storage.database('mistakes'),
      llm,
      streaming,
      regex: nativeRegex,
      logger,
      routing,
      rawPrompt: routedRawPrompt,
    },
    stream,
  );
}

function windowPort(): { emit(event: string, payload: unknown): void } {
  return { emit: (event, payload) => { captured.push({ event, payload }); } };
}

function eventsNamed(name: string): Array<Record<string, unknown>> {
  return captured
    .filter((event) => event.event === name)
    .map((event) => event.payload as Record<string, unknown>);
}

describe('AnkiGenerationService::process_task_and_generate_cards_stream', () => {
  it('cuts cards across chunk boundaries, saves and emits stats/completed', async () => {
    const db = env.storage.database('mistakes');
    const task = seedTask('doc-stream', 'task-stream');
    const card = JSON.stringify({ front: '流式问题', back: '流式答案', tags: ['t'] });
    control.handler = async (_body, _label, _opts, onDelta) => {
      const split = [
        card.slice(0, 11),
        card.slice(11, 24),
        card.slice(24),
      ];
      for (const chunk of split) {
        if (onDelta !== undefined && onDelta !== null && onDelta(chunk) === false) {
          return { content: chunk, aborted: true, interrupted: null };
        }
      }
      return { content: card, aborted: false, interrupted: null };
    };

    await service().processTaskAndGenerateCardsStream(task, windowPort());

    const cards = listCardsForTask(db, task.id).map(decodeAnkiCardRow);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ front: '流式问题', back: '流式答案', tags: ['t'] });
    expect(listTasksForDocument(db, task.document_id)[0]!.status).toBe('Completed');
    const payloads = eventsNamed('anki_generation_event');
    expect(payloads.some((payload) => 'NewCard' in payload)).toBe(true);
    expect(payloads).toContainEqual({
      GenerationStats: {
        task_id: task.id,
        document_id: task.document_id,
        cards_generated: 1,
        failed_cards: 0,
        duplicate_cards: 0,
        dropped_fragments: 0,
        flagged_cards: 0,
      },
    });
    expect(payloads.some((payload) => 'TaskCompleted' in payload)).toBe(true);
    expect(control.calls[0]!.label).toBe('Anki 流式制卡(model)');
  });

  it('turns an unparseable card into an error card and reports failed_cards', async () => {
    const db = env.storage.database('mistakes');
    const task = seedTask('doc-stream', 'task-error');
    const broken = '{"front": "only front"';
    control.handler = async (_body, _label, _opts, onDelta) => {
      if (onDelta !== undefined && onDelta !== null) onDelta(broken);
      return { content: broken, aborted: false, interrupted: null };
    };

    await service().processTaskAndGenerateCardsStream(task, windowPort());

    const cards = listCardsForTask(db, task.id).map(decodeAnkiCardRow);
    expect(cards).toHaveLength(1);
    expect(cards[0]!.is_error_card).toBe(true);
    const payloads = eventsNamed('anki_generation_event');
    expect(payloads.some((payload) => 'NewErrorCard' in payload)).toBe(true);
    expect(payloads).toContainEqual(expect.objectContaining({
      GenerationStats: expect.objectContaining({ failed_cards: 1 }),
    }));
  });

  it('cancellation leaves the task paused for the scheduler and emits no failure event', async () => {
    const db = env.storage.database('mistakes');
    const task = seedTask('doc-stream', 'task-cancel');
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    control.handler = async (_body, _label, opts) => {
      await gate;
      if (opts.cancel?.aborted === true) throw new Error('Anki 流式制卡 请求已取消');
      return { content: '[]', aborted: false, interrupted: null };
    };

    const pending = service().processTaskAndGenerateCardsStream(task, windowPort());
    await new Promise((resolve) => setTimeout(resolve, 10));
    await cancelStreaming(task.id);
    release();
    await pending;

    expect(listTasksForDocument(db, task.document_id)[0]!.status).not.toBe('Failed');
    const payloads = eventsNamed('anki_generation_event');
    expect(payloads.some((payload) => 'TaskProcessingError' in payload)).toBe(false);
    expect(payloads.some((payload) => 'TaskCompleted' in payload)).toBe(false);
  });

  it('runs the critic pass only when explicitly enabled', async () => {
    const db = env.storage.database('mistakes');
    const task = seedTask('doc-stream', 'task-critic', {
      enable_critic_pass: true,
      enable_qa_pass: true,
    });
    const card = JSON.stringify({ front: 'critic q', back: 'critic a', tags: [] });
    control.handler = async (_body, label, _opts, onDelta) => {
      if (label.includes('critic')) {
        return {
          content: JSON.stringify({ verdicts: [] }),
          aborted: false,
          interrupted: null,
        };
      }
      if (onDelta !== undefined && onDelta !== null) onDelta(card);
      return { content: card, aborted: false, interrupted: null };
    };

    await service().processTaskAndGenerateCardsStream(task, windowPort());

    // anki_critic.rs:968-973: llm.call_anki_routed_raw_prompt(decision, "anki_critic.run_critic_pass", &prompt.text, None).
    expect(rawPromptCalls.map(([decision, label, , images]) => [decision, label, images]))
      .toEqual([[null, 'anki_critic.run_critic_pass', null]]);
    expect(rawPromptCalls[0]![2]).toContain('critic q');
    expect(control.calls.map((call) => call.label)).toEqual(['Anki 流式制卡(model)']);
    const payloads = eventsNamed('anki_generation_event');
    expect(payloads.some((payload) => 'CriticSummary' in payload)).toBe(true);
    expect(listCardsForTask(db, task.id)).toHaveLength(1);
  });

  it('createGenerationService hands the critic the llmRawPrompt service from ctx', async () => {
    const wired = await createAnkiTestEnv({ provide: { llm, llmStreaming: streaming, llmRawPrompt: rawPrompt } });
    try {
      expect(createGenerationService(wired.host.ctx, wired.storage.database('mistakes'))?.rawPrompt).toBe(rawPrompt);
      expect(createGenerationService(env.host.ctx, env.storage.database('mistakes'))?.rawPrompt).toBeNull();
    } finally {
      await wired.dispose();
    }
  });

  it('without llmRawPrompt the critic degrades instead of picking a config and calling the provider itself', async () => {
    const task = seedTask('doc-stream', 'task-critic-no-raw', {
      enable_critic_pass: true,
      enable_qa_pass: true,
    });
    const card = JSON.stringify({ front: 'no raw q', back: 'no raw a', tags: [] });
    control.handler = async (_body, _label, _opts, onDelta) => {
      if (onDelta !== undefined && onDelta !== null) onDelta(card);
      return { content: card, aborted: false, interrupted: null };
    };

    await service(null, null).processTaskAndGenerateCardsStream(task, windowPort());

    expect(control.calls.map((call) => call.label)).toEqual(['Anki 流式制卡(model)']);
    const summary = eventsNamed('anki_generation_event').find((payload) => 'CriticSummary' in payload);
    expect(summary?.CriticSummary).toMatchObject({
      kept: 1,
      degraded: '模型调用失败: Anki critic 不可用：L02 未提供 llmRawPrompt 服务',
    });
  });

  it('consumes L02 anki routing for generator selection and critic decisions', async () => {
    const task = seedTask('doc-routing', 'task-routing', {
      enable_critic_pass: true,
      enable_qa_pass: true,
    });
    const decisions: Array<{ role: string; mode: string }> = [];
    const routing = {
      async probeAnkiRoutingSlots() {
        return {
          ankiCard: {
            configId: 'cfg', model: 'model', isMultimodal: false, isReasoning: false,
          },
          main: null,
          vision: null,
        };
      },
      async resolveAnkiRoleDecision(role, mode) {
        decisions.push({ role, mode });
        return {
          role,
          configId: 'cfg',
          model: 'model',
          slot: 'ankiCard' as const,
          degraded: false,
          isMultimodal: false,
          reason: 'test routing decision',
        };
      },
    } satisfies LlmAnkiRouting;

    const card = JSON.stringify({ front: 'routing q', back: 'routing a', tags: [] });
    control.handler = async (_body, label, _opts, onDelta) => {
      if (label.includes('critic')) {
        return { content: JSON.stringify({ verdicts: [] }), aborted: false, interrupted: null };
      }
      if (onDelta !== undefined && onDelta !== null) onDelta(card);
      return { content: card, aborted: false, interrupted: null };
    };

    const routed = service(routing);
    expect(await routed.getStreamingConfig(task.anki_generation_options_json))
      .toMatchObject({ id: 'cfg' });

    await routed.processTaskAndGenerateCardsStream(task, windowPort());

    expect(decisions).toEqual([{ role: 'critic', mode: 'auto' }]);
    expect(rawPromptCalls.map(([decision, label]) => [decision, label])).toEqual([[{
      role: 'critic', configId: 'cfg', model: 'model', slot: 'ankiCard', degraded: false,
      isMultimodal: false, reason: 'test routing decision',
    }, 'anki_critic.run_critic_pass']]);
    expect(control.calls.map((call) => call.label)).not.toContain('anki_critic.run_critic_pass');
    const summary = eventsNamed('anki_generation_event')
      .find((payload) => 'CriticSummary' in payload);
    expect(summary?.CriticSummary).toMatchObject({
      routed_config_id: 'cfg',
      routed_model: 'model',
      routed_degraded: false,
    });
  });

  it('falls back to delimiter when a structured request is rejected with HTTP 422', async () => {
    const task = seedTask('doc-stream', 'task-fallback', {
      output_protocol: 'json_schema',
    });
    const card = JSON.stringify({ front: 'fallback q', back: 'fallback a', tags: [] });
    let first = true;
    control.handler = async (_body, _label, _opts, onDelta) => {
      if (first) {
        first = false;
        throw {
          error_type: 'LLM',
          message: 'Anki 流式制卡(model) 接口返回错误 422: response_format unsupported',
          details: { status: 422 },
        };
      }
      if (onDelta !== undefined && onDelta !== null) onDelta(card);
      return { content: card, aborted: false, interrupted: null };
    };

    await service().processTaskAndGenerateCardsStream(task, windowPort());

    expect(control.calls).toHaveLength(2);
    const secondBody = control.calls[1]!.body as { response_format?: unknown };
    expect(secondBody.response_format).toBeUndefined();
  });

  function taskRow(documentId: string): { status: string; error_message: string | null } {
    return listTasksForDocument(env.storage.database('mistakes'), documentId)[0]!;
  }

  function processingErrors(taskId: string): unknown[] {
    return eventsNamed('anki_generation_event')
      .filter((payload) => 'TaskProcessingError' in payload)
      .map((payload) => payload.TaskProcessingError)
      .filter((payload) => (payload as { task_id?: unknown }).task_id === taskId)
      .map((payload) => (payload as { error_message?: unknown }).error_message);
  }

  it('V05-01: HTTP failures surface the Rust friendly text with one request and no response body', async () => {
    const cases: Array<[number, string]> = [
      [401, 'API 认证失败，请检查 API 密钥配置 (HTTP 401)'],
      [403, 'API 访问被拒绝，请检查账户权限 (HTTP 403)'],
      [429, 'API 请求过于频繁，请稍后重试 (HTTP 429)'],
      [503, 'AI 服务暂时不可用，请稍后重试 (HTTP 503)'],
      [418, 'AI API 请求失败，请检查网络连接或 API 配置 (HTTP 418)'],
    ];
    for (const [status, expected] of cases) {
      control.calls = [];
      const task = seedTask(`doc-http-${status}`, `task-http-${status}`);
      const body = '{"error":{"message":"余额不足 Invalid API key"}}';
      control.handler = async () => {
        throw {
          error_type: 'LLM',
          message: `Anki 流式制卡(model) 接口返回错误 ${status}: ${body}`,
          details: { status, body, stream: true },
        };
      };

      await service().processTaskAndGenerateCardsStream(task, windowPort());

      expect(taskRow(task.document_id)).toMatchObject({ status: 'Failed', error_message: expected });
      expect(processingErrors(task.id)).toEqual([expected]);
      expect(control.calls).toHaveLength(1);
      expect(control.calls[0]!.maxRetries).toBe(0);
    }
  });

  it('V05-01: an idle stall after delivered cards keeps the cards and ends Truncated with AI响应超时', async () => {
    const task = seedTask('doc-idle', 'task-idle');
    const card = JSON.stringify({ front: '空闲前', back: '已交付', tags: [] });
    control.handler = async (_body, _label, _opts, onDelta) => {
      onDelta?.(card);
      return { content: card, aborted: false, interrupted: 'Anki 流式制卡(model) 流式响应空闲超过 180s 无数据' };
    };

    await service().processTaskAndGenerateCardsStream(task, windowPort());

    expect(taskRow(task.document_id)).toMatchObject({ status: 'Truncated', error_message: 'AI响应超时' });
    expect(processingErrors(task.id)).toEqual(['AI响应超时']);
    expect(listCardsForTask(env.storage.database('mistakes'), task.id)).toHaveLength(1);
  });

  it('V05-01: send failures, read failures and the 600s client cap use the Rust texts and fail the task', async () => {
    const cases: Array<[string, () => ReturnType<StreamControl['handler']>, string]> = [
      ['send', async () => { throw { error_type: 'Network', message: 'Anki 流式制卡(model) 请求失败: fetch failed', details: null }; },
        'AI请求失败: fetch failed'],
      ['read', async () => ({ content: '', aborted: false, interrupted: 'Anki 流式制卡(model) 流式读取中断: socket hang up' }),
        '读取AI响应流失败: socket hang up'],
      ['cap', async () => ({ content: '', aborted: false, interrupted: 'Anki 流式制卡(model) 流式响应超过总时长上限 600s' }),
        '读取AI响应流失败: 流式响应超过总时长上限 600s'],
      ['header', async () => { throw { error_type: 'Network', message: 'Anki 流式制卡(model) 等待响应头超时（600s）', details: null }; },
        'AI请求失败: 等待响应头超过 600s'],
    ];
    for (const [name, handler, expected] of cases) {
      const task = seedTask(`doc-transport-${name}`, `task-transport-${name}`);
      control.handler = handler;

      await service().processTaskAndGenerateCardsStream(task, windowPort());

      expect(taskRow(task.document_id)).toMatchObject({ status: 'Failed', error_message: expected });
      expect(processingErrors(task.id)).toEqual([expected]);
    }
    expect(control.calls.every((call) => call.maxRetries === 0 && call.headerTimeoutMs === 600_000)).toBe(true);
  });

  it('V05-05: a decryptApiKey failure fails the task and emits TaskProcessingError instead of leaving it Streaming', async () => {
    const task = seedTask('doc-decrypt', 'task-decrypt');
    control.decryptError = { error_type: 'Configuration', message: 'API 密钥解密失败', details: null };

    await service().processTaskAndGenerateCardsStream(task, windowPort());

    expect(taskRow(task.document_id)).toMatchObject({ status: 'Failed', error_message: 'API 密钥解密失败' });
    expect(processingErrors(task.id)).toEqual(['API 密钥解密失败']);
    expect(control.calls).toHaveLength(0);
  });
});

describe('AnkiGenerationService::generate_anki_cards_from_document', () => {
  it('cleans markdown fences and maps question/images fallbacks', async () => {
    const content = '```json\n[{"question":"Q","back":"A","tags":[]}]\n```';
    control.handler = async () => ({ content, aborted: false, interrupted: null });
    const cards = await service().generateAnkiCardsFromDocument('doc', '通用', options());
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ front: 'Q', back: 'A', images: [] });
    expect(cards[0]!.id).toEqual(expect.any(String));
  });

  it('V05-03: transport failures surface the Rust model2_pipeline texts with a single request', async () => {
    const cases: Array<[unknown, string]> = [
      [{ error_type: 'LLM', message: 'Anki 制卡(model) 接口返回错误 401: {"error":"bad key"}', details: { status: 401, body: '{"error":"bad key"}', stream: true } },
        'Anki制卡API请求失败: 401 Unauthorized - {"error":"bad key"}'],
      [{ error_type: 'Network', message: 'Anki 制卡(model) 请求失败: connect ECONNREFUSED 127.0.0.1:443', details: null },
        '无法连接到 Anki 制卡 API 服务器: connect ECONNREFUSED 127.0.0.1:443'],
      [{ error_type: 'Network', message: 'Anki 制卡(model) 等待响应头超时（180s）', details: null },
        'Anki制卡API请求超时: 等待响应头超时（180s）'],
      [{ error_type: 'LLM', message: 'Anki 制卡(model) 响应不是有效 JSON: <html>', details: null },
        '解析 Anki 制卡响应失败: <html>'],
    ];
    for (const [thrown, expected] of cases) {
      control.calls = [];
      control.handler = async () => { throw thrown; };
      await expect(service().generateAnkiCardsFromDocument('doc', '通用', options()))
        .rejects.toMatchObject({ message: expected });
      expect(control.calls).toHaveLength(1);
      expect(control.calls[0]!.maxRetries).toBe(0);
    }

    control.handler = async () => ({ content: '[', aborted: false, interrupted: 'Anki 制卡(model) 流式读取中断: socket hang up' });
    await expect(service().generateAnkiCardsFromDocument('doc', '通用', options()))
      .rejects.toMatchObject({ message: '解析 Anki 制卡响应失败: socket hang up' });
  });

  it('clean/parse helpers preserve Rust error classes', () => {
    expect(() => cleanAnkiJsonResponse('no array here')).toThrow('无法找到JSON数组开始标记');
    expect(() => cleanAnkiJsonResponse('[1,2')).toThrow('无法找到JSON数组结束标记');
    expect(() => parseAnkiCardsWithFallback('{not json}', '{not json}')).toThrow(/解析ANKI卡片JSON失败/);
    expect(parseAnkiCardsWithFallback('[{"front":"f","back":"b"}]', '')[0]).toMatchObject({
      front: 'f',
      back: 'b',
      tags: [],
      images: [],
    });
  });
});
