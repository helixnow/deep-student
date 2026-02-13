/**
 * Chat V2 - 中间件层导出
 *
 * 包含：
 * - autoSave: 自动保存中间件
 * - eventBridge: 事件桥接中间件
 * - chunkBuffer: 流式更新缓冲器
 */

// 自动保存中间件
export {
  autoSave,
  createAutoSaveMiddleware,
  type AutoSaveMiddleware,
  type AutoSaveConfig,
} from './autoSave';

// 事件桥接中间件
export {
  // 原有函数（向后兼容）
  handleBackendEvent,
  handleBackendEvents,
  handleStreamComplete,
  handleStreamAbort,
  clearEventContext,
  createStartEvent,
  createChunkEvent,
  createEndEvent,
  createErrorEvent,
  // 多变体支持 (Prompt 9)
  handleBackendEventWithSequence,
  handleBackendEventsWithSequence,
  resetBridgeState,
  clearBridgeState,
  EVENT_TYPE_VARIANT_START,
  EVENT_TYPE_VARIANT_END,
  // 类型
  type BackendEvent,
  type EventPhase,
  type EventContext,
  type EventBridgeState,
} from './eventBridge';

// 流式更新缓冲器
export {
  chunkBuffer,
  createChunkBuffer,
  type ChunkBufferConfig,
} from './chunkBuffer';
