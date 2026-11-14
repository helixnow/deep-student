/**
 * `CryptoService`（`dstu-security/src/crypto/mod.rs`）：`<dir>/.master_key` 与 API Key 加密。
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, open, readFile, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { execFile, type ExecFileException } from 'node:child_process';
import type { Logger } from '../log/api.ts';
import type { CryptoService, EncryptedData } from './api.ts';
import { decodeUtf8Strict, rustTrim } from '../util/portable.ts';
import { errnoCode, ioMessage } from '../paths/compat.ts';
import { decodeBase64Standard } from '../util/base64.ts';

export { decodeBase64Standard, type Base64DecodeResult } from '../util/base64.ts';

/** 加密服务错误（Rust anyhow，文案与原版一致）。 */
export class CryptoServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CryptoServiceError';
  }
}


/** 严格解码（兼容既有调用方）：失败返回 null。 */
export function decodeBase64Strict(text: string): Buffer | null {
  const decoded = decodeBase64Standard(text);
  return 'error' in decoded ? null : decoded.bytes;
}

function b64(data: Uint8Array): string {
  return Buffer.from(data).toString('base64');
}

/** `child_process.execFile` 的回调形式（字符串输出）。 */
export type ExecFileRunner = (
  file: string,
  args: readonly string[],
  options: { windowsHide: boolean },
  callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => unknown;

export interface MasterKeyPermissionOptions {
  log: Pick<Logger, 'warn'>;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  /** 缺省 `child_process.execFile`。 */
  execFile?: ExecFileRunner;
}

export interface CryptoServiceOptions extends MasterKeyPermissionOptions {
  log: Logger;
}

async function restrictMasterKeyAclWindows(keyPath: string, options: MasterKeyPermissionOptions): Promise<void> {
  const u = rustTrim(options.env.USERNAME ?? '');
  if (u === '') {
    options.log.warn('跳过 .master_key ACL 收紧：无法解析当前用户(USERNAME)');
    return;
  }
  const d = rustTrim(options.env.USERDOMAIN ?? '');
  const user = d !== '' ? `${d}\\${u}` : u;
  const args = [keyPath, '/inheritance:r'];
  for (const g of [`${user}:(F)`, '*S-1-5-18:(F)', '*S-1-5-32-544:(F)']) args.push('/grant:r', g);
  const run = options.execFile ?? execFile;
  await new Promise<void>((resolve) => {
    run('icacls', args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const stderrText = String(stderr).trim();
        // Rust `Command::output()`：非零退出是 Ok(out)，只有 spawn 失败才是 Err(e)。
        if (typeof (error as NodeJS.ErrnoException).code === 'number' || stderrText !== '') {
          options.log.warn(`icacls 收紧 .master_key 权限未成功: ${stderrText}`);
        } else {
          options.log.warn(`无法执行 icacls 收紧 .master_key 权限: ${error.message}`);
        }
      }
      resolve();
    });
  });
}

/**
 * `create_master_key` 写入后的权限收紧（`crypto/mod.rs:101-112`）：POSIX 设为 0600（失败上抛）；
 * Windows 用 icacls 去掉继承、只授予当前用户、SYSTEM、Administrators（F8，失败只告警）。
 */
export async function restrictMasterKeyFile(keyPath: string, options: MasterKeyPermissionOptions): Promise<void> {
  if (options.platform === 'win32') await restrictMasterKeyAclWindows(keyPath, options);
  else await chmod(keyPath, 0o600);
}

/** `create_master_key`：生成并覆盖写入（非原子，同 Rust `OpenOptions::create.write.truncate`）。 */
async function createMasterKey(keyPath: string, options: CryptoServiceOptions): Promise<Buffer> {
  try {
    await mkdir(dirname(keyPath), { recursive: true });
  } catch (error) {
    throw new CryptoServiceError(ioMessage(error));
  }
  const key = randomBytes(32);
  let fh: FileHandle;
  try {
    fh = await open(keyPath, 'w');
  } catch (error) {
    throw new CryptoServiceError(`无法创建主密钥文件: ${JSON.stringify(keyPath)}: ${ioMessage(error)}`);
  }
  try {
    await fh.writeFile(key.toString('base64'));
  } finally {
    await fh.close();
  }
  await restrictMasterKeyFile(keyPath, options);
  options.log.info('🔐 [Crypto] 新主密钥已创建');
  return key;
}

