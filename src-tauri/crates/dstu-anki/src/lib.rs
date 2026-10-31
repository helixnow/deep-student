//! Deep Student Anki 制卡域 crate（服务层）。
//!
//! - 卡片仓储与模板配置（`anki`）、AnkiConnect 客户端（`anki_connect_service`）；
//! - APKG 导出 / 导入（`apkg_exporter_service` / `apkg_importer_service`）；
//! - 文档拆分、编排与流式制卡（`document_processing_service` / `enhanced_anki_service` /
//!   `streaming_anki_service`）；
//! - FSRS 复习服务（`fsrs_review_service`）；
//! - 制卡协议 / lint / critic / 金标 / 偏好记忆 / 图像遮挡 / 复习画像回流等纯函数层（`anki_*`）。
//!
//! 模块路径与拆分前在 `deep_student_lib` 中的路径一致：app 通过
//! `pub use dstu_anki::xxx` 保留原路径。取 `State<AppState>` 的命令层（`cmd::{anki_cards,
//! anki_connect, apkg_import, enhanced_anki, fsrs_review}`）与 ChatAnki 工具执行器
//! （`chat_v2::tools::chatanki_executor` 等，依赖 chat_v2 内部 API）仍留在 app。

// 与 app 相同的宏展开余量（制卡事件 / LLM 请求体的 json! 块）。
#![recursion_limit = "512"]

// 拆分前这些模块通过 `crate::xxx` 引用已下沉到其他 dstu crate 的模块，保留原路径。
use dstu_core::{models, prompt_contracts};
use dstu_learning::{fsrs_scheduler, mastery};
use dstu_llm::{anki_model_routing, llm_manager, providers};
use dstu_storage::database;
#[cfg(test)]
use dstu_storage::file_manager;
use dstu_util::utils;

// 单测按原路径 `crate::data_governance::{migration, schema_registry}` 建迁移好的测试库
// （app 的 `data_governance` 按原路径重导出 dstu-storage 的这两个模块）。
#[cfg(test)]
mod data_governance {
    pub(crate) use dstu_storage::{migration, schema_registry};
}

pub mod anki;
pub mod anki_connect_service;
pub mod anki_critic; // 生成后 grounded judge / LLM critic pass（opt-in 默认关闭，Round 4 #2）
pub mod anki_fsrs_feedback; // FSRS 复习数据回流制卡生成（用户复习画像 + 语义干扰预警，Round 3 #5）
pub mod anki_gold_set; // 金标卡集挖掘纯函数（编辑前后 diff → 金标/修正对 + lint 契约校验，Round 4 #10）
pub mod anki_image_occlusion; // AI 图像遮挡草稿纯函数层（OcclusionSpec 校验 / cloze 候选字段 / IMAGE_DESC 启发式盒建议，Round 4 #5）
pub mod anki_preference_memory; // 用户制卡偏好记忆（Mem0 风格 ADD-only 纯逻辑，接线见模块文档）
pub mod anki_protocol; // Anki 制卡输出协议（分隔符常量 / Structured Output / schema 生成）
pub mod anki_qa_lint; // 确定性卡片质检 lint（零 LLM 成本，Round 3 #3）
#[allow(dead_code)]
pub mod apkg_exporter_service;
pub mod apkg_importer_service;
pub mod document_processing_service;
pub mod enhanced_anki_service;
pub mod fsrs_review_service; // FSRS 闪卡复习服务（独立于题库 review_plans）
#[allow(dead_code)]
pub mod streaming_anki_service;
