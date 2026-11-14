import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import {
  getReviewStatesForLibrary,
  listAnkiLibraryCardsFiltered,
  listAnkiLibraryDeckCounts,
} from '../repository/anki-cards.ts';
import { rfc3339FromMillis } from '../src/time.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

/**
 * `tests/anki_nullable_card_reads.rs` 的历史库最小 schema：六个目标文本列不带 NOT NULL。
 * 迁移后的 mistakes 库会拒绝这些 NULL 行，因此与 Rust 测试一样先建历史形态库。
 */
const LEGACY_SCHEMA = `
  CREATE TABLE document_tasks (
      id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      original_document_name TEXT NOT NULL DEFAULT '',
      segment_index INTEGER NOT NULL DEFAULT 0,
      content_segment TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'Completed',
      created_at TEXT NOT NULL DEFAULT '2026-08-01T00:00:00.000Z',
      updated_at TEXT NOT NULL DEFAULT '2026-08-01T00:00:00.000Z',
      anki_generation_options_json TEXT NOT NULL DEFAULT '{}',
      source_session_id TEXT,
      deleted_at TEXT
  );
  CREATE TABLE anki_cards (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      front TEXT,
      back TEXT,
      text TEXT,
      tags_json TEXT,
      images_json TEXT,
      extra_fields_json TEXT,
      is_error_card INTEGER NOT NULL DEFAULT 0,
      error_content TEXT,
      card_order_in_task INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      template_id TEXT,
      source_type TEXT,
      source_id TEXT,
      deleted_at TEXT
  );
  CREATE TABLE fsrs_card_states (
      id TEXT PRIMARY KEY,
      anki_card_id TEXT NOT NULL,
      state INTEGER NOT NULL DEFAULT 0,
      stability REAL,
      difficulty REAL,
      due_ms INTEGER NOT NULL DEFAULT 0,
      lapses INTEGER NOT NULL DEFAULT 0,
      reps INTEGER NOT NULL DEFAULT 0,
      last_review_ms INTEGER,
      suspended INTEGER DEFAULT 0,
      deleted_at TEXT
  );
`;

function seedLegacyCard(
  db: DatabaseHandle,
  cardId: string,
  front: string | null,
  back: string | null,
  text: string | null,
  tagsJson: string | null,
  imagesJson: string | null,
  extraFieldsJson: string | null,
  createdAt: string,
): void {
  db.run(
    `INSERT INTO anki_cards (
        id, task_id, front, back, text, tags_json, images_json, extra_fields_json,
        created_at, updated_at
     ) VALUES (?1, 'task-legacy', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)`,
    [cardId, front, back, text, tagsJson, imagesJson, extraFieldsJson, createdAt],
  );
}

describe('tests/anki_nullable_card_reads.rs', () => {
  it('library_listing_survives_null_rows_and_reports_full_totals', async () => {
    const env = await createAnkiTestEnv({ migrate: false });
    try {
      const db = env.storage.database('mistakes');
      db.exec(LEGACY_SCHEMA);
      db.run(
        `INSERT INTO document_tasks (id, document_id, original_document_name, source_session_id)
         VALUES ('task-legacy', 'doc-legacy', 'legacy.md', 'sess-legacy')`,
      );
      // 六个目标列全 NULL 的历史坏行
      seedLegacyCard(db, 'card-null', null, null, null, null, null, null, '2026-08-20T08:00:01.000Z');
      // 健康对照行
      seedLegacyCard(
        db,
        'card-ok',
        'front-ok',
        'back-ok',
        'text {{c1::ok}}',
        '["tag-a","tag-b"]',
        '["img-1.png"]',
        '{"hint":"h1"}',
        '2026-08-20T08:00:02.000Z',
      );
      // 非 NULL 但内容损坏的 JSON：软解析兜底为空集合
      seedLegacyCard(
        db,
        'card-badjson',
        'front-bad',
        'back-bad',
        null,
        '{not-json',
        'also-not-json',
        '[broken',
        '2026-08-20T08:00:03.000Z',
      );
      db.run(
        `INSERT INTO fsrs_card_states (id, anki_card_id, state, stability, due_ms, lapses, reps, last_review_ms)
         VALUES ('fs-ok', 'card-ok', 2, 3.0, 0, 1, 3, 1000)`,
      );

      const listing = listAnkiLibraryCardsFiltered(db, null, null, {}, 1, 50, Date.now());
      expect(listing.total).toBe(3);
      expect(listing.items).toHaveLength(3);
      expect(listing.statusCounts).toMatchObject({ all: 3, review: 1, notEnqueued: 2 });

      const nullRow = listing.items.find((card) => card.id === 'card-null');
      expect(nullRow).toBeDefined();
      expect(nullRow?.front).toBe('');
      expect(nullRow?.back).toBe('');
      expect(nullRow?.text).toBeNull();
      expect(nullRow?.tags).toEqual([]);
      expect(nullRow?.images).toEqual([]);
      expect(nullRow?.extra_fields).toEqual({});
      expect(nullRow?.enqueued).toBe(false);
      expect(nullRow?.state).toBeNull();

      const okRow = listing.items.find((card) => card.id === 'card-ok');
      expect(okRow?.front).toBe('front-ok');
      expect(okRow?.enqueued).toBe(true);
      expect(okRow?.state).toBe(2);

      const badJsonRow = listing.items.find((card) => card.id === 'card-badjson');
      expect(badJsonRow?.tags).toEqual([]);
      expect(badJsonRow?.images).toEqual([]);
      expect(badJsonRow?.extra_fields).toEqual({});
    } finally {
      await env.dispose();
    }
  });
});

