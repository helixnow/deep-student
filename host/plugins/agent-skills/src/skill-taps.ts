/**
 * Tap skill sources: repo URL → codeload zip, catalog scan, deterministic repack,
 * install with provenance, and export back to a tap-shaped zip.
 * Ported from `src-tauri/crates/dstu-agent/src/chat_v2/skill_taps.rs` and the app
 * wrapper `src-tauri/src/chat_v2/skill_taps.rs`.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { now } from '../../../platform/time/index.ts';
import type { SkillImportZipResult, TapCatalog, TapCatalogEntry, TapExportResult } from '../api.ts';
import { fail, ioMessage, type SkillFiles } from './files.ts';
import type { HttpService } from '../../../platform/http/api.ts';
import { skillDownloadHttp } from './http.ts';
import { DEFAULT_AGENT_SKILLS_BASE, SkillPackages } from './skill-package.ts';
import {
  buildZip, MAX_SKILL_PACKAGE_ZIP_BYTES, readZipEntries, readZipEntry, ZipBudgetExceeded, type ZipEntry,
} from './zip.ts';
import { isZipWorkerInfrastructureError, runZipTask } from './workers/zip-pool.ts';
import {
  CODELOAD_PREFIX, DOUBLE_ENCODED_VIRTUAL_URI_REJECTED, decodeTapSourceDetail, encodeTapSourceDetail,
  extractSkillSummary, fetchRepoZip, isSpecialScheme, isVirtualTapPath, is_valid_skill_dir_name,
  repoNameFromZipUrl, repoZipTopPrefix, resolveCodeloadCandidates,
} from './taps-core.ts';

// Portable URL/provenance helpers live in `taps-core.ts` so the mobile host shares them.
export {
  CODELOAD_PREFIX, decodeTapSourceDetail, encodeTapSourceDetail, extractSkillSummary, fetchRepoZip,
  is_valid_skill_dir_name, repoNameFromZipUrl, repoZipTopPrefix, resolveCodeloadCandidates,
} from './taps-core.ts';

export const AGENT_INSTALLED_MARKER = 'AGENT_INSTALLED.json';
const MAX_CATALOG_SKILLS = 200;
const MAX_SKILL_DIR_DEPTH = 4;
const MAX_SKILL_MD_PREVIEW_BYTES = 256 * 1024;
const PROVENANCE_SETTINGS_PREFIX = 'skill.provenance.';

function openRepoArchive(zipBytes: Uint8Array): ZipEntry[] {
  try { return readZipEntries(zipBytes); }
  catch (error) { throw new Error(`Invalid repository zip: ${error instanceof Error ? error.message : String(error)}`); }
}

export function scanRepoZipForCatalog(zipBytes: Uint8Array): TapCatalogEntry[] {
  const entries = openRepoArchive(zipBytes);
  const entryNames = entries.map(entry => entry.name);
  const prefix = repoZipTopPrefix(entryNames) ?? '';

  const skillMdIndexes: Array<[number, string]> = [];
  for (const [index, rawName] of entryNames.entries()) {
    const norm = rawName.replaceAll('\\', '/');
    if (!norm.startsWith(prefix)) continue;
    const relative = norm.slice(prefix.length);
    if (relative.includes('..')) continue;
    if (relative.split('/').some(segment => segment.startsWith('.'))) continue;
    if (!(relative === 'SKILL.md' || relative.endsWith('/SKILL.md'))) continue;
    if ((relative.match(/\//g) ?? []).length > MAX_SKILL_DIR_DEPTH) continue;
    skillMdIndexes.push([index, relative]);
    if (skillMdIndexes.length >= MAX_CATALOG_SKILLS) break;
  }

  const result: TapCatalogEntry[] = [];
  for (const [index, relative] of skillMdIndexes) {
    const subdir = relative.replace(/SKILL\.md$/, '').replace(/\/+$/, '');
    const skillId = subdir === '' ? '' : subdir.slice(subdir.lastIndexOf('/') + 1);
    if (subdir !== '' && !is_valid_skill_dir_name(skillId)) continue;

    let content = '';
    const entry = entries[index]!;
    if (entry.size <= MAX_SKILL_MD_PREVIEW_BYTES) {
      try { content = Buffer.from(readZipEntry(zipBytes, entry, MAX_SKILL_MD_PREVIEW_BYTES)).toString('utf8'); }
      catch (error) { if (!(error instanceof ZipBudgetExceeded)) throw error; }
    }
    const [name, description, version] = extractSkillSummary(content);
    const dirPrefix = subdir === '' ? prefix : `${prefix}${subdir}/`;
    const fileCount = entryNames.filter(name2 => {
      const norm = name2.replaceAll('\\', '/');
      return norm.startsWith(dirPrefix) && !norm.endsWith('/');
    }).length;
    result.push({ subdir, skillId, name, description, version, fileCount });
  }

  result.sort((a, b) => Number(a.subdir === '') - Number(b.subdir === '') || Buffer.compare(Buffer.from(a.subdir), Buffer.from(b.subdir)));
  return result;
}

export function repackSkillSubdir(repoZip: Uint8Array, subdirRaw: string, fallbackDirName: string): Uint8Array {
  const entries = openRepoArchive(repoZip);
  const entryNames = entries.map(entry => entry.name);
  const prefix = repoZipTopPrefix(entryNames) ?? '';

  const subdir = subdirRaw.replace(/^\/+|\/+$/g, '');
  if (subdir.includes('..')) throw new Error('Invalid skill subdirectory');
  const dirName = subdir === '' ? fallbackDirName : subdir.slice(subdir.lastIndexOf('/') + 1);
  if (!is_valid_skill_dir_name(dirName)) throw new Error(`Invalid skill directory name: ${dirName}`);
  const dirPrefix = subdir === '' ? prefix : `${prefix}${subdir}/`;

  const members: Array<[string, number]> = [];
  for (const [index, rawName] of entryNames.entries()) {
    const norm = rawName.replaceAll('\\', '/');
    if (!norm.startsWith(dirPrefix) || norm.endsWith('/')) continue;
    const relative = norm.slice(dirPrefix.length);
    if (!relative || relative.includes('..')) continue;
    if (relative.split('/').some(segment => !segment || segment.startsWith('.'))) continue;
    members.push([`${dirName}/${relative}`, index]);
  }
  if (!members.length) throw new Error(`No files found under skill directory '${subdir}'`);
  members.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));

  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  let total = 0;
  for (const [outPath, index] of members) {
    const bytes = readZipEntry(repoZip, entries[index]!);
    total += bytes.length;
    if (total > MAX_SKILL_PACKAGE_ZIP_BYTES) {
      throw new Error(`Skill directory exceeds the ${MAX_SKILL_PACKAGE_ZIP_BYTES} byte package limit`);
    }
    files.push({ name: outPath, bytes });
  }
  const out = buildZip(files);
  if (out.length > MAX_SKILL_PACKAGE_ZIP_BYTES) {
    throw new Error(`Repacked skill package exceeds the ${MAX_SKILL_PACKAGE_ZIP_BYTES} byte limit`);
  }
  return out;
}

export function validateTapExportDestination(destPath: string): boolean {
  if (isVirtualTapPath(destPath)) return true;
  const decoded = (() => { try { return decodeURIComponent(destPath); } catch { return destPath; } })();
  if (isSpecialScheme(decoded)) throw new Error(DOUBLE_ENCODED_VIRTUAL_URI_REJECTED);
  if (path.extname(destPath.replace(/\/+$/, '')) !== '.zip') throw new Error('Destination must be a .zip file');
  return false;
}

/**
 * Rust `write_tap_export_zip` runs inside the export `spawn_blocking`
 * (skill_taps.rs:690-732,762-884); the Host awaits fs/promises so the up to
 * 64 MiB write stays off the event loop. Staging is removed on every exit.
 */
