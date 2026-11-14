import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createMigratedStorage } from './support/storage.ts';
import { createPaths } from '../../../platform/paths/index.ts';
import qbank from '../index.ts';
import { vfsTestServices } from './support/vfs-ports.ts';
import type {
  CreateQuestionParams, LegacyMigrationAudit, LegacyMigrationReceipt, Question,
} from '../api.ts';

const NOW = '2026-01-01T00:00:00+00:00';
interface PreviewCardInput {
  card_id?: string; id?: string; question_label?: string; ocr_text?: string;
  question_type?: string; [key: string]: unknown;
}

function previewWith(cards: PreviewCardInput[]): Record<string, unknown> {
  return {
    pages: [{
      page_index: 0, blob_hash: 'page-blob-1', original_image_path: '/tmp/original-page-1.png',
      width: 1000, height: 1400, cards,
    }],
  };
}

function card(cardId: string, text: string, extra: Record<string, unknown> = {}): PreviewCardInput {
  return { card_id: cardId, question_label: cardId, ocr_text: text, question_type: 'short_answer', ...extra };
}

async function fixture(preview: Record<string, unknown>, metadata: Record<string, unknown> = {}) {
  const { storage, base } = await createMigratedStorage('qbank-legacy-');
  const db = storage.database('vfs');
  const host = await createTestHost({
    plugins: [qbank],
    provide: {
      storage,
      paths: createPaths({ dataDir: base, platform: process.platform === 'win32' ? 'win32'
        : process.platform === 'linux' ? 'linux' : 'darwin',
        env: { ...process.env, DEVICE_ID: 'qbank-test-device' } }),
      ...vfsTestServices(db),
    },
  });
  db.run(`INSERT INTO exam_sheets (id, exam_name, status, temp_id, metadata_json, preview_json,
      created_at, updated_at)
    VALUES ('exam_1', 'legacy audit', 'completed', 'tmp_legacy', ?1, ?2, ?3, ?3)`,
  [JSON.stringify(metadata), JSON.stringify(preview), NOW]);
  const create = async (cardId: string, content: string): Promise<Question> => host.invoke('qbank_create_question', {
    params: { exam_id: 'exam_1', card_id: cardId, question_label: cardId, content, answer: null,
      options: null, question_type: 'short_answer', difficulty: null, tags: [], source_type: 'imported' } as CreateQuestionParams,
  }) as Promise<Question>;
  return {
    host, db, storage, create,
    preview(): { pages: { blob_hash: string; original_image_path: string; cards: { card_id: string }[] }[] } {
      return JSON.parse(db.pluck<string>("SELECT preview_json FROM exam_sheets WHERE id = 'exam_1'")!);
    },
    setCanonicalMarker() {
      db.run(`UPDATE exam_sheets SET metadata_json = json_set(COALESCE(metadata_json, '{}'),
        '$.question_document_version', 2) WHERE id = 'exam_1'`);
    },
    async dispose() {
      await host.dispose();
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function audit(f: Fixture): Promise<LegacyMigrationAudit> {
  return f.host.invoke('qbank_legacy_audit', { examId: 'exam_1' }) as Promise<LegacyMigrationAudit>;
}

describe('qbank_legacy_reconcile.rs', () => {
  it('all_deleted_canonical_marker_never_recreates_preview_cards', async () => {
    const f = await fixture(previewWith([card('c1', 'legacy question')]));
    try {
      const created = await f.create('c1', 'formal question');
      await f.host.invoke('qbank_delete_question', { questionId: created.id });
      f.setCanonicalMarker();
      const result = await audit(f);
      expect(result.canonical_marker).toBe(true);
      expect(result.canonical_question_count).toBe(0);
      expect(result.migratable_card_ids).toEqual([]);
      expect(result.cards).toHaveLength(1);
      expect(result.cards[0]).toMatchObject({
        status: 'suppressed_canonical', deleted_question_ids: [created.id],
      });
      expect(result.pages[0]).toMatchObject({
        blob_hash: 'page-blob-1', original_image_path: '/tmp/original-page-1.png',
      });
      await expect(f.host.invoke('qbank_legacy_migrate_selected', {
        examId: 'exam_1', cardIds: ['c1'], expectedVersion: result.audit_version,
      })).rejects.toMatchObject({ error_type: 'Validation', message: expect.stringContaining('不可迁移') as string });
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL"))
        .toBe(0);
      expect(f.db.pluck<number>('SELECT COUNT(*) FROM questions WHERE id = ?1 AND deleted_at IS NOT NULL',
        [created.id])).toBe(1);
    } finally { await f.dispose(); }
  });

  it('more_than_one_hundred_cards_are_all_reported_without_truncation', async () => {
    const cards = Array.from({ length: 150 }, (_, index) => card(`card-${index}`, `legacy question ${index}`));
    const f = await fixture(previewWith(cards));
    try {
      const result = await audit(f);
      expect(result.cards).toHaveLength(150);
      expect(result.migratable_card_ids).toHaveLength(150);
      expect(result.unmatched_count).toBe(150);
      expect(result.pages[0]!.card_count).toBe(150);
    } finally { await f.dispose(); }
  });

  it('mapping_uses_card_id_or_id_never_label_or_content', async () => {
    const f = await fixture(previewWith([card('legacy-c1', 'same question text', { question_label: 'Q1' })]));
    try {
      await f.host.invoke('qbank_create_question', {
        params: { exam_id: 'exam_1', card_id: 'different-card', question_label: 'Q1',
          content: 'same question text', answer: null, options: null, question_type: 'short_answer',
          difficulty: null, tags: [], source_type: 'imported' } as CreateQuestionParams,
      });
      const result = await audit(f);
      expect(result.cards[0]!.status).toBe('unmatched');
      expect(result.cards[0]!.formal_question_id).toBeNull();
      expect(result.migratable_card_ids).toEqual(['legacy-c1']);
    } finally { await f.dispose(); }
  });

  it('stale_audit_version_is_rejected_before_any_question_is_created', async () => {
    const f = await fixture(previewWith([card('c1', 'legacy one'), card('c2', 'legacy two')]));
    try {
      const stale = await audit(f);
      await f.create('c2', 'formal two');
      await expect(f.host.invoke('qbank_legacy_migrate_selected', {
        examId: 'exam_1', cardIds: ['c1'], expectedVersion: stale.audit_version,
      })).rejects.toMatchObject({
        error_type: 'Conflict', message: expect.stringContaining('审计已变化') as string,
      });
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL"))
        .toBe(1);
    } finally { await f.dispose(); }
  });

  it('selected_migration_is_idempotent_and_preserves_page_assets', async () => {
    const f = await fixture(previewWith([card('c1', 'legacy one'), card('c2', 'legacy two')]));
    try {
      const firstAudit = await audit(f);
      const first = await f.host.invoke('qbank_legacy_migrate_selected', {
        examId: 'exam_1', cardIds: ['c1'], expectedVersion: firstAudit.audit_version,
      }) as LegacyMigrationReceipt;
      expect(first.committed).toBe(true);
      expect(first.idempotent).toBe(false);
      expect(first.question_ids).toHaveLength(1);
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL"))
        .toBe(1);

      const second = await f.host.invoke('qbank_legacy_migrate_selected', {
        examId: 'exam_1', cardIds: ['c1'], expectedVersion: firstAudit.audit_version,
      }) as LegacyMigrationReceipt;
      expect(second.idempotent).toBe(true);
      expect(second.question_ids).toEqual(first.question_ids);
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL"))
        .toBe(1);

      const page = f.preview().pages[0]!;
      expect(page.blob_hash).toBe('page-blob-1');
      expect(page.original_image_path).toBe('/tmp/original-page-1.png');
      expect(page.cards).toHaveLength(2);
      expect(new Set(page.cards.map(item => item.card_id))).toEqual(new Set(['c1', 'c2']));

      expect(f.db.pluck<string>(
        "SELECT json_extract(provenance_json, '$.legacy_migration.card_id') FROM questions WHERE id = ?1",
        [first.question_ids[0]!])).toBe('c1');
      expect(f.db.pluck<string>('SELECT card_id FROM questions WHERE id = ?1', [first.question_ids[0]!]))
        .toBe('c1');
    } finally { await f.dispose(); }
  });

  it('commit_failure_rolls_back_every_question_and_keeps_preview_evidence', async () => {
    const f = await fixture(previewWith([card('c1', 'rollback-first'), card('c2', 'rollback-second')]));
    try {
      f.db.exec(`CREATE TRIGGER fail_second BEFORE INSERT ON questions
        WHEN NEW.content = 'rollback-second' BEGIN SELECT RAISE(ABORT, 'rollback test'); END;`);
      const result = await audit(f);
      await expect(f.host.invoke('qbank_legacy_migrate_selected', {
        examId: 'exam_1', cardIds: ['c1', 'c2'], expectedVersion: result.audit_version,
      })).rejects.toMatchObject({
        error_type: 'Database', message: expect.stringContaining('rollback test') as string,
      });
      expect(f.db.pluck<number>("SELECT COUNT(*) FROM questions WHERE exam_id = 'exam_1' AND deleted_at IS NULL"))
        .toBe(0);
      const page = f.preview().pages[0]!;
      expect(page.cards).toHaveLength(2);
      expect(page.original_image_path).toBe('/tmp/original-page-1.png');
    } finally { await f.dispose(); }
  });

  it('migrates a Rust-written preview and keeps every serde_json Value number as written', async () => {
    const f = await fixture({ pages: [] });
    const c1 = '{"card_id":"c1","page_index":0,"question_label":"1","bbox":{"x":0.05,"y":0.05,"width":0.9,"height":0.25},'
      + '"resolved_bbox":{"x":50.0,"y":70.0,"width":900.0,"height":350.0},"ocr_text":"数值题","tags":[],'
      + '"question_type":"numeric","structured_data":{"answer_value":2.50,"tolerance":1e-2}}';
    const c2 = '{"card_id":"c2","page_index":0,"question_label":"2","bbox":{"x":0.0,"y":0.0,"width":0.0,"height":0.0},'
      + '"ocr_text":"简答题","tags":[],"question_type":"short_answer"}';
    f.db.run("UPDATE exam_sheets SET preview_json = ?1 WHERE id = 'exam_1'", ['{"temp_id":"tmp_legacy","pages":[{'
      + `"page_index":0,"blob_hash":"page-blob-1","width":1000,"height":1400,"cards":[${c1},${c2}]}],`
      + '"raw_model_response":{"confidence":0.95}}']);
    try {
      const result = await audit(f);
      expect(result.migratable_card_ids).toEqual(['c1', 'c2']);
      const receipt = await f.host.invoke('qbank_legacy_migrate_selected', {
        examId: 'exam_1', cardIds: ['c1'], expectedVersion: result.audit_version,
      }) as LegacyMigrationReceipt;
      expect(receipt.committed).toBe(true);

      const stored = f.db.pluck<string>("SELECT preview_json FROM exam_sheets WHERE id = 'exam_1'")!;
      expect(stored).toContain(c1);
      expect(stored).toContain(c2);
      expect(stored).toContain('"raw_model_response":{"confidence":0.95}');
      const question = f.db.get<{ structured_data: string; provenance_json: string }>(
        'SELECT structured_data, provenance_json FROM questions WHERE id = ?1', [receipt.question_ids[0]!])!;
      expect(question.structured_data).toBe('{"answer_value":2.50,"tolerance":1e-2}');
      expect(question.provenance_json).toContain('"resolved_bbox":{"x":50.0,"y":70.0,"width":900.0,"height":350.0}');
    } finally { await f.dispose(); }
  });
});
