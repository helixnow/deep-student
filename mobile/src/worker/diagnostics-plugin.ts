/**
 * 原型诊断插件（只装在移动端外壳里，不进 profile）：把“前端 invoke → Worker Host → 存储 / WASM”
 * 的端到端路径暴露成 `plugin:host|call` 可调用的远程服务 `mobileDiagnostics`。
 *
 * 读写都经真实插件代码：临时会话由 `dstu.integration` 的 `appCommandState`（含其仓储 SQL）持久化，
 * FSRS 走 W14 第三轮的可移植 WASM 引擎（fetch + MemoryWasi）。
 */
import { definePlugin } from '../../../host/kernel/core.ts';
import type { StorageService } from '../../../host/platform/storage/api.ts';
import { batchArchiveOldMistakes, batchCleanupOrphanedMessages } from '../../../host/platform/storage/batch-operations.ts';
import { MobileStorageService } from '../../../host/platform/storage-mobile/index.ts';
import type { SqliteRuntime } from '../../../host/platform/storage-mobile/index.ts';
import { DEFAULT_PARAMETERS, type FsrsItem } from '../../../host/platform/native/fsrs/api.ts';
import { createWebFsrs } from '../../../host/platform/native/fsrs/web.ts';
import { createWebWasmEngine } from '../../../host/platform/native/wasm/web.ts';
import { MOBILE_CAPABILITIES } from '../capabilities.ts';
import { MOBILE_DIAGNOSTICS_PLUGIN_ID } from '../diagnostics-id.ts';
import type { AppCommandState, StreamContext } from '../../../host/plugins/integration/api.ts';
import type {} from '../../../host/plugins/integration/index.ts';
import type { FilesService } from '../../../host/platform/files/api.ts';
import { runFilesConformance } from '../../../host/platform/files/tests/conformance.ts';

export interface WorkerTimings {
  /** Worker timeOrigin 起到全部 Host 模块求值完成。 */
  readonly modulesEvaluatedMs: number;
  readonly wasmInitMs: number;
  readonly poolInstallMs: number;
}

const CORE_DATABASES = ['vfs', 'llm_usage', 'chat_v2', 'mistakes'] as const;

declare module '@deepseek-ai/cordis' {
  interface Context {
    mobileDiagnostics: MobileDiagnostics;
  }
}

