/**
 * TextFilePreview - 文本类文件的增强预览
 *
 * ★ 2026-06-12（审阅 UI/UX 建议）：替代原先所有文本文件统一 <pre> 的做法。
 * - .md/.markdown → ReactMarkdown 富渲染（GFM 表格/任务列表/删除线），链接经 openUrl 外部打开
 * - .csv/.tsv → 解析为表格展示（带引号转义处理，超长截断）
 * - .json → 单行压缩内容自动格式化
 * - 代码类扩展名 → 不换行 + 横向滚动；其余 → 等宽换行纯文本
 *
 * ★ 2026-07-08：超大文本截断渲染（避免超长字符串拖垮 DOM）、空文件空状态、
 *   React.memo 避免父组件无关重渲染导致的重复解析。
 * ★ 2026-07-08 R2：大文件渐进渲染（首屏先出首块内容，剩余部分在 transition 中补齐）。
 * ★ 2026-07-19（预览器改造）：
 * - 代码文件：Prism 按需高亮（语言组件动态 import，主题基于语义 token 亮暗两套）+
 *   行号列（sticky 左栏，user-select:none，复制不带行号）；>200k 字符自动降级不高亮。
 * - Markdown：对齐聊天渲染（remark-math + KaTeX、代码块 Prism 高亮 + 复制按钮、
 *   表格/引用/链接精修），链接仍走 openUrl 拦截。
 * - CSV/TSV：分隔符自动探测（逗号/分号/制表符按首行频次）、点击表头排序（数字感知，
 *   升/降/还原三态）、「首行为表头」内联开关、行号列、hover 行高亮。
 * - 顶部元信息条（扩展名徽标 + 行数/字数/表格规模 + 复制按钮）、截断提示细化、
 *   空文件/纯空白空态。
 */

import React, { startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import katex from 'katex';
// 对齐聊天 MarkdownRenderer：注册 mhchem 扩展，使 \ce{}/\pu{} 化学式可渲染
import 'katex/contrib/mhchem';
import { ArrowsDownUp, CaretDown, CaretUp, Check, Copy, FileText } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { openUrl } from '@/utils/urlOpener';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { ensureKatexStyles } from '@/utils/lazyStyles';

/** CSV 最大渲染行数（超出截断，避免超大文件拖垮 DOM） */
const CSV_MAX_RENDER_ROWS = 1000;

/** 纯文本 / Markdown 最大渲染字符数（超出截断并提示） */
const TEXT_MAX_RENDER_CHARS = 500_000;

/** 语法高亮上限：超过则降级为无高亮纯文本，防止 Prism 阻塞主线程 */
const HIGHLIGHT_MAX_CHARS = 200_000;

/** 渐进渲染：首屏立即渲染的字符数 / CSV 行数，剩余在 transition 中补齐 */
const TEXT_FIRST_CHUNK_CHARS = 64_000;
const CSV_FIRST_CHUNK_ROWS = 100;

/** 代码类扩展名：不自动换行，长行走横向滚动（更接近编辑器行为，便于阅读缩进结构） */
const CODE_LIKE_EXTENSIONS = new Set([
  'json', 'jsonc', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'ini',
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'css', 'scss', 'less',
  'py', 'rs', 'go', 'java', 'kt', 'kts', 'c', 'h', 'cpp', 'hpp', 'cc', 'cxx', 'hh', 'cs',
  'sql', 'sh', 'bash', 'zsh', 'ps1', 'bat', 'rb', 'php', 'swift', 'lua',
  'vue', 'svelte', 'graphql', 'conf', 'cfg', 'env', 'properties', 'diff', 'patch',
]);

// ============================================================================
// Prism 语法高亮基础设施（语言组件按需动态 import，引法对齐 crepe/plugins）
// ============================================================================

interface PrismInstance {
  languages: Record<string, unknown>;
  highlight: (text: string, grammar: unknown, language: string) => string;
}

/**
 * 扩展名 / fence 语言名 → Prism 语言 id 归一化。
 * 未列出的名字若恰好是 PRISM_LANGUAGE_LOADERS 的 key，也按原名加载。
 */
const PRISM_LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', javascript: 'javascript',
  ts: 'typescript', typescript: 'typescript',
  jsx: 'jsx', tsx: 'tsx',
  json: 'json', jsonc: 'json', jsonl: 'json', json5: 'json',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  py: 'python', python: 'python',
  rs: 'rust', rust: 'rust',
  go: 'go', golang: 'go',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin', kotlin: 'kotlin',
  c: 'c', h: 'c',
  cpp: 'cpp', hpp: 'cpp', cc: 'cpp', hh: 'cpp', cxx: 'cpp', 'c++': 'cpp',
  cs: 'csharp', csharp: 'csharp', dotnet: 'csharp',
  sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash', 'shell-session': 'bash',
  ps1: 'powershell', powershell: 'powershell',
  bat: 'batch', cmd: 'batch', batch: 'batch',
  rb: 'ruby', ruby: 'ruby',
  php: 'php',
  swift: 'swift',
  lua: 'lua',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'ini', conf: 'ini', cfg: 'ini', env: 'ini', properties: 'ini',
  xml: 'markup', html: 'markup', htm: 'markup', svg: 'markup', markup: 'markup',
  md: 'markdown', markdown: 'markdown',
  diff: 'diff', patch: 'diff',
  docker: 'docker', dockerfile: 'docker',
  graphql: 'graphql', gql: 'graphql',
  vue: 'markup', svelte: 'markup',
};

