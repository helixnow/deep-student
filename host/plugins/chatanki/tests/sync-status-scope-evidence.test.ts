/**
 * RF-W22-sync-status-patch-session-scope evidence: which `anki_cards` block a successful
 * chatanki_sync marks `synced`, Rust vs this lane, on the same real chat_v2 / mistakes DBs.
 *
 * - Rust mode: chatanki_executor.rs:14238–14270 picks the block with its own SQL (newest 40
 *   `anki_cards` rows of every session, first `documentId` match). The test runs that SQL
 *   verbatim and hands the window to this lane's `patchAnkiCardsBlockSyncStatus`, so the JSON
 *   write, `Map::remove` order and the chunk are the shared code; only the locator differs.
 * - This lane: the real `builtin-chatanki_sync` through `chatankiTools.execute`.
 *
 * Every case starts from a card block whose earlier UI sync failed (`syncStatus: 'error'`,
 * `syncError` set — `ankiCardsBlock.tsx:2327–2342` persists both). The live chunk changes nothing
 * on screen in either mode: `ankiCards.ts:551–552` drops non-mutation chunks on terminal blocks.
 * What the user sees comes from the DB row on the next session load: `synced` renders as the
 * `stored` preview ("已保存", `ankiCardsBlock.tsx:407`), `error` keeps the failure and its text.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import native from '../../../platform/native/index.ts';
import { createSettingsStore } from '../../../platform/settings/index.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import agentSkills from '../../agent-skills/index.ts';
import anki from '../../anki/index.ts';
import chat from '../../chat/index.ts';
import review from '../../review/index.ts';
import type { ChatAnkiChatBlock, ChatAnkiChatBlockStore, ToolExecutionContext } from '../api.ts';
import chatanki from '../index.ts';
import { patchAnkiCardsBlockSyncStatus } from '../src/sync-executor.ts';

let dir = '';
let storage: ReturnType<typeof createStorageService>;
let host: TestHost;
const CREATED = '2026-11-07T00:00:00Z';
const FAILED_UI_SYNC = { syncStatus: 'error', syncError: 'blocks.ankiCards.errors.ankiConnectUnavailable' };
let clock = 1_000;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chatanki-sync-scope-'));
  storage = createStorageService({ baseDir: dir, dataLocalDir: path.join(dir, 'local') });
  expect((await storage.migrations.runAll()).success).toBe(true);
  const settings = createSettingsStore({
    db: () => storage.database('mistakes'), secureStore: () => null, isSensitiveKey: () => false,
  });
  host = await createTestHost({
    app: { dataDir: dir }, plugins: [native, chat, anki, review, agentSkills, chatanki],
    provide: {
      paths: { appDataDir: dir, os: { home: dir, data: dir, temp: dir } }, storage, settings,
      llm: {}, vfs: {},
    },
  });
  // AnkiConnect v6 on 127.0.0.1:8765 accepting every note; only the network boundary is replaced.
  vi.spyOn(net, 'connect').mockImplementation((() => {
    const socket = new EventEmitter() as net.Socket;
    socket.destroy = () => socket;
    setImmediate(() => socket.emit('connect'));
    return socket;
  }) as typeof net.connect);
  vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
    if (init?.method !== 'POST') return new Response('');
    const request = JSON.parse(String(init.body)) as { action: string; params?: { notes?: unknown[] } };
    const notes = request.params?.notes ?? [];
    const result = ({
      version: 6, createDeck: 1, modelFieldNames: ['Front', 'Back'],
      canAddNotes: notes.map(() => true), addNotes: notes.map((_note, index) => 7000 + index),
    } as Record<string, unknown>)[request.action] ?? null;
    return new Response(JSON.stringify({ result, error: null }));
  });
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await host?.dispose();
  storage?.dispose();
  if (dir !== '') fs.rmSync(dir, { recursive: true, force: true });
});

function chatDb() { return storage.database('chat_v2'); }

function ownDocument(documentId: string, sessionId: string): void {
  const taskId = `task-${documentId}`;
  host.ctx.anki.documents.insertDocumentTask({
    id: taskId, document_id: documentId, original_document_name: 'scope.md',
    segment_index: 0, content_segment: 'material', status: 'Completed',
    created_at: CREATED, updated_at: CREATED, error_message: null, anki_generation_options_json: '{}',
  });
  host.ctx.anki.documents.setDocumentSessionSource(documentId, sessionId);
  expect(host.ctx.anki.cards.insertCard({
    id: `card-${documentId}`, task_id: taskId, front: 'front', back: 'back', text: null,
    tags: [], images: [], is_error_card: false, error_content: null,
    created_at: CREATED, updated_at: CREATED, extra_fields: {}, template_id: null,
  })).toBe(true);
}

/** One assistant message carrying one finished `anki_cards` preview block (rowid = insertion order). */
function cardBlock(blockId: string, sessionId: string, documentId: string, extra: object = {}): string {
  const db = chatDb();
  clock += 1;
  db.run(`INSERT OR IGNORE INTO chat_v2_sessions (id, mode, persist_status, created_at, updated_at)
    VALUES (?1, 'chat', 'active', ?2, ?2)`, [sessionId, CREATED]);
  db.run(`INSERT INTO chat_v2_messages (id, session_id, role, block_ids_json, timestamp)
    VALUES (?1, ?2, 'assistant', ?3, ?4)`, [`msg_${blockId}`, sessionId, JSON.stringify([blockId]), clock]);
  db.run(`INSERT INTO chat_v2_blocks (id, message_id, block_type, status, block_index, tool_name, started_at, tool_output_json)
    VALUES (?1, ?2, 'anki_cards', 'success', 0, 'chatanki_run', ?3, ?4)`,
  [blockId, `msg_${blockId}`, clock, JSON.stringify({ documentId, cards: [], ...extra })]);
  return `msg_${blockId}`;
}

