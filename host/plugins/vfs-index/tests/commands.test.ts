import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService } from '../../../platform/storage/service.ts';
import { testFiles } from './support/files.ts';
import { createSettingsService } from '../../../platform/settings/index.ts';
import type { LanceConnection, LanceEngineService, LanceSearchRequest, LanceTable, LanceTableSchema } from '../api.ts';
import plugin from '../index.ts';

class FakeChatTable implements LanceTable {
  readonly deletes: string[] = [];
  readonly optimizations: Array<{ action: string; options?: unknown }> = [];

  async countRows(): Promise<number> { return 0; }
  async schema(): Promise<LanceTableSchema> { return { fields: [{ name: 'message_id' }] }; }
  async addColumns(): Promise<void> {}
  async createIndex(): Promise<void> {}
  async add(): Promise<void> {}
  async vectorSearch(_request: LanceSearchRequest): Promise<never[]> { return []; }
  async ftsSearch(_request: LanceSearchRequest): Promise<never[]> { return []; }

  async delete(filter: string): Promise<void> {
    this.deletes.push(filter);
  }

  async optimize(action: 'compact' | 'prune' | 'index' | 'all', options?: unknown): Promise<void> {
    this.optimizations.push({ action, options });
  }
}

class FakeChatConnection implements LanceConnection {
  readonly tables = new Map<string, FakeChatTable>();

  async tableNames(): Promise<string[]> { return [...this.tables.keys()]; }
  async openTable(name: string): Promise<LanceTable | null> { return this.tables.get(name) ?? null; }
  async createTable(): Promise<LanceTable> { throw new Error('not used'); }
  async dropTable(name: string): Promise<void> { this.tables.delete(name); }
  hasTableDirectory(name: string): boolean { return this.tables.has(name); }
}

class FakeEngine implements LanceEngineService {
  readonly connection = new FakeChatConnection();
  readonly paths: string[] = [];
  constructor() {
    this.connection.tables.set('chat_embeddings_v2_d4', new FakeChatTable());
  }
  async connect(path: string): Promise<LanceConnection> {
    this.paths.push(path);
    return this.connection;
  }
}

type TestStorage = ReturnType<typeof createStorageService>;

const storageDirs: string[] = [];
const storages: TestStorage[] = [];
let templateDir: string;

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-commands-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('migration failed');
  storage.dispose();
}, 180_000);

function migratedStorage(): TestStorage {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-commands-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  storageDirs.push(base);
  storages.push(storage);
  return storage;
}

afterEach(() => {
  while (storages.length > 0) storages.pop()!.dispose();
  while (storageDirs.length > 0) fs.rmSync(storageDirs.pop()!, { recursive: true, force: true });
});

const tableOf = (engine: FakeEngine): FakeChatTable =>
  engine.connection.tables.get('chat_embeddings_v2_d4')!;

function settingsFor(storage: TestStorage) {
  return createSettingsService({ db: () => storage.database('mistakes'),
    secureStore: () => null, secrets: { isSensitiveKey: () => false } });
}

