import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import { testFiles } from './support/files.ts';
import { bindRealOwner, realOwner } from './support/real-owner.ts';
import { defineQuery, type DatabaseHandle } from '../../../platform/storage/api.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { JsonSyntaxError } from '../../../platform/util/api.ts';
import type { MultimodalInput } from '../src/multimodal.ts';
import type { VfsLanceRow, VfsLanceSearchResult } from '../api.ts';
import {
  VfsLanceStore,
  type LanceConnection,
  type LanceSearchRequest,
  type LanceTable,
  type LanceTableSchema,
  type LanceVectorColumn,
} from '../src/lance-store.ts';
import {
  modelFingerprintWithTransport,
  getActiveProfile,
  getByKey,
  getProfileById,
  registerWithModel,
} from '../repository/embedding-dim.ts';

class MemoryTable implements LanceTable {
  readonly columns: string[];
  readonly rows: Array<Record<string, unknown>> = [];
  readonly indices = new Set<string>();
  dimension: number;
  tableName: string;

  constructor(tableName: string, dimension: number, columns?: readonly string[]) {
    this.tableName = tableName;
    this.dimension = dimension;
    this.columns = columns === undefined
      ? [
        'embedding_id', 'resource_id', 'unit_id', 'resource_type', 'folder_id', 'chunk_index',
        'text', 'metadata', 'created_at', 'index_profile_id', 'generation', 'embedding',
      ]
      : [...columns];
  }

  async countRows(): Promise<number> {
    return this.rows.length;
  }

  async schema(): Promise<LanceTableSchema> {
    return { fields: this.columns.map((name) => ({ name })) };
  }

  async addColumns(expressions: readonly (readonly [string, string])[]): Promise<void> {
    for (const [name, expression] of expressions) {
      this.columns.push(name);
      for (const row of this.rows) {
        if (expression === "''") row[name] = '';
        else if (expression.startsWith("'")) row[name] = expression.slice(1, -1).replace(/''/g, "'");
        else row[name] = 0;
      }
    }
  }

  async createIndex(columns: readonly string[], kind: string): Promise<void> {
    const key = `${columns.join(',')}:${kind}`;
    if (this.indices.has(key)) throw new Error('index already exists');
    this.indices.add(key);
  }

  async add(rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    for (const row of rows) {
      this.rows.push({
        embedding_id: row.embedding_id,
        resource_id: row.resource_id,
        unit_id: row.unit_id,
        resource_type: row.resource_type,
        folder_id: row.folder_id,
        chunk_index: row.chunk_index,
        text: row.text,
        metadata: row.metadata,
        created_at: row.created_at,
        index_profile_id: row.index_profile_id,
        generation: row.generation,
        embedding: [...row.embedding as number[]],
      });
    }
  }

  async delete(filter: string): Promise<void> {
    const predicate = compileFilter(filter);
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (predicate(this.rows[index]!)) this.rows.splice(index, 1);
    }
  }

  async optimize(_action: 'compact' | 'prune' | 'index'): Promise<void> {
    // In-memory tables have nothing to compact.
  }

  async vectorSearch(request: LanceSearchRequest): Promise<VfsLanceSearchResult[]> {
    const predicate = request.filter === null ? () => true : compileFilter(request.filter);
    return this.rows
      .filter(predicate)
      .map((row) => toResult(row, cosine(request.vector ?? [], row['embedding'] as number[])))
      .sort((left, right) => right.score - left.score)
      .slice(0, request.limit);
  }

  async ftsSearch(request: LanceSearchRequest): Promise<VfsLanceSearchResult[]> {
    const predicate = request.filter === null ? () => true : compileFilter(request.filter);
    return this.rows
      .filter(predicate)
      .filter((row) => String(row['text']).includes(request.text ?? ''))
      .map((row) => toResult(row, 1));
  }

  async scanMetadata(): Promise<Array<string | null>> {
    return this.rows.map((row) => (row['metadata'] === null || row['metadata'] === undefined
      ? null
      : String(row['metadata'])));
  }
}

class MemoryConnection implements LanceConnection {
  readonly tables = new Map<string, MemoryTable>();

  async tableNames(): Promise<string[]> {
    return [...this.tables.keys()];
  }

  async openTable(name: string): Promise<LanceTable | null> {
    return this.tables.get(name) ?? null;
  }

  async createTable(
    name: string,
    columns: readonly LanceVectorColumn[],
  ): Promise<LanceTable> {
    const dimension = columns.find((column) => column.type === 'vector')?.dimension ?? 0;
    const table = new MemoryTable(name, dimension);
    this.tables.set(name, table);
    return table;
  }

  createTableWithSchema(name: string, columns: readonly LanceVectorColumn[]): Promise<LanceTable> {
    return this.createTable(name, columns);
  }

  async dropTable(name: string): Promise<void> {
    this.tables.delete(name);
  }

  hasTableDirectory(name: string): boolean {
    return this.tables.has(name);
  }

  createLegacyTable(name: string, rows: Array<Record<string, unknown>>): MemoryTable {
    const table = new MemoryTable(name, 64, [
      'embedding_id', 'resource_id', 'resource_type', 'folder_id', 'chunk_index',
      'text', 'metadata', 'created_at', 'embedding',
    ]);
    table.rows.push(...rows);
    this.tables.set(name, table);
    return table;
  }
}

function compileFilter(filter: string): (row: Record<string, unknown>) => boolean {
  if (filter === 'true') return () => true;
  const expressions = filter.split(' AND ');
  return (row) => expressions.every((expression) => evaluateExpression(row, expression.trim()));
}

