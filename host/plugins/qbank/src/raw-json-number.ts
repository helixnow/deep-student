/**
 * F4 validated `serde_json::Value` number → old frozen `JsonValue`.
 *
 * 整数 token 且精确值落在 JS 安全整数范围时投影为 number，保持既有 typed 整数消费者；
 * 小数/指数/超安全整数保留 F4 公开 `jsonNumberToRawJSON` 的原始数字原子，使
 * `JSON.stringify` 持久化不 Number 舍入、不把 underflow 变 0、不把指数改写成 JS 数字。
 * 这不是第二套 serializer：只决定单个 Value 数字节点的投影。
 */
import type { JsonValue } from '../../../platform/errors/api.ts';
import {
  jsonNumberToRawJSON, parseJsonDocument, type JsonNode, type JsonValueNumber,
} from '../../../platform/util/portable.ts';

const INTEGER_TOKEN = /^-?(?:0|[1-9][0-9]*)$/;
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** `serde_json::Value` 数字节点 → `JsonValue`（安全整数为 number，其余为原生 raw atom）。 */
export function jsonNumberValue(number: JsonValueNumber): JsonValue {
  if (INTEGER_TOKEN.test(number.raw)) {
    const integer = BigInt(number.raw);
    if (integer >= MIN_SAFE && integer <= MAX_SAFE) return Number(integer);
  }
  return jsonNumberToRawJSON(number) as unknown as JsonValue;
}

/**
 * `Value` 数字投影到旧 `JsonValue` 域：安全整数保持 number；小数/指数/超安全整数交给
 * `jsonNumberValue`（F4 `jsonNumberToRawJSON` 原生原子），本地 `JSON.stringify` 持久化
 * 保留原始数字 token。这里不做通用序列化，也不把 raw 加引号或转成 Infinity。
 */
export function nodeToValue(node: JsonNode): JsonValue {
  switch (node.kind) {
    case 'null': return null;
    case 'bool': return node.value;
    case 'string': return node.value;
    case 'number': return jsonNumberValue(node.value);
    case 'array': return node.items.map(nodeToValue);
    case 'object': return Object.fromEntries(node.members.map(member => [member.key, nodeToValue(member.value)]));
  }
}

/** `serde_json::from_str::<Value>`，错误文本为 serde_json Display。 */
export function valueFromStr(text: string): JsonValue {
  return nodeToValue(parseJsonDocument(text));
}

/**
 * 真正 typed/业务边界的原子读取：仅接受 F4 原生 `JSON.rawJSON` 原子（冻结、null 原型），
 * 返回其数值供需要 number 的消费者使用；普通值或非数字返回 null。不要让该转换进入
 * generic Value 持久化路径。
 */
export function rawJsonNumberAsNumber(value: unknown): number | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.getPrototypeOf(value) !== null || !Object.isFrozen(value)) return null;
  const raw = (value as { readonly rawJSON?: unknown }).rawJSON;
  if (typeof raw !== 'string') return null;
  const number = Number(raw);
  return Number.isNaN(number) ? null : number;
}

/** `Value::as_f64`（arbitrary_precision：`parse::<f64>().ok().filter(is_finite)`）：number 与原生数字原子都有值，其余为 null。 */
export function jsonValueAsF64(value: unknown): number | null {
  const number = typeof value === 'number' ? value : rawJsonNumberAsNumber(value);
  return number !== null && Number.isFinite(number) ? number : null;
}

/**
 * Value 树的深拷贝。`structuredClone` 遇到 `JSON.rawJSON` 原子会抛 DataCloneError；
 * 原子本身冻结，原样共享。
 */
export function cloneJsonValue<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => cloneJsonValue(item)) as T;
  if (rawJsonNumberAsNumber(value) !== null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJsonValue(item)])) as T;
}
