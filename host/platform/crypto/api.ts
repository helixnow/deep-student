/**
 * `ctx.crypto`：可移植的哈希、HMAC、随机数、AES-GCM 与编码（W14）。
 *
 * 接口只用 `Uint8Array` / `string` / `Promise`，不出现 `Buffer`、`KeyObject`、`Hash` 等 Node 类型；
 * 返回的字节一律是普通 `Uint8Array`（不是 `Buffer` 子类），调用方不能依赖 `.toString('hex')` 之类的
 * Buffer 方法，编码请用本服务的 `toHex` / `toBase64`。
 *
 * 两个实现，行为与输出逐字节一致（`tests/crypto.test.ts` 对两者跑同一套用例）：
 * - 桌面：`index.ts` 的 `createNodeCrypto()`（`node:crypto`）；
 * - Web / 移动端：`web.ts` 的 `createWebCrypto()`。异步方法只用 WebCrypto
 *   （`crypto.subtle`、`getRandomValues`、`randomUUID`）；WebCrypto 没有同步与增量摘要，
 *   `digestSync` / `hmacSync` / `createHasher` 用纯 JS 的 `@noble/hashes`。
 *
 * 选择同步还是异步：一次性的大块数据用异步 `digest`（移动端走原生 WebCrypto）；
 * 必须同步的调用点用 `*Sync`（拿不到 ctx 的 helper 直接 import `sync.ts`）；流式数据用 `createHasher`。
 */

/** WebCrypto 算法名。MD5 不在 WebCrypto 中，不提供。 */
export type DigestAlgorithm = 'SHA-1' | 'SHA-256' | 'SHA-384' | 'SHA-512';

/** 字节或字符串；字符串一律按 UTF-8 编码。 */
export type BinaryInput = Uint8Array | string;

/** 增量摘要（对应 `createHash().update().digest()`）。 */
export interface Hasher {
  update(data: BinaryInput): Hasher;
  /** 结束并返回摘要；之后再调用 `update` / `digest*` 抛 `CryptoError('HasherFinalized')`。 */
  digest(): Uint8Array;
  /** 同 `digest()`，返回小写 hex。 */
  digestHex(): string;
}

/** AES-GCM 认证标签长度（字节）。WebCrypto 与 Node 的交集里常用的 12–16。 */
export type AesGcmTagLength = 12 | 13 | 14 | 15 | 16;

export interface AesGcmParams {
  /** 原始密钥，16 / 24 / 32 字节（AES-128/192/256）。 */
  readonly key: Uint8Array;
  /** nonce，至少 1 字节；推荐 12 字节随机值，同一密钥下不得重复。 */
  readonly iv: Uint8Array;
  readonly additionalData?: Uint8Array;
  /** 默认 16。 */
  readonly tagLength?: AesGcmTagLength;
}

export interface AesGcmEncryptParams extends AesGcmParams {
  readonly plaintext: BinaryInput;
}

export interface AesGcmDecryptParams extends AesGcmParams {
  /** `ciphertext ‖ tag`（WebCrypto 的输出格式，`encrypt` 的返回值）。 */
  readonly ciphertext: Uint8Array;
}

/** `standard`：RFC 4648 §4（`+/`）；`url`：§5（`-_`）；`either`：解码时两套字符都接受。 */
export type Base64Alphabet = 'standard' | 'url' | 'either';

export interface Base64EncodeOptions {
  readonly alphabet?: 'standard' | 'url';
  /** 默认 `standard` 补 `=`、`url` 不补（与 Node 的 `base64` / `base64url` 一致）。 */
  readonly padding?: boolean;
}

export interface Base64DecodeOptions {
  /** 默认 `standard`。 */
  readonly alphabet?: Base64Alphabet;
}

export type CryptoErrorKind =
  | 'InvalidArgument'
  | 'InvalidKey'
  | 'InvalidIv'
  | 'InvalidEncoding'
  | 'DecryptFailed'
  | 'HasherFinalized';

