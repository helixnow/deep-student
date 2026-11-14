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
import { runConcurrent } from './support/concurrency.ts';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-resource-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const resources = () => host.ctx.vfsRepo.resources;

describe('resource_repo.rs', { timeout: 120_000 }, () => {
  it('test_create_or_reuse_dedup', () => {
    const result1 = resources().createOrReuse(db, 'note', 'test content', 'note_123', 'notes', null);
    expect(result1.isNew).toBe(true);

    const result2 = resources().createOrReuse(db, 'note', 'test content', 'note_456', 'notes', null);
    expect(result2.isNew).toBe(false);
    expect(result2.resourceId).toBe(result1.resourceId);
    expect(result2.hash).toBe(result1.hash);
  });

  it('test_get_resource', () => {
    const result = resources().createOrReuse(db, 'note', 'test content', 'note_123', 'notes', null);
    const resource = resources().getResource(db, result.resourceId);
    expect(resource).not.toBeNull();
    expect(resource!.id).toBe(result.resourceId);
    expect(resource!.hash).toBe(result.hash);
    expect(resource!.data).toBe('test content');
  });

  it('get_live_resource_keeps_deleted_at_out_of_the_dto_and_source_file_deletion_independent', () => {
    const live = resources().createOrReuse(db, 'note', 'live content', 'note_live', 'notes', null);
    const liveResource = resources().getLiveResource(db, live.resourceId);
    expect(liveResource?.id).toBe(live.resourceId);
    expect(liveResource !== null && 'deletedAt' in liveResource).toBe(false);

    const deleted = resources().createOrReuse(db, 'note', 'deleted content', 'note_deleted', 'notes', null);
    db.run('UPDATE resources SET deleted_at = ?1 WHERE id = ?2', [Date.now(), deleted.resourceId]);
    expect(resources().getLiveResource(db, deleted.resourceId)).toBeNull();
    // getResource keeps its original "includes soft-deleted rows" semantics.
    expect(resources().getResource(db, deleted.resourceId)).not.toBeNull();

    expect(resources().getLiveResource(db, 'res_missing')).toBeNull();

    const file = host.ctx.vfsRepo.files.createFile(
      db, 'sha_live_source', 'live.pdf', 10, 'document', 'application/pdf', null, null);
    host.ctx.vfsRepo.files.deleteFile(db, file.id);
    expect(resources().getLiveResource(db, file.resourceId!)).not.toBeNull();
  });

  it('test_ref_count', () => {
    const result = resources().createOrReuse(db, 'note', 'test content', null, null, null);
    expect(resources().getResource(db, result.resourceId)!.refCount).toBe(0);
    expect(resources().incrementRef(db, result.resourceId)).toBe(1);
    expect(resources().incrementRef(db, result.resourceId)).toBe(2);
    expect(resources().decrementRef(db, result.resourceId)).toBe(1);
    expect(resources().decrementRef(db, result.resourceId)).toBe(0);
    expect(resources().decrementRef(db, result.resourceId)).toBe(0);
  });

  it('test_list_by_type', () => {
    resources().createOrReuse(db, 'note', 'math content', null, null, null);
    resources().createOrReuse(db, 'note', 'physics content', null, null, null);
    resources().createOrReuse(db, 'translation', 'translation content', null, null, null);

    expect(resources().listByType(db, null, 10, 0)).toHaveLength(3);
    expect(resources().listByType(db, 'note', 10, 0)).toHaveLength(2);
  });

  it('test_compute_hash', () => {
    const hash1 = resources().computeHash('test content');
    const hash2 = resources().computeHash('test content');
    const hash3 = resources().computeHash('different content');
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(hash3);
    expect(hash1).toHaveLength(64);
  });

  it('test_concurrent_create_same_hash', async () => {
    // 10 independent connections race the same INSERT OR IGNORE, like the Rust
    // thread::spawn test (resource_repo.rs:1173-1240).
    const testContent = 'concurrent test content';
    const expectedHash = resources().computeHash(testContent);
    const outcomes = await runConcurrent<{ resourceId: string; hash: string; isNew: boolean }>(
      Array.from({ length: 10 }, (_, index) => ({
        mode: 'resource' as const,
        dbPath: db.path,
        content: testContent,
        index,
      })));

    expect(outcomes).toHaveLength(10);
    const results = outcomes.map(outcome => {
      if (!outcome.ok) throw new Error(`create failed: ${outcome.message}`);
      return outcome.value;
    });
    const first = results[0]!;
    for (const result of results) {
      expect(result.resourceId).toBe(first.resourceId);
      expect(result.hash).toBe(expectedHash);
    }
    expect(results.filter(result => result.isNew)).toHaveLength(1);
    expect(db.pluck<number>('SELECT COUNT(*) FROM resources WHERE hash = ?1', [expectedHash])).toBe(1);
  });
});
