//! 题目集同步冲突策略服务
//!
//! 实现本地-远程题目数据同步，包括：
//! - 冲突检测（基于 updated_at 和 content_hash）
//! - 冲突解决（保留本地/远程/较新版本/智能合并/手动选择）
//! - 同步状态追踪
//! - 批量操作支持
//!
//! ## 使用流程
//! 1. `sync_check` - 检查同步状态
//! 2. `sync_pull` - 拉取远程更新，检测冲突
//! 3. `resolve_conflicts` - 解决冲突
//! 4. `sync_push` - 推送本地更新

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use tracing::{info, warn};

use crate::vfs::database::VfsDatabase;

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err<T, E: std::fmt::Display>(result: Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[QuestionSync] Row parse error (skipped): {}", e);
            None
        }
    }
}
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::question_repo::{
    Difficulty, Question, QuestionImage, QuestionOption, QuestionStatus, QuestionType, SourceType,
};

// ============================================================================
// 同步策略枚举
// ============================================================================

/// 冲突解决策略
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum QuestionConflictStrategy {
    /// 保留本地版本
    KeepLocal,
    /// 保留远程版本
    KeepRemote,
    /// 保留更新时间较新的版本
    KeepNewer,
    /// 智能合并（字段级别）
    Merge,
    /// 手动选择（保持冲突状态，等待用户决定）
    Manual,
}

impl Default for QuestionConflictStrategy {
    fn default() -> Self {
        Self::KeepNewer
    }
}

impl QuestionConflictStrategy {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::KeepLocal => "keep_local",
            Self::KeepRemote => "keep_remote",
            Self::KeepNewer => "keep_newer",
            Self::Merge => "merge",
            Self::Manual => "manual",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "keep_local" => Self::KeepLocal,
            "keep_remote" => Self::KeepRemote,
            "keep_newer" => Self::KeepNewer,
            "merge" => Self::Merge,
            "manual" => Self::Manual,
            _ => Self::KeepNewer,
        }
    }
}

// ============================================================================
// 同步状态枚举
// ============================================================================

/// 同步状态
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SyncStatus {
    /// 仅本地存在（未同步）
    #[default]
    LocalOnly,
    /// 已同步（本地与远程一致）
    Synced,
    /// 本地已修改（待推送）
    Modified,
    /// 存在冲突
    Conflict,
    /// 远程已删除
    DeletedRemote,
}

impl SyncStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::LocalOnly => "local_only",
            Self::Synced => "synced",
            Self::Modified => "modified",
            Self::Conflict => "conflict",
            Self::DeletedRemote => "deleted_remote",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "local_only" => Self::LocalOnly,
            "synced" => Self::Synced,
            "modified" => Self::Modified,
            "conflict" => Self::Conflict,
            "deleted_remote" => Self::DeletedRemote,
            _ => Self::LocalOnly,
        }
    }
}

// ============================================================================
// 冲突类型枚举
// ============================================================================

/// 冲突类型
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ConflictType {
    /// 双方都修改了同一题目
    ModifyModify,
    /// 本地修改，远程删除
    ModifyDelete,
    /// 本地删除，远程修改
    DeleteModify,
    /// 双方都新增了相同 remote_id 的题目（罕见）
    AddAdd,
}

impl ConflictType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ModifyModify => "modify_modify",
            Self::ModifyDelete => "modify_delete",
            Self::DeleteModify => "delete_modify",
            Self::AddAdd => "add_add",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "modify_modify" => Self::ModifyModify,
            "modify_delete" => Self::ModifyDelete,
            "delete_modify" => Self::DeleteModify,
            "add_add" => Self::AddAdd,
            _ => Self::ModifyModify,
        }
    }
}

// ============================================================================
// 版本快照
// ============================================================================

/// 题目版本快照（用于冲突对比）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionVersion {
    /// 题目 ID
    pub id: String,
    /// 题干内容
    pub content: String,
    /// 选项
    pub options: Option<Vec<QuestionOption>>,
    /// 答案
    pub answer: Option<String>,
    /// 解析
    pub explanation: Option<String>,
    /// 题型
    pub question_type: QuestionType,
    /// 难度
    pub difficulty: Option<Difficulty>,
    /// 标签
    pub tags: Vec<String>,
    /// 学习状态
    pub status: QuestionStatus,
    /// 用户答案
    pub user_answer: Option<String>,
    /// 是否正确
    pub is_correct: Option<bool>,
    /// 尝试次数
    pub attempt_count: i32,
    /// 正确次数
    pub correct_count: i32,
    /// 用户笔记
    pub user_note: Option<String>,
    /// 收藏标记
    pub is_favorite: bool,
    /// 书签标记
    pub is_bookmarked: bool,
    /// 题目图片
    #[serde(default)]
    pub images: Vec<QuestionImage>,
    /// 内容哈希
    pub content_hash: String,
    /// 更新时间
    pub updated_at: String,
    /// 远程版本号
    pub remote_version: i32,
}

impl QuestionVersion {
    /// 从 Question 创建版本快照
    pub fn from_question(q: &Question, content_hash: &str, remote_version: i32) -> Self {
        Self {
            id: q.id.clone(),
            content: q.content.clone(),
            options: q.options.clone(),
            answer: q.answer.clone(),
            explanation: q.explanation.clone(),
            question_type: q.question_type.clone(),
            difficulty: q.difficulty.clone(),
            tags: q.tags.clone(),
            status: q.status.clone(),
            user_answer: q.user_answer.clone(),
            is_correct: q.is_correct,
            attempt_count: q.attempt_count,
            correct_count: q.correct_count,
            user_note: q.user_note.clone(),
            is_favorite: q.is_favorite,
            is_bookmarked: q.is_bookmarked,
            images: q.images.clone(),
            content_hash: content_hash.to_string(),
            updated_at: q.updated_at.clone(),
            remote_version,
        }
    }
}

// ============================================================================
// 同步冲突
// ============================================================================

/// 同步冲突记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncConflict {
    /// 冲突记录 ID
    pub id: String,
    /// 题目 ID
    pub question_id: String,
    /// 题目集 ID
    pub exam_id: String,
    /// 冲突类型
    pub conflict_type: ConflictType,
    /// 本地版本快照
    pub local_version: QuestionVersion,
    /// 远程版本快照
    pub remote_version: QuestionVersion,
    /// 冲突状态：pending | resolved | skipped
    pub status: String,
    /// 解决策略（如已解决）
    pub resolved_strategy: Option<String>,
    /// 解决时间
    pub resolved_at: Option<String>,
    /// 创建时间
    pub created_at: String,
}

// ============================================================================
// 同步错误
// ============================================================================

/// 同步错误
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncError {
    /// 题目 ID（如果有）
    pub question_id: Option<String>,
    /// 错误码
    pub code: String,
    /// 错误消息
    pub message: String,
    /// 是否可恢复
    pub recoverable: bool,
}

// ============================================================================
// 同步结果
// ============================================================================

/// 同步操作结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncResult {
    /// 同步的题目数量
    pub synced_count: u32,
    /// 新增的题目数量
    pub added_count: u32,
    /// 更新的题目数量
    pub updated_count: u32,
    /// 删除的题目数量
    pub deleted_count: u32,
    /// 冲突数量
    pub conflict_count: u32,
    /// 冲突列表
    pub conflicts: Vec<SyncConflict>,
    /// 错误列表
    pub errors: Vec<SyncError>,
    /// 是否成功
    pub success: bool,
    /// 同步方向：push | pull
    pub direction: String,
    /// 开始时间
    pub started_at: String,
    /// 完成时间
    pub completed_at: String,
}

