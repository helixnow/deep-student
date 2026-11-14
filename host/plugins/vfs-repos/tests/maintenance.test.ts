import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Message } from '@deepseek-ai/cordis';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import { SqliteDatabase } from '../../../platform/storage/database.ts';
import { PROFILES } from '../../../platform/storage/profiles.ts';
import type { BeforeVectorClear, VfsFolder, VfsMaintenanceService } from '../api.ts';
import plugin from '../index.ts';

let root: string;
let blobsDir: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;

beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-maintenance-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), notes: notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
  blobsDir = join(storage.locations.activeDir, 'vfs_blobs');
}, 120_000);

afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);

const maintenance = () => host.ctx.vfsRepo.maintenance;
const resources = () => host.ctx.vfsRepo.resources;
const files = () => host.ctx.vfsRepo.files;
const blobs = () => host.ctx.vfsRepo.blobs;
const folders = () => host.ctx.vfsRepo.folders;
const units = () => host.ctx.vfsRepo.embeddingUnits;
const segments = () => host.ctx.vfsRepo.embeddingSegments;
const todos = () => host.ctx.vfsRepo.todos;

function resourceState(resourceId: string): { index_state: string; index_error: string | null; index_retry_count: number; index_next_retry_at: number } {
  const row = db.get<{ index_state: string; index_error: string | null; index_retry_count: number; index_next_retry_at: number }>(
    'SELECT index_state, index_error, index_retry_count, index_next_retry_at FROM resources WHERE id = ?1', [resourceId]);
  expect(row).toBeDefined();
  return row!;
}

/** 临时 Lance 目录大小，模拟 L12 提供的文件原语。 */
function directorySize(path: string): number {
  let total = 0;
  for (const entry of readdirSync(path)) {
    const target = join(path, entry);
    const stat = statSync(target);
    total += stat.isDirectory() ? directorySize(target) : stat.size;
  }
  return total;
}

/** 在真实临时目录里建立 `<active>/lance/vfs`。 */
function createVectorLanceDir(): { lanceDir: string; bytes: number } {
  const lanceDir = join(storage.locations.activeDir, 'lance', 'vfs');
  mkdirSync(join(lanceDir, 'tables'), { recursive: true });
  writeFileSync(join(lanceDir, 'manifest'), Buffer.alloc(3));
  writeFileSync(join(lanceDir, 'tables', 'data'), Buffer.alloc(5));
  return { lanceDir, bytes: 8 };
}

function successfulVectorClearer(): BeforeVectorClear {
  return lanceDir => {
    const bytesFreed = directorySize(lanceDir);
    rmSync(lanceDir, { recursive: true });
    return { existed: true, removed: true, bytesFreed };
  };
}

