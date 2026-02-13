/**
 * Chat V2 - Anki 面板宿主组件
 *
 * 监听 open-anki-panel 事件，显示侧边栏 Anki 编辑面板。
 * 提供卡片预览、编辑、导出和同步功能。
 *
 * 这是 CardForge 2.0 与 Chat V2 集成的关键组件。
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/shad/Sheet';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Download, Send, Trash2, X, Loader2, Check, AlertCircle } from 'lucide-react';
import { useAnkiPanelV2Bridge } from '../hooks/useAnkiPanelV2Bridge';
import { ChatV2AnkiAdapter } from '@/components/anki/cardforge/adapters/chatV2Adapter';
import { cn } from '@/utils/cn';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import type { AnkiCard } from '@/types';
import { unifiedConfirm } from '@/utils/unifiedDialogs';

// ============================================================================
// 类型定义
// ============================================================================

type ActionStatus = 'idle' | 'loading' | 'success' | 'error';

interface CardItemProps {
  card: AnkiCard;
  index: number;
  onRemove: (card: AnkiCard, index: number) => void;
}

// ============================================================================
// 子组件：卡片项
// ============================================================================

const CardItem: React.FC<CardItemProps> = ({ card, index, onRemove }) => {
  const { t } = useTranslation('anki');
  const front = card.front ?? card.fields?.Front ?? '';
  const back = card.back ?? card.fields?.Back ?? '';

  return (
    <div className="group relative p-4 border rounded-lg bg-card hover:bg-accent/50 transition-colors">
      {/* 删除按钮 */}
      <button
        onClick={() => onRemove(card, index)}
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-destructive/10 rounded"
        title={t('chatV2.removeCard')}
      >
        <X className="w-4 h-4 text-muted-foreground hover:text-destructive" />
      </button>

      {/* 序号 */}
      <div className="absolute top-2 left-2 text-xs text-muted-foreground">
        #{index + 1}
      </div>

      {/* 内容 */}
      <div className="mt-4 space-y-2">
        <div>
          <div className="text-xs text-muted-foreground mb-1">{t('chatV2.front')}</div>
          <div className="text-sm font-medium line-clamp-3">
            {front || <span className="text-muted-foreground italic">{t('chatV2.noContent')}</span>}
          </div>
        </div>
        <div>
          <div className="text-xs text-muted-foreground mb-1">{t('chatV2.back')}</div>
          <div className="text-sm text-muted-foreground line-clamp-3">
            {back || <span className="italic">{t('chatV2.noContent')}</span>}
          </div>
        </div>
        {card.tags && card.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {card.tags.slice(0, 5).map((tag, i) => (
              <span
                key={i}
                className="px-1.5 py-0.5 text-xs bg-muted rounded"
              >
                {tag}
              </span>
            ))}
            {card.tags.length > 5 && (
              <span className="px-1.5 py-0.5 text-xs text-muted-foreground">
                +{card.tags.length - 5}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// 主组件
// ============================================================================

export const AnkiPanelHost: React.FC = () => {
  const { t } = useTranslation('anki');
  const { isSmallScreen } = useBreakpoint();
  const {
    isOpen,
    cards,
    blockId,
    businessSessionId,
    closePanel,
    updateCards,
  } = useAnkiPanelV2Bridge();

  // 操作状态
  const [exportStatus, setExportStatus] = useState<ActionStatus>('idle');
  const [syncStatus, setSyncStatus] = useState<ActionStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [undoState, setUndoState] = useState<{ card: AnkiCard; index: number } | null>(null);
  const undoTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const UNDO_TIMEOUT_MS = 6000;

  // 重置状态
  const resetStatus = useCallback((setter: React.Dispatch<React.SetStateAction<ActionStatus>>) => {
    setTimeout(() => setter('idle'), 2000);
  }, []);

  // 导出为 APKG
  const handleExport = useCallback(async () => {
    if (cards.length === 0) return;

    setExportStatus('loading');
    setErrorMessage(null);

    try {
      const chatV2Cards = cards.map((card) => ({
        id: card.id,
        front: card.front ?? card.fields?.Front ?? '',
        back: card.back ?? card.fields?.Back ?? '',
        tags: card.tags || [],
        fields: card.fields,
      }));

      const result = await ChatV2AnkiAdapter.exportCards(chatV2Cards, {
        format: 'apkg',
        deckName: businessSessionId || 'Chat V2 Export',
      });

      if (result.ok) {
        setExportStatus('success');
        console.log('[AnkiPanelHost] Export success:', result.filePath);
      } else {
        throw new Error(result.error || t('chatV2.exportFailed'));
      }
    } catch (error: unknown) {
      setExportStatus('error');
      setErrorMessage(error instanceof Error ? error.message : t('chatV2.exportFailed'));
      console.error('[AnkiPanelHost] Export error:', error);
    } finally {
      resetStatus(setExportStatus);
    }
  }, [cards, businessSessionId, resetStatus, t]);

  // 同步到 AnkiConnect
  const handleSync = useCallback(async () => {
    if (cards.length === 0) return;

    setSyncStatus('loading');
    setErrorMessage(null);

    try {
      const chatV2Cards = cards.map((card) => ({
        id: card.id,
        front: card.front ?? card.fields?.Front ?? '',
        back: card.back ?? card.fields?.Back ?? '',
        tags: card.tags || [],
        fields: card.fields,
      }));

      const result = await ChatV2AnkiAdapter.exportCards(chatV2Cards, {
        format: 'anki_connect',
        deckName: businessSessionId || 'Chat V2 Import',
      });

      if (result.ok) {
        setSyncStatus('success');
        console.log('[AnkiPanelHost] Sync success:', result.importedCount, 'cards');
      } else {
        throw new Error(result.error || t('chatV2.syncFailed'));
      }
    } catch (error: unknown) {
      setSyncStatus('error');
      setErrorMessage(error instanceof Error ? error.message : t('chatV2.syncFailed'));
      console.error('[AnkiPanelHost] Sync error:', error);
    } finally {
      resetStatus(setSyncStatus);
    }
  }, [cards, businessSessionId, resetStatus, t]);

  // 移除卡片
  const scheduleUndoClear = useCallback(() => {
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
    }
    undoTimerRef.current = setTimeout(() => {
      setUndoState(null);
      undoTimerRef.current = null;
    }, UNDO_TIMEOUT_MS);
  }, []);

  const handleRemoveCard = useCallback(
    (card: AnkiCard, index: number) => {
      if (!card) return;
      const cardId = typeof card.id === 'string' ? card.id : '';
      const confirmKey = cardId ? `anki-panel-remove:${cardId}` : `anki-panel-remove:${index}`;
      if (!unifiedConfirm(t('chatV2.removeCardConfirm'), { key: confirmKey })) {
        return;
      }
      const nextCards = cardId
        ? cards.filter((c) => c.id !== cardId)
        : cards.filter((_c, idx) => idx !== index);
      if (nextCards.length === cards.length) return;
      updateCards(nextCards);
      setUndoState({ card, index });
      scheduleUndoClear();
    },
    [cards, scheduleUndoClear, t, updateCards]
  );

  const handleUndoRemove = useCallback(() => {
    if (!undoState) return;
    if (undoTimerRef.current) {
      clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
    const hasDuplicate =
      undoState.card.id &&
      cards.some((c) => c.id === undoState.card.id);
    if (hasDuplicate) {
      setUndoState(null);
      return;
    }
    const insertIndex = Math.min(Math.max(undoState.index, 0), cards.length);
    const nextCards = [...cards];
    nextCards.splice(insertIndex, 0, undoState.card);
    updateCards(nextCards);
    setUndoState(null);
  }, [cards, undoState, updateCards]);

  useEffect(() => {
    return () => {
      if (undoTimerRef.current) {
        clearTimeout(undoTimerRef.current);
        undoTimerRef.current = null;
      }
    };
  }, []);

  // 获取按钮图标
  const getButtonIcon = (status: ActionStatus, DefaultIcon: React.ElementType) => {
    switch (status) {
      case 'loading':
        return <Loader2 className="w-4 h-4 animate-spin" />;
      case 'success':
        return <Check className="w-4 h-4 text-green-500" />;
      case 'error':
        return <AlertCircle className="w-4 h-4 text-destructive" />;
      default:
        return <DefaultIcon className="w-4 h-4" />;
    }
  };

  if (!isOpen) return null;

  return (
    <Sheet open={isOpen} onOpenChange={(open) => !open && closePanel()}>
      <SheetContent
        side="right"
        className={cn(
          "p-0 flex flex-col",
          isSmallScreen ? "w-full" : "w-[450px] sm:w-[500px]"
        )}
      >
        {/* 头部 */}
        <SheetHeader className={cn("border-b", isSmallScreen ? "px-4 py-3" : "px-6 py-4")}>
          <SheetTitle className="flex items-center gap-2">
            {t('chatV2.cardEdit')}
          </SheetTitle>
          <SheetDescription>
            {t('chatV2.totalCards', { count: cards.length })}
            {blockId && <span className="ml-2 text-xs">· Block: {blockId.slice(0, 8)}...</span>}
          </SheetDescription>
        </SheetHeader>

        {/* 错误提示 */}
        {errorMessage && (
          <div className={cn(
            "mt-4 p-3 bg-destructive/10 text-destructive text-sm rounded-md flex items-center gap-2",
            isSmallScreen ? "mx-4" : "mx-6"
          )}>
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            {errorMessage}
          </div>
        )}
        {undoState && (
          <div className={cn(
            "mt-4 flex items-center justify-between gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm",
            isSmallScreen ? "mx-4" : "mx-6"
          )}>
            <span className="text-muted-foreground">{t('chatV2.cardRemoved')}</span>
            <NotionButton size="sm" variant="ghost" onClick={handleUndoRemove}>
              {t('chatV2.undoRemove')}
            </NotionButton>
          </div>
        )}

        {/* 操作按钮 */}
        <div className={cn("py-3 border-b flex gap-2", isSmallScreen ? "px-4" : "px-6")}>
          <NotionButton
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={cards.length === 0 || exportStatus === 'loading'}
            className={cn(
              'flex-1',
              exportStatus === 'success' && 'border-green-500',
              exportStatus === 'error' && 'border-destructive'
            )}
          >
            {getButtonIcon(exportStatus, Download)}
            <span className="ml-2">{t('chatV2.exportApkg')}</span>
          </NotionButton>
          <NotionButton
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={cards.length === 0 || syncStatus === 'loading'}
            className={cn(
              'flex-1',
              syncStatus === 'success' && 'border-green-500',
              syncStatus === 'error' && 'border-destructive'
            )}
          >
            {getButtonIcon(syncStatus, Send)}
            <span className="ml-2">{t('chatV2.syncToAnki')}</span>
          </NotionButton>
        </div>

        {/* 卡片列表 */}
        <CustomScrollArea className={cn("flex-1 py-4", isSmallScreen ? "px-4" : "px-6")}>
          {cards.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-40 text-muted-foreground">
              <Trash2 className="w-8 h-8 mb-2 opacity-50" />
              <p>{t('chatV2.noCards')}</p>
            </div>
          ) : (
            <div className="space-y-3">
              {cards.map((card, index) => (
                <CardItem
                  key={card.id || index}
                  card={card}
                  index={index}
                  onRemove={handleRemoveCard}
                />
              ))}
            </div>
          )}
        </CustomScrollArea>

        {/* 底部操作 */}
        <div className={cn("py-3 border-t", isSmallScreen ? "px-4 pb-safe" : "px-6")}>
          <NotionButton variant="ghost" size="sm" onClick={closePanel} className="w-full">
            {t('chatV2.close')}
          </NotionButton>
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default AnkiPanelHost;
