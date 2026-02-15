/**
 * 引用选择器项 - 单个资源项的渲染组件
 */

import React from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import { BookOpen, Check, Ban } from 'lucide-react';
import { cn } from '../../../lib/utils';
import type { UnifiedResourceItem } from './types';

interface ReferenceSelectorItemProps {
  item: UnifiedResourceItem;
  /** 是否已被引用（禁用状态） */
  isReferenced: boolean;
  /** 是否选中 */
  isSelected: boolean;
  /** 点击回调 */
  onClick: () => void;
}

/**
 * 格式化时间为相对时间（使用 i18n）
 */
function useFormatRelativeTime() {
  const { t } = useTranslation('notes');
  
  return (timestamp: number): string => {
    const now = Date.now();
    const diff = now - timestamp;
    
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    
    if (minutes < 1) return t('reference.time.just_now');
    if (minutes < 60) return t('reference.time.minutes_ago', { count: minutes });
    if (hours < 24) return t('reference.time.hours_ago', { count: hours });
    if (days < 30) return t('reference.time.days_ago', { count: days });
    
    const date = new Date(timestamp);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
}

/**
 * 获取资源类型图标
 */
function getSourceIcon(sourceDb: string) {
  switch (sourceDb) {
    case 'textbooks':
      return <BookOpen className="h-5 w-5 text-purple-500" />;
    default:
      return <BookOpen className="h-5 w-5 text-gray-500" />;
  }
}

export const ReferenceSelectorItem: React.FC<ReferenceSelectorItemProps> = ({
  item,
  isReferenced,
  isSelected,
  onClick,
}) => {
  const formatRelativeTime = useFormatRelativeTime();
  
  return (
    <NotionButton
      variant="ghost" size="sm"
      disabled={isReferenced}
      onClick={onClick}
      className={cn(
        '!w-full !justify-start !px-3 !py-2.5 !h-auto !rounded-lg !text-left',
        isReferenced
          ? 'opacity-50 cursor-not-allowed bg-muted/30'
          : isSelected
            ? 'bg-primary/10 border border-primary/30'
            : 'hover:bg-accent/50 active:bg-accent'
      )}
    >
      {/* 图标 */}
      <div className="flex-shrink-0">
        {getSourceIcon(item.sourceDb)}
      </div>
      
      {/* 内容 */}
      <div className="flex-1 min-w-0">
        <div className={cn(
          'text-sm font-medium truncate',
          isReferenced ? 'text-muted-foreground' : 'text-foreground'
        )}>
          {item.title}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-muted-foreground/70">
            {formatRelativeTime(item.updatedAt)}
          </span>
        </div>
      </div>
      
      {/* 状态指示器 */}
      <div className="flex-shrink-0">
        {isReferenced ? (
          <Ban className="h-4 w-4 text-muted-foreground/50" />
        ) : isSelected ? (
          <Check className="h-4 w-4 text-primary" />
        ) : null}
      </div>
    </NotionButton>
  );
};

export default ReferenceSelectorItem;
