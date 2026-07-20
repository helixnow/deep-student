/**
 * 拖拽预览：显示被拖节点及其子树缩略；多选时显示数量徽章。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import type { MindMapNode } from '../../types';
import { countDescendants } from '../../utils/outlineCaret';

const MAX_PREVIEW_DEPTH = 3;   // 最多展示 3 层
const MAX_CHILDREN_SHOW = 4;   // 每层最多展示 4 个子节点

export const OutlineDragOverlayContent: React.FC<{
  node: MindMapNode;
  dragCount?: number;
}> = ({ node, dragCount = 1 }) => {
  const { t } = useTranslation('mindmap');

  const renderNode = (n: MindMapNode, depth: number) => {
    const hasChildren = n.children && n.children.length > 0;
    const childrenToShow = hasChildren ? n.children!.slice(0, MAX_CHILDREN_SHOW) : [];
    const hiddenCount = hasChildren ? n.children!.length - childrenToShow.length : 0;

    return (
      <div key={n.id} style={{ paddingLeft: depth > 0 ? 16 : 0 }}>
        <div className="flex items-center gap-1.5 py-[2px]">
          <div className={cn(
            "w-[5px] h-[5px] rounded-full flex-shrink-0",
            depth === 0 ? "bg-foreground/70" : "bg-foreground/30"
          )} />
          <span className={cn(
            "truncate",
            depth === 0 ? "font-medium text-[13px] max-w-[240px]" : "text-[12px] text-muted-foreground max-w-[200px]"
          )}>
            {n.text || t('outline.unnamedNode')}
          </span>
        </div>
        {depth < MAX_PREVIEW_DEPTH && childrenToShow.map(child => renderNode(child, depth + 1))}
        {(hiddenCount > 0 || (depth >= MAX_PREVIEW_DEPTH && hasChildren)) && (
          <div style={{ paddingLeft: 16 }} className="text-[11px] text-muted-foreground/60 py-[1px]">
            ⋯ {depth >= MAX_PREVIEW_DEPTH
              ? t('mindmap:outline.subtreeItemCount', {
                  defaultValue: '{{count}} 项',
                  count: countDescendants(n),
                })
              : t('mindmap:outline.subtreeItemCount', {
                  defaultValue: '{{count}} 项',
                  count: hiddenCount,
                })
            }
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="drag-overlay-item !items-start !flex-col !py-2 !px-3 min-w-[120px] max-w-[300px] relative">
      {dragCount > 1 && (
        <span className="outline-drag-count-badge">{dragCount}</span>
      )}
      {renderNode(node, 0)}
    </div>
  );
};
