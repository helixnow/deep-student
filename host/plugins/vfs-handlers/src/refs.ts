/** ref_handlers.rs: command validation and context resolution. */
import type { Context } from '@deepseek-ai/cordis';
import { rustTrim, utf8ByteLength, takeChars } from '../../../platform/util/portable.ts';
import { CommandError } from '../../../kernel/api.ts';
import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { VfsError } from '../../vfs/portable.ts';
import type { VfsReposService } from '../../vfs-repos/api.ts';
import { extractMindmapText } from '../../vfs-index/api.ts';
import type { DocsService } from '../../media/api.ts';
import type { GetResourceRefsInput, ResolvedResource, VfsContextRefData, VfsResourceRef,
  VfsResourceRef__De } from '../../../../contracts/ipc/generated/L13-vfs-api.ts';
import type { QbankRefReader } from './ref-needs.ts';
import * as repo from '../repository/refs.ts';

export interface RefDeps {
  conn(): SqlExecutor;
  blobsDir(): string;
  /** `ctx.files.readBytes`：PDF/题目插图 blob 读取（移动端同一套异步接口）。 */
  readBytes(path: string): Promise<Uint8Array>;
  repos: VfsReposService;
  docs?: Pick<DocsService, 'extractTextFromBase64'>;
  qbank?: QbankRefReader;
  log: Context['logger'];
}

function fail(error: unknown): never {
  if (error instanceof CommandError) throw error;
  throw new CommandError(error instanceof VfsError ? error.toString()
    : error instanceof Error ? error.message : String(error));
}

export function getResourceRefs(deps: RefDeps, params: GetResourceRefsInput): VfsContextRefData {
  deps.log.info('[VFS::RefHandlers] vfs_get_resource_refs: source_ids=%s, include_folder_contents=%s, max_items=%d', params.sourceIds, params.includeFolderContents ?? false, params.maxItems ?? 50);
  try {
    const conn = deps.conn();
    const max = Math.min(params.maxItems ?? 50, 50);
    const result: VfsContextRefData = { refs: [], truncated: false, totalCount: 0 };
    for (const id of params.sourceIds) {
      if (result.refs.length >= max) { result.truncated = true; break; }
      if (id.startsWith('fld_') && (params.includeFolderContents ?? false)) {
        let count = 0;
        try { count = repo.getFolderRefCount(conn, deps.repos.folders, id); }
        catch { count = 0; } // Rust unwrap_or(0), without a warning.
        result.totalCount += count;
        if (count > max - result.refs.length) result.truncated = true;
        try { result.refs.push(...repo.getFolderRefs(conn, deps.repos.folders, id, max - result.refs.length)); }
        catch (error) { deps.log.warn('[VFS::RefHandlers] Failed to get folder refs for %s: %s', id, String(error)); }
      } else {
        try {
          const ref = repo.getResourceRef(conn, id);
          if (ref !== null) { result.refs.push(ref); result.totalCount++; }
        } catch (error) { deps.log.warn('[VFS::RefHandlers] Failed to get resource ref for %s: %s', id, String(error)); }
      }
    }
    if (result.totalCount > max) result.truncated = true;
    deps.log.info('[VFS::RefHandlers] Got %d refs (total_count=%d, truncated=%s)', result.refs.length, result.totalCount, result.truncated);
    return result;
  } catch (error) { return fail(error); }
}

export function getResourceRefCount(deps: RefDeps, id: string): number {
  deps.log.info('[VFS::RefHandlers] vfs_get_resource_ref_count: source_id=%s', id);
  try {
    const conn = deps.conn();
    try {
      const count = repo.getResourceRefCount(conn, id);
      deps.log.info('[VFS::RefHandlers] Resource %s has %d refs', id, count);
      return count;
    }
    catch (error) {
      // Rust known-source queries use unwrap_or(0); unknown-source errors propagate.
      if (repo.getSourceIdType(id) === null) throw error;
      deps.log.info('[VFS::RefHandlers] Resource %s has %d refs', id, 0);
      return 0;
    }
  } catch (error) { return fail(error); }
}

/** Rust counts UTF-8 bytes when selecting the longer extracted text. */
export async function extractFileText(deps: RefDeps, id: string, name: string, base64: string | null): Promise<string | null> {
  return extractFileTextWithConn(deps, deps.conn(), id, name, base64);
}

/**
 * ref_handlers.rs:340-412 `extract_file_text_with_strategy(conn, source_id, file_name, base64_content)`
 * on a caller-supplied connection (published as `vfsRefText`).
 */
