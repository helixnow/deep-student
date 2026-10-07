import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BookOpen, CaretLeft, CaretRight, Cards, Eye, EyeSlash, Fire, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { useMindMapStore, useMindMapStoreApi } from '../../store';
import { countBlankProgress } from '../../utils/node/blankRanges';
import { buildReciteMissCards } from '../../utils/reciteCards';

/**
 * 复习导航后把目标行/节点滚入视野（大纲行有 data-node-id；画布由 focus effect 居中）。
 * - 查询限域到本实例容器 scope：分屏/保活多实例下全局查询可能滚动另一棵树
 *   （与 useMindMapKeyboard 的 containerRef 限域同一原则）；
 * - nodeId 经 CSS.escape：导入 id 含引号/反斜杠时不再拼出非法 selector。
 */
function scrollNodeRowIntoView(nodeId: string, scope: HTMLElement | null) {
  requestAnimationFrame(() => {
    const queryRoot: ParentNode = scope ?? globalThis.document;
    const escaped =
      typeof CSS?.escape === 'function'
        ? CSS.escape(nodeId)
        : nodeId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const row = queryRoot.querySelector<HTMLElement>(`[data-node-id="${escaped}"]`);
    if (!row) return;
    const prefersReduced =
      !!globalThis.window?.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    row.scrollIntoView({ block: 'center', behavior: prefersReduced ? 'auto' : 'smooth' });
  });
}

