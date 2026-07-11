/**
 * 待办管理 Zustand Store
 */

import { create } from 'zustand';
import i18n from '@/i18n';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type {
  TodoList,
  TodoItem,
  TodoFilterState,
  CreateTodoItemInput,
  UpdateTodoItemInput,
  TodoPriority,
  TodoViewFilter,
  TodoSortBy,
} from '../types';
import * as api from '../api';

// ★ I6 修复：搜索防抖定时器（模块级，store 为单例）
let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const SEARCH_DEBOUNCE_MS = 300;
/** 回收站分页大小（与后端 todo_list_deleted_* 命令的 limit 对应） */
const TRASH_PAGE_SIZE = 100;

// 每次应用启动只发一次逾期系统通知（模块级，store 为单例）
let overdueNotifiedThisLaunch = false;

// ★ 8.1 统一通知策略：经全局三档管线发送（仅后台/总是/从不）
// 逾期汇总属于用户主动关心的提醒，force 绕过 background 前台拦截
async function sendSystemNotification(title: string, body: string): Promise<void> {
  const { sendSystemNotification: send } = await import('@/utils/systemNotification');
  await send(title, body, { force: true });
}

/** 操作失败时统一弹全局错误通知（store 不在 React 上下文，直接用 i18n 实例） */
function notifyError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  showGlobalNotification('error', message, i18n.t('todo:notifications.operationFailed'));
  return message;
}

const SORT_BY_STORAGE_KEY = 'todo-sort-by';
const VALID_SORT_BY: TodoSortBy[] = ['manual', 'dueDate', 'priority', 'title'];

function loadPersistedSortBy(): TodoSortBy {
  try {
    const raw = localStorage.getItem(SORT_BY_STORAGE_KEY);
    return VALID_SORT_BY.includes(raw as TodoSortBy) ? (raw as TodoSortBy) : 'manual';
  } catch {
    return 'manual';
  }
}

interface TodoState {
  // 数据
  lists: TodoList[];
  activeListId: string | null;
  items: TodoItem[];
  selectedItemId: string | null;
  quickAddPreset: { dueDate?: string; requestId: number } | null;

  // 逾期未完成数（侧栏角标）
  overdueCount: number;

  // 回收站
  trashLists: TodoList[];
  trashItems: TodoItem[];
  isLoadingTrash: boolean;
  /** 上次拉取返回了整页数据，可能还有更早的删除记录 */
  trashHasMore: boolean;

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
  reorderItems: (orderedIds: string[]) => Promise<void>;
  selectItem: (itemId: string | null) => void;
  requestQuickAdd: (dueDate?: string) => void;
  clearQuickAddPreset: (requestId: number) => void;

  // 视图查询
  loadTodayItems: () => Promise<void>;
  loadOverdueItems: () => Promise<void>;
  loadUpcomingItems: (days?: number) => Promise<void>;
  loadAllPendingItems: () => Promise<void>;
  loadCompletedItems: () => Promise<void>;
  searchItems: (query: string) => Promise<void>;
  reloadCurrentView: () => Promise<void>;

  // 过滤操作
  setViewFilter: (view: TodoViewFilter) => void;
  setSearch: (search: string) => void;
  setPriorityFilter: (priority: TodoPriority | null) => void;
  setShowCompleted: (show: boolean) => void;
  setSortBy: (sortBy: TodoSortBy) => void;

  // 逾期角标
  refreshOverdueCount: () => Promise<void>;

  // 回收站
  loadTrash: () => Promise<void>;
  loadMoreTrash: () => Promise<void>;
  restoreListFromTrash: (listId: string) => Promise<void>;
  restoreItemFromTrash: (itemId: string) => Promise<void>;
  purgeListFromTrash: (listId: string) => Promise<void>;
  purgeItemFromTrash: (itemId: string) => Promise<void>;
  emptyTrash: () => Promise<void>;

  // 初始化
  initialize: () => Promise<void>;
}

