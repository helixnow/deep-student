import React, { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowClockwise, ArrowRight, BookOpen, CircleNotch, FileText,
  Infinity as InfinityIcon, MagnifyingGlass, Notebook, PencilLine, Plus, WarningCircle, X,
} from '@phosphor-icons/react';
import { createEmpty, INK_MIME, type DstuNode } from '@/dstu';
import { InkWorkspace, createInk, createInkBoard } from '@/features/ink';
import { MobileSlidingLayout, useMobileHeader } from '@/components/layout';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { getErrorMessage } from '@/utils/errorUtils';
import {
  NOTEBOOK_CARD_PAGE_SIZE, NotebookPaginationError, notebookFolder, notebookTitle,
  selectNotebookEntries, type NotebookEntry, type NotebookFilter,
} from './NotebookLibrary';
import { useNotebookLibrary } from './useNotebookLibrary';
import { flushInkEditor, hasDirtyInkEditor } from './editorSession';
import { hasContentSaveHandler, isContentDirty, saveContentNow } from '@/services/contentDirtyRegistry';
import type { NotebookHostState, NotebookPageProps } from './NotebookHost';
import './Notebook.css';

const NotebookTextWorkspace = lazy(() => import('./NotebookTextWorkspace'));
type CreateMode = 'paged' | 'board' | 'text';

function errorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'toUserMessage' in error && typeof error.toUserMessage === 'function') {
    return error.toUserMessage();
  }
  return getErrorMessage(error);
}

