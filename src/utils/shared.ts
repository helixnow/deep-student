// ★ 图谱模块已废弃 - 本地占位类型
export type TagHierarchy = { id: string; name: string; children?: TagHierarchy[] };
export type GraphQueryParams = Record<string, unknown>;
export type ForceGraphData = { nodes: unknown[]; links: unknown[] };
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
export type Tag = { id: string; name: string; color?: string };
export type ProblemCard = { id: string; content_problem: string; content_insight?: string; notes?: string };
export type CreateTagRequest = { name: string; color?: string; parent_id?: string; tag_type?: string; description?: string };
export type LegacyCreateTagRequest = CreateTagRequest & { parent_tag_id?: string };
import heic2any from 'heic2any';
import { getErrorMessage } from './errorUtils';
import { debugLogger } from './debugLogger';
import { DEBUG_TIMELINE_GLOBAL_KEYS } from '../config/debugPanel';
import { sanitizeDebugMessageList } from './debugSnapshot';
import { debugLog } from '../debug-panel/debugMasterSwitch';
// ★ Canvas Board 类型和 API 已移除（白板模块废弃，2026-01 清理）
// ★ irec 向量索引类型和 API 已移除（灵感图谱废弃，2025-01 清理）

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

export const isTauriRuntime =
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

export const convertHistoryToUnifiedMessages = (history?: ChatMessage[] | null): any[] => {
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

export const sanitizeStringList = (input: any): string[] => {
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
export const withSessionId = (sessionId: string) => ({ session_id: sessionId, sessionId });
// Build args that include both snake_case and camelCase graph id keys to be robust
export const withGraphId = (graphId: string) => ({ graph_id: graphId, graphId });

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
export function buildUnifiedRagOptions(
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
export function buildModelRequestPayload(baseRequest: Record<string, any>, options: {
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
export function stripNullsDeep<T>(input: T): T {
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
