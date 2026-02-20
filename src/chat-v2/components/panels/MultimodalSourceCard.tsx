/**
 * 多模态检索结果卡片组件
 *
 * 用于展示多模态知识库的检索结果，支持：
 * - 页面缩略图预览
 * - 来源类型标识（题目集识别/教材/附件）
 * - 页码显示
 * - 文本摘要
 * - 点击跳转原文
 *
 * 设计文档: docs/multimodal-user-memory-design.md (Section 8.4)
 */

import React, { useState, useCallback } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { useTranslation } from 'react-i18next';
import {
  FileText,
  BookOpen,
  Paperclip,
  Image as ImageIcon,
  ExternalLink,
  Loader2,
  ZoomIn,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { UnifiedSourceItem, MultimodalSourceType } from './sourceTypes';

// ============================================================================
// Props 定义
// ============================================================================

export interface MultimodalSourceCardProps {
  /** 来源项数据 */
  item: UnifiedSourceItem;
  /** 是否高亮 */
  highlighted?: boolean;
  /** 点击回调 */
  onClick?: (item: UnifiedSourceItem) => void;
  /** 查看原图回调 */
  onViewOriginal?: (blobHash: string) => void;
  /** 额外的 CSS 类名 */
  className?: string;
}

// ============================================================================
// 辅助函数
// ============================================================================

/** 获取来源类型图标 */
function getSourceTypeIcon(sourceType: MultimodalSourceType) {
  switch (sourceType) {
    case 'exam':
      return <FileText className="h-4 w-4" />;
    case 'textbook':
      return <BookOpen className="h-4 w-4" />;
    case 'attachment':
      return <Paperclip className="h-4 w-4" />;
    default:
      return <ImageIcon className="h-4 w-4" />;
  }
}

/** 获取来源类型颜色 */
function getSourceTypeColor(sourceType: MultimodalSourceType): string {
  switch (sourceType) {
    case 'exam':
      return 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-950';
    case 'textbook':
      return 'text-success bg-success/10';
    case 'attachment':
      return 'text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-950';
    default:
      return 'text-gray-600 dark:text-gray-400 bg-gray-50 dark:bg-gray-950';
  }
}

// ============================================================================
// 组件实现
// ============================================================================

export const MultimodalSourceCard: React.FC<MultimodalSourceCardProps> = ({
  item,
  highlighted = false,
  onClick,
  onViewOriginal,
  className,
}) => {
  const { t } = useTranslation(['common']);
  const [imageLoading, setImageLoading] = useState(true);
  const [imageError, setImageError] = useState(false);

  const multimodal = item.multimodal;
  const hasThumbnail = multimodal?.thumbnailBase64;
  const score = item.score;
  const scorePercent = score != null ? Math.round(score * 100) : null;

  // 处理图片加载
  const handleImageLoad = useCallback(() => {
    setImageLoading(false);
  }, []);

  const handleImageError = useCallback(() => {
    setImageLoading(false);
    setImageError(true);
  }, []);

  // 处理卡片点击
  const handleClick = useCallback(() => {
    onClick?.(item);
  }, [onClick, item]);

  // 处理查看原图
  const handleViewOriginal = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (multimodal?.blobHash) {
        onViewOriginal?.(multimodal.blobHash);
      }
    },
    [multimodal?.blobHash, onViewOriginal]
  );

  // 来源类型标签
  const sourceTypeLabel = multimodal?.sourceType
    ? t(`common:chat.sources.multimodal.sourceTypes.${multimodal.sourceType}`)
    : '';

  // 页码标签
  const pageLabel =
    multimodal?.pageIndex != null
      ? t('common:chat.sources.multimodal.pageLabel', { page: multimodal.pageIndex + 1 })
      : '';

  return (
    <div
      className={cn(
        // 与 UnifiedSourcePanel 中的卡片样式保持一致
        'usp-item-card w-56 flex-shrink-0 rounded-lg border bg-card p-2.5 hover:bg-accent/50 transition-all cursor-default group',
        highlighted && 'ring-1 ring-primary/30 shadow-lg scale-[1.02]',
        className
      )}
      onClick={handleClick}
      role="listitem"
    >
      {/* 缩略图区域 - 紧凑布局 */}
      {hasThumbnail && !imageError && (
        <div className="relative w-full h-24 rounded-md overflow-hidden bg-muted mb-2">
          {imageLoading && (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          )}
          <img
            src={`data:image/jpeg;base64,${multimodal.thumbnailBase64}`}
            alt={item.title}
            className={cn(
              'w-full h-full object-cover transition-opacity',
              imageLoading ? 'opacity-0' : 'opacity-100'
            )}
            onLoad={handleImageLoad}
            onError={handleImageError}
          />
          {/* 查看原图按钮 */}
          {multimodal?.blobHash && (
            <NotionButton variant="ghost" size="icon" iconOnly onClick={handleViewOriginal} className="absolute inset-0 !w-full !h-full !rounded-none bg-black/50 opacity-0 group-hover:opacity-100 text-white" aria-label={t('common:chat.sources.multimodal.viewOriginal')} title={t('common:chat.sources.multimodal.viewOriginal')}>
              <ZoomIn className="h-5 w-5" />
            </NotionButton>
          )}
        </div>
      )}

      {/* 标题行 */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-2 overflow-hidden">
          <span className="text-muted-foreground shrink-0">
            {multimodal?.sourceType ? getSourceTypeIcon(multimodal.sourceType) : <ImageIcon className="h-4 w-4" />}
          </span>
          <span className="text-sm font-medium truncate" title={item.title}>{item.title}</span>
        </div>
        {scorePercent != null && (
          <span className="usp-item-score">{scorePercent}%</span>
        )}
      </div>

      {/* 来源类型和页码 */}
      <div className="flex items-center gap-2 text-xs mb-1.5">
        {multimodal?.sourceType && (
          <span
            className={cn(
              'inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]',
              getSourceTypeColor(multimodal.sourceType)
            )}
          >
            {sourceTypeLabel}
          </span>
        )}
        {pageLabel && (
          <span className="text-muted-foreground text-[10px]">{pageLabel}</span>
        )}
      </div>

      {/* 文本摘要 */}
      <div className="text-xs text-muted-foreground line-clamp-2 mb-1.5 h-[2.4em]">
        {item.snippet || t('common:chat.sources.multimodal.noThumbnail')}
      </div>

      {/* 底部操作区 */}
      <div className="flex items-center justify-between mt-auto pt-1.5 border-t border-border/50">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wider opacity-70">
          {t('common:chat.sources.groupLabels.multimodal')}
        </span>
        {multimodal?.blobHash && (
          <NotionButton variant="ghost" size="sm" onClick={handleViewOriginal} className="text-primary hover:underline">
            <ExternalLink size={12} />
            {t('common:chat.sources.multimodal.viewOriginal')}
          </NotionButton>
        )}
      </div>
    </div>
  );
};

export default MultimodalSourceCard;
