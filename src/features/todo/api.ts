/**
 * 待办管理系统 Tauri API 层
 *
 * 所有命令统一经 `call()` 包装：失败时抛 {@link TodoApiError}，
 * 携带稳定的 {@link TodoErrorCode}（可映射 i18n 文案），message 保留后端原文。
 */

import { invoke } from '@tauri-apps/api/core';
import { parseCommandErrorEnvelope } from '@/api/tauriClient';
import type {
  TodoList,
  TodoItem,
  TodoActiveSummary,
  TodoPriority,
  CreateTodoListInput,
  UpdateTodoListInput,
  CreateTodoItemInput,
  UpdateTodoItemInput,
} from './types';

// ============================================================================
// 错误归一（新增能力，兼容旧调用方：抛出的仍是 Error 子类，message 不变语义）
// ============================================================================

/**
 * 稳定错误码（前端据此查 i18n 文案 `todo:apiErrors.<code>`；
 * 未识别时为 'unknown'，展示后端原始 message 兜底）。
 */
export type TodoErrorCode =
  | 'conflict'
  | 'notFound'
  | 'invalidArgument'
  | 'invalidOperation'
  | 'maintenance'
  | 'storage'
  | 'unknown';

/** 待办 API 错误：message 保留后端原文，code 为归一化错误码 */
export class TodoApiError extends Error {
  readonly code: TodoErrorCode;
  /** 触发错误的 Tauri 命令名（调试用） */
  readonly command: string;
  /** 后端稳定错误码原文（CommandError envelope 的 code；legacy 错误无此字段） */
  readonly backendCode?: string;
  /** 后端追踪 ID（用于关联后端日志；legacy 错误无此字段） */
  readonly traceId?: string;

  constructor(
    message: string,
    code: TodoErrorCode,
    command: string,
    backendCode?: string,
    traceId?: string,
  ) {
    super(message);
    this.name = 'TodoApiError';
    this.code = code;
    this.command = command;
    this.backendCode = backendCode;
    this.traceId = traceId;
  }
}

/**
 * TD-11：后端稳定 code（vfs/error.rs `stable_code()`）→ 前端 TodoErrorCode。
 * 只依赖 code、不匹配 message 文案；表外的未知 code 统一降级为 'unknown'
 * （UI 兜底展示后端原始 message）。
 */
const BACKEND_CODE_TO_TODO_CODE: Record<string, TodoErrorCode> = {
  VFS_CONFLICT: 'conflict',
  VFS_NOT_FOUND: 'notFound',
  VFS_INVALID_ARGUMENT: 'invalidArgument',
  VFS_INVALID_OPERATION: 'invalidOperation',
  VFS_LIMIT_EXCEEDED: 'invalidOperation',
  VFS_MAINTENANCE: 'maintenance',
  VFS_STORAGE: 'storage',
  VFS_IO: 'storage',
  VFS_SERIALIZATION: 'storage',
};

/**
 * 后端错误字符串 → 稳定错误码（与 src-tauri vfs/error.rs 的 Display 格式对齐）。
 *
 * ⚠️ TD-11 迁移期 legacy fallback：仅在后端未返回结构化 envelope 时使用
 * （如 pomodoro_* 命令），命中时 `toTodoApiError` 会发一次性可观测告警。
 * 新代码不要直接调用本函数做错误分派。
 */
export function classifyTodoError(message: string): TodoErrorCode {
  // OCC 冲突：VfsError::Conflict 渲染为 "CONFLICT(key): TODO_CONFLICT: ..."
  if (message.includes('TODO_CONFLICT') || message.startsWith('CONFLICT(')) return 'conflict';
  if (/\bnot found\b/i.test(message) || message.includes('NOT_FOUND')) return 'notFound';
  if (message.startsWith('Invalid argument')) return 'invalidArgument';
  if (message.startsWith('MAINTENANCE_MODE')) return 'maintenance';
  if (message.startsWith('INVALID_OPERATION') || message.startsWith('INVALID_STATE')) {
    return 'invalidOperation';
  }
  if (
    message.startsWith('Database error') ||
    message.startsWith('Connection pool error') ||
    message.startsWith('IO error')
  ) {
    return 'storage';
  }
  return 'unknown';
}

