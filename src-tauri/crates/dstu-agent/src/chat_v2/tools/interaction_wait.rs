//! 通用「挂起等待用户交互」注册表
//!
//! 工具执行器在等待前端用户操作（作答、确认等）时，把一个 oneshot Sender
//! 连同元数据登记到 [`PendingWaits`]，拿回 [`PendingWaitGuard`] 与 Receiver：
//!
//! - 前端经 Tauri 命令调用 [`PendingWaits::resolve_with`]：在锁内用元数据校验
//!   载荷，校验通过才移除条目并把结果送给等待方（只消费一次）；
//! - 等待方 future 被 drop（停止生成 / 注册表取消 / 看门狗）时，Guard 的
//!   `Drop` 移除自己那一条，不会像 `PENDING_ASK_CALLBACKS` 那样留下残留；
//! - 一键断电经 [`PendingWaits::drain_all`] drop 全部 Sender，等待方立刻收到
//!   `RecvError`。
//!
//! 条目带单调递增的登记序号：同一 key 被重新登记后，旧 Guard 的 drop 不会误删
//! 新条目。
//!
//! 锁中毒恢复口径同 `ask_user_executor.rs` 的 `PENDING_ASK_CALLBACKS`。
//! 锁只在同步代码里短暂持有，绝不跨 `.await`。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, MutexGuard};

use tokio::sync::oneshot;

/// 复合 key 分隔符（ASCII Unit Separator，不会出现在 session_id / tool_call_id 中）。
pub const WAIT_KEY_SEPARATOR: char = '\u{1f}';

/// 构造会话隔离的等待 key：`"{session_id}\u{1f}{tool_call_id}"`。
///
/// 会话不匹配时 key 不同，查找自然落空（调用方视为 Expired）。
pub fn wait_key(session_id: &str, tool_call_id: &str) -> String {
    format!("{session_id}{WAIT_KEY_SEPARATOR}{tool_call_id}")
}

/// 某会话全部等待 key 的公共前缀：`"{session_id}\u{1f}"`。
pub fn wait_key_session_prefix(session_id: &str) -> String {
    format!("{session_id}{WAIT_KEY_SEPARATOR}")
}

struct WaitEntry<T, M> {
    id: u64,
    sender: oneshot::Sender<T>,
    meta: M,
}

/// [`PendingWaits::resolve_with`] 的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResolveOutcome<E> {
    /// 校验通过，条目已移除，结果已送达等待方。
    Resolved,
    /// 没有对应条目（已作答 / 已取消 / 等待方已离开 / 会话不匹配）。
    Missing,
    /// 校验失败；条目保留，等待不受影响。
    Rejected(E),
}

/// 挂起等待注册表：`key -> (Sender<T>, M)`。
///
/// 一般放在 `static X: LazyLock<PendingWaits<T, M>>` 里使用。
pub struct PendingWaits<T, M> {
    label: &'static str,
    next_id: AtomicU64,
    entries: Mutex<HashMap<String, WaitEntry<T, M>>>,
}

