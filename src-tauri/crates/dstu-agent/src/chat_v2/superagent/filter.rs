//! 事件过滤：Fast Path（确定性程序策略）。
//!
//! 环境事件流“高噪音、低触发率”。在调用任何 LLM 之前，先用确定性规则筛掉
//! 绝大多数无关消息；只有通过的候选才会进入 Router（Slow Path，语义判断）。
//!
//! 规则（按顺序，任一命中即丢弃）：
//! 1. 内部来源（`internal`）永远放行；
//! 2. 来源模式为 `ignore`；
//! 3. 发送者不在白名单（白名单非空时）；
//! 4. `mention_only` 来源里既非显式请求、也没有提及关键词、且该话题尚无订阅 Worker；
//! 5. 幂等键在窗口内重复；
//! 6. 同一发送者超过每分钟速率上限；
//! 7. 正文为空。

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use super::store::SuperAgentStore;
use super::types::{IncomingTrigger, SOURCE_INTERNAL};

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
    /// 仅响应提及了任一关键词的消息（或显式请求，或已订阅话题的后续消息）。
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
    /// 正文最大保留字符数（超出部分在落库前截断，防止巨型载荷）。
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
        // Super-agent 模式页里用户直接输入的内容 = 明确请求
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

/// 对一条事件做程序层判定。`thread_has_subscribers` 表示该话题已有 Worker 订阅
/// （属于进行中的对话，不再要求 mention）。
pub fn evaluate(
    cfg: &FilterConfig,
    store: &SuperAgentStore,
    t: &IncomingTrigger,
    thread_has_subscribers: bool,
    now_ms: i64,
) -> Result<Verdict, String> {
    if t.source == SOURCE_INTERNAL {
        return Ok(Verdict::Accept { priority: 2 });
    }
    if t.body.trim().is_empty() {
        return Ok(Verdict::Drop(DropReason::EmptyBody));
    }
    let policy = cfg.policy_for(&t.source);
    if policy.mode == SourceMode::Ignore {
        return Ok(Verdict::Drop(DropReason::SourceIgnored));
    }
    if !policy.allow_senders.is_empty() && !policy.allow_senders.iter().any(|s| s == &t.sender) {
        return Ok(Verdict::Drop(DropReason::SenderNotAllowed));
    }
    if policy.mention_only && !t.explicit_request && !thread_has_subscribers {
        let lowered = t.body.to_lowercase();
        let mentioned = policy
            .mention_keywords
            .iter()
            .any(|k| !k.is_empty() && lowered.contains(&k.to_lowercase()));
        if !mentioned {
            return Ok(Verdict::Drop(DropReason::NotMentioned));
        }
    }
    if let Some(key) = t.dedupe_key.as_deref().filter(|k| !k.is_empty()) {
        if store.has_recent_dedupe(&t.source, key, now_ms - cfg.dedupe_window_ms)? {
            return Ok(Verdict::Drop(DropReason::Duplicate));
        }
    }
    if policy.max_per_minute > 0 && !t.sender.is_empty() {
        let recent = store.count_recent_from(&t.source, &t.sender, now_ms - 60_000)?;
        if recent >= i64::from(policy.max_per_minute) {
            return Ok(Verdict::Drop(DropReason::RateLimited));
        }
    }
    let priority = if policy.mode == SourceMode::Request || t.explicit_request {
        1
    } else {
        0
    };
    Ok(Verdict::Accept { priority })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::superagent::types::Trigger;

    fn incoming(source: &str, sender: &str, body: &str) -> IncomingTrigger {
        let mut t = IncomingTrigger::new(source, "th", body);
        t.sender = sender.into();
        t
    }

    fn eval(
        cfg: &FilterConfig,
        store: &SuperAgentStore,
        t: &IncomingTrigger,
        subs: bool,
    ) -> Verdict {
        evaluate(cfg, store, t, subs, 1_000_000).unwrap()
    }

    #[test]
    fn internal_always_accepted_with_top_priority() {
        let cfg = FilterConfig::default();
        let store = SuperAgentStore::open_in_memory();
        let t = IncomingTrigger::internal("th", "watchdog.stalled", "x");
        assert_eq!(
            eval(&cfg, &store, &t, false),
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
        let store = SuperAgentStore::open_in_memory();
        assert_eq!(
            eval(&cfg, &store, &incoming("chat", "alice", "  "), false),
            Verdict::Drop(DropReason::EmptyBody)
        );
        assert_eq!(
            eval(&cfg, &store, &incoming("chat", "bob", "hi"), false),
            Verdict::Drop(DropReason::SenderNotAllowed)
        );
        assert_eq!(
            eval(&cfg, &store, &incoming("chat", "alice", "hi"), false),
            Verdict::Accept { priority: 0 }
        );
        assert_eq!(
            eval(&cfg, &store, &incoming("noise", "alice", "hi"), false),
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
        let store = SuperAgentStore::open_in_memory();
        let chatter = incoming("group", "u", "lunch?");
        assert_eq!(
            eval(&cfg, &store, &chatter, false),
            Verdict::Drop(DropReason::NotMentioned)
        );
        assert_eq!(
            eval(&cfg, &store, &chatter, true),
            Verdict::Accept { priority: 0 }
        );
        let mention = incoming("group", "u", "hey @bot look at this");
        assert_eq!(
            eval(&cfg, &store, &mention, false),
            Verdict::Accept { priority: 0 }
        );
        let mut explicit = chatter.clone();
        explicit.explicit_request = true;
        assert_eq!(
            eval(&cfg, &store, &explicit, false),
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
        let store = SuperAgentStore::open_in_memory();
        let seed = |id: &str, dedupe: Option<&str>| {
            store
                .insert_trigger(
                    &Trigger {
                        id: id.into(),
                        source: "s".into(),
                        thread_key: "th".into(),
                        sender: "u".into(),
                        kind: "message".into(),
                        body: "b".into(),
                        dedupe_key: dedupe.map(str::to_string),
                        created_ms: 999_900,
                        priority: 0,
                    },
                    &[],
                )
                .unwrap();
        };
        seed("1", Some("k1"));
        let mut dup = incoming("s", "u", "hi");
        dup.dedupe_key = Some("k1".into());
        assert_eq!(
            eval(&cfg, &store, &dup, false),
            Verdict::Drop(DropReason::Duplicate)
        );
        seed("2", None);
        let fresh = incoming("s", "u", "hi");
        assert_eq!(
            eval(&cfg, &store, &fresh, false),
            Verdict::Drop(DropReason::RateLimited)
        );
        assert_eq!(
            eval(&cfg, &store, &incoming("s", "other", "hi"), false),
            Verdict::Accept { priority: 0 }
        );
    }

    #[test]
    fn default_config_treats_manual_and_ilink_as_requests() {
        let cfg = FilterConfig::default();
        let store = SuperAgentStore::open_in_memory();
        assert_eq!(
            eval(&cfg, &store, &incoming("manual", "me", "do x"), false),
            Verdict::Accept { priority: 1 }
        );
        assert_eq!(
            eval(&cfg, &store, &incoming("ilink", "me", "do x"), false),
            Verdict::Accept { priority: 1 }
        );
        assert_eq!(
            eval(&cfg, &store, &incoming("chat", "me", "do x"), false),
            Verdict::Accept { priority: 1 }
        );
        assert_eq!(
            eval(&cfg, &store, &incoming("webhook", "me", "do x"), false),
            Verdict::Accept { priority: 0 }
        );
    }
}
