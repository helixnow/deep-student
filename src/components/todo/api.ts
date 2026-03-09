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

export async function ensureInbox(): Promise<TodoList> {
  return invoke('todo_ensure_inbox');
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

// ============================================================================
// Query API
// ============================================================================

export async function listTodayItems(): Promise<TodoItem[]> {
  return invoke('todo_list_today');
}

export async function listOverdueItems(): Promise<TodoItem[]> {
  return invoke('todo_list_overdue');
}

export async function listUpcomingItems(days: number): Promise<TodoItem[]> {
  return invoke('todo_list_upcoming', { days });
}

export async function searchTodoItems(query: string): Promise<TodoItem[]> {
  return invoke('todo_search', { query });
}

export async function getActiveTodoSummary(): Promise<TodoActiveSummary | null> {
  return invoke('todo_get_active_summary');
}