impl<T, M> PendingWaits<T, M> {
    /// `label` 仅用于日志。
    pub fn new(label: &'static str) -> Self {
        Self {
            label,
            next_id: AtomicU64::new(1),
            entries: Mutex::new(HashMap::new()),
        }
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, WaitEntry<T, M>>> {
        self.entries.lock().unwrap_or_else(|poisoned| {
            log::error!(
                "[InteractionWait:{}] pending map mutex poisoned! Attempting recovery",
                self.label
            );
            poisoned.into_inner()
        })
    }

    /// 登记一个等待。返回的 Guard 必须与 Receiver 一起持有到等待结束；
    /// Guard drop 时移除本条目（若仍是自己登记的那一条）。
    ///
    /// 同 key 已有条目时覆盖之：旧 Sender 被 drop，旧等待方收到 `RecvError`。
    pub fn register(
        &self,
        key: impl Into<String>,
        meta: M,
    ) -> (PendingWaitGuard<'_, T, M>, oneshot::Receiver<T>) {
        let key = key.into();
        let (sender, receiver) = oneshot::channel();
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let replaced = {
            let mut entries = self.lock();
            entries.insert(key.clone(), WaitEntry { id, sender, meta })
        };
        if replaced.is_some() {
            log::warn!(
                "[InteractionWait:{}] key re-registered, previous waiter cancelled",
                self.label
            );
        }
        drop(replaced);
        (
            PendingWaitGuard {
                waits: self,
                key,
                id,
            },
            receiver,
        )
    }

    /// 在锁内用条目元数据校验/构造结果：`Ok(value)` → 移除条目并送达；
    /// `Err(e)` → 条目保留，返回 `Rejected(e)`。
    ///
    /// `f` 在锁内执行，不得再访问同一注册表（会死锁）。
    pub fn resolve_with<E, F>(&self, key: &str, f: F) -> ResolveOutcome<E>
    where
        F: FnOnce(&M) -> Result<T, E>,
    {
        let mut entries = self.lock();
        let Some(entry) = entries.get(key) else {
            return ResolveOutcome::Missing;
        };
        if entry.sender.is_closed() {
            // 等待方已离开（future 被 drop 但 Guard 尚未析构的窄窗口）
            entries.remove(key);
            return ResolveOutcome::Missing;
        }
        let value = match f(&entry.meta) {
            Ok(value) => value,
            Err(error) => return ResolveOutcome::Rejected(error),
        };
        let Some(entry) = entries.remove(key) else {
            return ResolveOutcome::Missing;
        };
        drop(entries);
        match entry.sender.send(value) {
            Ok(()) => ResolveOutcome::Resolved,
            Err(_) => ResolveOutcome::Missing,
        }
    }

    /// 是否存在该 key 的条目。
    pub fn contains(&self, key: &str) -> bool {
        self.lock().contains_key(key)
    }

    /// 以 `prefix` 开头的全部 key（排序后返回，便于测试与前端稳定展示）。
    pub fn keys_with_prefix(&self, prefix: &str) -> Vec<String> {
        let mut keys: Vec<String> = self
            .lock()
            .iter()
            .filter(|(key, entry)| key.starts_with(prefix) && !entry.sender.is_closed())
            .map(|(key, _)| key.clone())
            .collect();
        keys.sort();
        keys
    }

    /// 移除全部条目并 drop 其 Sender（等待方立即收到 `RecvError`）；返回移除数量。
    pub fn drain_all(&self) -> usize {
        let drained: Vec<WaitEntry<T, M>> = {
            let mut entries = self.lock();
            entries.drain().map(|(_, entry)| entry).collect()
        };
        let count = drained.len();
        // 在锁外 drop Sender
        drop(drained);
        count
    }

    /// 当前条目数（含等待方已离开但尚未清理的条目）。
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    fn remove_if_owned(&self, key: &str, id: u64) {
        let removed = {
            let mut entries = self.lock();
            if entries.get(key).is_some_and(|entry| entry.id == id) {
                entries.remove(key)
            } else {
                None
            }
        };
        drop(removed);
    }
}

/// 等待条目的 RAII 守卫：drop 时移除自己登记的条目（已被消费/覆盖则无操作）。
#[must_use = "dropping the guard immediately removes the pending wait"]
pub struct PendingWaitGuard<'a, T, M> {
    waits: &'a PendingWaits<T, M>,
    key: String,
    id: u64,
}

impl<T, M> PendingWaitGuard<'_, T, M> {
    pub fn key(&self) -> &str {
        &self.key
    }
}