impl Default for SyncResult {
    fn default() -> Self {
        let now = Utc::now().to_rfc3339();
        Self {
            synced_count: 0,
            added_count: 0,
            updated_count: 0,
            deleted_count: 0,
            conflict_count: 0,
            conflicts: vec![],
            errors: vec![],
            success: true,
            direction: "pull".to_string(),
            started_at: now.clone(),
            completed_at: now,
        }
    }
}

// ============================================================================
// 同步状态检查结果
// ============================================================================

/// 同步状态检查结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SyncStatusResult {
    /// 是否启用同步
    pub sync_enabled: bool,
    /// 最后同步时间
    pub last_synced_at: Option<String>,
    /// 本地修改数量（待推送）
    pub local_modified_count: u32,
    /// 待处理冲突数量
    pub pending_conflict_count: u32,
    /// 总题目数量
    pub total_count: u32,
    /// 已同步数量
    pub synced_count: u32,
    /// 同步配置
    pub sync_config: Option<SyncConfig>,
}

/// 同步配置
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SyncConfig {
    /// 默认冲突解决策略
    pub default_strategy: QuestionConflictStrategy,
    /// 是否自动同步
    pub auto_sync: bool,
    /// 同步间隔（秒）
    pub sync_interval_secs: u64,
    /// 是否同步学习进度
    pub sync_progress: bool,
    /// 是否同步用户笔记
    pub sync_notes: bool,
}

// ============================================================================
// 合并结果
// ============================================================================

/// 字段级合并结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MergeResult {
    /// 合并后的版本
    pub merged: QuestionVersion,
    /// 合并的字段
    pub merged_fields: Vec<String>,
    /// 冲突的字段（无法自动合并）
    pub conflicting_fields: Vec<String>,
    /// 是否完全合并成功
    pub fully_merged: bool,
}

// ============================================================================
// 远程题目（从云端接收的格式）
// ============================================================================

/// 远程题目数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RemoteQuestion {
    pub remote_id: String,
    pub content: String,
    pub options: Option<Vec<QuestionOption>>,
    pub answer: Option<String>,
    pub explanation: Option<String>,
    pub question_type: QuestionType,
    pub difficulty: Option<Difficulty>,
    pub tags: Vec<String>,
    pub status: QuestionStatus,
    pub user_answer: Option<String>,
    pub is_correct: Option<bool>,
    pub attempt_count: i32,
    pub correct_count: i32,
    pub user_note: Option<String>,
    pub is_favorite: bool,
    pub is_bookmarked: bool,
    #[serde(default)]
    pub images: Vec<QuestionImage>,
    pub content_hash: String,
    pub updated_at: String,
    pub remote_version: i32,
    pub deleted: bool,
}

// ============================================================================
// 同步服务
// ============================================================================

/// 题目同步服务
pub struct QuestionSyncService;

impl QuestionSyncService {
    // ========================================================================
    // 内容哈希计算
    // ========================================================================

    /// 计算题目内容哈希
    ///
    /// 基于核心内容字段计算 SHA256 哈希，用于检测内容变化。
    /// 包含字段：content, options, answer, explanation, question_type, difficulty, tags
    pub fn compute_content_hash(question: &Question) -> String {
        let mut hasher = Sha256::new();

        // 核心内容字段
        hasher.update(question.content.as_bytes());

        if let Some(opts) = &question.options {
            if let Ok(json) = serde_json::to_string(opts) {
                hasher.update(json.as_bytes());
            }
        }

        if let Some(answer) = &question.answer {
            hasher.update(answer.as_bytes());
        }

        if let Some(explanation) = &question.explanation {
            hasher.update(explanation.as_bytes());
        }

        hasher.update(question.question_type.as_str().as_bytes());

        if let Some(diff) = &question.difficulty {
            hasher.update(diff.as_str().as_bytes());
        }

        if let Ok(tags_json) = serde_json::to_string(&question.tags) {
            hasher.update(tags_json.as_bytes());
        }

        // 向后兼容：仅在有图片时纳入哈希
        if !question.images.is_empty() {
            if let Ok(json) = serde_json::to_string(&question.images) {
                hasher.update(json.as_bytes());
            }
        }

        let result = hasher.finalize();
        hex::encode(result)
    }

    /// 计算版本的内容哈希
    pub fn compute_version_hash(version: &QuestionVersion) -> String {
        let mut hasher = Sha256::new();

        hasher.update(version.content.as_bytes());

        if let Some(opts) = &version.options {
            if let Ok(json) = serde_json::to_string(opts) {
                hasher.update(json.as_bytes());
            }
        }

        if let Some(answer) = &version.answer {
            hasher.update(answer.as_bytes());
        }

        if let Some(explanation) = &version.explanation {
            hasher.update(explanation.as_bytes());
        }

        hasher.update(version.question_type.as_str().as_bytes());

        if let Some(diff) = &version.difficulty {
            hasher.update(diff.as_str().as_bytes());
        }

        if let Ok(tags_json) = serde_json::to_string(&version.tags) {
            hasher.update(tags_json.as_bytes());
        }

        // 向后兼容：仅在有图片时纳入哈希
        if !version.images.is_empty() {
            if let Ok(json) = serde_json::to_string(&version.images) {
                hasher.update(json.as_bytes());
            }
        }

        let result = hasher.finalize();
        hex::encode(result)
    }

    // ========================================================================
    // 同步状态检查
    // ========================================================================

    /// 检查同步状态
    pub fn check_sync_status(db: &VfsDatabase, exam_id: &str) -> VfsResult<SyncStatusResult> {
        let conn = db.get_conn_safe()?;
        Self::check_sync_status_with_conn(&conn, exam_id)
    }

