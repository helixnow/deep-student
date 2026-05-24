import React, { createContext, useContext, useReducer, useCallback, useEffect } from 'react';
import { TreeState, TreeActions, TreeCallbacks, TreeData } from './types';

// 初始状态
const initialState: TreeState = {
  expandedIds: new Set<string>(),
  selectedIds: new Set<string>(),
  focusedId: null,
  anchorId: null,
  renamingId: null,
  draggedId: null,
  overId: null,
  dropPosition: 'inside',
};

// Action 类型
type TreeAction =
  | { type: 'SET_EXPANDED'; id: string; expanded: boolean }
  | { type: 'TOGGLE_EXPANDED'; id: string }
  | { type: 'SELECT'; id: string; multi: boolean }
  | { type: 'SELECT_RANGE'; ids: string[]; focusId: string; anchorId: string | null }
  | { type: 'CLEAR_SELECTION' }
  | { type: 'SET_FOCUSED'; id: string | null }
  | { type: 'SET_ANCHOR'; id: string | null }
  | { type: 'SET_RENAMING'; id: string | null }
  | { type: 'SET_DRAGGED'; id: string | null }
  | { type: 'SET_OVER'; id: string | null }
  | { type: 'SET_DROP_POSITION'; position: 'before' | 'after' | 'inside' }
  | { type: 'SET_STATE'; state: Partial<TreeState> };

// Reducer
function treeReducer(state: TreeState, action: TreeAction): TreeState {
  switch (action.type) {
    case 'SET_EXPANDED': {
      const newExpanded = new Set(state.expandedIds);
      if (action.expanded) {
        newExpanded.add(action.id);
      } else {
        newExpanded.delete(action.id);
      }
      return { ...state, expandedIds: newExpanded };
    }
    
    case 'TOGGLE_EXPANDED': {
      const newExpanded = new Set(state.expandedIds);
      if (newExpanded.has(action.id)) {
        newExpanded.delete(action.id);
      } else {
        newExpanded.add(action.id);
      }
      return { ...state, expandedIds: newExpanded };
    }
    
    case 'SELECT': {
      const newSelected = new Set(action.multi ? state.selectedIds : []);
      if (newSelected.has(action.id)) {
        newSelected.delete(action.id);
      } else {
        newSelected.add(action.id);
      }
      return {
        ...state,
        selectedIds: newSelected,
        focusedId: action.id,
        anchorId: action.id,
      };
    }

    case 'SELECT_RANGE': {
      const newSelected = new Set(action.ids);
      return {
        ...state,
        selectedIds: newSelected,
        focusedId: action.focusId,
        anchorId: action.anchorId ?? action.focusId,
      };
    }
    
    case 'CLEAR_SELECTION':
      return { ...state, selectedIds: new Set(), anchorId: null };

    case 'SET_ANCHOR':
      return { ...state, anchorId: action.id };
    
    case 'SET_FOCUSED':
      return { ...state, focusedId: action.id, anchorId: action.id ?? state.anchorId };
    
    case 'SET_RENAMING':
      return { ...state, renamingId: action.id };
    
    case 'SET_DRAGGED':
      return { ...state, draggedId: action.id };
    
    case 'SET_OVER':
      return { ...state, overId: action.id };
    
    case 'SET_DROP_POSITION':
      return { ...state, dropPosition: action.position };
    
    case 'SET_STATE':
      return { ...state, ...action.state };
    
    default:
      return state;
  }
}

// Context
interface TreeContextValue {
  state: TreeState;
  actions: TreeActions;
  callbacks: TreeCallbacks;
  treeData: TreeData;
}

const TreeContext = createContext<TreeContextValue | null>(null);

export function useTree() {
  const context = useContext(TreeContext);
  if (!context) {
    throw new Error('useTree must be used within TreeProvider');
  }
  return context;
}

interface TreeProviderProps {
  children: React.ReactNode;
  treeData: TreeData;
  initialExpanded?: string[];
  initialSelected?: string[];
  focusedId?: string | null;
  renamingId?: string | null;
  callbacks?: TreeCallbacks;
  forcedExpandedIds?: string[] | null;
}