impl<T, M> Drop for PendingWaitGuard<'_, T, M> {
    fn drop(&mut self) {
        self.waits.remove_if_owned(&self.key, self.id);
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn waits() -> PendingWaits<u32, &'static str> {
        PendingWaits::new("test")
    }

    #[test]
    fn wait_key_is_session_scoped() {
        assert_eq!(wait_key("sess_a", "call_1"), "sess_a\u{1f}call_1");
        assert!(wait_key("sess_a", "call_1").starts_with(&wait_key_session_prefix("sess_a")));
        assert!(!wait_key("sess_ab", "call_1").starts_with(&wait_key_session_prefix("sess_a")));
    }

    #[test]
    fn resolve_sends_once_and_removes_entry() {
        let waits = waits();
        let (_guard, mut rx) = waits.register("k", "meta");
        let outcome = waits.resolve_with::<String, _>("k", |meta| {
            assert_eq!(*meta, "meta");
            Ok(7)
        });
        assert_eq!(outcome, ResolveOutcome::Resolved);
        assert_eq!(rx.try_recv().ok(), Some(7));
        assert!(!waits.contains("k"));
        // 第二次：已消费
        assert_eq!(
            waits.resolve_with::<String, _>("k", |_| Ok(8)),
            ResolveOutcome::Missing
        );
    }

    #[test]
    fn rejected_keeps_entry() {
        let waits = waits();
        let (_guard, mut rx) = waits.register("k", "meta");
        assert_eq!(
            waits.resolve_with("k", |_| Err::<u32, _>("bad")),
            ResolveOutcome::Rejected("bad")
        );
        assert!(waits.contains("k"));
        assert!(rx.try_recv().is_err());
        assert_eq!(
            waits.resolve_with::<String, _>("k", |_| Ok(1)),
            ResolveOutcome::Resolved
        );
        assert_eq!(rx.try_recv().ok(), Some(1));
    }

    #[test]
    fn guard_drop_removes_entry() {
        let waits = waits();
        let (guard, _rx) = waits.register("k", "meta");
        assert!(waits.contains("k"));
        drop(guard);
        assert!(!waits.contains("k"));
        assert!(waits.is_empty());
    }

    #[test]
    fn stale_guard_does_not_remove_reregistered_entry() {
        let waits = waits();
        let (old_guard, mut old_rx) = waits.register("k", "old");
        let (_new_guard, _new_rx) = waits.register("k", "new");
        // 旧等待方被取消
        assert!(old_rx.try_recv().is_err());
        drop(old_guard);
        assert!(waits.contains("k"));
        assert_eq!(
            waits.resolve_with::<String, _>("k", |meta| {
                assert_eq!(*meta, "new");
                Ok(1)
            }),
            ResolveOutcome::Resolved
        );
    }

    #[test]
    fn closed_receiver_counts_as_missing() {
        let waits = waits();
        let (_guard, rx) = waits.register("k", "meta");
        drop(rx);
        assert_eq!(
            waits.resolve_with::<String, _>("k", |_| Ok(1)),
            ResolveOutcome::Missing
        );
        assert!(!waits.contains("k"));
    }

    #[test]
    fn keys_with_prefix_filters_and_sorts() {
        let waits = waits();
        let (_g1, _r1) = waits.register(wait_key("sess_a", "c2"), "m");
        let (_g2, _r2) = waits.register(wait_key("sess_a", "c1"), "m");
        let (_g3, _r3) = waits.register(wait_key("sess_b", "c3"), "m");
        assert_eq!(
            waits.keys_with_prefix(&wait_key_session_prefix("sess_a")),
            vec![wait_key("sess_a", "c1"), wait_key("sess_a", "c2")]
        );
    }

    #[test]
    fn drain_all_cancels_every_waiter() {
        let waits = waits();
        let (_g1, mut r1) = waits.register("a", "m");
        let (_g2, mut r2) = waits.register("b", "m");
        assert_eq!(waits.drain_all(), 2);
        assert!(waits.is_empty());
        assert!(matches!(
            r1.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert!(matches!(
            r2.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        assert_eq!(waits.drain_all(), 0);
    }
}
