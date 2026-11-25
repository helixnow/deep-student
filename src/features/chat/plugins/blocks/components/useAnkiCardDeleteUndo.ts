/**
 * Chat V2 - Anki 卡片块删除与撤销 Hook
 *
 * 乐观更新（先移除 UI 投影），撤销窗口结束后才提交 DB 删除；
 * 一个撤销窗口覆盖整个选择集；提交失败自动回滚恢复卡片投影。
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { AnkiCard } from '@/types';
import type { BlockComponentProps } from '../../../registry';
import { logChatAnkiEvent } from '../../../anki';
import {
  cancelPendingDelete,
  commitPendingDeleteNow,
  schedulePendingDelete,
} from '../pendingCardDeletes';
import type { AnkiCardsBlockData, PendingDeleteEntry } from './ankiCardsBlockTypes';

/** 单卡删除的撤销窗口：窗口结束才真正提交 DB 删除 */
export const UNDO_DELETE_WINDOW_MS = 6000;

export interface UseAnkiCardDeleteUndoOptions {
  blockId: string;
  store: BlockComponentProps['store'];
  cards: AnkiCard[];
  persistToolOutput: (newData: AnkiCardsBlockData, propagateError?: boolean) => Promise<void>;
  setEditingIndex: Dispatch<SetStateAction<number>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
}

export interface UseAnkiCardDeleteUndoResult {
  pendingDelete: { entries: PendingDeleteEntry[] } | null;
  exitingIds: Set<string>;
  requestDeleteCards: (targets: Array<{ id?: string; index: number }>) => void;
  handleDeleteCard: (index: number) => void;
  handleUndoDelete: () => void;
}

