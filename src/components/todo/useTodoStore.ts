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
  searchItems: (query: string) => Promise<void>;

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
    set({ activeListId: listId, selectedItemId: null, items: [] });
    if (listId) {
      get().loadItems(listId, get().filter.showCompleted);
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
    set({ isLoadingItems: true, error: null });
    try {
      const items = await api.listTodoItems(listId, includeCompleted);
      set({ items, isLoadingItems: false });
    } catch (e) {
      set({ error: String(e), isLoadingItems: false });
    }
  },

  createItem: async (input) => {
    try {
      const item = await api.createTodoItem(input);
      set((s) => ({ items: [...s.items, item] }));
      return item;
    } catch (e) {
      set({ error: String(e) });
      throw e;
    }
  },

  updateItem: async (input) => {
    try {
      const updated = await api.updateTodoItem(input);
      set((s) => ({
        items: s.items.map((i) => (i.id === input.id ? updated : i)),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  toggleItem: async (itemId) => {
    try {
      const updated = await api.toggleTodoItem(itemId);
      set((s) => ({
        items: s.items.map((i) => (i.id === itemId ? updated : i)),
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  deleteItem: async (itemId) => {
    try {
      await api.deleteTodoItem(itemId);
      set((s) => ({
        items: s.items.filter((i) => i.id !== itemId),
        selectedItemId: s.selectedItemId === itemId ? null : s.selectedItemId,
      }));
    } catch (e) {
      set({ error: String(e) });
    }
  },

  selectItem: (itemId) => set({ selectedItemId: itemId }),

  // ========================================================================
  // 视图查询
  // ========================================================================

  loadTodayItems: async () => {
    set({ isLoadingItems: true, error: null });
    try {
      const items = await api.listTodayItems();
      set({ items, isLoadingItems: false });
    } catch (e) {
      set({ error: String(e), isLoadingItems: false });
    }
  },

  loadOverdueItems: async () => {
    set({ isLoadingItems: true, error: null });
    try {
      const items = await api.listOverdueItems();
      set({ items, isLoadingItems: false });
    } catch (e) {
      set({ error: String(e), isLoadingItems: false });
    }
  },

  loadUpcomingItems: async (days = 7) => {
    set({ isLoadingItems: true, error: null });
    try {
      const items = await api.listUpcomingItems(days);
      set({ items, isLoadingItems: false });
    } catch (e) {
      set({ error: String(e), isLoadingItems: false });
    }
  },

  searchItems: async (query) => {
    set({ isLoadingItems: true, error: null });
    try {
      const items = await api.searchTodoItems(query);
      set({ items, isLoadingItems: false });
    } catch (e) {
      set({ error: String(e), isLoadingItems: false });
    }
  },

  // ========================================================================
  // 过滤操作
  // ========================================================================

  setViewFilter: (view) => {
    set((s) => ({ filter: { ...s.filter, view } }));
    const state = get();
    switch (view) {
      case 'today':
        state.loadTodayItems();
        break;
      case 'overdue':
        state.loadOverdueItems();
        break;
      case 'upcoming':
        state.loadUpcomingItems();
        break;
      case 'all':
        if (state.activeListId) {
          state.loadItems(state.activeListId, state.filter.showCompleted);
        }
        break;
    }
  },

  setSearch: (search) => {
    set((s) => ({ filter: { ...s.filter, search } }));
    if (search.trim()) {
      get().searchItems(search);
    } else {
      // Fix: restore data for the current view, not just when activeListId exists
      const state = get();
      switch (state.filter.view) {
        case 'today':
          state.loadTodayItems();
          break;
        case 'overdue':
          state.loadOverdueItems();
          break;
        case 'upcoming':
          state.loadUpcomingItems();
          break;
        case 'all':
        default:
          if (state.activeListId) {
            state.loadItems(state.activeListId, state.filter.showCompleted);
          }
          break;
      }
    }
  },

  setPriorityFilter: (priority) =>
    set((s) => ({ filter: { ...s.filter, priorityFilter: priority } })),

  setShowCompleted: (show) => {
    set((s) => ({ filter: { ...s.filter, showCompleted: show } }));
    const state = get();
    if (state.activeListId) {
      state.loadItems(state.activeListId, show);
    }
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
