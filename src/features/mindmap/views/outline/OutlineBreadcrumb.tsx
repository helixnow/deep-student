/**
 * 聚焦模式（zoom in）面包屑导航 - Clean Style。
 * 路径变化时逐段淡入/滑动过渡（reduced-motion 退化为瞬时）。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { House, CaretRight } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { cn } from '@/lib/utils';
import { tweenFast, transitionInstant } from '@/styles/motion-springs';
import type { MindMapNode } from '../../types';

export const OutlineBreadcrumb: React.FC<{
  path: MindMapNode[];
  onNavigate: (nodeId: string | null) => void;
}> = ({ path, onNavigate }) => {
  const { t } = useTranslation('mindmap');
  const prefersReducedMotion = useReducedMotion();
  if (path.length <= 1) return null;

  const transition = prefersReducedMotion ? transitionInstant : tweenFast;

  return (
    <div
      className="outline-breadcrumb scrollbar-none flex items-center gap-0.5 px-4 py-2 text-sm text-[var(--mm-text-secondary)] select-none sticky top-0 bg-[var(--mm-bg)] z-10 overflow-x-auto overscroll-x-contain"
    >
      <CommonTooltip
        content={t('outlineV2.breadcrumbHome', { defaultValue: '返回完整大纲' })}
        shortcut="Esc"
        position="bottom"
      >
        <DsButton variant="ghost"
          onClick={() => onNavigate(null)}
          className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-[var(--mm-bg-hover)] transition-colors"
          aria-label={t('outline.exitFocusMode')}
        >
          <House size={14} />
        </DsButton>
      </CommonTooltip>
      <AnimatePresence initial={false}>
        {path.map((node, index) => (
          <motion.span
            key={node.id}
            className="flex items-center gap-0.5 min-w-0"
            initial={prefersReducedMotion ? false : { opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, x: 6 }}
            transition={transition}
          >
            <CaretRight
              size={11}
              weight="bold"
              className="text-[var(--mm-text-muted)] flex-shrink-0 opacity-70"
              aria-hidden="true"
            />
            <DsButton variant="ghost"
              onClick={() => onNavigate(node.id)}
              className={cn(
                "px-1 py-0.5 rounded hover:bg-[var(--mm-bg-hover)] transition-colors truncate max-w-[120px]",
                index === path.length - 1
                  ? "text-[var(--mm-text)] font-medium"
                  : ""
              )}
              title={node.text || t('outline.untitled')}
            >
              {node.text || t('outline.untitled')}
            </DsButton>
          </motion.span>
        ))}
      </AnimatePresence>
    </div>
  );
};
