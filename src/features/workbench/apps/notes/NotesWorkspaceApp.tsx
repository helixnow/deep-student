import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from 'react-resizable-panels';
import {
  ArrowsClockwise,
  CaretLeft,
  FileArchive,
  FileArrowUp,
  ArrowLeft,
  ArrowRight,
  FileText,
  FolderPlus,
  LinkSimple,
  List,
  MagnifyingGlass,
  Notebook,
  PushPin,
  PushPinSlash,
  SidebarSimple,
  TreeStructure,
  Trash,
  Robot,
  X,
} from '@phosphor-icons/react';
import { dstu, createEmpty, folderApi, trashApi, type DstuNode } from '@/dstu';
import { DSTU_FOLDER_CHANGE_EVENT } from '@/dstu/folderEvents';
import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';
import { getMindMapStoreForInstance } from '@/features/mindmap/store';
import { exportResourceById } from '@/features/learning-hub/utils/exportResource';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import {
  NOTES_WORKSPACE_COMMAND_EVENT,
  type NotesWorkspaceCommandAction,
  type NotesWorkspaceCommandDetail,
} from '@/command-palette/modules/notes.commands';
import { publishNotesFindQuery } from '@/features/notes/findQueryBridge';
import { cn } from '@/lib/utils';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { isMacOS } from '@/utils/platform';
import type { FolderTreeNode, VfsFolder } from '@/dstu/types/folder';
import { requestContentCloseConfirmation } from '../content/ContentCloseConfirmation';
import { isContentDirty } from '../content/contentDirtyRegistry';
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
} from './NotesBacklinksPanel';
import { NotesPropertiesTab } from './NotesPropertiesTab';
import { NotesSearchOverlay, type NotesSearchMode } from './NotesSearchOverlay';
import { NotesTrashDialog } from './NotesTrashDialog';
import { FavoritesSection } from './FavoritesSection';
import { TagFilter } from './TagFilter';
import { useNoteFavorites } from './hooks/useNoteFavorites';
import {
  useNotesNavHistory,
  type NotesNavHistoryEntry,
} from './hooks/useNotesNavHistory';
import { nodeMatchesTags } from './parseTagQuery';
import {
  NotesWorkspaceTree,
  mapWorkspaceTreeFolder,
  expandedIdsFromCollapsedPaths,
  collectFolderEntries,
  findItemById,
  NOTES_WORKSPACE_TREE_ROOT_ID,
  type NotesWorkspaceDropPosition,
  type NotesWorkspaceTreeItem,
  type NotesWorkspaceTreeMenuItem,
} from './tree';
import './NotesWorkspaceApp.css';
import { WorkbenchSidebarSurface } from '../../components/sidebar';
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
  NOTE_TITLE_COUNT_WARN_THRESHOLD,
  countNoteInputChars,
  sanitizeNoteTitleInput,
  validateNoteTitle,
} from '@/features/notes/noteInputLimits';
import './notes-empty-states.css';

// 导图视图懒加载：@xyflow/react 体积大，只有导图标签页真正展示时才拉取，
// 避免拖入 Notes 窗口启动 chunk（加载态用下方轻量占位）
const MindMapContentView = React.lazy(() =>
  import('@/features/mindmap/MindMapContentView').then((module) => ({
    default: module.MindMapContentView,
  })),
);

/** 导图 pane 懒加载占位：与文档树加载骨架同款脉冲条 */
const MindMapPaneFallback: React.FC = () => (
  <div className="notes-mindmap-loading" aria-hidden="true">
    <i /><i /><i />
  </div>
);

type ResourceType = NotesWorkspaceResourceRef['type'];

interface WorkspaceTab extends NotesWorkspaceResourceRef {
  key: string;
  title: string;
  pinned?: boolean;
}

type SaveState = 'saved' | 'saving' | 'dirty';
type WorkspacePaneId = 'main' | 'right';
type SplitLayout = [number, number];
type TabDropPosition = 'before' | 'after';

const DEFAULT_SPLIT_LAYOUT: SplitLayout = [50, 50];

interface CloseTabOptions {
  /** A user has already confirmed a destructive action for this resource. */
  force?: boolean;
}

interface TabContextMenu {
  key: string;
  x: number;
  y: number;
}

function getTabSaveState(tab: WorkspaceTab, windowId: string): SaveState {
  if (tab.type === 'note') {
    return isContentDirty('note', tab.id) ? 'dirty' : 'saved';
  }
  const state = getMindMapStoreForInstance(`${windowId}:${tab.key}`, tab.id)?.getState();
  if (state?.isSaving) return 'saving';
  return state?.isDirty ? 'dirty' : 'saved';
}

interface TreeFolder {
  name: string;
  path: string;
  id?: string;
  folders: Map<string, TreeFolder>;
  resources: DstuNode[];
}

interface ExplorerFolderTarget {
  kind: 'folder';
  id: string;
  name: string;
  path: string;
}

interface ExplorerResourceTarget {
  kind: 'resource';
  node: DstuNode;
}

type ExplorerTarget = ExplorerFolderTarget | ExplorerResourceTarget;

type ResourceDialog =
  | { mode: 'delete'; target: ExplorerTarget }
  | { mode: 'delete-many'; targets: ExplorerTarget[] }
  | { mode: 'create-folder'; value: string; parentId: string | null };

const WORKSPACE_STORAGE_KEY = 'workbench.notesWorkspace.state.v1';

interface PersistedWorkspaceState {
  tabs: WorkspaceTab[];
  activeTabKey: string | null;
  rightTabKey: string | null;
  focusedPane: WorkspacePaneId;
  splitLayout: SplitLayout;
  backlinksOpen: boolean;
  explorerOpen: boolean;
  collapsedFolderPaths: string[];
}

const resourceType = (value: unknown): ResourceType | null =>
  value === 'note' || value === 'mindmap' ? value : null;

const treeResourceKey = (type: string, id: string): string => `${type}:${id}`;

const EMPTY_RESOURCE_FOLDER_IDS: ReadonlyMap<string, string> = new Map();

function isStableVfsFolderId(id: string): boolean {
  return Boolean(id) && !id.startsWith('synth:');
}

function isReservedFolderTitle(title: string): boolean {
  return title.trim().toLocaleLowerCase() === '__system__';
}

function findParentDeep(
  items: readonly NotesWorkspaceTreeItem[],
  childId: string,
): { found: boolean; parentId: string | null } {
  for (const item of items) {
    if (!item.children?.length) continue;
    if (item.children.some((child) => child.id === childId)) {
      return {
        found: true,
        parentId: item.kind === 'folder' && isStableVfsFolderId(item.id) ? item.id : null,
      };
    }
    const nested = findParentDeep(item.children, childId);
    if (nested.found) return nested;
  }
  return { found: false, parentId: null };
}

function resolveMoveDestinationFolderId(
  items: readonly NotesWorkspaceTreeItem[],
  targetId: string,
  position: NotesWorkspaceDropPosition,
): string | null | undefined {
  if (targetId === NOTES_WORKSPACE_TREE_ROOT_ID) return undefined;
  const target = findItemById(items, targetId);
  if (!target) return null;
  if (position === 'inside' && target.kind === 'folder') {
    return isStableVfsFolderId(target.id) ? target.id : null;
  }
  const parent = findParentDeep(items, targetId);
  return parent.found ? parent.parentId ?? undefined : null;
}

function parseSplitLayout(value: unknown): SplitLayout {
  if (!Array.isArray(value) || value.length !== 2) return DEFAULT_SPLIT_LAYOUT;
  const [main, right] = value;
  if (
    typeof main !== 'number'
    || typeof right !== 'number'
    || !Number.isFinite(main)
    || !Number.isFinite(right)
    || main < 25
    || right < 25
    || main > 75
    || right > 75
    || Math.abs(main + right - 100) > 0.5
  ) return DEFAULT_SPLIT_LAYOUT;
  return [main, right];
}

function parseInitialResource(instanceKey: string | null, payload: unknown): NotesWorkspaceResourceRef | null {
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>;
    const type = resourceType(value.resourceType ?? value.type);
    const id = typeof value.resourceId === 'string' ? value.resourceId : instanceKey;
    if (type && id) return { type, id };
  }
  if (!instanceKey) return null;
  return { type: instanceKey.startsWith('mindmap_') ? 'mindmap' : 'note', id: instanceKey };
}

function getFolderMembership(treeNodes: readonly FolderTreeNode[]): ReadonlyMap<string, string> {
  const membership = new Map<string, string>();
  const visit = (nodes: readonly FolderTreeNode[]) => {
    for (const node of nodes) {
      for (const item of node.items) {
        if (resourceType(item.itemType)) {
          membership.set(treeResourceKey(item.itemType, item.itemId), node.folder.id);
        }
      }
      visit(node.children);
    }
  };
  visit(treeNodes);
  return membership;
}

