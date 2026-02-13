/**
 * 从 _legacy/chat-core/runtime/attachments.ts 迁移
 * 规范化聊天历史记录格式，用于后端 API 调用
 */

export interface NormalizedMessage {
  id?: string;
  persistent_stable_id?: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: string;
  created_at?: string;
  image_base64?: string[];
  doc_attachments?: Array<{
    name: string;
    mime_type: string;
    size_bytes: number;
    text_content?: string;
    base64_content?: string;
  }>;
  rag_sources?: any[];
  graph_sources?: any[];
  memory_sources?: any[];
  web_search_sources?: any[];
  tool_call?: any;
  tool_result?: any;
  metadata?: any;
}

/**
 * 规范化聊天历史记录，确保格式一致
 */
export function normalizeHistoryForBackend(history: any[]): NormalizedMessage[] {
  if (!history || !Array.isArray(history)) return [];
  
  return history.map((msg, idx) => {
    const result: NormalizedMessage = {
      id: msg.id || msg.persistent_stable_id || `msg-${idx}`,
      persistent_stable_id: msg.persistent_stable_id || msg.id || `msg-${idx}`,
      role: msg.role || 'user',
      content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || ''),
      timestamp: msg.timestamp || msg.created_at || new Date().toISOString(),
    };

    // 可选字段
    if (msg.image_base64) result.image_base64 = msg.image_base64;
    if (msg.doc_attachments) result.doc_attachments = msg.doc_attachments;
    if (msg.rag_sources) result.rag_sources = msg.rag_sources;
    if (msg.graph_sources) result.graph_sources = msg.graph_sources;
    if (msg.memory_sources) result.memory_sources = msg.memory_sources;
    if (msg.web_search_sources) result.web_search_sources = msg.web_search_sources;
    if (msg.tool_call) result.tool_call = msg.tool_call;
    if (msg.tool_result) result.tool_result = msg.tool_result;
    if (msg.metadata || msg._meta) result.metadata = msg.metadata || msg._meta;

    return result;
  });
}
