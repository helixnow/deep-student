//! 待办列表 Repo
//!
//! 提供 todo_lists 和 todo_items 表的 CRUD 操作。
//! 独立于 VFS 资源系统，直接操作 todo_lists / todo_items 表。

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

/// Escape LIKE wildcards (`%`, `_`, and the escape char itself) so user
/// queries match literally. Pair with `ESCAPE '\'` in SQL.
fn escape_like_pattern(query: &str) -> String {
    query
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

const VALID_TODO_STATUSES: &[&str] = &["pending", "completed", "cancelled"];
const VALID_TODO_PRIORITIES: &[&str] = &["none", "low", "medium", "high", "urgent"];

/// 校验并规范化为零填充 `YYYY-MM-DD`。日期参与字符串比较
/// （today/overdue/upcoming 查询），格式错误会静默破坏所有日期视图。
/// ★ 2026-06-12（第二轮审阅）：chrono 接受 `2026-6-1` 这类非零填充输入，
/// 但字符串比较下 '2026-6-1' > '2026-06-30'，必须在写入前规范化。
fn validate_due_date(v: &Option<String>) -> VfsResult<Option<String>> {
    match v {
        Some(s) => match chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            Ok(d) => Ok(Some(d.format("%Y-%m-%d").to_string())),
            Err(_) => Err(VfsError::InvalidArgument {
                param: "due_date".to_string(),
                reason: format!("Invalid due_date '{}'; expected YYYY-MM-DD", s),
            }),
        },
        None => Ok(None),
    }
}

/// 校验并规范化为零填充 `HH:MM`（也接受 `HH:MM:SS`，秒会被截断）。
fn validate_due_time(v: &Option<String>) -> VfsResult<Option<String>> {
    match v {
        Some(s) => {
            let parsed = chrono::NaiveTime::parse_from_str(s, "%H:%M")
                .or_else(|_| chrono::NaiveTime::parse_from_str(s, "%H:%M:%S"));
            match parsed {
                Ok(t) => Ok(Some(t.format("%H:%M").to_string())),
                Err(_) => Err(VfsError::InvalidArgument {
                    param: "due_time".to_string(),
                    reason: format!("Invalid due_time '{}'; expected HH:MM", s),
                }),
            }
        }
        None => Ok(None),
    }
}

// ============================================================================
// 重复规则（repeat_json 契约）
// ============================================================================

/// repeat_json 的结构化形式：`{"freq":"daily","interval":1}`。
/// `interval` 对 daily/weekly/monthly/yearly 生效；`weekdays`（工作日）忽略 interval。
/// weekly 可携带 `byWeekday`（0=周日..6=周六，与 JS getDay() 一致）实现
/// 「每周一、三、五」多选星期；旧客户端忽略该字段降级为普通每周。
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TodoRepeatRule {
    pub freq: String,
    #[serde(default = "default_repeat_interval")]
    pub interval: u32,
    #[serde(default, rename = "byWeekday")]
    pub by_weekday: Option<Vec<u8>>,
}

fn default_repeat_interval() -> u32 {
    1
}

const VALID_REPEAT_FREQS: &[&str] = &["daily", "weekly", "monthly", "yearly", "weekdays"];

/// 解析并校验重复规则；非法返回 None。
pub fn parse_repeat_rule(repeat_json: &str) -> Option<TodoRepeatRule> {
    let mut rule: TodoRepeatRule = serde_json::from_str(repeat_json).ok()?;
    if !VALID_REPEAT_FREQS.contains(&rule.freq.as_str()) {
        return None;
    }
    if rule.interval == 0 || rule.interval > 999 {
        return None;
    }
    // byWeekday 仅对 weekly 有意义：去重排序并校验 0-6；空数组视为未设置
    if let Some(ref mut days) = rule.by_weekday {
        if rule.freq != "weekly" {
            rule.by_weekday = None;
        } else {
            if days.iter().any(|d| *d > 6) {
                return None;
            }
            days.sort_unstable();
            days.dedup();
            if days.is_empty() {
                rule.by_weekday = None;
            }
        }
    }
    Some(rule)
}

/// 写入前校验 repeat_json：必须是可解析的合法规则，
/// 否则重复引擎会静默不生效，用户以为设置了重复实际没有。
fn validate_repeat_json(v: &Option<String>) -> VfsResult<()> {
    if let Some(s) = v {
        if parse_repeat_rule(s).is_none() {
            return Err(VfsError::InvalidArgument {
                param: "repeat_json".to_string(),
                reason: format!(
                    "Invalid repeat rule '{}'; expected {{\"freq\":\"daily|weekly|monthly|yearly|weekdays\",\"interval\":1-999,\"byWeekday\":[0-6]?}}",
                    s
                ),
            });
        }
    }
    Ok(())
}

/// 按规则从 `from` 推进一步。monthly/yearly 由 chrono 自动收口到月末
/// （1-31 + 1 月 = 2-28/29）；weekdays 跳过周六/周日。
fn step_due_date(from: chrono::NaiveDate, rule: &TodoRepeatRule) -> Option<chrono::NaiveDate> {
    use chrono::{Datelike, Days, Months, Weekday};
    let interval = rule.interval.max(1);
    match rule.freq.as_str() {
        "daily" => from.checked_add_days(Days::new(interval as u64)),
        "weekly" => match rule.by_weekday {
            Some(ref days) if !days.is_empty() => {
                step_weekly_by_weekday(from, days, interval)
            }
            _ => from.checked_add_days(Days::new(7 * interval as u64)),
        },
        "monthly" => from.checked_add_months(Months::new(interval)),
        "yearly" => from.checked_add_months(Months::new(12 * interval)),
        "weekdays" => {
            let mut d = from.checked_add_days(Days::new(1))?;
            while matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                d = d.checked_add_days(Days::new(1))?;
            }
            Some(d)
        }
        _ => None,
    }
}

/// 「每 N 周的周一/三/五」：从 `from` 之后逐日扫描，命中星期集合且
/// 所在周（周一为起点）与 `from` 所在周的间隔是 interval 的整数倍。
/// weekday 编号 0=周日..6=周六（与 JS getDay() 一致）。
fn step_weekly_by_weekday(
    from: chrono::NaiveDate,
    days: &[u8],
    interval: u32,
) -> Option<chrono::NaiveDate> {
    use chrono::{Datelike, Days};

    let week_start = |d: chrono::NaiveDate| -> chrono::NaiveDate {
        // 周一为一周起点
        let offset = d.weekday().num_days_from_monday() as u64;
        d.checked_sub_days(Days::new(offset)).unwrap_or(d)
    };
    let from_week = week_start(from);
    let interval = interval.max(1) as i64;

    // 最多扫 interval 周 + 1 周，必能覆盖下一个命中日
    let scan_limit = (interval * 7 + 7) as u64;
    let mut d = from.checked_add_days(Days::new(1))?;
    for _ in 0..scan_limit {
        let js_weekday = (d.weekday().num_days_from_sunday()) as u8;
        if days.contains(&js_weekday) {
            let week_diff = (week_start(d) - from_week).num_days() / 7;
            if week_diff % interval == 0 {
                return Some(d);
            }
        }
        d = d.checked_add_days(Days::new(1))?;
    }
    None
}