export function buildTree(
  nodes: DstuNode[],
  folders: VfsFolder[],
  resourceFolderIds: ReadonlyMap<string, string> = new Map(),
): TreeFolder {
  const root: TreeFolder = { name: '', path: '/', folders: new Map(), resources: [] };
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const knownTreeFolders = new Map<string, TreeFolder>();
  const resolvingFolderIds = new Set<string>();

  const ensureKnownFolder = (folder: VfsFolder): TreeFolder => {
    const cached = knownTreeFolders.get(folder.id);
    if (cached) return cached;
    if (resolvingFolderIds.has(folder.id)) return root;
    resolvingFolderIds.add(folder.id);
    const parentFolder = folder.parentId ? foldersById.get(folder.parentId) : undefined;
    const parent = parentFolder ? ensureKnownFolder(parentFolder) : root;
    resolvingFolderIds.delete(folder.id);
    if (isReservedFolderTitle(folder.title)) {
      knownTreeFolders.set(folder.id, parent);
      return parent;
    }
    const key = `id:${folder.id}`;
    const existing = parent.folders.get(key);
    if (existing) return existing;
    const treeFolder: TreeFolder = {
      id: folder.id,
      name: folder.title,
      path: `${parent.path === '/' ? '' : parent.path}/${folder.id}`,
      folders: new Map(),
      resources: [],
    };
    parent.folders.set(key, treeFolder);
    knownTreeFolders.set(folder.id, treeFolder);
    return treeFolder;
  };

  const ensureSyntheticFolder = (segments: string[]): TreeFolder => {
    let cursor = root;
    const pathSegments: string[] = [];
    for (const segment of segments) {
      if (isReservedFolderTitle(segment)) continue;
      pathSegments.push(segment);
      const knownMatches = [...cursor.folders.values()].filter((folder) => folder.name === segment);
      if (knownMatches.length === 1) {
        cursor = knownMatches[0];
        continue;
      }
      const key = `path:${pathSegments.join('/')}`;
      let next = cursor.folders.get(key);
      if (!next) {
        const path = `${cursor.path === '/' ? '' : cursor.path}/${key}`;
        next = { name: segment, path, folders: new Map(), resources: [] };
        cursor.folders.set(key, next);
      }
      cursor = next;
    }
    return cursor;
  };

  for (const folder of folders) {
    ensureKnownFolder(folder);
  }

  for (const node of nodes) {
    const type = resourceType(node.type);
    if (!type) continue;
    const folderId = resourceFolderIds.get(treeResourceKey(type, node.id));
    const folder = folderId ? foldersById.get(folderId) : undefined;
    if (folder) {
      ensureKnownFolder(folder).resources.push(node);
      continue;
    }
    const segments = node.path.split('/').filter(Boolean);
    if (segments.at(-1) === node.id) segments.pop();
    ensureSyntheticFolder(segments).resources.push(node);
  }
  return root;
}

function readPersistedWorkspaceState(): PersistedWorkspaceState {
  const fallback: PersistedWorkspaceState = {
    tabs: [],
    activeTabKey: null,
    rightTabKey: null,
    focusedPane: 'main',
    splitLayout: DEFAULT_SPLIT_LAYOUT,
    backlinksOpen: false,
    explorerOpen: true,
    collapsedFolderPaths: [],
  };
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return fallback;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORAGE_KEY);
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<PersistedWorkspaceState>;
    const restoredTabs = Array.isArray(value.tabs)
      ? value.tabs.filter((tab): tab is WorkspaceTab => (
        Boolean(tab)
        && typeof tab.key === 'string'
        && typeof tab.id === 'string'
        && typeof tab.title === 'string'
        && resourceType(tab.type) !== null
      ))
      : [];
    const tabs = restoredTabs.map((tab) => ({ ...tab, pinned: tab.pinned === true }));
    const rightTabKey = typeof value.rightTabKey === 'string' && tabs.some((tab) => tab.key === value.rightTabKey)
      ? value.rightTabKey
      : null;
    const mainTabs = tabs.filter((tab) => tab.key !== rightTabKey);
    const activeTabKey = typeof value.activeTabKey === 'string' && mainTabs.some((tab) => tab.key === value.activeTabKey)
      ? value.activeTabKey
      : mainTabs[0]?.key ?? null;
    return {
      tabs,
      activeTabKey,
      rightTabKey,
      focusedPane: rightTabKey && value.focusedPane === 'right' ? 'right' : 'main',
      splitLayout: parseSplitLayout(value.splitLayout),
      backlinksOpen: typeof value.backlinksOpen === 'boolean' ? value.backlinksOpen : false,
      explorerOpen: typeof value.explorerOpen === 'boolean' ? value.explorerOpen : true,
      collapsedFolderPaths: Array.isArray(value.collapsedFolderPaths)
        ? value.collapsedFolderPaths.filter((path): path is string => typeof path === 'string')
        : [],
    };
  } catch {
    return fallback;
  }
}

function getExplorerTargetName(target: ExplorerTarget): string {
  return target.kind === 'resource' ? target.node.name : target.name;
}

const IconButton: React.FC<React.ButtonHTMLAttributes<HTMLButtonElement> & { label: string }> = ({
  label,
  children,
  className,
  ...props
}) => (
  <button {...props} type="button" className={cn('notes-icon-button', className)} aria-label={label} title={label}>
    {children}
  </button>
);

const ResourceGlyph: React.FC<{ type: ResourceType; size?: number }> = ({ type, size = 15 }) =>
  type === 'note'
    ? <FileText size={size} aria-hidden />
    : <TreeStructure size={size} aria-hidden />;

interface WorkspacePaneProps {
  paneId: WorkspacePaneId;
  tabs: WorkspaceTab[];
  activeKey: string | null;
  windowId: string;
  workspaceActive: boolean;
  onActivate: (key: string) => void;
  onTitleChange: (key: string, title: string) => void;
  onSaveStateChange: (key: string, state: SaveState) => void;
  onCreateNote?: () => void;
  onOpenSearch?: () => void;
  onImport?: () => void;
  onAskAgent?: () => void;
}

const TREE_SKELETON_ROWS: Array<{ indent: number; width: string }> = [
  { indent: 0, width: '68%' },
  { indent: 1, width: '54%' },
  { indent: 1, width: '62%' },
  { indent: 2, width: '48%' },
];

const WorkspacePane: React.FC<WorkspacePaneProps> = ({
  paneId,
  tabs,
  activeKey,
  windowId,
  workspaceActive,
  onActivate,
  onTitleChange,
  onSaveStateChange,
  onCreateNote,
  onOpenSearch,
  onImport,
  onAskAgent,
}) => {
  const { t } = useTranslation('workbench');
  const active = tabs.find((tab) => tab.key === activeKey) ?? null;
  const modKey = isMacOS() ? '⌘' : 'Ctrl+';
  // 只挂载当前 + 最近 1 个标签的完整编辑器：后台标签不再用 hidden 常驻整份 Crepe，
  // 显著压低窗口 DOM 规模（拖窗每帧税 ∝ 节点数）。内容已由 DSTU/脏标记持久化。
  const [mountedKeys, setMountedKeys] = useState<string[]>(() => (activeKey ? [activeKey] : []));
  useEffect(() => {
    if (!activeKey) return;
    setMountedKeys((prev) => {
      const next = [activeKey, ...prev.filter((key) => key !== activeKey)];
      const living = new Set(tabs.map((tab) => tab.key));
      return next.filter((key) => living.has(key)).slice(0, 2);
    });
  }, [activeKey, tabs]);
  return (
    <section
      className="notes-workspace-pane"
      data-notes-pane={paneId}
      data-focused={workspaceActive ? 'true' : 'false'}
      data-resource-type={active?.type}
      data-resource-id={active?.id}
      role="region"
      aria-label={paneId === 'main'
        ? t('notesWorkspace.panes.main', 'Main editor')
        : t('notesWorkspace.panes.right', 'Right editor')}
      onPointerDown={() => active && onActivate(active.key)}
    >
      <div className="notes-pane-content">
        {!active && (
          <div className="nes-empty-pane notes-empty-pane" data-nes-empty-pane>
            <div className="nes-empty-pane__inner ui-zoom-fade-in">
              <div className="nes-empty-pane__icon" aria-hidden>
                <Notebook size={48} weight="thin" />
              </div>
              <p className="nes-empty-pane__title">
                {t('workbench:notesWorkspace.empty.paneTitle')}
              </p>
              <div className="nes-empty-pane__actions">
                <button
                  type="button"
                  className="nes-action"
                  onClick={() => onCreateNote?.()}
                >
                  <FileText size={14} aria-hidden />
                  {t('workbench:notesWorkspace.empty.paneNewNote')}
                </button>
                <button
                  type="button"
                  className="nes-action nes-action--ghost"
                  onClick={() => onOpenSearch?.()}
                >
                  <MagnifyingGlass size={14} aria-hidden />
                  {t('workbench:notesWorkspace.empty.paneOpenSearch')}
                </button>
                <button type="button" className="nes-action nes-action--ghost" onClick={onImport}>
                  <FileArrowUp size={14} aria-hidden />
                  {t('workbench:notesWorkspace.empty.paneImport', 'Import notes')}
                </button>
                <button type="button" className="nes-action nes-action--ghost" onClick={onAskAgent}>
                  <Robot size={14} aria-hidden />
                  {t('workbench:notesWorkspace.empty.paneAskAgent', 'Ask Agent')}
                </button>
              </div>
              <ul className="nes-empty-pane__hints">
                <li className="nes-empty-pane__hint">
                  <kbd className="nes-kbd">{modKey}O</kbd>
                  <span>{t('workbench:notesWorkspace.empty.hintQuickOpen')}</span>
                </li>
                <li className="nes-empty-pane__hint">
                  <kbd className="nes-kbd">{modKey}N</kbd>
                  <span>{t('workbench:notesWorkspace.empty.hintNewNote')}</span>
                </li>
              </ul>
            </div>
          </div>
        )}
        {tabs
          .filter((tab) => mountedKeys.includes(tab.key))
          .map((tab) => {
            const visible = tab.key === activeKey;
            return (
              <div className="notes-document-host" hidden={!visible} key={tab.key}>
                {tab.type === 'note' ? (
                  <UnifiedAppPanel
                    type="note"
                    resourceId={tab.id}
                    dstuPath={`/${tab.id}`}
                    strictType
                    isActive={workspaceActive && visible}
                    focusOnActive={workspaceActive && visible}
                    hostWindowId={windowId}
                    propertiesPanelDisabled
                    onTitleChange={(title) => onTitleChange(tab.key, title)}
                    onSaveStateChange={(state) => onSaveStateChange(tab.key, state)}
                    className="h-full"
                  />
                ) : (
                  <React.Suspense fallback={<MindMapPaneFallback />}>
                    <MindMapContentView
                      resourceId={tab.id}
                      storeInstanceId={`${windowId}:${tab.key}`}
                      isActive={workspaceActive && visible}
                      focusOnActive={workspaceActive && visible}
                      onTitleChange={(title) => onTitleChange(tab.key, title)}
                      onSaveStateChange={(state) => onSaveStateChange(tab.key, state)}
                      className="h-full"
                    />
                  </React.Suspense>
                )}
              </div>
            );
          })}
      </div>
    </section>
  );
};

interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeKey: string | null;
  rightTabKey: string | null;
  onActivate: (key: string) => void;
  onClose: (key: string) => void | Promise<boolean>;
  onReorder: (draggedKey: string, targetKey: string, position: TabDropPosition) => void;
  onOpenContextMenu: (key: string, x: number, y: number, trigger: HTMLElement) => void;
  /** Double-clicking the empty strip area (browser-style) creates a new note. */
  onNewTab?: () => void;
  contextMenuKey: string | null;
  leftOffset: number;
  saveStates: Map<string, SaveState>;
}

const WorkspaceTabs: React.FC<WorkspaceTabsProps> = ({
  tabs,
  activeKey,
  rightTabKey,
  onActivate,
  onClose,
  onReorder,
  onOpenContextMenu,
  onNewTab,
  contextMenuKey,
  leftOffset,
  saveStates,
}) => {
  const { t } = useTranslation('workbench');
  const stripRef = useRef<HTMLDivElement>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; position: TabDropPosition } | null>(null);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowMenuPosition, setOverflowMenuPosition] = useState<{ top: number; right: number } | null>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);

  const dismissOverflow = useCallback((event: Event) => {
    if (event.target instanceof Node && overflowRef.current?.contains(event.target)) return;
    if (event.target instanceof Node && overflowMenuRef.current?.contains(event.target)) return;
    setOverflowOpen(false);
  }, []);
  const dismissOverflowWithEscape = useCallback((event: Event) => {
    if (event instanceof KeyboardEvent && event.key === 'Escape') setOverflowOpen(false);
  }, []);
  useEventRegistry(overflowOpen ? [
    { target: 'document', type: 'pointerdown', listener: dismissOverflow },
    { target: 'document', type: 'keydown', listener: dismissOverflowWithEscape },
  ] : [], [overflowOpen, dismissOverflow, dismissOverflowWithEscape]);

  useEffect(() => {
    const active = stripRef.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    active?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeKey, tabs.length]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const onWheel = (event: WheelEvent) => {
      if (strip.scrollWidth <= strip.clientWidth) return;
      const delta = Math.abs(event.deltaY) >= Math.abs(event.deltaX) ? event.deltaY : event.deltaX;
      if (delta === 0) return;
      event.preventDefault();
      strip.scrollLeft += delta;
    };
    strip.addEventListener('wheel', onWheel, { passive: false });
    return () => strip.removeEventListener('wheel', onWheel);
  }, []);

  const focusTab = (event: React.KeyboardEvent, index: number) => {
    const buttons = event.currentTarget
      .closest('[data-notes-tabstrip]')
      ?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    if (!buttons?.length) return;
    const button = buttons.item((index + buttons.length) % buttons.length);
    button?.focus();
    button?.click();
  };
  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>, index: number, key: string) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusTab(event, index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusTab(event, index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusTab(event, 0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusTab(event, tabs.length - 1);
    } else if (event.key === 'Delete') {
      event.preventDefault();
      void onClose(key);
    } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
      event.preventDefault();
      const bounds = event.currentTarget.getBoundingClientRect();
      onOpenContextMenu(
        key,
        Math.max(8, Math.min(bounds.left, window.innerWidth - 184)),
        Math.max(8, Math.min(bounds.bottom, window.innerHeight - 148)),
        event.currentTarget,
      );
    }
  };

  const clearTabDrag = () => {
    setDraggedKey(null);
    setDropTarget(null);
  };

  return (
  <div className="notes-titlebar-tabs" style={{ paddingLeft: leftOffset }}>
    <div
      ref={stripRef}
      className="notes-tabstrip scrollbar-none"
      data-notes-tabstrip
      role="tablist"
      aria-label={t('notesWorkspace.tabs.aria', 'Open files')}
      onDoubleClick={(event) => {
        // 仅拦截真正的空白条区域：已有 tab 时双击空白＝浏览器式新建；
        // 各 tab 自己 stopPropagation，不会走到这里。没有 tab 时保留
        // 标题栏双击缩放的窗壳语义。
        if (!onNewTab || tabs.length === 0 || event.target !== event.currentTarget) return;
        event.preventDefault();
        event.stopPropagation();
        onNewTab();
      }}
    >
      {tabs.map((tab, index) => {
        const saveState = saveStates.get(tab.key) ?? 'saved';
        const isRightSplitTab = tab.key === rightTabKey;
        return (
        <div
          className="notes-tab"
          data-active={tab.key === activeKey ? 'true' : 'false'}
          data-right-split={isRightSplitTab ? 'true' : 'false'}
          data-pinned={tab.pinned ? 'true' : 'false'}
          data-save-state={saveState}
          data-drop-position={dropTarget?.key === tab.key ? dropTarget.position : undefined}
          key={tab.key}
          draggable
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => {
            event.preventDefault();
            const trigger = event.currentTarget.querySelector<HTMLElement>('[role="tab"]') ?? event.currentTarget;
            onOpenContextMenu(tab.key, event.clientX, event.clientY, trigger);
          }}
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', tab.key);
            setDraggedKey(tab.key);
          }}
          onDragOver={(event) => {
            if (!draggedKey || draggedKey === tab.key) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            const bounds = event.currentTarget.getBoundingClientRect();
            setDropTarget({
              key: tab.key,
              position: event.clientX >= bounds.left + bounds.width / 2 ? 'after' : 'before',
            });
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDropTarget((current) => current?.key === tab.key ? null : current);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            const target = dropTarget?.key === tab.key
              ? dropTarget
              : { key: tab.key, position: 'before' as const };
            if (draggedKey && draggedKey !== target.key) onReorder(draggedKey, target.key, target.position);
            clearTabDrag();
          }}
          onDragEnd={clearTabDrag}
          onAuxClick={(event) => {
            if (event.button !== 1) return;
            event.preventDefault();
            void onClose(tab.key);
          }}
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab.key === activeKey}
            aria-haspopup="menu"
            aria-expanded={contextMenuKey === tab.key}
            aria-controls={contextMenuKey === tab.key ? 'notes-tab-context-menu' : undefined}
            aria-description={tab.pinned
              ? t('notesWorkspace.tabs.pinned', 'Pinned')
              : undefined}
            tabIndex={tab.key === activeKey ? 0 : -1}
            onClick={() => onActivate(tab.key)}
            onKeyDown={(event) => handleKeyDown(event, index, tab.key)}
          >
            <ResourceGlyph type={tab.type} size={14} />
            <span>{tab.title}</span>
            {tab.pinned && (
              <PushPin
                className="notes-tab-pin"
                size={11}
                weight="fill"
                aria-hidden
              />
            )}
            {saveState !== 'saved' && (
              <i className="notes-tab-state" aria-label={saveState === 'saving'
                ? t('notesWorkspace.saveState.saving', 'Saving')
                : t('notesWorkspace.saveState.dirty', 'Unsaved')} />
            )}
          </button>
          <IconButton label={t('notesWorkspace.tabs.close', { defaultValue: 'Close {{title}}', title: tab.title })} onClick={() => void onClose(tab.key)}>
            <X size={12} />
          </IconButton>
        </div>
      );})}
    </div>
    {tabs.length > 0 && (
      <div className="notes-tabs-overflow" ref={overflowRef}>
        <IconButton
          label={t('notesWorkspace.tabs.showAll', 'Show all open files')}
          aria-haspopup="menu"
          aria-expanded={overflowOpen}
          onClick={(event) => {
            if (overflowOpen) {
              setOverflowOpen(false);
              return;
            }
            const bounds = event.currentTarget.getBoundingClientRect();
            setOverflowMenuPosition({
              top: bounds.bottom - 2,
              right: Math.max(8, window.innerWidth - bounds.right),
            });
            setOverflowOpen(true);
          }}
        >
          <List size={15} />
        </IconButton>
        {overflowOpen && overflowMenuPosition && createPortal(
          <CustomScrollArea
            ref={overflowMenuRef}
            className="notes-tabs-overflow-menu"
            viewportClassName="notes-tabs-overflow-menu-viewport"
            viewportProps={{ role: 'menu' }}
            style={overflowMenuPosition}
            fullHeight={false}
            trackOffsetTop={4}
            trackOffsetBottom={4}
            trackOffsetRight={2}
          >
            {tabs.map((tab) => {
              const overflowSaveState = saveStates.get(tab.key) ?? 'saved';
              return (
                <button
                  type="button"
                  role="menuitem"
                  key={tab.key}
                  data-active={tab.key === activeKey ? 'true' : 'false'}
                  data-save-state={overflowSaveState}
                  onClick={() => { onActivate(tab.key); setOverflowOpen(false); }}
                >
                  <ResourceGlyph type={tab.type} size={14} />
                  <span>{tab.title}</span>
                  {tab.pinned && <PushPin className="notes-tab-pin" size={11} weight="fill" aria-hidden />}
                  {overflowSaveState !== 'saved' && (
                    <i
                      className="notes-tab-state"
                      aria-label={overflowSaveState === 'saving'
                        ? t('notesWorkspace.saveState.saving', 'Saving')
                        : t('notesWorkspace.saveState.dirty', 'Unsaved')}
                    />
                  )}
                </button>
              );
            })}
          </CustomScrollArea>,
          document.body,
        )}
      </div>
    )}
  </div>
  );
};

