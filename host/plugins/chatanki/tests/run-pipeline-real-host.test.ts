// chatanki_executor.rs:6817–6899 + :7511–8046: chatanki_run through the real chat history (L04),
// the real VFS read set (vfs database, vfs-repos, agent-workspace resolver, media docs), the real L16
// document pipeline and chat block store. Only the L02 boundary (`llm`, `llmStreaming`, `llmRawPrompt`)
// is a double: it answers the route planner and the VLM extractor and streams the generated cards.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentWorkspace from '../../agent-workspace/index.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import type { ApiConfig, LLMManager, LlmRawPrompt, LlmStreamingService } from '../../llm/api.ts';
import media from '../../media/index.ts';
import notes from '../../notes/index.ts';
import review from '../../review/index.ts';
import vfs from '../../vfs/index.ts';
import vfsIndex from '../../vfs-index/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import chatanki from '../index.ts';
import type { AnkiCard, DocumentTask, ToolExecutionContext, ToolResultInfo } from '../api.ts';

const SESSION_REFS = 'sess_run_refs';
const SESSION_TEXT = 'sess_run_text';
const SESSION_IMAGE = 'sess_run_image';
const NOTES = '第一章 细胞结构\n线粒体是细胞进行有氧呼吸的主要场所，被称为细胞的能量工厂。\n叶绿体是植物细胞进行光合作用的场所。';
const MATERIAL = '光合作用分为光反应和暗反应两个阶段。\n光反应在类囊体薄膜上进行，产生 ATP 和 NADPH；暗反应在叶绿体基质中进行，固定二氧化碳。';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const DOWNGRADE_NOTE = '<system_note>模型不支持图片输入，已自动降级为 OCR 文本注入。</system_note>';

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

function cardJson(index: number): string {
  return JSON.stringify({ Question: `问题${index}`, Answer: `答案${index}`, Source: '', tags: [] });
}

const llm = {
  async getApiConfigs() { return [apiConfig()]; },
  async getModelAssignments() { return { anki_card_model_config_id: 'cfg' }; },
  async getModel2Config() { return apiConfig(); },
  async decryptApiKey(key: string) { return key; },
} as unknown as LLMManager;

let streamPrompts: string[] = [];
const llmStreaming: LlmStreamingService = {
  async singleShotCompletion(_config, body, _apiKey, _sessionId, _context, _opts, onDelta) {
    streamPrompts.push(JSON.stringify(body));
    onDelta?.(cardJson(1));
    return {
      content: cardJson(1), reasoningBytes: 0, finishReason: 'stop', usage: null, mode: 'stream',
      attempts: 1, interrupted: null, aborted: false,
    };
  },
};

interface RawCall { exit: string; decision: unknown; task: string; prompt: string; images: unknown; caller: unknown }
let rawCalls: RawCall[] = [];
let plannerAnswer = '';
let vlmAnswer = '';
// No llmAnkiRouting is published here, so the planner and VLM pass a null decision (caller anki).
const llmRawPrompt = {
  async callAnkiRoutedRawPrompt(decision: unknown, task: string, prompt: string, images: unknown) {
    rawCalls.push({ exit: 'routed', decision, task, prompt, images, caller: 'anki' });
    return { assistant_message: images === null ? plannerAnswer : vlmAnswer };
  },
  async callModel2RawPrompt(prompt: string, images: unknown, caller: unknown) {
    rawCalls.push({ exit: 'model2', decision: null, task: 'utility', prompt, images, caller });
    return { assistant_message: images === null ? plannerAnswer : vlmAnswer };
  },
} as unknown as LlmRawPrompt;

