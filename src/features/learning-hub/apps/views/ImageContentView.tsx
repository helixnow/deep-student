/**
 * 图片内容视图
 * 
 * 用于在 Learning Hub 中预览图片附件。
 * 支持缩放、全屏查看等功能。
 * 
 * ★ 2026-02 优化：渐进式加载支持
 * - 小文件（< 10MB）：直接加载 base64
 * - 大文件（>= 10MB）：显示警告，用户确认后加载
 * - 添加加载进度指示
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlassPlus, MagnifyingGlassMinus, ArrowClockwise, ArrowsOut, Warning, Download, CircleNotch, ImageBroken } from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { getErrorMessage } from '@/utils/errorUtils';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { invoke } from '@tauri-apps/api/core';
import { CustomScrollArea } from '@/components/custom-scroll-area';

import { base64ToBlob, base64ToUint8Array } from '@/utils/base64FileUtils';
import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { formatFileSize } from './previewUtils';

/** 图片大文件确认阈值（后端图片上限 50MB；超过 20MB 先提示再加载） */
const IMAGE_LARGE_FILE_THRESHOLD = 20 * 1024 * 1024;

/** 附件元数据类型 */
interface VfsAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  contentHash?: string;
}

/** 加载阶段 */
type LoadingStage = 'idle' | 'checking' | 'loading' | 'done' | 'large_file_warning';

/**
 * 图片内容视图组件
 */
