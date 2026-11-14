/**
 * `dstu-storage/src/migration/script_checker.rs`：迁移脚本静态检查器（反模式检测 + 危险 SQL 识别）。
 * 规则、文案与 Rust 一致。Rust regex 的 `\w` 是 Unicode 单词字符，这里用等价的 Unicode 属性类。
 */
import { rustTrim } from './sql-text.ts';

/** Rust regex `\w`（Alphabetic | M | Nd | Pc | Join_Control）。 */
const W = '[\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}]';
const re = (source: string, flags = '') => new RegExp(source.replaceAll('\\w', W), `u${flags}`);

const RE_CREATE_NEW_TABLE = re('CREATE\\s+TABLE\\s+(\\w+_NEW)\\s*\\(', 'gi');
const RE_ALL_CREATES = re('CREATE\\s+TABLE\\s+(\\w+)\\s*\\(', 'g');
const RE_SAFE_CREATES = re('CREATE\\s+TABLE\\s+IF\\s+NOT\\s+EXISTS\\s+(\\w+)', 'g');
const RE_FOREIGN_KEY = re('FOREIGN\\s+KEY\\s*\\(\\s*(\\w+)\\s*\\)\\s*REFERENCES\\s+(\\w+)\\s*\\(\\s*(\\w+)\\s*\\)', 'g');
const RE_ALL_DROPS = re('DROP\\s+TABLE\\s+(\\w+)', 'g');
const RE_SAFE_DROPS = re('DROP\\s+TABLE\\s+IF\\s+EXISTS\\s+(\\w+)', 'g');
const RE_ALL_INDEXES = re('CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+(\\w+)\\s+ON', 'g');
const RE_SAFE_INDEXES = re('CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+(\\w+)', 'g');

export interface CheckIssue {
  readonly rule: string;
  readonly message: string;
  readonly suggestion: string;
}

export class CheckResult {
  passed = true;
  readonly warnings: CheckIssue[] = [];
  readonly errors: CheckIssue[] = [];

  addWarning(warning: CheckIssue): void {
    this.warnings.push(warning);
  }

  addError(error: CheckIssue): void {
    this.passed = false;
    this.errors.push(error);
  }
}

