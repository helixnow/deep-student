//! dstu-sync 对上层能力的回调注册点。
//!
//! 拆分后 dstu-sync 是 domain crate，不能依赖 app 的 memory。同步引擎的字段级合并
//! （`data_governance::sync::field_merge` 的 `LearnerProfileData` 策略）在拆分前直接
//! 调用 `memory::learner_profile::merge_profile_json_for_sync`；现在 field_merge 的
//! 调用点保持原路径不变（`crate::memory::learner_profile` 是本 crate 的私有路径垫片），
//! 垫片转发到这里的 [`SyncFieldMerger`] 槽位，由 app 的
//! `extensions::register_extensions()` 注册 memory 的实现。全部注册时的可观察行为与
//! 拆分前一致；未注册时等价于“任一侧不是画像”（回退 row-level LWW/conflict）。
//!
//! 注册机制走 `dstu-kernel` 的 [`Slot`]（单提供方）：槽位被占用时保持“先注册者生效”
//! （返回 `Err(SlotOccupied)`），返回的 [`Disposer`] 由 `extensions.rs` 的插件 `Scope` 持有。

use std::sync::Arc;

use dstu_kernel::{Disposer, Slot, SlotOccupied};

/// `resources.data` 学习者画像 JSON 的结构化同步合并。
pub trait SyncFieldMerger: Send + Sync {
    /// 与 `memory::learner_profile::merge_profile_json_for_sync` 契约一致：纯函数、对称；
    /// 任一侧不是画像 JSON 时返回 `None`。
    fn merge_profile_json_for_sync(&self, local_json: &str, remote_json: &str) -> Option<String>;
}

static SYNC_FIELD_MERGER: Slot<dyn SyncFieldMerger> = Slot::new();

/// 注册学习者画像同步合并实现；槽位已占用时返回 `Err(SlotOccupied)`（先注册者生效）。
pub fn register_sync_field_merger(
    merger: Arc<dyn SyncFieldMerger>,
) -> Result<Disposer, SlotOccupied> {
    SYNC_FIELD_MERGER.provide(merger)
}

/// 调用已注册的学习者画像合并；未注册时返回 `None`（调用方回退 row-level LWW/conflict）。
pub fn merge_profile_json_for_sync(local_json: &str, remote_json: &str) -> Option<String> {
    SYNC_FIELD_MERGER
        .get()
        .and_then(|merger| merger.merge_profile_json_for_sync(local_json, remote_json))
}
