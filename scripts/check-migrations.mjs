#!/usr/bin/env node
// ============================================================================
// 数据库迁移 L1 静态门禁（CI Gate）
//
// 职责：
//   1. 校验 src-tauri/migrations/migration-lock.json（lock manifest）：
//      - 每个 migration SQL 文件都有 manifest 条目，无多余条目
//      - 路径全局唯一；版本号纯数字（i32 范围）且目录内唯一
//      - 实际文件 SHA-256 与 manifest 一致
//   2. 校验 SQL 文件与 Rust MigrationDef（include_str! 路径 + 版本号）一一对应
//   3. 危险 SQL 静态识别（无 WHERE 的 DELETE、DROP TABLE/COLUMN、UNIQUE、
//      ADD COLUMN NOT NULL、表重建、ADD COLUMN + 回填等），
//      通过机器可读注解 `-- @danger-ack: <rule>` 声明已知风险
//   4. CI 传入 --base-ref 时，与 base 分支的 manifest 比对：
//      已锁定条目被修改/删除/重命名即失败（即使当前 manifest 已同步改掉），
//      并检测新迁移版本号是否乱序（低于该库已锁定的最大版本）。
//      危险扫描的存量豁免（grandfather）此时也改从 base manifest 读取——
//      PR 同步往当前 manifest 的 dangers 数组塞豁免同样无效，
//      base 之后新增/变更的 SQL 只能靠文件内 @danger-ack 注解声明。
//
// 用法：
//   node scripts/check-migrations.mjs                    # 本地全量校验
//   node scripts/check-migrations.mjs --base-ref origin/main   # CI 不可变性校验
//   node scripts/check-migrations.mjs --update           # 新增迁移后更新 lock manifest
//   node scripts/check-migrations.mjs --all              # 审计模式：列出全部危险（含已豁免/已声明）
//   node scripts/check-migrations.mjs --json             # 机器可读输出
//
// 说明：
//   - Refinery 0.9（vendored: src-tauri/vendor/refinery-core）文件名解析正则为
//     ^([U|V])(\d+(?:\.\d+)?)__(\w+)，版本为纯数字（默认 i32）。
//     本仓库统一使用 V{version}__{snake_case}.sql，version 为 YYYYMMDD 形态纯数字。
//   - browser/ 目录为模块内 embed（不挂 MigrationCoordinator），
//     纳入 manifest 锁定与危险扫描，但豁免 Rust MigrationDef 对应检查。
// ============================================================================

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ----------------------------------------------------------------------------
// 常量
// ----------------------------------------------------------------------------

export const MIGRATIONS_REL = path.join('src-tauri', 'migrations');
export const LOCK_REL = path.join(MIGRATIONS_REL, 'migration-lock.json');
export const RUST_DEF_REL = path.join('src-tauri', 'src', 'data_governance', 'migration');

/** 各数据库目录 -> Rust MigrationDef 定义文件（null 表示豁免对应检查） */
export const DATABASES = {
  vfs: 'vfs.rs',
  chat_v2: 'chat_v2.rs',
  mistakes: 'mistakes.rs',
  llm_usage: 'llm_usage.rs',
  browser: null, // 模块内 refinery embed_migrations!，无 MigrationDef
};

/**
 * 与 vendored refinery-core 0.9 的 STEM_RE 语义一致：
 * ^([U|V])(\d+(?:\.\d+)?)__(\w+)
 * 本门禁额外收紧：只允许 V 前缀、纯整数版本（无小数点）。
 */
const REFINERY_STEM_RE = /^([UV])(\d+(?:\.\d+)?)__(\w+)\.sql$/;
const I32_MAX = 2147483647;

export const DANGER_RULES = Object.freeze([
  'delete_without_where',
  'drop_table',
  'drop_column',
  'unique_constraint',
  'add_not_null_column',
  'table_rebuild',
  'add_column_backfill',
]);

