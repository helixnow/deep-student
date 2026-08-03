// ============================================================================
// 数据库迁移 L1 静态门禁测试
//
// 运行: node --test scripts/__tests__/check-migrations.test.mjs
// 覆盖: 同日版本冲突 / 乱序 / checksum 篡改 / manifest 同步篡改 /
//       危险 SQL 识别与 @danger-ack 注解 / Rust MigrationDef 对应 /
//       Refinery 0.9 命名解析约束
// ============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DANGER_RULES,
  LOCK_REL,
  MIGRATIONS_REL,
  RUST_DEF_REL,
  auditDangers,
  buildManifest,
  checkAgainstBaseRef,
  checkManifest,
  checkRustCorrespondence,
  detectDangers,
  parseDangerAcks,
  runAudit,
  runCheck,
  runUpdate,
  scanMigrationFiles,
  sha256,
} from '../check-migrations.mjs';

// ----------------------------------------------------------------------------
// 测试夹具：构造最小仓库结构
// ----------------------------------------------------------------------------

const DBS = ['vfs', 'chat_v2', 'mistakes', 'llm_usage', 'browser'];
const RUST_FILES = { vfs: 'vfs.rs', chat_v2: 'chat_v2.rs', mistakes: 'mistakes.rs', llm_usage: 'llm_usage.rs' };

/**
 * 创建临时仓库。
 * @param {Object<string, Object<string,string>>} migrations db -> {fileName: sql}
 * @param {Object<string,string>} [rustOverrides] db -> rust 源码（缺省自动生成一一对应的 MigrationDef）
 */
function makeRepo(migrations, rustOverrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-'));
  for (const db of DBS) {
    fs.mkdirSync(path.join(root, MIGRATIONS_REL, db), { recursive: true });
  }
  fs.mkdirSync(path.join(root, RUST_DEF_REL), { recursive: true });

  for (const [db, files] of Object.entries(migrations)) {
    for (const [fileName, sql] of Object.entries(files)) {
      fs.writeFileSync(path.join(root, MIGRATIONS_REL, db, fileName), sql);
    }
  }

  for (const [db, rustFile] of Object.entries(RUST_FILES)) {
    if (rustOverrides[db] !== undefined) {
      fs.writeFileSync(path.join(root, RUST_DEF_REL, rustFile), rustOverrides[db]);
      continue;
    }
    // 自动生成与 SQL 文件一一对应的 MigrationDef
    let src = '// auto-generated fixture\n';
    for (const fileName of Object.keys(migrations[db] ?? {})) {
      const m = fileName.match(/^V(\d+)__(\w+)\.sql$/);
      if (!m) continue;
      src += `pub const X_${m[1]}: MigrationDef = MigrationDef::new(\n`;
      src += `    ${m[1]},\n    "${m[2]}",\n`;
      src += `    include_str!("../../../migrations/${db}/${fileName}"),\n);\n`;
    }
    fs.writeFileSync(path.join(root, RUST_DEF_REL, rustFile), src);
  }
  return root;
}

function writeLockFromCurrent(root) {
  const { files } = scanMigrationFiles(root);
  const manifest = buildManifest(files, null);
  fs.writeFileSync(path.join(root, LOCK_REL), JSON.stringify(manifest, null, 2));
  return manifest;
}

const BASE_REPO = {
  vfs: {
    'V20260130__init.sql': 'CREATE TABLE resources (id TEXT PRIMARY KEY);\n',
    'V20260131__add_flag.sql': 'ALTER TABLE resources ADD COLUMN flag INTEGER;\n',
  },
  chat_v2: { 'V20260130__init.sql': 'CREATE TABLE sessions (id TEXT PRIMARY KEY);\n' },
  mistakes: { 'V20260130__init.sql': 'CREATE TABLE mistakes (id TEXT PRIMARY KEY);\n' },
  llm_usage: { 'V20260130__init.sql': 'CREATE TABLE usage (id TEXT PRIMARY KEY);\n' },
  browser: { 'V20260711__init.sql': 'CREATE TABLE history (id TEXT PRIMARY KEY);\n' },
};

// ----------------------------------------------------------------------------
// 基线：干净仓库 + 正确 manifest 应通过
// ----------------------------------------------------------------------------

test('干净仓库 + 正确 manifest 全量通过', () => {
  const root = makeRepo(BASE_REPO);
  writeLockFromCurrent(root);
  const result = runCheck({ root });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.fileCount, 6);
});

