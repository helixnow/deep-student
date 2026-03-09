/**
 * 待办管理系统前端类型定义
 */

// ============================================================================
// 核心数据类型
// ============================================================================

export interface TodoList {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  color?: string;
  sortOrder: number;
  isDefault: boolean;
  isFavorite: boolean;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export interface TodoItem {
  id: string;
  todoListId: string;
  title: string;
  description?: string;
  status: TodoStatus;
  priority: TodoPriority;
  dueDate?: string;
  dueTime?: string;
  reminder?: string;
  tagsJson: string;
  sortOrder: number;
  parentId?: string;
  completedAt?: string;
  repeatJson?: string;
  attachmentsJson: string;
  estimatedPomodoros?: number;
  completedPomodoros?: number;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
}

export type TodoStatus = 'pending' | 'completed' | 'cancelled';
export type TodoPriority = 'none' | 'low' | 'medium' | 'high' | 'urgent';

export interface TodoActiveSummary {
  todayItems: TodoSummaryItem[];
  overdueItems: TodoSummaryItem[];
  upcomingHighPriority: TodoSummaryItem[];
  stats: TodoStats;
}

export interface TodoSummaryItem {
  id: string;
  title: string;
  priority: string;
  dueDate?: string;
  dueTime?: string;
  listTitle: string;
}

export interface TodoStats {
  totalPending: number;
  todayDue: number;
  overdueCount: number;
  todayCompleted: number;
}

// ============================================================================
// 输入参数
// ============================================================================

export interface CreateTodoListInput {
  title: string;
  description?: string;
  icon?: string;
  color?: string;
}

export interface UpdateTodoListInput {
  id: string;
  title?: string;
  description?: string;
  icon?: string;
  color?: string;
}

export interface CreateTodoItemInput {
  todoListId: string;
  title: string;
  description?: string;
  priority?: TodoPriority;
  dueDate?: string;
  dueTime?: string;
  tags?: string[];
  parentId?: string;
  attachments?: string[];
}

export interface UpdateTodoItemInput {
  id: string;
  title?: string;
  description?: string;
  status?: TodoStatus;
  priority?: TodoPriority;
  dueDate?: string;
  dueTime?: string;
  reminder?: string;
  tags?: string[];
  parentId?: string;
  attachments?: string[];
  repeatJson?: string;
  estimatedPomodoros?: number;
  completedPomodoros?: number;
}

// ============================================================================
// 视图过滤
// ============================================================================

export type TodoViewFilter = 'all' | 'today' | 'upcoming' | 'overdue' | 'completed';

export interface TodoFilterState {
  view: TodoViewFilter;
  search: string;
  priorityFilter: TodoPriority | null;
  showCompleted: boolean;
}

// ============================================================================
// 辅助函数
// ============================================================================

export function parseTags(tagsJson: string): string[] {
  try {
    return JSON.parse(tagsJson);
  } catch {
    return [];
  }
}

export function parseAttachments(attachmentsJson: string): string[] {
  try {
    return JSON.parse(attachmentsJson);
  } catch {
    return [];
  }
}

export const PRIORITY_CONFIG: Record<TodoPriority, { label: string; color: string; icon: string }> = {
  none: { label: '无', color: 'text-muted-foreground', icon: 'Minus' },
  low: { label: '低', color: 'text-blue-500', icon: 'ArrowDown' },
  medium: { label: '中', color: 'text-yellow-500', icon: 'ArrowRight' },
  high: { label: '高', color: 'text-orange-500', icon: 'ArrowUp' },
  urgent: { label: '紧急', color: 'text-red-500', icon: 'AlertTriangle' },
};

export const STATUS_CONFIG: Record<TodoStatus, { label: string; color: string }> = {
  pending: { label: '待办', color: 'text-muted-foreground' },
  completed: { label: '已完成', color: 'text-green-500' },
  cancelled: { label: '已取消', color: 'text-gray-400' },
};

export function isOverdue(item: TodoItem): boolean {
  if (!item.dueDate || item.status !== 'pending') return false;
  const today = new Date().toISOString().slice(0, 10);
  return item.dueDate < today;
}

export function isDueToday(item: TodoItem): boolean {
  if (!item.dueDate || item.status !== 'pending') return false;
  const today = new Date().toISOString().slice(0, 10);
  return item.dueDate === today;
}
