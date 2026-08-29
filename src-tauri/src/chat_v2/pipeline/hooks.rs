//! WI-13: Chat V2 流水线钩子（PipelineHook）。
//!
//! 把 `tool_loop.rs` 中横切的「审批准入」与「审计记录」抽为可插拔钩子：
//! - [`ApprovalGateHook`]：工具执行前的全部准入检查（Kill Switch、运行时
//!   allowlist、trusted automation 校验、功能开关、灾难命令守卫、用户命令
//!   规则、审批作用域绑定、AuthorityGate（Ask/Plan/Craft）、ApprovalManager
//!   人工审批、审批后重绑定复核与计划批准原子消费）。
//! - [`TaskAuditHook`]：回合/压缩边界的审计日志，以及工具执行后的审计标记
//!   （external MCP 安全边界注记 + trusted automation 预授权标记）。
//!
//! 两个钩子由 [`default_pipeline_hooks`] 默认注册，行为与迁移前的内联实现
//! 等价；额外钩子可通过 `ChatV2Pipeline::with_pipeline_hook` 追加。
//!
//! **顺序敏感：准入必须先于审计。** [`TaskAuditHook::after_tool`] 消费
//! [`ToolAdmission`] 中由 [`ApprovalGateHook::before_tool`] 写入的字段
//! （`authority_admission` / `is_external_mcp` /
//! `trusted_automation_preauthorized`）；若审计钩子先于准入钩子注册，
//! 这些字段将保持 fail-closed 的初始值（`None` / `false`），external MCP
//! 安全边界注记与 trusted automation 预授权标记会静默丢失。该顺序由测试
//! `default_hooks_keep_approval_gate_first` 锁定。

use super::*;

/// 单个工具调用在钩子链中的只读上下文。
pub struct ToolHookContext<'a> {
    pub tool_call: &'a ToolCall,
    pub block_id: &'a str,
    pub emitter: &'a Arc<ChatV2EventEmitter>,
    pub session_id: &'a str,
    pub message_id: &'a str,
    pub variant_id: Option<&'a str>,
    pub skill_state_version: Option<u64>,
    pub round_id: Option<&'a str>,
    pub skill_package_roots: &'a Option<std::collections::HashMap<String, String>>,
    pub execution_allowed_tools: &'a Option<Vec<String>>,
    pub cancellation_token: Option<&'a CancellationToken>,
    pub memory_enabled: bool,
    pub rag_enabled: bool,
    pub web_search_enabled: bool,
}

/// `before_tool` 产出的准入状态：由审批钩子填写，供执行上下文构建
/// （shell 守卫/权限档位注入）与 `after_tool` 审计钩子消费。
#[derive(Debug, Clone)]
pub struct ToolAdmission {
    // Security evidence is deliberately private. Appended hooks may inspect the
    // admission through hook behavior, but must not forge ApprovalGateHook's
    // decision before ExecutionContext is built.
    immutable_guard_asks: bool,
    approval_required: bool,
    approval_requirement_satisfied: bool,
    is_external_mcp: bool,
    trusted_automation_preauthorized: bool,
    /// 执行前复核通过的会话权限（authority_mode, permission_preset）。
    authority_admission: Option<(
        crate::chat_v2::types::AuthorityMode,
        crate::chat_v2::types::PermissionPreset,
    )>,
}

impl ToolAdmission {
    /// P8：曾经的只写字段 `approval_arguments` 已删除（全仓无读点）。
    /// `_arguments` 参数仅为保持 `tool_loop.rs` 调用点签名兼容而保留，
    /// 本函数不再持有工具参数的任何拷贝。
    pub(super) fn new(_arguments: &Value) -> Self {
        Self {
            immutable_guard_asks: false,
            approval_required: false,
            approval_requirement_satisfied: false,
            is_external_mcp: false,
            trusted_automation_preauthorized: false,
            authority_admission: None,
        }
    }

    pub(super) fn shell_guard_admitted(&self) -> bool {
        super::authority_mode::shell_guard_admitted(
            self.immutable_guard_asks,
            self.approval_required,
            self.approval_requirement_satisfied,
        )
    }

    pub(super) fn authority_admission(
        &self,
    ) -> Option<(
        crate::chat_v2::types::AuthorityMode,
        crate::chat_v2::types::PermissionPreset,
    )> {
        self.authority_admission
    }
}

/// `before_tool` 的裁决：继续执行，或以给定结果拦截本次调用。
pub enum ToolGateOutcome {
    Proceed,
    Block(Box<ToolResultInfo>),
}

/// Chat V2 流水线钩子。
///
/// 四个切点均为 `tool_loop.rs` 中的真实调用点，失败语义各不相同：
/// - `before_turn`：工具环每轮迭代开头、本轮 LLM 调用前。返回
///   [`ChatV2Result`]，`Err` 会中断整个回合（错误向上传播给调用方）。
/// - `before_tool`：单个工具执行前。**不走 `Result`**：拦截通过返回
///   [`ToolGateOutcome::Block`]（携带完整的失败 `ToolResultInfo` 回喂给
///   模型），`Proceed` 则放行并把准入证据写入 [`ToolAdmission`]。
/// - `after_tool`：executor 返回后、结果回喂前。**不可失败**（无返回值），
///   只能注记结果 / 打审计日志。
/// - `before_compaction`：环内 compaction 真正执行前。**不可失败**
///   （无返回值），只能观察 / 打日志，不能阻止 compaction。
#[async_trait::async_trait]
pub(crate) trait PipelineHook: Send + Sync {
    fn name(&self) -> &'static str;

    async fn before_turn(
        &self,
        _pipeline: &ChatV2Pipeline,
        _ctx: &PipelineContext,
        _recursion_depth: u32,
    ) -> ChatV2Result<()> {
        Ok(())
    }

    async fn before_tool(
        &self,
        _pipeline: &ChatV2Pipeline,
        _tool_ctx: &ToolHookContext<'_>,
        _admission: &mut ToolAdmission,
    ) -> ToolGateOutcome {
        ToolGateOutcome::Proceed
    }

    async fn after_tool(
        &self,
        _pipeline: &ChatV2Pipeline,
        _tool_ctx: &ToolHookContext<'_>,
        _admission: &ToolAdmission,
        _result: &mut ToolResultInfo,
    ) {
    }

    async fn before_compaction(
        &self,
        _pipeline: &ChatV2Pipeline,
        _ctx: &PipelineContext,
        _recursion_depth: u32,
    ) {
    }
}

/// 默认钩子集：审批准入 + 审计记录。
///
/// **顺序敏感：准入必须先于审计。** `TaskAuditHook::after_tool` 读取的
/// `authority_admission` / `is_external_mcp` / `trusted_automation_preauthorized`
/// 全部由 `ApprovalGateHook::before_tool` 在放行（`Proceed`）时写入；
/// `ApprovalGateHook` 必须保持链首位（测试
/// `default_hooks_keep_approval_gate_first` 锁定）。
pub(crate) fn default_pipeline_hooks() -> Arc<Vec<Arc<dyn PipelineHook>>> {
    Arc::new(vec![
        Arc::new(ApprovalGateHook) as Arc<dyn PipelineHook>,
        Arc::new(TaskAuditHook) as Arc<dyn PipelineHook>,
    ])
}

/// Resolve the backend-owned command guard only for the local shell executor.
///
/// Keeping this classification next to the default approval hook makes the
/// security boundary directly testable: an external MCP tool that happens to
/// accept a `command` argument must never be represented as locally guarded.
fn immutable_command_guard_for_tool_call(
    tool_call: &ToolCall,
) -> Option<crate::chat_v2::approval_scope::ShellCommandGuardDecision> {
    if !crate::chat_v2::approval_scope::is_local_shell_execute_tool(
        &tool_call.name,
        &tool_call.arguments,
    ) {
        return None;
    }

    // The pipeline checkpoint does not know the runtime cwd/roots yet (the
    // executor re-checks with full context before spawn), but HOME is always
    // protected and cheap to resolve here.
    let guard_roots: Vec<std::path::PathBuf> = dirs::home_dir().into_iter().collect();
    tool_call
        .arguments
        .get("command")
        .and_then(Value::as_str)
        .map(|command| {
            crate::chat_v2::approval_scope::immutable_shell_command_guard(
                command,
                None,
                &guard_roots,
            )
        })
}

