/**
 * `.key_seed` 种子文件与安全存储文件权限（`dstu-security/src/secure_store.rs` 的静态函数部分）。注释中的行号指该文件。
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, lstat, mkdir, open, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Logger } from '../log/api.ts';
import type { OsDirs } from '../paths/api.ts';
import { decodeUtf8Strict, rustTrim } from '../util/portable.ts';
import { errnoCode, ioMessage } from '../paths/compat.ts';
import { atomicWriteFile } from '../util/durable-fs.ts';
import { decodeBase64Standard } from './crypto-service.ts';
import { SecureStoreError, type SeedKeystore } from './api.ts';
import { DPAPI_SEED_ENTROPY, KEY_SEED_FILE_ONLY_ENV, NATIVE_DPAPI, type DpapiFailure, type DpapiPort } from './keystore.ts';

export const DPAPI_SEED_PREFIX = 'DPAPI1:';
export const KEYSTORE_SEED_PREFIX = 'KEYSTORE1:';
export const MAX_BACKUP_SEED_FILE_BYTES = 64 * 1024;

/** `seed_fingerprint`（449）。 */
export function seedFingerprint(seed: string): string {
  return createHash('sha256').update('deep-student.key_seed.fingerprint.v1').update(seed, 'utf8').digest('hex');
}

export type SeedFileContent =
  | { kind: 'Plaintext'; value: string }
  | { kind: 'Dpapi'; payload: string }
  | { kind: 'KeystoreRef'; fingerprint: string };

/** `classify_seed_content`（429）。 */
export function classifySeedContent(trimmed: string): SeedFileContent {
  if (trimmed.startsWith(DPAPI_SEED_PREFIX)) return { kind: 'Dpapi', payload: trimmed.slice(DPAPI_SEED_PREFIX.length) };
  if (trimmed.startsWith(KEYSTORE_SEED_PREFIX)) {
    const fingerprint = rustTrim(trimmed.slice(KEYSTORE_SEED_PREFIX.length));
    if (fingerprint.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(fingerprint)) {
      throw new SecureStoreError('EncryptionError', '平台密钥库引用标记格式非法（期望 KEYSTORE1:<sha256 hex>），拒绝继续');
    }
    return { kind: 'KeystoreRef', fingerprint };
  }
  return { kind: 'Plaintext', value: trimmed };
}

/**
 * Security.framework 的拒绝类错误（`SecCopyErrorMessageString` 文案与 OSStatus）：Electron 版与
 * 创建条目的 Tauri 版签名不同，读取旧条目时 macOS 会弹授权框；用户点“拒绝”/取消得到
 * errSecUserCanceled(-128) 或 errSecAuthFailed(-25293)，无法弹框时得到 errSecInteractionNotAllowed(-25308)。
 */
const KEYCHAIN_DENIED = /user cancel+ed the operation|errSecUserCanceled|\(-128\)|status -128\b|passphrase you entered is not correct|errSecAuthFailed|-25293/i;
const KEYCHAIN_NO_UI = /user interaction is not allowed|interaction is required|errSecInteractionNotAllowed|errSecInteractionRequired|-25308|-25315/i;

/** 密钥库读取失败时给用户的说明：按失败原因给出可执行的下一步，始终不生成新密钥。 */
export function keystoreUnavailableDetail(backendName: string, reason: string): string {
  if (KEYCHAIN_DENIED.test(reason)) {
    return `${backendName} 拒绝了 Deep Student 读取主密钥（授权弹窗被拒绝或取消）: ${reason}。`
      + 'API Key 与云存储凭据仍完整保存，只是暂时无法解密。请重试该操作或重启应用，在钥匙串授权弹窗中输入登录密码并选择“始终允许”；'
      + '如果不再弹窗，请打开“钥匙串访问”，搜索 deep-student，在该条目的“访问控制”中加入 Deep Student 后重试。系统不会生成新密钥覆盖旧数据';
  }
  if (KEYCHAIN_NO_UI.test(reason)) {
    return `${backendName} 当前无法弹出授权窗口（钥匙串已锁定，或应用在未登录图形界面的会话中运行）: ${reason}。`
      + '请登录桌面并解锁“登录”钥匙串后重试；API Key 与云存储凭据没有丢失，系统不会生成新密钥覆盖旧数据';
  }
  if (backendName === 'macOS Keychain') {
    return `${backendName} 不可用: ${reason}。请确认已登录桌面并解锁“登录”钥匙串后重试，或从备份恢复明文 .key_seed；系统不会自动生成新密钥覆盖旧密文`;
  }
  return `${backendName} 不可用: ${reason}。Linux 无桌面环境请先安装并解锁 Secret Service（gnome-keyring/KWallet），或从备份恢复明文 .key_seed；系统不会自动生成新密钥覆盖旧密文`;
}

