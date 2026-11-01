//! 插件、作用域与插件宿主。

use std::error::Error;
use std::fmt;
use std::sync::Arc;

use crate::Disposer;

/// 插件注入过程中收集的撤销凭证。
///
/// `Scope` 销毁时按**注册逆序**执行全部 `Disposer`：插件卸载、`PluginHost`
/// 回滚失败插件、或局部测试作用域离开作用域都走同一条路径。
pub struct Scope {
    disposers: Vec<Disposer>,
}

impl Scope {
    /// 构造空作用域。
    pub const fn new() -> Self {
        Self {
            disposers: Vec::new(),
        }
    }

    /// 收集一个撤销凭证（注册顺序即回滚的逆序）。
    pub fn add(&mut self, disposer: Disposer) {
        self.disposers.push(disposer);
    }

    /// 当前收集的凭证数。
    pub fn len(&self) -> usize {
        self.disposers.len()
    }

    /// 是否没有凭证。
    pub fn is_empty(&self) -> bool {
        self.disposers.is_empty()
    }
}

impl Default for Scope {
    fn default() -> Self {
        Self::new()
    }
}

impl fmt::Debug for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Scope")
            .field("len", &self.len())
            .finish_non_exhaustive()
    }
}

impl Drop for Scope {
    fn drop(&mut self) {
        // 逆序回滚：最后注册的最先撤销。
        while let Some(disposer) = self.disposers.pop() {
            disposer.dispose();
        }
    }
}

/// 插件：组合根中的一个显式、有序条目。
///
/// `apply` 在 [`Scope`] 上登记自己注入的全部撤销凭证；宿主只保存名字和 Scope，
/// 不关心插件内部注册了什么。
pub trait Plugin: Send + Sync + 'static {
    /// 插件名：`PluginHost` 用它做幂等（Once 语义）与卸载定位。
    fn name(&self) -> &'static str;

    /// 注入实现。返回 `Err` 时宿主丢弃本次 `Scope`，已完成的注册全部逆序回滚。
    fn apply(&self, scope: &mut Scope) -> Result<(), PluginError>;
}

/// 插件 apply 失败：始终携带插件名。
#[derive(Debug)]
pub struct PluginError {
    plugin: &'static str,
    message: String,
    source: Option<Box<dyn Error + Send + Sync>>,
}

impl PluginError {
    /// 由插件名与错误文本构造。
    pub fn new(plugin: &'static str, message: impl Into<String>) -> Self {
        Self {
            plugin,
            message: message.into(),
            source: None,
        }
    }

    /// 由插件名与底层错误构造（保留 `source` 链）。
    pub fn with_source(plugin: &'static str, source: impl Error + Send + Sync + 'static) -> Self {
        Self {
            plugin,
            message: source.to_string(),
            source: Some(Box::new(source)),
        }
    }

    /// 失败插件名。
    pub fn plugin(&self) -> &'static str {
        self.plugin
    }

    /// 错误文本。
    pub fn message(&self) -> &str {
        &self.message
    }

    /// 覆盖插件名：由 [`PluginHost`] 保证错误归属到实际 apply 的插件。
    fn reparent(mut self, plugin: &'static str) -> Self {
        self.plugin = plugin;
        self
    }
}

impl fmt::Display for PluginError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "plugin `{}` failed: {}", self.plugin, self.message)
    }
}

impl Error for PluginError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        self.source
            .as_deref()
            .map(|source| source as &(dyn Error + 'static))
    }
}

#[derive(Debug)]
struct AppliedPlugin {
    name: &'static str,
    /// 只通过 drop 生效（逆序回滚），不直接读取。
    #[allow(dead_code)]
    scope: Scope,
}

/// 插件宿主：按显式有序列表 apply，按名字幂等、按名字卸载。
///
/// - [`PluginHost::apply`] 对同名插件只生效一次（`Ok(false)` 表示跳过）。
/// - apply 失败时失败插件的 `Scope` 整个 drop 回滚，错误带插件名；本次调用中
///   先前已成功的插件保留（宿主状态一致，后续调用可重试失败插件）。
/// - 卸载 = 从列表移除并 drop 其 `Scope`（逆序回滚）。
///
/// 进程生命周期内插件不卸载；全局宿主由组合根持有。局部宿主用于测试。
#[derive(Debug, Default)]
pub struct PluginHost {
    applied: Vec<AppliedPlugin>,
}