    /// 检查同步状态（使用现有连接）
    pub fn check_sync_status_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<SyncStatusResult> {
        // 获取 exam_sheets 的同步配置
        let (sync_enabled, last_synced_at, sync_config_json): (
            i32,
            Option<String>,
            Option<String>,
        ) = conn
            .query_row(
                r#"
                SELECT COALESCE(sync_enabled, 0), last_synced_at, sync_config
                FROM exam_sheets
                WHERE id = ?1 AND deleted_at IS NULL
                "#,
                params![exam_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .map_err(|_| VfsError::NotFound {
                resource_type: "exam_sheet".to_string(),
                id: exam_id.to_string(),
            })?;

        // 解析同步配置
        let sync_config = sync_config_json.and_then(|json| serde_json::from_str(&json).ok());

        // 统计题目状态
        let stats: (u32, u32, u32) = conn.query_row(
            r#"
            SELECT
                COUNT(*) as total,
                COALESCE(SUM(CASE WHEN sync_status = 'synced' THEN 1 ELSE 0 END), 0) as synced,
                COALESCE(SUM(CASE WHEN sync_status = 'modified' THEN 1 ELSE 0 END), 0) as modified
            FROM questions
            WHERE exam_id = ?1 AND deleted_at IS NULL
            "#,
            params![exam_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )?;

        // 统计待处理冲突
        let pending_conflict_count: u32 = conn.query_row(
            r#"
            SELECT COUNT(*) FROM question_sync_conflicts
            WHERE exam_id = ?1 AND status = 'pending'
            "#,
            params![exam_id],
            |row| row.get(0),
        )?;

        Ok(SyncStatusResult {
            sync_enabled: sync_enabled != 0,
            last_synced_at,
            local_modified_count: stats.2,
            pending_conflict_count,
            total_count: stats.0,
            synced_count: stats.1,
            sync_config,
        })
    }

    // ========================================================================
    // 冲突检测
    // ========================================================================

    /// 检测本地与远程题目的冲突
    ///
    /// # Arguments
    /// * `local_questions` - 本地题目列表（包含同步元数据）
    /// * `remote_questions` - 远程题目列表
    ///
    /// # Returns
    /// * 检测到的冲突列表
    pub fn detect_conflicts(
        local_questions: &[LocalQuestionWithSync],
        remote_questions: &[RemoteQuestion],
    ) -> Vec<SyncConflict> {
        let mut conflicts = vec![];
        let now = Utc::now().to_rfc3339();

        // 建立远程题目索引（按 remote_id）
        let remote_map: HashMap<&str, &RemoteQuestion> = remote_questions
            .iter()
            .map(|q| (q.remote_id.as_str(), q))
            .collect();

        // 建立本地题目索引（按 remote_id）
        let local_map: HashMap<&str, &LocalQuestionWithSync> = local_questions
            .iter()
            .filter_map(|q| q.remote_id.as_ref().map(|rid| (rid.as_str(), q)))
            .collect();

        // 检测每个本地题目
        for local in local_questions {
            if let Some(remote_id) = &local.remote_id {
                if let Some(remote) = remote_map.get(remote_id.as_str()) {
                    // 远程存在，检查是否冲突
                    if remote.deleted {
                        // 远程已删除，本地已修改 => ModifyDelete 冲突
                        if local.sync_status == SyncStatus::Modified {
                            let conflict = Self::create_conflict(
                                &local.question,
                                &local.content_hash,
                                local.remote_version,
                                remote,
                                ConflictType::ModifyDelete,
                                &local.question.exam_id,
                                &now,
                            );
                            conflicts.push(conflict);
                        }
                    } else {
                        // 双方都存在且未删除，检查内容是否冲突
                        let local_hash = &local.content_hash;
                        let remote_hash = &remote.content_hash;

                        if local_hash != remote_hash {
                            // 内容不同
                            if local.sync_status == SyncStatus::Modified {
                                // 本地也有修改 => ModifyModify 冲突
                                let conflict = Self::create_conflict(
                                    &local.question,
                                    local_hash,
                                    local.remote_version,
                                    remote,
                                    ConflictType::ModifyModify,
                                    &local.question.exam_id,
                                    &now,
                                );
                                conflicts.push(conflict);
                            }
                            // 如果本地未修改，直接覆盖（不算冲突）
                        }
                    }
                }
                // 远程不存在：如果本地有 remote_id 但远程没有，可能是远程删除
            }
        }

        // 检测远程新增但本地也新增了相同 remote_id 的情况（罕见）
        for remote in remote_questions {
            if !remote.deleted {
                // 检查是否有本地题目没有 remote_id 但内容相似（这里简化处理，跳过）
            }
        }

        info!(
            "[QuestionSyncService] Detected {} conflicts",
            conflicts.len()
        );
        conflicts
    }

    /// 创建冲突记录
    fn create_conflict(
        local: &Question,
        local_hash: &str,
        local_remote_version: i32,
        remote: &RemoteQuestion,
        conflict_type: ConflictType,
        exam_id: &str,
        now: &str,
    ) -> SyncConflict {
        let id = format!("qsc_{}", nanoid::nanoid!(10));

        let local_version = QuestionVersion::from_question(local, local_hash, local_remote_version);

        let remote_version = QuestionVersion {
            id: remote.remote_id.clone(),
            content: remote.content.clone(),
            options: remote.options.clone(),
            answer: remote.answer.clone(),
            explanation: remote.explanation.clone(),
            question_type: remote.question_type.clone(),
            difficulty: remote.difficulty.clone(),
            tags: remote.tags.clone(),
            status: remote.status.clone(),
            user_answer: remote.user_answer.clone(),
            is_correct: remote.is_correct,
            attempt_count: remote.attempt_count,
            correct_count: remote.correct_count,
            user_note: remote.user_note.clone(),
            is_favorite: remote.is_favorite,
            is_bookmarked: remote.is_bookmarked,
            images: remote.images.clone(),
            content_hash: remote.content_hash.clone(),
            updated_at: remote.updated_at.clone(),
            remote_version: remote.remote_version,
        };

        SyncConflict {
            id,
            question_id: local.id.clone(),
            exam_id: exam_id.to_string(),
            conflict_type,
            local_version,
            remote_version,
            status: "pending".to_string(),
            resolved_strategy: None,
            resolved_at: None,
            created_at: now.to_string(),
        }
    }

    // ========================================================================
    // 冲突解决
    // ========================================================================

    /// 解决单个冲突
    pub fn resolve_conflict(
        db: &VfsDatabase,
        conflict_id: &str,
        strategy: QuestionConflictStrategy,
    ) -> VfsResult<Question> {
        let conn = db.get_conn_safe()?;
        Self::resolve_conflict_with_conn(&conn, conflict_id, strategy)
    }

    /// 解决单个冲突（使用现有连接）
    pub fn resolve_conflict_with_conn(
        conn: &Connection,
        conflict_id: &str,
        strategy: QuestionConflictStrategy,
    ) -> VfsResult<Question> {
        // 获取冲突记录
        let conflict =
            Self::get_conflict_with_conn(conn, conflict_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "sync_conflict".to_string(),
                id: conflict_id.to_string(),
            })?;

        if conflict.status != "pending" {
            return Err(VfsError::InvalidOperation {
                operation: "resolve_conflict".to_string(),
                reason: format!("Conflict {} is already {}", conflict_id, conflict.status),
            });
        }

        let now = Utc::now().to_rfc3339();
        let question_id = &conflict.question_id;

        // 根据策略解决冲突
        let resolved_version = match strategy {
            QuestionConflictStrategy::KeepLocal => {
                // 保留本地版本，更新同步状态
                Self::apply_keep_local(conn, question_id, &conflict.local_version, &now)?
            }
            QuestionConflictStrategy::KeepRemote => {
                // 应用远程版本
                Self::apply_remote_version(conn, question_id, &conflict.remote_version, &now)?
            }
            QuestionConflictStrategy::KeepNewer => {
                // 比较更新时间
                let local_ts = &conflict.local_version.updated_at;
                let local_time = DateTime::parse_from_rfc3339(local_ts)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|e| {
                        log::warn!("[QuestionSyncService] Failed to parse timestamp '{}': {}, using epoch fallback", local_ts, e);
                        DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                    });
                let remote_ts = &conflict.remote_version.updated_at;
                let remote_time = DateTime::parse_from_rfc3339(remote_ts)
                    .map(|dt| dt.with_timezone(&Utc))
                    .unwrap_or_else(|e| {
                        log::warn!("[QuestionSyncService] Failed to parse timestamp '{}': {}, using epoch fallback", remote_ts, e);
                        DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                    });

                if local_time >= remote_time {
                    Self::apply_keep_local(conn, question_id, &conflict.local_version, &now)?
                } else {
                    Self::apply_remote_version(conn, question_id, &conflict.remote_version, &now)?
                }
            }
            QuestionConflictStrategy::Merge => {
                // 智能合并
                let merge_result =
                    Self::merge_versions(&conflict.local_version, &conflict.remote_version);
                if merge_result.fully_merged {
                    Self::apply_merged_version(conn, question_id, &merge_result.merged, &now)?
                } else {
                    // 无法完全合并，保留较新版本
                    let local_ts = &conflict.local_version.updated_at;
                    let local_time =
                        DateTime::parse_from_rfc3339(local_ts)
                            .map(|dt| dt.with_timezone(&Utc))
                            .unwrap_or_else(|e| {
                                log::warn!("[QuestionSyncService] Failed to parse timestamp '{}': {}, using epoch fallback", local_ts, e);
                                DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                            });
                    let remote_ts = &conflict.remote_version.updated_at;
                    let remote_time =
                        DateTime::parse_from_rfc3339(remote_ts)
                            .map(|dt| dt.with_timezone(&Utc))
                            .unwrap_or_else(|e| {
                                log::warn!("[QuestionSyncService] Failed to parse timestamp '{}': {}, using epoch fallback", remote_ts, e);
                                DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                            });

                    if local_time >= remote_time {
                        Self::apply_keep_local(conn, question_id, &conflict.local_version, &now)?
                    } else {
                        Self::apply_remote_version(
                            conn,
                            question_id,
                            &conflict.remote_version,
                            &now,
                        )?
                    }
                }
            }
            QuestionConflictStrategy::Manual => {
                // 手动模式不自动解决，保持冲突状态
                return Err(VfsError::InvalidOperation {
                    operation: "resolve_conflict".to_string(),
                    reason: "Manual strategy requires explicit version selection".to_string(),
                });
            }
        };

        // 更新冲突状态为已解决
        conn.execute(
            r#"
            UPDATE question_sync_conflicts
            SET status = 'resolved', resolved_strategy = ?1, resolved_at = ?2
            WHERE id = ?3
            "#,
            params![strategy.as_str(), now, conflict_id],
        )?;

        info!(
            "[QuestionSyncService] Resolved conflict id={} with strategy={}",
            conflict_id,
            strategy.as_str()
        );

        // 返回解决后的题目
        Self::get_question_by_id(conn, question_id)
    }

    /// 批量解决冲突
    pub fn batch_resolve_conflicts(
        db: &VfsDatabase,
        exam_id: &str,
        strategy: QuestionConflictStrategy,
    ) -> VfsResult<Vec<Question>> {
        let conn = db.get_conn_safe()?;
        Self::batch_resolve_conflicts_with_conn(&conn, exam_id, strategy)
    }

    /// 批量解决冲突（使用现有连接）
    pub fn batch_resolve_conflicts_with_conn(
        conn: &Connection,
        exam_id: &str,
        strategy: QuestionConflictStrategy,
    ) -> VfsResult<Vec<Question>> {
        if strategy == QuestionConflictStrategy::Manual {
            return Err(VfsError::InvalidOperation {
                operation: "batch_resolve_conflicts".to_string(),
                reason: "Manual strategy cannot be used for batch resolution".to_string(),
            });
        }

        // 获取所有待处理冲突
        let conflicts = Self::list_pending_conflicts_with_conn(conn, exam_id)?;
        let mut resolved = vec![];

        for conflict in conflicts {
            match Self::resolve_conflict_with_conn(conn, &conflict.id, strategy) {
                Ok(question) => resolved.push(question),
                Err(e) => {
                    warn!(
                        "[QuestionSyncService] Failed to resolve conflict {}: {:?}",
                        conflict.id, e
                    );
                }
            }
        }

        info!(
            "[QuestionSyncService] Batch resolved {} conflicts for exam_id={}",
            resolved.len(),
            exam_id
        );

        Ok(resolved)
    }

    // ========================================================================
    // 版本应用
    // ========================================================================

    /// 保留本地版本
    fn apply_keep_local(
        conn: &Connection,
        question_id: &str,
        local_version: &QuestionVersion,
        now: &str,
    ) -> VfsResult<()> {
        // 更新同步状态为 synced，保留本地内容
        conn.execute(
            r#"
            UPDATE questions SET
                sync_status = 'synced',
                last_synced_at = ?1,
                content_hash = ?2,
                remote_version = remote_version + 1,
                updated_at = ?1
            WHERE id = ?3 AND deleted_at IS NULL
            "#,
            params![now, local_version.content_hash, question_id],
        )?;
        Ok(())
    }

    /// 应用远程版本
    fn apply_remote_version(
        conn: &Connection,
        question_id: &str,
        remote_version: &QuestionVersion,
        now: &str,
    ) -> VfsResult<()> {
        let options_json = remote_version
            .options
            .as_ref()
            .map(|opts| serde_json::to_string(opts).unwrap_or_default());
        let tags_json =
            serde_json::to_string(&remote_version.tags).unwrap_or_else(|_| "[]".to_string());

        let images_json =
            serde_json::to_string(&remote_version.images).unwrap_or_else(|_| "[]".to_string());

        conn.execute(
            r#"
            UPDATE questions SET
                content = ?1,
                options_json = ?2,
                answer = ?3,
                explanation = ?4,
                question_type = ?5,
                difficulty = ?6,
                tags = ?7,
                status = ?8,
                user_answer = ?9,
                is_correct = ?10,
                attempt_count = ?11,
                correct_count = ?12,
                user_note = ?13,
                is_favorite = ?14,
                is_bookmarked = ?15,
                images_json = ?16,
                sync_status = 'synced',
                last_synced_at = ?17,
                content_hash = ?18,
                remote_version = ?19,
                updated_at = ?17
            WHERE id = ?20 AND deleted_at IS NULL
            "#,
            params![
                remote_version.content,
                options_json,
                remote_version.answer,
                remote_version.explanation,
                remote_version.question_type.as_str(),
                remote_version.difficulty.as_ref().map(|d| d.as_str()),
                tags_json,
                remote_version.status.as_str(),
                remote_version.user_answer,
                remote_version.is_correct.map(|b| if b { 1 } else { 0 }),
                remote_version.attempt_count,
                remote_version.correct_count,
                remote_version.user_note,
                if remote_version.is_favorite { 1 } else { 0 },
                if remote_version.is_bookmarked { 1 } else { 0 },
                images_json,
                now,
                remote_version.content_hash,
                remote_version.remote_version,
                question_id,
            ],
        )?;
        Ok(())
    }

    /// 应用合并后的版本
    fn apply_merged_version(
        conn: &Connection,
        question_id: &str,
        merged: &QuestionVersion,
        now: &str,
    ) -> VfsResult<()> {
        let options_json = merged
            .options
            .as_ref()
            .map(|opts| serde_json::to_string(opts).unwrap_or_default());
        let tags_json = serde_json::to_string(&merged.tags).unwrap_or_else(|_| "[]".to_string());
        let images_json =
            serde_json::to_string(&merged.images).unwrap_or_else(|_| "[]".to_string());
        let new_hash = Self::compute_version_hash(merged);

        conn.execute(
            r#"
            UPDATE questions SET
                content = ?1,
                options_json = ?2,
                answer = ?3,
                explanation = ?4,
                question_type = ?5,
                difficulty = ?6,
                tags = ?7,
                status = ?8,
                user_answer = ?9,
                is_correct = ?10,
                attempt_count = ?11,
                correct_count = ?12,
                user_note = ?13,
                is_favorite = ?14,
                is_bookmarked = ?15,
                images_json = ?16,
                sync_status = 'synced',
                last_synced_at = ?17,
                content_hash = ?18,
                remote_version = ?19,
                updated_at = ?17
            WHERE id = ?20 AND deleted_at IS NULL
            "#,
            params![
                merged.content,
                options_json,
                merged.answer,
                merged.explanation,
                merged.question_type.as_str(),
                merged.difficulty.as_ref().map(|d| d.as_str()),
                tags_json,
                merged.status.as_str(),
                merged.user_answer,
                merged.is_correct.map(|b| if b { 1 } else { 0 }),
                merged.attempt_count,
                merged.correct_count,
                merged.user_note,
                if merged.is_favorite { 1 } else { 0 },
                if merged.is_bookmarked { 1 } else { 0 },
                images_json,
                now,
                new_hash,
                merged.remote_version + 1,
                question_id,
            ],
        )?;
        Ok(())
    }

    // ========================================================================
    // 智能合并
    // ========================================================================

    /// 智能合并两个版本
    ///
    /// 合并策略：
    /// - 内容字段（content, answer, explanation）：如果只有一方修改，取修改方
    /// - 学习进度字段（attempt_count, correct_count）：取最大值
    /// - 状态字段：根据学习进度推断
    /// - 标签：合并去重
    /// - 笔记：合并（用换行分隔）
    pub fn merge_versions(local: &QuestionVersion, remote: &QuestionVersion) -> MergeResult {
        let mut merged = local.clone();
        let mut merged_fields = vec![];
        let mut conflicting_fields = vec![];

        // 合并内容字段
        if local.content != remote.content {
            // 内容冲突，无法自动合并
            conflicting_fields.push("content".to_string());
        }

        // 合并答案
        if local.answer != remote.answer {
            if local.answer.is_none() && remote.answer.is_some() {
                merged.answer = remote.answer.clone();
                merged_fields.push("answer".to_string());
            } else if local.answer.is_some() && remote.answer.is_none() {
                // 保留本地
            } else {
                // 双方都有且不同
                conflicting_fields.push("answer".to_string());
            }
        }

        // 合并解析
        if local.explanation != remote.explanation {
            if local.explanation.is_none() && remote.explanation.is_some() {
                merged.explanation = remote.explanation.clone();
                merged_fields.push("explanation".to_string());
            } else if local.explanation.is_some() && remote.explanation.is_none() {
                // 保留本地
            } else {
                // 双方都有且不同
                conflicting_fields.push("explanation".to_string());
            }
        }

        // 合并选项
        if local.options != remote.options {
            conflicting_fields.push("options".to_string());
        }

        // 合并标签（取并集）
        let mut all_tags: Vec<String> = local.tags.clone();
        for tag in &remote.tags {
            if !all_tags.contains(tag) {
                all_tags.push(tag.clone());
            }
        }
        if all_tags != local.tags {
            merged.tags = all_tags;
            merged_fields.push("tags".to_string());
        }

        // 合并学习进度（取最大值）
        if remote.attempt_count > local.attempt_count {
            merged.attempt_count = remote.attempt_count;
            merged_fields.push("attempt_count".to_string());
        }
        if remote.correct_count > local.correct_count {
            merged.correct_count = remote.correct_count;
            merged_fields.push("correct_count".to_string());
        }

        // 合并笔记
        match (&local.user_note, &remote.user_note) {
            (Some(l), Some(r)) if l != r => {
                merged.user_note = Some(format!("{}\n---\n{}", l, r));
                merged_fields.push("user_note".to_string());
            }
            (None, Some(r)) => {
                merged.user_note = Some(r.clone());
                merged_fields.push("user_note".to_string());
            }
            _ => {}
        }

        // 合并收藏/书签（取 OR）
        if remote.is_favorite && !local.is_favorite {
            merged.is_favorite = true;
            merged_fields.push("is_favorite".to_string());
        }
        if remote.is_bookmarked && !local.is_bookmarked {
            merged.is_bookmarked = true;
            merged_fields.push("is_bookmarked".to_string());
        }

        // 合并图片（取并集，按 id 去重）
        if local.images != remote.images {
            let mut all_images = local.images.clone();
            for img in &remote.images {
                if !all_images.iter().any(|existing| existing.id == img.id) {
                    all_images.push(img.clone());
                }
            }
            if all_images.len() != local.images.len() {
                merged.images = all_images;
                merged_fields.push("images".to_string());
            }
        }

        let fully_merged = conflicting_fields.is_empty();

        MergeResult {
            merged,
            merged_fields,
            conflicting_fields,
            fully_merged,
        }
    }

    // ========================================================================
    // 冲突管理
    // ========================================================================

    /// 获取单个冲突
    pub fn get_conflict(db: &VfsDatabase, conflict_id: &str) -> VfsResult<Option<SyncConflict>> {
        let conn = db.get_conn_safe()?;
        Self::get_conflict_with_conn(&conn, conflict_id)
    }

    /// 获取单个冲突（使用现有连接）
    pub fn get_conflict_with_conn(
        conn: &Connection,
        conflict_id: &str,
    ) -> VfsResult<Option<SyncConflict>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, question_id, exam_id, conflict_type, local_snapshot, remote_snapshot,
                   status, resolved_strategy, resolved_at, created_at
            FROM question_sync_conflicts
            WHERE id = ?1
            "#,
        )?;

