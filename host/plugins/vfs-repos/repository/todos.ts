import { logError, logWarn } from './logger.ts';
import { nanoid } from 'nanoid';
import type { Row, SqlExecutor, SqlValue } from '../../../platform/storage/api.ts';
import {
  VfsRepositoryError, type CreateTodoItemParams, type CreateTodoListParams, type TagCountEntry,
  type TodoActiveSummary, type TodoBatchIdsResult, type TodoBatchItemsResult, type TodoCountsSnapshot,
  type TodoDailyCompletionStat, type TodoItem, type TodoItemWithChildStats, type TodoList,
  type TodoListCount, type TodoListDistributionStat, type TodoPriorityDistributionStat,
  type TodoRepository, type TodoStatsOverview, type TodoSummaryItem, type TodoTagDistributionStat,
  type TodoTrashCounts, type UpdateTodoItemParams, type UpdateTodoListParams,
} from '../api.ts';
import { databaseResult } from './errors.ts';
import { listAllTags, listItemsWithChildStats, statsOverview } from './todo-queries.ts';
import {
  DOMAIN_NOUN,
  TODO_ITEM_COLUMNS,
  TODO_LIST_COLUMNS,
  compact,
  conflict,
  domainNounLower,
  escapeLikePattern,
  invalidArgument,
  invalidOperation,
  jsonArray,
  mapSkippingErrors,
  notFound,
  optionalString,
  readI64,
  readText,
  rowToSummaryItem,
  rowToTodoItem,
  rowToTodoList,
  sanitizeBatchIds,
  todoConflict,
  validateRecurrence,
  validateTodoPriority,
  validateTodoStatus,
  withSavepoint,
} from './todo-utils.ts';
import {
  computeNextDueDate, diffDays, formatDate, freshUpdatedAt, fromUtcMidnight, localDate,
  localDateStartUtcString, localDateString, localTodayUtcBounds, normalizeOptionalStr, nowUtcString,
  parseDate, parseRepeatRule, parseTimestampMillis, shiftReminder, toUtcMidnight, validateDueDate, validateDueTime,
  validateReminder, validateRepeatJson, type LocalDate, type TodoRepeatRule,
} from './todos-helpers.ts';

export class TodoRepo implements TodoRepository {
  createTodoList(conn: SqlExecutor, params: CreateTodoListParams): TodoList {
    return databaseResult(() => {
      const finalTitle = params.title.trim() === '' ? '收件箱' : params.title;
      const listId = `tdl_${nanoid10()}`;
      const now = nowUtcString();
      let nextSort = 0;
      try {
        nextSort = conn.pluck<number>('SELECT COALESCE(MAX(sort_order), -1) + 1 FROM todo_lists WHERE deleted_at IS NULL') ?? 0;
      } catch (error) {
        logWarn('[VFS::TodoRepo] sort_order lookup failed:', error);
        nextSort = 0;
      }
      conn.run(`INSERT INTO todo_lists (id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)`, [
        listId, finalTitle, optionalString(params.description), optionalString(params.icon), optionalString(params.color),
        nextSort, params.isDefault === true ? 1 : 0, now, now,
      ]);
      return compact<TodoList>({
        id: listId, title: finalTitle,
        description: optionalString(params.description) ?? undefined,
        icon: optionalString(params.icon) ?? undefined,
        color: optionalString(params.color) ?? undefined,
        sortOrder: nextSort, isDefault: params.isDefault === true, isFavorite: false,
        createdAt: now, updatedAt: now,
      });
    });
  }

