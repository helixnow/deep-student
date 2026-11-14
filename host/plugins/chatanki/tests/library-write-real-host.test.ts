/**
 * W22 library-scope write tools through the production chain:
 * `chatankiTools.execute` → hydrate (`ctx.get('review')` / `ctx.get('anki')`) →
 * real L15/L16 writes on an isolated migrated mistakes DB → real L04 blocks.
 * Rust reference: chatanki_executor.rs:3656–4205 and :12057–12094.
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
import type {
  AnkiCard, ChatAnkiLibraryCardRecord, ChatAnkiLibraryCardStore, ToolExecutionContext, ToolResultInfo,
} from '../api.ts';
import { createChatAnkiExecutors } from '../api.ts';
import chatanki from '../index.ts';
import { convertBackendCard } from '../src/block-patch.ts';
import { ChatAnkiLibraryMutationExecutor } from '../src/library-mutation-executor.ts';
import { ChatAnkiLibraryReviewExecutor } from '../src/library-review-executor.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
const CREATED = '2026-08-24T00:00:00Z';
const CALLER = 'session-library-writer';
const FOREIGN = 'session-library-owner';
const RUN_ID = 'run-library-write';
const events: Array<Record<string, unknown>> = [];
const warnings: string[] = [];
const chunks: Array<{ blockId: string; patch: Record<string, unknown> }> = [];
const NOT_FOUND_TEXT = 'blocks.ankiCards.errors.statusNotFound: no live card task found for the given id under this session;';
const DB_UNAVAILABLE_TEXT = 'blocks.ankiCards.errors.databaseUnavailable: the card database is currently unavailable;';

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-library-write-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      llm: {}, vfs: {}, // unused; card, review, block and event owners are real
    },
  });
  host.ctx.backendEvents.listen('fsrs://changed', (value) => events.push(value as Record<string, unknown>));
  // L16 does not publish Rust `get_anki_agent_library_card` yet (handoff to W10).
  // Until it does, the real service object carries the same-row read below so the
  // update/delete tests still run through the production hydrate path.
  const ankiService = host.ctx.anki as unknown as ChatAnkiLibraryCardStore;
  if (typeof ankiService.getAnkiAgentLibraryCard !== 'function') {
    Object.defineProperty(ankiService, 'getAnkiAgentLibraryCard', {
      value: ownerLibraryCardRead, configurable: true, writable: true,
    });
  }
}, 60_000);

beforeEach(() => {
  // Only this file's isolated migrated fixture, never a production database.
  const db = storage.database('mistakes');
  db.run('DELETE FROM fsrs_review_logs');
  db.run('DELETE FROM fsrs_card_states');
  db.run('DELETE FROM anki_cards');
  db.run('DELETE FROM document_tasks');
  events.length = 0;
  warnings.length = 0;
  chunks.length = 0;
});
afterEach(() => { vi.restoreAllMocks(); });
afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

function seed(id: string, patch: Partial<AnkiCard> = {}, session: string | null = FOREIGN): AnkiCard {
  const taskId = `task-${id}`;
  const documentId = `doc-${id}`;
  host.ctx.anki.documents.insertDocumentTask({
    id: taskId, document_id: documentId, original_document_name: 'library.md',
    segment_index: 0, content_segment: 'material', status: 'Completed',
    created_at: CREATED, updated_at: CREATED, error_message: null, anki_generation_options_json: '{}',
  });
  if (session !== null) host.ctx.anki.documents.setDocumentSessionSource(documentId, session);
  const card: AnkiCard = {
    id, task_id: taskId, front: `front ${id}`, back: 'answer', text: null,
    tags: [], images: [], is_error_card: false, error_content: null,
    created_at: CREATED, updated_at: CREATED, extra_fields: {}, template_id: null, ...patch,
  };
  expect(host.ctx.anki.cards.insertCard(card)).toBe(true);
  return card;
}

function enqueue(id: string) {
  expect(host.ctx.review.enqueueCards([id]).enqueued).toBe(1);
  return libraryState(id)!;
}

function libraryState(id: string) {
  return host.ctx.review.getReviewStatesForLibrary('agent', [id])[0] ?? null;
}

function context(): ToolExecutionContext {
  return {
    sessionId: CALLER, messageId: 'message-library-write', blockId: 'block-library-write', runId: RUN_ID,
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined, saveToolBlock: () => undefined,
    emitChunk: (blockId, patch) => { chunks.push({ blockId, patch }); },
    warn: (message) => { warnings.push(message); },
  };
}

function run(name: string, args: unknown): Promise<ToolResultInfo> {
  return host.ctx.chatankiTools.execute({ id: `call-${name}`, name: `builtin-${name}`, arguments: args }, context());
}

async function output(name: string, args: unknown): Promise<Record<string, unknown>> {
  const result = await run(name, args);
  expect(result.success, result.error).toBe(true);
  return result.output as Record<string, unknown>;
}

function liveStateCount(ids: readonly string[]): number {
  const placeholders = ids.map((_, index) => `?${index + 1}`).join(', ');
  return storage.database('mistakes').pluck<number>(
    `SELECT COUNT(*) FROM fsrs_card_states WHERE deleted_at IS NULL AND anki_card_id IN (${placeholders})`, [...ids]) ?? 0;
}

interface LibraryRow {
  id: string; task_id: string; front: string | null; back: string | null; text: string | null;
  tags_json: string | null; images_json: string | null; is_error_card: number; error_content: string | null;
  created_at: string; updated_at: string; extra_fields_json: string; template_id: string | null;
  source_type: string | null; source_id: string | null; state_id: string | null; state: number | null;
  due_ms: number | null; suspended: number; enqueued: number; is_due: number;
  document_id: string; source_session_id: string | null;
}

function nonBlank(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value;
}

/** Rust `get_anki_agent_library_card` (database/mod.rs:5330-5341, row read :279-362). */
function ownerLibraryCardRead(cardId: string): ChatAnkiLibraryCardRecord | null {
  const trimmed = cardId.trim();
  if (trimmed === '') throw new Error('cardId is required');
  const row = storage.database('mistakes').get<LibraryRow>(
    `SELECT
       ac.id AS id, ac.task_id AS task_id, ac.front AS front, ac.back AS back, ac.text AS text,
       ac.tags_json AS tags_json, ac.images_json AS images_json, ac.is_error_card AS is_error_card,
       ac.error_content AS error_content, ac.created_at AS created_at, ac.updated_at AS updated_at,
       COALESCE(ac.extra_fields_json, '{}') AS extra_fields_json, ac.template_id AS template_id,
       ac.source_type AS source_type, ac.source_id AS source_id,
       fs.id AS state_id, fs.state AS state, fs.due_ms AS due_ms, COALESCE(fs.suspended, 0) AS suspended,
       CASE WHEN fs.id IS NULL THEN 0 ELSE 1 END AS enqueued,
       CASE WHEN fs.id IS NOT NULL AND COALESCE(fs.suspended, 0) = 0 AND fs.due_ms <= ?2
            THEN 1 ELSE 0 END AS is_due,
       dt.document_id AS document_id, dt.source_session_id AS source_session_id
     FROM anki_cards ac
     INNER JOIN document_tasks dt ON dt.id = ac.task_id
     LEFT JOIN fsrs_card_states fs ON fs.anki_card_id = ac.id AND fs.deleted_at IS NULL
     WHERE ac.id = ?1 AND ac.deleted_at IS NULL AND dt.deleted_at IS NULL`,
    [trimmed, Date.now()],
  );
  if (row === undefined) return null;
  return {
    libraryCard: {
      id: row.id, task_id: row.task_id, front: row.front ?? '', back: row.back ?? '', text: row.text,
      tags: JSON.parse(row.tags_json ?? '[]') as string[], images: JSON.parse(row.images_json ?? '[]') as string[],
      is_error_card: row.is_error_card !== 0, error_content: row.error_content,
      created_at: row.created_at, updated_at: row.updated_at,
      extra_fields: JSON.parse(row.extra_fields_json) as Record<string, string>, template_id: row.template_id,
      sourceType: nonBlank(row.source_type), sourceId: nonBlank(row.source_id),
      sourceSessionId: nonBlank(row.source_session_id), sourceRef: null,
      stateId: row.state_id, state: row.state, dueMs: row.due_ms,
      suspended: row.suspended !== 0, enqueued: row.enqueued !== 0, isDue: row.is_due !== 0,
    },
    locator: { documentId: row.document_id, sourceSessionId: row.source_session_id },
  };
}

