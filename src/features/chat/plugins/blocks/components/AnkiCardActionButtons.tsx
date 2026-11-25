/**
 * Chat V2 - Anki 卡片块操作按钮组子组件
 *
 * 负责任务控制（暂停/继续/取消）、失败分段重试、展开编辑、保存到卡片库、
 * 批量复习、牌组名选择，以及导出 APKG / AnkiConnect 同步菜单。
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise,
  Cards,
  CaretUp,
  Check,
  DotsThree,
  DownloadSimple,
  FloppyDisk,
  PaperPlaneRight,
  Pause,
  Pencil,
  Play,
  Stack,
  Stop,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { PulseDot } from '@/components/ui/PulseDot';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import {
  AppMenu,
  AppMenuContent,
  AppMenuGroup,
  AppMenuItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { isMobilePlatform } from '@/utils/platform';
import { getErrorMessage } from '@/utils/errorUtils';
import { controlDocumentTask } from '@/features/anki/taskControl';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import {
  saveCardsToLibrary,
  exportCardsAsApkg,
  importCardsViaAnkiConnect,
  logChatAnkiEvent,
} from '../../../anki';
import type { AnkiCard, AnkiGenerationOptions } from '@/types';
import type { SaveAnkiCardIdMapping } from '@/services/ankiApiAdapter';
import type { ActionStatus, AnkiCardsBlockData } from './ankiCardsBlockTypes';

export interface AnkiCardActionButtonsProps {
  cards: AnkiCard[];
  data: AnkiCardsBlockData | undefined;
  blockId: string;
  blockStatus: string;
  isStreaming?: boolean;
  isExpanded: boolean;
  onToggleExpand: () => void;
  retryableTaskCount: number;
  retryStatus: ActionStatus;
  retryError: string | null;
  onRetryFailedSegments: () => Promise<void>;
  /** 保存/导出/同步共用的牌组名（用户可在牌组选择器中修改） */
  deckName: string;
  onDeckNameChange: (deckName: string) => void;
  /** 同步成功/失败后回写块 toolOutput.syncStatus（消灭 syncStatus 空转） */
  onSyncStatusChange?: (status: 'synced' | 'error' | 'syncing', error?: string) => void;
  /** 保存成功后用后端返回的真实 ID 更新并持久化当前块。 */
  onCardsPersisted?: (mappings: SaveAnkiCardIdMapping[]) => Promise<void>;
}