test('lock manifest 缺失时失败并提示 --update', () => {
  const root = makeRepo(BASE_REPO);
  const result = runCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('lock manifest 缺失')));
});

test('runUpdate 生成 manifest 后检查通过', () => {
  const root = makeRepo(BASE_REPO);
  const result = runUpdate({ root });
  assert.equal(result.wrote, true);
  assert.equal(result.ok, true);
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_REL), 'utf8'));
  assert.equal(lock.entries.length, 6);
  // 条目字段完整
  for (const e of lock.entries) {
    assert.ok(e.database && e.version > 0 && e.name && e.path && /^[0-9a-f]{64}$/.test(e.sha256));
    assert.ok(Array.isArray(e.dangers));
  }
});

// ----------------------------------------------------------------------------
// 场景 1: 同日版本冲突
// ----------------------------------------------------------------------------

test('同日冲突：同目录两个文件共用同一版本号必须失败', () => {
  const repo = structuredClone(BASE_REPO);
  repo.vfs['V20260131__another_same_day.sql'] = 'CREATE INDEX IF NOT EXISTS i ON resources(flag);\n';
  const root = makeRepo(repo);
  const { errors } = scanMigrationFiles(root);
  assert.ok(
    errors.some((e) => e.includes('版本号冲突') && e.includes('20260131')),
    `应检测到版本冲突: ${JSON.stringify(errors)}`
  );
});

test('不同数据库目录允许相同版本号', () => {
  const root = makeRepo(BASE_REPO); // vfs 与 chat_v2 都有 20260130
  const { errors } = scanMigrationFiles(root);
  assert.ok(!errors.some((e) => e.includes('版本号冲突')));
});

// ----------------------------------------------------------------------------
// 场景 2: 乱序（新迁移版本低于已锁定最大版本）
// ----------------------------------------------------------------------------

test('乱序：base 之后新增的低版本迁移必须失败', () => {
  const baseRoot = makeRepo(BASE_REPO);
  const baseManifest = writeLockFromCurrent(baseRoot);

  const repo = structuredClone(BASE_REPO);
  // vfs base 最大版本 20260131，插入更低的 20260125
  repo.vfs['V20260125__late_insert.sql'] = 'CREATE TABLE IF NOT EXISTS late (id TEXT);\n';
  const root = makeRepo(repo);
  writeLockFromCurrent(root);

  const { files } = scanMigrationFiles(root);
  const { errors } = checkAgainstBaseRef(root, files, 'origin/main', {
    gitShow: () => JSON.stringify(baseManifest),
  });
  assert.ok(
    errors.some((e) => e.includes('乱序') && e.includes('V20260125__late_insert.sql')),
    `应检测到乱序: ${JSON.stringify(errors)}`
  );
});

test('base 之后新增更高版本迁移不报乱序', () => {
  const baseRoot = makeRepo(BASE_REPO);
  const baseManifest = writeLockFromCurrent(baseRoot);

  const repo = structuredClone(BASE_REPO);
  repo.vfs['V20260201__forward.sql'] = 'CREATE TABLE IF NOT EXISTS fwd (id TEXT);\n';
  const root = makeRepo(repo);
  const { files } = scanMigrationFiles(root);
  const { errors } = checkAgainstBaseRef(root, files, 'origin/main', {
    gitShow: () => JSON.stringify(baseManifest),
  });
  assert.deepEqual(errors, []);
});

// ----------------------------------------------------------------------------
// 场景 3: checksum 篡改（本地 manifest 校验）
// ----------------------------------------------------------------------------

test('checksum 篡改：修改已锁定 SQL 而不更新 manifest 必须失败', () => {
  const root = makeRepo(BASE_REPO);
  writeLockFromCurrent(root);
  fs.appendFileSync(
    path.join(root, MIGRATIONS_REL, 'vfs', 'V20260131__add_flag.sql'),
    'ALTER TABLE resources ADD COLUMN extra TEXT;\n'
  );
  const result = runCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('checksum 不一致') && e.includes('V20260131__add_flag.sql')));
});

test('删除已锁定迁移文件必须失败', () => {
  const root = makeRepo(BASE_REPO);
  writeLockFromCurrent(root);
  fs.rmSync(path.join(root, MIGRATIONS_REL, 'vfs', 'V20260131__add_flag.sql'));
  const result = runCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('文件不存在') && e.includes('V20260131__add_flag.sql')));
});

