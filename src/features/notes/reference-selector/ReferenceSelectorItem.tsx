/**
 * 引用选择器项 - 单个资源项的渲染组件
 *
 * listbox option 语义：由父级 ReferenceSelector 提供 role=listbox 容器，
 * 本组件渲染 role=option 行，支持鼠标点击与键盘 active 高亮（aria-activedescendant）。
 */

import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { convertFileSrc } from '@tauri-apps/api/core';
import { BookOpen, Table, Check, Prohibit } from '@phosphor-icons/react';
import { cn } from '../../../lib/utils';
import type { UnifiedResourceItem } from './types';

interface ReferenceSelectorItemProps {
  item: UnifiedResourceItem;
  /** DOM id（用于 aria-activedescendant） */
  id?: string;
  /** 是否已被引用（禁用状态） */
  isReferenced: boolean;
  /** 是否选中 */
  isSelected: boolean;
  /** 键盘导航当前高亮项 */
  isActive?: boolean;
  /** 点击回调 */
  onClick: () => void;
  /** hover 时同步键盘高亮（可选） */
  onHover?: () => void;
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
      return <BookOpen className="h-5 w-5 text-purple-500" aria-hidden="true" />;
    case 'exam_sessions':
      return <Table className="h-5 w-5 text-green-500" aria-hidden="true" />;
    default:
      return <BookOpen className="h-5 w-5 text-muted-foreground" aria-hidden="true" />;
  }
}

/**
 * 将本地封面路径转换为可渲染的 asset URL（非 Tauri 环境下返回 null 走图标回退）
 */
function useThumbnailSrc(thumbnail?: string): string | null {
  return useMemo(() => {
    if (!thumbnail) return null;
    if (/^(https?|data|asset|blob):/.test(thumbnail)) return thumbnail;
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return null;
    try {
      return convertFileSrc(thumbnail);
    } catch {
      return null;
    }
  }, [thumbnail]);
}

export const ReferenceSelectorItem: React.FC<ReferenceSelectorItemProps> = ({
  item,
  id,
  isReferenced,
  isSelected,
  isActive = false,
  onClick,
  onHover,
}) => {
  const formatRelativeTime = useFormatRelativeTime();
  const thumbnailSrc = useThumbnailSrc(item.thumbnail);
  const [thumbFailed, setThumbFailed] = useState(false);
  const showThumbnail = thumbnailSrc && !thumbFailed;

  return (
    <div
      id={id}
      role="option"
      aria-selected={isSelected}
      aria-disabled={isReferenced || undefined}
      onClick={isReferenced ? undefined : onClick}
      onMouseEnter={isReferenced ? undefined : onHover}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left transition-colors duration-150',
        isReferenced
          ? 'opacity-50 cursor-not-allowed bg-muted/30'
          : cn(
              'cursor-pointer',
              isActive || isSelected
                ? 'bg-[var(--interactive-hover)]'
                : 'hover:bg-[var(--interactive-hover)]'
            )
      )}
    >
      {/* 封面缩略图（无封面/加载失败回退类型图标） */}
      <div className="flex h-9 w-7 flex-shrink-0 items-center justify-center overflow-hidden rounded-sm">
        {showThumbnail ? (
          <img
            src={thumbnailSrc}
            alt=""
            loading="lazy"
            className="h-full w-full rounded-sm border border-border/40 object-cover"
            onError={() => setThumbFailed(true)}
          />
        ) : (
          getSourceIcon(item.sourceDb)
        )}
      </div>

      {/* 内容 */}
      <div className="min-w-0 flex-1">
        <div
          className={cn(
            'truncate text-sm font-medium',
            isReferenced ? 'text-muted-foreground' : 'text-foreground'
          )}
        >
          {item.title}
        </div>
        <div className="mt-0.5 flex items-center gap-2">
          <span className="text-xs text-muted-foreground/70">
            {formatRelativeTime(item.updatedAt)}
          </span>
        </div>
      </div>

      {/* 状态指示器 */}
      <div className="flex-shrink-0">
        {isReferenced ? (
          <Prohibit className="h-4 w-4 text-muted-foreground/50" aria-hidden="true" />
        ) : isSelected ? (
          <Check className="h-4 w-4 text-primary" aria-hidden="true" />
        ) : null}
      </div>
    </div>
  );
};

export default ReferenceSelectorItem;
