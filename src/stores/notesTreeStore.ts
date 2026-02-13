import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { immer } from 'zustand/middleware/immer';
import { enableMapSet } from 'immer';
import { TreeData } from '../components/notes/DndFileTree/types';

enableMapSet();

export type DropPosition = 'before' | 'after' | 'inside';

export interface FlattenedTreeNode {
  id: string;
  depth: number;
  parentId: string | null;
  isFolder: boolean;
}

export interface NotesTreePersistenceSnapshot {
  expandedIds: string[];
  selectedIds: string[];
  focusedId: string | null;
  version: number;
}

interface DragState {
  activeId: string | null;
  draggedIds: string[];
  overId: string | null;
  position: DropPosition;
}

interface FilterState {
  term: string;
  matches: Set<string>;
  forcedExpandedIds: string[] | null;
  locked: boolean;
  isFiltering: boolean;
  version: number;
}

interface TreeMetaState {
  parents: Record<string, string | null>;
  depths: Record<string, number>;
}

const NOTES_TREE_VIEW_VERSION = 2;

const deriveMeta = (treeData: TreeData): TreeMetaState => {
  const parents: Record<string, string | null> = { root: null };
  const depths: Record<string, number> = { root: 0 };

  const visit = (nodeId: string, depth: number) => {
    const node = treeData[nodeId];
    if (!node) return;
    depths[nodeId] = depth;
    if (!node.children) return;
    for (const childId of node.children) {
      parents[childId] = nodeId;
      visit(childId, depth + 1);
    }
  };

  visit('root', 0);
  return { parents, depths };
};

const ensureRoot = (): TreeData => ({
  root: {
    id: 'root',
    title: '',
    isFolder: true,
    canMove: false,
    canRename: false,
    children: [],
    data: {},
  },
});

interface NotesTreeState {
  treeData: TreeData;
  meta: TreeMetaState;
  expandedIds: Set<string>;
  selectedIds: Set<string>;
  anchorId: string | null;
  focusedId: string | null;
  renamingId: string | null;
  dragState: DragState;
  filter: FilterState;
  dataVersion: number;
  viewVersion: number;
  persistedVersion: number;
  typeaheadBuffer: string;
  typeaheadDeadline: number;
}

interface NotesTreeActions {
  transaction: <T>(updater: (draft: NotesTreeState) => T) => T;
  syncTree: (treeData: TreeData, options?: { preserveSelection?: boolean }) => void;
  hydrateFromSnapshot: (snapshot: NotesTreePersistenceSnapshot | null) => void;
  setExpandedIds: (ids: string[]) => void;
  expand: (id: string) => void;
  collapse: (id: string) => void;
  toggle: (id: string) => void;
  setSelectedIds: (ids: string[], opts?: { focusLast?: boolean; anchorId?: string | null }) => void;
  selectSingle: (id: string) => void;
  selectMulti: (id: string) => void;
  selectRange: (id: string) => void;
  focus: (id: string | null) => void;
  setRenamingId: (id: string | null) => void;
  setDragState: (next: Partial<DragState>) => void;
  resetDragState: () => void;
  setFilterTerm: (term: string, opts?: { locking?: boolean }) => void;
  startFiltering: () => void;
  finishFiltering: (payload: { matches: Set<string>; forcedExpandedIds: string[] | null; locked: boolean }) => void;
  clearFilter: () => void;
  resetTypeahead: () => void;
  pushTypeahead: (char: string, ttlMs?: number) => string;
}

