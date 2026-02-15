import React, { useEffect, useState, useRef, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import { Copy, Check, Plus, Minus, RotateCcw, AlertTriangle } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';

// ============================================================================
// HTML 转义辅助函数（防止 XSS）
// ============================================================================

/**
 * 转义 HTML 特殊字符，防止将用户可控字符串拼入 innerHTML 时产生 XSS
 */
const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

// ============================================================================
// Mermaid 主题配置
// ============================================================================

/**
 * 获取 mermaid 主题配置
 * 使用 Mermaid 官方内置主题，确保最佳兼容性和可读性
 * - 亮色模式：使用 'neutral' 主题（高对比度灰色系，适合各种图表）
 * - 暗色模式：使用 'dark' 主题（官方暗色主题，经过充分测试）
 */
const getMermaidThemeConfig = (isDark: boolean) => {
  // 通用字体配置
  const fontFamily = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
  
  if (isDark) {
    // 暗色模式 - 使用官方 dark 主题
    return {
      theme: 'dark' as const,
      themeVariables: {
        fontFamily,
        fontSize: '14px',
      },
    };
  } else {
    // 亮色模式 - 使用官方 neutral 主题（高对比度，适合 mindmap 等各种图表）
    return {
      theme: 'neutral' as const,
      themeVariables: {
        fontFamily,
        fontSize: '14px',
      },
    };
  }
};

export interface CodeBlockProps {
  children: any;
  className?: string;
  /** 是否正在流式生成 */
  isStreaming?: boolean;
}

// ============================================================================
// Mermaid 错误边界组件
// ============================================================================

interface MermaidErrorBoundaryProps {
  children: ReactNode;
  /** 原始代码内容，错误时显示 */
  fallbackCode: string;
  /** 代码语言 */
  language: string;
  /** 重置回调 */
  onReset?: () => void;
}

interface MermaidErrorBoundaryState {
  hasError: boolean;
  error: string | null;
  /** 用于检测 props 变化的前一次 fallbackCode */
  prevFallbackCode?: string;
}

/**
 * Mermaid 渲染错误边界
 * 当 Mermaid/SVG/HTML 渲染出错时，显示原始代码作为降级 UI
 */
class MermaidErrorBoundary extends Component<MermaidErrorBoundaryProps, MermaidErrorBoundaryState> {
  constructor(props: MermaidErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: unknown): MermaidErrorBoundaryState {
    return { hasError: true, error: getErrorMessage(error) };
  }

  // 当 fallbackCode 变化时（新的代码块），自动重置错误状态
  static getDerivedStateFromProps(
    props: MermaidErrorBoundaryProps,
    state: MermaidErrorBoundaryState
  ): Partial<MermaidErrorBoundaryState> | null {
    if (state.prevFallbackCode !== props.fallbackCode) {
      // 代码内容变化，重置错误状态
      return {
        hasError: false,
        error: null,
        prevFallbackCode: props.fallbackCode,
      };
    }
    return null;
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo): void {
    console.error('[CodeBlock] Mermaid render error:', getErrorMessage(error), errorInfo.componentStack);
  }

  handleReset = (): void => {
    this.setState({ hasError: false, error: null });
    this.props.onReset?.();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // 使用内部包装组件来获取 i18n
      return (
        <MermaidErrorFallbackUI
          error={this.state.error}
          language={this.props.language}
          fallbackCode={this.props.fallbackCode}
          onReset={this.handleReset}
        />
      );
    }
    return this.props.children;
  }
}

// 错误回退 UI 组件（函数组件，可使用 hooks）
interface MermaidErrorFallbackUIProps {
  error: string | null;
  language: string;
  fallbackCode: string;
  onReset: () => void;
}

const MermaidErrorFallbackUI: React.FC<MermaidErrorFallbackUIProps> = ({
  error,
  language,
  fallbackCode,
  onReset,
}) => {
  const { t } = useTranslation('chatV2');
  
  return (
    <div className="mermaid-error-boundary">
      <div className="mermaid-error-header">
        <AlertTriangle size={16} className="mermaid-error-icon" />
        <span className="mermaid-error-title">
          {t('codeBlock.renderFailed', '渲染失败')}
        </span>
        <NotionButton variant="ghost" size="sm" className="mermaid-error-reset" onClick={onReset}>
          {t('codeBlock.retry', '重试')}
        </NotionButton>
      </div>
      <div className="mermaid-error-message">
        {error || t('codeBlock.unknownError', '未知错误')}
      </div>
      <pre className="code-block mermaid-fallback-code">
        <code className={`language-${language}`}>
          {fallbackCode}
        </code>
      </pre>
    </div>
  );
};

