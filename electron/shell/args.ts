/**
 * 内置插件命令的参数读取，错误文本对齐 Tauri 的命令参数反序列化（tauri-2.11.5 `src/ipc/command.rs`）：
 * 缺键为 `invalid args `{key}` for command `{cmd}`: command {cmd} missing required key {key}`，
 * 类型不符为 serde_json 的 `invalid type: {unexpected}, expected {expected}`。
 */
import { invalidArgs, missingKey } from './errors.ts';

export interface InvokeInput {
  /** 插件内命令名（不含 `plugin:<name>|` 前缀），与 Tauri 报错中的命令名一致。 */
  command: string;
  /** JSON 载荷解析结果；原始字节载荷时为 null。 */
  json: unknown;
  /** `application/octet-stream` 载荷。 */
  raw: Uint8Array | null;
  headers: Record<string, string>;
}

/** serde `Unexpected` 对 JSON 值的描述。 */
export function describeUnexpected(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'boolean') return `boolean \`${value}\``;
  if (typeof value === 'number') return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  if (Array.isArray(value)) return 'sequence';
  return 'map';
}

function args(input: InvokeInput): Record<string, unknown> {
  const json = input.json;
  return json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
}

function typeError(input: InvokeInput, key: string, value: unknown, expected: string) {
  return invalidArgs(input.command, key, `invalid type: ${describeUnexpected(value)}, expected ${expected}`);
}

export function has(input: InvokeInput, key: string): boolean {
  const v = args(input)[key];
  return v !== undefined && v !== null;
}

export function raw(input: InvokeInput, key: string): unknown {
  return args(input)[key];
}

export function reqString(input: InvokeInput, key: string): string {
  const v = args(input)[key];
  if (v === undefined) throw missingKey(input.command, key);
  if (typeof v !== 'string') throw typeError(input, key, v, 'a string');
  return v;
}

export function optString(input: InvokeInput, key: string): string | null {
  const v = args(input)[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw typeError(input, key, v, 'a string');
  return v;
}

export function reqBool(input: InvokeInput, key: string): boolean {
  const v = args(input)[key];
  if (v === undefined) throw missingKey(input.command, key);
  if (typeof v !== 'boolean') throw typeError(input, key, v, 'a boolean');
  return v;
}

export function optBool(input: InvokeInput, key: string): boolean | null {
  const v = args(input)[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') throw typeError(input, key, v, 'a boolean');
  return v;
}

export function reqNumber(input: InvokeInput, key: string, expected = 'f64'): number {
  const v = args(input)[key];
  if (v === undefined) throw missingKey(input.command, key);
  if (typeof v !== 'number') throw typeError(input, key, v, expected);
  return v;
}

export function reqInteger(input: InvokeInput, key: string, expected = 'u32'): number {
  const v = reqNumber(input, key, expected);
  if (!Number.isInteger(v)) throw typeError(input, key, v, expected);
  return v;
}

export function optInteger(input: InvokeInput, key: string, expected = 'u32'): number | null {
  const v = args(input)[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw typeError(input, key, v, expected);
  return v;
}

export function reqStringArray(input: InvokeInput, key: string): string[] {
  const v = args(input)[key];
  if (v === undefined) throw missingKey(input.command, key);
  if (!Array.isArray(v)) throw typeError(input, key, v, 'a sequence');
  for (const item of v) if (typeof item !== 'string') throw typeError(input, key, item, 'a string');
  return v as string[];
}

export function optObject(input: InvokeInput, key: string): Record<string, unknown> | null {
  const v = args(input)[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw typeError(input, key, v, 'a map');
  return v as Record<string, unknown>;
}

export function reqObject(input: InvokeInput, key: string): Record<string, unknown> {
  const v = args(input)[key];
  if (v === undefined) throw missingKey(input.command, key);
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw typeError(input, key, v, 'a map');
  return v as Record<string, unknown>;
}

/** `__CHANNEL__:<id>`（`Channel` 的 IPC 序列化形式）。 */
export function reqChannel(input: InvokeInput, key: string): number {
  const v = args(input)[key];
  if (v === undefined) throw missingKey(input.command, key);
  if (typeof v === 'string' && v.startsWith('__CHANNEL__:')) {
    const id = Number(v.slice('__CHANNEL__:'.length));
    if (Number.isInteger(id) && id >= 0) return id;
  }
  throw invalidArgs(input.command, key, `invalid type: ${describeUnexpected(v)}, expected a string`);
}
