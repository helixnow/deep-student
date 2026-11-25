/**
 * W22 chatanki_sync through the production chain (`chatankiTools.execute` / L04 registry →
 * hydrate → L16 AnkiConnect sync + receipts facade) on isolated migrated DBs. Rust reference:
 * chatanki_executor.rs:6141–6482 and :14225–14301. Only the AnkiConnect network boundary
 * (port probe + fetch) is replaced; the L16 sync, receipts and L04 blocks are real.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentSkills from '../../agent-skills/index.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import type { ToolExecutor } from '../../chat/api.ts';
import review from '../../review/index.ts';
import type { AnkiCard, ToolExecutionContext, ToolResultInfo } from '../api.ts';
import chatanki from '../index.ts';
import { STATUS_NOT_FOUND_MESSAGE } from '../src/card-access.ts';
import { humanizeChatAnkiError } from '../src/errors.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let settings: ReturnType<typeof createSettingsStore>;
let host: TestHost;
const CREATED = '2026-11-07T00:00:00Z';
const CALLER = 'session-sync-caller';
const FOREIGN = 'session-sync-foreign';
const OUTPUT_KEYS = [
  'status', 'documentId', 'deckName', 'noteType', 'total', 'added', 'duplicates', 'failed',
  'createdModels', 'receiptWritten', 'error', 'warning',
];
const toolEnds: unknown[] = [];
const toolErrors: string[] = [];
const chunks: Array<{ blockId: string; patch: Record<string, unknown> }> = [];
const warnings: string[] = [];
const infos: string[] = [];

type Reply = { result: unknown; error: string | null };
let requests: Array<{ action: string; params: Record<string, unknown> }> = [];

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-sync-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  settings = createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  });
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, agentSkills, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage, settings,
      llm: {}, vfs: {},
    },
  });
}, 60_000);

beforeEach(() => {
  toolEnds.length = 0;
  toolErrors.length = 0;
  chunks.length = 0;
  warnings.length = 0;
  infos.length = 0;
  requests = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
afterAll(async () => {
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

/** AnkiConnect on 127.0.0.1:8765: the port probe connects and every POST is answered by `reply`. */
function ankiConnect(reply: (action: string, params: Record<string, unknown>) => Reply): void {
  vi.spyOn(net, 'connect').mockImplementation((() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = () => socket;
    setImmediate(() => socket.emit('connect'));
    return socket;
  }) as typeof net.connect);
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response('');
    const request = JSON.parse(String(init.body)) as { action: string; params?: Record<string, unknown> };
    const params = request.params ?? {};
    requests.push({ action: request.action, params });
    return new Response(JSON.stringify(reply(request.action, params)));
  });
}

/** A healthy AnkiConnect v6; `added` decides the `addNotes` ids, `canAdd` the precheck. */
function healthy(options: {
  fields?: string[]; canAdd?: (index: number) => boolean; added?: (index: number) => number | null;
} = {}): void {
  ankiConnect((action, params) => {
    const notes = (params.notes ?? []) as unknown[];
    switch (action) {
      case 'version': return { result: 6, error: null };
      case 'createDeck': return { result: 1, error: null };
      case 'modelNames': return { result: [], error: null };
      case 'createModel': return { result: {}, error: null };
      case 'modelFieldNames': return { result: options.fields ?? ['Front', 'Back'], error: null };
      case 'canAddNotes': return { result: notes.map((_note, index) => options.canAdd?.(index) ?? true), error: null };
      case 'addNotes': {
        const added = options.added ?? ((index: number) => 9000 + index);
        return { result: notes.map((_note, index) => added(index)), error: null };
      }
      default: return { result: null, error: `unexpected action ${action}` };
    }
  });
}

function actions(): string[] {
  return requests.map((request) => request.action);
}

function noteModels(): string[] {
  const add = requests.find((request) => request.action === 'addNotes');
  return ((add?.params.notes ?? []) as Array<{ modelName: string }>).map((note) => note.modelName);
}

function addDocument(documentId: string, session = CALLER): string {
  const taskId = `task-${documentId}`;
  host.ctx.anki.documents.insertDocumentTask({
    id: taskId, document_id: documentId, original_document_name: 'sync.md',
    segment_index: 0, content_segment: 'material', status: 'Completed',
    created_at: CREATED, updated_at: CREATED, error_message: null, anki_generation_options_json: '{}',
  });
  host.ctx.anki.documents.setDocumentSessionSource(documentId, session);
  return taskId;
}

