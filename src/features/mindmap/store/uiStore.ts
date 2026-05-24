/**
 * UI 状态管理
 * 
 * 职责：管理 UI 相关状态（选择、焦点、视图模式等）
 */

import { create } from 'zustand';
import type { NodeId, ThemeId } from '../types';

/** 视图模式 */
export type ViewMode = 'outline' | 'mindmap';

/** UI 状态 */
export interface UIState {
  /** 当前视图模式 */
  viewMode: ViewMode;
  /** 当前聚焦的节点 ID */
  focusedNodeId: NodeId | null;
  /** 选中的节点 ID 列表（多选） */
  selectedNodeIds: NodeId[];
  /** 正在编辑的节点 ID */
  editingNodeId: NodeId | null;
  /** 是否显示搜索栏 */
  showSearch: boolean;
  /** 搜索关键词 */
  searchQuery: string;
  /** 搜索结果节点 ID 列表 */
  searchResults: NodeId[];
  /** 当前搜索结果索引 */
  searchIndex: number;
  /** 当前主题 */
  themeId: ThemeId;
  /** 是否显示小地图 */
  showMinimap: boolean;
  /** 是否显示控制栏 */
  showControls: boolean;
}

/** UI 操作 */
export interface UIActions {
  // 视图模式
  setViewMode: (mode: ViewMode) => void;
  toggleViewMode: () => void;
  
  // 焦点
  setFocusedNodeId: (nodeId: NodeId | null) => void;
  
  // 选择
  selectNode: (nodeId: NodeId, isMultiSelect?: boolean) => void;
  selectNodes: (nodeIds: NodeId[]) => void;
  clearSelection: () => void;
  toggleNodeSelection: (nodeId: NodeId) => void;
  
  // 编辑
  setEditingNodeId: (nodeId: NodeId | null) => void;
  startEditing: (nodeId: NodeId) => void;
  stopEditing: () => void;
  
  // 搜索
  setShowSearch: (show: boolean) => void;
  toggleSearch: () => void;
  setSearchQuery: (query: string) => void;
  setSearchResults: (results: NodeId[]) => void;
  nextSearchResult: () => void;
  prevSearchResult: () => void;
  clearSearch: () => void;
  
  // 主题
  setThemeId: (themeId: ThemeId) => void;
  
  // 显示控制
  setShowMinimap: (show: boolean) => void;
  setShowControls: (show: boolean) => void;
}

export type UIStore = UIState & UIActions;

/** 创建 UI Store */
export const useUIStore = create<UIStore>()((set, get) => ({
  // 初始状态
  viewMode: 'outline',
  focusedNodeId: null,
  selectedNodeIds: [],
  editingNodeId: null,
  showSearch: false,
  searchQuery: '',
  searchResults: [],
  searchIndex: 0,
  themeId: 'dark',
  showMinimap: true,
  showControls: true,

  // 视图模式
  setViewMode: (mode) => set({ viewMode: mode }),
  toggleViewMode: () => set(state => ({
    viewMode: state.viewMode === 'outline' ? 'mindmap' : 'outline',
  })),

  // 焦点
  setFocusedNodeId: (nodeId) => set({ focusedNodeId: nodeId }),

  // 选择
  selectNode: (nodeId, isMultiSelect = false) => {
    set(state => {
      if (isMultiSelect) {
        const isSelected = state.selectedNodeIds.includes(nodeId);
        return {
          selectedNodeIds: isSelected
            ? state.selectedNodeIds.filter(id => id !== nodeId)
            : [...state.selectedNodeIds, nodeId],
          focusedNodeId: nodeId,
        };
      }
      return {
        selectedNodeIds: [nodeId],
        focusedNodeId: nodeId,
      };
    });
  },

  selectNodes: (nodeIds) => set({
    selectedNodeIds: nodeIds,
    focusedNodeId: nodeIds.length > 0 ? nodeIds[nodeIds.length - 1] : null,
  }),

  clearSelection: () => set({
    selectedNodeIds: [],
    focusedNodeId: null,
  }),

  toggleNodeSelection: (nodeId) => {
    set(state => {
      const isSelected = state.selectedNodeIds.includes(nodeId);
      return {
        selectedNodeIds: isSelected
          ? state.selectedNodeIds.filter(id => id !== nodeId)
          : [...state.selectedNodeIds, nodeId],
      };
    });
  },

  // 编辑
  setEditingNodeId: (nodeId) => set({ editingNodeId: nodeId }),
  startEditing: (nodeId) => set({ editingNodeId: nodeId, focusedNodeId: nodeId }),
  stopEditing: () => set({ editingNodeId: null }),

  // 搜索
  setShowSearch: (show) => set({ showSearch: show }),
  toggleSearch: () => set(state => ({ showSearch: !state.showSearch })),
  setSearchQuery: (query) => set({ searchQuery: query, searchIndex: 0 }),
  setSearchResults: (results) => set({ searchResults: results, searchIndex: 0 }),
  nextSearchResult: () => set(state => ({
    searchIndex: state.searchResults.length > 0
      ? (state.searchIndex + 1) % state.searchResults.length
      : 0,
  })),
  prevSearchResult: () => set(state => ({
    searchIndex: state.searchResults.length > 0
      ? (state.searchIndex - 1 + state.searchResults.length) % state.searchResults.length
      : 0,
  })),
  clearSearch: () => set({
    showSearch: false,
    searchQuery: '',
    searchResults: [],
    searchIndex: 0,
  }),

  // 主题
  setThemeId: (themeId) => set({ themeId }),

  // 显示控制
  setShowMinimap: (show) => set({ showMinimap: show }),
  setShowControls: (show) => set({ showControls: show }),
}));