/** legacy（非结构化）错误载荷的可观测告警：每命令每会话只告警一次 */
const legacyPayloadWarned = new Set<string>();

/**
 * 任意 invoke 异常 → TodoApiError（已是 TodoApiError 时原样返回）。
 *
 * TD-11：优先解析结构化 CommandError envelope 并按稳定 code 映射；
 * 未知 code 统一降级 'unknown'（message 原样保留给 UI 兜底展示）。
 * 无 envelope 时走 legacy Display 文案启发式（迁移期兜底，带一次性告警）。
 */
export function toTodoApiError(e: unknown, command: string): TodoApiError {
  if (e instanceof TodoApiError) return e;

  const envelope = parseCommandErrorEnvelope(e);
  if (envelope) {
    const code = BACKEND_CODE_TO_TODO_CODE[envelope.code] ?? 'unknown';
    return new TodoApiError(envelope.message, code, command, envelope.code, envelope.traceId);
  }

  if (!legacyPayloadWarned.has(command)) {
    legacyPayloadWarned.add(command);
    console.warn(
      '[todo/api] legacy string error payload from',
      command,
      '- classified by message text (TD-11 fallback); backend should return a CommandError envelope',
    );
  }
  const message = e instanceof Error ? e.message : String(e);
  return new TodoApiError(message, classifyTodoError(message), command);
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (e) {
    throw toTodoApiError(e, command);
  }
}

// ============================================================================
// TodoList API
// ============================================================================

export async function createTodoList(input: CreateTodoListInput): Promise<TodoList> {
  return call('todo_create_list', { input });
}

export async function getTodoList(listId: string): Promise<TodoList | null> {
  return call('todo_get_list', { listId });
}

export async function listTodoLists(): Promise<TodoList[]> {
  return call('todo_list_lists');
}

export async function updateTodoList(input: UpdateTodoListInput): Promise<TodoList> {
  return call('todo_update_list', { input });
}

export async function deleteTodoList(listId: string): Promise<void> {
  return call('todo_delete_list', { listId });
}

export async function toggleTodoListFavorite(listId: string): Promise<TodoList> {
  return call('todo_toggle_list_favorite', { listId });
}

export async function ensureInbox(title?: string): Promise<TodoList> {
  return call('todo_ensure_inbox', { title });
}

/**
 * 拖拽重排清单顺序。
 * ★ 2026-07-19 修复：后端命令签名是 `todo_reorder_lists(input: ReorderListsInput)`，
 * 参数必须包在 `input` 里；此前发平铺 `{ listIds }` 会因缺少 `input` 键被 Tauri 拒绝，
 * 导致清单拖拽排序必然失败回滚。
 */
export async function reorderTodoLists(listIds: string[]): Promise<void> {
  return call('todo_reorder_lists', { input: { listIds } });
}

// ============================================================================
// Recycle Bin API
// ============================================================================

export async function listDeletedTodoLists(limit = 100, offset = 0): Promise<TodoList[]> {
  return call('todo_list_deleted_lists', { limit, offset });
}

export async function restoreTodoList(listId: string): Promise<TodoList> {
  return call('todo_restore_list', { listId });
}

export async function purgeTodoList(listId: string): Promise<void> {
  return call('todo_purge_list', { listId });
}

export async function purgeDeletedTodoLists(): Promise<number> {
  return call('todo_purge_deleted_lists');
}

export async function restoreTodoItem(itemId: string): Promise<TodoItem> {
  return call('todo_restore_item', { itemId });
}

export async function listDeletedTodoItems(limit = 100, offset = 0): Promise<TodoItem[]> {
  return call('todo_list_deleted_items', { limit, offset });
}

export async function purgeTodoItem(itemId: string): Promise<void> {
  return call('todo_purge_item', { itemId });
}

export async function purgeDeletedTodoItems(): Promise<number> {
  return call('todo_purge_deleted_items');
}

// ============================================================================
// TodoItem API
// ============================================================================

export async function createTodoItem(input: CreateTodoItemInput): Promise<TodoItem> {
  return call('todo_create_item', { input });
}

export async function getTodoItem(itemId: string): Promise<TodoItem | null> {
  return call('todo_get_item', { itemId });
}

