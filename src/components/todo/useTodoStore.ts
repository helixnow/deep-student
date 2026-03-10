/**
 * 待办管理 Zustand Store
 */

import { create } from 'zustand';
import type {
  TodoList,
  TodoItem,
  TodoFilterState,
  CreateTodoItemInput,
  UpdateTodoItemInput,
  TodoPriority,
  TodoViewFilter,
} from './types';
import * as api from './api';

interface TodoState {
  // 数据
  lists: TodoList[];
  activeListId: string | null;
  items: TodoItem[];
  selectedItemId: string | null;

  // 过滤
  filter: TodoFilterState;

  // 加载状态
  isLoadingLists: boolean;
  isLoadingItems: boolean;
  itemsRequestVersion: number;
  error: string | null;

  // 列表操作
  loadLists: () => Promise<void>;
  setActiveList: (listId: string | null) => void;
  createList: (title: string, description?: string) => Promise<TodoList>;
  updateList: (id: string, title?: string, description?: string) => Promise<void>;
  deleteList: (id: string) => Promise<void>;
  toggleListFavorite: (id: string) => Promise<void>;

  // 待办项操作
  loadItems: (listId: string, includeCompleted?: boolean) => Promise<void>;
  createItem: (input: CreateTodoItemInput) => Promise<TodoItem>;
  updateItem: (input: UpdateTodoItemInput) => Promise<void>;
  toggleItem: (itemId: string) => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  selectItem: (itemId: string | null) => void;

  // 视图查询
  loadTodayItems: () => Promise<void>;
  loadOverdueItems: () => Promise<void>;
  loadUpcomingItems: (days?: number) => Promise<void>;
  loadCompletedItems: () => Promise<void>;
  searchItems: (query: string) => Promise<void>;
  reloadCurrentView: () => Promise<void>;

  // 过滤操作
  setViewFilter: (view: TodoViewFilter) => void;
  setSearch: (search: string) => void;
  setPriorityFilter: (priority: TodoPriority | null) => void;
  setShowCompleted: (show: boolean) => void;

  // 初始化
  initialize: () => Promise<void>;
}

