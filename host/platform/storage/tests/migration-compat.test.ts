/**
 * 移植自 src-tauri/src/data_governance/migration_compat_tests.rs：历史 fixture（用 refinery
 * runner 把真实迁移脚本重放到 schema_tuple + seed + 病态 history_ops）经生产
 * MigrationCoordinator.runAll() 升级到 HEAD，并与 fresh→HEAD 的语义 schema 快照逐项对照。
 * fixture 清单与 seed 直接读取 tests/fixtures/migrations（sha256 锚定）。
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { Connection } from '../connection.ts';
import { MigrationCoordinator } from '../migration/coordinator.ts';
import type { CoreMigrationReport } from '../migration/backup.ts';
import { loadSqlMigrations, Runner } from '../migration/refinery.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '../../../..');
const MIGRATIONS = path.join(REPO, 'resources/app/migrations');
const FIXTURE_ROOT = path.join(REPO, 'tests/fixtures/migrations');
const CORE_DATABASES = ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const;
type CoreDb = (typeof CORE_DATABASES)[number];

interface HistoryOp {
  database: string;
  op: string;
  table?: string;
  version?: number;
}
interface FixtureCase {
  id: string;
  kind: string;
  source_release?: string;
  schema_tuple: Record<string, number>;
  tags?: string[];
  expected_semantics?: string;
  history_ops?: HistoryOp[];
  allowed_extra_tables?: Record<string, string[]>;
  seeds?: Record<string, { file: string; sha256: string }>;
  oracles?: Array<{ database: string; query: string; expected: string }>;
}
interface FixtureManifest {
  format_version: number;
  cases: FixtureCase[];
}

const temps: string[] = [];
afterEach(() => {
  for (const d of temps.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-compat-'));
  temps.push(d);
  return d;
}

const sha256Hex = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** `parse_and_validate_manifest`：错误以 Error 抛出，文案与 Rust 一致。 */
function parseAndValidateManifest(json: string, root: string): FixtureManifest {
  let raw: { format_version: number; cases?: FixtureCase[] };
  try {
    raw = JSON.parse(json) as typeof raw;
  } catch (e) {
    throw new Error(`manifest JSON 解析失败: ${String(e)}`);
  }
  const manifest: FixtureManifest = { format_version: raw.format_version, cases: raw.cases ?? [] };
  if (manifest.format_version !== 1) throw new Error(`不支持的 manifest format_version: ${manifest.format_version}`);
  if (manifest.cases.length === 0) {
    throw new Error('fixture manifest 为空（0 cases）：迁移兼容性 CI 必须至少包含一个历史 fixture');
  }
  const seen = new Set<string>();
  const isCore = (db: string) => (CORE_DATABASES as readonly string[]).includes(db);
  for (const c of manifest.cases) {
    const ctx = `case '${c.id}'`;
    if (seen.has(c.id)) throw new Error(`${ctx}: id 重复`);
    seen.add(c.id);
    if (c.kind === 'release_binary') {
      throw new Error(`${ctx}: release_binary fixture 尚未落地（不存在可用的二进制 artifact，harness 拒绝伪装下载）`);
    } else if (c.kind !== 'bootstrap_sql') {
      throw new Error(`${ctx}: 未知 fixture kind '${c.kind}'`);
    }
    if ((c.expected_semantics ?? '').trim() === '') throw new Error(`${ctx}: expected_semantics 不能为空`);
    if ((c.tags ?? []).length === 0) throw new Error(`${ctx}: 场景标签 tags 不能为空`);
    if ((c.source_release ?? '').trim() === '') throw new Error(`${ctx}: source_release 不能为空`);
    for (const db of CORE_DATABASES) if (!(db in c.schema_tuple)) throw new Error(`${ctx}: schema_tuple 缺少核心库 '${db}'`);
    for (const db of Object.keys(c.schema_tuple)) if (!isCore(db)) throw new Error(`${ctx}: schema_tuple 引用未知数据库 '${db}'`);
    const seeds = c.seeds ?? {};
    if (Object.keys(seeds).length === 0) throw new Error(`${ctx}: bootstrap_sql fixture 必须至少包含一个 seed 文件（不允许空 fixture）`);
    for (const [db, seed] of Object.entries(seeds)) {
      if (!isCore(db)) throw new Error(`${ctx}: seed 引用未知数据库 '${db}'`);
      const actual = sha256Hex(fs.readFileSync(path.join(root, seed.file)));
      if (actual !== seed.sha256) throw new Error(`${ctx}: seed 文件 ${seed.file} 哈希漂移: manifest=${seed.sha256} 实际=${actual}`);
    }
    if ((c.oracles ?? []).length === 0) throw new Error(`${ctx}: 必须至少定义一个数据语义 oracle`);
    for (const o of c.oracles ?? []) if (!isCore(o.database)) throw new Error(`${ctx}: oracle 引用未知数据库 '${o.database}'`);
    for (const op of c.history_ops ?? []) {
      if (!isCore(op.database)) throw new Error(`${ctx}: history_op 引用未知数据库 '${op.database}'`);
      switch (op.op) {
        case 'drop_refinery_history':
        case 'insert_malformed_history_rows':
          break;
        case 'create_legacy_marker_table':
        case 'create_orphan_intermediate_table':
          if (op.table === undefined) throw new Error(`${ctx}: op '${op.op}' 缺少 table 参数`);
          break;
        case 'corrupt_checksum':
        case 'delete_history_row':
          if (op.version === undefined) throw new Error(`${ctx}: op '${op.op}' 缺少 version 参数`);
          break;
        default:
          throw new Error(`${ctx}: 未知 history_op '${op.op}'`);
      }
    }
  }
  return manifest;
}

