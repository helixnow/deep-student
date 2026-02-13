import React, { useState, useCallback, useRef } from 'react';
// 临时保留 react-pdf 实现，后续将迁移到 BasePdfViewer（react-pdf-viewer）
import { useTranslation } from 'react-i18next';
import { 
  FileUp, 
  ChevronLeft, 
  ChevronRight, 
  ZoomIn, 
  ZoomOut, 
  RotateCw,
  Download,
  X
} from 'lucide-react';
import useTheme from '../hooks/useTheme';
import { TauriAPI } from '../utils/tauriApi';
import 'react-pdf/dist/Page/AnnotationLayer.css';
import 'react-pdf/dist/Page/TextLayer.css';
import './PdfReader.css';
import { EnhancedPdfViewer } from './pdf/EnhancedPdfViewer';
import { usePdfRenderTracker } from '../utils/pdfDebug';

interface PdfReaderProps {}

export const PdfReader: React.FC<PdfReaderProps> = () => {
  const { t } = useTranslation(['pdf', 'common']);
  const { isDarkMode } = useTheme();
  
  const [file, setFile] = useState<File | null>(null);
  const [externalUrl, setExternalUrl] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>('document.pdf');
  const [numPages, setNumPages] = useState<number | null>(null);
  const [pageNumber, setPageNumber] = useState<number>(1);
  const [scale, setScale] = useState<number>(1.0);
  const [rotation, setRotation] = useState<number>(0);
  // 更细粒度的加载阶段：reading=从磁盘/tauri读取；parsing=pdf.js 解析；idle=就绪
  const [loadingStage, setLoadingStage] = useState<'idle' | 'reading' | 'parsing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [expectedSize, setExpectedSize] = useState<number | null>(null);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // 缓存 blob URL，避免每次渲染都重新创建
  const fileBlobUrlRef = useRef<string | null>(null);
  // 追踪当前 file 对象，用于检测变化
  const lastFileRef = useRef<File | null>(null);

  // ★ 生成 viewer URL（包含 Blob URL 管理）
  const viewerUrl = React.useMemo(() => {
    // 检测 file 是否真的变化了（对象引用不同）
    if (file !== lastFileRef.current) {
      // 释放旧的 Blob URL（只有当旧的 file 存在时才释放）
      if (lastFileRef.current && fileBlobUrlRef.current) {
        URL.revokeObjectURL(fileBlobUrlRef.current);
        fileBlobUrlRef.current = null;
      }
      lastFileRef.current = file;
    }
    
    if (file) {
      if (!fileBlobUrlRef.current) {
        fileBlobUrlRef.current = URL.createObjectURL(file);
      }
      return fileBlobUrlRef.current;
    }
    // 外部路径已转为 asset:// 协议 URL，可直接使用
    return externalUrl ?? undefined;
  }, [file, externalUrl]);

  React.useEffect(() => {
    return () => {
      if (fileBlobUrlRef.current) {
        URL.revokeObjectURL(fileBlobUrlRef.current);
        fileBlobUrlRef.current = null;
      }
    };
  }, []);

  // 渲染追踪
  usePdfRenderTracker('PdfReader', {
    hasFile: !!file,
    fileName,
    numPages,
    pageNumber,
    scale,
    rotation,
    loadingStage,
    hasError: !!error,
  });

  const onFileChange = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0];
    if (selectedFile && selectedFile.type === 'application/pdf') {
      // 清理旧的 blob URL
      if (fileBlobUrlRef.current) {
        URL.revokeObjectURL(fileBlobUrlRef.current);
        fileBlobUrlRef.current = null;
      }
      
      setFile(selectedFile);
      setExternalUrl(null);
      setPageNumber(1);
      setScale(1.0);
      setRotation(0);
      setError(null);
    } else {
      setError(t('pdf:errors.invalid_file'));
    }
  }, [t]);

  const onDocumentLoadSuccess = useCallback(({ numPages }: { numPages: number }) => {
    setNumPages(numPages);
    setLoadingStage('idle');
    setError(null);
  }, []);

  const onDocumentLoadError = useCallback((error: Error) => {
    console.error('PDF 加载失败:', error);
    setError(t('pdf:errors.load_failed'));
    setLoadingStage('idle');
  }, [t]);

  const changePage = useCallback((offset: number) => {
    setPageNumber((prevPageNumber) => {
      const newPage = prevPageNumber + offset;
      if (numPages && newPage >= 1 && newPage <= numPages) {
        return newPage;
      }
      return prevPageNumber;
    });
  }, [numPages]);

  const previousPage = useCallback(() => changePage(-1), [changePage]);
  const nextPage = useCallback(() => changePage(1), [changePage]);

  const handleZoomIn = useCallback(() => {
    setScale((prev) => Math.min(prev + 0.25, 3.0));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale((prev) => Math.max(prev - 0.25, 0.5));
  }, []);

  const handleRotate = useCallback(() => {
    setRotation((prev) => (prev + 90) % 360);
  }, []);

  const handleReset = useCallback(() => {
    setScale(1.0);
    setRotation(0);
  }, []);

  const handleViewerPageChange = useCallback((idx: number) => {
    setPageNumber(idx + 1);
  }, []);

  const handleViewerDocumentLoad = useCallback((n: number) => {
    setNumPages(n);
  }, []);

  const handleSelectFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleClearFile = useCallback(() => {
    // 清理 blob URL
    if (fileBlobUrlRef.current) {
      URL.revokeObjectURL(fileBlobUrlRef.current);
      fileBlobUrlRef.current = null;
    }
    
    setFile(null);
    setExternalUrl(null);
    setNumPages(null);
    setPageNumber(1);
    setScale(1.0);
    setRotation(0);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // 支持从外部事件打开 PDF（使用 pdfstream:// 协议实现流式加载）
  React.useEffect(() => {
    const handler = async (ev: any) => {
      try {
        const detail = (ev && ev.detail) || {};
        const path: string | undefined = typeof detail.path === 'string' ? detail.path : undefined;
        const name: string | undefined = typeof detail.name === 'string' ? detail.name : undefined;
        const data: Uint8Array | undefined = detail.data instanceof Uint8Array ? detail.data : undefined;
        const size: number | undefined = typeof detail.size === 'number' ? detail.size : undefined;
        setExpectedSize(typeof size === 'number' && size >= 0 ? size : null);
        setError(null);
        const safeName = name && /\.pdf$/i.test(name) ? name : (name ? `${name}.pdf` : 'document.pdf');
        setFileName(safeName);
        setPageNumber(1);
        setScale(1.0);
        setRotation(0);

        // 1) 如果事件直接给了数据，转为 blob URL
        if (data && data.byteLength) {
          // 确保类型兼容：从 Uint8Array 转为 ArrayBuffer
          const arrayBuffer = data.buffer as ArrayBuffer;
          const blob = new Blob([arrayBuffer], { type: 'application/pdf' });
          const f = new File([blob], safeName, { type: 'application/pdf' });
          setFile(f);
          setExternalUrl(null);
          setLoadingStage('parsing');
          return;
        }

        // 2) 仅提供路径时，转为 pdfstream:// 协议 URL（支持 Range Request 流式加载）
        if (path) {
          // 分段编码路径：保留 / 作为分隔符，只编码每段中的特殊字符
          const encodedPath = path
            .split('/')
            .map(segment => encodeURIComponent(segment))
            .join('/');
          const pdfstreamUrl = `pdfstream://localhost/${encodedPath}`;
          
          setFile(null);
          setExternalUrl(pdfstreamUrl);
          setLoadingStage('idle'); // pdfstream:// 直接由 PDF.js 按需加载，无需前端 loading
          return;
        }

        setError(t('pdf:errors.invalid_file'));
      } catch (err: unknown) {
        console.error('OPEN_PDF_FILE 处理失败:', err);
        setError(t('pdf:errors.load_failed'));
      } finally {}
    };
    try { window.addEventListener('OPEN_PDF_FILE' as any, handler as any); } catch {}
    return () => { try { window.removeEventListener('OPEN_PDF_FILE' as any, handler as any); } catch {} };
  }, [t]);

  const handleDownload = useCallback(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  }, [file]);

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
        <div className="pdf-error-message">
          <span>{error}</span>
        </div>
      )}

      {loadingStage === 'reading' && (
        <div className="pdf-loading" style={{ flex: 1 }}>
          <div className="pdf-loading-spinner"></div>
          <p>
            {expectedSize != null
              ? t('pdf:loading_reading', { mb: (expectedSize / (1024 * 1024)).toFixed(1) })
              : t('pdf:loading_reading_simple')}
          </p>
        </div>
      )}

      {!viewerUrl && !error && loadingStage === 'idle' && (
        <div className="pdf-empty-state">
          <FileUp className="h-16 w-16 empty-icon" />
          <h2>{t('pdf:empty.title')}</h2>
          <p>{t('pdf:empty.description')}</p>
        </div>
      )}

      {viewerUrl && (
        <div className="pdf-viewer-container" ref={containerRef}>
          <EnhancedPdfViewer
            data={undefined}
            url={viewerUrl as string}
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

