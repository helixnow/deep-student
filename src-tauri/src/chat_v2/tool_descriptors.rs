//! G01-c：ToolDescriptor 后端权威注册表
//!
//! ## 背景
//! 工具元数据曾散落多处且各自为政：`executor_registry::get_tool_timeout_secs`
//! 的字符串匹配表、`headless.rs` 的只读白名单、`ptc_runtime.rs` 的
//! `PTC_ALLOWED_TOOLS`、`grants.rs` 的 `ToolScope`、各 executor 自报敏感度。
//! 任何一处新增工具忘记同步别处就是能力面漂移。本模块把全部内建工具的
//! 静态元数据收敛到一张编译期全量表 [`BUILTIN_DESCRIPTORS`]，并配套
//! 同步测试（见文件底部 `mod tests`）：
//!
//! - 注册表 ↔ 执行器注册表双向对齐：每个 descriptor 必须有特异性 executor
//!   受理；独立维护的安全清单（headless 白/黑名单、PTC 白名单、automation
//!   受信写工具集）里每个被受理的工具必须恰有一条 descriptor；
//! - descriptor 的名字级敏感度与 executor 自报基线逐工具相等；
//! - `executor_registry::get_tool_timeout_secs` 已迁移为注册表驱动
//!   （等价性由 executor_registry 内的 legacy 对照测试锁定）。
//!
//! ## 命名口径
//! - `name` 一律为**裸名**（不带 `builtin-` 前缀），与 `strip_tool_namespace`
//!   的输出一致；
//! - 查询入口按调用方现状剥一次 `builtin-` 前缀（不多剥，与旧超时表口径
//!   逐字节一致，见 executor_registry 等价性测试的 `builtin-builtin-` 用例）。
//!
//! ## 消费方迁移状态
//! - 已迁移：`executor_registry::get_tool_timeout_secs`（G01-c，行为等价）；
//!   `headless.rs` 只读白名单（G01-e：`headless_allowed_tools` /
//!   `is_headless_allowed_tool` 改由 `headless_allowed` 标志位驱动，历史手写
//!   清单保留为 headless 侧 `#[cfg(test)]` 对照 oracle）；
//!   `grants.rs` 的 ToolScope 推导（G01-e grants 半边：`ToolScope::
//!   from_allow_entry` 的 Builtin/Shell 分类改由 [`grants_scope_hint`] 驱动，
//!   字符串规则先行不变、shell 族收紧为 fail-closed 语义位，等价性由
//!   grants 侧四层断言对照测试锁定）。
//! - 待迁移（G01-e 后续小步）：`ptc_runtime.rs::PTC_ALLOWED_TOOLS`。
//!   查询函数 [`is_ptc_allowed`] 与等价性测试已就绪，切换时删除旧常量即可。

use std::collections::HashMap;
use std::sync::LazyLock;

use super::tools::ToolSensitivity;
use ToolSensitivity::{High, Low, Medium};

// ============================================================================
// 枚举与结构
// ============================================================================

/// 副作用类别（保守归类：拿不准就往更严的桶放）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SideEffectClass {
    /// 纯读取：不落盘、不改任何持久状态（网络检索/查询也归此类）。
    Read,
    /// 写本地状态：本地 DB / VFS / 文件 / 会话状态 / 桌面操控。
    WriteLocal,
    /// 写远端：对外部服务造成可见效果（connector commit、云同步、网页表单类操作）。
    WriteRemote,
    /// 不可恢复：硬删除 / 清空进度 / 任意命令执行等无法撤销的破坏面。
    Irreversible,
}
use SideEffectClass::{Irreversible, Read, WriteLocal, WriteRemote};

/// `grants::ToolScope` 映射提示（G02-P1）。
///
/// 内建工具统一映射 `ToolScope::Builtin`；shell 族工具映射 `ToolScope::Shell`
/// 语义位（P1 阶段 Shell 授权恒 fail-closed，此处只是声明性提示）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GrantsScopeHint {
    Builtin,
    Shell,
}

/// 内建工具静态描述符（注册表条目）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ToolDescriptor {
    /// 裸工具名（无 `builtin-` 前缀）。
    pub name: &'static str,
    /// 名字级敏感基线 = executor 的 `sensitivity_level(name)`（同步测试逐工具锁定）。
    /// 参数级动态分级（如 `chatanki_transform` 脚本模式）仍以 executor 为准。
    pub sensitivity: ToolSensitivity,
    /// 是否纯只读（无副作用）。标注以 executor 现状为准，拿不准一律 false（fail-closed）。
    pub read_only: bool,
    /// 副作用类别（保守归类）。
    pub side_effect_class: SideEffectClass,
    /// 注册表看门狗超时（秒）：`None` = 默认 [`DEFAULT_TIMEOUT_SECS`]；
    /// `Some(0)` = 豁免看门狗（工具内部自带预算/取消，语义同旧表
    /// `NO_TOOL_TIMEOUT_SECS`，见 [`NO_TIMEOUT_SECS`]）。
    pub timeout_secs: Option<u64>,
    /// grants ToolScope 映射提示。
    pub grants_scope_hint: GrantsScopeHint,
    /// 是否属于 headless 白名单。G01-e 起为权威来源：
    /// `headless::headless_allowed_tools()` 由本标志派生，与历史手写清单的
    /// 等价性由 headless 侧对照测试与本模块同步测试双重锁定。
    pub headless_allowed: bool,
    /// 是否属于 PTC 脚本可调用白名单（与 `ptc_runtime::PTC_ALLOWED_TOOLS` 对齐，
    /// 等价性由同步测试锁定）。
    pub ptc_allowed: bool,
}

/// 默认工具执行超时（秒）——注册表看门狗默认值的全局唯一来源
/// （`executor_registry::DEFAULT_TOOL_TIMEOUT_SECS` 是本常量的别名）。
pub const DEFAULT_TIMEOUT_SECS: u64 = 120;
/// 看门狗豁免标记（`timeout_secs = Some(0)`）。
pub const NO_TIMEOUT_SECS: u64 = 0;

const fn d(
    name: &'static str,
    sensitivity: ToolSensitivity,
    read_only: bool,
    side_effect_class: SideEffectClass,
) -> ToolDescriptor {
    ToolDescriptor {
        name,
        sensitivity,
        read_only,
        side_effect_class,
        timeout_secs: None,
        grants_scope_hint: GrantsScopeHint::Builtin,
        headless_allowed: false,
        ptc_allowed: false,
    }
}

impl ToolDescriptor {
    /// 设置注册表看门狗超时（秒）；`0` = 豁免看门狗。
    pub const fn with_timeout(self, secs: u64) -> Self {
        ToolDescriptor {
            name: self.name,
            sensitivity: self.sensitivity,
            read_only: self.read_only,
            side_effect_class: self.side_effect_class,
            timeout_secs: Some(secs),
            grants_scope_hint: self.grants_scope_hint,
            headless_allowed: self.headless_allowed,
            ptc_allowed: self.ptc_allowed,
        }
    }

    /// 标记 grants 提示为 Shell 语义位。
    pub const fn shell_scoped(self) -> Self {
        ToolDescriptor {
            name: self.name,
            sensitivity: self.sensitivity,
            read_only: self.read_only,
            side_effect_class: self.side_effect_class,
            timeout_secs: self.timeout_secs,
            grants_scope_hint: GrantsScopeHint::Shell,
            headless_allowed: self.headless_allowed,
            ptc_allowed: self.ptc_allowed,
        }
    }

