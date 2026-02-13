/**
 * DSTU 文件编码工具
 *
 * 提供文件与 base64 字符串之间的转换功能，
 * 用于在前端和后端之间传输二进制文件。
 */

/**
 * 将 File/Blob 转换为 base64 字符串
 *
 * @param file 要转换的文件或 Blob 对象
 * @returns base64 编码的字符串（不包含 data URL 前缀）
 *
 * @example
 * ```typescript
 * const file = new File(['hello'], 'test.txt');
 * const base64 = await fileToBase64(file);
 * console.log(base64); // "aGVsbG8="
 * ```
 */
export async function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // 移除 data URL 前缀，只保留 base64 部分
      const base64 = result.split(',')[1] || result;
      resolve(base64);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/**
 * 将 base64 字符串转换为 Blob
 *
 * @param base64 base64 编码的字符串
 * @param mimeType MIME 类型（默认为 'application/octet-stream'）
 * @returns Blob 对象
 *
 * @example
 * ```typescript
 * const blob = base64ToBlob('aGVsbG8=', 'text/plain');
 * console.log(blob.size); // 5
 * console.log(blob.type); // "text/plain"
 * ```
 */
export function base64ToBlob(base64: string, mimeType = 'application/octet-stream'): Blob {
  const byteCharacters = atob(base64);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}