async function loadOrCreateMasterKey(keyPath: string, options: CryptoServiceOptions): Promise<Buffer> {
  let raw: Buffer;
  try {
    raw = await readFile(keyPath);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') {
      options.log.warn(`🔐 [Crypto] 主密钥文件不存在，将创建新密钥: ${JSON.stringify(keyPath)}`);
      return createMasterKey(keyPath, options);
    }
    // Rust：open 的 with_context + read_to_string 的 io::Error Display；保留原始文案。
    throw new CryptoServiceError(`无法打开主密钥文件: ${JSON.stringify(keyPath)}: ${ioMessage(error)}`);
  }
  let encoded: string;
  try {
    encoded = decodeUtf8Strict(raw);
  } catch {
    // `std::fs::read_to_string` 对非法 UTF-8 返回 InvalidData，Display 固定为这句。
    throw new CryptoServiceError('stream did not contain valid UTF-8');
  }
  options.log.info(`🔐 [Crypto] 加载已有主密钥: ${JSON.stringify(keyPath)}`);
  const decoded = decodeBase64Standard(rustTrim(encoded));
  if ('error' in decoded) throw new CryptoServiceError(`主密钥Base64解码失败: ${decoded.error}`);
  const bytes = decoded.bytes;
  if (bytes.length !== 32) {
    const len = bytes.length;
    bytes.fill(0);
    throw new CryptoServiceError(`主密钥长度无效，预期32字节，实际${len}`);
  }
  return bytes;
}

export class CryptoServiceImpl implements CryptoService {
  readonly keyFingerprint: string;
  readonly keyPath: string;
  private readonly masterKey: Buffer;
  private readonly options: CryptoServiceOptions;

  private constructor(
    keyPath: string,
    masterKey: Buffer,
    options: CryptoServiceOptions,
  ) {
    this.keyPath = keyPath;
    this.masterKey = masterKey;
    this.options = options;
    this.keyFingerprint = createHash('sha256').update(masterKey).digest('hex').slice(0, 8);
  }

  /** `CryptoService::new(path)`。 */
  static async open(dir: string, options: CryptoServiceOptions): Promise<CryptoServiceImpl> {
    const keyPath = join(dir, '.master_key');
    options.log.info(`🔐 [Crypto] 初始化加密服务，密钥路径: ${JSON.stringify(keyPath)}`);
    const service = new CryptoServiceImpl(keyPath, await loadOrCreateMasterKey(keyPath, options), options);
    options.log.info(`🔐 [Crypto] 主密钥指纹: ${service.keyFingerprint}...`);
    return service;
  }

  /** 测试向量用：以给定主密钥构造（不读写磁盘）。 */
  static fromKey(keyPath: string, masterKey: Uint8Array, options: CryptoServiceOptions): CryptoServiceImpl {
    return new CryptoServiceImpl(keyPath, Buffer.from(masterKey), options);
  }

