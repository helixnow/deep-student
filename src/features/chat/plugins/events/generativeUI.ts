/**
 * Chat V2 — generative_ui 事件处理插件
 *
 * 流式 JSON 意图写入 block.content；终态权威 intent 写入 toolOutput。
 *
 * 交互作答（awaitAnswer）：
 * - start payload 带 toolCallId 时接管 tool_call_preparing 建的 generative_ui 占位块；
 * - awaitAnswer:true → toolOutput 写 pending 交互；此时用户队列非空 → 立即 dismiss(user_message)；
 * - end payload 带 interaction / answer → 写入 toolOutput（同落库 tool_output 结构可回放）。
 */

import { eventRegistry, type EventHandler } from '../../registry/eventRegistry';
import type { ChatStore } from '../../core/types';
import {
  GENERATIVE_UI_BLOCK_TYPE,
  normalizeGenerativeUIEndIntent,
} from '@/features/generative-ui/bridge/chatBlockBridge';
import {
  finalizeGenerativeUIStream,
  resetGenerativeUIStream,
} from '@/features/generative-ui/bridge/generativeUIStreamRegistry';
import { dismissGenuiAnswer } from '@/features/generative-ui/bridge/genuiInteractionApi';
import {
  buildPendingGenerativeUIInteraction,
  parseGenerativeUIInteraction,
  parseGenerativeUIPersistedAnswer,
} from '@/features/generative-ui/interaction/readInteraction';
import { findPreparingBlockIds } from './toolCall';
import { chunkBuffer } from '../../core/middleware/chunkBuffer';
import { registerGenerativeUIArtifact } from '../../core/store/artifactRegistry';
import {
  findActiveArtifactSkill,
  validateIntentAgainstSkeleton,
} from '../../skills/artifactSkeleton';
import { skillRegistry } from '../../skills/registry';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import i18n from 'i18next';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface GenerativeUIStartPayload {
  title?: unknown;
  toolCallId?: unknown;
  awaitAnswer?: unknown;
}

/**
 * 接管 tool_call_preparing 建的 generative_ui 占位块（方案第 5 节）：
 * 原地换成后端 block_id（保持时间线位置），清掉参数预览 content（随后的 chunk 是完整 intent），
 * 重置以占位块 id 为键的流式解析器。找不到占位块返回 null。
 */
function adoptPreparingBlock(
  store: ChatStore,
  messageId: string,
  toolCallId: string,
  backendBlockId?: string,
): string | null {
  const preparingId = findPreparingBlockIds(store, messageId, toolCallId)[0];
  if (!preparingId) return null;

  let blockId = preparingId;
  if (backendBlockId && backendBlockId !== preparingId) {
    if (store.replaceBlockId) {
      store.replaceBlockId(preparingId, backendBlockId);
      blockId = backendBlockId;
    } else {
      store.deleteBlock?.(preparingId);
      blockId = store.createBlockWithId(messageId, GENERATIVE_UI_BLOCK_TYPE, backendBlockId);
    }
  }

  store.updateBlock(blockId, {
    type: GENERATIVE_UI_BLOCK_TYPE,
    isPreparing: false,
    content: '',
    toolCallId,
    error: undefined,
    toolOutput: undefined,
    endedAt: undefined,
  });
  resetGenerativeUIStream(preparingId);
  store.clearPreparingToolCall?.(messageId);
  return blockId;
}

const generativeUIEventHandler: EventHandler = {
  onStart: (store: ChatStore, messageId: string, payload?: unknown, backendBlockId?: string) => {
    const start = (isRecord(payload) ? payload : {}) as GenerativeUIStartPayload;
    const toolCallId =
      typeof start.toolCallId === 'string' && start.toolCallId.trim() ? start.toolCallId : undefined;

    let blockId = toolCallId
      ? adoptPreparingBlock(store, messageId, toolCallId, backendBlockId)
      : null;
    if (!blockId) {
      blockId = backendBlockId
        ? store.createBlockWithId(messageId, GENERATIVE_UI_BLOCK_TYPE, backendBlockId)
        : store.createBlock(messageId, GENERATIVE_UI_BLOCK_TYPE);
      if (toolCallId) store.updateBlock(blockId, { toolCallId });
    }
    if (toolCallId) store.updateBlockStatus(blockId, 'running');

    if (toolCallId && start.awaitAnswer === true) {
      // 等待作答：写 pending 交互（readGenerativeUIInteraction 据此 + 流状态判定可作答）
      store.updateBlock(blockId, {
        toolOutput: {
          awaitAnswer: true,
          interaction: buildPendingGenerativeUIInteraction(toolCallId),
        },
      });
      // start 前用户已在输入框入队消息：立即让位（后端 yieldTurn 结束本轮，随后队列发出）
      if ((store.queuedMessages?.length ?? 0) > 0 && store.sessionId) {
        void dismissGenuiAnswer(store.sessionId, toolCallId, 'user_message').catch((error: unknown) => {
          console.warn('[GenerativeUI] dismiss on start failed:', error);
        });
      }
    }

    return blockId;
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

    // 交互作答：end 载荷带 interaction（answered/dismissed/cancelled）与 answer（answered 时）。
    // end 缺 interaction 时沿用 start 写入的 pending 交互（由组件按 list_pending 判定中断）。
    const resultRecord = isRecord(result) ? result : undefined;
    const previousOutput = store.blocks.get(blockId)?.toolOutput;
    const previousInteraction = isRecord(previousOutput)
      ? parseGenerativeUIInteraction(previousOutput.interaction)
      : null;
    const interaction =
      parseGenerativeUIInteraction(resultRecord?.interaction) ?? previousInteraction;
    const answer = parseGenerativeUIPersistedAnswer(resultRecord?.answer);
    const awaitAnswer =
      interaction !== null || (isRecord(previousOutput) && previousOutput.awaitAnswer === true);

    if (intent !== null || interaction !== null) {
      store.updateBlock(blockId, {
        toolOutput: {
          ...(intent !== null ? { intent } : {}),
          isStreaming: false,
          ...(awaitAnswer ? { awaitAnswer: true } : {}),
          ...(interaction ? { interaction } : {}),
          ...(answer ? { answer } : {}),
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
      // skeletonRef 来源：live 路径走 executor end 载荷回显（live 块无 toolInput，
      // tool_input 仅持久化到 DB）；toolInput 回退覆盖 restore/测试路径。
      const echoedSkeletonRef =
        result && typeof result === 'object' && 'skeletonRef' in result
          ? (result as { skeletonRef?: unknown }).skeletonRef
          : undefined;
      const skeletonRef =
        typeof echoedSkeletonRef === 'string'
          ? echoedSkeletonRef
          : store.blocks.get(blockId)?.toolInput?.skeletonRef;
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
          const first = check.errors[0];
          const reason = first
            ? i18n.t(`generativeUi:skeleton.err_${first.code}`, first.params)
            : '';
          showGlobalNotification(
            'info',
            i18n.t('generativeUi:skeleton.mismatch_notice', { skillId: match.skillId, reason }),
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
