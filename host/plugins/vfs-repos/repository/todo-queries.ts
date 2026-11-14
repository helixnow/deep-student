/** Read-only statistics and aggregate queries for todo_repo.rs. */
import { logWarn } from './logger.ts';
import type { Row, SqlExecutor } from '../../../platform/storage/api.ts';
import {
  type TagCountEntry, type TodoDailyCompletionStat, type TodoItemWithChildStats,
  type TodoListDistributionStat, type TodoPriorityDistributionStat, type TodoStatsOverview,
  type TodoTagDistributionStat,
} from '../api.ts';
import { databaseResult } from './errors.ts';
import { mapSkippingErrors, readI64, readText, rowToTodoItem } from './todo-utils.ts';
import {
  diffDays, formatDate, fromUtcMidnight, localDate, localDateStartUtcString,
  localTodayUtcBounds, parseTimestampMillis, toUtcMidnight,
} from './todos-helpers.ts';

export function statsOverview(conn: SqlExecutor, daysInput: number): TodoStatsOverview {
  return databaseResult(() => {
    const days = Math.max(1, Math.min(366, Math.trunc(daysInput)));
    const today = localDate();
    const todayString = formatDate(today);
    const rangeStart = fromUtcMidnight(toUtcMidnight(today) - (days - 1) * 86_400_000);
    const rangeStartUtc = localDateStartUtcString(rangeStart);
    const [todayStartUtc, todayEndUtc] = localTodayUtcBounds();
    const totalPending = conn.pluck<number>("SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND deleted_at IS NULL") ?? 0;
    const totalCompleted = conn.pluck<number>("SELECT COUNT(*) FROM todo_items WHERE status = 'completed' AND deleted_at IS NULL") ?? 0;
    const completedToday = conn.pluck<number>(`SELECT COUNT(*) FROM todo_items
      WHERE status = 'completed' AND deleted_at IS NULL AND completed_at >= ?1 AND completed_at < ?2`,
    [todayStartUtc, todayEndUtc]) ?? 0;
    const overdueCount = conn.pluck<number>(
      "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND due_date < ?1 AND deleted_at IS NULL", [todayString]) ?? 0;
    const completionTrend: TodoDailyCompletionStat[] = [];
    for (let index = 0; index < days; index++) {
      completionTrend.push({
        date: formatDate(fromUtcMidnight(toUtcMidnight(rangeStart) + index * 86_400_000)),
        completedCount: 0, createdCount: 0,
      });
    }
    const bucketIndex = (timestamp: string): number | null => {
      const millis = parseTimestampMillis(timestamp);
      if (millis === null) {
        logWarn(`[VFS::TodoRepo] Skipping non-RFC3339 timestamp '${timestamp}' in stats overview`);
        return null;
      }
      const index = diffDays(localDate(new Date(millis)), rangeStart);
      return index >= 0 && index < days ? index : null;
    };
    const completedTimestamps = mapSkippingErrors(conn.all<Row>(`SELECT completed_at FROM todo_items
      WHERE status = 'completed' AND deleted_at IS NULL AND completed_at >= ?1`, [rangeStartUtc]), row => readText(row, 'completed_at', 0, false));
    for (const timestamp of completedTimestamps) {
      const index = bucketIndex(timestamp);
      if (index !== null) completionTrend[index]!.completedCount++;
    }
    const createdTimestamps = mapSkippingErrors(conn.all<Row>(`SELECT created_at FROM todo_items
      WHERE deleted_at IS NULL AND created_at >= ?1`, [rangeStartUtc]), row => readText(row, 'created_at', 0, false));
    for (const timestamp of createdTimestamps) {
      const index = bucketIndex(timestamp);
      if (index !== null) completionTrend[index]!.createdCount++;
    }
    const byList = mapSkippingErrors(conn.all<Row>(`SELECT tl.id, tl.title,
        COALESCE(SUM(CASE WHEN ti.status = 'pending' THEN 1 ELSE 0 END), 0) AS pending_count,
        COALESCE(SUM(CASE WHEN ti.status = 'completed' THEN 1 ELSE 0 END), 0) AS completed_count
      FROM todo_lists tl
      LEFT JOIN todo_items ti ON ti.todo_list_id = tl.id AND ti.deleted_at IS NULL
      WHERE tl.deleted_at IS NULL GROUP BY tl.id
      ORDER BY tl.is_default DESC, tl.sort_order ASC, tl.updated_at DESC`), row => ({
      listId: readText(row, 'id', 0, false),
      listTitle: readText(row, 'title', 1, false),
      pendingCount: readI64(row, 'pending_count', 2),
      completedCount: readI64(row, 'completed_count', 3),
    } satisfies TodoListDistributionStat));
    const rawPriorities = mapSkippingErrors(conn.all<Row>(
      "SELECT priority, COUNT(*) AS pending_count FROM todo_items WHERE status = 'pending' AND deleted_at IS NULL GROUP BY priority"),
    row => ({ priority: readText(row, 'priority', 0, false), count: readI64(row, 'pending_count', 1) }));
    const byPriority: TodoPriorityDistributionStat[] = ['urgent', 'high', 'medium', 'low', 'none'].map(priority => ({
      priority,
      pendingCount: rawPriorities.find(entry => entry.priority === priority)?.count ?? 0,
    }));
    const tagRows = mapSkippingErrors(conn.all<Row>(`SELECT tags_json, status FROM todo_items
      WHERE deleted_at IS NULL AND status IN ('pending', 'completed')
        AND tags_json IS NOT NULL AND tags_json != '' AND tags_json != '[]'`), row => ({
      tagsJson: readText(row, 'tags_json', 0, false), status: readText(row, 'status', 1, false),
    }));
    const tagMap = new Map<string, { pending: number; completed: number }>();
    for (const row of tagRows) {
      let tags: unknown;
      try { tags = JSON.parse(row.tagsJson); }
      catch { continue; }
      if (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) continue;
      const seen = new Set<string>();
      for (const rawTag of tags as string[]) {
        const tag = rawTag.trim();
        if (tag === '' || seen.has(tag)) continue;
        seen.add(tag);
        const entry = tagMap.get(tag) ?? { pending: 0, completed: 0 };
        if (row.status === 'pending') entry.pending++;
        else if (row.status === 'completed') entry.completed++;
        tagMap.set(tag, entry);
      }
    }
    const byTag: TodoTagDistributionStat[] = [...tagMap.entries()]
      .map(([tag, counts]) => ({ tag, pendingCount: counts.pending, completedCount: counts.completed }))
      .sort((a, b) => (b.pendingCount + b.completedCount) - (a.pendingCount + a.completedCount) || a.tag.localeCompare(b.tag))
      .slice(0, 100);
    return { totalPending, totalCompleted, completedToday, overdueCount, completionTrend, byList, byPriority, byTag };
  });
}

