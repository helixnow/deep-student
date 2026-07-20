/**
 * Chat V2 - 来源列表组件
 *
 * 显示检索来源列表
 * 支持展开/折叠、暗色/亮色主题
 */

import React, { useState, useCallback, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import { CaretDown, Stack } from '@phosphor-icons/react';
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
  const collapsibleId = useId();

  const hasMore = sources.length > maxVisible;
  const visibleSources = hasMore ? sources.slice(0, maxVisible) : sources;
  const hiddenSources = hasMore ? sources.slice(maxVisible) : [];

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
          <Stack size={16} />
          <span className="font-medium">{title}</span>
          <span className="text-xs">
            ({sources.length} {t('blocks.retrieval.sourcesCount')})
          </span>
        </div>
      )}

      {/* 来源卡片列表 */}
      <div>
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

        {/* 折叠部分：内联 grid-rows 展开动画（禁模态/侧滑，遵循 motion-reduce） */}
        {hiddenSources.length > 0 && (
          <div
            id={collapsibleId}
            aria-hidden={!isExpanded}
            // inert：折叠时阻止内部卡片被 Tab 聚焦（React 18 类型未收录该属性，需绕过）
            {...(!isExpanded
              ? ({ inert: '' } as unknown as React.HTMLAttributes<HTMLDivElement>)
              : {})}
            className={cn(
              'grid transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
              isExpanded ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div className={cn('space-y-2 pt-2', compact && 'space-y-1 pt-1')}>
                {hiddenSources.map((source, index) => (
                  <SourceCard
                    key={source.id}
                    source={source}
                    index={maxVisible + index}
                    compact={compact}
                    onClick={onSourceClick}
                  />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* 展开/折叠按钮 */}
      {hasMore && (
        <NotionButton
          variant="ghost"
          size="sm"
          onClick={toggleExpanded}
          aria-expanded={isExpanded}
          aria-controls={collapsibleId}
          className="w-full !justify-center text-muted-foreground hover:text-foreground"
        >
          <CaretDown
            size={16}
            className={cn(
              'transition-transform duration-200 motion-reduce:transition-none',
              !isExpanded && '-rotate-90'
            )}
          />
          <span>
            {isExpanded
              ? t('blocks.retrieval.showLess')
              : t('blocks.retrieval.showMore', { count: hiddenCount })}
          </span>
        </NotionButton>
      )}
    </div>
  );
};
