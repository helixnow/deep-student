import type { Block, BlockType, BlockStatus } from '../types/block';
import type { Message, ReplaySkillPayloadSnapshot } from '../types/message';
import type {
  ChatStore,
  LoadSessionResponseType,
  SessionRestoreBaseline,
} from '../types';
import type { ChatStoreState, SetState, GetState } from './types';
import { createDefaultChatParams, createDefaultPanelStates } from './types';
import { COMPOSER_PANEL_KEYS } from '../types/common';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { sessionSwitchPerf } from '../../debug/sessionSwitchPerf';
import { modeRegistry } from '../../registry';
import { SKILL_INSTRUCTION_TYPE_ID } from '../../skills/types';
import { skillDefaults } from '../../skills/skillDefaults';
import { debugLog } from '@/debug-panel/debugMasterSwitch';
import i18n from 'i18next';
import {
  isWorkbenchToolName,
  markWorkbenchBlockRestored,
  remapWorkbenchBlockType,
} from '@/features/chat/utils/workbenchBlockRemap';
import { revokeAttachmentBlobUrls } from './attachmentBlobUtils';
import { resetTransientRuntimes } from './transientRuntimeRegistry';
import {
  browserToolsSkill,
  builtinToolSkills,
} from '../../skills/builtin-tools';

const console = debugLog as Pick<typeof debugLog, 'log' | 'warn' | 'error' | 'info' | 'debug'>;

type PersistedSkillState = {
  manualPinnedSkillIds?: string[];
  modeRequiredBundleIds?: string[];
  agenticSessionSkillIds?: string[];
  branchLocalSkillIds?: string[];
  version?: number;
};

function parsePersistedSkillState(raw?: string): PersistedSkillState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedSkillState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    console.warn('[ChatStore] Failed to parse skillStateJson, falling back to legacy fields:', error);
    return null;
  }
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : [];
}

const CURRENT_BUILTIN_TOOL_NAMES = new Set([
  'load_skills',
  ...[...builtinToolSkills, browserToolsSkill].flatMap((skill) =>
    (skill.embeddedTools ?? []).map((tool) =>
      tool.name.replace(/^builtin[-:]/, '').replace(/^mcp_/, ''),
    ),
  ),
]);
const CURRENT_BUILTIN_SKILL_IDS = new Set([
  ...builtinToolSkills.map((skill) => skill.id),
  browserToolsSkill.id,
]);

function normalizeHistoricalToolName(toolName: string): string {
  return toolName
    .replace(/^builtin[-:]/, '')
    .replace(/^mcp_/, '')
    .replace(/^mcp\.tools\./, '');
}

function getReplayRuntimeSnapshots(
  message?: LoadSessionResponseType['messages'][number],
): ReplaySkillPayloadSnapshot[] {
  if (!message) return [];
  const snapshots = [
    message._meta?.skillRuntimeBefore,
    message._meta?.skillRuntimeAfter,
    ...(message.variants ?? []).flatMap((variant) => [
      variant.meta?.skillRuntimeBefore,
      variant.meta?.skillRuntimeAfter,
    ]),
  ];
  return snapshots.filter((snapshot): snapshot is ReplaySkillPayloadSnapshot => !!snapshot);
}

/**
 * Very old sessions persisted trusted local tools with the generic `mcp_`
 * prefix. Remap only when replay metadata proves that the tool came from a
 * local schema/built-in skill, and fail closed if any matching external schema
 * carries a serverId. A matching name by itself is deliberately insufficient.
 */
function remapLegacyBuiltinToolName(
  toolName: string | undefined,
  message?: LoadSessionResponseType['messages'][number],
): string | undefined {
  if (!toolName?.startsWith('mcp_')) return toolName;

  const shortName = normalizeHistoricalToolName(toolName);
  if (!CURRENT_BUILTIN_TOOL_NAMES.has(shortName)) return toolName;

  const snapshots = getReplayRuntimeSnapshots(message);
  const hasExternalSource = snapshots.some((snapshot) =>
    (snapshot.mcpToolSchemas ?? []).some((schema) =>
      normalizeHistoricalToolName(schema.name) === shortName
      && schema.serverId !== undefined,
    ),
  );
  if (hasExternalSource) return toolName;

  const hasTrustedLocalSchema = snapshots.some((snapshot) =>
    (snapshot.mcpToolSchemas ?? []).some((schema) =>
      normalizeHistoricalToolName(schema.name) === shortName
      && schema.serverId === undefined,
    ),
  );
  const hasBuiltinSkillEvidence = snapshots.some((snapshot) =>
    Object.entries(snapshot.skillEmbeddedTools ?? {}).some(([skillId, tools]) =>
      CURRENT_BUILTIN_SKILL_IDS.has(skillId)
      && tools.some((tool) => normalizeHistoricalToolName(tool.name) === shortName),
    ),
  );

  return hasTrustedLocalSchema || hasBuiltinSkillEvidence
    ? `builtin-${shortName}`
    : toolName;
}

/**
 * 后端块 → 前端 Block（restoreFromBackend / prependHistoryFromBackend 共用）
 *
 * ACR R2-05：旧库可能把 workbench_* 存成 mcp_tool；恢复时按 toolName remap 为
 * workbench_ops。DB 不存 toolCallId；桥侧 runId 现为 block.id，故 workbench 块用
 * id 回填 toolCallId，便于与 presence/账本候选对齐（账本本身不跨重启）。
 */
function convertBackendBlock(
  blk: LoadSessionResponseType['blocks'][number],
  message?: LoadSessionResponseType['messages'][number],
): Block {
  const toolName = remapLegacyBuiltinToolName(blk.toolName, message);
  const type = remapWorkbenchBlockType(blk.type, toolName) as BlockType;
  const isWorkbench = type === 'workbench_ops' || isWorkbenchToolName(toolName);
  if (isWorkbench) markWorkbenchBlockRestored(blk.id);
  return {
    id: blk.id,
    messageId: blk.messageId,
    type,
    status: blk.status as BlockStatus,
    content: blk.content,
    toolName,
    toolInput: blk.toolInput as Record<string, unknown> | undefined,
    toolOutput: blk.toolOutput,
    citations: blk.citations,
    error: blk.error,
    startedAt: blk.startedAt,
    endedAt: blk.endedAt,
    // 🔧 P3修复：恢复 firstChunkAt 用于排序（保持思维链交替顺序）
    firstChunkAt: blk.firstChunkAt,
    ...(isWorkbench ? { toolCallId: blk.id } : {}),
  };
}

