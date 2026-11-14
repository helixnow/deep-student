/**
 * L16 `anki` 服务对 L24 chatanki 的七个嵌套仓储面（A5）。
 *
 * 这里从真实插件装载后的 `ctx.anki` 取服务；卡片/文档/设置/偏好/APKG 都落到
 * 真实平台库或真实实现。L04 `chatSession` 与 L11 `vfsDatabase` + `vfsRepo`
 * 在测试里装载各自真实插件，不使用内存替身。
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AnkiCard, DocumentTask } from '../../../../contracts/ipc/generated/_shared.ts';
import type {
  ChatAnkiApkgImporter, ChatAnkiApkgVfs, ChatAnkiCardRepository, ChatAnkiChatBlockStore,
  ChatAnkiDocumentTaskRepository, ChatAnkiPreferenceMemory, ChatAnkiSettingsStore,
} from '../../chatanki/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import chat from '../../chat/index.ts';
import vfs from '../../vfs/index.ts';
import vfsRepos from '../../vfs-repos/index.ts';
import notes from '../../notes/index.ts';
import vfsIndex from '../../vfs-index/index.ts';
import type { AnkiService } from '../api.ts';
import { buildZip } from '../src/apkg-zip.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';
import { setAnkiLocalRuntime } from '../src/local-runtime.ts';
import { nodeAnkiLocalRuntime } from '../src/local-runtime.node.ts';

const NOW = '2026-11-04T00:00:00Z';
const SETTINGS_KEY = 'chatanki_preference_memory_store';

interface TaskSeed {
  id: string;
  documentId: string;
  sessionId: string | null;
  segmentIndex?: number;
  status?: string;
}

interface CardSeed {
  id: string;
  taskId: string;
  front?: string;
  back?: string;
  extraFields?: Record<string, string>;
  order?: number;
}

function insertTask(db: DatabaseHandle, seed: TaskSeed): void {
  db.run(
    `INSERT INTO document_tasks
       (id, document_id, original_document_name, segment_index, content_segment,
        status, created_at, updated_at, error_message, anki_generation_options_json,
        source_session_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, '{}', ?9)`,
    [
      seed.id,
      seed.documentId,
      `${seed.documentId}.md`,
      seed.segmentIndex ?? 0,
      `segment-${seed.segmentIndex ?? 0}`,
      seed.status ?? 'Completed',
      NOW,
      NOW,
      seed.sessionId,
    ],
  );
}

function insertCard(db: DatabaseHandle, seed: CardSeed): void {
  db.run(
    `INSERT INTO anki_cards
       (id, task_id, front, back, text, tags_json, images_json,
        is_error_card, error_content, card_order_in_task, created_at, updated_at,
        extra_fields_json, template_id, source_type, source_id)
     VALUES (?1, ?2, ?3, ?4, NULL, '[]', '[]', 0, NULL, ?5, ?6, ?7, ?8, NULL,
             'document', 'doc-a')`,
    [
      seed.id,
      seed.taskId,
      seed.front ?? `front-${seed.id}`,
      seed.back ?? `back-${seed.id}`,
      seed.order ?? 0,
      NOW,
      NOW,
      JSON.stringify(seed.extraFields ?? {}),
    ],
  );
}

type L24SurfaceCompatibility = [
  AnkiService['cards'] extends ChatAnkiCardRepository ? true : never,
  AnkiService['documents'] extends ChatAnkiDocumentTaskRepository ? true : never,
  AnkiService['chatBlocks'] extends ChatAnkiChatBlockStore ? true : never,
  AnkiService['settings'] extends ChatAnkiSettingsStore ? true : never,
  AnkiService['preferenceMemory'] extends ChatAnkiPreferenceMemory ? true : never,
  AnkiService['apkgImporter'] extends ChatAnkiApkgImporter ? true : never,
  AnkiService['apkgVfs'] extends ChatAnkiApkgVfs ? true : never,
];

function cardFixture(id: string, taskId: string): AnkiCard {
  return {
    id,
    task_id: taskId,
    front: `front-${id}`,
    back: `back-${id}`,
    text: null,
    tags: [],
    images: [],
    is_error_card: false,
    error_content: null,
    created_at: NOW,
    updated_at: NOW,
    extra_fields: {},
    template_id: null,
  };
}

function taskFixture(id: string, documentId: string): DocumentTask {
  return {
    id,
    document_id: documentId,
    original_document_name: 'inserted.md',
    segment_index: 2,
    content_segment: 'inserted segment',
    status: 'Pending',
    created_at: NOW,
    updated_at: NOW,
    error_message: null,
    anki_generation_options_json: '{}',
  };
}

/** Legacy `collection.anki2` fixture used by `ApkgImporterService`. */
function collectionBytes(env: AnkiTestEnv, file: string, front: string): Buffer {
  const handle = env.storage.openFile(file);
  try {
    handle.exec(`
      PRAGMA journal_mode = DELETE;
      CREATE TABLE col (models TEXT NOT NULL, decks TEXT NOT NULL);
      CREATE TABLE notes (
          id INTEGER PRIMARY KEY, mid INTEGER NOT NULL, tags TEXT NOT NULL, flds TEXT NOT NULL
      );
      CREATE TABLE cards (
          id INTEGER PRIMARY KEY, nid INTEGER NOT NULL, did INTEGER NOT NULL, ord INTEGER NOT NULL
      );
    `);
    handle.run('INSERT INTO col (models, decks) VALUES (?1, ?2)', [
      JSON.stringify({
        100: {
          name: 'Basic',
          type: 0,
          flds: [{ name: 'Front', ord: 0 }, { name: 'Back', ord: 1 }],
        },
      }),
      JSON.stringify({ 1: { name: 'Imported' } }),
    ]);
    handle.run("INSERT INTO notes (id, mid, tags, flds) VALUES (1, 100, '', ?1)", [
      `${front}\u001fback`,
    ]);
    handle.run('INSERT INTO cards (id, nid, did, ord) VALUES (10, 1, 1, 0)');
  } finally {
    env.storage.close(handle);
  }
  const bytes = fs.readFileSync(file);
  fs.rmSync(file, { force: true });
  return bytes;
}

