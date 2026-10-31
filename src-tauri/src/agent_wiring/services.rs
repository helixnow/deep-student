//! pipeline 服务容器组装（step 10 §3.1 #2 / §4）。
//!
//! 拆分前 `ChatV2Pipeline` 与 `ExecutionContext` 直接持有两个 L4 域服务字段：
//! `notes_manager`（Canvas 工具）与 `question_bank_service`（qbank_* / review_* 工具）。
//! 现在统一放进 `dstu_agent_api::Services`，域执行器按类型取用：
//! `ctx.services.get::<NotesManager>()` / `ctx.services.get::<QuestionBankService>()`。
//! 未插入的服务取出为 `None`，与原字段为 `None` 时的行为一致。

use std::sync::Arc;

use dstu_agent_api::Services;

use crate::notes_manager::NotesManager;
use crate::question_bank_service::QuestionBankService;

/// 由宿主已有的 `Arc` 组装 pipeline 服务容器（插入的是**同一份** `Arc`）。
///
/// - `notes_manager`：原 `ChatV2Pipeline::new` 的 `notes_manager` 参数；
/// - `question_bank_service`：原 `with_question_bank_service`，仅 `Some` 时插入。
pub fn build_pipeline_services(
    notes_manager: Option<Arc<NotesManager>>,
    question_bank_service: Option<Arc<QuestionBankService>>,
) -> Arc<Services> {
    let mut services = Services::new();
    if let Some(notes_manager) = notes_manager {
        services.insert(notes_manager);
    }
    if let Some(question_bank_service) = question_bank_service {
        services.insert(question_bank_service);
    }
    Arc::new(services)
}