        let conflict = stmt
            .query_row(params![conflict_id], |row| {
                let local_snapshot_json: String = row.get(4)?;
                let remote_snapshot_json: String = row.get(5)?;
                let conflict_type_str: String = row.get(3)?;

                let local_version: QuestionVersion = serde_json::from_str(&local_snapshot_json)
                    .unwrap_or_else(|_| QuestionVersion {
                        id: String::new(),
                        content: String::new(),
                        options: None,
                        answer: None,
                        explanation: None,
                        question_type: QuestionType::Other,
                        difficulty: None,
                        tags: vec![],
                        status: QuestionStatus::New,
                        user_answer: None,
                        is_correct: None,
                        attempt_count: 0,
                        correct_count: 0,
                        user_note: None,
                        is_favorite: false,
                        is_bookmarked: false,
                        images: vec![],
                        content_hash: String::new(),
                        updated_at: String::new(),
                        remote_version: 0,
                    });

                let remote_version: QuestionVersion = serde_json::from_str(&remote_snapshot_json)
                    .unwrap_or_else(|_| QuestionVersion {
                        id: String::new(),
                        content: String::new(),
                        options: None,
                        answer: None,
                        explanation: None,
                        question_type: QuestionType::Other,
                        difficulty: None,
                        tags: vec![],
                        status: QuestionStatus::New,
                        user_answer: None,
                        is_correct: None,
                        attempt_count: 0,
                        correct_count: 0,
                        user_note: None,
                        is_favorite: false,
                        is_bookmarked: false,
                        images: vec![],
                        content_hash: String::new(),
                        updated_at: String::new(),
                        remote_version: 0,
                    });

                Ok(SyncConflict {
                    id: row.get(0)?,
                    question_id: row.get(1)?,
                    exam_id: row.get(2)?,
                    conflict_type: ConflictType::from_str(&conflict_type_str),
                    local_version,
                    remote_version,
                    status: row.get(6)?,
                    resolved_strategy: row.get(7)?,
                    resolved_at: row.get(8)?,
                    created_at: row.get(9)?,
                })
            })
            .optional()?;

