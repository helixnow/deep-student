// ★ 图谱模块已废弃 - 本地占位类型
type TagHierarchy = { id: string; name: string; children?: TagHierarchy[] };
type GraphQueryParams = Record<string, unknown>;
type ForceGraphData = { nodes: unknown[]; links: unknown[] };
// Tauri API调用模块 - 真实的后端API调用
import { invoke } from '@tauri-apps/api/core';
import type {
  VendorConfig,
  ModelProfile,
  ApiConfig,
  AnkiLibraryCard,
  AnkiLibraryListResponse,
  ListAnkiCardsParams,
  ExportAnkiCardsResult,
} from '../types';
import { emitDebug } from '../utils/emitDebug';
import {
  ChatMessage,
  RagSourceInfo,
  DocumentAttachment,
  GeneralChatSessionRequest,
  GeneralChatSessionResponse,
  GenerateChatMetadataResponse,
  UpdateChatMetadataNoteResponse,
  UpdateOcrNoteResponse,
  ExamSheetSessionUnlinkRequest,
  ExamSheetSessionUnlinkResponse,
  RuntimeAutosaveCommitRequest,
  RuntimeAutosaveCommitResponse,
} from '../types';
import { normalizeHistoryForBackend } from './normalizeHistory';
import { t } from './i18n';
import { v4 as uuidv4 } from 'uuid';
// ★ 图谱模块已废弃 - 本地占位类型
type Tag = { id: string; name: string; color?: string };
type ProblemCard = { id: string; content_problem: string; content_insight?: string; notes?: string };
type CreateTagRequest = { name: string; color?: string; parent_id?: string; tag_type?: string; description?: string };
type LegacyCreateTagRequest = CreateTagRequest & { parent_tag_id?: string };
import heic2any from 'heic2any';
import { getErrorMessage } from './errorUtils';
import { debugLogger } from './debugLogger';
import { DEBUG_TIMELINE_GLOBAL_KEYS } from '../config/debugPanel';
import { sanitizeDebugMessageList } from './debugSnapshot';
import { debugLog } from '../debug-panel/debugMasterSwitch';
// ★ Canvas Board 类型和 API 已移除（白板模块废弃，2026-01 清理）
// ★ irec 向量索引类型和 API 已移除（灵感图谱废弃，2025-01 清理）

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

const isTauriRuntime =
  typeof window !== 'undefined' &&
  (Boolean((window as any).__TAURI_INTERNALS__) ||
    Boolean((window as any).__TAURI_IPC__));

// 全局调试日志函数
let globalAddLog: ((message: string, data?: any) => void) | null = null;
export const setGlobalDebugLogger = (addLog: (message: string, data?: any) => void) => {
  globalAddLog = addLog;
};
const tauriDebugLog = (message: string, data?: any) => {
  try {
    void debugLogger.log('DEBUG', 'TAURI_API', message, data);
  } catch (error) {
    // debugLogger failed silently
  }
  if (globalAddLog) {
    globalAddLog(message, data);
  }
};

const convertHistoryToUnifiedMessages = (history?: ChatMessage[] | null): any[] => {
  if (!history || history.length === 0) return [];
  let normalizedHistory: any[] = history as any[];
  try {
    normalizedHistory = normalizeHistoryForBackend(history as any);
  } catch {
    // fallback to raw history
  }
  return (normalizedHistory || []).map((m: any, idx: number) => {
    const stableId = m.persistent_stable_id || m._stableId || m.id || `${m.role}-${idx}-${Date.now()}`;
    const rawMeta = (m as any)?._meta ?? (m as any)?.metadata;
    let metadata;
    if (rawMeta !== undefined) {
      try {
        metadata = JSON.parse(JSON.stringify(rawMeta));
      } catch {
        metadata = rawMeta;
      }
    }
    return {
      id: stableId,
      persistent_stable_id: stableId,
      role: m.role,
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
      timestamp: m.timestamp || m.created_at || new Date().toISOString(),
      image_base64: m.image_base64 || undefined,
      doc_attachments: Array.isArray(m.doc_attachments)
        ? m.doc_attachments.map((d: any, docIdx: number) => ({
            name: d.name || `doc_${docIdx}`,
            mime_type: d.mime_type || 'text/plain',
            size_bytes: typeof d.size_bytes === 'number' ? d.size_bytes : (d.content?.length || d.text_content?.length || 0),
            text_content: d.text_content || (typeof d.content === 'string' ? d.content : undefined),
            base64_content: d.base64_content,
          }))
        : undefined,
      rag_sources: (m as any).rag_sources || undefined,
      graph_sources: (m as any).graph_sources || undefined,
      memory_sources: (m as any).memory_sources || undefined,
      web_search_sources: (m as any).web_search_sources || undefined,
      tool_call: (m as any).tool_call || undefined,
      tool_result: (m as any).tool_result || undefined,
      metadata,
      overrides: undefined,
      relations: undefined,
    };
  });
};

// 重新导出类型以保持兼容性
// ★ 2026-01 清理：MistakeItem 仍需导出以保持向后兼容
import { MistakeItem } from '../types';
export type { MistakeItem, ChatMessage, RagSourceInfo };

export interface GraphRecallStageLogDto {
  name: string;
  duration_ms: number;
  detail?: string | null;
}

export interface GraphRecallDiagnosticsResult {
  stages: GraphRecallStageLogDto[];
  warnings: string[];
  total_results: number;
  note_results: number;
  low_confidence: boolean;
}

export interface GraphRecallTestResult {
  success: boolean;
  error?: string | null;
  sources: RagSourceInfo[];
  payload: any[];
  diagnostics: GraphRecallDiagnosticsResult;
}

export interface ExamCardPreview {
  card_id: string;
  page_index: number;
  question_label: string;
  bbox: { x: number; y: number; width: number; height: number };
  resolved_bbox?: { x: number; y: number; width: number; height: number };
  /** @deprecated 旧数据兼容，新数据使用 page.blob_hash + card.bbox 实时裁剪 */
  cropped_image_path?: string;
  ocr_text: string;
  tags: string[];
  extra_metadata?: Record<string, unknown> | null;
  linked_mistake_ids?: string[];
  question_type?: string;
  options?: Array<{ key: string; content: string }>;
  answer?: string;
  explanation?: string;
  difficulty?: string;
  status?: string;
  user_answer?: string;
  is_correct?: boolean;
  attempt_count?: number;
  correct_count?: number;
  last_attempt_at?: string;
  user_note?: string;
  source_type?: string;
  source_info?: string;
  parent_card_id?: string;
  variant_ids?: string[];
}

export interface ExamSheetPreviewPage {
  page_index: number;
  /** @deprecated 旧数据兼容，新数据使用 blob_hash */
  original_image_path?: string;
  /** ★ VFS blob 哈希（文档25改造）*/
  blob_hash?: string;
  /** ★ 图片宽度（像素）*/
  width?: number;
  /** ★ 图片高度（像素）*/
  height?: number;
  cards: ExamCardPreview[];
}

export interface ExamSheetPreviewResult {
  session_id: string;
  /** @deprecated 使用 session_id */
  mistake_id?: string;
  exam_name?: string | null;
  pages: ExamSheetPreviewPage[];
  raw_model_response?: unknown;
  instructions?: string | null;
}

export interface ExamSheetPreviewRequestPayload {
  examName?: string;
  pageImages: Array<File | string>;
  instructions?: string;
  // 新增：合并提示词与识别侧重点（传给后端用于分组流程）
  groupingPrompt?: string;
  groupingFocus?: string;
  chunkSize?: number;
  concurrency?: number;
  outputFormat?: 'deepseek_ocr'; // 题目集识别固定使用 DeepSeek-OCR
  /** ★ 追加模式：如果提供 sessionId，将新识别的 pages 追加到现有会话 */
  sessionId?: string;
}

export interface ExamSheetCardUpdatePayload {
  card_id: string;
  page_index?: number;
  bbox?: ExamCardPreview['bbox'];
  resolved_bbox?: ExamCardPreview['bbox'];
  question_label?: string;
  ocr_text?: string;
  tags?: string[];
}

export interface ExamSheetCardCreatePayload {
  page_index: number;
  bbox?: ExamCardPreview['bbox'];
  resolved_bbox?: ExamCardPreview['bbox'];
  question_label?: string;
  ocr_text?: string;
  tags?: string[];
}

export interface UpdateExamSheetCardsRequestPayload {
  session_id: string;
  cards?: ExamSheetCardUpdatePayload[];
  exam_name?: string;
  create_cards?: ExamSheetCardCreatePayload[];
  delete_card_ids?: string[];
}

export interface UpdateExamSheetCardsResponsePayload {
  detail: ExamSheetSessionDetail;
}

export interface RenameExamSheetSessionResponsePayload {
  summary: ExamSheetSessionSummary;
}

// ★ 2026-01 清理：MistakeExamSheetLink 已废弃，使用 ExamSheetLink
export interface ExamSheetLink {
  exam_id: string;
  origin_exam_id?: string | null;
  exam_name?: string | null;
  card_id?: string | null;
  page_index?: number;
  question_label?: string;
  bbox?: ExamCardPreview['bbox'];
  resolved_bbox?: ExamCardPreview['bbox'];
  original_image_path?: string | null;
  cropped_image_path?: string | null;
  session_id?: string | null;
  ocr_text?: string | null;
  tags?: string[] | null;
}
/** @deprecated 使用 ExamSheetLink */
export type MistakeExamSheetLink = ExamSheetLink;



export type BackupTier =
  | 'core_config_chat'
  | 'vfs_full'
  | 'rebuildable'
  | 'large_files';

export interface BackupInfo {
  file_name: string;
  file_path: string;
  size: number;
  created_at: string;
  is_auto_backup: boolean;
}

export interface AnalysisRequest {
  question_image_files: string[]; // Base64编码的图片字符串
  analysis_image_files: string[]; // Base64编码的图片字符串
  user_question: string;
}

export interface AnalysisResponse {
  mistake_id: string; // 首轮即正式：直接是mistake_id
  business_session_id: string;
  generation_id: number;
  initial_data: {
    ocr_text: string;
    tags: string[];
    mistake_type: string;
    first_answer: string;
  };
}

export interface ContinueChatRequest {
  mistake_id: string; // 首轮即正式：直接是mistake_id
  chat_history: ChatMessage[];
}

export interface ContinueChatResponse {
  new_assistant_message: string;
}

export interface SaveMistakeRequest {
  mistake_id: string; // 首轮即正式：直接是mistake_id
  final_chat_history: ChatMessage[];
  source?: 'auto' | 'manual' | string;
  autosave_signature?: string | null;
  generation_id?: number | null;
  save_reason?: string | null;
}

export interface SaveMistakeResponse {
  success: boolean;
  final_mistake_item?: MistakeItem;
  source?: 'auto' | 'manual' | string;
}

// 统一封装：带调试埋点的 invoke
function sanitizeArgs(value: any, depth = 0): any {
  const redactKeys = /^(api[_-]?key|apikey|apiKey|authorization|auth|token|password)$/i;
  if (value == null) return value;
  if (depth > 2) return typeof value === 'object' ? '[Object]' : String(value);
  if (Array.isArray(value)) {
    if (value.length > 24) return { type: 'array', length: value.length };
    return value.map(v => sanitizeArgs(v, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) {
      if (redactKeys.test(k)) { out[k] = '***'; continue; }
      if (typeof v === 'string' && v.length > 256) { out[k] = `{string len=${v.length}}`; continue; }
      if (Array.isArray(v) && k.includes('image')) { out[k] = { type: 'array', length: v.length }; continue; }
      if (k === 'doc_attachments' && Array.isArray(v)) {
        out[k] = v.map((d: any) => ({ name: d?.name, size: d?.size_bytes, textLen: (d?.text_content||'').length }));
        continue;
      }
      out[k] = sanitizeArgs(v, depth + 1);
    }
    return out;
  }
  return value;
}

function summarizeResult(value: any): any {
  try {
    if (value == null) return null;
    if (typeof value === 'string') return value.length > 200 ? `{string len=${value.length}}` : value;
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    if (typeof value === 'object') return { type: 'object', keys: Object.keys(value).slice(0, 10) };
    return String(value);
  } catch { return '[Unserializable]'; }
}

const sanitizeStringList = (input: any): string[] => {
  if (!Array.isArray(input)) return [];
  const normalized = input
    .map((value) => {
      if (typeof value === 'string') return value.trim();
      if (typeof value === 'number') return String(value);
      return '';
    })
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return Array.from(new Set(normalized));
};

export async function invokeWithDebug<T>(cmd: string, args?: any, meta?: Record<string, any>): Promise<T> {
  const started = Date.now();
  try {
    try { emitDebug({ channel: 'tauri_invoke', eventName: `${cmd}:start`, payload: { args: sanitizeArgs(args), meta } }); } catch {}
    const res = await invoke<T>(cmd, args);
    const duration = Date.now() - started;
    try { emitDebug({ channel: 'tauri_invoke', eventName: `${cmd}:ok`, payload: { durationMs: duration, result: summarizeResult(res), meta } }); } catch {}
    return res;
  } catch (e: any) {
    const duration = Date.now() - started;
    try { emitDebug({ channel: 'tauri_invoke', eventName: `${cmd}:error`, payload: { durationMs: duration, error: (e?.message || String(e)), meta } }); } catch {}
    throw e;
  }
}

// Build args that include both snake_case and camelCase session id keys to be robust
const withSessionId = (sessionId: string) => ({ session_id: sessionId, sessionId });
// Build args that include both snake_case and camelCase graph id keys to be robust
const withGraphId = (graphId: string) => ({ graph_id: graphId, graphId });

// ======================== Token估算（精确优先，tiktoken可用时） ========================
export async function estimateTokens(
  texts: string[],
  model?: string,
): Promise<{ total: number; per_message: number[]; precise: boolean; tokenizer: string }> {
  const payload: any = { texts };
  if (model) payload.model = model;
  return await invokeWithDebug('estimate_tokens', payload, { tag: 'estimate_tokens' });
}

// ======================== 统一参数处理工具函数 ========================

/**
 * 统一处理RAG选项的默认值和库ID
 * 确保错题分析模式使用统一的参数构造逻辑
 */
function buildUnifiedRagOptions(
  ragOptions?: { top_k: number; enable_reranking?: boolean }, 
  libraryIds?: string[]
): { top_k: number; enable_reranking?: boolean; target_sub_library_ids?: string[] } | undefined {
  const hasLibraryArray = Array.isArray(libraryIds);
  const libsPayload = hasLibraryArray ? libraryIds : undefined;

  if (ragOptions) {
    const payload: { top_k: number; enable_reranking?: boolean; target_sub_library_ids?: string[] } = { ...ragOptions };
    if (libsPayload !== undefined) payload.target_sub_library_ids = libsPayload;
    return payload;
  }

  if (libsPayload !== undefined) {
    return {
      top_k: 5,
      target_sub_library_ids: libsPayload,
    };
  }

  return undefined;
}

/**
 * 统一构造模型调用的请求参数
 * 确保两个模式使用相同的参数透传逻辑
 */
function buildModelRequestPayload(baseRequest: Record<string, any>, options: {
  temperature?: number;
  model2_override_id?: string;
  enable_rag?: boolean;
  rag_options?: { top_k: number; enable_reranking?: boolean };
  library_ids?: string[];
  question_image_files?: string[];
  document_attachments?: Array<any>;
  mcp_tools?: string[];
  search_engines?: string[];
}): Record<string, any> {
  const request = { ...baseRequest };
  
  // 可选参数透传
  if (typeof options.temperature === 'number') request.temperature = options.temperature;
  if (options.model2_override_id) request.model2_override_id = options.model2_override_id;
  if (typeof options.enable_rag === 'boolean') request.enable_rag = options.enable_rag;
  
  // 统一RAG选项处理
  const ragOptions = buildUnifiedRagOptions(options.rag_options, options.library_ids);
  if (ragOptions) request.rag_options = ragOptions;
  
  // 多模态支持
  if (Array.isArray(options.question_image_files) && options.question_image_files.length > 0) {
    request.question_image_files = options.question_image_files;
  }
  
  // 文档附件支持
  if (Array.isArray(options.document_attachments) && options.document_attachments.length > 0) {
    request.document_attachments = options.document_attachments.map((doc: any) => {
      // 已是标准形态则直传
      if (doc && typeof doc === 'object' && ('mime_type' in doc || 'text_content' in doc || 'base64_content' in doc)) {
        return doc;
      }
      // 兼容精简形态：{ name, content }
      const name = String(doc?.name || 'document.txt');
      const text = String(doc?.content || '');
      const size_bytes = typeof text === 'string' ? text.length : 0;
      return {
        name,
        mime_type: 'text/plain',
        size_bytes,
        text_content: text,
      };
    });
  }
  
  // MCP工具和搜索引擎选择
  if (Array.isArray(options.mcp_tools)) request.mcp_tools = options.mcp_tools;
  if (Array.isArray(options.search_engines)) request.search_engines = options.search_engines;
  
  return request;
}

/**
 * 深度移除对象中的 null / undefined 字段
 * 目的：避免向 Tauri 命令传入 `null` 导致类型为 String 的字段反序列化失败
 * 注意：仅在发送请求前使用，不改变调用方对返回值的假设
 */
function stripNullsDeep<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }
  if (Array.isArray(input)) {
    return (input as any[]).map((item) => stripNullsDeep(item)) as any as T;
  }
  if (typeof input === 'object') {
    const result: any = {};
    for (const [key, value] of Object.entries(input as any)) {
      if (value === null || value === undefined) continue;
      result[key] = stripNullsDeep(value as any);
    }
    return result as T;
  }
  return input;
}

