/**
 * archiveManifest — 压缩包清单文本的识别与展示
 *
 * zip 导入时后端（attachment_repo::build_zip_manifest_text）把条目清单写入
 * extracted_text，首行为语言中立的机器标记 `[#archive-manifest]`。
 * 前端据标记识别，不依赖任何自然语言前缀；历史数据带 `[压缩包清单]`
 * 中文前缀，仅作只读兼容识别（新数据不再产生）。
 */

/** 与 Rust `attachment_repo::ARCHIVE_MANIFEST_MARKER` 严格对齐 */
export const ARCHIVE_MANIFEST_MARKER = '[#archive-manifest]';

/** 2026-08 之前导入的 zip 清单首行前缀（仅兼容识别，勿用于新数据） */
const LEGACY_ARCHIVE_MANIFEST_PREFIX = '[压缩包清单]';

function hasArchiveManifestMarkerLine(text: string): boolean {
  return (
    text === ARCHIVE_MANIFEST_MARKER
    || text.startsWith(`${ARCHIVE_MANIFEST_MARKER}\n`)
    || text.startsWith(`${ARCHIVE_MANIFEST_MARKER}\r\n`)
  );
}

/** 文本是否为压缩包条目清单（区别于 "[文档: xxx]" 等注入占位文本） */
export function isArchiveManifestText(text: string): boolean {
  return (
    hasArchiveManifestMarkerLine(text)
    || text.startsWith(LEGACY_ARCHIVE_MANIFEST_PREFIX)
  );
}

/** 剥除首行机器标记后的展示文本；legacy 文本（无标记行）原样返回 */
export function archiveManifestDisplayText(text: string): string {
  if (!hasArchiveManifestMarkerLine(text)) return text;
  if (text === ARCHIVE_MANIFEST_MARKER) return '';
  const suffix = text.slice(ARCHIVE_MANIFEST_MARKER.length);
  return suffix.startsWith('\r\n') ? suffix.slice(2) : suffix.slice(1);
}

const MAX_CLIENT_ZIP_ENTRIES = 500;

function formatEntryBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * 前端只读 ZIP 清单兜底：当后端未在导入期预写条目清单时，
 * 利用已内置的 JSZip 读取中央目录生成纯文本条目表，供 TextFilePreview 展示。
 */
export async function buildZipManifestFromBytes(
  buffer: ArrayBuffer,
  fileName: string,
): Promise<string | null> {
  const { inspectOfficeZipContainer } = await import('./officeZipContainer');
  const { issue, normalizedBuffer } = inspectOfficeZipContainer(buffer);
  if (issue) return null;

  const { default: JSZip } = await import('jszip');
  const zip = await JSZip.loadAsync(normalizedBuffer, { createFolders: false });
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && !entry.name.startsWith('__MACOSX/'))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (entries.length === 0) return null;

  const shown = entries.slice(0, MAX_CLIENT_ZIP_ENTRIES);
  let totalUncompressed = 0;
  const lines: string[] = [];

  for (const entry of entries) {
    const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
    if (typeof data?.uncompressedSize === 'number' && data.uncompressedSize >= 0) {
      totalUncompressed += data.uncompressedSize;
    }
  }

  lines.push(`${fileName} (${entries.length} files · ${formatEntryBytes(totalUncompressed)})`);
  lines.push('─'.repeat(32));

  for (const entry of shown) {
    const data = (entry as unknown as { _data?: { uncompressedSize?: number } })._data;
    const sizeLabel =
      typeof data?.uncompressedSize === 'number' && data.uncompressedSize >= 0
        ? `  (${formatEntryBytes(data.uncompressedSize)})`
        : '';
    lines.push(`${entry.name}${sizeLabel}`);
  }

  if (entries.length > MAX_CLIENT_ZIP_ENTRIES) {
    lines.push(`... (+${entries.length - MAX_CLIENT_ZIP_ENTRIES} more)`);
  }

  return lines.join('\n');
}