/** 本服务抛出的唯一错误类型；`kind` 跨实现一致，`message` 只用于日志。 */
export class CryptoError extends Error {
  override name = 'CryptoError';
  readonly kind: CryptoErrorKind;
  constructor(kind: CryptoErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export interface CryptoService {
  /** 实现标识，便于日志与诊断；业务逻辑不得据此分支。 */
  readonly implementation: 'node' | 'web';

  // ---- 摘要（异步；WebCrypto `subtle.digest`）
  digest(algorithm: DigestAlgorithm, data: BinaryInput): Promise<Uint8Array>;
  sha256(data: BinaryInput): Promise<Uint8Array>;
  /** 小写 hex。替代各插件里的 `sha256Hex` 副本。 */
  sha256Hex(data: BinaryInput): Promise<string>;
  sha1Hex(data: BinaryInput): Promise<string>;

  // ---- 同步 / 增量摘要
  digestSync(algorithm: DigestAlgorithm, data: BinaryInput): Uint8Array;
  /** 同步 SHA-256；不需要 ctx 的地方直接用 `sync.ts` 的同名纯函数。大数据量的边界见 `sync.ts` 文件头。 */
  sha256Sync(data: BinaryInput): Uint8Array;
  sha256HexSync(data: BinaryInput): string;
  createHasher(algorithm: DigestAlgorithm): Hasher;

  // ---- HMAC
  hmac(algorithm: DigestAlgorithm, key: BinaryInput, data: BinaryInput): Promise<Uint8Array>;
  hmacSync(algorithm: DigestAlgorithm, key: BinaryInput, data: BinaryInput): Uint8Array;

  // ---- 随机（WebCrypto 的 `getRandomValues` / `randomUUID` 本身是同步的）
  /** 密码学安全随机字节；`length` 为非负安全整数。 */
  randomBytes(length: number): Uint8Array;
  /** RFC 4122 v4，小写。 */
  randomUUID(): string;
  /** `[min, max)` 的均匀随机整数（拒绝采样），参数约束同 `node:crypto.randomInt`：安全整数、`max - min < 2^48`。 */
  randomInt(min: number, max: number): number;

  // ---- AES-GCM
  /** 返回 `ciphertext ‖ tag`。 */
  aesGcmEncrypt(params: AesGcmEncryptParams): Promise<Uint8Array>;
  /** 认证失败（密文/标签/AAD/nonce/密钥不符）抛 `CryptoError('DecryptFailed')`。 */
  aesGcmDecrypt(params: AesGcmDecryptParams): Promise<Uint8Array>;

  /** 定长比较；长度不同直接返回 false（长度本身不视为秘密）。 */
  timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean;

  // ---- 编码（与 `encoding.ts` 的纯函数是同一实现，不需要 ctx 时直接 import 那里）
  toHex(bytes: Uint8Array): string;
  /** 偶数长度、只含 `[0-9a-fA-F]`，否则抛 `InvalidEncoding`（不像 Buffer 那样遇错截断）。 */
  fromHex(text: string): Uint8Array;
  toBase64(bytes: Uint8Array, options?: Base64EncodeOptions): string;
  /**
   * WHATWG forgiving-base64：忽略 ASCII 空白，`=` 可省略，出现时必须正确；非字母表字符、
   * 长度余 1 抛 `InvalidEncoding`。需要 Rust `base64::STANDARD` 的严格语义（canonical 填充、
   * 尾随位为 0、逐字错误文案）用 `host/platform/util` 的 `decodeBase64Standard`。
   */
  fromBase64(text: string, options?: Base64DecodeOptions): Uint8Array;
  utf8Encode(text: string): Uint8Array;
  /** 默认把非法序列替换为 U+FFFD（同 Node `toString('utf8')`）；`fatal: true` 时抛 `InvalidEncoding`。 */
  utf8Decode(bytes: Uint8Array, options?: { readonly fatal?: boolean }): string;
}

// 必须引入 Context 才能合并到 cordis 重导出的 Context（而不是新建同名接口）。
import type { Context } from '@deepseek-ai/cordis';
export type { Context };

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** W14：可移植加密服务。 */
    crypto: CryptoService;
  }
}
