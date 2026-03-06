//! Skills 工具执行器
//!
//! 处理 `load_skills` 元工具调用，支持渐进披露架构。
//!
//! ## 设计说明
//!
//! `load_skills` 是一个特殊的元工具，用于按需加载技能组。
//! 后端执行器负责验证参数并从 skill_contents 获取技能内容返回给 LLM，
//! 前端同时调用 `loadSkillsToSession` 完成工具注入。
//!
//! ## 工作流程
//!
//! 1. LLM 调用 `load_skills(skills: ["knowledge-retrieval", ...])`
//! 2. 后端执行器验证参数，从 ctx.skill_contents 获取内容，返回 `{ status: "success", skill_ids: [...] }`
//! 3. 前端收到结果后，调用 `loadSkillsToSession` 加载 Skills 并动态注入工具
//! 4. 后端在后续轮次中动态追加已加载技能的工具 Schema

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::event_types;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::{
    ReplaySkillPayloadSnapshot, SessionSkillState, ToolCall, ToolResultInfo,
};

/// load_skills 工具名称
pub const LOAD_SKILLS_TOOL_NAME: &str = "load_skills";
pub const BUILTIN_LOAD_SKILLS_TOOL_NAME: &str = "builtin-load_skills";

/// load_skills 输入参数
#[derive(Debug, Deserialize)]
struct LoadSkillsInput {
    /// 要加载的技能 ID 列表
    skills: Vec<String>,
}

/// load_skills 输出结果
#[derive(Debug, Serialize)]
struct LoadSkillsOutput {
    /// 状态：delegated 表示需要前端处理
    status: String,
    /// 请求加载的技能 ID 列表
    skill_ids: Vec<String>,
    /// 消息
    message: String,
    /// 后端权威的会话级已加载 Skills
    loaded_skill_ids: Vec<String>,
    /// 后端权威的会话级激活 Skills
    active_skill_ids: Vec<String>,
    /// Skill 状态版本
    skill_state_version: u64,
    /// 后端权威 Skill 状态
    skill_state: SessionSkillState,
}

/// Skills 工具执行器
pub struct SkillsExecutor;

impl SkillsExecutor {
    pub fn new() -> Self {
        Self
    }

    /// 检查工具名是否为 load_skills
    ///
    /// 支持多种前缀格式：
    /// - load_skills（无前缀）
    /// - builtin-load_skills
    /// - builtin:load_skills
    /// - mcp_load_skills（Pipeline 添加的 MCP 前缀）
    pub fn is_load_skills_tool(tool_name: &str) -> bool {
        let stripped = Self::strip_prefix(tool_name);
        stripped == LOAD_SKILLS_TOOL_NAME
    }

    /// 去除工具名前缀
    ///
    /// 支持的前缀：builtin-, builtin:, mcp_
    fn strip_prefix(tool_name: &str) -> &str {
        tool_name
            .strip_prefix("builtin-")
            .or_else(|| tool_name.strip_prefix("builtin:"))
            .or_else(|| tool_name.strip_prefix("mcp_"))
            .unwrap_or(tool_name)
    }
}

