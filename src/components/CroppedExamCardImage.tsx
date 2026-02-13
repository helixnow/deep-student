/**
 * CroppedExamCardImage - 使用 Canvas 实时裁剪的题目集题目卡片图片组件
 *
 * ★ 文档25：替代旧的 cropped_image_path 方案
 * 1. 使用 blob_hash 从 VFS blobs 获取整页图片
 * 2. 根据 bbox 使用 Canvas 实时裁剪显示
 * 3. 支持加载状态和错误处理
 *
 * @see 25-题目集识别VFS存储与多模态上下文注入改造.md
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { getBlobAsDataUrl } from '@/chat-v2/context/blobApi';
import { getErrorMessage } from '@/utils/errorUtils';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { AlertCircle, ImageOff } from 'lucide-react';

// ============================================================================
// 类型定义
// ============================================================================

export interface BoundingBox {
  /** X 坐标（归一化 0-1 或像素值） */
  x: number;
  /** Y 坐标（归一化 0-1 或像素值） */
  y: number;
  /** 宽度（归一化 0-1 或像素值） */
  width: number;
  /** 高度（归一化 0-1 或像素值） */
  height: number;
}

export interface CroppedExamCardImageProps {
  /** VFS Blob 哈希（整页图片） */
  blobHash: string;
  /** 整页图片宽度（像素） */
  pageWidth: number;
  /** 整页图片高度（像素） */
  pageHeight: number;
  /** 归一化的裁剪边界框（0-1 范围） */
  bbox: BoundingBox;
  /** 像素级的边界框（可选，优先使用） */
  resolvedBbox?: BoundingBox;
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
 * CroppedExamCardImage - Canvas 裁剪图片组件
 *
 * 使用 Canvas 从整页图片中裁剪出指定区域的题目卡片。
 */
export const CroppedExamCardImage: React.FC<CroppedExamCardImageProps> = ({
  blobHash,
  pageWidth,
  pageHeight,
  bbox,
  resolvedBbox,
  alt = '题目卡片',
  className,
  maxHeight = 200,
  onClick,
  onLoad,
  onError,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [croppedDataUrl, setCroppedDataUrl] = useState<string | null>(null);

  // 计算实际的像素边界框
  const getPixelBbox = useCallback((): BoundingBox => {
    // 如果有 resolvedBbox（像素级），优先使用
    if (resolvedBbox && resolvedBbox.width > 1 && resolvedBbox.height > 1) {
      return resolvedBbox;
    }
    
    // 否则从归一化 bbox 计算像素值
    return {
      x: bbox.x * pageWidth,
      y: bbox.y * pageHeight,
      width: bbox.width * pageWidth,
      height: bbox.height * pageHeight,
    };
  }, [bbox, resolvedBbox, pageWidth, pageHeight]);

  // 加载并裁剪图片
  useEffect(() => {
    let mounted = true;
    const abortController = new AbortController();

    const loadAndCrop = async () => {
      if (!blobHash) {
        setError('缺少图片哈希');
        setIsLoading(false);
        return;
      }

      try {
        setIsLoading(true);
        setError(null);

        // 1. 从 VFS blobs 获取整页图片
        const dataUrl = await getBlobAsDataUrl(blobHash);
        
        if (!mounted) return;

        // 2. 加载图片到 Image 对象
        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('图片加载失败'));
          img.src = dataUrl;
        });

        if (!mounted) return;

        // 3. 计算裁剪区域
        const pixelBbox = getPixelBbox();
        
        // 边界检查
        const srcX = Math.max(0, Math.floor(pixelBbox.x));
        const srcY = Math.max(0, Math.floor(pixelBbox.y));
        const srcW = Math.min(Math.ceil(pixelBbox.width), img.width - srcX);
        const srcH = Math.min(Math.ceil(pixelBbox.height), img.height - srcY);

        if (srcW <= 0 || srcH <= 0) {
          throw new Error('无效的裁剪区域');
        }

        // 4. 使用 Canvas 裁剪
        const canvas = document.createElement('canvas');
        canvas.width = srcW;
        canvas.height = srcH;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          throw new Error('Canvas 上下文创建失败');
        }

        ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);

        // 5. 导出裁剪后的图片
        const croppedUrl = canvas.toDataURL('image/jpeg', 0.92);
        
        if (!mounted) return;

        setCroppedDataUrl(croppedUrl);
        setIsLoading(false);
        onLoad?.();

      } catch (err: unknown) {
        if (!mounted) return;
        const errorMsg = getErrorMessage(err);
        setError(errorMsg);
        setIsLoading(false);
        onError?.(errorMsg);
      }
    };

    loadAndCrop();

    return () => {
      mounted = false;
      abortController.abort();
    };
  }, [blobHash, getPixelBbox, onLoad, onError]);

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('relative flex items-center justify-center', className)}>
        <Skeleton 
          className="w-full rounded-lg" 
          style={{ height: typeof maxHeight === 'number' ? maxHeight : maxHeight }}
        />
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
        style={{ minHeight: 100 }}
      >
        <AlertCircle className="h-5 w-5" />
        <span>{error}</span>
      </div>
    );
  }

  // 无图片状态
  if (!croppedDataUrl) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-muted-foreground/30 bg-muted/20 p-4 text-sm text-muted-foreground',
          className
        )}
        style={{ minHeight: 100 }}
      >
        <ImageOff className="h-5 w-5" />
        <span>图片不可用</span>
      </div>
    );
  }

  // 正常显示
  return (
    <img
      src={croppedDataUrl}
      alt={alt}
      className={cn('rounded-lg object-contain', className, onClick && 'cursor-pointer')}
      style={{ maxHeight: typeof maxHeight === 'number' ? `${maxHeight}px` : maxHeight }}
      onClick={onClick}
    />
  );
};

