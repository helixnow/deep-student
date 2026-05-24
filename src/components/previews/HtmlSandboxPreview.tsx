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
  className?: string;
  style?: React.CSSProperties;
}

export const HtmlSandboxPreview: React.FC<HtmlSandboxPreviewProps> = ({
  mode,
  htmlContent,
  cssContent = '',
  compact = false,
  height,
  fidelity = 'default',
  title = 'html-preview',
  className,
  style,
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

  return (
    <iframe
      ref={iframeRef}
      className={className}
      sandbox={getHtmlSandboxPermissions(mode)}
      srcDoc={srcDoc}
      style={{
        display: 'block',
        width: '100%',
        maxWidth: '100%',
        height: height !== undefined ? height : iframeHeight,
        border: 'none',
        overflow: 'auto',
        ...style,
      }}
      title={title}
    />
  );
};

export default HtmlSandboxPreview;
