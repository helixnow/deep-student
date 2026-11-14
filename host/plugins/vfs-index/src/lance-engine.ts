/**
 * `lanceEngine` service: bridges the F7 platform `vector` service to the VFS
 * Lance boundary used by this lane.
 *
 * F7 (`ds-mig/F7-native`) publishes `connect` / `openTable` / `tableNames` /
 * `dropTable` / `createTableWithSchema` / `hasTableDirectory`, and tables expose
 * `query` / `search` / `fullTextSearch` / `schema` / `addColumns` / `createIndex`
 * / `optimizeAll`. The VFS store maps raw `_distance`/`_score` rows into
 * `VfsLanceSearchResult` and supplies its full VFS/legacy schemas; it never
 * probes a legacy `createTable(name, dimension)` signature. Missing capabilities
 * fail explicitly instead of pretending the write succeeded.
 */
import type {
  VectorConnection,
  VectorRow,
  VectorService,
  VectorTable,
} from '../../../platform/vector/api.ts';
import type { LanceEngineService, VfsLanceSearchResult } from '../api.ts';
import {
  VfsStoreError,
  other,
  parseLanceMetadataFields,
  vfsLanceTableColumns,
  type LanceConnection,
  type LanceSearchRequest,
  type LanceTable,
  type LanceTableSchema,
  type LanceVectorColumn,
  type LanceWritableRow,
} from './lance-types.ts';

export type { LanceVectorColumn };
export { vfsLanceTableColumns };
/** Backwards-compatible name for the VFS table schema builder. */
export const lanceTableColumns = vfsLanceTableColumns;

type VectorTableExtras = VectorTable & {
  schema?: () => Promise<LanceTableSchema>;
  addColumns?: (expressions: readonly (readonly [string, string])[]) => Promise<void>;
  createIndex?: (columns: readonly string[], kind: string) => Promise<void>;
  /** Legacy provider action, applied verbatim; F7-native no longer exposes it. */
  optimize?: (
    action: 'compact' | 'prune' | 'index' | 'all',
    options?: { olderThanDays?: number | null; deleteUnverified?: boolean },
  ) => Promise<void>;
  /** F7 `vector/api.ts`: all-actions optimize only. */
  optimizeAll?: (options?: { olderThanDays?: number; deleteUnverified?: boolean }) => Promise<void>;
  vectorSearch?: (request: LanceSearchRequest) => Promise<VfsLanceSearchResult[]>;
  /** Legacy provider FTS action. */
  ftsSearch?: (request: LanceSearchRequest) => Promise<VfsLanceSearchResult[]>;
  /** F7 `vector/api.ts`: native Lance full-text search. */
  fullTextSearch?: (
    text: string,
    options: { columns?: string[]; filter?: string; limit: number },
  ) => Promise<VectorRow[]>;
  scanMetadata?: () => Promise<Array<string | null>>;
};

type VectorConnectionExtras = VectorConnection & {
  /** F7 `vector/api.ts`: owner supplies the explicit business schema. */
  createTableWithSchema?: (name: string, columns: readonly LanceVectorColumn[]) => Promise<VectorTable>;
  hasTableDirectory?: (name: string) => boolean;
};

function hasMethod(value: object, key: string): boolean {
  return typeof (value as Record<string, unknown>)[key] === 'function';
}

function isNativeTable(table: VectorTable): table is VectorTable & LanceTable {
  return hasMethod(table, 'vectorSearch')
    && hasMethod(table, 'ftsSearch')
    && hasMethod(table, 'schema')
    && hasMethod(table, 'addColumns')
    && hasMethod(table, 'createIndex')
    && hasMethod(table, 'optimize');
}

function requiredString(row: VectorRow, key: string, context: string): string {
  const value = row[key];
  if (typeof value !== 'string') {
    throw other(`F7 vector ${context} 返回行缺少字符串字段 ${key}`);
  }
  return value;
}