export const useTodoStore = create<TodoState>((set, get) => ({
  lists: [],
  activeListId: null,
  items: [],
  selectedItemId: null,

  filter: {
    view: 'all',
    search: '',
    priorityFilter: null,
    showCompleted: false,
  },

  isLoadingLists: false,
  isLoadingItems: false,
  itemsRequestVersion: 0,
  error: null,

  // ========================================================================
  // 列表操作
  // ========================================================================

  loadLists: async () => {
    set({ isLoadingLists: true, error: null });
    try {
      const lists = await api.listTodoLists();
      set({ lists, isLoadingLists: false });
    } catch (e) {
      set({ error: String(e), isLoadingLists: false });
    }
  },

  setActiveList: (listId) => {
    set((s) => ({
      activeListId: listId,
      selectedItemId: null,
      items: [],
      isLoadingItems: false,
      itemsRequestVersion: s.itemsRequestVersion + 1,
    }));
    if (get().filter.view === 'all' && listId) {
      void get().reloadCurrentView();
    }
  },

  createList: async (title, description) => {
    try {
      const list = await api.createTodoList({ title, description });
      set((s) => ({ lists: [...s.lists, list] }));
      return list;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  updateList: async (id, title, description) => {
    try {
      const updated = await api.updateTodoList({ id, title, description });
      set((s) => ({
        lists: s.lists.map((l) => (l.id === id ? updated : l)),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  deleteList: async (id) => {
    try {
      await api.deleteTodoList(id);
      set((s) => ({
        lists: s.lists.filter((l) => l.id !== id),
        activeListId: s.activeListId === id ? null : s.activeListId,
        items: s.activeListId === id ? [] : s.items,
        selectedItemId: s.activeListId === id ? null : s.selectedItemId,
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  toggleListFavorite: async (id) => {
    try {
      const updated = await api.toggleTodoListFavorite(id);
      set((s) => ({
        lists: s.lists.map((l) => (l.id === id ? updated : l)),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  // ========================================================================
  // 待办项操作
  // ========================================================================

  loadItems: async (listId, includeCompleted = false) => {
    const requestVersion = get().itemsRequestVersion + 1;
    set({ isLoadingItems: true, itemsRequestVersion: requestVersion, error: null });
    try {
      const items = await api.listTodoItems(listId, includeCompleted);
      if (get().itemsRequestVersion !== requestVersion) return;
      const selectedItemId = get().selectedItemId;
      set({
        items,
        isLoadingItems: false,
        selectedItemId: selectedItemId && items.some((item) => item.id === selectedItemId)
          ? selectedItemId
          : null,
      });
    } catch (e) {
      if (get().itemsRequestVersion !== requestVersion) return;
      set({ error: String(e), isLoadingItems: false });
    }
  },

  createItem: async (input) => {
    try {
      const item = await api.createTodoItem(input);
      await get().reloadCurrentView();
      return item;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  updateItem: async (input) => {
    try {
      await api.updateTodoItem(input);
      await get().reloadCurrentView();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  toggleItem: async (itemId) => {
    try {
      await api.toggleTodoItem(itemId);
      await get().reloadCurrentView();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  deleteItem: async (itemId) => {
    try {
      await api.deleteTodoItem(itemId);
      set((s) => ({
        selectedItemId: s.selectedItemId === itemId ? null : s.selectedItemId,
      }));
      await get().reloadCurrentView();
    } catch (e) {
      set({ error: String(e) });
    }
  },

  selectItem: (itemId) => set({ selectedItemId: itemId }),

  // ========================================================================
  // 视图查询
  // ========================================================================

  loadTodayItems: async () => {
    const requestVersion = get().itemsRequestVersion + 1;
    set({ isLoadingItems: true, itemsRequestVersion: requestVersion, error: null });
    try {
      const items = await api.listTodayItems(get().filter.showCompleted);
      if (get().itemsRequestVersion !== requestVersion) return;
      const selectedItemId = get().selectedItemId;
      set({
        items,
        isLoadingItems: false,
        selectedItemId: selectedItemId && items.some((item) => item.id === selectedItemId)
          ? selectedItemId
          : null,
      });
    } catch (e) {
      if (get().itemsRequestVersion !== requestVersion) return;
      set({ error: String(e), isLoadingItems: false });
    }
  },

  loadOverdueItems: async () => {
    const requestVersion = get().itemsRequestVersion + 1;
    set({ isLoadingItems: true, itemsRequestVersion: requestVersion, error: null });
    try {
      const items = await api.listOverdueItems(get().filter.showCompleted);
      if (get().itemsRequestVersion !== requestVersion) return;
      const selectedItemId = get().selectedItemId;
      set({
        items,
        isLoadingItems: false,
        selectedItemId: selectedItemId && items.some((item) => item.id === selectedItemId)
          ? selectedItemId
          : null,
      });
    } catch (e) {
      if (get().itemsRequestVersion !== requestVersion) return;
      set({ error: String(e), isLoadingItems: false });
    }
  },

  loadUpcomingItems: async (days = 7) => {
    const requestVersion = get().itemsRequestVersion + 1;
    set({ isLoadingItems: true, itemsRequestVersion: requestVersion, error: null });
    try {
      const items = await api.listUpcomingItems(days, get().filter.showCompleted);
      if (get().itemsRequestVersion !== requestVersion) return;
      const selectedItemId = get().selectedItemId;
      set({
        items,
        isLoadingItems: false,
        selectedItemId: selectedItemId && items.some((item) => item.id === selectedItemId)
          ? selectedItemId
          : null,
      });
    } catch (e) {
      if (get().itemsRequestVersion !== requestVersion) return;
      set({ error: String(e), isLoadingItems: false });
    }
  },

  loadCompletedItems: async () => {
    const requestVersion = get().itemsRequestVersion + 1;
    set({ isLoadingItems: true, itemsRequestVersion: requestVersion, error: null });
    try {
      const items = await api.listCompletedItems(get().activeListId ?? undefined);
      if (get().itemsRequestVersion !== requestVersion) return;
      const selectedItemId = get().selectedItemId;
      set({
        items,
        isLoadingItems: false,
        selectedItemId: selectedItemId && items.some((item) => item.id === selectedItemId)
          ? selectedItemId
          : null,
      });
    } catch (e) {
      if (get().itemsRequestVersion !== requestVersion) return;
      set({ error: String(e), isLoadingItems: false });
    }
  },

  searchItems: async (query) => {
    const requestVersion = get().itemsRequestVersion + 1;
    set({ isLoadingItems: true, itemsRequestVersion: requestVersion, error: null });
    try {
      const items = await api.searchTodoItems(query);
      if (get().itemsRequestVersion !== requestVersion) return;
      const selectedItemId = get().selectedItemId;
      set({
        items,
        isLoadingItems: false,
        selectedItemId: selectedItemId && items.some((item) => item.id === selectedItemId)
          ? selectedItemId
          : null,
      });
    } catch (e) {
      if (get().itemsRequestVersion !== requestVersion) return;
      set({ error: String(e), isLoadingItems: false });
    }
  },

  reloadCurrentView: async () => {
    const state = get();
    if (state.filter.search.trim()) {
      await state.searchItems(state.filter.search);
      return;
    }

    switch (state.filter.view) {
      case 'today':
        await state.loadTodayItems();
        return;
      case 'overdue':
        await state.loadOverdueItems();
        return;
      case 'upcoming':
        await state.loadUpcomingItems();
        return;
      case 'completed':
        await state.loadCompletedItems();
        return;
      case 'all':
      default:
        if (state.activeListId) {
          await state.loadItems(state.activeListId, state.filter.showCompleted);
          return;
        }
        set({ items: [], isLoadingItems: false });
    }
  },

  // ========================================================================
  // 过滤操作
  // ========================================================================

  setViewFilter: (view) => {
    set((s) => ({
      filter: { ...s.filter, view },
      selectedItemId: null,
      items: [],
      isLoadingItems: false,
      itemsRequestVersion: s.itemsRequestVersion + 1,
    }));
    void get().reloadCurrentView();
  },

  setSearch: (search) => {
    set((s) => ({
      filter: { ...s.filter, search },
      selectedItemId: null,
      items: [],
      isLoadingItems: false,
      itemsRequestVersion: s.itemsRequestVersion + 1,
    }));
    void get().reloadCurrentView();
  },

  setPriorityFilter: (priority) =>
    set((s) => ({ filter: { ...s.filter, priorityFilter: priority } })),

  setShowCompleted: (show) => {
    set((s) => ({
      filter: { ...s.filter, showCompleted: show },
      selectedItemId: null,
      items: [],
      isLoadingItems: false,
      itemsRequestVersion: s.itemsRequestVersion + 1,
    }));
    void get().reloadCurrentView();
  },

  // ========================================================================
  // 初始化
  // ========================================================================

  initialize: async () => {
    try {
      await api.ensureInbox();
      await get().loadLists();
      const lists = get().lists;
      if (lists.length > 0) {
        const defaultList = lists.find((l) => l.isDefault) || lists[0];
        get().setActiveList(defaultList.id);
      }
    } catch (e) {
      set({ error: String(e) });
    }
  },
}));
