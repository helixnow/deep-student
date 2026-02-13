/**
 * Chat V2 - 来源列表组件
 *
 * 显示检索来源列表
 * 支持展开/折叠、暗色/亮色主题
 */

import React, { useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { ChevronDown, ChevronRight, Layers } from 'lucide-react';
import { SourceCard } from './SourceCard';
import type { RetrievalSource } from './types';

// ============================================================================
// Props
// ============================================================================

export interface SourceListProps {
  /** 来源列表 */
  sources: RetrievalSource[];
  /** 标题 */
  title?: string;
  /** 最大显示数量（超过则折叠） */
  maxVisible?: number;
  /** 默认展开 */
  defaultExpanded?: boolean;
  /** 紧凑模式 */
  compact?: boolean;
  /** 点击来源回调 */
  onSourceClick?: (source: RetrievalSource) => void;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 组件
// ============================================================================

/**
 * SourceList - 来源列表组件
 *
 * 功能：
 * 1. 列表展示来源卡片
 * 2. 支持展开/折叠
 * 3. 超过最大数量时显示"查看更多"
 * 4. 支持紧凑模式
 * 5. 暗色/亮色主题支持
 */
export const SourceList: React.FC<SourceListProps> = ({
  sources,
  title,
  maxVisible = 3,
  defaultExpanded = false,
  compact = false,
  onSourceClick,
  className,
}) => {
  const { t } = useTranslation('chatV2');
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  const hasMore = sources.length > maxVisible;
  const visibleSources = useMemo(() => {
    if (isExpanded || !hasMore) {
      return sources;
    }
    return sources.slice(0, maxVisible);
  }, [sources, isExpanded, hasMore, maxVisible]);

  const hiddenCount = sources.length - maxVisible;

  const toggleExpanded = useCallback(() => {
    setIsExpanded((prev) => !prev);
  }, []);

  if (sources.length === 0) {
    return null;
  }

  return (
    <div className={cn('space-y-2', className)}>
      {/* 标题栏 */}
      {title && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Layers className="w-4 h-4" />
          <span className="font-medium">{title}</span>
          <span className="text-xs">
            ({sources.length} {t('blocks.retrieval.sourcesCount')})
          </span>
        </div>
      )}

      {/* 来源卡片列表 */}
      <div className={cn('space-y-2', compact && 'space-y-1')}>
        {visibleSources.map((source, index) => (
          <SourceCard
            key={source.id}
            source={source}
            index={index}
            compact={compact}
            onClick={onSourceClick}
          />
        ))}
      </div>

      {/* 展开/折叠按钮 */}
      {hasMore && (
        <button
          onClick={toggleExpanded}
          className={cn(
            'w-full flex items-center justify-center gap-1',
            'py-2 rounded-lg text-sm',
            'text-muted-foreground hover:text-foreground',
            'hover:bg-muted/50 transition-colors'
          )}
        >
          {isExpanded ? (
            <>
              <ChevronDown className="w-4 h-4" />
              <span>{t('blocks.retrieval.showLess')}</span>
            </>
          ) : (
            <>
              <ChevronRight className="w-4 h-4" />
              <span>
                {t('blocks.retrieval.showMore', { count: hiddenCount })}
              </span>
            </>
          )}
        </button>
      )}
    </div>
  );
};
