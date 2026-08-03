/**
 * Chat V2 - 工作区消息注入事件处理插件
 *
 * 处理 workspace_injection（主代理中途向运行中的子代理注入消息）类型的后端事件。
 *
 * 事件类型：workspace_injection
 * 块类型：workspace_injection
 *
 * 后端契约（C11 注入可见化）：
 * - workspace_injection_start：在子代理会话的当前 assistant 消息上开一个块
 * - workspace_injection_chunk：chunk 为注入的格式化文本（"[工作区消息]\n来自 X: [type] 内容…"）
 * - workspace_injection_end：meta.result = { workspace_id, message_count, senders,
 *   message_types, injected_at }（即持久化的 toolOutput）
 *
 * 约束：
 * - 文件导入即自动注册（自执行）
 */

import { eventRegistry, type EventHandler } from '../../registry/eventRegistry';
import type { ChatStore } from '../../core/types';
import { logChatV2 } from '../../debug/chatV2Logger';

// ============================================================================
// 事件处理器
// ============================================================================

const workspaceInjectionEventHandler: EventHandler = {
  /**
   * 处理 workspace_injection_start 事件
   * 创建 running 状态的 workspace_injection 块
   */
  onStart: (
    store: ChatStore,
    messageId: string,
    _payload?: unknown,
    backendBlockId?: string
  ): string => {
    logChatV2('event', 'middleware', 'workspace_injection_start', {
      messageId,
      backendBlockId,
      sessionId: store.sessionId,
    }, 'info');

    // 后端传了 blockId 则使用它；已存在时直接复用，
    // 避免 createBlockWithId 把同一 ID 再次追加到 message.blockIds
    let blockId: string;
    if (backendBlockId) {
      blockId = store.blocks.has(backendBlockId)
        ? backendBlockId
        : store.createBlockWithId(messageId, 'workspace_injection', backendBlockId);
    } else {
      blockId = store.createBlock(messageId, 'workspace_injection');
    }

    store.updateBlockStatus(blockId, 'running');
    return blockId;
  },

  /**
   * 处理 workspace_injection_chunk 事件
   * chunk 即注入的格式化文本，追加到块内容
   */
  onChunk: (store: ChatStore, blockId: string, chunk: string): void => {
    store.updateBlockContent(blockId, chunk);
  },

  /**
   * 处理 workspace_injection_end 事件
   * meta.result（注入元数据）写入 toolOutput 并置 success
   */
  onEnd: (store: ChatStore, blockId: string, result?: unknown): void => {
    logChatV2('event', 'middleware', 'workspace_injection_end', {
      blockId,
      sessionId: store.sessionId,
    }, 'success');

    // setBlockResult 会解包 { result } 包装、写入 toolOutput 并置 success
    store.setBlockResult(blockId, result);
  },

  /**
   * 处理 workspace_injection_error 事件
   * 保留已注入内容，仅标记错误状态
   */
  onError: (store: ChatStore, blockId: string, error: string): void => {
    logChatV2('event', 'middleware', 'workspace_injection_error', {
      blockId,
      error,
      sessionId: store.sessionId,
    }, 'error');

    store.setBlockError(blockId, error);
  },
};

// ============================================================================
// 自动注册
// ============================================================================

eventRegistry.register('workspace_injection', workspaceInjectionEventHandler);

export { workspaceInjectionEventHandler };