export function listAllTags(conn: SqlExecutor): TagCountEntry[] {
  return databaseResult(() => {
    const rows = mapSkippingErrors(conn.all<Row>(`SELECT ti.tags_json FROM todo_items ti
      WHERE ti.deleted_at IS NULL
        AND ti.tags_json IS NOT NULL AND ti.tags_json != '' AND ti.tags_json != '[]'
        AND EXISTS(SELECT 1 FROM todo_lists l WHERE l.id = ti.todo_list_id AND l.deleted_at IS NULL)`),
    row => readText(row, 'tags_json', 0, false));
    const counts = new Map<string, number>();
    for (const tagsJson of rows) {
      let tags: unknown;
      try { tags = JSON.parse(tagsJson); }
      catch { continue; }
      if (!Array.isArray(tags) || !tags.every(tag => typeof tag === 'string')) continue;
      const seen = new Set<string>();
      for (const rawTag of tags as string[]) {
        const tag = rawTag.trim();
        if (tag === '' || seen.has(tag)) continue;
        seen.add(tag);
        counts.set(tag, (counts.get(tag) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  });
}

export function listItemsWithChildStats(conn: SqlExecutor, listId: string, includeCompleted: boolean, limit?: number | null, offset?: number | null): TodoItemWithChildStats[] {
  return databaseResult(() => {
    const select = `SELECT ti.id, ti.todo_list_id, ti.title, ti.description, ti.status, ti.priority, ti.due_date,
      ti.due_time, ti.reminder, ti.tags_json, ti.sort_order, ti.parent_id, ti.completed_at, ti.repeat_json,
      ti.attachments_json, ti.estimated_pomodoros, ti.completed_pomodoros, ti.created_at, ti.updated_at, ti.deleted_at,
      COALESCE(cs.total, 0) AS subtask_count, COALESCE(cs.done, 0) AS completed_subtask_count
      FROM todo_items ti
      LEFT JOIN (SELECT parent_id, COUNT(*) AS total,
          SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS done
        FROM todo_items WHERE deleted_at IS NULL AND parent_id IS NOT NULL GROUP BY parent_id) cs ON cs.parent_id = ti.id`;
    const sql = includeCompleted
      ? `${select} WHERE ti.todo_list_id = ?1 AND ti.deleted_at IS NULL
         ORDER BY CASE ti.status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 WHEN 'cancelled' THEN 2 END,
           ti.sort_order ASC, ti.created_at ASC LIMIT ?2 OFFSET ?3`
      : `${select} WHERE ti.todo_list_id = ?1 AND ti.deleted_at IS NULL AND ti.status = 'pending'
         ORDER BY ti.sort_order ASC, ti.created_at ASC LIMIT ?2 OFFSET ?3`;
    return mapSkippingErrors(conn.all(sql, [listId, limit == null ? -1 : limit, offset ?? 0]), row => ({
      ...rowToTodoItem(row),
      subtaskCount: readI64(row, 'subtask_count', 20),
      completedSubtaskCount: readI64(row, 'completed_subtask_count', 21),
    }));
  });
}