function evaluateExpression(row: Record<string, unknown>, expression: string): boolean {
  const unitGroup = expression.match(/^\(unit_id = '((?:[^']|'')*)' OR unit_id = ''\)$/);
  if (unitGroup !== null) {
    const unit = unitGroup[1]!.replace(/''/g, "'");
    return row['unit_id'] === unit || row['unit_id'] === '';
  }
  const notIn = expression.match(/^embedding_id NOT IN \((.*)\)$/);
  if (notIn !== null) {
    const values = parseList(notIn[1]!);
    return !values.includes(String(row['embedding_id']));
  }
  const inMatch = expression.match(/^(\w+) IN \((.*)\)$/);
  if (inMatch !== null) return parseList(inMatch[2]!).includes(String(row[inMatch[1]!]));
  const equals = expression.match(/^(\w+) = '((?:[^']|'')*)'$/);
  if (equals !== null) return String(row[equals[1]!]) === equals[2]!.replace(/''/g, "'");
  throw new Error(`unsupported test filter: ${expression}`);
}

function parseList(source: string): string[] {
  const values: string[] = [];
  const pattern = /'((?:[^']|'')*)'/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) values.push(match[1]!.replace(/''/g, "'"));
  return values;
}

function toResult(row: Record<string, unknown>, score: number): VfsLanceSearchResult {
  const generation = row['generation'];
  return {
    embedding_id: String(row['embedding_id']),
    resource_id: String(row['resource_id']),
    unit_id: String(row['unit_id'] ?? ''),
    resource_type: String(row['resource_type']),
    folder_id: row['folder_id'] === null || row['folder_id'] === undefined ? null : String(row['folder_id']),
    chunk_index: Number(row['chunk_index']),
    text: String(row['text']),
    score,
    metadata_json: row['metadata'] === null || row['metadata'] === undefined ? null : String(row['metadata']),
    index_profile_id: String(row['index_profile_id'] ?? ''),
    generation: typeof generation === 'bigint' ? generation : Number(generation ?? 0),
    page_index: null,
    source_id: null,
  };
}

function cosine(left: readonly number[], right: readonly number[]): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / Math.sqrt(leftNorm * rightNorm);
}

interface Harness {
  db: DatabaseHandle;
  storage: ReturnType<typeof createStorageService>;
  connection: MemoryConnection;
  store: VfsLanceStore;
  dispose(): void;
}

const harnesses: Harness[] = [];

let templateDir: string;

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-lance-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('vfs migration failed');
  storage.dispose();
}, 180_000);

async function migratedDb(): Promise<Harness> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-lance-store-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  const db = storage.database('vfs');
  bindRealOwner(db);
  const connection = new MemoryConnection();
  const store = new VfsLanceStore(db, {
    basePath: path.join(base, 'lance', 'vfs'),
    adapter: { connect: async () => connection },
  });
  const harness: Harness = {
    db,
    storage,
    connection,
    store,
    dispose: () => {
      storage.dispose();
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (harnesses.length > 0) harnesses.pop()!.dispose();
});

it('Rust maybe_optimize_all uses Instant elapsed time rather than wall-clock changes', async () => {
  const { store } = await migratedDb();
  const optimize = vi.spyOn(store, 'optimizeAll');
  const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
  const wall = vi.spyOn(Date, 'now').mockReturnValue(1000);
  try {
    await store.maybeOptimizeAll();
    expect(optimize).toHaveBeenCalledTimes(2);
    wall.mockReturnValue(86400000);
    clock.mockReturnValue(1001);
    await store.maybeOptimizeAll();
    expect(optimize).toHaveBeenCalledTimes(2);
    wall.mockReturnValue(0);
    clock.mockReturnValue(1000 + 1800 * 1000);
    await store.maybeOptimizeAll();
    expect(optimize).toHaveBeenCalledTimes(4);
  } finally {
    clock.mockRestore();
    wall.mockRestore();
    optimize.mockRestore();
  }
});

function insertResourceUnit(
  db: DatabaseHandle,
  options: {
    resourceId: string;
    unitId: string;
    profileId: string;
    generation: number | bigint;
    indexState?: string;
    textState?: string;
  },
): void {
  const now = Date.now();
  db.run(
    `INSERT INTO resources
       (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
     VALUES (?1, ?2, 'note', 'inline', 'text', 0, ?3, ?4, ?4)`,
    [options.resourceId, `hash-${options.resourceId}`, options.indexState ?? 'pending', now],
  );
  db.run(
    `INSERT INTO vfs_index_units
       (id, resource_id, unit_index, text_content, text_required, text_state,
        text_profile_id, text_generation, created_at, updated_at)
     VALUES (?1, ?2, 0, 'text', 1, ?3, ?4, ?5, ?6, ?6)`,
    [
      options.unitId,
      options.resourceId,
      options.textState ?? 'indexed',
      options.profileId,
      options.generation,
      now,
    ],
  );
}

function makeRow(
  profileId: string,
  resourceId: string,
  unitId: string,
  embeddingId: string,
  generation: number | bigint,
): VfsLanceRow {
  return {
    embedding_id: embeddingId,
    resource_id: resourceId,
    unit_id: unitId,
    resource_type: 'note',
    folder_id: null,
    chunk_index: typeof generation === 'bigint' ? 0 : generation,
    text: `generation ${generation}`,
    metadata_json: null,
    created_at: new Date().toISOString(),
    index_profile_id: profileId,
    generation,
    embedding: new Array<number>(64).fill(0.25),
  };
}

