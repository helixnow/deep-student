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
import { localToday, formatLocalDate, addDays, sortTodoItems } from '../types';
import * as api from '../api';
import type {
  TodoCountsSnapshot,
  TodoTrashCounts,
  TodoStatsOverview,
  TodoBatchItemsResult,
  TodoBatchIdsResult,
} from '../api';

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
  const rawMessage = e instanceof Error ? e.message : String(e);
  const todoError = e instanceof api.TodoApiError ? e : null;
  const message =
    todoError && todoError.code !== 'unknown'
      ? i18n.t(`todo:apiErrors.${todoError.code}`, { defaultValue: rawMessage })
      : rawMessage;
  const canRefresh = todoError?.code === 'conflict' || todoError?.code === 'notFound';
  showGlobalNotification(
    'error',
    message,
    i18n.t('todo:notifications.operationFailed'),
    canRefresh
      ? {
          action: {
            label: i18n.t('common:actions.refresh'),
            onClick: () => {
              void useTodoStore.getState().reloadCurrentView();
            },
          },
        }
      : undefined,
  );
  return message;
}

// 数据变更后轻推提醒调度器立即校准一次（动态 import 打破 store ↔ scheduler 环形依赖）
function pokeReminderScheduler(): void {
  void import('../reminderScheduler')
    .then((m) => m.notifyReminderDataChanged())
    .catch(() => {
      // 调度器加载失败不影响主流程
    });
}

// 用户设置提醒的当下（前台、有明确意图）就把系统通知权限要下来：
// 若等首个提醒在后台触发时才请求，权限框不会被看到，提醒会被系统静默丢弃。
// 每次启动最多请求一次（已授予时 ensure 内部直接短路，不弹框）。
let reminderPermissionRequestedThisLaunch = false;
function requestReminderNotificationPermission(): void {
  if (reminderPermissionRequestedThisLaunch) return;
  reminderPermissionRequestedThisLaunch = true;
  void import('@/utils/systemNotification')
    .then((m) => m.ensureSystemNotificationPermission())
    .catch(() => {
      // 权限请求失败不影响主流程（发送时还有兜底请求）
    });
}

const SORT_BY_STORAGE_KEY = 'todo-sort-by';
const VALID_SORT_BY: TodoSortBy[] = ['manual', 'dueDate', 'priority', 'title'];

/** 把 UpdateTodoItemInput 的字段乐观合并到本地 item（tags/attachments 序列化为 *Json） */
function mergeItemInput(item: TodoItem, input: UpdateTodoItemInput): TodoItem {
  const merged: TodoItem = { ...item };
  if (input.title !== undefined) merged.title = input.title;
  if (input.description !== undefined) merged.description = input.description;
  if (input.status !== undefined) merged.status = input.status;
  if (input.priority !== undefined) merged.priority = input.priority;
  if (input.dueDate !== undefined) merged.dueDate = input.dueDate;
  if (input.dueTime !== undefined) merged.dueTime = input.dueTime;
  if (input.reminder !== undefined) merged.reminder = input.reminder;
  if (input.tags !== undefined) merged.tagsJson = JSON.stringify(input.tags);
  if (input.parentId !== undefined) merged.parentId = input.parentId;
  if (input.attachments !== undefined) merged.attachmentsJson = JSON.stringify(input.attachments);
  if (input.repeatJson !== undefined) merged.repeatJson = input.repeatJson;
  if (input.estimatedPomodoros !== undefined) merged.estimatedPomodoros = input.estimatedPomodoros;
  // 状态翻转时同步 completedAt（与 toggleItem 的乐观口径一致；后端返回值随后覆盖）
  if (input.status !== undefined && input.status !== item.status) {
    merged.completedAt = input.status === 'completed' ? new Date().toISOString() : undefined;
  }
  return merged;
}