/** Rust `str::lines`：按 `\n` 切分并去掉行尾 `\r`，末尾空行不产出。 */
function rustLines(s: string): string[] {
  if (s.length === 0) return [];
  const parts = s.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function captures(regex: RegExp, text: string): RegExpExecArray[] {
  regex.lastIndex = 0;
  return [...text.matchAll(regex)] as RegExpExecArray[];
}

export class MigrationScriptChecker {
  private readonly skippedRules = new Set<string>();

  check(scriptName: string, sql: string): CheckResult {
    const result = new CheckResult();
    this.parseSkipMarkers(sql);
    const normalized = this.normalizeSql(sql);
    const isInitScript = scriptName.endsWith('__init') || scriptName.endsWith('__init.sql') || scriptName.includes(':init');
    if (!this.isSkipped('table_rebuild_cleanup') && !isInitScript) this.checkTableRebuildCleanup(scriptName, normalized, sql, result);
    if (!this.isSkipped('idempotent_create') && !isInitScript) this.checkIdempotentCreate(scriptName, normalized, result);
    if (!this.isSkipped('fk_orphan_cleanup') && !isInitScript) this.checkFkOrphanCleanup(scriptName, normalized, sql, result);
    if (!this.isSkipped('idempotent_drop') && !isInitScript) this.checkIdempotentDrop(scriptName, normalized, result);
    if (!this.isSkipped('idempotent_index') && !isInitScript) this.checkIdempotentIndex(scriptName, normalized, result);
    return result;
  }

  private parseSkipMarkers(sql: string): void {
    this.skippedRules.clear();
    for (const line of rustLines(sql)) {
      const trimmed = rustTrim(line);
      if (trimmed.startsWith('-- @skip-check:')) {
        let rest = trimmed;
        while (rest.startsWith('-- @skip-check:')) rest = rest.slice('-- @skip-check:'.length);
        this.skippedRules.add(rustTrim(rest));
      }
    }
  }

  private isSkipped(rule: string): boolean {
    return this.skippedRules.has(rule) || this.skippedRules.has('all');
  }

  /** `normalize_sql`：去掉 `--` 行注释与 `/* *\/` 块注释、删空行、转大写。 */
  normalizeSql(sql: string): string {
    let result = '';
    let inBlockComment = false;
    for (const line of rustLines(sql)) {
      const chars = Array.from(line);
      let lineResult = '';
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i]!;
        const next = chars[i + 1];
        if (inBlockComment) {
          if (c === '*' && next === '/') {
            i++;
            inBlockComment = false;
          }
        } else if (c === '-' && next === '-') {
          break;
        } else if (c === '/' && next === '*') {
          i++;
          inBlockComment = true;
        } else {
          lineResult += c;
        }
      }
      if (rustTrim(lineResult).length > 0) {
        result += lineResult;
        result += '\n';
      }
    }
    return result.toUpperCase();
  }

  private checkTableRebuildCleanup(scriptName: string, normalized: string, original: string, result: CheckResult): void {
    for (const cap of captures(RE_CREATE_NEW_TABLE, normalized)) {
      const tableName = cap[1] ?? '';
      const lower = tableName.toLowerCase();
      if (normalized.includes(`DROP TABLE IF EXISTS ${tableName}`)) continue;
      const hasStep0Comment = original.includes('STEP 0') || original.includes('中间状态清理');
      if (hasStep0Comment) {
        result.addWarning({
          rule: 'table_rebuild_cleanup',
          message: `[${scriptName}] 创建了临时表 ${lower} 但未找到对应的 DROP TABLE IF EXISTS`,
          suggestion: `在脚本开头添加: DROP TABLE IF EXISTS ${lower};`,
        });
      } else {
        result.addError({
          rule: 'table_rebuild_cleanup',
          message: `[${scriptName}] 创建了临时表 ${lower} 但未先清理中间状态`,
          suggestion: `在脚本开头添加:\n-- STEP 0: 中间状态清理\nDROP TABLE IF EXISTS ${lower};`,
        });
      }
    }
  }

  private checkIdempotentCreate(scriptName: string, normalized: string, result: CheckResult): void {
    const safe = new Set(captures(RE_SAFE_CREATES, normalized).map((c) => c[1]!));
    for (const cap of captures(RE_ALL_CREATES, normalized)) {
      const tableName = cap[1] ?? '';
      const lower = tableName.toLowerCase();
      if (tableName.endsWith('_NEW')) continue;
      if (safe.has(tableName)) continue;
      result.addWarning({
        rule: 'idempotent_create',
        message: `[${scriptName}] CREATE TABLE ${lower} 未使用 IF NOT EXISTS，可能导致重复执行失败`,
        suggestion: `改为: CREATE TABLE IF NOT EXISTS ${lower} (...)`,
      });
    }
  }

  private checkFkOrphanCleanup(scriptName: string, normalized: string, original: string, result: CheckResult): void {
    const creates: Array<[number, number, string]> = [];
    for (const cap of [...captures(RE_ALL_CREATES, normalized), ...captures(RE_SAFE_CREATES, normalized)]) {
      const name = cap[1];
      if (name === undefined) continue;
      const rel = normalized.slice(cap.index).indexOf('(');
      if (rel === -1) continue;
      const open = rel + cap.index;
      const bodyEnd = MigrationScriptChecker.findMatchingParen(normalized, open) ?? normalized.length;
      creates.push([open, bodyEnd, name]);
    }
    // Rust `sort_by_key`（稳定）
    creates.sort((a, b) => a[0] - b[0]);

    for (const cap of captures(RE_FOREIGN_KEY, normalized)) {
      const fkPos = cap.index;
      let owner: string | undefined;
      for (let i = creates.length - 1; i >= 0; i--) {
        const [open, end, name] = creates[i]!;
        if (fkPos > open && fkPos < end) {
          owner = name;
          break;
        }
      }
      if (owner !== undefined && !owner.endsWith('_NEW')) continue;

      const childCol = cap[1] ?? '';
      const parentTable = cap[2] ?? '';
      const childLower = childCol.toLowerCase();
      const parentLower = parentTable.toLowerCase();
      const hasNotIn = normalized.includes(`${childCol} NOT IN`) && normalized.includes(`FROM ${parentTable}`);
      const hasNotExists = normalized.includes('NOT EXISTS') && normalized.includes(`FROM ${parentTable}`);
      const hasCleanupComment =
        original.includes('STEP 1') || original.includes('数据完整性') || original.includes('孤儿') || original.includes('orphan');
      if (hasNotIn || hasNotExists) continue;
      if (hasCleanupComment) {
        result.addWarning({
          rule: 'fk_orphan_cleanup',
          message: `[${scriptName}] 添加了外键约束 table.${childLower} -> ${parentLower}，请确保已清理孤儿数据`,
          suggestion: '确保在 STEP 1 中有清理孤儿数据的逻辑',
        });
      } else {
        result.addError({
          rule: 'fk_orphan_cleanup',
          message: `[${scriptName}] 添加了外键约束但未清理可能存在的孤儿数据`,
          suggestion: `在创建表之前添加:\n-- STEP 1: 数据完整性修复\nDELETE FROM <child_table> WHERE ${childLower} NOT IN (SELECT id FROM ${parentLower});`,
        });
      }
    }
  }

  /** `find_matching_paren`。 */
  static findMatchingParen(text: string, open: number): number | undefined {
    if (text[open] !== '(') return undefined;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      const c = text[i];
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) return i;
      }
    }
    return undefined;
  }

  private checkIdempotentDrop(scriptName: string, normalized: string, result: CheckResult): void {
    const safe = new Set(captures(RE_SAFE_DROPS, normalized).map((c) => c[1]!));
    for (const cap of captures(RE_ALL_DROPS, normalized)) {
      const tableName = cap[1] ?? '';
      const lower = tableName.toLowerCase();
      if (tableName === 'IF') continue;
      if (safe.has(tableName)) continue;
      const newTable = `${tableName}_NEW`;
      if (normalized.includes(`CREATE TABLE ${newTable}`) || normalized.includes(`RENAME TO ${tableName}`)) continue;
      result.addWarning({
        rule: 'idempotent_drop',
        message: `[${scriptName}] DROP TABLE ${lower} 未使用 IF EXISTS`,
        suggestion: `改为: DROP TABLE IF EXISTS ${lower}`,
      });
    }
  }

  private checkIdempotentIndex(scriptName: string, normalized: string, result: CheckResult): void {
    const safe = new Set(captures(RE_SAFE_INDEXES, normalized).map((c) => c[1]!));
    for (const cap of captures(RE_ALL_INDEXES, normalized)) {
      const indexName = cap[1] ?? '';
      const lower = indexName.toLowerCase();
      if (indexName === 'IF') continue;
      if (safe.has(indexName)) continue;
      if (normalized.includes('DROP TABLE') && normalized.includes('RENAME TO')) continue;
      result.addWarning({
        rule: 'idempotent_index',
        message: `[${scriptName}] CREATE INDEX ${lower} 未使用 IF NOT EXISTS`,
        suggestion: `改为: CREATE INDEX IF NOT EXISTS ${lower} ON ...`,
      });
    }
  }
}

