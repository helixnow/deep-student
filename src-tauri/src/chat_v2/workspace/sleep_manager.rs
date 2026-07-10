//! 睡眠管理器
//!
//! 管理主代理的睡眠/唤醒机制，支持持久化和重启恢复。
//! 🆕 P1修复：添加 TaskTracker 追踪超时任务，确保优雅关闭。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tokio::sync::oneshot;
use tokio_util::task::TaskTracker;

use super::database::WorkspaceDatabase;
use super::types::{AgentStatus, MessageType, WorkspaceMessage};

// ============================================================================
// 类型定义
// ============================================================================

/// 唤醒条件
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WakeCondition {
    /// 任意消息唤醒
    AnyMessage,
    /// 收到 result 类型消息
    ResultMessage,
    /// 所有子代理完成
    AllCompleted,
    /// 超时自动唤醒
    Timeout { ms: u64 },
}

impl Default for WakeCondition {
    fn default() -> Self {
        Self::ResultMessage
    }
}

/// 睡眠状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SleepStatus {
    Sleeping,
    Awakened,
    Timeout,
    Cancelled,
}

impl Default for SleepStatus {
    fn default() -> Self {
        Self::Sleeping
    }
}

/// 睡眠块数据
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SleepBlockData {
    pub id: String,
    pub workspace_id: String,
    pub coordinator_session_id: String,
    pub awaiting_agents: Vec<String>,
    pub wake_condition: WakeCondition,
    pub status: SleepStatus,
    pub timeout_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub awakened_at: Option<DateTime<Utc>>,
    pub awakened_by: Option<String>,
    pub awaken_message: Option<String>,
    pub message_id: Option<String>,
    pub block_id: Option<String>,
}

impl SleepBlockData {
    pub fn new(
        workspace_id: String,
        coordinator_session_id: String,
        awaiting_agents: Vec<String>,
        wake_condition: WakeCondition,
    ) -> Self {
        Self {
            id: format!("sleep_{}", ulid::Ulid::new()),
            workspace_id,
            coordinator_session_id,
            awaiting_agents,
            wake_condition,
            status: SleepStatus::Sleeping,
            timeout_at: None,
            created_at: Utc::now(),
            awakened_at: None,
            awakened_by: None,
            awaken_message: None,
            message_id: None,
            block_id: None,
        }
    }

    pub fn with_timeout(mut self, timeout_ms: u64) -> Self {
        self.timeout_at = Some(Utc::now() + chrono::Duration::milliseconds(timeout_ms as i64));
        self
    }

    pub fn with_message_id(mut self, message_id: String) -> Self {
        self.message_id = Some(message_id);
        self
    }

    pub fn with_block_id(mut self, block_id: String) -> Self {
        self.block_id = Some(block_id);
        self
    }
}

