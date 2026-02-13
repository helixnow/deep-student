/**
 * Base64 文件转换工具
 *
 * 提供统一的 base64 字符串到 File/Blob 的转换功能，
 * 包括错误处理和性能优化。
 */

/**
 * 转换结果
 */
export interface Base64ToFileResult {
  success: boolean;
  file?: File;
  error?: string;
}

const BYTE_CHUNK_SIZE = 0x8000;

/**
 * 清理 base64 字符串
 * 移除可能的 data URL 前缀和空白字符
 */
export function cleanBase64String(base64: string): string {
  // 移除 data URL 前缀（如 "data:application/pdf;base64,"）
  const dataUrlMatch = base64.match(/^data:[^;]+;base64,(.+)$/s);
  let cleaned = dataUrlMatch ? dataUrlMatch[1] : base64;

  // Fast path: if no whitespace, skip regex (most base64 strings are clean)
  if (!cleaned.includes('\n') && !cleaned.includes('\r') && !cleaned.includes(' ')) {
    return cleaned;
  }

  // 移除所有空白字符（换行符、空格、制表符等）
  cleaned = cleaned.replace(/\s/g, '');

  return cleaned;
}

/**
 * 将 base64 字符串转换为 Uint8Array
 */
export function base64ToUint8Array(base64: string): Uint8Array | null {
  try {
    const cleanedBase64 = cleanBase64String(base64);
    if (!cleanedBase64) return null;

    const binaryString = atob(cleanedBase64);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (err: unknown) {
    console.error('[base64ToUint8Array] Conversion failed:', err);
    return null;
  }
}

/**
 * 将 Uint8Array 转换为 base64 字符串（分块，避免大数组展开导致栈溢出）
 */
export function uint8ArrayToBase64(bytes: Uint8Array): string {
  if (!bytes.length) return '';

  let binary = '';
  for (let i = 0; i < bytes.length; i += BYTE_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BYTE_CHUNK_SIZE);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

/**
 * 将 base64 字符串转换为 File 对象
 *
 * @param base64 - base64 编码的字符串（可能包含 data URL 前缀）
 * @param fileName - 文件名
 * @param mimeType - MIME 类型
 * @returns 转换结果，包含 File 对象或错误信息
 */
export function base64ToFile(
  base64: string,
  fileName: string,
  mimeType: string
): Base64ToFileResult {
  try {
    const bytes = base64ToUint8Array(base64);

    // 检查是否为空或解码失败
    if (!bytes || bytes.length === 0) {
      return {
        success: false,
        error: 'Base64 内容为空或无效',
      };
    }

    // 创建 Blob 和 File 对象
    const blob = new Blob([bytes], { type: mimeType });
    const file = new File([blob], fileName, { type: mimeType });

    return {
      success: true,
      file,
    };
  } catch (err: unknown) {
    console.error('[base64ToFile] Conversion failed:', err);
    return {
      success: false,
      error: err instanceof Error ? err.message : '文件转换失败',
    };
  }
}

/**
 * 将 base64 字符串转换为 Blob 对象
 *
 * @param base64 - base64 编码的字符串
 * @param mimeType - MIME 类型
 * @returns Blob 对象或 null
 */
export function base64ToBlob(base64: string, mimeType: string): Blob | null {
  const bytes = base64ToUint8Array(base64);
  if (!bytes) return null;
  return new Blob([bytes], { type: mimeType });
}

/**
 * 解码 base64 为 UTF-8 文本
 */
export function decodeBase64ToText(base64: string): string | null {
  const bytes = base64ToUint8Array(base64);
  if (!bytes) return null;

  try {
    return new TextDecoder('utf-8').decode(bytes);
  } catch (err: unknown) {
    console.error('[decodeBase64ToText] Decode failed:', err);
    return null;
  }
}

/**
 * 检查 base64 字符串的大致大小（字节）
 * 用于判断是否为大文件
 */
export function estimateBase64Size(base64: string): number {
  const cleanedBase64 = cleanBase64String(base64);
  // Base64 编码后的大小约为原始大小的 4/3
  return Math.floor(cleanedBase64.length * 0.75);
}

/**
 * 大文件阈值（100MB）
 */
export const LARGE_FILE_THRESHOLD = 100 * 1024 * 1024;

/**
 * 判断是否为大文件
 */
export function isLargeBase64(base64: string): boolean {
  return estimateBase64Size(base64) > LARGE_FILE_THRESHOLD;
}
