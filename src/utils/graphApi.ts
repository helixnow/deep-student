/**
 * Knowledge-graph / legacy mistake helpers.
 *
 * ## Deprecation inventory
 * - **owner**: knowledge-graph
 * - **barrel**: 禁止经 `tauriApi.ts` 静态 `export *`（已摘除）；仅保留 TauriAPI 动态包装的 2 个 stream API
 * - **live callers (do NOT delete file yet)**:
 *   - `src/quick-assistant/service.ts` → `bulkImportProblemCards`
 *   - `src/utils/tauriApi.ts` dynamic import → `unifiedImportTagHierarchyStream` /
 *     `unifiedGenerateTagHierarchyPreviewStream` → `NoTagTreeShadPanel`
 * - **remove target**: vNext after migrating those call sites off this module
 */

import { invoke } from '@tauri-apps/api/core';
import { getErrorMessage } from './errorUtils';
import { normalizeHistoryForBackend } from './normalizeHistory';
import { t } from './i18n';
import { v4 as uuidv4 } from 'uuid';
import { withGraphId } from './shared';
import type { Tag, ProblemCard, CreateTagRequest, LegacyCreateTagRequest, TagHierarchy } from './shared';
import type { GraphRecallTestResult } from './types';
import type { ChatMessage, MistakeItem } from '../types';

export async function extractMemoriesFromChat(params: {
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
export async function getPendingMemoryCandidates(conversationId: string): Promise<{
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
export async function dismissPendingMemoryCandidates(conversationId: string): Promise<number> {
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
export async function markPendingMemoryCandidatesSaved(conversationId: string): Promise<number> {
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
export async function graphRecallTest(params: {
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
export async function continueReviewChatStream(params: {
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
export async function trackCardAccess(cardId: string, graphId: string = 'default'): Promise<string> {
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
export async function bulkImportProblemCards(request: {
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
export async function getCardTags(cardId: string, graphId: string = 'default'): Promise<any[]> {
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
          await initialize_knowledge_graph();
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

export async function getCardTagMetrics(
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
          await initialize_knowledge_graph();
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
export async function removeCardTag(cardId: string, tagId: string, graphId: string = 'default') {
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
export async function addCardTag(cardId: string, tagId: string, graphId: string = 'default') {
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
export async function searchExistingTags(
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
export async function getAllTags(graphId: string = 'default'): Promise<any[]> {
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
          await initialize_knowledge_graph();
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
export async function createTag(name: string, parentId?: string, graphId: string = 'default'): Promise<any> {
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
export async function createTagWithParent(input: LegacyCreateTagRequest, graphId: string = 'default') {
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
export async function getTagHierarchy(rootTagId?: string, maxDepth?: number) {
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
export async function updateCardContent(request: {
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
export async function getTagMappingHistory(cardId: string) {
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
export async function getProblemCard(cardId: string, graphId: string = 'default') {
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
export async function mathWorkflowCreateSession(): Promise<string> {
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
export async function unifiedImportTagHierarchyFromContent(jsonContent: string, graphId: string = 'default'): Promise<string> {
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
export async function unifiedImportTagHierarchyStream(markdownContent: string, wrapSingleRoot: boolean = false, eventName?: string, graphId: string = 'default'): Promise<string> {
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
export async function unifiedExportTagHierarchy(graphId: string = 'default'): Promise<string> {
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
export async function unifiedGetTagTreeStats(graphId: string = 'default'): Promise<{
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
export async function unifiedAutoGenerateTagHierarchy(userHint: string, llmMode?: 'model2_raw' | 'model2', modelOverrideId?: string, graphId: string = 'default'): Promise<string> {
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
export async function unifiedGenerateTagHierarchyPreview(userHint: string, llmMode?: 'model2_raw' | 'model2', modelOverrideId?: string, graphId: string = 'default'): Promise<string> {
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
export async function unifiedGenerateTagHierarchyPreviewStream(userHint: string, modelOverrideId?: string, streamEvent?: string, graphId: string = 'default'): Promise<string> {
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

export async function unifiedOutlineUpdateTag(
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

export async function unifiedOutlineMoveTag(
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
export async function graphRecallSubtree(
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
export async function logMetricEvent(
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
function getDefaultGraphConfig() {
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
export async function initialize_knowledge_graph(config?: any): Promise<string> {
  try {
    console.log('Initializing unified SQLite knowledge graph service...');
    
    // Use default SQLite config if none provided
    const defaultConfig = getDefaultGraphConfig();
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
export async function testSQLiteConnection(config?: any): Promise<string> {
  try {
    console.log('Testing SQLite connection...');
    
    const defaultConfig = getDefaultGraphConfig();
    const finalConfig = config || defaultConfig;
    
    // 使用初始化命令来测试连接，因为初始化过程包含连接验证
    const response = await initialize_knowledge_graph(finalConfig);
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
export async function exportKnowledgeGraphData(options: {
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
export async function importKnowledgeGraphData(data: string, mergeStrategy: string = 'merge'): Promise<{
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
export async function exportUnifiedBackupData(options: {
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
export async function getCards(): Promise<Array<{
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
export async function getCardsByTags(tagIds: string[]): Promise<Array<{
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
export async function getCardStats(graphId: string = 'default'): Promise<{
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
export async function unifiedCreateTag(request: CreateTagRequest, graphId: string = 'default') {
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
export async function unifiedUpdateCard(card: ProblemCard, graphId: string = 'default'): Promise<void> {
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
export async function unifiedGetTags(graphId: string = 'default'): Promise<Tag[]> {
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
export async function unifiedGetTagHierarchy(rootTagId?: string | null, graphId: string = 'default'): Promise<TagHierarchy[]> {
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
export async function unifiedGetCardsWithTags(options?: { limit?: number; offset?: number }, graphId: string = 'default'): Promise<Array<[ProblemCard, Tag[]]>> {
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
export async function unifiedDeleteTag(tagId: string, graphId: string = 'default'): Promise<string> {
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
export async function graphUpdateTagDescription(
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
export async function graphReorderTag(
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
export async function graphBatchReorderTags(
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
export async function graphUpdateTagMetadata(params: {
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
export async function clearTagCache(graphId: string = 'default'): Promise<void> {
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
export async function unifiedDeleteCard(cardId: string, graphId: string = 'default'): Promise<boolean> {
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
export async function deleteMemoryIntakeTasks(
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
export async function unifiedSetCardTags(cardId: string, targetTagIds: string[], graphId: string = 'default'): Promise<void> {
  const current = await getCardTags(cardId, graphId).catch(() => []) as any[];
  const currentIds = new Set<string>((current || []).map((t: any) => t?.id || t?.tag?.id).filter(Boolean));
  const targetIds = new Set<string>(targetTagIds);
  // remove
  for (const id of Array.from(currentIds)) {
    if (!targetIds.has(id)) {
      try { await removeCardTag(cardId, id, graphId); } catch {}
    }
  }
  // add
  for (const id of Array.from(targetIds)) {
    if (!currentIds.has(id)) {
      try { await addCardTag(cardId, id, graphId); } catch {}
    }
  }
}

export async function updateCardNotes(cardId: string, notes: string | null): Promise<void> {
  const card = await getProblemCard(cardId) as ProblemCard;
  if (!card) {
    throw new Error("Card not found");
  }

  const updatedCard: ProblemCard = {
    ...card,
    notes: notes ?? undefined,
  };

  await unifiedUpdateCard(updatedCard);
  try {
    window.dispatchEvent(new CustomEvent('graphNoteUpdated', { detail: { cardId, hasNotes: Boolean(notes && notes.trim()) } }));
  } catch {}
}