export const useNotesTreeStore = create<NotesTreeState & NotesTreeActions>()(
  subscribeWithSelector(
    immer((set, get) => ({
      treeData: ensureRoot(),
      meta: deriveMeta(ensureRoot()),
      expandedIds: new Set<string>(['root']),
      selectedIds: new Set<string>(['root']),
      anchorId: 'root',
      focusedId: 'root',
      renamingId: null,
      dragState: {
        activeId: null,
        draggedIds: [],
        overId: null,
        position: 'inside',
      },
      filter: {
        term: '',
        matches: new Set<string>(),
        forcedExpandedIds: null,
        locked: false,
        isFiltering: false,
        version: 0,
      },
      dataVersion: 1,
      viewVersion: NOTES_TREE_VIEW_VERSION,
      persistedVersion: NOTES_TREE_VIEW_VERSION,
      typeaheadBuffer: '',
      typeaheadDeadline: 0,

      transaction: (updater) => {
        let result!: ReturnType<typeof updater>;
        set((state) => {
          result = updater(state as unknown as NotesTreeState);
        });
        return result;
      },

      syncTree: (treeData, options) => {
        const meta = deriveMeta(treeData);
        set((state) => {
          const nextExpanded =
            options?.preserveSelection && state.expandedIds.size
              ? new Set(state.expandedIds)
              : new Set<string>(['root']);
          const nextSelected =
            options?.preserveSelection && state.selectedIds.size
              ? new Set(state.selectedIds)
              : new Set<string>(['root']);
          return {
            treeData,
            meta,
            expandedIds: nextExpanded,
            selectedIds: nextSelected,
            anchorId: nextSelected.size ? Array.from(nextSelected).pop() ?? null : null,
            focusedId: nextSelected.size ? Array.from(nextSelected).pop() ?? 'root' : 'root',
            dataVersion: state.dataVersion + 1,
          };
        });
      },

      hydrateFromSnapshot: (snapshot) => {
        if (!snapshot || snapshot.version !== NOTES_TREE_VIEW_VERSION) {
          set({
            expandedIds: new Set<string>(['root']),
            selectedIds: new Set<string>(['root']),
            focusedId: 'root',
            anchorId: 'root',
            persistedVersion: NOTES_TREE_VIEW_VERSION,
          });
          return;
        }
        set({
          expandedIds: new Set(snapshot.expandedIds ?? ['root']),
          selectedIds: new Set(snapshot.selectedIds ?? ['root']),
          focusedId: snapshot.focusedId ?? 'root',
          anchorId: snapshot.selectedIds?.length
            ? snapshot.selectedIds[snapshot.selectedIds.length - 1]
            : snapshot.focusedId ?? 'root',
          persistedVersion: snapshot.version,
        });
      },

      setExpandedIds: (ids) => {
        set({ expandedIds: new Set(ids) });
      },

      expand: (id) => {
        if (get().expandedIds.has(id)) return;
        set((state) => ({
          expandedIds: new Set(state.expandedIds).add(id),
        }));
      },

      collapse: (id) => {
        if (!get().expandedIds.has(id)) return;
        set((state) => {
          const next = new Set(state.expandedIds);
          next.delete(id);
          return { expandedIds: next };
        });
      },

      toggle: (id) => {
        const expanded = get().expandedIds;
        if (expanded.has(id)) {
          set((state) => {
            const next = new Set(state.expandedIds);
            next.delete(id);
            return { expandedIds: next };
          });
        } else {
          set((state) => ({
            expandedIds: new Set(state.expandedIds).add(id),
          }));
        }
      },

      setSelectedIds: (ids, opts) => {
        const next = new Set(ids);
        set({
          selectedIds: next,
          anchorId: opts?.anchorId ?? (ids.length ? ids[ids.length - 1] : null),
          focusedId:
            opts?.focusLast && ids.length ? ids[ids.length - 1] : ids.length ? get().focusedId ?? ids[ids.length - 1] : get().focusedId ?? 'root',
        });
      },

      selectSingle: (id) => {
        set({
          selectedIds: new Set([id]),
          anchorId: id,
          focusedId: id,
        });
      },

      selectMulti: (id) => {
        const state = get();
        const next = new Set(state.selectedIds);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        set({
          selectedIds: next,
          anchorId: id,
          focusedId: id,
        });
      },

      selectRange: (id) => {
        const state = get();
        const anchor = state.anchorId ?? state.focusedId ?? id;
        if (!anchor) {
          set({
            selectedIds: new Set([id]),
            anchorId: id,
            focusedId: id,
          });
          return;
        }

        const visible = computeVisibleOrder(state.treeData, state.expandedIds, state.filter);
        const anchorIndex = visible.findIndex((node) => node.id === anchor);
        const targetIndex = visible.findIndex((node) => node.id === id);
        if (anchorIndex === -1 || targetIndex === -1) {
          set({
            selectedIds: new Set([id]),
            anchorId: id,
            focusedId: id,
          });
          return;
        }
        const [start, end] =
          anchorIndex <= targetIndex ? [anchorIndex, targetIndex] : [targetIndex, anchorIndex];
        const rangeIds = visible.slice(start, end + 1).map((node) => node.id);
        set({
          selectedIds: new Set(rangeIds),
          anchorId: anchor,
          focusedId: id,
        });
      },

      focus: (id) => {
        set({
          focusedId: id ?? 'root',
          anchorId: id ?? 'root',
        });
      },

      setRenamingId: (id) => {
        set({
          renamingId: id,
        });
      },

      setDragState: (next) => {
        set((state) => ({
          dragState: {
            ...state.dragState,
            ...next,
          },
        }));
      },

      resetDragState: () => {
        set({
          dragState: {
            activeId: null,
            draggedIds: [],
            overId: null,
            position: 'inside',
          },
        });
      },

      setFilterTerm: (term, opts) => {
        const normalized = term.trim().toLowerCase();
        set((state) => ({
          filter: {
            ...state.filter,
            term: normalized,
            locked: opts?.locking ? true : state.filter.locked,
            isFiltering: normalized.length > 0,
            version: state.filter.version + 1,
          },
        }));
      },

      startFiltering: () => {
        set((state) => ({
          filter: {
            ...state.filter,
            isFiltering: true,
          },
        }));
      },

      finishFiltering: ({ matches, forcedExpandedIds, locked }) => {
        set((state) => ({
          filter: {
            ...state.filter,
            matches,
            forcedExpandedIds,
            locked,
            isFiltering: false,
          },
        }));
      },

      clearFilter: () => {
        set({
          filter: {
            term: '',
            matches: new Set(),
            forcedExpandedIds: null,
            locked: false,
            isFiltering: false,
            version: get().filter.version + 1,
          },
        });
      },

      resetTypeahead: () => {
        set({
          typeaheadBuffer: '',
          typeaheadDeadline: 0,
        });
      },

      pushTypeahead: (char, ttlMs = 600) => {
        const now = performance.now();
        const state = get();
        const nextBuffer =
          now <= state.typeaheadDeadline ? `${state.typeaheadBuffer}${char}` : char;
        set({
          typeaheadBuffer: nextBuffer,
          typeaheadDeadline: now + ttlMs,
        });
        return nextBuffer;
      },
    }))
  )
);

