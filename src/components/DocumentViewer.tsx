import React, { useEffect, useMemo, useRef, useState } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { createPortal } from 'react-dom';
import { X, ExternalLink, Download, ZoomIn, ZoomOut, Home, Copy, Search, WrapText } from 'lucide-react';
import { openUrl } from '@/utils/urlOpener';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { fileManager } from '@/utils/fileManager';

interface DocumentViewerProps {
  isOpen: boolean;
  title?: string;
  // text 与 url 二选一
  textContent?: string | null;
  url?: string | null; // data:URL 或可嵌入的外链
  onClose: () => void;
  // 新增：预览/下载功能选项
  showPreviewDownload?: boolean;
  fileName?: string;
  sizeBytes?: number;
}

export const DocumentViewer: React.FC<DocumentViewerProps> = ({
  isOpen,
  title,
  textContent = null,
  url = null,
  onClose,
  showPreviewDownload = false,
  fileName,
  sizeBytes
}) => {
  const { t } = useTranslation('common');
  const displayTitle = title || t('document_viewer.default_title');
  // 通用：锁滚动、Esc 关闭
  // 键盘关闭 Esc
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  // 锁滚动
  useEffect(() => {
    if (!isOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [isOpen]);

  // 文本模式：字号、换行、搜索
  const [fontScale, setFontScale] = useState(1);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  const contentRef = useRef<HTMLPreElement>(null);

  const applyCopy = async () => {
    try {
      const txt = textContent ?? '';
      await navigator.clipboard.writeText(txt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {}
  };

  const scrollToQuery = () => {
    if (!contentRef.current || !query.trim()) return;
    const el = contentRef.current;
    const idx = (textContent || '').toLowerCase().indexOf(query.toLowerCase());
    if (idx >= 0) {
      // 计算大致滚动比例（粗略）
      const ratio = idx / (textContent || '').length;
      el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
    }
  };

  useEffect(() => { scrollToQuery(); }, [query]);

  // URL模式：缩放与拖拽
  const [scale, setScale] = useState(1);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const onWheel = (e: React.WheelEvent) => {
    if (!url) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    setScale(prev => Math.max(0.5, Math.min(3, prev * delta)));
  };
  const onMouseDown = (e: React.MouseEvent) => {
    if (!url) return;
    e.preventDefault();
    setIsDragging(true);
    dragStart.current = { x: e.clientX - position.x, y: e.clientY - position.y };
    const move = (ev: MouseEvent) => setPosition({ x: ev.clientX - dragStart.current.x, y: ev.clientY - dragStart.current.y });
    const up = () => {
      setIsDragging(false);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  if (!isOpen) return null;

  const handleOpenExternal = () => {
    if (!url) return;
    openUrl(url);
  };

  const handleDownload = async () => {
    if (textContent) {
      try {
        const defaultName = fileName || title || 'document.txt';
        await fileManager.saveTextFile({
          title: defaultName,
          defaultFileName: defaultName,
          content: textContent,
          filters: [{ name: 'Text', extensions: ['txt'] }],
        });
      } catch (e: unknown) {
        console.error('下载失败:', e);
        showGlobalNotification('error', t('document_viewer.download_failed'));
      }
    } else if (url) {
      openUrl(url);
    }
  };

  const handlePreview = () => {
    if (!textContent) return;
    
    try {
      const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
      const previewUrl = URL.createObjectURL(blob);
      // 使用安全的窗口打开方式，并添加跨域保护
      const newWindow = window.open('', '_blank', 'noopener,noreferrer,width=800,height=600');
      if (newWindow) {
        newWindow.location.href = previewUrl;
        const revoke = () => URL.revokeObjectURL(previewUrl);
        newWindow.addEventListener('beforeunload', revoke);
        setTimeout(revoke, 120000);
      } else {
        // 弹窗被阻止，降级到当前页面打开
        openUrl(previewUrl);
        setTimeout(() => URL.revokeObjectURL(previewUrl), 120000);
      }
    } catch (e: unknown) {
      console.error('预览失败:', e);
      showGlobalNotification('error', t('document_viewer.preview_failed'));
      handleDownload();
    }
  };

  const overlay = (
    <div className="modern-image-viewer-overlay" onClick={onClose}>
      <div className="modern-image-viewer-container" onClick={(e) => e.stopPropagation()}>
        {/* 内容区域 */}
        <div className="modern-viewer-content flex-1 overflow-hidden">
          {textContent != null ? (
            <div className="w-full h-full overflow-auto p-6">
              <pre
                ref={contentRef}
                style={{
                  whiteSpace: wrap ? 'pre-wrap' : 'pre',
                  wordWrap: wrap ? 'break-word' : 'normal',
                  lineHeight: 1.7,
                  margin: 0,
                  fontSize: `${Math.round(fontScale * 15)}px`
                }}
              >
                {textContent}
              </pre>
              {copied && (
                <div className="modern-viewer-hint fixed bottom-5 right-5 px-3 py-2 rounded-md text-xs">
                  {t('document_viewer.copied')}
                </div>
              )}
            </div>
          ) : url ? (
            <div
              className="w-full h-full overflow-hidden"
              onWheel={onWheel}
              onMouseDown={onMouseDown}
              onMouseUp={() => setIsDragging(false)}
              onMouseLeave={() => setIsDragging(false)}
              style={{ cursor: url && scale > 1 && isDragging ? 'grabbing' : url && scale > 1 ? 'grab' : 'default' }}
            >
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`,
                  transformOrigin: '0 0'
                }}
              >
                <iframe title="doc-viewer" src={url} style={{ width: '100%', height: '100%', border: 'none' }} />
              </div>
            </div>
          ) : null}
        </div>

        {/* 底部工具栏 */}
        <div className="modern-viewer-toolbar">
          <span className="modern-viewer-zoom-readout truncate max-w-[120px]" title={displayTitle}>{displayTitle}</span>
          {sizeBytes && (
            <span className="text-[11px] text-muted-foreground">({Math.round(sizeBytes/1024)}KB)</span>
          )}
          <div className="modern-viewer-divider" />
          {/* 预览/下载按钮 */}
          {showPreviewDownload && textContent && (
            <>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={handlePreview} className="modern-viewer-icon-button modern-viewer-icon-button--primary" title={t('document_viewer.preview_in_new_window')} aria-label={t('document_viewer.aria_preview')}>
                <ExternalLink size={16} />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={handleDownload} className="modern-viewer-icon-button modern-viewer-icon-button--success" title={t('document_viewer.download_document')} aria-label={t('document_viewer.aria_download')}>
                <Download size={16} />
              </NotionButton>
              <div className="modern-viewer-divider" />
            </>
          )}
          {/* 文本模式工具 */}
          {textContent != null && (
            <>
              <NotionButton variant="ghost" size="icon" iconOnly title={t('document_viewer.copy_all')} aria-label={t('document_viewer.aria_copy')} onClick={applyCopy} className="modern-viewer-icon-button">
                <Copy size={16} />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly title={t('document_viewer.decrease_font')} aria-label={t('document_viewer.aria_decrease_font')} onClick={() => setFontScale(v => Math.max(0.75, v / 1.1))} className="modern-viewer-icon-button">
                <ZoomOut size={16} />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly title={t('document_viewer.increase_font')} aria-label={t('document_viewer.aria_increase_font')} onClick={() => setFontScale(v => Math.min(2, v * 1.1))} className="modern-viewer-icon-button">
                <ZoomIn size={16} />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly title={t('document_viewer.reset_font')} aria-label={t('document_viewer.aria_reset_font')} onClick={() => setFontScale(1)} className="modern-viewer-icon-button">
                <Home size={16} />
              </NotionButton>
              <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md bg-transparent">
                <Search size={14} className="text-muted-foreground" />
                <input
                  placeholder={t('document_viewer.search_placeholder')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="text-xs bg-transparent outline-none min-w-[80px] text-foreground placeholder:text-muted-foreground"
                />
              </div>
              <NotionButton variant="ghost" size="icon" iconOnly title={wrap ? t('document_viewer.toggle_nowrap') : t('document_viewer.toggle_wrap')} aria-label={wrap ? t('document_viewer.aria_toggle_nowrap') : t('document_viewer.aria_toggle_wrap')} onClick={() => setWrap(w => !w)} className="modern-viewer-icon-button">
                <WrapText size={16} />
              </NotionButton>
            </>
          )}
          {/* URL模式工具 */}
          {url && (
            <>
              <NotionButton variant="ghost" size="icon" iconOnly title={t('document_viewer.zoom_out')} aria-label={t('document_viewer.aria_zoom_out')} onClick={() => setScale(s => Math.max(0.5, s / 1.1))} className="modern-viewer-icon-button">
                <ZoomOut size={16} />
              </NotionButton>
              <span className="modern-viewer-zoom-readout" role="status" aria-label={t('document_viewer.aria_zoom_level', { level: Math.round(scale * 100) })}>{Math.round(scale * 100)}%</span>
              <NotionButton variant="ghost" size="icon" iconOnly title={t('document_viewer.zoom_in')} aria-label={t('document_viewer.aria_zoom_in')} onClick={() => setScale(s => Math.min(3, s * 1.1))} className="modern-viewer-icon-button">
                <ZoomIn size={16} />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly title={t('document_viewer.reset')} aria-label={t('document_viewer.aria_reset')} onClick={() => { setScale(1); setPosition({ x: 0, y: 0 }); }} className="modern-viewer-icon-button">
                <Home size={16} />
              </NotionButton>
              <div className="modern-viewer-divider" />
              <NotionButton variant="ghost" size="icon" iconOnly onClick={handleOpenExternal} className="modern-viewer-icon-button" title={t('document_viewer.open_in_new_tab')} aria-label="open external">
                <ExternalLink size={16} />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly onClick={handleDownload} className="modern-viewer-icon-button" title={t('document_viewer.download')} aria-label="download">
                <Download size={16} />
              </NotionButton>
            </>
          )}
          <div className="modern-viewer-divider" />
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} className="modern-viewer-icon-button modern-viewer-icon-button--danger" title={t('document_viewer.close')} aria-label="close">
            <X size={16} />
          </NotionButton>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
};
