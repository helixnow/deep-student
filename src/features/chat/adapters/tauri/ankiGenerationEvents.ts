/**
 * Chat V2 - TauriAdapter 拆分模块 —— ChatAnki anki_generation_event 桥接：路由到 anki_cards 块、卡片合并缓冲与调试快照
 *
 * 自 TauriAdapter.ts 拆出（行为不变）；函数首参 host 为适配器实例，
 * 由 ChatV2TauriAdapter 同名方法委托调用。
 */

import type { AnkiCard } from '@/types';
import { isRetryableTerminalAnkiBlock } from './requestHelpers';
import type { TauriAdapterHost } from './adapterHost';

/** 从卡片字段中提取问题文本（用于签名/调试快照） */
export function extractAnkiCardQuestion(host: TauriAdapterHost, card: AnkiCard): string {
  const fields = (card.fields ?? {}) as Record<string, unknown>;
  const extraFields = (card.extra_fields ?? {}) as Record<string, unknown>;
  const fieldQuestion =
    fields.question ??
    fields.Question ??
    extraFields.question ??
    extraFields.Question;
  if (typeof fieldQuestion === 'string' && fieldQuestion.trim()) return fieldQuestion.trim();
  const front = card.front ?? '';
  if (front.trim().startsWith('{') && front.trim().endsWith('}')) {
    try {
      const parsed = JSON.parse(front) as Record<string, unknown>;
      const q = parsed.Question ?? parsed.question ?? parsed.front;
      if (typeof q === 'string' && q.trim()) return q.trim();
    } catch {
      // ignore
    }
  }
  return front.replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** 构建卡片列表签名（O(N)——仅在冲刷/终态时调用，不再每卡一次） */
export function buildAnkiCardsSignature(host: TauriAdapterHost, cards: AnkiCard[]): string {
  return cards
    .map((card) => `${card.id ?? 'no-id'}::${card.template_id ?? 'no-template'}::${host.extractAnkiCardQuestion(card)}`)
    .join('|');
}

/** 记录卡片来源快照（调试面板用） */
export function recordAnkiSourceSnapshot(
  host: TauriAdapterHost,
  targetBlock: { id: string },
  source: string,
  cards: AnkiCard[],
  status: string | undefined,
  docId: string | undefined,
): void {
  const signature = host.buildAnkiCardsSignature(cards);
  const updatedAt = new Date().toISOString();
  const cardIds = cards.map((card) => card.id ?? 'no-id');

  const win = window as Window & {
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
  };
  if (!win.__chatankiCardSourceByBlock) {
    win.__chatankiCardSourceByBlock = {};
  }
  win.__chatankiCardSourceByBlock[targetBlock.id] = {
    source,
    blockStatus: status,
    documentId: docId,
    cardIds,
    signature,
    updatedAt,
  };

  try {
    window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
      level: 'info',
      phase: 'bridge:source',
      summary: `source snapshot ${source} block=${targetBlock.id.slice(0, 8)} cards=${cards.length} doc=${docId ?? 'null'}`,
      detail: {
        blockId: targetBlock.id,
        source,
        blockStatus: status ?? null,
        documentId: docId ?? null,
        cardsCount: cards.length,
        cardIds,
        signature,
        updatedAt,
      },
    }}));
  } catch { /* debug only */ }
}

/**
 * 🚀 性能修复（2026-09-06）：批量落盘缓冲的制卡事件。
 * 将 100ms 窗口内到达的 NewCard/NewErrorCard 合并为一次 updateBlock，
 * 使 N 张卡的渲染开销从 O(N²) 降为 O(N)。
 */
