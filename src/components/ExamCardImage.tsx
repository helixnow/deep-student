/**
 * ExamCardImage - 题目集题目卡片图片组件（兼容新旧模式）
 *
 * ★ 文档25：渐进式迁移
 * 1. 新数据：使用 blob_hash + Canvas 裁剪
 * 2. 旧数据：使用 cropped_image_path
 *
 * @see 25-题目集识别VFS存储与多模态上下文注入改造.md
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { CroppedExamCardImage, type BoundingBox } from './CroppedExamCardImage';

// ============================================================================
// 类型定义
// ============================================================================

export interface ExamCardImageProps {
  /** VFS Blob 哈希（新模式） */
  blobHash?: string | null;
  /** 整页图片宽度（新模式） */
  pageWidth?: number;
  /** 整页图片高度（新模式） */
  pageHeight?: number;
  /** 归一化边界框（新模式） */
  bbox?: BoundingBox;
  /** 像素级边界框（新模式，优先使用） */
  resolvedBbox?: BoundingBox;
  /** 裁剪图片路径（旧模式） */
  croppedImagePath?: string;
  /** 图片解析函数（旧模式） */
  resolveImageSrc?: (path: string, options?: { cardId?: string }) => string;
  /** 卡片 ID（用于旧模式图片解析） */
  cardId?: string;
  /** 替代文本 */
  alt?: string;
  /** 自定义类名 */
  className?: string;
  /** 最大显示高度 */
  maxHeight?: number | string;
  /** 点击事件 */
  onClick?: () => void;
  /** 加载完成回调 */
  onLoad?: () => void;
  /** 错误回调 */
  onError?: (error: string) => void;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * ExamCardImage - 自动选择新旧模式的图片显示组件
 *
 * 根据数据类型自动选择：
 * - 有 blobHash: 使用 CroppedExamCardImage（Canvas 裁剪）
 * - 无 blobHash: 使用 img 标签 + croppedImagePath（旧模式）
 */
export const ExamCardImage: React.FC<ExamCardImageProps> = ({
  blobHash,
  pageWidth = 0,
  pageHeight = 0,
  bbox,
  resolvedBbox,
  croppedImagePath,
  resolveImageSrc,
  cardId,
  alt,
  className,
  maxHeight = 200,
  onClick,
  onLoad,
  onError,
}) => {
  const { t } = useTranslation('exam_sheet');
  const resolvedAlt = alt ?? t('image.alt_card');
  // ★ 新模式：使用 blob_hash + Canvas 裁剪
  if (blobHash && bbox && pageWidth > 0 && pageHeight > 0) {
    return (
      <CroppedExamCardImage
        blobHash={blobHash}
        pageWidth={pageWidth}
        pageHeight={pageHeight}
        bbox={bbox}
        resolvedBbox={resolvedBbox}
        alt={resolvedAlt}
        className={className}
        maxHeight={maxHeight}
        onClick={onClick}
        onLoad={onLoad}
        onError={onError}
      />
    );
  }

  // ★ 旧模式：使用 cropped_image_path
  if (croppedImagePath) {
    const src = resolveImageSrc
      ? resolveImageSrc(croppedImagePath, { cardId })
      : croppedImagePath;

    return (
      <img
        src={src}
        alt={resolvedAlt}
        className={cn('rounded-lg object-contain', className, onClick && 'cursor-pointer')}
        style={{ maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }}
        onClick={onClick}
        onLoad={onLoad}
        onError={() => onError?.(t('image.load_failed'))}
      />
    );
  }

  // 无可用图片
  return (
    <div
      className={cn(
        'flex items-center justify-center rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 text-sm text-muted-foreground',
        className
      )}
      style={{ minHeight: 100, maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }}
    >
      {t('image.no_image')}
    </div>
  );
};

export default ExamCardImage;