        Ok(conflict)
    }

    /// 列出待处理冲突
    pub fn list_pending_conflicts(db: &VfsDatabase, exam_id: &str) -> VfsResult<Vec<SyncConflict>> {
        let conn = db.get_conn_safe()?;
        Self::list_pending_conflicts_with_conn(&conn, exam_id)
    }

    /// 列出待处理冲突（使用现有连接）
    pub fn list_pending_conflicts_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<Vec<SyncConflict>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, question_id, exam_id, conflict_type, local_snapshot, remote_snapshot,
                   status, resolved_strategy, resolved_at, created_at
            FROM question_sync_conflicts
            WHERE exam_id = ?1 AND status = 'pending'
            ORDER BY created_at DESC
            "#,
        )?;

        let rows = stmt.query_map(params![exam_id], |row| {
            let local_snapshot_json: String = row.get(4)?;
            let remote_snapshot_json: String = row.get(5)?;
            let conflict_type_str: String = row.get(3)?;

            let local_version: QuestionVersion = serde_json::from_str(&local_snapshot_json)
                .unwrap_or_else(|_| QuestionVersion {
                    id: String::new(),
                    content: String::new(),
                    options: None,
                    answer: None,
                    explanation: None,
                    question_type: QuestionType::Other,
                    difficulty: None,
                    tags: vec![],
                    status: QuestionStatus::New,
                    user_answer: None,
                    is_correct: None,
                    attempt_count: 0,
                    correct_count: 0,
                    user_note: None,
                    is_favorite: false,
                    is_bookmarked: false,
                    images: vec![],
                    content_hash: String::new(),
                    updated_at: String::new(),
                    remote_version: 0,
                });

            let remote_version: QuestionVersion = serde_json::from_str(&remote_snapshot_json)
                .unwrap_or_else(|_| QuestionVersion {
                    id: String::new(),
                    content: String::new(),
                    options: None,
                    answer: None,
                    explanation: None,
                    question_type: QuestionType::Other,
                    difficulty: None,
                    tags: vec![],
                    status: QuestionStatus::New,
                    user_answer: None,
                    is_correct: None,
                    attempt_count: 0,
                    correct_count: 0,
                    user_note: None,
                    is_favorite: false,
                    is_bookmarked: false,
                    images: vec![],
                    content_hash: String::new(),
                    updated_at: String::new(),
                    remote_version: 0,
                });

            Ok(SyncConflict {
                id: row.get(0)?,
                question_id: row.get(1)?,
                exam_id: row.get(2)?,
                conflict_type: ConflictType::from_str(&conflict_type_str),
                local_version,
                remote_version,
                status: row.get(6)?,
                resolved_strategy: row.get(7)?,
                resolved_at: row.get(8)?,
                created_at: row.get(9)?,
            })
        })?;

        let conflicts: Vec<SyncConflict> = rows.filter_map(log_and_skip_err).collect();
        Ok(conflicts)
    }

    /// 保存冲突到数据库
    pub fn save_conflict(db: &VfsDatabase, conflict: &SyncConflict) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::save_conflict_with_conn(&conn, conflict)
    }

    /// 保存冲突到数据库（使用现有连接）
    pub fn save_conflict_with_conn(conn: &Connection, conflict: &SyncConflict) -> VfsResult<()> {
        let local_snapshot = serde_json::to_string(&conflict.local_version)
            .map_err(|e| VfsError::Serialization(e.to_string()))?;
        let remote_snapshot = serde_json::to_string(&conflict.remote_version)
            .map_err(|e| VfsError::Serialization(e.to_string()))?;

        conn.execute(
            r#"
            INSERT INTO question_sync_conflicts (
                id, question_id, exam_id, conflict_type, local_snapshot, remote_snapshot,
                local_hash, remote_hash, local_updated_at, remote_updated_at,
                status, created_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12
            )
            "#,
            params![
                conflict.id,
                conflict.question_id,
                conflict.exam_id,
                conflict.conflict_type.as_str(),
                local_snapshot,
                remote_snapshot,
                conflict.local_version.content_hash,
                conflict.remote_version.content_hash,
                conflict.local_version.updated_at,
                conflict.remote_version.updated_at,
                conflict.status,
                conflict.created_at,
            ],
        )?;

        Ok(())
    }

    // ========================================================================
    // 同步操作
    // ========================================================================

    /// 更新题目的同步状态为 modified
    pub fn mark_as_modified(db: &VfsDatabase, question_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::mark_as_modified_with_conn(&conn, question_id)
    }

    /// 更新题目的同步状态为 modified（使用现有连接）
    pub fn mark_as_modified_with_conn(conn: &Connection, question_id: &str) -> VfsResult<()> {
        conn.execute(
            r#"
            UPDATE questions SET
                sync_status = CASE
                    WHEN sync_status = 'synced' THEN 'modified'
                    ELSE sync_status
                END
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
            params![question_id],
        )?;
        Ok(())
    }

    /// 更新题目的内容哈希
    pub fn update_content_hash(db: &VfsDatabase, question_id: &str) -> VfsResult<String> {
        let conn = db.get_conn_safe()?;
        Self::update_content_hash_with_conn(&conn, question_id)
    }

    /// 更新题目的内容哈希（使用现有连接）
    pub fn update_content_hash_with_conn(
        conn: &Connection,
        question_id: &str,
    ) -> VfsResult<String> {
        // 获取题目
        let question = Self::get_question_by_id(conn, question_id)?;

        // 计算哈希
        let hash = Self::compute_content_hash(&question);

        // 更新数据库
        conn.execute(
            "UPDATE questions SET content_hash = ?1 WHERE id = ?2",
            params![hash, question_id],
        )?;

        Ok(hash)
    }

    /// 启用/禁用同步
    pub fn set_sync_enabled(db: &VfsDatabase, exam_id: &str, enabled: bool) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        conn.execute(
            "UPDATE exam_sheets SET sync_enabled = ?1 WHERE id = ?2",
            params![if enabled { 1 } else { 0 }, exam_id],
        )?;
        info!(
            "[QuestionSyncService] Set sync_enabled={} for exam_id={}",
            enabled, exam_id
        );
        Ok(())
    }

    /// 更新同步配置
    pub fn update_sync_config(
        db: &VfsDatabase,
        exam_id: &str,
        config: &SyncConfig,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let config_json =
            serde_json::to_string(config).map_err(|e| VfsError::Serialization(e.to_string()))?;

        conn.execute(
            "UPDATE exam_sheets SET sync_config = ?1 WHERE id = ?2",
            params![config_json, exam_id],
        )?;

        info!(
            "[QuestionSyncService] Updated sync_config for exam_id={}",
            exam_id
        );
        Ok(())
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 通过 ID 获取题目
    fn get_question_by_id(conn: &Connection, question_id: &str) -> VfsResult<Question> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, exam_id, card_id, question_label, content, options_json,
                   answer, explanation, question_type, difficulty, tags,
                   status, user_answer, is_correct, attempt_count, correct_count,
                   last_attempt_at, user_note, is_favorite, is_bookmarked,
                   source_type, source_ref, images_json, parent_id, created_at, updated_at,
                   ai_feedback, ai_score, ai_graded_at
            FROM questions
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
        )?;

        stmt.query_row(params![question_id], |row| {
            let options_json: Option<String> = row.get(5)?;
            let options: Option<Vec<QuestionOption>> = options_json
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok());

            let tags_json: Option<String> = row.get(10)?;
            let tags: Vec<String> = tags_json
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();

            let question_type_str: Option<String> = row.get(8)?;
            let question_type = question_type_str
                .map(|s| QuestionType::from_str(&s))
                .unwrap_or_default();

            let difficulty_str: Option<String> = row.get(9)?;
            let difficulty = difficulty_str.map(|s| Difficulty::from_str(&s));

            let status_str: Option<String> = row.get(11)?;
            let status = status_str
                .map(|s| QuestionStatus::from_str(&s))
                .unwrap_or_default();

            let source_type_str: Option<String> = row.get(20)?;
            let source_type = source_type_str
                .map(|s| SourceType::from_str(&s))
                .unwrap_or_default();

            let is_correct: Option<i32> = row.get(13)?;
            let is_favorite: i32 = row.get(18)?;
            let is_bookmarked: i32 = row.get(19)?;

            let images_json_str: Option<String> = row.get(22)?;
            let images: Vec<QuestionImage> = images_json_str
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();

            Ok(Question {
                id: row.get(0)?,
                exam_id: row.get(1)?,
                card_id: row.get(2)?,
                question_label: row.get(3)?,
                content: row.get(4)?,
                options,
                answer: row.get(6)?,
                explanation: row.get(7)?,
                question_type,
                difficulty,
                tags,
                status,
                user_answer: row.get(12)?,
                is_correct: is_correct.map(|v| v != 0),
                attempt_count: row.get(14)?,
                correct_count: row.get(15)?,
                last_attempt_at: row.get(16)?,
                user_note: row.get(17)?,
                is_favorite: is_favorite != 0,
                is_bookmarked: is_bookmarked != 0,
                source_type,
                source_ref: row.get(21)?,
                images,
                parent_id: row.get(23)?,
                created_at: row.get(24)?,
                updated_at: row.get(25)?,
                ai_feedback: row.get(26)?,
                ai_score: row.get(27)?,
                ai_graded_at: row.get(28)?,
            })
        })
        .map_err(|_| VfsError::NotFound {
            resource_type: "question".to_string(),
            id: question_id.to_string(),
        })
    }
}