/** 后端消息 → 前端 Message（restoreFromBackend / prependHistoryFromBackend 共用） */
function convertBackendMessage(msg: LoadSessionResponseType['messages'][number]): Message {
  return {
    id: msg.id,
    role: msg.role,
    blockIds: msg.blockIds, // 直接使用后端返回的 blockIds
    timestamp: msg.timestamp,
    persistentStableId: msg.persistentStableId,
    // 🔧 P0 分支模型补齐：后端已返回 parentId/supersedes，此前恢复时被丢弃，
    // 导致分支血缘在刷新/切换会话后不可见。前端只读透传。
    parentId: msg.parentId,
    supersedes: msg.supersedes,
    attachments: msg.attachments,
    // 🔧 修复：后端 serde(rename = "_meta") 序列化，字段名是 _meta
    // 🆕 统一用户消息处理：确保 contextSnapshot 被正确恢复
    _meta: msg._meta
      ? {
          modelId: msg._meta.modelId,
          // 🔒 审计修复: 添加 modelDisplayName 恢复（原代码遗漏此字段，
          // 导致恢复后消息显示模型 ID 而非用户友好名称）
          modelDisplayName: msg._meta.modelDisplayName,
          chatParams: msg._meta.chatParams,
          usage: msg._meta.usage,
          contextSnapshot: msg._meta.contextSnapshot,
          skillSnapshotBefore: msg._meta.skillSnapshotBefore,
          skillSnapshotAfter: msg._meta.skillSnapshotAfter,
          skillRuntimeBefore: msg._meta.skillRuntimeBefore,
          skillRuntimeAfter: msg._meta.skillRuntimeAfter,
          replaySource: msg._meta.replaySource,
        }
      : undefined,
    // 🔧 变体字段恢复
    activeVariantId: msg.activeVariantId,
    variants: msg.variants,
    sharedContext: msg.sharedContext,
  };
}

/**
 * Insert backend-only IDs around IDs that already exist in the live order.
 * Live-only IDs retain their relative order. With no shared anchor, backend
 * IDs are treated as the persisted prefix and live IDs as newer additions.
 */
function mergeAnchoredReferenceOrder(
  currentOrder: readonly string[],
  backendOrder: readonly string[],
): string[] {
  const dedupedCurrent = Array.from(new Set(currentOrder));
  const currentPosition = new Map(dedupedCurrent.map((id, index) => [id, index]));
  const seenBackend = new Set<string>();
  const responseOrder = backendOrder.filter((id) => {
    if (seenBackend.has(id)) return false;
    seenBackend.add(id);
    return true;
  });
  const missingIds = responseOrder.filter((id) => !currentPosition.has(id));
  if (missingIds.length === 0) return dedupedCurrent;

  const hasSharedAnchor = responseOrder.some((id) => currentPosition.has(id));
  if (!hasSharedAnchor) {
    return [...missingIds, ...dedupedCurrent];
  }

  const nextAnchorPositions: Array<number | undefined> = new Array(responseOrder.length);
  let nextAnchor: number | undefined;
  for (let index = responseOrder.length - 1; index >= 0; index--) {
    nextAnchorPositions[index] = nextAnchor;
    const position = currentPosition.get(responseOrder[index]);
    if (position !== undefined) nextAnchor = position;
  }

  const previousAnchorPositions: Array<number | undefined> = new Array(responseOrder.length);
  let previousAnchor: number | undefined;
  for (let index = 0; index < responseOrder.length; index++) {
    previousAnchorPositions[index] = previousAnchor;
    const position = currentPosition.get(responseOrder[index]);
    if (position !== undefined) previousAnchor = position;
  }

  const buckets = new Map<number, string[]>();
  for (let index = 0; index < responseOrder.length; index++) {
    const id = responseOrder[index];
    if (currentPosition.has(id)) continue;
    const gap = nextAnchorPositions[index]
      ?? (previousAnchorPositions[index] !== undefined
        ? previousAnchorPositions[index]! + 1
        : 0);
    const bucket = buckets.get(gap);
    if (bucket) bucket.push(id);
    else buckets.set(gap, [id]);
  }

  const merged: string[] = [];
  for (let gap = 0; gap <= dedupedCurrent.length; gap++) {
    const bucket = buckets.get(gap);
    if (bucket) merged.push(...bucket);
    if (gap < dedupedCurrent.length) merged.push(dedupedCurrent[gap]);
  }
  return merged;
}

function hasSameIdOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function mergeExistingMessageReferences(
  currentMessage: Message,
  backendMessage: LoadSessionResponseType['messages'][number],
  availableBlockIds: ReadonlySet<string>,
): Message {
  const backendBlockIds = backendMessage.blockIds.filter((id) => availableBlockIds.has(id));
  const blockIds = mergeAnchoredReferenceOrder(currentMessage.blockIds, backendBlockIds);

  const currentVariants = currentMessage.variants ?? [];
  const backendVariants = backendMessage.variants ?? [];
  if (backendVariants.length === 0) {
    return hasSameIdOrder(blockIds, currentMessage.blockIds)
      ? currentMessage
      : { ...currentMessage, blockIds };
  }

  const currentVariantById = new Map(currentVariants.map((variant) => [variant.id, variant]));
  const mergedVariantById = new Map(currentVariantById);
  for (const backendVariant of backendVariants) {
    const currentVariant = currentVariantById.get(backendVariant.id);
    const filteredBackendBlockIds = backendVariant.blockIds.filter((id) => availableBlockIds.has(id));
    if (currentVariant) {
      mergedVariantById.set(backendVariant.id, {
        ...backendVariant,
        ...currentVariant,
        blockIds: mergeAnchoredReferenceOrder(currentVariant.blockIds, filteredBackendBlockIds),
      });
    } else {
      mergedVariantById.set(backendVariant.id, {
        ...backendVariant,
        blockIds: filteredBackendBlockIds,
      });
    }
  }

  const variantOrder = mergeAnchoredReferenceOrder(
    currentVariants.map((variant) => variant.id),
    backendVariants.map((variant) => variant.id),
  );
  const variants = variantOrder
    .map((id) => mergedVariantById.get(id))
    .filter((variant): variant is NonNullable<(typeof currentVariants)[number]> => !!variant);

  const variantsUnchanged =
    variants.length === currentVariants.length
    && variants.every((variant, index) => {
      const currentVariant = currentVariants[index];
      return currentVariant === variant
        || (
          currentVariant.id === variant.id
          && hasSameIdOrder(currentVariant.blockIds, variant.blockIds)
          && currentVariant.status === variant.status
          && currentVariant.error === variant.error
        );
    });

  if (hasSameIdOrder(blockIds, currentMessage.blockIds) && variantsUnchanged) {
    return currentMessage;
  }

  return {
    ...currentMessage,
    blockIds,
    variants,
  };
}

function shouldRestoreMissingMessage(
  message: LoadSessionResponseType['messages'][number],
  baseline?: SessionRestoreBaseline,
): boolean {
  if (!baseline) return true;
  if (baseline.messageIds.has(message.id)) return false;
  if (
    baseline.oldestMessageTimestamp !== undefined
    && message.timestamp >= baseline.oldestMessageTimestamp
  ) {
    // Full-history completion is expected to add messages before the loaded
    // tail. A same/newer missing row was removed locally or created by a stale
    // backend snapshot and must not be resurrected.
    return false;
  }
  return true;
}

function hasIdentitySetChanged(
  currentIds: Iterable<string>,
  baselineIds: ReadonlySet<string>,
): boolean {
  const currentSet = currentIds instanceof Set ? currentIds : new Set(currentIds);
  if (currentSet.size !== baselineIds.size) return true;
  for (const id of currentSet) {
    if (!baselineIds.has(id)) return true;
  }
  return false;
}

