/**
 * W22 chatanki_control through the production chain (`chatankiTools.execute` / L04 registry →
 * hydrate → L16 `anki.pipeline`) on isolated migrated DBs. Rust reference:
 * chatanki_executor.rs:6483–6759. The real stream scheduler runs: with no Anki model
 * assigned, every rescheduled task fails its config step and the document completes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentSkills from '../../agent-skills/index.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import type { ChatV2EventEmitter, ToolExecutor } from '../../chat/api.ts';
import review from '../../review/index.ts';
import type { AnkiCard, TaskStatus, ToolExecutionContext, ToolResultInfo } from '../api.ts';
import chatanki from '../index.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
const CREATED = '2026-11-07T00:00:00Z';
const CALLER = 'session-control-caller';
const FOREIGN = 'session-control-foreign';
const NO_MODEL = 'Anki制卡模型在模型分配中未配置 (anki_card_model_config_id is None)';
const toolEnds: unknown[] = [];
const toolErrors: string[] = [];
const chunks: Array<{ blockId: string; patch: Record<string, unknown> }> = [];
const warnings: string[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-control-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, agentSkills, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      llm: {
        getModelAssignments: async () => ({ anki_card_model_config_id: null }),
        getApiConfigs: async () => [],
      },
      llmStreaming: {},
      vfs: {},
    },
  });
}, 60_000);

beforeEach(() => {
  toolEnds.length = 0;
  toolErrors.length = 0;
  chunks.length = 0;
  warnings.length = 0;
  host.events.length = 0;
});

afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

function addTask(
  documentId: string, segment: number, status: TaskStatus, session = CALLER,
): string {
  const id = `task-${documentId}-${segment}`;
  host.ctx.anki.documents.insertDocumentTask({
    id, document_id: documentId, original_document_name: 'control.md',
    segment_index: segment, content_segment: `segment ${segment}`, status,
    created_at: CREATED, updated_at: CREATED, error_message: null, anki_generation_options_json: '{}',
  });
  host.ctx.anki.documents.setDocumentSessionSource(documentId, session);
  return id;
}

function addCard(taskId: string, id: string, patch: Partial<AnkiCard> = {}): void {
  expect(host.ctx.anki.cards.insertCard({
    id, task_id: taskId, front: `front ${id}`, back: 'answer', text: null,
    tags: [], images: [], is_error_card: false, error_content: null,
    created_at: CREATED, updated_at: CREATED, extra_fields: {}, template_id: null, ...patch,
  })).toBe(true);
}

function seedBlock(blockId: string, sessionId: string, status: string, toolOutput: unknown): void {
  const db = storage.database('chat_v2');
  db.run(`INSERT OR IGNORE INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', 'active', ?2, ?2)`, [sessionId, CREATED]);
  db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
    VALUES (?1, ?2, 'assistant', ?3, ?4)`, [`msg-${blockId}`, sessionId, JSON.stringify([blockId]), Date.now()]);
  db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, tool_name, started_at, tool_output_json)
    VALUES (?1, ?2, 'anki_cards', ?3, 0, 'chatanki_run', ?4, ?5)`,
  [blockId, `msg-${blockId}`, status, Date.now(), JSON.stringify(toolOutput)]);
}

function blockRow(blockId: string) {
  const row = storage.database('chat_v2').get<{ status: string; tool_output_json: string }>(
    'SELECT status, tool_output_json FROM chat_v2_blocks WHERE id = ?1', [blockId])!;
  return { status: row.status, output: JSON.parse(row.tool_output_json) as Record<string, unknown> };
}

function statuses(documentId: string): Record<string, string> {
  const rows = storage.database('mistakes').all<{ id: string; status: string }>(
    'SELECT id, status FROM document_tasks WHERE document_id = ?1 ORDER BY segment_index', [documentId]);
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

function generationEvents(): Array<Record<string, unknown>> {
  return host.eventsNamed('anki_generation_event') as Array<Record<string, unknown>>;
}

function statusUpdates(): Array<[unknown, unknown]> {
  return generationEvents()
    .map((event) => event.TaskStatusUpdate as Record<string, unknown> | undefined)
    .filter((update): update is Record<string, unknown> => update !== undefined)
    .map((update) => [update.task_id, update.status]);
}

async function documentCompleted(documentId: string): Promise<void> {
  await vi.waitFor(() => {
    expect(generationEvents()).toContainEqual({ DocumentProcessingCompleted: { document_id: documentId } });
  });
}

function counts(partial: Record<string, number>, completedRatio: number) {
  return {
    counts: {
      total: 0, pending: 0, processing: 0, streaming: 0, paused: 0,
      completed: 0, failed: 0, truncated: 0, cancelled: 0, ...partial,
    },
    completedRatio,
  };
}

function context(): ToolExecutionContext {
  return {
    sessionId: CALLER, messageId: 'message-control', blockId: 'block-control-call',
    emitToolCallStart: () => undefined,
    emitToolCallEnd: (payload) => { toolEnds.push(payload); },
    emitToolCallError: (error) => { toolErrors.push(error); },
    saveToolBlock: () => undefined,
    emitChunk: (blockId, patch) => { chunks.push({ blockId, patch }); },
    warn: (message) => { warnings.push(message); },
  };
}

function control(args: unknown): Promise<ToolResultInfo> {
  return host.ctx.chatankiTools.execute(
    { id: 'call-control', name: 'builtin-chatanki_control', arguments: args }, context());
}

it('W22 control pause stops the running task through anki.pipeline and reports the nested Rust counts', async () => {
  addTask('doc-pause', 0, 'Processing');
  addTask('doc-pause', 1, 'Pending');
  addTask('doc-pause', 2, 'Completed');

  const result = await control({ action: ' Pause ', documentId: ' doc-pause ' });
  expect(result.success, result.error ?? undefined).toBe(true);
  expect(result.output).toEqual({
    status: 'ok', action: 'pause', documentId: 'doc-pause',
    counts: counts({ total: 3, paused: 1, pending: 1, completed: 1 }, 0.33333334),
  });
  expect(Object.keys(result.output as object)).toEqual(['status', 'action', 'documentId', 'counts']);
  expect(statuses('doc-pause')).toEqual({
    'task-doc-pause-0': 'Paused', 'task-doc-pause-1': 'Pending', 'task-doc-pause-2': 'Completed',
  });
  expect(statusUpdates()).toEqual([['task-doc-pause-0', 'Paused']]);
  expect(generationEvents().at(-1)).toEqual({ DocumentProcessingPaused: { document_id: 'doc-pause' } });
  expect(toolEnds).toEqual([{ result: result.output, durationMs: expect.any(Number) }]);
  expect(toolErrors).toEqual([]);

  host.events.length = 0;
  const resumed = await control({ action: 'resume', documentId: 'doc-pause' });
  expect(resumed.success, resumed.error ?? undefined).toBe(true);
  expect(resumed.output).toMatchObject({ status: 'ok', action: 'resume', documentId: 'doc-pause' });
  await documentCompleted('doc-pause');
  expect(statuses('doc-pause')).toEqual({
    'task-doc-pause-0': 'Failed', 'task-doc-pause-1': 'Failed', 'task-doc-pause-2': 'Completed',
  });
  expect(generationEvents()).toContainEqual({
    TaskProcessingError: { task_id: 'task-doc-pause-0', error_message: NO_MODEL, document_id: 'doc-pause' },
  });
});

it('W22 control cancel keeps cards, cancels unfinished tasks and converges the owned anki_cards block', async () => {
  addTask('doc-cancel', 0, 'Pending');
  addTask('doc-cancel', 1, 'Paused');
  const done = addTask('doc-cancel', 2, 'Completed');
  addCard(done, 'card-cancel-kept');
  seedBlock('blk-cancel', CALLER, 'running', { documentId: 'doc-cancel', cards: [] });

  const result = await control({ action: 'CANCEL', documentId: 'doc-cancel' });
  expect(result.success, result.error ?? undefined).toBe(true);
  expect(result.output).toEqual({
    status: 'ok', action: 'cancel', documentId: 'doc-cancel',
    counts: counts({ total: 3, cancelled: 2, completed: 1 }, 1),
  });
  expect(statuses('doc-cancel')).toEqual({
    'task-doc-cancel-0': 'Cancelled', 'task-doc-cancel-1': 'Cancelled', 'task-doc-cancel-2': 'Completed',
  });
  expect(statusUpdates()).toEqual([['task-doc-cancel-0', 'Cancelled'], ['task-doc-cancel-1', 'Cancelled']]);
  expect(generationEvents().at(-1)).toEqual({ DocumentProcessingCancelled: { document_id: 'doc-cancel' } });
  expect(storage.database('mistakes').pluck(
    'SELECT COUNT(*) FROM anki_cards WHERE id = ?1 AND deleted_at IS NULL', ['card-cancel-kept'])).toBe(1);

  const block = blockRow('blk-cancel');
  expect(block.status).not.toBe('running');
  expect(block.output).toMatchObject({ documentId: 'doc-cancel', cardsRefreshedFromDb: true });
  expect((block.output.cards as Array<{ id: string }>).map((card) => card.id)).toEqual(['card-cancel-kept']);
  expect(chunks.map((chunk) => chunk.blockId)).toEqual(['blk-cancel']);
});

it('W22 control retry re-queues one owned task, or builds the error-card repair task, then resumes', async () => {
  const failed = addTask('doc-retry', 0, 'Failed');
  addTask('doc-retry', 1, 'Completed');

  const one = await control({ action: 'retry', documentId: 'doc-retry', taskId: ` ${failed} ` });
  expect(one.success, one.error ?? undefined).toBe(true);
  expect(one.output).toMatchObject({ status: 'ok', action: 'retry', documentId: 'doc-retry' });
  await documentCompleted('doc-retry');
  expect(statusUpdates()).toEqual([[failed, 'Processing'], [failed, 'Failed']]);

  host.events.length = 0;
  const source = addTask('doc-repair', 0, 'Completed');
  addCard(source, 'card-repair-ok');
  addCard(source, 'card-repair-err', { is_error_card: true, error_content: 'truncated {"front":"photosynthesis' });
  const repair = await control({ action: 'retry', documentId: 'doc-repair', taskId: '   ' });
  expect(repair.success, repair.error ?? undefined).toBe(true);
  expect((repair.output as { counts: { counts: { total: number } } }).counts.counts.total).toBe(2);
  await documentCompleted('doc-repair');
  const tasks = storage.database('mistakes').all<{ original_document_name: string; status: string }>(
    'SELECT original_document_name, status FROM document_tasks WHERE document_id = ?1 ORDER BY segment_index',
    ['doc-repair']);
  expect(tasks).toEqual([
    { original_document_name: 'control.md', status: 'Completed' },
    { original_document_name: 'control.md - 错误卡修复', status: 'Failed' },
  ]);
});

it('W22 control retry: a foreign task is statusNotFound inline, a missing task is the Rust `?` error', async () => {
  addTask('doc-mine', 0, 'Failed');
  const other = addTask('doc-other', 0, 'Failed');

  const mismatch = await control({ action: 'retry', documentId: 'doc-mine', taskId: other });
  expect(mismatch.success).toBe(false);
  expect(mismatch.output).toBeNull();
  expect(mismatch.error).toBe('blocks.ankiCards.errors.statusNotFound');
  expect(toolErrors).toEqual(['blocks.ankiCards.errors.statusNotFound']);
  expect(statuses('doc-other')).toEqual({ [other]: 'Failed' });

  await expect(control({ action: 'retry', documentId: 'doc-mine', taskId: 'task-missing' }))
    .rejects.toThrow(/^获取任务失败: /);
  expect(statuses('doc-mine')).toEqual({ 'task-doc-mine-0': 'Failed' });
  expect(generationEvents()).toEqual([]);
});

it('W22 control maps argument, ownership and action failures like Rust before touching the pipeline', async () => {
  addTask('doc-guard', 0, 'Processing');
  addTask('doc-guard-foreign', 0, 'Processing', FOREIGN);
  const prefix = 'Invalid chatanki_control arguments: ';
  const cases: Array<[unknown, string]> = [
    [{}, `${prefix}missing field \`action\``],
    [{ action: 'pause' }, `${prefix}missing field \`documentId\``],
    [{ action: 'pause', documentId: 5 }, `${prefix}invalid type: number, expected a string`],
    [{ action: 'pause', documentId: 'doc-guard', taskId: 7 }, `${prefix}invalid type: number, expected a string`],
    [['pause', 'doc-guard'], `${prefix}invalid length 2, expected struct ChatAnkiControlArgs with 3 elements`],
    [{ action: 'pause', documentId: '  ' }, 'documentId is required'],
    [{ action: 'pause', documentId: 'doc-guard-foreign' }, 'blocks.ankiCards.errors.statusNotFound'],
    [{ action: ' Stop ', documentId: 'doc-guard' }, 'Unsupported action:  Stop '],
  ];
  for (const [args, error] of cases) {
    const result = await control(args);
    expect(result.success, JSON.stringify(args)).toBe(false);
    expect(result.output).toBeNull();
    expect(result.error).toBe(error);
  }
  expect(toolErrors).toEqual(cases.map(([, error]) => error));
  expect(statuses('doc-guard')).toEqual({ 'task-doc-guard-0': 'Processing' });
  expect(statuses('doc-guard-foreign')).toEqual({ 'task-doc-guard-foreign-0': 'Processing' });
  expect(generationEvents()).toEqual([]);

  const positional = await control(['pause', 'doc-guard', null]);
  expect(positional.output).toMatchObject({ status: 'ok', action: 'pause', documentId: 'doc-guard' });
  expect(statuses('doc-guard')).toEqual({ 'task-doc-guard-0': 'Paused' });
});

type EmitterCall = [method: string, ...args: unknown[]];

function recordingEmitter(): { emitter: ChatV2EventEmitter; calls: EmitterCall[] } {
  const calls: EmitterCall[] = [];
  const record = (method: string) => (...args: unknown[]) => { calls.push([method, ...args]); };
  return {
    calls,
    emitter: {
      emitStart: record('emitStart'), emitChunk: record('emitChunk'), emitEnd: record('emitEnd'),
      emitError: record('emitError'), emitStartWithMeta: record('emitStartWithMeta'),
      emitEndWithMeta: record('emitEndWithMeta'), emitErrorWithMeta: record('emitErrorWithMeta'),
    },
  };
}

function registry() {
  return host.ctx.chatSession.createExecutorRegistry(
    host.ctx.agentTools.toolExecutors() as readonly ToolExecutor[],
    { ignoresBroadApprovalBypassForArgs: () => false, neverRememberApprovalForArgs: () => false },
  );
}

it('W22 registry: builtin-chatanki_control is offered only while L16 publishes anki.pipeline and dispatches through it', async () => {
  const service = host.ctx.anki as unknown as Record<string, unknown>;
  const own = Object.getOwnPropertyDescriptor(service, 'pipeline');
  Object.defineProperty(service, 'pipeline', { value: undefined, configurable: true, writable: true });
  try {
    expect(registry().hasSpecificExecutor('builtin-chatanki_control')).toBe(false);
    expect(host.ctx.chatankiTools.canHandle('chatanki_control')).toBe(false);
  } finally {
    if (own === undefined) delete service.pipeline;
    else Object.defineProperty(service, 'pipeline', own);
  }
  const live = registry();
  expect(live.hasSpecificExecutor('builtin-chatanki_control')).toBe(true);

  addTask('doc-reg', 0, 'Streaming');
  const other = addTask('doc-reg-other', 0, 'Failed');
  const { emitter, calls } = recordingEmitter();
  const execution = () => {
    const context = host.ctx.chatSession.createExecutionContext({
      sessionId: CALLER, messageId: 'message-control-reg', blockId: 'block-control-reg', emitter,
      services: host.ctx, toolRegistry: {} as never,
    });
    context.round_id = 'round-control-reg';
    return context;
  };
  const paused = await live.execute(
    { id: 'call-control-reg', name: 'builtin-chatanki_control', arguments: { action: 'pause', documentId: 'doc-reg' } },
    execution());
  expect(paused.success, paused.error ?? undefined).toBe(true);
  expect(statuses('doc-reg')).toEqual({ 'task-doc-reg-0': 'Paused' });
  expect(calls.map(([method]) => method)).toEqual(['emitStartWithMeta', 'emitEndWithMeta']);

  calls.length = 0;
  const mismatch = await live.execute({
    id: 'call-control-reg-2', name: 'builtin-chatanki_control',
    arguments: { action: 'retry', documentId: 'doc-reg', taskId: other },
  }, execution());
  expect(mismatch.error).toBe('blocks.ankiCards.errors.statusNotFound');
  // chatanki_executor.rs:6629 `ctx.emitter.emit_error(TOOL_CALL, block_id, .., None)`, not emit_tool_call_error.
  expect(calls).toEqual([
    ['emitStartWithMeta', 'tool_call', 'message-control-reg', 'block-control-reg',
      { toolName: 'builtin-chatanki_control', toolInput: { action: 'retry', documentId: 'doc-reg', taskId: other },
        toolCallId: 'call-control-reg-2' }, null, null, 'round-control-reg'],
    ['emitError', 'tool_call', 'block-control-reg', 'blocks.ankiCards.errors.statusNotFound', null],
  ]);
});