/** DPAPI 失败的错误：策略阻止归为可重试的 PlatformUnsupported，其余保持 Rust 的 EncryptionError。 */
export function dpapiSeedError(op: 'protect' | 'unprotect', failure: DpapiFailure): SecureStoreError {
  if (failure.kind === 'blocked') {
    return new SecureStoreError(
      'PlatformUnsupported',
      `Windows 安全策略（AppLocker、软件限制策略或 PowerShell 受限语言模式）阻止了 Deep Student 通过 powershell.exe 调用系统 DPAPI，`
        + (op === 'unprotect'
          ? '无法解开本机保存的主密钥。API Key 与云存储凭据没有丢失；'
          : '无法保护新生成的主密钥，因此不会以明文保存任何密钥；')
        + `请联系管理员允许 Deep Student 以 FullLanguage 模式运行 powershell.exe 后重试。详情: ${failure.detail}`,
    );
  }
  if (op === 'protect') {
    return new SecureStoreError('EncryptionError', `DPAPI 封装密钥种子失败，拒绝明文降级。详情: ${failure.detail}`);
  }
  if (failure.kind === 'crypto') {
    return new SecureStoreError(
      'EncryptionError',
      'DPAPI 解封密钥种子失败：种子与当前 Windows 用户/机器绑定，跨设备复制的种子无法解密。'
        + `如果数据目录来自另一台电脑或另一个 Windows 账户，请在原电脑上导出备份后在这里恢复。详情: ${failure.detail}`,
    );
  }
  return new SecureStoreError(
    'EncryptionError',
    `DPAPI 解封密钥种子失败（无法确定原因，可重试）。API Key 与云存储凭据没有被改动。详情: ${failure.detail}`,
  );
}

/** `resolve_keystore_seed`（464）：fail-closed。 */
export async function resolveKeystoreSeed(keystore: SeedKeystore | null, fingerprint: string): Promise<string> {
  const fpShort = fingerprint.slice(0, 12);
  if (keystore === null) {
    throw new SecureStoreError(
      'PlatformUnsupported',
      `密钥种子已迁入平台密钥库（指纹 ${fpShort}…），当前平台/配置无法访问密钥库：请回到原设备运行，或从备份恢复明文 .key_seed；若设置了 ${KEY_SEED_FILE_ONLY_ENV} 请先移除该环境变量`,
    );
  }
  let stored: string | null;
  try {
    stored = await keystore.load(fingerprint);
  } catch (error) {
    throw new SecureStoreError('KeychainUnavailable', keystoreUnavailableDetail(keystore.backendName, error instanceof Error ? error.message : String(error)));
  }
  if (stored === null) {
    throw new SecureStoreError(
      'KeyNotFound',
      `${keystore.backendName} 中找不到指纹 ${fpShort}… 对应的密钥种子条目。若曾清理过钥匙串/密钥环，请从备份恢复明文 .key_seed；系统不会自动生成新密钥（fail-closed）`,
    );
  }
  const trimmed = rustTrim(stored);
  if (trimmed === '' || seedFingerprint(trimmed) !== fingerprint) {
    throw new SecureStoreError('EncryptionError', `${keystore.backendName} 返回的种子与 .key_seed 指纹不匹配，拒绝使用（fail-closed，防止用错误密钥改写旧密文）`);
  }
  return trimmed;
}

export interface SecureStoreInternals {
  /** `<root>/.secure`；null = `SecureStore::new()` 的静态回退目录。 */
  secureDir: string | null;
  enabled: boolean;
  keystore: SeedKeystore | null;
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  os: OsDirs;
  log: Logger;
  /** Windows 种子保护；缺省经 PowerShell 调用 DPAPI。 */
  dpapi?: DpapiPort;
}

