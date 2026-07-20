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
  GraduationCap,
  Image as ImageIcon,
  ArrowSquareOut,
  CaretRight,
} from '@phosphor-icons/react';
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

  // 学术搜索来源基础 type 仍为 web_search（联合类型约束），
  // 通过 metadata._sourceKind 细分显示图标与标签
  const sourceKind = source.metadata?._sourceKind as string | undefined;
  const isAcademic = sourceKind === 'academic';
  const Icon = isAcademic ? GraduationCap : (sourceTypeIcons[source.type] || FileText);
  const typeLabel = isAcademic
    ? t('blocks.retrieval.sourceTypes.academic')
    : t(`blocks.retrieval.sourceTypes.${source.type}`);
  const hasUrl = !!source.url;
  // 无 URL 且无回调的卡片是纯展示，不应表现为可点（避免误导的手型光标 + 无效 Tab 停留）
  const isInteractive = !!onClick || hasUrl;

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
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
      onClick={isInteractive ? handleClick : undefined}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
      className={cn(
        // 与统一来源面板（usp-item）对齐：圆角、边框透明度、hover 用 primary 着色
        'group relative rounded-xl border border-border/50 bg-card dark:bg-card/50',
        'transition-[border-color,background-color,box-shadow] duration-200 motion-reduce:transition-none',
        isInteractive && [
          'cursor-pointer',
          'hover:border-primary/35 hover:bg-primary/5 dark:hover:bg-muted/40',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background',
        ],
        compact ? 'p-2' : 'p-3',
        className
      )}
    >
      {/* 头部：图标 + 标题 + 分数 */}
      <div className="flex items-start gap-2">
        {/* 序号或图标 */}
        <div
          className={cn(
            'flex-shrink-0 flex items-center justify-center rounded-md',
            'bg-muted/50 text-muted-foreground',
            compact ? 'w-5 h-5 text-xs' : 'w-6 h-6 text-sm'
          )}
          aria-hidden="true"
        >
          {index !== undefined ? (
            <span className="font-medium tabular-nums">{index + 1}</span>
          ) : (
            <Icon size={compact ? 12 : 16} />
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

            {/* 相关度分数（与统一来源面板 usp-item-score 同款：描边 pill + 弱化文字） */}
            {scoreDisplay && (
              <span
                className={cn(
                  'flex-shrink-0 rounded-md border border-border/40 px-1.5 py-0.5',
                  'text-[11px] leading-none tabular-nums text-muted-foreground'
                )}
              >
                {scoreDisplay}
              </span>
            )}
          </div>

          {/* 来源类型标签 */}
          <div className="flex items-center gap-1 mt-0.5">
            <Icon size={12} className="text-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {typeLabel}
            </span>
          </div>
        </div>

        {/* 跳转指示器 */}
        {hasUrl && (
          <CaretRight
            size={compact ? 12 : 16}
            aria-hidden="true"
            className={cn(
              'flex-shrink-0 self-center text-muted-foreground',
              // 触屏无 hover：coarse 指针下常显，保留"可点开"的视觉线索；
              // 键盘聚焦时同样显示，与 hover 对等
              'opacity-0 transition-opacity duration-200 motion-reduce:transition-none',
              'group-hover:opacity-100 group-focus-visible:opacity-100',
              '[@media(pointer:coarse)]:opacity-60'
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
          <ArrowSquareOut size={12} />
          <span className="truncate" title={source.url}>
            {source.url}
          </span>
        </div>
      )}
    </div>
  );
};
