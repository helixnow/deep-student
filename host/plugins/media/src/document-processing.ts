/**
 * `src/chat_v2/tools/document_processing_executor.rs`: tool-name handling,
 * resource-id sanitising, `resolve_file`, stage parsing and the media-type gate
 * for the `document_parse` / `document_parse_status` tools
 * (executor: `tools/document-processing-executor.ts`).
 */
import type { VfsDatabase } from '../../vfs/api.ts';
import { fileRowById, resolveFileId, type VfsFileRow } from '../repository/vfs-files.ts';
import { rustTrim } from './transcript.ts';

export type ProcessingStage =
  | 'pending' | 'text_extraction' | 'page_rendering' | 'page_compression'
  | 'image_compression' | 'ocr_processing' | 'vector_indexing'
  | 'completed' | 'failed';

/** `dstu-core/src/tool_names.rs:26` */
export function stripToolNamespace(toolName: string): string {
  if (toolName.startsWith('builtin-')) return toolName.slice('builtin-'.length);
  if (toolName.startsWith('mcp_')) return toolName.slice('mcp_'.length);
  return toolName;
}

export const DOCUMENT_TOOL_NAMES = ['document_parse', 'document_parse_status'] as const;

export function canHandle(toolName: string): boolean {
  const name = stripToolNamespace(toolName);
  return (DOCUMENT_TOOL_NAMES as readonly string[]).includes(name);
}

/** 发起解析消耗算力（OCR 可能调用 LLM/VLM），状态查询为低敏感度。 */
export function sensitivityLevel(toolName: string): 'medium' | 'low' {
  return stripToolNamespace(toolName) === 'document_parse' ? 'medium' : 'low';
}

/** 清洗资源 ID：仅接受字母数字/下划线/连字符组成的 ID。 */
export function sanitizeId(raw: string): string {
  const trimmed = rustTrim(raw).replace(/^["'`]+|["'`]+$/g, '');
  if (trimmed === '' || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error(`资源 ID 格式无效: ${raw}`);
  }
  return trimmed;
}

export interface VfsFileLike {
  fileName: string;
  fileType: string;
  mimeType: string | null;
}

export interface ResolvedVfsFile extends VfsFileLike {
  id: string;
  resourceId: string | null;
  blobHash: string | null;
  sha256: string;
  size: number;
  pageCount: number | null;
  /** `extracted_text.chars().count()`，无文本为 0。 */
  extractedTextChars: number;
}

function fromRow(row: VfsFileRow): ResolvedVfsFile {
  return {
    id: row.id,
    resourceId: row.resource_id,
    blobHash: row.blob_hash,
    sha256: row.sha256,
    fileName: row.file_name,
    size: row.size,
    fileType: row.type,
    mimeType: row.mime_type,
    pageCount: row.page_count,
    extractedTextChars: row.extracted_text === null ? 0 : [...row.extracted_text].length,
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lookupFile(database: VfsDatabase, id: string): ResolvedVfsFile | null {
  let conn;
  try { conn = database.getConnSafe(); }
  catch (error) { throw new Error(`获取数据库连接失败: ${messageOf(error)}`); }
  let row: VfsFileRow | null;
  try { row = fileRowById(conn, id); }
  catch (error) { throw new Error(`查询文件失败: ${messageOf(error)}`); }
  return row === null ? null : fromRow(row);
}

/**
 * `DocumentProcessingExecutor::resolve_file`：支持 `file_*`/`att_*` 主键、
 * `res_*` 上传资源与两级引用资源反查；返回的错误文案与 Rust 一致。
 */
export function resolveFile(database: VfsDatabase, rawId: string): ResolvedVfsFile {
  const id = sanitizeId(rawId);

  if (id.startsWith('file_') || id.startsWith('att_')) {
    const file = lookupFile(database, id);
    if (file === null) {
      throw new Error(`文件不存在: ${id}（请用 resource_list/resource_search 获取有效 ID）`);
    }
    return file;
  }

  if (id.startsWith('res_')) {
    let conn;
    try { conn = database.getConnSafe(); }
    catch (error) { throw new Error(`获取数据库连接失败: ${messageOf(error)}`); }
    let fileId: string | null;
    try { fileId = resolveFileId(conn, id); }
    catch (error) { throw new Error(`解析资源失败: ${messageOf(error)}`); }
    if (fileId !== null) {
      const file = lookupFile(database, fileId);
      if (file === null) throw new Error(`文件不存在: ${fileId}`);
      return file;
    }
  }

  throw new Error(
    `资源 ${rawId} 未关联到可解析的文件（仅文件类资源支持解析/OCR；笔记/思维导图等无需解析）。`
    + '请用 resource_list 确认资源类型，或用 attachment_list 拿到附件 ID 后改用 attachment_stage/attachment_read。');
}

/** 校验文件媒体类型是否支持解析管线（PDF/图片）。 */
export function checkMediaSupported(file: VfsFileLike): void {
  const mime = file.mimeType ?? '';
  const supported = mime === 'application/pdf'
    || mime.startsWith('image/')
    || file.fileType === 'image';
  if (!supported) {
    throw new Error(
      `文件 ${file.fileName}（类型: ${mime === '' ? file.fileType : mime}）不支持解析/OCR 管线，`
      + '仅支持 PDF 与图片。DOCX/PPTX/XLSX 请用 docx_read_structured 等 Office 工具直接读取。');
  }
}

/** stage 参数 → ProcessingStage 映射（auto → 交给服务按媒体类型决定）。 */
export function parseStage(args: Record<string, unknown>): Extract<ProcessingStage, 'ocr_processing' | 'text_extraction'> | null {
  const value = args.stage;
  const stage = typeof value === 'string' ? value : 'auto';
  switch (stage) {
    case 'auto': return null;
    case 'ocr': return 'ocr_processing';
    case 'full': return 'text_extraction';
    default:
      throw new Error(`无效的 stage 参数: ${stage}（可选: auto / ocr / full）`);
  }
}
