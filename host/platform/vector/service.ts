import { statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import * as lance from '@lancedb/lancedb';
import { Bool, DataType, Field, FixedSizeList, Float32, Float64, Int32, Int64, Schema, Utf8 } from 'apache-arrow';
import type { VectorColumn, VectorConnection, VectorRow, VectorService, VectorTable, VectorValue } from './api.ts';

function schema(columns: readonly VectorColumn[]): Schema {
  return new Schema(columns.map(column => {
    const type = column.type === 'vector' ? new FixedSizeList(column.dimension!, new Field('item', new Float32(), false))
      : ({ utf8: new Utf8(), float32: new Float32(), float64: new Float64(), int32: new Int32(), int64: new Int64(), bool: new Bool() })[column.type];
    return new Field(column.name, type, column.nullable);
  }));
}

function rows(values: Array<Record<string, unknown>>): VectorRow[] {
  return values.map(value => Object.fromEntries(Object.entries(value).map(([key, raw]) => {
    const output = raw !== null && typeof raw === 'object' && 'toArray' in raw && typeof raw.toArray === 'function'
      ? Array.from(raw.toArray() as ArrayLike<number>) : raw;
    return [key, output as VectorValue];
  })));
}

function tableAdapter(table: lance.Table): VectorTable {
  return {
    async add(rows) {
      // The JS Arrow conversion silently coerces short/long arrays to the fixed
      // list size. Rust callers build a validated, explicitly sized RecordBatch;
      // reject before this lossy conversion rather than persisting padded data.
      const current = await table.schema();
      for (const field of current.fields) {
        if (!DataType.isFixedSizeList(field.type)) continue;
        for (const row of rows) {
          const value = row[field.name];
          if (Array.isArray(value) && value.length !== field.type.listSize) {
            throw new RangeError(`Vector column '${field.name}' dimension mismatch: expected ${field.type.listSize}, got ${value.length}`);
          }
        }
      }
      await table.add(rows, { mode: 'append' });
    },
    async delete(predicate) { await table.delete(predicate); },
    countRows: predicate => table.countRows(predicate),
    async schema() {
      const result = await table.schema();
      return { fields: result.fields.map(field => ({ name: field.name, type: field.type.toString(), nullable: field.nullable })) };
    },
    async addColumns(expressions) {
      await table.addColumns(expressions.map(([name, valueSql]) => ({ name, valueSql })));
    },
    async query(options) {
      const query = table.query();
      if (options.filter !== undefined) query.where(options.filter);
      if (options.columns !== undefined) query.select(options.columns);
      if (options.limit !== undefined) query.limit(options.limit);
      return rows(await query.toArray());
    },
    async search(vector, options) {
      const query = table.vectorSearch(vector).column(options.column).distanceType(options.metric).limit(options.limit);
      if (options.filter !== undefined) query.where(options.filter);
      if (options.columns !== undefined) query.select(options.columns);
      if (options.bypassVectorIndex === true) query.bypassVectorIndex();
      if (options.refineFactor !== undefined) query.refineFactor(options.refineFactor);
      return rows(await query.toArray());
    },
    async fullTextSearch(text, options) {
      const query = table.search(text, 'fts').limit(options.limit);
      if (options.filter !== undefined) query.where(options.filter);
      if (options.columns !== undefined) query.select(options.columns);
      return rows(await query.toArray());
    },
    async createIndex(columns, kind) {
      if (!['bitmap', 'btree', 'cosine-ivf-pq', 'fts-ngram'].includes(kind)) throw new Error(`Unknown Lance index kind: ${kind}`);
      const config = kind === 'bitmap' ? lance.Index.bitmap() : kind === 'btree' ? lance.Index.btree()
        : kind === 'cosine-ivf-pq' ? lance.Index.ivfPq({ distanceType: 'cosine' })
          : lance.Index.fts({ baseTokenizer: 'ngram', ngramMinLength: 2, ngramMaxLength: 4, prefixOnly: false,
            maxTokenLength: 64, lowercase: true, stem: false, removeStopWords: false, asciiFolding: true });
      // Rust calls create_index with one column at each call site, replace(false).
      if (columns.length !== 1) throw new Error('Lance index requires exactly one column');
      await table.createIndex(columns[0]!, { config, replace: false });
    },
    async optimizeAll(options) {
      await table.optimize({
        ...(options?.olderThanDays === undefined ? {} : { cleanupOlderThan: new Date(Date.now() - options.olderThanDays * 86_400_000) }),
        ...(options?.deleteUnverified === undefined ? {} : { deleteUnverified: options.deleteUnverified }),
      });
    },
  };
}

export function createVectorService(): VectorService & { dispose(): void } {
  const connections = new Map<string, Promise<VectorConnection>>();
  const live = new Set<lance.Connection>();
  return {
    async connect(path) {
      const location = resolve(path);
      let pending = connections.get(location);
      if (pending === undefined) {
        pending = lance.connect(location).then(connection => {
          live.add(connection);
          return {
            tableNames: () => connection.tableNames(),
            openTable: async name => tableAdapter(await connection.openTable(name)),
            createTableWithSchema: async (name: string, columns: readonly VectorColumn[]) => tableAdapter(await connection.createEmptyTable(name, schema(columns), {
              storageOptions: { new_table_data_storage_version: '2.0' },
            })),
            dropTable: name => connection.dropTable(name),
            hasTableDirectory(name) {
              try { return statSync(join(location, `${name}.lance`)).isDirectory(); }
              catch (error) { return false; } // Rust Path::is_dir returns false on IO errors.
            },
            close() { connection.close(); live.delete(connection); connections.delete(location); },
          } satisfies VectorConnection;
        }).catch((error: unknown) => { connections.delete(location); throw error; });
        connections.set(location, pending);
      }
      return pending;
    },
    dispose() { for (const connection of live) connection.close(); live.clear(); connections.clear(); },
  };
}
