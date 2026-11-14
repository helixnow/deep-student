// workspace 共用工具：ULID、UUID、摘要和单调读数；时间解析/格式化归 platform/time。
//
// Rust 依据：
// - `Workspace::generate_id` / `WorkspaceMessage::generate_id` 等使用 `ulid::Ulid::new()`；
import { toHex } from '../../../../platform/crypto/encoding.ts';
import { sha256HexSync } from '../../../../platform/crypto/sync.ts';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeTime(time: number): string {
  let rest = Math.max(0, Math.floor(time));
  const chars = new Array<string>(10);
  for (let index = 9; index >= 0; index--) {
    chars[index] = CROCKFORD[rest % 32] as string;
    rest = Math.floor(rest / 32);
  }
  return chars.join('');
}

function encodeRandom(): string {
  const value = BigInt(`0x${toHex(crypto.getRandomValues(new Uint8Array(10)))}`);
  const chars = new Array<string>(16);
  let rest = value;
  for (let index = 15; index >= 0; index--) {
    chars[index] = CROCKFORD[Number(rest & 31n)] as string;
    rest >>= 5n;
  }
  return chars.join('');
}

/** `ulid::Ulid::new()`：26 字符 Crockford Base32（48 位毫秒 + 80 位随机）。 */
export function ulid(time: number = Date.now()): string {
  return `${encodeTime(time)}${encodeRandom()}`;
}

/** `DateTime::<Utc>::from(std::time::UNIX_EPOCH)` 的 RFC3339 形式。 */
export const EPOCH_RFC3339 = '1970-01-01T00:00:00+00:00';

/** `uuid::Uuid::new_v4().to_string()`。 */
export function newUuidV4(): string {
  return crypto.randomUUID();
}

/** `hex::encode(Sha256::digest(bytes))`（只用于小输入，见 crypto/sync.ts 的性能边界）。 */
export function sha256Hex(value: string | Uint8Array): string {
  return sha256HexSync(value);
}

/** 毫秒时间戳（等价 `Instant::now()` 的可比较单调读数）。 */
export function monotonicMillis(): number {
  return performance.timeOrigin + performance.now();
}