export function NotebookPage({ isActive = true, onHostStateChange }: NotebookPageProps) {
  const { t, i18n } = useTranslation('ink');
  const { isSmallScreen } = useBreakpoint();
  const [selected, setSelected] = useState<NotebookEntry | null>(null);
  const [pendingOpen, setPendingOpen] = useState<NotebookEntry | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<NotebookFilter>('all');
  const [visibleCount, setVisibleCount] = useState(NOTEBOOK_CARD_PAGE_SIZE);
  const [creating, setCreating] = useState<CreateMode | null>(null);
  const [createFailure, setCreateFailure] = useState<{ mode: CreateMode; error: unknown } | null>(null);
  const mountedRef = useRef(true);
  const activeRef = useRef(isActive);
  const creatingRef = useRef(false);
  const currentHostStateRef = useRef<NotebookHostState | null>(null);
  const publishHostRef = useRef<() => void>(() => undefined);
  activeRef.current = isActive;
  const library = useNotebookLibrary(isActive && selected === null);
  const libraryBusyRef = useRef(true);
  libraryBusyRef.current = library.loading || (!library.complete && library.failures.length === 0);

  const writingPage = useMemo(() => {
    const entry = selected ?? pendingOpen;
    let cached: { page: HTMLElement; root: HTMLElement } | undefined;
    return () => {
      if (!entry) return undefined;
      const selector = entry.kind === 'ink' ? '[data-ink-workspace-page]' : '[data-notebook-document-id]';
      const page = [...document.querySelectorAll<HTMLElement>(selector)].find((candidate) =>
        (entry.kind === 'ink' ? candidate.dataset.inkWorkspacePage : candidate.dataset.notebookDocumentId) === entry.node.id,
      );
      if (page) {
        if (entry.kind === 'ink' && page.parentElement) cached = { page, root: page.parentElement };
        return page;
      }
      if (entry.kind === 'ink' && cached && cached.page.parentElement === cached.root
        && cached.page.dataset.inkWorkspacePage === entry.node.id) return cached.page;
      cached = undefined;
      return undefined;
    };
  }, [selected, pendingOpen]);

  const hostState = useMemo<NotebookHostState>(() => {
    const entry = selected ?? pendingOpen;
    const current = () => mountedRef.current && currentHostStateRef.current === state;
    const ready = () => {
      if (!entry) return true;
      const page = writingPage();
      if (!page) return false;
      if (entry.kind === 'text') {
        return page.dataset.notebookSaveState !== 'loading' && page.dataset.notebookSaveState !== undefined
          && Boolean(page.querySelector('.ProseMirror')) && hasContentSaveHandler('note', entry.node.id);
      }
      const paged = page.querySelector<HTMLElement>('[data-testid="ink-editor"]');
      return Boolean(paged?.dataset.documentId === entry.node.id
        && paged.querySelector('[data-testid="ink-editor-flush-state"]')?.textContent?.trim() === 'ready')
        || page.querySelector<HTMLElement>('[data-testid="ink-board-editor"]')?.dataset.documentId === entry.node.id;
    };
    const busy = () => {
      if (!current() || creatingRef.current || creating !== null || (!selected && pendingOpen)) return true;
      if (!entry) return libraryBusyRef.current;
      const page = writingPage();
      return !ready() || page?.dataset.notebookClosing === 'true'
        || Boolean(page?.querySelector('.ink-workspace-content[inert]'));
    };
    const state: NotebookHostState = {
      writing: Boolean(entry),
      get busy() { return Boolean(busy()); },
      isDirty: () => {
        if (!entry) return false;
        return entry.kind === 'ink' ? hasDirtyInkEditor(entry.node.id) : isContentDirty('note', entry.node.id);
      },
      flush: async () => {
        if (!current() || busy()) return false;
        if (!entry) return true;
        try {
          const saved = entry.kind === 'ink'
            ? (await flushInkEditor(entry.node.id)).ok
            : await saveContentNow('note', entry.node.id);
          return Boolean(current() && !busy() && ready() && saved && !state.isDirty());
        } catch {
          return false;
        } finally {
          if (current()) publishHostRef.current();
        }
      },
    };
    return state;
  }, [selected, pendingOpen, creating, writingPage]);
  currentHostStateRef.current = hostState;

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useLayoutEffect(() => {
    if (!onHostStateChange) return;
    let previous = '';
    const observedRoots = new Set<HTMLElement>([document.body]);
    const observerOptions = { childList: true, subtree: true, characterData: true, attributes: true };
    const publish = () => {
      if (!mountedRef.current || currentHostStateRef.current !== hostState) return;
      const page = writingPage();
      const root = page?.parentElement;
      if (root && !observedRoots.has(root)) {
        observer.observe(root, observerOptions);
        observedRoots.add(root);
      }
      const outputs = page ? [page.dataset.notebookSaveState, ...[...page.querySelectorAll(
        '[data-testid="ink-editor-save-state"], [data-testid="ink-board-save-state"]',
      )].map((output) => `${output.getAttribute('data-state')}:${output.textContent}`)] : [];
      const signature = JSON.stringify([hostState.writing, hostState.busy, hostState.isDirty(), outputs]);
      if (signature === previous) return;
      previous = signature;
      onHostStateChange(hostState);
    };
    const observer = new MutationObserver(publish);
    observer.observe(document.body, observerOptions);
    publishHostRef.current = publish;
    publish();
    const publishAfterInteraction = () => { queueMicrotask(publish); };
    const events = ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'input'] as const;
    events.forEach((event) => document.body.addEventListener(event, publishAfterInteraction, true));
    return () => {
      observer.disconnect();
      events.forEach((event) => document.body.removeEventListener(event, publishAfterInteraction, true));
      if (publishHostRef.current === publish) publishHostRef.current = () => undefined;
    };
  }, [hostState, onHostStateChange, writingPage]);

  useLayoutEffect(() => { publishHostRef.current(); }, [library.loading, library.complete, library.failures]);
  useLayoutEffect(() => () => { onHostStateChange?.(null); }, [onHostStateChange]);

  useEffect(() => {
    if (!isActive || !pendingOpen) return;
    setSelected(pendingOpen);
    setPendingOpen(null);
  }, [isActive, pendingOpen]);

  useEffect(() => { setVisibleCount(NOTEBOOK_CARD_PAGE_SIZE); }, [query, filter]);

  const openNotebook = useCallback((entry: NotebookEntry) => {
    if (!activeRef.current) return;
    setDrawerOpen(false);
    setSelected(entry);
  }, []);

  const closeNotebook = useCallback(() => {
    setSelected((entry) => entry === selected ? null : entry);
  }, [selected]);
  const toggleDrawer = useCallback(() => {
    if (activeRef.current) setDrawerOpen((open) => !open);
  }, []);

  useMobileHeader('notes', {
    title: t('notebook.title'),
    hidden: selected !== null,
    showMenu: selected === null,
    onMenuClick: toggleDrawer,
  }, [isActive, selected, toggleDrawer, t], isActive);

  const handleCreate = useCallback(async (mode: CreateMode) => {
    if (!activeRef.current || creatingRef.current) return;
    creatingRef.current = true;
    setCreating(mode);
    setCreateFailure(null);
    try {
      let entry: NotebookEntry;
      if (mode === 'text') {
        const result = await createEmpty({ type: 'note', name: t('notebook.untitledText'), folderId: null });
        if (!result.ok) throw result.error;
        entry = { node: result.value, kind: 'text' };
      } else {
        const title = t(mode === 'board' ? 'notebook.untitledBoard' : 'notebook.untitledPaged');
        const request = { title, ruling: 'blank' as const, operation_id: crypto.randomUUID(), folder_id: null };
        const manifest = mode === 'board'
          ? await createInkBoard(request)
          : await createInk({ ...request, width: 794, height: 1123 });
        const node: DstuNode = {
          id: manifest.document_id,
          sourceId: manifest.document_id,
          path: `/${manifest.document_id}`,
          name: `${manifest.title}.dsink`,
          type: 'file',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          metadata: { mimeType: INK_MIME },
        };
        entry = { node, kind: 'ink' };
      }
      if (!mountedRef.current) return;
      if (activeRef.current) openNotebook(entry);
      else setPendingOpen(entry);
    } catch (error) {
      if (mountedRef.current) setCreateFailure({ mode, error });
    } finally {
      creatingRef.current = false;
      if (mountedRef.current) setCreating(null);
    }
  }, [openNotebook, t]);

  const allEntries = useMemo(() => selectNotebookEntries(library.nodes), [library.nodes]);
  const entries = useMemo(() => selectNotebookEntries(library.nodes, query, filter), [library.nodes, query, filter]);
  const visibleEntries = entries.slice(0, visibleCount);
  const searching = query.trim().length > 0;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(i18n.resolvedLanguage ?? i18n.language, {
    month: 'short', day: 'numeric',
  }), [i18n.resolvedLanguage, i18n.language]);
  const disabled = !isActive || creating !== null;

  const createChoices = (
    <section className="notebook-create-grid" aria-label={t('notebook.createSection')}>
      <DsButton
        variant="ghost" className="notebook-create-card notebook-create-paged"
        onClick={() => void handleCreate('paged')} disabled={disabled}
        data-testid="notebook-create-paged"
      >
        <span className="notebook-create-glyph"><Notebook size={30} weight="duotone" aria-hidden /></span>
        <span className="notebook-create-copy">
          <strong>{t('notebook.newPaged')}</strong><span>{t('notebook.pagedDescription')}</span>
        </span>
        {creating === 'paged' ? <CircleNotch size={20} className="animate-spin" aria-hidden /> : <Plus size={21} aria-hidden />}
      </DsButton>
      <DsButton
        variant="ghost" className="notebook-create-card notebook-create-board"
        onClick={() => void handleCreate('board')} disabled={disabled}
        data-testid="notebook-create-board"
      >
        <span className="notebook-create-glyph"><InfinityIcon size={30} weight="bold" aria-hidden /></span>
        <span className="notebook-create-copy">
          <strong>{t('notebook.newBoard')}</strong><span>{t('notebook.boardDescription')}</span>
        </span>
        {creating === 'board' ? <CircleNotch size={20} className="animate-spin" aria-hidden /> : <Plus size={21} aria-hidden />}
      </DsButton>
    </section>
  );

  const content = (
    <ScrollArea className="notebook-scroll" viewportClassName="notebook-scroll-viewport">
      <main className="notebook-library" data-testid="notebook-library">
        <div className="notebook-library-intro">
          <div>
            {!isSmallScreen && <h1 className="notebook-library-title">{t('notebook.title')}</h1>}
            <p className="notebook-library-subtitle">{t('notebook.subtitle')}</p>
          </div>
          <DsButton variant="ghost" onClick={() => void handleCreate('text')} disabled={disabled} data-testid="notebook-create-text">
            {creating === 'text' ? <CircleNotch size={18} className="animate-spin" aria-hidden /> : <FileText size={18} aria-hidden />}
            {t('notebook.newText')}
          </DsButton>
        </div>
        {createChoices}
        {createFailure && (
          <div className="notebook-error" role="alert">
            <WarningCircle size={21} aria-hidden />
            <div><strong>{t('notebook.createFailed')}</strong><p>{errorMessage(createFailure.error)}</p></div>
            <DsButton variant="ghost" onClick={() => void handleCreate(createFailure.mode)} disabled={disabled}>
              {t('notebook.retry')}
            </DsButton>
          </div>
        )}
        <section className="notebook-collection" aria-label={searching ? t('notebook.searchResults') : t('notebook.recent')}>
          <div className="notebook-collection-heading">
            <div className="notebook-section-title">
              <h2>{searching ? t('notebook.searchResults') : t('notebook.recent')}</h2>
              <span>{t(library.complete ? 'notebook.count' : 'notebook.loadedCount', { count: entries.length })}</span>
            </div>
            <DsButton
              variant="ghost" size="icon" aria-label={t('notebook.refresh')} title={t('notebook.refresh')}
              onClick={library.refresh} disabled={!isActive || library.loading}
            ><ArrowClockwise size={18} aria-hidden /></DsButton>
          </div>
          <div className="notebook-library-toolbar">
            <div className="notebook-search">
              <MagnifyingGlass size={19} aria-hidden />
              <Input
                type="search" value={query} onChange={(event) => setQuery(event.target.value)}
                placeholder={t('notebook.searchPlaceholder')} aria-label={t('notebook.searchLabel')}
                disabled={!isActive} data-testid="notebook-search"
              />
              {query && <DsButton variant="ghost" size="icon" onClick={() => setQuery('')} disabled={!isActive} aria-label={t('notebook.clearSearch')}>
                <X size={16} aria-hidden />
              </DsButton>}
            </div>
            <div className="notebook-filters" role="group" aria-label={t('notebook.filterLabel')}>
              {(['all', 'ink', 'text'] as const).map((value) => (
                <DsButton
                  key={value} variant="ghost" size="sm" aria-pressed={filter === value}
                  onClick={() => setFilter(value)} disabled={!isActive}
                  className="notebook-filter"
                >{t(`notebook.filters.${value}`)}</DsButton>
              ))}
            </div>
          </div>
          {library.failures.length > 0 && (
            <div className="notebook-error" role="alert">
              <WarningCircle size={21} aria-hidden />
              <div>
                <strong>{t('notebook.loadFailed')}</strong>
                <p>{t('notebook.incompleteHint')}</p>
                {library.failures.map(({ source, error }) => (
                  <p key={source}>{t(source === 'note' ? 'notebook.types.text' : 'notebook.types.ink')}: {error instanceof NotebookPaginationError ? t('notebook.paginationStalled') : errorMessage(error)}</p>
                ))}
              </div>
              <DsButton variant="ghost" onClick={library.refresh} disabled={!isActive || library.loading}>{t('notebook.retry')}</DsButton>
            </div>
          )}
          {library.loading && (
            <div className="notebook-loading" role="status">
              <CircleNotch size={20} className="animate-spin" aria-hidden />
              {t(searching ? 'notebook.searching' : 'notebook.loading')}
            </div>
          )}
          {visibleEntries.length > 0 && (
            <div className="notebook-card-grid">
              {visibleEntries.map((entry) => {
                const title = notebookTitle(entry);
                const folder = notebookFolder(entry.node);
                return (
                  <DsButton
                    key={entry.node.id} variant="ghost" className="notebook-card"
                    onClick={() => openNotebook(entry)} disabled={!isActive}
                    aria-label={t('notebook.openNote', { title })}
                    data-testid={`notebook-card-${entry.node.id}`}
                  >
                    <span className={`notebook-card-cover notebook-card-cover-${entry.kind}`} aria-hidden>
                      <span className="notebook-card-paper" />
                      {entry.kind === 'text' ? <FileText size={30} weight="duotone" /> : <PencilLine size={30} weight="duotone" />}
                      <span className="notebook-card-kind">{t(`notebook.types.${entry.kind}`)}</span>
                    </span>
                    <span className="notebook-card-body">
                      <strong className="notebook-card-title" title={title}>{title}</strong>
                      <span className="notebook-card-folder" title={folder || t('notebook.rootFolder')}>{folder || t('notebook.rootFolder')}</span>
                      <span className="notebook-card-footer">
                        <span>{t('notebook.updatedOn', { date: dateFormatter.format(entry.node.updatedAt) })}</span>
                        <ArrowRight size={16} aria-hidden />
                      </span>
                    </span>
                  </DsButton>
                );
              })}
            </div>
          )}
          {entries.length > visibleCount && (
            <div className="notebook-load-more">
              <DsButton variant="ghost" onClick={() => setVisibleCount((count) => count + NOTEBOOK_CARD_PAGE_SIZE)} disabled={!isActive}>
                {t('notebook.showMore')}
              </DsButton>
            </div>
          )}
          {entries.length === 0 && library.complete && !library.loading && (
            <div className="notebook-empty" data-testid="notebook-empty">
              <BookOpen size={44} weight="duotone" aria-hidden />
              <h3>{t(searching || filter !== 'all' ? 'notebook.noResults' : 'notebook.emptyTitle')}</h3>
              <p>{t(searching || filter !== 'all' ? 'notebook.noResultsHint' : 'notebook.emptyHint')}</p>
              {(searching || filter !== 'all') && <DsButton variant="ghost" onClick={() => { setQuery(''); setFilter('all'); }} disabled={!isActive}>
                {t('notebook.clearFilters')}
              </DsButton>}
            </div>
          )}
        </section>
        <p className="notebook-storage-hint">{t('notebook.storageHint')}</p>
      </main>
    </ScrollArea>
  );

  const drawer = (
    <nav className="notebook-drawer" aria-label={t('notebook.recent')}>
      <h2>{t('notebook.recent')}</h2>
      {allEntries.slice(0, 8).map((entry) => (
        <DsButton key={entry.node.id} variant="nav" onClick={() => openNotebook(entry)} disabled={!isActive}>
          {entry.kind === 'text' ? <FileText size={18} aria-hidden /> : <Notebook size={18} aria-hidden />}
          <span className="truncate">{notebookTitle(entry)}</span>
        </DsButton>
      ))}
      {allEntries.length === 0 && <p>{t(library.loading ? 'notebook.loading' : library.failures.length ? 'notebook.loadFailed' : 'notebook.drawerEmpty')}</p>}
    </nav>
  );

  return (
    <div className="notebook-page" data-notebook-page={selected ? 'writing' : 'library'}>
      {selected ? selected.kind === 'ink' ? (
        <InkWorkspace documentId={selected.node.id} title={notebookTitle(selected)} isActive={isActive} onClose={closeNotebook} className="h-full" />
      ) : (
        <Suspense fallback={<div className="notebook-loading" role="status"><CircleNotch size={20} className="animate-spin" aria-hidden />{t('notebook.opening')}</div>}>
          <NotebookTextWorkspace key={selected.node.id} node={selected.node} isActive={isActive} onClose={closeNotebook} />
        </Suspense>
      ) : isSmallScreen ? (
        <MobileSlidingLayout
          sidebar={drawer} sidebarOpen={isActive && drawerOpen} onSidebarOpenChange={setDrawerOpen}
          enableGesture={isActive} className="notebook-mobile-layout" showSidebarAppNavigation
        >{content}</MobileSlidingLayout>
      ) : content}
    </div>
  );
}

export default NotebookPage;