// ----------------------------------------------------------------------------
// 场景 4: manifest 被同步篡改（base-ref 不可变性）
// ----------------------------------------------------------------------------

test('manifest 同步篡改：修改 SQL 且同步更新 manifest，base-ref 校验仍必须失败', () => {
  const baseRoot = makeRepo(BASE_REPO);
  const baseManifest = writeLockFromCurrent(baseRoot);

  // 攻击者：改 SQL 内容 + 重新生成 manifest（本地校验将通过）
  const repo = structuredClone(BASE_REPO);
  repo.vfs['V20260131__add_flag.sql'] = 'ALTER TABLE resources ADD COLUMN flag INTEGER DEFAULT 1;\n';
  const root = makeRepo(repo);
  writeLockFromCurrent(root);

  // 本地 manifest 校验通过（这正是攻击面）
  const local = runCheck({ root });
  assert.equal(local.ok, true, `同步篡改后本地校验应通过: ${JSON.stringify(local.errors)}`);

  // base-ref 校验必须抓住
  const withBase = runCheck({
    root,
    baseRef: 'origin/main',
    gitShow: () => JSON.stringify(baseManifest),
  });
  assert.equal(withBase.ok, false);
  assert.ok(
    withBase.errors.some((e) => e.includes('已锁定迁移内容被修改') && e.includes('V20260131__add_flag.sql')),
    JSON.stringify(withBase.errors)
  );
});

test('重命名已锁定迁移（含 manifest 同步更新）base-ref 校验必须失败', () => {
  const baseRoot = makeRepo(BASE_REPO);
  const baseManifest = writeLockFromCurrent(baseRoot);

  const repo = structuredClone(BASE_REPO);
  const sql = repo.vfs['V20260131__add_flag.sql'];
  delete repo.vfs['V20260131__add_flag.sql'];
  repo.vfs['V20260140__add_flag_renamed.sql'] = sql;
  const root = makeRepo(repo);
  writeLockFromCurrent(root);

  const { files } = scanMigrationFiles(root);
  const { errors } = checkAgainstBaseRef(root, files, 'origin/main', {
    gitShow: () => JSON.stringify(baseManifest),
  });
  assert.ok(errors.some((e) => e.includes('被删除或重命名') && e.includes('V20260131__add_flag.sql')));
});

test('base 上尚无 manifest 时跳过不可变性校验', () => {
  const root = makeRepo(BASE_REPO);
  writeLockFromCurrent(root);
  const { files } = scanMigrationFiles(root);
  const r = checkAgainstBaseRef(root, files, 'origin/main', {
    gitShow: () => {
      throw new Error('fatal: path does not exist');
    },
  });
  assert.equal(r.skipped, true);
  assert.deepEqual(r.errors, []);
});

// ----------------------------------------------------------------------------
// 场景 5: 危险 SQL 识别与机器可读注解
// ----------------------------------------------------------------------------

test('detectDangers 覆盖全部风险类别', () => {
  const cases = [
    ['delete_without_where', 'DELETE FROM users;'],
    ['drop_table', 'DROP TABLE users;'],
    ['drop_table', 'DROP TABLE IF EXISTS users;'],
    ['drop_column', 'ALTER TABLE users DROP COLUMN age;'],
    ['unique_constraint', 'CREATE UNIQUE INDEX idx_u ON users(email);'],
    ['add_not_null_column', "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user';"],
    [
      'table_rebuild',
      'DROP TABLE IF EXISTS users_new; CREATE TABLE users_new (id TEXT); INSERT INTO users_new SELECT * FROM users; DROP TABLE users; ALTER TABLE users_new RENAME TO users;',
    ],
    [
      'add_column_backfill',
      "ALTER TABLE users ADD COLUMN score INTEGER; UPDATE users SET score = 0 WHERE score IS NULL;",
    ],
  ];
  for (const [rule, sql] of cases) {
    const dangers = detectDangers('V20260601__danger.sql', sql);
    assert.ok(
      dangers.some((d) => d.rule === rule),
      `${rule} 应被检出: ${JSON.stringify(dangers)}`
    );
    assert.ok(DANGER_RULES.includes(rule));
  }
});

test('重建表内 UNIQUE 约束计为 unique_constraint', () => {
  const sql =
    'DROP TABLE IF EXISTS t_new; CREATE TABLE t_new (id TEXT, email TEXT UNIQUE); ' +
    'INSERT INTO t_new SELECT * FROM t; DROP TABLE t; ALTER TABLE t_new RENAME TO t;';
  const dangers = detectDangers('V20260601__rebuild_unique.sql', sql);
  assert.ok(dangers.some((d) => d.rule === 'unique_constraint'));
});

