import React, { useMemo, useEffect, useCallback, useState, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import katex, { KatexOptions } from 'katex';
import { renderToStaticMarkup } from 'react-dom/server';
import { CodeBlock } from './CodeBlock';
import { ensureKatexStyles } from '@/utils/lazyStyles';
import { openUrl } from '@/utils/urlOpener';
import { makeCitationRemarkPlugin, CITATION_PLACEHOLDER_STYLES } from '../../utils/citationRemarkPlugin';
import { CitationBadge } from '../../plugins/blocks/components/CitationPopover';
import { MindmapCitationCard } from '../MindmapCitationCard';
import { QbankCitationBadge } from '../QbankCitationBadge';
import type { RetrievalSourceType } from '../../plugins/blocks/components/types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getPdfPageImageDataUrl } from '@/api/vfsRagApi';

// 🔧 P18 优化：PDF 页面图片缓存（避免重复请求）
const pdfPageImageCache = new Map<string, string>();
const PDF_PAGE_CACHE_MAX_SIZE = 50; // 最多缓存 50 个页面

const markdownSanitizeSchema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    span: [
      ...(defaultSchema.attributes?.span || []),
      'className',
      'class',
      // rehype-sanitize 使用 HAST property 名称（camelCase）
      'dataCitation',
      'dataCitationType',
      'dataCitationIndex',
      'dataCitationShowImage',
      'dataMindmapCitation',
      'dataMindmapId',
      'dataMindmapVersionId',
      'dataMindmapTitle',
      'dataQbankCitation',
      'dataQbankSessionId',
      'dataQbankTitle',
      'dataPdfRef',
      'dataPdfSource',
      'dataPdfPage',
    ],
    code: [
      ...(defaultSchema.attributes?.code || []),
      'className',
      'class',
    ],
    pre: [
      ...(defaultSchema.attributes?.pre || []),
      'className',
      'class',
    ],
  },
};

function getCachedPdfPageImage(resourceId: string, pageIndex: number): string | undefined {
  const key = `${resourceId}:${pageIndex}`;
  return pdfPageImageCache.get(key);
}

function setCachedPdfPageImage(resourceId: string, pageIndex: number, dataUrl: string): void {
  const key = `${resourceId}:${pageIndex}`;
  // LRU 简化版：超过限制时清空一半
  if (pdfPageImageCache.size >= PDF_PAGE_CACHE_MAX_SIZE) {
    const keysToDelete = Array.from(pdfPageImageCache.keys()).slice(0, PDF_PAGE_CACHE_MAX_SIZE / 2);
    keysToDelete.forEach(k => pdfPageImageCache.delete(k));
  }
  pdfPageImageCache.set(key, dataUrl);
}

/** 引用图片信息（支持直接 URL 或 PDF 页面异步加载） */
export interface CitationImageInfo {
  /** 图片 URL（直接可用或 base64） */
  url?: string;
  /** 图片标题 */
  title?: string;
  /** 资源 ID（用于 PDF 页面异步加载） */
  resourceId?: string;
  /** 页码（0-indexed，用于 PDF 页面异步加载） */
  pageIndex?: number;
  /** 资源类型 */
  resourceType?: string;
}

interface MarkdownRendererProps {
  content: string;
  className?: string;
  // 当处于流式输出时，禁止触发 mermaid 运行
  isStreaming?: boolean;
  // 可选的链接点击处理函数
  onLinkClick?: (url: string) => void;
  extraRemarkPlugins?: any[];
  // 引用标记点击回调（type: rag/memory/web_search/multimodal, index: 从1开始的编号）
  onCitationClick?: (type: string, index: number) => void;
  // 引用图片解析器：根据引用类型与序号返回图片信息（支持 URL 或 PDF 页面异步加载）
  resolveCitationImage?: (type: RetrievalSourceType, index: number) => CitationImageInfo | null | undefined;
}

/**
 * 异步加载的引用图片组件
 * 支持：1) 直接 URL 2) PDF 页面异步加载
 */
