import { decodeUtf8Lossy } from '../../../platform/util/portable.ts';
import { ParsingError } from './document-errors.ts';

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
