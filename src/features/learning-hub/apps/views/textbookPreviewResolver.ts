import type { ResourceListItem } from '../../types';
import { inferFilePreviewTypeFromName, normalizePreviewType } from '../../types';

const SUPPORTED_TEXTBOOK_PREVIEW_TYPES = new Set<ResourceListItem['previewType']>([
  'pdf',
  'docx',
  'xlsx',
  'pptx',
  'text',
  'none',
]);

/**
 * 教材视图的预览类型解析（兼容旧 previewType + 文件名兜底）
 */
export function resolveTextbookPreviewType(
  previewType: string | undefined,
  fileName: string
): ResourceListItem['previewType'] {
  const normalized = normalizePreviewType(previewType);
  if (normalized && normalized !== 'none' && SUPPORTED_TEXTBOOK_PREVIEW_TYPES.has(normalized)) {
    return normalized;
  }

  const inferred = inferFilePreviewTypeFromName(fileName);
  return SUPPORTED_TEXTBOOK_PREVIEW_TYPES.has(inferred) ? inferred : 'none';
}
