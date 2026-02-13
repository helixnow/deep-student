export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: string;
  thinking_content?: string;
  rag_sources?: Array<{
    document_id: string;
    file_name: string;
    chunk_text: string;
    score: number;
    chunk_index: number;
  }>;
  memory_sources?: Array<{
    document_id: string;
    file_name: string;
    chunk_text: string;
    score: number;
    chunk_index: number;
  }>;
}
export type HostedChatApiProvider = {
  initiateAndGetStreamId: (params: any) => Promise<any>;
  startMainStreaming?: (params: any) => Promise<any>;
  [key: string]: any;
};
export const getStableMessageId = (msg: any, idx: number) => msg.id || msg.persistent_stable_id || `msg-${idx}`;
