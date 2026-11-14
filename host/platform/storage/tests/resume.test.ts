/**
 * 恢复兼容：从每个中间版本继续迁移。
 *
 * 中间库两种构造方式：
 * (a) 本迁移器的 refinery Runner（target = 第 N 个版本）；
 * (b) 原样执行前 N 个 SQL 文件，再按 refinery 的方式写 history
 *     （`version int4 PRIMARY KEY`、RFC3339 `Z` 的 applied_on、十进制 checksum 字符串）——
 *     模拟 Rust 版写出的库。
 * 然后 `MigrationCoordinator.migrateSingle` 必须到达最新版本、恰好应用 count-N 个迁移，
 * 且最终 schema 指纹与 fresh 全量迁移一致。
 *
 * 覆盖：chat_v2 / mistakes / llm_usage 每个 N；vfs 每个 N 需约 260 s，默认按步长 5 取样并
 * 必含首、尾与 repairs.ts 中有 pre-repair/兼容分支的版本前后（V20260130/0131/0201/0204/0205/
 * 0209/0210/0214/0523/0714/0808/0824）；`DS_RESUME_FULL=1` 时 vfs 也跑每个 N。
 *
 * 已知 Rust 语义差异（忠实保留，按原样断言）：chat_v2 从 V20260203/V20260204 继续时，
 * pre_repair_chat_v2_schema 的 V20260207 分支以 `TEXT DEFAULT '[]'` 补列并直接记账
 * （coordinator.rs:3595-3620），fresh 库则由迁移 SQL 建出无默认值的列。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoordinatedDatabaseName } from '../api.ts';
import { Connection } from '../connection.ts';
import { PROFILES } from '../profiles.ts';
import { MigrationCoordinator } from '../migration/coordinator.ts';
import { computeSchemaFingerprint, computeSchemaFingerprintScope, type SchemaFingerprintScope } from '../migration/fingerprint.ts';
import { Runner, timeRfc3339Now, type Migration } from '../migration/refinery.ts';

const quiet = () => undefined;
const DATABASES: CoordinatedDatabaseName[] = ['vfs', 'chat_v2', 'mistakes', 'llm_usage'];

let root: string;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-resume-'));
});
afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function openAt(file: string): Connection {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return new Connection(file, { label: path.basename(file), profile: PROFILES.plain });
}

interface Expected {
  canonical: string;
  scope: SchemaFingerprintScope;
  latest: number;
  migrations: readonly Migration[];
}

const expected = new Map<CoordinatedDatabaseName, Expected>();

function expectedFor(id: CoordinatedDatabaseName): Expected {
  let e = expected.get(id);
  if (e !== undefined) return e;
  const dir = fs.mkdtempSync(path.join(root, `fresh-${id}-`));
  const c = new MigrationCoordinator({ appDataDir: dir, auditDbPath: null, log: quiet });
  const report = c.migrateSingle(id);
  expect(report.success).toBe(true);
  const set = c.sets[id];
  const scope = computeSchemaFingerprintScope(set, set.latestVersion());
  const conn = openAt(c.getDatabasePath(id));
  const canonical = computeSchemaFingerprint(conn, set, set.latestVersion(), scope).canonicalSchema;
  conn.close();
  e = { canonical, scope, latest: set.latestVersion(), migrations: c.createRunner(id).getMigrations() };
  expected.set(id, e);
  return e;
}

/** 方式 (b)：原样执行前 n 个 SQL，并按 refinery 的 INSERT 写 history。 */
function buildRaw(file: string, migrations: readonly Migration[], n: number): void {
  const conn = openAt(file);
  conn.exec(`CREATE TABLE IF NOT EXISTS refinery_schema_history(
             version int4 PRIMARY KEY,
             name VARCHAR(255),
             applied_on VARCHAR(255),
             checksum VARCHAR(255));`);
  for (const m of migrations.slice(0, n)) {
    conn.exec(m.sql!);
    conn.exec(
      `INSERT INTO refinery_schema_history (version, name, applied_on, checksum) VALUES (${m.version}, '${m.name}', '${timeRfc3339Now()}', '${m.checksum}')`,
    );
  }
  conn.close();
}