// ======================== File转换工具函数 ========================

// 工具函数：将File对象转换为Base64字符串
export const fileToBase64 = (file: File): Promise<string> => {
    return new Promise(async (resolve, reject) => {
        tauriDebugLog(`[Base64] Processing file: ${file.name}, size: ${file.size}, type: ${file.type}`);

        let fileToProcess = file;
        let heicConversionState: 'none' | 'success' | 'fallback' = 'none';
        let heicFallbackMime: string | null = null;

        // 检查是否是HEIC/HEIF格式 - 更强健的检测逻辑
        const fileName = file.name.toLowerCase();
        const fileType = file.type.toLowerCase();
        const isHeicByExtension = fileName.endsWith('.heic') || fileName.endsWith('.heif');
        const isHeicByMimeType = fileType === 'image/heic' || fileType === 'image/heif';
        // 很多浏览器对HEIC文件的MIME类型识别不准确，主要依靠文件扩展名
        const isHeic = isHeicByExtension || isHeicByMimeType;
        tauriDebugLog(`[HEIC detect] type: "${file.type}", name: "${file.name}", ext: ${isHeicByExtension}, mime: ${isHeicByMimeType}, result: ${isHeic}`);

        if (isHeic) {
            tauriDebugLog(`[HEIC] Detected HEIC image: ${file.name}, converting to JPG...`);
            tauriDebugLog(`[HEIC] File details:`, { name: file.name, size: file.size, type: file.type });
            try {
                const conversionResult = await heic2any({
                    blob: file,
                    toType: "image/jpeg",
                    quality: 0.9, // 适当提高质量以进行测试
                });

                if (!conversionResult) {
                    throw new Error('heic2any returned null or undefined');
                }

                const convertedBlob = Array.isArray(conversionResult) ? conversionResult[0] : conversionResult;
                
                if (!(convertedBlob instanceof Blob)) {
                    throw new Error(`Conversion result is not a valid Blob, actual type: ${typeof convertedBlob}`);
                }
                
                tauriDebugLog('[HEIC] Converted blob details:', { size: convertedBlob.size, type: convertedBlob.type });

                const newFileName = `${file.name.split('.').slice(0, -1).join('.') || file.name}.jpg`;
                fileToProcess = new File([convertedBlob], newFileName, { type: 'image/jpeg' });
                tauriDebugLog(`[HEIC] Conversion success: ${fileToProcess.name}, size: ${fileToProcess.size}, type: ${fileToProcess.type}`);
                tauriDebugLog(`[HEIC] Created new File object:`, fileToProcess);
                heicConversionState = 'success';

            } catch (error) {
                console.error(`[HEIC] Conversion failed:`, error);
                console.warn(`[HEIC] Fallback: using original image: ${file.name}`);
                tauriDebugLog(`[HEIC] Conversion error details:`, { 
                    message: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    errorObject: error
                });
                
                // Fallback: use original image and mark conversion as failed
                fileToProcess = file;
                heicConversionState = 'fallback';
                heicFallbackMime = (() => {
                    const normalized = file.type?.toLowerCase();
                    if (normalized && normalized.startsWith('image/')) {
                        return normalized;
                    }
                    if (fileName.endsWith('.heif')) {
                        return 'image/heif';
                    }
                    return 'image/heic';
                })();
                tauriDebugLog(`[HEIC] Fallback: using original image: ${file.name}`);
                
                // Send fallback notification to debug channel and user
                try {
                    tauriDebugLog(`[HEIC] Conversion failed, using original: ${file.name}`);
                    // Use unified notification system instead of window.alert
                    if (typeof window !== 'undefined') {
                        setTimeout(() => {
                            // Dispatch global event to avoid direct component dependency
                            window.dispatchEvent(new CustomEvent('showGlobalNotification', {
                                detail: {
                                    type: 'warning',
                                    message: t('utils.notifications.heic_fallback', { fileName: file.name }),
                                    title: t('utils.notifications.heic_compat_title')
                                }
                            }));
                        }, 100);
                    }
                } catch {}
                
                // 注意：此处不再reject，而是继续使用原文件进行base64转换
            }
        }

        const reader = new FileReader();
        reader.readAsDataURL(fileToProcess);
        reader.onload = () => {
            const result = reader.result as string;
            tauriDebugLog(`[Base64] DataURL prefix: ${result.substring(0, 50)}`);

            const commaIndex = result.indexOf(',');
            const base64Data = commaIndex >= 0 ? result.slice(commaIndex + 1) : result;
            const dataUrlPrefix = commaIndex >= 0 ? result.slice(0, commaIndex) : '';

            if (!base64Data || base64Data.length < 100) {
                console.error(`[Base64] Abnormal data: length=${base64Data?.length || 0}`);
                reject(new Error('Base64 data conversion failed or too short'));
                return;
            }

            tauriDebugLog(`[Base64] Conversion success, length: ${base64Data.length}`);
            if (heicConversionState === 'fallback') {
                const normalizedMime = (() => {
                    if (heicFallbackMime && heicFallbackMime.startsWith('image/')) {
                        return heicFallbackMime;
                    }
                    if (dataUrlPrefix.startsWith('data:image/')) {
                        const mimePart = dataUrlPrefix.substring('data:'.length);
                        const sepIndex = mimePart.indexOf(';');
                        return sepIndex >= 0 ? mimePart.substring(0, sepIndex) : mimePart;
                    }
                    return fileName.endsWith('.heif') ? 'image/heif' : 'image/heic';
                })();
                const safeMime = normalizedMime || 'image/heic';
                const dataUrl = `data:${safeMime};base64,${base64Data}`;
                tauriDebugLog(`[HEIC fallback] Returning as DataURL: ${dataUrl.substring(0, 48)}...`);
                resolve(dataUrl);
                return;
            }

            resolve(base64Data);
        };
        reader.onerror = error => {
            console.error(`[Base64] FileReader error:`, error);
            reject(error);
        };
    });
};

// 工具函数：批量转换文件为Base64
export const filesToBase64 = async (files: File[]): Promise<string[]> => {
  const promises = files.map(file => fileToBase64(file));
  return Promise.all(promises);
};

// Tauri API调用类
export class TauriAPI {
  // ★ irec 向量索引缓存已移除（灵感图谱废弃，2025-01 清理）
  /**
   * 统一搜索接口封装
   */
  // ★ 图谱模块已废弃 - SearchRequest 本地占位类型
  static async unifiedSearchCards(
    req: Record<string, unknown>,
    graphId: string = 'default'
  ): Promise<any> {
    try {
      const args: any = { ...req };
      if (args.learningMode && !args.learning_mode) args.learning_mode = args.learningMode;
      // 后端签名为 unified_search_cards(request: SearchRequest, ...)
      return await invoke('unified_search_cards', { ...withGraphId(graphId), request: args });
    } catch (error) {
      console.error('Unified search failed:', error);
      throw error;
    }
  }

  /**
   * 获取力导图数据（统一API）
   */
  static async unifiedGetForceGraphData(
    params: Partial<GraphQueryParams> = {},
    graphId: string = 'default'
  ): Promise<ForceGraphData> {
    const p: any = {
      include_cards: params.include_cards ?? true,
      include_orphans: params.include_orphans ?? false,
      max_depth: params.max_depth ?? null,
      root_tag_id: params.root_tag_id ?? null,
      tag_types: params.tag_types ?? null,
      card_limit: params.card_limit ?? null,
      min_confidence: params.min_confidence ?? null,
      node_ids: params.node_ids ?? null,
    };
    // 兼容 camel
    p.rootTagId = p.root_tag_id; p.tagTypes = p.tag_types; p.maxDepth = p.max_depth; p.includeCards = p.include_cards; p.cardLimit = p.card_limit; p.minConfidence = p.min_confidence; p.nodeIds = p.node_ids; p.includeOrphans = p.include_orphans;
    return invoke<ForceGraphData>('unified_get_force_graph_data', { ...withGraphId(graphId), params: p });
  }
  // 通用转发：允许组件通过 TauriAPI.invoke 调用任意后端命令（带调试埋点）
  static async invoke<T = any>(cmd: string, args?: any): Promise<T> {
    return await invokeWithDebug<T>(cmd, args);
  }
    /**
     * 读取文本文件内容
     */
    static async readFileAsText(path: string): Promise<string> {
      try {
        return await invoke<string>('read_file_text', { path });
      } catch (error) {
        console.error('Failed to read file:', error);
        throw new Error(`Failed to read file: ${error}`);
      }
    }

    /**
     * 复制文件到指定位置
     */
    static async copyFile(sourcePath: string, destPath: string): Promise<void> {
      try {
        // 统一走后端命令（同时传两种命名以兼容）
        await invoke<void>('copy_file', { sourcePath, destPath, source_path: sourcePath, dest_path: destPath });
      } catch (error) {
        console.error('Failed to copy file:', error);
        throw new Error(`Failed to copy file: ${error}`);
      }
    }

    /**
     * 读取二进制文件为 Uint8Array（跨平台，兼容移动端 content:// 等 URI）
     */
    static async readFileAsBytes(path: string): Promise<Uint8Array> {
      try {
        const bytes = await invoke<number[]>('read_file_bytes', { path });
        return new Uint8Array(bytes);
      } catch (error) {
        console.error('Failed to read binary file:', error);
        throw new Error(`Failed to read binary file: ${error}`);
      }
    }

    /** 获取文件大小（字节） */
    static async getFileSize(path: string): Promise<number> {
      try {
        const size = await invoke<number>('get_file_size', { path });
        return size ?? 0;
      } catch (error) {
        console.error('Failed to get file size:', error);
        return 0;
      }
    }

    /**
     * 将文件复制到应用私有目录下的 textbooks 目录，并返回目标路径。
     * - 桌面端：可直接返回源路径（可配置），但为一致性这里统一复制
     * - 移动端：必须复制或持久化；复制更稳定
     */
    static async copyIntoTextbooksDir(sourcePath: string): Promise<string> {
      const root = await this.getAppDataDir();
      const fileName = sourcePath.split(/[/\\]/).pop() || `textbook_${Date.now()}.pdf`;
      // 使用与 root 一致的路径分隔符，避免 Windows 上产生混合分隔符
      const sep = root.includes('\\') ? '\\' : '/';
      const destPath = [root, 'textbooks', fileName].join(sep);
      try {
        // copy_file 的写入端会自动创建父目录（后端 open_writer 中实现）
        await this.copyFile(sourcePath, destPath);
        return destPath;
      } catch (error) {
        console.error('Failed to copy to textbook directory:', error);
        throw new Error(`Failed to copy to textbook directory: ${getErrorMessage(error)}`);
      }
    }

    // ==================== Anki Library ====================
    static async listAnkiLibraryCards(
      params: ListAnkiCardsParams
    ): Promise<AnkiLibraryListResponse> {
      const request = {
        template_id: params?.template_id,
        search: params?.search,
        page: params?.page,
        page_size: params?.page_size,
      };
      return invoke<AnkiLibraryListResponse>('list_anki_library_cards', { request });
    }

    static async updateAnkiCard(request: {
      id: string;
      payload: {
        front?: string;
        back?: string;
        tags?: string[];
        fields?: Record<string, string>;
        messageStableId: string | null;
      };
    }): Promise<void> {
      const { id, payload } = request;
      const fields = { ...(payload.fields ?? {}) };
      const resolvedFront = payload.front ?? fields.Front ?? '';
      const resolvedBack = payload.back ?? fields.Back ?? '';
      const tags = Array.isArray(payload.tags) ? [...payload.tags] : [];
      const cardPayload = {
        id,
        front: resolvedFront,
        back: resolvedBack,
        tags,
        fields: {
          ...fields,
          Front: resolvedFront,
          Back: resolvedBack,
        },
        extra_fields: {
          ...fields,
          messageStableId: payload.messageStableId ?? null,
        },
      };
      await invoke<void>('update_anki_card', { card: cardPayload });
    }

    static async deleteAnkiCard(cardId: string): Promise<boolean> {
      return invoke<boolean>('delete_anki_card', { card_id: cardId });
    }

    static async exportAnkiCards(options: {
      ids: string[];
      format?: 'apkg' | 'json';
      deckName?: string;
      noteType?: string;
      templateId?: string | null;
    }): Promise<ExportAnkiCardsResult> {
      const request = {
        ids: options.ids,
        format: options.format ?? 'apkg',
        deck_name: options.deckName,
        note_type: options.noteType,
        template_id: options.templateId ?? undefined,
      };
      return invoke<ExportAnkiCardsResult>('export_anki_cards', { request });
    }

  // ==================== 教材库（独立数据库） ====================
  static async textbooksAdd(filePaths: string[]): Promise<Array<{ id: string; name: string; path: string; size: number; addedAt: string }>> {
    const raw = await invoke<any>('textbooks_add', { sources: filePaths });
    const list = Array.isArray(raw) ? raw : [];
    const results = list.map((r: any) => ({
      id: r.id,
      name: r.file_name,
      path: r.file_path,
      size: typeof r.size === 'number' ? r.size : (typeof r.size === 'string' ? Number(r.size) : 0),
      addedAt: r.created_at || r.updated_at || new Date().toISOString(),
    }));

    // 🆕 教材导入后自动触发多模态索引（异步执行，不阻塞主流程）
    // ★ 多模态索引已禁用，跳过自动索引。恢复 MULTIMODAL_INDEX_ENABLED = true 后取消注释即可
    // for (const textbook of results) {
    //   (async () => {
    //     try {
    //       const { multimodalRagService } = await import('@/services/multimodalRagService');
    //       const configured = await multimodalRagService.isConfigured();
    //       if (!configured) {
    //         return;
    //       }
    //       const indexResult = await multimodalRagService.indexTextbook(textbook.id);
    //     } catch (indexError) {
    //       // 静默失败，不影响主流程
    //       console.warn('[TauriApi] Auto-indexing textbook failed:', indexError);
    //     }
    //   })();
    // }

    return results;
  }

  // ==================== 错题库管理API（已废弃 2026-01）====================
  // ★ 保留存根方法以避免编译错误，实际功能已移除
  // ★ 2026-02-08 清理：analyzeNewMistake 已删除（App.tsx 中仅赋值未调用）。
  //   以下 3 个方法仍有活跃调用方，待迁移后一并删除：
  //   - getMistakeDetails: dev test panels (ChatSaveTestPanel, chat-save-tests)
  //   - updateMistake: saveRequestHandler.ts
  //   - runtimeAutosaveCommit: saveRequestHandler.ts

  /**
   * @deprecated 2026-01 清理：错题功能已废弃。仍有 11 处调用（useLinkedMistakeEntries / mistakeReferencePlugin / debug-panel / chat-save-tests 等）。
   * TODO: 迁移上述调用方后删除此方法。
   */
  static async getMistakeDetails(_id: string): Promise<MistakeItem | null> {
    console.warn('[DEPRECATED] getMistakeDetails is deprecated, migrate callers (2026-01 cleanup)');
    return null;
  }