it.each([9007199254740992n, 9223372036854775807n])('R12-09 public text indexResource preserves i64 %s through Lance, Unit and Segment writes', async (current) => {
  const { db, storage, connection } = await migratedDb();
  const owner = realOwner();
  const model = {
    id: 'generation-config', model: 'generation-model', baseUrl: 'https://example.test/v1',
    providerType: null, providerScope: null, apiProtocol: null, modelAdapter: 'openai',
  };
  const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage), 
    storage, vfsRepo: owner, vector: { connect: async () => connection },
    llmEmbeddingModels: { getEmbeddingModelConfig: async () => model },
    'embedding@1': { callEmbeddingApi: async (texts: string[]) => texts.map(() => new Array<number>(64).fill(0.25)) },
  } });
  try {
      const text = `Generation precision text with enough content for a complete chunk ${current}`;
      const resourceId = owner.resources.createOrReuse(db, 'note', text, null, null, null).resourceId;
      const unit = owner.embeddingUnits.create(db, {
        resourceId, unitIndex: 0, imageBlobHash: null, imageMimeType: null, textContent: text, textSource: 'native',
      });
      db.run('UPDATE vfs_index_units SET text_generation = ?1 WHERE id = ?2', [current, unit.id]);
      const expected = current === 9223372036854775807n ? current : current + 1n;
      expect(host.ctx.vfsIndex.lance.nextUnitGeneration(unit.id, 'text')).toBe(expected);
      expect(await host.ctx.vfsIndex.indexing.indexResource(resourceId)).toEqual([1, 64]);
      const unitGeneration = db.pluck(defineQuery<[string], bigint>(
        'SELECT text_generation FROM vfs_index_units WHERE id = ?1', { options: { safeIntegers: true } },
      ), [unit.id]);
      const segmentGeneration = db.pluck(defineQuery<[string], bigint>(
        'SELECT generation FROM vfs_index_segments WHERE unit_id = ?1', { options: { safeIntegers: true } },
      ), [unit.id]);
      expect(unitGeneration).toBe(expected);
      const rows = [...connection.tables.values()].flatMap((table) => table.rows)
        .filter((row) => row.unit_id === unit.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.generation).toBe(expected);
      expect(segmentGeneration).toBe(expected);
  } finally { await host.dispose(); }
});

async function bySourceHarness() {
  const { db, storage, connection } = await migratedDb();
  const owner = realOwner();
  const inputsSeen: MultimodalInput[][] = [];
  const model = {
    id: 'preview-config', model: 'Qwen/Qwen3-VL-Embedding-8B', baseUrl: 'https://api.siliconflow.cn/v1',
    providerType: 'siliconflow', providerScope: null, apiProtocol: null, modelAdapter: 'openai',
  };
  const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage), 
    storage, vfsRepo: owner, vector: { connect: async () => connection },
    llmEmbeddingModels: { getVlEmbeddingModelConfig: async () => model },
    'embedding@1': { callMultimodalEmbeddingApi: async (inputs: MultimodalInput[]) => {
      inputsSeen.push(inputs);
      return inputs.map(() => new Array<number>(64).fill(0.25));
    } },
  } });
  const logs: Array<{ level: string; message: string }> = [];
  host.ctx.logger.exporter({ levels: { default: 4 }, export(record) {
    logs.push({ level: record.type, message: record.args.map(String).join(' ') });
  } });
  const blob = owner.blobs.storeBlob(db, path.join(storage.locations.activeDir, 'vfs_blobs'),
    Buffer.from('original preview bytes'), 'image/png');
  const file = owner.files.createFileWithDocDataInFolder(db, 'wp222', 'preview.pdf', 22,
    'file', 'application/pdf', null, null, null, null, null, 1);
  const resourceId = file.resourceId!;
  return { db, owner, connection, host, inputsSeen, logs, blob, file, resourceId,
    setPreview: (text: string) => owner.files.updatePdfPreviewOnly(db, file.id, text),
    index: (sourceType = 'textbook') => host.ctx.vfsIndex.multimodal.indexResourceBySource(sourceType, file.id, null),
  };
}

