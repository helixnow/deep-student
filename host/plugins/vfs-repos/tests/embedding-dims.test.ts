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

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-embedding-dim-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const dims = () => host.ctx.vfsRepo.embeddingDims;

describe('embedding_dim_repo.rs', { timeout: 120_000 }, () => {
  it('test_has_indexing_units_for_dimension_text', () => {
    db.run(`INSERT INTO vfs_index_units
      (id, resource_id, unit_index, text_state, text_embedding_dim, mm_state, mm_embedding_dim, created_at, updated_at)
      VALUES ('unit_text', 'res_unit_text', 0, 'indexing', NULL, 'disabled', NULL, ?1, ?1)`, [Date.now()]);
    db.run(`INSERT INTO vfs_index_segments (id, unit_id, modality, embedding_dim, segment_index, lance_row_id, created_at, updated_at)
      VALUES ('seg_text', 'unit_text', 'text', 512, 0, 'emb_seg_text', ?1, ?1)`, [Date.now()]);

    expect(dims().hasIndexingUnitsForDimension(db, 512, 'text')).toBe(true);
    expect(dims().hasIndexingUnitsForDimension(db, 512, 'multimodal')).toBe(false);
  });

  it('test_has_indexing_units_for_dimension_multimodal', () => {
    db.run(`INSERT INTO vfs_index_units
      (id, resource_id, unit_index, text_state, text_embedding_dim, mm_state, mm_embedding_dim, created_at, updated_at)
      VALUES ('unit_mm', 'res_unit_mm', 0, 'disabled', NULL, 'indexing', NULL, ?1, ?1)`, [Date.now()]);
    db.run(`INSERT INTO vfs_index_segments (id, unit_id, modality, embedding_dim, segment_index, lance_row_id, created_at, updated_at)
      VALUES ('seg_mm', 'unit_mm', 'multimodal', 1024, 0, 'emb_seg_mm', ?1, ?1)`, [Date.now()]);

    expect(dims().hasIndexingUnitsForDimension(db, 1024, 'multimodal')).toBe(true);
    expect(dims().hasIndexingUnitsForDimension(db, 1024, 'text')).toBe(false);
  });

  it('model_name_change_rolls_profiles_without_a_query_gap', () => {
    const now = Date.now();
    const first = dims().registerWithModel(db, 768, 'text', 'cfg_same', 'model-a');
    const firstProfileId = first.activeProfileId!;
    db.run(`INSERT INTO resources
      (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
      VALUES ('res_profile_roll', 'hash_profile_roll', 'note', 'inline', 'text', 0, 'indexed', ?1, ?1)`, [now]);
    db.run(`INSERT INTO vfs_index_units
      (id, resource_id, unit_index, text_content, text_required, text_state,
       text_embedding_dim, text_profile_id, text_generation, created_at, updated_at)
      VALUES ('unit_profile_roll', 'res_profile_roll', 0, 'text', 1, 'indexed',
              768, ?1, 1, ?2, ?2)`, [firstProfileId, now]);
    db.run(`INSERT INTO vfs_index_segments
      (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
       index_profile_id, generation, created_at, updated_at)
      VALUES ('seg_profile_old', 'unit_profile_roll', 0, 'text', 768,
              'emb_profile_old', ?1, 1, ?2, ?2)`, [firstProfileId, now]);
    dims().refreshCountsFromSegments(db);
    db.run("UPDATE vfs_embedding_dims SET record_count = 0 WHERE dimension = 768 AND modality = 'text'");

    const second = dims().registerWithModel(db, 768, 'text', 'cfg_same', 'model-b');
    const secondProfileId = second.activeProfileId!;
    expect(secondProfileId).not.toBe(firstProfileId);
    expect(dims().modelFingerprint('cfg_same', 'model-a', 'text-embedding-v1'))
      .not.toBe(dims().modelFingerprint('cfg_same', 'model-b', 'text-embedding-v1'));
    expect(dims().getProfileById(db, firstProfileId)!.state).toBe('queryable');
    expect(dims().getProfileById(db, secondProfileId)!.state).toBe('building');
    const pending = db.get<{ index_state: string; index_retry_count: number; index_next_retry_at: number }>(
      "SELECT index_state, index_retry_count, index_next_retry_at FROM resources WHERE id = 'res_profile_roll'")!;
    expect([pending.index_state, pending.index_retry_count, pending.index_next_retry_at])
      .toEqual(['pending', 0, 0]);

    db.run(`UPDATE vfs_index_units SET text_profile_id = ?1, text_generation = 2
      WHERE id = 'unit_profile_roll'`, [secondProfileId]);
    db.run("DELETE FROM vfs_index_segments WHERE id = 'seg_profile_old'");
    db.run(`INSERT INTO vfs_index_segments
      (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
       index_profile_id, generation, created_at, updated_at)
      VALUES ('seg_profile_new', 'unit_profile_roll', 0, 'text', 768,
              'emb_profile_new', ?1, 2, ?2, ?2)`, [secondProfileId, now]);
    dims().refreshCountsFromSegments(db);
    expect(dims().getProfileById(db, firstProfileId)!.state).toBe('retired');
    expect(dims().getProfileById(db, secondProfileId)!.state).toBe('active');
  });

  it('legacy_profile_registration_without_override_creates_a_new_space', () => {
    const now = Date.now();
    const legacy = dims().registerWithModel(db, 768, 'text', 'cfg-legacy-direct', 'Legacy display name');
    const legacyProfileId = legacy.activeProfileId!;
    db.run(`INSERT INTO resources
      (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
      VALUES ('res_legacy_direct', 'hash_legacy_direct', 'note', 'inline', 'text', 0, 'indexed', ?1, ?1)`, [now]);
    db.run(`INSERT INTO vfs_index_units
      (id, resource_id, unit_index, text_content, text_required, text_state,
       text_embedding_dim, text_profile_id, text_generation, created_at, updated_at)
      VALUES ('unit_legacy_direct', 'res_legacy_direct', 0, 'text', 1, 'indexed',
              768, ?1, 1, ?2, ?2)`, [legacyProfileId, now]);
    db.run(`INSERT INTO vfs_index_segments
      (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
       index_profile_id, generation, created_at, updated_at)
      VALUES ('seg_legacy_direct', 'unit_legacy_direct', 0, 'text', 768,
              'emb_legacy_direct', ?1, 1, ?2, ?2)`, [legacyProfileId, now]);
    dims().refreshCountsFromSegments(db);
    db.run(`UPDATE vfs_embedding_dims
      SET model_fingerprint = 'legacy:model-config:cfg-legacy-direct', model_name = 'Provider - model-real'
      WHERE dimension = 768 AND modality = 'text'`);
    db.run(`UPDATE vfs_index_profiles
      SET model_fingerprint = 'legacy:model-config:cfg-legacy-direct', model_name = 'Provider - model-real'
      WHERE id = ?1`, [legacyProfileId]);

    const strong = dims().registerWithModel(db, 768, 'text', 'cfg-legacy-direct', 'model-real');
    const strongProfileId = strong.activeProfileId!;
    const strongFingerprint = dims().modelFingerprint('cfg-legacy-direct', 'model-real', 'text-embedding-v1');

    expect(strongProfileId).not.toBe(legacyProfileId);
    expect(strong.lanceTableName).not.toBe(legacy.lanceTableName);
    expect(strong.modelFingerprint).toBe(strongFingerprint);
    const oldProfile = dims().getProfileById(db, legacyProfileId)!;
    const newProfile = dims().getProfileById(db, strongProfileId)!;
    expect(oldProfile.modelFingerprint).toBe('legacy:model-config:cfg-legacy-direct');
    expect(oldProfile.state).toBe('queryable');
    expect(newProfile.state).toBe('building');

    const activeBinding = db.get<{ active_profile_id: string; model_fingerprint: string }>(
      "SELECT active_profile_id, model_fingerprint FROM vfs_embedding_dims WHERE dimension = 768 AND modality = 'text'")!;
    expect([activeBinding.active_profile_id, activeBinding.model_fingerprint])
      .toEqual([strongProfileId, strongFingerprint]);
    const pending = db.get<{ text_state: string; index_state: string }>(
      `SELECT u.text_state, r.index_state FROM vfs_index_units u
       JOIN resources r ON r.id = u.resource_id WHERE u.id = 'unit_legacy_direct'`)!;
    expect([pending.text_state, pending.index_state]).toEqual(['pending', 'pending']);
  });

  it('assigned_unit_without_committed_manifest_rebuilds_without_queryable_old_profile', () => {
    const now = Date.now();
    const first = dims().registerWithModel(db, 768, 'text', 'cfg-empty-a', 'model-a');
    const firstProfileId = first.activeProfileId!;
    db.run(`INSERT INTO resources
      (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
      VALUES ('res_empty_manifest', 'hash_empty_manifest', 'note', 'inline', 'text', 0, 'indexed', ?1, ?1)`, [now]);
    db.run(`INSERT INTO vfs_index_units
      (id, resource_id, unit_index, text_content, text_required, text_state,
       text_embedding_dim, text_profile_id, text_generation, created_at, updated_at)
      VALUES ('unit_empty_manifest', 'res_empty_manifest', 0, 'text', 1, 'indexed',
              768, ?1, 3, ?2, ?2)`, [firstProfileId, now]);

    const second = dims().registerWithModel(db, 768, 'text', 'cfg-empty-b', 'model-b');
    const secondProfileId = second.activeProfileId!;
    expect(dims().getProfileById(db, firstProfileId)!.state).toBe('retired');
    expect(dims().getProfileById(db, secondProfileId)!.state).toBe('active');
    expect(db.pluck<string>("SELECT text_state FROM vfs_index_units WHERE id = 'unit_empty_manifest'"))
      .toBe('pending');
    expect(db.pluck<string>("SELECT index_state FROM resources WHERE id = 'res_empty_manifest'"))
      .toBe('pending');
  });

  it('profile_activation_requires_committed_unit_generation_manifest', () => {
    const now = Date.now();
    const first = dims().registerWithModel(db, 768, 'text', 'cfg-generation-a', 'model-a');
    const firstProfileId = first.activeProfileId!;
    db.run(`INSERT INTO resources
      (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
      VALUES ('res_generation_manifest', 'hash_generation_manifest', 'note', 'inline', 'text', 0, 'indexed', ?1, ?1)`, [now]);
    db.run(`INSERT INTO vfs_index_units
      (id, resource_id, unit_index, text_content, text_required, text_state,
       text_embedding_dim, text_profile_id, text_generation, created_at, updated_at)
      VALUES ('unit_generation_manifest', 'res_generation_manifest', 0, 'text', 1, 'indexed',
              768, ?1, 2, ?2, ?2)`, [firstProfileId, now]);
    db.run(`INSERT INTO vfs_index_segments
      (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
       index_profile_id, generation, created_at, updated_at)
      VALUES ('seg_generation_old', 'unit_generation_manifest', 0, 'text', 768,
              'emb_generation_old', ?1, 2, ?2, ?2)`, [firstProfileId, now]);

    const second = dims().registerWithModel(db, 768, 'text', 'cfg-generation-b', 'model-b');
    const secondProfileId = second.activeProfileId!;
    expect(dims().getProfileById(db, secondProfileId)!.state).toBe('building');

    db.run(`INSERT INTO vfs_index_segments
      (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
       index_profile_id, generation, created_at, updated_at)
      VALUES ('seg_generation_stale', 'unit_generation_manifest', 1, 'text', 768,
              'emb_generation_stale', ?1, 1, ?2, ?2)`, [secondProfileId, now]);
    db.run(`UPDATE vfs_index_units SET text_profile_id = ?1, text_generation = 2
      WHERE id = 'unit_generation_manifest'`, [secondProfileId]);
    dims().refreshCountsFromSegments(db);
    expect(dims().getProfileById(db, secondProfileId)!.state).toBe('building');
    expect(() => dims().activateProfile(db, secondProfileId, 1)).toThrow();

    db.run(`INSERT INTO vfs_index_segments
      (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
       index_profile_id, generation, created_at, updated_at)
      VALUES ('seg_generation_current', 'unit_generation_manifest', 2, 'text', 768,
              'emb_generation_current', ?1, 2, ?2, ?2)`, [secondProfileId, now]);
    dims().refreshCountsFromSegments(db);
    expect(dims().getProfileById(db, secondProfileId)!.state).toBe('active');
    expect(dims().activateProfile(db, secondProfileId, 1).state).toBe('active');
  });

  it('profile_identity_includes_dimension_and_registration_is_atomic', () => {
    const fingerprint = dims().modelFingerprint('cfg-shared', 'model-shared', 'text-embedding-v1');
    const first = dims().registerWithModelFingerprint(db, 768, 'text', 'cfg-shared', 'model-shared', fingerprint);
    const second = dims().registerWithModelFingerprint(db, 1024, 'text', 'cfg-shared', 'model-shared', fingerprint);
    expect(first.activeProfileId).not.toBe(second.activeProfileId);
    expect(first.lanceTableName).not.toBe(second.lanceTableName);

    const firstProfileId = first.activeProfileId!;
    db.exec(`CREATE TRIGGER reject_profile_switch
      BEFORE UPDATE OF active_profile_id ON vfs_embedding_dims
      WHEN OLD.dimension = 768 AND NEW.model_name = 'model-rejected'
      BEGIN SELECT RAISE(ABORT, 'reject profile switch'); END;`);
    expect(() => dims().registerWithModel(db, 768, 'text', 'cfg-rejected', 'model-rejected')).toThrow();
    const current = dims().getByKey(db, 768, 'text')!;
    expect(current.activeProfileId).toBe(firstProfileId);
    expect(current.modelName).toBe('model-shared');
    expect(dims().getProfileById(db, firstProfileId)!.state).toBe('active');
    expect(db.pluck<number>("SELECT COUNT(*) FROM vfs_index_profiles WHERE model_config_id = 'cfg-rejected'"))
      .toBe(0);
  });

  it('endpoint_change_rolls_profile_without_hashing_secrets', () => {
    const firstConfig = {
      id: 'cfg_transport', model: 'embed-model', name: 'Display name',
      baseUrl: 'https://user:secret@example.com/v1/?api_key=hidden',
      providerType: 'openai-compatible', providerScope: 'custom', apiProtocol: 'openai',
      modelAdapter: 'openai', apiKey: 'first-secret', enabled: true, isEmbedding: true,
    };
    const firstFingerprint = dims().modelFingerprintForConfig(firstConfig, 'text');
    firstConfig.apiKey = 'rotated-secret';
    (firstConfig as unknown as { headers?: Record<string, string> }).headers = {
      Authorization: 'Bearer another-secret',
    };
    expect(dims().modelFingerprintForConfig(firstConfig, 'text')).toBe(firstFingerprint);

    const secondConfig = { ...firstConfig, baseUrl: 'https://example.net/v1' };
    const secondFingerprint = dims().modelFingerprintForConfig(secondConfig, 'text');
    expect(secondFingerprint).not.toBe(firstFingerprint);

    const first = dims().registerWithModelFingerprint(db, 768, 'text', firstConfig.id,
      firstConfig.model, firstFingerprint);
    const firstProfile = first.activeProfileId!;
    const second = dims().registerWithModelFingerprint(db, 768, 'text', secondConfig.id,
      secondConfig.model, secondFingerprint);
    const secondProfile = second.activeProfileId!;
    expect(secondProfile).not.toBe(firstProfile);
    expect(dims().getProfileById(db, firstProfile)!.state).toBe('retired');
  });

  it('dimension_cascade_enqueues_orphans_and_collects_all_profile_tables', () => {
    const now = Date.now();
    const first = dims().registerWithModel(db, 768, 'text', 'cfg-cascade-a', 'model-a');
    const firstProfileId = first.activeProfileId!;
    db.run(`INSERT INTO resources
      (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
      VALUES ('res_cascade', 'hash_cascade', 'note', 'inline', 'text', 0, 'indexed', ?1, ?1)`, [now]);
    db.run(`INSERT INTO vfs_index_units
      (id, resource_id, unit_index, text_content, text_required, text_state,
       text_embedding_dim, text_profile_id, text_generation, created_at, updated_at)
      VALUES ('unit_cascade', 'res_cascade', 0, 'text', 1, 'indexed',
              768, ?1, 1, ?2, ?2)`, [firstProfileId, now]);
    db.run(`INSERT INTO vfs_index_segments
      (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
       index_profile_id, generation, created_at, updated_at)
      VALUES ('seg_cascade_old', 'unit_cascade', 0, 'text', 768,
              'emb_cascade_old', ?1, 1, ?2, ?2)`, [firstProfileId, now]);
    dims().refreshCountsFromSegments(db);

    const second = dims().registerWithModel(db, 768, 'text', 'cfg-cascade-b', 'model-b');
    db.run(`INSERT INTO vfs_index_segments
      (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
       index_profile_id, generation, created_at, updated_at)
      VALUES ('seg_cascade_new', 'unit_cascade', 1, 'text', 768,
              'emb_cascade_new', ?1, 1, ?2, ?2)`, [second.activeProfileId!, now]);

    const cleanup = dims().deleteDimensionCascadeCollect(db, 768, 'text');
    expect(cleanup.deletedSegments).toBe(2);
    expect(cleanup.lanceTableNames).toContain(first.lanceTableName);
    expect(cleanup.lanceTableNames).toContain(second.lanceTableName);
    for (const rowId of ['emb_cascade_old', 'emb_cascade_new']) {
      expect(db.pluck<number>('SELECT COUNT(*) FROM __lance_orphan_queue WHERE lance_row_id = ?1', [rowId]))
        .toBe(1);
    }
    expect(db.pluck<string | null>("SELECT text_profile_id FROM vfs_index_units WHERE id = 'unit_cascade'"))
      .toBeNull();
  });
});
