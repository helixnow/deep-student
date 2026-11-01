//! 可回滚的注册凭证。

use std::fmt;

/// 一次注册的撤销凭证：`drop` 时执行撤销动作，至多一次。
///
/// [`Scope`](crate::Scope) 持有插件注入产生的全部 `Disposer`；插件卸载、
/// `Scope` 销毁或 `PluginHost` 回滚失败插件时，按注册的**逆序**执行。
/// 显式 `drop` 与调用 [`Disposer::dispose`] 等价。
///
/// 立即丢弃一个刚落地的 `Disposer` 会立刻撤销注册，因此标注了 `must_use`。
#[must_use = "dropping the Disposer undoes the registration"]
pub struct Disposer {
    action: Option<Box<dyn FnOnce() + Send + Sync>>,
}

impl Disposer {
    /// 由撤销闭包构造。闭包至多执行一次，且必须线程安全。
    pub fn new<F>(action: F) -> Self
    where
        F: FnOnce() + Send + Sync + 'static,
    {
        Self {
            action: Some(Box::new(action)),
        }
    }

    /// 立即执行撤销动作；之后的 `Drop` 不会重复执行。
    pub fn dispose(mut self) {
        self.run();
    }

    /// 撤销动作是否尚未执行。
    pub fn is_active(&self) -> bool {
        self.action.is_some()
    }

    fn run(&mut self) {
        if let Some(action) = self.action.take() {
            action();
        }
    }
}

impl Drop for Disposer {
    fn drop(&mut self) {
        self.run();
    }
}

impl fmt::Debug for Disposer {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Disposer")
            .field("active", &self.is_active())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::Disposer;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    #[test]
    fn drop_runs_once() {
        let runs = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&runs);
        let disposer = Disposer::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        assert!(disposer.is_active());
        drop(disposer);
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn explicit_dispose_does_not_run_twice() {
        let runs = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&runs);
        let disposer = Disposer::new(move || {
            counter.fetch_add(1, Ordering::SeqCst);
        });
        disposer.dispose();
        assert_eq!(runs.load(Ordering::SeqCst), 1);
    }
}
