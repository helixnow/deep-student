/**
 * Portable tap repacking / catalog scanning over `platform/zip/core`.
 *
 * The desktop `skill-taps.ts` keeps its synchronous zlib versions (worker pool); this module
 * provides the async equivalents used by the mobile host and as the default for direct
 * `updates-core` calls. Error text matches `skill_taps.rs` / `repackSkillSubdir`.
 */
import {
  MemoryZipSink, ZipReader, ZipWriter, memoryZipSource,
} from '../../../platform/zip/core/index.ts';
import { compareUtf8 } from '../../../platform/util/portable.ts';
import { MAX_SKILL_PACKAGE_ZIP_BYTES } from './package-core.ts';
import {
  extractSkillSummary, is_valid_skill_dir_name, repoZipTopPrefix,
} from './taps-core.ts';
import type { ZipEntry } from '../../../platform/zip/core/index.ts';
import type { TapCatalogEntry } from '../api.ts';

const MAX_CATALOG_SKILLS = 200;
const MAX_SKILL_DIR_DEPTH = 4;
const MAX_SKILL_MD_PREVIEW_BYTES = 256 * 1024;

async function openRepoArchive(zipBytes: Uint8Array): Promise<ZipReader> {
  try { return await ZipReader.open(memoryZipSource(zipBytes)); }
  catch (error) {
    throw new Error(`Invalid repository zip: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function readEntry(reader: ZipReader, entry: ZipEntry): Promise<Uint8Array> {
  try { return await reader.readEntry(entry); }
  catch (error) { throw new Error(`Zip read error: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Async port of `scanRepoZipForCatalog` (`skill_taps.rs`). */
export async function scanRepoZipForCatalog(zipBytes: Uint8Array): Promise<TapCatalogEntry[]> {
  const reader = await openRepoArchive(zipBytes);
  const entries = reader.entries;
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
      try { content = new TextDecoder('utf-8').decode(await reader.readEntry(entry)); }
      catch { content = ''; }
    }
    const [name, description, version] = extractSkillSummary(content);
    const dirPrefix = subdir === '' ? prefix : `${prefix}${subdir}/`;
    const fileCount = entryNames.filter(candidate => {
      const norm = candidate.replaceAll('\\', '/');
      return norm.startsWith(dirPrefix) && !norm.endsWith('/');
    }).length;
    result.push({ subdir, skillId, name, description, version, fileCount });
  }

  result.sort((a, b) => Number(a.subdir === '') - Number(b.subdir === '')
    || compareUtf8(a.subdir, b.subdir));
  return result;
}

/** Async port of `repackSkillSubdir` (`skill_taps.rs`). */
export async function repackSkillSubdir(
  repoZip: Uint8Array,
  subdirRaw: string,
  fallbackDirName: string,
): Promise<Uint8Array> {
  const reader = await openRepoArchive(repoZip);
  const entries = reader.entries;
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
  members.sort((a, b) => compareUtf8(a[0], b[0]));

  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  let total = 0;
  for (const [outPath, index] of members) {
    const bytes = await readEntry(reader, entries[index]!);
    total += bytes.length;
    if (total > MAX_SKILL_PACKAGE_ZIP_BYTES) {
      throw new Error(`Skill directory exceeds the ${MAX_SKILL_PACKAGE_ZIP_BYTES} byte package limit`);
    }
    files.push({ name: outPath, bytes });
  }
  const sink = new MemoryZipSink();
  const writer = new ZipWriter(sink);
  for (const file of files) await writer.addBytes(file.name, file.bytes);
  await writer.finish();
  const out = sink.bytes();
  if (out.length > MAX_SKILL_PACKAGE_ZIP_BYTES) {
    throw new Error(`Repacked skill package exceeds the ${MAX_SKILL_PACKAGE_ZIP_BYTES} byte limit`);
  }
  return out;
}