describe('table-owner maintenance handoff (L13b)', { timeout: 120_000 }, () => {
  it('reset disabled resources only and clears retry fields', () => {
    const disabled = resources().createOrReuse(db, 'note', 'disabled content', 'note_disabled', 'notes', null);
    const failed = resources().createOrReuse(db, 'note', 'failed content', 'note_failed', 'notes', null);
    db.run(`UPDATE resources SET index_state = 'disabled', index_error = 'boom', index_retry_count = 3,
      index_next_retry_at = 99 WHERE id = ?1`, [disabled.resourceId]);
    db.run("UPDATE resources SET index_state = 'failed' WHERE id = ?1", [failed.resourceId]);

    expect(maintenance().resetDisabledToPending(db)).toBe(1);

    expect(resourceState(disabled.resourceId)).toEqual({
      index_state: 'pending', index_error: null, index_retry_count: 0, index_next_retry_at: 0,
    });
    expect(resourceState(failed.resourceId).index_state).toBe('failed');
  });

  it('reset indexed resources without a unit+segment pair only', () => {
    const indexedWithSegments = resources().createOrReuse(db, 'note', 'segmented', 'note_segmented', 'notes', null);
    const indexedWithout = resources().createOrReuse(db, 'note', 'orphaned', 'note_orphaned', 'notes', null);
    db.run("UPDATE resources SET index_state = 'indexed' WHERE id IN (?1, ?2)",
      [indexedWithSegments.resourceId, indexedWithout.resourceId]);

    const unit = units().create(db, {
      resourceId: indexedWithSegments.resourceId, unitIndex: 0, imageBlobHash: null,
      imageMimeType: null, textContent: 'body', textSource: 'manual',
    });
    segments().create(db, {
      unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 3,
      lanceRowId: 'row_1', contentText: 'body', contentHash: 'h1',
      startPos: 0, endPos: 4, metadataJson: null,
    });

    expect(maintenance().resetIndexedWithoutEmbeddings(db)).toBe(1);
    expect(resourceState(indexedWithSegments.resourceId).index_state).toBe('indexed');
    expect(resourceState(indexedWithout.resourceId).index_state).toBe('pending');
  });

  it('reset all index state rows in Rust order', () => {
    const resource = resources().createOrReuse(db, 'file', 'indexed payload', 'file_reset', 'files', null);
    const file = files().createFile(db, 'sha_reset_all', 'reset.pdf', 10, 'document', 'application/pdf', null, null);
    const exam = host.ctx.vfsRepo.exams.createExamSheet(db, {
      examName: 'reset exam', tempId: 'temp_reset', metadataJson: {}, previewJson: {},
    });
    const unit = units().create(db, {
      resourceId: resource.resourceId, unitIndex: 0, imageBlobHash: null,
      imageMimeType: null, textContent: 'body', textSource: 'manual',
    });
    segments().create(db, {
      unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 3,
      lanceRowId: 'row_2', contentText: 'body', contentHash: 'h2',
      startPos: 0, endPos: 4, metadataJson: null,
    });
    db.run(`UPDATE resources SET index_state = 'indexed', index_hash = 'abc',
      mm_index_state = 'indexed', mm_embedding_dim = 3 WHERE id = ?1`, [resource.resourceId]);

    const counts = maintenance().resetAllIndexStateRows(db);
    expect(counts).toEqual({
      deletedSegments: 1, deletedUnits: 1, updatedResources: expect.any(Number),
      updatedFiles: expect.any(Number), updatedExams: expect.any(Number),
    });
    expect(counts.updatedResources).toBeGreaterThanOrEqual(1);
    expect(counts.updatedFiles).toBeGreaterThanOrEqual(1);
    expect(counts.updatedExams).toBe(1);

    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units')).toBe(0);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_embedding_dims WHERE record_count != 0')).toBe(0);
    const resourceRow = db.get<{ index_state: string; index_hash: string | null; mm_index_state: string }>(
      'SELECT index_state, index_hash, mm_index_state FROM resources WHERE id = ?1', [resource.resourceId]);
    expect(resourceRow).toEqual({ index_state: 'pending', index_hash: null, mm_index_state: 'pending' });
    const fileRow = db.get<{ mm_index_state: string; mm_indexed_pages_json: string | null }>(
      'SELECT mm_index_state, mm_indexed_pages_json FROM files WHERE id = ?1', [file.id]);
    expect(fileRow).toEqual({ mm_index_state: 'pending', mm_indexed_pages_json: null });
    const examRow = db.get<{ mm_index_state: string }>(
      'SELECT mm_index_state FROM exam_sheets WHERE id = ?1', [exam.id]);
    expect(examRow).toEqual({ mm_index_state: 'pending' });
  });

  it('clear resource OCR clears resources.ocr_text and the file page JSON', () => {
    const file = files().createFile(db, 'sha_ocr', 'ocr.pdf', 10, 'document', 'application/pdf', null, null);
    resources().saveOcrText(db, file.resourceId!, 'ocr body');
    files().savePageOcr(db, file.id, 0, 'page body');

    maintenance().clearResourceOcr(db, file.resourceId!);

    expect(resources().getOcrText(db, file.resourceId!)).toBeNull();
    expect(files().getOcrPages(db, file.id)).toEqual([]);
  });

  it('clear resource OCR falls back to resources.source_id when resource_id is absent', () => {
    const file = files().createFile(db, 'sha_ocr_source', 'ocr-source.pdf', 10, 'document', 'application/pdf', null, null);
    db.run('UPDATE files SET resource_id = NULL WHERE id = ?1', [file.id]);
    db.run('UPDATE resources SET source_id = ?1 WHERE id = ?2', [file.id, file.resourceId!]);
    db.run('UPDATE files SET ocr_pages_json = ?1 WHERE id = ?2', ['["legacy"]', file.id]);

    maintenance().clearResourceOcr(db, file.resourceId!);

    expect(db.pluck('SELECT ocr_pages_json FROM files WHERE id = ?1', [file.id])).toBeNull();
  });

  it('get resource path caches the computed path and skips over-long paths', () => {
    const folder = folderRow('fld_path', '课程', null);
    folders().createFolder(db, folder);
    const file = files().createFile(db, 'sha_path', '第一章.pdf', 10, 'document', 'application/pdf', null, null);
    folders().addItemToFolder(db, {
      id: 'fi_path', folderId: folder.id, itemType: 'file', itemId: file.id,
      sortOrder: 0, createdAt: 1,
    });

    // Rust get_resource_title_with_conn has no `file` branch: `file_` falls back to source_id.
    expect(maintenance().getResourcePath(db, file.id)).toBe(`/课程/${file.id}`);
    expect(db.pluck('SELECT cached_path FROM folder_items WHERE id = ?1', ['fi_path'])).toBe(`/课程/${file.id}`);

    const longTitle = '长'.repeat(400);
    const longFolder = folderRow('fld_long', longTitle, null);
    folders().createFolder(db, longFolder);
    const longFile = files().createFile(db, 'sha_path_long', 'x.pdf', 10, 'document', 'application/pdf', null, null);
    folders().addItemToFolder(db, {
      id: 'fi_long', folderId: longFolder.id, itemType: 'file', itemId: longFile.id,
      sortOrder: 0, createdAt: 1,
    });
    const longPath = maintenance().getResourcePath(db, longFile.id);
    expect(longPath).toBe(`/${longTitle}/${longFile.id}`);
    expect(Buffer.byteLength(longPath, 'utf8')).toBeGreaterThan(1000);
    expect(db.pluck('SELECT cached_path FROM folder_items WHERE id = ?1', ['fi_long'])).toBeNull();
  });

  it('get resource path returns the title for unassigned resources', () => {
    const file = files().createFile(db, 'sha_unassigned', '游离.pdf', 10, 'document', 'application/pdf', null, null);
    expect(maintenance().getResourcePath(db, file.id)).toBe(`/${file.id}`);
  });

  it('resource title follows Rust prefix branches for file and tb', () => {
    const folder = folderRow('fld_prefix', '前缀', null);
    folders().createFolder(db, folder);

    const file = files().createFile(db, 'sha_prefix_file', '前缀.pdf', 10, 'document', 'application/pdf', null, null);
    folders().addItemToFolder(db, {
      id: 'fi_prefix_file', folderId: folder.id, itemType: 'file', itemId: file.id,
      sortOrder: 0, createdAt: 1,
    });
    expect(maintenance().getResourcePath(db, file.id)).toBe(`/前缀/${file.id}`);

    const textbook = files().createFile(db, 'sha_prefix_tb', '教材.pdf', 10, 'document', 'application/pdf', null, null);
    db.run('UPDATE files SET id = ?1 WHERE id = ?2', ['tb_prefix', textbook.id]);
    folders().addItemToFolder(db, {
      id: 'fi_prefix_tb', folderId: folder.id, itemType: 'file', itemId: 'tb_prefix',
      sortOrder: 0, createdAt: 1,
    });
    expect(maintenance().getResourcePath(db, 'tb_prefix')).toBe('/前缀/教材.pdf');
  });

  it('update path cache recurses into child folders', () => {
    const rootFolder = folderRow('fld_root', '根', null);
    folders().createFolder(db, rootFolder);
    const child = folderRow('fld_child', '子', rootFolder.id);
    folders().createFolder(db, child);
    const rootFile = files().createFile(db, 'sha_root_path', 'a.pdf', 10, 'document', 'application/pdf', null, null);
    const childFile = files().createFile(db, 'sha_child_path', 'b.pdf', 10, 'document', 'application/pdf', null, null);
    folders().addItemToFolder(db, { id: 'fi_root', folderId: rootFolder.id, itemType: 'file', itemId: rootFile.id, sortOrder: 0, createdAt: 1 });
    folders().addItemToFolder(db, { id: 'fi_child', folderId: child.id, itemType: 'file', itemId: childFile.id, sortOrder: 0, createdAt: 1 });

    expect(maintenance().updatePathCache(db, rootFolder.id)).toBe(2);
    expect(db.pluck('SELECT cached_path FROM folder_items WHERE id = ?1', ['fi_root'])).toBe(`/根/${rootFile.id}`);
    expect(db.pluck('SELECT cached_path FROM folder_items WHERE id = ?1', ['fi_child'])).toBe(`/根/子/${childFile.id}`);
    expect(maintenance().updatePathCache(db, 'fld_missing')).toBe(0);
    expect(() => maintenance().updatePathCache(db, 'not_a_folder'))
      .toThrow("Invalid argument 'folder_id': Invalid folder ID format: not_a_folder");
  });

  it('create todo subtasks inserts all rows in one savepoint', () => {
    const list = todos().ensureDefaultInbox(db);
    const parent = todos().createTodoItem(db, { todoListId: list.id, title: '大任务' });

    const created = maintenance().createTodoSubtasks(db, list.id, parent.id, ['第一步', '第二步']);

    expect(created).toHaveLength(2);
    expect(created.map(item => item.title)).toEqual(['第一步', '第二步']);
    expect(created.every(item => item.parentId === parent.id && item.priority === 'none')).toBe(true);
    expect(todos().listItemsByList(db, list.id, true).filter(item => item.parentId === parent.id)).toHaveLength(2);

    expect(() => maintenance().createTodoSubtasks(db, list.id, parent.id, ['一', ''])).toThrow();
    expect(todos().listItemsByList(db, list.id, true).filter(item => item.parentId === parent.id)).toHaveLength(2);
  });

  it('clear media cache clears preview, compressed and OCR state without touching Lance', async () => {
    const pageBlob = blobs().storeBlob(db, blobsDir, Buffer.from('page'), 'image/jpeg', 'jpg');
    const compressedBlob = blobs().storeBlob(db, blobsDir, Buffer.from('compressed'), 'image/webp', 'webp');
    const file = files().createFile(db, 'sha_media_cache', 'media.pdf', 10, 'document', 'application/pdf', null, null);
    db.run(`UPDATE files SET preview_json = ?1, compressed_blob_hash = ?2, ocr_pages_json = '["ocr"]',
      processing_progress = '{"readyModes":["image","ocr"]}' WHERE id = ?3`,
    [JSON.stringify({ pages: [{ blob_hash: pageBlob.hash, compressed_blob_hash: compressedBlob.hash }] }),
      compressedBlob.hash, file.id]);
    db.run('UPDATE resources SET ocr_text = ?1 WHERE id = ?2', ['ocr', file.resourceId!]);

    const result = await maintenance().clearMediaCache(db, blobsDir, {
      clearPdfPreview: true, clearCompressedImages: true, clearOcrText: true, clearVectorIndex: false,
    });

    const row = db.get<{ preview_json: string | null; compressed_blob_hash: string | null; ocr_pages_json: string | null; processing_progress: string; processing_status: string }>(
      'SELECT preview_json, compressed_blob_hash, ocr_pages_json, processing_progress, processing_status FROM files WHERE id = ?1', [file.id]);
    expect(row).toEqual({
      preview_json: null, compressed_blob_hash: null, ocr_pages_json: null,
      processing_progress: '{"readyModes":[]}', processing_status: 'pending',
    });
    expect(db.pluck('SELECT ocr_text FROM resources WHERE id = ?1', [file.resourceId!])).toBeNull();
    expect(result.pdfPreviewCleared).toBe(2);
    expect(result.compressedImagesCleared).toBe(1);
    expect(result.ocrTextCleared).toBe(1);
    expect(result.vectorIndexCleared).toBe(0);
    expect(result.filesReset).toBeGreaterThanOrEqual(3);
    expect(result.totalBytesFreed).toBe(Buffer.byteLength('page') + Buffer.byteLength('compressed'));
  });

  it('clear media cache vector branch preserves the Rust missing-column failure after deleting rows', async () => {
    const resource = resources().createOrReuse(db, 'file', 'vector payload', 'file_vector', 'files', null);
    const unit = units().create(db, {
      resourceId: resource.resourceId, unitIndex: 0, imageBlobHash: null,
      imageMimeType: null, textContent: 'body', textSource: 'manual',
    });
    segments().create(db, {
      unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 3,
      lanceRowId: 'row_vector', contentText: 'body', contentHash: 'h4',
      startPos: 0, endPos: 4, metadataJson: null,
    });

    // handlers.rs:7193-7200 references `resources.vector_indexed_at`, which is absent from
    // the vfs schema; the UPDATE fails after segments/units/dimension counts were cleared.
    await expect(maintenance().clearMediaCache(db, blobsDir, {
      clearPdfPreview: false, clearCompressedImages: false, clearOcrText: false, clearVectorIndex: true,
    })).rejects.toThrow(/vector_indexed_at/);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units')).toBe(0);
  });

  it('runs the vector file stage after OCR and before SQL, even when the later column failure occurs', async () => {
    const file = files().createFile(db, 'sha_vector_stage', 'stage.pdf', 10, 'document', 'application/pdf', null, null);
    resources().saveOcrText(db, file.resourceId!, 'ocr body');
    db.run("UPDATE files SET ocr_pages_json = '[\"ocr\"]' WHERE id = ?1", [file.id]);
    const resource = resources().createOrReuse(db, 'file', 'vector stage', 'file_vector_stage', 'files', null);
    const unit = units().create(db, {
      resourceId: resource.resourceId, unitIndex: 0, imageBlobHash: null,
      imageMimeType: null, textContent: 'body', textSource: 'manual',
    });
    segments().create(db, {
      unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 3,
      lanceRowId: 'row_stage', contentText: 'body', contentHash: 'h_stage',
      startPos: 0, endPos: 4, metadataJson: null,
    });
    const { lanceDir } = createVectorLanceDir();
    const seen: { dir?: string; ocr?: string | null; segments?: number } = {};

    await expect(maintenance().clearMediaCache(db, blobsDir, {
      clearPdfPreview: false, clearCompressedImages: false, clearOcrText: true, clearVectorIndex: true,
    }, dir => {
      seen.dir = dir;
      seen.ocr = db.pluck<string | null>('SELECT ocr_text FROM resources WHERE id = ?1', [file.resourceId!]) ?? null;
      seen.segments = db.pluck<number>('SELECT COUNT(*) FROM vfs_index_segments') ?? -1;
      const bytesFreed = directorySize(dir);
      rmSync(dir, { recursive: true });
      return { existed: true, removed: true, bytesFreed };
    })).rejects.toThrow(/vector_indexed_at/);

    expect(seen).toEqual({ dir: lanceDir, ocr: null, segments: 1 });
    expect(existsSync(lanceDir)).toBe(false);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units')).toBe(0);
  });

  it('accounts vector directory bytes when the vector SQL succeeds', async () => {
    db.exec('ALTER TABLE resources ADD COLUMN vector_indexed_at TEXT');
    const resource = resources().createOrReuse(db, 'file', 'vector success', 'file_vector_success', 'files', null);
    db.run("UPDATE resources SET vector_indexed_at = '2026-07-01T00:00:00Z' WHERE id = ?1", [resource.resourceId]);
    const unit = units().create(db, {
      resourceId: resource.resourceId, unitIndex: 0, imageBlobHash: null,
      imageMimeType: null, textContent: 'body', textSource: 'manual',
    });
    segments().create(db, {
      unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 3,
      lanceRowId: 'row_success', contentText: 'body', contentHash: 'h_success',
      startPos: 0, endPos: 4, metadataJson: null,
    });
    const { lanceDir, bytes } = createVectorLanceDir();
    let calls = 0;

    const service = host.ctx.vfsMaintenance as unknown as VfsMaintenanceService;
    const result = await service.clearMediaCache({
      clearPdfPreview: false, clearCompressedImages: false, clearOcrText: false, clearVectorIndex: true,
    }, dir => {
      calls += 1;
      expect(dir).toBe(lanceDir);
      return successfulVectorClearer()(dir);
    });

    expect(calls).toBe(1);
    expect(result.vectorIndexCleared).toBe(1);
    expect(result.totalBytesFreed).toBe(bytes);
    expect(result.filesReset).toBe(1);
    expect(existsSync(lanceDir)).toBe(false);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units')).toBe(0);
    expect(db.pluck('SELECT vector_indexed_at FROM resources WHERE id = ?1', [resource.resourceId])).toBeNull();
  });

  it('warns and continues vector SQL when the file stage reports removal failure', async () => {
    const logs: Message[] = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export: message => void logs.push(message) });
    const resource = resources().createOrReuse(db, 'file', 'vector failure', 'file_vector_failure', 'files', null);
    const unit = units().create(db, {
      resourceId: resource.resourceId, unitIndex: 0, imageBlobHash: null,
      imageMimeType: null, textContent: 'body', textSource: 'manual',
    });
    segments().create(db, {
      unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 3,
      lanceRowId: 'row_failure', contentText: 'body', contentHash: 'h_failure',
      startPos: 0, endPos: 4, metadataJson: null,
    });
    const { lanceDir } = createVectorLanceDir();
    let observedSegments = -1;

    await expect(maintenance().clearMediaCache(db, blobsDir, {
      clearPdfPreview: false, clearCompressedImages: false, clearOcrText: false, clearVectorIndex: true,
    }, dir => {
      observedSegments = db.pluck<number>('SELECT COUNT(*) FROM vfs_index_segments') ?? -1;
      return { existed: true, removed: false, bytesFreed: 0 };
    })).rejects.toThrow(/vector_indexed_at/);

    expect(observedSegments).toBe(1);
    expect(existsSync(lanceDir)).toBe(true);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units')).toBe(0);
    const messages = logs.flatMap(message => message.args.map(arg => String(arg)));
    expect(messages.some(message => message.includes('Failed to remove lance dir'))).toBe(true);
  });
});