function addCard(taskId: string, id: string, patch: Partial<AnkiCard> = {}): void {
  expect(host.ctx.anki.cards.insertCard({
    id, task_id: taskId, front: `front ${id}`, back: `back ${id}`, text: null,
    tags: [], images: [], is_error_card: false, error_content: null,
    created_at: CREATED, updated_at: CREATED, extra_fields: {}, template_id: null, ...patch,
  })).toBe(true);
}

function seedBlock(blockId: string, sessionId: string, toolOutput: unknown): void {
  const db = storage.database('chat_v2');
  db.run(`INSERT OR IGNORE INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', 'active', ?2, ?2)`, [sessionId, CREATED]);
  db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
    VALUES (?1, ?2, 'assistant', ?3, ?4)`, [`msg-${blockId}`, sessionId, JSON.stringify([blockId]), Date.now()]);
  db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, tool_name, started_at, tool_output_json)
    VALUES (?1, ?2, 'anki_cards', 'success', 0, 'chatanki_run', ?3, ?4)`,
  [blockId, `msg-${blockId}`, Date.now(), JSON.stringify(toolOutput)]);
}

function blockOutput(blockId: string): Record<string, unknown> {
  const row = storage.database('chat_v2').get<{ tool_output_json: string }>(
    'SELECT tool_output_json FROM chat_v2_blocks WHERE id = ?1', [blockId])!;
  return JSON.parse(row.tool_output_json) as Record<string, unknown>;
}

function receipts(documentId: string) {
  return storage.database('mistakes').all<{ id: string; anki_note_id: number | null; export_status: string | null }>(
    `SELECT c.id, c.anki_note_id, c.export_status FROM anki_cards c JOIN document_tasks t ON t.id = c.task_id
     WHERE t.document_id = ?1 ORDER BY c.id`, [documentId]);
}

function context(): ToolExecutionContext {
  return {
    sessionId: CALLER, messageId: 'message-sync', blockId: 'block-sync-call',
    emitToolCallStart: () => undefined,
    emitToolCallEnd: (payload) => { toolEnds.push(payload); },
    emitToolCallError: (error) => { toolErrors.push(error); },
    saveToolBlock: () => undefined,
    emitChunk: (blockId, patch) => { chunks.push({ blockId, patch }); },
    warn: (message) => { warnings.push(message); },
    info: (message) => { infos.push(message); },
  };
}

function sync(args: unknown): Promise<ToolResultInfo> {
  return host.ctx.chatankiTools.execute({ id: 'call-sync', name: 'builtin-chatanki_sync', arguments: args }, context());
}

it('W22 sync pushes the usable cards, writes export receipts and marks the owned anki_cards block synced', async () => {
  const task = addDocument('doc-ok');
  addCard(task, 'ok-1');
  addCard(task, 'ok-2');
  addCard(task, 'ok-err', { is_error_card: true, error_content: 'broken' });
  seedBlock('blk-ok', CALLER, {
    documentId: 'doc-ok', cards: [], syncError: 'previous failure', syncStatus: 'error', note: 'kept',
  });
  healthy();

  const result = await sync({ documentId: 'doc-ok', deckName: ' Deck A ', noteType: ' Basic ' });
  expect(result.success, result.error ?? undefined).toBe(true);
  expect(Object.keys(result.output as object)).toEqual(OUTPUT_KEYS);
  expect(result.output).toEqual({
    status: 'ok', documentId: 'doc-ok', deckName: 'Deck A', noteType: 'Basic', total: 2, added: 2,
    duplicates: 0, failed: 0, createdModels: [], receiptWritten: 2, error: null, warning: null,
  });
  expect(actions()).toEqual(['version', 'createDeck', 'version', 'modelFieldNames', 'canAddNotes', 'addNotes']);
  expect(requests[1]!.params).toEqual({ deck: 'Deck A' });
  expect(noteModels()).toEqual(['Basic', 'Basic']);
  expect(receipts('doc-ok')).toEqual([
    { id: 'ok-1', anki_note_id: 9000, export_status: 'synced' },
    { id: 'ok-2', anki_note_id: 9001, export_status: 'synced' },
    { id: 'ok-err', anki_note_id: null, export_status: null },
  ]);
  expect(infos).toContain('[ChatAnkiToolExecutor] export receipt written for 2 cards');

  // serde_json `Map::remove` under preserve_order swaps the last key into `syncError`'s slot.
  const block = blockOutput('blk-ok');
  expect(Object.keys(block)).toEqual(['documentId', 'cards', 'note', 'syncStatus']);
  expect(block).toEqual({ documentId: 'doc-ok', cards: [], note: 'kept', syncStatus: 'synced' });
  expect(chunks).toEqual([{ blockId: 'blk-ok', patch: { syncStatus: 'synced', syncError: null } }]);
  expect(toolEnds).toEqual([{ result: result.output, durationMs: expect.any(Number) }]);
  expect(toolErrors).toEqual([]);
});

