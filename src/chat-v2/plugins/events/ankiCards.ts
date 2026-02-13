/**
 * Chat V2 - Anki 卡片事件处理插件
 *
 * 处理 anki_cards 类型的后端事件。
 *
 * 事件类型：anki_cards
 * 块类型：anki_cards
 *
 * 特点：
 * - 支持流式接收卡片（逐张显示）
 * - 中断时保留已生成的卡片
 *
 * 约束：
 * - 文件导入即自动注册（自执行）
 */

import {
  eventRegistry,
  type EventHandler,
  type EventStartPayload,
} from '../../registry/eventRegistry';
import type { ChatStore } from '../../core/types';
import type { AnkiCardsBlockData } from '../blocks/ankiCardsBlock';
import type { AnkiCard } from '@/types';

declare global {
  interface Window {
    __chatankiCardSourceByBlock?: Record<
      string,
      {
        source: string;
        blockStatus?: string;
        documentId?: string;
        cardIds: string[];
        signature: string;
        updatedAt: string;
      }
    >;
  }
}

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * 解析 anki_cards chunk
 *
 * 历史兼容：
 * - 单张卡片 / 卡片数组（旧 streaming）
 *
 * 新版（ChatAnki background pipeline）：
 * - patch object: { progress?, ankiConnect?, documentId?, cards?: [...] }
 */
type AnkiCardsChunk =
  | { kind: 'cards'; cards: AnkiCard[] }
  | { kind: 'patch'; patch: Partial<AnkiCardsBlockData> & { cards?: AnkiCard[] } };

function parseAnkiCardsChunk(chunk: string): AnkiCardsChunk | null {
  try {
    const parsed = JSON.parse(chunk);
    // 如果是数组
    if (Array.isArray(parsed)) {
      return { kind: 'cards', cards: parsed as AnkiCard[] };
    }
    if (!parsed || typeof parsed !== 'object') return null;

    // 如果是单张卡片（旧格式）
    if ('front' in parsed && 'back' in parsed) {
      return { kind: 'cards', cards: [parsed as AnkiCard] };
    }

    // 否则认为是 patch object（新版）
    const patch = parsed as Partial<AnkiCardsBlockData> & { cards?: unknown };
    const patchCards = Array.isArray(patch.cards) ? (patch.cards as AnkiCard[]) : undefined;
    return { kind: 'patch', patch: { ...patch, cards: patchCards } };
  } catch {
    // 解析失败，忽略
    console.warn('[ankiCards] Failed to parse card chunk:', chunk);
    return null;
  }
}

/**
 * 确保卡片有 ID
 */
function ensureCardId(card: AnkiCard): AnkiCard {
  const makeStableSyntheticId = (value: string): string => {
    let hash = 0;
    for (let i = 0; i < value.length; i += 1) {
      hash = (hash << 5) - hash + value.charCodeAt(i);
      hash |= 0;
    }
    return `anki_synthetic_${Math.abs(hash)}`;
  };

  if (!card.id) {
    const fingerprint = JSON.stringify({
      front: card.front ?? card.fields?.Front ?? '',
      back: card.back ?? card.fields?.Back ?? '',
      text: card.text ?? '',
      template: card.template_id ?? '',
    });
    return {
      ...card,
      id: makeStableSyntheticId(fingerprint),
    };
  }
  return card;
}