  /** `encrypt_api_key`；`nonce` 只供测试向量注入。 */
  encryptApiKey(plaintext: string, nonce: Uint8Array = randomBytes(12)): EncryptedData {
    if (plaintext === '') return { ciphertext: '', nonce: '', version: 2 };
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final(), cipher.getAuthTag()]);
    return { ciphertext: b64(ct), nonce: b64(nonce), version: 2 };
  }

  decryptApiKey(data: EncryptedData): string {
    if (data.version === 2) {
      if (data.ciphertext === '' && data.nonce === '') return '';
      return this.decryptModern(data);
    }
    const decoded = decodeBase64Standard(data.ciphertext);
    if ('error' in decoded) throw new CryptoServiceError(`Base64 解码旧版密钥失败: ${decoded.error}`);
    try {
      return decodeUtf8Strict(decoded.bytes);
    } catch (error) {
      throw new CryptoServiceError(error instanceof Error ? error.message : String(error));
    }
  }

  private decryptModern(data: EncryptedData): string {
    const nonce = decodeBase64Standard(data.nonce);
    if ('error' in nonce) throw new CryptoServiceError(`解码 nonce 失败: ${nonce.error}`);
    if (nonce.bytes.length !== 12) throw new CryptoServiceError('nonce 长度无效，预期12字节');
    const ct = decodeBase64Standard(data.ciphertext);
    if ('error' in ct) throw new CryptoServiceError(`解码密文失败: ${ct.error}`);
    if (ct.bytes.length < 16) throw new CryptoServiceError('AES-GCM 解密失败: aead::Error');
    let plain: Buffer;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.masterKey, nonce.bytes);
      decipher.setAuthTag(ct.bytes.subarray(ct.bytes.length - 16));
      plain = Buffer.concat([decipher.update(ct.bytes.subarray(0, ct.bytes.length - 16)), decipher.final()]);
    } catch {
      // aes-gcm 认证失败只有 `aead::Error`。
      throw new CryptoServiceError('AES-GCM 解密失败: aead::Error');
    }
    try {
      return decodeUtf8Strict(plain);
    } catch (error) {
      throw new CryptoServiceError(error instanceof Error ? error.message : String(error));
    }
  }

  migratePlaintextKey(plaintext: string): string {
    return serializeEncryptedData(this.encryptApiKey(plaintext));
  }

  verifyKeyIntegrity(): boolean {
    const nonce = randomBytes(12);
    const test = Buffer.from('integrity-check');
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, nonce);
    const ct = Buffer.concat([cipher.update(test), cipher.final()]);
    const tag = cipher.getAuthTag();
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).equals(test);
  }

  async rotateMasterKey(newDir: string): Promise<CryptoService> {
    const keyPath = join(newDir, '.master_key');
    return new CryptoServiceImpl(keyPath, await createMasterKey(keyPath, this.options), this.options);
  }
}

/** `serde_json::to_string(&EncryptedData)`：`{"ciphertext":..,"nonce":..,"version":2|null}`。 */
export function serializeEncryptedData(data: EncryptedData): string {
  return JSON.stringify({ ciphertext: data.ciphertext, nonce: data.nonce, version: data.version ?? null });
}

/**
 * `CryptoService::is_encrypted_format`：`serde_json::from_str::<EncryptedData>` 是否成功。
 * serde 派生的结构体同时接受对象形式与序列（数组）形式；version 为 `u8` 或 null，可省略。
 */
export function parseEncryptedData(s: string): EncryptedData | null {
  let value: unknown;
  try {
    value = JSON.parse(s, (_k, v, ctx?: { source?: string }) => (typeof v === 'number' ? { __num: ctx?.source ?? String(v) } : v));
  } catch {
    // 非 JSON → 不是加密格式。
    return null;
  }
  const asU8 = (v: unknown): number | null | undefined => {
    if (v === null || v === undefined) return v as null | undefined;
    if (typeof v === 'object' && v !== null && '__num' in v) {
      const src = String((v as { __num: string }).__num);
      if (/^[0-9]+$/.test(src) && Number(src) <= 255) return Number(src);
    }
    return undefined;
  };
  if (Array.isArray(value)) {
    if (value.length < 2 || value.length > 3) return null;
    const [c, n, v] = value;
    if (typeof c !== 'string' || typeof n !== 'string') return null;
    if (value.length === 3) {
      const version = asU8(v);
      if (version === undefined && v !== null) return null;
      return { ciphertext: c, nonce: n, version: version ?? null };
    }
    return { ciphertext: c, nonce: n, version: null };
  }
  if (typeof value !== 'object' || value === null) return null;
  const o = value as Record<string, unknown>;
  if (typeof o.ciphertext !== 'string' || typeof o.nonce !== 'string') return null;
  let version: number | null = null;
  if ('version' in o && o.version !== null) {
    const v = asU8(o.version);
    if (v === undefined || v === null) return null;
    version = v;
  }
  return { ciphertext: o.ciphertext, nonce: o.nonce, version };
}

export function isEncryptedFormat(s: string): boolean {
  return parseEncryptedData(s) !== null;
}

/** `CryptoService::derive_static_key`：SHA-256(seed)。 */
export function deriveStaticKey(seed: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(seed, 'utf8').digest());
}
