/**
 * 迁移协调器使用的 SQL 文本工具，逐个移植自 `dstu-storage/src/migration/coordinator.rs`：
 * `sqlite3_complete`（SQLite `complete.c` 状态机）、`split_sql_statements`、
 * `strip_leading_sql_trivia`、`is_alter_add_column_statement`、`parse_alter_add_columns`、
 * `extract_column_def`、`find_simple_statement_end`、`find_trigger_statement_end`、
 * `extract_create_table_if_not_exists`、`find_sql_statement_end`、
 * `extract_init_non_table_schema_objects`、`extract_on_target_table`。
 *
 * Rust 实现按 UTF-8 字节下标操作，但所有判断只针对 ASCII 字符，因此在 UTF-16 下标上
 * 逐字符移植结果一致。
 */

// ------------------------------------------------------------------ sqlite3_complete

const TK_SEMI = 0;
const TK_WS = 1;
const TK_OTHER = 2;
const TK_EXPLAIN = 3;
const TK_CREATE = 4;
const TK_TEMP = 5;
const TK_TRIGGER = 6;
const TK_END = 7;

// complete.c `trans[8][8]`
const TRANS: readonly (readonly number[])[] = [
  /* 0 INVALID */ [1, 0, 2, 3, 4, 2, 2, 2],
  /* 1   START */ [1, 1, 2, 3, 4, 2, 2, 2],
  /* 2  NORMAL */ [1, 2, 2, 2, 2, 2, 2, 2],
  /* 3 EXPLAIN */ [1, 3, 3, 2, 4, 2, 2, 2],
  /* 4  CREATE */ [1, 4, 2, 2, 2, 4, 5, 2],
  /* 5 TRIGGER */ [6, 5, 5, 5, 5, 5, 5, 5],
  /* 6    SEMI */ [6, 6, 5, 5, 5, 5, 5, 7],
  /* 7     END */ [1, 7, 5, 5, 5, 5, 5, 5],
];

/** `IdChar`：sqlite3CtypeMap & 0x46 —— 字母、数字、`_`、`$`、以及 UTF-8 多字节（>= 0x80）。 */
function isIdChar(code: number): boolean {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a) ||
    code === 0x5f ||
    code === 0x24 ||
    code >= 0x80
  );
}

/** SQLite `sqlite3_complete`（未定义 SQLITE_OMIT_TRIGGER / SQLITE_OMIT_EXPLAIN）。 */
export function sqliteComplete(sql: string): boolean {
  let state = 0;
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    let token: number;
    switch (ch) {
      case ';':
        token = TK_SEMI;
        break;
      case ' ':
      case '\r':
      case '\t':
      case '\n':
      case '\f':
        token = TK_WS;
        break;
      case '/': {
        if (sql[i + 1] !== '*') {
          token = TK_OTHER;
          break;
        }
        i += 2;
        while (i < n && (sql[i] !== '*' || sql[i + 1] !== '/')) i++;
        if (i >= n) return false;
        i++;
        token = TK_WS;
        break;
      }
      case '-': {
        if (sql[i + 1] !== '-') {
          token = TK_OTHER;
          break;
        }
        while (i < n && sql[i] !== '\n') i++;
        if (i >= n) return state === 1;
        token = TK_WS;
        break;
      }
      case '[': {
        i++;
        while (i < n && sql[i] !== ']') i++;
        if (i >= n) return false;
        token = TK_OTHER;
        break;
      }
      case '`':
      case '"':
      case "'": {
        i++;
        while (i < n && sql[i] !== ch) i++;
        if (i >= n) return false;
        token = TK_OTHER;
        break;
      }
      default: {
        if (isIdChar(ch.charCodeAt(0))) {
          let nId = 1;
          while (i + nId < n && isIdChar(sql.charCodeAt(i + nId))) nId++;
          const word = sql.slice(i, i + nId).toLowerCase();
          switch (word) {
            case 'create':
              token = TK_CREATE;
              break;
            case 'trigger':
              token = TK_TRIGGER;
              break;
            case 'temp':
            case 'temporary':
              token = TK_TEMP;
              break;
            case 'end':
              token = TK_END;
              break;
            case 'explain':
              token = TK_EXPLAIN;
              break;
            default:
              token = TK_OTHER;
          }
          i += nId - 1;
        } else {
          token = TK_OTHER;
        }
        break;
      }
    }
    state = TRANS[state]![token]!;
    i++;
  }
  return state === 1;
}

