/**
 * 设备 ID 的纯函数（`device_id.rs`），不依赖 Node：桌面 `paths/index.ts` 再导出，移动端入口可直接引用。
 */
import { sha256HexSync } from '../crypto/sync.ts';
import { encodeUtf8, rustTrim } from '../util/portable.ts';

const DEVICE_ID_SHORT_HASH_LEN = 16;

export function normalizeDeviceId(deviceId: string): string {
  const trimmed = rustTrim(deviceId);
  const bytes = encodeUtf8(trimmed);
  if (
    trimmed !== '' &&
    bytes.length <= 128 &&
    trimmed !== '.' &&
    trimmed !== '..' &&
    /^[A-Za-z0-9._-]+$/.test(trimmed)
  ) {
    return trimmed;
  }
  return `device-${sha256HexSync(bytes)}`;
}

export function deviceIdShortHash(deviceId: string): string {
  return sha256HexSync(deviceId).slice(0, DEVICE_ID_SHORT_HASH_LEN);
}
