/**
 * 移动端技能包安装器：`skill_import_zip` 的 `ctx.files` 实现。
 *
 * 桌面的 `StagedSkillDirectory` 用「暂存目录 → rename 交换 → 备份回滚」保证原子性
 * （`skill-package.ts`）。OPFS 的目录句柄没有 `move()`（Chromium），目录 rename 在移动端
 * 明确是 `UnsupportedOnPlatform`，所以这里改成：
 *
 * 1. 暂存 `${base}/.<id>.staging-<uuid>`，所有条目先写进去；
 * 2. 提交时把现有技能目录复制到 `${base}/.<id>.backup-<uuid>`，再删旧目录、把暂存复制成正式目录；
 * 3. 提交后用 `AGENT_INSTALLED.json` + settings 写 provenance；settings 失败时 `rollback()`
 *    从备份恢复旧内容（与桌面同一顺序与错误文案）；
 * 4. `finalize()` 删除备份；`dispose()` 删除暂存。
 *
 * 这不是原子交换（移动端没有该能力），但每一步失败都会清理自己写下的内容，不会留下
 * 「一半新一半旧」的可见目录：正式目录只在暂存完整后创建。
 */
import type { FilesService } from '../../../../platform/files/api.ts';
import type { SkillImportZipResult } from '../../api.ts';
import { posix } from '../../../../platform/util/path.ts';
import { countYamlListItems } from '../package-core.ts';
import { debugPath, fail, MobileSkillPaths } from './paths.ts';
import { MAX_SKILL_PACKAGE_ZIP_BYTES, scanSkillZipBytesWithLimits, DEFAULT_ZIP_SCAN_LIMITS } from './zip.ts';
import { MobileSkillFiles, ioMessage } from './files.ts';

export const AGENT_INSTALLED_MARKER = 'AGENT_INSTALLED.json';
export const DEFAULT_AGENT_SKILLS_BASE = '~/.deep-student/skills';

export interface MobileSkillPackageLogger {
  warn?(message: string): void;
}

export interface ScannedMobileSkillPackage {
  result: SkillImportZipResult;
  files: Array<[string, Uint8Array]>;
  skillDir: string;
}

async function removeTree(files: FilesService, target: string): Promise<void> {
  try { await files.rm(target, { recursive: true, force: true }); }
  catch { /* boundary-allow empty-catch: best effort cleanup */ }
}

/** 递归复制目录：OPFS 目录没有 move()，提交/备份都靠逐文件读写。 */
async function copyTree(files: FilesService, from: string, to: string): Promise<void> {
  await files.mkdir(to, { recursive: true });
  for await (const entry of files.walk(from)) {
    if (entry.kind === 'directory') {
      await files.mkdir(posix.join(to, entry.relativePath), { recursive: true });
      continue;
    }
    if (entry.kind !== 'file') continue;
    const target = posix.join(to, entry.relativePath);
    const bytes = await files.readBytes(entry.path);
    await files.writeBytes(target, bytes, { createParents: true });
  }
}

export class MobileCommittedSkillDirectory {
  private readonly files: FilesService;
  private readonly liveDir: string;
  private backupDir: string | null;
  private finalized = false;

  constructor(files: FilesService, liveDir: string, backupDir: string | null) {
    this.files = files;
    this.liveDir = liveDir;
    this.backupDir = backupDir;
  }

  /** 撤销这次提交：删掉新目录，再从备份恢复旧内容（没有旧内容时等于卸载）。 */
  async rollback(): Promise<void> {
    if (this.finalized) return;
    await this.files.rm(this.liveDir, { recursive: true, force: true });
    if (this.backupDir !== null) {
      try { await copyTree(this.files, this.backupDir, this.liveDir); }
      catch (error) {
        throw new Error(`Failed to restore previous skill: ${ioMessage(error)}`);
      }
      await removeTree(this.files, this.backupDir);
      this.backupDir = null;
    }
    this.finalized = true;
  }