export async function extractFileTextWithConn(
  deps: Pick<RefDeps, 'docs' | 'log'>,
  conn: SqlExecutor,
  sourceId: string,
  fileName: string,
  base64Content: string | null,
): Promise<string | null> {
  const TEXT_THRESHOLD = 1000;
  const ocrText = repo.getOcrPagesText(conn, sourceId, deps.log);
  deps.log.debug('[TextExtract] OCR text for source_id=%s: len=%d', sourceId, utf8ByteLength(ocrText ?? ''));
  let parsedText = repo.getExtractedText(conn, sourceId);
  if (parsedText === null || utf8ByteLength(parsedText) < TEXT_THRESHOLD) {
    if (base64Content !== null && base64Content !== '') {
      deps.log.debug('[TextExtract] Trying DocumentParser for source_id=%s, base64_len=%d', sourceId, utf8ByteLength(base64Content));
      if (deps.docs === undefined) throw new Error('docs@1 未发布 extractTextFromBase64');
      let text: string | null = null;
      try { text = await deps.docs.extractTextFromBase64(fileName, base64Content); }
      catch { text = null; } // Rust `if let Ok(text)`: parser errors are dropped without warn/error.
      if (text !== null && utf8ByteLength(text) > utf8ByteLength(parsedText ?? '')) {
        deps.log.debug('[TextExtract] DocumentParser result: %d chars', utf8ByteLength(text));
        parsedText = text;
      }
    }
  }
  return repo.selectExtractedText(ocrText, parsedText, deps.log, sourceId);
}

function enumValue<T extends string>(value: T | object): T {
  return (typeof value === 'string' ? value : Object.keys(value)[0]) as T;
}

function normalizeRef(ref: VfsResourceRef__De): VfsResourceRef {
  return { ...ref, type: enumValue<VfsResourceRef['type']>(ref.type), injectModes: ref.injectModes == null ? ref.injectModes : {
    image: ref.injectModes.image?.map(mode => enumValue<'image' | 'ocr'>(mode)),
    pdf: ref.injectModes.pdf?.map(mode => enumValue<'image' | 'ocr' | 'text'>(mode)),
  } };
}

function missing(ref: VfsResourceRef): ResolvedResource {
  return { sourceId: ref.sourceId, resourceHash: ref.resourceHash, type: ref.type,
    name: ref.name, path: '', found: false };
}

