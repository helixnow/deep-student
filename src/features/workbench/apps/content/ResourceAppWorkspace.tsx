import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowClockwise,
  ClockCounterClockwise,
  ClipboardText,
  GearSix,
  MagnifyingGlass,
  PenNib,
  Plus,
  Rows,
  Translate,
  WarningCircle,
  X,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { CustomScrollArea } from '@/components/custom-scroll-area';
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
import { WorkbenchSidebarSurface, WorkbenchSidebarRow, WorkbenchSidebarRowLabel } from '../../components/sidebar';
import { WorkbenchSidebarLayout } from '../system/SystemWindowShared';
import { classifyWbSysWidth, type WbSysSizeClass } from '../system/useWbSysSize';

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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sizeClass, setSizeClass] = useState<WbSysSizeClass>('wide');
  const [pendingNavigation, setPendingNavigation] = useState<PendingNavigation | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const isExam = type === 'exam';
  // 作文/翻译：设置由 OS 应用侧边栏进入，并替换主区成为完整内容页
  const hasSettingsEntry = type === 'essay' || type === 'translation';
  const [settingsOpen, setSettingsOpen] = useState(false);
  const title = t(`workbench:apps.${type}`);
  const ResourceIcon = isExam ? ClipboardText : type === 'translation' ? Translate : PenNib;
  const newLabel = isExam
    ? t('workbench:resourceHome.newExam')
    : type === 'translation'
      ? t('workbench:resourceHome.newTranslation')
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
          : isContentDirty(type, activeId)
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

  const setSettingsView = useCallback((open: boolean, resourceId = selectedIdRef.current) => {
    if (!hasSettingsEntry || !resourceId) return;
    setSettingsOpen(open);
    window.dispatchEvent(new CustomEvent(`${type}:openSettings`, {
      detail: { targetResourceId: resourceId, open },
    }));
    if (open && sizeClass === 'compact') setSidebarOpen(false);
  }, [hasSettingsEntry, sizeClass, type]);

  const commitResourceSelection = useCallback((resourceId: string | null) => {
    selectedIdRef.current = resourceId;
    setSelectedId(resourceId);
    setSettingsOpen(false);
    if (resourceId && sizeClass === 'compact') setSidebarOpen(false);
  }, [sizeClass]);

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
    if (isContentDirty(type, resourceId)) {
      return 'unsaved';
    }
    return null;
  }, [type]);

  const selectResource = useCallback((resourceId: string | null, itemsAfter?: DstuNode[]): boolean => {
    const current = selectedIdRef.current;
    if (resourceId === current) {
      if (settingsOpen) setSettingsView(false, current);
      return true;
    }
    const confirmation = getLeaveConfirmation();
    if (confirmation) {
      setPendingNavigation({ kind: 'select', resourceId, confirmation, itemsAfter });
      return false;
    }
    if (itemsAfter) setItems(itemsAfter);
    commitResourceSelection(resourceId);
    return true;
  }, [commitResourceSelection, getLeaveConfirmation, settingsOpen, setSettingsView]);

  useEffect(() => {
    if (initialResourceId && initialResourceId !== selectedIdRef.current) {
      selectResource(initialResourceId);
    }
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

  // 侧边栏"设置"标签选中态：作文/翻译工作台在设置页开合时广播 settingsVisibility
  useEffect(() => {
    if (!hasSettingsEntry) return;
    const eventName = `${type}:settingsVisibility`;
    const handler = (evt: Event) => {
      const detail = (evt as CustomEvent<{ resourceId?: string; open?: boolean }>).detail;
      if (!detail?.resourceId || detail.resourceId !== selectedIdRef.current) return;
      setSettingsOpen(Boolean(detail.open));
    };
    window.addEventListener(eventName, handler);
    return () => window.removeEventListener(eventName, handler);
  }, [hasSettingsEntry, type]);

  const selectLibraryView = useCallback((view: LibraryView) => {
    setLibraryView(view);
    if (settingsOpen) setSettingsView(false);
  }, [settingsOpen, setSettingsView]);

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
    if (!host) return;
    // 首帧同步分级：ResizeObserver 首次回调是异步的，窄窗打开时会先按
    // wide 渲染并排侧栏再塌缩成抽屉（一帧闪变）。jsdom 下测量为 0，保持
    // wide 兜底不影响测试。
    const initialWidth = host.getBoundingClientRect().width || host.clientWidth;
    if (initialWidth > 0) setSizeClass(classifyWbSysWidth(initialWidth));
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => setSizeClass(classifyWbSysWidth(entry.contentRect.width)));
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

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

  return (
    <div
      ref={hostRef}
      className="wb-resource-workspace"
      data-testid={`wb-${type}-workspace`}
      data-compact={sizeClass === 'compact' ? 'true' : 'false'}
      data-sidebar-open={sizeClass === 'compact' ? (sidebarOpen ? 'true' : 'false') : 'true'}
    >
      <WorkbenchSidebarLayout
        sizeClass={sizeClass}
        navLabel={title}
        drawerOpen={sidebarOpen}
        onDrawerOpenChange={setSidebarOpen}
        sidebar={<WorkbenchSidebarSurface ariaLabel={title} className="wb-resource-workspace-sidebar">
        <header className="wb-resource-workspace-sidebar-title">
          <span className="wb-resource-workspace-app-icon">
            <ResourceIcon size={18} weight="duotone" aria-hidden="true" />
          </span>
          <strong>{title}</strong>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={createResource}
            disabled={creating}
            title={newLabel}
            aria-label={newLabel}
          >
            {creating ? <ArrowClockwise size={14} className="animate-spin" /> : <Plus size={14} />}
          </DsButton>
        </header>

        {/* data-wb-drawer-stay：搜索/过滤/刷新的结果就显示在抽屉列表里，
            紧凑窗抽屉不因这些操作自动收起（见 WorkbenchSidebarLayout） */}
        <div className="wb-resource-workspace-search" data-wb-drawer-stay>
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
            <DsButton
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
            </DsButton>
          )}
        </div>

        <nav className="wb-resource-workspace-nav" aria-label={title} data-wb-drawer-stay>
          <WorkbenchSidebarRow
            isActive={!settingsOpen && libraryView === 'all'}
            onClick={() => selectLibraryView('all')}
            leftSlot={<Rows size={14} />}
            rightSlot={<small>{items.length}</small>}
          >
            <WorkbenchSidebarRowLabel>{t('workbench:resourceHome.all')}</WorkbenchSidebarRowLabel>
          </WorkbenchSidebarRow>
          <WorkbenchSidebarRow
            isActive={!settingsOpen && libraryView === 'recent'}
            onClick={() => selectLibraryView('recent')}
            leftSlot={<ClockCounterClockwise size={14} />}
          >
            <WorkbenchSidebarRowLabel>{t('workbench:resourceHome.recent')}</WorkbenchSidebarRowLabel>
          </WorkbenchSidebarRow>
        </nav>

        <CustomScrollArea
          className="wb-resource-workspace-list-scroll"
          viewportClassName="wb-resource-workspace-list"
          viewportProps={{
            role: 'listbox',
            tabIndex: 0,
            'aria-label': title,
            'aria-busy': loading,
            onKeyDown: handleListKeyDown,
          }}
          trackOffsetTop={5}
          trackOffsetBottom={8}
          trackOffsetRight={3}
        >
          {loading && items.length === 0 ? (
            <div className="wb-resource-workspace-loading" role="status">
              {[0, 1, 2, 3, 4].map((index) => <i key={index} />)}
            </div>
          ) : error ? (
            <div className="wb-resource-workspace-message" role="alert">
              <WarningCircle size={22} />
              <span>{error}</span>
              <DsButton variant="outline" size="sm" onClick={() => void loadItems()}>
                {t('resourceHome.retry')}
              </DsButton>
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
            <WorkbenchSidebarRow
              key={item.id}
              rowType="thread"
              isActive={!settingsOpen && selectedId === item.id}
              role="option"
              aria-selected={!settingsOpen && selectedId === item.id}
              onClick={() => selectResource(item.id)}
              leftSlot={<ResourceIcon size={15} weight="duotone" />}
            >
              <WorkbenchSidebarRowLabel>{item.name || t('resourceHome.untitled')}</WorkbenchSidebarRowLabel>
            </WorkbenchSidebarRow>
          ))}
        </CustomScrollArea>

        {hasSettingsEntry && (
          <div className="wb-resource-workspace-settings" data-wb-drawer-stay>
            <WorkbenchSidebarRow
              isActive={settingsOpen}
              onClick={() => setSettingsView(true)}
              disabled={!selectedItem}
              title={selectedItem ? undefined : t('workbench:resourceHome.settingsNeedSelection')}
              leftSlot={<GearSix size={14} />}
            >
              <WorkbenchSidebarRowLabel>
                {type === 'translation'
                  ? t('workbench:resourceHome.translationSettings')
                  : t('workbench:resourceHome.essaySettings')}
              </WorkbenchSidebarRowLabel>
            </WorkbenchSidebarRow>
          </div>
        )}

        <footer className="wb-resource-workspace-sidebar-footer" data-wb-drawer-stay>
          <span>{t('workbench:resourceHome.itemCount', { count: visibleItems.length })}</span>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={() => void loadItems()}
            disabled={loading}
            title={t('resourceWorkspace.refresh')}
            aria-label={t('resourceWorkspace.refresh')}
          >
            <ArrowClockwise size={13} className={cn(loading && 'animate-spin')} />
          </DsButton>
        </footer>
      </WorkbenchSidebarSurface>}
      >

      <main className="wb-resource-workspace-main">
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
            externalSettingsNavigation={hasSettingsEntry}
            externalSettingsOpen={settingsOpen}
          />
        ) : (
          <div className="wb-resource-workspace-empty">
            <ResourceIcon size={38} weight="thin" />
            <strong>{t('workbench:resourceWorkspace.selectTitle')}</strong>
            <span>{t('workbench:resourceWorkspace.selectHint')}</span>
            <DsButton size="sm" onClick={createResource} disabled={creating}>
              <Plus size={15} />
              {newLabel}
            </DsButton>
          </div>
        )}
      </main>
      </WorkbenchSidebarLayout>
      <DsAlertDialog
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