  /**
   * @deprecated 2026-01 清理：错题功能已废弃。仍有 3 处调用（saveRequestHandler / ChatSaveTestPlugin / ChatSaveTestPanel）。
   * TODO: 迁移上述调用方后删除此方法。
   */
  static async updateMistake(item: MistakeItem): Promise<MistakeItem> {
    console.warn('[DEPRECATED] updateMistake is deprecated, migrate callers (2026-01 cleanup)');
    return item;
  }

  /**
   * @deprecated 2026-01 清理：错题功能已废弃。仍有 2 处调用（saveRequestHandler / FirstRoundFlowMonitor）。
   * TODO: 迁移上述调用方后删除此方法。
   */
  static async runtimeAutosaveCommit(_params: unknown): Promise<{
    success: boolean;
    mistakeId?: string | null;
    finalMistakeItem?: MistakeItem;
    reason?: string | null;
  }> {
    console.warn('[DEPRECATED] runtimeAutosaveCommit is deprecated, migrate callers (2026-01 cleanup)');
    return { success: true, reason: 'deprecated' };
  }

  // ========== Enhanced Chat Search APIs ==========
  static async rebuildChatFts(): Promise<number> {
    try {
      console.info('[TauriAPI] rebuildChatFts start');
      const res = await invoke<number>('rebuild_chat_fts');
      console.info('[TauriAPI] rebuildChatFts done', { inserted: res });
      return res || 0;
    } catch (e) {
      console.error('[TauriAPI] rebuildChatFts error', e);
      throw e;
    }
  }

  /**
   * 回填用户消息嵌入向量
   * TODO: 需要在后端实现 backfill_user_message_embeddings 命令
   */
  static async backfillUserMessageEmbeddings(_params: Record<string, unknown>): Promise<number> {
    try {
      console.info('[TauriAPI] backfillUserMessageEmbeddings start');
      // 暂时返回 0，后端命令尚未实现
      console.warn('[TauriAPI] backfillUserMessageEmbeddings: backend command not yet implemented');
      return 0;
    } catch (e) {
      console.error('[TauriAPI] backfillUserMessageEmbeddings error', e);
      throw e;
    }
  }

  static async searchChatFulltext(params: { query: string; role?: 'user'|'assistant'; limit?: number }): Promise<Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>> {
    const { query, role, limit } = params;
    try {
      console.info('[TauriAPI] searchChatFulltext start', { role, limit, query });
      const r = await invoke<Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>>('search_chat_fulltext', { request: { query, role: role || null, limit: typeof limit === 'number' ? limit : null } });
      console.info('[TauriAPI] searchChatFulltext done', { count: r?.length || 0, sample: (r || []).slice(0, 3) });
      return r;
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('[TauriAPI] searchChatFulltext error', { error: message, raw: error });
      throw new Error(message);
    }
  }

  static async searchChatBasic(params: { query: string; role?: 'user'|'assistant'; limit?: number }): Promise<Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>> {
    const { query, role, limit } = params;
    try {
      console.info('[TauriAPI] searchChatBasic start', { role, limit, query });
      const r = await invoke<Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>>('search_chat_basic', { request: { query, role: role || null, limit: typeof limit === 'number' ? limit : null } });
      console.info('[TauriAPI] searchChatBasic done', { count: r?.length || 0, sample: (r || []).slice(0, 3) });
      return r;
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('[TauriAPI] searchChatBasic error', { error: message, raw: error });
      throw new Error(message);
    }
  }

  static async searchChatSemantic(params: { query: string; topK?: number; ftsPrefilter?: boolean }): Promise<Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>> {
    const { query, topK, ftsPrefilter } = params;
    try {
      console.info('[TauriAPI] searchChatSemantic start', { topK, ftsPrefilter, query });
      const r = await invoke<Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>>('search_user_messages_semantic', {
        request: {
          query_text: query,
          top_k: typeof topK === 'number' ? topK : null,
          fts_prefilter: typeof ftsPrefilter === 'boolean' ? ftsPrefilter : null,
        },
      });
      console.info('[TauriAPI] searchChatSemantic done', { count: r?.length || 0 });
      return r;
    } catch (e) {
      console.error('[TauriAPI] searchChatSemantic error', { e });
      throw e;
    }
  }

