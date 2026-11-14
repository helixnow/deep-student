import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import plugin from '../index.ts';
import indexPlugin from '../../vfs-index/index.ts';
import pathsPlugin from '../../../platform/paths/index.ts';
// boundary-allow cross-plugin-impl: real repository owner plugins used by the production service
import notesPlugin from '../../notes/index.ts';
// boundary-allow cross-plugin-impl: real repository owner plugins used by the production service
import reposPlugin from '../../vfs-repos/index.ts';
import type { VfsUnitIndexService } from '../api.ts';

let template: string, root: string, host: TestHost, storage: ReturnType<typeof createStorageService>;
let db: DatabaseHandle, service: VfsUnitIndexService;
beforeAll(async () => {
  template = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-index-schema-'));
  const source = createStorageService({ baseDir: template, dataLocalDir: template });
  try { const result = await source.migrations.runAll(); expect(result.success, result.error ?? '').toBe(true); }
  finally { source.dispose(); }
}, 120_000);
afterAll(() => fs.rmSync(template, { recursive: true, force: true }));
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-index-'));
  fs.cpSync(template, root, { recursive: true });
  storage = createStorageService({ baseDir: root, dataLocalDir: root });
  host = await createTestHost({ plugins: [pathsPlugin, notesPlugin, reposPlugin, indexPlugin, plugin], provide: { storage }, app: { dataDir: root } });
  db = storage.database('vfs'); service = host.ctx.vfs.unitIndex;
  db.run(`INSERT INTO resources(id, hash, type, storage_mode, data, index_state, mm_index_state, created_at, updated_at)
    VALUES ('res_unit', 'hash_unit', 'note', 'inline', 'content', 'indexed', 'indexed', 0, 0)`);
  db.run(`INSERT INTO vfs_index_units(id, resource_id, unit_index, text_content, text_required, mm_required,
    image_blob_hash, text_state, mm_state, created_at, updated_at)
    VALUES ('unit_test', 'res_unit', 0, 'text', 1, 1, 'blob1', 'indexed', 'indexed', 0, 0)`);
}, 60_000);
afterEach(async () => { vi.restoreAllMocks(); await host?.dispose(); storage?.dispose(); fs.rmSync(root, { recursive: true, force: true }); });
const states = () => {
  const unit = db.get<{ text_state: string; mm_state: string }>('SELECT text_state, mm_state FROM vfs_index_units WHERE id = ?', ['unit_test'])!;
  const resource = db.get<{ index_state: string; mm_index_state: string }>('SELECT index_state, mm_index_state FROM resources WHERE id = ?', ['res_unit'])!;
  return [unit.text_state, unit.mm_state, resource.index_state, resource.mm_index_state];
};
it('sync_resource_units_uses_single_pool_connection', () => {
  // F3 has one shared SQLite connection; observing real borrowing catches nested acquisitions.
  const borrow = vi.spyOn(host.ctx.vfsDatabase, 'getConn');
  const units = service.syncResourceUnits({ resourceId: 'res_unit', resourceType: 'note', data: 'updated note content' });
  expect(borrow).toHaveBeenCalledTimes(1);
  expect(units).toHaveLength(1);
  expect(units[0]!.textContent).toBe('updated note content');
  expect(db.pluck('SELECT index_state FROM resources WHERE id = ?', ['res_unit'])).toBe('pending');
});
it('reset_unit_index_text_mode_updates_unit_and_resource_atomically', () => {
  service.resetUnitIndex('unit_test', 'text');
  expect(states()).toEqual(['pending', 'indexed', 'pending', 'indexed']);
});
it('reset_unit_index_mm_mode_updates_unit_and_resource_atomically', () => {
  service.resetUnitIndex('unit_test', 'mm');
  expect(states()).toEqual(['indexed', 'pending', 'indexed', 'pending']);
});
it('reset_unit_index_both_mode_updates_all_four_states', () => {
  service.resetUnitIndex('unit_test', 'both');
  expect(states()).toEqual(['pending', 'pending', 'pending', 'pending']);
});
it('reset_unit_index_unknown_mode_writes_nothing', () => {
  expect(() => service.resetUnitIndex('unit_test', 'bogus')).toThrow("unsupported index reset mode 'bogus'");
  expect(states()).toEqual(['indexed', 'indexed', 'indexed', 'indexed']);
});
it('rolls unit changes back when the resource scheduling update fails', () => {
  db.exec("CREATE TRIGGER fail_schedule BEFORE UPDATE OF index_state ON resources BEGIN SELECT RAISE(ABORT, 'schedule rejected'); END");
  expect(() => service.resetUnitIndex('unit_test', 'both')).toThrow('schedule rejected');
  expect(states()).toEqual(['indexed', 'indexed', 'indexed', 'indexed']);
});
it('full cleanup removes SQLite units before calling both Lance modalities without resetting resource state', async () => {
  const calls: string[] = [];
  // This is the unpublished native/Lance boundary, not the service under test.
  const result = await service.deleteResourceIndexFull('res_unit', { async deleteByResource(modality, id) {
    expect(id).toBe('res_unit');
    expect(db.pluck('SELECT COUNT(*) FROM vfs_index_units')).toBe(0);
    calls.push(modality); return 0;
  } });
  expect(result).toEqual({ resourceId: 'res_unit', deletedUnitCount: 1, lanceRowIds: [] });
  expect(calls).toEqual(['text', 'multimodal']);
  expect(db.pluck('SELECT index_state FROM resources WHERE id = ?', ['res_unit'])).toBe('indexed');
});
