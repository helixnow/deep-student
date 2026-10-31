//! 待办列表 Repo
//!
//! 提供 todo_lists 和 todo_items 表的 CRUD 操作。
//! 独立于 VFS 资源系统，直接操作 todo_lists / todo_items 表。

use std::collections::HashSet;

use log::{debug, error, info, warn};
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

fn fresh_updated_at(previous: &str) -> String {
    let now = chrono::Utc::now();
    let now = chrono::DateTime::<chrono::Utc>::from_timestamp_millis(now.timestamp_millis())
        .unwrap_or(now);
    let previous_time = chrono::DateTime::parse_from_rfc3339(previous)
        .ok()
        .map(|value| value.with_timezone(&chrono::Utc));
    let value = match previous_time {
        Some(previous_time) if now <= previous_time => {
            previous_time + chrono::Duration::milliseconds(1)
        }
        _ => now,
    };
    value.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
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

/// 校验并规范化提醒时间为本地 datetime `YYYY-MM-DDTHH:MM`（datetime-local 格式，
/// 接受带秒输入并截断到分钟）。
///
/// ★ 2026-07-19：写入前校验。reminder 参与字符串排序（list_reminder_items
/// ORDER BY reminder）且被 `shift_reminder`/前端调度器按此格式解析，
/// 非法或非零填充值会静默破坏提醒调度，必须在写入前拒绝并规范化。
fn validate_reminder(v: &Option<String>) -> VfsResult<Option<String>> {
    match v {
        Some(s) => {
            let parsed = chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M")
                .or_else(|_| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S"));
            match parsed {
                Ok(t) => Ok(Some(t.format("%Y-%m-%dT%H:%M").to_string())),
                Err(_) => Err(VfsError::InvalidArgument {
                    param: "reminder".to_string(),
                    reason: format!("Invalid reminder '{}'; expected YYYY-MM-DDTHH:MM", s),
                }),
            }
        }
        None => Ok(None),
    }
}

/// 本地日历日「今天」的 `[start, end)` UTC 时刻串。
///
/// ★ 2026-07-19：completed_at 以 UTC ISO（`…Z`）落库，而"今日完成"等
/// 统计口径是**本地日历日**（与 today/overdue 视图使用 `chrono::Local`
/// 生成日期一致）。此前用 `completed_at LIKE '{本地日期}%'` 直接拿本地
/// 日期匹配 UTC 字符串，在时区偏移跨日（如 UTC+8 的 00:00-08:00）时统计
/// 错误。这里把本地日界换算成 UTC 时刻串后做范围比较——UTC ISO 字符串
/// 字典序与时间序一致，可走 completed_at 索引。
fn local_today_utc_bounds() -> (String, String) {
    let today = chrono::Local::now().date_naive();
    (
        local_date_start_utc_string(today),
        local_date_start_utc_string(today + chrono::Days::new(1)),
    )
}

/// 本地日历日 00:00 对应的 UTC 时刻串（与 created_at/completed_at 同格式，
/// 可直接字符串比较）。原为 `local_today_utc_bounds` 内部闭包，
/// ★ 2026-07-20 提取为模块级函数供统计聚合（stats_overview 等）复用。
fn local_date_start_utc_string(d: chrono::NaiveDate) -> String {
    use chrono::TimeZone;
    // DST 导致本地午夜不存在/歧义时逐小时后移探测；歧义取较早侧。
    // 统计口径下该 1 小时级误差每年最多出现两天，可接受。
    let mut instant = None;
    for hour in 0..=3u32 {
        if let Some(naive) = d.and_hms_opt(hour, 0, 0) {
            match chrono::Local.from_local_datetime(&naive) {
                chrono::LocalResult::Single(v) | chrono::LocalResult::Ambiguous(v, _) => {
                    instant = Some(v);
                    break;
                }
                chrono::LocalResult::None => continue,
            }
        }
    }
    instant
        .map(|v| v.with_timezone(&chrono::Utc))
        .unwrap_or_else(chrono::Utc::now)
        .format("%Y-%m-%dT%H:%M:%S%.3fZ")
        .to_string()
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
            Some(ref days) if !days.is_empty() => step_weekly_by_weekday(from, days, interval),
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
/// 与常见待办应用的「跳过已错过的周期」行为一致。
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

/// 单清单 pending 计数（`todo_counts_snapshot` 命令 per_list 元素，camelCase 契约）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoListCount {
    pub list_id: String,
    pub pending_count: i64,
}

/// 待办计数快照（`todo_counts_snapshot` 命令返回，camelCase 契约，前端 F1 消费）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoCountsSnapshot {
    /// 今天到期 + 逾期 pending（与 todo_list_today 同口径）
    pub today_count: i64,
    /// 未来 7 天 pending（与 todo_list_upcoming days=7 同口径）
    pub upcoming_count: i64,
    /// 默认清单（收件箱）pending
    pub inbox_count: i64,
    pub all_pending_count: i64,
    /// 未删清单全量 pending 计数
    pub per_list: Vec<TodoListCount>,
}

// ============================================================================
// 批量操作 / 回收站 / 统计聚合的返回类型（2026-07-20 新增命令契约，
// 全部 camelCase 序列化；详见 .parallel-notes/backend.md）
// ============================================================================

/// 单次批量操作允许的最大条目数（防御误传超大数组拖垮单事务）
pub const MAX_TODO_BATCH_SIZE: usize = 500;

/// 批量写操作结果（返回实体的操作：完成/改期/移动/恢复）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoBatchItemsResult {
    /// 成功处理（含幂等命中）的条目，按输入顺序返回最新状态
    pub items: Vec<VfsTodoItem>,
    /// 被跳过的输入 ID（不存在/已删除/状态不适用），按输入顺序
    pub skipped_ids: Vec<String>,
}

/// 批量写操作结果（只返回 ID 的操作：删除/彻底删除）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoBatchIdsResult {
    /// 实际生效的输入 ID，按输入顺序
    pub affected_ids: Vec<String>,
    /// 被跳过的输入 ID（不存在/状态不适用），按输入顺序
    pub skipped_ids: Vec<String>,
}

/// 回收站计数（`todo_trash_counts` 命令返回）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoTrashCounts {
    /// 可独立恢复的已删除条目数（与 list_deleted_todo_items 同口径）
    pub deleted_items: usize,
    /// 已删除清单数（与 list_deleted_todo_lists 同口径）
    pub deleted_lists: usize,
}

/// 待办完成趋势单日桶（本地日历日）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoDailyCompletionStat {
    /// 本地日期（YYYY-MM-DD）
    pub date: String,
    /// 当日完成数（按 completed_at 转本地日分桶）
    pub completed_count: i64,
    /// 当日新建数（按 created_at 转本地日分桶）
    pub created_count: i64,
}

/// 按清单的待办分布
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoListDistributionStat {
    pub list_id: String,
    pub list_title: String,
    pub pending_count: i64,
    pub completed_count: i64,
}

/// 按标签的待办分布
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoTagDistributionStat {
    pub tag: String,
    pub pending_count: i64,
    pub completed_count: i64,
}

/// 按优先级的待处理分布（五档全量返回，含 0）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoPriorityDistributionStat {
    pub priority: String,
    pub pending_count: i64,
}

/// 待办统计总览（`todo_stats_overview` 命令返回，一次查询拿全）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoStatsOverview {
    pub total_pending: i64,
    pub total_completed: i64,
    /// 今日完成数（本地日历日口径，与 get_active_todo_summary 一致）
    pub completed_today: i64,
    /// 逾期未完成数
    pub overdue_count: i64,
    /// 近 N 天完成/新建趋势（升序，无数据天补零）
    pub completion_trend: Vec<TodoDailyCompletionStat>,
    /// 按清单分布（顺序与 list_todo_lists 一致）
    pub by_list: Vec<TodoListDistributionStat>,
    /// 按优先级分布（urgent/high/medium/low/none 固定顺序）
    pub by_priority: Vec<TodoPriorityDistributionStat>,
    /// 按标签分布（按条目总数降序，最多 100 个标签）
    pub by_tag: Vec<TodoTagDistributionStat>,
}

/// 标签 + 使用计数（`todo_list_all_tags` 命令返回元素；
/// ★ 2026-07-20 r3 补齐，count 降序、同 count 按 tag 升序）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TagCountEntry {
    pub tag: String,
    /// 含该标签的未删除条目数（同一条目内重复标签只计一次）
    pub count: i64,
}

/// 附带子任务统计的待办项（`todo_list_items_with_stats` 命令返回元素；
/// 条目字段与 VfsTodoItem 平铺合并）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItemWithChildStats {
    #[serde(flatten)]
    pub item: VfsTodoItem,
    /// 直接子任务数（不含软删除）
    pub subtask_count: i64,
    /// 已完成的直接子任务数
    pub completed_subtask_count: i64,
}

