import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import review from '../../review/index.ts';
import type { AnkiCard, FsrsAgentReviewStateSnapshot, ToolExecutionContext } from '../api.ts';
import { createChatAnkiExecutors } from '../api.ts';
import chatanki from '../index.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
const CREATED = '2026-08-24T00:00:00Z';
const CALLER = 'session-library-reader';
const FOREIGN = 'session-library-source';
const TOOL = 'builtin-chatanki_list_library_cards';
const events: unknown[] = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-library-list-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage,
      settings: createSettingsStore({
        db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
      }),
      llm: {}, vfs: {}, // unused; card, review, settings and UI providers are real
    },
  });
  host.ctx.backendEvents.listen('fsrs://changed', (value) => events.push(value));
}, 60_000);

beforeEach(() => {
  // Only this file's isolated migrated fixture, never a production database.
  const db = storage.database('mistakes');
  db.run('DELETE FROM fsrs_review_logs');
  db.run('DELETE FROM fsrs_card_states');
  db.run('DELETE FROM anki_cards');
  db.run('DELETE FROM document_tasks');
  events.length = 0;
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

function context(): ToolExecutionContext {
  return {
    sessionId: CALLER, messageId: 'message-library-list', blockId: 'block-library-list',
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined,
    emitToolCallError: () => undefined, saveToolBlock: () => undefined, warn: () => undefined,
  };
}

function run(args: unknown = {}) {
  return host.ctx.chatankiTools.execute({ id: 'call-library-list', name: TOOL, arguments: args }, context());
}

async function output(args: unknown = {}) {
  const result = await run(args);
  expect(result.success, result.error).toBe(true);
  return result.output as Record<string, unknown> & { cards: Array<Record<string, unknown>> };
}

it('AP0188 preserves all original normalization/default/rejection guarantees at the real tool entry', async () => {
  // Rust :15229-15268, the same original inputs (14 semantic guarantees).
  seed('normalized', { front: 'spaced query', template_id: 'design-swiss', is_error_card: true });
  const page = vi.spyOn(host.ctx.anki, 'listAnkiAgentLibraryPage'); // call-through observations only
  const states = vi.spyOn(host.ctx.review, 'getReviewStatesForLibrary');
  const normalized = await output({
    query: '  spaced query  ', templateId: '  design-swiss  ',
    schedule: 'not_enqueued', filter: 'error_only', page: 0, pageSize: 999,
  });
  expect(normalized.search).toBe('spaced query');
  expect(normalized.templateId).toBe('design-swiss');
  expect(normalized.schedule).toBe('not_enqueued');
  expect(normalized.filter).toBe('error_only');
  expect(normalized.page).toBe(1);
  expect(normalized.pageSize).toBe(20);
  expect(normalized.cards.map((card) => card.id)).toEqual(['normalized']);
  expect(page).toHaveBeenLastCalledWith({
    search: 'spaced query', templateId: 'design-swiss', schedule: 'not_enqueued',
    diagnostic: 'error_only', page: 1, pageSize: 20,
  });

  for (let index = 0; index < 25; index++) seed(`page-${String(index).padStart(2, '0')}`);
  const defaults = await output();
  expect(defaults.schedule).toBe('all');
  expect(defaults.filter).toBe('all');
  expect(defaults.page).toBe(1);
  expect(defaults.pageSize).toBe(20);
  expect(defaults.total).toBe(26n);
  expect(defaults.cards).toHaveLength(20); // catches inheriting the owner's default 12
  expect(defaults.search).toBeNull();
  expect(defaults.templateId).toBeNull();
  expect(page).toHaveBeenLastCalledWith({
    search: null, templateId: null, schedule: 'all', diagnostic: 'all', page: 1, pageSize: 20,
  });
  expect(states).toHaveBeenLastCalledWith('agent', defaults.cards.map((card) => card.id));
  expect(defaults.ratingAvailableToAgent).toBe(false);

  for (const invalid of [{ schedule: 'reviewed' }, { filter: 'edited_only' }]) {
    const calls = page.mock.calls.length;
    const reviewCalls = states.mock.calls.length;
    const rejected = await run(invalid);
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain('Invalid chatanki_list_library_cards arguments:');
    expect(page).toHaveBeenCalledTimes(calls);
    expect(states).toHaveBeenCalledTimes(reviewCalls);
  }
});

it('uses global diagnostic filtering and created DESC/id DESC before page boundaries', async () => {
  for (let index = 0; index < 25; index++) seed(`normal-${index}`);
  for (let index = 0; index < 3; index++) seed(`error-${index}`, { is_error_card: true });
  const first = await output({ filter: 'error_only', pageSize: 1 });
  expect(first.total).toBe(3n);
  expect(first.cards.map((card) => card.id)).toEqual(['error-2']);
  const second = await output({ filter: 'error_only', pageSize: 1, page: 2 });
  expect(second.total).toBe(3n);
  expect(second.cards.map((card) => card.id)).toEqual(['error-1']);
  storage.database('mistakes').run('UPDATE anki_cards SET created_at = ?1 WHERE id = ?2',
    ['2026-08-25T00:00:00Z', 'error-0']);
  expect((await output({ filter: 'error_only' })).cards.map((card) => card.id))
    .toEqual(['error-0', 'error-2', 'error-1']);
  const pastEnd = await output({ filter: 'error_only', page: 4, pageSize: 1 });
  expect(pastEnd).toMatchObject({ total: 3n, page: 4, pageSize: 1, cards: [] });
});

it('keeps new-state Due, Enqueued, NotEnqueued and Suspended separate from the UI list', async () => {
  for (const id of ['new', 'future', 'plain', 'suspended', 'state-deleted']) seed(id);
  host.ctx.review.enqueueCards(['new', 'future', 'suspended', 'state-deleted']);
  const db = storage.database('mistakes');
  db.run('UPDATE fsrs_card_states SET due_ms = 0');
  db.run("UPDATE fsrs_card_states SET due_ms = ?1 WHERE anki_card_id = 'future'", [(1n << 63n) - 1n]);
  db.run("UPDATE fsrs_card_states SET suspended = 1 WHERE anki_card_id = 'suspended'");
  db.run("UPDATE fsrs_card_states SET deleted_at = ?1 WHERE anki_card_id = 'state-deleted'", [CREATED]);
  expect((await output({ schedule: 'due' })).cards.map((card) => card.id)).toEqual(['new']);
  expect((await output({ schedule: 'enqueued' })).cards.map((card) => card.id))
    .toEqual(['suspended', 'new', 'future']);
  expect((await output({ schedule: 'not_enqueued' })).cards.map((card) => card.id))
    .toEqual(['state-deleted', 'plain']);
  expect((await output({ schedule: 'suspended' })).cards.map((card) => card.id)).toEqual(['suspended']);
});

it('projects real locator/content/review versions, truncation and false rating availability without extra lookups', async () => {
  const card = seed('projection', { front: 'x'.repeat(2001) });
  host.ctx.review.enqueueCards([card.id]);
  const state = host.ctx.review.getReviewStatesForLibrary('agent', [card.id])[0]!;
  const rated = await host.invoke<{ logId: string }>('fsrs_rate', { cardStateId: state.cardStateId, rating: 3, durationMs: 80 });
  storage.database('mistakes').run('UPDATE fsrs_card_states SET local_version = ?1, due_ms = 0 WHERE anki_card_id = ?2', [17n, card.id]);
  storage.database('mistakes').run('UPDATE anki_cards SET source_id = ?1, source_type = ?2 WHERE id = ?3',
    ['not-the-document', 'document', card.id]);
  const lookup = vi.spyOn(host.ctx.anki.cards, 'getCardWithDocument');
  const tasks = vi.spyOn(host.ctx.anki.documents, 'getTasksForDocument');
  const view = (await output()).cards[0]!;
  expect(view.documentId).toBe('doc-projection');
  expect(view.version).toBe(card.updated_at);
  expect(view.updatedAt).toBe(card.updated_at);
  expect((view.reviewState as FsrsAgentReviewStateSnapshot).reviewVersion).toBe(17n);
  expect((view.reviewState as FsrsAgentReviewStateSnapshot).latestReview?.logId).toBe(rated.logId);
  expect(view.enqueued).toBe(true);
  expect(view.isDue).toBe(true);
  expect(view.truncated).toBe(true);
  expect(view.truncatedFields).toContain('front');
  expect(view.ratingAvailableToAgent).toBe(false);
  expect([...(view.front as string)]).toHaveLength(2000);
  expect(view.sourceId).toBe('not-the-document');
  expect(view.sourceType).toBe('document');
  expect(lookup).not.toHaveBeenCalled();
  expect(tasks).not.toHaveBeenCalled();
});

it('retains bigint page counts, owner due i64 and exact review versions without exposing extra source fields', async () => {
  seed('exact');
  host.ctx.review.enqueueCards(['exact']);
  const exact = 9007199254740993n;
  storage.database('mistakes').run('UPDATE fsrs_card_states SET due_ms = ?1, local_version = ?1 WHERE anki_card_id = ?2', [exact, 'exact']);
  const page = vi.spyOn(host.ctx.anki, 'listAnkiAgentLibraryPage');
  const result = await output();
  expect(result.total).toBe(1n);
  expect(page.mock.results[0]?.value.items[0].libraryCard.dueMs).toBe(exact);
  expect((result.cards[0]!.reviewState as FsrsAgentReviewStateSnapshot).reviewVersion).toBe(exact);
  expect(Object.hasOwn(result.cards[0]!, 'dueMs')).toBe(false); // Rust exposes reviewState, not a new flat dueMs
  expect(Object.hasOwn(result.cards[0]!, 'sourceSessionId')).toBe(false);
  expect(Object.hasOwn(result.cards[0]!, 'sourceRef')).toBe(false);
});

it('reads foreign/null provenance but never widens session update/delete permission or emits mutation events', async () => {
  const foreign = seed('foreign');
  const noSession = seed('no-session', {}, null);
  const result = await output();
  expect(result.cards.map((card) => card.id)).toEqual(['no-session', 'foreign']);
  expect(result.cards.map((card) => card.documentId)).toEqual(['doc-no-session', 'doc-foreign']);
  expect(result.cards.every((card) => card.reviewState === null && card.ratingAvailableToAgent === false)).toBe(true);
  const before = events.length;
  for (const card of [foreign, noSession]) {
    for (const [name, args] of [
      ['chatanki_update_card', { cardId: card.id, expectedVersion: card.updated_at, patch: { front: 'forbidden' } }],
      ['chatanki_delete_card', { cardId: card.id, expectedVersion: card.updated_at, expectedReviewVersion: null }],
    ] as const) {
      const denied = await host.ctx.chatankiTools.execute({ id: `denied-${name}`, name, arguments: args }, context());
      expect(denied.success).toBe(false);
      expect(denied.error).toContain('statusNotFound');
      expect(host.ctx.anki.cards.getCardWithDocument(card.id)?.card).toEqual(card);
    }
  }
  expect(events).toHaveLength(before);
});

it('rejects parser errors before real SQL failures, and list failures before any review call', async () => {
  seed('fault');
  const db = storage.database('mistakes');
  const page = vi.spyOn(host.ctx.anki, 'listAnkiAgentLibraryPage');
  const states = vi.spyOn(host.ctx.review, 'getReviewStatesForLibrary');
  db.run('ALTER TABLE anki_cards RENAME TO unavailable_library_cards');
  try {
    const invalid = await run({ schedule: 'reviewed' });
    expect(invalid.success).toBe(false);
    expect(invalid.error).toContain('Invalid chatanki_list_library_cards arguments:');
    expect(page).not.toHaveBeenCalled();
    const failed = await run();
    expect(failed.success).toBe(false);
    expect(failed.error).toBe('Failed to list Anki library cards: no such table: anki_cards');
    expect(states).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  } finally { db.run('ALTER TABLE unavailable_library_cards RENAME TO anki_cards'); }
});

it('preserves the real structured review Database AppError after a successful list', async () => {
  seed('review-fault');
  host.ctx.review.enqueueCards(['review-fault']);
  const db = storage.database('mistakes');
  const page = vi.spyOn(host.ctx.anki, 'listAnkiAgentLibraryPage');
  db.run('ALTER TABLE fsrs_review_logs RENAME TO unavailable_review_logs');
  try {
    const result = await run();
    expect(page.mock.results[0]?.type).toBe('return');
    expect(result.success).toBe(false);
    const error = (result.output as { error: { error_type: string; message: string } }).error;
    expect(error.error_type).toBe('Database');
    expect(error.message).toContain('no such table: fsrs_review_logs');
    expect(result.error).toBe(error.message);
    expect(events).toEqual([]);
  } finally { db.run('ALTER TABLE unavailable_review_logs RENAME TO fsrs_review_logs'); }
});

it('keeps review NotFound as AppError when a genuine competing deletion occurs after page selection', async () => {
  const card = seed('competing-delete');
  const list = host.ctx.anki.listAnkiAgentLibraryPage.bind(host.ctx.anki);
  // Execute the real page read, then a real competing public-owner write. No
  // replacement rows, fabricated errors or review provider doubles.
  vi.spyOn(host.ctx.anki, 'listAnkiAgentLibraryPage').mockImplementation((request, nowMs) => {
    const page = list(request, nowMs);
    expect(host.ctx.anki.cards.deleteCardForSession(card.id, card.updated_at, null, FOREIGN).kind).toBe('deleted');
    return page;
  });
  const result = await run();
  expect(result.success).toBe(false);
  expect(result.output).toMatchObject({ error: { error_type: 'NotFound', message: `anki card not found: ${card.id}` } });
  expect(result.error).toBe(`anki card not found: ${card.id}`);
});

it('publishes only the implemented library list in the real roster with low sensitivity', () => {
  expect(host.ctx.chatankiTools.canHandle(TOOL)).toBe(true);
  const executor = createChatAnkiExecutors().find((candidate) => candidate.canHandle(TOOL));
  expect(executor).toBeDefined();
  expect(executor?.sensitivityLevel(TOOL)).toBe('low');
  expect(executor?.canHandle('chatanki_update_library_card')).toBe(false);
  const writer = createChatAnkiExecutors({ libraryCardRead: () => true })
    .find((candidate) => candidate.canHandle('chatanki_update_library_card'));
  expect(writer?.constructor).not.toBe(executor?.constructor);
  expect(writer?.sensitivityLevel('chatanki_update_library_card')).toBe('high');
  // The writer is claimed exactly when the published L16 carries getAnkiAgentLibraryCard.
  expect(host.ctx.chatankiTools.canHandle('chatanki_update_library_card'))
    .toBe(typeof (host.ctx.anki as { getAnkiAgentLibraryCard?: unknown }).getAnkiAgentLibraryCard === 'function');
});

// Exact from_value errors, not from_str line/column/path errors. The locked
// serde_json 1.0.149 features preserve object visit order and Number Unexpected.
const UNKNOWN_LIBRARY_FIELD = 'unknown field `extra`, expected one of `query`, `search`, `templateId`, `schedule`, `filter`, `page`, `pageSize`';
const UNKNOWN_SCHEDULE = 'unknown variant `reviewed`, expected one of `all`, `due`, `not_enqueued`, `suspended`, `enqueued`';

it.each([
  [{ query: 'first', search: 'second' }, 'duplicate field `search`'],
  [{ search: null, query: 'second' }, 'duplicate field `search`'],
  [{ search: 'first', query: 7 }, 'duplicate field `search`'],
  [{ query: 7, search: 'second' }, 'invalid type: number, expected a string'],
  [{ query: 7, schedule: 'reviewed', extra: null }, 'invalid type: number, expected a string'],
  [{ schedule: 'reviewed', query: 7, extra: null }, UNKNOWN_SCHEDULE],
  [{ extra: null, query: 7, schedule: 'reviewed' }, UNKNOWN_LIBRARY_FIELD],
] as const)('AP0188 serde visits aliases/fields in input order: %j', async (args, detail) => {
  const page = vi.spyOn(host.ctx.anki, 'listAnkiAgentLibraryPage');
  const states = vi.spyOn(host.ctx.review, 'getReviewStatesForLibrary');
  const result = await run(args);
  expect(result.success).toBe(false);
  expect(result.error).toBe(`Invalid chatanki_list_library_cards arguments: ${detail}`);
  expect(page).not.toHaveBeenCalled();
  expect(states).not.toHaveBeenCalled();
});

it.each([
  { schedule: { all: null }, filter: { all: null } },
  [null, null, { all: null }, { all: null }, null, null],
])('AP0188 serde accepts unit-enum maps and the full six-slot positional form: %j', async (args) => {
  const page = vi.spyOn(host.ctx.anki, 'listAnkiAgentLibraryPage');
  const result = await output(args);
  expect(result).toMatchObject({
    status: 'ok', search: null, templateId: null, schedule: 'all', filter: 'all',
    page: 1, pageSize: 20, total: 0n, cards: [], ratingAvailableToAgent: false,
  });
  expect(page).toHaveBeenCalledExactlyOnceWith({
    search: null, templateId: null, schedule: 'all', diagnostic: 'all', page: 1, pageSize: 20,
  });
});

it('AP0188 serde normalizes all six positional fields before the real owner query', async () => {
  seed('positional', { front: 'spaced query', template_id: 'design-swiss', is_error_card: true });
  const result = await output([
    '  spaced query  ', '  design-swiss  ', { not_enqueued: null }, { error_only: null }, 0, 999,
  ]);
  expect(result).toMatchObject({
    search: 'spaced query', templateId: 'design-swiss', schedule: 'not_enqueued', filter: 'error_only',
    page: 1, pageSize: 20, total: 1n, cards: [{ id: 'positional' }],
  });
});

it.each([
  [[], 'invalid length 0, expected struct ChatAnkiListLibraryCardsArgs with 6 elements'],
  // The middle enum fields have serde(default); missing Option page still
  // fails at slot 4. Do not replace this with an upfront array-length check.
  [[null, null], 'invalid length 4, expected struct ChatAnkiListLibraryCardsArgs with 6 elements'],
  [[null, null, 'all', 'all', 1], 'invalid length 5, expected struct ChatAnkiListLibraryCardsArgs with 6 elements'],
  [[7, null, 'reviewed', 'all', null, null, 7], 'invalid type: number, expected a string'],
  [[null, null, 'reviewed'], UNKNOWN_SCHEDULE],
  [[null, null, 'all', 'all', null, null, 7], 'invalid length 7, expected fewer elements in array'],
  [{ schedule: null }, 'invalid type: null, expected string or map'],
  [{ schedule: { due: false } }, 'invalid type: boolean `false`, expected unit'],
  [{ schedule: { reviewed: 7 } }, UNKNOWN_SCHEDULE],
  [{ filter: { all: null, error_only: null } }, 'invalid value: map, expected map with a single key'],
  [{ filter: {} }, 'invalid value: map, expected map with a single key'],
  [{ filter: 'edited_only' }, 'unknown variant `edited_only`, expected `all` or `error_only`'],
  [{ page: -1 }, 'invalid number'],
  [{ page: '1' }, 'invalid type: string "1", expected u32'],
] as const)('AP0188 serde rejects malformed positional/enum/width values with the first from_value error: %j', async (args, detail) => {
  const page = vi.spyOn(host.ctx.anki, 'listAnkiAgentLibraryPage');
  const result = await run(args);
  expect(result.success).toBe(false);
  expect(result.error).toBe(`Invalid chatanki_list_library_cards arguments: ${detail}`);
  expect(page).not.toHaveBeenCalled();
});

it('library list duration includes info/start work after the initial monotonic timestamp', async () => {
  let clock = 1_000;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const lifecycle: string[] = [];
  const result = await host.ctx.chatankiTools.execute({
    id: 'call-library-timing', name: TOOL, arguments: { schedule: 'reviewed' },
  }, {
    ...context(),
    info: () => { lifecycle.push('info'); clock += 40; },
    emitToolCallStart: () => { lifecycle.push('start'); clock += 60; },
    emitToolCallError: () => { lifecycle.push('error'); },
  });
  expect(result.success).toBe(false);
  expect(lifecycle).toEqual(['info', 'start', 'error']);
  expect(result.durationMs).toBe(100);
});