  static async searchChatCombined(params: { query: string; top_k?: number }): Promise<{ fts: Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>, semantic: Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}> }> {
    const { query, top_k } = params;
    try {
      console.info('[TauriAPI] searchChatCombined start', { top_k, query });
      const r = await invoke<{ fts: Array<any>, semantic: Array<any> }>('search_chat_combined', { request: { query, top_k: typeof top_k === 'number' ? top_k : null } });
      console.info('[TauriAPI] searchChatCombined done', { fts: r?.fts?.length || 0, sem: r?.semantic?.length || 0, ftsSample: r?.fts?.slice(0,3), semSample: r?.semantic?.slice(0,3) });
      return r;
    } catch (e) {
      console.error('[TauriAPI] searchChatCombined error', { e });
      throw e;
    }
  }

  static async getChatIndexStats(): Promise<{ total_fts: number; total_vectors: number; missing_user_embeddings: number }>{
    try {
      // 降低日志噪声：移除高频 info，改为调试级别
      await debugLogger.log('DEBUG', 'TAURI_API', 'getChatIndexStats.start', {});
      const s = await invoke<{ total_fts: number; total_vectors: number; missing_user_embeddings: number }>('get_chat_index_stats', { request: {} });
      await debugLogger.log('DEBUG', 'TAURI_API', 'getChatIndexStats.done', { stats: s });
      return s;
    } catch (e) {
      console.error('[TauriAPI] getChatIndexStats error', { e });
      throw e;
    }
  }

  // ========== Research Reports ==========
  static async researchListReports(params?: { limit?: number }): Promise<Array<{id:string; created_at:string; segments:number; context_window:number}>> {
    const limit = typeof params?.limit === 'number' ? params!.limit : null;
    return await invoke('research_list_reports', { request: { limit } });
  }

  static async researchGetReport(id: string): Promise<{ id:string; created_at:string; segments:number; context_window:number; report:string; metadata?: any }>{
    return await invoke('research_get_report', { id });
  }

  static async researchDeleteReport(id: string): Promise<boolean> {
    return await invoke('research_delete_report', { id });
  }

  static async researchExportAllReportsZip(params: { format: 'md'|'json'; path: string }): Promise<string> {
    const { format, path } = params;
    return await invoke('research_export_all_reports_zip', { request: { format, path } });
  }

  // ★ 2026-01 清理：continueMistakeChat 和 continueMistakeChatStream 已删除（错题功能废弃）
  static async saveSetting(key: string, value: string): Promise<void> {
    try {
      if (!isTauriRuntime) {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem(key, value);
        }
        return;
      }
      await invoke<void>('save_setting', { key, value });
    } catch (error) {
      console.error('Failed to save setting:', error);
      throw new Error(`Failed to save setting: ${error}`);
    }
  }

  static async getSetting(key: string): Promise<string | null> {
    try {
      if (!isTauriRuntime) {
        return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      }
      const response = await invoke<string | null>('get_setting', { key });
      return response;
    } catch (error) {
      console.error('Failed to get setting:', error);
      // 仅在 Tauri 运行时不可用时回退到 localStorage
      const fallback = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
      return fallback;
    }
  }

  static async deleteSetting(key: string): Promise<void> {
    try {
      if (!isTauriRuntime) {
        if (typeof localStorage !== 'undefined') {
          localStorage.removeItem(key);
        }
        return;
      }
      await invoke<boolean>('delete_setting', { key });
    } catch (error) {
      console.error('Failed to delete setting:', error);
      // 仅在 Tauri 运行时不可用时回退到 localStorage
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem(key);
      }
    }
  }

  // MCP helpers
  static async testMcpConnection(command: string, args: string[], env?: Record<string, string>, options?: { cwd?: string | null; framing?: 'jsonl' | 'content_length' | null }): Promise<any> {
    try {
      const response = await invoke<any>('test_mcp_connection', {
        command,
        args,
        env,
        cwd: options?.cwd ?? null,
        framing: options?.framing ?? null,
      });
      return response;
    } catch (error) {
      console.error('Failed to test MCP connection:', error);
      throw new Error(`Failed to test MCP connection: ${error}`);
    }
  }

  // Deep Research APIs removed

  

  

  

  

  

  

  

  static async researchGetRound(sessionId: string, roundNo: number): Promise<any> {
    return await invoke('research_get_round', { ...withSessionId(sessionId), round_no: roundNo, roundNo });
  }
  static async researchGetRoundVisualSummary(sessionId: string, roundNo: number): Promise<any> {
    return await invoke('research_get_round_visual_summary', { ...withSessionId(sessionId), round_no: roundNo, roundNo });
  }
  static async researchDeleteRound(sessionId: string, roundNo: number, cleanCoverage?: boolean): Promise<string> {
    return await invoke('research_delete_round', { ...withSessionId(sessionId), round_no: roundNo, roundNo, clean_coverage: !!cleanCoverage });
  }
  static async researchGenerateRoundReport(sessionId: string, roundNo: number, format?: string, options?: { include_plan?: boolean; include_summary?: boolean; include_citations?: boolean; include_metrics?: boolean; include_subagents?: boolean }): Promise<string> {
    const opts_json = options ? JSON.stringify(options) : null;
    return await invoke('research_generate_round_report', { ...withSessionId(sessionId), round_no: roundNo, roundNo, format: format || null, opts_json, optsJson: opts_json });
  }
  static async researchSetRoundNote(sessionId: string, roundNo: number, note: string, tags?: string[]): Promise<string> {
    return await invoke('research_set_round_note', { ...withSessionId(sessionId), round_no: roundNo, roundNo, note, tags: tags || null });
  }
  static async researchGetRoundNote(sessionId: string, roundNo: number): Promise<{ note?: string; tags?: string[] }> {
    return await invoke('research_get_round_note', { ...withSessionId(sessionId), round_no: roundNo, roundNo });
  }
  static async researchGetRoundNotes(sessionId: string): Promise<{ items: Array<{ round_no: number; note?: string; tags?: string[] }> }> {
    return await invoke('research_get_round_notes', { ...withSessionId(sessionId) });
  }
  static async researchGenerateSessionReport(sessionId: string, format?: string, options?: { include_plan?: boolean; include_summary?: boolean; include_citations?: boolean; include_metrics?: boolean; include_subagents?: boolean }, rounds?: number[]): Promise<string> {
    const opts_json = options ? JSON.stringify(options) : null;
    return await invoke('research_generate_session_report', { ...withSessionId(sessionId), format: format || null, opts_json, optsJson: opts_json, rounds: Array.isArray(rounds) ? rounds : null });
  }
  

  static async researchGetChunkText(documentId: string, chunkIndex: number, sessionId: string): Promise<string | null> {
    const res = await invoke<{ text: string | null }>('research_get_chunk_text', { ...withSessionId(sessionId), document_id: documentId, documentId, chunk_index: chunkIndex, chunkIndex });
    return res?.text ?? null;
  }

  static async researchGetChunkContext(documentId: string, chunkIndex: number, before: number, after: number, sessionId: string): Promise<Array<{chunk_index: number; text: string}>> {
    const res = await invoke<{ items: Array<{chunk_index: number; text: string}> }>('research_get_chunk_context', { ...withSessionId(sessionId), document_id: documentId, documentId, chunk_index: chunkIndex, chunkIndex, before, after });
    return res?.items || [];
  }

  static async researchUpdateSessionOptions(sessionId: string, options: Record<string, any>): Promise<string> {
    const options_json = JSON.stringify(options || {});
    return await invoke('research_update_session_options', { req: { ...withSessionId(sessionId), options_json, optionsJson: options_json } });
  }

  static async researchDeleteSession(sessionId: string): Promise<string> {
    // Some Tauri bindings may expect camelCase keys in generated bridges.
    // Send both to be robust across environments; extra keys are ignored.
    return await invoke('research_delete_session', { session_id: sessionId, sessionId });
  }

  // Utilities
  static async saveTextToFile(path: string, content: string): Promise<void> {
    await invoke('save_text_to_file', { path, content });
  }

  static async researchRunUntil(sessionId: string, maxRounds?: number, minSelected?: number, silentApproval?: boolean): Promise<string> {
    return await invoke('research_run_until', { 
      ...withSessionId(sessionId), 
      max_rounds: maxRounds, maxRounds,
      min_selected: minSelected, minSelected,
      silent_approval: typeof silentApproval === 'boolean' ? silentApproval : null,
      silentApproval: typeof silentApproval === 'boolean' ? silentApproval : null
    });
  }

  static async readFileText(path: string): Promise<string> {
    return await invoke<string>('read_file_text', { path });
  }

  static async researchRunMacroRound(sessionId: string, keywords?: string[]): Promise<string> {
    return await invoke('research_run_macro', { ...withSessionId(sessionId), keywords: keywords || null });
  }

  static async researchRunToFullCoverage(sessionId: string): Promise<string> {
    return await invoke('research_run_to_full_coverage', withSessionId(sessionId));
  }

  // Agent tool commands exposure
  static async researchAuditUserQuestions(params: { date_range?: [string, string]; keywords?: string[]; group_by?: 'topic'|'day'|'week'; limit?: number }): Promise<any> {
    const { date_range, keywords, group_by, limit } = params;
    return await invoke('research_audit_user_questions', { date_range: date_range || null, dateRange: date_range || null, keywords: keywords || null, group_by: group_by || null, groupBy: group_by || null, limit: typeof limit === 'number' ? limit : null });
  }

  static async researchFindSimilarQuestions(questionText: string, topK: number = 8): Promise<any> {
    return await invoke('research_find_similar_questions', { question_text: questionText, questionText, top_k: topK, topK });
  }

  static async researchGetFullChatHistory(documentId?: string, messageId?: string): Promise<any> {
    return await invoke('research_get_full_chat_history', { document_id: documentId || null, documentId: documentId || null, message_id: messageId || null, messageId: messageId || null });
  }

  static async researchDeepReadByDocs(sessionId: string, documentIds: string[], contextThreshold?: number): Promise<string> {
    return await invoke('research_deep_read_by_docs', { ...withSessionId(sessionId), document_ids: documentIds, documentIds, context_threshold: contextThreshold || null, contextThreshold: contextThreshold || null });
  }

  static async researchDeepReadByTag(sessionId: string, tag: string, contextThreshold?: number): Promise<string> {
    return await invoke('research_deep_read_by_tag', { ...withSessionId(sessionId), tag, context_threshold: contextThreshold || null, contextThreshold: contextThreshold || null });
  }

  // Precise token utilities (model-aware); fallbacks handled by backend
  static async researchCountTokensPrecise(documentIds: string[]): Promise<{ total_tokens: number; per_document: Array<{document_id: string; tokens: number}> }> {
    return await invoke('research_count_tokens', { document_ids: documentIds, documentIds, precise: true });
  }

  static async researchGetFullContentPrecise(documentIds: string[]): Promise<{ items: Array<{document_id: string; content: string; tokens_estimate: number}> }> {
    return await invoke('research_get_full_content', { document_ids: documentIds, documentIds, precise: true });
  }

  // Research settings (scoped helpers)
  static async researchGetSetting(key: string): Promise<string | null> {
    return await invoke('research_get_setting', { key });
  }
  static async researchSetSetting(key: string, value: string): Promise<string> {
    return await invoke('research_set_setting', { key, value });
  }
  static async researchDeleteSetting(key: string): Promise<string> {
    return await invoke('research_delete_setting', { key });
  }

  static async researchListArtifacts(sessionId: string, roundNo?: number): Promise<{items: Array<{id:number;round_no:number;agent:string;artifact_type:string;payload_json:string;size:number;created_at:string}>}> {
    return await invoke('research_list_artifacts', { ...withSessionId(sessionId), round_no: typeof roundNo === 'number' ? roundNo : null, roundNo: typeof roundNo === 'number' ? roundNo : null });
  }

  static async testMcpWebsocket(url: string, env?: Record<string, string>): Promise<any> {
    try {
      const response = await invoke<any>('test_mcp_websocket', { url, env });
      return response;
    } catch (error) {
      console.error('Failed to test MCP WebSocket connection:', error);
      throw new Error(`Failed to test MCP WebSocket connection: ${error}`);
    }
  }

  static async testMcpSse(endpoint: string, apiKey: string, env?: Record<string, string>): Promise<any> {
    try {
      const response = await invoke<any>('test_mcp_sse', { endpoint, apiKey, env });
      return response;
    } catch (error) {
      console.error('Failed to test MCP SSE connection:', error);
      throw new Error(`Failed to test MCP SSE connection: ${error}`);
    }
  }

  static async testMcpHttp(endpoint: string, apiKey: string, env?: Record<string, string>): Promise<any> {
    try {
      const response = await invoke<any>('test_mcp_http', { endpoint, apiKey, env });
      return response;
    } catch (error) {
      console.error('Failed to test MCP HTTP connection:', error);
      throw new Error(`Failed to test MCP HTTP connection: ${error}`);
    }
  }

  static async testMcpModelScope(serverId: string, apiKey: string, region: string, hosted: boolean): Promise<any> {
    try {
      const response = await invoke<any>('test_mcp_modelscope', { serverId, apiKey, region, hosted });
      return response;
    } catch (error) {
      console.error('Failed to test MCP ModelScope connection:', error);
      throw new Error(`Failed to test MCP ModelScope connection: ${error}`);
    }
  }

  static async reloadMcpClient(): Promise<{ success: boolean; message?: string; error?: string }> {
    try {
      const response = await invoke<{ success: boolean; message?: string; error?: string }>('reload_mcp_client');
      return response;
    } catch (error) {
      console.error('Failed to reload MCP client:', error);
      throw new Error(`Failed to reload MCP client: ${error}`);
    }
  }

  // 外部搜索连通性测试
  static async testWebSearchConnectivity(engine?: string): Promise<any> {
    try {
      const response = await invoke<any>('test_web_search_connectivity', { engine: engine || null });
      return response;
    } catch (error) {
      console.error('Failed to test external search connection:', error);
      throw new Error(`Failed to test external search connection: ${error}`);
    }
  }

  // MCP 状态与工具
  static async getMcpStatus(): Promise<any> {
    try {
      return await invoke<any>('get_mcp_status');
    } catch (error) {
      console.error('Failed to get MCP status:', error);
      throw new Error(`Failed to get MCP status: ${error}`);
    }
  }

  static async getMcpTools(): Promise<Array<{ name: string; description?: string; input_schema: any }>> {
    try {
      return await invoke<Array<{ name: string; description?: string; input_schema: any }>>('get_mcp_tools');
    } catch (error) {
      console.error('Failed to get MCP tools:', error);
      throw new Error(`Failed to get MCP tools: ${error}`);
    }
  }

  static async testAllSearchEngines(): Promise<{
    results: Record<string, {
      name: string;
      status: 'success' | 'failed' | 'not_configured';
      message: string;
      elapsed_ms: number;
      results_count?: number;
    }>;
    summary: {
      total: number;
      configured: number;
      success: number;
      failed: number;
    };
    timestamp: string;
  }> {
    try {
      return await invoke('test_all_search_engines');
    } catch (error) {
      console.error('Search engine health check failed:', error);
      throw new Error(`Search engine health check failed: ${error}`);
    }
  }

  static async testApiConnection(apiKey: string, apiBase: string, model?: string): Promise<boolean> {
    try {
      const response = await invoke<boolean>('test_api_connection', {
        api_key: apiKey,
        api_base: apiBase,
        model: model || null,
      });
      return response;
    } catch (error) {
      console.error('Failed to test API connection:', error);
      throw new Error(`Failed to test API connection: ${error}`);
    }
  }

  // 统计信息API
  static async getStatistics(): Promise<any> {
    try {
      const response = await invoke<any>('get_statistics');
      return response;
    } catch (error) {
      console.error('Failed to get statistics:', error);
      throw new Error(`Failed to get statistics: ${error}`);
    }
  }

  // 获取增强版统计信息（包含所有模块）
  static async getEnhancedStatistics(): Promise<any> {
    try {
      const response = await invoke<any>('get_enhanced_statistics');
      return response;
    } catch (error) {
      console.error('Failed to get enhanced statistics:', error);
      // 降级到基础统计
      return this.getStatistics();
    }
  }

  // 文档31清理：getSupportedSubjects 已彻底删除

  // 文件管理API
  static async getImageAsBase64(relativePath: string): Promise<string> {
    try {
      // 1) 优先尝试 camelCase 参数
      try {
        const response = await invoke<string>('get_image_as_base64', { relativePath });
        return response;
      } catch (e1) {
        // 2) 回退 snake_case 参数
        try {
          const response = await invoke<string>('get_image_as_base64', { relative_path: relativePath });
          return response;
        } catch (e2) {
          // 3) 最后兜底：前端通过 convertFileSrc + fetch 读取文件
          try {
            const { convertFileSrc } = await import('@tauri-apps/api/core');
            const assetUrl = convertFileSrc(relativePath);
            const resp = await fetch(assetUrl);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const blob = await resp.blob();
            const arr = await blob.arrayBuffer();
            const base64 = btoa(String.fromCharCode(...new Uint8Array(arr)));
            return base64;
          } catch (e3) {
            throw e2; // 抛出原始 Tauri 错误，方便定位命令问题
          }
        }
      }
    } catch (error) {
      console.error('Failed to get image as base64:', error);
      throw new Error(`Failed to get image: ${error}`);
    }
  }

  static async saveImageFromBase64(base64Data: string, originalPath: string): Promise<string> {
    try {
      // 从原路径中提取文件名，兼容不同操作系统的路径分隔符
      const pathSeparators = /[\/\\]/;
      const pathParts = originalPath.split(pathSeparators);
      let fileName = pathParts[pathParts.length - 1];
      
      // 如果文件名为空或无效，生成一个新的文件名
      if (!fileName || fileName.trim() === '') {
        const timestamp = new Date().getTime();
        const randomStr = Math.random().toString(36).substring(2, 8);
        fileName = `image_${timestamp}_${randomStr}.png`;
      }
      
      // 验证 base64 数据格式
      if (!base64Data || base64Data.trim() === '') {
        throw new Error('Base64 data is empty');
      }
      
      const response = await invoke<string>('save_image_from_base64_path', { 
        // 双写兼容：后端为 snake_case
        base64_data: base64Data,
        base64Data: base64Data,
        file_name: fileName,
        fileName: fileName
      });
      return response;
    } catch (error) {
      console.error('Failed to save image from base64:', error);
      throw new Error(`Failed to save image: ${error}`);
    }
  }

  static async cleanupOrphanedImages(): Promise<string[]> {
    try {
      const response = await invoke<string[]>('cleanup_orphaned_images');
      return response;
    } catch (error) {
      console.error('Failed to cleanup orphaned images:', error);
      throw new Error(`Failed to cleanup orphaned images: ${error}`);
    }
  }

  // API配置管理API
  static async getApiConfigurations(): Promise<ApiConfig[]> {
    try {
      const response = await invoke<ApiConfig[]>('get_api_configurations');
      return response;
    } catch (error) {
      console.error('Failed to get API configurations:', error);
      throw new Error(`Failed to get API configurations: ${error}`);
    }
  }

  static async saveApiConfigurations(configs: ApiConfig[]): Promise<void> {
    try {
      const filtered = (configs || []).filter((cfg: any) => {
        const isBuiltin = cfg?.isBuiltin ?? cfg?.is_builtin ?? false;
        return !isBuiltin;
      });
      await invoke<void>('save_api_configurations', { configs: filtered });
    } catch (error) {
      console.error('Failed to save API configurations:', error);
      throw new Error(`Failed to save API configurations: ${error}`);
    }
  }

  static async getVendorConfigs(): Promise<VendorConfig[]> {
    try {
      return await invoke<VendorConfig[]>('get_vendor_configs');
    } catch (error) {
      console.error('Failed to get vendor configs:', error);
      throw new Error(`Failed to get vendor configs: ${error}`);
    }
  }

  static async saveVendorConfigs(configs: VendorConfig[]): Promise<void> {
    try {
      await invoke<void>('save_vendor_configs', { configs });
    } catch (error) {
      console.error('Failed to save vendor configs:', error);
      throw new Error(`Failed to save vendor configs: ${error}`);
    }
  }

  static async getModelProfiles(): Promise<ModelProfile[]> {
    try {
      return await invoke<ModelProfile[]>('get_model_profiles');
    } catch (error) {
      console.error('Failed to get model profiles:', error);
      throw new Error(`Failed to get model profiles: ${error}`);
    }
  }

  static async saveModelProfiles(profiles: ModelProfile[]): Promise<void> {
    try {
      await invoke<void>('save_model_profiles', { profiles });
    } catch (error) {
      console.error('Failed to save model profiles:', error);
      throw new Error(`Failed to save model profiles: ${error}`);
    }
  }

  static async getModelAssignments(): Promise<any> {
    try {
      const response = await invoke<any>('get_model_assignments');
      return response;
    } catch (error) {
      console.error('Failed to get model assignments:', error);
      throw new Error(`Failed to get model assignments: ${error}`);
    }
  }

  static async saveModelAssignments(assignments: any): Promise<void> {
    try {
      await invoke<void>('save_model_assignments', { assignments });
    } catch (error) {
      console.error('Failed to save model assignments:', error);
      throw new Error(`Failed to save model assignments: ${error}`);
    }
  }

  // 科目配置管理API已废弃
  // ★ 2026-01 清理：批量错题操作 API 已删除

  // ★ 文档31清理：ensureMemoryLibraryForSubject 已删除
  // ★ 文档31清理：upsertMemoryEntry 已删除

  // 用户记忆：从聊天记录提取记忆候选
  // ★ 2026-01 清理：移除 mistake_id 参数，统一使用 conversation_id
  static async extractMemoriesFromChat(params: {
    conversation_id: string;
    chat_history: any[];
  }): Promise<{ success: boolean; candidates: Array<{ content: string; category: string }>; error_message?: string }> {
    try {
      const effectiveConversationId = params.conversation_id;
      if (!effectiveConversationId || typeof effectiveConversationId !== 'string' || effectiveConversationId.trim().length === 0) {
        throw new Error('Missing valid conversation_id');
      }

      // 规范化历史记录，确保格式符合后端期望
      const normalizedHistory = normalizeHistoryForBackend(params.chat_history || []).map((msg: any) => {
        // 确保 timestamp 是 ISO 字符串格式
        const timestamp = msg.timestamp || msg.created_at || new Date().toISOString();
        // 确保 content 是字符串
        const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '');
        
        // 构建符合后端 ChatMessage 结构的对象
        const result: any = {
          role: msg.role || 'user',
          content: content,
          timestamp: timestamp,
        };
        
        // 只添加存在的可选字段
        if (msg.thinking_content) result.thinking_content = msg.thinking_content;
        if (Array.isArray(msg.rag_sources) && msg.rag_sources.length > 0) result.rag_sources = msg.rag_sources;
        if (Array.isArray(msg.memory_sources) && msg.memory_sources.length > 0) result.memory_sources = msg.memory_sources;
        if (Array.isArray(msg.graph_sources) && msg.graph_sources.length > 0) result.graph_sources = msg.graph_sources;
        if (Array.isArray(msg.web_search_sources) && msg.web_search_sources.length > 0) result.web_search_sources = msg.web_search_sources;
        if (Array.isArray(msg.image_paths) && msg.image_paths.length > 0) result.image_paths = msg.image_paths;
        if (Array.isArray(msg.image_base64) && msg.image_base64.length > 0) result.image_base64 = msg.image_base64;
        if (Array.isArray(msg.doc_attachments) && msg.doc_attachments.length > 0) result.doc_attachments = msg.doc_attachments;
        
        return result;
      });

      const response = await invoke<{
        success: boolean;
        candidates: Array<{ content: string; category: string }>;
        error_message?: string;
      }>('extract_memories_from_chat', {
        request: {
          mistake_id: effectiveConversationId,
          chat_history: normalizedHistory,
        },
      });
      return response;
    } catch (error) {
      console.error('Failed to extract memory candidates:', error);
      throw new Error(`Failed to extract memory candidates: ${getErrorMessage(error)}`);
    }
  }

  // 用户记忆：查询待处理的记忆候选（用于恢复后台提取结果）
  // ★ 文档31清理：移除 subject 字段
  static async getPendingMemoryCandidates(conversationId: string): Promise<{
    conversation_id: string;
    candidates: Array<{ content: string; category: string }>;
    created_at: string;
  } | null> {
    try {
      const response = await invoke<{
        conversation_id: string;
        candidates: Array<{ content: string; category: string }>;
        created_at: string;
      } | null>('get_pending_memory_candidates', {
        conversationId: conversationId,
      });
      return response;
    } catch (error) {
      console.error('Failed to query pending memory candidates:', error);
      return null;
    }
  }

  // 用户记忆：清除/忽略待处理的记忆候选
  static async dismissPendingMemoryCandidates(conversationId: string): Promise<number> {
    try {
      const response = await invoke<number>('dismiss_pending_memory_candidates', {
        conversationId: conversationId,
      });
      return response;
    } catch (error) {
      console.error('Failed to dismiss pending memory candidates:', error);
      return 0;
    }
  }

  // 用户记忆：标记待处理记忆候选为已保存
  static async markPendingMemoryCandidatesSaved(conversationId: string): Promise<number> {
    try {
      const response = await invoke<number>('mark_pending_memory_candidates_saved', {
        conversationId: conversationId,
      });
      return response;
    } catch (error) {
      console.error('Failed to mark pending memory candidates as saved:', error);
      return 0;
    }
  }

  // ★ 文档31清理：移除 subject 参数，改用 graphId
  static async graphRecallTest(params: {
    graphId?: string;
    query: string;
    topK?: number;
    dynamic?: boolean;
  }): Promise<GraphRecallTestResult> {
    try {
      const response = await invoke<GraphRecallTestResult>('graph_recall_test', {
        graph_id: params.graphId,
        query: params.query,
        top_k: params.topK,
        dynamic: params.dynamic,
      });
      return response;
    } catch (error) {
      const message = getErrorMessage(error);
      console.error('Graph recall test failed:', message, error);
      throw new Error(`Graph recall test failed: ${message}`);
    }
  }

  // ★ 文档31清理：backfillMemoryForSubject 已删除

  // ★ 2026-01 清理：appendMistakeChatMessages, deleteChatTurn, deleteChatTurnDetail, repairUnpairedTurns 已删除（错题功能废弃）

  /**
   * 聊天追问（复用错题分析的追问模式）
   */
  static async continueReviewChatStream(params: {
    reviewId: string;
    chatHistory: ChatMessage[];
    enableChainOfThought: boolean;
    enableRag?: boolean;
    ragTopK?: number;
    // 覆盖参数（可选）
    temperature?: number;
    model2_override_id?: string;
    // 选择的RAG分库（可选）
    libraryIds?: string[];
  }): Promise<void> {
    try {
      
        const normalizedHistory = normalizeHistoryForBackend(params.chatHistory as any);
        const nowIso = new Date().toISOString();
        const historyForUnified = (normalizedHistory || []).map((m: any, idx: number) => {
          const stableId = m.persistent_stable_id || m._stableId || m.id || `${m.role}-${idx}-${Date.now()}`;
          const rawMeta = (m as any)._meta ?? (m as any).metadata;
          let metadata: any = undefined;
          if (rawMeta !== undefined) {
            try {
              metadata = JSON.parse(JSON.stringify(rawMeta));
            } catch {
              metadata = rawMeta;
            }
          }
          return {
            id: stableId,
            persistent_stable_id: stableId,
            role: m.role,
            content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
            timestamp: m.timestamp || nowIso,
            image_base64: m.image_base64 || undefined,
            doc_attachments: Array.isArray(m.doc_attachments) ? m.doc_attachments.map((d: any) => ({
              name: d.name || `doc_${idx}`,
              mime_type: d.mime_type || 'text/plain',
              size_bytes: typeof d.size_bytes === 'number' ? d.size_bytes : (d.content?.length || d.text_content?.length || 0),
              text_content: d.text_content || (typeof d.content === 'string' ? d.content : undefined),
              base64_content: d.base64_content,
            })) : undefined,
            rag_sources: (m as any).rag_sources || undefined,
            memory_sources: (m as any).memory_sources || undefined,
            tool_call: (m as any).tool_call || undefined,
            tool_result: (m as any).tool_result || undefined,
            metadata,
            overrides: undefined,
            relations: undefined,
          };
        });
        const lastUserIdx = [...historyForUnified].reverse().findIndex((m) => m.role === 'user');
        const lastUserMessageId = lastUserIdx >= 0 ? historyForUnified[historyForUnified.length - 1 - lastUserIdx].id : `last-user-${Date.now()}`;
        // ★ 文梣31清理：移除 subject 概念
        const unifiedPayload: any = {
          conversation: { id: params.reviewId, type: 'review' },
          history: historyForUnified,
          target: { last_user_message_id: lastUserMessageId },
          options: {
            overrides: {
              temperature: typeof params.temperature === 'number' ? params.temperature : undefined,
              model_override_id: params.model2_override_id,
              rag_options: params.enableRag ? { top_k: params.ragTopK || 5, enable_reranking: undefined } : undefined,
              library_ids: params.libraryIds,
            },
          },
        };
        await invoke('continue_unified_chat_stream', { request: unifiedPayload });
        
    } catch (error) {
      console.error('Chat follow-up failed:', error);
      throw new Error(`Chat follow-up failed: ${error}`);
    }
  }

  // ============================================================================
  // 🆕 访问跟踪 API
  // ============================================================================

  /**
   * 跟踪卡片访问
   */
  static async trackCardAccess(cardId: string, graphId: string = 'default'): Promise<string> {
    try {
      // 直接同时传入两种参数名，适配 tauri v1/v2 命名差异
      try {
        const response = await invoke<string>('unified_track_card_access', { ...withGraphId(graphId), cardId, card_id: cardId });
        return response;
      } catch (err: any) {
        const text = String(err || '');
        // 对"卡片不存在"的场景降级为 warn，不抛错
        if (/Card\s+not\s+found/i.test(text)) {
          console.warn('Card not found during access tracking (ignored):', cardId);
          return 'not_found';
        }
        console.error('Card access tracking failed:', err);
        throw new Error(`Card access tracking failed: ${err}`);
      }
    } catch (error) {
      console.error('Card access tracking failed:', error);
      throw new Error(`Card access tracking failed: ${error}`);
    }
  }

  /**
   * 批量导入问题卡片
   */
  static async bulkImportProblemCards(request: {
    cards: Array<{
      content_problem: string;
      content_insight: string;
      tag_names: string[];
    }>;
    batch_size?: number;
    concurrency?: number;
    skip_invalid_tags?: boolean;
    continue_on_error?: boolean;
    progress_callback?: (progress: {
      processed: number;
      total: number;
      status: string;
    }) => void;
  }): Promise<{
    success_count: number;
    failed_count: number;
    errors: string[];
  }> {
    try {
      // 模拟批量导入过程，实际应该调用Rust后端
      const cards = request.cards.filter(card => 
        card.content_problem && 
        card.content_insight && 
        Array.isArray(card.tag_names) && 
        card.tag_names.length > 0
      );
      
      let successCount = 0;
      let failedCount = 0;
      const errors: string[] = [];
      
      const batchSize = request.batch_size || 100;
      const batches = Math.ceil(cards.length / batchSize);
      
      for (let i = 0; i < batches; i++) {
        const start = i * batchSize;
        const end = Math.min((i + 1) * batchSize, cards.length);
        const batch = cards.slice(start, end);
        
        // 更新进度
        request.progress_callback?.({
          processed: start,
          total: cards.length,
          status: t('utils.progress.processing_batch', { current: i + 1, total: batches })
        });
        
        try {
          // 调用后端批量导入API
          const batchResult = await invoke<{
            successful_imports: number;
            failed_imports: number;
            errors: Array<{
              problem_index: number;
              error_type: string;
              error_message: string;
              problem_content: string;
            }>;
          }>('bulk_import_problem_cards', {
            cards: batch,
            skip_invalid_tags: request.skip_invalid_tags || true,
            continue_on_error: request.continue_on_error || true
          });
          
          successCount += batchResult.successful_imports;
          failedCount += batchResult.failed_imports;
          errors.push(...batchResult.errors.map(e => e.error_message));
          
        } catch (error) {
          if (request.continue_on_error) {
            failedCount += batch.length;
            errors.push(`Batch ${i + 1} import failed: ${error}`);
          } else {
            throw error;
          }
        }
      }
      
      // Final progress
      request.progress_callback?.({
        processed: cards.length,
        total: cards.length,
        status: t('utils.progress.import_complete')
      });
      
      return {
        success_count: successCount,
        failed_count: failedCount,
        errors: errors
      };
      
    } catch (error) {
      console.error('Bulk import problem cards failed:', error);
      throw new Error(`Bulk import failed: ${error}`);
    }
  }


  // ======================== 新增：标签映射和管理优化 API ========================

  /**
   * 获取卡片关联的所有标签（Tag 数组，由后端直接返回）
   */
  static async getCardTags(cardId: string, graphId: string = 'default'): Promise<any[]> {
    const normalizedId = typeof cardId === 'string' ? cardId : String(cardId);
    let lastError: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const tags = await invoke<any[]>('unified_get_card_tags', {
          ...withGraphId(graphId),
          card_id: normalizedId,
          cardId: normalizedId,
        });
        return tags || [];
      } catch (error: any) {
        lastError = error;
        const message = typeof error === 'string' ? error : (error?.message || JSON.stringify(error));
        // 参考 getAllTags：若服务未初始化，则自动初始化后重试一次
        if (attempt === 0 && message?.includes('Search service not initialized')) {
          try {
            await this.initialize_knowledge_graph();
            continue;
          } catch (initErr) {
            // 初始化失败则不再重试
          }
        }
        break;
      }
    }
    const msg = typeof lastError === 'string' 
      ? lastError 
      : (lastError?.message || (() => { try { return JSON.stringify(lastError); } catch { return String(lastError); } })());
    throw new Error(`Failed to get card tags: ${msg}`);
  }

  static async getCardTagMetrics(
    cardId: string,
    graphId: string = 'default'
  ): Promise<Array<{ tag_id: string; confidence?: number; specificity?: number }>> {
    const normalizedId = typeof cardId === 'string' ? cardId : String(cardId);
    let lastError: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const assignments = await invoke<Array<{ tag_id: string; confidence?: number; specificity?: number }>>('unified_get_card_tag_metrics', {
          ...withGraphId(graphId),
          card_id: normalizedId,
          cardId: normalizedId,
        });
        return (assignments || []).map((item) => ({
          tag_id: item.tag_id,
          confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
          specificity: typeof item.specificity === 'number' ? item.specificity : undefined,
        }));
      } catch (error: any) {
        lastError = error;
        const message = typeof error === 'string' ? error : (error?.message || JSON.stringify(error));
        if (attempt === 0 && message?.includes('Search service not initialized')) {
          try {
            await this.initialize_knowledge_graph();
            continue;
          } catch (initErr) {
            // ignore, break out to throw
          }
        }
        break;
      }
    }
    const msg = typeof lastError === 'string'
      ? lastError
      : (lastError?.message || (() => { try { return JSON.stringify(lastError); } catch { return String(lastError); } })());
    throw new Error(`Failed to get tag metrics: ${msg}`);
  }

  /**
   * 移除卡片与标签的关联
   */
  static async removeCardTag(cardId: string, tagId: string, graphId: string = 'default') {
    const normalizedCardId = typeof cardId === 'string' ? cardId : String(cardId);
    const normalizedTagId = typeof tagId === 'string' ? tagId : String(tagId);
    const response = await invoke('unified_remove_card_tag', {
      ...withGraphId(graphId),
      card_id: normalizedCardId,
      cardId: normalizedCardId,
      tag_id: normalizedTagId,
      tagId: normalizedTagId,
    });
    return response;
  }

  /**
   * 添加卡片与标签的关联
   */
  static async addCardTag(cardId: string, tagId: string, graphId: string = 'default') {
    const normalizedCardId = typeof cardId === 'string' ? cardId : String(cardId);
    const normalizedTagId = typeof tagId === 'string' ? tagId : String(tagId);
    const response = await invoke('unified_add_card_tag', {
      ...withGraphId(graphId),
      card_id: normalizedCardId,
      cardId: normalizedCardId,
      tag_id: normalizedTagId,
      tagId: normalizedTagId,
    });
    return response;
  }

  /**
   * 搜索现有标签
   */
  static async searchExistingTags(
    query: string, 
    limit?: number, 
    tagTypeFilter?: string
  ) {
    try {
      const response = await invoke('search_existing_tags', {
        query,
        limit,
        tag_type_filter: tagTypeFilter
      });
      console.log('Search tags success:', response);
      return response;
    } catch (error) {
      console.error('Failed to search tags:', error);
      throw new Error(`Failed to search tags: ${error}`);
    }
  }

  /**
   * 获取所有标签
   */
  /**
   * 获取所有标签 -> 如果搜索服务尚未初始化，则自动初始化后重试一次。
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async getAllTags(graphId: string = 'default'): Promise<any[]> {
    let lastError: any = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        // 优先使用统一接口，向后兼容失败后再尝试旧接口
        let response: any[] | null = null;
        try {
          // ★ Tauri 命令参数自动转为 camelCase
          response = await invoke<any[]>('unified_get_tags', { ...withGraphId(graphId) });
        } catch (legacyErr) {
          console.warn('unified_get_tags failed, trying legacy get_all_tags:', legacyErr);
          response = await invoke<any[]>('get_all_tags');
        }
        console.log('Get all tags success:', response);
        return response || [];
      } catch (error: any) {
        lastError = error;
        const message = typeof error === 'string' ? error : (error?.message || JSON.stringify(error));

        // 首次失败且原因是搜索服务未初始化，则自动执行一次初始化，再重试。
        if (attempt === 0 && message?.includes('Search service not initialized')) {
          console.warn('Search service not initialized, attempting auto-init before retrying tags...');
          try {
            await this.initialize_knowledge_graph();
            continue; // 进入下一次循环重试
          } catch (initErr) {
            console.error('Auto-init knowledge graph failed:', initErr);
            // 若初始化失败则直接跳出循环，稍后统一抛错
          }
        }
        break; // 非可恢复错误或重试已执行，跳出循环
      }
    }

    console.error('Failed to get all tags:', lastError);
    throw new Error(`Failed to get all tags: ${lastError}`);
  }

  /**
   * 创建新标签
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async createTag(name: string, parentId?: string, graphId: string = 'default'): Promise<any> {
    try {
      // ★ Tauri 命令参数自动转为 camelCase
      const response = await invoke('unified_create_tag', {
        ...withGraphId(graphId),
        request: {
          name,
          tag_type: 'Concept',
          parent_id: parentId || null,
          description: null
        }
      });
      console.log('Create tag success:', response);
      return response;
    } catch (error) {
      console.error('Failed to create tag:', error);
      throw new Error(`Failed to create tag: ${error}`);
    }
  }

  /**
   * 创建新标签并指定父标签
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async createTagWithParent(input: LegacyCreateTagRequest, graphId: string = 'default') {
    const request: CreateTagRequest = {
      name: input.name,
      tag_type: input.tag_type,
      parent_id: input.parent_id ?? input.parent_tag_id,
      description: input.description,
    };
    try {
      // ★ Tauri 命令参数自动转为 camelCase
      const response = await invoke<Tag>('unified_create_tag', { ...withGraphId(graphId), request });
      console.log('Create tag success:', response);
      return response;
    } catch (error) {
      console.error('Failed to create tag:', error);
      throw new Error(`Failed to create tag: ${error}`);
    }
  }

  /**
   * 获取标签层次结构
   */
  static async getTagHierarchy(rootTagId?: string, maxDepth?: number) {
    try {
      const response = await invoke('get_detailed_tag_hierarchy', {
        root_tag_id: rootTagId,
        max_depth: maxDepth
      });
      console.log('Get tag hierarchy success:', response);
      return response;
    } catch (error) {
      console.error('Failed to get tag hierarchy:', error);
      throw new Error(`Failed to get tag hierarchy: ${error}`);
    }
  }

  /**
   * 更新卡片内容
   */
  static async updateCardContent(request: {
    card_id: string;
    content_problem?: string;
    content_insight?: string;
    notes?: string;
    status?: string;
  }) {
    try {
      const response = await invoke('update_card_content', { request });
      console.log('Update card content success:', response);
      return response;
    } catch (error) {
      console.error('Failed to update card content:', error);
      throw new Error(`Failed to update card content: ${error}`);
    }
  }

  /**
   * 获取标签映射历史
   */
  static async getTagMappingHistory(cardId: string) {
    try {
      const response = await invoke('get_tag_mapping_history', {
        card_id: cardId
      });
      console.log('Get tag mapping history success:', response);
      return response;
    } catch (error) {
      console.error('Failed to get tag mapping history:', error);
      throw new Error(`Failed to get tag mapping history: ${error}`);
    }
  }

  /**
   * 获取问题卡片详情
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async getProblemCard(cardId: string, graphId: string = 'default') {
    try {
      // ★ Tauri 命令参数自动转为 camelCase
      const response = await invoke('unified_get_card', { ...withGraphId(graphId), card_id: cardId, cardId });
      console.log('Get problem card success:', response);
      return response;
    } catch (error) {
      console.error('Failed to get problem card:', error);
      throw new Error(`Failed to get problem card: ${error}`);
    }
  }

  /**
   * 数学工作流程 - 创建会话
   * SQLite模式下在前端生成UUID，不依赖后端服务
   */
  static async mathWorkflowCreateSession(): Promise<string> {
    try {
      console.log('Math workflow: creating new session (frontend-generated)');
      // Generate UUID in frontend, avoid dependency on legacy GraphService
      const sessionId = uuidv4();
      console.log('Session created:', sessionId);
      return sessionId;
    } catch (error) {
      console.error('Failed to create session:', error);
      throw new Error(`Failed to create session: ${error}`);
    }
  }

  // ==================== Irec统一标签树导入导出API ====================

  /**
   * 从JSON内容导入标签层次结构（统一API）
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedImportTagHierarchyFromContent(jsonContent: string, graphId: string = 'default'): Promise<string> {
    try {
      console.log('Starting tag tree import (unified API)...');
      // ★ Tauri 命令参数自动转为 camelCase
      const response = await invoke<string>('unified_import_tag_hierarchy_from_content', { ...withGraphId(graphId), jsonContent });
      try {
        const parsed = JSON.parse(response);
        return parsed;
      } catch {
        return response; // 兼容旧返回
      }
    } catch (error) {
      console.error('Failed to import tag tree:', error);
      throw new Error(`Failed to import tag tree: ${error}`);
    }
  }

  /**
   * 流式导入标签树（Markdown）：返回事件名，前端监听进度
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedImportTagHierarchyStream(markdownContent: string, wrapSingleRoot: boolean = false, eventName?: string, graphId: string = 'default'): Promise<string> {
    try {
      // ★ Tauri 命令参数自动转为 camelCase
      const response = await invoke<string>('unified_import_tag_hierarchy_from_content_stream', {
        ...withGraphId(graphId),
        jsonContent: markdownContent,
        wrapSingleRoot: wrapSingleRoot,
        streamEvent: eventName ?? null,
      });
      return response; // stream event name
    } catch (error) {
      console.error('Failed to stream import tag tree:', error);
      throw new Error(`Failed to import tag tree: ${error}`);
    }
  }

  /**
   * 导出标签层次结构为JSON（统一API）
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedExportTagHierarchy(graphId: string = 'default'): Promise<string> {
    try {
      console.log('Starting tag tree export (unified API)...');
      const response = await invoke<string>('unified_export_tag_hierarchy', { ...withGraphId(graphId) });
      console.log('Tag tree export success');
      return response;
    } catch (error) {
      console.error('Failed to export tag tree:', error);
      throw new Error(`Failed to export tag tree: ${error}`);
    }
  }

  /**
   * 获取标签树统计信息（统一API）
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedGetTagTreeStats(graphId: string = 'default'): Promise<{
    total_tags: number;
    by_type: Record<string, number>;
    last_updated: string;
  }> {
    try {
      console.log('Getting tag tree stats (unified API)...');
      const response = await invoke<{
        total_tags: number;
        by_type: Record<string, number>;
        last_updated: string;
      }>('unified_get_tag_tree_stats', { ...withGraphId(graphId) });
      console.log('Tag tree stats success:', response);
      return response;
    } catch (error) {
      console.error('Failed to get tag tree stats:', error);
      throw new Error(`Failed to get tag tree stats: ${error}`);
    }
  }

  /**
   * 自动生成并导入标签树（仅当当前/指定科目无标签树时）
   * @param graphId 图谱ID
   * @param userHint 用户简短提示（领域/范围/风格等）
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedAutoGenerateTagHierarchy(userHint: string, llmMode?: 'model2_raw' | 'model2', modelOverrideId?: string, graphId: string = 'default'): Promise<string> {
    try {
      console.log('Auto-generating tag tree (unified API)...');
      const response = await invoke<string>('unified_auto_generate_tag_hierarchy', {
        ...withGraphId(graphId),
        userHint: userHint,
        llmMode: llmMode ?? 'model2_raw',
        modelOverrideId: modelOverrideId ?? null,
      });
      console.log('Auto-generation and import complete');
      return response;
    } catch (error) {
      console.error('Failed to auto-generate tag tree:', error);
      throw new Error(`Failed to auto-generate tag tree: ${error}`);
    }
  }

  /**
   * 仅生成标签树 Markdown 预览（不导入）
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedGenerateTagHierarchyPreview(userHint: string, llmMode?: 'model2_raw' | 'model2', modelOverrideId?: string, graphId: string = 'default'): Promise<string> {
    try {
      console.log('Generating tag tree preview (unified API)...');
      const response = await invoke<string>('unified_generate_tag_hierarchy_preview', {
        ...withGraphId(graphId),
        userHint: userHint,
        llmMode: llmMode ?? 'model2_raw',
        modelOverrideId: modelOverrideId ?? null,
      });
      console.log('Preview generation complete');
      return response;
    } catch (error) {
      console.error('Failed to generate tag tree preview:', error);
      throw new Error(`Failed to generate tag tree preview: ${error}`);
    }
  }

  /**
   * 流式生成标签树预览：返回 stream_event 名称，前端据此监听事件并增量更新内容
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedGenerateTagHierarchyPreviewStream(userHint: string, modelOverrideId?: string, streamEvent?: string, graphId: string = 'default'): Promise<string> {
    try {
      const response = await invoke<string>('unified_generate_tag_hierarchy_preview_stream', {
        ...withGraphId(graphId),
        userHint: userHint,
        modelOverrideId: modelOverrideId ?? null,
        streamEvent: streamEvent ?? null,
      });
      return response; // 事件名
    } catch (error) {
      console.error('Failed to stream tag tree preview:', error);
      throw new Error(`Failed to stream tag tree preview: ${error}`);
    }
  }

  static async unifiedOutlineUpdateTag(
    payload: { tagId: string; name?: string; description?: string },
    graphId: string = 'default'
  ) {
    try {
      await invoke('unified_outline_update_tag', {
        ...withGraphId(graphId),
        payload: {
          tag_id: payload.tagId,
          name: payload.name ?? null,
          description: payload.description ?? null,
        },
      });
    } catch (error) {
      console.error('Failed to update tag:', error);
      throw error;
    }
  }

  static async unifiedOutlineMoveTag(
    payload: { tagId: string; newParentId?: string | null; siblingOrder: string[] },
    graphId: string = 'default'
  ) {
    try {
      const reqPayload: any = {
        tag_id: payload.tagId,
        sibling_order: payload.siblingOrder,
      };
      if (payload.newParentId !== undefined) {
        reqPayload.new_parent_id = payload.newParentId;
      }
      await invoke('unified_outline_move_tag', {
        ...withGraphId(graphId),
        payload: {
          ...reqPayload,
        },
      });
    } catch (error) {
      console.error('Failed to move tag:', error);
      throw error;
    }
  }



  /**
   * 图召回：基于标签子树（SQL 递归CTE）
   */
  static async graphRecallSubtree(
    seedTagId: string,
    maxDepth: number = 2,
    k: number = 50,
    graphId: string = 'default'
  ) {
    try {
      const response = await invoke<any[]>('unified_graph_recall_sql', {
        ...withGraphId(graphId),
        seedTags: [seedTagId],
        seed_tags: [seedTagId],
        maxDepth,
        max_depth: maxDepth,
        k
      } as any);
      return response || [];
    } catch (error) {
      console.error('Graph subtree recall failed:', error);
      throw error;
    }
  }

  // ★ 2026-02 清理：getIrecFuseConfig / setIrecFuseConfig 已删除（无调用方）

  /**
   * 记录 Irec 相关埋点
   */
  static async logMetricEvent(
    eventName: string,
    sessionId?: string,
    cardId?: string,
    tagId?: string,
    meta?: any,
    graphId: string = 'default'
  ) {
    try {
      await invoke('unified_log_metric_event', { ...withGraphId(graphId), eventName, sessionId, cardId, tagId, meta });
    } catch (e) {
      console.warn('logMetricEvent failed:', e);
    }
  }

  // ==================== 知识图谱服务API ====================

  /**
   * 获取知识图谱默认配置 - 使用SQLite
   */
  private static getDefaultGraphConfig() {
    return {
      database_type: "SQLite",
      sqlite_config: {
        database_path: "data/knowledge_graph.db",
        enable_vector_search: true,
        enable_fts: true,
        vector_dimensions: 1536,
        connection_pool_size: 10,
        enable_wal_mode: true,
        page_size: 4096,
        cache_size: -64000,
        enable_foreign_keys: true,
        synchronous_mode: "Normal",
        journal_mode: "Wal"
      },
      fallback_enabled: false,
      performance_monitoring: true,
      operation_timeout_ms: 30000,
      debug_logging: false
    };
  }

  /**
   * 初始化知识图谱服务 - 使用统一SQLite服务
   */
  static async initialize_knowledge_graph(config?: any): Promise<string> {
    try {
      console.log('Initializing unified SQLite knowledge graph service...');
      
      // Use default SQLite config if none provided
      const defaultConfig = this.getDefaultGraphConfig();
      const finalConfig = config || defaultConfig;
      
      console.log('Using SQLite config:', {
        database_type: finalConfig.database_type,
        sqlite_config: {
          ...finalConfig.sqlite_config,
          database_path: finalConfig.sqlite_config.database_path
        }
      });
      
      // Use unified SQLite initialization command
      console.log('[DEBUG] Calling backend initialize_unified_irec');
      console.log('[DEBUG] Config params:', finalConfig);
      
      const response = await invoke<string>('initialize_unified_irec', {
        config: finalConfig
      });
      console.log('[DEBUG] Unified SQLite knowledge graph init success:', response);
      return response;
    } catch (error) {
      console.error('[DEBUG] Unified SQLite knowledge graph init failed:', error);
      console.error('[DEBUG] Error details:', JSON.stringify(error, null, 2));
      throw new Error(`Failed to initialize unified SQLite knowledge graph: ${error}`);
    }
  }

  /**
   * 测试SQLite连接 (通过初始化测试)
   */
  static async testSQLiteConnection(config?: any): Promise<string> {
    try {
      console.log('Testing SQLite connection...');
      
      const defaultConfig = this.getDefaultGraphConfig();
      const finalConfig = config || defaultConfig;
      
      // 使用初始化命令来测试连接，因为初始化过程包含连接验证
      const response = await this.initialize_knowledge_graph(finalConfig);
      console.log('SQLite connection test success (via init verification):', response);
      return `SQLite connection OK - ${response}`;
    } catch (error) {
      console.error('SQLite connection test failed:', error);
      throw new Error(`SQLite connection test failed: ${error}`);
    }
  }


  // ============================================================================
  // 🔧 统一数据导入导出API (包含传统数据和知识图谱数据)
  // ============================================================================

  /**
   * 导出知识图谱数据
   */
  static async exportKnowledgeGraphData(options: {
    include_embeddings: boolean;
    include_relationships: boolean;
  }): Promise<{
    success: boolean;
    data?: string;
    stats?: {
      total_cards: number;
      total_tags: number;
      total_relationships: number;
      total_card_tag_relations: number;
      has_embeddings: boolean;
    };
    error?: string;
  }> {
    try {
      console.log('Exporting knowledge graph data...');
      const response = await invoke<{
        success: boolean;
        data?: string;
        stats?: {
          total_cards: number;
          total_tags: number;
          total_relationships: number;
          total_card_tag_relations: number;
          has_embeddings: boolean;
        };
        error?: string;
      }>('export_knowledge_graph_data', {
        request: {
          include_embeddings: options.include_embeddings,
          include_relationships: options.include_relationships,
        }
      });
      
      if (response.success) {
        console.log('Knowledge graph data export success:', response.stats);
      } else {
        console.error('Knowledge graph data export failed:', response.error);
      }
      
      return response;
    } catch (error) {
      console.error('Failed to export knowledge graph data:', error);
      throw new Error(`Failed to export knowledge graph data: ${error}`);
    }
  }

  /**
   * 导入知识图谱数据
   */
  static async importKnowledgeGraphData(data: string, mergeStrategy: string = 'merge'): Promise<{
    success: boolean;
    imported_stats?: {
      total_cards: number;
      total_tags: number;
      total_relationships: number;
      total_card_tag_relations: number;
      has_embeddings: boolean;
    };
    warnings: string[];
    error?: string;
  }> {
    try {
      console.log('Importing knowledge graph data...');
      const response = await invoke<{
        success: boolean;
        imported_stats?: {
          total_cards: number;
          total_tags: number;
          total_relationships: number;
          total_card_tag_relations: number;
          has_embeddings: boolean;
        };
        warnings: string[];
        error?: string;
      }>('import_knowledge_graph_data', {
        request: {
          data: data,
          merge_strategy: mergeStrategy,
        }
      });
      
      if (response.success) {
        console.log('Knowledge graph data import success:', response.imported_stats);
      } else {
        console.error('Knowledge graph data import failed:', response.error);
      }
      
      return response;
    } catch (error) {
      console.error('Failed to import knowledge graph data:', error);
      throw new Error(`Failed to import knowledge graph data: ${error}`);
    }
  }

  /**
   * 导出完整统一备份数据 (传统数据 + 知识图谱数据)
   */
  static async exportUnifiedBackupData(options: {
    include_images: boolean;
    include_knowledge_graph: boolean;
    include_embeddings: boolean;
    include_settings: boolean;
    include_statistics: boolean;
  }): Promise<{
    version: string;
    timestamp: string;
    backup_type: string;
    traditional_data: {
      mistakes: MistakeItem[];
      reviews: any[];
      settings: {
        system_settings: Record<string, string>;
        api_configurations: any[];
        model_assignments?: any;
        // ★ 文档31清理：subject_configurations 已废弃
      };
      statistics?: any;
    };
    knowledge_graph_data?: string;
    metadata: {
      total_size_mb: number;
      image_backup_stats: {
        total_question_images: number;
        total_analysis_images: number;
        successful_question_images: number;
        successful_analysis_images: number;
        backup_success_rate: number;
      };
      knowledge_graph_stats?: {
        total_cards: number;
        total_tags: number;
        total_relationships: number;
        total_card_tag_relations: number;
        has_embeddings: boolean;
      };
      export_options: typeof options;
    };
  }> {
    try {
      console.log('Exporting complete unified backup data...');
      const response = await invoke<{
        version: string;
        timestamp: string;
        backup_type: string;
        traditional_data: {
          mistakes: MistakeItem[];
          reviews: any[];
          settings: {
            system_settings: Record<string, string>;
            api_configurations: any[];
            model_assignments?: any;
            subject_configurations: any[];
          };
          statistics?: any;
        };
        knowledge_graph_data?: string;
        metadata: {
          total_size_mb: number;
          image_backup_stats: {
            total_question_images: number;
            total_analysis_images: number;
            successful_question_images: number;
            successful_analysis_images: number;
            backup_success_rate: number;
          };
          knowledge_graph_stats?: {
            total_cards: number;
            total_tags: number;
            total_relationships: number;
            total_card_tag_relations: number;
            has_embeddings: boolean;
          };
          export_options: typeof options;
        };
      }>('export_unified_backup_data', {
        options: options
      });
      
      console.log('Complete unified backup export success');
      return response;
    } catch (error) {
      console.error('Failed to export complete unified backup data:', error);
      throw new Error(`Failed to export complete unified backup data: ${error}`);
    }
  }


  // ==================== Irec知识图谱API ====================

  /**
   * 获取所有卡片
   */
  static async getCards(): Promise<Array<{
    id: string;
    title: string;
    content: string;
    tags: string[];
    status: string;
    created_at: string;
    views: number;
  }>> {
    try {
      console.log('Getting all cards...');
      const response = await invoke<Array<{
        id: string;
        title: string;
        content: string;
        tags: string[];
        status: string;
        created_at: string;
        views: number;
      }>>('unified_get_all_cards');
      console.log('Get cards success:', response);
      return response;
    } catch (error) {
      console.error('Failed to get cards:', error);
      throw new Error(`Failed to get cards: ${error}`);
    }
  }

  /**
   * 根据标签筛选卡片
   */
  static async getCardsByTags(tagIds: string[]): Promise<Array<{
    id: string;
    title: string;
    content: string;
    tags: string[];
    status: string;
    created_at: string;
    views: number;
  }>> {
    try {
      console.log('Filtering cards by tags...');
      const response = await invoke<Array<{
        id: string;
        title: string;
        content: string;
        tags: string[];
        status: string;
        created_at: string;
        views: number;
      }>>('unified_get_cards_by_tags', { tag_ids: tagIds });
      console.log('Filter cards success:', response);
      return response;
    } catch (error) {
      console.error('Failed to filter cards:', error);
      throw new Error(`Failed to filter cards: ${error}`);
    }
  }

  /**
   * 获取卡片统计信息
   */
  static async getCardStats(graphId: string = 'default'): Promise<{
    total: number;
    solved: number;
    views: number;
    recent: number;
  }> {
    try {
      console.log('Getting card stats...');
      const response = await invoke<{
        total: number;
        solved: number;
        views: number;
        recent: number;
      }>('unified_get_card_stats', { ...withGraphId(graphId) });
      console.log('Get stats success:', response);
      return response;
    } catch (error) {
      console.error('Failed to get stats:', error);
      throw new Error(`Failed to get stats: ${error}`);
    }
  }

  /**
   * 创建新标签 (统一API)
   */
  static async unifiedCreateTag(request: CreateTagRequest, graphId: string = 'default') {
    try {
      console.log('[Unified API] Create tag:', request.name);
      const response = await invoke<Tag>('unified_create_tag', {
        ...withGraphId(graphId),
        request,
      });
      console.log('Tag creation success:', response);
      return response;
    } catch (error) {
      console.error('[Unified API] Failed to create tag:', error);
      throw new Error(`Failed to create tag: ${error}`);
    }
  }

  /**
   * 更新卡片内容 (统一API) - 需要传入完整 ProblemCard 对象
   */
  static async unifiedUpdateCard(card: ProblemCard, graphId: string = 'default'): Promise<void> {
    try {
      console.log('[Unified API] Update card:', card.id);
      await invoke('unified_update_card', {
        ...withGraphId(graphId),
        card,
      });
      console.log('Card update success');
    } catch (error) {
      console.error('[Unified API] Failed to update card:', error);
      throw new Error(`Failed to update card: ${error}`);
    }
  }

  /**
   * 获取所有标签 (统一API)
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedGetTags(graphId: string = 'default'): Promise<Tag[]> {
    try {
      const tags = await invoke<Tag[]>('unified_get_tags', { ...withGraphId(graphId) });
      return tags;
    } catch (error) {
      console.error('[Unified API] Failed to get tags:', error);
      throw new Error(`Failed to get tags: ${error}`);
    }
  }

  /**
   * 获取标签层级（统一API）- 兼容 root_tag_id/rootTagId
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedGetTagHierarchy(rootTagId?: string | null, graphId: string = 'default'): Promise<TagHierarchy[]> {
    try {
      // ★ Tauri 命令参数自动转为 camelCase
      const args = rootTagId 
        ? { ...withGraphId(graphId), rootTagId } 
        : { ...withGraphId(graphId), rootTagId: null };
      const hierarchy = await invoke<TagHierarchy[]>('unified_get_tag_hierarchy', args);
      return hierarchy || [];
    } catch (error) {
      console.error('[Unified API] Failed to get tag hierarchy:', error);
      throw new Error(`Failed to get tag hierarchy: ${String(error)}`);
    }
  }

  /**
   * 获取卡片与其标签（统一API）
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedGetCardsWithTags(options?: { limit?: number; offset?: number }, graphId: string = 'default'): Promise<Array<[ProblemCard, Tag[]]>> {
    try {
      const args: Record<string, unknown> = { ...withGraphId(graphId) };
      if (typeof options?.limit === 'number') args.limit = options.limit;
      if (typeof options?.offset === 'number') args.offset = options.offset;
      const pairs = await invoke<Array<[ProblemCard, Tag[]]>>('unified_get_cards_with_tags', args);
      return Array.isArray(pairs) ? pairs : [];
    } catch (error) {
      console.error('[Unified API] Failed to get cards with tags:', error);
      throw new Error(`Failed to get cards with tags: ${String(error)}`);
    }
  }

  /** 删除标签（统一API）
   * 
   * ★ 文档31清理：使用默认图谱 ID "default"
   */
  static async unifiedDeleteTag(tagId: string, graphId: string = 'default'): Promise<string> {
    try {
      // ★ Tauri 命令参数自动转为 camelCase
      return await invoke<string>('unified_delete_tag', { ...withGraphId(graphId), tagId });
    } catch (error) {
      console.error('[Unified API] Failed to delete tag:', error);
      throw new Error(`Failed to delete tag: ${String(error)}`);
    }
  }

  // ==================== 大纲笔记模式专用 API ====================

  // ★ 文档31清理：移除 subject 参数
  /** 更新标签描述（大纲模式） */
  static async graphUpdateTagDescription(
    tagId: string,
    newDescription: string | null,
    graphId: string = 'default'
  ): Promise<void> {
    try {
      await invoke('unified_outline_update_tag', {
        ...withGraphId(graphId),
        payload: {
          tag_id: tagId,
          description: newDescription,
        },
      });
      console.log('Update tag description success');
    } catch (error) {
      console.error('Failed to update tag description:', error);
      throw new Error(`Failed to update tag description: ${String(error)}`);
    }
  }

  // ★ 文档31清理：移除 subject 参数
  /** 重新排序标签 */
  static async graphReorderTag(
    tagId: string,
    newSortOrder: number,
    graphId: string = 'default'
  ): Promise<void> {
    try {
      await invoke('graph_reorder_tag', {
        ...withGraphId(graphId),
        tag_id: tagId,
        tagId,
        new_sort_order: newSortOrder,
        newSortOrder,
      });
      console.log('Reorder tag success');
    } catch (error) {
      console.error('Failed to reorder tag:', error);
      throw new Error(`Failed to reorder tag: ${String(error)}`);
    }
  }

  // ★ 文档31清理：移除 subject 参数
  /** 批量重新排序标签 */
  static async graphBatchReorderTags(
    parentId: string | null,
    tagIdOrder: Array<[string, number]>,
    graphId: string = 'default'
  ): Promise<void> {
    try {
      await invoke('graph_batch_reorder_tags', {
        ...withGraphId(graphId),
        parent_id: parentId,
        parentId,
        tag_id_order: tagIdOrder,
        tagIdOrder,
      });
      console.log('Batch reorder tags success');
    } catch (error) {
      console.error('Failed to batch reorder tags:', error);
      throw new Error(`Failed to batch reorder tags: ${String(error)}`);
    }
  }

  // ★ 文档31清理：移除 subject 参数
  /** 更新标签元数据（名称、描述） */
  static async graphUpdateTagMetadata(params: {
    tagId: string;
    newName?: string;
    newDescription?: string;
    newTagType?: string;
    graphId?: string;
  }): Promise<void> {
    try {
      const graphId = params.graphId ?? 'default';
      await invoke('unified_outline_update_tag', {
        ...withGraphId(graphId),
        payload: {
          tag_id: params.tagId,
          name: params.newName ?? null,
          description: params.newDescription ?? null,
        },
      });
      console.log('Update tag metadata success');
    } catch (error) {
      console.error('Failed to update tag metadata:', error);
      throw new Error(`Failed to update tag metadata: ${String(error)}`);
    }
  }

  /** 清空标签缓存（大纲模式编辑后调用） */
  static async clearTagCache(graphId: string = 'default'): Promise<void> {
    try {
      // 通过重新初始化图谱服务来清空缓存
      await invoke('unified_fix_tag_hierarchy', { ...withGraphId(graphId) });
      console.log('Clear tag cache success');
    } catch (error) {
      console.warn('Clear tag cache failed (ignored):', error);
      // 不抛出错误，因为这只是优化操作
    }
  }

  /** 删除卡片（统一API） */
  static async unifiedDeleteCard(cardId: string, graphId: string = 'default'): Promise<boolean> {
    try {
      const ok = await invoke<boolean>('unified_delete_card', { ...withGraphId(graphId), cardId, card_id: cardId });
      if (ok === false) {
        console.warn('[Unified API] Delete card: backend returned false, treating as deleted', cardId);
        return true;
      }
      return ok;
    } catch (error) {
      // 兼容"卡片已不存在"的软失败：前端视为已删除
      const message = getErrorMessage(error);
      const text = String(message || '');
      if (/Card\s+not\s+found/i.test(text)) {
        console.warn('[Unified API] Delete card: backend says not found, treating as deleted', cardId);
        return true;
      }
      console.error('[Unified API] Failed to delete card:', error);
      throw new Error(`Failed to delete card: ${text}`);
    }
  }

  /** 批量删除记忆内化任务（可选：同步删除已创建 Note） */
  static async deleteMemoryIntakeTasks(
    taskIds: string[],
    options?: { deleteCards?: boolean }
  ): Promise<{ deleted: number; deleted_cards: number; queue_removed: number; dead_letter_removed: number }> {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return { deleted: 0, deleted_cards: 0, queue_removed: 0, dead_letter_removed: 0 };
    }
    try {
      const payload = {
        taskIds,
        task_ids: taskIds,
        deleteCards: options?.deleteCards ?? true,
        delete_cards: options?.deleteCards ?? true,
      };
      const result = await invoke<any>('delete_memory_internalization_tasks', payload);
      return {
        deleted: Number(result?.deleted ?? 0),
        deleted_cards: Number(result?.deleted_cards ?? 0),
        queue_removed: Number(result?.queue_removed ?? 0),
        dead_letter_removed: Number(result?.dead_letter_removed ?? 0),
      };
    } catch (error) {
      console.error('[Unified API] Failed to delete internalization tasks:', error);
      throw new Error(`Failed to delete internalization tasks: ${String(error)}`);
    }
  }

  /**
   * 设置卡片标签集合（前端组合，后端如未提供 set 接口则用 add/remove 达成）
   */
  static async unifiedSetCardTags(cardId: string, targetTagIds: string[], graphId: string = 'default'): Promise<void> {
    const current = await this.getCardTags(cardId, graphId).catch(() => []) as any[];
    const currentIds = new Set<string>((current || []).map((t: any) => t?.id || t?.tag?.id).filter(Boolean));
    const targetIds = new Set<string>(targetTagIds);
    // remove
    for (const id of Array.from(currentIds)) {
      if (!targetIds.has(id)) {
        try { await this.removeCardTag(cardId, id, graphId); } catch {}
      }
    }
    // add
    for (const id of Array.from(targetIds)) {
      if (!currentIds.has(id)) {
        try { await this.addCardTag(cardId, id, graphId); } catch {}
      }
    }
  }

  static async updateCardNotes(cardId: string, notes: string | null): Promise<void> {
    const card = await this.getProblemCard(cardId) as ProblemCard;
    if (!card) {
      throw new Error("Card not found");
    }

    const updatedCard: ProblemCard = {
      ...card,
      notes: notes ?? undefined,
    };

    await this.unifiedUpdateCard(updatedCard);
    try {
      window.dispatchEvent(new CustomEvent('graphNoteUpdated', { detail: { cardId, hasNotes: Boolean(notes && notes.trim()) } }));
    } catch {}
  }

  // ==================== LLM 生成答案（基于上下文） ====================
  static async llmGenerateAnswerWithContext(query: string, contextJson: string): Promise<string> {
    try {
      const response = await invoke<string>('llm_generate_answer_with_context', {
        query,
        context_json: contextJson,
      });
      console.log('LLM answer generation success');
      return response;
    } catch (error) {
      console.error('Failed to generate LLM answer:', error);
      throw new Error(`Failed to generate LLM answer: ${error}`);
    }
  }

  static async unifiedFixTagHierarchy(graphId: string = 'default'): Promise<string> {
    try {
      console.log('Starting tag tree fix/init (unified API)...');
      const response = await invoke<string>('unified_fix_tag_hierarchy', { ...withGraphId(graphId) });
      console.log('Tag tree fix complete:', response);
      return response;
    } catch (error) {
      console.error('Failed to fix tag tree:', error);
      throw new Error(`Failed to fix tag tree: ${error}`);
    }
  }

  /**
   * 初始化默认数学五层标签树（若后端提供该命令）
   */
  static async initializeDefaultTagHierarchy(): Promise<string> {
    try {
      console.log('Initializing default tag hierarchy...');
      const response = await invoke<string>('initialize_default_tag_hierarchy');
      console.log('Default tag hierarchy initialized:', response);
      return response;
    } catch (error) {
      console.error('Failed to initialize default tag hierarchy:', error);
      throw new Error(`Failed to initialize default tag hierarchy: ${error}`);
    }
  }

  // ★ 2026-02 清理：clearIrecLocalDatabase 已删除（无调用方）

  /**
   * 生成缺失的标签向量，可指定并发与批量大小（可选）。
   */
  static async generateMissingTagVectors(graphId: string = 'default'): Promise<string> {
    try {
      console.log('Starting batch generation of missing tag vectors...');
      const response = await invoke<{ success: boolean; message: string }>('unified_generate_missing_tag_vectors', { ...withGraphId(graphId) });
      // 订阅进度事件
      try {
        const { listen } = await import('@tauri-apps/api/event');
        const un = await listen<'any'>('tag_vector_status', (e: any) => {
          const p = e?.payload || {};
          console.log('Tag vector progress:', p);
        });
        // 调用方可存储 un 以便页面卸载时取消监听
      } catch (_) {}
      console.log('Tag vector batch task started:', response);
      return response.message;
    } catch (error) {
      console.error('Failed to trigger tag vector generation:', error);
      throw new Error(`Failed to trigger tag vector generation: ${error}`);
    }
  }

  // 旧备份命令链路已移除，请使用 DataGovernanceApi（data_governance_*）。

  // ===== P0-27 修复：WebView 设置备份/恢复 =====

  /**
   * 保存 WebView localStorage 数据到后端文件系统
   * 在备份导出前调用，确保 UI 偏好设置被包含在备份中
   */
  static async saveWebviewSettings(settings: Record<string, string>): Promise<{ success: boolean; path?: string; size?: number }> {
    return invoke<{ success: boolean; path?: string; size?: number }>('save_webview_settings', { settings });
  }

  static collectLocalStorageForBackup(): Record<string, string> {
    const keysToBackup = [
      // 主题设置
      'dstu_theme_mode',
      'dstu_theme_palette',
      'deep-student-theme',
      'deep-student-color-palette',
      // 语言设置
      'i18nextLng',
      'dstu_language',
      // 新手引导状态
      'onboarding_completed_flows',
      'onboarding_skipped',
      // 其他 UI 偏好
      'sidebar_collapsed',
      'chat_panel_width',
      'learning_hub_layout',
      // 🔧 P1-50: 云存储配置（非敏感信息，密码在安全存储中）
      'cloud_storage_config_v2',
      'cloud_storage_config',  // 旧版配置（用于迁移兼容）
      // 🔧 P1-50: AnkiConnect 配置
      'anki_connect_settings',
      // 🔧 P1-50: 模板编辑器偏好
      'template_editor_prefs',
      // 🔧 P1-50: 命令面板快捷键
      'command_palette_shortcuts',
    ];

    const result: Record<string, string> = {};
    for (const key of keysToBackup) {
      const value = localStorage.getItem(key);
      if (value !== null) {
        result[key] = value;
      }
    }
    return result;
  }

  /**
   * @deprecated 已移除。请使用 DataGovernanceApi.runHealthCheck() 代替。
   * 旧 backup::run_data_integrity_check 命令已从后端移除。
   */
  static async runDataIntegrityCheck(): Promise<string> {
    throw new Error(
      '旧备份命令 run_data_integrity_check 已移除，请使用 DataGovernanceApi.runHealthCheck() 代替'
    );
  }

  /**
   * 优化 Lance 数据库（合并碎片、清理旧版本、提升性能）
   * @param parallelism 并行度（默认4）
   */
  static async optimizeLanceDatabase(parallelism?: number, force = true): Promise<{ success: boolean; optimized_tables?: number; duration_ms?: number; message: string; error?: string }> {
    return invoke<{ success: boolean; optimized_tables?: number; duration_ms?: number; message: string; error?: string }>('optimize_lance_database', { parallelism, force });
  }

  // Data Space (A/B slots)
  static async getDataSpaceInfo(): Promise<{ active_slot: string; inactive_slot: string; pending_slot?: string; active_dir: string; inactive_dir: string; }> {
    if (!isTauriRuntime) {
      return {
        active_slot: 'A',
        inactive_slot: 'B',
        active_dir: '',
        inactive_dir: '',
      };
    }
    try {
      return await invoke('get_data_space_info');
    } catch (error) {
      console.warn('[tauriApi] getDataSpaceInfo call failed, returning default placeholder data.', error);
      return {
        active_slot: 'A',
        inactive_slot: 'B',
        active_dir: '',
        inactive_dir: '',
      };
    }
  }

  static async markDataSpacePendingSwitchToInactive(): Promise<string> {
    if (!isTauriRuntime) {
      return 'noop';
    }
    try {
      return await invoke('mark_data_space_pending_switch_to_inactive');
    } catch (error) {
      console.warn('[tauriApi] markDataSpacePendingSwitchToInactive call failed, returning noop.', error);
      return 'noop';
    }
  }

  // ===== 测试插槽 C/D API（前端全自动备份测试专用）=====

  /**
   * 获取测试插槽信息
   * 返回 C/D 插槽的目录路径、是否存在、文件数量等
   */
  static async getTestSlotInfo(): Promise<{
    slot_c_dir: string;
    slot_d_dir: string;
    slot_c_exists: boolean;
    slot_d_exists: boolean;
    slot_c_file_count: number;
    slot_d_file_count: number;
  }> {
    return invoke('get_test_slot_info');
  }

  /**
   * 清空测试插槽 C 和 D
   * 用于测试前的环境准备
   */
  static async clearTestSlots(): Promise<string> {
    return invoke('clear_test_slots');
  }

  static async restartApp(): Promise<void> {
    return invoke<void>('restart_app');
  }

  /**
   * 修复数据库 schema
   * 确保所有必需的列都存在
   */
  static async fixDatabaseSchema(): Promise<string> {
    try {
      console.log('Starting database schema fix...');
      const result = await invoke<string>('fix_database_schema');
      console.log('Database schema fix complete:', result);
      return result;
    } catch (error) {
      console.error('Failed to fix database schema:', error);
      throw error;
    }
  }

  /**
   * 物理删除所有数据库文件
   * 通过直接删除文件系统中的数据库文件来彻底清空所有数据
   */
  static async purgeAllDatabaseFiles(): Promise<string> {
    try {
      console.log('Purging all database files...');
      const result = await invoke<string>('purge_all_database_files');
      console.log('Database files purge complete:', result);
      return result;
    } catch (error) {
      console.error('Failed to purge database files:', error);
      throw new Error(`Failed to purge database files: ${error}`);
    }
  }

  static async purgeActiveDataDirNow(): Promise<string> {
    try {
      console.log('Purging active data directory (no restart)...');
      return await invoke<string>('purge_active_data_dir_now');
    } catch (error) {
      console.error('Failed to purge data directory:', error);
      throw new Error(`Failed to purge data directory: ${error}`);
    }
  }

  /**
   * 获取真实的存储占用信息
   * 返回详细的存储占用信息，包括数据库、图片、备份等各部分的大小
   */
  static async getStorageInfo(): Promise<{
    total_size: number;
    database_size: number;
    images_size: number;
    images_count: number;
    backups_size: number;
    cache_size: number;
    other_size: number;
    formatted_total: string;
    formatted_database: string;
    formatted_images: string;
    formatted_backups: string;
    formatted_cache: string;
    formatted_other: string;
  }> {
    try {
      const response = await invoke<any>('get_storage_info');
      console.log('Get storage info success:', response);
      return response;
    } catch (error: any) {
      console.error('Failed to get storage info:', error);
      throw new Error(`Failed to get storage info: ${error}`);
    }
  }
  
  /**
   * 获取应用数据目录（缓存版本）
   */
  private static appDataDir: string | null = null;
  
  static async getAppDataDir(): Promise<string> {
    if (!this.appDataDir) {
      try {
        this.appDataDir = await invoke<string>('get_app_data_dir');
      } catch (e) {
        // 后端未提供时使用空字符串占位
        this.appDataDir = '';
      }
    }
    return this.appDataDir;
  }

  static async getAppVersion(): Promise<string> {
    try {
      return await invoke<string>('get_app_version');
    } catch (error) {
      console.error('Failed to get app version, returning dev', error);
      return 'dev';
    }
  }
  
  // ★ 文档31清理：移除 subject 参数
  static async listExamSheetSessions(params: {
    limit?: number;
  }): Promise<ExamSheetSessionSummary[]> {
    try {
      const payload = {
        limit: params.limit ?? 50,
      };
      const response = await invokeWithDebug<ExamSheetSessionListResponse>(
        'list_exam_sheet_sessions',
        { request: payload },
        { tag: 'exam_sheet_list' }
      );
      return response.sessions;
    } catch (error) {
      throw new Error(`Failed to load exam sheet history: ${getErrorMessage(error)}`);
    }
  }

  static async getExamSheetSessionDetail(sessionId: string): Promise<ExamSheetSessionDetail> {
    try {
      const response = await invokeWithDebug<ExamSheetSessionDetailResponse>(
        'get_exam_sheet_session_detail',
        { request: { session_id: sessionId } },
        { tag: 'exam_sheet_detail' }
      );
      return response.detail;
    } catch (error) {
      throw new Error(`Failed to get exam sheet detail: ${getErrorMessage(error)}`);
    }
  }

  static async updateExamSheetCards(request: UpdateExamSheetCardsRequestPayload): Promise<ExamSheetSessionDetail> {
    try {
      const response = await invokeWithDebug<UpdateExamSheetCardsResponsePayload>(
        'update_exam_sheet_cards',
        { request },
        { tag: 'exam_sheet_update' }
      );
      return response.detail;
    } catch (error) {
      throw new Error(`Failed to update exam sheet data: ${getErrorMessage(error)}`);
    }
  }

  static async renameExamSheetSession(sessionId: string, examName?: string): Promise<ExamSheetSessionSummary> {
    try {
      const response = await invokeWithDebug<RenameExamSheetSessionResponsePayload>(
        'rename_exam_sheet_session',
        { request: { session_id: sessionId, exam_name: examName ?? null } },
        { tag: 'exam_sheet_rename' }
      );
      return response.summary;
    } catch (error) {
      throw new Error(`Failed to rename exam sheet: ${getErrorMessage(error)}`);
    }
  }

  // ★ 2026-01 清理：linkExamSheetSessionMistakes 和 unlinkExamSheetSessionMistake 已删除（错题关联功能废弃）

  /**
   * ★ 题目集识别预览（核心 API）
   * 处理上传的试卷图片，进行 OCR 识别和题目分割
   */
  static async processExamSheetPreview(payload: ExamSheetPreviewRequestPayload): Promise<ExamSheetPreviewResult> {
    try {
      // 将 File 对象转换为 base64 字符串
      const pageImages: string[] = await Promise.all(
        payload.pageImages.map(async (img) => {
          if (typeof img === 'string') {
            return img; // 已经是字符串（路径或 base64）
          }
          // File 对象需要转换为 base64
          return await fileToBase64(img);
        })
      );

      // 将前端 payload 转换为后端期望的 request 格式
      const request = {
        exam_name: payload.examName ?? null,
        page_images: pageImages,
        instructions: payload.instructions ?? null,
        grouping_prompt: payload.groupingPrompt ?? null,
        grouping_focus: payload.groupingFocus ?? null,
        chunk_size: payload.chunkSize ?? null,
        concurrency: payload.concurrency ?? null,
        output_format: payload.outputFormat ?? null,
        session_id: payload.sessionId ?? null,
      };
      const response = await invokeWithDebug<ExamSheetPreviewResult>(
        'process_exam_sheet_preview',
        { request },
        { tag: 'exam_sheet_preview' }
      );
      return response;
    } catch (error) {
      console.error('Exam sheet recognition preview failed:', error);
      throw new Error(`Exam sheet recognition preview failed: ${getErrorMessage(error)}`);
    }
  }

  // =================================================
  // 包管理器检测和安装
  // =================================================
  
  static async checkPackageManager(command: string): Promise<{
    detected: boolean;
    manager_type?: string;
    is_available?: boolean;
    version?: string;
    install_hints?: string[];
    can_auto_install?: boolean;
    message?: string;
  }> {
    try {
      return await invoke('check_package_manager', { command });
    } catch (error) {
      console.error('Failed to check package manager:', error);
      throw new Error(`Failed to check package manager: ${getErrorMessage(error)}`);
    }
  }

  static async autoInstallPackageManager(managerType: string): Promise<{
    success: boolean;
    message: string;
    installed_version?: string;
  }> {
    try {
      return await invoke('auto_install_package_manager', { managerType });
    } catch (error) {
      console.error('Failed to auto-install package manager:', error);
      throw new Error(`Failed to auto-install package manager: ${getErrorMessage(error)}`);
    }
  }

  static async checkAllPackageManagers(): Promise<{
    node: { is_available: boolean; version?: string; install_hints: string[] };
    python: { is_available: boolean; version?: string; install_hints: string[] };
    uv: { is_available: boolean; version?: string; install_hints: string[]; can_auto_install: boolean };
    cargo: { is_available: boolean; version?: string; install_hints: string[]; can_auto_install: boolean };
  }> {
    try {
      return await invoke('check_all_package_managers');
    } catch (error) {
      console.error('Failed to check all package managers:', error);
      throw new Error(`Package manager check failed: ${getErrorMessage(error)}`);
    }
  }

  // ★ 2026-01 清理：错题分析相关占位方法已删除（analyzeNewMistake, analyzeFromBridge, analyzeStepByStep, startStreamingAnswer, continueChatStream, runtimeAutosaveCommit 等）
  
  /**
   * 导入对话快照（占位）
   * @deprecated 后端尚未实现，返回失败状态
   */
  static async importConversationSnapshot(_params: unknown): Promise<{
    success: boolean;
    conversationId?: string;
    message?: string;
    warnings?: string[];
  }> {
    console.warn('[TauriAPI] importConversationSnapshot not yet implemented');
    return {
      success: false,
      message: t('utils.errors.import_not_implemented'),
      warnings: [t('utils.warnings.feature_unavailable')],
    };
  }

  /**
   * 保存图片到图片目录（占位）
   * @deprecated 后端尚未实现，返回空路径
   */
  static async saveImageToImagesDir(
    _imageBase64: string,
    _fileName?: string
  ): Promise<{ path: string }> {
    console.warn('[TauriAPI] saveImageToImagesDir not yet implemented, returning empty path');
    return { path: '' };
  }
}

