//! 题库纯数据类型（无领域依赖）。
//!
//! `SourceRef` / `QuestionMaterial` 只做序列化与内存表达，是 VFS 仓储层
//! （`vfs::repos::question_repo`）与题库领域（`qbank_document`）共用的数据形状。
//! 放在 vfs 内避免仓储层反向上依赖题库领域模块；`crate::qbank_document` 按原路径重导出。

use crate::vfs::repos::QuestionImage;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct SourceRef {
    pub source_id: String,
    #[serde(default)]
    pub page: Option<u32>,
    #[serde(default)]
    pub bbox: Option<[f64; 4]>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct QuestionMaterial {
    pub id: String,
    pub content: String,
    #[serde(default)]
    pub images: Vec<QuestionImage>,
    #[serde(default)]
    pub source_refs: Vec<SourceRef>,
    pub version: i64,
}
