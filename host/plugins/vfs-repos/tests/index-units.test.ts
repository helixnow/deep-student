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
import type { CreateUnitInput } from '../api.ts';
import plugin from '../index.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-index-unit-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const units = () => host.ctx.vfsRepo.embeddingUnits;

function seedResourceWithIndex(resourceId: string, lanceRowId: string): string {
  const now = Date.now();
  db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
    VALUES (?1, ?2, 'note', 'inline', 'content', 0, ?3, ?3)`, [resourceId, `hash_${resourceId}`, now]);
  const unitId = `unit_${resourceId}`;
  db.run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, created_at, updated_at)
    VALUES (?1, ?2, 0, 'text', ?3, ?3)`, [unitId, resourceId, now]);
  db.run(`INSERT INTO vfs_index_segments
    (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, created_at, updated_at)
    VALUES (?1, ?2, 0, 'text', 768, ?3, ?4, ?4)`, [`seg_${resourceId}`, unitId, lanceRowId, now]);
  return unitId;
}

describe('index_unit_repo.rs', { timeout: 120_000 }, () => {
  it('test_purge_index_artifacts_cascades_and_enqueues_lance_rows', () => {
    seedResourceWithIndex('res_purge_1', 'lance_row_a');
    expect(units().purgeIndexArtifactsByResource(db, 'res_purge_1')).toBe(1);
    expect(db.pluck<number>("SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = 'res_purge_1'"))
      .toBe(0);
    expect(db.pluck<number>("SELECT COUNT(*) FROM vfs_index_segments WHERE lance_row_id = 'lance_row_a'"))
      .toBe(0);
    expect(db.pluck<number>("SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'lance_row_a'"))
      .toBe(1);
  });

  it('test_sweep_orphan_index_units_only_removes_orphans', () => {
    seedResourceWithIndex('res_alive', 'lance_alive');
    seedResourceWithIndex('res_orphan', 'lance_orphan');
    db.run("DELETE FROM resources WHERE id = 'res_orphan'");

    expect(units().sweepOrphanIndexUnits(db)).toBe(1);
    expect(db.pluck<number>("SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = 'res_alive'"))
      .toBe(1);
    expect(db.pluck<number>("SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'lance_orphan'"))
      .toBe(1);
  });

  it('sync_units_content_change_invalidates_stale_segments', () => {
    const unitId = seedResourceWithIndex('res_sync_change', 'lance_stale_text');
    db.run(`UPDATE vfs_index_units SET text_required = 1, text_state = 'indexed',
        text_profile_id = 'profile_old', text_generation = 3, content_hash = 'stale_hash'
      WHERE id = ?1`, [unitId]);

    const synced = units().syncUnits(db, 'res_sync_change', [{
      resourceId: 'res_sync_change', unitIndex: 0, imageBlobHash: null, imageMimeType: null,
      textContent: 'brand new text', textSource: 'native',
    }]);

    const updated = synced.units[0]!;
    expect(updated.textState).toBe('pending');
    expect(updated.textProfileId).toBeNull();
    expect(updated.textGeneration).toBe(3);
    expect(db.pluck<number>('SELECT COUNT(*) FROM vfs_index_segments WHERE unit_id = ?1', [unitId]))
      .toBe(0);
    expect(db.pluck<number>("SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'lance_stale_text'"))
      .toBe(1);
    expect(synced.orphanedLanceRowIds).toContain('lance_stale_text');
  });

  it('sync_multimodal_image_change_invalidates_stale_segments', () => {
    const now = Date.now();
    db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
      VALUES ('res_mm_invalidate', 'hash_mm_invalidate', 'file', 'inline', '', 0, ?1, ?1)`, [now]);
    db.run(`INSERT INTO vfs_index_units
      (id, resource_id, unit_index, image_blob_hash, image_mime_type, mm_required,
       mm_state, mm_profile_id, mm_generation, created_at, updated_at)
      VALUES ('unit_mm_invalidate', 'res_mm_invalidate', 0, 'blob_old', 'image/png', 1,
              'indexed', 'profile_old_mm', 2, ?1, ?1)`, [now]);
    db.run(`INSERT INTO vfs_index_segments
      (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
       index_profile_id, generation, created_at, updated_at)
      VALUES ('seg_mm_invalidate', 'unit_mm_invalidate', 0, 'multimodal', 1024,
              'lance_stale_mm', 'profile_old_mm', 2, ?1, ?1)`, [now]);

    const synced = units().syncMultimodalUnits(db, 'res_mm_invalidate', [{
      resourceId: 'res_mm_invalidate', unitIndex: 0, imageBlobHash: 'blob_new',
      imageMimeType: 'image/png', textContent: null, textSource: null,
    }], false);

    const updated = synced.units[0]!;
    expect(updated.mmState).toBe('pending');
    expect(updated.mmProfileId).toBeNull();
    expect(updated.mmGeneration).toBe(2);
    expect(synced.orphanedLanceRowIds).toContain('lance_stale_mm');
    expect(db.pluck<number>("SELECT COUNT(*) FROM vfs_index_segments WHERE unit_id = 'unit_mm_invalidate'"))
      .toBe(0);
    expect(db.pluck<number>("SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'lance_stale_mm'"))
      .toBe(1);
  });

  it('bare_unit_delete_enqueues_lance_orphans', () => {
    seedResourceWithIndex('res_bare_delete', 'lance_bare_delete');
    expect(units().delete(db, 'unit_res_bare_delete')).toBe(true);
    expect(db.pluck<number>("SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'lance_bare_delete'"))
      .toBe(1);
  });

  it('sync_multimodal_page_rehashes_image_and_preserves_text', () => {
    const now = Date.now();
    db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
      VALUES ('res_mm_rehash', 'resource_hash', 'file', 'inline', '', 0, ?1, ?1)`, [now]);
    const created = units().create(db, {
      resourceId: 'res_mm_rehash', unitIndex: 0, imageBlobHash: 'blob_old',
      imageMimeType: 'image/png', textContent: 'preserved OCR', textSource: 'ocr',
    });
    const oldHash = created.contentHash!;

    const synced = units().syncMultimodalUnits(db, 'res_mm_rehash', [{
      resourceId: 'res_mm_rehash', unitIndex: 0, imageBlobHash: 'blob_new',
      imageMimeType: 'image/webp', textContent: null, textSource: null,
    }], false);
    const updated = synced.units[0]!;
    expect(updated.contentHash).not.toBe(oldHash);
    expect(updated.textContent).toBe('preserved OCR');
    expect(updated.mmState).toBe('pending');
  });
});