// ----------------------------------------------------------------------------
// SQL 归一化与危险检测
// ----------------------------------------------------------------------------

/** 去除注释与字符串字面量，转大写（供模式匹配，不用于 hash） */
export function normalizeSql(sql) {
  let out = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++;
    } else if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
    } else if (c === "'") {
      i++;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          i += 2;
        } else if (sql[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      out += "''"; // 占位，保持语句结构
    } else {
      out += c;
      i++;
    }
  }
  return out.toUpperCase();
}

/**
 * 解析机器可读风险声明注解。
 * 格式：`-- @danger-ack: rule_a, rule_b reason="为什么可接受"`
 * （`@allow-data-change:` 为等价别名。）
 * 只声明风险类别与理由，不包含/伪造 reviewer 身份——reviewer 批准只体现在
 * code review 本身，门禁不从 SQL 文本信任任何人名。
 * 返回 { acks: Set<string>, errors: string[] }（未知 rule 视为错误，防止拼写失效）。
 */
export function parseDangerAcks(sql) {
  const acks = new Set();
  const errors = [];
  for (const line of sql.split('\n')) {
    const m = line.trim().match(/^--\s*@(?:danger-ack|allow-data-change):\s*(.*)$/);
    if (!m) continue;
    // reason="..." 之后为自由文本，不参与 rule 解析
    const rulePart = m[1].split(/reason\s*=/)[0];
    const tokens = rulePart
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (tokens.length === 0) {
      errors.push('@danger-ack 注解为空，必须声明至少一个风险规则');
    }
    for (const token of tokens) {
      if (DANGER_RULES.includes(token)) {
        acks.add(token);
      } else {
        errors.push(`@danger-ack 声明了未知风险规则 "${token}"（可用: ${DANGER_RULES.join(', ')}）`);
      }
    }
  }
  return { acks, errors };
}

