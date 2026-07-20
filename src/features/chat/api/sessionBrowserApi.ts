/**
 * 会话浏览器相关命令封装
 *
 * - chat_v2_export_session：会话导出（Markdown / JSON）
 * - chat_v2_search_sessions：会话元信息搜索（标题/描述/标签 LIKE），
 *   与 chat_v2_search_content（FTS5 消息正文搜索）互补。
 */

import { invoke } from '@tauri-apps/api/core';
import type { ChatSession } from '../types/session';

/** chat_v2_export_session 支持的导出格式 */
export type SessionExportFormat = 'markdown' | 'json';

/** 后端 ExportSessionResponse（serde camelCase） */
export interface ExportSessionResponse {
  sessionId: string;
  /** 实际使用的导出格式 */
  format: SessionExportFormat;
  /** 导出内容（Markdown 文本或 JSON 字符串） */
  content: string;
  /** 导出的消息数 */
  messageCount: number;
}

export interface ExportChatSessionInput {
  sessionId: string;
  /** 'markdown'（默认）或 'json' */
  format?: SessionExportFormat;
  /** Markdown 格式下是否包含 thinking 块（默认 false；JSON 恒为全量） */
  includeThinking?: boolean;
}

export function exportChatSession(input: ExportChatSessionInput): Promise<ExportSessionResponse> {
  return invoke<ExportSessionResponse>('chat_v2_export_session', {
    sessionId: input.sessionId,
    format: input.format,
    includeThinking: input.includeThinking,
  });
}

export interface SearchChatSessionsInput {
  /** 搜索词（LIKE 子串匹配，后端已转义 % / _） */
  query: string;
  /** 最多返回条数，默认 50，后端上限 200 */
  limit?: number;
  /** 为 true 时同时命中已归档会话（默认只搜活跃会话） */
  includeArchived?: boolean;
}

export function searchChatSessions(input: SearchChatSessionsInput): Promise<ChatSession[]> {
  return invoke<ChatSession[]>('chat_v2_search_sessions', {
    query: input.query,
    limit: input.limit,
    includeArchived: input.includeArchived,
  });
}