export function flushAnkiCardBuffer(host: TauriAdapterHost, blockId: string): void {
  const queued = host.ankiCardFlushQueue.get(blockId);
  if (!queued) return;
  host.ankiCardFlushQueue.delete(blockId);
  if (queued.timer) {
    clearTimeout(queued.timer);
  }
  if (queued.cards.length === 0) return;

  const state = host.getCurrentState();
  const targetBlock = state.blocks.get(blockId);
  if (!targetBlock) return;

  const currentOutput = (targetBlock.toolOutput as Record<string, unknown> | undefined) ?? {};
  const currentCards = (currentOutput.cards as AnkiCard[] | undefined) ?? [];
  // 落盘前按最新状态重建 ID 索引（O(M)），窗口内新卡逐一 O(1) 判重——
  // 整体 O(M+N) 而非逐个 some() 的 O(N²)（2026-09-07 审阅 F3）。
  const existingIds = new Set<string>();
  for (const card of currentCards) {
    if (card.id) existingIds.add(card.id);
  }
  const newCards = queued.cards.filter((card) => !card.id || !existingIds.has(card.id));
  if (newCards.length === 0) return;

  const nextCards = [...currentCards, ...newCards];
  const documentId = queued.documentId;
  const ensureDocumentId = documentId && !currentOutput.documentId ? { documentId } : {};
  const nextTemplateId =
    (currentOutput.templateId as string | undefined) ||
    (newCards[0]?.template_id ?? undefined) ||
    null;
  const nextProgress = {
    ...(currentOutput.progress as Record<string, unknown> | undefined),
    stage: (currentOutput.progress as any)?.stage ?? 'streaming',
    cardsGenerated: nextCards.length,
    lastUpdatedAt: new Date().toISOString(),
  };
  host.recordAnkiSourceSnapshot(
    targetBlock,
    'event-new-card-batched',
    nextCards,
    targetBlock.status === 'success' || targetBlock.status === 'error' ? targetBlock.status : 'running',
    (ensureDocumentId.documentId as string | undefined) ?? (currentOutput.documentId as string | undefined),
  );
  state.updateBlock(blockId, {
    toolOutput: {
      ...currentOutput,
      ...ensureDocumentId,
      cards: nextCards,
      templateId: nextTemplateId,
      progress: nextProgress,
    },
    ...(targetBlock.status === 'success' || targetBlock.status === 'error'
      ? {}
      : { status: 'running' }),
  });
}

/**
 * 处理 ChatAnki 后端事件（anki_generation_event）
 * 将 NewCard/进度事件桥接到 anki_cards 块，实现实时预览
 */
