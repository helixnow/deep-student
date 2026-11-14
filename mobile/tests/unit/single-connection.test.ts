/**
 * V06-06：opfs-sahpool 上同一文件的两条连接互不可见（EXCLUSIVE + WAL 各自缓存），后关闭的一方会覆盖
 * 另一方的写入。移动端存储因此对每个库文件只保留一条连接：
 * - `openFile` 指向已注册库的文件时复用注册句柄的连接；
 * - 同一文件已由 `openFile` 打开且未关闭时，再次 `openFile` 以 `BUSY` 拒绝。
 */
import { describe, expect, it } from 'vitest';
import { StorageError } from '../../../host/platform/storage/errors.ts';
import { MobileStorageService } from '../../../host/platform/storage-mobile/service.ts';
import { errorShape, nodeRuntime, nodeSqlite, thrown } from './support/sqlite-node.ts';

async function migratedStorage(runtime = undefined as ReturnType<typeof nodeRuntime> | undefined) {
  const rt = runtime ?? nodeRuntime(await nodeSqlite());
  const storage = new MobileStorageService({ runtime: rt, baseDir: '/data' });
  await storage.migrations.runAll();
  return { runtime: rt, storage };
}

const COUNT = 'SELECT COUNT(*) FROM w31_writes';

describe('one connection per database file', () => {
  it('openFile on a registered database shares its connection: interleaved writes are all kept', async () => {
    const { runtime, storage } = await migratedStorage();
    const live = storage.database('llm_usage');
    live.exec('CREATE TABLE w31_writes (id INTEGER PRIMARY KEY, source TEXT NOT NULL)');
    const opens = runtime.opened.length;
    const other = storage.openFile(storage.pathOf('llm_usage'), { profile: 'plain', label: 'sync' });
    expect(runtime.opened.length).toBe(opens);

    for (let i = 0; i < 20; i++) {
      live.run('INSERT INTO w31_writes (source) VALUES (?)', ['live']);
      other.run('INSERT INTO w31_writes (source) VALUES (?)', ['file']);
    }
    await Promise.all([
      ...Array.from({ length: 10 }, () => live.write(tx => tx.run("INSERT INTO w31_writes (source) VALUES ('live-write')"))),
      ...Array.from({ length: 10 }, () => other.withTransaction(async tx => { tx.run("INSERT INTO w31_writes (source) VALUES ('file-tx')"); })),
    ]);
    expect(live.pluck(COUNT)).toBe(60);
    expect(other.pluck(COUNT)).toBe(60);

    storage.close(other);
    expect(errorShape(thrown(() => other.pluck(COUNT)))).toMatchObject({ code: 'TX_CLOSED' });
    expect(live.pluck(COUNT)).toBe(60);
    storage.dispose();

    const reopened = await migratedStorage(runtime);
    try {
      expect(reopened.storage.database('llm_usage').all('SELECT source, COUNT(*) AS n FROM w31_writes GROUP BY source ORDER BY source')).toEqual([
        { source: 'file', n: 20 },
        { source: 'file-tx', n: 10 },
        { source: 'live', n: 20 },
        { source: 'live-write', n: 10 },
      ]);
    } finally {
      reopened.storage.dispose();
    }
  }, 60_000);

  it('the shared handle sees the same transaction state and honours maintenance', async () => {
    const { storage } = await migratedStorage();
    try {
      const shared = storage.openFile(storage.pathOf('vfs'));
      const live = storage.database('vfs');
      const tx = await live.begin();
      expect(errorShape(thrown(() => shared.pluck('SELECT 1')))).toMatchObject({ code: 'BUSY', sqliteCode: 'SQLITE_BUSY' });
      await tx.rollback();
      expect(shared.pluck('SELECT 1')).toBe(1);

      const lease = await storage.enterMaintenance(['vfs']);
      expect(errorShape(thrown(() => shared.pluck('SELECT 1')))).toMatchObject({ code: 'MAINTENANCE', database: 'vfs' });
      lease.release();
      expect(shared.pluck('SELECT 1')).toBe(1);
      storage.close(shared);
      expect(storage.database('vfs').pluck('SELECT 1')).toBe(1);
    } finally {
      storage.dispose();
    }
  }, 60_000);

  it('a second openFile of the same file is refused until the first handle is closed', async () => {
    const { storage } = await migratedStorage();
    try {
      const first = storage.openFile('/data/tmp/scratch.db');
      first.exec('CREATE TABLE w31_writes (id INTEGER PRIMARY KEY, source TEXT NOT NULL)');
      for (const path of ['/data/tmp/scratch.db', '/data/tmp/../tmp/scratch.db']) {
        const error = thrown(() => storage.openFile(path));
        expect(error).toBeInstanceOf(StorageError);
        expect(errorShape(error)).toMatchObject({ code: 'BUSY', sqliteCode: 'SQLITE_BUSY', database: path });
      }
      storage.close(first);
      const second = storage.openFile('/data/tmp/scratch.db');
      expect(second.pluck(COUNT)).toBe(0);
      // 句柄对象自身的 close()（不经 storage.close）同样释放该文件。
      (second as unknown as { close(): void }).close();
      expect(storage.openFile('/data/tmp/scratch.db').pluck(COUNT)).toBe(0);
    } finally {
      storage.dispose();
    }
  }, 60_000);
});
