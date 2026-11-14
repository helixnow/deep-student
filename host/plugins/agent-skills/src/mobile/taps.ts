/**
 * 移动端 tap 技能源：`skill_tap_catalog` / `skill_tap_install` / `skill_export_tap`。
 *
 * URL 解析、codeload 下载、provenance 编码来自 `taps-core.ts`；仓库 zip 的扫描/重打包走
 * `repack-core.ts`（`platform/zip/core`）。只有 IO 换成 `ctx.files`：
 * - 导出时逐文件读取技能目录并现场打 zip（桌面是 `readdirSync` + worker）；
 * - 移动端没有系统保存对话框，`content://` 之类的虚拟目标明确拒绝。
 */
import { CommandError } from '../../../../kernel/api.ts';
import type { HttpService } from '../../../../platform/http/api.ts';
import type { SkillImportZipResult, TapCatalog, TapCatalogEntry, TapExportResult } from '../../api.ts';
import { now } from '../../../../platform/time/index.ts';
import { posix } from '../../../../platform/util/path.ts';
import { compareUtf8 } from '../../../../platform/util/portable.ts';
import { skillDownloadHttp } from '../http.ts';
import { MAX_SKILL_PACKAGE_ZIP_BYTES } from '../package-core.ts';
import { repackSkillSubdir, scanRepoZipForCatalog } from '../repack-core.ts';
import {
  CODELOAD_PREFIX, DOUBLE_ENCODED_VIRTUAL_URI_REJECTED, extractSkillSummary, fetchRepoZip,
  isSpecialScheme, isVirtualTapPath, is_valid_skill_dir_name, repoNameFromZipUrl,
  resolveCodeloadCandidates, encodeTapSourceDetail,
} from '../taps-core.ts';
import { fail } from './paths.ts';
import { ioMessage, MobileSkillFiles } from './files.ts';
import { AGENT_INSTALLED_MARKER, DEFAULT_AGENT_SKILLS_BASE, MobileSkillPackages } from './package.ts';
import { buildZipBytes } from './zip.ts';

const PROVENANCE_SETTINGS_PREFIX = 'skill.provenance.';

export interface MobileTapLogger {
  warn?(message: string): void;
}

export type TapSettingsWriter = (key: string, value: string) => void;

/** 移动端导出目标只能是 OPFS 内的真实路径（没有系统对话框）。 */
export function validateMobileTapExportDestination(destPath: string): void {
  if (isVirtualTapPath(destPath)) {
    throw new Error('Exporting to a virtual file URI is not available on mobile');
  }
  const decoded = (() => { try { return decodeURIComponent(destPath); } catch { return destPath; } })();
  if (isSpecialScheme(decoded)) throw new Error(DOUBLE_ENCODED_VIRTUAL_URI_REJECTED);
  if (posix.extname(destPath.replace(/\/+$/, '')) !== '.zip') throw new Error('Destination must be a .zip file');
}

export class MobileSkillTaps {
  private readonly files: MobileSkillFiles;
  private readonly packages: MobileSkillPackages;
  private readonly http: () => HttpService | null;
  private readonly logger: MobileTapLogger;

  constructor(
    files: MobileSkillFiles, packages: MobileSkillPackages, http: () => HttpService | null,
    logger: MobileTapLogger = {},
  ) {
    this.files = files;
    this.packages = packages;
    this.http = http;
    this.logger = logger;
  }

