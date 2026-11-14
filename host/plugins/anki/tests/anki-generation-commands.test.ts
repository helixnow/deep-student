/**
 * `src/commands.rs:3911-4030` 三个生成命令 + `src/cmd/enhanced_anki.rs:85-209`
 * 的 start/resume/trigger 命令契约。
 *
 * 生成主体是 L16 的 `AnkiGenerationService`；测试只在 L02 传输边界
 * （`llm` 配置读取 + `llmStreaming.singleShotCompletion`）使用替身，
 * 切卡、入库、事件、统计、调度与取消收尾都走真实生产代码。
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AnkiCard, DocumentTask,
} from '../../../../contracts/ipc/generated/_shared.ts';
import type {
  AnkiGenerationOptions, FieldExtractionRule__De,
} from '../../../../contracts/ipc/generated/L16-anki.ts';
import type { ApiConfig, LLMManager, LlmStreamingService } from '../../llm/api.ts';
import type { DocsService } from '../../media/api.ts';
import { DocumentProcessingService } from '../src/document-processing.ts';
import { buildOcclusionDraftMarker, OCCLUSION_FIELD } from '../api.ts';
import { documentRunRegistry, runningTaskHandles } from '../src/enhanced-service.ts';
import { insertDocumentTask } from '../repository/document-processing.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

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
    deck_name: '默认牌组',
    note_type: 'Basic',
    enable_images: false,
    max_cards_per_mistake: 5,
    segment_overlap_size: 200,
    template_fields: ['front', 'back', 'tags'],
    field_extraction_rules: {
      front: makeRule(true, 'Text', 'front'),
      back: makeRule(true, 'Text', 'back'),
      tags: makeRule(false, 'Array', 'tags'),
    },
    ...overrides,
  };
}

function cardJson(front = 'front', back = 'back'): string {
  return JSON.stringify({ front, back, tags: [] });
}

function apiConfig(): ApiConfig {
  return {
    id: 'cfg-anki',
    name: 'Anki 模型',
    vendorId: null,
    vendorName: null,
    providerType: 'openai',
    providerScope: null,
    authMode: null,
    apiProtocol: 'openai_chat',
    supportsOpenaiResponses: null,
    apiKey: 'encrypted-key',
    baseUrl: 'https://example.test/v1',
    model: 'test-model',
    isMultimodal: false,
    isReasoning: false,
    isEmbedding: false,
    isReranker: false,
    isImageGeneration: false,
    enabled: true,
    modelAdapter: 'openai',
    maxOutputTokens: 4096,
    temperature: 0.3,
    supportsTools: false,
    geminiApiVersion: 'v1beta',
    isBuiltin: true,
    isReadOnly: false,
    reasoningEffort: null,
    reasoningMode: null,
    thinkingEnabled: false,
    thinkingBudget: null,
    includeThoughts: false,
    minP: null,
    topK: null,
    enableThinking: null,
    supportsReasoning: false,
    headers: null,
    topPOverride: null,
    frequencyPenaltyOverride: null,
    presencePenaltyOverride: null,
    repetitionPenalty: null,
    reasoningSplit: null,
    effort: null,
    verbosity: null,
    isFavorite: false,
    maxTokensLimit: null,
    contextWindow: null,
    extraBody: null,
    resolvedAdapterId: null,
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface StreamControl {
  mode: 'chunks' | 'reject';
  chunks: string[];
  error: Error | null;
  gate: Promise<void> | null;
  sessionIds: string[];
  requests: Array<{ body: unknown; apiKey: string | null }>;
}

interface DocsControl {
  mode: 'success' | 'path-fail' | 'base64-fail';
  path: string | null;
  base64Name: string | null;
  base64Content: string | null;
}

const streamControl: StreamControl = {
  mode: 'chunks',
  chunks: ['[]'],
  error: null,
  gate: null,
  sessionIds: [],
  requests: [],
};

const docsControl: DocsControl = {
  mode: 'success',
  path: null,
  base64Name: null,
  base64Content: null,
};

const config = apiConfig();

const llmControl: { configGate: Promise<void> | null } = { configGate: null };

const llmDouble = {
  async getApiConfigs() {
    if (llmControl.configGate !== null) await llmControl.configGate;
    return [config];
  },
  async getModelAssignments() {
    return { anki_card_model_config_id: config.id };
  },
  async getModel2Config() {
    return config;
  },
  async decryptApiKey(apiKey: string) {
    return `decrypted:${apiKey}`;
  },
} as unknown as LLMManager;

const streamingDouble: LlmStreamingService = {
  async singleShotCompletion(_config, body, apiKey, sessionId, _context, _opts, onDelta) {
    streamControl.requests.push({ body, apiKey });
    if (sessionId !== null) streamControl.sessionIds.push(sessionId);
    if (streamControl.gate !== null) await streamControl.gate;
    if (streamControl.mode === 'reject') throw streamControl.error ?? new Error('模型不可用');
    const chunks = streamControl.chunks;
    let content = '';
    for (const chunk of chunks) {
      content += chunk;
      if (onDelta !== undefined && onDelta !== null && onDelta(chunk) === false) {
        return {
          content,
          reasoningBytes: 0,
          finishReason: 'stop',
          usage: null,
          mode: 'stream',
          attempts: 1,
          interrupted: null,
          aborted: true,
        };
      }
    }
    return {
      content,
      reasoningBytes: 0,
      finishReason: 'stop',
      usage: null,
      mode: 'stream',
      attempts: 1,
      interrupted: null,
      aborted: false,
    };
  },
};

const docsDouble = {
  version: 1,
  async extractTextFromPath(filePath: string) {
    docsControl.path = filePath;
    if (docsControl.mode === 'path-fail') throw new Error('损坏的文档');
    return 'file document text';
  },
  async extractTextFromBytes() {
    return 'bytes document text';
  },
  async extractTextFromBase64(fileName: string, base64Content: string) {
    docsControl.base64Name = fileName;
    docsControl.base64Content = base64Content;
    if (docsControl.mode === 'base64-fail') throw new Error('base64 解码失败');
    return 'base64 document text';
  },
  async extractEpubPagesFromBytes() {
    return [];
  },
  isPlainTextCodeExtension() {
    return false;
  },
  checkZipBombBytes() {},
  checkOfficeEncryptionBytes() {},
  checkPdfEncryptionBytes() {},
} as unknown as DocsService;

let shared: AnkiTestEnv;
let noGeneration: AnkiTestEnv;

beforeAll(async () => {
  shared = await createAnkiTestEnv({
    provide: { docs: docsDouble, llm: llmDouble, llmStreaming: streamingDouble },
  });
  noGeneration = await createAnkiTestEnv();
}, 120_000);

afterAll(async () => {
  await shared.dispose();
  await noGeneration.dispose();
});

beforeEach(() => {
  shared.host.events.length = 0;
  streamControl.mode = 'chunks';
  streamControl.chunks = ['[]'];
  streamControl.error = null;
  streamControl.gate = null;
  streamControl.sessionIds = [];
  streamControl.requests = [];
  llmControl.configGate = null;
  docsControl.mode = 'success';
  docsControl.path = null;
  docsControl.base64Name = null;
  docsControl.base64Content = null;
});

function seedTask(
  env: AnkiTestEnv,
  documentId: string,
  segmentIndex: number,
  status: DocumentTask['status'],
): DocumentTask {
  const db = env.storage.database('mistakes');
  const now = '2026-08-24T00:00:00+00:00';
  const task: DocumentTask = {
    id: `task-${documentId}-${segmentIndex}`,
    document_id: documentId,
    original_document_name: 'seed doc',
    segment_index: segmentIndex,
    content_segment: `segment ${segmentIndex}`,
    status,
    created_at: now,
    updated_at: now,
    error_message: null,
    anki_generation_options_json: JSON.stringify(options()),
  };
  insertDocumentTask(db, task);
  return task;
}

describe('src/commands.rs::generate_anki_cards_from_document*', () => {
  it('generate_from_document_maps_success_and_uses_l02_single_shot', async () => {
    streamControl.chunks = [JSON.stringify([
      { front: '问题', back: '答案', tags: ['tag'] },
    ])];
    const result = await shared.host.invoke('generate_anki_cards_from_document', {
      request: {
        document_content: '文档正文',
        original_document_name: 'doc',
        options: options({ deck_name: '备考' }),
      },
    }) as { success: boolean; cards: AnkiCard[]; error_message: string | null };
    expect(result.success).toBe(true);
    expect(result.error_message).toBeNull();
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({ front: '问题', back: '答案', tags: ['tag'] });
    expect(result.cards[0]!.id).toEqual(expect.any(String));
    expect(streamControl.requests).toHaveLength(1);
    expect(streamControl.requests[0]!.apiKey).toBe('decrypted:encrypted-key');
    const body = streamControl.requests[0]!.body as {
      messages: Array<{ content: string }>;
      max_tokens: number;
      temperature: number;
    };
    expect(body.messages[0]!.content).toContain('文档内容：\n文档正文');
    expect(body.messages[0]!.content).toContain('请根据以下学习内容');
    expect(body.max_tokens).toBe(4096);
    expect(docsControl.path).toBeNull();
  });

  it('generate_from_document_returns_failure_response_when_llm_rejects', async () => {
    streamControl.mode = 'reject';
    streamControl.error = new Error('模型不可用');
    const result = await shared.host.invoke('generate_anki_cards_from_document', {
      request: { document_content: '文档正文' },
    });
    expect(result).toEqual({ success: false, cards: [], error_message: '模型不可用' });
  });

  it('generate_from_document_fails_configuration_without_llm_services', async () => {
    await expect(
      noGeneration.host.invoke('generate_anki_cards_from_document', {
        request: { document_content: '文档正文' },
      }),
    ).rejects.toMatchObject({ error_type: 'Configuration' });
  });

  it('generate_from_file_extracts_text_then_generates', async () => {
    streamControl.chunks = [JSON.stringify([{ front: 'file q', back: 'file a' }])];
    const result = await shared.host.invoke('generate_anki_cards_from_document_file', {
      filePath: '/tmp/lesson.docx',
      options: null,
    }) as { success: boolean; cards: AnkiCard[] };
    expect(result.success).toBe(true);
    expect(result.cards[0]).toMatchObject({ front: 'file q', back: 'file a', images: [] });
    expect(docsControl.path).toBe('/tmp/lesson.docx');
  });

  it('generate_from_file_returns_parse_failure_response', async () => {
    docsControl.mode = 'path-fail';
    const result = await shared.host.invoke('generate_anki_cards_from_document_file', {
      filePath: '/tmp/broken.pdf',
    });
    expect(result).toEqual({
      success: false,
      cards: [],
      error_message: '文档解析失败: 损坏的文档',
    });
  });

  it('generate_from_base64_extracts_text_then_generates', async () => {
    streamControl.chunks = [JSON.stringify([{ front: 'b64 q', back: 'b64 a' }])];
    const result = await shared.host.invoke('generate_anki_cards_from_document_base64', {
      fileName: 'lesson.docx',
      base64Content: 'YQ==',
    }) as { success: boolean; cards: AnkiCard[] };
    expect(result.success).toBe(true);
    expect(result.cards[0]).toMatchObject({ front: 'b64 q', back: 'b64 a' });
    expect(docsControl.base64Name).toBe('lesson.docx');
    expect(docsControl.base64Content).toBe('YQ==');
  });

  it('generate_from_base64_returns_parse_failure_response', async () => {
    docsControl.mode = 'base64-fail';
    const result = await shared.host.invoke('generate_anki_cards_from_document_base64', {
      fileName: 'lesson.docx',
      base64Content: 'not-base64',
    });
    expect(result).toEqual({
      success: false,
      cards: [],
      error_message: '文档解析失败: base64 解码失败',
    });
  });
});

describe('src/cmd/enhanced_anki.rs::start/resume/trigger', () => {
  it('start_validates_document_content_and_name_and_card_limit', async () => {
    await expect(
      shared.host.invoke('start_enhanced_document_processing', {
        documentContent: '   ',
        originalDocumentName: 'doc',
        options: options(),
      }),
    ).rejects.toMatchObject({ error_type: 'Validation', message: '文档内容不能为空' });

    await expect(
      shared.host.invoke('start_enhanced_document_processing', {
        documentContent: 'x'.repeat(10_000_001),
        originalDocumentName: 'doc',
        options: options(),
      }),
    ).rejects.toMatchObject({ error_type: 'Validation', message: '文档内容过大，最大支持 10MB' });

    await expect(
      shared.host.invoke('start_enhanced_document_processing', {
        documentContent: '正文',
        originalDocumentName: '../escape',
        options: options(),
      }),
    ).rejects.toMatchObject({ error_type: 'Validation', message: '文档名称包含非法字符' });

    await expect(
      shared.host.invoke('start_enhanced_document_processing', {
        documentContent: '正文',
        originalDocumentName: 'x'.repeat(256),
        options: options(),
      }),
    ).rejects.toMatchObject({ error_type: 'Validation', message: '文档名称过长，最大支持 255 个字符' });

    await expect(
      shared.host.invoke('start_enhanced_document_processing', {
        documentContent: '正文',
        originalDocumentName: 'doc',
        options: options({ max_cards_per_mistake: 101 }),
      }),
    ).rejects.toMatchObject({
      error_type: 'Validation',
      message: '单次生成卡片数量过多，最大支持 100 张',
    });
  });

  it('start_creates_tasks_emits_started_and_runs_each_task_to_completion', async () => {
    streamControl.chunks = [cardJson('start q', 'start a')];
    const documentId = await shared.host.invoke('start_enhanced_document_processing', {
      documentContent: '第一段内容。\n\n第二段内容。',
      originalDocumentName: ' 备考文档 ',
      options: options({ fsrs_feedback: false }),
    }) as string;
    expect(typeof documentId).toBe('string');

    await waitFor(
      () => shared.host.eventsNamed('anki_generation_event').some(
        (payload) => typeof payload === 'object' && payload !== null && 'DocumentProcessingCompleted' in payload,
      ),
      'DocumentProcessingCompleted',
    );

    const processor = new DocumentProcessingService(shared.storage.database('mistakes'));
    const tasks = processor.getDocumentTasks(documentId);
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    expect(tasks.every((task) => task.original_document_name === '备考文档')).toBe(true);
    expect([...streamControl.sessionIds].sort()).toEqual(tasks.map((task) => task.id).sort());
    expect(tasks.every((task) => task.status === 'Completed')).toBe(true);

    const payloads = shared.host.eventsNamed('anki_generation_event') as Array<Record<string, unknown>>;
    expect(payloads).toContainEqual({
      DocumentProcessingStarted: {
        document_id: documentId,
        total_segments: tasks.length,
      },
    });
    expect(payloads.some((payload) => 'DocumentProcessingCompleted' in payload)).toBe(true);
    expect(payloads.some((payload) => 'NewCard' in payload)).toBe(true);
    expect(payloads.some((payload) => 'TaskCompleted' in payload)).toBe(true);
    expect(await shared.host.invoke('get_document_processing_state', { documentId })).toEqual({
      paused: false,
      current_task_id: null,
    });
  });

  it('start_injects_fsrs_profile_only_with_explicit_opt_in', async () => {
    await shared.host.invoke('start_enhanced_document_processing', {
      documentContent: 'FSRS 授权正文',
      originalDocumentName: 'fsrs doc',
      options: options({
        fsrs_feedback: true,
        user_review_profile: 'PROFILE-X',
        custom_requirements: 'BASE-REQ',
      }),
    });
    await waitFor(
      () => shared.host.eventsNamed('anki_generation_event').some(
        (payload) => typeof payload === 'object' && payload !== null && 'DocumentProcessingCompleted' in payload,
      ),
      'fsrs authorized completion',
    );
    const db = shared.storage.database('mistakes');
    const rows = db.all<{ anki_generation_options_json: string }>(
      'SELECT anki_generation_options_json FROM document_tasks WHERE original_document_name = ?1',
      ['fsrs doc'],
    );
    expect(rows.length).toBeGreaterThan(0);
    const parsed = JSON.parse(rows[0]!.anki_generation_options_json) as AnkiGenerationOptions;
    expect(parsed.user_review_profile).toBe('PROFILE-X');
    expect(parsed.custom_requirements).toBe('BASE-REQ\n\nPROFILE-X');

    shared.host.events.length = 0;
    await shared.host.invoke('start_enhanced_document_processing', {
      documentContent: 'FSRS 未授权正文',
      originalDocumentName: 'fsrs denied',
      options: options({
        fsrs_feedback: false,
        user_review_profile: 'PROFILE-Y',
        custom_requirements: 'BASE-REQ',
      }),
    });
    await waitFor(
      () => shared.host.eventsNamed('anki_generation_event').some(
        (payload) => typeof payload === 'object' && payload !== null && 'DocumentProcessingCompleted' in payload,
      ),
      'fsrs denied completion',
    );
    const deniedRows = db.all<{ anki_generation_options_json: string }>(
      'SELECT anki_generation_options_json FROM document_tasks WHERE original_document_name = ?1',
      ['fsrs denied'],
    );
    const denied = JSON.parse(deniedRows[0]!.anki_generation_options_json) as AnkiGenerationOptions;
    expect(denied.user_review_profile).toBe('PROFILE-Y');
    expect(denied.custom_requirements).toBe('BASE-REQ');
  });

  it('start_fails_configuration_without_generation_service_and_writes_no_tasks', async () => {
    const db = noGeneration.storage.database('mistakes');
    const before = db.pluck<number>('SELECT COUNT(*) FROM document_tasks') ?? 0;
    await expect(
      noGeneration.host.invoke('start_enhanced_document_processing', {
        documentContent: '正文',
        originalDocumentName: 'doc',
        options: options(),
      }),
    ).rejects.toMatchObject({ error_type: 'Configuration' });
    expect(db.pluck<number>('SELECT COUNT(*) FROM document_tasks')).toBe(before);
  });

  it('resume_schedules_paused_and_pending_tasks_sorted_by_segment', async () => {
    const documentId = 'doc-resume-sorted';
    const completed = seedTask(shared, documentId, 0, 'Completed');
    const paused = seedTask(shared, documentId, 2, 'Paused');
    const pending = seedTask(shared, documentId, 1, 'Pending');

    await shared.host.invoke('resume_document_processing', { documentId });
    await waitFor(() => streamControl.sessionIds.length === 2, 'two resumed tasks');
    expect(streamControl.sessionIds).toEqual([pending.id, paused.id]);
    expect(streamControl.sessionIds).not.toContain(completed.id);

    await waitFor(
      () => shared.host.eventsNamed('anki_generation_event').some(
        (payload) => typeof payload === 'object' && payload !== null && 'DocumentProcessingCompleted' in payload,
      ),
      'resume completion event',
    );
  });

  it('resume_without_remaining_tasks_emits_completed_immediately', async () => {
    const documentId = 'doc-resume-done';
    seedTask(shared, documentId, 0, 'Completed');

    await expect(
      shared.host.invoke('resume_document_processing', { documentId }),
    ).resolves.toBe(true);
    const payloads = shared.host.eventsNamed('anki_generation_event') as Array<Record<string, unknown>>;
    expect(payloads).toContainEqual({
      DocumentProcessingCompleted: { document_id: documentId },
    });
  });

  it('resume_fails_configuration_without_generation_service', async () => {
    const documentId = 'doc-resume-blocked';
    seedTask(noGeneration, documentId, 0, 'Pending');
    await expect(
      noGeneration.host.invoke('resume_document_processing', { documentId }),
    ).rejects.toMatchObject({ error_type: 'Configuration' });
  });

  it('trigger_rejects_non_retryable_status_and_unknown_task', async () => {
    const db = shared.storage.database('mistakes');
    const processor = new DocumentProcessingService(db);
    const [documentId, tasks] = await processor.processDocumentAndCreateTasks(
      'trigger doc',
      'trigger doc',
      options(),
    );
    processor.updateTaskStatus(tasks[0]!.id, 'Completed', null);
    await expect(
      shared.host.invoke('trigger_task_processing', { taskId: tasks[0]!.id }),
    ).rejects.toMatchObject({ error_type: 'Validation', message: '任务状态不是待处理' });
    expect(documentId).toEqual(expect.any(String));

    await expect(
      shared.host.invoke('trigger_task_processing', { taskId: 'task-does-not-exist' }),
    ).rejects.toMatchObject({ error_type: 'Database' });
  });

  it('trigger_runs_retryable_task_and_blocks_duplicate_trigger', async () => {
    let release: () => void = () => {};
    streamControl.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = shared.storage.database('mistakes');
    const processor = new DocumentProcessingService(db);
    const [, tasks] = await processor.processDocumentAndCreateTasks(
      'trigger run doc',
      'trigger run doc',
      options(),
    );
    const task = tasks[0]!;
    processor.updateTaskStatus(task.id, 'Failed', 'previous failure');

    await expect(
      shared.host.invoke('trigger_task_processing', { taskId: task.id }),
    ).resolves.toBeNull();
    // Rust 先判状态：首触发已把任务写成 Processing，重复触发命中“状态不是待处理”。
    await expect(
      shared.host.invoke('trigger_task_processing', { taskId: task.id }),
    ).rejects.toMatchObject({
      error_type: 'Validation',
      message: '任务状态不是待处理',
    });
    await waitFor(() => streamControl.sessionIds.length === 1, 'triggered task start');

    release();
    await waitFor(() => !runningTaskHandles.has(task.id), 'triggered task cleanup');
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('X6-LP-0062 structured rejection logs Rust ANKI_PROTOCOL before one delimiter retry', async () => {
    const processor = new DocumentProcessingService(shared.storage.database('mistakes'));
    const [, tasks] = await processor.processDocumentAndCreateTasks(
      'protocol retry source', 'protocol retry', options({ output_protocol: 'json_object' }),
    );
    const task = tasks[0]!;
    streamControl.chunks = [cardJson('protocol q', 'protocol a')];
    // Only the external L02 transport rejects once. Prompt/protocol retry, DB,
    // logger, parser, events and lifecycle remain the real L16 production path.
    const send = vi.spyOn(streamingDouble, 'singleShotCompletion')
      .mockRejectedValueOnce(new Error('response_format rejected (HTTP 400)'));
    const warn = vi.spyOn(shared.host.ctx.logger, 'warn');
    try {
      await expect(shared.host.invoke('trigger_task_processing', { taskId: task.id })).resolves.toBeNull();
      await waitFor(() => processor.getTask(task.id).status === 'Completed', 'protocol retry completion');
      await waitFor(() => !runningTaskHandles.has(task.id), 'protocol retry cleanup');
      expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[0]?.[1]).toHaveProperty('response_format', { type: 'json_object' });
      expect(send.mock.calls[1]?.[1]).not.toHaveProperty('response_format');
      expect(warn.mock.calls.filter(([message]) => message.includes('结构化输出请求被拒绝')))
        .toEqual([['[ANKI_PROTOCOL] 结构化输出请求被拒绝（response_format rejected (HTTP 400)），回退 delimiter 协议重试一次']]);
      const cards = await shared.host.invoke<AnkiCard[]>('get_task_cards', { taskId: task.id });
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ front: 'protocol q', back: 'protocol a', is_error_card: false });
      expect(shared.host.eventsNamed('anki_generation_event').some(
        (payload) => typeof payload === 'object' && payload !== null && 'TaskCompleted' in payload,
      )).toBe(true);
    } finally {
      send.mockRestore();
      warn.mockRestore();
    }
  });

  it.each([
    {
      phase: 'stream', raw: '{"🤖":[]}', failed: 0, dropped: 1,
      warning: '[ANKI_CARD_DEBUG] 丢弃不可读残片（8 字符）: UNREADABLE_CARD_FRAGMENT: 残片不含任何可读文本字段，已丢弃',
    },
    {
      phase: 'residual', raw: '{"cards":[{"🤖":[]}', failed: 0, dropped: 1,
      warning: '[ANKI_CARD_DEBUG] 丢弃流收尾的不可读残片（8 字符）',
    },
    {
      phase: 'truncated', raw: '{"cards":[{"front":"末尾😀', failed: 1, dropped: 0,
      warning: '[ANKI_CARD_DEBUG] 流收尾 wrapper 的最后一张卡在字符串中途截断，降级为错误卡（15 字符）',
    },
  ])('X6-LP-0062 $phase keeps Rust warning text, Unicode count and fragment/error-card statistics', async (fixture) => {
    const processor = new DocumentProcessingService(shared.storage.database('mistakes'));
    const [, tasks] = await processor.processDocumentAndCreateTasks(
      `fragment source ${fixture.phase}`, `fragment ${fixture.phase}`,
      options({ output_protocol: 'delimiter', field_extraction_rules: {} }),
    );
    const task = tasks[0]!;
    // Delimiter mode deliberately leaves an unclosed outer wrapper in the buffer;
    // the real residual expander (not a substituted parser) repairs it after EOF.
    streamControl.chunks = [fixture.raw];
    const warnings: string[] = [];
    const stopLogs = shared.host.ctx.logger.exporter({
      levels: { default: 4 },
      export: (message) => { if (message.type === 'warn') warnings.push(String(message.args[0])); },
    });
    try {
      await expect(shared.host.invoke('trigger_task_processing', { taskId: task.id })).resolves.toBeNull();
      await waitFor(() => processor.getTask(task.id).status === 'Completed', 'fragment completion');
      await waitFor(() => !runningTaskHandles.has(task.id), 'fragment cleanup');
      expect(processor.getTask(task.id)).toMatchObject({ status: 'Completed', error_message: null });
      expect(streamControl.requests).toHaveLength(1);
      expect(streamControl.requests[0]?.body).not.toHaveProperty('response_format');
      expect(streamControl.chunks).toEqual([fixture.raw]);
      expect(shared.host.eventsNamed('anki_generation_event')).toContainEqual({
        GenerationStats: {
          task_id: task.id, document_id: task.document_id, cards_generated: 0,
          failed_cards: fixture.failed, duplicate_cards: 0, dropped_fragments: fixture.dropped, flagged_cards: 0,
        },
      });
      expect(warnings).toEqual([fixture.warning]);
      const cards = await shared.host.invoke<AnkiCard[]>('get_task_cards', { taskId: task.id });
      expect(cards).toHaveLength(fixture.failed);
      if (fixture.phase === 'truncated') {
        expect(cards[0]).toMatchObject({
          is_error_card: true,
          error_content: '卡片在流结束时于字符串中途被截断，内容不完整: {"front":"末尾😀"}',
        });
      } else {
        expect(shared.host.eventsNamed('anki_generation_event')).toContainEqual({
          GenerationWarning: {
            task_id: task.id, document_id: task.document_id,
            reason: 'unreadable_fragment_dropped', fragment_preview: '{"🤖":[]}',
          },
        });
      }
    } finally { await stopLogs(); }
  });

  it.each([
    { phase: 'field-error', refuseInsert: false },
    { phase: 'field-error', refuseInsert: true },
    { phase: 'truncated', refuseInsert: true },
  ])('X6-LP-0063 residual $phase with insert refusal=$refuseInsert preserves raw payload and best-effort errors', async (fixture) => {
    const db = shared.storage.database('mistakes');
    const processor = new DocumentProcessingService(db);
    const [, tasks] = await processor.processDocumentAndCreateTasks(
      `residual error ${fixture.phase} ${fixture.refuseInsert}`, 'residual error',
      options({ output_protocol: 'delimiter' }),
    );
    const task = tasks[0]!;
    streamControl.chunks = [fixture.phase === 'truncated'
      ? '{"cards":[{"front":"末尾😀' : '{"cards":[{"front":"tail question"}'];
    if (fixture.refuseInsert) {
      db.run(`CREATE TRIGGER refuse_residual_error BEFORE INSERT ON anki_cards
        WHEN NEW.is_error_card = 1 BEGIN SELECT RAISE(ABORT, 'residual error card refused'); END`);
    }
    const records: Array<{ type: string; message: string }> = [];
    const stopLogs = shared.host.ctx.logger.exporter({
      levels: { default: 4 },
      export: (message) => { records.push({ type: message.type, message: String(message.args[0]) }); },
    });
    const run = vi.spyOn(db, 'run');
    try {
      await shared.host.invoke('trigger_task_processing', { taskId: task.id });
      await waitFor(() => processor.getTask(task.id).status === 'Completed', 'residual error completion');
      await waitFor(() => !runningTaskHandles.has(task.id), 'residual error cleanup');
      const inserts = run.mock.calls.map(([sql], index) => ({ sql, index }))
        .filter(({ sql }) => typeof sql === 'string' && sql.startsWith('INSERT OR IGNORE INTO anki_cards'));
      expect(inserts).toHaveLength(1);
      expect(run.mock.results[inserts[0]!.index]?.type).toBe(fixture.refuseInsert ? 'throw' : 'return');
      if (fixture.refuseInsert) {
        expect(run.mock.results[inserts[0]!.index]?.value).toMatchObject({ message: 'residual error card refused' });
      }
      const cards = await shared.host.invoke<AnkiCard[]>('get_task_cards', { taskId: task.id });
      expect(cards).toHaveLength(fixture.refuseInsert ? 0 : 1);
      if (!fixture.refuseInsert) {
        expect(cards[0]).toMatchObject({ is_error_card: true, error_content: '{"front":"tail question"}' });
      }
      expect(records.filter((record) => record.type === 'error')).toEqual([]);
      expect(records.filter((record) => record.message.includes('解析卡片失败')
        || record.message.includes('流收尾残留缓冲解析失败'))).toEqual(fixture.phase === 'truncated' ? [] : [{
        type: 'debug', message: '[ANKI_CARD_DEBUG] 流收尾残留缓冲解析失败: 缺少必需字段: back',
      }]);
      expect(shared.host.eventsNamed('anki_generation_event')).toContainEqual({
        GenerationStats: {
          task_id: task.id, document_id: task.document_id, cards_generated: 0,
          failed_cards: 1, duplicate_cards: 0, dropped_fragments: 0, flagged_cards: 0,
        },
      });
    } finally {
      run.mockRestore();
      await stopLogs();
      if (fixture.refuseInsert) db.run('DROP TRIGGER refuse_residual_error');
    }
  });

  it.each(['stream', 'residual'] as const)('%s consumes the pending occlusion draft only after the first saved card', async (phase) => {
    const imageRef = 'vfs://images/residual-heart.png';
    const marker = buildOcclusionDraftMarker(imageRef, '[IMAGE_DESC: 主动脉；肺动脉]');
    expect(marker).not.toBeNull();
    const processor = new DocumentProcessingService(shared.storage.database('mistakes'));
    const [, tasks] = await processor.processDocumentAndCreateTasks(
      `图示原文\n${marker!}`, `draft once ${phase}`, options({ output_protocol: 'delimiter' }),
    );
    const task = tasks[0]!;
    const firstJson = cardJson('first image question', 'first image answer');
    const secondJson = cardJson('second plain question', 'second plain answer');
    streamControl.chunks = phase === 'stream' ? [firstJson, secondJson]
      : [`{"cards":[${firstJson},${secondJson}`];
    await shared.host.invoke('trigger_task_processing', { taskId: task.id });
    await waitFor(() => processor.getTask(task.id).status === 'Completed', 'draft once completion');
    await waitFor(() => !runningTaskHandles.has(task.id), 'draft once cleanup');
    expect(streamControl.requests).toHaveLength(1);
    expect(streamControl.requests[0]?.body).not.toHaveProperty('response_format');
    const cards = await shared.host.invoke<AnkiCard[]>('get_task_cards', { taskId: task.id });
    expect(cards).toHaveLength(2);
    const first = cards.find((card) => card.front === 'first image question')!;
    const second = cards.find((card) => card.front === 'second plain question')!;
    expect(first.back).toBe('first image answer');
    expect(JSON.parse(first.extra_fields[OCCLUSION_FIELD]!)).toHaveProperty('imageRef', imageRef);
    expect(first.images).toEqual([imageRef]);
    expect(first.tags).toContain('image-occlusion');
    expect(first.text).toContain('{{c1::');
    expect(second.back).toBe('second plain answer');
    expect(second.extra_fields).not.toHaveProperty(OCCLUSION_FIELD);
    expect(second.images).toEqual([]);
    expect(second.tags).not.toContain('image-occlusion');
    expect(second.text).toBeNull();
  });

  it('delete_document_session_cancels_running_streams_then_clears_state', async () => {
    let release: () => void = () => {};
    streamControl.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const documentId = await shared.host.invoke('start_enhanced_document_processing', {
      documentContent: '待删除文档正文',
      originalDocumentName: 'delete doc',
      options: options(),
    }) as string;
    await waitFor(() => streamControl.sessionIds.length > 0, 'document stream start');
    const db = shared.storage.database('mistakes');
    expect(documentRunRegistry.get(documentId)).toBeDefined();

    await expect(
      shared.host.invoke('delete_document_session', { documentId }),
    ).resolves.toBe(true);
    expect(documentRunRegistry.get(documentId)).toBeUndefined();
    expect(db.pluck<number>(
      'SELECT COUNT(*) FROM document_tasks WHERE document_id = ?1',
      [documentId],
    )).toBe(0);
    expect(db.pluck<number>(
      `SELECT COUNT(*) FROM anki_cards
       WHERE task_id IN (SELECT id FROM document_tasks WHERE document_id = ?1)`,
      [documentId],
    )).toBe(0);

    release();
    await waitFor(() => !streamControl.sessionIds.some((id) => runningTaskHandles.has(id)), 'stream cleanup');
    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it('delete_during_config_fetch_aborts_the_real_run_handle_before_the_cancel_channel_exists', async () => {
    let release: () => void = () => {};
    llmControl.configGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const documentId = await shared.host.invoke('start_enhanced_document_processing', {
      documentContent: '配置读取期间删除的正文',
      originalDocumentName: 'abort during config',
      options: options(),
    }) as string;
    const db = shared.storage.database('mistakes');
    await waitFor(
      () => (db.pluck<number>(
        `SELECT COUNT(*) FROM document_tasks
         WHERE document_id = ?1 AND status = 'Processing'`,
        [documentId],
      ) ?? 0) > 0,
      'task processing before config resolves',
    );
    const taskIds = db.all<{ id: string }>(
      'SELECT id FROM document_tasks WHERE document_id = ?1',
      [documentId],
    ).map((row) => row.id);

    // 取消通道尚未注册（生成服务还停在配置 await），cancel_streaming 必须失败，
    // 删除路径改走 RUNNING_HANDLES.abort()；仅删 ID 不足以终止真实任务。
    await expect(
      shared.host.invoke('delete_document_session', { documentId }),
    ).resolves.toBe(true);
    release();
    await waitFor(
      () => taskIds.every((taskId) => !runningTaskHandles.has(taskId)),
      'aborted run handles released',
    );
    expect(streamControl.sessionIds).toEqual([]);
    expect(db.pluck<number>(
      'SELECT COUNT(*) FROM document_tasks WHERE document_id = ?1',
      [documentId],
    )).toBe(0);
  });

  it('delete_during_config_fetch_does_not_write_failed_state_when_config_rejects', async () => {
    let rejectConfig: (error: Error) => void = () => {};
    llmControl.configGate = new Promise<void>((_resolve, reject) => {
      rejectConfig = reject;
    });
    const documentId = await shared.host.invoke('start_enhanced_document_processing', {
      documentContent: '配置拒绝时删除的正文',
      originalDocumentName: 'config reject after delete',
      options: options(),
    }) as string;
    const db = shared.storage.database('mistakes');
    await waitFor(
      () => (db.pluck<number>(
        `SELECT COUNT(*) FROM document_tasks
         WHERE document_id = ?1 AND status = 'Processing'`,
        [documentId],
      ) ?? 0) > 0,
      'task processing before config rejects',
    );

    await expect(
      shared.host.invoke('delete_document_session', { documentId }),
    ).resolves.toBe(true);
    // Rust `JoinHandle::abort`：配置 future 的 reject 不再恢复执行，不能补写
    // Failed/Truncated 或发 TaskProcessingError。
    rejectConfig(new Error('配置读取失败'));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(
      shared.host.eventsNamed('anki_generation_event').some(
        (payload) => typeof payload === 'object'
          && payload !== null
          && 'TaskProcessingError' in payload,
      ),
    ).toBe(false);
    expect(streamControl.sessionIds).toEqual([]);
    expect(db.pluck<number>(
      'SELECT COUNT(*) FROM document_tasks WHERE document_id = ?1',
      [documentId],
    )).toBe(0);
    await waitFor(() => runningTaskHandles.size === 0, 'aborted run handles released');
  });

  it('trigger_fails_configuration_without_generation_service', async () => {
    const db = noGeneration.storage.database('mistakes');
    const processor = new DocumentProcessingService(db);
    const [, tasks] = await processor.processDocumentAndCreateTasks(
      'trigger blocked',
      'trigger blocked',
      options(),
    );
    await expect(
      noGeneration.host.invoke('trigger_task_processing', { taskId: tasks[0]!.id }),
    ).rejects.toMatchObject({ error_type: 'Configuration' });
  });
});
