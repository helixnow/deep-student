import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowCounterClockwise,
  CaretDown,
  CaretLeft,
  CaretRight,
  CaretUp,
  CircleNotch,
  List,
  MagnifyingGlass,
  Minus,
  Plus,
  SidebarSimple,
  TextAa,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  EPUB_SEARCH_RESULT_LIMIT,
  loadEpubBook,
  renderEpubChapter,
  resolveEpubNavigation,
  searchEpubBook,
  type EpubBookModel,
  type EpubReaderFontFamily,
  type EpubSearchResult,
} from './epubReaderModel';
import { PreviewStatus } from './PreviewStatus';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import './EpubPreview.css';

type ReaderTheme = 'light' | 'sepia' | 'dark' | 'app';

const THEME_OPTIONS: ReaderTheme[] = ['app', 'light', 'sepia', 'dark'];
const FONT_FAMILY_OPTIONS: EpubReaderFontFamily[] = ['book', 'serif', 'sans'];
const MIN_FONT_SCALE = 0.75;
const MAX_FONT_SCALE = 1.8;
const DEFAULT_LINE_HEIGHT = 1.75;
const MIN_LINE_HEIGHT = 1.3;
const MAX_LINE_HEIGHT = 2.2;
const DEFAULT_PAGE_MARGIN = 0.4;
const MAX_FRAME_MARKS = 400;

interface PersistedReaderState {
  chapterIndex: number;
  chapterProgress: number;
  theme: ReaderTheme;
  fontScale: number;
  fontFamily: EpubReaderFontFamily;
  lineHeight: number;
  pageMargin: number;
}

export interface EpubPreviewProps {
  base64Content: string;
  fileName: string;
  resourceId: string;
}