function cardBlockRows(): Array<{ id: string; sessionId: string; output: string }> {
  return chatDb().all<{ id: string; sessionId: string; output: string }>(
    `SELECT b.id AS id, m.session_id AS sessionId, b.tool_output_json AS output
     FROM chat_v2_blocks b JOIN chat_v2_messages m ON m.id = b.message_id
     WHERE b.block_type = 'anki_cards' ORDER BY b.rowid`);
}

/** The Rust locator, verbatim (chatanki_executor.rs:14243–14247), returned oldest→newest. */
function rustWindowStore(): ChatAnkiChatBlockStore {
  const real = host.ctx.anki.chatBlocks as unknown as ChatAnkiChatBlockStore;
  return {
    ...real,
    getBlock: (id) => real.getBlock(id),
    updateBlock: (block) => real.updateBlock(block),
    listSessionBlocks: () => chatDb().all<{ id: string; tool_output_json: string }>(`
      SELECT id, tool_output_json
      FROM chat_v2_blocks
      WHERE block_type = 'anki_cards' AND tool_output_json IS NOT NULL
      ORDER BY rowid DESC
      LIMIT 40`).reverse().map((row): ChatAnkiChatBlock => {
      let toolOutput: unknown = null;
      try { toolOutput = JSON.parse(row.tool_output_json) as unknown; } catch { toolOutput = null; }
      return { id: row.id, sessionId: '', type: 'anki_cards', status: 'success', toolOutput };
    }),
  };
}

interface Outcome {
  /** Blocks whose stored output changed, with the session they belong to and the new sync fields. */
  written: Array<{ blockId: string; sessionId: string; syncStatus: unknown; syncError: unknown }>;
  chunks: Array<{ blockId: string; patch: Record<string, unknown> }>;
}

function context(sessionId: string, chunks: Outcome['chunks']): ToolExecutionContext {
  return {
    sessionId, messageId: `msg-call-${sessionId}`, blockId: `blk-call-${sessionId}`,
    emitToolCallStart: () => undefined, emitToolCallEnd: () => undefined, emitToolCallError: () => undefined,
    saveToolBlock: () => undefined,
    emitChunk: (blockId, patch) => { chunks.push({ blockId, patch }); },
    warn: () => undefined, info: () => undefined,
  };
}

/** Runs `act`, reports every card block it changed, then restores the rows so both modes see one state. */
async function observe(act: (chunks: Outcome['chunks']) => Promise<void> | void): Promise<Outcome> {
  const before = new Map(cardBlockRows().map((row) => [row.id, row.output]));
  const chunks: Outcome['chunks'] = [];
  await act(chunks);
  const written = cardBlockRows().filter((row) => before.get(row.id) !== row.output).map((row) => {
    const output = JSON.parse(row.output) as Record<string, unknown>;
    return { blockId: row.id, sessionId: row.sessionId, syncStatus: output.syncStatus, syncError: output.syncError };
  });
  for (const row of written) {
    chatDb().run('UPDATE chat_v2_blocks SET tool_output_json = ?1 WHERE id = ?2', [before.get(row.blockId)!, row.blockId]);
  }
  return { written, chunks };
}

