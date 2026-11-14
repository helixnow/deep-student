// workspace/subagent_task.rs —— 子代理任务的持久化与重启恢复。
import type { SubagentTaskData, SubagentTaskStatus } from '../../api.ts';
import type { SqlExecutor } from '../../../../platform/storage/api.ts';
import * as taskSql from '../../repository/subagent-task-repository.ts';
import type { SubagentTaskRow } from '../../repository/subagent-task-repository.ts';
import { ulid } from './util.ts';
import { toRfc3339 as nowRfc3339, toRfc3339, parseRfc3339 } from '../../../../platform/time/index.ts';

export type SubagentTaskErrorKind = 'database' | 'not_found' | 'invalid_transition';

export class SubagentTaskError extends Error {
  readonly kind: SubagentTaskErrorKind;
  readonly detail: string;
  readonly taskId: string | null;
  readonly from: SubagentTaskStatus | null;
  readonly to: SubagentTaskStatus | null;

  constructor(
    kind: SubagentTaskErrorKind,
    detail: string,
    taskId: string | null = null,
    from: SubagentTaskStatus | null = null,
    to: SubagentTaskStatus | null = null,
  ) {
    const text = kind === 'database' ? `Database error: ${detail}`
      : kind === 'not_found' ? `Task not found: ${detail}`
        : `Invalid status transition for task ${taskId}: ${statusDebugName(from!)} -> ${statusDebugName(to!)}`;
    super(text);
    this.kind = kind;
    this.detail = detail;
    this.taskId = taskId;
    this.from = from;
    this.to = to;
    this.name = 'SubagentTaskError';
  }
}

const ALL_STATUSES: readonly SubagentTaskStatus[] = [
  'pending', 'running', 'completed', 'failed', 'cancelled', 'unknown',
];

function statusDebugName(status: SubagentTaskStatus): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `SubagentTaskData::new`：status=pending、started/completed/summary 为空。 */
export function newSubagentTask(
  workspaceId: string,
  agentSessionId: string,
  skillId: string | null,
  initialTask: string | null,
): SubagentTaskData {
  return {
    id: `task_${ulid()}`,
    workspaceId,
    agentSessionId,
    skillId,
    initialTask,
    status: 'pending',
    createdAt: nowRfc3339(),
    startedAt: null,
    completedAt: null,
    resultSummary: null,
  };
}

export class SubagentTaskManager {
  private readonly db: SqlExecutor;

  constructor(db: SqlExecutor) {
    this.db = db;
  }

  /** 校验任务状态机转换是否合法（同状态幂等）。 */
  static isValidTransition(from: SubagentTaskStatus, to: SubagentTaskStatus): boolean {
    if (from === to) return true;
    switch (from) {
      case 'pending':
        return to === 'running' || to === 'cancelled' || to === 'failed';
      case 'running':
        return to === 'completed' || to === 'failed' || to === 'cancelled' || to === 'unknown';
      case 'unknown':
        return to === 'running' || to === 'completed' || to === 'failed' || to === 'cancelled';
      default:
        return false;
    }
  }

  /** 目标状态的合法前驱列表（含同状态幂等），渲染为 SQL IN 子句内容。 */
  static allowedPredecessorsSql(to: SubagentTaskStatus): string {
    return ALL_STATUSES
      .filter(from => SubagentTaskManager.isValidTransition(from, to))
      .map(from => `'${from}'`)
      .join(', ');
  }

  static parseStatus(value: string): SubagentTaskStatus {
    return ALL_STATUSES.find(status => status === value) ?? 'pending';
  }

  createTask(task: SubagentTaskData): void {
    try {
      taskSql.createTask(this.db, {
        id: task.id,
        workspaceId: task.workspaceId,
        agentSessionId: task.agentSessionId,
        skillId: task.skillId,
        initialTask: task.initialTask,
        status: task.status,
        createdAt: task.createdAt,
      });
    } catch (error) {
      throw new SubagentTaskError('database', messageOf(error));
    }
  }

  /**
   * 更新任务状态（单条原子 UPDATE，`status IN (合法前驱)`）。
   * `changes() == 0` 表示任务不存在或当前状态不是合法前驱。
   */
  updateStatus(taskId: string, status: SubagentTaskStatus, resultSummary: string | null): void {
    let changes: number;
    try {
      changes = taskSql.updateTaskStatus(
        this.db,
        taskId,
        status,
        nowRfc3339(),
        resultSummary,
        SubagentTaskManager.allowedPredecessorsSql(status),
      );
    } catch (error) {
      throw new SubagentTaskError('database', messageOf(error));
    }

    if (changes === 0) {
      let currentStatusValue: string | undefined;
      try {
        currentStatusValue = taskSql.selectTaskStatus(this.db, taskId);
      } catch (error) {
        throw new SubagentTaskError('database', messageOf(error));
      }
      if (currentStatusValue === undefined) {
        throw new SubagentTaskError('not_found', taskId);
      }
      const currentStatus = SubagentTaskManager.parseStatus(currentStatusValue);
      throw new SubagentTaskError('invalid_transition', '', taskId, currentStatus, status);
    }
  }

