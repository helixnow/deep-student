/**
 * Chat V2 - SessionManager 类型定义
 *
 * 多会话管理相关的所有类型定义。
 *
 * ## 关于返回类型的说明
 *
 * 文档数据契约中定义 `getOrCreate` 返回 `ChatStore`，
 * 但实际实现返回 `StoreApi<ChatStore>`。
 *
 * 这是因为 Zustand 的设计模式要求：
 * - 使用 `useStore(store, selector)` 进行响应式订阅
 * - 使用 `store.getState()` 获取当前状态
 * - 使用 `store.subscribe()` 手动订阅变化
 *
 * `StoreApi<ChatStore>` 是 Zustand store 的标准类型，
 * 包含了状态管理所需的所有方法。
 *
 * 参考文档 05-多会话管理.md 中的使用示例：
 * ```typescript
 * const store = sessionManager.getOrCreate(sessionId);
 * const messageOrder = useStore(store, s => s.messageOrder);
 * ```
 */

import type { StoreApi } from 'zustand';
import type { ChatStore } from '../types';

/**
 * ChatStore 的 Zustand Store API 类型
 * 这是 sessionManager 实际返回的类型
 */
export type ChatStoreApi = StoreApi<ChatStore>;

// ============================================================================
// SessionManager 类型
// ============================================================================

/**
 * 会话创建选项
 */
export interface CreateSessionOptions {
  /** 会话模式 */
  mode?: string;
  /** 是否预加载历史消息 */
  preload?: boolean;
  /** 初始化配置（传递给 onInit） */
  initConfig?: Record<string, unknown>;
}

/**
 * SessionManager 接口
 *
 * 管理多个 ChatStore 实例，提供 LRU 缓存和生命周期管理。
 */
export interface ISessionManager {
  // ========== 会话管理 ==========

  /**
   * 获取或创建会话 Store
   * - 如果会话已存在，返回现有 Store 并更新 LRU
   * - 如果不存在，创建新 Store
   * - 如果超过 maxSessions，淘汰 LRU（非 streaming）
   *
   * @returns Zustand StoreApi，使用 `useStore(store, selector)` 订阅状态
   */
  getOrCreate(sessionId: string, options?: CreateSessionOptions): ChatStoreApi;

  /**
   * 仅获取会话 Store（不创建）
   *
   * @returns Zustand StoreApi 或 undefined
   */
  get(sessionId: string): ChatStoreApi | undefined;

  /**
   * 检查会话是否存在
   */
  has(sessionId: string): boolean;

  /**
   * 销毁会话
   * - 如果会话正在 streaming，先 abort
   * - 清理资源，从 Map 中移除
   */
  destroy(sessionId: string): Promise<void>;

  /**
   * 销毁所有会话
   */
  destroyAll(): Promise<void>;

  // ========== 当前会话管理（P1-26） ==========

  /**
   * 🔧 P1-26: 设置当前活跃会话 ID
   * 由 UI 层在切换会话时调用
   */
  setCurrentSessionId(sessionId: string | null): void;

  /**
   * 🔧 P1-26: 获取当前活跃会话 ID
   * 用于确定上下文注入等操作应该注入到哪个会话
   */
  getCurrentSessionId(): string | null;

  // ========== 状态查询 ==========

  /**
   * 获取所有正在流式的会话 ID
   */
  getActiveStreamingSessions(): string[];

  /**
   * 获取当前缓存的会话数量
   */
  getSessionCount(): number;

  /**
   * 获取所有会话 ID
   */
  getAllSessionIds(): string[];

  /**
   * 获取会话元数据（内部使用）
   */
  getSessionMeta(sessionId: string): SessionMeta | undefined;

  /**
   * 清除待执行的初始化配置（TauriAdapter 调用）
   */
  clearPendingInitConfig(sessionId: string): void;

  // ========== LRU 管理 ==========

  /**
   * 更新 LRU 顺序（访问时调用）
   */
  touch(sessionId: string): void;

  /**
   * 设置最大缓存数
   */
  setMaxSessions(max: number): void;

  /**
   * 获取最大缓存数
   */
  getMaxSessions(): number;

  // ========== 事件订阅 ==========

  /**
   * 订阅会话变化事件
   * @returns 取消订阅函数
   */
  subscribe(listener: SessionManagerListener): () => void;
}

/**
 * SessionManager 事件类型
 */
export type SessionManagerEventType =
  | 'session-created'
  | 'current-session-changed'
  | 'session-destroyed'
  | 'session-evicted'
  | 'streaming-change';

/**
 * SessionManager 事件
 */
export interface SessionManagerEvent {
  type: SessionManagerEventType;
  sessionId: string;
  /** streaming-change 事件时，表示是否正在流式 */
  isStreaming?: boolean;
}

/**
 * SessionManager 事件监听器
 */
export type SessionManagerListener = (event: SessionManagerEvent) => void;

// ============================================================================
// 内部类型
// ============================================================================

/**
 * 会话元数据（内部使用）
 */
export interface SessionMeta {
  /** 会话 ID */
  sessionId: string;
  /** 创建时间 */
  createdAt: number;
  /** 最后访问时间 */
  lastAccessedAt: number;
  /** 会话模式 */
  mode: string;
  /**
   * 待执行的初始化配置
   * 
   * 🔧 P0修复：initSession 必须在 TauriAdapter.setup() 完成后调用，
   * 所以先保存配置，由 TauriAdapter 在 loadSession 之后调用 initSession。
   */
  pendingInitConfig?: Record<string, unknown>;
}
