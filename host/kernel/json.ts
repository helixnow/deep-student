/**
 * 结果值的 plain-JSON 检查（debug 模式）与 IPC 线上转换。
 *
 * Rust 命令的返回值经 serde_json 序列化后才到前端；迁移后的值经结构化克隆转发，Map/Set 等
 * 会原样穿过 IPC，与 Tauri 版的前端可见结果不同。debug 下 kernel 拒绝这类值，迫使插件显式转换；
 * 生产环境不拒绝，按 JSON 投影并记告警（{@link plainWireOutput}）。
 *
 * BigInt 不属于“非 JSON”：D3 要求内部保持精确（游标、比较、写库），只在 IPC 线上边界按 Rust
 * serde_json 的数字语义转成 number，见 {@link toWireJson}。
 */

// Node/Electron expose the native brand check; a lookalike { rawJSON } object
// must never be interpreted as serialized input. Keep the ES2023 type target.
const nativeJson = JSON as typeof JSON & {
  isRawJSON?(value: unknown): value is Readonly<{ rawJSON: string }>;
  rawJSON?(text: string): Readonly<{ rawJSON: string }>;
};

const isRawJson = (value: unknown): value is Readonly<{ rawJSON: string }> =>
  typeof nativeJson.isRawJSON === 'function' && nativeJson.isRawJSON(value);

/** 返回第一处非 JSON 值的描述（含路径），全部合法时返回 `null`。BigInt 合法，由线上边界转换。 */
export function findNonJson(value: unknown, path = '$', seen: Set<object> = new Set(), serializeNonFinite = false): string | null {
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      return serializeNonFinite || Number.isFinite(value) ? null : `${path} is ${value} (serde_json serializes non-finite floats as null; convert explicitly)`;
    case 'bigint':
      return null;
    case 'undefined':
      return `${path} is undefined`;
    case 'function':
    case 'symbol':
      return `${path} is a ${typeof value}`;
    case 'object':
      break;
  }
  if (value === null) return null;
  if (isRawJson(value)) return null;
  const obj = value as object;
  if (seen.has(obj)) return `${path} is a circular reference`;
  if (Array.isArray(obj)) {
    seen.add(obj);
    for (let i = 0; i < obj.length; i++) {
      if (!(i in obj)) return `${path}[${i}] is a hole in a sparse array`;
      const item = obj[i];
      if (item === undefined) return `${path}[${i}] is undefined (JSON would turn it into null)`;
      const r = findNonJson(item, `${path}[${i}]`, seen, serializeNonFinite);
      if (r) return r;
    }
    seen.delete(obj);
    return null;
  }
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    const name = (proto as { constructor?: { name?: string } }).constructor?.name ?? 'unknown';
    return `${path} is an instance of ${name}; only plain objects, arrays, strings, finite numbers, booleans and null are allowed`;
  }
  seen.add(obj);
  for (const [key, item] of Object.entries(obj)) {
    // 值为 undefined 的属性等价于 serde `skip_serializing_if` 省略该键，允许。
    if (item === undefined) continue;
    const r = findNonJson(item, `${path}.${key}`, seen, serializeNonFinite);
    if (r) return r;
  }
  seen.delete(obj);
  return null;
}

/** Detect values needing source-preserving JSON: bigint or native raw atoms,
 * including roots and values reachable through the JSON container surface. */