// ============================================================================
// CodeBlock 主组件
// ============================================================================

export const CodeBlock: React.FC<CodeBlockProps> = ({ children, className, isStreaming }) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null);
  const [showRendered, setShowRendered] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [lastMouse, setLastMouse] = useState<{ x: number; y: number } | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const svgSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const contentOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [mermaidError, setMermaidError] = useState<string | null>(null);
  const errorBoundaryKey = useRef(0);
  
  // 生命周期跟踪：防止组件卸载后更新状态
  const isMountedRef = useRef(true);
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);
  const [contentSize, setContentSize] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  
  // 复制状态定时器引用，用于清理
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
    };
  }, []);

  // 兼容 children 为数组或字符串
  const rawChildren = Array.isArray(children) ? (children as any[]).join('') : String(children ?? '');
  const codeContent = rawChildren.replace(/\n$/, '');

  // 记录上一次的代码内容用于防抖比较
  const prevCodeRef = useRef<string>('');

  // 当代码内容变更时，重置渲染状态
  // 使用 useMemo 避免流式过程中频繁触发
  useEffect(() => {
    // 流式过程中不重置（除非内容完全不同的新代码块）
    if (isStreaming && renderedSvg) {
      return;
    }
    // 只有内容真正稳定后才重置
    if (prevCodeRef.current !== codeContent) {
      prevCodeRef.current = codeContent;
      setRenderedSvg(null);
      setShowRendered(false);
      setScale(1);
      setOffset({ x: 0, y: 0 });
      setMermaidError(null);
      didAutoFitRef.current = false;
    }
  }, [codeContent, isStreaming, renderedSvg]);

  // 切回渲染视图时允许再次自动适配
  useEffect(() => {
    if (showRendered) {
      didAutoFitRef.current = false;
    }
  }, [showRendered]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeContent);
      setCopied(true);
      // 清理之前的定时器，避免多次点击累积
      if (copyTimeoutRef.current) {
        clearTimeout(copyTimeoutRef.current);
      }
      copyTimeoutRef.current = setTimeout(() => {
        if (isMountedRef.current) {
          setCopied(false);
        }
      }, 2000);
      try { showGlobalNotification('success', t('codeBlock.copySuccess', '已复制代码到剪贴板'), t('codeBlock.copySuccessTitle', '复制成功')); } catch {}
    } catch (err: unknown) {
      console.error('[CodeBlock] Copy failed:', getErrorMessage(err));
    }
  };

  // 提取语言信息
  const language = className?.replace('language-', '') || 'text';
  const langLower = language.toLowerCase();
  const canRunMermaid = langLower === 'mermaid';
  const canRenderSvg = langLower === 'svg';
  const canRenderHtml = langLower === 'html' || langLower === 'htm';
  const canRenderXml = langLower === 'xml';

  const handleRunMermaid = async () => {
    if (!canRunMermaid || isStreaming) return;
    try {
      setRunning(true);
      setMermaidError(null);
      const lib: any = await import('mermaid');
      
      if (!isMountedRef.current) return;
      
      const mermaid = lib?.default ?? lib;
      
      const currentIsDark = document.documentElement.classList.contains('dark') ||
                            document.documentElement.getAttribute('data-theme') === 'dark';
      const themeConfig = getMermaidThemeConfig(currentIsDark);
      
      if (mermaid?.initialize) {
        mermaid.initialize({ 
          startOnLoad: false, 
          securityLevel: 'strict',
          ...themeConfig,
          flowchart: { useMaxWidth: true },
          sequence: { useMaxWidth: true },
        });
      }
      const id = `mermaid-${Math.random().toString(36).slice(2)}`;
      let svg: string | null = null;
      if (mermaid?.render) {
        const out = await mermaid.render(id, codeContent);
        svg = out?.svg || null;
      } else if (mermaid?.default?.render) {
        const out = await mermaid.default.render(id, codeContent);
        svg = out?.svg || null;
      } else {
        // 回退：尝试运行时渲染（需要 DOM 中存在 .mermaid 元素）
        svg = `<pre class="mermaid">${codeContent.replace(/</g, '&lt;')}</pre>`;
        if (mermaid?.run) {
          await mermaid.run();
        }
      }
      
      // 异步操作完成后再次检查组件是否已卸载
      if (!isMountedRef.current) return;
      
      setRenderedSvg(svg);
      setShowRendered(true);
    } catch (err: unknown) {
      // 组件卸载后不更新状态
      if (!isMountedRef.current) return;
      
      const errorMsg = getErrorMessage(err);
      console.error('[CodeBlock] Mermaid render failed:', errorMsg);
      setMermaidError(errorMsg);
      // 仍然设置一个错误提示的 SVG 内容，但保留切换到源码的能力
      setRenderedSvg(`<div class="mermaid-render-error"><span class="error-icon">⚠️</span><span class="error-text">${t('codeBlock.mermaidFailed', 'Mermaid 渲染失败')}：${escapeHtml(errorMsg)}</span></div>`);
      setShowRendered(true);
    } finally {
      // 组件卸载后不更新状态
      if (isMountedRef.current) {
        setRunning(false);
      }
    }
  };

  const clamp = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

  const handleRunSvg = () => {
    if (!canRenderSvg || isStreaming) return;
    try {
      setMermaidError(null);
      // 🔒 安全审计修复: 使用 DOMPurify 进行完整的 SVG 消毒
      // 替代原来不完整的正则 <script> 移除（遗漏了 <foreignObject>、on* 属性变体、SVG animate 等向量）
      const sanitized = DOMPurify.sanitize(String(codeContent), {
        USE_PROFILES: { svg: true, svgFilters: true },
        ADD_TAGS: ['style'], // SVG 内联样式
        FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'embed', 'object'],
        FORBID_ATTR: ['xlink:href'],
      });
      setRenderedSvg(sanitized);
      setShowRendered(true);
    } catch (err: unknown) {
      const errorMsg = getErrorMessage(err);
      console.error('[CodeBlock] SVG render failed:', errorMsg);
      setMermaidError(errorMsg);
      setRenderedSvg(`<div class="mermaid-render-error"><span class="error-icon">⚠️</span><span class="error-text">${t('codeBlock.svgFailed', 'SVG 渲染失败')}：${escapeHtml(errorMsg)}</span></div>`);
      setShowRendered(true);
    }
  };

  const sanitizeForIframe = (html: string) => {
    // 🔒 安全审计修复: 使用 DOMPurify 替代不完整的正则过滤
    return DOMPurify.sanitize(String(html), {
      WHOLE_DOCUMENT: false,
      FORBID_TAGS: ['script', 'iframe', 'embed', 'object', 'base'],
    });
  };

  const buildIframeDoc = (inner: string) => `<!doctype html><html><head><meta charset=\"utf-8\"><style>
    html,body{margin:0;padding:0;background:#fff;color:#111;overflow:visible!important;height:auto;min-width:0}
    *,*:before,*:after{box-sizing:border-box}
    /* 避免外部 CSS 干扰，使用 iframe 独立环境 */
    /* 让页面尺寸由内容决定，供父层测量 */
    body { display: inline-block; }
    /* 基于内容自动包裹宽高 */
    svg, img, canvas, table, pre, code, div, section, article { max-width: none !important; }
  </style></head><body>${inner}</body></html>`;

  const handleRunHtml = () => {
    if (!canRenderHtml || isStreaming) return;
    try {
      setMermaidError(null);
      const doc = buildIframeDoc(sanitizeForIframe(codeContent));
      // 使用 iframe + srcdoc 隔离样式
      const srcdoc = doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      // 初始不给 width/height，等待测量后外层控制缩放
      setRenderedSvg(`<iframe data-html-preview sandbox="allow-same-origin" style="display:block;border:0;" srcdoc="${srcdoc}"></iframe>`);
      setShowRendered(true);
    } catch (err: unknown) {
      const errorMsg = getErrorMessage(err);
      console.error('[CodeBlock] HTML render failed:', errorMsg);
      setMermaidError(errorMsg);
      setRenderedSvg(`<div class="mermaid-render-error"><span class="error-icon">⚠️</span><span class="error-text">${t('codeBlock.htmlFailed', 'HTML 渲染失败')}：${escapeHtml(errorMsg)}</span></div>`);
      setShowRendered(true);
    }
  };

  const handleRunXml = () => {
    if (!canRenderXml || isStreaming) return;
    try {
      setMermaidError(null);
      const content = String(codeContent).trim();
      // 允许可选的 BOM、XML 声明与 DOCTYPE
      const isSvgXml = /^\uFEFF?(?:<\?xml[\s\S]*?\?>)?\s*(?:<!DOCTYPE[\s\S]*?>\s*)?<svg[\s>]/i.test(content);
      if (isSvgXml) {
        // 作为 SVG 渲染
        handleRunSvg();
        return;
      }
      // 其他 XML：在 iframe 中以可读方式展示
      const escaped = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const doc = buildIframeDoc(`<pre style="margin:0;padding:12px;font:12px/1.5 monospace;white-space:pre">${escaped}</pre>`);
      const srcdoc = doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      setRenderedSvg(`<iframe data-html-preview sandbox="allow-same-origin" srcdoc="${srcdoc}"></iframe>`);
      setShowRendered(true);
    } catch (err: unknown) {
      const errorMsg = getErrorMessage(err);
      console.error('[CodeBlock] XML render failed:', errorMsg);
      setMermaidError(errorMsg);
      setRenderedSvg(`<div class="mermaid-render-error"><span class="error-icon">⚠️</span><span class="error-text">${t('codeBlock.xmlFailed', 'XML 渲染失败')}：${escapeHtml(errorMsg)}</span></div>`);
      setShowRendered(true);
    }
  };

  const applyZoom = (factor: number, anchor?: { x: number; y: number }) => {
    const el = previewRef.current;
    setScale(oldScale => {
      const newScale = clamp(oldScale * factor, 0.05, 50);
      if (!el) return newScale;
      const cx = (anchor ? anchor.x : el.clientWidth / 2);
      const cy = (anchor ? anchor.y : el.clientHeight / 2);
      const O = contentOriginRef.current;
      // S = offset + (C - O) * scale
      const Cx = O.x + (cx - offset.x) / oldScale;
      const Cy = O.y + (cy - offset.y) / oldScale;
      const newOffsetX = cx - (Cx - O.x) * newScale;
      const newOffsetY = cy - (Cy - O.y) * newScale;
      setOffset({ x: newOffsetX, y: newOffsetY });
      return newScale;
    });
  };
  const handleZoomIn = () => applyZoom(1.2);
  const handleZoomOut = () => applyZoom(1/1.2);
  const handleResetView = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!showRendered) return;
    setPanning(true);
    setLastMouse({ x: e.clientX, y: e.clientY });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (!panning || !lastMouse) return;
    const dx = e.clientX - lastMouse.x;
    const dy = e.clientY - lastMouse.y;
    setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    setLastMouse({ x: e.clientX, y: e.clientY });
  };
  const endPan = () => { setPanning(false); setLastMouse(null); };

  // 计算 SVG/HTML 预览基础尺寸
  const didAutoFitRef = useRef(false);

  // 重置错误边界
  const handleErrorBoundaryReset = () => {
    errorBoundaryKey.current += 1;
    setMermaidError(null);
    setRenderedSvg(null);
    setShowRendered(false);
  };

  useEffect(() => {
    if (!renderedSvg || !showRendered) return;
    const el = previewRef.current;
    if (!el) return;
    const svg: SVGSVGElement | null = el.querySelector('svg');
    const iframeEl: HTMLIFrameElement | null = svg ? null : el.querySelector('iframe[data-html-preview]');
    if (!svg && !iframeEl) return;
    let w = 0, h = 0, ox = 0, oy = 0;
    if (svg) {
      // 优先使用 viewBox 尺寸，原点设为 (0,0) 以避免负坐标导致初始位移
      const vb = svg.getAttribute('viewBox');
      if (vb) {
        const parts = vb.trim().split(/\s+/).map(Number);
        if (parts.length === 4) { w = parts[2]; h = parts[3]; ox = 0; oy = 0; }
      }
      // 退回 getBBox 宽高（不使用 x/y 作为原点）
      if (!w || !h) {
        try {
          const g = svg.querySelector('g');
          const target: any = g || svg;
          if (target && target.getBBox) {
            const bb = target.getBBox();
            w = bb.width; h = bb.height; ox = 0; oy = 0;
          }
        } catch {}
      }
      if (!w || !h) {
        // 退化：尝试 width/height 属性
        w = Number(svg.getAttribute('width')) || el.clientWidth || 800;
        h = Number(svg.getAttribute('height')) || el.clientHeight || 600;
      }
      svgSizeRef.current = { width: w, height: h };
      contentOriginRef.current = { x: ox, y: oy };
      // 为 WebKit/Safari 修复：强制为 <svg> 写入像素尺寸，避免百分比导致的 0 宽高
      try {
        if (w > 0 && h > 0) {
          svg.setAttribute('width', String(w));
          svg.setAttribute('height', String(h));
          (svg.style as any).width = `${w}px`;
          (svg.style as any).height = `${h}px`;
        }
      } catch {}
    } else if (iframeEl) {
      const computeIframeSize = () => {
        try {
          const doc = iframeEl.contentDocument;
          if (!doc) return false;
          const root = doc.documentElement;
          const body = doc.body;
          // 强制触发回流一次，确保样式应用完全
          void body?.offsetWidth;
          const iw = Math.max(
            root.scrollWidth || 0,
            body?.scrollWidth || 0,
            root.getBoundingClientRect().width || 0,
            body?.getBoundingClientRect().width || 0
          );
          const ih = Math.max(
            root.scrollHeight || 0,
            body?.scrollHeight || 0,
            root.getBoundingClientRect().height || 0,
            body?.getBoundingClientRect().height || 0
          );
          if (iw && ih) {
            w = iw; h = ih;
            iframeEl.style.width = `${w}px`;
            iframeEl.style.height = `${h}px`;
            svgSizeRef.current = { width: w, height: h };
            contentOriginRef.current = { x: 0, y: 0 };
            setContentSize({ width: w, height: h });
            return true;
          }
        } catch {}
        return false;
      };
      // 若立即不可得，等 onload 后再计算
      if (!computeIframeSize()) {
        iframeEl.addEventListener('load', () => {
          // 组件可能已卸载，检查 isMountedRef
          if (!isMountedRef.current) return;
          computeIframeSize();
          requestAnimationFrame(() => {
            if (isMountedRef.current) {
              handleFitView();
            }
          });
        }, { once: true });
      }
    }
    // 同步内容容器的固有尺寸
    setContentSize({ width: w, height: h });
    // 首次渲染时自动适配
    if (!didAutoFitRef.current) {
      if (w > 0 && h > 0) {
        requestAnimationFrame(() => {
          handleFitView();
          didAutoFitRef.current = true;
        });
      } else {
        setScale(1);
        setOffset({ x: 0, y: 0 });
      }
    }
  }, [renderedSvg, showRendered]);

  // 监听视窗尺寸变化，自动适配
  useEffect(() => {
    const el = previewRef.current;
    if (!el || !showRendered) return;
    const ro = new ResizeObserver(() => {
      handleFitView();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [showRendered]);

  const handleFitView = () => {
    const el = previewRef.current;
    if (!el) return;
    const base = svgSizeRef.current;
    if (!base.width || !base.height) return;
    const pad = 0; // 贴边展示
    const cw = Math.max(10, el.clientWidth - pad);
    const ch = Math.max(10, el.clientHeight - pad);
    const k = Math.min(cw / base.width, ch / base.height);
    const z = Math.max(0.05, Math.min(50, k));
    setScale(z);
    // 基于内容原点的居中
    const O = contentOriginRef.current;
    const offX = (cw - base.width * z) / 2 - O.x * z;
    const offY = (ch - base.height * z) / 2 - O.y * z;
    setOffset({ x: offX, y: offY });
  };

  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        <span className="code-block-lang">{language}</span>
        <div className="code-block-actions">
          <NotionButton variant="ghost" size="sm" className="code-block-copy" onClick={handleCopy}>
            {copied ? <Check size={14} /> : <Copy size={14} />}
            <span>{copied ? t('codeBlock.copied', '已复制') : t('codeBlock.copy', '复制')}</span>
          </NotionButton>

          {(canRunMermaid || canRenderSvg || canRenderHtml || canRenderXml) && (
            renderedSvg ? (
              <NotionButton
                variant="ghost"
                size="sm"
                className="code-block-copy"
                onClick={() => setShowRendered(v => !v)}
                title={showRendered ? t('codeBlock.viewSource', '查看源码') : t('codeBlock.viewRender', '查看渲染')}
              >
                <span style={{ marginRight: 4 }}>{showRendered ? '</>' : '◎'}</span>
                <span>{showRendered ? t('codeBlock.source', '源码') : t('codeBlock.render', '渲染')}</span>
              </NotionButton>
            ) : (
              <NotionButton 
                variant="ghost"
                size="sm"
                className="code-block-copy" 
                onClick={
                  canRunMermaid ? handleRunMermaid :
                  canRenderSvg ? handleRunSvg :
                  canRenderHtml ? handleRunHtml :
                  handleRunXml
                }
                disabled={!!isStreaming || running}
                title={
                  canRunMermaid ? (isStreaming ? t('codeBlock.mermaidHint', '内容生成中，等待代码块封闭后再运行') : t('codeBlock.runMermaid', '运行 mermaid 渲染')) :
                  canRenderSvg ? t('codeBlock.renderSvg', '渲染 SVG') :
                  canRenderHtml ? t('codeBlock.renderHtml', '渲染 HTML (隔离于 iframe)') :
                  t('codeBlock.renderXml', '渲染 XML')
                }
              >
                <span style={{ marginRight: 4 }}>{running && canRunMermaid ? '…' : '▶'}</span>
                <span>{running && canRunMermaid ? t('codeBlock.running', '运行中') : t('codeBlock.render', '渲染')}</span>
              </NotionButton>
            )
          )}

          {(renderedSvg && showRendered) && (
            <>
              <NotionButton variant="ghost" size="icon" iconOnly className="code-block-copy" onClick={handleZoomOut} aria-label={t('codeBlock.zoomOut', '缩小')} title={t('codeBlock.zoomOut', '缩小')}>
                <Minus size={14} />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly className="code-block-copy" onClick={handleZoomIn} aria-label={t('codeBlock.zoomIn', '放大')} title={t('codeBlock.zoomIn', '放大')}>
                <Plus size={14} />
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly className="code-block-copy" onClick={handleFitView} aria-label={t('codeBlock.fitView', '适配视图')} title={t('codeBlock.fitView', '适配视图')}>
                <span style={{ fontSize: 12 }}>⤢</span>
              </NotionButton>
              <NotionButton variant="ghost" size="icon" iconOnly className="code-block-copy" onClick={handleResetView} aria-label={t('codeBlock.resetView', '重置视图')} title={t('codeBlock.resetView', '重置视图')}>
                <RotateCcw size={14} />
              </NotionButton>
            </>
          )}
        </div>
      </div>
      {renderedSvg && showRendered ? (
        <MermaidErrorBoundary
          key={errorBoundaryKey.current}
          fallbackCode={codeContent}
          language={language}
          onReset={handleErrorBoundaryReset}
        >
          <div
            className={`mermaid-preview ${panning ? 'panning' : ''} ${mermaidError ? 'has-error' : ''}`}
            ref={previewRef}
            onMouseDown={onMouseDown}
            onMouseMove={onMouseMove}
            onMouseUp={endPan}
            onMouseLeave={endPan}
            onDoubleClick={handleFitView}
            onWheel={(e) => {
              if (!(e.ctrlKey || e.metaKey)) return; // 需要修饰键
              e.preventDefault();
              const factor = e.deltaY < 0 ? 1.1 : 1/1.1;
              const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
              applyZoom(factor, anchor);
            }}
          >
            <div className="mermaid-canvas">
              <div
                className="mermaid-content"
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                  transformOrigin: '0 0',
                  width: contentSize.width || undefined,
                  height: contentSize.height || undefined
                }}
                dangerouslySetInnerHTML={{ __html: renderedSvg }}
              />
            </div>
          </div>
        </MermaidErrorBoundary>
      ) : (
        <pre className="code-block">
          <code className={className}>{children}</code>
        </pre>
      )}
    </div>
  );
};
