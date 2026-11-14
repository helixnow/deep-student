/**
 * serde_json `Map::remove` under the workspace `preserve_order` feature (serde_json 1.0.149 `map.rs:150-162`)
 * is indexmap `swap_remove`: the last entry moves into the removed key's slot. Request bodies built with
 * `Map::remove` therefore reach the wire in that order; `delete` would keep the relative order instead.
 */
type JsonMap = { [key: string]: unknown };

function put(map: JsonMap, key: string, value: unknown): void {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
}

export function removeKey(map: JsonMap, key: string): unknown {
  if (!Object.hasOwn(map, key)) return undefined;
  const value = map[key];
  const keys = Object.keys(map);
  const following = keys.slice(keys.indexOf(key) + 1).map(name => [name, map[name]] as const);
  delete map[key];
  if (following.length === 0) return value;
  for (const [name] of following) delete map[name];
  const [lastName, lastValue] = following[following.length - 1]!;
  put(map, lastName, lastValue);
  for (const [name, item] of following.slice(0, -1)) put(map, name, item);
  return value;
}