export const NotesWorkspaceApp: React.FC<AppWindowProps> = ({
  windowId,
  instanceKey,
  launchPayload,
  isActive,
  renderThrottleMs = 0,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');
  const persistedStateRef = useRef(readPersistedWorkspaceState());
  const persistedState = persistedStateRef.current;
  const hostRef = useRef<HTMLDivElement>(null);
  const explorerRef = useRef<HTMLElement>(null);
  // 拖/缩/settle 期间冻结工作区动画/过渡（CSS 定向规则见 NotesWorkspaceApp.css）
  useDragRenderPause(hostRef, renderThrottleMs);
  const [resources, setResources] = useState<DstuNode[]>([]);
  const [folders, setFolders] = useState<VfsFolder[]>([]);
  const [resourceFolderIds, setResourceFolderIds] = useState<ReadonlyMap<string, string>>(
    EMPTY_RESOURCE_FOLDER_IDS,
  );
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => persistedState.tabs);
  const [activeTabKey, setActiveTabKey] = useState<string | null>(() => persistedState.activeTabKey);
  const [rightTabKey, setRightTabKey] = useState<string | null>(() => persistedState.rightTabKey);
  const [focusedPane, setFocusedPane] = useState<WorkspacePaneId>(() => persistedState.focusedPane);
  const [splitLayout, setSplitLayout] = useState<SplitLayout>(() => persistedState.splitLayout);
  const [backlinksOpen, setBacklinksOpen] = useState(() => persistedState.backlinksOpen);
  const [backlinksRequestedTab, setBacklinksRequestedTab] = useState<NotesBacklinksTabRequest | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<NotesSearchMode>('quick-open');
  const [explorerOpen, setExplorerOpen] = useState(() => persistedState.explorerOpen);
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
  const [status, setStatus] = useState(() => t('notesWorkspace.status.ready', 'Ready'));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tabSaveStates, setTabSaveStates] = useState<Record<string, SaveState>>({});
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenu | null>(null);
  const [resourceDialog, setResourceDialog] = useState<ResourceDialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [libraryDialog, setLibraryDialog] = useState<{ open: boolean; tab: 'export' | 'import' }>({
    open: false,
    tab: 'export',
  });
  const favorites = useNoteFavorites();
  const navHistory = useNotesNavHistory();
  const initialRef = useRef(parseInitialResource(instanceKey, launchPayload));
  const openResourceRef = useRef<(ref: NotesWorkspaceResourceRef, title?: string) => Promise<void>>(async () => undefined);
  const closeTabRef = useRef<(key: string, options?: CloseTabOptions) => Promise<boolean>>(async () => false);
  const pendingTabCloseKeysRef = useRef(new Set<string>());
  const pendingConfirmedDeletionKeysRef = useRef(new Set<string>());
  const activeTabRef = useRef<WorkspaceTab | null>(null);
  const tabsRef = useRef<WorkspaceTab[]>([]);
  const rightTabKeyRef = useRef<string | null>(rightTabKey);
  const focusedPaneRef = useRef<WorkspacePaneId>(focusedPane);
  const resourcesRef = useRef<DstuNode[]>([]);
  const hasLoadedResourcesRef = useRef(false);
  const loadSequenceRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const tabContextTriggerRef = useRef<HTMLElement | null>(null);
  const restoreTabContextFocusRef = useRef(false);
  const paneGroupRef = useRef<ImperativePanelGroupHandle>(null);
  const splitLayoutRef = useRef<SplitLayout>(splitLayout);

  const splitTab = tabs.find((tab) => tab.key === rightTabKey) ?? null;
  const mainTabs = useMemo(
    () => tabs.filter((tab) => tab.key !== splitTab?.key),
    [splitTab?.key, tabs],
  );
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
  const tabContextTarget = tabContextMenu
    ? tabs.find((tab) => tab.key === tabContextMenu.key) ?? null
    : null;
  const tabContextIndex = tabContextTarget ? tabs.findIndex((tab) => tab.key === tabContextTarget.key) : -1;
  const tabContextCanCloseOthers = Boolean(tabContextTarget && tabs.some(
    (tab) => tab.key !== tabContextTarget.key && !tab.pinned,
  ));
  const tabContextCanCloseRight = tabContextIndex >= 0 && tabs.slice(tabContextIndex + 1).some((tab) => !tab.pinned);
  activeTabRef.current = activeTab;
  tabsRef.current = tabs;
  rightTabKeyRef.current = splitTab?.key ?? null;
  focusedPaneRef.current = resolvedFocusedPane;
  splitLayoutRef.current = splitLayout;
  resourcesRef.current = resources;
  const filteredResources = useMemo(() => {
    const term = query.trim().toLocaleLowerCase();
    return resources.filter((node) => {
      if (term && !node.name.toLocaleLowerCase().includes(term)) return false;
      if (!nodeMatchesTags(node.metadata, selectedTags)) return false;
      return true;
    });
  }, [query, resources, selectedTags]);
  const tree = useMemo(
    () => buildTree(
      filteredResources,
      query.trim() || selectedTags.length > 0 ? [] : folders,
      query.trim() || selectedTags.length > 0 ? EMPTY_RESOURCE_FOLDER_IDS : resourceFolderIds,
    ),
    [filteredResources, folders, query, resourceFolderIds, selectedTags.length],
  );
  const treeItems = useMemo(() => mapWorkspaceTreeFolder(tree), [tree]);
  const folderEntries = useMemo(() => collectFolderEntries(treeItems), [treeItems]);
  const expandedIds = useMemo(
    () => expandedIdsFromCollapsedPaths(folderEntries, collapsedFolderPaths),
    [collapsedFolderPaths, folderEntries],
  );
  const hasTreeItems = treeItems.length > 0;
  const sidebarLayoutWidth = sizeClass === 'wide' ? 272 : sizeClass === 'medium' ? 240 : 0;
  const availableMainWidth = workspaceWidth - sidebarLayoutWidth;
  const backlinksOverlay = sizeClass === 'compact'
    || Boolean(splitTab)
    || workspaceWidth < 1180
    || availableMainWidth < 760;
  const titlebarTabsLeft = Math.max(76, sidebarLayoutWidth);
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
        dstu.list('/', { typeFilter: 'note', sortBy: 'name', sortOrder: 'asc', limit: 1000 }),
        dstu.list('/', { typeFilter: 'mindmap', sortBy: 'name', sortOrder: 'asc', limit: 1000 }),
        foldersRequest,
        folderTreeRequest,
      ]);
      if (requestSequence !== loadSequenceRef.current) return;

      const resourceFailure = !notesResult.ok ? notesResult : !mindmapsResult.ok ? mindmapsResult : null;
      if (resourceFailure) {
        const message = resourceFailure.error.toUserMessage();
        if (blocking || !hasLoadedResourcesRef.current) setLoadError(message);
        setStatus(message);
        if (blocking || requiresInitialLoad) setLoading(false);
        return;
      }

      const byId = new Map<string, DstuNode>();
      for (const node of [...notesResult.value, ...mindmapsResult.value]) {
        if (resourceType(node.type)) byId.set(node.id, node);
      }
      const nextResources = [...byId.values()];
      const nextFolders = foldersResult?.ok ? foldersResult.value : [];
      const nextResourceFolderIds = folderTreeResult?.ok
        ? getFolderMembership(folderTreeResult.value)
        : EMPTY_RESOURCE_FOLDER_IDS;
      hasLoadedResourcesRef.current = true;
      setResources(nextResources);
      setFolders(nextFolders);
      setResourceFolderIds(nextResourceFolderIds);
      setSelectedFolderId((current) => (
        current && nextFolders.some((folder) => folder.id === current) ? current : null
      ));
      setTabs((current) => current
        .filter((tab) => byId.has(tab.id))
        .map((tab) => {
          const node = byId.get(tab.id);
          return node && node.name !== tab.title ? { ...tab, title: node.name } : tab;
        }));
      setLoadError(null);
      setStatus(t('notesWorkspace.status.fileCount', { defaultValue: '{{count}} files', count: nextResources.length }));
      if (blocking || requiresInitialLoad) setLoading(false);
    } catch (error) {
      if (requestSequence !== loadSequenceRef.current) return;
      const message = error instanceof Error && error.message.trim()
        ? error.message
        : t('notesWorkspace.tree.loadFailed', 'Could not load files');
      if (blocking || !hasLoadedResourcesRef.current) setLoadError(message);
      setStatus(message);
      if (blocking || requiresInitialLoad) setLoading(false);
    }
  }, [t]);

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

  const openResource = useCallback((ref: NotesWorkspaceResourceRef, title?: string) => {
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
    setActiveTabKey((current) => {
      const mainCandidates = currentTabs.filter((tab) => tab.key !== key);
      if (current && current !== key && mainCandidates.some((tab) => tab.key === current)) return current;
      return mainCandidates.find((tab) => tab.key === priorRightKey)?.key ?? mainCandidates[0]?.key ?? null;
    });
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
    if (rightTabKeyRef.current === key) {
      closeRightSplit();
    } else {
      openTabInRightSplit(key);
    }
  }, [closeRightSplit, openTabInRightSplit]);

  const closeTab = useCallback(async (key: string, options: CloseTabOptions = {}) => {
    const currentTab = tabsRef.current.find((tab) => tab.key === key);
    if (!currentTab) return false;
    const saveState = currentTab ? getTabSaveState(currentTab, windowId) : 'saved';
    if (currentTab && saveState !== 'saved' && !options.force) {
      // Repeated Ctrl/Cmd+W presses should not enqueue duplicate discard prompts.
      if (pendingTabCloseKeysRef.current.has(key)) return false;
      pendingTabCloseKeysRef.current.add(key);
      try {
        const confirmed = await requestContentCloseConfirmation({
          description: t(
            saveState === 'saving'
              ? 'notesWorkspace.confirmCloseSaving'
              : 'notesWorkspace.confirmCloseUnsaved',
            saveState === 'saving'
              ? 'This tab is still saving. Close it anyway?'
              : 'This tab has unsaved changes. Close it anyway?',
          ),
        });
        if (!confirmed) return false;
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
    const closingRightSplitTab = closingRightKey === key;
    const closingWouldLeaveOnlyRightPane = !closingRightSplitTab
      && Boolean(closingRightKey)
      && tabsRef.current.every((tab) => tab.key === key || tab.key === closingRightKey);
    const shouldCloseSplit = closingRightSplitTab || closingWouldLeaveOnlyRightPane;
    if (shouldCloseSplit) {
      rightTabKeyRef.current = null;
      setRightTabKey(null);
    }
    setTabs((current) => {
      const closing = current.find((tab) => tab.key === key);
      if (!closing) return current;
      const closingIndex = current.findIndex((tab) => tab.key === key);
      const next = current.filter((tab) => tab.key !== key);
      const nextRightKey = shouldCloseSplit ? null : closingRightKey;
      const nextMainTabs = next.filter((tab) => tab.key !== nextRightKey);
      const neighbor = [next[closingIndex], next[closingIndex - 1], ...nextMainTabs]
        .find((tab): tab is WorkspaceTab => Boolean(tab) && tab.key !== nextRightKey) ?? null;
      setActiveTabKey((active) => (
        active && active !== key && nextMainTabs.some((tab) => tab.key === active)
          ? active
          : neighbor?.key ?? null
      ));
      setFocusedPane((currentPane) => {
        const nextPane: WorkspacePaneId = shouldCloseSplit
          ? 'main'
          : currentPane === 'main' && nextMainTabs.length === 0 && nextRightKey
            ? 'right'
            : currentPane;
        focusedPaneRef.current = nextPane;
        return nextPane;
      });
      return next;
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
    setTabs((current) => {
      const draggedIndex = current.findIndex((tab) => tab.key === draggedKey);
      if (draggedIndex < 0) return current;
      const next = [...current];
      const [dragged] = next.splice(draggedIndex, 1);
      const targetIndex = next.findIndex((tab) => tab.key === targetKey);
      if (!dragged || targetIndex < 0) return current;
      next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, dragged);
      return next;
    });
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

  const deleteContextResource = useCallback(async () => {
    if (!resourceDialog || resourceDialog.mode !== 'delete') return;
    const target = resourceDialog.target;
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
        const movedMessage = t('notesWorkspace.status.movedToTrash', {
          defaultValue: '{{name}} moved to trash',
          name: target.node.name,
        });
        setStatus(movedMessage);
        showGlobalNotification('success', movedMessage, undefined, {
          action: {
            label: t('notesWorkspace.actions.undo', 'Undo'),
            onClick: () => {
              void (async () => {
                const restored = await trashApi.restoreItem(target.node.id, target.node.type);
                if (!restored.ok) {
                  showGlobalNotification('error', restored.error.toUserMessage());
                  return;
                }
                const restoredMessage = t('notesWorkspace.status.restored', {
                  defaultValue: '{{name}} restored',
                  name: target.node.name,
                });
                setStatus(restoredMessage);
                showGlobalNotification('success', restoredMessage);
                await loadResources({ blocking: false });
              })();
            },
          },
        });
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
      const movedMessage = t('notesWorkspace.status.movedToTrash', {
        defaultValue: '{{name}} moved to trash',
        name: target.name,
      });
      setStatus(movedMessage);
      showGlobalNotification('success', movedMessage, undefined, {
        action: {
          label: t('notesWorkspace.actions.undo', 'Undo'),
          onClick: () => {
            void (async () => {
              const restored = await trashApi.restoreItem(target.id, 'folder');
              if (!restored.ok) {
                showGlobalNotification('error', restored.error.toUserMessage());
                return;
              }
              const restoredMessage = t('notesWorkspace.status.restored', {
                defaultValue: '{{name}} restored',
                name: target.name,
              });
              setStatus(restoredMessage);
              showGlobalNotification('success', restoredMessage);
              await loadResources({ blocking: false });
            })();
          },
        },
      });
    }
    setResourceDialog(null);
    await loadResources({ blocking: false });
  }, [closeTab, loadResources, resourceDialog, selectedFolderId, t]);

  // 多选批量删除：一次内联确认，逐项移入回收站，失败逐项上报
  const deleteContextResources = useCallback(async () => {
    if (!resourceDialog || resourceDialog.mode !== 'delete-many') return;
    const targets = resourceDialog.targets;
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
  }, [closeTab, loadResources, resourceDialog, t]);

  const createFolder = useCallback(async () => {
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
      if (event.type === 'updated' && changedNode && resourceType(changedNode.type)) {
        setResources((current) => {
          const index = current.findIndex((node) => node.id === changedNode.id);
          if (index < 0) return current;
          const existing = current[index];
          // Content-only saves produce updated events too. Skip React work when
          // the explorer-visible shape did not change.
          if (
            existing.name === changedNode.name
            && existing.path === changedNode.path
            && existing.type === changedNode.type
          ) return current;
          const next = [...current];
          next[index] = changedNode;
          return next;
        });
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

  useEventRegistry(
    [{ target: 'window', type: DSTU_FOLDER_CHANGE_EVENT, listener: onFolderChange }],
    [onFolderChange],
  );

  useEffect(() => {
    const initial = initialRef.current;
    if (!initial) return;
    initialRef.current = null;
    void openResource(initial);
  }, [openResource]);

  // Keep the two panes coherent after a resource deletion or a restored
  // workspace. The right-side tab is never a valid main-pane selection.
  useEffect(() => {
    const validRightKey = rightTabKey && tabs.some((tab) => tab.key === rightTabKey)
      ? rightTabKey
      : null;
    if (validRightKey !== rightTabKey) setRightTabKey(validRightKey);
    const validMainTabs = tabs.filter((tab) => tab.key !== validRightKey);
    const validActiveKey = activeTabKey && validMainTabs.some((tab) => tab.key === activeTabKey)
      ? activeTabKey
      : validMainTabs[0]?.key ?? null;
    if (validActiveKey !== activeTabKey) setActiveTabKey(validActiveKey);
    const validFocusedPane: WorkspacePaneId = validRightKey && focusedPane === 'right' ? 'right' : 'main';
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
      saveState: getTabSaveState(tab, windowId),
    })),
  }), [windowId]);

  useEffect(() => {
    setWorkspaceActiveResource(windowId, activeTab ? { type: activeTab.type, id: activeTab.id } : null);
  }, [activeTab, windowId]);

  useEffect(() => {
    try {
      window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify({
        tabs,
        activeTabKey: mainActiveTab?.key ?? null,
        rightTabKey: splitTab?.key ?? null,
        focusedPane: resolvedFocusedPane,
        splitLayout,
        backlinksOpen,
        explorerOpen,
        collapsedFolderPaths: [...collapsedFolderPaths].sort(),
      } satisfies PersistedWorkspaceState));
    } catch {
      // Local storage is a convenience only; a private browser context must
      // not prevent the workspace from opening.
    }
  }, [backlinksOpen, collapsedFolderPaths, explorerOpen, mainActiveTab?.key, resolvedFocusedPane, splitLayout, splitTab?.key, tabs]);

  const handleSplitLayout = useCallback((layout: number[]) => {
    if (!splitTab || layout.length !== 2) return;
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
      if (group?.getLayout().length === 2) group.setLayout(splitLayoutRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [splitTab?.key]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      const width = entry.contentRect.width;
      setWorkspaceWidth(width);
      const nextSizeClass = classifyWbSysWidth(width);
      setSizeClass(nextSizeClass);
      if (nextSizeClass === 'compact') setExplorerOpen(false);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!backlinksOverlay) return;
    if (explorerOpen && backlinksOpen) setExplorerOpen(false);
  }, [backlinksOpen, backlinksOverlay, explorerOpen]);

  // 窄窗「文件」内联子屏打开时接管 Android 返回键：先关子屏，不关笔记窗口
  useEffect(() => {
    if (sizeClass !== 'compact' || !explorerOpen) return;
    return registerBackHandler(() => {
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

  // 行内输入行 / 确认条（非模态）：打开时把焦点送进面板，关闭后归还给触发
  // 元素；触发行已被删除时回落到树内相邻可聚焦行。
  useEffect(() => {
    const mode = resourceDialog?.mode;
    if (!mode) return;
    const opener = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = mode === 'delete' || mode === 'delete-many'
      ? window.requestAnimationFrame(() => {
        explorerRef.current
          ?.querySelector<HTMLElement>('[data-notes-inline-confirm] button.is-danger')
          ?.focus();
      })
      : null;
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      const active = document.activeElement;
      // 焦点仍停在别的控件上（如失焦取消时点中的目标）就不要抢回来
      if (active instanceof HTMLElement && active !== document.body) return;
      if (opener?.isConnected) {
        opener.focus();
        return;
      }
      explorerRef.current?.querySelector<HTMLElement>('[role="treeitem"]')?.focus();
    };
  }, [resourceDialog?.mode]);

  const onCloseTabShortcut = useCallback((event: Event) => {
    if (!(event instanceof KeyboardEvent)) return;
    if (
      !(event.metaKey || event.ctrlKey)
      || event.altKey
      || event.shiftKey
      || event.key.toLocaleLowerCase() !== 'w'
    ) return;
    // The workspace owns Ctrl/Cmd+W even before a tab is opened. Without
    // this, the browser/WebView default can close the entire application.
    event.preventDefault();
    const current = activeTabRef.current;
    if (!current) return;
    void closeTabRef.current(current.key);
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
  const recentSearchResources = useMemo(() => {
    const seen = new Set<string>();
    const recents: DstuNode[] = [];
    for (let index = navHistory.entries.length - 1; index >= 0; index -= 1) {
      const entry = navHistory.entries[index];
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      const node = resources.find((item) => item.id === entry.id && item.type === entry.type);
      if (node) recents.push(node);
      if (recents.length >= 8) break;
    }
    return recents;
  }, [navHistory.entries, resources]);

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
          setBacklinksRequestedTab((request) => ({
            tab: 'links',
            requestId: (request?.requestId ?? 0) + 1,
          }));
          setBacklinksOpen((open) => !open);
          break;
        case 'toggle-outline':
          setBacklinksRequestedTab((request) => ({
            tab: 'properties',
            requestId: (request?.requestId ?? 0) + 1,
          }));
          setBacklinksOpen(true);
          break;
        case 'export-current':
          if (activeTabRef.current) {
            void exportResourceById(
              activeTabRef.current.id,
              i18next.getFixedT(i18next.language, 'learningHub'),
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
  }, [createResource, focusExplorerSearch, openSearchOverlay, selectedFolderId]);
  useEventRegistry(
    isActive
      ? [{ target: 'window', type: NOTES_WORKSPACE_COMMAND_EVENT, listener: onWorkspaceCommand }]
      : [],
    [isActive, onWorkspaceCommand],
  );

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
      const result = await dstu.rename(path, name);
      if (!result.ok) {
        setStatus(result.error.toUserMessage());
        return;
      }
      updateTabTitle(`${item.kind}:${item.id}`, name);
    }
    await loadResources({ blocking: false });
  }, [loadResources, treeItems, updateTabTitle]);

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

  const resolveCreateFolderId = useCallback((item: NotesWorkspaceTreeItem): string | undefined => {
    if (item.kind === 'folder' && isStableVfsFolderId(item.id)) return item.id;
    return selectedFolderId ?? undefined;
  }, [selectedFolderId]);

  const requestDeleteTreeItem = useCallback((item: NotesWorkspaceTreeItem) => {
    setDialogError(null);
    if (item.kind === 'folder') {
      if (!isStableVfsFolderId(item.id)) return;
      setResourceDialog({
        mode: 'delete',
        target: { kind: 'folder', id: item.id, name: item.name, path: item.path ?? item.id },
      });
      return;
    }
    const node = resourcesRef.current.find((entry) => entry.id === item.id && entry.type === item.kind);
    if (!node) return;
    setResourceDialog({ mode: 'delete', target: { kind: 'resource', node } });
  }, []);

  // 树内多选 Delete：合并为一次批量确认（避免逐项弹出、只剩最后一项生效）
  const requestDeleteTreeItems = useCallback((items: readonly NotesWorkspaceTreeItem[]) => {
    const targets: ExplorerTarget[] = [];
    for (const item of items) {
      if (item.kind === 'folder') {
        if (!isStableVfsFolderId(item.id)) continue;
        targets.push({ kind: 'folder', id: item.id, name: item.name, path: item.path ?? item.id });
        continue;
      }
      const node = resourcesRef.current.find((entry) => entry.id === item.id && entry.type === item.kind);
      if (node) targets.push({ kind: 'resource', node });
    }
    if (targets.length === 0) return;
    setDialogError(null);
    if (targets.length === 1) {
      setResourceDialog({ mode: 'delete', target: targets[0] });
      return;
    }
    setResourceDialog({ mode: 'delete-many', targets });
  }, []);

  const getTreeMenuItems = useCallback((
    item: NotesWorkspaceTreeItem,
    helpers: { beginRename: () => void },
  ): NotesWorkspaceTreeMenuItem[] => {
    const items: NotesWorkspaceTreeMenuItem[] = [];
    if (item.kind === 'note' || item.kind === 'mindmap') {
      const resourceType = item.kind;
      items.push({
        id: 'open',
        label: t('notesWorkspace.context.open'),
        onSelect: () => void openResource({ type: resourceType, id: item.id }, item.name),
      });
      items.push({
        id: 'openSplit',
        label: t('notesWorkspace.context.openSplit'),
        onSelect: () => {
          void (async () => {
            await openResource({ type: resourceType, id: item.id }, item.name);
            openTabInRightSplit(`${resourceType}:${item.id}`);
          })();
        },
      });
      const isFavorite = favorites.items.some((entry) => entry.id === item.id && entry.type === resourceType)
        || item.favorite === true;
      items.push({
        id: 'favorite',
        label: isFavorite
          ? t('notesWorkspace.context.unfavorite')
          : t('notesWorkspace.context.favorite'),
        onSelect: () => { void favorites.toggle(item.id, resourceType); },
      });
    }
    if (item.canRename !== false) {
      items.push({
        id: 'rename',
        label: t('notesWorkspace.context.rename'),
        onSelect: () => helpers.beginRename(),
      });
    }
    const createFolderId = resolveCreateFolderId(item);
    items.push({
      id: 'newNote',
      label: t('notesWorkspace.context.newNote'),
      separatorBefore: true,
      onSelect: () => { void createResource('note', createFolderId ?? null); },
    });
    items.push({
      id: 'newFolder',
      label: t('notesWorkspace.context.newFolder'),
      onSelect: () => {
        setDialogError(null);
        setResourceDialog({
          mode: 'create-folder',
          value: '',
          parentId: createFolderId ?? null,
        });
      },
    });
    items.push({
      id: 'newMindmap',
      label: t('notesWorkspace.context.newMindmap'),
      onSelect: () => { void createResource('mindmap', createFolderId ?? null); },
    });
    if (item.kind === 'folder' ? isStableVfsFolderId(item.id) : true) {
      items.push({
        id: 'delete',
        label: t('notesWorkspace.context.delete'),
        danger: true,
        separatorBefore: true,
        onSelect: () => {
          requestDeleteTreeItem(item);
        },
      });
    }
    return items;
  }, [createResource, favorites, openResource, openTabInRightSplit, requestDeleteTreeItem, resolveCreateFolderId, t]);

  const openTabContextMenu = useCallback((key: string, x: number, y: number, trigger: HTMLElement) => {
    restoreTabContextFocusRef.current = false;
    tabContextTriggerRef.current = trigger;
    setTabContextMenu({
      key,
      x: Math.max(8, Math.min(x, window.innerWidth - 184)),
      y: Math.max(8, Math.min(y, window.innerHeight - 148)),
    });
  }, []);

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
    const markdownFiles = files.filter((file) => /\.md(?:own)?$/i.test(file.name));
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
    if (
      (event.metaKey || event.ctrlKey)
      && !event.altKey
      && !event.shiftKey
      && event.key.toLocaleLowerCase() === 'p'
    ) {
      event.preventDefault();
      event.stopPropagation();
      openSearchOverlay('quick-open');
      return;
    }
    const cyclesByPage = event.ctrlKey
      && !event.metaKey
      && !event.altKey
      && !event.shiftKey
      && (event.key === 'PageDown' || event.key === 'PageUp');
    // mod+shift+] / [：某些键盘布局下 shift 组合产出 } / {，一并接受
    const cyclesByBracket = (event.metaKey || event.ctrlKey)
      && event.shiftKey
      && !event.altKey
      && (event.key === ']' || event.key === '[' || event.key === '}' || event.key === '{');
    if (cyclesByPage || cyclesByBracket) {
      event.preventDefault();
      event.stopPropagation();
      cycleTab(event.key === 'PageDown' || event.key === ']' || event.key === '}' ? 1 : -1);
    }
  }, [activateHistoryEntry, cycleTab, navHistory, openSearchOverlay]);

  useEventRegistry(
    isActive
      ? [{ target: 'window', type: 'keydown', listener: onWindowKeyDown, options: true }]
      : [],
    [isActive, onWindowKeyDown],
  );

  // 资源管理器面板：宽/中窗作为并排侧栏；窄窗（compact）复用为全屏内联「文件」子屏（P0-5 去抽屉化）
  const explorerSurface = (
    <WorkbenchSidebarSurface
        ariaLabel={t('notesWorkspace.explorer.title', 'Files')}
        ref={explorerRef}
        className="notes-explorer"
        data-notes-explorer
      >
        <header>
          <span>{t('notesWorkspace.explorer.title', 'Files')}</span>
          <div>
            <IconButton
              label={t('notesWorkspace.navigation.back', 'Back')}
              disabled={!navHistory.canBack}
              onClick={() => { void navHistory.runNavigation('back', activateHistoryEntry); }}
            ><ArrowLeft size={15} /></IconButton>
            <IconButton
              label={t('notesWorkspace.navigation.forward', 'Forward')}
              disabled={!navHistory.canForward}
              onClick={() => { void navHistory.runNavigation('forward', activateHistoryEntry); }}
            ><ArrowRight size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.explorer.newNote', 'New note')} onClick={() => void createResource('note')}><FileText size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.explorer.newFolder', 'New folder')} onClick={() => { setDialogError(null); setResourceDialog({ mode: 'create-folder', value: '', parentId: selectedFolderId }); }}><FolderPlus size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.explorer.newMindmap', 'New mind map')} onClick={() => void createResource('mindmap')}><TreeStructure size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.explorer.refresh', 'Refresh')} onClick={() => void loadResources({ blocking: false })}><ArrowsClockwise size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.ribbon.search', 'Search notes')} onClick={() => openSearchOverlay('full-text')}><MagnifyingGlass size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.ribbon.backlinks', 'Linked notes')} data-active={backlinksOpen ? 'true' : 'false'} onClick={() => setBacklinksOpen((open) => !open)}><LinkSimple size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.ribbon.trash', 'Trash')} onClick={() => setTrashOpen(true)}><Trash size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.library.manage', 'Import or export library')} onClick={() => setLibraryDialog({ open: true, tab: 'export' })}><FileArchive size={15} /></IconButton>
          </div>
        </header>
        <div className="notes-search">
          <MagnifyingGlass size={14} aria-hidden />
          <input
            className="notes-search-input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('notesWorkspace.search.placeholder', 'Search files...')}
            aria-label={t('notesWorkspace.search.aria', 'Search files')}
          />
          {query && <IconButton label={t('notesWorkspace.search.clear', 'Clear search')} onClick={() => setQuery('')}><X size={12} /></IconButton>}
        </div>
        <TagFilter
          selectedTags={selectedTags}
          onChange={setSelectedTags}
          className="notes-explorer-tag-filter"
        />
        <FavoritesSection
          items={favorites.items}
          activeId={activeTab?.id ?? null}
          onOpen={(item) => {
            void openResource({ type: item.type, id: item.id }, item.name);
            closeExplorerIfCompact();
          }}
          onUnfavorite={(item) => {
            void favorites.setFavorite(item.id, item.type, false, { path: item.path, name: item.name });
          }}
        />
        {resourceDialog?.mode === 'create-folder' && (
          <div className="notes-inline-create ui-rise-in" data-notes-inline-create>
            <div className="notes-inline-create-row">
              <FolderPlus size={14} aria-hidden />
              <input
                autoFocus
                value={resourceDialog.value}
                placeholder={t('notesWorkspace.dialog.createFolderTitle', 'New folder')}
                aria-label={t('notesWorkspace.dialog.createFolderTitle', 'New folder')}
                onChange={(event) => {
                  setDialogError(null);
                  setResourceDialog({
                    mode: 'create-folder',
                    // 输入侧就地清洗：粘贴内容折叠换行、去控制字符、按 500 字符截断
                    //（与后端 note_repo validate_title 限额一致）
                    value: sanitizeNoteTitleInput(event.target.value),
                    parentId: resourceDialog.parentId,
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    event.stopPropagation();
                    setDialogError(null);
                    setResourceDialog(null);
                    return;
                  }
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  void createFolder();
                }}
                onBlur={() => {
                  setDialogError(null);
                  setResourceDialog(null);
                }}
              />
            </div>
            {countNoteInputChars(resourceDialog.value) > NOTE_TITLE_COUNT_WARN_THRESHOLD && (
              <p
                className="notes-inline-counter"
                data-at-limit={countNoteInputChars(resourceDialog.value) >= NOTE_TITLE_MAX_CHARS ? 'true' : undefined}
                aria-live="polite"
              >
                {t('notesWorkspace.validation.charCount', {
                  defaultValue: '{{count}} / {{max}}',
                  count: countNoteInputChars(resourceDialog.value),
                  max: NOTE_TITLE_MAX_CHARS,
                })}
              </p>
            )}
            {dialogError && <p className="notes-inline-error" role="alert">{dialogError}</p>}
          </div>
        )}
        {(resourceDialog?.mode === 'delete' || resourceDialog?.mode === 'delete-many') && (
          <div
            className="notes-inline-confirm ui-rise-in"
            data-notes-inline-confirm
            role="group"
            aria-label={t('notesWorkspace.dialog.deleteTitle', 'Move to trash')}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return;
              event.preventDefault();
              event.stopPropagation();
              setDialogError(null);
              setResourceDialog(null);
            }}
          >
            <p className="notes-inline-confirm-copy">
              {resourceDialog.mode === 'delete'
                ? t('notesWorkspace.dialog.deleteDescription', {
                  defaultValue: 'Move "{{name}}" to the trash?',
                  name: getExplorerTargetName(resourceDialog.target),
                })
                : t('notesWorkspace.dialog.deleteManyDescription', {
                  defaultValue: 'Move {{count}} selected items to the trash?',
                  count: resourceDialog.targets.length,
                })}
            </p>
            {dialogError && <p className="notes-inline-error" role="alert">{dialogError}</p>}
            <div className="notes-inline-confirm-actions">
              <button
                type="button"
                onClick={() => {
                  setDialogError(null);
                  setResourceDialog(null);
                }}
              >
                {t('notesWorkspace.dialog.cancel', 'Cancel')}
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => {
                  if (resourceDialog.mode === 'delete') void deleteContextResource();
                  else void deleteContextResources();
                }}
              >
                {t('notesWorkspace.dialog.delete', 'Delete')}
              </button>
            </div>
          </div>
        )}
        <div className="notes-tree-host" aria-live="polite">
          {loading && !hasTreeItems ? (
            <div
              className="notes-tree"
              role="tree"
              aria-label={t('notesWorkspace.tree.aria')}
              aria-busy="true"
            >
              <div
                className="nes-tree-skeleton notes-tree-loading"
                aria-label={t('notesWorkspace.tree.loading', 'Loading files')}
              >
                {TREE_SKELETON_ROWS.map((row, index) => (
                  <div
                    key={index}
                    className="nes-tree-skeleton__row"
                    style={{ '--nes-indent': row.indent } as React.CSSProperties}
                  >
                    <i
                      className="nes-tree-skeleton__bar"
                      style={{ '--nes-bar-w': row.width } as React.CSSProperties}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : loadError && !hasTreeItems ? (
            <div
              className="notes-tree"
              role="tree"
              aria-label={t('notesWorkspace.tree.aria')}
              aria-busy="false"
            >
              <div className="notes-tree-message" data-state="error">
                <span>{t('notesWorkspace.tree.loadFailed', 'Could not load files')}</span>
                <button type="button" onClick={() => void loadResources({ blocking: true })}>{t('notesWorkspace.tree.retry', 'Retry')}</button>
              </div>
            </div>
          ) : !hasTreeItems ? (
            <div
              className="notes-tree"
              role="tree"
              aria-label={t('notesWorkspace.tree.aria')}
              aria-busy="false"
            >
              <div className="nes-tree-empty notes-tree-message" data-state="empty">
                {query || selectedTags.length > 0 ? (
                  <>
                    <p className="nes-tree-empty__message">
                      {t('notesWorkspace.tree.noMatches', {
                        defaultValue: 'No files match "{{query}}"',
                        query: query || selectedTags.join(', '),
                      })}
                    </p>
                    <button
                      type="button"
                      className="nes-action"
                      onClick={() => { setQuery(''); setSelectedTags([]); }}
                    >
                      {t('notesWorkspace.tree.showAll', 'Show all files')}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="nes-tree-empty__icon" aria-hidden>
                      <Notebook size={32} weight="thin" />
                    </div>
                    <p className="nes-tree-empty__title">
                      {t('workbench:notesWorkspace.empty.treeTitle')}
                    </p>
                    <div className="nes-tree-empty__actions">
                      <button
                        type="button"
                        className="nes-action"
                        onClick={() => void createResource('note')}
                      >
                        <FileText size={13} aria-hidden />
                        {t('workbench:notesWorkspace.empty.treeNewNote')}
                      </button>
                      <button
                        type="button"
                        className="nes-action nes-action--ghost"
                        onClick={() => {
                          setDialogError(null);
                          setResourceDialog({ mode: 'create-folder', value: '', parentId: selectedFolderId });
                        }}
                      >
                        <FolderPlus size={13} aria-hidden />
                        {t('workbench:notesWorkspace.empty.treeNewFolder')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          ) : (
            <NotesWorkspaceTree
              items={treeItems}
              expandedIds={expandedIds}
              selectedId={selectedTreeId ?? selectedFolderId}
              activeId={activeTab?.id ?? null}
              aria-busy={loading}
              rootLabel={t('notesWorkspace.tree.root')}
              onToggleExpand={toggleTreeExpand}
              onExpand={expandTreeFolder}
              onSelect={selectTreeItem}
              onOpen={openTreeItem}
              onMove={(dragId, targetId, position) => { void moveTreeItem(dragId, targetId, position); }}
              onRename={(id, name) => { void renameTreeItem(id, name); }}
              onDelete={requestDeleteTreeItem}
              onDeleteMany={requestDeleteTreeItems}
              getMenuItems={getTreeMenuItems}
            />
          )}
        </div>
      </WorkbenchSidebarSurface>
  );

  return (
    <>
      {titlebarTarget ? createPortal(
        <WorkspaceTabs
          tabs={tabs}
          activeKey={activeTab?.key ?? null}
          rightTabKey={splitTab?.key ?? null}
          onActivate={activateTab}
          onClose={closeTab}
          onReorder={reorderTabs}
          onOpenContextMenu={openTabContextMenu}
          onNewTab={() => { void createResource('note'); }}
          contextMenuKey={tabContextMenu?.key ?? null}
          leftOffset={titlebarTabsLeft}
          saveStates={saveStates}
        />,
        titlebarTarget,
      ) : null}
      <div
        ref={hostRef}
        className="notes-workspace"
        data-wb-notes-workspace
        data-focus-mode={focusMode ? 'true' : 'false'}
        data-compact={sizeClass === 'compact' ? 'true' : 'false'}
        data-explorer-open={sizeClass === 'compact' ? (explorerOpen ? 'true' : 'false') : 'true'}
        onKeyDown={handleWorkspaceKeyDown}
        onDragOver={(event) => {
          if (!Array.from(event.dataTransfer.files).some((file) => /\.md(?:own)?$/i.test(file.name))) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = 'copy';
        }}
        onDrop={(event) => {
          const files = Array.from(event.dataTransfer.files);
          if (!files.some((file) => /\.md(?:own)?$/i.test(file.name))) return;
          event.preventDefault();
          void importDroppedMarkdown(files);
        }}
      >
      <WorkbenchSidebarLayout
        sizeClass={sizeClass}
        navLabel={t('notesWorkspace.explorer.title', 'Files')}
        drawerOpen={sizeClass === 'compact' ? false : explorerOpen}
        onDrawerOpenChange={setExplorerOpen}
        sidebar={sizeClass === 'compact' ? null : explorerSurface}
      >

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
              defaultSize={splitTab ? splitLayout[0] : 100}
              minSize={splitTab ? 25 : 100}
              className="notes-pane-panel"
            >
              <WorkspacePane
                paneId="main"
                tabs={mainTabs}
                activeKey={mainActiveTab?.key ?? null}
                windowId={windowId}
                workspaceActive={isActive && resolvedFocusedPane === 'main'}
                onActivate={activateTab}
                onTitleChange={updateTabTitle}
                onSaveStateChange={updateTabSaveState}
                onCreateNote={() => { void createResource('note'); }}
                onOpenSearch={() => openSearchOverlay('quick-open')}
                onImport={() => setLibraryDialog({ open: true, tab: 'import' })}
                onAskAgent={() => { void openQuickAssistantWindow(); }}
              />
            </Panel>
            {splitTab && (
              <>
                <PanelResizeHandle
                  className="notes-pane-resize"
                  aria-label={t('notesWorkspace.panes.resize', 'Resize split panes')}
                />
                <Panel
                  id="notes-workspace-right-pane"
                  order={2}
                  defaultSize={splitLayout[1]}
                  minSize={25}
                  className="notes-pane-panel"
                >
                  <WorkspacePane
                    paneId="right"
                    tabs={[splitTab]}
                    activeKey={splitTab.key}
                    windowId={windowId}
                    workspaceActive={isActive && resolvedFocusedPane === 'right'}
                    onActivate={activateTab}
                    onTitleChange={updateTabTitle}
                    onSaveStateChange={updateTabSaveState}
                    onCreateNote={() => { void createResource('note'); }}
                    onOpenSearch={() => openSearchOverlay('quick-open')}
                    onImport={() => setLibraryDialog({ open: true, tab: 'import' })}
                    onAskAgent={() => { void openQuickAssistantWindow(); }}
                  />
                </Panel>
              </>
            )}
          </PanelGroup>
          <NotesBacklinksPanel
            open={backlinksOpen}
            requestedTab={backlinksRequestedTab}
            activeResource={activeResource}
            notes={resources}
            onOpenResource={openWorkspaceSearchResult}
            onClose={() => setBacklinksOpen(false)}
            onCreateFromUnresolved={createFromUnresolved}
            onRefresh={() => { void loadResources({ blocking: false }); }}
            propertiesContent={(
              <NotesPropertiesTab
                activeResource={activeResource}
                onRefresh={() => { void loadResources({ blocking: false }); }}
              />
            )}
          />
        </div>
        <footer className="notes-statusbar" data-notes-statusbar>
          <span>{status}</span>
          <span>{activeTab
            ? `${activeTab.type === 'note'
              ? t('notesWorkspace.status.noteType', 'Markdown')
              : t('notesWorkspace.status.mindmapType', 'Mind map')} · ${saveStates.get(activeTab.key) === 'saving'
              ? t('notesWorkspace.saveState.saving', 'Saving')
              : saveStates.get(activeTab.key) === 'dirty'
                ? t('notesWorkspace.saveState.dirty', 'Unsaved')
                : t('notesWorkspace.saveState.saved', 'Saved')}`
            : t('notesWorkspace.status.library', 'Local library')}</span>
        </footer>
      </main>
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
        <div ref={contextMenuRef} id="notes-tab-context-menu" className="notes-context-menu notes-tab-context-menu" role="menu" style={{ left: tabContextMenu.x, top: tabContextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={Boolean(tabContextTarget.pinned)}
            onClick={() => {
              toggleTabPinned(tabContextTarget.key);
              restoreTabContextFocusRef.current = true;
              setTabContextMenu(null);
            }}
          >
            {tabContextTarget.pinned ? <PushPinSlash size={14} aria-hidden /> : <PushPin size={14} aria-hidden />}
            {tabContextTarget.pinned
              ? t('notesWorkspace.tabs.unpin', { defaultValue: 'Unpin {{title}}', title: tabContextTarget.title })
              : t('notesWorkspace.tabs.pin', { defaultValue: 'Pin {{title}}', title: tabContextTarget.title })}
          </button>
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={tabContextTarget.key === splitTab?.key}
            disabled={tabContextTarget.key !== splitTab?.key && tabs.length <= 1}
            onClick={() => {
              toggleTabRightSplit(tabContextTarget.key);
              restoreTabContextFocusRef.current = true;
              setTabContextMenu(null);
            }}
          >
            <SidebarSimple size={14} aria-hidden />
            {tabContextTarget.key === splitTab?.key
              ? t('notesWorkspace.tabs.closeRightSplit', { defaultValue: 'Close {{title}} from right split', title: tabContextTarget.title })
              : t('notesWorkspace.tabs.openInRightSplit', { defaultValue: 'Open {{title}} in right split', title: tabContextTarget.title })}
          </button>
          <div role="separator" className="notes-context-menu-separator" />
          <button
            type="button"
            role="menuitem"
            className="is-danger"
            onClick={() => {
              void closeTab(tabContextTarget.key);
              restoreTabContextFocusRef.current = true;
              setTabContextMenu(null);
            }}
          >
            {t('notesWorkspace.tabs.close', { defaultValue: 'Close {{title}}', title: tabContextTarget.title })}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!tabContextCanCloseOthers}
            onClick={() => {
              closeOtherTabs(tabContextTarget.key);
              restoreTabContextFocusRef.current = true;
              setTabContextMenu(null);
            }}
          >
            {t('notesWorkspace.tabs.closeOthers', 'Close other tabs')}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!tabContextCanCloseRight}
            onClick={() => {
              closeTabsToRight(tabContextTarget.key);
              restoreTabContextFocusRef.current = true;
              setTabContextMenu(null);
            }}
          >
            {t('notesWorkspace.tabs.closeTabsToRight', 'Close tabs to the right')}
          </button>
        </div>
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
