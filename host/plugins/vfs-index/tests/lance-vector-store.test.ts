import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createStorageService } from '../../../platform/storage/service.ts';
import type { LanceConnection, LanceEngineService, LanceSearchRequest, LanceTable, LanceTableSchema, LanceVectorColumn } from '../api.ts';
import { LegacyKbStore } from '../src/legacy-kb-store.ts';
import { ChatLanceStore } from '../src/chat-embeddings.ts';
import { testFiles } from './support/files.ts';

class MemoryKbTable implements LanceTable {
  readonly rows: Array<Record<string, unknown>> = [];
  readonly indexCalls: Array<{ columns: readonly string[]; kind: string }> = [];
  readonly tableName: string;

  constructor(tableName: string) {
    this.tableName = tableName;
  }

  async countRows(): Promise<number> { return this.rows.length; }
  async schema(): Promise<LanceTableSchema> {
    return {
      fields: ['chunk_id', 'document_id', 'sub_library_id', 'chunk_index', 'text', 'metadata', 'created_at', 'embedding']
        .map((name) => ({ name })),
    };
  }
  async addColumns(): Promise<void> {}
  async createIndex(columns: readonly string[], kind: string): Promise<void> {
    this.indexCalls.push({ columns, kind });
  }
  async add(rows: readonly Readonly<Record<string, unknown>>[]): Promise<void> {
    this.rows.push(...rows.map((row) => ({ ...row })));
  }
  async delete(filter: string): Promise<void> {
    if (filter === 'true') {
      this.rows.length = 0;
      return;
    }
    const match = filter.match(/^chunk_id IN \((.*)\)$/);
    if (match === null) throw new Error(`unsupported filter: ${filter}`);
    const ids = new Set(
      [...match[1]!.matchAll(/'((?:[^']|'')*)'/g)].map((entry) => entry[1]!.replace(/''/g, "'")),
    );
    for (let index = this.rows.length - 1; index >= 0; index -= 1) {
      if (ids.has(String(this.rows[index]!['chunk_id']))) this.rows.splice(index, 1);
    }
  }
  async optimize(): Promise<void> {}
  async vectorSearch(_request: LanceSearchRequest): Promise<never[]> { return []; }
  async ftsSearch(_request: LanceSearchRequest): Promise<never[]> { return []; }
}

class MemoryKbConnection implements LanceConnection {
  readonly tables = new Map<string, MemoryKbTable>();
  readonly createdColumns = new Map<string, readonly LanceVectorColumn[]>();
  async tableNames(): Promise<string[]> { return [...this.tables.keys()]; }
  async openTable(name: string): Promise<LanceTable | null> { return this.tables.get(name) ?? null; }
  async createTable(
    name: string,
    columns: readonly LanceVectorColumn[],
  ): Promise<LanceTable> {
    this.createdColumns.set(name, columns);
    const table = new MemoryKbTable(name);
    this.tables.set(name, table);
    return table;
  }
  async dropTable(name: string): Promise<void> { this.tables.delete(name); }
  hasTableDirectory(name: string): boolean { return this.tables.has(name); }
}

class MemoryKbEngine implements LanceEngineService {
  readonly connection = new MemoryKbConnection();
  async connect(): Promise<LanceConnection> { return this.connection; }
}

const storages: Array<ReturnType<typeof createStorageService>> = [];
const dirs: string[] = [];
let templateDir: string;

beforeAll(async () => {
  templateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-kb-template-'));
  const storage = createStorageService({
    baseDir: templateDir,
    dataLocalDir: path.join(templateDir, 'local'),
  });
  const report = await storage.migrations.runAll();
  if (!report.success) throw new Error('migration failed');
  storage.dispose();
}, 180_000);

function migratedStorage(): ReturnType<typeof createStorageService> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vfs-kb-'));
  fs.cpSync(templateDir, base, { recursive: true });
  const storage = createStorageService({ baseDir: base, dataLocalDir: path.join(base, 'local') });
  dirs.push(base);
  storages.push(storage);
  return storage;
}

afterEach(() => {
  while (storages.length > 0) storages.pop()!.dispose();
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('Rust lance_vector_store.rs tests', () => {
  it('parse_dim_from_table_name_accepts_any_dim_and_rejects_others', () => {
    const prefix = 'kb_chunks_v2_d';
    expect(ChatLanceStore.parseDimFromTableName('kb_chunks_v2_d1024', prefix)).toBe(1024);
    expect(ChatLanceStore.parseDimFromTableName('kb_chunks_v2_d1792', prefix)).toBe(1792);
    expect(ChatLanceStore.parseDimFromTableName('kb_chunks_v2_d2560', prefix)).toBe(2560);
    expect(ChatLanceStore.parseDimFromTableName('chat_embeddings_v2_d1024', prefix)).toBeNull();
    expect(ChatLanceStore.parseDimFromTableName('kb_chunks_v2_dabc', prefix)).toBeNull();
    expect(ChatLanceStore.parseDimFromTableName('unrelated_table', prefix)).toBeNull();
  });

  it('rows_to_retrieved_input_dedup_semantics', () => {
    const deduped = LegacyKbStore.dedupeRowsByChunkId([
      ['c1', 0.5],
      ['c1', 0.9],
      ['c2', 0.7],
    ]);
    expect(deduped).toEqual([
      ['c1', 0.9],
      ['c2', 0.7],
    ]);
  });

  it('clear_all_success_means_sqlite_and_every_lance_table_are_empty', async () => {
    const storage = migratedStorage();
    const engine = new MemoryKbEngine();
    const store = LegacyKbStore.create(storage.database('mistakes'), engine, () => testFiles(storage));
    store.addDocumentRecordWithLibrary('doc-clear', 'clear.txt', null, null, 'default');
    await store.addChunks([{
      chunk: {
        id: 'chunk-clear',
        document_id: 'doc-clear',
        chunk_index: 0,
        text: 'vector that must be removed',
        metadata: {},
      },
      // Deliberately non-candidate dimension.
      embedding: [0.1, 0.2, 0.3],
    }]);
    const table = engine.connection.tables.get('kb_chunks_v2_d3')!;
    expect(engine.connection.createdColumns.get('kb_chunks_v2_d3')?.map((column) => column.name))
      .toEqual([
        'chunk_id', 'document_id', 'sub_library_id', 'chunk_index',
        'text', 'metadata', 'created_at', 'embedding',
      ]);
    expect(engine.connection.createdColumns.get('kb_chunks_v2_d3')?.at(-1)).toMatchObject({
      type: 'vector', dimension: 3, nullable: false,
    });
    expect(table.indexCalls).toContainEqual({ columns: ['text'], kind: 'fts-ngram' });
    expect(table.indexCalls).toContainEqual({ columns: ['chunk_id'], kind: 'btree' });
    expect(table.indexCalls.some((call) => call.kind === 'cosine-ivf-pq')).toBe(false);
    expect(await table.countRows()).toBe(1);

    await store.clearAll();
    expect(await table.countRows()).toBe(0);
    const db = storage.database('mistakes');
    for (const name of ['rag_vectors', 'rag_document_chunks', 'rag_documents']) {
      const exists = Number(db.pluck<number>(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
      )) !== 0;
      if (!exists) {
        expect(name).toBe('rag_vectors');
        continue;
      }
      expect(db.pluck(`SELECT COUNT(*) FROM ${name}`)).toBe(0);
    }
  });
});
