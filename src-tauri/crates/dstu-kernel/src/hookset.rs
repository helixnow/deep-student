//! 多订阅者回调集。

use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use crate::Disposer;

struct Entry<T: ?Sized> {
    id: u64,
    hook: Arc<T>,
}

struct HookSetState<T: ?Sized> {
    next_id: u64,
    entries: Vec<Entry<T>>,
}

/// 多订阅者回调集：`static HOOKS: HookSet<dyn Trait> = HookSet::new();`。
///
/// - [`HookSet::register`] 返回 [`Disposer`]，drop 后按 id 精确移除对应条目。
/// - 遍历一律先 [`HookSet::snapshot`] 再回调：回调期间不持锁，回调里再注册/
///   注销也不会死锁；快照之后被移除的条目本轮仍会被调用（与旧实现
///   `RwLock<Vec<..>>` 先 clone 再遍历一致）。
/// - 锁中毒一律按 `unwrap_or_else(|p| p.into_inner())` 恢复，不 panic。
pub struct HookSet<T: ?Sized> {
    state: Mutex<HookSetState<T>>,
}

impl<T: ?Sized> HookSet<T> {
    /// 构造空集合（可用于 `static`）。
    pub const fn new() -> Self {
        Self {
            state: Mutex::new(HookSetState {
                next_id: 0,
                entries: Vec::new(),
            }),
        }
    }

    /// 当前条目数。
    pub fn len(&self) -> usize {
        self.lock_state().entries.len()
    }

    /// 是否没有条目。
    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// 按注册顺序克隆一份快照；后续调用不持锁。
    pub fn snapshot(&self) -> Vec<Arc<T>> {
        self.lock_state()
            .entries
            .iter()
            .map(|entry| Arc::clone(&entry.hook))
            .collect()
    }

    fn lock_state(&self) -> MutexGuard<'_, HookSetState<T>> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl<T: ?Sized + Send + Sync + 'static> HookSet<T> {
    /// 注册一个回调，返回撤销凭证。
    pub fn register(&'static self, hook: Arc<T>) -> Disposer {
        let id = self.insert(hook);
        Disposer::new(move || self.remove(id))
    }

    /// 插入条目并返回内部 id；不提供撤销凭证（供 [`Kernel`](crate::Kernel) 带使用）。
    pub(crate) fn insert(&self, hook: Arc<T>) -> u64 {
        let mut state = self.lock_state();
        state.next_id = state.next_id.wrapping_add(1);
        let id = state.next_id;
        state.entries.push(Entry { id, hook });
        id
    }

    /// 按内部 id 移除条目；不存在时为空操作（`Disposer` 至多执行一次）。
    pub(crate) fn remove(&self, id: u64) {
        let mut state = self.lock_state();
        state.entries.retain(|entry| entry.id != id);
    }
}

impl<T: ?Sized> Default for HookSet<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: ?Sized> fmt::Debug for HookSet<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("HookSet")
            .field("len", &self.len())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::HookSet;
    use std::sync::Arc;

    trait Probe: Send + Sync {
        fn name(&self) -> &'static str;

        /// 回调里再注册（若遍历持锁会死锁）。
        fn on_event(&self) {}
    }

    struct Named(&'static str);

    impl Probe for Named {
        fn name(&self) -> &'static str {
            self.0
        }
    }

    fn hookset() -> &'static HookSet<dyn Probe> {
        Box::leak(Box::new(HookSet::new()))
    }

    #[test]
    fn registers_in_order_and_removes_by_disposer() {
        let hooks = hookset();
        let a = hooks.register(Arc::new(Named("a")));
        let _b = hooks.register(Arc::new(Named("b")));
        let _c = hooks.register(Arc::new(Named("c")));

        let names: Vec<_> = hooks.snapshot().iter().map(|hook| hook.name()).collect();
        assert_eq!(names, vec!["a", "b", "c"]);

        drop(a);
        assert_eq!(hooks.len(), 2);
        let names: Vec<_> = hooks.snapshot().iter().map(|hook| hook.name()).collect();
        assert_eq!(names, vec!["b", "c"]);
    }

    #[test]
    fn snapshot_isolated_from_later_removals() {
        let hooks = hookset();
        let a = hooks.register(Arc::new(Named("a")));
        let b = hooks.register(Arc::new(Named("b")));

        let snapshot = hooks.snapshot();
        drop(a);
        drop(b);
        assert!(hooks.is_empty());

        // 快照里的条目本轮仍然全部调用（旧实现 clone 后遍历的语义）。
        let names: Vec<_> = snapshot.iter().map(|hook| hook.name()).collect();
        assert_eq!(names, vec!["a", "b"]);
    }

    #[test]
    fn callback_may_register_without_deadlock() {
        let hooks = hookset();

        struct Reentrant {
            hooks: &'static HookSet<dyn Probe>,
        }

        impl Probe for Reentrant {
            fn name(&self) -> &'static str {
                "reentrant"
            }

            fn on_event(&self) {
                let extra = self.hooks.register(Arc::new(Named("extra")));
                // 回调里注册的条目在进程内一直保留，忽略撤销凭证。
                std::mem::forget(extra);
            }
        }

        // 注册登记在进程内一直保留：忘掉 Disposer，否则这里立刻撤销。
        std::mem::forget(hooks.register(Arc::new(Reentrant { hooks })));

        // snapshot 之后不持锁：下面的回调可以安全地再次 register。
        for hook in hooks.snapshot() {
            hook.on_event();
        }
        assert_eq!(hooks.len(), 2);
    }

    #[test]
    fn poisoned_lock_recovers() {
        let hooks = hookset();
        let _ = std::thread::spawn(move || {
            let _guard = hooks.state.lock().unwrap();
            panic!("poison hookset");
        })
        .join();

        let _disposer = hooks.register(Arc::new(Named("after-poison")));
        assert_eq!(hooks.len(), 1);
        let names: Vec<_> = hooks.snapshot().iter().map(|hook| hook.name()).collect();
        assert_eq!(names, vec!["after-poison"]);
    }
}
