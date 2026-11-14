/**
 * Legacy KB vector store (`LanceVectorStore` KB slice), retained for the
 * `kb_chunks_v2_d*` tables that predate the VFS profile store.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import * as path from '../../../platform/util/path.ts';
import type { FilesService } from '../../../platform/files/api.ts';
import type { DatabaseHandle } from '../../../platform/storage/api.ts';
import type { LanceEngineService } from '../api.ts';
import type { LanceTable, LanceVectorColumn } from './lance-store.ts';
import { MIN_ROWS_FOR_ANN_INDEX } from './lance-types.ts';
import type { LaneLogger } from './logger.ts';
import type { SettingsWithConn } from '../../../platform/settings/api.ts';
import { KB_MUTATION_LOCK } from './kb-mutation-lock.ts';
import {
  clearRagMetadata,
  ensureBaseRagSchema,
  getDocumentSubLibraries,
  getSetting,
  insertDocumentRecord,
  replaceDocumentChunks,
  type RagChunkRow,
  saveSetting,
} from '../repository/chat-lance.ts';

export const KB_V2_TABLE_PREFIX = 'kb_chunks_v2_d';
export const KB_LEGACY_TABLE_PREFIX = 'kb_chunks_d';

/**
 * `lance_vector_store.rs::ensure_wide_table` (1295-1311) explicit schema.
 * This is the legacy KB table, not the VFS profile schema.
 */
export function legacyKbTableColumns(dimension: number): LanceVectorColumn[] {
  if (!Number.isSafeInteger(dimension) || dimension <= 0) {
    throw new Error(`无效的 Lance 向量维度: ${dimension}`);
  }
  return [
    { name: 'chunk_id', type: 'utf8', nullable: false },
    { name: 'document_id', type: 'utf8', nullable: false },
    { name: 'sub_library_id', type: 'utf8', nullable: true },
    { name: 'chunk_index', type: 'int32', nullable: false },
    { name: 'text', type: 'utf8', nullable: false },
    { name: 'metadata', type: 'utf8', nullable: true },
    { name: 'created_at', type: 'utf8', nullable: false },
    { name: 'embedding', type: 'vector', nullable: false, dimension },
  ];
}

export interface DocumentChunk {
  id: string;
  document_id: string;
  chunk_index: number;
  text: string;
  metadata: Readonly<Record<string, unknown>>;
}

export interface DocumentChunkWithEmbedding {
  chunk: DocumentChunk;
  embedding: readonly number[];
}

interface LanceChunkRow extends RagChunkRow {
  sub_library_id: string | null;
  created_at: string;
  embedding: readonly number[];
}

export class LegacyKbStore {
  private readonly db: DatabaseHandle;
  private readonly engine: LanceEngineService;
  private lancePath: string;
  private readonly logger: LaneLogger | undefined;
  private prepare: (() => Promise<string>) | undefined;
  private readonly ensuredTables = new Set<string>();

  private constructor(
    db: DatabaseHandle,
    engine: LanceEngineService,
    lancePath: string,
    logger?: LaneLogger,
    prepare?: () => Promise<string>,
  ) {
    this.db = db;
    this.engine = engine;
    this.lancePath = lancePath;
    this.logger = logger;
    this.prepare = prepare;
  }

  static create(
    db: DatabaseHandle,
    engine: LanceEngineService,
    files: () => FilesService,
    logger?: LaneLogger,
    settings?: SettingsWithConn,
  ): LegacyKbStore {
    ensureBaseRagSchema(db, logger);
    const desired = resolveKbLancePath(db, settings);
    return new LegacyKbStore(db, engine, desired, logger,
      () => ensureKbLanceDir(files(), db, desired, logger, settings));
  }

  /** First connect creates the directory (Rust `create_dir_all`) through `ctx.files`. */
  private async connection(): Promise<Awaited<ReturnType<LanceEngineService['connect']>>> {
    if (this.prepare !== undefined) {
      this.lancePath = await this.prepare();
      // The directory only needs creating once; keep the resolved path afterwards.
      this.prepare = undefined;
    }
    return this.engine.connect(this.lancePath);
  }

