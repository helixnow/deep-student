//! 待办列表 Repo
//!
//! 提供 todo_lists 和 todo_items 表的 CRUD 操作。
//! 独立于 VFS 资源系统，直接操作 todo_lists / todo_items 表。

use std::sync::Arc;

use log::{debug, info, warn};
use rusqlite::{params, Connection, OptionalExtension};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::types::{
    TodoActiveSummary, TodoStats, TodoSummaryItem, VfsCreateTodoItemParams,
    VfsCreateTodoListParams, VfsTodoItem, VfsTodoList, VfsUpdateTodoItemParams,
    VfsUpdateTodoListParams,
};

/// Normalize `Some("")` to `None` — prevents empty strings from polluting
/// date/time columns where `NULL` is the correct "unset" representation.
fn normalize_optional_str(v: Option<String>) -> Option<String> {
    v.filter(|s| !s.trim().is_empty())
}

fn log_and_skip_err<T>(r: Result<T, rusqlite::Error>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::TodoRepo] Row parse error: {}", e);
            None
        }
    }
}

/// 待办列表 Repo
pub struct VfsTodoRepo;

impl VfsTodoRepo {
    // ========================================================================
    // TodoList CRUD
    // ========================================================================

    /// 创建待办列表
    pub fn create_todo_list(
        db: &VfsDatabase,
        params: VfsCreateTodoListParams,
    ) -> VfsResult<VfsTodoList> {
        let conn = db.get_conn_safe()?;
        Self::create_todo_list_with_conn(&conn, params)
    }

    /// 创建待办列表（使用现有连接）
    pub fn create_todo_list_with_conn(
        conn: &Connection,
        params: VfsCreateTodoListParams,
    ) -> VfsResult<VfsTodoList> {
        let final_title = if params.title.trim().is_empty() {
            "收件箱".to_string()
        } else {
            params.title.clone()
        };

        let list_id = VfsTodoList::generate_id();
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            r#"
            INSERT INTO todo_lists (id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6, 0, ?7, ?8)
            "#,
            params![
                list_id,
                final_title,
                params.description,
                params.icon,
                params.color,
                params.is_default as i32,
                now,
                now,
            ],
        )?;

        info!("[TodoRepo] Created todo list: {}", list_id);

