//! 优先级分带：不可移除的 Kernel 带 + 按注册顺序执行的 Default 带。

use std::fmt;
use std::sync::Arc;

use crate::{Disposer, HookSet};

/// gate 语义的单步裁决：继续放行，或以给定载荷短路。
///
/// 与 Chat V2 的 `ToolGateOutcome::{Proceed, Block}` 同构；内核只提供机制，
/// 不携带业务类型。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision<R> {
    /// 继续交给下一个钩子。
    Continue,
    /// 立即短路；后续钩子（含 Default 带）不再执行。
    Block(R),
}

/// 带优先级分带的钩子集合：`static HOOKS: Kernel<dyn Trait> = Kernel::new();`。
///
/// - **Kernel 带**：安全关键钩子（审批准入、Kill Switch 等），进程生命周期内
///   不可移除，**始终先于** Default 带执行；用 [`Kernel::add_kernel`] 注册。
/// - **Default 带**：其余插件钩子，按注册顺序执行；注册返回 [`Disposer`]，
///   drop 后移除（插件回滚/卸载）。
///
/// 三种调用语义（都先取两个带的快照，再按 Kernel -> Default 顺序回调，不持锁）：
/// - [`Kernel::observe`]：全部调用，不返回结果、不能失败；
/// - [`Kernel::gate`]：按顺序调用，遇到第一个 [`GateDecision::Block`] 立即短路；
/// - [`Kernel::waterfall`]：按顺序把可变上下文传给每个钩子，返回最终上下文。
pub struct Kernel<T: ?Sized> {
    kernel: HookSet<T>,
    default: HookSet<T>,
}

impl<T: ?Sized> Kernel<T> {
    /// 构造空内核（可用于 `static`）。
    pub const fn new() -> Self {
        Self {
            kernel: HookSet::new(),
            default: HookSet::new(),
        }
    }

    /// Kernel 带条目数。
    pub fn kernel_len(&self) -> usize {
        self.kernel.len()
    }

    /// Default 带条目数。
    pub fn default_len(&self) -> usize {
        self.default.len()
    }

    /// 按 Kernel -> Default 顺序克隆快照。
    fn snapshot(&self) -> Vec<Arc<T>> {
        let mut hooks = self.kernel.snapshot();
        hooks.extend(self.default.snapshot());
        hooks
    }
}

impl<T: ?Sized + Send + Sync + 'static> Kernel<T> {
    /// 注册 Kernel 带钩子。语义上不可移除（不返回 [`Disposer`]），只应在
    /// 组合根里注册审批、Kill Switch 这类安全关键钩子。
    pub fn add_kernel(&self, hook: Arc<T>) {
        self.kernel.insert(hook);
    }

    /// 注册 Default 带钩子；drop 返回的 [`Disposer`] 即移除。
    pub fn add_default(&'static self, hook: Arc<T>) -> Disposer {
        self.default.register(hook)
    }

    /// observe：全部调用，不能失败。
    pub fn observe(&self, mut visit: impl FnMut(&T)) {
        for hook in self.snapshot() {
            visit(hook.as_ref());
        }
    }

    /// gate：按顺序调用，第一个 Block 短路并返回其载荷；全部 Continue 返回 `None`。
    pub fn gate<R>(&self, mut check: impl FnMut(&T) -> GateDecision<R>) -> Option<R> {
        for hook in self.snapshot() {
            if let GateDecision::Block(blocked) = check(hook.as_ref()) {
                return Some(blocked);
            }
        }
        None
    }

    /// waterfall：按顺序传递可变上下文，返回最终上下文。
    pub fn waterfall<C>(&self, mut context: C, mut visit: impl FnMut(&T, &mut C)) -> C {
        for hook in self.snapshot() {
            visit(hook.as_ref(), &mut context);
        }
        context
    }
}

impl<T: ?Sized> Default for Kernel<T> {
    fn default() -> Self {
        Self::new()
    }
}

