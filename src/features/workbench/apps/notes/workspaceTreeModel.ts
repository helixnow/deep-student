import { dstu, type DstuNode } from '@/dstu';
import { RESOURCE_ID_PREFIX_MAP } from '@/dstu/types/path';
import type { FolderTreeNode, VfsFolder } from '@/dstu/types/folder';
import { getMindMapStoreForInstance } from '@/features/mindmap/store';
import { sameNoteLearningMetadata } from '@/features/notes/noteLearningProps';
import { isContentDirty, type ContentSaveState } from '../content/contentDirtyRegistry';
import type { NotesWorkspaceResourceRef } from './workspaceRegistry';
import type { NotesNavHistoryEntry } from './hooks/useNotesNavHistory';
import { nodeMatchesTags } from './parseTagQuery';
import {
  findItemById,
  NOTES_WORKSPACE_TREE_ROOT_ID,
  type NotesWorkspaceDropPosition,
  type NotesWorkspaceTreeItem,
} from './tree';

export type ResourceType = NotesWorkspaceResourceRef['type'];

export interface WorkspaceTab extends NotesWorkspaceResourceRef {
  key: string;
  title: string;
  pinned?: boolean;
}

export type SaveState = ContentSaveState;
export type WorkspacePaneId = 'main' | 'right';
export type SplitLayout = [number, number];
export type TabDropPosition = 'before' | 'after';

export const DEFAULT_SPLIT_LAYOUT: SplitLayout = [50, 50];

export interface CloseTabOptions {
  /** A user has already confirmed a destructive action for this resource. */
  force?: boolean;
}

export interface TabContextMenu {
  key: string;
  x: number;
  y: number;
}

export interface TreeFolder {
  name: string;
  path: string;
  id?: string;
  folders: Map<string, TreeFolder>;
  resources: DstuNode[];
}

export interface ExplorerFolderTarget {
  kind: 'folder';
  id: string;
  name: string;
  path: string;
}

export interface ExplorerResourceTarget {
  kind: 'resource';
  node: DstuNode;
}

export type ExplorerTarget = ExplorerFolderTarget | ExplorerResourceTarget;

export type ResourceDialog =
  | { mode: 'delete'; target: ExplorerTarget }
  | { mode: 'delete-many'; targets: ExplorerTarget[] }
  | { mode: 'create-folder'; value: string; parentId: string | null };

export interface PersistedWorkspaceState {
  tabs: WorkspaceTab[];
  activeTabKey: string | null;
  rightTabKey: string | null;
  focusedPane: WorkspacePaneId;
  splitLayout: SplitLayout;
  backlinksOpen: boolean;
  explorerOpen: boolean;
  collapsedFolderPaths: string[];
}

export interface NoteBreadcrumbItem {
  id: string;
  title: string;
  type: 'folder' | 'note';
}

export const WORKSPACE_STORAGE_KEY = 'workbench.notesWorkspace.state.v1';

/**
 * 资源列表分页参数，与 wikilinkNotesCache 对齐（每页 1000、总上限 20000）。
 * 旧实现单次 `limit: 1000` 静默截断：第 1001 篇起从文件树里消失且毫无提示。
 */
export const RESOURCE_LIST_PAGE_SIZE = 1000;
export const RESOURCE_LIST_MAX_TOTAL = 20000;

/**
 * 背链面板并排（非 overlay）所需的最小工作区宽度。
 * 旧值 1180 恰好等于窗口默认宽（去掉窗框后工作区永远差几像素）——默认
 * 尺寸下面板永远盖在正文上。现在阈值与默认窗宽（register.ts 1240）拉开，
 * 默认窗口即可并排显示。
 */
export const BACKLINKS_SIDE_BY_SIDE_MIN_WIDTH = 1120;

export const EMPTY_RESOURCE_FOLDER_IDS: ReadonlyMap<string, string> = new Map();

// 互斥 never 字段与 shared/result 的 Ok/Err 同款（strict:false 下无收窄）
export type ListWorkspaceResourcesResult =
  | { ok: true; nodes: DstuNode[]; truncated: boolean; error?: never }
  | { ok: false; error: { toUserMessage(): string }; nodes?: never; truncated?: never };

export const resourceType = (value: unknown): ResourceType | null =>
  value === 'note' || value === 'mindmap' ? value : null;

export const treeResourceKey = (type: string, id: string): string => `${type}:${id}`;

export function isStableVfsFolderId(id: string): boolean {
  return Boolean(id) && !id.startsWith('synth:');
}

export function isReservedFolderTitle(title: string): boolean {
  return title.trim().toLocaleLowerCase() === '__system__';
}

