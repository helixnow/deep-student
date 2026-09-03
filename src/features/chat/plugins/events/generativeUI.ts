/**
 * Chat V2 — generative_ui 事件处理插件
 *
 * 流式 JSON 意图写入 block.content；终态权威 intent 写入 toolOutput。
 */

import { eventRegistry, type EventHandler } from '../../registry/eventRegistry';
import type { ChatStore } from '../../core/types';
import {
  GENERATIVE_UI_BLOCK_TYPE,
  normalizeGenerativeUIEndIntent,
} from '@/features/generative-ui/bridge/chatBlockBridge';
import { finalizeGenerativeUIStream } from '@/features/generative-ui/bridge/generativeUIStreamRegistry';
import { chunkBuffer } from '../../core/middleware/chunkBuffer';

const generativeUIEventHandler: EventHandler = {
  onStart: (store: ChatStore, messageId: string, _payload?: unknown, backendBlockId?: string) => {
    if (backendBlockId) {
      return store.createBlockWithId(messageId, GENERATIVE_UI_BLOCK_TYPE, backendBlockId);
    }
    return store.createBlock(messageId, GENERATIVE_UI_BLOCK_TYPE);
  },

  onChunk: (store: ChatStore, blockId: string, chunk: string) => {
    store.updateBlockContent(blockId, chunk);
  },

  onEnd: (store: ChatStore, blockId: string, result?: unknown) => {
    chunkBuffer.flushBlock(store.sessionId, blockId);
    finalizeGenerativeUIStream(blockId);

    const authoritativeContent =
      result && typeof result === 'object' && 'content' in result
        ? (result as { content?: unknown }).content
        : undefined;

    if (typeof authoritativeContent === 'string') {
      store.updateBlock(blockId, { content: authoritativeContent });
    }

    const rawIntent =
      result && typeof result === 'object' && 'intent' in result
        ? (result as { intent?: unknown }).intent
        : authoritativeContent;

    const intent = normalizeGenerativeUIEndIntent(rawIntent);

    if (intent !== null) {
      store.updateBlock(blockId, {
        toolOutput: {
          intent,
          isStreaming: false,
        },
      });
    }

    store.updateBlockStatus(blockId, 'success');
  },

  onError: (store: ChatStore, blockId: string, error: string) => {
    chunkBuffer.flushBlock(store.sessionId, blockId);
    finalizeGenerativeUIStream(blockId);
    store.setBlockError(blockId, error);
  },
};

eventRegistry.register(GENERATIVE_UI_BLOCK_TYPE, generativeUIEventHandler);

export { generativeUIEventHandler };
