import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { clampMenuPosition } from './tree/TreeContextMenu';
import { createPortal } from 'react-dom';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from 'react-resizable-panels';
import { CaretLeft } from '@phosphor-icons/react';
import { dstu, createEmpty, folderApi, trashApi, type DstuNode } from '@/dstu';
import { DSTU_FOLDER_CHANGE_EVENT } from '@/dstu/folderEvents';
import { exportResourceById } from '@/features/learning-hub/utils/exportResource';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import {
  NOTES_WORKSPACE_COMMAND_EVENT,
  type NotesWorkspaceCommandAction,
  type NotesWorkspaceCommandDetail,
} from '@/command-palette/modules/notes.commands';
import { publishNotesFindQuery } from '@/features/notes/findQueryBridge';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { VfsFolder } from '@/dstu/types/folder';
import { requestContentCloseDecision } from '../content/ContentCloseConfirmation';
import {
  hasContentSaveHandler,
  saveContentNow,
} from '../content/contentDirtyRegistry';
import type { AppWindowProps } from '../../core/types';
import { setWindowDirty } from '../../core/windowCloseGuard';
import { useDragRenderPause } from '../../hooks/useDragRenderPause';
import {
  forgetWorkspaceResource,
  registerWorkspaceHost,
  setWorkspaceActiveResource,
  type NotesWorkspaceResourceRef,
} from './workspaceRegistry';
import {
  NotesBacklinksPanel,
  type NotesBacklinksTabRequest,
  type PanelTab,
} from './NotesBacklinksPanel';
import { RENAME_SYNC_SOURCE_LIMIT, syncWikiLinksAfterNoteRename } from './wikilinkRenameSync';
import { NotesOutlineTab, NotesPropertiesTab } from './NotesPropertiesTab';
import type { NoteBreadcrumbItem } from '@/features/notes/components/NotesEditorHeader';
import { CreateLearningNoteDialog } from '@/features/notes/components/CreateLearningNoteDialog';
import { NotesGraphTab } from './graph/NotesGraphTab';
import { NotesSearchOverlay, type NotesSearchMode } from './NotesSearchOverlay';
import { NotesTrashDialog } from './NotesTrashDialog';
import { useNoteFavorites } from './hooks/useNoteFavorites';
import {
  useNotesNavHistory,
  type NotesNavHistoryEntry,
} from './hooks/useNotesNavHistory';
import { useMemoryRootFolder } from '@/features/learning-hub/hooks/useMemoryRootFolder';
import {
  mapWorkspaceTreeFolder,
  expandedIdsFromCollapsedPaths,
  collectFolderEntries,
  findItemById,
  type NotesWorkspaceDropPosition,
  type NotesWorkspaceTreeItem,
} from './tree';
import './NotesWorkspaceApp.css';
import { WorkbenchSidebarLayout } from '../system/SystemWindowShared';
import { classifyWbSysWidth, type WbSysSizeClass } from '../system/useWbSysSize';
import { setWikilinkCreateContext } from '@/features/notes/createFromWikilink';
import { WorkbenchNotesLibraryDialog } from './WorkbenchNotesLibraryDialog';
import { notesDstuAdapter } from '@/dstu/adapters/notesDstuAdapter';
import { openQuickAssistantWindow } from '@/quick-assistant/window';
import {
  updateFocusModeOwners,
  type NotesFocusModeEventDetail,
} from '@/features/notes/focusModeOwnership';
import {
  NOTE_TITLE_MAX_CHARS,
  validateNoteTitle,
} from '@/features/notes/noteInputLimits';
import './notes-empty-states.css';
import { NotesChromeSlotContext } from '@/features/notes/notesChromeSlot';
import {
  BACKLINKS_SIDE_BY_SIDE_MIN_WIDTH,
  DEFAULT_SPLIT_LAYOUT,
  EMPTY_RESOURCE_FOLDER_IDS,
  RESOURCE_LIST_MAX_TOTAL,
  RESOURCE_LIST_PAGE_SIZE,
  buildTree,
  computeNoteBreadcrumbs,
  computeTabCloseNextState,
  filterWorkspaceResources,
  getFolderMembership,
  getRecentSearchResources,
  getTabContextMenuState,
  getTabSaveState,
  getWelcomeRecentResources,
  isCloseTabShortcut,
  isMarkdownFileName,
  isStableVfsFolderId,
  listWorkspaceResources,
  matchWorkspaceWindowShortcut,
  mergeUpdatedResourceNode,
  parseInitialResource,
  parseSplitLayout,
  readPersistedWorkspaceState,
  reconcileTabsWithResources,
  reorderWorkspaceTabs,
  resolveCoherentPaneState,
  resolveExplorerDeleteTargets,
  resolveMoveDestinationFolderId,
  resolveRightSplitMainTabKey,
  resourceType,
  shouldCloseRightSplitOnTabClose,
  treeResourceKey,
  writePersistedWorkspaceState,
  type CloseTabOptions,
  type PersistedWorkspaceState,
  type ResourceDialog,
  type ResourceType,
  type SaveState,
  type SplitLayout,
  type TabContextMenu,
  type TabDropPosition,
  type WorkspacePaneId,
  type WorkspaceTab,
} from './workspaceTreeModel';
import { WorkspaceTabContextMenu, WorkspaceTabs } from './components/WorkspaceTabStrip';
import { WorkspacePane } from './components/WorkspacePane';
import { WorkspaceExplorer } from './components/WorkspaceExplorer';

export {
  RESOURCE_LIST_PAGE_SIZE,
  RESOURCE_LIST_MAX_TOTAL,
  BACKLINKS_SIDE_BY_SIDE_MIN_WIDTH,
  listWorkspaceResources,
  buildTree,
  computeNoteBreadcrumbs,
};

function normalizeWorkspaceResourceRef(
  ref: NotesWorkspaceResourceRef | null,
): NotesWorkspaceResourceRef | null {
  if (!ref) return null;
  const rawId = ref.id.trim();
  if (!rawId) return null;
  if (rawId.startsWith('note:')) {
    const stripped = rawId.slice('note:'.length).trim();
    return stripped ? { type: 'note', id: stripped } : null;
  }
  if (rawId.startsWith('mindmap:')) {
    const stripped = rawId.slice('mindmap:'.length).trim();
    return stripped ? { type: 'mindmap', id: stripped } : null;
  }
  return { type: ref.type, id: rawId };
}

function normalizePersistedWorkspaceState(state: PersistedWorkspaceState): PersistedWorkspaceState {
  const keyRemap = new Map<string, string>();
  const seenKeys = new Set<string>();
  const tabs: WorkspaceTab[] = [];
  for (const tab of state.tabs) {
    const normalizedRef = normalizeWorkspaceResourceRef({ type: tab.type, id: tab.id });
    if (!normalizedRef) continue;
    const canonicalKey = `${normalizedRef.type}:${normalizedRef.id}`;
    keyRemap.set(tab.key, canonicalKey);
    if (seenKeys.has(canonicalKey)) continue;
    seenKeys.add(canonicalKey);
    tabs.push({
      ...tab,
      type: normalizedRef.type,
      id: normalizedRef.id,
      key: canonicalKey,
    });
  }
  const remapKey = (key: string | null): string | null => {
    if (!key) return null;
    const mapped = keyRemap.get(key) ?? key;
    return seenKeys.has(mapped) ? mapped : null;
  };
  const rightTabKey = remapKey(state.rightTabKey);
  const mainTabs = tabs.filter((tab) => tab.key !== rightTabKey);
  const rawActive = remapKey(state.activeTabKey);
  const activeTabKey = rawActive && mainTabs.some((tab) => tab.key === rawActive)
    ? rawActive
    : mainTabs[0]?.key ?? null;
  return {
    ...state,
    tabs,
    activeTabKey,
    rightTabKey,
    focusedPane: rightTabKey && state.focusedPane === 'right' ? 'right' : 'main',
  };
}

