import { isAndroid } from './platform';

/**
 * 组装 `<input type="file" accept>`，规避 wry Android 文件选择器的两个坑
 * （wry RustWebChromeClient.showFilePicker / getValidTypes）：
 *
 * 1. 首项以 "." 开头时，intent.type 会被替换成 `validTypes[0]`；validTypes 只收
 *    MimeTypeMap 认识的扩展名——`accept=".md"` 在不认识 md 的系统上得到空数组，
 *    直接 IndexOutOfBounds 崩溃。
 * 2. 不认识的扩展名被静默丢弃，EXTRA_MIME_TYPES 只剩已知 MIME，文件会被置灰。
 *
 * 因此：MIME 类型永远排在扩展名前面（首项非 "."，validTypes 也不会为空）；
 * Android 上可再追加兜底 MIME（如 `application/octet-stream` 或通配类型），
 * 选完后由调用方按扩展名校验。桌面端维持原有的精确过滤。
 */
export function buildFileAccept(
  mimeTypes: readonly string[],
  extensions: readonly string[] = [],
  options: { androidExtraMimeTypes?: readonly string[]; android?: boolean } = {},
): string {
  if (mimeTypes.length === 0) {
    throw new Error('buildFileAccept needs at least one MIME type (wry Android crashes on extension-only accept)');
  }
  const android = options.android ?? isAndroid();
  const parts = [
    ...mimeTypes,
    ...(android ? options.androidExtraMimeTypes ?? [] : []),
    ...extensions.map((ext) => (ext.startsWith('.') ? ext : `.${ext}`)),
  ];
  return Array.from(new Set(parts)).join(',');
}

/** Markdown 文件：部分 Android 版本的 MimeTypeMap 不认识 md，存储提供方会报 octet-stream */
export const MARKDOWN_FILE_ACCEPT_MIME = ['text/markdown', 'text/x-markdown', 'text/plain'] as const;
