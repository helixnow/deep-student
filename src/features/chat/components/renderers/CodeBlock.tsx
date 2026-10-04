import React, { useEffect, useLayoutEffect, useState, useRef, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import {
  Copy,
  Check,
  Plus,
  Minus,
  ArrowCounterClockwise,
  ArrowSquareOut,
  ArrowsInSimple,
  ArrowsOutSimple,
  Code,
  DownloadSimple,
  Eye,
  ImageSquare,
  Warning,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { IconSwap } from '@/components/ui/IconSwap';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { useTranslation } from 'react-i18next';
import DOMPurify from 'dompurify';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { CodeBlockShell } from '../ui/CodeBlockShell';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChatHtmlPreview } from '@/components/previews/ChatHtmlPreview';
import { htmlUsesScripts, shouldAutoPreviewHtml } from '@/components/previews/chatHtmlPreviewDocument';
import { launchSandboxWorkbench } from '@/features/sandbox/launchSandboxWorkbench';
import { shouldPauseHeavyContent } from '@/features/workbench/core/shellGestureFlags';
import { reportFrontendError } from '@/logging/errorReporter';
import { DEFAULT_RENDERER_CAPABILITIES, type RendererCapabilities } from './rendererCapabilities';
import { RichCodeRenderer, type RichCodeRendererKind } from './RichCodeRenderer';
import { CodeBlockMoreMenu, type CodeBlockMenuAction } from './CodeBlockMoreMenu';
import { sanitizeSvgMarkup } from './progressiveSvg';
import { useProgressiveSvg } from './useProgressiveSvg';
import { downloadHtmlSource, downloadSvgSource, saveSvgAsPng, type SaveResult } from './codeBlockExport';
// The blocked renderer needs the shared token palette without loading FlowToken.
import '../../styles/flowtoken-patched.css';

// Keep the shared Prism grammar bundle behind a code-only boundary. Plain prose
// and inline code never evaluate it, and completed blocks retain memoized output.
const LazySyntaxHighlighter = React.lazy(() => import('react-syntax-highlighter/dist/esm/prism'));

const HighlightContent: React.FC<{ children?: ReactNode }> = ({ children }) => <>{children}</>;

const HighlightedCode = React.memo(function HighlightedCode({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const language = className?.replace('language-', '').toLowerCase();
  const hasLanguage = language && !['text', 'plain', 'plaintext'].includes(language);

  // The code node belongs to this component, not the lazy fallback, so loading
  // grammars, appending streamed text and ending the stream do not replace it.
  return (
    <code className={className}>
      {hasLanguage ? (
        <React.Suspense fallback={children}>
          <LazySyntaxHighlighter
            language={language}
            useInlineStyles={false}
            PreTag={HighlightContent}
            CodeTag="span"
          >
            {children}
          </LazySyntaxHighlighter>
        </React.Suspense>
      ) : children}
    </code>
  );
});

/**
 * OS 模式拖/缩/settle 手势期让路：mermaid 解析/渲染主线程开销大，
 * 延迟重试到手势结束再跑（结果不变只是延后）。旗由 settle 桥接兜底清理，
 * 不会悬挂；轮询间隔与 SETTLE_BRIDGE_MS 同量级。
 */
const waitForShellGestureIdle = async (): Promise<void> => {
  while (shouldPauseHeavyContent()) {
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
};

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
  /** 用户已启用的可视化能力；未开启时始终以普通源码块显示。 */
  rendererCapabilities?: RendererCapabilities;
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
    console.error(
      '[CodeBlock] Mermaid render error:',
      getErrorMessage(error),
      error,
      errorInfo.componentStack,
    );
    void reportFrontendError(error, {
      kind: 'REACT_ERROR_BOUNDARY',
      component: 'mermaid-renderer',
      extra: {
        language: this.props.language,
        componentStack: errorInfo.componentStack,
      },
    }).catch(() => undefined);
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
        <Warning size={16} className="mermaid-error-icon" />
        <span className="mermaid-error-title">
          {t('codeBlock.renderFailed')}
        </span>
        <DsButton variant="ghost" size="sm" className="mermaid-error-reset [@media(pointer:coarse)]:!min-h-11" onClick={onReset}>
          {t('codeBlock.retry')}
        </DsButton>
      </div>
      <div className="mermaid-error-message">
        {error || t('codeBlock.unknownError')}
      </div>
      <ScrollArea orientation="both" className="mermaid-fallback-scroll-area">
        <pre className="code-block mermaid-fallback-code">
          <code className={`language-${language}`}>
            {fallbackCode}
          </code>
        </pre>
      </ScrollArea>
    </div>
  );
};

// ============================================================================
// CodeBlock 主组件
// ============================================================================

/**
 * 🚀 长会话性能：非流式消息的代码块容器启用渲染跳过（content-visibility）。
 * 离屏代码块（Shiki/mermaid/KaTeX 重 DOM）不再参与每帧 layout/paint，
 * 直渲染模式下流式冲刷的强制 layout 只覆盖可视区。contain-intrinsic-size
 * 的 auto 前缀让浏览器记住上次渲染尺寸，未渲染时回落 220px。
 * 流式中的消息不启用：活动内容必须真实参与吸底跟随的 layout。
 */
const IDLE_CODE_SHELL_STYLE: React.CSSProperties = {
  contentVisibility: 'auto',
  containIntrinsicSize: 'auto 220px',
};

/**
 * 图形预览视窗高度：按 SVG 固有宽高比随容器宽度计算，夹在 [MIN, MAX] 内。
 * 宽扁的图不再被塞进固定 420px 的大框；流式时根标签（含 viewBox）最先写完，
 * 首帧即确定高度，后续帧不跳动。触屏上限再压到 45% 视口高，避免一屏全是图。
 */
const PREVIEW_MIN_HEIGHT = 160;
const PREVIEW_MAX_HEIGHT = 420;

const getPreviewMaxHeight = (): number => {
  if (typeof window === 'undefined') return PREVIEW_MAX_HEIGHT;
  const coarse = typeof window.matchMedia === 'function' && window.matchMedia('(pointer: coarse)').matches;
  return coarse
    ? Math.max(PREVIEW_MIN_HEIGHT, Math.min(PREVIEW_MAX_HEIGHT, Math.round(window.innerHeight * 0.45)))
    : PREVIEW_MAX_HEIGHT;
};

const clampNumber = (val: number, min: number, max: number) => Math.max(min, Math.min(max, val));

/** 从 HTML 的 <title> 推一个文件名，缺省 page.html */
const htmlFileNameFor = (source: string): string => {
  const title = /<title[^>]*>([^<]{1,80})<\/title>/i.exec(source)?.[1]?.trim();
  const safe = title
    ? Array.from(title).filter((ch) => ch.charCodeAt(0) >= 32).join('')
      .replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
  return `${safe || 'page'}.html`;
};

export const CodeBlock: React.FC<CodeBlockProps> = ({
  children,
  className,
  isStreaming,
  rendererCapabilities = DEFAULT_RENDERER_CAPABILITIES,
}) => {
  const { t } = useTranslation('chatV2');
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);
  const [renderedSvg, setRenderedSvg] = useState<string | null>(null);
  const [showRendered, setShowRendered] = useState(false);
  const [showRichRenderer, setShowRichRenderer] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const [lastMouse, setLastMouse] = useState<{ x: number; y: number } | null>(null);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const svgSizeRef = useRef<{ width: number; height: number }>({ width: 0, height: 0 });
  const contentOriginRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const [mermaidError, setMermaidError] = useState<string | null>(null);
  const errorBoundaryKey = useRef(0);
  /** SVG 代码块：默认预览（流式渐进渲染），菜单可切到源码 */
  const [svgView, setSvgView] = useState<'preview' | 'source'>('preview');
  /** HTML 代码块：null = 按内容自动决定（完整文档/带样式默认预览） */
  const [htmlViewOverride, setHtmlViewOverride] = useState<'preview' | 'source' | null>(null);
  const [htmlExpanded, setHtmlExpanded] = useState(false);
  /** HTML 内容高度超出收起态上限（才需要"展开"按钮） */
  const [htmlOverflowing, setHtmlOverflowing] = useState(false);
  /** 图形预览视窗高度（按宽高比计算）；null 时用 CSS 默认 */
  const [previewHeight, setPreviewHeight] = useState<number | null>(null);
  /** 用户手动缩放/平移过：之后的新帧与容器尺寸变化不再自动适配，尊重用户视角 */
  const userAdjustedRef = useRef(false);

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

  // 提取语言信息
  const language = className?.replace('language-', '') || 'text';
  const langLower = language.toLowerCase();
  const canRunMermaid = langLower === 'mermaid';
  const canRenderSvg = langLower === 'svg';
  const canRenderHtml = langLower === 'html' || langLower === 'htm';
  const canRenderXml = langLower === 'xml';
  const richRendererKind: RichCodeRendererKind | null =
    rendererCapabilities.charts && (langLower === 'vega-lite' || langLower === 'vega') ? 'vega-lite' :
    rendererCapabilities.graphviz && langLower === 'dot' ? 'dot' :
    rendererCapabilities.music && langLower === 'abc' ? 'abc' :
    rendererCapabilities.timing && langLower === 'wavedrom' ? 'wavedrom' :
    rendererCapabilities.chemicalFiles && ['mol', 'molfile', 'sdf'].includes(langLower) ? 'molecule-2d' :
    rendererCapabilities.molecular3d && langLower === 'pdb' ? 'molecule-3d' :
    rendererCapabilities.geojson && langLower === 'geojson' ? 'geojson' : null;
  const canRenderRich = richRendererKind !== null;
  /** SVG / HTML 走自动预览 + 「…」菜单；其余可视化保持手动「运行」 */
  const hasLivePreview = canRenderSvg || canRenderHtml;

  // ---- SVG：流式渐进渲染 ----
  const progressiveSvg = useProgressiveSvg(codeContent, !!isStreaming, canRenderSvg && svgView === 'preview');
  // 流式中根标签尚未写完时先给出预览占位；流结束仍无合法 SVG 则退回源码
  const svgPreviewActive = canRenderSvg && svgView === 'preview' && (progressiveSvg !== null || !!isStreaming);

  // ---- HTML：完整文档默认预览 ----
  const htmlView: 'preview' | 'source' = canRenderHtml
    ? htmlViewOverride ?? (shouldAutoPreviewHtml(codeContent) ? 'preview' : 'source')
    : 'source';
  const htmlPreviewActive = canRenderHtml && htmlView === 'preview';

  /** 当前在图形预览视窗（缩放/平移）里显示的标记 */
  const previewMarkup = canRenderSvg ? (svgPreviewActive ? progressiveSvg : null) : (showRendered ? renderedSvg : null);
  const previewVisible = canRenderSvg ? svgPreviewActive : !!(renderedSvg && showRendered);

  // 记录上一次的代码内容用于防抖比较
  const prevCodeRef = useRef<string>('');
  const didAutoFitRef = useRef(false);
  /** 上次布局所在的视窗元素：切回预览（视窗重新挂载）时需要重新布局 */
  const lastPreviewElRef = useRef<HTMLDivElement | null>(null);

  // 当代码内容变更时，重置手动渲染（mermaid / xml）的状态。
  // SVG / HTML 预览随内容实时更新，不参与重置（否则流结束那一刻预览会被清掉）。
  useEffect(() => {
    if (hasLivePreview) return;
    // 流式过程中不重置（除非内容完全不同的新代码块）
    if (isStreaming && renderedSvg) {
      return;
    }
    // 只有内容真正稳定后才重置
    if (prevCodeRef.current !== codeContent) {
      prevCodeRef.current = codeContent;
      setRenderedSvg(null);
      setShowRichRenderer(false);
      setShowRendered(false);
      setScale(1);
      setOffset({ x: 0, y: 0 });
      setMermaidError(null);
      setPreviewHeight(null);
      userAdjustedRef.current = false;
      didAutoFitRef.current = false;
    }
  }, [codeContent, hasLivePreview, isStreaming, renderedSvg]);

  // 设置关闭后立刻退回源码，避免已卸载能力仍留在消息中继续渲染。
  useEffect(() => {
    setShowRichRenderer(false);
  }, [rendererCapabilities]);

  const handleCopy = async () => {
    try {
      await copyTextToClipboard(codeContent);
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
      try { showGlobalNotification('success', t('codeBlock.copySuccess'), t('codeBlock.copySuccessTitle')); } catch {}
    } catch (err: unknown) {
      console.error('[CodeBlock] Copy failed:', getErrorMessage(err));
      try { showGlobalNotification('error', t('codeBlock.copyFailed'), t('codeBlock.copyFailedTitle')); } catch {}
    }
  };

  /** 保存类动作的统一反馈：取消不提示，成功/失败给出通知 */
  const runSaveAction = async (action: () => Promise<SaveResult>, failureKey: 'codeBlock.saveFailed' | 'codeBlock.imageExportFailed') => {
    try {
      const result = await action();
      if (!result.canceled) {
        try { showGlobalNotification('success', t('codeBlock.saved')); } catch {}
      }
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      console.error('[CodeBlock] Save failed:', message);
      try { showGlobalNotification('error', t(failureKey, { message })); } catch {}
    }
  };

  const handleRunMermaid = async () => {
    if (!canRunMermaid || isStreaming) return;
    const id = `mermaid-${Math.random().toString(36).slice(2)}`;
    try {
      setRunning(true);
      setMermaidError(null);
      // 手势期不启动渲染，结束后再跑（拖拽热路径禁止 mermaid 抢帧）
      await waitForShellGestureIdle();
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
      let svg: string | null = null;
      if (mermaid?.render) {
        const out = await mermaid.render(id, codeContent);
        svg = out?.svg || null;
      } else if (mermaid?.default?.render) {
        const out = await mermaid.default.render(id, codeContent);
        svg = out?.svg || null;
      } else {
        svg = `<pre class="mermaid">${codeContent.replace(/</g, '&lt;')}</pre>`;
        if (mermaid?.run) {
          await mermaid.run();
        }
      }
      if (svg) {
        svg = DOMPurify.sanitize(svg, {
          USE_PROFILES: { svg: true, svgFilters: true },
          ADD_TAGS: ['style', 'foreignObject'],
          FORBID_TAGS: ['script', 'iframe', 'embed', 'object'],
          FORBID_ATTR: ['xlink:href'],
        });
      }

      // 异步操作完成后再次检查组件是否已卸载
      if (!isMountedRef.current) return;

      setRenderedSvg(svg);
      setShowRendered(true);
    } catch (err: unknown) {
      // mermaid.render 解析失败时会把错误图（id / d+id）残留在 document.body 上，
      // 必须手动移除，否则每次失败渲染都会泄漏一个孤儿 DOM 节点
      try {
        document.getElementById(id)?.remove();
        document.getElementById(`d${id}`)?.remove();
      } catch {}

      // 组件卸载后不更新状态
      if (!isMountedRef.current) return;

      const errorMsg = getErrorMessage(err);
      console.error('[CodeBlock] Mermaid render failed:', errorMsg);
      setMermaidError(errorMsg);
      // 仍然设置一个错误提示的 SVG 内容，但保留切换到源码的能力
      setRenderedSvg(`<div class="mermaid-render-error"><span class="error-icon">⚠️</span><span class="error-text">${escapeHtml(t('codeBlock.errorWithDetail', { message: t('codeBlock.mermaidFailed'), detail: errorMsg }))}</span></div>`);
      setShowRendered(true);
    } finally {
      // 组件卸载后不更新状态
      if (isMountedRef.current) {
        setRunning(false);
      }
    }
  };

  const buildIframeDoc = (inner: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:#fff;color:#111;overflow:visible!important;height:auto;min-width:0}
    *,*:before,*:after{box-sizing:border-box}
    /* 避免外部 CSS 干扰，使用 iframe 独立环境 */
    /* 让页面尺寸由内容决定，供父层测量 */
    body { display: inline-block; }
    /* 基于内容自动包裹宽高 */
    svg, img, canvas, table, pre, code, div, section, article { max-width: none !important; }
  </style></head><body>${inner}</body></html>`;

  const handleRunXml = () => {
    if (!canRenderXml || isStreaming) return;
    try {
      setMermaidError(null);
      const content = String(codeContent).trim();
      // 允许可选的 BOM、XML 声明与 DOCTYPE
      const isSvgXml = /^\uFEFF?(?:<\?xml[\s\S]*?\?>)?\s*(?:<!DOCTYPE[\s\S]*?>\s*)?<svg[\s>]/i.test(content);
      if (isSvgXml) {
        // 作为 SVG 渲染（🔒 DOMPurify 完整消毒，见 progressiveSvg.sanitizeSvgMarkup）
        setRenderedSvg(sanitizeSvgMarkup(content));
        setShowRendered(true);
        return;
      }
      // 其他 XML：在 iframe 中以可读方式展示
      const escaped = content
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const doc = buildIframeDoc(`<pre style="margin:0;padding:12px;font:12px/1.5 monospace;white-space:pre">${escaped}</pre>`);
      const srcdoc = doc.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
      setRenderedSvg(`<iframe data-html-preview sandbox="" srcdoc="${srcdoc}"></iframe>`);
      setShowRendered(true);
    } catch (err: unknown) {
      const errorMsg = getErrorMessage(err);
      console.error('[CodeBlock] XML render failed:', errorMsg);
      setMermaidError(errorMsg);
      setRenderedSvg(`<div class="mermaid-render-error"><span class="error-icon">⚠️</span><span class="error-text">${escapeHtml(t('codeBlock.errorWithDetail', { message: t('codeBlock.xmlFailed'), detail: errorMsg }))}</span></div>`);
      setShowRendered(true);
    }
  };

  const handleOpenSandbox = () => {
    if (!canRenderHtml || isStreaming) return;

    launchSandboxWorkbench({
      sourceType: 'chat-code-block',
      sourceMessageId: 'chat-code-block',
      language: langLower,
      title: t('codeBlock.sandboxTitle'),
      content: codeContent,
    });
  };

  /** 按给定视窗尺寸把内容等比适配并居中 */
  const fitTo = (cw: number, ch: number) => {
    const base = svgSizeRef.current;
    if (!base.width || !base.height) return;
    const w = Math.max(10, cw);
    const h = Math.max(10, ch);
    const k = Math.min(w / base.width, h / base.height);
    const z = Math.max(0.05, Math.min(50, k));
    setScale(z);
    // 基于内容原点的居中
    const O = contentOriginRef.current;
    setOffset({ x: (w - base.width * z) / 2 - O.x * z, y: (h - base.height * z) / 2 - O.y * z });
  };

  const handleFitView = () => {
    const el = previewRef.current;
    if (!el) return;
    userAdjustedRef.current = false;
    fitTo(el.clientWidth, el.clientHeight);
  };

  /**
   * 视窗布局：按宽高比算出高度（仅 SVG 内容），未被用户手动调整时自动适配。
   * 在 layout effect / ResizeObserver 中调用，新高度与适配在同一帧生效。
   */
  const layoutPreview = () => {
    const el = previewRef.current;
    const base = svgSizeRef.current;
    if (!el || !base.width || !base.height) return;
    const cw = el.clientWidth;
    let ch = el.clientHeight;
    if (el.querySelector('svg') && cw > 0) {
      ch = clampNumber(Math.round((cw * base.height) / base.width), PREVIEW_MIN_HEIGHT, getPreviewMaxHeight());
      setPreviewHeight((prev) => (prev === ch ? prev : ch));
    }
    if (!userAdjustedRef.current) {
      fitTo(cw, ch);
    }
    didAutoFitRef.current = true;
  };
  const layoutPreviewRef = useRef(layoutPreview);
  layoutPreviewRef.current = layoutPreview;
  const handleFitViewRef = useRef(handleFitView);
  handleFitViewRef.current = handleFitView;

  const applyZoom = (factor: number, anchor?: { x: number; y: number }) => {
    const el = previewRef.current;
    userAdjustedRef.current = true;
    setScale(oldScale => {
      const newScale = clampNumber(oldScale * factor, 0.05, 50);
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
    userAdjustedRef.current = true;
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  // P1-11: 平移改用 Pointer Events —— 鼠标 / 触摸 / 触控笔统一处理。
  // 精确指针下 CSS touch-action: none；触屏（pointer: coarse）为 pan-y——纵向拖动
  // 交还页面滚动（浏览器派发 pointercancel → endPan），横向起手的拖动才平移图表，
  // 避免整屏高的预览把对话滚动困住（见 markdown.css .mermaid-preview）。
  const onPanPointerDown = (e: React.PointerEvent) => {
    if (!previewVisible) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    // 捕获指针：拖出预览区域时 move/up 事件不丢失（替代原 onMouseLeave 兜底）
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setPanning(true);
    setLastMouse({ x: e.clientX, y: e.clientY });
  };
  const onPanPointerMove = (e: React.PointerEvent) => {
    if (!panning || !lastMouse) return;
    const dx = e.clientX - lastMouse.x;
    const dy = e.clientY - lastMouse.y;
    if (dx !== 0 || dy !== 0) userAdjustedRef.current = true;
    setOffset(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    setLastMouse({ x: e.clientX, y: e.clientY });
  };
  const endPan = () => { setPanning(false); setLastMouse(null); };
  const onPanPointerUp = (e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    }
    endPan();
  };

  // React 17+ 在根容器以 passive 模式绑定 wheel 事件，onWheel 里的
  // preventDefault() 会被忽略：ctrl+滚轮缩放预览时页面/WebView 仍会同步缩放滚动，
  // 且控制台报 "Unable to preventDefault inside passive event listener"。
  // 改用原生非 passive 监听器；handler 存 ref，避免 offset/scale 闭包过期。
  const wheelHandlerRef = useRef<(e: WheelEvent) => void>(() => {});
  wheelHandlerRef.current = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return; // 需要修饰键
    e.preventDefault();
    const el = previewRef.current;
    if (!el) return;
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    const rect = el.getBoundingClientRect();
    applyZoom(factor, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  useEffect(() => {
    if (!previewVisible) return;
    const el = previewRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => wheelHandlerRef.current(e);
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, [previewVisible]);

  // 重置错误边界
  const handleErrorBoundaryReset = () => {
    errorBoundaryKey.current += 1;
    setMermaidError(null);
    setRenderedSvg(null);
    setShowRendered(false);
  };

  // 每帧新标记提交后、绘制前测量并固定尺寸：流式渐进渲染时新帧与旧帧尺寸一致，
  // 视窗与变换保持不变，不会出现"先按错误尺寸画一帧再跳回"的闪动。
  useLayoutEffect(() => {
    if (!previewMarkup || !previewVisible) return;
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
        const parts = vb.trim().split(/[\s,]+/).map(Number);
        if (parts.length === 4) { w = parts[2]; h = parts[3]; ox = 0; oy = 0; }
      }
      // 次选 width/height 像素属性
      if (!w || !h) {
        const aw = Number(svg.getAttribute('width'));
        const ah = Number(svg.getAttribute('height'));
        if (aw > 0 && ah > 0) { w = aw; h = ah; }
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
        w = el.clientWidth || 800;
        h = el.clientHeight || 600;
      }
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
              handleFitViewRef.current();
            }
          });
        }, { once: true });
      }
      if (!w || !h) return;
    }
    const prevSize = svgSizeRef.current;
    const sizeChanged = prevSize.width !== w || prevSize.height !== h;
    svgSizeRef.current = { width: w, height: h };
    contentOriginRef.current = { x: ox, y: oy };
    // 同步内容容器的固有尺寸
    setContentSize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    const elChanged = lastPreviewElRef.current !== el;
    lastPreviewElRef.current = el;
    // 首帧、视窗重新挂载或固有尺寸变化时重新布局（流式新帧尺寸不变则视角保持不动）
    if (sizeChanged || elChanged || !didAutoFitRef.current) {
      layoutPreviewRef.current();
    }
  }, [previewMarkup, previewVisible]);

  // 监听视窗尺寸变化，自动适配
  useEffect(() => {
    const el = previewRef.current;
    if (!el || !previewVisible) return;
    if (typeof ResizeObserver !== 'function') return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      // 只响应宽度变化：高度由 layoutPreview 自己写入，避免自激
      const width = el.clientWidth;
      if (width === lastWidth) return;
      lastWidth = width;
      layoutPreviewRef.current();
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [previewVisible]);

  // ---- 「…」更多菜单（SVG / HTML） ----
  const showingSource = canRenderSvg ? !svgPreviewActive : !htmlPreviewActive;
  const moreActions: CodeBlockMenuAction[] = [];
  if (hasLivePreview) {
    moreActions.push({
      key: 'download',
      label: t('codeBlock.download'),
      icon: <DownloadSimple size={16} />,
      disabled: !!isStreaming,
      onSelect: () => {
        void runSaveAction(
          () => (canRenderSvg ? downloadSvgSource(codeContent) : downloadHtmlSource(codeContent, htmlFileNameFor(codeContent))),
          'codeBlock.saveFailed',
        );
      },
    });
    if (canRenderSvg) {
      moreActions.push({
        key: 'save-image',
        label: t('codeBlock.saveAsImage'),
        icon: <ImageSquare size={16} />,
        disabled: !!isStreaming || progressiveSvg === null,
        onSelect: () => {
          void runSaveAction(() => saveSvgAsPng(codeContent), 'codeBlock.imageExportFailed');
        },
      });
    }
    moreActions.push({
      key: 'copy',
      label: t('codeBlock.copyCode'),
      icon: <Copy size={16} />,
      onSelect: () => { void handleCopy(); },
    });
    moreActions.push({
      key: 'toggle-view',
      label: showingSource ? t('codeBlock.viewPreview') : t('codeBlock.viewCode'),
      icon: showingSource ? <Eye size={16} /> : <Code size={16} />,
      onSelect: () => {
        if (canRenderSvg) {
          setSvgView(showingSource ? 'preview' : 'source');
        } else {
          setHtmlViewOverride(showingSource ? 'preview' : 'source');
        }
      },
    });
    if (canRenderHtml) {
      moreActions.push({
        key: 'open-sandbox',
        label: t('codeBlock.openSandbox'),
        icon: <ArrowSquareOut size={16} />,
        disabled: !!isStreaming,
        onSelect: handleOpenSandbox,
      });
    }
  }

  const zoomControls = (
    <>
      <DsButton variant="ghost" size="icon" iconOnly className="code-block-copy" onClick={handleZoomOut} aria-label={t('codeBlock.zoomOut')} title={t('codeBlock.zoomOut')}>
        <Minus size={14} />
      </DsButton>
      <DsButton variant="ghost" size="icon" iconOnly className="code-block-copy" onClick={handleZoomIn} aria-label={t('codeBlock.zoomIn')} title={t('codeBlock.zoomIn')}>
        <Plus size={14} />
      </DsButton>
      <DsButton variant="ghost" size="icon" iconOnly className="code-block-copy" onClick={handleFitView} aria-label={t('codeBlock.fitView')} title={t('codeBlock.fitView')}>
        <span style={{ fontSize: 12 }}>⤢</span>
      </DsButton>
      <DsButton variant="ghost" size="icon" iconOnly className="code-block-copy" onClick={handleResetView} aria-label={t('codeBlock.resetView')} title={t('codeBlock.resetView')}>
        <ArrowCounterClockwise size={14} />
      </DsButton>
    </>
  );

  const scriptsIgnored = htmlPreviewActive && htmlUsesScripts(codeContent);

  const liveHeader = (
    <div className="code-block-header">
      <span className="code-block-lang">{language}</span>
      {scriptsIgnored && (
        <span className="code-block-badge" title={t('codeBlock.scriptsDisabledHint')}>
          {t('codeBlock.scriptsDisabled')}
        </span>
      )}
      <div className="code-block-actions">
        {svgPreviewActive && progressiveSvg !== null && zoomControls}
        {htmlPreviewActive && (htmlOverflowing || htmlExpanded) && (
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            className="code-block-copy"
            onClick={() => setHtmlExpanded((v) => !v)}
            aria-label={htmlExpanded ? t('codeBlock.collapsePreview') : t('codeBlock.expandPreview')}
            title={htmlExpanded ? t('codeBlock.collapsePreview') : t('codeBlock.expandPreview')}
            aria-pressed={htmlExpanded}
          >
            {htmlExpanded ? <ArrowsInSimple size={14} /> : <ArrowsOutSimple size={14} />}
          </DsButton>
        )}
        <CodeBlockMoreMenu actions={moreActions} label={t('codeBlock.moreActions')} />
      </div>
    </div>
  );

  const legacyHeader = (
    <div className="code-block-header">
      <span className="code-block-lang">{language}</span>
      <div className="code-block-actions">
        <DsButton variant="ghost" size="sm" className="code-block-copy [@media(pointer:coarse)]:!min-h-11" onClick={handleCopy}>
          <IconSwap
            active={copied}
            a={<Copy size={14} />}
            b={<Check size={14} />}
          />
          <span>{copied ? t('codeBlock.copied') : t('codeBlock.copy')}</span>
        </DsButton>

        {(canRunMermaid || canRenderXml || canRenderRich) && (
          (renderedSvg || showRichRenderer) ? (
            <DsButton
              variant="ghost"
              size="sm"
              className="code-block-copy [@media(pointer:coarse)]:!min-h-11"
              onClick={() => canRenderRich ? setShowRichRenderer(v => !v) : setShowRendered(v => !v)}
              title={(canRenderRich ? showRichRenderer : showRendered) ? t('codeBlock.viewSource') : t('codeBlock.viewRender')}
            >
              <span style={{ marginRight: 4 }}>{(canRenderRich ? showRichRenderer : showRendered) ? '</>' : '◎'}</span>
              <span>{(canRenderRich ? showRichRenderer : showRendered) ? t('codeBlock.source') : t('codeBlock.render')}</span>
            </DsButton>
          ) : (
            <DsButton
              variant="ghost"
              size="sm"
              className="code-block-copy [@media(pointer:coarse)]:!min-h-11"
              onClick={
                canRunMermaid ? handleRunMermaid :
                canRenderXml ? handleRunXml :
                () => setShowRichRenderer(true)
              }
              disabled={!!isStreaming || running}
              title={
                canRunMermaid ? (isStreaming ? t('codeBlock.mermaidHint') : t('codeBlock.runMermaid')) :
                canRenderXml ? t('codeBlock.renderXml') :
                t('codeBlock.run')
              }
            >
              <span style={{ marginRight: 4 }}>{running && canRunMermaid ? '…' : '▶'}</span>
              <span>{running && canRunMermaid ? t('codeBlock.running') : t('codeBlock.run')}</span>
            </DsButton>
          )
        )}

        {previewVisible && zoomControls}
      </div>
    </div>
  );

  const sourceView = (
    <ScrollArea orientation="both" className="code-block-scroll-area">
      <pre className="code-block code-block-inner">
        <HighlightedCode className={className}>{rawChildren}</HighlightedCode>
      </pre>
    </ScrollArea>
  );

  let body: ReactNode;
  if (showRichRenderer && richRendererKind) {
    body = <RichCodeRenderer kind={richRendererKind} source={codeContent} />;
  } else if (htmlPreviewActive) {
    body = (
      <MermaidErrorBoundary
        key={errorBoundaryKey.current}
        fallbackCode={codeContent}
        language={language}
        onReset={handleErrorBoundaryReset}
      >
        <ChatHtmlPreview
          className="chat-html-preview-stage"
          html={codeContent}
          streaming={!!isStreaming}
          expanded={htmlExpanded}
          onOverflowChange={setHtmlOverflowing}
          title={t('codeBlock.htmlPreviewTitle')}
        />
      </MermaidErrorBoundary>
    );
  } else if (previewVisible) {
    body = (
      <MermaidErrorBoundary
        key={errorBoundaryKey.current}
        fallbackCode={codeContent}
        language={language}
        onReset={handleErrorBoundaryReset}
      >
        <div
          className={`mermaid-preview ${panning ? 'panning' : ''} ${mermaidError ? 'has-error' : ''}`}
          ref={previewRef}
          data-no-screen-swipe
          data-preview-kind={canRenderSvg ? 'svg' : undefined}
          style={previewHeight !== null ? { height: previewHeight } : undefined}
          onPointerDown={onPanPointerDown}
          onPointerMove={onPanPointerMove}
          onPointerUp={onPanPointerUp}
          onPointerCancel={onPanPointerUp}
          onDoubleClick={handleFitView}
        >
          <div className="mermaid-canvas">
            {previewMarkup ? (
              <div
                className="mermaid-content"
                style={{
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                  transformOrigin: '0 0',
                  width: contentSize.width || undefined,
                  height: contentSize.height || undefined,
                }}
                dangerouslySetInnerHTML={{ __html: previewMarkup }}
              />
            ) : (
              <div className="code-block-preview-pending">{t('codeBlock.previewPending')}</div>
            )}
          </div>
        </div>
      </MermaidErrorBoundary>
    );
  } else {
    body = sourceView;
  }

  return (
    <CodeBlockShell
      header={hasLivePreview ? liveHeader : legacyHeader}
      stickyHeader
      bodyClassName="code-block-body-shell"
      style={isStreaming ? undefined : IDLE_CODE_SHELL_STYLE}
    >
      {body}
    </CodeBlockShell>
  );
};
