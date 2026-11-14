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
import type { VfsCreateTranslationParams } from '../api.ts';
import plugin from '../index.ts';
import { newFolder, newFolderItem } from '../repository/folders.ts';

/** 与生产一致：插件启动时从 F4 `paths.dataSpaceDeviceId()` 解析一次并注入仓储。 */
const TEST_DEVICE_ID = 'device-l11-translation';

let root: string;
let storage: ReturnType<typeof createStorageService>;
let host: Awaited<ReturnType<typeof createTestHost>>;
let db: DatabaseHandle;
beforeEach(async () => {
  ({ root, storage } = await createVfsTestStorage('l11-translation-'));
  host = await createTestHost({ plugins: [plugin], provide: { storage, paths: pathsServiceDouble(TEST_DEVICE_ID), 'notes': notesServiceDouble(() => storage.database('vfs')) } });
  db = storage.database('vfs');
}, 120_000);
afterEach(async () => {
  await host?.dispose();
  storage?.dispose();
  if (root) rmSync(root, { recursive: true, force: true });
}, 120_000);
const translations = () => host.ctx.vfsRepo.translations;

function makeParams(source: string, translated: string): VfsCreateTranslationParams {
  return {
    title: null,
    source,
    translated,
    srcLang: 'en',
    tgtLang: 'zh',
    engine: null,
    model: null,
  };
}

function resourceRow(resourceId: string): { data: string; hash: string; indexState: string | null } | null {
  const row = db.get<{ data: string; hash: string; index_state: string | null }>(
    'SELECT data, hash, index_state FROM resources WHERE id = ?1', [resourceId]);
  return row === undefined ? null : { data: row.data, hash: row.hash, indexState: row.index_state };
}

describe('translation_repo.rs', { timeout: 120_000 }, () => {
  it('test_translation_id_generation', () => {
    const translation = translations().createTranslation(db, makeParams('hello', '你好'));
    expect(translation.id.startsWith('tr_')).toBe(true);
    expect(translation.id).toHaveLength(13);
  });

  it('sync_column_mutations_use_persisted_device_id', () => {
    const translation = translations().createTranslation(db, makeParams('hello', '你好'));
    const created = db.get<{ device_id: string | null; local_version: number }>(
      'SELECT device_id, COALESCE(local_version, 0) AS local_version FROM translations WHERE id = ?1',
      [translation.id])!;
    expect(created.device_id).toBe(TEST_DEVICE_ID);

    translations().setFavorite(db, translation.id, true);
    const favorited = db.get<{ device_id: string | null; local_version: number; is_favorite: number }>(
      'SELECT device_id, COALESCE(local_version, 0) AS local_version, is_favorite FROM translations WHERE id = ?1',
      [translation.id])!;
    expect(favorited.device_id).toBe(TEST_DEVICE_ID);
    expect(favorited.local_version).toBe(created.local_version + 1);
    expect(favorited.is_favorite).toBe(1);

    // deleteTranslation also bumps the folder_items sync columns.
    const folders = host.ctx.vfsRepo.folders;
    const folder = newFolder('translations');
    folders.createFolder(db, folder);
    folders.addItemToFolder(db, newFolderItem(folder.id, 'translation', translation.id));
    translations().deleteTranslation(db, translation.id);
    expect(db.pluck<string>('SELECT device_id FROM translations WHERE id = ?1', [translation.id]))
      .toBe(TEST_DEVICE_ID);
    expect(db.pluck<string>(
      `SELECT device_id FROM folder_items WHERE item_type = 'translation' AND item_id = ?1`,
      [translation.id])).toBe(TEST_DEVICE_ID);
    expect(db.pluck<number>(
      `SELECT COALESCE(local_version, 0) FROM folder_items WHERE item_type = 'translation' AND item_id = ?1`,
      [translation.id])).toBe(1);
  });

  it('test_identical_content_translations_get_distinct_resources', () => {
    const first = translations().createTranslation(db, makeParams('hello', '你好'));
    const second = translations().createTranslation(db, makeParams('hello', '你好'));
    expect(second.resourceId).not.toBe(first.resourceId);
  });

  it('test_update_translation_content_in_place_refreshes_hash_and_index_state', () => {
    const translation = translations().createTranslation(db, makeParams('hello', '你好'));
    const resourceId = translation.resourceId;
    db.run("UPDATE resources SET index_state = 'indexed' WHERE id = ?1", [resourceId]);
    const before = resourceRow(resourceId)!;

    translations().updateTranslationContent(db, translation.id, 'hello world', '你好世界');

    const after = resourceRow(resourceId)!;
    expect(after.data).toContain('hello world');
    expect(after.hash).not.toBe(before.hash);
    expect(after.indexState).toBe('pending');
  });

  it('test_update_shared_resource_uses_copy_on_write', () => {
    const first = translations().createTranslation(db, makeParams('shared', '共享'));
    const second = translations().createTranslation(db, makeParams('shared', '共享'));
    const firstResource = first.resourceId;
    const secondResource = second.resourceId;

    // 模拟历史脏数据：两条翻译指向同一资源
    db.run('UPDATE translations SET resource_id = ?1 WHERE id = ?2', [firstResource, second.id]);
    db.run('DELETE FROM resources WHERE id = ?1', [secondResource]);

    translations().updateTranslationContent(db, second.id, 'edited', '已编辑');

    const shared = resourceRow(firstResource)!;
    expect(shared.data).toContain('shared');

    const newResourceId = db.pluck<string>(
      'SELECT resource_id FROM translations WHERE id = ?1', [second.id])!;
    expect(newResourceId).not.toBe(firstResource);
    const detached = resourceRow(newResourceId)!;
    expect(detached.data).toContain('edited');
  });

  it('test_purge_translation_keeps_shared_resource_until_last_reference', () => {
    const first = translations().createTranslation(db, makeParams('a', '甲'));
    const second = translations().createTranslation(db, makeParams('a', '甲'));
    const firstResource = first.resourceId;
    const secondResource = second.resourceId;

    // 模拟历史共享
    db.run('UPDATE translations SET resource_id = ?1 WHERE id = ?2', [firstResource, second.id]);
    db.run('DELETE FROM resources WHERE id = ?1', [secondResource]);

    translations().purgeTranslation(db, first.id);
    expect(resourceRow(firstResource)).not.toBeNull();

    translations().purgeTranslation(db, second.id);
    expect(resourceRow(firstResource)).toBeNull();
  });

  // C1 U2/U4: translation_executor.rs:1293-1311 metadata-only write.
  it('setMetadataJsonOnlyWithConn writes metadata_json only and reports missing rows', () => {
    const translation = translations().createTranslation(db, makeParams('meta', '元'));
    const before = db.get<Record<string, unknown>>('SELECT * FROM translations WHERE id = ?1', [translation.id])!;
    translations().setMetadataJsonOnlyWithConn(db, translation.id, '{"a":1}');
    const after = db.get<Record<string, unknown>>('SELECT * FROM translations WHERE id = ?1', [translation.id])!;
    expect(after.metadata_json).toBe('{"a":1}');
    expect({ ...after, metadata_json: before.metadata_json }).toEqual(before);
    expect(() => translations().setMetadataJsonOnlyWithConn(db, 'tr_missing', '{}'))
      .toThrow('translation row tr_missing not found for metadata update');
  });
});
