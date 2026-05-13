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
  if (normalizedMime.includes('wordprocessingml')) return 'docx';
  if (normalizedMime.includes('spreadsheet') || normalizedMime.includes('excel')) return 'xlsx';
  if (normalizedMime.includes('presentationml') || normalizedMime.includes('powerpoint')) return 'pptx';

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
