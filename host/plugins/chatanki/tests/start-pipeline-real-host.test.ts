// chatanki_executor.rs:6760–6815 + :6901–7213 + :7462–8892: chatanki_start through the real chat
// block store, the real L16 document pipeline (`anki.pipeline` startDocumentProcessingWithId /
// cancelStreaming / cancelDocumentProcessing, task scheduler, card stream parser, repositories) and the
// live pipeline registry. Only the L02 boundary (`llm` + `llmStreaming.singleShotCompletion`) is a double.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import type { ApiConfig, LLMManager, LlmStreamingService } from '../../llm/api.ts';
import review from '../../review/index.ts';
import chatanki from '../index.ts';
import type { AnkiCard, DocumentTask, ToolExecutionContext, ToolResultInfo } from '../api.ts';
import type { ChatAnkiPipelineRegistry } from '../src/pipeline-registry.ts';

const SESSION = 'sess_start_pipeline';
const MESSAGE = 'msg_start_pipeline';
const TOOL_BLOCK = 'blk_tool_start';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;

interface AnkiSurface {
  pipeline: Record<string, unknown>;
  documents: { getTasksForDocument(id: string): DocumentTask[] };
  cards: { getCardsForDocument(id: string): AnkiCard[] };
  templates: { importBuiltinTemplatesIfEmpty(): void };
}

interface ChatAnkiSurface {
  pipelines: ChatAnkiPipelineRegistry;
  canHandle(name: string): boolean;
  execute(call: { id: string; name: string; arguments: unknown }, context: ToolExecutionContext): Promise<ToolResultInfo>;
  backgroundSettled(): Promise<void>;
}

const ankiSurface = (): AnkiSurface => host.ctx.get('anki') as unknown as AnkiSurface;
const tools = (): ChatAnkiSurface => host.ctx.get('chatankiTools') as unknown as ChatAnkiSurface;

function apiConfig(): ApiConfig {
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

type OnDelta = ((delta: string) => boolean) | null | undefined;
type StreamHandler = (cancel: AbortSignal | undefined, onDelta: OnDelta) => Promise<{ content: string; aborted: boolean }>;

let streamHandler: StreamHandler = async () => ({ content: '', aborted: false });
const streamLabels: string[] = [];
let streamPrompts: string[] = [];

const llm = {
  async getApiConfigs() { return [apiConfig()]; },
  async getModelAssignments() { return { anki_card_model_config_id: 'cfg' }; },
  async getModel2Config() { return apiConfig(); },
  async decryptApiKey(key: string) { return key; },
} as unknown as LLMManager;

const llmStreaming: LlmStreamingService = {
  async singleShotCompletion(_config, body, _apiKey, _sessionId, _context, opts, onDelta) {
    streamLabels.push(opts.label);
    streamPrompts.push(JSON.stringify(body));
    const result = await streamHandler(opts.cancel, onDelta);
    return {
      content: result.content, reasoningBytes: 0, finishReason: 'stop', usage: null, mode: 'stream',
      attempts: 1, interrupted: null, aborted: result.aborted,
    };
  },
};

function cardJson(index: number): string {
  return JSON.stringify({ Question: `问题${index}`, Answer: `答案${index}`, Source: '', tags: [] });
}

/** Streams `count` cards, then keeps the stream open until the scheduler aborts it. */
function streamThenHold(count: number, onEntered: () => void = () => undefined): { aborted: Promise<void> } {
  let markAborted: () => void = () => undefined;
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  streamHandler = async (cancel, onDelta) => {
    onEntered();
    let content = '';
    for (let index = 1; index <= count; index += 1) {
      content += cardJson(index);
      onDelta?.(cardJson(index));
    }
    await new Promise<void>((resolve) => {
      if (cancel?.aborted === true) resolve();
      cancel?.addEventListener('abort', () => resolve(), { once: true });
    });
    markAborted();
    return { content, aborted: true };
  };
  return { aborted };
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-start-pipeline-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      vfs: {}, llm, llmStreaming,
      agentApproval: { clearSessionRemembered() {}, rejectAllPending: () => 0 },
    },
  });
  ankiSurface().templates.importBuiltinTemplatesIfEmpty();
  const db = storage.database('chat_v2');
  db.run(`INSERT INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', 'active', '2026-11-07T00:00:00+00:00', '2026-11-07T00:00:00+00:00')`, [SESSION]);
  db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
    VALUES (?1, ?2, 'assistant', ?3, 1)`, [MESSAGE, SESSION, JSON.stringify([TOOL_BLOCK])]);
  db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, tool_name)
    VALUES (?1, ?2, 'tool_call', 'running', 3, 'chatanki_start')`, [TOOL_BLOCK, MESSAGE]);
}, 60_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

