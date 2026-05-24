/**
 * Chat V2 - Chunk 缓冲器
 *
 * 优化流式更新性能：
 * 1. 收集一定时间窗口内的 chunk
 * 2. 批量合并后一次性更新 Store
 * 3. 减少 Map 创建次数和重渲染频率
 *
 * 性能优化原理：
 * - 原来：每个 chunk 触发一次 Store 更新 → 每个 chunk 创建新 Map
 * - 现在：合并窗口内的 chunk → 减少 Map 创建次数
 *
 * 🔧 P1修复（多会话并发支持）：
 * - 按会话 ID 分组缓冲，避免多会话同时流式时互相干扰
 * - 每个会话维护独立的 store 引用和缓冲区
 */

import type { ChatStore } from '../types';
import { CHUNK_BUFFER_WINDOW_MS, CHUNK_MAX_BUFFER_SIZE } from '../constants';

export interface ChunkBufferConfig {
  bufferWindowMs: number;
  maxBufferSize: number;
}

const DEFAULT_CONFIG: ChunkBufferConfig = {
  bufferWindowMs: CHUNK_BUFFER_WINDOW_MS,
  maxBufferSize: CHUNK_MAX_BUFFER_SIZE,
};

// ============================================================================
// Chunk 缓冲器实现
// ============================================================================

interface BufferedChunk {
  content: string;
  timestamp: number;
}

/**
 * 🔧 P1修复：按会话分组的缓冲结构
 * 每个会话维护独立的 store 引用、缓冲区和定时器
 */
interface SessionBuffer {
  store: ChatStore;
  buffers: Map<string, BufferedChunk>;
  flushTimerId: ReturnType<typeof setTimeout> | null;
}

/**
 * Chunk 缓冲器
 *
 * 🔧 P1修复：支持多会话并发
 * 按 sessionId 分组收集 chunk，定期批量刷新到对应的 Store
 */
class ChunkBufferImpl {
  /** 配置 */
  private config: ChunkBufferConfig;

  /** 🔧 P1修复：按会话 ID 分组的缓冲 */
  private sessions = new Map<string, SessionBuffer>();

  constructor(config: Partial<ChunkBufferConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 设置 Store 引用
   * 🔧 P1修复：为指定会话创建或更新缓冲区
   */
  setStore(store: ChatStore): void {
    const sessionId = store.sessionId;
    
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, {
        store,
        buffers: new Map(),
        flushTimerId: null,
      });
    } else {
      const session = this.sessions.get(sessionId)!;
      session.store = store;
    }
  }

  /**
   * 添加 chunk 到缓冲区
   * 🔧 P1修复：使用指定会话进行缓冲
   * 🔧 P2修复：sessionId 为必传参数，避免多会话并发时 chunk 串流
   *
   * @param blockId 块 ID
   * @param chunk 内容块
   * @param sessionId 目标会话 ID（必传）
   */
  push(blockId: string, chunk: string, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      console.warn('[ChunkBuffer] Session not found:', sessionId);
      return;
    }

    const existing = session.buffers.get(blockId);

    if (existing) {
      existing.content += chunk;
    } else {
      session.buffers.set(blockId, {
        content: chunk,
        timestamp: Date.now(),
      });
    }

    // 检查是否需要立即刷新（超过最大缓冲大小）
    const buffer = session.buffers.get(blockId)!;
    if (buffer.content.length >= this.config.maxBufferSize) {
      this.flushSessionBlock(sessionId, blockId);
    } else {
      this.scheduleSessionFlush(sessionId);
    }
  }

  /**
   * 调度指定会话的延迟刷新
   */
  private scheduleSessionFlush(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.flushTimerId !== null) {
      return; // 已有调度
    }

    session.flushTimerId = setTimeout(() => {
      session.flushTimerId = null;
      this.flushSession(sessionId);
    }, this.config.bufferWindowMs);
  }

  /**
   * 刷新指定会话的单个块
   */
  private flushSessionBlock(sessionId: string, blockId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const buffer = session.buffers.get(blockId);
    if (!buffer) return;

    // 更新对应的 Store
    session.store.updateBlockContent(blockId, buffer.content);

    // 清除缓冲
    session.buffers.delete(blockId);
  }

  /**
   * 刷新指定会话的所有缓冲
   */
  flushSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    // 批量收集所有更新
    const updates: Array<{ blockId: string; content: string }> = [];

    for (const [blockId, buffer] of session.buffers) {
      if (buffer.content) {
        updates.push({ blockId, content: buffer.content });
      }
    }

    // 清空缓冲
    session.buffers.clear();

    // 批量更新 Store
    if (updates.length > 0) {
      const store = session.store;
      if (store.batchUpdateBlockContent) {
        store.batchUpdateBlockContent(updates);
      } else {
        for (const { blockId, content } of updates) {
          store.updateBlockContent(blockId, content);
        }
      }
    }
  }

  /**
   * 刷新所有会话的缓冲（兼容旧 API）
   */
  flushAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.flushSession(sessionId);
    }
  }

  /**
   * 立即刷新所有会话并清理定时器
   */
  forceFlush(): void {
    for (const [sessionId, session] of this.sessions) {
      if (session.flushTimerId !== null) {
        clearTimeout(session.flushTimerId);
        session.flushTimerId = null;
      }
      this.flushSession(sessionId);
    }
  }

  /**
   * 刷新并清理指定会话
   */
  flushAndCleanupSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.flushTimerId !== null) {
      clearTimeout(session.flushTimerId);
      session.flushTimerId = null;
    }
    this.flushSession(sessionId);
    this.sessions.delete(sessionId);
  }

  /**
   * 清理所有（用于重置）
   */
  clear(): void {
    for (const session of this.sessions.values()) {
      if (session.flushTimerId !== null) {
        clearTimeout(session.flushTimerId);
      }
    }
    this.sessions.clear();
  }

  /**
   * 获取缓冲区状态（调试用）
   */
  getStatus(): { sessionCount: number; bufferCount: number; totalSize: number } {
    let bufferCount = 0;
    let totalSize = 0;
    for (const session of this.sessions.values()) {
      bufferCount += session.buffers.size;
      for (const buffer of session.buffers.values()) {
        totalSize += buffer.content.length;
      }
    }
    return {
      sessionCount: this.sessions.size,
      bufferCount,
      totalSize,
    };
  }
}

// ============================================================================
// 单例导出
// ============================================================================

/**
 * 全局 Chunk 缓冲器实例
 */
export const chunkBuffer = new ChunkBufferImpl();

/**
 * 创建新的 Chunk 缓冲器（用于测试或自定义配置）
 */
export function createChunkBuffer(config?: Partial<ChunkBufferConfig>): ChunkBufferImpl {
  return new ChunkBufferImpl(config);
}