// ------------------------------------------------------------------ 语句切分与分类

/** Rust `str::trim_start` / `trim`：Unicode White_Space（JS 的 trim 额外去掉 U+FEFF，这里排除）。 */
const RUST_WS = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/;

export function rustTrimStart(s: string): string {
  let i = 0;
  while (i < s.length && RUST_WS.test(s[i]!)) i++;
  return s.slice(i);
}

export function rustTrimEnd(s: string): string {
  let j = s.length;
  while (j > 0 && RUST_WS.test(s[j - 1]!)) j--;
  return s.slice(0, j);
}

export function rustTrim(s: string): string {
  return rustTrimEnd(rustTrimStart(s));
}

/** `str::trim_end_matches(';')`。 */
function trimEndSemicolons(s: string): string {
  let j = s.length;
  while (j > 0 && s[j - 1] === ';') j--;
  return s.slice(0, j);
}

/** `strip_leading_sql_trivia`。 */
export function stripLeadingSqlTrivia(sql: string): string {
  let rest = rustTrimStart(sql);
  for (;;) {
    if (rest.startsWith('--')) {
      const pos = rest.indexOf('\n');
      if (pos === -1) return '';
      rest = rustTrimStart(rest.slice(pos + 1));
      continue;
    }
    if (rest.startsWith('/*')) {
      const body = rest.slice(2);
      const pos = body.indexOf('*/');
      if (pos === -1) return '';
      rest = rustTrimStart(body.slice(pos + 2));
      continue;
    }
    break;
  }
  return rest;
}

/** Rust `to_uppercase`（Unicode 大写；与 `toUpperCase` 一致，ASCII 判断不受影响）。 */
export function isAlterAddColumnStatement(stmt: string): boolean {
  const upper = stripLeadingSqlTrivia(stmt).toUpperCase();
  return upper.startsWith('ALTER TABLE ') && upper.includes(' ADD COLUMN ');
}

/** `split_sql_statements`：逐字符累积，遇 `;` 用 sqlite3_complete 判定语句完整。 */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  for (const ch of sql) {
    current += ch;
    if (ch !== ';') continue;
    // CString::new 失败（含 NUL）时 Rust `continue`，不判定完整。
    if (current.includes('\0')) continue;
    if (sqliteComplete(current)) {
      const stmt = rustTrim(trimEndSemicolons(rustTrim(current)));
      if (stmt.length > 0) statements.push(stmt);
      current = '';
    }
  }
  const stmt = rustTrim(current);
  if (stmt.length > 0) statements.push(stmt);
  return statements;
}

/** Rust `char::is_alphanumeric`（Alphabetic || Numeric）。 */
const ALNUM = /[\p{Alphabetic}\p{N}]/u;

/** `trim_matches(|c| !c.is_alphanumeric() && c != '_')`。 */
function trimNonIdent(token: string): string {
  const chars = Array.from(token);
  let start = 0;
  let end = chars.length;
  const keep = (c: string) => ALNUM.test(c) || c === '_';
  while (start < end && !keep(chars[start]!)) start++;
  while (end > start && !keep(chars[end - 1]!)) end--;
  return chars.slice(start, end).join('');
}

