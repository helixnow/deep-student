import React, { useEffect, useMemo, useRef, useState } from 'react';
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
        {/* 顶部工具栏 */}
        <div className="modern-viewer-toolbar flex items-center justify-between px-6 py-4 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <span className="text-foreground font-medium text-sm" title={displayTitle}>{displayTitle}</span>
            {sizeBytes && (
              <span className="text-xs text-muted-foreground">({Math.round(sizeBytes/1024)}KB)</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {/* 预览/下载按钮（仅在需要时显示） */}
            {showPreviewDownload && textContent && (
              <>
                <button
                  onClick={handlePreview}
                  className="modern-viewer-icon-button modern-viewer-icon-button--primary rounded-lg p-2"
                  title={t('document_viewer.preview_in_new_window')}
                  aria-label={t('document_viewer.aria_preview')}
                >
                  <ExternalLink size={18} />
                </button>
                <button
                  onClick={handleDownload}
                  className="modern-viewer-icon-button modern-viewer-icon-button--success rounded-lg p-2"
                  title={t('document_viewer.download_document')}
                  aria-label={t('document_viewer.aria_download')}
                >
                  <Download size={18} />
                </button>
              </>
            )}
            {/* 文本模式工具 */}
            {textContent != null && (
              <>
                <button
                  title={t('document_viewer.copy_all')}
                  aria-label={t('document_viewer.aria_copy')}
                  onClick={applyCopy}
                  className="modern-viewer-icon-button rounded-lg p-2"
                >
                  <Copy size={18} />
                </button>
                <button
                  title={t('document_viewer.decrease_font')}
                  aria-label={t('document_viewer.aria_decrease_font')}
                  onClick={() => setFontScale(v => Math.max(0.75, v / 1.1))}
                  className="modern-viewer-icon-button rounded-lg p-2"
                >
                  <ZoomOut size={18} />
                </button>
                <button
                  title={t('document_viewer.increase_font')}
                  aria-label={t('document_viewer.aria_increase_font')}
                  onClick={() => setFontScale(v => Math.min(2, v * 1.1))}
                  className="modern-viewer-icon-button rounded-lg p-2"
                >
                  <ZoomIn size={18} />
                </button>
                <button
                  title={t('document_viewer.reset_font')}
                  aria-label={t('document_viewer.aria_reset_font')}
                  onClick={() => setFontScale(1)}
                  className="modern-viewer-icon-button rounded-lg p-2"
                >
                  <Home size={18} />
                </button>
                <div className="flex items-center gap-1 px-2 py-1 rounded-lg border border-[hsl(var(--border) / 0.45)] bg-[hsl(var(--card) / 0.6)]">
                  <Search size={16} className="text-[hsl(var(--muted-foreground))]" />
                  <input
                    placeholder={t('document_viewer.search_placeholder')}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    className="text-sm bg-transparent outline-none min-w-[120px] text-[hsl(var(--foreground))] placeholder:text-[hsl(var(--muted-foreground))]"
                  />
                </div>
                <button
                  title={wrap ? t('document_viewer.toggle_nowrap') : t('document_viewer.toggle_wrap')}
                  aria-label={wrap ? t('document_viewer.aria_toggle_nowrap') : t('document_viewer.aria_toggle_wrap')}
                  onClick={() => setWrap(w => !w)}
                  className="modern-viewer-icon-button rounded-lg p-2"
                >
                  <WrapText size={18} />
                </button>
              </>
            )}
            {/* URL模式工具：缩放与重置 */}
            {url && (
              <>
                <button
                  title={t('document_viewer.zoom_out')}
                  aria-label={t('document_viewer.aria_zoom_out')}
                  onClick={() => setScale(s => Math.max(0.5, s / 1.1))}
                  className="modern-viewer-icon-button rounded-lg p-2"
                >
                  <ZoomOut size={18} />
                </button>
                <span className="px-3 py-1 rounded-md text-sm font-medium min-w-[60px] text-center border border-[hsl(var(--border) / 0.45)] bg-[hsl(var(--card) / 0.55)] text-[hsl(var(--foreground))]" role="status" aria-label={t('document_viewer.aria_zoom_level', { level: Math.round(scale * 100) })}>{Math.round(scale * 100)}%</span>
                <button
                  title={t('document_viewer.zoom_in')}
                  aria-label={t('document_viewer.aria_zoom_in')}
                  onClick={() => setScale(s => Math.min(3, s * 1.1))}
                  className="modern-viewer-icon-button rounded-lg p-2"
                >
                  <ZoomIn size={18} />
                </button>
                <button
                  title={t('document_viewer.reset')}
                  aria-label={t('document_viewer.aria_reset')}
                  onClick={() => { setScale(1); setPosition({ x: 0, y: 0 }); }}
                  className="modern-viewer-icon-button rounded-lg p-2"
                >
                  <Home size={18} />
                </button>
              </>
            )}
            {url && (
              <>
                <button
                  onClick={handleOpenExternal}
                  className="modern-viewer-icon-button rounded-lg p-2"
                  title={t('document_viewer.open_in_new_tab')}
                >
                  <ExternalLink size={18} />
                </button>
                <button
                  onClick={handleDownload}
                  className="modern-viewer-icon-button rounded-lg p-2"
                  title={t('document_viewer.download')}
                >
                  <Download size={18} />
                </button>
              </>
            )}
            <button
              onClick={onClose}
              className="modern-viewer-icon-button modern-viewer-icon-button--danger rounded-lg p-2"
              title={t('document_viewer.close')}
            >
              <X size={20} />
            </button>
          </div>
        </div>

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

        {/* 底部提示 */}
        <div className="modern-viewer-footer px-6 py-3 text-[12px]">
          {showPreviewDownload ? (
            <>
              {t('document_viewer.hint_preview_download')}
            </>
          ) : (
            <>
              {t('document_viewer.hint_default')}
            </>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
};
