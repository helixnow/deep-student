import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  ArrowDown,
  ArrowSquareOut,
  ArrowUp,
  ChatCircleDots,
  DotsThree,
  FloppyDisk,
  FolderOpen,
  MagnifyingGlass,
  Printer,
  X,
} from '@phosphor-icons/react';
import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';
import { useReferenceToChat, type SourceType } from '@/features/learning-hub/useReferenceToChat';
import type { DstuNode } from '@/dstu/types';
import { DsButton } from '@/components/ui/DsButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { saveResourceToDevice } from '@/features/learning-hub/apps/views/saveResourceToDevice';
import { getErrorMessage } from '@/utils/errorUtils';
import type { AppWindowProps } from '../../core/types';
import { useDragRenderPause } from '../../hooks/useDragRenderPause';
import { ContentEmptyState } from '../content/ContentEmptyState';
import { normalizeResourceInstanceKey } from '../content/resourceIdentity';
import {
  isPrintablePreview,
  isTextSearchablePreview,
  resolvePreviewShellMode,
} from './previewShellUtils';
import './FilePreviewAppWindow.css';

const MAX_SEARCH_MATCHES = 2_000;

const IS_MAC = typeof navigator !== 'undefined' && /mac|iphone|ipad|ipod/i.test(navigator.platform ?? '');

