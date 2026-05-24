/**
 * Chat V2 - Session 模块导出
 *
 * 多会话管理相关的所有导出。
 */

// 类型导出
export type {
  ChatStoreApi,
  ISessionManager,
  CreateSessionOptions,
  SessionManagerEvent,
  SessionManagerEventType,
  SessionManagerListener,
  SessionMeta,
} from './types';

// SessionManager 单例导出
export { sessionManager, getSessionManager } from './sessionManager';