export interface MobileDiagnostics {
  boot(): unknown;
  tempSessionRoundTrip(tempId: string): Promise<unknown>;
  readTempSession(tempId: string): unknown;
  ftsTrigram(title: string, body: string, query: string): Promise<unknown>;
  fsrsEvaluate(items: FsrsItem[]): Promise<unknown>;
  schemaSnapshot(): unknown;
  migrationDigests(): Promise<Record<string, string>>;
  capabilities(): unknown;
  storageBatch(): unknown;
  browserDatabase(): unknown;
  openBrowserDatabase(): unknown;
  filesConformance(): Promise<unknown>;
  filesPlatformRules(): Promise<unknown>;
  ping(message: string): string;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function memory(sqlite: SqliteRuntime) {
  const js = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
  return { wasmHeapBytes: sqlite.sqlite3.wasm.heap8u().byteLength, jsHeapUsed: js?.usedJSHeapSize ?? null, jsHeapTotal: js?.totalJSHeapSize ?? null };
}

function newSession(tempId: string): StreamContext {
  return {
    temp_id: tempId,
    created_at: '2026-11-07T04:00:00.123456789Z',
    question_images: [],
    analysis_images: [],
    user_question: '移动端原型：牛顿第二定律的适用条件？',
    ocr_text: 'F = ma',
    ocr_note: null,
    tags: ['物理'],
    mistake_type: '概念理解',
    chat_category: 'analysis',
    chat_metadata: null,
    chat_history: [],
    initial_doc_attachments: null,
    pinned_images: null,
    exam_sheet: null,
    stream_state: 'in_progress',
    bridge_context: null,
    last_error: null,
  };
}

/** 完整 schema 快照：refinery 历史 + sqlite_master（与桌面 golden 逐项比较）。 */
export function schemaSnapshot(storage: StorageService) {
  const out: Record<string, { history: unknown[]; schema: unknown[] }> = {};
  for (const name of CORE_DATABASES) {
    const db = storage.database(name);
    out[name] = {
      history: db.all('SELECT version, name, CAST(checksum AS TEXT) AS checksum FROM refinery_schema_history ORDER BY version'),
      schema: db.all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"),
    };
  }
  return out;
}

export function createDiagnosticsPlugin(sqlite: SqliteRuntime, timings: WorkerTimings) {
  return definePlugin({
    meta: {
      id: MOBILE_DIAGNOSTICS_PLUGIN_ID,
      lane: 'W14-portable',
      provides: ['mobileDiagnostics'],
      remote: { mobileDiagnostics: ['boot', 'tempSessionRoundTrip', 'readTempSession', 'ftsTrigram', 'fsrsEvaluate', 'schemaSnapshot', 'migrationDigests', 'capabilities', 'storageBatch', 'browserDatabase', 'openBrowserDatabase', 'filesConformance', 'filesPlatformRules', 'ping'] },
      platforms: ['mobile'],
    },
    inject: ['storage', 'appCommandState', 'files'],
    apply(ctx) {
      const storage = ctx.storage;
      const files: FilesService = ctx.files;
      const state: AppCommandState = ctx.appCommandState;
      let fsrs: ReturnType<typeof createWebFsrs> | undefined;
      const appliedAt = performance.now();

      const service: MobileDiagnostics = {
        boot() {
          const pragmas = storage instanceof MobileStorageService
            ? Object.fromEntries(CORE_DATABASES.map(name => [name, (storage as MobileStorageService).database(name).pragmas]))
            : null;
          return {
            timings: { ...timings, diagnosticsAppliedMs: appliedAt },
            sqliteVersion: sqlite.sqlite3.capi.sqlite3_libversion(),
            migration: storage.startupMigrationReport(),
            pragmas,
            locations: storage.locations,
            memory: memory(sqlite),
            nodeGlobals: {
              Buffer: typeof (globalThis as { Buffer?: unknown }).Buffer,
              process: typeof (globalThis as { process?: unknown }).process,
              setImmediate: typeof (globalThis as { setImmediate?: unknown }).setImmediate,
            },
          };
        },

        async tempSessionRoundTrip(tempId) {
          state.withTempSessions(sessions => { sessions.set(tempId, newSession(tempId)); });
          const first = await state.modifyTempSession(tempId, (session) => {
            session.stream_state = 'completed';
            session.tags.push('mobile');
          });
          // 移出内存缓存，迫使下一次 modify 走 getTempSessionRecord（从 mistakes.db 读回）。
          state.withTempSessions(sessions => { sessions.delete(tempId); });
          const second = await state.modifyTempSession(tempId, (session) => {
            session.last_error = 'reloaded-from-db';
          });
          const row = storage.database('mistakes').get(
            'SELECT temp_id, stream_state, created_at, last_error, length(session_data) AS bytes FROM temp_sessions WHERE temp_id = ?1',
            [tempId],
          );
          return {
            first: { stream_state: first.stream_state, tags: first.tags },
            second: { stream_state: second.stream_state, tags: second.tags, last_error: second.last_error, user_question: second.user_question },
            row,
          };
        },

        readTempSession(tempId) {
          return storage.database('mistakes').get(
            'SELECT temp_id, stream_state, last_error, length(session_data) AS bytes FROM temp_sessions WHERE temp_id = ?1',
            [tempId],
          ) ?? null;
        },

        async ftsTrigram(title, body, query) {
          const vfs = storage.database('vfs');
          const tx = await vfs.begin();
          try {
            const rowid = 9_000_001;
            tx.run('INSERT INTO notes_fts(rowid, title, body) VALUES (?1, ?2, ?3)', [rowid, title, body]);
            const hits = tx.all<{ rowid: number }>('SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?1 ORDER BY bm25(notes_fts)', [query]);
            const tokenizer = tx.pluck<string>("SELECT sql FROM sqlite_master WHERE name = 'notes_fts'");
            let busyWhileOpen: string | null = null;
            try {
              vfs.get('SELECT 1');
            } catch (error) {
              busyWhileOpen = (error as { code?: string }).code ?? String(error);
            }
            return { hits: hits.map(hit => hit.rowid), inserted: rowid, tokenizer, busyWhileOpen };
          } finally {
            await tx.rollback();
          }
        },

        async fsrsEvaluate(items) {
          fsrs ??= createWebFsrs(createWebWasmEngine());
          const started = performance.now();
          const evaluation = await fsrs.evaluate(DEFAULT_PARAMETERS, items);
          return { evaluation, ms: performance.now() - started, nextStates: fsrs.nextStates(DEFAULT_PARAMETERS, null, 0.9, 0) };
        },

        schemaSnapshot() {
          return schemaSnapshot(storage);
        },

        /** 打包进 Worker 的迁移 SQL 的 UTF-8 字节摘要（与桌面磁盘文件的 SHA-256 比较）。 */
        async migrationDigests() {
          const out: Record<string, string> = {};
          for (const [database, files] of Object.entries(sqlite.migrations)) {
            for (const [file, sql] of Object.entries(files)) out[`${database}/${file}`] = await sha256Hex(sql);
          }
          return out;
        },

        capabilities() {
          return MOBILE_CAPABILITIES;
        },

        /**
         * 两个批处理（与桌面 batch-operations 测试同一组数据）在临时库上执行：表结构取自真实迁移出的 mistakes.db，
         * 用户的错题与消息不参与（批处理作用于整张表，在真实库上会归档用户的旧错题、删掉孤儿消息）。
         */
        storageBatch() {
          const tables = storage.database('mistakes').all<{ sql: string }>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name IN ('mistakes', 'chat_messages') ORDER BY name DESC",
          );
          const file = `${storage.pathOf('mistakes')}.storage-batch`;
          if (sqlite.exists(file)) sqlite.unlink(file);
          const db = storage.openFile(file, { label: 'storage-batch' });
          const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();
          const insert = (id: string, createdAt: string, status: string) => db.run(
            `INSERT INTO mistakes
               (id, created_at, question_images, analysis_images, user_question, ocr_text,
                tags, mistake_type, status, chat_category, updated_at, last_accessed_at)
             VALUES (?1, ?2, '[]', '[]', ?1, '', '[]', 'analysis', ?3, 'analysis', ?2, '1970-01-01T00:00:00Z')`,
            [id, createdAt, status],
          );
          const ids = ['batch-old-active', 'batch-old-archived', 'batch-new-active'];
          try {
            for (const { sql } of tables) db.exec(sql);
            insert(ids[0]!, daysAgo(100), 'completed');
            insert(ids[1]!, daysAgo(100), 'archived');
            insert(ids[2]!, daysAgo(10), 'completed');
            db.exec('PRAGMA foreign_keys = OFF');
            db.run("INSERT INTO chat_messages (mistake_id, role, content, timestamp) VALUES ('batch-old-active', 'user', 'kept', '2026-01-01T00:00:00+00:00')");
            db.run("INSERT INTO chat_messages (mistake_id, role, content, timestamp) VALUES ('batch-gone', 'user', 'orphan', '2026-01-01T00:00:00+00:00')");
            db.exec('PRAGMA foreign_keys = ON');
            const archived = batchArchiveOldMistakes(db, 30);
            const statuses = db.all<{ id: string; status: string }>(`SELECT id, status FROM mistakes WHERE id IN (?1, ?2, ?3) ORDER BY id`, ids);
            const removed = batchCleanupOrphanedMessages(db);
            const messages = db.all<{ mistake_id: string }>("SELECT mistake_id FROM chat_messages WHERE mistake_id LIKE 'batch-%' ORDER BY mistake_id");
            return { archived, statuses, removed, messages };
          } finally {
            storage.close(db);
            sqlite.unlink(file);
          }
        },

        /** 移动端不支持的能力：错误的结构化字段（Worker 内）。前端看到的形态由 e2e 经 invoke 另行断言。 */
        browserDatabase() {
          try {
            storage.database('browser');
            return { opened: true };
          } catch (error) {
            const e = error as { name?: string; code?: string; capability?: string; platform?: string; message?: string };
            return { name: e.name, code: e.code, capability: e.capability, platform: e.platform, message: e.message };
          }
        },

        /** 不捕获：错误经 Host 命令边界到达前端 invoke 的 reject。 */
        openBrowserDatabase() {
          storage.database('browser');
          return null;
        },

        /** `ctx.files` 一致性用例（与桌面实现、内存 OPFS 同一套）在真实 OPFS 上运行；跑完删除工作目录。 */
        async filesConformance() {
          const base = `${ctx.app.dataDir}/tmp/files-conformance-${Date.now()}`;
          await files.mkdir(base);
          try {
            return { roots: files.roots, flavor: files.flavor, results: await runFilesConformance(files, base) };
          } finally {
            await files.rm(base, { recursive: true, force: true });
          }
        },

        /** 平台差异在真实引擎上的表现：显式 UnsupportedOnPlatform，SQLite pool 目录不可达。 */
        async filesPlatformRules() {
          const describe = (error: unknown) => {
            const e = error as { name?: string; kind?: string; message?: string };
            return { name: e.name, kind: e.kind, message: e.message };
          };
          const dir = `${ctx.app.dataDir}/tmp/rules-${Date.now()}`;
          await files.writeText(`${dir}/a/x.txt`, 'x', { createParents: true });
          const out: Record<string, unknown> = {};
          try {
            files.grant('/picked/file.zip');
            out.grant = 'granted';
          } catch (error) {
            out.grant = describe(error);
          }
          out.directoryRename = await files.rename(`${dir}/a`, `${dir}/b`).then(() => 'renamed', describe);
          out.afterDirectoryRename = await files.readText(`${dir}/a/x.txt`).catch(describe);
          await files.writeText(`${dir}/old.txt`, 'old');
          await files.writeAtomic(`${dir}/old.txt`, 'new');
          out.atomic = await files.readText(`${dir}/old.txt`);
          out.atomicEntries = (await files.readDir(dir)).map(entry => entry.name);
          const writer = (await files.openWrite(`${dir}/locked.txt`)).getWriter();
          out.secondWriter = await files.writeText(`${dir}/locked.txt`, 'two').then(() => 'written', (error: unknown) => ({ ...describe(error), osCode: (error as { osCode?: string }).osCode }));
          await writer.close();
          const held = await files.openFile(`${dir}/held.bin`, { mode: 'create' });
          await held.write(new TextEncoder().encode('held'), 0);
          out.heldWriter = await files.writeText(`${dir}/held.bin`, 'two').then(() => 'written', (error: unknown) => ({ ...describe(error), osCode: (error as { osCode?: string }).osCode }));
          const reader = await files.openFile(`${dir}/held.bin`);
          await held.write(new TextEncoder().encode('!'), 4);
          out.heldReads = [await files.readText(`${dir}/held.bin`), new TextDecoder().decode(await reader.read(0, 10)), new TextDecoder().decode(await held.read(1, 10))];
          await reader.close();
          await held.close();
          out.afterHeldClose = await files.writeText(`${dir}/held.bin`, 'free').then(() => files.readText(`${dir}/held.bin`), describe);
          out.poolDirectory = await files.readDir('/.deep-student').then(() => 'listed', describe);
          out.directoryStat = await files.stat(dir);
          await files.rm(dir, { recursive: true });
          return out;
        },

        ping(message) {
          ctx.backendEvents.emit('mobile://pong', { message, at: Date.now() });
          return `pong:${message}`;
        },
      };
      ctx.provide('mobileDiagnostics', service);
    },
  });
}