const loadManifest = () => parseAndValidateManifest(fs.readFileSync(path.join(FIXTURE_ROOT, 'manifest.json'), 'utf8'), FIXTURE_ROOT);

function databasePath(dataDir: string, db: CoreDb): string {
  return db === 'vfs' ? path.join(dataDir, 'databases', 'vfs.db') : path.join(dataDir, `${db}.db`);
}

function openConn(file: string): Connection {
  return new Connection(file, { label: path.basename(file), profile: { foreignKeys: true } });
}

const migrationsFor = (db: CoreDb) => loadSqlMigrations(path.join(MIGRATIONS, db));

function applyHistoryOp(conn: Connection, op: HistoryOp, ctx: string): void {
  switch (op.op) {
    case 'drop_refinery_history':
      conn.run('DROP TABLE IF EXISTS refinery_schema_history');
      return;
    case 'create_legacy_marker_table':
      conn.exec(
        `CREATE TABLE IF NOT EXISTS "${op.table}" (version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT);\n` +
          `INSERT OR IGNORE INTO "${op.table}" (version, name, applied_at) VALUES (1, 'legacy_init', '2026-01-30T00:00:00Z');`,
      );
      return;
    case 'create_orphan_intermediate_table':
      conn.exec(
        `CREATE TABLE IF NOT EXISTS "${op.table}" (id TEXT PRIMARY KEY, leftover TEXT);\n` +
          `INSERT OR IGNORE INTO "${op.table}" (id, leftover) VALUES ('orphan_1', 'from failed migration');`,
      );
      return;
    case 'insert_malformed_history_rows':
      conn.exec(
        "INSERT OR IGNORE INTO refinery_schema_history (version, name, applied_on, checksum)\n VALUES (0, 'ghost_zero_version', 'not-a-timestamp', '12345');\n" +
          "INSERT OR IGNORE INTO refinery_schema_history (version, name, applied_on, checksum)\n VALUES (20260101, 'ghost_empty_checksum', '2026-01-01T00:00:00Z', '');",
      );
      return;
    case 'corrupt_checksum':
      expect(conn.run("UPDATE refinery_schema_history SET checksum = '999999999' WHERE version = ?1", [op.version!]).changes, `${ctx}: corrupt_checksum(${op.version}) 未命中`).toBe(1);
      return;
    case 'delete_history_row':
      expect(conn.run('DELETE FROM refinery_schema_history WHERE version = ?1', [op.version!]).changes, `${ctx}: delete_history_row(${op.version}) 未命中`).toBe(1);
      return;
    default:
      throw new Error(`${ctx}: 未知 history_op '${op.op}'`);
  }
}