function seedSession(sessionId: string, users: Array<{ id: string; text: string | null; refs: unknown[] | null }>): void {
  const db = storage.database('chat_v2');
  db.run(`INSERT INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', 'active', '2026-11-07T00:00:00+00:00', '2026-11-07T00:00:00+00:00')`, [sessionId]);
  users.forEach((user, index) => {
    const contentBlock = `${user.id}_content`;
    const meta = user.refs === null ? null : JSON.stringify({ contextSnapshot: { userRefs: user.refs, retrievalRefs: [] } });
    db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp, meta_json)
      VALUES (?1, ?2, 'user', ?3, ?4, ?5)`,
    [user.id, sessionId, JSON.stringify(user.text === null ? [] : [contentBlock]), index + 1, meta]);
    if (user.text !== null) {
      db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, content)
        VALUES (?1, ?2, 'content', 'success', 0, ?3)`, [contentBlock, user.id, user.text]);
    }
  });
  db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
    VALUES (?1, ?2, 'assistant', ?3, 100)`, [`msg_${sessionId}`, sessionId, JSON.stringify([`blk_tool_${sessionId}`])]);
  db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, tool_name)
    VALUES (?1, ?2, 'tool_call', 'running', 1, 'chatanki_run')`, [`blk_tool_${sessionId}`, `msg_${sessionId}`]);
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-run-pipeline-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  const paths = createPaths({ dataDir: dir, platform: 'linux', env: {
    HOME: dir, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir, XDG_CACHE_HOME: dir,
  } });
  host = await createTestHost({
    app: { dataDir: dir },
    plugins: [native, vfsRepos, notes, vfsIndex, vfs, media, agentWorkspace, chat, anki, review, chatanki],
    provide: {
      paths, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      llm, llmStreaming, llmRawPrompt,
    },
  });
  ankiSurface().templates.importBuiltinTemplatesIfEmpty();

  seedSession(SESSION_REFS, [{
    id: 'msg_refs_user', text: '帮我把讲义做成卡片',
    refs: [{ resourceId: 'file_notes', hash: 'hash-notes', typeId: 'file', displayName: 'lecture-notes.pdf' }],
  }]);
  seedSession(SESSION_TEXT, [
    { id: 'msg_text_material', text: `  ${MATERIAL}  `, refs: null },
    { id: 'msg_text_short', text: '继续', refs: null },
  ]);
  seedSession(SESSION_IMAGE, [{
    id: 'msg_image_user', text: '看图',
    refs: [{ resourceId: 'res_ctx_diagram', hash: 'hash-ctx-diagram', typeId: 'image', displayName: 'diagram.png' }],
  }]);

  const vfsDb = storage.database('vfs');
  vfsDb.run(`INSERT INTO resources (id, hash, type, source_id, data, created_at, updated_at) VALUES
    ('res_notes', 'hash-notes', 'file', NULL, NULL, 1, 1),
    ('res_diagram', 'hash-diagram', 'image', NULL, ?1, 1, 1),
    ('res_ctx_diagram', 'hash-ctx-diagram', 'image', NULL, ?2, 1, 1)`, [PNG, JSON.stringify({
    refs: [{ sourceId: 'file_diagram', resourceHash: 'hash-diagram', type: 'image', name: 'diagram.png' }],
    truncated: false, totalCount: 1,
  })]);
  vfsDb.run(`INSERT INTO files (id, resource_id, sha256, file_name, size, created_at, updated_at, type, mime_type, extracted_text) VALUES
    ('file_notes', 'res_notes', 'sha-notes', 'notes-upload.pdf', 10, '2026-11-07', '2026-11-07', 'document', 'application/pdf', ?1),
    ('file_diagram', 'res_diagram', 'sha-diagram', 'diagram.png', 10, '2026-11-07', '2026-11-07', 'image', 'image/png', NULL)`,
  [NOTES]);
}, 60_000);

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

type Event = [string, ...unknown[]];
let warns: string[] = [];

beforeEach(() => {
  streamPrompts = [];
  rawCalls = [];
  plannerAnswer = '';
  vlmAnswer = '';
  warns = [];
});

function context(sessionId: string, events: Event[]): ToolExecutionContext {
  return {
    sessionId, messageId: `msg_${sessionId}`, blockId: `blk_tool_${sessionId}`,
    emitToolCallStart: () => undefined,
    emitToolCallEnd: (payload) => { events.push(['tool_end', payload]); },
    emitToolCallError: (error) => { events.push(['tool_error', error]); },
    saveToolBlock: () => undefined,
    warn: (message) => { warns.push(message); },
    info: () => undefined,
    emitChunk: (id, update) => { events.push(['chunk', id, update]); },
    emitBlockError: (id, error) => { events.push(['error', id, error]); },
    emitBlockStart: (id, payload) => { events.push(['start', id, payload]); },
    emitBlockEnd: (id, result) => { events.push(['end', id, result]); },
    emitEvent: (event, payload) => { events.push(['event', event, payload]); },
    ankiConnect: { checkAnkiConnectAvailability: async () => false },
  };
}

