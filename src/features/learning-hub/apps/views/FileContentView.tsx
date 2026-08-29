/**
 * 文件内容视图
 * 
 * 用于在 Learning Hub 中预览文档附件（PDF、DOCX、XLSX 等）。
 * 根据文件类型路由到不同的预览组件：
 * - DOCX: 富文本预览（docx-preview）
 * - XLSX: 表格预览（ExcelJS）
 * - PPTX: 演示文稿预览（pptx-preview）
 * - 其他: 纯文本预览
 * 
 * 统一工具栏架构：
 * - 缩放控制：所有预览类型
 * - 字号控制：仅 DOCX/XLSX
 * - 使用 PreviewContext 统一管理预览状态
 * - 使用 UnifiedPreviewToolbar 显示控制项
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch } from '@phosphor-icons/react';
import type { ContentViewProps } from '../UnifiedAppPanel';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { PreviewProvider, usePreviewContext, type PreviewType } from './PreviewContext';
import type { ToolbarPreviewType } from './UnifiedPreviewToolbar';
import { usePdfLoader } from '@/hooks/usePdfLoader';
import { usePdfFocusListener } from './usePdfFocusListener';
import {
  base64ToBlob,
  estimateBase64Size,
  LARGE_FILE_THRESHOLD,
  uint8ArrayToBase64,
} from '@/utils/base64FileUtils';
import { getErrorMessage } from '@/utils/errorUtils';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { archiveManifestDisplayText, isArchiveManifestText } from './archiveManifest';
import { saveFiltersForFileName, saveResourceToDevice } from './saveResourceToDevice';
import { CustomScrollArea } from '@/components/custom-scroll-area';

// PDF 预览组件
import {
  TextbookPdfViewer,
  type Bookmark,
  type ReadingProgress,
} from '@/features/pdf/components/TextbookPdfViewer';
import { resolveFilePreviewMode } from './filePreviewResolver';
import { formatFileSize } from './previewUtils';
import { RichDocumentPreview } from './RichDocumentPreview';
import { TextFilePreview } from './TextFilePreview';
import EpubPreview from './EpubPreview';
import { loadTextPreviewContent } from './textPreviewLoader';
import {
  isLikelyUnsupportedMedia,
  resolveAudioMimeType,
  resolveVideoMimeType,
} from './mediaPreviewUtils';
import { PreviewStatus } from './PreviewStatus';
import { AudioPlayer, VideoPlayer } from './media';
import { createPreviewPersistController } from './previewPersistence';
import { useReferenceToChat } from '@/features/learning-hub/useReferenceToChat';
import {
  buildSelectionLocator,
  type PdfSelectionPayload,
} from '@/features/pdf/pdfSelectionActions';

/** 加载指示延迟：对齐 UnifiedAppPanel 的 150ms 策略，快速加载不闪 spinner */
const LOADING_INDICATOR_DELAY_MS = 150;

/**
 * 媒体源描述
 * - stream: filestream:// 自定义协议流式播放（不进内存）
 * - blob:   整文件读入内存后的 blob URL（流式不可用时的回退方案）
 */
interface MediaSourceState {
  url: string;
  kind: 'stream' | 'blob';
}

/**
 * 将文件预览模式映射到 PreviewContext 类型
 */
const toContextPreviewType = (mode: ReturnType<typeof resolveFilePreviewMode>): PreviewType => {
  if (mode === 'docx' || mode === 'xlsx' || mode === 'pptx' || mode === 'text') {
    return mode;
  }
  return null;
};

/**
 * 将 PreviewType 转换为 ToolbarPreviewType
 */
const toToolbarPreviewType = (type: PreviewType): ToolbarPreviewType => {
  if (type === 'docx' || type === 'xlsx' || type === 'pptx' || type === 'image' || type === 'text') {
    return type;
  }
  return 'other';
};

/**
 * 文件内容视图内部组件
 * 包含主要逻辑，使用 PreviewContext 管理预览状态
 */
