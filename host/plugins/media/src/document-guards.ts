/**
 * `dstu-docs/src/document_parser.rs` upload gates: document size, PDF / Office encryption markers and
 * ZIP-bomb detection (M-1, M-11), shared by every extraction entry point.
 */
import { decodeUtf8Lossy } from '../../../platform/util/portable.ts';
import { ParsingError } from './document-errors.ts';
import { zipDirectory, zipEntryData, zipEntryNames } from './zip.ts';

export const MAX_DOCUMENT_SIZE = 200 * 1024 * 1024;
export const MAX_SINGLE_ENTRY_SIZE = 100 * 1024 * 1024;
export const MAX_FILES_IN_ARCHIVE = 10_000;
export const MAX_NESTED_ZIP_DEPTH = 3;
export const MAX_DECOMPRESSED_SIZE = 500 * 1024 * 1024;
export const MAX_COMPRESSION_RATIO = 100;

const OFFICE_CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

const ZIP_LIKE_EXTENSIONS: readonly string[] = [
  'zip', 'docx', 'xlsx', 'pptx', 'xlsb',
  'odt', 'odp', 'odg', 'ods', 'epub',
  'jar', 'war', 'ear', 'apk',
  'cbz', 'kmz', 'xpi', 'crx', 'aar', 'appx', 'msix', 'nupkg',
];

/** ★ 嵌套 ZIP 检测：扩展名是否属于 ZIP 容器格式。 */
export function isZipLikeExtension(entryName: string): boolean {
  const lower = entryName.toLowerCase();
  return ZIP_LIKE_EXTENSIONS.some(extension => lower.endsWith(`.${extension}`));
}

/** ★ 嵌套 ZIP 检测：`PK\x03\x04` 或空 ZIP 的 `PK\x05\x06` 魔数。 */
export function isZipMagicBytes(data: Uint8Array): boolean {
  if (data.length < 4) return false;
  return (data[0] === 0x50 && data[1] === 0x4b
    && ((data[2] === 0x03 && data[3] === 0x04) || (data[2] === 0x05 && data[3] === 0x06)));
}

export function checkFileSize(size: number): void {
  if (size > MAX_DOCUMENT_SIZE) {
    throw new ParsingError('FileTooLarge',
      `文件大小 ${Math.trunc(size / (1024 * 1024))}MB 超过限制 ${Math.trunc(MAX_DOCUMENT_SIZE / (1024 * 1024))}MB`);
  }
}

/** ★ M-1：检查 PDF 是否加密：头部 4KB、尾部 4KB、大文件中间 8KB 的 `/Encrypt` 标记。 */
export function checkPdfEncryption(bytes: Uint8Array, fileName: string): void {
  const encrypted = (): never => {
    throw new ParsingError('EncryptedDocument',
      `文件 '${fileName}' 是加密的 PDF 文档，请先解除密码保护后再上传`);
  };
  const header = decodeUtf8Lossy(bytes.subarray(0, Math.min(bytes.length, 4096)));
  if (header.includes('/Encrypt')) encrypted();
  if (bytes.length > 4096) {
    const trailer = decodeUtf8Lossy(bytes.subarray(bytes.length - 4096));
    if (trailer.includes('/Encrypt')) encrypted();
  }
  if (bytes.length > 8192) {
    const midStart = Math.trunc(bytes.length / 2) - 4096;
    const midEnd = Math.min(midStart + 8192, bytes.length);
    const middle = decodeUtf8Lossy(bytes.subarray(midStart, midEnd));
    if (middle.includes('/Encrypt')) encrypted();
  }
}

/** ★ M-1：检测 Office 文档加密：CFB 魔数、EncryptedPackage、缺失 [Content_Types].xml。 */
export function checkOfficeEncryption(bytes: Uint8Array, fileName: string): void {
  const encrypted = (message: string): never => {
    throw new ParsingError('EncryptedDocument', message);
  };
  if (bytes.length >= 8 && OFFICE_CFB_MAGIC.every((byte, i) => bytes[i] === byte)) {
    encrypted(`文件 '${fileName}' 是加密的 Office 文档，请先解除密码保护后再上传`);
  }
  const names = zipEntryNames(bytes);
  if (names === null) return;
  if (names.includes('EncryptedPackage')) {
    encrypted(`文件 '${fileName}' 是加密的 Office 文档，请先解除密码保护后再上传`);
  }
  if (!names.includes('[Content_Types].xml')) {
    const hasOfficeStructure = names.some(name => name.startsWith('word/')
      || name.startsWith('xl/') || name.startsWith('ppt/')
      || name === 'docProps/core.xml' || name === 'docProps/app.xml');
    if (!hasOfficeStructure) {
      encrypted(`文件 '${fileName}' 可能是加密的或已损坏，请检查文件完整性`);
    }
  }
}

/** ★ M-11：检测 ZIP Bomb（文件数量 / 单条目 / 真实解压字节 / 压缩比 / 嵌套）。 */
export function checkZipBomb(bytes: Uint8Array, fileName: string, warn: (message: string) => void): void {
  checkZipBombRecursive(bytes, fileName, 0, warn);
}

