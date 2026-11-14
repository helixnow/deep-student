/**
 * 恢复候选槽时的全局加密密钥发布（`backup/mod.rs:3584 restore_crypto_keys_from_manifest_transactional`）。
 *
 * 发布顺序与 Rust 一致：journal 先落盘 → 旧密钥移入回滚目录 → 新密钥装入 →
 * 目录 fsync → `after_publish`（登记切槽租约）→ 清理 journal。任一步失败都
 * 按 journal 记录的已移动/已安装状态回滚；回滚不完整时保留 journal，交由
 * 启动侧 `CryptoPublication.recover` 收敛。
 */
import { createHash } from 'node:crypto';
import {
  chmodSync, closeSync, copyFileSync, cpSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync,
  openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, fsyncSync, writeSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Context } from '@deepseek-ai/cordis';
import type { CryptoPublication, CryptoPublicationJournal } from '../../../platform/secrets/api.ts';
import { rustTrim, utf8ByteLength } from '../../../platform/util/portable.ts';
import {
  domainRestorePlan, type BackupFile, type BackupManifest,
} from './manifest.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import { ioMessage } from './io.ts';

const PRE_RESTORE_DIR = '.pre_restore';
export const MAX_BACKUP_MASTER_KEY_BYTES = 4_096;
export const MAX_BACKUP_SECURE_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_BACKUP_SECURE_TOTAL_BYTES = 64 * 1024 * 1024;
export const MAX_BACKUP_SECURE_FILES = 4_096;

export interface CryptoRestoreResult {
  restored: number;
}

function removeCryptoPath(path: string): void {
  let metadata;
  try { metadata = lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (metadata.isSymbolicLink()) rmSync(path, { force: true });
  else if (metadata.isDirectory()) rmSync(path, { recursive: true, force: true });
  else rmSync(path, { force: true });
}

function restrictPermissions(path: string, directory: boolean): void {
  if (process.platform === 'win32') return;
  chmodSync(path, directory ? 0o700 : 0o600);
}

function syncDirectory(path: string): void {
  if (process.platform === 'win32') return;
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

/** `copy_crypto_file_to_staging`（backup/mod.rs:244-315）。 */
export function copyCryptoFileToStaging(source: string, destination: string, maxBytes: number): number {
  let metadata;
  try { metadata = lstatSync(source); }
  catch (error) { throw new Error(`无法检查备份密钥文件 ${source}: ${ioMessage(error)}`); }
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`备份密钥条目必须是普通文件: ${source}`);
  }
  if (metadata.size > maxBytes) {
    throw new Error(`备份密钥文件过大: ${source} (${metadata.size} bytes)`);
  }

  const input = openSync(source, 'r');
  try {
    const opened = fstatSync(input);
    if (!opened.isFile() || opened.size > maxBytes || opened.size !== metadata.size) {
      throw new Error(`备份密钥文件在暂存期间发生异常变化: ${source}`);
    }
    const output = openSync(destination, 'wx');
    let keep = false;
    try {
      const buffer = new Uint8Array(64 * 1024);
      const limit = maxBytes + 1;
      let copied = 0;
      while (copied < limit) {
        const read = readSync(input, buffer, 0, Math.min(buffer.length, limit - copied), null);
        if (read === 0) break;
        let written = 0;
        while (written < read) written += writeSync(output, buffer, written, read - written);
        copied += read;
      }
      if (copied > maxBytes) throw new Error(`备份密钥文件实际读取大小超限: ${source}`);
      if (copied !== opened.size) {
        throw new Error(`备份密钥文件实际读取大小变化: ${source} expected=${opened.size}, actual=${copied}`);
      }
      // 暂存密钥随后会被改名发布：数据必须先落盘，断电后不能出现已发布但内容为空的密钥文件。
      fsyncSync(output);
      const stagedSize = fstatSync(output).size;
      if (stagedSize !== copied) {
        throw new Error(`备份密钥暂存大小不一致: ${destination} expected=${copied}, actual=${stagedSize}`);
      }
      restrictPermissions(destination, false);
      keep = true;
      return copied;
    } finally {
      closeSync(output);
      if (!keep) rmSync(destination, { force: true });
    }
  } finally {
    closeSync(input);
  }
}

export function validateStagedMasterKey(path: string): void {
  const encoded = readFileSync(path, 'utf8');
  if (utf8ByteLength(encoded) > MAX_BACKUP_MASTER_KEY_BYTES) {
    throw new Error('备份主密钥内容超过大小上限');
  }
  const trimmed = rustTrim(encoded);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(trimmed) || trimmed.length % 4 !== 0) {
    throw new Error('备份主密钥 Base64 无效');
  }
  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.length !== 32) {
    throw new Error(`备份主密钥长度无效: expected=32, actual=${decoded.length}`);
  }
}

