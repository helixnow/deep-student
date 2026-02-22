import React, { useRef, useEffect, useState, useMemo } from 'react';
import DOMPurify from 'dompurify';

const sanitizeCss = (css: string) => {
  if (!css) return '';
  let sanitized = css;
  // Prevent CSS-to-HTML breakout via </style> injection
  sanitized = sanitized.replace(/<\s*\/\s*style/gi, '<\\/style');
  sanitized = sanitized.replace(/@import\s+[^;]+;?/gi, '');
  sanitized = sanitized.replace(/@charset\s+[^;]+;?/gi, '');
  sanitized = sanitized.replace(/expression\s*\(/gi, '');
  sanitized = sanitized.replace(/behavior\s*:/gi, 'blocked-behavior:');
  sanitized = sanitized.replace(/-moz-binding\s*:/gi, 'blocked-moz-binding:');
  sanitized = sanitized.replace(/javascript\s*:/gi, 'blocked-javascript:');
  // Block external resource loading via url() — allow data: URIs only
  sanitized = sanitized.replace(/url\s*\(\s*(['"]?)\s*https?:\/\//gi, 'url($1blocked://');
  return sanitized;
};

const sanitizeHtml = (html: string) => {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'iframe', 'embed', 'object', 'form'],
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
    ALLOW_DATA_ATTR: false,
  });
};

interface ShadowDomPreviewProps {
  htmlContent: string;
  cssContent: string;
  /** 紧凑模式：去除容器边距和圆角 */
  compact?: boolean;
  /** 可选高度 */
  height?: number;
  /** 渲染保真模式：anki 模式尽量贴近 Anki WebView 渲染 */
  fidelity?: 'default' | 'anki';
}

export const ShadowDomPreview: React.FC<ShadowDomPreviewProps> = ({
  htmlContent,
  cssContent,
  compact = false,
  height,
  fidelity = 'default',
}) => {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [iframeHeight, setIframeHeight] = useState<number>(height || 200);

  const srcdoc = useMemo(() => {
    const safeCss = sanitizeCss(cssContent);
    const safeHtml = sanitizeHtml(htmlContent);
    const isAnkiFidelity = fidelity === 'anki';
    const bodyContent = isAnkiFidelity
      ? safeHtml
      : `<div class="card-content-container">${safeHtml}</div>`;

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  html, body {
    margin: 0;
    padding: 0;
    background: ${compact || isAnkiFidelity ? 'transparent' : 'white'};
    overflow: hidden;
    max-width: 100%;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  .card-content-container {
    background: ${compact ? 'transparent' : 'white'};
    border-radius: ${compact ? '0' : '16px'};
    padding: ${compact ? '4px' : '20px'};
    box-sizing: border-box;
    overflow: visible;
    position: relative;
    max-width: 100%;
  }
  .card-content-container * {
    max-width: 100%;
    box-sizing: border-box;
  }
  img, video, canvas, svg {
    max-width: 100%;
    height: auto;
  }
  table {
    max-width: 100%;
    overflow-x: auto;
    display: block;
  }
  pre, code {
    max-width: 100%;
    overflow-x: auto;
    word-wrap: break-word;
  }
  ${safeCss}
</style>
<script>
  new ResizeObserver(function() {
    var h = document.body ? document.body.scrollHeight : 0;
    if (h > 0) window.parent.postMessage({ type: 'sdp-resize', height: h }, '*');
  }).observe(document.documentElement);
  window.addEventListener('load', function() {
    var h = document.body ? document.body.scrollHeight : 0;
    if (h > 0) window.parent.postMessage({ type: 'sdp-resize', height: h }, '*');
  });
</script>
</head>
<body>
${bodyContent}
</body>
</html>`;
  }, [htmlContent, cssContent, compact, fidelity]);

  useEffect(() => {
    const handleMessage = (e: MessageEvent) => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      if (e.data?.type === 'sdp-resize' && typeof e.data.height === 'number') {
        const h = Math.max(20, Math.min(e.data.height, 5000));
        if (Number.isFinite(h)) setIframeHeight(h);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-scripts"
      srcDoc={srcdoc}
      style={{
        display: 'block',
        width: '100%',
        maxWidth: '100%',
        height: iframeHeight,
        border: 'none',
        overflow: 'hidden',
      }}
      title="card-preview"
    />
  );
};

export default ShadowDomPreview;