impl Default for SkillsExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for SkillsExecutor {
    fn name(&self) -> &'static str {
        "SkillsExecutor"
    }

    fn can_handle(&self, tool_name: &str) -> bool {
        Self::is_load_skills_tool(tool_name)
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        // load_skills 是安全的元工具，无需审批
        ToolSensitivity::Low
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = std::time::Instant::now();
        let stripped_name = Self::strip_prefix(&call.name);

        // 发射工具调用开始事件
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        tracing::info!(
            "[SkillsExecutor] Executing {} with input: {:?}",
            stripped_name,
            call.arguments
        );

        match stripped_name {
            "load_skills" => {
                // 解析输入参数
                let parsed_input: LoadSkillsInput =
                    match serde_json::from_value(call.arguments.clone()) {
                        Ok(v) => v,
                        Err(e) => {
                            let error_msg = format!("参数解析失败: {}", e);
                            let duration_ms = start_time.elapsed().as_millis() as u64;
                            ctx.emit_tool_call_error(&error_msg);
                            return Ok(ToolResultInfo::failure(
                                Some(call.id.clone()),
                                Some(ctx.block_id.clone()),
                                call.name.clone(),
                                call.arguments.clone(),
                                error_msg,
                                duration_ms,
                            ));
                        }
                    };

                if parsed_input.skills.is_empty() {
                    let error_msg = "请指定至少一个技能 ID".to_string();
                    let duration_ms = start_time.elapsed().as_millis() as u64;
                    ctx.emit_tool_call_error(&error_msg);
                    return Ok(ToolResultInfo::failure(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        error_msg,
                        duration_ms,
                    ));
                }

                // 🔧 核心修复：从 skill_contents 获取技能的完整内容并返回给 LLM
                // 这样 LLM 就能看到技能的 MD 文件内容（包含工具定义）
                let mut skill_content_parts: Vec<String> = Vec::new();
                let mut loaded_skills: Vec<String> = Vec::new();
                let mut not_found_skills: Vec<String> = Vec::new();

                if let Some(ref skill_contents) = ctx.skill_contents {
                    for skill_id in &parsed_input.skills {
                        if let Some(content) = skill_contents.get(skill_id) {
                            skill_content_parts.push(format!(
                                "<skill_loaded id=\"{}\">\n<instructions>\n{}\n</instructions>\n</skill_loaded>",
                                skill_id,
                                content
                            ));
                            loaded_skills.push(skill_id.clone());
                        } else {
                            not_found_skills.push(skill_id.clone());
                        }
                    }
                } else {
                    // 没有 skill_contents，所有技能都找不到
                    not_found_skills = parsed_input.skills.clone();
                }

                // 构建完整的输出内容
                let mut output_parts = skill_content_parts;

                if !not_found_skills.is_empty() {
                    output_parts.push(format!(
                        "<warning>以下技能未找到: {}</warning>",
                        not_found_skills.join(", ")
                    ));
                }

                if !loaded_skills.is_empty() {
                    output_parts.push(format!(
                        "\n共加载 {} 个技能。这些工具现在可以使用了。",
                        loaded_skills.len()
                    ));
                }

                let full_content = output_parts.join("\n");

                let mut session_loaded_skill_ids = loaded_skills.clone();
                let mut session_active_skill_ids = Vec::new();
                let mut skill_state_version = 0_u64;
                let mut authoritative_skill_state = SessionSkillState::default();

                if let Some(ref chat_v2_db) = ctx.chat_v2_db {
                    match ChatV2Repo::load_session_state_v2(chat_v2_db, &ctx.session_id) {
                        Ok(existing_state) => {
                            let existing_state = existing_state.unwrap_or_else(|| {
                                crate::chat_v2::types::SessionState {
                                    session_id: ctx.session_id.clone(),
                                    chat_params: None,
                                    features: None,
                                    mode_state: None,
                                    input_value: None,
                                    panel_states: None,
                                    updated_at: chrono::Utc::now().to_rfc3339(),
                                    pending_context_refs_json: None,
                                    loaded_skill_ids_json: None,
                                    active_skill_ids_json: None,
                                    skill_state_json: None,
                                }
                            });
                            let previous_skill_state = existing_state.resolved_skill_state();
                            let previous_snapshot = previous_skill_state.snapshot();
                            let next_skill_state = if ctx.variant_id.is_some() {
                                previous_skill_state.with_added_branch_local_skills(&loaded_skills)
                            } else {
                                previous_skill_state.with_added_agentic_skills(&loaded_skills)
                            };
                            let next_snapshot = next_skill_state.snapshot();
                            session_loaded_skill_ids = next_skill_state.resolved_loaded_skill_ids();
                            session_active_skill_ids = next_skill_state.resolved_active_skill_ids();
                            skill_state_version = next_skill_state.version;
                            authoritative_skill_state = next_skill_state.clone();
                            if let Err(err) = ChatV2Repo::update_session_skill_state_v2(
                                chat_v2_db,
                                &ctx.session_id,
                                &next_skill_state,
                            ) {
                                tracing::warn!(
                                    "[SkillsExecutor] Failed to persist session skill state: session_id={}, error={}",
                                    ctx.session_id,
                                    err
                                );
                            }

                            match ChatV2Repo::get_message_v2(chat_v2_db, &ctx.message_id) {
                                Ok(Some(mut message)) => {
                                    let previous_runtime = message
                                        .meta
                                        .as_ref()
                                        .and_then(|meta| {
                                            meta.skill_runtime_after
                                                .clone()
                                                .or(meta.skill_runtime_before.clone())
                                        })
                                        .unwrap_or_default();
                                    let next_runtime = ReplaySkillPayloadSnapshot {
                                        active_skill_ids: {
                                            let mut merged = session_active_skill_ids.clone();
                                            merged.extend(session_loaded_skill_ids.clone());
                                            merged.sort();
                                            merged.dedup();
                                            merged
                                        },
                                        skill_allowed_tools: {
                                            let mut allowed = authoritative_skill_state
                                                .effective_allowed_internal_tools
                                                .clone();
                                            allowed.extend(
                                                authoritative_skill_state
                                                    .effective_allowed_external_tools
                                                    .clone(),
                                            );
                                            allowed.sort();
                                            allowed.dedup();
                                            allowed
                                        },
                                        skill_contents: previous_runtime.skill_contents.clone(),
                                        skill_embedded_tools: previous_runtime
                                            .skill_embedded_tools
                                            .clone(),
                                        mcp_tool_schemas: previous_runtime.mcp_tool_schemas.clone(),
                                        selected_mcp_servers: previous_runtime
                                            .selected_mcp_servers
                                            .clone(),
                                    };
                                    if let Some(ref variant_id) = ctx.variant_id {
                                        if let Some(ref mut variants) = message.variants {
                                            if let Some(variant) = variants
                                                .iter_mut()
                                                .find(|variant| variant.id == *variant_id)
                                            {
                                                let mut variant_meta =
                                                    variant.meta.clone().unwrap_or_default();
                                                variant_meta.skill_snapshot_before =
                                                    Some(previous_snapshot.clone());
                                                variant_meta.skill_snapshot_after =
                                                    Some(next_snapshot.clone());
                                                variant_meta.skill_runtime_before =
                                                    Some(previous_runtime.clone());
                                                variant_meta.skill_runtime_after =
                                                    Some(next_runtime.clone());
                                                variant.meta = Some(variant_meta);
                                            }
                                        }
                                    }

                                    let mut meta = message.meta.unwrap_or_default();
                                    meta.skill_snapshot_before = Some(previous_snapshot);
                                    meta.skill_snapshot_after = Some(next_snapshot);
                                    meta.skill_runtime_before = Some(previous_runtime);
                                    meta.skill_runtime_after = Some(next_runtime);
                                    meta.replay_source = Some("current".to_string());
                                    message.meta = Some(meta);
                                    if let Err(err) =
                                        ChatV2Repo::update_message_v2(chat_v2_db, &message)
                                    {
                                        tracing::warn!(
                                            "[SkillsExecutor] Failed to update message skill snapshots: message_id={}, error={}",
                                            ctx.message_id,
                                            err
                                        );
                                    }
                                }
                                Ok(None) => {}
                                Err(err) => {
                                    tracing::warn!(
                                        "[SkillsExecutor] Failed to load message for skill snapshots: message_id={}, error={}",
                                        ctx.message_id,
                                        err
                                    );
                                }
                            }
                        }
                        Err(err) => {
                            tracing::warn!(
                                "[SkillsExecutor] Failed to load session skill state: session_id={}, error={}",
                                ctx.session_id,
                                err
                            );
                        }
                    }
                }

                // 构建输出结构
                let output = LoadSkillsOutput {
                    status: "success".to_string(),
                    skill_ids: loaded_skills.clone(),
                    message: full_content.clone(),
                    loaded_skill_ids: session_loaded_skill_ids,
                    active_skill_ids: session_active_skill_ids,
                    skill_state_version,
                    skill_state: authoritative_skill_state,
                };

                let duration_ms = start_time.elapsed().as_millis() as u64;
                let result_json = json!({
                    "result": output,
                    "content": full_content, // 🆕 直接暴露完整内容，方便 LLM 读取
                    "durationMs": duration_ms,
                });

                // 发射工具调用结束事件
                ctx.emitter.emit_end_with_meta(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(result_json.clone()),
                    ctx.variant_id.as_deref(),
                    Some(skill_state_version),
                    ctx.round_id.as_deref(),
                );

                tracing::info!(
                    "[SkillsExecutor] load_skills persisted and synced: {:?}",
                    parsed_input.skills
                );

                Ok(ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    result_json,
                    duration_ms,
                ))
            }
            _ => {
                let error_msg = format!("未知的 Skills 工具: {}", call.name);
                let duration_ms = start_time.elapsed().as_millis() as u64;
                ctx.emit_tool_call_error(&error_msg);
                Ok(ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    duration_ms,
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_load_skills_tool() {
        assert!(SkillsExecutor::is_load_skills_tool("load_skills"));
        assert!(SkillsExecutor::is_load_skills_tool("builtin-load_skills"));
        assert!(SkillsExecutor::is_load_skills_tool("builtin:load_skills"));
        assert!(SkillsExecutor::is_load_skills_tool("mcp_load_skills")); // 🆕 支持 mcp_ 前缀
        assert!(!SkillsExecutor::is_load_skills_tool("other_tool"));
        assert!(!SkillsExecutor::is_load_skills_tool("mcp_other_tool"));
    }

    #[test]
    fn test_strip_prefix() {
        assert_eq!(
            SkillsExecutor::strip_prefix("builtin-load_skills"),
            "load_skills"
        );
        assert_eq!(
            SkillsExecutor::strip_prefix("builtin:load_skills"),
            "load_skills"
        );
        assert_eq!(
            SkillsExecutor::strip_prefix("mcp_load_skills"),
            "load_skills"
        ); // 🆕 支持 mcp_ 前缀
        assert_eq!(SkillsExecutor::strip_prefix("load_skills"), "load_skills");
    }
}
