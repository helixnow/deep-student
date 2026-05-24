/**
 * Chat V2 - Anki 面板桥接 Hook
 *
 * 监听 `open-anki-panel` 事件，管理 Anki 编辑面板状态。
 * 这是 Chat V2 与 CardForge 2.0 面板交互的核心桥接。
 *
 * @example
 * ```tsx
 * const { isOpen, cards, closePanel } = useAnkiPanelV2Bridge();
 *
 * return isOpen ? <AnkiEditPanel cards={cards} onClose={closePanel} /> : null;
 * ```
 */

import { useEffect, useState, useCallback } from 'react';
import type { AnkiCard } from '@/types';

// ============================================================================
// 类型定义
// ============================================================================

/**
 * open-anki-panel 事件参数
 */
export interface OpenAnkiPanelParams {
  /** 触发事件的块 ID */
  blockId?: string;
  /** 关联的消息 ID */
  messageId?: string;
  /** 业务会话 ID */
  businessSessionId?: string;
  /** 要编辑的卡片列表 */
  cards?: AnkiCard[];
}

/**
 * Anki 面板状态
 */
export interface AnkiPanelState {
  /** 面板是否打开 */
  isOpen: boolean;
  /** 触发事件的块 ID */
  blockId: string | null;
  /** 关联的消息 ID */
  messageId: string | null;
  /** 业务会话 ID */
  businessSessionId: string | null;
  /** 当前编辑的卡片列表 */
  cards: AnkiCard[];
}

// ============================================================================
// 初始状态
// ============================================================================

const initialState: AnkiPanelState = {
  isOpen: false,
  blockId: null,
  messageId: null,
  businessSessionId: null,
  cards: [],
};

// ============================================================================
// Hook 实现
// ============================================================================

/**
 * Anki 面板桥接 Hook
 *
 * 监听 `open-anki-panel` CustomEvent 并管理面板状态。
 */
export function useAnkiPanelV2Bridge() {
  const [panelState, setPanelState] = useState<AnkiPanelState>(initialState);

  // 打开面板
  const openPanel = useCallback((params: OpenAnkiPanelParams) => {
    console.log('[useAnkiPanelV2Bridge] Opening panel with params:', params);
    setPanelState({
      isOpen: true,
      blockId: params.blockId || null,
      messageId: params.messageId || null,
      businessSessionId: params.businessSessionId || null,
      cards: params.cards || [],
    });
  }, []);

  // 关闭面板
  const closePanel = useCallback(() => {
    console.log('[useAnkiPanelV2Bridge] Closing panel');
    setPanelState(initialState);
  }, []);

  // 更新卡片列表
  const updateCards = useCallback((cards: AnkiCard[]) => {
    setPanelState((prev) => ({ ...prev, cards }));
  }, []);

  // 添加单张卡片
  const addCard = useCallback((card: AnkiCard) => {
    setPanelState((prev) => ({
      ...prev,
      cards: [...prev.cards, card],
    }));
  }, []);

  // 移除单张卡片
  const removeCard = useCallback((cardId: string) => {
    setPanelState((prev) => ({
      ...prev,
      cards: prev.cards.filter((c) => c.id !== cardId),
    }));
  }, []);

  // 更新单张卡片
  const updateCard = useCallback((cardId: string, updates: Partial<AnkiCard>) => {
    setPanelState((prev) => ({
      ...prev,
      cards: prev.cards.map((c) =>
        c.id === cardId ? { ...c, ...updates } : c
      ),
    }));
  }, []);

  // 监听 open-anki-panel 事件
  useEffect(() => {
    const handleOpenPanel = (event: Event) => {
      const customEvent = event as CustomEvent<OpenAnkiPanelParams>;
      console.log('[useAnkiPanelV2Bridge] Received open-anki-panel event:', customEvent.detail);
      openPanel(customEvent.detail || {});
    };

    window.addEventListener('open-anki-panel', handleOpenPanel);

    return () => {
      window.removeEventListener('open-anki-panel', handleOpenPanel);
    };
  }, [openPanel]);

  return {
    // 状态
    ...panelState,

    // 操作方法
    openPanel,
    closePanel,
    updateCards,
    addCard,
    removeCard,
    updateCard,
  };
}

// ============================================================================
// 类型导出
// ============================================================================

export type UseAnkiPanelV2BridgeReturn = ReturnType<typeof useAnkiPanelV2Bridge>;