it('W22 sync status: duplicates only is ok without receipts, a partial push warns, nothing landed is the raw error key', async () => {
  const dupTask = addDocument('doc-dup');
  addCard(dupTask, 'dup-1');
  addCard(dupTask, 'dup-2');
  healthy({ canAdd: () => false });
  const dup = await sync({ documentId: 'doc-dup' });
  expect(dup.success).toBe(true);
  expect(dup.output).toMatchObject({ status: 'ok', total: 2, added: 0, duplicates: 2, failed: 0, receiptWritten: 0 });
  expect(actions()).not.toContain('addNotes');
  expect(receipts('doc-dup').map((row) => row.export_status)).toEqual([null, null]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  requests = [];
  const partTask = addDocument('doc-part');
  addCard(partTask, 'part-1');
  addCard(partTask, 'part-2');
  seedBlock('blk-part', CALLER, { documentId: 'doc-part', cards: [] });
  healthy({ added: (index) => (index === 0 ? 9100 : null) });
  const partial = await sync({ documentId: 'doc-part' });
  expect(partial.success).toBe(true);
  expect(partial.output).toEqual({
    status: 'partial', documentId: 'doc-part', deckName: 'Default', noteType: 'Basic', total: 2, added: 1,
    duplicates: 0, failed: 1, createdModels: [], receiptWritten: 1, error: null,
    warning: { code: 'anki_sync_partial', details: { total: 2, added: 1, duplicates: 0, failed: 1 } },
  });
  expect(receipts('doc-part')).toEqual([
    { id: 'part-1', anki_note_id: 9100, export_status: 'synced' },
    { id: 'part-2', anki_note_id: null, export_status: null },
  ]);
  expect(blockOutput('blk-part')).toEqual({ documentId: 'doc-part', cards: [], syncStatus: 'synced' });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  requests = [];
  chunks.length = 0;
  const failTask = addDocument('doc-fail');
  addCard(failTask, 'fail-1');
  seedBlock('blk-fail', CALLER, { documentId: 'doc-fail', cards: [] });
  healthy({ added: () => null });
  const failed = await sync({ documentId: 'doc-fail' });
  const expectedSyncEmpty = humanizeChatAnkiError('blocks.ankiCards.errors.ankiSyncEmpty');
  expect(failed.success).toBe(false);
  expect(failed.error).toBe(expectedSyncEmpty);
  expect(failed.output).toEqual({
    status: 'error', documentId: 'doc-fail', deckName: 'Default', noteType: 'Basic', total: 1, added: 0,
    duplicates: 0, failed: 1, createdModels: [], receiptWritten: 0,
    error: expectedSyncEmpty, warning: null,
  });
  expect(toolErrors).toEqual([expectedSyncEmpty]);
  expect(blockOutput('blk-fail')).toEqual({ documentId: 'doc-fail', cards: [] });
  expect(chunks).toEqual([]);
});

it('W22 sync maps templates to Deep Student models, infers the single template and reads the default deck setting', async () => {
  host.ctx.anki.templates.importBuiltinTemplatesIfEmpty();
  const template = host.ctx.anki.templates.list().find((candidate) => candidate.fields.length > 0
    && !candidate.front_template.includes('{{cloze:'))!;
  const model = host.ctx.anki.templateModelName(template);
  expect(model).toBe(`Deep Student / ${template.id} / v${template.version}`);
  settings.save('anki_connect_default_deck', 'Deck From Settings');
  try {
    const task = addDocument('doc-tpl');
    addCard(task, 'tpl-cloze', { text: '{{c1::cell}} wall', front: '', back: '' });
    addCard(task, 'tpl-card', { template_id: ` ${template.id} ` });
    healthy({ fields: template.fields });

    const result = await sync({ documentId: 'doc-tpl' });
    expect(result.success, result.error ?? undefined).toBe(true);
    expect(result.output).toMatchObject({
      status: 'ok', deckName: 'Deck From Settings', noteType: 'Basic', total: 2, added: 2, createdModels: [model],
    });
    expect(actions()).toEqual([
      'version', 'createDeck', 'version', 'modelNames', 'createModel', 'modelFieldNames', 'canAddNotes', 'addNotes',
    ]);
    // The cloze card has no template of its own: the inferred single template overrides `Cloze`.
    expect(noteModels()).toEqual([model, model]);
  } finally {
    settings.save('anki_connect_default_deck', '');
  }
});

it('W22 sync: an all-cloze set goes to Cloze; a missing template is the Rust `?` error after the deck exists', async () => {
  const clozeTask = addDocument('doc-cloze');
  addCard(clozeTask, 'cloze-1', { front: 'The {{c1::nucleus}} stores DNA', back: '' });
  addCard(clozeTask, 'cloze-2', { front: '', back: '', extra_fields: { text: '{{c2::ATP}} powers cells' } });
  healthy({ fields: ['Text', 'Back Extra'] });
  const cloze = await sync({ documentId: 'doc-cloze' });
  expect(cloze.output).toMatchObject({ status: 'ok', noteType: 'Cloze', added: 2 });
  expect(actions()).not.toContain('modelNames');
  expect(noteModels()).toEqual(['Cloze', 'Cloze']);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();

  requests = [];
  const missingTask = addDocument('doc-missing-tpl');
  addCard(missingTask, 'missing-tpl-card', { template_id: 'tpl-does-not-exist' });
  healthy();
  await expect(sync({ documentId: 'doc-missing-tpl' }))
    .rejects.toThrow('模板 tpl-does-not-exist 不存在，请先选择可用模板');
  expect(actions()).toEqual(['version', 'createDeck']);

  requests = [];
  const explicit = await sync({ documentId: 'doc-missing-tpl', noteType: 'Basic' });
  expect(explicit.output).toMatchObject({ status: 'ok', noteType: 'Basic', added: 1 });
});

it('W22 sync: unavailable AnkiConnect, empty sets, ownership and argument failures return actionable errors', async () => {
  const task = addDocument('doc-guard');
  addCard(task, 'guard-1');
  ankiConnect(() => ({ result: 5, error: null }));
  const unavailable = await sync({ documentId: 'doc-guard' });
  expect(unavailable.success).toBe(false);
  expect(unavailable.error).toContain('[anki_connect_version_unsupported]');
  expect(unavailable.error).toContain('API v5');
  expect(unavailable.error).toContain('>= v6');
  expect(unavailable.error).not.toMatch(/[\u3400-\u9fff]/);
  expect(unavailable.output).toEqual({
    status: 'error',
    errorCode: 'anki_connect_version_unsupported',
    retryable: false,
    detectedVersion: 5,
    requiredVersion: 6,
    error: unavailable.error,
  });
  expect(warnings).toEqual([expect.stringMatching(
    /^\[ChatAnkiToolExecutor\] AnkiConnect unavailable \(anki_connect_version_unsupported\):/)]);
  expect(warnings[0]).not.toMatch(/[\u3400-\u9fff]/);
  expect(actions()).toEqual(['version']);

  const errorsOnly = addDocument('doc-errors-only');
  addCard(errorsOnly, 'only-err', { is_error_card: true, error_content: 'x' });
  addDocument('doc-foreign', FOREIGN);
  const prefix = 'Invalid chatanki_sync arguments: ';
  const cases: Array<[unknown, string]> = [
    [{ documentId: 'doc-errors-only' }, 'No cards to sync (all cards are empty or error cards)'],
    [{ documentId: 'doc-foreign' }, STATUS_NOT_FOUND_MESSAGE],
    [{}, `${prefix}missing field \`documentId\``],
    [{ documentId: 'doc-guard', templateIds: 'tpl' }, `${prefix}invalid type: string "tpl", expected a sequence`],
    [{ documentId: 'doc-guard', templateMode: 'some' },
      `${prefix}unknown variant \`some\`, expected one of \`single\`, \`multiple\`, \`all\``],
    [{ documentId: 'doc-guard', templateMode: { single: 1 } }, `${prefix}invalid type: number, expected unit`],
    [['doc-guard'], `${prefix}invalid length 1, expected struct ChatAnkiSyncArgs with 6 elements`],
  ];
  requests = [];
  for (const [args, error] of cases) {
    const result = await sync(args);
    expect(result.success, JSON.stringify(args)).toBe(false);
    expect(result.output).toBeNull();
    expect(result.error).toBe(error);
  }
  expect(requests).toEqual([]);
});

it('G19 regression: syncs Library cards via libraryCardIds/cardIds and unowned Library documents without statusNotFound', async () => {
  // 1. Cross-session cards synced explicitly via libraryCardIds and cardIds.
  const foreignTask = addDocument('doc-lib-foreign', FOREIGN);
  addCard(foreignTask, 'lib-foreign-1');
  const ownTask = addDocument('doc-lib-own', CALLER);
  addCard(ownTask, 'lib-own-1');
  seedBlock('blk-lib-own', CALLER, { documentId: 'doc-lib-own', cards: [], syncStatus: 'error', syncError: 'old' });
  healthy();

  const byLibraryIds = await sync({
    libraryCardIds: ['lib-foreign-1', 'lib-own-1'],
    deckName: 'Biology Deck',
    noteType: 'Basic',
  });
  expect(byLibraryIds.success, byLibraryIds.error ?? undefined).toBe(true);
  expect(byLibraryIds.output).toEqual({
    status: 'ok',
    documentId: null,
    libraryCardIds: ['lib-foreign-1', 'lib-own-1'],
    deckName: 'Biology Deck',
    noteType: 'Basic',
    total: 2,
    added: 2,
    duplicates: 0,
    failed: 0,
    createdModels: [],
    receiptWritten: 2,
    error: null,
    warning: null,
  });
  expect(receipts('doc-lib-foreign')).toEqual([{ id: 'lib-foreign-1', anki_note_id: 9000, export_status: 'synced' }]);
  expect(receipts('doc-lib-own')).toEqual([{ id: 'lib-own-1', anki_note_id: 9001, export_status: 'synced' }]);
  // Library-id sync must not mutate unrelated chat blocks.
  expect(blockOutput('blk-lib-own')).toEqual({
    documentId: 'doc-lib-own', cards: [], syncStatus: 'error', syncError: 'old',
  });

  // `cardIds` alias also works for Library cards.
  requests = [];
  const byCardIds = await sync({ cardIds: ['lib-foreign-1'], deckName: 'Biology Deck' });
  expect(byCardIds.success, byCardIds.error ?? undefined).toBe(true);
  expect(byCardIds.output).toMatchObject({
    status: 'ok',
    documentId: null,
    libraryCardIds: ['lib-foreign-1'],
    added: 1,
  });

  // Missing or conflicting selector arguments fail closed with clear messages.
  const both = await sync({ documentId: 'doc-lib-own', libraryCardIds: ['lib-own-1'] });
  expect(both.success).toBe(false);
  expect(both.error).toContain('mutually exclusive');

  const missingCard = await sync({ libraryCardIds: ['lib-foreign-1', 'does-not-exist'] });
  expect(missingCard.success).toBe(false);
  expect(missingCard.error).toContain('library_cards_unavailable');

  // 2. Unowned Library document (created via save_anki_cards without business_session_id -> source_session_id IS NULL).
  const saved = await host.invoke<{ savedIds: string[]; taskId: string }>('save_anki_cards', {
    request: {
      document_id: 'doc-manual-library',
      business_session_id: null,
      message_stable_id: null,
      block_id: null,
      template_id: null,
      cards: [{ id: 'manual-lib-card-1', front: 'ATP', back: 'Adenosine triphosphate', text: null, tags: ['bio'], images: null, fields: null, template_id: null }],
      options: null,
    },
  });
  expect(saved.savedIds).toEqual(['manual-lib-card-1']);

  requests = [];
  const byLibraryDoc = await sync({ documentId: 'doc-manual-library', deckName: 'Bio' });
  expect(byLibraryDoc.success, byLibraryDoc.error ?? undefined).toBe(true);
  expect(byLibraryDoc.output).toMatchObject({
    status: 'ok',
    documentId: 'doc-manual-library',
    deckName: 'Bio',
    total: 1,
    added: 1,
    receiptWritten: 1,
  });
  expect(receipts('doc-manual-library')).toEqual([
    { id: 'manual-lib-card-1', anki_note_id: 9000, export_status: 'synced' },
  ]);
});

it('G19 regression: offline AnkiConnect peer returns actionable English error without raw os error 111 or Chinese leak', async () => {
  const task = addDocument('doc-offline');
  addCard(task, 'offline-1');
  vi.spyOn(net, 'connect').mockImplementation((() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = () => socket;
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8765'), {
      code: 'ECONNREFUSED',
      errno: -111,
    });
    setImmediate(() => socket.emit('error', err));
    return socket;
  }) as typeof net.connect);

  const result = await sync({ documentId: 'doc-offline' });
  expect(result.success).toBe(false);
  expect(result.error).toContain('[anki_connect_offline]');
  expect(result.error).not.toContain('os error 111');
  expect(result.error).not.toMatch(/[\u3400-\u9fff]/);
  expect(result.output).toEqual({
    status: 'error',
    errorCode: 'anki_connect_offline',
    retryable: true,
    error: result.error,
  });

  const probe = await host.ctx.chatankiTools.execute(
    { id: 'call-probe-offline', name: 'builtin-chatanki_check_anki_connect', arguments: {} },
    context(),
  );
  expect(probe.success).toBe(true);
  expect(probe.output).toMatchObject({
    status: 'ok',
    available: false,
    errorCode: 'anki_connect_offline',
    retryable: true,
  });
  const probeError = (probe.output as { error: string }).error;
  expect(probeError).toContain('[anki_connect_offline]');
  expect(probeError).not.toContain('os error 111');
  expect(probeError).not.toMatch(/[\u3400-\u9fff]/);
});

