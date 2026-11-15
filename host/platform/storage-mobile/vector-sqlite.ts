/** OPFS-backed vector tables for Web Workers, using the existing SQLite WASM runtime. */
import type { DatabaseHandle, Row, SqlParam, SqlValue, StorageService } from '../storage/api.ts';
import { defineQuery } from '../storage/query.ts';
import { posix } from '../util/path.ts';
import type { VectorColumn, VectorConnection, VectorService, VectorTable, VectorValue } from '../vector/api.ts';

const schemaTable = 'mobile_vector_schema';
const schemaQuery = defineQuery<readonly [string], { columns: string }>(
  `SELECT columns FROM ${schemaTable} WHERE name = ?`,
);
const row = (sql: string) => defineQuery<readonly SqlParam[], Row>(sql, { options: { safeIntegers: true } });

function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(value)) throw new Error(`Invalid vector identifier: ${value}`);
  return `"${value}"`;
}

const sqlTypes = { utf8: 'TEXT', float32: 'REAL', float64: 'REAL', int32: 'INTEGER', int64: 'INTEGER', bool: 'INTEGER', vector: 'BLOB' };
const schemaTypes = { utf8: 'Utf8', float32: 'Float32', float64: 'Float64', int32: 'Int32', int64: 'Int64', bool: 'Bool', vector: 'Float32' };

function columnSql(column: VectorColumn): string {
  if (column.type === 'vector' && (!Number.isSafeInteger(column.dimension) || (column.dimension ?? 0) <= 0)) {
    throw new Error(`Invalid vector dimension for ${column.name}`);
  }
  return `${identifier(column.name)} ${sqlTypes[column.type]}${column.nullable ? '' : ' NOT NULL'}`;
}

function invalidColumn(column: VectorColumn): never {
  throw new TypeError(`Invalid ${column.type} value for ${column.name}`);
}

function toFloat32(value: number[], column: VectorColumn): Float32Array {
  if (!Array.isArray(value) || value.length !== column.dimension || !value.every(Number.isFinite)) return invalidColumn(column);
  const data = Float32Array.from(value);
  if (!data.every(Number.isFinite)) return invalidColumn(column);
  return data;
}

function encode(value: VectorValue | undefined, column: VectorColumn): SqlParam {
  if (value === undefined || value === null) return column.nullable ? null : invalidColumn(column);
  switch (column.type) {
    case 'vector': if (Array.isArray(value)) return new Uint8Array(toFloat32(value, column).buffer); break;
    case 'utf8': if (typeof value === 'string') return value; break;
    case 'bool': if (typeof value === 'boolean') return value; break;
    case 'int32': if (typeof value === 'number' && (value | 0) === value) return value; break;
    case 'int64': {
      if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
      if (typeof value === 'bigint' && BigInt.asIntN(64, value) === value) return value;
      break;
    }
    case 'float32': if (typeof value === 'number' && Number.isFinite(Math.fround(value))) return Math.fround(value); break;
    case 'float64': if (typeof value === 'number' && Number.isFinite(value)) return value; break;
  }
  return invalidColumn(column);
}

function floatView(value: SqlValue | undefined, column: VectorColumn): Float32Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== (column.dimension ?? 0) * 4) return invalidColumn(column);
  return value.byteOffset % 4 === 0
    ? new Float32Array(value.buffer, value.byteOffset, value.byteLength / 4)
    : new Float32Array(Uint8Array.from(value).buffer);
}

function decode(value: SqlValue | undefined, column: VectorColumn): VectorValue {
  if (value === null) return null;
  if (column.type === 'vector') return Array.from(floatView(value, column));
  if (column.type === 'bool') return value === 1 || value === 1n;
  if (column.type === 'int64') return typeof value === 'bigint' ? value : BigInt(Number(value));
  if (column.type === 'utf8') return String(value);
  return Number(value);
}

// Filters are SQL expressions supplied by first-party repositories, just like the Lance boundary.
const where = (filter?: string) => filter === undefined || filter === '' ? '' : ` WHERE (${filter})`;
const limit = (n: number | undefined) => {
  if (n === undefined) return '';
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('Vector result limit must be a non-negative integer');
  return ` LIMIT ${n}`;
};

function distance(a: Float32Array, b: Float32Array, metric: 'cosine' | 'l2' | 'dot', magnitude: number): number {
  let dot = 0; let norm = 0; let squared = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!; const y = b[i]!;
    if (metric === 'l2') squared += (x - y) ** 2;
    else { dot += x * y; norm += y * y; }
  }
  if (metric === 'l2') return squared;
  if (metric === 'dot') return -dot;
  return norm === 0 || magnitude === 0 ? 1 : 1 - Math.max(-1, Math.min(1, dot / Math.sqrt(magnitude * norm)));
}