  async catalog(repoUrl: string): Promise<TapCatalog> {
    let candidates: string[];
    try { candidates = resolveCodeloadCandidates(repoUrl); }
    catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }
    let bytes: Uint8Array;
    let resolvedZipUrl: string;
    try { [bytes, resolvedZipUrl] = await fetchRepoZip(candidates, skillDownloadHttp(this.http)); }
    catch (error) { return fail('IO_ERROR', error instanceof Error ? error.message : String(error)); }
    let skills: TapCatalogEntry[];
    try { skills = await scanRepoZipForCatalog(bytes); }
    catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }
    return { repoUrl, resolvedZipUrl, skills };
  }

  async install(
    zipUrl: string,
    subdir: string,
    overwrite: boolean,
    dryRun: boolean | null | undefined,
    expectedPackageSha256: string | null | undefined,
    saveSetting: TapSettingsWriter,
  ): Promise<SkillImportZipResult> {
    if (!zipUrl.startsWith(CODELOAD_PREFIX)) {
      fail('INVALID_INPUT', 'zip_url must be a resolved codeload.github.com link from skill_tap_catalog');
    }
    let repoBytes: Uint8Array;
    let resolvedUrl: string;
    try { [repoBytes, resolvedUrl] = await fetchRepoZip([zipUrl], skillDownloadHttp(this.http)); }
    catch (error) { return fail('IO_ERROR', error instanceof Error ? error.message : String(error)); }

    const fallbackName = repoNameFromZipUrl(resolvedUrl);
    let packageBytes: Uint8Array;
    try { packageBytes = await repackSkillSubdir(repoBytes, subdir, fallbackName); }
    catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }

    if (dryRun ?? false) {
      return this.packages.install(packageBytes, DEFAULT_AGENT_SKILLS_BASE, overwrite, true);
    }

    const prepared = await this.packages.prepare(packageBytes, DEFAULT_AGENT_SKILLS_BASE, overwrite);
    try {
      if (expectedPackageSha256 === null || expectedPackageSha256 === undefined) {
        fail('INVALID_INPUT', 'expectedPackageSha256 is required when installing a tap skill');
      }
      const expected = expectedPackageSha256.trim().toLowerCase();
      if (expected.length !== 64 || !/^[0-9a-f]+$/.test(expected)) {
        fail('INVALID_INPUT', 'expectedPackageSha256 must be a 64-character SHA-256 digest');
      }
      const actual = prepared.result.package_sha256.toLowerCase();
      let difference = 0;
      for (let index = 0; index < 64; index++) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
      if (difference !== 0) {
        fail('INVALID_INPUT', `Tap package changed after confirmation: expected ${expected}, got ${actual}`);
      }

      const provenance = {
        sourceKind: 'tap',
        sourceDetail: encodeTapSourceDetail(resolvedUrl, subdir),
        packageSha256: prepared.result.package_sha256,
        riskLevel: prepared.result.risk_level,
        installedAt: now().rfc3339,
        sessionId: 'skills_management',
      };
      const provenanceJson = JSON.stringify(provenance, null, 2);
      try { await prepared.writeStagedFile(AGENT_INSTALLED_MARKER, new TextEncoder().encode(provenanceJson)); }
      catch (error) { return fail('IO_ERROR', ioMessage(error)); }

      const [installed, committed] = await prepared.commit();
      const key = `${PROVENANCE_SETTINGS_PREFIX}${installed.skill_id}`;
      let persistError: unknown;
      try { saveSetting(key, provenanceJson); }
      catch (error) { persistError = error; }
      if (persistError !== undefined) {
        const message = ioMessage(persistError);
        try { await committed.rollback(); }
        catch (rollbackError) {
          fail('IO_ERROR',
            `Failed to persist tap provenance (${message}), and rollback also failed (${ioMessage(rollbackError)}).`);
        }
        fail('IO_ERROR', `Failed to persist tap provenance (${message}); the install was rolled back.`);
      }
      await committed.finalize();
      return installed;
    } finally {
      await prepared.dispose();
    }
  }

  async exportTap(skillIds: readonly string[], destPath: string): Promise<TapExportResult> {
    if (!skillIds.length) fail('INVALID_INPUT', 'No skills selected');
    if (skillIds.length > 64) fail('INVALID_INPUT', 'Too many skills (max 64)');
    for (const id of skillIds) {
      if (!is_valid_skill_dir_name(id)) fail('INVALID_INPUT', `Invalid skill id: ${id}`);
    }
    try { validateMobileTapExportDestination(destPath); }
    catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }

    try {
      return await this._exportArchive(skillIds, destPath);
    } catch (error) {
      if (error instanceof CommandError) throw error;
      return fail('IO_ERROR', error instanceof Error ? error.message : String(error));
    }
  }

  private async _exportArchive(skillIds: readonly string[], destPath: string): Promise<TapExportResult> {
    const base = this.files.expandPath(DEFAULT_AGENT_SKILLS_BASE);
    const files: Array<{ relative: string; bytes: Uint8Array }> = [];
    const readmeLines = [
      '# Skills Tap', '',
      'Exported from Deep Student. Push this directory to a GitHub repository,',
      'then anyone can browse & install these skills via a skill source (tap) URL.', '',
      '## Skills', '',
    ];
    let fileCount = 0;
    let skillCount = 0;
    let total = 0;

    for (const skillId of skillIds) {
      const skillDir = posix.join(base, skillId);
      if (!await this.files.exists(skillDir)) throw new Error(`Skill directory not found: ${skillId}`);
      let summary: [string, string, string] = ['', '', ''];
      const members: Array<[string, string]> = [];
      for await (const entry of this.files.files.walk(skillDir)) {
        if (entry.kind !== 'file') continue;
        const relative = entry.relativePath.replaceAll('\\', '/');
        if (relative.split('/').some(segment => segment.startsWith('.'))) continue;
        if (relative === AGENT_INSTALLED_MARKER) continue;
        if (relative === 'SKILL.md') {
          try { summary = extractSkillSummary(await this.files.files.readText(entry.path)); }
          catch { summary = ['', '', '']; }
        }
        members.push([`${skillId}/${relative}`, entry.path]);
      }
      if (!members.length) throw new Error(`Skill '${skillId}' has no exportable files`);
      members.sort((a, b) => compareUtf8(a[0], b[0]));

      for (const [outPath, path] of members) {
        let bytes: Uint8Array;
        try { bytes = await this.files.files.readBytes(path); }
        catch (error) { throw new Error(`Failed to read ${outPath}: ${ioMessage(error)}`); }
        total += bytes.length;
        if (total > MAX_SKILL_PACKAGE_ZIP_BYTES) {
          throw new Error(`Export exceeds the ${MAX_SKILL_PACKAGE_ZIP_BYTES} byte limit`);
        }
        files.push({ relative: outPath, bytes });
        fileCount++;
      }

      const [name, description, version] = summary;
      const display = name || skillId;
      const ver = version ? ` (v${version})` : '';
      readmeLines.push(`- **${display}**${ver} — \`${skillId}/\`：${description}`);
      skillCount++;
    }

    readmeLines.push('');
    files.push({ relative: 'README.md', bytes: new TextEncoder().encode(readmeLines.join('\n')) });
    fileCount++;

    let zipBytes: Uint8Array;
    try { zipBytes = await buildZipBytes(files); }
    catch (error) { return fail('IO_ERROR', `Export task failed: ${ioMessage(error)}`); }
    const target = this.files.paths.expandForFiles(destPath);
    try { await this.files.files.writeBytes(target, zipBytes); }
    catch (error) { return fail('IO_ERROR', `Failed to write ${target}: ${ioMessage(error)}`); }
    return { path: target, skillCount, fileCount };
  }
}
