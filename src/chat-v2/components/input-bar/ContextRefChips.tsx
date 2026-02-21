/**
 * Chat V2 - ContextRefChips 组件
 *
 * 🔧 P1-27: 显示 pendingContextRefs 中非附件类型的上下文引用
 *
 * 功能：
 * 1. 显示待发送的上下文引用（如笔记、教材、题目集等）
 * 2. 允许用户点击移除单个引用
 * 3. 提供清空所有引用的按钮
 */

import React, { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { X, FileText, BookOpen, ClipboardList, Languages, Pencil, Folder, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import type { ContextRef } from '../../resources/types';

// ============================================================================
// 类型定义
// ============================================================================

export interface ContextRefChipsProps {
  /** 待发送的上下文引用列表 */
  refs: ContextRef[];
  /** 移除单个引用的回调 */
  onRemove: (resourceId: string) => void;
  /** 清空所有引用的回调 */
  onClearAll: () => void;
  /** 是否禁用交互 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 类型图标映射
// ============================================================================

/**
 * 根据类型 ID 获取对应的图标组件
 */
const getTypeIcon = (typeId: string): React.ElementType => {
  switch (typeId) {
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
    case 'folder':
      return Folder;
    case 'skill':
    case 'skill_instruction':
      return Zap;
    default:
      return FileText;
  }
};

/**
 * 根据类型 ID 获取翻译键
 */
const getTypeLabelKey = (typeId: string): string => {
  switch (typeId) {
    case 'note':
    case 'textbook':
    case 'exam':
    case 'essay':
    case 'translation':
    case 'folder':
    case 'skill':
      return `chatV2:contextRef.type.${typeId}`;
    default:
      return typeId;
  }
};

/**
 * 根据类型 ID 获取 Chip 颜色样式
 */
const getTypeColorClass = (typeId: string): string => {
  switch (typeId) {
    case 'note':
      return 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300';
    case 'textbook':
      return 'bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300';
    case 'exam':
      return 'bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300';
    case 'essay':
      return 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300';
    case 'translation':
      return 'bg-cyan-100 text-cyan-700 dark:bg-cyan-900/40 dark:text-cyan-300';
    case 'folder':
      return 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300';
    case 'skill':
    case 'skill_instruction':
      return 'bg-primary/20 text-primary';
    default:
      return 'bg-muted text-foreground';
  }
};

// ============================================================================
// 主组件
// ============================================================================

/**
 * ContextRefChips - 上下文引用 Chips 组件
 *
 * 在输入栏上方显示待发送的上下文引用列表，
 * 让用户可以看到并管理即将随消息发送的引用。
 */
export const ContextRefChips: React.FC<ContextRefChipsProps> = memo(
  ({ refs, onRemove, onClearAll, disabled = false, className }) => {
    const { t } = useTranslation(['chatV2', 'common']);

    const vfsResourceTypes = new Set(['note', 'textbook', 'exam', 'essay', 'translation', 'image', 'file', 'mindmap']);
    
    const displayRefs = useMemo(() => {
      return refs.filter((ref) => !vfsResourceTypes.has(ref.typeId));
    }, [refs]);

    // 没有需要显示的引用时不渲染
    if (displayRefs.length === 0) {
      return null;
    }

    return (
      <div
        className={cn(
          'context-ref-chips flex flex-wrap items-center gap-1.5 px-2 py-1.5',
          className
        )}
      >
        {/* 引用列表 */}
        {displayRefs.map((ref) => {
          const Icon = getTypeIcon(ref.typeId);
          const labelKey = getTypeLabelKey(ref.typeId);
          // 优先使用 displayName，否则使用翻译或 typeId
          const label = ref.displayName 
            ? ref.displayName 
            : (labelKey.startsWith('chatV2:') ? t(labelKey) : labelKey);
          const colorClass = getTypeColorClass(ref.typeId);
          const isSticky = ref.isSticky;

          return (
            <div
              key={`${ref.resourceId}-${ref.hash}`}
              className={cn(
                'context-ref-chip inline-flex items-center gap-1.5 px-3 py-1',
                'rounded-full text-xs font-medium border border-transparent',
                'transition-all duration-200 hover:scale-105 cursor-default',
                colorClass,
                isSticky && 'shadow-sm ring-1 ring-background/50'
              )}
              title={`${label} (${ref.resourceId.slice(0, 8)}...)`}
            >
              <Icon size={12} className="shrink-0" />
              <span className="truncate max-w-[80px]">{label}</span>
              {!disabled && (
                <NotionButton variant="ghost" size="icon" iconOnly onClick={() => onRemove(ref.resourceId)} className="ml-1 -mr-1 !h-4 !w-4 !p-0 !rounded-full opacity-60 hover:opacity-100 hover:bg-black/5 dark:hover:bg-white/10" aria-label={`${t('common:actions.remove')} ${label}`} title={t('common:actions.remove')}>
                  <X size={10} />
                </NotionButton>
              )}
            </div>
          );
        })}

        {/* 清空所有按钮 */}
        {displayRefs.length > 1 && !disabled && (
          <NotionButton variant="ghost" size="sm" onClick={onClearAll} className="text-muted-foreground hover:text-destructive hover:bg-destructive/10" title={t('chatV2:contextRef.clearAll')}>
            {t('common:actions.clear_all')}
          </NotionButton>
        )}
      </div>
    );
  }
);

ContextRefChips.displayName = 'ContextRefChips';

export default ContextRefChips;