export const ReciteStatusBar: React.FC = () => {
  const { t } = useTranslation('mindmap');
  const storeApi = useMindMapStoreApi();
  /** 状态条自身渲染在 .mindmap-container 内，经 closest 反查即为本实例容器 */
  const barRef = useRef<HTMLDivElement>(null);
  const reciteMode = useMindMapStore(s => s.reciteMode);
  const document = useMindMapStore(s => s.document);
  const revealedBlanks = useMindMapStore(s => s.revealedBlanks);
  const revealAllBlanks = useMindMapStore(s => s.revealAllBlanks);
  const resetAllBlanks = useMindMapStore(s => s.resetAllBlanks);
  const setReciteMode = useMindMapStore(s => s.setReciteMode);
  const blankOutlineForRecite = useMindMapStore(s => s.blankOutlineForRecite);
  const reviewQueue = useMindMapStore(s => s.reciteReviewQueue);
  const reviewIndex = useMindMapStore(s => s.reciteReviewIndex);
  const startReciteReview = useMindMapStore(s => s.startReciteReview);
  const stepReciteReview = useMindMapStore(s => s.stepReciteReview);
  const stopReciteReview = useMindMapStore(s => s.stopReciteReview);
  const reciteSessionLog = useMindMapStore(s => s.reciteSessionLog);
  const mindmapId = useMindMapStore(s => s.mindmapId);

  const progress = useMemo(() => {
    if (!reciteMode) return { total: 0, revealed: 0 };
    return countBlankProgress(document.root, revealedBlanks);
  }, [reciteMode, document.root, revealedBlanks]);

  // 本次背诵里翻开过的空 → 卡片；已存过的节点不重复存（同一会话连点两次）
  const [savedNodeIds, setSavedNodeIds] = useState<ReadonlySet<string>>(() => new Set());
  const [savingCards, setSavingCards] = useState(false);
  const missCards = useMemo(
    () => (reciteMode ? buildReciteMissCards(document.root, reciteSessionLog).filter((card) => !savedNodeIds.has(card.nodeId)) : []),
    [reciteMode, document.root, reciteSessionLog, savedNodeIds],
  );
  const saveMissCards = useCallback(async () => {
    if (savingCards || missCards.length === 0) return;
    setSavingCards(true);
    try {
      const { saveReciteMissCards } = await import('../../utils/saveReciteMissCards');
      const count = await saveReciteMissCards({
        cards: missCards,
        mindmapId,
        title: document.root.text ?? '',
        deckPrefix: t('recite.missCardsDeck'),
        tag: t('recite.missCardsTag'),
      });
      setSavedNodeIds((prev) => new Set([...prev, ...missCards.map((card) => card.nodeId)]));
      showGlobalNotification('success', t('recite.missCardsDone', { count }));
    } catch (error: unknown) {
      showGlobalNotification('error', t('recite.missCardsFailed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setSavingCards(false);
    }
  }, [document.root.text, mindmapId, missCards, savingCards, t]);

  const scrollToCurrentReviewNode = useCallback(() => {
    const { reciteReviewQueue, reciteReviewIndex } = storeApi.getState();
    const item = reciteReviewQueue?.[reciteReviewIndex];
    if (!item) return;
    const scope = barRef.current?.closest<HTMLElement>('.mindmap-container') ?? null;
    scrollNodeRowIntoView(item.nodeId, scope);
  }, [storeApi]);

  const handleStartReview = useCallback(() => {
    if (startReciteReview() > 0) scrollToCurrentReviewNode();
  }, [startReciteReview, scrollToCurrentReviewNode]);

  const handleStep = useCallback((delta: number) => {
    stepReciteReview(delta);
    scrollToCurrentReviewNode();
  }, [stepReciteReview, scrollToCurrentReviewNode]);

  if (!reciteMode) return null;

  const inReview = !!reviewQueue && reviewQueue.length > 0;

  // 顶部内联占位条：占用文档流（父容器 flex-col），不再作为悬浮层遮挡画布顶部节点
  return (
    <div ref={barRef} className="mm-recite-status-bar shrink-0 z-30 flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1.5 border-b border-[var(--mm-border)] bg-[var(--mm-bg-elevated)] ui-drop-in">
      <BookOpen className="w-4 h-4 text-[var(--mm-warning)] shrink-0" />
      <span className="text-sm font-medium whitespace-nowrap">{t('recite.title')}</span>

      {progress.total > 0 ? (
        <div
          className="flex items-center gap-2"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-valuenow={progress.revealed}
          aria-label={t('recite.progress', {
            revealed: progress.revealed,
            total: progress.total,
          })}
        >
          <div className="w-24 h-1.5 rounded-full bg-[var(--mm-border)] overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--mm-warning)] transition-all duration-300 motion-reduce:transition-none"
              style={{ width: `${(progress.revealed / progress.total) * 100}%` }}
            />
          </div>
          {/* 进度只说一次：进度条 + 已揭示/总数（百分比、剩余数与之同义，已去掉） */}
          <span className="text-xs text-[var(--mm-text-muted)] whitespace-nowrap tabular-nums">
            {progress.revealed}/{progress.total}
          </span>
        </div>
      ) : (
        // 还没有挖空：一键遮住要点（刚由笔记 / 大纲生成的导图直接能背），或退出手动挖空
        <>
          <DsButton
            variant="ghost"
            className="mm-recite-status-action h-7 px-2 text-xs gap-1"
            onClick={blankOutlineForRecite}
            title={t('recite.blankOutlineHint', {
              defaultValue: '保留中心主题和一级分支作提示，下面各层整段遮住；点一下揭示，可撤销',
            })}
          >
            <EyeSlash size={14} />
            {t('recite.blankOutline', { defaultValue: '一键遮住要点' })}
          </DsButton>
          <DsButton
            variant="ghost"
            className="mm-recite-status-action h-7 px-2 text-xs"
            onClick={() => setReciteMode(false)}
          >
            {t('recite.manualBlank', { defaultValue: '手动挖空' })}
          </DsButton>
        </>
      )}

      <div className="w-px h-4 bg-[var(--mm-border)]" />

      {/* 难点优先复习：按历史错误率排序逐节点走查（会话统计在退出背诵时持久化） */}
      {inReview ? (
        <div
          className="flex items-center gap-1"
          role="group"
          aria-label={t('recite.reviewNavLabel', { defaultValue: '难点优先复习导航' })}
        >
          <Fire size={14} className="text-[var(--mm-warning)] shrink-0" />
          <DsButton
            variant="ghost"
            className="mm-recite-status-action h-7 w-7 p-0"
            onClick={() => handleStep(-1)}
            disabled={reviewIndex <= 0}
            aria-label={t('recite.reviewPrev', { defaultValue: '上一个难点' })}
          >
            <CaretLeft size={14} />
          </DsButton>
          <span className="text-xs text-[var(--mm-text-muted)] whitespace-nowrap tabular-nums">
            {reviewIndex + 1}/{reviewQueue.length}
          </span>
          <DsButton
            variant="ghost"
            className="mm-recite-status-action h-7 w-7 p-0"
            onClick={() => handleStep(1)}
            disabled={reviewIndex >= reviewQueue.length - 1}
            aria-label={t('recite.reviewNext', { defaultValue: '下一个难点' })}
          >
            <CaretRight size={14} />
          </DsButton>
          <DsButton
            variant="ghost"
            className="mm-recite-status-action h-7 px-2 text-xs"
            onClick={stopReciteReview}
          >
            {t('recite.reviewStop', { defaultValue: '结束复习' })}
          </DsButton>
        </div>
      ) : (
        <DsButton
          variant="ghost"
          onClick={handleStartReview}
          className="mm-recite-status-action h-7 px-2 text-xs gap-1"
          disabled={progress.total === 0}
          title={t('recite.reviewStartHint', {
            defaultValue: '按历史错误率从难到易逐节点复习（翻开=没背出来）',
          })}
        >
          <Fire size={14} />
          {t('recite.reviewStart', { defaultValue: '难点优先' })}
        </DsButton>
      )}

      {missCards.length > 0 && (
        <DsButton
          variant="ghost"
          onClick={() => void saveMissCards()}
          disabled={savingCards}
          className="mm-recite-status-action h-7 px-2 text-xs gap-1"
          title={t('recite.missCardsHint')}
          data-testid="mm-recite-miss-cards"
        >
          <Cards size={14} />
          {t('recite.missCards', { count: missCards.length })}
        </DsButton>
      )}

      <div className="w-px h-4 bg-[var(--mm-border)]" />
      <DsButton variant="ghost" onClick={revealAllBlanks} className="mm-recite-status-action h-7 px-2 text-xs gap-1" disabled={progress.total === 0}>
        <Eye size={14} />
        {t('recite.revealAll')}
      </DsButton>
      <DsButton variant="ghost" onClick={resetAllBlanks} className="mm-recite-status-action h-7 px-2 text-xs gap-1" disabled={progress.total === 0}>
        <EyeSlash size={14} />
        {t('recite.resetAll')}
      </DsButton>
      <DsButton variant="ghost" onClick={() => setReciteMode(false)} className="mm-recite-status-action h-7 px-2 text-xs gap-1">
        <X size={14} />
        {t('recite.exit')}
      </DsButton>
    </div>
  );
};
