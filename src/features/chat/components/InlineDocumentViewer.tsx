/**
 * Chat V2 - 内联文档查看器
 *
 * ★ 2026-07-19 内联化改造：
 * 原实现名为 "Inline" 实为 createPortal 到 #document-viewer-root 的全屏浮层
 * （getBoundingClientRect 对 .chat-v2 定位 hack）。现改为真正的消息流内展开面板：
 * - 渲染在引用卡片下方，随消息流滚动，高度受限内部滚动，可折叠关闭
 * - 按扩展名 Prism 语法高亮（语言组件按需动态 import，与 crepe/TextFilePreview 同源）
 * - 无换行模式下显示行号列（CSS content 生成，复制不带行号）
 * - 搜索为真实匹配高亮 + 上一处/下一处跳转（替代原「字符比例滚动」）
 * - 键盘快捷键作用域限定在面板内（不再挂 document 级监听/Android 返回键拦截）
 */

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import {
  X,
  MagnifyingGlassPlus,
  MagnifyingGlassMinus,
  House,
  Copy,
  MagnifyingGlass,
  TextIndent,
  ArrowSquareOut,
  Download,
  Check,
  CaretUp,
  CaretDown,
} from '@phosphor-icons/react';
import { fileManager } from '@/utils/fileManager';
import { copyTextToClipboard } from '@/utils/clipboardUtils';
import { Input } from '@/components/ui/shad/Input';
import { useBreakpoint } from '@/hooks/useBreakpoint';

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
  /** 文件名（用于下载与语法高亮语言推断） */
  fileName?: string;
  /** 自定义类名 */
  className?: string;
}

// ============================================================================
// Prism 语法高亮基础设施（语言按需动态 import，引法对齐 TextFilePreview）
// ============================================================================

interface PrismInstance {
  languages: Record<string, unknown>;
  highlight: (text: string, grammar: unknown, language: string) => string;
}

/** 超过该字符数不做高亮，避免 Prism 阻塞主线程 */
const HIGHLIGHT_MAX_CHARS = 200_000;

/** 搜索匹配数上限（防止单字符查询在超大文本上生成海量 mark 节点） */
const SEARCH_MAX_MATCHES = 1000;

/** 扩展名 → Prism 语言 id 归一化 */
const PRISM_LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript',
  jsx: 'jsx', tsx: 'tsx',
  json: 'json', jsonc: 'json', jsonl: 'json',
  css: 'css', scss: 'scss', sass: 'scss', less: 'less',
  py: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c',
  cpp: 'cpp', hpp: 'cpp', cc: 'cpp', hh: 'cpp', cxx: 'cpp',
  cs: 'csharp',
  sql: 'sql',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  ps1: 'powershell',
  bat: 'batch', cmd: 'batch',
  rb: 'ruby',
  php: 'php',
  swift: 'swift',
  lua: 'lua',
  yaml: 'yaml', yml: 'yaml',
  toml: 'toml',
  ini: 'ini', conf: 'ini', cfg: 'ini', env: 'ini', properties: 'ini',
  xml: 'markup', html: 'markup', htm: 'markup', svg: 'markup',
  md: 'markdown', markdown: 'markdown',
  diff: 'diff', patch: 'diff',
  graphql: 'graphql', gql: 'graphql',
};

/** 动态 import 必须是字面量路径（Vite 静态分析），逐语言登记 loader */
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
  php: () => import('prismjs/components/prism-php'),
  'markup-templating': () => import('prismjs/components/prism-markup-templating'),
  swift: () => import('prismjs/components/prism-swift'),
  lua: () => import('prismjs/components/prism-lua'),
  json: () => import('prismjs/components/prism-json'),
  yaml: () => import('prismjs/components/prism-yaml'),
  toml: () => import('prismjs/components/prism-toml'),
  ini: () => import('prismjs/components/prism-ini'),
  markdown: () => import('prismjs/components/prism-markdown'),
  diff: () => import('prismjs/components/prism-diff'),
  graphql: () => import('prismjs/components/prism-graphql'),
};

