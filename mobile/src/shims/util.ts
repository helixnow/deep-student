/**
 * `node:util` 在 Worker / 页面中的实现：`format`（Host 日志导出用）、`inspect`（简化版，不保证与 Node 输出逐字相同）、
 * `promisify` / `callbackify`、`inherits`、`deprecate`、`types`，以及全局的 `TextEncoder` / `TextDecoder`。
 */
type Callback = (error: unknown, ...values: unknown[]) => void;

export const promisify = Object.assign(
  <T = unknown>(fn: (...args: any[]) => void): ((...args: any[]) => Promise<T>) => {
    const custom = (fn as unknown as Record<symbol, (...args: any[]) => Promise<T>>)[promisify.custom];
    if (typeof custom === 'function') return custom;
    return function (this: unknown, ...args: unknown[]) {
      return new Promise<T>((resolve, reject) => {
        fn.call(this, ...args, (error: unknown, value: T) => (error ? reject(error) : resolve(value)));
      });
    };
  },
  { custom: Symbol.for('nodejs.util.promisify.custom') },
);

export function callbackify(fn: (...args: any[]) => Promise<unknown>): (...args: any[]) => void {
  return function (this: unknown, ...args: unknown[]) {
    const callback = args.pop() as Callback;
    fn.apply(this, args).then(value => callback(null, value), error => callback(error ?? new Error('Promise was rejected with a falsy value')));
  };
}

export interface InspectOptions { depth?: number | null; colors?: boolean; compact?: boolean | number; breakLength?: number }

function inspectValue(value: unknown, depth: number, seen: Set<object>): string {
  switch (typeof value) {
    case 'string': return depth === 0 ? value : `'${value.replace(/'/g, "\\'")}'`;
    case 'number': return Object.is(value, -0) ? '-0' : String(value);
    case 'bigint': return `${value}n`;
    case 'symbol': return value.toString();
    case 'undefined': return 'undefined';
    case 'function': return `[Function: ${value.name || '(anonymous)'}]`;
  }
  if (value === null) return 'null';
  const object = value as object;
  if (seen.has(object)) return '[Circular *1]';
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (depth > 2) return Array.isArray(value) ? '[Array]' : '[Object]';
  seen.add(object);
  try {
    if (Array.isArray(value)) return `[ ${value.map(item => inspectValue(item, depth + 1, seen)).join(', ')} ]`.replace('[  ]', '[]');
    if (value instanceof Map) return `Map(${value.size}) { ${[...value].map(([k, v]) => `${inspectValue(k, depth + 1, seen)} => ${inspectValue(v, depth + 1, seen)}`).join(', ')} }`;
    if (value instanceof Set) return `Set(${value.size}) { ${[...value].map(item => inspectValue(item, depth + 1, seen)).join(', ')} }`;
    if (ArrayBuffer.isView(value)) return `${value.constructor.name}(${(value as unknown as ArrayLike<unknown>).length ?? value.byteLength}) [ ${Array.from(value as unknown as ArrayLike<number>).join(', ')} ]`;
    const entries = Object.entries(object).map(([key, item]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : `'${key}'`}: ${inspectValue(item, depth + 1, seen)}`);
    const name = object.constructor && object.constructor !== Object ? `${object.constructor.name} ` : '';
    return entries.length ? `${name}{ ${entries.join(', ')} }` : `${name}{}`;
  } finally {
    seen.delete(object);
  }
}

export const inspect = Object.assign(
  (value: unknown, _options?: InspectOptions): string => (typeof value === 'string' ? `'${value}'` : inspectValue(value, 1, new Set())),
  { custom: Symbol.for('nodejs.util.inspect.custom'), defaultOptions: {} as InspectOptions },
);

/** Node `util.format` 的占位符：%s %d %i %f %j %o %O %c %%；多余的参数以空格接在后面。 */
export function format(template?: unknown, ...args: unknown[]): string {
  if (typeof template !== 'string') return [template, ...args].map(item => (typeof item === 'string' ? item : inspect(item))).join(' ');
  if (args.length === 0) return template;
  let index = 0;
  const out = template.replace(/%[sdifjoOc%]/g, (token) => {
    if (token === '%%') return '%';
    if (index >= args.length) return token;
    const arg = args[index++];
    switch (token) {
      case '%s': return typeof arg === 'string' ? arg : typeof arg === 'bigint' ? `${arg}n` : typeof arg === 'object' && arg !== null ? inspect(arg) : String(arg);
      case '%d': return typeof arg === 'bigint' ? `${arg}n` : String(Number(arg));
      case '%i': return typeof arg === 'bigint' ? `${arg}n` : String(Number.parseInt(String(arg), 10));
      case '%f': return String(Number.parseFloat(String(arg)));
      case '%j': try { return JSON.stringify(arg); } catch { return '[Circular]'; }
      case '%c': return '';
      default: return inspect(arg);
    }
  });
  const rest = args.slice(index).map(item => (typeof item === 'string' ? item : inspect(item)));
  return rest.length ? `${out} ${rest.join(' ')}` : out;
}

export function inherits(ctor: { prototype: object; super_?: unknown }, superCtor: { prototype: object }): void {
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype);
}

export function deprecate<T extends (...args: any[]) => unknown>(fn: T, message: string): T {
  let warned = false;
  return function (this: unknown, ...args: unknown[]) {
    if (!warned) {
      warned = true;
      console.warn(`DeprecationWarning: ${message}`);
    }
    return fn.apply(this, args);
  } as T;
}

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  const keysA = Reflect.ownKeys(a);
  const keysB = Reflect.ownKeys(b);
  return keysA.length === keysB.length && keysA.every(key => isDeepStrictEqual((a as Record<PropertyKey, unknown>)[key], (b as Record<PropertyKey, unknown>)[key]));
}

export const types = {
  isPromise: (value: unknown): value is Promise<unknown> => value instanceof Promise,
  isDate: (value: unknown): value is Date => value instanceof Date,
  isRegExp: (value: unknown): value is RegExp => value instanceof RegExp,
  isMap: (value: unknown): value is Map<unknown, unknown> => value instanceof Map,
  isSet: (value: unknown): value is Set<unknown> => value instanceof Set,
  isUint8Array: (value: unknown): value is Uint8Array => value instanceof Uint8Array,
  isTypedArray: (value: unknown): boolean => ArrayBuffer.isView(value) && !(value instanceof DataView),
  isArrayBuffer: (value: unknown): value is ArrayBuffer => value instanceof ArrayBuffer,
  isNativeError: (value: unknown): value is Error => value instanceof Error,
};

const TextEncoderCtor = globalThis.TextEncoder;
const TextDecoderCtor = globalThis.TextDecoder;
export { TextEncoderCtor as TextEncoder, TextDecoderCtor as TextDecoder };

export default {
  promisify, callbackify, inspect, format, inherits, deprecate, isDeepStrictEqual, types,
  TextEncoder: TextEncoderCtor, TextDecoder: TextDecoderCtor,
};
