/**
 * DSBK 容器的 Web Streams 版加解密：帧格式与 `backup_crypto.rs` 的
 * `encrypt_backup_file_with_key` / `decrypt_backup_file_with_key_provider` 逐字节相同，
 * 读写对象换成 `ReadableStream` / `WritableStream`，错误文案沿用 Rust（读写端错误
 * 的 io 文本由 `describeError` 给出）。
 *
 * 只依赖 Uint8Array、DataView 与 Web Streams；AES-256-GCM 与密钥由调用方注入，
 * 桌面端（Node crypto）与移动端可共用同一份帧逻辑。
 *
 * 流的所有权：调用即锁定两端。成功时读到 EOF 并关闭 output；任何失败都取消 input、
 * 中止 output（同 `pipeTo`），output 侧负责丢弃已写出的部分。交给 output 的分块归
 * output 所有，本模块不再改写；只清零自己持有的明文副本。
 */

/** anyhow 错误（文案同 Rust）。 */
export class BackupCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupCryptoError';
  }
}

export const DSBK_V1_HEADER_LEN = 4 + 1 + 12 + 16 + 12;
export const DSBK_V2_HEADER_LEN = 4 + 1 + 12 + 16 + 7 + 4;
export const DSBK_GCM_TAG_LEN = 16;
/** v2 每块 `chunk(u32 LE)` 在头部的偏移（`DSBK_V2_HEADER_LEN - 4`）。 */
export const DSBK_V2_CHUNK_OFFSET = DSBK_V2_HEADER_LEN - 4;
export const STREAM_PLAINTEXT_CHUNK = 1024 * 1024;
export const DSBK_MAX_PLAINTEXT_CHUNK = 64 * 1024 * 1024;

const MAGIC = Uint8Array.of(0x44, 0x53, 0x42, 0x4b);
const V1 = 1;
const V2 = 2;
const AEAD_FAILED = '备份解密失败（密码错误或数据损坏）: aead::Error';

export interface DsbkAead {
  /** AES-256-GCM 加密，返回 `ciphertext ‖ tag16`。 */
  seal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array | Promise<Uint8Array>;
  /** 认证失败返回 null（aes-gcm `aead::Error`）。 */
  open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array | null | Promise<Uint8Array | null>;
}

/** 按容器头登记的 salt / m / t / p 给出 32 字节密钥；密钥的清零由提供方负责。 */
export type DsbkKeyFor = (salt: Uint8Array, m: number, t: number, p: number) => Promise<Uint8Array>;

export interface DsbkStreamDeps {
  aead: DsbkAead;
  randomBytes(length: number): Uint8Array;
  /** 读写端错误的 io 文本（Rust `io::Error` 的 Display）；默认取 `Error.message`。 */
  describeError?: (error: unknown) => string;
}

export interface DsbkEncryptParams {
  salt: Uint8Array;
  m: number;
  t: number;
  p: number;
}

const defaultDescribe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** `stream_chunk_nonce`：prefix7 ‖ counter_be32 ‖ final_flag。 */
function chunkNonce(prefix: Uint8Array, counter: number, isFinal: boolean): Uint8Array {
  const nonce = new Uint8Array(12);
  nonce.set(prefix.subarray(0, 7), 0);
  new DataView(nonce.buffer).setUint32(7, counter >>> 0, false);
  nonce[11] = isFinal ? 1 : 0;
  return nonce;
}

/** `is_encrypted_backup`：只看 4 字节 DSBK 魔数。 */
export function isEncryptedBackup(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && MAGIC.every((b, i) => bytes[i] === b);
}

function u32le(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, true);
}

/** `std::io::BufReader` 之上的 `read` / `read_exact` 语义：短读即 EOF，空分块不算 EOF。 */
class Source {
  private pending: Uint8Array | null = null;
  private eof = false;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  /** 尽量读满 `size` 字节，返回实际读到的部分；读端错误原样抛出。 */
  async fill(size: number): Promise<Uint8Array> {
    const out = new Uint8Array(size);
    let filled = 0;
    while (filled < size) {
      if (this.pending === null) {
        if (this.eof) break;
        const { done, value } = await this.reader.read();
        if (done) {
          this.eof = true;
          break;
        }
        if (!(value instanceof Uint8Array)) throw new TypeError('stream chunk is not a Uint8Array');
        this.pending = value;
      }
      const n = Math.min(size - filled, this.pending.length);
      out.set(this.pending.subarray(0, n), filled);
      filled += n;
      this.pending = n === this.pending.length ? null : this.pending.subarray(n);
    }
    return filled === size ? out : out.subarray(0, filled);
  }