/** `build_fixture_slot`：生产 refinery runner（Target::Version, grouped=false, abort_* 默认 true）。 */
function buildFixtureSlot(c: FixtureCase, dataDir: string): void {
  for (const db of CORE_DATABASES) {
    const target = c.schema_tuple[db]!;
    const file = databasePath(dataDir, db);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const conn = openConn(file);
    try {
      new Runner(migrationsFor(db), { target: { kind: 'Version', version: target }, grouped: false }).run(conn);
      const seed = c.seeds?.[db];
      if (seed !== undefined) {
        // rusqlite 连接不开 SQLITE_DBCONFIG_DEFENSIVE；better-sqlite3 默认开启，会拒绝 seed 中的
        // writable_schema 写入（v0944_anki_library）。fixture 构建期间按 rusqlite 语义关闭。
        conn.raw.unsafeMode(true);
        conn.exec(fs.readFileSync(path.join(FIXTURE_ROOT, seed.file), 'utf8'));
        conn.raw.unsafeMode(false);
      }
      for (const op of (c.history_ops ?? []).filter((o) => o.database === db)) applyHistoryOp(conn, op, `case '${c.id}' ${db}`);
    } finally {
      conn.close();
    }
  }
}

const quoteIdent = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** `value_to_string`。 */
function valueToString(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (Buffer.isBuffer(v)) return `blob:${sha256Hex(v)}`;
  return String(v);
}

/** `semantic_schema_snapshot`。 */
function semanticSchemaSnapshot(conn: Connection): Map<string, string> {
  const snapshot = new Map<string, string>();
  const tables = conn
    .all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'refinery_schema_history' ORDER BY name")
    .map((r) => r.name);
  for (const table of tables) {
    const q = quoteIdent(table);
    let desc = 'columns:\n';
    for (const r of conn.all<{ cid: number; name: string; type: string; notnull: number; dflt_value: unknown; pk: number; hidden: number }>(`PRAGMA table_xinfo(${q})`)) {
      const dflt = r.dflt_value === null ? '<none>' : valueToString(r.dflt_value);
      desc += `  [${r.cid}] ${r.name} type=${r.type} notnull=${r.notnull} default=${dflt} pk=${r.pk} hidden=${r.hidden}\n`;
    }
    desc += 'indexes:\n';
    const entries: Array<[string, string]> = [];
    for (const r of conn.all<{ name: string; unique: number; origin: string; partial: number }>(`PRAGMA index_list(${q})`)) {
      let idx = `  ${r.name} unique=${r.unique} origin=${r.origin} partial=${r.partial}\n`;
      for (const x of conn.all<{ seqno: number; cid: number; name: string | null; desc: number; coll: string; key: number }>(`PRAGMA index_xinfo(${quoteIdent(r.name)})`)) {
        idx += `    seq=${x.seqno} cid=${x.cid} col=${x.name ?? '<expr-or-rowid>'} desc=${x.desc} coll=${x.coll} key=${x.key}\n`;
      }
      entries.push([r.name, idx]);
    }
    entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
    for (const [, idx] of entries) desc += idx;
    desc += 'foreign_keys:\n';
    for (const r of conn.all<{ id: number; seq: number; table: string; from: string; to: string | null; on_update: string; on_delete: string }>(`PRAGMA foreign_key_list(${q})`)) {
      desc += `  [${r.id}.${r.seq}] ${r.from} -> ${r.table}(${r.to ?? '<implicit-pk>'}) on_update=${r.on_update} on_delete=${r.on_delete}\n`;
    }
    snapshot.set(`table:${table}`, desc);
  }
  for (const r of conn.all<{ type: string; name: string; sql: string | null }>(
    "SELECT type, name, sql FROM sqlite_master WHERE type IN ('trigger', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
  )) {
    snapshot.set(`${r.type}:${r.name}`, (r.sql ?? '').split(/\s+/).filter((s) => s !== '').join(' '));
  }
  return snapshot;
}

function diffSnapshots(fresh: Map<string, string>, fixture: Map<string, string>): string[] {
  const diffs: string[] = [];
  for (const [key, freshVal] of fresh) {
    const fixtureVal = fixture.get(key);
    if (fixtureVal === undefined) diffs.push(`fixture 缺少对象 ${key}`);
    else if (fixtureVal !== freshVal) diffs.push(`对象 ${key} 定义不一致:\n--- fresh ---\n${freshVal}\n--- fixture ---\n${fixtureVal}`);
  }
  for (const key of fixture.keys()) if (!fresh.has(key)) diffs.push(`fixture 存在 fresh 没有的对象 ${key}`);
  return diffs;
}