/** Prism 组件依赖链（对齐 prismjs components.json 的 require 声明） */
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

function getExtension(fileName?: string): string {
  if (!fileName) return '';
  const idx = fileName.lastIndexOf('.');
  return idx >= 0 ? fileName.slice(idx + 1).toLowerCase() : '';
}

function resolvePrismLanguage(ext: string): string | null {
  if (!ext) return null;
  return PRISM_LANGUAGE_ALIASES[ext] ?? (PRISM_LANGUAGE_LOADERS[ext] ? ext : null);
}

let prismCorePromise: Promise<PrismInstance | null> | null = null;

/** Prism 核心懒加载（CJS interop：default 导出 / 全局 Prism 双兜底） */
function loadPrismCore(): Promise<PrismInstance | null> {
  if (!prismCorePromise) {
    prismCorePromise = import('prismjs')
      .then((mod) => {
        const candidate = ((mod as { default?: unknown })?.default ?? mod) as PrismInstance;
        if (candidate && typeof candidate.highlight === 'function') {
          return candidate;
        }
        const globalPrism = (globalThis as { Prism?: PrismInstance }).Prism;
        return globalPrism && typeof globalPrism.highlight === 'function' ? globalPrism : null;
      })
      .catch((err: unknown) => {
        console.warn('[InlineDocumentViewer] Failed to load prism core:', err);
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
  for (const lang of collectPrismLanguageChain(language, [])) {
    if (loadedPrismLanguages.has(lang) || prism.languages[lang]) continue;
    const loader = PRISM_LANGUAGE_LOADERS[lang];
    if (!loader) continue;
    try {
      await loader();
      loadedPrismLanguages.add(lang);
    } catch (err: unknown) {
      console.warn(`[InlineDocumentViewer] Failed to load prism language "${lang}":`, err);
      return prism; // 核心可用但该语言缺失，调用方按 grammar 缺失降级
    }
  }
  return prism;
}

// ============================================================================
// 高亮 / 行号主题：基于语义 token 的亮暗两套配色（不引 Prism 外部 css）
// ============================================================================

const SYNTAX_THEME_STYLE_ID = 'idv-syntax-theme';

const SYNTAX_THEME_CSS = `
/* 行号 gutter：数字走 ::before content（不产生文本节点），复制/选区永不带行号 */
.idv-gutter > div::before {
  content: attr(data-ln);
}
.idv-syntax {
  --idv-hl-comment: hsl(var(--muted-foreground));
  --idv-hl-keyword: hsl(355 60% 44%);
  --idv-hl-string: hsl(212 90% 30%);
  --idv-hl-constant: hsl(212 90% 40%);
  --idv-hl-function: hsl(261 60% 48%);
  --idv-hl-entity: hsl(137 55% 27%);
  --idv-hl-regex: hsl(29 85% 32%);
}
:root.dark .idv-syntax {
  --idv-hl-keyword: hsl(347 85% 72%);
  --idv-hl-string: hsl(212 95% 80%);
  --idv-hl-constant: hsl(212 100% 74%);
  --idv-hl-function: hsl(261 85% 79%);
  --idv-hl-entity: hsl(115 45% 68%);
  --idv-hl-regex: hsl(29 90% 72%);
}
.idv-syntax .token.comment, .idv-syntax .token.prolog, .idv-syntax .token.doctype, .idv-syntax .token.cdata { color: var(--idv-hl-comment); font-style: italic; }
.idv-syntax .token.punctuation { color: hsl(var(--foreground) / 0.6); }
.idv-syntax .token.operator, .idv-syntax .token.combinator { color: hsl(var(--foreground) / 0.75); }
.idv-syntax .token.keyword, .idv-syntax .token.atrule, .idv-syntax .token.rule, .idv-syntax .token.important { color: var(--idv-hl-keyword); }
.idv-syntax .token.string, .idv-syntax .token.char, .idv-syntax .token.attr-value, .idv-syntax .token.url, .idv-syntax .token.template-string { color: var(--idv-hl-string); }
.idv-syntax .token.number, .idv-syntax .token.boolean, .idv-syntax .token.constant, .idv-syntax .token.symbol, .idv-syntax .token.unit { color: var(--idv-hl-constant); }
.idv-syntax .token.property, .idv-syntax .token.attr-name, .idv-syntax .token.variable, .idv-syntax .token.parameter { color: var(--idv-hl-constant); }
.idv-syntax .token.function, .idv-syntax .token.function-name, .idv-syntax .token.method { color: var(--idv-hl-function); }
.idv-syntax .token.class-name, .idv-syntax .token.maybe-class-name, .idv-syntax .token.tag, .idv-syntax .token.selector, .idv-syntax .token.builtin, .idv-syntax .token.namespace { color: var(--idv-hl-entity); }
.idv-syntax .token.regex { color: var(--idv-hl-regex); }
.idv-syntax .token.deleted { color: hsl(var(--destructive)); }
.idv-syntax .token.inserted { color: hsl(var(--success)); }
.idv-syntax .token.bold { font-weight: 600; }
.idv-syntax .token.italic { font-style: italic; }
/* 搜索匹配高亮：语义 token（primary 系），当前匹配加深加框 */
.idv-search-mark {
  background: hsl(var(--primary) / 0.22);
  color: inherit;
  border-radius: 2px;
}
.idv-search-mark--active {
  background: hsl(var(--primary) / 0.45);
  outline: 1px solid hsl(var(--primary));
}
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
 * 异步高亮 hook：Prism 核心与语言组件加载完成后才换入高亮 HTML，
 * 首帧始终纯文本（不阻塞展开动画）。code / 语言变化期间返回 null。
 */
function usePrismHighlight(code: string, ext: string, enabled: boolean): string | null {
  const language = enabled ? resolvePrismLanguage(ext) : null;
  const [result, setResult] = useState<{ code: string; language: string; html: string } | null>(null);

  useEffect(() => {
    if (!language || !code) return;
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
        console.warn('[InlineDocumentViewer] Prism highlight failed:', err);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  return language && result && result.code === code && result.language === language
    ? result.html
    : null;
}

// ============================================================================
// 搜索匹配
// ============================================================================

/** 全部匹配的起始偏移（大小写不敏感，上限截断） */
function findMatches(text: string, query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const source = text.toLowerCase();
  const matches: number[] = [];
  let idx = source.indexOf(q);
  while (idx !== -1 && matches.length < SEARCH_MAX_MATCHES) {
    matches.push(idx);
    idx = source.indexOf(q, idx + q.length);
  }
  return matches;
}

interface SearchHighlightedTextProps {
  text: string;
  queryLength: number;
  matches: number[];
  activeIndex: number;
  /** 可写 ref：当前匹配的 <mark> 通过回调 ref 写入，供滚动定位 */
  activeMarkRef: React.MutableRefObject<HTMLElement | null>;
}

/** 搜索态渲染：纯文本切段 + <mark>，当前匹配挂 ref 供滚动定位 */
const SearchHighlightedText: React.FC<SearchHighlightedTextProps> = ({
  text,
  queryLength,
  matches,
  activeIndex,
  activeMarkRef,
}) => {
  const segments: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((start, i) => {
    if (start > cursor) {
      segments.push(text.slice(cursor, start));
    }
    const isActive = i === activeIndex;
    segments.push(
      <mark
        key={`m-${start}`}
        ref={isActive ? (el) => { activeMarkRef.current = el; } : undefined}
        className={cn('idv-search-mark', isActive && 'idv-search-mark--active')}
      >
        {text.slice(start, start + queryLength)}
      </mark>
    );
    cursor = start + queryLength;
  });
  if (cursor < text.length) {
    segments.push(text.slice(cursor));
  }
  return <>{segments}</>;
};

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
  // ★ 低-14：小屏时搜索框改为弹性宽度，不再固定 90px
  const { isSmallScreen } = useBreakpoint();
  const title = titleProp || t('chatV2:documentViewer.defaultTitle');
  const ext = getExtension(fileName || titleProp);
  const isHighlightable = Boolean(resolvePrismLanguage(ext));

  // 状态
  const [fontScale, setFontScale] = useState(1);
  // 代码类内容默认不换行（配行号），普通文本默认换行
  const [wrap, setWrap] = useState(!isHighlightable);
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  const [activeMatch, setActiveMatch] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const activeMarkRef = useRef<HTMLElement | null>(null);
  const previewUrlsRef = useRef<Set<string>>(new Set());

  const text = textContent ?? '';

  // 卸载时兜底释放所有 blob URL（每次打开新窗口时也会先释放旧的，见 handleOpenExternal）
  useEffect(() => () => {
    previewUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
    previewUrlsRef.current.clear();
  }, []);

  // 文档切换时重置搜索与视图状态
  useEffect(() => {
    setQuery('');
    setActiveMatch(0);
    setFontScale(1);
  }, [text]);

  // 搜索匹配（真实匹配定位，替代原「字符比例滚动」）
  const matches = useMemo(() => findMatches(text, query), [text, query]);
  const queryLength = query.trim().length;
  const hasQuery = queryLength > 0;
  const clampedActiveMatch = matches.length > 0 ? Math.min(activeMatch, matches.length - 1) : 0;

  const gotoMatch = useCallback((direction: 1 | -1) => {
    if (matches.length === 0) return;
    setActiveMatch((prev) => {
      const bounded = Math.min(prev, matches.length - 1);
      return (bounded + direction + matches.length) % matches.length;
    });
  }, [matches.length]);

  // 当前匹配滚动到可视区中部
  useEffect(() => {
    if (!hasQuery || matches.length === 0) return;
    activeMarkRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
  }, [hasQuery, matches, clampedActiveMatch]);

  // 语法高亮（搜索态下让位给匹配标记渲染）
  const highlightEnabled = isHighlightable && !hasQuery && text.length > 0 && text.length <= HIGHLIGHT_MAX_CHARS;
  const highlightedHtml = usePrismHighlight(text, ext, highlightEnabled);

  // 行号列（仅无换行模式：换行时物理行与视觉行不一致，行号会错位）
  const showGutter = !wrap;
  const gutterRows = useMemo(() => {
    if (!showGutter) return null;
    let n = 1;
    let idx = -1;
    while ((idx = text.indexOf('\n', idx + 1)) !== -1) n++;
    return Array.from({ length: n }, (_, i) => <div key={i} data-ln={i + 1} />);
  }, [showGutter, text]);

  // 行号数字由 CSS content 生成，样式需在首帧前可用（与高亮共用同一 style 标签）
  useEffect(() => {
    if (isOpen) ensureSyntaxThemeStyles();
  }, [isOpen]);

  // 面板内快捷键（作用域限定在面板，不再监听 document）
  const handlePanelKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement | null;
    const isEditableTarget = !!target && (
      target.tagName === 'INPUT'
      || target.tagName === 'TEXTAREA'
      || target.isContentEditable
    );
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    // 输入框内打字时不响应字号快捷键（+/-/0 会同时改变字号）
    if (isEditableTarget) return;
    switch (e.key) {
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
  }, [onClose]);

  // 搜索框：Enter 下一处 / Shift+Enter 上一处
  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      gotoMatch(e.shiftKey ? -1 : 1);
    }
  }, [gotoMatch]);

  // 复制全文
  const handleCopy = useCallback(async () => {
    if (!text) return;
    try {
      await copyTextToClipboard(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (e: unknown) {
      console.error('Copy failed:', e);
    }
  }, [text]);

  // 下载
  const handleDownload = useCallback(async () => {
    if (!text) return;
    try {
      const defaultName = fileName || title || 'document.txt';
      await fileManager.saveTextFile({
        title: defaultName,
        defaultFileName: defaultName,
        content: text,
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
    } catch (e: unknown) {
      console.error('Download failed:', e);
    }
  }, [text, fileName, title]);

  // 新窗口打开
  const handleOpenExternal = useCallback(() => {
    if (!text) return;
    try {
      // noopener 下 window.open 恒返回 null，无法监听新窗口关闭。
      // 旧 URL 在新窗口加载后即无用：每次打开前先释放上一批，避免累计泄漏；
      // 卸载时的清理 effect 兜底释放最后一个。
      previewUrlsRef.current.forEach((u) => URL.revokeObjectURL(u));
      previewUrlsRef.current.clear();
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const previewUrl = URL.createObjectURL(blob);
      previewUrlsRef.current.add(previewUrl);
      window.open(previewUrl, '_blank', 'noopener,noreferrer');
    } catch (e: unknown) {
      console.error('Preview failed:', e);
    }
  }, [text]);

  if (!isOpen || !textContent) {
    return null;
  }

  const fontSize = Math.round(fontScale * 13);

  return (
    <div
      data-testid="inline-document-viewer"
      role="region"
      aria-label={title}
      tabIndex={-1}
      onKeyDown={handlePanelKeyDown}
      className={cn(
        'chat-msg-enter w-full overflow-hidden rounded-xl border border-border/60 bg-background shadow-sm',
        'flex flex-col',
        className
      )}
    >
      {/* 工具栏（小屏空间不足时允许换行，避免横向溢出） */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-border bg-muted/50 px-3 py-2">
        {/* 标题 + 扩展名徽标 */}
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {ext && (
            <span className="inline-flex shrink-0 items-center rounded border border-border bg-muted/60 px-1.5 py-px font-mono text-2xs font-medium uppercase tracking-wider text-foreground/70">
              {ext}
            </span>
          )}
          <span className="truncate text-sm font-medium text-foreground" title={title}>
            {title}
          </span>
        </div>

        {/* 搜索：真实匹配计数 + 上一处/下一处 */}
        <div className={cn('flex items-center gap-1', isSmallScreen && 'min-w-0 flex-1')}>
          <div className={cn('flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1', isSmallScreen && 'min-w-0 flex-1')}>
            <MagnifyingGlass size={14} className="text-muted-foreground" />
            <Input
              type="search"
              placeholder={t('chatV2:documentViewer.search')}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActiveMatch(0);
              }}
              onKeyDown={handleSearchKeyDown}
              className={cn(
                'bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground',
                isSmallScreen ? 'min-w-[120px] flex-1' : 'w-[90px]'
              )}
            />
            {hasQuery && (
              <span
                className={cn(
                  'min-w-[36px] text-center text-[11px] tabular-nums',
                  matches.length === 0 ? 'text-destructive' : 'text-muted-foreground'
                )}
              >
                {matches.length === 0
                  ? t('chatV2:documentViewer.noMatches')
                  : `${clampedActiveMatch + 1}/${matches.length}${matches.length >= SEARCH_MAX_MATCHES ? '+' : ''}`}
              </span>
            )}
          </div>
          <DsButton variant="ghost" size="icon" iconOnly disabled={matches.length === 0} onClick={() => gotoMatch(-1)} className="bg-muted hover:bg-[var(--interactive-hover)] disabled:opacity-40" aria-label={t('chatV2:documentViewer.prevMatch')} title={t('chatV2:documentViewer.prevMatch')}>
            <CaretUp size={14} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly disabled={matches.length === 0} onClick={() => gotoMatch(1)} className="bg-muted hover:bg-[var(--interactive-hover)] disabled:opacity-40" aria-label={t('chatV2:documentViewer.nextMatch')} title={t('chatV2:documentViewer.nextMatch')}>
            <CaretDown size={14} />
          </DsButton>
        </div>

        {/* 字号 / 换行 */}
        <div className="flex items-center gap-1">
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => setFontScale((prev) => Math.max(prev / 1.1, 0.75))} className="bg-muted hover:bg-[var(--interactive-hover)]" aria-label={t('common:imageViewer.zoomOut')} title={t('common:imageViewer.zoomOut')}>
            <MagnifyingGlassMinus size={15} />
          </DsButton>
          <span className="min-w-[42px] rounded-md bg-muted px-1.5 py-1 text-center text-xs font-medium text-muted-foreground">
            {Math.round(fontScale * 100)}%
          </span>
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => setFontScale((prev) => Math.min(prev * 1.1, 2))} className="bg-muted hover:bg-[var(--interactive-hover)]" aria-label={t('common:imageViewer.zoomIn')} title={t('common:imageViewer.zoomIn')}>
            <MagnifyingGlassPlus size={15} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => setFontScale(1)} className="bg-muted hover:bg-[var(--interactive-hover)]" aria-label={t('common:imageViewer.reset')} title={t('common:imageViewer.reset')}>
            <House size={15} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly onClick={() => setWrap((w) => !w)} className={cn(wrap ? 'bg-primary/20 text-primary' : 'bg-muted hover:bg-[var(--interactive-hover)]')} aria-label={wrap ? t('chatV2:documentViewer.noWrap') : t('chatV2:documentViewer.wrap')} title={wrap ? t('chatV2:documentViewer.noWrap') : t('chatV2:documentViewer.wrap')}>
            <TextIndent size={15} />
          </DsButton>
        </div>

        {/* 操作按钮 */}
        <div className="flex items-center gap-1">
          <DsButton variant="ghost" size="icon" iconOnly onClick={handleCopy} className="bg-muted hover:bg-[var(--interactive-hover)]" aria-label={t('common:actions.copy')} title={t('common:actions.copy')}>
            {copied ? <Check size={15} className="text-success" /> : <Copy size={15} />}
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly onClick={handleOpenExternal} className="bg-muted hover:bg-[var(--interactive-hover)]" aria-label={t('common:actions.open')} title={t('common:actions.open')}>
            <ArrowSquareOut size={15} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly onClick={handleDownload} className="bg-muted hover:bg-[var(--interactive-hover)]" aria-label={t('common:actions.download')} title={t('common:actions.download')}>
            <Download size={15} />
          </DsButton>
          <DsButton variant="ghost" size="icon" iconOnly onClick={onClose} className="hover:bg-destructive/20 hover:text-destructive" aria-label={t('common:actions.close')} title={t('common:actions.close')}>
            <X size={15} />
          </DsButton>
        </div>
      </div>

      {/* 文档内容：高度受限内部滚动（内联面板不占满消息流） */}
      <div
        ref={contentRef}
        className="max-h-[min(60vh,480px)] min-h-[120px] overflow-auto overscroll-contain"
      >
        <div className={cn('flex items-stretch', wrap ? 'w-full' : 'w-max min-w-full')}>
          {showGutter && (
            <div
              aria-hidden="true"
              className="idv-gutter sticky left-0 z-[1] shrink-0 select-none border-r border-border/60 bg-background py-3 pl-3 pr-2.5 text-right font-mono text-muted-foreground/50"
              style={{ fontSize: `${fontSize}px`, lineHeight: 1.7 }}
            >
              {gutterRows}
            </div>
          )}
          <pre
            className={cn(
              'm-0 flex-1 py-3 pl-3 pr-6 font-mono text-foreground',
              highlightedHtml && !hasQuery && 'idv-syntax'
            )}
            style={{
              whiteSpace: wrap ? 'pre-wrap' : 'pre',
              wordWrap: wrap ? 'break-word' : 'normal',
              lineHeight: 1.7,
              fontSize: `${fontSize}px`,
            }}
          >
            {hasQuery && matches.length > 0 ? (
              <SearchHighlightedText
                text={text}
                queryLength={queryLength}
                matches={matches}
                activeIndex={clampedActiveMatch}
                activeMarkRef={activeMarkRef}
              />
            ) : highlightedHtml ? (
              <code dangerouslySetInnerHTML={{ __html: highlightedHtml }} />
            ) : (
              text
            )}
          </pre>
        </div>
      </div>

      {/* 快捷键提示 */}
      <div className="border-t border-border px-3 py-1.5 text-[11px] text-muted-foreground">
        {t('chatV2:documentViewer.previewHint')}
      </div>
    </div>
  );
};

export default InlineDocumentViewer;