  async finalize(): Promise<void> {
    if (this.backupDir !== null) {
      await removeTree(this.files, this.backupDir);
      this.backupDir = null;
    }
    this.finalized = true;
  }
}

export class MobilePreparedSkillPackage {
  readonly result: SkillImportZipResult;
  private readonly files: FilesService;
  private readonly stagingDir: string;
  private readonly skillDir: string;
  private readonly overwrite: boolean;
  private disposed = false;

  constructor(
    files: FilesService, result: SkillImportZipResult, stagingDir: string, skillDir: string, overwrite: boolean,
  ) {
    this.files = files;
    this.result = result;
    this.stagingDir = stagingDir;
    this.skillDir = skillDir;
    this.overwrite = overwrite;
  }

  async writeStagedFile(relative: string, bytes: Uint8Array): Promise<void> {
    const parts = relative.replaceAll('\\', '/').split('/');
    if (!relative || relative.startsWith('/') || parts.some(part => !part || part === '.' || part === '..')) {
      throw new Error(`Invalid staged skill path: ${debugPath(relative)}`);
    }
    try {
      await this.files.writeBytes(posix.join(this.stagingDir, ...parts), bytes, { createParents: true });
    } catch (error) {
      throw new Error(`Failed to write staged file ${debugPath(posix.join(this.stagingDir, ...parts))}: ${ioMessage(error)}`);
    }
  }

