/**
 * Chat V2 - 引用事件系统
 *
 * 用于在正文引用标记点击和来源面板高亮之间建立通信
 */

import type { RetrievalSourceType } from '../plugins/blocks/components/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * 引用高亮事件数据
 */
export interface CitationHighlightEvent {
  /** 来源类型 */
  type: RetrievalSourceType;
  /** 引用索引（从 1 开始） */
  index: number;
  /** 消息 ID（可选，用于定位特定消息的来源面板） */
  messageId?: string;
}

type CitationEventListener = (event: CitationHighlightEvent) => void;

// ============================================================================
// 事件发射器
// ============================================================================

class CitationEventEmitter {
  private listeners: Set<CitationEventListener> = new Set();

  /**
   * 订阅引用高亮事件
   */
  subscribe(listener: CitationEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * 发射引用高亮事件
   */
  emit(event: CitationHighlightEvent): void {
    this.listeners.forEach((listener) => {
      try {
        listener(event);
      } catch (error: unknown) {
        console.error('[CitationEvents] Listener error:', error);
      }
    });
  }

  /**
   * 清除所有监听器
   */
  clear(): void {
    this.listeners.clear();
  }
}

// 全局单例
export const citationEvents = new CitationEventEmitter();