/// 构造「执行前被拦截」的统一失败结果并发射 start/error 事件。
/// （原 `execute_single_tool` 内闭包 `build_preflight_blocked_result` 的自由函数版。）
pub(crate) fn preflight_blocked_result(
    tool_ctx: &ToolHookContext<'_>,
    error_message: String,
) -> ToolResultInfo {
    let tool_call = tool_ctx.tool_call;
    let display_arguments = crate::chat_v2::approval_scope::redact_tool_arguments_for_display(
        &tool_call.name,
        &tool_call.arguments,
    );
    let payload = json!({
        "toolName": tool_call.name,
        "toolInput": display_arguments.clone(),
        "toolCallId": tool_call.id,
    });
    tool_ctx.emitter.emit_start_with_meta(
        event_types::TOOL_CALL,
        tool_ctx.message_id,
        Some(tool_ctx.block_id),
        Some(payload),
        tool_ctx.variant_id,
        tool_ctx.skill_state_version,
        tool_ctx.round_id,
    );
    tool_ctx.emitter.emit_error_with_meta(
        event_types::TOOL_CALL,
        tool_ctx.block_id,
        &error_message,
        tool_ctx.variant_id,
        tool_ctx.skill_state_version,
        tool_ctx.round_id,
    );
    ToolResultInfo {
        tool_call_id: Some(tool_call.id.clone()),
        block_id: Some(tool_ctx.block_id.to_string()),
        tool_name: tool_call.name.clone(),
        input: display_arguments,
        output: json!(null),
        success: false,
        error: Some(error_message),
        duration_ms: None,
        reasoning_content: None,
        thought_signature: None,
    }
}

/// 内置钩子：审批/授权准入门（迁自 `execute_single_tool` 的内联前置检查）。
pub struct ApprovalGateHook;