  static parseDimFromTableName(name: string, prefix: string): number | null {
    if (!name.startsWith(prefix)) return null;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) return null;
    const dim = Number(suffix);
    return Number.isSafeInteger(dim) ? dim : null;
  }

  /** Mirrors the retrieval-side `sort_by(score desc)` + first-seen chunk_id dedup. */
  static dedupeRowsByChunkId(
    rows: ReadonlyArray<readonly [string, number]>,
  ): Array<[string, number]> {
    const sorted: Array<[string, number]> = rows.map(([id, score]) => [id, score]);
    sorted.sort((left, right) => right[1] - left[1]);
    const seen = new Set<string>();
    return sorted.filter(([id]) => {
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }

  getLancePath(): string {
    return this.lancePath;
  }

  private async tableNames(prefix: string): Promise<Array<[number, string]>> {
    const connection = await this.connection();
    const names = await connection.tableNames();
    return names
      .map((name) => {
        const dim = LegacyKbStore.parseDimFromTableName(name, prefix);
        return dim === null ? null : [dim, name] as [number, string];
      })
      .filter((entry): entry is [number, string] => entry !== null)
      .sort((left, right) => left[0] - right[0]);
  }

  private async ensureWideTable(dim: number): Promise<LanceTable> {
    const connection = await this.connection();
    const tableName = `${KB_V2_TABLE_PREFIX}${dim}`;
    let table = await connection.openTable(tableName);
    if (table === null) table = await connection.createTable(tableName, legacyKbTableColumns(dim));
    if (this.ensuredTables.has(tableName)) return table;
    let allReady = true;
    const rowCount = await table.countRows().catch(() => 0);
    for (const [columns, kind] of [
      [['embedding'], 'cosine-ivf-pq'],
      [['text'], 'fts-ngram'],
      [['chunk_id'], 'btree'],
      [['document_id'], 'btree'],
      [['sub_library_id'], 'btree'],
    ] as const) {
      // `ensure_embedding_ann_index` skips IVF-PQ below the training threshold
      // and deliberately does not cache the table so it is retried later.
      if (kind === 'cosine-ivf-pq' && rowCount < MIN_ROWS_FOR_ANN_INDEX) {
        allReady = false;
        continue;
      }
      try {
        await table.createIndex(columns, kind);
      } catch (error) {
        const message = messageOf(error);
        if (!message.includes('already exists')) {
          allReady = false;
          // Rust `ensure_wide_table` warns and continues; it only caches the
          // table as ensured when every secondary index succeeded.
          const column = columns.join(',');
          this.logger?.warn(`⚠️ [LanceIndex] 索引确保失败 ${tableName}.${column}: ${message}`);
        }
      }
    }
    if (allReady) this.ensuredTables.add(tableName);
    return table;
  }

  addDocumentRecordWithLibrary(
    documentId: string,
    fileName: string,
    filePath: string | null,
    fileSize: number | null,
    subLibraryId: string,
  ): void {
    try {
      insertDocumentRecord(this.db, documentId, fileName, filePath, fileSize, subLibraryId);
    } catch (error) {
      throw new Error(`Database error: 添加文档记录失败: ${messageOf(error)}`);
    }
  }

  async addChunks(chunks: readonly DocumentChunkWithEmbedding[]): Promise<void> {
    if (chunks.length === 0) return;
    await KB_MUTATION_LOCK.read(async () => this.addChunksLocked(chunks));
  }

  private async addChunksLocked(chunks: readonly DocumentChunkWithEmbedding[]): Promise<void> {
    const dim = chunks[0]!.embedding.length;
    if (dim === 0) throw new Error('Validation error: embedding 维度不可为 0');
    const inconsistent = chunks.find((chunk) => chunk.embedding.length !== dim);
    if (inconsistent !== undefined) {
      throw new Error(
        `Validation error: 检测到不一致的 embedding 维度: ${inconsistent.embedding.length} vs ${dim}`,
      );
    }
    let subLibraries: Map<string, string>;
    try {
      subLibraries = getDocumentSubLibraries(
        this.db,
        [...new Set(chunks.map((chunk) => chunk.chunk.document_id))],
      );
    } catch (error) {
      throw new Error(`Database error: ${messageOf(error)}`);
    }
    const createdAt = toRfc3339();
    const rows: LanceChunkRow[] = chunks.map(({ chunk, embedding }) => ({
      chunk_id: chunk.id,
      document_id: chunk.document_id,
      sub_library_id: subLibraries.get(chunk.document_id) ?? null,
      chunk_index: chunk.chunk_index,
      text: chunk.text,
      metadata_json: Object.keys(chunk.metadata).length === 0
        ? null
        : JSON.stringify(chunk.metadata),
      created_at: createdAt,
      embedding: [...embedding],
    }));
    const table = await this.ensureWideTable(dim);
    // `merge_insert(chunk_id)` semantics; the adapter has no native merge, so
    // remove matching keys first and then append the replacement rows.
    await table.delete(`chunk_id IN (${rows.map((row) => `'${row.chunk_id.replace(/'/g, "''")}'`).join(',')})`);
    await table.add(rows as unknown as ReadonlyArray<Readonly<Record<string, unknown>>>);
    try {
      replaceDocumentChunks(this.db, rows);
    } catch (error) {
      try {
        await table.delete(`chunk_id IN (${rows.map((row) => `'${row.chunk_id.replace(/'/g, "''")}'`).join(',')})`);
      } catch (cleanupError) {
        throw new Error(
          `Database error: 写入 SQLite 分块元数据失败: ${messageOf(error)}; `
          + `且补偿删除 Lance 行失败（存在孤儿向量，需重建该文档索引）: ${messageOf(cleanupError)}`,
        );
      }
      throw new Error(`Database error: ${messageOf(error)}`);
    }
  }

  async clearAll(): Promise<void> {
    await KB_MUTATION_LOCK.write(async () => this.clearAllLocked());
  }

  private async clearAllLocked(): Promise<void> {
    const connection = await this.connection();
    const names = [
      ...(await this.tableNames(KB_V2_TABLE_PREFIX)).map(([, name]) => name),
      ...(await this.tableNames(KB_LEGACY_TABLE_PREFIX)).map(([, name]) => name),
    ].sort().filter((name, index, all) => index === 0 || name !== all[index - 1]);
    for (const name of names) {
      const table = await connection.openTable(name);
      if (table === null) {
        throw new Error(`Database error: 打开待清空 Lance 表 ${name} 失败: table not found`);
      }
      await table.delete('true').catch((error: unknown) => {
        throw new Error(`Database error: 清空 Lance 表 ${name} 失败: ${messageOf(error)}`);
      });
      const remaining = await table.countRows().catch((error: unknown) => {
        throw new Error(`Database error: 校验 Lance 表 ${name} 清空结果失败: ${messageOf(error)}`);
      });
      if (remaining !== 0) {
        throw new Error(`Database error: Lance 表 ${name} 清空后仍残留 ${remaining} 行`);
      }
    }
    try {
      clearRagMetadata(this.db);
    } catch (error) {
      throw new Error(`Database error: ${messageOf(error)}`);
    }
  }
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Rust `std::env::current_dir()` 的兜底：只在数据库没有路径（`:memory:`）时用到。
 * 宿主没有 `process`（移动端 Worker）时退回 `/`，与 `:memory:` 库的 Lance 目录一样只用于测试。
 */