describe('Rust commands.rs:2012 clear_message_embeddings', () => {
  it('R12-06 logs successful Lance deletion before the best-effort database marker error', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, vector: engine } });
    try {
      await host.invoke('clear_message_embeddings', { messageIds: ['2', '2', '1'] });
      const logs = host.ctx.logger.buffer.filter((entry) => entry.name === 'vfs-index')
        .map((entry) => ({ level: entry.type, message: entry.args.map(String).join(' ') }));
      const success = logs.findIndex((entry) => entry.level === 'info'
        && entry.message === '[ClearEmbeddings] 已清空 Lance 中 2 条消息的向量');
      const marker = logs.findIndex((entry) => entry.level === 'error'
        && entry.message.includes('无法标记数据库 embedding_retry'));
      expect(success).toBeGreaterThanOrEqual(0);
      expect(marker).toBeGreaterThan(success);
    } finally { await host.dispose(); }
  });

  it('R12-06 logs Lance deletion failure and does not run the later database marker', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    tableOf(engine).delete = async () => { throw new Error('disk full'); };
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, vector: engine } });
    try {
      await expect(host.invoke('clear_message_embeddings', { messageIds: ['7'] })).rejects.toEqual({
        error_type: 'Database', details: null,
        message: '清空向量失败: Database error: 删除聊天向量失败: disk full',
      });
      const logs = host.ctx.logger.buffer.filter((entry) => entry.name === 'vfs-index');
      expect(logs.filter((entry) => entry.type === 'error').map((entry) => entry.args.map(String).join(' ')))
        .toEqual(['[ClearEmbeddings] 清空向量失败: Database error: 删除聊天向量失败: disk full']);
      expect(logs.some((entry) => entry.type === 'info')).toBe(false);
    } finally { await host.dispose(); }
  });
  it('returns early for an empty input list', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, vector: { connect: (path: string) => engine.connect(path) } } });
    try {
      expect(await host.invoke('clear_message_embeddings', { messageIds: [] })).toBeNull();
      expect(engine.paths).toEqual([]);
      expect(tableOf(engine).deletes).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('parses trimmed numeric ids, skips blanks, sorts/dedups and forwards them to Lance', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, vector: { connect: (path: string) => engine.connect(path) } } });
    try {
      expect(await host.invoke('clear_message_embeddings', {
        messageIds: [' 3 ', '2', '', '2', '+1'],
      })).toBeNull();
      expect(tableOf(engine).deletes).toEqual(["message_id IN ('1','2','3')"]);
      expect(engine.paths[0]!.endsWith(path.join('lance', 'kb'))).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  it('keeps i64 ids beyond Number.MAX_SAFE_INTEGER exact when forwarding to Lance', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, vector: { connect: (path: string) => engine.connect(path) } } });
    try {
      expect(await host.invoke('clear_message_embeddings', {
        messageIds: [' 9223372036854775807 ', '-9223372036854775808', '9223372036854775807'],
      })).toBeNull();
      expect(tableOf(engine).deletes).toEqual([
        "message_id IN ('-9223372036854775808','9223372036854775807')",
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('reports Lance deletion failures as `清空向量失败: …`', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    const table = tableOf(engine);
    table.delete = async () => { throw new Error('disk full'); };
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, vector: { connect: (path: string) => engine.connect(path) } } });
    try {
      const error = await host.invoke('clear_message_embeddings', { messageIds: ['7'] })
        .catch((reason: unknown) => reason);
      expect(error).toEqual({
        error_type: 'Database',
        message: '清空向量失败: Database error: 删除聊天向量失败: disk full',
        details: null,
      });
    } finally {
      await host.dispose();
    }
  });

  it('preserves the Rust missing-column failure for non-numeric stable tokens', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, vector: { connect: (path: string) => engine.connect(path) } } });
    try {
      const error = await host.invoke('clear_message_embeddings', { messageIds: ['stable-token'] })
        .catch((reason: unknown) => reason);
      expect(error).toMatchObject({ error_type: 'Database' });
      expect((error as { message: string }).message).toContain('persistent_stable_id');
      expect(tableOf(engine).deletes).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  it('still succeeds when the Lance engine is unavailable (Rust only logs the DB marker failure)', async () => {
    const storage = migratedStorage();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage } });
    try {
      expect(await host.invoke('clear_message_embeddings', { messageIds: ['9'] })).toBeNull();
      const errors = host.ctx.logger.buffer.filter(
        (message) => message.name === 'vfs-index' && message.type === 'error',
      );
      expect(errors).toHaveLength(1);
      expect(errors[0]!.args.map(String).join(' ')).toContain('无法标记数据库 embedding_retry');
    } finally {
      await host.dispose();
    }
  });
});

describe('Rust commands.rs:6898 optimize_lance_database', () => {
  it('preserves the skipped optimization response and ignores both optional arguments', async () => {
    const storage = migratedStorage();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage } });
    try {
      const expected = { success: true, optimized_tables: 0, duration_ms: 0, message: 'Lance 优化已跳过' };
      expect(await host.invoke('optimize_lance_database')).toEqual(expected);
      expect(await host.invoke('optimize_lance_database', { parallelism: 8, force: true })).toEqual(expected);
      expect(await host.invoke('optimize_lance_database', { parallelism: 0, force: false })).toEqual(expected);
      expect(host.events).toEqual([]);
    } finally {
      await host.dispose();
    }
  });
});