#[async_trait::async_trait]
impl PipelineHook for ApprovalGateHook {
    fn name(&self) -> &'static str {
        "approval_gate"
    }

    async fn before_tool(
        &self,
        pipeline: &ChatV2Pipeline,
        tool_ctx: &ToolHookContext<'_>,
        admission: &mut ToolAdmission,
    ) -> ToolGateOutcome {
        let tool_call = tool_ctx.tool_call;
        let block_id = tool_ctx.block_id;
        let emitter = tool_ctx.emitter;
        let session_id = tool_ctx.session_id;
        let message_id = tool_ctx.message_id;
        let variant_id = tool_ctx.variant_id;
        let skill_state_version = tool_ctx.skill_state_version;
        let round_id = tool_ctx.round_id;
        let skill_package_roots = tool_ctx.skill_package_roots;
        let execution_allowed_tools = tool_ctx.execution_allowed_tools;
        let cancellation_token = tool_ctx.cancellation_token;
        let memory_enabled = tool_ctx.memory_enabled;
        let rag_enabled = tool_ctx.rag_enabled;
        let web_search_enabled = tool_ctx.web_search_enabled;

        let build_preflight_blocked_result =
            |error_message: String| Box::new(preflight_blocked_result(tool_ctx, error_message));

        // Kill Switch first: blocks every new tool execution regardless of Ask/Plan/Craft.
        if let Some(kill_switch) = &pipeline.kill_switch {
            if let Err(message) = kill_switch.ensure_allowed() {
                log::warn!(
                    "[ChatV2::pipeline] KillSwitch blocked tool '{}' before authority/approval",
                    tool_call.name
                );
                let display_arguments =
                    crate::chat_v2::approval_scope::redact_tool_arguments_for_display(
                        &tool_call.name,
                        &tool_call.arguments,
                    );
                let payload = json!({
                    "toolName": tool_call.name,
                    "toolInput": display_arguments.clone(),
                    "toolCallId": tool_call.id,
                    "killSwitchBlocked": true,
                });
                emitter.emit_start_with_meta(
                    event_types::TOOL_CALL,
                    message_id,
                    Some(block_id),
                    Some(payload),
                    variant_id,
                    skill_state_version,
                    round_id,
                );
                emitter.emit_error_with_meta(
                    event_types::TOOL_CALL,
                    block_id,
                    &message,
                    variant_id,
                    skill_state_version,
                    round_id,
                );
                return ToolGateOutcome::Block(Box::new(ToolResultInfo {
                    tool_call_id: Some(tool_call.id.clone()),
                    block_id: Some(block_id.to_string()),
                    tool_name: tool_call.name.clone(),
                    input: display_arguments,
                    output: json!({
                        "killSwitchBlocked": true,
                        "message": message,
                    }),
                    success: false,
                    error: Some(message),
                    duration_ms: None,
                    reasoning_content: None,
                    thought_signature: None,
                }));
            }
        }

        // Feature flag checks (memory, RAG, web search)
        let short_name = ChatV2Pipeline::canonical_tool_short_name(&tool_call.name);

        if !crate::chat_v2::tool_policy::is_tool_allowed_by_execution_policy(
            &tool_call.name,
            &tool_call.arguments,
            execution_allowed_tools,
        ) {
            let allowed_count = execution_allowed_tools
                .as_ref()
                .map(|tools| tools.len())
                .unwrap_or(0);
            log::warn!(
                "[ChatV2::pipeline] Tool blocked by runtime execution allowlist: tool={}, allowed_count={}",
                tool_call.name,
                allowed_count
            );
            return ToolGateOutcome::Block(build_preflight_blocked_result(format!(
                "当前运行时未允许调用工具 '{}'，工具调用已被后端拦截",
                tool_call.name
            )));
        }
        if let Err(error) = crate::chat_v2::headless::validate_trusted_automation_tool_call(
            session_id,
            &tool_call.name,
            &tool_call.arguments,
        ) {
            log::warn!(
                "[ChatV2::pipeline] Trusted automation profile blocked tool '{}': {}",
                tool_call.name,
                error
            );
            return ToolGateOutcome::Block(build_preflight_blocked_result(error));
        }

        let is_memory_tool = short_name.starts_with("memory_");
        // 🔧 P0-2：rag_enabled 开关必须覆盖所有知识库检索工具。
        // unified_search / multimodal_search 与 rag_search 同走 VFS 检索管线，
        // 仅匹配 "rag_" 前缀会导致用户关闭 RAG 后仍可通过前两者检索知识库。
        // web_search 不受 rag_enabled 控制，由 web_search_enabled 单独把关。
        let is_rag_tool = short_name.starts_with("rag_")
            || matches!(short_name, "unified_search" | "multimodal_search");
        let is_web_search_tool = short_name == "web_search";

        if is_memory_tool && !memory_enabled {
            return ToolGateOutcome::Block(build_preflight_blocked_result(
                "memory 功能已关闭，工具调用被拦截".to_string(),
            ));
        }
        if is_rag_tool && !rag_enabled {
            return ToolGateOutcome::Block(build_preflight_blocked_result(
                "RAG 功能已关闭，工具调用被拦截".to_string(),
            ));
        }
        if is_web_search_tool && !web_search_enabled {
            return ToolGateOutcome::Block(build_preflight_blocked_result(
                "WebSearch 功能已关闭，工具调用被拦截".to_string(),
            ));
        }

        let is_local_shell = crate::chat_v2::approval_scope::is_local_shell_execute_tool(
            &tool_call.name,
            &tool_call.arguments,
        );
        let is_external_mcp = crate::chat_v2::tool_approval_policy::is_external_mcp_call(
            &tool_call.name,
            &tool_call.arguments,
        );
        // The immutable catastrophe guard applies to the backend-owned local
        // shell before user rules or any preset bypass. External MCP execution
        // is remote/uncontrolled and is explicitly not claimed to be protected
        // by this local command parser.
        let immutable_command_guard = immutable_command_guard_for_tool_call(tool_call);
        if immutable_command_guard.as_ref().is_some_and(|decision| {
            decision.effect == crate::chat_v2::approval_scope::ShellCommandGuardEffect::Deny
        }) {
            return ToolGateOutcome::Block(build_preflight_blocked_result(
                "终端命令被不可覆盖的灾难命令守卫拒绝".to_string(),
            ));
        }

        // User command-list denies apply before remembered approval. Its Allow
        // remains advisory and cannot override the immutable guard above.
        let shell_command_decision =
            if crate::chat_v2::approval_scope::is_shell_runtime_tool_for_args(
                &tool_call.name,
                &tool_call.arguments,
            ) {
                tool_call
                    .arguments
                    .get("command")
                    .and_then(Value::as_str)
                    .map(|command| {
                        let raw_policy = pipeline.main_db.as_ref().and_then(|db| {
                            db.get_setting(crate::chat_v2::shell_command_policy::SETTING_KEY)
                                .ok()
                                .flatten()
                        });
                        crate::chat_v2::shell_command_policy::enforce_for_call(
                            raw_policy.as_deref(),
                            command,
                            is_local_shell,
                        )
                    })
            } else {
                None
            };
        if shell_command_decision.as_ref().is_some_and(|decision| {
            decision.effective_effect == crate::chat_v2::shell_command_policy::ShellRuleEffect::Deny
        }) {
            return ToolGateOutcome::Block(build_preflight_blocked_result(
                "终端命令被用户配置的拒绝规则拦截".to_string(),
            ));
        }

        // Shell approval is bound to backend-resolved filesystem authority,
        // never to model-supplied root labels. The original ToolCall remains
        // untouched and is the only value passed to the executor.
        let approval_arguments = match pipeline.resolve_local_shell_approval_arguments(
            tool_call,
            emitter,
            session_id,
            skill_package_roots.as_ref(),
        ) {
            Ok(Some(arguments)) => arguments,
            Ok(None) => tool_call.arguments.clone(),
            Err(error) => {
                return ToolGateOutcome::Block(build_preflight_blocked_result(format!(
                    "无法绑定本地终端审批作用域: {error}"
                )))
            }
        };
        let expected_runtime_binding =
            crate::chat_v2::approval_scope::runtime_root_binding_from_args(&approval_arguments)
                .map(str::to_string);
        let expected_runtime_scope_key = expected_runtime_binding.as_ref().map(|_| {
            crate::chat_v2::approval_scope::make_runtime_scope_key(
                &tool_call.name,
                &approval_arguments,
            )
        });

        // 🆕 文档 29 P1-3：检查工具敏感等级，决定是否需要用户审批
        let sensitivity = pipeline
            .executor_registry
            .get_sensitivity_for_call(&tool_call.name, &tool_call.arguments);

        // Resolve source-qualified tool, legacy tool, source, domain, and global
        // rules in one place. Precise runtime-authority approvals remain locked.
        let mut effective_sensitivity = if let Some(ref db) = pipeline.main_db {
            crate::chat_v2::tool_approval_policy::resolve_effective_sensitivity(
                sensitivity,
                &tool_call.name,
                &tool_call.arguments,
                |key| db.get_setting(key).ok().flatten(),
            )
        } else {
            sensitivity
        };
        if let Some(decision) = shell_command_decision.as_ref() {
            effective_sensitivity = crate::chat_v2::shell_command_policy::apply_to_sensitivity(
                decision,
                effective_sensitivity,
            );
        }

        // AuthorityGate (Ask / Plan / Craft): after sensitivity, before ApprovalManager.
        let plan_binding_key = super::authority_mode::plan_call_binding_key(
            &tool_call.name,
            &approval_arguments,
            round_id,
        );
        let authority_state =
            match ChatV2Repo::get_session_authority_state(&pipeline.db, session_id) {
                Ok(state) => state,
                Err(err) => {
                    log::error!(
                    "[ChatV2::pipeline] Failed to load authority mode for {}: {}; refusing tool",
                    session_id,
                    err
                );
                    return ToolGateOutcome::Block(build_preflight_blocked_result(
                        "无法读取会话权限状态，已安全阻止工具执行".to_string(),
                    ));
                }
            };
        let authority_decision = super::authority_mode::evaluate_authority_gate(
            &authority_state,
            &tool_call.name,
            effective_sensitivity,
            Some(&plan_binding_key),
            chrono::Utc::now(),
        );
        let mut plan_gate_just_approved = false;
        match authority_decision {
            super::authority_mode::AuthorityGateDecision::Allow => {}
            super::authority_mode::AuthorityGateDecision::BlockAsk { message, tool_name } => {
                log::info!(
                    "[ChatV2::pipeline] AuthorityGate Ask blocked write tool '{}'",
                    tool_name
                );
                let display_arguments =
                    crate::chat_v2::approval_scope::redact_tool_arguments_for_display(
                        &tool_call.name,
                        &tool_call.arguments,
                    );
                let payload = json!({
                    "toolName": tool_call.name,
                    "toolInput": display_arguments.clone(),
                    "toolCallId": tool_call.id,
                    "authorityBlocked": true,
                    "authorityMode": "ask",
                    "suggestedMode": "plan",
                });
                emitter.emit_start_with_meta(
                    event_types::TOOL_CALL,
                    message_id,
                    Some(block_id),
                    Some(payload),
                    variant_id,
                    skill_state_version,
                    round_id,
                );
                emitter.emit_error_with_meta(
                    event_types::TOOL_CALL,
                    block_id,
                    &message,
                    variant_id,
                    skill_state_version,
                    round_id,
                );
                return ToolGateOutcome::Block(Box::new(ToolResultInfo {
                    tool_call_id: Some(tool_call.id.clone()),
                    block_id: Some(block_id.to_string()),
                    tool_name: tool_call.name.clone(),
                    input: display_arguments,
                    output: super::authority_mode::ask_block_structured_output(&tool_name),
                    success: false,
                    error: Some(message),
                    duration_ms: None,
                    reasoning_content: None,
                    thought_signature: None,
                }));
            }
            super::authority_mode::AuthorityGateDecision::WaitPlanGate { summary } => {
                let plan_outcome = pipeline
                    .request_plan_gate(
                        tool_call,
                        &approval_arguments,
                        &summary,
                        emitter,
                        session_id,
                        message_id,
                        cancellation_token,
                        &plan_binding_key,
                        round_id,
                    )
                    .await;
                match plan_outcome {
                    ApprovalOutcome::Approved => {
                        // Plan batch approved for this binding — skip secondary TOOL_APPROVAL
                        // for the same binding (privilege escalation still asks below).
                        plan_gate_just_approved = true;
                    }
                    ApprovalOutcome::Rejected { reason } => {
                        let message = match reason {
                            Some(user_reason) => {
                                format!("用户拒绝了计划执行。用户说明：{}", user_reason)
                            }
                            None => "用户拒绝了计划执行".to_string(),
                        };
                        return ToolGateOutcome::Block(build_preflight_blocked_result(message));
                    }
                    ApprovalOutcome::Timeout => {
                        return ToolGateOutcome::Block(build_preflight_blocked_result(
                            "计划确认等待超时，请重试".to_string(),
                        ));
                    }
                    ApprovalOutcome::ChannelClosed => {
                        return ToolGateOutcome::Block(build_preflight_blocked_result(
                            "计划确认通道异常关闭，请重试".to_string(),
                        ));
                    }
                    ApprovalOutcome::Cancelled => {
                        return ToolGateOutcome::Block(build_preflight_blocked_result(
                            "流已取消，计划确认中止".to_string(),
                        ));
                    }
                }
            }
        }

        let immutable_guard_asks = immutable_command_guard.as_ref().is_some_and(|decision| {
            decision.effect == crate::chat_v2::approval_scope::ShellCommandGuardEffect::Ask
        });
        let privilege_escalation =
            crate::chat_v2::approval_scope::is_privilege_escalation_tool_for_args(
                &tool_call.name,
                &tool_call.arguments,
            );
        let plan_binding_covers_tool_approval =
            super::authority_mode::plan_binding_satisfies_tool_approval(
                &authority_state,
                &plan_binding_key,
                privilege_escalation,
                plan_gate_just_approved,
                chrono::Utc::now(),
            );
        let approval_required = if plan_binding_covers_tool_approval {
            false
        } else {
            super::authority_mode::requires_tool_approval(
                &authority_state,
                sensitivity,
                effective_sensitivity,
                immutable_guard_asks,
                is_external_mcp,
                privilege_escalation,
            )
        };
        if privilege_escalation
            && approval_required
            && authority_state.authority_mode == crate::chat_v2::types::AuthorityMode::Craft
            && matches!(
                authority_state.permission_preset,
                crate::chat_v2::types::PermissionPreset::FullAccess
                    | crate::chat_v2::types::PermissionPreset::DangerFullAccess
            )
        {
            log::info!(
                "[ChatV2::audit] privilege_escalation=true approval_forced=true permission_preset={} session={} tool_call_id={} tool={}",
                authority_state.permission_preset.as_str(),
                session_id,
                tool_call.id,
                tool_call.name
            );
        }
        let mut approval_requirement_satisfied = false;

        // trusted automation: begin —— 预授权旁路（无人值守定时任务）。
        // 安全判定全部集中在 headless::is_trusted_automation_preauthorized：仅当
        // 会话安装了 TrustedAutomationSessionGuard（headless runner 显式安装的
        // pinned profile），且本次调用以【原始参数】重新通过 profile 全部校验
        // （工具白名单、root 读写、shell 前缀/操作符、网络域、输出预算、回滚
        // 证据）时才返回 true；任何校验不满足或异常一律 false → 走下方原有
        // ApprovalManager 人工审批路径（fail-closed）。普通交互会话无 profile，
        // 恒为 false，此段对非自动化路径零行为变化。
        let trusted_automation_preauthorized = !immutable_guard_asks
            && crate::chat_v2::headless::is_trusted_automation_preauthorized(
                session_id,
                &tool_call.name,
                &tool_call.arguments,
            );
        if trusted_automation_preauthorized && approval_required {
            approval_requirement_satisfied = true;
            log::info!(
                "[ChatV2::pipeline] trusted_automation_preauthorized: skipping ApprovalManager for tool '{}' (session={}, tool_call_id={}, sensitivity={:?})",
                tool_call.name,
                session_id,
                tool_call.id,
                effective_sensitivity
            );
        }
        // trusted automation: end（下一行条件中的 !trusted_automation_preauthorized
        // 是本次改造对既有审批判定的唯一侵入点）
        if approval_required && !trusted_automation_preauthorized {
            let Some(approval_manager) = &pipeline.approval_manager else {
                log::error!(
                    "[ChatV2::pipeline] Refusing {:?} tool '{}' because ApprovalManager is unavailable",
                    effective_sensitivity,
                    tool_call.name
                );
                return ToolGateOutcome::Block(build_preflight_blocked_result(
                    "审批服务不可用，已阻止中高风险工具执行".to_string(),
                ));
            };
            // 🔧 F8/F9 修复说明：session_id 必须是真实会话 ID（多变体路径不再传
            // "{session}:{variant}" 复合键）。前端审批响应携带真实 session_id，
            // ApprovalManager 按 (session_id, tool_call_id) 精确匹配 pending 项，
            // 若此处键不一致，用户点击"允许"将永远匹配不到等待者（approval_expired），
            // 工具只能等到超时被拒。

            // 🔧 P1-51 + M-081 修复：优先查询数据库持久化设置
            // 统一入口 `approval_scope::make_setting_key`（v2 优先，未知工具 fallback v1）
            // 同时读取旧版 v1 键作为向后兼容（如果 v2 未命中）
            // ADR-B2：权限类工具跳过一切 remember 路径（不可绕过人工审批）。
            let irreversible = crate::chat_v2::approval_scope::never_remember_approval_for_args(
                &tool_call.name,
                &approval_arguments,
            );
            let can_use_session_remember = !immutable_guard_asks
                && authority_state.authority_mode == crate::chat_v2::types::AuthorityMode::Craft
                && authority_state.permission_preset
                    == crate::chat_v2::types::PermissionPreset::Relaxed
                && sensitivity == Some(ToolSensitivity::Medium)
                && effective_sensitivity == Some(ToolSensitivity::Medium)
                && !irreversible;

            // Presets are session-only. Persistent/global remembers are
            // deliberately ignored; Craft/relaxed may reuse only Medium approvals.
            let remembered = can_use_session_remember
                .then(|| {
                    approval_manager.check_session_remembered(
                        session_id,
                        &tool_call.name,
                        &approval_arguments,
                    )
                })
                .flatten();

            if let Some(is_allowed) = remembered {
                log::info!(
                    "[ChatV2::pipeline] Tool {} approval remembered: {} (persisted={})",
                    tool_call.name,
                    is_allowed,
                    false
                );
                if !is_allowed {
                    // 用户之前选择了"始终拒绝"
                    return ToolGateOutcome::Block(build_preflight_blocked_result(
                        "用户已拒绝此工具执行".to_string(),
                    ));
                }
                // 用户之前选择了"始终允许"，继续执行
                approval_requirement_satisfied = true;
            } else {
                // 需要请求用户审批
                let actual_sensitivity = if immutable_guard_asks
                    || sensitivity == Some(ToolSensitivity::High)
                    || effective_sensitivity == Some(ToolSensitivity::High)
                {
                    ToolSensitivity::High
                } else {
                    effective_sensitivity
                        .or(sensitivity)
                        .unwrap_or(ToolSensitivity::Medium)
                };
                let approval_preset = if authority_state.authority_mode
                    == crate::chat_v2::types::AuthorityMode::Craft
                {
                    authority_state.permission_preset
                } else {
                    // Presets are Craft-only. Plan approvals remain
                    // single-use and cannot seed a later Craft remember.
                    crate::chat_v2::types::PermissionPreset::Cautious
                };
                let approval_outcome = pipeline
                    .request_tool_approval(
                        tool_call,
                        &approval_arguments,
                        emitter,
                        session_id,
                        message_id,
                        block_id,
                        &actual_sensitivity,
                        approval_preset,
                        approval_manager,
                        cancellation_token,
                    )
                    .await;

                match approval_outcome {
                    ApprovalOutcome::Approved => {
                        // 用户同意，继续执行
                        approval_requirement_satisfied = true;
                    }
                    ApprovalOutcome::Rejected { reason } => {
                        let message = match reason {
                            Some(user_reason) => {
                                format!("用户拒绝执行此工具。用户说明：{}", user_reason)
                            }
                            None => "用户拒绝执行此工具".to_string(),
                        };
                        return ToolGateOutcome::Block(build_preflight_blocked_result(message));
                    }
                    ApprovalOutcome::Timeout => {
                        return ToolGateOutcome::Block(build_preflight_blocked_result(
                            "工具审批等待超时，请重试".to_string(),
                        ));
                    }
                    ApprovalOutcome::ChannelClosed => {
                        return ToolGateOutcome::Block(build_preflight_blocked_result(
                            "工具审批通道异常关闭，请重试".to_string(),
                        ));
                    }
                    ApprovalOutcome::Cancelled => {
                        return ToolGateOutcome::Block(build_preflight_blocked_result(
                            "流已取消，工具审批中止".to_string(),
                        ));
                    }
                }
            }
        }
        if let Some(expected_binding) = expected_runtime_binding.as_deref() {
            let rebound = match pipeline.resolve_local_shell_approval_arguments(
                tool_call,
                emitter,
                session_id,
                skill_package_roots.as_ref(),
            ) {
                Ok(Some(arguments)) => arguments,
                Ok(None) => {
                    return ToolGateOutcome::Block(build_preflight_blocked_result(
                        "本地终端审批绑定在执行前丢失".to_string(),
                    ))
                }
                Err(error) => {
                    return ToolGateOutcome::Block(build_preflight_blocked_result(format!(
                        "本地终端运行时作用域在审批后发生变化: {error}"
                    )))
                }
            };
            let current_binding =
                crate::chat_v2::approval_scope::runtime_root_binding_from_args(&rebound);
            let current_scope_key =
                crate::chat_v2::approval_scope::make_runtime_scope_key(&tool_call.name, &rebound);
            if current_binding != Some(expected_binding)
                || expected_runtime_scope_key.as_deref() != Some(current_scope_key.as_str())
            {
                log::warn!(
                    "[ChatV2::pipeline] Runtime-root approval binding changed before shell exec: tool_call_id={}",
                    tool_call.id
                );
                return ToolGateOutcome::Block(build_preflight_blocked_result(
                    "本地终端运行时目录、访问权限、环境或可读范围在审批后发生变化，请重新审批"
                        .to_string(),
                ));
            }
        }

        // Re-check all revocable authority immediately before the executor. The
        // preceding plan/tool approvals can wait for user input, during which an
        // emergency stop or mode change must take effect.
        if let Some(kill_switch) = &pipeline.kill_switch {
            if let Err(message) = kill_switch.ensure_allowed() {
                return ToolGateOutcome::Block(build_preflight_blocked_result(message));
            }
        }
        if cancellation_token.is_some_and(|token| token.is_cancelled()) {
            return ToolGateOutcome::Block(build_preflight_blocked_result(
                "流已取消，工具执行中止".to_string(),
            ));
        }
        let current_authority =
            match ChatV2Repo::get_session_authority_state(&pipeline.db, session_id) {
                Ok(state) => state,
                Err(error) => {
                    log::error!(
                        "[ChatV2::pipeline] Authority re-check failed for {}: {}",
                        session_id,
                        error
                    );
                    return ToolGateOutcome::Block(build_preflight_blocked_result(
                        "执行前无法复核会话权限，已安全阻止工具执行".to_string(),
                    ));
                }
            };
        // An approved Plan binding replaces the secondary tool approval for
        // this exact call. Re-evaluate that evidence together with the current
        // authority state; checking `requires_tool_approval` alone would reject
        // every valid Plan call before its binding can be atomically consumed.
        let current_plan_binding_covers_tool_approval =
            super::authority_mode::plan_binding_satisfies_tool_approval(
                &current_authority,
                &plan_binding_key,
                privilege_escalation,
                plan_gate_just_approved,
                chrono::Utc::now(),
            );
        let current_approval_required = !current_plan_binding_covers_tool_approval
            && super::authority_mode::requires_tool_approval(
                &current_authority,
                sensitivity,
                effective_sensitivity,
                immutable_guard_asks,
                is_external_mcp,
                privilege_escalation,
            );
        if current_approval_required && !approval_requirement_satisfied {
            return ToolGateOutcome::Block(build_preflight_blocked_result(
                "会话审批策略在执行前发生变化，当前调用需要重新审批".to_string(),
            ));
        }
        match super::authority_mode::evaluate_authority_gate(
            &current_authority,
            &tool_call.name,
            effective_sensitivity,
            Some(&plan_binding_key),
            chrono::Utc::now(),
        ) {
            super::authority_mode::AuthorityGateDecision::Allow => {
                if current_authority.authority_mode == crate::chat_v2::types::AuthorityMode::Plan {
                    match ChatV2Repo::consume_session_plan_binding(
                        &pipeline.db,
                        session_id,
                        &plan_binding_key,
                        chrono::Utc::now(),
                    ) {
                        Ok(true) => {}
                        Ok(false) => {
                            return ToolGateOutcome::Block(build_preflight_blocked_result(
                                "计划批准已被消费或与当前调用不匹配，请重新确认".to_string(),
                            ));
                        }
                        Err(error) => {
                            log::error!(
                                "[ChatV2::pipeline] Failed to consume plan approval: {}",
                                error
                            );
                            return ToolGateOutcome::Block(build_preflight_blocked_result(
                                "无法原子消费计划批准，已安全阻止工具执行".to_string(),
                            ));
                        }
                    }
                }
            }
            super::authority_mode::AuthorityGateDecision::BlockAsk { message, .. } => {
                return ToolGateOutcome::Block(build_preflight_blocked_result(message));
            }
            super::authority_mode::AuthorityGateDecision::WaitPlanGate { .. } => {
                return ToolGateOutcome::Block(build_preflight_blocked_result(
                    "计划批准已过期或与当前工具调用不匹配，请重新确认".to_string(),
                ));
            }
        }

        admission.immutable_guard_asks = immutable_guard_asks;
        admission.approval_required = approval_required;
        admission.approval_requirement_satisfied = approval_requirement_satisfied;
        admission.is_external_mcp = is_external_mcp;
        admission.trusted_automation_preauthorized = trusted_automation_preauthorized;
        admission.authority_admission = Some((
            current_authority.authority_mode,
            current_authority.permission_preset,
        ));
        ToolGateOutcome::Proceed
    }
}

