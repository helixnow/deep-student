//! Super 会话外部事件入口：Fast Path（确定性程序策略）+ 写入 Super 工作区收件箱。
//!
//! 迁移自旧 `superagent/types.rs`（`IncomingTrigger`）与 `superagent/filter.rs`
//! （过滤规则与测试）。差异：
//! - 去重与限速不再依赖 superagent.db，改为进程内存窗口 [`InboundWindow`]；
//! - 通过过滤的事件不再进入 Router 队列，而是作为 `Task` 消息写入 Super 工作区收件箱，
//!   由前端常驻控制器在会话空闲时经 `chat_v2_super_deliver_inbox` 投递。
//!
//! 过滤规则（按顺序，任一命中即丢弃）：
//! 1. 内部来源（`internal`）永远放行；
//! 2. 正文为空；
//! 3. 来源模式为 `ignore`；
//! 4. 发送者不在白名单（白名单非空时）；
//! 5. `mention_only` 来源里既非显式请求、也没有提及关键词、且该话题不属于进行中的对话；
//! 6. 幂等键在窗口内重复；
//! 7. 同一发送者超过每分钟速率上限。

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, LazyLock, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::chat_v2::workspace::{AgentRole, AgentStatus, MessageType, WorkspaceCoordinator};

/// 内部来源标识：系统生成的事件。
pub const SOURCE_INTERNAL: &str = "internal";

/// 外部事件伪发送者前缀：`external:{source}`（以 Coordinator 角色、Closed 状态登记在 Super 工作区，
/// 仅用于满足工作区「发送者必须是成员」的约束；不计入活跃配额、不会被当作 Worker）。
pub const EXTERNAL_SENDER_PREFIX: &str = "external:";

/// 外部事件消息 metadata 键（工作区消息 metadata 上的结构化来源）。
pub const EXTERNAL_META_KEY: &str = "super_external";

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

/// `post_external_event` 的结果。
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum IngestOutcome {
    /// Super 会话未启用（或尚无活跃 Super 会话）。
    Disabled,
    /// 被程序层过滤丢弃（`reason` 见 [`DropReason::as_str`]）。
    Dropped { reason: String },
    /// 已写入 Super 工作区收件箱。
    Accepted {
        #[serde(rename = "messageId")]
        message_id: String,
        priority: i32,
    },
}