/** 动态 import 必须是字面量路径（Vite 静态分析），故逐语言登记 loader */
const PRISM_LANGUAGE_LOADERS: Record<string, () => Promise<unknown>> = {
  markup: () => import('prismjs/components/prism-markup'),
  clike: () => import('prismjs/components/prism-clike'),
  javascript: () => import('prismjs/components/prism-javascript'),
  typescript: () => import('prismjs/components/prism-typescript'),
  jsx: () => import('prismjs/components/prism-jsx'),
  tsx: () => import('prismjs/components/prism-tsx'),
  css: () => import('prismjs/components/prism-css'),
  scss: () => import('prismjs/components/prism-scss'),
  less: () => import('prismjs/components/prism-less'),
  python: () => import('prismjs/components/prism-python'),
  rust: () => import('prismjs/components/prism-rust'),
  go: () => import('prismjs/components/prism-go'),
  java: () => import('prismjs/components/prism-java'),
  kotlin: () => import('prismjs/components/prism-kotlin'),
  c: () => import('prismjs/components/prism-c'),
  cpp: () => import('prismjs/components/prism-cpp'),
  csharp: () => import('prismjs/components/prism-csharp'),
  sql: () => import('prismjs/components/prism-sql'),
  bash: () => import('prismjs/components/prism-bash'),
  powershell: () => import('prismjs/components/prism-powershell'),
  batch: () => import('prismjs/components/prism-batch'),
  ruby: () => import('prismjs/components/prism-ruby'),
  'markup-templating': () => import('prismjs/components/prism-markup-templating'),
  php: () => import('prismjs/components/prism-php'),
  swift: () => import('prismjs/components/prism-swift'),
  lua: () => import('prismjs/components/prism-lua'),
  json: () => import('prismjs/components/prism-json'),
  yaml: () => import('prismjs/components/prism-yaml'),
  toml: () => import('prismjs/components/prism-toml'),
  ini: () => import('prismjs/components/prism-ini'),
  markdown: () => import('prismjs/components/prism-markdown'),
  diff: () => import('prismjs/components/prism-diff'),
  docker: () => import('prismjs/components/prism-docker'),
  graphql: () => import('prismjs/components/prism-graphql'),
};

/** Prism 组件的依赖链（对齐 prismjs components.json 的 require 声明） */
const PRISM_LANGUAGE_DEPENDENCIES: Record<string, string[]> = {
  javascript: ['clike'],
  typescript: ['javascript'],
  jsx: ['markup', 'javascript'],
  tsx: ['jsx', 'typescript'],
  c: ['clike'],
  cpp: ['c'],
  csharp: ['clike'],
  java: ['clike'],
  kotlin: ['clike'],
  go: ['clike'],
  ruby: ['clike'],
  php: ['markup-templating'],
  'markup-templating': ['markup'],
  scss: ['css'],
  less: ['css'],
  markdown: ['markup'],
};

function resolvePrismLanguage(name: string): string | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  return PRISM_LANGUAGE_ALIASES[key] ?? (PRISM_LANGUAGE_LOADERS[key] ? key : null);
}

let prismCorePromise: Promise<PrismInstance | null> | null = null;

/** Prism 核心懒加载（CJS interop：default 导出 / 全局 Prism 双兜底） */
function loadPrismCore(): Promise<PrismInstance | null> {
  if (!prismCorePromise) {
    prismCorePromise = import('prismjs')
      .then((mod) => {
        const candidate: any = (mod as any)?.default ?? mod;
        if (candidate && typeof candidate.highlight === 'function') {
          return candidate as PrismInstance;
        }
        const globalPrism: any = (globalThis as any).Prism;
        return globalPrism && typeof globalPrism.highlight === 'function'
          ? (globalPrism as PrismInstance)
          : null;
      })
      .catch((err: unknown) => {
        console.warn('[TextFilePreview] Failed to load prism core:', err);
        return null;
      });
  }
  return prismCorePromise;
}

function collectPrismLanguageChain(language: string, acc: string[]): string[] {
  if (acc.includes(language)) return acc;
  for (const dep of PRISM_LANGUAGE_DEPENDENCIES[language] ?? []) {
    collectPrismLanguageChain(dep, acc);
  }
  if (!acc.includes(language)) acc.push(language);
  return acc;
}

const loadedPrismLanguages = new Set<string>();

async function loadPrismLanguage(language: string): Promise<PrismInstance | null> {
  const prism = await loadPrismCore();
  if (!prism) return null;
  const chain = collectPrismLanguageChain(language, []);
  for (const lang of chain) {
    // grammar 已存在（如 crepe 已静态注册）则跳过
    if (loadedPrismLanguages.has(lang) || prism.languages[lang]) continue;
    const loader = PRISM_LANGUAGE_LOADERS[lang];
    if (!loader) continue;
    try {
      await loader();
      loadedPrismLanguages.add(lang);
    } catch (err: unknown) {
      console.warn(`[TextFilePreview] Failed to load prism language "${lang}":`, err);
      return prism; // 核心可用但该语言缺失，调用方按 grammar 缺失降级
    }
  }
  return prism;
}