// 合并相邻的assistant消息：
// - 如果出现 [assistant(无内容但含工具/来源)] + [assistant(有内容)]，
//   则把前者的 tool_call/tool_result/overrides.multi_tool 以及 rag/graph/memory/web_search sources 合并到后者，删除前者。
function coalesceAssistantMessages(list: any[]): any[] {
  if (!Array.isArray(list) || list.length === 0) return list || [];
  const out: any[] = [];
  for (let i = 0; i < list.length; i++) {
    const cur = list[i];
    const next = list[i + 1];
    const isAssistant = (m: any) => (m && (m.role === 'assistant'));
    const contentOf = (m: any) => (typeof m?.content === 'string' ? m.content.trim() : '');
    const hasTools = (m: any) => Boolean(m?.tool_call || m?.tool_result || (m?.overrides && m.overrides.multi_tool));
    const hasSources = (m: any) => Boolean(
      (m?.rag_sources && m.rag_sources.length) ||
      (m?.graph_sources && m.graph_sources.length) ||
      (m?.memory_sources && m.memory_sources.length) ||
      (m?.web_search_sources && m.web_search_sources.length)
    );

    if (isAssistant(cur) && isAssistant(next) && !contentOf(cur) && contentOf(next)) {
      // 合并工具
      if (hasTools(cur)) {
        // 兼容字段：保留最后一次到 tool_call/tool_result；多轮存到 overrides.multi_tool
        next.tool_call = next.tool_call || cur.tool_call || undefined;
        next.tool_result = next.tool_result || cur.tool_result || undefined;
        const curMulti = cur?.overrides?.multi_tool;
        if (curMulti && Array.isArray(curMulti.tool_calls) || Array.isArray(curMulti?.tool_results)) {
          const ov = next.overrides || {};
          const nt = ov.multi_tool || { tool_calls: [], tool_results: [] };
          if (Array.isArray(curMulti.tool_calls)) nt.tool_calls = [...(nt.tool_calls || []), ...curMulti.tool_calls];
          if (Array.isArray(curMulti.tool_results)) nt.tool_results = [...(nt.tool_results || []), ...curMulti.tool_results];
          ov.multi_tool = nt;
          next.overrides = ov;
        }
      }
      // 合并来源
      if (hasSources(cur)) {
        if (Array.isArray(cur.rag_sources)) next.rag_sources = [...(next.rag_sources || []), ...cur.rag_sources];
        if (Array.isArray(cur.graph_sources)) next.graph_sources = [...(next.graph_sources || []), ...cur.graph_sources];
        if (Array.isArray(cur.memory_sources)) next.memory_sources = [...(next.memory_sources || []), ...cur.memory_sources];
        if (Array.isArray(cur.web_search_sources)) next.web_search_sources = [...(next.web_search_sources || []), ...cur.web_search_sources];
      }
      // 丢弃当前，推进索引
      i++; // 跳过 next 将在下面 push
      out.push(next);
      continue;
    }
    out.push(cur);
  }
  return out;
}