impl PluginHost {
    /// 构造空宿主。
    pub const fn new() -> Self {
        Self {
            applied: Vec::new(),
        }
    }

    /// 已 apply 的插件数。
    pub fn len(&self) -> usize {
        self.applied.len()
    }

    /// 是否没有插件。
    pub fn is_empty(&self) -> bool {
        self.applied.is_empty()
    }

    /// 插件是否已 apply。
    pub fn contains(&self, name: &str) -> bool {
        self.applied.iter().any(|plugin| plugin.name == name)
    }

    /// 已 apply 的插件名（apply 顺序）。
    pub fn applied_names(&self) -> impl Iterator<Item = &'static str> + '_ {
        self.applied.iter().map(|plugin| plugin.name)
    }

    /// apply 单个插件；已存在同名插件时跳过并返回 `Ok(false)`。
    pub fn apply(&mut self, plugin: &dyn Plugin) -> Result<bool, PluginError> {
        let name = plugin.name();
        if self.contains(name) {
            return Ok(false);
        }

        let mut scope = Scope::new();
        match plugin.apply(&mut scope) {
            Ok(()) => {
                self.applied.push(AppliedPlugin { name, scope });
                Ok(true)
            }
            Err(error) => {
                // scope 在返回前 drop：失败插件的注册按逆序全部回滚。
                Err(error.reparent(name))
            }
        }
    }

    /// 按给定顺序 apply 一组插件；返回本次新 apply 的数量。
    ///
    /// 任一插件失败即停止（该插件已回滚），之前的插件保留在宿主中。
    pub fn apply_all(
        &mut self,
        plugins: impl IntoIterator<Item = Arc<dyn Plugin>>,
    ) -> Result<usize, PluginError> {
        let mut applied = 0;
        for plugin in plugins {
            if self.apply(plugin.as_ref())? {
                applied += 1;
            }
        }
        Ok(applied)
    }

    /// 按名字卸载插件，逆序回滚其全部注册；返回是否找到并卸载。
    pub fn unload(&mut self, name: &str) -> bool {
        match self.applied.iter().position(|plugin| plugin.name == name) {
            Some(index) => {
                // remove 返回的 AppliedPlugin 在此 drop，Scope 逆序回滚。
                self.applied.remove(index);
                true
            }
            None => false,
        }
    }

    /// 逆序卸载全部插件（每个插件的 Scope 内部仍是注册逆序）。
    pub fn unload_all(&mut self) {
        while let Some(plugin) = self.applied.pop() {
            drop(plugin);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{Disposer, Plugin, PluginError, PluginHost, Scope};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};

    /// 在 apply 中登记若干资源；撤销时把 "undo ..." 写回日志。
    struct TrackingPlugin {
        name: &'static str,
        steps: &'static [&'static str],
        fail: bool,
        log: Arc<Mutex<Vec<String>>>,
    }

