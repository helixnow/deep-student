/**
 * Chat embedding Lance maintenance, ported from
 * `crates/dstu-vfs/src/lance_vector_store.rs` (chat slice).
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import * as path from '../../../platform/util/path.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import type { SettingsWithConn } from '../../../platform/settings/api.ts';
import { now, parseRfc3339, toRfc3339 } from '../../../platform/time/index.ts';
import type { LanceConnection, LanceEngineService } from '../api.ts';
import {
  ensureBaseRagSchema,
  getSetting,
  parseBoolFlag,
  saveSetting,
} from '../repository/chat-lance.ts';
import type { LaneLogger } from './logger.ts';
import { KB_MUTATION_LOCK } from './kb-mutation-lock.ts';

const CHAT_V2_TABLE_PREFIX = 'chat_embeddings_v2_d';
const CHAT_LEGACY_TABLE_PREFIX = 'chat_embeddings_d';
const CHAT_LEGACY_FALLBACK_TABLE = 'chat_embeddings';
const KB_V2_TABLE_PREFIX = 'kb_chunks_v2_d';
const OPTIMIZE_MIN_INTERVAL_CHAT_SECS = 1800;
const OPTIMIZE_MIN_INTERVAL_KB_SECS = 1800;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class ChatLanceStore {
  private readonly db: SqlExecutor;
  private readonly engine: LanceEngineService;
  private lancePath: string;
  private readonly logger: LaneLogger | undefined;
  private readonly settings: SettingsWithConn | undefined;
  private readonly prepare: (() => Promise<string>) | undefined;
  private connection: LanceConnection | null = null;

  private constructor(
    db: SqlExecutor,
    engine: LanceEngineService,
    lancePath: string,
    logger?: LaneLogger,
    settings?: SettingsWithConn,
    prepare?: () => Promise<string>,
  ) {
    this.db = db;
    this.engine = engine;
    this.lancePath = lancePath;
    this.logger = logger;
    this.settings = settings;
    this.prepare = prepare;
  }

  /** `LanceVectorStore::new`: base RAG schema + Lance path resolution. */
  static create(
    db: SqlExecutor,
    engine: LanceEngineService,
    files: () => FilesService,
    logger?: LaneLogger,
    settings?: SettingsWithConn,
  ): ChatLanceStore {
    ensureBaseRagSchema(db, logger);
    const desired = resolveLancePath(db, logger, settings);
    return new ChatLanceStore(db, engine, desired, logger, settings,
      () => ensureLanceDir(files(), db, desired, logger, settings));
  }

  private async connect(): Promise<LanceConnection> {
    if (this.connection === null) {
      if (this.prepare !== undefined) this.lancePath = await this.prepare();
      this.connection = await this.engine.connect(this.lancePath);
    }
    return this.connection;
  }

  static parseDimFromTableName(name: string, prefix: string): number | null {
    if (!name.startsWith(prefix)) return null;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) return null;
    const dim = Number(suffix);
    return Number.isSafeInteger(dim) ? dim : null;
  }

  private async existingDimTables(prefix: string): Promise<Array<[number, string]>> {
    const connection = await this.connect();
    const names = await connection.tableNames().catch((error: unknown) => {
      throw new Error(`Database error: 枚举 Lance 表失败: ${messageOf(error)}`);
    });
    return names
      .map((name) => {
        const dim = ChatLanceStore.parseDimFromTableName(name, prefix);
        return dim === null ? null : [dim, name] as [number, string];
      })
      .filter((entry): entry is [number, string] => entry !== null)
      .sort((left, right) => left[0] - right[0]);
  }

  private async openExistingChatTables(): Promise<Array<{ delete(filter: string): Promise<void> }>> {
    const connection = await this.connect();
    const tables: Array<{ delete(filter: string): Promise<void> }> = [];
    for (const [, tableName] of await this.existingDimTables(CHAT_V2_TABLE_PREFIX)) {
      const table = await connection.openTable(tableName);
      if (table !== null) tables.push(table);
    }
    return tables;
  }

  async deleteChatEmbeddingsByIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return;
    await KB_MUTATION_LOCK.read(async () => {
      const tables = await this.openExistingChatTables();
      if (tables.length === 0) return;
      const batches: string[][] = [];
      for (let offset = 0; offset < ids.length; offset += 900) {
        batches.push(ids.slice(offset, offset + 900).map((id) => id.replace(/'/g, "''")));
      }
      for (const table of tables) {
        for (const batch of batches) {
          if (batch.length === 0) continue;
          const expr = `message_id IN (${batch.map((id) => `'${id}'`).join(',')})`;
          await table.delete(expr).catch((error: unknown) => {
            throw new Error(`Database error: 删除聊天向量失败: ${messageOf(error)}`);
          });
        }
      }
    });
  }

  async optimizeChatTables(
    olderThanDays: number | null,
    deleteUnverified: boolean | null,
    force: boolean,
  ): Promise<number> {
    const names: string[] = [];
    for (const [, name] of await this.existingDimTables(CHAT_V2_TABLE_PREFIX)) names.push(name);
    for (const [, name] of await this.existingDimTables(CHAT_LEGACY_TABLE_PREFIX)) names.push(name);
    names.push(CHAT_LEGACY_FALLBACK_TABLE);
    return this.optimizeTableGroup(
      'chat',
      OPTIMIZE_MIN_INTERVAL_CHAT_SECS,
      names,
      olderThanDays,
      deleteUnverified,
      force,
    );
  }

  /** `optimize_kb_tables`: legacy `kb_chunks_v2_d*` only, own `kb` throttle scope. */
  async optimizeKbTables(
    olderThanDays: number | null,
    deleteUnverified: boolean | null,
    force: boolean,
  ): Promise<number> {
    const names = (await this.existingDimTables(KB_V2_TABLE_PREFIX)).map(([, name]) => name);
    return this.optimizeTableGroup(
      'kb',
      OPTIMIZE_MIN_INTERVAL_KB_SECS,
      names,
      olderThanDays,
      deleteUnverified,
      force,
    );
  }

  private shouldSkipOptimization(scope: string, minIntervalSecs: number, force: boolean): boolean {
    if (force) return false;
    const key = `lance.optimize.last.${scope}`;
    const raw = getSetting(this.db, key);
    if (raw === undefined) return false;
    const parsed = parseRfc3339(raw);
    if (parsed === null) return false;
    return now().millis - parsed.millis < Math.max(0, minIntervalSecs) * 1000;
  }

  private recordOptimizationTimestamp(scope: string): void {
    try {
      saveSetting(
        this.db,
        `lance.optimize.last.${scope}`,
        toRfc3339(),
        this.settings,
      );
    } catch (error) {
      // Rust `record_optimization_timestamp` only logs a warning.
      this.logger?.warn(`[Lance优化] 记录 ${scope} 上次优化时间失败: ${messageOf(error)}`);
    }
  }

  private resolveDeleteUnverified(override: boolean | null): boolean {
    if (override !== null) return override;
    const raw = getSetting(this.db, 'lance.optimize.delete_unverified');
    return raw === undefined ? false : parseBoolFlag(raw) ?? false;
  }

  private async optimizeTableInternal(
    table: {
      optimize(
        action: 'compact' | 'prune' | 'index' | 'all',
        options?: { olderThanDays?: number | null; deleteUnverified?: boolean },
      ): Promise<void>;
    },
    olderThanDays: number | null,
    deleteUnverified: boolean,
  ): Promise<void> {
    const pruneDuration = olderThanDays !== null && olderThanDays !== 0 ? olderThanDays : null;
    if (pruneDuration !== null || deleteUnverified) {
      await table.optimize('compact').catch((error: unknown) => {
        throw new Error(`Database error: ${messageOf(error)}`);
      });
      await table.optimize('prune', {
        olderThanDays: pruneDuration,
        deleteUnverified,
      }).catch((error: unknown) => {
        throw new Error(`Database error: ${messageOf(error)}`);
      });
      await table.optimize('index').catch((error: unknown) => {
        throw new Error(`Database error: ${messageOf(error)}`);
      });
    } else {
      await table.optimize('all').catch((error: unknown) => {
        throw new Error(`Database error: ${messageOf(error)}`);
      });
    }
  }

  private async optimizeTableGroup(
    scope: string,
    minIntervalSecs: number,
    tableNames: readonly string[],
    olderThanDays: number | null,
    deleteUnverified: boolean | null,
    force: boolean,
  ): Promise<number> {
    if (this.shouldSkipOptimization(scope, minIntervalSecs, force)) return 0;
    const deleteFlag = this.resolveDeleteUnverified(deleteUnverified);
    const connection = await this.connect();
    let optimized = 0;
    const seen = new Set<string>();
    for (const name of tableNames) {
      if (rustTrim(name) === '' || seen.has(name)) continue;
      seen.add(name);
      // `lance_vector_store.rs`: `open_table` errors skip that table; only an
      // opened table counts as optimizable.
      let table: Awaited<ReturnType<typeof connection.openTable>>;
      try {
        table = await connection.openTable(name);
      } catch {
        continue;
      }
      if (table === null) continue;
      try {
        await this.optimizeTableInternal(table, olderThanDays, deleteFlag);
        optimized += 1;
      } catch (error) {
        // Rust logs and continues with the remaining tables.
        this.logger?.error(`[Lance优化] ${name} 优化失败: ${messageOf(error)}`);
      }
    }
    this.recordOptimizationTimestamp(scope);
    return optimized;
  }
}

/**
 * Rust `std::env::current_dir()` 的兜底：只在数据库没有路径（`:memory:`）时用到。
 * 宿主没有 `process`（移动端 Worker）时退回 `/`，与 `:memory:` 库的 Lance 目录一样只用于测试。
 */
function currentDir(): string {
  return (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '/';
}

function defaultLanceRoot(db: SqlExecutor): string {
  const dbPath = (db as { readonly path?: string }).path;
  return path.join(dbPath === undefined ? currentDir() : path.dirname(dbPath), 'lance');
}

/** Rust `LanceVectorStore::new`: resolves the configured (or default) KB root synchronously. */
function resolveLancePath(db: SqlExecutor, logger?: LaneLogger, settings?: SettingsWithConn): string {
  const defaultRoot = defaultLanceRoot(db);
  const rawSetting = rustTrim(getSetting(db, 'rag.lance.path') ?? '');
  if (rawSetting !== '') {
    if (path.isAbsolute(rawSetting)) {
      const candidate = path.resolve(rawSetting);
      if (candidate !== rawSetting) saveSetting(db, 'rag.lance.path', candidate, settings);
      return path.join(candidate, 'kb');
    }
    saveSetting(db, 'rag.lance.path', defaultRoot, settings);
  }
  return path.join(defaultRoot, 'kb');
}

/**
 * 首次连接前建目录（Rust `create_dir_all`）。自定义目录不可用时与 Rust 一样警告、
 * 把设置写回默认根并改用默认目录；移动端目录操作同样是异步的。
 */
async function ensureLanceDir(
  files: FilesService,
  db: SqlExecutor,
  desired: string,
  logger?: LaneLogger,
  settings?: SettingsWithConn,
): Promise<string> {
  try {
    await files.mkdir(desired, { recursive: true });
    return desired;
  } catch (error) {
    const defaultRoot = defaultLanceRoot(db);
    const fallback = path.join(defaultRoot, 'kb');
    if (fallback === desired) throw error;
    logger?.warn(`[Lance路径] 自定义目录不可用 ${desired}: ${messageOf(error)}`);
    saveSetting(db, 'rag.lance.path', defaultRoot, settings);
    await files.mkdir(fallback, { recursive: true });
    return fallback;
  }
}

export { CHAT_V2_TABLE_PREFIX, CHAT_LEGACY_TABLE_PREFIX, CHAT_LEGACY_FALLBACK_TABLE, OPTIMIZE_MIN_INTERVAL_CHAT_SECS };