    /// 标记为 headless 白名单成员。
    pub const fn headless(self) -> Self {
        ToolDescriptor {
            name: self.name,
            sensitivity: self.sensitivity,
            read_only: self.read_only,
            side_effect_class: self.side_effect_class,
            timeout_secs: self.timeout_secs,
            grants_scope_hint: self.grants_scope_hint,
            headless_allowed: true,
            ptc_allowed: self.ptc_allowed,
        }
    }

    /// 标记为 PTC 白名单成员。
    pub const fn ptc(self) -> Self {
        ToolDescriptor {
            name: self.name,
            sensitivity: self.sensitivity,
            read_only: self.read_only,
            side_effect_class: self.side_effect_class,
            timeout_secs: self.timeout_secs,
            grants_scope_hint: self.grants_scope_hint,
            headless_allowed: self.headless_allowed,
            ptc_allowed: true,
        }
    }

    /// 同时标记 headless + PTC 白名单成员（两名单高度重叠的只读数据面）。
    pub const fn headless_ptc(self) -> Self {
        ToolDescriptor {
            name: self.name,
            sensitivity: self.sensitivity,
            read_only: self.read_only,
            side_effect_class: self.side_effect_class,
            timeout_secs: self.timeout_secs,
            grants_scope_hint: self.grants_scope_hint,
            headless_allowed: true,
            ptc_allowed: true,
        }
    }
}