interface TaskSeed {
  id: string;
  documentId?: string;
  optionsJson?: string;
  sourceSessionId?: string | null;
  createdAt?: string;
  deletedAt?: string | null;
}

interface CardSeed {
  id: string;
  taskId: string;
  front: string;
  tags?: string[];
  sourceType?: string;
  sourceId?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

interface StateSeed {
  id: string;
  cardId: string;
  state: number;
  dueMs: number;
  suspended?: boolean;
  lastReviewMs?: number | null;
  updatedAt?: string;
  localVersion?: number;
  reps?: number;
  lapses?: number;
  leech?: boolean;
  learningStep?: number;
}

function insertTask(db: DatabaseHandle, seed: TaskSeed): void {
  db.run(
    `INSERT INTO document_tasks
       (id, document_id, original_document_name, segment_index, content_segment,
        status, created_at, updated_at, error_message, anki_generation_options_json,
        source_session_id, deleted_at)
     VALUES (?1, ?2, 'doc.md', 0, 'segment', 'Completed', ?3, ?3, NULL, ?4, ?5, ?6)`,
    [
      seed.id,
      seed.documentId ?? 'doc-1',
      seed.createdAt ?? '2026-01-01T00:00:00Z',
      seed.optionsJson ?? '{}',
      seed.sourceSessionId ?? null,
      seed.deletedAt ?? null,
    ],
  );
}

function insertCard(db: DatabaseHandle, seed: CardSeed): void {
  db.run(
    `INSERT INTO anki_cards
       (id, task_id, front, back, text, tags_json, images_json,
        is_error_card, error_content, card_order_in_task, created_at, updated_at,
        extra_fields_json, template_id, source_type, source_id, deleted_at)
     VALUES (?1, ?2, ?3, ?4, NULL, ?5, '[]', 0, NULL, 0, ?6, ?7, '{}', NULL, ?8, ?9, ?10)`,
    [
      seed.id,
      seed.taskId,
      seed.front,
      `back-${seed.id}`,
      JSON.stringify(seed.tags ?? []),
      seed.createdAt ?? '2026-01-01T00:00:00Z',
      seed.updatedAt ?? '2026-01-01T00:00:00Z',
      seed.sourceType ?? 'document',
      seed.sourceId ?? 'doc-1',
      seed.deletedAt ?? null,
    ],
  );
}

function insertState(db: DatabaseHandle, seed: StateSeed): void {
  db.run(
    `INSERT INTO fsrs_card_states
       (id, anki_card_id, deck_id, state, stability, difficulty,
        elapsed_days, scheduled_days, reps, lapses, due_ms, last_review_ms,
        suspended, fsrs_params_version, desired_retention, created_at, updated_at,
        leech, buried_until_ms, learning_step, local_version)
     VALUES (?1, ?2, NULL, ?3, 3.5, 4.5, 1, 3, ?4, ?5, ?6, ?7,
             ?8, 'rs-fsrs-1.2', 0.9, ?9, ?9, ?10, NULL, ?11, ?12)`,
    [
      seed.id,
      seed.cardId,
      seed.state,
      seed.reps ?? 3,
      seed.lapses ?? 1,
      seed.dueMs,
      seed.lastReviewMs ?? null,
      seed.suspended === true ? 1 : 0,
      seed.updatedAt ?? '2026-01-02T00:00:00Z',
      seed.leech === true ? 1 : 0,
      seed.learningStep ?? 0,
      seed.localVersion ?? 0,
    ],
  );
}

function snapshotJson(cardId: string, stateId: string): string {
  // Rust `FsrsStateBeforeSnapshot` 用 `#[serde(rename_all = "camelCase")]` 写入
  // `state_before_json`；L15 的 undoable 校验按同一 wire 形状解析。
  return JSON.stringify({
    snapshotVersion: 1,
    cardStateId: stateId,
    ankiCardId: cardId,
    deckId: null,
    state: 2,
    stability: 3.5,
    difficulty: 4.5,
    elapsedDays: 1,
    scheduledDays: 3,
    reps: 3,
    lapses: 1,
    dueMs: 0,
    lastReviewMs: 1000,
    suspended: false,
    fsrsParamsVersion: 'rs-fsrs-1.2',
    desiredRetention: 0.9,
    leech: false,
    buriedUntilMs: null,
    learningStep: 0,
  });
}

interface LatestReview {
  logId: string;
  reviewedAt: string | null;
  rating: number;
  undoable: boolean;
}

interface LibraryItem {
  id: string;
  front: string;
  sourceType: string | null;
  sourceId: string | null;
  sourceSessionId: string | null;
  sourceRef: unknown;
  enqueued: boolean;
  version: string;
  reviewVersion: number | null;
  latestReview: LatestReview | null;
}

interface LibraryListResponse {
  items: LibraryItem[];
  page: number;
  pageSize: number;
  total: number;
  statusCounts: {
    all: number;
    due: number;
    new: number;
    learning: number;
    review: number;
    suspended: number;
    notEnqueued: number;
  };
  decks?: Array<{ name: string; all: number; due: number; new: number; notEnqueued: number }>;
}

const NOW = Date.now();

function seedLibraryFixture(db: DatabaseHandle): void {
  insertTask(db, {
    id: 'task-a',
    optionsJson: '{"deck_name":"语文","source_ref":{"kind":"chat","id":"c1"}}',
    sourceSessionId: 'sess-1',
    createdAt: '2026-01-01T00:00:01Z',
  });
  insertTask(db, {
    id: 'task-b',
    optionsJson: '{"deck_name":"语文::古诗"}',
    createdAt: '2026-01-01T00:00:02Z',
  });
  insertCard(db, {
    id: 'card-due',
    taskId: 'task-a',
    front: 'alpha',
    tags: ['literal%tag'],
    createdAt: '2026-01-01T00:00:05Z',
    updatedAt: '2026-01-02T00:00:00Z',
  });
  insertCard(db, {
    id: 'card-new',
    taskId: 'task-a',
    front: 'beta',
    createdAt: '2026-01-01T00:00:04Z',
    updatedAt: '2026-01-02T00:00:01Z',
  });
  insertCard(db, {
    id: 'card-learning',
    taskId: 'task-b',
    front: 'gamma',
    createdAt: '2026-01-01T00:00:03Z',
    updatedAt: '2026-01-02T00:00:02Z',
  });
  insertCard(db, {
    id: 'card-unenqueued',
    taskId: 'task-b',
    front: 'delta',
    createdAt: '2026-01-01T00:00:02Z',
    updatedAt: '2026-01-02T00:00:03Z',
  });
  insertCard(db, {
    id: 'card-suspended',
    taskId: 'task-b',
    front: 'epsilon',
    createdAt: '2026-01-01T00:00:01Z',
    updatedAt: '2026-01-02T00:00:04Z',
  });

  insertState(db, {
    id: 'state-due',
    cardId: 'card-due',
    state: 2,
    dueMs: NOW - 1000,
    lastReviewMs: 1000,
    updatedAt: '2026-01-02T00:00:00Z',
    localVersion: 7,
  });
  insertState(db, { id: 'state-new', cardId: 'card-new', state: 0, dueMs: 0 });
  insertState(db, { id: 'state-learning', cardId: 'card-learning', state: 1, dueMs: NOW + 3_600_000 });
  insertState(db, {
    id: 'state-suspended',
    cardId: 'card-suspended',
    state: 2,
    dueMs: NOW - 1000,
    suspended: true,
  });

  db.run(
    `INSERT INTO fsrs_review_logs
       (id, card_state_id, anki_card_id, rating, state_before, state_after,
        review_ms, fsrs_params_version, state_before_json, created_at, updated_at)
     VALUES ('log-0', 'state-due', 'card-due', 1, 1, 2, 500, 'rs-fsrs-1.2', NULL,
             '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`,
  );
  db.run(
    `INSERT INTO fsrs_review_logs
       (id, card_state_id, anki_card_id, rating, state_before, state_after,
        review_ms, fsrs_params_version, state_before_json, created_at, updated_at)
     VALUES ('log-1', 'state-due', 'card-due', 3, 2, 2, 1000, 'rs-fsrs-1.2', ?1,
             '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')`,
    [snapshotJson('card-due', 'state-due')],
  );
}

describe('src/cmd/enhanced_anki.rs::list_anki_library_cards', () => {
  let env: AnkiTestEnv;
  let db: DatabaseHandle;

  beforeAll(async () => {
    env = await createAnkiTestEnv();
    db = env.storage.database('mistakes');
  }, 120_000);

  afterAll(async () => {
    await env.dispose();
  });

  beforeEach(() => {
    db.run('DELETE FROM fsrs_review_logs');
    db.run('DELETE FROM fsrs_card_states');
    db.run('DELETE FROM anki_cards');
    db.run('DELETE FROM document_tasks');
    seedLibraryFixture(db);
  });

  it('returns status_counts_and_deck_counts', async () => {
    const response = await env.host.invoke<LibraryListResponse>('list_anki_library_cards', {
      request: { pageSize: 20, includeDecks: true },
    });
    expect(response.total).toBe(5);
    expect(response.page).toBe(1);
    expect(response.pageSize).toBe(20);
    expect(response.items).toHaveLength(5);
    expect(response.statusCounts).toEqual({
      all: 5,
      due: 1,
      new: 1,
      learning: 1,
      review: 1,
      suspended: 1,
      notEnqueued: 1,
    });
    expect(response.decks).toEqual([
      { name: '语文', all: 2, due: 1, new: 1, notEnqueued: 0 },
      { name: '语文::古诗', all: 3, due: 0, new: 0, notEnqueued: 1 },
    ]);
  });

  it('filters_by_status_deck_and_escaped_search', async () => {
    const ids = async (request: Record<string, unknown>): Promise<string[]> => {
      const response = await env.host.invoke<LibraryListResponse>('list_anki_library_cards', { request });
      return response.items.map((item) => item.id);
    };

    expect(await ids({ status: 'due' })).toEqual(['card-due']);
    expect(await ids({ status: 'new' })).toEqual(['card-new']);
    expect(await ids({ status: 'learning' })).toEqual(['card-learning']);
    expect(await ids({ status: 'review' })).toEqual(['card-due']);
    expect(await ids({ status: 'suspended' })).toEqual(['card-suspended']);
    expect(await ids({ status: 'notEnqueued' })).toEqual(['card-unenqueued']);
    // 牌组前缀匹配包含子牌组
    expect((await ids({ deck: '语文' })).sort()).toEqual(
      ['card-due', 'card-new', 'card-learning', 'card-unenqueued', 'card-suspended'].sort(),
    );
    expect((await ids({ deck: '语文::古诗' })).sort()).toEqual(
      ['card-learning', 'card-unenqueued', 'card-suspended'].sort(),
    );
    // LIKE 通配符按字面量转义：只有标签里真的含 "%" 的卡命中
    expect(await ids({ search: '%' })).toEqual(['card-due']);
    expect(await ids({ search: '_' })).toEqual([]);
    expect(await ids({ search: 'literal%tag' })).toEqual(['card-due']);
  });

  it('enriches_review_versions_and_undoable_latest_review', async () => {
    const response = await env.host.invoke<LibraryListResponse>('list_anki_library_cards', {
      request: { search: 'alpha' },
    });
    const due = response.items[0]!;
    expect(due.id).toBe('card-due');
    expect(due.version).toBe('2026-01-02T00:00:00Z');
    expect(due.reviewVersion).toBe(7);
    expect(due.latestReview).toEqual({
      logId: 'log-1',
      reviewedAt: rfc3339FromMillis(1000),
      rating: 3,
      undoable: true,
    });
    expect(due.sourceType).toBe('document');
    expect(due.sourceId).toBe('doc-1');
    expect(due.sourceSessionId).toBe('sess-1');
    expect(due.sourceRef).toEqual({ kind: 'chat', id: 'c1' });

    const newCard = await env.host.invoke<LibraryListResponse>('list_anki_library_cards', {
      request: { search: 'beta' },
    });
    expect(newCard.items[0]?.reviewVersion).toBe(0);
    expect(newCard.items[0]?.latestReview).toBeNull();

    const unenqueued = await env.host.invoke<LibraryListResponse>('list_anki_library_cards', {
      request: { search: 'delta' },
    });
    expect(unenqueued.items[0]?.reviewVersion).toBeNull();
    expect(unenqueued.items[0]?.latestReview).toBeNull();
  });

  it('sorts_unenqueued_cards_last', async () => {
    const response = await env.host.invoke<LibraryListResponse>('list_anki_library_cards', {
      request: { sort: 'due', sortDesc: false, pageSize: 20 },
    });
    expect(response.items[0]?.id).toBe('card-new');
    expect(response.items.at(-1)?.id).toBe('card-unenqueued');
  });

  it('lists_ungrouped_deck_and_paginates_with_live_totals', async () => {
    insertTask(db, { id: 'task-c', optionsJson: '{}', createdAt: '2026-01-01T00:00:03Z' });
    insertCard(db, { id: 'card-ungrouped', taskId: 'task-c', front: 'ungrouped' });

    const ungrouped = await env.host.invoke<LibraryListResponse>('list_anki_library_cards', {
      request: { deck: '' },
    });
    expect(ungrouped.items.map((item) => item.id)).toEqual(['card-ungrouped']);
    expect(ungrouped.statusCounts.notEnqueued).toBe(1);

    const firstPage = await env.host.invoke<LibraryListResponse>('list_anki_library_cards', {
      request: { page: 1, pageSize: 2 },
    });
    const secondPage = await env.host.invoke<LibraryListResponse>('list_anki_library_cards', {
      request: { page: 2, pageSize: 2 },
    });
    expect(firstPage.total).toBe(6);
    expect(secondPage.total).toBe(6);
    expect(firstPage.items).toHaveLength(2);
    expect(secondPage.items).toHaveLength(2);
    expect(firstPage.items.map((item) => item.id)).not.toEqual(secondPage.items.map((item) => item.id));
  });

  it('deck_counts_group_by_task_deck_and_exclude_deleted_cards', () => {
    insertTask(db, { id: 'task-c', optionsJson: '{}', createdAt: '2026-01-01T00:00:03Z' });
    insertCard(db, { id: 'card-ungrouped', taskId: 'task-c', front: 'ungrouped' });
    insertCard(db, {
      id: 'card-deleted',
      taskId: 'task-a',
      front: 'gone',
      deletedAt: '2026-01-02T00:00:00Z',
    });

    const decks = listAnkiLibraryDeckCounts(db, NOW);
    expect(decks).toEqual([
      { name: '', all: 1, due: 0, new: 0, notEnqueued: 1 },
      { name: '语文', all: 2, due: 1, new: 1, notEnqueued: 0 },
      { name: '语文::古诗', all: 3, due: 0, new: 0, notEnqueued: 1 },
    ]);
    expect(listAnkiLibraryCardsFiltered(db, null, null, {}, 1, 20, NOW).total).toBe(6);
  });

  it('local review-state reads parse the camelCase FsrsStateBeforeSnapshot like build_agent_snapshot', () => {
    const viaAnki = getReviewStatesForLibrary(db, ['card-due'])[0]!;
    const viaReview = env.host.ctx.review.getReviewStatesForLibrary('agent', ['card-due'])[0]!;
    expect(viaReview.latestReview?.undoable).toBe(true);
    expect(viaAnki.latestReview).toEqual(viaReview.latestReview);
  });

  it('review_state_reads_reject_duplicate_blank_and_deleted_cards', () => {
    expect(getReviewStatesForLibrary(db, ['card-due', 'card-due']).map((state) => state.ankiCardId)).toEqual([
      'card-due',
    ]);
    expect(() => getReviewStatesForLibrary(db, ['card-due', '  '])).toThrowError(
      'ankiCardIds must not contain empty IDs',
    );
    expect(() => getReviewStatesForLibrary(db, Array.from({ length: 101 }, (_, index) => `card-${index}`)))
      .toThrowError('ankiCardIds must contain at most 100 entries');
    insertCard(db, {
      id: 'card-deleted',
      taskId: 'task-a',
      front: 'gone',
      deletedAt: '2026-01-02T00:00:00Z',
    });
    expect(() => getReviewStatesForLibrary(db, ['card-deleted'])).toThrowError(
      'anki card not found: card-deleted',
    );
  });
});