test('带 WHERE 的 DELETE 与 _new 中间表 DROP 不算危险', () => {
  const dangers = detectDangers(
    'V20260601__safe.sql',
    "DELETE FROM users WHERE deleted_at IS NOT NULL;\nDROP TABLE IF EXISTS users_new;\nCREATE INDEX IF NOT EXISTS i ON users(id);"
  );
  assert.deepEqual(dangers, []);
});

test('init 迁移豁免危险扫描', () => {
  const dangers = detectDangers('V20260130__init.sql', 'DROP TABLE legacy; DELETE FROM old_stuff;');
  assert.deepEqual(dangers, []);
});

test('注释与字符串字面量中的危险关键词不误报', () => {
  const sql = [
    "-- DROP TABLE users （只是注释）",
    "/* DELETE FROM users */",
    "INSERT INTO audit_log(msg) VALUES ('DROP TABLE users');",
  ].join('\n');
  const dangers = detectDangers('V20260601__comments.sql', sql);
  assert.deepEqual(dangers, []);
});

test('@danger-ack 注解声明后危险不再阻塞', () => {
  const repo = structuredClone(BASE_REPO);
  repo.vfs['V20260601__drop_legacy.sql'] =
    '-- @danger-ack: drop_table reason="legacy 表已由 V20260131 迁移替代，确认无数据引用"\nDROP TABLE legacy;\n';
  const root = makeRepo(repo);
  writeLockFromCurrent(root);
  // 手动清空该条目的 dangers，确保豁免完全来自注解而非 manifest
  const lockPath = path.join(root, LOCK_REL);
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  for (const e of lock.entries) e.dangers = [];
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));

  const result = runCheck({ root });
  assert.deepEqual(result.errors, []);
});

test('未声明的危险 SQL 必须失败并给出注解指引', () => {
  const repo = structuredClone(BASE_REPO);
  repo.vfs['V20260601__drop_legacy.sql'] = 'DROP TABLE legacy;\n';
  const root = makeRepo(repo);
  writeLockFromCurrent(root);
  const lockPath = path.join(root, LOCK_REL);
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  for (const e of lock.entries) e.dangers = [];
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));

  const result = runCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('[drop_table]') && e.includes('@danger-ack')));
});

test('@danger-ack 引用未知规则时报错（防拼写失效）', () => {
  const { acks, errors } = parseDangerAcks('-- @danger-ack: drop_tables\nDROP TABLE x;');
  assert.equal(acks.size, 0);
  assert.ok(errors.some((e) => e.includes('drop_tables')));
});

test('manifest 存量豁免仅在 hash 未变时生效（篡改后不得继承豁免）', () => {
  const repo = structuredClone(BASE_REPO);
  repo.vfs['V20260601__drop_legacy.sql'] = 'DROP TABLE legacy;\n';
  const root = makeRepo(repo);
  // 首次建锁：dangers 被记录为存量豁免
  writeLockFromCurrent(root);
  let result = runCheck({ root });
  assert.equal(result.ok, true, `存量豁免应生效: ${JSON.stringify(result.errors)}`);

  // 篡改文件内容（保持危险语句），不更新 manifest → checksum + 危险双失败
  fs.appendFileSync(path.join(root, MIGRATIONS_REL, 'vfs', 'V20260601__drop_legacy.sql'), 'DROP TABLE legacy2;\n');
  result = runCheck({ root });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('checksum 不一致')));
  assert.ok(result.errors.some((e) => e.includes('[drop_table]')), '篡改后不应继承存量豁免');
});

test('@allow-data-change 是 @danger-ack 的等价别名', () => {
  const { acks, errors } = parseDangerAcks('-- @allow-data-change: drop_table reason="确认"\nDROP TABLE x;');
  assert.deepEqual(errors, []);
  assert.ok(acks.has('drop_table'));
});