// ============================================================================
// 全量内建工具描述符表（按 executor 分组，与 pipeline.rs 注册顺序同序）
// ============================================================================
//
// 盘点来源（2026-09）：各 executor `can_handle` 名单 + `tool_names` 常量、
// `executor_registry` 旧超时表、`headless` 白/黑名单、`PTC_ALLOWED_TOOLS`、
// `automations::trusted_profile_supported_extra_tools`。
// 新增工具时必须在此登记，否则同步测试红灯。
pub static BUILTIN_DESCRIPTORS: &[ToolDescriptor] = &[
    // —— AttemptCompletionExecutor（1）——
    // 控制面工具：标记任务完成，不改用户数据。
    d("attempt_completion", Low, true, Read).headless(),

    // —— CanvasToolExecutor（9）——
    d("note_read", Low, true, Read),
    d("note_list", Low, true, Read),
    d("note_search", Low, true, Read),
    d("note_append", Medium, false, WriteLocal),
    d("note_create", Medium, false, WriteLocal),
    d("note_delete", Medium, false, WriteLocal),
    d("note_update_tags", Medium, false, WriteLocal),
    d("note_set", High, false, WriteLocal),
    d("note_replace", High, false, WriteLocal),

    // —— ChatAnkiToolExecutor（29）——
    // 旧超时表前缀规则：`chatanki_*` 一律 600s，`chatanki_wait` 61 分钟。
    d("chatanki_run", Low, false, WriteLocal).with_timeout(600),
    d("chatanki_import_apkg", Medium, false, WriteLocal).with_timeout(600),
    d("chatanki_start", Low, false, WriteLocal).with_timeout(600),
    d("chatanki_status", Low, true, Read).with_timeout(600),
    // 内部 timeoutMs 上限 60 分钟 + 竞态缓冲（迁移自旧表 61*60）。
    d("chatanki_wait", Low, true, Read).with_timeout(61 * 60),
    d("chatanki_get_cards", Low, true, Read).with_timeout(600),
    d("chatanki_update_card", Low, false, WriteLocal).with_timeout(600),
    d("chatanki_batch_update_cards", Medium, false, WriteLocal).with_timeout(600),
    d("chatanki_delete_card", Low, false, Irreversible).with_timeout(600),
    d("chatanki_delete_cards", Medium, false, Irreversible).with_timeout(600),
    // 经本机 AnkiConnect 写入牌组，归本地写。
    d("chatanki_add_cards", Low, false, WriteLocal).with_timeout(600),
    d("chatanki_enqueue_review", Low, false, WriteLocal).with_timeout(600),
    d("chatanki_review_stats", Low, true, Read).with_timeout(600),
    d("chatanki_undo_last_review", High, false, WriteLocal).with_timeout(600),
    d("chatanki_set_suspended", Medium, false, WriteLocal).with_timeout(600),
    d("chatanki_list_library_cards", Low, true, Read).with_timeout(600),
    d("chatanki_update_library_card", High, false, WriteLocal).with_timeout(600),
    d("chatanki_enqueue_library_review", Medium, false, WriteLocal).with_timeout(600),
    d("chatanki_set_library_suspended", Medium, false, WriteLocal).with_timeout(600),
    d("chatanki_undo_library_last_review", High, false, WriteLocal).with_timeout(600),
    d("chatanki_delete_library_card", High, false, Irreversible).with_timeout(600),
    d("chatanki_retemplate", Low, false, WriteLocal).with_timeout(600),
    // 名字级基线 Medium；script 模式按参数动态升 High（executor 为准）。
    d("chatanki_transform", Medium, false, WriteLocal).with_timeout(600),
    d("chatanki_control", Low, false, WriteLocal).with_timeout(600),
    d("chatanki_export", Medium, false, WriteLocal).with_timeout(600),
    // export/sync 注释（executor）：向本进程外发送完整卡片数据，按数据外发归类。
    d("chatanki_sync", Medium, false, WriteRemote).with_timeout(600),
    d("chatanki_list_templates", Low, true, Read).with_timeout(600),
    d("chatanki_analyze", Low, true, Read).with_timeout(600),
    d("chatanki_check_anki_connect", Low, true, Read).with_timeout(600),

    // —— BuiltinRetrievalExecutor（4）——
    // multimodal_search 已在暴露层收敛进 unified_search，执行器仍受理（历史回放）。
    d("unified_search", Low, true, Read).with_timeout(180).headless_ptc(),
    d("rag_search", Low, true, Read).with_timeout(180).headless_ptc(),
    d("multimodal_search", Low, true, Read).with_timeout(180),
    d("web_search", Low, true, Read).with_timeout(180).headless_ptc(),

    // —— InsightRecallExecutor（1）——
    // 召回可能伴随记忆侧活动记录，按 fail-closed 标非只读。
    d("insight_recall", Low, false, WriteLocal),

    // —— BuiltinResourceExecutor（11）——
    d("resource_list", Low, true, Read).headless_ptc(),
    d("resource_read", Low, true, Read).headless_ptc(),
    d("resource_search", Low, true, Read).headless_ptc(),
    d("folder_list", Low, true, Read).headless_ptc(),
    d("mindmap_create", Low, false, WriteLocal),
    d("mindmap_update", Low, false, WriteLocal),
    // 导图删除的恢复路径未确认，按不可恢复归类（fail-closed）。
    d("mindmap_delete", High, false, Irreversible),
    d("mindmap_edit_nodes", High, false, WriteLocal),
    d("mindmap_versions", Low, true, Read),
    d("mindmap_diff_versions", Low, true, Read),
    d("mindmap_import", Low, false, WriteLocal),

    // —— ConnectorToolExecutor（4）——
    d("connector_registry", Low, true, Read),
    d("connector_operation_draft", Medium, false, WriteLocal),
    d("connector_operation_confirm", High, false, WriteLocal),
    // commit 落到外部服务（gmail_send 等），远端副作用。
    d("connector_operation_commit", High, false, WriteRemote),

    // —— TaskAuditExecutor（2）——
    d("task_audit_export", Medium, false, WriteLocal),
    d("lineage_forget", High, false, Irreversible),

    // —— DstuToolExecutor（10）——
    d("dstu_folder_create", Medium, false, WriteLocal),
    d("dstu_folder_rename", Medium, false, WriteLocal),
    d("dstu_rename", Medium, false, WriteLocal),
    d("dstu_move", Medium, false, WriteLocal),
    // delete 进回收站（dstu_restore 可恢复），非不可恢复。
    d("dstu_delete", Medium, false, WriteLocal),
    d("dstu_restore", Medium, false, WriteLocal),
    d("dstu_list_trash", Low, true, Read).headless_ptc(),
    d("dstu_set_favorite", Low, false, WriteLocal),
    d("dstu_purge", High, false, Irreversible),
    d("dstu_upload_file", Medium, false, WriteLocal),

    // —— AttachmentToolExecutor（2）——
    d("attachment_list", Low, true, Read),
    d("attachment_read", Low, true, Read),

    // —— FetchExecutor（1）——
    d("web_fetch", Low, true, Read).with_timeout(180).headless_ptc(),

    // —— BrowserToolExecutor（11）——
    d("browser_open", High, false, WriteLocal),
    // navigate/click/type 可触发远端页面副作用（表单提交等），按远端写归类。
    d("browser_navigate", Medium, false, WriteRemote),
    d("browser_snapshot", Low, true, Read),
    d("browser_screenshot", Low, true, Read),
    d("browser_click", Medium, false, WriteRemote),
    d("browser_type", Medium, false, WriteRemote),
    d("browser_file_upload", High, false, WriteRemote),
    // downloads 会把文件写进本地受管目录。
    d("browser_downloads", Low, false, WriteLocal),
    d("browser_scroll", Low, true, Read),
    d("browser_back", Low, false, WriteLocal),
    d("browser_close", Medium, false, WriteLocal),

    // —— MediaToolExecutor（2）——
    d("media_capabilities", Low, true, Read),
    d("media_transcribe", Medium, false, WriteLocal),

    // —— OfficeFidelityExecutor（1）——
    d("office_fidelity_inspect", Low, true, Read),

    // —— McpProposeExecutor（1）——
    // 裸名带 mcp_ 前缀，旧超时表经外部-MCP 前缀兜底得 180s；注册表化后显式保留。
    d("mcp_server_propose", High, false, WriteLocal).with_timeout(180),

    // —— McpManageExecutor（3）——
    d("mcp_server_update", High, false, WriteLocal).with_timeout(180),
    d("mcp_server_set_enabled", Medium, false, WriteLocal).with_timeout(180),
    d("mcp_server_remove", High, false, WriteLocal).with_timeout(180),

    // —— AutomationExecutor（9）——
    d("automation_propose", High, false, WriteLocal),
    d("automation_list", Low, true, Read),
    d("automation_set_enabled", Medium, false, WriteLocal),
    d("automation_update", Medium, false, WriteLocal),
    d("automation_delete", High, false, Irreversible),
    d("automation_run_now", Medium, false, WriteLocal),
    d("automation_runs", Low, true, Read),
    d("automation_retry_run", Medium, false, WriteLocal),
    d("automation_cancel_run", Medium, false, WriteLocal),

    // —— AcademicSearchExecutor（2）——
    d("arxiv_search", Low, true, Read).with_timeout(180).ptc(),
    d("scholar_search", Low, true, Read).with_timeout(180).ptc(),

    // —— PaperSaveExecutor（2）——
    d("paper_save", Medium, false, WriteLocal).with_timeout(600),
    d("cite_format", Low, true, Read).with_timeout(30),

    // —— KnowledgeExecutor（1）——
    // 内化提取会写长期记忆候选，按写归类。
    d("knowledge_extract", Low, false, WriteLocal),

    // —— TodoListExecutor（4，代理侧 todo 面板状态）——
    d("todo_init", Low, false, WriteLocal).headless(),
    d("todo_update", Low, false, WriteLocal).headless(),
    d("todo_add", Low, false, WriteLocal).headless(),
    d("todo_get", Low, true, Read).headless(),

    // —— GoalExecutor（3，会话级持久目标）——
    d("goal_create", Low, false, WriteLocal),
    d("goal_update", Low, false, WriteLocal),
    d("goal_get", Low, true, Read),

    // —— QBankExecutor（32）——
    d("qbank_list", Low, true, Read).headless_ptc(),
    d("qbank_list_questions", Low, true, Read).headless_ptc(),
    d("qbank_get_question", Low, true, Read).headless_ptc(),
    d("qbank_get_stats", Low, true, Read).headless_ptc(),
    // 推荐状态语义，executor 明确不视为纯只读。
    d("qbank_get_next_question", Low, false, WriteLocal).headless_ptc(),
    d("qbank_get_submissions", Low, true, Read),
    d("qbank_get_question_history", Low, true, Read),
    d("qbank_list_source_images", Low, true, Read),
    d("qbank_search_questions", Low, true, Read),
    d("qbank_get_learning_trend", Low, true, Read),
    d("qbank_get_activity_heatmap", Low, true, Read),
    d("qbank_get_knowledge_stats", Low, true, Read),
    d("qbank_get_check_in_calendar", Low, true, Read),
    d("qbank_get_daily_practice", Low, false, WriteLocal),
    d("qbank_create_question", Medium, false, WriteLocal),
    d("qbank_toggle_favorite", Medium, false, WriteLocal),
    d("qbank_toggle_bookmark", Medium, false, WriteLocal),
    d("qbank_submit_answer", Medium, false, WriteLocal),
    d("qbank_update_question", Medium, false, WriteLocal),
    d("qbank_batch_update_questions", Medium, false, WriteLocal),
    d("qbank_generate_paper", Medium, false, WriteLocal),
    d("qbank_batch_import", Medium, false, WriteLocal),
    d("qbank_import_document", Medium, false, WriteLocal),
    d("qbank_export", Medium, false, WriteLocal),
    d("qbank_ai_grade", Medium, false, WriteLocal),
    d("qbank_start_timed_practice", Low, false, WriteLocal),
    d("qbank_generate_mock_exam", Low, false, WriteLocal),
    d("qbank_submit_mock_exam", Low, false, WriteLocal),
    d("qbank_generate_variant", Low, false, WriteLocal),
    d("qbank_reset_progress", Medium, false, Irreversible),
    d("qbank_delete_questions", High, false, Irreversible),

    // —— TranslationToolExecutor（3）——
    // translate_text 消耗 LLM 预算并填充内存结果缓存，不按纯只读标注。
    d("translate_text", Low, false, WriteLocal).with_timeout(600),
    d("translation_result_read", Low, true, Read),
    d("translation_save", Medium, false, WriteLocal),

    // —— SettingsModelsToolExecutor（5）——
    d("settings_get", Low, true, Read).headless_ptc(),
    d("settings_set", Medium, false, WriteLocal),
    d("model_assignments_get", Low, true, Read).headless_ptc(),
    d("model_assignments_set", Medium, false, WriteLocal),
    d("model_profile_add", High, false, WriteLocal),

    // —— LlmUsageToolExecutor（1）——
    d("llm_usage_query", Low, true, Read).headless_ptc(),

    // —— LearningOverviewExecutor（3）——
    d("learning_overview", Low, true, Read).headless_ptc(),
    d("pomodoro_today_stats", Low, true, Read).headless_ptc(),
    d("pomodoro_daily_stats", Low, true, Read).headless_ptc(),

    // —— DataGovernanceToolExecutor（5）——
    d("backup_status", Low, true, Read).headless_ptc(),
    d("backup_job_status", Low, true, Read).headless_ptc(),
    d("sync_status", Low, true, Read).headless_ptc(),
    d("backup_create", High, false, WriteLocal),
    d("sync_run", High, false, WriteRemote),

    // —— MemoryToolExecutor（16）——
    d("memory_search", Low, true, Read),
    d("memory_read", Low, true, Read).headless_ptc(),
    d("memory_list", Low, true, Read).headless_ptc(),
    d("memory_write", Medium, false, WriteLocal),
    d("memory_write_smart", Medium, false, WriteLocal),
    d("memory_write_batch", Medium, false, WriteLocal),
    d("memory_update_by_id", Medium, false, WriteLocal),
    // VFS 软删除，可经回收站恢复。
    d("memory_delete", Medium, false, WriteLocal),
    d("memory_batch_move", Medium, false, WriteLocal),
    d("memory_add_relation", Medium, false, WriteLocal),
    d("memory_remove_relation", Medium, false, WriteLocal),
    d("memory_update_tags", Medium, false, WriteLocal),
    d("memory_log_activity", Medium, false, WriteLocal),
    d("memory_export_all", High, false, WriteLocal),
    // 学习者画像读取（Medium 基线以 executor 为准；本身是纯 getter）。
    d("learner_profile_get", Medium, true, Read),
    d("learner_profile_update", Medium, false, WriteLocal),

    // —— UserTodoExecutor（14）——
    d("user_todo_list_lists", Low, true, Read).headless_ptc(),
    d("user_todo_list_items", Low, true, Read).headless_ptc(),
    d("user_todo_get_summary", Low, true, Read).headless_ptc(),
    d("user_todo_search", Low, true, Read).headless_ptc(),
    d("user_todo_list_trash", Low, true, Read).headless_ptc(),
    d("user_todo_create_item", Medium, false, WriteLocal),
    d("user_todo_complete_item", Medium, false, WriteLocal),
    d("user_todo_update_item", Medium, false, WriteLocal),
    // 删除进回收站（user_todo_restore 可恢复）。
    d("user_todo_delete_item", Medium, false, WriteLocal),
    d("user_todo_create_list", Medium, false, WriteLocal),
    d("user_todo_update_list", Medium, false, WriteLocal),
    d("user_todo_delete_list", High, false, WriteLocal),
    d("user_todo_restore", Medium, false, WriteLocal),
    d("user_todo_reorder", Medium, false, WriteLocal),

    // —— SkillsExecutor（1）——
    d("load_skills", Low, true, Read),

    // —— TemplateDesignerExecutor（9）——
    d("template_list", Low, true, Read),
    d("template_get", Low, true, Read),
    d("template_validate", Low, true, Read),
    d("template_preview", Low, true, Read),
    d("template_create", Medium, false, WriteLocal),
    d("template_update", Medium, false, WriteLocal),
    d("template_fork", Medium, false, WriteLocal),
    d("template_set_default", Medium, false, WriteLocal),
    // 自定义模板是物理删除（executor 注释），按不可恢复归类。
    d("template_delete", High, false, Irreversible),

    // —— TextbookPdfToolExecutor（3）——
    // bookmarks/highlights 名字级 Medium；action=get 动态降 Low（executor 为准）。
    d("textbook_bookmarks", Medium, false, WriteLocal),
    d("textbook_highlights", Medium, false, WriteLocal),
    d("pdf_page_image", Low, true, Read),

    // —— IndexWebpageToolExecutor（3）——
    d("index_status", Low, true, Read).headless_ptc(),
    d("index_rebuild", High, false, WriteLocal).with_timeout(600),
    d("webpage_save", Medium, false, WriteLocal).with_timeout(300),

    // —— AskUserExecutor（1）——
    // 显式等待用户交互，豁免通用看门狗（旧表 NO_TOOL_TIMEOUT_SECS）。
    d("ask_user", Low, true, Read).with_timeout(NO_TIMEOUT_SECS),

    // —— SessionToolExecutor（20）——
    d("session_list", Low, true, Read),
    d("session_search", Low, true, Read),
    d("session_get", Low, true, Read),
    d("session_get_messages", Low, true, Read),
    d("session_stats", Low, true, Read),
    d("tag_list_all", Low, true, Read),
    d("group_list", Low, true, Read),
    d("session_export", Medium, false, WriteLocal),
    d("session_import", Medium, false, WriteLocal),
    d("session_tag_add", Medium, false, WriteLocal),
    d("session_tag_remove", Medium, false, WriteLocal),
    d("session_move", Medium, false, WriteLocal),
    d("session_rename", Medium, false, WriteLocal),
    // 归档可经 session_restore 恢复。
    d("session_restore", Medium, false, WriteLocal),
    d("group_create", Medium, false, WriteLocal),
    d("group_update", Medium, false, WriteLocal),
    // 名字级 Medium；operations 含 archive 时动态升 High（executor 为准）。
    d("session_batch_tag", Medium, false, WriteLocal),
    d("session_batch_move", Medium, false, WriteLocal),
    d("session_batch_ops", Medium, false, WriteLocal),
    d("session_archive", High, false, WriteLocal),

    // —— DocxToolExecutor（6）——
    d("docx_read_structured", Low, true, Read),
    d("docx_extract_tables", Low, true, Read),
    d("docx_get_metadata", Low, true, Read),
    d("docx_to_spec", Low, true, Read).with_timeout(300),
    d("docx_create", Medium, false, WriteLocal).with_timeout(300),
    d("docx_replace_text", Medium, false, WriteLocal).with_timeout(300),

    // —— PptxToolExecutor（6）——
    d("pptx_read_structured", Low, true, Read),
    d("pptx_get_metadata", Low, true, Read),
    d("pptx_extract_tables", Low, true, Read),
    d("pptx_to_spec", Low, true, Read).with_timeout(300),
    d("pptx_create", Medium, false, WriteLocal).with_timeout(300),
    d("pptx_replace_text", Medium, false, WriteLocal).with_timeout(300),

    // —— XlsxToolExecutor（7）——
    // 旧超时表 300s 组不含 xlsx_edit_cells（保持默认 120s），迁移后维持原值。
    d("xlsx_read_structured", Low, true, Read),
    d("xlsx_extract_tables", Low, true, Read),
    d("xlsx_get_metadata", Low, true, Read),
    d("xlsx_to_spec", Low, true, Read).with_timeout(300),
    d("xlsx_create", Medium, false, WriteLocal).with_timeout(300),
    d("xlsx_edit_cells", Medium, false, WriteLocal),
    d("xlsx_replace_text", Medium, false, WriteLocal).with_timeout(300),

    // —— ImageGenerationExecutor（1）——
    d("image_generate", Low, false, WriteLocal).with_timeout(300),

    // —— GenerativeUiExecutor（1）——
    d("render_generative_ui", Low, false, WriteLocal),

    // —— WorkspaceFsExecutor（8）——
    d("workspace_file_list", Low, true, Read),
    d("workspace_file_read", Low, true, Read),
    d("workspace_artifact_write", Medium, false, WriteLocal),
    d("workspace_file_write", Medium, false, WriteLocal),
    d("workspace_file_edit", Medium, false, WriteLocal),
    d("workspace_file_move", High, false, WriteLocal),
    d("workspace_file_delete", High, false, WriteLocal),
    d("workspace_change_revert", High, false, WriteLocal),

    // —— LspNavigationExecutor（4）——
    // 查询本身只读，但会拉起外部语言服务器进程，不按纯只读标注（executor 注释）。
    d("workspace_lsp_definition", Medium, false, Read),
    d("workspace_lsp_references", Medium, false, Read),
    d("workspace_lsp_hover", Medium, false, Read),
    d("workspace_lsp_document_symbols", Medium, false, Read),

    // —— CodeNavigationExecutor（2）——
    d("workspace_text_search", Low, true, Read),
    d("workspace_symbol_outline", Low, true, Read),

    // —— FileManagerExecutor（3）——
    d("file_manager_plan", Low, true, Read),
    d("file_manager_commit", Medium, false, WriteLocal),
    d("file_manager_restore", Medium, false, WriteLocal),

    // —— AttachmentStageExecutor（2）——
    d("attachment_stage", Medium, false, WriteLocal),
    d("attachment_extract", Medium, false, WriteLocal),

    // —— NotesImportExecutor（1）——
    d("notes_import", Medium, false, WriteLocal),

    // —— SkillInstallExecutor（2）——
    d("skill_scan", Low, true, Read),
    d("skill_install", High, false, WriteLocal),

    // —— SkillMarketReadToolExecutor（2，chat_v2/skill_market_client.rs）——
    d("skill_market_search", Low, true, Read),
    d("skill_market_skill_detail", Low, true, Read),

    // —— SkillMarketInstallToolExecutor（2，chat_v2/skill_market_client.rs）——
    // verify 会下载包到受管目录做校验，按写归类（fail-closed）。
    d("skill_market_verify", Low, false, WriteLocal),
    d("skill_market_download_and_scan", High, false, WriteLocal),

    // —— SkillWorkshopExecutor（2）——
    d("skill_workshop_propose", Medium, false, WriteLocal),
    d("skill_workshop_apply", High, false, WriteLocal),

    // —— SkillLifecycleExecutor（3）——
    d("skill_set_enabled", Medium, false, WriteLocal),
    // 删除技能包，破坏性（approval_scope 注释）。
    d("skill_remove", High, false, Irreversible),
    // 名字级 High；action=inspect 动态降 Low（executor 为准）。
    d("skill_trust_request", High, false, WriteLocal),

    // —— LocalShellPreflightExecutor（1）——
    // 纯策略预检，不执行命令。
    d("local_shell_preflight", Low, true, Read).shell_scoped(),

    // —— GitToolExecutor（5）——
    d("git_status", Medium, true, Read),
    d("git_diff", Medium, true, Read),
    d("git_log", Medium, true, Read),
    // 名字级 High；action=list 动态降 Medium（executor 为准）。
    d("git_branch", High, false, WriteLocal),
    d("git_commit", High, false, WriteLocal),

    // —— SelfInspectExecutor（1）——
    d("self_inspect", Low, true, Read),

    // —— RolePackExecutor（3）——
    d("role_pack_list", Low, true, Read),
    d("role_pack_get", Low, true, Read),
    d("role_pack_validate", Low, true, Read),

    // —— RuntimeRootRequestExecutor（1）——
    d("runtime_root_request", High, false, WriteLocal),

    // —— LocalShellExecuteExecutor（1）——
    // 任意命令执行，executor 自带命令级 deadline + 沙箱清理，看门狗豁免。
    d("local_shell_execute", High, false, Irreversible)
        .with_timeout(NO_TIMEOUT_SECS)
        .shell_scoped(),

    // —— EssayGradingExecutor（7）——
    d("essay_grade", Medium, false, WriteLocal),
    d("essay_grade_status", Low, true, Read),
    d("essay_grade_wait", Low, true, Read),
    d("essay_list_modes", Low, true, Read),
    d("essay_list_sessions", Low, true, Read),
    d("essay_list_results", Low, true, Read),
    d("essay_get_result", Low, true, Read),

    // —— ReviewToolExecutor（8）——
    d("review_get_due", Low, true, Read).headless_ptc(),
    d("review_stats", Low, true, Read).headless_ptc(),
    d("review_schedule", Medium, false, WriteLocal),
    d("review_plan_generate", Medium, false, WriteLocal),
    d("review_submit", Medium, false, WriteLocal),
    d("review_suspend", Medium, false, WriteLocal),
    d("review_resume", Medium, false, WriteLocal),
    d("review_delete", High, false, Irreversible),

    // —— DocumentProcessingExecutor（2）——
    d("document_parse", Medium, false, WriteLocal),
    d("document_parse_status", Low, true, Read),

    // —— WorkbenchToolExecutor（11）——
    // 旧超时表前缀规则：`workbench_*` 一律 180s（ACR 桥 + 前端 pacing 演出）。
    d("workbench_get_capabilities", Low, true, Read).with_timeout(180),
    d("workbench_observe", Low, true, Read).with_timeout(180),
    d("workbench_wait_for", Low, true, Read).with_timeout(180),
    d("workbench_list_windows", Low, true, Read).with_timeout(180),
    d("workbench_query_state", Low, true, Read).with_timeout(180),
    d("workbench_act", Medium, false, WriteLocal).with_timeout(180),
    d("workbench_app_command", Medium, false, WriteLocal).with_timeout(180),
    d("workbench_open_app", Medium, false, WriteLocal).with_timeout(180),
    d("workbench_act_high", High, false, WriteLocal).with_timeout(180),
    d("workbench_undo", High, false, WriteLocal).with_timeout(180),
    d("workbench_close_window", High, false, WriteLocal).with_timeout(180),

    // —— WorkspaceToolExecutor（8，coordinator 注册）——
    d("workspace_create", Low, false, WriteLocal),
    d("workspace_create_agent", Low, false, WriteLocal),
    d("workspace_send", Low, false, WriteLocal),
    d("workspace_query", Low, true, Read),
    d("workspace_set_context", Low, false, WriteLocal),
    d("workspace_get_context", Low, true, Read),
    d("workspace_update_document", Low, false, WriteLocal),
    d("workspace_read_document", Low, true, Read),

    // —— SubagentExecutor（1，coordinator 注册）——
    // 阻塞等待子代理终态，内部自带 750s 等待预算与取消，看门狗豁免。
    d("subagent_call", Medium, false, WriteLocal).with_timeout(NO_TIMEOUT_SECS),

    // —— CustomAgentExecutor（5，coordinator 注册）——
    d("custom_agent_list", Low, true, Read),
    d("custom_agent_get", Low, true, Read),
    d("custom_agent_propose", Medium, false, WriteLocal),
    d("custom_agent_apply", High, false, WriteLocal),
    // 删除 persona 文件，破坏性（approval_scope 注释）。
    d("custom_agent_remove", High, false, Irreversible),

    // —— CoordinatorSleepExecutor（1，coordinator 注册）——
    // 内部 60 分钟硬上限 + 取消令牌，看门狗豁免。
    d("coordinator_sleep", Low, false, WriteLocal).with_timeout(NO_TIMEOUT_SECS),

    // —— ToolPackExecutor（1，Arc::new_cyclic 尾部队列）——
    // 聚合器：子调用各自重过中央准入；pack 本身按可携带写副作用归类。
    d("tool_pack", Low, false, WriteLocal).with_timeout(600),

    // —— PtcExecutor（1）——
    // 子调用被白名单限死在只读面，但脚本本体是可编程执行 + trace 落库。
    d("ptc_run", Medium, false, WriteLocal).with_timeout(600),
];

