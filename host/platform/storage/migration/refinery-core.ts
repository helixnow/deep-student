/**
 * refinery 0.9（`src-tauri/vendor/refinery-core`，与 crates.io 0.9.0 源码一致）的 SQLite 部分移植：
 *
 * - 文件名解析 `util.rs::parse_migration_name`：`^([U|V])(\d+(?:\.\d+)?)__(\w+)`（Rust regex 的
 *   `\d`/`\w` 是 Unicode 类），版本解析为 i32。
 * - checksum `runner.rs::Migration::unapplied`：`SipHasher13::new()`（密钥 0,0），依次
 *   `name.hash()`（UTF-8 字节 + 0xFF）、`version.hash()`（i32 小端 4 字节）、`sql.hash()`
 *   （UTF-8 字节 + 0xFF），`finish()` 得 u64，十进制字符串存入 `checksum VARCHAR(255)`。
 * - 校验 `traits/mod.rs::verify_migrations`、执行 `traits/sync.rs::migrate`、rusqlite 驱动
 *   `drivers/rusqlite.rs`：迁移 SQL 与 history INSERT 在同一事务提交，避免历史与 schema 分离。
 * - history 表 `refinery_schema_history(version int4 PRIMARY KEY, name VARCHAR(255),
 *   applied_on VARCHAR(255), checksum VARCHAR(255))`，applied_on 为 `time` crate 的 RFC3339。
 *
 * 本文件是可移植核心（桌面与移动端共用，不依赖 Node）；从磁盘目录加载迁移文件的
 * `loadSqlMigrations` 在桌面适配层 `refinery.ts`。
 */
import { StorageError } from '../errors.ts';
import type { SqlParams, TransactionBehavior } from '../api.ts';
import { rfc3339Now } from '../time.ts';
import { toRfc3339Opts } from '../../time/index.ts';
import { splitSqlStatements, stripLeadingSqlTrivia } from './sql-text.ts';

export const DEFAULT_MIGRATION_TABLE_NAME = 'refinery_schema_history';

// ------------------------------------------------------------------ SipHash-1-3

const MASK = (1n << 64n) - 1n;
const UTF8 = new TextEncoder();

/** 流式 SipHash（与 siphasher 1.0 `Hasher<S>` 相同的缓冲语义）。64 位字以 hi/lo 两个 u32 表示。 */
export class SipHasher13 {
  // [v0hi, v0lo, v1hi, v1lo, v2hi, v2lo, v3hi, v3lo]
  private readonly v = new Uint32Array(8);
  private readonly tail = new Uint8Array(8);
  private ntail = 0;
  private length = 0;

  constructor(k0 = 0n, k1 = 0n) {
    const k0hi = Number((k0 >> 32n) & 0xffffffffn), k0lo = Number(k0 & 0xffffffffn);
    const k1hi = Number((k1 >> 32n) & 0xffffffffn), k1lo = Number(k1 & 0xffffffffn);
    const v = this.v;
    v[0] = k0hi ^ 0x736f6d65; v[1] = k0lo ^ 0x70736575;
    v[2] = k1hi ^ 0x646f7261; v[3] = k1lo ^ 0x6e646f6d;
    v[4] = k0hi ^ 0x6c796765; v[5] = k0lo ^ 0x6e657261;
    v[6] = k1hi ^ 0x74656462; v[7] = k1lo ^ 0x79746573;
  }

  private block(mhi: number, mlo: number): void {
    const v = this.v;
    v[6] = v[6]! ^ mhi; v[7] = v[7]! ^ mlo;
    sipRound(v); // c_rounds = 1
    v[0] = v[0]! ^ mhi; v[1] = v[1]! ^ mlo;
  }

  write(bytes: Uint8Array): this {
    this.length += bytes.length;
    const tail = this.tail;
    for (let i = 0; i < bytes.length; i++) {
      tail[this.ntail++] = bytes[i]!;
      if (this.ntail === 8) {
        this.block(
          (tail[4]! | (tail[5]! << 8) | (tail[6]! << 16) | (tail[7]! << 24)) >>> 0,
          (tail[0]! | (tail[1]! << 8) | (tail[2]! << 16) | (tail[3]! << 24)) >>> 0,
        );
        tail.fill(0);
        this.ntail = 0;
      }
    }
    return this;
  }

