/**
 * `tests/anki_nullable_card_reads.rs`（4 条待移植用例）的移植。
 *
 * 历史库的 `front/back/text/tags_json/images_json/extra_fields_json` 可以为 NULL；
 * 读侧必须兜底为空串/空集合，且非法 JSON 软解析为空集合，不能让整批读取失败。
 * 测试用裸建表复现历史 schema（迁移后的新库带 NOT NULL，无法插入坏行）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { decodeAnkiCardRow } from '../src/anki-cards.ts';
import {
  getCardsByIds,
  getCardsForDocumentForSession,
  listCardsForDocument,
  listCardsForTask,
  listRecentCards,
} from '../repository/anki-cards.ts';
import { listFeedbackRows } from '../repository/anki-fsrs-feedback.ts';
import { createAnkiTestEnv, type AnkiTestEnv } from './env.ts';

const LEGACY_SCHEMA: readonly string[] = [
  `CREATE TABLE document_tasks (
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
  )`,
  `CREATE TABLE anki_cards (
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
  )`,
  `CREATE TABLE fsrs_card_states (
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
  )`,
];

function openLegacyDb(env: AnkiTestEnv): DatabaseHandle {
  const file = path.join(env.dir, 'legacy-mistakes.db');
  fs.rmSync(file, { force: true });
  const db = env.storage.openFile(file);
  db.batch(LEGACY_SCHEMA.map((query) => ({ query })));
  return db;
}

function seedTask(db: DatabaseHandle, taskId: string, documentId: string, sessionId: string): void {
  db.run(
    `INSERT INTO document_tasks (id, document_id, original_document_name, source_session_id)
     VALUES (?1, ?2, 'legacy.md', ?3)`,
    [taskId, documentId, sessionId],
  );
}

function seedCard(
  db: DatabaseHandle,
  cardId: string,
  taskId: string,
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
     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
    [cardId, taskId, front, back, text, tagsJson, imagesJson, extraFieldsJson, createdAt],
  );
}

function seedStandardFixture(db: DatabaseHandle): void {
  seedTask(db, 'task-legacy', 'doc-legacy', 'sess-legacy');
  seedCard(
    db,
    'card-null',
    'task-legacy',
    null,
    null,
    null,
    null,
    null,
    null,
    '2026-08-20T08:00:01.000Z',
  );
  seedCard(
    db,
    'card-ok',
    'task-legacy',
    'front-ok',
    'back-ok',
    'text {{c1::ok}}',
    '["tag-a","tag-b"]',
    '["img-1.png"]',
    '{"hint":"h1"}',
    '2026-08-20T08:00:02.000Z',
  );
  seedCard(
    db,
    'card-badjson',
    'task-legacy',
    'front-bad',
    'back-bad',
    null,
    '{not-json',
    'also-not-json',
    '[broken',
    '2026-08-20T08:00:03.000Z',
  );
}

function assertNullCardDefaults(card: ReturnType<typeof decodeAnkiCardRow>): void {
  expect(card.id).toBe('card-null');
  expect(card.front).toBe('');
  expect(card.back).toBe('');
  expect(card.text).toBeNull();
  expect(card.tags).toEqual([]);
  expect(card.images).toEqual([]);
  expect(card.extra_fields).toEqual({});
}

function assertOkCardIntact(card: ReturnType<typeof decodeAnkiCardRow>): void {
  expect(card.id).toBe('card-ok');
  expect(card.front).toBe('front-ok');
  expect(card.back).toBe('back-ok');
  expect(card.text).toBe('text {{c1::ok}}');
  expect(card.tags).toEqual(['tag-a', 'tag-b']);
  expect(card.images).toEqual(['img-1.png']);
  expect(card.extra_fields.hint).toBe('h1');
}

describe('tests/anki_nullable_card_reads.rs', () => {
  it('get_cards_for_task_defaults_null_columns_instead_of_failing_the_batch', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = openLegacyDb(env);
      seedStandardFixture(db);

      const cards = listCardsForTask(db, 'task-legacy').map(decodeAnkiCardRow);
      expect(cards).toHaveLength(3);

      assertNullCardDefaults(cards[0]!);
      assertOkCardIntact(cards[1]!);

      const bad = cards[2]!;
      expect(bad.id).toBe('card-badjson');
      expect(bad.front).toBe('front-bad');
      expect(bad.tags).toEqual([]);
      expect(bad.images).toEqual([]);
      expect(bad.extra_fields).toEqual({});
    } finally {
      await env.dispose();
    }
  });

  it('document_id_and_recent_reads_share_the_same_null_defaults', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = openLegacyDb(env);
      seedStandardFixture(db);

      const byDocument = listCardsForDocument(db, 'doc-legacy').map(decodeAnkiCardRow);
      expect(byDocument).toHaveLength(3);
      assertNullCardDefaults(byDocument[0]!);
      assertOkCardIntact(byDocument[1]!);

      const byIds = getCardsByIds(db, ['card-null', 'card-ok']).map(decodeAnkiCardRow);
      expect(byIds).toHaveLength(2);
      assertNullCardDefaults(byIds[0]!);
      assertOkCardIntact(byIds[1]!);

      const recent = listRecentCards(db, 10).map(decodeAnkiCardRow);
      expect(recent).toHaveLength(3);
      assertNullCardDefaults(recent[2]!);
    } finally {
      await env.dispose();
    }
  });

  it('session_scoped_read_uses_shared_mapper_defaults_and_keeps_ownership_guard', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = openLegacyDb(env);
      seedStandardFixture(db);

      const ownedRows = getCardsForDocumentForSession(db, 'doc-legacy', 'sess-legacy');
      expect(ownedRows).not.toBeNull();
      const owned = ownedRows!.map(decodeAnkiCardRow);
      expect(owned).toHaveLength(3);
      assertNullCardDefaults(owned[0]!);
      assertOkCardIntact(owned[1]!);

      const foreign = getCardsForDocumentForSession(db, 'doc-legacy', 'sess-other');
      expect(foreign).toBeNull();
    } finally {
      await env.dispose();
    }
  });

  it('fsrs_feedback_rows_default_null_front_and_tags', async () => {
    const env = await createAnkiTestEnv();
    try {
      const db = openLegacyDb(env);
      seedStandardFixture(db);
      db.run(
        `INSERT INTO fsrs_card_states
           (id, anki_card_id, state, stability, due_ms, lapses, reps, last_review_ms)
         VALUES ('fs-null', 'card-null', 2, 2.5, 0, 4, 6, 1000)`,
      );

      const rows = listFeedbackRows(db, 10);
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.ankiCardId).toBe('card-null');
      expect(row.front).toBe('');
      expect(row.tags).toEqual([]);
      expect(row.lapses).toBe(4);
      expect(row.stability).toBe(2.5);
    } finally {
      await env.dispose();
    }
  });
});
