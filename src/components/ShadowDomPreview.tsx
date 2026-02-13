import React, { useRef, useEffect, useState, useCallback } from 'react';

const sanitizeCss = (css: string) => {
  if (!css) return '';
  let sanitized = css;
  sanitized = sanitized.replace(/@import\s+[^;]+;?/gi, '');
  sanitized = sanitized.replace(/expression\s*\(/gi, '');
  return sanitized;
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

  const adjustHeight = useCallback(() => {
    const iframe = iframeRef.current;
    if (!iframe?.contentDocument?.body) return;
    const body = iframe.contentDocument.body;
    const scrollH = body.scrollHeight;
    if (scrollH > 0) {
      setIframeHeight(scrollH);
    }
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const safeCss = sanitizeCss(cssContent);

    const handleLoad = () => {
      const doc = iframe.contentDocument;
      if (!doc) return;
      const isAnkiFidelity = fidelity === 'anki';
      const bodyContent = isAnkiFidelity
        ? htmlContent
        : `<div class="card-content-container">${htmlContent}</div>`;
      try {
        window.dispatchEvent(new CustomEvent('chatanki-debug-lifecycle', {
          detail: {
            level: 'debug',
            phase: 'render:stack',
            summary: `ShadowDomPreview load fidelity=${fidelity} compact=${compact} html=${htmlContent.length} css=${safeCss.length}`,
            detail: {
              fidelity,
              compact,
              htmlLength: htmlContent.length,
              cssLength: safeCss.length,
            },
          },
        }));
      } catch { /* debug only */ }

      const fullHtml = `<!DOCTYPE html>
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
</head>
<body>
${bodyContent}
</body>
</html>`;

      doc.open();
      doc.write(fullHtml);
      doc.close();

      // 高度自适应
      requestAnimationFrame(() => {
        adjustHeight();
        // 监听内部尺寸变化
        try {
          const ro = new ResizeObserver(() => adjustHeight());
          if (doc.body) ro.observe(doc.body);
          (iframe as any).__resizeObserver = ro;
        } catch (_) {}
      });

      // 监听 iframe 内部点击后可能引起的 DOM 变化，重新调整高度
      doc.addEventListener('click', () => {
        setTimeout(adjustHeight, 50);
        setTimeout(adjustHeight, 200);
      });
    };

    iframe.addEventListener('load', handleLoad);
    // 触发加载：设置空白 src
    iframe.src = 'about:blank';

    return () => {
      iframe.removeEventListener('load', handleLoad);
      if ((iframe as any).__resizeObserver) {
        try { (iframe as any).__resizeObserver.disconnect(); } catch (_) {}
        delete (iframe as any).__resizeObserver;
      }
    };
  }, [htmlContent, cssContent, compact, fidelity, adjustHeight]);

  return (
    <iframe
      ref={iframeRef}
      sandbox="allow-scripts allow-same-origin"
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