  /** `Hasher::write_str` 默认实现：字节 + 0xFF（`impl Hash for str`）。 */
  writeStr(s: string): this {
    this.write(UTF8.encode(s));
    return this.write(Uint8Array.of(0xff));
  }

  /** `impl Hash for i32` → `write_i32` → `write_u32(i as u32)`，小端 4 字节。 */
  writeI32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setInt32(0, v, true);
    return this.write(b);
  }

  finish(): bigint {
    const t = this.tail;
    const bhi = ((((this.length & 0xff) << 24) | (t[6]! << 16) | (t[5]! << 8) | t[4]!) >>> 0);
    const blo = ((t[3]! << 24) | (t[2]! << 16) | (t[1]! << 8) | t[0]!) >>> 0;
    const v = Uint32Array.from(this.v); // finish 不改变哈希器状态
    v[6] = v[6]! ^ bhi; v[7] = v[7]! ^ blo;
    sipRound(v);
    v[0] = v[0]! ^ bhi; v[1] = v[1]! ^ blo;
    v[5] = v[5]! ^ 0xff;
    sipRound(v); // d_rounds = 3
    sipRound(v);
    sipRound(v);
    const hi = (v[0]! ^ v[2]! ^ v[4]! ^ v[6]!) >>> 0;
    const lo = (v[1]! ^ v[3]! ^ v[5]! ^ v[7]!) >>> 0;
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
}

/** SipRound：64 位加法/循环左移/异或，在 hi/lo u32 上实现。 */
function sipRound(v: Uint32Array): void {
  let v0h = v[0]!, v0l = v[1]!, v1h = v[2]!, v1l = v[3]!, v2h = v[4]!, v2l = v[5]!, v3h = v[6]!, v3l = v[7]!;
  let lo: number, th: number;
  // v0 += v1; v1 = rotl(v1, 13); v1 ^= v0; v0 = rotl(v0, 32)
  lo = v0l + v1l; v0h = (v0h + v1h + (lo > 0xffffffff ? 1 : 0)) >>> 0; v0l = lo >>> 0;
  th = ((v1h << 13) | (v1l >>> 19)) >>> 0; v1l = ((v1l << 13) | (v1h >>> 19)) >>> 0; v1h = th;
  v1h = (v1h ^ v0h) >>> 0; v1l = (v1l ^ v0l) >>> 0;
  th = v0h; v0h = v0l; v0l = th;
  // v2 += v3; v3 = rotl(v3, 16); v3 ^= v2
  lo = v2l + v3l; v2h = (v2h + v3h + (lo > 0xffffffff ? 1 : 0)) >>> 0; v2l = lo >>> 0;
  th = ((v3h << 16) | (v3l >>> 16)) >>> 0; v3l = ((v3l << 16) | (v3h >>> 16)) >>> 0; v3h = th;
  v3h = (v3h ^ v2h) >>> 0; v3l = (v3l ^ v2l) >>> 0;
  // v0 += v3; v3 = rotl(v3, 21); v3 ^= v0
  lo = v0l + v3l; v0h = (v0h + v3h + (lo > 0xffffffff ? 1 : 0)) >>> 0; v0l = lo >>> 0;
  th = ((v3h << 21) | (v3l >>> 11)) >>> 0; v3l = ((v3l << 21) | (v3h >>> 11)) >>> 0; v3h = th;
  v3h = (v3h ^ v0h) >>> 0; v3l = (v3l ^ v0l) >>> 0;
  // v2 += v1; v1 = rotl(v1, 17); v1 ^= v2; v2 = rotl(v2, 32)
  lo = v2l + v1l; v2h = (v2h + v1h + (lo > 0xffffffff ? 1 : 0)) >>> 0; v2l = lo >>> 0;
  th = ((v1h << 17) | (v1l >>> 15)) >>> 0; v1l = ((v1l << 17) | (v1h >>> 15)) >>> 0; v1h = th;
  v1h = (v1h ^ v2h) >>> 0; v1l = (v1l ^ v2l) >>> 0;
  th = v2h; v2h = v2l; v2l = th;
  v[0] = v0h; v[1] = v0l; v[2] = v1h; v[3] = v1l; v[4] = v2h; v[5] = v2l; v[6] = v3h; v[7] = v3l;
}

/** refinery migration checksum（u64）。 */
export function refineryChecksum(name: string, version: number, sql: string): bigint {
  return new SipHasher13().writeStr(name).writeI32(version).writeStr(sql).finish();
}

