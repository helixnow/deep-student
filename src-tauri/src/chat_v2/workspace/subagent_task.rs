//! 子代理任务管理器
//!
//! 管理子代理任务的持久化和重启恢复。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::sync::Arc;

use super::database::WorkspaceDatabase;

/// 子代理任务状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[derive(Default)]
pub enum SubagentTaskStatus {
    #[default]
    Pending,
    Running,
    Completed,
    Failed,
    Cancelled,
}

/// 子代理任务数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentTaskData {
    pub id: String,
    pub workspace_id: String,
    pub agent_session_id: String,
    pub skill_id: Option<String>,
    pub initial_task: Option<String>,
    pub status: SubagentTaskStatus,
    pub created_at: DateTime<Utc>,
    pub started_at: Option<DateTime<Utc>>,
    pub completed_at: Option<DateTime<Utc>>,
    pub result_summary: Option<String>,
}

impl SubagentTaskData {
    pub fn new(
        workspace_id: String,
        agent_session_id: String,
        skill_id: Option<String>,
        initial_task: Option<String>,
    ) -> Self {
        Self {
            id: format!("task_{}", ulid::Ulid::new()),
            workspace_id,
            agent_session_id,
            skill_id,
            initial_task,
            status: SubagentTaskStatus::Pending,
            created_at: Utc::now(),
            started_at: None,
            completed_at: None,
            result_summary: None,
        }
    }
}

/// 子代理任务错误
#[derive(Debug, thiserror::Error)]
pub enum SubagentTaskError {
    #[error("Database error: {0}")]
    Database(String),
    #[error("Task not found: {0}")]
    NotFound(String),
    #[error("Invalid status transition for task {task_id}: {from:?} -> {to:?}")]
    InvalidTransition {
        task_id: String,
        from: SubagentTaskStatus,
        to: SubagentTaskStatus,
    },
}

/// 子代理任务管理器
pub struct SubagentTaskManager {
    db: Arc<WorkspaceDatabase>,
}

fn parse_db_utc_datetime(value: String, field: &'static str) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(&value)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|err| {
            rusqlite::Error::FromSqlConversionFailure(
                0,
                rusqlite::types::Type::Text,
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    format!("Invalid RFC3339 in {field}: {err}"),
                )),
            )
        })
}

impl SubagentTaskManager {
    pub fn new(db: Arc<WorkspaceDatabase>) -> Self {
        Self { db }
    }

    /// 全部状态（用于从 [`Self::is_valid_transition`] 推导合法前驱列表）
    const ALL_STATUSES: [SubagentTaskStatus; 5] = [
        SubagentTaskStatus::Pending,
        SubagentTaskStatus::Running,
        SubagentTaskStatus::Completed,
        SubagentTaskStatus::Failed,
        SubagentTaskStatus::Cancelled,
    ];

