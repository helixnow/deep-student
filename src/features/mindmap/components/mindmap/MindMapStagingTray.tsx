/**
 * 待整理摘录池（MindMapStagingTray，C7 §3.1）
 *
 * 视觉与工程约束：
 * - 零 Emoji；分隔线统一 `1px border-border/35`；状态点 `6px`；计数统一 `font-mono tabular-nums`；
 * - 支持切换入图策略：`直挂节点` | `先入待整理池`；
 * - 支持从池中直接拖拽卡片上树（`DS_EXCERPT_MIME` + 原子撤销关联）、点击「归入选中节点」、
 *   「合并入节点」或移除——每次操作均为单步 `Cmd+Z` 原子历史。
 */

import React, { useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { addTypedEventListener } from '@/events';
import {
  ArrowBendDownRight,
  FilePdf,
  GitMerge,
  LinkSimple,
  Note,
  PlayCircle,
  Question,
  Tray,
  Trash,
  X,
} from '@phosphor-icons/react';
import {
  clearActiveExcerptDrag,
  startExcerptDrag,
} from '@/ui-kernel/services/excerpt-dnd';
import { useOptionalUiKernel } from '@/ui-kernel/react';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useMindMapStore } from '../../store';
import type { ExcerptIntakeMode, MindMapStagingExcerpt } from '../../types';
import { formatMindMapSourcePill } from '../../utils/nodeAnchors';
import {
  setActiveStagingExcerptDragId,
  stagingExcerptToDragPayload,
} from '../../utils/excerptIngest';
import { revealMindMapSourceAnchor } from '../shared/NodeSourcePills';
import '../../styles/mn5-excerpt.css';

export interface MindMapStagingTrayProps {
  className?: string;
}

function StagingSourceIcon({ kind }: { kind: MindMapStagingExcerpt['anchor']['kind'] }) {
  const cls = 'mm-mn5-source-pill-icon';
  switch (kind) {
    case 'pdf':
      return <FilePdf size={11} weight="bold" className={cls} aria-hidden />;
    case 'media':
      return <PlayCircle size={11} weight="bold" className={cls} aria-hidden />;
    case 'note':
      return <Note size={11} weight="bold" className={cls} aria-hidden />;
    case 'qbank':
      return <Question size={11} weight="bold" className={cls} aria-hidden />;
    default:
      return <LinkSimple size={11} weight="bold" className={cls} aria-hidden />;
  }
}