  /** 读到 EOF，`prefix` 在前拼成一整段。 */
  async readToEnd(prefix: Uint8Array): Promise<Uint8Array> {
    const parts = [prefix];
    if (this.pending !== null) parts.push(this.pending);
    this.pending = null;
    while (!this.eof) {
      const { done, value } = await this.reader.read();
      if (done) this.eof = true;
      else if (value instanceof Uint8Array) parts.push(value);
      else throw new TypeError('stream chunk is not a Uint8Array');
    }
    const all = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
    let offset = 0;
    for (const part of parts) {
      all.set(part, offset);
      offset += part.length;
    }
    return all;
  }
}

class Frames {
  private readonly source: Source;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly describe: (error: unknown) => string;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>, writer: WritableStreamDefaultWriter<Uint8Array>, describe: (error: unknown) => string) {
    this.source = new Source(reader);
    this.writer = writer;
    this.describe = describe;
  }

  /** `fill_chunk`。 */
  async fillChunk(size: number): Promise<Uint8Array> {
    try {
      return await this.source.fill(size);
    } catch (error) {
      throw new BackupCryptoError(`读取数据失败: ${this.describe(error)}`);
    }
  }

  /** `read_exact(..).map_err(|e| anyhow!("{what}: {e}"))`。 */
  async readExact(size: number, what: string): Promise<Uint8Array> {
    let bytes: Uint8Array;
    try {
      bytes = await this.source.fill(size);
    } catch (error) {
      throw new BackupCryptoError(`${what}: ${this.describe(error)}`);
    }
    if (bytes.length < size) throw new BackupCryptoError(`${what}: failed to fill whole buffer`);
    return bytes;
  }

  async readToEnd(prefix: Uint8Array, what: string): Promise<Uint8Array> {
    try {
      return await this.source.readToEnd(prefix);
    } catch (error) {
      throw new BackupCryptoError(`${what}: ${this.describe(error)}`);
    }
  }

  async write(bytes: Uint8Array, what: string): Promise<void> {
    try {
      await this.writer.write(bytes);
    } catch (error) {
      throw new BackupCryptoError(`${what}: ${this.describe(error)}`);
    }
  }
}

