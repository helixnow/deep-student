/** builtin_resource_executor.rs:138-378,1371-1423. */
import { rustTrim } from '../../../../platform/util/portable.ts';
import { fitPagedReadToDefaultBudget } from './utf8-paging.ts';

export type ReadResourceType = 'notes' | 'files' | 'exams' | 'essays' | 'translations' | 'mindmaps';
export function inferTypeFromId(id: string): ReadResourceType | null {
  if (id.startsWith('note_')) return 'notes';
  if (['file_', 'tb_', 'att_'].some(prefix => id.startsWith(prefix))) return 'files';
  if (id.startsWith('exam_')) return 'exams';
  if (['essay_session_', 'essay_', 'es_'].some(prefix => id.startsWith(prefix))) return 'essays';
  if (id.startsWith('tr_')) return 'translations';
  if (id.startsWith('mm_')) return 'mindmaps';
  return null;
}
export function isSupportedReadId(id: string): boolean {
  return id !== '' && /^[A-Za-z0-9_-]+$/.test(id) && (inferTypeFromId(id) !== null || id.startsWith('res_'));
}
export function sanitizeReadResourceId(raw: string): string {
  const trimmed = rustTrim(raw).replace(/^["'`]+|["'`]+$/g, '');
  if (isSupportedReadId(trimmed)) return trimmed;
  for (const token of trimmed.split(/\p{White_Space}+/u)) {
    const candidate = token.replace(/^[^A-Za-z0-9_-]+|[^A-Za-z0-9_-]+$/g, '');
    if (isSupportedReadId(candidate)) return candidate;
  }
  for (const token of trimmed.replace(/[^A-Za-z0-9_-]/g, ' ').split(/ +/)) if (isSupportedReadId(token)) return token;
  for (const prefix of ['note_', 'tb_', 'file_', 'att_', 'exam_', 'essay_session_', 'essay_', 'es_', 'tr_', 'mm_', 'res_']) {
    const start = trimmed.indexOf(prefix);
    if (start >= 0) {
      const suffix = /^[A-Za-z0-9_-]*/.exec(trimmed.slice(start))![0];
      if (isSupportedReadId(suffix)) return suffix;
    }
  }
  return trimmed;
}
export function pickResourceReadId(args: unknown): [string, string] | null {
  const object = args !== null && typeof args === 'object' ? args as Record<string, unknown> : {};
  for (const key of ['resource_id', 'readResourceId', 'read_resource_id', 'sourceId', 'source_id', 'resourceId']) {
    if (typeof object[key] !== 'string') continue;
    const value = sanitizeReadResourceId(object[key]);
    if (rustTrim(value) !== '') return [value, key];
  }
  return null;
}
export interface ReadAvailability {
  hasExtractedText: boolean; hasOcrPages: boolean; hasPreviewImages: boolean;
  hasImageOcr: boolean; hasStructuredContent: boolean;
}
export function collectReadAvailability(type: string, content: string, metadata: Record<string, unknown> | null): ReadAvailability {
  return {
    hasExtractedText: metadata?.hasExtractedText === true || type === 'files' && content.includes('--- 第 '),
    hasOcrPages: metadata?.hasOcrPages === true || type === 'files' && content.includes('--- 第 '),
    hasPreviewImages: metadata?.hasPreviewImages === true || Array.isArray(metadata?.previewImages) && metadata.previewImages.length > 0,
    hasImageOcr: metadata?.hasImageOcr === true || type === 'images' && content.includes('<image_ocr'),
    hasStructuredContent: metadata?.hasStructuredContent === true || type === 'exams' && content.includes('<question') || type === 'mindmaps' && content.includes('"root"'),
  };
}
export function buildDegradationInfo(type: string, content: string, availability: ReadAvailability, metadataError: string | null) {
  const reasonCodes: string[] = [];
  let level = 'none';
  if (rustTrim(content) === '') { level = 'fallback'; reasonCodes.push('empty_content'); }
  if (content.startsWith('[文档:')) { level = 'fallback'; reasonCodes.push('filename_placeholder'); }
  const missing = (when: boolean, reason: string) => { if (when) { reasonCodes.push(reason); if (level === 'none') level = 'partial'; } };
  missing(type === 'files' && !availability.hasOcrPages, 'missing_ocr_pages');
  missing(type === 'files' && !availability.hasExtractedText, 'missing_extracted_text');
  missing(type === 'exams' && !availability.hasStructuredContent, 'missing_structured_exam_content');
  missing(type === 'images' && !availability.hasImageOcr, 'missing_image_ocr');
  missing(metadataError !== null, 'metadata_error');
  const message = level === 'none' ? '内容完整可用。' : level === 'partial' ? '已返回部分能力（部分字段缺失或降级）。' : '已触发兜底退化，返回了可用的最小内容。';
  return { level, reasonCodes, message };
}
export function fitResourceReadResult(result: Record<string, unknown>, offset: number, totalBytes: number): void {
  const fits = () => fitPagedReadToDefaultBudget(result, 'content', offset, totalBytes);
  if (fits()) return;
  if (result.metadata !== null && typeof result.metadata === 'object' && !Array.isArray(result.metadata)) {
    const metadata = result.metadata as Record<string, unknown>;
    if (Object.hasOwn(metadata, 'previewImages')) {
      const images = metadata.previewImages; delete metadata.previewImages;
      metadata.previewImagesOmitted = true; metadata.previewImageCount = Array.isArray(images) ? images.length : 0;
    }
  }
  if (fits()) return;
  const count = Array.isArray(result.previewImages) ? result.previewImages.length : 0;
  while (Array.isArray(result.previewImages) && result.previewImages.length > 0) {
    result.previewImages.length = Math.floor(result.previewImages.length / 2);
    result.previewImagesTruncated = true; result.previewImageCount = count;
    if (fits()) return;
  }
  if (Object.hasOwn(result, 'metadata')) { delete result.metadata; result.metadataOmitted = true; }
  if (!fits()) throw new Error('resource_read metadata exceeds the tool result budget');
}