        Ok(VfsTodoList {
            id: list_id,
            title: final_title,
            description: params.description,
            icon: params.icon,
            color: params.color,
            sort_order: 0,
            is_default: params.is_default,
            is_favorite: false,
            created_at: now.clone(),
            updated_at: now,
            deleted_at: None,
        })
    }

    /// 获取待办列表
    pub fn get_todo_list(db: &VfsDatabase, list_id: &str) -> VfsResult<Option<VfsTodoList>> {
        let conn = db.get_conn_safe()?;
        Self::get_todo_list_with_conn(&conn, list_id)
    }

    /// 获取待办列表（使用现有连接）
    pub fn get_todo_list_with_conn(
        conn: &Connection,
        list_id: &str,
    ) -> VfsResult<Option<VfsTodoList>> {
        let result = conn
            .query_row(
                r#"
                SELECT id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at, deleted_at
                FROM todo_lists
                WHERE id = ?1 AND deleted_at IS NULL
                "#,
                params![list_id],
                Self::row_to_todo_list,
            )
            .optional()?;
        Ok(result)
    }

    /// 列出所有待办列表（不含软删除）
    pub fn list_todo_lists(db: &VfsDatabase) -> VfsResult<Vec<VfsTodoList>> {
        let conn = db.get_conn_safe()?;
        Self::list_todo_lists_with_conn(&conn)
    }

    /// 列出所有待办列表（使用现有连接）
    pub fn list_todo_lists_with_conn(conn: &Connection) -> VfsResult<Vec<VfsTodoList>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at, deleted_at
            FROM todo_lists
            WHERE deleted_at IS NULL
            ORDER BY is_default DESC, sort_order ASC, updated_at DESC
            "#,
        )?;

        let rows = stmt.query_map([], Self::row_to_todo_list)?;
        let lists: Vec<VfsTodoList> = rows.filter_map(log_and_skip_err).collect();
        Ok(lists)
    }

    /// 更新待办列表
    pub fn update_todo_list(
        db: &VfsDatabase,
        list_id: &str,
        params: VfsUpdateTodoListParams,
    ) -> VfsResult<VfsTodoList> {
        let conn = db.get_conn_safe()?;
        let current = Self::get_todo_list_with_conn(&conn, list_id)?.ok_or_else(|| {
            VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: list_id.to_string(),
            }
        })?;

        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let final_title = params.title.unwrap_or(current.title);
        let final_description = params.description.or(current.description);
        let final_icon = params.icon.or(current.icon);
        let final_color = params.color.or(current.color);

        conn.execute(
            r#"
            UPDATE todo_lists
            SET title = ?1, description = ?2, icon = ?3, color = ?4, updated_at = ?5
            WHERE id = ?6
            "#,
            params![final_title, final_description, final_icon, final_color, now, list_id],
        )?;

        info!("[TodoRepo] Updated todo list: {}", list_id);

        Ok(VfsTodoList {
            id: list_id.to_string(),
            title: final_title,
            description: final_description,
            icon: final_icon,
            color: final_color,
            sort_order: current.sort_order,
            is_default: current.is_default,
            is_favorite: current.is_favorite,
            created_at: current.created_at,
            updated_at: now,
            deleted_at: None,
        })
    }

    /// 软删除待办列表
    pub fn delete_todo_list(db: &VfsDatabase, list_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_todo_list_with_conn(&conn, list_id)
    }

    /// 软删除待办列表（使用现有连接，SAVEPOINT 支持嵌套）
    pub fn delete_todo_list_with_conn(conn: &Connection, list_id: &str) -> VfsResult<()> {
        conn.execute("SAVEPOINT delete_todo_list", [])?;

        let result = (|| -> VfsResult<()> {
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();

            // 检查是否为默认列表
            let is_default: bool = conn
                .query_row(
                    "SELECT is_default FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL",
                    params![list_id],
                    |row| row.get::<_, i32>(0).map(|v| v != 0),
                )
                .optional()?
                .unwrap_or(false);

            if is_default {
                return Err(VfsError::InvalidOperation {
                    operation: "delete_default_todo_list".to_string(),
                    reason: "Cannot delete the default inbox list".to_string(),
                });
            }

            let affected = conn.execute(
                "UPDATE todo_lists SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
                params![now, now, list_id],
            )?;

            if affected == 0 {
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM todo_lists WHERE id = ?1)",
                    params![list_id],
                    |row| row.get(0),
                )?;
                if exists {
                    return Ok(()); // 幂等删除
                } else {
                    return Err(VfsError::NotFound {
                        resource_type: "TodoList".to_string(),
                        id: list_id.to_string(),
                    });
                }
            }

            // 同时软删除所有待办项
            conn.execute(
                "UPDATE todo_items SET deleted_at = ?1, updated_at = ?2 WHERE todo_list_id = ?3 AND deleted_at IS NULL",
                params![now, now, list_id],
            )?;

            Ok(())
        })();

        match result {
            Ok(_) => {
                if let Err(e) = conn.execute("RELEASE SAVEPOINT delete_todo_list", []) {
                    let _ = conn.execute("ROLLBACK TO SAVEPOINT delete_todo_list", []);
                    return Err(e.into());
                }
                info!("[VFS::TodoRepo] Soft deleted todo list: {}", list_id);
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT delete_todo_list", []);
                let _ = conn.execute("RELEASE SAVEPOINT delete_todo_list", []);
                Err(e)
            }
        }
    }

    /// 恢复软删除的待办列表
    pub fn restore_todo_list(db: &VfsDatabase, list_id: &str) -> VfsResult<VfsTodoList> {
        let conn = db.get_conn_safe()?;
        Self::restore_todo_list_with_conn(&conn, list_id)
    }

    /// 恢复软删除的待办列表（使用现有连接，事务保护）
    pub fn restore_todo_list_with_conn(
        conn: &Connection,
        list_id: &str,
    ) -> VfsResult<VfsTodoList> {
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<()> {
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();

            let affected = conn.execute(
                "UPDATE todo_lists SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL",
                params![now, list_id],
            )?;

            if affected == 0 {
                return Err(VfsError::NotFound {
                    resource_type: "TodoList (deleted)".to_string(),
                    id: list_id.to_string(),
                });
            }

            // 同时恢复该列表下的所有待办项
            conn.execute(
                "UPDATE todo_items SET deleted_at = NULL, updated_at = ?1 WHERE todo_list_id = ?2 AND deleted_at IS NOT NULL",
                params![now, list_id],
            )?;

            Ok(())
        })();

        match result {
            Ok(_) => {
                if let Err(commit_err) = conn.execute("COMMIT", []) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(commit_err.into());
                }
                info!("[VFS::TodoRepo] Restored todo list: {}", list_id);
                Self::get_todo_list_with_conn(conn, list_id)?.ok_or_else(|| VfsError::NotFound {
                    resource_type: "TodoList".to_string(),
                    id: list_id.to_string(),
                })
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 切换列表收藏状态
    pub fn toggle_todo_list_favorite(
        db: &VfsDatabase,
        list_id: &str,
    ) -> VfsResult<VfsTodoList> {
        let conn = db.get_conn_safe()?;
        let current = Self::get_todo_list_with_conn(&conn, list_id)?.ok_or_else(|| {
            VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: list_id.to_string(),
            }
        })?;

        let new_favorite = !current.is_favorite;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            "UPDATE todo_lists SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_favorite as i32, now, list_id],
        )?;

        Ok(VfsTodoList {
            is_favorite: new_favorite,
            updated_at: now,
            ..current
        })
    }

    /// 确保默认收件箱列表存在（首次使用时自动创建）
    ///
    /// 使用 `BEGIN IMMEDIATE` 事务防止并发创建重复的默认收件箱。
    pub fn ensure_default_inbox(db: &VfsDatabase) -> VfsResult<VfsTodoList> {
        let conn = db.get_conn_safe()?;

        // 先快速无锁检查（大多数情况直接命中）
        let existing = conn
            .query_row(
                r#"
                SELECT id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at, deleted_at
                FROM todo_lists
                WHERE is_default = 1 AND deleted_at IS NULL
                "#,
                [],
                Self::row_to_todo_list,
            )
            .optional()?;

        if let Some(inbox) = existing {
            return Ok(inbox);
        }

        // 未找到 → 加事务锁后再次检查并创建（双重检查）
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsTodoList> {
            let existing_in_tx = conn
                .query_row(
                    r#"
                    SELECT id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at, deleted_at
                    FROM todo_lists
                    WHERE is_default = 1 AND deleted_at IS NULL
                    "#,
                    [],
                    Self::row_to_todo_list,
                )
                .optional()?;

            if let Some(inbox) = existing_in_tx {
                return Ok(inbox);
            }

            Self::create_todo_list_with_conn(
                &conn,
                VfsCreateTodoListParams {
                    title: "收件箱".to_string(),
                    description: Some("默认待办列表".to_string()),
                    icon: Some("inbox".to_string()),
                    color: None,
                    is_default: true,
                },
            )
        })();

        match result {
            Ok(list) => {
                conn.execute("COMMIT", [])?;
                Ok(list)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // TodoItem CRUD
    // ========================================================================

    /// 创建待办项
    pub fn create_todo_item(
        db: &VfsDatabase,
        params: VfsCreateTodoItemParams,
    ) -> VfsResult<VfsTodoItem> {
        let conn = db.get_conn_safe()?;
        Self::create_todo_item_with_conn(&conn, params)
    }

    /// 创建待办项（使用现有连接）
    pub fn create_todo_item_with_conn(
        conn: &Connection,
        params: VfsCreateTodoItemParams,
    ) -> VfsResult<VfsTodoItem> {
        // 验证列表存在
        let list_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL)",
            params![params.todo_list_id],
            |row| row.get(0),
        )?;
        if !list_exists {
            return Err(VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: params.todo_list_id.clone(),
            });
        }

        // 验证父任务存在（如果指定）
        if let Some(ref pid) = params.parent_id {
            let parent_exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM todo_items WHERE id = ?1 AND deleted_at IS NULL)",
                params![pid],
                |row| row.get(0),
            )?;
            if !parent_exists {
                return Err(VfsError::NotFound {
                    resource_type: "TodoItem (parent)".to_string(),
                    id: pid.clone(),
                });
            }
        }

        let item_id = VfsTodoItem::generate_id();
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let tags_json = params
            .tags
            .as_ref()
            .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".to_string()))
            .unwrap_or_else(|| "[]".to_string());

        let attachments_json = params
            .attachments
            .as_ref()
            .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "[]".to_string()))
            .unwrap_or_else(|| "[]".to_string());

        // 获取当前最大 sort_order
        let max_sort: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM todo_items WHERE todo_list_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL",
                params![params.todo_list_id, params.parent_id],
                |row| row.get(0),
            )
            .unwrap_or(-1);

        conn.execute(
            r#"
            INSERT INTO todo_items (id, todo_list_id, title, description, status, priority, due_date, due_time, tags_json, sort_order, parent_id, attachments_json, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
            "#,
            params![
                item_id,
                params.todo_list_id,
                params.title,
                params.description,
                params.priority,
                params.due_date,
                params.due_time,
                tags_json,
                max_sort + 1,
                params.parent_id,
                attachments_json,
                now,
                now,
            ],
        )?;

        // 更新列表的 updated_at
        conn.execute(
            "UPDATE todo_lists SET updated_at = ?1 WHERE id = ?2",
            params![now, params.todo_list_id],
        )?;

        info!(
            "[VFS::TodoRepo] Created todo item: {} in list {}",
            item_id, params.todo_list_id
        );

        Ok(VfsTodoItem {
            id: item_id,
            todo_list_id: params.todo_list_id,
            title: params.title,
            description: params.description,
            status: "pending".to_string(),
            priority: params.priority,
            due_date: params.due_date,
            due_time: params.due_time,
            reminder: None,
            tags_json,
            sort_order: max_sort + 1,
            parent_id: params.parent_id,
            completed_at: None,
            repeat_json: None,
            attachments_json,
            created_at: now.clone(),
            updated_at: now,
            deleted_at: None,
        })
    }

    /// 获取待办项
    pub fn get_todo_item(db: &VfsDatabase, item_id: &str) -> VfsResult<Option<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        Self::get_todo_item_with_conn(&conn, item_id)
    }

    /// 获取待办项（使用现有连接）
    pub fn get_todo_item_with_conn(
        conn: &Connection,
        item_id: &str,
    ) -> VfsResult<Option<VfsTodoItem>> {
        let result = conn
            .query_row(
                r#"
                SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                       tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, created_at, updated_at, deleted_at
                FROM todo_items
                WHERE id = ?1 AND deleted_at IS NULL
                "#,
                params![item_id],
                Self::row_to_todo_item,
            )
            .optional()?;
        Ok(result)
    }

    /// 列出列表内的待办项
    pub fn list_items_by_list(
        db: &VfsDatabase,
        list_id: &str,
        include_completed: bool,
    ) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let sql = if include_completed {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE todo_list_id = ?1 AND deleted_at IS NULL
            ORDER BY
                CASE status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 WHEN 'cancelled' THEN 2 END,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                sort_order ASC
            "#
        } else {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE todo_list_id = ?1 AND deleted_at IS NULL AND status = 'pending'
            ORDER BY
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                sort_order ASC
            "#
        };

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![list_id], Self::row_to_todo_item)?;
        let items: Vec<VfsTodoItem> = rows.filter_map(log_and_skip_err).collect();
        Ok(items)
    }

    /// 更新待办项
    pub fn update_todo_item(
        db: &VfsDatabase,
        item_id: &str,
        params: VfsUpdateTodoItemParams,
    ) -> VfsResult<VfsTodoItem> {
        let conn = db.get_conn_safe()?;
        Self::update_todo_item_with_conn(&conn, item_id, params)
    }

    /// 更新待办项（使用现有连接）
    pub fn update_todo_item_with_conn(
        conn: &Connection,
        item_id: &str,
        params: VfsUpdateTodoItemParams,
    ) -> VfsResult<VfsTodoItem> {
        let current =
            Self::get_todo_item_with_conn(conn, item_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "TodoItem".to_string(),
                id: item_id.to_string(),
            })?;

        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let final_title = params.title.unwrap_or(current.title.clone());
        let final_description = if params.description.is_some() {
            params.description
        } else {
            current.description.clone()
        };
        let final_status = params.status.unwrap_or(current.status.clone());
        let final_priority = params.priority.unwrap_or(current.priority.clone());
        // Fix: normalize empty strings to None so that clearing a date
        // does not write "" into the DB (which SQL treats as < any date).
        let final_due_date = if params.due_date.is_some() {
            normalize_optional_str(params.due_date)
        } else {
            current.due_date.clone()
        };
        let final_due_time = if params.due_time.is_some() {
            normalize_optional_str(params.due_time)
        } else {
            current.due_time.clone()
        };
        let final_reminder = if params.reminder.is_some() {
            normalize_optional_str(params.reminder)
        } else {
            current.reminder.clone()
        };
        let final_tags_json = params
            .tags
            .as_ref()
            .map(|t| serde_json::to_string(t).unwrap_or_else(|_| "[]".to_string()))
            .unwrap_or(current.tags_json.clone());
        // Fix: validate parent_id on update (existence, same list, no self-ref)
        let final_parent_id = if let Some(ref pid) = params.parent_id {
            let pid_trimmed = pid.trim();
            if pid_trimmed.is_empty() {
                None
            } else {
                if pid_trimmed == item_id {
                    return Err(VfsError::InvalidOperation {
                        operation: "update_todo_item".to_string(),
                        reason: "Cannot set parent_id to self".to_string(),
                    });
                }
                let parent_row: Option<(String,)> = conn
                    .query_row(
                        "SELECT todo_list_id FROM todo_items WHERE id = ?1 AND deleted_at IS NULL",
                        params![pid_trimmed],
                        |row| Ok((row.get::<_, String>(0)?,)),
                    )
                    .optional()?;
                match parent_row {
                    None => {
                        return Err(VfsError::NotFound {
                            resource_type: "TodoItem (parent)".to_string(),
                            id: pid_trimmed.to_string(),
                        });
                    }
                    Some((parent_list_id,)) if parent_list_id != current.todo_list_id => {
                        return Err(VfsError::InvalidOperation {
                            operation: "update_todo_item".to_string(),
                            reason: format!(
                                "Parent item belongs to list '{}', expected '{}'",
                                parent_list_id, current.todo_list_id
                            ),
                        });
                    }
                    _ => {}
                }
                Some(pid_trimmed.to_string())
            }
        } else {
            current.parent_id.clone()
        };
        let final_attachments_json = params
            .attachments
            .as_ref()
            .map(|a| serde_json::to_string(a).unwrap_or_else(|_| "[]".to_string()))
            .unwrap_or(current.attachments_json.clone());
        let final_repeat_json = if params.repeat_json.is_some() {
            params.repeat_json
        } else {
            current.repeat_json.clone()
        };

        // 处理完成时间
        let final_completed_at = if final_status == "completed" && current.status != "completed" {
            Some(now.clone())
        } else if final_status != "completed" {
            None
        } else {
            current.completed_at.clone()
        };

        conn.execute(
            r#"
            UPDATE todo_items
            SET title = ?1, description = ?2, status = ?3, priority = ?4, due_date = ?5, due_time = ?6,
                reminder = ?7, tags_json = ?8, parent_id = ?9, completed_at = ?10, repeat_json = ?11,
                attachments_json = ?12, updated_at = ?13
            WHERE id = ?14
            "#,
            params![
                final_title,
                final_description,
                final_status,
                final_priority,
                final_due_date,
                final_due_time,
                final_reminder,
                final_tags_json,
                final_parent_id,
                final_completed_at,
                final_repeat_json,
                final_attachments_json,
                now,
                item_id,
            ],
        )?;

        // 更新列表的 updated_at
        conn.execute(
            "UPDATE todo_lists SET updated_at = ?1 WHERE id = ?2",
            params![now, current.todo_list_id],
        )?;

        info!("[VFS::TodoRepo] Updated todo item: {}", item_id);

        Ok(VfsTodoItem {
            id: item_id.to_string(),
            todo_list_id: current.todo_list_id,
            title: final_title,
            description: final_description,
            status: final_status,
            priority: final_priority,
            due_date: final_due_date,
            due_time: final_due_time,
            reminder: final_reminder,
            tags_json: final_tags_json,
            sort_order: current.sort_order,
            parent_id: final_parent_id,
            completed_at: final_completed_at,
            repeat_json: final_repeat_json,
            attachments_json: final_attachments_json,
            created_at: current.created_at,
            updated_at: now,
            deleted_at: None,
        })
    }

    /// 切换待办项完成状态
    pub fn toggle_todo_item(db: &VfsDatabase, item_id: &str) -> VfsResult<VfsTodoItem> {
        let conn = db.get_conn_safe()?;
        let current =
            Self::get_todo_item_with_conn(&conn, item_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "TodoItem".to_string(),
                id: item_id.to_string(),
            })?;

        let new_status = if current.status == "completed" {
            "pending"
        } else {
            "completed"
        };

        Self::update_todo_item_with_conn(
            &conn,
            item_id,
            VfsUpdateTodoItemParams {
                status: Some(new_status.to_string()),
                ..Default::default()
            },
        )
    }

    /// 软删除待办项
    pub fn delete_todo_item(db: &VfsDatabase, item_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        // 获取 list_id 以更新列表时间
        let list_id: Option<String> = conn
            .query_row(
                "SELECT todo_list_id FROM todo_items WHERE id = ?1 AND deleted_at IS NULL",
                params![item_id],
                |row| row.get(0),
            )
            .optional()?;

        let affected = conn.execute(
            "UPDATE todo_items SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![now, now, item_id],
        )?;

        if affected == 0 {
            let exists: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM todo_items WHERE id = ?1)",
                params![item_id],
                |row| row.get(0),
            )?;
            if !exists {
                return Err(VfsError::NotFound {
                    resource_type: "TodoItem".to_string(),
                    id: item_id.to_string(),
                });
            }
            // 已删除，幂等返回
        }

        // 递归软删除所有后代子任务（使用 CTE 遍历整棵子树）
        conn.execute(
            r#"
            WITH RECURSIVE descendants(id) AS (
                SELECT id FROM todo_items WHERE parent_id = ?3 AND deleted_at IS NULL
                UNION ALL
                SELECT ti.id FROM todo_items ti
                JOIN descendants d ON ti.parent_id = d.id
                WHERE ti.deleted_at IS NULL
            )
            UPDATE todo_items SET deleted_at = ?1, updated_at = ?2
            WHERE id IN (SELECT id FROM descendants)
            "#,
            params![now, now, item_id],
        )?;

        // 更新列表时间
        if let Some(lid) = list_id {
            conn.execute(
                "UPDATE todo_lists SET updated_at = ?1 WHERE id = ?2",
                params![now, lid],
            )?;
        }

        info!("[VFS::TodoRepo] Soft deleted todo item: {}", item_id);
        Ok(())
    }

    /// 批量重排序待办项
    pub fn reorder_items(
        db: &VfsDatabase,
        list_id: &str,
        item_ids: &[String],
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        for (i, id) in item_ids.iter().enumerate() {
            conn.execute(
                "UPDATE todo_items SET sort_order = ?1, updated_at = ?2 WHERE id = ?3 AND todo_list_id = ?4",
                params![i as i32, now, id, list_id],
            )?;
        }

        conn.execute(
            "UPDATE todo_lists SET updated_at = ?1 WHERE id = ?2",
            params![now, list_id],
        )?;

        Ok(())
    }

    // ========================================================================
    // 查询方法
    // ========================================================================

    /// 获取今日到期的待办项
    pub fn list_today_items(db: &VfsDatabase) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE due_date = ?1 AND status = 'pending' AND deleted_at IS NULL
            ORDER BY
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                due_time ASC NULLS LAST,
                sort_order ASC
            "#,
        )?;

        let rows = stmt.query_map(params![today], Self::row_to_todo_item)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 获取已过期未完成的待办项
    pub fn list_overdue_items(db: &VfsDatabase) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE due_date < ?1 AND status = 'pending' AND deleted_at IS NULL
            ORDER BY due_date ASC,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
            "#,
        )?;

        let rows = stmt.query_map(params![today], Self::row_to_todo_item)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 获取即将到期的待办项（指定天数范围）
    pub fn list_upcoming_items(db: &VfsDatabase, days: i64) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let end_date = (chrono::Local::now() + chrono::Duration::days(days))
            .format("%Y-%m-%d")
            .to_string();

        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE due_date > ?1 AND due_date <= ?2 AND status = 'pending' AND deleted_at IS NULL
            ORDER BY due_date ASC,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
            "#,
        )?;

        let rows = stmt.query_map(params![today, end_date], Self::row_to_todo_item)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 搜索待办项
    pub fn search_items(db: &VfsDatabase, query: &str) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let like_pattern = format!("%{}%", query);

        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE (title LIKE ?1 OR description LIKE ?1) AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT 50
            "#,
        )?;

        let rows = stmt.query_map(params![like_pattern], Self::row_to_todo_item)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    // ========================================================================
    // System Prompt 注入：活跃待办摘要
    // ========================================================================

    /// 获取活跃待办摘要（用于注入 System Prompt）
    pub fn get_active_todo_summary(db: &VfsDatabase) -> VfsResult<Option<TodoActiveSummary>> {
        let conn = db.get_conn_safe()?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let upcoming_end = (chrono::Local::now() + chrono::Duration::days(3))
            .format("%Y-%m-%d")
            .to_string();

        // 检查是否有任何待办列表
        let has_lists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM todo_lists WHERE deleted_at IS NULL)",
            [],
            |row| row.get(0),
        )?;
        if !has_lists {
            return Ok(None);
        }

        // 今日到期（最多 5 条）
        let today_items = Self::query_summary_items(
            &conn,
            r#"
            SELECT ti.id, ti.title, ti.priority, ti.due_date, ti.due_time, tl.title
            FROM todo_items ti
            JOIN todo_lists tl ON ti.todo_list_id = tl.id
            WHERE ti.due_date = ?1 AND ti.status = 'pending' AND ti.deleted_at IS NULL AND tl.deleted_at IS NULL
            ORDER BY CASE ti.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
            LIMIT 5
            "#,
            params![today],
        )?;

        // 已过期（最多 3 条）
        let overdue_items = Self::query_summary_items(
            &conn,
            r#"
            SELECT ti.id, ti.title, ti.priority, ti.due_date, ti.due_time, tl.title
            FROM todo_items ti
            JOIN todo_lists tl ON ti.todo_list_id = tl.id
            WHERE ti.due_date < ?1 AND ti.status = 'pending' AND ti.deleted_at IS NULL AND tl.deleted_at IS NULL
            ORDER BY ti.due_date DESC
            LIMIT 3
            "#,
            params![today],
        )?;

        // 近 3 天高优先级（最多 3 条）
        let upcoming_high_priority = Self::query_summary_items(
            &conn,
            r#"
            SELECT ti.id, ti.title, ti.priority, ti.due_date, ti.due_time, tl.title
            FROM todo_items ti
            JOIN todo_lists tl ON ti.todo_list_id = tl.id
            WHERE ti.due_date > ?1 AND ti.due_date <= ?2 AND ti.status = 'pending'
                AND ti.priority IN ('urgent', 'high') AND ti.deleted_at IS NULL AND tl.deleted_at IS NULL
            ORDER BY ti.due_date ASC
            LIMIT 3
            "#,
            params![today, upcoming_end],
        )?;

        // 统计
        let total_pending: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND deleted_at IS NULL",
                [],
                |row| row.get::<_, i64>(0),
            )
            .map(|v| v as usize)
            .unwrap_or(0);

        let today_due: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM todo_items WHERE due_date = ?1 AND status = 'pending' AND deleted_at IS NULL",
                params![today],
                |row| row.get::<_, i64>(0),
            )
            .map(|v| v as usize)
            .unwrap_or(0);

        let overdue_count: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM todo_items WHERE due_date < ?1 AND status = 'pending' AND deleted_at IS NULL",
                params![today],
                |row| row.get::<_, i64>(0),
            )
            .map(|v| v as usize)
            .unwrap_or(0);

        let today_completed: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM todo_items WHERE completed_at LIKE ?1 AND status = 'completed' AND deleted_at IS NULL",
                params![format!("{}%", today)],
                |row| row.get::<_, i64>(0),
            )
            .map(|v| v as usize)
            .unwrap_or(0);

        // 如果没有任何活跃信息，返回 None（不浪费 token）
        if total_pending == 0 && today_completed == 0 {
            return Ok(None);
        }

        Ok(Some(TodoActiveSummary {
            today_items,
            overdue_items,
            upcoming_high_priority,
            stats: TodoStats {
                total_pending,
                today_due,
                overdue_count,
                today_completed,
            },
        }))
    }

    /// 格式化活跃待办摘要为 System Prompt 文本
    pub fn format_active_summary_for_prompt(summary: &TodoActiveSummary) -> String {
        let mut lines = Vec::new();

        if !summary.overdue_items.is_empty() {
            lines.push("【已过期未完成】".to_string());
            for item in &summary.overdue_items {
                let priority_mark = if item.priority == "urgent" || item.priority == "high" {
                    "!"
                } else {
                    " "
                };
                let date_info = item
                    .due_date
                    .as_ref()
                    .map(|d| format!(" (过期: {})", d))
                    .unwrap_or_default();
                lines.push(format!(
                    "- [{}] {}{} [{}]",
                    priority_mark, item.title, date_info, item.list_title
                ));
            }
        }

        if !summary.today_items.is_empty() {
            lines.push("【今日待办】".to_string());
            for item in &summary.today_items {
                let priority_mark = if item.priority == "urgent" || item.priority == "high" {
                    "!"
                } else {
                    " "
                };
                let time_info = item
                    .due_time
                    .as_ref()
                    .map(|t| format!(" 截止 {}", t))
                    .unwrap_or_default();
                lines.push(format!(
                    "- [{}] {}{} [{}]",
                    priority_mark, item.title, time_info, item.list_title
                ));
            }
        }

        if !summary.upcoming_high_priority.is_empty() {
            lines.push("【即将到期（高优先级）】".to_string());
            for item in &summary.upcoming_high_priority {
                let date_info = item
                    .due_date
                    .as_ref()
                    .map(|d| format!(" ({})", d))
                    .unwrap_or_default();
                lines.push(format!("- [!] {}{} [{}]", item.title, date_info, item.list_title));
            }
        }

        lines.push(format!(
            "统计：未完成 {} 项，今日到期 {} 项，已过期 {} 项，今日已完成 {} 项",
            summary.stats.total_pending,
            summary.stats.today_due,
            summary.stats.overdue_count,
            summary.stats.today_completed,
        ));

        lines.join("\n")
    }

    // ========================================================================
    // 内部辅助方法
    // ========================================================================

    fn row_to_todo_list(row: &rusqlite::Row) -> rusqlite::Result<VfsTodoList> {
        Ok(VfsTodoList {
            id: row.get(0)?,
            title: row.get(1)?,
            description: row.get(2)?,
            icon: row.get(3)?,
            color: row.get(4)?,
            sort_order: row.get(5)?,
            is_default: row.get::<_, i32>(6)? != 0,
            is_favorite: row.get::<_, i32>(7)? != 0,
            created_at: row.get(8)?,
            updated_at: row.get(9)?,
            deleted_at: row.get(10)?,
        })
    }

    // ========================================================================
    // 回收站操作
    // ========================================================================

    /// 列出已删除的待办列表
    pub fn list_deleted_todo_lists(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTodoList>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at, deleted_at
            FROM todo_lists
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_todo_list)?;
        let lists: Vec<VfsTodoList> = rows.collect::<Result<Vec<_>, _>>()?;

        debug!(
            "[VFS::TodoRepo] Listed {} deleted todo lists",
            lists.len()
        );

        Ok(lists)
    }

    /// 永久删除单个待办列表
    pub fn purge_todo_list(db: &VfsDatabase, list_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = Self::purge_todo_list_inner(&conn, list_id);

        match result {
            Ok(_) => {
                if let Err(commit_err) = conn.execute("COMMIT", []) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(commit_err.into());
                }
                info!("[VFS::TodoRepo] Purged todo list: {}", list_id);
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 永久删除所有已删除的待办列表
    pub fn purge_deleted_todo_lists(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare("SELECT id FROM todo_lists WHERE deleted_at IS NOT NULL")?;

        let ids: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let count = ids.len();
        if count == 0 {
            return Ok(0);
        }

        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<()> {
            for id in &ids {
                Self::purge_todo_list_inner(&conn, id)?;
            }
            Ok(())
        })();

        match result {
            Ok(_) => {
                if let Err(commit_err) = conn.execute("COMMIT", []) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(commit_err.into());
                }
                info!("[VFS::TodoRepo] Purged {} deleted todo lists", count);
                Ok(count)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 永久删除待办列表的内部逻辑（不含事务管理，供批量操作复用）
    fn purge_todo_list_inner(conn: &Connection, list_id: &str) -> VfsResult<()> {
        // 1. 删除该列表下的所有待办项
        conn.execute(
            "DELETE FROM todo_items WHERE todo_list_id = ?1",
            params![list_id],
        )?;

        // 2. 删除待办列表记录
        conn.execute("DELETE FROM todo_lists WHERE id = ?1", params![list_id])?;

        Ok(())
    }

    fn row_to_todo_item(row: &rusqlite::Row) -> rusqlite::Result<VfsTodoItem> {
        Ok(VfsTodoItem {
            id: row.get(0)?,
            todo_list_id: row.get(1)?,
            title: row.get(2)?,
            description: row.get(3)?,
            status: row.get(4)?,
            priority: row.get(5)?,
            due_date: row.get(6)?,
            due_time: row.get(7)?,
            reminder: row.get(8)?,
            tags_json: row.get(9)?,
            sort_order: row.get(10)?,
            parent_id: row.get(11)?,
            completed_at: row.get(12)?,
            repeat_json: row.get(13)?,
            attachments_json: row.get(14)?,
            created_at: row.get(15)?,
            updated_at: row.get(16)?,
            deleted_at: row.get(17)?,
        })
    }

    fn query_summary_items(
        conn: &Connection,
        sql: &str,
        params: impl rusqlite::Params,
    ) -> VfsResult<Vec<TodoSummaryItem>> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params, |row| {
            Ok(TodoSummaryItem {
                id: row.get(0)?,
                title: row.get(1)?,
                priority: row.get(2)?,
                due_date: row.get(3)?,
                due_time: row.get(4)?,
                list_title: row.get(5)?,
            })
        })?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }
}

// 为 VfsUpdateTodoItemParams 实现 Default 以支持部分更新
impl Default for VfsUpdateTodoItemParams {
    fn default() -> Self {
        Self {
            title: None,
            description: None,
            status: None,
            priority: None,
            due_date: None,
            due_time: None,
            reminder: None,
            tags: None,
            parent_id: None,
            attachments: None,
            repeat_json: None,
        }
    }
}
