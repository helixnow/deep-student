/**
 * Chat V2 - 来源卡片组件
 *
 * 显示单个检索来源的卡片
 * 支持暗色/亮色主题
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import {
  FileText,
  Globe,
  Brain,
  ImageIcon,
  ExternalLink,
  ChevronRight,
} from 'lucide-react';
import type { RetrievalSource, RetrievalSourceType } from './types';
import { openUrl } from '@/utils/urlOpener';

// ============================================================================
// Props
// ============================================================================

export interface SourceCardProps {
  /** 来源数据 */
  source: RetrievalSource;
  /** 序号（可选） */
  index?: number;
  /** 是否紧凑模式 */
  compact?: boolean;
  /** 点击回调 */
  onClick?: (source: RetrievalSource) => void;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 图标映射
// ============================================================================

// ★ 2026-01 清理：移除 graph 图标（错题系统废弃）
const sourceTypeIcons: Record<RetrievalSourceType, typeof FileText> = {
  rag: FileText,
  memory: Brain,
  web_search: Globe,
  multimodal: ImageIcon,
};

// ============================================================================
// 组件
// ============================================================================

/**
 * SourceCard - 来源卡片组件
 *
 * 功能：
 * 1. 显示来源标题、摘要
 * 2. 根据类型显示不同图标
 * 3. 显示相关度分数（如果有）
 * 4. 支持点击跳转
 * 5. 暗色/亮色主题支持
 */
export const SourceCard: React.FC<SourceCardProps> = ({
  source,
  index,
  compact = false,
  onClick,
  className,
}) => {
  const { t } = useTranslation('chatV2');

  const Icon = sourceTypeIcons[source.type] || FileText;
  const hasUrl = !!source.url;

  // 如果标题为空，使用 i18n 默认标题
  const displayTitle = source.title || t('blocks.retrieval.defaultSourceTitle', {
    index: (source.metadata?._fallbackIndex as number) ?? (index !== undefined ? index + 1 : 1),
  });

  const handleClick = useCallback(() => {
    if (onClick) {
      onClick(source);
    } else if (hasUrl) {
      // 默认行为：打开 URL
      openUrl(source.url);
    }
  }, [onClick, source, hasUrl]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleClick();
      }
    },
    [handleClick]
  );

  // 格式化分数显示
  const scoreDisplay = source.score !== undefined 
    ? `${Math.round(source.score * 100)}%` 
    : null;

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'group relative rounded-lg border transition-all',
        'bg-card hover:bg-accent/50',
        'border-border/50 hover:border-border',
        'dark:bg-card/50 dark:hover:bg-accent/30',
        'cursor-pointer',
        compact ? 'p-2' : 'p-3',
        className
      )}
    >
      {/* 头部：图标 + 标题 + 分数 */}
      <div className="flex items-start gap-2">
        {/* 序号或图标 */}
        <div
          className={cn(
            'flex-shrink-0 flex items-center justify-center rounded',
            'bg-muted/50 text-muted-foreground',
            compact ? 'w-5 h-5 text-xs' : 'w-6 h-6 text-sm'
          )}
        >
          {index !== undefined ? (
            <span className="font-medium">{index + 1}</span>
          ) : (
            <Icon className={compact ? 'w-3 h-3' : 'w-4 h-4'} />
          )}
        </div>

        {/* 标题区域 */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h4
              className={cn(
                'font-medium text-foreground truncate',
                compact ? 'text-xs' : 'text-sm'
              )}
              title={displayTitle}
            >
              {displayTitle}
            </h4>

            {/* 相关度分数 */}
            {scoreDisplay && (
              <span
                className={cn(
                  'flex-shrink-0 px-1.5 py-0.5 rounded text-xs',
                  'bg-primary/10 text-primary',
                  'dark:bg-primary/20'
                )}
              >
                {scoreDisplay}
              </span>
            )}
          </div>

          {/* 来源类型标签 */}
          <div className="flex items-center gap-1 mt-0.5">
            <Icon className="w-3 h-3 text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {t(`blocks.retrieval.sourceTypes.${source.type}`)}
            </span>
          </div>
        </div>

        {/* 跳转指示器 */}
        {hasUrl && (
          <ChevronRight
            className={cn(
              'flex-shrink-0 text-muted-foreground',
              'opacity-0 group-hover:opacity-100 transition-opacity',
              compact ? 'w-3 h-3' : 'w-4 h-4'
            )}
          />
        )}
      </div>

      {/* 摘要内容 */}
      {!compact && source.snippet && (
        <p
          className={cn(
            'mt-2 text-sm text-muted-foreground',
            'line-clamp-2 leading-relaxed'
          )}
        >
          {source.snippet}
        </p>
      )}

      {/* URL 显示（紧凑模式不显示） */}
      {!compact && hasUrl && (
        <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
          <ExternalLink className="w-3 h-3" />
          <span className="truncate" title={source.url}>
            {source.url}
          </span>
        </div>
      )}
    </div>
  );
};