export const MindMapStagingTray: React.FC<MindMapStagingTrayProps> = ({ className }) => {
  const { t } = useTranslation('mindmap');
  const kernel = useOptionalUiKernel();
  const stagingTrayOpen = useMindMapStore((s) => s.stagingTrayOpen);
  const setStagingTrayOpen = useMindMapStore((s) => s.setStagingTrayOpen);
  const excerptIntakeMode = useMindMapStore((s) => s.excerptIntakeMode);
  const setExcerptIntakeMode = useMindMapStore((s) => s.setExcerptIntakeMode);
  const stagingExcerpts = useMindMapStore((s) => s.document.stagingExcerpts);
  const focusedNodeId = useMindMapStore((s) => s.focusedNodeId);
  const selection = useMindMapStore((s) => s.selection);
  const rootId = useMindMapStore((s) => s.document.root.id);
  const reciteMode = useMindMapStore((s) => s.reciteMode);
  const commitStagingExcerpt = useMindMapStore((s) => s.commitStagingExcerpt);
  const removeStagingExcerpt = useMindMapStore((s) => s.removeStagingExcerpt);
  const clearStagingExcerpts = useMindMapStore((s) => s.clearStagingExcerpts);
  const draggingRef = useRef(false);

  const items = stagingExcerpts ?? [];
  const activeTargetId = focusedNodeId ?? selection[0] ?? null;
  const canMergeIntoTarget = Boolean(activeTargetId && activeTargetId !== rootId);

  const handleModeSwitch = useCallback(
    (mode: ExcerptIntakeMode) => {
      setExcerptIntakeMode(mode);
    },
    [setExcerptIntakeMode],
  );

  const handleDragStart = useCallback(
    (e: React.DragEvent<HTMLDivElement>, item: MindMapStagingExcerpt) => {
      if (reciteMode) {
        e.preventDefault();
        return;
      }
      const payload = stagingExcerptToDragPayload(item);
      if (!payload) {
        e.preventDefault();
        return;
      }
      setActiveStagingExcerptDragId(item.id);
      draggingRef.current = true;
      startExcerptDrag(e.nativeEvent, payload);
    },
    [reciteMode],
  );

  const handleDragEnd = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    setActiveStagingExcerptDragId(null);
    clearActiveExcerptDrag();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handleDragEnd();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') handleDragEnd();
    };
    const cleanups = [
      addTypedEventListener('blur', () => handleDragEnd()),
      addTypedEventListener('dragend', () => handleDragEnd()),
      addTypedEventListener('drop', () => handleDragEnd()),
      addTypedEventListener('keydown', (_d, event) => onKeyDown(event as unknown as KeyboardEvent)),
      addTypedEventListener('visibilitychange', () => onVisibility(), undefined, 'document'),
    ];
    return () => {
      handleDragEnd();
      cleanups.forEach((dispose) => dispose());
    };
  }, [handleDragEnd]);

  if (!stagingTrayOpen || reciteMode) return null;

  return (
    <aside
      className={cn(
        'flex flex-col shrink-0 w-[272px] max-w-[min(360px,calc(100vw-24px))] h-full border-l border-border/35 bg-[var(--mm-bg-elevated)] z-20 select-none',
        className,
      )}
      aria-label={t('mn5.stagingTrayTitle')}
      data-testid="mm-staging-tray"
    >
      {/* 顶栏：标题 + 等宽数量胶囊 + 关闭 */}
      <div className="flex items-center justify-between gap-2 min-h-9 px-3 border-b border-border/35 shrink-0 [@media(pointer:coarse)]:min-h-12">
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="mm-mn5-status-dot" aria-hidden="true" />
          <Tray size={13} className="text-[var(--mm-text-muted)] shrink-0" aria-hidden />
          <span className="text-xs font-medium text-[var(--mm-text)] truncate">
            {t('mn5.stagingTrayTitle')}
          </span>
          <span
            className="inline-flex items-center justify-center min-w-[20px] h-[18px] px-1.5 rounded-full border border-border/35 bg-[var(--mm-bg)] text-2xs font-mono tabular-nums text-[var(--mm-text-muted)]"
            data-testid="mm-staging-count"
          >
            {items.length}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {items.length > 0 && (
            <Tooltip>
              <TooltipTrigger asChild>
                <DsButton
                  variant="ghost"
                  size="sm"
                  className="h-6 px-1.5 text-2xs text-[var(--mm-text-muted)] transition-colors motion-reduce:transition-none"
                  onClick={clearStagingExcerpts}
                  aria-label={t('mn5.stagingTrayClearAll')}
                  data-testid="mm-staging-clear-btn"
                >
                  <Trash size={12} />
                </DsButton>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('mn5.stagingTrayClearAll')}</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger asChild>
              <DsButton
                variant="ghost"
                size="icon"
                className="h-6 w-6 transition-colors motion-reduce:transition-none"
                onClick={() => setStagingTrayOpen(false)}
                aria-label={t('mn5.stagingTrayToggleHint')}
                data-testid="mm-staging-close-btn"
              >
                <X size={13} />
              </DsButton>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('mn5.stagingTrayToggleHint')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 入图方式切换：直挂节点 | 先入待整理池 */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border/35 shrink-0">
        <span className="text-2xs text-[var(--mm-text-muted)] shrink-0">
          {t('mn5.intakeModeLabel')}
        </span>
        <div
          className="inline-flex items-center rounded-md border border-border/35 p-0.5 bg-[var(--mm-bg)]"
          role="group"
          aria-label={t('mn5.intakeModeLabel')}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <DsButton
                variant="ghost"
                size="sm"
                className={cn(
                  'h-6 px-2 rounded text-2xs transition-colors motion-reduce:transition-none',
                  excerptIntakeMode === 'direct'
                    ? 'bg-[var(--mm-celadon-pill-bg)] text-[var(--mm-celadon-pill-fg)] font-medium'
                    : 'text-[var(--mm-text-muted)] hover:text-[var(--mm-text)]',
                )}
                aria-pressed={excerptIntakeMode === 'direct'}
                onClick={() => handleModeSwitch('direct')}
                data-testid="mm-intake-mode-direct"
              >
                {t('mn5.intakeModeDirect')}
              </DsButton>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('mn5.intakeModeDirectHint')}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <DsButton
                variant="ghost"
                size="sm"
                className={cn(
                  'h-6 px-2 rounded text-2xs transition-colors motion-reduce:transition-none',
                  excerptIntakeMode === 'staging'
                    ? 'bg-[var(--mm-celadon-pill-bg)] text-[var(--mm-celadon-pill-fg)] font-medium'
                    : 'text-[var(--mm-text-muted)] hover:text-[var(--mm-text)]',
                )}
                aria-pressed={excerptIntakeMode === 'staging'}
                onClick={() => handleModeSwitch('staging')}
                data-testid="mm-intake-mode-staging"
              >
                {t('mn5.intakeModeStaging')}
              </DsButton>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t('mn5.intakeModeStagingHint')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* 列表容器（固定弹性高度以驱动 CustomScrollArea） */}
      <div className="flex-1 min-h-0">
        {items.length === 0 ? (
          <div
            className="px-4 py-8 text-xs leading-relaxed text-[var(--mm-text-muted)]"
            data-testid="mm-staging-empty"
          >
            {t('mn5.stagingTrayEmpty')}
          </div>
        ) : (
          <CustomScrollArea
            className="h-full"
            viewportClassName="p-2.5 pb-[calc(10px+max(env(safe-area-inset-bottom,0px),var(--mobile-safe-area-bottom,0px)))] space-y-2"
          >
            {items.map((item) => {
              const locator = formatMindMapSourcePill(item.anchor);
              const showThumb =
                typeof item.imageDataUrl === 'string' &&
                item.imageDataUrl.startsWith('data:image/');
              return (
                <div
                  key={item.id}
                  draggable
                  onDragStart={(e) => handleDragStart(e, item)}
                  onDragEnd={handleDragEnd}
                  className="group flex flex-col gap-1.5 p-2.5 rounded-md border border-border/35 bg-[var(--mm-bg)] hover:border-[var(--mm-celadon-border)] cursor-grab active:cursor-grabbing transition-colors motion-reduce:transition-none"
                  data-testid="mm-staging-card"
                  data-staging-id={item.id}
                >
                  <div className="flex items-center justify-between gap-1.5">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DsButton
                          variant="ghost"
                          size="sm"
                          className="mm-mn5-source-pill h-auto py-0"
                          onClick={() =>
                            void revealMindMapSourceAnchor(item.anchor, kernel?.anchors ?? null)
                          }
                        >
                          <StagingSourceIcon kind={item.anchor.kind} />
                          <span className="mm-mn5-source-pill-label font-mono tabular-nums text-2xs font-medium">
                            {locator}
                          </span>
                        </DsButton>
                      </TooltipTrigger>
                      <TooltipContent side="top">
                        {t('mn5.revealSourceHint', { locator })}
                      </TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <DsButton
                          variant="ghost"
                          size="icon"
                          className="w-5 h-5 rounded text-[var(--mm-text-muted)] hover:text-[var(--mm-text)] hover:bg-[var(--mm-bg-hover)] transition-colors motion-reduce:transition-none relative"
                          onClick={() => removeStagingExcerpt(item.id)}
                          aria-label={t('mn5.removeStagingItem')}
                          data-testid="mm-staging-remove-btn"
                        >
                          <X size={11} />
                        </DsButton>
                      </TooltipTrigger>
                      <TooltipContent side="top">{t('mn5.removeStagingItem')}</TooltipContent>
                    </Tooltip>
                  </div>

                  {showThumb && (
                    <img
                      src={item.imageDataUrl}
                      alt={item.title}
                      draggable={false}
                      className="max-h-24 w-full rounded border border-border/35 object-contain bg-[var(--mm-bg-elevated)]"
                    />
                  )}

                  <div className="text-xs text-[var(--mm-text)] line-clamp-3 leading-relaxed break-words select-text">
                    {item.text || item.title}
                  </div>

                  <div className="flex flex-wrap items-center gap-1 pt-1 border-t border-border/35">
                    <DsButton
                      variant="ghost"
                      size="sm"
                      className="gap-1 h-6 px-2 rounded text-2xs font-medium bg-[var(--mm-celadon-pill-bg)] hover:bg-[var(--mm-celadon-pill-bg-hover)] text-[var(--mm-celadon-pill-fg)] transition-colors motion-reduce:transition-none"
                      onClick={() => commitStagingExcerpt(item.id)}
                      data-testid="mm-staging-commit-btn"
                    >
                      <ArrowBendDownRight size={11} aria-hidden />
                      <span>{t('mn5.commitToSelectedNode')}</span>
                    </DsButton>
                    {canMergeIntoTarget && activeTargetId && (
                      <DsButton
                        variant="ghost"
                        size="sm"
                        className="gap-1 h-6 px-2 rounded text-2xs border border-border/35 text-[var(--mm-text-muted)] hover:text-[var(--mm-text)] hover:bg-[var(--mm-bg-hover)] transition-colors motion-reduce:transition-none"
                        onClick={() =>
                          commitStagingExcerpt(item.id, {
                            mode: 'merge',
                            targetNodeId: activeTargetId,
                          })
                        }
                        data-testid="mm-staging-merge-btn"
                      >
                        <GitMerge size={11} aria-hidden />
                        <span>{t('mn5.mergeIntoSelectedNode')}</span>
                      </DsButton>
                    )}
                  </div>
                </div>
              );
            })}
          </CustomScrollArea>
        )}
      </div>
    </aside>
  );
};

export default MindMapStagingTray;
