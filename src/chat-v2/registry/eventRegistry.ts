/**
 * Chat V2 - 事件处理注册表
 *
 * 管理后端事件处理器的注册和获取
 */

import type { ChatStore } from '../core/types';
import { Registry } from './Registry';

// ============================================================================
// 事件处理器接口
// ============================================================================

/**
 * 事件开始时的 payload 类型
 */
export interface EventStartPayload {
  /** 块类型（可选，默认使用事件的 type） */
  blockType?: string;
  /** 工具名称（工具调用时） */
  toolName?: string;
  /** 工具输入（工具调用时） */
  toolInput?: unknown;
  /** 其他扩展字段 */
  [key: string]: unknown;
}

/**
 * 事件处理器接口
 */
export interface EventHandler {
  /**
   * 事件开始时调用
   * @param store Store 实例
   * @param messageId 消息 ID
   * @param payload 附加数据（包含 blockType）
   * @param backendBlockId 可选，后端传递的 blockId（多工具并发时使用）
   * @returns 如果 backendBlockId 存在则返回它，否则返回前端创建的 blockId
   */
  onStart?: (
    store: ChatStore,
    messageId: string,
    payload: EventStartPayload,
    backendBlockId?: string
  ) => string;

  /**
   * 收到数据块时调用
   * @param store Store 实例
   * @param blockId 块 ID
   * @param chunk 数据块
   */
  onChunk?: (store: ChatStore, blockId: string, chunk: string) => void;

  /**
   * 事件结束时调用
   * @param store Store 实例
   * @param blockId 块 ID
   * @param result 最终结果
   */
  onEnd?: (store: ChatStore, blockId: string, result?: unknown) => void;

  /**
   * 事件错误时调用
   * @param store Store 实例
   * @param blockId 块 ID
   * @param error 错误信息
   */
  onError?: (store: ChatStore, blockId: string, error: string) => void;
}

// ============================================================================
// 事件注册表实例
// ============================================================================

/**
 * 事件处理注册表单例
 */
export const eventRegistry = new Registry<EventHandler>('EventRegistry');