type Event = [string, ...unknown[]];
type ChunkHook = (update: Record<string, unknown>) => void;

let onChunk: ChunkHook = () => undefined;
let warns: string[] = [];

beforeEach(() => {
  streamHandler = async () => ({ content: '', aborted: false });
  streamLabels.length = 0;
  streamPrompts = [];
  onChunk = () => undefined;
  warns = [];
});

function context(events: Event[]): ToolExecutionContext {
  return {
    sessionId: SESSION, messageId: MESSAGE, blockId: TOOL_BLOCK,
    emitToolCallStart: () => undefined,
    emitToolCallEnd: (payload) => { events.push(['tool_end', payload]); },
    emitToolCallError: (error) => { events.push(['tool_error', error]); },
    saveToolBlock: () => undefined,
    warn: (message) => { warns.push(message); },
    info: () => undefined,
    emitChunk: (id, update) => {
      events.push(['chunk', id, update]);
      onChunk(update as Record<string, unknown>);
    },
    emitBlockError: (id, error) => { events.push(['error', id, error]); },
    emitBlockStart: (id, payload) => { events.push(['start', id, payload]); },
    emitBlockEnd: (id, result) => { events.push(['end', id, result]); },
    emitEvent: (event, payload) => { events.push(['event', event, payload]); },
    ankiConnect: { checkAnkiConnectAvailability: async () => false },
  };
}

async function start(args: Record<string, unknown>, events: Event[] = []): Promise<ToolResultInfo> {
  return tools().execute(
    { id: 'call_start', name: 'builtin-chatanki_start', arguments: { templateMode: 'single', ...args } }, context(events),
  );
}

interface BlockRow {
  status: string; block_index: number; content: string | null; tool_output_json: string | null; error: string | null;
}

function blockRow(blockId: string): BlockRow | undefined {
  return storage.database('chat_v2').get<BlockRow>(
    'SELECT status, block_index, content, tool_output_json, error FROM chat_v2_blocks WHERE id = ?1', [blockId],
  );
}

function output(row: BlockRow | undefined): Record<string, unknown> {
  return JSON.parse(row?.tool_output_json ?? 'null') as Record<string, unknown>;
}

function messageBlockIds(): string[] {
  return JSON.parse(storage.database('chat_v2').pluck<string>(
    'SELECT block_ids_json FROM chat_v2_messages WHERE id = ?1', [MESSAGE],
  ) ?? '[]') as string[];
}

function progressOf(update: Record<string, unknown>): Record<string, unknown> | null {
  return (update.progress ?? null) as Record<string, unknown> | null;
}

function streamingCount(update: Record<string, unknown>): number | null {
  const counts = progressOf(update)?.counts as Record<string, number> | undefined;
  return counts?.streaming ?? null;
}

const kindOf = (event: Event): string =>
  (event[0] === 'chunk' ? `chunk:${Object.keys(event[2] as object).join(',')}` : event[0]);

it('chatanki_start is claimed exactly while anki.pipeline publishes the generation surface', () => {
  const pipeline = ankiSurface().pipeline;
  expect(tools().canHandle('chatanki_start')).toBe(true);
  expect(tools().canHandle('chatanki_run')).toBe(false);
  const published = pipeline.startDocumentProcessingWithId;
  delete pipeline.startDocumentProcessingWithId;
  try {
    expect(tools().canHandle('chatanki_start')).toBe(false);
  } finally {
    pipeline.startDocumentProcessingWithId = published;
  }
  expect(tools().canHandle('chatanki_start')).toBe(true);
});

it('front-half failures return failure results and persist no block', async () => {
  const before = storage.database('chat_v2').pluck<number>("SELECT COUNT(*) FROM chat_v2_blocks WHERE block_type = 'anki_cards'");
  const events: Event[] = [];
  const parse = await start({ content: 'x' }, events);
  expect(parse.success).toBe(false);
  expect(parse.error).toBe('Invalid chatanki_start arguments: missing field `goal`');
  expect((await start({ goal: ' ', content: 'x' })).error).toBe('goal is required');
  expect((await start({ goal: 'g', content: 'x', outputProtocol: 'XML' })).error)
    .toBe("invalid outputProtocol 'xml': expected auto | delimiter | json_object | json_schema");
  expect((await start({ goal: 'g', content: 'x', templateMode: 'single', templateId: 'missing-tpl' })).error)
    .toBe('指定模板不存在: missing-tpl');
  expect(events).toEqual([['tool_error', 'Invalid chatanki_start arguments: missing field `goal`']]);
  expect(storage.database('chat_v2').pluck<number>("SELECT COUNT(*) FROM chat_v2_blocks WHERE block_type = 'anki_cards'"))
    .toBe(before);
  expect(streamLabels).toEqual([]);
});