describe('Rust commands.rs:2088 optimize_chat_embeddings_table', () => {
  it('R12-03 settings read failures use Rust defaults while timestamp write failure only warns', async () => {
    const storage = migratedStorage();
    const settings = settingsFor(storage);
    const engine = new FakeEngine();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, settings, vector: engine } });
    const logs: Array<{ type: string; args: unknown[] }> = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export: entry => { logs.push(entry); } });
    try {
      storage.database('mistakes').exec('DROP TABLE settings');
      expect(await host.invoke('optimize_chat_embeddings_table', { force: false })).toBeNull();
      expect(tableOf(engine).optimizations).toEqual([{ action: 'all', options: undefined }]);
      expect(engine.paths).toContain(path.join(path.dirname(storage.database('mistakes').path), 'lance', 'kb'));
      expect(logs.some(entry => entry.type === 'warn'
        && entry.args.map(String).join(' ').includes('[Lance优化] 记录 chat 上次优化时间失败:'))).toBe(true);
    } finally { await host.dispose(); }
  });
  it('R12-03 uses the real F4 settings owner after optimizing an empty scope', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    engine.connection.tables.clear();
    const settings = settingsFor(storage);
    const save = vi.spyOn(settings, 'saveWithConn');
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, settings, vector: engine } });
    try {
      expect(await host.invoke('optimize_chat_embeddings_table', { force: true })).toBeNull();
      expect(save).toHaveBeenCalledWith(storage.database('mistakes'), 'lance.optimize.last.chat', expect.any(String));
      expect(settings.get('lance.optimize.last.chat')).toMatch(/\+00:00$/);
    } finally { save.mockRestore(); await host.dispose(); }
  });

  it('R12-03 timestamp owner failure warns after optimization and remains successful', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    const settings = settingsFor(storage);
    const save = vi.spyOn(settings, 'saveWithConn');
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, settings, vector: engine } });
    const logs: Array<{ type: string; args: unknown[] }> = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export: entry => { logs.push(entry); } });
    try {
      storage.database('mistakes').exec(`CREATE TRIGGER reject_optimize_timestamp BEFORE INSERT ON settings
        WHEN NEW.key = 'lance.optimize.last.chat' BEGIN SELECT RAISE(ABORT, 'timestamp rejected'); END`);
      expect(await host.invoke('optimize_chat_embeddings_table', { force: true })).toBeNull();
      expect(tableOf(engine).optimizations).toEqual([{ action: 'all', options: undefined }]);
      expect(save).toHaveBeenCalledTimes(1);
      expect(settings.get('lance.optimize.last.chat')).toBeNull();
      expect(logs.some(entry => entry.type === 'warn'
        && entry.args.map(String).join(' ').includes('[Lance优化] 记录 chat 上次优化时间失败:')
        && entry.args.map(String).join(' ').includes('timestamp rejected'))).toBe(true);
      expect(logs.filter(entry => entry.type === 'warn').map(entry => entry.args.map(String).join(' ')))
        .toContain('[Lance优化] 记录 chat 上次优化时间失败: timestamp rejected');
    } finally { save.mockRestore(); await host.dispose(); }
  });

  it('R12-03 both legacy KB and chat path fallback write through the same F4 connection', async () => {
    const storage = migratedStorage();
    const settings = settingsFor(storage);
    settings.save('rag.lance.path', 'relative-kb-root');
    const save = vi.spyOn(settings, 'saveWithConn');
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, settings, vector: new FakeEngine() } });
    try {
      const db = storage.database('mistakes');
      const root = path.join(path.dirname(db.path), 'lance');
      expect(host.ctx.vfsIndex.legacyKb!.getLancePath()).toBe(path.join(root, 'kb'));
      expect(save).toHaveBeenCalledWith(db, 'rag.lance.path', root);
      save.mockClear();
      settings.save('rag.lance.path', 'relative-chat-root');
      expect(await host.invoke('optimize_chat_embeddings_table', { force: true })).toBeNull();
      expect(save.mock.calls.map(([, key]) => key)).toEqual(['rag.lance.path', 'lance.optimize.last.chat']);
      expect(settings.get('rag.lance.path')).toBe(root);
    } finally { save.mockRestore(); await host.dispose(); }
  });

  it('R12-03 path owner failure propagates before any table optimization', async () => {
    const storage = migratedStorage();
    const settings = settingsFor(storage);
    const engine = new FakeEngine();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, settings, vector: engine } });
    try {
      settings.save('rag.lance.path', 'invalid-relative-root');
      storage.database('mistakes').exec(`CREATE TRIGGER reject_lance_path BEFORE INSERT ON settings
        WHEN NEW.key = 'rag.lance.path' BEGIN SELECT RAISE(ABORT, 'path rejected'); END`);
      await expect(host.invoke('optimize_chat_embeddings_table', { force: true })).rejects.toMatchObject({
        error_type: 'Database', message: expect.stringContaining('path rejected'), details: null,
      });
      expect(tableOf(engine).optimizations).toEqual([]);
      expect(settings.get('rag.lance.path')).toBe('invalid-relative-root');
    } finally { await host.dispose(); }
  });
  it('R12-06 emits the Rust zero-optimized debug diagnostic', async () => {
    const storage = migratedStorage();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage } });
    const logs: Array<{ name: string; type: string; args: unknown[] }> = [];
    host.ctx.logger.exporter({ levels: { default: 4 }, export: (entry) => { logs.push(entry); } });
    try {
      expect(await host.invoke('optimize_chat_embeddings_table')).toBeNull();
      expect(logs.some((entry) => entry.name === 'vfs-index' && entry.type === 'debug'
        && entry.args.map(String).join(' ') === '[Lance优化] 聊天向量表在节流窗口内，未执行优化。')).toBe(true);
    } finally { await host.dispose(); }
  });
  it('defaults force to true and uses OptimizeAction::All when no prune flags are set', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, vector: { connect: (path: string) => engine.connect(path) } } });
    try {
      expect(await host.invoke('optimize_chat_embeddings_table', {})).toBeNull();
      expect(tableOf(engine).optimizations).toEqual([{ action: 'all', options: undefined }]);
    } finally {
      await host.dispose();
    }
  });

  it('compacts, prunes with the requested flags and merges indexes', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, vector: { connect: (path: string) => engine.connect(path) } } });
    try {
      expect(await host.invoke('optimize_chat_embeddings_table', {
        olderThanDays: 7,
        deleteUnverified: true,
        force: true,
      })).toBeNull();
      expect(tableOf(engine).optimizations).toEqual([
        { action: 'compact', options: undefined },
        { action: 'prune', options: { olderThanDays: 7, deleteUnverified: true } },
        { action: 'index', options: undefined },
      ]);
    } finally {
      await host.dispose();
    }
  });

  it('throttles non-forced calls through the persisted chat scope timestamp', async () => {
    const storage = migratedStorage();
    const engine = new FakeEngine();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage, settings: settingsFor(storage), vector: { connect: (path: string) => engine.connect(path) } } });
    try {
      await host.invoke('optimize_chat_embeddings_table', { force: true });
      const calls = tableOf(engine).optimizations.length;
      await host.invoke('optimize_chat_embeddings_table', { force: false });
      expect(tableOf(engine).optimizations).toHaveLength(calls);
      expect(storage.database('mistakes').pluck(
        "SELECT value FROM settings WHERE key = 'lance.optimize.last.chat'",
      )).toBeTruthy();
    } finally {
      await host.dispose();
    }
  });

  it('is a no-op success when the Lance feature is unavailable (lance_vector_store.rs:3044)', async () => {
    const storage = migratedStorage();
    const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage),  storage } });
    try {
      expect(await host.invoke('optimize_chat_embeddings_table', { force: true })).toBeNull();
      expect(storage.database('mistakes').pluck(
        "SELECT value FROM settings WHERE key = 'lance.optimize.last.chat'",
      )).toBeUndefined();
    } finally {
      await host.dispose();
    }
  });
});