// ============================================================================
// 查询入口
// ============================================================================

/// 裸名 → descriptor 的 O(1) 索引（编译期常量表的运行时缓存）。
static DESCRIPTOR_INDEX: LazyLock<HashMap<&'static str, &'static ToolDescriptor>> =
    LazyLock::new(|| BUILTIN_DESCRIPTORS.iter().map(|d| (d.name, d)).collect());

/// 按裸名精确查找 descriptor。
///
/// **不**剥 `builtin-` 前缀——调用方负责按自身口径剥一次
/// （`executor_registry::get_tool_timeout_secs` 的旧实现就是先剥一次再匹配；
/// 保持同样口径使迁移逐字节等价，双前缀输入会落到未登记兜底分支）。
pub fn lookup(name: &str) -> Option<&'static ToolDescriptor> {
    DESCRIPTOR_INDEX.get(name).copied()
}

/// 该工具是否属于 headless 只读白名单（接受 `builtin-` 前缀或裸名）。
///
/// G01-e 起为 headless 准入判定的权威实现（`headless::is_headless_allowed_tool`
/// 委托本函数）；与历史手写清单的集合等价性由本模块
/// `headless_flag_matches_headless_whitelist` 与 headless 侧对照测试双重锁定。
pub fn is_headless_readonly(tool_name: &str) -> bool {
    let stripped = tool_name.strip_prefix("builtin-").unwrap_or(tool_name);
    lookup(stripped).is_some_and(|d| d.headless_allowed)
}