const AsyncCitationImage: React.FC<{
  imageInfo: CitationImageInfo;
  citationIndex: number;
  resolveImageSrc: (src: string) => string;
}> = ({ imageInfo, citationIndex, resolveImageSrc }) => {
  const [imageUrl, setImageUrl] = useState<string | null>(
    imageInfo.url ? resolveImageSrc(imageInfo.url) : null
  );
  const [loading, setLoading] = useState(!imageInfo.url && !!imageInfo.resourceId);
  const [error, setError] = useState(false);

  useEffect(() => {
    // 🔧 修复：添加 cancelled 标志防止竞态条件
    let cancelled = false;
    
    // 如果已有 URL，不需要异步加载
    if (imageInfo.url) {
      setImageUrl(resolveImageSrc(imageInfo.url));
      return;
    }

    // 如果有 resourceId + pageIndex，异步加载 PDF 页面图片
    if (imageInfo.resourceId && imageInfo.pageIndex !== undefined && imageInfo.pageIndex !== null) {
      // 🔧 P18 优化：先检查缓存
      const cached = getCachedPdfPageImage(imageInfo.resourceId, imageInfo.pageIndex);
      if (cached) {
        setImageUrl(cached);
        setLoading(false);
        return;
      }
      
      setLoading(true);
      setError(false);
      
      getPdfPageImageDataUrl(imageInfo.resourceId, imageInfo.pageIndex)
        .then((dataUrl) => {
          if (!cancelled) {
            // 🔧 P18 优化：存入缓存
            setCachedPdfPageImage(imageInfo.resourceId!, imageInfo.pageIndex!, dataUrl);
            setImageUrl(dataUrl);
            setLoading(false);
          }
        })
        .catch((err) => {
          if (!cancelled) {
            console.warn('[AsyncCitationImage] Failed to load PDF page image:', err);
            setError(true);
            setLoading(false);
          }
        });
    }
    
    // 🔧 修复：cleanup 函数设置 cancelled 标志
    return () => {
      cancelled = true;
    };
  }, [imageInfo.url, imageInfo.resourceId, imageInfo.pageIndex, resolveImageSrc]);

  if (loading) {
    return (
      <span className="citation-inline-image-loading" />
    );
  }

  if (error || !imageUrl) {
    return null;
  }

  return (
    <img
      src={imageUrl}
      alt={imageInfo.title || `image-${citationIndex}`}
      className="citation-inline-image"
      onError={(e) => {
        console.warn('[MarkdownRenderer] Citation image load failed:', imageUrl);
        (e.target as HTMLImageElement).style.display = 'none';
      }}
    />
  );
};

// 预处理函数：处理LaTeX和空行
const preprocessContent = (content: string): string => {
  if (!content) return '';

  let processedContent = content;

  // 专门处理 bmatrix 环境
  processedContent = processedContent.replace(/\\begin{bmatrix}(.*?)\\end{bmatrix}/gs, (match, matrixContent) => {
    // 移除每行末尾 \\ 之前和之后的空格
    let cleanedMatrix = matrixContent.replace(/\s*\\\\\s*/g, ' \\\\ ');
    // 移除 & 周围的空格
    cleanedMatrix = cleanedMatrix.replace(/\s*&\s*/g, '&');
    // 移除行首和行尾的空格
    cleanedMatrix = cleanedMatrix.split(' \\\\ ').map((row: string) => row.trim()).join(' \\\\ ');
    return `\\begin{bmatrix}${cleanedMatrix}\\end{bmatrix}`;
  });

  // 处理空行：将多个连续的空行减少为最多一个空行
  processedContent = processedContent
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/^\s*\d+\.\s*$/gm, '')
    .replace(/(\d+\.\s*[^\n]*\n)\n+(?=\d+\.)/g, '$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n[ \t]*\n/g, '\n\n')
    .replace(/(\d+\.\s*[^\n]*)\n\n+(\d+\.\s*[^\n]*)/g, '$1\n$2')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '');

  // 若存在未闭合的 ```，自动补一个结尾
  const fenceCount = (processedContent.match(/```/g) || []).length;
  if (fenceCount % 2 === 1) {
    processedContent += '\n```';
  }

  return processedContent;
};

// 🔧 性能优化：模块级常量，避免每次渲染创建新数组引用（会击穿 React.memo）
const EMPTY_REMARK_PLUGINS: any[] = [];

