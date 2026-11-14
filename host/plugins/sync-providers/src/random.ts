/**
 * 随机标识（临时文件名、租约/声明 nonce、版本 id 后缀）。用标准 Web Crypto（Node、Electron、
 * WebView 均提供 `globalThis.crypto`），输出格式与 `node:crypto` 的 `randomBytes(n).toString('hex')`、
 * `randomUUID()` 相同。
 */

/** `n` 个随机字节的小写十六进制（长度 `2n`）。 */
export function randomHex(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  let out = '';
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0');
  return out;
}

/** RFC 4122 v4 UUID（小写、带连字符）。 */
export function randomUuid(): string {
  return crypto.randomUUID();
}