function shortcutLabel(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`;
}

const SUPPORTS_HIGHLIGHT_API =
  typeof globalThis.CSS !== 'undefined'
  && 'highlights' in globalThis.CSS
  && typeof (globalThis as { Highlight?: unknown }).Highlight === 'function';

interface SearchState {
  ranges: Range[];
  current: number;
}

export interface PreviewSelectionMetadata {
  selectedText?: string;
  locator?: string;
}

export function getPreviewHighlightNames(instanceKey: string | null): {
  all: string;
  current: string;
} {
  const suffix = normalizeResourceInstanceKey(instanceKey)?.replace(/[^a-zA-Z0-9_-]/g, '-') ?? 'empty';
  return {
    all: `file-preview-search-${suffix}`,
    current: `file-preview-search-current-${suffix}`,
  };
}

function closestElement(node: Node | null): Element | null {
  if (!node) return null;
  return node instanceof Element ? node : node.parentElement;
}

export function getPreviewSelectionMetadata(root: HTMLElement): PreviewSelectionMetadata {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return {};
  const range = selection.getRangeAt(0);
  if (!root.contains(range.commonAncestorContainer)) return {};

  const selectedText = selection.toString().trim().slice(0, 4_000);
  const startElement = closestElement(range.startContainer);
  const endElement = closestElement(range.endContainer);

  const startCell = startElement?.closest<HTMLElement>('[data-xlsx-cell]');
  const endCell = endElement?.closest<HTMLElement>('[data-xlsx-cell]');
  if (startCell) {
    const sheet = startCell.closest<HTMLElement>('[data-xlsx-sheet]')?.dataset.xlsxSheet;
    const start = startCell.dataset.xlsxCell;
    const end = endCell?.dataset.xlsxCell;
    const cellRange = end && end !== start ? `${start}:${end}` : start;
    return { selectedText, locator: sheet && cellRange ? `${sheet}!${cellRange}` : cellRange };
  }

  const slide = startElement?.closest('.pptx-preview-slide-wrapper');
  if (slide?.parentElement) {
    const slides = Array.from(slide.parentElement.querySelectorAll(':scope > .pptx-preview-slide-wrapper'));
    return { selectedText, locator: `slide:${Math.max(1, slides.indexOf(slide) + 1)}` };
  }

  const section = startElement?.closest('section.docx-preview, section.docx');
  if (section?.parentElement) {
    const sections = Array.from(section.parentElement.querySelectorAll(':scope > section'));
    return { selectedText, locator: `section:${Math.max(1, sections.indexOf(section) + 1)}` };
  }

  const pre = startElement?.closest('pre');
  if (pre) {
    const prefixRange = document.createRange();
    prefixRange.selectNodeContents(pre);
    prefixRange.setEnd(range.startContainer, range.startOffset);
    const startLine = prefixRange.toString().split(/\r\n|\r|\n/).length;
    const lineCount = selectedText.split(/\r\n|\r|\n/).length;
    return {
      selectedText,
      locator: lineCount > 1 ? `lines:${startLine}-${startLine + lineCount - 1}` : `line:${startLine}`,
    };
  }

  return selectedText ? { selectedText } : {};
}

function clearCssHighlights(names: { all: string; current: string }): void {
  const registry = (globalThis.CSS as unknown as { highlights?: Map<string, unknown> } | undefined)?.highlights;
  registry?.delete(names.all);
  registry?.delete(names.current);
}

function applyCssHighlights(ranges: Range[], current: number, names: { all: string; current: string }): void {
  const registry = (globalThis.CSS as unknown as {
    highlights?: { set: (name: string, value: unknown) => void; delete: (name: string) => void };
  } | undefined)?.highlights;
  const HighlightCtor = (globalThis as unknown as {
    Highlight?: new (...ranges: Range[]) => unknown;
  }).Highlight;
  if (!registry || !HighlightCtor) return;

  registry.set(names.all, new HighlightCtor(...ranges));
  if (ranges[current]) {
    registry.set(names.current, new HighlightCtor(ranges[current]));
  } else {
    registry.delete(names.current);
  }
}

/** Fallback when the CSS Highlight API is missing: make the current match visible via selection. */
function selectRangeFallback(range: Range): void {
  const selection = window.getSelection();
  if (!selection) return;
  selection.removeAllRanges();
  selection.addRange(range.cloneRange());
}

function findScrollContainer(start: Element | null, root: HTMLElement): HTMLElement | null {
  let element: HTMLElement | null = start instanceof HTMLElement ? start : start?.parentElement ?? null;
  while (element && root.contains(element)) {
    if (element.scrollHeight > element.clientHeight + 1) {
      const overflowY = window.getComputedStyle(element).overflowY;
      if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return element;
    }
    if (element === root) break;
    element = element.parentElement;
  }
  return null;
}

/**
 * Scroll a match into view using the range's own rect instead of
 * `startContainer.parentElement.scrollIntoView` (which centers the whole
 * ancestor block — unusable for matches inside a large `<pre>` or paragraph).
 */
function scrollRangeIntoView(range: Range, root: HTMLElement): void {
  const target = closestElement(range.startContainer);
  if (!target) return;
  const reduceMotion = typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';

  const rect = range.getBoundingClientRect();
  const scroller = findScrollContainer(target, root);
  if (!scroller || (rect.width === 0 && rect.height === 0)) {
    target.scrollIntoView({ behavior, block: 'center' });
    return;
  }

  const scrollerRect = scroller.getBoundingClientRect();
  const top = rect.top - scrollerRect.top - scroller.clientHeight / 2 + rect.height / 2;
  const outsideX = rect.left < scrollerRect.left || rect.right > scrollerRect.right;
  scroller.scrollBy({
    top,
    left: outsideX ? rect.left - scrollerRect.left - scroller.clientWidth / 2 : 0,
    behavior,
  });
}

function findTextRanges(root: HTMLElement, query: string): Range[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return [];

  const ranges: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || parent.closest('[data-file-preview-toolbar]')) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style, textarea, input, [aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
      return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  let node = walker.nextNode();
  while (node && ranges.length < MAX_SEARCH_MATCHES) {
    const text = node.textContent ?? '';
    const lower = text.toLocaleLowerCase();
    let offset = lower.indexOf(normalized);
    while (offset >= 0 && ranges.length < MAX_SEARCH_MATCHES) {
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, offset + normalized.length);
      ranges.push(range);
      offset = lower.indexOf(normalized, offset + Math.max(1, normalized.length));
    }
    node = walker.nextNode();
  }
  return ranges;
}

function sourceTypeForNode(node: DstuNode): SourceType | null {
  if (node.type === 'textbook') return 'textbook';
  if (node.type === 'image') return 'image';
  if (node.type === 'file') return 'file';
  return null;
}

interface ToolbarActionProps {
  label: string;
  shortcut?: string;
  /** Extra tooltip line, e.g. explaining why the action is disabled. */
  note?: string;
  disabled?: boolean;
  busy?: boolean;
  /** Toggle buttons: renders aria-pressed plus a persistent active background. */
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

// Trigger 用 span 包裹而非 asChild：禁用按钮 pointer-events 为 none，
// 悬停事件落在 span 上，禁用原因的 Tooltip 才能弹出。
const ToolbarAction: React.FC<ToolbarActionProps> = ({
  label,
  shortcut,
  note,
  disabled,
  busy,
  active,
  onClick,
  children,
}) => (
  <CommonTooltip
    position="bottom"
    content={
      <>
        {label}
        {shortcut ? <span className="wb-file-preview-kbd">{shortcut}</span> : null}
        {note ? <span className="wb-file-preview-tip-note">{note}</span> : null}
      </>
    }
  >
    <span className="wb-file-preview-tip-anchor">
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        onClick={onClick}
        disabled={disabled}
        aria-label={label}
        aria-pressed={active}
        className={active ? 'wb-file-preview-btn-active' : undefined}
      >
        {busy ? <span className="wb-file-preview-spinner" aria-hidden="true" /> : children}
      </DsButton>
    </span>
  </CommonTooltip>
);

const ToolbarSeparator: React.FC = () => (
  <span className="wb-file-preview-sep" role="separator" aria-orientation="vertical" />
);

const FilePreviewAppWindow: React.FC<AppWindowProps> = ({
  instanceKey,
  isActive,
  renderThrottleMs = 0,
  onTitleChange,
  requestClose,
}) => {
  const { t } = useTranslation('workbench');
  const resourceId = normalizeResourceInstanceKey(instanceKey);
  const highlightNames = useMemo(() => getPreviewHighlightNames(resourceId), [resourceId]);
  const previewRootRef = useRef<HTMLDivElement>(null);
  // 拖/缩/settle 期间冻结预览窗动画/过渡（CSS 定向规则见 FilePreviewAppWindow.css）
  useDragRenderPause(previewRootRef, renderThrottleMs);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const [node, setNode] = useState<DstuNode | null>(null);
  const [sourcePath, setSourcePath] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchState, setSearchState] = useState<SearchState>({ ranges: [], current: 0 });
  // 通过 ref 读取最新搜索状态，把滚动/高亮副作用留在 setState 之外
  const searchStateRef = useRef<SearchState>(searchState);
  useEffect(() => {
    searchStateRef.current = searchState;
  }, [searchState]);
  const [toolbarWidth, setToolbarWidth] = useState(Number.POSITIVE_INFINITY);
  const epubSelectionRef = useRef<PreviewSelectionMetadata>({});
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const { referenceToChat, canReferenceToChat } = useReferenceToChat();
  const reducedMotion = useReducedMotion();

  const previewMode = useMemo(() => resolvePreviewShellMode(node), [node]);
  // 节点未加载完成前先按可用处理，加载后再按类型收紧
  const canSearch = node === null || isTextSearchablePreview(previewMode);
  const canPrint = node !== null && isPrintablePreview(previewMode);
  // EPUB / PDF 自带结构化全文搜索（EPUB 侧栏、PDF 文本层扫描+高亮）。
  // 壳层 Cmd+F 只做转发：DOM 扫描对 iframe 化的 EPUB 够不着内容，
  // 对虚拟化 PDF 只能命中已渲染的少数页，都不能作为回退。
  const usesEmbeddedSearch = previewMode === 'epub' || previewMode === 'pdf';

  // 把打开搜索的请求转发给内嵌阅读器（EPUB 侧栏 / PDF 搜索条）。
  // 阅读器尚未挂载（加载中）时为 no-op，返回 false。
  const forwardSearchToEmbedded = useCallback((): boolean => {
    const root = previewRootRef.current;
    if (!root) return false;
    const epubTarget = root.querySelector('[data-epub-preview]');
    if (epubTarget) {
      epubTarget.dispatchEvent(new CustomEvent('epub-preview-open-search'));
      return true;
    }
    const pdfTarget = root.querySelector('[data-pdf-preview]');
    if (pdfTarget) {
      pdfTarget.dispatchEvent(new CustomEvent('pdf-preview-open-search'));
      return true;
    }
    return false;
  }, []);

  const openSearchPanel = useCallback(() => {
    if (forwardSearchToEmbedded()) return;
    if (usesEmbeddedSearch) return;
    setSearchOpen(true);
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, [forwardSearchToEmbedded, usesEmbeddedSearch]);

  const closeSearch = useCallback(() => {
    // Keep the query so reopening restores the last search (Chrome parity).
    setSearchOpen(false);
    previewRootRef.current?.focus({ preventScroll: true });
  }, []);

  // 加载期（node === null）先按可搜索放行；节点随后解析为图片/音视频等
  // 不可搜索类型时，收起可能已被 Cmd+F 打开的搜索条，避免停留在无效状态。
  // EPUB / PDF 同理收起：它们的搜索由内嵌阅读器负责，壳层搜索条对其无效。
  useEffect(() => {
    if (!canSearch || usesEmbeddedSearch) setSearchOpen(false);
  }, [canSearch, usesEmbeddedSearch]);

  const toggleSearchPanel = useCallback(() => {
    if (forwardSearchToEmbedded()) return;
    if (usesEmbeddedSearch) return;
    if (searchOpen) {
      closeSearch();
    } else {
      openSearchPanel();
    }
  }, [closeSearch, forwardSearchToEmbedded, openSearchPanel, searchOpen, usesEmbeddedSearch]);

  useEffect(() => {
    if (!node) return;
    let cancelled = false;
    setSourcePath(null);
    void invoke<string | null>('vfs_get_file_blob_path', { id: node.id })
      .then((path) => {
        if (!cancelled) setSourcePath(path || (node.metadata?.filePath as string | undefined) || null);
      })
      .catch(() => {
        if (!cancelled) setSourcePath((node.metadata?.filePath as string | undefined) || null);
      });
    return () => { cancelled = true; };
  }, [node]);

  useLayoutEffect(() => {
    const element = toolbarRef.current;
    if (!element) return;
    setToolbarWidth(element.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number') setToolbarWidth(width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [resourceId]);

  useEffect(() => {
    clearCssHighlights(highlightNames);
    if (!searchOpen || !searchQuery.trim() || !previewRootRef.current) {
      setSearchState({ ranges: [], current: 0 });
      return;
    }

    const root = previewRootRef.current;
    let frame = 0;
    let initialRun = true;
    const update = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const ranges = findTextRanges(root, searchQuery);
        // DOM 变更触发的重扫保留当前命中序号（夹取到新范围内），换关键词才归零
        const current = initialRun
          ? 0
          : Math.min(searchStateRef.current.current, Math.max(0, ranges.length - 1));
        applyCssHighlights(ranges, current, highlightNames);
        setSearchState({ ranges, current });
        if (initialRun) {
          initialRun = false;
          if (ranges[0]) {
            if (!SUPPORTS_HIGHLIGHT_API) selectRangeFallback(ranges[0]);
            scrollRangeIntoView(ranges[0], root);
          }
        }
      });
    };
    update();
    const observer = new MutationObserver(update);
    // 只观察内容区：命中计数等工具栏文本变化不应触发全文重扫
    const contentElement = root.querySelector('[data-file-preview-content]') ?? root;
    observer.observe(contentElement, { childList: true, subtree: true, characterData: true });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      clearCssHighlights(highlightNames);
    };
  }, [highlightNames, searchOpen, searchQuery, node?.id]);

  useEffect(() => () => clearCssHighlights(highlightNames), [highlightNames]);

  // Bound per resourceId: with the previous `[]` deps, mounting through the
  // empty state left previewRootRef.current null and the listener never bound.
  useEffect(() => {
    const root = previewRootRef.current;
    if (!root) return;
    const handleEpubSelection = (event: Event) => {
      epubSelectionRef.current = (event as CustomEvent<PreviewSelectionMetadata>).detail ?? {};
    };
    root.addEventListener('file-preview-selection', handleEpubSelection);
    return () => root.removeEventListener('file-preview-selection', handleEpubSelection);
  }, [resourceId]);

  useEffect(() => {
    epubSelectionRef.current = {};
  }, [node?.id]);

  const navigateSearch = useCallback((delta: number) => {
    const { ranges, current } = searchStateRef.current;
    const total = ranges.length;
    if (!total) return;
    let next = current;
    // DOM 变更后个别 Range 可能已失联（MutationObserver 重扫存在窗口期），跳过失效项
    for (let step = 0; step < total; step += 1) {
      next = (next + delta + total) % total;
      const range = ranges[next];
      if (range && range.startContainer.isConnected) {
        applyCssHighlights(ranges, next, highlightNames);
        const root = previewRootRef.current;
        if (root) {
          if (!SUPPORTS_HIGHLIGHT_API) selectRangeFallback(range);
          scrollRangeIntoView(range, root);
        }
        setSearchState((previous) => ({ ...previous, current: next }));
        return;
      }
    }
  }, [highlightNames]);

  const fileFilters = useMemo(() => {
    if (!node) return undefined;
    const extension = node.name.split('.').pop()?.toLowerCase();
    return extension ? [{ name: extension.toUpperCase(), extensions: [extension] }] : undefined;
  }, [node]);

  const runAction = useCallback(async (name: string, action: () => Promise<void>) => {
    setBusyAction(name);
    try {
      await action();
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    } finally {
      setBusyAction(null);
    }
  }, []);

  const handleSave = useCallback(() => runAction('save', async () => {
    if (!node) throw new Error(t('filePreview.downloadUnavailable'));
    // 共享双通道：blob 直拷贝优先，legacy 内联资源回退 base64 落盘
    const result = await saveResourceToDevice({
      nodeId: node.id,
      fileName: node.name,
      sourcePath,
      filters: fileFilters,
      title: t('filePreview.saveAs'),
      notFoundMessage: t('filePreview.downloadUnavailable'),
    });
    if (!result.canceled) showGlobalNotification('success', t('filePreview.downloadSuccess'));
  }), [fileFilters, node, runAction, sourcePath, t]);

  const handleOpen = useCallback(() => runAction('open', async () => {
    if (!sourcePath) throw new Error(t('filePreview.downloadUnavailable'));
    const { openPath } = await import('@tauri-apps/plugin-opener');
    await openPath(sourcePath);
  }), [runAction, sourcePath, t]);

  const handleReveal = useCallback(() => runAction('reveal', async () => {
    if (!sourcePath) throw new Error(t('filePreview.downloadUnavailable'));
    const { revealItemInDir } = await import('@tauri-apps/plugin-opener');
    await revealItemInDir(sourcePath);
  }), [runAction, sourcePath, t]);

  const handlePrint = useCallback(() => {
    if (!canPrint) {
      showGlobalNotification('info', t('filePreview.printUnsupported'));
      return;
    }
    const root = previewRootRef.current;
    if (!root) return;
    // Tag the printing window so print CSS only affects this preview and
    // never bleeds into portals, notifications, or other preview windows.
    root.setAttribute('data-file-preview-printing', '');
    // 双保险：window.print() 返回后立即清理；某些 WebKit 场景 print() 立刻返回、
    // 打印真正结束时才派发 afterprint。cleanup 自行摘除监听，避免残留。
    const cleanup = () => {
      root.removeAttribute('data-file-preview-printing');
      window.removeEventListener('afterprint', cleanup);
    };
    window.addEventListener('afterprint', cleanup);
    requestAnimationFrame(() => {
      try {
        window.print();
      } finally {
        cleanup();
      }
    });
  }, [canPrint, t]);

  const handleReference = useCallback(() => runAction('reference', async () => {
    if (!node) return;
    const sourceType = sourceTypeForNode(node);
    if (!sourceType) throw new Error(t('filePreview.referenceNotSupported'));
    const domSelectionMetadata = previewRootRef.current
      ? getPreviewSelectionMetadata(previewRootRef.current)
      : {};
    const selectionMetadata = domSelectionMetadata.selectedText
      ? domSelectionMetadata
      : epubSelectionRef.current;
    await referenceToChat({
      sourceType,
      sourceId: node.sourceId || node.id,
      metadata: { title: node.name, ...selectionMetadata },
    });
  }), [node, referenceToChat, runAction, t]);

  // Window-level shortcuts gated on window focus: reliable regardless of
  // which element inside the preview currently has DOM focus.
  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const mod = event.metaKey || event.ctrlKey;
      if (!mod && event.key === 'Escape' && searchOpen
        && (event.target === document.body
          || previewRootRef.current?.contains(event.target as Node))) {
        closeSearch();
        return;
      }
      if (!mod || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === 'f' && !event.shiftKey) {
        // 不可搜索类型不 preventDefault：让 Cmd+F 继续冒泡给其他消费者
        // （如 WebView / 全局命令），而不是被壳层空吞。
        if (canSearch) {
          event.preventDefault();
          openSearchPanel();
        }
      } else if (key === 'g' && searchOpen) {
        event.preventDefault();
        navigateSearch(event.shiftKey ? -1 : 1);
      } else if (key === 'p' && !event.shiftKey && !busyAction) {
        // 与工具栏打印钮的禁用条件对齐：文件对话框等忙碌期不弹打印
        event.preventDefault();
        handlePrint();
      } else if (key === 's' && !event.shiftKey && node && !busyAction) {
        // 保存走双通道（blob → base64 回退），无 blob 路径也可用
        event.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busyAction, canSearch, closeSearch, handlePrint, handleSave, isActive, navigateSearch, node, openSearchPanel, searchOpen]);

  const handleSearchInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    // 中文等 IME 组词中的 Enter 是确认候选词，不应触发跳转
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      navigateSearch(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeSearch();
    }
  }, [closeSearch, navigateSearch]);

  if (!resourceId) {
    return (
      <ContentEmptyState
        title={t('workbench:content.missingResource')}
        description={t('workbench:content.missingResourceHint')}
      />
    );
  }

  const actionsDisabled = !sourcePath || busyAction !== null;
  // 保存有 base64 回退通道，不依赖 blob 路径；打开/定位必须有真实文件路径
  const saveDisabled = !node || busyAction !== null;
  const collapseActions = toolbarWidth < (searchOpen ? 560 : 300);
  const truncated = searchState.ranges.length >= MAX_SEARCH_MATCHES;
  const hasQuery = Boolean(searchQuery.trim());
  const countLabel = !hasQuery
    ? ''
    : searchState.ranges.length
      ? `${searchState.current + 1}/${searchState.ranges.length}${truncated ? '+' : ''}`
      : t('filePreview.noMatches');
  const countHint = truncated
    ? t('filePreview.tooManyMatches', { limit: MAX_SEARCH_MATCHES })
    : !SUPPORTS_HIGHLIGHT_API && hasQuery && searchState.ranges.length
      ? t('filePreview.highlightUnsupported')
      : undefined;

  return (
    <div ref={previewRootRef} className="wb-file-preview" data-file-preview-root tabIndex={-1}>
      <style>{`
        ::highlight(${highlightNames.all}) { background-color: hsl(var(--warning) / 28%); }
        ::highlight(${highlightNames.current}) { background-color: hsl(var(--warning) / 90%); color: hsl(var(--warning-foreground)); }
      `}</style>
      <div
        ref={toolbarRef}
        className="wb-file-preview-toolbar"
        data-file-preview-toolbar
        role="toolbar"
        aria-label={t('workbench:apps.filePreview')}
      >
        <ToolbarAction
          label={t('filePreview.search')}
          shortcut={shortcutLabel('F')}
          note={canSearch ? undefined : t('filePreview.searchUnavailable')}
          disabled={!canSearch}
          active={searchOpen}
          onClick={toggleSearchPanel}
        >
          <MagnifyingGlass size={16} />
        </ToolbarAction>
        {!collapseActions && (
          <>
            <ToolbarSeparator />
            <ToolbarAction
              label={t('filePreview.saveAs')}
              shortcut={shortcutLabel('S')}
              disabled={saveDisabled}
              busy={busyAction === 'save'}
              onClick={() => { void handleSave(); }}
            >
              <FloppyDisk size={16} />
            </ToolbarAction>
            <ToolbarAction
              label={t('filePreview.openExternal')}
              disabled={actionsDisabled}
              busy={busyAction === 'open'}
              onClick={() => { void handleOpen(); }}
            >
              <ArrowSquareOut size={16} />
            </ToolbarAction>
            <ToolbarAction
              label={t('filePreview.showInFolder')}
              disabled={actionsDisabled}
              busy={busyAction === 'reveal'}
              onClick={() => { void handleReveal(); }}
            >
              <FolderOpen size={16} />
            </ToolbarAction>
            <ToolbarSeparator />
            <ToolbarAction
              label={t('filePreview.print')}
              shortcut={shortcutLabel('P')}
              note={canPrint ? undefined : t('filePreview.printUnsupported')}
              disabled={!canPrint || busyAction !== null}
              onClick={handlePrint}
            >
              <Printer size={16} />
            </ToolbarAction>
            <ToolbarSeparator />
          </>
        )}
        <ToolbarAction
          label={t('filePreview.referenceToChat')}
          disabled={!node || !canReferenceToChat() || busyAction !== null}
          busy={busyAction === 'reference'}
          onClick={() => { void handleReference(); }}
        >
          <ChatCircleDots size={16} />
        </ToolbarAction>
        <AnimatePresence initial={false}>
          {searchOpen && (
            <motion.div
              key="file-preview-search"
              className="wb-file-preview-search"
              role="search"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
              animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4, scale: 0.98 }}
              transition={
                reducedMotion
                  ? { duration: 0.01 }
                  : { duration: 0.15, ease: [0.22, 1, 0.36, 1] as [number, number, number, number] }
              }
            >
              <MagnifyingGlass size={14} className="wb-file-preview-search-icon" aria-hidden="true" />
              <input
                ref={searchInputRef}
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                onKeyDown={handleSearchInputKeyDown}
                placeholder={t('filePreview.searchPlaceholder')}
                aria-label={t('filePreview.search')}
              />
              <span
                className="wb-file-preview-search-count"
                aria-live="polite"
                title={countHint}
              >
                {countLabel}
              </span>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="wb-file-preview-search-btn"
                onClick={() => navigateSearch(-1)}
                disabled={!searchState.ranges.length}
                title={`${t('filePreview.previous')} (Shift+Enter)`}
                aria-label={t('filePreview.previous')}
              >
                <ArrowUp size={14} />
              </DsButton>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="wb-file-preview-search-btn"
                onClick={() => navigateSearch(1)}
                disabled={!searchState.ranges.length}
                title={`${t('filePreview.next')} (Enter)`}
                aria-label={t('filePreview.next')}
              >
                <ArrowDown size={14} />
              </DsButton>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="wb-file-preview-search-btn"
                onClick={closeSearch}
                title={`${t('filePreview.closeSearch')} (Esc)`}
                aria-label={t('filePreview.closeSearch')}
              >
                <X size={14} />
              </DsButton>
            </motion.div>
          )}
        </AnimatePresence>
        {collapseActions && (
          <AppMenu className={searchOpen ? undefined : 'ml-auto'}>
            <AppMenuTrigger asChild>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
                aria-label={t('filePreview.moreActions')}
              >
                <DotsThree size={16} weight="bold" />
              </DsButton>
            </AppMenuTrigger>
            <AppMenuContent align="end" width={240}>
              <AppMenuItem
                icon={<FloppyDisk size={16} />}
                shortcut={shortcutLabel('S')}
                disabled={saveDisabled}
                onClick={() => { void handleSave(); }}
              >
                {t('filePreview.saveAs')}
              </AppMenuItem>
              <AppMenuItem
                icon={<ArrowSquareOut size={16} />}
                disabled={actionsDisabled}
                onClick={() => { void handleOpen(); }}
              >
                {t('filePreview.openExternal')}
              </AppMenuItem>
              <AppMenuItem
                icon={<FolderOpen size={16} />}
                disabled={actionsDisabled}
                onClick={() => { void handleReveal(); }}
              >
                {t('filePreview.showInFolder')}
              </AppMenuItem>
              <AppMenuSeparator />
              <AppMenuItem
                icon={<Printer size={16} />}
                shortcut={shortcutLabel('P')}
                disabled={!canPrint || busyAction !== null}
                onClick={handlePrint}
              >
                {t('filePreview.print')}
              </AppMenuItem>
            </AppMenuContent>
          </AppMenu>
        )}
      </div>
      <div className="wb-file-preview-content" data-file-preview-content>
        <UnifiedAppPanel
          type="file"
          resourceId={resourceId}
          dstuPath={`/${resourceId}`}
          preferNodeType
          isActive={isActive}
          onNodeLoaded={setNode}
          onTitleChange={onTitleChange}
          onClose={requestClose}
          className="h-full"
        />
      </div>
    </div>
  );
};

export default FilePreviewAppWindow;