export function TreeProvider({
  children,
  treeData,
  initialExpanded = [],
  initialSelected = [],
  focusedId = null,
  renamingId = null,
  callbacks = {},
  forcedExpandedIds = null,
}: TreeProviderProps) {
  const [state, dispatch] = useReducer(treeReducer, {
    ...initialState,
    expandedIds: new Set(initialExpanded),
    selectedIds: new Set(initialSelected),
    focusedId: focusedId,
    anchorId: initialSelected.length ? initialSelected[initialSelected.length - 1] : focusedId,
    renamingId: renamingId,
  });

  const computeVisibleIds = useCallback(() => {
    const visible: string[] = [];
    const visit = (id: string, include: boolean) => {
      if (!include) return;
      const node = treeData[id];
      if (!node) return;
      if (id !== 'root') {
        visible.push(id);
      }
      if (!node.children) return;
      const isExpanded = state.expandedIds.has(id) || id === 'root';
      if (!isExpanded) return;
      for (const child of node.children) {
        visit(child, true);
      }
    };
    visit('root', true);
    return visible;
  }, [treeData, state.expandedIds]);

  const actions: TreeActions = {
    expand: useCallback((id: string) => {
      dispatch({ type: 'SET_EXPANDED', id, expanded: true });
      callbacks.onExpand?.(id);
    }, [callbacks]),
    
    collapse: useCallback((id: string) => {
      dispatch({ type: 'SET_EXPANDED', id, expanded: false });
      callbacks.onCollapse?.(id);
    }, [callbacks]),
    
    toggleExpand: useCallback((id: string) => {
      dispatch({ type: 'TOGGLE_EXPANDED', id });
      if (state.expandedIds.has(id)) {
        callbacks.onCollapse?.(id);
      } else {
        callbacks.onExpand?.(id);
      }
    }, [state.expandedIds, callbacks]),
    
    select: useCallback((id: string, multi = false) => {
      dispatch({ type: 'SELECT', id, multi });
      const newSelected = multi ? [...state.selectedIds] : [];
      const idx = newSelected.indexOf(id);
      if (idx >= 0) {
        newSelected.splice(idx, 1);
      } else {
        newSelected.push(id);
      }
      callbacks.onSelect?.(newSelected);
    }, [state.selectedIds, callbacks]),

    selectRange: useCallback((id: string) => {
      const visibleIds = computeVisibleIds();
      if (visibleIds.length === 0) {
        return;
      }
      const anchor = state.anchorId ?? state.focusedId ?? visibleIds[0];
      const anchorIndex = Math.max(0, visibleIds.indexOf(anchor ?? id));
      const targetIndex = Math.max(0, visibleIds.indexOf(id));
      const start = Math.min(anchorIndex === -1 ? targetIndex : anchorIndex, targetIndex);
      const end = Math.max(anchorIndex === -1 ? targetIndex : anchorIndex, targetIndex);
      const range = visibleIds.slice(start, end + 1);
      dispatch({
        type: 'SELECT_RANGE',
        ids: range,
        focusId: id,
        anchorId: anchorIndex === -1 ? id : anchor ?? id,
      });
      callbacks.onSelect?.(range);
      callbacks.onFocus?.(id);
    }, [callbacks, computeVisibleIds, state.anchorId, state.focusedId]),
    
    clearSelection: useCallback(() => {
      dispatch({ type: 'CLEAR_SELECTION' });
      callbacks.onSelect?.([]);
    }, [callbacks]),
    
    focus: useCallback((id: string) => {
      dispatch({ type: 'SET_FOCUSED', id });
      callbacks.onFocus?.(id);
    }, [callbacks]),

    setAnchor: useCallback((id: string | null) => {
      dispatch({ type: 'SET_ANCHOR', id });
    }, []),
    
    startRename: useCallback((id: string) => {
      dispatch({ type: 'SET_RENAMING', id });
    }, []),
    
    endRename: useCallback(() => {
      dispatch({ type: 'SET_RENAMING', id: null });
    }, []),
    
    setDraggedId: useCallback((id: string | null) => {
      dispatch({ type: 'SET_DRAGGED', id });
    }, []),
    
    setOverId: useCallback((id: string | null) => {
      dispatch({ type: 'SET_OVER', id });
    }, []),
    
    setDropPosition: useCallback((position: 'before' | 'after' | 'inside') => {
      dispatch({ type: 'SET_DROP_POSITION', position });
    }, []),
  };

  // 同步外部受控的 selected/expanded/focused/renaming 变化
  useEffect(() => {
    dispatch({
      type: 'SET_STATE',
      state: {
        selectedIds: new Set(initialSelected),
        anchorId: initialSelected.length ? initialSelected[initialSelected.length - 1] : null,
      },
    });
  }, [JSON.stringify(initialSelected)]);
  useEffect(() => {
    const forced = forcedExpandedIds && forcedExpandedIds.length ? forcedExpandedIds : null;
    const target = forced ?? initialExpanded;
    dispatch({ type: 'SET_STATE', state: { expandedIds: new Set(target) } });
  }, [JSON.stringify(forcedExpandedIds || []), JSON.stringify(initialExpanded)]);
  useEffect(() => {
    if (focusedId !== undefined) {
      dispatch({ type: 'SET_STATE', state: { focusedId } });
    }
  }, [focusedId]);
  useEffect(() => {
    if (renamingId !== undefined) {
      dispatch({ type: 'SET_STATE', state: { renamingId } });
    }
  }, [renamingId]);

  return (
    <TreeContext.Provider value={{ state, actions, callbacks, treeData }}>
      {children}
    </TreeContext.Provider>
  );
}