/// 该工具是否允许在 PTC 脚本内调用（接受 `builtin-` 前缀或裸名）。
///
/// 与 `ptc_runtime::PTC_ALLOWED_TOOLS` 的集合等价性由本模块测试锁定。
// TODO(G01-e): 消费方切换——ptc_runtime.rs 的 PTC_ALLOWED_TOOLS /
// is_ptc_allowed_tool / PTC_ALLOWED_TOOL_SET 改由本标志位驱动，删除手写清单。
pub fn is_ptc_allowed(tool_name: &str) -> bool {
    let stripped = tool_name.strip_prefix("builtin-").unwrap_or(tool_name);
    lookup(stripped).is_some_and(|d| d.ptc_allowed)
}

/// 该工具的 grants ToolScope 映射提示（接受 `builtin-` 前缀或裸名）。
///
/// G01-e（grants 半边）起为 grants 侧 ToolScope 推导的分类权威：
/// `grants::ToolScope::from_allow_entry` 在字符串规则（`::` / `mcp_` 前缀）
/// 之后以本函数决定 Builtin/Shell 归类。未登记名字（外部 MCP 动态工具等）
/// 返回 `None`，由 grants 侧兜底为 `ToolScope::Builtin`（与旧纯字符串规则
/// 结果一致）。
pub fn grants_scope_hint(tool_name: &str) -> Option<GrantsScopeHint> {
    let stripped = tool_name.strip_prefix("builtin-").unwrap_or(tool_name);
    lookup(stripped).map(|d| d.grants_scope_hint)
}

