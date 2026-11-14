/**
 * V06-01：移动端执行期 SQL 错误必须与桌面 better-sqlite3 实现一样包装成 `StorageError`
 * （`code`、`sqliteCode` 扩展码名、`phase`、`database`、`message = sqlite3_errmsg`），同一组故障 SQL 逐条比对。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseHandle } from '../../../host/platform/storage/api.ts';
import { Connection } from '../../../host/platform/storage/connection.ts';
import { PROFILES } from '../../../host/platform/storage/profiles.ts';
import { openFileDatabase } from '../../../host/platform/storage/service.ts';
import { MobileDatabase } from '../../../host/platform/storage-mobile/database.ts';
import type { MobileConnection } from '../../../host/platform/storage-mobile/connection.ts';
import { errorShape, mobileConnection, nodeSqlite, thrown, uniqueFile } from './support/sqlite-node.ts';

type Sqlite = Awaited<ReturnType<typeof nodeSqlite>>;
type AnyConnection = Pick<Connection | MobileConnection, 'run' | 'get' | 'all' | 'pluck' | 'iterate' | 'exec'>;

let sqlite3: Sqlite;
let dir: string;
let n = 0;

beforeAll(async () => {
  sqlite3 = await nodeSqlite();
  dir = mkdtempSync(join(tmpdir(), 'w31-diff-'));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const LABEL = 'diff';

function desktop(): Connection {
  return new Connection(join(dir, `d${++n}.db`), { label: LABEL, profile: PROFILES.plain });
}

function mobile(): MobileConnection {
  return mobileConnection(sqlite3, uniqueFile('diff'), LABEL, PROFILES.plain);
}

interface FaultCase {
  readonly name: string;
  readonly setup: readonly string[];
  readonly fail: (conn: AnyConnection) => unknown;
  readonly sqliteCode: string;
}

const CASES: readonly FaultCase[] = [
  { name: 'UNIQUE', setup: ['CREATE TABLE u(a UNIQUE)', 'INSERT INTO u VALUES (1)'], fail: c => c.run('INSERT INTO u VALUES (?1)', [1]), sqliteCode: 'SQLITE_CONSTRAINT_UNIQUE' },
  { name: 'PRIMARY KEY', setup: ['CREATE TABLE p(id TEXT PRIMARY KEY)', "INSERT INTO p VALUES ('x')"], fail: c => c.run('INSERT INTO p VALUES (?1)', ['x']), sqliteCode: 'SQLITE_CONSTRAINT_PRIMARYKEY' },
  { name: 'NOT NULL', setup: ['CREATE TABLE nn(a TEXT NOT NULL)'], fail: c => c.run('INSERT INTO nn VALUES (?1)', [null]), sqliteCode: 'SQLITE_CONSTRAINT_NOTNULL' },
  { name: 'CHECK', setup: ['CREATE TABLE ck(a INTEGER CHECK (a > 0))'], fail: c => c.run('INSERT INTO ck VALUES (?1)', [-1]), sqliteCode: 'SQLITE_CONSTRAINT_CHECK' },
  {
    name: 'FOREIGN KEY',
    setup: ['PRAGMA foreign_keys = ON', 'CREATE TABLE parent(id INTEGER PRIMARY KEY)', 'CREATE TABLE child(pid INTEGER REFERENCES parent(id))'],
    fail: c => c.run('INSERT INTO child VALUES (?1)', [42]),
    sqliteCode: 'SQLITE_CONSTRAINT_FOREIGNKEY',
  },
  {
    name: 'trigger RAISE(ABORT)',
    setup: ['CREATE TABLE tr(a)', "CREATE TRIGGER tr_block BEFORE INSERT ON tr BEGIN SELECT RAISE(ABORT, '只读表'); END"],
    fail: c => c.run('INSERT INTO tr VALUES (1)'),
    sqliteCode: 'SQLITE_CONSTRAINT_TRIGGER',
  },
  { name: 'FULL', setup: ['CREATE TABLE big(x)', 'PRAGMA max_page_count = 4'], fail: (c) => { for (let i = 0; i < 64; i++) c.run('INSERT INTO big VALUES (randomblob(3000))'); }, sqliteCode: 'SQLITE_FULL' },
  {
    name: 'CORRUPT (malformed schema)',
    setup: ['CREATE TABLE t(a)', 'PRAGMA writable_schema = ON', "UPDATE sqlite_schema SET sql = 'CREATE TABLE t(' WHERE name = 't'", 'PRAGMA writable_schema = OFF', 'PRAGMA schema_version = 99'],
    fail: c => c.all('SELECT * FROM t'),
    sqliteCode: 'SQLITE_CORRUPT',
  },
  { name: 'step error in get()', setup: [], fail: c => c.get("SELECT json('{') AS j"), sqliteCode: 'SQLITE_ERROR' },
  { name: 'step error in all()', setup: [], fail: c => c.all('SELECT abs(-9223372036854775807 - 1) AS v'), sqliteCode: 'SQLITE_ERROR' },
  { name: 'step error in pluck()', setup: [], fail: c => c.pluck("SELECT json('[') AS j"), sqliteCode: 'SQLITE_ERROR' },
  { name: 'step error in iterate()', setup: [], fail: c => [...c.iterate("SELECT json('{') AS j")], sqliteCode: 'SQLITE_ERROR' },
  { name: 'prepare error', setup: [], fail: c => c.run('INSERT INTO missing_table VALUES (1)'), sqliteCode: 'SQLITE_ERROR' },
  { name: 'exec error', setup: ['CREATE TABLE ex(a UNIQUE)', 'INSERT INTO ex VALUES (1)'], fail: c => c.exec('INSERT INTO ex VALUES (1)'), sqliteCode: 'SQLITE_CONSTRAINT_UNIQUE' },
];

describe('V06-01 mobile SQL errors match the desktop driver', () => {
  it.each(CASES)('$name: same StorageError code / sqliteCode / phase / message', ({ setup, fail, sqliteCode }) => {
    const d = desktop();
    const m = mobile();
    try {
      for (const sql of setup) {
        d.exec(sql);
        m.exec(sql);
      }
      const desktopShape = errorShape(thrown(() => fail(d)));
      const mobileShape = errorShape(thrown(() => fail(m)));
      expect(desktopShape).toMatchObject({ storageError: true, code: 'SQLITE', sqliteCode, database: LABEL });
      expect(mobileShape).toEqual(desktopShape);
    } finally {
      d.close();
      m.close();
    }
  });

  it('BUSY: opening a second connection while another holds the EXCLUSIVE lock fails with the same StorageError', () => {
    // 持锁方处于 locking_mode=EXCLUSIVE（移动端每条连接都是）；第二条连接打开时应用 PRAGMA 要读 schema，遇到
    // SQLITE_BUSY。桌面构造连接固定 busy_timeout=5000，这一例因此要等 5 秒。
    const file = join(dir, `busy${++n}.db`);
    const holder = new Connection(file, { label: LABEL, profile: PROFILES.plain });
    holder.exec('PRAGMA locking_mode = EXCLUSIVE');
    holder.exec('CREATE TABLE b(a)');
    holder.run('INSERT INTO b VALUES (1)');
    const desktopShape = errorShape(thrown(() => new Connection(file, { label: LABEL, profile: PROFILES.plain })));
    holder.close();

    const mobileFile = uniqueFile('busy');
    const mobileHolder = mobileConnection(sqlite3, mobileFile, LABEL, PROFILES.plain, 'unix');
    mobileHolder.exec('CREATE TABLE b(a)');
    mobileHolder.run('INSERT INTO b VALUES (1)');
    const mobileShape = errorShape(thrown(() => mobileConnection(sqlite3, mobileFile, LABEL, PROFILES.plain, 'unix')));
    mobileHolder.close();

    expect(desktopShape).toMatchObject({ storageError: true, code: 'SQLITE', sqliteCode: 'SQLITE_BUSY', phase: 'execute', message: 'database is locked' });
    expect(mobileShape).toEqual(desktopShape);
  });

  it('a failed statement stays usable: the same cached statement runs again after the error', () => {
    for (const conn of [desktop(), mobile()]) {
      try {
        conn.exec('CREATE TABLE u(a UNIQUE)');
        conn.run('INSERT INTO u VALUES (?1)', [1]);
        expect(errorShape(thrown(() => conn.run('INSERT INTO u VALUES (?1)', [1])))).toMatchObject({ sqliteCode: 'SQLITE_CONSTRAINT_UNIQUE' });
        expect(conn.run('INSERT INTO u VALUES (?1)', [2]).changes).toBe(1);
        expect(conn.all('SELECT a FROM u ORDER BY a')).toEqual([{ a: 1 }, { a: 2 }]);
        expect(errorShape(thrown(() => conn.get("SELECT json('{') AS j")))).toMatchObject({ sqliteCode: 'SQLITE_ERROR' });
        expect(conn.get("SELECT json('{}') AS j")).toEqual({ j: '{}' });
      } finally {
        conn.close();
      }
    }
  });

  it('a conflict inside a sync transaction rolls back and throws the same StorageError as the desktop handle', () => {
    const run = (db: DatabaseHandle) => {
      db.exec('CREATE TABLE u(a UNIQUE)');
      db.run('INSERT INTO u VALUES (1)');
      const shape = errorShape(thrown(() => db.transaction((tx) => {
        tx.run('INSERT INTO u VALUES (?1)', [2]);
        tx.run('INSERT INTO u VALUES (?1)', [1]);
      })));
      return { shape, rows: db.all('SELECT a FROM u ORDER BY a'), inTransaction: db.inTransaction };
    };
    const d = openFileDatabase(join(dir, `tx${++n}.db`), { profile: 'plain', label: LABEL });
    const file = uniqueFile('tx');
    const m = new MobileDatabase({ name: LABEL, path: file, profile: PROFILES.plain, open: () => mobileConnection(sqlite3, file, LABEL, PROFILES.plain), warn: () => undefined });
    try {
      const desktopResult = run(d);
      const mobileResult = run(m);
      expect(desktopResult).toEqual({ shape: expect.objectContaining({ storageError: true, sqliteCode: 'SQLITE_CONSTRAINT_UNIQUE' }), rows: [{ a: 1 }], inTransaction: false });
      expect(mobileResult).toEqual(desktopResult);
    } finally {
      d.close();
      m.close();
    }
  });

  it('async transaction conflicts reject with the desktop StorageError shape', async () => {
    const run = async (db: DatabaseHandle) => {
      db.exec('CREATE TABLE u(a UNIQUE)');
      db.run('INSERT INTO u VALUES (1)');
      const error = await db.withTransaction(async (tx) => {
        tx.run('INSERT INTO u VALUES (?1)', [1]);
      }).then(() => null, (e: unknown) => e);
      return { shape: errorShape(error), rows: db.all('SELECT a FROM u') };
    };
    const d = openFileDatabase(join(dir, `atx${++n}.db`), { profile: 'plain', label: LABEL });
    const file = uniqueFile('atx');
    const m = new MobileDatabase({ name: LABEL, path: file, profile: PROFILES.plain, open: () => mobileConnection(sqlite3, file, LABEL, PROFILES.plain), warn: () => undefined });
    try {
      // 桌面异步事务跑在第二条连接（标签 `<库>#tx`）上；移动端单连接，`database` 是库名本身。
      const { shape: { database: desktopDatabase, ...desktopShape }, rows } = await run(d);
      expect(desktopDatabase).toBe(`${LABEL}#tx`);
      expect(desktopShape).toMatchObject({ storageError: true, sqliteCode: 'SQLITE_CONSTRAINT_UNIQUE' });
      const { shape: { database: mobileDatabase, ...mobileShape }, rows: mobileRows } = await run(m);
      expect(mobileDatabase).toBe(LABEL);
      expect({ shape: mobileShape, rows: mobileRows }).toEqual({ shape: desktopShape, rows });
    } finally {
      d.close();
      m.close();
    }
  });
});