function assertIntegrity(conn: Connection, ctx: string): void {
  expect(conn.pluck('PRAGMA integrity_check'), `${ctx}: integrity_check`).toBe('ok');
  expect(conn.all('PRAGMA foreign_key_check'), `${ctx}: foreign_key_check`).toEqual([]);
}

function assertHistoryConsistent(conn: Connection, db: CoreDb, ctx: string): void {
  const rows = conn.all<{ version: number; name: string; checksum: string | null }>('SELECT version, name, checksum FROM refinery_schema_history ORDER BY version');
  const expected = migrationsFor(db)
    .map((m) => [m.version, m.name] as const)
    .sort((a, b) => a[0] - b[0]);
  expect(rows.map((r) => r.version), `${ctx}: 迁移历史版本集合与嵌入迁移集不一致`).toEqual(expected.map((e) => e[0]));
  rows.forEach((r, i) => {
    expect(r.name, `${ctx}: v${r.version} 迁移名称不一致`).toBe(expected[i]![1]);
    const ck = r.checksum ?? '';
    expect(ck !== '' && ck !== '0', `${ctx}: v${r.version} checksum 非法（'${ck}'）`).toBe(true);
  });
}

function runOracles(dataDir: string, c: FixtureCase): void {
  for (const o of c.oracles ?? []) {
    const conn = openConn(databasePath(dataDir, o.database as CoreDb));
    try {
      const actual = valueToString(conn.pluck(o.query));
      expect(actual, `case '${c.id}' ${o.database}: oracle\n  query: ${o.query}`).toBe(o.expected);
    } finally {
      conn.close();
    }
  }
}

async function runProductionUpgrade(dataDir: string): Promise<CoreMigrationReport> {
  return new MigrationCoordinator({ appDataDir: dataDir, migrationsDir: MIGRATIONS, auditDbPath: null }).runAll();
}

function withConn<T>(file: string, fn: (c: Connection) => T): T {
  const c = openConn(file);
  try {
    return fn(c);
  } finally {
    c.close();
  }
}

/** `production_readwrite_smoke` 中 chat_v2 / mistakes / llm_usage 部分（VFS 仓储部分见 TESTMAP）。 */
function productionReadwriteSmoke(dataDir: string, ctx: string): void {
  const now = '2026-07-21T00:00:00.000Z';
  withConn(databasePath(dataDir, 'chat_v2'), (chat) => {
    chat.run(
      "INSERT INTO chat_v2_sessions (id, mode, title, persist_status, created_at, updated_at) VALUES ('sess_smoke_0001', 'general_chat', '升级冒烟会话', 'active', ?1, ?1)",
      [now],
    );
    expect(chat.pluck("SELECT COUNT(*) FROM chat_v2_sessions WHERE id = 'sess_smoke_0001'"), `${ctx}: chat_v2 读回`).toBe(1);
  });
  withConn(databasePath(dataDir, 'mistakes'), (m) => {
    m.run(
      `INSERT INTO mistakes (id, created_at, question_images, analysis_images, user_question, ocr_text, tags, mistake_type, status, updated_at)
       VALUES ('mistake_smoke_1', ?1, '[]', '[]', '升级冒烟错题', 'ocr', '["smoke"]', 'other', 'pending', ?1)`,
      [now],
    );
    expect(m.pluck("SELECT COUNT(*) FROM mistakes WHERE id = 'mistake_smoke_1'"), `${ctx}: mistakes 读回`).toBe(1);
  });
  withConn(databasePath(dataDir, 'llm_usage'), (llm) => {
    llm.run(
      `INSERT INTO llm_usage_logs (id, timestamp, provider, model, caller_type, prompt_tokens, completion_tokens, total_tokens)
       VALUES ('usage_smoke_001', ?1, 'anthropic', 'claude-sonnet-5', 'chat', 10, 5, 15)`,
      [now],
    );
    expect(llm.pluck("SELECT COUNT(*) FROM llm_usage_logs WHERE id = 'usage_smoke_001'"), `${ctx}: llm_usage 读回`).toBe(1);
    expect(llm.pluck("SELECT cache_write_tokens FROM llm_usage_logs WHERE id = 'usage_smoke_001'"), `${ctx}: 旧式 INSERT 必须保持 NULL`).toBeNull();
  });
}