/// 完成重复任务后的下一次到期日。
///
/// 从原到期日推进一步；逾期完成（结果仍早于今天）时继续推进到 >= 今天，
/// 与滴答清单/Todoist 的"跳过已错过的周期"行为一致。
/// 允许结果等于今天（如：昨天到期的每日任务今早补完 → 下一次今天到期）。
fn compute_next_due_date(
    rule: &TodoRepeatRule,
    from: chrono::NaiveDate,
    today: chrono::NaiveDate,
) -> Option<chrono::NaiveDate> {
    let mut next = step_due_date(from, rule)?;
    let mut guard = 0;
    while next < today {
        next = step_due_date(next, rule)?;
        guard += 1;
        if guard > 5000 {
            return None;
        }
    }
    Some(next)
}

/// 重复任务滚动时把提醒时间平移到新到期日（保留时刻）。
///
/// reminder 为本地 datetime（`YYYY-MM-DDTHH:MM[:SS]`，datetime-local 格式）。
/// 平移量 = 新到期日 - 旧到期日；解析失败返回 None（丢弃过期提醒）。
fn shift_reminder(
    reminder: &str,
    old_due: chrono::NaiveDate,
    new_due: chrono::NaiveDate,
) -> Option<String> {
    let parsed = chrono::NaiveDateTime::parse_from_str(reminder, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| chrono::NaiveDateTime::parse_from_str(reminder, "%Y-%m-%dT%H:%M"))
        .ok()?;
    let delta = new_due.signed_duration_since(old_due);
    let shifted = parsed.checked_add_signed(delta)?;
    Some(shifted.format("%Y-%m-%dT%H:%M").to_string())
}

fn validate_todo_status(status: &str) -> VfsResult<()> {
    if VALID_TODO_STATUSES.contains(&status) {
        Ok(())
    } else {
        Err(VfsError::InvalidArgument {
            param: "status".to_string(),
            reason: format!(
                "Unsupported todo status '{}'; expected one of {:?}",
                status, VALID_TODO_STATUSES
            ),
        })
    }
}