function filterSkillInstructionRefsWhenStructuredStateExists(
  refs: import('../../context/types').ContextRef[],
  state?: LoadSessionResponseType['state'],
): import('../../context/types').ContextRef[] {
  if (!state?.skillStateJson) {
    return refs;
  }
  return refs.filter((ref) => ref.typeId !== SKILL_INSTRUCTION_TYPE_ID);
}

function getRestoredActiveSkillIds(state?: LoadSessionResponseType['state']): string[] {
  const parsedSkillState = parsePersistedSkillState(state?.skillStateJson);
  const fromStructured = normalizeStringArray(parsedSkillState?.manualPinnedSkillIds);
  if (fromStructured.length > 0) {
    return fromStructured;
  }

  if (!state?.activeSkillIdsJson) {
    return [];
  }

  try {
    return normalizeStringArray(JSON.parse(state.activeSkillIdsJson));
  } catch (error) {
    console.warn('[ChatStore] Failed to parse activeSkillIdsJson, falling back to empty:', error);
    return [];
  }
}

function getRestoredLoadedSkillIds(state?: LoadSessionResponseType['state']): string[] {
  const parsedSkillState = parsePersistedSkillState(state?.skillStateJson);
  const fromStructured = [
    ...normalizeStringArray(parsedSkillState?.agenticSessionSkillIds),
    ...normalizeStringArray(parsedSkillState?.modeRequiredBundleIds),
  ];

  if (fromStructured.length > 0) {
    return Array.from(new Set(fromStructured));
  }

  if (!state?.loadedSkillIdsJson) {
    return [];
  }

  try {
    return normalizeStringArray(JSON.parse(state.loadedSkillIdsJson));
  } catch (error) {
    console.warn('[ChatStore] Failed to parse loadedSkillIdsJson, falling back to empty:', error);
    return [];
  }
}

/**
 * Merge missing backend messages without assuming they all predate the current
 * window. Backend neighbours provide stable anchors; timestamps place messages
 * among local-only entries inside those bounds.
 */
export function mergeHistoryMessageOrder(
  currentOrder: string[],
  currentMessages: ReadonlyMap<string, Message>,
  backendMessages: LoadSessionResponseType['messages'],
): string[] {
  const messageById = new Map<string, Pick<Message, 'timestamp'>>();
  for (const [id, message] of currentMessages) {
    messageById.set(id, message);
  }
  for (const message of backendMessages) {
    messageById.set(message.id, message);
  }

  const seenResponseIds = new Set<string>();
  const responseOrder = backendMessages
    .map((message, index) => ({ message, index }))
    .sort((a, b) => a.message.timestamp - b.message.timestamp || a.index - b.index)
    .map(({ message }) => message.id)
    .filter((id) => {
      if (seenResponseIds.has(id)) return false;
      seenResponseIds.add(id);
      return true;
    });
  const currentPosition = new Map(currentOrder.map((id, index) => [id, index]));

  // Precompute response neighbours that already exist in the live order. This
  // makes anchor lookup O(1) for every missing message.
  const previousAnchorPositions: Array<number | undefined> = new Array(responseOrder.length);
  const nextAnchorPositions: Array<number | undefined> = new Array(responseOrder.length);
  let anchorPosition: number | undefined;
  for (let index = 0; index < responseOrder.length; index++) {
    previousAnchorPositions[index] = anchorPosition;
    const currentIndex = currentPosition.get(responseOrder[index]);
    if (currentIndex !== undefined) anchorPosition = currentIndex;
  }
  anchorPosition = undefined;
  for (let index = responseOrder.length - 1; index >= 0; index--) {
    nextAnchorPositions[index] = anchorPosition;
    const currentIndex = currentPosition.get(responseOrder[index]);
    if (currentIndex !== undefined) anchorPosition = currentIndex;
  }

  let currentOrderIsChronological = true;
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  for (const messageId of currentOrder) {
    const timestamp = messageById.get(messageId)?.timestamp;
    if (timestamp === undefined) continue;
    if (timestamp < previousTimestamp) {
      currentOrderIsChronological = false;
      break;
    }
    previousTimestamp = timestamp;
  }

  const gapBuckets = new Map<number, string[]>();
  for (let responseIndex = 0; responseIndex < responseOrder.length; responseIndex++) {
    const messageId = responseOrder[responseIndex];
    if (currentPosition.has(messageId)) continue;

    const previousAnchor = previousAnchorPositions[responseIndex];
    const nextAnchor = nextAnchorPositions[responseIndex];
    let lowerBound = previousAnchor !== undefined ? previousAnchor + 1 : 0;
    let upperBound = nextAnchor ?? currentOrder.length;
    if (upperBound < lowerBound) {
      lowerBound = 0;
      upperBound = currentOrder.length;
    }

    let gap: number;
    if (currentOrderIsChronological) {
      const timestamp = messageById.get(messageId)?.timestamp ?? Number.POSITIVE_INFINITY;
      let low = lowerBound;
      let high = upperBound;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        const candidateTimestamp =
          messageById.get(currentOrder[middle])?.timestamp ?? Number.POSITIVE_INFINITY;
        if (candidateTimestamp <= timestamp) {
          low = middle + 1;
        } else {
          high = middle;
        }
      }
      gap = low;
    } else {
      // Corrupt/legacy timestamp order: preserve the live order and use the
      // nearest backend neighbour as the deterministic insertion anchor.
      gap = nextAnchor ?? (previousAnchor !== undefined ? previousAnchor + 1 : currentOrder.length);
    }

    const bucket = gapBuckets.get(gap);
    if (bucket) bucket.push(messageId);
    else gapBuckets.set(gap, [messageId]);
  }

  if (gapBuckets.size === 0) return currentOrder;

  const merged: string[] = [];
  for (let gap = 0; gap <= currentOrder.length; gap++) {
    const bucket = gapBuckets.get(gap);
    if (bucket) merged.push(...bucket);
    if (gap < currentOrder.length) merged.push(currentOrder[gap]);
  }
  return merged;
}

