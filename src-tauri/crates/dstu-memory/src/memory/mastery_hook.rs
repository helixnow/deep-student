//! memory 对 mastery 画像回流扩展点的接入（`mastery::profile_sink`）。
//!
//! mastery 已下沉到 dstu-learning，不能再直接调用 `learner_profile`；这里把
//! `learner_profile::{upsert,remove}_weak_point_from_mastery` 原样包装成
//! [`MasteryProfileSink`]，由 `extensions::register_extensions()` 在启动时注册。

use std::sync::Arc;

use crate::mastery::profile_sink::{MasteryProfileSink, MasteryWeakPointEvidence};
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;

use super::learner_profile;

pub struct LearnerProfileMasterySink;

impl MasteryProfileSink for LearnerProfileMasterySink {
    fn upsert_weak_point_from_mastery(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        concept: &str,
        evidence: &MasteryWeakPointEvidence,
    ) -> VfsResult<()> {
        learner_profile::upsert_weak_point_from_mastery(vfs_db, concept, evidence).map(|_| ())
    }

    fn remove_weak_point_from_mastery(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        concept: &str,
    ) -> VfsResult<()> {
        learner_profile::remove_weak_point_from_mastery(vfs_db, concept).map(|_| ())
    }
}

/// 由 `extensions::register_extensions()` 的 `MemoryMasteryPlugin` 调用；幂等由
/// `PluginHost`（同名插件只 apply 一次）保证。
pub fn install_mastery_hooks(scope: &mut dstu_kernel::Scope) {
    let sink = Arc::new(LearnerProfileMasterySink);
    if let Ok(disposer) = crate::mastery::profile_sink::register_mastery_profile_sink(sink) {
        scope.add(disposer);
    }
}