const ImageContentView: React.FC<ContentViewProps> = ({
  node,
  onClose,
}) => {
  const { t } = useTranslation(['learningHub', 'common']);
  
  // 状态
  const [zoom, setZoom] = useState(100);
  const [rotation, setRotation] = useState(0);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [loadingStage, setLoadingStage] = useState<LoadingStage>('idle');
  const [error, setError] = useState<string | null>(null);
  // ★ 2026-06-12（审阅问题 M2）：渲染失败状态（解码失败/系统不支持的格式如 HEIC）
  const [renderFailed, setRenderFailed] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [fileSize, setFileSize] = useState<number>(0);
  const [loadStartTime, setLoadStartTime] = useState<number>(0);
  
  // 用于清理 ObjectURL
  const objectUrlRef = useRef<string | null>(null);
  
  // ★ 驱动加载耗时实时更新
  const [, setTick] = useState(0);
  useEffect(() => {
    if (loadingStage !== 'loading') return;
    const id = setInterval(() => setTick((prev) => prev + 1), 1000);
    return () => clearInterval(id);
  }, [loadingStage]);

  // 从 node 的 metadata 获取图片信息
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const mimeType = (metadata?.mimeType as string) || 'image/png';
  const isLikelyUnsupportedFormat = /heic|heif/i.test(mimeType) || /\.(heic|heif)$/i.test(node.name);

  // 清理 ObjectURL
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) {
        URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = null;
      }
    };
  }, []);

  // 加载图片内容的核心函数
  // ★ 2026-06-12（审阅问题 M2/M10）：base64 → Blob → ObjectURL。
  // 旧实现直接拼 data: URL，base64 字符串与解码位图双份驻留内存，
  // 且 objectUrlRef 清理逻辑形同虚设（从未赋值）。
  const loadImageContent = useCallback(async () => {
    setLoadingStage('loading');
    setLoadStartTime(Date.now());
    setError(null);
    setRenderFailed(false);
    
    try {
      // 调用后端获取附件内容
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
      });
      
      if (result.found && result.content) {
        const blob = base64ToBlob(result.content, mimeType);
        if (!blob) {
          setError(t('learningHub:error.imageDecodeFailed', '图片解码失败'));
          setLoadingStage('idle');
          return;
        }
        const objectUrl = URL.createObjectURL(blob);
        if (objectUrlRef.current) {
          URL.revokeObjectURL(objectUrlRef.current);
        }
        objectUrlRef.current = objectUrl;
        setImageUrl(objectUrl);
        setLoadingStage('done');
      } else {
        setError(t('learningHub:error.imageNotFound', '图片未找到'));
        setLoadingStage('idle');
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err));
      setLoadingStage('idle');
    }
  }, [node.id, mimeType, t]);

  // ★ 保存到本地（渲染失败/大文件场景的逃生通道）
  const handleSaveToDevice = useCallback(async () => {
    setIsSaving(true);
    try {
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
      });
      if (!result?.found || !result?.content) {
        showGlobalNotification('error', t('learningHub:error.imageNotFound', '图片未找到'));
        return;
      }
      const bytes = base64ToUint8Array(result.content);
      if (!bytes) {
        showGlobalNotification('error', t('learningHub:error.imageDecodeFailed', '图片解码失败'));
        return;
      }
      const ext = node.name.includes('.') ? node.name.split('.').pop() || '' : '';
      const saveResult = await fileManager.saveBinaryFile({
        data: bytes,
        defaultFileName: node.name,
        filters: ext ? [{ name: node.name, extensions: [ext] }] : undefined,
      });
      if (!saveResult.canceled && saveResult.path) {
        showGlobalNotification('success', t('learningHub:file.savedSuccessfully', '文件已保存'));
        try {
          const { openPath } = await import('@tauri-apps/plugin-opener');
          await openPath(saveResult.path);
        } catch {
          // 打开失败不阻塞，文件已保存
        }
      }
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }, [node.id, node.name, t]);

  // 初始化：先检查文件大小
  useEffect(() => {
    const checkAndLoad = async () => {
      setLoadingStage('checking');
      setError(null);
      
      try {
        // 先获取附件元数据
        const attachment = await invoke<VfsAttachment | null>('vfs_get_attachment', {
          attachmentId: node.id,
        });
        
        if (!attachment) {
          setError(t('learningHub:error.imageNotFound', '图片未找到'));
          setLoadingStage('idle');
          return;
        }
        
        setFileSize(attachment.size);
        
        // 检查文件大小
        // ★ 2026-06-12（审阅问题 M8）：阈值改为图片专用 20MB。
        // 旧代码用通用 LARGE_FILE_THRESHOLD(100MB)，而图片上传上限远低于此，
        // 警告分支永远不可达。
        if (attachment.size >= IMAGE_LARGE_FILE_THRESHOLD) {
          // 大文件：显示警告，让用户决定是否加载
          setLoadingStage('large_file_warning');
        } else {
          // 小文件：直接加载
          await loadImageContent();
        }
      } catch (err: unknown) {
        setError(getErrorMessage(err));
        setLoadingStage('idle');
      }
    };

    void checkAndLoad();
  }, [node.id, t, loadImageContent]);

  // 缩放控制
  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(prev + 25, 400));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(prev - 25, 25));
  }, []);

  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360);
  }, []);

  const handleReset = useCallback(() => {
    setZoom(100);
    setRotation(0);
  }, []);

  // ★ 鼠标滚轮缩放（Ctrl/Cmd + 滚轮）
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -25 : 25;
    setZoom((prev) => Math.max(25, Math.min(400, prev + delta)));
  }, []);

  // 检查文件大小中
  if (loadingStage === 'checking') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        <p className="text-sm text-muted-foreground">
          {t('learningHub:image.checkingSize', '检查文件大小...')}
        </p>
      </div>
    );
  }

  // 大文件警告
  if (loadingStage === 'large_file_warning') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-6">
        <div className="flex items-center gap-2 text-amber-500">
          <Warning size={32} />
        </div>
        <div className="text-center space-y-2">
          <h3 className="text-lg font-medium">
            {t('learningHub:image.largeFileWarning', '大文件警告')}
          </h3>
          <p className="text-sm text-muted-foreground max-w-md">
            {t(
              'learningHub:image.largeFileDescription',
              '此图片较大 ({{size}})，加载可能需要较长时间并占用较多内存。是否继续加载？',
              { size: formatFileSize(fileSize) }
            )}
          </p>
        </div>
        <div className="flex gap-3 mt-2">
          <NotionButton
            variant="default"
            onClick={() => {
              onClose?.();
            }}
          >
            {t('common:cancel', '取消')}
          </NotionButton>
          <NotionButton
            variant="primary"
            onClick={() => {
              void loadImageContent();
            }}
          >
            {t('learningHub:image.loadAnyway', '继续加载')}
          </NotionButton>
        </div>
      </div>
    );
  }

  // 加载中
  if (loadingStage === 'loading') {
    const elapsed = loadStartTime > 0 ? Math.floor((Date.now() - loadStartTime) / 1000) : 0;
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
        <div className="text-center">
          <p className="text-sm text-muted-foreground">
            {t('learningHub:image.loading', '加载图片中...')}
          </p>
          {fileSize > 0 && (
            <p className="text-xs text-muted-foreground mt-1">
              {formatFileSize(fileSize)}
              {elapsed > 2 && ` · ${elapsed}s`}
            </p>
          )}
        </div>
      </div>
    );
  }

  // 错误
  if (error || !imageUrl) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-muted-foreground">
        <p>{error || t('learningHub:error.imageNotFound', '图片未找到')}</p>
        <NotionButton
          variant="default"
          size="sm"
          onClick={() => {
            void loadImageContent();
          }}
        >
          {t('common:retry', '重试')}
        </NotionButton>
      </div>
    );
  }

  // ★ 2026-06-12（审阅问题 M2）：图片解码/渲染失败（典型如 WebView 不支持 HEIC）。
  // 旧实现没有 onError 处理，失败时只显示一个永远加载不出来的空白裂图。
  if (renderFailed) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 p-6 text-center">
        <ImageBroken size={40} className="text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium">
            {t('learningHub:image.renderFailed', '图片无法显示')}
          </p>
          <p className="text-xs text-muted-foreground max-w-md">
            {isLikelyUnsupportedFormat
              ? t('learningHub:image.unsupportedFormatHint', '当前系统的内置浏览器不支持该格式（如 HEIC/HEIF）。可保存到本地后用系统图片查看器打开。')
              : t('learningHub:image.renderFailedHint', '图片数据可能已损坏或格式不受支持。可尝试保存到本地查看。')}
          </p>
        </div>
        <div className="flex gap-2">
          <NotionButton
            variant="default"
            size="sm"
            onClick={() => {
              void loadImageContent();
            }}
          >
            {t('common:retry', '重试')}
          </NotionButton>
          <NotionButton
            variant="primary"
            size="sm"
            disabled={isSaving}
            onClick={() => {
              void handleSaveToDevice();
            }}
          >
            {isSaving ? <CircleNotch size={14} className="animate-spin" /> : <Download size={14} />}
            <span className="ml-1">{t('learningHub:image.saveToDevice', '保存到本地')}</span>
          </NotionButton>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full bg-background">
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2 border-b bg-muted/30">
        <div className="flex items-center gap-1">
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleZoomOut}
            disabled={zoom <= 25}
            title={t('learningHub:image.zoomOut', '缩小')}
          >
            <MagnifyingGlassMinus size={16} />
          </NotionButton>
          <span className="text-sm text-muted-foreground min-w-[4rem] text-center">
            {zoom}%
          </span>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleZoomIn}
            disabled={zoom >= 400}
            title={t('learningHub:image.zoomIn', '放大')}
          >
            <MagnifyingGlassPlus size={16} />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleRotate}
            title={t('learningHub:image.rotate', '旋转')}
          >
            <ArrowClockwise size={16} />
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleReset}
            title={t('learningHub:image.reset', '重置')}
          >
            <ArrowsOut size={16} />
          </NotionButton>
        </div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <span className="truncate max-w-[200px]">{node.name}</span>
          {fileSize > 0 && (
            <span className="text-xs opacity-70">({formatFileSize(fileSize)})</span>
          )}
        </div>
      </div>

      {/* 图片区域（支持 Ctrl+滚轮缩放） */}
      <CustomScrollArea className="flex-1" viewportClassName="flex items-center justify-center p-4 bg-muted/10" onWheel={handleWheel}>
        <img
          src={imageUrl}
          alt={node.name}
          className="object-contain transition-all duration-200"
          style={{
            width: zoom !== 100 ? `${zoom}%` : undefined,
            maxWidth: zoom > 100 ? 'none' : '100%',
            transform: rotation ? `rotate(${rotation}deg)` : undefined,
          }}
          draggable={false}
          onError={() => setRenderFailed(true)}
        />
      </CustomScrollArea>
    </div>
  );
};

export default ImageContentView;