/** A persisted `anki_cards` block owned by `sessionId` that shows `cards` for `documentId`. */
function seedSourceBlock(sessionId: string, documentId: string, cards: readonly AnkiCard[]): string {
  const db = storage.database('chat_v2');
  const blockId = `blk-${documentId}`;
  const messageId = `msg-${documentId}`;
  db.run(`INSERT OR IGNORE INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', 'active', ?2, ?2)`, [sessionId, CREATED]);
  db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
    VALUES (?1, ?2, 'assistant', ?3, ?4)`, [messageId, sessionId, JSON.stringify([blockId]), Date.now()]);
  db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, tool_name, started_at, tool_output_json)
    VALUES (?1, ?2, 'anki_cards', 'success', 0, 'chatanki_run', ?3, ?4)`,
  [blockId, messageId, Date.now(), JSON.stringify({ documentId, cards: cards.map(convertBackendCard) })]);
  return blockId;
}

function blockOutput(blockId: string): Record<string, unknown> {
  const json = storage.database('chat_v2').pluck<string>(
    'SELECT tool_output_json FROM chat_v2_blocks WHERE id = ?1', [blockId]);
  return JSON.parse(json!) as Record<string, unknown>;
}

function cardRow(id: string) {
  return storage.database('mistakes').get<{ front: string; updated_at: string; extra_fields_json: string; deleted_at: string | null }>(
    'SELECT front, updated_at, extra_fields_json, deleted_at FROM anki_cards WHERE id = ?1', [id]);
}

// ---------------------------------------------------------------------------
// chatanki_enqueue_library_review (Rust :3812–3950)
// ---------------------------------------------------------------------------

it('W22 enqueue_library_review enqueues foreign-session cards and projects fresh library review states', async () => {
  seed('enq-a');
  seed('enq-b', {}, null);
  const first = await output('chatanki_enqueue_library_review', {
    cards: [{ cardId: ' enq-a ', expectedVersion: ` ${CREATED} ` }, { cardId: 'enq-b', expectedVersion: CREATED }],
  });
  const states = host.ctx.review.getReviewStatesForLibrary('agent', ['enq-a', 'enq-b']);
  expect(states).toHaveLength(2);
  expect(Object.keys(first)).toEqual(['status', 'enqueued', 'skipped', 'cards', 'mutationApplied', 'retryable', 'reviewStateUnavailable']);
  expect(first).toEqual({
    status: 'ok', enqueued: 2, skipped: 0,
    cards: [{ cardId: 'enq-a', reviewState: states[0] }, { cardId: 'enq-b', reviewState: states[1] }],
    mutationApplied: true, retryable: false, reviewStateUnavailable: false,
  });
  expect((first.cards as Array<Record<string, unknown>>).map((card) => Object.keys(card)))
    .toEqual([['cardId', 'reviewState'], ['cardId', 'reviewState']]);
  expect(liveStateCount(['enq-a', 'enq-b'])).toBe(2);
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({
    source: 'agent', action: 'enqueue', entityIds: ['enq-a', 'enq-b'],
    cardStateIds: states.map((state) => state.cardStateId), runId: RUN_ID,
  });

  const again = await output('chatanki_enqueue_library_review', {
    cards: [{ cardId: 'enq-a', expectedVersion: CREATED }],
  });
  expect(again).toEqual({
    status: 'ok', enqueued: 0, skipped: 1, cards: [{ cardId: 'enq-a', reviewState: states[0] }],
    mutationApplied: false, retryable: false, reviewStateUnavailable: false,
  });
  expect(events).toHaveLength(1); // no newly enqueued state → no fsrs://changed
});