/// 内置钩子：任务审计记录（回合/压缩边界日志 + 执行后审计标记）。
pub struct TaskAuditHook;

#[async_trait::async_trait]
impl PipelineHook for TaskAuditHook {
    fn name(&self) -> &'static str {
        "task_audit"
    }

    async fn before_turn(
        &self,
        _pipeline: &ChatV2Pipeline,
        ctx: &PipelineContext,
        recursion_depth: u32,
    ) -> ChatV2Result<()> {
        log::debug!(
            "[ChatV2::audit] turn_start session={} depth={} accumulated_tool_results={}",
            ctx.session_id,
            recursion_depth,
            ctx.tool_results.len()
        );
        Ok(())
    }

    async fn after_tool(
        &self,
        _pipeline: &ChatV2Pipeline,
        tool_ctx: &ToolHookContext<'_>,
        admission: &ToolAdmission,
        result: &mut ToolResultInfo,
    ) {
        let tool_call = tool_ctx.tool_call;
        let session_id = tool_ctx.session_id;
        if let Some((authority_mode, permission_preset)) = admission.authority_admission {
            if admission.is_external_mcp
                && authority_mode == crate::chat_v2::types::AuthorityMode::Craft
                && matches!(
                    permission_preset,
                    crate::chat_v2::types::PermissionPreset::FullAccess
                        | crate::chat_v2::types::PermissionPreset::DangerFullAccess
                )
            {
                // Audit contract: remote MCP implementations are outside
                // the local shell sandbox, runtime-root enforcement and
                // immutable command-guard guarantee.
                log::info!(
                    "[ChatV2::audit] external_mcp=true approval_bypassed=true permission_preset={} local_shell_sandbox_guaranteed=false runtime_roots_guaranteed=false command_guard_guaranteed=false session={} tool_call_id={} tool={} success={}",
                    permission_preset.as_str(),
                    session_id,
                    tool_call.id,
                    tool_call.name,
                    result.success
                );
                if let Some(output) = result.output.as_object_mut() {
                    output.insert(
                        "external_mcp_security_boundary".to_string(),
                        json!({
                            "approval_bypassed": true,
                            "permission_preset": permission_preset.as_str(),
                            "local_shell_sandbox_guaranteed": false,
                            "runtime_roots_guaranteed": false,
                            "command_guard_guaranteed": false,
                        }),
                    );
                }
            }
        }
        // trusted automation: begin —— 预授权执行的可审计标记。
        // 仅当本次调用经 trusted profile 预授权跳过了人工审批时，在持久化的
        // 工具输出（JSON 对象时）补写 trusted_automation_preauthorized=true，
        // 供事后审计区分"用户点了允许"与"profile 预授权放行"。
        if admission.trusted_automation_preauthorized {
            if let Some(output) = result.output.as_object_mut() {
                output
                    .entry("trusted_automation_preauthorized".to_string())
                    .or_insert(json!(true));
            }
            log::info!(
                "[ChatV2::pipeline] tool '{}' executed under trusted_automation_preauthorized (session={}, tool_call_id={}, success={})",
                tool_call.name,
                session_id,
                tool_call.id,
                result.success
            );
        }
        // trusted automation: end
    }

    async fn before_compaction(
        &self,
        _pipeline: &ChatV2Pipeline,
        ctx: &PipelineContext,
        recursion_depth: u32,
    ) {
        log::info!(
            "[ChatV2::audit] in_loop_compaction_start session={} depth={} history_len={}",
            ctx.session_id,
            recursion_depth,
            ctx.chat_history.len()
        );
    }
}