async function run(sessionId: string, args: Record<string, unknown>, events: Event[] = []): Promise<ToolResultInfo> {
  return tools().execute(
    { id: `call_${sessionId}`, name: 'builtin-chatanki_run', arguments: { templateMode: 'single', ...args } },
    context(sessionId, events),
  );
}

interface Started { blockId: string; documentId: string }

async function runToEnd(sessionId: string, args: Record<string, unknown>, events: Event[] = []): Promise<Started> {
  const result = await run(sessionId, args, events);
  expect(result.success, result.error).toBe(true);
  const out = result.output as { ankiBlockId: string; documentId: string; status: string };
  expect(out.status).toBe('started');
  await tools().backgroundSettled();
  return { blockId: out.ankiBlockId, documentId: out.documentId };
}

function blockOutput(blockId: string): { status: string; error: string | null; output: Record<string, unknown> | null } {
  const row = storage.database('chat_v2').get<{ status: string; error: string | null; tool_output_json: string | null }>(
    'SELECT status, error, tool_output_json FROM chat_v2_blocks WHERE id = ?1', [blockId],
  )!;
  return { status: row.status, error: row.error, output: JSON.parse(row.tool_output_json ?? 'null') as Record<string, unknown> | null };
}

function segments(documentId: string): string[] {
  return ankiSurface().documents.getTasksForDocument(documentId).map((task) => task.content_segment);
}

function importing(events: Event[]): unknown[] {
  return events
    .filter((event) => event[0] === 'chunk' && (event[2] as { progress?: { stage?: string } }).progress?.stage === 'importing')
    .map((event) => (event[2] as { progress: unknown }).progress);
}

function taskCreatedDebug(events: Event[]): unknown {
  const chunk = events.find((event) => event[0] === 'chunk' && 'documentId' in (event[2] as object) && 'debug' in (event[2] as object));
  return (chunk?.[2] as { debug?: unknown } | undefined)?.debug;
}

it('chatanki_run is claimed while the L16 generation control and the L02 raw prompt are both published', () => {
  expect(tools().canHandle('chatanki_run')).toBe(true);
  expect(tools().canHandle('builtin-chatanki_run')).toBe(true);
  const pipeline = ankiSurface().pipeline;
  const published = pipeline.startDocumentProcessingWithId;
  delete pipeline.startDocumentProcessingWithId;
  try {
    expect(tools().canHandle('chatanki_run')).toBe(false);
  } finally {
    pipeline.startDocumentProcessingWithId = published;
  }
});

it('front half: Rust arg parse failures stay inline and persist no block', async () => {
  const before = storage.database('chat_v2').pluck<number>("SELECT COUNT(*) FROM chat_v2_blocks WHERE block_type = 'anki_cards'");
  const events: Event[] = [];
  const parsed = await run(SESSION_REFS, { content: 'x' }, events);
  expect(parsed.error).toBe('Invalid chatanki_run arguments: missing field `goal`');
  expect(events).toEqual([['tool_error', 'Invalid chatanki_run arguments: missing field `goal`']]);
  expect((await run(SESSION_REFS, { goal: '  ' })).error).toBe('goal is required');
  expect(storage.database('chat_v2').pluck<number>("SELECT COUNT(*) FROM chat_v2_blocks WHERE block_type = 'anki_cards'"))
    .toBe(before);
  expect(rawCalls).toEqual([]);
});

it('session file ref: the LLM route plan picks simple_text and the generator receives the VFS extracted text', async () => {
  plannerAnswer = JSON.stringify({ route: 'simple_text', confidence: 0.75, glossaryMode: false, reason: '纯文本讲义' });
  const events: Event[] = [];
  const { blockId, documentId } = await runToEnd(SESSION_REFS, { goal: '细胞结构', debug: true }, events);

  expect(rawCalls).toHaveLength(1);
  expect(rawCalls[0]).toMatchObject({
    exit: 'routed', decision: null, task: 'chatanki.plan_route', images: null, caller: 'anki',
  });
  expect(rawCalls[0]!.prompt).toContain('- lecture-notes.pdf (file)');
  expect(rawCalls[0]!.prompt).toContain('线粒体是细胞进行有氧呼吸的主要场所');

  const expected = `# lecture-notes.pdf\n\n${NOTES}`;
  expect(segments(documentId)).toEqual([expected]);
  expect(streamPrompts[0]).toContain(JSON.stringify(expected).slice(1, -1));
  expect(importing(events)).toEqual([
    { stage: 'importing', route: 'simple_text', messageKey: 'blocks.ankiCards.progress.messages.importing' },
  ]);
  const debug = taskCreatedDebug(events) as Record<string, unknown>;
  expect(Object.keys(debug)).toEqual(['selectedContextRefs', 'routeSource', 'routePlan']);
  expect(debug).toEqual({
    selectedContextRefs: [{ resourceId: 'file_notes', hash: 'hash-notes', typeId: 'file' }],
    routeSource: 'llm',
    routePlan: { route: 'simple_text', confidence: 0.75, glossaryMode: false, reason: '纯文本讲义', applied: true },
  });

  const terminal = blockOutput(blockId);
  expect(terminal.status).toBe('success');
  expect(terminal.output).toMatchObject({ status: 'completed', debug });
  expect(ankiSurface().cards.getCardsForDocument(documentId).map((card) => card.front)).toEqual(['问题1']);
});