const disableIndentedCodePlugin = function disableIndentedCodePlugin(this: any) {
  const Parser = this?.Parser;
  if (!Parser || !Parser.prototype) return;

  const blockTokenizers = Parser.prototype.blockTokenizers;
  const blockMethods: string[] = Parser.prototype.blockMethods || [];

  if (!blockTokenizers || typeof blockTokenizers.indentedCode === 'undefined') {
    return;
  }

  delete blockTokenizers.indentedCode;

  const index = blockMethods.indexOf('indentedCode');
  if (index !== -1) {
    blockMethods.splice(index, 1);
  }
};

// 规范化全角标点（仅限文本节点，不进入 code/inlineCode/math），
// 修复中文输入法下使用全角符号导致的 Markdown 加粗/删除线等语法不生效问题。
// 例如：＂＊＊加粗＊＊＂/＂＿＿加粗＿＿＂/＂～～删除线～～＂
const normalizeFullWidthPunctPlugin = function normalizeFullWidthPunctPlugin() {
  return function transformer(tree: any) {
    const SKIP_IN = new Set(['code', 'inlineCode', 'math', 'inlineMath']);
    function walk(node: any, parent: any | null) {
      if (!node) return;
      const t = node.type;
      if (t === 'text') {
        if (parent && SKIP_IN.has(parent.type)) return;
        const map: Record<string, string> = {
          '＊': '*',
          '＿': '_',
          '～': '~',
          '＃': '#',
        };
        const re = /[＊＿～＃]/g;
        if (typeof node.value === 'string' && re.test(node.value)) {
          node.value = node.value.replace(re, (ch: string) => map[ch] || ch);
        }
        return;
      }
      const children = Array.isArray(node.children) ? node.children : [];
      for (const c of children) walk(c, node);
    }
    walk(tree, null);
  };
};

// 拦截 ```math / ```latex 代码块并转成 math 节点的插件（必须在 remark-math 之前执行）
const convertMathCodeBlocksPlugin = function convertMathCodeBlocksPlugin() {
  return function transformer(tree: any) {
    function walk(node: any, parent: any | null, index: number) {
      if (!node) return;
      
      // 找到 type='code' 且 lang='math' 或 'latex' 的节点
      if (node.type === 'code' && typeof node.lang === 'string' && /^(math|latex)$/i.test(node.lang)) {
        console.warn('[MarkdownRenderer] Detected ```math/```latex code block (model violated prompt), force-converted to math node:', node.value?.substring(0, 50));
        // 转换为 math 节点（块级数学公式）
        node.type = 'math';
        node.meta = node.meta || null;
        delete node.lang; // math节点不需要lang属性
      }
      
      // 递归处理子节点
      const children = Array.isArray(node.children) ? node.children : [];
      for (let i = 0; i < children.length; i++) {
        walk(children[i], node, i);
      }
    }
    walk(tree, null, 0);
  };
};

