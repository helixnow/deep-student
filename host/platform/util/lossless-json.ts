/**
 * 可无损 JSON（`serde_json::Value` 子集）表示。
 *
 * `sqlite_value_to_json` 区分 SQLite 的 INTEGER 与 REAL：`1` 与 `1.0` 在
 * serde_json 中是两个不相等的 `Number` 变体。JavaScript 的 `number` 无法表达
 * 这一差异，因此：
 * - 超出 `Number.MAX_SAFE_INTEGER` 的 INTEGER 用 `bigint` 保留；
 * - REAL 用 {@link JsonFloat} 标记，序列化为带小数点的字面量（如 `1.0`）。
 *
 * `parseJsonLossless` / `stringifyJsonLossless` 在 JSON 文本边界完成往返，
 * 供导出、导入与 change payload 使用。
 *
 * 可移植叶子：不得导入 Node 模块。`sync/api.ts` 重导出本模块的同一批值；
 * `isJsonFloat` 依赖 `instanceof JsonFloat`，任何副本都会让跨模块判定失效。
 *
 * kernel 的原生数字原子（`JSON.rawJSON`）结构上也满足 `{ [key: string]: DbJson }`。比较、序列化和
 * 投影时原子按 `parseJsonLossless(atom.rawJSON)` 处理，不当成 `{"rawJSON": …}` 对象；
 * `cloneDbJson` 原样保留原子（它不可变）。
 */
export type DbJson =
  | null
  | boolean
  | number
  | bigint
  | string
  | JsonFloat
  | DbJson[]
  | { [key: string]: DbJson };

/** 标记一个来自 SQLite REAL 列（或 JSON 浮点字面量）的值。 */
export class JsonFloat {
  readonly value: number;
  /** serde_json arbitrary_precision decimal representation; never rebuild parsed JSON from value. */
  readonly source: string;

  constructor(value: number, source?: string) {
    this.value = value;
    this.source = source ?? formatFloat(value);
  }
}

export function isJsonFloat(value: unknown): value is JsonFloat {
  return value instanceof JsonFloat;
}

type RawJsonAtom = Readonly<{ rawJSON: string }>;
const nativeJson = JSON as typeof JSON & { isRawJSON?(value: unknown): boolean };

function isRawJsonAtom(value: unknown): value is RawJsonAtom {
  return nativeJson.isRawJSON?.(value) === true;
}

/** 原子换成 `parseJsonLossless` 对同一文本的结果；其他值原样返回。 */
function unwrapAtom<T extends DbJson | undefined>(value: T): DbJson | T {
  return isRawJsonAtom(value) ? parseJsonLossless(value.rawJSON) : value;
}

/** 判断一个值是否为 JSON 对象（排除数组、JsonFloat 与原生数字原子）。 */
export function isJsonObject(value: unknown): value is { [key: string]: DbJson } {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isJsonFloat(value) && !isRawJsonAtom(value);
}

/**
 * 结构相等，保留 serde_json 的数字变体语义：
 * INTEGER `1`（number）≠ REAL `1.0`（JsonFloat）；大整数按数值比较。
 */
export function dbJsonEquals(left: DbJson | undefined, right: DbJson | undefined): boolean {
  if (left === right) return true;
  if (isRawJsonAtom(left) || isRawJsonAtom(right)) return dbJsonEquals(unwrapAtom(left), unwrapAtom(right));
  if (left === undefined || right === undefined || left === null || right === null) return false;
  if (isJsonFloat(left) || isJsonFloat(right)) {
    return isJsonFloat(left) && isJsonFloat(right) && left.source === right.source;
  }
  if (typeof left === 'bigint' || typeof right === 'bigint') {
    if (typeof left === 'bigint' && typeof right === 'bigint') return left === right;
    const integer = typeof left === 'bigint' ? left : right;
    const other = typeof left === 'bigint' ? right : left;
    return typeof other === 'number' && Number.isSafeInteger(other) && BigInt(other) === integer;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => dbJsonEquals(item, right[index]));
  }
  if (typeof left === 'object' && typeof right === 'object') {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(key => Object.hasOwn(right, key) && dbJsonEquals(left[key], right[key]));
  }
  return false;
}

