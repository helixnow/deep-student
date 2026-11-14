/**
 * Shared types and constants for the VFS Lance store.
 *
 * Behaviour is ported from `crates/dstu-vfs/src/vfs/lance_store.rs`. The native
 * LanceDB engine is supplied through {@link LanceConnection}.
 */
import type { VfsLanceSearchResult } from '../api.ts';
import type { LaneLogger } from './logger.ts';

/** lance_store.rs::parse_metadata_fields: Value lookup, then as_i64 and Rust's i32 cast. */
export function parseLanceMetadataFields(text: string | null | undefined): [number | null, string | null] {
  if (text == null) return [null, null];
  try {
    // This is serde_json::Value, not a typed struct. Native JSON parsing supplies
    // last-wins keys and accepts arbitrary-precision numbers in unrelated fields.
    // Reviver source retains the one integer token we consume before JS rounds it.
    const pageTokens = new WeakMap<object, string>();
    const parsed: unknown = JSON.parse(text, function (this: object, key: string, value: unknown,
      context?: { source?: string }) {
      if (key === 'page_index' && typeof value === 'number' && context?.source !== undefined) {
        pageTokens.set(this, context.source);
      }
      return value;
    });
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return [null, null];
    const raw = pageTokens.get(parsed);
    let pageIndex: number | null = null;
    if (raw !== undefined && /^-?(?:0|[1-9][0-9]*)$/.test(raw)) {
      const value = BigInt(raw);
      if (value >= -9223372036854775808n && value <= 9223372036854775807n) {
        pageIndex = Number(BigInt.asIntN(32, value));
      }
    }
    const source = 'source_id' in parsed ? parsed.source_id : null;
    return [pageIndex, typeof source === 'string' ? source : null];
  } catch (error) {
    if (error instanceof SyntaxError) return [null, null];
    throw error;
  }
}

export const VFS_LANCE_TABLE_PREFIX = 'vfs_emb_';
export const VFS_FTS_VERSION = '2026-01-vfs-ngram-v1';
export const OPTIMIZE_MIN_INTERVAL_SECS = 1800;
export const MIN_ROWS_FOR_ANN_INDEX = 256;
export const ANN_INDEX_VERSION = 1;

/** VfsError-compatible error with Rust Display text. */
export class VfsStoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'VfsStoreError';
    this.code = code;
  }
}

export function invalidArgument(param: string, reason: string): VfsStoreError {
  return new VfsStoreError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`);
}

export function invalidState(message: string): VfsStoreError {
  return new VfsStoreError('VFS_INVALID_OPERATION', `INVALID_STATE: ${message}`);
}

/** VfsError::InvalidState, including the same public error shape from L11. */
export function isInvalidState(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'VFS_INVALID_OPERATION'
    && error.message.startsWith('INVALID_STATE: ');
}

export function notFound(resourceType: string, id: string): VfsStoreError {
  return new VfsStoreError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`);
}

export function other(message: string): VfsStoreError {
  return new VfsStoreError('VFS_INTERNAL', message);
}

/** Preserve L12's public name while consuming F7's now-published schema type. */
export type LanceVectorColumn = import('../../../platform/vector/api.ts').VectorColumn;

/**
 * `lance_store.rs::build_schema` (882-901) as the F7 explicit column schema.
 * Column order is part of the Lance table contract.
 */
export function vfsLanceTableColumns(dimension: number): LanceVectorColumn[] {
  if (!Number.isSafeInteger(dimension) || dimension <= 0) {
    throw other(`无效的 Lance 向量维度: ${dimension}`);
  }
  return [
    { name: 'embedding_id', type: 'utf8', nullable: false },
    { name: 'resource_id', type: 'utf8', nullable: false },
    { name: 'unit_id', type: 'utf8', nullable: false },
    { name: 'resource_type', type: 'utf8', nullable: false },
    { name: 'folder_id', type: 'utf8', nullable: true },
    { name: 'chunk_index', type: 'int32', nullable: false },
    { name: 'text', type: 'utf8', nullable: false },
    { name: 'metadata', type: 'utf8', nullable: true },
    { name: 'created_at', type: 'utf8', nullable: false },
    { name: 'index_profile_id', type: 'utf8', nullable: false },
    { name: 'generation', type: 'int64', nullable: false },
    { name: 'embedding', type: 'vector', nullable: false, dimension },
  ];
}

export interface LanceColumnSchema {
  readonly name: string;
}