export const MarkdownRenderer: React.FC<MarkdownRendererProps> = React.memo(({
  content,
  className = '',
  isStreaming = false,
  onLinkClick,
  extraRemarkPlugins = EMPTY_REMARK_PLUGINS,
  onCitationClick,
  resolveCitationImage,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // 🚀 性能优化：按需加载 KaTeX CSS
  useEffect(() => {
    ensureKatexStyles();
  }, []);

  // 🆕 注入引用徽章样式（支持热更新）
  useEffect(() => {
    const styleId = 'citation-badge-styles';
    let style = document.getElementById(styleId) as HTMLStyleElement | null;
    if (!style) {
      style = document.createElement('style');
      style.id = styleId;
      document.head.appendChild(style);
    }
    if (style.textContent !== CITATION_PLACEHOLDER_STYLES) {
      style.textContent = CITATION_PLACEHOLDER_STYLES;
    }
  }, [CITATION_PLACEHOLDER_STYLES]);

  // 🆕 引用标记点击处理
  const handleCitationClick = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const rawTarget = e.target as EventTarget | null;
    const elementTarget = (rawTarget instanceof Element ? rawTarget : null);
    const target = elementTarget?.closest?.('[data-citation="true"], [data-pdf-ref="true"]') as HTMLElement | null;
    if (!target) return;
    // 检查是否点击了引用标记
    if (target.dataset.citation === 'true') {
      e.preventDefault();
      e.stopPropagation();
      const citationType = target.dataset.citationType;
      const citationIndex = parseInt(target.dataset.citationIndex || '0', 10);
      if (citationType && citationIndex > 0 && onCitationClick) {
        onCitationClick(citationType, citationIndex);
      }
      return;
    }
    if (target.dataset.pdfRef === 'true') {
      e.preventDefault();
      e.stopPropagation();
      const sourceId = target.dataset.pdfSource;
      const pageNumber = parseInt(target.dataset.pdfPage || '0', 10);
      if (pageNumber > 0) {
        document.dispatchEvent(new CustomEvent('pdf-ref:open', {
          detail: {
            sourceId: sourceId || undefined,
            pageNumber,
          },
        }));
      }
    }
  }, [onCitationClick]);

  const resolveImageSrc = useCallback((src?: string) => {
    if (!src) return src;
    const isLocalPath =
      src.startsWith('/') ||
      /^[a-zA-Z]:[\\/]/.test(src) ||
      src.startsWith('file://');
    const isAlreadyValid =
      src.startsWith('asset://') ||
      src.startsWith('http://') ||
      src.startsWith('https://') ||
      src.startsWith('data:') ||
      src.startsWith('blob:');

    if (isLocalPath && !isAlreadyValid) {
      try {
        const cleanPath = src.replace(/^file:\/\//, '');
        return convertFileSrc(cleanPath);
      } catch (error: unknown) {
        console.warn('[MarkdownRenderer] Failed to convert file path:', src, error);
      }
    }
    return src;
  }, []);

  // 🔧 性能优化：缓存预处理结果，避免每次渲染都重跑正则
  const processedContent = useMemo(() => preprocessContent(content), [content]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const pdfRefs = Array.from(container.querySelectorAll('[data-pdf-ref="true"]')) as HTMLElement[];
    if (pdfRefs.length > 0) {
      console.log('[MarkdownRenderer] pdf-ref nodes found:', pdfRefs.length, pdfRefs.map((el) => ({
        sourceId: el.dataset.pdfSource,
        page: el.dataset.pdfPage,
      })));
    }
  }, [processedContent]);

  const remarkPlugins = useMemo(() => {
    // remark-math 默认支持 $...$ $$...$$ \(...\) \[...\] 四种格式
    // 作为 prompt 失效时的兜底机制，确保所有标准 LaTeX 格式都能渲染
    // convertMathCodeBlocksPlugin 必须在 remarkMath 之前，拦截 ```math/```latex 代码块
    const base = [
      disableIndentedCodePlugin as any,
      normalizeFullWidthPunctPlugin as any,
      convertMathCodeBlocksPlugin as any,  // 在 remark-math 之前拦截代码块
      remarkMath as any,
      remarkGfm as any,
      makeCitationRemarkPlugin() as any,   // 🆕 引用标记处理插件
    ];
    return [...base, ...(extraRemarkPlugins || [])];
  }, [extraRemarkPlugins]);

  const katexOptions: KatexOptions = useMemo(() => ({
    throwOnError: false,
    errorColor: 'hsl(var(--destructive))',
    strict: false,
    trust: false,
    macros: {
      '\\RR': '\\mathbb{R}',
      '\\NN': '\\mathbb{N}',
      '\\ZZ': '\\mathbb{Z}',
      '\\QQ': '\\mathbb{Q}',
      '\\CC': '\\mathbb{C}'
    }
  }), []);

  const renderMath = (value: string, displayMode: boolean) => {
    const latex = value?.trim() ?? '';
    if (!latex) return null;
    try {
      const html = katex.renderToString(latex, { ...katexOptions, displayMode });
      return (
        <span dangerouslySetInnerHTML={{ __html: html }} />
      );
    } catch (error: unknown) {
      console.error('[MarkdownRenderer] KaTeX render failed:', error, 'latex=', latex);
      return (
        <span className="katex-error" style={{ display: displayMode ? 'block' : 'inline' }}>
          {latex}
        </span>
      );
    }
  };

  return (
    <div ref={containerRef} className={`markdown-content ${className}`} onClick={handleCitationClick}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, markdownSanitizeSchema]]}
        components={{
          // @ts-expect-error - remark-math plugin provides math/inlineMath components not in react-markdown types
          math: ({ value }: { value?: string }) => renderMath(String(value ?? ''), true),
          inlineMath: ({ value }: { value?: string }) => renderMath(String(value ?? ''), false),
          // 统一处理 pre，避免出现嵌套的 <pre><pre> 造成双滚动条
          pre: ({ children }: any) => {
            const childArray = React.Children.toArray(children as any);
            const codeElement: any = (childArray as any[]).find((c: any) => c?.type === 'code') ?? childArray[0];
            const className = (codeElement as any)?.props?.className as string | undefined;
            const codeContent = String((codeElement as any)?.props?.children ?? '').replace(/\n$/, '');

            // 若 pre>code 被标记为 math 样式（如 "math math-display" 或 "math math-inline"），直接用 KaTeX 渲染
            const cls = typeof className === 'string' ? className : '';
            const isMathLike = /(?:^|\s)(math|math-display|math-inline)(?:\s|$)/i.test(cls) || /language-(math|latex)/i.test(cls);
            if (isMathLike) {
              const display = /math-display/i.test(cls) || (!/math-inline/i.test(cls));
              return renderMath(codeContent, display);
            }

            return (
              <CodeBlock className={className} isStreaming={isStreaming}>
                {(codeElement as any)?.props?.children}
              </CodeBlock>
            );
          },
          // 自定义 code：区分内联与块级，但块级不再额外包裹一层 pre
          code: ({ inline, className, children, ...props }: any) => {
            const codeContent = String(children).replace(/\n$/, '');
            
            // 1) 明确标记为 math/latex 的代码块，强制转 KaTeX
            const isMathBlock = typeof className === 'string' && /language-(math|latex)/i.test(className);
            if (isMathBlock) {
              return renderMath(codeContent, inline === false);
            }

            // 2) 兜底：裸代码块若包含典型 LaTeX 命令（\frac、\int、\sum、\lim、\sqrt、上下标），也转 KaTeX
            const hasLatexSignature = /\\(frac|int|sum|lim|sqrt|prod|infty|to|rightarrow|leftarrow|partial|nabla|alpha|beta|gamma|theta|pi|sigma|omega|cdot|times|geq?|leq?|neq?|approx|equiv|text|mathrm|mathbb|bmatrix|begin|end)|[\^_]\{/i.test(codeContent);
            if (hasLatexSignature && !className) {
              // 识别为未声明语言的 LaTeX 代码块，转为数学渲染
              console.warn('[MarkdownRenderer] Detected bare LaTeX code block (missing $ wrapper), auto-converted to KaTeX:', codeContent);
              return renderMath(codeContent, inline === false);
            }

            const isMultiline = codeContent.includes('\n');
            const isInlineCode = inline !== false && !isMultiline && !className;
            if (isInlineCode) {
              return <code className="inline-code" {...props}>{children}</code>;
            }
            return <code className={className} {...props}>{children}</code>;
          },
          // 自定义表格渲染
          table: ({ children }) => (
            <div className="table-wrapper">
              <table className="markdown-table">{children}</table>
            </div>
          ),
          // 🔧 修复：自定义图片渲染，支持本地文件路径转换为 asset:// URL
          img: ({ src, alt, ...props }: any) => {
            const finalSrc = resolveImageSrc(src);
            return (
              <img
                src={finalSrc}
                alt={alt || 'image'}
                style={{ maxWidth: '100%', height: 'auto', borderRadius: '8px' }}
                onError={(e) => {
                  console.warn('[MarkdownRenderer] Image load failed:', finalSrc);
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
                {...props}
              />
            );
          },
          p: ({ children, ...props }: any) => {
            const childArray = React.Children.toArray(children);
            const hasMindmapCard = childArray.some((child) =>
              React.isValidElement(child) && child.type === MindmapCitationCard
            );
            if (hasMindmapCard) {
              return <div className="my-3">{children}</div>;
            }
            return <p {...props}>{children}</p>;
          },
          span: ({ children, ...props }: any) => {
            // 处理思维导图引用 - 渲染完整的 ReactFlow 预览
            const isMindmapCitation = props['data-mindmap-citation'] === 'true';
            if (isMindmapCitation) {
              const mindmapId = props['data-mindmap-id'] as string | undefined;
              const mindmapVersionId = props['data-mindmap-version-id'] as string | undefined;
              // ★ 2026-02 修复：读取 LLM 提供的标题信息，在加载期间显示
              const rawTitle = props['data-mindmap-title'] as string | undefined;
              const displayTitle = rawTitle ? decodeURIComponent(rawTitle) : undefined;
              return (
                <MindmapCitationCard
                  mindmapId={mindmapId}
                  versionId={mindmapVersionId}
                  displayTitle={displayTitle}
                  embedHeight={280}
                />
              );
            }

            // 处理题目集引用 - 渲染可点击跳转徽章
            const isQbankCitation = props['data-qbank-citation'] === 'true';
            if (isQbankCitation) {
              const sessionId = props['data-qbank-session-id'] as string;
              const rawTitle = props['data-qbank-title'] as string | undefined;
              const displayTitle = rawTitle ? decodeURIComponent(rawTitle) : undefined;
              return (
                <QbankCitationBadge
                  sessionId={sessionId}
                  title={displayTitle}
                />
              );
            }

            // 处理普通引用
            const isCitation = props['data-citation'] === 'true';
            if (!isCitation) {
              return <span {...props}>{children}</span>;
            }

            const citationType = props['data-citation-type'] as RetrievalSourceType | undefined;
            const citationIndex = Number(props['data-citation-index'] || 0);
            // 🔧 P37: 只有显式使用 [知识库-1:图片] 格式时才渲染图片
            const showImage = props['data-citation-show-image'] === 'true';
            const handleBadgeClick = (e: React.MouseEvent) => {
              e.preventDefault();
              e.stopPropagation();
              if (citationType && citationIndex > 0 && onCitationClick) {
                onCitationClick(citationType, citationIndex);
              }
            };

            // 🔧 P37: 只在显式请求时渲染图片（[知识库-1:图片] 格式）
            // 支持 rag 和 multimodal 类型的图片渲染
            const imageInfo =
              showImage && (citationType === 'multimodal' || citationType === 'rag') && citationIndex > 0 && resolveCitationImage
                ? resolveCitationImage(citationType, citationIndex)
                : null;
            
            // 判断是否有可渲染的图片（直接 URL 或可异步加载）
            const hasImage = imageInfo && (
              imageInfo.url || 
              (imageInfo.resourceId && imageInfo.pageIndex !== undefined && imageInfo.pageIndex !== null)
            );

            // ★ 2026-01 修复：有图片时使用 div 块级容器
            // 注意：不展开 props 以避免原始 class 覆盖我们的 className
            if (hasImage && imageInfo) {
              return (
                <div 
                  className="citation-image-block"
                  data-citation="true"
                  data-citation-type={citationType}
                  data-citation-index={citationIndex}
                >
                  <CitationBadge
                    index={Math.max(citationIndex - 1, 0)}
                    onClick={handleBadgeClick}
                  />
                  <AsyncCitationImage
                    imageInfo={imageInfo}
                    citationIndex={citationIndex}
                    resolveImageSrc={resolveImageSrc}
                  />
                </div>
              );
            }
            
            // 无图片时直接返回 CitationBadge（不再套外层 span）
            return (
              <CitationBadge
                index={Math.max(citationIndex - 1, 0)}
                onClick={handleBadgeClick}
              />
            );
          },
          // 自定义链接处理，跨平台兼容
          a: ({ href, children, ...props }: any) => {
            const handleClick = async (e: React.MouseEvent) => {
              e.preventDefault();
              if (!href) return;

              // 如果有自定义处理函数，先调用它
              if (onLinkClick) {
                onLinkClick(href);
                return;
              }

              // 使用统一的跨平台链接打开函数
              await openUrl(href);
            };
            return (
              <a
                href={href}
                onClick={handleClick}
                className="text-primary underline cursor-pointer"
                {...props}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {processedContent}
      </ReactMarkdown>
    </div>
  );
});

type RenderMarkdownStaticOptions = {
  enableMath?: boolean;
};

export const renderMarkdownStatic = (
  content: string,
  _options: RenderMarkdownStaticOptions = {},
): string => {
  try {
    return renderToStaticMarkup(
      <MarkdownRenderer
        content={content}
        isStreaming={false}
      />
    );
  } catch (error: unknown) {
    console.error('[MarkdownRenderer] renderMarkdownStatic failed:', error);
    return content ?? '';
  }
};
