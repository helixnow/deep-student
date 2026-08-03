/**
 * 多模态检索结果卡片组件
 *
 * 用于展示多模态知识库的检索结果，支持：
 * - 页面缩略图预览（thumbnailBase64 / imageUrl，加载失败显示占位而非整块消失）
 * - 来源类型标识（题目集识别/教材/附件）
 * - 页码显示
 * - 文本摘要
 * - 类型内序号徽章（与 citation `[类型-N]` 契约一致）
 * - 定位/打开操作（由父级面板注入）
 *
 * 设计文档: docs/multimodal-user-memory-design.md (Section 8.4)
 */

import React, { useState, useCallback, useEffect, useMemo } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  BookOpen,
  Paperclip,
  Image as ImageIcon,
  ArrowSquareOut,
  ImageBroken,
} from '@phosphor-icons/react';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { cn } from '@/lib/utils';
import type { UnifiedSourceItem, MultimodalSourceType } from './sourceTypes';

// ============================================================================
// Props 定义
// ============================================================================

export interface MultimodalSourceCardProps {
  /** 来源项数据 */
  item: UnifiedSourceItem;
  /** 显示编号（类型内序号，1-based） */
  displayNumber?: number;
  /** 是否高亮 */
  highlighted?: boolean;
  /** 展开网格模式（false = 水平轮播固定宽度） */
  expanded?: boolean;
  /** 点击回调 */
  onClick?: (item: UnifiedSourceItem) => void;
  /** 定位到知识库回调（存在时显示定位按钮） */
  onLocate?: (item: UnifiedSourceItem) => void;
  /** 定位按钮文案 */
  locateLabel?: string;
  /** hover 进入（用于父级 hover 预览） */
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>;
  /** hover 离开（用于父级 hover 预览） */
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>;
  /** 额外的 CSS 类名 */
  className?: string;
  /** 内联样式（父级面板注入入场 stagger 变量等） */
  style?: React.CSSProperties;
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 获取来源类型图标 */
function getSourceTypeIcon(sourceType?: MultimodalSourceType) {
  switch (sourceType) {
    case 'exam':
      return <FileText size={16} />;
    case 'textbook':
      return <BookOpen size={16} />;
    case 'attachment':
      return <Paperclip size={16} />;
    default:
      return <ImageIcon size={16} />;
  }
}

/** 获取来源类型色标（token 化） */
function getSourceTypeColor(sourceType?: MultimodalSourceType): string {
  switch (sourceType) {
    case 'exam':
      return 'text-primary bg-primary/10';
    case 'textbook':
      return 'text-success bg-success/10';
    case 'attachment':
      return 'text-muted-foreground bg-muted';
    default:
      return 'text-muted-foreground bg-muted';
  }
}

/**
 * 解析卡片图片源：优先缩略图 base64，回退到后端 imageUrl
 */
export function resolveMultimodalImageSrc(item: UnifiedSourceItem): string | null {
  const thumbnail = item.multimodal?.thumbnailBase64;
  if (thumbnail) {
    return `data:image/jpeg;base64,${thumbnail}`;
  }
  if (item.imageUrl) {
    return item.imageUrl;
  }
  return null;
}

// ============================================================================
// 组件实现
// ============================================================================

export const MultimodalSourceCard = React.forwardRef<HTMLDivElement, MultimodalSourceCardProps>(({
  item,
  displayNumber,
  highlighted = false,
  expanded = false,
  onClick,
  onLocate,
  locateLabel,
  onMouseEnter,
  onMouseLeave,
  className,
  style,
}, ref) => {
  const { t } = useTranslation(['common', 'chatV2']);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  const multimodal = item.multimodal;
  const imageSrc = useMemo(() => resolveMultimodalImageSrc(item), [item]);
  const score = item.score;
  const scorePercent = score != null ? Math.round(score * 100) : null;

  // 图片源变化（组件被复用展示其他 item）时重置加载/错误状态
  useEffect(() => {
    setImageLoading(true);
    setImageError(false);
  }, [imageSrc]);

  const handleImageLoad = useCallback(() => {
    setImageLoading(false);
  }, []);

  const handleImageError = useCallback(() => {
    setImageLoading(false);
    setImageError(true);
  }, []);

  const handleClick = useCallback(() => {
    onClick?.(item);
  }, [onClick, item]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!onClick || e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    onClick(item);
  }, [item, onClick]);

  const handleLocate = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onLocate?.(item);
    },
    [onLocate, item]
  );

  // 来源类型标签
  const sourceTypeLabel = multimodal?.sourceType
    ? t(`common:chat.sources.multimodal.sourceTypes.${multimodal.sourceType}`, {
        defaultValue: multimodal.sourceType,
      })
    : '';

  // 页码标签（优先 multimodal.pageIndex，回退 item.pageIndex）
  const pageIndex = multimodal?.pageIndex ?? item.pageIndex;
  const pageLabel =
    pageIndex != null
      ? t('common:chat.sources.multimodal.pageLabel', { page: pageIndex + 1 })
      : '';

  return (
    <div
      ref={ref}
      className={cn(
        // 视觉样式统一走 UnifiedSourcePanel.css 的 .usp-item-card
        'usp-item-card group',
        !expanded && 'w-56 flex-shrink-0',
        highlighted && 'usp-citation-pulse',
        className
      )}
      style={style}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      role={onClick ? 'button' : 'listitem'}
      tabIndex={onClick ? 0 : undefined}
    >
      {/* 缩略图区域：加载失败时显示占位（图标 + 文案），不整块消失 */}
      {imageSrc && (
        <div className="relative w-full h-24 rounded-md overflow-hidden bg-muted mb-2">
          {imageError ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-muted-foreground">
              <ImageBroken size={16} />
              <span className="text-2xs">
                {t('chatV2:sourcePanel.thumbnailUnavailable')}
              </span>
            </div>
          ) : (
            <>
              {imageLoading && <Skeleton className="absolute inset-0 rounded-none" />}
              <img
                src={imageSrc}
                alt={item.title}
                loading="lazy"
                className={cn(
                  'w-full h-full object-cover transition-opacity duration-300 ease-in-out motion-reduce:transition-none',
                  imageLoading ? 'opacity-0' : 'opacity-100'
                )}
                onLoad={handleImageLoad}
                onError={handleImageError}
              />
            </>
          )}
        </div>
      )}

      {/* 标题行 */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 overflow-hidden">
          {displayNumber != null && (
            <span className="usp-item-badge">{displayNumber}</span>
          )}
          <span className="usp-card-icon shrink-0">
            {getSourceTypeIcon(multimodal?.sourceType)}
          </span>
          <span className="usp-card-title text-sm font-medium truncate" title={item.title}>{item.title}</span>
        </div>
        {scorePercent != null && (
          <span
            className="usp-item-score"
            data-tier={scorePercent >= 75 ? 'high' : scorePercent >= 45 ? 'mid' : 'low'}
          >
            <i className="usp-score-dot" aria-hidden />
            {scorePercent}%
          </span>
        )}
      </div>

      {/* 来源类型和页码 */}
      {(sourceTypeLabel || pageLabel) && (
        <div className="flex items-center gap-2 text-xs mb-1.5">
          {sourceTypeLabel && (
            <span
              className={cn(
                'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-2xs',
                getSourceTypeColor(multimodal?.sourceType)
              )}
            >
              {sourceTypeLabel}
            </span>
          )}
          {pageLabel && (
            <span className="text-muted-foreground text-2xs">{pageLabel}</span>
          )}
        </div>
      )}

      {/* 文本摘要 */}
      <div className="text-xs text-muted-foreground line-clamp-2 mb-1.5 min-h-8">
        {item.snippet || t('common:chat.sources.multimodal.noSnippet')}
      </div>

      {/* 底部操作区 */}
      <div className="flex items-center justify-between gap-2 mt-auto pt-1.5 border-t border-border/50">
        <span className="usp-card-meta truncate">
          {t('common:chat.sources.groupLabels.multimodal')}
        </span>
        {onLocate && (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={handleLocate}
            className="!h-6 text-xs text-primary [@media(pointer:coarse)]:!h-11"
          >
            <ArrowSquareOut size={12} />
            {locateLabel || t('common:chat.sources.locateKb')}
          </DsButton>
        )}
      </div>
    </div>
  );
});

MultimodalSourceCard.displayName = 'MultimodalSourceCard';

export default MultimodalSourceCard;