// ------------------------------------------------------------------ 文件名

export type MigrationPrefix = 'V' | 'U';

/** refinery `Kind` 错误的 Display 文案（error.rs）。 */
export class RefineryError extends Error {
  readonly kind: | 'InvalidName'
      | 'InvalidVersion'
      | 'RepeatedVersion'
      | 'DivergentVersion'
      | 'MissingVersion'
      | 'InvalidMigrationPath'
      | 'InvalidMigrationFile'
      | 'Connection';
  readonly report: Migration[] | undefined;

  constructor(
    kind:
      | 'InvalidName'
      | 'InvalidVersion'
      | 'RepeatedVersion'
      | 'DivergentVersion'
      | 'MissingVersion'
      | 'InvalidMigrationPath'
      | 'InvalidMigrationFile'
      | 'Connection',
    message: string,
    report: Migration[] | undefined = undefined,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.kind = kind;
    this.report = report;
    this.name = 'RefineryError';
  }
}

// `^([U|V])(\d+(?:\.\d+)?)__(\w+)`；Rust regex 的 \d = \p{Nd}，\w = Alphabetic|M|Nd|Pc|Join_Control。
const STEM_RE = /^([U|V])(\p{Nd}+(?:\.\p{Nd}+)?)__([\p{Alphabetic}\p{M}\p{Nd}\p{Pc}\p{Join_Control}]+)/u;
const SQL_FILE_RE = new RegExp(`${STEM_RE.source}\\.sql$`, 'u');

const I32_MAX = 2147483647;
const I32_MIN = -2147483648;

/** Rust `str::parse::<i32>()`：可选 `+`/`-`，ASCII 数字，范围 i32。 */
function parseI32(s: string): number | undefined {
  if (!/^[+-]?[0-9]+$/.test(s)) return undefined;
  const n = BigInt(s);
  if (n > BigInt(I32_MAX) || n < BigInt(I32_MIN)) return undefined;
  return Number(n);
}

export function parseMigrationName(name: string): { prefix: MigrationPrefix; version: number; name: string } {
  const m = STEM_RE.exec(name);
  if (m === null) throw new RefineryError('InvalidName', 'migration name must be in the format V{number}__{name}');
  const version = parseI32(m[2]!);
  if (version === undefined) throw new RefineryError('InvalidVersion', 'migration version must be a valid integer');
  return { prefix: m[1] === 'V' ? 'V' : 'U', version, name: m[3]! };
}

// ------------------------------------------------------------------ Migration

export class Migration {
  readonly state: 'Applied' | 'Unapplied';
  readonly name: string;
  readonly version: number;
  readonly prefix: MigrationPrefix;
  readonly sql: string | undefined;
  readonly checksum: bigint;
  appliedOn: string | undefined;

  private constructor(init: {
    state: 'Applied' | 'Unapplied';
    name: string;
    version: number;
    prefix: MigrationPrefix;
    sql: string | undefined;
    checksum: bigint;
    appliedOn: string | undefined;
  }) {
    this.state = init.state;
    this.name = init.name;
    this.version = init.version;
    this.prefix = init.prefix;
    this.sql = init.sql;
    this.checksum = init.checksum;
    this.appliedOn = init.appliedOn;
  }

  /** `Migration::unapplied(input_name, sql)`：input_name 是文件 stem（如 `V20260130__init`）。 */
  static unapplied(inputName: string, sql: string): Migration {
    const parsed = parseMigrationName(inputName);
    return new Migration({
      state: 'Unapplied',
      name: parsed.name,
      version: parsed.version,
      prefix: parsed.prefix,
      sql,
      checksum: refineryChecksum(parsed.name, parsed.version, sql),
      appliedOn: undefined,
    });
  }

  static applied(version: number, name: string, appliedOn: string, checksum: bigint): Migration {
    return new Migration({ state: 'Applied', name, version, prefix: 'V', sql: undefined, checksum, appliedOn });
  }

  /** `Display`：`{prefix}{version}__{name}`。 */
  toString(): string {
    return `${this.prefix}${this.version}__${this.name}`;
  }

  /** `PartialEq`：version + name + checksum。 */
  equals(other: Migration): boolean {
    return this.version === other.version && this.name === other.name && this.checksum === other.checksum;
  }
}

