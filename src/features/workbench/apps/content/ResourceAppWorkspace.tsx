import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  ClockCounterClockwise,
  ClipboardText,
  MagnifyingGlass,
  PenNib,
  Plus,
  Rows,
  SidebarSimple,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotionAlertDialog } from '@/components/ui/NotionDialog';
import { createEmpty, dstu, type DstuNode } from '@/dstu';
import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/lib/utils';
import { isContentDirty } from './contentDirtyRegistry';
import { useReviewPlanStore } from '@/stores/reviewPlanStore';
import {
  clearResourceWorkspaceActive,
  registerResourceWorkspace,
  setResourceWorkspaceActive,
  type ResourceWorkspaceType,
} from './resourceWorkspaceRegistry';
import './ResourceAppWorkspace.css';

type LibraryView = 'all' | 'recent';

type PendingNavigation =
  | {
      kind: 'select';
      resourceId: string | null;
      confirmation: 'unsaved' | 'review';
      /** Latest list response held until a dirty resource is safely unmounted. */
      itemsAfter?: DstuNode[];
    }
  | { kind: 'create'; confirmation: 'unsaved' | 'review' };

interface ResourceAppWorkspaceProps {
  type: ResourceWorkspaceType;
  initialResourceId?: string | null;
  isActive: boolean;
  onTitleChange: (title: string) => void;
}

