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
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

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
        ctx.emitter.emit_tool_call_start(
            &ctx.message_id,
            &ctx.block_id,
            &call.name,
            call.arguments.clone(),
            Some(&call.id),
            None,
        );

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
                            ctx.emitter.emit_error(
                                event_types::TOOL_CALL,
                                &ctx.block_id,
                                &error_msg,
                                None,
                            );
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
                    ctx.emitter
                        .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
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

                // 构建输出结构
                let output = LoadSkillsOutput {
                    status: "success".to_string(),
                    skill_ids: loaded_skills.clone(),
                    message: full_content.clone(),
                };

                let duration_ms = start_time.elapsed().as_millis() as u64;
                let result_json = json!({
                    "result": output,
                    "content": full_content, // 🆕 直接暴露完整内容，方便 LLM 读取
                    "durationMs": duration_ms,
                });

                // 发射工具调用结束事件
                ctx.emitter.emit_end(
                    event_types::TOOL_CALL,
                    &ctx.block_id,
                    Some(result_json.clone()),
                    None,
                );

                tracing::info!(
                    "[SkillsExecutor] load_skills delegated to frontend: {:?}",
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
                ctx.emitter
                    .emit_error(event_types::TOOL_CALL, &ctx.block_id, &error_msg, None);
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
