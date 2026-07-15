import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import i18next from 'i18next';
import { useTranslation } from 'react-i18next';
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from 'react-resizable-panels';
import {
  ArrowsClockwise,
  CaretDown,
  FileText,
  Files,
  FolderPlus,
  FolderSimple,
  LinkSimple,
  MagnifyingGlass,
  NotePencil,
  PushPin,
  PushPinSlash,
  SidebarSimple,
  TreeStructure,
  Trash,
  X,
} from '@phosphor-icons/react';
import { dstu, createEmpty, folderApi, trashApi, type DstuNode } from '@/dstu';
import { DSTU_FOLDER_CHANGE_EVENT } from '@/dstu/folderEvents';
import UnifiedAppPanel from '@/features/learning-hub/apps/UnifiedAppPanel';
import { MindMapContentView } from '@/features/mindmap/MindMapContentView';
import { getMindMapStoreForInstance } from '@/features/mindmap/store';
import { exportResourceById } from '@/features/learning-hub/utils/exportResource';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { COMMAND_EVENTS } from '@/command-palette/hooks/useCommandEvents';
import {
  NOTES_WORKSPACE_COMMAND_EVENT,
  type NotesWorkspaceCommandAction,
  type NotesWorkspaceCommandDetail,
} from '@/command-palette/modules/notes.commands';
import { cn } from '@/lib/utils';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import type { FolderTreeNode, VfsFolder } from '@/dstu/types/folder';
import { requestContentCloseConfirmation } from '../content/ContentCloseConfirmation';
import { isContentDirty } from '../content/contentDirtyRegistry';
import type { AppWindowProps } from '../../core/types';
import {
  forgetWorkspaceResource,
  registerWorkspaceHost,
  setWorkspaceActiveResource,
  type NotesWorkspaceResourceRef,
} from './workspaceRegistry';
import { NotesBacklinksPanel } from './NotesBacklinksPanel';
import { NotesSearchOverlay, type NotesSearchMode } from './NotesSearchOverlay';
import './NotesWorkspaceApp.css';

type ResourceType = NotesWorkspaceResourceRef['type'];

interface WorkspaceTab extends NotesWorkspaceResourceRef {
  key: string;
  title: string;
  pinned?: boolean;
}

type SaveState = 'saved' | 'saving' | 'dirty';
type WorkspacePaneId = 'main' | 'right';
type SplitLayout = [number, number];
type TrashItemType = ResourceType | 'folder';
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

function canDropExplorerItemIntoFolder(item: DraggedExplorerItem, folder: TreeFolder): boolean {
  if (!folder.id) return false;
  if (item.kind === 'resource') return true;
  return folder.id !== item.folder.id && !folder.path.startsWith(`${item.folder.path}/`);
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

type DraggedExplorerItem =
  | { kind: 'resource'; node: DstuNode }
  | { kind: 'folder'; folder: TreeFolder };

type ResourceDialog =
  | { mode: 'rename' | 'delete'; target: ExplorerTarget; value: string }
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
  explorerWidth: number;
  collapsedFolderPaths: string[];
}

const resourceType = (value: unknown): ResourceType | null =>
  value === 'note' || value === 'mindmap' ? value : null;

const trashItemType = (value: unknown): TrashItemType | null =>
  value === 'folder' ? 'folder' : resourceType(value);

const treeResourceKey = (type: string, id: string): string => `${type}:${id}`;

const ROOT_TREE_DROP_TARGET = '__notes-workspace-root__';
const EMPTY_RESOURCE_FOLDER_IDS: ReadonlyMap<string, string> = new Map();

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
    explorerWidth: 240,
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
      explorerWidth: typeof value.explorerWidth === 'number'
        ? Math.max(200, Math.min(360, value.explorerWidth))
        : 240,
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

const TrashGlyph: React.FC<{ type: TrashItemType; size?: number }> = ({ type, size = 15 }) =>
  type === 'folder'
    ? <FolderSimple size={size} weight="fill" aria-hidden />
    : <ResourceGlyph type={type} size={size} />;

interface TreeBranchProps {
  folder: TreeFolder;
  depth?: number;
  activeId: string | null;
  selectedFolderId: string | null;
  collapsedFolderPaths: ReadonlySet<string>;
  dragOverFolderPath: string | null;
  onOpen: (ref: NotesWorkspaceResourceRef, title?: string) => void;
  onContextMenu: (event: React.MouseEvent, node: DstuNode) => void;
  onFolderContextMenu: (event: React.MouseEvent, folder: TreeFolder) => void;
  onToggleFolder: (folder: TreeFolder) => void;
  onSelectFolder: (folder: TreeFolder) => void;
  onResourceDragStart: (event: React.DragEvent, node: DstuNode) => void;
  onFolderDragStart: (event: React.DragEvent, folder: TreeFolder) => void;
  onDragEnd: () => void;
  onDragOverFolder: (event: React.DragEvent, folder: TreeFolder) => void;
  onDragLeaveFolder: (event: React.DragEvent, folder: TreeFolder) => void;
  onDropIntoFolder: (event: React.DragEvent, folder: TreeFolder) => void;
}