it('no refs, no content: the newest material-like user message (not the trailing short command) is the input', async () => {
  const events: Event[] = [];
  const { blockId, documentId } = await runToEnd(SESSION_TEXT, { goal: '光合作用', debug: true }, events);
  expect(rawCalls).toEqual([]);
  expect(segments(documentId)).toEqual([MATERIAL]);
  expect(importing(events)).toEqual([
    { stage: 'importing', route: 'simple_text', messageKey: 'blocks.ankiCards.progress.messages.simpleTextDetected' },
  ]);
  expect(taskCreatedDebug(events)).toEqual({ inputSource: 'latest_user_message' });
  expect(blockOutput(blockId).status).toBe('success');
});

it('preferred ids: a VFS source id outside the session snapshot resolves; an unknown id fails the run with the Rust message', async () => {
  const found = await runToEnd(SESSION_TEXT, { goal: '细胞结构', resourceId: 'file_notes', route: 'simple_text', debug: true });
  expect(rawCalls).toEqual([]);
  expect(segments(found.documentId)).toEqual([`# notes-upload.pdf\n\n${NOTES}`]);
  expect(blockOutput(found.blockId).output).toMatchObject({
    debug: {
      selectedContextRefs: [{ resourceId: 'file_notes', hash: 'hash-notes', typeId: 'file' }],
      routeSource: 'forced',
    },
  });

  const events: Event[] = [];
  const missing = await runToEnd(SESSION_TEXT, {
    goal: 'g', resourceId: 'file_missing', resourceIds: ['file_missing', '  '], route: 'VLM_FULL', content: '  ',
  }, events);
  const message = 'Preferred resource not found in current session context: file_missing';
  expect(warns).toContain(`[ChatAnkiToolExecutor] background pipeline error: ${message}`);
  expect(events.filter((event) => event[0] === 'error')).toEqual([['error', missing.blockId, message]]);
  expect(blockOutput(missing.blockId)).toMatchObject({ status: 'error', error: message });
  expect(ankiSurface().documents.getTasksForDocument(missing.documentId).map((task) => [task.status, task.error_message]))
    .toEqual([['Failed', message]]);
  expect(streamPrompts).toHaveLength(1);
});

it('image ref with a forced vlm_light route: the VLM gets the VFS image and its output joins the text and tool content', async () => {
  vlmAnswer = '## 图示\n箭头从线粒体指向细胞质。';
  const events: Event[] = [];
  const { blockId, documentId } = await runToEnd(SESSION_IMAGE, {
    goal: '能量流向', route: 'vlm_light', visualHint: '  关注箭头方向  ', content: '补充：图中箭头表示 ATP 流向。', maxImages: 3,
  }, events);

  expect(rawCalls).toHaveLength(1);
  expect(rawCalls[0]).toMatchObject({
    exit: 'routed', decision: null, task: 'chatanki.vlm_light_extract', images: [{ mime: 'image/png', base64: PNG }], caller: 'anki',
  });
  expect(rawCalls[0]!.prompt).toContain('关注箭头方向');
  expect(segments(documentId)).toEqual([
    `${DOWNGRADE_NOTE}\n\n补充：图中箭头表示 ATP 流向。\n\n# 视觉补充\n\n${vlmAnswer}`,
  ]);
  expect(importing(events)).toEqual([
    { stage: 'importing', route: 'vlm_light', messageKey: 'blocks.ankiCards.progress.messages.vlmExtracting' },
  ]);
  expect(blockOutput(blockId).status).toBe('success');
});
