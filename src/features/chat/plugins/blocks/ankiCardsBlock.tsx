/**
 * Chat V2 - Anki 卡片块渲染插件
 *
 * 架构设计：
 * - 折叠态：显示前 3 张卡片预览（紧凑模式）
 * - 展开态：内联展示所有卡片，点击单张卡片可展开编辑
 * - 复用 chatAnkiActions 实现保存/导出/同步操作
 *
 * 自执行注册：import 即注册
 */

import { useRefreshOnReturn } from '@/hooks/useRefreshOnReturn';
import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { CaretUp, Rows, SquaresFour } from '@phosphor-icons/react';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { blockRegistry, type BlockComponentProps } from '../../registry';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';

// ============================================================================
// 复用 Chat V2 本地 Anki 管线
// ============================================================================
import {
  saveCardsToLibrary,
  exportCardsAsApkg,
  logChatAnkiEvent,
  AnkiCardStackPreview,
  FullWidthCardWrapper,
} from '../../anki';
import type { AnkiCard, AnkiGenerationOptions } from '@/types';
import type { SaveAnkiCardIdMapping } from '@/services/ankiApiAdapter';
import { ChatAnkiProgressCompact } from './components/ChatAnkiProgressCompact';
import {
  AnkiCardSkeleton,
  AnkiCompletionSummary,
  AnkiInlineUndoBar,
} from './components/ChatAnkiCardExtras';
import { summarizeQaFlags } from './components/ankiQaFlags';
import { AnkiQaFlagsSummaryChip } from './components/AnkiQaFlagBadge';
import { AnkiCriticSummaryBanner } from './components/AnkiCriticSummaryBanner';
import { parseAnkiMediaReport } from './components/ankiMediaReport';
import {
  parseOcclusionSpec,
  type OcclusionSpec,
} from '@/components/anki/utils/imageOcclusion';
import {
  getAnkiBlockUiState,
  patchAnkiBlockUiState,
  getLastDeckNameInput,
  setLastDeckNameInput,
  type AnkiCardEditDraft,
} from './components/ankiCardsBlockState';
import type {
  AnkiCardsBlockData,
  AnkiCardsIssue,
  AnkiCardsWarning,
  ZombieCompletionState,
} from './components/ankiCardsBlockTypes';
import {
  hasRealCardId,
  isTemplateCompatibleWithCard,
  mapBlockStatusToPreviewStatus,
  resolveZombieCompletionState,
} from './components/ankiCardsBlockFields';
import { AnkiOcclusionCardPreview } from './components/AnkiOcclusionCardPreview';
import { InlineCardItem } from './components/AnkiInlineCardItem';
import { AnkiCardActionButtons } from './components/AnkiCardActionButtons';
import { AnkiBatchSelectionBar } from './components/AnkiBatchSelectionBar';
import {
  UNDO_DELETE_WINDOW_MS,
  useAnkiCardDeleteUndo,
} from './components/useAnkiCardDeleteUndo';
import { useAnkiFailedSegmentRetry } from './components/useAnkiFailedSegmentRetry';
import { useMultiTemplateLoader } from '../../hooks/useMultiTemplateLoader';
import { invoke } from '@tauri-apps/api/core';
import './components/chat-anki-cards.css';

// ============================================================================
// 公开类型与纯函数重导出（保持模块既有导出契约）
// ============================================================================
export type {
  AnkiCardsWarning,
  AnkiCardsIssue,
  AnkiCardsBlockData,
  ZombieCompletionState,
};
export { resolveZombieCompletionState };

// ============================================================================
// 主组件
// ============================================================================

/** Zombie block watchdog 阈值：running 状态超过该时长无更新则做后端核实/标错 */
const ZOMBIE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Anki 卡片块组件
 *
 * 支持两种模式：
 * 1. 折叠态：预览前 3 张卡片
 * 2. 展开态：内联展示所有卡片，点击可编辑
 */
