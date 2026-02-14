/**
 * 节点资源引用卡片
 *
 * 在思维导图节点内显示关联的 VFS 资源引用，
 * 支持点击跳转和右键移除。
 */

import React, { useCallback } from 'react';
import {
  FileText,
  BookOpen,
  ClipboardList,
  Languages,
  Pencil,
  Image as ImageIcon,
  File,
  Brain,
  X,
  Search,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MindMapNodeRef } from '../../types';

// ============================================================================
// 类型图标映射（与 Chat V2 ContextRefChips 保持一致）
// ============================================================================

const getRefIcon = (type: string): React.ElementType => {
  switch (type) {
    case 'note':
      return FileText;
    case 'textbook':
      return BookOpen;
    case 'exam':
      return ClipboardList;
    case 'essay':
      return Pencil;
    case 'translation':
      return Languages;
    case 'image':
      return ImageIcon;
    case 'file':
      return File;
    case 'mindmap':
      return Brain;
    case 'retrieval':
      return Search;
    default:
      return FileText;
  }
};

const getRefColorClass = (type: string): string => {
  switch (type) {
    case 'note':
      return 'text-blue-600 dark:text-blue-400';
    case 'textbook':
      return 'text-purple-600 dark:text-purple-400';
    case 'exam':
      return 'text-orange-600 dark:text-orange-400';
    case 'essay':
      return 'text-green-600 dark:text-green-400';
    case 'translation':
      return 'text-cyan-600 dark:text-cyan-400';
    case 'mindmap':
      return 'text-indigo-600 dark:text-indigo-400';
    default:
      return 'text-muted-foreground';
  }
};

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
  const Icon = getRefIcon(ref_.type);
  const colorClass = getRefColorClass(ref_.type);

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
        'max-w-full',
        className
      )}
      onClick={handleClick}
      title={`${ref_.name} (${ref_.sourceId})`}
    >
      <Icon className={cn('w-3 h-3 shrink-0', colorClass)} />
      <span className="truncate">{ref_.name}</span>
      {!readonly && onRemove && (
        <button
          type="button"
          onClick={handleRemove}
          className="ml-0.5 -mr-0.5 p-0.5 rounded-sm opacity-0 group-hover/ref:opacity-60 hover:!opacity-100 hover:bg-destructive/10 transition-opacity"
        >
          <X className="w-2.5 h-2.5" />
        </button>
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
    <div className={cn('flex flex-col gap-0.5 mt-1', className)}>
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