export const NotesWorkspaceApp: React.FC<AppWindowProps> = ({
  windowId,
  instanceKey,
  launchPayload,
  isActive,
  isVisible = true,
  isSuspended = false,
  renderThrottleMs = 0,
  onTitleChange,
}) => {
  const { t } = useTranslation(['workbench', 'notes', 'common']);
  const persistedStateRef = useRef(normalizePersistedWorkspaceState(readPersistedWorkspaceState()));
  const persistedState = persistedStateRef.current;
  const paneVisible = isVisible && !isSuspended;
  const [hasBeenVisible, setHasBeenVisible] = useState(paneVisible);
  const [paneReloadNonce, setPaneReloadNonce] = useState<{ main: number; right: number }>({ main: 0, right: 0 });
  const [hasInteractiveTabOpen, setHasInteractiveTabOpen] = useState(false);
  const hostRef = useRef<HTMLDivElement>(null);
  // 拖/缩/settle 期间冻结工作区动画/过渡（CSS 定向规则见 NotesWorkspaceApp.css）
  useDragRenderPause(hostRef, renderThrottleMs);

  const [resources, setResources] = useState<DstuNode[]>([]);
  const [folders, setFolders] = useState<VfsFolder[]>([]);
  const [resourceFolderIds, setResourceFolderIds] = useState<ReadonlyMap<string, string>>(EMPTY_RESOURCE_FOLDER_IDS);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [learningCreateOpen, setLearningCreateOpen] = useState(false);
  /** 从目录树右键创建时的目标文件夹；undefined = 跟随当前上下文文件夹 */
  const [learningCreateFolderId, setLearningCreateFolderId] = useState<string | null | undefined>(undefined);
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => persistedState.tabs);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(() => persistedState.activeTabKey);
  const [rightTabKey, setRightTabKey] = useState<string | null>(() => persistedState.rightTabKey);
  const [focusedPane, setFocusedPane] = useState<WorkspacePaneId>(() => persistedState.focusedPane);
  const [splitLayout, setSplitLayout] = useState<SplitLayout>(() => persistedState.splitLayout);
  const [backlinksOpen, setBacklinksOpen] = useState(() => persistedState.backlinksOpen);
  const [backlinksRequestedTab, setBacklinksRequestedTab] = useState<NotesBacklinksTabRequest | null>(null);
  // 命令处理器不随面板状态重建：经 ref 跟踪面板开关与真实激活页签（由面板通过 onActiveTabChange 回传）
  const backlinksStateRef = useRef<{ open: boolean; tab: PanelTab }>({
    open: backlinksOpen,
    tab: 'links',
  });
  backlinksStateRef.current.open = backlinksOpen;
  const handleBacklinksActiveTabChange = useCallback((tab: PanelTab) => {
    backlinksStateRef.current.tab = tab;
  }, []);
  const closeBacklinks = useCallback(() => {
    setBacklinksOpen(false);
  }, []);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<NotesSearchMode>('quick-open');
  const [explorerOpen, setExplorerOpen] = useState(() => persistedState.explorerOpen);
  const explorerOpenRef = useRef(explorerOpen);
  explorerOpenRef.current = explorerOpen;
  // compact 档把 explorerOpen 复用为「文件」全屏子屏的开关；进窄窗前的
  // 宽/中窗侧栏折叠偏好暂存在这里，回宽窗时还原（持久化也写这份偏好）
  const explorerBeforeCompactRef = useRef(persistedState.explorerOpen);
  const [focusMode, setFocusMode] = useState(false);
  const focusModeOwnersRef = useRef<Set<string>>(new Set());
  const [collapsedFolderPaths, setCollapsedFolderPaths] = useState<Set<string>>(
    () => new Set(persistedState.collapsedFolderPaths),
  );
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [selectedTreeId, setSelectedTreeId] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [sizeClass, setSizeClass] = useState<WbSysSizeClass>('wide');
  const sizeClassRef = useRef<WbSysSizeClass>('wide');
  sizeClassRef.current = sizeClass;
  const [workspaceWidth, setWorkspaceWidth] = useState(0);
  const [titlebarTarget, setTitlebarTarget] = useState<HTMLElement | null>(null);
  const [notesChromeSlot, setNotesChromeSlot] = useState<HTMLDivElement | null>(null);
  const [status, setStatus] = useState(() => t('notesWorkspace.status.ready', 'Ready'));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tabSaveStates, setTabSaveStates] = useState<Record<string, SaveState>>({});
  const tabSaveStatesRef = useRef(tabSaveStates);
  tabSaveStatesRef.current = tabSaveStates;
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenu | null>(null);
  const [resourceDialog, setResourceDialog] = useState<ResourceDialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const dialogBusyRef = useRef(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [libraryDialog, setLibraryDialog] = useState<{ open: boolean; tab: 'export' | 'import' }>({
    open: false,
    tab: 'export',
  });

  const favorites = useNoteFavorites();
  const navHistory = useNotesNavHistory();
  const initialRef = useRef(normalizeWorkspaceResourceRef(parseInitialResource(instanceKey, launchPayload)));
  const openResourceRef = useRef<(ref: NotesWorkspaceResourceRef, title?: string) => Promise<void>>(async () => undefined);
  const closeTabRef = useRef<(key: string, options?: CloseTabOptions) => Promise<boolean>>(async () => false);
  const pendingTabCloseKeysRef = useRef(new Set<string>());
  const pendingConfirmedDeletionKeysRef = useRef(new Set<string>());
  const activeTabRef = useRef<WorkspaceTab | null>(null);
  const mainActiveTabRef = useRef<WorkspaceTab | null>(null);
  const splitTabRef = useRef<WorkspaceTab | null>(null);
  const tabsRef = useRef<WorkspaceTab[]>([]);
  const rightTabKeyRef = useRef<string | null>(rightTabKey);
  const focusedPaneRef = useRef<WorkspacePaneId>(focusedPane);
  const resourcesRef = useRef<DstuNode[]>([]);
  const resourceUpdatedAtRef = useRef<Map<string, number>>(new Map());
  const syncHydrationPendingRef = useRef(false);
  const wasPaneVisibleRef = useRef(paneVisible);
  const pendingStageHydrationRef = useRef<{
    preferredType: ResourceType;
    rootFolderId: string | null;
    preferCorrectionNotes?: boolean;
  } | null>(null);
  const hasLoadedResourcesRef = useRef(false);
  const truncationNotifiedRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const tabContextTriggerRef = useRef<HTMLElement | null>(null);
  const restoreTabContextFocusRef = useRef(false);
  const paneGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const splitLayoutRef = useRef<SplitLayout>(splitLayout);

  const splitTab = tabs.find((tab) => tab.key === rightTabKey) ?? null;
  const mainTabs = useMemo(() => tabs.filter((tab) => tab.key !== splitTab?.key), [splitTab?.key, tabs]);
  const mainActiveTab = mainTabs.find((tab) => tab.key === activeTabKey) ?? mainTabs[0] ?? null;
  const resolvedFocusedPane: WorkspacePaneId = splitTab && focusedPane === 'right' ? 'right' : 'main';
  const activeTab = resolvedFocusedPane === 'right' ? splitTab : mainActiveTab;
  const activeResource = activeTab
    ? resources.find((node) => node.id === activeTab.id && node.type === activeTab.type) ?? null
    : null;
  const activeResourceFolderId = activeTab
    ? resourceFolderIds.get(treeResourceKey(activeTab.type, activeTab.id)) ?? null
    : null;
  const contextualFolderId = activeTab ? activeResourceFolderId : selectedFolderId;

  const {
    target: tabContextTarget,
    canCloseOthers: tabContextCanCloseOthers,
    canCloseRight: tabContextCanCloseRight,
  } = getTabContextMenuState(tabs, tabContextMenu);

  activeTabRef.current = activeTab;
  mainActiveTabRef.current = mainActiveTab;
  splitTabRef.current = splitTab;
  tabsRef.current = tabs;
  rightTabKeyRef.current = splitTab?.key ?? null;
  focusedPaneRef.current = resolvedFocusedPane;
  splitLayoutRef.current = splitLayout;
  resourcesRef.current = resources;

  const filteredResources = useMemo(
    () => filterWorkspaceResources(resources, query, selectedTags),
    [query, resources, selectedTags],
  );
  const tree = useMemo(
    () => buildTree(
      filteredResources,
      query.trim() || selectedTags.length > 0 ? [] : folders,
      query.trim() || selectedTags.length > 0 ? EMPTY_RESOURCE_FOLDER_IDS : resourceFolderIds,
    ),
    [filteredResources, folders, query, resourceFolderIds, selectedTags.length],
  );
  const memoryRoot = useMemoryRootFolder();
  const treeItems = useMemo(() => mapWorkspaceTreeFolder(tree, { memoryRoot }), [memoryRoot, tree]);
  const folderEntries = useMemo(() => collectFolderEntries(treeItems), [treeItems]);
  const expandedIds = useMemo(
    () => expandedIdsFromCollapsedPaths(folderEntries, collapsedFolderPaths),
    [collapsedFolderPaths, folderEntries],
  );

  // 宽/中窗侧栏可被 explorerOpen 真正折叠（mod+\ / 命令面板 toggle-sidebar）：
  // 折叠后布局宽度归零，titlebar 标签偏移与背链 overlay 判定随之变化
  const explorerVisible = sizeClass !== 'compact' && explorerOpen;
  const sidebarLayoutWidth = explorerVisible ? (sizeClass === 'wide' ? 244 : 216) : 0;
  const availableMainWidth = workspaceWidth - sidebarLayoutWidth;
  const backlinksOverlay = sizeClass === 'compact'
    || Boolean(splitTab)
    || workspaceWidth < BACKLINKS_SIDE_BY_SIDE_MIN_WIDTH
    || availableMainWidth < 760;
  // 标签 portal 的原点已在红绿灯右侧；这里只传侧栏宽度，CSS 扣除 slot 的预留。
  // 与实际侧栏消费相同 token，收起 / 窄窗 / 专注模式均不再额外留白。
  const titlebarSidebarWidth = explorerVisible && !focusMode
    ? sizeClass === 'wide' ? 'var(--wb-sidebar-width, 272px)' : 'var(--wb-sidebar-width-medium, 240px)'
    : '0px';
  const saveStates = useMemo(
    () => new Map(tabs.map((tab) => [tab.key, tabSaveStates[tab.key] ?? getTabSaveState(tab, windowId)])),
    [tabSaveStates, tabs, windowId],
  );

  // P1 未保存圆点：任一标签页非 saved（dirty/saving）→ 推送窗口级脏状态，
  // WindowTitleBar 红灯据此渲染中心圆点（windowCloseGuard 脏通道）。
  const hasUnsavedTabs = useMemo(
    () => Array.from(saveStates.values()).some((state) => state !== 'saved'),
    [saveStates],
  );
  useEffect(() => {
    setWindowDirty(windowId, hasUnsavedTabs);
  }, [hasUnsavedTabs, windowId]);
  useEffect(() => () => setWindowDirty(windowId, false), [windowId]);

  useLayoutEffect(() => {
    let observer: MutationObserver | null = null;
    const findTarget = (): HTMLElement | null => {
      const target = Array.from(document.querySelectorAll<HTMLElement>('[data-wb-titlebar-slot]'))
        .find((element) => element.dataset.windowId === windowId) ?? null;
      setTitlebarTarget((current) => current === target ? current : target);
      if (target) observer?.disconnect();
      return target;
    };
    if (!findTarget()) {
      observer = new MutationObserver(findTarget);
      // 观察范围收窄到本窗口壳：slot 只出现在自己的窗壳内，观察整个 body
      // 会让桌面任何 DOM 变动都触发全页 querySelectorAll
      const shell = document.querySelector<HTMLElement>(
        `[data-wb-window-id="${typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(windowId) : windowId}"]`,
      );
      observer.observe(shell ?? document.body, { childList: true, subtree: true });
    }
  return () => observer?.disconnect();
  }, [windowId]);

  const updateTabSaveState = useCallback((key: string, state: SaveState) => {
    setTabSaveStates((current) => current[key] === state ? current : { ...current, [key]: state });
  }, []);

  const loadResources = useCallback(async (options?: { blocking?: boolean }) => {
    const requiresInitialLoad = !hasLoadedResourcesRef.current;
    const blocking = options?.blocking ?? requiresInitialLoad;
    const requestSequence = ++loadSequenceRef.current;
    if (blocking) {
      setLoading(true);
      setLoadError(null);
    }

    try {
      const foldersRequest = folderApi?.listFolders?.() ?? Promise.resolve(null);
      const folderTreeRequest = folderApi?.getFolderTree?.() ?? Promise.resolve(null);
      const [notesResult, mindmapsResult, foldersResult, folderTreeResult] = await Promise.all([
        listWorkspaceResources('note'),
        listWorkspaceResources('mindmap'),
        foldersRequest,
        folderTreeRequest,
      ]);
      if (requestSequence !== loadSequenceRef.current) return;

      const reportLoadFailure = (message: string) => {
        if (blocking || !hasLoadedResourcesRef.current) setLoadError(message);
        setStatus(message);
        setLoading(false);
      };
      if (!notesResult.ok) {
        reportLoadFailure(notesResult.error.toUserMessage());
        return;
      }
      if (!mindmapsResult.ok) {
        reportLoadFailure(mindmapsResult.error.toUserMessage());
        return;
      }

      const byId = new Map<string, DstuNode>();
      for (const node of [...notesResult.nodes, ...mindmapsResult.nodes]) {
        if (resourceType(node.type)) byId.set(node.id, node);
      }
      const nextResources = [...byId.values()];
      // 命中上限（或后续分页失败）时明确告知，不再静默丢文件；同一截断态只提示一次
      const truncated = notesResult.truncated || mindmapsResult.truncated;
      if (truncated && !truncationNotifiedRef.current) {
        truncationNotifiedRef.current = true;
        showGlobalNotification('warning', t('notesWorkspace.tree.truncated', {
          defaultValue: '文件数量超过 {{max}} 上限，文件树仅显示部分内容',
          max: RESOURCE_LIST_MAX_TOTAL,
        }));
      } else if (!truncated) {
        truncationNotifiedRef.current = false;
      }
      const nextFolders = foldersResult?.ok ? foldersResult.value : [];
      const nextResourceFolderIds = folderTreeResult?.ok
        ? getFolderMembership(folderTreeResult.value)
        : EMPTY_RESOURCE_FOLDER_IDS;
      const hadLoadedBefore = hasLoadedResourcesRef.current;
      const syncHydrationPending = syncHydrationPendingRef.current;
      syncHydrationPendingRef.current = false;
      const previousUpdatedAt = resourceUpdatedAtRef.current;
      const shouldReloadPaneTab = (tab: WorkspaceTab | null): boolean => {
        if (!tab || !byId.has(tab.id)) return false;
        if (getTabSaveState(tab, windowId) !== 'saved') return false;
        if (syncHydrationPending) return true;
        if (!hadLoadedBefore) return false;
        const prevTs = previousUpdatedAt.get(tab.id);
        const nextTs = byId.get(tab.id)?.updatedAt ?? 0;
        return prevTs === undefined || nextTs > prevTs;
      };
      const reloadMain = shouldReloadPaneTab(mainActiveTabRef.current);
      const reloadRight = shouldReloadPaneTab(splitTabRef.current);

      const nextUpdatedAt = new Map<string, number>();
      for (const node of nextResources) {
        nextUpdatedAt.set(node.id, node.updatedAt ?? 0);
      }
      resourceUpdatedAtRef.current = nextUpdatedAt;

      hasLoadedResourcesRef.current = true;
      setResources(nextResources);
      setFolders(nextFolders);
      setResourceFolderIds(nextResourceFolderIds);
      setSelectedFolderId((current) => (
        current && nextFolders.some((folder) => folder.id === current) ? current : null
      ));
      setTabs((current) => reconcileTabsWithResources(current, byId));
      if (reloadMain || reloadRight) {
        setPaneReloadNonce((current) => ({
          main: reloadMain ? current.main + 1 : current.main,
          right: reloadRight ? current.right + 1 : current.right,
        }));
      }
      setLoadError(null);
      setStatus(t('notesWorkspace.status.fileCount', { defaultValue: '{{count}} files', count: nextResources.length }));
      setLoading(false);
      if (
        pendingStageHydrationRef.current &&
        tabsRef.current.length === 0 &&
        !initialRef.current &&
        nextResources.length > 0
      ) {
        const req = pendingStageHydrationRef.current;
        pendingStageHydrationRef.current = null;
        const sorted = [...nextResources].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        const inFolder = req.rootFolderId
          ? sorted.filter((n) => {
              const fid = nextResourceFolderIds.get(treeResourceKey(resourceType(n.type) ?? 'note', n.id));
              return fid === req.rootFolderId;
            })
          : [];
        const pool = inFolder.length > 0 ? inFolder : sorted;
        const correctionRegex = /错题|订正|复盘|mistake|review|error/i;
        const candidate =
          (req.preferCorrectionNotes
            ? pool.find((n) => resourceType(n.type) === 'note' && correctionRegex.test(n.name))
            : undefined) ??
          pool.find((n) => resourceType(n.type) === req.preferredType) ??
          pool[0];
        const cType = candidate ? resourceType(candidate.type) : null;
        if (candidate && cType) {
          void openResourceRef.current({ type: cType, id: candidate.id }, candidate.name);
        }
      }
    } catch (error) {
      if (requestSequence !== loadSequenceRef.current) return;
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : t('notesWorkspace.tree.loadFailed', 'Could not load files');
      if (blocking || !hasLoadedResourcesRef.current) setLoadError(message);
      setStatus(message);
      setLoading(false);
    }
  }, [t, windowId]);

  useEffect(() => {
    void favorites.refresh();
  }, [favorites.refresh]);

  const queueResourceRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void loadResources({ blocking: false });
    }, 140);
  }, [loadResources]);

  const activateTab = useCallback((key: string) => {
    if (!tabsRef.current.some((tab) => tab.key === key)) return;
    restoreTabContextFocusRef.current = false;
    setTabContextMenu(null);
    if (rightTabKeyRef.current === key) {
      focusedPaneRef.current = 'right';
      setFocusedPane('right');
    } else {
      focusedPaneRef.current = 'main';
      setFocusedPane('main');
      setActiveTabKey(key);
    }
    const tab = tabsRef.current.find((item) => item.key === key);
    if (tab) {
      navHistory.push({ key: tab.key, type: tab.type, id: tab.id });
    }
  }, [navHistory]);

  const openResource = useCallback((rawRef: NotesWorkspaceResourceRef, title?: string) => {
    const ref = normalizeWorkspaceResourceRef(rawRef);
    if (!ref) return Promise.resolve();
    setHasInteractiveTabOpen(true);
    const key = `${ref.type}:${ref.id}`;
    setTabs((current) => {
      if (current.some((tab) => tab.type === ref.type && tab.id === ref.id)) return current;
      const node = resourcesRef.current.find((item) => item.id === ref.id);
      return [...current, {
        ...ref,
        key,
        title: title ?? node?.name ?? t(
          ref.type === 'note' ? 'notesWorkspace.untitledNote' : 'notesWorkspace.untitledMindmap',
          ref.type === 'note' ? 'Untitled note' : 'Untitled mind map',
        ),
      }];
    });
    if (rightTabKeyRef.current === key) {
      focusedPaneRef.current = 'right';
      setFocusedPane('right');
    } else {
      focusedPaneRef.current = 'main';
      setFocusedPane('main');
      setActiveTabKey(key);
    }
    navHistory.push({ key, type: ref.type, id: ref.id });
    return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }, [navHistory, t]);

  const activateHistoryEntry = useCallback(async (entry: NotesNavHistoryEntry) => {
    const exists = tabsRef.current.some((tab) => tab.key === entry.key)
      || resourcesRef.current.some((node) => node.id === entry.id && node.type === entry.type);
    if (!exists) {
      navHistory.prune(entry.key);
      return;
    }
    await openResource({ type: entry.type, id: entry.id });
  }, [navHistory, openResource]);

  const openTabInRightSplit = useCallback((key: string) => {
    const currentTabs = tabsRef.current;
    if (!currentTabs.some((tab) => tab.key === key)) return;
    if (currentTabs.length < 2) {
      setStatus(t('notesWorkspace.status.splitNeedsAnotherTab', 'Open another tab to split the workspace.'));
      return;
    }
    const priorRightKey = rightTabKeyRef.current;
    rightTabKeyRef.current = key;
    focusedPaneRef.current = 'right';
    setRightTabKey(key);
    setFocusedPane('right');
    setActiveTabKey((current) => resolveRightSplitMainTabKey(currentTabs, key, priorRightKey, current));
  }, [t]);

  const closeRightSplit = useCallback(() => {
    const currentRightKey = rightTabKeyRef.current;
    if (!currentRightKey) return;
    rightTabKeyRef.current = null;
    focusedPaneRef.current = 'main';
    setRightTabKey(null);
    setFocusedPane('main');
    setActiveTabKey(currentRightKey);
  }, []);

  const toggleTabRightSplit = useCallback((key: string) => {
    if (rightTabKeyRef.current === key) closeRightSplit();
    else openTabInRightSplit(key);
  }, [closeRightSplit, openTabInRightSplit]);

  const closeTab = useCallback(async (key: string, options: CloseTabOptions = {}) => {
    const currentTab = tabsRef.current.find((tab) => tab.key === key);
    if (!currentTab) return false;
    const saveState = getTabSaveState(currentTab, windowId);
    if (saveState !== 'saved' && !options.force) {
      // Repeated Ctrl/Cmd+W presses should not enqueue duplicate discard prompts.
      if (pendingTabCloseKeysRef.current.has(key)) return false;
      pendingTabCloseKeysRef.current.add(key);
      try {
        // C15：复用与 Learning Hub 相同的三态保存关闭协议，而不是只问“是否丢弃”。
        const offerSave = hasContentSaveHandler(currentTab.type, currentTab.id);
        const decision = await requestContentCloseDecision({
          description: t(
            saveState === 'saving'
              ? 'notesWorkspace.confirmCloseSaving'
              : 'notesWorkspace.confirmCloseUnsaved',
            saveState === 'saving'
              ? 'This tab is still saving. Close it anyway?'
              : 'This tab has unsaved changes. Close it anyway?',
          ),
          offerSave,
        });
        if (decision === 'cancel') return false;
        if (decision === 'save') {
          const saved = await saveContentNow(currentTab.type, currentTab.id);
          if (!saved) {
            showGlobalNotification(
              'error',
              t('content.saveAndCloseFailed', { defaultValue: '保存失败，已保留窗口与草稿。' }),
            );
            return false;
          }
        }
      } catch {
        // A failed confirmation surface must never discard a tab implicitly.
        return false;
      } finally {
        pendingTabCloseKeysRef.current.delete(key);
      }
    }
    const tabToClose = tabsRef.current.find((tab) => tab.key === key);
    if (!tabToClose) return false;
    forgetWorkspaceResource({ type: tabToClose.type, id: tabToClose.id }, windowId);
    const closingRightKey = rightTabKeyRef.current;
    const shouldCloseSplit = shouldCloseRightSplitOnTabClose(tabsRef.current, key, closingRightKey);
    if (shouldCloseSplit) {
      rightTabKeyRef.current = null;
      setRightTabKey(null);
    }
    setTabs((current) => {
      const nextState = computeTabCloseNextState(current, key, closingRightKey, shouldCloseSplit);
      if (!nextState) return current;
      setActiveTabKey((active) => (
        active && active !== key && nextState.nextMainTabs.some((tab) => tab.key === active)
          ? active
          : nextState.neighborKey
      ));
      setFocusedPane((currentPane) => {
        const nextPane: WorkspacePaneId = shouldCloseSplit
          ? 'main'
          : currentPane === 'main' && nextState.nextMainTabs.length === 0 && nextState.nextRightKey
            ? 'right'
            : currentPane;
        focusedPaneRef.current = nextPane;
        return nextPane;
      });
      return nextState.nextTabs;
    });
    setTabSaveStates((current) => {
      if (!(key in current)) return current;
      const { [key]: _removed, ...next } = current;
      return next;
    });
    return true;
  }, [t, windowId]);
  closeTabRef.current = closeTab;
  openResourceRef.current = openResource;

  const updateTabTitle = useCallback((key: string, title: string) => {
    if (!title.trim()) return;
    setTabs((current) => {
      const tab = current.find((item) => item.key === key);
      if (!tab || tab.title === title) return current;
      return current.map((item) => item.key === key ? { ...item, title } : item);
    });
  }, []);

  const reorderTabs = useCallback((draggedKey: string, targetKey: string, position: TabDropPosition) => {
    if (draggedKey === targetKey) return;
    setTabs((current) => reorderWorkspaceTabs(current, draggedKey, targetKey, position));
  }, []);

  const toggleTabPinned = useCallback((key: string) => {
    setTabs((current) => {
      const tab = current.find((item) => item.key === key);
      if (!tab) return current;
      return current.map((item) => item.key === key ? { ...item, pinned: !item.pinned } : item);
    });
  }, []);

  const closeTabs = useCallback(async (keys: readonly string[]) => {
    for (const key of keys) {
      const closed = await closeTabRef.current(key);
      if (!closed) break;
    }
  }, []);

  const closeOtherTabs = useCallback((key: string) => {
    const keys = tabsRef.current
      .filter((tab) => tab.key !== key && !tab.pinned)
      .map((tab) => tab.key);
    void closeTabs(keys);
  }, [closeTabs]);

  const closeTabsToRight = useCallback((key: string) => {
    const index = tabsRef.current.findIndex((tab) => tab.key === key);
    if (index < 0) return;
    const keys = tabsRef.current
      .slice(index + 1)
      .filter((tab) => !tab.pinned)
      .map((tab) => tab.key);
    void closeTabs(keys);
  }, [closeTabs]);

  const notifyMovedToTrash = useCallback((id: string, itemType: string, name: string) => {
    const movedMessage = t('notesWorkspace.status.movedToTrash', {
      defaultValue: '{{name}} moved to trash',
      name,
    });
    setStatus(movedMessage);
    showGlobalNotification('success', movedMessage, undefined, {
      action: {
        label: t('notesWorkspace.actions.undo', 'Undo'),
        onClick: () => {
          void (async () => {
            const restored = await trashApi.restoreItem(id, itemType);
            if (!restored.ok) {
              showGlobalNotification('error', restored.error.toUserMessage());
              return;
            }
            const restoredMessage = t('notesWorkspace.status.restored', {
              defaultValue: '{{name}} restored',
              name,
            });
            setStatus(restoredMessage);
            showGlobalNotification('success', restoredMessage);
            await loadResources({ blocking: false });
          })();
        },
      },
    });
  }, [loadResources, t]);

  const deleteContextResource = useCallback(async () => {
    if (dialogBusyRef.current) return;
    if (!resourceDialog || resourceDialog.mode !== 'delete') return;
    const target = resourceDialog.target;
    dialogBusyRef.current = true;
    setDialogBusy(true);
    try {
      if (target.kind === 'resource') {
        const key = `${target.node.type}:${target.node.id}`;
        // dstu.delete can notify the global resource-sync listener before its
        // promise resolves. Mark this user-confirmed deletion first so that
        // listener cannot enqueue a redundant dirty-tab confirmation.
        pendingConfirmedDeletionKeysRef.current.add(key);
        try {
          const result = await dstu.delete(target.node.path || `/${target.node.id}`);
          if (!result.ok) {
            const message = result.error.toUserMessage();
            setStatus(message);
            setDialogError(message);
            return;
          }
          // The user already confirmed moving this resource to the trash. Do not
          // ask a second discard question or retain a tab for a deleted resource.
          await closeTab(key, { force: true });
          notifyMovedToTrash(target.node.id, target.node.type, target.node.name);
        } finally {
          pendingConfirmedDeletionKeysRef.current.delete(key);
        }
      } else {
        const result = await folderApi.deleteFolder(target.id);
        if (!result.ok) {
          const message = result.error.toUserMessage();
          setStatus(message);
          setDialogError(message);
          return;
        }
        notifyMovedToTrash(target.id, 'folder', target.name);
      }
      setResourceDialog(null);
      await loadResources({ blocking: false });
    } finally {
      dialogBusyRef.current = false;
      setDialogBusy(false);
    }
  }, [closeTab, loadResources, notifyMovedToTrash, resourceDialog]);

  // 多选批量删除：一次内联确认，逐项移入回收站，失败逐项上报
  const deleteContextResources = useCallback(async () => {
    if (dialogBusyRef.current) return;
    if (!resourceDialog || resourceDialog.mode !== 'delete-many') return;
    const targets = resourceDialog.targets;
    dialogBusyRef.current = true;
    setDialogBusy(true);
    try {
      let failed = 0;
      let lastError: string | null = null;
      for (const target of targets) {
        if (target.kind === 'resource') {
          const key = `${target.node.type}:${target.node.id}`;
          pendingConfirmedDeletionKeysRef.current.add(key);
          try {
            const result = await dstu.delete(target.node.path || `/${target.node.id}`);
            if (!result.ok) {
              failed += 1;
              lastError = result.error.toUserMessage();
              continue;
            }
            await closeTab(key, { force: true });
          } finally {
            pendingConfirmedDeletionKeysRef.current.delete(key);
          }
        } else {
          const result = await folderApi.deleteFolder(target.id);
          if (!result.ok) {
            failed += 1;
            lastError = result.error.toUserMessage();
          }
        }
      }
      setResourceDialog(null);
      const succeeded = targets.length - failed;
      if (succeeded > 0) {
        const message = t('notesWorkspace.status.movedManyToTrash', {
          defaultValue: '{{count}} items moved to trash',
          count: succeeded,
        });
        setStatus(message);
        showGlobalNotification('success', message);
      }
      if (failed > 0 && lastError) {
        setStatus(lastError);
        showGlobalNotification('error', lastError);
      }
      await loadResources({ blocking: false });
    } finally {
      dialogBusyRef.current = false;
      setDialogBusy(false);
    }
  }, [closeTab, loadResources, resourceDialog, t]);

  const createFolder = useCallback(async () => {
    if (dialogBusyRef.current) return;
    if (!resourceDialog || resourceDialog.mode !== 'create-folder') return;
    const name = resourceDialog.value.trim();
    if (!name) {
      setDialogError(t('notesWorkspace.dialog.nameRequired', 'Enter a name.'));
      return;
    }
    // 前置校验（输入侧已 sanitize，这里是提交前最终防线；后端 InvalidArgument 仍兜底）
    const violation = validateNoteTitle(name);
    if (violation === 'too_long') {
      setDialogError(t('notesWorkspace.validation.nameTooLong', {
        defaultValue: 'Names can be at most {{max}} characters',
        max: NOTE_TITLE_MAX_CHARS,
      }));
      return;
    }
    if (violation === 'control_chars') {
      setDialogError(t('notesWorkspace.validation.nameInvalidChars', 'Names can\'t contain line breaks or control characters'));
      return;
    }
    dialogBusyRef.current = true;
    setDialogBusy(true);
    try {
      const result = await folderApi.createFolder(name, resourceDialog.parentId ?? undefined);
      if (!result.ok) {
        const message = result.error.toUserMessage();
        setStatus(message);
        setDialogError(message);
        return;
      }
      setSelectedFolderId(result.value.id);
      setDialogError(null);
      setResourceDialog(null);
      await loadResources({ blocking: false });
    } finally {
      dialogBusyRef.current = false;
      setDialogBusy(false);
    }
  }, [loadResources, resourceDialog, t]);

  const createResource = useCallback(async (type: ResourceType, folderId?: string | null) => {
    setStatus(t(
      type === 'note' ? 'notesWorkspace.status.creatingNote' : 'notesWorkspace.status.creatingMindmap',
      type === 'note' ? 'Creating note...' : 'Creating mind map...',
    ));
    const targetFolderId = folderId === undefined ? contextualFolderId : folderId;
    const result = await createEmpty({ type, folderId: targetFolderId ?? undefined });
    if (!result.ok) {
      setStatus(result.error.toUserMessage());
      return;
    }
    await loadResources({ blocking: false });
    await openResource({ type, id: result.value.id }, result.value.name);
  }, [contextualFolderId, loadResources, openResource, t]);

  const createFromUnresolved = useCallback(async (title: string) => {
    const trimmed = title.trim();
    if (!trimmed) return;
    setStatus(t('notesWorkspace.status.creatingNote', 'Creating note...'));
    const result = await createEmpty({
      type: 'note',
      name: trimmed,
      folderId: contextualFolderId ?? undefined,
    });
    if (!result.ok) {
      setStatus(result.error.toUserMessage());
      throw new Error(result.error.toUserMessage());
    }
    await loadResources({ blocking: false });
    await openResource({ type: 'note', id: result.value.id }, trimmed);
  }, [contextualFolderId, loadResources, openResource, t]);

  useEffect(() => {
    if (!isActive) return;
    return setWikilinkCreateContext({
      folderId: contextualFolderId,
      onCreated: async (noteId, title) => {
        await loadResources({ blocking: false });
        await openResource({ type: 'note', id: noteId }, title);
      },
    });
  }, [contextualFolderId, isActive, loadResources, openResource]);

  useEffect(() => {
    onTitleChange(t('notesWorkspace.title', 'Notes'));
    void loadResources({ blocking: true });
    const unwatch = dstu.watch('*', (event) => {
      const changedNode = event.node;
      if (event.type === 'deleted' || event.type === 'purged') {
        const deletedId = changedNode?.id ?? event.path.replace(/^\/(?:_trash\/)?/, '');
        if (deletedId) {
          setResources((current) => current.filter((node) => node.id !== deletedId));
        }
        queueResourceRefresh();
        return;
      }
      if (event.type === 'updated' && changedNode && resourceType(changedNode.type)) {
        const known = resourcesRef.current.find((node) => node.id === changedNode.id);
        if (known && changedNode.updatedAt < known.updatedAt) return;
        resourceUpdatedAtRef.current.set(changedNode.id, changedNode.updatedAt ?? 0);
        setResources((current) => mergeUpdatedResourceNode(current, changedNode));
        updateTabTitle(`${changedNode.type}:${changedNode.id}`, changedNode.name);
        return;
      }
      queueResourceRefresh();
    });
  return () => {
      unwatch();
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [loadResources, onTitleChange, queueResourceRefresh, t, updateTabTitle]);

  const onFolderChange = useCallback(() => {
    // Folder mutations do not travel through dstu.watch(). Reuse the silent,
    // debounced refresh path so external moves/renames preserve the tree UI.
    queueResourceRefresh();
  }, [queueResourceRefresh]);
  const triggerSyncHydration = useCallback(() => {
    syncHydrationPendingRef.current = true;
    void loadResources({ blocking: false });
  }, [loadResources]);
  const onSyncProgressWindowEvent = useCallback((event: Event) => {
    const detail = (event as CustomEvent<{ phase?: string; outcome?: string | null }>).detail;
    if (detail?.phase === 'completed' || detail?.outcome === 'completed') {
      triggerSyncHydration();
    }
  }, [triggerSyncHydration]);
  useEventRegistry(
    [
      { target: 'window', type: DSTU_FOLDER_CHANGE_EVENT, listener: onFolderChange },
      { target: 'window', type: 'data-governance:local-change', listener: triggerSyncHydration },
      { target: 'window', type: 'data-governance-sync-progress', listener: onSyncProgressWindowEvent },
    ],
    [onFolderChange, onSyncProgressWindowEvent, triggerSyncHydration],
  );

  // S5-02: Listen to backend sync completion events so notes/resources hydrated
  // by pairing or bidirectional sync refresh both the file tree and open clean tabs.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void import('@tauri-apps/api/event')
      .then(({ listen }) => listen<{ phase?: string; outcome?: string | null }>(
        'data-governance-sync-progress',
        (event) => {
          const payload = event.payload;
          if (payload?.phase === 'completed' || payload?.outcome === 'completed') {
            triggerSyncHydration();
          }
        },
      ))
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => undefined);
  return () => {
      disposed = true;
      unlisten?.();
    };
  }, [triggerSyncHydration]);

  // S5-02: Never mount editors inside a background `content-visibility: hidden`
  // shell before first visibility, and re-hydrate clean tabs when waking from background.
  useEffect(() => {
    const wasVisible = wasPaneVisibleRef.current;
    wasPaneVisibleRef.current = paneVisible;
    if (!paneVisible) return;
    if (!hasBeenVisible) {
      setHasBeenVisible(true);
      if (hasLoadedResourcesRef.current) {
        void loadResources({ blocking: false });
      }
      return;
    }
    if (!wasVisible) {
      triggerSyncHydration();
    }
  }, [hasBeenVisible, loadResources, paneVisible, triggerSyncHydration]);

  useEffect(() => {
    const initial = initialRef.current;
    if (!initial) return;
    initialRef.current = null;
    void openResource(initial);
  }, [openResource]);

  // Keep the two panes coherent after a resource deletion or a restored
  // workspace. The right-side tab is never a valid main-pane selection.
  useEffect(() => {
    const { validRightKey, validActiveKey, validFocusedPane } = resolveCoherentPaneState(
      tabs,
      activeTabKey,
      rightTabKey,
      focusedPane,
    );
    if (validRightKey !== rightTabKey) setRightTabKey(validRightKey);
    if (validActiveKey !== activeTabKey) setActiveTabKey(validActiveKey);
    if (validFocusedPane !== focusedPane) setFocusedPane(validFocusedPane);
  }, [activeTabKey, focusedPane, rightTabKey, tabs]);

  useEffect(() => registerWorkspaceHost(windowId, {
    openResource: (ref) => openResourceRef.current(ref),
    closeResource: (ref) => {
      const tab = tabsRef.current.find((item) => item.type === ref.type && item.id === ref.id);
      if (tab) {
        void closeTabRef.current(tab.key, {
          force: pendingConfirmedDeletionKeysRef.current.has(tab.key),
        });
      }
    },
    hasUnsavedChanges: () => tabsRef.current.some(
      (tab) => getTabSaveState(tab, windowId) !== 'saved',
    ),
    getActiveResource: () => {
      const current = activeTabRef.current;
      return current ? { type: current.type, id: current.id } : null;
    },
    listResources: () => tabsRef.current.map((tab) => ({ type: tab.type, id: tab.id })),
    listResourceDetails: () => tabsRef.current.map((tab) => ({
      type: tab.type,
      id: tab.id,
      title: tab.title,
      saveState: tabSaveStatesRef.current[tab.key] ?? getTabSaveState(tab, windowId),
    })),
  }), [windowId]);

  useEffect(() => {
    setWorkspaceActiveResource(windowId, activeTab ? { type: activeTab.type, id: activeTab.id } : null);
  }, [activeTab, windowId]);

  useEffect(() => {
    writePersistedWorkspaceState({
      tabs,
      activeTabKey: mainActiveTab?.key ?? null,
      rightTabKey: splitTab?.key ?? null,
      focusedPane: resolvedFocusedPane,
      splitLayout,
      backlinksOpen,
      // compact 档 explorerOpen 是「文件」子屏开关，持久化写宽/中窗折叠偏好
      explorerOpen: sizeClassRef.current === 'compact' ? explorerBeforeCompactRef.current : explorerOpen,
      collapsedFolderPaths: [...collapsedFolderPaths].sort(),
    });
  }, [backlinksOpen, collapsedFolderPaths, explorerOpen, mainActiveTab?.key, resolvedFocusedPane, splitLayout, splitTab?.key, tabs]);

  const handleSplitLayout = useCallback((layout: number[]) => {
    if (!splitTab || layout.length !== 2) return;
    // compact 分屏锁定 50/50（无手柄不可拖），不把该布局写回持久化，避免覆盖桌面拖拽比例
    if (sizeClassRef.current === 'compact') return;
    const nextLayout = parseSplitLayout(layout);
    setSplitLayout((current) => (
      current[0] === nextLayout[0] && current[1] === nextLayout[1]
        ? current
        : nextLayout
    ));
  }, [splitTab]);

  useLayoutEffect(() => {
    if (!splitTab) return;
    const frame = window.requestAnimationFrame(() => {
      const group = paneGroupRef.current;
      // compact 锁定默认布局（对照 VerticalResizable fixed：断点切换不继承桌面拖拽残留比例）
      if (group?.getLayout().length === 2) {
        group.setLayout(sizeClass === 'compact' ? DEFAULT_SPLIT_LAYOUT : splitLayoutRef.current);
      }
    });
  return () => window.cancelAnimationFrame(frame);
  }, [splitTab?.key, sizeClass]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setWorkspaceWidth(width);
      const nextSizeClass = classifyWbSysWidth(width);
      const prevSizeClass = sizeClassRef.current;
      setSizeClass(nextSizeClass);
      if (nextSizeClass === 'compact' && prevSizeClass !== 'compact') {
        // 进窄窗：暂存宽/中窗折叠偏好；「文件」子屏一律从关闭开始
        explorerBeforeCompactRef.current = explorerOpenRef.current;
        setExplorerOpen(false);
      } else if (nextSizeClass !== 'compact' && prevSizeClass === 'compact') {
        // 回宽/中窗：还原进窄窗前的侧栏折叠偏好
        setExplorerOpen(explorerBeforeCompactRef.current);
      }
    });
    observer.observe(host);
  return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (sizeClass !== 'compact') return;
    if (explorerOpen && backlinksOpen) setExplorerOpen(false);
  }, [backlinksOpen, sizeClass, explorerOpen]);

  // 窄窗「文件」内联子屏打开时接管 Android 返回键：先关子屏，不关笔记窗口
  useEffect(() => {
    if (sizeClass !== 'compact' || !explorerOpen) return;
    return registerBackHandler(() => {
      // 保活守卫：隐藏工作台里的笔记窗口仍保持挂载，explorer 打开态也随之滞留——
      // 此时不消费返回键、不误关 explorer，交还给当前活跃视图
      const el = hostRef.current;
      if (!el || !el.isConnected || el.getClientRects().length === 0) return false;
      if (window.getComputedStyle(el).visibility === 'hidden') return false;
      setExplorerOpen(false);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [explorerOpen, sizeClass]);

  const onFocusModeChanged = useCallback((event: Event) => {
    const nextOwners = updateFocusModeOwners(
      focusModeOwnersRef.current,
      (event as CustomEvent<NotesFocusModeEventDetail>).detail,
      windowId,
    );
    focusModeOwnersRef.current = nextOwners;
    setFocusMode(nextOwners.size > 0);
  }, [windowId]);
  useEventRegistry(
    [{ target: 'window', type: 'notes:focus-mode-changed', listener: onFocusModeChanged }],
    [onFocusModeChanged],
  );
  useEffect(() => () => {
    // 读 ref 的最新值：onFocusModeChanged 会整体替换 Set，清理必须落在当前实例上
    focusModeOwnersRef.current.clear();
  }, [windowId]);

  const dismissTabContextMenu = useCallback((event: Event) => {
    if (event.target instanceof Node && contextMenuRef.current?.contains(event.target)) return;
    restoreTabContextFocusRef.current = event instanceof KeyboardEvent && event.key === 'Escape';
    setTabContextMenu(null);
  }, []);
  const dismissTabContextMenuOnEscape = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') dismissTabContextMenu(event);
  }, [dismissTabContextMenu]);
  // Tabs stop bubbling pointer events so the window shell cannot start a
  // drag. Use capture here to still dismiss a stale menu before another tab
  // is selected or dragged, while retaining clicks inside the menu itself.
  useEventRegistry(tabContextMenu ? [
    { target: 'window', type: 'pointerdown', listener: dismissTabContextMenu, options: true },
    { target: 'window', type: 'click', listener: dismissTabContextMenu, options: true },
    { target: 'window', type: 'keydown', listener: dismissTabContextMenuOnEscape },
  ] : [], [dismissTabContextMenu, dismissTabContextMenuOnEscape, tabContextMenu]);

  useEffect(() => {
    if (!tabContextMenu) return;
    const trigger = tabContextTriggerRef.current;
    const menu = contextMenuRef.current;
    const frame = window.requestAnimationFrame(() => {
      menu?.querySelector<HTMLElement>('[role="menuitemcheckbox"]')?.focus();
    });
  return () => {
      window.cancelAnimationFrame(frame);
      if (restoreTabContextFocusRef.current && trigger?.isConnected) trigger.focus();
      restoreTabContextFocusRef.current = false;
      if (tabContextTriggerRef.current === trigger) tabContextTriggerRef.current = null;
    };
  }, [tabContextMenu]);

  const onCloseTabShortcut = useCallback((event: Event) => {
    if (!(event instanceof KeyboardEvent) || !isCloseTabShortcut(event)) return;
    // The workspace owns Ctrl/Cmd+W even before a tab is opened. Without
    // this, the browser/WebView default can close the entire application.
    event.preventDefault();
    const current = activeTabRef.current;
    if (current) void closeTabRef.current(current.key);
  }, []);
  useEventRegistry(
    isActive ? [{ target: 'window', type: 'keydown', listener: onCloseTabShortcut }] : [],
    [isActive, onCloseTabShortcut],
  );

  const focusExplorerSearch = useCallback(() => {
    setExplorerOpen(true);
    window.setTimeout(() => hostRef.current?.querySelector<HTMLInputElement>('.notes-search-input')?.focus(), 0);
  }, []);

  const openSearchOverlay = useCallback((mode: NotesSearchMode) => {
    setSearchMode(mode);
    setSearchOpen(true);
  }, []);

  // cmd+P 空查询的「最近打开」分组：导航历史新→旧去重，映射到仍存在的资源
  const recentSearchResources = useMemo(
    () => getRecentSearchResources(navHistory.entries, resources),
    [navHistory.entries, resources],
  );
  // 空工作区欢迎页「继续最近学习」：优先会话访问历史，不足 4 条时按最近更新时间补齐
  const welcomeRecentResources = useMemo(
    () => getWelcomeRecentResources(recentSearchResources, resources),
    [recentSearchResources, resources],
  );

  const openWorkspaceSearchResult = useCallback(async (
    node: DstuNode,
    context?: { mode: NotesSearchMode; query: string },
  ) => {
    const type = resourceType(node.type);
    if (!type) return;
    await openResource({ type, id: node.id }, node.name);
    // 搜索可能从「文件」子屏进入：打开结果后一并收起子屏，直达编辑器
    if (sizeClassRef.current === 'compact') setExplorerOpen(false);
    if (type === 'note' && context?.mode === 'full-text' && context.query.trim()) {
      publishNotesFindQuery({ noteId: node.id, query: context.query });
    }
  }, [openResource]);

  const onWorkspaceCommand = useCallback((event: Event) => {
    const action = (event as CustomEvent<NotesWorkspaceCommandDetail>).detail?.action as NotesWorkspaceCommandAction | undefined;
    switch (action) {
      case 'create-note':
        void createResource('note');
        break;
      case 'create-folder':
        setDialogError(null);
        // 行内输入行挂在资源管理器树区顶部；窄窗下先展开「文件」子屏
        setExplorerOpen(true);
        setResourceDialog({ mode: 'create-folder', value: '', parentId: selectedFolderId });
        break;
      case 'focus-search':
        focusExplorerSearch();
        break;
      case 'quick-switch':
        openSearchOverlay('quick-open');
        break;
      case 'search-content':
        openSearchOverlay('full-text');
        break;
      case 'force-save':
        window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.NOTES_FORCE_SAVE));
        break;
      case 'toggle-sidebar':
        setExplorerOpen((open) => !open);
        break;
      case 'toggle-backlinks':
        if (backlinksStateRef.current.open && backlinksStateRef.current.tab === 'links') {
          backlinksStateRef.current.open = false;
          setBacklinksOpen(false);
          break;
        }
        backlinksStateRef.current = { open: true, tab: 'links' };
        setBacklinksRequestedTab((request) => ({
          tab: 'links',
          requestId: (request?.requestId ?? 0) + 1,
        }));
        setBacklinksOpen(true);
        break;
      case 'toggle-outline':
        if (backlinksStateRef.current.open && backlinksStateRef.current.tab === 'outline') {
          backlinksStateRef.current.open = false;
          setBacklinksOpen(false);
          break;
        }
        backlinksStateRef.current = { open: true, tab: 'outline' };
        setBacklinksRequestedTab((request) => ({
          tab: 'outline',
          requestId: (request?.requestId ?? 0) + 1,
        }));
        setBacklinksOpen(true);
        break;
      case 'export-current':
        if (activeTabRef.current) {
          void exportResourceById(
            activeTabRef.current.id,
            i18next.getFixedT(i18next.language, 'learningHub'),
            windowId,
          );
        }
        break;
      case 'export-library':
        setLibraryDialog({ open: true, tab: 'export' });
        break;
      case 'import-library':
        setLibraryDialog({ open: true, tab: 'import' });
        break;
      case 'insert-math':
        window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.NOTES_INSERT_MATH));
        break;
      case 'insert-table':
        window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.NOTES_INSERT_TABLE));
        break;
      case 'insert-codeblock':
        window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.NOTES_INSERT_CODEBLOCK));
        break;
      case 'insert-link':
        window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.NOTES_INSERT_LINK));
        break;
      case 'insert-image':
        window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.NOTES_INSERT_IMAGE));
        break;
      default:
        break;
    }
  }, [createResource, focusExplorerSearch, openSearchOverlay, selectedFolderId, windowId]);
  useEventRegistry(
    isActive
      ? [{ target: 'window', type: NOTES_WORKSPACE_COMMAND_EVENT, listener: onWorkspaceCommand }]
      : [],
    [isActive, onWorkspaceCommand],
  );

  // S4-11：响应学习流阶段预设（精读导图 / 笔记共创 / 刷题订正）的空面板材料注入，绝不抢占已有活动标签
  useEffect(() => {
    const hydrateFromStage = (
      preferredType: ResourceType,
      rootFolderId: string | null,
      preferCorrectionNotes = false,
    ) => {
      if (tabsRef.current.length > 0) return;
      if (!hasLoadedResourcesRef.current) {
        pendingStageHydrationRef.current = {
          preferredType,
          rootFolderId,
          preferCorrectionNotes,
        };
        return;
      }
      if (resourcesRef.current.length === 0) return;
      const sorted = [...resourcesRef.current].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
      const inFolder = rootFolderId
        ? sorted.filter((n) => {
            const fid = resourceFolderIds.get(treeResourceKey(resourceType(n.type) ?? 'note', n.id));
            return fid === rootFolderId;
          })
        : [];
      const pool = inFolder.length > 0 ? inFolder : sorted;
      const correctionRegex = /错题|订正|复盘|mistake|review|error/i;
      const candidate =
        (preferCorrectionNotes
          ? pool.find((n) => resourceType(n.type) === 'note' && correctionRegex.test(n.name))
          : undefined) ??
        pool.find((n) => resourceType(n.type) === preferredType) ??
        pool[0];
      const cType = candidate ? resourceType(candidate.type) : null;
      if (candidate && cType) {
        void openResourceRef.current({ type: cType, id: candidate.id }, candidate.name);
      }
    };

    const onPreferMindmap = (event: Event) => {
      const detail = (event as CustomEvent<{ rootFolderId?: string | null }>).detail;
      hydrateFromStage('mindmap', detail?.rootFolderId ?? null, false);
    };
    const onHydrateNotesStage = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          preferredType?: ResourceType;
          rootFolderId?: string | null;
          preferCorrectionNotes?: boolean;
        }>
      ).detail;
      hydrateFromStage(
        detail?.preferredType === 'mindmap' ? 'mindmap' : 'note',
        detail?.rootFolderId ?? null,
        Boolean(detail?.preferCorrectionNotes),
      );
    };

    window.addEventListener('workbench:prefer-mindmap-tab', onPreferMindmap);
    window.addEventListener('workbench:hydrate-notes-stage', onHydrateNotesStage);
  return () => {
      window.removeEventListener('workbench:prefer-mindmap-tab', onPreferMindmap);
      window.removeEventListener('workbench:hydrate-notes-stage', onHydrateNotesStage);
    };
  }, [resourceFolderIds]);

  const toggleTreeExpand = useCallback((id: string) => {
    const item = findItemById(treeItems, id);
    if (!item?.path || item.kind !== 'folder') return;
    setCollapsedFolderPaths((current) => {
      const next = new Set(current);
      if (next.has(item.path!)) next.delete(item.path!);
      else next.add(item.path!);
      return next;
    });
  }, [treeItems]);

  const expandTreeFolder = useCallback((id: string) => {
    const item = findItemById(treeItems, id);
    if (!item?.path || item.kind !== 'folder') return;
    setCollapsedFolderPaths((current) => {
      if (!current.has(item.path!)) return current;
      const next = new Set(current);
      next.delete(item.path!);
      return next;
    });
  }, [treeItems]);

  const selectTreeItem = useCallback((id: string | null) => {
    setSelectedTreeId(id);
    if (id === null) {
      setSelectedFolderId(null);
      return;
    }
    const item = findItemById(treeItems, id);
    if (item?.kind === 'folder' && isStableVfsFolderId(item.id)) {
      setSelectedFolderId(item.id);
    }
  }, [treeItems]);

  // 窄窗（compact）下「文件」以全屏内联子屏呈现：选中打开资源后自动收起，回到编辑器
  const closeExplorerIfCompact = useCallback(() => {
    if (sizeClassRef.current === 'compact') setExplorerOpen(false);
  }, []);

  // 布局抽屉回调仅在 compact 档代理「文件」子屏开关；离开 compact 时布局会
  // 强制回传 false（收抽屉残留），不能让它冲掉宽/中窗的侧栏折叠偏好
  const handleDrawerOpenChange = useCallback((open: boolean) => {
    if (sizeClassRef.current === 'compact') setExplorerOpen(open);
  }, []);

  const openTreeItem = useCallback((id: string) => {
    const item = findItemById(treeItems, id);
    if (!item || item.kind === 'folder') return;
    void openResource({ type: item.kind, id: item.id }, item.name);
    closeExplorerIfCompact();
  }, [closeExplorerIfCompact, openResource, treeItems]);

  const renameTreeItem = useCallback(async (id: string, newName: string) => {
    const item = findItemById(treeItems, id);
    if (!item || item.canRename === false) return;
    const name = newName.trim();
    if (!name || name === item.name) return;
    if (item.kind === 'folder') {
      if (!isStableVfsFolderId(item.id)) return;
      const result = await folderApi.renameFolder(item.id, name);
      if (!result.ok) {
        setStatus(result.error.toUserMessage());
        return;
      }
    } else {
      const node = resourcesRef.current.find((entry) => entry.id === item.id && entry.type === item.kind);
      const path = node?.path || `/${item.id}`;
      const previousName = (node?.name ?? item.name).trim();
      const result = await dstu.rename(path, name);
      if (!result.ok) {
        setStatus(result.error.toUserMessage());
        return;
      }
      updateTabTitle(`${item.kind}:${item.id}`, name);
      // 按旧标题写的 [[wikilink]] 会因重命名失解析：后台回写引用来源
      //（OCC 保护并发编辑；脏来源跳过），结果以通知汇总
      if (item.kind === 'note' && previousName && previousName !== name) {
        const knownNotes = resourcesRef.current
          .filter((entry) => entry.type === 'note')
          .map((entry) => ({
            id: entry.id,
            title: entry.id === item.id ? previousName : entry.name,
          }));
        void syncWikiLinksAfterNoteRename({
          noteId: item.id,
          oldTitle: previousName,
          newTitle: name,
          knownNotes,
        }).then((summary) => {
          // C14：把“无法扫描 / 扫描被截断”与“部分未同步”分别、诚实地告知，
          // 不能把本批成功表达成“全库引用均已同步”。
          if (summary.scanFailed) {
            showGlobalNotification('warning', t('notesWorkspace.renameSync.scanFailed', {
              defaultValue: '标题已更新，但未能扫描引用来源，双链可能未同步，请手动检查。',
            }));
            return;
          }
          if (summary.updatedSources > 0) {
            showGlobalNotification('success', t('notesWorkspace.renameSync.updated', {
              defaultValue: '已同步更新 {{count}} 篇笔记中的双链',
              count: summary.updatedSources,
            }));
            void loadResources({ blocking: false });
          }
          if (summary.skippedDirtySources > 0 || summary.failedSources > 0) {
            showGlobalNotification('warning', t('notesWorkspace.renameSync.incomplete', {
              defaultValue: '{{count}} 篇笔记中的双链未同步（有未保存修改或写回失败），请手动检查',
              count: summary.skippedDirtySources + summary.failedSources,
            }));
          }
          if (summary.truncated) {
            showGlobalNotification('warning', t('notesWorkspace.renameSync.truncated', {
              defaultValue: '引用来源超出单批上限，本批仅同步了前 {{count}} 篇，其余请稍后重新处理。',
              count: RENAME_SYNC_SOURCE_LIMIT,
            }));
          }
        });
      }
    }
    await loadResources({ blocking: false });
  }, [loadResources, t, treeItems, updateTabTitle]);

  const moveTreeItem = useCallback(async (
    dragId: string,
    targetId: string,
    position: NotesWorkspaceDropPosition,
  ) => {
    const dragItem = findItemById(treeItems, dragId);
    if (!dragItem || dragItem.canMove === false) return;
    const destination = resolveMoveDestinationFolderId(treeItems, targetId, position);
    if (destination === null) return;
    let result: Awaited<ReturnType<typeof folderApi.moveItem>>;
    if (dragItem.kind === 'folder') {
      if (!isStableVfsFolderId(dragItem.id)) return;
      result = await folderApi.moveFolder(dragItem.id, destination);
    } else {
      result = await folderApi.moveItem(dragItem.kind, dragItem.id, destination);
    }
    if (!result.ok) {
      setStatus(result.error.toUserMessage());
      return;
    }
    setSelectedFolderId(destination ?? null);
    await loadResources({ blocking: false });
  }, [loadResources, treeItems]);

  const requestDeleteTreeItems = useCallback((items: readonly NotesWorkspaceTreeItem[]) => {
    const targets = resolveExplorerDeleteTargets(items, resourcesRef.current);
    if (targets.length === 0) return;
    setDialogError(null);
    setResourceDialog(
      targets.length === 1
        ? { mode: 'delete', target: targets[0] }
        : { mode: 'delete-many', targets },
    );
  }, []);

  const requestDeleteTreeItem = useCallback((item: NotesWorkspaceTreeItem) => {
    requestDeleteTreeItems([item]);
  }, [requestDeleteTreeItems]);

  const openTabContextMenu = useCallback((key: string, x: number, _y: number, trigger: HTMLElement) => {
    restoreTabContextFocusRef.current = false;
    tabContextTriggerRef.current = trigger;
    // 菜单出现在标签下方（横向跟随指针），不盖住标签本身；视口限制在挂载后按实测尺寸做
    const tabBounds = trigger.getBoundingClientRect();
    setTabContextMenu({ key, x, y: tabBounds.bottom + 4 });
  }, []);

  // 按实测尺寸把标签页菜单限制在视口内
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!tabContextMenu || !menu) return;
    const rect = menu.getBoundingClientRect();
    const next = clampMenuPosition(
      tabContextMenu.x,
      tabContextMenu.y,
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (next.left !== tabContextMenu.x || next.top !== tabContextMenu.y) {
      setTabContextMenu((current) => (current ? { ...current, x: next.left, y: next.top } : current));
    }
  }, [tabContextMenu]);

  const handleWorkspaceKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (navHistory.handleKeyDown(event, activateHistoryEntry)) return;
  }, [activateHistoryEntry, navHistory]);

  // Ctrl+PageDown/PageUp 与 mod+shift+[ / ]：像浏览器 / VS Code 一样循环切换标签页
  const cycleTab = useCallback((direction: 1 | -1) => {
    const currentTabs = tabsRef.current;
    if (currentTabs.length < 2) return;
    const currentKey = activeTabRef.current?.key ?? null;
    const index = currentTabs.findIndex((tab) => tab.key === currentKey);
    const next = currentTabs[((index < 0 ? 0 : index) + direction + currentTabs.length) % currentTabs.length];
    if (next) activateTab(next.key);
  }, [activateTab]);

  const importDroppedMarkdown = useCallback(async (files: readonly File[]) => {
    const markdownFiles = files.filter((file) => isMarkdownFileName(file.name));
    if (markdownFiles.length === 0) return;
    let firstImported: DstuNode | null = null;
    let failed = 0;
    for (const file of markdownFiles) {
      try {
        const result = await notesDstuAdapter.importMarkdownContent(
          file.name,
          await file.text(),
          contextualFolderId,
        );
        if (result.ok) firstImported ??= result.value;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    await loadResources({ blocking: false });
    if (firstImported) await openResource({ type: 'note', id: firstImported.id }, firstImported.name);
    if (failed > 0) {
      showGlobalNotification('warning', t('notesWorkspace.import.partial', {
        defaultValue: '{{success}} imported, {{failed}} failed',
        success: markdownFiles.length - failed,
        failed,
      }));
    } else {
      showGlobalNotification('success', t('notesWorkspace.import.success', {
        defaultValue: 'Imported {{count}} notes',
        count: markdownFiles.length,
      }));
    }
  }, [contextualFolderId, loadResources, openResource, t]);

  const onWindowKeyDown = useCallback((event: Event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (navHistory.handleKeyDown(event, activateHistoryEntry)) return;
    const shortcut = matchWorkspaceWindowShortcut(event, searchOpen);
    if (!shortcut) return;
    event.preventDefault();
    event.stopPropagation();
    if (shortcut === 'quick-open') openSearchOverlay('quick-open');
    else cycleTab(shortcut === 'cycle-prev' ? -1 : 1);
  }, [activateHistoryEntry, cycleTab, navHistory, openSearchOverlay, searchOpen]);
  useEventRegistry(
    isActive ? [{ target: 'window', type: 'keydown', listener: onWindowKeyDown, options: true }] : [],
    [isActive, onWindowKeyDown],
  );

  // 资源管理器面板：宽/中窗作为并排侧栏；窄窗（compact）复用为全屏内联「文件」子屏（P0-5 去抽屉化）
  const explorerSurface = (
    <WorkspaceExplorer
      canNavBack={navHistory.canBack}
      canNavForward={navHistory.canForward}
      onNavBack={() => { void navHistory.runNavigation('back', activateHistoryEntry); }}
      onNavForward={() => { void navHistory.runNavigation('forward', activateHistoryEntry); }}
      query={query}
      onQueryChange={setQuery}
      selectedTags={selectedTags}
      onSelectedTagsChange={setSelectedTags}
      loading={loading}
      loadError={loadError}
      resourcesCount={resources.length}
      filteredResources={filteredResources}
      treeItems={treeItems}
      expandedIds={expandedIds}
      selectedTreeId={selectedTreeId}
      selectedFolderId={selectedFolderId}
      activeTabId={activeTab?.id ?? null}
      backlinksOpen={backlinksOpen}
      favorites={favorites}
      resourceDialog={resourceDialog}
      dialogError={dialogError}
      dialogBusy={dialogBusy}
      onResourceDialogChange={setResourceDialog}
      onDialogErrorChange={setDialogError}
      onCreateResource={(type, folderId) => { void createResource(type, folderId); }}
      onCreateFolderSubmit={() => { void createFolder(); }}
      onDeleteConfirm={() => { void deleteContextResource(); }}
      onDeleteManyConfirm={() => { void deleteContextResources(); }}
      onOpenLearningCreate={(folderId) => {
        if (folderId !== undefined) setLearningCreateFolderId(folderId);
        setLearningCreateOpen(true);
      }}
      onOpenFullTextSearch={() => openSearchOverlay('full-text')}
      onToggleBacklinks={() => setBacklinksOpen((open) => !open)}
      onOpenTrash={() => setTrashOpen(true)}
      onOpenLibrary={() => setLibraryDialog({ open: true, tab: 'export' })}
      onRetryLoad={() => { void loadResources({ blocking: true }); }}
      onOpenResource={openResource}
      onOpenTabInRightSplit={openTabInRightSplit}
      onOpenSearchResult={(node) => { void openWorkspaceSearchResult(node); }}
      onCloseExplorerIfCompact={closeExplorerIfCompact}
      onToggleTreeExpand={toggleTreeExpand}
      onExpandTreeFolder={expandTreeFolder}
      onSelectTreeItem={selectTreeItem}
      onOpenTreeItem={openTreeItem}
      onMoveTreeItem={(dragId, targetId, position) => { void moveTreeItem(dragId, targetId, position); }}
      onRenameTreeItem={(id, name) => { void renameTreeItem(id, name); }}
      onRequestDeleteTreeItem={requestDeleteTreeItem}
      onRequestDeleteTreeItems={requestDeleteTreeItems}
    />
  );

  const getNoteBreadcrumbs = useCallback(
    (noteId: string, title: string): readonly NoteBreadcrumbItem[] => {
      const trail = computeNoteBreadcrumbs(noteId, folders, resourceFolderIds, title);
      // 根目录下的单篇笔记无需多占一行面包屑，仅在嵌套文件夹内展示路径定向
      return trail.length > 1 ? trail : [];
    },
    [folders, resourceFolderIds],
  );

  const handleNoteBreadcrumbClick = useCallback(
    (item: NoteBreadcrumbItem) => {
      if (item.type !== 'folder') return;
      setQuery('');
      setSelectedTags([]);
      if (sizeClassRef.current === 'compact') setBacklinksOpen(false);
      setExplorerOpen(true);
      // 展开目标目录及其祖先目录（直接基于 folders 计算路径，清空过滤前即使 treeItems 尚未重建也能生效）
      const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
      const chainIds: string[] = [];
      const visited = new Set<string>();
      let cursor: string | null = item.id;
      while (cursor && !visited.has(cursor)) {
        visited.add(cursor);
        chainIds.unshift(cursor);
        cursor = foldersById.get(cursor)?.parentId ?? null;
      }
      const pathsToExpand = new Set<string>();
      let prefix = '';
      for (const id of chainIds) {
        prefix = `${prefix}/${id}`;
        pathsToExpand.add(prefix);
        const existing = findItemById(treeItems, id);
        if (existing?.path) pathsToExpand.add(existing.path);
      }
      setCollapsedFolderPaths((current) => {
        let changed = false;
        const next = new Set(current);
        for (const path of pathsToExpand) {
          if (next.delete(path)) changed = true;
        }
        return changed ? next : current;
      });
      setSelectedTreeId(item.id);
      if (isStableVfsFolderId(item.id)) {
        setSelectedFolderId(item.id);
      }
    },
    [folders, treeItems],
  );

  const sharedPaneActionProps = {
    windowId,
    onActivate: activateTab,
    onTitleChange: updateTabTitle,
    onSaveStateChange: updateTabSaveState,
    onCreateNote: () => { void createResource('note'); },
    onCreateMindmap: () => { void createResource('mindmap'); },
    onOpenSearch: () => openSearchOverlay('quick-open'),
    onImport: () => setLibraryDialog({ open: true, tab: 'import' }),
    onAskAgent: () => { void openQuickAssistantWindow().catch((error) => showGlobalNotification('error', String(error))); },
    recentResources: welcomeRecentResources,
    onOpenRecent: (node: DstuNode) => { void openWorkspaceSearchResult(node); },
    getNoteBreadcrumbs,
    onNoteBreadcrumbClick: handleNoteBreadcrumbClick,
    suppressFloatingToc: backlinksOpen && !backlinksOverlay,
  };

  const canRenderEditorPanes = hasBeenVisible && (!loading || hasInteractiveTabOpen || tabs.length === 0);

  return (
    <>
      {titlebarTarget ? createPortal(
        <WorkspaceTabs
          tabs={tabs}
          activeKey={activeTab?.key ?? null}
          mainActiveKey={mainActiveTab?.key ?? null}
          rightTabKey={splitTab?.key ?? null}
          onActivate={activateTab}
          onClose={closeTab}
          onReorder={reorderTabs}
          onOpenContextMenu={openTabContextMenu}
          onNewTab={() => { void createResource('note'); }}
          contextMenuKey={tabContextMenu?.key ?? null}
          sidebarWidth={titlebarSidebarWidth}
          saveStates={saveStates}
          actionsSlotRef={setNotesChromeSlot}
          backlinksOpen={backlinksOpen}
          onToggleBacklinks={focusMode ? undefined : () => setBacklinksOpen((open) => !open)}
        />,
        titlebarTarget,
      ) : null}
      <div
        ref={hostRef}
        className="notes-workspace"
        data-wb-notes-workspace
        data-focus-mode={focusMode ? 'true' : 'false'}
        data-compact={sizeClass === 'compact' ? 'true' : 'false'}
        data-explorer-open={explorerOpen ? 'true' : 'false'}
        onKeyDown={handleWorkspaceKeyDown}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.files).some((file) => isMarkdownFileName(file.name))) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (!files.some((file) => isMarkdownFileName(file.name))) return;
          event.preventDefault();
          void importDroppedMarkdown(files);
        }}
      >
        <WorkbenchSidebarLayout
          sizeClass={sizeClass}
          navLabel={t('notesWorkspace.explorer.title', 'Files')}
          drawerOpen={false}
          onDrawerOpenChange={handleDrawerOpenChange}
          sidebarCollapsed={!explorerVisible}
          sidebar={sizeClass === 'compact' ? null : explorerSurface}
        >
          <NotesChromeSlotContext.Provider value={splitTab || sizeClass === 'compact' ? null : notesChromeSlot}>
            <main className="notes-workspace-main" data-notes-split={splitTab ? 'true' : 'false'}>
              <div className="notes-main-content" data-backlinks-open={backlinksOpen ? 'true' : 'false'} data-backlinks-overlay={backlinksOverlay ? 'true' : 'false'}>
                <PanelGroup
                  ref={paneGroupRef}
                  direction={sizeClass === 'compact' ? 'vertical' : 'horizontal'}
                  className="notes-panes"
                  id="notes-workspace-panes"
                  onLayout={handleSplitLayout}
                >
                  <Panel
                    id="notes-workspace-main-pane"
                    order={1}
                    defaultSize={splitTab ? (sizeClass === 'compact' ? DEFAULT_SPLIT_LAYOUT[0] : splitLayout[0]) : 100}
                    minSize={splitTab ? 25 : 100}
                    className="notes-pane-panel"
                  >
                    {canRenderEditorPanes ? (
                      <WorkspacePane
                        key={`main:${paneReloadNonce.main}`}
                        {...sharedPaneActionProps}
                        paneId="main"
                        tabs={mainTabs}
                        activeKey={mainActiveTab?.key ?? null}
                        workspaceActive={isActive && resolvedFocusedPane === 'main' && !(backlinksOpen && backlinksOverlay)}
                      />
                    ) : null}
                  </Panel>
                  {splitTab && (
                    <>
                      {/* compact（手机窄窗）分屏固定 50/50：不渲染拖拽手柄（对照 VerticalResizable fixed） */}
                      {sizeClass !== 'compact' && (
                        <PanelResizeHandle
                          className="notes-pane-resize"
                          /* 触屏热区：库在 document 层用 getBoundingClientRect + hitAreaMargins 做命中检测，
                             CSS ::after 外扩不参与；coarse 22 → 1px 可视宽 + 2×22 = 45px ≥ 44px */
                          hitAreaMargins={{ coarse: 22, fine: 5 }}
                          aria-label={t('notesWorkspace.panes.resize', 'Resize split panes')}
                        />
                      )}
                      <Panel
                        id="notes-workspace-right-pane"
                        order={2}
                        defaultSize={sizeClass === 'compact' ? DEFAULT_SPLIT_LAYOUT[1] : splitLayout[1]}
                        minSize={25}
                        className="notes-pane-panel"
                      >
                        {canRenderEditorPanes ? (
                          <WorkspacePane
                            key={`right:${paneReloadNonce.right}`}
                            {...sharedPaneActionProps}
                            paneId="right"
                            tabs={[splitTab]}
                            activeKey={splitTab.key}
                            workspaceActive={isActive && resolvedFocusedPane === 'right' && !(backlinksOpen && backlinksOverlay)}
                          />
                        ) : null}
                      </Panel>
                    </>
                  )}
                </PanelGroup>
                <NotesBacklinksPanel
                  open={backlinksOpen}
                  requestedTab={backlinksRequestedTab}
                  onActiveTabChange={handleBacklinksActiveTabChange}
                  activeResource={activeResource}
                  notes={resources}
                  onOpenResource={openWorkspaceSearchResult}
                  onClose={closeBacklinks}
                  hideCloseButton
                  onCreateFromUnresolved={createFromUnresolved}
                  onRefresh={() => { void loadResources({ blocking: false }); }}
                  outlineContent={(
                    <NotesOutlineTab
                      key={activeResource?.id ?? 'no-note-outline'}
                      activeResource={activeResource}
                      onHeadingNavigate={backlinksOverlay ? closeBacklinks : undefined}
                    />
                  )}
                  propertiesContent={(
                    <NotesPropertiesTab
                      key={activeResource?.id ?? 'no-note'}
                      activeResource={activeResource}
                      hideOutline
                      onRefresh={() => { void loadResources({ blocking: false }); }}
                    />
                  )}
                  graphContent={(
                    <NotesGraphTab
                      open={backlinksOpen}
                      activeResource={activeResource}
                      notes={resources}
                      onOpenResource={openWorkspaceSearchResult}
                    />
                  )}
                />
              </div>
              <footer className="notes-statusbar" data-notes-statusbar>
                <span>{status}</span>
                <div className="notes-statusbar-right">
                  {!titlebarTarget && (
                    <button
                      type="button"
                      className="notes-chrome-backlinks-btn is-statusbar"
                      data-active={backlinksOpen ? 'true' : undefined}
                      aria-pressed={backlinksOpen}
                      aria-label={t('notes:workspace.linksAndGraph', { defaultValue: '反向链接 / 图谱' })}
                      title={t('notes:workspace.linksAndGraph', { defaultValue: '反向链接 / 图谱' })}
                      onClick={() => setBacklinksOpen((open) => !open)}
                    >
                      <span>{t('notesWorkspace.backlinks.title', 'Links')}</span>
                    </button>
                  )}
                  {/* 保存状态已在编辑器顶栏常驻：这里只在未保存 / 失败时提示，不重复「已保存」 */}
                  <span>{activeTab && (saveStates.get(activeTab.key) ?? 'saved') !== 'saved'
                    ? t(`notesWorkspace.saveState.${saveStates.get(activeTab.key)}`)
                    : ''}</span>
                </div>
              </footer>
            </main>
          </NotesChromeSlotContext.Provider>
        </WorkbenchSidebarLayout>
        {/* 窄窗「文件」全屏内联子屏（移动端契约：无遮罩抽屉；顶栏返回 + Android back） */}
        {sizeClass === 'compact' && explorerOpen && (
          <div className="notes-files-subscreen" data-notes-files-subscreen>
            <div className="notes-files-subscreen-header">
              <button
                type="button"
                className="notes-files-subscreen-back"
                onClick={() => setExplorerOpen(false)}
                aria-label={t('notesWorkspace.explorer.closeFiles', 'Close files')}
              >
                <CaretLeft size={16} aria-hidden />
                <span>{t('notesWorkspace.navigation.back', 'Back')}</span>
              </button>
              <span className="notes-files-subscreen-title">
                {t('notesWorkspace.explorer.title', 'Files')}
              </span>
            </div>
            <div className="notes-files-subscreen-body">{explorerSurface}</div>
          </div>
        )}
        {learningCreateOpen && (
          <CreateLearningNoteDialog
            folderId={learningCreateFolderId !== undefined ? learningCreateFolderId : contextualFolderId}
            onClose={() => { setLearningCreateOpen(false); setLearningCreateFolderId(undefined); }}
            onCreated={async (node) => {
              await loadResources({ blocking: false });
              await openResource({ type: 'note', id: node.id }, node.name);
            }}
          />
        )}
        <NotesSearchOverlay
          open={searchOpen}
          mode={searchMode}
          onModeChange={setSearchMode}
          resources={resources}
          recentResources={recentSearchResources}
          onOpenResource={openWorkspaceSearchResult}
          onClose={() => setSearchOpen(false)}
        />
        <WorkbenchNotesLibraryDialog
          open={libraryDialog.open}
          initialTab={libraryDialog.tab}
          onOpenChange={(open) => setLibraryDialog((current) => ({ ...current, open }))}
          onImported={() => loadResources({ blocking: false })}
        />
        {tabContextMenu && tabContextTarget && (
          <WorkspaceTabContextMenu
            menuRef={contextMenuRef}
            menu={tabContextMenu}
            target={tabContextTarget}
            isRightSplit={tabContextTarget.key === splitTab?.key}
            canOpenRightSplit={tabs.length > 1}
            canCloseOthers={tabContextCanCloseOthers}
            canCloseRight={tabContextCanCloseRight}
            onTogglePin={toggleTabPinned}
            onToggleRightSplit={toggleTabRightSplit}
            onCloseTab={(key) => { void closeTab(key); }}
            onCloseOthers={closeOtherTabs}
            onCloseRight={closeTabsToRight}
            onDismissAndRestoreFocus={() => {
              restoreTabContextFocusRef.current = true;
              setTabContextMenu(null);
            }}
          />
        )}
        <NotesTrashDialog
          open={trashOpen}
          onOpenChange={setTrashOpen}
          onChanged={() => {
            void loadResources({ blocking: false });
            void favorites.refresh();
          }}
        />
      </div>
    </>
  );
};

export default NotesWorkspaceApp;