export interface ExamSheetSessionMetadata {
  instructions?: string | null;
  tags?: string[] | null;
  page_count?: number | null;
  card_count?: number | null;
  raw_model_response?: any;
}

export interface ExamSheetSessionSummary {
  id: string;
  exam_name?: string | null;
  mistake_id: string;
  created_at: string;
  updated_at: string;
  status: string;
  metadata?: ExamSheetSessionMetadata | null;
  linked_mistake_ids?: string[] | null;
}

export interface ExamSheetSessionDetail {
  summary: ExamSheetSessionSummary;
  preview: ExamSheetPreviewResult;
}

export type ExamSheetProgressEvent =
  | {
      type: 'SessionCreated';
      detail: ExamSheetSessionDetail;
      total_chunks: number;
    }
  | {
      type: 'ChunkCompleted';
      detail: ExamSheetSessionDetail;
      chunk_index: number;
      total_chunks: number;
    }
  | {
      type: 'Completed';
      detail: ExamSheetSessionDetail;
    }
  | {
      type: 'Failed';
      session_id?: string | null;
      error: string;
      detail?: ExamSheetSessionDetail | null;
    };

export interface ExamSheetSessionListResponse {
  sessions: ExamSheetSessionSummary[];
}

export interface ExamSheetSessionDetailResponse {
  detail: ExamSheetSessionDetail;
}