const TreeBranch: React.FC<TreeBranchProps> = ({
  folder,
  depth = 0,
  activeId,
  selectedFolderId,
  collapsedFolderPaths,
  dragOverFolderPath,
  onOpen,
  onContextMenu,
  onFolderContextMenu,
  onToggleFolder,
  onSelectFolder,
  onResourceDragStart,
  onFolderDragStart,
  onDragEnd,
  onDragOverFolder,
  onDragLeaveFolder,
  onDropIntoFolder,
}) => {
  const { t } = useTranslation('workbench');
  const expanded = !collapsedFolderPaths.has(folder.path);
  const folders = [...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
  const resources = [...folder.resources].sort((a, b) => a.name.localeCompare(b.name));
  const level = depth + 1;
  return (
    <>
      {folder.name && (
        <button
          type="button"
          className="notes-tree-row notes-tree-folder"
          role="treeitem"
          data-notes-tree-item
          data-notes-tree-folder
          data-depth={level}
          data-expanded={expanded ? 'true' : 'false'}
          data-selected={selectedFolderId === folder.id ? 'true' : 'false'}
          data-drop-target={dragOverFolderPath === folder.path ? 'true' : 'false'}
          style={{ paddingLeft: 8 + depth * 14 }}
          onClick={() => {
            onSelectFolder(folder);
            onToggleFolder(folder);
          }}
          onContextMenu={(event) => onFolderContextMenu(event, folder)}
          draggable={Boolean(folder.id)}
          onDragStart={(event) => onFolderDragStart(event, folder)}
          onDragEnd={onDragEnd}
          onDragOver={(event) => onDragOverFolder(event, folder)}
          onDragLeave={(event) => onDragLeaveFolder(event, folder)}
          onDrop={(event) => onDropIntoFolder(event, folder)}
          aria-expanded={expanded}
          aria-selected={selectedFolderId === folder.id}
          aria-level={level}
          aria-label={t('notesWorkspace.tree.folder', { defaultValue: 'Folder: {{name}}', name: folder.name })}
        >
          <CaretDown size={12} className={expanded ? '' : 'is-collapsed'} aria-hidden />
          <FolderSimple size={15} weight="fill" aria-hidden />
          <span>{folder.name}</span>
        </button>
      )}
      {(folder.name ? expanded : true) && (
        <div role={folder.name ? 'group' : undefined}>
          {folders.map((child) => (
            <TreeBranch
              key={child.path}
              folder={child}
              depth={folder.name ? depth + 1 : depth}
              activeId={activeId}
              selectedFolderId={selectedFolderId}
              collapsedFolderPaths={collapsedFolderPaths}
              dragOverFolderPath={dragOverFolderPath}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              onFolderContextMenu={onFolderContextMenu}
              onToggleFolder={onToggleFolder}
              onSelectFolder={onSelectFolder}
              onResourceDragStart={onResourceDragStart}
              onFolderDragStart={onFolderDragStart}
              onDragEnd={onDragEnd}
              onDragOverFolder={onDragOverFolder}
              onDragLeaveFolder={onDragLeaveFolder}
              onDropIntoFolder={onDropIntoFolder}
            />
          ))}
          {resources.map((node) => {
            const type = node.type as ResourceType;
            return (
              <button
                type="button"
                key={node.id}
                className="notes-tree-row notes-tree-resource"
                role="treeitem"
                data-notes-tree-item
                data-depth={folder.name ? level + 1 : level}
                data-active={activeId === node.id ? 'true' : 'false'}
                style={{ paddingLeft: 25 + (folder.name ? depth : 0) * 14 }}
                onClick={() => onOpen({ type, id: node.id }, node.name)}
                onContextMenu={(event) => onContextMenu(event, node)}
                draggable
                onDragStart={(event) => onResourceDragStart(event, node)}
                onDragEnd={onDragEnd}
                data-resource-type={type}
                data-resource-id={node.id}
                aria-selected={activeId === node.id}
                aria-level={folder.name ? level + 1 : level}
              >
                <ResourceGlyph type={type} />
                <span>{node.name}</span>
              </button>
            );
          })}
        </div>
      )}
    </>
  );
};

interface WorkspacePaneProps {
  paneId: WorkspacePaneId;
  tabs: WorkspaceTab[];
  activeKey: string | null;
  windowId: string;
  workspaceActive: boolean;
  onActivate: (key: string) => void;
  onTitleChange: (key: string, title: string) => void;
  onSaveStateChange: (key: string, state: SaveState) => void;
}

const WorkspacePane: React.FC<WorkspacePaneProps> = ({
  paneId,
  tabs,
  activeKey,
  windowId,
  workspaceActive,
  onActivate,
  onTitleChange,
  onSaveStateChange,
}) => {
  const { t } = useTranslation('workbench');
  const active = tabs.find((tab) => tab.key === activeKey) ?? null;
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
          <div className="notes-empty-pane">
            <NotePencil size={34} weight="thin" aria-hidden />
            <span>{t('notesWorkspace.emptyPane', 'Select a note or mind map')}</span>
          </div>
        )}
        {tabs.map((tab) => {
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
                  onTitleChange={(title) => onTitleChange(tab.key, title)}
                  onSaveStateChange={(state) => onSaveStateChange(tab.key, state)}
                  className="h-full"
                />
              ) : (
                <MindMapContentView
                  resourceId={tab.id}
                  storeInstanceId={`${windowId}:${tab.key}`}
                  isActive={workspaceActive && visible}
                  focusOnActive={workspaceActive && visible}
                  onTitleChange={(title) => onTitleChange(tab.key, title)}
                  onSaveStateChange={(state) => onSaveStateChange(tab.key, state)}
                  className="h-full"
                />
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
  canOpenRightSplit: boolean;
  onActivate: (key: string) => void;
  onClose: (key: string) => void | Promise<boolean>;
  onToggleRightSplit: (key: string) => void;
  onReorder: (draggedKey: string, targetKey: string, position: TabDropPosition) => void;
  onOpenContextMenu: (key: string, x: number, y: number, trigger: HTMLElement) => void;
  contextMenuKey: string | null;
  leftOffset: number;
  saveStates: Map<string, SaveState>;
}

const WorkspaceTabs: React.FC<WorkspaceTabsProps> = ({
  tabs,
  activeKey,
  rightTabKey,
  canOpenRightSplit,
  onActivate,
  onClose,
  onToggleRightSplit,
  onReorder,
  onOpenContextMenu,
  contextMenuKey,
  leftOffset,
  saveStates,
}) => {
  const { t } = useTranslation('workbench');
  const stripRef = useRef<HTMLDivElement>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{ key: string; position: TabDropPosition } | null>(null);

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
    <div ref={stripRef} className="notes-tabstrip" data-notes-tabstrip role="tablist" aria-label={t('notesWorkspace.tabs.aria', 'Open files')}>
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
          <IconButton
            className="notes-tab-split-button"
            label={isRightSplitTab
              ? t('notesWorkspace.tabs.closeRightSplit', { defaultValue: 'Close {{title}} from right split', title: tab.title })
              : t('notesWorkspace.tabs.openInRightSplit', { defaultValue: 'Open {{title}} in right split', title: tab.title })}
            aria-pressed={isRightSplitTab}
            disabled={!isRightSplitTab && !canOpenRightSplit}
            onClick={() => onToggleRightSplit(tab.key)}
          >
            <SidebarSimple size={12} />
          </IconButton>
        </div>
      );})}
    </div>
  </div>
  );
};

