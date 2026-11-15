import { expect, it } from 'vitest';
import { MobileStorageService } from '../../../host/platform/storage-mobile/service.ts';
import { createMobileVector } from '../../../host/platform/vector/mobile.ts';
import type { VectorColumn } from '../../../host/platform/vector/api.ts';
import { nodeRuntime, nodeSqlite, openRaw, uniqueFile } from './support/sqlite-node.ts';

it('persists grouped mobile embeddings in SQLite WASM and keeps vector, text and delete results consistent', async () => {
  const sqlite = await nodeSqlite();
  const runtime = nodeRuntime(sqlite);
  const storage = new MobileStorageService({ runtime, baseDir: '/app' });
  const mobile = createMobileVector(storage);
  const path = '/app/slots/slotA/lance/vfs';
  const schema: VectorColumn[] = [
    { name: 'id', type: 'utf8', nullable: false },
    { name: 'group_id', type: 'utf8', nullable: false },
    { name: 'text', type: 'utf8', nullable: false },
    { name: 'embedding', type: 'vector', nullable: false, dimension: 3 },
  ];
  try {
    const connection = await mobile.connect(path, 'vfs');
    const table = await connection.createTableWithSchema!('profile_text', schema);
    const generation = 9007199254740997n;
    await table.addColumns!([['generation', 'CAST(0 AS BIGINT)']]);
    await table.add([
      { id: 'nearest', group_id: 'a', text: '检索中文资料', embedding: [1, 0, 0], generation },
      { id: 'further', group_id: 'a', text: '中文释义', embedding: [0.4, 1, 0], generation: 1 },
      { id: 'excluded', group_id: 'b', text: '检索中文资料', embedding: [1, 0, 0], generation: 2 },
    ]);
    await table.createIndex!(['group_id'], 'btree');
    await table.createIndex!(['text'], 'fts-ngram');
    await table.add([{ id: 'inserted-later', group_id: 'a', text: '备份中文资料', embedding: [0, 1, 0], generation: 2 }]);
    await expect(table.add([
      { id: 'rolled-back', group_id: 'a', text: '不应出现', embedding: [0, 1, 0], generation: 2 },
      { id: 'invalid-vector', group_id: 'a', text: '错误维度', embedding: [0], generation: 2 },
    ])).rejects.toThrow('Invalid vector value');
    // The published owner is what backup snapshots; restore the database into a second data root.
    // Node WASM VACUUM writes to a flat VFS file; the Android runtime reads its OPFS pool path directly.
    const snapshot = uniqueFile('vector-snapshot');
    await storage.database('vfs').backupTo(snapshot);
    const copy = new MobileStorageService({ runtime, baseDir: '/restored' });
    expect(runtime.opened).toContain(storage.pathOf('vfs'));
    expect(runtime.opened).not.toContain(`${path}/vectors.sqlite`);
    const backup = openRaw(sqlite, snapshot);
    try {
      const pointer = backup.pointer as Parameters<typeof sqlite.capi.sqlite3_js_db_export>[0];
      runtime.put(copy.pathOf('vfs'), sqlite.capi.sqlite3_js_db_export(pointer));
    }
    finally { backup.close(); }
    const restored = createMobileVector(copy);
    try {
      const reopened = await restored.connect(path, 'vfs');
      expect(await reopened.tableNames()).toEqual(['profile_text']);
      expect(reopened.supportsApproximateSearch).toBe(false);
      const saved = await reopened.openTable('profile_text');
      const options = { column: 'embedding', metric: 'cosine' as const, filter: "group_id = 'a'", limit: 2, columns: ['id', 'generation'] };
      expect(await saved.search([1, 0, 0], options)).toEqual([
        { id: 'nearest', generation, _distance: 0 },
        { id: 'further', generation: 1n, _distance: expect.any(Number) },
      ]);
      expect((await saved.fullTextSearch!('中文资料', { ...options, columns: ['id'] })).map(row => row.id)).toEqual(['nearest', 'inserted-later']);
      expect((await saved.fullTextSearch!('中文', { ...options, columns: ['id'] })).map(row => row.id)).toEqual(['nearest', 'further']);
      expect(await saved.countRows()).toBe(4);
      await saved.delete("id = 'nearest'");
      expect((await saved.fullTextSearch!('检索中文', { ...options, columns: ['id'] }))).toEqual([]);
      expect((await saved.search([1, 0, 0], options)).map(row => row.id)).toEqual(['further', 'inserted-later']);
      await reopened.dropTable('profile_text');
      expect(await reopened.tableNames()).toEqual([]);
      expect(reopened.hasTableDirectory!('profile_text')).toBe(false);
    } finally { restored.dispose(); copy.dispose(); }
  } finally {
    mobile.dispose();
    storage.dispose();
  }
});