it('RF-W22-sync-status-patch-session-scope: the syncStatus write-back stays on the caller session\'s block', async () => {
  const task = addDocument('doc-rf');
  addCard(task, 'rf-1');
  seedBlock('blk-rf-own', CALLER, { documentId: 'doc-rf', cards: [] });
  // Rust scans the newest 40 anki_cards rows of every session: 40 unrelated rows push the
  // caller's block out of that window and a forked foreign copy of the document sits inside it.
  seedBlock('blk-rf-foreign', FOREIGN, { documentId: 'doc-rf', cards: [] });
  for (let index = 0; index < 40; index += 1) seedBlock(`blk-rf-noise-${index}`, FOREIGN, { documentId: `noise-${index}` });
  healthy();

  const result = await sync({ documentId: 'doc-rf' });
  expect(result.success, result.error ?? undefined).toBe(true);
  expect(blockOutput('blk-rf-own')).toEqual({ documentId: 'doc-rf', cards: [], syncStatus: 'synced' });
  expect(blockOutput('blk-rf-foreign')).toEqual({ documentId: 'doc-rf', cards: [] });
  expect(chunks).toEqual([{ blockId: 'blk-rf-own', patch: { syncStatus: 'synced', syncError: null } }]);
});

function registry() {
  return host.ctx.chatSession.createExecutorRegistry(
    host.ctx.agentTools.toolExecutors() as readonly ToolExecutor[],
    { ignoresBroadApprovalBypassForArgs: () => false, neverRememberApprovalForArgs: () => false },
  );
}

it('W22 registry: builtin-chatanki_sync is offered only while L16 publishes the whole AnkiConnect sync facade', () => {
  const service = host.ctx.anki as unknown as Record<string, unknown>;
  for (const method of ['addNotesToAnkiDetailed', 'writeAnkiExportReceipts', 'readSyncOptions']) {
    const own = Object.getOwnPropertyDescriptor(service, method);
    Object.defineProperty(service, method, { value: undefined, configurable: true, writable: true });
    try {
      expect(registry().hasSpecificExecutor('builtin-chatanki_sync'), method).toBe(false);
      expect(host.ctx.chatankiTools.canHandle('chatanki_sync'), method).toBe(false);
    } finally {
      if (own === undefined) delete service[method];
      else Object.defineProperty(service, method, own);
    }
  }
  expect(registry().hasSpecificExecutor('builtin-chatanki_sync')).toBe(true);
  expect(host.ctx.chatankiTools.canHandle('chatanki_sync')).toBe(true);
});
