/** builtin_resource_executor.rs:380-545,1104-1673 and content_helpers.rs:413-519. */
import type { Context } from '@deepseek-ai/cordis';
import { charCount, rustTrim, utf8ByteLength } from '../../../../platform/util/portable.ts';
import { sha256HexSync } from '../../../../platform/crypto/sync.ts';
import { checkExpectedHash, optionalExpectedHash, pageUtf8Text, parseMaxBytes, parseOffset } from './utf8-paging.ts';
import { getContentByType } from '../dstu-content.ts';
import { parseOcrPages } from '../ocr.ts';
import { joinOcrPagesText } from '../../repository/resources.ts';
import { ocrJsonForResource, sourceIdForResource } from '../../repository/resource-tools.ts';
import { readTranscriptRange, formatMediaTimestamp, mediaCitation, type TranscriptRead } from '../media-index.ts';
import { buildDegradationInfo, collectReadAvailability, fitResourceReadResult, inferTypeFromId, pickResourceReadId,
  sanitizeReadResourceId, type ReadResourceType } from './resource-read-helpers.ts';
import { toolNotes, toolVfsDatabase, toolVfsRepos } from './tool-services.ts';

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown): string | null => typeof value === 'string' ? value : null;
const uint = (value: unknown): number | null => typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 2 ** 64 ? value : null;
const detail = (error: unknown): string => error instanceof Error ? error.message : String(error);
export interface ResolvedReadTarget { requestedId: string; readId: string; resourceType: ReadResourceType; resolvedBy: string }
export function resolveReadTarget(ctx: Context, raw: string): ResolvedReadTarget {
  const requestedId = sanitizeReadResourceId(raw), direct = inferTypeFromId(requestedId);
  if (direct !== null) return { requestedId, readId: requestedId, resourceType: direct, resolvedBy: 'direct' };
  if (!requestedId.startsWith('res_')) throw new Error(`Cannot infer resource type from ID: ${requestedId}. 请传入 note_/tb_/file_/exam_/essay_/tr_/mm_ 或 res_ 开头的资源 ID。`);
  let resource;
  try { resource = toolVfsRepos(ctx).resources.getResource(toolVfsDatabase(ctx).getConnSafe(), requestedId); }
  catch (error) { throw new Error(`Failed to resolve resource '${requestedId}': ${detail(error)}`); }
  if (resource === null) throw new Error(`Resource '${requestedId}' not found. 请先调用 unified_search/resource_list 获取最新 ID。`);
  if (resource.sourceId !== undefined) {
    const type = inferTypeFromId(resource.sourceId);
    if (type !== null) return { requestedId, readId: resource.sourceId, resourceType: type, resolvedBy: 'resource.source_id' };
  }
  const type = ({ note: 'notes', textbook: 'files', image: 'files', file: 'files', exam: 'exams', essay: 'essays',
    translation: 'translations', mindmap: 'mindmaps' } as Record<string, ReadResourceType>)[resource.type];
  if (type === undefined) throw new Error(`Resource '${resource.id}' type '${resource.type === 'insightcard' ? 'insight_card' : resource.type}' does not support builtin-resource_read.`);
  let source: string | null;
  try { source = sourceIdForResource(toolVfsDatabase(ctx).getConnSafe(), type, resource.id); }
  catch { source = null; }
  if (source !== null) {
    const inferred = inferTypeFromId(source);
    if (inferred !== null) return { requestedId, readId: source, resourceType: inferred, resolvedBy: 'resource_id_lookup' };
  }
  throw new Error(`Resource '${resource.id}' exists, but cannot map it to a readable source ID. 请尝试 resource_list/resource_search 重新定位具体资源。`);
}
function previewImages(ctx: Context, preview: unknown): Record<string, unknown>[] {
  const pages = object(preview).pages;
  if (!Array.isArray(pages)) return [];
  return pages.flatMap((value, index) => {
    const page = object(value), pageIndex = uint(page.pageIndex) ?? uint(page.page_index) ?? index;
    const blobHash = str(page.compressedBlobHash) ?? str(page.compressed_blob_hash) ?? str(page.blobHash) ?? str(page.blob_hash);
    if (blobHash === null) return [];
    let imagePath: string | null;
    try { imagePath = toolVfsRepos(ctx).blobs.getBlobPath(toolVfsDatabase(ctx).getConnSafe(), toolVfsDatabase(ctx).blobsDir(), blobHash); }
    catch { imagePath = null; }
    return [{ pageIndex, blobHash, imagePath }];
  });
}
function previewImagesFromString(ctx: Context, raw: string | undefined): Record<string, unknown>[] {
  if (raw === undefined || rustTrim(raw) === '') return [];
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return []; }
  return previewImages(ctx, value);
}
export function resourceReadMetadata(ctx: Context, type: string, id: string): Record<string, unknown> | null {
  const lookup = <T>(label: string, read: () => T | null, convert: (value: T) => Record<string, unknown>): Record<string, unknown> | null => {
    try {
      const value = read();
      if (value !== null) return convert(value);
      ctx.logger.debug(`[BuiltinResource] get metadata: ${label} not found for %s`, id); return null;
    } catch (error) {
      const message = `${label} query error: ${detail(error)}`;
      ctx.logger.warn('[BuiltinResource] get metadata failed for %s: %s', id, message); throw new Error(message);
    }
  };
  const db = () => toolVfsDatabase(ctx).getConnSafe(), repos = toolVfsRepos(ctx);
  if (type === 'notes') return lookup('note', () => toolNotes(ctx).repository.getNote(id, db()), note => ({ title: note.title, tags: note.tags, createdAt: note.createdAt, updatedAt: note.updatedAt ?? null }));
  if (type === 'textbooks' || type === 'files' && id.startsWith('tb_')) return lookup('textbook', () => repos.textbooks.getTextbook(db(), id), book => ({
    title: book.fileName, pageCount: book.pageCount ?? null, lastPage: book.lastPage ?? null, createdAt: book.createdAt, updatedAt: book.updatedAt ?? null }));
  if (type === 'exams') return lookup('exam', () => repos.exams.getExamSheet(db(), id), exam => {
    const images = previewImages(ctx, exam.previewJson);
    return { title: exam.examName ?? null, status: exam.status, createdAt: exam.createdAt, updatedAt: exam.updatedAt ?? null, hasPreviewImages: images.length > 0, previewImages: images };
  });
  if (type === 'essays') return lookup('essay session', () => repos.essays.getSession(db(), id), session => ({
    title: session.title, essayType: session.essay_type ?? null, totalRounds: session.total_rounds, createdAt: session.created_at, updatedAt: session.updated_at ?? null }));
  if (type === 'translations') return lookup('translation', () => repos.translations.getTranslation(db(), id), translation => ({
    title: translation.title ?? null, srcLang: translation.srcLang, tgtLang: translation.tgtLang, createdAt: translation.createdAt, updatedAt: translation.updatedAt ?? null }));
  if (type === 'files') return lookup('file', () => repos.files.getFile(db(), id), file => {
    const images = previewImagesFromString(ctx, file.previewJson);
    return { fileName: file.fileName, fileType: file.fileType, mimeType: file.mimeType ?? null, size: file.size,
      pageCount: file.pageCount ?? null, createdAt: file.createdAt, updatedAt: file.updatedAt ?? null,
      hasExtractedText: file.extractedText !== undefined && rustTrim(file.extractedText) !== '',
      hasOcrPages: file.ocrPagesJson !== undefined && rustTrim(file.ocrPagesJson) !== '', hasPreviewImages: images.length > 0, previewImages: images };
  });
  if (type === 'mindmaps') return lookup('mindmap', () => repos.mindmaps.getMindmapWithConn(db(), id), mindmap => ({
    title: mindmap.title, description: mindmap.description ?? null, defaultView: mindmap.defaultView, theme: mindmap.theme ?? null,
    isFavorite: mindmap.isFavorite, createdAt: mindmap.createdAt, updatedAt: mindmap.updatedAt }));
  ctx.logger.warn("[BuiltinResource] get metadata: unsupported resource type '%s' for %s", type, id);
  return null;
}
function totalPages(ctx: Context, type: string, id: string): number {
  if (!['textbooks', 'textbook', 'files', 'file'].includes(type)) return 0;
  try {
    const raw = ocrJsonForResource(toolVfsDatabase(ctx).getConnSafe(), id);
    return raw === null || rustTrim(raw) === '' ? 0 : parseOcrPages(raw, ctx.logger).length;
  } catch { return 0; }
}
function pagedContent(ctx: Context, type: string, id: string, pageStart: number, pageEnd: number): [string, number] {
  if (['textbooks', 'textbook', 'files', 'file'].includes(type)) {
    const raw = ocrJsonForResource(toolVfsDatabase(ctx).getConnSafe(), id);
    if (raw !== null && rustTrim(raw) !== '') {
      const pages = parseOcrPages(raw, ctx.logger);
      if (pages.length > 0) {
        const start = Math.min(Math.max(0, pageStart - 1), pages.length - 1), end = Math.min(pageEnd, pages.length);
        const content = joinOcrPagesText(pages.slice(start, end), start, '第', '页');
        if (content !== undefined) {
          ctx.logger.info('[DSTU::content_helpers] get_content_by_type_paged: SUCCESS - type=%s, id=%s, pages=%d-%d/%d', type, id, pageStart, pageEnd, pages.length);
          return [content, pages.length];
        }
      }
    }
    ctx.logger.info('[DSTU::content_helpers] get_content_by_type_paged: no OCR pages, fallback to full content for id=%s', id);
  }
  return [getContentByType({ database: toolVfsDatabase(ctx) }, type, id), 0];
}
export function executeResourceRead(ctx: Context, argumentsValue: unknown): Record<string, unknown> {
  if (!ctx.get('vfsDatabase')) throw new Error('VFS database not available');
  const picked = pickResourceReadId(argumentsValue);
  if (picked === null) throw new Error('Missing resource identifier. 请传入 resource_id/readResourceId/sourceId/resourceId，并可先调用 resource_list 或 unified_search 获取可用 ID。');
  const resolved = resolveReadTarget(ctx, picked[0]), args = object(argumentsValue);
  const includeMetadata = typeof args.include_metadata === 'boolean' ? args.include_metadata : true;
  ctx.logger.debug('[BuiltinResourceExecutor] resource_read: requested_id=%s, resolved_id=%s, type=%s, include_metadata=%s', resolved.requestedId, resolved.readId, resolved.resourceType, includeMetadata);
  const startTime = performance.now();
  let metadata: Record<string, unknown> | null = null, metadataError: string | null = null;
  if (includeMetadata) {
    try { metadata = resourceReadMetadata(ctx, resolved.resourceType, resolved.readId); }
    catch (error) { metadataError = detail(error); ctx.logger.warn('[BuiltinResourceExecutor] get metadata failed for %s: %s', resolved.readId, metadataError); }
  }
  const rawStart = uint(args.page_start), rawEnd = uint(args.page_end);
  const pageStart = rawStart === null ? null : Math.max(1, rawStart), pageEnd = rawEnd === null ? null : Math.max(1, rawEnd);
  const offset = parseOffset(argumentsValue), maxBytes = parseMaxBytes(argumentsValue), expected = optionalExpectedHash(argumentsValue);
  const timeStart = typeof args.time_start === 'number' ? args.time_start : null, timeEnd = typeof args.time_end === 'number' ? args.time_end : null;
  let media: TranscriptRead | null = null;
  if (resolved.resourceType === 'files' && pageStart === null) {
    try { media = readTranscriptRange(toolVfsDatabase(ctx).getConnSafe(), resolved.readId, timeStart, timeEnd); }
    catch (error) { ctx.logger.warn('[BuiltinResourceExecutor] transcript read failed for %s: %s', resolved.readId, detail(error)); }
  }
  let logical: string, pages: number;
  if (media !== null) { logical = media.content; pages = 0; }
  else if (pageStart !== null) {
    const end = Math.max(pageStart, pageEnd ?? pageStart);
    ctx.logger.debug('[BuiltinResourceExecutor] resource_read paged: pages=%d-%d, type=%s', pageStart, end, resolved.resourceType);
    [logical, pages] = pagedContent(ctx, resolved.resourceType, resolved.readId, pageStart, end);
  } else {
    logical = getContentByType({ database: toolVfsDatabase(ctx) }, resolved.resourceType, resolved.readId);
    pages = totalPages(ctx, resolved.resourceType, resolved.readId);
  }
  const hash = sha256HexSync(logical);
  if (expected !== null) checkExpectedHash(expected, hash);
  const page = pageUtf8Text(logical, offset, maxBytes), count = charCount(logical);
  const availability = collectReadAvailability(resolved.resourceType, logical, metadata);
  const degradation = buildDegradationInfo(resolved.resourceType, logical, availability, metadataError);
  const durationMs = Math.floor(performance.now() - startTime);
  ctx.logger.debug('[BuiltinResourceExecutor] resource_read completed: requested_id=%s, resolved_id=%s, content_len=%d, total_pages=%d, %dms', resolved.requestedId, resolved.readId, utf8ByteLength(page.content), pages, durationMs);
  const result: Record<string, unknown> = { success: true, resourceId: resolved.requestedId, resolvedResourceId: resolved.readId,
    resolvedBy: resolved.resolvedBy, resolvedFromArg: picked[1], type: resolved.resourceType, content: page.content,
    contentLength: utf8ByteLength(page.content), contentTruncated: page.truncated, sha256: hash, offset: page.offset,
    returned_bytes: page.returned_bytes, next_offset: page.next_offset, eof: page.eof, truncated: page.truncated,
    availability, previewImages: metadata !== null && Object.hasOwn(metadata, 'previewImages') ? metadata.previewImages : [], degradation, durationMs };
  if (pages > 0) {
    result.totalPages = pages;
    if (pageStart !== null) {
      const end = Math.min(pages, Math.max(pageStart, pageEnd ?? pageStart));
      result.pageStart = pageStart; result.pageEnd = end;
      result.hint = `当前返回第 ${pageStart}-${end} 页（共 ${pages} 页）。可通过 page_start/page_end 参数读取其他页。`;
    } else result.hint = `本文档共 ${pages} 页。可通过 page_start/page_end 参数按页读取，避免一次加载全部内容。`;
  }
  if (media !== null) {
    result.timeRange = media.range; result.mediaDurationMs = media.totalMs; result.mediaCitation = mediaCitation(resolved.readId, media.range.startMs);
    let hint = `转写 ${formatMediaTimestamp(media.range.startMs)}–${formatMediaTimestamp(Math.min(media.range.endMs, media.totalMs))}（全长 ${formatMediaTimestamp(media.totalMs)}，单次≤10分钟）。引用格式 [媒体@${resolved.readId}:mm:ss]。`;
    if (media.truncated) hint += '请求超过 10 分钟，已截断。';
    if (media.range.endMs < media.totalMs) hint += `继续读传 time_start=${Math.floor(media.range.endMs / 1000)}。`;
    result.hint = hint;
  } else if (timeStart !== null || timeEnd !== null) result.hint = '该资源没有已完成的音视频转写，已忽略 time_start/time_end。';
  if (metadata !== null) result.metadata = metadata;
  if (metadataError !== null) result.metadata_error = `Failed to retrieve metadata for '${resolved.readId}': ${metadataError}. The content is still available.`;
  else if (metadata === null && includeMetadata) result.metadata_error = 'Metadata not found for this resource. The content is still available.';
  fitResourceReadResult(result, page.offset, utf8ByteLength(logical));
  if (result.truncated === true) {
    const next = uint(result.next_offset) ?? page.next_offset, returned = uint(result.returned_bytes) ?? 0;
    const hint = pages > 0 ? `请缩小 page_start/page_end 范围，或用 offset=${next} 继续读取（共 ${pages} 页）。` : `请用 offset=${next} 继续读取剩余内容。`;
    result.truncationNotice = `内容过长已分页：逻辑内容 ${count} 字符，本次返回 ${returned} 字节。${hint}`;
  }
  return result;
}