it('W22 enqueue_library_review returns conflict, not_found and blocked as structured non-mutations', async () => {
  seed('enq-stale');
  seed('enq-diag', { is_error_card: true, error_content: 'diagnostic' });

  const conflict = await output('chatanki_enqueue_library_review', {
    cards: [{ cardId: 'enq-stale', expectedVersion: 'stale-version' }],
  });
  expect(Object.keys(conflict)).toEqual(['status', 'error', 'conflicts', 'mutationApplied', 'retryable', 'guidance']);
  expect(conflict).toEqual({
    status: 'conflict', error: 'version_conflict',
    conflicts: [{ cardId: 'enq-stale', expectedVersion: 'stale-version', currentVersion: CREATED }],
    mutationApplied: false, retryable: true,
    guidance: 'Call builtin-chatanki_list_library_cards to refresh content versions before retrying.',
  });

  const missing = await output('chatanki_enqueue_library_review', {
    cards: [{ cardId: 'enq-missing', expectedVersion: CREATED }],
  });
  expect(Object.keys(missing)).toEqual(['status', 'error', 'cardIds', 'mutationApplied', 'retryable', 'guidance']);
  expect(missing).toEqual({
    status: 'not_found', error: 'card_not_found', cardIds: ['enq-missing'],
    mutationApplied: false, retryable: true,
    guidance: 'Call builtin-chatanki_list_library_cards to refresh the live card set before retrying.',
  });

  const blocked = await output('chatanki_enqueue_library_review', {
    cards: [{ cardId: 'enq-diag', expectedVersion: CREATED }],
  });
  expect(Object.keys(blocked)).toEqual(['status', 'error', 'cardIds', 'mutationApplied', 'retryable']);
  expect(blocked).toEqual({
    status: 'blocked', error: 'diagnostic_card', cardIds: ['enq-diag'], mutationApplied: false, retryable: false,
  });
  expect(liveStateCount(['enq-stale', 'enq-diag'])).toBe(0);
  expect(events).toHaveLength(0);
});

it('W22 enqueue_library_review keeps the committed enqueue and reports partial when the refresh fails', async () => {
  seed('enq-partial');
  vi.spyOn(host.ctx.review, 'getReviewStatesForLibrary').mockImplementation(() => { throw new Error('refresh boom'); });
  const partial = await output('chatanki_enqueue_library_review', {
    cards: [{ cardId: 'enq-partial', expectedVersion: CREATED }],
  });
  expect(partial).toEqual({
    status: 'partial', enqueued: 1, skipped: 0, cards: [{ cardId: 'enq-partial', reviewStateUnavailable: true }],
    mutationApplied: true, retryable: false, reviewStateUnavailable: true,
  });
  expect(liveStateCount(['enq-partial'])).toBe(1);
  expect(warnings).toContain('[ChatAnkiToolExecutor] Failed to refresh library review states after enqueue: refresh boom');
});

it('W22 enqueue_library_review rejects arguments with the Rust serde and normalize texts before any write', async () => {
  seed('enq-pos');
  const write = vi.spyOn(host.ctx.review, 'enqueueCardsForLibrary');
  const prefix = 'Invalid chatanki_enqueue_library_review arguments: ';
  const cases: Array<[unknown, string]> = [
    [{}, 'missing field `cards`'],
    [null, 'invalid type: null, expected struct ChatAnkiEnqueueLibraryReviewArgs'],
    [{ cards: [], extra: 1 }, 'unknown field `extra`, expected `cards`'],
    [{ cards: 'enq-pos' }, 'invalid type: string "enq-pos", expected a sequence'],
    [{ cards: [{ cardId: 'a', expectedVersion: 'v', note: 1 }] }, 'unknown field `note`, expected `cardId` or `expectedVersion`'],
    [{ cards: [{ cardId: 7, expectedVersion: 'v' }] }, 'invalid type: number, expected a string'],
    [{ cards: [{ cardId: 'a' }] }, 'missing field `expectedVersion`'],
    [{ cards: [] }, 'cards must contain 1 to 100 entries'],
    [{ cards: Array.from({ length: 101 }, (_, index) => ({ cardId: `c${index}`, expectedVersion: 'v' })) }, 'cards must contain 1 to 100 entries'],
    [{ cards: [{ cardId: '  ', expectedVersion: 'v' }] }, 'every card requires cardId and expectedVersion'],
    [{ cards: [{ cardId: 'a', expectedVersion: 'v' }, { cardId: ' a ', expectedVersion: 'v' }] }, 'cards must not contain duplicate cardId values'],
    [[], 'invalid length 0, expected struct ChatAnkiEnqueueLibraryReviewArgs with 1 element'],
  ];
  for (const [args, message] of cases) {
    const result = await run('chatanki_enqueue_library_review', args);
    expect(result.success).toBe(false);
    expect(result.error).toBe(`${prefix}${message}`);
  }
  expect(write).not.toHaveBeenCalled();

  // serde's positional struct form is accepted at both levels.
  const positional = await output('chatanki_enqueue_library_review', [[['enq-pos', CREATED]]]);
  expect(positional.enqueued).toBe(1);
  expect(write).toHaveBeenCalledWith('agent', [{ cardId: 'enq-pos', expectedContentVersion: CREATED }]);
});

// ---------------------------------------------------------------------------
// chatanki_set_library_suspended / chatanki_undo_library_last_review
// (Rust :3952–4057, finish_library_agent_review_mutation :12057–12094)
// ---------------------------------------------------------------------------