export function isMarkdownFileName(name: string): boolean {
  return /\.md(?:own)?$/i.test(name);
}

export function getExplorerTargetName(target: ExplorerTarget): string {
  return target.kind === 'resource' ? target.node.name : target.name;
}

export function getTabSaveState(tab: WorkspaceTab, windowId: string): SaveState {
  if (tab.type === 'note') {
    return isContentDirty('note', tab.id) ? 'dirty' : 'saved';
  }
  const state = getMindMapStoreForInstance(`${windowId}:${tab.key}`, tab.id)?.getState();
  if (state?.isSaving) return 'saving';
  return state?.isDirty ? 'dirty' : 'saved';
}

/** 分页拉全某类型资源；命中总上限或后续页失败时返回已取到的部分并标记截断。 */
export async function listWorkspaceResources(typeFilter: ResourceType): Promise<ListWorkspaceResourcesResult> {
  const nodes: DstuNode[] = [];
  let offset = 0;
  for (;;) {
    const result = await dstu.list('/', {
      typeFilter,
      sortBy: 'name',
      sortOrder: 'asc',
      limit: RESOURCE_LIST_PAGE_SIZE,
      offset,
    });
    if (!result.ok) {
      // 首页失败 = 整树加载失败；后续页失败保留已取到的部分并提示不完整
      if (offset === 0) return { ok: false, error: result.error };
      return { ok: true, nodes, truncated: true };
    }
    nodes.push(...result.value);
    if (result.value.length < RESOURCE_LIST_PAGE_SIZE) return { ok: true, nodes, truncated: false };
    if (nodes.length >= RESOURCE_LIST_MAX_TOTAL) return { ok: true, nodes, truncated: true };
    offset += RESOURCE_LIST_PAGE_SIZE;
  }
}

