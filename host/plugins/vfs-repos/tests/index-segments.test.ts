import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestHost } from '../../../kernel/testing.ts';
import { notesServiceDouble } from './support/notes-service.ts';
import { pathsServiceDouble } from './support/paths-service.ts';
import { createVfsTestStorage } from './support/vfs-test-storage.ts';
import type { createStorageService } from '../../../platform/storage/service.ts';
import { defineQuery, type DatabaseHandle } from '../../../platform/storage/api.ts';
import type { CreateSegmentInput } from '../api.ts';
import plugin from '../index.ts';

const MODALITY_MULTIMODAL = 'multimodal';
let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-index-segment-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const segments = () => host.ctx.vfsRepo.embeddingSegments;
const dims = () => host.ctx.vfsRepo.embeddingDims;

function seedUnit(): { resourceId: string; unitId: string } {
  const resourceId = 'res_mm_segment_test';
  const unitId = 'unit_mm_segment_test';
  const now = Date.now();
  db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
    VALUES (?1, 'hash_mm_segment_test', 'file', 'inline', '', 0, ?2, ?2)`, [resourceId, now]);
  db.run(`INSERT INTO vfs_index_units
    (id, resource_id, unit_index, image_blob_hash, mm_required, mm_state, created_at, updated_at)
    VALUES (?1, ?2, 0, 'blob_page_0', 1, 'indexing', ?3, ?3)`, [unitId, resourceId, now]);
  return { resourceId, unitId };
}

function segmentInput(unitId: string, lanceRowId: string): CreateSegmentInput {
  return {
    unitId,
    segmentIndex: 0,
    modality: MODALITY_MULTIMODAL,
    embeddingDim: 1024,
    lanceRowId,
    contentText: null,
    contentHash: 'content_hash',
    startPos: null,
    endPos: null,
    metadataJson: '{"page_index":0,"blob_hash":"blob_page_0","unit_id":"unit_mm_segment_test"}',
  };
}

describe('index_segment_repo.rs', { timeout: 120_000 }, () => {
  it('replace_is_idempotent_and_removal_is_durable', () => {
    const { resourceId, unitId } = seedUnit();
    segments().replaceByUnitAndModality(db, resourceId, unitId, MODALITY_MULTIMODAL,
      [segmentInput(unitId, 'mm_row_stable')]);
    segments().replaceByUnitAndModality(db, resourceId, unitId, MODALITY_MULTIMODAL,
      [segmentInput(unitId, 'mm_row_stable')]);

    expect(db.pluck<number>(
      'SELECT COUNT(*) FROM vfs_index_segments WHERE unit_id = ?1 AND modality = ?2',
      [unitId, MODALITY_MULTIMODAL])).toBe(1);
    expect(db.pluck<number>('SELECT COUNT(*) FROM __lance_orphan_queue')).toBe(0);

    segments().replaceByUnitAndModality(db, resourceId, unitId, MODALITY_MULTIMODAL,
      [segmentInput(unitId, 'mm_row_new_image')]);
    expect(db.pluck<number>(
      "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'mm_row_stable'")).toBe(1);

    dims().register(db, 1024, MODALITY_MULTIMODAL);
    dims().refreshCountsFromSegments(db);
    expect(db.pluck<number>(
      'SELECT record_count FROM vfs_embedding_dims WHERE dimension = 1024 AND modality = ?1',
      [MODALITY_MULTIMODAL])).toBe(1);

    segments().replaceByUnitAndModality(db, resourceId, unitId, MODALITY_MULTIMODAL, []);
    dims().refreshCountsFromSegments(db);
    expect(db.pluck<number>(
      "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'mm_row_new_image'")).toBe(1);
    expect(db.pluck<number>(
      'SELECT record_count FROM vfs_embedding_dims WHERE dimension = 1024 AND modality = ?1',
      [MODALITY_MULTIMODAL])).toBe(0);

    segments().replaceByUnitAndModality(db, resourceId, unitId, MODALITY_MULTIMODAL,
      [segmentInput(unitId, 'mm_row_new_image')]);
    expect(db.pluck<number>(
      "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'mm_row_new_image'")).toBe(0);
  });

  it('bare_segment_deletes_enqueue_orphans_by_default', () => {
    const { unitId } = seedUnit();
    segments().create(db, segmentInput(unitId, 'mm_row_bare_a'));
    segments().deleteByUnitAndModality(db, unitId, MODALITY_MULTIMODAL);
    expect(db.pluck<number>(
      "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'mm_row_bare_a'")).toBe(1);

    const inputB = segmentInput(unitId, 'mm_row_bare_b');
    inputB.segmentIndex = 1;
    segments().create(db, inputB);
    segments().deleteByUnitAndModalityUnsafe(db, unitId, MODALITY_MULTIMODAL);
    expect(db.pluck<number>(
      "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'mm_row_bare_b'")).toBe(0);

    const inputC = segmentInput(unitId, 'mm_row_bare_c');
    inputC.segmentIndex = 2;
    const seg = segments().create(db, inputC);
    expect(segments().delete(db, seg.id)).toBe(true);
    expect(db.pluck<number>(
      "SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = 'mm_row_bare_c'")).toBe(1);
  });

  it('image_segment_falls_back_to_multimodal_dims_profile', () => {
    const { unitId } = seedUnit();
    const dim = dims().registerWithModel(db, 1024, MODALITY_MULTIMODAL,
      'cfg-mm-fallback', 'mm-model');
    const expectedProfile = dim.activeProfileId!;

    const input = segmentInput(unitId, 'mm_row_image_norm');
    input.modality = 'image';
    const created = segments().create(db, input);
    expect(created.indexProfileId).toBe(expectedProfile);

    const batchInput = segmentInput(unitId, 'mm_row_image_norm_batch');
    batchInput.modality = 'image';
    batchInput.segmentIndex = 1;
    const batch = segments().batchCreate(db, [batchInput]);
    expect(batch[0]!.indexProfileId).toBe(expectedProfile);
  });

  it('reenqueue_makes_a_high_retry_orphan_due_immediately', () => {
    db.run(`INSERT INTO __lance_orphan_queue
      (lance_row_id, resource_id, retry_count, next_retry_at, last_error)
      VALUES ('emb_deferred', 'res_old', 99, ?1, 'old failure')`, [Date.now() + 3_600_000]);

    segments().enqueueLanceOrphan(db, 'emb_deferred', 'res_new');
    const state = db.get<{ resource_id: string; retry_count: number; next_retry_at: number; last_error: string | null }>(
      `SELECT resource_id, retry_count, next_retry_at, last_error
       FROM __lance_orphan_queue WHERE lance_row_id = 'emb_deferred'`)!;
    expect([state.resource_id, state.retry_count, state.next_retry_at, state.last_error])
      .toEqual(['res_new', 99, 0, null]);
  });

  // R12-09: Rust i64 generation is copied unit -> segment without f64 rounding.
  it('R12-09 segment writes and reads keep unit i64 generation exact', () => {
    const exactGeneration = defineQuery<[string], { generation: bigint }>(
      'SELECT generation FROM vfs_index_segments WHERE lance_row_id = ?1', { options: { safeIntegers: true } });
    for (const generation of [9007199254740993n, 9223372036854775807n]) {
      const { resourceId, unitId } = seedUnit();
      db.run('UPDATE vfs_index_units SET mm_generation = ?1, text_generation = ?1 WHERE id = ?2', [generation, unitId]);
      expect(host.ctx.vfsRepo.embeddingUnits.getById(db, unitId)?.mmGeneration).toBe(generation);

      const replaced = segments().replaceByUnitAndModality(db, resourceId, unitId, MODALITY_MULTIMODAL,
        [segmentInput(unitId, `mm_${generation}`)]);
      expect(replaced[0]!.generation).toBe(generation);
      expect(db.get(exactGeneration, [`mm_${generation}`])?.generation).toBe(generation);
      expect(segments().getByUnitAndModality(db, unitId, MODALITY_MULTIMODAL)[0]!.generation).toBe(generation);

      const text = segments().create(db, { ...segmentInput(unitId, `text_${generation}`), modality: 'text' });
      expect(text.generation).toBe(generation);
      expect(db.get(exactGeneration, [`text_${generation}`])?.generation).toBe(generation);

      db.run('DELETE FROM vfs_index_segments WHERE unit_id = ?1', [unitId]);
      db.run('DELETE FROM vfs_index_units WHERE id = ?1', [unitId]);
      db.run('DELETE FROM resources WHERE id = ?1', [resourceId]);
    }
  });
});