// ------------------------------------------------------------------ 危险 SQL 静态识别（L1 门禁）

export type DangerRule =
  | 'delete_without_where'
  | 'drop_table'
  | 'drop_column'
  | 'unique_constraint'
  | 'add_not_null_column'
  | 'table_rebuild'
  | 'add_column_backfill';

const DANGER_RULES: readonly DangerRule[] = [
  'delete_without_where',
  'drop_table',
  'drop_column',
  'unique_constraint',
  'add_not_null_column',
  'table_rebuild',
  'add_column_backfill',
];

/** `DangerRule::from_str`。 */
export function dangerRuleFromStr(s: string): DangerRule | undefined {
  return (DANGER_RULES as readonly string[]).includes(s) ? (s as DangerRule) : undefined;
}

export interface DangerFinding {
  readonly rule: DangerRule;
  readonly detail: string;
  readonly acknowledged: boolean;
}

const RE_DELETE_FROM = re('^DELETE\\s+FROM\\s+(\\w+)');
const RE_DROP_TABLE_ANY = re('DROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(\\w+)', 'g');
const RE_DROP_COLUMN = re('ALTER\\s+TABLE\\s+(\\w+)\\s+DROP\\s+COLUMN\\s+(\\w+)', 'g');
const RE_CREATE_UNIQUE_INDEX = re('CREATE\\s+UNIQUE\\s+INDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)');
const RE_CREATE_TABLE_ANY = re('CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(\\w+)');
const RE_ADD_COLUMN = re('ALTER\\s+TABLE\\s+(\\w+)\\s+ADD\\s+COLUMN\\s+');
// Rust regex `\b` 是 Unicode 单词边界
const RE_NOT_NULL = re(`(?<!${W})(?=${W})NOT\\s+NULL(?<=${W})(?!${W})`);
const RE_UPDATE_SET = re(`^UPDATE\\s+(\\w+)\\s+SET(?<=${W})(?!${W})`);
const RE_INSERT_INTO = re('^INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO\\s+(\\w+)');