export const computeVisibleOrder = (
  treeData: TreeData,
  expandedIds: Set<string>,
  filterState: FilterState,
): FlattenedTreeNode[] => {
  const result: FlattenedTreeNode[] = [];
  const matches = filterState.term ? filterState.matches : null;
  const visit = (id: string, depth: number, parentId: string | null) => {
    if (id !== 'root') {
      const node = treeData[id];
      if (!node) return;
      if (matches && matches.size && !matches.has(id) && !matches.has(parentId ?? '')) {
        // allow traversal; filter already handled via forced treeData shape.
      }
      result.push({
        id,
        depth,
        parentId,
        isFolder: node.isFolder,
      });
      if (!node.isFolder) {
        return;
      }
    }
    const node = treeData[id];
    if (!node || !node.children) return;
    const shouldExpand = id === 'root' || expandedIds.has(id) || filterState.forcedExpandedIds?.includes(id);
    if (!shouldExpand) return;
    for (const childId of node.children) {
      visit(childId, depth + (id === 'root' ? 0 : 1), id === 'root' ? null : id);
    }
  };
  visit('root', 0, null);
  return result;
};

export const getParentChain = (
  state: NotesTreeState,
  id: string,
): string[] => {
  const parents: string[] = [];
  let current: string | null = id;
  const visited = new Set<string>();
  while (current && current !== 'root' && !visited.has(current)) {
    visited.add(current);
    const parentId = state.meta.parents[current] ?? null;
    if (parentId && parentId !== 'root') {
      parents.unshift(parentId);
    }
    current = parentId;
  }
  return parents;
};

export const toPersistenceSnapshot = (state: NotesTreeState): NotesTreePersistenceSnapshot => ({
  expandedIds: Array.from(state.expandedIds),
  selectedIds: Array.from(state.selectedIds),
  focusedId: state.focusedId,
  version: state.viewVersion,
});