export async function listTodoItems(listId: string, includeCompleted: boolean): Promise<TodoItem[]> {
  return call('todo_list_items', { listId, includeCompleted });
}

export async function updateTodoItem(input: UpdateTodoItemInput): Promise<TodoItem> {
  return call('todo_update_item', { input });
}

/**
 * 切换完成状态。可选 `expectedUpdatedAt` 走后端乐观锁（R1-04），
 * 并发冲突时抛 code === 'conflict' 的 TodoApiError。
 */
export async function toggleTodoItem(itemId: string, expectedUpdatedAt?: string): Promise<TodoItem> {
  return call('todo_toggle_item', { itemId, expectedUpdatedAt });
}

export async function deleteTodoItem(itemId: string): Promise<void> {
  return call('todo_delete_item', { itemId });
}

export async function reorderTodoItems(listId: string, itemIds: string[]): Promise<void> {
  return call('todo_reorder_items', { input: { listId, itemIds } });
}

/**
 * 移动待办到另一清单（连同子树），返回更新后的 item。
 * ★ 2026-07-19 修复：后端命令签名是 `todo_move_item(input: MoveTodoItemInput)`，
 * 参数必须包在 `input` 里；此前发平铺 `{ itemId, targetListId }` 会因缺少
 * `input` 键被 Tauri 拒绝，导致「移动到清单」必然失败回滚。
 */
export async function moveTodoItem(itemId: string, targetListId: string): Promise<TodoItem> {
  return call('todo_move_item', { input: { itemId, targetListId } });
}

// ============================================================================
// Query API
// ============================================================================

export async function listTodayItems(includeCompleted = false): Promise<TodoItem[]> {
  return call('todo_list_today', { includeCompleted });
}

export async function listOverdueItems(includeCompleted = false): Promise<TodoItem[]> {
  return call('todo_list_overdue', { includeCompleted });
}

export async function listUpcomingItems(days: number, includeCompleted = false): Promise<TodoItem[]> {
  return call('todo_list_upcoming', { days, includeCompleted });
}

/** 所有设置了提醒的待处理任务（提醒调度器轮询用） */
export async function listReminderItems(): Promise<TodoItem[]> {
  return call('todo_list_reminders');
}

/** 全部待处理任务（跨清单，四象限矩阵视图用） */
export async function listAllPendingItems(): Promise<TodoItem[]> {
  return call('todo_list_all_pending');
}

/** AI 拆解：让工具模型把任务拆为若干子任务并落库，返回新建的子任务 */
export async function aiBreakdownTodo(itemId: string): Promise<TodoItem[]> {
  return call('todo_ai_breakdown', { itemId });
}

export async function listCompletedItems(listId?: string): Promise<TodoItem[]> {
  return call('todo_list_completed', { listId });
}

export async function searchTodoItems(query: string): Promise<TodoItem[]> {
  return call('todo_search', { query });
}

export async function getActiveTodoSummary(): Promise<TodoActiveSummary | null> {
  return call('todo_get_active_summary');
}

// ============================================================================
// 侧栏计数快照（与后端 todo_counts_snapshot 命令的三方契约：F1/F5/F9）
// ============================================================================

export interface TodoCountsSnapshot {
  /** 今天到期 + 逾期的 pending 数 */
  todayCount: number;
  /** 未来 7 天 pending 数 */
  upcomingCount: number;
  /** 默认清单 pending 数 */
  inboxCount: number;
  allPendingCount: number;
  perList: { listId: string; pendingCount: number }[];
}

export async function getTodoCountsSnapshot(): Promise<TodoCountsSnapshot> {
  return call('todo_counts_snapshot');
}

// ============================================================================
// 批量操作 API（2026-07-20 新增，与后端 .parallel-notes/backend.md §1 契约一致）
//
// 通用语义：itemIds 上限 500（超限整体报错）；空数组返回空结果；
// 「跳过」（不存在/已删除/状态不适用）不算失败，收进 skippedIds；
// 单事务原子提交，只有真正的错误（无效参数/目标不存在/DB 错误）才整体回滚。
// ============================================================================

