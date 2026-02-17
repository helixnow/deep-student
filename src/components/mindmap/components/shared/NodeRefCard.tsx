/**
 * 节点资源引用卡片
 *
 * 在思维导图节点内显示关联的 VFS 资源引用，
 * 支持点击跳转和右键移除。
 */

import React, { useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getResourceIcon, type ResourceIconType } from '@/components/learning-hub/icons';
import type { MindMapNodeRef } from '../../types';


// ============================================================================
// 组件
// ============================================================================

export interface NodeRefCardProps {
  ref_: MindMapNodeRef;
  onRemove?: (sourceId: string) => void;
  onClick?: (sourceId: string) => void;
  readonly?: boolean;
  className?: string;
}

export const NodeRefCard: React.FC<NodeRefCardProps> = ({
  ref_,
  onRemove,
  onClick,
  readonly = false,
  className,
}) => {
  const IconComp = getResourceIcon(ref_.type as ResourceIconType);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClick?.(ref_.sourceId);
    },
    [onClick, ref_.sourceId]
  );

  const handleRemove = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      e.preventDefault();
      onRemove?.(ref_.sourceId);
    },
    [onRemove, ref_.sourceId]
  );

  return (
    <div
      className={cn(
        'group/ref nopan nodrag',
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded',
        'text-[11px] leading-tight',
        'bg-[var(--mm-bg-elevated)] hover:bg-accent/50',
        'border border-border/30',
        'cursor-pointer transition-colors duration-150',
        className
      )}
      onClick={handleClick}
      title={`${ref_.name} (${ref_.sourceId})`}
    >
      <IconComp size={14} className="shrink-0" />
      <span className="whitespace-nowrap">{ref_.name}</span>
      {!readonly && onRemove && (
        <NotionButton variant="ghost" size="icon" iconOnly onClick={handleRemove} className="!ml-0.5 !-mr-0.5 !p-0.5 !h-auto !w-auto !min-w-0 !rounded-sm opacity-0 group-hover/ref:opacity-60 hover:!opacity-100 hover:bg-destructive/10" aria-label="remove">
          <X className="w-2.5 h-2.5" />
        </NotionButton>
      )}
    </div>
  );
};

// ============================================================================
// 引用列表组件
// ============================================================================

export interface NodeRefListProps {
  refs: MindMapNodeRef[];
  onRemove?: (sourceId: string) => void;
  onClick?: (sourceId: string) => void;
  readonly?: boolean;
  className?: string;
}

export const NodeRefList: React.FC<NodeRefListProps> = ({
  refs,
  onRemove,
  onClick,
  readonly = false,
  className,
}) => {
  if (!refs || refs.length === 0) return null;

  return (
    <div className={cn('flex flex-col gap-0.5 mt-1 whitespace-normal', className)}>
      {refs.map((ref) => (
        <NodeRefCard
          key={ref.sourceId}
          ref_={ref}
          onRemove={onRemove}
          onClick={onClick}
          readonly={readonly}
        />
      ))}
    </div>
  );
};
