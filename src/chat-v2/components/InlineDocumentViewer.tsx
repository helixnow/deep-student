/**
 * Chat V2 - 内联文档查看器
 *
 * 与全局 DocumentViewer 不同，此组件只覆盖聊天主区域而非整个应用
 * 通过查找最近的 .chat-v2 容器并计算其边界来实现
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { NotionButton } from '@/components/ui/NotionButton';
import {
  X,
  ZoomIn,
  ZoomOut,
  Home,
  Copy,
  Search,
  WrapText,
  ExternalLink,
  Download,
  Check,
} from 'lucide-react';
import { fileManager } from '@/utils/fileManager';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

// ============================================================================
// 类型定义
// ============================================================================

interface InlineDocumentViewerProps {
  /** 是否打开 */
  isOpen: boolean;
  /** 文档标题 */
  title?: string;
  /** 文本内容 */
  textContent: string | null;
  /** 关闭回调 */
  onClose: () => void;
  /** 文件名（用于下载） */
  fileName?: string;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// 辅助 Hook：获取 .chat-v2 容器
// ============================================================================

function useChatV2Container() {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [bounds, setBounds] = useState<DOMRect | null>(null);

  useEffect(() => {
    // ★ 查找或创建 modal 容器，避免层叠上下文问题
    const findOrCreateContainer = () => {
      // 优先使用已存在的 modal-root
      let modalRoot = document.getElementById('document-viewer-root');
      if (!modalRoot) {
        // 创建一个挂载在 body 下的容器
        modalRoot = document.createElement('div');
        modalRoot.id = 'document-viewer-root';
        modalRoot.style.cssText = 'position: fixed; top: 0; left: 0; width: 100%; height: 100%; pointer-events: none; z-index: 99999;';
        document.body.appendChild(modalRoot);
      }
      setContainer(modalRoot);
      
      // 获取 .chat-v2 的边界用于定位
      const chatContainer = document.querySelector('.chat-v2') as HTMLElement;
      if (chatContainer) {
        setBounds(chatContainer.getBoundingClientRect());
      }
      return true;
    };

    findOrCreateContainer();

    // 监听窗口大小变化更新边界
    const handleResize = () => {
      const chatContainer = document.querySelector('.chat-v2') as HTMLElement;
      if (chatContainer) {
        setBounds(chatContainer.getBoundingClientRect());
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return { container, bounds };
}

// ============================================================================
// 组件实现
// ============================================================================

export const InlineDocumentViewer: React.FC<InlineDocumentViewerProps> = ({
  isOpen,
  title: titleProp,
  textContent,
  onClose,
  fileName,
  className,
}) => {
  const { t } = useTranslation(['common', 'chatV2']);
  const title = titleProp || t('chatV2:documentViewer.defaultTitle');

  // 获取 modal 容器和 .chat-v2 边界用于定位
  const { container, bounds } = useChatV2Container();

  // 状态
  const [fontScale, setFontScale] = useState(1);
  const [wrap, setWrap] = useState(true);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  const contentRef = useRef<HTMLPreElement>(null);

  // 键盘事件处理
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case '+':
        case '=':
          setFontScale((prev) => Math.min(prev * 1.1, 2));
          break;
        case '-':
          setFontScale((prev) => Math.max(prev / 1.1, 0.75));
          break;
        case '0':
          setFontScale(1);
          break;
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // 复制全文
  const handleCopy = useCallback(async () => {
    if (!textContent) return;
    try {
      await copyTextToClipboard(textContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e: unknown) {
      console.error('Copy failed:', e);
    }
  }, [textContent]);

  // 下载
  const handleDownload = useCallback(async () => {
    if (!textContent) return;
    try {
      const defaultName = fileName || title || 'document.txt';
      await fileManager.saveTextFile({
        title: defaultName,
        defaultFileName: defaultName,
        content: textContent,
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
    } catch (e: unknown) {
      console.error('Download failed:', e);
    }
  }, [textContent, fileName, title]);

  // 新窗口打开
  const handleOpenExternal = useCallback(() => {
    if (!textContent) return;
    try {
      const blob = new Blob([textContent], { type: 'text/plain;charset=utf-8' });
      const previewUrl = URL.createObjectURL(blob);
      const win = window.open(previewUrl, '_blank', 'noopener,noreferrer');
      if (win) {
        const revoke = () => URL.revokeObjectURL(previewUrl);
        win.addEventListener('beforeunload', revoke);
        setTimeout(revoke, 120000);
      } else {
        setTimeout(() => URL.revokeObjectURL(previewUrl), 120000);
      }
    } catch (e: unknown) {
      console.error('Preview failed:', e);
    }
  }, [textContent]);

  // 搜索滚动
  const scrollToQuery = useCallback(() => {
    if (!contentRef.current || !query.trim() || !textContent) return;
    const el = contentRef.current;
    const idx = textContent.toLowerCase().indexOf(query.toLowerCase());
    if (idx >= 0) {
      const ratio = idx / textContent.length;
      el.scrollTop = ratio * (el.scrollHeight - el.clientHeight);
    }
  }, [query, textContent]);

  useEffect(() => {
    scrollToQuery();
  }, [scrollToQuery]);

  // 不显示时返回 null
  if (!isOpen || !textContent || !container) {
    return null;
  }

  // 使用 bounds 精确定位到 .chat-v2 区域
  const overlayStyle: React.CSSProperties = bounds ? {
    position: 'fixed',
    top: bounds.top,
    left: bounds.left,
    width: bounds.width,
    height: bounds.height,
    pointerEvents: 'auto',
  } : {
    position: 'fixed',
    inset: 0,
    pointerEvents: 'auto',
  };

  const overlay = (
    <div
      className={cn(
        'bg-background/95 dark:bg-background/98 backdrop-blur-sm',
        'flex flex-col',
        'shadow-lg ring-1 ring-border/40 border-l border-border/50',
        className
      )}
      style={overlayStyle}
      onClick={(e) => {
        // 点击背景关闭
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
    >
      {/* 工具栏 */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-muted/50 border-b border-border flex-shrink-0">
        {/* 左侧：标题 */}
        <div className="flex items-center gap-3">
          <span className="text-foreground font-medium text-sm truncate max-w-[200px]" title={title}>
            {title}
          </span>
        </div>

        {/* 中间：工具 */}
        <div className="flex items-center gap-1.5">
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setFontScale((prev) => Math.max(prev / 1.1, 0.75))} className="bg-muted hover:bg-muted/80" aria-label={t('common:imageViewer.zoomOut')} title={t('common:imageViewer.zoomOut')}>
            <ZoomOut className="w-4 h-4" />
          </NotionButton>
          <span className="px-2 py-1 rounded-md text-xs font-medium min-w-[45px] text-center bg-muted text-muted-foreground">
            {Math.round(fontScale * 100)}%
          </span>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setFontScale((prev) => Math.min(prev * 1.1, 2))} className="bg-muted hover:bg-muted/80" aria-label={t('common:imageViewer.zoomIn')} title={t('common:imageViewer.zoomIn')}>
            <ZoomIn className="w-4 h-4" />
          </NotionButton>
          <div className="w-px h-4 bg-border mx-1" />
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setFontScale(1)} className="bg-muted hover:bg-muted/80" aria-label={t('common:imageViewer.reset')} title={t('common:imageViewer.reset')}>
            <Home className="w-4 h-4" />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setWrap((w) => !w)} className={cn(wrap ? 'bg-primary/20 text-primary' : 'bg-muted hover:bg-muted/80')} aria-label={wrap ? t('common:noWrap') : t('common:wrap')} title={wrap ? t('common:noWrap') : t('common:wrap')}>
            <WrapText className="w-4 h-4" />
          </NotionButton>
          <div className="w-px h-4 bg-border mx-1" />
          <div className="flex items-center gap-1 px-2 py-1 rounded-md border border-border bg-background">
            <Search size={14} className="text-muted-foreground" />
            <input
              placeholder={t('chatV2:documentViewer.search')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="text-xs bg-transparent outline-none w-[80px] text-foreground placeholder:text-muted-foreground"
            />
          </div>
        </div>

        {/* 右侧：操作按钮 */}
        <div className="flex items-center gap-1.5">
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCopy} className="bg-muted hover:bg-muted/80" aria-label={t('common:copy')} title={t('common:copy')}>
            {copied ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleOpenExternal} className="bg-muted hover:bg-muted/80" aria-label={t('common:openInNewTab')} title={t('common:openInNewTab')}>
            <ExternalLink className="w-4 h-4" />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={handleDownload} className="bg-muted hover:bg-muted/80" aria-label={t('common:download')} title={t('common:download')}>
            <Download className="w-4 h-4" />
          </NotionButton>
          <div className="w-px h-4 bg-border mx-1" />
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} className="hover:bg-destructive/20 hover:text-destructive" aria-label={t('common:close')} title={t('common:close')}>
            <X className="w-4 h-4" />
          </NotionButton>
        </div>
      </div>

      {/* 文档内容 */}
      <div className="flex-1 overflow-auto p-4">
        <pre
          ref={contentRef}
          className="text-foreground font-mono"
          style={{
            whiteSpace: wrap ? 'pre-wrap' : 'pre',
            wordWrap: wrap ? 'break-word' : 'normal',
            lineHeight: 1.7,
            margin: 0,
            fontSize: `${Math.round(fontScale * 14)}px`,
          }}
        >
          {textContent}
        </pre>
      </div>

      {/* 快捷键提示 */}
      <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border flex-shrink-0">
        {t('chatV2:messageItem.documentPreviewHint')}
      </div>
    </div>
  );

  // 使用 Portal 渲染到独立容器，只覆盖 .chat-v2 区域
  return createPortal(overlay, container);
};

export default InlineDocumentViewer;
