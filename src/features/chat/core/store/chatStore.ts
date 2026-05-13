/**
 * Chat V2 - Store 类型定义
 *
 * 重新导出 ChatStore 相关的类型定义。
 * 实际类型定义在 ../types/store.ts 中。
 */

// 从 types 模块导出 Store 相关类型
export type {
  SessionStatus,
  ChatParams,
  PanelStates,
  ChatStore,
  SessionPersistData,
} from '../types/store';

export {
  createDefaultChatParams,
  createDefaultPanelStates,
  serializeStoreState,
  deserializeStoreState,
} from '../types/store';

// 从本地 types 导出内部类型
export type {
  ChatStoreState,
  SetState,
  GetState,
} from './types';

export {
  createInitialState,
} from './types';
