import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
import qbankPlugin from '../../qbank/index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
let blobsDir: string;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-exam-'));
  host = await createTestHost({ plugins: [plugin, qbankPlugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
  blobsDir = join(storage.locations.activeDir, 'vfs_blobs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const exams = () => host.ctx.vfsRepo.exams;
const blobs = () => host.ctx.vfsRepo.blobs;

describe('exam_repo.rs', { timeout: 120_000 }, () => {
  it('test_exam_sheet_id_generation', () => {
    const exam = exams().createExamSheet(db, {
      examName: null,
      tempId: 'temp_id_gen',
      metadataJson: {},
      previewJson: { pages: [] },
      status: 'pending',
      folderId: null,
    });
    expect(exam.id.startsWith('exam_')).toBe(true);
    expect(exam.id).toHaveLength(15);
  });

  it('test_purge_exam_sheet_dereferences_page_and_question_blobs', () => {
    const pageBlob = blobs().storeBlob(db, blobsDir, Buffer.from('exam-page-image'), 'image/jpeg', 'jpg');
    const questionBlob = blobs().storeBlob(db, blobsDir, Buffer.from('question-image'), 'image/jpeg', 'jpg');

    const exam = exams().createExamSheet(db, {
      examName: '回归测试卷',
      tempId: 'temp_regress_1',
      metadataJson: {},
      previewJson: { pages: [{ page_index: 0, blob_hash: pageBlob.hash }] },
      status: 'completed',
      folderId: null,
    });

    db.run(`INSERT INTO questions (id, exam_id, content, images_json, created_at, updated_at)
      VALUES ('q_regress_1', ?1, 'test question', ?2, datetime('now'), datetime('now'))`,
    [exam.id, JSON.stringify([{ hash: questionBlob.hash }])]);

    exams().purgeExamSheet(db, blobsDir, exam.id);

    for (const [label, hash] of [['page', pageBlob.hash], ['question', questionBlob.hash]] as const) {
      const rc = db.pluck<number | null>('SELECT ref_count FROM blobs WHERE hash = ?1', [hash]);
      expect(rc === undefined || rc === null || rc === 0, `${label} blob ${hash} must be dereferenced after purge, got ${String(rc)}`).toBe(true);
    }

    const qCount = Number(db.pluck<number>('SELECT COUNT(*) FROM questions WHERE exam_id = ?1', [exam.id]) ?? 0);
    expect(qCount).toBe(0);
  });

  it('test_copy_exam_sheet_shares_blobs_and_copies_questions', () => {
    const pageBlob = blobs().storeBlob(db, blobsDir, Buffer.from('copy-exam-page'), 'image/jpeg', 'jpg');
    const questionBlob = blobs().storeBlob(db, blobsDir, Buffer.from('copy-exam-question'), 'image/jpeg', 'jpg');

    const exam = exams().createExamSheet(db, {
      examName: '复制回归卷',
      tempId: 'temp_copy_regress',
      metadataJson: { subject: 'math' },
      previewJson: { pages: [{ page_index: 0, blob_hash: pageBlob.hash }] },
      status: 'completed',
      folderId: null,
    });

    db.run(`INSERT INTO questions (id, exam_id, content, answer, images_json, created_at, updated_at)
      VALUES ('q_copy_1', ?1, 'question A', 'answer A', ?2, datetime('now'), datetime('now'))`,
    [exam.id, JSON.stringify([{ hash: questionBlob.hash }])]);
    db.run(`INSERT INTO questions (id, exam_id, content, created_at, updated_at)
      VALUES ('q_copy_2', ?1, 'question B', datetime('now'), datetime('now'))`, [exam.id]);

    const copy = exams().copyExamSheet(db, exam.id, null);
    expect(copy.id).not.toBe(exam.id);
    expect(copy.examName).toBe('复制回归卷 (副本)');

    for (const [label, hash] of [['page', pageBlob.hash], ['question', questionBlob.hash]] as const) {
      const rc = db.pluck<number>('SELECT ref_count FROM blobs WHERE hash = ?1', [hash]);
      expect(rc, `${label} blob 复制后引用计数必须为 2`).toBe(2);
    }

    const copied = db.all<{ content: string; answer: string | null }>(
      'SELECT content, answer FROM questions WHERE exam_id = ?1 ORDER BY content', [copy.id]);
    expect(copied).toHaveLength(2);
    expect(copied[0]!.content).toBe('question A');
    expect(copied[0]!.answer).toBe('answer A');
    expect(copied[1]!.content).toBe('question B');

    exams().purgeExamSheet(db, blobsDir, exam.id);

    for (const [label, hash] of [['page', pageBlob.hash], ['question', questionBlob.hash]] as const) {
      const rc = db.pluck<number>('SELECT ref_count FROM blobs WHERE hash = ?1', [hash]);
      expect(rc, `${label} blob 在原卷 purge 后必须为 1（副本仍持有）`).toBe(1);
    }
    const copyQCount = Number(db.pluck<number>(
      'SELECT COUNT(*) FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL', [copy.id]) ?? 0);
    expect(copyQCount).toBe(2);

    exams().purgeExamSheet(db, blobsDir, copy.id);
    for (const [label, hash] of [['page', pageBlob.hash], ['question', questionBlob.hash]] as const) {
      const rc = db.pluck<number | null>('SELECT ref_count FROM blobs WHERE hash = ?1', [hash]);
      expect(rc === undefined || rc === null || rc === 0, `${label} blob 副本 purge 后必须归零，got ${String(rc)}`).toBe(true);
    }
  });

  it('V2-OWNER-QBANK copies authoring entities through the real owner and remaps question references', () => {
    const exam = exams().createExamSheet(db, { examName: 'owner copy', tempId: 'owner-copy',
      metadataJson: {}, previewJson: { pages: [] }, status: 'completed', folderId: null });
    const now = '2026-01-01T00:00:00+00:00';
    db.run(`INSERT INTO qbank_sources(id,exam_id,source_key,descriptor_json,created_at,updated_at)
      VALUES('source_owner',?1,'source-key','{}',?2,?2)`, [exam.id, now]);
    db.run(`INSERT INTO qbank_materials(id,exam_id,content,source_refs_json,created_at,updated_at)
      VALUES('material_owner',?1,'material',?2,?3,?3)`,
    [exam.id, '[{"source_id":"source_owner","nested":{"group_id":"group_owner"}}]', now]);
    db.run(`INSERT INTO qbank_groups(id,exam_id,label,position,created_at,updated_at)
      VALUES('group_owner',?1,'shared group',2,?2,?2)`, [exam.id, now]);
    db.run(`INSERT INTO qbank_group_materials(id,exam_id,group_id,material_id,position,created_at,updated_at)
      VALUES('link_owner',?1,'group_owner','material_owner',4,?2,?2)`, [exam.id, now]);
    db.run(`INSERT INTO questions(id,exam_id,content,group_id,source_ref,created_at,updated_at)
      VALUES('q_owner',?1,'question','group_owner','{"source_id":"source_owner"}',?2,?2)`, [exam.id, now]);
    expect(host.ctx.qbank.examCascade).toBeDefined();

    const copy = exams().copyExamSheet(db, exam.id, null);
    const source = db.get<{ id: string; created_at: string }>('SELECT id,created_at FROM qbank_sources WHERE exam_id=?1', [copy.id])!;
    const group = db.get<{ id: string }>('SELECT id FROM qbank_groups WHERE exam_id=?1', [copy.id])!;
    const material = db.get<{ id: string; source_refs_json: string }>(
      'SELECT id,source_refs_json FROM qbank_materials WHERE exam_id=?1', [copy.id])!;
    expect(source.id).not.toBe('source_owner');
    expect(source.created_at).toMatch(/\+00:00$/);
    expect(JSON.parse(material.source_refs_json)).toEqual([{ source_id: source.id, nested: { group_id: group.id } }]);
    expect(db.get('SELECT group_id,material_id,position FROM qbank_group_materials WHERE exam_id=?1', [copy.id]))
      .toEqual({ group_id: group.id, material_id: material.id, position: 4 });
    const question = db.get<{ group_id: string; source_ref: string }>(
      'SELECT group_id,source_ref FROM questions WHERE exam_id=?1', [copy.id])!;
    expect(question.group_id).toBe(group.id);
    expect(JSON.parse(question.source_ref)).toEqual({ source_id: source.id });
  });

  it('V2-OWNER-QBANK owner SQL failure rolls back L11 exam/resource/blob writes on the same connection', () => {
    const blob = blobs().storeBlob(db, blobsDir, Buffer.from('cascade-copy-rollback'), 'image/png', 'png');
    const exam = exams().createExamSheet(db, { examName: 'rollback', tempId: 'owner-rollback',
      metadataJson: {}, previewJson: { pages: [{ blob_hash: blob.hash }] }, status: 'completed', folderId: null });
    db.run(`INSERT INTO qbank_materials(id,exam_id,content,created_at,updated_at)
      VALUES('material_rollback',?1,'x','now','now')`, [exam.id]);
    const resourcesBefore = db.pluck('SELECT COUNT(*) FROM resources');
    db.exec(`CREATE TRIGGER reject_copied_material BEFORE INSERT ON qbank_materials
      WHEN NEW.id <> 'material_rollback' BEGIN SELECT RAISE(ABORT, 'owner material rejected'); END`);
    expect(() => exams().copyExamSheet(db, exam.id, null)).toThrow('Database error: owner material rejected');
    expect(db.pluck('SELECT COUNT(*) FROM exam_sheets')).toBe(1);
    expect(db.pluck('SELECT COUNT(*) FROM resources')).toBe(resourcesBefore);
    expect(db.pluck('SELECT COUNT(*) FROM qbank_materials')).toBe(1);
    expect(blobs().getBlob(db, blob.hash)?.refCount).toBe(1);
  });

  it('V2-OWNER-QBANK delete/restore preserves the owner deletion batch and rolls back owner failures', () => {
    const exam = exams().createExamSheet(db, { examName: 'lifecycle', tempId: 'owner-lifecycle',
      metadataJson: {}, previewJson: {}, status: 'completed', folderId: null });
    db.run(`INSERT INTO qbank_materials(id,exam_id,content,created_at,updated_at)
      VALUES('material_live',?1,'x','now','now')`, [exam.id]);
    db.run(`INSERT INTO qbank_materials(id,exam_id,content,created_at,updated_at,deleted_at,deletion_batch)
      VALUES('material_older',?1,'old','now','now','old-time','prior-batch')`, [exam.id]);
    db.run(`INSERT INTO qbank_groups(id,exam_id,created_at,updated_at) VALUES('group_live',?1,'now','now')`, [exam.id]);
    db.run(`INSERT INTO qbank_practice_attempts(id,scope_id,document_json,created_at,updated_at)
      VALUES('attempt_live',?1,'{}','now','now')`, [exam.id]);
    db.run(`INSERT INTO questions(id,exam_id,content,created_at,updated_at)
      VALUES('q_lifecycle',?1,'x','now','now')`, [exam.id]);
    db.exec(`CREATE TRIGGER reject_group_delete BEFORE UPDATE OF deleted_at ON qbank_groups
      WHEN NEW.deleted_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'owner delete rejected'); END`);
    expect(() => exams().deleteExamSheet(db, exam.id)).toThrow('Database error: owner delete rejected');
    for (const table of ['exam_sheets', 'questions', 'qbank_materials']) {
      const id = table === 'exam_sheets' ? exam.id : table === 'questions' ? 'q_lifecycle' : 'material_live';
      expect(db.pluck(`SELECT deleted_at FROM ${table} WHERE id=?1`, [id])).toBeNull();
    }
    db.exec('DROP TRIGGER reject_group_delete');
    exams().deleteExamSheet(db, exam.id);
    const batch = db.pluck<string>('SELECT deletion_batch FROM exam_sheets WHERE id=?1', [exam.id])!;
    expect(batch).toMatch(/^exam_delete_/);
    expect(db.get('SELECT deletion_batch,local_version FROM qbank_practice_attempts WHERE id=?1', ['attempt_live']))
      .toEqual({ deletion_batch: batch, local_version: 2 });
    exams().restoreExam(db, exam.id);
    expect(db.get('SELECT deleted_at,deletion_batch,local_version FROM qbank_practice_attempts WHERE id=?1', ['attempt_live']))
      .toEqual({ deleted_at: null, deletion_batch: null, local_version: 3 });
    expect(db.get('SELECT deleted_at,deletion_batch FROM qbank_materials WHERE id=?1', ['material_older']))
      .toEqual({ deleted_at: 'old-time', deletion_batch: 'prior-batch' });
    expect(db.pluck('SELECT deleted_at FROM questions WHERE id=?1', ['q_lifecycle'])).toBeNull();
  });

  it('V2-OWNER-QBANK keeps JSON errors wrapped and retains blobs referenced by owner snapshots', () => {
    const exam = exams().createExamSheet(db, { examName: 'invalid refs', tempId: 'owner-invalid',
      metadataJson: {}, previewJson: {}, status: 'completed', folderId: null });
    db.run(`INSERT INTO qbank_materials(id,exam_id,content,source_refs_json,created_at,updated_at)
      VALUES('material_invalid',?1,'x','not json','now','now')`, [exam.id]);
    expect(() => exams().copyExamSheet(db, exam.id, null)).toThrow('Serialization error:');
    expect(db.pluck('SELECT COUNT(*) FROM exam_sheets')).toBe(1);

    const blob = blobs().storeBlob(db, blobsDir, Buffer.from('owner-snapshot-page'), 'image/png', 'png');
    const doomed = exams().createExamSheet(db, { examName: 'purge', tempId: 'owner-purge',
      metadataJson: {}, previewJson: { pages: [{ blob_hash: blob.hash }] }, status: 'completed', folderId: null });
    db.run(`INSERT INTO qbank_papers(id,exam_id,title,document_json,created_at,updated_at)
      VALUES('paper_retains',?1,'archive',?2,'now','now')`, [exam.id, JSON.stringify({ image: { hash: blob.hash } })]);
    exams().purgeExamSheetWithConn(db, doomed.id);
    expect(exams().getExamSheet(db, doomed.id)).toBeNull();
    expect(blobs().getBlob(db, blob.hash)?.refCount).toBe(1);
  });
  it('reads metadata_json / preview_json as serde_json::Value text (arbitrary_precision number text)', () => {
    const exam = exams().createExamSheet(db, {
      examName: null, tempId: 'temp_value_text', metadataJson: {}, previewJson: { pages: [] }, status: 'completed', folderId: null,
    });
    const preview = '{"pages":[{"page_index":0,"cards":[{"bbox":{"x":0.5,"y":1.0,"width":2,"height":3e0}}]}],'
      + '"b":1.50,"a":12345678901234567890,"c":-0.0}';
    const metadata = '{"score":1.0,"big":1E400,"page_count":3}';
    db.run('UPDATE exam_sheets SET preview_json = ?1, metadata_json = ?2 WHERE id = ?3', [preview, metadata, exam.id]);
    const read = exams().getExamSheet(db, exam.id)!;
    expect(JSON.stringify(read.previewJson)).toBe(
      '{"pages":[{"page_index":0,"cards":[{"bbox":{"x":0.5,"y":1.0,"width":2,"height":3e+0}}]}],'
      + '"b":1.50,"a":12345678901234567890,"c":-0.0}');
    expect(JSON.stringify(read.metadataJson)).toBe('{"score":1.0,"big":1e+400,"page_count":3}');
    expect(JSON.stringify(exams().listExamSheets(db, null, 10, 0).find(sheet => sheet.id === exam.id)!.metadataJson))
      .toBe('{"score":1.0,"big":1e+400,"page_count":3}');
  });
});

describe('qbank_authoring_service.rs:534 markQuestionDocumentCompleted', { timeout: 120_000 }, () => {
  const STAMP = '2026-07-01T00:00:00.000Z';
  const logMax = (): number => Number(db.pluck<number>('SELECT COALESCE(MAX(id), 0) FROM __change_log') ?? 0);
  const logSince = (from: number) => db.all<{ table_name: string; record_id: string; operation: string }>(
    'SELECT table_name, record_id, operation FROM __change_log WHERE id > ?1 ORDER BY id', [from]);
  const row = (examId: string) => db.get<{
    metadata_json: string; status: string; import_state_json: string | null; updated_at: string;
  }>('SELECT metadata_json, status, import_state_json, updated_at FROM exam_sheets WHERE id = ?1', [examId])!;
  const importingExam = (metadata: string) => {
    const exam = exams().createExamSheet(db, {
      examName: '导入中', tempId: `temp_mark_${Math.random()}`, metadataJson: {}, previewJson: { pages: [] },
      status: 'importing', folderId: null,
    });
    db.run(`UPDATE exam_sheets SET metadata_json = ?1, import_state_json = '{"stage":"draft"}', updated_at = ?2
      WHERE id = ?3`, [metadata, STAMP, exam.id]);
    return exam.id;
  };

  it('sets version 2 in place, completes, clears import state, keeps updated_at; one exam_sheets UPDATE', () => {
    const examId = importingExam('{"score": 1.50, "big": 12345678901234567890, "question_document_version": 1, "tags": ["a"]}');
    const before = logMax();
    exams().markQuestionDocumentCompleted(db, examId);
    expect(row(examId)).toEqual({
      metadata_json: '{"score":1.50,"big":12345678901234567890,"question_document_version":2,"tags":["a"]}',
      status: 'completed', import_state_json: null, updated_at: STAMP,
    });
    expect(logSince(before)).toEqual([{ table_name: 'exam_sheets', record_id: examId, operation: 'UPDATE' }]);
  });

  it('commit tail order: preview UPDATE then completion UPDATE, nothing else on exam_sheets or resources', () => {
    const examId = importingExam('{}');
    const before = logMax();
    exams().updatePreviewJson(db, examId, { pages: [] });
    const previewStamp = row(examId).updated_at;
    exams().markQuestionDocumentCompleted(db, examId);
    expect(logSince(before)).toEqual([
      { table_name: 'exam_sheets', record_id: examId, operation: 'UPDATE' },
      { table_name: 'exam_sheets', record_id: examId, operation: 'UPDATE' },
    ]);
    expect(row(examId).updated_at).toBe(previewStamp);
  });

  it('missing exam is a no-op (Rust ignores the affected count)', () => {
    const before = logMax();
    expect(() => exams().markQuestionDocumentCompleted(db, 'exam_missing00')).not.toThrow();
    expect(logSince(before)).toEqual([]);
  });

  it('malformed metadata_json fails the statement and leaves the row unchanged', () => {
    const examId = importingExam('{not json');
    const before = logMax();
    expect(() => exams().markQuestionDocumentCompleted(db, examId)).toThrow(/malformed JSON/);
    expect(row(examId)).toEqual({
      metadata_json: '{not json', status: 'importing', import_state_json: '{"stage":"draft"}', updated_at: STAMP,
    });
    expect(logSince(before)).toEqual([]);
  });
});

describe('qbank_legacy_reconcile.rs:695 setImportStateRaw', { timeout: 120_000 }, () => {
  const STAMP = '2026-07-01T00:00:00.000Z';
  const logMax = (): number => Number(db.pluck<number>('SELECT COALESCE(MAX(id), 0) FROM __change_log') ?? 0);
  const logSince = (from: number) => db.all<{ table_name: string; record_id: string; operation: string }>(
    'SELECT table_name, record_id, operation FROM __change_log WHERE id > ?1 ORDER BY id', [from]);
  const row = (examId: string) => db.get<{ import_state_json: string | null; updated_at: string }>(
    'SELECT import_state_json, updated_at FROM exam_sheets WHERE id = ?1', [examId])!;
  const examWithState = (state: string) => {
    const exam = exams().createExamSheet(db, {
      examName: '复核', tempId: `temp_raw_${Math.random()}`, metadataJson: {}, previewJson: { pages: [] },
      status: 'importing', folderId: null,
    });
    db.run('UPDATE exam_sheets SET import_state_json = ?1, updated_at = ?2 WHERE id = ?3', [state, STAMP, exam.id]);
    return exam.id;
  };

  it('writes the retained text verbatim, keeps updated_at, and still logs one exam_sheets UPDATE', () => {
    const retained = '{"job_id": "other", "n": 1.50, "big": 12345678901234567890}';
    const examId = examWithState(retained);
    const before = logMax();
    exams().setImportStateRaw(db, examId, retained);
    expect(row(examId)).toEqual({ import_state_json: retained, updated_at: STAMP });
    expect(logSince(before)).toEqual([{ table_name: 'exam_sheets', record_id: examId, operation: 'UPDATE' }]);
  });

  it('clears the state with NULL without touching updated_at; malformed stored text is written back unchanged', () => {
    const examId = examWithState('{"job_id":"job_1"}');
    exams().setImportStateRaw(db, examId, null);
    expect(row(examId)).toEqual({ import_state_json: null, updated_at: STAMP });

    const malformed = examWithState('{not json');
    exams().setImportStateRaw(db, malformed, '{not json');
    expect(row(malformed)).toEqual({ import_state_json: '{not json', updated_at: STAMP });
  });

  it('a missing exam is a no-op', () => {
    const before = logMax();
    expect(() => exams().setImportStateRaw(db, 'exam_missing00', null)).not.toThrow();
    expect(logSince(before)).toEqual([]);
  });
});