test('base-ref 下豁免只信 base manifest：往当前 manifest 塞豁免无效', () => {
  const baseRoot = makeRepo(BASE_REPO);
  const baseManifest = writeLockFromCurrent(baseRoot);

  // 攻击者：新增危险迁移 + 在当前 manifest 中手工填 dangers 伪造存量豁免
  const repo = structuredClone(BASE_REPO);
  repo.vfs['V20260601__drop_legacy.sql'] = 'DROP TABLE legacy;\n';
  const root = makeRepo(repo);
  writeLockFromCurrent(root); // 首次建锁语义会把 dangers 记为豁免（等价于手工篡改）

  // 本地校验（无 base-ref）会因存量豁免通过——这正是攻击面
  const local = runCheck({ root });
  assert.equal(local.ok, true, JSON.stringify(local.errors));

  // 带 base-ref：豁免来源切换为 base manifest，新文件无豁免 → 必须失败
  const withBase = runCheck({
    root,
    baseRef: 'origin/main',
    gitShow: () => JSON.stringify(baseManifest),
  });
  assert.equal(withBase.ok, false);
  assert.ok(
    withBase.errors.some((e) => e.includes('[drop_table]') && e.includes('V20260601__drop_legacy.sql')),
    JSON.stringify(withBase.errors)
  );
});

test('base-ref bootstrap（base 无 manifest）时危险豁免退回当前 manifest', () => {
  const repo = structuredClone(BASE_REPO);
  repo.vfs['V20260601__drop_legacy.sql'] = 'DROP TABLE legacy;\n';
  const root = makeRepo(repo);
  writeLockFromCurrent(root); // 首次建锁：存量豁免

  const result = runCheck({
    root,
    baseRef: 'origin/main',
    gitShow: () => {
      throw new Error('fatal: path does not exist');
    },
  });
  assert.equal(result.baseRefSkipped, true);
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

// ----------------------------------------------------------------------------
// --all 审计模式
// ----------------------------------------------------------------------------

test('--all 审计：列出全部危险并标注 acked/grandfathered/unacknowledged', () => {
  const repo = structuredClone(BASE_REPO);
  repo.vfs['V20260601__drop_legacy.sql'] = 'DROP TABLE legacy;\n';
  repo.vfs['V20260602__acked.sql'] =
    '-- @danger-ack: delete_without_where reason="重建缓存表"\nDELETE FROM cache_entries;\n';
  const root = makeRepo(repo);
  writeLockFromCurrent(root); // drop_legacy 与 acked 的 dangers 都进入存量豁免

  // 再新增一个未锁定、未声明的危险迁移
  fs.writeFileSync(
    path.join(root, MIGRATIONS_REL, 'vfs', 'V20260603__drop_more.sql'),
    'DROP TABLE more_legacy;\n'
  );

  const { files } = scanMigrationFiles(root);
  const lock = JSON.parse(fs.readFileSync(path.join(root, LOCK_REL), 'utf8'));
  const findings = auditDangers(files, lock);

  const byPath = (p) => findings.filter((f) => f.path.endsWith(p));
  assert.equal(byPath('V20260601__drop_legacy.sql')[0].status, 'grandfathered');
  assert.equal(byPath('V20260602__acked.sql')[0].status, 'acked');
  assert.equal(byPath('V20260603__drop_more.sql')[0].status, 'unacknowledged');

  const result = runAudit({ root });
  assert.equal(result.audit, true);
  assert.equal(result.findings.length, findings.length);
});

test('runUpdate 对新增危险迁移不自动豁免（需文件内注解）', () => {
  const root = makeRepo(BASE_REPO);
  runUpdate({ root }); // 初次建锁
  fs.writeFileSync(
    path.join(root, MIGRATIONS_REL, 'vfs', 'V20260601__drop_legacy.sql'),
    'DROP TABLE legacy;\n'
  );
  const result = runUpdate({ root }); // 二次 update：新条目 dangers=[]
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('[drop_table]')));
});

// ----------------------------------------------------------------------------
// 场景 6: Rust MigrationDef 对应
// ----------------------------------------------------------------------------

test('SQL 缺少对应 MigrationDef 必须失败', () => {
  const root = makeRepo(BASE_REPO, { vfs: '// 没有任何 MigrationDef\n' });
  const { files } = scanMigrationFiles(root);
  const errors = checkRustCorrespondence(root, files);
  assert.ok(errors.some((e) => e.includes('缺少对应的 Rust MigrationDef') && e.includes('vfs/V20260130__init.sql')));
});