export interface ExamSheetSessionLinkResponse {
  success: boolean;
}

export async function clearMessageEmbeddings(ids: Array<string | number>): Promise<void> {
  if (!Array.isArray(ids) || ids.length === 0) return;
  const payload = ids
    .map((id) => {
      if (typeof id === 'number') return id.toString();
      if (typeof id === 'string') return id.trim();
      return '';
    })
    .filter((val) => val.length > 0);
  if (payload.length === 0) return;
  await invoke('clear_message_embeddings', { messageIds: payload });
}

// ======================== 测试数据库管理 ========================

export interface DatabaseInfo {
  production_db_path: string;
  test_db_path: string;
  test_db_exists: boolean;
  production_db_exists: boolean;
  active_database: 'production' | 'test';
}

export interface TestDatabaseSwitchResponse {
  success: boolean;
  test_db_path?: string;
  production_db_path?: string;
  message: string;
  deleted_files?: string[];
  active_database?: 'production' | 'test';
}

/**
 * 切换到测试数据库
 */
export async function switchToTestDatabase(): Promise<TestDatabaseSwitchResponse> {
  return await invokeWithDebug('switch_to_test_database', {}, { tag: 'test_db' });
}

/**
 * 重置测试数据库（删除并重新创建）
 */
export async function resetTestDatabase(): Promise<TestDatabaseSwitchResponse> {
  return await invokeWithDebug('reset_test_database', {}, { tag: 'test_db' });
}

