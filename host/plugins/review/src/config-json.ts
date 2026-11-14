/**
 * `anki_decks.config_json` 的 serde_json `Value` 读改写（dstu-anki 开启 `arbitrary_precision`，
 * 应用图统一打开 `preserve_order`）。
 *
 * - 读取：`serde_json::from_str::<Value>(s).ok()` 且须为对象，否则 `{}`；数字保留原文本，
 *   以 `JSON.rawJSON` 原样写回。
 * - `json!(f64)`：zmij 格式（整数值补 `.0`，如 `525600.0`）；非有限值为 `null`。
 * - `Map::remove`：preserve_order 下等价 `swap_remove`（末项移到被删位置）。
 *
 * W13 的通用 `host/platform/serde-compat` 落地后由它统一替换这里的就地实现。
 */
import { ryuFormat } from '../../../platform/util/portable.ts';
import { JsonNumberToken, parseSerdeJson } from './serde-json.ts';

const rawJSON = (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON;

export type ConfigObject = Record<string, unknown>;

export function readConfigObjectExact(raw: string | null): ConfigObject {
  if (raw === null) return {};
  const parsed = parseSerdeJson(raw);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed) || parsed instanceof JsonNumberToken) return {};
  return rawNumbers(parsed) as ConfigObject;
}

function rawNumbers(value: unknown): unknown {
  if (value instanceof JsonNumberToken) return rawJSON(value.source);
  if (Array.isArray(value)) return value.map(rawNumbers);
  if (typeof value === 'object' && value !== null) {
    const out: ConfigObject = {};
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, key, { value: rawNumbers(item), enumerable: true, writable: true, configurable: true });
    }
    return out;
  }
  return value;
}

/** `serde_json::json!(v)` for an `f64`. */
export function f64Json(value: number): unknown {
  return Number.isFinite(value) ? rawJSON(ryuFormat(value)) : null;
}

/** `Map::remove(key)` under `preserve_order`（indexmap `swap_remove`）。返回新对象。 */
export function swapRemove(object: ConfigObject, key: string): ConfigObject {
  if (!Object.hasOwn(object, key)) return object;
  const keys = Object.keys(object);
  const index = keys.indexOf(key);
  const last = keys[keys.length - 1]!;
  if (last !== key) keys[index] = last;
  keys.pop();
  const out: ConfigObject = {};
  for (const name of keys) {
    Object.defineProperty(out, name, { value: object[name], enumerable: true, writable: true, configurable: true });
  }
  return out;
}