/// 敏感度非 Low（或未知）时，缺失 ApprovalManager 必须 fail-closed。
/// （迁自 tool_loop.rs；语义规格由下方测试锁定。）
fn approval_manager_required(sensitivity: Option<ToolSensitivity>) -> bool {
    sensitivity != Some(ToolSensitivity::Low)
}

/// 带超时地等待一个 oneshot 响应，并可选地同时监听流取消信号。
///
/// 返回值三层语义（与调用点的分支一一对应）：
/// - `None`：流被取消（cancellation token 触发），等待被放弃；
/// - `Some(Err(_))`：等待超时；
/// - `Some(Ok(..))`：在超时前收到了 oneshot 结果（含通道关闭错误）。
///
/// 🔧 F7 修复的共享实现：`request_tool_approval` 与 `request_plan_gate`
/// 两处等待逻辑完全同构，收敛于此；等待之后的
/// Approved / Rejected / Timeout / Cancelled 业务分支仍留在各自调用点。
async fn wait_oneshot_with_optional_cancel<F: std::future::Future>(
    rx: F,
    timeout_duration: std::time::Duration,
    cancellation_token: Option<&CancellationToken>,
) -> Option<Result<F::Output, tokio::time::error::Elapsed>> {
    if let Some(cancel_token) = cancellation_token {
        tokio::select! {
            result = tokio::time::timeout(timeout_duration, rx) => Some(result),
            _ = cancel_token.cancelled() => None,
        }
    } else {
        Some(tokio::time::timeout(timeout_duration, rx).await)
    }
}

