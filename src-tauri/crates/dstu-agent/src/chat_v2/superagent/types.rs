//! Super-agent 领域类型。
//!
//! 术语对照（见 docs 中 DeepSeek Harness 的 Super-agent 设计）：
//! - **Trigger**：环境中的半结构化事件（IM 消息、复习到期、CI 结果、自动化回执……）。
//! - **Thread**：同一话题/对象下连续 Trigger 构成的事件流，用 `thread_key` 标识。
//! - **Router**：常驻的全局路由会话，只做对外交互与任务分派，不亲自执行任务。
//! - **Worker**：上下文隔离的执行会话，订阅一个或多个 Thread，只向 Router 汇报。

use serde::{Deserialize, Serialize};

/// 内部来源标识：Watchdog / Worker 回报等系统生成的 Trigger。
pub const SOURCE_INTERNAL: &str = "internal";
/// Router 的投递目标名。
pub const TARGET_ROUTER: &str = "router";

/// 外部（或内部）传入的原始事件。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IncomingTrigger {
    /// 事件来源：`ilink` / `manual` / `review` / `automation` / `internal` ……
    pub source: String,
    /// 事件所属的话题流。为空时回退为 `"{source}:default"`。
    #[serde(default)]
    pub thread_key: String,
    /// 发送者标识（用户 id、机器人名……）。
    #[serde(default)]
    pub sender: String,
    /// 事件类型，自由文本，如 `message` / `review.due` / `ci.failed`。
    #[serde(default = "default_kind")]
    pub kind: String,
    /// 事件正文（不可信输入）。
    pub body: String,
    /// 幂等键：同一 (source, dedupe_key) 在窗口内只处理一次。
    #[serde(default)]
    pub dedupe_key: Option<String>,
    /// 是否是对 Agent 的显式请求（私聊、@、按钮点击）。显式请求不受 mention_only 限制。
    #[serde(default)]
    pub explicit_request: bool,
}

fn default_kind() -> String {
    "message".to_string()
}

impl IncomingTrigger {
    pub fn new(
        source: impl Into<String>,
        thread_key: impl Into<String>,
        body: impl Into<String>,
    ) -> Self {
        Self {
            source: source.into(),
            thread_key: thread_key.into(),
            sender: String::new(),
            kind: default_kind(),
            body: body.into(),
            dedupe_key: None,
            explicit_request: false,
        }
    }

    pub fn internal(
        thread_key: impl Into<String>,
        kind: impl Into<String>,
        body: impl Into<String>,
    ) -> Self {
        Self {
            source: SOURCE_INTERNAL.to_string(),
            thread_key: thread_key.into(),
            sender: "system".to_string(),
            kind: kind.into(),
            body: body.into(),
            dedupe_key: None,
            explicit_request: true,
        }
    }
}

/// 落库后的 Trigger。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Trigger {
    pub id: String,
    pub source: String,
    pub thread_key: String,
    pub sender: String,
    pub kind: String,
    pub body: String,
    pub dedupe_key: Option<String>,
    pub created_ms: i64,
    pub priority: i32,
}

impl Trigger {
    pub fn generate_id() -> String {
        format!("trg_{}", ulid::Ulid::new().to_string().to_lowercase())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerStatus {
    Idle,
    Running,
    Failed,
    Interrupted,
    Closed,
}

impl WorkerStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Running => "running",
            Self::Failed => "failed",
            Self::Interrupted => "interrupted",
            Self::Closed => "closed",
        }
    }

    pub fn parse(raw: &str) -> Self {
        match raw {
            "running" => Self::Running,
            "failed" => Self::Failed,
            "interrupted" => Self::Interrupted,
            "closed" => Self::Closed,
            _ => Self::Idle,
        }
    }
}

/// Worker 记录（对应一个独立上下文的 headless 命名会话）。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Worker {
    pub id: String,
    pub thread_key: String,
    pub title: String,
    /// Router 下发的任务简报，首轮运行时注入。
    pub brief: String,
    pub brief_sent: bool,
    pub session_id: Option<String>,
    pub status: WorkerStatus,
    pub created_ms: i64,
    pub last_progress_ms: i64,
    pub run_started_ms: Option<i64>,
    pub runs: i64,
    pub last_output_hash: Option<String>,
    /// 连续产出相同结果的次数（用于 Watchdog 识别空转）。
    pub repeat_count: i64,
}

impl Worker {
    pub fn generate_id() -> String {
        format!("swk_{}", ulid::Ulid::new().to_string().to_lowercase())
    }
}

/// Router 对用户可见的回复。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Reply {
    pub id: String,
    pub thread_key: String,
    pub text: String,
    pub created_ms: i64,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// 按字符数截断（不会切断 UTF-8），返回 (截断后文本, 被截去的字符数)。
pub fn clip_chars(text: &str, max_chars: usize) -> (String, usize) {
    let total = text.chars().count();
    if total <= max_chars {
        return (text.to_string(), 0);
    }
    (text.chars().take(max_chars).collect(), total - max_chars)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clip_chars_is_utf8_safe() {
        let (clipped, spilled) = clip_chars("复习到期提醒abc", 4);
        assert_eq!(clipped, "复习到期");
        assert_eq!(spilled, 5);
        let (same, none) = clip_chars("短", 10);
        assert_eq!(same, "短");
        assert_eq!(none, 0);
    }

    #[test]
    fn worker_status_roundtrip() {
        for s in [
            WorkerStatus::Idle,
            WorkerStatus::Running,
            WorkerStatus::Failed,
            WorkerStatus::Interrupted,
            WorkerStatus::Closed,
        ] {
            assert_eq!(WorkerStatus::parse(s.as_str()), s);
        }
    }
}
