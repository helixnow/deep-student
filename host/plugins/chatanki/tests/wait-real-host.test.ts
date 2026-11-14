/**
 * W22 chatanki_wait through the production chain (`chatankiTools.execute` →
 * hydrate → real L16 task/card reads and real L04 blocks on isolated migrated
 * DBs). Rust reference: chatanki_executor.rs:5039–5547.
 * The 900 ms poll sleep runs on fake timers; `performance.now` is the
 * monotonic clock the deadline and the 8 s block-discovery grace read.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, TaskStatus, ToolExecutionContext, ToolResultInfo } from '../api.ts';
import chatanki from '../index.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
const CREATED = '2026-08-24T00:00:00Z';
const CALLER = 'session-wait-caller';
const FOREIGN = 'session-wait-foreign';
const toolEnds: unknown[] = [];
const toolErrors: string[] = [];
const chunks: Array<{ blockId: string; patch: Record<string, unknown> }> = [];
const warnings: string[] = [];
let clockMs = 0;
let cancelled = false;

const WAIT_KEYS = [
  'status', 'ankiBlockId', 'documentId', 'cardsCount', 'usableCards', 'progress', 'ankiConnect',
  'limitReached', 'error', 'shouldRetry',
];
const PROJECTED_WAIT_KEYS = [
  ...WAIT_KEYS, 'schemaVersion', 'stateRevision', 'workflowStatus', 'generationStatus', 'deliveryStatus',
  'recoveryStatus', 'availableCards', 'recoveredCards', 'finalStatus', 'finalError', 'issues', 'warnings',
];
const EARLY_KEYS = ['status', 'ankiBlockId', 'documentId', 'cardsCount', 'progress', 'ankiConnect', 'error', 'shouldRetry'];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-wait-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      llm: {}, vfs: {}, // unused; task, card and block owners are real
    },
  });
}, 60_000);

beforeEach(() => {
  toolEnds.length = 0;
  toolErrors.length = 0;
  chunks.length = 0;
  warnings.length = 0;
  clockMs = 0;
  cancelled = false;
  vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

async function advance(ms: number): Promise<void> {
  clockMs += ms;
  await vi.advanceTimersByTimeAsync(ms);
}

function addTask(
  documentId: string, segment: number, status: TaskStatus, session = CALLER, errorMessage: string | null = null,
): void {
  host.ctx.anki.documents.insertDocumentTask({
    id: `task-${documentId}-${segment}`, document_id: documentId, original_document_name: 'wait.md',
    segment_index: segment, content_segment: 'material', status,
    created_at: CREATED, updated_at: CREATED, error_message: errorMessage, anki_generation_options_json: '{}',
  });
  host.ctx.anki.documents.setDocumentSessionSource(documentId, session);
}

function addCard(documentId: string, id: string, patch: Partial<AnkiCard> = {}): AnkiCard {
  const card: AnkiCard = {
    id, task_id: `task-${documentId}-0`, front: `front ${id}`, back: 'answer', text: null,
    tags: [], images: [], is_error_card: false, error_content: null,
    created_at: CREATED, updated_at: CREATED, extra_fields: {}, template_id: null, ...patch,
  };
  expect(host.ctx.anki.cards.insertCard(card)).toBe(true);
  return card;
}

function seedBlock(
  blockId: string, sessionId: string, status: string, toolOutput: unknown, error: string | null = null,
): void {
  const db = storage.database('chat_v2');
  db.run(`INSERT OR IGNORE INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', 'active', ?2, ?2)`, [sessionId, CREATED]);
  db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
    VALUES (?1, ?2, 'assistant', ?3, ?4)`, [`msg-${blockId}`, sessionId, JSON.stringify([blockId]), Date.now()]);
  db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, tool_name, started_at, tool_output_json, error)
    VALUES (?1, ?2, 'anki_cards', ?3, 0, 'chatanki_run', ?4, ?5, ?6)`,
  [blockId, `msg-${blockId}`, status, Date.now(), JSON.stringify(toolOutput), error]);
}

function blockRow(blockId: string) {
  const row = storage.database('chat_v2').get<{ status: string; tool_output_json: string }>(
    'SELECT status, tool_output_json FROM chat_v2_blocks WHERE id = ?1', [blockId])!;
  return { status: row.status, output: JSON.parse(row.tool_output_json) as Record<string, unknown> };
}

function context(): ToolExecutionContext {
  return {
    sessionId: CALLER, messageId: 'message-wait', blockId: 'block-wait-call',
    emitToolCallStart: () => undefined,
    emitToolCallEnd: (payload) => { toolEnds.push(payload); },
    emitToolCallError: (error) => { toolErrors.push(error); },
    saveToolBlock: () => undefined,
    emitChunk: (blockId, patch) => { chunks.push({ blockId, patch }); },
    isCancelled: () => cancelled,
    warn: (message) => { warnings.push(message); },
  };
}

function wait(args: unknown): Promise<ToolResultInfo> {
  return host.ctx.chatankiTools.execute({ id: 'call-wait', name: 'builtin-chatanki_wait', arguments: args }, context());
}

function counts(partial: Record<string, number>): Record<string, number> {
  return {
    total: 0, pending: 0, processing: 0, streaming: 0, paused: 0,
    completed: 0, failed: 0, truncated: 0, cancelled: 0, ...partial,
  };
}

it('W22 wait on a terminal owned document returns the Rust payload with the workflow projection merged', async () => {
  addTask('doc-done', 0, 'Completed');
  addTask('doc-done', 1, 'Cancelled', CALLER, 'GLOBAL_CARD_LIMIT_REACHED');
  addCard('doc-done', 'card-done-a');
  addCard('doc-done', 'card-done-err', { is_error_card: true, error_content: 'diagnostic' });
  seedBlock('blk-done', CALLER, 'running', { documentId: 'doc-done', cards: [] });

  const result = await wait({ documentId: ' doc-done ' });
  expect(result.success).toBe(true);
  const output = result.output as Record<string, unknown>;
  expect(Object.keys(output)).toEqual(PROJECTED_WAIT_KEYS);
  expect(output).toMatchObject({
    status: 'completed', ankiBlockId: '', documentId: 'doc-done', cardsCount: 2, usableCards: 1,
    ankiConnect: null, limitReached: true, error: null, shouldRetry: false,
    workflowStatus: 'completed', finalStatus: 'completed', availableCards: 1,
  });
  const progress = output.progress as Record<string, unknown>;
  expect(Object.keys(progress)).toEqual([
    'counts', 'completedRatio', 'stage', 'messageKey', 'messageParams', 'cardsGenerated', 'lastUpdatedAt',
  ]);
  expect(progress).toMatchObject({
    counts: counts({ total: 2, completed: 1, cancelled: 1 }), completedRatio: 1, stage: 'completed', cardsGenerated: 1,
  });
  expect(toolEnds).toEqual([{ result: output, durationMs: 0 }]);
  expect(toolErrors).toEqual([]);

  const block = blockRow('blk-done');
  expect(block.status).toBe('success');
  expect(block.output).toMatchObject({ documentId: 'doc-done', cardsRefreshedFromDb: true });
  expect((block.output.cards as Array<{ id: string }>).map((card) => card.id).sort()).toEqual(['card-done-a', 'card-done-err']);
  expect(chunks.map((chunk) => chunk.blockId)).toEqual(['blk-done']);
});

it('W22 wait times out on a running document with the f32 completedRatio snapshot', async () => {
  addTask('doc-slow', 0, 'Completed');
  addTask('doc-slow', 1, 'Processing');
  addTask('doc-slow', 2, 'Processing');
  const pending = wait({ documentId: 'doc-slow', timeoutMs: 1000 });
  await advance(900);
  await advance(900);
  const result = await pending;
  expect(result.success).toBe(true);
  const output = result.output as Record<string, unknown>;
  expect(Object.keys(output)).toEqual(WAIT_KEYS);
  expect(output).toEqual({
    status: 'timeout', ankiBlockId: '', documentId: 'doc-slow', cardsCount: 0, usableCards: null,
    progress: { counts: counts({ total: 3, completed: 1, processing: 2 }), completedRatio: 0.33333334 },
    ankiConnect: null, limitReached: false, error: 'blocks.ankiCards.errors.waitTimeout', shouldRetry: true,
  });
});

it('W22 wait keeps polling a running document until its tasks finish', async () => {
  addTask('doc-poll', 0, 'Processing');
  addCard('doc-poll', 'card-poll');
  let settled = false;
  const pending = wait({ documentId: 'doc-poll' }).finally(() => { settled = true; });
  await advance(900);
  await advance(900);
  expect(settled).toBe(false);
  storage.database('mistakes').run("UPDATE document_tasks SET status = 'Completed' WHERE document_id = ?1", ['doc-poll']);
  await advance(900);
  const result = await pending;
  expect(result.output).toMatchObject({
    status: 'completed', documentId: 'doc-poll', cardsCount: 1, usableCards: 1, shouldRetry: false,
    progress: { counts: counts({ total: 1, completed: 1 }), completedRatio: 1 },
  });
});

it('W22 wait reports paused and maps ownership, invalid and parse failures like Rust', async () => {
  addTask('doc-paused', 0, 'Paused');
  const paused = await wait({ documentId: 'doc-paused' });
  expect(paused.success).toBe(true);
  expect(paused.output).toMatchObject({ status: 'paused', finalStatus: 'paused', shouldRetry: false });

  addTask('doc-foreign', 0, 'Completed', FOREIGN);
  const foreign = await wait({ documentId: ' doc-foreign ', timeoutMs: 5 });
  expect(foreign.success).toBe(false);
  expect(foreign.error).toBe('blocks.ankiCards.errors.statusNotFound');
  expect(Object.keys(foreign.output as object)).toEqual(EARLY_KEYS);
  expect(foreign.output).toEqual({
    status: 'not_found', ankiBlockId: '', documentId: ' doc-foreign ', cardsCount: 0, progress: null,
    ankiConnect: null, error: 'blocks.ankiCards.errors.statusNotFound', shouldRetry: true,
  });

  for (const args of [{}, { ankiBlockId: '  ', documentId: '' }, { documentId: null, timeoutMs: null }]) {
    const invalid = await wait(args);
    expect(invalid.success).toBe(false);
    expect(invalid.error).toBe('blocks.ankiCards.errors.waitInvalidArgs');
    expect(invalid.output).toEqual({
      status: 'invalid_args', ankiBlockId: '', documentId: null, cardsCount: 0, progress: null,
      ankiConnect: null, error: 'blocks.ankiCards.errors.waitInvalidArgs', shouldRetry: false,
    });
  }
  expect(toolErrors).toEqual([
    'blocks.ankiCards.errors.statusNotFound',
    ...Array.from({ length: 3 }, () => 'blocks.ankiCards.errors.waitInvalidArgs'),
  ]);

  const prefix = 'Invalid chatanki_wait arguments: ';
  const cases: Array<[unknown, string]> = [
    [{ documentId: 5 }, 'invalid type: number, expected a string'],
    [{ documentId: 'doc-paused', timeoutMs: -1 }, 'invalid number'],
    [{ documentId: 'doc-paused', timeoutMs: 1.5 }, 'invalid number'],
    [{ documentId: 'doc-paused', timeoutMs: '5' }, 'invalid type: string "5", expected u64'],
    [[], 'invalid length 0, expected struct ChatAnkiWaitArgs with 3 elements'],
    ['doc-paused', 'invalid type: string "doc-paused", expected struct ChatAnkiWaitArgs'],
  ];
  for (const [args, message] of cases) {
    const result = await wait(args);
    expect(result.success).toBe(false);
    expect(result.output).toBeNull();
    expect(result.error).toBe(`${prefix}${message}`);
  }
  const unknownIgnored = await wait({ documentId: 'doc-paused', note: 'serde ignores unknown wait fields' });
  expect(unknownIgnored.output).toMatchObject({ status: 'paused' });
  const positional = await wait([null, 'doc-paused', null]);
  expect(positional.output).toMatchObject({ status: 'paused', documentId: 'doc-paused' });
});

it('W22 wait on an anki block follows the owned block, its document and the block-side terminal rules', async () => {
  addTask('doc-blk', 0, 'Completed');
  addCard('doc-blk', 'card-blk');
  seedBlock('blk-owned', CALLER, 'success', {
    documentId: 'doc-blk', cards: [], progress: { stage: 'running', note: 'block' }, ankiConnect: { available: true },
  });
  const owned = await wait({ ankiBlockId: ' blk-owned ' });
  expect(owned.success).toBe(true);
  expect(owned.output).toMatchObject({
    status: 'completed', ankiBlockId: 'blk-owned', documentId: 'doc-blk', cardsCount: 0, usableCards: 1,
    ankiConnect: { available: true }, progress: { stage: 'completed', note: 'block' },
  });

  seedBlock('blk-error', CALLER, 'error', { cards: [{ id: 'x' }] }, 'boom');
  const errored = await wait({ ankiBlockId: 'blk-error' });
  expect(errored.success).toBe(true);
  expect(errored.output).toEqual({
    status: 'error', ankiBlockId: 'blk-error', documentId: null, cardsCount: 1, usableCards: null,
    progress: null, ankiConnect: null, limitReached: false, error: 'boom', shouldRetry: false,
  });

  seedBlock('blk-foreign', FOREIGN, 'success', { documentId: 'doc-blk' });
  const foreign = await wait({ ankiBlockId: 'blk-foreign' });
  expect(foreign.success).toBe(false);
  expect(foreign.error).toBe('blocks.ankiCards.errors.statusNotFound');
  expect(foreign.output).toEqual({
    status: 'not_found', ankiBlockId: 'blk-foreign', documentId: null, cardsCount: 0, usableCards: null,
    progress: null, ankiConnect: null, limitReached: false, error: 'blocks.ankiCards.errors.statusNotFound',
    shouldRetry: true,
  });

  addTask('doc-running', 0, 'Processing');
  const mismatch = await wait({ ankiBlockId: 'blk-owned', documentId: 'doc-running' });
  expect(mismatch.success).toBe(false);
  expect(mismatch.error).toBe('chatanki_wait_document_mismatch');
  expect(mismatch.output).toMatchObject({
    status: 'invalid_args', ankiBlockId: 'blk-owned', documentId: 'doc-running', shouldRetry: false,
    progress: { counts: counts({ total: 1, processing: 1 }), completedRatio: 0 },
  });

  cancelled = true;
  const stopped = await wait({ ankiBlockId: ' blk-owned ' });
  expect(stopped.success).toBe(true);
  expect(stopped.output).toEqual({
    status: 'cancelled', ankiBlockId: ' blk-owned ', documentId: null, cardsCount: 0, usableCards: null,
    progress: null, ankiConnect: null, limitReached: false, error: null, shouldRetry: false,
  });
});

it('W22 wait gives up on an undiscovered block after the grace window unless a short timeout ends first', async () => {
  const grace = wait({ ankiBlockId: 'blk-missing', timeoutMs: 0 });
  for (let step = 0; step < 9; step += 1) await advance(900);
  const notFound = await grace;
  expect(notFound.success).toBe(false);
  expect(notFound.error).toBe('blocks.ankiCards.errors.waitNotFound');
  expect(notFound.output).toMatchObject({ status: 'not_found', ankiBlockId: 'blk-missing', shouldRetry: true });

  const short = wait({ ankiBlockId: 'blk-missing', timeoutMs: 1000 });
  await advance(900);
  await advance(900);
  const timedOut = await short;
  expect(timedOut.success).toBe(true);
  expect(timedOut.output).toEqual({
    status: 'timeout', ankiBlockId: 'blk-missing', documentId: null, cardsCount: 0, usableCards: null,
    progress: null, ankiConnect: null, limitReached: false, error: 'blocks.ankiCards.errors.waitTimeout',
    shouldRetry: true,
  });
});