// ------------------------------------------------------------------ 权限

async function restrictToOwnerWindows(path: string, isDir: boolean, env: SecureStoreInternals['env'], log: Logger): Promise<void> {
  const u = rustTrim(env.USERNAME ?? '');
  if (u === '') {
    log.warn(`跳过 ACL 收紧：无法解析当前用户(USERNAME) ${JSON.stringify(path)}`);
    return;
  }
  const d = rustTrim(env.USERDOMAIN ?? '');
  const user = d !== '' ? `${d}\\${u}` : u;
  const suffix = isDir ? '(OI)(CI)(F)' : '(F)';
  const args = [path, '/inheritance:r'];
  for (const g of [`${user}:${suffix}`, `*S-1-5-18:${suffix}`, `*S-1-5-32-544:${suffix}`]) args.push('/grant:r', g);
  await new Promise<void>((resolve) => {
    execFile('icacls', args, { windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const stderrText = String(stderr).trim();
        // Rust `Command::output()`：非零退出是 Ok(out)，只有 spawn 失败才是 Err(e)。
        if (typeof (error as NodeJS.ErrnoException).code === 'number' || stderrText !== '') {
          log.warn(`icacls 收紧权限未成功 ${JSON.stringify(path)}: ${stderrText}`);
        } else {
          log.warn(`无法执行 icacls 收紧权限 ${JSON.stringify(path)}: ${error.message}`);
        }
      }
      resolve();
    });
  });
}

/** `restrict_permissions`（592）：best-effort，失败只告警。 */
export async function restrictPermissions(path: string, isDir: boolean, internals: Pick<SecureStoreInternals, 'platform' | 'env' | 'log'>): Promise<void> {
  if (internals.platform === 'win32') return restrictToOwnerWindows(path, isDir, internals.env, internals.log);
  try {
    await chmod(path, isDir ? 0o700 : 0o600);
  } catch (error) {
    internals.log.warn(`设置安全存储权限失败 ${JSON.stringify(path)}: ${ioMessage(error)}`);
  }
}

/** `atomic_write_secure_file`（912）。 */
export async function atomicWriteSecureFile(path: string, data: Uint8Array | string, internals: SecureStoreInternals): Promise<void> {
  const parent = join(path, '..');
  try {
    await mkdir(parent, { recursive: true });
  } catch (error) {
    throw new SecureStoreError('Other', `创建安全存储目录失败: ${ioMessage(error)}`);
  }
  try {
    await atomicWriteFile(path, data, { beforeRename: (temp) => restrictPermissions(temp, false, internals) });
  } catch (error) {
    throw new SecureStoreError('Other', `提交安全存储文件失败: ${ioMessage(error)}`);
  }
  await restrictPermissions(path, false, internals);
}

/** 读取受大小限制的普通文件（不跟随符号链接）。返回 null = 不存在。 */
export async function readBounded(path: string, max: number, onTooLarge: (len: number) => SecureStoreError, wrongType: string): Promise<Buffer | null> {
  let meta;
  try {
    meta = await lstat(path);
  } catch (error) {
    if (errnoCode(error) === 'ENOENT') return null;
    throw error;
  }
  if (meta.isSymbolicLink() || !meta.isFile()) throw new SecureStoreError('AccessDenied', wrongType);
  if (meta.size > max) throw onTooLarge(meta.size);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    let filled = 0;
    while (filled < buf.length) {
      const { bytesRead } = await fh.read(buf, filled, buf.length - filled, null);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return buf.subarray(0, filled);
  } finally {
    await fh.close();
  }
}

// ------------------------------------------------------------------ 种子文件（静态函数）

export async function writeSeedFile(seedFile: string, seed: string, internals: SecureStoreInternals): Promise<void> {
  if (internals.platform === 'win32') {
    const result = await (internals.dpapi ?? NATIVE_DPAPI).protect(Buffer.from(seed, 'utf8'), DPAPI_SEED_ENTROPY);
    if (!result.ok) throw dpapiSeedError('protect', result.failure);
    const wrapped = result.data;
    try {
      return await atomicWriteSecureFile(seedFile, DPAPI_SEED_PREFIX + wrapped.toString('base64'), internals);
    } finally {
      wrapped.fill(0);
    }
  }
  return atomicWriteSecureFile(seedFile, seed, internals);
}