// ============================================================================
// 高亮主题：不引 Prism 外部 css，自写基于语义 token 的亮/暗两套配色
// ============================================================================

const SYNTAX_THEME_STYLE_ID = 'tfp-syntax-theme';

const SYNTAX_THEME_CSS = `
/* 行号 gutter：数字走 ::before content（不产生文本节点），
   selection.toString() / 复制 / 外壳 closest('pre') 行号计算天然不受污染
   （WebKit 对 user-select:none 文本仍可能计入选区，纯 CSS content 无此问题） */
.tfp-gutter > div::before {
  content: attr(data-ln);
}
.tfp-syntax {
  --tfp-hl-comment: hsl(var(--muted-foreground));
  --tfp-hl-keyword: hsl(355 60% 44%);
  --tfp-hl-string: hsl(212 90% 30%);
  --tfp-hl-constant: hsl(212 90% 40%);
  --tfp-hl-function: hsl(261 60% 48%);
  --tfp-hl-entity: hsl(137 55% 27%);
  --tfp-hl-regex: hsl(29 85% 32%);
}
:root.dark .tfp-syntax {
  --tfp-hl-keyword: hsl(347 85% 72%);
  --tfp-hl-string: hsl(212 95% 80%);
  --tfp-hl-constant: hsl(212 100% 74%);
  --tfp-hl-function: hsl(261 85% 79%);
  --tfp-hl-entity: hsl(115 45% 68%);
  --tfp-hl-regex: hsl(29 90% 72%);
}
.tfp-syntax .token.comment, .tfp-syntax .token.prolog, .tfp-syntax .token.doctype, .tfp-syntax .token.cdata { color: var(--tfp-hl-comment); font-style: italic; }
.tfp-syntax .token.punctuation { color: hsl(var(--foreground) / 0.6); }
.tfp-syntax .token.operator, .tfp-syntax .token.combinator { color: hsl(var(--foreground) / 0.75); }
.tfp-syntax .token.keyword, .tfp-syntax .token.atrule, .tfp-syntax .token.rule, .tfp-syntax .token.important { color: var(--tfp-hl-keyword); }
.tfp-syntax .token.string, .tfp-syntax .token.char, .tfp-syntax .token.attr-value, .tfp-syntax .token.url, .tfp-syntax .token.template-string { color: var(--tfp-hl-string); }
.tfp-syntax .token.number, .tfp-syntax .token.boolean, .tfp-syntax .token.constant, .tfp-syntax .token.symbol, .tfp-syntax .token.unit { color: var(--tfp-hl-constant); }
.tfp-syntax .token.property, .tfp-syntax .token.attr-name, .tfp-syntax .token.variable, .tfp-syntax .token.parameter { color: var(--tfp-hl-constant); }
.tfp-syntax .token.function, .tfp-syntax .token.function-name, .tfp-syntax .token.method { color: var(--tfp-hl-function); }
.tfp-syntax .token.class-name, .tfp-syntax .token.maybe-class-name, .tfp-syntax .token.tag, .tfp-syntax .token.selector, .tfp-syntax .token.builtin, .tfp-syntax .token.namespace { color: var(--tfp-hl-entity); }
.tfp-syntax .token.regex { color: var(--tfp-hl-regex); }
.tfp-syntax .token.deleted { color: hsl(var(--destructive)); }
.tfp-syntax .token.inserted { color: hsl(var(--success)); }
.tfp-syntax .token.bold { font-weight: 600; }
.tfp-syntax .token.italic { font-style: italic; }
`;

let syntaxThemeInjected = false;

function ensureSyntaxThemeStyles(): void {
  if (syntaxThemeInjected || typeof document === 'undefined') return;
  if (!document.getElementById(SYNTAX_THEME_STYLE_ID)) {
    const style = document.createElement('style');
    style.id = SYNTAX_THEME_STYLE_ID;
    style.textContent = SYNTAX_THEME_CSS;
    document.head.appendChild(style);
  }
  syntaxThemeInjected = true;
}

/**
 * 异步高亮 hook：Prism 核心与语言组件加载完成后才 setState 换入高亮 HTML，
 * 首帧始终是纯文本（不阻塞首屏）。code 变化期间返回 null（调用方回退纯文本）。
 */