impl ChatV2Pipeline {
    /// 🆕 2026-07: 保守判断工具是否可能进入审批流程
    ///
    /// 与 `execute_single_tool` 内的 effective_sensitivity 逻辑共用同一个解析器：
    /// - 最终敏感度非 Low（或无执行器）→ 可能审批 → 串行；
    /// - 来源、能力域或单工具规则把 Low 升级后，也会自动转为串行。
    pub(crate) fn tool_may_require_approval(&self, tool_name: &str, arguments: &Value) -> bool {
        let base_sensitivity = self
            .executor_registry
            .get_sensitivity_for_call(tool_name, arguments);
        let effective_sensitivity = if let Some(ref db) = self.main_db {
            crate::chat_v2::tool_approval_policy::resolve_effective_sensitivity(
                base_sensitivity,
                tool_name,
                arguments,
                |key| db.get_setting(key).ok().flatten(),
            )
        } else {
            base_sensitivity
        };
        effective_sensitivity != Some(ToolSensitivity::Low)
    }
    fn resolve_local_shell_approval_arguments(
        &self,
        tool_call: &ToolCall,
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        skill_package_roots: Option<&std::collections::HashMap<String, String>>,
    ) -> Result<Option<Value>, String> {
        if !crate::chat_v2::approval_scope::is_local_shell_execute_tool(
            &tool_call.name,
            &tool_call.arguments,
        ) {
            return Ok(None);
        }

        use serde_json::json;
        use tauri::Manager;

        let window = emitter.window();
        let state = window.state::<crate::commands::AppState>();
        // Inject group preferred root into approval args (not ToolCall) before
        // binding/scope so approval sees the same root execute will resolve.
        let explicit =
            crate::chat_v2::runtime_roots::explicit_runtime_root_id_from_args(&tool_call.arguments);
        let effective_root_id =
            crate::chat_v2::runtime_roots::resolve_effective_runtime_root_id_for_session(
                window.app_handle(),
                &state.database,
                Some(self.db.as_ref()),
                session_id,
                skill_package_roots,
                explicit.as_deref(),
            );
        let mut approval_args = tool_call.arguments.clone();
        if explicit.is_none() {
            if let Some(object) = approval_args.as_object_mut() {
                object.insert("root_id".to_string(), json!(effective_root_id));
            }
        }
        let (root_id, cwd) =
            crate::chat_v2::approval_scope::normalized_shell_runtime_location(&approval_args);
        let support_readable_roots =
            LocalShellExecuteExecutor::runtime_support_read_roots(&approval_args)?;
        let binding = crate::chat_v2::runtime_roots::shell_runtime_approval_binding(
            window.app_handle(),
            &state.database,
            session_id,
            skill_package_roots,
            Some(&root_id),
            Some(&cwd),
            &support_readable_roots,
        )?;
        let scoped = crate::chat_v2::approval_scope::attach_runtime_root_approval_binding(
            &approval_args,
            &binding,
        )?;
        let env_facts = LocalShellExecuteExecutor::env_policy_facts(&approval_args)?;
        crate::chat_v2::approval_scope::attach_shell_env_policy_facts(&scoped, &env_facts).map(Some)
    }