function checkZipBombRecursive(bytes: Uint8Array, fileName: string, depth: number, warn: (message: string) => void): void {
  if (depth >= MAX_NESTED_ZIP_DEPTH) {
    throw new ParsingError('ZipBombDetected',
      `文件 '${fileName}' 嵌套深度超过限制 ${MAX_NESTED_ZIP_DEPTH} 层，可能是 ZIP Bomb 攻击`);
  }
  const entries = zipDirectory(bytes);
  if (entries === null) {
    // Rust 只记录诊断，随后交给具体解析器报错。
    warn('ZIP bomb check: failed to open as ZIP: invalid Zip archive');
    return;
  }
  if (entries.length > MAX_FILES_IN_ARCHIVE) {
    throw new ParsingError('ZipBombDetected',
      `文件 '${fileName}' 包含 ${entries.length} 个条目，超过安全限制 ${MAX_FILES_IN_ARCHIVE} 个`);
  }
  let totalUncompressed = 0;
  const compressedSize = bytes.length;
  for (const entry of entries) {
    if (entry.declaredSize > MAX_SINGLE_ENTRY_SIZE) {
      throw new ParsingError('ZipBombDetected',
        `文件 '${fileName}' 中的条目 '${entry.name}' 解压后大小 `
        + `${(entry.declaredSize / (1024 * 1024)).toFixed(1)}MB 超过限制 `
        + `${(MAX_SINGLE_ENTRY_SIZE / (1024 * 1024)).toFixed(1)}MB`);
    }
    if (entry.compressedSize > 0) {
      const ratio = entry.declaredSize / entry.compressedSize;
      if (ratio > MAX_COMPRESSION_RATIO) {
        throw new ParsingError('ZipBombDetected',
          `文件 '${fileName}' 中的条目 '${entry.name}' 压缩比 ${ratio.toFixed(1)}:1 `
          + `超过安全阈值 ${MAX_COMPRESSION_RATIO.toFixed(0)}:1`);
      }
    }
    let entryBytes: Uint8Array | null;
    try {
      entryBytes = zipEntryData(bytes, entry, MAX_SINGLE_ENTRY_SIZE + 1);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ParsingError('ZipBombDetected',
          `文件 '${fileName}' 中的条目 '${entry.name}' 实际解压大小超过限制 `
          + `${(MAX_SINGLE_ENTRY_SIZE / (1024 * 1024)).toFixed(1)}MB`
          + `（声明大小 ${(entry.declaredSize / (1024 * 1024)).toFixed(1)}MB，声明值被伪造）`);
      }
      // 个别条目解压失败交给后续具体解析器处理
      continue;
    }
    if (entryBytes === null) continue;
    const actualSize = entryBytes.length;
    if (actualSize > MAX_SINGLE_ENTRY_SIZE) {
      throw new ParsingError('ZipBombDetected',
        `文件 '${fileName}' 中的条目 '${entry.name}' 实际解压大小超过限制 `
        + `${(MAX_SINGLE_ENTRY_SIZE / (1024 * 1024)).toFixed(1)}MB`
        + `（声明大小 ${(entry.declaredSize / (1024 * 1024)).toFixed(1)}MB，声明值被伪造）`);
    }
    if (actualSize > entry.declaredSize + 1024 * 1024) {
      throw new ParsingError('ZipBombDetected',
        `文件 '${fileName}' 中的条目 '${entry.name}' 真实解压大小 `
        + `${(actualSize / (1024 * 1024)).toFixed(1)}MB 远超声明值 `
        + `${(entry.declaredSize / (1024 * 1024)).toFixed(1)}MB，疑似 ZIP Bomb`);
    }
    if (entry.compressedSize > 0) {
      const ratio = actualSize / entry.compressedSize;
      if (ratio > MAX_COMPRESSION_RATIO) {
        throw new ParsingError('ZipBombDetected',
          `文件 '${fileName}' 中的条目 '${entry.name}' 真实压缩比 ${ratio.toFixed(1)}:1 `
          + `超过安全阈值 ${MAX_COMPRESSION_RATIO.toFixed(0)}:1`);
      }
    }
    totalUncompressed += actualSize;
    if (totalUncompressed > MAX_DECOMPRESSED_SIZE) {
      throw new ParsingError('ZipBombDetected',
        `文件 '${fileName}' 解压后总大小超过限制 `
        + `${(MAX_DECOMPRESSED_SIZE / (1024 * 1024)).toFixed(0)}MB`
        + `（已累计 ${(totalUncompressed / (1024 * 1024)).toFixed(1)}MB）`);
    }
    if (entryBytes.length > 0
      && (isZipLikeExtension(entry.name) || isZipMagicBytes(entryBytes.subarray(0, 4)))) {
      checkZipBombRecursive(entryBytes, `${fileName} -> ${entry.name}`, depth + 1, warn);
    }
  }
  if (compressedSize > 0) {
    const overallRatio = totalUncompressed / compressedSize;
    if (overallRatio > MAX_COMPRESSION_RATIO) {
      throw new ParsingError('ZipBombDetected',
        `文件 '${fileName}' 整体压缩比 ${overallRatio.toFixed(1)}:1 `
        + `超过安全阈值 ${MAX_COMPRESSION_RATIO.toFixed(0)}:1`);
    }
  }
}
