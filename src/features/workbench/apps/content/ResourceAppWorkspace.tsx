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
import { createEmpty, dstu, type DstuNode } from '@/dstu';
import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { cn } from '@/lib/utils';
import { isContentDirty } from './contentDirtyRegistry';
import {
  clearResourceWorkspaceActive,
  registerResourceWorkspace,
  setResourceWorkspaceActive,
  type ResourceWorkspaceType,
} from './resourceWorkspaceRegistry';
import './ResourceAppWorkspace.css';

type LibraryView = 'all' | 'recent';

interface ResourceAppWorkspaceProps {
  type: ResourceWorkspaceType;
  initialResourceId?: string | null;
  isActive: boolean;
  onTitleChange: (title: string) => void;
}

function canLeaveResource(type: ResourceWorkspaceType, resourceId: string | null): boolean {
  if (type !== 'essay' || !resourceId || !isContentDirty(type, resourceId)) return true;
  if (typeof window === 'undefined' || typeof window.confirm !== 'function') return true;
  // eslint-disable-next-line no-alert -- switching resources must not discard an edited essay silently.
  return window.confirm('当前作文有未保存的修改，确定要切换吗？');
}

export const ResourceAppWorkspace: React.FC<ResourceAppWorkspaceProps> = ({
  type,
  initialResourceId,
  isActive,
  onTitleChange,
}) => {
  const { t } = useTranslation(['workbench', 'common']);
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
  const hostRef = useRef<HTMLDivElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const sidebarResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const isExam = type === 'exam';
  const title = isExam
    ? t('workbench:apps.exam', '题目集')
    : t('workbench:apps.essay', '作文批改');
  const ResourceIcon = isExam ? ClipboardText : PenNib;
  const newLabel = isExam
    ? t('workbench:resourceHome.newExam', '新建题目集')
    : t('workbench:resourceHome.newEssay', '新建作文批改');

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
      setItems(result.value);
      const activeId = selectedIdRef.current;
      if (activeId && !result.value.some((item) => item.id === activeId)) {
        selectedIdRef.current = null;
        setSelectedId(null);
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

  const selectResource = useCallback((resourceId: string | null): boolean => {
    const current = selectedIdRef.current;
    if (resourceId === current) return true;
    if (!canLeaveResource(type, current)) return false;
    selectedIdRef.current = resourceId;
    setSelectedId(resourceId);
    if (resourceId && compact) setSidebarOpen(false);
    return true;
  }, [compact, type]);

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

  const createResource = useCallback(async () => {
    if (creating || !canLeaveResource(type, selectedIdRef.current)) return;
    setCreating(true);
    setError(null);
    const result = await createEmpty({ type });
    setCreating(false);
    if (!result.ok) {
      setError(result.error.toUserMessage());
      return;
    }
    setItems((current) => [result.value, ...current.filter((item) => item.id !== result.value.id)]);
    selectedIdRef.current = result.value.id;
    setSelectedId(result.value.id);
    if (compact) setSidebarOpen(false);
  }, [compact, creating, type]);

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
      void createResource();
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
            onClick={() => void createResource()}
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
            title={t('workbench:resourceWorkspace.hideSidebar', '隐藏侧边栏')}
            aria-label={t('workbench:resourceWorkspace.hideSidebar', '隐藏侧边栏')}
          >
            <SidebarSimple size={14} />
          </NotionButton>
        </header>

        <div className="wb-resource-workspace-search">
          <MagnifyingGlass size={14} aria-hidden="true" />
          <input
            ref={searchInputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && query) {
                event.preventDefault();
                setQuery('');
              }
            }}
            placeholder={t('workbench:resourceHome.search', '搜索')}
            aria-label={t('workbench:resourceHome.search', '搜索')}
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
              title={t('workbench:resourceWorkspace.clearSearch', '清除搜索')}
              aria-label={t('workbench:resourceWorkspace.clearSearch', '清除搜索')}
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
            <span>{t('workbench:resourceHome.all', '全部')}</span>
            <small>{items.length}</small>
          </NotionButton>
          <NotionButton
            variant="ghost"
            className="wb-resource-workspace-nav-row"
            data-active={libraryView === 'recent'}
            onClick={() => setLibraryView('recent')}
          >
            <ClockCounterClockwise size={14} />
            <span>{t('workbench:resourceHome.recent', '最近使用')}</span>
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
                {t('common:retry', '重试')}
              </NotionButton>
            </div>
          ) : visibleItems.length === 0 ? (
            <div className="wb-resource-workspace-message">
              <span>
                {query
                  ? t('workbench:resourceHome.noMatches', '没有匹配的内容')
                  : t('workbench:resourceHome.empty', '这里还没有内容')}
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
              <span>{item.name || t('common:untitled', '未命名')}</span>
            </NotionButton>
          ))}
        </div>

        <footer className="wb-resource-workspace-sidebar-footer">
          <span>{t('workbench:resourceHome.itemCount', '{{count}} 个项目', { count: visibleItems.length })}</span>
          <NotionButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => void loadItems()}
            disabled={loading}
            title={t('common:refresh', '刷新')}
            aria-label={t('common:refresh', '刷新')}
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
            title={t('workbench:resourceWorkspace.showSidebar', '显示侧边栏')}
            aria-label={t('workbench:resourceWorkspace.showSidebar', '显示侧边栏')}
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
            <strong>{t('workbench:resourceWorkspace.selectTitle', '选择一个项目')}</strong>
            <span>{t('workbench:resourceWorkspace.selectHint', '从左侧选择，或新建后直接开始。')}</span>
            <NotionButton size="sm" onClick={() => void createResource()} disabled={creating}>
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
          aria-label={t('workbench:resourceWorkspace.hideSidebar', '隐藏侧边栏')}
        />
      )}
    </div>
  );
};

export default ResourceAppWorkspace;