export async function writeTapExportZip(
  bytes: Uint8Array,
  destPath: string,
  destIsVirtual: boolean,
  stagingDir: string,
  writeVirtual: (staged: string, target: string) => void,
  logger: TapLogger = { warn: message => process.emitWarning(message) },
): Promise<string> {
  if (!destIsVirtual) {
    try { await writeFile(destPath, bytes); }
    catch (error) { throw new Error(`Failed to write ${destPath}: ${ioMessage(error)}`); }
    return destPath;
  }
  try { await mkdir(stagingDir, { recursive: true }); }
  catch (error) { throw new Error(`Failed to create staging dir: ${ioMessage(error)}`); }
  const staged = path.join(stagingDir, `skills_tap_${randomUUID()}.zip`);
  try {
    try { await writeFile(staged, bytes); }
    catch (error) { throw new Error(`Failed to stage export ${staged}: ${ioMessage(error)}`); }
    try { writeVirtual(staged, destPath.trim()); }
    catch (error) { throw new Error(`Failed to write ${destPath}: ${error instanceof Error ? error.message : String(error)}`); }
  } finally {
    try { await rm(staged, { force: true }); }
    catch (error) { logger.warn?.(`[agent-skills] failed to remove staged export ${staged}: ${ioMessage(error)}`); }
  }
  return destPath.trim();
}