export function createRestoreActions(
  set: SetState,
  getState: GetState,
) {
  // 🔧 P1 修复（2026-07-08 审阅 20 P1-3）：恢复代际计数器（每 store 实例一份闭包）。
  // restoreFromBackend 的异步恢复链跨多次网络级 await，期间用户可能编辑上下文引用
  // 或再次触发 loadSession；每次 set 前用代际 + sessionId 双重校验丢弃过期写回。
  let restoreGeneration = 0;

  return {
        /**
         * 尾部分块加载第二阶段：把全量响应中的缺失历史合并到正确位置。
         * 只补 messageMap/messageOrder/blocks，不触碰运行时状态。
         */
        prependHistoryFromBackend: (
          response: LoadSessionResponseType,
          baseline?: SessionRestoreBaseline,
        ): void => {
          const current = getState();
          // 会话已切换或数据未就绪时丢弃（补齐请求可能晚于切换返回）
          if (current.sessionId !== response.session.id || !current.isDataLoaded) {
            return;
          }

          const missingMessages = response.messages.filter(
            (msg) => !current.messageMap.has(msg.id) && shouldRestoreMissingMessage(msg, baseline),
          );
          const retainedMessageIds = new Set(current.messageMap.keys());
          for (const message of missingMessages) retainedMessageIds.add(message.id);

          // Blocks belonging to a message that was deleted while the request
          // was in flight are excluded with that message. A block that existed
          // at request start but is now gone is also treated as an intentional
          // live deletion and is not resurrected.
          let blocksChanged = false;
          const messageMap = new Map(current.messageMap);
          const blocksMap = new Map(current.blocks);
          const backendMessageById = new Map(
            response.messages.map((message) => [message.id, message]),
          );
          for (const blk of response.blocks) {
            if (blocksMap.has(blk.id)) continue;
            if (!retainedMessageIds.has(blk.messageId)) continue;
            if (baseline?.blockIds.has(blk.id)) continue;
            blocksMap.set(blk.id, convertBackendBlock(blk, backendMessageById.get(blk.messageId)));
            blocksChanged = true;
          }

          const availableBlockIds = new Set(blocksMap.keys());
          let messagesChanged = false;
          for (const msg of response.messages) {
            const currentMessage = messageMap.get(msg.id);
            if (!currentMessage) {
              if (!retainedMessageIds.has(msg.id)) continue;
              const converted = convertBackendMessage(msg);
              messageMap.set(msg.id, {
                ...converted,
                blockIds: converted.blockIds.filter((id) => availableBlockIds.has(id)),
                variants: converted.variants?.map((variant) => ({
                  ...variant,
                  blockIds: variant.blockIds.filter((id) => availableBlockIds.has(id)),
                })),
              });
              messagesChanged = true;
              continue;
            }

            const mergedMessage = mergeExistingMessageReferences(
              currentMessage,
              msg,
              availableBlockIds,
            );
            if (mergedMessage !== currentMessage) {
              messageMap.set(msg.id, mergedMessage);
              messagesChanged = true;
            }
          }

          const retainedBackendMessages = response.messages.filter((msg) => retainedMessageIds.has(msg.id));
          const messageOrder = mergeHistoryMessageOrder(
            current.messageOrder,
            messageMap,
            retainedBackendMessages,
          );
          const orderChanged = !hasSameIdOrder(messageOrder, current.messageOrder);
          if (
            !messagesChanged
            && !blocksChanged
            && !orderChanged
          ) {
            return;
          }

          set({
            messageMap,
            messageOrder,
            blocks: blocksMap,
          });

          console.log(
            '[ChatStore] Merged history from backend:',
            response.session.id,
            `+${missingMessages.length} messages`
          );
        },
        restoreFromBackend: (
          response: LoadSessionResponseType,
          baseline?: SessionRestoreBaseline,
        ): void => {
          const { session, messages, blocks, state } = response;
          const t0 = performance.now();

          // 🔧 P1: 递增恢复代际；后续异步链的每次写回前校验代际与会话未变
          const thisRestoreGeneration = ++restoreGeneration;
          const isRestoreStale = (): boolean =>
            restoreGeneration !== thisRestoreGeneration || getState().sessionId !== session.id;

          // 1. 按 timestamp 排序消息（确保消息顺序正确）
          const tSortStart = performance.now();
          const sortedMessages = [...messages].sort(
            (a, b) => a.timestamp - b.timestamp
          );
          const tSortEnd = performance.now();
          sessionSwitchPerf.mark('set_data_start', {
            phase: 'sort_messages',
            ms: tSortEnd - tSortStart,
          });

          // 2. 转换块数据（先处理，后面可能需要添加从 sources 恢复的块）
          const tBlockMapStart = performance.now();
          const blocksMap = new Map<string, Block>();
          const backendMessageById = new Map(messages.map((message) => [message.id, message]));
          for (const blk of blocks) {
            blocksMap.set(blk.id, convertBackendBlock(blk, backendMessageById.get(blk.messageId)));
          }
          const tBlockMapEnd = performance.now();
          sessionSwitchPerf.mark('set_data_end', {
            phase: 'build_blocks_map',
            ms: tBlockMapEnd - tBlockMapStart,
            blockCount: blocksMap.size,
          });

          // 3. 转换消息数据
          // 注意：所有块（包括检索块、工具调用块等）现在都统一存储在 blocks 表中，
          // 直接通过 msg.blockIds 引用，无需从 meta 中恢复
          const tMsgMapStart = performance.now();
          const messageMap = new Map<string, Message>();
          const messageOrder: string[] = [];

          for (const msg of sortedMessages) {
            messageMap.set(msg.id, convertBackendMessage(msg));
            messageOrder.push(msg.id);
          }
          const tMsgMapEnd = performance.now();
          sessionSwitchPerf.mark('set_data_end', {
            phase: 'build_messages_map',
            ms: tMsgMapEnd - tMsgMapStart,
            messageCount: messageOrder.length,
          });

          // 4. 转换状态数据
          // P1 修复：使用字段级合并而非整体替换，防止后端返回的部分字段为 null 时丢失默认值
          const chatParams = {
            ...createDefaultChatParams(),
            ...(state?.chatParams ?? {}),
          };
          const features = new Map(Object.entries(state?.features ?? {}));
          // 只接收当前已知的面板 key，过滤旧持久化数据中已下线的幽灵面板
          // （'rag'/'search'/'learn' 等），避免恢复出无渲染路径的 true 状态
          const persistedPanelStates = (state?.panelStates ?? {}) as Record<string, unknown>;
          const panelStates = createDefaultPanelStates();
          COMPOSER_PANEL_KEYS.forEach((panel) => {
            if (typeof persistedPanelStates[panel] === 'boolean') {
              panelStates[panel] = persistedPanelStates[panel] as boolean;
            }
          });
          const modeState = state?.modeState ?? null;
          const inputValue = state?.inputValue ?? '';

          // 🆕 Prompt 7: 恢复待发送的上下文引用
          //
          // 🛡️ 鲁棒性改造：多级降级解析，防止 JSON 异常导致引用丢失
          //
          // 策略：
          // 1. 标准 JSON.parse
          // 2. 逐个元素解析（处理数组部分损坏）
          // 3. 字符串扫描提取 ContextRef 对象（安全的非正则方法，防止 ReDoS）
          // 4. 详细日志记录 + 用户通知
          let pendingContextRefs: import('../../context/types').ContextRef[] = [];
          let parseResult: 'success' | 'partial' | 'failed' = 'success';

          if (state?.pendingContextRefsJson) {
            // 📊 解析统计
            const stats = {
              originalLength: state.pendingContextRefsJson.length,
              parsedCount: 0,
              failedCount: 0,
              method: '' as 'standard' | 'incremental' | 'string-scan' | 'none',
            };

            try {
              // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
              // 第一级：标准 JSON.parse
              // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
              const parsed = JSON.parse(state.pendingContextRefsJson);

              // 验证是否为数组
              if (!Array.isArray(parsed)) {
                throw new Error('Parsed result is not an array');
              }

              // 验证并过滤有效的 ContextRef
              const validated = parsed.filter((item: unknown): item is import('../../context/types').ContextRef => {
                return isValidContextRef(item);
              });

              // ★ P0-03 补齐旧数据迁移：历史数据可能没有 isSticky 字段
              // - legacy skill_instruction 仅作历史兼容读取，不再作为运行时真相源
              pendingContextRefs = filterSkillInstructionRefsWhenStructuredStateExists(validated.map((ref) => {
                if (ref.typeId === SKILL_INSTRUCTION_TYPE_ID) {
                  return { ...ref, isSticky: true };
                }
                return ref;
              }), state);
              stats.parsedCount = validated.length;
              stats.failedCount = parsed.length - validated.length;
              stats.method = 'standard';

              console.log('[ChatStore] ✅ Restored pendingContextRefs (standard):', {
                total: validated.length,
                failed: stats.failedCount,
              });

            } catch (standardError) {
              console.warn('[ChatStore] ⚠️ Standard JSON.parse failed, trying incremental parse...', standardError);

              try {
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                // 第二级：逐个元素解析（处理数组部分损坏）
                // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                const jsonStr = state.pendingContextRefsJson.trim();

                // 检查是否是数组格式
                if (!jsonStr.startsWith('[') || !jsonStr.endsWith(']')) {
                  throw new Error('Not an array format');
                }

                // 提取数组内容（去除首尾方括号）
                const arrayContent = jsonStr.slice(1, -1).trim();

                if (arrayContent) {
                  // 尝试提取每个对象
                  // 使用更健壮的方法：查找所有顶层的 {...} 对象
                  const objectMatches: string[] = [];
                  let depth = 0;
                  let startIdx = -1;

                  for (let i = 0; i < arrayContent.length; i++) {
                    const char = arrayContent[i];

                    if (char === '{') {
                      if (depth === 0) {
                        startIdx = i;
                      }
                      depth++;
                    } else if (char === '}') {
                      depth--;
                      if (depth === 0 && startIdx !== -1) {
                        objectMatches.push(arrayContent.substring(startIdx, i + 1));
                        startIdx = -1;
                      }
                    }
                  }

                  if (objectMatches && objectMatches.length > 0) {
                    const incrementalRefs: import('../../context/types').ContextRef[] = [];

                    for (const objStr of objectMatches) {
                      try {
                        const obj = JSON.parse(objStr);
                        if (isValidContextRef(obj)) {
                          incrementalRefs.push(obj);
                          stats.parsedCount++;
                        } else {
                          stats.failedCount++;
                          console.warn('[ChatStore] Invalid ContextRef object:', obj);
                        }
                      } catch (itemError) {
                        stats.failedCount++;
                        console.warn('[ChatStore] Failed to parse individual item:', objStr, itemError);
                      }
                    }

                    if (incrementalRefs.length > 0) {
                      // ★ P0-03 补齐旧数据迁移：历史数据可能没有 isSticky 字段
                      pendingContextRefs = filterSkillInstructionRefsWhenStructuredStateExists(incrementalRefs.map((ref) => {
                        if (ref.typeId === SKILL_INSTRUCTION_TYPE_ID) {
                          return { ...ref, isSticky: true };
                        }
                        return ref;
                      }), state);
                      stats.method = 'incremental';
                      parseResult = stats.failedCount > 0 ? 'partial' : 'success';

                      console.log('[ChatStore] ✅ Restored pendingContextRefs (incremental):', {
                        total: incrementalRefs.length,
                        failed: stats.failedCount,
                      });
                    } else {
                      throw new Error('No valid objects found in incremental parse');
                    }
                  } else {
                    throw new Error('No object patterns found');
                  }
                } else {
                  // 空数组
                  pendingContextRefs = [];
                  stats.method = 'incremental';
                  console.log('[ChatStore] Empty array detected');
                }

              } catch (incrementalError) {
                console.warn('[ChatStore] ⚠️ Incremental parse failed, trying string scanning extraction...', incrementalError);

                try {
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                  // 第三级：字符串扫描提取 ContextRef（安全的非正则方法）
                  //
                  // 安全设计说明：
                  // 1. 完全避免复杂正则表达式，防止 ReDoS 攻击
                  // 2. 使用简单的字符扫描，时间复杂度 O(n)
                  // 3. 添加超时保护机制，防止长时间运行
                  // 4. 对每个候选对象进行安全的 JSON 解析
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

                  // 性能监控：记录开始时间
                  const scanStartTime = performance.now();
                  const SCAN_TIMEOUT_MS = 5000; // 5秒超时保护

                  /**
                   * 从字符串中提取可能的 ContextRef 对象
                   * 使用简单的字符扫描，避免正则表达式回溯问题
                   */
                  const extractPossibleContextRefs = (jsonString: string): import('../../context/types').ContextRef[] => {
                    const refs: import('../../context/types').ContextRef[] = [];
                    let i = 0;
                    let objectsScanned = 0;
                    const maxObjectsToScan = 10000; // 最多扫描10000个对象，防止无限循环

                    while (i < jsonString.length) {
                      // 超时检查
                      if (performance.now() - scanStartTime > SCAN_TIMEOUT_MS) {
                        console.warn('[ChatStore] ⚠️ String scanning timeout, returning partial results');
                        break;
                      }

                      // 对象数量限制检查
                      if (objectsScanned >= maxObjectsToScan) {
                        console.warn('[ChatStore] ⚠️ Max objects scanned limit reached, returning partial results');
                        break;
                      }

                      // 查找对象开始位置
                      const start = jsonString.indexOf('{', i);
                      if (start === -1) break;

                      // 查找匹配的结束大括号（使用深度计数）
                      let depth = 0;
                      let end = start;
                      let foundEnd = false;

                      // 扫描最多1000个字符，防止单个对象过大
                      const maxScanLength = 1000;
                      const scanLimit = Math.min(start + maxScanLength, jsonString.length);

                      for (let j = start; j < scanLimit; j++) {
                        const char = jsonString[j];

                        if (char === '{') {
                          depth++;
                        } else if (char === '}') {
                          depth--;
                          if (depth === 0) {
                            end = j + 1;
                            foundEnd = true;
                            break;
                          }
                        }
                      }

                      if (foundEnd) {
                        const candidate = jsonString.substring(start, end);
                        objectsScanned++;

                        // 快速预检：必须包含所有必需字段
                        if (
                          candidate.includes('"resourceId"') &&
                          candidate.includes('"hash"') &&
                          candidate.includes('"typeId"')
                        ) {
                          // 尝试安全解析
                          try {
                            const obj = JSON.parse(candidate);

                            // 验证是否为有效的 ContextRef
                            if (isValidContextRef(obj)) {
                              refs.push(obj);
                              stats.parsedCount++;
                            } else {
                              stats.failedCount++;
                            }
                          } catch (parseError) {
                            // JSON 解析失败，继续扫描
                            stats.failedCount++;
                          }
                        }

                        // 移动到下一个位置
                        i = end;
                      } else {
                        // 没有找到匹配的结束大括号，跳过这个开始位置
                        i = start + 1;
                      }
                    }

                    return refs;
                  };

                  // 执行字符串扫描提取
                  const scanRefs = extractPossibleContextRefs(state.pendingContextRefsJson);
                  const scanDuration = performance.now() - scanStartTime;

                  if (scanRefs.length > 0) {
                    // ★ P0-03 补齐旧数据迁移：历史数据可能没有 isSticky 字段
                    pendingContextRefs = filterSkillInstructionRefsWhenStructuredStateExists(scanRefs.map((ref) => {
                      if (ref.typeId === SKILL_INSTRUCTION_TYPE_ID) {
                        return { ...ref, isSticky: true };
                      }
                      return ref;
                    }), state);
                    stats.method = 'string-scan';
                    parseResult = 'partial'; // 字符串扫描一定是部分恢复

                    console.log('[ChatStore] ✅ Restored pendingContextRefs (string-scan):', {
                      total: scanRefs.length,
                      failed: stats.failedCount,
                      durationMs: scanDuration.toFixed(2),
                      performance: scanDuration < 100 ? '🚀 excellent' : scanDuration < 500 ? '✅ good' : '⚠️ slow',
                    });
                  } else {
                    throw new Error('No valid refs extracted by string scanning');
                  }

                } catch (scanError) {
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                  // 所有方法都失败
                  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
                  stats.method = 'none';
                  parseResult = 'failed';

                  console.error('[ChatStore] ❌ All parse methods failed:', {
                    standardError,
                    incrementalError,
                    scanError,
                    originalJson: state.pendingContextRefsJson.substring(0, 500) + '...', // 只记录前500字符
                  });
                }
              }
            }

            // 📊 最终统计日志
            console.log('[ChatStore] Pending context refs parse summary:', {
              parseResult,
              stats,
              finalCount: pendingContextRefs.length,
            });

            // 🔔 用户通知（部分恢复或失败时）
            if (parseResult === 'partial') {
              // 延迟通知，避免阻塞初始化
              setTimeout(() => {
                const message = stats.parsedCount > 0
                  ? i18n.t('chatV2:chat.context_restored', { parsedCount: stats.parsedCount, failedCount: stats.failedCount })
                  : i18n.t('chatV2:chat.context_partially_corrupted');

                console.warn('[ChatStore] 🔔 User notification:', message);
                showGlobalNotification('warning', message);
              }, 1000);
            } else if (parseResult === 'failed') {
              setTimeout(() => {
                const message = i18n.t('chatV2:chat.context_corrupted');
                console.error('[ChatStore] 🔔 User notification:', message);
                showGlobalNotification('error', message);
              }, 1000);
            }
          }

          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          // 辅助函数：验证 ContextRef 有效性
          // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
          function isValidContextRef(obj: unknown): obj is import('../../context/types').ContextRef {
            if (!obj || typeof obj !== 'object') {
              return false;
            }

            const ref = obj as Record<string, unknown>;

            // 检查必需字段
            if (typeof ref.resourceId !== 'string' || !ref.resourceId.trim()) {
              return false;
            }
            if (typeof ref.hash !== 'string' || !ref.hash.trim()) {
              return false;
            }
            if (typeof ref.typeId !== 'string' || !ref.typeId.trim()) {
              return false;
            }

            // 额外验证：resourceId 格式（res_{nanoid(10)}）
            if (!/^res_[a-zA-Z0-9_-]{10}$/.test(ref.resourceId)) {
              console.warn('[ChatStore] Invalid resourceId format:', ref.resourceId);
              return false;
            }

            // 额外验证：hash 格式（SHA-256 hex）
            if (!/^[a-f0-9]{64}$/.test(ref.hash)) {
              console.warn('[ChatStore] Invalid hash format:', ref.hash);
              return false;
            }

            return true;
          }

          // 5. 设置状态（重置运行时状态）
          // 🚀 性能优化 V2：使用 queueMicrotask 延迟 Promise 回调
          //
          // 问题分析：set() 触发 React 在微任务中同步渲染，阻塞后续微任务 ~300ms
          //
          // 解决方案：
          // 1. 一次性 set() 所有状态（避免 UI 闪烁）
          // 2. 在 set() 前用 queueMicrotask 预先安排一个"让步"点
          //    让 loadSession Promise 可以更快 resolve

          // 🔧 安全解析 activeSkillIdsJson（统一为一次解析，防止 JSON 异常中断恢复）
          let restoredActiveSkillIds: string[] = getRestoredActiveSkillIds(state);
          // 🔧 新会话（无持久化 activeSkillIdsJson）回退到默认技能
          // 避免 loadSession 竞态覆写 activateSkill 已设置的 activeSkillIds
          if (restoredActiveSkillIds.length === 0 && !state?.activeSkillIdsJson && !state?.skillStateJson) {
            restoredActiveSkillIds = skillDefaults.getAll();
          }

          // 📊 细粒度打点：set 开始
          sessionSwitchPerf.mark('set_start', {
            messageCount: messageOrder.length,
            blockCount: blocksMap.size,
          });

          // 一次性更新所有状态
          const restoredActiveBlockIds = new Set(
            Array.from(blocksMap.values())
              .filter((block) => block.status === 'running' || block.status === 'pending')
              .map((block) => block.id)
          );

          // Listener registration and initial load deliberately run in
          // parallel. If a stream (or an edit/delete) advanced the live Store
          // while the backend snapshot was in flight, merge the snapshot into
          // that live state instead of replacing it with idle/null and losing
          // already received chunks.
          const liveState = getState();
          const liveStateAdvanced = !!baseline && (
            liveState.sessionStatus !== baseline.sessionStatus
            || liveState.currentStreamingMessageId !== baseline.currentStreamingMessageId
            || hasIdentitySetChanged(liveState.messageMap.keys(), baseline.messageIds)
            || hasIdentitySetChanged(liveState.blocks.keys(), baseline.blockIds)
          );

          let finalMessageMap = messageMap;
          let finalMessageOrder = messageOrder;
          let finalBlocksMap = blocksMap;
          let finalSessionStatus: ChatStore['sessionStatus'] = 'idle';
          let finalCurrentStreamingMessageId: string | null = null;
          let finalActiveBlockIds = restoredActiveBlockIds;
          let finalStreamingVariantIds = new Set<string>();

          if (liveStateAdvanced) {
            finalBlocksMap = new Map(liveState.blocks);
            const retainedMessageIds = new Set(liveState.messageMap.keys());
            for (const backendMessage of sortedMessages) {
              if (
                liveState.messageMap.has(backendMessage.id)
                || shouldRestoreMissingMessage(backendMessage, baseline)
              ) {
                retainedMessageIds.add(backendMessage.id);
              }
            }
            for (const backendBlock of blocks) {
              if (finalBlocksMap.has(backendBlock.id)) continue;
              if (!retainedMessageIds.has(backendBlock.messageId)) continue;
              if (baseline?.blockIds.has(backendBlock.id)) continue;
              finalBlocksMap.set(
                backendBlock.id,
                convertBackendBlock(
                  backendBlock,
                  backendMessageById.get(backendBlock.messageId),
                ),
              );
            }

            const availableBlockIds = new Set(finalBlocksMap.keys());
            finalMessageMap = new Map(liveState.messageMap);
            for (const backendMessage of sortedMessages) {
              const existingMessage = finalMessageMap.get(backendMessage.id);
              if (existingMessage) {
                finalMessageMap.set(
                  backendMessage.id,
                  mergeExistingMessageReferences(
                    existingMessage,
                    backendMessage,
                    availableBlockIds,
                  ),
                );
              } else if (retainedMessageIds.has(backendMessage.id)) {
                const converted = convertBackendMessage(backendMessage);
                finalMessageMap.set(backendMessage.id, {
                  ...converted,
                  blockIds: converted.blockIds.filter((id) => availableBlockIds.has(id)),
                  variants: converted.variants?.map((variant) => ({
                    ...variant,
                    blockIds: variant.blockIds.filter((id) => availableBlockIds.has(id)),
                  })),
                });
              }
            }
            const retainedBackendMessages = sortedMessages.filter((message) => retainedMessageIds.has(message.id));
            finalMessageOrder = mergeHistoryMessageOrder(
              liveState.messageOrder,
              finalMessageMap,
              retainedBackendMessages,
            );
            finalSessionStatus = liveState.sessionStatus;
            finalCurrentStreamingMessageId = liveState.currentStreamingMessageId;
            finalActiveBlockIds = new Set([
              ...restoredActiveBlockIds,
              ...liveState.activeBlockIds,
            ]);
            finalStreamingVariantIds = new Set(liveState.streamingVariantIds);
          }

          // 🔧 P1 内存泄漏修复：恢复会话会直接置空 attachments，先释放 blob: 预览 URL
          revokeAttachmentBlobUrls(getState().attachments);
          const shouldResetTransientRuntimes =
            session.id !== liveState.sessionId
            || (!liveStateAdvanced && !liveState.pendingBlockingInteraction);
          if (shouldResetTransientRuntimes) {
            resetTransientRuntimes(getState().setPendingApproval);
          }

          // liveState 已前进（例如发送后清空了输入框）时保留当前 composer，
          // 避免后端快照里尚未刷掉的旧草稿把已发送正文写回输入框。
          const resolvedInputValue = liveStateAdvanced
            ? liveState.inputValue
            : inputValue;

          set({
            sessionId: session.id,
            mode: session.mode,
            title: session.title ?? '',
            description: '', // 文档 28 改造：description 由后端事件更新，恢复时初始化为空
            groupId: session.groupId ?? null,
            sessionMetadata: session.metadata ?? null,
            authorityMode: (() => {
              const meta = session.metadata as Record<string, unknown> | null | undefined;
              const raw = meta?.authorityMode ?? meta?.authority_mode;
              return raw === 'ask' || raw === 'plan' || raw === 'craft' ? raw : 'craft';
            })(),
            permissionPreset: (() => {
              const meta = session.metadata as Record<string, unknown> | null | undefined;
              const raw = meta?.permissionPreset ?? meta?.permission_preset;
              return raw === 'cautious'
                || raw === 'relaxed'
                || raw === 'full_access'
                || raw === 'danger_full_access'
                ? raw
                : 'relaxed';
            })(),
            authorityAskBlockedHint: false,
            sessionStatus: finalSessionStatus,
            isDataLoaded: true,
            messageMap: finalMessageMap,
            messageOrder: finalMessageOrder,
            blocks: finalBlocksMap,
            currentStreamingMessageId: finalCurrentStreamingMessageId,
            activeBlockIds: finalActiveBlockIds,
            streamingVariantIds: finalStreamingVariantIds,
            chatParams,
            features,
            modeState,
            inputValue: resolvedInputValue,
            attachments: [],
            panelStates,
            pendingContextRefs,
            pendingContextRefsDirty: false,
            // 从安全解析的结果恢复（支持多选）
            activeSkillIds: restoredActiveSkillIds,
            skillStateJson: state?.skillStateJson ?? null,
            ...(shouldResetTransientRuntimes
              ? {
                  pendingBlockingInteraction: null,
                  pendingApprovalRequest: null,
                }
              : {}),
          });

          // 📊 细粒度打点：set 结束
          sessionSwitchPerf.mark('set_end');
          
          // 📊 细粒度打点：微任务检查点
          Promise.resolve().then(() => {
            sessionSwitchPerf.mark('microtask_check');
          });
          sessionSwitchPerf.mark('set_data_end', {
            phase: 'restore_total',
            ms: performance.now() - t0,
          });
          
          console.log('[ChatStore] Session restored from backend:', session.id, 'isDataLoaded: true');

          // 🔧 统一的异步恢复路径：资源验证 + 技能 ContextRef 重建
          // 合并原有的三条竞态路径为单一 queueMicrotask
          queueMicrotask(async () => {
            try {
              // 🔧 P1: 恢复链入口守卫——会话已切换或新一轮 restore 已开始时整体放弃
              if (isRestoreStale()) {
                console.log('[ChatStore] Skip unified restore chain: session/generation changed');
                return;
              }

              // === Step 0: 注入分组关联来源（pinned resources） ===
              const currentGroupId = getState().groupId;
              if (currentGroupId) {
                try {
                  const { invoke } = await import('@tauri-apps/api/core');
                  const group = await invoke<{ pinnedResourceIds?: string[] } | null>('chat_v2_get_group', { groupId: currentGroupId });
                  const pinnedIds = group?.pinnedResourceIds ?? [];
                  if (pinnedIds.length > 0) {
                    const { getResourceRefsV2 } = await import('../../context/vfsRefApi');
                    const { resourceStoreApi } = await import('../../resources');
                    const refsResult = await getResourceRefsV2(pinnedIds);
                    if (refsResult.ok && refsResult.value.refs.length > 0) {
                      // 🔧 P1: 只收集"待新增"的 pinned refs，写回时基于最新 state 做增量合并，
                      // 避免逐个 await 期间用户新增的引用被快照整体覆盖丢弃
                      const pinnedRefsToAdd: import('../../context/types').ContextRef[] = [];
                      const seenResourceIds = new Set(
                        getState().pendingContextRefs.map((r) => r.resourceId)
                      );
                      for (const vfsRef of refsResult.value.refs) {
                        try {
                          const resourceResult = await resourceStoreApi.createOrReuse({
                            type: vfsRef.type as import('../../context/types').ResourceType,
                            data: JSON.stringify({ refs: [vfsRef], totalCount: 1, truncated: false }),
                            sourceId: vfsRef.sourceId,
                            metadata: { name: vfsRef.name, title: vfsRef.name },
                          });
                          // Skip if same resourceId already in refs (exact content match via hash)
                          if (seenResourceIds.has(resourceResult.resourceId)) continue;
                          seenResourceIds.add(resourceResult.resourceId);

                          pinnedRefsToAdd.push({
                            resourceId: resourceResult.resourceId,
                            hash: resourceResult.hash,
                            typeId: vfsRef.type,
                            isSticky: true,
                            displayName: vfsRef.name,
                          });
                        } catch (refErr) {
                          console.warn('[ChatStore] Failed to create pinned resource ref:', vfsRef.sourceId, refErr);
                        }
                      }
                      if (pinnedRefsToAdd.length > 0 && !isRestoreStale()) {
                        // 基于写回时刻的最新 refs 增量合并；不复位 pendingContextRefsDirty，
                        // 避免破坏 editAndResend 三态语义（用户在恢复窗口内的编辑保持 dirty）
                        const latestRefs = getState().pendingContextRefs;
                        const latestIds = new Set(latestRefs.map((r) => r.resourceId));
                        const mergedRefs = [
                          ...latestRefs,
                          ...pinnedRefsToAdd.filter((r) => !latestIds.has(r.resourceId)),
                        ];
                        if (mergedRefs.length > latestRefs.length) {
                          set({ pendingContextRefs: mergedRefs });
                          console.log('[ChatStore] Injected group pinned resources:', mergedRefs.length - latestRefs.length);
                        }
                      }
                    }
                  }
                } catch (groupErr) {
                  console.warn('[ChatStore] Failed to inject group pinned resources:', groupErr);
                }
              }

              // 🔧 P1: Step 0 可能耗时较长，进入后续步骤前再次校验
              if (isRestoreStale()) {
                console.log('[ChatStore] Abort unified restore chain after Step 0: session/generation changed');
                return;
              }

              // === Step 1: 兼容恢复 — 如果 activeSkillIdsJson 为空但存在 legacy skill refs，从 refs 推断 ===
              if (restoredActiveSkillIds.length === 0 && pendingContextRefs.length > 0 && !state?.skillStateJson) {
                const orphanSkillRefs = pendingContextRefs.filter(
                  (ref) => ref.typeId === SKILL_INSTRUCTION_TYPE_ID && ref.isSticky
                );
                if (orphanSkillRefs.length > 0) {
                  const { resourceStoreApi } = await import('../../resources');
                  const inferredIds: string[] = [];
                  for (const skillRef of orphanSkillRefs) {
                    // 优先使用 ref.skillId（如果存在）
                    if (skillRef.skillId) {
                      if (!inferredIds.includes(skillRef.skillId)) {
                        inferredIds.push(skillRef.skillId);
                      }
                      continue;
                    }
                    // 否则从资源元数据推断
                    try {
                      const resource = await resourceStoreApi.get(skillRef.resourceId);

                      const skillId = (resource?.metadata as any)?.skillId as string | undefined;
                      if (skillId && !inferredIds.includes(skillId)) {
                        inferredIds.push(skillId);
                      }
                    } catch (e) {
                      console.warn('[ChatStore] Failed to infer skill from ref:', e);
                    }
                  }
                  if (inferredIds.length > 0 && !isRestoreStale()) {
                    set({ activeSkillIds: inferredIds } as Partial<ChatStoreState>);
                    console.log('[ChatStore] Inferred activeSkillIds from orphan refs:', inferredIds);
                  }
                }
              }

              // === Step 3: 验证资源有效性 ===
              // 🔧 使用 getState() 获取最新的 refs（包含 Step 1 新增的 skill refs）
              const currentRefsForValidation = getState().pendingContextRefs;
              if (currentRefsForValidation.length > 0) {
                const { resourceStoreApi } = await import('../../resources');
                const invalidRefs: string[] = [];

                for (const ref of currentRefsForValidation) {
                  try {
                    const exists = await resourceStoreApi.exists(ref.resourceId);
                    if (!exists) {
                      invalidRefs.push(ref.resourceId);
                    }
                  } catch {
                    // 验证失败时保留引用（宁可多保留，避免丢失用户数据）
                  }
                }

                if (invalidRefs.length > 0 && !isRestoreStale()) {
                  // 🔧 P1: 写回时基于最新 state 只剔除已确认无效的引用，
                  // 保留验证窗口期内用户新增的引用；不强制复位 dirty
                  const invalidIdSet = new Set(invalidRefs);
                  const latestRefs = getState().pendingContextRefs;
                  const filteredRefs = latestRefs.filter((ref) => !invalidIdSet.has(ref.resourceId));
                  if (filteredRefs.length !== latestRefs.length) {
                    console.warn('[ChatStore] Removing invalid refs:', latestRefs.length - filteredRefs.length);
                    set({ pendingContextRefs: filteredRefs });
                    showGlobalNotification('warning', i18n.t('chatV2:chat.context_invalid_removed', { count: latestRefs.length - filteredRefs.length }));
                  }
                }
              }

              // 🔧 修复：会话恢复完成后修复 skill 状态一致性
              // repairSkillState 从 hasActiveSkill getter 中提取，避免 getter 副作用
              if (!isRestoreStale()) {
                getState().repairSkillState();
              }
            } catch (e) {
              console.error('[ChatStore] Failed during unified session restore:', e);
            }
          });

          // 🔧 Canvas 笔记引用恢复：始终发射事件以确保会话切换时状态正确同步

          const canvasNoteId = (modeState as any)?.canvasNoteId as string | undefined;

          const canvasNoteHistory = (modeState as any)?.canvasNoteHistory as string[] | undefined;
          
          // 始终发射事件，即使没有 Canvas 状态（用于清理上一个会话的状态）
          console.log('[ChatStore] Syncing canvas note reference:', { canvasNoteId, canvasNoteHistory });
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent('canvas:restore-note', { 
              detail: { 
                noteId: canvasNoteId || null,
                noteHistory: canvasNoteHistory || [],
              } 
            }));
          }, 0);

          // 🆕 渐进披露：恢复已加载的 Skills
          // 🔧 增加 registry 就绪等待，避免 skills 尚未加载完成导致 notFound
          const restoredLoadedSkillIds = getRestoredLoadedSkillIds(state);
          if (restoredLoadedSkillIds.length > 0) {
            queueMicrotask(async () => {
              try {
                // 🔧 P1: 会话/代际守卫（syncLoadedSkillsFromBackend 按 session.id 隔离，
                // 此守卫避免为已切走的会话做无谓的等待与重试订阅）
                if (isRestoreStale()) return;
                // 等待 skillRegistry 初始化完成（带超时保护）
                const { skillRegistry } = await import('../../skills/registry');
                if (!skillRegistry.isInitialized()) {
                  const ready = await skillRegistry.waitForInitialized(5000);
                  if (!ready) {
                    console.warn('[ChatStore] Skill registry not ready after 5s, restoring loaded skills anyway');
                  }
                }

                const { syncLoadedSkillsFromBackend } = await import('../../skills/progressiveDisclosure');
                const attemptRestoreLoadedSkills = () =>
                  syncLoadedSkillsFromBackend(session.id, restoredLoadedSkillIds, { replace: true });
                const loadResult = attemptRestoreLoadedSkills();
                console.log('[ChatStore] Restored loaded skills:', {
                  sessionId: session.id,
                  requestedSkills: restoredLoadedSkillIds,
                  loadedCount: loadResult.loaded.length,
                  notFoundCount: loadResult.notFound.length,
                });

                // 🔧 如果部分技能未找到，可能是 skills 仍在加载中：订阅 registry 更新并重试（有限次数）
                if (loadResult.notFound.length > 0) {
                  const { subscribeToSkillRegistry } = await import('../../skills/registry');
                  let retries = 0;
                  const maxRetries = 3;
                  const unsubscribe = subscribeToSkillRegistry(() => {
                    retries++;
                    const retryResult = attemptRestoreLoadedSkills();
                    console.log('[ChatStore] Retry restoring loaded skills:', {
                      sessionId: session.id,
                      retry: retries,
                      loadedCount: retryResult.loaded.length,
                      notFoundCount: retryResult.notFound.length,
                    });

                    if (retryResult.notFound.length === 0 || retries >= maxRetries) {
                      unsubscribe();
                    }
                  });

                  // 超时兜底：避免极端情况下不触发更新导致订阅常驻
                  setTimeout(() => {
                    try {
                      unsubscribe();
                    } catch {
                      // ignore
                    }
                  }, 5000);
                }
              } catch (e) {
                console.warn('[ChatStore] Failed to restore loaded skills:', e);
              }
            });
          }
        },

  };
}