function stripQuotes(name) {
  return name.replace(/^["'`[]|["'`\]]$/g, '');
}

/**
 * 危险 SQL 静态识别。
 * @param {string} fileName 文件名（V...__name.sql）
 * @param {string} sql 原始 SQL
 * @returns {{rule: string, detail: string}[]}
 */
export function detectDangers(fileName, sql) {
  const stem = fileName.match(REFINERY_STEM_RE);
  const migrationName = stem ? stem[3] : '';
  // init 迁移创建全新数据库，不存在既有数据风险
  if (migrationName === 'init') return [];

  const normalized = normalizeSql(sql);
  const statements = normalized
    .split(';')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);

  const dangers = [];
  const addColumnTables = new Set();
  const writeTables = new Set();
  const newTables = new Set();
  let hasRenameTo = false;

  for (const stmt of statements) {
    // 1. 无 WHERE 的 DELETE
    if (/^DELETE\s+FROM\s+/.test(stmt) && !/\bWHERE\b/.test(stmt)) {
      const t = stmt.match(/^DELETE\s+FROM\s+([A-Z0-9_."'`[\]]+)/)?.[1] ?? '?';
      dangers.push({
        rule: 'delete_without_where',
        detail: `DELETE FROM ${stripQuotes(t).toLowerCase()} 没有 WHERE 子句，会清空整表`,
      });
    }

    // 2. DROP TABLE（_new 中间表清理豁免）
    for (const m of stmt.matchAll(/\bDROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Z0-9_."'`[\]]+)/g)) {
      const table = stripQuotes(m[1]);
      if (!table.endsWith('_NEW')) {
        dangers.push({
          rule: 'drop_table',
          detail: `DROP TABLE ${table.toLowerCase()} 会不可逆删除表及其数据`,
        });
      }
    }

    // 3. DROP COLUMN
    for (const m of stmt.matchAll(/\bALTER\s+TABLE\s+([A-Z0-9_."'`[\]]+)\s+DROP\s+COLUMN\s+([A-Z0-9_."'`[\]]+)/g)) {
      dangers.push({
        rule: 'drop_column',
        detail: `ALTER TABLE ${stripQuotes(m[1]).toLowerCase()} DROP COLUMN ${stripQuotes(m[2]).toLowerCase()} 会不可逆删除列数据`,
      });
    }

    // 4a. CREATE UNIQUE INDEX（对既有数据施加唯一约束，可能因重复数据失败）
    if (/\bCREATE\s+UNIQUE\s+INDEX\b/.test(stmt)) {
      const name = stmt.match(/\bCREATE\s+UNIQUE\s+INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Z0-9_."'`[\]]+)/)?.[1] ?? '?';
      dangers.push({
        rule: 'unique_constraint',
        detail: `CREATE UNIQUE INDEX ${stripQuotes(name).toLowerCase()} 对既有数据施加唯一约束，存在重复数据时迁移失败`,
      });
    }

    // 收集 CREATE TABLE（含重建表）与 4b. 重建表内的 UNIQUE 约束
    const createM = stmt.match(/\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Z0-9_."'`[\]]+)/);
    if (createM) {
      const table = stripQuotes(createM[1]);
      if (table.endsWith('_NEW')) {
        newTables.add(table);
        if (/\bUNIQUE\b/.test(stmt)) {
          dangers.push({
            rule: 'unique_constraint',
            detail: `重建表 ${table.toLowerCase()} 含 UNIQUE 约束，数据回灌可能因重复数据失败`,
          });
        }
      }
    }

    // 5. ADD COLUMN ... NOT NULL（对已有表）
    const addColM = stmt.match(/\bALTER\s+TABLE\s+([A-Z0-9_."'`[\]]+)\s+ADD\s+COLUMN\s+/);
    if (addColM) {
      const table = stripQuotes(addColM[1]);
      addColumnTables.add(table);
      if (/\bNOT\s+NULL\b/.test(stmt)) {
        dangers.push({
          rule: 'add_not_null_column',
          detail: `ALTER TABLE ${table.toLowerCase()} ADD COLUMN ... NOT NULL 对已有表新增非空列（SQLite 要求非空默认值，且旧行为默认值语义）`,
        });
      }
    }

    // 收集写语句目标表（供 7 使用）
    const updM = stmt.match(/^UPDATE\s+([A-Z0-9_."'`[\]]+)\s+SET\b/);
    if (updM) writeTables.add(stripQuotes(updM[1]));
    const insM = stmt.match(/^INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Z0-9_."'`[\]]+)/);
    if (insM) writeTables.add(stripQuotes(insM[1]));

    if (/\bRENAME\s+TO\b/.test(stmt)) hasRenameTo = true;
  }

  // 6. 表重建（CREATE TABLE xxx_new + RENAME TO）
  if (newTables.size > 0 && hasRenameTo) {
    dangers.push({
      rule: 'table_rebuild',
      detail: `检测到表重建流程（${[...newTables].map((t) => t.toLowerCase()).join(', ')} + RENAME TO），涉及全表复制与替换`,
    });
  }

  // 7. ADD COLUMN + 同表 UPDATE/INSERT 回填混排
  const backfilled = [...addColumnTables].filter((t) => writeTables.has(t));
  if (backfilled.length > 0) {
    dangers.push({
      rule: 'add_column_backfill',
      detail: `同一脚本内对 ${backfilled.map((t) => t.toLowerCase()).join(', ')} 既 ADD COLUMN 又执行 UPDATE/INSERT 回填，失败中断可能留下半迁移状态`,
    });
  }

  return dangers;
}

// ----------------------------------------------------------------------------
// 文件扫描与 manifest 构建
// ----------------------------------------------------------------------------

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * 扫描迁移目录，返回 { files, errors }。
 * files: [{ database, fileName, relPath(相对 migrations 目录, POSIX 分隔), version, name, sha256, sql }]
 */
export function scanMigrationFiles(root) {
  const errors = [];
  const files = [];
  const migrationsDir = path.join(root, MIGRATIONS_REL);

  for (const database of Object.keys(DATABASES)) {
    const dir = path.join(migrationsDir, database);
    if (!fs.existsSync(dir)) {
      errors.push(`迁移目录缺失: ${path.join(MIGRATIONS_REL, database)}`);
      continue;
    }
    for (const entry of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (!fs.statSync(full).isFile()) continue;
      if (!entry.endsWith('.sql')) continue;

      const relPath = `${database}/${entry}`;
      const m = entry.match(REFINERY_STEM_RE);
      if (!m) {
        errors.push(
          `${relPath}: 文件名不符合 Refinery 0.9 可解析格式 V{纯数字版本}__{名称}.sql，会被 Refinery 静默忽略`
        );
        continue;
      }
      const [, prefix, versionStr, name] = m;
      if (prefix !== 'V') {
        errors.push(`${relPath}: 本仓库只允许 V 前缀版本化迁移（U 前缀不受支持）`);
      }
      if (versionStr.includes('.')) {
        errors.push(`${relPath}: 版本号必须为纯数字（Refinery i32 版本下小数版本会解析失败）`);
        continue;
      }
      const version = Number(versionStr);
      if (!Number.isSafeInteger(version) || version <= 0 || version > I32_MAX) {
        errors.push(`${relPath}: 版本号 ${versionStr} 超出 i32 范围或非法`);
        continue;
      }
      const buf = fs.readFileSync(full);
      files.push({
        database,
        fileName: entry,
        relPath,
        version,
        name,
        sha256: sha256(buf),
        sql: buf.toString('utf8'),
      });
    }
  }

  // 版本号目录内唯一（同日冲突）
  for (const database of Object.keys(DATABASES)) {
    const seen = new Map();
    for (const f of files.filter((f) => f.database === database)) {
      if (seen.has(f.version)) {
        errors.push(
          `${database}: 版本号冲突 —— ${seen.get(f.version)} 与 ${f.fileName} 都使用版本 ${f.version}（同日多个迁移需使用下一个未占用的纯数字版本）`
        );
      } else {
        seen.set(f.version, f.fileName);
      }
    }
  }

  return { files, errors };
}

/** 读取 lock manifest；不存在返回 null */
export function readLock(root) {
  const p = path.join(root, LOCK_REL);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * 构建新的 manifest 对象。
 * dangers 继承策略：path+sha256 与旧 manifest 完全一致的条目继承旧 dangers（grandfather）；
 * 新/变更条目 dangers=[]（必须使用文件内 @danger-ack 注解声明）。
 * 旧 manifest 不存在时（首次建锁）记录当前检测到的 dangers 作为存量豁免。
 */
export function buildManifest(files, oldLock) {
  const oldByPath = new Map((oldLock?.entries ?? []).map((e) => [e.path, e]));
  const entries = files
    .slice()
    .sort((a, b) => (a.database === b.database ? a.version - b.version : a.database.localeCompare(b.database)))
    .map((f) => {
      let dangers = [];
      if (oldLock == null) {
        dangers = [...new Set(detectDangers(f.fileName, f.sql).map((d) => d.rule))].sort();
      } else {
        const old = oldByPath.get(f.relPath);
        if (old && old.sha256 === f.sha256) dangers = old.dangers ?? [];
      }
      return {
        database: f.database,
        version: f.version,
        name: f.name,
        path: f.relPath,
        sha256: f.sha256,
        dangers,
      };
    });
  return {
    $schema: 'deep-student migration lock manifest',
    version: 1,
    generatedBy: 'node scripts/check-migrations.mjs --update',
    entries,
  };
}

// ----------------------------------------------------------------------------
// Rust MigrationDef 对应检查
// ----------------------------------------------------------------------------

/**
 * 解析 Rust 定义文件中的 MigrationDef::new(version, "name", include_str!("path"))。
 * 返回 [{ version, name, includeRelPath(相对 migrations 目录, POSIX) }]
 */
export function parseRustDefs(root, rustFile) {
  const full = path.join(root, RUST_DEF_REL, rustFile);
  if (!fs.existsSync(full)) return { defs: null, error: `Rust 定义文件缺失: ${path.join(RUST_DEF_REL, rustFile)}` };
  const src = fs.readFileSync(full, 'utf8');
  const defs = [];
  const re = /MigrationDef::new\s*\(\s*(\d+)\s*,\s*"([^"]*)"\s*,\s*include_str!\s*\(\s*"([^"]*)"\s*\)/g;
  for (const m of src.matchAll(re)) {
    const includePath = m[3];
    // include_str! 相对 src/data_governance/migration/，形如 ../../../migrations/vfs/Vxxx.sql
    const resolved = path.posix.normalize(path.posix.join('src/data_governance/migration', includePath));
    const prefix = 'migrations/';
    // normalize 后形如 migrations/vfs/Vxxx.sql（相对 src-tauri）
    const inMigrations = resolved.startsWith(prefix) ? resolved.slice(prefix.length) : null;
    defs.push({
      version: Number(m[1]),
      name: m[2],
      includeRelPath: inMigrations,
      rawInclude: includePath,
    });
  }
  return { defs, error: null };
}

export function checkRustCorrespondence(root, files) {
  const errors = [];
  for (const [database, rustFile] of Object.entries(DATABASES)) {
    if (rustFile == null) continue; // browser 豁免
    const dbFiles = files.filter((f) => f.database === database);
    const { defs, error } = parseRustDefs(root, rustFile);
    if (error) {
      errors.push(error);
      continue;
    }
    const defByPath = new Map();
    for (const d of defs) {
      if (d.includeRelPath == null) {
        errors.push(`${rustFile}: include_str! 路径无法归一化到 migrations 目录: ${d.rawInclude}`);
        continue;
      }
      if (defByPath.has(d.includeRelPath)) {
        errors.push(`${rustFile}: 同一 SQL 被多个 MigrationDef 引用: ${d.includeRelPath}`);
      }
      defByPath.set(d.includeRelPath, d);
    }
    for (const f of dbFiles) {
      const def = defByPath.get(f.relPath);
      if (!def) {
        errors.push(`${f.relPath}: 缺少对应的 Rust MigrationDef（${rustFile} 中未发现 include_str! 引用）`);
        continue;
      }
      if (def.version !== f.version) {
        errors.push(
          `${f.relPath}: Rust MigrationDef 版本号 ${def.version} 与文件名版本 ${f.version} 不一致（${rustFile}）`
        );
      }
      defByPath.delete(f.relPath);
    }
    for (const leftover of defByPath.keys()) {
      if (leftover.startsWith(`${database}/`)) {
        errors.push(`${rustFile}: MigrationDef 引用了不存在的 SQL 文件 ${leftover}`);
      }
    }
  }
  return errors;
}

// ----------------------------------------------------------------------------
// manifest 校验 / 危险 SQL 校验 / base-ref 不可变性校验
// ----------------------------------------------------------------------------

export function checkManifest(files, lock) {
  const errors = [];
  if (lock == null) {
    errors.push(`lock manifest 缺失: ${LOCK_REL}（运行 node scripts/check-migrations.mjs --update 生成）`);
    return errors;
  }
  const entries = lock.entries ?? [];

  const byPath = new Map();
  for (const e of entries) {
    if (byPath.has(e.path)) {
      errors.push(`manifest 路径重复: ${e.path}`);
    }
    byPath.set(e.path, e);
    if (!Number.isInteger(e.version) || e.version <= 0 || e.version > I32_MAX) {
      errors.push(`manifest 条目 ${e.path} 的版本号非法: ${e.version}`);
    }
  }

  const filesByPath = new Map(files.map((f) => [f.relPath, f]));
  for (const f of files) {
    const e = byPath.get(f.relPath);
    if (!e) {
      errors.push(`迁移文件未锁定: ${f.relPath}（新增迁移需运行 --update 更新 manifest）`);
      continue;
    }
    if (e.sha256 !== f.sha256) {
      errors.push(`checksum 不一致: ${f.relPath} 实际 ${f.sha256}，manifest 记录 ${e.sha256}`);
    }
    if (e.version !== f.version) {
      errors.push(`版本不一致: ${f.relPath} 文件名版本 ${f.version}，manifest 记录 ${e.version}`);
    }
    if (e.database !== f.database) {
      errors.push(`数据库归属不一致: ${f.relPath} 位于 ${f.database}，manifest 记录 ${e.database}`);
    }
  }
  for (const e of entries) {
    if (!filesByPath.has(e.path)) {
      errors.push(`manifest 条目对应的文件不存在: ${e.path}（迁移文件被删除或重命名）`);
    }
  }
  return errors;
}

/**
 * 危险 SQL 校验。
 * @param files 扫描结果
 * @param lock 存量豁免（grandfather）来源 manifest：
 *   - 本地运行：当前工作区的 lock manifest；
 *   - CI --base-ref：base 分支的 manifest（防止 PR 同步往当前 manifest 塞豁免）。
 *   仅当条目 sha256 与实际文件一致时豁免才生效。
 */
export function checkDangers(files, lock) {
  const errors = [];
  const lockByPath = new Map((lock?.entries ?? []).map((e) => [e.path, e]));
  for (const f of files) {
    const { acks, errors: ackErrors } = parseDangerAcks(f.sql);
    for (const e of ackErrors) errors.push(`${f.relPath}: ${e}`);

    const lockedEntry = lockByPath.get(f.relPath);
    // 仅当 hash 与锁定值一致时，锁定的存量豁免才生效（防止篡改后继承豁免）
    const grandfathered =
      lockedEntry && lockedEntry.sha256 === f.sha256 ? new Set(lockedEntry.dangers ?? []) : new Set();

    for (const d of detectDangers(f.fileName, f.sql)) {
      if (acks.has(d.rule) || grandfathered.has(d.rule)) continue;
      errors.push(
        `${f.relPath}: 危险 SQL [${d.rule}] ${d.detail}；` +
          `如确认可接受，请在脚本中添加机器可读注解: -- @danger-ack: ${d.rule} reason="..."`
      );
    }
  }
  return errors;
}

/**
 * --all 审计模式：列出全部危险发现（包含已被存量豁免/注解声明的），
 * 用于历史债务盘点。status: acked | grandfathered | unacknowledged。
 */
export function auditDangers(files, lock) {
  const lockByPath = new Map((lock?.entries ?? []).map((e) => [e.path, e]));
  const findings = [];
  for (const f of files) {
    const { acks } = parseDangerAcks(f.sql);
    const lockedEntry = lockByPath.get(f.relPath);
    const grandfathered =
      lockedEntry && lockedEntry.sha256 === f.sha256 ? new Set(lockedEntry.dangers ?? []) : new Set();
    for (const d of detectDangers(f.fileName, f.sql)) {
      const status = acks.has(d.rule) ? 'acked' : grandfathered.has(d.rule) ? 'grandfathered' : 'unacknowledged';
      findings.push({ path: f.relPath, rule: d.rule, detail: d.detail, status });
    }
  }
  return findings;
}

/**
 * base-ref 不可变性校验。
 * 从 git 读取 base 分支的 manifest：已锁定条目在当前工作区必须逐字节保持
 * （路径存在、SHA-256 一致、版本一致）——与当前 manifest 内容无关，
 * 因此同步篡改 manifest 也会失败。
 * 同时检测乱序：base 之后新增的迁移版本必须大于该库 base 中的最大版本。
 */
export function checkAgainstBaseRef(root, files, baseRef, { gitShow } = {}) {
  const errors = [];
  const lockGitPath = LOCK_REL.split(path.sep).join('/');
  let baseLockRaw;
  const show =
    gitShow ??
    ((ref, p) =>
      execFileSync('git', ['-C', root, 'show', `${ref}:${p}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }));
  try {
    baseLockRaw = show(baseRef, lockGitPath);
  } catch {
    // base 上还没有 manifest（首次引入 bootstrap），跳过不可变性校验
    return { errors, skipped: true, baseLock: null };
  }

  let baseLock;
  try {
    baseLock = JSON.parse(baseLockRaw);
  } catch (e) {
    errors.push(`base ref ${baseRef} 的 manifest 解析失败: ${e.message}`);
    return { errors, skipped: false, baseLock: null };
  }

  const filesByPath = new Map(files.map((f) => [f.relPath, f]));
  const baseEntries = baseLock.entries ?? [];
  for (const e of baseEntries) {
    const f = filesByPath.get(e.path);
    if (!f) {
      errors.push(`已锁定迁移被删除或重命名: ${e.path}（base=${baseRef}）——已发布迁移不可变更，请新增修复迁移`);
      continue;
    }
    if (f.sha256 !== e.sha256) {
      errors.push(
        `已锁定迁移内容被修改: ${e.path}（base=${baseRef} 记录 ${e.sha256}，当前 ${f.sha256}）——即使 manifest 已同步更新也不允许`
      );
    }
    if (f.version !== e.version) {
      errors.push(`已锁定迁移版本被变更: ${e.path}（base ${e.version} -> 当前 ${f.version}）`);
    }
  }

  // 乱序检测：新迁移版本必须大于 base 中该库的最大版本
  const baseMaxByDb = new Map();
  const basePathSet = new Set(baseEntries.map((e) => e.path));
  for (const e of baseEntries) {
    baseMaxByDb.set(e.database, Math.max(baseMaxByDb.get(e.database) ?? 0, e.version));
  }
  for (const f of files) {
    if (basePathSet.has(f.relPath)) continue;
    const baseMax = baseMaxByDb.get(f.database) ?? 0;
    if (baseMax > 0 && f.version <= baseMax) {
      errors.push(
        `新迁移版本乱序: ${f.relPath} 版本 ${f.version} 不大于 ${f.database} 已锁定的最大版本 ${baseMax}` +
          `（Refinery 不会执行低于已应用版本的迁移，老用户将跳过该脚本）`
      );
    }
  }

  return { errors, skipped: false, baseLock };
}

// ----------------------------------------------------------------------------
// 入口
// ----------------------------------------------------------------------------

/**
 * 全量检查。
 * @returns {{ ok: boolean, errors: string[], fileCount: number, baseRefSkipped?: boolean }}
 */
export function runCheck({ root, baseRef = null, gitShow } = {}) {
  const errors = [];
  const { files, errors: scanErrors } = scanMigrationFiles(root);
  errors.push(...scanErrors);

  const lock = readLock(root);
  errors.push(...checkManifest(files, lock));
  errors.push(...checkRustCorrespondence(root, files));

  // 危险扫描的存量豁免来源：本地为当前 manifest；
  // CI 传 --base-ref 且 base 上已有 manifest 时，只信 base manifest——
  // PR 同步往当前 manifest 的 dangers 数组塞豁免不生效，
  // base 之后新增/变更的 SQL 必须用文件内 @danger-ack 注解声明。
  let dangerLock = lock;
  let baseRefSkipped;
  if (baseRef) {
    const r = checkAgainstBaseRef(root, files, baseRef, { gitShow });
    errors.push(...r.errors);
    baseRefSkipped = r.skipped;
    if (!r.skipped && r.baseLock) dangerLock = r.baseLock;
  }
  errors.push(...checkDangers(files, dangerLock));

  return { ok: errors.length === 0, errors, fileCount: files.length, baseRefSkipped };
}

/**
 * --all 审计模式：不设豁免地盘点全部危险发现（含状态标注），只报告不写盘。
 */
export function runAudit({ root }) {
  const { files, errors: scanErrors } = scanMigrationFiles(root);
  const lock = readLock(root);
  const findings = auditDangers(files, lock);
  return { audit: true, scanErrors, findings, fileCount: files.length };
}

/**
 * --update：重建 manifest（继承存量豁免），写盘后再全量校验。
 * 即使存在扫描错误（如版本冲突）也会写入可解析条目的锁定值，
 * 但返回 ok=false 让操作者感知问题（CI 门禁跑的是普通 check）。
 */
export function runUpdate({ root }) {
  const { files } = scanMigrationFiles(root);
  const oldLock = readLock(root);
  const manifest = buildManifest(files, oldLock);
  fs.writeFileSync(path.join(root, LOCK_REL), `${JSON.stringify(manifest, null, 2)}\n`);
  const result = runCheck({ root });
  return { ...result, wrote: true };
}

function findRepoRoot(startDir) {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, MIGRATIONS_REL))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function main() {
  const args = process.argv.slice(2);
  const opts = { update: false, json: false, all: false, baseRef: null, root: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--update') opts.update = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--all') opts.all = true;
    else if (a === '--base-ref') opts.baseRef = args[++i];
    else if (a === '--root') opts.root = args[++i];
    else {
      console.error(`未知参数: ${a}`);
      console.error(
        '用法: node scripts/check-migrations.mjs [--update] [--all] [--base-ref <ref>] [--json] [--root <dir>]'
      );
      process.exit(2);
    }
  }
  if (opts.baseRef !== null && (!opts.baseRef || opts.baseRef.startsWith('--'))) {
    console.error('--base-ref 需要一个 git ref 参数');
    process.exit(2);
  }

  const root = opts.root ? path.resolve(opts.root) : findRepoRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (!root) {
    console.error(`无法定位仓库根目录（未找到 ${MIGRATIONS_REL}）`);
    process.exit(2);
  }

  if (opts.all) {
    // 审计模式：盘点全部危险发现（含存量豁免/已声明），只报告不改变门禁结论
    const result = runAudit({ root });
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      for (const e of result.scanErrors) console.error(`  ! ${e}`);
      const byStatus = { unacknowledged: [], grandfathered: [], acked: [] };
      for (const f of result.findings) byStatus[f.status].push(f);
      for (const [status, list] of Object.entries(byStatus)) {
        if (list.length === 0) continue;
        console.log(`\n[${status}] ${list.length} 条:`);
        for (const f of list) console.log(`  - ${f.path} [${f.rule}] ${f.detail}`);
      }
      console.log(
        `\n审计完成：${result.fileCount} 个迁移文件，共 ${result.findings.length} 条危险发现` +
          `（未声明 ${byStatus.unacknowledged.length} / 存量豁免 ${byStatus.grandfathered.length} / 注解声明 ${byStatus.acked.length}）`
      );
    }
    process.exit(0);
  }

  const result = opts.update ? runUpdate({ root }) : runCheck({ root, baseRef: opts.baseRef });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    if (result.wrote) console.log(`已写入 ${LOCK_REL}`);
    if (result.baseRefSkipped) console.log(`base ref 上尚无 manifest，跳过不可变性校验`);
    if (result.ok) {
      console.log(`✅ 迁移静态门禁通过（${result.fileCount} 个迁移文件）`);
    } else {
      console.error(`❌ 迁移静态门禁失败，共 ${result.errors.length} 个问题:\n`);
      for (const e of result.errors) console.error(`  - ${e}`);
    }
  }
  process.exit(result.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
