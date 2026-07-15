import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  CaretLeft,
  CaretRight,
  CircleNotch,
  List,
  MagnifyingGlass,
  Minus,
  Plus,
  SidebarSimple,
  WarningCircle,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  loadEpubBook,
  renderEpubChapter,
  resolveEpubNavigation,
  searchEpubBook,
  type EpubBookModel,
} from './epubReaderModel';
import './EpubPreview.css';

type ReaderTheme = 'light' | 'sepia' | 'dark';

interface PersistedReaderState {
  chapterIndex: number;
  chapterProgress: number;
  theme: ReaderTheme;
  fontScale: number;
}

export interface EpubPreviewProps {
  base64Content: string;
  fileName: string;
  resourceId: string;
}

function loadReaderState(key: string): PersistedReaderState {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '{}') as Partial<PersistedReaderState>;
    return {
      chapterIndex: Math.max(0, Number(value.chapterIndex) || 0),
      chapterProgress: Math.min(1, Math.max(0, Number(value.chapterProgress) || 0)),
      theme: value.theme === 'dark' || value.theme === 'sepia' ? value.theme : 'light',
      fontScale: Math.min(1.8, Math.max(0.75, Number(value.fontScale) || 1)),
    };
  } catch {
    return { chapterIndex: 0, chapterProgress: 0, theme: 'light', fontScale: 1 };
  }
}