function mergeCardsUnique(currentCards: AnkiCard[], incomingCards: AnkiCard[]): AnkiCard[] {
  const merged = new Map<string, AnkiCard>();
  let overwritten = 0;
  const overwriteSamples: Array<Record<string, unknown>> = [];
  for (const card of currentCards.map(ensureCardId)) {
    merged.set(card.id, card);
  }
  for (const card of incomingCards.map(ensureCardId)) {
    // 新数据覆盖旧数据，避免同一 id 的流式更新产生视觉回退。
    if (merged.has(card.id)) {
      overwritten += 1;
      const previous = merged.get(card.id);
      if (overwriteSamples.length < 3 && previous) {
        overwriteSamples.push({
          id: card.id,
          templateBefore: previous.template_id ?? null,
          templateAfter: card.template_id ?? null,
          frontChanged: (previous.front ?? '') !== (card.front ?? ''),
          backChanged: (previous.back ?? '') !== (card.back ?? ''),
          fieldsKeysBefore: Object.keys((previous.fields ?? {}) as Record<string, unknown>),
          fieldsKeysAfter: Object.keys((card.fields ?? {}) as Record<string, unknown>),
        });
      }
    }
    merged.set(card.id, card);
  }
  const result = Array.from(merged.values());
  try {
    window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
      detail: {
        level: overwritten > 0 ? 'debug' : 'info',
        phase: 'bridge:event',
        summary: `anki_cards merge current=${currentCards.length} incoming=${incomingCards.length} result=${result.length} overwritten=${overwritten}`,
        detail: {
          currentCards: currentCards.length,
          incomingCards: incomingCards.length,
          resultCards: result.length,
          overwritten,
          overwriteSamples,
        },
      },
    }));
  } catch { /* debug only */ }
  return result;
}

function isTerminalBlockStatus(status?: string): boolean {
  return status === 'success' || status === 'error';
}

function extractCardQuestion(card: AnkiCard): string {
  const fields = (card.fields ?? {}) as Record<string, unknown>;
  const extraFields = (card.extra_fields ?? {}) as Record<string, unknown>;
  const fromField =
    fields.question ??
    fields.Question ??
    extraFields.question ??
    extraFields.Question;
  if (typeof fromField === 'string' && fromField.trim()) return fromField.trim();

  const front = card.front ?? '';
  if (front.trim().startsWith('{') && front.trim().endsWith('}')) {
    try {
      const parsed = JSON.parse(front) as Record<string, unknown>;
      const question = parsed.Question ?? parsed.question ?? parsed.front;
      if (typeof question === 'string' && question.trim()) return question.trim();
    } catch {
      // ignore
    }
  }

  return front.replace(/\s+/g, ' ').trim().slice(0, 80);
}

function buildCardsSignature(cards: AnkiCard[]): string {
  return cards
    .map((card) => {
      const id = card.id ?? 'no-id';
      const tid = card.template_id ?? 'no-template';
      const q = extractCardQuestion(card);
      return `${id}::${tid}::${q}`;
    })
    .join('|');
}

function recordCardsSourceSnapshot(
  blockId: string,
  source: string,
  cards: AnkiCard[],
  documentId: string | undefined,
  blockStatus?: string,
): void {
  const signature = buildCardsSignature(cards);
  const updatedAt = new Date().toISOString();
  const cardIds = cards.map((card) => card.id ?? 'no-id');

  if (!window.__chatankiCardSourceByBlock) {
    window.__chatankiCardSourceByBlock = {};
  }
  window.__chatankiCardSourceByBlock[blockId] = {
    source,
    blockStatus,
    documentId,
    cardIds,
    signature,
    updatedAt,
  };

  const sample = cards.slice(0, 3).map((card) => ({
    id: card.id ?? null,
    templateId: card.template_id ?? null,
    question: extractCardQuestion(card),
  }));

  try {
    window.dispatchEvent(
      new CustomEvent('chatanki-debug-lifecycle', {
        detail: {
          level: 'info',
          phase: 'bridge:source',
          summary: `source snapshot ${source} block=${blockId.slice(0, 8)} cards=${cards.length} doc=${documentId ?? 'null'}`,
          detail: {
            blockId,
            source,
            documentId,
            blockStatus: blockStatus ?? null,
            cardsCount: cards.length,
            cardIds,
            cardsSample: sample,
            signature,
            updatedAt,
          },
        },
      }),
    );
  } catch {
    // debug only
  }
}

// ============================================================================
// 事件处理器
// ============================================================================

/**
 * Anki 卡片事件处理器
 *
 * 注意：Store actions 内部已处理 activeBlockIds 管理：
 * - createBlock 自动添加到 activeBlockIds
 * - updateBlockStatus(success/error) 自动从 activeBlockIds 移除
 * - setBlockError 自动设置错误状态并从 activeBlockIds 移除
 */
