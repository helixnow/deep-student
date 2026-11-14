/**
 * 移动端技能包 ZIP 读写：同一套上限与错误文案，实现换成 `platform/zip/core`。
 *
 * 桌面 `skill-package.ts` 用 `node:zlib` 同步 inflate 与 worker 池；移动端 Worker 里没有
 * `node:zlib`，`CompressionStream('deflate-raw')` 才是可用实现，因此这里用流式 `ZipReader`
 * 逐条目读取、按 `scan_skill_zip_bytes_with_limits` 的预算与文案校验，并把结果交给
 * 同一份 `package-core.ts` 启发式（风险分级、SKILL.md 发现）。
 */
import { sha256HexSync } from '../../../../platform/crypto/sync.ts';
import {
  MemoryZipSink, ZipReader, ZipWriter, memoryZipSource,
} from '../../../../platform/zip/core/index.ts';
import { utf8ByteLength } from '../../../../platform/util/portable.ts';
import {
  DEFAULT_ZIP_SCAN_LIMITS, MAX_SKILL_PACKAGE_ZIP_BYTES, assessSkillPackageRisk, isSafeZipEntry,
  rootSkillIdFromFrontmatter, zipSkillPrefix, type SkillFileBytes, type ZipScanLimits, type ZipScanOutcome,
} from '../package-core.ts';
import { zipEntryCountPreflight } from '../zip-entries.ts';
import type { ZipEntry } from '../../../../platform/zip/core/index.ts';

export { DEFAULT_ZIP_SCAN_LIMITS, MAX_SKILL_PACKAGE_ZIP_BYTES };
export type { ZipScanLimits, ZipScanOutcome };

/** 与桌面 `ZipBudgetExceeded` 同一含义：读预算用尽。 */
export class MobileZipBudgetExceeded extends Error {
  override name = 'ZipBudgetExceeded';
}

interface LimitedRead {
  bytes: Uint8Array;
  exceeded: boolean;
}