function optionalString(row: VectorRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

const INT32_MIN = -2147483648n;
const INT32_MAX = 2147483647n;

/** Rust `i32` field: validate its own range instead of applying i64 safety rules. */
function requiredInt32(row: VectorRow, key: string, context: string): number {
  const value: unknown = row[key];
  if (typeof value === 'number'
    && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) {
    return value;
  }
  if (typeof value === 'bigint') {
    if (value < INT32_MIN || value > INT32_MAX) {
      throw other(`F7 vector ${context} 返回的 ${key} 超出 int32 范围`);
    }
    return Number(value);
  }
  throw other(`F7 vector ${context} 返回行缺少 int32 字段 ${key}`);
}

/**
 * Rust `i64` generation. F7 surfaces it as `number` or `bigint`; keep the
 * native `bigint` exactly and never reject a legal i64 while it is internal
 * (generation is not an IPC field).
 */
function requiredGeneration(row: VectorRow, key: string, context: string): number | bigint {
  const value: unknown = row[key];
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  throw other(`F7 vector ${context} 返回行缺少整数 generation`);
}

/**
 * `lance_store.rs::extract_search_results_hybrid` score order: `_relevance_score`,
 * then `1 - _distance`, then `_score`, else 0.0. FTS selects only the result
 * columns, so a missing score column is valid and maps to 0.0.
 */
function scoreOf(row: VectorRow): number {
  const relevance = row._relevance_score;
  if (typeof relevance === 'number' && Number.isFinite(relevance)) return relevance;
  const distance = row._distance;
  if (typeof distance === 'number' && Number.isFinite(distance)) {
    return Math.min(1, Math.max(-1, 1 - distance));
  }
  const fts = row._score;
  if (typeof fts === 'number' && Number.isFinite(fts)) return fts;
  return 0;
}

function toSearchResult(row: VectorRow, score: number): VfsLanceSearchResult {
  const metadata = row.metadata === null || row.metadata === undefined ? null : String(row.metadata);
  const [pageIndex, sourceId] = parseLanceMetadataFields(metadata);
  return {
    embedding_id: requiredString(row, 'embedding_id', 'search'),
    resource_id: requiredString(row, 'resource_id', 'search'),
    unit_id: requiredString(row, 'unit_id', 'search'),
    resource_type: requiredString(row, 'resource_type', 'search'),
    folder_id: optionalString(row, 'folder_id'),
    chunk_index: requiredInt32(row, 'chunk_index', 'search'),
    text: requiredString(row, 'text', 'search'),
    score,
    metadata_json: metadata,
    index_profile_id: requiredString(row, 'index_profile_id', 'search'),
    generation: requiredGeneration(row, 'generation', 'search'),
    page_index: pageIndex,
    source_id: sourceId,
  };
}

function toVectorRows(rows: readonly LanceWritableRow[]): VectorRow[] {
  return rows.map((row) => ({ ...row } as VectorRow));
}

class VectorLanceTable implements LanceTable {
  private readonly extras: VectorTableExtras;

  private readonly table: VectorTable;

  constructor(table: VectorTable) {
    this.table = table;
    this.extras = table;
  }

  async countRows(): Promise<number> {
    return this.table.countRows();
  }

  async schema(): Promise<LanceTableSchema> {
    if (this.extras.schema !== undefined) return this.extras.schema();
    const rows = await this.table.query({ limit: 1 });
    const first = rows[0];
    return { fields: first === undefined ? [] : Object.keys(first).map((name) => ({ name })) };
  }

  async addColumns(expressions: readonly (readonly [string, string])[]): Promise<void> {
    if (this.extras.addColumns !== undefined) {
      await this.extras.addColumns(expressions);
      return;
    }
    if (expressions.length === 0) return;
    throw other(
      `F7 vector 服务缺少 addColumns 能力，无法升级 Lance 生命周期列: ${expressions.map(([name]) => name).join(', ')}`,
    );
  }

  async createIndex(columns: readonly string[], kind: string): Promise<void> {
    if (this.extras.createIndex === undefined) {
      throw other(`F7 vector 服务缺少 createIndex 能力: ${kind}(${columns.join(', ')})`);
    }
    await this.extras.createIndex(columns, kind);
  }

  async add(rows: readonly LanceWritableRow[]): Promise<void> {
    await this.table.add(toVectorRows(rows));
  }

  async delete(filter: string): Promise<void> {
    await this.table.delete(filter);
  }

  async optimize(
    action: 'compact' | 'prune' | 'index' | 'all',
    options?: { olderThanDays?: number | null; deleteUnverified?: boolean },
  ): Promise<void> {
    if (this.extras.optimize !== undefined) {
      await this.extras.optimize(action, options);
      return;
    }
    if (this.extras.optimizeAll !== undefined && action === 'all') {
      await this.extras.optimizeAll({
        ...(options?.olderThanDays === undefined || options.olderThanDays === null
          ? {}
          : { olderThanDays: options.olderThanDays }),
        ...(options?.deleteUnverified === undefined
          ? {}
          : { deleteUnverified: options.deleteUnverified }),
      });
      return;
    }
    if (this.extras.optimizeAll !== undefined) {
      throw other(
        `F7 vector optimizeAll 只能执行全量优化，无法单独执行 ${action}；`
        + 'VFS 优化入口应请求 all',
      );
    }
    throw other(`F7 vector 服务缺少 optimize 能力: ${action}`);
  }

  async optimizeAll(options?: {
    olderThanDays?: number | null;
    deleteUnverified?: boolean;
  }): Promise<void> {
    if (this.extras.optimizeAll !== undefined) {
      await this.extras.optimizeAll({
        ...(options?.olderThanDays === undefined || options.olderThanDays === null
          ? {}
          : { olderThanDays: options.olderThanDays }),
        ...(options?.deleteUnverified === undefined
          ? {}
          : { deleteUnverified: options.deleteUnverified }),
      });
      return;
    }
    if (this.extras.optimize !== undefined) {
      await this.extras.optimize('all', options);
      return;
    }
    throw other('F7 vector 服务缺少 optimizeAll 能力');
  }

  async vectorSearch(request: LanceSearchRequest): Promise<VfsLanceSearchResult[]> {
    if (this.extras.vectorSearch !== undefined) return this.extras.vectorSearch(request);
    if (request.vector === undefined) {
      throw other('F7 vector 服务缺少 ftsSearch 能力，且向量查询缺少 query vector');
    }
    // F7 branch adds bypassVectorIndex/refineFactor; the main platform type is
    // narrower, so call with a structurally extended options object.
    const options = {
      column: 'embedding',
      metric: 'cosine' as const,
      limit: request.limit,
      ...(request.filter === null ? {} : { filter: request.filter }),
      columns: [...request.select],
      bypassVectorIndex: request.bypassVectorIndex,
      ...(request.refineFactor === null ? {} : { refineFactor: request.refineFactor }),
    };
    const rows = await this.table.search([...request.vector], options);
    return rows.map((row) => toSearchResult(row, scoreOf(row)));
  }

  async ftsSearch(request: LanceSearchRequest): Promise<VfsLanceSearchResult[]> {
    if (this.extras.ftsSearch !== undefined) return this.extras.ftsSearch(request);
    if (this.extras.fullTextSearch === undefined) {
      throw other('F7 vector 服务缺少 fullTextSearch 能力');
    }
    if (request.text === undefined) {
      throw other('F7 vector fullTextSearch 需要查询文本');
    }
    const rows = await this.extras.fullTextSearch(request.text, {
      columns: [...request.select],
      ...(request.filter === null ? {} : { filter: request.filter }),
      limit: request.limit,
    });
    return rows.map((row) => toSearchResult(row, scoreOf(row)));
  }

  async scanMetadata(): Promise<Array<string | null>> {
    if (this.extras.scanMetadata !== undefined) return this.extras.scanMetadata();
    // F7 has no dedicated scan method; `query` is the no-vector scan path.
    const rows = await this.table.query({ columns: ['metadata'] });
    return rows.map((row) => (typeof row.metadata === 'string' ? row.metadata : null));
  }
}

class VectorLanceConnection implements LanceConnection {
  private readonly extras: VectorConnectionExtras;
  private knownTables: Set<string> | null = null;

  private readonly connection: VectorConnection;

  constructor(connection: VectorConnection) {
    this.connection = connection;
    this.extras = connection;
  }

  async tableNames(): Promise<string[]> {
    const names = await this.connection.tableNames();
    this.knownTables = new Set(names);
    return names;
  }

  async openTable(name: string): Promise<LanceTable | null> {
    const names = this.knownTables ?? new Set(await this.tableNames());
    if (!names.has(name)) return null;
    const table = await this.connection.openTable(name);
    return isNativeTable(table) ? table : new VectorLanceTable(table);
  }

  async createTable(
    name: string,
    columns: readonly LanceVectorColumn[],
  ): Promise<LanceTable> {
    if (this.extras.createTableWithSchema === undefined) {
      throw other(
        `F7 vector 服务缺少 createTableWithSchema 能力，`
        + `无法创建 Lance 表 ${name}`,
      );
    }
    const table = await this.extras.createTableWithSchema(name, columns);
    this.knownTables?.add(name);
    return isNativeTable(table) ? table : new VectorLanceTable(table);
  }

  async dropTable(name: string): Promise<void> {
    await this.connection.dropTable(name);
    this.knownTables?.delete(name);
  }

  hasTableDirectory(name: string): boolean {
    if (this.extras.hasTableDirectory !== undefined) return this.extras.hasTableDirectory(name);
    return this.knownTables === null ? true : this.knownTables.has(name);
  }
}

export class VectorLanceEngine implements LanceEngineService {
  private readonly vector: VectorService;

  constructor(vector: VectorService) {
    this.vector = vector;
  }

  async connect(path: string): Promise<LanceConnection> {
    return new VectorLanceConnection(await this.vector.connect(path));
  }
}

/** Without an F7 `vector` provider every engine call reports the disabled feature. */
export class UnavailableLanceEngine implements LanceEngineService {
  async connect(_path: string): Promise<LanceConnection> {
    throw new VfsStoreError('VFS_INVALID_OPERATION', '向量索引功能未启用（当前构建未包含 lance feature）');
  }
}

/**
 * `lanceEngine` is provided during L12 apply, before F7's deferred provider is
 * guaranteed to exist. It resolves the current `vector` service per connect so a
 * late-loaded or replaced provider is picked up without restarting L12.
 */
export class LifecycleLanceEngine implements LanceEngineService {
  private current: LanceEngineService = new UnavailableLanceEngine();

  setVector(vector: VectorService | undefined): void {
    this.current = createLanceEngine(vector);
  }

  async connect(path: string): Promise<LanceConnection> {
    return this.current.connect(path);
  }
}

export function createLanceEngine(vector: VectorService | undefined): LanceEngineService {
  return vector === undefined ? new UnavailableLanceEngine() : new VectorLanceEngine(vector);
}
