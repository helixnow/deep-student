/**
 * 参数绑定计划：把 rusqlite 风格的参数（位置数组对应 `?` / `?NNN` / `:name` 的**参数索引**）
 * 转换成 better-sqlite3 的绑定形式。
 *
 * better-sqlite3 把 `?NNN` 当作名为 `NNN` 的命名参数，且位置数组只绑定匿名 `?`；rusqlite
 * `params![a, b]` 则按 SQLite 参数索引（1 起）逐个绑定。这里按 SQLite 的索引分配规则
 * （`?NNN` → NNN；`?` → 当前最大索引 + 1；命名参数首次出现 → 最大索引 + 1，重复出现复用）
 * 从 SQL 文本求出每个索引对应的参数名，再把数组转换成 `{ 名字: 值 }` + 匿名值列表。
 */
import type { SqlParam, SqlParams } from './api.ts';
import { StorageError } from './errors.ts';

/** better-sqlite3 accepts any Uint8Array view as a BLOB, binding exactly its byteOffset..byteLength range. */
export type BindValue = null | number | bigint | string | Uint8Array;

export interface ParamSlot {
  /** SQLite 参数索引（1 起）。 */
  index: number;
  /** better-sqlite3 侧的命名键（`?NNN` → `NNN`，`:x`/`@x`/`$x` → `x`）；匿名 `?` 为 null。 */
  key: string | null;
}

export interface ParamPlan {
  /** 按出现顺序的唯一参数槽。 */
  slots: ParamSlot[];
  /** 参数个数（= sqlite3_bind_parameter_count）。 */
  count: number;
  hasAnonymous: boolean;
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uFFFF]/;

/** 从 SQL 文本中按 SQLite tokenizer 规则提取参数（跳过字符串、引用标识符与注释）。 */
export function planParams(sql: string): ParamPlan {
  const slots: ParamSlot[] = [];
  const byKey = new Map<string, number>();
  let max = 0;
  let hasAnonymous = false;
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(sql, i, c);
      continue;
    }
    if (c === '[') {
      const end = sql.indexOf(']', i + 1);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (c === '?') {
      let j = i + 1;
      while (j < n && sql[j]! >= '0' && sql[j]! <= '9') j++;
      if (j === i + 1) {
        max += 1;
        hasAnonymous = true;
        slots.push({ index: max, key: null });
      } else {
        const digits = sql.slice(i + 1, j);
        const index = Number(digits);
        const key = String(index);
        if (!byKey.has(key)) {
          byKey.set(key, index);
          slots.push({ index, key: digits });
        }
        if (index > max) max = index;
      }
      i = j;
      continue;
    }
    if ((c === ':' || c === '@' || c === '$') && i + 1 < n && IDENT_CHAR.test(sql[i + 1]!)) {
      let j = i + 1;
      while (j < n && IDENT_CHAR.test(sql[j]!)) j++;
      // `::` 之类不是参数；`$` 允许 `$a::b(c)` 的 TCL 语法，better-sqlite3 已禁用 TCL 变量，这里只认标识符。
      const key = sql.slice(i + 1, j);
      const full = c + key;
      if (!byKey.has(full)) {
        max += 1;
        byKey.set(full, max);
        slots.push({ index: max, key });
      }
      i = j;
      continue;
    }
    i++;
  }
  return { slots, count: max, hasAnonymous };
}

function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < sql.length) {
    if (sql[i] === quote) {
      if (sql[i + 1] === quote) {
        i += 2;
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

function toBindValue(value: SqlParam | undefined, where: string): BindValue {
  if (value === undefined) {
    throw new StorageError('INVALID_PARAM', `SQL parameter ${where} is undefined`);
  }
  if (value === null) return null;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'string') {
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Uint8Array) return value;
  throw new StorageError('INVALID_PARAM', `SQL parameter ${where} has unsupported type ${typeof value}`);
}

/**
 * rusqlite 的参数个数 / 类型校验与文案，按出现顺序对每个参数槽回调一次已转换的值。
 * 驱动无关：桌面据此组装 better-sqlite3 实参，SQLite WASM 可按 `slot.index` 直接 `bind`。
 */
export function forEachBinding(
  plan: ParamPlan,
  params: SqlParams | undefined,
  bind: (slot: ParamSlot, value: BindValue) => void,
): void {
  if (params === undefined) {
    if (plan.count > 0) {
      throw new StorageError('INVALID_PARAM', `Wrong number of parameters passed to query. Got 0, needed ${plan.count}`);
    }
    return;
  }
  if (Array.isArray(params)) {
    const list = params as readonly SqlParam[];
    if (list.length !== plan.count) {
      throw new StorageError(
        'INVALID_PARAM',
        `Wrong number of parameters passed to query. Got ${list.length}, needed ${plan.count}`,
      );
    }
    for (const slot of plan.slots) bind(slot, toBindValue(list[slot.index - 1], `#${slot.index}`));
    return;
  }
  const record = params as Readonly<Record<string, SqlParam>>;
  for (const slot of plan.slots) {
    if (slot.key === null) {
      throw new StorageError('INVALID_PARAM', 'Anonymous "?" parameters require an array of values');
    }
    bind(slot, toBindValue(record[slot.key], `"${slot.key}"`));
  }
}

const INT64_LIMIT = 2 ** 63;

/**
 * better-sqlite3 把所有 JS number 绑定为 REAL；rusqlite 的 i64 / bool（以及 sqlite-wasm 的整数）走 INTEGER。
 * 整数值改用 bigint 交给 better-sqlite3，否则 TEXT 列写出 "5.0"、JSON 函数写出 `5.0`，Rust 按 i64 读取会失败。
 */
function toDesktopBindValue(value: BindValue): BindValue {
  if (typeof value === 'number' && Number.isInteger(value) && value >= -INT64_LIMIT && value < INT64_LIMIT) {
    return BigInt(value);
  }
  return value;
}

/** 生成 better-sqlite3 `stmt.get(...args)` 的实参列表。 */
export function bindArgs(plan: ParamPlan, params: SqlParams | undefined): unknown[] {
  const named: Record<string, BindValue> = {};
  const anonymous: BindValue[] = [];
  let hasNamed = false;
  forEachBinding(plan, params, (slot, raw) => {
    const value = toDesktopBindValue(raw);
    if (slot.key === null) {
      anonymous.push(value);
    } else {
      named[slot.key] = value;
      hasNamed = true;
    }
  });
  return hasNamed ? [named, ...anonymous] : anonymous;
}