/** 读一个条目，最多读 `budget` 字节；超出预算时截断并标记（对应 `Read::take`）。 */
async function readEntryLimited(reader: ZipReader, entry: ZipEntry, budget: number): Promise<LimitedRead> {
  const stream = await reader.openEntry(entry);
  const source = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let exceeded = false;
  try {
    for (;;) {
      const next = await source.read();
      if (next.done) break;
      const value = next.value;
      if (total + value.length > budget) {
        chunks.push(value.subarray(0, Math.max(0, budget - total)));
        total = budget;
        exceeded = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await source.cancel().catch(() => undefined);
    source.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return { bytes: out, exceeded };
}

async function openArchive(zipBytes: Uint8Array): Promise<ZipReader> {
  try {
    return await ZipReader.open(memoryZipSource(zipBytes));
  } catch (error) {
    throw new Error(`Invalid zip: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Port of `scan_skill_zip_bytes_with_limits` over the portable ZIP core. */
export async function scanSkillZipBytesWithLimits(zipBytes: Uint8Array, limits: ZipScanLimits): Promise<ZipScanOutcome> {
  const declaredEntries = zipEntryCountPreflight(zipBytes);
  if (declaredEntries > limits.maxEntries) {
    throw new Error(`Zip contains too many entries (${declaredEntries} > ${limits.maxEntries})`);
  }

  const packageSha256 = sha256HexSync(zipBytes);
  const reader = await openArchive(zipBytes);
  const entries = [...reader.entries];
  if (entries.length > limits.maxEntries) {
    throw new Error(`Zip contains too many entries (${entries.length} > ${limits.maxEntries})`);
  }

  const entryNames: string[] = [];
  for (const entry of entries) {
    const bytes = utf8ByteLength(entry.name);
    if (bytes > limits.maxEntryNameBytes) {
      throw new Error(`Zip entry name is too long (${bytes} bytes > ${limits.maxEntryNameBytes} bytes)`);
    }
    entryNames.push(entry.name);
  }

  const found = zipSkillPrefix(entryNames);
  if (!found) throw new Error('Zip must contain a SKILL.md (at root or in a skill folder)');
  const [prefix, foundSkillId] = found;
  let skillId = foundSkillId;
  if (!/^[\p{Alphabetic}\p{N}_-]+$/u.test(skillId)) {
    throw new Error('Skill folder name contains invalid characters');
  }

  const extracted: Array<[string, Uint8Array]> = [];
  let totalBytes = 0;
  const extractedPaths = new Set<string>();
  for (const entry of entries) {
    if (entry.isDirectory || entry.name.endsWith('/')) continue;
    const rawName = entry.name;
    if (!isSafeZipEntry(rawName)) continue;
    if (entry.size > limits.maxFileBytes) {
      throw new Error(`Zip entry too large: ${rawName} (${entry.size} bytes > ${limits.maxFileBytes} bytes)`);
    }
    const norm = rawName.replaceAll('\\', '/');
    let relative: string;
    if (!prefix) relative = norm;
    else if (norm.startsWith(prefix)) relative = norm.slice(prefix.length);
    else continue;
    if (!relative || relative.includes('..')) continue;
    if (relative.toLowerCase() === 'skill.md') relative = 'SKILL.md';
    const lower = relative.toLowerCase();
    if (extractedPaths.has(lower)) throw new Error(`Zip contains duplicate path: ${relative}`);
    extractedPaths.add(lower);

    const remainingTotal = Math.max(0, limits.maxTotalBytes - totalBytes);
    const readBudget = Math.min(limits.maxFileBytes, remainingTotal) + 1;
    let result: LimitedRead;
    try {
      result = await readEntryLimited(reader, entry, readBudget);
    } catch (error) {
      throw new Error(`Zip read error: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (result.exceeded) {
      if (remainingTotal < limits.maxFileBytes) {
        throw new Error(`Zip actual uncompressed size exceeds limit (${limits.maxTotalBytes} bytes)`);
      }
      throw new Error(
        `Zip entry decompressed size exceeds per-file limit: ${rawName} (${limits.maxFileBytes + 1} bytes > ${limits.maxFileBytes} bytes)`);
    }
    const actualBytes = result.bytes.length;
    if (actualBytes > limits.maxFileBytes) {
      throw new Error(`Zip entry decompressed size exceeds per-file limit: ${rawName} (${actualBytes} bytes > ${limits.maxFileBytes} bytes)`);
    }
    if (actualBytes > remainingTotal) {
      throw new Error(`Zip actual uncompressed size exceeds limit (${limits.maxTotalBytes} bytes)`);
    }
    totalBytes += actualBytes;
    extracted.push([relative, result.bytes]);
  }

  if (!extracted.length) throw new Error('No extractable files found in zip');
  if (!prefix) {
    const frontmatterSkillId = rootSkillIdFromFrontmatter(extracted.map(([relative, bytes]) => ({ relative, bytes })));
    if (frontmatterSkillId !== null) skillId = frontmatterSkillId;
  }

  const [riskLevel, riskSignals] = assessSkillPackageRisk(extracted.map(([relative, bytes]) => ({ relative, bytes })));
  return { skillId, files: extracted, packageSha256, riskLevel, riskSignals };
}

export async function scanSkillZipBytes(zipBytes: Uint8Array): Promise<ZipScanOutcome> {
  return scanSkillZipBytesWithLimits(zipBytes, DEFAULT_ZIP_SCAN_LIMITS);
}

/** 读取仓库 zip 的条目列表（tap catalog 用；只解析中央目录）。 */
export async function listZipEntries(zipBytes: Uint8Array): Promise<ZipEntry[]> {
  return [...(await openArchive(zipBytes)).entries];
}

export async function readZipEntryBytes(
  zipBytes: Uint8Array, entry: ZipEntry, maxBytes = MAX_SKILL_PACKAGE_ZIP_BYTES,
): Promise<Uint8Array> {
  const reader = await openArchive(zipBytes);
  const target = reader.entries.find(candidate => candidate.index === entry.index);
  if (target === undefined) throw new Error('Zip entry not found');
  const result = await readEntryLimited(reader, target, Math.max(1, maxBytes));
  if (result.exceeded) throw new MobileZipBudgetExceeded('zip entry exceeded read budget');
  return result.bytes;
}

/** 确定性 deflate zip（tap 重打包 / 导出）：条目按 UTF-8 字节序排序。 */
export async function buildZipBytes(files: readonly SkillFileBytes[]): Promise<Uint8Array> {
  const sorted = [...files].sort((a, b) => a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0);
  const sink = new MemoryZipSink();
  const writer = new ZipWriter(sink);
  for (const file of sorted) await writer.addBytes(file.relative, file.bytes);
  await writer.finish();
  return sink.bytes();
}