describe('WP-222 D33 public by-source AttachmentPreview consumption', () => {
  it.each(['minimal snake', 'full camel', 'nullable map', 'short sequence', 'full sequence'])(
    'indexes %s through the real page conversion, Lance store and SQLite ledger', async (shape) => {
      const h = await bySourceHarness();
      try {
        const hash = h.blob.hash;
        const previews: Record<string, string> = {
          'minimal snake': `{"pages":[{"page_index":0,"blob_hash":"${hash}"}]}`,
          'full camel': `{"pages":[{"pageIndex":0,"blobHash":"${hash}","width":1,"height":1,"mimeType":"image/png","compressedBlobHash":"not-the-original"}],"renderDpi":150,"totalPages":1,"renderedAt":"recorded"}`,
          'nullable map': `{"pages":[{"page_index":0,"blobHash":"${hash}","width":null,"height":null,"mime_type":null,"compressed_blob_hash":null}],"dpi":null,"page_count":null,"rendered_at":null,"unknown":1e400}`,
          'short sequence': `[[[0,"${hash}"]]]`,
          'full sequence': `[[[0,"${hash}",null,null,null,null]],null,18446744073709551615,""]`,
        };
        h.setPreview(previews[shape]!);
        expect(await h.index()).toEqual({ indexed_pages: 1, dimension: 64, failed_pages: [] });
        expect(h.inputsSeen).toHaveLength(1);
        expect(h.inputsSeen[0]![0]!.image).toEqual({ kind: 'base64', data: Buffer.from('original preview bytes').toString('base64'), mediaType: 'image/png' });
        const units = h.owner.embeddingUnits.getByResource(h.db, h.resourceId);
        expect(units).toHaveLength(1);
        expect(units[0]).toMatchObject({ unitIndex: 0, imageBlobHash: hash, imageMimeType: 'image/png', mmState: 'indexed' });
        const segments = h.owner.embeddingSegments.getByUnitAndModality(h.db, units[0]!.id, 'multimodal');
        expect(segments).toHaveLength(1);
        const rows = [...h.connection.tables.values()].flatMap(table => table.rows);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ chunk_index: 0, unit_id: units[0]!.id, embedding_id: segments[0]!.lanceRowId });
        expect(h.db.pluck('SELECT mm_index_state FROM files WHERE id = ?1', [h.file.id])).toBe('indexed');
        expect(h.db.pluck('SELECT mm_index_state FROM resources WHERE id = ?1', [h.resourceId])).toBe('indexed');
      } finally { await h.host.dispose(); }
    },
  );

  it('preserves exact usize values until the i32 cast, including 2^53 neighbours', async () => {
    const h = await bySourceHarness();
    try {
      h.setPreview(`{"pages":[${['2147483648', '4294967295', '9007199254740992', '9007199254740993', '18446744073709551614'].map(
        value => `{"page_index":${value},"blob_hash":"${h.blob.hash}"}`).join(',')}],"page_count":18446744073709551615}`);
      expect(await h.index()).toEqual({ indexed_pages: 5, dimension: 64, failed_pages: [] });
      const rows = [...h.connection.tables.values()].flatMap(table => table.rows);
      expect(rows.map(row => row.chunk_index)).toEqual([-2147483648, -1, 0, 1, -2]);
      expect(h.owner.embeddingUnits.getByResource(h.db, h.resourceId).map(unit => unit.unitIndex).sort((a, b) => a - b))
        .toEqual([-2147483648, -2, -1, 0, 1]);
      const stored = JSON.parse(String(h.db.pluck('SELECT mm_indexed_pages_json FROM files WHERE id = ?1', [h.file.id])));
      expect(stored.map((page: { page_index: number }) => page.page_index)).toEqual([-2147483648, -1, 0, 1, -2]);
    } finally { await h.host.dispose(); }
  });

  it('indexes sequence usize::MAX as i32 minus one on a fresh resource', async () => {
    const h = await bySourceHarness();
    try {
      h.setPreview(`[[[18446744073709551615,"${h.blob.hash}"]]]`);
      expect(await h.index()).toEqual({ indexed_pages: 1, dimension: 64, failed_pages: [] });
      expect([...h.connection.tables.values()].flatMap(table => table.rows).map(row => row.chunk_index)).toEqual([-1]);
      expect(h.owner.embeddingUnits.getByResource(h.db, h.resourceId).map(unit => unit.unitIndex)).toEqual([-1]);
    } finally { await h.host.dispose(); }
  });

  it('skips absent/null blob hashes but sends Some empty hash into the real blob failure branch', async () => {
    const h = await bySourceHarness();
    try {
      h.setPreview(`{"pages":[{"page_index":0,"blob_hash":"${h.blob.hash}"}]}`);
      await h.index();
      h.setPreview('{"pages":[{"page_index":1},{"page_index":2,"blob_hash":null}]}');
      expect(await h.index()).toEqual({ indexed_pages: 0, dimension: 0, failed_pages: [] });
      expect(h.db.pluck('SELECT mm_index_state FROM files WHERE id = ?1', [h.file.id])).toBe('disabled');
      expect([...h.connection.tables.values()].flatMap(table => table.rows)).toEqual([]);
      expect(h.db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(0);
      expect(h.logs).toContainEqual({ level: 'warn', message: `[VfsMultimodalService] No pages found for resource ${h.file.id} (type=textbook)` });
      h.setPreview('{"pages":[{"page_index":7,"blob_hash":""}]}');
      await expect(h.index()).rejects.toThrow('多模态页面缺少可读取的原图或 blob_hash: [7]');
      expect(h.db.pluck('SELECT mm_index_state FROM files WHERE id = ?1', [h.file.id])).toBe('failed');
      expect(h.inputsSeen).toHaveLength(1);
      expect([...h.connection.tables.values()].flatMap(table => table.rows)).toEqual([]);
    } finally { await h.host.dispose(); }
  });

  it('keeps Some empty MIME through Unit sync and embedding input', async () => {
    const h = await bySourceHarness();
    try {
      h.setPreview(`{"pages":[{"pageIndex":0,"blobHash":"${h.blob.hash}","mimeType":""}]}`);
      expect(await h.index()).toEqual({ indexed_pages: 1, dimension: 64, failed_pages: [] });
      expect(h.inputsSeen[0]![0]!.image).toMatchObject({ kind: 'base64', mediaType: '' });
      expect(h.owner.embeddingUnits.getByResource(h.db, h.resourceId)[0]!.imageMimeType).toBe('');
    } finally { await h.host.dispose(); }
  });

  it('preserves serde first-error detail and position before any mm or index write', async () => {
    const h = await bySourceHarness();
    try {
      h.setPreview(`{"pages":[{"page_index":0,"blob_hash":"${h.blob.hash}"}]}`);
      await h.index();
      const cases: Array<[string, string, number, number]> = [
        ['{"pages":[]', 'EOF while parsing an object', 1, 11],
        ['{}', 'missing field `pages`', 1, 2],
        ['{"pages":[],"dpi":null,"renderDpi":?}', 'duplicate field `dpi`', 1, 34],
        ['{"pages":[{"page_index":0,"pageIndex":?}]}', 'duplicate field `page_index`', 1, 37],
        ['{"pages":[{"page_index":-1}],?', 'invalid value: integer `-1`, expected usize', 1, 26],
        ['{"pages":[{"page_index":1.0}]}', 'invalid type: floating point `1.0`, expected usize', 1, 27],
        ['{"pages":[{"page_index":-0}]}', 'invalid type: floating point `-0.0`, expected usize', 1, 26],
        ['{"pages":[{"page_index":18446744073709551616}]}', 'invalid type: floating point `1.8446744073709552e+19`, expected usize', 1, 44],
        ['[[[0]]]', 'invalid length 1, expected struct AttachmentPreviewPage with 6 elements', 1, 5],
        // serde_json de.rs:1078-1082 consumes the comma, then peek_error points at '?'.
        ['[[],null,null,null,?]', 'trailing characters', 1, 20],
        ['{\n"未知":"页","pages":[{"page_index":null}]}', 'invalid type: null, expected usize', 2, 42],
      ];
      for (const [text, code, line, column] of cases) {
        h.setPreview(text);
        const changes = h.db.pluck('SELECT total_changes()');
        const logStart = h.logs.length;
        const failure = await h.index().catch((error: unknown) => error);
        expect(failure, text).toBeInstanceOf(Error);
        if (!(failure instanceof Error)) throw new Error('expected preview failure');
        expect(failure.message, text).toBe(`Failed to parse preview_json: ${code} at line ${line} column ${column}`);
        expect(failure.cause).toBeInstanceOf(JsonSyntaxError);
        expect(failure.cause).toMatchObject({ code, line, column });
        expect(h.db.pluck('SELECT total_changes()'), text).toBe(changes);
        expect(h.logs.slice(logStart)).toEqual([{ level: 'info', message: `[VfsMultimodalService] index_resource_by_source: type=textbook, id=${h.file.id}` }]);
      }
      expect(h.inputsSeen).toHaveLength(1);
      expect([...h.connection.tables.values()].flatMap(table => table.rows)).toHaveLength(1);
      expect(h.db.pluck('SELECT COUNT(*) FROM vfs_index_segments')).toBe(1);
      expect(h.db.pluck('SELECT mm_index_state FROM files WHERE id = ?1', [h.file.id])).toBe('indexed');
    } finally { await h.host.dispose(); }
  });

  it('retains no-preview image fallback and missing-preview diagnostics', async () => {
    const h = await bySourceHarness();
    try {
      h.db.run('UPDATE files SET blob_hash = ?1, mime_type = NULL WHERE id = ?2', [h.blob.hash, h.file.id]);
      expect(await h.index('image')).toEqual({ indexed_pages: 1, dimension: 64, failed_pages: [] });
      expect(h.inputsSeen[0]![0]!.image).toMatchObject({ kind: 'base64', mediaType: 'image/png' });
      expect(h.logs).toContainEqual({ level: 'info', message: `[VfsMultimodalService] Image fallback: using blob_hash=${h.blob.hash} for single-page index` });
      h.db.run('UPDATE files SET blob_hash = NULL WHERE id = ?1', [h.file.id]);
      expect(await h.index('image')).toEqual({ indexed_pages: 0, dimension: 0, failed_pages: [] });
      expect(h.logs).toContainEqual({ level: 'warn', message: `[VfsMultimodalService] Image ${h.file.id} has no blob_hash, cannot index` });
      expect(h.logs).toContainEqual({ level: 'warn', message: `[VfsMultimodalService] No pages found for resource ${h.file.id} (type=image)` });
      expect(await h.index()).toEqual({ indexed_pages: 0, dimension: 0, failed_pages: [] });
      expect(h.logs).toContainEqual({ level: 'warn', message: `[VfsMultimodalService] Resource ${h.file.id} has no preview_json in business table` });
    } finally { await h.host.dispose(); }
  });
});