function table(db: DatabaseHandle, name: string): VectorTable {
  const sqlName = identifier(`vec_${name}`);
  const fts = identifier(`vecfts_${name}`);
  const columns = (): VectorColumn[] => {
    const value = db.get(schemaQuery, [name]);
    if (value === undefined) throw new Error(`Vector table not found: ${name}`);
    return JSON.parse(value.columns) as VectorColumn[];
  };
  const select = (names?: readonly string[]) => {
    const schema = columns();
    return names === undefined ? schema : names.map((name) => {
      const column = schema.find(candidate => candidate.name === name);
      if (!column) throw new Error(`Unknown vector column: ${name}`);
      return column;
    });
  };
  const project = (result: Row, picked: VectorColumn[]) => Object.fromEntries(
    picked.map(column => [column.name, decode(result[column.name], column)]),
  );
  const columnList = (picked: VectorColumn[]) => picked.map(column => identifier(column.name)).join(', ');

  return {
    async add(rows) {
      if (rows.length === 0) return;
      await db.write(tx => {
        const schema = columns();
        const insert = `INSERT INTO ${sqlName} (${columnList(schema)}) VALUES (${schema.map(() => '?').join(', ')})`;
        for (const input of rows) tx.run(insert, schema.map(column => encode(input[column.name], column)));
      });
    },
    async delete(predicate) {
      // Prepare a single statement. A predicate is never passed to a multi-statement executor.
      await db.write(tx => tx.run(`DELETE FROM ${sqlName}${where(predicate)}`));
    },
    async countRows(predicate) { return Number(db.pluck(`SELECT count(*) FROM ${sqlName}${where(predicate)}`)); },
    async query(options) {
      const picked = select(options.columns);
      return db.all(row(`SELECT ${columnList(picked) || 'rowid'} FROM ${sqlName}${where(options.filter)}${limit(options.limit)}`), [])
        .map(result => project(result, picked));
    },
    async search(vector, options) {
      limit(options.limit);
      const [column] = select([options.column]);
      if (column?.type !== 'vector') throw new Error(`Not a vector column: ${options.column}`);
      const query = toFloat32(vector, column);
      if (options.limit === 0) return [];
      const picked = select(options.columns);
      const norm = query.reduce((sum, value) => sum + value * value, 0);
      const field = identifier(column.name);
      // Load only row IDs and embeddings during the scan. Keep O(limit) results and fetch payloads after ranking.
      const ranked: { id: SqlParam; distance: number }[] = [];
      for (const result of db.iterate(row(`SELECT rowid, ${field} FROM ${sqlName}${where(options.filter)}`), [])) {
        if (result[column.name] === null) continue;
        const score = distance(query, floatView(result[column.name], column), options.metric, norm);
        if (ranked.length === options.limit && score >= ranked[ranked.length - 1]!.distance) continue;
        let lo = 0; let hi = ranked.length;
        while (lo < hi) {
          const mid = (lo + hi) >>> 1;
          if (ranked[mid]!.distance <= score) lo = mid + 1;
          else hi = mid;
        }
        ranked.splice(lo, 0, { id: result.rowid!, distance: score });
        if (ranked.length > options.limit) ranked.pop();
      }
      const get = row(`SELECT ${columnList(picked) || 'rowid'} FROM ${sqlName} WHERE rowid = ?`);
      return ranked.map(item => ({ ...project(db.one(get, [item.id]), picked), _distance: item.distance }));
    },
    async schema() {
      return { fields: columns().map(column => ({ name: column.name, nullable: column.nullable,
        type: column.type === 'vector' ? `FixedSizeList[${column.dimension}]<Float32>` : schemaTypes[column.type],
      })) };
    },
    async addColumns(expressions) {
      await db.write(tx => {
        const schema = columns();
        for (const [name, expression] of expressions) {
          // The lifecycle owner supplies SQL text literals and CAST(0 AS BIGINT) defaults.
          const value = tx.one(row(`SELECT (${expression}) AS value`), []).value;
          const column: VectorColumn = { name, nullable: value === null, type: typeof value === 'string' || value === null ? 'utf8'
            : typeof value === 'bigint' ? 'int64' : 'float64' };
          const literal = value === null ? 'NULL' : typeof value === 'string' ? `'${value.replaceAll("'", "''")}'` : String(value);
          tx.run(`ALTER TABLE ${sqlName} ADD COLUMN ${columnSql(column)} DEFAULT ${literal}`);
          schema.push(column);
        }
        tx.run(`UPDATE ${schemaTable} SET columns = ? WHERE name = ?`, [JSON.stringify(schema), name]);
      });
    },
    async createIndex(names, kind) {
      const picked = select(names);
      if (kind === 'fts-ngram' && names.length === 1 && names[0] === 'text' && picked[0]?.type === 'utf8') {
        await db.write(tx => {
          if (tx.pluck('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?', ['table', `vecfts_${name}`])) return;
          // External-content FTS stores only the terms; all writes/deletes update it in the same transaction.
          tx.exec(`CREATE VIRTUAL TABLE ${fts} USING fts5(text, content = 'vec_${name}', tokenize = 'trigram');
            CREATE TRIGGER ${identifier(`vecfts_${name}_insert`)} AFTER INSERT ON ${sqlName} BEGIN
              INSERT INTO ${fts}(rowid, text) VALUES (new.rowid, new.text); END;
            CREATE TRIGGER ${identifier(`vecfts_${name}_delete`)} AFTER DELETE ON ${sqlName} BEGIN
              INSERT INTO ${fts}(${fts}, rowid, text) VALUES ('delete', old.rowid, old.text); END;
            INSERT INTO ${fts}(${fts}) VALUES ('rebuild');`);
        });
      } else if ((kind === 'btree' || kind === 'bitmap') && names.length > 0) {
        await db.write(tx => tx.run(`CREATE INDEX IF NOT EXISTS ${identifier(`vecidx_${name}_${names.join('_')}`)} ON ${sqlName} (${columnList(picked)})`));
      } else throw new Error(`Vector index kind is unavailable on mobile: ${kind}`);
    },
    async fullTextSearch(text, options) {
      if (text.trim() === '') return [];
      select(['text']);
      const picked = select(options.columns);
      // Trigrams cannot find one- and two-character queries, including many Chinese search terms.
      const indexed = [...text].length >= 3 && db.pluck('SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?', ['table', `vecfts_${name}`]);
      const predicate = indexed ? `rowid IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ?)` : 'instr(lower(text), lower(?)) > 0';
      const filter = `${predicate}${options.filter ? ` AND (${options.filter})` : ''}`;
      const query = row(`SELECT ${columnList(picked) || 'rowid'} FROM ${sqlName}${where(filter)} ORDER BY rowid${limit(options.limit)}`);
      const input = indexed ? `"${text.replaceAll('"', '""')}"` : text;
      return db.all(query, [input]).map(result => ({ ...project(result, picked), _score: 1 }));
    },
    async optimizeAll() { await db.write(tx => tx.exec('PRAGMA optimize')); },
  };
}