/// 批量 ID 入参清洗：去空白、去重（保持首现顺序）、限制批量上限。
fn sanitize_batch_ids(ids: &[String], param: &str) -> VfsResult<Vec<String>> {
    if ids.len() > MAX_TODO_BATCH_SIZE {
        return Err(VfsError::InvalidArgument {
            param: param.to_string(),
            reason: format!(
                "Batch size {} exceeds limit {}",
                ids.len(),
                MAX_TODO_BATCH_SIZE
            ),
        });
    }
    let mut seen: HashSet<&str> = HashSet::with_capacity(ids.len());
    let mut out = Vec::with_capacity(ids.len());
    for id in ids {
        let trimmed = id.trim();
        if trimmed.is_empty() {
            continue;
        }
        if seen.insert(trimmed) {
            out.push(trimmed.to_string());
        }
    }
    Ok(out)
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

        // ★ 2026-07-19：此前恒写 sort_order=0，新清单全部挤在头部且互相并列
        // （排序退化为 updated_at DESC），与 reorder_todo_lists 重写的 0..n
        // 序列冲突。改为未删清单范围内 MAX+1 追加到尾部（与 create_todo_item
        // 的条目级做法一致）。
        let next_sort: i32 = conn
            .query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM todo_lists WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .unwrap_or(0);

        conn.execute(
            r#"
            INSERT INTO todo_lists (id, title, description, icon, color, sort_order, is_default, is_favorite, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 0, ?8, ?9)
            "#,
            params![
                list_id,
                final_title,
                params.description,
                params.icon,
                params.color,
                next_sort,
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
            sort_order: next_sort,
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
        // ★ 2026-07-19：description/icon/color 采用与 item 更新一致的三态语义——
        // None=不变、Some("")=清空为 NULL、Some(v)=设值。此前用 `.or(current…)`
        // 导致 Some("") 被存成空串、且永远无法清空回 NULL。
        let final_description = if params.description.is_some() {
            normalize_optional_str(params.description)
        } else {
            current.description
        };
        let final_icon = if params.icon.is_some() {
            normalize_optional_str(params.icon)
        } else {
            current.icon
        };
        let final_color = if params.color.is_some() {
            normalize_optional_str(params.color)
        } else {
            current.color
        };

        // ★ 2026-07-19：WHERE 补 deleted_at IS NULL——读取与写入之间列表可能
        // 被并发软删除，缺谓词会把回收站行改活跃字段（且推进 updated_at 干扰
        // 云同步 LWW）。affected == 0 视为 NotFound。
        // ★ local_version 与 updated_at 同步推进（本文件所有推进 updated_at
        // 的写路径统一做法，对齐 reorder_todo_lists；变更捕获主链路仍是
        // __change_log 触发器，此处保证记录级版本戳不落后）。
        let affected = conn.execute(
            r#"
            UPDATE todo_lists
            SET title = ?1, description = ?2, icon = ?3, color = ?4, updated_at = ?5,
                local_version = COALESCE(local_version, 0) + 1
            WHERE id = ?6 AND deleted_at IS NULL
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
        if affected == 0 {
            return Err(VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: list_id.to_string(),
            });
        }

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

    /// Agent-facing list update with an atomic optimistic-lock predicate.
    pub fn update_todo_list_if_version(
        db: &VfsDatabase,
        list_id: &str,
        params: VfsUpdateTodoListParams,
        expected_updated_at: &str,
    ) -> VfsResult<(VfsTodoList, VfsTodoList)> {
        if expected_updated_at.trim().is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "expected_updated_at".to_string(),
                reason: "expected_updated_at must not be empty".to_string(),
            });
        }
        if params
            .title
            .as_deref()
            .is_some_and(|title| title.trim().is_empty())
        {
            return Err(VfsError::InvalidArgument {
                param: "title".to_string(),
                reason: "Todo list title cannot be empty".to_string(),
            });
        }

        let conn = db.get_conn_safe()?;
        let previous =
            Self::get_todo_list_with_conn(&conn, list_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: list_id.to_string(),
            })?;
        let now = fresh_updated_at(expected_updated_at);
        let affected = conn.execute(
            r#"
            UPDATE todo_lists
            SET title = COALESCE(?1, title), description = COALESCE(?2, description),
                icon = COALESCE(?3, icon), color = COALESCE(?4, color), updated_at = ?5,
                local_version = COALESCE(local_version, 0) + 1
            WHERE id = ?6 AND deleted_at IS NULL AND updated_at = ?7
            "#,
            params![
                params.title,
                params.description,
                params.icon,
                params.color,
                now,
                list_id,
                expected_updated_at,
            ],
        )?;
        if affected == 0 {
            let actual: Option<String> = conn
                .query_row(
                    "SELECT updated_at FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL",
                    params![list_id],
                    |row| row.get(0),
                )
                .optional()?;
            return match actual {
                Some(actual) => Err(VfsError::Conflict {
                    key: "todo_lists.conflict".to_string(),
                    message: format!(
                        "TODO_CONFLICT: expected_updated_at={}, actual_updated_at={}",
                        expected_updated_at, actual
                    ),
                }),
                None => Err(VfsError::NotFound {
                    resource_type: "TodoList".to_string(),
                    id: list_id.to_string(),
                }),
            };
        }

        let current =
            Self::get_todo_list_with_conn(&conn, list_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: list_id.to_string(),
            })?;
        Ok((previous, current))
    }

    /// 软删除待办列表
    pub fn delete_todo_list(db: &VfsDatabase, list_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_todo_list_with_conn(&conn, list_id)
    }

    /// Agent-facing list deletion with atomic OCC and default-inbox protection.
    pub fn delete_todo_list_if_version(
        db: &VfsDatabase,
        list_id: &str,
        expected_updated_at: &str,
    ) -> VfsResult<VfsTodoList> {
        if expected_updated_at.trim().is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "expected_updated_at".to_string(),
                reason: "expected_updated_at must not be empty".to_string(),
            });
        }
        let conn = db.get_conn_safe()?;
        conn.execute("SAVEPOINT delete_todo_list_occ", [])?;
        let result = (|| -> VfsResult<VfsTodoList> {
            let previous = conn
                .query_row(
                    r#"
                    SELECT id, title, description, icon, color, sort_order, is_default, is_favorite,
                           created_at, updated_at, deleted_at
                    FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL
                    "#,
                    params![list_id],
                    Self::row_to_todo_list,
                )
                .optional()?
                .ok_or_else(|| VfsError::NotFound {
                    resource_type: "TodoList".to_string(),
                    id: list_id.to_string(),
                })?;
            if previous.is_default {
                return Err(VfsError::InvalidOperation {
                    operation: "delete_default_todo_list".to_string(),
                    reason: "Cannot delete the default inbox list".to_string(),
                });
            }

            let now = fresh_updated_at(expected_updated_at);
            let affected = conn.execute(
                r#"
                UPDATE todo_lists
                SET deleted_at = ?1, updated_at = ?1,
                    local_version = COALESCE(local_version, 0) + 1
                WHERE id = ?2 AND deleted_at IS NULL AND is_default = 0 AND updated_at = ?3
                "#,
                params![now, list_id, expected_updated_at],
            )?;
            if affected == 0 {
                let actual: Option<String> = conn
                    .query_row(
                        "SELECT updated_at FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL",
                        params![list_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                return Err(match actual {
                    Some(actual) => VfsError::Conflict {
                        key: "todo_lists.conflict".to_string(),
                        message: format!(
                            "TODO_CONFLICT: expected_updated_at={}, actual_updated_at={}",
                            expected_updated_at, actual
                        ),
                    },
                    None => VfsError::NotFound {
                        resource_type: "TodoList".to_string(),
                        id: list_id.to_string(),
                    },
                });
            }
            conn.execute(
                "UPDATE todo_items SET deleted_at = ?1, updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE todo_list_id = ?2 AND deleted_at IS NULL",
                params![now, list_id],
            )?;
            Ok(previous)
        })();

        match result {
            Ok(previous) => {
                conn.execute("RELEASE SAVEPOINT delete_todo_list_occ", [])?;
                Ok(previous)
            }
            Err(error) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT delete_todo_list_occ", []);
                let _ = conn.execute("RELEASE SAVEPOINT delete_todo_list_occ", []);
                Err(error)
            }
        }
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
                "UPDATE todo_lists SET deleted_at = ?1, updated_at = ?2, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3 AND deleted_at IS NULL",
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
                "UPDATE todo_items SET deleted_at = ?1, updated_at = ?2, local_version = COALESCE(local_version, 0) + 1 WHERE todo_list_id = ?3 AND deleted_at IS NULL",
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
                "UPDATE todo_lists SET deleted_at = NULL, updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2",
                params![now, list_id],
            )?;

            // 仅恢复同批次删除的待办项
            conn.execute(
                "UPDATE todo_items SET deleted_at = NULL, updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE todo_list_id = ?2 AND deleted_at = ?3",
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

        // ★ 2026-07-20：WHERE 补 deleted_at IS NULL——读取与写入之间列表可能被
        // 并发软删除，缺谓词会改写回收站行并推进其 updated_at 干扰云同步 LWW
        // （与 update_todo_list 的同类修复一致）。affected == 0 视为 NotFound。
        let affected = conn.execute(
            "UPDATE todo_lists SET is_favorite = ?1, updated_at = ?2, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3 AND deleted_at IS NULL",
            params![new_favorite as i32, now, list_id],
        )?;
        if affected == 0 {
            return Err(VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: list_id.to_string(),
            });
        }

        Ok(VfsTodoList {
            is_favorite: new_favorite,
            updated_at: now,
            ..current
        })
    }

    /// 批量重排序待办列表（事务保护；ID 必须去重且精确覆盖全部未删除列表）
    ///
    /// 按传入顺序把 `sort_order` 重写为 0..n（校验风格与 `reorder_items` 一致），
    /// 每行推进 updated_at 与 local_version（sort_order 参与 LWW 整行同步，
    /// 不推进版本会被远端旧序覆盖）。
    pub fn reorder_todo_lists(db: &VfsDatabase, list_ids: &[String]) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        // fresh_updated_at 以全表最新 updated_at 为基线，保证重排后的时间戳
        // 严格前进（同毫秒内"创建即拖拽"也不会产出相同 LWW 时间戳）。
        let max_updated: Option<String> = conn
            .query_row(
                "SELECT MAX(updated_at) FROM todo_lists WHERE deleted_at IS NULL",
                [],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        let now = fresh_updated_at(max_updated.as_deref().unwrap_or_default());

        conn.execute("SAVEPOINT reorder_todo_lists", [])?;

        let result = (|| -> VfsResult<()> {
            let input_ids: HashSet<&str> = list_ids.iter().map(String::as_str).collect();
            if input_ids.len() != list_ids.len() {
                return Err(VfsError::InvalidArgument {
                    param: "list_ids".to_string(),
                    reason: "list_ids must not contain duplicates".to_string(),
                });
            }
            let mut stmt = conn.prepare("SELECT id FROM todo_lists WHERE deleted_at IS NULL")?;
            let actual_ids: HashSet<String> = stmt
                .query_map([], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            if actual_ids.len() != input_ids.len()
                || !actual_ids.iter().all(|id| input_ids.contains(id.as_str()))
            {
                return Err(VfsError::InvalidArgument {
                    param: "list_ids".to_string(),
                    reason: "list_ids must exactly match every non-deleted todo list".to_string(),
                });
            }
            for (i, id) in list_ids.iter().enumerate() {
                conn.execute(
                    r#"
                    UPDATE todo_lists
                    SET sort_order = ?1, updated_at = ?2,
                        local_version = COALESCE(local_version, 0) + 1
                    WHERE id = ?3 AND deleted_at IS NULL
                    "#,
                    params![i as i32, now, id],
                )?;
            }
            Ok(())
        })();

        match result {
            Ok(_) => {
                conn.execute("RELEASE SAVEPOINT reorder_todo_lists", [])?;
                info!("[VFS::TodoRepo] Reordered {} todo lists", list_ids.len());
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT reorder_todo_lists", []);
                let _ = conn.execute("RELEASE SAVEPOINT reorder_todo_lists", []);
                Err(e)
            }
        }
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
        let normalized_due_date =
            validate_due_date(&normalize_optional_str(params.due_date.clone()))?;
        let normalized_due_time =
            validate_due_time(&normalize_optional_str(params.due_time.clone()))?;
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

        let normalized_reminder =
            validate_reminder(&normalize_optional_str(params.reminder.clone()))?;

        // ★ 2026-07-19：条目 INSERT 与列表 updated_at 推进必须原子提交
        // （与 update_todo_item 一致）——中途失败会留下"条目已创建但列表
        // 时间戳未推进"的不一致，云同步 LWW 依赖 updated_at 判断新旧。
        conn.execute("SAVEPOINT create_todo_item", [])?;

        let write_result = (|| -> VfsResult<()> {
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
                "UPDATE todo_lists SET updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2",
                params![now, params.todo_list_id],
            )?;
            Ok(())
        })();

        match write_result {
            Ok(_) => {
                conn.execute("RELEASE SAVEPOINT create_todo_item", [])?;
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT create_todo_item", []);
                let _ = conn.execute("RELEASE SAVEPOINT create_todo_item", []);
                return Err(e);
            }
        }

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
            // ★ 2026-07-19：DB 列默认 0（V20260310 DEFAULT 0），返回 Some(0)
            // 与随后 get/list 读回的行保持一致，避免"创建返回 None、刷新变 0"。
            estimated_pomodoros: Some(0),
            completed_pomodoros: Some(0),
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
    /// 排序以 sort_order（手动拖拽序）为主——主流待办应用的默认行为；
    /// 状态仍分组（pending 在前），优先级作为徽章展示不参与排序。
    pub fn list_items_by_list(
        db: &VfsDatabase,
        list_id: &str,
        include_completed: bool,
    ) -> VfsResult<Vec<VfsTodoItem>> {
        Self::list_items_by_list_paged(db, list_id, include_completed, None, None)
    }

    /// 同上，SQL 级分页（移动端支撑）。
    ///
    /// ★ 2026-07-19：此前 handler 全量拉取后内存 skip/take，分页只省 IPC
    /// 不省 DB/内存。改为 SQL LIMIT/OFFSET；`limit`/`offset` 为 None 时
    /// 用 `LIMIT -1 OFFSET 0`（SQLite 语义 = 不限量），与全量行为一致。
    pub fn list_items_by_list_paged(
        db: &VfsDatabase,
        list_id: &str,
        include_completed: bool,
        limit: Option<u32>,
        offset: Option<u32>,
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
            LIMIT ?2 OFFSET ?3
            "#
        } else {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE todo_list_id = ?1 AND deleted_at IS NULL AND status = 'pending'
            ORDER BY sort_order ASC, created_at ASC
            LIMIT ?2 OFFSET ?3
            "#
        };

        let limit_param: i64 = limit.map(|v| v as i64).unwrap_or(-1);
        let offset_param: i64 = offset.unwrap_or(0) as i64;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(
            params![list_id, limit_param, offset_param],
            Self::row_to_todo_item,
        )?;
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
        Self::update_todo_item_with_conn_ex(conn, item_id, params).map(|(item, _)| item)
    }

    /// 同上，并额外返回"完成重复任务时派生的下一次实例 id"
    /// （★ 2026-07-20 r3 补齐：batch_complete 事件的 entityIds 需要包含
    /// 派生实例；既有调用方走上面的薄包装，返回结构不变）。
    fn update_todo_item_with_conn_ex(
        conn: &Connection,
        item_id: &str,
        params: VfsUpdateTodoItemParams,
    ) -> VfsResult<(VfsTodoItem, Option<String>)> {
        let current =
            Self::get_todo_item_with_conn(conn, item_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "TodoItem".to_string(),
                id: item_id.to_string(),
            })?;

        let expected_revision = params.expected_updated_at.clone();

        // R1-04：乐观锁冲突检测（照抄 note_repo expected_updated_at 模板）
        if let Some(ref expected) = params.expected_updated_at {
            if !expected.is_empty() && *expected != current.updated_at {
                warn!(
                    "[VFS::TodoRepo] Optimistic lock conflict for todo item {}: expected updated_at='{}', actual='{}'",
                    item_id, expected, current.updated_at
                );
                // ★ 2026-07-19：与本文件其余 OCC 路径统一为 VfsError::Conflict
                // （此前是 Other("TODO_CONFLICT:…")，同一冲突两种错误类型）。
                // 消息保留 TODO_CONFLICT 稳定子串——AI 层与前端按子串识别冲突。
                return Err(VfsError::Conflict {
                    key: "todo_items.conflict".to_string(),
                    message: format!(
                        "TODO_CONFLICT: expected_updated_at={}, actual_updated_at={}",
                        expected, current.updated_at
                    ),
                });
            }
        }

        let now = fresh_updated_at(&current.updated_at);

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
            validate_reminder(&normalize_optional_str(params.reminder))?
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
            let affected = conn.execute(
                r#"
                UPDATE todo_items
                SET title = ?1, description = ?2, status = ?3, priority = ?4, due_date = ?5, due_time = ?6,
                    reminder = ?7, tags_json = ?8, parent_id = ?9, completed_at = ?10, repeat_json = ?11,
                    attachments_json = ?12, updated_at = ?13, estimated_pomodoros = ?15,
                    local_version = COALESCE(local_version, 0) + 1
                WHERE id = ?14 AND deleted_at IS NULL
                  AND (?16 IS NULL OR ?16 = '' OR updated_at = ?16)
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
                    expected_revision,
                ],
            )?;

            if affected == 0 {
                // ★ 2026-07-20：affected == 0 有两种原因——OCC 失配（Conflict）
                // 或行在读取后被并发软删除/物理删除（NotFound）。此前不加区分
                // 一律报 Conflict，未传 expected_updated_at 的调用方会收到
                // 带空 expected 的假冲突。这里回查行状态给出准确错误。
                let actual: Option<String> = conn
                    .query_row(
                        "SELECT updated_at FROM todo_items WHERE id = ?1 AND deleted_at IS NULL",
                        params![item_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                return Err(match actual {
                    Some(actual) => VfsError::Conflict {
                        key: "todo_items.conflict".to_string(),
                        message: format!(
                            "TODO_CONFLICT: expected_updated_at={}, actual_updated_at={}",
                            expected_revision.as_deref().unwrap_or_default(),
                            actual
                        ),
                    },
                    None => VfsError::NotFound {
                        resource_type: "TodoItem".to_string(),
                        id: item_id.to_string(),
                    },
                });
            }

            // 更新列表的 updated_at
            conn.execute(
                "UPDATE todo_lists SET updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2",
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
            // 派生缓存只由 pomodoro_records 重算路径维护，通用更新不得覆盖。
            completed_pomodoros: current.completed_pomodoros,
            created_at: current.created_at,
            updated_at: now,
            deleted_at: None,
        };

        // 重复任务：完成时生成下一次实例（失败不阻塞完成操作——
        // 派生实例可在用户取消完成/再完成时补生成，不值得回滚整个更新）。
        // ★ 2026-07-19：日志级别 warn → error 并带上规则/到期日上下文，
        // 便于用户报告"重复任务没有生成下一次"时定位（保守修复，不改返回结构）。
        let mut spawned_id: Option<String> = None;
        if was_completed_now {
            match Self::spawn_next_recurrence_with_conn(conn, &updated) {
                Ok(id) => spawned_id = id,
                Err(e) => {
                    error!(
                        "[VFS::TodoRepo] Failed to spawn next recurrence for {} (title='{}', repeat_json={:?}, due_date={:?}): {}",
                        item_id, updated.title, updated.repeat_json, updated.due_date, e
                    );
                }
            }
        }

        if let Err(e) = conn.execute("RELEASE SAVEPOINT update_todo_item", []) {
            let _ = conn.execute("ROLLBACK TO SAVEPOINT update_todo_item", []);
            return Err(e.into());
        }

        Ok((updated, spawned_id))
    }

    /// 重复任务引擎：完成一个带重复规则的任务后，按规则生成下一次实例。
    ///
    /// - 复制标题/描述/优先级/时间/标签/父级/附件/预估番茄数/重复规则；
    ///   completed_pomodoros 归零，状态 pending；
    /// - 下一次到期日由 `compute_next_due_date` 计算（逾期完成跳到未来）；
    /// - 防重：同清单同父级下已存在相同标题+到期日+规则的未完成任务时跳过
    ///   （覆盖"完成→取消完成→再完成"的反复操作）；
    /// - 无到期日或规则非法时静默跳过。
    ///
    /// 返回派生的新实例 id（未派生返回 `Ok(None)`，供批量完成事件收集）。
    fn spawn_next_recurrence_with_conn(
        conn: &Connection,
        completed: &VfsTodoItem,
    ) -> VfsResult<Option<String>> {
        let repeat_json = match completed.repeat_json.as_deref() {
            Some(s) if !s.trim().is_empty() => s,
            _ => return Ok(None),
        };
        let rule = match parse_repeat_rule(repeat_json) {
            Some(r) => r,
            None => return Ok(None),
        };
        let due = match completed
            .due_date
            .as_deref()
            .and_then(|d| chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d").ok())
        {
            Some(d) => d,
            None => return Ok(None),
        };

        let today = chrono::Local::now().date_naive();
        let next = match compute_next_due_date(&rule, due, today) {
            Some(d) => d,
            None => return Ok(None),
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
            return Ok(None);
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

        // ★ 2026-07-19：派生新条目也是清单内容变更——与 create_todo_item_with_conn
        // 一致推进所属清单 updated_at / local_version（云同步 LWW 依赖清单时间戳
        // 判断新旧，此前漏推进会让远端旧清单快照覆盖派生结果）。
        conn.execute(
            "UPDATE todo_lists SET updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2",
            params![now, completed.todo_list_id],
        )?;

        info!(
            "[VFS::TodoRepo] Spawned next recurrence of {}: {} due {}",
            completed.id, item_id, next_str
        );
        Ok(Some(item_id))
    }

    /// 切换待办项完成状态
    ///
    /// R1-04：可选 `expected_updated_at`；None 时保持旧行为。
    pub fn toggle_todo_item(
        db: &VfsDatabase,
        item_id: &str,
        expected_updated_at: Option<String>,
    ) -> VfsResult<VfsTodoItem> {
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
                expected_updated_at,
                ..Default::default()
            },
        )
    }

    /// 软删除待办项（父项 + 整棵子树同批次删除，事务保护）
    pub fn delete_todo_item(db: &VfsDatabase, item_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_todo_item_with_conn(&conn, item_id)
    }

    /// 同上（使用现有连接，SAVEPOINT 支持嵌套，供批量操作复用）
    pub fn delete_todo_item_with_conn(conn: &Connection, item_id: &str) -> VfsResult<()> {
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
                "UPDATE todo_items SET deleted_at = ?1, updated_at = ?2, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3 AND deleted_at IS NULL",
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
            // deleted_at 与父项一致，作为"删除批次"标记供恢复使用）。
            // ★ 2026-07-19：depth < 100 防御历史坏数据中的 parent 环导致递归不终止
            // （与 update_todo_item 环检测、V20260615 触发器的深度上限一致）。
            conn.execute(
                r#"
                WITH RECURSIVE descendants(id, depth) AS (
                    SELECT id, 1 FROM todo_items WHERE parent_id = ?3 AND deleted_at IS NULL
                    UNION ALL
                    SELECT ti.id, d.depth + 1 FROM todo_items ti
                    JOIN descendants d ON ti.parent_id = d.id
                    WHERE ti.deleted_at IS NULL AND d.depth < 100
                )
                UPDATE todo_items SET deleted_at = ?1, updated_at = ?2,
                    local_version = COALESCE(local_version, 0) + 1
                WHERE id IN (SELECT id FROM descendants)
                "#,
                params![now, now, item_id],
            )?;

            // 更新列表时间
            if let Some(lid) = list_id {
                conn.execute(
                    "UPDATE todo_lists SET updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2",
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

    /// Agent-facing item deletion with an atomic optimistic-lock predicate.
    pub fn delete_todo_item_if_version(
        db: &VfsDatabase,
        item_id: &str,
        expected_updated_at: &str,
    ) -> VfsResult<VfsTodoItem> {
        if expected_updated_at.trim().is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "expected_updated_at".to_string(),
                reason: "expected_updated_at must not be empty".to_string(),
            });
        }
        let conn = db.get_conn_safe()?;
        conn.execute("SAVEPOINT delete_todo_item_occ", [])?;
        let result = (|| -> VfsResult<VfsTodoItem> {
            let previous = Self::get_todo_item_with_conn(&conn, item_id)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "TodoItem".to_string(),
                    id: item_id.to_string(),
                }
            })?;
            let now = fresh_updated_at(expected_updated_at);
            let affected = conn.execute(
                r#"
                UPDATE todo_items
                SET deleted_at = ?1, updated_at = ?1,
                    local_version = COALESCE(local_version, 0) + 1
                WHERE id = ?2 AND deleted_at IS NULL AND updated_at = ?3
                "#,
                params![now, item_id, expected_updated_at],
            )?;
            if affected == 0 {
                let actual: Option<String> = conn
                    .query_row(
                        "SELECT updated_at FROM todo_items WHERE id = ?1 AND deleted_at IS NULL",
                        params![item_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                return Err(match actual {
                    Some(actual) => VfsError::Conflict {
                        key: "todo_items.conflict".to_string(),
                        message: format!(
                            "TODO_CONFLICT: expected_updated_at={}, actual_updated_at={}",
                            expected_updated_at, actual
                        ),
                    },
                    None => VfsError::NotFound {
                        resource_type: "TodoItem".to_string(),
                        id: item_id.to_string(),
                    },
                });
            }
            // ★ 2026-07-19：depth < 100 防环（同 delete_todo_item）
            conn.execute(
                r#"
                WITH RECURSIVE descendants(id, depth) AS (
                    SELECT id, 1 FROM todo_items WHERE parent_id = ?2 AND deleted_at IS NULL
                    UNION ALL
                    SELECT ti.id, d.depth + 1 FROM todo_items ti
                    JOIN descendants d ON ti.parent_id = d.id
                    WHERE ti.deleted_at IS NULL AND d.depth < 100
                )
                UPDATE todo_items SET deleted_at = ?1, updated_at = ?1,
                    local_version = COALESCE(local_version, 0) + 1
                WHERE id IN (SELECT id FROM descendants)
                "#,
                params![now, item_id],
            )?;
            conn.execute(
                "UPDATE todo_lists SET updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2",
                params![now, previous.todo_list_id],
            )?;
            Ok(previous)
        })();

        match result {
            Ok(previous) => {
                conn.execute("RELEASE SAVEPOINT delete_todo_item_occ", [])?;
                Ok(previous)
            }
            Err(error) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT delete_todo_item_occ", []);
                let _ = conn.execute("RELEASE SAVEPOINT delete_todo_item_occ", []);
                Err(error)
            }
        }
    }

    /// 恢复软删除的待办项（自身 + 同批次删除的后代子树）
    ///
    /// "同批次"指 deleted_at 与目标项完全一致——列表删除前已单独删除的
    /// 子项不会被误恢复。
    pub fn restore_todo_item(db: &VfsDatabase, item_id: &str) -> VfsResult<VfsTodoItem> {
        let conn = db.get_conn_safe()?;
        Self::restore_todo_item_with_conn(&conn, item_id)
    }

    /// 同上（使用现有连接，SAVEPOINT 支持嵌套，供批量操作复用）
    pub fn restore_todo_item_with_conn(conn: &Connection, item_id: &str) -> VfsResult<VfsTodoItem> {
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

            // 恢复自身 + 同批次后代（depth < 100 防环，同 delete_todo_item）
            conn.execute(
                r#"
                WITH RECURSIVE descendants(id, depth) AS (
                    SELECT id, 1 FROM todo_items WHERE id = ?2
                    UNION ALL
                    SELECT ti.id, d.depth + 1 FROM todo_items ti
                    JOIN descendants d ON ti.parent_id = d.id
                    WHERE ti.deleted_at = ?3 AND d.depth < 100
                )
                UPDATE todo_items SET deleted_at = NULL, updated_at = ?1,
                    local_version = COALESCE(local_version, 0) + 1
                WHERE id IN (SELECT id FROM descendants) AND deleted_at = ?3
                "#,
                params![now, item_id, batch],
            )?;

            conn.execute(
                "UPDATE todo_lists SET updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2",
                params![now, list_id],
            )?;
            Ok(())
        })();

        match result {
            Ok(_) => {
                conn.execute("RELEASE SAVEPOINT restore_todo_item", [])?;
                info!("[VFS::TodoRepo] Restored todo item: {}", item_id);
                Self::get_todo_item_with_conn(conn, item_id)?.ok_or_else(|| VfsError::NotFound {
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

    /// 批量重排序待办项（事务保护；ID 必须去重且精确覆盖清单全部未删除项）
    ///
    /// R1-04：可选 `expected_updated_at` 校验列表 `updated_at`；None 时保持旧行为。
    pub fn reorder_items(
        db: &VfsDatabase,
        list_id: &str,
        item_ids: &[String],
        expected_updated_at: Option<&str>,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let expected_updated_at = expected_updated_at.filter(|value| !value.is_empty());
        let now = expected_updated_at.map_or_else(
            || {
                chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string()
            },
            fresh_updated_at,
        );

        conn.execute("SAVEPOINT reorder_todo_items", [])?;

        let result = (|| -> VfsResult<()> {
            if let Some(expected) = expected_updated_at {
                let affected = conn.execute(
                    r#"
                    UPDATE todo_lists
                    SET updated_at = ?1, local_version = COALESCE(local_version, 0) + 1
                    WHERE id = ?2 AND deleted_at IS NULL AND updated_at = ?3
                    "#,
                    params![now, list_id, expected],
                )?;
                if affected == 0 {
                    let actual: Option<String> = conn
                        .query_row(
                            "SELECT updated_at FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL",
                            params![list_id],
                            |row| row.get(0),
                        )
                        .optional()?;
                    return Err(match actual {
                        Some(actual) => VfsError::Conflict {
                            key: "todo_lists.conflict".to_string(),
                            message: format!(
                                "TODO_CONFLICT: expected_updated_at={}, actual_updated_at={}",
                                expected, actual
                            ),
                        },
                        None => VfsError::NotFound {
                            resource_type: "TodoList".to_string(),
                            id: list_id.to_string(),
                        },
                    });
                }
            }

            let input_ids: HashSet<&str> = item_ids.iter().map(String::as_str).collect();
            if input_ids.len() != item_ids.len() {
                return Err(VfsError::InvalidArgument {
                    param: "item_ids".to_string(),
                    reason: "item_ids must not contain duplicates".to_string(),
                });
            }
            let mut stmt = conn.prepare(
                "SELECT id FROM todo_items WHERE todo_list_id = ?1 AND deleted_at IS NULL",
            )?;
            let actual_ids: HashSet<String> = stmt
                .query_map(params![list_id], |row| row.get(0))?
                .collect::<Result<_, _>>()?;
            if actual_ids.len() != input_ids.len()
                || !actual_ids.iter().all(|id| input_ids.contains(id.as_str()))
            {
                return Err(VfsError::InvalidArgument {
                    param: "item_ids".to_string(),
                    reason: "item_ids must exactly match every non-deleted item in the target list"
                        .to_string(),
                });
            }
            for (i, id) in item_ids.iter().enumerate() {
                conn.execute(
                    "UPDATE todo_items SET sort_order = ?1, updated_at = ?2, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3 AND todo_list_id = ?4 AND deleted_at IS NULL",
                    params![i as i32, now, id, list_id],
                )?;
            }

            if expected_updated_at.is_none() {
                let affected = conn.execute(
                    "UPDATE todo_lists SET updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?2 AND deleted_at IS NULL",
                    params![now, list_id],
                )?;
                if affected == 0 {
                    return Err(VfsError::NotFound {
                        resource_type: "TodoList".to_string(),
                        id: list_id.to_string(),
                    });
                }
            }
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

    /// 把待办项（连同整棵子树）移动到目标清单。
    ///
    /// - 目标清单必须存在且未删除；
    /// - 被移动项挂到目标清单顶层（原父项留在源清单，跨清单父子关系被
    ///   触发器禁止，故根节点 parent_id 置 NULL）；子树内部的 parent
    ///   关系原样保留，整体跟随迁移；
    /// - sort_order 追加到目标清单顶层尾部；
    /// - 后代按深度自浅向深逐层改写 todo_list_id——UPDATE 触发器校验
    ///   "parent 与本行同清单"，必须先迁父行再迁子行；
    /// - 软删除的后代一并迁移，避免恢复时出现跨清单父子；
    /// - 源/目标清单 updated_at 同步推进，SAVEPOINT 原子提交。
    pub fn move_todo_item(
        db: &VfsDatabase,
        item_id: &str,
        target_list_id: &str,
    ) -> VfsResult<VfsTodoItem> {
        let conn = db.get_conn_safe()?;
        Self::move_todo_item_with_conn(&conn, item_id, target_list_id)
    }

    /// 同上（使用现有连接，SAVEPOINT 支持嵌套，供批量操作复用）
    pub fn move_todo_item_with_conn(
        conn: &Connection,
        item_id: &str,
        target_list_id: &str,
    ) -> VfsResult<VfsTodoItem> {
        let current =
            Self::get_todo_item_with_conn(conn, item_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "TodoItem".to_string(),
                id: item_id.to_string(),
            })?;

        let target_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL)",
            params![target_list_id],
            |row| row.get(0),
        )?;
        if !target_exists {
            return Err(VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: target_list_id.to_string(),
            });
        }

        let now = fresh_updated_at(&current.updated_at);
        let source_list_id = current.todo_list_id.clone();

        conn.execute("SAVEPOINT move_todo_item", [])?;

        let result = (|| -> VfsResult<()> {
            // 目标清单顶层尾部追加
            let max_sort: i32 = conn
                .query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) FROM todo_items WHERE todo_list_id = ?1 AND parent_id IS NULL AND deleted_at IS NULL",
                    params![target_list_id],
                    |row| row.get(0),
                )
                .unwrap_or(-1);

            // 收集后代（含软删除行；depth < 100 防历史坏数据成环）
            let mut stmt = conn.prepare(
                r#"
                WITH RECURSIVE descendants(id, depth) AS (
                    SELECT id, 1 FROM todo_items WHERE parent_id = ?1
                    UNION ALL
                    SELECT ti.id, d.depth + 1 FROM todo_items ti
                    JOIN descendants d ON ti.parent_id = d.id
                    WHERE d.depth < 100
                )
                SELECT id FROM descendants ORDER BY depth ASC
                "#,
            )?;
            let descendant_ids: Vec<String> = stmt
                .query_map(params![item_id], |row| row.get(0))?
                .collect::<Result<_, _>>()?;

            // 根节点先迁：detach 原父 + 落目标清单尾部
            // （affected == 0 说明读取后被并发删除，整体回滚避免"子树已迁、根未迁"）
            let affected = conn.execute(
                r#"
                UPDATE todo_items
                SET todo_list_id = ?1, parent_id = NULL, sort_order = ?2, updated_at = ?3,
                    local_version = COALESCE(local_version, 0) + 1
                WHERE id = ?4 AND deleted_at IS NULL
                "#,
                params![target_list_id, max_sort + 1, now, item_id],
            )?;
            if affected == 0 {
                return Err(VfsError::NotFound {
                    resource_type: "TodoItem".to_string(),
                    id: item_id.to_string(),
                });
            }

            // 后代按深度序逐行迁移（保留子树内 parent 关系与相对 sort_order）
            for id in &descendant_ids {
                conn.execute(
                    "UPDATE todo_items SET todo_list_id = ?1, updated_at = ?2, local_version = COALESCE(local_version, 0) + 1 WHERE id = ?3",
                    params![target_list_id, now, id],
                )?;
            }

            // 源/目标清单时间戳推进（云同步 LWW 基准）
            conn.execute(
                "UPDATE todo_lists SET updated_at = ?1, local_version = COALESCE(local_version, 0) + 1 WHERE id IN (?2, ?3) AND deleted_at IS NULL",
                params![now, source_list_id, target_list_id],
            )?;
            Ok(())
        })();

        match result {
            Ok(_) => {
                conn.execute("RELEASE SAVEPOINT move_todo_item", [])?;
                info!(
                    "[VFS::TodoRepo] Moved todo item {} from list {} to list {}",
                    item_id, source_list_id, target_list_id
                );
                Self::get_todo_item_with_conn(conn, item_id)?.ok_or_else(|| VfsError::NotFound {
                    resource_type: "TodoItem".to_string(),
                    id: item_id.to_string(),
                })
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT move_todo_item", []);
                let _ = conn.execute("RELEASE SAVEPOINT move_todo_item", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 查询方法
    // ========================================================================

    /// 获取今日到期的待办项
    /// 「今天」视图（含过期未完成项的常见语义）：
    /// - 今天到期的待办
    /// - 加上所有逾期未完成的待办（逾期任务不该从「今天」消失，前端按到期分组置顶展示）
    /// - include_completed 时额外包含今天完成的（逾期+已完成不再属于「今天」）
    pub fn list_today_items(
        db: &VfsDatabase,
        include_completed: bool,
    ) -> VfsResult<Vec<VfsTodoItem>> {
        Self::list_today_items_paged(db, include_completed, None, None)
    }

    /// 同上，SQL 级分页；None 时等价全量（见 list_items_by_list_paged）。
    pub fn list_today_items_paged(
        db: &VfsDatabase,
        include_completed: bool,
        limit: Option<u32>,
        offset: Option<u32>,
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
            LIMIT ?2 OFFSET ?3
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
            LIMIT ?2 OFFSET ?3
            "#
        };

        let limit_param: i64 = limit.map(|v| v as i64).unwrap_or(-1);
        let offset_param: i64 = offset.unwrap_or(0) as i64;
        let mut stmt = conn.prepare(sql)?;

        let rows = stmt.query_map(
            params![today, limit_param, offset_param],
            Self::row_to_todo_item,
        )?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 获取已过期未完成的待办项
    pub fn list_overdue_items(
        db: &VfsDatabase,
        include_completed: bool,
    ) -> VfsResult<Vec<VfsTodoItem>> {
        Self::list_overdue_items_paged(db, include_completed, None, None)
    }

    /// 同上，SQL 级分页；None 时等价全量（见 list_items_by_list_paged）。
    pub fn list_overdue_items_paged(
        db: &VfsDatabase,
        include_completed: bool,
        limit: Option<u32>,
        offset: Option<u32>,
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
            LIMIT ?2 OFFSET ?3
            "#
        } else {
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json, estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE due_date < ?1 AND status = 'pending' AND deleted_at IS NULL
            ORDER BY due_date ASC,
                CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END
            LIMIT ?2 OFFSET ?3
            "#
        };

        let limit_param: i64 = limit.map(|v| v as i64).unwrap_or(-1);
        let offset_param: i64 = offset.unwrap_or(0) as i64;
        let mut stmt = conn.prepare(sql)?;

        let rows = stmt.query_map(
            params![today, limit_param, offset_param],
            Self::row_to_todo_item,
        )?;
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

    /// Bounded search for Agent tools, with an exact total for pagination metadata.
    pub fn search_items_paginated(
        db: &VfsDatabase,
        query: &str,
        limit: u32,
        offset: u32,
    ) -> VfsResult<(Vec<VfsTodoItem>, usize)> {
        let conn = db.get_conn_safe()?;
        let like_pattern = format!("%{}%", escape_like_pattern(query.trim()));
        let total: i64 = conn.query_row(
            r#"
            SELECT COUNT(*) FROM todo_items
            WHERE (title LIKE ?1 ESCAPE '\' OR description LIKE ?1 ESCAPE '\')
              AND deleted_at IS NULL
            "#,
            params![like_pattern],
            |row| row.get(0),
        )?;
        let mut stmt = conn.prepare(
            r#"
            SELECT id, todo_list_id, title, description, status, priority, due_date, due_time, reminder,
                   tags_json, sort_order, parent_id, completed_at, repeat_json, attachments_json,
                   estimated_pomodoros, completed_pomodoros, created_at, updated_at, deleted_at
            FROM todo_items
            WHERE (title LIKE ?1 ESCAPE '\' OR description LIKE ?1 ESCAPE '\')
              AND deleted_at IS NULL
            ORDER BY updated_at DESC
            LIMIT ?2 OFFSET ?3
            "#,
        )?;
        let rows = stmt.query_map(params![like_pattern, limit, offset], Self::row_to_todo_item)?;
        Ok((
            rows.filter_map(log_and_skip_err).collect(),
            total.max(0) as usize,
        ))
    }

    // ========================================================================
    // 计数快照（前端徽标/侧栏计数，聚合 COUNT，不拉全行）
    // ========================================================================

    /// 全量视图计数快照：
    /// - `today_count`：今天到期 + 逾期 pending（与 `list_today_items`
    ///   include_completed=false 同口径：`status='pending' AND due_date <= 今天`）；
    /// - `upcoming_count`：未来 7 天 pending（与 `list_upcoming_items(days=7)`
    ///   同口径：`due_date > 今天 AND due_date <= 今天+7`）；
    /// - `inbox_count`：默认清单（is_default=1，未删）内 pending；无默认清单时 0；
    /// - `all_pending_count`：全部未删 pending（与 `list_all_pending_items` 同口径）；
    /// - `per_list`：全部未删清单的 pending 计数（含 0，LEFT JOIN），
    ///   顺序与 `list_todo_lists` 一致。
    pub fn counts_snapshot(db: &VfsDatabase) -> VfsResult<TodoCountsSnapshot> {
        let conn = db.get_conn_safe()?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let upcoming_end = (chrono::Local::now() + chrono::Duration::days(7))
            .format("%Y-%m-%d")
            .to_string();

        let today_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND due_date <= ?1 AND deleted_at IS NULL",
            params![today],
            |row| row.get(0),
        )?;

        let upcoming_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND due_date > ?1 AND due_date <= ?2 AND deleted_at IS NULL",
            params![today, upcoming_end],
            |row| row.get(0),
        )?;

        let inbox_count: i64 = conn.query_row(
            r#"
            SELECT COUNT(*)
            FROM todo_items ti
            JOIN todo_lists tl ON tl.id = ti.todo_list_id
            WHERE tl.is_default = 1 AND tl.deleted_at IS NULL
              AND ti.status = 'pending' AND ti.deleted_at IS NULL
            "#,
            [],
            |row| row.get(0),
        )?;

        let all_pending_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND deleted_at IS NULL",
            [],
            |row| row.get(0),
        )?;

        let mut stmt = conn.prepare(
            r#"
            SELECT tl.id, COUNT(ti.id)
            FROM todo_lists tl
            LEFT JOIN todo_items ti
              ON ti.todo_list_id = tl.id AND ti.status = 'pending' AND ti.deleted_at IS NULL
            WHERE tl.deleted_at IS NULL
            GROUP BY tl.id
            ORDER BY tl.is_default DESC, tl.sort_order ASC, tl.updated_at DESC
            "#,
        )?;
        let per_list: Vec<TodoListCount> = stmt
            .query_map([], |row| {
                Ok(TodoListCount {
                    list_id: row.get(0)?,
                    pending_count: row.get(1)?,
                })
            })?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(TodoCountsSnapshot {
            today_count,
            upcoming_count,
            inbox_count,
            all_pending_count,
            per_list,
        })
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

        // ★ 2026-07-19：completed_at 是 UTC ISO（…Z），此前 LIKE '{本地日期}%'
        // 直接拿本地日期匹配 UTC 串，非 UTC 时区在日界附近统计错误。
        // 改为把本地"今天"的日界换算成 UTC 时刻串做范围比较（口径与
        // today/overdue 视图的"本地日历日"一致，见 local_today_utc_bounds）。
        let (today_start_utc, today_end_utc) = local_today_utc_bounds();
        let today_completed: usize = conn
            .query_row(
                "SELECT COUNT(*) FROM todo_items WHERE completed_at >= ?1 AND completed_at < ?2 AND status = 'completed' AND deleted_at IS NULL",
                params![today_start_utc, today_end_utc],
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
            ORDER BY deleted_at DESC, id ASC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_todo_list)?;
        let lists: Vec<VfsTodoList> = rows.collect::<Result<Vec<_>, _>>()?;

        debug!("[VFS::TodoRepo] Listed {} deleted todo lists", lists.len());

        Ok(lists)
    }

    pub fn count_deleted_todo_lists(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM todo_lists WHERE deleted_at IS NOT NULL",
            [],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as usize)
    }

    /// 永久删除单个待办列表（仅允许清除已在回收站中的列表）
    ///
    /// ★ 2026-07-20："已在回收站"校验移入 BEGIN IMMEDIATE 事务内——此前
    /// 校验在事务外，校验与删除之间列表可能被并发恢复，会把已恢复的
    /// 活跃列表连同条目物理删除（TOCTOU）。
    pub fn purge_todo_list(db: &VfsDatabase, list_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;

        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<()> {
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
            Self::purge_todo_list_inner(&conn, list_id)
        })();

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
            ORDER BY ti.deleted_at DESC, ti.id ASC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_todo_item)?;
        let items: Vec<VfsTodoItem> = rows.collect::<Result<Vec<_>, _>>()?;

        debug!("[VFS::TodoRepo] Listed {} deleted todo items", items.len());

        Ok(items)
    }

    pub fn count_deleted_todo_items(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        let count: i64 = conn.query_row(
            r#"
            SELECT COUNT(*) FROM todo_items ti
            WHERE ti.deleted_at IS NOT NULL
              AND (ti.parent_id IS NULL OR EXISTS(
                    SELECT 1 FROM todo_items p WHERE p.id = ti.parent_id AND p.deleted_at IS NULL
                  ))
              AND EXISTS(
                    SELECT 1 FROM todo_lists l
                    WHERE l.id = ti.todo_list_id AND l.deleted_at IS NULL
                  )
            "#,
            [],
            |row| row.get(0),
        )?;
        Ok(count.max(0) as usize)
    }

    /// 永久删除单个待办项（仅允许清除已在回收站中的项；连同整棵已删除子树）
    pub fn purge_todo_item(db: &VfsDatabase, item_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_todo_item_with_conn(&conn, item_id)
    }

    /// 同上（使用现有连接，SAVEPOINT 支持嵌套，供批量操作复用）
    ///
    /// ★ 2026-07-20："已在回收站"校验移入事务内——此前校验在事务外，
    /// 校验与删除之间条目可能被并发恢复，会把已恢复的活跃条目连同
    /// 子树物理删除（TOCTOU）。同时由 BEGIN IMMEDIATE 改为 SAVEPOINT，
    /// 与本仓库其余事务一致并支持嵌套复用。
    pub fn purge_todo_item_with_conn(conn: &Connection, item_id: &str) -> VfsResult<()> {
        conn.execute("SAVEPOINT purge_todo_item", [])?;

        let result = (|| -> VfsResult<()> {
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

            // 后代（无论删除批次）一并物理删除，避免遗留悬挂 parent_id。
            // ★ 2026-07-19：depth < 100 防御 parent 环导致递归不终止。
            conn.execute(
                r#"
                WITH RECURSIVE descendants(id, depth) AS (
                    SELECT id, 1 FROM todo_items WHERE parent_id = ?1
                    UNION ALL
                    SELECT ti.id, d.depth + 1 FROM todo_items ti
                    JOIN descendants d ON ti.parent_id = d.id
                    WHERE d.depth < 100
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
                conn.execute("RELEASE SAVEPOINT purge_todo_item", [])?;
                info!("[VFS::TodoRepo] Purged todo item: {}", item_id);
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT purge_todo_item", []);
                let _ = conn.execute("RELEASE SAVEPOINT purge_todo_item", []);
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

    /// 回收站计数（条目 + 清单），供前端徽标/分页控件一次拉取。
    pub fn trash_counts(db: &VfsDatabase) -> VfsResult<TodoTrashCounts> {
        Ok(TodoTrashCounts {
            deleted_items: Self::count_deleted_todo_items(db)?,
            deleted_lists: Self::count_deleted_todo_lists(db)?,
        })
    }

    // ========================================================================
    // 批量操作（2026-07-20 新增；单事务，全部成功或全部回滚。
    // 「跳过」不是失败：不存在/已删除/状态不适用的 ID 收集进 skipped_ids，
    // 其余照常处理——批量操作不因个别条目已被并发删除而整体失败。）
    // ========================================================================

    /// 批量完成待办项（已完成的条目幂等返回原状态；重复任务照常派生下一次实例）。
    ///
    /// 返回 `(结果, 事件 entityIds)`：entityIds = 实际发生写库变更的条目 id
    /// + 派生的下一次重复实例 id（按发生顺序）。整批幂等命中（无实际写库）
    /// 时为空——handler 据此决定是否广播 `todo://changed`
    /// （★ 2026-07-20 r3 补齐：修复"幂等命中也广播"与"entityIds 缺派生实例"）。
    pub fn batch_complete_items(
        db: &VfsDatabase,
        item_ids: &[String],
    ) -> VfsResult<(TodoBatchItemsResult, Vec<String>)> {
        let ids = sanitize_batch_ids(item_ids, "item_ids")?;
        if ids.is_empty() {
            return Ok((
                TodoBatchItemsResult {
                    items: Vec::new(),
                    skipped_ids: Vec::new(),
                },
                Vec::new(),
            ));
        }
        let conn = db.get_conn_safe()?;
        conn.execute("SAVEPOINT todo_batch_complete", [])?;

        let result = (|| -> VfsResult<(TodoBatchItemsResult, Vec<String>)> {
            let mut items = Vec::with_capacity(ids.len());
            let mut skipped_ids = Vec::new();
            let mut event_ids = Vec::new();
            for id in &ids {
                match Self::get_todo_item_with_conn(&conn, id)? {
                    None => skipped_ids.push(id.clone()),
                    // 已完成 → 幂等命中，原样返回不再写库（不进事件 entityIds）
                    Some(current) if current.status == "completed" => items.push(current),
                    Some(_) => {
                        let update = Self::update_todo_item_with_conn_ex(
                            &conn,
                            id,
                            VfsUpdateTodoItemParams {
                                status: Some("completed".to_string()),
                                ..Default::default()
                            },
                        );
                        match update {
                            Ok((updated, spawned_id)) => {
                                event_ids.push(updated.id.clone());
                                items.push(updated);
                                if let Some(spawned) = spawned_id {
                                    event_ids.push(spawned);
                                }
                            }
                            // 读取与更新之间被并发删除 → 跳过而非整体失败
                            Err(VfsError::NotFound { .. }) => skipped_ids.push(id.clone()),
                            Err(e) => return Err(e),
                        }
                    }
                }
            }
            Ok((TodoBatchItemsResult { items, skipped_ids }, event_ids))
        })();

        match result {
            Ok(out) => {
                conn.execute("RELEASE SAVEPOINT todo_batch_complete", [])?;
                info!(
                    "[VFS::TodoRepo] Batch completed {} items ({} skipped)",
                    out.0.items.len(),
                    out.0.skipped_ids.len()
                );
                Ok(out)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT todo_batch_complete", []);
                let _ = conn.execute("RELEASE SAVEPOINT todo_batch_complete", []);
                Err(e)
            }
        }
    }

    /// 批量改期。
    ///
    /// - `due_date`：`None` 或空串 → 清空到期日（联动清空到期时间）；
    ///   `Some("YYYY-MM-DD")` → 设为该日期
    /// - `due_time`：`None` → 保留各条目现有时间；`Some("")` → 清空；
    ///   `Some("HH:MM")` → 设为该时间
    pub fn batch_reschedule_items(
        db: &VfsDatabase,
        item_ids: &[String],
        due_date: Option<String>,
        due_time: Option<String>,
    ) -> VfsResult<TodoBatchItemsResult> {
        // 输入格式提前校验（与逐条更新同一套校验器），失败即整体拒绝
        validate_due_date(&normalize_optional_str(due_date.clone()))?;
        validate_due_time(&normalize_optional_str(due_time.clone()))?;

        let ids = sanitize_batch_ids(item_ids, "item_ids")?;
        if ids.is_empty() {
            return Ok(TodoBatchItemsResult {
                items: Vec::new(),
                skipped_ids: Vec::new(),
            });
        }
        let conn = db.get_conn_safe()?;
        conn.execute("SAVEPOINT todo_batch_reschedule", [])?;

        let result = (|| -> VfsResult<TodoBatchItemsResult> {
            let mut items = Vec::with_capacity(ids.len());
            let mut skipped_ids = Vec::new();
            for id in &ids {
                let update = Self::update_todo_item_with_conn(
                    &conn,
                    id,
                    VfsUpdateTodoItemParams {
                        // Some("") 在更新路径中表示"清空为 NULL"
                        due_date: Some(due_date.clone().unwrap_or_default()),
                        due_time: due_time.clone(),
                        ..Default::default()
                    },
                );
                match update {
                    Ok(updated) => items.push(updated),
                    Err(VfsError::NotFound { .. }) => skipped_ids.push(id.clone()),
                    Err(e) => return Err(e),
                }
            }
            Ok(TodoBatchItemsResult { items, skipped_ids })
        })();

        match result {
            Ok(out) => {
                conn.execute("RELEASE SAVEPOINT todo_batch_reschedule", [])?;
                info!(
                    "[VFS::TodoRepo] Batch rescheduled {} items ({} skipped)",
                    out.items.len(),
                    out.skipped_ids.len()
                );
                Ok(out)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT todo_batch_reschedule", []);
                let _ = conn.execute("RELEASE SAVEPOINT todo_batch_reschedule", []);
                Err(e)
            }
        }
    }

    /// 批量设置优先级（★ 2026-07-20 r3 补齐；语义完全镜像 batch_reschedule：
    /// 单事务、priority 非法时整体拒绝（与单项更新同一套校验器）、
    /// 不存在/已删除的 ID 进 skipped_ids）。
    pub fn batch_set_priority_items(
        db: &VfsDatabase,
        item_ids: &[String],
        priority: &str,
    ) -> VfsResult<TodoBatchItemsResult> {
        // 输入提前校验，失败即整体拒绝（不部分执行）
        validate_todo_priority(priority)?;

        let ids = sanitize_batch_ids(item_ids, "item_ids")?;
        if ids.is_empty() {
            return Ok(TodoBatchItemsResult {
                items: Vec::new(),
                skipped_ids: Vec::new(),
            });
        }
        let conn = db.get_conn_safe()?;
        conn.execute("SAVEPOINT todo_batch_set_priority", [])?;

        let result = (|| -> VfsResult<TodoBatchItemsResult> {
            let mut items = Vec::with_capacity(ids.len());
            let mut skipped_ids = Vec::new();
            for id in &ids {
                let update = Self::update_todo_item_with_conn(
                    &conn,
                    id,
                    VfsUpdateTodoItemParams {
                        priority: Some(priority.to_string()),
                        ..Default::default()
                    },
                );
                match update {
                    Ok(updated) => items.push(updated),
                    Err(VfsError::NotFound { .. }) => skipped_ids.push(id.clone()),
                    Err(e) => return Err(e),
                }
            }
            Ok(TodoBatchItemsResult { items, skipped_ids })
        })();

        match result {
            Ok(out) => {
                conn.execute("RELEASE SAVEPOINT todo_batch_set_priority", [])?;
                info!(
                    "[VFS::TodoRepo] Batch set priority '{}' on {} items ({} skipped)",
                    priority,
                    out.items.len(),
                    out.skipped_ids.len()
                );
                Ok(out)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT todo_batch_set_priority", []);
                let _ = conn.execute("RELEASE SAVEPOINT todo_batch_set_priority", []);
                Err(e)
            }
        }
    }

    /// 批量移动到目标清单（每个条目连同子树，语义同 move_todo_item）。
    ///
    /// 输入中互为祖先-后代的 ID：后代随祖先子树整体迁移，自身跳过
    /// （skipped_ids），避免"先迁子再迁父"把子树拆散且结果依赖输入顺序。
    pub fn batch_move_items(
        db: &VfsDatabase,
        item_ids: &[String],
        target_list_id: &str,
    ) -> VfsResult<TodoBatchItemsResult> {
        let ids = sanitize_batch_ids(item_ids, "item_ids")?;
        if ids.is_empty() {
            return Ok(TodoBatchItemsResult {
                items: Vec::new(),
                skipped_ids: Vec::new(),
            });
        }
        let conn = db.get_conn_safe()?;

        let target_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM todo_lists WHERE id = ?1 AND deleted_at IS NULL)",
            params![target_list_id],
            |row| row.get(0),
        )?;
        if !target_exists {
            return Err(VfsError::NotFound {
                resource_type: "TodoList".to_string(),
                id: target_list_id.to_string(),
            });
        }

        conn.execute("SAVEPOINT todo_batch_move", [])?;

        let result = (|| -> VfsResult<TodoBatchItemsResult> {
            // 先在任何移动发生前整体计算"祖先在批量集合内"的跳过集，
            // 保证结果与输入顺序无关
            let id_set: HashSet<&str> = ids.iter().map(String::as_str).collect();
            let mut skip_set: HashSet<String> = HashSet::new();
            {
                let mut stmt = conn.prepare(
                    r#"
                    WITH RECURSIVE ancestors(id, depth) AS (
                        SELECT parent_id, 1 FROM todo_items
                        WHERE id = ?1 AND parent_id IS NOT NULL
                        UNION ALL
                        SELECT ti.parent_id, a.depth + 1
                        FROM todo_items ti
                        JOIN ancestors a ON ti.id = a.id
                        WHERE ti.parent_id IS NOT NULL AND a.depth < 100
                    )
                    SELECT id FROM ancestors
                    "#,
                )?;
                for id in &ids {
                    let ancestors: Vec<String> = stmt
                        .query_map(params![id], |row| row.get(0))?
                        .collect::<Result<_, _>>()?;
                    if ancestors.iter().any(|a| id_set.contains(a.as_str())) {
                        skip_set.insert(id.clone());
                    }
                }
            }

            let mut items = Vec::with_capacity(ids.len());
            let mut skipped_ids = Vec::new();
            for id in &ids {
                if skip_set.contains(id) {
                    skipped_ids.push(id.clone());
                    continue;
                }
                match Self::move_todo_item_with_conn(&conn, id, target_list_id) {
                    Ok(item) => items.push(item),
                    Err(VfsError::NotFound { resource_type, .. })
                        if resource_type == "TodoItem" =>
                    {
                        skipped_ids.push(id.clone())
                    }
                    Err(e) => return Err(e),
                }
            }
            Ok(TodoBatchItemsResult { items, skipped_ids })
        })();

        match result {
            Ok(out) => {
                conn.execute("RELEASE SAVEPOINT todo_batch_move", [])?;
                info!(
                    "[VFS::TodoRepo] Batch moved {} items to list {} ({} skipped)",
                    out.items.len(),
                    target_list_id,
                    out.skipped_ids.len()
                );
                Ok(out)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT todo_batch_move", []);
                let _ = conn.execute("RELEASE SAVEPOINT todo_batch_move", []);
                Err(e)
            }
        }
    }

    /// 批量软删除（每个条目连同子树同批次删除，语义同 delete_todo_item）
    pub fn batch_delete_items(
        db: &VfsDatabase,
        item_ids: &[String],
    ) -> VfsResult<TodoBatchIdsResult> {
        let ids = sanitize_batch_ids(item_ids, "item_ids")?;
        if ids.is_empty() {
            return Ok(TodoBatchIdsResult {
                affected_ids: Vec::new(),
                skipped_ids: Vec::new(),
            });
        }
        let conn = db.get_conn_safe()?;
        conn.execute("SAVEPOINT todo_batch_delete", [])?;

        let result = (|| -> VfsResult<TodoBatchIdsResult> {
            let mut affected_ids = Vec::with_capacity(ids.len());
            let mut skipped_ids = Vec::new();
            for id in &ids {
                match Self::delete_todo_item_with_conn(&conn, id) {
                    Ok(()) => affected_ids.push(id.clone()),
                    Err(VfsError::NotFound { .. }) => skipped_ids.push(id.clone()),
                    Err(e) => return Err(e),
                }
            }
            Ok(TodoBatchIdsResult {
                affected_ids,
                skipped_ids,
            })
        })();

        match result {
            Ok(out) => {
                conn.execute("RELEASE SAVEPOINT todo_batch_delete", [])?;
                info!(
                    "[VFS::TodoRepo] Batch deleted {} items ({} skipped)",
                    out.affected_ids.len(),
                    out.skipped_ids.len()
                );
                Ok(out)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT todo_batch_delete", []);
                let _ = conn.execute("RELEASE SAVEPOINT todo_batch_delete", []);
                Err(e)
            }
        }
    }

    /// 批量从回收站恢复（语义同 restore_todo_item：恢复自身 + 同批次后代；
    /// 所属清单已删除的条目跳过）
    pub fn batch_restore_items(
        db: &VfsDatabase,
        item_ids: &[String],
    ) -> VfsResult<TodoBatchItemsResult> {
        let ids = sanitize_batch_ids(item_ids, "item_ids")?;
        if ids.is_empty() {
            return Ok(TodoBatchItemsResult {
                items: Vec::new(),
                skipped_ids: Vec::new(),
            });
        }
        let conn = db.get_conn_safe()?;
        conn.execute("SAVEPOINT todo_batch_restore", [])?;

        let result = (|| -> VfsResult<TodoBatchItemsResult> {
            let mut items = Vec::with_capacity(ids.len());
            let mut skipped_ids = Vec::new();
            for id in &ids {
                match Self::restore_todo_item_with_conn(&conn, id) {
                    Ok(item) => items.push(item),
                    Err(VfsError::NotFound { .. }) | Err(VfsError::InvalidOperation { .. }) => {
                        skipped_ids.push(id.clone())
                    }
                    Err(e) => return Err(e),
                }
            }
            Ok(TodoBatchItemsResult { items, skipped_ids })
        })();

        match result {
            Ok(out) => {
                conn.execute("RELEASE SAVEPOINT todo_batch_restore", [])?;
                info!(
                    "[VFS::TodoRepo] Batch restored {} items ({} skipped)",
                    out.items.len(),
                    out.skipped_ids.len()
                );
                Ok(out)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT todo_batch_restore", []);
                let _ = conn.execute("RELEASE SAVEPOINT todo_batch_restore", []);
                Err(e)
            }
        }
    }

    /// 批量彻底删除（仅回收站中的条目；未在回收站/不存在的 ID 跳过）
    pub fn batch_purge_items(
        db: &VfsDatabase,
        item_ids: &[String],
    ) -> VfsResult<TodoBatchIdsResult> {
        let ids = sanitize_batch_ids(item_ids, "item_ids")?;
        if ids.is_empty() {
            return Ok(TodoBatchIdsResult {
                affected_ids: Vec::new(),
                skipped_ids: Vec::new(),
            });
        }
        let conn = db.get_conn_safe()?;
        conn.execute("SAVEPOINT todo_batch_purge", [])?;

        let result = (|| -> VfsResult<TodoBatchIdsResult> {
            let mut affected_ids = Vec::with_capacity(ids.len());
            let mut skipped_ids = Vec::new();
            for id in &ids {
                match Self::purge_todo_item_with_conn(&conn, id) {
                    Ok(()) => affected_ids.push(id.clone()),
                    Err(VfsError::NotFound { .. }) | Err(VfsError::InvalidOperation { .. }) => {
                        skipped_ids.push(id.clone())
                    }
                    Err(e) => return Err(e),
                }
            }
            Ok(TodoBatchIdsResult {
                affected_ids,
                skipped_ids,
            })
        })();

        match result {
            Ok(out) => {
                conn.execute("RELEASE SAVEPOINT todo_batch_purge", [])?;
                info!(
                    "[VFS::TodoRepo] Batch purged {} items ({} skipped)",
                    out.affected_ids.len(),
                    out.skipped_ids.len()
                );
                Ok(out)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO SAVEPOINT todo_batch_purge", []);
                let _ = conn.execute("RELEASE SAVEPOINT todo_batch_purge", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 统计聚合（2026-07-20 新增：前端统计视图一次查询拿全）
    // ========================================================================

    /// 待办统计总览：总量/今日/逾期 + 近 N 天完成趋势 + 按清单/优先级/标签分布。
    ///
    /// - `days` clamp 1-366，趋势按本地日历日分桶（completed_at/created_at
    ///   为 UTC ISO 串，逐行转本地日，口径与 pomodoro get_daily_stats 一致）
    /// - 标签来自 tags_json（JSON 数组），Rust 侧解析聚合（不依赖 json1 扩展），
    ///   仅统计 pending/completed 两态，按总数降序取前 100
    pub fn stats_overview(db: &VfsDatabase, days: u32) -> VfsResult<TodoStatsOverview> {
        use chrono::{DateTime, Duration};

        let days = days.clamp(1, 366) as i64;
        let conn = db.get_conn_safe()?;
        let today = chrono::Local::now().date_naive();
        let today_str = today.format("%Y-%m-%d").to_string();
        let range_start_local = today - Duration::days(days - 1);
        let range_start_utc = local_date_start_utc_string(range_start_local);
        let (today_start_utc, today_end_utc) = local_today_utc_bounds();

        let total_pending: i64 = conn.query_row(
            "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND deleted_at IS NULL",
            [],
            |row| row.get(0),
        )?;
        let total_completed: i64 = conn.query_row(
            "SELECT COUNT(*) FROM todo_items WHERE status = 'completed' AND deleted_at IS NULL",
            [],
            |row| row.get(0),
        )?;
        let completed_today: i64 = conn.query_row(
            "SELECT COUNT(*) FROM todo_items WHERE status = 'completed' AND deleted_at IS NULL AND completed_at >= ?1 AND completed_at < ?2",
            params![today_start_utc, today_end_utc],
            |row| row.get(0),
        )?;
        let overdue_count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM todo_items WHERE status = 'pending' AND due_date < ?1 AND deleted_at IS NULL",
            params![today_str],
            |row| row.get(0),
        )?;

        // 趋势：预填完整日期序列（无数据天补零），逐行按本地日归桶
        let mut completion_trend: Vec<TodoDailyCompletionStat> = (0..days)
            .map(|i| TodoDailyCompletionStat {
                date: (range_start_local + Duration::days(i))
                    .format("%Y-%m-%d")
                    .to_string(),
                completed_count: 0,
                created_count: 0,
            })
            .collect();
        let bucket_index = |ts: &str| -> Option<usize> {
            match DateTime::parse_from_rfc3339(ts) {
                Ok(dt) => {
                    let idx = (dt.with_timezone(&chrono::Local).date_naive() - range_start_local)
                        .num_days();
                    if (0..days).contains(&idx) {
                        Some(idx as usize)
                    } else {
                        None
                    }
                }
                Err(e) => {
                    warn!(
                        "[VFS::TodoRepo] Skipping non-RFC3339 timestamp '{}' in stats overview: {}",
                        ts, e
                    );
                    None
                }
            }
        };
        {
            let mut stmt = conn.prepare(
                "SELECT completed_at FROM todo_items WHERE status = 'completed' AND deleted_at IS NULL AND completed_at >= ?1",
            )?;
            let completed: Vec<String> = stmt
                .query_map(params![range_start_utc], |row| row.get(0))?
                .filter_map(log_and_skip_err)
                .collect();
            for ts in completed {
                if let Some(idx) = bucket_index(&ts) {
                    completion_trend[idx].completed_count += 1;
                }
            }
            let mut stmt = conn.prepare(
                "SELECT created_at FROM todo_items WHERE deleted_at IS NULL AND created_at >= ?1",
            )?;
            let created: Vec<String> = stmt
                .query_map(params![range_start_utc], |row| row.get(0))?
                .filter_map(log_and_skip_err)
                .collect();
            for ts in created {
                if let Some(idx) = bucket_index(&ts) {
                    completion_trend[idx].created_count += 1;
                }
            }
        }

        // 按清单分布（一条聚合 SQL，顺序与 list_todo_lists 一致）
        let by_list: Vec<TodoListDistributionStat> = {
            let mut stmt = conn.prepare(
                r#"
                SELECT tl.id, tl.title,
                       COALESCE(SUM(CASE WHEN ti.status = 'pending' THEN 1 ELSE 0 END), 0),
                       COALESCE(SUM(CASE WHEN ti.status = 'completed' THEN 1 ELSE 0 END), 0)
                FROM todo_lists tl
                LEFT JOIN todo_items ti
                  ON ti.todo_list_id = tl.id AND ti.deleted_at IS NULL
                WHERE tl.deleted_at IS NULL
                GROUP BY tl.id
                ORDER BY tl.is_default DESC, tl.sort_order ASC, tl.updated_at DESC
                "#,
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(TodoListDistributionStat {
                        list_id: row.get(0)?,
                        list_title: row.get(1)?,
                        pending_count: row.get(2)?,
                        completed_count: row.get(3)?,
                    })
                })?
                .filter_map(log_and_skip_err)
                .collect();
            rows
        };

        // 按优先级分布（五档固定顺序，含 0）
        let by_priority: Vec<TodoPriorityDistributionStat> = {
            let mut stmt = conn.prepare(
                "SELECT priority, COUNT(*) FROM todo_items WHERE status = 'pending' AND deleted_at IS NULL GROUP BY priority",
            )?;
            let raw: Vec<(String, i64)> = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .filter_map(log_and_skip_err)
                .collect();
            ["urgent", "high", "medium", "low", "none"]
                .iter()
                .map(|p| TodoPriorityDistributionStat {
                    priority: (*p).to_string(),
                    pending_count: raw
                        .iter()
                        .find(|(k, _)| k == p)
                        .map(|(_, c)| *c)
                        .unwrap_or(0),
                })
                .collect()
        };

        // 按标签分布（Rust 侧解析 tags_json，避免依赖 json1 扩展）
        let by_tag: Vec<TodoTagDistributionStat> = {
            let mut stmt = conn.prepare(
                r#"
                SELECT tags_json, status FROM todo_items
                WHERE deleted_at IS NULL
                  AND status IN ('pending', 'completed')
                  AND tags_json IS NOT NULL AND tags_json != '' AND tags_json != '[]'
                "#,
            )?;
            let rows: Vec<(String, String)> = stmt
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .filter_map(log_and_skip_err)
                .collect();
            let mut tag_map: std::collections::BTreeMap<String, (i64, i64)> =
                std::collections::BTreeMap::new();
            for (tags_json, status) in rows {
                let Ok(tags) = serde_json::from_str::<Vec<String>>(&tags_json) else {
                    continue;
                };
                // 同一条目内重复标签只计一次
                let mut seen: HashSet<String> = HashSet::new();
                for tag in tags {
                    let tag = tag.trim().to_string();
                    if tag.is_empty() || !seen.insert(tag.clone()) {
                        continue;
                    }
                    let entry = tag_map.entry(tag).or_insert((0, 0));
                    match status.as_str() {
                        "pending" => entry.0 += 1,
                        "completed" => entry.1 += 1,
                        _ => {}
                    }
                }
            }
            let mut by_tag: Vec<TodoTagDistributionStat> = tag_map
                .into_iter()
                .map(|(tag, (pending, completed))| TodoTagDistributionStat {
                    tag,
                    pending_count: pending,
                    completed_count: completed,
                })
                .collect();
            by_tag.sort_by(|a, b| {
                (b.pending_count + b.completed_count)
                    .cmp(&(a.pending_count + a.completed_count))
                    .then_with(|| a.tag.cmp(&b.tag))
            });
            by_tag.truncate(100);
            by_tag
        };

        Ok(TodoStatsOverview {
            total_pending,
            total_completed,
            completed_today,
            overdue_count,
            completion_trend,
            by_list,
            by_priority,
            by_tag,
        })
    }

    /// 全量标签词表（`todo_list_all_tags` 命令；★ 2026-07-20 r3 补齐）。
    ///
    /// 与 `stats_overview.by_tag` 的差异（该路径为统计视图设计，
    /// 截断前 100 且不排除软删清单中的条目，口径保留不动）：
    /// - **无 100 上限**，全量返回；
    /// - 排除软删除条目 *与* 软删除清单中的条目（软删清单的条目
    ///   deleted_at 通常已同批置位，EXISTS 子句兜底历史脏数据）；
    /// - 不分状态，count = 含该标签的条目总数（同一条目内重复标签只计一次）。
    ///
    /// tags 以 `tags_json`（JSON 字符串数组文本）落库，沿用本仓库惯例在
    /// Rust 侧解析聚合（不依赖 SQLite json1 扩展）；SQL 先按
    /// `tags_json` 非空预过滤，只捞真正带标签的行。
    /// count 降序、同 count 按 tag 升序（BTreeMap 保证解析序稳定）。
    pub fn list_all_tags(db: &VfsDatabase) -> VfsResult<Vec<TagCountEntry>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT ti.tags_json FROM todo_items ti
            WHERE ti.deleted_at IS NULL
              AND ti.tags_json IS NOT NULL AND ti.tags_json != '' AND ti.tags_json != '[]'
              AND EXISTS(SELECT 1 FROM todo_lists l WHERE l.id = ti.todo_list_id AND l.deleted_at IS NULL)
            "#,
        )?;
        let rows: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .filter_map(log_and_skip_err)
            .collect();

        let mut tag_map: std::collections::BTreeMap<String, i64> =
            std::collections::BTreeMap::new();
        for tags_json in rows {
            let Ok(tags) = serde_json::from_str::<Vec<String>>(&tags_json) else {
                continue;
            };
            // 同一条目内重复标签只计一次（与 stats_overview.by_tag 口径一致）
            let mut seen: HashSet<String> = HashSet::new();
            for tag in tags {
                let tag = tag.trim().to_string();
                if tag.is_empty() || !seen.insert(tag.clone()) {
                    continue;
                }
                *tag_map.entry(tag).or_insert(0) += 1;
            }
        }

        let mut out: Vec<TagCountEntry> = tag_map
            .into_iter()
            .map(|(tag, count)| TagCountEntry { tag, count })
            .collect();
        out.sort_by(|a, b| b.count.cmp(&a.count).then_with(|| a.tag.cmp(&b.tag)));
        Ok(out)
    }

    /// 清单条目 + 直接子任务计数（N+1 消除：一次聚合 JOIN 取代
    /// "列表 + 每行一次子任务 COUNT"；排序/过滤/分页语义与
    /// `list_items_by_list_paged` 完全一致）。
    pub fn list_items_with_child_stats(
        db: &VfsDatabase,
        list_id: &str,
        include_completed: bool,
        limit: Option<u32>,
        offset: Option<u32>,
    ) -> VfsResult<Vec<TodoItemWithChildStats>> {
        let conn = db.get_conn_safe()?;
        let sql = if include_completed {
            r#"
            SELECT ti.id, ti.todo_list_id, ti.title, ti.description, ti.status, ti.priority, ti.due_date, ti.due_time, ti.reminder,
                   ti.tags_json, ti.sort_order, ti.parent_id, ti.completed_at, ti.repeat_json, ti.attachments_json, ti.estimated_pomodoros, ti.completed_pomodoros, ti.created_at, ti.updated_at, ti.deleted_at,
                   COALESCE(cs.total, 0), COALESCE(cs.done, 0)
            FROM todo_items ti
            LEFT JOIN (
                SELECT parent_id,
                       COUNT(*) AS total,
                       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS done
                FROM todo_items
                WHERE deleted_at IS NULL AND parent_id IS NOT NULL
                GROUP BY parent_id
            ) cs ON cs.parent_id = ti.id
            WHERE ti.todo_list_id = ?1 AND ti.deleted_at IS NULL
            ORDER BY
                CASE ti.status WHEN 'pending' THEN 0 WHEN 'completed' THEN 1 WHEN 'cancelled' THEN 2 END,
                ti.sort_order ASC,
                ti.created_at ASC
            LIMIT ?2 OFFSET ?3
            "#
        } else {
            r#"
            SELECT ti.id, ti.todo_list_id, ti.title, ti.description, ti.status, ti.priority, ti.due_date, ti.due_time, ti.reminder,
                   ti.tags_json, ti.sort_order, ti.parent_id, ti.completed_at, ti.repeat_json, ti.attachments_json, ti.estimated_pomodoros, ti.completed_pomodoros, ti.created_at, ti.updated_at, ti.deleted_at,
                   COALESCE(cs.total, 0), COALESCE(cs.done, 0)
            FROM todo_items ti
            LEFT JOIN (
                SELECT parent_id,
                       COUNT(*) AS total,
                       SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS done
                FROM todo_items
                WHERE deleted_at IS NULL AND parent_id IS NOT NULL
                GROUP BY parent_id
            ) cs ON cs.parent_id = ti.id
            WHERE ti.todo_list_id = ?1 AND ti.deleted_at IS NULL AND ti.status = 'pending'
            ORDER BY ti.sort_order ASC, ti.created_at ASC
            LIMIT ?2 OFFSET ?3
            "#
        };

        let limit_param: i64 = limit.map(|v| v as i64).unwrap_or(-1);
        let offset_param: i64 = offset.unwrap_or(0) as i64;
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![list_id, limit_param, offset_param], |row| {
            Ok(TodoItemWithChildStats {
                item: Self::row_to_todo_item(row)?,
                subtask_count: row.get(20)?,
                completed_subtask_count: row.get(21)?,
            })
        })?;
        Ok(rows.filter_map(log_and_skip_err).collect())
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
            expected_updated_at: None,
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
        assert!(
            ids.contains(&overdue.id.as_str()),
            "overdue pending should appear in today view"
        );
        assert_eq!(
            items.len(),
            2,
            "no-due and completed-overdue must be excluded"
        );
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
        let shifted = shift_reminder(
            "2026-06-11T21:00:00",
            date("2026-06-12"),
            date("2026-06-13"),
        );
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
        let completed =
            VfsTodoRepo::toggle_todo_item(&db, &item.id, None).expect("toggle complete");
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
        VfsTodoRepo::toggle_todo_item(&db, &item.id, None).expect("un-complete");
        VfsTodoRepo::toggle_todo_item(&db, &item.id, None).expect("re-complete");
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
        VfsTodoRepo::toggle_todo_item(&db, &no_due.id, None).expect("complete");

        // 无规则 → 不生成
        let plain = create_item(&db, &list.id, "普通任务", Some("2026-01-01".into()), None);
        VfsTodoRepo::toggle_todo_item(&db, &plain.id, None).expect("complete");

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
        assert!(
            !titles.contains(&"Child"),
            "child should not be a root entry"
        );

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

    #[test]
    fn agent_list_update_and_delete_enforce_atomic_occ() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "OCC");

        let (previous, updated) = VfsTodoRepo::update_todo_list_if_version(
            &db,
            &list.id,
            VfsUpdateTodoListParams {
                title: Some("OCC updated".to_string()),
                description: None,
                icon: None,
                color: None,
            },
            &list.updated_at,
        )
        .expect("fresh revision updates");
        assert_eq!(previous.title, "OCC");
        assert_eq!(updated.title, "OCC updated");
        assert_ne!(updated.updated_at, list.updated_at);

        let stale_update = VfsTodoRepo::update_todo_list_if_version(
            &db,
            &list.id,
            VfsUpdateTodoListParams {
                title: Some("stale".to_string()),
                description: None,
                icon: None,
                color: None,
            },
            &list.updated_at,
        )
        .expect_err("stale revision must conflict");
        assert!(stale_update.to_string().contains("TODO_CONFLICT"));

        let stale_delete =
            VfsTodoRepo::delete_todo_list_if_version(&db, &list.id, &list.updated_at)
                .expect_err("stale delete must conflict");
        assert!(stale_delete.to_string().contains("TODO_CONFLICT"));
        assert!(VfsTodoRepo::get_todo_list(&db, &list.id)
            .expect("read list")
            .is_some());
    }

    #[test]
    fn agent_item_delete_enforces_occ_and_is_restorable() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "Item OCC");
        let item = create_item(&db, &list.id, "Task", None, None);
        let updated = VfsTodoRepo::update_todo_item(
            &db,
            &item.id,
            VfsUpdateTodoItemParams {
                title: Some("Task updated".to_string()),
                expected_updated_at: Some(item.updated_at.clone()),
                ..Default::default()
            },
        )
        .expect("update item");

        let stale = VfsTodoRepo::delete_todo_item_if_version(&db, &item.id, &item.updated_at)
            .expect_err("stale delete must conflict");
        assert!(stale.to_string().contains("TODO_CONFLICT"));

        let previous = VfsTodoRepo::delete_todo_item_if_version(&db, &item.id, &updated.updated_at)
            .expect("fresh delete");
        assert_eq!(previous.title, "Task updated");
        assert!(VfsTodoRepo::get_todo_item(&db, &item.id)
            .expect("read deleted")
            .is_none());
        let restored = VfsTodoRepo::restore_todo_item(&db, &item.id).expect("restore");
        assert_eq!(restored.id, item.id);
    }

    #[test]
    fn agent_cannot_delete_default_inbox() {
        let (_temp_dir, db) = setup_test_db();
        let inbox = VfsTodoRepo::ensure_default_inbox(&db).expect("create inbox");
        let error = VfsTodoRepo::delete_todo_list_if_version(&db, &inbox.id, &inbox.updated_at)
            .expect_err("default inbox is protected");
        assert!(error.to_string().contains("delete_default_todo_list"));
    }

    #[test]
    fn agent_reorder_requires_exact_unique_list_membership() {
        let (_temp_dir, db) = setup_test_db();
        let list = create_list(&db, "Reorder");
        let first = create_item(&db, &list.id, "First", None, None);
        let second = create_item(&db, &list.id, "Second", None, None);
        let other_list = create_list(&db, "Other");
        let outside = create_item(&db, &other_list.id, "Outside", None, None);
        let revision = VfsTodoRepo::get_todo_list(&db, &list.id)
            .unwrap()
            .unwrap()
            .updated_at;

        for invalid in [
            vec![first.id.clone(), first.id.clone()],
            vec![first.id.clone()],
            vec![first.id.clone(), outside.id.clone()],
        ] {
            let error = VfsTodoRepo::reorder_items(&db, &list.id, &invalid, Some(&revision))
                .expect_err("partial/duplicate/external reorder must fail");
            assert!(error.to_string().contains("item_ids"));
            assert_eq!(
                VfsTodoRepo::get_todo_list(&db, &list.id)
                    .unwrap()
                    .unwrap()
                    .updated_at,
                revision,
                "failed reorder must roll back OCC version claim"
            );
        }

        VfsTodoRepo::reorder_items(
            &db,
            &list.id,
            &[second.id.clone(), first.id.clone()],
            Some(&revision),
        )
        .expect("exact reorder succeeds");
        let ordered = VfsTodoRepo::list_items_by_list(&db, &list.id, true).unwrap();
        assert_eq!(
            ordered
                .iter()
                .map(|item| item.id.as_str())
                .collect::<Vec<_>>(),
            vec![second.id.as_str(), first.id.as_str()]
        );
    }

    #[test]
    fn reorder_lists_requires_exact_unique_membership_and_persists_order() {
        let (_temp_dir, db) = setup_test_db();
        let a = create_list(&db, "Alpha");
        let b = create_list(&db, "Beta");
        let c = create_list(&db, "Gamma");

        for invalid in [
            vec![a.id.clone(), a.id.clone(), b.id.clone()], // 重复
            vec![a.id.clone(), b.id.clone()],               // 不完整
            vec![a.id.clone(), b.id.clone(), "tdl_missing".to_string()], // 未知 ID
        ] {
            let error = VfsTodoRepo::reorder_todo_lists(&db, &invalid)
                .expect_err("duplicate/partial/unknown reorder must fail");
            assert!(error.to_string().contains("list_ids"));
        }

        VfsTodoRepo::reorder_todo_lists(&db, &[c.id.clone(), a.id.clone(), b.id.clone()])
            .expect("exact reorder succeeds");
        let ordered = VfsTodoRepo::list_todo_lists(&db).expect("list lists");
        assert_eq!(
            ordered.iter().map(|l| l.id.as_str()).collect::<Vec<_>>(),
            vec![c.id.as_str(), a.id.as_str(), b.id.as_str()]
        );
        assert_eq!(
            ordered.iter().map(|l| l.sort_order).collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
        // updated_at 必须推进（云同步 LWW 依赖）
        assert_ne!(ordered[0].updated_at, c.updated_at);
    }

    #[test]
    fn move_todo_item_moves_subtree_to_target_list_tail() {
        let (_temp_dir, db) = setup_test_db();
        let source = create_list(&db, "Source");
        let target = create_list(&db, "Target");
        let existing = create_item(&db, &target.id, "Existing", None, None);
        let parent = create_item(&db, &source.id, "Parent", None, None);
        let child = create_item(&db, &source.id, "Child", None, Some(parent.id.clone()));
        let grandchild = create_item(&db, &source.id, "Grandchild", None, Some(child.id.clone()));

        let moved = VfsTodoRepo::move_todo_item(&db, &parent.id, &target.id)
            .expect("move subtree to target");
        assert_eq!(moved.todo_list_id, target.id);
        assert_eq!(moved.parent_id, None);
        assert_eq!(
            moved.sort_order,
            existing.sort_order + 1,
            "moved root appends to target top-level tail"
        );

        // 子树整体跟随，内部 parent 关系保留
        let moved_child = VfsTodoRepo::get_todo_item(&db, &child.id)
            .unwrap()
            .expect("child alive");
        assert_eq!(moved_child.todo_list_id, target.id);
        assert_eq!(moved_child.parent_id.as_deref(), Some(parent.id.as_str()));
        let moved_grandchild = VfsTodoRepo::get_todo_item(&db, &grandchild.id)
            .unwrap()
            .expect("grandchild alive");
        assert_eq!(moved_grandchild.todo_list_id, target.id);
        assert_eq!(
            moved_grandchild.parent_id.as_deref(),
            Some(child.id.as_str())
        );

        // 源清单已空
        let source_items = VfsTodoRepo::list_items_by_list(&db, &source.id, true).unwrap();
        assert!(source_items.is_empty());
    }

    #[test]
    fn move_todo_item_rejects_missing_or_deleted_target_list() {
        let (_temp_dir, db) = setup_test_db();
        let source = create_list(&db, "Source");
        let doomed = create_list(&db, "Doomed");
        let item = create_item(&db, &source.id, "Task", None, None);

        assert!(VfsTodoRepo::move_todo_item(&db, &item.id, "tdl_missing").is_err());

        VfsTodoRepo::delete_todo_list(&db, &doomed.id).expect("soft delete target");
        let error = VfsTodoRepo::move_todo_item(&db, &item.id, &doomed.id)
            .expect_err("deleted target must be rejected");
        assert!(error.to_string().contains("TodoList"));

        // 失败不应改变原条目
        let untouched = VfsTodoRepo::get_todo_item(&db, &item.id).unwrap().unwrap();
        assert_eq!(untouched.todo_list_id, source.id);
    }
}