export interface LanceTableSchema {
  readonly fields: readonly LanceColumnSchema[];
}

export interface LanceSearchRequest {
  readonly vector?: readonly number[];
  readonly text?: string;
  readonly limit: number;
  readonly filter: string | null;
  readonly bypassVectorIndex: boolean;
  readonly refineFactor: number | null;
  readonly select: readonly string[];
}

export type LanceWritableRow = Readonly<Record<string, unknown>>;

export interface LanceTable {
  countRows(): Promise<number>;
  schema(): Promise<LanceTableSchema>;
  addColumns(expressions: readonly (readonly [string, string])[]): Promise<void>;
  createIndex(columns: readonly string[], kind: string): Promise<void>;
  add(rows: readonly LanceWritableRow[]): Promise<void>;
  delete(filter: string): Promise<void>;
  optimize(
    action: 'compact' | 'prune' | 'index' | 'all',
    options?: { olderThanDays?: number | null; deleteUnverified?: boolean },
  ): Promise<void>;
  /**
   * F7's Node binding exposes only all-actions optimize. Present when the
   * provider cannot run compact/prune/index individually.
   */
  optimizeAll?(options?: { olderThanDays?: number | null; deleteUnverified?: boolean }): Promise<void>;
  vectorSearch(request: LanceSearchRequest): Promise<VfsLanceSearchResult[]>;
  ftsSearch(request: LanceSearchRequest): Promise<VfsLanceSearchResult[]>;
  /** Raw metadata values for diagnostics. */
  scanMetadata?(): Promise<Array<string | null>>;
}

export interface LanceConnection {
  tableNames(): Promise<string[]>;
  openTable(name: string): Promise<LanceTable | null>;
  /** F7 `createTableWithSchema`: callers pass their complete VFS/legacy schema. */
  createTable(name: string, columns: readonly LanceVectorColumn[]): Promise<LanceTable>;
  dropTable(name: string): Promise<void>;
  /** Mirrors the on-disk directory check in `sweep_retired_profile_tables_inner`. */
  hasTableDirectory(name: string): boolean;
}

export interface LanceAdapter {
  connect(path: string): Promise<LanceConnection>;
}

export interface VfsLanceStoreOptions {
  /** Directory used for the Lance catalog; passed through to the adapter. */
  readonly basePath: string;
  /**
   * Creates `basePath` before the first adapter connection. Mobile file backends only
   * expose async directory operations, so this replaces the old synchronous `mkdirSync`.
   */
  readonly ensureBaseDir?: () => Promise<void>;
  readonly adapter: LanceAdapter;
  /** Cordis logger (`ctx.logger('vfs-index')`); diagnostics only. */
  readonly logger?: LaneLogger;
}

/** Process-wide mutation gate, mirroring Rust `VFS_MUTATION_LOCK` (writer-preferring). */
export class MutationLock {
  private readers = 0;
  private writer = false;
  private writerQueue: Array<() => void> = [];
  private readerQueue: Array<() => void> = [];

  private async acquireReader(): Promise<() => void> {
    if (this.writer || this.writerQueue.length > 0) {
      await new Promise<void>((resolve) => this.readerQueue.push(resolve));
    }
    this.readers += 1;
    return () => {
      this.readers -= 1;
      this.drain();
    };
  }

  private async acquireWriter(): Promise<() => void> {
    if (this.writer || this.readers > 0) {
      await new Promise<void>((resolve) => this.writerQueue.push(resolve));
    }
    this.writer = true;
    return () => {
      this.writer = false;
      this.drain();
    };
  }

  private drain(): void {
    if (this.writer || this.readers > 0) return;
    const writer = this.writerQueue.shift();
    if (writer !== undefined) {
      writer();
      return;
    }
    while (this.readerQueue.length > 0) this.readerQueue.shift()!();
  }

  async read<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireReader();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async write<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquireWriter();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export const VFS_MUTATION_LOCK = new MutationLock();

export interface LanceTableDiagnostic {
  tableName: string;
  dimension: number;
  rowCount: number;
  columns: string[];
  hasMetadataColumn: boolean;
  hasEmbeddingIdColumn: boolean;
  hasResourceIdColumn: boolean;
  hasTextColumn: boolean;
  sampleMetadata: Array<string | null>;
  metadataWithPageIndex: number;
  metadataNullCount: number;
  schemaValid: boolean;
  issueDescription: string | null;
}