describe('data_governance/migration_compat_tests.rs', () => {
  it('manifest_with_zero_cases_is_rejected', () => {
    expect(() => parseAndValidateManifest('{"format_version":1,"cases":[]}', FIXTURE_ROOT)).toThrow(/0 cases/);
    expect(() => parseAndValidateManifest('{"format_version":1}', FIXTURE_ROOT)).toThrow(/0 cases/);
  });

  it('release_binary_fixture_kind_fails_loudly_until_provisioned', () => {
    const json = JSON.stringify({
      format_version: 1,
      cases: [
        {
          id: 'future_release',
          kind: 'release_binary',
          source_release: 'v9.9.9',
          tags: ['release'],
          expected_semantics: 'n/a',
          schema_tuple: { vfs: 1, chat_v2: 1, mistakes: 1, llm_usage: 1 },
          seeds: {},
          oracles: [],
        },
      ],
    });
    expect(() => parseAndValidateManifest(json, FIXTURE_ROOT)).toThrow(/release_binary/);
  });

  it('manifest_is_valid_and_non_trivial', () => {
    const m = loadManifest();
    expect(m.cases.length).toBeGreaterThanOrEqual(3);
    const tags = new Set(m.cases.flatMap((c) => c.tags ?? []));
    expect(tags.has('oldest_legacy')).toBe(true);
    expect(tags.has('recent_epoch') || tags.has('partial_history')).toBe(true);
  });

  it('historical_fixtures_upgrade_to_head_via_production_coordinator', async () => {
    const manifest = loadManifest();
    expect(manifest.cases.length).toBeGreaterThan(0);
    const freshDir = tempDir();
    const fresh = await runProductionUpgrade(freshDir);
    expect(fresh.success, `fresh 基线迁移失败: ${fresh.error}`).toBe(true);
    const freshSnapshots = new Map(CORE_DATABASES.map((db) => [db, withConn(databasePath(freshDir, db), semanticSchemaSnapshot)] as const));

    for (const c of manifest.cases) {
      // Each fixture remains synchronous/atomic; service runner IPC between fixtures.
      await setImmediate();
      const ctx = `case '${c.id}'`;
      const dataDir = tempDir();
      buildFixtureSlot(c, dataDir);

      const report = await runProductionUpgrade(dataDir);
      expect(report.success, `${ctx}: run_all 报告失败: ${report.error}`).toBe(true);
      expect(report.databases).toHaveLength(CORE_DATABASES.length);
      for (const r of report.databases) expect(r.success, `${ctx}: ${r.id} 迁移失败: ${r.error}`).toBe(true);

      for (const db of CORE_DATABASES) {
        const dbCtx = `${ctx} ${db}`;
        withConn(databasePath(dataDir, db), (conn) => {
          assertIntegrity(conn, dbCtx);
          assertHistoryConsistent(conn, db, dbCtx);
          const snap = semanticSchemaSnapshot(conn);
          for (const t of c.allowed_extra_tables?.[db] ?? []) {
            expect(snap.delete(`table:${t}`), `${dbCtx}: manifest 声明的遗留表 ${t} 实际不存在`).toBe(true);
          }
          const diffs = diffSnapshots(freshSnapshots.get(db)!, snap);
          expect(diffs, `${dbCtx}: fixture→HEAD 与 fresh→HEAD 语义 schema 不一致`).toEqual([]);
        });
      }
      runOracles(dataDir, c);

      const rerun = await runProductionUpgrade(dataDir);
      expect(rerun.success, `${ctx}: 幂等重跑失败: ${rerun.error}`).toBe(true);
      for (const r of rerun.databases) {
        expect(r.appliedCount, `${ctx}: 幂等重跑不应再应用迁移（${r.id}）`).toBe(0);
        expect(r.fromVersion, `${ctx}: 幂等重跑版本发生变化（${r.id}）`).toBe(r.toVersion);
      }
      for (const db of CORE_DATABASES) {
        withConn(databasePath(dataDir, db), (conn) => {
          assertIntegrity(conn, `${ctx} ${db} (reopen)`);
          assertHistoryConsistent(conn, db, `${ctx} ${db} (reopen)`);
        });
      }
      runOracles(dataDir, c);
      productionReadwriteSmoke(dataDir, ctx);
    }
  }, 300_000);
});
