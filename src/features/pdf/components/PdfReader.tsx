import React, { useState, useCallback, useRef } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { UploadSimple, WarningCircle, X } from '@phosphor-icons/react';
import useTheme from '@/hooks/useTheme';
import { useMobileHeader } from '@/components/layout';
import { NotionButton } from '@/components/ui/NotionButton';
import { TauriAPI } from '@/utils/tauriApi';
import '../styles/pdf-reader.css';
import { EnhancedPdfViewer } from './EnhancedPdfViewer';
import { usePdfRenderTracker } from '@/utils/pdfDebug';
import { classifyPdfLoadError } from '@/features/learning-hub/apps/views/pdfLoadErrors';

export const PdfReader: React.FC = () => {
  const { t } = useTranslation(['pdf', 'common']);
  const { isDarkMode } = useTheme();

  // 供 useMobileHeader rightActions 调用（handleSelectFile 在下方定义）
  const handleSelectFileRef = useRef<() => void>(() => {});

  // D-1: 移动端顶栏标题（pdf-reader 视图直挂本组件）
  // ★ 2026-07-08（移动端审计 D-2）：文件打开后页内不再有「选择文件」入口，
  // 换文件只能退出视图重进 —— 把打开文件动作收进统一顶栏右侧。
  useMobileHeader('pdf-reader', {
    title: t('common:navigation.pdf_reader'),
    rightActions: (
      <NotionButton
        variant="ghost"
        size="sm"
        iconOnly
        aria-label={t('pdf:empty.select_button')}
        onClick={() => handleSelectFileRef.current()}
      >
        <UploadSimple size={18} />
      </NotionButton>
    ),
  }, [t]);

  const [file, setFile] = useState<File | null>(null);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('document.pdf');
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(1);
  // 加载阶段：parsing=pdf.js 解析中；idle=就绪
  const [loadingStage, setLoadingStage] = useState<'idle' | 'parsing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [errorHint, setErrorHint] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // ★ Blob URL 生命周期由 effect 管理（而非 useMemo 副作用）：
  // StrictMode / 并发渲染下 useMemo 可能重复执行或结果被丢弃，
  // 在其中 create/revoke 会误 revoke 仍在使用的 URL。
  // state 同时记录 URL 所属的 File：file 切换到新 URL 就绪之间有一次
  // 中间渲染，若只存 URL 会把上一个（将被 revoke 的）blob URL 交给 viewer。
  const [fileBlob, setFileBlob] = useState<{ file: File; url: string } | null>(null);
  React.useEffect(() => {
    if (!file) {
      setFileBlob(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setFileBlob({ file, url });
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [file]);

  // 生成 viewer URL（纯计算，无副作用）
  const viewerUrl = React.useMemo(() => {
    if (file) {
      // blob URL 尚未就绪（或还挂着旧 file 的 URL）时返回 undefined，渲染层会等待
      return fileBlob && fileBlob.file === file ? fileBlob.url : undefined;
    }
    // 外部路径已转为 pdfstream:// 协议 URL，可直接使用
    return externalUrl ?? undefined;
  }, [file, fileBlob, externalUrl]);

  // 渲染追踪
  usePdfRenderTracker('PdfReader', {
    hasFile: !!file,
    fileName,
    numPages,
    pageNumber,
    loadingStage,
    hasError: !!error,
  });

  const clearError = useCallback(() => {
    setError(null);
    setErrorHint(null);
  }, []);

  /** 分类加载错误 → 语义化文案 + 提示（与 EnhancedPdfViewer 内部错误面板同一分类源） */
  const applyClassifiedError = useCallback((err: unknown) => {
    const classified = classifyPdfLoadError(err);
    switch (classified.kind) {
      case 'password':
        setError(t('pdf:errors.password_protected'));
        setErrorHint(t('pdf:errors.password_protected_hint'));
        break;
      case 'invalid':
        setError(t('pdf:errors.invalid_pdf'));
        setErrorHint(t('pdf:errors.invalid_pdf_hint'));
        break;
      case 'network':
        setError(t('pdf:errors.stream_failed'));
        setErrorHint(t('pdf:errors.stream_failed_hint'));
        break;
      case 'too-large':
        setError(t('pdf:errors.too_large_simple'));
        setErrorHint(t('pdf:errors.too_large_hint'));
        break;
      default:
        setError(t('pdf:errors.load_failed'));
        setErrorHint(classified.rawMessage || null);
        break;
    }
  }, [t]);

  const onFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      setFile(selectedFile);
      setFileName(selectedFile.name || 'document.pdf');
      setExternalUrl(null);
      setPageNumber(1);
      clearError();
    } else {
      setError(t('pdf:errors.invalid_file'));
      setErrorHint(null);
    }
  }, [t, clearError]);

  const handleViewerPageChange = useCallback((idx: number) => {
    setPageNumber(idx + 1);
  }, []);

  const handleViewerDocumentLoad = useCallback((n: number) => {
    setNumPages(n);
    setLoadingStage('idle');
  }, []);

  const handleSelectFile = useCallback(async () => {
    try {
      const { open: dialogOpen } = await import('@tauri-apps/plugin-dialog');
      const selected = await dialogOpen({
        multiple: false,
        directory: false,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
      });
      if (selected && typeof selected === 'string') {
        // 通过后端读取文件字节
        const bytes = await TauriAPI.readFileAsBytes(selected);
        const blob = new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer], { type: 'application/pdf' });
        const { extractFileName } = await import('@/utils/fileManager');
        const name = extractFileName(selected) || 'document.pdf';
        const pdfFile = new File([blob], name, { type: 'application/pdf' });
        setFile(pdfFile);
        setFileName(name);
        setExternalUrl(null);
        setPageNumber(1);
        clearError();
      }
    } catch (err) {
      console.warn('[PdfReader] Tauri dialog failed, falling back to file input:', err);
      fileInputRef.current?.click();
    }
  }, [clearError]);
  handleSelectFileRef.current = handleSelectFile;

  const handleClearFile = useCallback(() => {
    // blob URL 由 [file] effect 的 cleanup 负责 revoke
    setFile(null);
    setExternalUrl(null);
    setNumPages(null);
    setPageNumber(1);
    setLoadingStage('idle');
    clearError();
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, [clearError]);

  // 支持从外部事件打开 PDF（使用 pdfstream:// 协议实现流式加载）
  React.useEffect(() => {
    const handler = async (ev: any) => {
      try {
        const detail = (ev && ev.detail) || {};
        const path: string | undefined = typeof detail.path === 'string' ? detail.path : undefined;
        const name: string | undefined = typeof detail.name === 'string' ? detail.name : undefined;
        const data: Uint8Array | undefined = detail.data instanceof Uint8Array ? detail.data : undefined;
        clearError();
        const safeName = name && /\.pdf$/i.test(name) ? name : (name ? `${name}.pdf` : 'document.pdf');
        setFileName(safeName);
        setPageNumber(1);

        // 1) 如果事件直接给了数据，转为 blob URL
        if (data && data.byteLength) {
          // ★ 2026-06-12（代理 3 审阅 H2）：按视图范围切片。
          // 直接取 data.buffer 时，若 Uint8Array 是大 buffer 的子视图
          // （byteOffset≠0 或长度小于 buffer），会把无关字节一并打进 Blob 导致 PDF 损坏。
          const arrayBuffer = data.buffer.slice(
            data.byteOffset,
            data.byteOffset + data.byteLength
          ) as ArrayBuffer;
          const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
          const f = new File([blob], safeName, { type: 'application/pdf' });
          setFile(f);
          setExternalUrl(null);
          setLoadingStage('parsing');
          return;
        }

        // 2) 仅提供路径时，转为 pdfstream:// 协议 URL（支持 Range Request 流式加载）
        if (path) {
          // 使用 Tauri 官方 API 构建跨平台协议 URL
          // Windows WebView2: http://pdfstream.localhost/<encoded_path>
          // macOS/Linux:      pdfstream://localhost/<encoded_path>
          const pdfstreamUrl = convertFileSrc(path, 'pdfstream');

          setFile(null);
          setExternalUrl(pdfstreamUrl);
          setLoadingStage('idle'); // pdfstream:// 直接由 PDF.js 按需加载，无需前端 loading
          return;
        }

        setError(t('pdf:errors.invalid_file'));
        setErrorHint(null);
      } catch (err: unknown) {
        console.error('OPEN_PDF_FILE 处理失败:', err);
        applyClassifiedError(err);
      }
    };
    try { window.addEventListener('OPEN_PDF_FILE' as any, handler as any); } catch {}
    return () => { try { window.removeEventListener('OPEN_PDF_FILE' as any, handler as any); } catch {} };
  }, [t, clearError, applyClassifiedError]);

  return (
    <div className={`pdf-reader-container ${isDarkMode ? 'dark-mode' : 'light-mode'}`}>
      {/* 隐藏的文件选择器 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        onChange={onFileChange}
        style={{ display: 'none' }}
      />

      {error && (
        <div className="pdf-reader-status ui-drop-in" role="alert">
          <WarningCircle size={20} className="pdf-reader-status__icon" aria-hidden />
          <div className="pdf-reader-status__body">
            <p className="pdf-reader-status__title">{error}</p>
            {errorHint && <p className="pdf-reader-status__hint">{errorHint}</p>}
          </div>
          <div className="pdf-reader-status__actions">
            <NotionButton variant="ghost" size="sm" onClick={handleSelectFile} className="gap-1.5">
              <UploadSimple size={14} />
              {t('pdf:empty.select_button')}
            </NotionButton>
            <NotionButton
              variant="ghost"
              size="sm"
              iconOnly
              aria-label={t('pdf:a11y.close')}
              onClick={clearError}
            >
              <X size={14} />
            </NotionButton>
          </div>
        </div>
      )}

      {!viewerUrl && !file && !error && loadingStage === 'idle' && (
        <div className="pdf-empty-state ui-rise-in">
          <div className="pdf-empty-state__icon-wrap">
            <UploadSimple size={32} className="empty-icon" />
          </div>
          <h2>{t('pdf:empty.title')}</h2>
          <p>{t('pdf:empty.description')}</p>
          <NotionButton variant="primary" size="sm" onClick={handleSelectFile} className="mt-4 gap-1.5">
            <UploadSimple size={16} />
            {t('pdf:empty.select_button')}
          </NotionButton>
        </div>
      )}

      {viewerUrl && (
        <div className="pdf-viewer-container" ref={containerRef}>
          <EnhancedPdfViewer
            data={undefined}
            url={viewerUrl}
            fileName={file ? file.name : (fileName || 'document.pdf')}
            onPageChange={handleViewerPageChange}
            onDocumentLoad={handleViewerDocumentLoad}
            onFileSelect={handleSelectFile}
            onFileClear={handleClearFile}
            hasFile={!!file || !!viewerUrl}
            isDarkMode={isDarkMode}
          />
        </div>
      )}
    </div>
  );
};

export default PdfReader;
