/**
 * 云存储凭据的纯函数部分（`dstu-security/src/secure_store.rs`）：加密密码强度、凭据状态与 serde 读写、暂存记录。
 * 实例方法见 secure-store.ts。
 */
import { charCount, JsonReader, rustTrim } from '../util/portable.ts';
import {
  CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE,
  CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE,
  MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS,
  MIN_CLOUD_ENCRYPTION_PASSWORD_DISTINCT_CHARS,
  SecureStoreError,
  type CloudStorageCredentialStatus,
  type CloudStorageCredentials,
} from './api.ts';

export const U64_MAX = (1n << 64n) - 1n;

const CLOUD_ENCRYPTION_PASSWORD_BLACKLIST = new Set([
  'password',
  'password1',
  'password12',
  'password123',
  'passw0rd',
  'p@ssw0rd',
  '12345678',
  '123456789',
  '1234567890',
  '11111111',
  '00000000',
  '88888888',
  '66666666',
  'aa123456',
  'abc12345',
  'a1b2c3d4',
  '1q2w3e4r',
  '1qaz2wsx',
  'qwer1234',
  'qwertyui',
  'qwertyuiop',
  'asdfghjk',
  'asdfghjkl',
  'zxcvbnm123',
  'iloveyou',
  'sunshine',
  'princess',
  'football',
  'baseball',
  'superman',
  'internet',
  'computer',
]);

export function cloudEncryptionPasswordTooShort(password: string | null | undefined): boolean {
  if (password === null || password === undefined) return false;
  const t = rustTrim(password);
  return t !== '' && charCount(t) < MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS;
}

export function cloudEncryptionPasswordTooWeak(password: string | null | undefined): boolean {
  if (password === null || password === undefined) return false;
  const t = rustTrim(password);
  if (t === '') return false;
  if (CLOUD_ENCRYPTION_PASSWORD_BLACKLIST.has(t.toLowerCase())) return true;
  return new Set(t).size < MIN_CLOUD_ENCRYPTION_PASSWORD_DISTINCT_CHARS;
}

export function cloudEncryptionPasswordTooShortMessage(): string {
  return `[${CLOUD_ENCRYPTION_PASSWORD_TOO_SHORT_CODE}] 云端端到端加密密码至少需要 ${MIN_CLOUD_ENCRYPTION_PASSWORD_CHARS} 个字符（不能为空白）`;
}

export function cloudEncryptionPasswordTooWeakMessage(): string {
  return `[${CLOUD_ENCRYPTION_PASSWORD_TOO_WEAK_CODE}] 云端端到端加密密码过于常见或过于单一（常见弱口令、或不同字符少于 ${MIN_CLOUD_ENCRYPTION_PASSWORD_DISTINCT_CHARS} 个），请换一个更难猜的密码`;
}

export function checkNewCloudEncryptionPassword(password: string | null | undefined): void {
  if (cloudEncryptionPasswordTooShort(password)) throw new SecureStoreError('CloudEncryptionPasswordTooShort', cloudEncryptionPasswordTooShortMessage());
  if (cloudEncryptionPasswordTooWeak(password)) throw new SecureStoreError('CloudEncryptionPasswordTooWeak', cloudEncryptionPasswordTooWeakMessage());
}

/** 字段顺序 = Rust 结构体声明顺序（serde 序列化顺序）。 */
const FIELDS: ReadonlyArray<keyof CloudStorageCredentials> = ['webdavPassword', 's3SecretAccessKey', 'ftpPassword', 'encryptionPassword'];

function present(v: string | undefined): boolean {
  return v !== undefined && rustTrim(v) !== '';
}

export function credentialStatus(c: CloudStorageCredentials): CloudStorageCredentialStatus {
  return {
    webdavPasswordConfigured: present(c.webdavPassword),
    s3SecretAccessKeyConfigured: present(c.s3SecretAccessKey),
    ftpPasswordConfigured: present(c.ftpPassword),
    encryptionPasswordConfigured: present(c.encryptionPassword),
  };
}

export function hasAnySecret(c: CloudStorageCredentials): boolean {
  return FIELDS.some((f) => present(c[f]));
}

export function applyNonemptyUpdate(target: CloudStorageCredentials, update: CloudStorageCredentials): void {
  for (const f of FIELDS) if (present(update[f])) target[f] = update[f];
}

/** serde 序列化：字段顺序固定，`None` 省略。 */
export function serializeCredentials(c: CloudStorageCredentials): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FIELDS) if (c[f] !== undefined) out[f] = c[f]!;
  return out;
}

/** CloudStorageCredentials derive：defaulted Option fields, map/sequence, unknown IgnoredAny。 */
export function readCredentials(r: JsonReader): CloudStorageCredentials {
  const out: CloudStorageCredentials = {};
  const readField = (field: keyof CloudStorageCredentials): void => {
    if (!r.readOptionNone()) out[field] = r.readString();
  };
  if (r.peekKind() === 'array') {
    r.beginArray();
    let closed = false;
    for (const field of FIELDS) {
      if (!r.nextItem()) { closed = true; break; }
      readField(field);
    }
    if (!closed) r.endArray();
  } else {
    r.beginObject('struct CloudStorageCredentials');
    const seen = new Set<string>();
    for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
      const field = FIELDS.find(name => name === key);
      if (field === undefined) { r.skipIgnoredValue(); continue; }
      if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
      seen.add(field);
      readField(field);
    }
  }
  return out;
}

/** `str::parse::<u64>()`：可选前导 `+`，只允许 ASCII 数字；失败时给出 Rust `ParseIntError` 文案。 */
export function parseU64(raw: string): bigint | string {
  if (raw === '') return 'cannot parse integer from empty string';
  if (!/^\+?[0-9]+$/.test(raw)) return 'invalid digit found in string';
  const v = BigInt(raw);
  return v > U64_MAX ? 'number too large to fit in target type' : v;
}

export interface StagedRecord {
  generation: bigint;
  credentials: CloudStorageCredentials;
}

export function parseStaged(json: string): StagedRecord {
  const r = new JsonReader(json);
  let generation: bigint | undefined;
  let credentials: CloudStorageCredentials | undefined;
  const fields = ['generation', 'credentials'] as const;
  const readField = (field: typeof fields[number]): void => {
    if (field === 'generation') generation = r.readUnsigned('u64', U64_MAX);
    else credentials = readCredentials(r);
  };
  if (r.peekKind() === 'array') {
    r.beginArray();
    for (const [index, field] of fields.entries()) {
      if (!r.nextItem()) throw r.error(`invalid length ${index}, expected struct StagedCloudCredentials with 2 elements`);
      readField(field);
    }
    r.endArray();
  } else {
    r.beginObject('struct StagedCloudCredentials');
    const seen = new Set<string>();
    for (let key = r.nextKey(); key !== null; key = r.nextKey()) {
      const field = fields.find(name => name === key);
      if (field === undefined) { r.skipIgnoredValue(); continue; }
      if (seen.has(field)) throw r.fieldError(`duplicate field \`${field}\``);
      seen.add(field);
      readField(field);
    }
  }
  if (generation === undefined) throw r.error('missing field `generation`');
  if (credentials === undefined) throw r.error('missing field `credentials`');
  r.end();
  return { generation, credentials };
}

export function serializeStaged(record: StagedRecord): string {
  return `{"generation":${record.generation.toString()},"credentials":${JSON.stringify(serializeCredentials(record.credentials))}}`;
}
