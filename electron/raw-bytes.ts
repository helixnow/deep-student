/**
 * Host 的 invoke 结果只允许 JSON 值（kernel 的 debug 校验会拒绝 `Uint8Array`），而
 * `read_file_bytes` 的契约结果是 `tauri::ipc::Response` 原始字节。这里用显式信封把字节
 * 以 base64 穿过 JSON 边界，main 的 `ShellRuntime` 在回写前端前解码为 `Uint8Array`
 * （前端仍收到 ArrayBuffer）。
 */
export const RAW_BYTES_FIELD = '__dstuRawBytes';

export interface RawBytesEnvelope {
  readonly [RAW_BYTES_FIELD]: string;
}

export function encodeRawBytes(bytes: Uint8Array): RawBytesEnvelope {
  return { [RAW_BYTES_FIELD]: Buffer.from(bytes).toString('base64') };
}

export function decodeRawBytes(value: unknown): Uint8Array | null {
  if (value === null || typeof value !== 'object') return null;
  const encoded = (value as Record<string, unknown>)[RAW_BYTES_FIELD];
  if (typeof encoded !== 'string') return null;
  return new Uint8Array(Buffer.from(encoded, 'base64'));
}