/** Rust `split_whitespace`。 */
function splitWhitespace(s: string): string[] {
  const out: string[] = [];
  let current = '';
  for (const ch of s) {
    if (RUST_WS.test(ch)) {
      if (current.length > 0) out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** `parse_alter_add_columns`：返回 `[table, column]` 列表。 */
export function parseAlterAddColumns(sql: string): Array<[string, string]> {
  const results: Array<[string, string]> = [];
  for (const stmt of splitSqlStatements(sql)) {
    if (!isAlterAddColumnStatement(stmt)) continue;
    const tokens = splitWhitespace(stripLeadingSqlTrivia(stmt));
    let table: string | undefined;
    let column: string | undefined;
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]!.toUpperCase();
      if (t === 'TABLE' && i + 1 < tokens.length && table === undefined) table = trimNonIdent(tokens[i + 1]!);
      if (t === 'COLUMN' && i + 1 < tokens.length && column === undefined) column = trimNonIdent(tokens[i + 1]!);
    }
    if (table !== undefined && column !== undefined && table.length > 0 && column.length > 0) {
      results.push([table, column]);
    }
  }
  return results;
}

/** `extract_column_def`：`ADD COLUMN <col>` 之后的定义；找不到时为 `TEXT`。 */
export function extractColumnDef(sql: string, targetTable: string, targetColumn: string): string {
  const upperTable = targetTable.toUpperCase();
  const upperColumn = targetColumn.toUpperCase();
  for (const stmt of splitSqlStatements(sql)) {
    if (!isAlterAddColumnStatement(stmt)) continue;
    const trimmed = trimEndSemicolons(rustTrim(stripLeadingSqlTrivia(stmt)));
    const upper = trimmed.toUpperCase();
    if (!upper.includes(upperTable) || !upper.includes(upperColumn)) continue;
    const tokens = splitWhitespace(trimmed);
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i]!.toUpperCase() === 'COLUMN' && i + 1 < tokens.length) {
        const colName = trimNonIdent(tokens[i + 1]!);
        if (colName.toUpperCase() === upperColumn) {
          if (i + 2 < tokens.length) return tokens.slice(i + 2).join(' ');
          return 'TEXT';
        }
      }
    }
  }
  return 'TEXT';
}

/** `replay_migration_without_alter_add_columns` 的 SQL 构造部分。 */
export function sqlWithoutAlterAddColumns(sql: string): string {
  let replay = '';
  for (const stmt of splitSqlStatements(sql)) {
    if (isAlterAddColumnStatement(stmt)) continue;
    replay += stmt;
    replay += ';\n';
  }
  return replay;
}

// ------------------------------------------------------------------ init.sql 对象抽取

const ASCII_WS = (c: string | undefined) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f';
const ASCII_ALNUM_US = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_]/.test(c);

