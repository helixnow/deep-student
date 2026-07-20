/**
 * 待办管理系统 Tauri API 层
 */

import { invoke } from '@tauri-apps/api/core';
import type {
  TodoList,
  TodoItem,
  TodoActiveSummary,
  CreateTodoListInput,
  UpdateTodoListInput,
  CreateTodoItemInput,
  UpdateTodoItemInput,
} from './types';

// ============================================================================
// TodoList API
// ============================================================================

export async function createTodoList(input: CreateTodoListInput): Promise<TodoList> {
  return invoke('todo_create_list', { input });
}

export async function getTodoList(listId: string): Promise<TodoList | null> {
  return invoke('todo_get_list', { listId });
}

export async function listTodoLists(): Promise<TodoList[]> {
  return invoke('todo_list_lists');
}

export async function updateTodoList(input: UpdateTodoListInput): Promise<TodoList> {
  return invoke('todo_update_list', { input });
}

export async function deleteTodoList(listId: string): Promise<void> {
  return invoke('todo_delete_list', { listId });
}

export async function toggleTodoListFavorite(listId: string): Promise<TodoList> {
  return invoke('todo_toggle_list_favorite', { listId });
}

export async function ensureInbox(title?: string): Promise<TodoList> {
  return invoke('todo_ensure_inbox', { title });
}

/** 拖拽重排清单顺序（与后端 todo_reorder_lists 约定 { listIds }） */
export async function reorderTodoLists(listIds: string[]): Promise<void> {
  return invoke('todo_reorder_lists', { listIds });
}

// ============================================================================
// Recycle Bin API
// ============================================================================

export async function listDeletedTodoLists(limit = 100, offset = 0): Promise<TodoList[]> {
  return invoke('todo_list_deleted_lists', { limit, offset });
}

export async function restoreTodoList(listId: string): Promise<TodoList> {
  return invoke('todo_restore_list', { listId });
}

export async function purgeTodoList(listId: string): Promise<void> {
  return invoke('todo_purge_list', { listId });
}

export async function purgeDeletedTodoLists(): Promise<number> {
  return invoke('todo_purge_deleted_lists');
}

export async function restoreTodoItem(itemId: string): Promise<TodoItem> {
  return invoke('todo_restore_item', { itemId });
}

export async function listDeletedTodoItems(limit = 100, offset = 0): Promise<TodoItem[]> {
  return invoke('todo_list_deleted_items', { limit, offset });
}

export async function purgeTodoItem(itemId: string): Promise<void> {
  return invoke('todo_purge_item', { itemId });
}

export async function purgeDeletedTodoItems(): Promise<number> {
  return invoke('todo_purge_deleted_items');
}

// ============================================================================
// TodoItem API
// ============================================================================

export async function createTodoItem(input: CreateTodoItemInput): Promise<TodoItem> {
  return invoke('todo_create_item', { input });
}

export async function getTodoItem(itemId: string): Promise<TodoItem | null> {
  return invoke('todo_get_item', { itemId });
}

export async function listTodoItems(listId: string, includeCompleted: boolean): Promise<TodoItem[]> {
  return invoke('todo_list_items', { listId, includeCompleted });
}

export async function updateTodoItem(input: UpdateTodoItemInput): Promise<TodoItem> {
  return invoke('todo_update_item', { input });
}

export async function toggleTodoItem(itemId: string): Promise<TodoItem> {
  return invoke('todo_toggle_item', { itemId });
}

export async function deleteTodoItem(itemId: string): Promise<void> {
  return invoke('todo_delete_item', { itemId });
}

export async function reorderTodoItems(listId: string, itemIds: string[]): Promise<void> {
  return invoke('todo_reorder_items', { input: { listId, itemIds } });
}

/** 移动待办到另一清单（与后端 todo_move_item 约定 { itemId, targetListId }，返回更新后的 item） */
export async function moveTodoItem(itemId: string, targetListId: string): Promise<TodoItem> {
  return invoke('todo_move_item', { itemId, targetListId });
}

// ============================================================================
// Query API
// ============================================================================

export async function listTodayItems(includeCompleted = false): Promise<TodoItem[]> {
  return invoke('todo_list_today', { includeCompleted });
}

export async function listOverdueItems(includeCompleted = false): Promise<TodoItem[]> {
  return invoke('todo_list_overdue', { includeCompleted });
}

export async function listUpcomingItems(days: number, includeCompleted = false): Promise<TodoItem[]> {
  return invoke('todo_list_upcoming', { days, includeCompleted });
}

/** 所有设置了提醒的待处理任务（提醒调度器轮询用） */
export async function listReminderItems(): Promise<TodoItem[]> {
  return invoke('todo_list_reminders');
}

/** 全部待处理任务（跨清单，四象限矩阵视图用） */
export async function listAllPendingItems(): Promise<TodoItem[]> {
  return invoke('todo_list_all_pending');
}

/** AI 拆解：让工具模型把任务拆为若干子任务并落库，返回新建的子任务 */
export async function aiBreakdownTodo(itemId: string): Promise<TodoItem[]> {
  return invoke('todo_ai_breakdown', { itemId });
}

export async function listCompletedItems(listId?: string): Promise<TodoItem[]> {
  return invoke('todo_list_completed', { listId });
}

export async function searchTodoItems(query: string): Promise<TodoItem[]> {
  return invoke('todo_search', { query });
}

export async function getActiveTodoSummary(): Promise<TodoActiveSummary | null> {
  return invoke('todo_get_active_summary');
}