async function resolveOne(deps: RefDeps, ref: VfsResourceRef): Promise<ResolvedResource> {
  deps.log.info('[PDF_DEBUG] resolve_single_ref_with_conn START: source_id=%s, type=%s, name=%s', ref.sourceId, ref.type, ref.name);
  const conn = deps.conn();
  const id = repo.getSourceIdType(ref.sourceId) !== null ? ref.sourceId
    : (ref.resourceId ? repo.resolveSourceIdByResourceId(conn, ref.resourceId) : null)
      ?? (ref.sourceId.startsWith('res_') ? repo.resolveSourceIdByResourceId(conn, ref.sourceId) : null) ?? ref.sourceId;
  const info = repo.getSourceIdType(id);
  if (info === null) {
    deps.log.warn('[OCR_DIAG] get_source_id_type returned None for source_id=%s, normalized_source_id=%s', ref.sourceId, id);
    const snippet = rustTrim(ref.snippet ?? (rustTrim(ref.name) ? ref.name : ''));
    return ref.type === 'retrieval' && snippet ? { ...missing(ref), found: true,
      content: snippet, warning: 'retrieval snippet fallback' } : missing(ref);
  }
  const exists = repo.resourceExists(conn, info.table, id);
  deps.log.info('[OCR_DIAG] resource exists check: source_id=%s, table=%s, exists=%s', id, info.table, exists);
  if (!exists) {
    deps.log.warn("[OCR_DIAG] resource NOT FOUND in table '%s': source_id=%s", info.table, id);
    return missing(ref);
  }
  const result = { ...missing(ref), found: true, name: repo.getResourceTitle(conn, id) ?? ref.name,
    path: repo.getResourcePath(conn, id, ref.type) };
  const title = result.name;
  deps.log.info('[PDF_DEBUG] calling get_resource_content_with_conn: source_id=%s, type=%s', id, ref.type);
  const raw = repo.getRawResourceContent(conn, deps.blobsDir(), deps.repos.files, id, ref.type, deps.log);
  deps.log.info('[PDF_DEBUG] raw_content result: source_id=%s, has_content=%s, content_len=%d', id, raw !== null, utf8ByteLength(raw ?? ''));
  deps.log.info('[PDF_DEBUG] processing content by type: source_id=%s, resource_type=%s, inject_modes=%s', ref.sourceId, ref.type, ref.injectModes ?? null);
  let content = raw;
  let warning: string | undefined;
  let blocks;
  if (ref.type === 'image') {
    deps.log.info('[OCR_DIAG] Image branch entered: source_id=%s, inject_modes=%s, image_modes=%s', ref.sourceId, ref.injectModes ?? null, ref.injectModes?.image ?? null);
    const modes = repo.resolveImageInjectModes(ref.injectModes?.image, true);
    deps.log.info('[OCR_DIAG] Image: resolved modes: include_image=%s, include_ocr=%s', modes.includeImage, modes.includeOcr);
    deps.log.info('[OCR_DIAG] Image type: include_image=%s, include_ocr=%s, source_id=%s', modes.includeImage, modes.includeOcr, ref.sourceId);
    const parts: string[] = [];
    if (modes.includeImage && raw !== null) {
      deps.log.info('[PDF_DEBUG] Image type: adding raw base64, len=%d', utf8ByteLength(raw));
      parts.push(raw);
    }
    if (modes.includeOcr) {
      const ocr = repo.getImageOcrText(conn, ref.sourceId, deps.log);
      if (ocr !== null) {
        deps.log.info('[PDF_DEBUG] Image type: adding OCR text, len=%d', utf8ByteLength(ocr));
        parts.push(`<image_ocr name="${repo.escapeXmlAttr(title)}">${repo.escapeXmlContent(ocr)}</image_ocr>`);
      } else deps.log.info('[PDF_DEBUG] Image type: no OCR text available');
    }
    content = parts.length ? parts.join('\n\n') : !modes.includeImage && modes.includeOcr ? `[图片无 OCR 文本: ${title}]` : null;
  } else if (ref.type === 'file' || ref.type === 'textbook') {
    if (title.toLowerCase().endsWith('.pdf')) {
      const modes = repo.resolvePdfInjectModes(ref.injectModes?.pdf, true);
      deps.log.info('[PDF_DEBUG] PDF file: include_text=%s, include_ocr=%s', modes.includeText, modes.includeOcr);
      const parts: string[] = [];
      if (modes.includeOcr) {
        const ocr = repo.getOcrPagesText(conn, ref.sourceId, deps.log);
        if (ocr !== null) {
          deps.log.info('[PDF_DEBUG] PDF: adding OCR pages text, len=%d', utf8ByteLength(ocr));
          parts.push(`<pdf_ocr name="${repo.escapeXmlAttr(title)}">${repo.escapeXmlContent(ocr)}</pdf_ocr>`);
        } else deps.log.info('[PDF_DEBUG] PDF: no OCR pages text available');
      }
      if (modes.includeText) {
        const text = await extractFileText(deps, ref.sourceId, title, raw);
        if (text) {
          deps.log.info('[PDF_DEBUG] PDF: adding extracted text, len=%d', utf8ByteLength(text));
          parts.push(text);
        }
      }
      content = parts.length ? parts.join('\n\n') : `[文档: ${title}]`;
      if (!parts.length && modes.includeImage) deps.log.info('[PDF_DEBUG] PDF %s in image-only mode: text parts empty by design, page images delivered via multimodal_blocks', ref.sourceId);
      if (!parts.length && !modes.includeImage) {
        deps.log.warn('[PDF_DEBUG] No text available for PDF source_id=%s, returning filename hint', ref.sourceId);
        warning = `「${title}」文本提取失败，该文档内容未能送入对话`;
      }
      if (modes.includeImage) {
        blocks = await repo.getFileMultimodalBlocks(conn, deps.blobsDir(), deps.repos.blobs, ref.sourceId, deps.log, deps.readBytes);
        deps.log.info('[PDF_DEBUG] multimodal_blocks for PDF: source_id=%s, blocks_count=%d', ref.sourceId, blocks?.length ?? 0);
      } else deps.log.info('[PDF_DEBUG] multimodal_blocks skipped for PDF (inject_modes.pdf does not include Image): source_id=%s', ref.sourceId);
    } else {
      deps.log.info('[PDF_DEBUG] File/Textbook (non-PDF): calling extract_file_text_with_strategy');
      content = await extractFileText(deps, ref.sourceId, title, raw);
      if (content) deps.log.info('[PDF_DEBUG] extract_file_text_with_strategy returned %d chars', utf8ByteLength(content));
      if (!content) {
        deps.log.warn('[PDF_DEBUG] No text available for source_id=%s, returning filename hint', ref.sourceId);
        const ext = rustTrim(title.split('.').at(-1) ?? '').toLowerCase();
        if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'wma', 'opus'].includes(ext)) {
          content = `[音频文件: ${title}（resourceId: ${ref.sourceId}）。该音频尚未转写，内容不可直接读取。若需要其中的语音内容，可调用 media_transcribe 工具（传入该 resourceId）转写为带 [mm:ss] 时间戳的文本；Opus/WMA 编码需先转为 MP3/M4A]`;
          warning = `「${title}」是音频文件且尚未转写，模型可通过 media_transcribe 工具转写`;
        } else if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'wmv', 'flv'].includes(ext)) {
          content = `[视频文件: ${title}（resourceId: ${ref.sourceId}）。该视频尚未转写，画面内容不可读取。若需要其中的语音内容，可调用 media_transcribe 工具（传入该 resourceId）提取音轨并转写为带 [mm:ss] 时间戳的文本]`;
          warning = `「${title}」是视频文件且尚未转写，模型可通过 media_transcribe 工具转写音轨`;
        } else {
          content = `[文档: ${title}]`;
          warning = `「${title}」文本提取失败，该文档内容未能送入对话`;
        }
      }
    }
  } else if (ref.type === 'mindmap') {
    deps.log.info('[PDF_DEBUG] MindMap type: extracting node text from JSON, raw_content_len=%d', utf8ByteLength(raw ?? ''));
    if (raw !== null) {
      const extracted = extractMindmapText(raw);
      if (extracted) deps.log.info('[PDF_DEBUG] MindMap: extracted %d chars of node text', utf8ByteLength(extracted));
      else if (extracted === '') deps.log.info('[PDF_DEBUG] MindMap: extract_mindmap_text returned empty, using raw');
      else deps.log.info('[PDF_DEBUG] MindMap: extract_mindmap_text returned None, using raw');
      content = extracted || raw;
    }
  } else if (ref.type === 'exam') {
    if (deps.qbank === undefined || typeof deps.qbank.contextForRefs !== 'function') throw new Error('qbank 未发布 contextForRefs');
    const document = deps.qbank.contextForRefs(ref.sourceId);
    content = document === null ? raw : JSON.stringify(document);
    blocks = await repo.getExamMultimodalBlocks(conn, deps.blobsDir(), deps.repos.blobs, ref.sourceId, document, deps.log, deps.readBytes);
  } else {
    deps.log.info('[PDF_DEBUG] %s type: using raw_content directly, has_content=%s', ref.type, raw !== null);
  }
  deps.log.info('[PDF_DEBUG] final content: source_id=%s, has_content=%s, content_len=%d', ref.sourceId, content !== null, utf8ByteLength(content ?? ''));
  return { ...result, ...(content === null ? {} : { content }),
    ...(warning === undefined ? {} : { warning }), ...(blocks == null ? {} : { multimodalBlocks: blocks }) };
}

