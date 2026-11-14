/**
 * 备份 ZIP 的归档策略（`zip_export.rs` / `backup_common.rs`）：条目上限、便携排除、条目名安全与
 * 中央目录层面的校验。只做判断，不读写文件。
 */
import type { ZipEntry } from '../../../platform/zip/core/index.ts';
import { sep } from '../../../platform/util/path.ts';
import { toRfc3339 } from '../../../platform/time/index.ts';
import type { ArchiveReader } from './zip-io.ts';

export const MAX_ARCHIVE_FILES = 100_000;
export const MAX_ARCHIVE_UNCOMPRESSED_BYTES = 20n * 1024n * 1024n * 1024n;
const MAX_ARCHIVE_COMPRESSION_RATIO = 200;
const CRYPTO_SECRET_ROOTS = new Set(['crypto', '.secure', '.master_key', '.key_seed']);

/** `copy_with_actual_size_budget`：实际字节数超过剩余预算时拒绝，且不提交计数。 */
export function copyWithActualSizeBudget(
  actualBytes: bigint,
  totalWritten: bigint,
  maxTotal: bigint,
): bigint {
  const remaining = maxTotal > totalWritten ? maxTotal - totalWritten : 0n;
  if (actualBytes > remaining) {
    throw new Error(`ZIP 实际解压总量超限: > ${maxTotal} bytes`);
  }
  return totalWritten + actualBytes;
}

/** `backup_common::is_crypto_secret_backup_relative_path`。 */
export function isCryptoSecretRelativePath(relative: string): boolean {
  const first = relative.split('/')[0] ?? '';
  return CRYPTO_SECRET_ROOTS.has(first.toLowerCase());
}

/** `zip_export::is_portable_excluded_relative_path`。 */
export function isPortableExcludedRelativePath(relative: string): boolean {
  if (isCryptoSecretRelativePath(relative)) return true;
  const normalized = relative.replace(/\\/g, '/').toLowerCase();
  if (normalized === 'databases/audit.db') return true;
  return normalized === 'persistent/user_skills' || normalized.startsWith('persistent/user_skills/');
}

export interface ArchiveEntryInfo {
  /** 规范化后的条目名（`\` → `/`，目录不带尾部 `/`）。 */
  name: string;
  isDirectory: boolean;
  size: number;
  compressedSize: number;
  entry: ZipEntry;
}

export function archiveEntries(reader: ArchiveReader): ArchiveEntryInfo[] {
  return reader.entries.map(entry => ({
    name: entry.name.replace(/\\/g, '/').replace(/\/+$/, ''),
    isDirectory: entry.isDirectory,
    size: entry.size,
    compressedSize: entry.compressedSize,
    entry,
  }));
}

export function tooManyEntries(count: number, max: number): Error {
  return new Error(`ZIP 文件数量超限: ${count} > ${max}`);
}

/** zip 0.6.6 `ZipFileData::enclosed_name`（types.rs:383-398）返回 None 的条目名（`\` 已换成 `/`）。 */
function enclosedNameIsNone(name: string): boolean {
  if (name.includes('\0') || name.startsWith('/')) return true;
  // Windows 上 `C:x`、`C:/x` 解析出 Prefix 分量；POSIX 上它们只是普通文件名。
  if (sep === '\\' && /^[A-Za-z]:/.test(name)) return true;
  let depth = 0;
  for (const component of name.split('/')) {
    if (component === '..') {
      if (depth === 0) return true;
      depth -= 1;
    } else if (component !== '' && component !== '.') {
      depth += 1;
    }
  }
  return false;
}

/** 在 Rust `enclosed_name` 之上，本端还拒绝任何 `.`、`..` 与空分量（Rust 解压时同样拒绝，只是更晚）。 */
export function isUnsafeArchivePath(name: string): boolean {
  if (name === '' || enclosedNameIsNone(name)) return true;
  return name.split('/').some(component => component === '..' || component === '.' || component === '');
}

function ratioText(value: number): string {
  return value.toFixed(1);
}

/**
 * `zip_export::validate_import_archive`：路径安全、便携排除、换行、重复，以及中央目录声明的
 * 20 GiB 解压总量、非空条目零压缩、单条目与整体压缩比 ≤ 200。
 */