it('W22 set_library_suspended writes the foreign-session review state and emits one agent review event', async () => {
  seed('sus-a');
  const before = enqueue('sus-a');
  const suspended = await output('chatanki_set_library_suspended', {
    cardId: ' sus-a ', expectedReviewVersion: Number(before.reviewVersion), suspended: true,
  });
  const after = libraryState('sus-a')!;
  expect(after.suspended).toBe(true);
  expect(after.reviewVersion).toBe(before.reviewVersion + 1n);
  expect(Object.keys(suspended)).toEqual(['status', 'cardId', 'changed', 'mutationApplied', 'retryable', 'reviewState']);
  expect(suspended).toEqual({
    status: 'ok', cardId: 'sus-a', changed: true, mutationApplied: true, retryable: false, reviewState: after,
  });
  expect(storage.database('mistakes').pluck<number>(
    'SELECT suspended FROM fsrs_card_states WHERE anki_card_id = ?1 AND deleted_at IS NULL', ['sus-a'])).toBe(1);
  expect(events).toEqual([{
    source: 'agent', action: 'set_suspended', entityIds: ['sus-a'],
    cardStateIds: [after.cardStateId], cards: [after], runId: RUN_ID,
  }]);

  const unchanged = await output('chatanki_set_library_suspended', {
    cardId: 'sus-a', expectedReviewVersion: Number(after.reviewVersion), suspended: true,
  });
  expect(unchanged).toEqual({
    status: 'ok', cardId: 'sus-a', changed: false, mutationApplied: false, retryable: false, reviewState: after,
  });
  expect(events).toHaveLength(1);

  const stale = await output('chatanki_set_library_suspended', {
    cardId: 'sus-a', expectedReviewVersion: Number(before.reviewVersion), suspended: false,
  });
  expect(Object.keys(stale)).toEqual(['status', 'error', 'cardId', 'current', 'mutationApplied', 'retryable', 'guidance']);
  expect(stale).toEqual({
    status: 'conflict', error: 'review_state_conflict', cardId: 'sus-a', current: after,
    mutationApplied: false, retryable: true,
    guidance: 'Call builtin-chatanki_list_library_cards to refresh reviewState before retrying.',
  });
  expect(libraryState('sus-a')).toEqual(after);
  expect(events).toHaveLength(1);
});

it('W22 set_library_suspended maps blocked, not-enqueued and argument failures like Rust', async () => {
  seed('sus-diag');
  const diag = enqueue('sus-diag');
  storage.database('mistakes').run('UPDATE anki_cards SET is_error_card = 1 WHERE id = ?1', ['sus-diag']);
  const blocked = await output('chatanki_set_library_suspended', {
    cardId: 'sus-diag', expectedReviewVersion: Number(diag.reviewVersion), suspended: true,
  });
  expect(Object.keys(blocked)).toEqual(['status', 'error', 'cardId', 'current', 'mutationApplied', 'retryable']);
  expect(blocked).toMatchObject({ status: 'blocked', error: 'diagnostic_card', cardId: 'sus-diag', mutationApplied: false, retryable: false });

  seed('sus-plain');
  const notEnqueued = await run('chatanki_set_library_suspended', { cardId: 'sus-plain', expectedReviewVersion: 0, suspended: true });
  expect(notEnqueued.success).toBe(false);
  expect(notEnqueued.error?.startsWith(NOT_FOUND_TEXT)).toBe(true);

  const write = vi.spyOn(host.ctx.review, 'setSuspendedForLibrary');
  const prefix = 'Invalid chatanki_set_library_suspended arguments: ';
  const cases: Array<[unknown, string]> = [
    [{ cardId: 'sus-plain', expectedReviewVersion: -1, suspended: true }, 'cardId and a non-negative expectedReviewVersion are required'],
    [{ cardId: ' ', expectedReviewVersion: 1, suspended: true }, 'cardId and a non-negative expectedReviewVersion are required'],
    [{ cardId: 'sus-plain', expectedReviewVersion: 1.5, suspended: true }, 'invalid number'],
    [{ cardId: 'sus-plain', expectedReviewVersion: 2 ** 63, suspended: true }, 'invalid number'],
    [{ cardId: 'sus-plain', expectedReviewVersion: '3', suspended: true }, 'invalid type: string "3", expected i64'],
    [{ cardId: 'sus-plain', expectedReviewVersion: 1, suspended: 'yes' }, 'invalid type: string "yes", expected a boolean'],
    [{ cardId: 'sus-plain', expectedReviewVersion: 1 }, 'missing field `suspended`'],
    [{ cardId: 'sus-plain', expectedReviewVersion: 1, suspended: true, reason: 'x' },
      'unknown field `reason`, expected one of `cardId`, `expectedReviewVersion`, `suspended`'],
    [{ cardId: 'sus-plain', cardId_: 1 }, 'unknown field `cardId_`, expected one of `cardId`, `expectedReviewVersion`, `suspended`'],
  ];
  for (const [args, message] of cases) {
    const result = await run('chatanki_set_library_suspended', args);
    expect(result.success).toBe(false);
    expect(result.error).toBe(`${prefix}${message}`);
  }
  expect(write).not.toHaveBeenCalled();
});

