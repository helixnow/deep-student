import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rmSync } from 'node:fs';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { runWithoutChangeLogEcho } from '../repository/change-log-echo.ts';
import plugin from '../index.ts';

interface PendingRow {
  id: number;
  table_name: string;
  record_id: string;
  operation: string;
  sync_version: number;
}

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;

beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-changelog-echo-'));
  host = await createTestHost({
    plugins: [plugin],
    provide: {
      storage,
      paths: pathsServiceDouble(),
      notes: notesServiceDouble(() => storage.database('vfs')),
    },
  });
  db = storage.database('vfs');
}, 120_000);

afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

const pendingRows = (tableName?: string): PendingRow[] => (
  tableName === undefined
    ? db.all<PendingRow>(
      'SELECT id, table_name, record_id, operation, sync_version FROM __change_log WHERE sync_version = 0 ORDER BY id ASC',
    )
    : db.all<PendingRow>(
      'SELECT id, table_name, record_id, operation, sync_version FROM __change_log WHERE sync_version = 0 AND table_name = ?1 ORDER BY id ASC',
      [tableName],
    )
);

const markAllSynced = (): void => {
  db.run('UPDATE __change_log SET sync_version = 1 WHERE sync_version = 0');
};

describe('__change_log echo suppression for local-derived updates (Finding B)', { timeout: 120_000 }, () => {
  it('suppresses phantom pending rows for all local-derived resources index state updates', () => {
    const { indexStates, maintenance, resources } = host.ctx.vfsRepo;
    const res = resources.createOrReuse(db, 'note', 'hello world', null, null, null);
    const imgRes = resources.createOrReuse(db, 'image', 'aGVsbG8=', null, null, null);
    const pdfFile = host.ctx.vfsRepo.files.createFile(
      db, 'sha-paged-pdf', 'paged.pdf', 1024, 'document', 'application/pdf', null, null,
    );
    db.run('UPDATE files SET page_count = 5 WHERE id = ?1', [pdfFile.id]);
    markAllSynced();
    expect(pendingRows()).toEqual([]);

    // Text index lifecycle
    indexStates.setIndexState(db, res.resourceId, 'indexing', null, null);
    indexStates.markIndexed(db, res.resourceId, res.hash);
    indexStates.markFailed(db, res.resourceId, '获取嵌入模型配置失败: missing default');
    expect(indexStates.reviveConfigBlocked(db)).toBe(1);
    expect(indexStates.claimPendingResources(db, 10, 3)).toContain(res.resourceId);
    indexStates.markDisabled(db, res.resourceId);
    expect(maintenance.resetDisabledToPending(db)).toBeGreaterThanOrEqual(1);
    indexStates.markIndexed(db, res.resourceId, res.hash);
    expect(maintenance.resetIndexedWithoutEmbeddings(db)).toBeGreaterThanOrEqual(1);

    // Paged PDF requeue
    indexStates.markIndexed(db, pdfFile.resourceId!, 'pdf-hash');
    expect(indexStates.requeuePagedPdfsOnce(db)).toBe(1);

    // Multimodal index lifecycle on resources
    indexStates.setMmIndexState(db, imgRes.resourceId, 'pending', null);
    expect(indexStates.claimMmIndexingResources(db, [imgRes.resourceId], 3)).toEqual([imgRes.resourceId]);
    indexStates.markMmFailed(db, imgRes.resourceId, 'mm model timeout');
    indexStates.markMmIndexed(db, imgRes.resourceId);

    // Startup crash recovery & full index resets
    indexStates.markIndexing(db, res.resourceId);
    expect(maintenance.recoverStuckIndexingWithConn(db, Date.now())).toBeGreaterThanOrEqual(1);
    maintenance.resetAllIndexStateRows(db);
    maintenance.resetRebuildableIndex(db);

    expect(pendingRows()).toEqual([]);
  });

  it('suppresses phantom pending rows and preserves updated_at for files & exam_sheets local-derived updates', () => {
    const { files, attachments, textbooks, exams } = host.ctx.vfsRepo;
    const file = files.createFile(db, 'sha-file-local', 'notes.pdf', 512, 'document', 'application/pdf', null, null);
    const tb = textbooks.createTextbook(db, 'sha-tb-local', 'book.pdf', 2048, null, null);
    const exam = exams.createExamSheet(db, {
      examName: 'Midterm', tempId: 'tmp-midterm', metadataJson: {}, previewJson: {},
    });

    const fixedStamp = '2025-01-02T03:04:05.000Z';
    db.run('UPDATE files SET updated_at = ?1 WHERE id IN (?2, ?3)', [fixedStamp, file.id, tb.id]);
    db.run('UPDATE exam_sheets SET updated_at = ?1 WHERE id = ?2', [fixedStamp, exam.id]);
    markAllSynced();
    expect(pendingRows()).toEqual([]);

    // File processing status transitions
    files.applyProcessingStatus(db, file.id, 'page_rendering', '{"stage":"page_rendering","percent":10}', null, 1000, null);
    files.updateProcessingProgress(db, file.id, '{"stage":"page_compression","percent":40}');
    files.applyProcessingStatus(db, file.id, 'completed_with_issues', '{"stage":"completed_with_issues"}', null, 2000, 'page 2 warning');
    files.applyProcessingStatus(db, file.id, 'completed', '{"stage":"completed","percent":100}', null, 3000, null);
    files.setProcessingError(db, file.id, 'temporary failure', 4000);
    files.markProcessingRecovered(db, file.id);
    files.cancelProcessing(db, file.id);

    // File multimodal index transitions (files, attachments, textbooks)
    files.applyMultimodalIndexState(db, file.id, 'indexed', '[{"page_index":0}]');
    files.applyMultimodalIndexState(db, file.id, 'failed', 'mm error');
    files.applyMultimodalIndexState(db, file.id, 'pending', null);
    attachments.setMmIndexState(db, file.id, 'indexed', null);
    attachments.saveMmIndexedPages(db, file.id, '[{"page_index":0}]');

    textbooks.markTextbookRenderError(db, tb.id, 'render failed');
    textbooks.savePageMmIndex(db, tb.id, {
      pageIndex: 0,
      blobHash: 'b1',
      embeddingDim: 1024,
      indexingMode: 'image',
      indexedAt: '2026-01-01T00:00:00.000Z',
    });
    textbooks.clearMmIndex(db, tb.id);
    textbooks.setMmIndexState(db, tb.id, 'indexed', null);

    // Exam multimodal index transitions
    exams.applyMultimodalIndexState(db, exam.id, 'indexed', '[{"page_index":0}]', 1024);
    exams.applyMultimodalIndexState(db, exam.id, 'failed', 'dim mismatch', 1024);
    exams.setMmIndexState(db, exam.id, 'pending', null);
    exams.saveMmIndexMetadata(db, exam.id, '[{"page_index":0}]', 1024, 'image');

    expect(pendingRows()).toEqual([]);
    expect(db.pluck<string>('SELECT updated_at FROM files WHERE id = ?1', [file.id])).toBe(fixedStamp);
    expect(db.pluck<string>('SELECT updated_at FROM files WHERE id = ?1', [tb.id])).toBe(fixedStamp);
    expect(db.pluck<string>('SELECT updated_at FROM exam_sheets WHERE id = ?1', [exam.id])).toBe(fixedStamp);
  });

  it('preserves pre-existing legitimate pending rows both outside and inside nested transactions', () => {
    const { resources, indexStates, files } = host.ctx.vfsRepo;
    const res = resources.createOrReuse(db, 'note', 'initial body', null, null, null);
    const file = files.createFile(db, 'sha-preserve', 'keep.pdf', 100, 'document', 'application/pdf', null, null);
    markAllSynced();

    // Legitimate synced edits emit pending rows.
    resources.updateResourceData(db, res.resourceId, 'edited body');
    files.updateFileName(db, file.id, 'renamed.pdf');
    const before = pendingRows();
    expect(before.some(row => row.table_name === 'resources' && row.record_id === res.resourceId && row.operation === 'UPDATE')).toBe(true);
    expect(before.some(row => row.table_name === 'files' && row.record_id === file.id && row.operation === 'UPDATE')).toBe(true);

    // Local-derived updates outside a transaction must NOT erase pre-existing pending rows.
    indexStates.markIndexed(db, res.resourceId, 'h-after');
    files.applyProcessingStatus(db, file.id, 'completed', '{"stage":"completed","percent":100}', null, Date.now(), null);
    expect(pendingRows()).toEqual(before);

    // Local-derived updates inside an explicit transaction (SAVEPOINT path) must preserve
    // both earlier pending rows and real edits in the same transaction.
    db.transaction(tx => {
      files.setFavorite(tx, file.id, true);
      indexStates.markFailed(tx, res.resourceId, 'transient error');
      files.applyMultimodalIndexState(tx, file.id, 'indexed', '[{"page_index":0}]');
    });
    const after = pendingRows();
    const added = after.slice(before.length);
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ table_name: 'files', record_id: file.id, operation: 'UPDATE', sync_version: 0 });
  });

  it('still emits pending __change_log rows for real synced content/metadata edits', () => {
    const { resources, files, attachments, exams } = host.ctx.vfsRepo;
    const res = resources.createOrReuse(db, 'note', 'v1', null, null, null);
    const file = files.createFile(db, 'sha-synced-edits', 'doc.pdf', 256, 'document', 'application/pdf', null, null);
    const exam = exams.createExamSheet(db, {
      examName: 'Quiz 1', tempId: 'tmp-quiz-1', metadataJson: {}, previewJson: {},
    });
    markAllSynced();

    resources.updateResourceData(db, res.resourceId, 'v2');
    resources.saveOcrText(db, res.resourceId, 'ocr text');
    files.updatePdfPreview(db, file.id, '{"pages":[]}', 2);
    files.updatePdfExtractedText(db, file.id, 'pdf body', 2);
    attachments.setFavorite(db, file.id, true);
    files.updateFileName(db, file.id, 'doc-renamed.pdf');
    files.deleteFile(db, file.id);
    exams.updateExamName(db, exam.id, 'Quiz 1 Revised');

    const rows = pendingRows();
    expect(rows.filter(r => r.table_name === 'resources' && r.record_id === res.resourceId && r.operation === 'UPDATE').length)
      .toBeGreaterThanOrEqual(2);
    expect(rows.filter(r => r.table_name === 'files' && r.record_id === file.id && r.operation === 'UPDATE').length)
      .toBeGreaterThanOrEqual(5);
    expect(rows.filter(r => r.table_name === 'exam_sheets' && r.record_id === exam.id && r.operation === 'UPDATE').length)
      .toBeGreaterThanOrEqual(1);
  });

  it('does not emit phantom resource pending rows on folder move or exam question index invalidation', () => {
    const { folders, resources, exams, questions } = host.ctx.vfsRepo;
    const now = Date.now();
    folders.createFolder(db, {
      id: 'fld_target_echo',
      title: 'Target',
      isExpanded: true,
      isFavorite: false,
      sortOrder: 0,
      createdAt: now,
      updatedAt: now,
    });
    const res = resources.createOrReuse(db, 'note', 'note body', 'note_1', 'notes', null);
    db.run(`INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
      VALUES ('note_1', ?1, 'Note 1', '[]', 0, '2025-01-01T00:00:00.000Z', '2025-01-01T00:00:00.000Z')`, [res.resourceId]);
    db.run('UPDATE resources SET index_state = \'indexed\', updated_at = 1000 WHERE id = ?1', [res.resourceId]);

    const exam = exams.createExamSheet(db, {
      examName: 'Exam 1', tempId: 'tmp-exam-1', metadataJson: {}, previewJson: {},
    });
    expect(exam.resourceId).toBeDefined();
    db.run('UPDATE resources SET index_state = \'indexed\', updated_at = 2000 WHERE id = ?1', [exam.resourceId!]);
    markAllSynced();

    folders.moveItemToFolder(db, 'note', 'note_1', 'fld_target_echo');
    questions.createQuestion(db, { exam_id: exam.id, content: 'Q1' });

    // folder_items and questions SHOULD emit pending rows, but resources index invalidation must NOT.
    expect(pendingRows('resources')).toEqual([]);
    expect(pendingRows('folder_items').length).toBeGreaterThanOrEqual(1);
    expect(pendingRows('questions').length).toBeGreaterThanOrEqual(1);
    expect(db.pluck<number>('SELECT updated_at FROM resources WHERE id = ?1', [res.resourceId])).toBe(1000);
    expect(db.pluck<number>('SELECT updated_at FROM resources WHERE id = ?1', [exam.resourceId!])).toBe(2000);
  });

  it('BUG-T4B: suppresses phantom __change_log UPDATE rows for background OCR cache writes', () => {
    const { resources } = host.ctx.vfsRepo;
    const res = resources.createOrReuse(db, 'file', 'pdf-bytes', null, null, null);
    const fixedUpdatedAt = 1795640429797;
    db.run('UPDATE resources SET ocr_text = NULL, updated_at = ?1 WHERE id = ?2', [fixedUpdatedAt, res.resourceId]);
    markAllSynced();
    expect(pendingRows()).toEqual([]);

    // 1) saveOcrTextIfEmptyWithConn populates ocr_text without bumping updated_at or emitting sync_version = 0 rows
    resources.saveOcrTextIfEmptyWithConn(db, res.resourceId, 'background extracted page 1');
    expect(resources.getOcrText(db, res.resourceId)).toBe('background extracted page 1');
    expect(db.pluck<number>('SELECT updated_at FROM resources WHERE id = ?1', [res.resourceId])).toBe(fixedUpdatedAt);
    expect(pendingRows('resources')).toEqual([]);

    // 2) saveOcrTextWithoutTimestampWithConn overwrites ocr_text without bumping updated_at or emitting sync_version = 0 rows
    resources.saveOcrTextWithoutTimestampWithConn(db, res.resourceId, 'background extracted pages 1-2');
    expect(resources.getOcrText(db, res.resourceId)).toBe('background extracted pages 1-2');
    expect(db.pluck<number>('SELECT updated_at FROM resources WHERE id = ?1', [res.resourceId])).toBe(fixedUpdatedAt);
    expect(pendingRows('resources')).toEqual([]);

    // 3) Inside a transaction (SAVEPOINT path), preserves pre-existing pending rows while suppressing OCR cache echoes
    resources.updateResourceData(db, res.resourceId, 'real edited resource data');
    const before = pendingRows('resources');
    expect(before).toHaveLength(1);
    db.transaction(tx => {
      resources.saveOcrTextWithoutTimestampWithConn(tx, res.resourceId, 'nested tx ocr cache');
    });
    expect(resources.getOcrText(db, res.resourceId)).toBe('nested tx ocr cache');
    expect(pendingRows('resources')).toEqual(before);
  });

  it('works safely when __change_log table does not exist (minimal unit-test schema)', () => {
    const minimal = storage.openFile(':memory:', { label: 'minimal-no-changelog' });
    try {
      minimal.exec('CREATE TABLE resources (id TEXT PRIMARY KEY, index_state TEXT)');
      minimal.run("INSERT INTO resources (id, index_state) VALUES ('r1', 'pending')");
      const changes = runWithoutChangeLogEcho(minimal, 'resources', () => (
        minimal.run("UPDATE resources SET index_state = 'indexed' WHERE id = 'r1'").changes
      ));
      expect(changes).toBe(1);
      expect(minimal.pluck<string>("SELECT index_state FROM resources WHERE id = 'r1'")).toBe('indexed');
    } finally {
      storage.close(minimal);
    }
  });
});
