//! 掌握度 → 学习者画像薄弱点的确定性回流扩展点。
//!
//! 学习者画像（`memory::learner_profile`）属于记忆系统：画像笔记放在 `MemoryConfig`
//! 管理的记忆根目录 `__system__` 下，创建时与记忆写路径共用 `MEMORY_STRUCTURE_LOCK`，
//! 写路径还经 `MemoryService` 记审计日志，因此不随本 crate 下沉。mastery 只在这里声明
//! 回流接口和证据类型；memory 实现 [`MasteryProfileSink`]，在组合根（app 的
//! `extensions::register_extensions()`）注入。启动时先注入再执行任何业务代码，
//! 完整应用中的行为与拆分前直接调用 `learner_profile::*_weak_point_from_mastery` 一致。
//! 未注入时（本 crate 单测、未调用 `register_extensions()` 的环境）回流为 no-op。

use std::sync::Arc;

use dstu_kernel::{Disposer, Slot, SlotOccupied};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;

/// 薄弱知识点来源：掌握度中间层确定性回流（与 LLM 晋升路径共存）
pub const WEAK_POINT_SOURCE_MASTERY: &str = "mastery";

/// 掌握度回流时携带的确定性证据（不经 LLM）
#[derive(Debug, Clone)]
pub struct MasteryWeakPointEvidence {
    pub score: f64,
    pub total: i32,
    pub wrong_count: i32,
    pub recent_wrong_summary: String,
}

/// 画像侧的回流实现（memory 提供）。
pub trait MasteryProfileSink: Send + Sync {
    /// 掌握度中间层 → 画像薄弱点确定性 upsert（`source: mastery`）
    fn upsert_weak_point_from_mastery(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        concept: &str,
        evidence: &MasteryWeakPointEvidence,
    ) -> VfsResult<()>;

    /// 掌握度恢复：移除 `source=mastery` 且知识点匹配的薄弱点
    fn remove_weak_point_from_mastery(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        concept: &str,
    ) -> VfsResult<()>;
}

static MASTERY_PROFILE_SINK: Slot<dyn MasteryProfileSink> = Slot::new();

/// 注册画像回流实现；槽位已占用时返回 `Err(SlotOccupied)`（先注册者生效）。
pub fn register_mastery_profile_sink(
    sink: Arc<dyn MasteryProfileSink>,
) -> Result<Disposer, SlotOccupied> {
    MASTERY_PROFILE_SINK.provide(sink)
}

pub(crate) fn upsert_weak_point_from_mastery(
    vfs_db: &Arc<VfsDatabase>,
    concept: &str,
    evidence: &MasteryWeakPointEvidence,
) -> VfsResult<()> {
    match MASTERY_PROFILE_SINK.get() {
        Some(sink) => sink.upsert_weak_point_from_mastery(vfs_db, concept, evidence),
        None => Ok(()),
    }
}

pub(crate) fn remove_weak_point_from_mastery(
    vfs_db: &Arc<VfsDatabase>,
    concept: &str,
) -> VfsResult<()> {
    match MASTERY_PROFILE_SINK.get() {
        Some(sink) => sink.remove_weak_point_from_mastery(vfs_db, concept),
        None => Ok(()),
    }
}
