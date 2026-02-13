/**
 * ExamPageImage - 题目集页面图片组件（兼容新旧模式）
 *
 * ★ 文档25：渐进式迁移
 * 1. 新数据：使用 blob_hash + getBlobAsDataUrl
 * 2. 旧数据：使用 original_image_path
 */

import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { getBlobAsDataUrl } from '@/chat-v2/context/blobApi';
import { getErrorMessage } from '@/utils/errorUtils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { AlertCircle, ImageOff } from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

export interface ExamPageImageProps {
  /** VFS Blob 哈希（新模式） */
  blobHash?: string | null;
  /** 原始图片路径（旧模式） */
  originalImagePath?: string | null;
  /** 图片解析函数（旧模式） */
  resolveImageSrc?: (path: string) => string;
  /** 替代文本 */
  alt?: string;
  /** 自定义类名 */
  className?: string;
  /** 自定义样式 */
  style?: React.CSSProperties;
  /** 加载完成回调 */
  onLoad?: (event: React.SyntheticEvent<HTMLImageElement>) => void;
  /** 错误回调 */
  onError?: (error: string) => void;
}

// ============================================================================
// 组件实现
// ============================================================================

/**
 * ExamPageImage - 自动选择新旧模式的整页图片显示组件
 *
 * 根据数据类型自动选择：
 * - 有 blobHash: 使用 getBlobAsDataUrl 获取图片
 * - 无 blobHash: 使用 resolveImageSrc + originalImagePath（旧模式）
 */
export const ExamPageImage: React.FC<ExamPageImageProps> = ({
  blobHash,
  originalImagePath,
  resolveImageSrc,
  alt,
  className,
  style,
  onLoad,
  onError,
}) => {
  const { t } = useTranslation('exam_sheet');
  const resolvedAlt = alt ?? t('image.alt_page');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  // ★ 新模式：使用 blob_hash 获取图片
  useEffect(() => {
    if (!blobHash) {
      setDataUrl(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let mounted = true;

    const loadImage = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const url = await getBlobAsDataUrl(blobHash);
        if (!mounted) return;
        setDataUrl(url);
        setIsLoading(false);
      } catch (err: unknown) {
        if (!mounted) return;
        const errorMsg = getErrorMessage(err);
        setError(errorMsg);
        setIsLoading(false);
        onError?.(errorMsg);
      }
    };

    loadImage();

    return () => {
      mounted = false;
    };
  }, [blobHash, onError]);

  // ★ 新模式：使用 blob_hash
  if (blobHash) {
    // 加载状态
    if (isLoading) {
      return (
        <div className={cn('relative flex items-center justify-center', className)} style={style}>
          <Skeleton className="h-full w-full rounded-lg" />
        </div>
      );
    }

    // 错误状态
    if (error) {
      return (
        <div
          className={cn(
            'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive',
            className
          )}
          style={style}
        >
          <AlertCircle className="h-5 w-5" />
          <span>{error}</span>
        </div>
      );
    }

    // 成功加载
    if (dataUrl) {
      return (
        <img
          src={dataUrl}
          alt={resolvedAlt}
          className={cn('block select-none rounded-lg shadow-lg', className)}
          style={style}
          onLoad={onLoad}
          onError={() => onError?.(t('image.load_failed'))}
        />
      );
    }
  }

  // ★ 旧模式：使用 original_image_path
  if (originalImagePath) {
    const src = resolveImageSrc ? resolveImageSrc(originalImagePath) : originalImagePath;

    return (
      <img
        src={src}
        alt={resolvedAlt}
        className={cn('block select-none rounded-lg shadow-lg', className)}
        style={style}
        onLoad={onLoad}
        onError={() => onError?.(t('image.load_failed'))}
      />
    );
  }

  // 无可用图片
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 p-4 text-sm text-muted-foreground',
        className
      )}
      style={{ minHeight: 200, ...style }}
    >
      <ImageOff className="h-8 w-8" />
      <span>{t('image.no_image')}</span>
    </div>
  );
};

export default ExamPageImage;