function walkFiles(root: string): Array<{ relative: string; full: string }> {
  const out: Array<{ relative: string; full: string }> = [];
  const visit = (current: string, relative: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { visit(full, nextRelative); continue; }
      if (!entry.isFile()) continue;
      out.push({ relative: nextRelative, full });
    }
  };
  visit(root, '');
  return out;
}

export interface TapExportArchive {
  zipBytes: Uint8Array;
  skillCount: number;
  fileCount: number;
}

/** CPU-bound part of `skill_export_tap`: walk, read, hash and deflate off the Host loop. */
export function buildTapExportArchive(base: string, skillIds: readonly string[]): TapExportArchive {
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
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
    const skillDir = path.join(base, skillId);
    if (!existsSync(skillDir) || !statSync(skillDir).isDirectory()) {
      throw new Error(`Skill directory not found: ${skillId}`);
    }
    let summary: [string, string, string] = ['', '', ''];
    const members: Array<[string, string]> = [];
    for (const member of walkFiles(skillDir)) {
      const relative = member.relative.replaceAll('\\', '/');
      if (relative.split('/').some(segment => segment.startsWith('.')) || relative === AGENT_INSTALLED_MARKER) continue;
      if (relative === 'SKILL.md') {
        try { summary = extractSkillSummary(readFileSync(member.full, 'utf8')); }
        catch { summary = ['', '', '']; }
      }
      members.push([`${skillId}/${relative}`, member.full]);
    }
    if (!members.length) throw new Error(`Skill '${skillId}' has no exportable files`);
    members.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));

    for (const [outPath, fsPath] of members) {
      let bytes: Buffer;
      try { bytes = readFileSync(fsPath); }
      catch (error) { throw new Error(`Failed to read ${outPath}: ${ioMessage(error)}`); }
      total += bytes.length;
      if (total > MAX_SKILL_PACKAGE_ZIP_BYTES) {
        throw new Error(`Export exceeds the ${MAX_SKILL_PACKAGE_ZIP_BYTES} byte limit`);
      }
      files.push({ name: outPath, bytes });
      fileCount++;
    }

    const [name, description, version] = summary;
    const display = name || skillId;
    const ver = version ? ` (v${version})` : '';
    readmeLines.push(`- **${display}**${ver} — \`${skillId}/\`：${description}`);
    skillCount++;
  }

  readmeLines.push('');
  files.push({ name: 'README.md', bytes: Buffer.from(readmeLines.join('\n')) });
  fileCount++;

  return { zipBytes: buildZip(files), skillCount, fileCount };
}

export interface TapSettingsWriter {
  (key: string, value: string): void;
}

export interface TapLogger {
  warn?(message: string): void;
}

export class SkillTaps {
  _files: SkillFiles;
  _packages: SkillPackages;
  _stagingDir: string;
  _http: () => HttpService | null;
  _logger: TapLogger;
  constructor(
    files: SkillFiles,
    packages: SkillPackages,
    appDataDir: string,
    http: () => HttpService | null,
    logger: TapLogger = { warn: message => process.emitWarning(message) },
  ) {
    this._files = files;
    this._packages = packages;
    this._stagingDir = path.join(appDataDir, 'temp_skill_tap_export');
    this._http = http;
    this._logger = logger;
  }