export async function unwrapDpapiSeed(encoded: string, dpapi: DpapiPort = NATIVE_DPAPI): Promise<string> {
  const decoded = decodeBase64Standard(rustTrim(encoded));
  if ('error' in decoded) {
    throw new SecureStoreError('EncryptionError', `密钥种子 DPAPI 载荷解码失败: ${decoded.error}`);
  }
  const wrapped = decoded.bytes;
  const result = await dpapi.unprotect(wrapped, DPAPI_SEED_ENTROPY);
  wrapped.fill(0);
  if (!result.ok) throw dpapiSeedError('unprotect', result.failure);
  const plain = result.data;
  try {
    return rustTrim(decodeUtf8Strict(plain));
  } catch (error) {
    throw new SecureStoreError('Other', `密钥种子 UTF-8 解码失败: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    plain.fill(0);
  }
}

/** `read_seed_file_checked`（1070）。 */
async function readSeedFileChecked(seedFile: string): Promise<string> {
  let meta;
  try {
    meta = await lstat(seedFile);
  } catch (error) {
    throw new SecureStoreError('Other', `读取密钥种子元数据失败: ${ioMessage(error)}`);
  }
  if (meta.isSymbolicLink() || !meta.isFile()) throw new SecureStoreError('AccessDenied', '密钥种子必须是普通文件，不能是目录或符号链接');
  if (meta.size > MAX_BACKUP_SEED_FILE_BYTES) {
    throw new SecureStoreError('EncryptionError', `密钥种子文件异常过大: ${meta.size} bytes（上限 ${MAX_BACKUP_SEED_FILE_BYTES} bytes）`);
  }
  let buf: Buffer | null;
  try {
    buf = await readBounded(seedFile, MAX_BACKUP_SEED_FILE_BYTES, () => new SecureStoreError('EncryptionError', '密钥种子读取大小超限'), '');
  } catch (error) {
    if (error instanceof SecureStoreError) throw error;
    throw new SecureStoreError('Other', `读取密钥种子失败: ${ioMessage(error)}`);
  }
  if (buf === null) throw new SecureStoreError('Other', '打开密钥种子失败: No such file or directory (os error 2)');
  if (buf.length > MAX_BACKUP_SEED_FILE_BYTES) throw new SecureStoreError('EncryptionError', '密钥种子读取大小超限');
  let text: string;
  try {
    text = decodeUtf8Strict(buf);
  } catch {
    throw new SecureStoreError('Other', '读取密钥种子失败: stream did not contain valid UTF-8');
  } finally {
    buf.fill(0);
  }
  const trimmed = rustTrim(text);
  if (trimmed === '') throw new SecureStoreError('EncryptionError', '密钥种子为空');
  return trimmed;
}

/** `validate_backup_seed_file`（967）。 */
export async function validateBackupSeedFile(seedFile: string, keystore: SeedKeystore | null, platform: NodeJS.Platform): Promise<void> {
  let meta;
  try {
    meta = await lstat(seedFile);
  } catch (error) {
    throw new SecureStoreError('Other', `读取备份密钥种子元数据失败: ${ioMessage(error)}`);
  }
  if (meta.isSymbolicLink() || !meta.isFile()) throw new SecureStoreError('AccessDenied', '备份密钥种子必须是普通文件，不能是目录或符号链接');
  if (meta.size > MAX_BACKUP_SEED_FILE_BYTES) {
    throw new SecureStoreError('EncryptionError', `备份密钥种子文件异常过大: ${meta.size} bytes（上限 ${MAX_BACKUP_SEED_FILE_BYTES} bytes）`);
  }
  let fh;
  try {
    fh = await open(seedFile, 'r');
  } catch (error) {
    throw new SecureStoreError('Other', `打开备份密钥种子失败: ${ioMessage(error)}`);
  }
  let buf: Buffer;
  try {
    const opened = await fh.stat();
    if (!opened.isFile() || opened.size > MAX_BACKUP_SEED_FILE_BYTES) throw new SecureStoreError('EncryptionError', '备份密钥种子在验证期间发生异常变化');
    buf = Buffer.alloc(MAX_BACKUP_SEED_FILE_BYTES + 1);
    let filled = 0;
    try {
      while (filled < buf.length) {
        const { bytesRead } = await fh.read(buf, filled, buf.length - filled, null);
        if (bytesRead === 0) break;
        filled += bytesRead;
      }
    } catch (error) {
      buf.fill(0);
      throw new SecureStoreError('Other', `读取备份密钥种子失败: ${ioMessage(error)}`);
    }
    buf = buf.subarray(0, filled);
  } finally {
    await fh.close();
  }
  if (buf.length > MAX_BACKUP_SEED_FILE_BYTES) throw new SecureStoreError('EncryptionError', '备份密钥种子在读取期间超过大小上限');
  let seed: string;
  try {
    seed = decodeUtf8Strict(buf);
  } catch {
    throw new SecureStoreError('Other', '读取备份密钥种子失败: stream did not contain valid UTF-8');
  } finally {
    buf.fill(0);
  }
  const trimmed = rustTrim(seed);
  if (trimmed === '') throw new SecureStoreError('EncryptionError', '备份密钥种子为空');
  if (trimmed.startsWith(KEYSTORE_SEED_PREFIX)) {
    const fingerprint = rustTrim(trimmed.slice(KEYSTORE_SEED_PREFIX.length));
    if (fingerprint.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(fingerprint)) throw new SecureStoreError('EncryptionError', '备份中的平台密钥库引用标记格式非法');
    await resolveKeystoreSeed(keystore, fingerprint);
    return;
  }
  if (trimmed.startsWith(DPAPI_SEED_PREFIX)) {
    if (platform !== 'win32') throw new SecureStoreError('PlatformUnsupported', 'DPAPI 密钥种子只能在可解封它的 Windows 用户/机器上恢复');
    const plain = await unwrapDpapiSeed(trimmed.slice(DPAPI_SEED_PREFIX.length));
    if (rustTrim(plain) === '') throw new SecureStoreError('EncryptionError', 'DPAPI 解封后的备份密钥种子为空');
  }
}

/** `resolve_seed_file_plaintext`（1113）。 */
export async function resolveSeedFilePlaintext(seedFile: string, keystore: SeedKeystore | null, platform: NodeJS.Platform): Promise<string> {
  const content = classifySeedContent(await readSeedFileChecked(seedFile));
  if (content.kind === 'Plaintext') return content.value;
  if (content.kind === 'Dpapi') {
    if (platform !== 'win32') throw new SecureStoreError('PlatformUnsupported', 'DPAPI 封装的密钥种子只能在原 Windows 用户/机器上解封，无法导出明文种子');
    return unwrapDpapiSeed(content.payload);
  }
  return resolveKeystoreSeed(keystore, content.fingerprint);
}

/** `reseal_seed_file_for_current_platform`（1145）。 */
export async function resealSeedFileForCurrentPlatform(seedFile: string, internals: SecureStoreInternals): Promise<boolean> {
  const content = classifySeedContent(await readSeedFileChecked(seedFile));
  if (content.kind !== 'Plaintext') return false;
  if (internals.platform !== 'win32') return false;
  await writeSeedFile(seedFile, content.value, internals);
  return true;
}

/** `migrate_seed_to_keystore`（879）。 */
export async function migrateSeedToKeystore(keystore: SeedKeystore, seedFile: string, seed: string, internals: SecureStoreInternals): Promise<void> {
  const fingerprint = seedFingerprint(seed);
  try {
    await keystore.store(fingerprint, seed);
  } catch (error) {
    throw new SecureStoreError('KeychainUnavailable', `${keystore.backendName} 写入失败: ${error instanceof Error ? error.message : String(error)}`);
  }
  let stored: string | null;
  try {
    stored = await keystore.load(fingerprint);
  } catch (error) {
    throw new SecureStoreError('KeychainUnavailable', `${keystore.backendName} 回读验证失败: ${error instanceof Error ? error.message : String(error)}，保留明文种子`);
  }
  if (stored === null || rustTrim(stored) !== seed) {
    throw new SecureStoreError('EncryptionError', `${keystore.backendName} 回读验证失败：读出内容与写入种子不一致，保留明文种子`);
  }
  await atomicWriteSecureFile(seedFile, KEYSTORE_SEED_PREFIX + fingerprint, internals);
}
