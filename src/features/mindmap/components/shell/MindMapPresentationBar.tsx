import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useShallow } from 'zustand/react/shallow';
import {
  CaretLeft,
  CaretRight,
  House,
  X,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/shad/Tooltip';
import { cn } from '@/utils/cn';
import { useMindMapStore } from '../../store';

export interface PresentationBranchItem {
  id: string;
  text: string;
}

export interface MindMapPresentationBarProps {
  rootTitle: string;
  branches: readonly PresentationBranchItem[];
  /** -1 表示全图总览；0..branches.length-1 表示当前聚焦的一级分支索引 */
  stepIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onOverview: () => void;
  onExit: () => void;
}

/**
 * Spotlight 分支演示控制 HUD：
 * - 悬浮于画布底部居中，支持按一级分支步进演示（总览 ↔ 各一级分支）；
 * - 全部使用语义令牌 + `--shadow-base` 阴影 + `var(--wb-glass-blur, none)` 毛玻璃；
 * - 所有按钮兼容 coarse 44px 触屏热区与 `prefers-reduced-motion`。
 */
export const MindMapPresentationBar: React.FC<MindMapPresentationBarProps> = React.memo(
  ({
    rootTitle,
    branches,
    stepIndex,
    onPrev,
    onNext,
    onOverview,
    onExit,
  }) => {
    const { t } = useTranslation(['mindmap']);
    const total = branches.length;
    const isOverview = stepIndex < 0 || stepIndex >= total;
    const currentBranch = isOverview ? null : branches[stepIndex] ?? null;
    const canPrev = stepIndex >= 0;
    const canNext = total > 0 && stepIndex < total - 1;

    const overviewLabel = t('mindmap:presentation.overview', {
      defaultValue: '总览',
    });
    const displayTitle = isOverview
      ? rootTitle.trim() || t('mindmap:outline.untitled', { defaultValue: '无标题' })
      : currentBranch?.text.trim() || t('mindmap:outline.unnamedNode', { defaultValue: '未命名节点' });
    const progressText = isOverview
      ? overviewLabel
      : `${stepIndex + 1} / ${total}`;

    return (
      <div
        role="region"
        aria-label={t('mindmap:presentation.hudLabel', {
          defaultValue: '分支演示控制栏',
        })}
        data-testid="mm-presentation-bar"
        data-wb-blur-surface
        className={cn(
          'absolute left-1/2 -translate-x-1/2 z-30',
          'bottom-[calc(16px+max(env(safe-area-inset-bottom,0px),var(--mobile-safe-area-bottom,0px)))]',
          'flex items-center gap-1 max-w-[calc(100%-24px)] px-2 py-1.5',
          'rounded-xl border border-[var(--mm-border)]',
          'bg-[color-mix(in_srgb,var(--mm-bg-elevated)_90%,transparent)]',
          '[backdrop-filter:var(--wb-glass-blur,none)]',
          'text-[var(--mm-text)] shadow-[var(--mm-shadow-dock)]',
          'select-none transition-colors motion-reduce:transition-none',
        )}
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <DsButton
              variant="ghost"
              className={cn(
                'ds-btn h-8 px-2 text-xs transition-colors motion-reduce:transition-none',
                isOverview && 'bg-[var(--mm-primary-soft)] text-[var(--mm-primary)]',
              )}
              onClick={onOverview}
              aria-label={overviewLabel}
              aria-pressed={isOverview}
              data-testid="mm-presentation-overview"
            >
              <House size={15} />
              <span className="hidden sm:inline">{overviewLabel}</span>
            </DsButton>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t('mindmap:presentation.overviewHint', {
              defaultValue: '返回全图总览 (Home)',
            })}
          </TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <DsButton
                variant="ghost"
                size="icon"
                className="ds-btn h-8 w-8 px-0 justify-center transition-colors motion-reduce:transition-none"
                onClick={onPrev}
                disabled={!canPrev}
                aria-label={t('mindmap:presentation.prevBranch', {
                  defaultValue: '上一分支 (←)',
                })}
                data-testid="mm-presentation-prev"
              >
                <CaretLeft size={16} />
              </DsButton>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t('mindmap:presentation.prevBranch', {
              defaultValue: '上一分支 (←)',
            })}
          </TooltipContent>
        </Tooltip>

        <div
          className="flex items-center gap-1.5 px-2 min-w-0 max-w-[260px] sm:max-w-[360px]"
          aria-live="polite"
          data-testid="mm-presentation-status"
        >
          <span className="shrink-0 font-mono tabular-nums text-xs font-medium text-[var(--mm-primary)]">
            {progressText}
          </span>
          <span aria-hidden="true" className="text-xs text-[var(--mm-text-muted)]">
            ·
          </span>
          <span className="truncate text-xs font-medium text-[var(--mm-text)]">
            {displayTitle}
          </span>
        </div>

        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex">
              <DsButton
                variant="ghost"
                size="icon"
                className="ds-btn h-8 w-8 px-0 justify-center transition-colors motion-reduce:transition-none"
                onClick={onNext}
                disabled={!canNext}
                aria-label={t('mindmap:presentation.nextBranch', {
                  defaultValue: '下一分支 (→ / Space)',
                })}
                data-testid="mm-presentation-next"
              >
                <CaretRight size={16} />
              </DsButton>
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t('mindmap:presentation.nextBranch', {
              defaultValue: '下一分支 (→ / Space)',
            })}
          </TooltipContent>
        </Tooltip>

        <div className="w-px h-4 bg-[var(--mm-border)] mx-0.5 shrink-0" />

        <Tooltip>
          <TooltipTrigger asChild>
            <DsButton
              variant="ghost"
              className="ds-btn h-8 px-2 text-xs text-[var(--mm-text-secondary)] hover:text-[var(--mm-text)] transition-colors motion-reduce:transition-none"
              onClick={onExit}
              aria-label={t('mindmap:presentation.exit')}
              data-testid="mm-presentation-exit"
            >
              <X size={15} />
              <span className="hidden sm:inline">
                {t('mindmap:presentation.exitShort', { defaultValue: '退出' })}
              </span>
            </DsButton>
          </TooltipTrigger>
          <TooltipContent side="top">
            {t('mindmap:presentation.exitHint')}
          </TooltipContent>
        </Tooltip>
      </div>
    );
  },
);