async function withStreams(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  deps: DsbkStreamDeps,
  flushFailed: string,
  run: (frames: Frames) => Promise<void>,
): Promise<void> {
  const describe = deps.describeError ?? defaultDescribe;
  const reader = input.getReader();
  let writer: WritableStreamDefaultWriter<Uint8Array>;
  try {
    writer = output.getWriter();
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    reader.releaseLock();
    throw error;
  }
  try {
    await run(new Frames(reader, writer, describe));
    try {
      await writer.close();
    } catch (error) {
      throw new BackupCryptoError(`${flushFailed}: ${describe(error)}`);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    await writer.abort(error).catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
}

/**
 * `encrypt_backup_file_with_key`：DSBK v2，明文块 1 MiB。密钥经 `keyFor(params…)`
 * 取得，头部登记同一组 salt / m / t / p。
 */
export function encryptDsbkStream(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  params: DsbkEncryptParams,
  keyFor: DsbkKeyFor,
  deps: DsbkStreamDeps,
): Promise<void> {
  return withStreams(input, output, deps, '刷新加密输出失败', async frames => {
    const { salt, m, t, p } = params;
    const key = await keyFor(salt, m, t, p);
    const prefix = deps.randomBytes(7);
    const header = new Uint8Array(DSBK_V2_HEADER_LEN);
    const view = new DataView(header.buffer);
    header.set(MAGIC, 0);
    header[4] = V2;
    view.setUint32(5, m >>> 0, true);
    view.setUint32(9, t >>> 0, true);
    view.setUint32(13, p >>> 0, true);
    header.set(salt.subarray(0, 16), 17);
    header.set(prefix.subarray(0, 7), 33);
    view.setUint32(40, STREAM_PLAINTEXT_CHUNK, true);
    await frames.write(header, '写入加密头部失败');

    let counter = 0;
    let current = await frames.fillChunk(STREAM_PLAINTEXT_CHUNK);
    for (;;) {
      const next = await frames.fillChunk(STREAM_PLAINTEXT_CHUNK);
      const isFinal = next.length === 0;
      const ct = await deps.aead.seal(key, chunkNonce(prefix, counter, isFinal), current);
      current.fill(0);
      await frames.write(ct, '写入密文失败');
      if (isFinal) break;
      current = next;
      if (counter === 0xffffffff) throw new BackupCryptoError('分块计数溢出（文件过大）');
      counter++;
    }
  });
}

/** `decrypt_backup_with_key_provider`：整段 DSBK v1。 */
async function openV1(data: Uint8Array, keyFor: DsbkKeyFor, aead: DsbkAead): Promise<Uint8Array> {
  if (data.length < DSBK_V1_HEADER_LEN) throw new BackupCryptoError('加密备份数据太短');
  if (!isEncryptedBackup(data)) throw new BackupCryptoError('非加密备份文件（无 DSBK 标头）');
  if (data[4] !== V1) throw new BackupCryptoError(`不支持的加密版本: ${data[4]}`);
  const key = await keyFor(data.slice(17, 33), u32le(data, 5), u32le(data, 9), u32le(data, 13));
  const pt = await aead.open(key, data.subarray(33, 45), data.subarray(45));
  if (pt === null) throw new BackupCryptoError(AEAD_FAILED);
  return pt;
}

/**
 * `decrypt_backup_file_with_key_provider`：v2 逐块认证后写出；v1 整段读入、认证通过后
 * 一次写出（同 Rust，仅旧备份会走到）。
 */
export function decryptDsbkStream(
  input: ReadableStream<Uint8Array>,
  output: WritableStream<Uint8Array>,
  keyFor: DsbkKeyFor,
  deps: DsbkStreamDeps,
): Promise<void> {
  return withStreams(input, output, deps, '刷新解密输出失败', async frames => {
    const head = await frames.readExact(5, '读取加密头失败');
    if (!isEncryptedBackup(head)) throw new BackupCryptoError('非加密备份文件（无 DSBK 标头）');
    const version = head[4]!;
    if (version === V1) {
      const data = await frames.readToEnd(head, '读取加密备份失败');
      await frames.write(await openV1(data, keyFor, deps.aead), '写入解密输出失败');
      return;
    }
    if (version !== V2) throw new BackupCryptoError(`不支持的加密版本: ${version}`);

    const params = await frames.readExact(12, '读取加密参数失败');
    const salt = await frames.readExact(16, '读取 salt 失败');
    const prefix = await frames.readExact(7, '读取 nonce 前缀失败');
    const chunk = u32le(await frames.readExact(4, '读取分块大小失败'), 0);
    if (chunk === 0 || chunk > DSBK_MAX_PLAINTEXT_CHUNK) throw new BackupCryptoError(`加密分块大小非法: ${chunk}`);
    const cipherChunk = chunk + DSBK_GCM_TAG_LEN;
    const key = await keyFor(salt, u32le(params, 0), u32le(params, 4), u32le(params, 8));

    let counter = 0;
    let current = await frames.fillChunk(cipherChunk);
    if (current.length === 0) throw new BackupCryptoError('加密备份缺少数据块');
    for (;;) {
      const next = await frames.fillChunk(cipherChunk);
      const isFinal = next.length === 0;
      const pt = await deps.aead.open(key, chunkNonce(prefix, counter, isFinal), current);
      if (pt === null) throw new BackupCryptoError(AEAD_FAILED);
      await frames.write(pt, '写入解密输出失败');
      if (isFinal) break;
      current = next;
      if (counter === 0xffffffff) throw new BackupCryptoError('分块计数溢出');
      counter++;
    }
  });
}