export async function resolveResourceRefs(deps: RefDeps, refs: VfsResourceRef__De[]): Promise<ResolvedResource[]> {
  deps.log.info('[VFS::RefHandlers] vfs_resolve_resource_refs: %d refs', refs.length);
  refs.forEach((ref, index) => deps.log.info('[OCR_DIAG] ref[%d]: source_id=%s, type=%s, name=%s, inject_modes=%s', index, ref.sourceId, ref.type, ref.name, ref.injectModes ?? null));
  if (refs.length > 50) throw new CommandError(`Too many refs to resolve: ${refs.length} (max: 50)`);
  try { deps.conn(); } catch (error) { return fail(error); }
  const resolved: ResolvedResource[] = [];
  for (const input of refs) {
    const ref = normalizeRef(input);
    try {
      const resource = await resolveOne(deps, ref);
      deps.log.info('[OCR_DIAG] resolved: source_id=%s, found=%s, has_content=%s, content_len=%d, has_multimodal_blocks=%s, content_preview=%s',
        resource.sourceId, resource.found, resource.content != null, utf8ByteLength(resource.content ?? ''), resource.multimodalBlocks != null,
        resource.content == null ? 'None' : `"${takeChars(resource.content, 200)}..."`);
      resolved.push(resource);
    }
    catch (error) {
      deps.log.warn('[VFS::RefHandlers] Failed to resolve ref %s: %s', ref.sourceId, String(error));
      resolved.push(missing(ref));
    }
  }
  deps.log.info('[VFS::RefHandlers] Resolved %d refs, %d found', resolved.length, resolved.filter(r => r.found).length);
  return resolved;
}

export type { GetResourceRefsInput, VfsResourceRef__De };