/** 批量操作结果（返回实体的操作：complete/reschedule/move/restore） */
export interface TodoBatchItemsResult {
  /** 成功处理（含幂等命中）的条目最新状态，按输入顺序 */
  items: TodoItem[];
  /** 被跳过的输入 ID（不存在/已删除/状态不适用） */
  skippedIds: string[];
}

/** 批量操作结果（只返回 ID 的操作：delete/purge） */
export interface TodoBatchIdsResult {
  /** 实际生效的输入 ID，按输入顺序 */
  affectedIds: string[];
  /** 被跳过的输入 ID */
  skippedIds: string[];
}

/** 批量完成（已完成条目幂等返回原状态；重复任务照常派生下一次实例） */
export async function batchCompleteTodoItems(itemIds: string[]): Promise<TodoBatchItemsResult> {
  return call('todo_batch_complete', { itemIds });
}

/**
 * 批量改期。
 * - `dueDate`：`null`/缺省/空串 → 清空到期日（联动清空到期时间）；`"YYYY-MM-DD"` → 设为该日期
 * - `dueTime`：`null`/缺省 → 保留各条目现有时间；`""` → 清空；`"HH:MM"` → 设为该时间
 * - 格式非法 → 整体报错（code 'invalidArgument'），不部分执行
 */
export async function batchRescheduleTodoItems(
  itemIds: string[],
  dueDate?: string | null,
  dueTime?: string | null,
): Promise<TodoBatchItemsResult> {
  return call('todo_batch_reschedule', { itemIds, dueDate, dueTime });
}

/**
 * 批量移动到目标清单（连同各自子树）。目标清单不存在/已删除 → 整体报错。
 * 输入中互为祖先-后代时后代随祖先子树迁移、自身进 skippedIds。
 */
export async function batchMoveTodoItems(
  itemIds: string[],
  targetListId: string,
): Promise<TodoBatchItemsResult> {
  return call('todo_batch_move', { itemIds, targetListId });
}

/** 批量软删除（连同子树，同批次进回收站） */
export async function batchDeleteTodoItems(itemIds: string[]): Promise<TodoBatchIdsResult> {
  return call('todo_batch_delete', { itemIds });
}

/** 批量从回收站恢复（自身 + 同批次删除的后代；所属清单已删除的条目进 skippedIds） */
export async function batchRestoreTodoItems(itemIds: string[]): Promise<TodoBatchItemsResult> {
  return call('todo_batch_restore', { itemIds });
}

/** 批量彻底删除（仅回收站中的条目；物理删除不可恢复） */
export async function batchPurgeTodoItems(itemIds: string[]): Promise<TodoBatchIdsResult> {
  return call('todo_batch_purge', { itemIds });
}

/**
 * 批量设置优先级（2026-07-20 遗留补齐轮新增；参数平铺，
 * 返回结构与 batchRescheduleTodoItems 完全同形——items + skippedIds）。
 */
export async function batchSetPriorityTodoItems(
  itemIds: string[],
  priority: TodoPriority,
): Promise<TodoBatchItemsResult> {
  return call('todo_batch_set_priority', { itemIds, priority });
}

// ============================================================================
// 回收站计数（backend.md §2.1）
// ============================================================================

export interface TodoTrashCounts {
  /** 可独立恢复的已删除条目数（与 todo_list_deleted_items 同口径） */
  deletedItems: number;
  /** 已删除清单数（与 todo_list_deleted_lists 同口径） */
  deletedLists: number;
}

export async function getTodoTrashCounts(): Promise<TodoTrashCounts> {
  return call('todo_trash_counts');
}

// ============================================================================
// 统计总览（backend.md §3）
// ============================================================================

export interface TodoStatsOverview {
  totalPending: number;
  totalCompleted: number;
  /** 今日完成数（本地日历日口径） */
  completedToday: number;
  overdueCount: number;
  /** 近 N 天完成/新建趋势（升序，无数据天补零） */
  completionTrend: { date: string; completedCount: number; createdCount: number }[];
  /** 按清单分布（顺序与 todo_list_lists 一致） */
  byList: { listId: string; listTitle: string; pendingCount: number; completedCount: number }[];
  /** 按优先级分布（urgent/high/medium/low/none 固定顺序，含 0） */
  byPriority: { priority: string; pendingCount: number }[];
  /** 按标签分布（按条目总数降序，最多 100 个标签；同条目内重复标签只计一次） */
  byTag: { tag: string; pendingCount: number; completedCount: number }[];
}