/** 批量入参清洗：去空白、去重（保持首现顺序），与后端 sanitize 口径一致 */
function sanitizeIds(itemIds: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of itemIds) {
    const id = raw.trim();
    if (id && !seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/** 新建/移动的 item 是否（大致）属于当前视图；拿不准的场景返回 false，交给后台静默校准 */
function itemBelongsToCurrentView(
  item: TodoItem,
  state: Pick<TodoState, 'filter' | 'activeListId'>,
): boolean {
  const { view, showCompleted, search } = state.filter;
  if (search.trim()) return false;
  if (item.status === 'completed' && view !== 'completed' && !showCompleted) return false;
  const today = localToday();
  switch (view) {
    case 'all':
      return state.activeListId !== null && item.todoListId === state.activeListId;
    case 'today':
      // 后端 todo_list_today 口径：pending 含逾期（due_date <= today），
      // completed 仅当天（due_date = today）。此前只认 === today，
      // 导致新建/改期出的逾期项不做乐观插入（要等静默校准才出现）
      if (!item.dueDate) return false;
      return item.status === 'completed' ? item.dueDate === today : item.dueDate <= today;
    case 'upcoming':
      // 必须 pending 且落在未来 7 天窗口内（与 listUpcomingItems(7) 口径一致），
      // 否则 showCompleted 时可能误插已完成项 / 插入窗口之外的条目
      return (
        item.status === 'pending' &&
        Boolean(item.dueDate) &&
        (item.dueDate as string) > today &&
        (item.dueDate as string) <= formatLocalDate(addDays(new Date(), 7))
      );
    case 'overdue':
      return item.status === 'pending' && Boolean(item.dueDate) && (item.dueDate as string) < today;
    case 'matrix':
      return item.status === 'pending';
    case 'completed':
      return item.status === 'completed';
    default:
      return false;
  }
}

/** rootId 及其（多级）子任务的 id 集合，用于级联乐观移除 */
function collectDescendantIds(items: TodoItem[], rootId: string): Set<string> {
  const ids = new Set<string>([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of items) {
      if (item.parentId && ids.has(item.parentId) && !ids.has(item.id)) {
        ids.add(item.id);
        changed = true;
      }
    }
  }
  return ids;
}

function loadPersistedSortBy(): TodoSortBy {
  try {
    const raw = localStorage.getItem(SORT_BY_STORAGE_KEY);
    return VALID_SORT_BY.includes(raw as TodoSortBy) ? (raw as TodoSortBy) : 'manual';
  } catch {
    return 'manual';
  }
}

interface TodoState {
  workspaceView: 'todos' | 'automations';
  // 数据
  lists: TodoList[];
  activeListId: string | null;
  items: TodoItem[];
  selectedItemId: string | null;
  quickAddPreset: { dueDate?: string; requestId: number } | null;

  // 逾期未完成数（侧栏角标）
  overdueCount: number;

  // 侧栏计数快照（与后端 todo_counts_snapshot / F9 契约；后端未落地时保持 null）
  counts: TodoCountsSnapshot | null;

  // 回收站
  trashLists: TodoList[];
  trashItems: TodoItem[];
  isLoadingTrash: boolean;
  /** 上次拉取返回了整页数据，可能还有更早的删除记录 */
  trashHasMore: boolean;
  /** 回收站计数（todo_trash_counts；未拉取/后端未落地时为 null） */
  trashCounts: TodoTrashCounts | null;

  /** 统计总览快照（todo_stats_overview；未拉取时为 null） */
  statsOverview: TodoStatsOverview | null;

  // 过滤
  filter: TodoFilterState;

  // 加载状态
  isLoadingLists: boolean;
  isLoadingItems: boolean;
  itemsRequestVersion: number;
  error: string | null;

  // 列表操作
  setWorkspaceView: (view: 'todos' | 'automations') => void;
  loadLists: () => Promise<void>;
  setActiveList: (listId: string | null) => void;
  createList: (title: string, description?: string) => Promise<TodoList>;
  /**
   * 更新清单。第 4 参为兼容性扩展：{ icon?, color? }，
   * 三态语义与后端一致——undefined 不变、'' 清空、非空字符串设值。
   */
  updateList: (
    id: string,
    title?: string,
    description?: string,
    extra?: { icon?: string; color?: string },
  ) => Promise<void>;
  deleteList: (id: string) => Promise<void>;
  toggleListFavorite: (id: string) => Promise<void>;

  // 待办项操作
  loadItems: (listId: string, includeCompleted?: boolean) => Promise<void>;
  createItem: (input: CreateTodoItemInput) => Promise<TodoItem>;
  updateItem: (input: UpdateTodoItemInput) => Promise<void>;
  toggleItem: (itemId: string) => Promise<void>;
  deleteItem: (itemId: string) => Promise<void>;
  reorderItems: (orderedIds: string[]) => Promise<void>;
  /**
   * 子任务拖拽重排（详情面板用）：orderedIds 为某父任务直接子任务的新顺序。
   * 内部拉全清单 id 序列做精确覆盖（后端 todo_reorder_items 契约），
   * 本地乐观重排 + 失败回滚 + 静默校准。
   */
  reorderSubtasks: (parentId: string, orderedIds: string[]) => Promise<void>;
  moveItemToList: (itemId: string, targetListId: string) => Promise<void>;
  reorderLists: (listIds: string[]) => Promise<void>;
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

  // 侧栏计数快照（失败静默）
  refreshCounts: () => Promise<void>;

  // ========================================================================
  // 批量操作（供 BulkActionBar 切换；单事务后端命令，乐观更新 + 失败回滚）
  // 返回后端结果（含 skippedIds），失败时返回 null 并弹错误通知
  // ========================================================================
  bulkCompleteItems: (itemIds: string[]) => Promise<TodoBatchItemsResult | null>;
  /** dueDate: null/'' 清空到期日（联动清空时间）；dueTime: undefined 保留、'' 清空、'HH:MM' 设值 */
  bulkRescheduleItems: (
    itemIds: string[],
    dueDate?: string | null,
    dueTime?: string | null,
  ) => Promise<TodoBatchItemsResult | null>;
  /** 批量设置优先级（乐观更新 + 定向回滚 + 静默校准，模式同 bulkRescheduleItems） */
  bulkSetPriorityItems: (
    itemIds: string[],
    priority: TodoPriority,
  ) => Promise<TodoBatchItemsResult | null>;
  bulkMoveItems: (itemIds: string[], targetListId: string) => Promise<TodoBatchItemsResult | null>;
  bulkDeleteItems: (itemIds: string[]) => Promise<TodoBatchIdsResult | null>;
  /** 回收站批量恢复（作用于 trashItems） */
  bulkRestoreItems: (itemIds: string[]) => Promise<TodoBatchItemsResult | null>;
  /** 回收站批量彻底删除（作用于 trashItems，不可恢复） */
  bulkPurgeItems: (itemIds: string[]) => Promise<TodoBatchIdsResult | null>;

  /** 回收站计数（失败静默，保留旧值） */
  refreshTrashCounts: () => Promise<void>;
  /** 统计总览（days 默认 30）；成功后写入 statsOverview 并返回，失败返回 null（静默） */
  refreshStatsOverview: (days?: number) => Promise<TodoStatsOverview | null>;

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

export const useTodoStore = create<TodoState>((set, get) => {
  // 静默校准的世代号：两次静默校准并发时，旧响应不得覆盖新响应。
  // 独立于 itemsRequestVersion（那是显式加载的语义，不混用）。
  let silentReloadSeq = 0;

  // ★ 竞态防护 1：同一条目的快速连续写（如详情面板连续 blur 保存、快速双击勾选）。
  // 每次写操作领取该 item 的最新序号；响应返回时只有仍持有最新序号的操作
  // 才允许应用权威结果 / 执行回滚，旧响应直接丢弃（最终一致由静默校准兜底）。
  // 序号取自全局单调计数器：map 条目被清理后再领取不会回到 1，
  // 否则仍在途的旧响应（恰好也持有序号 1）会被误判为最新而覆盖新请求的乐观状态。
  let itemOpCounter = 0;
  const itemOpSeq = new Map<string, number>();
  const acquireItemOp = (itemId: string): number => {
    const seq = ++itemOpCounter;
    itemOpSeq.set(itemId, seq);
    return seq;
  };
  const isLatestItemOp = (itemId: string, seq: number): boolean => itemOpSeq.get(itemId) === seq;
  const releaseItemOp = (itemId: string, seq: number): void => {
    // 只有最新持有者离场时清理，保持 Map 只含在途条目
    if (itemOpSeq.get(itemId) === seq) itemOpSeq.delete(itemId);
  };

  // ★ 竞态防护 2：写操作在途时不应用静默校准结果——
  // 否则先完成的写触发的整表替换会抹掉后启动写操作的乐观状态。
  // 被推迟的校准在全部写操作结束后补跑一次。
  let pendingWrites = 0;
  let reloadDeferred = false;
  const beginWrite = (): void => {
    pendingWrites += 1;
  };
  const endWrite = (): void => {
    pendingWrites = Math.max(0, pendingWrites - 1);
    if (pendingWrites === 0 && reloadDeferred) {
      reloadDeferred = false;
      void silentReloadCurrentView();
    }
  };

  /**
   * 定向快照回滚：只把 affectedIds 还原到 prevItems 中的状态
   * （被乐观移除的按原相对顺序插回，被修改的就地还原），
   * 其余条目保留并发操作产生的现状，快照后新增的条目追加保留。
   */
  const restoreItemsSnapshot = (prevItems: TodoItem[], affectedIds: Set<string>): void => {
    set((s) => {
      const currentById = new Map(s.items.map((i) => [i.id, i]));
      const restored: TodoItem[] = [];
      for (const item of prevItems) {
        if (affectedIds.has(item.id)) {
          restored.push(item);
        } else {
          const current = currentById.get(item.id);
          if (current) restored.push(current);
        }
      }
      const known = new Set(restored.map((i) => i.id));
      for (const item of s.items) {
        if (!known.has(item.id)) restored.push(item);
      }
      return { items: restored };
    });
  };

  /**
   * 重排失败的顺序回滚：只把条目顺序还原为 prevItems 的顺序，
   * 条目对象取当前最新（并发 update/toggle 的乐观或权威状态不被覆盖），
   * 快照后新增的条目追加保留、快照后被移除的条目不塞回。
   */
  const restoreItemsOrder = (prevItems: TodoItem[]): void => {
    set((s) => {
      const currentById = new Map(s.items.map((i) => [i.id, i]));
      const restored: TodoItem[] = [];
      for (const item of prevItems) {
        const current = currentById.get(item.id);
        if (current) restored.push(current);
      }
      const known = new Set(restored.map((i) => i.id));
      for (const item of s.items) {
        if (!known.has(item.id)) restored.push(item);
      }
      return { items: restored };
    });
  };

  /**
   * 子集精确覆盖重排：后端 todo_reorder_items 要求 id 列表精确等于清单内
   * 全部未删除条目。先拉全量序列（含已完成/子任务），把 orderedIds 子集
   * 按新顺序嵌回其原有位置（其余条目位置不动）后整体提交。
   * orderedIds 中已不存在于清单的 id（并发删除）自动剔除。
   *
   * 注意：todo_list_items(includeCompleted=true) 返回的是「按状态分组
   * （pending→completed→cancelled）再按 sort_order」的展示序，直接按返回
   * 顺序提交会把已完成项的 sort_order 全部重写到清单末尾——之后取消完成时
   * 条目会跳到末位。这里按 sortOrder（同序按 createdAt，与后端排序键一致）
   * 重建真实的 sort_order 序列后再嵌入子集。
   */
  const reorderSubsetExact = async (listId: string, orderedIds: string[]): Promise<void> => {
    const fullItems = await api.listTodoItems(listId, true);
    fullItems.sort((a, b) =>
      a.sortOrder !== b.sortOrder
        ? a.sortOrder - b.sortOrder
        : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
    const fullIds = fullItems.map((i) => i.id);
    const present = new Set(fullIds);
    const queue = orderedIds.filter((id) => present.has(id));
    if (queue.length === 0) return;
    const subset = new Set(queue);
    let cursor = 0;
    const nextIds = fullIds.map((id) => (subset.has(id) ? queue[cursor++] : id));
    await api.reorderTodoItems(listId, nextIds);
  };

  // 计数快照刷新节流：写操作密集时合并为一次后端查询
  let countsRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const COUNTS_REFRESH_DEBOUNCE_MS = 300;
  const scheduleCountsRefresh = (): void => {
    if (countsRefreshTimer !== null) clearTimeout(countsRefreshTimer);
    countsRefreshTimer = setTimeout(() => {
      countsRefreshTimer = null;
      void get().refreshCounts();
      // 软删除/恢复/撤销等路径统一经此防抖口刷新回收站徽标，
      // 避免单条 deleteItem/deleteList 后侧栏计数陈旧
      void get().refreshTrashCounts();
    }, COUNTS_REFRESH_DEBOUNCE_MS);
  };

  /**
   * 静默校准当前视图：后台重新拉取当前视图数据，成功后整体替换 items，
   * 但不清空旧列表、不置 isLoadingItems（写路径乐观更新后的最终一致性兜底）。
   * 只快照而不 bump itemsRequestVersion——不打断在途的显式加载；
   * 若期间有显式加载启动（版本变化）或有更新的静默校准启动（世代号变化），
   * 丢弃本次静默结果。
   */
  const silentReloadCurrentView = async (): Promise<void> => {
    const state = get();
    void state.refreshOverdueCount();

    const requestVersion = state.itemsRequestVersion;
    const seq = ++silentReloadSeq;

    try {
      let items: TodoItem[] | null = null;
      if (state.filter.search.trim()) {
        items = await api.searchTodoItems(state.filter.search);
      } else {
        switch (state.filter.view) {
          case 'today':
            items = await api.listTodayItems(state.filter.showCompleted);
            break;
          case 'overdue':
            items = await api.listOverdueItems(state.filter.showCompleted);
            break;
          case 'upcoming':
            items = await api.listUpcomingItems(7, state.filter.showCompleted);
            break;
          case 'matrix':
            items = await api.listAllPendingItems();
            break;
          case 'completed':
            items = await api.listCompletedItems(state.activeListId ?? undefined);
            break;
          case 'all':
          default:
            if (state.activeListId) {
              items = await api.listTodoItems(state.activeListId, state.filter.showCompleted);
            }
            break;
        }
      }
      if (!Array.isArray(items)) return;
      if (get().itemsRequestVersion !== requestVersion) return;
      if (seq !== silentReloadSeq) return; // 已有更新的静默校准在途/完成，丢弃旧响应
      if (pendingWrites > 0) {
        // 有写操作在途：整表替换会抹掉其乐观状态，推迟到全部写结束后补跑
        reloadDeferred = true;
        return;
      }
      const selectedItemId = get().selectedItemId;
      set({
        items,
        selectedItemId: selectedItemId && items.some((item) => item.id === selectedItemId)
          ? selectedItemId
          : null,
      });
      scheduleCountsRefresh();
    } catch {
      // 静默校准失败不打扰用户（乐观状态已经可用，下次显式刷新会纠正）
    }
  };

  return {
  workspaceView: 'todos',
  lists: [],
  activeListId: null,
  items: [],
  selectedItemId: null,
  quickAddPreset: null,

  overdueCount: 0,
  counts: null,

  trashLists: [],
  trashItems: [],
  isLoadingTrash: false,
  trashHasMore: false,
  trashCounts: null,

  statsOverview: null,

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

  setWorkspaceView: (workspaceView) => set({ workspaceView, selectedItemId: null }),

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

  updateList: async (id, title, description, extra) => {
    try {
      const updated = await api.updateTodoList({
        id,
        title,
        description,
        icon: extra?.icon,
        color: extra?.color,
      });
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
      // 级联软删除会改变逾期角标与各类计数
      void get().refreshOverdueCount();
      scheduleCountsRefresh();
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
                  // 级联恢复的条目要立刻可见；reloadCurrentView 内部会刷新逾期角标
                  await get().reloadCurrentView();
                  scheduleCountsRefresh();
                  pokeReminderScheduler();
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

  // ★ 乐观写路径：用后端返回值就地追加，不再 await 整表 reload（消除新建闪烁）；
  // 视图归属拿不准/排序需要校准时由后台静默 reload 兜底
  createItem: async (input) => {
    if (input.reminder) requestReminderNotificationPermission();
    try {
      const item = await api.createTodoItem(input);
      if (itemBelongsToCurrentView(item, get())) {
        set((s) => (s.items.some((i) => i.id === item.id) ? s : { items: [...s.items, item] }));
      }
      void silentReloadCurrentView();
      scheduleCountsRefresh();
      pokeReminderScheduler();
      return item;
    } catch (e) {
      set({ error: notifyError(e) });
      throw e;
    }
  },

  // ★ 乐观更新：先本地合并输入字段，成功后用后端完整 item 就地替换，失败回滚；
  // 不再整表 reload（修复详情 blur 保存时列表闪烁）。若更新后不再属于当前视图
  // （如改到期日移出「今天」），由后台静默 reload 校准，不清空列表
  updateItem: async (input) => {
    if (input.reminder) requestReminderNotificationPermission();
    // 定向快照：只记录本条 item 的修改前状态。失败时定向回滚该条，
    // 不做全表快照回滚——否则会覆盖并发请求对其他条目的成功结果
    const prevItem = get().items.find((i) => i.id === input.id);
    // 领取本条目的最新写序号：同一条目快速连续保存时，
    // 旧请求的迟到响应（成功或失败）都不得覆盖新请求的乐观状态
    const opSeq = acquireItemOp(input.id);
    if (prevItem) {
      set((s) => ({
        items: s.items.map((i) => (i.id === input.id ? mergeItemInput(i, input) : i)),
        error: null,
      }));
    }
    beginWrite();
    try {
      const updated = await api.updateTodoItem(input);
      if (prevItem && isLatestItemOp(input.id, opSeq)) {
        set((s) => {
          const { view, showCompleted } = s.filter;
          const stillVisible =
            view === 'completed'
              ? updated.status === 'completed'
              : updated.status !== 'completed' || showCompleted;
          return {
            items: stillVisible
              ? s.items.map((i) => (i.id === updated.id ? updated : i))
              : s.items.filter((i) => i.id !== updated.id),
            selectedItemId:
              !stillVisible && s.selectedItemId === updated.id ? null : s.selectedItemId,
          };
        });
      }
      void silentReloadCurrentView();
      scheduleCountsRefresh();
      pokeReminderScheduler();
    } catch (e) {
      set((s) => ({
        // 旧请求失败但已有更新的写在途时不回滚（新写的乐观状态优先）；
        // item 已被其他并发操作移除时也不强行塞回
        items: prevItem && isLatestItemOp(input.id, opSeq)
          ? s.items.map((i) => (i.id === input.id ? prevItem : i))
          : s.items,
        error: notifyError(e),
      }));
    } finally {
      releaseItemOp(input.id, opSeq);
      endWrite();
    }
  },

  // ★ I6 修复：乐观勾选——立即翻转本地状态，成功后用后端返回值就地替换，
  // 失败定向回滚；不再整表 reload，消除勾选时的列表闪烁与延迟
  toggleItem: async (itemId) => {
    const target = get().items.find((i) => i.id === itemId);
    if (!target) {
      // ★ 审查轮修复（review-todo-list.md §2）：完成动画延迟提交期间切视图/
      // 整表替换后条目已不在当前 items——此前静默 no-op 直接丢操作。
      // 无本地条目可做乐观更新，改为直接提交后端翻转，静默校准 + 计数刷新兜底。
      // 仍领取写序号：让同条目在途的旧响应（若有）失效，避免迟到覆盖。
      const opSeq = acquireItemOp(itemId);
      beginWrite();
      try {
        await api.toggleTodoItem(itemId);
        void silentReloadCurrentView();
        scheduleCountsRefresh();
        pokeReminderScheduler();
      } catch (e) {
        set({ error: notifyError(e) });
      } finally {
        releaseItemOp(itemId, opSeq);
        endWrite();
      }
      return;
    }

    const completing = target.status !== 'completed';
    // 与 updateItem 共用同一条目写序号：快速连翻/翻转+保存交错时旧响应不覆盖新状态
    const opSeq = acquireItemOp(itemId);
    set((s) => ({
      items: s.items.map((i) =>
        i.id === itemId
          ? {
              ...i,
              status: completing ? 'completed' : 'pending',
              // 乐观翻转时同步 completedAt（后端返回值随后覆盖为权威值）
              completedAt: completing ? new Date().toISOString() : undefined,
            }
          : i
      ),
      error: null,
    }));

    beginWrite();
    try {
      const updated = await api.toggleTodoItem(itemId);
      if (isLatestItemOp(itemId, opSeq)) {
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
      }
      // 勾选影响逾期角标；重复任务完成后派生的下一次也要出现——静默校准兜底
      void silentReloadCurrentView();
      scheduleCountsRefresh();
      pokeReminderScheduler();
    } catch (e) {
      // 定向回滚：只还原本条 item（已被并发操作移除、或已有更新写在途时不塞回）
      set((s) => ({
        items: isLatestItemOp(itemId, opSeq)
          ? s.items.map((i) => (i.id === itemId ? target : i))
          : s.items,
        error: notifyError(e),
      }));
    } finally {
      releaseItemOp(itemId, opSeq);
      endWrite();
    }
  },

  // 删除待办：乐观移除（含本地可见的子任务级联）+ 撤销 toast（软删除，可恢复）。
  // 不再删除后整表 reload——后台静默校准即可，避免列表二次闪烁
  deleteItem: async (itemId) => {
    const prevItems = get().items;
    const target = prevItems.find((i) => i.id === itemId);
    const removedIds = collectDescendantIds(prevItems, itemId);
    set((s) => ({
      items: s.items.filter((i) => !removedIds.has(i.id)),
      selectedItemId:
        s.selectedItemId && removedIds.has(s.selectedItemId) ? null : s.selectedItemId,
    }));
    beginWrite();
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
                  await silentReloadCurrentView();
                  scheduleCountsRefresh();
                  pokeReminderScheduler();
                } catch (e) {
                  notifyError(e);
                }
              })();
            },
          },
        },
      );
      void silentReloadCurrentView();
      scheduleCountsRefresh();
      pokeReminderScheduler();
    } catch (e) {
      // 定向回滚：只把被乐观移除的条目按原相对顺序插回，
      // 已被并发操作更新/新增的其他条目保持现状
      restoreItemsSnapshot(prevItems, removedIds);
      set({ error: notifyError(e) });
    } finally {
      endWrite();
    }
  },

  // 拖拽排序：乐观重排本地顺序，失败回滚（仅 'all' 视图的手动排序）。
  // ★ 修复：后端 todo_reorder_items 要求 id 列表精确覆盖清单内全部未删除条目
  // （含子任务与已完成项），而 UI 只传可见顶层子集——此前只要清单里存在
  // 子任务/隐藏的已完成项，拖拽排序必然被后端拒绝回滚。
  // 现在先拉全量 id 序列，把子集的新顺序嵌回原位置后做精确覆盖提交。
  reorderItems: async (orderedIds) => {
    const listId = get().activeListId;
    if (!listId) return;
    const prevItems = get().items;
    const orderedSet = new Set(orderedIds);
    const byId = new Map(prevItems.map((i) => [i.id, i]));
    const reordered = orderedIds
      .map((id) => byId.get(id))
      .filter((i): i is TodoItem => Boolean(i));
    const rest = prevItems.filter((i) => !orderedSet.has(i.id));
    set({ items: [...reordered, ...rest] });
    beginWrite();
    try {
      await reorderSubsetExact(listId, orderedIds);
    } catch (e) {
      // 只回滚顺序：整表 set(prevItems) 会连带覆盖并发写的乐观状态、
      // 丢掉快照后新建的条目
      restoreItemsOrder(prevItems);
      set({ error: notifyError(e) });
    } finally {
      endWrite();
    }
  },

  // 子任务拖拽重排：orderedIds 为某父任务直接子任务的新顺序；
  // 其余条目（顶层/其他父的子任务/已完成项）位置不变
  reorderSubtasks: async (parentId, orderedIds) => {
    const prevItems = get().items;
    const parent =
      prevItems.find((i) => i.id === parentId) ?? (await api.getTodoItem(parentId));
    if (!parent) return;
    const listId = parent.todoListId;

    // 乐观重排：本地可见的这些子任务按新顺序占据原有位置
    const orderedSet = new Set(orderedIds);
    const localQueue = orderedIds.filter((id) => prevItems.some((i) => i.id === id));
    if (localQueue.length > 0) {
      const queue = [...localQueue];
      const byId = new Map(prevItems.map((i) => [i.id, i]));
      set((s) => ({
        items: s.items.map((i) => {
          if (!orderedSet.has(i.id)) return i;
          const nextId = queue.shift();
          return nextId ? byId.get(nextId) ?? i : i;
        }),
      }));
    }
    beginWrite();
    try {
      await reorderSubsetExact(listId, orderedIds);
      void silentReloadCurrentView();
    } catch (e) {
      // 重排只动顺序，回滚也只还原顺序（不回退条目内容，
      // 避免覆盖并发 update/toggle 的乐观状态）
      restoreItemsOrder(prevItems);
      set({ error: notifyError(e) });
    } finally {
      endWrite();
    }
  },

  // 移动到其他清单：乐观更新本地 todoListId（'all' 视图移出当前清单则本地移除），
  // 成功后用后端返回 item 替换，失败定向回滚。
  // ★ 修复：后端移动的是整棵子树——本地级联同步（此前只动父项，
  // 移出当前清单时可见的子任务会悬挂残留到静默校准）
  moveItemToList: async (itemId, targetListId) => {
    const prevSelectedItemId = get().selectedItemId;
    const prevItems = get().items;
    const target = prevItems.find((i) => i.id === itemId);
    const state = get();
    const leavesCurrentView =
      state.filter.view === 'all' &&
      state.activeListId !== null &&
      targetListId !== state.activeListId;
    const movedIds = target ? collectDescendantIds(prevItems, itemId) : new Set<string>();

    if (target) {
      set((s) => ({
        items: leavesCurrentView
          ? s.items.filter((i) => !movedIds.has(i.id))
          : s.items.map((i) => (movedIds.has(i.id) ? { ...i, todoListId: targetListId } : i)),
        selectedItemId:
          leavesCurrentView && s.selectedItemId && movedIds.has(s.selectedItemId)
            ? null
            : s.selectedItemId,
        error: null,
      }));
    }

    beginWrite();
    try {
      const updated = await api.moveTodoItem(itemId, targetListId);
      if (target && !leavesCurrentView) {
        set((s) => ({
          items: s.items.map((i) => (i.id === itemId ? updated : i)),
        }));
      }
      void silentReloadCurrentView();
      scheduleCountsRefresh();
    } catch (e) {
      // 定向回滚：只还原被移动的子树（乐观移除则按原相对顺序插回，仍在场则就地还原）
      if (target) restoreItemsSnapshot(prevItems, movedIds);
      set((s) => ({
        selectedItemId:
          leavesCurrentView && s.selectedItemId === null && prevSelectedItemId !== null &&
          movedIds.has(prevSelectedItemId)
            ? prevSelectedItemId
            : s.selectedItemId,
        error: notifyError(e),
      }));
    } finally {
      endWrite();
    }
  },

  // 清单拖拽排序：乐观重排本地 lists，失败回滚
  reorderLists: async (listIds) => {
    const prevLists = get().lists;
    const byId = new Map(prevLists.map((l) => [l.id, l]));
    const reordered = listIds
      .map((id) => byId.get(id))
      .filter((l): l is TodoList => Boolean(l));
    const rest = prevLists.filter((l) => !listIds.includes(l.id));
    set({ lists: [...reordered, ...rest], error: null });
    try {
      await api.reorderTodoLists(listIds);
    } catch (e) {
      set({ lists: prevLists, error: notifyError(e) });
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

  // ★ 修复闪白：切视图不再瞬间清空 items——保留旧列表，
  // reloadCurrentView 会置 isLoadingItems 并 bump version，加载完成后整体替换
  setViewFilter: (view) => {
    set((s) => ({
      filter: { ...s.filter, view },
      selectedItemId: null,
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

  // 同 setViewFilter：保留旧列表直至新数据到达，避免闪白
  setShowCompleted: (show) => {
    set((s) => ({
      filter: { ...s.filter, showCompleted: show },
      selectedItemId: null,
      itemsRequestVersion: s.itemsRequestVersion + 1,
    }));
    void get().reloadCurrentView();
  },

  // ========================================================================
  // 逾期角标
  // ========================================================================

  refreshOverdueCount: async () => {
    // 优先走聚合统计（todo_get_active_summary 单次查询），失败再回退全量逾期列表
    try {
      const summary = await api.getActiveTodoSummary();
      const count = summary?.stats?.overdueCount;
      if (typeof count === 'number' && Number.isFinite(count)) {
        set({ overdueCount: count });
        return;
      }
    } catch {
      // 回退旧方案
    }
    try {
      const items = await api.listOverdueItems(false);
      if (Array.isArray(items)) set({ overdueCount: items.length });
    } catch {
      // 角标属增强信息，失败静默（避免打断主流程的错误提示）
    }
  },

  // ========================================================================
  // 侧栏计数快照
  // ========================================================================

  refreshCounts: async () => {
    try {
      const counts = await api.getTodoCountsSnapshot();
      if (counts) set({ counts });
    } catch {
      // 后端 todo_counts_snapshot 可能尚未落地/查询失败：静默容错，保留旧快照
    }
  },

  // ========================================================================
  // 批量操作（2026-07-20 新增；单事务后端命令 + 乐观更新 + 定向回滚）
  // ========================================================================

  bulkCompleteItems: async (itemIds) => {
    const ids = sanitizeIds(itemIds);
    if (ids.length === 0) return { items: [], skippedIds: [] };
    const prevItems = get().items;
    const affected = new Set(ids);
    const nowIso = new Date().toISOString();
    const { view, showCompleted } = get().filter;
    const keepCompleted = view === 'completed' || showCompleted;
    set((s) => ({
      items: keepCompleted
        ? s.items.map((i) =>
            affected.has(i.id) && i.status !== 'completed'
              ? { ...i, status: 'completed' as const, completedAt: nowIso }
              : i,
          )
        : s.items.filter((i) => !affected.has(i.id)),
      selectedItemId:
        !keepCompleted && s.selectedItemId && affected.has(s.selectedItemId)
          ? null
          : s.selectedItemId,
      error: null,
    }));
    beginWrite();
    try {
      const result = await api.batchCompleteTodoItems(ids);
      // 仍可见的条目就地替换为权威状态；重复任务派生的下一实例由静默校准带入
      const byId = new Map(result.items.map((i) => [i.id, i]));
      set((s) => ({ items: s.items.map((i) => byId.get(i.id) ?? i) }));
      void silentReloadCurrentView();
      scheduleCountsRefresh();
      pokeReminderScheduler();
      return result;
    } catch (e) {
      restoreItemsSnapshot(prevItems, affected);
      set({ error: notifyError(e) });
      return null;
    } finally {
      endWrite();
    }
  },

  bulkRescheduleItems: async (itemIds, dueDate, dueTime) => {
    const ids = sanitizeIds(itemIds);
    if (ids.length === 0) return { items: [], skippedIds: [] };
    const prevItems = get().items;
    const affected = new Set(ids);
    const clearsDate = dueDate === undefined || dueDate === null || dueDate === '';
    set((s) => ({
      items: s.items.map((i) => {
        if (!affected.has(i.id)) return i;
        const next = { ...i };
        if (clearsDate) {
          next.dueDate = undefined;
          next.dueTime = undefined;
        } else {
          next.dueDate = dueDate as string;
          if (dueTime === '') next.dueTime = undefined;
          else if (dueTime !== undefined && dueTime !== null) next.dueTime = dueTime;
        }
        return next;
      }),
      error: null,
    }));
    beginWrite();
    try {
      const result = await api.batchRescheduleTodoItems(ids, dueDate, dueTime);
      const byId = new Map(result.items.map((i) => [i.id, i]));
      // 改期可能移出当前视图（今天/即将到期等），保留在场并就地替换，
      // 视图归属交给静默校准收敛（避免整片闪没）
      set((s) => ({ items: s.items.map((i) => byId.get(i.id) ?? i) }));
      void silentReloadCurrentView();
      scheduleCountsRefresh();
      pokeReminderScheduler();
      return result;
    } catch (e) {
      restoreItemsSnapshot(prevItems, affected);
      set({ error: notifyError(e) });
      return null;
    } finally {
      endWrite();
    }
  },

  // 批量设置优先级（2026-07-20 遗留补齐轮）：乐观更新/定向回滚/静默校准
  // 与 bulkRescheduleItems 同模式。计数快照与回收站徽标均不依赖优先级
  // （counts 只统计 pending 数、trash 只看软删除），故不接
  // scheduleCountsRefresh/refreshTrashCounts；提醒调度只看 reminder 时刻，
  // 也不需要 pokeReminderScheduler。
  bulkSetPriorityItems: async (itemIds, priority) => {
    const ids = sanitizeIds(itemIds);
    if (ids.length === 0) return { items: [], skippedIds: [] };
    const prevItems = get().items;
    const affected = new Set(ids);
    set((s) => ({
      items: s.items.map((i) => (affected.has(i.id) ? { ...i, priority } : i)),
      error: null,
    }));
    beginWrite();
    try {
      const result = await api.batchSetPriorityTodoItems(ids, priority);
      const byId = new Map(result.items.map((i) => [i.id, i]));
      // 优先级过滤/矩阵象限归属可能变化，保留在场并就地替换，
      // 视图归属交给静默校准收敛（与 bulkRescheduleItems 口径一致）
      set((s) => ({ items: s.items.map((i) => byId.get(i.id) ?? i) }));
      void silentReloadCurrentView();
      return result;
    } catch (e) {
      restoreItemsSnapshot(prevItems, affected);
      set({ error: notifyError(e) });
      return null;
    } finally {
      endWrite();
    }
  },

  bulkMoveItems: async (itemIds, targetListId) => {
    const ids = sanitizeIds(itemIds);
    if (ids.length === 0) return { items: [], skippedIds: [] };
    const prevItems = get().items;
    const state = get();
    const leavesCurrentView =
      state.filter.view === 'all' &&
      state.activeListId !== null &&
      targetListId !== state.activeListId;
    // 后端连同子树迁移：本地级联（多个根的子树并集）
    const movedIds = new Set<string>();
    for (const id of ids) {
      for (const sub of collectDescendantIds(prevItems, id)) movedIds.add(sub);
    }
    set((s) => ({
      items: leavesCurrentView
        ? s.items.filter((i) => !movedIds.has(i.id))
        : s.items.map((i) => (movedIds.has(i.id) ? { ...i, todoListId: targetListId } : i)),
      selectedItemId:
        leavesCurrentView && s.selectedItemId && movedIds.has(s.selectedItemId)
          ? null
          : s.selectedItemId,
      error: null,
    }));
    beginWrite();
    try {
      const result = await api.batchMoveTodoItems(ids, targetListId);
      if (!leavesCurrentView) {
        const byId = new Map(result.items.map((i) => [i.id, i]));
        set((s) => ({ items: s.items.map((i) => byId.get(i.id) ?? i) }));
      }
      void silentReloadCurrentView();
      scheduleCountsRefresh();
      return result;
    } catch (e) {
      restoreItemsSnapshot(prevItems, movedIds);
      set({ error: notifyError(e) });
      return null;
    } finally {
      endWrite();
    }
  },

  bulkDeleteItems: async (itemIds) => {
    const ids = sanitizeIds(itemIds);
    if (ids.length === 0) return { affectedIds: [], skippedIds: [] };
    const prevItems = get().items;
    const removedIds = new Set<string>();
    for (const id of ids) {
      for (const sub of collectDescendantIds(prevItems, id)) removedIds.add(sub);
    }
    set((s) => ({
      items: s.items.filter((i) => !removedIds.has(i.id)),
      selectedItemId:
        s.selectedItemId && removedIds.has(s.selectedItemId) ? null : s.selectedItemId,
      error: null,
    }));
    beginWrite();
    try {
      const result = await api.batchDeleteTodoItems(ids);
      void silentReloadCurrentView();
      scheduleCountsRefresh();
      void get().refreshTrashCounts();
      pokeReminderScheduler();
      return result;
    } catch (e) {
      restoreItemsSnapshot(prevItems, removedIds);
      set({ error: notifyError(e) });
      return null;
    } finally {
      endWrite();
    }
  },

  bulkRestoreItems: async (itemIds) => {
    const ids = sanitizeIds(itemIds);
    if (ids.length === 0) return { items: [], skippedIds: [] };
    try {
      const result = await api.batchRestoreTodoItems(ids);
      // 只移除真正被恢复的条目；skipped（如所属清单已删除）留在回收站
      const restoredIds = new Set(result.items.map((i) => i.id));
      set((s) => ({ trashItems: s.trashItems.filter((i) => !restoredIds.has(i.id)) }));
      await silentReloadCurrentView();
      scheduleCountsRefresh();
      void get().refreshTrashCounts();
      pokeReminderScheduler();
      return result;
    } catch (e) {
      set({ error: notifyError(e) });
      return null;
    }
  },

  bulkPurgeItems: async (itemIds) => {
    const ids = sanitizeIds(itemIds);
    if (ids.length === 0) return { affectedIds: [], skippedIds: [] };
    try {
      const result = await api.batchPurgeTodoItems(ids);
      const purgedIds = new Set(result.affectedIds);
      set((s) => ({ trashItems: s.trashItems.filter((i) => !purgedIds.has(i.id)) }));
      void get().refreshTrashCounts();
      return result;
    } catch (e) {
      set({ error: notifyError(e) });
      return null;
    }
  },

  refreshTrashCounts: async () => {
    try {
      const trashCounts = await api.getTodoTrashCounts();
      if (trashCounts) set({ trashCounts });
    } catch {
      // 增强信息：失败静默，保留旧值
    }
  },

  refreshStatsOverview: async (days = 30) => {
    try {
      const statsOverview = await api.getTodoStatsOverview(days);
      set({ statsOverview });
      return statsOverview;
    } catch {
      // 统计视图属增强信息：失败静默，调用方按 null 降级
      return null;
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
      void get().refreshTrashCounts();
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
      scheduleCountsRefresh();
      void get().refreshTrashCounts();
      pokeReminderScheduler();
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
      scheduleCountsRefresh();
      void get().refreshTrashCounts();
      pokeReminderScheduler();
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
      void get().refreshTrashCounts();
    } catch (e) {
      notifyError(e);
    }
  },

  purgeItemFromTrash: async (itemId) => {
    try {
      await api.purgeTodoItem(itemId);
      set((s) => ({ trashItems: s.trashItems.filter((i) => i.id !== itemId) }));
      void get().refreshTrashCounts();
    } catch (e) {
      notifyError(e);
    }
  },

  emptyTrash: async () => {
    try {
      await api.purgeDeletedTodoItems();
      await api.purgeDeletedTodoLists();
      set({
        trashLists: [],
        trashItems: [],
        trashHasMore: false,
        trashCounts: { deletedItems: 0, deletedLists: 0 },
      });
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
      void get().refreshCounts();

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
  };
});

// ============================================================================
// 记忆化 selector（2026-07-20 新增，纯增量导出）
//
// Zustand 的 selector 每次 store 变化都会重跑；直接在组件里
// `useTodoStore((s) => sortTodoItems(s.items, s.filter.sortBy))` 会每次返回
// 新数组引用导致必然重渲染。以下 selector 按输入引用做单槽缓存，
// items/sortBy/priorityFilter 未变时返回同一引用，可安全用于 useTodoStore(selector)。
// ============================================================================

type SortedSelectorInput = Pick<TodoState, 'items' | 'filter'>;

let sortedCache: {
  items: TodoItem[];
  sortBy: TodoSortBy;
  result: TodoItem[];
} | null = null;

/** 当前视图条目按 filter.sortBy 排序（记忆化；manual 直接返回原引用） */
export function selectSortedItems(state: SortedSelectorInput): TodoItem[] {
  const { items } = state;
  const { sortBy } = state.filter;
  if (sortBy === 'manual') return items;
  if (sortedCache && sortedCache.items === items && sortedCache.sortBy === sortBy) {
    return sortedCache.result;
  }
  const result = sortTodoItems(items, sortBy);
  sortedCache = { items, sortBy, result };
  return result;
}

let visibleCache: {
  items: TodoItem[];
  sortBy: TodoSortBy;
  priorityFilter: TodoPriority | null;
  result: TodoItem[];
} | null = null;

/** 排序 + 优先级过滤后的可见条目（记忆化；无过滤时与 selectSortedItems 同引用） */
export function selectVisibleItems(state: SortedSelectorInput): TodoItem[] {
  const sorted = selectSortedItems(state);
  const { priorityFilter } = state.filter;
  if (!priorityFilter) return sorted;
  const { items } = state;
  const { sortBy } = state.filter;
  if (
    visibleCache &&
    visibleCache.items === items &&
    visibleCache.sortBy === sortBy &&
    visibleCache.priorityFilter === priorityFilter
  ) {
    return visibleCache.result;
  }
  const result = sorted.filter((i) => i.priority === priorityFilter);
  visibleCache = { items, sortBy, priorityFilter, result };
  return result;
}
