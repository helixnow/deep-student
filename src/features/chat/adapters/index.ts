/**
 * Chat V2 - Adapters 导出
 *
 * 提供与后端通信的适配器
 */

// 主适配器
export { ChatV2TauriAdapter } from './TauriAdapter';

// 🔧 多会话保活：适配器管理器
export { adapterManager } from './AdapterManager';
export type { AdapterEntry, AdapterManagerEvent, AdapterManagerEventType } from './AdapterManager';

// 类型导出
export type {
  SendOptions,
  SendMessageRequest,
  SessionEventPayload,
  SessionEventType,
  LoadSessionResponse,
  SessionInfo,
  BackendMessage,
  BackendBlock,
  SessionState,
  SessionSettings,
  CreateSessionRequest,
} from './types';

// 辅助函数
export { convertBackendBlock } from './types';