function usePrismHighlight(code: string, languageName: string | null, enabled: boolean): string | null {
  const language = languageName ? resolvePrismLanguage(languageName) : null;
  const [result, setResult] = useState<{ code: string; language: string; html: string } | null>(null);

  useEffect(() => {
    if (!enabled || !language || !code) return;
    let cancelled = false;
    ensureSyntaxThemeStyles();
    void loadPrismLanguage(language).then((prism) => {
      if (cancelled || !prism) return;
      const grammar = prism.languages[language];
      if (!grammar) return;
      try {
        const html = prism.highlight(code, grammar, language);
        if (!cancelled) setResult({ code, language, html });
      } catch (err: unknown) {
        console.warn('[TextFilePreview] Prism highlight failed:', err);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, language, enabled]);

  return enabled && language && result && result.code === code && result.language === language
    ? result.html
    : null;
}

// ============================================================================
// 通用小部件：复制按钮 / 元信息条
// ============================================================================

const CopyTextButton: React.FC<{ text: string }> = ({ text }) => {
  const { t } = useTranslation(['learningHub']);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleCopy = useCallback(async () => {
    try {
      const ok = await copyTextToClipboard(text);
      if (!ok) return;
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch (err: unknown) {
      console.warn('[TextFilePreview] Copy failed:', err);
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="ui-state-colors inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
      aria-label={t('learningHub:filePreview.copy')}
    >
      {copied ? <Check size={12} className="text-success" aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
      <span>{copied ? t('learningHub:filePreview.copied') : t('learningHub:filePreview.copy')}</span>
    </button>
  );
};

interface FileMetaBarProps {
  ext: string;
  items: string[];
  /** 提供时在右侧渲染「复制全文」按钮 */
  copyText?: string;
  /** 右侧附加控件（如 CSV 表头开关） */
  children?: React.ReactNode;
}

/** 顶部元信息条：扩展名徽标 + 行数/字数等轻量统计，安静内联一行 */
const FileMetaBar: React.FC<FileMetaBarProps> = ({ ext, items, copyText, children }) => (
  <div className="flex select-none flex-wrap items-center gap-x-2 gap-y-1 px-4 pb-2 pt-3 text-xs text-muted-foreground">
    <span className="inline-flex items-center rounded border border-border bg-muted/60 px-1.5 py-px font-mono text-[10px] font-medium uppercase tracking-wider text-foreground/70">
      {ext || 'txt'}
    </span>
    {items.map((item, i) => (
      <React.Fragment key={i}>
        {i > 0 && <span aria-hidden="true" className="text-muted-foreground/40">·</span>}
        <span>{item}</span>
      </React.Fragment>
    ))}
    <span className="ml-auto flex items-center gap-3">
      {children}
      {copyText !== undefined && <CopyTextButton text={copyText} />}
    </span>
  </div>
);

// ============================================================================
// Markdown 渲染（对齐聊天侧：remark-math + KaTeX、代码块高亮 + 复制）
// ============================================================================

const MARKDOWN_REMARK_PLUGINS = [remarkMath, remarkGfm];

function renderMathHtml(latex: string, displayMode: boolean): React.ReactNode {
  const trimmed = latex.trim();
  if (!trimmed) return null;
  try {
    const html = katex.renderToString(trimmed, {
      throwOnError: false,
      strict: false,
      trust: false,
      errorColor: 'hsl(var(--destructive))',
      displayMode,
    });
    return displayMode ? (
      <div className="not-prose overflow-x-auto py-1" dangerouslySetInnerHTML={{ __html: html }} />
    ) : (
      <span dangerouslySetInnerHTML={{ __html: html }} />
    );
  } catch (err: unknown) {
    console.warn('[TextFilePreview] KaTeX render failed:', err, 'latex=', trimmed);
    return <code>{trimmed}</code>;
  }
}

function flattenChildrenText(children: unknown): string {
  if (children == null) return '';
  if (typeof children === 'string') return children;
  if (typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(flattenChildrenText).join('');
  if (React.isValidElement(children)) return flattenChildrenText((children.props as any)?.children);
  return '';
}

/** remark-math 产出的 class：language-math + math-inline / math-display */
const MATH_CLASS_RE = /(?:^|\s)math(?:\s|$)|language-(?:math|latex)(?![\w-])/i;

/** Markdown 内代码块：语言标签 + 复制按钮 + Prism 高亮 */
const MarkdownCodeBlock: React.FC<{ language: string | null; code: string }> = ({ language, code }) => {
  const html = usePrismHighlight(code, language, code.length > 0 && code.length <= HIGHLIGHT_MAX_CHARS);
  return (
    <div className="not-prose my-3 overflow-hidden rounded-lg border border-border bg-muted/30">
      <div className="flex items-center justify-between border-b border-border/60 bg-muted/50 py-1 pl-3 pr-1.5">
        <span className="font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
          {language || 'text'}
        </span>
        <CopyTextButton text={code} />
      </div>
      <pre className={cn('m-0 overflow-x-auto p-3 font-mono text-[13px] leading-6 text-foreground', html && 'tfp-syntax')}>
        {html ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}
      </pre>
    </div>
  );
};

const markdownComponents = {
  // 块级代码 / 块级数学：pre 层统一接管（子元素 props 仍是原始 className/children）
  pre: ({ children }: any) => {
    const childArray = React.Children.toArray(children);
    const codeElement: any =
      childArray.find((c: any) => c?.type === 'code' || c?.props?.className) ?? childArray[0];
    const cls = String(codeElement?.props?.className ?? '');
    const raw = flattenChildrenText(codeElement?.props?.children).replace(/\n$/, '');
    if (MATH_CLASS_RE.test(cls)) {
      return renderMathHtml(raw, true);
    }
    const lang = /language-([\w+-]+)/i.exec(cls)?.[1] ?? null;
    return <MarkdownCodeBlock language={lang} code={raw} />;
  },
  code: ({ className, children, node: _node, ...props }: any) => {
    const text = flattenChildrenText(children).replace(/\n$/, '');
    // 行内数学（math-inline）；块级数学（math-display）留给 pre 层处理
    if (typeof className === 'string' && MATH_CLASS_RE.test(className) && !/math-display/i.test(className)) {
      return renderMathHtml(text, false);
    }
    if (!className && !text.includes('\n')) {
      return (
        <code
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.875em] font-normal text-foreground before:content-none after:content-none"
          {...props}
        >
          {children}
        </code>
      );
    }
    return <code className={className} {...props}>{children}</code>;
  },
  table: ({ children, node: _node, ...props }: any) => (
    <div className="not-prose my-3 w-fit max-w-full overflow-x-auto rounded-lg border border-border">
      <table className="m-0 w-max border-collapse text-sm" {...props}>{children}</table>
    </div>
  ),
  th: ({ children, node: _node, ...props }: any) => (
    <th className="border-b border-r border-border bg-muted/50 px-3 py-1.5 text-left font-medium last:border-r-0" {...props}>
      {children}
    </th>
  ),
  td: ({ children, node: _node, ...props }: any) => (
    <td className="border-b border-r border-border/60 px-3 py-1.5 align-top last:border-r-0" {...props}>
      {children}
    </td>
  ),
  blockquote: ({ children, node: _node, ...props }: any) => (
    <blockquote className="my-3 border-l-2 border-border pl-3 font-normal not-italic text-muted-foreground" {...props}>
      {children}
    </blockquote>
  ),
  a: ({ children, node: _node, ...props }: any) => (
    <a
      className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
      {...props}
    >
      {children}
    </a>
  ),
};

// ============================================================================
// CSV / TSV
// ============================================================================

export interface TextFilePreviewProps {
  /** 已解码的文本内容 */
  content: string;
  /** 文件名（用于判断渲染模式） */
  fileName: string;
  className?: string;
}

interface ParsedCsv {
  rows: string[][];
  /** 超出 maxRows 而未构建的剩余行数 */
  hiddenRows: number;
  /** 渲染列数（取各行最大值，短行渲染时补齐，保证网格完整） */
  colCount: number;
}

/**
 * 简易 CSV/TSV 解析（支持双引号包裹、引号转义、字段内换行）。
 * 达到 maxRows 后停止构建字符串，仅统计剩余行数，避免超大文件的无用解析开销。
 */
function parseCsv(text: string, maxRows: number = Infinity, delimiter: string = ','): ParsedCsv {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;

  for (; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }

  const finalize = (hiddenRows: number): ParsedCsv => {
    let colCount = 0;
    for (const r of rows) {
      if (r.length > colCount) colCount = r.length;
    }
    return { rows, hiddenRows, colCount };
  };

  if (i >= text.length) {
    // 全量解析完成：收尾 + 丢弃末尾空行
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) {
      rows.pop();
    }
    return finalize(0);
  }

  // 截断：剩余部分只统计行数（尊重引号内换行），不再构建字符串
  let hiddenRows = 0;
  let hasTrailingContent = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      hasTrailingContent = true;
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      hiddenRows++;
      hasTrailingContent = false;
    } else {
      hasTrailingContent = true;
    }
  }
  if (hasTrailingContent) hiddenRows++;
  return finalize(hiddenRows);
}

/** 分隔符自动探测：按首行出现频次挑选；tsv 优先制表符，其余优先逗号 */
function detectCsvDelimiter(text: string, ext: string): string {
  const newlineIdx = text.indexOf('\n');
  const firstLine = text.slice(0, Math.min(newlineIdx >= 0 ? newlineIdx : text.length, 4000));
  const candidates = ext === 'tsv' ? ['\t', ',', ';'] : [',', ';', '\t'];
  let best = candidates[0];
  let bestCount = 0;
  for (const candidate of candidates) {
    let count = 0;
    for (let j = 0; j < firstLine.length; j++) {
      if (firstLine[j] === candidate) count++;
    }
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return bestCount > 0 ? best : (ext === 'tsv' ? '\t' : ',');
}

type CsvSort = { col: number; dir: 'asc' | 'desc' };

function parseCsvNumber(value: string): number | null {
  const s = value.trim();
  if (!s) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

interface CsvTableProps {
  parsed: ParsedCsv;
  hasHeader: boolean;
  revealFull: boolean;
}

const CsvTable: React.FC<CsvTableProps> = ({ parsed, hasHeader, revealFull }) => {
  const { t } = useTranslation(['learningHub']);
  // 数据源切换时在 render 阶段重置排序（parsed 由上层 useMemo 保证身份稳定）
  const [sortState, setSortState] = useState<{ key: ParsedCsv; sort: CsvSort | null }>({
    key: parsed,
    sort: null,
  });
  if (sortState.key !== parsed) {
    setSortState({ key: parsed, sort: null });
  }
  const sort = sortState.key === parsed && sortState.sort && sortState.sort.col < parsed.colCount
    ? sortState.sort
    : null;

  const headerCells = hasHeader ? parsed.rows[0] ?? [] : null;

  const bodyRows = useMemo(() => {
    const source = hasHeader ? parsed.rows.slice(1) : parsed.rows;
    // line = 文件内记录序号（1 起；有表头时数据从第 2 条记录开始）
    return source.map((cells, i) => ({ cells, line: i + (hasHeader ? 2 : 1) }));
  }, [parsed, hasHeader]);

  const sortedRows = useMemo(() => {
    if (!sort) return bodyRows;
    const { col, dir } = sort;
    const factor = dir === 'asc' ? 1 : -1;
    return [...bodyRows].sort((a, b) => {
      const av = a.cells[col] ?? '';
      const bv = b.cells[col] ?? '';
      const an = parseCsvNumber(av);
      const bn = parseCsvNumber(bv);
      if (an !== null && bn !== null) return (an - bn) * factor;
      if (an !== null) return -factor; // 数字排在文本之前
      if (bn !== null) return factor;
      return av.localeCompare(bv, undefined, { numeric: true }) * factor;
    });
  }, [bodyRows, sort]);

  const visibleRows = revealFull ? sortedRows : sortedRows.slice(0, CSV_FIRST_CHUNK_ROWS);

  const cycleSort = (col: number) => {
    setSortState((prev) => {
      const current = prev.key === parsed ? prev.sort : null;
      if (!current || current.col !== col) return { key: parsed, sort: { col, dir: 'asc' } };
      if (current.dir === 'asc') return { key: parsed, sort: { col, dir: 'desc' } };
      return { key: parsed, sort: null };
    });
  };

  const padCells = (cells: string[]): string[] =>
    cells.length >= parsed.colCount
      ? cells
      : [...cells, ...Array<string>(parsed.colCount - cells.length).fill('')];

  return (
    <table className="w-max min-w-full border-collapse text-sm">
      <thead>
        <tr>
          <th
            scope="col"
            aria-label={t('learningHub:filePreview.csvRowNumber')}
            className="sticky top-0 z-10 select-none border border-border bg-muted px-2 py-1.5"
          />
          {Array.from({ length: parsed.colCount }, (_, i) => {
            const dir = sort?.col === i ? sort.dir : null;
            const nextActionLabel =
              dir === null
                ? t('learningHub:filePreview.sortAsc')
                : dir === 'asc'
                  ? t('learningHub:filePreview.sortDesc')
                  : t('learningHub:filePreview.sortNone');
            return (
              <th
                key={i}
                scope="col"
                aria-sort={dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'}
                className="sticky top-0 z-10 border border-border bg-muted p-0 text-left font-medium"
              >
                <button
                  type="button"
                  onClick={() => cycleSort(i)}
                  title={nextActionLabel}
                  className="ui-state-colors group flex w-full items-center gap-1 px-3 py-1.5 text-left hover:bg-accent"
                >
                  <span className={cn('max-w-[24rem] truncate', !headerCells && 'text-muted-foreground')}>
                    {headerCells
                      ? headerCells[i] ?? ''
                      : t('learningHub:filePreview.csvColumn', { index: i + 1 })}
                  </span>
                  {dir === 'asc' ? (
                    <CaretUp size={12} weight="bold" className="shrink-0 text-primary" aria-hidden="true" />
                  ) : dir === 'desc' ? (
                    <CaretDown size={12} weight="bold" className="shrink-0 text-primary" aria-hidden="true" />
                  ) : (
                    <ArrowsDownUp
                      size={12}
                      className="ui-state-colors shrink-0 text-muted-foreground opacity-0 group-hover:opacity-70"
                      aria-hidden="true"
                    />
                  )}
                </button>
              </th>
            );
          })}
        </tr>
      </thead>
      <tbody>
        {visibleRows.map(({ cells, line }) => (
          <tr key={line} className="even:bg-muted/20 hover:bg-accent/50">
            <td className="select-none border border-border bg-muted/40 px-2 py-1.5 text-right align-top font-mono text-xs text-muted-foreground">
              {line}
            </td>
            {padCells(cells).map((cell, c) => (
              <td
                key={c}
                className="max-w-[36rem] whitespace-pre-wrap break-words border border-border px-3 py-1.5 align-top"
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
};

// ============================================================================
// 通用工具
// ============================================================================

function getExtension(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

/** 截断时避免切断代理对（否则末尾出现孤立代理项渲染为 �） */
function sliceSafe(text: string, end: number): string {
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

function countLines(text: string): number {
  if (!text) return 0;
  let count = 1;
  let idx = -1;
  while ((idx = text.indexOf('\n', idx + 1)) !== -1) count++;
  return count;
}

/**
 * 大内容渐进渲染：首屏只渲染首块，commit 后在 transition 中补齐完整（截断上限内的）内容。
 * 内容切换时同步重置（render 阶段派生状态，避免旧内容全量渲染一帧）。
 */
function useProgressiveReveal(contentKey: string, isLarge: boolean): boolean {
  const [state, setState] = useState({ key: contentKey, full: !isLarge });
  if (state.key !== contentKey) {
    setState({ key: contentKey, full: !isLarge });
  }
  const pending = isLarge && !state.full;

  useEffect(() => {
    if (!pending) return;
    let cancelled = false;
    // 先让首块内容 paint，再在低优先级 transition 中渲染剩余部分
    const raf = requestAnimationFrame(() => {
      startTransition(() => {
        if (!cancelled) {
          setState((s) => (s.key === contentKey && !s.full ? { ...s, full: true } : s));
        }
      });
    });
    return () => {
      cancelled = true;
      cancelAnimationFrame(raf);
    };
  }, [pending, contentKey]);

  return state.key === contentKey ? state.full : !isLarge;
}

// ============================================================================
// 主组件
// ============================================================================

const TextFilePreviewComponent: React.FC<TextFilePreviewProps> = ({ content, fileName, className }) => {
  const { t } = useTranslation(['learningHub']);
  const ext = getExtension(fileName);
  const isTabular = ext === 'csv' || ext === 'tsv';
  const isMarkdown = ext === 'md' || ext === 'markdown';
  const isCodeLike = !isTabular && !isMarkdown && CODE_LIKE_EXTENSIONS.has(ext);

  const csvDelimiter = useMemo(
    () => (isTabular ? detectCsvDelimiter(content, ext) : ','),
    [isTabular, ext, content]
  );

  const parsedCsv = useMemo(
    () => (isTabular ? parseCsv(content, CSV_MAX_RENDER_ROWS, csvDelimiter) : null),
    [isTabular, csvDelimiter, content]
  );

  // 「首行为表头」开关（默认开）；内容切换时 render 阶段重置
  const [csvHeaderState, setCsvHeaderState] = useState({ key: content, hasHeader: true });
  if (csvHeaderState.key !== content) {
    setCsvHeaderState({ key: content, hasHeader: true });
  }
  const csvHasHeader = csvHeaderState.key === content ? csvHeaderState.hasHeader : true;

  // 单行压缩 JSON 自动格式化（已格式化/超大文件保持原样）
  const displayContent = useMemo(() => {
    if (ext === 'json' && content.length <= TEXT_MAX_RENDER_CHARS && !content.includes('\n')) {
      try {
        return JSON.stringify(JSON.parse(content), null, 2);
      } catch {
        // 非法 JSON：按原文展示
      }
    }
    return content;
  }, [ext, content]);

  const isTextTruncated = displayContent.length > TEXT_MAX_RENDER_CHARS;
  const cappedText = isTextTruncated ? sliceSafe(displayContent, TEXT_MAX_RENDER_CHARS) : displayContent;

  // 渐进渲染（Markdown 不分块：部分内容会破坏语法结构导致布局跳变）
  const isLargeForReveal = parsedCsv
    ? parsedCsv.rows.length > CSV_FIRST_CHUNK_ROWS
    : !isMarkdown && cappedText.length > TEXT_FIRST_CHUNK_CHARS;
  const revealFull = useProgressiveReveal(content, isLargeForReveal);

  const renderText = revealFull ? cappedText : sliceSafe(cappedText, TEXT_FIRST_CHUNK_CHARS);

  // 元信息（行数/字数按截断前的完整内容统计）
  const stats = useMemo(
    () => ({ lines: countLines(displayContent), chars: displayContent.length }),
    [displayContent]
  );

  // 代码高亮：大文本自动降级（不高亮），Markdown/CSV 不走此路径
  const highlightEnabled = isCodeLike && cappedText.length <= HIGHLIGHT_MAX_CHARS;
  const highlightedHtml = usePrismHighlight(renderText, isCodeLike ? ext : null, highlightEnabled);

  // 行号列（gutter 与代码分列渲染；数字用 CSS content 生成，选区/复制永不带行号）
  const gutterRows = useMemo(() => {
    if (!isCodeLike) return null;
    const n = countLines(renderText);
    return Array.from({ length: n }, (_, i) => <div key={i} data-ln={i + 1} />);
  }, [isCodeLike, renderText]);

  // Markdown：按需加载 KaTeX 样式
  useEffect(() => {
    if (isMarkdown) ensureKatexStyles();
  }, [isMarkdown]);

  // 代码类：gutter 行号靠 ::before content 生成，样式必须在首帧 paint 前注入
  // （useLayoutEffect），且不依赖 Prism 加载成功——大文件降级不高亮时行号也要可见
  useLayoutEffect(() => {
    if (isCodeLike) ensureSyntaxThemeStyles();
  }, [isCodeLike]);

  // Markdown 链接：拦截并交给系统浏览器打开，避免劫持应用内导航
  const handleMarkdownClick = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element
      ? (event.target.closest('a[href]') as HTMLAnchorElement | null)
      : null;
    const href = target?.getAttribute('href');
    if (!target || !href) return;
    event.preventDefault();
    event.stopPropagation();
    if (/^(https?:|mailto:)/i.test(href)) {
      void openUrl(href);
    }
    // 相对路径/锚点链接：文档预览内没有可导航目标，仅阻断默认行为
  }, []);

  // 空文件 / 纯空白：给出明确空状态，避免呈现"看似加载失败"的空白区域
  if (content.trim() === '' && (!parsedCsv || parsedCsv.rows.length === 0)) {
    return (
      <div className={cn('ui-rise-in flex h-full flex-col items-center justify-center gap-2 p-6', className)}>
        <FileText size={28} weight="light" className="text-muted-foreground/50" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          {content.length === 0
            ? t('learningHub:filePreview.emptyFile')
            : t('learningHub:filePreview.whitespaceOnly')}
        </p>
      </div>
    );
  }

  const truncationNotice = isTextTruncated ? (
    <div
      className="mb-2 inline-flex max-w-full items-start gap-1.5 rounded-md bg-warning/10 px-2.5 py-1.5 text-xs leading-5 text-warning"
      role="note"
    >
      {t('learningHub:filePreview.textTruncatedDetail', {
        shown: cappedText.length.toLocaleString(),
        total: displayContent.length.toLocaleString(),
      })}
    </div>
  ) : null;

  const textMetaItems = [
    t('learningHub:filePreview.metaLines', { value: stats.lines.toLocaleString() }),
    t('learningHub:filePreview.metaChars', { value: stats.chars.toLocaleString() }),
  ];

  // Markdown 富渲染
  if (isMarkdown) {
    return (
      <div className={cn('min-h-full', className)}>
        <FileMetaBar ext={ext} items={textMetaItems} copyText={content} />
        <div className="px-4 pb-4" onClick={handleMarkdownClick}>
          {truncationNotice}
          <div className="prose prose-sm dark:prose-invert max-w-none">
            <ReactMarkdown remarkPlugins={MARKDOWN_REMARK_PLUGINS} components={markdownComponents as any}>
              {cappedText}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    );
  }

  // CSV/TSV 表格化
  if (parsedCsv && parsedCsv.rows.length > 0) {
    const totalRows = parsedCsv.rows.length + parsedCsv.hiddenRows;
    const delimiterLabel =
      csvDelimiter === '\t'
        ? t('learningHub:filePreview.delimiterTab')
        : csvDelimiter === ';'
          ? t('learningHub:filePreview.delimiterSemicolon')
          : t('learningHub:filePreview.delimiterComma');
    return (
      <div className={cn('min-h-full pb-4', className)}>
        {/* sticky left：横向滚动时元信息条/提示保持可见 */}
        <div className="sticky left-0 z-20">
          <FileMetaBar
            ext={ext}
            items={[
              t('learningHub:filePreview.metaTable', {
                rows: totalRows.toLocaleString(),
                cols: parsedCsv.colCount.toLocaleString(),
              }),
              delimiterLabel,
            ]}
            copyText={content}
          >
            <label className="flex cursor-pointer select-none items-center gap-1.5">
              <input
                type="checkbox"
                checked={csvHasHeader}
                onChange={(e) => setCsvHeaderState({ key: content, hasHeader: e.target.checked })}
                className="h-3.5 w-3.5 cursor-pointer accent-primary"
              />
              <span>{t('learningHub:filePreview.csvHeaderRow')}</span>
            </label>
          </FileMetaBar>
          {parsedCsv.hiddenRows > 0 && (
            <div className="px-4 pb-2 text-xs text-warning" role="note">
              {t('learningHub:docPreview.csvTruncated', {
                shown: CSV_MAX_RENDER_ROWS,
                hidden: parsedCsv.hiddenRows,
              })}
            </div>
          )}
        </div>
        <div className="px-4 pt-1">
          <CsvTable
            key={csvHasHeader ? 'with-header' : 'no-header'}
            parsed={parsedCsv}
            hasHeader={csvHasHeader}
            revealFull={revealFull}
          />
        </div>
      </div>
    );
  }

  // 代码类：行号列 + Prism 高亮（gutter sticky 左侧，长行横向滚动）
  if (isCodeLike) {
    return (
      <div className={cn('min-h-full', className)}>
        <div className="sticky left-0 z-10">
          <FileMetaBar ext={ext} items={textMetaItems} copyText={content} />
          {truncationNotice && <div className="px-4">{truncationNotice}</div>}
        </div>
        <div className="flex w-max min-w-full items-stretch">
          <div
            aria-hidden="true"
            className="tfp-gutter sticky left-0 z-[1] shrink-0 select-none border-r border-border/60 bg-background py-3 pl-4 pr-3 text-right font-mono text-sm leading-6 text-muted-foreground/50"
          >
            {gutterRows}
          </div>
          <pre
            className={cn(
              'm-0 flex-1 whitespace-pre py-3 pl-4 pr-8 font-mono text-sm leading-6 text-foreground',
              highlightedHtml && 'tfp-syntax'
            )}
          >
            {highlightedHtml ? (
              <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
            ) : (
              <code>{renderText}</code>
            )}
          </pre>
        </div>
      </div>
    );
  }

  // 默认：等宽换行纯文本
  return (
    <div className={cn('min-h-full', className)}>
      <div className="sticky left-0">
        <FileMetaBar ext={ext} items={textMetaItems} copyText={content} />
        {truncationNotice && <div className="px-4">{truncationNotice}</div>}
      </div>
      <pre className="m-0 whitespace-pre-wrap break-words px-4 pb-4 pt-1 font-mono text-sm leading-6 text-foreground">
        {renderText}
      </pre>
    </div>
  );
};

/** memo：父组件（如缩放/字号等上下文变化）重渲染时避免重复解析 CSV/Markdown */
export const TextFilePreview = React.memo(TextFilePreviewComponent);

export default TextFilePreview;
