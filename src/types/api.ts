/**
 * API-specific types
 * Re-exports from the main types file for convenience
 */

export type {
  // Core data models
  /**
   * @deprecated 2026-01 清理：错题功能已废弃，仍有多处引用（见 index.ts 注释）。
   */
  MistakeItem,
  ChatMessage,
  RagSourceInfo,
  
  // API requests/responses
  GeneralChatSessionRequest,
  GeneralChatSessionResponse,
  GenerateChatMetadataResponse,
  ContinueChatResponse,
  
  // API configuration
  ApiConfig,
  ModelAssignments,
  ModelAdapter,
  ChatMetadata,
  
  // Statistics
  Statistics,
} from './index';
