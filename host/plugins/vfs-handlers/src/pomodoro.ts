/** vfs/todo_handlers.rs + vfs/pomodoro_handlers.rs: 番茄钟命令层（错误为 String，与前端契约一致）。 */
import { CommandError } from '../../../kernel/api.ts';
import { pomodoroErrorMessage } from './errors.ts';
import type { TodoDeps } from './todo.ts';
import { emitTodoChanged } from './todo.ts';
import type {
  CreatePomodoroRecordParams,
  PomodoroDailyStat,
  PomodoroHourlyStat,
  PomodoroRecord,
  PomodoroRepository,
  PomodoroStatsOverview,
  PomodoroStreakStats,
  PomodoroTodayStats,
  PomodoroTodoFocusSummary as RepoTodoFocusSummary,
  PomodoroTodoStat as RepoTodoStat,
} from '../../vfs-repos/api.ts';
import type {
  PomodoroTodoFocusSummary,
  PomodoroTodoStat,
} from '../../../../contracts/ipc/generated/L13-vfs-api.ts';

export interface CreatePomodoroInput {
  todoItemId?: string | null;
  startTime: string;
  endTime?: string | null;
  duration: number;
  actualDuration: number;
  type?: string;
  status?: string;
}

export interface PomodoroDeps {
  readonly conn: TodoDeps['conn'];
  readonly repos: PomodoroRepository;
  readonly log: TodoDeps['log'];
  readonly emit: TodoDeps['emit'];
}

function fail(error: unknown): never {
  throw new CommandError(pomodoroErrorMessage(error));
}

export function createRecord(deps: PomodoroDeps, input: CreatePomodoroInput): PomodoroRecord {
  const params: CreatePomodoroRecordParams = {
    todoItemId: input.todoItemId ?? null,
    startTime: input.startTime,
    endTime: input.endTime ?? null,
    duration: input.duration,
    actualDuration: input.actualDuration,
    type: input.type ?? 'work',
    status: input.status ?? 'completed',
  };
  let record: PomodoroRecord;
  try {
    record = deps.repos.createRecord(deps.conn(), params);
  } catch (error) {
    return fail(error);
  }
  if (record.type === 'work' && record.status === 'completed' && record.todoItemId != null) {
    emitTodoChanged(deps, 'update', [record.todoItemId]);
  }
  return record;
}

export function getRecord(deps: PomodoroDeps, recordId: string): PomodoroRecord | null {
  try {
    return deps.repos.getRecord(deps.conn(), recordId);
  } catch (error) {
    return fail(error);
  }
}

export function listByTodo(deps: PomodoroDeps, todoItemId: string): PomodoroRecord[] {
  try {
    return deps.repos.listByTodoItem(deps.conn(), todoItemId);
  } catch (error) {
    return fail(error);
  }
}

export function todayStats(deps: PomodoroDeps): PomodoroTodayStats {
  try {
    return deps.repos.getTodayStats(deps.conn());
  } catch (error) {
    return fail(error);
  }
}

export function listToday(deps: PomodoroDeps): PomodoroRecord[] {
  try {
    return deps.repos.listTodayRecords(deps.conn());
  } catch (error) {
    return fail(error);
  }
}

export function dailyStats(deps: PomodoroDeps, days: number | null): PomodoroDailyStat[] {
  try {
    return deps.repos.getDailyStats(deps.conn(), days ?? 7);
  } catch (error) {
    return fail(error);
  }
}

export function deleteRecord(deps: PomodoroDeps, recordId: string): null {
  // Rust: VfsPomodoroRepo::get_record(..).ok().flatten() — read errors are ignored.
  let linkedItem: string | null = null;
  try {
    const record = deps.repos.getRecord(deps.conn(), recordId);
    if (record !== null && record.type === 'work' && record.status === 'completed') {
      linkedItem = record.todoItemId ?? null;
    }
  } catch (error) {
    deps.log.debug('[pomodoro_handlers] linked todo lookup failed: %s', error);
    linkedItem = null;
  }
  try {
    deps.repos.deleteRecord(deps.conn(), recordId);
  } catch (error) {
    return fail(error);
  }
  if (linkedItem !== null) emitTodoChanged(deps, 'update', [linkedItem]);
  return null;
}

export function listRange(deps: PomodoroDeps, startDate: string, endDate: string): PomodoroRecord[] {
  try {
    return deps.repos.listRange(deps.conn(), startDate, endDate);
  } catch (error) {
    return fail(error);
  }
}

export function streak(deps: PomodoroDeps): PomodoroStreakStats {
  try {
    return deps.repos.getStreakStats(deps.conn());
  } catch (error) {
    return fail(error);
  }
}

export function hourlyStats(deps: PomodoroDeps, days: number | null): PomodoroHourlyStat[] {
  try {
    return deps.repos.getHourlyStats(deps.conn(), days ?? 30);
  } catch (error) {
    return fail(error);
  }
}

export function statsByTodo(
  deps: PomodoroDeps,
  startDate: string | null,
  endDate: string | null,
  limit: number | null,
): PomodoroTodoStat[] {
  let stats: RepoTodoStat[];
  try {
    stats = deps.repos.getStatsByTodo(deps.conn(), startDate, endDate, limit ?? 20);
  } catch (error) {
    return fail(error);
  }
  // Rust PomodoroTodoStat 没有 skip_serializing_if：todoTitle 为 None 时序列化为 null。
  return stats.map(entry => ({ ...entry, todoTitle: entry.todoTitle ?? null }));
}

export function statsOverview(deps: PomodoroDeps, days: number | null): PomodoroStatsOverview {
  try {
    return deps.repos.getStatsOverview(deps.conn(), days ?? 30);
  } catch (error) {
    return fail(error);
  }
}

export function todoFocusSummary(deps: PomodoroDeps, todoItemId: string): PomodoroTodoFocusSummary {
  let summary: RepoTodoFocusSummary;
  try {
    summary = deps.repos.getTodoFocusSummary(deps.conn(), todoItemId);
  } catch (error) {
    return fail(error);
  }
  // Rust PomodoroTodoFocusSummary 没有 skip_serializing_if：Optional 字段为 None 时是 null。
  return {
    todoItemId: summary.todoItemId,
    todoTitle: summary.todoTitle ?? null,
    totalFocusSeconds: summary.totalFocusSeconds,
    completedCount: summary.completedCount,
    interruptedCount: summary.interruptedCount,
    firstFocusAt: summary.firstFocusAt ?? null,
    lastFocusAt: summary.lastFocusAt ?? null,
    daily: summary.daily,
  };
}