// ============================================================================
// 辅助 Hook
// ============================================================================

/**
 * useCroppedImage - 裁剪图片 Hook（用于需要编程式访问裁剪结果的场景）
 */
export function useCroppedImage(
  blobHash: string | undefined,
  pageWidth: number,
  pageHeight: number,
  bbox: BoundingBox | undefined,
  resolvedBbox?: BoundingBox
) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!blobHash || !bbox) {
      setDataUrl(null);
      return;
    }

    let mounted = true;

    const load = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const fullDataUrl = await getBlobAsDataUrl(blobHash);
        
        if (!mounted) return;

        const img = new Image();
        img.crossOrigin = 'anonymous';
        
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('图片加载失败'));
          img.src = fullDataUrl;
        });

        if (!mounted) return;

        // 计算裁剪区域
        const pixelBbox = resolvedBbox && resolvedBbox.width > 1
          ? resolvedBbox
          : {
              x: bbox.x * pageWidth,
              y: bbox.y * pageHeight,
              width: bbox.width * pageWidth,
              height: bbox.height * pageHeight,
            };

        const canvas = document.createElement('canvas');
        const srcX = Math.max(0, Math.floor(pixelBbox.x));
        const srcY = Math.max(0, Math.floor(pixelBbox.y));
        const srcW = Math.min(Math.ceil(pixelBbox.width), img.width - srcX);
        const srcH = Math.min(Math.ceil(pixelBbox.height), img.height - srcY);

        canvas.width = srcW;
        canvas.height = srcH;
        
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, srcX, srcY, srcW, srcH, 0, 0, srcW, srcH);
          setDataUrl(canvas.toDataURL('image/jpeg', 0.92));
        }

        setIsLoading(false);
      } catch (err: unknown) {
        if (!mounted) return;
        setError(getErrorMessage(err));
        setIsLoading(false);
      }
    };

    load();

    return () => {
      mounted = false;
    };
  }, [blobHash, pageWidth, pageHeight, bbox, resolvedBbox]);

  return { dataUrl, isLoading, error };
}

export default CroppedExamCardImage;
