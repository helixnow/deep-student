//! 每日学习日志层（Daily Log）
//!
//! 三层记忆中的"工作层"（参考成熟代理运行时的 `memory/YYYY-MM-DD.md` 与 另一桌面代理实现
//! 每日工作日志）：
//! - append-only：每天一条记录，会话结束/重要事件时追加条目
//!   （例："做了 5 道二次函数题，错 2 道，均为符号错误"）
//! - **不注入** system prompt：日志笔记使用 `__daily_log_YYYY-MM-DD__` 系统
//!   标题命名，被 list/画像刷新/分类聚合的 `__` 前缀过滤规则天然排除；
//!   但**保持向量索引启用**，可经现有 memory_search（Lance 混合检索）召回
//! - tag 标记：`daily_log` + `_daily_log_date:YYYY-MM-DD`，类型 study（4000 字上限）、
//!   目的 systemic（检索加权最低，避免抢占普通记忆的召回位）
//! - 晋升管道（evolution.rs）扫描近 7 天日志，蒸馏进学习者画像

use std::sync::Arc;

use tracing::{debug, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::note_repo::VfsNoteRepo;
use crate::vfs::types::{VfsCreateNoteParams, VfsFolder, VfsUpdateNoteParams};

use super::service::{MemoryPurpose, MemoryService, MemoryType};

/// 日志文件夹（位于记忆根目录下）
pub const DAILY_LOG_FOLDER_TITLE: &str = "学习日志";
/// 用户可见 tag，标记该笔记为每日学习日志
pub const DAILY_LOG_TAG: &str = "daily_log";
/// 系统 tag 前缀：日志日期
pub const TAG_DAILY_LOG_DATE_PREFIX: &str = "_daily_log_date:";
/// 单日日志内容上限（与 study 类型 4000 字上限一致）
pub const DAILY_LOG_MAX_CHARS: usize = 4000;

/// 每日日志笔记标题：`__daily_log_2026-07-08__`
pub fn daily_log_note_title(date: &str) -> String {
    format!("__daily_log_{}__", date)
}

/// 今天的本地日期（YYYY-MM-DD）
pub fn today_local_date() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

/// 追加结果
#[derive(Debug, Clone)]
pub struct DailyLogAppendOutcome {
    pub note_id: String,
    /// 写入资源 ID（用于触发即时索引）；跳过写入时为 None
    pub resource_id: Option<String>,
    /// 是否实际追加（重复条目/空条目会被跳过）
    pub appended: bool,
    pub reason: String,
}

/// 单日日志（供晋升管道扫描）
#[derive(Debug, Clone)]
pub struct DailyLogRecord {
    pub date: String,
    pub note_id: String,
    pub content: String,
}

/// 定位（不创建）日志文件夹 ID
fn find_log_folder_id(
    vfs_db: &Arc<VfsDatabase>,
    root_id: &str,
) -> VfsResult<Option<String>> {
    let children = VfsFolderRepo::list_folders_by_parent(vfs_db, Some(root_id))?;
    Ok(children
        .iter()
        .find(|f| f.title == DAILY_LOG_FOLDER_TITLE)
        .map(|f| f.id.clone()))
}

/// 获取或创建日志文件夹
fn get_or_create_log_folder_id(vfs_db: &Arc<VfsDatabase>, root_id: &str) -> VfsResult<String> {
    if let Some(id) = find_log_folder_id(vfs_db, root_id)? {
        return Ok(id);
    }
    let folder = VfsFolder::new(
        DAILY_LOG_FOLDER_TITLE.to_string(),
        Some(root_id.to_string()),
        None,
        None,
    );
    VfsFolderRepo::create_folder(vfs_db, &folder)?;
    debug!("[DailyLog] Created daily log folder: {}", folder.id);
    Ok(folder.id)
}

/// 在日志文件夹下按标题查找笔记
fn find_log_note(
    vfs_db: &Arc<VfsDatabase>,
    folder_id: &str,
    title: &str,
) -> VfsResult<Option<(String, String)>> {
    use rusqlite::params;
    let conn = vfs_db.get_conn_safe()?;
    let found: Option<(String, String)> = conn
        .query_row(
            r#"
            SELECT n.id, n.resource_id FROM notes n
            JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
            WHERE n.title = ?1 AND fi.folder_id = ?2
              AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
            LIMIT 1
            "#,
            params![title, folder_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .ok();
    Ok(found)
}

/// 追加一条日志条目到"今天"的日志（外部入口）
pub fn append_entry(service: &MemoryService, entry: &str) -> VfsResult<DailyLogAppendOutcome> {
    append_entry_for_date(service, &today_local_date(), entry)
}

/// 追加一条日志条目到指定日期的日志
///
/// - 条目自动加 `- [HH:MM]` 前缀
/// - 同日内容完全相同的条目会被跳过（防重复 flush / 提取）
/// - 超过 4000 字上限时丢弃最旧的行，保持"最近优先"
pub fn append_entry_for_date(
    service: &MemoryService,
    date: &str,
    entry: &str,
) -> VfsResult<DailyLogAppendOutcome> {
    let entry = entry.trim();
    if entry.is_empty() {
        return Ok(DailyLogAppendOutcome {
            note_id: String::new(),
            resource_id: None,
            appended: false,
            reason: "空条目，跳过".to_string(),
        });
    }

    let vfs_db = service.vfs_db_ref().clone();
    let root_id = service.get_or_create_root_folder()?;
    let folder_id = get_or_create_log_folder_id(&vfs_db, &root_id)?;
    let title = daily_log_note_title(date);

    // 条目单行化，防止破坏日志的行结构
    let entry_single_line = entry.replace('\n', " ").replace('\r', " ");
    let time_str = chrono::Local::now().format("%H:%M").to_string();
    let new_line = format!("- [{}] {}", time_str, entry_single_line);

    match find_log_note(&vfs_db, &folder_id, &title)? {
        Some((note_id, resource_id)) => {
            let current = VfsNoteRepo::get_note_content(&vfs_db, &note_id)?.unwrap_or_default();

            // 去重：忽略时间戳前缀比较条目正文
            if lines_contain_entry(&current, &entry_single_line) {
                return Ok(DailyLogAppendOutcome {
                    note_id,
                    resource_id: None,
                    appended: false,
                    reason: "当日已有相同条目，跳过".to_string(),
                });
            }

            let mut lines: Vec<String> = current
                .lines()
                .filter(|l| !l.trim().is_empty())
                .map(|l| l.to_string())
                .collect();
            lines.push(new_line);
            let content = enforce_log_char_limit(lines);

            VfsNoteRepo::update_note(
                &vfs_db,
                &note_id,
                VfsUpdateNoteParams {
                    title: None,
                    content: Some(content),
                    tags: None,
                    expected_updated_at: None,
                },
            )?;
            if let Err(e) = VfsIndexStateRepo::mark_pending(&vfs_db, &resource_id) {
                warn!("[DailyLog] Failed to mark pending for indexing: {}", e);
            }
            debug!("[DailyLog] Appended entry to {} ({})", title, note_id);
            Ok(DailyLogAppendOutcome {
                note_id,
                resource_id: Some(resource_id),
                appended: true,
                reason: "已追加".to_string(),
            })
        }
        None => {
            // 每日首条：创建当日日志笔记（保持索引启用 → memory_search 可检索）
            let tags = vec![
                DAILY_LOG_TAG.to_string(),
                format!("{}{}", TAG_DAILY_LOG_DATE_PREFIX, date),
                MemoryType::Study.to_tag(),
                MemoryPurpose::Systemic.to_tag(),
            ];
            let note = VfsNoteRepo::create_note_in_folder(
                &vfs_db,
                VfsCreateNoteParams {
                    title,
                    content: new_line,
                    tags,
                },
                Some(&folder_id),
            )?;
            if let Err(e) = VfsIndexStateRepo::mark_pending(&vfs_db, &note.resource_id) {
                warn!("[DailyLog] Failed to mark pending for indexing: {}", e);
            }
            debug!("[DailyLog] Created daily log note for {}: {}", date, note.id);
            Ok(DailyLogAppendOutcome {
                note_id: note.id,
                resource_id: Some(note.resource_id),
                appended: true,
                reason: "已创建当日日志并写入首条".to_string(),
            })
        }
    }
}

/// 批量追加（flush / 自动提取路径用）；返回实际追加条数
pub fn append_entries(service: &MemoryService, entries: &[String]) -> usize {
    let mut appended = 0usize;
    for entry in entries {
        match append_entry(service, entry) {
            Ok(outcome) if outcome.appended => appended += 1,
            Ok(_) => {}
            Err(e) => warn!("[DailyLog] Failed to append entry: {}", e),
        }
    }
    appended
}

/// 扫描最近 N 天的日志（含今天；供晋升管道使用，按日期升序返回）
pub fn list_recent(service: &MemoryService, days: u32) -> VfsResult<Vec<DailyLogRecord>> {
    use rusqlite::params;

    let vfs_db = service.vfs_db_ref().clone();
    let Some(root_id) = service.get_root_folder_id()? else {
        return Ok(vec![]);
    };
    let Some(folder_id) = find_log_folder_id(&vfs_db, &root_id)? else {
        return Ok(vec![]);
    };

    let cutoff = chrono::Local::now() - chrono::Duration::days(i64::from(days.max(1)) - 1);
    let cutoff_date = cutoff.format("%Y-%m-%d").to_string();
    let cutoff_title = daily_log_note_title(&cutoff_date);

    let conn = vfs_db.get_conn_safe()?;
    let mut stmt = conn.prepare(
        r#"
        SELECT n.id, n.title FROM notes n
        JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
        WHERE fi.folder_id = ?1 AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
          AND n.title LIKE '!_!_daily!_log!_%!_!_' ESCAPE '!'
          AND n.title >= ?2
        ORDER BY n.title ASC
        "#,
    )?;
    let rows: Vec<(String, String)> = stmt
        .query_map(params![folder_id, cutoff_title], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .filter_map(|r| r.ok())
        .collect();
    drop(stmt);
    drop(conn);

    let mut records = Vec::with_capacity(rows.len());
    for (note_id, title) in rows {
        let Some(date) = parse_date_from_title(&title) else {
            continue;
        };
        let content = VfsNoteRepo::get_note_content(&vfs_db, &note_id)?.unwrap_or_default();
        if content.trim().is_empty() {
            continue;
        }
        records.push(DailyLogRecord {
            date,
            note_id,
            content,
        });
    }
    Ok(records)
}

/// 从标题 `__daily_log_YYYY-MM-DD__` 解析日期
fn parse_date_from_title(title: &str) -> Option<String> {
    title
        .strip_prefix("__daily_log_")
        .and_then(|s| s.strip_suffix("__"))
        .filter(|s| s.len() == 10)
        .map(|s| s.to_string())
}

/// 检查已有内容是否包含同一条目（忽略 `- [HH:MM] ` 时间戳前缀）
fn lines_contain_entry(content: &str, entry_body: &str) -> bool {
    content
        .lines()
        .any(|line| strip_entry_prefix(line).trim() == entry_body.trim())
}

/// 去掉行首的 `- [HH:MM] ` 前缀
fn strip_entry_prefix(line: &str) -> &str {
    let trimmed = line.trim_start();
    let Some(rest) = trimmed.strip_prefix("- [") else {
        return trimmed;
    };
    match rest.find("] ") {
        Some(pos) => &rest[pos + 2..],
        None => trimmed,
    }
}

/// 超上限时丢弃最旧的行（日志"最近优先"），返回拼好的内容
fn enforce_log_char_limit(lines: Vec<String>) -> String {
    let mut kept = lines;
    loop {
        let total: usize = kept.iter().map(|l| l.chars().count() + 1).sum();
        if total <= DAILY_LOG_MAX_CHARS || kept.len() <= 1 {
            break;
        }
        kept.remove(0);
    }
    kept.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_daily_log_note_title_and_parse() {
        let title = daily_log_note_title("2026-07-08");
        assert_eq!(title, "__daily_log_2026-07-08__");
        assert_eq!(
            parse_date_from_title(&title).as_deref(),
            Some("2026-07-08")
        );
        assert!(parse_date_from_title("__user_profile__").is_none());
        assert!(parse_date_from_title("__daily_log_bad__").is_none());
    }

    #[test]
    fn test_strip_entry_prefix() {
        assert_eq!(
            strip_entry_prefix("- [21:30] 做了 5 道二次函数题"),
            "做了 5 道二次函数题"
        );
        assert_eq!(strip_entry_prefix("普通行"), "普通行");
        assert_eq!(strip_entry_prefix("  - [08:01] x"), "x");
    }

    #[test]
    fn test_lines_contain_entry_ignores_timestamp() {
        let content = "- [09:00] 复习虚拟语气\n- [21:30] 做了 5 道二次函数题";
        assert!(lines_contain_entry(content, "做了 5 道二次函数题"));
        assert!(lines_contain_entry(content, "复习虚拟语气"));
        assert!(!lines_contain_entry(content, "做了 6 道二次函数题"));
    }

    #[test]
    fn test_enforce_log_char_limit_drops_oldest() {
        let long_line = "x".repeat(1000);
        let lines: Vec<String> = (0..10).map(|i| format!("- [10:0{}] {}", i, long_line)).collect();
        let result = enforce_log_char_limit(lines);
        assert!(result.chars().count() <= DAILY_LOG_MAX_CHARS);
        // 最新的行必须保留
        assert!(result.contains("- [10:09]"));
        // 最旧的行被丢弃
        assert!(!result.contains("- [10:00]"));
    }

    #[test]
    fn test_enforce_log_char_limit_keeps_single_oversize_line() {
        let lines = vec!["y".repeat(DAILY_LOG_MAX_CHARS + 100)];
        let result = enforce_log_char_limit(lines);
        // 单行超限时保留（不产生空日志）
        assert!(!result.is_empty());
    }
}
