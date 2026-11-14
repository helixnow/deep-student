import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
// boundary-allow cross-plugin-impl: real table-owner repositories exercised through the production service
import reposPlugin from '../../vfs-repos/index.ts';
import type { VfsIndexUnit } from '../../vfs-repos/api.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import type { UnitBuildInput, VfsIndexMaintenanceService } from '../api.ts';
import { pathsServiceDouble } from './support/paths-service.ts';

interface UnitBuilderService { syncResourceUnits(input: UnitBuildInput): VfsIndexUnit[] }

type TestStorage = ReturnType<typeof createStorageService>;

let templateDir = '';
const roots: string[] = [];
const storages: TestStorage[] = [];
const hosts: TestHost[] = [];

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-unit-sync-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  try {
    const report = await storage.migrations.runAll();
    if (!report.success) throw new Error(report.error ?? 'vfs migration failed');
  } finally {
    storage.dispose();
  }
}, 180_000);

afterEach(async () => {
  while (hosts.length > 0) await hosts.pop()!.dispose();
  while (storages.length > 0) storages.pop()!.dispose();
  while (roots.length > 0) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

interface Harness {
  host: TestHost;
  db: DatabaseHandle;
  storage: TestStorage;
  repositories: VfsReposService;
  unitBuilder: UnitBuilderService;
  maintenance: VfsIndexMaintenanceService;
}

async function harness(): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-unit-sync-'));
  roots.push(root);
  fs.cpSync(templateDir, root, { recursive: true });
  const storage = createStorageService({ baseDir: root, dataLocalDir: path.join(root, 'local') });
  storages.push(storage);
  const host = await createTestHost({
    plugins: [reposPlugin, plugin],
    provide: { storage, paths: pathsServiceDouble() },
  });
  hosts.push(host);
  return {
    host,
    db: storage.database('vfs'),
    storage,
    repositories: host.ctx.get('vfsRepo') as VfsReposService,
    unitBuilder: host.ctx.get('vfsUnitBuilder') as UnitBuilderService,
    maintenance: host.ctx.vfsIndexMaintenance,
  };
}

function seedIndexedUnit(db: DatabaseHandle, resourceId: string): string {
  const now = Date.now();
  db.run(
    `INSERT INTO resources
       (id, hash, type, storage_mode, data, ref_count, created_at, updated_at,
        index_state, mm_index_state)
     VALUES (?1, ?2, 'note', 'inline', 'content', 0, ?3, ?3, 'indexed', 'indexed')`,
    [resourceId, `hash_${resourceId}`, now],
  );
  const unitId = `unit_${resourceId}`;
  db.run(
    `INSERT INTO vfs_index_units
       (id, resource_id, unit_index, text_content, text_required, mm_required,
        image_blob_hash, text_state, mm_state, created_at, updated_at)
     VALUES (?1, ?2, 0, 'text', 1, 1, 'blob1', 'indexed', 'indexed', ?3, ?3)`,
    [unitId, resourceId, now],
  );
  return unitId;
}

function states(db: DatabaseHandle, resourceId: string, unitId: string): [string, string, string, string] {
  const unit = db.get<{ text_state: string; mm_state: string }>(
    'SELECT text_state, mm_state FROM vfs_index_units WHERE id = ?1',
    [unitId],
  )!;
  const resource = db.get<{ index_state: string; mm_index_state: string }>(
    'SELECT index_state, mm_index_state FROM resources WHERE id = ?1',
    [resourceId],
  )!;
  return [unit.text_state, unit.mm_state, resource.index_state, resource.mm_index_state];
}

describe('Rust index_service.rs sync_resource_units', () => {
  it('sync_resource_units_uses_single_pool_connection', async () => {
    const { host, db, storage, unitBuilder } = await harness();
    const resourceId = 'res_sync_single_connection';
    seedIndexedUnit(db, resourceId);

    // The service binds the shared vfs handle once at start-up; syncing never
    // re-acquires it, so a saturated connection pool cannot deadlock the write.
    const databases = vi.spyOn(storage, 'database');
    const units = unitBuilder.syncResourceUnits({
      resourceId,
      resourceType: 'note',
      data: 'updated note content',
    });
    expect(databases).not.toHaveBeenCalled();
    expect(units).toHaveLength(1);
    expect(units[0]!.textContent).toBe('updated note content');
    expect(db.pluck('SELECT index_state FROM resources WHERE id = ?1', [resourceId])).toBe('pending');
    expect(host.ctx.get('vfsUnitBuilder')).toBe(unitBuilder);
  });

  it('syncResourceUnits rejects unsupported resource types with the Rust InvalidArgument text', async () => {
    const { unitBuilder } = await harness();
    expect(() => unitBuilder.syncResourceUnits({
      resourceId: 'res_retrieval',
      resourceType: 'retrieval',
    })).toThrow("Invalid argument 'resource_type': Unsupported resource type: retrieval");
  });
});

describe('Rust index_service.rs reset_unit_index', () => {
  it('reset_unit_index_text_mode_updates_unit_and_resource_atomically', async () => {
    const { db, maintenance } = await harness();
    const resourceId = 'res_n07_text';
    const unitId = seedIndexedUnit(db, resourceId);

    maintenance.resetUnitIndex(unitId, 'text');

    expect(states(db, resourceId, unitId)).toEqual(['pending', 'indexed', 'pending', 'indexed']);
  });

  it('reset_unit_index_mm_mode_updates_unit_and_resource_atomically', async () => {
    const { db, maintenance } = await harness();
    const resourceId = 'res_n07_mm';
    const unitId = seedIndexedUnit(db, resourceId);

    maintenance.resetUnitIndex(unitId, 'mm');

    expect(states(db, resourceId, unitId)).toEqual(['indexed', 'pending', 'indexed', 'pending']);
  });

  it('reset_unit_index_both_mode_updates_all_four_states', async () => {
    const { db, maintenance } = await harness();
    const resourceId = 'res_n07_both';
    const unitId = seedIndexedUnit(db, resourceId);

    maintenance.resetUnitIndex(unitId, 'both');

    expect(states(db, resourceId, unitId)).toEqual(['pending', 'pending', 'pending', 'pending']);
  });

  it('reset_unit_index_unknown_mode_writes_nothing', async () => {
    const { db, maintenance } = await harness();
    const resourceId = 'res_n07_bad';
    const unitId = seedIndexedUnit(db, resourceId);

    expect(() => maintenance.resetUnitIndex(unitId, 'bogus'))
      .toThrow("unsupported index reset mode 'bogus'; expected text, mm, or both");
    expect(states(db, resourceId, unitId)).toEqual(['indexed', 'indexed', 'indexed', 'indexed']);
  });

  it('rolls unit changes back when the resource scheduling update fails', async () => {
    const { db, maintenance } = await harness();
    const resourceId = 'res_n07_rollback';
    const unitId = seedIndexedUnit(db, resourceId);
    db.exec(
      "CREATE TRIGGER fail_schedule BEFORE UPDATE OF index_state ON resources BEGIN SELECT RAISE(ABORT, 'schedule rejected'); END",
    );

    expect(() => maintenance.resetUnitIndex(unitId, 'both')).toThrow('schedule rejected');
    expect(states(db, resourceId, unitId)).toEqual(['indexed', 'indexed', 'indexed', 'indexed']);
  });
});

describe('Rust index_service.rs delete_resource_index', () => {
  it('deleteResourceIndex enqueues Lance rows and refreshes dimension counts', async () => {
    const { db, maintenance } = await harness();
    const resourceId = 'res_delete';
    const unitId = seedIndexedUnit(db, resourceId);
    db.run(
      `INSERT INTO vfs_index_segments
         (id, unit_id, segment_index, modality, embedding_dim, lance_row_id, content_text,
          created_at, updated_at)
       VALUES ('seg_1', ?1, 0, 'text', 128, 'row_1', 'chunk', 0, 0)`,
      [unitId],
    );
    db.run(
      `INSERT INTO vfs_embedding_dims
         (dimension, modality, lance_table_name, record_count, created_at, last_used_at)
       VALUES (128, 'text', 'vfs_emb_text_128', 4, 0, 0)`,
    );

    maintenance.deleteResourceIndex(resourceId);

    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units WHERE resource_id = ?1', [resourceId])).toBe(0);
    expect(db.pluck('SELECT lance_row_id FROM __lance_orphan_queue')).toBe('row_1');
    expect(db.pluck("SELECT record_count FROM vfs_embedding_dims WHERE modality = 'text' AND dimension = 128")).toBe(0);
  });
});

describe('Rust multimodal_service.rs process_pending_batch', () => {
  it('claims pending mm units, counts failures and recovers the resource from indexing', async () => {
    const { host, db } = await harness();
    const now = Date.now();
    db.run(
      `INSERT INTO resources
         (id, hash, type, storage_mode, data, ref_count, created_at, updated_at,
          index_state, mm_index_state)
       VALUES ('res_mm_batch', 'hash_mm_batch', 'file', 'inline', NULL, 0, ?1, ?1, 'indexed', 'pending')`,
      [now],
    );
    db.run(
      `INSERT INTO vfs_index_units
         (id, resource_id, unit_index, text_content, text_required, mm_required,
          image_blob_hash, image_mime_type, text_state, mm_state, created_at, updated_at)
       VALUES ('unit_mm_batch', 'res_mm_batch', 0, NULL, 0, 1, 'blob_page', 'image/png',
               'disabled', 'pending', ?1, ?1)`,
      [now],
    );

    // The configured L02 multimodal model is absent in this host, so the Rust
    // "not configured" failure path still claims the resource, counts it as
    // failed and clears `indexing`.
    const result = await host.ctx.vfsIndex.multimodal.processPendingBatch(10);

    expect(result).toEqual([0, 1]);
    expect(db.pluck('SELECT mm_index_state FROM resources WHERE id = ?1', ['res_mm_batch'])).toBe('failed');
    expect(String(db.pluck('SELECT mm_index_error FROM resources WHERE id = ?1', ['res_mm_batch']))).toContain(
      '还没有启用多模态索引',
    );
  });
});

describe('Rust index_service.rs get_status_summary', () => {
  it('get_status_summary_returns_zeroed_counts_for_an_empty_index', async () => {
    const { host } = await harness();

    expect(host.ctx.vfsIndex.getStatusSummary!()).toEqual({
      totalUnits: 0,
      textStats: { pending: 0, indexing: 0, indexed: 0, failed: 0, disabled: 0 },
      mmStats: { pending: 0, indexing: 0, indexed: 0, failed: 0, disabled: 0 },
      dimensions: [],
    });
  });

  it('reads unit states and segment modality dimensions through the bound L11 repositories', async () => {
    const { host, db, repositories } = await harness();
    const created = repositories.resources.createOrReuse(
      db, 'note', 'status summary content', null, null, null,
    );
    const resourceId = created.resourceId;
    const textUnit = repositories.embeddingUnits.create(db, {
      resourceId, unitIndex: 0, imageBlobHash: null, imageMimeType: null,
      textContent: 'indexed page', textSource: 'native',
    });
    repositories.embeddingUnits.setTextIndexed(db, textUnit.id, 1, 64);
    repositories.embeddingUnits.setMmState(db, textUnit.id, 'pending', null);
    const failedUnit = repositories.embeddingUnits.create(db, {
      resourceId, unitIndex: 1, imageBlobHash: null, imageMimeType: null,
      textContent: 'failed page', textSource: 'native',
    });
    repositories.embeddingUnits.setTextState(db, failedUnit.id, 'failed', 'text failed');
    repositories.embeddingUnits.setMmState(db, failedUnit.id, 'disabled', null);
    for (const [index, unit] of [textUnit, failedUnit].entries()) {
      repositories.embeddingSegments.create(db, {
        unitId: unit.id, segmentIndex: 0, modality: 'text', embeddingDim: 64,
        lanceRowId: `status-row-${index}`, contentText: 'chunk', contentHash: null,
        startPos: null, endPos: null, metadataJson: null,
      });
    }

    expect(host.ctx.vfsIndex.getStatusSummary!()).toEqual({
      totalUnits: 2,
      textStats: { pending: 0, indexing: 0, indexed: 1, failed: 1, disabled: 0 },
      mmStats: { pending: 1, indexing: 0, indexed: 0, failed: 0, disabled: 1 },
      dimensions: [{ dimension: 64, modality: 'text', count: 2 }],
    });
  });
});