/** 待办统计总览（days 默认 30，后端 clamp 1-366） */
export async function getTodoStatsOverview(days?: number): Promise<TodoStatsOverview> {
  return call('todo_stats_overview', { days });
}

/** 标签及其使用条目数（todo_list_all_tags 返回项；count 降序） */
export interface TodoTagWithCount {
  tag: string;
  count: number;
}

/**
 * 全库标签词表（含使用计数，count 降序，无 100 条截断）。
 * 2026-07-20 遗留补齐轮新增：独立命令 todo_list_all_tags，
 * 替代此前借道 todo_stats_overview.byTag 的旁路（那条路最多 100 个标签）。
 */
export async function listAllTagsWithCounts(): Promise<TodoTagWithCount[]> {
  return call('todo_list_all_tags');
}

/**
 * 全库标签词表（自动补全用，按使用数降序）。
 * 签名保持不变（消费方 TodoItemDetail/TagsEditor 零改动），
 * 内部改走 todo_list_all_tags，摆脱 stats 旁路的 100 上限。
 */
export async function listAllTags(): Promise<string[]> {
  const tags = await listAllTagsWithCounts();
  return tags.map((t) => t.tag);
}

// ============================================================================
// 番茄钟统计聚合（backend.md §3.1 / §3.2；类型为后端契约的本地镜像，
// 避免跨 feature 依赖 pomodoro 模块内部类型）
// ============================================================================

export interface PomodoroStatsOverview {
  today: {
    completedCount: number;
    totalFocusSeconds: number;
    interruptedCount: number;
    /** 严格口径（仅 completed 的 actualDuration） */
    completedFocusSeconds: number;
  };
  streak: { currentStreakDays: number; longestStreakDays: number };
  /** 近 N 天升序、无数据天补零 */
  daily: { date: string; completedCount: number; focusSeconds: number; interruptedCount: number }[];
  /** 由 daily 派生的按周聚合（weekStart 为该周周一，升序；首尾周可能不满 7 天） */
  weekly: {
    weekStart: string;
    completedCount: number;
    focusSeconds: number;
    interruptedCount: number;
    activeDays: number;
  }[];
}

/** 番茄钟统计总览：一次替代 today/streak/daily 三连发（days 默认 30，clamp 1-366） */
export async function getPomodoroStatsOverview(days?: number): Promise<PomodoroStatsOverview> {
  return call('pomodoro_stats_overview', { days });
}

export interface PomodoroTodoFocusSummary {
  todoItemId: string;
  /** 软删任务仍返回标题；任务不存在为 null（不报错） */
  todoTitle: string | null;
  totalFocusSeconds: number;
  completedCount: number;
  interruptedCount: number;
  firstFocusAt: string | null;
  lastFocusAt: string | null;
  /** 仅有记录的天，本地日升序 */
  daily: { date: string; focusSeconds: number; completedCount: number; interruptedCount: number }[];
}

/** 某任务的专注历史聚合（任务详情「专注历史」一次拉全） */
export async function getPomodoroTodoFocusSummary(
  todoItemId: string,
): Promise<PomodoroTodoFocusSummary> {
  return call('pomodoro_todo_focus_summary', { todoItemId });
}

// ============================================================================
// 性能类命令（backend.md §4.1）
// ============================================================================

/** 附带直接子任务计数的待办项（TodoItem 字段平铺合并） */
export type TodoItemWithStats = TodoItem & {
  /** 直接子任务数（不含软删除） */
  subtaskCount: number;
  /** 已完成的直接子任务数 */
  completedSubtaskCount: number;
};

/**
 * 清单条目 + 子任务计数（一条聚合 SQL 消除 N+1）。
 * 排序/过滤/分页语义与 listTodoItems 完全一致，可直接替换调用点。
 */
export async function listTodoItemsWithStats(
  listId: string,
  includeCompleted: boolean,
  limit?: number,
  offset?: number,
): Promise<TodoItemWithStats[]> {
  return call('todo_list_items_with_stats', { listId, includeCompleted, limit, offset });
}