it('W22 undo_library_last_review restores the rated foreign-session card and rejects a stale log id', async () => {
  seed('undo-a');
  const enqueued = enqueue('undo-a');
  const rated = await host.invoke<{ logId: string }>('fsrs_rate', {
    cardStateId: enqueued.cardStateId, rating: 3, durationMs: 500,
  });
  const ratedState = libraryState('undo-a')!;
  expect(ratedState.latestReview?.logId).toBe(rated.logId);
  // fsrs_rate emits its own source=user events (some after the command resolves).
  const agentEvents = () => events.filter((event) => event.source === 'agent');

  const stale = await output('chatanki_undo_library_last_review', {
    cardId: 'undo-a', expectedReviewVersion: Number(ratedState.reviewVersion), expectedLogId: 'log-other',
  });
  expect(stale).toEqual({
    status: 'conflict', error: 'review_state_conflict', cardId: 'undo-a', current: ratedState,
    mutationApplied: false, retryable: true,
    guidance: 'Call builtin-chatanki_list_library_cards to refresh reviewState before retrying.',
  });
  expect(agentEvents()).toHaveLength(0);

  const undone = await output('chatanki_undo_library_last_review', {
    cardId: ' undo-a ', expectedReviewVersion: Number(ratedState.reviewVersion), expectedLogId: ` ${rated.logId} `,
  });
  const restored = libraryState('undo-a')!;
  expect(restored.reviewVersion).toBe(ratedState.reviewVersion + 1n);
  expect(restored.latestReview).toBeNull();
  expect(undone).toEqual({
    status: 'ok', cardId: 'undo-a', changed: true, mutationApplied: true, retryable: false, reviewState: restored,
  });
  expect(agentEvents()).toEqual([{
    source: 'agent', action: 'undo_last_review', entityIds: ['undo-a'],
    cardStateIds: [restored.cardStateId], cards: [restored], runId: RUN_ID,
  }]);

  const prefix = 'Invalid chatanki_undo_library_last_review arguments: ';
  for (const [args, message] of [
    [{ cardId: 'undo-a', expectedReviewVersion: 1 }, 'missing field `expectedLogId`'],
    [{ cardId: 'undo-a', expectedReviewVersion: 1, expectedLogId: '  ' }, 'cardId, non-negative expectedReviewVersion, and expectedLogId are required'],
    [{ cardId: 'undo-a', expectedReviewVersion: null, expectedLogId: 'log' }, 'invalid type: null, expected i64'],
  ] as Array<[unknown, string]>) {
    const result = await run('chatanki_undo_library_last_review', args);
    expect(result.error).toBe(`${prefix}${message}`);
  }
});

it('W22 library review tools fail closed without the L15 review owner', async () => {
  const executor = createChatAnkiExecutors().find((candidate) => candidate.canHandle('chatanki_set_library_suspended'))!;
  expect(executor).toBeInstanceOf(ChatAnkiLibraryReviewExecutor);
  expect(executor.name()).toBe('ChatAnkiLibraryReviewExecutor');
  const call = { id: 'call-no-review', name: 'chatanki_set_library_suspended', arguments: { cardId: 'x', expectedReviewVersion: 1, suspended: true } };
  const absent = await executor.execute(call, context());
  expect(absent.success).toBe(false);
  expect(absent.error?.startsWith(DB_UNAVAILABLE_TEXT)).toBe(true);
  const partial = await executor.execute(call, { ...context(), libraryReviews: {} });
  expect(partial.error).toBe('chatanki_set_library_suspended requires the L15 review service (setSuspendedForLibrary)');
  const enqueueCall = { ...call, name: 'chatanki_enqueue_library_review', arguments: { cards: [{ cardId: 'x', expectedVersion: 'v' }] } };
  const noRefresh = await executor.execute(enqueueCall, {
    ...context(), libraryReviews: { enqueueCardsForLibrary: () => { throw new Error('must not write'); } },
  });
  expect(noRefresh.error).toBe('chatanki_enqueue_library_review requires the L15 review service (getReviewStatesForLibrary)');
});

// ---------------------------------------------------------------------------
// chatanki_update_library_card / chatanki_delete_library_card
// (Rust :3656–3810, :4059–4205, review load :12303–12368, UI sync :13395–13410)
// ---------------------------------------------------------------------------

const LIBRARY_CARD_KEYS = [
  'id', 'index', 'front', 'back', 'text', 'tags', 'templateId', 'extraFields', 'isErrorCard', 'errorContent',
  'updatedAt', 'version', 'truncated', 'truncatedFields', 'documentId', 'sourceType', 'sourceId', 'enqueued',
  'isDue', 'reviewState', 'ratingAvailableToAgent',
];
const LIBRARY_CONFLICT_KEYS = [
  'status', 'error', 'cardId', 'current', 'mutationApplied', 'retryable', 'reviewStateUnavailable', 'guidance',
];
const LIBRARY_CONFLICT_GUIDANCE = 'Call builtin-chatanki_list_library_cards to refresh content and review versions before retrying.';

function projectedLibraryCard(id: string, reviewState: unknown): Record<string, unknown> {
  const record = ownerLibraryCardRead(id)!;
  const card = record.libraryCard;
  return {
    id: card.id, index: null, front: card.front, back: card.back, text: card.text, tags: card.tags,
    templateId: card.template_id, extraFields: card.extra_fields, isErrorCard: card.is_error_card,
    errorContent: card.error_content, updatedAt: card.updated_at, version: card.updated_at,
    truncated: false, truncatedFields: [], documentId: record.locator.documentId,
    sourceType: card.sourceType, sourceId: card.sourceId, enqueued: card.enqueued, isDue: card.isDue,
    reviewState, ratingAvailableToAgent: false,
  };
}

function unavailableLibraryCard(id: string): Record<string, unknown> {
  const card = projectedLibraryCard(id, null);
  delete card.reviewState;
  card.reviewStateUnavailable = true;
  return card;
}

function runWith(name: string, args: unknown, overrides: Partial<ToolExecutionContext>): Promise<ToolResultInfo> {
  return host.ctx.chatankiTools.execute(
    { id: `call-${name}`, name: `builtin-${name}`, arguments: args }, { ...context(), ...overrides });
}

function failingReviewRefresh(): void {
  vi.spyOn(host.ctx.review, 'getReviewStatesForLibrary').mockImplementation(() => { throw new Error('refresh boom'); });
}

