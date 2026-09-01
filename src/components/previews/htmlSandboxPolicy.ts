import DOMPurify from 'dompurify';

export type HtmlSandboxMode = 'chat-safe' | 'template-safe';

interface BuildHtmlSandboxDocumentOptions {
  html: string;
  css: string;
  mode: HtmlSandboxMode;
  compact?: boolean;
  height?: number | string;
  fidelity?: 'default' | 'anki';
}

// 自动高度测量：基础样式把 html/body 钉在 height/min-height:100%，此时
// body.scrollHeight 恒 ≥ iframe 视口高度，只涨不缩（棘轮）——瞬时窄宽渲染
// （如等比缩放预览首帧）产生的虚高会被永久锁定。测量时临时解除钉高取真实
// 内容高度，测完同步恢复，不影响渲染结果。
const TEMPLATE_RESIZE_SCRIPT = `<script>
  function sdpMeasure() {
    var b = document.body;
    if (!b) return 0;
    var de = document.documentElement;
    var deh = de.style.height, bh = b.style.height, bm = b.style.minHeight;
    de.style.height = 'auto'; b.style.height = 'auto'; b.style.minHeight = '0';
    var h = b.scrollHeight;
    de.style.height = deh; b.style.height = bh; b.style.minHeight = bm;
    return h;
  }
  new ResizeObserver(function() {
    var h = sdpMeasure();
    if (h > 0) window.parent.postMessage({ type: 'sdp-resize', height: h }, '*');
  }).observe(document.documentElement);
  window.addEventListener('load', function() {
    var h = sdpMeasure();
    if (h > 0) window.parent.postMessage({ type: 'sdp-resize', height: h }, '*');
  });
</script>`;

function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

export function sanitizeCssForPreview(css: string, _mode: HtmlSandboxMode): string {
  if (!css) return '';
  let sanitized = stripCssComments(css);
  sanitized = sanitized.replace(/\\[0-9a-fA-F]{1,6}\s?/g, '_');
  sanitized = sanitized.replace(/<\s*\/\s*style/gi, '<\\/style');
  sanitized = sanitized.replace(/@import\s+[^;]+;?/gi, '');
  sanitized = sanitized.replace(/@charset\s+[^;]+;?/gi, '');
  sanitized = sanitized.replace(/@font-face\s*\{[^}]*\}/gi, '');
  sanitized = sanitized.replace(/expression\s*\(/gi, '');
  sanitized = sanitized.replace(/behavior\s*:/gi, 'blocked-behavior:');
  sanitized = sanitized.replace(/-moz-binding\s*:/gi, 'blocked-moz-binding:');
  sanitized = sanitized.replace(/javascript\s*:/gi, 'blocked-javascript:');
  sanitized = sanitized.replace(/url\s*\(\s*(['"]?)\s*(.*?)\s*\1\s*\)/gi, (_match, quote, uri) => {
    const trimmed = String(uri).trim().toLowerCase();
    if (trimmed.startsWith('data:image/')) {
      return `url(${quote}${uri}${quote})`;
    }
    return `url(${quote}blocked${quote})`;
  });
  return sanitized;
}

export function sanitizeHtmlForPreview(html: string, mode: HtmlSandboxMode): string {
  if (!html) return '';
  const isFullDoc = /^\s*(<!doctype|<html[\s>])/i.test(html.trim());
  const forbidTags =
    mode === 'chat-safe'
      ? ['script', 'iframe', 'embed', 'object', 'form', 'base', 'link']
      : ['script', 'iframe', 'embed', 'object', 'form', 'base'];

  return DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: isFullDoc,
    ADD_TAGS: ['style', 'meta'],
    FORBID_TAGS: forbidTags,
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onblur'],
    ALLOW_DATA_ATTR: false,
  });
}

export function getHtmlSandboxPermissions(mode: HtmlSandboxMode): string {
  return mode === 'template-safe' ? 'allow-scripts' : '';
}

export function getHtmlSandboxCsp(mode: HtmlSandboxMode): string {
  if (mode === 'template-safe') {
    return [
      "default-src 'none'",
      "img-src data: blob: https:",
      "media-src data: blob: https:",
      "style-src 'unsafe-inline'",
      "font-src data:",
      "connect-src 'none'",
      "script-src 'unsafe-inline'",
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join('; ');
  }

  return [
    "default-src 'none'",
    "img-src data: blob: https:",
    "media-src data: blob: https:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "connect-src 'none'",
    "script-src 'none'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export function buildHtmlSandboxDocument({
  html,
  css,
  mode,
  compact = false,
  fidelity = 'default',
}: BuildHtmlSandboxDocumentOptions): string {
  const isAnkiFidelity = fidelity === 'anki';
  const bodyContent =
    isAnkiFidelity || mode === 'chat-safe'
      ? html
      : `<div class="card-content-container">${html}</div>`;

  const resizeScript = mode === 'template-safe' ? TEMPLATE_RESIZE_SCRIPT : '';
  const csp = getHtmlSandboxCsp(mode);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root {
    --preview-scrollbar-thumb: color-mix(in srgb, CanvasText 28%, transparent);
    --preview-scrollbar-track: transparent;
  }
  html, body {
    margin: 0;
    padding: 0;
    height: 100%;
    background: ${compact || isAnkiFidelity ? 'transparent' : 'white'};
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable both-edges;
    scrollbar-color: var(--scrollbar-thumb, var(--preview-scrollbar-thumb))
      var(--scrollbar-track, var(--preview-scrollbar-track));
    max-width: 100%;
    min-height: 100%;
    word-wrap: break-word;
    overflow-wrap: break-word;
    -webkit-overflow-scrolling: touch;
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
  /* KaTeX 豁免：内部绝对定位子元素对强制 max-width 敏感，强压会破坏公式布局；
     超宽的展示公式改为容器内横向滚动（与 table/pre 同策略），窄屏不再被裁剪。 */
  .katex, .katex * {
    max-width: none;
  }
  .katex-display {
    max-width: 100%;
    overflow-x: auto;
    overflow-y: hidden;
  }
  ${css}
</style>
${resizeScript}
</head>
<body>
${bodyContent}
</body>
</html>`;
}