export const ResourceAppWorkspace: React.FC<ResourceAppWorkspaceProps> = ({
  type,
  initialResourceId,
  isActive,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');
  const [items, setItems] = useState<DstuNode[]>([]);
  const [query, setQuery] = useState('');
  const [libraryView, setLibraryView] = useState<LibraryView>('all');
  const [selectedId, setSelectedId] = useState<string | null>(initialResourceId ?? null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [compact, setCompact] = useState(false);
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const isExam = type === 'exam';
  const title = isExam
    ? t('workbench:apps.exam')
    : t('workbench:apps.essay');
  const ResourceIcon = isExam ? ClipboardText : PenNib;
  const newLabel = isExam
    ? t('workbench:resourceHome.newExam')
    : t('workbench:resourceHome.newEssay');

  useEffect(() => onTitleChange(title), [onTitleChange, title]);

  const loadItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await dstu.list('/', {
      typeFilter: type,
      sortBy: 'updatedAt',
      sortOrder: 'desc',
      limit: 500,
    });
    if (result.ok) {
      const activeId = selectedIdRef.current;
      if (activeId && !result.value.some((item) => item.id === activeId)) {
        const reviewSession = useReviewPlanStore.getState().session;
        const confirmation = (
          type === 'exam'
          && reviewSession.isActive
          && reviewSession.examId === activeId
          && reviewSession.currentIndex < reviewSession.queue.length
        )
          ? 'review'
          : ((type === 'essay' || type === 'exam') && isContentDirty(type, activeId))
            ? 'unsaved'
            : null;

        if (confirmation) {
          // Do not replace `items` yet: selectedItem would become null and
          // unmount the dirty editor before the user can decide what to do.
          setPendingNavigation((current) => (
            current?.kind === 'select' && current.resourceId === null
              ? { ...current, itemsAfter: result.value }
              : {
                  kind: 'select',
                  resourceId: null,
                  confirmation,
                  itemsAfter: result.value,
                }
          ));
        } else {
          setItems(result.value);
          selectedIdRef.current = null;
          setSelectedId(null);
        }
      } else {
        setItems(result.value);
      }
    } else {
      setError(result.error.toUserMessage());
    }
    setLoading(false);
  }, [type]);

  useEffect(() => {
    void loadItems();
    const unwatch = dstu.watch('*', () => void loadItems());
    return () => unwatch();
  }, [loadItems]);

  const commitResourceSelection = useCallback((resourceId: string | null) => {
    selectedIdRef.current = resourceId;
    setSelectedId(resourceId);
    if (resourceId && compact) setSidebarOpen(false);
  }, [compact]);

  const getLeaveConfirmation = useCallback((): 'unsaved' | 'review' | null => {
    const resourceId = selectedIdRef.current;
    if (!resourceId) return null;

    const reviewSession = useReviewPlanStore.getState().session;
    if (
      type === 'exam'
      && reviewSession.isActive
      && reviewSession.examId === resourceId
      && reviewSession.currentIndex < reviewSession.queue.length
    ) {
      return 'review';
    }
    if ((type === 'essay' || type === 'exam') && isContentDirty(type, resourceId)) {
      return 'unsaved';
    }
    return null;
  }, [type]);

  const selectResource = useCallback((resourceId: string | null, itemsAfter?: DstuNode[]): boolean => {
    const current = selectedIdRef.current;
    if (resourceId === current) return true;
    const confirmation = getLeaveConfirmation();
    if (confirmation) {
      setPendingNavigation({ kind: 'select', resourceId, confirmation, itemsAfter });
      return false;
    }
    if (itemsAfter) setItems(itemsAfter);
    commitResourceSelection(resourceId);
    return true;
  }, [commitResourceSelection, getLeaveConfirmation]);

  useEffect(() => {
    if (initialResourceId) selectResource(initialResourceId);
  }, [initialResourceId, selectResource]);

  useEffect(() => {
    return registerResourceWorkspace(type, (resourceId) => {
      if (selectResource(resourceId)) void loadItems();
    });
  }, [loadItems, selectResource, type]);

  useEffect(() => {
    setResourceWorkspaceActive(type, selectedId);
    return () => clearResourceWorkspaceActive(type, selectedId);
  }, [selectedId, type]);

  const createResourceNow = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    const result = await createEmpty({ type });
    setCreating(false);
    if (!result.ok) {
      setError(result.error.toUserMessage());
      return;
    }
    setItems((current) => [result.value, ...current.filter((item) => item.id !== result.value.id)]);
    commitResourceSelection(result.value.id);
  }, [commitResourceSelection, creating, type]);

  const createResource = useCallback(() => {
    if (creating) return;
    const confirmation = getLeaveConfirmation();
    if (confirmation) {
      setPendingNavigation({ kind: 'create', confirmation });
      return;
    }
    void createResourceNow();
  }, [createResourceNow, creating, getLeaveConfirmation]);

  const confirmPendingNavigation = useCallback(() => {
    const action = pendingNavigation;
    setPendingNavigation(null);
    if (!action) return;
    if (action.confirmation === 'review') {
      useReviewPlanStore.getState().endSession();
      // Re-enter the normal navigation path after ending review. It may still
      // need to confirm an unsaved exam draft before the current view unmounts.
      if (action.kind === 'select') {
        selectResource(action.resourceId, action.itemsAfter);
        return;
      }
      createResource();
      return;
    }
    if (action.kind === 'select') {
      if (action.itemsAfter) setItems(action.itemsAfter);
      commitResourceSelection(action.resourceId);
      return;
    }
    void createResourceNow();
  }, [commitResourceSelection, createResource, createResourceNow, pendingNavigation, selectResource]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const recentThreshold = Date.now() - 30 * 24 * 60 * 60 * 1000;
    return items.filter((item) => {
      if (libraryView === 'recent' && item.updatedAt < recentThreshold) return false;
      return !normalized || item.name.toLocaleLowerCase().includes(normalized);
    });
  }, [items, libraryView, query]);

  const selectedItem = items.find((item) => item.id === selectedId) ?? null;

  const handleResourceTitle = useCallback((resourceTitle: string) => {
    if (!selectedIdRef.current) return;
    const resourceId = selectedIdRef.current;
    setItems((current) => current.map((item) => (
      item.id === resourceId && item.name !== resourceTitle
        ? { ...item, name: resourceTitle }
        : item
    )));
  }, []);

  const handleListKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (visibleItems.length === 0) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = visibleItems.findIndex((item) => item.id === selectedIdRef.current);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? visibleItems.length - 1
        : currentIndex < 0
          ? (delta > 0 ? 0 : visibleItems.length - 1)
          : Math.min(Math.max(currentIndex + delta, 0), visibleItems.length - 1);
    selectResource(visibleItems[nextIndex].id);
  }, [selectResource, visibleItems]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setCompact(entry.contentRect.width < 720));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    sidebar.toggleAttribute('inert', !sidebarOpen);
    if (!sidebarOpen && sidebar.contains(document.activeElement)) {
      window.setTimeout(() => {
        hostRef.current
          ?.querySelector<HTMLButtonElement>('.wb-resource-workspace-sidebar-handle')
          ?.focus();
      }, 0);
    }
  }, [sidebarOpen]);

  const handleShortcut = useCallback((rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLocaleLowerCase();
    if (key === 'f') {
      event.preventDefault();
      setSidebarOpen(true);
      window.setTimeout(() => searchInputRef.current?.focus(), 0);
    } else if (key === 'n') {
      event.preventDefault();
      createResource();
    }
  }, [createResource]);

  useEventRegistry(
    isActive ? [{ target: 'window', type: 'keydown', listener: handleShortcut }] : [],
    [handleShortcut, isActive],
  );

  const startSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (compact) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    sidebarResizeRef.current = { startX: event.clientX, startWidth: sidebarWidth };
  }, [compact, sidebarWidth]);

  const moveSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const resize = sidebarResizeRef.current;
    if (!resize) return;
    setSidebarWidth(Math.max(200, Math.min(
      340,
      resize.startWidth + event.clientX - resize.startX,
    )));
  }, []);

  const stopSidebarResize = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    sidebarResizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  return (
    <div
      ref={hostRef}
      className="wb-resource-workspace"
      data-testid={`wb-${type}-workspace`}
      data-compact={compact ? 'true' : 'false'}
      data-sidebar-open={sidebarOpen ? 'true' : 'false'}
      style={{ '--wb-resource-sidebar-width': `${sidebarWidth}px` } as React.CSSProperties}
    >
      <aside
        ref={sidebarRef}
        className="wb-resource-workspace-sidebar"
        aria-hidden={!sidebarOpen}
      >
        <header className="wb-resource-workspace-sidebar-title">
          <span className="wb-resource-workspace-app-icon">
            <ResourceIcon size={18} weight="duotone" aria-hidden="true" />
          </span>
          <strong>{title}</strong>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={createResource}
            disabled={creating}
            title={newLabel}
            aria-label={newLabel}
          >
            {creating ? <ArrowClockwise size={14} className="animate-spin" /> : <Plus size={14} />}
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => setSidebarOpen(false)}
            title={t('workbench:resourceWorkspace.hideSidebar')}
            aria-label={t('workbench:resourceWorkspace.hideSidebar')}
          >
            <SidebarSimple size={14} />
          </NotionButton>
        </header>

        <div className="wb-resource-workspace-search">
          <MagnifyingGlass size={14} aria-hidden="true" />
          <input
            ref={searchInputRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                setQuery('');
              }
            }}
            placeholder={t('workbench:resourceHome.search')}
            aria-label={t('workbench:resourceHome.search')}
          />
          {query && (
            <NotionButton
              variant="ghost"
              size="icon"
              iconOnly
              onClick={() => {
                setQuery('');
                searchInputRef.current?.focus();
              }}
              title={t('workbench:resourceWorkspace.clearSearch')}
              aria-label={t('workbench:resourceWorkspace.clearSearch')}
            >
              <X size={12} />
            </NotionButton>
          )}
        </div>

        <nav className="wb-resource-workspace-nav" aria-label={title}>
          <NotionButton
            variant="ghost"
            className="wb-resource-workspace-nav-row"
            data-active={libraryView === 'all'}
            onClick={() => setLibraryView('all')}
          >
            <Rows size={14} />
            <span>{t('workbench:resourceHome.all')}</span>
            <small>{items.length}</small>
          </NotionButton>
          <NotionButton
            variant="ghost"
            className="wb-resource-workspace-nav-row"
            data-active={libraryView === 'recent'}
            onClick={() => setLibraryView('recent')}
          >
            <ClockCounterClockwise size={14} />
            <span>{t('workbench:resourceHome.recent')}</span>
          </NotionButton>
        </nav>

        <div
          className="wb-resource-workspace-list"
          role="listbox"
          tabIndex={0}
          aria-label={title}
          aria-busy={loading}
          onKeyDown={handleListKeyDown}
        >
          {loading && items.length === 0 ? (
            <div className="wb-resource-workspace-loading" role="status">
              {[0, 1, 2, 3, 4].map((index) => <i key={index} />)}
            </div>
          ) : error ? (
            <div className="wb-resource-workspace-message" role="alert">
              <WarningCircle size={22} />
              <span>{error}</span>
              <NotionButton variant="outline" size="sm" onClick={() => void loadItems()}>
                {t('resourceHome.retry')}
              </NotionButton>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="wb-resource-workspace-message">
              <span>
                {query
                  ? t('workbench:resourceHome.noMatches')
                  : t('workbench:resourceHome.empty')}
              </span>
            </div>
          ) : visibleItems.map((item) => (
            <NotionButton
              key={item.id}
              variant="ghost"
              className="wb-resource-workspace-resource"
              data-selected={selectedId === item.id}
              role="option"
              aria-selected={selectedId === item.id}
              onClick={() => selectResource(item.id)}
            >
              <ResourceIcon size={15} weight="duotone" />
              <span>{item.name || t('resourceHome.untitled')}</span>
            </NotionButton>
          ))}
        </div>

        <footer className="wb-resource-workspace-sidebar-footer">
          <span>{t('workbench:resourceHome.itemCount', { count: visibleItems.length })}</span>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => void loadItems()}
            disabled={loading}
            title={t('resourceWorkspace.refresh')}
            aria-label={t('resourceWorkspace.refresh')}
          >
            <ArrowClockwise size={13} className={cn(loading && 'animate-spin')} />
          </NotionButton>
        </footer>
        <div
          className="wb-resource-workspace-resize"
          role="separator"
          aria-orientation="vertical"
          aria-valuemin={200}
          aria-valuemax={340}
          aria-valuenow={sidebarWidth}
          onPointerDown={startSidebarResize}
          onPointerMove={moveSidebarResize}
          onPointerUp={stopSidebarResize}
          onPointerCancel={stopSidebarResize}
        />
      </aside>

      <main className="wb-resource-workspace-main">
        {!sidebarOpen && (
          <NotionButton
            variant="outline"
            size="icon"
            iconOnly
            className="wb-resource-workspace-sidebar-handle"
            onClick={() => setSidebarOpen(true)}
            title={t('workbench:resourceWorkspace.showSidebar')}
            aria-label={t('workbench:resourceWorkspace.showSidebar')}
          >
            <SidebarSimple size={15} />
          </NotionButton>
        )}
        {selectedItem ? (
          <UnifiedAppPanel
            type={type}
            resourceId={selectedItem.id}
            dstuPath={`/${selectedItem.id}`}
            strictType
            isActive={isActive}
            onTitleChange={handleResourceTitle}
            onClose={() => selectResource(null)}
            className="h-full"
          />
        ) : (
          <div className="wb-resource-workspace-empty">
            <ResourceIcon size={38} weight="thin" />
            <strong>{t('workbench:resourceWorkspace.selectTitle')}</strong>
            <span>{t('workbench:resourceWorkspace.selectHint')}</span>
            <NotionButton size="sm" onClick={createResource} disabled={creating}>
              <Plus size={15} />
              {newLabel}
            </NotionButton>
          </div>
        )}
      </main>
      {compact && sidebarOpen && (
        <NotionButton
          variant="ghost"
          className="wb-resource-workspace-scrim"
          onClick={() => setSidebarOpen(false)}
          aria-label={t('workbench:resourceWorkspace.hideSidebar')}
        />
      )}
      <NotionAlertDialog
        open={pendingNavigation !== null}
        onOpenChange={(open) => {
          if (!open) setPendingNavigation(null);
        }}
        icon={<WarningCircle size={20} className="text-warning" />}
        title={pendingNavigation?.confirmation === 'review'
          ? t('resourceWorkspace.reviewExitTitle')
          : t('content.unsavedTitle')}
        description={pendingNavigation?.confirmation === 'review'
          ? t('resourceWorkspace.reviewExitDescription')
          : t('content.confirmCloseUnsaved')}
        confirmText={pendingNavigation?.confirmation === 'review'
          ? t('resourceWorkspace.reviewExitConfirm')
          : t('resourceWorkspace.discard')}
        cancelText={t('resourceWorkspace.cancel')}
        confirmVariant="danger"
        onConfirm={confirmPendingNavigation}
      />
    </div>
  );
};

export default ResourceAppWorkspace;