it('W22 update_library_card rewrites a foreign-session card, stamps user provenance and syncs the owning block', async () => {
  const card = seed('upd-a', { extra_fields: { Note: 'kept', _content_provenance: '{"actor":"user","code":"forged"}' } });
  const blockId = seedSourceBlock(FOREIGN, 'doc-upd-a', [card]);
  enqueue('upd-a');
  const updated = await output('chatanki_update_library_card', {
    cardId: ' upd-a ', expectedVersion: ` ${CREATED} `, patch: { front: 'edited front', tags: ['t1'] },
  });

  const row = cardRow('upd-a')!;
  expect(row.front).toBe('edited front');
  expect(row.updated_at).not.toBe(CREATED);
  const extras = JSON.parse(row.extra_fields_json) as Record<string, string>;
  expect(extras.Note).toBe('kept');
  const provenance = JSON.parse(extras._content_provenance!) as Record<string, unknown>;
  expect(Object.keys(provenance)).toEqual(['actor', 'code', 'at']);
  expect(provenance).toMatchObject({ actor: 'user', code: 'chatanki_update_library_card' });
  expect(provenance.at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/);

  expect(Object.keys(updated)).toEqual([
    'status', 'documentId', 'card', 'mutationApplied', 'retryable', 'reviewStateUnavailable', 'uiSync',
  ]);
  expect(updated).toEqual({
    status: 'ok', documentId: 'doc-upd-a', card: projectedLibraryCard('upd-a', libraryState('upd-a')),
    mutationApplied: true, retryable: false, reviewStateUnavailable: false,
    uiSync: { status: 'ok', blockId, eventAttempted: true },
  });
  expect(Object.keys(updated.card as object)).toEqual(LIBRARY_CARD_KEYS);

  const backend = convertBackendCard(ownerLibraryCardRead('upd-a')!.libraryCard);
  expect(blockOutput(blockId)).toMatchObject({ documentId: 'doc-upd-a', cards: [backend], deletedCardIds: [] });
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.blockId).toBe(blockId);
  expect(chunks[0]!.patch).toMatchObject({ documentId: 'doc-upd-a', cardMutation: 'upsert', cards: [backend] });
  expect(events).toEqual([{ source: 'agent', action: 'card_updated', entityIds: ['upd-a'], runId: RUN_ID, cards: [backend] }]);
});

it('W22 update_library_card reports a not_required UI sync without a source session or owning block', async () => {
  seed('upd-orphan', {}, null);
  const orphan = await output('chatanki_update_library_card', {
    cardId: 'upd-orphan', expectedVersion: CREATED, patch: { back: 'new back' },
  });
  expect(orphan).toEqual({
    status: 'ok', documentId: 'doc-upd-orphan', card: projectedLibraryCard('upd-orphan', null),
    mutationApplied: true, retryable: false, reviewStateUnavailable: false,
    uiSync: { status: 'not_required', eventAttempted: false },
  });
  expect(cardRow('upd-orphan')!.front).toBe('front upd-orphan');

  seed('upd-noblock');
  const noBlock = await output('chatanki_update_library_card', {
    cardId: 'upd-noblock', expectedVersion: CREATED, patch: { text: 'cloze {{c1::text}}' },
  });
  expect(noBlock).toMatchObject({ status: 'ok', uiSync: { status: 'not_required', eventAttempted: false } });
  expect(chunks).toHaveLength(0);
  expect(events.map((event) => event.entityIds)).toEqual([['upd-orphan'], ['upd-noblock']]);
});

it('W22 update_library_card maps conflict, not found, invalid content, preflight and argument failures', async () => {
  seed('upd-stale');
  const conflict = await output('chatanki_update_library_card', {
    cardId: 'upd-stale', expectedVersion: 'stale-version', patch: { front: 'lost' },
  });
  expect(Object.keys(conflict)).toEqual(LIBRARY_CONFLICT_KEYS);
  expect(conflict).toEqual({
    status: 'conflict', error: 'version_conflict', cardId: 'upd-stale', current: projectedLibraryCard('upd-stale', null),
    mutationApplied: false, retryable: true, reviewStateUnavailable: false, guidance: LIBRARY_CONFLICT_GUIDANCE,
  });
  expect(cardRow('upd-stale')!.front).toBe('front upd-stale');

  const write = vi.spyOn(host.ctx.anki, 'updateAnkiCardIfVersionForLibrary');
  const missing = await run('chatanki_update_library_card', { cardId: 'upd-missing', expectedVersion: CREATED, patch: { front: 'x' } });
  expect(missing.success).toBe(false);
  expect(missing.error?.startsWith(NOT_FOUND_TEXT)).toBe(true);
  const empty = await run('chatanki_update_library_card', { cardId: 'upd-stale', expectedVersion: CREATED, patch: { front: '  ' } });
  expect(empty.error?.startsWith('blocks.ankiCards.errors.cardContentRequired: ')).toBe(true);
  const preflight = await runWith('chatanki_update_library_card', {
    cardId: 'upd-stale', expectedVersion: CREATED, patch: { front: 'x' },
  }, {
    chatBlocks: {
      listSessionBlocks: () => { throw new Error('blocks boom'); },
      getBlock: () => null, updateBlock: () => undefined, upsertBlock: () => undefined,
    },
  });
  expect(preflight.error).toBe('Unable to prepare library card UI synchronization: blocks boom');

  const prefix = 'Invalid chatanki_update_library_card arguments: ';
  const cases: Array<[unknown, string]> = [
    [{ cardId: 'upd-stale', expectedVersion: CREATED }, 'missing field `patch`'],
    [{ cardId: 'upd-stale', expectedVersion: CREATED, patch: {} }, 'cardId, expectedVersion, and a non-empty patch are required'],
    [{ cardId: ' ', expectedVersion: CREATED, patch: { front: 'x' } }, 'cardId, expectedVersion, and a non-empty patch are required'],
    [{ cardId: 'upd-stale', expectedVersion: CREATED, patch: { front: 'x', note: 1 } },
      'unknown field `note`, expected one of `front`, `back`, `text`, `tags`, `extraFields`, `extra_fields`'],
    [{ cardId: 'upd-stale', expectedVersion: CREATED, patch: { tags: 'x' } }, 'invalid type: string "x", expected a sequence'],
    [{ cardId: 'upd-stale', expectedVersion: CREATED, patch: { front: 'x' }, documentId: 'd' },
      'unknown field `documentId`, expected one of `cardId`, `expectedVersion`, `patch`'],
    ['upd-stale', 'invalid type: string "upd-stale", expected struct ChatAnkiUpdateLibraryCardArgs'],
  ];
  for (const [args, message] of cases) {
    const result = await run('chatanki_update_library_card', args);
    expect(result.success).toBe(false);
    expect(result.error).toBe(`${prefix}${message}`);
  }
  expect(write).not.toHaveBeenCalled();
  expect(events).toHaveLength(0);
});

