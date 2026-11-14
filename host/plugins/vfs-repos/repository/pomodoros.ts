/** Port of dstu-vfs pomodoro_repo.rs. All functions take the caller's connection. */
import { logError, logInfo, logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import { defineQuery, type Row, type SqlExecutor, type SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError,
  type CreatePomodoroRecordParams,
  type PomodoroDailyStat,
  type PomodoroFocusDay,
  type PomodoroHourlyStat,
  type PomodoroRecord,
  type PomodoroRepository,
  type PomodoroStatsOverview,
  type PomodoroStreakStats,
  type PomodoroTodoFocusSummary,
  type PomodoroTodoStat,
  type PomodoroTodayStats,
  type PomodoroWeeklyStat,
} from '../api.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import { databaseResult } from './errors.ts';
import { utcTimestamp } from './timestamps.ts';

const VALID_POMODORO_TYPES = ['work', 'short_break', 'long_break'] as const;
const VALID_POMODORO_STATUSES = ['completed', 'interrupted'] as const;
const RECORD_COLUMNS = `id, todo_item_id, start_time, end_time, duration, actual_duration,
  type, status, created_at, updated_at, deleted_at`;

/**
 * S04/TD-02: `pomodoro_counts.rs` 的完成数口径。
 * `todo_item_id IS NOT NULL` 与 Rust `COMPLETED_WORK_FILTER` 一致（孤儿记录不参与计数）。
 */
const COMPLETED_WORK_FILTER = [
  'todo_item_id IS NOT NULL',
  'deleted_at IS NULL',
  "type = 'work'",
  "status = 'completed'",
].join(' AND ');

const UPDATE_COMPLETED_POMODOROS_FROM_FACTS = `
  UPDATE todo_items
  SET completed_pomodoros = rc.cnt
  FROM (
      SELECT todo_item_id, COUNT(*) AS cnt
      FROM pomodoro_records
      WHERE ${COMPLETED_WORK_FILTER}
      GROUP BY todo_item_id
  ) rc
  WHERE todo_items.id = rc.todo_item_id
    AND todo_items.completed_pomodoros IS NOT rc.cnt
`;

const ZERO_EMPTY_COMPLETED_POMODOROS = `
  UPDATE todo_items
  SET completed_pomodoros = 0
  WHERE completed_pomodoros IS NOT 0
    AND id NOT IN (
        SELECT todo_item_id FROM pomodoro_records
        WHERE ${COMPLETED_WORK_FILTER}
    )
`;

/** `change_log_max_id`：表不存在/查询失败返回 null（Rust `.ok()`）；i64 保持 bigint。 */
const CHANGE_LOG_MAX_ID = defineQuery<void, { max_id: bigint }>(
  'SELECT COALESCE(MAX(id), 0) AS max_id FROM __change_log',
  { name: 'vfsRepos.pomodoro.changeLogMaxId', options: { safeIntegers: true } },
);

/** 回声抑制：只标记重算之后新增、尚未上传的 `todo_items` 变更。 */
const SUPPRESS_TODO_ITEMS_ECHO = defineQuery<[number, bigint], void>(
  `UPDATE __change_log SET sync_version = ?1
   WHERE id > ?2
     AND sync_version = 0
     AND table_name = 'todo_items'`,
  { name: 'vfsRepos.pomodoro.suppressTodoItemsEcho' },
);

/**
 * Rust `SyncManager::table_has_column`（sync/mod.rs:8147-8159）：缺表时 PRAGMA
 * 返回空集；prepare/query 失败同样按 false 处理（`pomodoro_counts.rs:91-97` 随后静默跳过）。
 * 只容错形状探测本身，重算/清零的 UPDATE 错误仍由调用处转换并传播。
 */
function tableHasColumn(conn: SqlExecutor, tableName: string, columnName: string): boolean {
  try {
    return conn.all<{ name: string }>(`SELECT name FROM pragma_table_info('${tableName}')`)
      .some(column => column.name === columnName);
  } catch { // boundary-allow empty-catch: sync/mod.rs:8147-8159 的 prepare/query 失败按 false。
    return false;
  }
}

function syncCountsDatabaseError(action: string, error: unknown): VfsRepositoryError {
  return new VfsRepositoryError(
    'VFS_STORAGE',
    `${action} 失败: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface LocalDate { year: number; month: number; day: number }

function invalidArgument(param: string, reason: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_INVALID_ARGUMENT', `Invalid argument '${param}': ${reason}`, { param });
}
function notFound(resourceType: string, id: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_NOT_FOUND', `${resourceType} not found: ${id}`, { resourceType, id });
}
function databaseMessage(message: string): VfsRepositoryError {
  return new VfsRepositoryError('VFS_STORAGE', `Database error: ${message}`);
}

function valueKind(value: SqlValue | undefined): string {
  if (value === null || value === undefined) return 'Null';
  if (typeof value === 'string') return 'Text';
  if (typeof value === 'number') return Number.isInteger(value) ? 'Integer' : 'Real';
  if (typeof value === 'bigint') return 'Integer';
  return 'Blob';
}
function columnError(index: number, name: string, value: SqlValue | undefined): VfsRepositoryError {
  return databaseMessage(`Invalid column type ${valueKind(value)} at index: ${index}, name: ${name}`);
}
function readText(row: Row, name: string, index: number): string {
  const value = row[name];
  if (typeof value !== 'string') throw columnError(index, name, value);
  return value;
}
function readInteger(row: Row, name: string, index: number): number {
  const value = row[name];
  const number = typeof value === 'bigint' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isInteger(number)) throw columnError(index, name, value);
  return number;
}
function optionalText(value: SqlValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function rowToRecord(row: Row): PomodoroRecord {
  const todoItemId = optionalText(row.todo_item_id);
  const endTime = optionalText(row.end_time);
  const updatedAt = optionalText(row.updated_at);
  const deletedAt = optionalText(row.deleted_at);
  return {
    id: readText(row, 'id', 0),
    ...(todoItemId === undefined ? {} : { todoItemId }),
    startTime: readText(row, 'start_time', 2),
    ...(endTime === undefined ? {} : { endTime }),
    duration: readInteger(row, 'duration', 4),
    actualDuration: readInteger(row, 'actual_duration', 5),
    type: readText(row, 'type', 6),
    status: readText(row, 'status', 7),
    createdAt: readText(row, 'created_at', 8),
    ...(updatedAt === undefined ? {} : { updatedAt }),
    ...(deletedAt === undefined ? {} : { deletedAt }),
  };
}

function mapRecords(rows: readonly Row[]): PomodoroRecord[] {
  const records: PomodoroRecord[] = [];
  for (const row of rows) {
    try { records.push(rowToRecord(row)); }
    catch (error) { logWarn('[VFS::PomodoroRepo] Row parse error:', error); }
  }
  return records;
}

function validateRecordParams(params: CreatePomodoroRecordParams): void {
  if (!(VALID_POMODORO_TYPES as readonly string[]).includes(params.type)) {
    throw invalidArgument('type',
      `Unsupported pomodoro type '${params.type}'; expected one of ["work", "short_break", "long_break"]`);
  }
  if (!(VALID_POMODORO_STATUSES as readonly string[]).includes(params.status)) {
    throw invalidArgument('status',
      `Unsupported pomodoro status '${params.status}'; expected one of ["completed", "interrupted"]`);
  }
  if (params.duration < 0) throw invalidArgument('duration', 'duration must be >= 0');
  if (params.actualDuration < 0) throw invalidArgument('actual_duration', 'actual_duration must be >= 0');
}

function statOrWarn<T>(ctx: string, fallback: T, run: () => T): T {
  try { return run(); }
  catch (error) {
    logError(`[VFS::PomodoroRepo] Stats scalar query '${ctx}' failed, returning default(0); `
      + `result may under-report and mask DB corruption or schema drift:`, error);
    return fallback;
  }
}

function dayNumber(date: LocalDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}
function dateFromDayNumber(number: number): LocalDate {
  const date = new Date(number * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}
function addDays(date: LocalDate, days: number): LocalDate {
  return dateFromDayNumber(dayNumber(date) + days);
}
function compareDates(left: LocalDate, right: LocalDate): number {
  return dayNumber(left) - dayNumber(right);
}
function formatDate(date: LocalDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}
function localToday(): LocalDate {
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
}
function localDateOf(date: Date): LocalDate {
  return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
}
function parseTimestamp(value: string): Date | null {
  const parsed = parseRfc3339(value);
  return parsed === null ? null : new Date(parsed.millis);
}
function parseYmd(param: string, value: string): LocalDate {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (match === null) {
    throw invalidArgument(param, `Expected YYYY-MM-DD, got '${value}': input contains invalid characters`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) {
    throw invalidArgument(param, `Expected YYYY-MM-DD, got '${value}': input is out of range`);
  }
  return { year, month, day };
}

/** Rust `local_date_start_utc`: local midnight expressed as UTC RFC3339 milliseconds. */
function localDateStartUtc(date: LocalDate): string {
  const dt = new Date(date.year, date.month - 1, date.day, 0, 0, 0, 0);
  if (Number.isNaN(dt.getTime())) {
    throw invalidArgument('date', `Cannot resolve local midnight for date '${formatDate(date)}'`);
  }
  return dt.toISOString();
}

function recountCompletedPomodorosCache(conn: SqlExecutor, todoItemId: string, now: string): void {
  conn.run(`UPDATE todo_items
    SET completed_pomodoros = (
            SELECT COUNT(*) FROM pomodoro_records
            WHERE todo_item_id = todo_items.id
              AND deleted_at IS NULL
              AND type = 'work'
              AND status = 'completed'
        ),
        updated_at = ?1,
        local_version = COALESCE(local_version, 0) + 1
    WHERE id = ?2
      AND deleted_at IS NULL
      AND completed_pomodoros IS NOT (
            SELECT COUNT(*) FROM pomodoro_records
            WHERE todo_item_id = todo_items.id
              AND deleted_at IS NULL
              AND type = 'work'
              AND status = 'completed'
        )`, [now, todoItemId]);
}

function weeklyFromDaily(daily: readonly PomodoroDailyStat[]): PomodoroWeeklyStat[] {
  const weeks: PomodoroWeeklyStat[] = [];
  const indexByStart = new Map<string, number>();
  for (const day of daily) {
    let date: LocalDate;
    try { date = parseYmd('date', day.date); }
    catch (error) {
      logWarn(`[VFS::PomodoroRepo] Skipping malformed daily bucket date '${day.date}' in weekly stats:`, error);
      continue;
    }
    const weekday = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
    const offset = (weekday + 6) % 7;
    const weekStart = addDays(date, -offset);
    const key = formatDate(weekStart);
    let index = indexByStart.get(key);
    if (index === undefined) {
      weeks.push({
        weekStart: key, completedCount: 0, focusSeconds: 0,
        interruptedCount: 0, activeDays: 0,
      });
      index = weeks.length - 1;
      indexByStart.set(key, index);
    }
    const week = weeks[index]!;
    week.completedCount += day.completedCount;
    week.focusSeconds += day.focusSeconds;
    week.interruptedCount += day.interruptedCount;
    if (day.completedCount > 0 || day.focusSeconds > 0) week.activeDays += 1;
  }
  return weeks;
}

export class PomodoroRepo implements PomodoroRepository {
  createRecord(conn: SqlExecutor, params: CreatePomodoroRecordParams): PomodoroRecord {
    return databaseResult(() => {
      validateRecordParams(params);
      const recordId = `pd_${nanoid(10)}`;
      const now = utcTimestamp();
      const todoItemId = params.todoItemId ?? null;
      const endTime = params.endTime ?? null;
      conn.exec('SAVEPOINT pomodoro_create');
      try {
        conn.run(`INSERT INTO pomodoro_records
            (id, todo_item_id, start_time, end_time, duration, actual_duration, type, status, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)`,
        [recordId, todoItemId, params.startTime, endTime, params.duration,
          params.actualDuration, params.type, params.status, now]);
        if (todoItemId !== null && params.status === 'completed' && params.type === 'work') {
          recountCompletedPomodorosCache(conn, todoItemId, now);
        }
        conn.exec('RELEASE SAVEPOINT pomodoro_create');
      } catch (error) {
        try { conn.exec('ROLLBACK TO SAVEPOINT pomodoro_create'); }
        catch (rollbackError) { logWarn('[VFS::PomodoroRepo] Create rollback failed:', rollbackError); }
        try { conn.exec('RELEASE SAVEPOINT pomodoro_create'); }
        catch (releaseError) { logWarn('[VFS::PomodoroRepo] Create release failed:', releaseError); }
        throw error;
      }
      logInfo(`[VFS::PomodoroRepo] Created pomodoro record: ${recordId}`);
      return {
        id: recordId,
        ...(todoItemId === null ? {} : { todoItemId }),
        startTime: params.startTime,
        ...(endTime === null ? {} : { endTime }),
        duration: params.duration,
        actualDuration: params.actualDuration,
        type: params.type,
        status: params.status,
        createdAt: now,
        updatedAt: now,
      };
    });
  }

  deleteRecord(conn: SqlExecutor, recordId: string): void {
    databaseResult(() => {
      const now = utcTimestamp();
      conn.exec('SAVEPOINT pomodoro_delete');
      try {
        const target = conn.get<Row>(
          `SELECT todo_item_id, type, status FROM pomodoro_records
           WHERE id = ?1 AND deleted_at IS NULL`, [recordId]);
        if (target === undefined) throw notFound('PomodoroRecord', recordId);
        const todoItemId = optionalText(target.todo_item_id) ?? null;
        const type = readText(target, 'type', 1);
        const status = readText(target, 'status', 2);
        conn.run(`UPDATE pomodoro_records
          SET deleted_at = ?1,
              updated_at = ?1,
              local_version = COALESCE(local_version, 0) + 1
          WHERE id = ?2 AND deleted_at IS NULL`, [now, recordId]);
        if (todoItemId !== null && status === 'completed' && type === 'work') {
          recountCompletedPomodorosCache(conn, todoItemId, now);
        }
        conn.exec('RELEASE SAVEPOINT pomodoro_delete');
      } catch (error) {
        try { conn.exec('ROLLBACK TO SAVEPOINT pomodoro_delete'); }
        catch (rollbackError) { logWarn('[VFS::PomodoroRepo] Delete rollback failed:', rollbackError); }
        try { conn.exec('RELEASE SAVEPOINT pomodoro_delete'); }
        catch (releaseError) { logWarn('[VFS::PomodoroRepo] Delete release failed:', releaseError); }
        throw error;
      }
      logInfo(`[VFS::PomodoroRepo] Deleted pomodoro record: ${recordId}`);
    });
  }

  recountCompletedPomodorosCache(conn: SqlExecutor, todoItemId: string, now: string): void {
    databaseResult(() => recountCompletedPomodorosCache(conn, todoItemId, now));
  }

  /**
   * S04/TD-02：同步 apply 提交边界上的派生计数全量重算。
   *
   * 语义对应 `dstu-sync/.../sync/pomodoro_counts.rs:72-145`：
   * - 只有批次触及 `pomodoro_records` 或 `todo_items` 才重算；
   * - 以未软删的 `work` + `completed` 事实行重算所有 todo，空集合归零；
   * - `IS NOT` 避免值未变化时 UPDATE（不触发变更日志触发器）；
   * - 不修改 `updated_at` / `local_version`（派生缓存不是本地业务修改）；
   * - 抑制 `pre_log_max` 之后本批新增的 `todo_items` 日志（`sync_version = 0`），
   *   既有未同步日志（id <= pre_log_max）保持原样；`pre_log_max` 以 i64/bigint 读取。
   *
   * 必须由调用方在 vfs 的同步 apply 事务（`BEGIN IMMEDIATE`）、所有单条 SAVEPOINT
   * 之后、提交之前用该事务的执行器调用；调用方不得另开/拆分事务，也不得自己
   * 写 `todo_items.completed_pomodoros`。
   */
  recomputeCompletedPomodorosForSyncBatch(conn: SqlExecutor, changedTables: readonly string[]): void {
    if (!changedTables.includes('pomodoro_records') && !changedTables.includes('todo_items')) return;
    // 库形状守卫（Rust pomodoro_counts.rs:91-97）：缺表/缺列时静默跳过。
    if (!tableHasColumn(conn, 'todo_items', 'completed_pomodoros')
      || !tableHasColumn(conn, 'pomodoro_records', 'todo_item_id')
      || !tableHasColumn(conn, 'pomodoro_records', 'status')) {
      return;
    }

    let preLogMax: bigint | null;
    try {
      preLogMax = conn.get(CHANGE_LOG_MAX_ID)?.max_id ?? 0n;
    } catch {
      preLogMax = null;
    }

    try {
      conn.run(UPDATE_COMPLETED_POMODOROS_FROM_FACTS);
    } catch (error) {
      throw syncCountsDatabaseError('重算 todo_items.completed_pomodoros', error);
    }
    try {
      conn.run(ZERO_EMPTY_COMPLETED_POMODOROS);
    } catch (error) {
      throw syncCountsDatabaseError('清零 todo_items.completed_pomodoros', error);
    }

    if (preLogMax !== null) {
      // Rust `let _ = conn.execute(...)`：回声抑制失败不影响重算结果，也不打日志。
      try {
        conn.run(SUPPRESS_TODO_ITEMS_ECHO, [Math.floor(Date.now() / 1000), preLogMax]);
      } catch { // boundary-allow empty-catch: pomodoro_counts.rs:137 的 let _ 无日志。
      }
    }
  }

  getRecord(conn: SqlExecutor, recordId: string): PomodoroRecord | null {
    return databaseResult(() => {
      const row = conn.get<Row>(`SELECT ${RECORD_COLUMNS} FROM pomodoro_records
        WHERE id = ?1 AND deleted_at IS NULL`, [recordId]);
      return row === undefined ? null : rowToRecord(row);
    });
  }

  listByTodoItem(conn: SqlExecutor, todoItemId: string): PomodoroRecord[] {
    return databaseResult(() => mapRecords(conn.all<Row>(`SELECT ${RECORD_COLUMNS}
      FROM pomodoro_records
      WHERE todo_item_id = ?1 AND deleted_at IS NULL
      ORDER BY created_at DESC`, [todoItemId])));
  }

  getTodayStats(conn: SqlExecutor): PomodoroTodayStats {
    return databaseResult(() => {
      const todayStart = localDateStartUtc(localToday());
      const completedCount = statOrWarn('today_completed_count', 0, () => Number(conn.pluck<number>(
        `SELECT COUNT(*) FROM pomodoro_records
         WHERE type = 'work' AND status = 'completed' AND created_at >= ?1
           AND deleted_at IS NULL`, [todayStart]) ?? 0));
      const totalFocusSeconds = statOrWarn('today_total_focus_seconds', 0, () => Number(conn.pluck<number>(
        `SELECT COALESCE(SUM(MAX(actual_duration, 0)), 0) FROM pomodoro_records
         WHERE type = 'work' AND status IN ('completed', 'interrupted')
           AND created_at >= ?1 AND deleted_at IS NULL`, [todayStart]) ?? 0));
      const completedFocusSeconds = statOrWarn('today_completed_focus_seconds', 0, () => Number(conn.pluck<number>(
        `SELECT COALESCE(SUM(MAX(actual_duration, 0)), 0) FROM pomodoro_records
         WHERE type = 'work' AND status = 'completed' AND created_at >= ?1
           AND deleted_at IS NULL`, [todayStart]) ?? 0));
      const interruptedCount = statOrWarn('today_interrupted_count', 0, () => Number(conn.pluck<number>(
        `SELECT COUNT(*) FROM pomodoro_records
         WHERE type = 'work' AND status = 'interrupted' AND created_at >= ?1
           AND deleted_at IS NULL`, [todayStart]) ?? 0));
      return { completedCount, totalFocusSeconds, interruptedCount, completedFocusSeconds };
    });
  }

  focusSecondsByLocalDate(conn: SqlExecutor, startDate: string, endDateExclusive: string): Record<string, number> {
    return databaseResult(() => {
      const start = parseYmd('start', startDate);
      const end = parseYmd('end_exclusive', endDateExclusive);
      const startUtc = localDateStartUtc(start);
      const endUtc = localDateStartUtc(end);
      const rows = conn.all<Row>(
        `SELECT created_at, actual_duration FROM pomodoro_records
         WHERE type = 'work' AND status IN ('completed', 'interrupted')
           AND created_at >= ?1 AND created_at < ?2 AND deleted_at IS NULL`,
        [startUtc, endUtc]);
      const byDay = new Map<number, { date: LocalDate; seconds: number }>();
      for (const row of rows) {
        let createdAt: string;
        let actualDuration: number;
        try {
          createdAt = readText(row, 'created_at', 0);
          actualDuration = readInteger(row, 'actual_duration', 1);
        } catch (error) {
          logWarn('[VFS::PomodoroRepo] Row parse error:', error);
          continue;
        }
        const parsed = parseTimestamp(createdAt);
        if (parsed === null) continue;
        const date = localDateOf(parsed);
        if (compareDates(date, start) < 0 || compareDates(date, end) >= 0) continue;
        const key = dayNumber(date);
        const bucket = byDay.get(key);
        if (bucket === undefined) byDay.set(key, { date, seconds: Math.max(0, actualDuration) });
        else bucket.seconds += Math.max(0, actualDuration);
      }
      const result: Record<string, number> = {};
      for (const [, bucket] of [...byDay.entries()].sort(([left], [right]) => left - right)) {
        result[formatDate(bucket.date)] = bucket.seconds;
      }
      return result;
    });
  }

  getDailyStats(conn: SqlExecutor, days: number): PomodoroDailyStat[] {
    return databaseResult(() => {
      const clamped = Math.min(366, Math.max(1, Math.trunc(days)));
      const today = localToday();
      const rangeStartLocal = addDays(today, -(clamped - 1));
      const rangeStartUtc = localDateStartUtc(rangeStartLocal);
      const rows = conn.all<Row>(
        `SELECT created_at, status, actual_duration FROM pomodoro_records
         WHERE type = 'work' AND created_at >= ?1 AND deleted_at IS NULL`, [rangeStartUtc]);
      const buckets: PomodoroDailyStat[] = [];
      for (let i = 0; i < clamped; i += 1) {
        buckets.push({
          date: formatDate(addDays(rangeStartLocal, i)),
          completedCount: 0, focusSeconds: 0, interruptedCount: 0,
        });
      }
      for (const row of rows) {
        let createdAt: string;
        let status: string;
        let actualDuration: number;
        try {
          createdAt = readText(row, 'created_at', 0);
          status = readText(row, 'status', 1);
          actualDuration = readInteger(row, 'actual_duration', 2);
        } catch (error) {
          logWarn('[VFS::PomodoroRepo] Row parse error:', error);
          continue;
        }
        const parsed = parseTimestamp(createdAt);
        if (parsed === null) {
          logWarn(`[VFS::PomodoroRepo] Skipping record with non-RFC3339 created_at '${createdAt}' in daily stats`);
          continue;
        }
        const index = dayNumber(localDateOf(parsed)) - dayNumber(rangeStartLocal);
        if (index < 0 || index >= clamped) continue;
        const bucket = buckets[index]!;
        if (status === 'completed') {
          bucket.completedCount += 1;
          bucket.focusSeconds += Math.max(0, actualDuration);
        } else if (status === 'interrupted') {
          bucket.interruptedCount += 1;
          bucket.focusSeconds += Math.max(0, actualDuration);
        }
      }
      return buckets;
    });
  }

  listTodayRecords(conn: SqlExecutor): PomodoroRecord[] {
    return databaseResult(() => {
      const todayStart = localDateStartUtc(localToday());
      return mapRecords(conn.all<Row>(`SELECT ${RECORD_COLUMNS} FROM pomodoro_records
        WHERE created_at >= ?1 AND deleted_at IS NULL
        ORDER BY created_at DESC`, [todayStart]));
    });
  }

  listRange(conn: SqlExecutor, startDate: string, endDate: string): PomodoroRecord[] {
    return databaseResult(() => {
      const start = parseYmd('start_date', startDate);
      const end = parseYmd('end_date', endDate);
      if (compareDates(start, end) > 0) {
        throw invalidArgument('start_date',
          `start_date '${formatDate(start)}' must be <= end_date '${formatDate(end)}'`);
      }
      const rangeStartUtc = localDateStartUtc(start);
      const rangeEndUtc = localDateStartUtc(addDays(end, 1));
      return mapRecords(conn.all<Row>(`SELECT ${RECORD_COLUMNS} FROM pomodoro_records
        WHERE created_at >= ?1 AND created_at < ?2 AND deleted_at IS NULL
        ORDER BY created_at DESC`, [rangeStartUtc, rangeEndUtc]));
    });
  }

  getStreakStats(conn: SqlExecutor): PomodoroStreakStats {
    return databaseResult(() => {
      const rows = conn.all<Row>(
        `SELECT created_at FROM pomodoro_records
         WHERE type = 'work' AND status = 'completed' AND deleted_at IS NULL`);
      const activeDays = new Set<number>();
      for (const row of rows) {
        let createdAt: string;
        try { createdAt = readText(row, 'created_at', 0); }
        catch (error) { logWarn('[VFS::PomodoroRepo] Row parse error:', error); continue; }
        const parsed = parseTimestamp(createdAt);
        if (parsed === null) {
          logWarn(`[VFS::PomodoroRepo] Skipping record with non-RFC3339 created_at '${createdAt}' in streak stats`);
          continue;
        }
        activeDays.add(dayNumber(localDateOf(parsed)));
      }

      let longestStreakDays = 0;
      let run = 0;
      let previous: number | null = null;
      for (const day of [...activeDays].sort((left, right) => left - right)) {
        run = previous !== null && day - previous === 1 ? run + 1 : 1;
        longestStreakDays = Math.max(longestStreakDays, run);
        previous = day;
      }

      const today = dayNumber(localToday());
      let anchor: number | null = activeDays.has(today) ? today
        : activeDays.has(today - 1) ? today - 1 : null;
      let currentStreakDays = 0;
      while (anchor !== null) {
        if (!activeDays.has(anchor)) break;
        currentStreakDays += 1;
        anchor -= 1;
      }
      return { currentStreakDays, longestStreakDays };
    });
  }

  getHourlyStats(conn: SqlExecutor, days: number): PomodoroHourlyStat[] {
    return databaseResult(() => {
      const clamped = Math.min(366, Math.max(1, Math.trunc(days)));
      const rangeStartUtc = localDateStartUtc(addDays(localToday(), -(clamped - 1)));
      const rows = conn.all<Row>(
        `SELECT start_time, status, actual_duration FROM pomodoro_records
         WHERE type = 'work' AND created_at >= ?1 AND deleted_at IS NULL`, [rangeStartUtc]);
      const buckets: PomodoroHourlyStat[] = Array.from({ length: 24 }, (_, hour) => ({
        hour, completedCount: 0, focusSeconds: 0,
      }));
      for (const row of rows) {
        let startTime: string;
        let status: string;
        let actualDuration: number;
        try {
          startTime = readText(row, 'start_time', 0);
          status = readText(row, 'status', 1);
          actualDuration = readInteger(row, 'actual_duration', 2);
        } catch (error) {
          logWarn('[VFS::PomodoroRepo] Row parse error:', error);
          continue;
        }
        const parsed = parseTimestamp(startTime);
        if (parsed === null) {
          logWarn(`[VFS::PomodoroRepo] Skipping record with non-RFC3339 start_time '${startTime}' in hourly stats`);
          continue;
        }
        const bucket = buckets[parsed.getHours()]!;
        if (status === 'completed') {
          bucket.completedCount += 1;
          bucket.focusSeconds += Math.max(0, actualDuration);
        } else if (status === 'interrupted') {
          bucket.focusSeconds += Math.max(0, actualDuration);
        }
      }
      return buckets;
    });
  }

  getStatsByTodo(conn: SqlExecutor, startDate: string | null, endDate: string | null,
    limit: number): PomodoroTodoStat[] {
    return databaseResult(() => {
      const start = startDate === null ? null : parseYmd('start_date', startDate);
      const end = endDate === null ? null : parseYmd('end_date', endDate);
      if (start !== null && end !== null && compareDates(start, end) > 0) {
        throw invalidArgument('start_date',
          `start_date '${formatDate(start)}' must be <= end_date '${formatDate(end)}'`);
      }
      const rangeStartUtc = start === null
        ? '0000-01-01T00:00:00.000Z' : localDateStartUtc(start);
      const rangeEndUtc = end === null
        ? '9999-12-31T23:59:59.999Z' : localDateStartUtc(addDays(end, 1));
      const boundedLimit = Math.max(1, Math.trunc(limit));
      const rows = conn.all<Row>(
        `SELECT p.todo_item_id,
                t.title,
                SUM(CASE WHEN p.status = 'completed' THEN 1 ELSE 0 END) AS completed_count,
                COALESCE(SUM(MAX(p.actual_duration, 0)), 0) AS focus_seconds
         FROM pomodoro_records p
         LEFT JOIN todo_items t ON t.id = p.todo_item_id
         WHERE p.type = 'work'
           AND p.status IN ('completed', 'interrupted')
           AND p.todo_item_id IS NOT NULL
           AND p.deleted_at IS NULL
           AND p.created_at >= ?1 AND p.created_at < ?2
         GROUP BY p.todo_item_id
         ORDER BY focus_seconds DESC, completed_count DESC, p.todo_item_id ASC
         LIMIT ?3`, [rangeStartUtc, rangeEndUtc, boundedLimit]);
      const stats: PomodoroTodoStat[] = [];
      for (const row of rows) {
        try {
          const todoTitle = optionalText(row.title);
          stats.push({
            todoItemId: readText(row, 'todo_item_id', 0),
            ...(todoTitle === undefined ? {} : { todoTitle }),
            completedCount: readInteger(row, 'completed_count', 2),
            focusSeconds: readInteger(row, 'focus_seconds', 3),
          });
        } catch (error) {
          logWarn('[VFS::PomodoroRepo] Row parse error:', error);
        }
      }
      return stats;
    });
  }

  getStatsOverview(conn: SqlExecutor, days: number): PomodoroStatsOverview {
    return databaseResult(() => {
      const daily = this.getDailyStats(conn, days);
      const weekly = weeklyFromDaily(daily);
      return {
        today: this.getTodayStats(conn),
        streak: this.getStreakStats(conn),
        daily,
        weekly,
      };
    });
  }

  getTodoFocusSummary(conn: SqlExecutor, todoItemId: string): PomodoroTodoFocusSummary {
    return databaseResult(() => {
      const titleRow = conn.get<Row>('SELECT title FROM todo_items WHERE id = ?1', [todoItemId]);
      const todoTitle = titleRow === undefined ? undefined : optionalText(titleRow.title);

      const aggregate = conn.get<Row>(
        `SELECT COALESCE(SUM(MAX(actual_duration, 0)), 0) AS total_focus,
                COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count,
                COALESCE(SUM(CASE WHEN status = 'interrupted' THEN 1 ELSE 0 END), 0) AS interrupted_count,
                MIN(start_time) AS first_focus,
                MAX(start_time) AS last_focus
         FROM pomodoro_records
         WHERE todo_item_id = ?1 AND type = 'work'
           AND status IN ('completed', 'interrupted')
           AND deleted_at IS NULL`, [todoItemId]);
      if (aggregate === undefined) throw databaseMessage('query returned no rows');
      const totalFocusSeconds = readInteger(aggregate, 'total_focus', 0);
      const completedCount = readInteger(aggregate, 'completed_count', 1);
      const interruptedCount = readInteger(aggregate, 'interrupted_count', 2);
      const firstFocusAt = optionalText(aggregate.first_focus);
      const lastFocusAt = optionalText(aggregate.last_focus);

      const rows = conn.all<Row>(
        `SELECT created_at, status, actual_duration FROM pomodoro_records
         WHERE todo_item_id = ?1 AND type = 'work'
           AND status IN ('completed', 'interrupted')
           AND deleted_at IS NULL`, [todoItemId]);
      const buckets = new Map<number, { date: LocalDate; focus: number; completed: number; interrupted: number }>();
      for (const row of rows) {
        let createdAt: string;
        let status: string;
        let actualDuration: number;
        try {
          createdAt = readText(row, 'created_at', 0);
          status = readText(row, 'status', 1);
          actualDuration = readInteger(row, 'actual_duration', 2);
        } catch (error) {
          logWarn('[VFS::PomodoroRepo] Row parse error:', error);
          continue;
        }
        const parsed = parseTimestamp(createdAt);
        if (parsed === null) {
          logWarn(`[VFS::PomodoroRepo] Skipping record with non-RFC3339 created_at '${createdAt}' in focus summary`);
          continue;
        }
        const date = localDateOf(parsed);
        const key = dayNumber(date);
        let bucket = buckets.get(key);
        if (bucket === undefined) {
          bucket = { date, focus: 0, completed: 0, interrupted: 0 };
          buckets.set(key, bucket);
        }
        bucket.focus += Math.max(0, actualDuration);
        if (status === 'completed') bucket.completed += 1;
        else if (status === 'interrupted') bucket.interrupted += 1;
      }
      const daily: PomodoroFocusDay[] = [...buckets.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, bucket]) => ({
          date: formatDate(bucket.date),
          focusSeconds: bucket.focus,
          completedCount: bucket.completed,
          interruptedCount: bucket.interrupted,
        }));

      return {
        todoItemId,
        ...(todoTitle === undefined ? {} : { todoTitle }),
        totalFocusSeconds,
        completedCount,
        interruptedCount,
        ...(firstFocusAt === undefined ? {} : { firstFocusAt }),
        ...(lastFocusAt === undefined ? {} : { lastFocusAt }),
        daily,
      };
    });
  }
}