// ============================================================================
// 同步测试（G01-c 的核心防线）
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Arc;

    use crate::chat_v2::automations::trusted_profile_supported_extra_tools;
    use crate::chat_v2::headless::{HEADLESS_BLOCKED_TOOLS, LEGACY_HEADLESS_ALLOWED_TOOLS};
    use crate::chat_v2::skill_market_client::{
        SkillMarketInstallToolExecutor, SkillMarketReadToolExecutor,
    };
    use crate::chat_v2::tools::executor_registry::ToolExecutorRegistry;
    use crate::chat_v2::tools::notes_import_executor::NotesImportExecutor;
    use crate::chat_v2::tools::ptc_runtime::PTC_ALLOWED_TOOLS;
    use crate::chat_v2::tools::qbank_executor::QBankExecutor;
    use crate::chat_v2::tools::role_pack_executor::RolePackExecutor;
    use crate::chat_v2::tools::runtime_root_request_executor::RuntimeRootRequestExecutor;
    use crate::chat_v2::tools::self_inspect_executor::SelfInspectExecutor;
    use crate::chat_v2::tools::skill_install_executor::SkillInstallExecutor;
    use crate::chat_v2::tools::skill_workshop_executor::SkillWorkshopExecutor;
    use crate::chat_v2::tools::{
        AcademicSearchExecutor, AskUserExecutor, AttachmentStageExecutor, AttachmentToolExecutor,
        AttemptCompletionExecutor, AutomationExecutor, BrowserToolExecutor, BuiltinResourceExecutor,
        BuiltinRetrievalExecutor, CanvasToolExecutor, ChatAnkiToolExecutor, CodeNavigationExecutor,
        ConnectorToolExecutor, CoordinatorSleepExecutor, CustomAgentExecutor,
        DataGovernanceToolExecutor, DocumentProcessingExecutor, DocxToolExecutor, DstuToolExecutor,
        EssayGradingExecutor, FetchExecutor, FileManagerExecutor, GeneralToolExecutor,
        GenerativeUiExecutor, GitToolExecutor, GoalExecutor, ImageGenerationExecutor,
        IndexWebpageToolExecutor, InsightRecallExecutor, KnowledgeExecutor, LearningOverviewExecutor,
        LlmUsageToolExecutor, LocalShellExecuteExecutor, LocalShellPreflightExecutor,
        LspNavigationExecutor, McpManageExecutor, McpProposeExecutor, MediaToolExecutor,
        MemoryToolExecutor, OfficeFidelityExecutor, PaperSaveExecutor, PptxToolExecutor,
        PtcExecutor, ReviewToolExecutor, SessionToolExecutor, SettingsModelsToolExecutor,
        SkillLifecycleExecutor, SkillsExecutor, SubagentExecutor, TaskAuditExecutor,
        TemplateDesignerExecutor, TextbookPdfToolExecutor, TodoListExecutor, ToolExecutor,
        ToolPackExecutor, TranslationToolExecutor, UserTodoExecutor, WorkbenchToolExecutor,
        WorkspaceFsExecutor, WorkspaceToolExecutor, XlsxToolExecutor,
    };
    use crate::chat_v2::workspace::WorkspaceCoordinator;

    /// 生产等价执行器注册表镜像。
    ///
    /// ⚠️ 与 `pipeline.rs::create_executor_registry_with_workspace` 保持**同序**镜像；
    /// 新增/删除 executor 时必须同步此处与 `EXPECTED_ROSTER`，否则本防线失效。
    /// （`create_executor_registry` 是 pipeline 私有方法，测试无法直接复用。）
    fn production_like_registry() -> (tempfile::TempDir, Arc<ToolExecutorRegistry>) {
        let temp = tempfile::tempdir().expect("workspace coordinator temp dir");
        let coordinator = Arc::new(WorkspaceCoordinator::new(temp.path().to_path_buf()));

        let mut executors: Vec<Arc<dyn ToolExecutor>> = vec![
            Arc::new(AttemptCompletionExecutor::new()),
            Arc::new(CanvasToolExecutor::new()),
            Arc::new(ChatAnkiToolExecutor::new()),
            Arc::new(BuiltinRetrievalExecutor::new()),
            Arc::new(InsightRecallExecutor::new()),
            Arc::new(BuiltinResourceExecutor::new()),
            Arc::new(ConnectorToolExecutor::new()),
            Arc::new(TaskAuditExecutor::new()),
            Arc::new(DstuToolExecutor::new()),
            Arc::new(AttachmentToolExecutor::new()),
            Arc::new(FetchExecutor::new()),
            Arc::new(BrowserToolExecutor::new()),
            Arc::new(MediaToolExecutor::new()),
            Arc::new(OfficeFidelityExecutor::new()),
            Arc::new(McpProposeExecutor::new()),
            Arc::new(McpManageExecutor::new()),
            Arc::new(AutomationExecutor::new()),
            Arc::new(AcademicSearchExecutor::new()),
            Arc::new(PaperSaveExecutor::new()),
            Arc::new(KnowledgeExecutor::new()),
            Arc::new(TodoListExecutor::new()),
            Arc::new(GoalExecutor::new()),
            Arc::new(QBankExecutor::new()),
            Arc::new(TranslationToolExecutor::new()),
            Arc::new(SettingsModelsToolExecutor::new()),
            Arc::new(LlmUsageToolExecutor::new()),
            Arc::new(LearningOverviewExecutor::new()),
            Arc::new(DataGovernanceToolExecutor::new()),
            Arc::new(MemoryToolExecutor::new()),
            Arc::new(UserTodoExecutor::new()),
            Arc::new(SkillsExecutor::new()),
            Arc::new(TemplateDesignerExecutor::new()),
            Arc::new(TextbookPdfToolExecutor::new()),
            Arc::new(IndexWebpageToolExecutor::new()),
            Arc::new(AskUserExecutor::new()),
            Arc::new(SessionToolExecutor::new()),
            Arc::new(DocxToolExecutor::new()),
            Arc::new(PptxToolExecutor::new()),
            Arc::new(XlsxToolExecutor::new()),
            Arc::new(ImageGenerationExecutor::new()),
            Arc::new(GenerativeUiExecutor::new()),
            Arc::new(WorkspaceFsExecutor::new()),
            Arc::new(LspNavigationExecutor::new()),
            Arc::new(CodeNavigationExecutor::new()),
            Arc::new(FileManagerExecutor::new()),
            Arc::new(AttachmentStageExecutor::new()),
            Arc::new(NotesImportExecutor::new()),
            Arc::new(SkillInstallExecutor::new()),
            Arc::new(SkillMarketReadToolExecutor::new()),
            Arc::new(SkillMarketInstallToolExecutor::new()),
            Arc::new(SkillWorkshopExecutor::new()),
            Arc::new(SkillLifecycleExecutor::new()),
            Arc::new(LocalShellPreflightExecutor::new()),
            Arc::new(GitToolExecutor::new()),
            Arc::new(SelfInspectExecutor::new()),
            Arc::new(RolePackExecutor::new()),
            Arc::new(RuntimeRootRequestExecutor::new()),
            Arc::new(LocalShellExecuteExecutor::new()),
            Arc::new(EssayGradingExecutor::new()),
            Arc::new(ReviewToolExecutor::new()),
            Arc::new(DocumentProcessingExecutor::new()),
            Arc::new(WorkbenchToolExecutor::new()),
            // —— coordinator 注册组（pipeline.rs workspace 分支）——
            Arc::new(WorkspaceToolExecutor::new(coordinator.clone())),
            Arc::new(SubagentExecutor::new(coordinator.clone())),
            Arc::new(CustomAgentExecutor::new(coordinator.clone())),
            Arc::new(CoordinatorSleepExecutor::new(coordinator)),
        ];

        let registry = Arc::new_cyclic(|weak: &std::sync::Weak<ToolExecutorRegistry>| {
            executors.push(Arc::new(ToolPackExecutor::new(weak.clone())));
            executors.push(Arc::new(PtcExecutor::new()));
            // GeneralToolExecutor 必须最后（catch-all）
            executors.push(Arc::new(GeneralToolExecutor::new()));
            ToolExecutorRegistry::from_vec(executors)
        });
        (temp, registry)
    }

    /// 与 pipeline.rs 注册顺序一致的 executor 名单快照。
    const EXPECTED_ROSTER: &[&str] = &[
        "AttemptCompletionExecutor",
        "CanvasToolExecutor",
        "ChatAnkiToolExecutor",
        "BuiltinRetrievalExecutor",
        "InsightRecallExecutor",
        "BuiltinResourceExecutor",
        "ConnectorToolExecutor",
        "TaskAuditExecutor",
        "DstuToolExecutor",
        "AttachmentToolExecutor",
        "FetchExecutor",
        "BrowserToolExecutor",
        "MediaToolExecutor",
        "OfficeFidelityExecutor",
        "McpProposeExecutor",
        "McpManageExecutor",
        "AutomationExecutor",
        "AcademicSearchExecutor",
        "PaperSaveExecutor",
        "KnowledgeExecutor",
        "TodoListExecutor",
        "GoalExecutor",
        "QBankExecutor",
        "TranslationToolExecutor",
        "SettingsModelsToolExecutor",
        "LlmUsageToolExecutor",
        "LearningOverviewExecutor",
        "DataGovernanceToolExecutor",
        "MemoryToolExecutor",
        "UserTodoExecutor",
        "SkillsExecutor",
        "TemplateDesignerExecutor",
        "TextbookPdfToolExecutor",
        "IndexWebpageToolExecutor",
        "AskUserExecutor",
        "SessionToolExecutor",
        "DocxToolExecutor",
        "PptxToolExecutor",
        "XlsxToolExecutor",
        "ImageGenerationExecutor",
        "GenerativeUiExecutor",
        "WorkspaceFsExecutor",
        "LspNavigationExecutor",
        "CodeNavigationExecutor",
        "FileManagerExecutor",
        "AttachmentStageExecutor",
        "NotesImportExecutor",
        "SkillInstallExecutor",
        "SkillMarketReadToolExecutor",
        "SkillMarketInstallToolExecutor",
        "SkillWorkshopExecutor",
        "SkillLifecycleExecutor",
        "LocalShellPreflightExecutor",
        "GitToolExecutor",
        "SelfInspectExecutor",
        "RolePackExecutor",
        "RuntimeRootRequestExecutor",
        "LocalShellExecuteExecutor",
        "EssayGradingExecutor",
        "ReviewToolExecutor",
        "DocumentProcessingExecutor",
        "WorkbenchToolExecutor",
        "WorkspaceToolExecutor",
        "SubagentExecutor",
        "CustomAgentExecutor",
        "CoordinatorSleepExecutor",
        "ToolPackExecutor",
        "PtcExecutor",
        "GeneralToolExecutor",
    ];

    /// 独立维护的安全清单并集（注册表外的第二信源，缺 descriptor 立即红灯）。
    ///
    /// headless 口径使用 headless.rs 保留的 `#[cfg(test)]` 手写清单 oracle
    /// （G01-e 后生产 `headless_allowed_tools()` 由注册表派生，不再独立）。
    fn independently_known_tool_names() -> HashSet<String> {
        let mut set = HashSet::new();
        for name in LEGACY_HEADLESS_ALLOWED_TOOLS {
            set.insert((*name).to_string());
        }
        for (name, _reason) in HEADLESS_BLOCKED_TOOLS {
            // `mcp_*` 是通配文档口径，不是具体工具名
            if !name.contains('*') {
                set.insert((*name).to_string());
            }
        }
        for name in PTC_ALLOWED_TOOLS {
            set.insert((*name).to_string());
        }
        for name in trusted_profile_supported_extra_tools() {
            set.insert(name.to_string());
        }
        set
    }

    #[test]
    fn table_is_wellformed() {
        assert!(!BUILTIN_DESCRIPTORS.is_empty());
        let mut seen = HashSet::new();
        for descriptor in BUILTIN_DESCRIPTORS {
            assert!(
                !descriptor.name.starts_with("builtin-"),
                "descriptor name must be bare: {}",
                descriptor.name
            );
            assert!(
                !descriptor.name.is_empty() && descriptor.name.trim() == descriptor.name,
                "descriptor name must be non-empty and trimmed: {:?}",
                descriptor.name
            );
            assert!(
                seen.insert(descriptor.name),
                "duplicate descriptor for tool: {}",
                descriptor.name
            );
        }
    }

    /// 方向一（多余 descriptor）：每条 descriptor 必须被某个**特异性** executor
    /// 受理（GeneralToolExecutor 兜底不算）。工具从 executor 移除后忘删
    /// descriptor 会立即红灯。
    #[test]
    fn every_descriptor_maps_to_a_specific_executor() {
        let (_temp, registry) = production_like_registry();
        assert_eq!(registry.len(), EXPECTED_ROSTER.len());
        for descriptor in BUILTIN_DESCRIPTORS {
            assert!(
                registry.has_specific_executor(descriptor.name),
                "no specific executor handles descriptor tool: {}",
                descriptor.name
            );
            assert!(
                registry.has_specific_executor(&format!("builtin-{}", descriptor.name)),
                "no specific executor handles builtin-{} ",
                descriptor.name
            );
        }
    }

    /// 方向二（缺失 descriptor）：独立安全清单里每个被特异性 executor 受理的
    /// 工具名必须在注册表恰有一条 descriptor。
    ///
    /// 已知边界：若某 executor 内部私有名单新增工具且未进任何安全清单，
    /// 本测试无法感知——新增 executor 应遵循 codebase 惯例暴露
    /// `pub mod tool_names` 并把工具加入相应白/黑名单（也会被本清单捕获）。
    #[test]
    fn independently_known_tools_all_have_descriptors() {
        let (_temp, registry) = production_like_registry();
        for name in independently_known_tool_names() {
            let stripped = name.strip_prefix("builtin-").unwrap_or(name.as_str());
            if !registry.has_specific_executor(stripped) {
                // 清单里的防御性条目（如 anki_generate_cards）无 executor 受理，
                // 无需 descriptor。
                continue;
            }
            assert!(
                lookup(stripped).is_some(),
                "tool '{name}' is handled by an executor and listed in a security list \
                 but has no ToolDescriptor (register it in BUILTIN_DESCRIPTORS)"
            );
        }
    }

    /// executor 花名册快照：镜像构造与 pipeline.rs 注册保持同序。
    /// 若 pipeline 新增 executor，需同步 production_like_registry 与本名单。
    #[test]
    fn executor_roster_matches_pipeline_registration() {
        let (_temp, registry) = production_like_registry();
        let names = registry.executor_names();
        assert_eq!(names, EXPECTED_ROSTER);
    }

    /// descriptor 的名字级敏感度必须与 executor 自报基线逐工具相等——
    /// 注册表不是第二套拍脑袋分级，而是现状的权威镜像。
    #[test]
    fn descriptor_sensitivity_matches_executor_baseline() {
        let (_temp, registry) = production_like_registry();
        for descriptor in BUILTIN_DESCRIPTORS {
            let actual = registry
                .get_sensitivity(descriptor.name)
                .unwrap_or_else(|| panic!("no executor for {}", descriptor.name));
            assert_eq!(
                actual, descriptor.sensitivity,
                "sensitivity drift for tool {}",
                descriptor.name
            );
        }
    }

    /// headless 标志位集合 == headless 手写白名单 oracle（裸名集合比较）。
    ///
    /// 对照口径：G01-e 后 `headless::headless_allowed_tools()` 本身由本标志位
    /// 派生（用它对照即成同义反复），因此这里对照 headless.rs 保留的
    /// `#[cfg(test)] LEGACY_HEADLESS_ALLOWED_TOOLS`——第二信源，任一侧漂移
    /// 都会红灯。
    #[test]
    fn headless_flag_matches_headless_whitelist() {
        let flagged: HashSet<&str> = BUILTIN_DESCRIPTORS
            .iter()
            .filter(|d| d.headless_allowed)
            .map(|d| d.name)
            .collect();
        let whitelisted: HashSet<String> = LEGACY_HEADLESS_ALLOWED_TOOLS
            .iter()
            .map(|name| {
                name.strip_prefix("builtin-")
                    .map(str::to_string)
                    .unwrap_or_else(|| (*name).to_string())
            })
            .collect();
        let flagged_strings: HashSet<String> = flagged.iter().map(|s| s.to_string()).collect();
        assert_eq!(flagged_strings, whitelisted);
    }

    /// headless 白名单收录原则之一：敏感度必须为 Low（无人审批下可自动执行）。
    #[test]
    fn headless_tools_are_low_sensitivity() {
        for descriptor in BUILTIN_DESCRIPTORS {
            if descriptor.headless_allowed {
                assert_eq!(
                    descriptor.sensitivity,
                    Low,
                    "headless-allowed tool {} must be Low sensitivity",
                    descriptor.name
                );
            }
        }
    }

    /// PTC 标志位集合 == PTC_ALLOWED_TOOLS（裸名集合比较）。
    #[test]
    fn ptc_flag_matches_ptc_whitelist() {
        let flagged: HashSet<&str> = BUILTIN_DESCRIPTORS
            .iter()
            .filter(|d| d.ptc_allowed)
            .map(|d| d.name)
            .collect();
        let whitelisted: HashSet<String> = PTC_ALLOWED_TOOLS
            .iter()
            .map(|name| {
                name.strip_prefix("builtin-")
                    .map(str::to_string)
                    .unwrap_or_else(|| (*name).to_string())
            })
            .collect();
        let flagged_strings: HashSet<String> = flagged.iter().map(|s| s.to_string()).collect();
        assert_eq!(flagged_strings, whitelisted);
    }

    /// PTC 收录原则：Low 敏感度。
    #[test]
    fn ptc_tools_are_low_sensitivity() {
        for descriptor in BUILTIN_DESCRIPTORS {
            if descriptor.ptc_allowed {
                assert_eq!(
                    descriptor.sensitivity,
                    Low,
                    "ptc-allowed tool {} must be Low sensitivity",
                    descriptor.name
                );
            }
        }
    }

    #[test]
    fn lookup_is_exact_bare_name_match() {
        assert!(lookup("rag_search").is_some());
        // 不剥前缀：前缀形式由调用方处理（见函数文档）
        assert!(lookup("builtin-rag_search").is_none());
        assert!(lookup("nonexistent_tool").is_none());
    }

    #[test]
    fn headless_and_ptc_queries_accept_both_name_forms() {
        assert!(is_headless_readonly("builtin-rag_search"));
        assert!(is_headless_readonly("rag_search"));
        assert!(is_headless_readonly("todo_init"));
        assert!(is_headless_readonly("builtin-attempt_completion"));
        assert!(!is_headless_readonly("builtin-local_shell_execute"));
        assert!(!is_headless_readonly("builtin-arxiv_search")); // headless 不收，PTC 收
        assert!(!is_headless_readonly("nonexistent"));

        assert!(is_ptc_allowed("builtin-rag_search"));
        assert!(is_ptc_allowed("arxiv_search"));
        assert!(!is_ptc_allowed("builtin-attempt_completion")); // PTC 有意排除元工具
        assert!(!is_ptc_allowed("builtin-todo_init"));
        assert!(!is_ptc_allowed("builtin-local_shell_execute"));
        assert!(!is_ptc_allowed("ptc_run")); // 自我排除防递归
        assert!(!is_ptc_allowed("nonexistent"));
    }

    #[test]
    fn grants_scope_hint_marks_shell_family() {
        assert_eq!(
            grants_scope_hint("builtin-local_shell_execute"),
            Some(GrantsScopeHint::Shell)
        );
        assert_eq!(
            grants_scope_hint("local_shell_preflight"),
            Some(GrantsScopeHint::Shell)
        );
        assert_eq!(
            grants_scope_hint("builtin-rag_search"),
            Some(GrantsScopeHint::Builtin)
        );
        assert_eq!(grants_scope_hint("mcp_brave_search"), None);
    }
}