export function useAnkiCardDeleteUndo({
  blockId,
  store,
  cards,
  persistToolOutput,
  setEditingIndex,
  setSelectedIds,
}: UseAnkiCardDeleteUndoOptions): UseAnkiCardDeleteUndoResult {
  const { t: tAnki } = useTranslation('anki');
  const [pendingDelete, setPendingDelete] = useState<{ entries: PendingDeleteEntry[] } | null>(null);
  const pendingDeleteRef = useRef<{ entries: PendingDeleteEntry[] } | null>(null);
  // 删除退出动画：先标记 exiting，动画结束后才真正从投影移除
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 把卡片恢复到 store 投影（撤销 / DB 删除失败回滚共用）
  const restoreDeletedCards = useCallback(
    (entries: PendingDeleteEntry[]) => {
      if (!store || entries.length === 0) return;
      const latestBlock = store.getState().blocks.get(blockId);
      const latestData = latestBlock?.toolOutput as AnkiCardsBlockData | undefined;
      if (!latestData) return;
      const nextCards = [...(latestData.cards ?? [])];
      let changed = false;
      // 按原索引升序插回，尽量还原原相对位置
      [...entries]
        .sort((a, b) => a.index - b.index)
        .forEach((entry) => {
          // 流式更新可能已重新带回同 id 卡片，避免重复插入
          if (entry.card.id && nextCards.some((card) => card.id === entry.card.id)) return;
          const insertAt = Math.min(Math.max(entry.index, 0), nextCards.length);
          nextCards.splice(insertAt, 0, entry.card);
          changed = true;
        });
      if (!changed) return;
      const newData: AnkiCardsBlockData = { ...latestData, cards: nextCards };
      store.getState().updateBlock(blockId, { toolOutput: newData });
      void persistToolOutput(newData);
    },
    [store, blockId, persistToolOutput]
  );

  // 提交待删除卡片的 DB 删除（新删除到来时结算上一个窗口）。
  // 实际的撤销计时与提交由模块级 pendingCardDeletes 管理（F19），
  // 组件卸载不会强制提前提交或吞掉失败。
  const flushPendingDelete = useCallback(() => {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    pendingDeleteRef.current = null;
    setPendingDelete(null);
    commitPendingDeleteNow(blockId);
  }, [blockId]);

  // 组件卸载（虚拟滚动等）时只清理本地动画定时器；待提交删除继续由模块级
  // 管理器在撤销窗口结束后完成，失败会回写投影并提示，不再静默吞掉。
  useEffect(() => {
    return () => {
      if (exitTimerRef.current) clearTimeout(exitTimerRef.current);
    };
  }, []);

  // 立即执行删除（乐观移除投影 + 打开撤销窗口）。targets 支持按 id（优先）或索引解析。
  const commitDeleteCards = useCallback(
    (targets: Array<{ id?: string; index: number }>) => {
      if (!store || targets.length === 0) return;
      // 同一时刻只保留一个撤销窗口：先提交上一个
      flushPendingDelete();
      const latestBlock = store.getState().blocks.get(blockId);
      const latestData = latestBlock?.toolOutput as AnkiCardsBlockData | undefined;
      if (!latestData) return;
      const latestCards = latestData.cards ?? [];
      // 以最新 store 解析目标（流式期间索引可能漂移，优先按 id 匹配）
      const removeIndices = new Set<number>();
      targets.forEach((target) => {
        if (target.id) {
          const byId = latestCards.findIndex((card) => card.id === target.id);
          if (byId >= 0) removeIndices.add(byId);
          return;
        }
        if (target.index >= 0 && target.index < latestCards.length) {
          removeIndices.add(target.index);
        }
      });
      if (removeIndices.size === 0) return;
      const entries: PendingDeleteEntry[] = [...removeIndices]
        .sort((a, b) => a - b)
        .map((index) => ({ card: latestCards[index], index }));
      const newCards = latestCards.filter((_, i) => !removeIndices.has(i));
      const newData: AnkiCardsBlockData = { ...latestData, cards: newCards };
      store.getState().updateBlock(blockId, { toolOutput: newData });
      void persistToolOutput(newData);
      // 🔧 删除非编辑中的卡片时，正确调整 editingIndex 避免偏移到错误卡片
      setEditingIndex((prev) => {
        if (prev < 0) return prev;
        if (removeIndices.has(prev)) return -1;
        const shift = [...removeIndices].filter((i) => i < prev).length;
        return prev - shift;
      });
      // 从多选集合中清掉已删除的卡片
      setSelectedIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set(prev);
        entries.forEach((entry) => {
          if (entry.card.id) next.delete(entry.card.id);
        });
        return next;
      });
      setExitingIds(new Set());
      const pending = { entries };
      pendingDeleteRef.current = pending;
      setPendingDelete(pending);
      // 撤销窗口与 DB 提交交给模块级管理器，脱离组件卸载生命周期（F19）
      schedulePendingDelete(
        blockId,
        {
          cardIds: entries
            .map((entry) => entry.card.id)
            .filter((id): id is string => Boolean(id)),
          restore: (failedCardIds) => {
            const failed = new Set(failedCardIds);
            restoreDeletedCards(
              entries.filter((entry) => entry.card.id && failed.has(entry.card.id)),
            );
          },
          onResult: ({ failed }) => {
            if (failed.length > 0) {
              showGlobalNotification('warning', tAnki('chatBlock.deleteCommitFailed'));
            }
          },
        },
        UNDO_DELETE_WINDOW_MS,
      );
      logChatAnkiEvent('chat_anki_card_deleted', {
        indices: entries.map((entry) => entry.index),
        count: entries.length,
        blockId,
      });
    },
    [
      store,
      blockId,
      persistToolOutput,
      flushPendingDelete,
      restoreDeletedCards,
      setEditingIndex,
      setSelectedIds,
      tAnki,
    ]
  );

  // 请求删除：先播放退出动画（高度塌缩+淡出），动画结束后真正提交。
  // prefers-reduced-motion 下直接删除，遵守既有降级模式。
  const requestDeleteCards = useCallback(
    (targets: Array<{ id?: string; index: number }>) => {
      if (targets.length === 0) return;
      const reduceMotion =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const animatableIds = targets
        .map((target) => target.id)
        .filter((id): id is string => Boolean(id));
      if (reduceMotion || animatableIds.length === 0 || exitTimerRef.current) {
        commitDeleteCards(targets);
        return;
      }
      setExitingIds(new Set(animatableIds));
      exitTimerRef.current = setTimeout(() => {
        exitTimerRef.current = null;
        commitDeleteCards(targets);
      }, 220);
    },
    [commitDeleteCards]
  );

  // 单卡删除入口（InlineCardItem onDelete）
  const handleDeleteCard = useCallback(
    (index: number) => {
      const card = cards[index];
      requestDeleteCards([{ id: card?.id, index }]);
    },
    [cards, requestDeleteCards]
  );

  // 撤销删除：取消模块级提交定时器并恢复投影（覆盖整个选择集）
  const handleUndoDelete = useCallback(() => {
    const pending = pendingDeleteRef.current;
    if (!pending) return;
    cancelPendingDelete(blockId);
    pendingDeleteRef.current = null;
    setPendingDelete(null);
    restoreDeletedCards(pending.entries);
    logChatAnkiEvent('chat_anki_card_delete_undone', {
      indices: pending.entries.map((entry) => entry.index),
      count: pending.entries.length,
      blockId,
    });
  }, [restoreDeletedCards, blockId]);

  return {
    pendingDelete,
    exitingIds,
    requestDeleteCards,
    handleDeleteCard,
    handleUndoDelete,
  };
}