it('started: block row before return, guard live while the model streams, terminal success with the generated cards', async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  streamHandler = async (_cancel, onDelta) => {
    await gate;
    for (const index of [1, 2]) onDelta?.(cardJson(index));
    return { content: cardJson(1) + cardJson(2), aborted: false };
  };
  onChunk = (update) => { if (streamingCount(update) === 1) release(); };
  const events: Event[] = [];
  const result = await start({ goal: '细胞呼吸', content: '线粒体是细胞的能量工厂。', deckName: '生物', maxCards: 250 }, events);
  expect(result.success).toBe(true);
  const out = result.output as Record<string, unknown>;
  const blockId = out.ankiBlockId as string;
  const documentId = out.documentId as string;
  expect(blockId).toMatch(/^blk_[0-9a-f-]{36}$/);
  expect(Object.keys(out)).toEqual(['status', 'ankiBlockId', 'documentId', 'message', 'warnings']);
  expect(out.status).toBe('started');
  expect((out.warnings as Array<Record<string, unknown>>)[0]).toMatchObject({ code: 'max_cards_clamped', requested: 250, applied: 100 });

  const initial = blockRow(blockId)!;
  expect(initial.block_index).toBe(4);
  expect(initial.content).toBeNull();
  expect(messageBlockIds()).toEqual([TOOL_BLOCK, blockId]);
  expect(tools().pipelines.isActive(blockId)).toBe(true);
  expect(events.map((event) => event[0]).slice(0, 2)).toEqual(['start', 'tool_end']);
  expect(events[0]).toEqual(['start', blockId, {
    templateId: 'design-footnote', templateIds: null, templateMode: 'single',
    options: {
      deck_name: '生物', note_type: 'Basic', template_id: 'design-footnote', template_ids: null,
      template_mode: 'single', enable_images: false, max_cards_per_source: 0,
    },
  }]);

  await tools().backgroundSettled();
  expect(tools().pipelines.isActive(blockId)).toBe(false);
  expect(streamLabels).toEqual(['Anki 流式制卡(model)']);
  expect(streamPrompts[0]).toContain('线粒体是细胞的能量工厂。');

  const tasks = ankiSurface().documents.getTasksForDocument(documentId);
  expect(tasks.map((t) => [t.status, t.original_document_name, t.content_segment]))
    .toEqual([['Completed', '生物', '线粒体是细胞的能量工厂。']]);
  expect(JSON.parse(tasks[0]!.anki_generation_options_json)).toMatchObject({ max_cards_total: 100, max_cards_per_mistake: 100 });
  const stored = ankiSurface().cards.getCardsForDocument(documentId);
  expect(stored.map((c) => [c.front, c.back, c.template_id])).toEqual([
    ['问题1', '答案1', 'design-footnote'], ['问题2', '答案2', 'design-footnote'],
  ]);
  expect(stored.map((c) => c.extra_fields)).toMatchObject([
    { question: '问题1', answer: '答案1', source: '' },
    { question: '问题2', answer: '答案2', source: '' },
  ]);

  const terminal = blockRow(blockId)!;
  expect(terminal.status).toBe('success');
  expect(terminal.block_index).toBe(4);
  expect(terminal.content).toBeNull();
  const final = output(terminal);
  expect((final.cards as Array<Record<string, unknown>>).map((c) => c.id)).toEqual(stored.map((c) => c.id));
  expect(final).toMatchObject({
    documentId, status: 'completed', workflowStatus: 'completed', limitReached: false, hiddenOverLimitCount: 0,
    ankiConnect: { available: false, error: null },
  });

  const kinds = events.map(kindOf);
  const head = ['start', 'tool_end', 'chunk:ankiConnect,progress', 'chunk:progress', 'chunk:warnings', 'chunk:documentId,progress,debug'];
  const tail = ['chunk:documentId,cards,progress', 'event', 'end'];
  expect(kinds.slice(0, head.length)).toEqual(head);
  expect(kinds.slice(-tail.length)).toEqual(tail);
  const polled = events.slice(head.length, -tail.length);
  expect(polled.length).toBeGreaterThan(0);
  for (const event of polled) {
    expect(kindOf(event)).toBe('chunk:documentId,progress');
    expect(progressOf(event[2] as Record<string, unknown>)?.stage).toBe('generating');
  }
  expect(streamingCount(polled.at(-1)![2] as Record<string, unknown>)).toBe(1);
  expect(events.at(-2)).toEqual(['event', 'fsrs://changed', {
    source: 'agent', action: 'cards_persisted', entityIds: stored.map((c) => c.id), runId: blockId,
  }]);
});