const ankiCardsEventHandler: EventHandler = {
  /**
   * 处理 anki_cards_start 事件
   * 创建新的 anki_cards 块
   *
   * @param store ChatStore 实例
   * @param messageId 消息 ID
   * @param payload 附加数据（包含 blockType，可能包含 templateId）
   * @param backendBlockId 可选，后端传递的 blockId
   * @returns 创建的块 ID
   */
  onStart: (
    store: ChatStore,
    messageId: string,
    payload: EventStartPayload & { templateId?: string; templateIds?: string[]; templateMode?: string; options?: unknown },
    backendBlockId?: string
  ): string => {
    // 幂等保护：同一个 backendBlockId 可能因重放/重连重复触发 start 事件
    // 若块已存在，直接复用，避免在 UI 中出现“叠层双预览”。
    if (backendBlockId && store.blocks.has(backendBlockId)) {
      const existing = store.blocks.get(backendBlockId);
      const existingData = existing?.toolOutput as AnkiCardsBlockData | undefined;
      const terminal = isTerminalBlockStatus(existing?.status);
      store.updateBlock(backendBlockId, {
        toolOutput: {
          cards: existingData?.cards || [],
          templateId: payload?.templateId ?? existingData?.templateId ?? null,
          templateIds: payload?.templateIds ?? existingData?.templateIds,
          templateMode: payload?.templateMode ?? existingData?.templateMode,
          syncStatus: existingData?.syncStatus ?? 'pending',
          businessSessionId: existingData?.businessSessionId ?? store.sessionId,
          messageStableId: existingData?.messageStableId ?? messageId,
          options: (payload?.options as AnkiCardsBlockData['options']) ?? existingData?.options,
          documentId: existingData?.documentId,
          progress: existingData?.progress,
          ankiConnect: existingData?.ankiConnect,
          finalStatus: existingData?.finalStatus,
          finalError: existingData?.finalError,
          warnings: existingData?.warnings,
        },
        ...(terminal ? {} : { status: 'running' }),
      });
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
          detail: {
            level: terminal ? 'warn' : 'debug',
            phase: 'bridge:event',
            summary: terminal
              ? `anki_cards start ignored status downgrade (terminal=${existing?.status}) block=${backendBlockId.slice(0, 8)}`
              : `anki_cards start reuse block=${backendBlockId.slice(0, 8)}`,
            detail: { blockId: backendBlockId, blockStatus: existing?.status, terminal },
          },
        }));
      } catch { /* debug only */ }
      return backendBlockId;
    }

    // 额外兜底：某些流式重放场景可能出现没有 backendBlockId 的重复 start，
    // 直接复用当前消息内仍在运行的 anki_cards 块，避免出现“叠两层预览”。
    const currentMessage = store.messageMap.get(messageId);
    const runningAnkiBlockId = currentMessage?.blockIds?.find((id) => {
      const b = store.blocks.get(id);
      return b?.type === 'anki_cards' && b?.status === 'running';
    });
    if (runningAnkiBlockId) {
      const existing = store.blocks.get(runningAnkiBlockId);
      const existingData = existing?.toolOutput as AnkiCardsBlockData | undefined;
      const terminal = isTerminalBlockStatus(existing?.status);
      store.updateBlock(runningAnkiBlockId, {
        toolOutput: {
          cards: existingData?.cards || [],
          templateId: payload?.templateId ?? existingData?.templateId ?? null,
          templateIds: payload?.templateIds ?? existingData?.templateIds,
          templateMode: payload?.templateMode ?? existingData?.templateMode,
          syncStatus: existingData?.syncStatus ?? 'pending',
          businessSessionId: existingData?.businessSessionId ?? store.sessionId,
          messageStableId: existingData?.messageStableId ?? messageId,
          options: (payload?.options as AnkiCardsBlockData['options']) ?? existingData?.options,
          documentId: existingData?.documentId,
          progress: existingData?.progress,
          ankiConnect: existingData?.ankiConnect,
          finalStatus: existingData?.finalStatus,
          finalError: existingData?.finalError,
          warnings: existingData?.warnings,
        },
        ...(terminal ? {} : { status: 'running' }),
      });
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
          detail: {
            level: terminal ? 'warn' : 'debug',
            phase: 'bridge:event',
            summary: terminal
              ? `anki_cards start reuse terminal block=${runningAnkiBlockId.slice(0, 8)}`
              : `anki_cards start reuse running block=${runningAnkiBlockId.slice(0, 8)}`,
            detail: { blockId: runningAnkiBlockId, blockStatus: existing?.status, terminal },
          },
        }));
      } catch { /* debug only */ }
      return runningAnkiBlockId;
    }

    // 如果后端传了 blockId，使用它；否则由前端生成
    const blockId = backendBlockId
      ? store.createBlockWithId(messageId, 'anki_cards', backendBlockId)
      : store.createBlock(messageId, 'anki_cards');

    // 🔧 P2 修复：从消息获取 persistentStableId 作为 messageStableId
    // persistentStableId 在 Message 上，不在 _meta 中
    const message = store.messageMap.get(messageId);
    const messageStableId = message?.persistentStableId || messageId;

    // 设置初始数据
    // 🔧 P1 修复：使用 updateBlock 设置初始数据，将状态设置为 running
    // 不使用 setBlockResult，因为它会自动设置 status: 'success' 并移除活跃状态
    // 🔧 P2 修复：添加 businessSessionId 和 messageStableId，确保面板能正确关联会话
    const initialData: AnkiCardsBlockData = {
      cards: [],
      templateId: payload?.templateId || null,
      templateIds: payload?.templateIds,
      templateMode: payload?.templateMode,
      syncStatus: 'pending',
      // P2 修复：添加必要的上下文信息
      businessSessionId: store.sessionId,
      messageStableId,
      options: payload?.options as AnkiCardsBlockData['options'],
    };
    store.updateBlock(blockId, {
      toolOutput: initialData,
      status: 'running', // 标记为正在运行，直到 onEnd 被调用
    });
    recordCardsSourceSnapshot(blockId, 'start', initialData.cards, undefined, 'running');

    return blockId;
  },

  /**
   * 处理 anki_cards_chunk 事件
   * 流式接收卡片
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   * @param chunk 卡片数据（JSON 字符串）
   */
  onChunk: (store: ChatStore, blockId: string, chunk: string): void => {
    const block = store.blocks.get(blockId);
    if (!block) {
      console.warn('[ankiCards] Block not found:', blockId);
      return;
    }

    const currentData = block.toolOutput as AnkiCardsBlockData | undefined;
    const currentCards = currentData?.cards || [];

    const parsed = parseAnkiCardsChunk(chunk);
    if (!parsed) return;
    const terminal = isTerminalBlockStatus(block.status);

    if (parsed.kind === 'cards') {
      const updatedCards = mergeCardsUnique(currentCards, parsed.cards);
      store.updateBlock(blockId, {
        toolOutput: {
          ...currentData,
          cards: updatedCards,
          templateId: currentData?.templateId || null,
          syncStatus: 'pending',
        } as AnkiCardsBlockData,
        ...(terminal ? {} : { status: 'running' }),
      });
      if (terminal) {
        try {
          window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
            detail: {
              level: 'warn',
              phase: 'bridge:event',
              summary: `anki_cards chunk merged without status downgrade block=${blockId.slice(0, 8)} terminal=${block.status}`,
              detail: { blockId, blockStatus: block.status, cardsBefore: currentCards.length, cardsAfter: updatedCards.length },
            },
          }));
        } catch { /* debug only */ }
      }
      const docIdForLog = currentData?.documentId;
      recordCardsSourceSnapshot(
        blockId,
        'chunk-cards',
        updatedCards,
        docIdForLog,
        terminal ? block.status : 'running',
      );
      return;
    }

    // Patch merge (progress/ankiConnect/documentId/options/cards etc.)
    const { cards: patchCards, ...restPatch } = parsed.patch;
    const updatedCards = Array.isArray(patchCards)
      ? mergeCardsUnique(currentCards, patchCards)
      : currentCards;

    store.updateBlock(blockId, {
      toolOutput: {
        ...currentData,
        ...restPatch,
        cards: updatedCards,
        templateId: (restPatch as any)?.templateId ?? currentData?.templateId ?? null,
        templateIds: (restPatch as any)?.templateIds ?? currentData?.templateIds,
        templateMode: (restPatch as any)?.templateMode ?? currentData?.templateMode,
        syncStatus: (restPatch as any)?.syncStatus ?? currentData?.syncStatus ?? 'pending',
      } as AnkiCardsBlockData,
      ...(terminal ? {} : { status: 'running' }),
    });
    const docIdForLog =
      ((restPatch as unknown as Record<string, unknown>)?.documentId as string | undefined) ??
      currentData?.documentId;
    recordCardsSourceSnapshot(
      blockId,
      'chunk-patch',
      updatedCards,
      docIdForLog,
      terminal ? block.status : 'running',
    );
    if (terminal) {
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
          detail: {
            level: 'warn',
            phase: 'bridge:event',
            summary: `anki_cards patch merged without status downgrade block=${blockId.slice(0, 8)} terminal=${block.status}`,
            detail: { blockId, blockStatus: block.status, hasCardsPatch: Array.isArray(patchCards) },
          },
        }));
      } catch { /* debug only */ }
    }
  },

  /**
   * 处理 anki_cards_end 事件
   * 完成 anki_cards 块
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   * @param result 最终结果（可选，可能包含完整卡片列表）
   */
  onEnd: (store: ChatStore, blockId: string, result?: unknown): void => {
    const block = store.blocks.get(blockId);
    if (!block) {
      console.warn('[ankiCards] Block not found:', blockId);
      return;
    }

    const currentData = block.toolOutput as AnkiCardsBlockData | undefined;
    const currentCards = currentData?.cards || [];
    let resultStatus: string | undefined;
    let resultError: string | undefined;
    let normalizedStatus: string | undefined;

    if (result && typeof result === 'object') {
      const resultObj = result as Record<string, unknown>;
      const resultCards = Array.isArray(resultObj.cards) ? (resultObj.cards as AnkiCard[]) : undefined;
      // 🔧 修复：onEnd 中 result.cards 的处理策略
      // - 如果后端返回了卡片列表，以后端为权威来源（后端可能重新生成了全部卡片）
      // - 如果后端未返回卡片（null/undefined），保留前端流式累积的卡片
      // 注意：前端编辑已通过 chat_v2_update_block_tool_output 持久化到数据库，不会丢失
      const finalCards = resultCards
        ? mergeCardsUnique([], resultCards)
        : mergeCardsUnique([], currentCards);

      const { cards: _cardsIgnored, status, error, ...rest } = resultObj as any;
      resultStatus = typeof status === 'string' ? status : undefined;
      resultError = typeof error === 'string' ? error : undefined;
      normalizedStatus = resultStatus ? resultStatus.toLowerCase() : undefined;

      store.updateBlock(blockId, {
        toolOutput: {
          ...currentData,
          ...rest,
          cards: finalCards,
          templateId: (rest as any)?.templateId ?? currentData?.templateId ?? null,
          templateIds: (rest as any)?.templateIds ?? currentData?.templateIds,
          templateMode: (rest as any)?.templateMode ?? currentData?.templateMode,
          syncStatus: (rest as any)?.syncStatus ?? currentData?.syncStatus ?? 'pending',
          finalStatus: normalizedStatus ?? currentData?.finalStatus,
          finalError: resultError ?? currentData?.finalError,
        } as AnkiCardsBlockData,
      });
      const docIdForLog =
        ((rest as unknown as Record<string, unknown>)?.documentId as string | undefined) ??
        currentData?.documentId;
      recordCardsSourceSnapshot(
        blockId,
        'end-result',
        finalCards,
        docIdForLog,
        normalizedStatus ?? block.status,
      );
    } else {
      recordCardsSourceSnapshot(
        blockId,
        'end-no-result',
        currentCards,
        currentData?.documentId,
        block.status,
      );
    }

    const isErrorStatus =
      normalizedStatus === 'error' || normalizedStatus === 'failed';
    const isCancelledStatus =
      normalizedStatus === 'cancelled' || normalizedStatus === 'canceled';
    const shouldError = isErrorStatus || (Boolean(resultError) && !isCancelledStatus);

    if (shouldError) {
      if (resultError) {
        store.setBlockError(blockId, resultError);
      } else {
        store.updateBlockStatus(blockId, 'error');
      }
      return;
    }

    if (isCancelledStatus) {
      store.updateBlockStatus(blockId, 'success');
      return;
    }

    // 关键保护：当 tool_call 先结束但后台仍在持续投递 NewCard 时，不能提前把块置为 success。
    // 满足以下条件时保留 running，等待后续 anki_generation_event 的完成信号：
    // 1) result 没有明确 status/error；
    // 2) result 没有返回完整 cards；
    // 3) 当前进度仍处于生成中（非 completed/cancelled/failed）。
    if (result && typeof result === 'object') {
      const resultObj = result as Record<string, unknown>;
      const hasResultCards = Array.isArray(resultObj.cards);
      const hasExplicitTerminal =
        typeof resultObj.status === 'string' || typeof resultObj.error === 'string';
      const resultStage = ((resultObj.progress as Record<string, unknown> | undefined)?.stage ??
        (resultObj as Record<string, unknown>).stage) as string | undefined;
      const currentStage = String(resultStage ?? currentData?.progress?.stage ?? '').toLowerCase();
      const stageLooksInFlight =
        !currentStage ||
        ['generating', 'streaming', 'processing', 'routing', 'importing'].includes(currentStage);
      if (!hasResultCards && !hasExplicitTerminal && stageLooksInFlight) {
        try {
          window.dispatchEvent(
            new CustomEvent('chatanki-debug-lifecycle', {
              detail: {
                level: 'warn',
                phase: 'bridge:event',
                summary: `anki_cards end ignored premature terminal transition block=${blockId.slice(0, 8)} stage=${currentStage || 'unknown'}`,
                detail: {
                  blockId,
                  hasResultCards,
                  hasExplicitTerminal,
                  currentStage: currentData?.progress?.stage ?? null,
                  cardsCount: currentCards.length,
                },
              },
            }),
          );
        } catch {
          // debug only
        }
        return;
      }
    }

    // 默认完成：设置状态为成功（会自动从 activeBlockIds 移除）
    store.updateBlockStatus(blockId, 'success');
  },

  /**
   * 处理 anki_cards_error 事件
   * 标记 anki_cards 块为错误状态
   * 注意：保留已生成的卡片（onAbort: 'keep-content'）
   *
   * @param store ChatStore 实例
   * @param blockId 块 ID
   * @param error 错误信息
   */
  onError: (store: ChatStore, blockId: string, error: string): void => {
    const block = store.blocks.get(blockId);
    if (block) {
      const currentData = block.toolOutput as AnkiCardsBlockData | undefined;
      // 🔧 P1 修复：使用 updateBlock 更新同步状态，保留已有卡片
      if (currentData) {
        store.updateBlock(blockId, {
          toolOutput: {
            ...currentData,
            syncStatus: 'error',
            syncError: error,
            finalStatus: 'error',
            finalError: error,
          } as AnkiCardsBlockData,
        });
      }
    }
    // 设置块错误（会自动设置 status: 'error' 并从 activeBlockIds 移除）
    store.setBlockError(blockId, error);
  },
};

// ============================================================================
// 自动注册
// ============================================================================

// 注册到 eventRegistry（导入即注册）
eventRegistry.register('anki_cards', ankiCardsEventHandler);

// 导出 handler 供测试使用
export { ankiCardsEventHandler };
