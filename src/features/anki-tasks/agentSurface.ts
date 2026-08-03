/**
 * A45-2 — 制卡任务面板 Agent 表面扩展类型（docs/dev/acr/ACR-4.5.md）
 *
 * 基础表面契约定义在 workbench 的 agentSurfaceRegistry.ts（他人名下文件，
 * 本轮不改动）。这里用子类型的方式为 taskDashboard 表面追加：
 * - 会话实体的状态令牌（运行中/失败/完成计数，口径与后端
 *   list_document_sessions 完全一致，见 src-tauri/src/database/mod.rs）；
 * - 焦点会话的失败分段清单（供 retryTask 按 ref 精确操作）。
 *
 * AnkiTasksApp 注册的 snapshot 返回本扩展形状；函数返回值协变，
 * 依旧满足基础 TaskDashboardAgentSurface 接口。manifest 侧通过
 * taskDashboardAgentActions.ts 的防御式 reader 读取扩展字段，
 * 旧形状表面（如既有测试 mock）自动降级为「无令牌」诚实观察。
 */
import type {
  TaskDashboardAgentItem,
  TaskDashboardAgentSnapshot,
} from '@/features/workbench/apps/system/agentSurfaceRegistry';

/**
 * 会话状态令牌。计数口径（与 list_document_sessions SQL 一致）：
 * - failedTasks：Failed / Truncated / Cancelled（「失败口径」，可重试）
 * - activeTasks：Pending / Processing / Streaming
 * - pausedTasks：Paused
 */
export interface TaskDashboardSessionStateTokens {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  activeTasks: number;
  pausedTasks: number;
  totalCards: number;
}

export interface TaskDashboardAgentItemDetailed
  extends TaskDashboardAgentItem, TaskDashboardSessionStateTokens {}

/** 焦点会话中单个失败口径分段（映射自 get_document_tasks 的 DocumentTask） */
export interface TaskDashboardFailedTaskItem {
  id: string;
  /** Failed | Truncated | Cancelled */
  status: string;
  segmentIndex: number;
  errorMessage: string | null;
}

/** 焦点会话失败分段清单；loading / loadError 让观察方诚实感知数据未就绪 */
export interface TaskDashboardFocusedFailedTasks {
  sessionId: string;
  loading: boolean;
  loadError: string | null;
  tasks: TaskDashboardFailedTaskItem[];
}

export interface TaskDashboardAgentSnapshotDetailed extends TaskDashboardAgentSnapshot {
  sessions: TaskDashboardAgentItemDetailed[];
  /** 仅当焦点会话存在失败口径任务时非 null */
  focusedFailedTasks: TaskDashboardFocusedFailedTasks | null;
}