export function findParentDeep(
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

export function resolveMoveDestinationFolderId(
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

export function parseSplitLayout(value: unknown): SplitLayout {
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

/** 从资源 ID 前缀推断工作区资源类型；非 note/mindmap 前缀返回 null。 */
export function resourceTypeFromIdPrefix(id: string): ResourceType | null {
  for (const [prefix, type] of Object.entries(RESOURCE_ID_PREFIX_MAP)) {
    if (id.startsWith(prefix)) return resourceType(type);
  }
  return null;
}

export function parseInitialResource(instanceKey: string | null, payload: unknown): NotesWorkspaceResourceRef | null {
  if (payload && typeof payload === 'object') {
    const value = payload as Record<string, unknown>;
    const type = resourceType(value.resourceType ?? value.type);
    const id = typeof value.resourceId === 'string' ? value.resourceId : instanceKey;
    if (type && id) return { type, id };
  }
  if (!instanceKey) return null;
  // 冷启动回退按 DSTU 统一的 ID 前缀表推断类型（mm_ → mindmap 等），
  // 未知前缀按笔记打开（历史行为，笔记是工作区的默认资源类型）
  return { type: resourceTypeFromIdPrefix(instanceKey) ?? 'note', id: instanceKey };
}

export function getFolderMembership(treeNodes: readonly FolderTreeNode[]): ReadonlyMap<string, string> {
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

export function readPersistedWorkspaceState(): PersistedWorkspaceState {
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

export function writePersistedWorkspaceState(state: PersistedWorkspaceState): void {
  if (typeof window === 'undefined' || typeof window.localStorage === 'undefined') return;
  try {
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Local storage is a convenience only; a private browser context must
    // not prevent the workspace from opening.
  }
}

export function filterWorkspaceResources(
  resources: readonly DstuNode[],
  query: string,
  selectedTags: readonly string[],
): DstuNode[] {
  const term = query.trim().toLocaleLowerCase();
  return resources.filter((node) => {
    if (term && !node.name.toLocaleLowerCase().includes(term)) return false;
    if (!nodeMatchesTags(node.metadata, selectedTags)) return false;
    return true;
  });
}

export function getRecentSearchResources(
  entries: readonly NotesNavHistoryEntry[],
  resources: readonly DstuNode[],
  limit = 8,
): DstuNode[] {
  const seen = new Set<string>();
  const recents: DstuNode[] = [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (seen.has(entry.key)) continue;
    seen.add(entry.key);
    const node = resources.find((item) => item.id === entry.id && item.type === entry.type);
    if (node) recents.push(node);
    if (recents.length >= limit) break;
  }
  return recents;
}

export function getWelcomeRecentResources(
  recentSearchResources: readonly DstuNode[],
  resources: readonly DstuNode[],
  limit = 4,
): DstuNode[] {
  const seen = new Set<string>();
  const combined: DstuNode[] = [];
  for (const node of recentSearchResources) {
    const key = treeResourceKey(node.type, node.id);
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(node);
    if (combined.length >= limit) return combined;
  }
  const sortedByUpdated = [...resources].sort((a, b) => b.updatedAt - a.updatedAt);
  for (const node of sortedByUpdated) {
    const key = treeResourceKey(node.type, node.id);
    if (seen.has(key)) continue;
    seen.add(key);
    combined.push(node);
    if (combined.length >= limit) break;
  }
  return combined;
}

export function reorderWorkspaceTabs(
  tabs: readonly WorkspaceTab[],
  draggedKey: string,
  targetKey: string,
  position: TabDropPosition,
): WorkspaceTab[] {
  if (draggedKey === targetKey) return [...tabs];
  const draggedIndex = tabs.findIndex((tab) => tab.key === draggedKey);
  if (draggedIndex < 0) return [...tabs];
  const next = [...tabs];
  const [dragged] = next.splice(draggedIndex, 1);
  const targetIndex = next.findIndex((tab) => tab.key === targetKey);
  if (!dragged || targetIndex < 0) return [...tabs];
  next.splice(targetIndex + (position === 'after' ? 1 : 0), 0, dragged);
  return next;
}

/**
 * Compute root-to-leaf breadcrumb trail for a note, ready for DSTU breadcrumb wiring.
 * Skips reserved `__system__` folders and terminates safely on circular parent chains.
 */
export function computeNoteBreadcrumbs(
  nodeId: string,
  folders: readonly VfsFolder[],
  resourceFolderIds: ReadonlyMap<string, string>,
  noteTitle: string,
): NoteBreadcrumbItem[] {
  const foldersById = new Map(folders.map((folder) => [folder.id, folder]));
  const startFolderId = resourceFolderIds.get(treeResourceKey('note', nodeId))
    ?? resourceFolderIds.get(nodeId);
  const trail: NoteBreadcrumbItem[] = [];
  const visited = new Set<string>();
  let cursorId = startFolderId;
  while (cursorId && !visited.has(cursorId)) {
    visited.add(cursorId);
    const folder = foldersById.get(cursorId);
    if (!folder) break;
    if (!isReservedFolderTitle(folder.title)) {
      trail.push({ id: folder.id, title: folder.title, type: 'folder' });
    }
    cursorId = folder.parentId ?? undefined;
  }
  trail.reverse();
  trail.push({ id: nodeId, title: noteTitle, type: 'note' });
  return trail;
}

export function resolveRightSplitMainTabKey(
  tabs: readonly WorkspaceTab[],
  rightKey: string,
  priorRightKey: string | null,
  currentActiveKey: string | null,
): string | null {
  const mainCandidates = tabs.filter((tab) => tab.key !== rightKey);
  if (currentActiveKey && currentActiveKey !== rightKey && mainCandidates.some((tab) => tab.key === currentActiveKey)) {
    return currentActiveKey;
  }
  return mainCandidates.find((tab) => tab.key === priorRightKey)?.key ?? mainCandidates[0]?.key ?? null;
}

export function resolveCoherentPaneState(
  tabs: readonly WorkspaceTab[],
  activeTabKey: string | null,
  rightTabKey: string | null,
  focusedPane: WorkspacePaneId,
): { validRightKey: string | null; validActiveKey: string | null; validFocusedPane: WorkspacePaneId } {
  const validRightKey = rightTabKey && tabs.some((tab) => tab.key === rightTabKey) ? rightTabKey : null;
  const validMainTabs = tabs.filter((tab) => tab.key !== validRightKey);
  const validActiveKey = activeTabKey && validMainTabs.some((tab) => tab.key === activeTabKey)
    ? activeTabKey
    : validMainTabs[0]?.key ?? null;
  const validFocusedPane: WorkspacePaneId = validRightKey && focusedPane === 'right' ? 'right' : 'main';
  return { validRightKey, validActiveKey, validFocusedPane };
}

export function shouldCloseRightSplitOnTabClose(
  tabs: readonly WorkspaceTab[],
  closingKey: string,
  closingRightKey: string | null,
): boolean {
  if (!closingRightKey) return false;
  if (closingRightKey === closingKey) return true;
  return tabs.every((tab) => tab.key === closingKey || tab.key === closingRightKey);
}

export function computeTabCloseNextState(
  tabs: readonly WorkspaceTab[],
  closingKey: string,
  closingRightKey: string | null,
  shouldCloseSplit: boolean,
): { nextTabs: WorkspaceTab[]; nextRightKey: string | null; nextMainTabs: WorkspaceTab[]; neighborKey: string | null } | null {
  const closingIndex = tabs.findIndex((tab) => tab.key === closingKey);
  if (closingIndex < 0) return null;
  const nextTabs = tabs.filter((tab) => tab.key !== closingKey);
  const nextRightKey = shouldCloseSplit ? null : closingRightKey;
  const nextMainTabs = nextTabs.filter((tab) => tab.key !== nextRightKey);
  const neighbor = [nextTabs[closingIndex], nextTabs[closingIndex - 1], ...nextMainTabs]
    .find((tab): tab is WorkspaceTab => Boolean(tab) && tab.key !== nextRightKey) ?? null;
  return { nextTabs, nextRightKey, nextMainTabs, neighborKey: neighbor?.key ?? null };
}

export function reconcileTabsWithResources(
  tabs: readonly WorkspaceTab[],
  byId: ReadonlyMap<string, DstuNode>,
): WorkspaceTab[] {
  return tabs
    .filter((tab) => byId.has(tab.id))
    .map((tab) => {
      const node = byId.get(tab.id);
      return node && node.name !== tab.title ? { ...tab, title: node.name } : tab;
    });
}

export function mergeUpdatedResourceNode(current: DstuNode[], changedNode: DstuNode): DstuNode[] {
  const index = current.findIndex((node) => node.id === changedNode.id);
  if (index < 0) return current;
  const existing = current[index];
  if (changedNode.updatedAt < existing.updatedAt) return current;
  // Keep the latest version even on content-only saves, so delayed
  // metadata cannot restore an older learning state. Skip duplicate snapshots.
  if (
    existing.name === changedNode.name
    && existing.path === changedNode.path
    && existing.type === changedNode.type
    && existing.updatedAt === changedNode.updatedAt
    && sameNoteLearningMetadata(existing.metadata, changedNode.metadata)
  ) return current;
  const next = [...current];
  next[index] = changedNode;
  return next;
}

export function resolveExplorerDeleteTargets(
  items: readonly NotesWorkspaceTreeItem[],
  resources: readonly DstuNode[],
): ExplorerTarget[] {
  const targets: ExplorerTarget[] = [];
  for (const item of items) {
    if (item.kind === 'folder') {
      if (!isStableVfsFolderId(item.id)) continue;
      targets.push({ kind: 'folder', id: item.id, name: item.name, path: item.path ?? item.id });
      continue;
    }
    const node = resources.find((entry) => entry.id === item.id && entry.type === item.kind);
    if (node) targets.push({ kind: 'resource', node });
  }
  return targets;
}

export function isCloseTabShortcut(event: KeyboardEvent): boolean {
  return (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey
    && event.key.toLocaleLowerCase() === 'w';
}

export type WorkspaceWindowShortcut = 'quick-open' | 'cycle-next' | 'cycle-prev';

export function matchWorkspaceWindowShortcut(
  event: KeyboardEvent,
  searchOpen: boolean,
): WorkspaceWindowShortcut | null {
  if (
    (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey
    && event.key.toLocaleLowerCase() === 'p'
  ) {
    return 'quick-open';
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
  // Ctrl+Tab / Ctrl+Shift+Tab（handlesTabCycleShortcut 让位协议）：
  // - defaultPrevented = 壳层切换器会话进行中已接管，跳过（协议规则 2）；
  // - 搜索浮层打开时它自持 Ctrl+Tab 切搜索模式，让给浮层。
  const cyclesByTab = event.ctrlKey
    && !event.metaKey
    && !event.altKey
    && event.key === 'Tab'
    && !event.defaultPrevented
    && !searchOpen;
  if (!cyclesByPage && !cyclesByBracket && !cyclesByTab) return null;
  const backwards = cyclesByTab
    ? event.shiftKey
    : event.key === 'PageUp' || event.key === '[' || event.key === '{';
  return backwards ? 'cycle-prev' : 'cycle-next';
}

export function getTabContextMenuState(
  tabs: readonly WorkspaceTab[],
  menu: TabContextMenu | null,
): { target: WorkspaceTab | null; canCloseOthers: boolean; canCloseRight: boolean } {
  const target = menu ? tabs.find((tab) => tab.key === menu.key) ?? null : null;
  const index = target ? tabs.findIndex((tab) => tab.key === target.key) : -1;
  return {
    target,
    canCloseOthers: Boolean(target && tabs.some((tab) => tab.key !== target.key && !tab.pinned)),
    canCloseRight: index >= 0 && tabs.slice(index + 1).some((tab) => !tab.pinned),
  };
}