impl<T: ?Sized> fmt::Debug for Kernel<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Kernel")
            .field("kernel_len", &self.kernel_len())
            .field("default_len", &self.default_len())
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use super::{GateDecision, Kernel};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    /// 模拟 PipelineHook 的最小形状：只在内核单测里使用，不改真实 hooks。
    trait Probe: Send + Sync {
        fn name(&self) -> &'static str;
    }

    struct Named(&'static str);

    impl Probe for Named {
        fn name(&self) -> &'static str {
            self.0
        }
    }

    fn kernel() -> &'static Kernel<dyn Probe> {
        Box::leak(Box::new(Kernel::new()))
    }

    #[test]
    fn kernel_band_always_runs_before_default_band() {
        let kernel = kernel();
        let _default_a = kernel.add_default(Arc::new(Named("default_a")));
        kernel.add_kernel(Arc::new(Named("kernel")));
        let _default_b = kernel.add_default(Arc::new(Named("default_b")));

        let mut seen = Vec::new();
        kernel.observe(|hook| seen.push(hook.name()));
        assert_eq!(seen, vec!["kernel", "default_a", "default_b"]);
    }

    #[test]
    fn default_band_follows_registration_order_and_is_removable() {
        let kernel = kernel();
        let first = kernel.add_default(Arc::new(Named("first")));
        let _second = kernel.add_default(Arc::new(Named("second")));
        assert_eq!(kernel.default_len(), 2);

        drop(first);
        let mut seen = Vec::new();
        kernel.observe(|hook| seen.push(hook.name()));
        assert_eq!(seen, vec!["second"]);
    }

    /// 场景：`ApprovalGateHook` 在 Kernel 带、`TaskAuditHook` 在 Default 带。
    #[test]
    fn gate_stops_at_first_block_and_skips_later_bands() {
        struct ApprovalGate;
        impl Probe for ApprovalGate {
            fn name(&self) -> &'static str {
                "approval_gate"
            }
        }
        struct TaskAudit;
        impl Probe for TaskAudit {
            fn name(&self) -> &'static str {
                "task_audit"
            }
        }

        let kernel = kernel();
        kernel.add_kernel(Arc::new(ApprovalGate));
        let _audit = kernel.add_default(Arc::new(TaskAudit));

        let mut ran = Vec::new();
        let blocked = kernel.gate(|hook| {
            ran.push(hook.name());
            if hook.name() == "approval_gate" {
                GateDecision::Block("blocked by kill switch")
            } else {
                GateDecision::Continue
            }
        });
        assert_eq!(blocked, Some("blocked by kill switch"));
        assert_eq!(ran, vec!["approval_gate"], "Block 后 Default 带不执行");

        ran.clear();
        let blocked = kernel.gate(|hook| {
            ran.push(hook.name());
            GateDecision::<&'static str>::Continue
        });
        assert_eq!(blocked, None);
        assert_eq!(
            ran,
            vec!["approval_gate", "task_audit"],
            "Kernel 带先于 Default 带，且全放行时两者都执行"
        );
    }

    #[test]
    fn waterfall_threads_context_in_band_order() {
        let kernel = kernel();
        let _default = kernel.add_default(Arc::new(Named("default")));
        kernel.add_kernel(Arc::new(Named("kernel")));

        let calls = AtomicUsize::new(0);
        let context = kernel.waterfall(Vec::new(), |hook, seen: &mut Vec<&'static str>| {
            calls.fetch_add(1, Ordering::SeqCst);
            seen.push(hook.name());
        });
        assert_eq!(context, vec!["kernel", "default"]);
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn gate_returns_none_when_empty() {
        let kernel: &'static Kernel<dyn Probe> = Box::leak(Box::new(Kernel::new()));
        assert_eq!(kernel.gate(|_| GateDecision::<()>::Continue), None);
    }
}