function collectBackupFilesUnder(root: string): BackupFile[] {
  let rootMetadata;
  try { rootMetadata = lstatSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(`备份域根必须是普通目录: crypto`);
  }
  const files: BackupFile[] = [];
  const walk = (dir: string, relative: string): void => {
    for (const name of readdirSync(dir)) {
      const absolute = join(dir, name);
      const rel = `${relative}/${name}`;
      const metadata = lstatSync(absolute);
      if (metadata.isSymbolicLink()) throw new Error(`备份域包含非常规文件: ${absolute}`);
      if (metadata.isDirectory()) { walk(absolute, rel); continue; }
      if (!metadata.isFile()) throw new Error(`备份域包含非常规文件: ${absolute}`);
      const bytes = readFileSync(absolute);
      files.push({
        path: rel,
        size: bytes.length,
        sha256: sha256Hex(bytes),
      });
    }
  };
  walk(root, 'crypto');
  return files;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function verifyCryptoMaterial(
  ctx: Context,
  manifest: BackupManifest,
  backupSubdir: string,
): Promise<void> {
  if (manifest.key_policy !== 'included_local') return;
  const coverage = manifest.coverage?.domains.crypto;
  if (!coverage) throw new Error('密钥策略声明 included_local 但缺少 crypto 覆盖');
  if (coverage.status !== 'complete') {
    throw new Error('密钥策略声明 included_local 但 crypto 域不完整');
  }
  for (const relative of coverage.paths) {
    const allowed = relative === 'crypto/.master_key'
      || relative === 'crypto/.secure/.key_seed'
      || (relative.startsWith('crypto/.secure/') && relative.toLowerCase().endsWith('.enc'));
    if (!allowed) throw new Error(`crypto 域包含未识别文件: ${relative}`);
  }
  const master = join(backupSubdir, 'crypto', '.master_key');
  if (coverage.paths.includes('crypto/.master_key')) {
    try { validateStagedMasterKey(master); }
    catch (error) { throw new Error(`主密钥验证失败: ${ioMessage(error)}`); }
  }
  const seedPath = join(backupSubdir, 'crypto', '.secure', '.key_seed');
  const hasSeed = coverage.paths.includes('crypto/.secure/.key_seed');
  if (hasSeed) {
    try { await ctx.secrets.validateBackupSeedFile(seedPath); }
    catch (error) { throw new Error(`安全存储种子不可用于恢复: ${ioMessage(error)}`); }
  }
  const encrypted = coverage.paths.filter(path =>
    path.startsWith('crypto/.secure/') && path.toLowerCase().endsWith('.enc'));
  if (encrypted.length === 0) return;
  if (!hasSeed) throw new Error('crypto 域含加密凭据但缺少 .key_seed');
  // 与 verifyWithAssets 一致：SecureStore 读凭据可能迁移种子，不能改动已校验的归档。
  const sandbox = mkdtempSync(join(tmpdir(), 'dstu-restore-crypto-'));
  try {
    const secureDir = join(sandbox, '.secure');
    mkdirSync(secureDir);
    copyFileSync(seedPath, join(secureDir, '.key_seed'));
    for (const relative of encrypted) {
      copyFileSync(join(backupSubdir, relative), join(secureDir, basename(relative)));
    }
    const store = ctx.secrets.openStore(sandbox);
    for (const relative of encrypted) {
      const key = basename(relative).replace(/\.enc$/i, '');
      let value: string | null;
      try { value = await store.getSecret(key); }
      catch (error) { throw new Error(`加密凭据无法实际解密 ${relative}: ${ioMessage(error)}`); }
      if (value === null) throw new Error(`加密凭据验证时消失: ${relative}`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

function snapshotCurrentCryptoKeys(appDataRoot: string, preRestoreRoot: string): void {
  const destination = join(preRestoreRoot, 'crypto');
  removeCryptoPath(destination);
  const master = join(appDataRoot, '.master_key');
  const secure = join(appDataRoot, '.secure');
  if (!existsSync(master) && !existsSync(secure)) return;
  mkdirSync(destination, { recursive: true });
  if (existsSync(master)) copyFileSync(master, join(destination, '.master_key'));
  if (existsSync(secure)) cpSync(secure, join(destination, '.secure'), { recursive: true, dereference: false });
}

function rollbackPublishedCrypto(state: {
  targetMaster: string; targetSecure: string; rollbackMaster: string; rollbackSecure: string;
  installedMaster: boolean; installedSecure: boolean; movedMaster: boolean; movedSecure: boolean;
}): string[] {
  const errors: string[] = [];
  if (state.installedMaster) {
    try { removeCryptoPath(state.targetMaster); }
    catch (error) { errors.push(`删除新主密钥失败: ${ioMessage(error)}`); }
  }
  if (state.installedSecure) {
    try { removeCryptoPath(state.targetSecure); }
    catch (error) { errors.push(`删除新安全目录失败: ${ioMessage(error)}`); }
  }
  if (state.movedMaster) {
    try { renameSync(state.rollbackMaster, state.targetMaster); }
    catch (error) { errors.push(`恢复旧主密钥失败: ${ioMessage(error)}`); }
  }
  if (state.movedSecure) {
    try { renameSync(state.rollbackSecure, state.targetSecure); }
    catch (error) { errors.push(`恢复旧安全目录失败: ${ioMessage(error)}`); }
  }
  return errors;
}


/** `restore_crypto_keys`：目录版（非 manifest）入口，供旧恢复路径与回滚使用。 */
export async function restoreCryptoKeys(ctx: Context, backupSubdir: string): Promise<number> {
  const publication: CryptoPublication | undefined = ctx.secrets?.publication;
  if (!publication) throw new Error('密钥发布服务不可用，目标密钥保持不变');
  return restoreCryptoKeysTransactional(ctx, backupSubdir, null, () => {}, publication);
}

/**
 * `restore_crypto_keys_from_manifest_transactional`。
 * `afterPublish` 负责持久化恢复切槽租约；它失败时旧密钥必须恢复。
 */
export async function restoreCryptoKeysFromManifestTransactional(
  ctx: Context,
  manifest: BackupManifest,
  backupSubdir: string,
  cutover: readonly [string, string] | null,
  afterPublish: (restored: number) => void,
): Promise<number> {
  const publication: CryptoPublication | undefined = ctx.secrets?.publication;
  if (!publication) throw new Error('密钥发布服务不可用，目标密钥保持不变');
  const plan = domainRestorePlan(manifest, 'crypto');
  if (!plan) throw new Error('备份缺少 crypto restore plan');
  const actualFiles = collectBackupFilesUnder(join(backupSubdir, 'crypto'));

  if (plan.status === 'absent' || plan.status === 'empty') {
    if (actualFiles.length === 0) { afterPublish(0); return 0; }
    throw new Error('crypto restore plan 声明无文件，但归档包含加密材料');
  }
  if (plan.status !== 'complete' || manifest.key_policy !== 'included_local'
    || plan.files.length !== actualFiles.length) {
    throw new Error('crypto restore plan 不可执行或文件集合不完整');
  }
  for (const actual of actualFiles) {
    const declared = plan.files.find(file => file.path === actual.path);
    if (!declared) throw new Error(`crypto 归档包含未声明文件: ${actual.path}`);
    if (declared.size !== actual.size || declared.sha256 !== actual.sha256) {
      throw new Error(`crypto restore plan 元数据不匹配: ${actual.path}`);
    }
  }
  await verifyCryptoMaterial(ctx, manifest, backupSubdir);

  return restoreCryptoKeysTransactional(ctx, backupSubdir, cutover, afterPublish, publication);
}

/**
 * 目录版密钥恢复核心（`restore_crypto_keys_transactional`）：
 * 扫描 `backup_subdir/crypto`，校验种子/凭据后以 journal + rename 原子发布。
 */
async function restoreCryptoKeysTransactional(
  ctx: Context,
  backupSubdir: string,
  cutover: readonly [string, string] | null,
  afterPublish: (restored: number) => void,
  publication: CryptoPublication,
): Promise<number> {
  let backupMetadata;
  try { backupMetadata = lstatSync(backupSubdir); }
  catch (error) { throw new Error(`无法检查备份目录，目标密钥保持不变: ${ioMessage(error)}`); }
  if (backupMetadata.isSymbolicLink() || !backupMetadata.isDirectory()) {
    throw new Error('备份目录必须是普通目录，目标密钥保持不变');
  }
  const cryptoSource = join(backupSubdir, 'crypto');
  let cryptoMetadata;
  try { cryptoMetadata = lstatSync(cryptoSource); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { afterPublish(0); return 0; }
    throw new Error(`无法检查备份加密密钥目录，目标密钥保持不变: ${ioMessage(error)}`);
  }
  if (cryptoMetadata.isSymbolicLink() || !cryptoMetadata.isDirectory()) {
    throw new Error('备份加密密钥路径必须是普通目录，目标密钥保持不变');
  }
  mkdirSync(ctx.app.dataDir, { recursive: true });
  const staging = mkdtempSync(join(ctx.app.dataDir, 'crypto-restore-staging-'));
  try {
    const stagedCrypto = join(staging, 'crypto');
    mkdirSync(stagedCrypto);
    restrictPermissions(stagedCrypto, true);

    const sourceMaster = join(cryptoSource, '.master_key');
    const stagedMaster = join(stagedCrypto, '.master_key');
    let hasMaster = false;
    if (existsSync(sourceMaster)) {
      copyCryptoFileToStaging(sourceMaster, stagedMaster, MAX_BACKUP_MASTER_KEY_BYTES);
      try { validateStagedMasterKey(stagedMaster); }
      catch (error) { throw new Error(`备份主密钥无效，目标密钥保持不变: ${ioMessage(error)}`); }
      hasMaster = true;
    }

    const sourceSecure = join(cryptoSource, '.secure');
    const stagedSecure = join(stagedCrypto, '.secure');
    let hasSecure = false;
    let secureFileCount = 0;
    let secureTotalBytes = 0;
    let hasSeed = false;
    let encryptedFileCount = 0;
    if (existsSync(sourceSecure)) {
      const secureMetadata = lstatSync(sourceSecure);
      if (secureMetadata.isSymbolicLink() || !secureMetadata.isDirectory()) {
        throw new Error('备份安全存储路径必须是普通目录，目标密钥保持不变');
      }
      hasSecure = true;
      mkdirSync(stagedSecure);
      restrictPermissions(stagedSecure, true);
      for (const name of readdirSync(sourceSecure)) {
        const source = join(sourceSecure, name);
        const metadata = lstatSync(source);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
          throw new Error(`备份安全存储条目必须是普通文件，目标密钥保持不变: ${source}`);
        }
        secureFileCount += 1;
        if (secureFileCount > MAX_BACKUP_SECURE_FILES) {
          throw new Error(`备份安全存储文件数超限，目标密钥保持不变: ${secureFileCount}`);
        }
        const stagedFile = join(stagedSecure, name);
        const copied = copyCryptoFileToStaging(source, stagedFile, MAX_BACKUP_SECURE_FILE_BYTES);
        secureTotalBytes += copied;
        if (secureTotalBytes > MAX_BACKUP_SECURE_TOTAL_BYTES) {
          throw new Error(`备份安全存储总大小超限，目标密钥保持不变: ${secureTotalBytes} bytes`);
        }
        if (name === '.key_seed') hasSeed = true;
        else if (name.toLowerCase().endsWith('.enc')) {
          encryptedFileCount += 1;
          if (copied < 28) {
            throw new Error(`备份加密凭据格式过短，目标密钥保持不变: ${stagedFile}`);
          }
        }
      }
    }

    if (encryptedFileCount > 0 && !hasSeed) {
      throw new Error('备份含加密凭据但缺少 .key_seed，拒绝与现有密钥混合，目标密钥保持不变');
    }
    if (hasSeed) {
      const stagedSeed = join(stagedSecure, '.key_seed');
      try { await ctx.secrets.validateBackupSeedFile(stagedSeed); }
      catch (error) { throw new Error(`备份密钥种子与当前环境不兼容，目标密钥保持不变: ${ioMessage(error)}`); }
      try { await ctx.secrets.resealSeedFileForCurrentPlatform(stagedSeed); }
      catch (error) { throw new Error(`备份密钥种子按当前平台重新封装失败，目标密钥保持不变: ${ioMessage(error)}`); }
    }
    if (!hasMaster && !hasSecure) { afterPublish(0); return 0; }

    const preRestoreRoot = join(ctx.app.dataDir, 'recovery', 'backups', PRE_RESTORE_DIR);
    if (backupSubdir !== preRestoreRoot) {
      try { snapshotCurrentCryptoKeys(ctx.app.dataDir, preRestoreRoot); }
      catch (error) { throw new Error(`当前密钥快照失败，已中止恢复且目标密钥保持不变: ${ioMessage(error)}`); }
    }

    const appDataRoot = ctx.app.dataDir;
    const journalPath = publication.journalPath(appDataRoot);
    if (existsSync(journalPath)) {
      throw new Error('检测到未决的密钥发布 journal，请先重启应用完成恢复后重试');
    }
    const rollbackDir = publication.rollbackDir(appDataRoot);
    removeCryptoPath(rollbackDir);
    mkdirSync(rollbackDir);
    restrictPermissions(rollbackDir, true);

    const targetMaster = join(appDataRoot, '.master_key');
    const targetSecure = join(appDataRoot, '.secure');
    const rollbackMaster = join(rollbackDir, '.master_key');
    const rollbackSecure = join(rollbackDir, '.secure');
    const hadOldMaster = existsSync(targetMaster);
    const hadOldSecure = existsSync(targetSecure);

    const journal: CryptoPublicationJournal = {
      version: 1,
      backupId: cutover?.[0] ?? null,
      targetSlot: cutover?.[1] ?? null,
      hadOldMaster,
      hadOldSecure,
      installsMaster: hasMaster,
      installsSecure: hasSecure,
      createdAt: toRfc3339(),
    };
    try { await publication.writeJournal(appDataRoot, journal); }
    catch (error) {
      removeCryptoPath(rollbackDir);
      throw new Error(`写入密钥发布 journal 失败，目标密钥保持不变: ${ioMessage(error)}`);
    }

    const state = {
      targetMaster, targetSecure, rollbackMaster, rollbackSecure,
      installedMaster: false, installedSecure: false, movedMaster: false, movedSecure: false,
    };
    try {
      if (hasMaster && hadOldMaster) { renameSync(targetMaster, rollbackMaster); state.movedMaster = true; }
      if (hasSecure && hadOldSecure) { renameSync(targetSecure, rollbackSecure); state.movedSecure = true; }
      if (hasMaster) { renameSync(stagedMaster, targetMaster); state.installedMaster = true; }
      if (hasSecure) { renameSync(stagedSecure, targetSecure); state.installedSecure = true; }
    } catch (error) {
      const rollbackErrors = rollbackPublishedCrypto(state);
      if (rollbackErrors.length === 0) {
        try { await publication.removeJournal(appDataRoot); }
        catch (journalError) { ctx.logger('backup').warn(`清理密钥发布 journal 失败（启动侧回滚为幂等空操作）: ${ioMessage(journalError)}`); }
        removeCryptoPath(rollbackDir);
      }
      throw new Error(rollbackErrors.length === 0
        ? `密钥原子提交失败，已恢复原目标: ${ioMessage(error)}`
        : `密钥原子提交失败且回滚不完整（journal 已保留，重启后自动修复）: ${ioMessage(error)}; ${rollbackErrors.join('; ')}`);
    }

    const restored = (hasMaster ? 1 : 0) + secureFileCount;
    try {
      syncDirectory(appDataRoot);
      if (hasMaster) restrictPermissions(targetMaster, false);
      if (hasSecure) {
        restrictPermissions(targetSecure, true);
        for (const name of readdirSync(targetSecure)) {
          const entry = join(targetSecure, name);
          if (lstatSync(entry).isFile()) restrictPermissions(entry, false);
        }
      }
      afterPublish(restored);
    } catch (error) {
      const rollbackErrors = rollbackPublishedCrypto(state);
      if (rollbackErrors.length === 0) {
        try { await publication.removeJournal(appDataRoot); }
        catch (journalError) { ctx.logger('backup').warn(`清理密钥发布 journal 失败（启动侧回滚为幂等空操作）: ${ioMessage(journalError)}`); }
        removeCryptoPath(rollbackDir);
      }
      throw new Error(rollbackErrors.length === 0
        ? `密钥发布后的恢复切槽提交失败，已恢复旧密钥: ${ioMessage(error)}`
        : `密钥发布后的恢复切槽提交失败且旧密钥回滚不完整（journal 已保留，重启后自动修复）: ${ioMessage(error)}; ${rollbackErrors.join('; ')}`);
    }

    try {
      await publication.removeJournal(appDataRoot);
      try { removeCryptoPath(rollbackDir); }
      catch (error) { ctx.logger('backup').warn(`清理密钥回滚目录失败（残留将在下次启动清理）: ${ioMessage(error)}`); }
    } catch (journalError) {
      if (cutover !== null) {
        ctx.logger('backup').warn(`清理密钥发布 journal 失败，下次启动将按已登记切槽前滚清理: ${ioMessage(journalError)}`);
      } else {
        const rollbackErrors = rollbackPublishedCrypto(state);
        throw new Error(rollbackErrors.length === 0
          ? `密钥发布 journal 清理失败，已恢复旧密钥: ${ioMessage(journalError)}`
          : `密钥发布 journal 清理失败且旧密钥回滚不完整（journal 已保留，重启后自动修复）: ${ioMessage(journalError)}; ${rollbackErrors.join('; ')}`);
      }
    }
    return restored;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