const EpubPreview: React.FC<EpubPreviewProps> = ({ base64Content, fileName, resourceId }) => {
  const { t } = useTranslation(['learningHub', 'common']);
  const storageKey = `epub-reader:${resourceId}`;
  const initialState = useMemo(() => loadReaderState(storageKey), [storageKey]);
  const rootRef = useRef<HTMLDivElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const iframeCleanupRef = useRef<(() => void) | null>(null);
  const objectUrlsRef = useRef<string[]>([]);
  const pendingFragmentRef = useRef<string | null>(null);
  const pendingSearchRef = useRef<string | null>(null);
  const restoreProgressRef = useRef(initialState.chapterProgress);
  const [book, setBook] = useState<EpubBookModel | null>(null);
  const [srcDoc, setSrcDoc] = useState('');
  const [chapterIndex, setChapterIndex] = useState(initialState.chapterIndex);
  const [chapterProgress, setChapterProgress] = useState(initialState.chapterProgress);
  const [theme, setTheme] = useState<ReaderTheme>(initialState.theme);
  const [fontScale, setFontScale] = useState(initialState.fontScale);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarMode, setSidebarMode] = useState<'toc' | 'search'>('toc');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<Array<{ chapterIndex: number; title: string; excerpt: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
    restoreProgressRef.current = initialState.chapterProgress;
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
  }, [
    base64Content,
    initialState.chapterIndex,
    initialState.chapterProgress,
    initialState.fontScale,
    initialState.theme,
  ]);

  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    setLoading(true);
    void renderEpubChapter(book, chapterIndex, theme, fontScale)
      .then((rendered) => {
        if (cancelled) {
          rendered.objectUrls.forEach(URL.revokeObjectURL);
          return;
        }
        objectUrlsRef.current.forEach(URL.revokeObjectURL);
        objectUrlsRef.current = rendered.objectUrls;
        setSrcDoc(rendered.srcDoc);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(getErrorMessage(reason));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [book, chapterIndex, fontScale, theme]);

  useEffect(() => () => {
    iframeCleanupRef.current?.();
    objectUrlsRef.current.forEach(URL.revokeObjectURL);
  }, []);

  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify({ chapterIndex, chapterProgress, theme, fontScale }));
  }, [chapterIndex, chapterProgress, fontScale, storageKey, theme]);

  useEffect(() => {
    const root = rootRef.current;
    const openSearch = () => {
      setSidebarOpen(true);
      setSidebarMode('search');
    };
    root?.addEventListener('epub-preview-open-search', openSearch);
    return () => root?.removeEventListener('epub-preview-open-search', openSearch);
  }, []);

  useEffect(() => {
    if (!book || !searchQuery.trim()) {
      setSearchResults([]);
      setSearching(false);
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
  }, [book, searchQuery]);

  const highlightFrameText = useCallback((query: string) => {
    const document = iframeRef.current?.contentDocument;
    if (!document || !query.trim()) return;
    document.querySelectorAll('mark[data-epub-search-current]').forEach((mark) => mark.replaceWith(...mark.childNodes));
    const normalized = query.toLocaleLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      const offset = (node.textContent ?? '').toLocaleLowerCase().indexOf(normalized);
      if (offset >= 0) {
        const range = document.createRange();
        range.setStart(node, offset);
        range.setEnd(node, offset + query.length);
        const mark = document.createElement('mark');
        mark.dataset.epubSearchCurrent = 'true';
        range.surroundContents(mark);
        mark.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      node = walker.nextNode();
    }
  }, []);

  const navigateToChapter = useCallback((nextIndex: number, fragment?: string) => {
    if (!book) return;
    const bounded = Math.max(0, Math.min(book.chapters.length - 1, nextIndex));
    pendingFragmentRef.current = fragment ?? null;
    restoreProgressRef.current = 0;
    setChapterProgress(0);
    if (bounded === chapterIndex) {
      const document = iframeRef.current?.contentDocument;
      if (fragment) document?.getElementById(fragment)?.scrollIntoView({ block: 'start' });
      else iframeRef.current?.contentWindow?.scrollTo({ top: 0 });
      if (pendingSearchRef.current) highlightFrameText(pendingSearchRef.current);
      pendingSearchRef.current = null;
      return;
    }
    setChapterIndex(bounded);
  }, [book, chapterIndex, highlightFrameText]);

  const navigateToSearchResult = useCallback((nextChapterIndex: number) => {
    pendingSearchRef.current = searchQuery;
    navigateToChapter(nextChapterIndex);
  }, [navigateToChapter, searchQuery]);

  const handleFrameLoad = useCallback(() => {
    iframeCleanupRef.current?.();
    const frame = iframeRef.current;
    const frameWindow = frame?.contentWindow;
    const document = frame?.contentDocument;
    if (!frameWindow || !document) return;

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
    if (pendingSearchRef.current) {
      highlightFrameText(pendingSearchRef.current);
      pendingSearchRef.current = null;
    }

    let frameRequest = 0;
    const updateProgress = () => {
      if (frameRequest) return;
      frameRequest = frameWindow.requestAnimationFrame(() => {
        frameRequest = 0;
        const maxScroll = Math.max(0, document.documentElement.scrollHeight - frameWindow.innerHeight);
        setChapterProgress(maxScroll > 0 ? Math.min(1, frameWindow.scrollY / maxScroll) : 1);
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
      }
    };
    frameWindow.addEventListener('scroll', updateProgress, { passive: true });
    // The EPUB document lives in an iframe and cannot use the app-level event registry.
    // eslint-disable-next-line no-restricted-syntax
    document.addEventListener('selectionchange', updateSelection);
    // eslint-disable-next-line no-restricted-syntax
    document.addEventListener('click', handleClick);
    // eslint-disable-next-line no-restricted-syntax
    document.addEventListener('keydown', handleKeyDown);
    iframeCleanupRef.current = () => {
      frameWindow.removeEventListener('scroll', updateProgress);
      document.removeEventListener('selectionchange', updateSelection);
      document.removeEventListener('click', handleClick);
      document.removeEventListener('keydown', handleKeyDown);
      if (frameRequest) frameWindow.cancelAnimationFrame(frameRequest);
      if (restoreFrame) frameWindow.cancelAnimationFrame(restoreFrame);
      if (restoreTimer) frameWindow.clearTimeout(restoreTimer);
    };
  }, [book, chapterIndex, highlightFrameText, navigateToChapter]);

  const overallProgress = book
    ? Math.round(((chapterIndex + chapterProgress) / book.chapters.length) * 100)
    : 0;

  if (error) {
    return (
      <div className="epub-preview-state" role="alert">
        <WarningCircle size={44} aria-hidden="true" />
        <strong>{t('learningHub:epubPreview.loadFailed')}</strong>
        <span>{error}</span>
      </div>
    );
  }

  if (!book) {
    return (
      <div className="epub-preview-state" role="status">
        <CircleNotch className="animate-spin" size={36} aria-hidden="true" />
        <span>{t('learningHub:epubPreview.loading')}</span>
      </div>
    );
  }

  return (
    <div ref={rootRef} className={`epub-preview epub-preview-${theme}`} data-epub-preview>
      <div className="epub-preview-toolbar" role="toolbar" aria-label={t('learningHub:epubPreview.readerToolbar')}>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setSidebarOpen((value) => !value)} title={t('learningHub:epubPreview.toggleSidebar')} aria-label={t('learningHub:epubPreview.toggleSidebar')}>
          <SidebarSimple size={17} />
        </NotionButton>
        <div className="epub-preview-book-title" title={`${book.title}${book.author ? ` - ${book.author}` : ''}`}>
          <strong>{book.title || fileName}</strong>
          {book.author && <span>{book.author}</span>}
        </div>
        <div className="epub-preview-toolbar-spacer" />
        <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setFontScale((value) => Math.max(0.75, Number((value - 0.1).toFixed(2))))} disabled={fontScale <= 0.75} title={t('learningHub:previewToolbar.fontDecrease')} aria-label={t('learningHub:previewToolbar.fontDecrease')}>
          <Minus size={16} />
        </NotionButton>
        <span className="epub-preview-font-value" aria-live="polite">{Math.round(fontScale * 100)}%</span>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setFontScale((value) => Math.min(1.8, Number((value + 0.1).toFixed(2))))} disabled={fontScale >= 1.8} title={t('learningHub:previewToolbar.fontIncrease')} aria-label={t('learningHub:previewToolbar.fontIncrease')}>
          <Plus size={16} />
        </NotionButton>
        <select className="epub-preview-theme" value={theme} onChange={(event) => setTheme(event.target.value as ReaderTheme)} aria-label={t('learningHub:epubPreview.theme')}>
          <option value="light">{t('learningHub:epubPreview.themeLight')}</option>
          <option value="sepia">{t('learningHub:epubPreview.themeSepia')}</option>
          <option value="dark">{t('learningHub:epubPreview.themeDark')}</option>
        </select>
      </div>

      <div className="epub-preview-body">
        {sidebarOpen && (
          <aside className="epub-preview-sidebar" aria-label={t('learningHub:epubPreview.navigation')}>
            <div className="epub-preview-sidebar-tabs">
              <NotionButton variant={sidebarMode === 'toc' ? 'default' : 'ghost'} size="sm" onClick={() => setSidebarMode('toc')}>
                <List size={15} />{t('learningHub:epubPreview.contents')}
              </NotionButton>
              <NotionButton variant={sidebarMode === 'search' ? 'default' : 'ghost'} size="sm" onClick={() => setSidebarMode('search')}>
                <MagnifyingGlass size={15} />{t('common:search')}
              </NotionButton>
            </div>
            {sidebarMode === 'toc' ? (
              <nav className="epub-preview-toc">
                {book.toc.map((entry, index) => (
                  <NotionButton
                    key={`${entry.chapterIndex}:${entry.fragment ?? ''}:${index}`}
                    variant="ghost"
                    size="sm"
                    className={entry.chapterIndex === chapterIndex ? 'is-active' : ''}
                    style={{ paddingInlineStart: `${12 + Math.min(entry.depth, 4) * 14}px` }}
                    onClick={() => navigateToChapter(entry.chapterIndex, entry.fragment)}
                  >
                    {entry.title}
                  </NotionButton>
                ))}
              </nav>
            ) : (
              <div className="epub-preview-search">
                <label className="epub-preview-search-input">
                  <MagnifyingGlass size={15} aria-hidden="true" />
                  <input type="search" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder={t('learningHub:epubPreview.searchPlaceholder')} autoFocus />
                </label>
                <div className="epub-preview-search-summary">
                  {searching
                    ? t('learningHub:epubPreview.searching')
                    : searchQuery.trim() && t('learningHub:epubPreview.searchCount', { count: searchResults.length })}
                </div>
                <div className="epub-preview-search-results">
                  {searchResults.map((result, index) => (
                    <NotionButton key={`${result.chapterIndex}:${index}`} variant="ghost" size="sm" onClick={() => navigateToSearchResult(result.chapterIndex)}>
                      <strong>{result.title}</strong>
                      <span>{result.excerpt}</span>
                    </NotionButton>
                  ))}
                </div>
              </div>
            )}
          </aside>
        )}

        <main className="epub-preview-reader">
          {loading && <div className="epub-preview-loading"><CircleNotch className="animate-spin" size={28} /></div>}
          <iframe
            ref={iframeRef}
            className="epub-preview-frame"
            title={`${fileName}: ${book.chapters[chapterIndex]?.title ?? ''}`}
            sandbox="allow-same-origin"
            srcDoc={srcDoc}
            onLoad={handleFrameLoad}
          />
          <footer className="epub-preview-footer">
            <NotionButton variant="ghost" size="icon" iconOnly disabled={chapterIndex === 0} onClick={() => navigateToChapter(chapterIndex - 1)} title={t('learningHub:epubPreview.previousChapter')} aria-label={t('learningHub:epubPreview.previousChapter')}>
              <CaretLeft size={18} />
            </NotionButton>
            <div className="epub-preview-progress" aria-label={t('learningHub:epubPreview.progress', { progress: overallProgress })}>
              <div><span style={{ width: `${overallProgress}%` }} /></div>
              <span>{chapterIndex + 1} / {book.chapters.length} · {overallProgress}%</span>
            </div>
            <NotionButton variant="ghost" size="icon" iconOnly disabled={chapterIndex >= book.chapters.length - 1} onClick={() => navigateToChapter(chapterIndex + 1)} title={t('learningHub:epubPreview.nextChapter')} aria-label={t('learningHub:epubPreview.nextChapter')}>
              <CaretRight size={18} />
            </NotionButton>
          </footer>
        </main>
      </div>
    </div>
  );
};

export default EpubPreview;