describe('vfsMaintenance service provider', { timeout: 120_000 }, () => {
  it('publishes the service and delegates index-state resets', () => {
    const service = host.ctx.vfsMaintenance;
    expect(service).toBeDefined();

    const disabled = resources().createOrReuse(db, 'note', 'disabled', 'note_svc_disabled', 'notes', null);
    db.run(`UPDATE resources SET index_state = 'disabled', index_error = 'boom', index_retry_count = 2,
      index_next_retry_at = 42 WHERE id = ?1`, [disabled.resourceId]);
    expect(service.resetDisabledToPending()).toBe(1);
    expect(resourceState(disabled.resourceId).index_state).toBe('pending');

    const indexed = resources().createOrReuse(db, 'note', 'indexed', 'note_svc_indexed', 'notes', null);
    db.run("UPDATE resources SET index_state = 'indexed' WHERE id = ?1", [indexed.resourceId]);
    expect(service.resetIndexedWithoutEmbeddings()).toBe(1);
    expect(resourceState(indexed.resourceId).index_state).toBe('pending');

    const resource = resources().createOrReuse(db, 'file', 'reset all', 'file_svc_reset', 'files', null);
    const unit = units().create(db, {
      resourceId: resource.resourceId, unitIndex: 0, imageBlobHash: null,
      imageMimeType: null, textContent: 'body', textSource: 'manual',
    });
    segments().create(db, {
      unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 3,
      lanceRowId: 'row_svc', contentText: 'body', contentHash: 'svc',
      startPos: 0, endPos: 4, metadataJson: null,
    });
    const counts = service.resetAllIndexStateRows();
    expect(counts.deletedSegments).toBe(1);
    expect(counts.deletedUnits).toBe(1);
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units')).toBe(0);
  });

  it('delegates path lookup and subtree cache updates', () => {
    const service = host.ctx.vfsMaintenance;
    const folder = folderRow('fld_svc', '服务', null);
    folders().createFolder(db, folder);
    const file = files().createFile(db, 'sha_svc_path', '路径.pdf', 10, 'document', 'application/pdf', null, null);
    folders().addItemToFolder(db, {
      id: 'fi_svc', folderId: folder.id, itemType: 'file', itemId: file.id, sortOrder: 0, createdAt: 1,
    });

    expect(service.getResourcePath(file.id)).toBe(`/服务/${file.id}`);
    expect(service.updatePathCache(folder.id)).toBe(1);
    expect(db.pluck('SELECT cached_path FROM folder_items WHERE id = ?1', ['fi_svc'])).toBe(`/服务/${file.id}`);
    expect(service.updatePathCache('fld_svc_missing')).toBe(0);
    expect(() => service.updatePathCache('svc_not_a_folder'))
      .toThrow("Invalid argument 'folder_id': Invalid folder ID format: svc_not_a_folder");
  });

  it('delegates todo subtasks, OCR clearing and media cache clearing', async () => {
    const service = host.ctx.vfsMaintenance;
    const list = todos().ensureDefaultInbox(db);
    const parent = todos().createTodoItem(db, { todoListId: list.id, title: '拆解' });
    const created = service.createTodoSubtasks(list.id, parent.id, ['子一', '子二']);
    expect(created.map(item => item.title)).toEqual(['子一', '子二']);
    expect(created.every(item => item.parentId === parent.id)).toBe(true);

    const file = files().createFile(db, 'sha_svc_media', 'svc.pdf', 10, 'document', 'application/pdf', null, null);
    resources().saveOcrText(db, file.resourceId!, 'ocr body');
    files().savePageOcr(db, file.id, 0, 'page body');
    service.clearResourceOcr(file.resourceId!);
    expect(resources().getOcrText(db, file.resourceId!)).toBeNull();
    expect(files().getOcrPages(db, file.id)).toEqual([]);

    db.run(`UPDATE files SET ocr_pages_json = '["ocr"]',
      processing_progress = '{"readyModes":["ocr"]}' WHERE id = ?1`, [file.id]);
    const result = await service.clearMediaCache({
      clearPdfPreview: false, clearCompressedImages: false, clearOcrText: true, clearVectorIndex: false,
    });
    expect(result.ocrTextCleared).toBe(1);
    expect(db.pluck('SELECT ocr_pages_json FROM files WHERE id = ?1', [file.id])).toBeNull();
    expect(db.pluck('SELECT processing_status FROM files WHERE id = ?1', [file.id])).toBe('pending');
  });
});

