/**
 * 聚焦模式（zoom in）面包屑导航 - Notion Style。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { House } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import type { MindMapNode } from '../../types';

export const OutlineBreadcrumb: React.FC<{
  path: MindMapNode[];
  onNavigate: (nodeId: string | null) => void;
}> = ({ path, onNavigate }) => {
  const { t } = useTranslation('mindmap');
  if (path.length <= 1) return null;

  return (
    <div
      className="outline-breadcrumb flex items-center gap-1 px-4 py-2 text-sm text-[var(--mm-text-secondary)] select-none sticky top-0 bg-[var(--mm-bg)] z-10"
    >
      <NotionButton variant="ghost"
        onClick={() => onNavigate(null)}
        className="flex items-center gap-1 px-1 py-0.5 rounded hover:bg-[var(--mm-bg-hover)] transition-colors"
        title={t('outline.exitFocusMode')}
      >
        <House size={14} />
      </NotionButton>
      {path.map((node, index) => (
        <React.Fragment key={node.id}>
          <span className="text-[var(--mm-text-muted)]">/</span>
          <NotionButton variant="ghost"
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
          </NotionButton>
        </React.Fragment>
      ))}
    </div>
  );
};
