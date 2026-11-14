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

const MODALITY_TEXT = 'text';
let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-embedding-repo-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const dimensions = () => host.ctx.vfsRepo.embeddingDimensions;
const states = () => host.ctx.vfsRepo.indexStates;

describe('embedding_repo.rs', { timeout: 120_000 }, () => {
  it('test_register_dimension', () => {
    const tableName = dimensions().registerDimension(db, 768, MODALITY_TEXT, null);
    expect(tableName).toBe('vfs_emb_text_768');
    const dim = dimensions().getDimension(db, 768, MODALITY_TEXT)!;
    expect(dim.dimension).toBe(768);
    expect(dim.modality).toBe(MODALITY_TEXT);
  });

  it('requeue_paged_pdfs_runs_once_and_only_for_multi_page_files', () => {
    for (const id of ['res_pdf', 'res_one', 'res_note']) {
      db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, index_state, created_at, updated_at)
        VALUES (?1, ?1, 'file', 'inline', 'x', 'indexed', 0, 0)`, [id]);
    }
    for (const [id, res, pages] of [['file_pdf', 'res_pdf', 3], ['file_one', 'res_one', 1]] as const) {
      db.run(`INSERT INTO files (id, resource_id, sha256, file_name, size, page_count, created_at, updated_at)
        VALUES (?1, ?2, ?1, 'a.pdf', 1, ?3, '0', '0')`, [id, res, pages]);
    }
    expect(states().requeuePagedPdfsOnce(db)).toBe(1);
    expect(db.pluck<string>("SELECT index_state FROM resources WHERE id = 'res_pdf'")).toBe('pending');
    expect(states().requeuePagedPdfsOnce(db)).toBe(0);
  });

  it('test_revive_config_blocked_only_touches_embedding_config_failures', () => {
    for (const id of ['res_a', 'res_b', 'res_c']) {
      db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at)
        VALUES (?1, ?1, 'note', 'inline', 'x', 0, 0)`, [id]);
    }
    db.run(`INSERT INTO vfs_index_units (id, resource_id, unit_index, text_content, text_required,
        text_state, mm_required, mm_state, created_at, updated_at)
      VALUES ('u_a', 'res_a', 0, 'x', 1, 'failed', 0, 'disabled', 0, 0)`);
    states().markFailed(db, 'res_a', '获取嵌入模型配置失败: 默认文本嵌入配置已禁用或能力协议不匹配');
    states().markFailed(db, 'res_b', '找不到嵌入模型配置，请检查维度绑定的模型是否存在');
    states().markFailed(db, 'res_c', 'PDF 解析失败');

    expect(states().reviveConfigBlocked(db)).toBe(2);

    const row = (id: string) => db.get<{ index_state: string; index_retry_count: number; index_error: string | null }>(
      `SELECT index_state, COALESCE(index_retry_count, 0) AS index_retry_count, index_error
       FROM resources WHERE id = ?1`, [id])!;
    expect([row('res_a').index_state, row('res_a').index_retry_count, row('res_a').index_error])
      .toEqual(['pending', 0, null]);
    expect([row('res_b').index_state, row('res_b').index_retry_count, row('res_b').index_error])
      .toEqual(['pending', 0, null]);
    expect(row('res_c').index_state).toBe('failed');
    expect(row('res_c').index_retry_count).toBe(1);
    expect(db.pluck<string>("SELECT text_state FROM vfs_index_units WHERE id = 'u_a'")).toBe('pending');
    expect(states().reviveConfigBlocked(db)).toBe(0);
  });

  it('test_index_state', () => {
    db.run(`INSERT INTO resources (id, hash, type, storage_mode, data, created_at, updated_at)
      VALUES ('res_test', 'hash123', 'note', 'inline', 'test', 0, 0)`);
    states().markPending(db, 'res_test');
    expect(states().getIndexState(db, 'res_test')!.state).toBe('pending');
    states().markIndexed(db, 'res_test', 'hash123');
    const state = states().getIndexState(db, 'res_test')!;
    expect(state.state).toBe('indexed');
    expect(state.hash).toBe('hash123');
  });

  it('failed_resources_stop_requeueing_after_max_retries', () => {
    db.run(`INSERT INTO resources
      (id, hash, type, storage_mode, data, index_state, index_retry_count,
       index_next_retry_at, mm_index_state, mm_index_retry_count,
       mm_index_next_retry_at, created_at, updated_at)
      VALUES
      ('res_retry_text', 'hash_retry_text', 'note', 'inline', 'text',
       'failed', 99, 0, NULL, 0, 0, 0, 10),
      ('res_retry_mm', 'hash_retry_mm', 'image', 'inline', '',
       'disabled', 0, 0, 'failed', 99, 0, 0, 20)`);

    const text = states().getPendingResources(db, 10, 3);
    const multimodal = states().getMmPendingResources(db, 10, 3);
    expect(text).not.toContain('res_retry_text');
    expect(multimodal).not.toContain('res_retry_mm');

    expect(states().getPendingResources(db, 10, 200)).toContain('res_retry_text');
    expect(states().getMmPendingResources(db, 10, 200)).toContain('res_retry_mm');

    expect(states().claimMmIndexingResources(db, ['res_retry_mm'], 3)).toEqual([]);

    states().markFailed(db, 'res_retry_text', 'again');
    const retry = db.get<{ index_retry_count: number; index_next_retry_at: number }>(
      `SELECT index_retry_count, index_next_retry_at FROM resources WHERE id = 'res_retry_text'`)!;
    const now = Date.now();
    expect(retry.index_retry_count).toBe(100);
    expect(retry.index_next_retry_at).toBeGreaterThan(now);
    expect(retry.index_next_retry_at).toBeLessThanOrEqual(now + 3_601_000);

    states().markPending(db, 'res_retry_text');
    const reset = db.get<{ index_retry_count: number; index_next_retry_at: number }>(
      `SELECT index_retry_count, index_next_retry_at FROM resources WHERE id = 'res_retry_text'`)!;
    expect([reset.index_retry_count, reset.index_next_retry_at]).toEqual([0, 0]);
    expect(states().getPendingResources(db, 10, 3)).toContain('res_retry_text');
  });

  it('mm_claim_skips_resources_already_indexing', () => {
    db.run(`INSERT INTO resources
      (id, hash, type, storage_mode, data, index_state, mm_index_state,
       mm_index_retry_count, mm_index_next_retry_at, created_at, updated_at)
      VALUES
      ('res_mm_free', 'hash_mm_free', 'image', 'inline', '', 'disabled', 'pending', 0, 0, 0, 10),
      ('res_mm_busy', 'hash_mm_busy', 'image', 'inline', '', 'disabled', 'indexing', 0, 0, 0, 20)`);

    expect(states().claimMmIndexingResources(db, ['res_mm_free', 'res_mm_busy'], 3))
      .toEqual(['res_mm_free']);
    expect(db.pluck<string>("SELECT mm_index_state FROM resources WHERE id = 'res_mm_free'"))
      .toBe('indexing');
  });
});