it('W22 update_library_card keeps the committed write and reports partial when the review refresh fails', async () => {
  seed('upd-partial', {}, null);
  enqueue('upd-partial');
  failingReviewRefresh();
  const partial = await output('chatanki_update_library_card', {
    cardId: 'upd-partial', expectedVersion: CREATED, patch: { front: 'partial front' },
  });
  expect(cardRow('upd-partial')!.front).toBe('partial front');
  expect(partial).toEqual({
    status: 'partial', documentId: 'doc-upd-partial', card: unavailableLibraryCard('upd-partial'),
    mutationApplied: true, retryable: false, reviewStateUnavailable: true,
    uiSync: { status: 'not_required', eventAttempted: false },
  });
  expect(Object.keys(partial.card as object))
    .toEqual([...LIBRARY_CARD_KEYS.filter((key) => key !== 'reviewState'), 'reviewStateUnavailable']);

  const conflict = await output('chatanki_update_library_card', {
    cardId: 'upd-partial', expectedVersion: CREATED, patch: { front: 'stale write' },
  });
  expect(conflict).toEqual({
    status: 'conflict', error: 'version_conflict', cardId: 'upd-partial', current: unavailableLibraryCard('upd-partial'),
    mutationApplied: false, retryable: true, reviewStateUnavailable: true, guidance: LIBRARY_CONFLICT_GUIDANCE,
  });
  expect(warnings).toEqual([
    '[ChatAnkiToolExecutor] Failed to refresh library review state after update_library_card for upd-partial: refresh boom',
    '[ChatAnkiToolExecutor] Failed to refresh library review state after update_library_card_conflict for upd-partial: refresh boom',
  ]);
});

it('W22 delete_library_card deletes an enqueued foreign-session card under both CAS versions and syncs the owning block', async () => {
  const card = seed('del-a');
  const sibling: AnkiCard = { ...card, id: 'del-a-sibling', front: 'sibling' };
  expect(host.ctx.anki.cards.insertCard(sibling)).toBe(true);
  const blockId = seedSourceBlock(FOREIGN, 'doc-del-a', [card, sibling]);
  const state = enqueue('del-a');
  const deleted = await output('chatanki_delete_library_card', {
    cardId: ' del-a ', expectedVersion: ` ${CREATED} `, expectedReviewVersion: Number(state.reviewVersion),
  });
  expect(Object.keys(deleted)).toEqual(['status', 'documentId', 'cardId', 'deleted', 'mutationApplied', 'retryable', 'uiSync']);
  expect(deleted).toEqual({
    status: 'ok', documentId: 'doc-del-a', cardId: 'del-a', deleted: true, mutationApplied: true, retryable: false,
    uiSync: { status: 'ok', blockId, eventAttempted: true },
  });
  expect(ownerLibraryCardRead('del-a')).toBeNull();
  expect(ownerLibraryCardRead('del-a-sibling')).not.toBeNull();
  expect(liveStateCount(['del-a'])).toBe(0);
  expect(blockOutput(blockId)).toMatchObject({
    documentId: 'doc-del-a', cards: [convertBackendCard(sibling)], deletedCardIds: ['del-a'],
  });
  expect(chunks).toHaveLength(1);
  expect(chunks[0]!.blockId).toBe(blockId);
  expect(chunks[0]!.patch).toMatchObject({ documentId: 'doc-del-a', cardMutation: 'delete', deletedCardIds: ['del-a'] });
  expect(events).toEqual([{ source: 'agent', action: 'card_deleted', entityIds: ['del-a'], runId: RUN_ID }]);
});

it('W22 delete_library_card returns content and review conflicts with a freshly loaded review state', async () => {
  seed('del-c', {}, null);
  const state = enqueue('del-c');
  const content = await output('chatanki_delete_library_card', {
    cardId: 'del-c', expectedVersion: 'stale-version', expectedReviewVersion: Number(state.reviewVersion),
  });
  expect(Object.keys(content)).toEqual(LIBRARY_CONFLICT_KEYS);
  expect(content).toEqual({
    status: 'conflict', error: 'version_conflict', cardId: 'del-c', current: projectedLibraryCard('del-c', state),
    mutationApplied: false, retryable: true, reviewStateUnavailable: false, guidance: LIBRARY_CONFLICT_GUIDANCE,
  });
  const review = await output('chatanki_delete_library_card', {
    cardId: 'del-c', expectedVersion: CREATED, expectedReviewVersion: null,
  });
  expect(review).toEqual({ ...content, error: 'review_state_conflict' });
  const staleReview = await output('chatanki_delete_library_card', {
    cardId: 'del-c', expectedVersion: CREATED, expectedReviewVersion: Number(state.reviewVersion) + 1,
  });
  expect(staleReview).toEqual({ ...content, error: 'review_state_conflict' });
  expect(ownerLibraryCardRead('del-c')).not.toBeNull();
  expect(liveStateCount(['del-c'])).toBe(1);
  expect(events).toHaveLength(0);

  failingReviewRefresh();
  const contentUnavailable = await output('chatanki_delete_library_card', {
    cardId: 'del-c', expectedVersion: 'stale-version', expectedReviewVersion: Number(state.reviewVersion),
  });
  const reviewUnavailable = await output('chatanki_delete_library_card', {
    cardId: 'del-c', expectedVersion: CREATED, expectedReviewVersion: null,
  });
  const unavailable = {
    status: 'conflict', cardId: 'del-c', current: unavailableLibraryCard('del-c'),
    mutationApplied: false, retryable: true, reviewStateUnavailable: true, guidance: LIBRARY_CONFLICT_GUIDANCE,
  };
  expect(contentUnavailable).toEqual({ ...unavailable, error: 'version_conflict' });
  expect(reviewUnavailable).toEqual({ ...unavailable, error: 'review_state_conflict' });
  expect(warnings).toEqual([
    '[ChatAnkiToolExecutor] Failed to refresh library review state after delete_library_card_content_conflict for del-c: refresh boom',
    '[ChatAnkiToolExecutor] Failed to refresh library review state after delete_library_card_review_conflict for del-c: refresh boom',
  ]);
});