describe('anki service chatanki surface (A5)', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;
  let service: AnkiService;

  beforeAll(async () => {
    env = await createAnkiTestEnv({
      provide: (storage) => ({
        settings: createSettingsService({
          db: () => storage.database('mistakes'),
          secureStore: () => null,
          secrets: { isSensitiveKey: () => false },
        }),
      }),
    });
    // L13 的 dstu.vfs 按 Rust 注入 notes / vfsRepo / vfsIndex：先装这些服务的所有者
    await env.host.install(vfsRepos);
    await env.host.install(notes);
    await env.host.install(vfsIndex);
    await env.host.install(vfs);
    await env.host.install(chat);
    db = env.storage.database('mistakes');
    service = env.host.ctx.anki;
  }, 120_000);

  afterAll(async () => {
    await env.dispose();
    setAnkiLocalRuntime(null);
  });

  beforeEach(() => {
    setAnkiLocalRuntime(nodeAnkiLocalRuntime);
    db.run('DELETE FROM fsrs_review_logs');
    db.run('DELETE FROM fsrs_card_states');
    db.run('DELETE FROM anki_cards');
    db.run('DELETE FROM document_tasks');
    db.run('DELETE FROM settings');
  });

  function seedOwnedDocument(): void {
    insertTask(db, { id: 'task-a', documentId: 'doc-a', sessionId: 'sess-a' });
    insertTask(db, { id: 'task-b', documentId: 'doc-b', sessionId: 'sess-b' });
    insertCard(db, { id: 'card-a1', taskId: 'task-a', order: 0, extraFields: { Extra: 'extra-a1' } });
    insertCard(db, { id: 'card-a2', taskId: 'task-a', order: 1 });
    insertCard(db, { id: 'card-b1', taskId: 'task-b', order: 0 });
  }

  it('exposes the seven production nested surfaces', () => {
    const l24SurfaceCompatibility: L24SurfaceCompatibility = [
      true, true, true, true, true, true, true,
    ];
    expect(l24SurfaceCompatibility.every(Boolean)).toBe(true);
    expect(service.cards).toBeTypeOf('object');
    expect(service.documents).toBeTypeOf('object');
    expect(service.chatBlocks).toBeTypeOf('object');
    expect(service.settings).toBeTypeOf('object');
    expect(service.preferenceMemory).toBeTypeOf('object');
    expect(service.apkgImporter).toBeTypeOf('object');
    expect(service.apkgVfs).toBeTypeOf('object');
  });

  it('cards reads real mistakes-DB rows with session ownership and stable ordering', () => {
    seedOwnedDocument();

    expect(service.cards.isDocumentOwnedBySession('doc-a', 'sess-a')).toBe(true);
    expect(service.cards.isDocumentOwnedBySession('doc-a', 'sess-b')).toBe(false);

    expect(service.cards.getCardsForDocumentForSession('doc-a', 'sess-a')?.map((card) => card.id))
      .toEqual(['card-a1', 'card-a2']);
    expect(service.cards.getCardsForDocumentForSession('doc-a', 'sess-b')).toBeNull();
    expect(service.cards.getCardsForDocument('doc-a').map((card) => card.id))
      .toEqual(['card-a1', 'card-a2']);

    expect(service.cards.getCardWithDocument('card-a1')).toMatchObject({
      documentId: 'doc-a',
      card: { id: 'card-a1', front: 'front-card-a1' },
    });
    expect(service.cards.getCardForSession('card-a1', 'sess-b')).toBeNull();
    expect(service.cards.getCardForSession('card-a1', 'sess-a')).toMatchObject({
      documentId: 'doc-a',
    });
    expect(service.cards.loadOwnedCard('card-a1', 'sess-a')).toMatchObject({
      documentId: 'doc-a',
    });
    expect(service.cards.loadOwnedCard('card-a1', 'sess-b')).toBeNull();

    expect(service.cards.getLibraryCardsByIds(['card-a2', 'card-a1']).map((card) => card.id))
      .toEqual(['card-a2', 'card-a1']);
    expect(() => service.cards.getLibraryCardsByIds(['card-a1', 'missing-card']))
      .toThrow('library_cards_unavailable: missing-card');
  });

  it('cards insert, CAS update, retemplate and delete stay inside an immediate transaction', () => {
    seedOwnedDocument();

    const inserted = service.cards.insertCardsForDocument('doc-a', 'sess-a', [
      cardFixture('card-a3', 'ignored-task'),
    ]);
    expect(inserted.map((card) => card.id)).toEqual(['card-a3']);
    expect(inserted[0]?.task_id).toBe('task-a');
    expect(
      db.pluck<number>('SELECT card_order_in_task FROM anki_cards WHERE id = ?1', ['card-a3']),
    ).toBe(2);
    expect(
      db.pluck<string>('SELECT source_type FROM anki_cards WHERE id = ?1', ['card-a3']),
    ).toBe('document');

    const current = service.cards.getCardWithDocument('card-a1')!.card;
    const updated = service.cards.updateCardIfVersionForSession(
      { ...current, front: 'edited-front' }, current.updated_at, 'sess-a',
    );
    expect(updated.kind).toBe('updated');
    if (updated.kind !== 'updated') throw new Error('expected updated');
    expect(updated.card.front).toBe('edited-front');

    const conflict = service.cards.updateCardIfVersionForSession(
      { ...current, front: 'stale-front' }, current.updated_at, 'sess-a',
    );
    expect(conflict).toMatchObject({ kind: 'conflict', current: { front: 'edited-front' } });
    expect(service.cards.updateCardIfVersionForSession(
      { ...current, front: 'other-session' }, updated.card.updated_at, 'sess-b',
    )).toEqual({ kind: 'notFound' });

    const beforeRetemplate = service.cards.getCardsForDocument('doc-a');
    const expectedVersions = new Map(
      beforeRetemplate.map((card) => [card.id, card.updated_at] as const),
    );
    const retemplated = service.cards.retemplateCardsForSession(
      { kind: 'document', documentId: 'doc-a' },
      {
        templateId: 'template-retemplated',
        noteType: 'Basic',
        fields: ['Front', 'Extra', 'Missing'],
        requiredFields: ['Missing'],
      },
      expectedVersions,
      'sess-a',
      ['doc-a'],
    );
    expect(retemplated.kind).toBe('updated');
    if (retemplated.kind !== 'updated') throw new Error('expected retemplate update');
    const cardA1 = retemplated.updates.find((update) => update.card.id === 'card-a1')!;
    expect(cardA1.card.template_id).toBe('template-retemplated');
    expect(cardA1.card.extra_fields.Front).toBe('edited-front');
    expect(cardA1.card.extra_fields.Extra).toBe('extra-a1');
    expect(cardA1.missingFields).toContainEqual({ field: 'Missing', required: true });

    db.run(
      `INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, created_at, updated_at)
       VALUES ('state-a2', 'card-a2', 0, ?1, ?1)`,
      [NOW],
    );
    db.run(
      `INSERT INTO fsrs_review_logs
         (id, card_state_id, anki_card_id, rating, state_before, state_after,
          review_ms, fsrs_params_version)
       VALUES ('log-a2', 'state-a2', 'card-a2', 3, 0, 1, 1, 'rs-fsrs-1.2')`,
    );
    const deleteTarget = service.cards.getCardWithDocument('card-a2')!.card;
    expect(service.cards.deleteCardForSession(
      'card-a2', deleteTarget.updated_at, null, 'sess-a',
    )).toMatchObject({
      kind: 'reviewConflict',
      review: { ankiCardId: 'card-a2', reviewVersion: 0n },
    });
    expect(service.cards.deleteCardForSession(
      'card-a2', deleteTarget.updated_at, 0, 'sess-a',
    )).toEqual({ kind: 'deleted' });
    expect(db.pluck<string>('SELECT id FROM anki_cards WHERE id = ?1', ['card-a2']))
      .toBeUndefined();
    expect(db.pluck<number>(
      'SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1', ['card-a2'],
    )).toBe(0);
    expect(db.pluck<number>(
      'SELECT COUNT(*) FROM fsrs_review_logs WHERE anki_card_id = ?1', ['card-a2'],
    )).toBe(0);
    expect(service.cards.deleteCardForSession(
      'card-a1', current.updated_at, null, 'sess-a',
    )).toMatchObject({ kind: 'conflict' });
  });

  it('publishes the F3 agent-library card surface on the real anki service', () => {
    seedOwnedDocument();

    expect(service.insertAnkiCard(cardFixture('card-f3', 'task-a'))).toBe(true);
    expect(service.insertAnkiCard(cardFixture('card-f3', 'task-a'))).toBe(false);

    const listed = service.listAnkiAgentLibraryCards({
      search: 'front-card-a1',
      filter: { status: 'notEnqueued' },
      page: 1,
      pageSize: 12,
    });
    expect(listed.total).toBe(1);
    expect(listed.items.map((card) => card.id)).toEqual(['card-a1']);
    expect(service.listAnkiAgentLibraryCards({ page: 1, pageSize: 12 }).total).toBe(4);

    const current = listed.items[0]!;
    const updated = service.updateAnkiCardIfVersionForLibrary(
      { ...current, front: 'library-front' },
      current.updated_at,
    );
    expect(updated.type).toBe('updated');
    if (updated.type !== 'updated') throw new Error('expected library update');
    expect(updated.current.front).toBe('library-front');

    expect(service.updateAnkiCardIfVersionForLibrary(
      { ...current, front: 'stale' },
      current.updated_at,
    )).toMatchObject({ type: 'conflict', current: { front: 'library-front' } });

    expect(service.updateAnkiCardIfVersionForSession(
      { ...updated.current, back: 'session-back' },
      updated.current.updated_at,
      'sess-a',
    )).toMatchObject({ kind: 'updated', card: { back: 'session-back' } });

    expect(service.getAnkiAgentLibraryCardsByIds(['card-a2', 'card-a1'])
      .map((card) => card.id)).toEqual(['card-a2', 'card-a1']);
    expect(() => service.getAnkiAgentLibraryCardsByIds(['card-a1', 'missing-card']))
      .toThrow('library_cards_unavailable: missing-card');

    db.run(
      `INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, local_version, created_at, updated_at)
       VALUES ('state-f3', 'card-a2', 0, 1, ?1, ?1)`,
      [NOW],
    );
    db.run(
      `INSERT INTO fsrs_review_logs
         (id, card_state_id, anki_card_id, rating, state_before, state_after,
          review_ms, fsrs_params_version)
       VALUES ('log-f3', 'state-f3', 'card-a2', 3, 0, 1, 1, 'rs-fsrs-1.2')`,
    );
    expect(service.deleteAnkiCardForLibrary('card-a2', 'stale-version', 1)).toMatchObject({
      type: 'contentConflict',
      current: { id: 'card-a2' },
    });
    expect(service.deleteAnkiCardForLibrary('card-a2', NOW, 0)).toMatchObject({
      type: 'reviewConflict',
      review: { ankiCardId: 'card-a2', reviewVersion: 1n },
    });
    expect(() => service.deleteAnkiCardForLibrary('card-a2', NOW, 1.5))
      .toThrow('expectedReviewVersion must be a non-negative integer or null');
    expect(() => service.deleteAnkiCardForLibrary('card-a2', NOW, -1))
      .toThrow('expectedReviewVersion must be a non-negative integer or null');
    expect(service.deleteAnkiCardForLibrary('card-a2', NOW, 1)).toMatchObject({
      type: 'deleted',
      locator: { documentId: 'doc-a', sourceSessionId: 'sess-a' },
    });
    expect(db.pluck<string>('SELECT id FROM anki_cards WHERE id = ?1', ['card-a2']))
      .toBeUndefined();
    expect(db.pluck<number>(
      'SELECT COUNT(*) FROM fsrs_card_states WHERE anki_card_id = ?1', ['card-a2'],
    )).toBe(0);
    expect(db.pluck<number>(
      'SELECT COUNT(*) FROM fsrs_review_logs WHERE anki_card_id = ?1', ['card-a2'],
    )).toBe(0);
  });

  it('getAnkiAgentLibraryCard reads one live library card with its task locator (get_anki_agent_library_card)', () => {
    seedOwnedDocument();
    insertTask(db, { id: 'task-blank', documentId: 'doc-blank', sessionId: '  ' });
    insertCard(db, { id: 'card-blank', taskId: 'task-blank' });
    db.run(
      `INSERT INTO fsrs_card_states (id, anki_card_id, due_ms, created_at, updated_at)
       VALUES ('state-a1', 'card-a1', 1000, ?1, ?1)`,
      [NOW],
    );

    const record = service.getAnkiAgentLibraryCard(' card-a1 ', 1000);
    expect(record).toMatchObject({
      libraryCard: {
        id: 'card-a1', task_id: 'task-a', front: 'front-card-a1', extra_fields: { Extra: 'extra-a1' },
        sourceType: 'document', sourceId: 'doc-a', sourceSessionId: 'sess-a', sourceRef: null,
        stateId: 'state-a1', dueMs: 1000, enqueued: true, suspended: false, isDue: true,
      },
      locator: { documentId: 'doc-a', sourceSessionId: 'sess-a' },
    });
    expect(service.getAnkiAgentLibraryCard('card-a1', 999)?.libraryCard.isDue).toBe(false);
    // The locator keeps the raw column; only the card's sourceSessionId drops blanks (mod.rs:318-325).
    expect(service.getAnkiAgentLibraryCard('card-blank')).toMatchObject({
      libraryCard: { sourceSessionId: null, enqueued: false },
      locator: { documentId: 'doc-blank', sourceSessionId: '  ' },
    });

    expect(service.getAnkiAgentLibraryCard('missing-card')).toBeNull();
    db.run('UPDATE anki_cards SET deleted_at = ?1 WHERE id = ?2', [NOW, 'card-a2']);
    expect(service.getAnkiAgentLibraryCard('card-a2')).toBeNull();
    db.run('UPDATE document_tasks SET deleted_at = ?1 WHERE id = ?2', [NOW, 'task-b']);
    expect(service.getAnkiAgentLibraryCard('card-b1')).toBeNull();
    expect(() => service.getAnkiAgentLibraryCard('')).toThrow('cardId is required');
    expect(() => service.getAnkiAgentLibraryCard(' \t')).toThrow('cardId is required');
  });

  it('F3 library delete fails closed without the L15 transaction owner', async () => {
    const noReview = await createAnkiTestEnv({ withReview: false });
    try {
      const isolated = noReview.host.ctx.anki as AnkiService;
      expect(() => isolated.deleteAnkiCardForLibrary('card-a1', NOW, null))
        .toThrow('review service does not publish the FSRS transaction surface');
    } finally {
      await noReview.dispose();
    }
  });

  it('documents reads and writes the same tasks table', () => {
    seedOwnedDocument();

    const tasks = service.documents.getTasksForDocument('doc-a');
    expect(tasks).toEqual([
      expect.objectContaining({
        id: 'task-a',
        document_id: 'doc-a',
        status: 'Completed',
        anki_generation_options_json: '{}',
      }),
    ]);
    expect(service.documents.getDocumentSessionSource('doc-a')).toBe('sess-a');
    expect(service.documents.getDocumentSessionSource('doc-b')).toBe('sess-b');

    service.documents.insertDocumentTask(taskFixture('task-c', 'doc-c'));
    expect(service.documents.getTasksForDocument('doc-c')).toEqual([
      expect.objectContaining({ id: 'task-c', segment_index: 2, status: 'Pending' }),
    ]);
    expect(service.documents.getDocumentSessionSource('doc-c')).toBeNull();
    service.documents.setDocumentSessionSource('doc-c', 'sess-c');
    expect(service.documents.getDocumentSessionSource('doc-c')).toBe('sess-c');
  });

  it('settings and preference memory hit the published F4 store and L16 pure functions', () => {
    service.settings.saveSetting(SETTINGS_KEY, '{"entries":[]}');
    expect(service.settings.getSetting(SETTINGS_KEY)).toBe('{"entries":[]}');
    expect(db.pluck<string>('SELECT value FROM settings WHERE key = ?1', [SETTINGS_KEY]))
      .toBe('{"entries":[]}');

    const store = service.preferenceMemory.emptyStore();
    expect(store).toEqual({ entries: [] });
    const outcome = service.preferenceMemory.consolidateObservation(store, {
      extraRequirements:
        '请用中文回答，不要翻译专业术语，每份材料最多 7 张卡，请用学术填空题模板',
      edits: [],
      deletions: [],
      generatedCount: 7,
      templateUsed: '学术填空题',
    }, 1_000);
    expect(outcome.added).toHaveLength(4);
    expect(store.entries).toHaveLength(4);
    expect(store.entries.map((entry) => entry.kind).sort()).toEqual([
      'card_density', 'language', 'no_translation', 'template_preference',
    ]);
  });

  it('chatBlocks maps real L04 session/message/block rows', () => {
    const session = env.host.ctx.chatSession;
    session.createSession({
      id: 'sess-chat-surface',
      mode: 'chat',
      title: 'surface',
      titleLocked: false,
      persistStatus: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    session.createMessage({
      id: 'msg-chat-surface',
      sessionId: 'sess-chat-surface',
      role: 'assistant',
      blockIds: ['block-chat-surface'],
      timestamp: 1,
    });
    session.createBlock({
      id: 'block-chat-surface',
      messageId: 'msg-chat-surface',
      type: 'anki_cards',
      status: 'running',
      content: 'keep-content',
      toolName: 'chatanki_run',
      toolOutput: { cards: [] },
    });

    expect(service.chatBlocks.listSessionBlocks('sess-chat-surface')).toEqual([
      expect.objectContaining({
        id: 'block-chat-surface',
        sessionId: 'sess-chat-surface',
        type: 'anki_cards',
        status: 'running',
        toolName: 'chatanki_run',
        toolOutput: { cards: [] },
      }),
    ]);
    expect(service.chatBlocks.getBlock('block-chat-surface')).toMatchObject({
      id: 'block-chat-surface',
      sessionId: 'sess-chat-surface',
    });
    expect(service.chatBlocks.getBlock('missing-block')).toBeNull();

    service.chatBlocks.updateBlock({
      ...service.chatBlocks.getBlock('block-chat-surface')!,
      status: 'error',
      error: 'generation_failed',
      toolOutput: { cards: [{ id: 'card-1' }] },
    });
    expect(session.getBlock('block-chat-surface')).toMatchObject({
      status: 'error',
      error: 'generation_failed',
      content: 'keep-content',
      toolOutput: { cards: [{ id: 'card-1' }] },
    });

    service.chatBlocks.upsertBlock({
      id: 'block-chat-new',
      sessionId: 'sess-chat-surface',
      messageId: 'msg-chat-surface',
      type: 'anki_cards',
      status: 'running',
      toolName: 'chatanki_run',
      toolOutput: { cards: [] },
      blockIndex: 2,
      startedAt: 10,
      firstChunkAt: 10,
    });
    expect(session.getMessageBlocks('msg-chat-surface')).toHaveLength(2);
    service.chatBlocks.upsertBlock({
      ...service.chatBlocks.getBlock('block-chat-new')!,
      status: 'completed',
      toolOutput: { cards: [{ id: 'card-2' }] },
      endedAt: 20,
    });
    expect(session.getBlock('block-chat-new')).toMatchObject({
      status: 'completed',
      toolOutput: { cards: [{ id: 'card-2' }] },
    });
    expect(session.getBlock('block-chat-new')?.endedAt).toBe(20);
  });

  it('chatBlocks.upsertBlock appends the block id to its message and creates the orphan placeholder (chatanki_executor.rs:14592-14727)', () => {
    const session = env.host.ctx.chatSession;
    const createSession = (id: string): void => session.createSession({
      id, mode: 'chat', title: id, titleLocked: false, persistStatus: 'active', createdAt: NOW, updatedAt: NOW,
    });
    const upsert = (id: string, messageId: string): void => service.chatBlocks.upsertBlock({
      id, sessionId: '', messageId, type: 'anki_cards', status: 'running', toolName: 'chatanki_run',
      toolOutput: { cards: [] }, blockIndex: 1, startedAt: 10, firstChunkAt: 10, endedAt: null,
    });

    createSession('sess-upsert-append');
    session.createMessage({ id: 'msg-upsert-append', sessionId: 'sess-upsert-append', role: 'assistant', blockIds: [], timestamp: 1 });
    session.createBlock({ id: 'block-upsert-old', messageId: 'msg-upsert-append', type: 'anki_cards', status: 'running' });
    upsert('block-upsert-old', 'msg-upsert-append');
    upsert('block-upsert-new', 'msg-upsert-append');
    upsert('block-upsert-new', 'msg-upsert-append');
    expect(session.getMessage('msg-upsert-append')?.blockIds).toEqual(['block-upsert-old', 'block-upsert-new']);

    createSession('sess_orphan-surface');
    upsert('block-orphan', 'msg_orphan-surface');
    expect(session.getMessage('msg_orphan-surface')).toMatchObject({
      sessionId: 'sess_orphan-surface', role: 'assistant', blockIds: ['block-orphan'],
    });
    expect(session.getBlock('block-orphan')).toMatchObject({ messageId: 'msg_orphan-surface', status: 'running' });

    const longMessageId = `msg_${'x'.repeat(50)}`;
    createSession(`sess_${'x'.repeat(35)}`);
    upsert('block-orphan-long', longMessageId);
    expect(session.getMessage(longMessageId)?.sessionId).toBe(`sess_${'x'.repeat(35)}`);

    expect(() => upsert('block-orphan-missing', 'no-session-message')).toThrow();
    expect(session.getMessage('no-session-message')).toBeNull();
    expect(session.getBlock('block-orphan-missing')).toBeNull();
  });

  it('chatBlocks.upsertBlock overwrites content, tool input and citations with NULL like the ON CONFLICT update (chatanki_executor.rs:14651-14700)', () => {
    const session = env.host.ctx.chatSession;
    session.createSession({
      id: 'sess-upsert-null', mode: 'chat', title: 'sess-upsert-null', titleLocked: false, persistStatus: 'active', createdAt: NOW, updatedAt: NOW,
    });
    session.createMessage({ id: 'msg-upsert-null', sessionId: 'sess-upsert-null', role: 'assistant', blockIds: [], timestamp: 1 });
    session.createBlock({
      id: 'block-upsert-null', messageId: 'msg-upsert-null', type: 'anki_cards', status: 'running',
      content: 'stale-content', toolInput: { goal: 'old' }, citations: [{ type: 'rag', title: 'old' }],
    });

    service.chatBlocks.upsertBlock({
      id: 'block-upsert-null', sessionId: '', messageId: 'msg-upsert-null', type: 'anki_cards', status: 'completed',
      toolName: 'chatanki_run', toolOutput: { cards: [{ id: 'card-3' }] }, blockIndex: 1, startedAt: 10, firstChunkAt: 10, endedAt: 20,
    });

    const stored = session.getBlock('block-upsert-null');
    expect({ content: stored?.content ?? null, toolInput: stored?.toolInput ?? null, citations: stored?.citations ?? null })
      .toEqual({ content: null, toolInput: null, citations: null });
    expect(stored).toMatchObject({ status: 'completed', toolOutput: { cards: [{ id: 'card-3' }] }, endedAt: 20 });
  });

  it('apkgImporter runs the real APKG pipeline and keeps internal cardIds', () => {
    const collectionPath = path.join(env.dir, 'collection.anki2');
    const apkg = buildZip([{
      name: 'collection.anki2',
      data: collectionBytes(env, collectionPath, 'imported front'),
    }]);

    const imported = service.apkgImporter.importBytes(
      apkg, 'surface.apkg', 'sess-import',
    );
    expect(imported.importedCards).toBe(1);
    expect(imported.cardIds).toHaveLength(1);
    expect(imported.warnings).toEqual([]);
    expect(service.documents.getDocumentSessionSource(imported.documentId))
      .toBe('sess-import');
    expect(service.cards.getCardsForDocument(imported.documentId).map((card) => card.front))
      .toEqual(['imported front']);

    const filePath = path.join(env.dir, 'path-import.apkg');
    fs.writeFileSync(filePath, buildZip([{
      name: 'collection.anki2',
      data: collectionBytes(env, path.join(env.dir, 'collection-path.anki2'), 'path front'),
    }]));
    const fromPath = service.apkgImporter.importPath(filePath, 'sess-import');
    expect(fromPath.importedCards).toBe(1);
    expect(fromPath.cardIds).toHaveLength(1);
  });

  it('apkgExporter writes a multi-template APKG the importer reads back (chatanki_executor.rs:5958-6063)', () => {
    const exporter = service.apkgExporter;
    expect(exporter.sanitizeFilenameWithExtension('a:b', 'chatanki_cards', 'apkg')).toBe('a_b.apkg');
    expect(exporter.sanitizeFilenameWithExtension('Deck.APKG', 'chatanki_cards', 'apkg')).toBe('Deck.APKG');
    expect(exporter.sanitizeFilenameWithExtension('  ', 'chatanki_cards', 'apkg')).toBe('chatanki_cards.apkg');

    const card: AnkiCard = {
      id: 'exported-card', task_id: '', front: 'exported front', back: 'exported back', text: null, tags: [], images: [],
      is_error_card: false, error_content: null, created_at: NOW, updated_at: NOW, extra_fields: {}, template_id: null,
    };
    const out = path.join(env.dir, exporter.sanitizeFilenameWithExtension('Exported', 'chatanki_cards', 'apkg'));
    expect(exporter.exportMultiTemplateReport([card], 'Exported', out, new Map()))
      .toEqual({ exportedMedia: 0, missingMedia: [], warnings: [] });
    const imported = service.apkgImporter.importPath(out, null);
    expect(service.cards.getCardsForDocument(imported.documentId).map((row) => [row.front, row.back]))
      .toEqual([['exported front', 'exported back']]);
    expect(() => exporter.exportMultiTemplateReport([], 'Exported', out, new Map())).toThrow('没有卡片可以导出');
  });

  it('apkgVfs resolves L11 file/resource rows and reads real blob bytes', () => {
    const vfsDb = env.storage.database('vfs');
    const blobsDir = env.host.ctx.vfsDatabase.blobsDir();
    const blobHash = 'surface-blob-hash';
    const blobDir = path.join(blobsDir, 'surface');
    fs.mkdirSync(blobDir, { recursive: true });
    fs.writeFileSync(path.join(blobDir, 'apkg.bin'), Buffer.from('apkg-bytes'));

    vfsDb.exec(`
      CREATE TABLE IF NOT EXISTS resources (
        id TEXT PRIMARY KEY, hash TEXT NOT NULL UNIQUE, type TEXT NOT NULL,
        source_id TEXT, source_table TEXT, storage_mode TEXT NOT NULL DEFAULT 'inline',
        data TEXT, external_hash TEXT, metadata_json TEXT, ref_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
        deleted_reason TEXT, index_state TEXT, index_hash TEXT, index_error TEXT,
        indexed_at INTEGER, index_retry_count INTEGER, ocr_text TEXT,
        mm_index_state TEXT, mm_index_error TEXT, mm_index_retry_count INTEGER,
        mm_embedding_dim INTEGER, mm_indexing_mode TEXT, mm_indexed_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY, resource_id TEXT, blob_hash TEXT,
        sha256 TEXT NOT NULL UNIQUE, file_name TEXT NOT NULL, original_path TEXT,
        size INTEGER NOT NULL, page_count INTEGER, tags_json TEXT NOT NULL DEFAULT '[]',
        is_favorite INTEGER NOT NULL DEFAULT 0, last_opened_at TEXT, last_page INTEGER,
        bookmarks_json TEXT NOT NULL DEFAULT '[]', cover_key TEXT,
        status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL, deleted_at TEXT, type TEXT NOT NULL DEFAULT 'document',
        name TEXT, content_hash TEXT, description TEXT, mime_type TEXT,
        preview_json TEXT, extracted_text TEXT, ocr_pages_json TEXT,
        mm_indexed_pages_json TEXT, mm_index_state TEXT, mm_index_error TEXT,
        processing_status TEXT, processing_progress TEXT, processing_error TEXT,
        processing_started_at INTEGER, processing_completed_at INTEGER,
        compressed_blob_hash TEXT
      );
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY, relative_path TEXT NOT NULL, size INTEGER NOT NULL,
        mime_type TEXT, ref_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
      );
    `);
    vfsDb.run(
      `INSERT INTO resources (id, hash, type, source_id, created_at, updated_at)
       VALUES ('res_surface', 'resource-hash', 'file', NULL, 1, 1)`,
    );
    vfsDb.run(
      `INSERT INTO blobs (hash, relative_path, size, ref_count, created_at)
       VALUES (?1, 'surface/apkg.bin', 10, 1, 1)`,
      [blobHash],
    );
    vfsDb.run(
      `INSERT INTO files (id, resource_id, blob_hash, sha256, file_name, original_path,
                          size, created_at, updated_at)
       VALUES ('file_surface', 'res_surface', ?1, 'sha-surface', 'surface.apkg', NULL,
               10, ?2, ?2)`,
      [blobHash, NOW],
    );

    expect(service.apkgVfs.resolveApkgFile('file_surface')).toMatchObject({
      resourceId: 'file_surface',
      file: {
        id: 'file_surface',
        resourceId: 'res_surface',
        fileName: 'surface.apkg',
        blobHash,
        size: 10,
      },
    });
    expect(service.apkgVfs.resolveApkgFile('res_surface')).toMatchObject({
      resourceId: 'file_surface',
    });
    expect(service.apkgVfs.readBlob(blobHash)).toEqual(Buffer.from('apkg-bytes'));
    expect(service.apkgVfs.readBlob('missing-blob')).toBeNull();
    expect(() => service.apkgVfs.resolveApkgFile('mm_surface'))
      .toThrow("Resource 'mm_surface' is a mindmap resource");

    // Rust chatanki_executor.rs:10642-10653 filters the joined resource tombstone,
    // even if the file is still live. getResource intentionally includes deleted rows.
    vfsDb.run("UPDATE resources SET deleted_at = 2 WHERE id = 'res_surface'");
    expect(env.host.ctx.vfsRepo.resources.getResource(vfsDb, 'res_surface')).not.toBeNull();
    expect(service.apkgVfs.resolveApkgFile('file_surface')).toBeNull();
    // Rust :10615-10622 finds the live file first, then returns None when its resource is deleted.
    expect(service.apkgVfs.resolveApkgFile('res_surface')).toBeNull();
    vfsDb.run("UPDATE resources SET deleted_at = NULL WHERE id = 'res_surface'");
    expect(service.apkgVfs.resolveApkgFile('res_surface')).toMatchObject({ resourceId: 'file_surface' });

    // Rust :10570-10579 still reads raw res_ metadata: an alias may name another live source.
    // Do not mechanically change that getResource call to getLiveResource.
    vfsDb.run(`INSERT INTO resources (id, hash, type, source_id, created_at, updated_at, deleted_at)
      VALUES ('res_surface_alias', 'alias-hash', 'file', 'file_surface', 1, 1, 2)`);
    expect(service.apkgVfs.resolveApkgFile('res_surface_alias')).toMatchObject({ resourceId: 'file_surface' });

    vfsDb.run("UPDATE files SET deleted_at = ?1 WHERE id = 'file_surface'", [NOW]);
    expect(service.apkgVfs.resolveApkgFile('file_surface')).toBeNull();
    expect(() => service.apkgVfs.resolveApkgFile('res_surface')).toThrow(
      "Resource 'res_surface' exists, but chatanki_run cannot map it to a readable file/image source ID.",
    );
    vfsDb.run("UPDATE files SET deleted_at = NULL WHERE id = 'file_surface'");

    // A missing joined resource cannot supply the required hash (Rust :10669-10672).
    vfsDb.run("UPDATE files SET resource_id = NULL WHERE id = 'file_surface'");
    expect(service.apkgVfs.resolveApkgFile('file_surface')).toBeNull();
    vfsDb.run("UPDATE files SET resource_id = 'res_surface' WHERE id = 'file_surface'");

    const original = path.join(env.dir, 'original.apkg');
    fs.writeFileSync(original, Buffer.from('original-bytes'));
    expect(service.apkgVfs.isVirtualUri('content://media/1')).toBe(true);
    expect(service.apkgVfs.isVirtualUri(original)).toBe(false);
    expect(service.apkgVfs.isFile(original)).toBe(true);
    expect(service.apkgVfs.statFile(original)).toEqual({ size: 14 });
    expect(service.apkgVfs.readFile(original)).toEqual(Buffer.from('original-bytes'));
  });
});