  markRunning(taskId: string): void {
    this.updateStatus(taskId, 'running', null);
  }

  markCompleted(taskId: string, resultSummary: string | null): void {
    this.updateStatus(taskId, 'completed', resultSummary);
  }

  markFailed(taskId: string, errorMessage: string | null): void {
    this.updateStatus(taskId, 'failed', errorMessage);
  }

  markUnknown(taskId: string, reason: string | null): void {
    this.updateStatus(taskId, 'unknown', reason);
  }

  /**
   * 启动 sweep：把 owner 进程已死的 running 任务收敛为 Unknown。
   * 并发下已被他处迁移的单个任务跳过不计错误。
   */
  sweepOrphanedRunning(isAgentAlive: (agentSessionId: string) => boolean): SubagentTaskData[] {
    let runningIds: string[];
    try {
      runningIds = taskSql.listRunningTaskIds(this.db);
    } catch (error) {
      throw new SubagentTaskError('database', messageOf(error));
    }

    const swept: SubagentTaskData[] = [];
    for (const taskId of runningIds) {
      const task = this.getTask(taskId);
      if (task === null) continue;
      if (isAgentAlive(task.agentSessionId)) continue;
      try {
        this.markUnknown(task.id, 'owner process lost before terminal state; outcome unknown');
      } catch (error) {
        if (error instanceof SubagentTaskError && error.kind === 'invalid_transition') continue;
        throw error;
      }
      swept.push({ ...task, status: 'unknown' });
    }
    return swept;
  }

  /** 获取待用户决策的 Unknown 任务（恢复路径的“不盲重跑”清单）。 */
  getUnknownTasks(): SubagentTaskData[] {
    return this.queryRows(() => taskSql.listUnknownTasks(this.db));
  }

  getTask(taskId: string): SubagentTaskData | null {
    const row = this.queryOne(() => taskSql.getTask(this.db, taskId));
    return row === undefined ? null : rowToTask(row);
  }

  /** 获取需要恢复的任务（pending 或 running 状态）。 */
  getTasksToRestore(): SubagentTaskData[] {
    return this.queryRows(() => taskSql.listTasksToRestore(this.db));
  }

  /** 列出最近的任务（不限状态，按创建时间倒序）。 */
  listRecentTasks(limit: number): SubagentTaskData[] {
    return this.queryRows(() => taskSql.listRecentTasks(this.db, limit));
  }

  /** 获取代理的当前任务。 */
  getAgentTask(agentSessionId: string): SubagentTaskData | null {
    const row = this.queryOne(() => taskSql.getAgentTask(this.db, agentSessionId));
    return row === undefined ? null : rowToTask(row);
  }

  private queryRows(run: () => SubagentTaskRow[]): SubagentTaskData[] {
    let rows: SubagentTaskRow[];
    try {
      rows = run();
    } catch (error) {
      throw new SubagentTaskError('database', messageOf(error));
    }
    return rows.map(rowToTask);
  }

  private queryOne(run: () => SubagentTaskRow | undefined): SubagentTaskRow | undefined {
    try {
      return run();
    } catch (error) {
      throw new SubagentTaskError('database', messageOf(error));
    }
  }
}

function parseDbTimestamp(value: string, field: string): string {
  const parsed = parseRfc3339(value);
  if (parsed === null) {
    throw new SubagentTaskError('database', `Invalid RFC3339 in ${field}: ${value}`);
  }
  return toRfc3339(parsed.epochNanos);
}

function rowToTask(row: SubagentTaskRow): SubagentTaskData {
  const started = row.started_at === null ? null : parseRfc3339(row.started_at);
  const completed = row.completed_at === null ? null : parseRfc3339(row.completed_at);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    agentSessionId: row.agent_session_id,
    skillId: row.skill_id,
    initialTask: row.initial_task,
    status: SubagentTaskManager.parseStatus(row.status),
    createdAt: parseDbTimestamp(row.created_at, 'created_at'),
    startedAt: started === null ? null : toRfc3339(started.epochNanos),
    completedAt: completed === null ? null : toRfc3339(completed.epochNanos),
    resultSummary: row.result_summary,
  };
}
