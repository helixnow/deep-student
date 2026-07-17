import type { FlattenedTreeRow, NotesWorkspaceTreeItem } from './types';

export function isFolderItem(item: NotesWorkspaceTreeItem): boolean {
  return item.kind === 'folder';
}

export function toExpandedSet(
  expandedIds: ReadonlySet<string> | readonly string[],
): Set<string> {
  return expandedIds instanceof Set ? new Set(expandedIds) : new Set(expandedIds);
}

/** Depth-first visible rows given expanded folder ids. */
export function flattenVisibleTree(
  items: readonly NotesWorkspaceTreeItem[],
  expandedIds: ReadonlySet<string>,
  parentId: string | null = null,
  depth = 0,
): FlattenedTreeRow[] {
  const rows: FlattenedTreeRow[] = [];
  const siblingCount = items.length;

  items.forEach((item, index) => {
    rows.push({
      id: item.id,
      item,
      depth,
      parentId,
      indexAmongSiblings: index,
      siblingCount,
    });

    if (isFolderItem(item) && expandedIds.has(item.id) && item.children?.length) {
      rows.push(...flattenVisibleTree(item.children, expandedIds, item.id, depth + 1));
    }
  });

  return rows;
}

/** Collect all folder ids under `items` (inclusive of nested folders). */
export function collectFolderIds(items: readonly NotesWorkspaceTreeItem[]): string[] {
  return collectFolderEntries(items).map((entry) => entry.id);
}

/**
 * Collect `{ id, path }` for every folder that has a `path`.
 * Used with `expandedIdsFromCollapsedPaths` when the host still stores
 * `collapsedFolderPaths`.
 */
export function collectFolderEntries(
  items: readonly NotesWorkspaceTreeItem[],
): Array<{ id: string; path: string }> {
  const entries: Array<{ id: string; path: string }> = [];
  const visit = (nodes: readonly NotesWorkspaceTreeItem[]) => {
    for (const node of nodes) {
      if (isFolderItem(node)) {
        if (typeof node.path === 'string') {
          entries.push({ id: node.id, path: node.path });
        }
        if (node.children?.length) visit(node.children);
      }
    }
  };
  visit(items);
  return entries;
}

/** Descendant ids of a folder (not including itself). */
export function collectDescendantIds(
  items: readonly NotesWorkspaceTreeItem[],
  folderId: string,
): Set<string> {
  const result = new Set<string>();
  const find = (nodes: readonly NotesWorkspaceTreeItem[]): NotesWorkspaceTreeItem | null => {
    for (const node of nodes) {
      if (node.id === folderId) return node;
      if (node.children?.length) {
        const hit = find(node.children);
        if (hit) return hit;
      }
    }
    return null;
  };
  const root = find(items);
  if (!root?.children?.length) return result;
  const walk = (nodes: readonly NotesWorkspaceTreeItem[]) => {
    for (const node of nodes) {
      result.add(node.id);
      if (node.children?.length) walk(node.children);
    }
  };
  walk(root.children);
  return result;
}

export function findItemById(
  items: readonly NotesWorkspaceTreeItem[],
  id: string,
): NotesWorkspaceTreeItem | null {
  for (const item of items) {
    if (item.id === id) return item;
    if (item.children?.length) {
      const hit = findItemById(item.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Duck-typed source shape matching NotesWorkspaceApp `TreeFolder` so the wiring
 * agent can call `mapWorkspaceTreeFolder(tree)` without importing private types.
 */
export interface WorkspaceTreeFolderSource {
  id?: string;
  name: string;
  path: string;
  folders: Map<string, WorkspaceTreeFolderSource> | Iterable<[string, WorkspaceTreeFolderSource]>;
  resources: ReadonlyArray<{
    id: string;
    name: string;
    type: string;
    /** DstuNode top-level / list filter shape (preferred). */
    isFavorite?: boolean;
    /** Legacy snake_case alias. */
    is_favorite?: boolean;
    metadata?: Record<string, unknown>;
  }>;
}

function listChildFolders(
  folders: WorkspaceTreeFolderSource['folders'],
): WorkspaceTreeFolderSource[] {
  if (folders instanceof Map) return [...folders.values()];
  return [...folders].map((entry) => entry[1]);
}

function resolveResourceFavorite(
  resource: WorkspaceTreeFolderSource['resources'][number],
): boolean {
  if (typeof resource.isFavorite === 'boolean') return resource.isFavorite;
  if (typeof resource.is_favorite === 'boolean') return resource.is_favorite;
  const meta = resource.metadata?.isFavorite;
  return typeof meta === 'boolean' ? meta : false;
}

function mapResources(
  resources: WorkspaceTreeFolderSource['resources'],
): NotesWorkspaceTreeItem[] {
  return [...resources]
    .filter((resource) => resource.type === 'note' || resource.type === 'mindmap')
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((resource) => ({
      id: resource.id,
      name: resource.name,
      kind: resource.type as 'note' | 'mindmap',
      favorite: resolveResourceFavorite(resource),
      canRename: true,
      canMove: true,
    } satisfies NotesWorkspaceTreeItem));
}

export function mapWorkspaceTreeFolder(
  folder: WorkspaceTreeFolderSource,
  options?: { includeRootChildrenOnly?: boolean },
): NotesWorkspaceTreeItem[] {
  const includeRootChildrenOnly = options?.includeRootChildrenOnly ?? true;

  const mapFolder = (node: WorkspaceTreeFolderSource): NotesWorkspaceTreeItem | null => {
    if (!node.id && !node.name) {
      // Virtual root — map children only.
      return null;
    }
    const childFolders = listChildFolders(node.folders)
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
      .map(mapFolder)
      .filter((child): child is NotesWorkspaceTreeItem => child !== null);
    const children = [...childFolders, ...mapResources(node.resources)];

    if (!node.id) {
      // Synthetic path folders (no VFS id): keep them so path-grouped resources
      // remain visible, but disable rename/move (cannot target DSTU folder APIs).
      if (!node.name || children.length === 0) return null;
      return {
        id: `synth:${node.path}`,
        name: node.name,
        kind: 'folder',
        path: node.path,
        children,
        canRename: false,
        canMove: false,
      };
    }

    return {
      id: node.id,
      name: node.name,
      kind: 'folder',
      path: node.path,
      children,
      canRename: true,
      canMove: true,
    };
  };

  if (includeRootChildrenOnly && !folder.id && !folder.name) {
    const childFolders = listChildFolders(folder.folders)
      .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path))
      .map(mapFolder)
      .filter((child): child is NotesWorkspaceTreeItem => child !== null);
    return [...childFolders, ...mapResources(folder.resources)];
  }

  const mapped = mapFolder(folder);
  return mapped ? [mapped] : [];
}

/**
 * Convert host `collapsedFolderPaths` + path→id map into `expandedIds`.
 * Folders whose path is NOT in the collapsed set are expanded.
 */
export function expandedIdsFromCollapsedPaths(
  folderEntries: ReadonlyArray<{ id: string; path: string }>,
  collapsedFolderPaths: ReadonlySet<string> | readonly string[],
): Set<string> {
  const collapsed = collapsedFolderPaths instanceof Set
    ? collapsedFolderPaths
    : new Set(collapsedFolderPaths);
  const expanded = new Set<string>();
  for (const entry of folderEntries) {
    if (!collapsed.has(entry.path)) expanded.add(entry.id);
  }
  return expanded;
}