MindMapPresentationBar.displayName = 'MindMapPresentationBar';

export interface MindMapPresentationHudProps {
  stepIndex: number;
  onPrev: () => void;
  onNext: () => void;
  onOverview: () => void;
  onExit: () => void;
}

/**
 * 仅在演示模式开启时挂载的 Store 连接层，避免常态编辑时主壳层订阅一级分支文本变更。
 */
export const MindMapPresentationHud: React.FC<MindMapPresentationHudProps> = ({
  stepIndex,
  onPrev,
  onNext,
  onOverview,
  onExit,
}) => {
  const rootTitle = useMindMapStore((state) => state.document.root.text);
  const serializedBranches = useMindMapStore(
    useShallow((state) =>
      state.document.root.children.map((child) => `${child.id}\u0000${child.text}`),
    ),
  );

  const branches = useMemo<PresentationBranchItem[]>(
    () =>
      serializedBranches.map((entry) => {
        const sepIdx = entry.indexOf('\u0000');
        return {
          id: sepIdx >= 0 ? entry.slice(0, sepIdx) : entry,
          text: sepIdx >= 0 ? entry.slice(sepIdx + 1) : '',
        };
      }),
    [serializedBranches],
  );

  return (
    <MindMapPresentationBar
      rootTitle={rootTitle}
      branches={branches}
      stepIndex={stepIndex}
      onPrev={onPrev}
      onNext={onNext}
      onOverview={onOverview}
      onExit={onExit}
    />
  );
};