it('R12-09 public multimodal indexResourcePages preserves i64 generation in metadata and the owner ledger', async () => {
  const { db, storage, connection } = await migratedDb();
  const owner = realOwner();
  const model = {
    id: 'mm-generation-config', model: 'Qwen/Qwen3-VL-Embedding-8B', baseUrl: 'https://api.siliconflow.cn/v1',
    providerType: 'siliconflow', providerScope: null, apiProtocol: null, modelAdapter: 'openai',
  };
  const host = await createTestHost({ plugins: [plugin], provide: { files: testFiles(storage), 
    storage, vfsRepo: owner, vector: { connect: async () => connection },
    llmEmbeddingModels: { getVlEmbeddingModelConfig: async () => model },
    'embedding@1': { callMultimodalEmbeddingApi: async (inputs: unknown[]) => inputs.map(() => new Array<number>(64).fill(0.25)) },
  } });
  try {
    const resourceId = owner.resources.createOrReuse(db, 'image', 'large generation image', null, null, null).resourceId;
    const blob = owner.blobs.storeBlob(db, path.join(storage.locations.activeDir, 'vfs_blobs'),
      new TextEncoder().encode('external embedding transport image payload'), 'image/png');
    const unit = owner.embeddingUnits.create(db, {
      resourceId, unitIndex: 0, imageBlobHash: blob.hash, imageMimeType: 'image/png', textContent: null, textSource: null,
    });
    db.run('UPDATE vfs_index_units SET mm_generation = ?1 WHERE id = ?2', [9007199254740992n, unit.id]);
    expect(await host.ctx.vfsIndex.multimodal.indexResourcePages(resourceId, 'image', null, [{
      page_index: 0, blob_hash: blob.hash, image_base64: null, image_mime: 'image/png', text_content: null,
    }])).toEqual({ indexed_pages: 1, dimension: 64, failed_pages: [] });
    const expected = 9007199254740993n;
    expect(db.pluck(defineQuery<[string], bigint>(
      'SELECT mm_generation FROM vfs_index_units WHERE id = ?1', { options: { safeIntegers: true } },
    ), [unit.id])).toBe(expected);
    const segmentGeneration = db.pluck(defineQuery<[string], bigint>(
      "SELECT generation FROM vfs_index_segments WHERE unit_id = ?1 AND modality = 'multimodal'",
      { options: { safeIntegers: true } },
    ), [unit.id]);
    const rows = [...connection.tables.values()].flatMap((table) => table.rows).filter((row) => row.unit_id === unit.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.generation).toBe(expected);
    expect(rows[0]!.metadata).toContain('"generation":9007199254740993');
    expect(segmentGeneration).toBe(expected);
  } finally { await host.dispose(); }
});

