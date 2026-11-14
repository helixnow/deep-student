// Rust tool outputs are serde_json::Value: an i64 such as L15's `reviewVersion`
// is a Value::Number. Host owners keep exact bigint values, but L04's result
// budget, history and tool-block persistence JSON.stringify the output, so the
// agent-tool boundary carries them as native JSON.rawJSON number atoms.
import type { ToolResultInfo } from '../api.ts';

const nativeJson = JSON as typeof JSON & {
  rawJSON(text: string): unknown;
  isRawJSON(value: unknown): boolean;
};

/** Same reference when the value holds no bigint. */
export function agentJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return nativeJson.rawJSON(value.toString());
  if (value === null || typeof value !== 'object' || nativeJson.isRawJSON(value)) return value;
  if (Array.isArray(value)) {
    let copy: unknown[] | null = null;
    for (let index = 0; index < value.length; index += 1) {
      const item: unknown = value[index];
      const projected = agentJsonValue(item);
      if (projected !== item && copy === null) copy = value.slice(0, index);
      if (copy !== null) copy.push(projected);
    }
    return copy ?? value;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const entries = Object.keys(value).map((key) => {
    const item = (value as Record<string, unknown>)[key];
    return [key, item, agentJsonValue(item)] as const;
  });
  if (entries.every(([, item, projected]) => item === projected)) return value;
  const copy: Record<string, unknown> = {};
  for (const [key, , projected] of entries) {
    // A JSON key such as "__proto__" must stay an own data property.
    Object.defineProperty(copy, key, { value: projected, enumerable: true, configurable: true, writable: true });
  }
  return copy;
}

export function agentToolResult(result: ToolResultInfo): ToolResultInfo {
  const output = agentJsonValue(result.output);
  return output === result.output ? result : { ...result, output };
}