export const NotesWorkspaceApp: React.FC<AppWindowProps> = ({
  windowId,
  instanceKey,
  launchPayload,
  isActive,
  onTitleChange,
}) => {
  const { t } = useTranslation('workbench');
  const persistedStateRef = useRef(readPersistedWorkspaceState());
  const persistedState = persistedStateRef.current;
  const hostRef = useRef<HTMLDivElement>(null);
  const explorerRef = useRef<HTMLElement>(null);
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
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchMode, setSearchMode] = useState<NotesSearchMode>('quick-open');
  const [explorerOpen, setExplorerOpen] = useState(() => persistedState.explorerOpen);
  const [explorerWidth, setExplorerWidth] = useState(() => persistedState.explorerWidth);
  const [collapsedFolderPaths, setCollapsedFolderPaths] = useState<Set<string>>(
    () => new Set(persistedState.collapsedFolderPaths),
  );
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [draggedItem, setDraggedItem] = useState<DraggedExplorerItem | null>(null);
  const [dragOverFolderPath, setDragOverFolderPath] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  const [titlebarTarget, setTitlebarTarget] = useState<HTMLElement | null>(null);
  const [status, setStatus] = useState(() => t('notesWorkspace.status.ready', 'Ready'));
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tabSaveStates, setTabSaveStates] = useState<Record<string, SaveState>>({});
  const [contextMenu, setContextMenu] = useState<{ target: ExplorerTarget; x: number; y: number } | null>(null);
  const [tabContextMenu, setTabContextMenu] = useState<TabContextMenu | null>(null);
  const [resourceDialog, setResourceDialog] = useState<ResourceDialog | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashItems, setTrashItems] = useState<DstuNode[]>([]);
  const [trashError, setTrashError] = useState<string | null>(null);
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const trashDialogRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const tabContextTriggerRef = useRef<HTMLElement | null>(null);
  const restoreTabContextFocusRef = useRef(false);
  const treeTypeaheadRef = useRef<{ value: string; timer: number | null }>({ value: '', timer: null });
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
    return term ? resources.filter((node) => node.name.toLocaleLowerCase().includes(term)) : resources;
  }, [query, resources]);
  const tree = useMemo(
    () => buildTree(
      filteredResources,
      query.trim() ? [] : folders,
      query.trim() ? EMPTY_RESOURCE_FOLDER_IDS : resourceFolderIds,
    ),
    [filteredResources, folders, query, resourceFolderIds],
  );
  const hasTreeItems = tree.folders.size > 0 || tree.resources.length > 0;
  const titlebarTabsLeft = Math.max(76, 44 + (explorerOpen && !compact ? explorerWidth : 0));
  const saveStates = useMemo(
    () => new Map(tabs.map((tab) => [tab.key, tabSaveStates[tab.key] ?? getTabSaveState(tab, windowId)])),
    [tabSaveStates, tabs, windowId],
  );

  useLayoutEffect(() => {
    const findTarget = () => {
      const target = Array.from(document.querySelectorAll<HTMLElement>('[data-wb-titlebar-slot]'))
        .find((element) => element.dataset.windowId === windowId) ?? null;
      setTitlebarTarget((current) => current === target ? current : target);
    };
    findTarget();
    const observer = new MutationObserver(findTarget);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
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
      return;
    }
    focusedPaneRef.current = 'main';
    setFocusedPane('main');
    setActiveTabKey(key);
  }, []);

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
    return new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  }, [t]);

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

  const renameContextResource = useCallback(async () => {
    if (!resourceDialog || resourceDialog.mode !== 'rename') return;
    const name = resourceDialog.value.trim();
    const target = resourceDialog.target;
    if (!name) {
      setDialogError(t('notesWorkspace.dialog.nameRequired', 'Enter a name.'));
      return;
    }
    if (name === getExplorerTargetName(target)) {
      setResourceDialog(null);
      return;
    }
    if (target.kind === 'resource') {
      const result = await dstu.rename(target.node.path || `/${target.node.id}`, name);
      if (!result.ok) {
        const message = result.error.toUserMessage();
        setStatus(message);
        setDialogError(message);
        return;
      }
      updateTabTitle(`${target.node.type}:${target.node.id}`, name);
    } else {
      const result = await folderApi.renameFolder(target.id, name);
      if (!result.ok) {
        const message = result.error.toUserMessage();
        setStatus(message);
        setDialogError(message);
        return;
      }
    }
    setDialogError(null);
    setResourceDialog(null);
    await loadResources({ blocking: false });
  }, [loadResources, resourceDialog, t, updateTabTitle]);

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

  const createFolder = useCallback(async () => {
    if (!resourceDialog || resourceDialog.mode !== 'create-folder') return;
    const name = resourceDialog.value.trim();
    if (!name) {
      setDialogError(t('notesWorkspace.dialog.nameRequired', 'Enter a name.'));
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

  const createResource = useCallback(async (type: ResourceType) => {
    setStatus(t(
      type === 'note' ? 'notesWorkspace.status.creatingNote' : 'notesWorkspace.status.creatingMindmap',
      type === 'note' ? 'Creating note...' : 'Creating mind map...',
    ));
    const result = await createEmpty({ type, folderId: selectedFolderId ?? undefined });
    if (!result.ok) {
      setStatus(result.error.toUserMessage());
      return;
    }
    await loadResources({ blocking: false });
    await openResource({ type, id: result.value.id }, result.value.name);
  }, [loadResources, openResource, selectedFolderId, t]);

  const loadTrash = useCallback(async () => {
    setTrashLoading(true);
    setTrashError(null);
    const result = await trashApi.listTrash(100, 0);
    if (!result.ok) {
      setTrashError(result.error.toUserMessage());
    } else {
      setTrashItems(result.value.filter((node) => trashItemType(node.type)));
    }
    setTrashLoading(false);
  }, []);

  const restoreTrashItem = useCallback(async (node: DstuNode) => {
    const type = trashItemType(node.type);
    if (!type) return;
    const result = await trashApi.restoreItem(node.id, type);
    if (!result.ok) {
      setTrashError(result.error.toUserMessage());
      return;
    }
    setTrashItems((current) => current.filter((item) => item.id !== node.id));
    setStatus(t('notesWorkspace.status.restored', { defaultValue: '{{name}} restored', name: node.name }));
    await loadResources({ blocking: false });
  }, [loadResources, t]);

  const closeTrash = useCallback(() => setTrashOpen(false), []);

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
        explorerWidth,
        collapsedFolderPaths: [...collapsedFolderPaths].sort(),
      } satisfies PersistedWorkspaceState));
    } catch {
      // Local storage is a convenience only; a private browser context must
      // not prevent the workspace from opening.
    }
  }, [backlinksOpen, collapsedFolderPaths, explorerOpen, explorerWidth, mainActiveTab?.key, resolvedFocusedPane, splitLayout, splitTab?.key, tabs]);

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
      const nextCompact = entry.contentRect.width < 720;
      setCompact(nextCompact);
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const explorer = explorerRef.current;
    if (!explorer) return;
    if (compact && !explorerOpen) explorer.setAttribute('inert', '');
    else explorer.removeAttribute('inert');
  }, [compact, explorerOpen]);

  useEffect(() => {
    if (!contextMenu && !tabContextMenu) return;
    const dismiss = (event?: Event) => {
      if (event?.target instanceof Node && contextMenuRef.current?.contains(event.target)) return;
      if (tabContextMenu) {
        restoreTabContextFocusRef.current = event instanceof KeyboardEvent && event.key === 'Escape';
      }
      setContextMenu(null);
      setTabContextMenu(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(event); };
    // Tabs stop bubbling pointer events so the window shell cannot start a
    // drag. Use capture here to still dismiss a stale menu before another tab
    // is selected or dragged, while retaining clicks inside the menu itself.
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('click', dismiss, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('click', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu, tabContextMenu]);

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

  useEffect(() => {
    if (!resourceDialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusInitial = () => {
      const focusable = dialogRef.current?.querySelector<HTMLElement>(
        'input:not([disabled]), button:not([disabled])',
      );
      focusable?.focus();
    };
    const frame = window.requestAnimationFrame(focusInitial);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setResourceDialog(null);
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled])',
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus();
    };
  }, [resourceDialog]);

  useEffect(() => {
    if (trashOpen) void loadTrash();
  }, [loadTrash, trashOpen]);

  useEffect(() => {
    if (!trashOpen) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusable = () => Array.from(trashDialogRef.current?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const frame = window.requestAnimationFrame(() => focusable()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTrash();
        return;
      }
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKeyDown, true);
      previouslyFocused?.focus();
    };
  }, [closeTrash, trashOpen]);

  useEffect(() => {
    if (!isActive) return;
    const onKeyDown = (event: KeyboardEvent) => {
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
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isActive]);

  const focusExplorerSearch = useCallback(() => {
    setExplorerOpen(true);
    window.setTimeout(() => hostRef.current?.querySelector<HTMLInputElement>('.notes-search-input')?.focus(), 0);
  }, []);

  const openSearchOverlay = useCallback((mode: NotesSearchMode) => {
    setSearchMode(mode);
    setSearchOpen(true);
  }, []);

  const openWorkspaceSearchResult = useCallback(async (node: DstuNode) => {
    const type = resourceType(node.type);
    if (!type) return;
    await openResource({ type, id: node.id }, node.name);
  }, [openResource]);

  useEffect(() => {
    if (!isActive) return;
    const onWorkspaceCommand = (event: Event) => {
      const action = (event as CustomEvent<NotesWorkspaceCommandDetail>).detail?.action as NotesWorkspaceCommandAction | undefined;
      switch (action) {
        case 'create-note':
          void createResource('note');
          break;
        case 'create-folder':
          setDialogError(null);
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
          setBacklinksOpen((open) => !open);
          break;
        case 'toggle-outline':
          window.dispatchEvent(new CustomEvent(COMMAND_EVENTS.NOTES_TOGGLE_OUTLINE));
          break;
        case 'export-current':
          if (activeTabRef.current) {
            void exportResourceById(
              activeTabRef.current.id,
              i18next.getFixedT(i18next.language, 'learningHub'),
            );
          }
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
    };
    window.addEventListener(NOTES_WORKSPACE_COMMAND_EVENT, onWorkspaceCommand);
    return () => window.removeEventListener(NOTES_WORKSPACE_COMMAND_EVENT, onWorkspaceCommand);
  }, [createResource, focusExplorerSearch, isActive, openSearchOverlay, selectedFolderId]);

  const startExplorerResize = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = explorerWidth;
    const move = (moveEvent: PointerEvent) => setExplorerWidth(Math.max(200, Math.min(360, startWidth + moveEvent.clientX - startX)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }, [explorerWidth]);

  const toggleFolder = useCallback((folder: TreeFolder) => {
    setCollapsedFolderPaths((current) => {
      const next = new Set(current);
      if (next.has(folder.path)) next.delete(folder.path);
      else next.add(folder.path);
      return next;
    });
  }, []);

  const openContextMenu = useCallback((event: React.MouseEvent, target: ExplorerTarget) => {
    event.preventDefault();
    restoreTabContextFocusRef.current = false;
    setTabContextMenu(null);
    setContextMenu({
      target,
      x: Math.min(event.clientX, window.innerWidth - 176),
      y: Math.min(event.clientY, window.innerHeight - 72),
    });
  }, []);

  const openTabContextMenu = useCallback((key: string, x: number, y: number, trigger: HTMLElement) => {
    setContextMenu(null);
    restoreTabContextFocusRef.current = false;
    tabContextTriggerRef.current = trigger;
    setTabContextMenu({
      key,
      x: Math.max(8, Math.min(x, window.innerWidth - 184)),
      y: Math.max(8, Math.min(y, window.innerHeight - 148)),
    });
  }, []);

  const handleTreeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target.closest<HTMLElement>('[data-notes-tree-item]') : null;
    if (!target) return;
    const treeElement = event.currentTarget;
    // Collapsed descendants are unmounted, so the DOM order already contains
    // exactly the navigable tree items without relying on layout APIs.
    const rows = Array.from(treeElement.querySelectorAll<HTMLElement>('[data-notes-tree-item]'));
    const index = rows.indexOf(target);
    if (index < 0) return;
    const key = event.key;
    const focusRow = (nextIndex: number) => rows[nextIndex]?.focus();
    if (key === 'ArrowDown') {
      event.preventDefault();
      focusRow(Math.min(rows.length - 1, index + 1));
      return;
    }
    if (key === 'ArrowUp') {
      event.preventDefault();
      focusRow(Math.max(0, index - 1));
      return;
    }
    if (key === 'Home') {
      event.preventDefault();
      focusRow(0);
      return;
    }
    if (key === 'End') {
      event.preventDefault();
      focusRow(rows.length - 1);
      return;
    }
    const isFolder = target.hasAttribute('data-notes-tree-folder');
    if (key === 'ArrowRight' && isFolder) {
      event.preventDefault();
      if (target.dataset.expanded === 'false') target.click();
      else focusRow(Math.min(rows.length - 1, index + 1));
      return;
    }
    if (key === 'ArrowLeft' && isFolder) {
      event.preventDefault();
      if (target.dataset.expanded === 'true') {
        target.click();
      } else {
        const currentDepth = Number(target.dataset.depth ?? 0);
        for (let previous = index - 1; previous >= 0; previous -= 1) {
          if (Number(rows[previous].dataset.depth ?? 0) < currentDepth) {
            rows[previous].focus();
            break;
          }
        }
      }
      return;
    }
    if (key === 'ArrowLeft') {
      event.preventDefault();
      const currentDepth = Number(target.dataset.depth ?? 0);
      for (let previous = index - 1; previous >= 0; previous -= 1) {
        if (Number(rows[previous].dataset.depth ?? 0) < currentDepth) {
          rows[previous].focus();
          break;
        }
      }
      return;
    }
    if (key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
    const typeahead = treeTypeaheadRef.current;
    typeahead.value += key.toLocaleLowerCase();
    if (typeahead.timer !== null) window.clearTimeout(typeahead.timer);
    typeahead.timer = window.setTimeout(() => {
      typeahead.value = '';
      typeahead.timer = null;
    }, 650);
    const match = [...rows.slice(index + 1), ...rows.slice(0, index + 1)]
      .find((row) => row.textContent?.trim().toLocaleLowerCase().startsWith(typeahead.value));
    if (match) {
      event.preventDefault();
      match.focus();
    }
  }, []);

  const handleDropIntoFolder = useCallback(async (event: React.DragEvent, folder: TreeFolder | null) => {
    event.preventDefault();
    event.stopPropagation();
    setDragOverFolderPath(null);
    const dragged = draggedItem;
    setDraggedItem(null);
    if (!dragged || (folder && !canDropExplorerItemIntoFolder(dragged, folder))) return;
    const destinationFolderId = folder?.id;
    let result: Awaited<ReturnType<typeof folderApi.moveItem>>;
    if (dragged.kind === 'resource') {
      const type = resourceType(dragged.node.type);
      if (!type) return;
      result = await folderApi.moveItem(type, dragged.node.id, destinationFolderId);
    } else {
      if (!dragged.folder.id) return;
      result = await folderApi.moveFolder(dragged.folder.id, destinationFolderId);
    }
    if (!result.ok) {
      setStatus(result.error.toUserMessage());
      return;
    }
    setSelectedFolderId(destinationFolderId ?? null);
    await loadResources({ blocking: false });
  }, [draggedItem, loadResources]);

  return (
    <>
      {titlebarTarget ? createPortal(
        <WorkspaceTabs
          tabs={tabs}
          activeKey={activeTab?.key ?? null}
          rightTabKey={splitTab?.key ?? null}
          canOpenRightSplit={tabs.length > 1}
          onActivate={activateTab}
          onClose={closeTab}
          onToggleRightSplit={toggleTabRightSplit}
          onReorder={reorderTabs}
          onOpenContextMenu={openTabContextMenu}
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
        data-compact={compact ? 'true' : 'false'}
        data-explorer-open={explorerOpen ? 'true' : 'false'}
        style={{ '--notes-explorer-width': `${explorerWidth}px` } as React.CSSProperties}
      >
      <nav className="notes-ribbon" data-notes-ribbon aria-label={t('notesWorkspace.ribbon.aria', 'Notes navigation')}>
        <div>
          <IconButton label={t('notesWorkspace.ribbon.explorer', 'File explorer')} data-active={explorerOpen ? 'true' : 'false'} onClick={() => setExplorerOpen((value) => !value)}><Files size={20} /></IconButton>
          <IconButton label={t('notesWorkspace.ribbon.search', 'Search notes')} onClick={() => openSearchOverlay('full-text')}><MagnifyingGlass size={20} /></IconButton>
        </div>
        <div>
          <IconButton label={t('notesWorkspace.ribbon.backlinks', 'Linked notes')} data-active={backlinksOpen ? 'true' : 'false'} onClick={() => setBacklinksOpen((open) => !open)}><LinkSimple size={20} /></IconButton>
          <IconButton label={t('notesWorkspace.ribbon.trash', 'Trash')} onClick={() => setTrashOpen(true)}><Trash size={20} /></IconButton>
        </div>
      </nav>

      <aside
        ref={explorerRef}
        className="notes-explorer"
        data-notes-explorer
        data-open={explorerOpen ? 'true' : 'false'}
        aria-hidden={!explorerOpen}
      >
        <header>
          <span>{t('notesWorkspace.explorer.title', 'Files')}</span>
          <div>
            <IconButton label={t('notesWorkspace.explorer.newNote', 'New note')} onClick={() => void createResource('note')}><FileText size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.explorer.newFolder', 'New folder')} onClick={() => { setDialogError(null); setResourceDialog({ mode: 'create-folder', value: '', parentId: selectedFolderId }); }}><FolderPlus size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.explorer.newMindmap', 'New mind map')} onClick={() => void createResource('mindmap')}><TreeStructure size={15} /></IconButton>
            <IconButton label={t('notesWorkspace.explorer.refresh', 'Refresh')} onClick={() => void loadResources({ blocking: false })}><ArrowsClockwise size={15} /></IconButton>
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
        <div
          className="notes-tree"
          role="tree"
          aria-label={t('notesWorkspace.tree.aria', 'File tree')}
          aria-busy={loading}
          aria-live="polite"
          onKeyDown={handleTreeKeyDown}
        >
          <button
            type="button"
            className="notes-tree-root"
            role="treeitem"
            data-notes-tree-item
            data-depth={1}
            data-selected={selectedFolderId === null ? 'true' : 'false'}
            data-drop-target={dragOverFolderPath === ROOT_TREE_DROP_TARGET ? 'true' : 'false'}
            aria-selected={selectedFolderId === null}
            aria-level={1}
            onClick={() => setSelectedFolderId(null)}
            onDragOver={(event) => {
              if (!draggedItem) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              setDragOverFolderPath(ROOT_TREE_DROP_TARGET);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDragOverFolderPath((current) => current === ROOT_TREE_DROP_TARGET ? null : current);
              }
            }}
            onDrop={(event) => void handleDropIntoFolder(event, null)}
          >
            <FolderSimple size={14} weight="fill" aria-hidden />
            <span>{t('notesWorkspace.tree.root', 'Library root')}</span>
          </button>
          {loading && !hasTreeItems ? (
            <div className="notes-tree-loading" aria-label={t('notesWorkspace.tree.loading', 'Loading files')}>
              <i /><i /><i /><i />
            </div>
          ) : loadError && !hasTreeItems ? (
            <div className="notes-tree-message" data-state="error">
              <span>{t('notesWorkspace.tree.loadFailed', 'Could not load files')}</span>
              <button type="button" onClick={() => void loadResources({ blocking: true })}>{t('notesWorkspace.tree.retry', 'Retry')}</button>
            </div>
          ) : !hasTreeItems ? (
            <div className="notes-tree-message" data-state="empty">
              <span>{query
                ? t('notesWorkspace.tree.noMatches', { defaultValue: 'No files match "{{query}}"', query })
                : t('notesWorkspace.tree.empty', 'No files in this library yet')}</span>
              {query ? (
                <button type="button" onClick={() => setQuery('')}>{t('notesWorkspace.tree.showAll', 'Show all files')}</button>
              ) : (
                <button type="button" onClick={() => void createResource('note')}>{t('notesWorkspace.explorer.newNote', 'New note')}</button>
              )}
            </div>
          ) : (
            <TreeBranch
              folder={tree}
              depth={1}
              activeId={activeTab?.id ?? null}
              selectedFolderId={selectedFolderId}
              collapsedFolderPaths={collapsedFolderPaths}
              dragOverFolderPath={dragOverFolderPath}
              onOpen={(ref, title) => void openResource(ref, title)}
              onContextMenu={(event, node) => openContextMenu(event, { kind: 'resource', node })}
              onFolderContextMenu={(event, folder) => {
                if (!folder.id) return;
                openContextMenu(event, { kind: 'folder', id: folder.id, name: folder.name, path: folder.path });
              }}
              onToggleFolder={toggleFolder}
              onSelectFolder={(folder) => setSelectedFolderId(folder.id ?? null)}
              onResourceDragStart={(event, node) => {
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', node.id);
                setDraggedItem({ kind: 'resource', node });
              }}
              onFolderDragStart={(event, folder) => {
                if (!folder.id) return;
                event.dataTransfer.effectAllowed = 'move';
                event.dataTransfer.setData('text/plain', folder.id);
                setDraggedItem({ kind: 'folder', folder });
              }}
              onDragEnd={() => {
                setDraggedItem(null);
                setDragOverFolderPath(null);
              }}
              onDragOverFolder={(event, folder) => {
                if (!draggedItem || !canDropExplorerItemIntoFolder(draggedItem, folder)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setDragOverFolderPath(folder.path);
              }}
              onDragLeaveFolder={(event, folder) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOverFolderPath((current) => current === folder.path ? null : current);
              }}
              onDropIntoFolder={(event, folder) => void handleDropIntoFolder(event, folder)}
            />
          )}
        </div>
        <div className="notes-explorer-resize" onPointerDown={startExplorerResize} />
      </aside>

      {!explorerOpen && <IconButton label={t('notesWorkspace.explorer.open', 'Open file explorer')} className="notes-explorer-handle" onClick={() => setExplorerOpen(true)}><SidebarSimple size={15} /></IconButton>}
      <main className="notes-workspace-main" data-notes-split={splitTab ? 'true' : 'false'}>
        <div className="notes-main-content" data-backlinks-open={backlinksOpen ? 'true' : 'false'}>
          <PanelGroup
            ref={paneGroupRef}
            direction={compact ? 'vertical' : 'horizontal'}
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
                  />
                </Panel>
              </>
            )}
          </PanelGroup>
          <NotesBacklinksPanel
            open={backlinksOpen}
            activeResource={activeResource}
            notes={resources}
            onOpenResource={openWorkspaceSearchResult}
            onClose={() => setBacklinksOpen(false)}
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
      <NotesSearchOverlay
        open={searchOpen}
        mode={searchMode}
        onModeChange={setSearchMode}
        resources={resources}
        onOpenResource={openWorkspaceSearchResult}
        onClose={() => setSearchOpen(false)}
      />
      {explorerOpen && <button className="notes-explorer-scrim" aria-label={t('notesWorkspace.explorer.close', 'Close file explorer')} onClick={() => setExplorerOpen(false)} />}
      {contextMenu && (
        <div ref={contextMenuRef} className="notes-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
          <button type="button" role="menuitem" onClick={() => { setDialogError(null); setResourceDialog({ mode: 'rename', target: contextMenu.target, value: getExplorerTargetName(contextMenu.target) }); setContextMenu(null); }}>{t('notesWorkspace.context.rename', 'Rename')}</button>
          <button type="button" role="menuitem" className="is-danger" onClick={() => { setDialogError(null); setResourceDialog({ mode: 'delete', target: contextMenu.target, value: '' }); setContextMenu(null); }}>{t('notesWorkspace.context.delete', 'Delete')}</button>
        </div>
      )}
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
      {resourceDialog && (
        <div className="notes-dialog-scrim" role="presentation" onPointerDown={() => setResourceDialog(null)}>
          <div
            ref={dialogRef}
            className="notes-resource-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notes-resource-dialog-title"
            onPointerDown={(event) => event.stopPropagation()}
          >
            <h2 id="notes-resource-dialog-title">{resourceDialog.mode === 'rename'
              ? t('notesWorkspace.dialog.renameTitle', 'Rename')
              : resourceDialog.mode === 'create-folder'
                ? t('notesWorkspace.dialog.createFolderTitle', 'New folder')
                : t('notesWorkspace.dialog.deleteTitle', 'Move to trash')}</h2>
            {resourceDialog.mode === 'rename' || resourceDialog.mode === 'create-folder' ? (
              <input
                autoFocus
                value={resourceDialog.value}
                onFocus={(event) => event.currentTarget.select()}
                onChange={(event) => {
                  setDialogError(null);
                  setResourceDialog({ ...resourceDialog, value: event.target.value });
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
                  event.preventDefault();
                  void (resourceDialog.mode === 'rename' ? renameContextResource() : createFolder());
                }}
                aria-label={t('notesWorkspace.dialog.nameLabel', 'Name')}
              />
            ) : <p>{t('notesWorkspace.dialog.deleteDescription', { defaultValue: 'Move "{{name}}" to the trash?', name: getExplorerTargetName(resourceDialog.target) })}</p>}
            {dialogError && <p className="notes-dialog-error" role="alert">{dialogError}</p>}
            <div>
              <button type="button" onClick={() => { setDialogError(null); setResourceDialog(null); }}>{t('notesWorkspace.dialog.cancel', 'Cancel')}</button>
              <button
                type="button"
                className={resourceDialog.mode === 'delete' ? 'is-danger' : 'is-primary'}
                disabled={resourceDialog.mode === 'rename' && (!resourceDialog.value.trim() || resourceDialog.value.trim() === getExplorerTargetName(resourceDialog.target))}
                onClick={() => void (resourceDialog.mode === 'rename'
                  ? renameContextResource()
                  : resourceDialog.mode === 'create-folder'
                    ? createFolder()
                    : deleteContextResource())}
              >
                {resourceDialog.mode === 'rename'
                  ? t('notesWorkspace.dialog.rename', 'Rename')
                  : resourceDialog.mode === 'create-folder'
                    ? t('notesWorkspace.dialog.create', 'Create')
                    : t('notesWorkspace.dialog.delete', 'Delete')}
              </button>
            </div>
          </div>
        </div>
      )}
      {trashOpen && (
        <div className="notes-dialog-scrim" role="presentation" onPointerDown={closeTrash}>
          <div ref={trashDialogRef} className="notes-resource-dialog notes-trash-dialog" role="dialog" aria-modal="true" aria-labelledby="notes-trash-dialog-title" onPointerDown={(event) => event.stopPropagation()}>
            <div className="notes-trash-dialog-header">
              <h2 id="notes-trash-dialog-title">{t('notesWorkspace.trash.title', 'Trash')}</h2>
              <IconButton label={t('notesWorkspace.trash.close', 'Close trash')} onClick={closeTrash}><X size={14} /></IconButton>
            </div>
            {trashLoading ? (
              <div className="notes-tree-loading" aria-label={t('notesWorkspace.trash.loading', 'Loading trash')}><i /><i /><i /></div>
            ) : trashError ? (
              <div className="notes-tree-message" data-state="error">
                <span>{trashError}</span>
                <button type="button" onClick={() => void loadTrash()}>{t('notesWorkspace.tree.retry', 'Retry')}</button>
              </div>
            ) : trashItems.length === 0 ? (
              <div className="notes-tree-message" data-state="empty"><span>{t('notesWorkspace.trash.empty', 'Trash is empty')}</span></div>
            ) : (
              <div className="notes-trash-list">
                {trashItems.map((node) => {
                  const type = trashItemType(node.type);
                  if (!type) return null;
                  return (
                    <div key={`${type}:${node.id}`} className="notes-trash-item">
                      <TrashGlyph type={type} />
                      <span>{node.name}</span>
                      <IconButton label={t('notesWorkspace.trash.restore', { defaultValue: 'Restore {{name}}', name: node.name })} onClick={() => void restoreTrashItem(node)}><ArrowsClockwise size={14} /></IconButton>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </>
  );
};

export default NotesWorkspaceApp;