/** Same caller, same document, same DB state: Rust's locator, then this lane's real tool. */
async function bothModes(callerSessionId: string, documentId: string): Promise<{ rust: Outcome; lane: Outcome }> {
  const rust = await observe((chunks) => {
    patchAnkiCardsBlockSyncStatus(rustWindowStore(), context(callerSessionId, chunks), documentId, 'synced', null);
  });
  const lane = await observe(async (chunks) => {
    const result = await host.ctx.chatankiTools.execute(
      { id: `call-${documentId}`, name: 'builtin-chatanki_sync', arguments: { documentId } },
      context(callerSessionId, chunks),
    );
    expect(result.success, result.error ?? undefined).toBe(true);
    expect(result.output).toMatchObject({ status: 'ok', added: 1 });
  });
  return { rust, lane };
}

const SYNCED = { syncStatus: 'synced', syncError: undefined };
const chunkFor = (blockId: string) => ({ blockId, patch: { syncStatus: 'synced', syncError: null } });

it('RF-W22-sync-status-patch-session-scope evidence 1: one session, under 40 card blocks — Rust and this lane write the same block', async () => {
  ownDocument('doc-e1', 'sess_e1');
  cardBlock('blk-e1', 'sess_e1', 'doc-e1', FAILED_UI_SYNC);
  cardBlock('blk-e1-other', 'sess_e1-other', 'doc-e1-other');

  const { rust, lane } = await bothModes('sess_e1', 'doc-e1');
  expect(rust).toEqual({ written: [{ blockId: 'blk-e1', sessionId: 'sess_e1', ...SYNCED }], chunks: [chunkFor('blk-e1')] });
  expect(lane).toEqual(rust);
});

it('RF-W22-sync-status-patch-session-scope evidence 2: after a session branch Rust marks the branch copy and leaves the caller\'s block failed', async () => {
  ownDocument('doc-e2', 'sess_e2');
  const message = cardBlock('blk-e2', 'sess_e2', 'doc-e2', FAILED_UI_SYNC);
  // The real chat_v2_branch_session deep-copies the block (new id, newer rowid, same documentId).
  const branch = await host.invoke<{ id: string }>('chat_v2_branch_session', { sourceSessionId: 'sess_e2', upToMessageId: message });
  const copy = cardBlockRows().find((row) => row.sessionId === branch.id)!;
  expect(JSON.parse(copy.output)).toEqual({ documentId: 'doc-e2', cards: [], ...FAILED_UI_SYNC });

  const { rust, lane } = await bothModes('sess_e2', 'doc-e2');
  // Rust: the caller's own block keeps `error` + the stale AnkiConnect text; the branch copy (a session
  // that cannot even sync this document: verify_document_ownership rejects it) shows "已保存", and the
  // chunk names a block the caller's view does not hold.
  expect(rust).toEqual({
    written: [{ blockId: copy.id, sessionId: branch.id, ...SYNCED }], chunks: [chunkFor(copy.id)],
  });
  expect(lane).toEqual({ written: [{ blockId: 'blk-e2', sessionId: 'sess_e2', ...SYNCED }], chunks: [chunkFor('blk-e2')] });
});

it('RF-W22-sync-status-patch-session-scope evidence 3: 40 newer card blocks in other sessions push the caller\'s block out of Rust\'s window', async () => {
  ownDocument('doc-e3', 'sess_e3');
  cardBlock('blk-e3', 'sess_e3', 'doc-e3', FAILED_UI_SYNC);
  for (let index = 0; index < 40; index += 1) cardBlock(`blk-e3-noise-${index}`, `sess_e3-other-${index % 4}`, `doc-e3-noise-${index}`);

  const { rust, lane } = await bothModes('sess_e3', 'doc-e3');
  expect(rust).toEqual({ written: [], chunks: [] });
  expect(lane).toEqual({ written: [{ blockId: 'blk-e3', sessionId: 'sess_e3', ...SYNCED }], chunks: [chunkFor('blk-e3')] });
});