function currentDir(): string {
  return (globalThis as { process?: { cwd?: () => string } }).process?.cwd?.() ?? '/';
}

function defaultKbRoot(db: DatabaseHandle): string {
  const dbPath = (db as { readonly path?: string }).path;
  return path.join(dbPath === undefined ? currentDir() : path.dirname(dbPath), 'lance');
}

function resolveKbLancePath(db: DatabaseHandle, settings?: SettingsWithConn): string {
  const defaultRoot = defaultKbRoot(db);
  const rawSetting = rustTrim(getSetting(db, 'rag.lance.path') ?? '');
  if (rawSetting !== '') {
    if (path.isAbsolute(rawSetting)) return path.join(path.resolve(rawSetting), 'kb');
    saveSetting(db, 'rag.lance.path', defaultRoot, settings);
  }
  return path.join(defaultRoot, 'kb');
}

/**
 * 首次连接前建目录（Rust `create_dir_all`）。自定义目录不可用时与 Rust 一样警告、
 * 把设置写回默认根并改用默认目录；移动端目录操作同样是异步的。
 */
async function ensureKbLanceDir(
  files: FilesService,
  db: DatabaseHandle,
  desired: string,
  logger?: LaneLogger,
  settings?: SettingsWithConn,
): Promise<string> {
  const defaultRoot = defaultKbRoot(db);
  const fallback = path.join(defaultRoot, 'kb');
  try {
    await files.mkdir(desired, { recursive: true });
    return desired;
  } catch (error) {
    if (fallback === desired) throw error;
    logger?.warn(`[Lance路径] 自定义目录不可用 ${desired}: ${messageOf(error)}`);
    saveSetting(db, 'rag.lance.path', defaultRoot, settings);
    await files.mkdir(fallback, { recursive: true });
    return fallback;
  }
}
