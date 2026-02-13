/**
 * 调试专用数据库访问层 API
 * ================================
 * 提供直接读取数据库原始数据的接口，用于调试插件验证数据完整性。
 * 
 * ⚠️ 警告：这些 API 仅供调试使用，不应在正常业务流程中调用。
 */

import { invoke } from '@tauri-apps/api/core';

/**
 * 原始聊天消息（从数据库直接反序列化）
 */
export interface DebugRawChatMessage {
  role: string;
  content: string;
  timestamp: string;
  thinking_content?: string;
  rag_sources?: unknown;
  memory_sources?: unknown;
  graph_sources?: unknown;
  web_search_sources?: unknown;
  image_paths?: string[];
  image_base64?: string[];
  doc_attachments?: unknown;
  tool_call?: unknown;
  tool_result?: unknown;
  overrides?: unknown;
  relations?: unknown;
  persistent_stable_id?: string;
  // P0 修复：添加缺失的关键字段
  textbook_pages?: unknown;
  unified_sources?: unknown;
  _meta?: unknown;
}

/**
 * 错题的原始数据库记录
 */
export interface DebugRawMistakeRecord {
  id: string;
  subject: string;
  created_at: string;
  updated_at: string;
  last_accessed_at: string;
  user_question: string;
  ocr_text: string;
  ocr_note?: string;
  tags: string[];
  mistake_type: string;
  status: string;
  chat_category: string;
  question_images: string[];
  analysis_images: string[];
  mistake_summary?: string;
  user_error_analysis?: string;
  /** @deprecated irec 模块已废弃 */
  irec_card_id?: string;
  /** @deprecated irec 模块已废弃 */
  irec_status?: number;
  chat_metadata?: unknown;
  
  /** 核心：原始聊天历史（JSON 字符串） */
  chat_history_raw_json: string;
  
  /** 反序列化后的聊天历史 */
  chat_history: DebugRawChatMessage[];
}

/**
 * 数据库统计信息
 */
export interface DebugDatabaseStats {
  total_mistakes: number;
  mistakes_with_chat: number;
  total_messages: number;
  messages_with_images: number;
  messages_with_thinking: number;
  messages_with_rag_sources: number;
  messages_with_memory_sources: number;
  messages_with_web_sources: number;
  messages_with_persistent_id: number;
}

/**
 * 数据完整性报告
 */
export interface DebugIntegrityReport {
  mistake_id: string;
  is_valid: boolean;
  message_count: number;
  issues: string[];
  warnings: string[];
  summary: string;
}

/**
 * 调试专用：获取错题的原始数据库记录（绕过业务逻辑）
 * 
 * 与 TauriAPI.getMistakeDetails 的区别：
 * - 不经过任何业务逻辑处理或数据转换
 * - 直接返回数据库中的 JSON 原文
 * - 包含原始的 chat_history JSON 字符串
 * - 用于验证数据库存储是否正确
 * 
 * @param id 错题 ID
 * @returns 原始数据库记录，如果不存在则返回 null
 */
export async function debugGetRawMistake(id: string): Promise<DebugRawMistakeRecord | null> {
  return await invoke<DebugRawMistakeRecord | null>('debug_get_raw_mistake', { id });
}

/**
 * 调试专用：批量获取多个错题的原始记录
 * 
 * @param ids 错题 ID 列表
 * @returns 原始数据库记录列表
 */
export async function debugGetRawMistakesBatch(ids: string[]): Promise<DebugRawMistakeRecord[]> {
  return await invoke<DebugRawMistakeRecord[]>('debug_get_raw_mistakes_batch', { ids });
}

/**
 * 调试专用：获取数据库统计信息
 * 
 * @returns 数据库统计信息
 */
export async function debugGetDatabaseStats(): Promise<DebugDatabaseStats> {
  return await invoke<DebugDatabaseStats>('debug_get_database_stats');
}

/**
 * 调试专用：验证特定错题的数据完整性
 * 
 * 检查项包括：
 * - chat_history JSON 是否可解析
 * - 每条消息的字段完整性
 * - 图片字段的一致性（image_base64 vs content 中的 image_url）
 * - persistent_stable_id 的唯一性
 * - 时间戳顺序
 * 
 * @param id 错题 ID
 * @returns 完整性报告
 */
export async function debugVerifyMistakeIntegrity(id: string): Promise<DebugIntegrityReport> {
  return await invoke<DebugIntegrityReport>('debug_verify_mistake_integrity', { id });
}