/**
 * 切换回生产数据库
 */
export async function switchToProductionDatabase(): Promise<TestDatabaseSwitchResponse> {
  return await invokeWithDebug('switch_to_production_database', {}, { tag: 'test_db' });
}

/**
 * 获取当前数据库路径信息
 */
export async function getDatabaseInfo(): Promise<DatabaseInfo> {
  return await invokeWithDebug('get_database_info', {}, { tag: 'test_db' });
}

/**
 * 播种测试数据库
 */
export async function seedTestDatabase(config?: {
  create_basic_mistakes?: boolean;
  create_mistakes_with_chat?: boolean;
  create_mistakes_with_attachments?: boolean;
  create_diverse_mistakes?: boolean; // subject 已废弃
}): Promise<{
  success: boolean;
  mistakes_created: number;
  messages_created: number;
  errors: string[];
}> {
  return await invokeWithDebug('seed_test_database', { config: config || null }, { tag: 'test_db' });
}

export async function setTestRunId(testRunId: string): Promise<{ success: boolean; test_run_id: string }> {
  return await invokeWithDebug('set_test_run_id', { test_run_id: testRunId, testRunId }, { tag: 'test_run' });
}

export const TestDatabaseAPI = {
  switchToTest: switchToTestDatabase,
  reset: resetTestDatabase,
  switchToProduction: switchToProductionDatabase,
  getInfo: getDatabaseInfo,
  seed: seedTestDatabase,
};

// ======================== 翻译功能API ========================

export interface TranslationHistoryItem {
  id: string;
  source_text: string;
  translated_text: string;
  src_lang: string;
  tgt_lang: string;
  prompt_used?: string | null;
  created_at: string;
  is_favorite: boolean;
  quality_rating?: number | null;
}

/**
 * OCR提取文本（单页图片识别）
 * @param options - {imagePath?: string, imageBase64?: string}
 */
export async function ocrExtractText(options: {
  imagePath?: string;
  imageBase64?: string;
}): Promise<string> {
  try {
    const result = await invoke<string>('ocr_extract_text', {
      image_path: options.imagePath || null,
      image_base64: options.imageBase64 || null,
      imagePath: options.imagePath || null, // 兼容驼峰命名
      imageBase64: options.imageBase64 || null,
    });
    return result;
  } catch (error) {
    const message = getErrorMessage(error);
    throw new Error(`OCR text extraction failed: ${message}`);
  }
}

/**
// ★ 翻译 CRUD 命令已全部迁移至 DSTU/VFS（translationDstuAdapter）
// translateText / listTranslations / updateTranslation / deleteTranslation /
// toggleTranslationFavorite / rateTranslation / TranslationAPI 聚合对象均已删除

// ★ 白板库 API 已移除（白板模块废弃，2026-01 清理）
*/