export function validateImportArchive(entries: readonly ArchiveEntryInfo[]): void {
  if (entries.length > MAX_ARCHIVE_FILES) throw tooManyEntries(entries.length, MAX_ARCHIVE_FILES);
  const paths = new Set<string>();
  let totalUncompressed = 0n;
  let totalCompressed = 0n;
  for (const entry of entries) {
    const name = entry.name;
    if (isUnsafeArchivePath(name)) throw new Error(`ZIP 包含越界或空路径: ${name}`);
    if (isPortableExcludedRelativePath(name)) {
      throw new Error(`未加密 ZIP 禁止包含密钥或本地审计材料: ${name}`);
    }
    if (name.includes('\r') || name.includes('\n')) throw new Error(`ZIP 路径包含换行符: ${JSON.stringify(name)}`);
    if (!paths.add(name)) throw new Error(`ZIP 包含重复路径: ${name}`);
    totalUncompressed += BigInt(entry.size);
    totalCompressed += BigInt(entry.compressedSize);
    if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error(`ZIP 解压总量超限: ${totalUncompressed} > ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} bytes`);
    }
    if (entry.size > 0 && entry.compressedSize === 0) throw new Error(`ZIP 非空条目压缩大小为零: ${name}`);
    if (entry.compressedSize > 0) {
      const ratio = entry.size / entry.compressedSize;
      if (ratio > MAX_ARCHIVE_COMPRESSION_RATIO) {
        throw new Error(`ZIP 压缩比异常: ${ratioText(ratio)} > ${ratioText(MAX_ARCHIVE_COMPRESSION_RATIO)}`);
      }
    }
  }
  if (totalUncompressed > 0n && totalCompressed === 0n) throw new Error('ZIP 总压缩大小异常为零');
  if (totalCompressed > 0n) {
    const ratio = Number(totalUncompressed) / Number(totalCompressed);
    if (ratio > MAX_ARCHIVE_COMPRESSION_RATIO) {
      throw new Error(`ZIP 总压缩比异常: ${ratioText(ratio)} > ${ratioText(MAX_ARCHIVE_COMPRESSION_RATIO)}`);
    }
  }
}

/**
 * `zip_export::validate_secrets_archive`。早期 Electron 版用 JSZip 生成内层归档时
 * 会隐式写入父目录条目（`crypto/`、`crypto/.secure/`）；这些纯父目录条目被跳过以保持可导入，
 * 其余目录条目仍按 Rust 拒绝。
 */
// RUST-FIX(RF-W08-sealed-archive-implicit-parent-dirs): Rust 拒绝任何目录条目，早期 Electron 版的加密备份因此无法导入。
export function validateSecretsArchive(entries: readonly ArchiveEntryInfo[]): ArchiveEntryInfo[] {
  if (entries.length > MAX_ARCHIVE_FILES) throw tooManyEntries(entries.length, MAX_ARCHIVE_FILES);
  const fileNames = entries.filter(entry => !entry.isDirectory).map(entry => entry.name);
  const isImplicitParent = (name: string): boolean => fileNames.some(file => file.startsWith(`${name}/`));
  const paths = new Set<string>();
  const files: ArchiveEntryInfo[] = [];
  let hasManifest = false;
  let totalUncompressed = 0n;
  for (const entry of entries) {
    const name = entry.name;
    if (name === '' || enclosedNameIsNone(name) || name.includes('../')) {
      throw new Error(`密封载荷包含越界或空路径: ${name}`);
    }
    if (name.includes('\r') || name.includes('\n')) throw new Error(`密封载荷路径包含换行符: ${JSON.stringify(name)}`);
    if (!paths.add(name)) throw new Error(`密封载荷包含重复路径: ${name}`);
    if (entry.isDirectory) {
      if (isPortableExcludedRelativePath(name) && isImplicitParent(name)) continue;
      throw new Error(`密封载荷不允许包含目录条目: ${name}`);
    }
    if (name === 'manifest.json') hasManifest = true;
    else if (!isPortableExcludedRelativePath(name)) {
      throw new Error(`密封载荷只允许包含敏感数据与原始清单，发现越权条目: ${name}`);
    }
    totalUncompressed += BigInt(entry.size);
    if (totalUncompressed > MAX_ARCHIVE_UNCOMPRESSED_BYTES) {
      throw new Error(`ZIP 解压总量超限: ${totalUncompressed} > ${MAX_ARCHIVE_UNCOMPRESSED_BYTES} bytes`);
    }
    if (entry.compressedSize > 0) {
      const ratio = entry.size / entry.compressedSize;
      if (ratio > MAX_ARCHIVE_COMPRESSION_RATIO) {
        throw new Error(`密封载荷压缩比异常: ${ratioText(ratio)} > ${ratioText(MAX_ARCHIVE_COMPRESSION_RATIO)}`);
      }
    }
    files.push(entry);
  }
  if (!hasManifest) throw new Error('密封载荷缺少原始 manifest.json，无法解封为完整备份');
  return files;
}

export function archivePolicyLimits(): { maxFiles: number; maxUncompressedBytes: bigint; maxCompressionRatio: number } {
  return {
    maxFiles: MAX_ARCHIVE_FILES,
    maxUncompressedBytes: MAX_ARCHIVE_UNCOMPRESSED_BYTES,
    maxCompressionRatio: MAX_ARCHIVE_COMPRESSION_RATIO,
  };
}

export function portableExclusionSummary(): string {
  return `导出时间 ${toRfc3339()}；便携排除根: ${[...CRYPTO_SECRET_ROOTS].join(', ')}, databases/audit.db, persistent/user_skills`;
}