const FileContentViewInner: React.FC<ContentViewProps> = ({
  node,
  isActive = true,
  // onClose 暂未使用，保留接口以便后续扩展
}) => {
  const { t } = useTranslation(['learningHub', 'common', 'pdf']);
  
  // 从 PreviewContext 获取状态和方法
  const {
    zoomScale,
    fontScale,
    previewType,
    setZoomScale,
    setFontScale,
    resetZoom,
    resetFont,
    setPreviewType,
  } = usePreviewContext();
  
  // 状态
  const [textContent, setTextContent] = useState<string | null>(null);
  const [base64Content, setBase64Content] = useState<string | null>(null);
  const [mediaSource, setMediaSource] = useState<MediaSourceState | null>(null);
  // filestream 播放失败（协议/解码问题）后置 true，回退到 blob URL 方案
  const [streamBlocked, setStreamBlocked] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPreviewTooLarge, setIsPreviewTooLarge] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [mediaRenderFailed, setMediaRenderFailed] = useState(false);

  // ★ isActive 门控：非活跃标签页不响应全局事件（pdf-page-refs 清除等）
  const isActiveRef = useRef(isActive);
  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  // 从 node 的 metadata 获取文件信息
  const metadata = node.metadata as Record<string, unknown> | undefined;
  const mimeType = (metadata?.mimeType as string) || 'application/octet-stream';
  const contentHash = (metadata?.contentHash as string) || '';

  // 解析文件预览模式
  const previewMode = resolveFilePreviewMode(mimeType, node.name, node.previewType);
  const isDocx = previewMode === 'docx';
  const isExcel = previewMode === 'xlsx';
  const isPptx = previewMode === 'pptx';
  const isEpub = previewMode === 'epub';
  const isPdf = previewMode === 'pdf';
  const isAudio = previewMode === 'audio';
  const isVideo = previewMode === 'video';
  const needsRichPreview = isDocx || isExcel || isPptx;
  const needsBinaryPreview = needsRichPreview || isEpub || isAudio || isVideo;
  const canPreviewText = previewMode === 'text';
  // ★ 2026-07-20：压缩包兜底预览——zip 导入时后端已生成条目清单（extracted_text），
  // 预览页尝试加载清单只读展示；rar/7z 无解析依赖，仅展示说明文案
  const archiveExt = (node.name.split('.').pop() || '').toLowerCase();
  const isArchive = previewMode === 'none' && ['zip', 'rar', '7z'].includes(archiveExt);

  // 使用统一的 PDF 加载 Hook（支持缓存、去重、大文件检测）
  const {
    file: pdfFile,
    filePath: pdfFilePath,
    loading: pdfLoading,
    error: pdfError,
    isLargeFile: isPdfLargeFile,
    retry: retryPdfLoad,
  } = usePdfLoader({
    nodeId: node.id,
    fileName: node.name,
    cacheKey: `${node.id}:${node.updatedAt || ''}`,
    enabled: isPdf,
  });
  
  // PDF 页面选择状态
  const [selectedPages, setSelectedPages] = useState<Set<number>>(new Set());
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  // ★ File PDF persist：仅 dstu.setMetadata（见 previewPersistence NOTE(backend)）
  const nodePathRef = useRef(node.path);
  const nodeIdRef = useRef(node.id);
  const nodeMetadataRef = useRef(node.metadata as Record<string, unknown> | undefined);
  useEffect(() => {
    nodePathRef.current = node.path;
    nodeIdRef.current = node.id;
    nodeMetadataRef.current = node.metadata as Record<string, unknown> | undefined;
  }, [node.path, node.id, node.metadata]);

  const persistControllerRef = useRef(
    createPreviewPersistController({
      kind: 'file',
      nodeId: node.id,
      nodePath: node.path,
      // ★ 创建时快照（白名单提取），dispose flush 不回读活 ref
      metadata: node.metadata as Record<string, unknown> | undefined,
    }),
  );

  // ★ R2：切换资源时在 render 阶段同步重置内容状态（组件实例跨节点复用）。
  // 仅靠 effect 重置会让"新节点 + 旧内容"先渲染一帧（如 md 内容被当作新文件名的 csv 解析）；
  // PDF 页面选择同理，避免上一个 PDF 的选择残留到新文件。
  const [prevNodeId, setPrevNodeId] = useState(node.id);
  if (prevNodeId !== node.id) {
    setPrevNodeId(node.id);
    setTextContent(null);
    setBase64Content(null);
    setMediaSource(null); // 旧 blob URL 由 [mediaSource] 清理 effect 释放
    setStreamBlocked(false);
    setError(null);
    setIsPreviewTooLarge(false);
    setMediaRenderFailed(false);
    setSelectedPages(new Set());
    const nextBookmarks = (node.metadata as Record<string, unknown> | undefined)?.bookmarks as Bookmark[] | undefined;
    setBookmarks(Array.isArray(nextBookmarks) ? nextBookmarks : []);
  }

  const readingProgress = useMemo<ReadingProgress | undefined>(() => {
    const progress = (node.metadata as Record<string, unknown> | undefined)?.readingProgress as
      | { page?: number; lastReadAt?: number }
      | undefined;
    if (progress && typeof progress.page === 'number' && progress.page > 0) {
      return { page: progress.page, lastReadAt: progress.lastReadAt };
    }
    return undefined;
  }, [node.metadata]);

  useEffect(() => {
    const saved = (node.metadata as Record<string, unknown> | undefined)?.bookmarks as Bookmark[] | undefined;
    if (saved && Array.isArray(saved)) {
      setBookmarks(saved);
    } else {
      setBookmarks([]);
    }
  }, [node.metadata]);

  // node 切换时 flush 旧控制器再换新；unmount 时 dispose。
  // 旧控制器 dispose 用创建时快照，不读已指向新 node 的活 ref。
  useEffect(() => {
    persistControllerRef.current.dispose();
    persistControllerRef.current = createPreviewPersistController({
      kind: 'file',
      nodeId: nodeIdRef.current,
      nodePath: nodePathRef.current,
      metadata: nodeMetadataRef.current,
    });
    return () => {
      persistControllerRef.current.dispose();
    };
  }, [node.id]);

  const handleProgressChange = useCallback((progress: ReadingProgress) => {
    persistControllerRef.current.scheduleProgress(progress);
  }, []);

  const handleBookmarksChange = useCallback((newBookmarks: Bookmark[]) => {
    setBookmarks(newBookmarks);
    persistControllerRef.current.scheduleBookmarks(newBookmarks);
  }, []);

  // 划词「引用到对话」：selectedText + 页码 locator 随资源引用进入会话上下文
  const { referenceToChat } = useReferenceToChat();
  const handleQuoteToChat = useCallback((payload: PdfSelectionPayload) => {
    void referenceToChat({
      sourceType: 'file',
      sourceId: node.sourceId || node.id,
      metadata: {
        title: node.name,
        selectedText: payload.text,
        locator: buildSelectionLocator(payload.page),
      },
    });
  }, [referenceToChat, node.sourceId, node.id, node.name]);

  // ★ 使用共享 Hook 监听 PDF 页码跳转事件
  const [focusRequest, handleFocusHandled] = usePdfFocusListener({
    enabled: isPdf,
    nodeId: node.id,
    nodeSourceId: node.sourceId,
    nodePath: node.path,
    nodeName: node.name,
  });

  // 处理页面选择变化 + 广播给 Chat InputBar
  const handlePageSelectionChange = useCallback((pages: Set<number>) => {
    setSelectedPages(pages);
    document.dispatchEvent(new CustomEvent('pdf-page-refs:update', {
      detail: {
        sourceId: node.sourceId,
        sourceName: node.name,
        pages: Array.from(pages).sort((a, b) => a - b),
      },
    }));
  }, [node.sourceId, node.name]);

  // 监听 Chat 侧发来的清除/移除选择事件
  // ★ 标签页：通过 sourceId 过滤，避免多个 PDF tab 互相干扰
  useEffect(() => {
    const handleClear = (event: Event) => {
      // ★ 非活跃标签页不响应全局清除事件
      if (!isActiveRef.current) return;
      const detail = (event as CustomEvent<{ sourceId?: string }>).detail;
      if (detail?.sourceId && detail.sourceId !== node.sourceId) return;
      setSelectedPages(new Set());
    };
    const handleRemove = (event: Event) => {
      if (!isActiveRef.current) return;
      const detail = (event as CustomEvent<{ page: number; sourceId?: string }>).detail;
      if (detail?.sourceId && detail.sourceId !== node.sourceId) return;
      setSelectedPages((prev) => {
        const next = new Set(prev);
        next.delete(detail.page);
        return next;
      });
    };
    document.addEventListener('pdf-page-refs:clear', handleClear);
    document.addEventListener('pdf-page-refs:remove', handleRemove);
    return () => {
      document.removeEventListener('pdf-page-refs:clear', handleClear);
      document.removeEventListener('pdf-page-refs:remove', handleRemove);
      // ★ 卸载（关闭 tab）时广播空选择，避免聊天 chips 残留指向已关闭的 PDF
      document.dispatchEvent(new CustomEvent('pdf-page-refs:update', {
        detail: { sourceId: node.sourceId, sourceName: '', pages: [] },
      }));
    };
  }, [node.sourceId]);

  // 稳定的空回调（避免每次渲染创建新函数）
  const noopExportPages = useCallback(() => {}, []);

  // 根据文件类型设置 previewType
  useEffect(() => {
    setPreviewType(toContextPreviewType(previewMode));
  }, [previewMode, setPreviewType]);

  // Blob URL 生命周期：每次 mediaSource 变化（含卸载）时释放旧 blob URL
  // （filestream URL 无需释放，由自定义协议按需读取）
  useEffect(() => {
    return () => {
      if (mediaSource?.kind === 'blob') {
        URL.revokeObjectURL(mediaSource.url);
      }
    };
  }, [mediaSource]);

  // ★ 用于手动重试的计数器（重试时给 filestream 重新一次机会）
  const [retryCount, setRetryCount] = useState(0);
  const handleRetry = useCallback(() => {
    setStreamBlocked(false);
    setRetryCount((c) => c + 1);
  }, []);

  // ★ 播放器错误：stream 播放失败 → 回退 blob 方案重新加载；blob 也失败 → 错误态
  const mediaSourceKindRef = useRef<MediaSourceState['kind'] | null>(null);
  useEffect(() => {
    mediaSourceKindRef.current = mediaSource?.kind ?? null;
  }, [mediaSource]);

  const handleMediaError = useCallback(() => {
    if (mediaSourceKindRef.current === 'stream') {
      setStreamBlocked(true); // 触发加载 effect 重跑，走 blob 回退
    } else {
      setMediaRenderFailed(true);
    }
  }, []);

  // ★ L-008 修复：文件过大时提供"保存到本地"操作
  // 共享双通道（saveResourceToDevice）：blob 直拷贝优先，legacy 内联回退 base64
  const handleSaveFile = useCallback(async () => {
    setIsSaving(true);
    try {
      const saveResult = await saveResourceToDevice({
        nodeId: node.id,
        fileName: node.name,
        filters: saveFiltersForFileName(node.name),
        notFoundMessage: t('learningHub:file.loadFailed'),
        openAfterSave: true,
      });
      if (!saveResult.canceled && saveResult.path) {
        showGlobalNotification('success', t('learningHub:file.savedSuccessfully'));
      }
    } catch (err: unknown) {
      showGlobalNotification('error', getErrorMessage(err));
    } finally {
      setIsSaving(false);
    }
  }, [node.id, node.name, t]);

  // 加载文件内容
  useEffect(() => {
    let isMounted = true;

    const loadTextContent = async () => {
      try {
        const content = await loadTextPreviewContent({
          nodeId: node.id,
          fileName: node.name,
          contentHash,
        });
        if (!isMounted) return;
        // 空字符串是合法内容（空文件），由 TextFilePreview 渲染空状态
        if (content !== null) {
          setTextContent(content);
        } else {
          setError(t('learningHub:file.contentNotFound', { id: node.id }));
        }
      } catch (textErr: unknown) {
        console.warn('[FileContentView] loadTextContent failed:', textErr);
        if (isMounted) {
          setError(getErrorMessage(textErr));
        }
      }
    };

    const loadBinaryContent = async () => {
      const blobPath = await invoke<string | null>('vfs_get_file_blob_path', { id: node.id });
      if (!isMounted) return;

      if (blobPath) {
        // ★ 音视频：优先 filestream:// 流式协议（零内存拷贝），
        //   协议不可用 / check 失败 / 播放失败（streamBlocked）时回退 blob URL
        if (isAudio || isVideo) {
          const mediaMimeType = isAudio
            ? resolveAudioMimeType(mimeType, node.name)
            : resolveVideoMimeType(mimeType, node.name);

          if (!streamBlocked) {
            try {
              const canStream = await invoke<boolean>('filestream_check_access', {
                path: blobPath,
              });
              if (!isMounted) return;
              if (canStream) {
                // VFS blob 落盘为 <hash>.bin，协议按扩展名只能推断出 octet-stream；
                // 通过 ?mime= 覆盖告知真实媒体类型（WKWebView 对 Content-Type 敏感）。
                // 仅取主类型：后端 sanitize 拒绝含 ';codecs=' 参数的覆盖值。
                const mimeParam = encodeURIComponent(
                  (mediaMimeType.split(';')[0] ?? '').trim(),
                );
                setMediaSource({
                  url: `${convertFileSrc(blobPath, 'filestream')}?mime=${mimeParam}`,
                  kind: 'stream',
                });
                return;
              }
            } catch {
              // filestream 协议与本次改动并行落地，不可假设已存在；异常时静默回退
            }
            if (!isMounted) return;
          }

          const mediaFileSize = await invoke<number>('get_file_size', { path: blobPath });
          if (!isMounted) return;
          if (mediaFileSize > LARGE_FILE_THRESHOLD) {
            setError(t('learningHub:file.previewTooLarge'));
            setIsPreviewTooLarge(true);
            return;
          }

          const mediaBuffer = await invoke<ArrayBuffer>('read_file_bytes', { path: blobPath });
          if (!isMounted) return;
          // ★ 音视频不再另存 base64（无消费方），避免双份内存
          setMediaSource({
            url: URL.createObjectURL(new Blob([mediaBuffer], { type: mediaMimeType })),
            kind: 'blob',
          });
          return;
        }

        const fileSize = await invoke<number>('get_file_size', { path: blobPath });
        if (!isMounted) return;
        if (fileSize > LARGE_FILE_THRESHOLD) {
          setError(t('learningHub:file.previewTooLarge'));
          setIsPreviewTooLarge(true);
          return;
        }

        const buffer = await invoke<ArrayBuffer>('read_file_bytes', { path: blobPath });
        if (!isMounted) return;
        setBase64Content(uint8ArrayToBase64(new Uint8Array(buffer)));
        return;
      }

      // Legacy inline resources have no blob path. Keep the compatibility
      // fallback, guarded by the database metadata size check above.
      const result = await invoke<{ content: string | null; found: boolean }>('vfs_get_attachment_content', {
        attachmentId: node.id,
        maxBytes: LARGE_FILE_THRESHOLD,
      });

      if (!isMounted) return;

      if (result?.found && result?.content) {
        const estimatedSize = estimateBase64Size(result.content);
        if (estimatedSize > LARGE_FILE_THRESHOLD) {
          setError(t('learningHub:file.previewTooLarge'));
          setIsPreviewTooLarge(true);
          return;
        }

        if (isAudio || isVideo) {
          const mediaMimeType = isAudio
            ? resolveAudioMimeType(mimeType, node.name)
            : resolveVideoMimeType(mimeType, node.name);
          const mediaBlob = base64ToBlob(result.content, mediaMimeType);

          if (!mediaBlob) {
            setError(t('learningHub:file.mediaDecodeFailed'));
            return;
          }

          // ★ 音视频不再另存 base64；旧 URL 由 [mediaSource] 清理 effect 统一释放
          setMediaSource({ url: URL.createObjectURL(mediaBlob), kind: 'blob' });
          return;
        }

        setBase64Content(result.content);
        return;
      }

      setError(t('learningHub:file.contentNotFound', { id: node.id }));
    };

    const loadContent = async () => {
      // 重置状态（切换资源时清除上一个文件的残留；旧 blob URL 由清理 effect 释放）
      setError(null);
      setIsPreviewTooLarge(false);
      setTextContent(null);
      setBase64Content(null);
      setMediaRenderFailed(false);
      setMediaSource(null);

      // ★ 压缩包：尝试加载后端生成的条目清单（zip 导入时写入 extracted_text）
      if (isArchive) {
        setIsLoading(true);
        try {
          const manifest = await loadTextPreviewContent({
            nodeId: node.id,
            fileName: node.name,
            contentHash,
          });
          if (!isMounted) return;
          // 仅当返回的是清单文本时展示（识别走机器标记，含 legacy 中文前缀兼容）
          if (manifest && isArchiveManifestText(manifest)) {
            setTextContent(archiveManifestDisplayText(manifest));
          }
        } catch (archiveErr: unknown) {
          console.warn('[FileContentView] load archive manifest failed:', archiveErr);
        } finally {
          if (isMounted) setIsLoading(false);
        }
        return;
      }

      // PDF 有独立的加载 Hook；不可预览类型无需加载 → 跳过，避免无意义的 loading 闪烁
      if (!needsBinaryPreview && !canPreviewText) {
        return;
      }

      setIsLoading(true);
      try {
        const knownSize = typeof node.size === 'number' ? node.size : null;
        // ★ 音视频不做入口大小拦截：filestream 流式播放不受大小限制，
        //   仅在流式不可用、回退整读内存时再做阈值检查（见 loadBinaryContent）
        if (
          needsBinaryPreview &&
          !isAudio &&
          !isVideo &&
          knownSize &&
          knownSize > LARGE_FILE_THRESHOLD
        ) {
          setError(t('learningHub:file.previewTooLarge'));
          setIsPreviewTooLarge(true);
          return;
        }

        if (needsBinaryPreview) {
          await loadBinaryContent();
        } else {
          await loadTextContent();
        }
      } catch (err: unknown) {
        // 🔒 审计修复: 二进制加载失败时设置错误状态（原代码静默吞掉）
        // （loadTextContent 内部自带 try/catch，此处仅捕获二进制加载异常）
        if (isMounted) {
          setError(getErrorMessage(err));
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    void loadContent();

    return () => {
      isMounted = false;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- t 不加入依赖：语言切换不应重新加载文件；retryCount 用于手动重试；streamBlocked 触发流式→blob 回退重载
  }, [
    canPreviewText,
    contentHash,
    isArchive,
    isAudio,
    isVideo,
    mimeType,
    needsBinaryPreview,
    node.id,
    node.name,
    node.size,
    retryCount,
    streamBlocked,
  ]);
  const showToolbar = Boolean(needsRichPreview && base64Content && previewType);

  const renderRichDocumentPreview = (
    kind: 'docx' | 'xlsx' | 'pptx',
    content: string
  ) => (
    <RichDocumentPreview
      kind={kind}
      base64Content={content}
      fileName={node.name}
      showToolbar={showToolbar}
      previewType={toToolbarPreviewType(previewType)}
      zoomScale={zoomScale}
      fontScale={fontScale}
      onZoomChange={setZoomScale}
      onFontChange={setFontScale}
      onZoomReset={resetZoom}
      onFontReset={resetFont}
      fallback={<div className="flex items-center justify-center h-full"><CircleNotch className="h-8 w-8 animate-spin text-primary" /></div>}
    />
  );

  // 渲染内容
  const renderContent = () => {
    if (error) {
      return (
        <PreviewStatus
          tone="error"
          title={error}
          meta={
            isPreviewTooLarge && typeof node.size === 'number' && node.size > 0
              ? `${node.name} · ${formatFileSize(node.size)}`
              : undefined
          }
          actions={[
            ...(isPreviewTooLarge
              ? [{
                  id: 'save',
                  label: t('learningHub:file.saveToDevice'),
                  onClick: () => { void handleSaveFile(); },
                  variant: 'primary' as const,
                  loading: isSaving,
                }]
              : []),
            {
              id: 'retry',
              label: t('common:retry'),
              onClick: handleRetry,
              variant: 'ghost' as const,
            },
          ]}
        />
      );
    }
    if (isLoading) {
      return (
        <PreviewStatus
          tone="loading"
          title={t('learningHub:loading.content')}
          delayMs={LOADING_INDICATOR_DELAY_MS}
        />
      );
    }

    // PDF 预览
    if (isPdf) {
      if (pdfLoading) {
        return (
          <PreviewStatus
            tone="loading"
            title={t('learningHub:loading.content')}
            description={isPdfLargeFile ? t('learningHub:file.loadingLargeFile') : undefined}
            delayMs={LOADING_INDICATOR_DELAY_MS}
          />
        );
      }
      if (pdfError) {
        return (
          <PreviewStatus
            tone="error"
            title={pdfError}
            actions={[
              {
                id: 'retry',
                label: t('common:retry'),
                onClick: retryPdfLoad,
                variant: 'ghost',
              },
            ]}
          />
        );
      }
      if (pdfFile || pdfFilePath) {
        return (
          <TextbookPdfViewer
            file={pdfFile}
            filePath={pdfFilePath || ''}
            fileName={node.name}
            selectedPages={selectedPages}
            onPageSelectionChange={handlePageSelectionChange}
            onExportSelectedPages={noopExportPages}
            enableAutoPrepare={false}
            focusRequest={focusRequest}
            onFocusHandled={handleFocusHandled}
            resourcePath={node.path}
            readingProgress={readingProgress}
            onProgressChange={handleProgressChange}
            bookmarks={bookmarks}
            onBookmarksChange={handleBookmarksChange}
            onQuoteToChat={handleQuoteToChat}
          />
        );
      }
      // 正在等待加载
      return (
        <PreviewStatus
          tone="loading"
          title={t('learningHub:loading.content')}
          delayMs={LOADING_INDICATOR_DELAY_MS}
        />
      );
    }

    // DOCX / Excel / PPTX 富文档预览（ui-rise-in 轻量淡入，避免二进制解码完成后的生硬切换）
    if (isDocx && base64Content) {
      return <div className="h-full ui-rise-in">{renderRichDocumentPreview('docx', base64Content)}</div>;
    }
    if (isExcel && base64Content) {
      return <div className="h-full ui-rise-in">{renderRichDocumentPreview('xlsx', base64Content)}</div>;
    }
    if (isPptx && base64Content) {
      return <div className="h-full ui-rise-in">{renderRichDocumentPreview('pptx', base64Content)}</div>;
    }
    if (isEpub && base64Content) {
      return (
        <div className="h-full ui-rise-in">
          <EpubPreview
            base64Content={base64Content}
            fileName={node.name}
            resourceId={node.id}
            metadataProgress={readingProgress}
            onProgressChange={handleProgressChange}
            isActive={isActive}
          />
        </div>
      );
    }

    // 音视频预览：自定义播放器（流式优先；播放失败时统一错误态）
    if ((isAudio || isVideo) && mediaSource) {
      if (mediaRenderFailed) {
        return (
          <PreviewStatus
            tone="error"
            title={t('learningHub:file.mediaRenderFailed')}
            description={
              isLikelyUnsupportedMedia(node.name, isAudio ? 'audio' : 'video')
                ? t('learningHub:file.mediaUnsupportedHint')
                : t('learningHub:file.mediaRenderFailedHint')
            }
            actions={[
              { id: 'retry', label: t('common:retry'), onClick: handleRetry, variant: 'ghost' },
              {
                id: 'save',
                label: t('learningHub:file.saveToDevice'),
                onClick: () => { void handleSaveFile(); },
                variant: 'primary',
                loading: isSaving,
              },
            ]}
          />
        );
      }

      const compatibilityHint = isLikelyUnsupportedMedia(node.name, isAudio ? 'audio' : 'video')
        ? t('learningHub:file.mediaUnsupportedWarning')
        : undefined;

      if (isAudio) {
        return (
          <AudioPlayer
            key={mediaSource.url}
            src={mediaSource.url}
            fileName={node.name}
            meta={
              typeof node.size === 'number' && node.size > 0
                ? formatFileSize(node.size)
                : undefined
            }
            compatibilityHint={compatibilityHint}
            isActive={isActive}
            onError={handleMediaError}
          />
        );
      }
      return (
        <VideoPlayer
          key={mediaSource.url}
          src={mediaSource.url}
          fileName={node.name}
          compatibilityHint={compatibilityHint}
          isActive={isActive}
          onError={handleMediaError}
        />
      );
    }

    // 文本预览（md 富渲染 / csv 表格化 / 纯文本，带滚动容器）
    // ★ 空字符串也进入此分支：TextFilePreview 会渲染"文件内容为空"空状态
    if (textContent !== null) {
      return (
        <CustomScrollArea className="h-full min-h-0" orientation="both">
          <TextFilePreview content={textContent} fileName={node.name} />
        </CustomScrollArea>
      );
    }

    // 无法预览 — 显示文件信息以帮助排查
    return (
      <PreviewStatus
        tone="empty"
        icon="file"
        title={isArchive ? t('learningHub:file.archiveNoPreview') : t('learningHub:file.noPreview')}
        description={
          isArchive ? t('learningHub:file.archiveNoManifestHint') : t('learningHub:file.downloadHint')
        }
        meta={`${node.name} · ${mimeType}${
          typeof node.size === 'number' && node.size > 0 ? ` · ${formatFileSize(node.size)}` : ''
        }`}
        actions={[
          {
            id: 'save',
            label: t('learningHub:file.saveToDevice'),
            onClick: () => { void handleSaveFile(); },
            variant: 'primary',
            loading: isSaving,
          },
          {
            id: 'retry',
            label: t('common:retry'),
            onClick: handleRetry,
            variant: 'ghost',
          },
        ]}
      />
    );
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-background">
      {renderContent()}
    </div>
  );
};

/**
 * 文件内容视图组件
 * 使用 PreviewProvider 包装，提供统一的预览状态管理
 */
const FileContentView: React.FC<ContentViewProps> = (props) => (
  <PreviewProvider>
    <FileContentViewInner {...props} />
  </PreviewProvider>
);

export default FileContentView;
