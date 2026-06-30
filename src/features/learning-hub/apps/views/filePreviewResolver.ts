import type { ResourceListItem } from '../../types';
import { inferFilePreviewTypeFromName, normalizePreviewType } from '../../types';

export type FilePreviewMode = Extract<
  ResourceListItem['previewType'],
  'pdf' | 'docx' | 'xlsx' | 'pptx' | 'text' | 'audio' | 'video' | 'none'
>;

const FILE_PREVIEW_MODES: Set<FilePreviewMode> = new Set([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
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
  const normalizedPreviewType = asFilePreviewMode(normalizePreviewType(previewType));
  if (normalizedPreviewType && normalizedPreviewType !== 'none') {
    return normalizedPreviewType;
  }

  const normalizedMime = (mimeType || '').toLowerCase();

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
    normalizedMime.includes('rtf')
  ) {
    return 'text';
  }

  return asFilePreviewMode(inferFilePreviewTypeFromName(fileName)) ?? 'none';
}

export function isRichDocumentPreviewMode(mode: FilePreviewMode): mode is 'docx' | 'xlsx' | 'pptx' {
  return mode === 'docx' || mode === 'xlsx' || mode === 'pptx';
}