it('RF-W22-sync-status-patch-session-scope evidence 4: one long session with 40 later card blocks — Rust misses the caller\'s own block', async () => {
  ownDocument('doc-e4', 'sess_e4');
  cardBlock('blk-e4', 'sess_e4', 'doc-e4', FAILED_UI_SYNC);
  for (let index = 0; index < 40; index += 1) cardBlock(`blk-e4-later-${index}`, 'sess_e4', `doc-e4-later-${index}`);

  const { rust, lane } = await bothModes('sess_e4', 'doc-e4');
  expect(rust).toEqual({ written: [], chunks: [] });
  expect(lane).toEqual({ written: [{ blockId: 'blk-e4', sessionId: 'sess_e4', ...SYNCED }], chunks: [chunkFor('blk-e4')] });
});

it('RF-W22-sync-status-patch-session-scope evidence 5: the caller deleted its card message; only a branch copy remains — Rust marks the copy, this lane writes nothing', async () => {
  ownDocument('doc-e5', 'sess_e5');
  const message = cardBlock('blk-e5', 'sess_e5', 'doc-e5', FAILED_UI_SYNC);
  const branch = await host.invoke<{ id: string }>('chat_v2_branch_session', { sourceSessionId: 'sess_e5', upToMessageId: message });
  await host.invoke('chat_v2_delete_message', { sessionId: 'sess_e5', messageId: message });
  const copies = cardBlockRows().filter((row) => JSON.parse(row.output).documentId === 'doc-e5');
  expect(copies.map((row) => row.sessionId)).toEqual([branch.id]);

  const { rust, lane } = await bothModes('sess_e5', 'doc-e5');
  expect(rust).toEqual({
    written: [{ blockId: copies[0]!.id, sessionId: branch.id, ...SYNCED }], chunks: [chunkFor(copies[0]!.id)],
  });
  expect(lane).toEqual({ written: [], chunks: [] });
});

it('RF-W22-sync-status-patch-session-scope evidence 6: after a snapshot export + re-import Rust marks the imported copy and leaves the caller\'s block failed', async () => {
  ownDocument('doc-e6', 'sess_e6');
  cardBlock('blk-e6', 'sess_e6', 'doc-e6', FAILED_UI_SYNC);
  // The Rust frontend's snapshot file (sessionExport.ts:69–83): meta + every message page, then
  // chat_v2_import_session writes it as a new session with fresh block ids and the same documentId.
  const meta = await host.invoke<Record<string, unknown> & { pageSize: number }>('chat_v2_export_session_meta', { sessionId: 'sess_e6' });
  const page = await host.invoke<{ messages: unknown[]; blocks: unknown[]; nextOffset: number | null }>(
    'chat_v2_export_session_messages', { sessionId: 'sess_e6', offset: 0, limit: meta.pageSize },
  );
  expect(page.nextOffset).toBeNull();
  const snapshotJson = JSON.stringify({
    format: meta.format, version: meta.version, exportedAt: meta.exportedAt, appVersion: meta.appVersion,
    session: meta.session, sessionState: meta.sessionState, messages: page.messages, blocks: page.blocks,
  });
  const imported = await host.invoke<{ sessionId: string; blockCount: number }>('chat_v2_import_session', { snapshotJson });
  expect(imported.blockCount).toBe(1);
  const copy = cardBlockRows().find((row) => row.sessionId === imported.sessionId)!;
  expect(copy.id).not.toBe('blk-e6');
  expect(JSON.parse(copy.output)).toEqual({ documentId: 'doc-e6', cards: [], ...FAILED_UI_SYNC });
  // The imported session cannot sync this document itself (verify_document_ownership, chatanki_executor.rs:6183).
  const fromCopy = await host.ctx.chatankiTools.execute(
    { id: 'call-doc-e6-copy', name: 'builtin-chatanki_sync', arguments: { documentId: 'doc-e6' } },
    context(imported.sessionId, []),
  );
  expect([fromCopy.success, fromCopy.error]).toEqual([false, 'blocks.ankiCards.errors.statusNotFound']);

  const { rust, lane } = await bothModes('sess_e6', 'doc-e6');
  expect(rust).toEqual({
    written: [{ blockId: copy.id, sessionId: imported.sessionId, ...SYNCED }], chunks: [chunkFor(copy.id)],
  });
  expect(lane).toEqual({ written: [{ blockId: 'blk-e6', sessionId: 'sess_e6', ...SYNCED }], chunks: [chunkFor('blk-e6')] });
});