fn validate_todo_priority(priority: &str) -> VfsResult<()> {
    if VALID_TODO_PRIORITIES.contains(&priority) {
        Ok(())
    } else {
        Err(VfsError::InvalidArgument {
            param: "priority".to_string(),
            reason: format!(
                "Unsupported todo priority '{}'; expected one of {:?}",
                priority, VALID_TODO_PRIORITIES
            ),
        })
    }
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
        let current =
            Self::get_todo_list_with_conn(&conn, list_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: list_id.to_string(),
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
            params![
                final_title,
                final_description,
                final_icon,
                final_color,
                now,
                list_id
            ],
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

    /// 恢复软删除的待办列表（使用现有连接，SAVEPOINT 支持嵌套）
    ///
    /// 仅恢复与列表同批次（deleted_at 相同）删除的待办项——
    /// 列表删除之前已被用户单独删除的项保持删除状态，不会"复活"。
    ///
    /// ★ 2026-06-12（第二轮审阅）：BEGIN IMMEDIATE 改为 SAVEPOINT，
    /// 与 delete/restore_item 等同仓库其余事务保持一致，调用方持有
    /// 外层事务时不会因嵌套 BEGIN 报错。
    pub fn restore_todo_list_with_conn(conn: &Connection, list_id: &str) -> VfsResult<VfsTodoList> {
        conn.execute("SAVEPOINT restore_todo_list", [])?;

        let result = (|| -> VfsResult<()> {
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();

            let batch: Option<String> = conn
                .query_row(
                    "SELECT deleted_at FROM todo_lists WHERE id = ?1 AND deleted_at IS NOT NULL",
                    params![list_id],
                    |row| row.get(0),
                )
                .optional()?;

            let batch = batch.ok_or_else(|| VfsError::NotFound {
                resource_type: "TodoList (deleted)".to_string(),
                id: list_id.to_string(),
            })?;

            conn.execute(
                "UPDATE todo_lists SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
                params![now, list_id],
            )?;

            // 仅恢复同批次删除的待办项
            conn.execute(
                "UPDATE todo_items SET deleted_at = NULL, updated_at = ?1 WHERE todo_list_id = ?2 AND deleted_at = ?3",
                params![now, list_id, batch],
            )?;

            Ok(())
        })();

        match result {
            Ok(_) => {
                if let Err(e) = conn.execute("RELEASE SAVEPOINT restore_todo_list", []) {
                    let _ = conn.execute("ROLLBACK TO SAVEPOINT restore_todo_list", []);
                    return Err(e.into());
                }
                info!("[VFS::TodoRepo] Restored todo list: {}", list_id);
                Self::get_todo_list_with_conn(conn, list_id)?.ok_or_else(|| VfsError::NotFound {
                    resource_type: "TodoList".to_string(),
                    id: list_id.to_string(),
                })
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT restore_todo_list", []);
                let _ = conn.execute("RELEASE SAVEPOINT restore_todo_list", []);
                Err(e)
            }
        }
    }

    /// 切换列表收藏状态
    pub fn toggle_todo_list_favorite(db: &VfsDatabase, list_id: &str) -> VfsResult<VfsTodoList> {
        let conn = db.get_conn_safe()?;
        let current =
            Self::get_todo_list_with_conn(&conn, list_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: list_id.to_string(),
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
        Self::ensure_default_inbox_with_title(db, None)
    }

    /// 同上，但允许调用方传入本地化的收件箱标题（仅在首次创建时使用）。
    pub fn ensure_default_inbox_with_title(
        db: &VfsDatabase,
        title: Option<&str>,
    ) -> VfsResult<VfsTodoList> {
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

            let inbox_title = title
                .map(|t| t.trim())
                .filter(|t| !t.is_empty())
                .unwrap_or("收件箱")
                .to_string();

            Self::create_todo_list_with_conn(
                &conn,
                VfsCreateTodoListParams {
                    title: inbox_title,
                    description: None,
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
        let final_title = params.title.trim().to_string();
        if final_title.is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "title".to_string(),
                reason: "Todo item title cannot be empty".to_string(),
            });
        }
        validate_todo_priority(&params.priority)?;
        let normalized_due_date = validate_due_date(&normalize_optional_str(params.due_date.clone()))?;
        let normalized_due_time = validate_due_time(&normalize_optional_str(params.due_time.clone()))?;
        let normalized_repeat_json = normalize_optional_str(params.repeat_json.clone());
        validate_repeat_json(&normalized_repeat_json)?;

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
            let parent_row: Option<(String,)> = conn
                .query_row(
                    "SELECT todo_list_id FROM todo_items WHERE id = ?1 AND deleted_at IS NULL",
                    params![pid],
                    |row| Ok((row.get::<_, String>(0)?,)),
                )
                .optional()?;
            match parent_row {
                None => {
                    return Err(VfsError::NotFound {
                        resource_type: "TodoItem (parent)".to_string(),
                        id: pid.clone(),
                    });
                }
                Some((parent_list_id,)) if parent_list_id != params.todo_list_id => {
                    return Err(VfsError::InvalidOperation {
                        operation: "create_todo_item".to_string(),
                        reason: format!(
                            "Parent item belongs to list '{}', expected '{}'",
                            parent_list_id, params.todo_list_id
                        ),
                    });
                }
                _ => {}
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

        let normalized_reminder = normalize_optional_str(params.reminder.clone());

        conn.execute(
            r#"
            INSERT INTO todo_items (id, todo_list_id, title, description, status, priority, due_date, due_time, reminder, tags_json, sort_order, parent_id, repeat_json, attachments_json, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
            "#,
            params![
                item_id,
                params.todo_list_id,
                final_title,
                normalize_optional_str(params.description.clone()),
                params.priority,
                normalized_due_date,
                normalized_due_time,
                normalized_reminder,
                tags_json,
                max_sort + 1,
                params.parent_id,
                normalized_repeat_json,
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
            title: final_title,
            description: normalize_optional_str(params.description),
            status: "pending".to_string(),
            priority: params.priority,
            due_date: normalized_due_date,
            due_time: normalized_due_time,
            reminder: normalized_reminder,
            tags_json,
            sort_order: max_sort + 1,
            parent_id: params.parent_id,
            completed_at: None,
            repeat_json: normalized_repeat_json,
            attachments_json,
            estimated_pomodoros: None,
            completed_pomodoros: None,
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
                       tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
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
    ///
    /// 排序以 sort_order（手动拖拽序）为主——对标主流待办应用的默认行为；
    /// 状态仍分组（pending 在前），优先级作为徽章展示不参与排序。
    pub fn list_items_by_list(
        db: &VfsDatabase,
        list_id: &str,
        include_completed: bool,
    ) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let sql = if include_completed {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE todo_list_id = ?1 AND deleted_at IS NULL
            ORDER BY
                CASE status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 WHEN 'cancelled' THEN 2 END,
                sort_order ASC,
                created_at ASC
            "#
        } else {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE todo_list_id = ?1 AND deleted_at IS NULL AND status = 'pending'
            ORDER BY sort_order ASC, created_at ASC
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
        if final_title.trim().is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "title".to_string(),
                reason: "Todo item title cannot be empty".to_string(),
            });
        }
        // 传 Some("") 一律视为"清空为 NULL"（与 due_date 行为一致）
        let final_description = if params.description.is_some() {
            normalize_optional_str(params.description)
        } else {
            current.description.clone()
        };
        let final_status = params.status.unwrap_or(current.status.clone());
        let final_priority = params.priority.unwrap_or(current.priority.clone());
        validate_todo_status(&final_status)?;
        validate_todo_priority(&final_priority)?;
        // Fix: normalize empty strings to None so that clearing a date
        // does not write "" into the DB (which SQL treats as < any date).
        let final_due_date = if params.due_date.is_some() {
            validate_due_date(&normalize_optional_str(params.due_date))?
        } else {
            current.due_date.clone()
        };
        let final_due_time = if params.due_time.is_some() {
            validate_due_time(&normalize_optional_str(params.due_time))?
        } else {
            current.due_time.clone()
        };
        // 清空截止日期时联动清空截止时间，避免遗留"孤立时间"
        let final_due_time = if final_due_date.is_none() {
            None
        } else {
            final_due_time
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
                // ★ 2026-06-12（第二轮审阅）：环检测遍历全图（含软删除节点）。
                // 环是结构属性，与删除状态无关——只看存活链会放过
                // "经软删除节点成环、恢复后变成活环"的情况（与 V20260615 触发器一致）。
                // 深度上限防御历史坏数据中已存在的环导致递归不终止。
                let creates_cycle: bool = conn.query_row(
                    r#"
                    WITH RECURSIVE descendants(id, depth) AS (
                        SELECT id, 1 FROM todo_items WHERE parent_id = ?1
                        UNION ALL
                        SELECT ti.id, d.depth + 1
                        FROM todo_items ti
                        JOIN descendants d ON ti.parent_id = d.id
                        WHERE d.depth < 100
                    )
                    SELECT EXISTS(SELECT 1 FROM descendants WHERE id = ?2)
                    "#,
                    params![item_id, pid_trimmed],
                    |row| row.get(0),
                )?;
                if creates_cycle {
                    return Err(VfsError::InvalidOperation {
                        operation: "update_todo_item".to_string(),
                        reason: "Cannot set parent_id to a descendant item".to_string(),
                    });
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
        let repeat_explicitly_set = params.repeat_json.is_some();
        let final_repeat_json = if repeat_explicitly_set {
            normalize_optional_str(params.repeat_json)
        } else {
            current.repeat_json.clone()
        };
        // 仅校验本次显式写入的规则；历史数据中的非法规则保持原样（引擎会忽略）
        if repeat_explicitly_set {
            validate_repeat_json(&final_repeat_json)?;
        }
        let final_estimated_pomodoros = if params.estimated_pomodoros.is_some() {
            params.estimated_pomodoros.map(|v| v.clamp(0, 999))
        } else {
            current.estimated_pomodoros
        };
        let final_completed_pomodoros = if params.completed_pomodoros.is_some() {
            params.completed_pomodoros.map(|v| v.clamp(0, 9999))
        } else {
            current.completed_pomodoros
        };

        // 处理完成时间
        let final_completed_at = if final_status == "completed" && current.status != "completed" {
            Some(now.clone())
        } else if final_status != "completed" {
            None
        } else {
            current.completed_at.clone()
        };

        // ★ 2026-06-12（第二轮审阅）：条目更新 + 列表时间戳 + 重复任务派生
        // 必须原子提交，否则中途失败会留下"条目已变更但列表时间戳未推进"
        // 的不一致（云同步 LWW 依赖 updated_at 判断新旧）。
        conn.execute("SAVEPOINT update_todo_item", [])?;

        let write_result = (|| -> VfsResult<()> {
            conn.execute(
                r#"
                UPDATE todo_items
                SET title = ?1, description = ?2, status = ?3, priority = ?4, due_date = ?5, due_time = ?6,
                    reminder = ?7, tags_json = ?8, parent_id = ?9, completed_at = ?10, repeat_json = ?11,
                    attachments_json = ?12, updated_at = ?13, estimated_pomodoros = ?15, completed_pomodoros = ?16
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
                    final_estimated_pomodoros,
                    final_completed_pomodoros,
                ],
            )?;

            // 更新列表的 updated_at
            conn.execute(
                "UPDATE todo_lists SET updated_at = ?1 WHERE id = ?2",
                params![now, current.todo_list_id],
            )?;
            Ok(())
        })();

        if let Err(e) = write_result {
            let _ = conn.execute("ROLLBACK TO SAVEPOINT update_todo_item", []);
            let _ = conn.execute("RELEASE SAVEPOINT update_todo_item", []);
            return Err(e);
        }

        info!("[VFS::TodoRepo] Updated todo item: {}", item_id);

        let was_completed_now = final_status == "completed" && current.status != "completed";

        let updated = VfsTodoItem {
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
            estimated_pomodoros: final_estimated_pomodoros,
            completed_pomodoros: final_completed_pomodoros,
            created_at: current.created_at,
            updated_at: now,
            deleted_at: None,
        };

        // 重复任务：完成时生成下一次实例（失败仅告警，不阻塞完成操作——
        // 派生实例可在用户取消完成/再完成时补生成，不值得回滚整个更新）
        if was_completed_now {
            if let Err(e) = Self::spawn_next_recurrence_with_conn(conn, &updated) {
                warn!(
                    "[VFS::TodoRepo] Failed to spawn next recurrence for {}: {}",
                    item_id, e
                );
            }
        }

        if let Err(e) = conn.execute("RELEASE SAVEPOINT update_todo_item", []) {
            let _ = conn.execute("ROLLBACK TO SAVEPOINT update_todo_item", []);
            return Err(e.into());
        }

        Ok(updated)
    }

    /// 重复任务引擎：完成一个带重复规则的任务后，按规则生成下一次实例。
    ///
    /// - 复制标题/描述/优先级/时间/标签/父级/附件/预估番茄数/重复规则；
    ///   completed_pomodoros 归零，状态 pending；
    /// - 下一次到期日由 `compute_next_due_date` 计算（逾期完成跳到未来）；
    /// - 防重：同清单同父级下已存在相同标题+到期日+规则的未完成任务时跳过
    ///   （覆盖"完成→取消完成→再完成"的反复操作）；
    /// - 无到期日或规则非法时静默跳过。
    fn spawn_next_recurrence_with_conn(
        conn: &Connection,
        completed: &VfsTodoItem,
    ) -> VfsResult<()> {
        let repeat_json = match completed.repeat_json.as_deref() {
            Some(s) if !s.trim().is_empty() => s,
            _ => return Ok(()),
        };
        let rule = match parse_repeat_rule(repeat_json) {
            Some(r) => r,
            None => return Ok(()),
        };
        let due = match completed
            .due_date
            .as_deref()
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        {
            Some(d) => d,
            None => return Ok(()),
        };

        let today = chrono::Local::now().date_naive();
        let next = match compute_next_due_date(&rule, due, today) {
            Some(d) => d,
            None => return Ok(()),
        };
        let next_str = next.format("%Y-%m-%d").to_string();

        let dup_exists: bool = conn.query_row(
            r#"
            SELECT EXISTS(
                SELECT 1 FROM todo_items
                WHERE todo_list_id = ?1 AND parent_id IS ?2 AND title = ?3
                  AND due_date = ?4 AND repeat_json = ?5
                  AND status = 'pending' AND deleted_at IS NULL
            )
            "#,
            params![
                completed.todo_list_id,
                completed.parent_id,
                completed.title,
                next_str,
                repeat_json,
            ],
            |row| row.get(0),
        )?;
        if dup_exists {
            return Ok(());
        }

        let item_id = VfsTodoItem::generate_id();
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let max_sort: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) FROM todo_items WHERE todo_list_id = ?1 AND parent_id IS ?2 AND deleted_at IS NULL",
                params![completed.todo_list_id, completed.parent_id],
                |row| row.get(0),
            )
            .unwrap_or(-1);

        // 提醒随到期日平移（保留时刻），无法解析则丢弃避免指向过去
        let next_reminder = completed
            .reminder
            .as_deref()
            .and_then(|r| shift_reminder(r, due, next));

        conn.execute(
            r#"
            INSERT INTO todo_items (id, todo_list_id, title, description, status, priority, due_date, due_time, reminder, tags_json, sort_order, parent_id, repeat_json, attachments_json, estimated_pomodoros, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 'pending', ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
            "#,
            params![
                item_id,
                completed.todo_list_id,
                completed.title,
                completed.description,
                completed.priority,
                next_str,
                completed.due_time,
                next_reminder,
                completed.tags_json,
                max_sort + 1,
                completed.parent_id,
                repeat_json,
                completed.attachments_json,
                completed.estimated_pomodoros,
                now,
                now,
            ],
        )?;

        info!(
            "[VFS::TodoRepo] Spawned next recurrence of {}: {} due {}",
            completed.id, item_id, next_str
        );
        Ok(())
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

    /// 软删除待办项（父项 + 整棵子树同批次删除，事务保护）
    pub fn delete_todo_item(db: &VfsDatabase, item_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute("SAVEPOINT delete_todo_item", [])?;

        let result = (|| -> VfsResult<()> {
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

            // 递归软删除所有后代子任务（使用 CTE 遍历整棵子树，
            // deleted_at 与父项一致，作为"删除批次"标记供恢复使用）
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
            Ok(())
        })();

        match result {
            Ok(_) => {
                conn.execute("RELEASE SAVEPOINT delete_todo_item", [])?;
                info!("[VFS::TodoRepo] Soft deleted todo item: {}", item_id);
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT delete_todo_item", []);
                let _ = conn.execute("RELEASE SAVEPOINT delete_todo_item", []);
                Err(e)
            }
        }
    }

    /// 恢复软删除的待办项（自身 + 同批次删除的后代子树）
    ///
    /// "同批次"指 deleted_at 与目标项完全一致——列表删除前已单独删除的
    /// 子项不会被误恢复。
    pub fn restore_todo_item(db: &VfsDatabase, item_id: &str) -> VfsResult<VfsTodoItem> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute("SAVEPOINT restore_todo_item", [])?;

        let result = (|| -> VfsResult<()> {
            let row: Option<(String, Option<String>, Option<String>)> = conn
                .query_row(
                    "SELECT todo_list_id, deleted_at, parent_id FROM todo_items WHERE id = ?1",
                    params![item_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;

            let (list_id, deleted_at, parent_id) = row.ok_or_else(|| VfsError::NotFound {
                resource_type: "TodoItem".to_string(),
                id: item_id.to_string(),
            })?;

            let batch = match deleted_at {
                Some(batch) => batch,
                None => return Ok(()), // 未删除，幂等返回
            };

            // 所属列表必须存在且未删除（否则恢复出的项不可见）
            let list_alive: bool = conn.query_row(
                "SELECT EXISTS(SELECT 1 FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL)",
                params![list_id],
                |row| row.get(0),
            )?;
            if !list_alive {
                return Err(VfsError::InvalidOperation {
                    operation: "restore_todo_item".to_string(),
                    reason: "Cannot restore item: its list is deleted".to_string(),
                });
            }

            // 父项已被删除时恢复为顶层项，避免出现"不可见的子项"
            if let Some(ref pid) = parent_id {
                let parent_alive: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM todo_items WHERE id = ?1 AND deleted_at IS NULL)",
                    params![pid],
                    |row| row.get(0),
                )?;
                if !parent_alive {
                    conn.execute(
                        "UPDATE todo_items SET parent_id = NULL WHERE id = ?1",
                        params![item_id],
                    )?;
                }
            }

            // 恢复自身 + 同批次后代
            conn.execute(
                r#"
                WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM todo_items WHERE id = ?2
                    UNION ALL
                    SELECT ti.id FROM todo_items ti
                    JOIN descendants d ON ti.parent_id = d.id
                    WHERE ti.deleted_at = ?3
                )
                UPDATE todo_items SET deleted_at = NULL, updated_at = ?1
                WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?3
                "#,
                params![now, item_id, batch],
            )?;

            conn.execute(
                "UPDATE todo_lists SET updated_at = ?1 WHERE id = ?2",
                params![now, list_id],
            )?;
            Ok(())
        })();

        match result {
            Ok(_) => {
                conn.execute("RELEASE SAVEPOINT restore_todo_item", [])?;
                info!("[VFS::TodoRepo] Restored todo item: {}", item_id);
                Self::get_todo_item_with_conn(&conn, item_id)?.ok_or_else(|| VfsError::NotFound {
                    resource_type: "TodoItem".to_string(),
                    id: item_id.to_string(),
                })
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT restore_todo_item", []);
                let _ = conn.execute("RELEASE SAVEPOINT restore_todo_item", []);
                Err(e)
            }
        }
    }

    /// 批量重排序待办项（事务保护；id 必须属于指定列表，否则静默跳过）
    pub fn reorder_items(db: &VfsDatabase, list_id: &str, item_ids: &[String]) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute("SAVEPOINT reorder_todo_items", [])?;

        let result = (|| -> VfsResult<()> {
            for (i, id) in item_ids.iter().enumerate() {
                conn.execute(
                    "UPDATE todo_items SET sort_order = ?1, updated_at = ?2 WHERE id = ?3 AND todo_list_id = ?4 AND deleted_at IS NULL",
                    params![i as i32, now, id, list_id],
                )?;
            }

            conn.execute(
                "UPDATE todo_lists SET updated_at = ?1 WHERE id = ?2",
                params![now, list_id],
            )?;
            Ok(())
        })();

        match result {
            Ok(_) => {
                conn.execute("RELEASE SAVEPOINT reorder_todo_items", [])?;
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT reorder_todo_items", []);
                let _ = conn.execute("RELEASE SAVEPOINT reorder_todo_items", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 查询方法
    // ========================================================================

    /// 获取今日到期的待办项
    /// 「今天」视图（SOTA 语义，对齐 Todoist/TickTick）：
    /// - 今天到期的待办
    /// - 加上所有逾期未完成的待办（逾期任务不该从「今天」消失，前端按到期分组置顶展示）
    /// - include_completed 时额外包含今天完成的（逾期+已完成不再属于「今天」）
    pub fn list_today_items(
        db: &VfsDatabase,
        include_completed: bool,
    ) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let sql = if include_completed {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE ((status = 'pending' AND due_date <= ?1) OR (status = 'completed' AND due_date = ?1))
              AND deleted_at IS NULL
            ORDER BY
                CASE status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
                due_date ASC,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                due_time ASC NULLS LAST,
                sort_order ASC
            "#
        } else {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE status = 'pending' AND due_date <= ?1 AND deleted_at IS NULL
            ORDER BY
                due_date ASC,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                due_time ASC NULLS LAST,
                sort_order ASC
            "#
        };

        let mut stmt = conn.prepare(sql)?;

        let rows = stmt.query_map(params![today], Self::row_to_todo_item)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 获取已过期未完成的待办项
    pub fn list_overdue_items(
        db: &VfsDatabase,
        include_completed: bool,
    ) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let sql = if include_completed {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE due_date < ?1 AND status IN ('pending', 'completed') AND deleted_at IS NULL
            ORDER BY due_date ASC,
                CASE status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
            "#
        } else {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE due_date < ?1 AND status = 'pending' AND deleted_at IS NULL
            ORDER BY due_date ASC,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
            "#
        };

        let mut stmt = conn.prepare(sql)?;

        let rows = stmt.query_map(params![today], Self::row_to_todo_item)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 列出全部待处理任务（跨清单，四象限矩阵视图数据源）。
    pub fn list_all_pending_items(db: &VfsDatabase) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE status = 'pending' AND deleted_at IS NULL
            ORDER BY
                CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
                due_date ASC,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
            "#,
        )?;
        let rows = stmt.query_map([], Self::row_to_todo_item)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 列出所有设置了提醒的待处理任务（提醒调度器数据源）。
    ///
    /// reminder 为本地 datetime 字符串（YYYY-MM-DDTHH:MM），时间比较交给前端
    /// （前端持有正确的本地时钟与时区语义），此处只做存在性过滤。
    pub fn list_reminder_items(db: &VfsDatabase) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE reminder IS NOT NULL AND reminder != '' AND status = 'pending' AND deleted_at IS NULL
            ORDER BY reminder ASC
            "#,
        )?;
        let rows = stmt.query_map([], Self::row_to_todo_item)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 获取即将到期的待办项（指定天数范围）
    pub fn list_upcoming_items(
        db: &VfsDatabase,
        days: i64,
        include_completed: bool,
    ) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let end_date = (chrono::Local::now() + chrono::Duration::days(days))
            .format("%Y-%m-%d")
            .to_string();

        let sql = if include_completed {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE due_date > ?1 AND due_date <= ?2 AND status IN ('pending', 'completed') AND deleted_at IS NULL
            ORDER BY due_date ASC,
                CASE status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 ELSE 2 END,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
            "#
        } else {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE due_date > ?1 AND due_date <= ?2 AND status = 'pending' AND deleted_at IS NULL
            ORDER BY due_date ASC,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
            "#
        };

        let mut stmt = conn.prepare(sql)?;

        let rows = stmt.query_map(params![today, end_date], Self::row_to_todo_item)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 获取已完成的待办项
    pub fn list_completed_items(
        db: &VfsDatabase,
        list_id: Option<&str>,
    ) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        if let Some(list_id) = list_id {
            let mut stmt = conn.prepare(
                r#"
                SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                       tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
                FROM todo_items
                WHERE todo_list_id = ?1 AND status = 'completed' AND deleted_at IS NULL
                ORDER BY completed_at DESC NULLS LAST, updated_at DESC
                "#,
            )?;
            let rows = stmt.query_map(params![list_id], Self::row_to_todo_item)?;
            return Ok(rows.filter_map(log_and_skip_err).collect());
        }

        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE status = 'completed' AND deleted_at IS NULL
            ORDER BY completed_at DESC NULLS LAST, updated_at DESC
            "#,
        )?;
        let rows = stmt.query_map([], Self::row_to_todo_item)?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 搜索待办项
    pub fn search_items(db: &VfsDatabase, query: &str) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let like_pattern = format!("%{}%", escape_like_pattern(query.trim()));

        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE (title LIKE ?1 ESCAPE '\' OR description LIKE ?1 ESCAPE '\') AND deleted_at IS NULL
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
                lines.push(format!(
                    "- [!] {}{} [{}]",
                    item.title, date_info, item.list_title
                ));
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

        debug!("[VFS::TodoRepo] Listed {} deleted todo lists", lists.len());

        Ok(lists)
    }

    /// 永久删除单个待办列表（仅允许清除已在回收站中的列表）
    pub fn purge_todo_list(db: &VfsDatabase, list_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;

        let is_deleted: Option<bool> = conn
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM todo_lists WHERE id = ?1",
                params![list_id],
                |row| row.get(0),
            )
            .optional()?;
        match is_deleted {
            None => {
                return Err(VfsError::NotFound {
                    resource_type: "TodoList".to_string(),
                    id: list_id.to_string(),
                });
            }
            Some(false) => {
                return Err(VfsError::InvalidOperation {
                    operation: "purge_todo_list".to_string(),
                    reason: "Cannot purge a list that is not in trash".to_string(),
                });
            }
            Some(true) => {}
        }

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

    /// 列出回收站中"可独立恢复"的已删除待办项。
    ///
    /// 仅返回恢复后立即可见的根条目：
    /// - 顶层项（parent_id IS NULL），或父项仍存活的子项；
    ///   随父项同批删除的后代由 `restore_todo_item` 的批次恢复带回，不单独列出；
    /// - 所属清单必须未删除——清单级条目走 `list_deleted_todo_lists`。
    pub fn list_deleted_todo_items(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsTodoItem>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT ti.id, ti.todo_list_id, ti.title, ti.description, ti.status, ti.priority, ti.due_date, ti.due_time, ti.reminder,
                   ti.tags_json, ti.sort_order, ti.parent_id, ti.completed_at, ti.repeat_json, ti.attachments_json, ti.estimated_pomodoros, ti.completed_pomodoros, ti.created_at, ti.updated_at, ti.deleted_at
            FROM todo_items ti
            WHERE ti.deleted_at IS NOT NULL
              AND (
                    ti.parent_id IS NULL
                    OR EXISTS(SELECT 1 FROM todo_items p WHERE p.id = ti.parent_id AND p.deleted_at IS NULL)
                  )
              AND EXISTS(SELECT 1 FROM todo_lists l WHERE l.id = ti.todo_list_id AND l.deleted_at IS NULL)
            ORDER BY ti.deleted_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_todo_item)?;
        let items: Vec<VfsTodoItem> = rows.collect::<Result<Vec<_>, _>>()?;

        debug!("[VFS::TodoRepo] Listed {} deleted todo items", items.len());

        Ok(items)
    }

    /// 永久删除单个待办项（仅允许清除已在回收站中的项；连同整棵已删除子树）
    pub fn purge_todo_item(db: &VfsDatabase, item_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;

        let is_deleted: Option<bool> = conn
            .query_row(
                "SELECT deleted_at IS NOT NULL FROM todo_items WHERE id = ?1",
                params![item_id],
                |row| row.get(0),
            )
            .optional()?;
        match is_deleted {
            None => {
                return Err(VfsError::NotFound {
                    resource_type: "TodoItem".to_string(),
                    id: item_id.to_string(),
                });
            }
            Some(false) => {
                return Err(VfsError::InvalidOperation {
                    operation: "purge_todo_item".to_string(),
                    reason: "Cannot purge an item that is not in trash".to_string(),
                });
            }
            Some(true) => {}
        }

        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<()> {
            // 后代（无论删除批次）一并物理删除，避免遗留悬挂 parent_id
            conn.execute(
                r#"
                WITH RECURSIVE descendants(id) AS (
                    SELECT id FROM todo_items WHERE parent_id = ?1
                    UNION ALL
                    SELECT ti.id FROM todo_items ti
                    JOIN descendants d ON ti.parent_id = d.id
                )
                DELETE FROM todo_items
                WHERE id IN (SELECT id FROM descendants) OR id = ?1
                "#,
                params![item_id],
            )?;
            Ok(())
        })();

        match result {
            Ok(_) => {
                if let Err(commit_err) = conn.execute("COMMIT", []) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(commit_err.into());
                }
                info!("[VFS::TodoRepo] Purged todo item: {}", item_id);
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 永久删除所有已删除的待办项（仅清理存活清单中的项；
    /// 已删除清单连同其项由 `purge_deleted_todo_lists` 负责）
    pub fn purge_deleted_todo_items(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;

        let count = conn.execute(
            r#"
            DELETE FROM todo_items
            WHERE deleted_at IS NOT NULL
              AND EXISTS(SELECT 1 FROM todo_lists l WHERE l.id = todo_items.todo_list_id AND l.deleted_at IS NULL)
            "#,
            [],
        )?;

        if count > 0 {
            info!("[VFS::TodoRepo] Purged {} deleted todo items", count);
        }
        Ok(count)
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
            estimated_pomodoros: row.get::<_, Option<i32>>(15).unwrap_or(None),
            completed_pomodoros: row.get::<_, Option<i32>>(16).unwrap_or(None),
            created_at: row.get(17)?,
            updated_at: row.get(18)?,
            deleted_at: row.get(19)?,
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
            estimated_pomodoros: None,
            completed_pomodoros: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, VfsDatabase) {
        crate::vfs::database::setup_migrated_test_db()
    }

    fn create_list(db: &VfsDatabase, title: &str) -> VfsTodoList {
        VfsTodoRepo::create_todo_list(
            db,
            VfsCreateTodoListParams {
                title: title.to_string(),
                description: None,
                icon: None,
                color: None,
                is_default: false,
            },
        )
        .expect("create todo list")
    }

    fn create_item(
        db: &VfsDatabase,
        list_id: &str,
        title: &str,
        due_date: Option<String>,
        parent_id: Option<String>,
    ) -> VfsTodoItem {
        VfsTodoRepo::create_todo_item(
            db,
            VfsCreateTodoItemParams {
                todo_list_id: list_id.to_string(),
                title: title.to_string(),
                description: None,
                priority: "none".to_string(),
                due_date,
                due_time: None,
                reminder: None,
                tags: None,
                parent_id,
                attachments: None,
                repeat_json: None,
            },
        )
        .expect("create todo item")
    }

    #[test]
    fn test_create_todo_item_rejects_cross_list_parent() {
        let (_temp_dir, db) = setup_test_db();
        let list_a = create_list(&db, "List A");
        let list_b = create_list(&db, "List B");
        let parent = create_item(&db, &list_a.id, "Parent", None, None);

        let err = VfsTodoRepo::create_todo_item(
            &db,
            VfsCreateTodoItemParams {
                todo_list_id: list_b.id.clone(),
                title: "Child".to_string(),
                description: None,
                priority: "none".to_string(),
                due_date: None,
                due_time: None,
                reminder: None,
                tags: None,
                parent_id: Some(parent.id),
                attachments: None,
                repeat_json: None,
            },
        )
        .expect_err("cross-list parent should be rejected");

        assert!(
            err.to_string().contains("Parent item belongs to list"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn test_update_todo_item_rejects_parent_cycle() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "Cycle Test");
        let parent = create_item(&db, &list.id, "Parent", None, None);
        let child = create_item(&db, &list.id, "Child", None, Some(parent.id.clone()));

        let err = VfsTodoRepo::update_todo_item(
            &db,
            &parent.id,
            VfsUpdateTodoItemParams {
                parent_id: Some(child.id),
                ..Default::default()
            },
        )
        .expect_err("cycle should be rejected");

        assert!(
            err.to_string().contains("descendant"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn test_list_today_items_include_completed_flag_controls_completed_visibility() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "Today");
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let pending = create_item(&db, &list.id, "Pending", Some(today.clone()), None);
        let completed = create_item(&db, &list.id, "Completed", Some(today.clone()), None);

        VfsTodoRepo::update_todo_item(
            &db,
            &completed.id,
            VfsUpdateTodoItemParams {
                status: Some("completed".to_string()),
                ..Default::default()
            },
        )
        .expect("complete todo item");

        let pending_only = VfsTodoRepo::list_today_items(&db, false).expect("list pending today");
        assert_eq!(pending_only.len(), 1);
        assert_eq!(pending_only[0].id, pending.id);

        let with_completed =
            VfsTodoRepo::list_today_items(&db, true).expect("list today with completed");
        assert_eq!(with_completed.len(), 2);
        assert!(with_completed.iter().any(|item| item.id == completed.id));
    }

    #[test]
    fn test_list_today_items_includes_overdue_pending_excludes_overdue_completed() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "Today");
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let yesterday = (chrono::Local::now() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();

        let due_today = create_item(&db, &list.id, "Due today", Some(today.clone()), None);
        let overdue = create_item(&db, &list.id, "Overdue", Some(yesterday.clone()), None);
        let overdue_done = create_item(&db, &list.id, "Overdue done", Some(yesterday), None);
        // 无截止日的任务不属于今天视图
        create_item(&db, &list.id, "No due", None, None);

        VfsTodoRepo::update_todo_item(
            &db,
            &overdue_done.id,
            VfsUpdateTodoItemParams {
                status: Some("completed".to_string()),
                ..Default::default()
            },
        )
        .expect("complete overdue item");

        let items = VfsTodoRepo::list_today_items(&db, false).expect("list today");
        let ids: Vec<&str> = items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&due_today.id.as_str()), "today item missing");
        assert!(ids.contains(&overdue.id.as_str()), "overdue pending should appear in today view");
        assert_eq!(items.len(), 2, "no-due and completed-overdue must be excluded");
        // 逾期任务排在今天任务之前（due_date ASC）
        assert_eq!(items[0].id, overdue.id);

        // include_completed 也不应把「逾期+已完成」捞回来
        let with_completed = VfsTodoRepo::list_today_items(&db, true).expect("list with completed");
        assert!(
            !with_completed.iter().any(|i| i.id == overdue_done.id),
            "completed overdue item must not appear"
        );
    }

    #[test]
    fn test_todo_insert_trigger_rejects_invalid_status() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "Trigger");
        let conn = db.get_conn_safe().expect("open db connection");
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let err = conn
            .execute(
                r#"
                INSERT INTO todo_items (
                    id, todo_list_id, title, status, priority, tags_json, attachments_json, created_at, updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, '[]', '[]', ?6, ?7)
                "#,
                params![
                    "ti_invalid_status",
                    list.id,
                    "Broken",
                    "not-a-real-status",
                    "none",
                    now,
                    now,
                ],
            )
            .expect_err("invalid status should be blocked by trigger");

        assert!(
            err.to_string().contains("todo_items.status is invalid"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn test_create_todo_item_rejects_invalid_priority() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "Priority");

        let err = VfsTodoRepo::create_todo_item(
            &db,
            VfsCreateTodoItemParams {
                todo_list_id: list.id,
                title: "Broken".to_string(),
                description: None,
                priority: "impossible".to_string(),
                due_date: None,
                due_time: None,
                reminder: None,
                tags: None,
                parent_id: None,
                attachments: None,
                repeat_json: None,
            },
        )
        .expect_err("invalid priority should be rejected");

        assert!(
            err.to_string().contains("Unsupported todo priority"),
            "unexpected error: {}",
            err
        );
    }

    #[test]
    fn test_update_todo_item_rejects_invalid_status() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "Status");
        let item = create_item(&db, &list.id, "Task", None, None);

        let err = VfsTodoRepo::update_todo_item(
            &db,
            &item.id,
            VfsUpdateTodoItemParams {
                status: Some("done-ish".to_string()),
                ..Default::default()
            },
        )
        .expect_err("invalid status should be rejected");

        assert!(
            err.to_string().contains("Unsupported todo status"),
            "unexpected error: {}",
            err
        );
    }

    // ========================================================================
    // 重复规则
    // ========================================================================

    fn date(s: &str) -> chrono::NaiveDate {
        chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").expect("valid date")
    }

    fn rule(freq: &str, interval: u32) -> TodoRepeatRule {
        TodoRepeatRule {
            freq: freq.to_string(),
            interval,
            by_weekday: None,
        }
    }

    fn weekly_rule(interval: u32, by_weekday: &[u8]) -> TodoRepeatRule {
        TodoRepeatRule {
            freq: "weekly".to_string(),
            interval,
            by_weekday: Some(by_weekday.to_vec()),
        }
    }

    #[test]
    fn test_parse_repeat_rule_validation() {
        assert!(parse_repeat_rule(r#"{"freq":"daily"}"#).is_some());
        assert!(parse_repeat_rule(r#"{"freq":"weekly","interval":2}"#).is_some());
        assert!(parse_repeat_rule(r#"{"freq":"weekdays"}"#).is_some());
        // 非法 freq / interval / JSON
        assert!(parse_repeat_rule(r#"{"freq":"hourly"}"#).is_none());
        assert!(parse_repeat_rule(r#"{"freq":"daily","interval":0}"#).is_none());
        assert!(parse_repeat_rule(r#"{"freq":"daily","interval":1000}"#).is_none());
        assert!(parse_repeat_rule("not json").is_none());
    }

    #[test]
    fn test_parse_repeat_rule_by_weekday() {
        // 合法多选星期：去重排序
        let rule =
            parse_repeat_rule(r#"{"freq":"weekly","interval":1,"byWeekday":[5,1,3,1]}"#).unwrap();
        assert_eq!(rule.by_weekday, Some(vec![1, 3, 5]));
        // 超范围星期非法
        assert!(parse_repeat_rule(r#"{"freq":"weekly","byWeekday":[7]}"#).is_none());
        // 空数组视为未设置
        let rule = parse_repeat_rule(r#"{"freq":"weekly","byWeekday":[]}"#).unwrap();
        assert_eq!(rule.by_weekday, None);
        // 非 weekly 频率忽略 byWeekday
        let rule = parse_repeat_rule(r#"{"freq":"daily","byWeekday":[1,3]}"#).unwrap();
        assert_eq!(rule.by_weekday, None);
    }

    #[test]
    fn test_step_due_date_weekly_by_weekday() {
        // 2026-06-08 是周一；规则=每周一三五（JS 编号 1/3/5）
        // 周一 → 周三
        let next = step_due_date(date("2026-06-08"), &weekly_rule(1, &[1, 3, 5])).unwrap();
        assert_eq!(next, date("2026-06-10"));
        // 周三 → 周五
        let next = step_due_date(date("2026-06-10"), &weekly_rule(1, &[1, 3, 5])).unwrap();
        assert_eq!(next, date("2026-06-12"));
        // 周五 → 下周一
        let next = step_due_date(date("2026-06-12"), &weekly_rule(1, &[1, 3, 5])).unwrap();
        assert_eq!(next, date("2026-06-15"));
        // 从非选中日（周四）出发 → 最近的周五
        let next = step_due_date(date("2026-06-11"), &weekly_rule(1, &[1, 3, 5])).unwrap();
        assert_eq!(next, date("2026-06-12"));
    }

    #[test]
    fn test_step_due_date_weekly_by_weekday_interval() {
        // 每 2 周的周一/周五；2026-06-12 是周五
        // 同周内还有候选日时不跳周：周一 06-08 → 周五 06-12
        let next = step_due_date(date("2026-06-08"), &weekly_rule(2, &[1, 5])).unwrap();
        assert_eq!(next, date("2026-06-12"));
        // 本周候选用尽 → 跳 2 周后的周一（06-22，跳过 06-15 那周）
        let next = step_due_date(date("2026-06-12"), &weekly_rule(2, &[1, 5])).unwrap();
        assert_eq!(next, date("2026-06-22"));
    }

    #[test]
    fn test_step_due_date_monthly_clamps_to_month_end() {
        // 1-31 + 1 月 → 2-28（非闰年）
        let next = step_due_date(date("2026-01-31"), &rule("monthly", 1)).unwrap();
        assert_eq!(next, date("2026-02-28"));
        // 闰年 2-29 + 12 月 → 次年 2-28
        let next = step_due_date(date("2028-02-29"), &rule("yearly", 1)).unwrap();
        assert_eq!(next, date("2029-02-28"));
    }

    #[test]
    fn test_shift_reminder_follows_due_date() {
        // 到期日 +7 天 → 提醒同步 +7 天，保留时刻
        let shifted = shift_reminder("2026-06-12T08:30", date("2026-06-12"), date("2026-06-19"));
        assert_eq!(shifted.as_deref(), Some("2026-06-19T08:30"));
        // 带秒格式也能解析（输出归一化到分钟）
        let shifted = shift_reminder("2026-06-11T21:00:00", date("2026-06-12"), date("2026-06-13"));
        assert_eq!(shifted.as_deref(), Some("2026-06-12T21:00"));
        // 解析失败 → None（丢弃）
        assert!(shift_reminder("not-a-date", date("2026-06-12"), date("2026-06-13")).is_none());
    }

    #[test]
    fn test_step_due_date_weekdays_skips_weekend() {
        // 2026-06-12 是周五 → 下一个工作日是周一 06-15
        let next = step_due_date(date("2026-06-12"), &rule("weekdays", 1)).unwrap();
        assert_eq!(next, date("2026-06-15"));
        // 周一 → 周二
        let next = step_due_date(date("2026-06-15"), &rule("weekdays", 1)).unwrap();
        assert_eq!(next, date("2026-06-16"));
    }

    #[test]
    fn test_compute_next_due_date_skips_missed_cycles() {
        // 上上周一到期的每周任务，今天（周五）补完 → 跳到未来最近的周一
        let next =
            compute_next_due_date(&rule("weekly", 1), date("2026-06-01"), date("2026-06-12"))
                .unwrap();
        assert_eq!(next, date("2026-06-15"));
        // 昨天到期的每日任务今天补完 → 今天到期（允许 == today）
        let next = compute_next_due_date(&rule("daily", 1), date("2026-06-11"), date("2026-06-12"))
            .unwrap();
        assert_eq!(next, date("2026-06-12"));
        // 未来到期提前完成 → 直接推进一步，不回拉
        let next = compute_next_due_date(&rule("daily", 1), date("2026-06-20"), date("2026-06-12"))
            .unwrap();
        assert_eq!(next, date("2026-06-21"));
    }

    #[test]
    fn test_complete_repeating_item_spawns_next_occurrence() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "Repeat");
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();

        let item = VfsTodoRepo::create_todo_item(
            &db,
            VfsCreateTodoItemParams {
                todo_list_id: list.id.clone(),
                title: "每日复习".to_string(),
                description: Some("背 20 个单词".to_string()),
                priority: "high".to_string(),
                due_date: Some(today.clone()),
                due_time: Some("08:00".to_string()),
                reminder: None,
                tags: None,
                parent_id: None,
                attachments: None,
                repeat_json: Some(r#"{"freq":"daily","interval":1}"#.to_string()),
            },
        )
        .expect("create repeating item");
        assert_eq!(
            item.repeat_json.as_deref(),
            Some(r#"{"freq":"daily","interval":1}"#)
        );

        // 完成 → 生成明天到期的下一次实例
        let completed = VfsTodoRepo::toggle_todo_item(&db, &item.id).expect("toggle complete");
        assert_eq!(completed.status, "completed");

        let items = VfsTodoRepo::list_items_by_list(&db, &list.id, true).expect("list items");
        assert_eq!(items.len(), 2, "completed original + spawned next");
        let tomorrow = (chrono::Local::now().date_naive() + chrono::Days::new(1))
            .format("%Y-%m-%d")
            .to_string();
        let spawned = items
            .iter()
            .find(|i| i.status == "pending")
            .expect("spawned pending item");
        assert_eq!(spawned.title, "每日复习");
        assert_eq!(spawned.due_date.as_deref(), Some(tomorrow.as_str()));
        assert_eq!(spawned.due_time.as_deref(), Some("08:00"));
        assert_eq!(spawned.priority, "high");
        assert_eq!(
            spawned.repeat_json.as_deref(),
            Some(r#"{"freq":"daily","interval":1}"#)
        );

        // 反复 取消完成→再完成 不应产生重复实例
        VfsTodoRepo::toggle_todo_item(&db, &item.id).expect("un-complete");
        VfsTodoRepo::toggle_todo_item(&db, &item.id).expect("re-complete");
        let items = VfsTodoRepo::list_items_by_list(&db, &list.id, true).expect("list again");
        assert_eq!(items.len(), 2, "dedup guard should prevent duplicates");
    }

    #[test]
    fn test_complete_without_due_date_or_rule_spawns_nothing() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "NoRepeat");

        // 有规则但无到期日 → 不生成
        let no_due = VfsTodoRepo::create_todo_item(
            &db,
            VfsCreateTodoItemParams {
                todo_list_id: list.id.clone(),
                title: "无日期".to_string(),
                description: None,
                priority: "none".to_string(),
                due_date: None,
                due_time: None,
                reminder: None,
                tags: None,
                parent_id: None,
                attachments: None,
                repeat_json: Some(r#"{"freq":"daily"}"#.to_string()),
            },
        )
        .expect("create");
        VfsTodoRepo::toggle_todo_item(&db, &no_due.id).expect("complete");

        // 无规则 → 不生成
        let plain = create_item(&db, &list.id, "普通任务", Some("2026-01-01".into()), None);
        VfsTodoRepo::toggle_todo_item(&db, &plain.id).expect("complete");

        let items = VfsTodoRepo::list_items_by_list(&db, &list.id, true).expect("list");
        assert_eq!(items.len(), 2, "no extra items spawned");
    }

    #[test]
    fn test_create_todo_item_rejects_invalid_repeat_json() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "BadRepeat");

        let err = VfsTodoRepo::create_todo_item(
            &db,
            VfsCreateTodoItemParams {
                todo_list_id: list.id,
                title: "Broken".to_string(),
                description: None,
                priority: "none".to_string(),
                due_date: None,
                due_time: None,
                reminder: None,
                tags: None,
                parent_id: None,
                attachments: None,
                repeat_json: Some(r#"{"freq":"hourly"}"#.to_string()),
            },
        )
        .expect_err("invalid repeat rule should be rejected");

        assert!(
            err.to_string().contains("Invalid repeat rule"),
            "unexpected error: {}",
            err
        );
    }

    // ========================================================================
    // 任务级回收站
    // ========================================================================

    #[test]
    fn test_deleted_items_trash_roundtrip() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "Trash");
        let parent = create_item(&db, &list.id, "Parent", None, None);
        let _child = create_item(&db, &list.id, "Child", None, Some(parent.id.clone()));
        let solo = create_item(&db, &list.id, "Solo", None, None);

        VfsTodoRepo::delete_todo_item(&db, &parent.id).expect("delete parent subtree");
        VfsTodoRepo::delete_todo_item(&db, &solo.id).expect("delete solo");

        // 回收站只列出可独立恢复的根条目（Child 随 Parent 批次恢复，不单列）
        let trash = VfsTodoRepo::list_deleted_todo_items(&db, 100, 0).expect("list trash");
        let titles: Vec<&str> = trash.iter().map(|i| i.title.as_str()).collect();
        assert!(titles.contains(&"Parent"));
        assert!(titles.contains(&"Solo"));
        assert!(!titles.contains(&"Child"), "child should not be a root entry");

        // 恢复 Parent → Child 同批次恢复
        VfsTodoRepo::restore_todo_item(&db, &parent.id).expect("restore parent");
        let alive = VfsTodoRepo::list_items_by_list(&db, &list.id, true).expect("list alive");
        let alive_titles: Vec<&str> = alive.iter().map(|i| i.title.as_str()).collect();
        assert!(alive_titles.contains(&"Parent"));
        assert!(alive_titles.contains(&"Child"));

        // 彻底删除 Solo → 从回收站消失，且无法再恢复
        VfsTodoRepo::purge_todo_item(&db, &solo.id).expect("purge solo");
        let trash = VfsTodoRepo::list_deleted_todo_items(&db, 100, 0).expect("list trash again");
        assert!(trash.is_empty());
        assert!(VfsTodoRepo::restore_todo_item(&db, &solo.id).is_err());

        // 不允许 purge 未删除的项
        assert!(VfsTodoRepo::purge_todo_item(&db, &parent.id).is_err());
    }

    #[test]
    fn test_purge_all_deleted_items_keeps_alive_ones() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "PurgeAll");
        let keep = create_item(&db, &list.id, "Keep", None, None);
        let gone_a = create_item(&db, &list.id, "GoneA", None, None);
        let gone_b = create_item(&db, &list.id, "GoneB", None, None);

        VfsTodoRepo::delete_todo_item(&db, &gone_a.id).expect("delete a");
        VfsTodoRepo::delete_todo_item(&db, &gone_b.id).expect("delete b");

        let purged = VfsTodoRepo::purge_deleted_todo_items(&db).expect("purge all");
        assert_eq!(purged, 2);

        let alive = VfsTodoRepo::list_items_by_list(&db, &list.id, true).expect("list");
        assert_eq!(alive.len(), 1);
        assert_eq!(alive[0].id, keep.id);
    }
}