    fn canonical_tool_short_name(tool_name: &str) -> &str {
        tool_name
            .strip_prefix(super::super::tools::builtin_retrieval_executor::BUILTIN_NAMESPACE)
            .or_else(|| tool_name.strip_prefix("builtin:"))
            .or_else(|| tool_name.strip_prefix("mcp.tools."))
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name)
    }

    /// 请求用户审批敏感工具
    ///
    /// 🆕 文档 29 P1-3：发射审批事件并等待用户响应
    ///
    /// 返回 `ApprovalOutcome` 以区分用户同意、拒绝、超时、通道异常等情况。
    async fn request_tool_approval(
        &self,
        tool_call: &ToolCall,
        approval_arguments: &Value,
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        block_id: &str,
        sensitivity: &ToolSensitivity,
        permission_preset: crate::chat_v2::types::PermissionPreset,
        approval_manager: &Arc<ApprovalManager>,
        cancellation_token: Option<&CancellationToken>,
    ) -> ApprovalOutcome {
        let timeout_seconds = approval_manager.default_timeout();
        let approval_block_id = format!("approval_{}", tool_call.id);
        let sensitivity_label = match sensitivity {
            ToolSensitivity::Low => "low",
            ToolSensitivity::Medium => "medium",
            ToolSensitivity::High => "high",
        };

        // 构建审批请求
        let request = ApprovalRequest {
            session_id: session_id.to_string(),
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            arguments: crate::chat_v2::approval_scope::redact_tool_arguments_for_display(
                &tool_call.name,
                approval_arguments,
            ),
            sensitivity: sensitivity_label.to_string(),
            permission_preset,
            description: ApprovalManager::generate_description(&tool_call.name, approval_arguments),
            timeout_seconds,
            runtime_scope: crate::chat_v2::approval_scope::make_runtime_approval_scope(
                &tool_call.name,
                approval_arguments,
                sensitivity_label,
            ),
        };

        // 注册等待
        let rx = approval_manager.register_with_permission_preset(
            session_id,
            &tool_call.id,
            &tool_call.name,
            approval_arguments,
            permission_preset,
            *sensitivity,
        );

        // 发射审批请求事件到前端
        log::info!(
            "[ChatV2::pipeline] Emitting tool approval request: tool={}, sensitivity={:?}",
            tool_call.name,
            sensitivity
        );
        let payload = serde_json::to_value(&request).ok();
        log::debug!(
            "[ChatV2::pipeline] tool approval block mapping: tool_block_id={}, approval_block_id={}",
            block_id,
            approval_block_id
        );
        emitter.emit_start(
            event_types::TOOL_APPROVAL_REQUEST,
            message_id,
            Some(&approval_block_id),
            payload,
            None, // variant_id
        );

        // 等待响应或超时
        // 🔧 F7 修复：同时监听流取消信号 —— 用户停止生成时立即清理 pending 审批
        // 并退出等待，不再让审批 sender 残留到 60s 超时
        let timeout_duration = std::time::Duration::from_secs(timeout_seconds as u64);
        let wait_result =
            wait_oneshot_with_optional_cancel(rx, timeout_duration, cancellation_token).await;

        let Some(timeout_result) = wait_result else {
            // 流被取消：清理 pending 审批并通知前端关闭审批卡片
            log::info!(
                "[ChatV2::pipeline] Stream cancelled while waiting approval for tool: {}",
                tool_call.name
            );
            approval_manager.cancel_with_session(session_id, &tool_call.id);
            emitter.emit_error(
                event_types::TOOL_APPROVAL_REQUEST,
                &approval_block_id,
                "approval_cancelled",
                None,
            );
            return ApprovalOutcome::Cancelled;
        };

        match timeout_result {
            Ok(Ok(response)) => {
                log::info!(
                    "[ChatV2::pipeline] Received approval response: approved={}",
                    response.approved
                );
                let result_payload = serde_json::json!({
                    "toolCallId": tool_call.id,
                    "approved": response.approved,
                    "reason": response.reason,
                });
                emitter.emit_end(
                    event_types::TOOL_APPROVAL_REQUEST,
                    &approval_block_id,
                    Some(result_payload),
                    None,
                );
                if response.approved {
                    ApprovalOutcome::Approved
                } else {
                    // 'user_rejected' / 'timeout' 是前端哨兵值，不算用户填写的理由
                    let reason = response.reason.filter(|r| {
                        let trimmed = r.trim();
                        !trimmed.is_empty() && trimmed != "user_rejected" && trimmed != "timeout"
                    });
                    ApprovalOutcome::Rejected { reason }
                }
            }
            Ok(Err(_)) => {
                // channel 被关闭（不应该发生）
                log::warn!("[ChatV2::pipeline] Approval channel closed unexpectedly");
                emitter.emit_error(
                    event_types::TOOL_APPROVAL_REQUEST,
                    &approval_block_id,
                    "approval_channel_closed",
                    None,
                );
                approval_manager.cancel_with_session(session_id, &tool_call.id);
                ApprovalOutcome::ChannelClosed
            }
            Err(_) => {
                // 超时
                log::warn!(
                    "[ChatV2::pipeline] Approval timeout for tool: {}",
                    tool_call.name
                );
                approval_manager.cancel_with_session(session_id, &tool_call.id);
                emitter.emit_error(
                    event_types::TOOL_APPROVAL_REQUEST,
                    &approval_block_id,
                    "approval_timeout",
                    None,
                );
                ApprovalOutcome::Timeout
            }
        }
    }

    /// Plan mode write gate: emit `plan_gate`, wait for user confirm, then bind planId.
    /// Approval here must never upgrade to remember / global_bypass.
    async fn request_plan_gate(
        &self,
        tool_call: &ToolCall,
        approval_arguments: &Value,
        summary: &str,
        emitter: &Arc<ChatV2EventEmitter>,
        session_id: &str,
        message_id: &str,
        cancellation_token: Option<&CancellationToken>,
        binding_key: &str,
        round_id: Option<&str>,
    ) -> ApprovalOutcome {
        use super::authority_mode::{
            default_plan_ttl_secs, global_plan_gate_manager, PlanGateRequest,
        };
        use crate::chat_v2::types::PlanAuthorityState;

        let manager = global_plan_gate_manager();
        let timeout_seconds = manager.default_timeout();
        let mut pending_plan = PlanAuthorityState::new_pending(summary);
        pending_plan.bind_to_call(binding_key.to_string());
        let plan_id = pending_plan.plan_id.clone();
        let plan_block_id = format!("plan_gate_{}", tool_call.id);

        // Persist pending plan so UI can show summary even before approval.
        if let Err(err) =
            ChatV2Repo::set_session_plan_state(&self.db, session_id, Some(pending_plan.clone()))
        {
            log::warn!(
                "[ChatV2::pipeline] Failed to persist pending plan for {}: {}",
                session_id,
                err
            );
        }

        let request = PlanGateRequest {
            session_id: session_id.to_string(),
            plan_id: plan_id.clone(),
            tool_call_id: tool_call.id.clone(),
            tool_name: tool_call.name.clone(),
            summary: summary.to_string(),
            timeout_seconds,
            arguments: crate::chat_v2::approval_scope::redact_tool_arguments_for_display(
                &tool_call.name,
                approval_arguments,
            ),
        };

        let rx = manager.register(session_id, &tool_call.id, &plan_id);
        log::info!(
            "[ChatV2::pipeline] Emitting plan_gate: planId={}, tool={}, round={:?}",
            plan_id,
            tool_call.name,
            round_id
        );
        let payload = serde_json::to_value(&request).ok();
        emitter.emit_start(
            event_types::PLAN_GATE,
            message_id,
            Some(&plan_block_id),
            payload,
            None,
        );

        let timeout_duration = std::time::Duration::from_secs(timeout_seconds as u64);
        let wait_result =
            wait_oneshot_with_optional_cancel(rx, timeout_duration, cancellation_token).await;

        let Some(timeout_result) = wait_result else {
            log::info!(
                "[ChatV2::pipeline] Stream cancelled while waiting plan_gate for tool: {}",
                tool_call.name
            );
            manager.cancel(session_id, &tool_call.id);
            let _ = ChatV2Repo::set_session_plan_state(&self.db, session_id, None);
            emitter.emit_error(
                event_types::PLAN_GATE,
                &plan_block_id,
                "plan_gate_cancelled",
                None,
            );
            return ApprovalOutcome::Cancelled;
        };

        match timeout_result {
            Ok(Ok(response)) => {
                let result_payload = json!({
                    "planId": plan_id,
                    "toolCallId": tool_call.id,
                    "approved": response.approved,
                    "reason": response.reason,
                });
                emitter.emit_end(
                    event_types::PLAN_GATE,
                    &plan_block_id,
                    Some(result_payload),
                    None,
                );
                if response.approved {
                    // Plan approval binds only this planId batch — never remember/global_bypass.
                    pending_plan.mark_approved(default_plan_ttl_secs());
                    if let Err(err) =
                        ChatV2Repo::set_session_plan_state(&self.db, session_id, Some(pending_plan))
                    {
                        log::error!(
                            "[ChatV2::pipeline] Failed to persist approved plan {}: {}",
                            plan_id,
                            err
                        );
                        return ApprovalOutcome::Rejected {
                            reason: Some("failed to persist plan approval".to_string()),
                        };
                    }
                    ApprovalOutcome::Approved
                } else {
                    let _ = ChatV2Repo::set_session_plan_state(&self.db, session_id, None);
                    let reason = response.reason.filter(|r| {
                        let trimmed = r.trim();
                        !trimmed.is_empty() && trimmed != "user_rejected" && trimmed != "timeout"
                    });
                    ApprovalOutcome::Rejected { reason }
                }
            }
            Ok(Err(_)) => {
                log::warn!("[ChatV2::pipeline] Plan gate channel closed unexpectedly");
                manager.cancel(session_id, &tool_call.id);
                let _ = ChatV2Repo::set_session_plan_state(&self.db, session_id, None);
                emitter.emit_error(
                    event_types::PLAN_GATE,
                    &plan_block_id,
                    "plan_gate_channel_closed",
                    None,
                );
                ApprovalOutcome::ChannelClosed
            }
            Err(_) => {
                log::warn!(
                    "[ChatV2::pipeline] Plan gate timeout for tool: {}",
                    tool_call.name
                );
                manager.cancel(session_id, &tool_call.id);
                let _ = ChatV2Repo::set_session_plan_state(&self.db, session_id, None);
                emitter.emit_error(
                    event_types::PLAN_GATE,
                    &plan_block_id,
                    "plan_gate_timeout",
                    None,
                );
                ApprovalOutcome::Timeout
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 顺序敏感：`TaskAuditHook::after_tool` 消费 `ApprovalGateHook::before_tool`
    /// 写入的 `authority_admission` / `is_external_mcp` /
    /// `trusted_automation_preauthorized`。准入必须先于审计，否则审计读到的
    /// 是下方 `audit_consumed_admission_fields_start_fail_closed` 锁定的
    /// fail-closed 初始值，安全注记会静默丢失。
    #[test]
    fn default_hooks_keep_approval_gate_first() {
        let names = default_pipeline_hooks()
            .iter()
            .map(|hook| hook.name())
            .collect::<Vec<_>>();

        assert_eq!(names, ["approval_gate", "task_audit"]);
    }

    /// 强化上面的顺序锁：审计钩子依赖的三个字段在 `ToolAdmission::new`
    /// 时必须是「未准入」的 fail-closed 值——只有 `ApprovalGateHook` 放行
    /// 时才会写入真实证据。若本测试失败，说明有人给初始值注入了伪造的
    /// 准入证据，审计将无法区分「准入钩子未运行」与「准入通过」。
    #[test]
    fn audit_consumed_admission_fields_start_fail_closed() {
        let admission = ToolAdmission::new(&json!({"command": "ls"}));

        assert!(admission.authority_admission().is_none());
        assert!(!admission.is_external_mcp);
        assert!(!admission.trusted_automation_preauthorized);
    }

    #[test]
    fn catastrophe_guard_is_wired_only_to_backend_local_shell() {
        let local_shell = ToolCall {
            id: "local-catastrophe".to_string(),
            name: "builtin-local_shell_execute".to_string(),
            arguments: json!({"command": "rm -rf /"}),
        };
        let local_decision = immutable_command_guard_for_tool_call(&local_shell)
            .expect("backend local shell must run the immutable guard");
        assert_eq!(
            local_decision.effect,
            crate::chat_v2::approval_scope::ShellCommandGuardEffect::Deny
        );

        let external_mcp = ToolCall {
            id: "external-command".to_string(),
            name: "mcp.tools.local_shell_execute".to_string(),
            arguments: json!({"command": "rm -rf /"}),
        };
        assert!(
            immutable_command_guard_for_tool_call(&external_mcp).is_none(),
            "external MCP commands are outside the local guard guarantee"
        );
    }

    #[test]
    fn missing_approval_manager_is_fail_closed_for_non_low_sensitivity() {
        assert!(!approval_manager_required(Some(ToolSensitivity::Low)));
        assert!(approval_manager_required(Some(ToolSensitivity::Medium)));
        assert!(approval_manager_required(Some(ToolSensitivity::High)));
        assert!(approval_manager_required(None));
    }

    #[test]
    fn phase9_non_low_tools_enter_the_fail_closed_approval_path() {
        use crate::chat_v2::tools::ToolExecutor;

        let memory = crate::chat_v2::tools::MemoryToolExecutor::new();
        let essay = crate::chat_v2::tools::EssayGradingExecutor::new();
        let temp_dir = tempfile::tempdir().expect("create workspace directory");
        let subagent = crate::chat_v2::tools::SubagentExecutor::new(Arc::new(
            crate::chat_v2::workspace::WorkspaceCoordinator::new(temp_dir.path().to_path_buf()),
        ));

        for (tool, sensitivity) in [
            (
                "builtin-memory_batch_move",
                memory.sensitivity_level("builtin-memory_batch_move"),
            ),
            (
                "builtin-memory_add_relation",
                memory.sensitivity_level("builtin-memory_add_relation"),
            ),
            (
                "builtin-memory_remove_relation",
                memory.sensitivity_level("builtin-memory_remove_relation"),
            ),
            (
                "builtin-memory_update_tags",
                memory.sensitivity_level("builtin-memory_update_tags"),
            ),
            (
                "builtin-memory_export_all",
                memory.sensitivity_level("builtin-memory_export_all"),
            ),
            (
                "builtin-essay_grade",
                essay.sensitivity_level("builtin-essay_grade"),
            ),
            (
                "builtin-subagent_call",
                subagent.sensitivity_level("builtin-subagent_call"),
            ),
        ] {
            assert_ne!(sensitivity, ToolSensitivity::Low, "{tool}");
            assert!(
                approval_manager_required(Some(sensitivity)),
                "{tool} must be blocked when ApprovalManager is unavailable"
            );
        }

        assert!(!approval_manager_required(Some(
            essay.sensitivity_level("builtin-essay_list_modes")
        )));
    }

    #[test]
    fn phase2_phase3_and_phase8_non_low_tools_fail_closed_without_approval_manager() {
        use crate::chat_v2::tools::ToolExecutor;

        let canvas = crate::chat_v2::tools::CanvasToolExecutor::new();
        let dstu = crate::chat_v2::tools::DstuToolExecutor::new();
        let session = crate::chat_v2::tools::SessionToolExecutor::new();
        let index = crate::chat_v2::tools::IndexWebpageToolExecutor::new();

        let cases = [
            (
                "builtin-note_delete",
                canvas.sensitivity_level("builtin-note_delete"),
            ),
            (
                "builtin-note_update_tags",
                canvas.sensitivity_level("builtin-note_update_tags"),
            ),
            (
                "builtin-dstu_folder_create",
                dstu.sensitivity_level("builtin-dstu_folder_create"),
            ),
            (
                "builtin-dstu_folder_rename",
                dstu.sensitivity_level("builtin-dstu_folder_rename"),
            ),
            (
                "builtin-dstu_rename",
                dstu.sensitivity_level("builtin-dstu_rename"),
            ),
            (
                "builtin-dstu_move",
                dstu.sensitivity_level("builtin-dstu_move"),
            ),
            (
                "builtin-dstu_delete",
                dstu.sensitivity_level("builtin-dstu_delete"),
            ),
            (
                "builtin-dstu_restore",
                dstu.sensitivity_level("builtin-dstu_restore"),
            ),
            (
                "builtin-dstu_purge",
                dstu.sensitivity_level("builtin-dstu_purge"),
            ),
            (
                "builtin-dstu_upload_file",
                dstu.sensitivity_level("builtin-dstu_upload_file"),
            ),
            (
                "builtin-session_export",
                session.sensitivity_level("builtin-session_export"),
            ),
            (
                "builtin-session_tag_add",
                session.sensitivity_level("builtin-session_tag_add"),
            ),
            (
                "builtin-session_tag_remove",
                session.sensitivity_level("builtin-session_tag_remove"),
            ),
            (
                "builtin-session_move",
                session.sensitivity_level("builtin-session_move"),
            ),
            (
                "builtin-session_rename",
                session.sensitivity_level("builtin-session_rename"),
            ),
            (
                "builtin-session_restore",
                session.sensitivity_level("builtin-session_restore"),
            ),
            (
                "builtin-group_create",
                session.sensitivity_level("builtin-group_create"),
            ),
            (
                "builtin-group_update",
                session.sensitivity_level("builtin-group_update"),
            ),
            (
                "builtin-session_archive",
                session.sensitivity_level("builtin-session_archive"),
            ),
            (
                "builtin-index_rebuild",
                index.sensitivity_level("builtin-index_rebuild"),
            ),
            (
                "builtin-webpage_save",
                index.sensitivity_level("builtin-webpage_save"),
            ),
        ];
        for (tool, sensitivity) in cases {
            assert_ne!(sensitivity, ToolSensitivity::Low, "{tool}");
            assert!(
                approval_manager_required(Some(sensitivity)),
                "{tool} must be blocked when ApprovalManager is unavailable"
            );
        }

        let learning = crate::chat_v2::tools::LearningOverviewExecutor::new();
        for tool in [
            "builtin-learning_overview",
            "builtin-pomodoro_today_stats",
            "builtin-pomodoro_daily_stats",
        ] {
            assert_eq!(
                learning.sensitivity_level(tool),
                ToolSensitivity::Low,
                "{tool}"
            );
            assert!(!approval_manager_required(Some(
                learning.sensitivity_level(tool)
            )));
        }
    }
}
