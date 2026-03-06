import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from './errorUtils';
import { debugLogger } from './debugLogger';
import { withGraphId, invokeWithDebug } from './shared';
import type { GraphQueryParams, ForceGraphData } from './shared';
import type { AnkiLibraryCard, AnkiLibraryListResponse, ListAnkiCardsParams, ExportAnkiCardsResult } from '../types';
import { getAppDataDir } from './systemApi';

// ★ irec 向量索引缓存已移除（灵感图谱废弃，2025-01 清理）
/**
 * 统一搜索接口封装
 */
// ★ 图谱模块已废弃 - SearchRequest 本地占位类型
export async function unifiedSearchCards(
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
export async function unifiedGetForceGraphData(
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
export async function tauriInvoke<T = any>(cmd: string, args?: any): Promise<T> {
  return await invokeWithDebug<T>(cmd, args);
}
/**
 * 读取文本文件内容
 */
export async function readFileAsText(path: string): Promise<string> {
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
export async function copyFile(sourcePath: string, destPath: string): Promise<void> {
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
export async function readFileAsBytes(path: string): Promise<Uint8Array> {
  try {
    const bytes = await invoke<number[]>('read_file_bytes', { path });
    return new Uint8Array(bytes);
  } catch (error) {
    console.error('Failed to read binary file:', error);
    throw new Error(`Failed to read binary file: ${error}`);
  }
}

/** 获取文件大小（字节） */
export async function getFileSize(path: string): Promise<number> {
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
export async function copyIntoTextbooksDir(sourcePath: string): Promise<string> {
  const root = await getAppDataDir();
  const { extractFileName } = await import('@/utils/fileManager');
  const fileName = extractFileName(sourcePath) || `textbook_${Date.now()}.pdf`;
  // 使用与 root 一致的路径分隔符，避免 Windows 上产生混合分隔符
  const sep = root.includes('\\') ? '\\' : '/';
  const destPath = [root, 'textbooks', fileName].join(sep);
  try {
    // copy_file 的写入端会自动创建父目录（后端 open_writer 中实现）
    await copyFile(sourcePath, destPath);
    return destPath;
  } catch (error) {
    console.error('Failed to copy to textbook directory:', error);
    throw new Error(`Failed to copy to textbook directory: ${getErrorMessage(error)}`);
  }
}

// ==================== Anki Library ====================
export async function listAnkiLibraryCards(
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

export async function updateAnkiCard(request: {
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

export async function deleteAnkiCard(cardId: string): Promise<boolean> {
  return invoke<boolean>('delete_anki_card', { card_id: cardId });
}

export async function exportAnkiCards(options: {
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

// ==================== 教材库（兼容壳，建议迁移到 textbookDstuAdapter） ====================
/**
 * @deprecated 请改用 `textbookDstuAdapter.addTextbooks()`。
 * 该兼容壳不支持传入 `folderId`，仅为历史调用保留。
 */
export async function textbooksAdd(filePaths: string[]): Promise<Array<{ id: string; name: string; path: string; size: number; addedAt: string }>> {
console.warn('[chatApi] textbooksAdd() is deprecated; use textbookDstuAdapter.addTextbooks() instead.');
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

// ========== Enhanced Chat Search APIs ==========
export async function rebuildChatFts(): Promise<number> {
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
export async function backfillUserMessageEmbeddings(_params: Record<string, unknown>): Promise<number> {
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

export async function searchChatFulltext(params: { query: string; role?: 'user'|'assistant'; limit?: number }): Promise<Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>> {
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

export async function searchChatBasic(params: { query: string; role?: 'user'|'assistant'; limit?: number }): Promise<Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>> {
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

export async function searchChatSemantic(params: { query: string; topK?: number; ftsPrefilter?: boolean }): Promise<Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>> {
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

export async function searchChatCombined(params: { query: string; top_k?: number }): Promise<{ fts: Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}>, semantic: Array<{message_id:number; mistake_id:string; role:string; timestamp:string; text:string; score:number}> }> {
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

export async function getChatIndexStats(): Promise<{ total_fts: number; total_vectors: number; missing_user_embeddings: number }>{
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
export async function researchListReports(params?: { limit?: number }): Promise<Array<{id:string; created_at:string; segments:number; context_window:number}>> {
  const limit = typeof params?.limit === 'number' ? params!.limit : null;
  return await invoke('research_list_reports', { request: { limit } });
}

export async function researchGetReport(id: string): Promise<{ id:string; created_at:string; segments:number; context_window:number; report:string; metadata?: any }>{
  return await invoke('research_get_report', { id });
}

export async function researchDeleteReport(id: string): Promise<boolean> {
  return await invoke('research_delete_report', { id });
}

export async function researchExportAllReportsZip(params: { format: 'md'|'json'; path: string }): Promise<string> {
  const { format, path } = params;
  return await invoke('research_export_all_reports_zip', { request: { format, path } });
}

// ★ 2026-01 清理：continueMistakeChat 和 continueMistakeChatStream 已删除（错题功能废弃）

/** @deprecated R6 废弃 - 后端 command 已移除，仅为 saveRequestHandler 死代码保留编译兼容 */
export async function runtimeAutosaveCommit(_params: any): Promise<any> {
  throw new Error('runtimeAutosaveCommit is deprecated: backend command removed');
}

/** @deprecated R6 废弃 - 后端 command 已移除，仅为 saveRequestHandler 死代码保留编译兼容 */
export async function updateMistake(_item: any): Promise<any> {
  throw new Error('updateMistake is deprecated: backend command removed');
}