function connection(db: DatabaseHandle, close: () => void): VectorConnection {
  db.exec(`CREATE TABLE IF NOT EXISTS ${schemaTable} (name TEXT PRIMARY KEY, columns TEXT NOT NULL) WITHOUT ROWID`);
  const exists = (name: string) => db.get(schemaQuery, [name]) !== undefined;
  return {
    supportsApproximateSearch: false,
    async tableNames() { return db.all<{ name: string }>(`SELECT name FROM ${schemaTable} ORDER BY name`).map(entry => entry.name); },
    hasTableDirectory: exists,
    async openTable(name) {
      if (!exists(name)) throw new Error(`Vector table not found: ${name}`);
      return table(db, name);
    },
    async createTableWithSchema(name, columns) {
      const declaration = columns.map(columnSql).join(', ');
      const sqlName = identifier(`vec_${name}`);
      await db.write(tx => {
        const current = tx.get(schemaQuery, [name]);
        if (current !== undefined) {
          if (current.columns !== JSON.stringify(columns)) throw new Error(`Vector schema mismatch for ${name}`);
          return;
        }
        tx.run(`CREATE TABLE ${sqlName} (${declaration})`);
        tx.run(`INSERT INTO ${schemaTable} (name, columns) VALUES (?, ?)`, [name, JSON.stringify(columns)]);
      });
      return table(db, name);
    },
    async dropTable(name) {
      await db.write(tx => {
        tx.run(`DROP TABLE IF EXISTS ${identifier(`vec_${name}`)}`);
        tx.run(`DROP TABLE IF EXISTS ${identifier(`vecfts_${name}`)}`);
        tx.run(`DELETE FROM ${schemaTable} WHERE name = ?`, [name]);
      });
    },
    close,
  };
}

export function createMobileVector(storage: Pick<StorageService, 'database' | 'openFile' | 'close'>): VectorService & { dispose(): void } {
  const connections = new Map<string, VectorConnection>();
  return {
    async connect(path, owner) {
      if (owner !== undefined) {
        // Use the registered handle for the metadata owner. A snapshot of that database then
        // restores its matching vectors, including re-indexed generations, on a replacement device.
        const cached = connections.get(owner);
        if (cached !== undefined) return cached;
        const opened = connection(storage.database(owner), () => { connections.delete(owner); });
        connections.set(owner, opened);
        return opened;
      }
      const file = posix.resolve('/', path, 'vectors.sqlite');
      const cached = connections.get(file);
      if (cached !== undefined) return cached;
      const db = storage.openFile(file);
      try {
        const opened = connection(db, () => { if (connections.delete(file)) storage.close(db); });
        connections.set(file, opened);
        return opened;
      } catch (error) { storage.close(db); throw error; }
    },
    dispose() { for (const opened of connections.values()) opened.close(); },
  };
}
