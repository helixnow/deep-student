/**
 * 平台通用工具中依赖 Node 的导出（仅桌面）：返回 `Buffer` 的 `decodeBase64Standard`、ZIP（`node:zlib`）、
 * QR PNG（`node:zlib`），以及 win32 退避的 rename 与目录 fsync（`node:fs`）。其余工具从 `portable.ts`
 * （或与它相同的 `index.ts` / `api.ts`）导入。
 */
export { decodeBase64Standard, type Base64DecodeResult } from './base64.ts';
export {
  fsyncDirectory,
  fsyncDirectorySync,
  renameWithRetry,
  renameWithRetrySync,
  type PlatformOption,
} from './durable-fs.ts';

export {
  ZipArchive,
  ZipError,
  ZipWriter,
  readZip,
  writeZip,
  zipEnclosedName,
  type ZipCompression,
  type ZipEntryInfo,
  type ZipFileOptions,
  type ZipIndexEntry,
  type ZipInputEntry,
  type ZipReadOptions,
} from './zip.ts';
export { encodeQrMatrix, qrcodePngBase64, type QrMatrix } from './qr.ts';