  async catalog(repoUrl: string): Promise<TapCatalog> {
    let candidates: string[];
    try { candidates = resolveCodeloadCandidates(repoUrl); }
    catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }
    let bytes: Uint8Array;
    let resolvedZipUrl: string;
    try { [bytes, resolvedZipUrl] = await fetchRepoZip(candidates, skillDownloadHttp(this._http)); }
    catch (error) { return fail('IO_ERROR', error instanceof Error ? error.message : String(error)); }
    let skills: TapCatalogEntry[];
    try { skills = await runZipTask<TapCatalogEntry[]>('scanRepoZip', { zipBytes: bytes }); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isZipWorkerInfrastructureError(error)) {
        return fail('IO_ERROR', `Catalog scan task failed: ${message}`);
      }
      return fail('INVALID_INPUT', message);
    }
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
    try { [repoBytes, resolvedUrl] = await fetchRepoZip([zipUrl], skillDownloadHttp(this._http)); }
    catch (error) { return fail('IO_ERROR', error instanceof Error ? error.message : String(error)); }

    const fallbackName = repoNameFromZipUrl(resolvedUrl);
    let packageBytes: Uint8Array;
    try {
      packageBytes = await runZipTask<Uint8Array>('repackSkillSubdir', {
        zipBytes: repoBytes, subdir, fallbackDirName: fallbackName,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isZipWorkerInfrastructureError(error)) return fail('IO_ERROR', `Repack task failed: ${message}`);
      return fail('INVALID_INPUT', message);
    }

    if (dryRun ?? false) {
      return this._packages.install(packageBytes, DEFAULT_AGENT_SKILLS_BASE, overwrite, true);
    }

    const prepared = await this._packages.prepare(packageBytes, DEFAULT_AGENT_SKILLS_BASE, overwrite);
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
      try { prepared.writeStagedFile(AGENT_INSTALLED_MARKER, Buffer.from(provenanceJson)); }
      catch (error) { return fail('IO_ERROR', error instanceof Error ? error.message : String(error)); }

      const [installed, committed] = prepared.commit();
      const key = `${PROVENANCE_SETTINGS_PREFIX}${installed.skill_id}`;
      let persistError: unknown;
      try { saveSetting(key, provenanceJson); }
      catch (error) { persistError = error; }
      if (persistError !== undefined) {
        const message = persistError instanceof Error ? persistError.message : String(persistError);
        try { committed.rollback(); }
        catch (rollbackError) {
          fail('IO_ERROR', `Failed to persist tap provenance (${message}), and rollback also failed (${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}).`);
        }
        fail('IO_ERROR', `Failed to persist tap provenance (${message}); the install was rolled back.`);
      }
      committed.finalize();
      return installed;
    } finally {
      prepared.dispose();
    }
  }

  async exportTap(skillIds: readonly string[], destPath: string, writeVirtual: (staged: string, target: string) => void): Promise<TapExportResult> {
    if (!skillIds.length) fail('INVALID_INPUT', 'No skills selected');
    if (skillIds.length > 64) fail('INVALID_INPUT', 'Too many skills (max 64)');
    for (const id of skillIds) {
      if (!is_valid_skill_dir_name(id)) fail('INVALID_INPUT', `Invalid skill id: ${id}`);
    }
    let destIsVirtual: boolean;
    try { destIsVirtual = validateTapExportDestination(destPath); }
    catch (error) { return fail('INVALID_INPUT', error instanceof Error ? error.message : String(error)); }

    const base = this._files.expandPath(DEFAULT_AGENT_SKILLS_BASE);
    try {
      const archive = await runZipTask<TapExportArchive>('exportTap', { base, skillIds });
      const written = await writeTapExportZip(
        archive.zipBytes, destPath, destIsVirtual, this._stagingDir, writeVirtual, this._logger,
      );
      return { path: written, skillCount: archive.skillCount, fileCount: archive.fileCount };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (isZipWorkerInfrastructureError(error)) return fail('IO_ERROR', `Export task failed: ${message}`);
      return fail('IO_ERROR', message);
    }
  }
}