  async commit(): Promise<[SkillImportZipResult, MobileCommittedSkillDirectory]> {
    let backupDir: string | null = null;
    try {
      const liveExists = await this.files.exists(this.skillDir);
      if (liveExists && !this.overwrite) {
        throw new Error(`Skill directory already exists: ${debugPath(this.skillDir)}. Pass overwrite=true to replace.`);
      }
      const parent = posix.dirname(this.skillDir);
      const name = posix.basename(this.skillDir);
      if (liveExists) {
        backupDir = posix.join(parent, `.${name}.backup-${globalThis.crypto.randomUUID()}`);
        try { await copyTree(this.files, this.skillDir, backupDir); }
        catch (error) {
          await removeTree(this.files, backupDir);
          throw new Error(`Failed to move existing skill ${debugPath(this.skillDir)} to rollback backup: ${ioMessage(error)}`);
        }
        try { await this.files.rm(this.skillDir, { recursive: true, force: true }); }
        catch (error) {
          // Do not merge staged files into the old package if its removal failed.
          throw new Error(`Failed to remove existing skill ${debugPath(this.skillDir)}. Rollback backup: ${debugPath(backupDir)}: ${ioMessage(error)}`);
        }
      }
      try {
        await copyTree(this.files, this.stagingDir, this.skillDir);
      } catch (error) {
        // A first-time install can fail partway through copyTree too.
        await this.files.rm(this.skillDir, { recursive: true, force: true });
        if (backupDir !== null) {
          try { await copyTree(this.files, backupDir, this.skillDir); }
          catch (restoreError) {
            throw new Error(
              `Failed to publish staged skill (${ioMessage(error)}), and failed to restore the previous skill (${ioMessage(restoreError)}). Rollback backup: ${debugPath(backupDir)}`);
          }
          await removeTree(this.files, backupDir);
          backupDir = null;
        }
        throw new Error(`Failed to publish staged skill: ${ioMessage(error)}`);
      }
      return [this.result, new MobileCommittedSkillDirectory(this.files, this.skillDir, backupDir)];
    } catch (error) {
      // Desktop `PreparedSkillPackage::commit()` maps every commit failure to `IO_ERROR`.
      fail('IO_ERROR', error instanceof Error ? error.message : String(error));
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await removeTree(this.files, this.stagingDir);
  }
}

export interface MobileVirtualZipReader {
  (uri: string, maxBytes: number): Promise<Uint8Array> | Uint8Array;
}

const VIRTUAL_SCHEMES = ['content://', 'asset://', 'ph://', 'image://', 'camera://'];
const ANDROID_SAF_PREFIXES = ['primary:', 'secondary:', 'raw:'];

/** Port of `unified_file_manager::is_virtual_uri` (SPECIAL_SCHEMES + SAF prefixes). */
export function isVirtualUri(value: string): boolean {
  const lower = value.trimStart().toLowerCase();
  return VIRTUAL_SCHEMES.some(scheme => lower.startsWith(scheme))
    || ANDROID_SAF_PREFIXES.some(prefix => lower.startsWith(prefix));
}

function decodeDataUri(value: string): Uint8Array | null {
  if (!value.startsWith('data:')) return null;
  const comma = value.indexOf(',');
  if (comma < 0) return null;
  const meta = value.slice(5, comma);
  const payload = value.slice(comma + 1);
  if (!meta.toLowerCase().includes(';base64')) {
    return new TextEncoder().encode(decodeURIComponent(payload));
  }
  const binary = atob(payload.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export class MobileSkillPackages {
  readonly files: MobileSkillFiles;
  private readonly fs: FilesService;
  private readonly paths: MobileSkillPaths;
  private readonly logger: MobileSkillPackageLogger;

  constructor(files: MobileSkillFiles, paths: MobileSkillPaths, logger: MobileSkillPackageLogger = {}) {
    this.files = files;
    this.fs = files.files;
    this.paths = paths;
    this.logger = logger;
  }

  async scanForBase(zipBytes: Uint8Array, basePath: string): Promise<ScannedMobileSkillPackage> {
    if (!zipBytes.length) fail('INVALID_INPUT', 'Skill package is empty');
    if (zipBytes.length > MAX_SKILL_PACKAGE_ZIP_BYTES) {
      fail('INVALID_INPUT', `Skill package too large (${zipBytes.length} bytes > ${MAX_SKILL_PACKAGE_ZIP_BYTES} bytes)`);
    }
    const expandedBase = this.files.expandPath(basePath);
    this.files.validatePath(expandedBase);

    let scan;
    try { scan = await scanSkillZipBytesWithLimits(zipBytes, DEFAULT_ZIP_SCAN_LIMITS); }
    catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }

    const skillDir = posix.join(expandedBase, scan.skillId);
    this.files.validatePath(posix.join(skillDir, 'SKILL.md'));

    let scriptsCount = 0;
    let referencesCount = 0;
    let skillMdContent = '';
    for (const [relative, bytes] of scan.files) {
      const lower = relative.replaceAll('\\', '/').toLowerCase();
      if (lower.startsWith('scripts/')) scriptsCount++;
      if (lower.startsWith('references/')) referencesCount++;
      if (lower === 'skill.md') skillMdContent = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
    }
    const allowedToolsCount = skillMdContent
      ? countYamlListItems(skillMdContent, 'allowed-tools') + countYamlListItems(skillMdContent, 'allowedTools')
      : 0;

    // 移动端没有外部 PATH / Python 环境可探测，`requires` 省略（契约中该字段可选）。
    const result: SkillImportZipResult = {
      skill_id: scan.skillId,
      path: skillDir,
      files_extracted: scan.files.length,
      scripts_count: scriptsCount,
      references_count: referencesCount,
      allowed_tools_count: allowedToolsCount,
      package_sha256: scan.packageSha256,
      risk_level: scan.riskLevel,
      risk_signals: scan.riskSignals,
    };
    return { result, files: scan.files, skillDir };
  }

  async prepare(zipBytes: Uint8Array, basePath: string, overwrite: boolean): Promise<MobilePreparedSkillPackage> {
    const scanned = await this.scanForBase(zipBytes, basePath);
    if (await this.fs.exists(scanned.skillDir) && !overwrite) {
      fail('INVALID_INPUT', `Skill directory already exists: ${debugPath(scanned.skillDir)}. Pass overwrite=true to replace.`);
    }
    const parent = posix.dirname(scanned.skillDir);
    const name = posix.basename(scanned.skillDir);
    const stagingDir = posix.join(parent, `.${name}.staging-${globalThis.crypto.randomUUID()}`);
    try { await this.fs.mkdir(stagingDir, { recursive: true }); }
    catch (error) { return fail('IO_ERROR', `Failed to create skill staging directory ${debugPath(stagingDir)}: ${ioMessage(error)}`); }
    try {
      for (const [relative, bytes] of scanned.files) {
        await this.fs.writeBytes(posix.join(stagingDir, ...relative.split('/')), bytes, { createParents: true });
      }
    } catch (error) {
      await removeTree(this.fs, stagingDir);
      return fail('IO_ERROR', `Failed to write staged file: ${ioMessage(error)}`);
    }
    return new MobilePreparedSkillPackage(this.fs, scanned.result, stagingDir, scanned.skillDir, overwrite);
  }

  async install(
    zipBytes: Uint8Array, basePath: string, overwrite: boolean, dryRun: boolean,
  ): Promise<SkillImportZipResult> {
    if (dryRun) return (await this.scanForBase(zipBytes, basePath)).result;
    const prepared = await this.prepare(zipBytes, basePath, overwrite);
    try {
      const [result, committed] = await prepared.commit();
      await committed.finalize();
      return result;
    } finally {
      await prepared.dispose();
    }
  }

  async readZipBytes(zipPath: string, readVirtual?: MobileVirtualZipReader): Promise<Uint8Array> {
    const dataUri = decodeDataUri(zipPath.trim());
    if (dataUri !== null) {
      if (dataUri.length > MAX_SKILL_PACKAGE_ZIP_BYTES) {
        fail('INVALID_INPUT', `Zip file too large (> ${MAX_SKILL_PACKAGE_ZIP_BYTES} bytes)`);
      }
      return dataUri;
    }
    if (isVirtualUri(zipPath)) {
      const uri = zipPath.trim();
      if (readVirtual === undefined) {
        return fail('IO_ERROR', `Failed to read zip: virtual file URI is not readable on this platform: ${uri}`);
      }
      let bytes: Uint8Array;
      try { bytes = await readVirtual(uri, MAX_SKILL_PACKAGE_ZIP_BYTES); }
      catch (error) { return fail('IO_ERROR', `Failed to read zip: ${ioMessage(error)}`); }
      if (bytes.length > MAX_SKILL_PACKAGE_ZIP_BYTES) {
        fail('INVALID_INPUT', `Zip file too large (> ${MAX_SKILL_PACKAGE_ZIP_BYTES} bytes)`);
      }
      return bytes;
    }

    const expanded = this.files.expandPath(zipPath);
    let stat;
    try { stat = await this.fs.stat(expanded); }
    catch { return fail('INVALID_INPUT', `Zip file not found: ${debugPath(expanded)}`); }
    if (stat.kind !== 'file') return fail('INVALID_INPUT', `Zip file not found: ${debugPath(expanded)}`);
    if (stat.size > MAX_SKILL_PACKAGE_ZIP_BYTES) {
      fail('INVALID_INPUT', `Zip file too large (${stat.size} bytes > ${MAX_SKILL_PACKAGE_ZIP_BYTES} bytes)`);
    }
    let bytes: Uint8Array;
    try { bytes = await this.fs.readBytes(expanded, { maxBytes: MAX_SKILL_PACKAGE_ZIP_BYTES }); }
    catch (error) { return fail('IO_ERROR', `Failed to read zip ${debugPath(expanded)}: ${ioMessage(error)}`); }
    if (bytes.length > MAX_SKILL_PACKAGE_ZIP_BYTES) {
      fail('INVALID_INPUT', `Zip grew beyond the ${MAX_SKILL_PACKAGE_ZIP_BYTES} byte limit while being read`);
    }
    return bytes;
  }

  async importZip(
    zipPath: string, basePath: string, overwrite: boolean, dryRun: boolean | null | undefined,
    readVirtual?: MobileVirtualZipReader,
  ): Promise<SkillImportZipResult> {
    const bytes = await this.readZipBytes(zipPath, readVirtual);
    return this.install(bytes, basePath, overwrite, dryRun ?? false);
  }
}