/** `parse_danger_acks`：返回 [已声明规则, 未知规则名]。 */
export function parseDangerAcks(sql: string): [Set<DangerRule>, string[]] {
  const acks = new Set<DangerRule>();
  const unknown: string[] = [];
  for (const line of rustLines(sql)) {
    const trimmed = rustTrim(line);
    let rest: string | undefined;
    if (trimmed.startsWith('-- @danger-ack:')) rest = trimmed.slice('-- @danger-ack:'.length);
    else if (trimmed.startsWith('-- @allow-data-change:')) rest = trimmed.slice('-- @allow-data-change:'.length);
    if (rest === undefined) continue;
    const rulePart = rest.split('reason')[0] ?? rest;
    for (const raw of rulePart.split(/[ ,\t]/)) {
      const token = rustTrim(raw);
      if (token.length === 0 || token === '=') continue;
      const rule = dangerRuleFromStr(token);
      if (rule !== undefined) acks.add(rule);
      else unknown.push(token);
    }
  }
  return [acks, unknown];
}

/** `strip_string_literals`：单引号字面量替换为 `''`。 */
export function stripStringLiterals(sql: string): string {
  let out = '';
  const chars = Array.from(sql);
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (c !== "'") {
      out += c;
      continue;
    }
    i++;
    while (i < chars.length) {
      if (chars[i] === "'") {
        if (chars[i + 1] === "'") i++;
        else break;
      }
      i++;
    }
    out += "''";
  }
  return out;
}

/** Rust `split_whitespace` + join(' ')。 */
function collapseWhitespace(s: string): string {
  return s.split(/\s+/u).filter((t) => t.length > 0).join(' ');
}

function splitStatements(normalized: string): string[] {
  return normalized
    .split(';')
    .map(collapseWhitespace)
    .filter((s) => s.length > 0);
}

