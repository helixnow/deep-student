import { describe, expect, it } from 'vitest';
import type {
  VectorConnection,
  VectorRow,
  VectorService,
  VectorTable,
} from '../../../platform/vector/api.ts';
import {
  UnavailableLanceEngine,
  VectorLanceEngine,
  createLanceEngine,
  lanceTableColumns,
  type LanceVectorColumn,
} from '../src/lance-engine.ts';
import { VfsStoreError } from '../src/lance-types.ts';

type SearchOptions = Parameters<VectorTable['search']>[1];

interface SearchCall { vector: number[]; options: SearchOptions }

class F7Table implements VectorTable {
  readonly added: VectorRow[][] = [];
  readonly deleted: string[] = [];
  readonly searchCalls: SearchCall[] = [];
  readonly queryCalls: Array<{ columns?: string[]; limit?: number }> = [];
  readonly ftsCalls: Array<{ text: string; options: { columns?: readonly string[]; filter?: string; limit: number } }> = [];
  readonly indexCalls: Array<{ columns: readonly string[]; kind: string }> = [];
  readonly schemaAdds: Array<readonly (readonly [string, string])[]> = [];
  readonly optimizeAllCalls: Array<{ olderThanDays?: number; deleteUnverified?: boolean } | undefined> = [];
  includeFtsScore = true;
  rows: VectorRow[] = [
    {
      embedding_id: 'emb-1',
      resource_id: 'res-1',
      unit_id: 'unit-1',
      resource_type: 'note',
      folder_id: null,
      chunk_index: 2,
      text: 'hello',
      metadata: '{"page":3}',
      index_profile_id: 'profile-1',
      generation: 4,
    },
  ];

  async add(rows: VectorRow[]): Promise<void> {
    this.added.push(rows);
  }

  async delete(predicate: string): Promise<void> {
    this.deleted.push(predicate);
  }

  async countRows(): Promise<number> {
    return this.rows.length;
  }