describe('reset rebuildable index (L21 handoff)', { timeout: 120_000 }, () => {
  it('removes the stale Lance dir and resets only existing schema columns', () => {
    const service = host.ctx.vfsMaintenance as unknown as VfsMaintenanceService;
    const target = storage.locations.activeDir;
    const lanceDir = join(target, 'databases', 'lance', 'vfs');
    mkdirSync(join(lanceDir, 'tables'), { recursive: true });
    writeFileSync(join(lanceDir, 'manifest'), Buffer.alloc(4));

    const indexed = resources().createOrReuse(db, 'note', 'indexed', 'note_rebuild', 'notes', null);
    const disabled = resources().createOrReuse(db, 'note', 'disabled', 'note_rebuild_disabled', 'notes', null);
    db.run(`UPDATE resources SET index_state = 'indexed', index_hash = 'h', index_error = 'e',
      indexed_at = 1, index_retry_count = 2, index_next_retry_at = 3, index_generation = 4,
      mm_index_state = 'indexed', mm_index_error = 'm', mm_indexed_at = 5, mm_embedding_dim = 6,
      mm_indexing_mode = 'page', mm_index_retry_count = 7,
      mm_index_next_retry_at = 8, mm_index_generation = 9 WHERE id = ?1`, [indexed.resourceId]);
    db.run("UPDATE resources SET index_state = 'disabled', mm_index_state = 'disabled' WHERE id = ?1",
      [disabled.resourceId]);

    const unit = units().create(db, {
      resourceId: indexed.resourceId, unitIndex: 0, imageBlobHash: null,
      imageMimeType: null, textContent: 'body', textSource: 'manual',
    });
    db.run(`UPDATE vfs_index_units SET text_required = 1, text_state = 'indexed', text_error = 'e',
      text_indexed_at = 1, text_chunk_count = 2, text_embedding_dim = 3, text_profile_id = 'p',
      text_generation = 4, mm_required = 1, mm_state = 'indexed', mm_error = 'm',
      mm_indexed_at = 5, mm_embedding_dim = 6, mm_profile_id = 'q', mm_generation = 7
      WHERE id = ?1`, [unit.id]);
    segments().create(db, {
      unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 3,
      lanceRowId: 'row_rebuild', contentText: 'body', contentHash: 'h',
      startPos: 0, endPos: 4, metadataJson: null,
    });
    db.run(`INSERT INTO vfs_embedding_dims
      (dimension, modality, lance_table_name, record_count, created_at, last_used_at,
       active_profile_id, active_generation, ann_metric, ann_index_version)
      VALUES (64, 'text', 'vec_64', 5, 10, 20, 'prof_active', 2, 'l2', 4)`);
    db.run(`INSERT INTO vfs_index_profiles
      (id, model_fingerprint, model_config_id, model_name, dimension, modality,
       embedding_protocol, schema_version, lance_table_name, active_generation, state,
       ann_metric, ann_index_version, created_at, updated_at)
      VALUES ('prof_active', 'fp', 'cfg', 'm', 64, 'text', 'legacy', 1, 'vec_64', 2, 'active', 'l2', 4, 1, 1),
             ('prof_retired', 'fp2', 'cfg2', 'm2', 64, 'text', 'legacy', 1, 'vec_64', 2, 'active', 'l2', 4, 1, 1)`);

    const file = files().createFile(db, 'sha_rebuild', 'rebuild.pdf', 10, 'document',
      'application/pdf', null, null);
    db.run(`UPDATE files SET mm_index_state = 'indexed', mm_index_error = 'e',
      mm_indexed_pages_json = '[]' WHERE id = ?1`, [file.id]);
    const exam = host.ctx.vfsRepo.exams.createExamSheet(db, {
      examName: 'rebuild exam', tempId: 'temp_rebuild', metadataJson: {}, previewJson: {},
    });
    db.run(`UPDATE exam_sheets SET mm_index_state = 'indexed', mm_index_error = 'e',
      mm_indexed_pages_json = '[]', mm_embedding_dim = 3, mm_indexing_mode = 'page',
      mm_indexed_at = 4 WHERE id = ?1`, [exam.id]);
    db.run("INSERT INTO __lance_orphan_queue (lance_row_id, resource_id) VALUES ('row_rebuild', ?1)",
      [indexed.resourceId]);

    service.resetRebuildableIndex(target);

    expect(existsSync(lanceDir)).toBe(false);
    expect(db.get('SELECT index_state, index_hash, index_error, indexed_at, index_retry_count, ' +
      'index_next_retry_at, index_generation, mm_index_state, mm_index_error, mm_indexed_at, ' +
      'mm_embedding_dim, mm_indexing_mode, mm_index_retry_count, ' +
      'mm_index_next_retry_at, mm_index_generation FROM resources WHERE id = ?1', [indexed.resourceId]))
      .toEqual({
        index_state: 'pending', index_hash: null, index_error: null, indexed_at: null,
        index_retry_count: 0, index_next_retry_at: 0, index_generation: 0,
        mm_index_state: 'pending', mm_index_error: null, mm_indexed_at: null,
        mm_embedding_dim: null, mm_indexing_mode: null,
        mm_index_retry_count: 0, mm_index_next_retry_at: 0, mm_index_generation: 0,
      });
    expect(db.get('SELECT index_state, mm_index_state FROM resources WHERE id = ?1', [disabled.resourceId]))
      .toEqual({ index_state: 'disabled', mm_index_state: 'disabled' });

    expect(db.get('SELECT text_state, text_error, text_indexed_at, text_chunk_count, ' +
      'text_embedding_dim, text_profile_id, text_generation, mm_state, mm_error, mm_indexed_at, ' +
      'mm_embedding_dim, mm_profile_id, mm_generation FROM vfs_index_units WHERE id = ?1', [unit.id]))
      .toEqual({
        text_state: 'pending', text_error: null, text_indexed_at: null, text_chunk_count: 0,
        text_embedding_dim: null, text_profile_id: null, text_generation: 0,
        mm_state: 'pending', mm_error: null, mm_indexed_at: null,
        mm_embedding_dim: null, mm_profile_id: null, mm_generation: 0,
      });
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
    expect(db.get('SELECT record_count, created_at, last_used_at, active_generation, ann_metric, ' +
      'ann_index_version FROM vfs_embedding_dims WHERE dimension = 64 AND modality = ?1', ['text']))
      .toEqual({
        record_count: 0, created_at: 10, last_used_at: 10,
        active_generation: 0, ann_metric: 'exact', ann_index_version: 0,
      });
    expect(db.all<{ id: string; active_generation: number; state: string; ann_metric: string; ann_index_version: number }>(
      'SELECT id, active_generation, state, ann_metric, ann_index_version FROM vfs_index_profiles ORDER BY id'))
      .toEqual([
        { id: 'prof_active', active_generation: 0, state: 'active', ann_metric: 'exact', ann_index_version: 0 },
        { id: 'prof_retired', active_generation: 0, state: 'retired', ann_metric: 'exact', ann_index_version: 0 },
      ]);
    expect(db.get('SELECT mm_index_state, mm_index_error, mm_indexed_pages_json ' +
      'FROM files WHERE id = ?1', [file.id]))
      .toEqual({
        mm_index_state: 'pending', mm_index_error: null, mm_indexed_pages_json: null,
      });
    expect(db.get('SELECT mm_index_state, mm_index_error, mm_indexed_pages_json, mm_embedding_dim, ' +
      'mm_indexing_mode, mm_indexed_at FROM exam_sheets WHERE id = ?1', [exam.id]))
      .toEqual({
        mm_index_state: 'pending', mm_index_error: null, mm_indexed_pages_json: null,
        mm_embedding_dim: null, mm_indexing_mode: null, mm_indexed_at: null,
      });
    expect(db.pluck('SELECT COUNT(*) FROM __lance_orphan_queue')).toBe(0);

    // Idempotent: the second call leaves the same rebuildable state.
    service.resetRebuildableIndex(target);
    expect(db.pluck('SELECT index_state FROM resources WHERE id = ?1', [indexed.resourceId]))
      .toBe('pending');
  });

  it('rolls back the whole ledger on a late old-schema failure', () => {
    const target = mkdtempSync(join(tmpdir(), 'l11-rebuild-rollback-'));
    const dbPath = join(target, 'databases', 'vfs.db');
    mkdirSync(join(target, 'databases'), { recursive: true });
    const oldSchema = new SqliteDatabase({ name: 'vfs', path: dbPath, profile: PROFILES.plain });
    try {
      oldSchema.exec(`CREATE TABLE resources (id TEXT PRIMARY KEY, index_state TEXT);
        CREATE TABLE vfs_index_units (id TEXT PRIMARY KEY, text_required INTEGER, text_state TEXT);
        CREATE TABLE vfs_index_segments (id TEXT PRIMARY KEY);
        CREATE TABLE files (id TEXT PRIMARY KEY, mm_index_state TEXT);
        INSERT INTO resources VALUES ('res_old', 'indexed');
        INSERT INTO vfs_index_units VALUES ('unit_old', 1, 'indexed');
        INSERT INTO vfs_index_segments VALUES ('seg_old');
        INSERT INTO files VALUES ('file_old', 'indexed');
        CREATE TRIGGER trg_rebuild_reject BEFORE UPDATE ON files
        BEGIN SELECT RAISE(ABORT, 'rebuild rejected'); END;`);
    } finally {
      oldSchema.close();
    }

    expect(() => (host.ctx.vfsMaintenance as unknown as VfsMaintenanceService).resetRebuildableIndex(target))
      .toThrow('rebuild rejected');

    const check = new SqliteDatabase({ name: 'vfs', path: dbPath, profile: PROFILES.plain, mustExist: true });
    try {
      expect(check.pluck('SELECT index_state FROM resources WHERE id = ?1', ['res_old']))
        .toBe('indexed');
      expect(check.pluck('SELECT text_state FROM vfs_index_units WHERE id = ?1', ['unit_old']))
        .toBe('indexed');
      expect(check.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(1);

      check.exec('DROP TRIGGER trg_rebuild_reject');
      check.close();
      (host.ctx.vfsMaintenance as unknown as VfsMaintenanceService).resetRebuildableIndex(target);
      const after = new SqliteDatabase({ name: 'vfs', path: dbPath, profile: PROFILES.plain, mustExist: true });
      try {
        expect(after.pluck('SELECT index_state FROM resources WHERE id = ?1', ['res_old']))
          .toBe('pending');
        expect(after.pluck('SELECT text_state FROM vfs_index_units WHERE id = ?1', ['unit_old']))
          .toBe('pending');
        expect(after.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
      } finally {
        after.close();
      }
    } finally {
      try { check.close(); } catch { /* already closed */ }
      rmSync(target, { recursive: true, force: true });
    }
  });
});

function folderRow(id: string, title: string, parentId: string | null): VfsFolder {
  return {
    id, parentId: parentId ?? undefined, title, isExpanded: true, isFavorite: false,
    sortOrder: 0, createdAt: 1, updatedAt: 1,
  };
}