// ============================================================================
// 本地题目（带同步元数据）
// ============================================================================

/// 本地题目（带同步元数据）
#[derive(Debug, Clone)]
pub struct LocalQuestionWithSync {
    pub question: Question,
    pub sync_status: SyncStatus,
    pub last_synced_at: Option<String>,
    pub remote_id: Option<String>,
    pub content_hash: String,
    pub remote_version: i32,
}

impl LocalQuestionWithSync {
    /// 从数据库加载
    pub fn load_from_db(conn: &Connection, question_id: &str) -> VfsResult<Option<Self>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, exam_id, card_id, question_label, content, options_json,
                   answer, explanation, question_type, difficulty, tags,
                   status, user_answer, is_correct, attempt_count, correct_count,
                   last_attempt_at, user_note, is_favorite, is_bookmarked,
                   source_type, source_ref, images_json, parent_id, created_at, updated_at,
                   ai_feedback, ai_score, ai_graded_at,
                   sync_status, last_synced_at, remote_id, content_hash, remote_version
            FROM questions
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
        )?;

        let result = stmt
            .query_row(params![question_id], |row| {
                let options_json: Option<String> = row.get(5)?;
                let options: Option<Vec<QuestionOption>> = options_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok());

                let tags_json: Option<String> = row.get(10)?;
                let tags: Vec<String> = tags_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();

                let question_type_str: Option<String> = row.get(8)?;
                let question_type = question_type_str
                    .map(|s| QuestionType::from_str(&s))
                    .unwrap_or_default();

                let difficulty_str: Option<String> = row.get(9)?;
                let difficulty = difficulty_str.map(|s| Difficulty::from_str(&s));

                let status_str: Option<String> = row.get(11)?;
                let status = status_str
                    .map(|s| QuestionStatus::from_str(&s))
                    .unwrap_or_default();

                let source_type_str: Option<String> = row.get(20)?;
                let source_type = source_type_str
                    .map(|s| SourceType::from_str(&s))
                    .unwrap_or_default();

                let is_correct: Option<i32> = row.get(13)?;
                let is_favorite: i32 = row.get(18)?;
                let is_bookmarked: i32 = row.get(19)?;

                let images_json_str: Option<String> = row.get(22)?;
                let images: Vec<QuestionImage> = images_json_str
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();

                // AI 字段: 26-28, Sync 字段: 29-33
                let sync_status_str: Option<String> = row.get(29)?;
                let sync_status = sync_status_str
                    .map(|s| SyncStatus::from_str(&s))
                    .unwrap_or_default();

                let content_hash: Option<String> = row.get(32)?;
                let remote_version: Option<i32> = row.get(33)?;

                let question = Question {
                    id: row.get(0)?,
                    exam_id: row.get(1)?,
                    card_id: row.get(2)?,
                    question_label: row.get(3)?,
                    content: row.get(4)?,
                    options,
                    answer: row.get(6)?,
                    explanation: row.get(7)?,
                    question_type,
                    difficulty,
                    tags,
                    status,
                    user_answer: row.get(12)?,
                    is_correct: is_correct.map(|v| v != 0),
                    attempt_count: row.get(14)?,
                    correct_count: row.get(15)?,
                    last_attempt_at: row.get(16)?,
                    user_note: row.get(17)?,
                    is_favorite: is_favorite != 0,
                    is_bookmarked: is_bookmarked != 0,
                    source_type,
                    source_ref: row.get(21)?,
                    images,
                    parent_id: row.get(23)?,
                    created_at: row.get(24)?,
                    updated_at: row.get(25)?,
                    ai_feedback: row.get(26)?,
                    ai_score: row.get(27)?,
                    ai_graded_at: row.get(28)?,
                };

                // 如果没有 content_hash，计算一个
                let hash = content_hash
                    .unwrap_or_else(|| QuestionSyncService::compute_content_hash(&question));

                Ok(LocalQuestionWithSync {
                    question,
                    sync_status,
                    last_synced_at: row.get(30)?,
                    remote_id: row.get(31)?,
                    content_hash: hash,
                    remote_version: remote_version.unwrap_or(0),
                })
            })
            .optional()?;

        Ok(result)
    }

    /// 批量加载题目集下所有题目
    pub fn load_all_for_exam(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<Vec<LocalQuestionWithSync>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, exam_id, card_id, question_label, content, options_json,
                   answer, explanation, question_type, difficulty, tags,
                   status, user_answer, is_correct, attempt_count, correct_count,
                   last_attempt_at, user_note, is_favorite, is_bookmarked,
                   source_type, source_ref, images_json, parent_id, created_at, updated_at,
                   ai_feedback, ai_score, ai_graded_at,
                   sync_status, last_synced_at, remote_id, content_hash, remote_version
            FROM questions
            WHERE exam_id = ?1 AND deleted_at IS NULL
            "#,
        )?;

        let rows = stmt.query_map(params![exam_id], |row| {
            let options_json: Option<String> = row.get(5)?;
            let options: Option<Vec<QuestionOption>> = options_json
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok());

            let tags_json: Option<String> = row.get(10)?;
            let tags: Vec<String> = tags_json
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();

            let question_type_str: Option<String> = row.get(8)?;
            let question_type = question_type_str
                .map(|s| QuestionType::from_str(&s))
                .unwrap_or_default();

            let difficulty_str: Option<String> = row.get(9)?;
            let difficulty = difficulty_str.map(|s| Difficulty::from_str(&s));

            let status_str: Option<String> = row.get(11)?;
            let status = status_str
                .map(|s| QuestionStatus::from_str(&s))
                .unwrap_or_default();

            let source_type_str: Option<String> = row.get(20)?;
            let source_type = source_type_str
                .map(|s| SourceType::from_str(&s))
                .unwrap_or_default();

            let is_correct: Option<i32> = row.get(13)?;
            let is_favorite: i32 = row.get(18)?;
            let is_bookmarked: i32 = row.get(19)?;

            let images_json_str: Option<String> = row.get(22)?;
            let images: Vec<QuestionImage> = images_json_str
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or_default();

            // AI 字段: 26-28, Sync 字段: 29-33
            let sync_status_str: Option<String> = row.get(29)?;
            let sync_status = sync_status_str
                .map(|s| SyncStatus::from_str(&s))
                .unwrap_or_default();

            let content_hash: Option<String> = row.get(32)?;
            let remote_version: Option<i32> = row.get(33)?;

            let question = Question {
                id: row.get(0)?,
                exam_id: row.get(1)?,
                card_id: row.get(2)?,
                question_label: row.get(3)?,
                content: row.get(4)?,
                options,
                answer: row.get(6)?,
                explanation: row.get(7)?,
                question_type,
                difficulty,
                tags,
                status,
                user_answer: row.get(12)?,
                is_correct: is_correct.map(|v| v != 0),
                attempt_count: row.get(14)?,
                correct_count: row.get(15)?,
                last_attempt_at: row.get(16)?,
                user_note: row.get(17)?,
                is_favorite: is_favorite != 0,
                is_bookmarked: is_bookmarked != 0,
                source_type,
                source_ref: row.get(21)?,
                images,
                parent_id: row.get(23)?,
                created_at: row.get(24)?,
                updated_at: row.get(25)?,
                ai_feedback: row.get(26)?,
                ai_score: row.get(27)?,
                ai_graded_at: row.get(28)?,
            };

            // 如果没有 content_hash，计算一个
            let hash = content_hash
                .unwrap_or_else(|| QuestionSyncService::compute_content_hash(&question));

            Ok(LocalQuestionWithSync {
                question,
                sync_status,
                last_synced_at: row.get(30)?,
                remote_id: row.get(31)?,
                content_hash: hash,
                remote_version: remote_version.unwrap_or(0),
            })
        })?;

        let questions: Vec<LocalQuestionWithSync> = rows.filter_map(log_and_skip_err).collect();
        Ok(questions)
    }
}

