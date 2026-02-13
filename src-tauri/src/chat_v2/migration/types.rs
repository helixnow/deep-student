//! 迁移相关类型定义

use serde::{Deserialize, Serialize};

/// 迁移状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationStatus {
    /// 未开始
    NotStarted,
    /// 进行中
    InProgress,
    /// 已完成
    Completed,
    /// 已回滚
    RolledBack,
    /// 失败
    Failed,
}

impl Default for MigrationStatus {
    fn default() -> Self {
        Self::NotStarted
    }
}

/// 迁移步骤
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationStep {
    /// 检查旧数据
    CheckLegacyData,
    /// 按 mistake_id 分组
    GroupByMistakeId,
    /// 创建会话
    CreateSession,
    /// 迁移消息
    MigrateMessages,
    /// 创建块
    CreateBlocks,
    /// 创建附件
    CreateAttachments,
    /// 标记已迁移
    MarkMigrated,
    /// 完成
    Finished,
}

/// 迁移进度
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationProgress {
    /// 当前状态
    pub status: MigrationStatus,
    /// 当前步骤
    pub current_step: MigrationStep,
    /// 总消息数
    pub total_messages: usize,
    /// 已迁移消息数
    pub migrated_messages: usize,
    /// 总会话数（按 mistake_id 分组）
    pub total_sessions: usize,
    /// 已创建会话数
    pub created_sessions: usize,
    /// 进度百分比 (0-100)
    pub percent: u8,
    /// 当前处理的 mistake_id
    pub current_mistake_id: Option<String>,
    /// 错误信息
    pub error: Option<String>,
}

impl Default for MigrationProgress {
    fn default() -> Self {
        Self {
            status: MigrationStatus::NotStarted,
            current_step: MigrationStep::CheckLegacyData,
            total_messages: 0,
            migrated_messages: 0,
            total_sessions: 0,
            created_sessions: 0,
            percent: 0,
            current_mistake_id: None,
            error: None,
        }
    }
}

impl MigrationProgress {
    /// 更新进度百分比
    pub fn update_percent(&mut self) {
        if self.total_messages > 0 {
            self.percent =
                ((self.migrated_messages as f64 / self.total_messages as f64) * 100.0) as u8;
        }
    }
}

/// 迁移报告
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    /// 迁移状态
    pub status: MigrationStatus,
    /// 创建的会话数
    pub sessions_created: usize,
    /// 迁移的消息数
    pub messages_migrated: usize,
    /// 创建的块数
    pub blocks_created: usize,
    /// 创建的附件数
    pub attachments_created: usize,
    /// 跳过的消息数（已迁移过）
    pub messages_skipped: usize,
    /// 错误列表
    pub errors: Vec<String>,
    /// 开始时间（毫秒时间戳）
    pub started_at: i64,
    /// 结束时间（毫秒时间戳）
    pub ended_at: i64,
    /// 耗时（毫秒）
    pub duration_ms: i64,
}

impl Default for MigrationReport {
    fn default() -> Self {
        Self {
            status: MigrationStatus::NotStarted,
            sessions_created: 0,
            messages_migrated: 0,
            blocks_created: 0,
            attachments_created: 0,
            messages_skipped: 0,
            errors: Vec::new(),
            started_at: 0,
            ended_at: 0,
            duration_ms: 0,
        }
    }
}

/// 迁移事件（通过 Tauri 事件发送到前端）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationEvent {
    /// 事件类型
    pub event_type: MigrationEventType,
    /// 进度信息
    pub progress: MigrationProgress,
    /// 当前处理的项目描述
    pub message: String,
}

/// 迁移事件类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MigrationEventType {
    /// 迁移开始
    Started,
    /// 进度更新
    Progress,
    /// 步骤变更
    StepChanged,
    /// 迁移完成
    Completed,
    /// 迁移失败
    Failed,
    /// 回滚开始
    RollbackStarted,
    /// 回滚完成
    RollbackCompleted,
    /// 回滚失败
    RollbackFailed,
}

/// 迁移检查结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCheckResult {
    /// 是否需要迁移
    pub needs_migration: bool,
    /// 未迁移的消息数
    pub pending_messages: usize,
    /// 未迁移的会话数（按 mistake_id 分组）
    pub pending_sessions: usize,
    /// 已迁移的消息数
    pub migrated_messages: usize,
    /// 是否可以回滚
    pub can_rollback: bool,
    /// 上次迁移时间
    pub last_migration_at: Option<i64>,
}

impl Default for MigrationCheckResult {
    fn default() -> Self {
        Self {
            needs_migration: false,
            pending_messages: 0,
            pending_sessions: 0,
            migrated_messages: 0,
            can_rollback: false,
            last_migration_at: None,
        }
    }
}