it('generation start rejected by L16 validation: startFailed terminal block, Failed placeholder task bound to the session', async () => {
  const events: Event[] = [];
  const result = await start({ goal: 'g', content: 'c', deckName: '../生物' }, events);
  const { ankiBlockId: blockId, documentId } = result.output as { ankiBlockId: string; documentId: string };
  await tools().backgroundSettled();
  expect(warns).toContain('[ChatAnkiToolExecutor] start document processing failed: 文档名称包含非法字符');
  const row = blockRow(blockId)!;
  expect(row.status).toBe('error');
  expect(row.error).toBe('blocks.ankiCards.errors.startFailed');
  const tasks = ankiSurface().documents.getTasksForDocument(documentId);
  expect(tasks.map((t) => [t.status, t.error_message])).toEqual([['Failed', 'blocks.ankiCards.errors.startFailed']]);
  expect(events.filter((event) => event[0] === 'error')).toEqual([['error', blockId, 'blocks.ankiCards.errors.startFailed']]);
  expect(tools().pipelines.isActive(blockId)).toBe(false);
  expect(streamLabels).toEqual([]);
});

it('maxCards reached while the model keeps streaming: the stream is cancelled and the task ends with the limit marker', async () => {
  const stream = streamThenHold(2);
  const events: Event[] = [];
  const result = await start({ goal: 'g', content: 'c', maxCards: 2 }, events);
  const { ankiBlockId: blockId, documentId } = result.output as { ankiBlockId: string; documentId: string };
  await tools().backgroundSettled();
  await stream.aborted;
  const statuses = ankiSurface().documents.getTasksForDocument(documentId).map((t) => [t.status, t.error_message]);
  expect(statuses).toEqual([['Cancelled', 'GLOBAL_CARD_LIMIT_REACHED']]);
  const final = output(blockRow(blockId));
  expect(final).toMatchObject({ status: 'completed', limitReached: true, hiddenOverLimitCount: 0 });
  expect((final.cards as unknown[]).length).toBe(2);
  expect((final.progress as Record<string, unknown>).messageKey).toBe('blocks.ankiCards.progress.messages.limitReached');
  expect(ankiSurface().cards.getCardsForDocument(documentId)).toHaveLength(2);
});

it('kill switch mid-stream: non-destructive cancel keeps cards and ends as cancelled without fsrs://changed', async () => {
  const stream = streamThenHold(1);
  onChunk = (update) => {
    if (Array.isArray(update.cards) && update.cards.length === 1) tools().pipelines.cancelAll('test_kill', () => undefined);
  };
  const events: Event[] = [];
  const result = await start({ goal: 'g', content: 'c' }, events);
  const { ankiBlockId: blockId, documentId } = result.output as { ankiBlockId: string; documentId: string };
  await tools().backgroundSettled();
  await stream.aborted;
  expect(ankiSurface().documents.getTasksForDocument(documentId).map((t) => t.status)).toEqual(['Cancelled']);
  const row = blockRow(blockId)!;
  expect(row.status).toBe('success');
  expect(output(row)).toMatchObject({ status: 'cancelled', workflowStatus: 'cancelled' });
  expect((output(row).cards as unknown[]).length).toBe(1);
  expect(ankiSurface().cards.getCardsForDocument(documentId)).toHaveLength(1);
  expect(events.some((event) => event[0] === 'event')).toBe(false);
  expect(events.at(-1)?.[0]).toBe('end');
});

it('unloading chatanki cancels a running pipeline through the non-destructive path (V09)', async () => {
  let entered: () => void = () => undefined;
  const streamEntered = new Promise<void>((resolve) => { entered = resolve; });
  const stream = streamThenHold(0, entered);
  const service = tools();
  const result = await start({ goal: 'g', content: 'c' });
  const { ankiBlockId: blockId, documentId } = result.output as { ankiBlockId: string; documentId: string };
  await streamEntered;
  await host.unload('dstu.chatanki');
  await service.backgroundSettled();
  await stream.aborted;
  expect(ankiSurface().documents.getTasksForDocument(documentId).map((t) => t.status)).toEqual(['Cancelled']);
  expect(blockRow(blockId)?.status).toBe('success');
  expect(output(blockRow(blockId))).toMatchObject({ status: 'cancelled' });
  expect(service.pipelines.isActive(blockId)).toBe(false);
  await host.install(chatanki);
});
