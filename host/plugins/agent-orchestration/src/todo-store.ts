import type { TodoList } from './todo.ts';

/** todo_executor.rs:180–204: the single process-local store, isolated by session ID. */
const todoStore = new Map<string, TodoList>();

/** Rust get_todo_list clones the stored list, including all steps. */
export function getTodoList(sessionId: string): TodoList | null {
  const list = todoStore.get(sessionId);
  return list === undefined ? null : structuredClone(list);
}

/** Shared by DB restore and the L06 todo_* executor, never a second caller-side store. */
export function setTodoList(sessionId: string, list: TodoList): void {
  todoStore.set(sessionId, structuredClone(list));
}