  getTodoList(conn: SqlExecutor, id: string): TodoList | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${TODO_LIST_COLUMNS} FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL`, [id]);
      return row === undefined ? null : rowToTodoList(row);
    });
  }

  listTodoLists(conn: SqlExecutor): TodoList[] {
    return databaseResult(() => mapSkippingErrors(
      conn.all(`SELECT ${TODO_LIST_COLUMNS} FROM todo_lists WHERE deleted_at IS NULL
        ORDER BY is_default DESC, sort_order ASC, updated_at DESC`), rowToTodoList));
  }

  updateTodoList(conn: SqlExecutor, id: string, params: UpdateTodoListParams): TodoList {
    return databaseResult(() => {
      const current = this.getTodoList(conn, id);
      if (current === null) throw notFound('TodoList', id);
      const now = nowUtcString();
      const finalTitle = params.title ?? current.title;
      const finalDescription = params.description != null ? normalizeOptionalStr(params.description) : (current.description ?? null);
      const finalIcon = params.icon != null ? normalizeOptionalStr(params.icon) : (current.icon ?? null);
      const finalColor = params.color != null ? normalizeOptionalStr(params.color) : (current.color ?? null);
      const affected = conn.run(`UPDATE todo_lists
        SET title = ?1, description = ?2, icon = ?3, color = ?4, updated_at = ?5,
            local_version = COALESCE(local_version, 0) + 1
        WHERE id = ?6 AND deleted_at IS NULL`,
      [finalTitle, finalDescription, finalIcon, finalColor, now, id]).changes;
      if (affected === 0) throw notFound('TodoList', id);
      return compact<TodoList>({
        id, title: finalTitle,
        description: finalDescription ?? undefined, icon: finalIcon ?? undefined, color: finalColor ?? undefined,
        sortOrder: current.sortOrder, isDefault: current.isDefault, isFavorite: current.isFavorite,
        createdAt: current.createdAt, updatedAt: now,
      });
    });
  }

  updateTodoListIfVersion(conn: SqlExecutor, id: string, params: UpdateTodoListParams, expectedUpdatedAt: string): [TodoList, TodoList] {
    return databaseResult(() => {
      if (expectedUpdatedAt.trim() === '') throw invalidArgument('expected_updated_at', 'expected_updated_at must not be empty');
      if (params.title != null && params.title.trim() === '') throw invalidArgument('title', `${DOMAIN_NOUN} list title cannot be empty`);
      const previous = this.getTodoList(conn, id);
      if (previous === null) throw notFound('TodoList', id);
      const now = freshUpdatedAt(expectedUpdatedAt);
      const affected = conn.run(`UPDATE todo_lists
        SET title = COALESCE(?1, title), description = COALESCE(?2, description),
            icon = COALESCE(?3, icon), color = COALESCE(?4, color), updated_at = ?5,
            local_version = COALESCE(local_version, 0) + 1
        WHERE id = ?6 AND deleted_at IS NULL AND updated_at = ?7`,
      [optionalString(params.title), optionalString(params.description), optionalString(params.icon),
        optionalString(params.color), now, id, expectedUpdatedAt]).changes;
      if (affected === 0) {
        const actual = conn.pluck<string | null>('SELECT updated_at FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL', [id]);
        if (actual != null) throw todoConflict(expectedUpdatedAt, actual, 'todo_lists.conflict');
        throw notFound('TodoList', id);
      }
      const current = this.getTodoList(conn, id);
      if (current === null) throw notFound('TodoList', id);
      return [previous, current];
    });
  }

  deleteTodoList(conn: SqlExecutor, id: string): void {
    databaseResult(() => withSavepoint(conn, 'delete_todo_list', () => {
      const now = nowUtcString();
      const isDefault = conn.pluck<number>('SELECT is_default FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL', [id]);
      if (isDefault != null && isDefault !== 0) {
        throw invalidOperation('delete_default_todo_list', 'Cannot delete the default inbox list');
      }
      const affected = conn.run(`UPDATE todo_lists SET deleted_at = ?1, updated_at = ?2,
        local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3 AND deleted_at IS NULL`, [now, now, id]).changes;
      if (affected === 0) {
        const exists = conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM todo_lists WHERE id = ?1)', [id]);
        if (exists === 1) return;
        throw notFound('TodoList', id);
      }
      conn.run(`UPDATE todo_items SET deleted_at = ?1, updated_at = ?2,
        local_version = COALESCE(local_version, 0) + 1 WHERE todo_list_id = ?3 AND deleted_at IS NULL`, [now, now, id]);
    }));
  }

  deleteTodoListIfVersion(conn: SqlExecutor, id: string, expectedUpdatedAt: string): TodoList {
    return databaseResult(() => {
      if (expectedUpdatedAt.trim() === '') throw invalidArgument('expected_updated_at', 'expected_updated_at must not be empty');
      return withSavepoint(conn, 'delete_todo_list_occ', () => {
        const row = conn.get(`SELECT ${TODO_LIST_COLUMNS} FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL`, [id]);
        if (row === undefined) throw notFound('TodoList', id);
        const previous = rowToTodoList(row);
        if (previous.isDefault) throw invalidOperation('delete_default_todo_list', 'Cannot delete the default inbox list');
        const now = freshUpdatedAt(expectedUpdatedAt);
        const affected = conn.run(`UPDATE todo_lists
          SET deleted_at = ?1, updated_at = ?1, local_version = COALESCE(local_version, 0) + 1
          WHERE id = ?2 AND deleted_at IS NULL AND is_default = 0 AND updated_at = ?3`,
        [now, id, expectedUpdatedAt]).changes;
        if (affected === 0) {
          const actual = conn.pluck<string | null>('SELECT updated_at FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL', [id]);
          if (actual != null) throw todoConflict(expectedUpdatedAt, actual, 'todo_lists.conflict');
          throw notFound('TodoList', id);
        }
        conn.run(`UPDATE todo_items SET deleted_at = ?1, updated_at = ?1,
          local_version = COALESCE(local_version, 0) + 1 WHERE todo_list_id = ?2 AND deleted_at IS NULL`, [now, id]);
        return previous;
      });
    });
  }

  restoreTodoList(conn: SqlExecutor, id: string): TodoList {
    return databaseResult(() => {
      conn.exec('SAVEPOINT restore_todo_list');
      try {
        const now = nowUtcString();
        const batch = conn.pluck<string | null>('SELECT deleted_at FROM todo_lists WHERE id = ?1 AND deleted_at IS NOT NULL', [id]);
        if (batch == null) throw notFound('TodoList (deleted)', id);
        conn.run(`UPDATE todo_lists SET deleted_at = NULL, updated_at = ?1,
          local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2`, [now, id]);
        conn.run(`UPDATE todo_items SET deleted_at = NULL, updated_at = ?1,
          local_version = COALESCE(local_version, 0) + 1 WHERE todo_list_id = ?2 AND deleted_at = ?3`, [now, id, batch]);
      } catch (error) {
        try { conn.exec('ROLLBACK TO SAVEPOINT restore_todo_list'); } catch (ignored) { logWarn('[VFS::TodoRepo] Ignoring transaction cleanup failure:', ignored); }
        try { conn.exec('RELEASE SAVEPOINT restore_todo_list'); } catch (ignored) { logWarn('[VFS::TodoRepo] Ignoring transaction cleanup failure:', ignored); }
        throw error;
      }
      conn.exec('RELEASE SAVEPOINT restore_todo_list');
      const restored = this.getTodoList(conn, id);
      if (restored === null) throw notFound('TodoList', id);
      return restored;
    });
  }

  toggleTodoListFavorite(conn: SqlExecutor, id: string): TodoList {
    return databaseResult(() => {
      const current = this.getTodoList(conn, id);
      if (current === null) throw notFound('TodoList', id);
      const newFavorite = !current.isFavorite;
      const now = nowUtcString();
      const affected = conn.run(`UPDATE todo_lists SET is_favorite = ?1, updated_at = ?2,
        local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3 AND deleted_at IS NULL`,
      [newFavorite ? 1 : 0, now, id]).changes;
      if (affected === 0) throw notFound('TodoList', id);
      return { ...current, isFavorite: newFavorite, updatedAt: now };
    });
  }

  reorderTodoLists(conn: SqlExecutor, listIds: readonly string[]): void {
    databaseResult(() => {
      const maxUpdated = conn.pluck<string | null>('SELECT MAX(updated_at) FROM todo_lists WHERE deleted_at IS NULL');
      const now = freshUpdatedAt(maxUpdated ?? '');
      withSavepoint(conn, 'reorder_todo_lists', () => {
        const inputIds = new Set(listIds);
        if (inputIds.size !== listIds.length) {
          throw invalidArgument('list_ids', 'list_ids must not contain duplicates');
        }
        const actualIds = new Set(conn.all<{ id: string }>('SELECT id FROM todo_lists WHERE deleted_at IS NULL').map(row => row.id));
        if (actualIds.size !== inputIds.size || ![...actualIds].every(id => inputIds.has(id))) {
          throw invalidArgument('list_ids', 'list_ids must exactly match every non-deleted ' + domainNounLower + ' list');
        }
        for (let index = 0; index < listIds.length; index++) {
          conn.run(`UPDATE todo_lists SET sort_order = ?1, updated_at = ?2,
            local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3 AND deleted_at IS NULL`,
          [index, now, listIds[index]!]);
        }
      });
    });
  }

  ensureDefaultInbox(conn: SqlExecutor, title?: string | null): TodoList {
    return databaseResult(() => {
      const findInbox = () => {
        const row = conn.get(`SELECT ${TODO_LIST_COLUMNS} FROM todo_lists WHERE is_default = 1 AND deleted_at IS NULL`);
        return row === undefined ? null : rowToTodoList(row);
      };
      const existing = findInbox();
      if (existing !== null) return existing;
      conn.exec('BEGIN IMMEDIATE');
      try {
        const inTransaction = findInbox();
        if (inTransaction !== null) {
          conn.exec('COMMIT');
          return inTransaction;
        }
        const trimmed = title == null ? '' : title.trim();
        const inboxTitle = trimmed === '' ? '收件箱' : trimmed;
        const created = this.createTodoList(conn, {
          title: inboxTitle, description: null, icon: 'inbox', color: null, isDefault: true,
        });
        conn.exec('COMMIT');
        return created;
      } catch (error) {
        try { conn.exec('ROLLBACK'); } catch (ignored) { logWarn('[VFS::TodoRepo] Ignoring transaction cleanup failure:', ignored); }
        throw error;
      }
    });
  }

  listDeletedTodoLists(conn: SqlExecutor, limit: number, offset: number): TodoList[] {
    return databaseResult(() => conn.all(`SELECT ${TODO_LIST_COLUMNS} FROM todo_lists
      WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC, id ASC LIMIT ?1 OFFSET ?2`, [limit, offset])
      .map(rowToTodoList));
  }

  countDeletedTodoLists(conn: SqlExecutor): number {
    return databaseResult(() => Math.max(0, conn.pluck<number>('SELECT COUNT(*) FROM todo_lists WHERE deleted_at IS NOT NULL') ?? 0));
  }

  purgeTodoList(conn: SqlExecutor, id: string): void {
    databaseResult(() => {
      conn.exec('BEGIN IMMEDIATE');
      try {
        const isDeleted = conn.pluck<number>('SELECT deleted_at IS NOT NULL FROM todo_lists WHERE id = ?1', [id]);
        if (isDeleted == null) throw notFound('TodoList', id);
        if (isDeleted === 0) throw invalidOperation('purge_todo_list', 'Cannot purge a list that is not in trash');
        this.purgeTodoListInner(conn, id);
        conn.exec('COMMIT');
      } catch (error) {
        try { conn.exec('ROLLBACK'); } catch (ignored) { logWarn('[VFS::TodoRepo] Ignoring transaction cleanup failure:', ignored); }
        throw error;
      }
    });
  }

  purgeDeletedTodoLists(conn: SqlExecutor): number {
    return databaseResult(() => {
      const ids = conn.all<{ id: string }>('SELECT id FROM todo_lists WHERE deleted_at IS NOT NULL').map(row => row.id);
      const count = ids.length;
      if (count === 0) return 0;
      conn.exec('BEGIN IMMEDIATE');
      try {
        for (const id of ids) this.purgeTodoListInner(conn, id);
        conn.exec('COMMIT');
        return count;
      } catch (error) {
        try { conn.exec('ROLLBACK'); } catch (ignored) { logWarn('[VFS::TodoRepo] Ignoring transaction cleanup failure:', ignored); }
        throw error;
      }
    });
  }

  private purgeTodoListInner(conn: SqlExecutor, id: string): void {
    conn.run('DELETE FROM todo_items WHERE todo_list_id = ?1', [id]);
    conn.run('DELETE FROM todo_lists WHERE id = ?1', [id]);
  }

  createTodoItem(conn: SqlExecutor, params: CreateTodoItemParams): TodoItem {
    return databaseResult(() => {
      const finalTitle = params.title.trim();
      if (finalTitle === '') throw invalidArgument('title', `${DOMAIN_NOUN} item title cannot be empty`);
      const priority = params.priority ?? 'none';
      validateTodoPriority(priority);
      const normalizedDueDate = validateDueDate(normalizeOptionalStr(params.dueDate));
      const normalizedDueTime = validateDueTime(normalizeOptionalStr(params.dueTime));
      const normalizedRepeatJson = normalizeOptionalStr(params.repeatJson);
      validateRepeatJson(normalizedRepeatJson);
      const listExists = conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL)', [params.todoListId]);
      if (listExists !== 1) throw notFound('TodoList', params.todoListId);
      const parentId = normalizeOptionalStr(params.parentId);
      if (parentId !== null) {
        const parentListId = conn.pluck<string | null>('SELECT todo_list_id FROM todo_items WHERE id = ?1 AND deleted_at IS NULL', [parentId]);
        if (parentListId == null) throw notFound('TodoItem (parent)', parentId);
        if (parentListId !== params.todoListId) {
          throw invalidOperation('create_todo_item', `Parent item belongs to list '${parentListId}', expected '${params.todoListId}'`);
        }
      }
      const itemId = `ti_${nanoid10()}`;
      const now = nowUtcString();
      const tagsJson = jsonArray(params.tags);
      const attachmentsJson = jsonArray(params.attachments);
      let maxSort = -1;
      try {
        maxSort = conn.pluck<number>(
          'SELECT COALESCE(MAX(sort_order), -1) FROM todo_items WHERE todo_list_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL',
          [params.todoListId, parentId]) ?? -1;
      } catch (error) {
        logWarn('[VFS::TodoRepo] item sort_order lookup failed:', error);
        maxSort = -1;
      }
      const normalizedReminder = validateReminder(normalizeOptionalStr(params.reminder));
      withSavepoint(conn, 'create_todo_item', () => {
        conn.run(`INSERT INTO todo_items (id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
          tags_json, sort_order, parent_id, repeat_json, attachments_json, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`, [
          itemId, params.todoListId, finalTitle, normalizeOptionalStr(params.description), priority,
          normalizedDueDate, normalizedDueTime, normalizedReminder, tagsJson, maxSort + 1, parentId,
          normalizedRepeatJson, attachmentsJson, now, now,
        ]);
        conn.run(`UPDATE todo_lists SET updated_at = ?1,
          local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2`, [now, params.todoListId]);
      });
      return compact<TodoItem>({
        id: itemId, todoListId: params.todoListId, title: finalTitle,
        description: normalizeOptionalStr(params.description) ?? undefined,
        status: 'pending', priority,
        dueDate: normalizedDueDate ?? undefined, dueTime: normalizedDueTime ?? undefined,
        reminder: normalizedReminder ?? undefined, tagsJson, sortOrder: maxSort + 1,
        parentId: parentId ?? undefined, repeatJson: normalizedRepeatJson ?? undefined,
        attachmentsJson, estimatedPomodoros: 0, completedPomodoros: 0,
        createdAt: now, updatedAt: now,
      });
    });
  }

  getTodoItem(conn: SqlExecutor, id: string): TodoItem | null {
    return databaseResult(() => {
      const row = conn.get(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items WHERE id = ?1 AND deleted_at IS NULL`, [id]);
      return row === undefined ? null : rowToTodoItem(row);
    });
  }

  listItemsByList(conn: SqlExecutor, listId: string, includeCompleted: boolean, limit?: number | null, offset?: number | null): TodoItem[] {
    return databaseResult(() => {
      const sql = includeCompleted
        ? `SELECT ${TODO_ITEM_COLUMNS} FROM todo_items WHERE todo_list_id = ?1 AND deleted_at IS NULL
           ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 WHEN 'cancelled' THEN 2 END,
             sort_order ASC, created_at ASC LIMIT ?2 OFFSET ?3`
        : `SELECT ${TODO_ITEM_COLUMNS} FROM todo_items WHERE todo_list_id = ?1 AND deleted_at IS NULL AND status = 'pending'
           ORDER BY sort_order ASC, created_at ASC LIMIT ?2 OFFSET ?3`;
      return mapSkippingErrors(conn.all(sql, [listId, limit == null ? -1 : limit, offset ?? 0]), rowToTodoItem);
    });
  }

  updateTodoItem(conn: SqlExecutor, id: string, params: UpdateTodoItemParams): TodoItem {
    return databaseResult(() => this.updateTodoItemEx(conn, id, params)[0]);
  }

  private updateTodoItemEx(conn: SqlExecutor, id: string, params: UpdateTodoItemParams): [TodoItem, string | null] {
    const current = this.getTodoItem(conn, id);
    if (current === null) throw notFound('TodoItem', id);
    const expectedRevision = params.expectedUpdatedAt ?? null;
    if (expectedRevision !== null && expectedRevision !== '' && expectedRevision !== current.updatedAt) {
      throw todoConflict(expectedRevision, current.updatedAt, 'todo_items.conflict');
    }
    const now = freshUpdatedAt(current.updatedAt);
    const finalTitle = params.title ?? current.title;
    if (finalTitle.trim() === '') throw invalidArgument('title', `${DOMAIN_NOUN} item title cannot be empty`);
    const finalDescription = params.description != null
      ? normalizeOptionalStr(params.description) : (current.description ?? null);
    const finalStatus = params.status ?? current.status;
    const finalPriority = params.priority ?? current.priority;
    validateTodoStatus(finalStatus);
    validateTodoPriority(finalPriority);
    let finalDueDate = params.dueDate != null
      ? validateDueDate(normalizeOptionalStr(params.dueDate)) : (current.dueDate ?? null);
    let finalDueTime = params.dueTime != null
      ? validateDueTime(normalizeOptionalStr(params.dueTime)) : (current.dueTime ?? null);
    if (finalDueDate === null) finalDueTime = null;
    const finalReminder = params.reminder != null
      ? validateReminder(normalizeOptionalStr(params.reminder)) : (current.reminder ?? null);
    const finalTagsJson = params.tags != null ? jsonArray(params.tags) : current.tagsJson;
    let finalParentId: string | null;
    if (params.parentId != null) {
      const trimmed = params.parentId.trim();
      if (trimmed === '') {
        finalParentId = null;
      } else {
        if (trimmed === id) throw invalidOperation('update_todo_item', 'Cannot set parent_id to self');
        const parentListId = conn.pluck<string | null>('SELECT todo_list_id FROM todo_items WHERE id = ?1 AND deleted_at IS NULL', [trimmed]);
        if (parentListId == null) throw notFound('TodoItem (parent)', trimmed);
        if (parentListId !== current.todoListId) {
          throw invalidOperation('update_todo_item', `Parent item belongs to list '${parentListId}', expected '${current.todoListId}'`);
        }
        const createsCycle = conn.pluck<number>(`WITH RECURSIVE descendants(id, depth) AS (
            SELECT id, 1 FROM todo_items WHERE parent_id = ?1
            UNION ALL
            SELECT ti.id, d.depth + 1 FROM todo_items ti
            JOIN descendants d ON ti.parent_id = d.id
            WHERE d.depth < 100
          ) SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)`, [id, trimmed]);
        if (createsCycle === 1) throw invalidOperation('update_todo_item', 'Cannot set parent_id to a descendant item');
        finalParentId = trimmed;
      }
    } else {
      finalParentId = current.parentId ?? null;
    }
    const finalAttachmentsJson = params.attachments != null ? jsonArray(params.attachments) : current.attachmentsJson;
    const repeatExplicitlySet = params.repeatJson != null;
    const finalRepeatJson = repeatExplicitlySet
      ? normalizeOptionalStr(params.repeatJson) : (current.repeatJson ?? null);
    if (repeatExplicitlySet) validateRepeatJson(finalRepeatJson);
    if (params.dueDate != null && current.dueDate != null
      && finalRepeatJson !== null && finalDueDate === null) {
      throw invalidArgument('due_date', 'A recurring task must have a due date; clear repeat_json first');
    }
    const finalEstimatedPomodoros = params.estimatedPomodoros != null
      ? Math.max(0, Math.min(999, params.estimatedPomodoros)) : (current.estimatedPomodoros ?? null);
    let finalCompletedAt: string | null;
    if (finalStatus === 'completed' && current.status !== 'completed') finalCompletedAt = now;
    else if (finalStatus !== 'completed') finalCompletedAt = null;
    else finalCompletedAt = current.completedAt ?? null;

    const updated = withSavepoint(conn, 'update_todo_item', () => {
      const affected = conn.run(`UPDATE todo_items
        SET title = ?1, description = ?2, status = ?3, priority = ?4, due_date = ?5, due_time = ?6,
            reminder = ?7, tags_json = ?8, parent_id = ?9, completed_at = ?10, repeat_json = ?11,
            attachments_json = ?12, updated_at = ?13, estimated_pomodoros = ?15,
            local_version = COALESCE(local_version, 0) + 1
        WHERE id = ?14 AND deleted_at IS NULL AND (?16 IS NULL OR ?16 = '' OR updated_at = ?16)`, [
        finalTitle, finalDescription, finalStatus, finalPriority, finalDueDate, finalDueTime,
        finalReminder, finalTagsJson, finalParentId, finalCompletedAt, finalRepeatJson,
        finalAttachmentsJson, now, id, finalEstimatedPomodoros, expectedRevision,
      ]).changes;
      if (affected === 0) {
        const actual = conn.pluck<string | null>('SELECT updated_at FROM todo_items WHERE id = ?1 AND deleted_at IS NULL', [id]);
        if (actual != null) throw todoConflict(expectedRevision ?? '', actual, 'todo_items.conflict');
        throw notFound('TodoItem', id);
      }
      conn.run(`UPDATE todo_lists SET updated_at = ?1,
        local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2`, [now, current.todoListId]);
      const item = compact<TodoItem>({
        id, todoListId: current.todoListId, title: finalTitle,
        description: finalDescription ?? undefined, status: finalStatus, priority: finalPriority,
        dueDate: finalDueDate ?? undefined, dueTime: finalDueTime ?? undefined,
        reminder: finalReminder ?? undefined, tagsJson: finalTagsJson, sortOrder: current.sortOrder,
        parentId: finalParentId ?? undefined, completedAt: finalCompletedAt ?? undefined,
        repeatJson: finalRepeatJson ?? undefined, attachmentsJson: finalAttachmentsJson,
        estimatedPomodoros: finalEstimatedPomodoros ?? undefined,
        completedPomodoros: current.completedPomodoros,
        createdAt: current.createdAt, updatedAt: now,
      });
      const wasCompletedNow = finalStatus === 'completed' && current.status !== 'completed';
      let spawnedId: string | null = null;
      if (wasCompletedNow) {
        try { spawnedId = this.spawnNextRecurrence(conn, item); }
        catch (error) {
          logError(`[VFS::TodoRepo] Failed to spawn next recurrence for ${id} (title='${item.title}', repeat_json=${item.repeatJson}, due_date=${item.dueDate}):`, error);
        }
      }
      return [item, spawnedId] as [TodoItem, string | null];
    });
    return updated;
  }

  private spawnNextRecurrence(conn: SqlExecutor, completed: TodoItem): string | null {
    const recurrence = validateRecurrence(completed);
    if (recurrence === null) return null;
    const nextString = formatDate(recurrence.next);
    const duplicate = conn.pluck<number>(`SELECT EXISTS(
      SELECT 1 FROM todo_items
      WHERE todo_list_id = ?1 AND parent_id IS ?2 AND title = ?3
        AND due_date = ?4 AND repeat_json = ?5
        AND status = 'pending' AND deleted_at IS NULL)`, [
      completed.todoListId, completed.parentId ?? null, completed.title, nextString, recurrence.repeatJson,
    ]);
    if (duplicate === 1) return null;
    const itemId = `ti_${nanoid10()}`;
    const now = nowUtcString();
    let maxSort = -1;
    try {
      maxSort = conn.pluck<number>(
        'SELECT COALESCE(MAX(sort_order), -1) FROM todo_items WHERE todo_list_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL',
        [completed.todoListId, completed.parentId ?? null]) ?? -1;
    } catch (error) {
      logWarn('[VFS::TodoRepo] recurrence sort_order lookup failed:', error);
      maxSort = -1;
    }
    const nextReminder = completed.reminder === undefined
      ? null : shiftReminder(completed.reminder, recurrence.due, recurrence.next);
    conn.run(`INSERT INTO todo_items (id, todo_list_id, title, description, status, priority, due_date, due_time,
        reminder, tags_json, sort_order, parent_id, repeat_json, attachments_json, estimated_pomodoros, created_at, updated_at)
      VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)`, [
      itemId, completed.todoListId, completed.title, completed.description ?? null, completed.priority,
      nextString, completed.dueTime ?? null, nextReminder, completed.tagsJson, maxSort + 1,
      completed.parentId ?? null, recurrence.repeatJson, completed.attachmentsJson,
      completed.estimatedPomodoros ?? null, now, now,
    ]);
    conn.run(`UPDATE todo_lists SET updated_at = ?1,
      local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2`, [now, completed.todoListId]);
    return itemId;
  }

  toggleTodoItem(conn: SqlExecutor, id: string, expectedUpdatedAt?: string | null): TodoItem {
    return databaseResult(() => {
      const current = this.getTodoItem(conn, id);
      if (current === null) throw notFound('TodoItem', id);
      const newStatus = current.status === 'completed' ? 'pending' : 'completed';
      return this.updateTodoItem(conn, id, { status: newStatus, expectedUpdatedAt: expectedUpdatedAt ?? null });
    });
  }

  deleteTodoItem(conn: SqlExecutor, id: string): void {
    databaseResult(() => {
      const now = nowUtcString();
      withSavepoint(conn, 'delete_todo_item', () => {
        const listId = conn.pluck<string | null>('SELECT todo_list_id FROM todo_items WHERE id = ?1 AND deleted_at IS NULL', [id]);
        const affected = conn.run(`UPDATE todo_items SET deleted_at = ?1, updated_at = ?2,
          local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3 AND deleted_at IS NULL`, [now, now, id]).changes;
        if (affected === 0) {
          const exists = conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM todo_items WHERE id = ?1)', [id]);
          if (exists !== 1) throw notFound('TodoItem', id);
        }
        conn.run(`WITH RECURSIVE descendants(id, depth) AS (
            SELECT id, 1 FROM todo_items WHERE parent_id = ?3 AND deleted_at IS NULL
            UNION ALL
            SELECT ti.id, d.depth + 1 FROM todo_items ti
            JOIN descendants d ON ti.parent_id = d.id
            WHERE ti.deleted_at IS NULL AND d.depth < 100
          )
          UPDATE todo_items SET deleted_at = ?1, updated_at = ?2,
            local_version = COALESCE(local_version, 0) + 1
          WHERE id IN (SELECT id FROM descendants)`, [now, now, id]);
        if (listId != null) {
          conn.run(`UPDATE todo_lists SET updated_at = ?1,
            local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2`, [now, listId]);
        }
      });
    });
  }

  deleteTodoItemIfVersion(conn: SqlExecutor, id: string, expectedUpdatedAt: string): TodoItem {
    return databaseResult(() => {
      if (expectedUpdatedAt.trim() === '') throw invalidArgument('expected_updated_at', 'expected_updated_at must not be empty');
      return withSavepoint(conn, 'delete_todo_item_occ', () => {
        const previous = this.getTodoItem(conn, id);
        if (previous === null) throw notFound('TodoItem', id);
        const now = freshUpdatedAt(expectedUpdatedAt);
        const affected = conn.run(`UPDATE todo_items SET deleted_at = ?1, updated_at = ?1,
          local_version = COALESCE(local_version, 0) + 1
          WHERE id = ?2 AND deleted_at IS NULL AND updated_at = ?3`, [now, id, expectedUpdatedAt]).changes;
        if (affected === 0) {
          const actual = conn.pluck<string | null>('SELECT updated_at FROM todo_items WHERE id = ?1 AND deleted_at IS NULL', [id]);
          if (actual != null) throw todoConflict(expectedUpdatedAt, actual, 'todo_items.conflict');
          throw notFound('TodoItem', id);
        }
        conn.run(`WITH RECURSIVE descendants(id, depth) AS (
            SELECT id, 1 FROM todo_items WHERE parent_id = ?2 AND deleted_at IS NULL
            UNION ALL
            SELECT ti.id, d.depth + 1 FROM todo_items ti
            JOIN descendants d ON ti.parent_id = d.id
            WHERE ti.deleted_at IS NULL AND d.depth < 100
          )
          UPDATE todo_items SET deleted_at = ?1, updated_at = ?1,
            local_version = COALESCE(local_version, 0) + 1
          WHERE id IN (SELECT id FROM descendants)`, [now, id]);
        conn.run(`UPDATE todo_lists SET updated_at = ?1,
          local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2`, [now, previous.todoListId]);
        return previous;
      });
    });
  }

  restoreTodoItem(conn: SqlExecutor, id: string): TodoItem {
    return databaseResult(() => {
      const now = nowUtcString();
      conn.exec('SAVEPOINT restore_todo_item');
      try {
        const row = conn.get('SELECT todo_list_id, deleted_at, parent_id FROM todo_items WHERE id = ?1', [id]);
        if (row === undefined) throw notFound('TodoItem', id);
        const listId = readText(row, 'todo_list_id', 0, false);
        const deletedAt = readText(row, 'deleted_at', 1, true);
        const parentId = readText(row, 'parent_id', 2, true);
        if (deletedAt === null) {
          conn.exec('RELEASE SAVEPOINT restore_todo_item');
          const item = this.getTodoItem(conn, id);
          if (item === null) throw notFound('TodoItem', id);
          return item;
        }
        const listAlive = conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL)', [listId]);
        if (listAlive !== 1) throw invalidOperation('restore_todo_item', 'Cannot restore item: its list is deleted');
        if (parentId !== null) {
          const parentAlive = conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM todo_items WHERE id = ?1 AND deleted_at IS NULL)', [parentId]);
          if (parentAlive !== 1) conn.run('UPDATE todo_items SET parent_id = NULL WHERE id = ?1', [id]);
        }
        conn.run(`WITH RECURSIVE descendants(id, depth) AS (
            SELECT id, 1 FROM todo_items WHERE id = ?2
            UNION ALL
            SELECT ti.id, d.depth + 1 FROM todo_items ti
            JOIN descendants d ON ti.parent_id = d.id
            WHERE ti.deleted_at = ?3 AND d.depth < 100
          )
          UPDATE todo_items SET deleted_at = NULL, updated_at = ?1,
            local_version = COALESCE(local_version, 0) + 1
          WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?3`, [now, id, deletedAt]);
        conn.run(`UPDATE todo_lists SET updated_at = ?1,
          local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2`, [now, listId]);
      } catch (error) {
        try { conn.exec('ROLLBACK TO SAVEPOINT restore_todo_item'); } catch (ignored) { logWarn('[VFS::TodoRepo] Ignoring transaction cleanup failure:', ignored); }
        try { conn.exec('RELEASE SAVEPOINT restore_todo_item'); } catch (ignored) { logWarn('[VFS::TodoRepo] Ignoring transaction cleanup failure:', ignored); }
        throw error;
      }
      conn.exec('RELEASE SAVEPOINT restore_todo_item');
      const restored = this.getTodoItem(conn, id);
      if (restored === null) throw notFound('TodoItem', id);
      return restored;
    });
  }

  reorderItems(conn: SqlExecutor, listId: string, itemIds: readonly string[], expectedUpdatedAt?: string | null): void {
    databaseResult(() => {
      const expected = expectedUpdatedAt != null && expectedUpdatedAt !== '' ? expectedUpdatedAt : null;
      const now = expected === null ? nowUtcString() : freshUpdatedAt(expected);
      withSavepoint(conn, 'reorder_todo_items', () => {
        if (expected !== null) {
          const affected = conn.run(`UPDATE todo_lists SET updated_at = ?1,
            local_version = COALESCE(local_version, 0) + 1
            WHERE id = ?2 AND deleted_at IS NULL AND updated_at = ?3`, [now, listId, expected]).changes;
          if (affected === 0) {
            const actual = conn.pluck<string | null>('SELECT updated_at FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL', [listId]);
            if (actual != null) throw todoConflict(expected, actual, 'todo_lists.conflict');
            throw notFound('TodoList', listId);
          }
        }
        const inputIds = new Set(itemIds);
        if (inputIds.size !== itemIds.length) throw invalidArgument('item_ids', 'item_ids must not contain duplicates');
        const actualIds = new Set(conn.all<{ id: string }>(
          'SELECT id FROM todo_items WHERE todo_list_id = ?1 AND deleted_at IS NULL', [listId]).map(row => row.id));
        if (actualIds.size !== inputIds.size || ![...actualIds].every(id => inputIds.has(id))) {
          throw invalidArgument('item_ids', 'item_ids must exactly match every non-deleted item in the target list');
        }
        for (let index = 0; index < itemIds.length; index++) {
          conn.run(`UPDATE todo_items SET sort_order = ?1, updated_at = ?2,
            local_version = COALESCE(local_version, 0) + 1
            WHERE id = ?3 AND todo_list_id = ?4 AND deleted_at IS NULL`, [index, now, itemIds[index]!, listId]);
        }
        if (expected === null) {
          const affected = conn.run(`UPDATE todo_lists SET updated_at = ?1,
            local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2 AND deleted_at IS NULL`, [now, listId]).changes;
          if (affected === 0) throw notFound('TodoList', listId);
        }
      });
    });
  }

  moveTodoItem(conn: SqlExecutor, id: string, targetListId: string): TodoItem {
    return databaseResult(() => {
      const current = this.getTodoItem(conn, id);
      if (current === null) throw notFound('TodoItem', id);
      const targetExists = conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL)', [targetListId]);
      if (targetExists !== 1) throw notFound('TodoList', targetListId);
      const now = freshUpdatedAt(current.updatedAt);
      const sourceListId = current.todoListId;
      conn.exec('SAVEPOINT move_todo_item');
      try {
        let maxSort = -1;
        try {
          maxSort = conn.pluck<number>(`SELECT COALESCE(MAX(sort_order), -1) FROM todo_items
            WHERE todo_list_id = ?1 AND parent_id IS NULL AND deleted_at IS NULL`, [targetListId]) ?? -1;
        } catch (error) {
          logWarn('[VFS::TodoRepo] move sort_order lookup failed:', error);
          maxSort = -1;
        }
        const descendantIds = conn.all<{ id: string }>(`WITH RECURSIVE descendants(id, depth) AS (
            SELECT id, 1 FROM todo_items WHERE parent_id = ?1
            UNION ALL
            SELECT ti.id, d.depth + 1 FROM todo_items ti
            JOIN descendants d ON ti.parent_id = d.id
            WHERE d.depth < 100
          ) SELECT id FROM descendants ORDER BY depth ASC`, [id]).map(row => row.id);
        const affected = conn.run(`UPDATE todo_items
          SET todo_list_id = ?1, parent_id = NULL, sort_order = ?2, updated_at = ?3,
              local_version = COALESCE(local_version, 0) + 1
          WHERE id = ?4 AND deleted_at IS NULL`, [targetListId, maxSort + 1, now, id]).changes;
        if (affected === 0) throw notFound('TodoItem', id);
        for (const descendantId of descendantIds) {
          conn.run(`UPDATE todo_items SET todo_list_id = ?1, updated_at = ?2,
            local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3`, [targetListId, now, descendantId]);
        }
        conn.run(`UPDATE todo_lists SET updated_at = ?1,
          local_version = COALESCE(local_version, 0) + 1 WHERE id IN (?2, ?3) AND deleted_at IS NULL`,
        [now, sourceListId, targetListId]);
      } catch (error) {
        try { conn.exec('ROLLBACK TO SAVEPOINT move_todo_item'); } catch (ignored) { logWarn('[VFS::TodoRepo] Ignoring transaction cleanup failure:', ignored); }
        try { conn.exec('RELEASE SAVEPOINT move_todo_item'); } catch (ignored) { logWarn('[VFS::TodoRepo] Ignoring transaction cleanup failure:', ignored); }
        throw error;
      }
      conn.exec('RELEASE SAVEPOINT move_todo_item');
      const moved = this.getTodoItem(conn, id);
      if (moved === null) throw notFound('TodoItem', id);
      return moved;
    });
  }

  listTodayItems(conn: SqlExecutor, includeCompleted: boolean, limit?: number | null, offset?: number | null): TodoItem[] {
    return databaseResult(() => {
      const today = localDateString();
      const sql = includeCompleted
        ? `SELECT ${TODO_ITEM_COLUMNS} FROM todo_items
           WHERE ((status = 'pending' AND due_date <= ?1) OR (status = 'completed' AND due_date = ?1))
             AND deleted_at IS NULL
           ORDER BY CASE status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
             due_date ASC,
             CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
             due_time ASC NULLS LAST, sort_order ASC LIMIT ?2 OFFSET ?3`
        : `SELECT ${TODO_ITEM_COLUMNS} FROM todo_items
           WHERE status = 'pending' AND due_date <= ?1 AND deleted_at IS NULL
           ORDER BY due_date ASC,
             CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
             due_time ASC NULLS LAST, sort_order ASC LIMIT ?2 OFFSET ?3`;
      return mapSkippingErrors(conn.all(sql, [today, limit == null ? -1 : limit, offset ?? 0]), rowToTodoItem);
    });
  }

  listOverdueItems(conn: SqlExecutor, includeCompleted: boolean, limit?: number | null, offset?: number | null): TodoItem[] {
    return databaseResult(() => {
      const today = localDateString();
      const sql = includeCompleted
        ? `SELECT ${TODO_ITEM_COLUMNS} FROM todo_items
           WHERE due_date < ?1 AND status IN ('pending', 'completed') AND deleted_at IS NULL
           ORDER BY due_date ASC,
             CASE status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
             CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
           LIMIT ?2 OFFSET ?3`
        : `SELECT ${TODO_ITEM_COLUMNS} FROM todo_items
           WHERE due_date < ?1 AND status = 'pending' AND deleted_at IS NULL
           ORDER BY due_date ASC,
             CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
           LIMIT ?2 OFFSET ?3`;
      return mapSkippingErrors(conn.all(sql, [today, limit == null ? -1 : limit, offset ?? 0]), rowToTodoItem);
    });
  }

  listAllPendingItems(conn: SqlExecutor): TodoItem[] {
    return databaseResult(() => mapSkippingErrors(conn.all(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items
      WHERE status = 'pending' AND deleted_at IS NULL
      ORDER BY CASE WHEN due_date IS NULL THEN 1 ELSE 0 END, due_date ASC,
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`),
    rowToTodoItem));
  }

  listReminderItems(conn: SqlExecutor): TodoItem[] {
    return databaseResult(() => mapSkippingErrors(conn.all(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items
      WHERE reminder IS NOT NULL AND reminder != '' AND status = 'pending' AND deleted_at IS NULL
      ORDER BY reminder ASC`), rowToTodoItem));
  }

  listUpcomingItems(conn: SqlExecutor, days: number, includeCompleted: boolean): TodoItem[] {
    return databaseResult(() => {
      const today = localDateString();
      const endDate = localDateString(new Date(Date.now() + days * 86_400_000));
      const sql = includeCompleted
        ? `SELECT ${TODO_ITEM_COLUMNS} FROM todo_items
           WHERE due_date > ?1 AND due_date <= ?2 AND status IN ('pending', 'completed') AND deleted_at IS NULL
           ORDER BY due_date ASC,
             CASE status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
             CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`
        : `SELECT ${TODO_ITEM_COLUMNS} FROM todo_items
           WHERE due_date > ?1 AND due_date <= ?2 AND status = 'pending' AND deleted_at IS NULL
           ORDER BY due_date ASC,
             CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`;
      return mapSkippingErrors(conn.all(sql, [today, endDate]), rowToTodoItem);
    });
  }

  listCompletedItems(conn: SqlExecutor, listId?: string | null): TodoItem[] {
    return databaseResult(() => {
      const sql = listId != null
        ? `SELECT ${TODO_ITEM_COLUMNS} FROM todo_items WHERE todo_list_id = ?1 AND status = 'completed' AND deleted_at IS NULL
           ORDER BY completed_at DESC NULLS LAST, updated_at DESC`
        : `SELECT ${TODO_ITEM_COLUMNS} FROM todo_items WHERE status = 'completed' AND deleted_at IS NULL
           ORDER BY completed_at DESC NULLS LAST, updated_at DESC`;
      return mapSkippingErrors(conn.all(sql, listId != null ? [listId] : []), rowToTodoItem);
    });
  }

  searchItems(conn: SqlExecutor, query: string): TodoItem[] {
    return databaseResult(() => {
      const likePattern = `%${escapeLikePattern(query.trim())}%`;
      return mapSkippingErrors(conn.all(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items
        WHERE (title LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\') AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT 50`, [likePattern]), rowToTodoItem);
    });
  }

  searchItemsPaginated(conn: SqlExecutor, query: string, limit: number, offset: number): [TodoItem[], number] {
    return databaseResult(() => {
      const likePattern = `%${escapeLikePattern(query.trim())}%`;
      const total = conn.pluck<number>(`SELECT COUNT(*) FROM todo_items
        WHERE (title LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\') AND deleted_at IS NULL`, [likePattern]) ?? 0;
      const items = mapSkippingErrors(conn.all(`SELECT ${TODO_ITEM_COLUMNS} FROM todo_items
        WHERE (title LIKE ?1 ESCAPE '\\' OR description LIKE ?1 ESCAPE '\\') AND deleted_at IS NULL
        ORDER BY updated_at DESC LIMIT ?2 OFFSET ?3`, [likePattern, limit, offset]), rowToTodoItem);
      return [items, Math.max(0, total)];
    });
  }

  countsSnapshot(conn: SqlExecutor): TodoCountsSnapshot {
    return databaseResult(() => {
      const today = localDateString();
      const upcomingEnd = localDateString(new Date(Date.now() + 7 * 86_400_000));
      const todayCount = conn.pluck<number>(
        "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND due_date <= ?1 AND deleted_at IS NULL", [today]) ?? 0;
      const upcomingCount = conn.pluck<number>(
        "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND due_date > ?1 AND due_date <= ?2 AND deleted_at IS NULL",
        [today, upcomingEnd]) ?? 0;
      const inboxCount = conn.pluck<number>(`SELECT COUNT(*) FROM todo_items ti
        JOIN todo_lists tl ON tl.id = ti.todo_list_id
        WHERE tl.is_default = 1 AND tl.deleted_at IS NULL
          AND ti.status = 'pending' AND ti.deleted_at IS NULL`) ?? 0;
      const allPendingCount = conn.pluck<number>(
        "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND deleted_at IS NULL") ?? 0;
      const perList = mapSkippingErrors(conn.all<Row>(`SELECT tl.id, COUNT(ti.id) AS pending_count FROM todo_lists tl
        LEFT JOIN todo_items ti ON ti.todo_list_id = tl.id AND ti.status = 'pending' AND ti.deleted_at IS NULL
        WHERE tl.deleted_at IS NULL GROUP BY tl.id
        ORDER BY tl.is_default DESC, tl.sort_order ASC, tl.updated_at DESC`), row => ({
        listId: readText(row, 'id', 0, false),
        pendingCount: readI64(row, 'pending_count', 1),
      } satisfies TodoListCount));
      return { todayCount, upcomingCount, inboxCount, allPendingCount, perList };
    });
  }

  getActiveTodoSummary(conn: SqlExecutor): TodoActiveSummary | null {
    return databaseResult(() => {
      const today = localDateString();
      const upcomingEnd = localDateString(new Date(Date.now() + 3 * 86_400_000));
      const hasLists = conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM todo_lists WHERE deleted_at IS NULL)');
      if (hasLists !== 1) return null;
      const querySummary = (sql: string, params: readonly SqlValue[]): TodoSummaryItem[] =>
        mapSkippingErrors(conn.all(sql, params), rowToSummaryItem);
      const todayItems = querySummary(`SELECT ti.id, ti.title, ti.priority, ti.due_date, ti.due_time, tl.title AS list_title
        FROM todo_items ti JOIN todo_lists tl ON ti.todo_list_id = tl.id
        WHERE ti.due_date = ?1 AND ti.status = 'pending' AND ti.deleted_at IS NULL AND tl.deleted_at IS NULL
        ORDER BY CASE ti.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
        LIMIT 5`, [today]);
      const overdueItems = querySummary(`SELECT ti.id, ti.title, ti.priority, ti.due_date, ti.due_time, tl.title AS list_title
        FROM todo_items ti JOIN todo_lists tl ON ti.todo_list_id = tl.id
        WHERE ti.due_date < ?1 AND ti.status = 'pending' AND ti.deleted_at IS NULL AND tl.deleted_at IS NULL
        ORDER BY ti.due_date DESC LIMIT 3`, [today]);
      const upcomingHighPriority = querySummary(`SELECT ti.id, ti.title, ti.priority, ti.due_date, ti.due_time, tl.title AS list_title
        FROM todo_items ti JOIN todo_lists tl ON ti.todo_list_id = tl.id
        WHERE ti.due_date > ?1 AND ti.due_date <= ?2 AND ti.status = 'pending'
          AND ti.priority IN ('urgent', 'high') AND ti.deleted_at IS NULL AND tl.deleted_at IS NULL
        ORDER BY ti.due_date ASC LIMIT 3`, [today, upcomingEnd]);
      const countOrZero = (sql: string, params: readonly SqlValue[] = []): number => {
        try { return conn.pluck<number>(sql, params) ?? 0; }
        catch (error) { logWarn('[VFS::TodoRepo] summary count failed:', error); return 0; }
      };
      const totalPending = countOrZero("SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND deleted_at IS NULL");
      const todayDue = countOrZero("SELECT COUNT(*) FROM todo_items WHERE due_date = ?1 AND status = 'pending' AND deleted_at IS NULL", [today]);
      const overdueCount = countOrZero("SELECT COUNT(*) FROM todo_items WHERE due_date < ?1 AND status = 'pending' AND deleted_at IS NULL", [today]);
      const [todayStartUtc, todayEndUtc] = localTodayUtcBounds();
      const todayCompleted = countOrZero(`SELECT COUNT(*) FROM todo_items
        WHERE completed_at >= ?1 AND completed_at < ?2 AND status = 'completed' AND deleted_at IS NULL`,
      [todayStartUtc, todayEndUtc]);
      if (totalPending === 0 && todayCompleted === 0) return null;
      return {
        todayItems, overdueItems, upcomingHighPriority,
        stats: { totalPending, todayDue, overdueCount, todayCompleted },
      };
    });
  }

  formatActiveSummaryForPrompt(summary: TodoActiveSummary): string {
    const lines: string[] = [];
    if (summary.overdueItems.length > 0) {
      lines.push('【已过期未完成】');
      for (const item of summary.overdueItems) {
        const priorityMark = item.priority === 'urgent' || item.priority === 'high' ? '!' : ' ';
        const dateInfo = item.dueDate === null ? '' : ` (过期: ${item.dueDate})`;
        lines.push(`- [${priorityMark}] ${item.title}${dateInfo} [${item.listTitle}]`);
      }
    }
    if (summary.todayItems.length > 0) {
      lines.push('【今日待办】');
      for (const item of summary.todayItems) {
        const priorityMark = item.priority === 'urgent' || item.priority === 'high' ? '!' : ' ';
        const timeInfo = item.dueTime === null ? '' : ` 截止 ${item.dueTime}`;
        lines.push(`- [${priorityMark}] ${item.title}${timeInfo} [${item.listTitle}]`);
      }
    }
    if (summary.upcomingHighPriority.length > 0) {
      lines.push('【即将到期（高优先级）】');
      for (const item of summary.upcomingHighPriority) {
        const dateInfo = item.dueDate === null ? '' : ` (${item.dueDate})`;
        lines.push(`- [!] ${item.title}${dateInfo} [${item.listTitle}]`);
      }
    }
    lines.push(`统计：未完成 ${summary.stats.totalPending} 项，今日到期 ${summary.stats.todayDue} 项，已过期 ${summary.stats.overdueCount} 项，今日已完成 ${summary.stats.todayCompleted} 项`);
    return lines.join('\n');
  }

  listDeletedTodoItems(conn: SqlExecutor, limit: number, offset: number): TodoItem[] {
    return databaseResult(() => conn.all(`SELECT ti.id, ti.todo_list_id, ti.title, ti.description, ti.status, ti.priority,
      ti.due_date, ti.due_time, ti.reminder, ti.tags_json, ti.sort_order, ti.parent_id, ti.completed_at, ti.repeat_json,
      ti.attachments_json, ti.estimated_pomodoros, ti.completed_pomodoros, ti.created_at, ti.updated_at, ti.deleted_at
      FROM todo_items ti
      WHERE ti.deleted_at IS NOT NULL
        AND (ti.parent_id IS NULL OR EXISTS(SELECT 1 FROM todo_items p WHERE p.id = ti.parent_id AND p.deleted_at IS NULL))
        AND EXISTS(SELECT 1 FROM todo_lists l WHERE l.id = ti.todo_list_id AND l.deleted_at IS NULL)
      ORDER BY ti.deleted_at DESC, ti.id ASC LIMIT ?1 OFFSET ?2`, [limit, offset]).map(rowToTodoItem));
  }

  countDeletedTodoItems(conn: SqlExecutor): number {
    return databaseResult(() => Math.max(0, conn.pluck<number>(`SELECT COUNT(*) FROM todo_items ti
      WHERE ti.deleted_at IS NOT NULL
        AND (ti.parent_id IS NULL OR EXISTS(SELECT 1 FROM todo_items p WHERE p.id = ti.parent_id AND p.deleted_at IS NULL))
        AND EXISTS(SELECT 1 FROM todo_lists l WHERE l.id = ti.todo_list_id AND l.deleted_at IS NULL)`) ?? 0));
  }

  purgeTodoItem(conn: SqlExecutor, id: string): void {
    databaseResult(() => withSavepoint(conn, 'purge_todo_item', () => {
      const isDeleted = conn.pluck<number>('SELECT deleted_at IS NOT NULL FROM todo_items WHERE id = ?1', [id]);
      if (isDeleted == null) throw notFound('TodoItem', id);
      if (isDeleted === 0) throw invalidOperation('purge_todo_item', 'Cannot purge an item that is not in trash');
      conn.run(`WITH RECURSIVE descendants(id, depth) AS (
          SELECT id, 1 FROM todo_items WHERE parent_id = ?1
          UNION ALL
          SELECT ti.id, d.depth + 1 FROM todo_items ti
          JOIN descendants d ON ti.parent_id = d.id
          WHERE d.depth < 100
        ) DELETE FROM todo_items WHERE id IN (SELECT id FROM descendants) OR id = ?1`, [id]);
    }));
  }

  purgeDeletedTodoItems(conn: SqlExecutor): number {
    return databaseResult(() => conn.run(`DELETE FROM todo_items
      WHERE deleted_at IS NOT NULL
        AND EXISTS(SELECT 1 FROM todo_lists l WHERE l.id = todo_items.todo_list_id AND l.deleted_at IS NULL)`).changes);
  }

  trashCounts(conn: SqlExecutor): TodoTrashCounts {
    return databaseResult(() => ({
      deletedItems: this.countDeletedTodoItems(conn),
      deletedLists: this.countDeletedTodoLists(conn),
    }));
  }

  batchCompleteItems(conn: SqlExecutor, itemIds: readonly string[]): [TodoBatchItemsResult, string[]] {
    return databaseResult(() => {
      const ids = sanitizeBatchIds(itemIds, 'item_ids');
      if (ids.length === 0) return [{ items: [], skippedIds: [] }, []];
      return withSavepoint(conn, 'todo_batch_complete', () => {
        const items: TodoItem[] = [];
        const skippedIds: string[] = [];
        const eventIds: string[] = [];
        for (const id of ids) {
          const current = this.getTodoItem(conn, id);
          if (current === null) { skippedIds.push(id); continue; }
          if (current.status === 'completed') { items.push(current); continue; }
          try {
            const [updated, spawnedId] = this.updateTodoItemEx(conn, id, { status: 'completed' });
            eventIds.push(updated.id);
            items.push(updated);
            if (spawnedId !== null) eventIds.push(spawnedId);
          } catch (error) {
            if (error instanceof VfsRepositoryError && error.code === 'VFS_NOT_FOUND') { skippedIds.push(id); continue; }
            throw error;
          }
        }
        return [{ items, skippedIds }, eventIds];
      });
    });
  }

  batchRescheduleItems(conn: SqlExecutor, itemIds: readonly string[], dueDate?: string | null, dueTime?: string | null): TodoBatchItemsResult {
    return databaseResult(() => {
      validateDueDate(normalizeOptionalStr(dueDate));
      validateDueTime(normalizeOptionalStr(dueTime));
      const ids = sanitizeBatchIds(itemIds, 'item_ids');
      if (ids.length === 0) return { items: [], skippedIds: [] };
      return withSavepoint(conn, 'todo_batch_reschedule', () => {
        const items: TodoItem[] = [];
        const skippedIds: string[] = [];
        for (const id of ids) {
          try {
            items.push(this.updateTodoItem(conn, id, { dueDate: dueDate ?? '', dueTime: dueTime ?? null }));
          } catch (error) {
            if (error instanceof VfsRepositoryError && error.code === 'VFS_NOT_FOUND') { skippedIds.push(id); continue; }
            throw error;
          }
        }
        return { items, skippedIds };
      });
    });
  }

  batchSetPriorityItems(conn: SqlExecutor, itemIds: readonly string[], priority: string): TodoBatchItemsResult {
    return databaseResult(() => {
      validateTodoPriority(priority);
      const ids = sanitizeBatchIds(itemIds, 'item_ids');
      if (ids.length === 0) return { items: [], skippedIds: [] };
      return withSavepoint(conn, 'todo_batch_set_priority', () => {
        const items: TodoItem[] = [];
        const skippedIds: string[] = [];
        for (const id of ids) {
          try { items.push(this.updateTodoItem(conn, id, { priority })); }
          catch (error) {
            if (error instanceof VfsRepositoryError && error.code === 'VFS_NOT_FOUND') { skippedIds.push(id); continue; }
            throw error;
          }
        }
        return { items, skippedIds };
      });
    });
  }

  batchMoveItems(conn: SqlExecutor, itemIds: readonly string[], targetListId: string): TodoBatchItemsResult {
    return databaseResult(() => {
      const ids = sanitizeBatchIds(itemIds, 'item_ids');
      if (ids.length === 0) return { items: [], skippedIds: [] };
      const targetExists = conn.pluck<number>('SELECT EXISTS(SELECT 1 FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL)', [targetListId]);
      if (targetExists !== 1) throw notFound('TodoList', targetListId);
      return withSavepoint(conn, 'todo_batch_move', () => {
        const idSet = new Set(ids);
        const skipSet = new Set<string>();
        for (const id of ids) {
          const ancestors = conn.all<{ id: string }>(`WITH RECURSIVE ancestors(id, depth) AS (
              SELECT parent_id, 1 FROM todo_items WHERE id = ?1 AND parent_id IS NOT NULL
              UNION ALL
              SELECT ti.parent_id, a.depth + 1 FROM todo_items ti
              JOIN ancestors a ON ti.id = a.id
              WHERE ti.parent_id IS NOT NULL AND a.depth < 100
            ) SELECT id FROM ancestors`, [id]).map(row => row.id);
          if (ancestors.some(ancestor => idSet.has(ancestor))) skipSet.add(id);
        }
        const items: TodoItem[] = [];
        const skippedIds: string[] = [];
        for (const id of ids) {
          if (skipSet.has(id)) { skippedIds.push(id); continue; }
          try { items.push(this.moveTodoItem(conn, id, targetListId)); }
          catch (error) {
            if (error instanceof VfsRepositoryError && error.code === 'VFS_NOT_FOUND'
              && error.data?.resourceType === 'TodoItem') { skippedIds.push(id); continue; }
            throw error;
          }
        }
        return { items, skippedIds };
      });
    });
  }

  batchDeleteItems(conn: SqlExecutor, itemIds: readonly string[]): TodoBatchIdsResult {
    return databaseResult(() => {
      const ids = sanitizeBatchIds(itemIds, 'item_ids');
      if (ids.length === 0) return { affectedIds: [], skippedIds: [] };
      return withSavepoint(conn, 'todo_batch_delete', () => {
        const affectedIds: string[] = [];
        const skippedIds: string[] = [];
        for (const id of ids) {
          try { this.deleteTodoItem(conn, id); affectedIds.push(id); }
          catch (error) {
            if (error instanceof VfsRepositoryError && error.code === 'VFS_NOT_FOUND') { skippedIds.push(id); continue; }
            throw error;
          }
        }
        return { affectedIds, skippedIds };
      });
    });
  }

  batchRestoreItems(conn: SqlExecutor, itemIds: readonly string[]): TodoBatchItemsResult {
    return databaseResult(() => {
      const ids = sanitizeBatchIds(itemIds, 'item_ids');
      if (ids.length === 0) return { items: [], skippedIds: [] };
      return withSavepoint(conn, 'todo_batch_restore', () => {
        const items: TodoItem[] = [];
        const skippedIds: string[] = [];
        for (const id of ids) {
          try { items.push(this.restoreTodoItem(conn, id)); }
          catch (error) {
            if (error instanceof VfsRepositoryError
              && (error.code === 'VFS_NOT_FOUND' || error.code === 'VFS_INVALID_OPERATION')) { skippedIds.push(id); continue; }
            throw error;
          }
        }
        return { items, skippedIds };
      });
    });
  }

  batchPurgeItems(conn: SqlExecutor, itemIds: readonly string[]): TodoBatchIdsResult {
    return databaseResult(() => {
      const ids = sanitizeBatchIds(itemIds, 'item_ids');
      if (ids.length === 0) return { affectedIds: [], skippedIds: [] };
      return withSavepoint(conn, 'todo_batch_purge', () => {
        const affectedIds: string[] = [];
        const skippedIds: string[] = [];
        for (const id of ids) {
          try { this.purgeTodoItem(conn, id); affectedIds.push(id); }
          catch (error) {
            if (error instanceof VfsRepositoryError
              && (error.code === 'VFS_NOT_FOUND' || error.code === 'VFS_INVALID_OPERATION')) { skippedIds.push(id); continue; }
            throw error;
          }
        }
        return { affectedIds, skippedIds };
      });
    });
  }

  statsOverview(conn: SqlExecutor, daysInput: number): TodoStatsOverview {
    return statsOverview(conn, daysInput);
  }

  listAllTags(conn: SqlExecutor): TagCountEntry[] {
    return listAllTags(conn);
  }

  listItemsWithChildStats(conn: SqlExecutor, listId: string, includeCompleted: boolean, limit?: number | null, offset?: number | null): TodoItemWithChildStats[] {
    return listItemsWithChildStats(conn, listId, includeCompleted, limit, offset);
  }
}

function nanoid10(): string {
  // Lazy import would break sync; nanoid is a pure ESM function usable synchronously.
  return nanoid(10);
}