/** `time::OffsetDateTime::now_utc().format(&Rfc3339)`（纳秒位去尾零；JS 只有毫秒精度）。 */
export function timeRfc3339Now(now: Date = new Date()): string {
  const rfc = toRfc3339Opts(BigInt(now.getTime()) * 1_000_000n, 'Nanos');
  const fraction = rfc.slice(20, 29).replace(/0+$/, '');
  return `${rfc.slice(0, 19)}${fraction === '' ? '' : `.${fraction}`}Z`;
}

/** chrono `Utc::now().to_rfc3339()`（`SecondsFormat::AutoSi`，偏移 `+00:00`）。 */
export function chronoRfc3339Now(now: Date = new Date()): string {
  return rfc3339Now(now);
}

// RFC3339（time crate 解析器接受的形式）：日期 T 时间 [.小数] (Z|±HH:MM)
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/;

// ------------------------------------------------------------------ 迁移文件集合

/**
 * `embed_migrations!` 的文件筛选与排序：只收文件名匹配 `STEM_RE + \.sql$` 的条目（其余忽略），
 * 按版本稳定排序（同版本保持输入顺序）。`name` 是文件名（不含目录），`sql` 是文件原文。
 * 桌面由 `refinery.ts` 的 `loadSqlMigrations` 从目录读出后调用；移动端由外壳注入的 SQL 文本调用。
 */
export function migrationsFromSqlFiles(files: Iterable<{ readonly name: string; readonly sql: string }>): Migration[] {
  const migrations: Migration[] = [];
  for (const file of files) {
    if (SQL_FILE_RE.test(file.name)) migrations.push(Migration.unapplied(file.name.slice(0, -'.sql'.length), file.sql));
  }
  return sortByVersion(migrations);
}

/** Rust `Vec::sort`（稳定）按 `Ord`（仅 version）。 */
function sortByVersion(migrations: Migration[]): Migration[] {
  return migrations
    .map((m, i) => [m, i] as const)
    .sort((a, b) => a[0].version - b[0].version || a[1] - b[1])
    .map(([m]) => m);
}

// ------------------------------------------------------------------ Runner

/** Runner 实际用到的连接能力；桌面 `Connection` 与移动端 `MobileConnection` 都满足。 */
export interface RefineryConnection {
  all<R>(sql: string, params?: SqlParams): R[];
  exec(sql: string): void;
  begin(behavior: TransactionBehavior): void;
  commit(): void;
  rollback(): void;
}

// boundary-allow test-double: refinery Target::Fake semantics
export type Target = { kind: 'Latest' } | { kind: 'Version'; version: number } | { kind: 'Fake' } | { kind: 'FakeVersion'; version: number };

export interface RunnerOptions {
  grouped?: boolean;
  abortDivergent?: boolean;
  abortMissing?: boolean;
  target?: Target;
  tableName?: string;
  /** refinery 通过 `log` 输出的诊断（如 abort_* = false 时的 divergent/missing）。 */
  log?: (level: 'info' | 'error' | 'debug', message: string) => void;
}

export class Runner {
  readonly grouped: boolean;
  readonly abortDivergent: boolean;
  readonly abortMissing: boolean;
  readonly target: Target;
  readonly tableName: string;
  private readonly log: NonNullable<RunnerOptions['log']>;

  private readonly migrations: readonly Migration[];

  constructor(
    migrations: readonly Migration[],
    options: RunnerOptions = {},
  ) {
    this.migrations = migrations;
    this.grouped = options.grouped ?? false;
    this.abortDivergent = options.abortDivergent ?? true;
    this.abortMissing = options.abortMissing ?? true;
    this.target = options.target ?? { kind: 'Latest' };
    this.tableName = options.tableName ?? DEFAULT_MIGRATION_TABLE_NAME;
    this.log = options.log ?? (() => undefined);
  }

  getMigrations(): readonly Migration[] {
    return this.migrations;
  }

  getAppliedMigrations(conn: RefineryConnection): Migration[] {
    return queryAppliedMigrations(
      conn,
      `SELECT version, name, applied_on, checksum FROM ${this.tableName} ORDER BY version ASC;`,
      'error getting applied migrations',
    );
  }

  getLastAppliedMigration(conn: RefineryConnection): Migration | undefined {
    const rows = queryAppliedMigrations(
      conn,
      `SELECT version, name, applied_on, checksum
    FROM ${this.tableName} WHERE version=(SELECT MAX(version) from ${this.tableName})`,
      'error getting last applied migration',
    );
    return rows.pop();
  }