/** 深拷贝（保持对象键顺序与数字变体）。 */
export function cloneDbJson<T extends DbJson>(value: T): T {
  if (value === null || typeof value !== 'object' || isRawJsonAtom(value)) return value;
  if (isJsonFloat(value)) return new JsonFloat(value.value, value.source) as T;
  if (Array.isArray(value)) return value.map(item => cloneDbJson(item)) as T;
  const out: { [key: string]: DbJson } = {};
  for (const [key, item] of Object.entries(value)) out[key] = cloneDbJson(item);
  return out as T;
}

interface SourceContext {
  source?: string;
}

/**
 * 解析 JSON 文本，保留整数/浮点字面量区别与 >2^53 整数。
 *
 * 依赖 ECMAScript `JSON.parse` source access（Node 21+/Chromium 114+）；
 * numeric source 不可用时拒绝解析，不能静默接受已舍入的 Number。
 */
export function parseJsonLossless(text: string): DbJson {
  const reviver = (key: string, value: unknown, context?: SourceContext): unknown => {
    if (typeof value !== 'number') return value;
    const source = context?.source;
    if (source === undefined) throw new Error('Lossless JSON parsing requires JSON.parse source access');
    if (source.includes('.') || source.includes('e') || source.includes('E')) {
      // serde_json 1.0.149 de.rs::scan_exponent: lower-case e and explicit sign.
      const decimal = source.replace(/[eE]([+-]?)([0-9]+)$/u, (_match, sign: string, digits: string) => `e${sign || '+'}${digits}`);
      return new JsonFloat(value, decimal);
    }
    if (!Number.isSafeInteger(value)) return BigInt(source);
    return value;
  };
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown) as DbJson;
}

function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return 'null';
  if (Object.is(value, -0)) return '-0.0';
  const text = String(value);
  return Number.isInteger(value) && !text.includes('e') ? `${text}.0` : text;
}

function stringifyScalar(value: DbJson): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'null';
    return Number.isInteger(value) ? String(value) : formatFloat(value).replace(/\.0$/, '');
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (isJsonFloat(value)) return value.source;
  throw new Error('不是 JSON 标量');
}

/** 序列化为 JSON 文本；`pretty` 与 `serde_json::to_writer_pretty` 的 2 空格风格一致。 */
export function stringifyJsonLossless(value: DbJson, pretty = false): string {
  return [...jsonChunksLossless(value, pretty)].join('');
}

/** Shared token writer: export consumes tokens without materializing the entire document. */
export function* jsonChunksLossless(value: DbJson, pretty = false): Generator<string> {
  function* write(item: DbJson, depth: number): Generator<string> {
    const current = unwrapAtom(item);
    if (current === null || typeof current !== 'object' || isJsonFloat(current)) {
      yield stringifyScalar(current);
      return;
    }
    const indent = pretty ? '\n' + '  '.repeat(depth + 1) : '';
    const closingIndent = pretty ? '\n' + '  '.repeat(depth) : '';
    if (Array.isArray(current)) {
      yield '[';
      for (let index = 0; index < current.length; index++) {
        yield (index === 0 ? '' : ',') + indent;
        yield* write(current[index]!, depth + 1);
      }
      yield (current.length === 0 ? '' : closingIndent) + ']';
      return;
    }
    const entries = Object.entries(current);
    yield '{';
    for (let index = 0; index < entries.length; index++) {
      const [key, item] = entries[index]!;
      yield `${index === 0 ? '' : ','}${indent}${JSON.stringify(key)}:${pretty ? ' ' : ''}`;
      yield* write(item, depth + 1);
    }
    yield (entries.length === 0 ? '' : closingIndent) + '}';
  }
  yield* write(value, 0);
}

/** `DbJson` → 普通 JavaScript 值（用于发布到 IPC 的只读结果）。 */
export function toPlainJson(value: DbJson): unknown {
  if (isRawJsonAtom(value)) return toPlainJson(parseJsonLossless(value.rawJSON));
  if (value === null || typeof value !== 'object') return value;
  if (isJsonFloat(value)) return value.value;
  if (Array.isArray(value)) return value.map(toPlainJson);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) out[key] = toPlainJson(item);
  return out;
}