    impl TrackingPlugin {
        fn new(
            name: &'static str,
            steps: &'static [&'static str],
            fail: bool,
            log: &Arc<Mutex<Vec<String>>>,
        ) -> Arc<dyn Plugin> {
            Arc::new(Self {
                name,
                steps,
                fail,
                log: Arc::clone(log),
            })
        }
    }

    impl Plugin for TrackingPlugin {
        fn name(&self) -> &'static str {
            self.name
        }

        fn apply(&self, scope: &mut Scope) -> Result<(), PluginError> {
            for step in self.steps {
                let log = Arc::clone(&self.log);
                let apply_entry = format!("apply {}:{}", self.name, step);
                let undo_entry = format!("undo {}:{}", self.name, step);
                scope.add(Disposer::new(move || {
                    log.lock().unwrap().push(undo_entry);
                }));
                self.log.lock().unwrap().push(apply_entry);
            }
            if self.fail {
                return Err(PluginError::new("mislabeled", "boom"));
            }
            Ok(())
        }
    }

    fn log() -> Arc<Mutex<Vec<String>>> {
        Arc::new(Mutex::new(Vec::new()))
    }

    #[test]
    fn apply_is_idempotent_by_name() {
        let log = log();
        let mut host = PluginHost::new();
        let plugin = TrackingPlugin::new("p", &["a"], false, &log);

        assert!(host.apply(plugin.as_ref()).expect("first apply"));
        assert!(
            !host.apply(plugin.as_ref()).expect("second apply"),
            "同名插件只生效一次"
        );
        assert_eq!(host.len(), 1);
        assert_eq!(host.applied_names().collect::<Vec<_>>(), vec!["p"]);
        assert_eq!(*log.lock().unwrap(), vec!["apply p:a"]);
    }

    #[test]
    fn failed_apply_rolls_back_in_reverse_order_and_carries_plugin_name() {
        let log = log();
        let mut host = PluginHost::new();
        let plugin = TrackingPlugin::new("failing", &["a", "b"], true, &log);

        let error = host.apply(plugin.as_ref()).expect_err("apply must fail");
        assert_eq!(error.plugin(), "failing", "错误归属到实际插件");
        assert_eq!(error.to_string(), "plugin `failing` failed: boom");
        assert!(!host.contains("failing"));
        assert!(host.is_empty());

        assert_eq!(
            *log.lock().unwrap(),
            vec![
                "apply failing:a",
                "apply failing:b",
                "undo failing:b",
                "undo failing:a",
            ],
            "失败插件的 Scope 按注册逆序整体回滚"
        );
    }

    #[test]
    fn unload_rolls_back_in_reverse_order() {
        let log = log();
        let mut host = PluginHost::new();
        let plugin = TrackingPlugin::new("p", &["a", "b", "c"], false, &log);
        assert!(host.apply(plugin.as_ref()).expect("apply"));
        log.lock().unwrap().clear();

        assert!(host.unload("p"));
        assert!(!host.unload("p"), "重复卸载返回 false");
        assert_eq!(
            *log.lock().unwrap(),
            vec!["undo p:c", "undo p:b", "undo p:a"]
        );
    }

    #[test]
    fn apply_all_keeps_explicit_order_and_stops_at_failure() {
        let log = log();
        let mut host = PluginHost::new();
        let first = TrackingPlugin::new("first", &["a"], false, &log);
        let failing = TrackingPlugin::new("failing", &["b"], true, &log);
        let last = TrackingPlugin::new("last", &["c"], false, &log);

        let error = host
            .apply_all(vec![first, failing, last])
            .expect_err("batch must fail");
        assert_eq!(error.plugin(), "failing");

        assert!(host.contains("first"));
        assert!(!host.contains("failing"));
        assert!(!host.contains("last"));
        assert_eq!(
            *log.lock().unwrap(),
            vec!["apply first:a", "apply failing:b", "undo failing:b",],
            "失败插件回滚，之前的插件保留，之后的插件不再 apply"
        );
    }

    #[test]
    fn duplicate_names_in_one_batch_apply_once() {
        let calls = Arc::new(AtomicUsize::new(0));

        struct Counting {
            calls: Arc<AtomicUsize>,
        }

        impl Plugin for Counting {
            fn name(&self) -> &'static str {
                "counting"
            }

            fn apply(&self, _scope: &mut Scope) -> Result<(), PluginError> {
                self.calls.fetch_add(1, Ordering::SeqCst);
                Ok(())
            }
        }

        let mut host = PluginHost::new();
        let applied = host
            .apply_all(vec![
                Arc::new(Counting {
                    calls: Arc::clone(&calls),
                }) as Arc<dyn Plugin>,
                Arc::new(Counting {
                    calls: Arc::clone(&calls),
                }),
            ])
            .expect("apply all");
        assert_eq!(applied, 1);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(host.len(), 1);
    }

    #[test]
    fn unload_all_uses_host_order_and_rolls_back_each_scope() {
        let log = log();
        let mut host = PluginHost::new();
        host.apply(TrackingPlugin::new("first", &["a"], false, &log).as_ref())
            .expect("apply first");
        host.apply(TrackingPlugin::new("second", &["b"], false, &log).as_ref())
            .expect("apply second");
        log.lock().unwrap().clear();

        host.unload_all();
        assert!(host.is_empty());
        assert_eq!(*log.lock().unwrap(), vec!["undo second:b", "undo first:a"]);
    }
}