// ============================================================================
// Tauri 命令
// ============================================================================

use crate::commands::AppState;
use tauri::State;

/// 检查同步状态
#[tauri::command]
pub async fn qbank_sync_check(
    state: State<'_, AppState>,
    exam_id: String,
) -> Result<SyncStatusResult, String> {
    let db = state
        .vfs_db
        .as_ref()
        .ok_or("VFS database not initialized")?;
    QuestionSyncService::check_sync_status(db, &exam_id).map_err(|e| e.to_string())
}

/// 获取冲突列表
#[tauri::command]
pub async fn qbank_get_sync_conflicts(
    state: State<'_, AppState>,
    exam_id: String,
) -> Result<Vec<SyncConflict>, String> {
    let db = state
        .vfs_db
        .as_ref()
        .ok_or("VFS database not initialized")?;
    QuestionSyncService::list_pending_conflicts(db, &exam_id).map_err(|e| e.to_string())
}

/// 解决单个冲突
#[tauri::command]
pub async fn qbank_resolve_sync_conflict(
    state: State<'_, AppState>,
    conflict_id: String,
    strategy: String,
) -> Result<crate::vfs::repos::question_repo::Question, String> {
    let db = state
        .vfs_db
        .as_ref()
        .ok_or("VFS database not initialized")?;
    let strategy = QuestionConflictStrategy::from_str(&strategy);
    QuestionSyncService::resolve_conflict(db, &conflict_id, strategy).map_err(|e| e.to_string())
}

