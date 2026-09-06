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
import { registerGenerativeUIArtifact } from '../../core/store/artifactRegistry';
import {
  findActiveArtifactSkill,
  validateIntentAgainstSkeleton,
} from '../../skills/artifactSkeleton';
import { skillRegistry } from '../../skills/registry';
import { showGlobalNotification } from '@/components/UnifiedNotification';

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

    // P1 产物一等公民化：终态登记进会话产物索引（intent 已写入、status 已 success）。
    // 刷新快照在 registry 内部沿 messageOrder 前溯前一用户消息取得。
    registerGenerativeUIArtifact(store, blockId);

    // P3 产物模板校验（执行面方案 d）：激活 skill 声明了骨架时，对照校验块序列。
    // 不符则降级为普通产物 + 提示（无工具错误通道，零协议改动；产物本身仍保留）。
    // intent 为 string 时表示解析失败的原始文本，无法对照骨架，跳过。
    if (intent !== null && typeof intent !== 'string') {
      const skeletonRef = store.blocks.get(blockId)?.toolInput?.skeletonRef;
      const match = findActiveArtifactSkill(
        store.activeSkillIds ?? [],
        (id) => skillRegistry.get(id),
        typeof skeletonRef === 'string' ? skeletonRef : undefined,
      );
      if (match) {
        const check = validateIntentAgainstSkeleton(intent, match.artifact);
        if (!check.valid) {
          console.warn(
            '[GenerativeUI] 产物不符合 skill 骨架，已降级为普通产物:',
            match.skillId,
            check.errors,
          );
          showGlobalNotification(
            'info',
            `生成内容与「${match.skillId}」模板布局不符，已按普通产物保留（${check.errors[0] ?? ''}）`,
          );
        }
      }
    }
  },

  onError: (store: ChatStore, blockId: string, error: string) => {
    chunkBuffer.flushBlock(store.sessionId, blockId);
    finalizeGenerativeUIStream(blockId);
    store.setBlockError(blockId, error);
  },
};

eventRegistry.register(GENERATIVE_UI_BLOCK_TYPE, generativeUIEventHandler);

export { generativeUIEventHandler };