const AnkiCardsBlock: React.FC<BlockComponentProps> = React.memo(({
  block,
  isStreaming,
  store,
}) => {
  const { t } = useTranslation('chatV2');
  const { t: tAnki } = useTranslation('anki');
  const data = block.toolOutput as AnkiCardsBlockData | undefined;
  // useMemo 固定空数组引用：`data?.cards || []` 每次渲染都会生成新数组，
  // 导致依赖 cards 的 effect/memo（调试上报、模板 id 提取等）在流式期间每帧重跑
  const cards = useMemo(() => data?.cards ?? [], [data?.cards]);
  const isBlockBusy = block.status === 'pending' || block.status === 'running';
  // 按动作粒度解锁：生成中允许展开浏览；已带真实 ID 的卡允许单卡编辑/删除
  //（DB 已有行，后端 CAS 保护并发）；整批操作仍由 AnkiCardActionButtons 内部门控。
  const isGenerating = isBlockBusy || Boolean(isStreaming);
  const documentId = typeof data?.documentId === 'string' ? data.documentId.trim() : '';

  const {
    retryableTaskIds,
    retryStatus,
    retryError,
    handleRetryFailedSegments,
  } = useAnkiFailedSegmentRetry({
    blockStatus: block.status,
    data,
    documentId,
  });

  // ChatAnki Workflow Debug: 记录 block 状态变化
  const prevStatusRef = useRef(block.status);
  const prevCardsLenRef = useRef(cards.length);
  useEffect(() => {
    const statusChanged = prevStatusRef.current !== block.status;
    const cardsChanged = prevCardsLenRef.current !== cards.length;
    if (statusChanged || cardsChanged) {
      const fingerprints = cards.map((card) =>
        `${card.front ?? card.fields?.Front ?? ''}||${card.back ?? card.fields?.Back ?? ''}`.trim(),
      );
      let adjacentDuplicatePairs = 0;
      for (let i = 1; i < fingerprints.length; i += 1) {
        if (fingerprints[i] && fingerprints[i] === fingerprints[i - 1]) {
          adjacentDuplicatePairs += 1;
        }
      }
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
          detail: {
            level: statusChanged && block.status === 'error' ? 'error' : 'info',
            phase: 'block:state',
            summary: `status=${block.status} cards=${cards.length} docId=${data?.documentId ?? 'null'} dupAdjacent=${adjacentDuplicatePairs}`,
            detail: {
              blockId: block.id,
              status: block.status,
              prevStatus: prevStatusRef.current,
              cardsCount: cards.length,
              prevCardsCount: prevCardsLenRef.current,
              documentId: data?.documentId,
              templateId: data?.templateId,
              templateIds: data?.templateIds,
              templateMode: data?.templateMode,
              adjacentDuplicatePairs,
              progress: data?.progress,
            },
            documentId: data?.documentId,
            blockId: block.id,
          },
        }));
      } catch { /* debug plugin not available */ }
      prevStatusRef.current = block.status;
      prevCardsLenRef.current = cards.length;
    }
  }, [block.status, cards, cards.length, block.id, data?.documentId, data?.templateId, data?.templateIds, data?.templateMode, data?.progress]);

  // 多模板支持：从卡片数组中提取所有唯一的 template_id，批量加载
  const allTemplateIds = useMemo(() => {
    const ids = new Set<string>();
    if (data?.templateId) ids.add(data.templateId);
    (data?.templateIds ?? []).forEach((id) => {
      if (id) ids.add(id);
    });
    cards.forEach((c) => { if (c.template_id) ids.add(c.template_id); });
    return [...ids];
  }, [cards, data?.templateId, data?.templateIds]);

  const { templateMap } = useMultiTemplateLoader(allTemplateIds);
  useEffect(() => {
    if (cards.length === 0) return;
    const unresolvedTemplateCards = cards.filter(
      (card) => Boolean(card.template_id) && !templateMap.has(card.template_id as string),
    ).length;
    const incompatibleTemplateCards = cards.filter((card) => {
      const resolvedTemplate = (() => {
        if (card.template_id && templateMap.has(card.template_id)) {
          return templateMap.get(card.template_id) ?? null;
        }
        if (data?.templateId && templateMap.has(data.templateId)) {
          return templateMap.get(data.templateId) ?? null;
        }
        if (templateMap.size === 1) {
          return [...templateMap.values()][0];
        }
        return null;
      })();
      return Boolean(resolvedTemplate) && !isTemplateCompatibleWithCard(card, resolvedTemplate);
    }).length;
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
        detail: {
          level: unresolvedTemplateCards > 0 || incompatibleTemplateCards > 0 ? 'warn' : 'debug',
          phase: 'render:stack',
          summary: `renderer templates resolved=${templateMap.size}/${allTemplateIds.length} unresolvedCards=${unresolvedTemplateCards} incompatibleCards=${incompatibleTemplateCards}`,
          detail: {
            blockId: block.id,
            documentId: data?.documentId,
            cards: cards.length,
            allTemplateIds,
            unresolvedTemplateCards,
            incompatibleTemplateCards,
          },
          documentId: data?.documentId,
          blockId: block.id,
        },
      }));
    } catch { /* debug plugin not available */ }
  }, [templateMap, allTemplateIds, cards, block.id, data?.documentId, data?.templateId]);

  // 向后兼容：提取单模板 fallback（用于 InlineCardItem 等还需要单 template 的场景）
  const template = useMemo(() => {
    if (data?.templateId && templateMap.has(data.templateId)) {
      return templateMap.get(data.templateId) ?? null;
    }
    // 如果只有一个模板，直接用它
    if (templateMap.size === 1) {
      return [...templateMap.values()][0];
    }
    return null;
  }, [templateMap, data?.templateId]);

  // 展开/编辑/分页/多选等 UI 状态：初始值从模块级 Map 恢复（虚拟滚动卸载不丢），
  // 变化时写回 Map（见下方持久化 effect）。
  const [isExpanded, setIsExpanded] = useState(() => getAnkiBlockUiState(block.id).isExpanded);
  // 展开态布局：紧凑列表 / 双列网格
  const [layout, setLayout] = useState<'list' | 'grid'>(() => getAnkiBlockUiState(block.id).layout);
  // 当前正在编辑的卡片索引（-1 表示无）
  const [editingIndex, setEditingIndex] = useState(() => getAnkiBlockUiState(block.id).editingIndex);
  // 分页：限制同时渲染的卡片数量，防止大量 iframe 导致浏览器卡顿/崩溃
  const CARDS_PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(() =>
    Math.max(getAnkiBlockUiState(block.id).visibleCount, CARDS_PAGE_SIZE)
  );
  // 多选集合（卡片 id）
  const [selectedIds, setSelectedIds] = useState<Set<string>>(
    () => new Set(getAnkiBlockUiState(block.id).selectedIds)
  );
  // 挂载时恢复的未保存编辑草稿（只消费一次，由 InlineCardItem 判定归属）
  const [restoredDraft] = useState<AnkiCardEditDraft | null>(
    () => getAnkiBlockUiState(block.id).editDraft
  );
  // 保存/导出/同步共用的牌组名：块级记忆 > 会话内上次输入 > 生成 options > Default
  const [deckName, setDeckName] = useState(() =>
    getAnkiBlockUiState(block.id).deckName ??
    getLastDeckNameInput() ??
    ((block.toolOutput as AnkiCardsBlockData | undefined)?.options?.deck_name || 'Default')
  );

  // UI 状态写回模块级 Map（虚拟滚动卸载后重挂可恢复）
  useEffect(() => {
    patchAnkiBlockUiState(block.id, {
      isExpanded,
      layout,
      editingIndex,
      visibleCount,
      selectedIds: [...selectedIds],
      deckName,
    });
  }, [block.id, isExpanded, layout, editingIndex, visibleCount, selectedIds, deckName]);

  const handleDeckNameChange = useCallback((value: string) => {
    setDeckName(value);
    setLastDeckNameInput(value);
  }, []);

  const handleDraftChange = useCallback(
    (draft: AnkiCardEditDraft | null) => {
      patchAnkiBlockUiState(block.id, { editDraft: draft });
    },
    [block.id]
  );

  // 展开态卡片列表末尾的 ref（用于自动滚动到新卡片）
  const cardsEndRef = useRef<HTMLDivElement>(null);
  // 记录上次卡片数量，仅在增长时滚动。
  // 初始化为当前数量：isExpanded 从模块级状态恢复后，虚拟滚动重挂不应触发自动滚动。
  const prevCardsCountRef = useRef(cards.length);

  const hasProgress = useMemo(() => {
    if (!data?.progress) return false;
    if (typeof data.progress.completedRatio === 'number') return true;
    if (typeof data.progress.stage === 'string' && data.progress.stage.trim()) return true;
    if (typeof data.progress.message === 'string' && data.progress.message.trim()) return true;
    if (typeof data.progress.messageKey === 'string' && data.progress.messageKey.trim()) return true;
    if (typeof data.progress.cardsGenerated === 'number') return true;
    if (typeof data.progress.route === 'string' && data.progress.route.trim()) return true;
    if (data.progress.counts && typeof data.progress.counts === 'object') return true;
    return false;
  }, [data?.progress]);

  const hasAnkiConnect = useMemo(() => {
    if (!data?.ankiConnect) return false;
    if (typeof data.ankiConnect.available === 'boolean') return true;
    if (typeof data.ankiConnect.error === 'string' && data.ankiConnect.error.trim()) return true;
    if (typeof data.ankiConnect.checkedAt === 'string') return true;
    return false;
  }, [data?.ankiConnect]);

  // APKG 媒体导入报告（tool_output.mediaReport）：解析失败/缺失时为 null
  const mediaReport = useMemo(() => parseAnkiMediaReport(data?.mediaReport), [data?.mediaReport]);

  // 质检标记块级摘要：N 张卡片带 _qa_flags（用于完成态复查提示）
  const qaFlagsSummary = useMemo(() => summarizeQaFlags(cards), [cards]);

  // 折叠预览最多与既有纯文本栈一致展示前 5 张卡；只收录可安全解析的遮挡卡。
  const occlusionPreviewCards = useMemo(
    () => cards
      .map((card, index) => ({
        card,
        index,
        spec: parseOcclusionSpec(card.extra_fields),
      }))
      .filter(
        (entry): entry is { card: AnkiCard; index: number; spec: OcclusionSpec } =>
          entry.spec !== null,
      )
      .slice(0, 5),
    [cards],
  );

  const shouldShowChatAnkiProgress = hasProgress || hasAnkiConnect || mediaReport !== null;

  // 刷新 AnkiConnect 状态：调用后端重新检测，更新 block 数据
  // 注意：从 store 读取最新 block 数据，避免 stale closure 导致覆盖并发更新
  const handleRefreshAnkiConnect = useCallback(async () => {
    if (!store) return;
    try {
      const available = await invoke<boolean>('check_anki_connect_status');
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = latestBlock?.toolOutput as AnkiCardsBlockData | undefined;
      if (!latestData) return;
      const newData = {
        ...latestData,
        ankiConnect: {
          ...latestData.ankiConnect,
          available,
          checkedAt: new Date().toISOString(),
          error: available ? undefined : latestData.ankiConnect?.error,
        },
      };
      store.getState().updateBlock(block.id, { toolOutput: newData });
    } catch (err) {
      console.warn('[AnkiCardsBlock] Failed to refresh AnkiConnect status:', err);
    }
  }, [store, block.id]);

  useRefreshOnReturn(handleRefreshAnkiConnect, hasAnkiConnect && data?.ankiConnect?.available !== true);

  // Zombie block watchdog: 如果 block 持续处于 running 状态超过 5 分钟无更新，自动标记为 error
  const lastActivityRef = useRef(Date.now());
  useEffect(() => {
    // 每次 cards/progress 变化都重置活跃时间戳
    lastActivityRef.current = Date.now();
  }, [cards.length, data?.progress?.stage, data?.progress?.cardsGenerated]);
  useEffect(() => {
    if (block.status !== 'running') return;
    const timer = setInterval(() => {
      if (block.status !== 'running' || Date.now() - lastActivityRef.current <= ZOMBIE_TIMEOUT_MS) return;

      const currentDocumentId = (store?.getState().blocks.get(block.id)?.toolOutput as AnkiCardsBlockData | undefined)?.documentId;
      if (!currentDocumentId) {
        console.warn('[AnkiCardsBlock] Zombie block detected without documentId, forcing error state:', block.id);
        store?.getState().setBlockError(block.id, t('blocks.ankiCards.errors.pipelineTimeout'));
        clearInterval(timer);
        return;
      }

      void (async () => {
        try {
          const tasks = await invoke<Array<{ status?: string }>>('get_document_tasks', { documentId: currentDocumentId });
          const latestBlock = store?.getState().blocks.get(block.id);
          if (!latestBlock || latestBlock.status !== 'running') return;

          const statuses = tasks.map((task) => String(task.status ?? '').toLowerCase());
          const hasInFlight = statuses.some((status) => ['pending', 'processing', 'streaming', 'paused'].includes(status));
          if (hasInFlight) {
            lastActivityRef.current = Date.now();
            return;
          }

          if (tasks.length > 0) {
            const dbCards = await invoke<Array<Record<string, unknown>>>('get_document_cards', { documentId: currentDocumentId });
            const latestData = latestBlock.toolOutput as AnkiCardsBlockData | undefined;
            const finalCards = dbCards.length > 0 ? dbCards : (latestData?.cards ?? []);
            const completion = resolveZombieCompletionState(statuses, finalCards);
            store?.getState().updateBlock(block.id, {
              toolOutput: {
                ...latestData,
                cards: finalCards as AnkiCard[],
                finalStatus: completion.finalStatus,
                progress: {
                  ...latestData?.progress,
                  stage: completion.finalStatus,
                  cardsGenerated: finalCards.length,
                  lastUpdatedAt: new Date().toISOString(),
                },
              } as AnkiCardsBlockData,
              status: completion.blockStatus,
              error: completion.blockStatus === 'error' ? t(completion.errorKey) : undefined,
            });
            clearInterval(timer);
            return;
          }

          console.warn('[AnkiCardsBlock] Zombie block detected, forcing error state after backend check:', block.id);
          store?.getState().setBlockError(block.id, t('blocks.ankiCards.errors.pipelineTimeout'));
          clearInterval(timer);
        } catch (err) {
          console.warn('[AnkiCardsBlock] Zombie block backend verification failed, forcing error state:', err);
          store?.getState().setBlockError(block.id, t('blocks.ankiCards.errors.pipelineTimeout'));
          clearInterval(timer);
        }
      })();
    }, 30_000); // check every 30s
    return () => clearInterval(timer);
  }, [block.status, block.id, store, t]);

  // 展开态：新卡片到来时自动滚动到底部（仅在卡片数量增长时触发）
  useEffect(() => {
    if (isExpanded && cards.length > prevCardsCountRef.current && editingIndex < 0) {
      cardsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    prevCardsCountRef.current = cards.length;
  }, [isExpanded, cards.length, editingIndex]);

  // 切换展开/折叠
  const handleToggleExpand = useCallback(() => {
    setIsExpanded((prev) => !prev);
    setEditingIndex(-1);
    setVisibleCount(CARDS_PAGE_SIZE);
  }, [CARDS_PAGE_SIZE]);

  // 切换卡片编辑模式
  const handleToggleEdit = useCallback((index: number) => {
    setEditingIndex((prev) => (prev === index ? -1 : index));
  }, []);

  // 🔧 场景8修复：将编辑后的 toolOutput 持久化到数据库
  // 防止后续 pipeline 重保存消息时丢失用户编辑
  const persistToolOutput = useCallback(
    async (newData: AnkiCardsBlockData, propagateError = false) => {
      try {
        await invoke('chat_v2_update_block_tool_output', {
          blockId: block.id,
          toolOutputJson: JSON.stringify(newData),
        });
      } catch (err) {
        console.warn('[AnkiCardsBlock] Failed to persist tool_output:', err);
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.persistFailed'),
        );
        if (propagateError) throw err;
      }
    },
    [block.id, t]
  );

  const handleCardsPersisted = useCallback(
    async (mappings: SaveAnkiCardIdMapping[]) => {
      if (!store || mappings.length === 0) return;
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = (latestBlock?.toolOutput as AnkiCardsBlockData | undefined) ?? data;
      if (!latestData) return;

      const nextCards = [...(latestData.cards ?? [])];
      let changed = false;
      for (const mapping of mappings) {
        const persistedId = mapping.persistedId?.trim();
        if (
          !persistedId ||
          persistedId.startsWith('anki_synthetic_') ||
          persistedId.startsWith('chat-batch-') ||
          !Number.isInteger(mapping.inputIndex) ||
          mapping.inputIndex < 0
        ) {
          continue;
        }

        const expectedInputId = mapping.inputId ?? undefined;
        let targetIndex = mapping.inputIndex;
        const indexedCard = nextCards[targetIndex];
        if (
          expectedInputId !== undefined &&
          indexedCard?.id !== expectedInputId &&
          indexedCard?.id !== persistedId
        ) {
          targetIndex = nextCards.findIndex((card) => card.id === expectedInputId);
        }
        const target = nextCards[targetIndex];
        if (!target || target.id === persistedId) continue;
        if (expectedInputId !== undefined && target.id !== expectedInputId) continue;

        nextCards[targetIndex] = { ...target, id: persistedId };
        changed = true;
      }

      if (!changed) return;
      const newData: AnkiCardsBlockData = { ...latestData, cards: nextCards };
      await persistToolOutput(newData, true);
      store.getState().updateBlock(block.id, { toolOutput: newData });
    },
    [store, block.id, data, persistToolOutput]
  );

  // M4：Sync 成功后写块 syncStatus（store + DB tool_output）
  const handleSyncStatusChange = useCallback(
    (status: 'synced' | 'error' | 'syncing', error?: string) => {
      if (!store) return;
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = (latestBlock?.toolOutput as AnkiCardsBlockData | undefined) ?? data;
      if (!latestData) return;
      const newData: AnkiCardsBlockData = {
        ...latestData,
        syncStatus: status,
        syncError: status === 'error' ? error : undefined,
      };
      store.getState().updateBlock(block.id, { toolOutput: newData });
      // syncing 为瞬时态，不必落库；synced/error 持久化以免刷新后空转
      if (status === 'synced' || status === 'error') {
        void persistToolOutput(newData);
      }
    },
    [store, block.id, data, persistToolOutput]
  );

  // E2 修复：块内编辑/删除同时回写 anki_cards 表（消灭双数据源）。
  // AI 的 chatanki_export / chatanki_sync 读取的是 DB，
  // 不回写会导致"用户在块里删过/改过的卡在 AI 导出时复活"。
  // 成功后再更新投影；失败 toast 且不覆写 store（避免与流式更新竞态丢卡）。
  const syncCardUpdateToDb = useCallback(async (card: AnkiCard) => {
    if (!card.id) return;
    // 空 text 归一化为 null，避免把 DB 中的 NULL 覆盖为空字符串
    const payload = { ...card, text: card.text?.trim() ? card.text : null };
    try {
      await invoke('update_anki_card', { card: payload });
    } catch (err) {
      console.warn('[AnkiCardsBlock] Failed to sync card edit to anki DB:', err);
      showGlobalNotification(
        'warning',
        t('blocks.ankiCards.action.dbSyncFailed'),
      );
      throw err;
    }
  }, [t]);

  // 保存卡片编辑：从 store 读最新 toolOutput 再合并，避免闭包 cards 整表覆写冲掉流式新卡
  const handleSaveCard = useCallback(
    async (index: number, updated: AnkiCard) => {
      if (!store) return;
      try {
        await syncCardUpdateToDb(updated);
      } catch {
        return;
      }
      const latestBlock = store.getState().blocks.get(block.id);
      const latestData = latestBlock?.toolOutput as AnkiCardsBlockData | undefined;
      if (!latestData) return;
      const latestCards = latestData.cards ?? [];
      const newCards = [...latestCards];
      const byId = updated.id
        ? newCards.findIndex((card) => card.id === updated.id)
        : -1;
      const targetIndex = byId >= 0 ? byId : index;
      if (targetIndex < 0 || targetIndex >= newCards.length) return;
      newCards[targetIndex] = updated;
      const newData = { ...latestData, cards: newCards };
      store.getState().updateBlock(block.id, { toolOutput: newData });
      void persistToolOutput(newData);
      setEditingIndex(-1);
      logChatAnkiEvent('chat_anki_card_edited', { index: targetIndex, blockId: block.id });
    },
    [store, block.id, persistToolOutput, syncCardUpdateToDb]
  );

  // 删除 + 撤销（支持批量）
  const {
    pendingDelete,
    exitingIds,
    requestDeleteCards,
    handleDeleteCard,
    handleUndoDelete,
  } = useAnkiCardDeleteUndo({
    blockId: block.id,
    store,
    cards,
    persistToolOutput,
    setEditingIndex,
    setSelectedIds,
  });

  // ==========================================================================
  // 多选与批量操作：checkbox 选择集 + 批量删除/保存所选/导出所选
  // ==========================================================================
  const selectableIds = useMemo(
    () => cards.map((card) => card.id).filter((id): id is string => Boolean(id)),
    [cards]
  );
  // 只统计仍存在于当前卡片列表的选中项（流式/删除后自动收敛）
  const selectedCards = useMemo(
    () => cards.filter((card) => card.id && selectedIds.has(card.id)),
    [cards, selectedIds]
  );
  const selectedCount = selectedCards.length;
  const allSelected = selectableIds.length > 0 && selectedCount === selectableIds.length;

  const handleToggleSelect = useCallback((cardId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(cardId)) next.delete(cardId);
      else next.add(cardId);
      return next;
    });
  }, []);

  const handleToggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const hasAll = selectableIds.length > 0 && selectableIds.every((id) => prev.has(id));
      return hasAll ? new Set<string>() : new Set(selectableIds);
    });
  }, [selectableIds]);

  const handleInvertSelection = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set<string>();
      selectableIds.forEach((id) => {
        if (!prev.has(id)) next.add(id);
      });
      return next;
    });
  }, [selectableIds]);

  // 批量删除：一个撤销窗口覆盖整个选择集
  const handleDeleteSelected = useCallback(() => {
    if (selectedCards.length === 0) return;
    requestDeleteCards(
      selectedCards.map((card) => ({ id: card.id, index: cards.indexOf(card) }))
    );
  }, [selectedCards, cards, requestDeleteCards]);

  // 计算预览状态
  const previewStatus = useMemo(() => {
    return mapBlockStatusToPreviewStatus(
      block.status,
      data?.syncStatus,
      cards.length > 0,
      data?.finalStatus
    );
  }, [block.status, data?.syncStatus, data?.finalStatus, cards.length]);

  const resolveChatAnkiError = useCallback(
    (error?: string | null) => {
      if (!error) return undefined;
      const translated = t(error, { defaultValue: '' });
      if (translated) return translated;
      // 后端错误为 "i18n key: 可读细节" 形式（humanize_chatanki_error）时，
      // 翻译 key 部分并保留细节文本。
      const separator = error.indexOf(': ');
      if (separator > 0) {
        const keyPart = error.slice(0, separator);
        const translatedKey = t(keyPart, { defaultValue: '' });
        if (translatedKey) return `${translatedKey}: ${error.slice(separator + 2)}`;
      }
      return error;
    },
    [t]
  );

  const deliveryRecovered = data?.deliveryStatus === 'ready' && cards.length > 0;
  const errorMessage = useMemo(() => {
    const generationError = deliveryRecovered ? undefined : block.error || data?.finalError;
    return resolveChatAnkiError(generationError || data?.syncError);
  }, [block.error, data?.syncError, data?.finalError, deliveryRecovered, resolveChatAnkiError]);

  // ==========================================================================
  // 完成态小结条：N 张卡 · 用时 · 任务中心 / 导出内联入口
  // ==========================================================================
  const showCompletionSummary =
    block.status === 'success' &&
    cards.length > 0 &&
    (previewStatus === 'ready' || previewStatus === 'stored');

  const durationText = useMemo(() => {
    if (!block.startedAt || !block.endedAt) return null;
    const elapsedMs = block.endedAt - block.startedAt;
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
    const totalSeconds = Math.max(1, Math.round(elapsedMs / 1000));
    const duration =
      totalSeconds < 60
        ? tAnki('chatBlock.durationSeconds', { count: totalSeconds })
        : tAnki('chatBlock.durationMinutes', {
            minutes: Math.floor(totalSeconds / 60),
            seconds: totalSeconds % 60,
          });
    return tAnki('chatBlock.summaryDuration', { duration });
  }, [block.startedAt, block.endedAt, tAnki]);

  const summaryContext = useMemo(
    () => ({
      documentId: data?.documentId ?? null,
      businessSessionId: data?.businessSessionId ?? null,
      messageStableId: data?.messageStableId ?? null,
      blockId: block.id,
      templateId: data?.templateId ?? null,
      options: {
        ...(data?.options ?? {}),
        deck_name: deckName,
      } as AnkiGenerationOptions,
    }),
    [data, block.id, deckName]
  );

  const [summaryExportPending, setSummaryExportPending] = useState(false);
  const handleSummaryExport = useCallback(async () => {
    if (cards.length === 0 || summaryExportPending) return;
    setSummaryExportPending(true);
    try {
      const result = await exportCardsAsApkg({ cards, context: summaryContext, deckName });
      if (result.cancelled) return;
      if (!result.success || !result.filePath) {
        throw new Error(t('blocks.ankiCards.action.exportFailedNoPath'));
      }
      logChatAnkiEvent(
        'chat_anki_action_performed',
        { action: 'export', cardCount: cards.length, entry: 'completion_summary' },
        summaryContext,
      );
      showGlobalNotification(
        'success',
        t('blocks.ankiCards.action.apkgExportedWithNote', {
          note: t('blocks.ankiCards.action.exportNewCardsNote'),
        }),
        result.filePath,
      );
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Summary export failed:', msg);
      showGlobalNotification('error', t('blocks.ankiCards.action.exportFailedWithHint'), msg);
    } finally {
      setSummaryExportPending(false);
    }
  }, [cards, summaryContext, summaryExportPending, deckName, t]);

  // ==========================================================================
  // 批量操作条：保存所选 / 导出所选（复用 chatAnkiActions，传选择子集）
  // ==========================================================================
  const [batchAction, setBatchAction] = useState<'save' | 'export' | null>(null);

  const handleSaveSelected = useCallback(async () => {
    if (selectedCards.length === 0 || batchAction) return;
    setBatchAction('save');
    try {
      const result = await saveCardsToLibrary({ cards: selectedCards, context: summaryContext });
      if (!result.success) {
        throw new Error(result.error || t('blocks.ankiCards.action.saveFailed'));
      }
      await handleCardsPersisted(result.cardIdMappings ?? []);
      logChatAnkiEvent(
        'chat_anki_action_performed',
        { action: 'save_selected', cardCount: result.savedCount },
        summaryContext,
      );
      showGlobalNotification(
        'success',
        t('blocks.ankiCards.action.savedCountWithHint', { count: result.savedCount }),
      );
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Save selected failed:', msg);
      showGlobalNotification(
        'error',
        t('blocks.ankiCards.action.saveFailedWithHint'),
        t('blocks.ankiCards.action.saveFailedDetail', { detail: msg }),
      );
    } finally {
      setBatchAction(null);
    }
  }, [selectedCards, batchAction, summaryContext, handleCardsPersisted, t]);

  const handleExportSelected = useCallback(async () => {
    if (selectedCards.length === 0 || batchAction) return;
    setBatchAction('export');
    try {
      const result = await exportCardsAsApkg({ cards: selectedCards, context: summaryContext, deckName });
      if (result.cancelled) return;
      if (!result.success || !result.filePath) {
        throw new Error(t('blocks.ankiCards.action.exportFailedNoPath'));
      }
      logChatAnkiEvent(
        'chat_anki_action_performed',
        { action: 'export_selected', cardCount: selectedCards.length },
        summaryContext,
      );
      showGlobalNotification(
        'success',
        t('blocks.ankiCards.action.apkgExportedWithNote', {
          note: t('blocks.ankiCards.action.exportNewCardsNote'),
        }),
        result.filePath,
      );
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Export selected failed:', msg);
      showGlobalNotification('error', t('blocks.ankiCards.action.exportFailedWithHint'), msg);
    } finally {
      setBatchAction(null);
    }
  }, [selectedCards, batchAction, summaryContext, deckName, t]);

  // "引用到输入框"：向聊天输入框注入 `卡片#N（id: xxx）` 文本
  const handleQuoteCard = useMemo(() => {
    if (!store) return undefined;
    return (index: number) => {
      const latestData = store.getState().blocks.get(block.id)?.toolOutput as
        | AnkiCardsBlockData
        | undefined;
      const card = (latestData?.cards ?? [])[index];
      if (!card?.id) return;
      const quote = t('blocks.ankiCards.quoteText', { index: index + 1, id: card.id });
      const state = store.getState();
      const current = state.inputValue ?? '';
      state.setInputValue(current ? `${current.replace(/\s+$/, '')} ${quote} ` : `${quote} `);
      logChatAnkiEvent('chat_anki_card_quoted', { index, blockId: block.id });
    };
  }, [store, block.id, t]);

  const handleOpenTaskCenter = useCallback(() => {
    workbenchBus.launch({ typeId: 'taskDashboard', reason: 'api' });
    logChatAnkiEvent(
      'chat_anki_action_performed',
      { action: 'open_task_center', cardCount: cards.length },
      summaryContext,
    );
  }, [cards.length, summaryContext]);

  return (
    <div className="chat-v2-anki-cards-block">
      {/* 折叠态：卡片预览 */}
      {!isExpanded && (
        <>
          {occlusionPreviewCards.length > 0 && (
            <div
              data-testid="anki-occlusion-preview-gallery"
              className="mb-2 grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              {occlusionPreviewCards.map(({ card, index, spec }) => (
                <AnkiOcclusionCardPreview
                  key={card.id || `occlusion-${index}`}
                  spec={spec}
                  cardIndex={index}
                />
              ))}
            </div>
          )}
          <AnkiCardStackPreview
            status={previewStatus}
            cards={cards}
            templateId={data?.templateId}
            template={template}
            templateMap={templateMap}
            debugContext={{
              blockId: block.id,
              documentId: data?.documentId,
            }}
            lastUpdatedAt={block.endedAt || block.startedAt}
            errorMessage={shouldShowChatAnkiProgress ? undefined : errorMessage}
            stableId={data?.messageStableId || block.messageId}
            disabled={false}
            onClick={cards.length > 0 ? handleToggleExpand : undefined}
          />
        </>
      )}

      {/* 展开态：内联卡片编辑列表 */}
      {isExpanded && cards.length > 0 && (
        <div className="ui-drop-in">
          {/* 头部统计 + 全选 + 布局切换 */}
          <div className="flex items-center justify-between gap-2 mb-3">
            <span className="flex min-w-0 items-center gap-2 text-xs font-medium text-muted-foreground">
              {selectableIds.length > 0 && (
                <Checkbox
                  checked={allSelected ? true : selectedCount > 0 ? 'indeterminate' : false}
                  onCheckedChange={handleToggleSelectAll}
                  aria-label={t('blocks.ankiCards.selectAll')}
                  title={t('blocks.ankiCards.selectAll')}
                />
              )}
              <span className="truncate tabular-nums">
                {t('blocks.ankiCards.title')} · {cards.length} {t('blocks.ankiCards.cards')}
              </span>
            </span>
            <div className="flex items-center gap-1">
              <DsButton
                type="button"
                variant={layout === 'list' ? 'default' : 'ghost'}
                size="icon"
                iconOnly
                onClick={() => setLayout('list')}
                className="lg:h-8 lg:w-8"
                aria-pressed={layout === 'list'}
                aria-label={tAnki('chatBlock.layoutList')}
                title={tAnki('chatBlock.layoutList')}
              >
                <Rows size={14} />
              </DsButton>
              <DsButton
                type="button"
                variant={layout === 'grid' ? 'default' : 'ghost'}
                size="icon"
                iconOnly
                onClick={() => setLayout('grid')}
                className="lg:h-8 lg:w-8"
                aria-pressed={layout === 'grid'}
                aria-label={tAnki('chatBlock.layoutGrid')}
                title={tAnki('chatBlock.layoutGrid')}
              >
                <SquaresFour size={14} />
              </DsButton>
              <DsButton
                type="button"
                size="sm"
                variant="ghost"
                onClick={handleToggleExpand}
                className="min-h-10 px-2"
              >
                <CaretUp size={14} />
                {t('blocks.ankiCards.collapse')}
              </DsButton>
            </div>
          </div>

          {/* 批量操作条：已选 N 张 + 反选/删除/保存/导出所选 */}
          {selectedCount > 0 && (
            <AnkiBatchSelectionBar
              selectedCount={selectedCount}
              batchAction={batchAction}
              isGenerating={isGenerating}
              onInvertSelection={handleInvertSelection}
              onDeleteSelected={handleDeleteSelected}
              onSaveSelected={() => void handleSaveSelected()}
              onExportSelected={() => void handleExportSelected()}
            />
          )}

          {/* 卡片列表（分页渲染，防止大量 iframe 崩溃；逐张 stagger 入场） */}
          <div
            className={cn(
              layout === 'grid'
                ? 'grid grid-cols-1 gap-2 sm:grid-cols-2'
                : 'space-y-2'
            )}
          >
            {cards.slice(0, visibleCount).map((card, index) => (
              <div
                key={card.id || `card-${index}`}
                className={cn(
                  'canki-card-enter flex items-start gap-2',
                  card.id && exitingIds.has(card.id) && 'canki-card-exit',
                  layout === 'grid' && editingIndex === index && 'sm:col-span-2'
                )}
                style={{ '--canki-stagger': `${Math.min(index, 10) * 35}ms` } as React.CSSProperties}
              >
                {card.id && (
                  <Checkbox
                    checked={selectedIds.has(card.id)}
                    onCheckedChange={() => handleToggleSelect(card.id as string)}
                    aria-label={t('blocks.ankiCards.selectCard', { index: index + 1 })}
                    className="mt-3 flex-shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <InlineCardItem
                    card={card}
                    index={index}
                    isEditing={editingIndex === index}
                    template={template}
                    templateMap={templateMap}
                    onToggleEdit={handleToggleEdit}
                    onSave={handleSaveCard}
                    onDelete={handleDeleteCard}
                    onQuote={handleQuoteCard}
                    disabled={isGenerating && !hasRealCardId(card)}
                    initialDraft={editingIndex === index ? restoredDraft : null}
                    onDraftChange={handleDraftChange}
                  />
                </div>
              </div>
            ))}
            {/* 生成仍在进行（如重试失败分段）时的骨架占位 */}
            {isBlockBusy && visibleCount >= cards.length && (
              <AnkiCardSkeleton hint={tAnki('chatBlock.skeletonHint')} />
            )}
            {/* 加载更多按钮 */}
            {visibleCount < cards.length && (
              <div
                className={cn(
                  'flex items-center justify-center gap-2 py-2',
                  layout === 'grid' && 'sm:col-span-2'
                )}
              >
                <DsButton
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setVisibleCount((prev) => prev + CARDS_PAGE_SIZE)}
                  className="min-h-10 text-xs"
                >
                  {t('blocks.ankiCards.showMore', { remaining: cards.length - visibleCount })}
                </DsButton>
                {/* >50 张时不再一键挂全部 iframe，改为大步长分页（每次 +50） */}
                {cards.length > 50 ? (
                  <DsButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setVisibleCount((prev) => prev + 50)}
                    className="min-h-10 text-xs text-muted-foreground"
                  >
                    {t('blocks.ankiCards.showMoreBig', { count: 50 })}
                  </DsButton>
                ) : (
                  <DsButton
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setVisibleCount(cards.length)}
                    className="min-h-10 text-xs text-muted-foreground"
                  >
                    {t('blocks.ankiCards.showAll', { total: cards.length })}
                  </DsButton>
                )}
              </div>
            )}
            {/* 滚动锚点：新卡片到来时自动滚动到此处 */}
            <div
              ref={cardsEndRef}
              className={cn('scroll-mb-48', layout === 'grid' && 'sm:col-span-2')}
            />
          </div>

          {/* 错误/状态信息 */}
          {errorMessage && !shouldShowChatAnkiProgress && (
            <div role="alert" className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-2 py-1 text-sm text-destructive">
              {errorMessage}
            </div>
          )}
        </div>
      )}

      {/* 底部操作区：移动端全宽，桌面端保持原布局 */}
      {(shouldShowChatAnkiProgress ||
        cards.length > 0 ||
        retryableTaskIds.length > 0 ||
        Boolean(pendingDelete) ||
        (Boolean(data?.documentId) &&
          (isBlockBusy ||
            data?.progress?.stage?.toLowerCase() === 'paused' ||
            data?.finalStatus?.toLowerCase() === 'paused'))) && (
        <FullWidthCardWrapper className="chatanki-bottom-actions">
          {/* 完成态小结：张数 / 用时 / 任务中心 / 导出 */}
          {showCompletionSummary && (
            <AnkiCompletionSummary
              summaryText={tAnki('chatBlock.summaryCompleted', { count: cards.length })}
              durationText={durationText}
              taskCenterLabel={tAnki('chatBlock.openTaskCenter')}
              onOpenTaskCenter={handleOpenTaskCenter}
              exportLabel={tAnki('chatBlock.exportApkg')}
              onExport={() => void handleSummaryExport()}
              exportPending={summaryExportPending}
            />
          )}

          {shouldShowChatAnkiProgress && (
            <ChatAnkiProgressCompact
              progress={data?.progress}
              ankiConnect={data?.ankiConnect}
              warnings={data?.warnings}
              mediaReport={mediaReport}
              cardsCount={cards.length}
              blockStatus={block.status}
              finalStatus={data?.finalStatus}
              errorMessage={errorMessage}
            />
          )}

          {/* AI 质检终审任务级摘要（字段尚未收进 AnkiCardsBlockData，宽松透传；无数据时组件自行不渲染） */}
          <AnkiCriticSummaryBanner criticSummary={(data as { criticSummary?: unknown } | undefined)?.criticSummary} />

          {/* 质检标记块级摘要：折叠/展开态均可见，提示复查后再导出 */}
          {qaFlagsSummary.flaggedCardCount > 0 && (
            <AnkiQaFlagsSummaryChip
              flaggedCardCount={qaFlagsSummary.flaggedCardCount}
              maxSeverity={qaFlagsSummary.maxSeverity}
            />
          )}

          {/* 删除撤销条（6s 窗口，倒计时结束才真正提交 DB 删除；批量共用一个窗口） */}
          {pendingDelete && pendingDelete.entries.length > 0 && (
            <AnkiInlineUndoBar
              message={
                pendingDelete.entries.length === 1
                  ? tAnki('chatBlock.deletedCard', { index: pendingDelete.entries[0].index + 1 })
                  : tAnki('chatBlock.deletedCards', { count: pendingDelete.entries.length })
              }
              undoLabel={tAnki('chatBlock.undo')}
              onUndo={handleUndoDelete}
              durationMs={UNDO_DELETE_WINDOW_MS}
            />
          )}

          {/* 操作按钮组：有卡片，或运行中/暂停且有 documentId（暂停/继续/取消） */}
          {(cards.length > 0 ||
            retryableTaskIds.length > 0 ||
            (Boolean(data?.documentId) &&
              (isBlockBusy ||
                data?.progress?.stage?.toLowerCase() === 'paused' ||
                data?.finalStatus?.toLowerCase() === 'paused'))) && (
            <AnkiCardActionButtons
              cards={cards}
              data={data}
              blockId={block.id}
              blockStatus={block.status}
              isStreaming={isStreaming}
              isExpanded={isExpanded}
              onToggleExpand={handleToggleExpand}
              retryableTaskCount={retryableTaskIds.length}
              retryStatus={retryStatus}
              retryError={retryError}
              onRetryFailedSegments={handleRetryFailedSegments}
              deckName={deckName}
              onDeckNameChange={handleDeckNameChange}
              onSyncStatusChange={handleSyncStatusChange}
              onCardsPersisted={handleCardsPersisted}
              hideExportInMenu={showCompletionSummary}
            />
          )}
        </FullWidthCardWrapper>
      )}
    </div>
  );
});

// ============================================================================
// 自动注册
// ============================================================================

blockRegistry.register('anki_cards', {
  type: 'anki_cards',
  component: AnkiCardsBlock,
  onAbort: 'keep-content', // 中断时保留已生成的卡片
});

// 导出组件（供测试和其他模块使用）
export { AnkiCardsBlock };