function loadReaderState(key: string): PersistedReaderState {
  const fallback: PersistedReaderState = {
    chapterIndex: 0,
    chapterProgress: 0,
    theme: 'light',
    fontScale: 1,
    fontFamily: 'book',
    lineHeight: DEFAULT_LINE_HEIGHT,
    pageMargin: DEFAULT_PAGE_MARGIN,
  };
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<PersistedReaderState>;
    // Older persisted payloads only carried {chapterIndex, chapterProgress,
    // theme, fontScale}; every field falls back independently so they still load.
    const pageMargin = Number(value.pageMargin);
    return {
      chapterIndex: Math.max(0, Math.floor(Number(value.chapterIndex) || 0)),
      chapterProgress: Math.min(1, Math.max(0, Number(value.chapterProgress) || 0)),
      theme: value.theme === 'dark' || value.theme === 'sepia' || value.theme === 'app' ? value.theme : 'light',
      fontScale: Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, Number(value.fontScale) || 1)),
      fontFamily: value.fontFamily === 'serif' || value.fontFamily === 'sans' ? value.fontFamily : 'book',
      lineHeight: Math.min(MAX_LINE_HEIGHT, Math.max(MIN_LINE_HEIGHT, Number(value.lineHeight) || DEFAULT_LINE_HEIGHT)),
      pageMargin: Number.isFinite(pageMargin) ? Math.min(1, Math.max(0, pageMargin)) : DEFAULT_PAGE_MARGIN,
    };
  } catch {
    return fallback;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const EpubPreview: React.FC<EpubPreviewProps> = ({ base64Content, fileName, resourceId }) => {
  const { t } = useTranslation(['learningHub', 'common']);
  // 与 App shell 同源的移动端判定（<768px）；旧实现自造 700px 断点，
  // 700-767px 区间会与 EpubPreview.css 的移动样式及全局移动壳分叉
  const isNarrow = useIsMobile();
  const storageKey = `epub-reader:${resourceId}`;
  const initialState = useMemo(() => loadReaderState(storageKey), [storageKey]);
  const rootRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const tocRef = useRef<HTMLDivElement>(null);
  const iframeCleanupRef = useRef<(() => void) | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const pendingFragmentRef = useRef<string | null>(null);
  const pendingSearchRef = useRef<{ query: string; matchIndex: number } | null>(null);
  const restoreProgressRef = useRef(initialState.chapterProgress);
  const chapterProgressRef = useRef(initialState.chapterProgress);
  const renderedChapterRef = useRef<number | null>(null);
  const frameMarksRef = useRef<HTMLElement[]>([]);
  const persistStateRef = useRef<PersistedReaderState>({ ...initialState });
  const persistTimerRef = useRef(0);
  const [book, setBook] = useState<EpubBookModel | null>(null);
  const [srcDoc, setSrcDoc] = useState('');
  const [frameGeneration, setFrameGeneration] = useState(0);
  const [chapterIndex, setChapterIndex] = useState(initialState.chapterIndex);
  const [chapterProgress, setChapterProgress] = useState(initialState.chapterProgress);
  const [theme, setTheme] = useState<ReaderTheme>(initialState.theme);
  const [fontScale, setFontScale] = useState(initialState.fontScale);
  const [fontFamily, setFontFamily] = useState<EpubReaderFontFamily>(initialState.fontFamily);
  const [lineHeight, setLineHeight] = useState(initialState.lineHeight);
  const [pageMargin, setPageMargin] = useState(initialState.pageMargin);
  const [appDark, setAppDark] = useState(() => document.documentElement.classList.contains('dark'));
  const [sidebarOpen, setSidebarOpen] = useState(!isNarrow);
  const [sidebarMode, setSidebarMode] = useState<'toc' | 'search'>('toc');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EpubSearchResult[]>([]);
  const [activeResultIndex, setActiveResultIndex] = useState(-1);
  const [frameMatch, setFrameMatch] = useState<{ current: number; total: number } | null>(null);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);

  const resolvedTheme: 'light' | 'sepia' | 'dark' = theme === 'app' ? (appDark ? 'dark' : 'light') : theme;

  useEffect(() => {
    if (isNarrow) setSidebarOpen(false);
  }, [isNarrow, resourceId]);

  useEffect(() => {
    if (!isNarrow || !sidebarOpen) return;
    return registerBackHandler(() => {
      setSidebarOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isNarrow, sidebarOpen]);

  // Follow app theme (html.dark) for the "auto" reading theme.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setAppDark(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setBook(null);
    setSrcDoc('');
    setChapterIndex(initialState.chapterIndex);
    setChapterProgress(initialState.chapterProgress);
    setTheme(initialState.theme);
    setFontScale(initialState.fontScale);
    setFontFamily(initialState.fontFamily);
    setLineHeight(initialState.lineHeight);
    setPageMargin(initialState.pageMargin);
    setFrameMatch(null);
    frameMarksRef.current = [];
    restoreProgressRef.current = initialState.chapterProgress;
    chapterProgressRef.current = initialState.chapterProgress;
    renderedChapterRef.current = null;
    void loadEpubBook(base64Content)
      .then((loadedBook) => {
        if (cancelled) return;
        setBook(loadedBook);
        setChapterIndex(Math.min(initialState.chapterIndex, loadedBook.chapters.length - 1));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(getErrorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [base64Content, initialState, reloadGeneration]);

  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    // Re-render of the same chapter (theme/typography change): remember the
    // current scroll progress so it can be restored after the iframe reloads.
    if (renderedChapterRef.current === chapterIndex) {
      restoreProgressRef.current = chapterProgressRef.current;
    }
    renderedChapterRef.current = chapterIndex;
    setLoading(true);
    void renderEpubChapter(book, chapterIndex, {
      theme: resolvedTheme,
      fontScale,
      fontFamily,
      lineHeight,
      pageMargin,
    })
      .then((rendered) => {
        if (cancelled) {
          rendered.objectUrls.forEach(URL.revokeObjectURL);
          return;
        }
        objectUrlsRef.current.forEach(URL.revokeObjectURL);
        objectUrlsRef.current = rendered.objectUrls;
        setSrcDoc(rendered.srcDoc);
        setFrameGeneration((generation) => generation + 1);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(getErrorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [book, chapterIndex, resolvedTheme, fontScale, fontFamily, lineHeight, pageMargin]);

  useEffect(() => () => {
    iframeCleanupRef.current?.();
    objectUrlsRef.current.forEach(URL.revokeObjectURL);
  }, []);

  // Debounced persistence: scroll progress updates at rAF frequency, so the
  // localStorage write is delayed and flushed on unmount / window unload.
  const flushPersist = useCallback(() => {
    if (persistTimerRef.current) {
      window.clearTimeout(persistTimerRef.current);
      persistTimerRef.current = 0;
    }
    try {
      localStorage.setItem(storageKey, JSON.stringify(persistStateRef.current));
    } catch {
      // Quota errors are non-fatal for reading.
    }
  }, [storageKey]);

  useEffect(() => {
    persistStateRef.current = { chapterIndex, chapterProgress, theme, fontScale, fontFamily, lineHeight, pageMargin };
    if (persistTimerRef.current) window.clearTimeout(persistTimerRef.current);
    persistTimerRef.current = window.setTimeout(() => {
      persistTimerRef.current = 0;
      try {
        localStorage.setItem(storageKey, JSON.stringify(persistStateRef.current));
      } catch {
        // Quota errors are non-fatal for reading.
      }
    }, 500);
  }, [chapterIndex, chapterProgress, theme, fontScale, fontFamily, lineHeight, pageMargin, storageKey]);

  useEffect(() => {
    // Flushing pending reading progress on window close cannot go through the
    // app-level event registry (it must run during unload).
    // eslint-disable-next-line no-restricted-syntax
    window.addEventListener('beforeunload', flushPersist);
    return () => {
      window.removeEventListener('beforeunload', flushPersist);
      flushPersist();
    };
  }, [flushPersist]);

  useEffect(() => {
    const root = rootRef.current;
    const openSearch = () => {
      setSidebarOpen(true);
      setSidebarMode('search');
    };
    root?.addEventListener('epub-preview-open-search', openSearch);
    return () => root?.removeEventListener('epub-preview-open-search', openSearch);
  }, []);

  const clearFrameHighlights = useCallback(() => {
    frameMarksRef.current = [];
    setFrameMatch(null);
    const document = iframeRef.current?.contentDocument;
    if (!document) return;
    document.querySelectorAll('mark[data-epub-search]').forEach((mark) => {
      const parent = mark.parentNode;
      mark.replaceWith(...Array.from(mark.childNodes));
      parent?.normalize();
    });
  }, []);

  const setCurrentFrameMatch = useCallback((index: number, smooth = true) => {
    const marks = frameMarksRef.current;
    if (!marks.length) return;
    const bounded = ((index % marks.length) + marks.length) % marks.length;
    marks.forEach((mark, markIndex) => {
      if (markIndex === bounded) mark.setAttribute('data-current', '');
      else mark.removeAttribute('data-current');
    });
    marks[bounded].scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
    setFrameMatch({ current: bounded, total: marks.length });
  }, []);

  const highlightFrameText = useCallback((query: string, targetIndex = 0) => {
    clearFrameHighlights();
    const document = iframeRef.current?.contentDocument;
    const trimmed = query.trim();
    if (!document?.body || !trimmed) return;
    let pattern: RegExp;
    try {
      pattern = new RegExp(escapeRegExp(trimmed), 'gi');
    } catch {
      return;
    }
    // SVG subtrees stay searchable at the chapter level, but wrapping their
    // text nodes in an HTML <mark> would drop them from SVG rendering.
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest('style, script, title, svg, mark[data-epub-search]')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    const textNodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      textNodes.push(node as Text);
      node = walker.nextNode();
    }
    const marks: HTMLElement[] = [];
    for (const textNode of textNodes) {
      if (marks.length >= MAX_FRAME_MARKS) break;
      const text = textNode.textContent ?? '';
      pattern.lastIndex = 0;
      const ranges: Array<[number, number]> = [];
      let match = pattern.exec(text);
      while (match) {
        if (!match[0]) break;
        ranges.push([match.index, match[0].length]);
        match = pattern.exec(text);
      }
      // Wrap from the last range to the first so earlier offsets stay valid
      // while the text node is being split.
      const nodeMarks: HTMLElement[] = [];
      for (const [start, length] of ranges.reverse()) {
        try {
          const target = textNode.splitText(start);
          target.splitText(Math.min(length, target.length));
          const mark = document.createElement('mark');
          mark.setAttribute('data-epub-search', '');
          target.replaceWith(mark);
          mark.append(target);
          nodeMarks.unshift(mark);
        } catch {
          // Skip a hit that cannot be wrapped instead of failing the search.
        }
      }
      marks.push(...nodeMarks);
    }
    frameMarksRef.current = marks;
    if (marks.length) setCurrentFrameMatch(targetIndex, false);
  }, [clearFrameHighlights, setCurrentFrameMatch]);

  useEffect(() => {
    setActiveResultIndex(-1);
    if (!book || !searchQuery.trim()) {
      setSearchResults([]);
      setSearching(false);
      clearFrameHighlights();
      return;
    }
    let cancelled = false;
    setSearching(true);
    const timer = window.setTimeout(() => {
      void searchEpubBook(book, searchQuery).then((results) => {
        if (!cancelled) setSearchResults(results);
      }).finally(() => {
        if (!cancelled) setSearching(false);
      });
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [book, searchQuery, clearFrameHighlights]);

  const navigateToChapter = useCallback((
    nextIndex: number,
    fragment?: string,
    search?: { query: string; matchIndex: number }
  ) => {
    if (!book) return;
    // Any explicit navigation replaces a not-yet-applied search focus so a
    // stale highlight cannot fire on the next frame load.
    pendingSearchRef.current = search ?? null;
    const bounded = Math.max(0, Math.min(book.chapters.length - 1, nextIndex));
    if (bounded === chapterIndex) {
      pendingSearchRef.current = null;
      if (search) {
        highlightFrameText(search.query, search.matchIndex);
        return;
      }
      const document = iframeRef.current?.contentDocument;
      if (fragment) document?.getElementById(fragment)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      else iframeRef.current?.contentWindow?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    pendingFragmentRef.current = fragment ?? null;
    restoreProgressRef.current = 0;
    chapterProgressRef.current = 0;
    setChapterProgress(0);
    setChapterIndex(bounded);
  }, [book, chapterIndex, highlightFrameText]);

  const navigateToSearchResult = useCallback((result: EpubSearchResult, resultIndex: number) => {
    setActiveResultIndex(resultIndex);
    navigateToChapter(result.chapterIndex, undefined, {
      query: searchQuery,
      matchIndex: result.matchIndex,
    });
  }, [navigateToChapter, searchQuery]);

  const pageBy = useCallback((direction: 1 | -1) => {
    const lastChapter = (book?.chapters.length ?? 1) - 1;
    const frameWindow = iframeRef.current?.contentWindow;
    const document = iframeRef.current?.contentDocument;
    if (!frameWindow || !document) {
      navigateToChapter(chapterIndex + direction);
      return;
    }
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - frameWindow.innerHeight);
    if (direction > 0 && frameWindow.scrollY >= maxScroll - 2) {
      // At the very end/start of the book there is nowhere to go; do not fall
      // into the same-chapter branch, which would scroll back to the top.
      if (chapterIndex < lastChapter) navigateToChapter(chapterIndex + 1);
    } else if (direction < 0 && frameWindow.scrollY <= 2) {
      if (chapterIndex > 0) navigateToChapter(chapterIndex - 1);
    } else {
      frameWindow.scrollBy({ top: direction * frameWindow.innerHeight * 0.88, behavior: 'smooth' });
    }
  }, [book, chapterIndex, navigateToChapter]);

  const handleFrameLoad = useCallback(() => {
    iframeCleanupRef.current?.();
    const frame = iframeRef.current;
    const frameWindow = frame?.contentWindow;
    const document = frame?.contentDocument;
    if (!frameWindow || !document) return;
    frameMarksRef.current = [];
    setFrameMatch(null);

    const fragment = pendingFragmentRef.current;
    pendingFragmentRef.current = null;
    let restoreFrame = 0;
    let restoreTimer = 0;
    if (fragment) {
      document.getElementById(fragment)?.scrollIntoView({ block: 'start' });
    } else if (restoreProgressRef.current > 0) {
      const targetProgress = restoreProgressRef.current;
      const restorePosition = () => {
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - frameWindow.innerHeight);
        frameWindow.scrollTo({ top: maxScroll * targetProgress });
      };
      restorePosition();
      restoreFrame = frameWindow.requestAnimationFrame(() => {
        restoreFrame = frameWindow.requestAnimationFrame(restorePosition);
      });
      restoreTimer = frameWindow.setTimeout(restorePosition, 500);
      restoreProgressRef.current = 0;
    }
    const pendingSearch = pendingSearchRef.current;
    pendingSearchRef.current = null;
    if (pendingSearch) {
      highlightFrameText(pendingSearch.query, pendingSearch.matchIndex);
    }

    let frameRequest = 0;
    const updateProgress = () => {
      if (frameRequest) return;
      frameRequest = frameWindow.requestAnimationFrame(() => {
        frameRequest = 0;
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - frameWindow.innerHeight);
        const progress = maxScroll > 0 ? Math.min(1, frameWindow.scrollY / maxScroll) : 1;
        chapterProgressRef.current = progress;
        setChapterProgress(progress);
      });
    };
    const updateSelection = () => {
      const selection = frameWindow.getSelection();
      const selectedText = selection?.toString().trim().slice(0, 4_000) ?? '';
      rootRef.current?.dispatchEvent(new CustomEvent('file-preview-selection', {
        bubbles: true,
        detail: selectedText
          ? { selectedText, locator: `chapter:${chapterIndex + 1}` }
          : {},
      }));
    };
    const handleClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      const destination = resolveEpubNavigation(book, chapterIndex, href);
      event.preventDefault();
      if (destination) {
        navigateToChapter(destination.chapterIndex, destination.fragment);
      } else if (/^(?:https?:|mailto:|tel:)/i.test(href)) {
        void import('@tauri-apps/plugin-opener').then(({ openUrl }) => openUrl(href));
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setSidebarOpen(true);
        setSidebarMode('search');
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - frameWindow.innerHeight);
      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault();
          pageBy(1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          pageBy(-1);
          break;
        case 'Home':
          event.preventDefault();
          frameWindow.scrollTo({ top: 0, behavior: 'smooth' });
          break;
        case 'End':
          event.preventDefault();
          frameWindow.scrollTo({ top: maxScroll, behavior: 'smooth' });
          break;
        default:
      }
    };
    // 📱 触屏左右滑动翻页（最小版）：只在横向位移显著大于纵向（>2 倍）
    // 且超过 60px 时触发，纵向阅读滚动/斜向手势/双指缩放/选字均不受影响。
    // 监听 passive，不 preventDefault —— 不与 iframe 内原生滚动争夺手势。
    let swipeStart: { x: number; y: number } | null = null;
    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        swipeStart = null;
        return;
      }
      // 起点在可横向滚动的表格/代码块内：手势归它们自己，不参与翻页
      const target = event.target as Element | null;
      if (target?.closest?.('table, pre')) {
        swipeStart = null;
        return;
      }
      swipeStart = { x: event.touches[0].clientX, y: event.touches[0].clientY };
    };
    const handleTouchEnd = (event: TouchEvent) => {
      const start = swipeStart;
      swipeStart = null;
      if (!start || event.touches.length > 0) return;
      const touch = event.changedTouches[0];
      if (!touch) return;
      // 有选区时按选字语义处理，不翻页
      if (frameWindow.getSelection()?.toString().trim()) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 2) return;
      pageBy(dx < 0 ? 1 : -1);
    };
    frameWindow.addEventListener('scroll', updateProgress, { passive: true });
    // The EPUB document lives in an iframe and cannot use the app-level event registry.
    // eslint-disable-next-line no-restricted-syntax
    document.addEventListener('selectionchange', updateSelection);
    // eslint-disable-next-line no-restricted-syntax
    document.addEventListener('click', handleClick);
    // eslint-disable-next-line no-restricted-syntax
    document.addEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line no-restricted-syntax
    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    // eslint-disable-next-line no-restricted-syntax
    document.addEventListener('touchend', handleTouchEnd, { passive: true });
    iframeCleanupRef.current = () => {
      frameWindow.removeEventListener('scroll', updateProgress);
      document.removeEventListener('selectionchange', updateSelection);
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchend', handleTouchEnd);
      if (frameRequest) frameWindow.cancelAnimationFrame(frameRequest);
      if (restoreFrame) frameWindow.cancelAnimationFrame(restoreFrame);
      if (restoreTimer) frameWindow.clearTimeout(restoreTimer);
    };
  }, [book, chapterIndex, highlightFrameText, navigateToChapter, pageBy]);

  const handleRootKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable) return;
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      pageBy(1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      pageBy(-1);
    } else if (event.key === 'Home' || event.key === 'End') {
      const frameWindow = iframeRef.current?.contentWindow;
      const document = iframeRef.current?.contentDocument;
      if (!frameWindow || !document) return;
      event.preventDefault();
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - frameWindow.innerHeight);
      frameWindow.scrollTo({ top: event.key === 'Home' ? 0 : maxScroll, behavior: 'smooth' });
    }
  }, [pageBy]);

  const handleSearchInputKeyDown = useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || !searchResults.length) return;
    event.preventDefault();
    const step = event.shiftKey ? -1 : 1;
    const next = activeResultIndex < 0
      ? (step > 0 ? 0 : searchResults.length - 1)
      : ((activeResultIndex + step) % searchResults.length + searchResults.length) % searchResults.length;
    navigateToSearchResult(searchResults[next], next);
  }, [activeResultIndex, navigateToSearchResult, searchResults]);

  // Keep the active TOC entry visible while reading.
  useEffect(() => {
    if (!sidebarOpen || sidebarMode !== 'toc') return;
    tocRef.current?.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [chapterIndex, sidebarMode, sidebarOpen, book]);

  const resetTypography = useCallback(() => {
    setFontScale(1);
    setFontFamily('book');
    setLineHeight(DEFAULT_LINE_HEIGHT);
    setPageMargin(DEFAULT_PAGE_MARGIN);
  }, []);

  const renderExcerpt = useCallback((excerpt: string) => {
    const query = searchQuery.trim();
    if (!query) return excerpt;
    const lower = excerpt.toLocaleLowerCase();
    if (lower.length !== excerpt.length) return excerpt;
    const index = lower.indexOf(query.toLocaleLowerCase());
    if (index < 0) return excerpt;
    return (
      <>
        {excerpt.slice(0, index)}
        <mark>{excerpt.slice(index, index + query.length)}</mark>
        {excerpt.slice(index + query.length)}
      </>
    );
  }, [searchQuery]);

  const overallProgress = book
    ? Math.round(((chapterIndex + chapterProgress) / book.chapters.length) * 100)
    : 0;

  const themeLabels: Record<ReaderTheme, string> = {
    app: t('learningHub:epubPreview.themeAuto'),
    light: t('learningHub:epubPreview.themeLight'),
    sepia: t('learningHub:epubPreview.themeSepia'),
    dark: t('learningHub:epubPreview.themeDark'),
  };
  const fontFamilyLabels: Record<EpubReaderFontFamily, string> = {
    book: t('learningHub:epubPreview.fontFamilyBook'),
    serif: t('learningHub:epubPreview.fontFamilySerif'),
    sans: t('learningHub:epubPreview.fontFamilySans'),
  };

  if (error) {
    return (
      <PreviewStatus
        tone="error"
        title={t('learningHub:epubPreview.loadFailed')}
        description={error}
        actions={[{
          id: 'retry',
          label: t('common:retry'),
          onClick: () => setReloadGeneration((generation) => generation + 1),
          loading,
        }]}
        className="epub-preview-state"
      />
    );
  }

  if (!book) {
    return (
      <PreviewStatus
        tone="loading"
        title={t('learningHub:epubPreview.loading')}
        className="epub-preview-state"
      />
    );
  }

  return (
    <div
      ref={rootRef}
      className={`epub-preview epub-preview-${resolvedTheme}`}
      data-epub-preview
      onKeyDown={handleRootKeyDown}
    >
      <div className="epub-preview-toolbar" role="toolbar" aria-label={t('learningHub:epubPreview.readerToolbar')}>
        <DsButton variant="ghost" size="icon" iconOnly onClick={() => setSidebarOpen((value) => !value)} title={t('learningHub:epubPreview.toggleSidebar')} aria-label={t('learningHub:epubPreview.toggleSidebar')} aria-expanded={sidebarOpen}>
          <SidebarSimple size={16} />
        </DsButton>
        <div className="epub-preview-book-title" title={`${book.title}${book.author ? ` - ${book.author}` : ''}`}>
          <strong>{book.title || fileName}</strong>
          {book.author && <span>{book.author}</span>}
        </div>
        <div className="epub-preview-toolbar-spacer" />
        <div className="epub-preview-theme-seg" role="radiogroup" aria-label={t('learningHub:epubPreview.theme')}>
          {THEME_OPTIONS.map((option) => (
            <DsButton
              key={option}
              variant="ghost"
              size="icon"
              iconOnly
              role="radio"
              aria-checked={theme === option}
              className="epub-preview-theme-btn"
              onClick={() => setTheme(option)}
              title={themeLabels[option]}
              aria-label={themeLabels[option]}
            >
              <span className={`epub-preview-theme-dot epub-preview-theme-dot-${option}`} aria-hidden="true" />
            </DsButton>
          ))}
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <DsButton variant="ghost" size="icon" iconOnly title={t('learningHub:epubPreview.displaySettings')} aria-label={t('learningHub:epubPreview.displaySettings')}>
              <TextAa size={16} />
            </DsButton>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={6} className="epub-preview-settings" aria-label={t('learningHub:epubPreview.displaySettings')}>
            <div className="epub-preview-settings-row epub-preview-settings-theme-row">
              <span className="epub-preview-settings-label">{t('learningHub:epubPreview.theme')}</span>
              <div className="epub-preview-settings-seg" role="radiogroup" aria-label={t('learningHub:epubPreview.theme')}>
                {THEME_OPTIONS.map((option) => (
                  <DsButton
                    key={option}
                    variant="ghost"
                    size="icon"
                    iconOnly
                    role="radio"
                    aria-checked={theme === option}
                    className="epub-preview-theme-btn"
                    onClick={() => setTheme(option)}
                    title={themeLabels[option]}
                    aria-label={themeLabels[option]}
                  >
                    <span className={`epub-preview-theme-dot epub-preview-theme-dot-${option}`} aria-hidden="true" />
                  </DsButton>
                ))}
              </div>
            </div>
            <div className="epub-preview-settings-row">
              <span className="epub-preview-settings-label">{t('learningHub:epubPreview.fontSize')}</span>
              <div className="epub-preview-settings-stepper">
                <DsButton variant="ghost" size="icon" iconOnly onClick={() => setFontScale((value) => Math.max(MIN_FONT_SCALE, Number((value - 0.1).toFixed(2))))} disabled={fontScale <= MIN_FONT_SCALE} title={t('learningHub:previewToolbar.fontDecrease')} aria-label={t('learningHub:previewToolbar.fontDecrease')}>
                  <Minus size={16} />
                </DsButton>
                <span className="epub-preview-font-value" aria-live="polite">{Math.round(fontScale * 100)}%</span>
                <DsButton variant="ghost" size="icon" iconOnly onClick={() => setFontScale((value) => Math.min(MAX_FONT_SCALE, Number((value + 0.1).toFixed(2))))} disabled={fontScale >= MAX_FONT_SCALE} title={t('learningHub:previewToolbar.fontIncrease')} aria-label={t('learningHub:previewToolbar.fontIncrease')}>
                  <Plus size={16} />
                </DsButton>
              </div>
            </div>
            <div className="epub-preview-settings-row">
              <span className="epub-preview-settings-label">{t('learningHub:epubPreview.fontFamily')}</span>
              <div className="epub-preview-settings-seg" role="radiogroup" aria-label={t('learningHub:epubPreview.fontFamily')}>
                {FONT_FAMILY_OPTIONS.map((option) => (
                  <DsButton
                    key={option}
                    variant={fontFamily === option ? 'default' : 'ghost'}
                    size="sm"
                    role="radio"
                    aria-checked={fontFamily === option}
                    className={`epub-preview-font-option epub-preview-font-option-${option}`}
                    onClick={() => setFontFamily(option)}
                  >
                    {fontFamilyLabels[option]}
                  </DsButton>
                ))}
              </div>
            </div>
            <label className="epub-preview-settings-row">
              <span className="epub-preview-settings-label">{t('learningHub:epubPreview.lineHeight')}</span>
              <input
                type="range"
                min={MIN_LINE_HEIGHT}
                max={MAX_LINE_HEIGHT}
                step={0.05}
                value={lineHeight}
                onChange={(event) => setLineHeight(Number(event.target.value))}
                aria-label={t('learningHub:epubPreview.lineHeight')}
              />
              <span className="epub-preview-settings-value">{lineHeight.toFixed(2)}</span>
            </label>
            <label className="epub-preview-settings-row">
              <span className="epub-preview-settings-label">{t('learningHub:epubPreview.pageMargin')}</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={pageMargin}
                onChange={(event) => setPageMargin(Number(event.target.value))}
                aria-label={t('learningHub:epubPreview.pageMargin')}
              />
              <span className="epub-preview-settings-value">{Math.round(pageMargin * 100)}%</span>
            </label>
            <div className="epub-preview-settings-footer">
              <DsButton variant="ghost" size="sm" onClick={resetTypography}>
                <ArrowCounterClockwise size={16} />
                {t('learningHub:epubPreview.resetTypography')}
              </DsButton>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <div className="epub-preview-body">
        {isNarrow && sidebarOpen && (
          <button
            type="button"
            className="epub-preview-sidebar-scrim"
            aria-label={t('common:close')}
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <aside
          className="epub-preview-sidebar"
          data-open={sidebarOpen}
          aria-hidden={!sidebarOpen}
          aria-label={t('learningHub:epubPreview.navigation')}
        >
          <div className="epub-preview-sidebar-inner">
            <div className="epub-preview-sidebar-tabs">
              <DsButton variant={sidebarMode === 'toc' ? 'default' : 'ghost'} size="sm" className="ui-state-colors" onClick={() => setSidebarMode('toc')}>
                <List size={16} />{t('learningHub:epubPreview.contents')}
              </DsButton>
              <DsButton variant={sidebarMode === 'search' ? 'default' : 'ghost'} size="sm" className="ui-state-colors" onClick={() => setSidebarMode('search')}>
                <MagnifyingGlass size={16} />{t('common:search')}
              </DsButton>
            </div>
            {sidebarMode === 'toc' ? (
              <CustomScrollArea className="epub-preview-toc min-h-0 flex-1 ui-rise-in" viewportRef={tocRef}>
                <nav aria-label={t('learningHub:epubPreview.contents')}>
                  {book.toc.map((entry, index) => (
                    <DsButton
                      key={`${entry.chapterIndex}:${entry.fragment ?? ''}:${index}`}
                      variant="ghost"
                      size="sm"
                      className={entry.chapterIndex === chapterIndex ? 'is-active' : ''}
                      style={{ paddingInlineStart: `${12 + Math.min(entry.depth, 4) * 14}px` }}
                      onClick={() => {
                        navigateToChapter(entry.chapterIndex, entry.fragment);
                        if (isNarrow) setSidebarOpen(false);
                      }}
                    >
                      {entry.title}
                    </DsButton>
                  ))}
                </nav>
              </CustomScrollArea>
            ) : (
              <div className="epub-preview-search ui-rise-in">
                <label className="epub-preview-search-input">
                  <MagnifyingGlass size={16} aria-hidden="true" />
                  <input
                    type="search"
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={handleSearchInputKeyDown}
                    placeholder={t('learningHub:epubPreview.searchPlaceholder')}
                    autoFocus
                  />
                </label>
                <div className="epub-preview-search-summary">
                  {searching
                    ? t('learningHub:epubPreview.searching')
                    : searchQuery.trim()
                      ? searchResults.length
                        ? searchResults.length >= EPUB_SEARCH_RESULT_LIMIT
                          ? t('learningHub:epubPreview.searchCapped', { count: searchResults.length })
                          : t('learningHub:epubPreview.searchCount', { count: searchResults.length })
                        : t('learningHub:epubPreview.searchNoResults')
                      : null}
                </div>
                {frameMatch && frameMatch.total > 0 && (
                  <div className="epub-preview-match-nav ui-rise-in">
                    <span>{t('learningHub:epubPreview.matchPosition', { current: frameMatch.current + 1, total: frameMatch.total })}</span>
                    <DsButton variant="ghost" size="icon" iconOnly onClick={() => setCurrentFrameMatch(frameMatch.current - 1)} title={t('learningHub:epubPreview.previousMatch')} aria-label={t('learningHub:epubPreview.previousMatch')}>
                      <CaretUp size={16} />
                    </DsButton>
                    <DsButton variant="ghost" size="icon" iconOnly onClick={() => setCurrentFrameMatch(frameMatch.current + 1)} title={t('learningHub:epubPreview.nextMatch')} aria-label={t('learningHub:epubPreview.nextMatch')}>
                      <CaretDown size={16} />
                    </DsButton>
                  </div>
                )}
                <CustomScrollArea className="epub-preview-search-results min-h-0 flex-1">
                  {searchResults.map((result, index) => (
                    <DsButton
                      key={`${result.chapterIndex}:${result.matchIndex}:${index}`}
                      variant="ghost"
                      size="sm"
                      className={index === activeResultIndex ? 'is-active' : ''}
                      onClick={() => {
                        navigateToSearchResult(result, index);
                        if (isNarrow) setSidebarOpen(false);
                      }}
                    >
                      <strong>{result.title}</strong>
                      <span>{renderExcerpt(result.excerpt)}</span>
                    </DsButton>
                  ))}
                </CustomScrollArea>
              </div>
            )}
          </div>
        </aside>

        <main className="epub-preview-reader">
          {loading && <div className="epub-preview-loading"><CircleNotch className="animate-spin" size={28} /></div>}
          <iframe
            key={frameGeneration}
            ref={iframeRef}
            className="epub-preview-frame ui-fade-in"
            title={`${fileName}: ${book.chapters[chapterIndex]?.title ?? ''}`}
            sandbox="allow-same-origin"
            srcDoc={srcDoc}
            onLoad={handleFrameLoad}
          />
          <footer className="epub-preview-footer">
            <DsButton variant="ghost" size="icon" iconOnly disabled={chapterIndex === 0} onClick={() => navigateToChapter(chapterIndex - 1)} title={t('learningHub:epubPreview.previousChapter')} aria-label={t('learningHub:epubPreview.previousChapter')}>
              <CaretLeft size={16} />
            </DsButton>
            <div className="epub-preview-progress" aria-label={t('learningHub:epubPreview.progress', { progress: overallProgress })}>
              <div><span style={{ width: `${overallProgress}%` }} /></div>
              <span>{chapterIndex + 1} / {book.chapters.length} · {overallProgress}%</span>
            </div>
            <DsButton variant="ghost" size="icon" iconOnly disabled={chapterIndex >= book.chapters.length - 1} onClick={() => navigateToChapter(chapterIndex + 1)} title={t('learningHub:epubPreview.nextChapter')} aria-label={t('learningHub:epubPreview.nextChapter')}>
              <CaretRight size={16} />
            </DsButton>
          </footer>
        </main>
      </div>
    </div>
  );
};

export default EpubPreview;