/// 批量解决冲突
#[tauri::command]
pub async fn qbank_batch_resolve_conflicts(
    state: State<'_, AppState>,
    exam_id: String,
    strategy: String,
) -> Result<Vec<crate::vfs::repos::question_repo::Question>, String> {
    let db = state
        .vfs_db
        .as_ref()
        .ok_or("VFS database not initialized")?;
    let strategy = QuestionConflictStrategy::from_str(&strategy);
    QuestionSyncService::batch_resolve_conflicts(db, &exam_id, strategy).map_err(|e| e.to_string())
}

/// 启用/禁用同步
#[tauri::command]
pub async fn qbank_set_sync_enabled(
    state: State<'_, AppState>,
    exam_id: String,
    enabled: bool,
) -> Result<(), String> {
    let db = state
        .vfs_db
        .as_ref()
        .ok_or("VFS database not initialized")?;
    QuestionSyncService::set_sync_enabled(db, &exam_id, enabled).map_err(|e| e.to_string())
}

/// 更新同步配置
#[tauri::command]
pub async fn qbank_update_sync_config(
    state: State<'_, AppState>,
    exam_id: String,
    config: SyncConfig,
) -> Result<(), String> {
    let db = state
        .vfs_db
        .as_ref()
        .ok_or("VFS database not initialized")?;
    QuestionSyncService::update_sync_config(db, &exam_id, &config).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_content_hash_consistency() {
        let question = Question {
            id: "q_test".to_string(),
            exam_id: "exam_1".to_string(),
            card_id: None,
            question_label: Some("Q1".to_string()),
            content: "What is 2+2?".to_string(),
            options: Some(vec![
                QuestionOption {
                    key: "A".to_string(),
                    content: "3".to_string(),
                },
                QuestionOption {
                    key: "B".to_string(),
                    content: "4".to_string(),
                },
            ]),
            answer: Some("B".to_string()),
            explanation: Some("Basic arithmetic".to_string()),
            question_type: QuestionType::SingleChoice,
            difficulty: Some(Difficulty::Easy),
            tags: vec!["math".to_string()],
            status: QuestionStatus::New,
            user_answer: None,
            is_correct: None,
            attempt_count: 0,
            correct_count: 0,
            last_attempt_at: None,
            user_note: None,
            is_favorite: false,
            is_bookmarked: false,
            source_type: SourceType::Ocr,
            source_ref: None,
            images: vec![],
            parent_id: None,
            created_at: "2024-01-01T00:00:00Z".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            ai_feedback: None,
            ai_score: None,
            ai_graded_at: None,
        };

        let hash1 = QuestionSyncService::compute_content_hash(&question);
        let hash2 = QuestionSyncService::compute_content_hash(&question);
        assert_eq!(hash1, hash2);

        // 修改非内容字段不应影响哈希
        let mut question2 = question.clone();
        question2.user_answer = Some("A".to_string());
        question2.attempt_count = 1;
        let hash3 = QuestionSyncService::compute_content_hash(&question2);
        assert_eq!(hash1, hash3);

        // 修改内容字段应改变哈希
        let mut question3 = question.clone();
        question3.content = "What is 3+3?".to_string();
        let hash4 = QuestionSyncService::compute_content_hash(&question3);
        assert_ne!(hash1, hash4);
    }

    #[test]
    fn test_conflict_strategy_conversion() {
        assert_eq!(
            QuestionConflictStrategy::from_str("keep_local"),
            QuestionConflictStrategy::KeepLocal
        );
        assert_eq!(
            QuestionConflictStrategy::from_str("keep_remote"),
            QuestionConflictStrategy::KeepRemote
        );
        assert_eq!(
            QuestionConflictStrategy::from_str("keep_newer"),
            QuestionConflictStrategy::KeepNewer
        );
        assert_eq!(
            QuestionConflictStrategy::from_str("merge"),
            QuestionConflictStrategy::Merge
        );
        assert_eq!(
            QuestionConflictStrategy::from_str("manual"),
            QuestionConflictStrategy::Manual
        );
        assert_eq!(
            QuestionConflictStrategy::from_str("unknown"),
            QuestionConflictStrategy::KeepNewer
        );
    }

    #[test]
    fn test_merge_versions() {
        let local = QuestionVersion {
            id: "q_1".to_string(),
            content: "Test content".to_string(),
            options: None,
            answer: Some("A".to_string()),
            explanation: None,
            question_type: QuestionType::SingleChoice,
            difficulty: Some(Difficulty::Easy),
            tags: vec!["tag1".to_string()],
            status: QuestionStatus::New,
            user_answer: None,
            is_correct: None,
            attempt_count: 1,
            correct_count: 1,
            user_note: Some("Local note".to_string()),
            is_favorite: true,
            is_bookmarked: false,
            images: vec![],
            content_hash: "hash1".to_string(),
            updated_at: "2024-01-01T00:00:00Z".to_string(),
            remote_version: 1,
        };

        let remote = QuestionVersion {
            id: "q_1".to_string(),
            content: "Test content".to_string(), // 相同内容
            options: None,
            answer: Some("A".to_string()),
            explanation: Some("Remote explanation".to_string()), // 远程新增
            question_type: QuestionType::SingleChoice,
            difficulty: Some(Difficulty::Easy),
            tags: vec!["tag1".to_string(), "tag2".to_string()], // 远程多一个标签
            status: QuestionStatus::New,
            user_answer: None,
            is_correct: None,
            attempt_count: 2, // 远程更多
            correct_count: 1,
            user_note: Some("Remote note".to_string()),
            is_favorite: false,
            is_bookmarked: true, // 远程有书签
            images: vec![],
            content_hash: "hash2".to_string(),
            updated_at: "2024-01-02T00:00:00Z".to_string(),
            remote_version: 2,
        };

        let result = QuestionSyncService::merge_versions(&local, &remote);

        // 检查合并结果
        assert!(result.merged.explanation.is_some());
        assert_eq!(result.merged.tags.len(), 2);
        assert_eq!(result.merged.attempt_count, 2);
        assert!(result.merged.is_favorite);
        assert!(result.merged.is_bookmarked);
        assert!(result.merged.user_note.is_some());
        assert!(result
            .merged
            .user_note
            .as_ref()
            .unwrap()
            .contains("Local note"));
        assert!(result
            .merged
            .user_note
            .as_ref()
            .unwrap()
            .contains("Remote note"));
    }
}