/// 唤醒载荷
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeUpPayload {
    pub sleep_id: String,
    pub awakened_by: String,
    pub message: Option<WorkspaceMessage>,
    pub reason: WakeReason,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WakeReason {
    Message,
    AllCompleted,
    Timeout,
    Manual,
    Cancelled,
}

/// 睡眠错误
#[derive(Debug, thiserror::Error)]
pub enum SleepError {
    #[error("Database error: {0}")]
    Database(String),
    #[error("Sleep not found: {0}")]
    NotFound(String),
    #[error("Sleep already awakened: {0}")]
    AlreadyAwakened(String),
    #[error("Timeout")]
    Timeout,
    #[error("Cancelled")]
    Cancelled,
}

/// 🆕 唤醒结果信息（用于事件发射）
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeResultInfo {
    pub sleep_id: String,
    pub workspace_id: String,
    pub coordinator_session_id: String,
    pub awakened_by: String,
    pub awaken_message: Option<String>,
    pub wake_reason: String,
}

// ============================================================================
// SleepManager
// ============================================================================

/// 睡眠管理器
pub struct SleepManager {
    db: Arc<WorkspaceDatabase>,
    /// 活跃的睡眠 (sleepId -> oneshot::Sender<WakeUpPayload>)
    active_sleeps: Arc<Mutex<HashMap<String, oneshot::Sender<WakeUpPayload>>>>,
    app_handle: Option<AppHandle>,
    /// 🆕 P1修复：任务追踪器，用于追踪超时任务
    task_tracker: TaskTracker,
}

impl SleepManager {
    pub fn new(db: Arc<WorkspaceDatabase>) -> Self {
        Self {
            db,
            active_sleeps: Arc::new(Mutex::new(HashMap::new())),
            app_handle: None,
            task_tracker: TaskTracker::new(),
        }
    }

    pub fn with_app_handle(mut self, handle: AppHandle) -> Self {
        self.app_handle = Some(handle);
        self
    }

    /// 🆕 P1修复：关闭任务追踪器，等待所有超时任务完成
    pub async fn shutdown(&self, timeout: std::time::Duration) -> bool {
        self.task_tracker.close();
        match tokio::time::timeout(timeout, self.task_tracker.wait()).await {
            Ok(()) => {
                log::info!("[SleepManager] All timeout tasks completed");
                true
            }
            Err(_) => {
                log::warn!("[SleepManager] Timeout waiting for tasks to complete");
                false
            }
        }
    }

    /// 开始睡眠（同步阶段）：持久化、注册到 active_sleeps、启动超时任务。
    ///
    /// 返回等待唤醒的 Receiver，调用方在注册完成后、阻塞等待前
    /// 可以先做一次初始唤醒条件检查（见 [`Self::check_initial_wake_conditions`]），
    /// 避免"结果先到、睡眠后建"的竞态导致睡满超时。
    pub fn begin_sleep(
        &self,
        data: &SleepBlockData,
    ) -> Result<oneshot::Receiver<WakeUpPayload>, SleepError> {
        // 保存到数据库
        self.save_sleep(data)?;

        // 创建 oneshot channel
        let (tx, rx) = oneshot::channel::<WakeUpPayload>();

        // 注册到活跃睡眠
        {
            let mut sleeps = self.active_sleeps.lock().unwrap_or_else(|poisoned| {
                log::error!("[SleepManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            });
            sleeps.insert(data.id.clone(), tx);
        }

        log::info!("[SleepManager] Sleep started: {}", data.id);

        // 如果有超时，设置超时任务
        if let Some(timeout) = data.timeout_at {
            self.spawn_timeout_task(data.id.clone(), timeout);
        }

        Ok(rx)
    }

    /// 创建睡眠，返回一个 Future 等待唤醒
    pub async fn sleep(&self, data: SleepBlockData) -> Result<WakeUpPayload, SleepError> {
        let sleep_id = data.id.clone();
        let rx = self.begin_sleep(&data)?;

        // 等待唤醒
        match rx.await {
            Ok(payload) => {
                log::info!(
                    "[SleepManager] Sleep awakened: {} by {}",
                    sleep_id,
                    payload.awakened_by
                );
                Ok(payload)
            }
            Err(_) => {
                log::warn!(
                    "[SleepManager] Sleep channel closed unexpectedly: {}",
                    sleep_id
                );
                Err(SleepError::Cancelled)
            }
        }
    }

    fn spawn_timeout_task(&self, sleep_id: String, timeout_at: DateTime<Utc>) {
        let active_sleeps = self.active_sleeps.clone();
        let db = self.db.clone();

        // 🆕 P1修复：使用 TaskTracker 追踪超时任务
        self.task_tracker.spawn(async move {
            let duration = (timeout_at - Utc::now()).to_std().unwrap_or_default();
            tokio::time::sleep(duration).await;

            // 检查是否还在睡眠
            let sender = {
                let mut sleeps = active_sleeps.lock().unwrap_or_else(|poisoned| {
                    log::error!("[SleepManager] Mutex poisoned! Attempting recovery");
                    poisoned.into_inner()
                });
                sleeps.remove(&sleep_id)
            };

            if let Some(tx) = sender {
                log::info!("[SleepManager] Sleep timeout: {}", sleep_id);

                let payload = WakeUpPayload {
                    sleep_id: sleep_id.clone(),
                    awakened_by: "system".to_string(),
                    message: None,
                    reason: WakeReason::Timeout,
                };
                let _ = tx.send(payload);

                // 更新数据库状态
                if let Err(e) = Self::update_sleep_status_static(
                    &db,
                    &sleep_id,
                    SleepStatus::Timeout,
                    None,
                    None,
                ) {
                    log::warn!("[SleepManager] Failed to update timeout status: {}", e);
                }

                // coordinator_awakened 事件由 sleep_executor 在唤醒后统一发射，
                // 避免 SleepManager 直接持有 AppHandle 产生的生命周期耦合
            }
        });
    }

    /// 尝试唤醒指定的睡眠
    pub fn try_wake(&self, sleep_id: &str, payload: WakeUpPayload) -> Result<bool, SleepError> {
        let sender = {
            let mut sleeps = self.active_sleeps.lock().unwrap_or_else(|poisoned| {
                log::error!("[SleepManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            });
            sleeps.remove(sleep_id)
        };

        if let Some(tx) = sender {
            // 更新数据库
            self.update_sleep_status(
                sleep_id,
                SleepStatus::Awakened,
                Some(&payload.awakened_by),
                payload.message.as_ref().map(|m| m.content.as_str()),
            )?;

            let _ = tx.send(payload);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// 检查消息是否应该唤醒某个睡眠
    ///
    /// 支持以下场景触发唤醒：
    /// 1. 消息直接发给 coordinator（target_session_id 匹配）
    /// 2. 广播消息（target_session_id 为 None）且发送者在 awaiting_agents 中
    /// 3. 消息发送者在 awaiting_agents 列表中
    ///
    /// 🆕 返回被唤醒的睡眠信息列表，供调用方发射事件
    pub fn check_and_wake_by_message(
        &self,
        message: &WorkspaceMessage,
    ) -> Result<Vec<WakeResultInfo>, SleepError> {
        let mut awakened = Vec::new();

        // 获取所有活跃的睡眠
        let active_sleep_ids: Vec<String> = {
            let sleeps = self.active_sleeps.lock().unwrap_or_else(|poisoned| {
                log::error!("[SleepManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            });
            sleeps.keys().cloned().collect()
        };

        for sleep_id in active_sleep_ids {
            if let Ok(Some(sleep_data)) = self.get_sleep(&sleep_id) {
                // 检查消息是否与此睡眠相关
                let is_relevant = self.is_message_relevant_to_sleep(message, &sleep_data);

                if !is_relevant {
                    continue;
                }

                // 检查是否满足唤醒条件
                let should_wake = match &sleep_data.wake_condition {
                    WakeCondition::AnyMessage => true,
                    WakeCondition::ResultMessage => message.message_type == MessageType::Result,
                    WakeCondition::AllCompleted => {
                        // 检查是否是结果消息，且发送者在 awaiting_agents 中
                        if message.message_type == MessageType::Result {
                            // 记录已完成的代理，检查是否全部完成
                            self.check_all_agents_completed(&sleep_data, &message.sender_session_id)
                        } else {
                            false
                        }
                    }
                    WakeCondition::Timeout { .. } => false, // 超时由定时器处理
                };

                if should_wake {
                    log::info!(
                        "[SleepManager] Waking up sleep {} due to message from {}, condition={:?}",
                        sleep_id,
                        message.sender_session_id,
                        sleep_data.wake_condition
                    );

                    let payload = WakeUpPayload {
                        sleep_id: sleep_id.clone(),
                        awakened_by: message.sender_session_id.clone(),
                        message: Some(message.clone()),
                        reason: WakeReason::Message,
                    };

                    if let Ok(true) = self.try_wake(&sleep_id, payload) {
                        // 🆕 收集唤醒结果信息
                        awakened.push(WakeResultInfo {
                            sleep_id: sleep_id.clone(),
                            workspace_id: sleep_data.workspace_id.clone(),
                            coordinator_session_id: sleep_data.coordinator_session_id.clone(),
                            awakened_by: message.sender_session_id.clone(),
                            awaken_message: Some(message.content.clone()),
                            wake_reason: "message".to_string(),
                        });
                    }
                }
            }
        }

        Ok(awakened)
    }

    /// 根据 Agent 状态变化尝试唤醒睡眠中的 Coordinator
    ///
    /// 主要用于修复 worker 通过 attempt_completion 结束但未写入 result 消息时，
    /// coordinator 只能等到 timeout 才恢复的问题。
    pub fn check_and_wake_by_agent_status(
        &self,
        workspace_id: &str,
        agent_session_id: &str,
        status: &AgentStatus,
    ) -> Result<Vec<WakeResultInfo>, SleepError> {
        if !matches!(
            status,
            AgentStatus::Completed | AgentStatus::Failed | AgentStatus::Cancelled
        ) {
            return Ok(Vec::new());
        }

        let mut awakened = Vec::new();

        let active_sleep_ids: Vec<String> = {
            let sleeps = self.active_sleeps.lock().unwrap_or_else(|poisoned| {
                log::error!("[SleepManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            });
            sleeps.keys().cloned().collect()
        };

        for sleep_id in active_sleep_ids {
            if let Ok(Some(sleep_data)) = self.get_sleep(&sleep_id) {
                if sleep_data.workspace_id != workspace_id {
                    continue;
                }

                if !self.is_agent_relevant_to_sleep(agent_session_id, &sleep_data) {
                    continue;
                }

                let should_wake = match &sleep_data.wake_condition {
                    WakeCondition::AllCompleted | WakeCondition::ResultMessage => {
                        // 终态兜底：仅当所有 awaiting_agents 都进入终态时才唤醒
                        // ResultMessage 本应由消息触发；但若 worker 走 attempt_completion
                        // 而未发 result 消息，则以全员终态为 fallback，避免纯超时
                        self.check_all_agents_terminal(&sleep_data)
                    }
                    WakeCondition::AnyMessage | WakeCondition::Timeout { .. } => false,
                };

                if !should_wake {
                    continue;
                }

                log::info!(
                    "[SleepManager] Waking up sleep {} by agent status: agent={}, status={:?}, condition={:?}",
                    sleep_id,
                    agent_session_id,
                    status,
                    sleep_data.wake_condition
                );

                let payload = WakeUpPayload {
                    sleep_id: sleep_id.clone(),
                    awakened_by: agent_session_id.to_string(),
                    message: None,
                    reason: WakeReason::AllCompleted,
                };

                if let Ok(true) = self.try_wake(&sleep_id, payload) {
                    awakened.push(WakeResultInfo {
                        sleep_id: sleep_id.clone(),
                        workspace_id: sleep_data.workspace_id.clone(),
                        coordinator_session_id: sleep_data.coordinator_session_id.clone(),
                        awakened_by: agent_session_id.to_string(),
                        awaken_message: None,
                        wake_reason: "all_completed".to_string(),
                    });
                }
            }
        }

        Ok(awakened)
    }

    /// 睡眠激活后的初始唤醒条件检查（修复"结果先到、睡眠后建"的竞态）
    ///
    /// check_and_wake_by_message / check_and_wake_by_agent_status 只在事件发生时
    /// 扫描 active_sleeps；若子代理在睡眠注册之前就发出了 result 或进入终态，
    /// 这些事件永远不会再触发，主代理只能睡到超时。
    ///
    /// 本方法在 begin_sleep 注册之后、阻塞等待之前调用，检查两类既成事实：
    /// 1. coordinator 的 inbox 中已有满足唤醒条件的未读消息（走消息唤醒路径）；
    /// 2. 所有被等待的 agent 已全部进入终态（走 all_completed 唤醒路径）。
    ///
    /// 任一满足则通过 try_wake 立即唤醒（与正常唤醒共用同一路径，
    /// 保证 DB 状态更新与事件语义一致）。检查失败不影响正常睡眠，由调用方兜底。
    pub fn check_initial_wake_conditions(
        &self,
        sleep_id: &str,
    ) -> Result<Vec<WakeResultInfo>, SleepError> {
        // 未注册（或已被并发唤醒）则无事可做
        if !self.is_sleep_active(sleep_id) {
            return Ok(Vec::new());
        }
        let Some(sleep_data) = self.get_sleep(sleep_id)? else {
            return Ok(Vec::new());
        };
        if sleep_data.status != SleepStatus::Sleeping {
            return Ok(Vec::new());
        }

        let mut awakened = Vec::new();

        // 条件 1：inbox 中已有满足唤醒条件的未读消息。
        // 优先于终态检查，与正常路径顺序一致（消息先于状态变更触发），
        // 且能把消息内容带回给 coordinator。
        if let Some(message) = self.find_pending_wake_message(&sleep_data)? {
            log::info!(
                "[SleepManager] Initial check: waking sleep {} due to pending inbox message {} from {}",
                sleep_id,
                message.id,
                message.sender_session_id
            );
            let payload = WakeUpPayload {
                sleep_id: sleep_id.to_string(),
                awakened_by: message.sender_session_id.clone(),
                message: Some(message.clone()),
                reason: WakeReason::Message,
            };
            if self.try_wake(sleep_id, payload)? {
                awakened.push(WakeResultInfo {
                    sleep_id: sleep_id.to_string(),
                    workspace_id: sleep_data.workspace_id.clone(),
                    coordinator_session_id: sleep_data.coordinator_session_id.clone(),
                    awakened_by: message.sender_session_id.clone(),
                    awaken_message: Some(message.content.clone()),
                    wake_reason: "message".to_string(),
                });
                return Ok(awakened);
            }
        }

        // 条件 2：所有被等待的 agent 已全部终态（与 check_and_wake_by_agent_status 同款判定）
        let all_terminal = match &sleep_data.wake_condition {
            WakeCondition::AllCompleted | WakeCondition::ResultMessage => {
                self.check_all_agents_terminal(&sleep_data)
            }
            WakeCondition::AnyMessage | WakeCondition::Timeout { .. } => false,
        };
        if all_terminal {
            log::info!(
                "[SleepManager] Initial check: waking sleep {} because all awaited agents are already terminal",
                sleep_id
            );
            let payload = WakeUpPayload {
                sleep_id: sleep_id.to_string(),
                awakened_by: "system".to_string(),
                message: None,
                reason: WakeReason::AllCompleted,
            };
            if self.try_wake(sleep_id, payload)? {
                awakened.push(WakeResultInfo {
                    sleep_id: sleep_id.to_string(),
                    workspace_id: sleep_data.workspace_id.clone(),
                    coordinator_session_id: sleep_data.coordinator_session_id.clone(),
                    awakened_by: "system".to_string(),
                    awaken_message: None,
                    wake_reason: "all_completed".to_string(),
                });
            }
        }

        Ok(awakened)
    }

    /// 在 coordinator 的未读 inbox 中查找第一条满足唤醒条件的消息
    fn find_pending_wake_message(
        &self,
        sleep_data: &SleepBlockData,
    ) -> Result<Option<WorkspaceMessage>, SleepError> {
        let repo = super::repo::WorkspaceRepo::new(Arc::clone(&self.db));
        let messages = repo
            .get_unread_inbox_messages(&sleep_data.coordinator_session_id)
            .map_err(SleepError::Database)?;

        for message in messages {
            if !self.is_message_relevant_to_sleep(&message, sleep_data) {
                continue;
            }
            let should_wake = match &sleep_data.wake_condition {
                WakeCondition::AnyMessage => true,
                WakeCondition::ResultMessage => message.message_type == MessageType::Result,
                WakeCondition::AllCompleted => {
                    message.message_type == MessageType::Result
                        && self.check_all_agents_completed(sleep_data, &message.sender_session_id)
                }
                WakeCondition::Timeout { .. } => false,
            };
            if should_wake {
                return Ok(Some(message));
            }
        }

        Ok(None)
    }

    /// 检查消息是否与睡眠相关
    fn is_message_relevant_to_sleep(
        &self,
        message: &WorkspaceMessage,
        sleep_data: &SleepBlockData,
    ) -> bool {
        // 1. 消息直接发给 coordinator
        if let Some(target) = &message.target_session_id {
            if target == &sleep_data.coordinator_session_id {
                return true;
            }
        }

        // 2. 广播消息且发送者在 awaiting_agents 中（或 awaiting_agents 为空表示等待所有）
        if message.target_session_id.is_none() {
            // 如果 awaiting_agents 为空，表示等待任意子代理
            if sleep_data.awaiting_agents.is_empty() {
                return true;
            }
            // 否则检查发送者是否在等待列表中
            if sleep_data
                .awaiting_agents
                .contains(&message.sender_session_id)
            {
                return true;
            }
        }

        // 3. 发送者在 awaiting_agents 中（即使不是广播）
        if sleep_data
            .awaiting_agents
            .contains(&message.sender_session_id)
        {
            return true;
        }

        false
    }

    fn is_agent_relevant_to_sleep(
        &self,
        agent_session_id: &str,
        sleep_data: &SleepBlockData,
    ) -> bool {
        if sleep_data.awaiting_agents.is_empty() {
            return true;
        }
        sleep_data
            .awaiting_agents
            .contains(&agent_session_id.to_string())
    }

    fn check_all_agents_terminal(&self, sleep_data: &SleepBlockData) -> bool {
        if sleep_data.awaiting_agents.is_empty() {
            return true;
        }

        let Ok(conn) = self.db.get_connection() else {
            return false;
        };

        let statuses: std::collections::HashMap<String, String> = conn
            .prepare("SELECT session_id, status FROM agent WHERE workspace_id = ?1")
            .and_then(|mut stmt| {
                let rows = stmt.query_map(rusqlite::params![sleep_data.workspace_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;

                let mut map = std::collections::HashMap::new();
                for row in rows {
                    match row {
                        Ok((session_id, status)) => {
                            map.insert(session_id, status);
                        }
                        Err(e) => {
                            log::warn!("[SleepManager] Failed to parse agent status row: {}", e);
                        }
                    }
                }
                Ok(map)
            })
            .unwrap_or_default();

        for agent in &sleep_data.awaiting_agents {
            let is_terminal = statuses
                .get(agent)
                .map(|s| s == "completed" || s == "failed" || s == "cancelled")
                .unwrap_or(false);

            if !is_terminal {
                log::debug!(
                    "[SleepManager] Agent {} not terminal yet for sleep {}",
                    agent,
                    sleep_data.id
                );
                return false;
            }
        }

        true
    }

    /// 检查是否所有等待的代理都已完成（用于 AllCompleted 条件）
    fn check_all_agents_completed(
        &self,
        sleep_data: &SleepBlockData,
        completed_agent: &str,
    ) -> bool {
        // 如果 awaiting_agents 为空，表示只等待一个结果就唤醒
        if sleep_data.awaiting_agents.is_empty() {
            return true;
        }

        // 查询数据库中已完成的代理（通过检查 result 类型消息）
        let completed_agents = self.get_completed_agents_for_sleep(&sleep_data.id);

        // 添加当前完成的代理
        let mut all_completed: std::collections::HashSet<String> =
            completed_agents.into_iter().collect();
        all_completed.insert(completed_agent.to_string());

        // 检查是否所有 awaiting_agents 都已完成
        for agent in &sleep_data.awaiting_agents {
            if !all_completed.contains(agent) {
                log::debug!(
                    "[SleepManager] AllCompleted check: agent {} not yet completed",
                    agent
                );
                return false;
            }
        }

        log::info!(
            "[SleepManager] AllCompleted: all {} agents have completed",
            sleep_data.awaiting_agents.len()
        );
        true
    }

    /// 获取已为指定睡眠发送过结果的代理列表
    fn get_completed_agents_for_sleep(&self, sleep_id: &str) -> Vec<String> {
        // 从数据库查询已完成的代理
        // 这里简化处理：通过查询 message 表中 message_type='result' 的消息
        if let Ok(Some(sleep_data)) = self.get_sleep(sleep_id) {
            if let Ok(conn) = self.db.get_connection() {
                let result: Result<Vec<String>, _> = conn
                    .prepare(
                        "SELECT DISTINCT sender_session_id FROM message \
                         WHERE workspace_id = ?1 AND message_type = 'result' \
                         AND created_at > ?2",
                    )
                    .and_then(|mut stmt| {
                        let rows = stmt.query_map(
                            rusqlite::params![
                                sleep_data.workspace_id,
                                sleep_data.created_at.to_rfc3339()
                            ],
                            |row| row.get(0),
                        )?;
                        rows.collect()
                    });

                if let Ok(agents) = result {
                    return agents;
                }
            }
        }
        Vec::new()
    }

    /// 手动唤醒（用户点击唤醒按钮）
    /// 🔧 P33 修复：返回 WakeResultInfo 供调用方发射事件
    pub fn manual_wake(
        &self,
        sleep_id: &str,
        user_message: Option<String>,
    ) -> Result<Option<WakeResultInfo>, SleepError> {
        // 先获取睡眠数据，用于构建 WakeResultInfo
        let sleep_data = self.get_sleep(sleep_id)?;

        let payload = WakeUpPayload {
            sleep_id: sleep_id.to_string(),
            awakened_by: "user".to_string(),
            message: None,
            reason: WakeReason::Manual,
        };

        let success = self.try_wake(sleep_id, payload)?;

        if success {
            if let Some(data) = sleep_data {
                Ok(Some(WakeResultInfo {
                    sleep_id: sleep_id.to_string(),
                    workspace_id: data.workspace_id,
                    coordinator_session_id: data.coordinator_session_id,
                    awakened_by: "user".to_string(),
                    awaken_message: user_message,
                    wake_reason: "manual".to_string(),
                }))
            } else {
                Ok(None)
            }
        } else {
            Ok(None)
        }
    }

    /// 取消睡眠
    pub fn cancel(&self, sleep_id: &str) -> Result<bool, SleepError> {
        let sender = {
            let mut sleeps = self.active_sleeps.lock().unwrap_or_else(|poisoned| {
                log::error!("[SleepManager] Mutex poisoned! Attempting recovery");
                poisoned.into_inner()
            });
            sleeps.remove(sleep_id)
        };

        if let Some(tx) = sender {
            self.update_sleep_status(sleep_id, SleepStatus::Cancelled, None, None)?;

            let payload = WakeUpPayload {
                sleep_id: sleep_id.to_string(),
                awakened_by: "system".to_string(),
                message: None,
                reason: WakeReason::Cancelled,
            };
            let _ = tx.send(payload);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    /// 恢复持久化的睡眠（应用启动时）- 仅读取数据
    pub fn restore_sleeps(&self) -> Result<Vec<SleepBlockData>, SleepError> {
        let conn = self
            .db
            .get_connection()
            .map_err(|e| SleepError::Database(e.to_string()))?;

        let mut stmt = conn.prepare(
            "SELECT id, workspace_id, coordinator_session_id, awaiting_agents, wake_condition, \
             status, timeout_at, created_at, awakened_at, awakened_by, awaken_message, \
             message_id, block_id \
             FROM sleep_block WHERE status = 'sleeping'"
        ).map_err(|e| SleepError::Database(e.to_string()))?;

        let sleeps = stmt
            .query_map([], |row| {
                Ok(SleepBlockData {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    coordinator_session_id: row.get(2)?,
                    awaiting_agents: serde_json::from_str(&row.get::<_, String>(3)?)
                        .unwrap_or_default(),
                    wake_condition: serde_json::from_str(&row.get::<_, String>(4)?)
                        .unwrap_or_default(),
                    status: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>(5)?))
                        .unwrap_or_default(),
                    timeout_at: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc)),
                    created_at: {
                        let s = row.get::<_, String>(7)?;
                        DateTime::parse_from_rfc3339(&s)
                            .map(|dt| dt.with_timezone(&Utc))
                            .unwrap_or_else(|e| {
                                log::warn!("[SleepManager] Failed to parse created_at in restore_sleeps '{}': {}", s, e);
                                DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                            })
                    },
                    awakened_at: row
                        .get::<_, Option<String>>(8)?
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc)),
                    awakened_by: row.get(9)?,
                    awaken_message: row.get(10)?,
                    message_id: row.get(11)?,
                    block_id: row.get(12)?,
                })
            })
            .map_err(|e| SleepError::Database(e.to_string()))?;

        let mut result = Vec::new();
        for sleep in sleeps {
            if let Ok(s) = sleep {
                result.push(s);
            }
        }

        log::info!("[SleepManager] Restored {} sleeping blocks", result.len());
        Ok(result)
    }

    /// 恢复持久化的睡眠并激活它们（重新注册到 active_sleeps）
    /// 返回 (sleep_id, oneshot::Receiver) 列表，调用方可以 await 这些 Receiver 等待唤醒
    pub fn restore_and_activate_sleeps(
        &self,
    ) -> Result<Vec<(String, oneshot::Receiver<WakeUpPayload>)>, SleepError> {
        let sleeps = self.restore_sleeps()?;
        let mut receivers = Vec::new();

        for sleep_data in sleeps {
            let sleep_id = sleep_data.id.clone();

            // 创建 oneshot channel
            let (tx, rx) = oneshot::channel::<WakeUpPayload>();

            // 注册到活跃睡眠（幂等：已激活的 sleep 跳过，避免重复注册与重复超时任务）
            {
                let mut active = self.active_sleeps.lock().unwrap_or_else(|poisoned| {
                    log::error!("[SleepManager] Mutex poisoned! Attempting recovery");
                    poisoned.into_inner()
                });
                if active.contains_key(&sleep_id) {
                    log::debug!(
                        "[SleepManager] Sleep {} already active, skipping re-activation",
                        sleep_id
                    );
                    continue;
                }
                active.insert(sleep_id.clone(), tx);
            }

            if let Some(timeout_at) = sleep_data.timeout_at {
                self.spawn_timeout_task(sleep_id.clone(), timeout_at);
            }

            log::info!(
                "[SleepManager] Re-activated sleep: id={}, coordinator={}, awaiting={:?}",
                sleep_id,
                sleep_data.coordinator_session_id,
                sleep_data.awaiting_agents
            );

            receivers.push((sleep_id, rx));
        }

        log::info!(
            "[SleepManager] Activated {} sleeps for wake-up",
            receivers.len()
        );
        Ok(receivers)
    }

    /// 检查指定睡眠是否在活跃状态（可被唤醒）
    pub fn is_sleep_active(&self, sleep_id: &str) -> bool {
        let sleeps = self.active_sleeps.lock().unwrap_or_else(|poisoned| {
            log::error!("[SleepManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        sleeps.contains_key(sleep_id)
    }

    /// 获取所有活跃睡眠的 ID 列表
    pub fn get_active_sleep_ids(&self) -> Vec<String> {
        let sleeps = self.active_sleeps.lock().unwrap_or_else(|poisoned| {
            log::error!("[SleepManager] Mutex poisoned! Attempting recovery");
            poisoned.into_inner()
        });
        sleeps.keys().cloned().collect()
    }

    // ========================================================================
    // 数据库操作
    // ========================================================================

    fn save_sleep(&self, data: &SleepBlockData) -> Result<(), SleepError> {
        let conn = self
            .db
            .get_connection()
            .map_err(|e| SleepError::Database(e.to_string()))?;

        conn.execute(
            "INSERT INTO sleep_block (id, workspace_id, coordinator_session_id, awaiting_agents, \
             wake_condition, status, timeout_at, created_at, message_id, block_id) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            rusqlite::params![
                data.id,
                data.workspace_id,
                data.coordinator_session_id,
                serde_json::to_string(&data.awaiting_agents).unwrap_or_default(),
                serde_json::to_string(&data.wake_condition).unwrap_or_default(),
                serde_json::to_string(&data.status)
                    .unwrap_or_default()
                    .trim_matches('"'),
                data.timeout_at.map(|t| t.to_rfc3339()),
                data.created_at.to_rfc3339(),
                data.message_id,
                data.block_id,
            ],
        )
        .map_err(|e| SleepError::Database(e.to_string()))?;

        Ok(())
    }

    fn get_sleep(&self, sleep_id: &str) -> Result<Option<SleepBlockData>, SleepError> {
        let conn = self
            .db
            .get_connection()
            .map_err(|e| SleepError::Database(e.to_string()))?;

        let result = conn.query_row(
            "SELECT id, workspace_id, coordinator_session_id, awaiting_agents, wake_condition, \
             status, timeout_at, created_at, awakened_at, awakened_by, awaken_message, \
             message_id, block_id \
             FROM sleep_block WHERE id = ?1",
            [sleep_id],
            |row| {
                Ok(SleepBlockData {
                    id: row.get(0)?,
                    workspace_id: row.get(1)?,
                    coordinator_session_id: row.get(2)?,
                    awaiting_agents: serde_json::from_str(&row.get::<_, String>(3)?)
                        .unwrap_or_default(),
                    wake_condition: serde_json::from_str(&row.get::<_, String>(4)?)
                        .unwrap_or_default(),
                    status: serde_json::from_str(&format!("\"{}\"", row.get::<_, String>(5)?))
                        .unwrap_or_default(),
                    timeout_at: row
                        .get::<_, Option<String>>(6)?
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc)),
                    created_at: {
                        let s = row.get::<_, String>(7)?;
                        DateTime::parse_from_rfc3339(&s)
                            .map(|dt| dt.with_timezone(&Utc))
                            .unwrap_or_else(|e| {
                                log::warn!("[SleepManager] Failed to parse created_at in get_sleep '{}': {}", s, e);
                                DateTime::<Utc>::from(std::time::UNIX_EPOCH)
                            })
                    },
                    awakened_at: row
                        .get::<_, Option<String>>(8)?
                        .and_then(|s| DateTime::parse_from_rfc3339(&s).ok())
                        .map(|dt| dt.with_timezone(&Utc)),
                    awakened_by: row.get(9)?,
                    awaken_message: row.get(10)?,
                    message_id: row.get(11)?,
                    block_id: row.get(12)?,
                })
            },
        );

        match result {
            Ok(data) => Ok(Some(data)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(SleepError::Database(e.to_string())),
        }
    }

    fn update_sleep_status(
        &self,
        sleep_id: &str,
        status: SleepStatus,
        awakened_by: Option<&str>,
        awaken_message: Option<&str>,
    ) -> Result<(), SleepError> {
        Self::update_sleep_status_static(&self.db, sleep_id, status, awakened_by, awaken_message)
    }

    fn update_sleep_status_static(
        db: &WorkspaceDatabase,
        sleep_id: &str,
        status: SleepStatus,
        awakened_by: Option<&str>,
        awaken_message: Option<&str>,
    ) -> Result<(), SleepError> {
        let conn = db
            .get_connection()
            .map_err(|e| SleepError::Database(e.to_string()))?;

        conn.execute(
            "UPDATE sleep_block SET status = ?1, awakened_at = ?2, awakened_by = ?3, awaken_message = ?4 WHERE id = ?5",
            rusqlite::params![
                serde_json::to_string(&status).unwrap_or_default().trim_matches('"'),
                Utc::now().to_rfc3339(),
                awakened_by,
                awaken_message,
                sleep_id,
            ],
        ).map_err(|e| SleepError::Database(e.to_string()))?;

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    const WS_ID: &str = "ws_test";
    const COORD: &str = "coord_sess";
    const WORKER: &str = "worker_sess";

    fn setup_manager() -> (TempDir, SleepManager) {
        let temp_dir = TempDir::new().expect("temp dir");
        let db = super::super::database::WorkspaceDatabase::new(temp_dir.path(), WS_ID)
            .expect("workspace db");
        {
            let conn = db.get_connection().expect("conn");
            let now = Utc::now().to_rfc3339();
            conn.execute(
                "INSERT INTO workspace (id, name, status, creator_session_id, created_at, updated_at) \
                 VALUES (?1, 'test', 'active', ?2, ?3, ?3)",
                rusqlite::params![WS_ID, COORD, now],
            )
            .expect("insert workspace");
            for (session_id, role) in [(COORD, "coordinator"), (WORKER, "worker")] {
                conn.execute(
                    "INSERT INTO agent (session_id, workspace_id, role, status, joined_at, last_active_at) \
                     VALUES (?1, ?2, ?3, 'idle', ?4, ?4)",
                    rusqlite::params![session_id, WS_ID, role, now],
                )
                .expect("insert agent");
            }
        }
        (temp_dir, SleepManager::new(Arc::new(db)))
    }

    fn set_agent_status(manager: &SleepManager, session_id: &str, status: &str) {
        let conn = manager.db.get_connection().expect("conn");
        conn.execute(
            "UPDATE agent SET status = ?1 WHERE session_id = ?2",
            rusqlite::params![status, session_id],
        )
        .expect("update agent status");
    }

    /// 向 coordinator 的 inbox 插入一条未读消息（模拟 worker 在睡眠创建前发出的消息）
    fn insert_unread_inbox_message(manager: &SleepManager, message_type: &str, content: &str) {
        let conn = manager.db.get_connection().expect("conn");
        let now = Utc::now().to_rfc3339();
        let msg_id = format!("wsmsg_{}", ulid::Ulid::new());
        conn.execute(
            "INSERT INTO message (id, workspace_id, sender_session_id, target_session_id, \
             message_type, content, status, created_at) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'delivered', ?7)",
            rusqlite::params![msg_id, WS_ID, WORKER, COORD, message_type, content, now],
        )
        .expect("insert message");
        conn.execute(
            "INSERT INTO inbox (session_id, message_id, priority, status, created_at) \
             VALUES (?1, ?2, 0, 'unread', ?3)",
            rusqlite::params![COORD, msg_id, now],
        )
        .expect("insert inbox item");
    }

    fn make_sleep_data(wake_condition: WakeCondition) -> SleepBlockData {
        // 不设置 timeout_at，避免测试依赖 tokio runtime（spawn_timeout_task）
        SleepBlockData::new(
            WS_ID.to_string(),
            COORD.to_string(),
            vec![WORKER.to_string()],
            wake_condition,
        )
    }

    #[test]
    fn initial_check_wakes_when_result_arrived_before_sleep() {
        let (_dir, manager) = setup_manager();
        insert_unread_inbox_message(&manager, "result", "早到的结果");

        let data = make_sleep_data(WakeCondition::ResultMessage);
        let mut rx = manager.begin_sleep(&data).expect("begin sleep");

        let awakened = manager
            .check_initial_wake_conditions(&data.id)
            .expect("initial check");
        assert_eq!(awakened.len(), 1);
        assert_eq!(awakened[0].wake_reason, "message");
        assert_eq!(awakened[0].awakened_by, WORKER);

        let payload = rx.try_recv().expect("wake payload delivered");
        assert_eq!(payload.reason, WakeReason::Message);
        assert_eq!(
            payload.message.as_ref().map(|m| m.content.as_str()),
            Some("早到的结果")
        );

        // 与正常唤醒同路径：DB 状态被更新，active_sleeps 中已移除
        let stored = manager.get_sleep(&data.id).unwrap().unwrap();
        assert_eq!(stored.status, SleepStatus::Awakened);
        assert!(!manager.is_sleep_active(&data.id));
    }

    #[test]
    fn initial_check_wakes_when_agents_already_terminal() {
        let (_dir, manager) = setup_manager();
        // worker 在睡眠创建前就已进入终态（含新加入的 cancelled）
        set_agent_status(&manager, WORKER, "cancelled");

        let data = make_sleep_data(WakeCondition::ResultMessage);
        let mut rx = manager.begin_sleep(&data).expect("begin sleep");

        let awakened = manager
            .check_initial_wake_conditions(&data.id)
            .expect("initial check");
        assert_eq!(awakened.len(), 1);
        assert_eq!(awakened[0].wake_reason, "all_completed");

        let payload = rx.try_recv().expect("wake payload delivered");
        assert_eq!(payload.reason, WakeReason::AllCompleted);

        let stored = manager.get_sleep(&data.id).unwrap().unwrap();
        assert_eq!(stored.status, SleepStatus::Awakened);
    }

    #[test]
    fn initial_check_does_not_wake_without_conditions() {
        let (_dir, manager) = setup_manager();
        set_agent_status(&manager, WORKER, "running");
        // inbox 中只有 progress 消息，不满足 ResultMessage 条件
        insert_unread_inbox_message(&manager, "progress", "进行中");

        let data = make_sleep_data(WakeCondition::ResultMessage);
        let mut rx = manager.begin_sleep(&data).expect("begin sleep");

        let awakened = manager
            .check_initial_wake_conditions(&data.id)
            .expect("initial check");
        assert!(awakened.is_empty());
        assert!(rx.try_recv().is_err());

        // 正常睡眠不受影响
        assert!(manager.is_sleep_active(&data.id));
        let stored = manager.get_sleep(&data.id).unwrap().unwrap();
        assert_eq!(stored.status, SleepStatus::Sleeping);
    }

    #[test]
    fn agent_status_wake_treats_cancelled_as_terminal() {
        let (_dir, manager) = setup_manager();
        let data = make_sleep_data(WakeCondition::ResultMessage);
        let mut rx = manager.begin_sleep(&data).expect("begin sleep");

        // worker 被取消 → 应触发 all-terminal 唤醒而不是睡到超时
        set_agent_status(&manager, WORKER, "cancelled");
        let awakened = manager
            .check_and_wake_by_agent_status(WS_ID, WORKER, &AgentStatus::Cancelled)
            .expect("wake by status");
        assert_eq!(awakened.len(), 1);
        assert_eq!(awakened[0].wake_reason, "all_completed");

        let payload = rx.try_recv().expect("wake payload delivered");
        assert_eq!(payload.reason, WakeReason::AllCompleted);
    }

    #[test]
    fn restore_and_activate_sleeps_is_idempotent() {
        let (_dir, manager) = setup_manager();
        let data = make_sleep_data(WakeCondition::ResultMessage);
        // 仅持久化（模拟重启前遗留的 sleeping 记录），不注册 active_sleeps
        manager.save_sleep(&data).expect("save sleep");

        let first = manager
            .restore_and_activate_sleeps()
            .expect("first restore");
        assert_eq!(first.len(), 1);

        // 第二次恢复（如 get_instance 并发重入）不应重复激活
        let second = manager
            .restore_and_activate_sleeps()
            .expect("second restore");
        assert!(second.is_empty());
        assert!(manager.is_sleep_active(&data.id));
    }
}