describe('Rust vfs/lance_store.rs tests', () => {
  it('test_table_name', () => {
    expect(VfsLanceStore.tableName('text', 768)).toBe('vfs_emb_text_768');
    expect(VfsLanceStore.tableName('multimodal', 4096)).toBe('vfs_emb_multimodal_4096');
  });

  it('dimension_only_search_apis_reject_bare_vectors', async () => {
    const { store } = await migratedDb();
    const vector = await store
      .vectorSearchFull('text', new Array<number>(64).fill(0), 5)
      .catch((error: unknown) => error);
    expect(String(vector)).toContain('profile_id');
    const hybrid = await store
      .hybridSearchFull('text', 'query', new Array<number>(64).fill(0), 5)
      .catch((error: unknown) => error);
    expect(String(hybrid)).toContain('planner-owned');
  });

  it('stale_embedding_result_cannot_switch_the_writable_profile_back', async () => {
    const { db, store } = await migratedDb();
    const profileA = store.ensureModelProfile('text', 64, 'cfg-a', 'model-a');
    db.run("UPDATE vfs_embedding_dims SET record_count = 1 WHERE dimension = 64 AND modality = 'text'");
    registerWithModel(db, 64, 'text', 'cfg-b', 'model-b');
    const profileB = getActiveProfile(db, 64, 'text')!;
    expect(profileB.id).not.toBe(profileA.id);

    expect(() => store.ensureModelProfile('text', 64, 'cfg-a', 'model-a')).toThrow(/INVALID_STATE/);
    expect(getActiveProfile(db, 64, 'text')!.id).toBe(profileB.id);
  });

  it('legacy_profile_rolls_to_strong_fingerprint_without_a_query_gap', async () => {
    const { db, store } = await migratedDb();
    const legacy = store.ensureModelProfile('text', 64, 'cfg-legacy', 'Legacy display name');
    const now = Date.now();
    db.run(
      `UPDATE vfs_embedding_dims
       SET record_count = 1,
           model_fingerprint = 'legacy:model-config:cfg-legacy',
           model_name = 'Provider - model-real'
       WHERE dimension = 64 AND modality = 'text'`,
    );
    db.run(
      `UPDATE vfs_index_profiles
       SET model_fingerprint = 'legacy:model-config:cfg-legacy',
           model_name = 'Provider - model-real', ann_metric = 'legacy_l2'
       WHERE id = ?1`,
      [legacy.id],
    );
    insertResourceUnit(db, {
      resourceId: 'resource-legacy-roll',
      unitId: 'unit-legacy-roll',
      profileId: legacy.id,
      generation: 0,
      indexState: 'indexed',
    });
    db.run(
      `INSERT INTO vfs_index_segments
         (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
          index_profile_id, generation, created_at, updated_at)
       VALUES ('segment-legacy-roll', 'unit-legacy-roll', 0, 'text', 64,
               'embedding-legacy-roll', ?1, 0, ?2, ?2)`,
      [legacy.id, now],
    );

    const strongFingerprint = modelFingerprintWithTransport(
      'cfg-legacy',
      'model-real',
      'text-embedding-v1',
      {
        providerType: 'openai-compatible',
        providerScope: 'custom',
        baseUrl: 'https://example.com/v1',
        apiProtocol: 'openai',
        modelAdapter: 'openai',
      },
    );
    const strong = store.ensureModelProfileWithFingerprint(
      'text',
      64,
      'cfg-legacy',
      'model-real',
      strongFingerprint,
    );

    expect(strong.id).not.toBe(legacy.id);
    expect(strong.lance_table_name).not.toBe(legacy.lance_table_name);
    expect(strong.model_fingerprint).toBe(strongFingerprint);
    expect(strong.state).toBe('building');

    const oldProfile = getProfileById(db, legacy.id)!;
    expect([oldProfile.model_fingerprint, oldProfile.state])
      .toEqual(['legacy:model-config:cfg-legacy', 'queryable']);
    const binding = getByKey(db, 64, 'text')!;
    expect([binding.active_profile_id, binding.model_fingerprint])
      .toEqual([strong.id, strongFingerprint]);
    const pending = db.get(
      `SELECT u.text_state, u.text_profile_id, r.index_state
       FROM vfs_index_units u JOIN resources r ON r.id = u.resource_id
       WHERE u.id = 'unit-legacy-roll'`,
    )!;
    expect([pending['text_state'], pending['text_profile_id'], pending['index_state']])
      .toEqual(['pending', legacy.id, 'pending']);

    expect(() => store.ensureModelProfileWithFingerprint(
      'text',
      64,
      'cfg-legacy',
      'Provider - model-real',
      'legacy:model-config:cfg-legacy',
    )).toThrow(/INVALID_STATE/);
    expect(getByKey(db, 64, 'text')!.active_profile_id).toBe(strong.id);
  });

  it('legacy_upgrade_rejects_unbound_or_mismatched_config_profiles', async () => {
    const { db, store } = await migratedDb();
    const profile = store.ensureModelProfile('text', 64, 'cfg-bound', 'model-real');
    db.run(
      `UPDATE vfs_embedding_dims
       SET record_count = 1,
           model_fingerprint = 'legacy:unbound:text:64',
           model_config_id = 'cfg-bound'
       WHERE dimension = 64 AND modality = 'text'`,
    );
    db.run(
      `UPDATE vfs_index_profiles
       SET model_fingerprint = 'legacy:unbound:text:64', model_config_id = 'cfg-bound'
       WHERE id = ?1`,
      [profile.id],
    );
    expect(() => store.ensureModelProfile('text', 64, 'cfg-bound', 'model-real'))
      .toThrow(/INVALID_STATE/);

    db.run(
      `UPDATE vfs_embedding_dims
       SET model_fingerprint = 'legacy:model-config:cfg-bound', model_config_id = 'cfg-other'
       WHERE dimension = 64 AND modality = 'text'`,
    );
    db.run(
      `UPDATE vfs_index_profiles
       SET model_fingerprint = 'legacy:model-config:cfg-bound', model_config_id = 'cfg-other'
       WHERE id = ?1`,
      [profile.id],
    );
    expect(() => store.ensureModelProfile('text', 64, 'cfg-bound', 'model-real'))
      .toThrow(/INVALID_STATE/);
    expect(getByKey(db, 64, 'text')!.active_profile_id).toBe(profile.id);
  });

  it('test_build_filter_expr', () => {
    expect(VfsLanceStore.buildFilterExpr(null, null)).toBeNull();
    expect(VfsLanceStore.buildFilterExpr(['folder1'], null)).toBe("folder_id = 'folder1'");
    expect(VfsLanceStore.buildFilterExpr(['folder1', 'folder2'], null))
      .toBe("folder_id IN ('folder1', 'folder2')");
    expect(VfsLanceStore.buildFilterExpr(null, ['note'])).toBe("resource_type = 'note'");
    expect(VfsLanceStore.buildFilterExpr(['folder1'], ['note', 'textbook']))
      .toBe("folder_id = 'folder1' AND resource_type IN ('note', 'textbook')");
  });

  it('does not widen empty folder/resource/type scopes to all resources', () => {
    expect(VfsLanceStore.buildFilterExprFull({ folderIds: [] })).toBe('1 = 0');
    expect(VfsLanceStore.buildFilterExprFull({ resourceIds: [] })).toBe('1 = 0');
    expect(VfsLanceStore.buildFilterExprFull({ resourceTypes: [] })).toBe('1 = 0');
    expect(VfsLanceStore.buildFilterExprFull({ folderIds: [], mountedResourceIds: ['res_mounted'] }))
      .toBe("resource_id = 'res_mounted'");
  });

  it('legacy_cleanup_preserves_queryable_tables_and_retirement_sweep_retries', async () => {
    const { db, connection, store } = await migratedDb();
    const legacy = store.ensureModelProfile('text', 64, 'cfg-legacy-cleanup', 'legacy-model');
    db.run("UPDATE vfs_index_profiles SET state = 'queryable' WHERE id = ?1", [legacy.id]);
    connection.createLegacyTable(legacy.lance_table_name, [
      {
        embedding_id: 'legacy-orphan', resource_id: 'legacy-resource', resource_type: 'note',
        folder_id: null, chunk_index: 0, text: 'old chunk', metadata: null,
        created_at: '2026-01-01T00:00:00Z', embedding: new Array<number>(64).fill(0.2),
      },
      {
        embedding_id: 'legacy-still-live', resource_id: 'legacy-resource', resource_type: 'note',
        folder_id: null, chunk_index: 1, text: 'other old chunk', metadata: null,
        created_at: '2026-01-01T00:00:00Z', embedding: new Array<number>(64).fill(0.2),
      },
    ]);

    expect(await store.deleteByUnitExceptIds(
      'text',
      'legacy-resource',
      'unit-current',
      ['new-row'],
    )).toBe(0);
    expect(await connection.tables.get(legacy.lance_table_name)!.countRows()).toBe(2);

    const replacement = store.ensureModelProfile('text', 64, 'cfg-replacement', 'replacement-model');
    expect(replacement.id).not.toBe(legacy.id);
    expect(store.retiredProfileTableCandidates()).toContain(legacy.lance_table_name);

    await expect(store.sweepRetiredProfileTablesWithPreDrop((tableName) => {
      throw new Error(`simulated table occupancy for ${tableName}`);
    })).rejects.toThrow(/simulated table occupancy/);
    expect(await connection.tableNames()).toContain(legacy.lance_table_name);
    expect(store.retiredProfileTableCandidates()).toContain(legacy.lance_table_name);

    expect(await store.sweepRetiredProfileTables()).toBe(1);
    expect(await store.sweepRetiredProfileTables()).toBe(0);
    expect(await connection.tableNames()).not.toContain(legacy.lance_table_name);
    expect(getProfileById(db, legacy.id)!.state).toBe('retired');
  });

  it('delete_by_resource_except_dim_and_except_ids_preserve_requested_rows', async () => {
    const { db, connection, store } = await migratedDb();
    const profile64 = store.ensureModelProfile('text', 64, 'cfg-keep-64', 'model-keep-64');
    const profile128 = store.ensureModelProfile('text', 128, 'cfg-keep-128', 'model-keep-128');
    insertResourceUnit(db, {
      resourceId: 'resource-keep',
      unitId: 'unit-keep',
      profileId: profile64.id,
      generation: 1,
      indexState: 'pending',
      textState: 'indexed',
    });
    await store.writeChunks('text', [
      makeRow(profile64.id, 'resource-keep', 'unit-keep', 'emb-keep-a', 1),
      makeRow(profile64.id, 'resource-keep', 'unit-keep', 'emb-keep-b', 1),
      makeRow(profile64.id, 'resource-other', 'unit-other', 'emb-other', 1),
    ]);
    const row128 = {
      ...makeRow(profile128.id, 'resource-keep', 'unit-keep', 'emb-keep-128', 1),
      embedding: new Array<number>(128).fill(0.5),
    };
    await store.writeChunks('text', [row128]);

    expect(await store.deleteByResourceExceptDim('text', 'resource-keep', 64)).toBe(1);
    expect(await connection.tables.get(profile128.lance_table_name)!.countRows()).toBe(0);
    expect(await connection.tables.get(profile64.lance_table_name)!.countRows()).toBe(3);

    expect(await store.deleteByResourceExceptIds(
      'text', 'resource-keep', ['emb-keep-a'],
    )).toBe(2);
    const remaining = connection.tables.get(profile64.lance_table_name)!.rows;
    expect(remaining.map((row) => String(row['embedding_id'])).sort())
      .toEqual(['emb-keep-a', 'emb-other']);
  });

  it('clear_all_discovers_actual_tables_and_verifies_no_rows_remain', async () => {
    const { db, connection, store } = await migratedDb();
    const profile = store.ensureModelProfile('text', 64, 'cfg-clear', 'model-clear');
    insertResourceUnit(db, {
      resourceId: 'resource-clear',
      unitId: 'unit-clear',
      profileId: profile.id,
      generation: 1,
      indexState: 'pending',
      textState: 'indexing',
    });
    await store.writeChunks('text', [
      makeRow(profile.id, 'resource-clear', 'unit-clear', 'emb-clear', 1),
    ]);
    const table = connection.tables.get(profile.lance_table_name)!;
    expect(await table.countRows()).toBe(1);

    expect(await store.clearAll('text')).toBe(1);
    expect(await table.countRows()).toBe(0);
  });

  it('unit_generation_keeps_large_i64_exact_and_filters_adjacent_values', async () => {
    const { db, store } = await migratedDb();
    const profile = store.ensureModelProfile('text', 64, 'cfg-large-generation', 'model-large');
    const large = 9_007_199_254_740_993n; // 2^53 + 1
    const adjacent = 9_007_199_254_740_992n;
    insertResourceUnit(db, {
      resourceId: 'resource-large',
      unitId: 'unit-large',
      profileId: profile.id,
      generation: large,
      indexState: 'indexed',
    });
    await store.writeChunks('text', [
      makeRow(profile.id, 'resource-large', 'unit-large', 'emb-large', large),
      makeRow(profile.id, 'resource-large', 'unit-large', 'emb-adjacent', adjacent),
    ]);

    const results = await store.vectorSearchProfileFull(
      profile.id,
      new Array<number>(64).fill(0.25),
      10,
    );
    expect(results.map((result) => result.embedding_id)).toEqual(['emb-large']);
    expect(results[0]!.generation).toBe(large);
    expect(results[0]!.generation).not.toBe(adjacent);
  });

  it('tiny_legacy_profile_repairs_to_exact_and_unit_generation_is_authoritative', async () => {
    const { db, store } = await migratedDb();
    const profile = store.ensureModelProfile('text', 64, 'cfg-generation', 'model-generation');
    insertResourceUnit(db, {
      resourceId: 'resource-generation',
      unitId: 'unit-generation',
      profileId: profile.id,
      generation: 1,
      indexState: 'pending',
      textState: 'indexed',
    });
    await store.writeChunks('text', [
      makeRow(profile.id, 'resource-generation', 'unit-generation', 'emb-generation-1', 1),
      makeRow(profile.id, 'resource-generation', 'unit-generation', 'emb-generation-2', 2),
    ]);
    db.run(
      "UPDATE vfs_index_profiles SET ann_metric = 'legacy_l2', ann_index_version = 0 WHERE id = ?1",
      [profile.id],
    );
    store.forgetEnsuredTable(profile.lance_table_name);
    await store.ensureProfileReady(profile.id);
    const repaired = getProfileById(db, profile.id)!;
    expect(repaired.ann_metric).toBe('exact');
    expect(repaired.ann_index_version).toBe(1);
    expect(store.isTableEnsured(profile.lance_table_name)).toBe(true);
    await store.ensureProfileReady(profile.id);

    const generationOne = await store.vectorSearchProfileFull(
      profile.id,
      new Array<number>(64).fill(0.25),
      10,
    );
    expect(generationOne).toHaveLength(1);
    expect(generationOne[0]!.embedding_id).toBe('emb-generation-1');

    db.run(
      `UPDATE vfs_index_units SET text_generation = 2 WHERE id = 'unit-generation'`,
    );
    const generationTwo = await store.vectorSearchProfileFull(
      profile.id,
      new Array<number>(64).fill(0.25),
      10,
    );
    expect(generationTwo).toHaveLength(1);
    expect(generationTwo[0]!.embedding_id).toBe('emb-generation-2');
  });

  it('stats_skip_open_table_failures_and_diagnostics_pad_null_samples', async () => {
    const { db, connection, store } = await migratedDb();
    db.run(
      `INSERT INTO vfs_embedding_dims
         (dimension, modality, lance_table_name, record_count, created_at, last_used_at)
       VALUES (64, 'text', 'vfs_emb_text_64', 0, 0, 0),
              (128, 'text', 'vfs_emb_text_128', 0, 0, 0)`,
    );
    const broken = new MemoryTable('vfs_emb_text_64', 64);
    const healthy = new MemoryTable('vfs_emb_text_128', 128);
    broken.rows.push(...Array.from({ length: 3 }, (_, index) => ({
      embedding_id: `emb-broken-${index}`,
      resource_id: 'resource-broken',
      unit_id: 'unit-broken',
      resource_type: 'note',
      folder_id: null,
      chunk_index: index,
      text: 'broken',
      metadata: null,
      created_at: '2026-01-01T00:00:00Z',
      index_profile_id: 'profile-broken',
      generation: 1,
      embedding: new Array<number>(64).fill(0.1),
    })));
    healthy.rows.push({
      embedding_id: 'emb-healthy',
      resource_id: 'resource-healthy',
      unit_id: 'unit-healthy',
      resource_type: 'note',
      folder_id: null,
      chunk_index: 0,
      text: 'healthy',
      metadata: null,
      created_at: '2026-01-01T00:00:00Z',
      index_profile_id: 'profile-healthy',
      generation: 1,
      embedding: new Array<number>(128).fill(0.1),
    });
    connection.tables.set(broken.tableName, broken);
    connection.tables.set(healthy.tableName, healthy);
    const originalOpen = connection.openTable.bind(connection);
    connection.openTable = async (name: string): Promise<LanceTable | null> => {
      if (name === broken.tableName) throw new Error('open failed');
      return originalOpen(name);
    };

    expect(await store.getTableStats('text')).toEqual([['vfs_emb_text_128', 1]]);

    const diagnostics = await store.diagnoseTableSchema('text');
    const health = diagnostics.find((entry) => entry.tableName === healthy.tableName)!;
    expect(health.sampleMetadata).toEqual([null]);
    expect(health.metadataNullCount).toBe(1);
    expect(diagnostics.some((entry) => entry.tableName === broken.tableName)).toBe(false);
  });
});