/** `detect_dangerous_statements`。 */
export function detectDangerousStatements(scriptName: string, sql: string): DangerFinding[] {
  const isInit = scriptName.endsWith('__init') || scriptName.endsWith('__init.sql') || scriptName.endsWith(':init');
  if (isInit) return [];
  const [acks] = parseDangerAcks(sql);
  const normalized = stripStringLiterals(new MigrationScriptChecker().normalizeSql(sql));
  const statements = splitStatements(normalized);
  const findings: Array<[DangerRule, string]> = [];
  const addColumnTables = new Set<string>();
  const writeTables = new Set<string>();
  const newTables: string[] = [];
  let hasRenameTo = false;

  for (const stmt of statements) {
    const del = RE_DELETE_FROM.exec(stmt);
    if (del !== null && !stmt.includes('WHERE')) {
      findings.push(['delete_without_where', `DELETE FROM ${del[1]!.toLowerCase()} 没有 WHERE 子句`]);
    }
    for (const cap of captures(RE_DROP_TABLE_ANY, stmt)) {
      const table = cap[1]!;
      if (!table.endsWith('_NEW')) findings.push(['drop_table', `DROP TABLE ${table.toLowerCase()}`]);
    }
    for (const cap of captures(RE_DROP_COLUMN, stmt)) {
      findings.push(['drop_column', `ALTER TABLE ${cap[1]!.toLowerCase()} DROP COLUMN ${cap[2]!.toLowerCase()}`]);
    }
    const uniq = RE_CREATE_UNIQUE_INDEX.exec(stmt);
    if (uniq !== null) findings.push(['unique_constraint', `CREATE UNIQUE INDEX ${uniq[1]!.toLowerCase()}`]);
    const create = RE_CREATE_TABLE_ANY.exec(stmt);
    if (create !== null) {
      const table = create[1]!;
      if (table.endsWith('_NEW')) {
        if (stmt.includes('UNIQUE')) findings.push(['unique_constraint', `重建表 ${table.toLowerCase()} 含 UNIQUE 约束`]);
        newTables.push(table);
      }
    }
    const add = RE_ADD_COLUMN.exec(stmt);
    if (add !== null) {
      const table = add[1]!;
      if (RE_NOT_NULL.test(stmt)) findings.push(['add_not_null_column', `ALTER TABLE ${table.toLowerCase()} ADD COLUMN ... NOT NULL`]);
      addColumnTables.add(table);
    }
    const upd = RE_UPDATE_SET.exec(stmt);
    if (upd !== null) writeTables.add(upd[1]!);
    const ins = RE_INSERT_INTO.exec(stmt);
    if (ins !== null) writeTables.add(ins[1]!);
    if (stmt.includes('RENAME TO')) hasRenameTo = true;
  }

  if (newTables.length > 0 && hasRenameTo) {
    findings.push(['table_rebuild', `表重建流程: ${newTables.map((t) => t.toLowerCase()).join(', ')}`]);
  }
  // Rust 先 to_lowercase 再 sort（按字节序）；这里同样对小写结果排序。
  const backfilled = [...addColumnTables]
    .filter((t) => writeTables.has(t))
    .map((t) => t.toLowerCase())
    .sort((a, b) => (Buffer.compare(Buffer.from(a), Buffer.from(b))));
  if (backfilled.length > 0) findings.push(['add_column_backfill', `ADD COLUMN + 同表回填: ${backfilled.join(', ')}`]);

  return findings.map(([rule, detail]) => ({ rule, detail, acknowledged: acks.has(rule) }));
}

/** `check_migration_script`。 */
export function checkMigrationScript(scriptName: string, sql: string): CheckResult {
  return new MigrationScriptChecker().check(scriptName, sql);
}

/** `assert_migration_script_valid`：有错误时抛出（Rust 为 panic），警告写到 stderr。 */
export function assertMigrationScriptValid(scriptName: string, sql: string): void {
  const result = checkMigrationScript(scriptName, sql);
  const rule = '═'.repeat(60);
  if (!result.passed) {
    let msg = `\n\n❌ 迁移脚本 ${scriptName} 检查失败:\n${rule}\n`;
    for (const error of result.errors) {
      msg += `\n[${error.rule}] ${error.message}\n`;
      msg += `   💡 建议: ${error.suggestion}\n`;
    }
    if (result.warnings.length > 0) {
      msg += '\n⚠️ 警告:\n';
      for (const warning of result.warnings) msg += `   [${warning.rule}] ${warning.message}\n`;
    }
    msg += `\n${rule}\n\n如果确认无问题，可在脚本中添加: -- @skip-check: <rule_name>\n`;
    throw new Error(msg);
  }
  if (result.warnings.length > 0) {
    let out = `\n⚠️ 迁移脚本 ${scriptName} 检查警告:\n`;
    for (const warning of result.warnings) out += `   [${warning.rule}] ${warning.message}\n   💡 ${warning.suggestion}\n`;
    process.stderr.write(out);
  }
}