export function hasRawJson(value: unknown, seen = new Set<object>()): boolean {
  if (typeof value === 'bigint') return true;
  if (value === null || typeof value !== 'object') return false;
  if (isRawJson(value)) return true;
  if (seen.has(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return false;
  seen.add(value);
  return Object.values(value).some(item => hasRawJson(item, seen));
}

/**
 * {@link toWireJson} 的旁路标记：遇到函数、symbol 或非普通原型的对象时置位。字节（ArrayBuffer 与其视图）不算：
 * 结构化克隆照常复制，main 的 `encodeBody` 把根上的字节作为 raw body 发出。
 */
export interface WireScan {
  nonPlain: boolean;
}

function isBytes(value: object): boolean {
  return ArrayBuffer.isView(value) || value instanceof ArrayBuffer;
}

/** Actual invoke/event exits only. The optional text and projection share one
 * serialization, retaining raw numeric origin across structured clone. */
export function wireJsonOutput(value: unknown, raw: boolean, scan?: WireScan): { value: unknown; json?: string } {
  if (!raw) return { value: toWireJson(value, new Map(), scan) };
  const json = JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'bigint' ? (typeof nativeJson.rawJSON === 'function' ? nativeJson.rawJSON(item.toString()) : Number(item)) : item);
  return { value: JSON.parse(json), json };
}

export interface PlainWireOutput {
  value: unknown;
  json?: string;
  /** 值不是普通 JSON 时：第一处问题的路径与类型，以及投影结果，供调用方记告警。 */
  projection?: string;
}

/**
 * 命令结果、错误值与事件载荷的线上出口（V08-10）。debug 关闭时不跑 {@link findNonJson}，类实例、Map、Date、函数会
 * 原样交给结构化克隆：函数让 postMessage 抛 DataCloneError，其余到前端成了与 Rust serde 输出不同的形状。这里只靠
 * {@link toWireJson} 顺带的原型检查发现它们，命中时整值改用 {@link toPlainJson} 投影，不抛错；循环引用投影不了，
 * 按原值发送并在描述里说明。
 */
export function plainWireOutput(value: unknown, raw: boolean): PlainWireOutput {
  const scan: WireScan = { nonPlain: false };
  const wire = wireJsonOutput(value, raw, scan);
  if (!scan.nonPlain) return wire;
  const problem = nonPlainPath(value) ?? '$ is not plain JSON';
  try {
    return { value: toPlainJson(value), projection: `${problem}; sent its JSON projection` };
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    return { ...wire, projection: `${problem}; JSON projection failed (${reason}), sent as is` };
  }
}

/** 第一处函数、symbol 或非普通原型对象（字节除外，同 {@link WireScan}）的路径与类型；没有返回 `null`。 */
export function nonPlainPath(value: unknown, path = '$', seen: Set<object> = new Set()): string | null {
  if (typeof value === 'function' || typeof value === 'symbol') return `${path} is a ${typeof value}`;
  if (value === null || typeof value !== 'object' || isRawJson(value) || isBytes(value) || seen.has(value)) return null;
  const proto = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) {
    return `${path} is an instance of ${(proto as { constructor?: { name?: string } }).constructor?.name ?? 'unknown'}`;
  }
  seen.add(value);
  const entries: [string, unknown][] = Array.isArray(value)
    ? value.map((item, i) => [`${path}[${i}]`, item])
    : Object.entries(value).map(([key, item]) => [`${path}.${key}`, item]);
  for (const [itemPath, item] of entries) {
    const found = nonPlainPath(item, itemPath, seen);
    if (found) return found;
  }
  return null;
}

/**
 * 按 `JSON.stringify` 投影成普通 JSON，即前端在 Tauri 版里能看到的形状：有 `toJSON` 的用它（Date → ISO 字符串），
 * Map/Set 成 `{}`，类实例只留自有可枚举属性，函数、symbol 与 `undefined` 属性省略，BigInt 与 rawJSON 原子按
 * {@link toWireJson} 的规则成 number。根值投影不出来（函数、`undefined`）时为 `null`。循环引用抛 TypeError。
 */
export function toPlainJson(value: unknown): unknown {
  const text = JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? Number(item) : item));
  return text === undefined ? null : JSON.parse(text);
}

/**
 * 把内部值复制成 IPC 线上的 JSON 形状（D3）。
 *
 * - `BigInt` → `number`：与 Rust serde_json 输出整数后前端 `JSON.parse` 的精度一致（超过 2^53 时
 *   同样按 IEEE-754 最近偶数舍入）；不修改原对象，内部游标/比较仍保持 BigInt 精确值。
 * - 数组与普通对象递归复制；对象中值为 `undefined` 的属性保留（main 的 `JSON.stringify` 会省略它）。
 * - 其他值原样返回（Map/Set/类实例仍由 {@link findNonJson} 在 debug 下拒绝）；给了 `scan` 时，遇到函数、symbol
 *   或非普通原型的对象置位 `scan.nonPlain`（{@link plainWireOutput} 据此投影）。
 *
 * 只在命令结果、事件载荷、Host 桥等线上边界调用；不要用它预处理内部状态。
 */
export function toWireJson(value: unknown, seen: Map<object, unknown> = new Map(), scan?: WireScan): unknown {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'function' || typeof value === 'symbol') {
    if (scan) scan.nonPlain = true;
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  // serde_json arbitrary_precision writes the token verbatim; the frontend then
  // parses it. Project only here, preserving the original atom for Host users.
  if (isRawJson(value)) return JSON.parse(value.rawJSON);
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const item of value) copy.push(toWireJson(item, seen, scan));
    return copy;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) {
    if (scan && !isBytes(value)) scan.nonPlain = true;
    return value;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    // A legal JSON own key such as "__proto__" must remain a data property.
    Object.defineProperty(copy, key, {
      value: toWireJson((value as Record<string, unknown>)[key], seen, scan),
      enumerable: true, configurable: true, writable: true,
    });
  }
  return copy;
}
