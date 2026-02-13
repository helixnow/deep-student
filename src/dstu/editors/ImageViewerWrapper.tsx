/**
 * 图片查看器包装组件
 *
 * 将图片显示包装为符合 DSTU EditorProps 接口的组件。
 *
 * @see 21-VFS虚拟文件系统架构设计.md 第四章 4.8
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, AlertCircle, Image as ImageIcon, ZoomIn, ZoomOut, RotateCw, RefreshCw } from 'lucide-react';
import type { EditorProps, CreateEditorProps } from '../editorTypes';
import { pathUtils } from '../utils/pathUtils';
import { dstu } from '../api';
import { cn } from '@/lib/utils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CustomScrollArea } from '@/components/custom-scroll-area';

/**
 * 图片查看器包装组件
 *
 * 通过 DSTU API 加载图片数据。
 */
export const ImageViewerWrapper: React.FC<EditorProps | CreateEditorProps> = (props) => {
  const { t } = useTranslation(['dstu', 'common']);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  // 判断是否为创建模式（图片不支持创建模式）
  const isCreateMode = 'mode' in props && props.mode === 'create';

  // 解析路径获取信息
  const pathInfo = !isCreateMode && 'path' in props ? pathUtils.parse(props.path) : null;

  // 解析路径用于加载
  const path = !isCreateMode && 'path' in props ? props.path : null;

  // 用于清理 blob URL 的 ref
  const currentUrlRef = React.useRef<string | null>(null);

  // 加载图片
  const loadImage = useCallback(async () => {
    if (isCreateMode) {
      setError(t('dstu:errors.internal'));
      setIsLoading(false);
      return;
    }

    if (!path) return;

    setIsLoading(true);
    setError(null);

    const result = await dstu.getContent(path);
    setIsLoading(false);

    if (result.ok) {
      const content = result.value;
      // 清理之前的 blob URL
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
        currentUrlRef.current = null;
      }
      if (content instanceof Blob) {
        const newUrl = URL.createObjectURL(content);
        currentUrlRef.current = newUrl;
        setImageUrl(newUrl);
      } else if (typeof content === 'string' && content.startsWith('data:')) {
        setImageUrl(content);
      } else {
        setImageUrl(null);
      }
    } else {
      const errMsg = result.error.toUserMessage();
      setError(errMsg);
      showGlobalNotification('error', errMsg);
    }
  }, [isCreateMode, path, t]);

  useEffect(() => {
    void loadImage();

    return () => {
      if (currentUrlRef.current) {
        URL.revokeObjectURL(currentUrlRef.current);
      }
    };
  }, [loadImage]);

  // 缩放控制
  const handleZoomIn = () => setZoom((z) => Math.min(z + 0.25, 3));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 0.25, 0.25));
  const handleRotate = () => setRotation((r) => (r + 90) % 360);

  // 加载状态
  if (isLoading) {
    return (
      <div className={cn('flex items-center justify-center h-full py-8', props.className)}>
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        <span className="ml-2 text-muted-foreground">{t('dstu:preview.loading')}</span>
      </div>
    );
  }

  // 错误状态
  if (error) {
    const onClose = 'onClose' in props ? props.onClose : undefined;
    return (
      <div className={cn('flex flex-col items-center justify-center h-full py-8 gap-4', props.className)}>
        <AlertCircle className="w-8 h-8 text-destructive" />
        <span className="text-destructive text-center max-w-md">{error}</span>
        <div className="flex gap-2">
          <button
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            onClick={() => void loadImage()}
          >
            <RefreshCw className="w-4 h-4" />
            {t('common:actions.retry')}
          </button>
          {onClose && (
            <button
              className="px-4 py-2 border rounded-md hover:bg-muted"
              onClick={onClose}
            >
              {t('common:actions.close')}
            </button>
          )}
        </div>
      </div>
    );
  }

  // 图片查看器 UI
  return (
    <div className={cn('flex flex-col h-full', props.className)}>
      {/* 工具栏 */}
      <div className="flex-shrink-0 flex items-center justify-between px-4 py-2 bg-muted/50 border-b">
        <div className="flex items-center gap-2">
          <ImageIcon className="w-5 h-5 text-muted-foreground" />
          <span className="text-sm font-medium">{pathInfo?.id || t('dstu:types.image')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            className="p-1.5 hover:bg-muted rounded-md"
            onClick={handleZoomOut}
            title={t('common:zoomOut')}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-muted-foreground min-w-[3rem] text-center">
            {Math.round(zoom * 100)}%
          </span>
          <button
            className="p-1.5 hover:bg-muted rounded-md"
            onClick={handleZoomIn}
            title={t('common:zoomIn')}
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            className="p-1.5 hover:bg-muted rounded-md ml-2"
            onClick={handleRotate}
            title={t('common:rotate')}
          >
            <RotateCw className="w-4 h-4" />
          </button>
          {'onClose' in props && props.onClose && (
            <button
              className="px-3 py-1 text-sm border rounded-md hover:bg-muted ml-2"
              onClick={props.onClose}
            >
              {t('common:actions.close')}
            </button>
          )}
        </div>
      </div>

      {/* 图片内容 */}
      <CustomScrollArea className="flex-1 flex items-center justify-center bg-muted/20" viewportClassName="p-4">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={pathInfo?.id || 'image'}
            className="max-w-full max-h-full object-contain transition-transform"
            style={{
              transform: `scale(${zoom}) rotate(${rotation}deg)`,
            }}
          />
        ) : (
          <div className="text-center">
            <ImageIcon className="w-16 h-16 mx-auto mb-4 text-muted-foreground/50" />
            <p className="text-muted-foreground">
              {t('dstu:preview.noImage')}
            </p>
          </div>
        )}
      </CustomScrollArea>
    </div>
  );
};

export default ImageViewerWrapper;