/** 已知差异：[库, 从第 N 个迁移继续] → [仅 resume 有的行, 仅 fresh 有的行]。 */
const KNOWN_RUST_DIVERGENCES: Record<string, [string[], string[]]> = {
  'chat_v2:5': [["col:27:active_skill_ids_json:TEXT:0:'[]':0"], ['col:27:active_skill_ids_json:TEXT:0::0']],
  'chat_v2:6': [["col:27:active_skill_ids_json:TEXT:0:'[]':0"], ['col:27:active_skill_ids_json:TEXT:0::0']],
};

const VFS_COMPAT_VERSIONS = [20260130, 20260131, 20260201, 20260204, 20260205, 20260209, 20260210, 20260214, 20260523, 20260714, 20260808, 20260824];

function sampleIndices(id: CoordinatedDatabaseName, migrations: readonly Migration[]): number[] {
  const all = Array.from({ length: migrations.length - 1 }, (_, i) => i + 1);
  if (id !== 'vfs' || process.env.DS_RESUME_FULL === '1') return all;
  const keep = new Set<number>([1, migrations.length - 1]);
  for (const n of all) if (n % 5 === 0) keep.add(n);
  migrations.forEach((m, i) => {
    if (VFS_COMPAT_VERSIONS.includes(m.version)) {
      for (const n of [i, i + 1]) if (n >= 1 && n < migrations.length) keep.add(n);
    }
  });
  return [...keep].sort((a, b) => a - b);
}

function resumeAndCheck(id: CoordinatedDatabaseName, dir: string, n: number): void {
  const e = expectedFor(id);
  const c = new MigrationCoordinator({ appDataDir: dir, auditDbPath: null, log: quiet });
  const report = c.migrateSingle(id);
  expect(report.success).toBe(true);
  expect(report.fromVersion).toBe(e.migrations[n - 1]!.version);
  expect(report.toVersion).toBe(e.latest);
  expect(report.appliedCount).toBe(e.migrations.length - n);
  const conn = openAt(c.getDatabasePath(id));
  try {
    const actual = computeSchemaFingerprint(conn, c.sets[id], e.latest, e.scope).canonicalSchema;
    const known = KNOWN_RUST_DIVERGENCES[`${id}:${n}`];
    if (known === undefined) {
      expect(actual, `${id} resumed after ${n} migrations`).toBe(e.canonical);
    } else {
      const a = actual.split('\n');
      const b = e.canonical.split('\n');
      expect([a.filter((l) => !b.includes(l)), b.filter((l) => !a.includes(l))]).toEqual(known);
    }
  } finally {
    conn.close();
  }
}

for (const id of DATABASES) {
  describe(`resume ${id} from every intermediate version`, () => {
    it('(a) refinery Runner prefix and (b) raw SQL + refinery-style history both converge to the fresh schema', async () => {
      // 每个用例之间让出事件循环：整段同步 SQLite 工作超过 60s 会让 vitest worker 的 RPC 超时。
      const yieldLoop = () => new Promise<void>((r) => setImmediate(r));
      const e = expectedFor(id);
      const count = e.migrations.length;
      // (a) 逐步推进一个模板库，每到一个 N 复制一份再继续迁移。
      const templateDir = fs.mkdtempSync(path.join(root, `tpl-${id}-`));
      const coordinatorPaths = new MigrationCoordinator({ appDataDir: templateDir, auditDbPath: null, log: quiet });
      const templateFile = coordinatorPaths.getDatabasePath(id);
      const relative = path.relative(templateDir, templateFile);
      const template = openAt(templateFile);
      try {
        const sampled = new Set(sampleIndices(id, e.migrations));
        for (let n = 1; n < count; n++) {
          new Runner(e.migrations, { target: { kind: 'Version', version: e.migrations[n - 1]!.version } }).run(template);
          if (!sampled.has(n)) continue;
          const caseDir = path.join(root, `${id}-a-${n}`);
          fs.mkdirSync(path.dirname(path.join(caseDir, relative)), { recursive: true });
          fs.copyFileSync(templateFile, path.join(caseDir, relative));
          resumeAndCheck(id, caseDir, n);
          fs.rmSync(caseDir, { recursive: true, force: true });
          await yieldLoop();
        }
      } finally {
        template.close();
      }
      // (b) 原样 SQL + 手写 history
      for (const n of sampleIndices(id, e.migrations)) {
        const caseDir = path.join(root, `${id}-b-${n}`);
        buildRaw(path.join(caseDir, relative), e.migrations, n);
        resumeAndCheck(id, caseDir, n);
        fs.rmSync(caseDir, { recursive: true, force: true });
        await yieldLoop();
      }
    }, 1_200_000);
  });
}