  async query(options: { filter?: string; columns?: string[]; limit?: number }): Promise<VectorRow[]> {
    this.queryCalls.push({
      ...(options.columns === undefined ? {} : { columns: options.columns }),
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    return this.rows.slice(0, options.limit ?? this.rows.length);
  }

  async search(vector: number[], options: SearchOptions): Promise<VectorRow[]> {
    this.searchCalls.push({ vector, options });
    return this.rows.slice(0, options.limit).map((row) => ({
      ...row,
      _distance: 0.25,
    }));
  }

  async schema(): Promise<{ fields: Array<{ name: string }> }> {
    return { fields: this.rows[0] === undefined
      ? []
      : Object.keys(this.rows[0]).map((name) => ({ name })) };
  }

  async addColumns(expressions: readonly (readonly [string, string])[]): Promise<void> {
    this.schemaAdds.push(expressions);
  }

  async createIndex(columns: readonly string[], kind: string): Promise<void> {
    this.indexCalls.push({ columns, kind });
  }

  async fullTextSearch(
    text: string,
    options: { columns?: readonly string[]; filter?: string; limit: number },
  ): Promise<VectorRow[]> {
    this.ftsCalls.push({ text, options });
    return this.rows.slice(0, options.limit).map((row) => (
      this.includeFtsScore ? { ...row, _score: 0.5 } : row
    ));
  }

  async optimizeAll(options?: { olderThanDays?: number; deleteUnverified?: boolean }): Promise<void> {
    this.optimizeAllCalls.push(options);
  }
}

class F7Connection implements VectorConnection {
  readonly tables = new Map<string, F7Table>();
  readonly opened: string[] = [];
  readonly dropped: string[] = [];
  readonly created: Array<{ name: string; columns: readonly LanceVectorColumn[] }> = [];
  connectedPath: string | null = null;

  constructor() {
    this.tables.set('vfs_emb_text_768', new F7Table());
  }

  async tableNames(): Promise<string[]> {
    return [...this.tables.keys()];
  }

  async openTable(name: string): Promise<VectorTable> {
    this.opened.push(name);
    const table = this.tables.get(name);
    if (table === undefined) throw new Error(`table not found: ${name}`);
    return table;
  }

  async createTableWithSchema(name: string, columns: readonly LanceVectorColumn[]): Promise<VectorTable> {
    this.created.push({ name, columns });
    const table = new F7Table();
    this.tables.set(name, table);
    return table;
  }

  async dropTable(name: string): Promise<void> {
    this.dropped.push(name);
    this.tables.delete(name);
  }

  close(): void {}
}

class F7Vector implements VectorService {
  readonly connection = new F7Connection();
  readonly paths: string[] = [];

  async connect(path: string): Promise<VectorConnection> {
    this.paths.push(path);
    this.connection.connectedPath = path;
    return this.connection;
  }
}

/** Minimal pre-F7 provider without any optional capability. */
class BareTable implements VectorTable {
  async add(): Promise<void> {}
  async delete(): Promise<void> {}
  async countRows(): Promise<number> { return 0; }
  async query(): Promise<VectorRow[]> { return []; }
  async search(): Promise<VectorRow[]> { return []; }
}

class BareConnection implements VectorConnection {
  async tableNames(): Promise<string[]> { return ['bare']; }
  async openTable(): Promise<VectorTable> { return new BareTable(); }
  async dropTable(): Promise<void> {}
  close(): void {}
}

describe('lanceEngine F7 vector bridge', () => {
  it('connects through the platform vector service and caches table names', async () => {
    const vector = new F7Vector();
    const engine = new VectorLanceEngine(vector);
    const connection = await engine.connect('/tmp/lance');

    expect(vector.paths).toEqual(['/tmp/lance']);
    expect(connection.hasTableDirectory('vfs_emb_text_768')).toBe(true);
    expect(await connection.tableNames()).toEqual(['vfs_emb_text_768']);
    expect(connection.hasTableDirectory('retired')).toBe(false);
    expect(await connection.openTable('missing')).toBeNull();
    expect(vector.connection.opened).toEqual([]);
  });

  it('creates tables with the Rust build_schema columns through createTableWithSchema', async () => {
    const vector = new F7Vector();
    const engine = new VectorLanceEngine(vector);
    const connection = await engine.connect('/tmp/lance');

    const table = await connection.createTable('vfs_emb_image_4', lanceTableColumns(4));

    expect(vector.connection.created).toHaveLength(1);
    expect(vector.connection.created[0]!.name).toBe('vfs_emb_image_4');
    expect(vector.connection.created[0]!.columns).toEqual(lanceTableColumns(4));
    expect(vector.connection.created[0]!.columns.map((column) => column.name)).toEqual([
      'embedding_id', 'resource_id', 'unit_id', 'resource_type', 'folder_id', 'chunk_index',
      'text', 'metadata', 'created_at', 'index_profile_id', 'generation', 'embedding',
    ]);
    expect(vector.connection.created[0]!.columns.at(-1)).toMatchObject({
      type: 'vector', dimension: 4, nullable: false,
    });
    await table.add([{ embedding_id: 'emb-2', embedding: [0.1, 0.2, 0.3, 0.4] }]);
    expect(vector.connection.tables.get('vfs_emb_image_4')!.added).toHaveLength(1);
    expect(connection.hasTableDirectory('vfs_emb_image_4')).toBe(true);
  });

  it('adapts add/delete/countRows and maps vector search rows', async () => {
    const vector = new F7Vector();
    const engine = new VectorLanceEngine(vector);
    const connection = await engine.connect('/tmp/lance');
    const table = await connection.openTable('vfs_emb_text_768');

    expect(table).not.toBeNull();
    expect(await table!.countRows()).toBe(1);
    await table!.add([{ embedding_id: 'emb-2', embedding: [0.1, 0.2, 0.3, 0.4] }]);
    await table!.delete("resource_id = 'res-1'");
    expect(vector.connection.tables.get('vfs_emb_text_768')!.added).toEqual([
      [{ embedding_id: 'emb-2', embedding: [0.1, 0.2, 0.3, 0.4] }],
    ]);
    expect(vector.connection.tables.get('vfs_emb_text_768')!.deleted).toEqual(["resource_id = 'res-1'"]);

    const results = await table!.vectorSearch({
      vector: [0.1, 0.2, 0.3, 0.4],
      limit: 3,
      filter: "resource_type = 'note'",
      bypassVectorIndex: true,
      refineFactor: 2,
      select: ['embedding_id', 'resource_id'],
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      embedding_id: 'emb-1',
      resource_id: 'res-1',
      unit_id: 'unit-1',
      chunk_index: 2,
      text: 'hello',
      score: 0.75,
      metadata_json: '{"page":3}',
      index_profile_id: 'profile-1',
      generation: 4,
      page_index: null,
      source_id: null,
    });
    expect(vector.connection.tables.get('vfs_emb_text_768')!.searchCalls[0]).toMatchObject({
      vector: [0.1, 0.2, 0.3, 0.4],
      options: {
        column: 'embedding',
        metric: 'cosine',
        limit: 3,
        filter: "resource_type = 'note'",
        columns: ['embedding_id', 'resource_id'],
        bypassVectorIndex: true,
        refineFactor: 2,
      },
    });
  });

  it('scans metadata through query and keeps Int64 generation exact', async () => {
    const vector = new F7Vector();
    const engine = new VectorLanceEngine(vector);
    const connection = await engine.connect('/tmp/lance');
    const table = (await connection.openTable('vfs_emb_text_768'))!;
    const internal = vector.connection.tables.get('vfs_emb_text_768')!;

    expect(await table.scanMetadata!()).toEqual(['{"page":3}']);
    expect(internal.queryCalls).toEqual([{ columns: ['metadata'] }]);

    internal.rows = [{
      ...internal.rows[0]!,
      generation: BigInt(7),
    } as unknown as VectorRow];
    const results = await table.vectorSearch({
      vector: [0.1, 0.2, 0.3, 0.4],
      limit: 3,
      filter: null,
      bypassVectorIndex: true,
      refineFactor: null,
      select: ['embedding_id'],
    });
    expect(results[0]!.generation).toBe(7n);
  });

  it.each([
    ['{"page_index":1,"source_id":"file_media"}', 1, 'file_media'],
    ['{"page_index":9007199254740993,"source_id":"file_media"}', 1, 'file_media'],
    ['{"page_index":9223372036854775807}', -1, null],
    ['{"page_index":9223372036854775808}', null, null],
    ['{"page_index":1.5,"source_id":"file_media"}', null, 'file_media'],
    ['{"page_index":-0}', 0, null],
    ['{"page_index":0,"page_index":2}', 2, null],
    ['{"page_index":1,"extra":1e400,"source_id":"file_media"}', 1, 'file_media'],
    ['{', null, null],
  ])('R12-01 parse_metadata_fields reads native metadata for vector and FTS: %s', async (metadata, page, source) => {
    const vector = new F7Vector();
    const table = (await (await new VectorLanceEngine(vector).connect('/tmp/lance')).openTable('vfs_emb_text_768'))!;
    vector.connection.tables.get('vfs_emb_text_768')!.rows[0]!.metadata = metadata;
    const request = { vector: [0.1, 0.2, 0.3, 0.4], text: 'hello', limit: 1,
      filter: null, bypassVectorIndex: true, refineFactor: null, select: ['metadata'] };
    for (const hits of [await table.vectorSearch(request), await table.ftsSearch(request)]) {
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ page_index: page, source_id: source, metadata_json: metadata });
    }
  });

  it('keeps large generation and adjacent i64 values distinct', async () => {
    const vector = new F7Vector();
    const engine = new VectorLanceEngine(vector);
    const connection = await engine.connect('/tmp/lance');
    const table = (await connection.openTable('vfs_emb_text_768'))!;
    const internal = vector.connection.tables.get('vfs_emb_text_768')!;

    const large = 9_007_199_254_740_993n; // 2^53 + 1
    const adjacent = 9_007_199_254_740_992n; // Number(large) would round to this
    internal.rows = [{ ...internal.rows[0]!, generation: large } as unknown as VectorRow];
    const largeResults = await table.vectorSearch({
      vector: [0.1, 0.2, 0.3, 0.4], limit: 1, filter: null,
      bypassVectorIndex: false, refineFactor: null, select: ['embedding_id'],
    });
    expect(largeResults[0]!.generation).toBe(large);
    expect(largeResults[0]!.generation).not.toBe(adjacent);

    internal.rows = [{ ...internal.rows[0]!, generation: adjacent } as unknown as VectorRow];
    const adjacentResults = await table.vectorSearch({
      vector: [0.1, 0.2, 0.3, 0.4], limit: 1, filter: null,
      bypassVectorIndex: false, refineFactor: null, select: ['embedding_id'],
    });
    expect(adjacentResults[0]!.generation).toBe(adjacent);
    expect(adjacentResults[0]!.generation).not.toBe(large);
  });

  it('handles chunk_index as i32 independently from i64 generation', async () => {
    const vector = new F7Vector();
    const engine = new VectorLanceEngine(vector);
    const connection = await engine.connect('/tmp/lance');
    const table = (await connection.openTable('vfs_emb_text_768'))!;
    const internal = vector.connection.tables.get('vfs_emb_text_768')!;

    internal.rows = [{ ...internal.rows[0]!, chunk_index: 2_147_483_647n } as unknown as VectorRow];
    const max = await table.vectorSearch({
      vector: [0.1, 0.2, 0.3, 0.4], limit: 1, filter: null,
      bypassVectorIndex: false, refineFactor: null, select: ['embedding_id'],
    });
    expect(max[0]!.chunk_index).toBe(2_147_483_647);

    internal.rows = [{ ...internal.rows[0]!, chunk_index: 2_147_483_648n } as unknown as VectorRow];
    await expect(table.vectorSearch({
      vector: [0.1, 0.2, 0.3, 0.4], limit: 1, filter: null,
      bypassVectorIndex: false, refineFactor: null, select: ['embedding_id'],
    })).rejects.toThrow('chunk_index 超出 int32 范围');
  });

  it('maps fullTextSearch rows and keeps Lance\'s missing-score fallback', async () => {
    const vector = new F7Vector();
    const engine = new VectorLanceEngine(vector);
    const connection = await engine.connect('/tmp/lance');
    const table = (await connection.openTable('vfs_emb_text_768'))!;
    const internal = vector.connection.tables.get('vfs_emb_text_768')!;

    const results = await table.ftsSearch({
      text: 'hello',
      limit: 4,
      filter: "resource_type = 'note'",
      bypassVectorIndex: false,
      refineFactor: null,
      select: ['embedding_id', 'text'],
    });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ embedding_id: 'emb-1', score: 0.5 });
    expect(internal.ftsCalls).toEqual([{
      text: 'hello',
      options: {
        columns: ['embedding_id', 'text'],
        filter: "resource_type = 'note'",
        limit: 4,
      },
    }]);

    // Rust `extract_search_results_hybrid` uses 0.0 when the FTS projection
    // omits `_score` (VFS selects only SEARCH_RESULT_COLUMNS).
    internal.includeFtsScore = false;
    const noScore = await table.ftsSearch({
      text: 'hello',
      limit: 4,
      filter: null,
      bypassVectorIndex: false,
      refineFactor: null,
      select: ['embedding_id'],
    });
    expect(noScore[0]!.score).toBe(0);
  });

  it('uses optimizeAll only for the all-actions request and rejects single actions', async () => {
    const vector = new F7Vector();
    const engine = new VectorLanceEngine(vector);
    const connection = await engine.connect('/tmp/lance');
    const table = (await connection.openTable('vfs_emb_text_768'))!;
    const internal = vector.connection.tables.get('vfs_emb_text_768')!;

    await table.optimize('all', { olderThanDays: 7, deleteUnverified: false });
    expect(internal.optimizeAllCalls).toEqual([{ olderThanDays: 7, deleteUnverified: false }]);

    await expect(table.optimize('compact')).rejects.toThrow(
      'F7 vector optimizeAll 只能执行全量优化，无法单独执行 compact',
    );
    await expect(table.optimize('prune')).rejects.toThrow(
      'F7 vector optimizeAll 只能执行全量优化，无法单独执行 prune',
    );
    await expect(table.optimize('index')).rejects.toThrow(
      'F7 vector optimizeAll 只能执行全量优化，无法单独执行 index',
    );
  });

  it('reports missing platform capabilities instead of silently succeeding', async () => {
    const engine = new VectorLanceEngine({
      async connect() { return new BareConnection(); },
    });
    const connection = await engine.connect('/tmp/lance');
    await connection.tableNames();
    const table = await connection.openTable('bare');

    await expect(connection.createTable('vfs_emb_image_4', lanceTableColumns(4))).rejects.toThrow(
      'F7 vector 服务缺少 createTableWithSchema 能力',
    );
    await expect(table!.addColumns([['unit_id', "''"]])).rejects.toThrow(
      'F7 vector 服务缺少 addColumns 能力',
    );
    await expect(table!.createIndex(['text'], 'fts-ngram')).rejects.toThrow(
      'F7 vector 服务缺少 createIndex 能力',
    );
    await expect(table!.optimize('all')).rejects.toThrow(
      'F7 vector 服务缺少 optimize 能力',
    );
    await expect(table!.optimizeAll!()).rejects.toThrow(
      'F7 vector 服务缺少 optimizeAll 能力',
    );
    await expect(table!.ftsSearch({
      text: 'hello',
      limit: 3,
      filter: null,
      bypassVectorIndex: false,
      refineFactor: null,
      select: ['embedding_id'],
    })).rejects.toThrow('F7 vector 服务缺少 fullTextSearch 能力');
  });

  it('forwards richer platform connections and tables unchanged', async () => {
    const table = new F7Table();
    const richTable = Object.assign(table, {
      async vectorSearch() { return []; },
      async ftsSearch() { return []; },
      async scanMetadata() { return [null]; },
      async optimize() {},
    });
    const richConnection = {
      async tableNames() { return ['vfs_emb_text_4']; },
      async openTable() { return richTable; },
      async createTableWithSchema() { return richTable; },
      async dropTable() {},
      hasTableDirectory() { return true; },
      close() {},
    };
    const engine = new VectorLanceEngine({
      async connect() { return richConnection; },
    });
    const connection = await engine.connect('/tmp/lance');
    expect(await connection.openTable('vfs_emb_text_4')).toBe(richTable);
    expect(await connection.createTable('vfs_emb_text_4', lanceTableColumns(4))).toBe(richTable);
  });

  it('reports the disabled feature when F7 has not published the vector provider', async () => {
    const engine = createLanceEngine(undefined);
    expect(engine).toBeInstanceOf(UnavailableLanceEngine);
    await expect(engine.connect('/tmp/lance')).rejects.toMatchObject({
      code: 'VFS_INVALID_OPERATION',
      message: '向量索引功能未启用（当前构建未包含 lance feature）',
    } satisfies Partial<VfsStoreError>);
  });
});