// ============================================================================
// 过滤配置
// ============================================================================

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum SourceMode {
    /// 直接忽略该来源。
    Ignore,
    /// 作为候选事件：通过程序层后交给 Router 语义判断，Router 可选择不理会。
    Candidate,
    /// 视为明确请求：提升优先级，Router 应当处理。
    Request,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct SourcePolicy {
    pub mode: SourceMode,
    /// 非空时仅允许这些发送者。
    pub allow_senders: Vec<String>,
    /// 仅响应提及了任一关键词的消息（或显式请求，或进行中话题的后续消息）。
    pub mention_only: bool,
    pub mention_keywords: Vec<String>,
    /// 同一发送者每分钟上限（0 = 不限）。
    pub max_per_minute: u32,
}

impl Default for SourcePolicy {
    fn default() -> Self {
        Self {
            mode: SourceMode::Candidate,
            allow_senders: Vec::new(),
            mention_only: false,
            mention_keywords: Vec::new(),
            max_per_minute: 30,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct FilterConfig {
    pub default_policy: SourcePolicy,
    pub per_source: HashMap<String, SourcePolicy>,
    /// 幂等窗口（毫秒）。
    pub dedupe_window_ms: i64,
    /// 正文最大保留字符数（超出部分在入箱前截断，防止巨型载荷）。
    pub max_body_chars: usize,
}

impl Default for FilterConfig {
    fn default() -> Self {
        let mut per_source = HashMap::new();
        // 用户自己在应用内/手动发出的内容 = 明确请求
        per_source.insert(
            "manual".to_string(),
            SourcePolicy {
                mode: SourceMode::Request,
                max_per_minute: 0,
                ..SourcePolicy::default()
            },
        );
        per_source.insert(
            "chat".to_string(),
            SourcePolicy {
                mode: SourceMode::Request,
                max_per_minute: 0,
                ..SourcePolicy::default()
            },
        );
        // 绑定用户的私聊渠道（iLink）：同样是明确请求
        per_source.insert(
            "ilink".to_string(),
            SourcePolicy {
                mode: SourceMode::Request,
                max_per_minute: 20,
                ..SourcePolicy::default()
            },
        );
        Self {
            default_policy: SourcePolicy::default(),
            per_source,
            dedupe_window_ms: 10 * 60 * 1000,
            max_body_chars: 20_000,
        }
    }
}

impl FilterConfig {
    pub fn policy_for(&self, source: &str) -> &SourcePolicy {
        self.per_source.get(source).unwrap_or(&self.default_policy)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DropReason {
    EmptyBody,
    SourceIgnored,
    SenderNotAllowed,
    NotMentioned,
    Duplicate,
    RateLimited,
}

impl DropReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::EmptyBody => "empty_body",
            Self::SourceIgnored => "source_ignored",
            Self::SenderNotAllowed => "sender_not_allowed",
            Self::NotMentioned => "not_mentioned",
            Self::Duplicate => "duplicate",
            Self::RateLimited => "rate_limited",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Drop(DropReason),
    /// 放行；`priority`：2 = 内部/紧急，1 = 明确请求，0 = 普通候选。
    Accept {
        priority: i32,
    },
}

// ============================================================================
// 内存窗口（替代旧 superagent.db 的 dedupe / 速率查询）
// ============================================================================

/// 单个 (source, sender) 速率桶最多保留的时间戳数（足够覆盖任何合理的每分钟上限）。
const RATE_BUCKET_CAP: usize = 512;
/// 去重表最大条目数（超出时先按窗口清理，仍超出则清空最旧的一半）。
const DEDUPE_CAP: usize = 4_096;

/// 进程内去重 / 限速窗口。重启后清零（可接受：外部事件源自身应有幂等键）。
#[derive(Debug, Default)]
pub struct InboundWindow {
    /// (source, dedupe_key) -> 最近一次接受时间（ms）
    dedupe: HashMap<(String, String), i64>,
    /// (source, sender) -> 最近接受时间（ms，升序）
    rate: HashMap<(String, String), VecDeque<i64>>,
}

impl InboundWindow {
    pub fn new() -> Self {
        Self::default()
    }

    /// `since_ms` 之后是否接受过同一 (source, key)。
    pub fn has_recent_dedupe(&self, source: &str, key: &str, since_ms: i64) -> bool {
        self.dedupe
            .get(&(source.to_string(), key.to_string()))
            .is_some_and(|ts| *ts >= since_ms)
    }

    /// `since_ms` 之后同一 (source, sender) 被接受的次数。
    pub fn count_recent_from(&self, source: &str, sender: &str, since_ms: i64) -> usize {
        self.rate
            .get(&(source.to_string(), sender.to_string()))
            .map(|q| q.iter().filter(|ts| **ts >= since_ms).count())
            .unwrap_or(0)
    }

    /// 记录一条被接受的事件（供后续去重 / 限速判定）。
    pub fn record(&mut self, t: &IncomingTrigger, now_ms: i64, dedupe_window_ms: i64) {
        if let Some(key) = t.dedupe_key.as_deref().filter(|k| !k.is_empty()) {
            self.dedupe
                .insert((t.source.clone(), key.to_string()), now_ms);
            if self.dedupe.len() > DEDUPE_CAP {
                let cutoff = now_ms - dedupe_window_ms;
                self.dedupe.retain(|_, ts| *ts >= cutoff);
                if self.dedupe.len() > DEDUPE_CAP {
                    let mut stamps: Vec<i64> = self.dedupe.values().copied().collect();
                    stamps.sort_unstable();
                    let median = stamps[stamps.len() / 2];
                    self.dedupe.retain(|_, ts| *ts >= median);
                }
            }
        }
        if !t.sender.is_empty() {
            let bucket = self
                .rate
                .entry((t.source.clone(), t.sender.clone()))
                .or_default();
            bucket.push_back(now_ms);
            let cutoff = now_ms - 60_000;
            while bucket.front().is_some_and(|ts| *ts < cutoff) || bucket.len() > RATE_BUCKET_CAP {
                bucket.pop_front();
            }
        }
    }
}

static INBOUND_WINDOW: LazyLock<Mutex<InboundWindow>> =
    LazyLock::new(|| Mutex::new(InboundWindow::new()));

/// 对一条事件做程序层判定。`thread_has_subscribers` 表示该话题属于进行中的对话
/// （不再要求 mention）；新架构没有话题订阅，`post_external_event` 恒传 false。
pub fn evaluate(
    cfg: &FilterConfig,
    window: &InboundWindow,
    t: &IncomingTrigger,
    thread_has_subscribers: bool,
    now_ms: i64,
) -> Verdict {
    if t.source == SOURCE_INTERNAL {
        return Verdict::Accept { priority: 2 };
    }
    if t.body.trim().is_empty() {
        return Verdict::Drop(DropReason::EmptyBody);
    }
    let policy = cfg.policy_for(&t.source);
    if policy.mode == SourceMode::Ignore {
        return Verdict::Drop(DropReason::SourceIgnored);
    }
    if !policy.allow_senders.is_empty() && !policy.allow_senders.iter().any(|s| s == &t.sender) {
        return Verdict::Drop(DropReason::SenderNotAllowed);
    }
    if policy.mention_only && !t.explicit_request && !thread_has_subscribers {
        let lowered = t.body.to_lowercase();
        let mentioned = policy
            .mention_keywords
            .iter()
            .any(|k| !k.is_empty() && lowered.contains(&k.to_lowercase()));
        if !mentioned {
            return Verdict::Drop(DropReason::NotMentioned);
        }
    }
    if let Some(key) = t.dedupe_key.as_deref().filter(|k| !k.is_empty()) {
        if window.has_recent_dedupe(&t.source, key, now_ms - cfg.dedupe_window_ms) {
            return Verdict::Drop(DropReason::Duplicate);
        }
    }
    if policy.max_per_minute > 0 && !t.sender.is_empty() {
        let recent = window.count_recent_from(&t.source, &t.sender, now_ms - 60_000);
        if recent >= policy.max_per_minute as usize {
            return Verdict::Drop(DropReason::RateLimited);
        }
    }
    let priority = if policy.mode == SourceMode::Request || t.explicit_request {
        1
    } else {
        0
    };
    Verdict::Accept { priority }
}

/// 判定并（放行时）记入窗口；原子完成，避免并发事件同时穿过去重/限速。
pub fn evaluate_and_record(
    cfg: &FilterConfig,
    window: &mut InboundWindow,
    t: &IncomingTrigger,
    now_ms: i64,
) -> Verdict {
    let verdict = evaluate(cfg, window, t, false, now_ms);
    if matches!(verdict, Verdict::Accept { .. }) && t.source != SOURCE_INTERNAL {
        window.record(t, now_ms, cfg.dedupe_window_ms);
    }
    verdict
}

/// 规范化：空话题回退 `{source}:default`，正文按字符截断。
pub fn normalize_trigger(mut t: IncomingTrigger, cfg: &FilterConfig) -> IncomingTrigger {
    if t.thread_key.trim().is_empty() {
        t.thread_key = format!("{}:default", t.source);
    }
    let total = t.body.chars().count();
    if total > cfg.max_body_chars {
        t.body = t.body.chars().take(cfg.max_body_chars).collect();
    }
    t
}

/// 外部来源 → 伪发送者 id（只保留 `[A-Za-z0-9_.-]`，最长 48 字符）。
pub fn external_sender_id(source: &str) -> String {
    let cleaned: String = source
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        .take(48)
        .collect();
    let cleaned = if cleaned.is_empty() {
        "unknown".to_string()
    } else {
        cleaned
    };
    format!("{EXTERNAL_SENDER_PREFIX}{cleaned}")
}

/// 是否为外部事件伪发送者 id。
pub fn is_external_sender(session_id: &str) -> bool {
    session_id.starts_with(EXTERNAL_SENDER_PREFIX)
}

/// 确保外部伪发送者已登记为工作区成员（Coordinator 角色、Closed 状态：不占活跃配额，
/// 不会被 Worker 维度的取消/删除/名册逻辑处理）。
pub(crate) fn ensure_external_sender(
    coordinator: &WorkspaceCoordinator,
    workspace_id: &str,
    sender_id: &str,
) -> Result<(), String> {
    if coordinator.get_agent(workspace_id, sender_id)?.is_some() {
        return Ok(());
    }
    coordinator.register_agent(
        workspace_id,
        sender_id,
        AgentRole::Coordinator,
        None,
        Some(json!({ "super_agent": { "external_source": true } })),
    )?;
    coordinator.update_agent_status(workspace_id, sender_id, AgentStatus::Closed)?;
    Ok(())
}

/// 写入 Super 工作区收件箱（核心，可测）。返回工作区消息 id。
pub(crate) fn enqueue_external_event(
    coordinator: &WorkspaceCoordinator,
    workspace_id: &str,
    super_session_id: &str,
    trigger: &IncomingTrigger,
    priority: i32,
) -> Result<String, String> {
    let sender_id = external_sender_id(&trigger.source);
    ensure_external_sender(coordinator, workspace_id, &sender_id)?;
    // 正文原样入箱（不可信）；投递格式化时统一中和并包进 <untrusted_event>。
    let message = coordinator.send_message(
        workspace_id,
        &sender_id,
        Some(super_session_id),
        MessageType::Task,
        trigger.body.clone(),
    )?;
    // 键名与 EXTERNAL_META_KEY 一致（json! 键用字面量，避免宏对标识符键的歧义）
    let metadata = json!({
        "super_external": {
            "source": trigger.source,
            "sender": trigger.sender,
            "kind": trigger.kind,
            "threadKey": trigger.thread_key,
            "explicitRequest": trigger.explicit_request,
            "priority": priority,
            "receivedAt": chrono::Utc::now().to_rfc3339(),
        }
    });
    if let Err(error) = coordinator.update_message_metadata(workspace_id, &message.id, &metadata) {
        log::warn!(
            "[SuperSession::inbound] Failed to persist external event metadata (message={}): {}",
            message.id,
            error
        );
    }
    Ok(message.id)
}

/// 外部事件入口（替代旧 `superagent::emit_trigger`）。本次不接任何事件源。
///
/// filter（来源策略、白名单、mention、空正文；去重和限速用内存窗口）→ 写 Super 工作区
/// 收件箱（`Task` 消息，发送者 `external:{source}`）→ 发 `super_session_inbox_changed`。
pub fn post_external_event(app: &AppHandle, trigger: IncomingTrigger) -> IngestOutcome {
    if !super::state::is_enabled(app) {
        return IngestOutcome::Disabled;
    }
    let Some(db) = app
        .try_state::<Arc<crate::chat_v2::database::ChatV2Database>>()
        .map(|s| s.inner().clone())
    else {
        return IngestOutcome::Disabled;
    };
    let Some(coordinator) = app
        .try_state::<Arc<WorkspaceCoordinator>>()
        .map(|s| s.inner().clone())
    else {
        return IngestOutcome::Disabled;
    };
    let Some(current) = super::state::current_super(&db) else {
        return IngestOutcome::Disabled;
    };
    let Some(workspace_id) = current.workspace_id.clone() else {
        return IngestOutcome::Disabled;
    };
    if current.hidden {
        return IngestOutcome::Disabled;
    }

    let cfg = FilterConfig::default();
    let trigger = normalize_trigger(trigger, &cfg);
    let now = chrono::Utc::now().timestamp_millis();
    let verdict = {
        let mut window = INBOUND_WINDOW.lock().unwrap_or_else(|p| p.into_inner());
        evaluate_and_record(&cfg, &mut window, &trigger, now)
    };
    let priority = match verdict {
        Verdict::Drop(reason) => {
            log::info!(
                "[SuperSession::inbound] Dropped external event: source={}, thread={}, reason={}",
                trigger.source,
                trigger.thread_key,
                reason.as_str()
            );
            return IngestOutcome::Dropped {
                reason: reason.as_str().to_string(),
            };
        }
        Verdict::Accept { priority } => priority,
    };

    match enqueue_external_event(
        &coordinator,
        &workspace_id,
        &current.session_id,
        &trigger,
        priority,
    ) {
        Ok(message_id) => {
            super::state::emit_inbox_changed(app, &coordinator, &current.session_id, &workspace_id);
            IngestOutcome::Accepted {
                message_id,
                priority,
            }
        }
        Err(error) => {
            log::warn!(
                "[SuperSession::inbound] Failed to enqueue external event (source={}): {}",
                trigger.source,
                error
            );
            IngestOutcome::Dropped {
                reason: "enqueue_failed".to_string(),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn incoming(source: &str, sender: &str, body: &str) -> IncomingTrigger {
        let mut t = IncomingTrigger::new(source, "th", body);
        t.sender = sender.into();
        t
    }

    fn eval(
        cfg: &FilterConfig,
        window: &InboundWindow,
        t: &IncomingTrigger,
        subs: bool,
    ) -> Verdict {
        evaluate(cfg, window, t, subs, 1_000_000)
    }

    #[test]
    fn internal_always_accepted_with_top_priority() {
        let cfg = FilterConfig::default();
        let window = InboundWindow::new();
        let t = IncomingTrigger::internal("th", "watchdog.stalled", "x");
        assert_eq!(
            eval(&cfg, &window, &t, false),
            Verdict::Accept { priority: 2 }
        );
    }

    #[test]
    fn empty_ignored_and_allowlist() {
        let mut cfg = FilterConfig::default();
        cfg.per_source.insert(
            "chat".into(),
            SourcePolicy {
                allow_senders: vec!["alice".into()],
                ..SourcePolicy::default()
            },
        );
        cfg.per_source.insert(
            "noise".into(),
            SourcePolicy {
                mode: SourceMode::Ignore,
                ..SourcePolicy::default()
            },
        );
        let window = InboundWindow::new();
        assert_eq!(
            eval(&cfg, &window, &incoming("chat", "alice", "  "), false),
            Verdict::Drop(DropReason::EmptyBody)
        );
        assert_eq!(
            eval(&cfg, &window, &incoming("chat", "bob", "hi"), false),
            Verdict::Drop(DropReason::SenderNotAllowed)
        );
        assert_eq!(
            eval(&cfg, &window, &incoming("chat", "alice", "hi"), false),
            Verdict::Accept { priority: 0 }
        );
        assert_eq!(
            eval(&cfg, &window, &incoming("noise", "alice", "hi"), false),
            Verdict::Drop(DropReason::SourceIgnored)
        );
    }

    #[test]
    fn mention_only_bypassed_by_explicit_request_or_subscription() {
        let mut cfg = FilterConfig::default();
        cfg.per_source.insert(
            "group".into(),
            SourcePolicy {
                mention_only: true,
                mention_keywords: vec!["@Bot".into()],
                ..SourcePolicy::default()
            },
        );
        let window = InboundWindow::new();
        let chatter = incoming("group", "u", "lunch?");
        assert_eq!(
            eval(&cfg, &window, &chatter, false),
            Verdict::Drop(DropReason::NotMentioned)
        );
        assert_eq!(
            eval(&cfg, &window, &chatter, true),
            Verdict::Accept { priority: 0 }
        );
        let mention = incoming("group", "u", "hey @bot look at this");
        assert_eq!(
            eval(&cfg, &window, &mention, false),
            Verdict::Accept { priority: 0 }
        );
        let mut explicit = chatter.clone();
        explicit.explicit_request = true;
        assert_eq!(
            eval(&cfg, &window, &explicit, false),
            Verdict::Accept { priority: 1 }
        );
    }

    #[test]
    fn dedupe_and_rate_limit() {
        let mut cfg = FilterConfig::default();
        cfg.per_source.insert(
            "s".into(),
            SourcePolicy {
                max_per_minute: 2,
                ..SourcePolicy::default()
            },
        );
        let mut window = InboundWindow::new();
        let seed = |window: &mut InboundWindow, dedupe: Option<&str>| {
            let mut t = incoming("s", "u", "b");
            t.dedupe_key = dedupe.map(str::to_string);
            window.record(&t, 999_900, cfg.dedupe_window_ms);
        };
        seed(&mut window, Some("k1"));
        let mut dup = incoming("s", "u", "hi");
        dup.dedupe_key = Some("k1".into());
        assert_eq!(
            eval(&cfg, &window, &dup, false),
            Verdict::Drop(DropReason::Duplicate)
        );
        seed(&mut window, None);
        let fresh = incoming("s", "u", "hi");
        assert_eq!(
            eval(&cfg, &window, &fresh, false),
            Verdict::Drop(DropReason::RateLimited)
        );
        assert_eq!(
            eval(&cfg, &window, &incoming("s", "other", "hi"), false),
            Verdict::Accept { priority: 0 }
        );
    }

    #[test]
    fn default_config_treats_manual_and_ilink_as_requests() {
        let cfg = FilterConfig::default();
        let window = InboundWindow::new();
        assert_eq!(
            eval(&cfg, &window, &incoming("manual", "me", "do x"), false),
            Verdict::Accept { priority: 1 }
        );
        assert_eq!(
            eval(&cfg, &window, &incoming("ilink", "me", "do x"), false),
            Verdict::Accept { priority: 1 }
        );
        assert_eq!(
            eval(&cfg, &window, &incoming("chat", "me", "do x"), false),
            Verdict::Accept { priority: 1 }
        );
        assert_eq!(
            eval(&cfg, &window, &incoming("webhook", "me", "do x"), false),
            Verdict::Accept { priority: 0 }
        );
    }

    #[test]
    fn memory_window_expires_dedupe_and_rate() {
        let cfg = FilterConfig::default();
        let mut window = InboundWindow::new();
        let mut t = incoming("webhook", "u", "hello");
        t.dedupe_key = Some("evt-1".into());
        assert_eq!(
            evaluate_and_record(&cfg, &mut window, &t, 0),
            Verdict::Accept { priority: 0 }
        );
        // 窗口内重复 → Duplicate
        assert_eq!(
            evaluate_and_record(&cfg, &mut window, &t, 1_000),
            Verdict::Drop(DropReason::Duplicate)
        );
        // 窗口外 → 再次放行
        assert_eq!(
            evaluate_and_record(&cfg, &mut window, &t, cfg.dedupe_window_ms + 1),
            Verdict::Accept { priority: 0 }
        );
        // 速率：默认 30/分钟，一分钟后计数清零
        let mut w2 = InboundWindow::new();
        let flood = incoming("webhook", "spammer", "x");
        for i in 0..30 {
            assert!(matches!(
                evaluate_and_record(&cfg, &mut w2, &flood, i),
                Verdict::Accept { .. }
            ));
        }
        assert_eq!(
            evaluate_and_record(&cfg, &mut w2, &flood, 100),
            Verdict::Drop(DropReason::RateLimited)
        );
        assert!(matches!(
            evaluate_and_record(&cfg, &mut w2, &flood, 61_000),
            Verdict::Accept { .. }
        ));
    }

    #[test]
    fn normalize_defaults_thread_and_clips_body() {
        let mut cfg = FilterConfig::default();
        cfg.max_body_chars = 4;
        let t = normalize_trigger(IncomingTrigger::new("ilink", " ", "复习到期提醒abc"), &cfg);
        assert_eq!(t.thread_key, "ilink:default");
        assert_eq!(t.body, "复习到期");
    }

    #[test]
    fn external_sender_id_is_sanitized() {
        assert_eq!(external_sender_id("ilink"), "external:ilink");
        assert_eq!(external_sender_id("a b/c<d>"), "external:abcd");
        assert_eq!(external_sender_id("  "), "external:unknown");
        assert!(is_external_sender("external:ilink"));
        assert!(!is_external_sender("subagent_explorer_1"));
    }

    #[test]
    fn enqueue_external_event_lands_in_super_inbox() {
        let dir = tempfile::TempDir::new().unwrap();
        let coordinator = WorkspaceCoordinator::new(dir.path().to_path_buf());
        let ws = coordinator.create_workspace("sess_super", None).unwrap();
        coordinator
            .register_agent(&ws.id, "sess_super", AgentRole::Coordinator, None, None)
            .unwrap();
        let mut t = IncomingTrigger::new("ilink", "th", "请帮我看看");
        t.sender = "u1".into();
        let id = enqueue_external_event(&coordinator, &ws.id, "sess_super", &t, 1).unwrap();
        // 第二条复用同一伪发送者
        enqueue_external_event(&coordinator, &ws.id, "sess_super", &t, 1).unwrap();
        assert_eq!(
            coordinator
                .pending_inbox_count(&ws.id, "sess_super")
                .unwrap(),
            2
        );
        let sender = coordinator
            .get_agent(&ws.id, "external:ilink")
            .unwrap()
            .expect("pseudo sender registered");
        assert_eq!(sender.role, AgentRole::Coordinator);
        assert_eq!(sender.status, AgentStatus::Closed);
        let drained = coordinator.drain_inbox(&ws.id, "sess_super", 10).unwrap();
        assert_eq!(drained[0].id, id);
        assert_eq!(drained[0].sender_session_id, "external:ilink");
        let meta = drained[0].metadata.clone().expect("external metadata");
        assert_eq!(meta[EXTERNAL_META_KEY]["source"], "ilink");
        assert_eq!(meta[EXTERNAL_META_KEY]["sender"], "u1");
    }
}