export const AnkiCardActionButtons: React.FC<AnkiCardActionButtonsProps> = ({
  cards,
  data,
  blockId,
  blockStatus,
  isStreaming,
  isExpanded,
  onToggleExpand,
  retryableTaskCount,
  retryStatus,
  retryError,
  onRetryFailedSegments,
  deckName,
  onDeckNameChange,
  onSyncStatusChange,
  onCardsPersisted,
}) => {
  const { t } = useTranslation('chatV2');
  const [saveStatus, setSaveStatus] = useState<ActionStatus>('idle');
  const [exportStatus, setExportStatus] = useState<ActionStatus>('idle');
  const [syncStatus, setSyncStatus] = useState<ActionStatus>('idle');
  const [taskControlStatus, setTaskControlStatus] = useState<ActionStatus>('idle');
  /** 记录当前点击的是哪个任务控制按钮，pending/结果反馈只落在该按钮上 */
  const [pendingTaskAction, setPendingTaskAction] = useState<'pause' | 'resume' | 'cancel' | null>(null);

  // 同步互斥锁：防止同一事件循环 tick 内的快速双击导致重复调用
  const actionLockRef = useRef<Set<string>>(new Set());
  const timeoutRefs = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  useEffect(() => {
    const timeouts = timeoutRefs.current;
    return () => {
      timeouts.forEach((id) => clearTimeout(id));
      timeouts.clear();
    };
  }, []);

  const context = useMemo(
    () => ({
      documentId: data?.documentId ?? null,
      businessSessionId: data?.businessSessionId ?? null,
      messageStableId: data?.messageStableId ?? null,
      blockId,
      templateId: data?.templateId ?? null,
      // 用户选择的牌组名优先于生成期 options 中的 deck_name
      options: {
        ...(data?.options ?? {}),
        deck_name: deckName,
      } as AnkiGenerationOptions,
    }),
    [blockId, data, deckName]
  );

  const resetStatusAfterDelay = useCallback(
    (setter: React.Dispatch<React.SetStateAction<ActionStatus>>) => {
      const timeoutId = setTimeout(() => {
        setter('idle');
        timeoutRefs.current.delete(timeoutId);
      }, 2000);
      timeoutRefs.current.add(timeoutId);
    },
    []
  );

  const documentId = data?.documentId;
  const progressStage = data?.progress?.stage?.toLowerCase();
  const isPaused =
    progressStage === 'paused' || data?.finalStatus?.toLowerCase() === 'paused';
  const isBlockBusy = blockStatus === 'pending' || blockStatus === 'running';
  const showTaskControls = Boolean(documentId) && (isBlockBusy || isPaused);

  const handleTaskControl = useCallback(
    async (action: 'pause' | 'resume' | 'cancel') => {
      if (!documentId || taskControlStatus === 'loading' || actionLockRef.current.has('taskControl')) {
        return;
      }
      actionLockRef.current.add('taskControl');
      setPendingTaskAction(action);
      setTaskControlStatus('loading');
      try {
        await controlDocumentTask({ documentId, action });
        setTaskControlStatus('success');
        const successKey =
          action === 'pause'
            ? 'blocks.ankiCards.action.paused'
            : action === 'resume'
              ? 'blocks.ankiCards.action.resumed'
              : 'blocks.ankiCards.action.cancelled';
        showGlobalNotification('success', t(successKey));
      } catch (error: unknown) {
        const msg = getErrorMessage(error);
        console.error(`[AnkiCardsBlock] Task ${action} failed:`, msg);
        setTaskControlStatus('error');
        const failKey =
          action === 'pause'
            ? 'blocks.ankiCards.action.pauseFailed'
            : action === 'resume'
              ? 'blocks.ankiCards.action.resumeFailed'
              : 'blocks.ankiCards.action.cancelFailed';
        showGlobalNotification('error', t(failKey), msg);
      }
      actionLockRef.current.delete('taskControl');
      resetStatusAfterDelay(setTaskControlStatus);
    },
    [documentId, taskControlStatus, resetStatusAfterDelay, t]
  );

  const handleSave = useCallback(async () => {
    if (cards.length === 0 || saveStatus === 'loading' || actionLockRef.current.has('save')) return;
    actionLockRef.current.add('save');
    setSaveStatus('loading');
    try {
      const result = await saveCardsToLibrary({ cards, context });
      if (!result.success) {
        const failDetail =
          result.error ||
          result.failed?.map((f) => `${f.id}: ${f.error}`).join('; ') ||
          t('blocks.ankiCards.action.saveFailed');
        throw new Error(failDetail);
      }
      await onCardsPersisted?.(result.cardIdMappings ?? []);
      const reviewableSavedCount = result.savedCount;
      logChatAnkiEvent(
        'chat_anki_action_performed',
        {
          action: 'save',
          cardCount: reviewableSavedCount,
          skippedErrorCards: result.skippedErrorCards ?? 0,
        },
        context,
      );
      setSaveStatus('success');
      if (result.warning?.code === 'anki_save_partial') {
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.savePartialTitle'),
          t('blocks.ankiCards.action.savePartialDetail', {
            saved: result.warning.details.saved,
            duplicated: result.warning.details.duplicated,
            skipped: result.warning.details.skipped,
            failed: result.warning.details.failed,
          })
        );
      } else if (result.warning?.code === 'anki_save_all_skipped') {
        showGlobalNotification(
          'info',
          t('blocks.ankiCards.action.saveAllSkippedTitle'),
          t('blocks.ankiCards.action.saveAllSkippedDetail', {
            skipped: result.warning.details.skipped,
            duplicated: result.warning.details.duplicated,
          })
        );
      } else if ((result.skippedErrorCards ?? 0) > 0) {
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.savedCountWithHint', { count: result.savedCount }),
          t('blocks.ankiCards.action.skippedDiagnosticDetail', {
            count: result.skippedErrorCards,
          }),
        );
      } else {
        showGlobalNotification(
          'success',
          t('blocks.ankiCards.action.savedCountWithHint', { count: result.savedCount })
        );
      }
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Save failed:', msg);
      setSaveStatus('error');
      showGlobalNotification(
        'error',
        t('blocks.ankiCards.action.saveFailedWithHint'),
        t('blocks.ankiCards.action.saveFailedDetail', { detail: msg })
      );
    }
    actionLockRef.current.delete('save');
    resetStatusAfterDelay(setSaveStatus);
  }, [cards, context, saveStatus, resetStatusAfterDelay, t, onCardsPersisted]);

  const handleExport = useCallback(async () => {
    if (cards.length === 0 || exportStatus === 'loading' || actionLockRef.current.has('export')) return;
    actionLockRef.current.add('export');
    setExportStatus('loading');
    // 统计多模板信息
    const templateIds = [...new Set(cards.map(c => c.template_id).filter(Boolean))];
    try {
      window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
        level: 'info', phase: 'export:apkg',
        summary: `Export started | ${cards.length} cards | ${templateIds.length} templates: ${templateIds.join(', ') || 'null'}`,
        detail: { cardsCount: cards.length, templateIds },
      }}));
    } catch { /* */ }
    try {
      const result = await exportCardsAsApkg({ cards, context, deckName });
      if (result.cancelled) {
        // 用户取消了文件保存对话框，静默恢复，不显示错误
        setExportStatus('idle');
        actionLockRef.current.delete('export');
        return;
      }
      if (!result.success || !result.filePath) throw new Error(t('blocks.ankiCards.action.exportFailedNoPath'));
      logChatAnkiEvent('chat_anki_action_performed', { action: 'export', cardCount: cards.length }, context);
      setExportStatus('success');
      const exportNote = t('blocks.ankiCards.action.exportNewCardsNote');
      const missingMedia = result.missingMedia ?? [];
      if (missingMedia.length > 0) {
        // F16：导出成功 ≠ 媒体完整。缺失媒体必须在按钮反馈里可见，而不是只留日志。
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.exportMissingMediaTitle', { count: missingMedia.length }),
          t('blocks.ankiCards.action.exportMissingMediaDetail', { count: missingMedia.length }),
        );
      } else if (result.skippedErrorCards && result.skippedErrorCards > 0) {
        showGlobalNotification('warning', t('blocks.ankiCards.action.exportSkippedErrorsWithNote', {
          exported: cards.length - result.skippedErrorCards,
          skipped: result.skippedErrorCards,
          note: exportNote,
        }), result.filePath);
      } else {
        showGlobalNotification('success', t('blocks.ankiCards.action.apkgExportedWithNote', {
          note: exportNote,
        }), result.filePath);
      }
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'info', phase: 'export:apkg',
          summary: `Export success → ${result.filePath}`,
          detail: { filePath: result.filePath },
        }}));
      } catch { /* */ }
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Export failed:', msg);
      setExportStatus('error');
      showGlobalNotification('error', t('blocks.ankiCards.action.exportFailedWithHint'), msg);
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', { detail: {
          level: 'error', phase: 'export:apkg',
          summary: `Export FAILED: ${msg}`,
          detail: { error: msg },
        }}));
      } catch { /* */ }
    }
    actionLockRef.current.delete('export');
    resetStatusAfterDelay(setExportStatus);
  }, [cards, context, deckName, exportStatus, resetStatusAfterDelay, t]);

  const reviewableCards = useMemo(
    () => cards.filter((card) => {
      const row = card as { is_error_card?: unknown; isErrorCard?: unknown };
      return row.is_error_card !== true && row.isErrorCard !== true;
    }),
    [cards],
  );
  const reviewCardIds = useMemo(
    () => reviewableCards.map((card) => (typeof card.id === 'string' ? card.id.trim() : '')),
    [reviewableCards],
  );
  const reviewTemplateId = useCallback((card: AnkiCard): string | undefined => {
    if (typeof card.template_id === 'string') return card.template_id;
    const legacyTemplateId = Reflect.get(card, 'templateId');
    return typeof legacyTemplateId === 'string' ? legacyTemplateId : undefined;
  }, []);
  const reviewCards = useMemo(
    () =>
      reviewableCards.map((card, index) => {
        const templateId = reviewTemplateId(card);
        return {
          id: reviewCardIds[index],
          ankiCardId: reviewCardIds[index],
          front: card.front || '',
          back: card.back || '',
          ...(typeof card.text === 'string' && card.text.trim()
            ? { text: card.text }
            : {}),
          tags: card.tags,
          ...(Array.isArray(card.images) ? { images: card.images } : {}),
          ...(templateId ? { templateId } : {}),
          ...(card.fields && typeof card.fields === 'object'
            ? { extraFields: card.fields as Record<string, string> }
            : {}),
        };
      }),
    [reviewableCards, reviewCardIds, reviewTemplateId],
  );
  const canReviewBatch =
    reviewCards.length > 0 &&
    reviewCards.every((card) => {
      const id = card.ankiCardId;
      const hasFace =
        card.front.trim().length > 0
        || card.back.trim().length > 0
        || (typeof card.text === 'string' && card.text.trim().length > 0);
      return (
        hasFace &&
        id.length > 0 &&
        !id.startsWith('anki_synthetic_') &&
        !id.startsWith('chat-batch-')
      );
    });

  const handleReviewBatch = useCallback(() => {
    if (!canReviewBatch) return;
    const payload = {
      screen: 'session' as const,
      mode: 'batch' as const,
      cardIds: reviewCardIds,
      cards: reviewCards,
    };
    // R2-04：收编双路径——统一走 onActivation startReview（已开窗 activate；未开窗 fallbackLaunch）
    void workbenchBus.activate({
      typeId: 'flashcards',
      instanceKey: '',
      action: 'startReview',
      payload,
      fallbackLaunch: {
        typeId: 'flashcards',
        reason: 'api',
        payload,
      },
    });
    logChatAnkiEvent('chat_anki_action_performed', { action: 'review_batch', cardCount: cards.length }, context);
  }, [canReviewBatch, cards.length, context, reviewCardIds, reviewCards]);

  const handleSync = useCallback(async () => {
    if (cards.length === 0 || syncStatus === 'loading' || actionLockRef.current.has('sync')) return;
    actionLockRef.current.add('sync');
    setSyncStatus('loading');
    onSyncStatusChange?.('syncing');
    try {
      const result = await importCardsViaAnkiConnect({ cards, context, deckName });
      if (!result.success) throw new Error(t('blocks.ankiCards.action.syncFailedDetail'));
      logChatAnkiEvent('chat_anki_action_performed', { action: 'import', cardCount: cards.length }, context);
      setSyncStatus('success');
      // M4：写块 syncStatus，避免预览态长期停在 pending
      onSyncStatusChange?.('synced');
      if (result.warning?.code === 'anki_sync_partial') {
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.syncPartialTitle'),
          t('blocks.ankiCards.action.syncPartialDetail', {
            added: result.warning.details.added,
            failed: result.warning.details.failed,
          })
        );
      } else if (result.warning?.code === 'anki_sync_all_duplicates') {
        // 全部已存在：幂等成功，提示而非报错
        showGlobalNotification(
          'info',
          t('blocks.ankiCards.action.syncAllDuplicatesTitle'),
          t('blocks.ankiCards.action.syncAllDuplicatesDetail', {
            count: result.warning.details.duplicates,
          })
        );
      } else {
        showGlobalNotification('success', t('blocks.ankiCards.action.syncedCountWithHint', { count: result.importedCount }));
      }
      if (result.warnings && result.warnings.length > 0) {
        // F18：同名 note_type 冲突等后端告警必须可见，不能只留在日志
        showGlobalNotification(
          'warning',
          t('blocks.ankiCards.action.syncWarningsTitle'),
          result.warnings.join(' '),
        );
      }
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      console.error('[AnkiCardsBlock] Sync failed:', msg);
      setSyncStatus('error');
      onSyncStatusChange?.('error', msg);
      showGlobalNotification('error', t('blocks.ankiCards.action.syncFailedWithHint'), msg);
    }
    actionLockRef.current.delete('sync');
    resetStatusAfterDelay(setSyncStatus);
  }, [cards, context, deckName, syncStatus, resetStatusAfterDelay, onSyncStatusChange, t]);

  // 整批交付动作（加入卡片库/导出/同步/复习这批）仍等终态；
  // 展开浏览按动作粒度解锁，生成中即可用（见下方 expand 按钮）。
  const isDisabled = cards.length === 0 || isStreaming || (isBlockBusy && !isPaused);
  const showRetryFailedSegments = retryableTaskCount > 0;
  const isAnkiConnectAvailable = data?.ankiConnect?.available === true;
  const syncDisabledReason = !isAnkiConnectAvailable
    ? t(
        `blocks.ankiCards.progress.ankiConnect.${
          data?.ankiConnect?.available === false ? 'notConnected' : 'checking'
        }` as const
      )
    : undefined;

  const renderIcon = (status: ActionStatus, DefaultIcon: React.ComponentType<{ className?: string; size?: string | number }>) => {
    switch (status) {
      case 'loading':
        return <PulseDot className="h-1.5 w-1.5 text-current" />;
      case 'success':
        return <Check size={16} className="text-success" />;
      case 'error':
        return <X size={16} className="text-destructive" />;
      default:
        return <DefaultIcon size={16} />;
    }
  };

  const retryAction = showRetryFailedSegments ? (
    <div className="col-span-2 flex min-w-0 flex-col items-start gap-1 sm:col-span-1">
      <DsButton
        type="button"
        onClick={() => void onRetryFailedSegments()}
        disabled={retryStatus === 'loading'}
        aria-busy={retryStatus === 'loading'}
        variant={retryStatus === 'error' ? 'danger' : 'default'}
        className="min-h-10 w-full text-xs sm:w-auto sm:text-sm"
      >
        {renderIcon(retryStatus, ArrowClockwise)}
        {t('blocks.ankiCards.retryFailedSegments')}
      </DsButton>
      {retryStatus === 'error' && retryError && (
        <span
          role="alert"
          className="max-w-full text-xs leading-snug text-destructive"
          data-testid="chatanki-retry-failed-segments-error"
        >
          {retryError}
        </span>
      )}
    </div>
  ) : null;

  if (!showTaskControls && cards.length === 0) {
    return retryAction ? (
      <div className="grid grid-cols-2 gap-2 mt-3 pt-3 border-t border-border/50">
        {retryAction}
      </div>
    ) : null;
  }

  return (
    <div className="mt-3 grid grid-cols-2 gap-2 border-t border-border/50 pt-3 sm:flex sm:flex-wrap">
      {retryAction}

      {/* 运行中：暂停 / 继续 / 取消（有 documentId 时）。
          pending/成功/失败反馈只落在被点击的按钮上，其余按钮仅禁用。 */}
      {showTaskControls && (
        <>
          {isPaused ? (
            <DsButton
              type="button"
              onClick={() => void handleTaskControl('resume')}
              disabled={taskControlStatus === 'loading'}
              aria-busy={taskControlStatus === 'loading' && pendingTaskAction === 'resume'}
              variant="primary"
              className="min-h-10 text-xs sm:text-sm"
            >
              {taskControlStatus !== 'idle' && pendingTaskAction === 'resume'
                ? renderIcon(taskControlStatus, Play)
                : <Play size={14} />}
              {t('blocks.ankiCards.resume')}
            </DsButton>
          ) : (
            <DsButton
              type="button"
              onClick={() => void handleTaskControl('pause')}
              disabled={taskControlStatus === 'loading'}
              aria-busy={taskControlStatus === 'loading' && pendingTaskAction === 'pause'}
              variant="default"
              className="min-h-10 text-xs sm:text-sm"
            >
              {taskControlStatus !== 'idle' && pendingTaskAction === 'pause'
                ? renderIcon(taskControlStatus, Pause)
                : <Pause size={14} />}
              {t('blocks.ankiCards.pause')}
            </DsButton>
          )}
          <DsButton
            type="button"
            onClick={() => void handleTaskControl('cancel')}
            disabled={taskControlStatus === 'loading'}
            aria-busy={taskControlStatus === 'loading' && pendingTaskAction === 'cancel'}
            variant="danger"
            className="min-h-10 text-xs sm:text-sm"
          >
            {taskControlStatus !== 'idle' && pendingTaskAction === 'cancel'
              ? renderIcon(taskControlStatus, Stop)
              : <Stop size={14} />}
            {t('blocks.ankiCards.cancel')}
          </DsButton>
        </>
      )}

      {cards.length > 0 && (
        <>
          {/* 内联展开/折叠编辑：生成中也允许展开浏览 */}
          <DsButton
            type="button"
            onClick={onToggleExpand}
            variant={isExpanded ? 'default' : 'primary'}
            className="min-h-10 text-xs sm:text-sm"
          >
            {isExpanded ? <CaretUp size={14} /> : <Pencil size={14} />}
            {isExpanded ? t('blocks.ankiCards.collapse') : t('blocks.ankiCards.edit')}
          </DsButton>

          {/* 加入本地卡片库 */}
          <DsButton
            type="button"
            onClick={handleSave}
            disabled={isDisabled || saveStatus === 'loading'}
            variant={saveStatus === 'success' ? 'success' : saveStatus === 'error' ? 'danger' : canReviewBatch ? 'default' : 'primary'}
            className="min-h-10 text-xs sm:text-sm"
          >
            {renderIcon(saveStatus, FloppyDisk)}
            {t(
              saveStatus === 'success'
                ? 'blocks.ankiCards.addedToLibrary'
                : 'blocks.ankiCards.addToLibrary'
            )}
          </DsButton>

          {/* 复习这批 → workbench 闪卡会话（OS 模式专属；移动端隐藏避免死路动作） */}
          {!isMobilePlatform() && (
            <DsButton
              type="button"
              onClick={handleReviewBatch}
              disabled={isDisabled || !canReviewBatch}
              title={!canReviewBatch ? t('blocks.ankiCards.reviewBatchNeedsRealIds') : undefined}
              variant="primary"
              className="min-h-10 text-xs sm:text-sm"
            >
              <Stack size={16} />
              {t('blocks.ankiCards.reviewBatch')}
            </DsButton>
          )}

          {/* 牌组名选择：保存/导出/同步共用（默认取生成 options，会话内记住上次输入） */}
          <Popover>
            <PopoverTrigger asChild>
              <DsButton
                type="button"
                variant="ghost"
                className="min-h-10 max-w-[180px] text-xs text-muted-foreground sm:text-sm"
                title={t('blocks.ankiCards.deckName')}
                aria-label={t('blocks.ankiCards.deckName')}
              >
                <Cards size={14} />
                <span className="truncate">{deckName}</span>
              </DsButton>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-60 rounded-lg border bg-popover p-3 shadow-md">
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('blocks.ankiCards.deckName')}
              </label>
              <Input
                type="text"
                value={deckName}
                onChange={(e) => onDeckNameChange(e.target.value)}
                placeholder={t('blocks.ankiCards.deckNamePlaceholder')}
                className="w-full"
              />
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t('blocks.ankiCards.deckNameHint')}
              </p>
            </PopoverContent>
          </Popover>

          {/* 低频交付动作收进菜单，避免与编辑/复习争夺主层级。 */}
          <AppMenu>
            <AppMenuTrigger asChild>
              <DsButton
                type="button"
                variant="ghost"
                size="icon"
                iconOnly
                className="lg:h-10 lg:w-10 justify-self-end"
                aria-label={t('blocks.ankiCards.moreActions')}
                title={t('blocks.ankiCards.moreActions')}
              >
                <DotsThree size={20} />
              </DsButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" width={240}>
              <AppMenuGroup>
                <AppMenuItem
                  icon={renderIcon(exportStatus, DownloadSimple)}
                  onClick={() => void handleExport()}
                  disabled={isDisabled || exportStatus === 'loading'}
                >
                  {t('blocks.ankiCards.export')}
                </AppMenuItem>
                <AppMenuItem
                  icon={renderIcon(syncStatus, PaperPlaneRight)}
                  onClick={() => void handleSync()}
                  disabled={isDisabled || syncStatus === 'loading' || !isAnkiConnectAvailable}
                >
                  {t('blocks.ankiCards.sync')}
                  {syncDisabledReason ? ` · ${syncDisabledReason}` : ''}
                </AppMenuItem>
              </AppMenuGroup>
            </AppMenuContent>
          </AppMenu>
        </>
      )}
    </div>
  );
};
