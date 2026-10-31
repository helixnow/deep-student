//! 一期单 session 内存态（0..1）
//!
//! 持久化落点由 B1a `BrowserDatabase` / repository 负责；本模块只维护
//! controlMode / loading / 历史栈等运行时字段。

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use super::window::BROWSER_CONTENT_LABEL;

/// 默认历史栈上限
pub const MAX_HISTORY: usize = 50;

/// 用户显式接管后，拒绝 Agent 操作类工具的冷却秒数（对齐仲裁 15s；过后可「稍后再试」）
pub const USER_TAKEOVER_BLOCK_SECS: i64 = 15;

/// 会话控制权（仅内存）
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum ControlMode {
    #[default]
    User,
    Agent,
}

/// 打开会话参数（commands / agent 共用）
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenSessionOptions {
    pub url: String,
    pub display_name: Option<String>,
    pub chat_session_id: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub focused: Option<bool>,
    /// 若已有存活 session：focus + navigate（幂等）
    pub reuse_existing: Option<bool>,
    /// Agent 路径时置 true → 额外跑 `is_blocked_for_agent`
    pub from_agent: Option<bool>,
}

impl Default for OpenSessionOptions {
    fn default() -> Self {
        Self {
            url: String::new(),
            display_name: None,
            chat_session_id: None,
            width: None,
            height: None,
            focused: Some(true),
            reuse_existing: Some(true),
            from_agent: Some(false),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub url: String,
    pub title: String,
    pub visited_at: DateTime<Utc>,
}

/// 对外快照（get_state / 事件）
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSessionState {
    pub id: String,
    pub label: String,
    pub title: String,
    pub url: String,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub loading: bool,
    pub alive: bool,
    pub control_mode: ControlMode,
    pub history_index: usize,
    pub history_len: usize,
    pub chat_session_id: Option<String>,
    pub profile_path: String,
    pub created_at: String,
    pub updated_at: String,
}

/// 内存中的唯一会话
#[derive(Debug, Clone)]
pub struct BrowserSession {
    pub id: String,
    pub label: String,
    pub title: String,
    pub url: String,
    pub history: Vec<HistoryEntry>,
    pub history_index: usize,
    pub profile_path: PathBuf,
    pub chat_session_id: Option<String>,
    pub display_name: Option<String>,
    pub control_mode: ControlMode,
    pub loading: bool,
    pub alive: bool,
    /// 用户显式接管时间戳（ACR R1-05）；冷却期内 Agent 操作类工具返回 USER_TAKEOVER
    pub user_takeover_at: Option<DateTime<Utc>>,
    /// ACR 4.0（A7）：用户接管后 Agent 首次成功 claim 时需在回执中提示的闩锁。
    /// `take_over()` 置位；由执行器经 `consume_takeover_notice` 消费清除，
    /// 与 15s 冷却（`user_takeover_at`）互不影响。
    pub takeover_notice_pending: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl BrowserSession {
    pub fn new(
        id: String,
        url: String,
        profile_path: PathBuf,
        chat_session_id: Option<String>,
        display_name: Option<String>,
    ) -> Self {
        let now = Utc::now();
        let entry = HistoryEntry {
            url: url.clone(),
            title: String::new(),
            visited_at: now,
        };
        Self {
            id,
            label: BROWSER_CONTENT_LABEL.to_string(),
            title: String::new(),
            url,
            history: vec![entry],
            history_index: 0,
            profile_path,
            chat_session_id,
            display_name,
            control_mode: ControlMode::User,
            loading: true,
            alive: true,
            user_takeover_at: None,
            takeover_notice_pending: false,
            created_at: now,
            updated_at: now,
        }
    }

    pub fn can_go_back(&self) -> bool {
        self.history_index > 0
    }

    pub fn can_go_forward(&self) -> bool {
        self.history_index + 1 < self.history.len()
    }

    pub fn snapshot(&self) -> BrowserSessionState {
        BrowserSessionState {
            id: self.id.clone(),
            label: self.label.clone(),
            title: self.title.clone(),
            url: self.url.clone(),
            can_go_back: self.can_go_back(),
            can_go_forward: self.can_go_forward(),
            loading: self.loading,
            alive: self.alive,
            control_mode: self.control_mode,
            history_index: self.history_index,
            history_len: self.history.len(),
            chat_session_id: self.chat_session_id.clone(),
            profile_path: self.profile_path.to_string_lossy().into_owned(),
            created_at: self.created_at.to_rfc3339(),
            updated_at: self.updated_at.to_rfc3339(),
        }
    }

    /// 压入新 URL（截断前进栈）
    pub fn push_url(&mut self, url: String, title: Option<String>) {
        if self.history_index + 1 < self.history.len() {
            self.history.truncate(self.history_index + 1);
        }
        let now = Utc::now();
        self.history.push(HistoryEntry {
            url: url.clone(),
            title: title.unwrap_or_default(),
            visited_at: now,
        });
        if self.history.len() > MAX_HISTORY {
            let overflow = self.history.len() - MAX_HISTORY;
            self.history.drain(0..overflow);
        }
        self.history_index = self.history.len().saturating_sub(1);
        self.url = url;
        self.loading = true;
        self.updated_at = now;
    }

    /// 替换当前条目（reuse open / replace navigate）
    pub fn replace_url(&mut self, url: String, title: Option<String>) {
        let now = Utc::now();
        if let Some(entry) = self.history.get_mut(self.history_index) {
            entry.url = url.clone();
            if let Some(t) = title {
                entry.title = t;
            }
            entry.visited_at = now;
        } else {
            self.history.push(HistoryEntry {
                url: url.clone(),
                title: title.unwrap_or_default(),
                visited_at: now,
            });
            self.history_index = 0;
        }
        self.url = url;
        self.loading = true;
        self.updated_at = now;
    }

    pub fn go_back(&mut self) -> Option<String> {
        if !self.can_go_back() {
            return None;
        }
        self.history_index -= 1;
        let url = self.history[self.history_index].url.clone();
        self.url = url.clone();
        self.title = self.history[self.history_index].title.clone();
        self.loading = true;
        self.updated_at = Utc::now();
        Some(url)
    }

    pub fn go_forward(&mut self) -> Option<String> {
        if !self.can_go_forward() {
            return None;
        }
        self.history_index += 1;
        let url = self.history[self.history_index].url.clone();
        self.url = url.clone();
        self.title = self.history[self.history_index].title.clone();
        self.loading = true;
        self.updated_at = Utc::now();
        Some(url)
    }

    pub fn set_title(&mut self, title: String) {
        self.title = title.clone();
        if let Some(entry) = self.history.get_mut(self.history_index) {
            entry.title = title;
        }
        self.updated_at = Utc::now();
    }

    pub fn mark_loaded(&mut self, url: Option<String>) {
        if let Some(u) = url {
            self.url = u.clone();
            if let Some(entry) = self.history.get_mut(self.history_index) {
                entry.url = u;
            }
        }
        self.loading = false;
        self.updated_at = Utc::now();
    }

    pub fn mark_closed(&mut self) {
        self.alive = false;
        self.loading = false;
        self.updated_at = Utc::now();
    }

    pub fn set_control_mode(&mut self, mode: ControlMode) {
        self.control_mode = mode;
        // Agent 重新取得控制权时清除接管闩锁
        if mode == ControlMode::Agent {
            self.user_takeover_at = None;
        }
        self.updated_at = Utc::now();
    }

    /// 用户接管：强制 User 控制态，并打上接管时间戳（冷却期内拒绝 Agent 操作）
    pub fn take_over(&mut self) {
        self.control_mode = ControlMode::User;
        self.user_takeover_at = Some(Utc::now());
        // ACR 4.0（A7）：冷却结束后 Agent 首次 claim 的回执需要告知用户
        self.takeover_notice_pending = true;
        self.updated_at = Utc::now();
    }

    /// ACR 4.0（A7）：消费「用户接管后首次 claim」提示闩锁（返回消费前的值）。
    /// 只在 Agent 成功 claim 控制权后由执行器调用，用于回执提示字段。
    pub fn consume_takeover_notice(&mut self) -> bool {
        let pending = self.takeover_notice_pending;
        self.takeover_notice_pending = false;
        pending
    }

    /// 是否仍处于用户接管冷却期（过期则清除闩锁并返回 false）
    pub fn is_blocked_by_user_takeover(&mut self) -> bool {
        let Some(at) = self.user_takeover_at else {
            return false;
        };
        let elapsed = (Utc::now() - at).num_seconds();
        if elapsed < USER_TAKEOVER_BLOCK_SECS {
            return true;
        }
        self.user_takeover_at = None;
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn history_back_forward() {
        let mut s = BrowserSession::new(
            "bs_1".into(),
            "https://a.example/".into(),
            PathBuf::from("/tmp/p"),
            None,
            None,
        );
        s.push_url("https://b.example/".into(), None);
        s.push_url("https://c.example/".into(), None);
        assert!(s.can_go_back());
        assert!(!s.can_go_forward());
        assert_eq!(s.go_back().as_deref(), Some("https://b.example/"));
        assert!(s.can_go_forward());
        assert_eq!(s.go_forward().as_deref(), Some("https://c.example/"));
    }

    #[test]
    fn push_truncates_forward_stack() {
        let mut s = BrowserSession::new(
            "bs_1".into(),
            "https://a.example/".into(),
            PathBuf::from("/tmp/p"),
            None,
            None,
        );
        s.push_url("https://b.example/".into(), None);
        s.push_url("https://c.example/".into(), None);
        s.go_back();
        s.push_url("https://d.example/".into(), None);
        assert_eq!(s.history.len(), 3);
        assert_eq!(s.url, "https://d.example/");
        assert!(!s.can_go_forward());
    }

    /// ACR R1-05：用户接管闩锁与 Agent claim 清除
    #[test]
    fn user_takeover_blocks_then_clears_on_agent_claim() {
        let mut s = BrowserSession::new(
            "bs_1".into(),
            "https://a.example/".into(),
            PathBuf::from("/tmp/p"),
            None,
            None,
        );
        assert_eq!(s.control_mode, ControlMode::User);
        assert!(!s.is_blocked_by_user_takeover());

        s.set_control_mode(ControlMode::Agent);
        assert_eq!(s.control_mode, ControlMode::Agent);

        s.take_over();
        assert_eq!(s.control_mode, ControlMode::User);
        assert!(s.user_takeover_at.is_some());
        assert!(s.is_blocked_by_user_takeover());

        // Agent 重新 claim 后清除闩锁
        s.set_control_mode(ControlMode::Agent);
        assert_eq!(s.control_mode, ControlMode::Agent);
        assert!(s.user_takeover_at.is_none());
        assert!(!s.is_blocked_by_user_takeover());
    }

    /// ACR 4.0（A7）：接管提示闩锁——take_over 置位、claim 不清除、消费一次即清
    #[test]
    fn takeover_notice_latch_survives_claim_until_consumed() {
        let mut s = BrowserSession::new(
            "bs_1".into(),
            "https://a.example/".into(),
            PathBuf::from("/tmp/p"),
            None,
            None,
        );
        assert!(!s.takeover_notice_pending);
        assert!(!s.consume_takeover_notice());

        s.take_over();
        assert!(s.takeover_notice_pending);

        // 冷却过期清除 user_takeover_at，但提示闩锁保留给首次 claim 的回执
        s.user_takeover_at =
            Some(Utc::now() - chrono::Duration::seconds(USER_TAKEOVER_BLOCK_SECS + 1));
        assert!(!s.is_blocked_by_user_takeover());
        assert!(s.takeover_notice_pending);

        // Agent claim（set_control_mode）本身不消费闩锁——由执行器显式消费
        s.set_control_mode(ControlMode::Agent);
        assert!(s.takeover_notice_pending);
        assert!(s.consume_takeover_notice());
        assert!(!s.consume_takeover_notice());
    }

    #[test]
    fn user_takeover_block_expires() {
        let mut s = BrowserSession::new(
            "bs_1".into(),
            "https://a.example/".into(),
            PathBuf::from("/tmp/p"),
            None,
            None,
        );
        s.take_over();
        // 模拟冷却已过
        s.user_takeover_at =
            Some(Utc::now() - chrono::Duration::seconds(USER_TAKEOVER_BLOCK_SECS + 1));
        assert!(!s.is_blocked_by_user_takeover());
        assert!(s.user_takeover_at.is_none());
    }
}