export function handleAnkiGenerationEvent(host: TauriAdapterHost, payload: unknown): void {
  const raw = (payload as { payload?: unknown })?.payload ?? payload;
  if (!raw || typeof raw !== 'object') return;

  const normalized = 'type' in (raw as Record<string, unknown>) && 'data' in (raw as Record<string, unknown>)
    ? {
        type: (raw as { type: string }).type,
        data: (raw as { data: unknown }).data,
      }
    : (() => {
        const keys = Object.keys(raw as Record<string, unknown>);
        if (keys.length === 0) return null;
        const type = keys[0];
        return { type, data: (raw as Record<string, unknown>)[type] };
      })();

  if (!normalized) return;

  const { type, data } = normalized;
  const dataObj = (data && typeof data === 'object') ? (data as Record<string, unknown>) : undefined;
  const cardData = (dataObj && 'card' in dataObj ? (dataObj.card as AnkiCard) : (data as AnkiCard | undefined));
  const documentId =
    (dataObj?.document_id as string | undefined) ||
    (dataObj?.documentId as string | undefined) ||
    ((cardData as any)?.document_id as string | undefined) ||
    ((raw as any)?.document_id as string | undefined) ||
    ((raw as any)?.documentId as string | undefined);

  if (
    host.getAnkiEventOwnerAdapterId() !== host.adapterInstanceId &&
    !documentId
  ) {
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'debug',
        phase: 'bridge:event',
        summary: `drop anki_generation_event without documentId: adapter#${host.adapterInstanceId} is not owner`,
        detail: {
          adapterId: host.adapterInstanceId,
          ownerAdapterId: host.getAnkiEventOwnerAdapterId(),
          sessionId: host.sessionId,
          type,
        },
      }}));
    } catch { /* debug only */ }
    return;
  }

  const state = host.getCurrentState();
  const blocks = state.blocks;
  // 按 documentId 精确匹配（不限状态 — 块可能已被 chatanki_wait 标记为 success）
  const findBlockByDocumentId = (docId: string) => {
    for (const block of blocks.values()) {
      if (block.type !== 'anki_cards') continue;
      const toolOutput = block.toolOutput as Record<string, unknown> | undefined;
      if (toolOutput?.documentId === docId) return block;
    }
    return undefined;
  };
  // 仅无 documentId 时允许回退到最新活跃块（且仅 owner adapter 能走到这里）
  const findLatestActiveAnkiBlock = () => {
    const candidates = Array.from(blocks.values()).filter((block) => {
      if (block.type !== 'anki_cards') return false;
      return block.status === 'running' || block.status === 'pending';
    });
    return candidates.length > 0 ? candidates[candidates.length - 1] : undefined;
  };

  // P1 止血：有 documentId 时只精确匹配，禁止回退到「最新活跃块」（避免串块 / 写错 documentId）
  let usedLatestActiveFallback = false;
  const targetBlock = documentId
    ? findBlockByDocumentId(documentId)
    : (() => {
        const fallback = findLatestActiveAnkiBlock();
        if (fallback) usedLatestActiveFallback = true;
        return fallback;
      })();
  if (!targetBlock) {
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'warn',
        phase: 'bridge:event',
        summary: `drop anki_generation_event ${type}: no target block`,
        documentId,
        detail: { type, data: dataObj ?? data },
      }}));
    } catch { /* debug only */ }
    // documentId 存在但本 session 没有匹配的块 → 事件属于其他 session / 块未就绪，静默忽略
    // documentId 不存在且没有活跃块 → 无处投递，忽略
    return;
  }
  if (usedLatestActiveFallback) {
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'warn',
        phase: 'bridge:event',
        summary: `anki_generation_event ${type}: no documentId, fallback to latest active block ${targetBlock.id.slice(0, 8)}`,
        blockId: targetBlock.id,
        detail: { type, adapterId: host.adapterInstanceId },
      }}));
    } catch { /* debug only */ }
  }
  // ensureDocumentId 仅在精确匹配到块后写入；有 documentId 时不会走到 fallback，故不会污染其他块
  try {
    window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
      level: 'debug',
      phase: 'bridge:event',
      summary: `route anki_generation_event ${type} -> block ${targetBlock.id.slice(0, 8)}`,
      documentId,
      blockId: targetBlock.id,
      detail: {
        type,
        blockStatus: targetBlock.status,
        currentCards: ((targetBlock.toolOutput as any)?.cards ?? []).length,
      },
    }}));
  } catch { /* debug only */ }

  // 🚀 性能修复（2026-09-06）：非卡片事件到达前先冲刷合并缓冲，
  // 保证进度/完成/失败/重试事件基于最新卡片列表（否则终态事件会用旧 toolOutput 覆盖刚冲刷的卡片）
  if (type !== 'NewCard' && type !== 'NewErrorCard') {
    host.flushAnkiCardBuffer(targetBlock.id);
  }
  const latestBlock = host.getCurrentState().blocks.get(targetBlock.id) ?? targetBlock;

  const currentOutput = (latestBlock.toolOutput as Record<string, unknown> | undefined) ?? {};
  const currentCards = (currentOutput.cards as AnkiCard[] | undefined) ?? [];
  const ensureDocumentId = documentId && !currentOutput.documentId ? { documentId } : {};
  const retryRelevantEvent = [
    'TaskStatusUpdate',
    'NewCard',
    'NewErrorCard',
    'TaskCompleted',
    'TaskProcessingError',
    'TaskFailed',
    'DocumentProcessingFailed',
    'DocumentProcessingCompleted',
  ].includes(type);
  const isRetryFlow = Boolean(
    documentId &&
      retryRelevantEvent &&
      (host.retryingAnkiDocumentIds.has(documentId) ||
        isRetryableTerminalAnkiBlock(targetBlock.status, currentOutput)),
  );
  if (isRetryFlow && documentId) {
    host.retryingAnkiDocumentIds.add(documentId);
  }

  // 生成质量观测事件（CriticSummary / GenerationStats）：只 patch toolOutput
  // 观测字段，不动 status / progress / cards，不参与 retry reconcile。
  // 类型与归一化契约以 ankiCardsBlockState 的 AnkiCriticSummary / AnkiGenerationStats
  // 为准（此处经 inline import() 类型引用对齐，避免改动本文件 import 区）。
  if (type === 'CriticSummary' || type === 'GenerationStats') {
    if (!dataObj) return;
    // 兼容 snake_case（后端当前 wire 格式）与 camelCase（防后端序列化策略调整）
    const pickNum = (snake: string, camel: string): number => {
      const value = dataObj[snake] ?? dataObj[camel];
      if (typeof value === 'number' && Number.isFinite(value)) return value;
      if (typeof value === 'string') {
        const parsed = Number(value);
        if (Number.isFinite(parsed)) return parsed;
      }
      return 0;
    };
    const pickStr = (snake: string, camel: string): string | undefined => {
      const value = dataObj[snake] ?? dataObj[camel];
      return typeof value === 'string' && value ? value : undefined;
    };
    const receivedAt = new Date().toISOString();

    let statsPatch: Record<string, unknown>;
    if (type === 'CriticSummary') {
      const degradedRaw = dataObj.degraded;
      const routedDegradedRaw = dataObj.routed_degraded ?? dataObj.routedDegraded;
      const criticSummary: import('../../plugins/blocks/components/ankiCardsBlockState').AnkiCriticSummary = {
        taskId: pickStr('task_id', 'taskId'),
        documentId: pickStr('document_id', 'documentId'),
        examined: pickNum('examined', 'examined'),
        kept: pickNum('kept', 'kept'),
        revised: pickNum('revised', 'revised'),
        flagged: pickNum('flagged', 'flagged'),
        rejectedUnknownIds: pickNum('rejected_unknown_ids', 'rejectedUnknownIds'),
        skippedOverBudget: pickNum('skipped_over_budget', 'skippedOverBudget'),
        goldReferences: pickNum('gold_references', 'goldReferences'),
        goldReferencesTruncated: pickNum('gold_references_truncated', 'goldReferencesTruncated'),
        persistFailures: pickNum('persist_failures', 'persistFailures'),
        degraded: typeof degradedRaw === 'string' && degradedRaw ? degradedRaw : null,
        routedConfigId: pickStr('routed_config_id', 'routedConfigId'),
        routedModel: pickStr('routed_model', 'routedModel'),
        routedDegraded: typeof routedDegradedRaw === 'boolean' ? routedDegradedRaw : undefined,
        receivedAt,
      };
      statsPatch = { criticSummary };
    } else {
      const generationStats: import('../../plugins/blocks/components/ankiCardsBlockState').AnkiGenerationStats = {
        taskId: pickStr('task_id', 'taskId'),
        documentId: pickStr('document_id', 'documentId'),
        cardsGenerated: pickNum('cards_generated', 'cardsGenerated'),
        failedCards: pickNum('failed_cards', 'failedCards'),
        duplicateCards: pickNum('duplicate_cards', 'duplicateCards'),
        droppedFragments: pickNum('dropped_fragments', 'droppedFragments'),
        flaggedCards: pickNum('flagged_cards', 'flaggedCards'),
        receivedAt,
      };
      statsPatch = { generationStats };
    }

    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'info', phase: 'bridge:event',
        summary: `${type} → block ${targetBlock.id.slice(0, 8)} | ${JSON.stringify(statsPatch[type === 'CriticSummary' ? 'criticSummary' : 'generationStats']).slice(0, 200)}`,
        documentId, blockId: targetBlock.id,
        detail: statsPatch,
      }}));
    } catch { /* debug only */ }

    // 终态块（success/error）同样允许 patch —— 这两个事件在任务收尾后到达属正常时序
    state.updateBlock(targetBlock.id, {
      toolOutput: {
        ...currentOutput,
        ...ensureDocumentId,
        ...statsPatch,
      },
    });
    return;
  }

  if (type === 'NewCard' || type === 'NewErrorCard') {
    if (!cardData) return;
    // 🚀 性能修复（2026-09-06）：卡片事件进入合并缓冲，100ms 窗口批量写入 store。
    // 原实现每张卡一次 O(N) 签名计算 + updateBlock + 调试 CustomEvent，
    // N 张卡产生 O(N²) 渲染与事件洪水。
    // F3（2026-09-07）：判重改 ID 索引——条目创建时从已落盘卡片播种
    // （每窗口 O(M) 一次），窗口期内每张新卡 O(1)；无 ID 卡片不参与判重，
    // 始终保留（与原语义一致）。
    let queued = host.ankiCardFlushQueue.get(targetBlock.id);
    if (!queued) {
      const seededIds = new Set<string>();
      for (const card of currentCards) {
        if (card.id) seededIds.add(card.id);
      }
      queued = {
        cards: [],
        cardIds: seededIds,
        documentId,
        timer: setTimeout(() => host.flushAnkiCardBuffer(targetBlock.id), 100),
      };
      host.ankiCardFlushQueue.set(targetBlock.id, queued);
    }
    if (cardData.id && queued.cardIds.has(cardData.id)) {
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'debug', phase: 'bridge:event',
          summary: `${type} duplicate dropped: ${cardData.id?.slice(0, 10) ?? 'no-id'}`,
          documentId, blockId: targetBlock.id,
        }}));
      } catch { /* debug only */ }
      return;
    }
    queued.cards.push(cardData);
    if (cardData.id) queued.cardIds.add(cardData.id);
    if (documentId && !queued.documentId) queued.documentId = documentId;
    // 重试对账读的是后端 TaskSnapshot，与前端缓冲时序无关，保持立即调度
    if (isRetryFlow && documentId) {
      host.scheduleAnkiRetryReconcile(targetBlock.id, documentId);
    }
    return;
  }

  if (type === 'TaskStatusUpdate' || type === 'DocumentProcessingStarted') {
    if (isRetryFlow && documentId) {
      host.scheduleAnkiRetryReconcile(targetBlock.id, documentId);
      return;
    }
    const nextProgress = {
      ...(currentOutput.progress as Record<string, unknown> | undefined),
      stage:
        type === 'TaskStatusUpdate'
          ? ((dataObj?.status as string | undefined) || 'streaming')
          : 'processing',
      lastUpdatedAt: new Date().toISOString(),
    };
    host.recordAnkiSourceSnapshot(
      targetBlock,
      type === 'TaskStatusUpdate' ? 'event-task-status' : 'event-doc-started',
      currentCards,
      targetBlock.status === 'success' || targetBlock.status === 'error' ? targetBlock.status : 'running',
      (ensureDocumentId.documentId as string | undefined) ?? (currentOutput.documentId as string | undefined),
    );
    state.updateBlock(targetBlock.id, {
      toolOutput: {
        ...currentOutput,
        ...ensureDocumentId,
        progress: nextProgress,
      },
      ...(targetBlock.status === 'success' || targetBlock.status === 'error'
        ? {}
        : { status: 'running' }),
    });
    return;
  }

  if (type === 'TaskCompleted') {
    if ((targetBlock.status === 'success' || targetBlock.status === 'error') && !isRetryFlow) {
      return;
    }
    if (documentId) {
      host.scheduleAnkiRetryReconcile(targetBlock.id, documentId);
    }
    return;
  }

  if (type === 'DocumentProcessingCompleted') {
    if (isRetryFlow && documentId) {
      host.scheduleAnkiRetryReconcile(targetBlock.id, documentId);
      return;
    }
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'info', phase: 'bridge:card',
        summary: `${type} → block ${targetBlock.id.slice(0, 8)} COMPLETED | ${currentCards.length} cards total`,
        documentId, blockId: targetBlock.id,
        detail: { cardsCount: currentCards.length, templateIds: [...new Set(currentCards.map((c: any) => c.template_id).filter(Boolean))] },
      }}));
    } catch { /* */ }
    host.recordAnkiSourceSnapshot(
      targetBlock,
      'event-doc-completed',
      currentCards,
      'success',
      (ensureDocumentId.documentId as string | undefined) ?? (currentOutput.documentId as string | undefined),
    );
    state.updateBlock(targetBlock.id, {
      toolOutput: {
        ...currentOutput,
        ...ensureDocumentId,
        finalStatus: 'completed',
      },
    });
    if (targetBlock.status !== 'error') {
      state.updateBlockStatus(targetBlock.id, 'success');
    }
    return;
  }

  if (type === 'TaskProcessingError' && isRetryFlow && documentId) {
    host.scheduleAnkiRetryReconcile(targetBlock.id, documentId);
    return;
  }

  // 取消：保留已生成卡片，块 status=success，finalStatus=cancelled（与 failed 分离）
  if (type === 'DocumentProcessingCancelled') {
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'info', phase: 'bridge:card',
        summary: `${type} → block ${targetBlock.id.slice(0, 8)} CANCELLED | ${currentCards.length} cards kept`,
        documentId, blockId: targetBlock.id,
        detail: { cardsCount: currentCards.length },
      }}));
    } catch { /* */ }
    host.recordAnkiSourceSnapshot(
      targetBlock,
      'event-doc-cancelled',
      currentCards,
      'success',
      (ensureDocumentId.documentId as string | undefined) ?? (currentOutput.documentId as string | undefined),
    );
    state.updateBlock(targetBlock.id, {
      toolOutput: {
        ...currentOutput,
        ...ensureDocumentId,
        finalStatus: 'cancelled',
      },
    });
    if (targetBlock.status !== 'error') {
      state.updateBlockStatus(targetBlock.id, 'success');
    }
    return;
  }

  if (
    type === 'TaskFailed' ||
    type === 'DocumentProcessingFailed' ||
    type === 'WorkflowFailed'
  ) {
    if (isRetryFlow && documentId) {
      host.scheduleAnkiRetryReconcile(targetBlock.id, documentId);
      return;
    }
    const errorMessage =
      (dataObj?.message as string | undefined) ||
      (dataObj?.error as string | undefined) ||
      'generation_failed';
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'error', phase: 'bridge:card',
        summary: `${type} → block ${targetBlock.id.slice(0, 8)} FAILED: ${errorMessage}`,
        documentId, blockId: targetBlock.id,
        detail: { error: errorMessage },
      }}));
    } catch { /* */ }
    state.updateBlock(targetBlock.id, {
      toolOutput: {
        ...currentOutput,
        ...ensureDocumentId,
        finalStatus: 'failed',
        finalError: errorMessage,
      },
    });
    state.updateBlockStatus(targetBlock.id, 'error');
  }
}