it('W22 delete_library_card maps not found and argument failures like Rust before any write', async () => {
  seed('del-args', {}, null);
  const missing = await run('chatanki_delete_library_card', { cardId: 'del-missing', expectedVersion: CREATED, expectedReviewVersion: null });
  expect(missing.success).toBe(false);
  expect(missing.error?.startsWith(NOT_FOUND_TEXT)).toBe(true);

  const write = vi.spyOn(host.ctx.anki, 'deleteAnkiCardForLibrary');
  const prefix = 'Invalid chatanki_delete_library_card arguments: ';
  const cases: Array<[unknown, string]> = [
    [{ cardId: 'del-args', expectedVersion: CREATED }, 'expectedReviewVersion is required; use null to assert the card is not enqueued'],
    [{ cardId: 'del-args', expectedVersion: CREATED, expectedReviewVersion: -1 }, 'expectedReviewVersion must be null or non-negative'],
    [{ cardId: 'del-args', expectedVersion: ' ', expectedReviewVersion: null }, 'cardId and expectedVersion are required'],
    [{ cardId: 'del-args', expectedVersion: CREATED, expectedReviewVersion: 1.5 }, 'invalid number'],
    [{ cardId: 'del-args', expectedVersion: CREATED, expectedReviewVersion: '1' }, 'invalid type: string "1", expected i64'],
    [{ cardId: 'del-args', expectedReviewVersion: null }, 'missing field `expectedVersion`'],
    [{ cardId: 'del-args', expectedVersion: CREATED, expectedReviewVersion: null, force: true },
      'unknown field `force`, expected one of `cardId`, `expectedVersion`, `expectedReviewVersion`'],
  ];
  for (const [args, message] of cases) {
    const result = await run('chatanki_delete_library_card', args);
    expect(result.success).toBe(false);
    expect(result.error).toBe(`${prefix}${message}`);
  }
  expect(write).not.toHaveBeenCalled();
  expect(ownerLibraryCardRead('del-args')).not.toBeNull();

  const deleted = await output('chatanki_delete_library_card', {
    cardId: 'del-args', expectedVersion: CREATED, expectedReviewVersion: null,
  });
  expect(deleted).toMatchObject({ status: 'ok', deleted: true, uiSync: { status: 'not_required', eventAttempted: false } });
  expect(write).toHaveBeenCalledWith('del-args', CREATED, null);
  expect(ownerLibraryCardRead('del-args')).toBeNull();
});

it('W22 library content tools fail closed without the L16 library card owner and surface owner errors', async () => {
  const executor = createChatAnkiExecutors({ libraryCardRead: () => true })
    .find((candidate) => candidate.canHandle('chatanki_update_library_card'))!;
  expect(executor).toBeInstanceOf(ChatAnkiLibraryMutationExecutor);
  expect(executor.name()).toBe('ChatAnkiLibraryMutationExecutor');
  expect(executor.canHandle('builtin-chatanki_delete_library_card')).toBe(true);
  const update = {
    id: 'call-no-owner', name: 'chatanki_update_library_card',
    arguments: { cardId: 'lib-x', expectedVersion: 'v1', patch: { front: 'f' } },
  };
  const remove = {
    ...update, name: 'chatanki_delete_library_card',
    arguments: { cardId: 'lib-x', expectedVersion: 'v1', expectedReviewVersion: null },
  };
  const absent = await executor.execute(update, context());
  expect(absent.error?.startsWith(DB_UNAVAILABLE_TEXT)).toBe(true);
  expect((await executor.execute(update, { ...context(), libraryCardStore: {} })).error)
    .toBe('chatanki_update_library_card requires the L16 library card owner (getAnkiAgentLibraryCard, updateAnkiCardIfVersionForLibrary)');

  const writeBoom = () => { throw new Error('write boom'); };
  const writesOnly: ChatAnkiLibraryCardStore = {
    updateAnkiCardIfVersionForLibrary: writeBoom, deleteAnkiCardForLibrary: writeBoom,
  };
  expect((await executor.execute(update, { ...context(), libraryCardStore: writesOnly })).error)
    .toBe('chatanki_update_library_card requires the L16 library card owner (getAnkiAgentLibraryCard)');
  expect((await executor.execute(remove, { ...context(), libraryCardStore: writesOnly })).error)
    .toBe('chatanki_delete_library_card requires the L16 library card owner (getAnkiAgentLibraryCard)');

  const readBoom: ChatAnkiLibraryCardStore = { ...writesOnly, getAnkiAgentLibraryCard: () => { throw new Error('read boom'); } };
  expect((await executor.execute(update, { ...context(), libraryCardStore: readBoom })).error).toBe('Failed to load library card: read boom');
  expect((await executor.execute(remove, { ...context(), libraryCardStore: readBoom })).error).toBe('Failed to load library card: read boom');

  const record: ChatAnkiLibraryCardRecord = {
    libraryCard: {
      id: 'lib-x', task_id: 'task-x', front: 'f0', back: 'b0', text: null, tags: [], images: [],
      is_error_card: false, error_content: null, created_at: CREATED, updated_at: 'v1', extra_fields: {}, template_id: null,
      sourceType: null, sourceId: null, sourceSessionId: null, sourceRef: null,
      stateId: null, state: null, dueMs: null, suspended: false, enqueued: false, isDue: false,
    },
    locator: { documentId: 'doc-x', sourceSessionId: null },
  };
  const readable: ChatAnkiLibraryCardStore = { ...writesOnly, getAnkiAgentLibraryCard: () => record };
  expect((await executor.execute(update, { ...context(), libraryCardStore: readable })).error).toBe('Failed to update library card: write boom');
  expect((await executor.execute(remove, { ...context(), libraryCardStore: readable })).error).toBe('Failed to delete library card: write boom');
  expect(events).toHaveLength(0);
});