test('MigrationDef 版本号与文件名版本不一致必须失败', () => {
  const rust = `pub const X: MigrationDef = MigrationDef::new(
    20260999,
    "init",
    include_str!("../../../migrations/vfs/V20260130__init.sql"),
);
pub const Y: MigrationDef = MigrationDef::new(
    20260131,
    "add_flag",
    include_str!("../../../migrations/vfs/V20260131__add_flag.sql"),
);
`;
  const root = makeRepo(BASE_REPO, { vfs: rust });
  const { files } = scanMigrationFiles(root);
  const errors = checkRustCorrespondence(root, files);
  assert.ok(errors.some((e) => e.includes('版本号 20260999') && e.includes('文件名版本 20260130')));
});

test('MigrationDef 引用不存在的 SQL 必须失败', () => {
  const rust = `pub const X: MigrationDef = MigrationDef::new(
    20260130,
    "init",
    include_str!("../../../migrations/vfs/V20260130__init.sql"),
);
pub const Y: MigrationDef = MigrationDef::new(
    20260131,
    "add_flag",
    include_str!("../../../migrations/vfs/V20260131__add_flag.sql"),
);
pub const Z: MigrationDef = MigrationDef::new(
    20260999,
    "ghost",
    include_str!("../../../migrations/vfs/V20260999__ghost.sql"),
);
`;
  const root = makeRepo(BASE_REPO, { vfs: rust });
  const { files } = scanMigrationFiles(root);
  const errors = checkRustCorrespondence(root, files);
  assert.ok(errors.some((e) => e.includes('不存在的 SQL 文件') && e.includes('vfs/V20260999__ghost.sql')));
});

test('browser 目录豁免 MigrationDef 对应检查', () => {
  const root = makeRepo(BASE_REPO);
  const { files } = scanMigrationFiles(root);
  const errors = checkRustCorrespondence(root, files);
  assert.ok(!errors.some((e) => e.includes('browser/')));
});

// ----------------------------------------------------------------------------
// 场景 7: Refinery 0.9 命名约束（与 vendored parser 语义一致）
// ----------------------------------------------------------------------------

test('不符合 Refinery 解析格式的文件名必须失败', () => {
  const repo = structuredClone(BASE_REPO);
  // 文档旧格式 V{YYYYMMDD}_{NNN}__ 在 Refinery 0.9 STEM_RE 下不可解析
  repo.vfs['V20260131_001__old_doc_format.sql'] = 'SELECT 1;\n';
  const root = makeRepo(repo);
  const { errors } = scanMigrationFiles(root);
  assert.ok(
    errors.some((e) => e.includes('V20260131_001__old_doc_format.sql') && e.includes('静默忽略')),
    JSON.stringify(errors)
  );
});

test('小数版本号（Refinery i32 下解析失败）必须报错', () => {
  const repo = structuredClone(BASE_REPO);
  repo.vfs['V20260131.1__decimal.sql'] = 'SELECT 1;\n';
  const root = makeRepo(repo);
  const { errors } = scanMigrationFiles(root);
  assert.ok(errors.some((e) => e.includes('V20260131.1__decimal.sql') && e.includes('纯数字')));
});

test('超出 i32 范围的版本号必须报错', () => {
  const repo = structuredClone(BASE_REPO);
  repo.vfs['V2147483648__too_big.sql'] = 'SELECT 1;\n';
  const root = makeRepo(repo);
  const { errors } = scanMigrationFiles(root);
  assert.ok(errors.some((e) => e.includes('V2147483648__too_big.sql') && e.includes('i32')));
});

test('U 前缀迁移在本仓库不允许', () => {
  const repo = structuredClone(BASE_REPO);
  repo.vfs['U20260140__unversioned.sql'] = 'SELECT 1;\n';
  const root = makeRepo(repo);
  const { errors } = scanMigrationFiles(root);
  assert.ok(errors.some((e) => e.includes('U 前缀')));
});

// ----------------------------------------------------------------------------
// 杂项：manifest 结构校验
// ----------------------------------------------------------------------------

test('manifest 路径重复必须失败', () => {
  const root = makeRepo(BASE_REPO);
  const manifest = writeLockFromCurrent(root);
  manifest.entries.push({ ...manifest.entries[0] });
  fs.writeFileSync(path.join(root, LOCK_REL), JSON.stringify(manifest, null, 2));
  const { files } = scanMigrationFiles(root);
  const errors = checkManifest(files, manifest);
  assert.ok(errors.some((e) => e.includes('路径重复')));
});

test('sha256 帮助函数输出稳定', () => {
  assert.equal(
    sha256(Buffer.from('hello')),
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824'
  );
});
