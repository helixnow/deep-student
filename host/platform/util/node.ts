/**
 * 桌面工具：返回 `Buffer` 的 `decodeBase64Standard`、同步 ZIP（`node:zlib`）、win32 退避的
 * rename 与目录 fsync（`node:fs`）。QR PNG 为兼容旧调用方也从这里导出，移动端可直接使用 `qr.ts`。
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
