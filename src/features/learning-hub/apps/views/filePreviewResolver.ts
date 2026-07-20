import type { ResourceListItem } from '../../types';
import { inferFilePreviewTypeFromName, normalizePreviewType } from '../../types';

export type FilePreviewMode = Extract<
  ResourceListItem['previewType'],
  'pdf' | 'docx' | 'xlsx' | 'pptx' | 'epub' | 'text' | 'audio' | 'video' | 'none'
>;

const FILE_PREVIEW_MODES: Set<FilePreviewMode> = new Set([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'epub',
  'text',
  'audio',
  'video',
  'none',
]);

const asFilePreviewMode = (value?: string): FilePreviewMode | null => {
  if (!value) return null;
  if (!FILE_PREVIEW_MODES.has(value as FilePreviewMode)) {
    return null;
  }
  return value as FilePreviewMode;
};

/**
 * 为 file 资源解析最终预览模式
 * 优先级：显式 previewType > MIME > 扩展名
 */
export function resolveFilePreviewMode(
  mimeType: string,
  fileName: string,
  previewType?: string
): FilePreviewMode {
  const normalizedMime = (mimeType || '').toLowerCase();
  const isEpubFile = fileName.split('.').pop()?.toLowerCase() === 'epub';

  // Older imports labelled EPUB as text. The file signature wins so they are
  // upgraded to the structured reader without a data migration.
  if (isEpubFile || normalizedMime.includes('epub')) return 'epub';

  const normalizedPreviewType = asFilePreviewMode(normalizePreviewType(previewType));
  if (normalizedPreviewType && normalizedPreviewType !== 'none') {
    return normalizedPreviewType;
  }

  if (normalizedMime.startsWith('audio/')) return 'audio';
  if (normalizedMime.startsWith('video/')) return 'video';
  if (normalizedMime.includes('pdf')) return 'pdf';
  // ★ 2026-06-12（审阅问题 R3）：富文档渲染仅匹配 OOXML MIME。
  // 老格式 MIME（application/vnd.ms-excel、application/msword、
  // application/vnd.ms-powerpoint、oasis.opendocument.*）此前被宽泛的
  // 'spreadsheet'/'excel'/'powerpoint' 规则误路由到富渲染组件，必然解析失败。
  // 现统一降级：电子表格老格式 → text（后端可提取文本），其余老格式走扩展名兜底。
  if (normalizedMime.includes('wordprocessingml')) return 'docx';
  if (normalizedMime.includes('spreadsheetml')) return 'xlsx';
  if (normalizedMime.includes('presentationml')) return 'pptx';
  if (
    normalizedMime.includes('ms-excel') ||
    normalizedMime.includes('opendocument.spreadsheet')
  ) {
    return 'text';
  }

  if (
    normalizedMime.startsWith('text/') ||
    normalizedMime.includes('json') ||
    normalizedMime.includes('xml') ||
    normalizedMime.includes('rtf') ||
    // ★ 2026-07-19（预览器改造）：常见代码/配置类 MIME（导入器可能给出
    // application/javascript、application/x-yaml、application/x-sh 等）也走文本预览
    normalizedMime.includes('javascript') ||
    normalizedMime.includes('ecmascript') ||
    normalizedMime.includes('typescript') ||
    normalizedMime.includes('yaml') ||
    normalizedMime.includes('toml') ||
    normalizedMime.includes('x-sh') ||
    normalizedMime.includes('shellscript') ||
    normalizedMime.includes('x-python')
  ) {
    return 'text';
  }

  return asFilePreviewMode(inferFilePreviewTypeFromName(fileName)) ?? 'none';
}

export function isRichDocumentPreviewMode(mode: FilePreviewMode): mode is 'docx' | 'xlsx' | 'pptx' {
  return mode === 'docx' || mode === 'xlsx' || mode === 'pptx';
}