/** `find_simple_statement_end`。 */
export function findSimpleStatementEnd(sql: string, from: number): number | undefined {
  let i = from;
  let inSingle = false;
  while (i < sql.length) {
    const c = sql[i];
    if (inSingle) {
      if (c === "'") {
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === ';') return i + 1;
    i++;
  }
  return undefined;
}

/** `find_trigger_statement_end`：独立 token `END` 后的 `;`。 */
export function findTriggerStatementEnd(sql: string, from: number): number | undefined {
  let i = from;
  let inSingle = false;
  while (i < sql.length) {
    const c = sql[i];
    if (inSingle) {
      if (c === "'") {
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === "'") {
      inSingle = true;
    } else if (c === ';') {
      let wordEnd = i;
      while (wordEnd > from && ASCII_WS(sql[wordEnd - 1])) wordEnd--;
      let wordStart = wordEnd;
      while (wordStart > from && ASCII_ALNUM_US(sql[wordStart - 1])) wordStart--;
      if (sql.slice(wordStart, wordEnd).toUpperCase() === 'END') {
        return i + 1;
      }
    }
    i++;
  }
  return undefined;
}

/** Rust `sql.to_ascii_uppercase()`（只改 ASCII，保持下标对齐）。 */
export function asciiUpper(s: string): string {
  return s.replace(/[a-z]/g, (c) => c.toUpperCase());
}

function leadingWsLen(s: string, from: number): number {
  let i = from;
  while (i < s.length && RUST_WS.test(s[i]!)) i++;
  return i - from;
}

/** 名称：从 `start` 起连续的 `[A-Za-z0-9_]`。 */
function identLen(s: string, start: number, end = s.length): number {
  let i = start;
  while (i < end && ASCII_ALNUM_US(s[i])) i++;
  return i - start;
}

/** `find_sql_statement_end`：从 `(` 起配对括号，返回 `)`（及其后可选 `;`）之后的位置。 */
export function findSqlStatementEnd(sql: string, openParen: number): number | undefined {
  let depth = 0;
  let i = openParen;
  let inSingle = false;
  while (i < sql.length) {
    const c = sql[i];
    if (inSingle) {
      if (c === "'") {
        if (sql[i + 1] === "'") {
          i += 2;
          continue;
        }
        inSingle = false;
      }
      i++;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) {
        i++;
        while (i < sql.length && ASCII_WS(sql[i])) i++;
        if (i < sql.length && sql[i] === ';') return i + 1;
        return i;
      }
    }
    i++;
  }
  return undefined;
}

/** `extract_create_table_if_not_exists`：`[表名, 语句]`，排除 VIRTUAL TABLE。 */
export function extractCreateTableIfNotExists(sql: string): Array<[string, string]> {
  const MARKER = 'CREATE TABLE IF NOT EXISTS';
  const results: Array<[string, string]> = [];
  const upper = asciiUpper(sql);
  let pos = 0;
  for (;;) {
    const start = upper.indexOf(MARKER, pos);
    if (start === -1) break;
    const lookbackStart = Math.max(0, start - 16);
    if (upper.slice(lookbackStart, start).includes('VIRTUAL')) {
      pos = start + MARKER.length;
      continue;
    }
    const afterMarker = start + MARKER.length;
    const nameStart = afterMarker + leadingWsLen(sql, afterMarker);
    const name = sql.slice(nameStart, nameStart + identLen(sql, nameStart));
    if (name.length === 0) {
      pos = afterMarker;
      continue;
    }
    const openRel = sql.indexOf('(', afterMarker);
    if (openRel === -1) break;
    const end = findSqlStatementEnd(sql, openRel);
    if (end === undefined) break;
    results.push([name, rustTrim(sql.slice(start, end))]);
    pos = end;
  }
  return results;
}

/** `extract_on_target_table`：`[from, end)` 中 ` ON <table>` 的表名。 */
export function extractOnTargetTable(sql: string, upper: string, from: number, end: number): string | undefined {
  const rel = upper.slice(from, end).indexOf(' ON ');
  if (rel === -1) return undefined;
  const afterOn = from + rel + 4;
  const segment = sql.slice(afterOn, end);
  const tableStart = afterOn + (segment.length - rustTrimStart(segment).length);
  const len = identLen(sql, tableStart, end);
  if (len === 0) return undefined;
  return sql.slice(tableStart, tableStart + len);
}

export interface InitSchemaObject {
  masterType: 'index' | 'view' | 'table' | 'trigger';
  name: string;
  targetTable: string | undefined;
  statement: string;
}

/** `extract_init_non_table_schema_objects`。 */
export function extractInitNonTableSchemaObjects(sql: string): InitSchemaObject[] {
  const MARKERS: Array<[string, InitSchemaObject['masterType'], boolean]> = [
    ['CREATE UNIQUE INDEX IF NOT EXISTS', 'index', false],
    ['CREATE INDEX IF NOT EXISTS', 'index', false],
    ['CREATE VIEW IF NOT EXISTS', 'view', false],
    ['CREATE VIRTUAL TABLE IF NOT EXISTS', 'table', false],
    ['CREATE TRIGGER IF NOT EXISTS', 'trigger', true],
  ];
  const upper = asciiUpper(sql);
  const results: InitSchemaObject[] = [];
  let pos = 0;
  for (;;) {
    const start = upper.indexOf('CREATE ', pos);
    if (start === -1) break;
    const entry = MARKERS.find(([marker]) => upper.startsWith(marker, start));
    if (entry === undefined) {
      pos = start + 'CREATE '.length;
      continue;
    }
    const [marker, masterType, isTrigger] = entry;
    const afterMarker = start + marker.length;
    const nameStart = afterMarker + leadingWsLen(sql, afterMarker);
    const nameLen = identLen(sql, nameStart);
    const name = sql.slice(nameStart, nameStart + nameLen);
    if (name.length === 0) {
      pos = afterMarker;
      continue;
    }
    const scanFrom = nameStart + nameLen;
    const end = isTrigger ? findTriggerStatementEnd(sql, scanFrom) : findSimpleStatementEnd(sql, scanFrom);
    if (end === undefined) break;
    const targetTable =
      masterType === 'index' || masterType === 'trigger' ? extractOnTargetTable(sql, upper, scanFrom, end) : undefined;
    results.push({ masterType, name, targetTable, statement: rustTrim(sql.slice(start, end)) });
    pos = end;
  }
  return results;
}
