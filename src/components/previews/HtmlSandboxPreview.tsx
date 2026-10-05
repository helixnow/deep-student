import React, { useEffect, useMemo, useRef, useState } from 'react';

import {
  buildHtmlSandboxDocument,
  getHtmlSandboxPermissions,
  sanitizeCssForPreview,
  sanitizeHtmlForPreview,
  type HtmlSandboxMode,
} from './htmlSandboxPolicy';

export interface HtmlSandboxPreviewProps {
  mode: HtmlSandboxMode;
  htmlContent: string;
  cssContent?: string;
  compact?: boolean;
  height?: number | string;
  fidelity?: 'default' | 'anki';
  title?: string;
  /** iframe 最小高度（px）：内容不足时也撑满宿主区域（复习舞台） */
  minHeight?: number;
  className?: string;
  style?: React.CSSProperties;
  /** iframe 内点击非交互区域时回调（卡面辅助脚本发出 `sdp-click`） */
  onFrameClick?: () => void;
}

/** srcDoc 的轻量指纹（djb2），仅用作 React key */
function srcDocKey(doc: string): string {
  let hash = 5381;
  for (let i = 0; i < doc.length; i += 1) hash = ((hash << 5) + hash + doc.charCodeAt(i)) | 0;
  return `${doc.length}:${hash >>> 0}`;
}

export const HtmlSandboxPreview: React.FC<HtmlSandboxPreviewProps> = ({
  mode,
  htmlContent,
  cssContent = '',
  compact = false,
  height,
  fidelity = 'default',
  title = 'html-preview',
  minHeight,
  className,
  style,
  onFrameClick,
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState<number>(typeof height === 'number' ? height : 200);

  const srcDoc = useMemo(() => {
    const safeHtml = sanitizeHtmlForPreview(htmlContent, mode);
    const safeCss = sanitizeCssForPreview(cssContent, mode);
    return buildHtmlSandboxDocument({
      html: safeHtml,
      css: safeCss,
      mode,
      compact,
      height,
      fidelity,
    });
  }, [compact, cssContent, fidelity, height, htmlContent, mode]);

  useEffect(() => {
    if (typeof height === 'number') {
      setIframeHeight(height);
      return;
    }
    if (height !== undefined) {
      return;
    }
    if (mode !== 'template-safe') {
      return;
    }

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === 'sdp-resize' && typeof event.data.height === 'number') {
        const nextHeight = Math.max(20, Math.min(event.data.height, 5000));
        if (Number.isFinite(nextHeight)) {
          setIframeHeight(nextHeight);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [height, mode]);

  useEffect(() => {
    if (!onFrameClick || mode !== 'template-safe') return undefined;
    const handleClick = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      if (event.data?.type === 'sdp-click') onFrameClick();
    };
    window.addEventListener('message', handleClick);
    return () => window.removeEventListener('message', handleClick);
  }, [mode, onFrameClick]);

  return (
    <iframe
      // 内容变化即重建 iframe：WebKit 对快速连续的 srcdoc 更新会漏掉重载，
      // 画面停在旧文档（复习切卡时出现过上一张卡的模板）
      key={srcDocKey(srcDoc)}
      ref={iframeRef}
      className={className}
      sandbox={getHtmlSandboxPermissions(mode)}
      srcDoc={srcDoc}
      style={{
        display: 'block',
        width: '100%',
        maxWidth: '100%',
        height: height !== undefined ? height : Math.max(iframeHeight, minHeight ?? 0),
        border: 'none',
        overflow: 'auto',
        background: 'hsl(var(--background))',
        colorScheme: 'light dark',
        ...style,
      }}
      title={title}
    />
  );
};

export default HtmlSandboxPreview;