  /** `Migrate::migrate`。返回本次应用（非仅记账目标）的迁移。 */
  run(conn: RefineryConnection): Migration[] {
    const unapplied = this.getUnappliedMigrations(conn);
    // boundary-allow test-double: refinery Target::Fake semantics
    const historyOnly = this.target.kind === 'Fake' || this.target.kind === 'FakeVersion';
    return migrate(conn, unapplied, this.target, this.tableName, this.grouped || historyOnly, this.log);
  }

  getUnappliedMigrations(conn: RefineryConnection): Migration[] {
    // assert_migrations_table：单独一个事务
    executeInTransaction(
      conn,
      [
        `CREATE TABLE IF NOT EXISTS ${this.tableName}(
             version int4 PRIMARY KEY,
             name VARCHAR(255),
             applied_on VARCHAR(255),
             checksum VARCHAR(255));`,
      ],
      'error asserting migrations table',
      undefined,
    );
    const applied = this.getAppliedMigrations(conn);
    const result = verifyMigrations(applied, [...this.migrations], this.abortDivergent, this.abortMissing, this.log);
    if (result.length === 0) this.log('info', 'no migrations to apply');
    return result;
  }
}

/** `traits/mod.rs::verify_migrations`。 */
export function verifyMigrations(
  applied: readonly Migration[],
  migrationsIn: Migration[],
  abortDivergent: boolean,
  abortMissing: boolean,
  log: NonNullable<RunnerOptions['log']> = () => undefined,
): Migration[] {
  const migrations = sortByVersion(migrationsIn);
  for (const app of applied) {
    const migration = migrations.find((m) => m.version === app.version);
    if (migration === undefined) {
      if (abortMissing) {
        throw new RefineryError('MissingVersion', `migration ${app} is missing from the filesystem`);
      }
      log('error', `migration ${app} is missing from the filesystem`);
    } else if (!migration.equals(app)) {
      if (abortDivergent) {
        throw new RefineryError('DivergentVersion', `applied migration ${app} is different than filesystem one ${migration}`);
      }
      log('error', `applied migration ${app} is different than filesystem one ${migration}`);
    }
  }
  const last = applied[applied.length - 1];
  const current = last === undefined ? -1 : last.version;
  if (last === undefined) log('info', 'schema history table is empty, going to apply all migrations');
  else log('info', `current version: ${current}`);

  const toBeApplied: Migration[] = [];
  for (const migration of migrations) {
    if (applied.some((app) => app.version === migration.version)) continue;
    if (toBeApplied.some((m) => m.equals(migration))) {
      throw new RefineryError('RepeatedVersion', `migration ${migration} is repeated, migration versions must be unique`);
    } else if (migration.prefix === 'V' && current >= migration.version) {
      if (abortMissing) throw new RefineryError('MissingVersion', `migration ${migration} is missing from the filesystem`);
      log('error', `found migration on file system ${migration} not applied`);
    } else {
      toBeApplied.push(migration);
    }
  }
  return toBeApplied;
}

/** `insert_migration_query`（字符串拼接，与 refinery 一致——名称来自文件名 `\w+`，不含引号）。 */
function insertMigrationQuery(migration: Migration, tableName: string): string {
  return `INSERT INTO ${tableName} (version, name, applied_on, checksum) VALUES (${migration.version}, '${migration.name}', '${migration.appliedOn}', '${migration.checksum}')`;
}