    /// 状态的数据库字符串表示
    fn status_to_str(status: &SubagentTaskStatus) -> &'static str {
        match status {
            SubagentTaskStatus::Pending => "pending",
            SubagentTaskStatus::Running => "running",
            SubagentTaskStatus::Completed => "completed",
            SubagentTaskStatus::Failed => "failed",
            SubagentTaskStatus::Cancelled => "cancelled",
        }
    }

    /// 目标状态的合法前驱列表（含同状态幂等），渲染为 SQL IN 子句内容。
    /// 值全部来自可信常量 [`Self::status_to_str`]，可安全内插 SQL。
    fn allowed_predecessors_sql(to: &SubagentTaskStatus) -> String {
        Self::ALL_STATUSES
            .iter()
            .filter(|from| Self::is_valid_transition(from, to))
            .map(|s| format!("'{}'", Self::status_to_str(s)))
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// 校验任务状态机转换是否合法。
    ///
    /// 规则：
    /// - `Pending` → `Running` / `Cancelled` / `Failed`
    /// - `Running` → `Completed` / `Failed` / `Cancelled`
    /// - 终止状态（`Completed` / `Failed` / `Cancelled`）不允许任何外向转换
    /// - 同状态幂等（视为合法，便于重试场景）
    fn is_valid_transition(from: &SubagentTaskStatus, to: &SubagentTaskStatus) -> bool {
        if from == to {
            return true;
        }
        match (from, to) {
            (SubagentTaskStatus::Pending, SubagentTaskStatus::Running)
            | (SubagentTaskStatus::Pending, SubagentTaskStatus::Cancelled)
            | (SubagentTaskStatus::Pending, SubagentTaskStatus::Failed) => true,
            (SubagentTaskStatus::Running, SubagentTaskStatus::Completed)
            | (SubagentTaskStatus::Running, SubagentTaskStatus::Failed)
            | (SubagentTaskStatus::Running, SubagentTaskStatus::Cancelled) => true,
            _ => false,
        }
    }

    /// 创建新任务
    pub fn create_task(&self, task: &SubagentTaskData) -> Result<(), SubagentTaskError> {
        let conn = self
            .db
            .get_connection()
            .map_err(|e| SubagentTaskError::Database(e.to_string()))?;

        conn.execute(
            "INSERT INTO subagent_task (id, workspace_id, agent_session_id, skill_id, \
             initial_task, status, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                task.id,
                task.workspace_id,
                task.agent_session_id,
                task.skill_id,
                task.initial_task,
                format!("{:?}", task.status).to_lowercase(),
                task.created_at.to_rfc3339(),
            ],
        )
        .map_err(|e| SubagentTaskError::Database(e.to_string()))?;

        log::info!(
            "[SubagentTaskManager] Created task: id={}, agent={}",
            task.id,
            task.agent_session_id
        );

        Ok(())
    }

    /// 更新任务状态
    ///
    /// 转换以**单条原子 UPDATE** 完成：`WHERE id = ? AND status IN (合法前驱列表)`，
    /// 前驱列表由 [`Self::is_valid_transition`] 推导。`changes() == 0` 表示当前状态
    /// 不是合法前驱（或任务不存在），返回错误。消除了旧实现"读-判-写"的竞态窗口，
    /// 防止终止状态被反向覆盖或非法跨阶段跳转。
    pub fn update_status(
        &self,
        task_id: &str,
        status: SubagentTaskStatus,
        result_summary: Option<&str>,
    ) -> Result<(), SubagentTaskError> {
        let conn = self
            .db
            .get_connection()
            .map_err(|e| SubagentTaskError::Database(e.to_string()))?;

        let now = Utc::now().to_rfc3339();
        let status_str = Self::status_to_str(&status);
        let allowed_from = Self::allowed_predecessors_sql(&status);

        let changes = match status {
            SubagentTaskStatus::Running => conn.execute(
                &format!(
                    "UPDATE subagent_task SET status = ?1, started_at = COALESCE(started_at, ?2), completed_at = NULL \
                     WHERE id = ?3 AND status IN ({allowed_from})"
                ),
                rusqlite::params![status_str, now, task_id],
            ),
            SubagentTaskStatus::Completed
            | SubagentTaskStatus::Failed
            | SubagentTaskStatus::Cancelled => conn.execute(
                &format!(
                    "UPDATE subagent_task SET status = ?1, completed_at = ?2, result_summary = ?3 \
                     WHERE id = ?4 AND status IN ({allowed_from})"
                ),
                rusqlite::params![status_str, now, result_summary, task_id],
            ),
            SubagentTaskStatus::Pending => conn.execute(
                &format!(
                    "UPDATE subagent_task SET status = ?1, started_at = NULL, completed_at = NULL, result_summary = NULL \
                     WHERE id = ?2 AND status IN ({allowed_from})"
                ),
                rusqlite::params![status_str, task_id],
            ),
        }
        .map_err(|e| SubagentTaskError::Database(e.to_string()))?;

        if changes == 0 {
            // 未命中行：区分"任务不存在"与"非法转换"（此读仅用于错误报告，best-effort）
            let current_status_str: String = conn
                .query_row(
                    "SELECT status FROM subagent_task WHERE id = ?1",
                    [task_id],
                    |row| row.get::<_, String>(0),
                )
                .map_err(|e| match e {
                    rusqlite::Error::QueryReturnedNoRows => {
                        SubagentTaskError::NotFound(task_id.to_string())
                    }
                    other => SubagentTaskError::Database(other.to_string()),
                })?;
            let current_status = Self::parse_status(&current_status_str);
            log::warn!(
                "[SubagentTaskManager] Rejected invalid transition for task {}: {:?} -> {:?}",
                task_id,
                current_status,
                status
            );
            return Err(SubagentTaskError::InvalidTransition {
                task_id: task_id.to_string(),
                from: current_status,
                to: status,
            });
        }

        log::info!(
            "[SubagentTaskManager] Updated task status: id={}, status={:?}",
            task_id,
            status
        );

        Ok(())
    }

    /// 标记任务开始执行
    ///
    /// 委托原子转换路径：终态任务会被拒绝；`started_at` 用 COALESCE 保留首次值
    /// （重试再次进入 Running 不会覆盖任务真实开始时间）。
    pub fn mark_running(&self, task_id: &str) -> Result<(), SubagentTaskError> {
        self.update_status(task_id, SubagentTaskStatus::Running, None)
    }

    /// 标记任务完成
    pub fn mark_completed(
        &self,
        task_id: &str,
        result_summary: Option<&str>,
    ) -> Result<(), SubagentTaskError> {
        self.update_status(task_id, SubagentTaskStatus::Completed, result_summary)
    }

    /// 标记任务失败
    pub fn mark_failed(
        &self,
        task_id: &str,
        error_message: Option<&str>,
    ) -> Result<(), SubagentTaskError> {
        self.update_status(task_id, SubagentTaskStatus::Failed, error_message)
    }

    /// 获取任务
    pub fn get_task(&self, task_id: &str) -> Result<Option<SubagentTaskData>, SubagentTaskError> {
        let conn = self
            .db
            .get_connection()
            .map_err(|e| SubagentTaskError::Database(e.to_string()))?;

        let result = conn.query_row(
            "SELECT id, workspace_id, agent_session_id, skill_id, initial_task, \
             status, created_at, started_at, completed_at, result_summary \
             FROM subagent_task WHERE id = ?1",
            [task_id],
            |row| {
                Ok(SubagentTaskData {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    agent_session_id: row.get(2)?,
                    skill_id: row.get(3)?,
                    initial_task: row.get(4)?,
                    status: Self::parse_status(&row.get::<_, String>(5)?),
                    created_at: parse_db_utc_datetime(row.get::<_, String>(6)?, "created_at")?,
                    started_at: row
                        .get::<_, Option<String>>(7)?
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc)),
                    completed_at: row
                        .get::<_, Option<String>>(8)?
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc)),
                    result_summary: row.get(9)?,
                })
            },
        );

        match result {
            Ok(task) => Ok(Some(task)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(SubagentTaskError::Database(e.to_string())),
        }
    }

    /// 获取需要恢复的任务（pending 或 running 状态）
    pub fn get_tasks_to_restore(&self) -> Result<Vec<SubagentTaskData>, SubagentTaskError> {
        let conn = self
            .db
            .get_connection()
            .map_err(|e| SubagentTaskError::Database(e.to_string()))?;

        let mut stmt = conn
            .prepare(
                "SELECT id, workspace_id, agent_session_id, skill_id, initial_task, \
             status, created_at, started_at, completed_at, result_summary \
             FROM subagent_task WHERE status IN ('pending', 'running')",
            )
            .map_err(|e| SubagentTaskError::Database(e.to_string()))?;

        let tasks = stmt
            .query_map([], |row| {
                Ok(SubagentTaskData {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    agent_session_id: row.get(2)?,
                    skill_id: row.get(3)?,
                    initial_task: row.get(4)?,
                    status: Self::parse_status(&row.get::<_, String>(5)?),
                    created_at: parse_db_utc_datetime(row.get::<_, String>(6)?, "created_at")?,
                    started_at: row
                        .get::<_, Option<String>>(7)?
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc)),
                    completed_at: row
                        .get::<_, Option<String>>(8)?
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc)),
                    result_summary: row.get(9)?,
                })
            })
            .map_err(|e| SubagentTaskError::Database(e.to_string()))?;

        let mut result = Vec::new();
        for t in tasks.flatten() {
            result.push(t);
        }

        log::info!(
            "[SubagentTaskManager] Found {} tasks to restore",
            result.len()
        );
        Ok(result)
    }

    /// 获取代理的当前任务
    pub fn get_agent_task(
        &self,
        agent_session_id: &str,
    ) -> Result<Option<SubagentTaskData>, SubagentTaskError> {
        let conn = self
            .db
            .get_connection()
            .map_err(|e| SubagentTaskError::Database(e.to_string()))?;

        let result = conn.query_row(
            "SELECT id, workspace_id, agent_session_id, skill_id, initial_task, \
             status, created_at, started_at, completed_at, result_summary \
             FROM subagent_task WHERE agent_session_id = ?1 AND status IN ('pending', 'running') \
             ORDER BY created_at DESC LIMIT 1",
            [agent_session_id],
            |row| {
                Ok(SubagentTaskData {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    agent_session_id: row.get(2)?,
                    skill_id: row.get(3)?,
                    initial_task: row.get(4)?,
                    status: Self::parse_status(&row.get::<_, String>(5)?),
                    created_at: parse_db_utc_datetime(row.get::<_, String>(6)?, "created_at")?,
                    started_at: row
                        .get::<_, Option<String>>(7)?
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc)),
                    completed_at: row
                        .get::<_, Option<String>>(8)?
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc)),
                    result_summary: row.get(9)?,
                })
            },
        );

        match result {
            Ok(task) => Ok(Some(task)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(SubagentTaskError::Database(e.to_string())),
        }
    }

    fn parse_status(s: &str) -> SubagentTaskStatus {
        match s {
            "pending" => SubagentTaskStatus::Pending,
            "running" => SubagentTaskStatus::Running,
            "completed" => SubagentTaskStatus::Completed,
            "failed" => SubagentTaskStatus::Failed,
            "cancelled" => SubagentTaskStatus::Cancelled,
            _ => SubagentTaskStatus::Pending,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_manager() -> (TempDir, SubagentTaskManager) {
        let temp_dir = TempDir::new().expect("temp dir");
        let db = WorkspaceDatabase::new(temp_dir.path(), "ws_test").expect("workspace db");
        {
            let conn = db.get_connection().expect("conn");
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO workspace (id, name, status, creator_session_id, created_at, updated_at) \
                 VALUES (?1, ?2, 'active', ?3, ?4, ?4)",
                rusqlite::params!["ws_test", "test", "creator_sess", now],
            )
            .expect("insert workspace");
        }
        (temp_dir, SubagentTaskManager::new(Arc::new(db)))
    }

    fn make_task(manager: &SubagentTaskManager) -> SubagentTaskData {
        let agent_session_id = format!("agent_{}", ulid::Ulid::new());
        {
            let conn = manager.db.get_connection().expect("conn");
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO agent (session_id, workspace_id, role, status, joined_at, last_active_at) \
                 VALUES (?1, 'ws_test', 'worker', 'idle', ?2, ?2)",
                rusqlite::params![agent_session_id, now],
            )
            .expect("insert agent");
        }
        let task = SubagentTaskData::new(
            "ws_test".to_string(),
            agent_session_id,
            None,
            Some("test task".to_string()),
        );
        manager.create_task(&task).expect("create");
        task
    }

    #[test]
    fn is_valid_transition_pending_outbound() {
        assert!(SubagentTaskManager::is_valid_transition(
            &SubagentTaskStatus::Pending,
            &SubagentTaskStatus::Running
        ));
        assert!(SubagentTaskManager::is_valid_transition(
            &SubagentTaskStatus::Pending,
            &SubagentTaskStatus::Cancelled
        ));
        assert!(SubagentTaskManager::is_valid_transition(
            &SubagentTaskStatus::Pending,
            &SubagentTaskStatus::Failed
        ));
        assert!(!SubagentTaskManager::is_valid_transition(
            &SubagentTaskStatus::Pending,
            &SubagentTaskStatus::Completed
        ));
    }

    #[test]
    fn is_valid_transition_running_outbound() {
        assert!(SubagentTaskManager::is_valid_transition(
            &SubagentTaskStatus::Running,
            &SubagentTaskStatus::Completed
        ));
        assert!(SubagentTaskManager::is_valid_transition(
            &SubagentTaskStatus::Running,
            &SubagentTaskStatus::Failed
        ));
        assert!(SubagentTaskManager::is_valid_transition(
            &SubagentTaskStatus::Running,
            &SubagentTaskStatus::Cancelled
        ));
        assert!(!SubagentTaskManager::is_valid_transition(
            &SubagentTaskStatus::Running,
            &SubagentTaskStatus::Pending
        ));
    }

    #[test]
    fn is_valid_transition_terminal_states_reject_outbound() {
        for terminal in [
            SubagentTaskStatus::Completed,
            SubagentTaskStatus::Failed,
            SubagentTaskStatus::Cancelled,
        ] {
            for target in [
                SubagentTaskStatus::Pending,
                SubagentTaskStatus::Running,
                SubagentTaskStatus::Completed,
                SubagentTaskStatus::Failed,
                SubagentTaskStatus::Cancelled,
            ] {
                let expected = terminal == target;
                assert_eq!(
                    SubagentTaskManager::is_valid_transition(&terminal, &target),
                    expected,
                    "{:?} -> {:?}",
                    terminal,
                    target
                );
            }
        }
    }

    #[test]
    fn is_valid_transition_same_state_idempotent() {
        for state in [
            SubagentTaskStatus::Pending,
            SubagentTaskStatus::Running,
            SubagentTaskStatus::Completed,
            SubagentTaskStatus::Failed,
            SubagentTaskStatus::Cancelled,
        ] {
            assert!(SubagentTaskManager::is_valid_transition(&state, &state));
        }
    }

    #[test]
    fn update_status_happy_path_pending_to_running_to_completed() {
        let (_dir, manager) = setup_manager();
        let task = make_task(&manager);

        manager
            .update_status(&task.id, SubagentTaskStatus::Running, None)
            .expect("running");
        let after_running = manager.get_task(&task.id).unwrap().unwrap();
        assert_eq!(after_running.status, SubagentTaskStatus::Running);

        manager
            .update_status(&task.id, SubagentTaskStatus::Completed, Some("ok"))
            .expect("completed");
        let after_completed = manager.get_task(&task.id).unwrap().unwrap();
        assert_eq!(after_completed.status, SubagentTaskStatus::Completed);
    }

    #[test]
    fn update_status_rejects_completed_to_running() {
        let (_dir, manager) = setup_manager();
        let task = make_task(&manager);

        manager
            .update_status(&task.id, SubagentTaskStatus::Running, None)
            .expect("running");
        manager
            .update_status(&task.id, SubagentTaskStatus::Completed, None)
            .expect("completed");

        let err = manager
            .update_status(&task.id, SubagentTaskStatus::Running, None)
            .expect_err("must reject");
        match err {
            SubagentTaskError::InvalidTransition { from, to, task_id } => {
                assert_eq!(from, SubagentTaskStatus::Completed);
                assert_eq!(to, SubagentTaskStatus::Running);
                assert_eq!(task_id, task.id);
            }
            other => panic!("expected InvalidTransition, got {:?}", other),
        }

        let after = manager.get_task(&task.id).unwrap().unwrap();
        assert_eq!(after.status, SubagentTaskStatus::Completed);
    }

    #[test]
    fn update_status_rejects_pending_to_completed_skip() {
        let (_dir, manager) = setup_manager();
        let task = make_task(&manager);

        let err = manager
            .update_status(&task.id, SubagentTaskStatus::Completed, None)
            .expect_err("must reject skip");
        assert!(matches!(err, SubagentTaskError::InvalidTransition { .. }));

        let after = manager.get_task(&task.id).unwrap().unwrap();
        assert_eq!(after.status, SubagentTaskStatus::Pending);
    }

    #[test]
    fn update_status_idempotent_same_state() {
        let (_dir, manager) = setup_manager();
        let task = make_task(&manager);

        manager
            .update_status(&task.id, SubagentTaskStatus::Pending, None)
            .expect("pending->pending idempotent");

        manager
            .update_status(&task.id, SubagentTaskStatus::Running, None)
            .expect("running");
        manager
            .update_status(&task.id, SubagentTaskStatus::Running, None)
            .expect("running->running idempotent");
    }

    #[test]
    fn update_status_not_found_returns_error() {
        let (_dir, manager) = setup_manager();
        let err = manager
            .update_status("missing_task", SubagentTaskStatus::Running, None)
            .expect_err("not found");
        assert!(matches!(err, SubagentTaskError::NotFound(_)));
    }

    #[test]
    fn mark_running_rejected_on_terminal_task() {
        let (_dir, manager) = setup_manager();

        // Completed 终态：mark_running 必须被拒绝且状态不被覆盖
        let task = make_task(&manager);
        manager.mark_running(&task.id).expect("running");
        manager
            .update_status(&task.id, SubagentTaskStatus::Completed, Some("done"))
            .expect("completed");
        let err = manager
            .mark_running(&task.id)
            .expect_err("terminal task must reject mark_running");
        assert!(matches!(err, SubagentTaskError::InvalidTransition { .. }));
        let after = manager.get_task(&task.id).unwrap().unwrap();
        assert_eq!(after.status, SubagentTaskStatus::Completed);
        assert_eq!(after.result_summary.as_deref(), Some("done"));

        // Cancelled 终态同样拒绝
        let task2 = make_task(&manager);
        manager
            .update_status(
                &task2.id,
                SubagentTaskStatus::Cancelled,
                Some("user cancelled"),
            )
            .expect("cancelled");
        let err2 = manager
            .mark_running(&task2.id)
            .expect_err("cancelled task must reject mark_running");
        assert!(matches!(err2, SubagentTaskError::InvalidTransition { .. }));
        let after2 = manager.get_task(&task2.id).unwrap().unwrap();
        assert_eq!(after2.status, SubagentTaskStatus::Cancelled);
    }

    #[test]
    fn mark_running_preserves_first_started_at() {
        let (_dir, manager) = setup_manager();
        let task = make_task(&manager);

        manager.mark_running(&task.id).expect("first running");
        let first_started_at = manager
            .get_task(&task.id)
            .unwrap()
            .unwrap()
            .started_at
            .expect("started_at set");

        std::thread::sleep(std::time::Duration::from_millis(10));
        manager.mark_running(&task.id).expect("idempotent running");
        let second_started_at = manager
            .get_task(&task.id)
            .unwrap()
            .unwrap()
            .started_at
            .expect("started_at still set");

        assert_eq!(
            first_started_at, second_started_at,
            "started_at must not be overwritten by repeated mark_running"
        );
    }

    #[test]
    fn cancelled_task_excluded_from_restore() {
        let (_dir, manager) = setup_manager();

        let task_pending = make_task(&manager);
        let task_running = make_task(&manager);
        manager.mark_running(&task_running.id).expect("running");
        let task_cancelled = make_task(&manager);
        manager.mark_running(&task_cancelled.id).expect("running");
        manager
            .update_status(
                &task_cancelled.id,
                SubagentTaskStatus::Cancelled,
                Some("user cancelled"),
            )
            .expect("cancelled");

        let to_restore = manager.get_tasks_to_restore().expect("restore list");
        let ids: Vec<&str> = to_restore.iter().map(|t| t.id.as_str()).collect();
        assert!(ids.contains(&task_pending.id.as_str()), "pending restored");
        assert!(ids.contains(&task_running.id.as_str()), "running restored");
        assert!(
            !ids.contains(&task_cancelled.id.as_str()),
            "cancelled task must not be restored"
        );
    }
}