export const useTodoStore = create<TodoState>((set, get) => ({
  lists: [],
  activeListId: null,
  items: [],
  selectedItemId: null,
  quickAddPreset: null,

  overdueCount: 0,

  trashLists: [],
  trashItems: [],
  isLoadingTrash: false,
  trashHasMore: false,

  filter: {
    view: 'all',
    search: '',
    priorityFilter: null,
    showCompleted: false,
    sortBy: loadPersistedSortBy(),
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
      set({ error: notifyError(e), isLoadingLists: false });
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
      set({ error: notifyError(e) });
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
      set({ error: notifyError(e) });
    }
  },

  // 删除清单：软删除 + 撤销 toast；当前清单被删时回退到默认/首个清单
  deleteList: async (id) => {
    const deleted = get().lists.find((l) => l.id === id);
    try {
      await api.deleteTodoList(id);
      set((s) => {
        const lists = s.lists.filter((l) => l.id !== id);
        const wasActive = s.activeListId === id;
        return {
          lists,
          activeListId: wasActive ? null : s.activeListId,
          items: wasActive ? [] : s.items,
          selectedItemId: wasActive ? null : s.selectedItemId,
        };
      });
      // 回退选中：优先默认清单，其次第一个
      if (get().activeListId === null && get().filter.view === 'all') {
        const lists = get().lists;
        const fallback = lists.find((l) => l.isDefault) || lists[0];
        if (fallback) get().setActiveList(fallback.id);
      }
      showGlobalNotification(
        'success',
        i18n.t('todo:notifications.listDeleted', { title: deleted?.title ?? '' }),
        undefined,
        {
          action: {
            label: i18n.t('todo:notifications.undo'),
            onClick: () => {
              void (async () => {
                try {
                  const restored = await api.restoreTodoList(id);
                  set((s) => ({ lists: [...s.lists, restored] }));
                  get().setActiveList(restored.id);
                  await get().loadLists();
                } catch (e) {
                  notifyError(e);
                }
              })();
            },
          },
        },
      );
    } catch (e) {
      set({ error: notifyError(e) });
    }
  },

  toggleListFavorite: async (id) => {
    try {
      const updated = await api.toggleTodoListFavorite(id);
      set((s) => ({
        lists: s.lists.map((l) => (l.id === id ? updated : l)),
      }));
    } catch (e) {
      set({ error: notifyError(e) });
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
      set({ error: notifyError(e), isLoadingItems: false });
    }
  },

  createItem: async (input) => {
    try {
      const item = await api.createTodoItem(input);
      await get().reloadCurrentView();
      return item;
    } catch (e) {
      set({ error: notifyError(e) });
      throw e;
    }
  },

  updateItem: async (input) => {
    try {
      await api.updateTodoItem(input);
      await get().reloadCurrentView();
    } catch (e) {
      set({ error: notifyError(e) });
    }
  },

  // ★ I6 修复：乐观勾选——立即翻转本地状态，成功后用后端返回值就地替换，
  // 失败回滚；不再整表 reload，消除勾选时的列表闪烁与延迟
  toggleItem: async (itemId) => {
    const prevItems = get().items;
    const target = prevItems.find((i) => i.id === itemId);
    if (!target) return;

    const optimisticStatus = target.status === 'completed' ? 'pending' : 'completed';
    set((s) => ({
      items: s.items.map((i) =>
        i.id === itemId ? { ...i, status: optimisticStatus } : i
      ),
      error: null,
    }));

    try {
      const updated = await api.toggleTodoItem(itemId);
      set((s) => {
        const { view, showCompleted } = s.filter;
        // 勾选后是否仍属于当前视图（completed 视图只留已完成；其他视图按 showCompleted）
        const stillVisible =
          view === 'completed'
            ? updated.status === 'completed'
            : updated.status !== 'completed' || showCompleted;
        return {
          items: stillVisible
            ? s.items.map((i) => (i.id === itemId ? updated : i))
            : s.items.filter((i) => i.id !== itemId),
          selectedItemId:
            !stillVisible && s.selectedItemId === itemId ? null : s.selectedItemId,
        };
      });
    } catch (e) {
      // 回滚乐观更新
      set({ items: prevItems, error: notifyError(e) });
    }
  },

  // 删除待办：乐观移除 + 撤销 toast（软删除，可恢复）
  deleteItem: async (itemId) => {
    const prevItems = get().items;
    const target = prevItems.find((i) => i.id === itemId);
    set((s) => ({
      items: s.items.filter((i) => i.id !== itemId),
      selectedItemId: s.selectedItemId === itemId ? null : s.selectedItemId,
    }));
    try {
      await api.deleteTodoItem(itemId);
      showGlobalNotification(
        'success',
        i18n.t('todo:notifications.itemDeleted', { title: target?.title ?? '' }),
        undefined,
        {
          action: {
            label: i18n.t('todo:notifications.undo'),
            onClick: () => {
              void (async () => {
                try {
                  await api.restoreTodoItem(itemId);
                  await get().reloadCurrentView();
                } catch (e) {
                  notifyError(e);
                }
              })();
            },
          },
        },
      );
      // 子任务级联删除等需要整体刷新
      await get().reloadCurrentView();
    } catch (e) {
      set({ items: prevItems, error: notifyError(e) });
    }
  },

  // 拖拽排序：乐观重排本地顺序，失败回滚（仅 'all' 视图的手动排序）
  reorderItems: async (orderedIds) => {
    const listId = get().activeListId;
    if (!listId) return;
    const prevItems = get().items;
    const byId = new Map(prevItems.map((i) => [i.id, i]));
    const reordered = orderedIds
      .map((id) => byId.get(id))
      .filter((i): i is TodoItem => Boolean(i));
    const rest = prevItems.filter((i) => !orderedIds.includes(i.id));
    set({ items: [...reordered, ...rest] });
    try {
      await api.reorderTodoItems(listId, orderedIds);
    } catch (e) {
      set({ items: prevItems, error: notifyError(e) });
    }
  },

  selectItem: (itemId) => set({ selectedItemId: itemId }),

  requestQuickAdd: (dueDate) => set((state) => ({
    quickAddPreset: {
      dueDate,
      requestId: (state.quickAddPreset?.requestId ?? 0) + 1,
    },
  })),

  clearQuickAddPreset: (requestId) => set((state) => (
    state.quickAddPreset?.requestId === requestId ? { quickAddPreset: null } : state
  )),

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
      set({ error: notifyError(e), isLoadingItems: false });
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
      set({ error: notifyError(e), isLoadingItems: false });
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
      set({ error: notifyError(e), isLoadingItems: false });
    }
  },

  loadAllPendingItems: async () => {
    const requestVersion = get().itemsRequestVersion + 1;
    set({ isLoadingItems: true, itemsRequestVersion: requestVersion, error: null });
    try {
      const items = await api.listAllPendingItems();
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
      set({ error: notifyError(e), isLoadingItems: false });
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
      set({ error: notifyError(e), isLoadingItems: false });
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
      set({ error: notifyError(e), isLoadingItems: false });
    }
  },

  reloadCurrentView: async () => {
    const state = get();
    // 数据变更后顺带刷新逾期角标（fire-and-forget，不阻塞视图加载）
    void get().refreshOverdueCount();

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
      case 'matrix':
        await state.loadAllPendingItems();
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

  // ★ I6 修复：搜索防抖——每次按键不再立即整表查询；
  // 输入期间保留旧结果（bump version 使在途请求失效），300ms 静默后才发起查询；
  // 清空搜索时立即恢复当前视图
  setSearch: (search) => {
    set((s) => ({
      filter: { ...s.filter, search },
      selectedItemId: null,
      itemsRequestVersion: s.itemsRequestVersion + 1,
    }));

    if (searchDebounceTimer) {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = null;
    }

    if (!search.trim()) {
      void get().reloadCurrentView();
      return;
    }

    searchDebounceTimer = setTimeout(() => {
      searchDebounceTimer = null;
      void get().reloadCurrentView();
    }, SEARCH_DEBOUNCE_MS);
  },

  setPriorityFilter: (priority) =>
    set((s) => ({ filter: { ...s.filter, priorityFilter: priority } })),

  // 排序为纯客户端行为，不触发重新加载；选择持久化到 localStorage
  setSortBy: (sortBy) => {
    set((s) => ({ filter: { ...s.filter, sortBy } }));
    try {
      localStorage.setItem(SORT_BY_STORAGE_KEY, sortBy);
    } catch {
      // 持久化失败不影响本次会话
    }
  },

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
  // 逾期角标
  // ========================================================================

  refreshOverdueCount: async () => {
    try {
      const items = await api.listOverdueItems(false);
      set({ overdueCount: items.length });
    } catch {
      // 角标属增强信息，失败静默（避免打断主流程的错误提示）
    }
  },

  // ========================================================================
  // 回收站
  // ========================================================================

  loadTrash: async () => {
    set({ isLoadingTrash: true });
    try {
      const [trashLists, trashItems] = await Promise.all([
        api.listDeletedTodoLists(TRASH_PAGE_SIZE, 0),
        api.listDeletedTodoItems(TRASH_PAGE_SIZE, 0),
      ]);
      set({
        trashLists,
        trashItems,
        isLoadingTrash: false,
        trashHasMore:
          trashLists.length >= TRASH_PAGE_SIZE || trashItems.length >= TRASH_PAGE_SIZE,
      });
    } catch (e) {
      set({ isLoadingTrash: false, error: notifyError(e) });
    }
  },

  // ★ 2026-06-12（第二轮审阅）：回收站超过一页时支持继续加载，
  // 否则用户看不到更早的删除记录（而"清空回收站"清的是全部，口径不一致）。
  loadMoreTrash: async () => {
    const { trashLists, trashItems, isLoadingTrash } = get();
    if (isLoadingTrash) return;
    set({ isLoadingTrash: true });
    try {
      const [moreLists, moreItems] = await Promise.all([
        api.listDeletedTodoLists(TRASH_PAGE_SIZE, trashLists.length),
        api.listDeletedTodoItems(TRASH_PAGE_SIZE, trashItems.length),
      ]);
      set((s) => {
        const seenLists = new Set(s.trashLists.map((l) => l.id));
        const seenItems = new Set(s.trashItems.map((i) => i.id));
        return {
          trashLists: [...s.trashLists, ...moreLists.filter((l) => !seenLists.has(l.id))],
          trashItems: [...s.trashItems, ...moreItems.filter((i) => !seenItems.has(i.id))],
          isLoadingTrash: false,
          trashHasMore:
            moreLists.length >= TRASH_PAGE_SIZE || moreItems.length >= TRASH_PAGE_SIZE,
        };
      });
    } catch (e) {
      set({ isLoadingTrash: false, error: notifyError(e) });
    }
  },

  restoreListFromTrash: async (listId) => {
    try {
      const restored = await api.restoreTodoList(listId);
      set((s) => ({ trashLists: s.trashLists.filter((l) => l.id !== listId) }));
      await get().loadLists();
      await get().reloadCurrentView();
      showGlobalNotification(
        'success',
        i18n.t('todo:trash.restored', { title: restored.title }),
      );
    } catch (e) {
      notifyError(e);
    }
  },

  restoreItemFromTrash: async (itemId) => {
    try {
      const restored = await api.restoreTodoItem(itemId);
      set((s) => ({ trashItems: s.trashItems.filter((i) => i.id !== itemId) }));
      await get().reloadCurrentView();
      showGlobalNotification(
        'success',
        i18n.t('todo:trash.restored', { title: restored.title }),
      );
    } catch (e) {
      notifyError(e);
    }
  },

  purgeListFromTrash: async (listId) => {
    try {
      await api.purgeTodoList(listId);
      set((s) => ({ trashLists: s.trashLists.filter((l) => l.id !== listId) }));
    } catch (e) {
      notifyError(e);
    }
  },

  purgeItemFromTrash: async (itemId) => {
    try {
      await api.purgeTodoItem(itemId);
      set((s) => ({ trashItems: s.trashItems.filter((i) => i.id !== itemId) }));
    } catch (e) {
      notifyError(e);
    }
  },

  emptyTrash: async () => {
    try {
      await api.purgeDeletedTodoItems();
      await api.purgeDeletedTodoLists();
      set({ trashLists: [], trashItems: [], trashHasMore: false });
      showGlobalNotification('success', i18n.t('todo:trash.emptied'));
    } catch (e) {
      notifyError(e);
    }
  },

  // ========================================================================
  // 初始化
  // ========================================================================

  initialize: async () => {
    try {
      // 传入本地化标题，避免新库默认建出英文 "Inbox"
      await api.ensureInbox(i18n.t('todo:views.inbox'));
      await get().loadLists();
      const lists = get().lists;
      if (lists.length > 0) {
        const defaultList = lists.find((l) => l.isDefault) || lists[0];
        get().setActiveList(defaultList.id);
      }
      await get().refreshOverdueCount();

      // 启动后首次进入待办时，如有逾期任务发一次系统通知提醒
      const overdue = get().overdueCount;
      if (overdue > 0 && !overdueNotifiedThisLaunch) {
        overdueNotifiedThisLaunch = true;
        void sendSystemNotification(
          i18n.t('todo:overdue.notificationTitle'),
          i18n.t('todo:overdue.notificationBody', { count: overdue }),
        );
      }
    } catch (e) {
      set({ error: notifyError(e) });
    }
  },
}));