/** rusqlite `Transaction for Connection::execute`：一个事务里依次 `execute_batch`，失败回滚。 */
function executeInTransaction(conn: RefineryConnection, queries: readonly string[], context: string, report: Migration[] | undefined): number {
  const rebuild = queries.some(query => splitSqlStatements(query).some(statement => /^DROP\s+TABLE\b/i.test(stripLeadingSqlTrivia(statement))));
  let foreignKeys: number | undefined;
  try {
    if (rebuild) {
      foreignKeys = Number(conn.all<{ foreign_keys: number }>('PRAGMA foreign_keys')[0]?.foreign_keys ?? 0);
      // SQLite ignores this pragma once BEGIN has run. DROP of a referenced parent
      // must not cascade into child rows while the replacement table is built.
      conn.exec('PRAGMA foreign_keys = OFF');
    }
    conn.begin('deferred');
    let count = 0;
    for (const query of queries) {
      conn.exec(query);
      count++;
    }
    if (rebuild && conn.all('PRAGMA foreign_key_check').length > 0) {
      throw new Error('foreign_key_check failed after table rebuild');
    }
    conn.commit();
    return count;
  } catch (error) {
    conn.rollback();
    throw new RefineryError('Connection', `\`${context}\`, \`${errorMessage(error)}\``, report, { cause: error });
  } finally {
    if (foreignKeys !== undefined) conn.exec(`PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `drivers/rusqlite.rs::query_applied_migrations`（在一个事务中读取）。 */
function queryAppliedMigrations(conn: RefineryConnection, query: string, context: string): Migration[] {
  let rows: Array<{ version: unknown; name: unknown; applied_on: unknown; checksum: unknown }>;
  try {
    conn.begin('deferred');
    rows = conn.all(query);
    for (const row of rows) {
      if (typeof row.version !== 'number' || !Number.isInteger(row.version)) {
        throw new StorageError('SQLITE', `Invalid column type at index: 0, name: version`);
      }
      if (typeof row.applied_on !== 'string') {
        throw new StorageError('SQLITE', `Invalid column type ${row.applied_on === null ? 'Null' : typeof row.applied_on} at index: 2, name: applied_on`);
      }
      if (typeof row.checksum !== 'string') {
        throw new StorageError('SQLITE', `Invalid column type ${row.checksum === null ? 'Null' : typeof row.checksum} at index: 3, name: checksum`);
      }
      if (row.name !== null && typeof row.name !== 'string') {
        throw new StorageError('SQLITE', `Invalid column type at index: 1, name: name`);
      }
    }
    conn.commit();
  } catch (error) {
    conn.rollback();
    throw new RefineryError('Connection', `\`${context}\`, \`${errorMessage(error)}\``, undefined, { cause: error });
  }
  return rows.map((row) => {
    const appliedOn = row.applied_on as string;
    // Rust: `OffsetDateTime::parse(..).unwrap()` / `checksum.parse::<u64>().expect(..)` —— 失败即 panic。
    if (!RFC3339_RE.test(appliedOn)) {
      throw new Error(`called \`Result::unwrap()\` on an \`Err\` value: invalid RFC3339 applied_on '${appliedOn}'`);
    }
    const checksumText = row.checksum as string;
    if (!/^\+?[0-9]+$/.test(checksumText) || BigInt(checksumText) > MASK) {
      throw new Error('checksum must be a valid u64');
    }
    if (row.name === null) {
      throw new RefineryError('Connection', `\`${context}\`, \`Invalid column type Null at index: 1, name: name\``);
    }
    return Migration.applied(row.version as number, row.name as string, appliedOn, BigInt(checksumText));
  });
}

/** `traits/sync.rs::migrate`。 */
function migrate(
  conn: RefineryConnection,
  migrations: Migration[],
  target: Target,
  tableName: string,
  batched: boolean,
  log: NonNullable<RunnerOptions['log']>,
): Migration[] {
  const batch: string[] = [];
  const applied: Migration[] = [];
  // boundary-allow test-double: refinery Target::Fake semantics
  const historyOnly = target.kind === 'Fake' || target.kind === 'FakeVersion';
  for (const migration of migrations) {
    // boundary-allow test-double: refinery Target::Fake semantics
    if ((target.kind === 'Version' || target.kind === 'FakeVersion') && target.version < migration.version) {
      log('info', `stopping at migration: ${target.version}, due to user option`);
      break;
    }
    migration.appliedOn = timeRfc3339Now();
    const insert = insertMigrationQuery(migration, tableName);
    if (migration.sql === undefined) throw new Error('sql must be Some!');
    if (!historyOnly) {
      applied.push(migration);
      batch.push(migration.sql);
    }
    batch.push(insert);
  }

  if (batched) {
    executeInTransaction(conn, batch, 'error applying migrations', undefined);
  } else {
    for (let i = 0; i < batch.length; i += 2) {
      const current = applied[i / 2]!;
      log('info', `applying migration: ${current} ...`);
      executeInTransaction(conn, [batch[i]!, batch[i + 1]!], 'error applying update', applied.slice(0, i / 2));
      log('debug', `applied migration:  ${current} writing state to db.`);
    }
  }
  return applied;
}
