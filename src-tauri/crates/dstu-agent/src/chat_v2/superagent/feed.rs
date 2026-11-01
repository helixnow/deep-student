//! Super-agent 模式页的统一时间线：把“用户输入 / Router 回复 / Worker 进展 / 系统提示”
//! 合并成一条按时间排序的流。用户感知的是**同一个 Agent 在持续对话**，
//! 而不是若干个互不相通的会话——会话（Session）只是底层实现细节。

use serde::Serialize;

use super::store::SuperAgentStore;
use super::types::SOURCE_INTERNAL;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FeedKind {
    /// 用户（或外部渠道）发来的内容
    User,
    /// Router 对用户的回复
    Reply,
    /// Worker 的进展/结果/失败（折叠展示）
    Worker,
    /// Watchdog、派发被拒等系统提示
    System,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FeedItem {
    pub id: String,
    pub kind: FeedKind,
    pub thread_key: String,
    pub text: String,
    pub created_ms: i64,
    /// 事件来源（user 项有意义：chat / ilink / …）
    pub source: String,
}

pub fn build_feed(store: &SuperAgentStore, limit: usize) -> Result<Vec<FeedItem>, String> {
    let mut items: Vec<FeedItem> = Vec::new();
    for t in store.feed_triggers(limit)? {
        let kind = if t.source == SOURCE_INTERNAL {
            if t.kind.starts_with("worker.") {
                FeedKind::Worker
            } else {
                FeedKind::System
            }
        } else {
            FeedKind::User
        };
        items.push(FeedItem {
            id: t.id,
            kind,
            thread_key: t.thread_key,
            text: t.body,
            created_ms: t.created_ms,
            source: t.source,
        });
    }
    for r in store.list_replies(limit)? {
        items.push(FeedItem {
            id: r.id,
            kind: FeedKind::Reply,
            thread_key: r.thread_key,
            text: r.text,
            created_ms: r.created_ms,
            source: "router".to_string(),
        });
    }
    items.sort_by(|a, b| {
        a.created_ms
            .cmp(&b.created_ms)
            .then_with(|| a.id.cmp(&b.id))
    });
    let overflow = items.len().saturating_sub(limit);
    Ok(items.split_off(overflow))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat_v2::superagent::types::{Reply, Trigger};

    fn trig(id: &str, source: &str, kind: &str, ts: i64) -> Trigger {
        Trigger {
            id: id.into(),
            source: source.into(),
            thread_key: "t".into(),
            sender: "s".into(),
            kind: kind.into(),
            body: format!("body-{id}"),
            dedupe_key: None,
            created_ms: ts,
            priority: 0,
        }
    }

    #[test]
    fn merges_users_replies_and_worker_events_in_time_order() {
        let store = SuperAgentStore::open_in_memory();
        store
            .insert_trigger(&trig("a", "chat", "message", 10), &[])
            .unwrap();
        store
            .insert_trigger(&trig("b", "internal", "worker.report", 30), &[])
            .unwrap();
        store
            .insert_trigger(&trig("c", "internal", "watchdog.worker_stalled", 40), &[])
            .unwrap();
        store
            .add_reply(&Reply {
                id: "r1".into(),
                thread_key: "t".into(),
                text: "好的".into(),
                created_ms: 20,
            })
            .unwrap();
        let feed = build_feed(&store, 50).unwrap();
        let kinds: Vec<_> = feed.iter().map(|i| i.kind).collect();
        assert_eq!(
            kinds,
            [
                FeedKind::User,
                FeedKind::Reply,
                FeedKind::Worker,
                FeedKind::System
            ]
        );
    }

    #[test]
    fn limit_keeps_the_most_recent_items() {
        let store = SuperAgentStore::open_in_memory();
        for i in 0..10 {
            store
                .insert_trigger(&trig(&format!("t{i}"), "chat", "message", i), &[])
                .unwrap();
        }
        let feed = build_feed(&store, 3).unwrap();
        assert_eq!(
            feed.iter().map(|i| i.id.as_str()).collect::<Vec<_>>(),
            ["t7", "t8", "t9"]
        );
    }
}
