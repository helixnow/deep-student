//! Skills 工具执行器
//!
//! 处理 `load_skills` 元工具调用，支持渐进披露架构。
//!
//! ## 设计说明
//!
//! `load_skills` 是一个特殊的元工具，用于按需加载技能组。
//! 后端执行器负责验证参数并更新会话技能状态。
//! 前端同时调用 `loadSkillsToSession` 完成工具注入。
//!
//! ## 工作流程
//!
//! 1. LLM 调用 `load_skills(skills: ["knowledge-retrieval", ...])`
//! 2. 后端执行器验证参数，返回轻量元数据
//! 3. 前端收到结果后，调用 `loadSkillsToSession` 加载 Skills 并动态注入工具
//! 4. 后端在后续轮次中通过 transient hidden user message 注入技能正文

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::HashMap;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use crate::chat_v2::event_types;
use crate::chat_v2::repo::ChatV2Repo;
use crate::chat_v2::types::{ReplaySkillPayloadSnapshot, ToolCall, ToolResultInfo};

/// load_skills 工具名称
pub const LOAD_SKILLS_TOOL_NAME: &str = "load_skills";
pub const BUILTIN_LOAD_SKILLS_TOOL_NAME: &str = "builtin-load_skills";

/// load_skills 输入参数
#[derive(Debug, Deserialize)]
struct LoadSkillsInput {
    /// 要加载的技能 ID 列表
    #[serde(deserialize_with = "deserialize_string_or_vec")]
    skills: Vec<String>,
}

/// 自定义反序列化：兼容 JSON 数组和字符串化的 JSON 数组
///
/// 部分 LLM（如 Gemini）会将数组参数序列化为字符串：
///   `"[\"knowledge-retrieval\", \"academic-search\"]"` （字符串）
/// 而不是正确的 JSON 数组：
///   `["knowledge-retrieval", "academic-search"]`
///
/// 此反序列化器同时支持两种格式。
fn deserialize_string_or_vec<'de, D>(deserializer: D) -> Result<Vec<String>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    use serde::de;

    struct StringOrVec;

    impl<'de> de::Visitor<'de> for StringOrVec {
        type Value = Vec<String>;

        fn expecting(&self, formatter: &mut std::fmt::Formatter) -> std::fmt::Result {
            formatter.write_str("a string or a sequence of strings")
        }

        fn visit_str<E>(self, value: &str) -> Result<Self::Value, E>
        where
            E: de::Error,
        {
            // 尝试将字符串解析为 JSON 数组
            serde_json::from_str::<Vec<String>>(value).map_err(|_| {
                de::Error::custom(format!(
                    "invalid stringified array: '{}', expected a JSON array string like '[\"a\", \"b\"]'",
                    value
                ))
            })
        }

        fn visit_seq<A>(self, seq: A) -> Result<Self::Value, A::Error>
        where
            A: de::SeqAccess<'de>,
        {
            Deserialize::deserialize(de::value::SeqAccessDeserializer::new(seq))
        }
    }

    deserializer.deserialize_any(StringOrVec)
}

/// load_skills 输出结果
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
struct LoadedToolOutput {
    /// 工具注册名
    name: String,
    /// 提供该工具的技能 ID；前端据此可靠区分内置与第三方技能来源
    skill_id: String,
}

#[derive(Debug, Clone, Serialize)]
struct LoadSkillsOutput {
    /// 状态
    status: String,
    /// 本次模型请求的技能 ID（原样保留，便于审计“模型猜了什么”）
    requested_skill_ids: Vec<String>,
    /// 后端权威的会话级已加载 Skills
    loaded_skill_ids: Vec<String>,
    /// 本次请求中新加载的 Skills
    newly_loaded_skill_ids: Vec<String>,
    /// 本次请求中此前已经加载的 Skills
    already_loaded_skill_ids: Vec<String>,
    /// 本次请求中不存在于可信运行时目录的 IDs
    missing_skill_ids: Vec<String>,
    /// 当前可信运行时目录中确实可加载的精确 IDs（不包含被拒绝项）
    available_skill_ids: Vec<String>,
    /// 本次加载后可用的工具名称
    loaded_tool_names: Vec<String>,
    /// 保留工具与技能来源关系的结构化列表
    loaded_tools: Vec<LoadedToolOutput>,
    /// 本次因运行时准入被拒绝的技能 ID（原因见 rejected_skills）
    rejected_skill_ids: Vec<String>,
    /// 本次因运行时准入被拒绝的技能及原因
    rejected_skills: HashMap<String, String>,
    /// Skill 状态版本
    skill_state_version: u64,
    /// 轻量提示
    message: String,
}

/// Skills 工具执行器
pub struct SkillsExecutor;

fn classify_requested_skills(
    requested: &[String],
    skill_contents: Option<&HashMap<String, String>>,
    admission_errors: Option<&HashMap<String, String>>,
) -> (Vec<String>, Vec<String>, HashMap<String, String>) {
    let mut loaded = Vec::new();
    let mut not_found = Vec::new();
    let mut rejected = HashMap::new();

    for skill_id in requested {
        if let Some(reason) = admission_errors.and_then(|errors| errors.get(skill_id)) {
            rejected.insert(skill_id.clone(), reason.clone());
        } else if skill_contents.is_some_and(|contents| contents.contains_key(skill_id)) {
            loaded.push(skill_id.clone());
        } else {
            not_found.push(skill_id.clone());
        }
    }

    (loaded, not_found, rejected)
}

/// 返回当前可信运行时目录中可加载的精确 Skill IDs。
///
/// `skill_contents` 是前端按运行时准入（信任/启用/requires/依赖）过滤后
/// 传来的可信目录；`skill_admission_errors` 中的 ID 永远不能出现在可加载
/// 列表里。这里只做集合整理，不猜测、不补齐、不做别名/模糊匹配。
fn collect_available_runtime_skill_ids(
    skill_contents: Option<&HashMap<String, String>>,
    admission_errors: Option<&HashMap<String, String>>,
) -> Vec<String> {
    let mut ids: Vec<String> = skill_contents
        .map(|contents| {
            contents
                .keys()
                .filter(|id| !id.trim().is_empty())
                .filter(|id| !admission_errors.is_some_and(|errors| errors.contains_key(*id)))
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids.dedup();
    ids
}

fn format_available_skill_ids_hint(available: &[String]) -> String {
    if available.is_empty() {
        "The trusted runtime catalog currently contains no loadable skill IDs.".to_string()
    } else {
        format!(
            "Available skill IDs (trusted runtime, exact): {}",
            available.join(", ")
        )
    }
}

fn build_load_skills_message(
    loaded: &[String],
    already_loaded: &[String],
    missing: &[String],
    rejected: &HashMap<String, String>,
    available: &[String],
    has_untrusted_rejection: bool,
    include_available_hint: bool,
) -> String {
    let mut parts = Vec::new();
    let has_problem = !missing.is_empty() || !rejected.is_empty();

    if loaded.is_empty() && has_problem {
        parts.push("No skills loaded.".to_string());
    } else if loaded.is_empty() {
        parts.push("No skills were requested.".to_string());
    } else if already_loaded.len() == loaded.len() {
        parts.push("Skills already loaded.".to_string());
    } else {
        parts.push("Skills loaded. Instructions will be provided in the next message.".to_string());
    }

    if !already_loaded.is_empty() {
        parts.push(format!("Already loaded: {}", already_loaded.join(", ")));
    }
    if !missing.is_empty() {
        parts.push(format!("Missing: {}", missing.join(", ")));
    }
    if !rejected.is_empty() {
        let mut entries: Vec<String> = rejected
            .iter()
            .map(|(id, reason)| format!("{} ({})", id, reason))
            .collect();
        entries.sort();
        parts.push(format!("Rejected: {}", entries.join(", ")));
    }

    // 关键：失败工具结果回喂模型时只发送 `Error: {message}`，结构化
    // `output` 不会进入 tool message（见 pipeline/history.rs）。因此精确
    // ID 必须出现在 message 本身，否则模型在失败后拿不到任何可恢复线索。
    if include_available_hint {
        parts.push(format_available_skill_ids_hint(available));
        parts.push(
            "Retry load_skills only with exact IDs copied from that list or from <available_skills>; do not guess, translate, shorten, or invent IDs."
                .to_string(),
        );
    }

    if has_untrusted_rejection {
        parts.push(
            "If trust was granted earlier in this same tool loop, this is the immutable pre-grant runtime catalog snapshot, not a failed grant. Do not retry load_skills in this request; the trusted package becomes loadable on the next user turn."
                .to_string(),
        );
    }

    parts.join(" ")
}

struct LoadSkillsOutcome<'a> {
    requested_skill_ids: &'a [String],
    loaded_skill_ids: &'a [String],
    already_loaded_skill_ids: Vec<String>,
    missing_skill_ids: &'a [String],
    rejected_skills: HashMap<String, String>,
    available_skill_ids: Vec<String>,
    session_loaded_skill_ids: Vec<String>,
    loaded_tools: Vec<LoadedToolOutput>,
    skill_state_version: u64,
    has_untrusted_rejection: bool,
    include_available_hint: bool,
}

fn build_load_skills_output(outcome: LoadSkillsOutcome<'_>) -> LoadSkillsOutput {
    let LoadSkillsOutcome {
        requested_skill_ids,
        loaded_skill_ids,
        already_loaded_skill_ids,
        missing_skill_ids,
        rejected_skills,
        available_skill_ids,
        session_loaded_skill_ids,
        loaded_tools,
        skill_state_version,
        has_untrusted_rejection,
        include_available_hint,
    } = outcome;

    let newly_loaded_skill_ids: Vec<String> = loaded_skill_ids
        .iter()
        .filter(|id| !already_loaded_skill_ids.iter().any(|loaded| loaded == *id))
        .cloned()
        .collect();
    let mut rejected_skill_ids: Vec<String> = rejected_skills.keys().cloned().collect();
    rejected_skill_ids.sort();

    let mut loaded_tool_names: Vec<String> =
        loaded_tools.iter().map(|tool| tool.name.clone()).collect();
    loaded_tool_names.sort();
    loaded_tool_names.dedup();

    let message = build_load_skills_message(
        loaded_skill_ids,
        &already_loaded_skill_ids,
        missing_skill_ids,
        &rejected_skills,
        &available_skill_ids,
        has_untrusted_rejection,
        include_available_hint,
    );

    let all_failed = loaded_skill_ids.is_empty()
        && (!missing_skill_ids.is_empty() || !rejected_skills.is_empty());
    let empty_request = requested_skill_ids.is_empty() && loaded_skill_ids.is_empty();

    LoadSkillsOutput {
        status: if all_failed || empty_request {
            "error".to_string()
        } else {
            "success".to_string()
        },
        requested_skill_ids: requested_skill_ids.to_vec(),
        loaded_skill_ids: session_loaded_skill_ids,
        newly_loaded_skill_ids,
        already_loaded_skill_ids,
        missing_skill_ids: missing_skill_ids.to_vec(),
        available_skill_ids,
        loaded_tool_names,
        loaded_tools,
        rejected_skill_ids,
        rejected_skills,
        skill_state_version,
        message,
    }
}

fn current_session_loaded_skill_ids(ctx: &ExecutionContext) -> Vec<String> {
    ctx.chat_v2_db
        .as_ref()
        .and_then(|db| {
            ChatV2Repo::load_session_state_v2(db, &ctx.session_id)
                .ok()
                .flatten()
        })
        .map(|state| state.resolved_skill_state().resolved_loaded_skill_ids())
        .unwrap_or_default()
}

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
                let available_skill_ids = collect_available_runtime_skill_ids(
                    ctx.skill_contents.as_ref(),
                    ctx.skill_admission_errors.as_ref(),
                );

                // 解析输入参数
                let parsed_input: LoadSkillsInput =
                    match serde_json::from_value(call.arguments.clone()) {
                        Ok(v) => v,
                        Err(e) => {
                            let error_msg = format!(
                                "参数解析失败: {}. {}",
                                e,
                                format_available_skill_ids_hint(&available_skill_ids)
                            );
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
                    let output = build_load_skills_output(LoadSkillsOutcome {
                        requested_skill_ids: &[],
                        loaded_skill_ids: &[],
                        already_loaded_skill_ids: Vec::new(),
                        missing_skill_ids: &[],
                        rejected_skills: HashMap::new(),
                        available_skill_ids,
                        session_loaded_skill_ids: current_session_loaded_skill_ids(ctx),
                        loaded_tools: Vec::new(),
                        skill_state_version: 0,
                        has_untrusted_rejection: false,
                        include_available_hint: true,
                    });
                    let error_msg = output.message.clone();
                    let duration_ms = start_time.elapsed().as_millis() as u64;
                    ctx.emit_tool_call_error(&error_msg);
                    let result_json = json!({
                        "result": output,
                        "durationMs": duration_ms,
                    });
                    return Ok(ToolResultInfo::failure_with_output(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        result_json,
                        error_msg,
                        duration_ms,
                    ));
                }

                let (loaded_skills, not_found_skills, rejected_skills) = classify_requested_skills(
                    &parsed_input.skills,
                    ctx.skill_contents.as_ref(),
                    ctx.skill_admission_errors.as_ref(),
                );

                let mut session_loaded_skill_ids = loaded_skills.clone();
                let mut already_loaded_skill_ids: Vec<String> = Vec::new();
                let mut skill_state_version = 0_u64;
                let mut loaded_tools: Vec<LoadedToolOutput> = loaded_skills
                    .iter()
                    .flat_map(|skill_id| {
                        ctx.skill_embedded_tools
                            .as_ref()
                            .and_then(|map| map.get(skill_id))
                            .into_iter()
                            .flatten()
                            .map(move |tool| LoadedToolOutput {
                                name: tool.name.clone(),
                                skill_id: skill_id.clone(),
                            })
                    })
                    .collect();
                loaded_tools.sort_by(|left, right| {
                    left.skill_id
                        .cmp(&right.skill_id)
                        .then_with(|| left.name.cmp(&right.name))
                });
                loaded_tools.dedup();

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
                            let previous_loaded_skill_ids =
                                previous_skill_state.resolved_loaded_skill_ids();
                            already_loaded_skill_ids = loaded_skills
                                .iter()
                                .filter(|id| {
                                    previous_loaded_skill_ids.iter().any(|loaded| loaded == *id)
                                })
                                .cloned()
                                .collect();
                            let previous_snapshot = previous_skill_state.snapshot();
                            let next_skill_state = if ctx.variant_id.is_some() {
                                previous_skill_state.with_added_branch_local_skills(&loaded_skills)
                            } else {
                                previous_skill_state.with_added_agentic_skills(&loaded_skills)
                            };
                            let next_snapshot = next_skill_state.snapshot();
                            session_loaded_skill_ids = next_skill_state.resolved_loaded_skill_ids();
                            skill_state_version = next_skill_state.version;
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
                                        active_skill_ids: next_skill_state
                                            .resolved_active_skill_ids(),
                                        execution_allowed_tools: previous_runtime
                                            .execution_allowed_tools
                                            .clone(),
                                        skill_contents: if previous_runtime
                                            .skill_contents
                                            .is_empty()
                                        {
                                            ctx.skill_contents.clone().unwrap_or_default()
                                        } else {
                                            previous_runtime.skill_contents.clone()
                                        },
                                        skill_dependencies: previous_runtime
                                            .skill_dependencies
                                            .clone(),
                                        skill_embedded_tools: if previous_runtime
                                            .skill_embedded_tools
                                            .is_empty()
                                        {
                                            ctx.skill_embedded_tools.clone().unwrap_or_default()
                                        } else {
                                            previous_runtime.skill_embedded_tools.clone()
                                        },
                                        mcp_tool_schemas: previous_runtime.mcp_tool_schemas.clone(),
                                        selected_mcp_servers: previous_runtime
                                            .selected_mcp_servers
                                            .clone(),
                                    };
                                    let previous_runtime_for_meta =
                                        previous_runtime.clone().without_skill_contents();
                                    let next_runtime_for_meta =
                                        next_runtime.clone().without_skill_contents();
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
                                                    Some(previous_runtime_for_meta.clone());
                                                variant_meta.skill_runtime_after =
                                                    Some(next_runtime_for_meta.clone());
                                                variant.meta = Some(variant_meta);
                                            }
                                        }
                                    }

                                    let mut meta = message.meta.unwrap_or_default();
                                    meta.skill_snapshot_before = Some(previous_snapshot);
                                    meta.skill_snapshot_after = Some(next_snapshot);
                                    meta.skill_runtime_before = Some(previous_runtime_for_meta);
                                    meta.skill_runtime_after = Some(next_runtime_for_meta);
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

                let has_untrusted_rejection = rejected_skills
                    .values()
                    .any(|reason| reason.to_ascii_lowercase().contains("untrusted"));
                let include_available_hint =
                    !not_found_skills.is_empty() || !rejected_skills.is_empty();

                // 构建输出结构。注意：失败时 pipeline 只把 `message` 作为
                // `Error: ...` 回喂模型；结构化字段仅用于 UI/审计。因此精确
                // 可加载 ID 必须写进 message，不能只放在 available_skill_ids。
                let output = build_load_skills_output(LoadSkillsOutcome {
                    requested_skill_ids: &parsed_input.skills,
                    loaded_skill_ids: &loaded_skills,
                    already_loaded_skill_ids,
                    missing_skill_ids: &not_found_skills,
                    rejected_skills,
                    available_skill_ids,
                    session_loaded_skill_ids,
                    loaded_tools,
                    skill_state_version,
                    has_untrusted_rejection,
                    include_available_hint,
                });
                let message = output.message.clone();
                let all_failed = output.status == "error";

                let duration_ms = start_time.elapsed().as_millis() as u64;
                let result_json = json!({
                    "result": output,
                    "durationMs": duration_ms,
                });

                if all_failed {
                    ctx.emit_tool_call_error(&message);
                } else {
                    ctx.emitter.emit_end_with_meta(
                        event_types::TOOL_CALL,
                        &ctx.block_id,
                        Some(result_json.clone()),
                        ctx.variant_id.as_deref(),
                        Some(skill_state_version),
                        ctx.round_id.as_deref(),
                    );
                }

                tracing::info!(
                    "[SkillsExecutor] load_skills persisted and synced: {:?}",
                    parsed_input.skills
                );

                if all_failed {
                    Ok(ToolResultInfo::failure_with_output(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        result_json,
                        message,
                        duration_ms,
                    ))
                } else {
                    Ok(ToolResultInfo::success(
                        Some(call.id.clone()),
                        Some(ctx.block_id.clone()),
                        call.name.clone(),
                        call.arguments.clone(),
                        result_json,
                        duration_ms,
                    ))
                }
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

    #[test]
    fn admission_errors_reject_disabled_skills_before_content_lookup() {
        let requested = vec!["disabled-skill".to_string(), "ok-skill".to_string()];
        let contents = HashMap::from([
            ("disabled-skill".to_string(), "must not load".to_string()),
            ("ok-skill".to_string(), "ok".to_string()),
        ]);
        let admission_errors = HashMap::from([(
            "disabled-skill".to_string(),
            "disabled: Skill \"disabled-skill\" is disabled and cannot be loaded".to_string(),
        )]);

        let (loaded, missing, rejected) =
            classify_requested_skills(&requested, Some(&contents), Some(&admission_errors));

        assert_eq!(loaded, vec!["ok-skill"]);
        assert!(missing.is_empty());
        assert!(rejected["disabled-skill"].starts_with("disabled:"));
    }

    #[test]
    fn available_runtime_ids_are_exact_sorted_and_exclude_rejections() {
        let contents = HashMap::from([
            ("qbank-tools".to_string(), "qbank".to_string()),
            ("dstu-tools".to_string(), "dstu".to_string()),
            (
                "rejected-skill".to_string(),
                "must not be advertised".to_string(),
            ),
            ("".to_string(), "empty id".to_string()),
        ]);
        let admission_errors = HashMap::from([(
            "rejected-skill".to_string(),
            "untrusted: Skill \"rejected-skill\" is untrusted".to_string(),
        )]);

        let available =
            collect_available_runtime_skill_ids(Some(&contents), Some(&admission_errors));

        assert_eq!(available, vec!["dstu-tools", "qbank-tools"]);
    }

    #[test]
    fn missing_skill_message_returns_exact_loadable_ids_and_never_autoloads() {
        let requested = vec!["question_bank".to_string(), "题库".to_string()];
        let missing = requested.clone();
        let available = vec!["dstu-tools".to_string(), "qbank-tools".to_string()];
        let output = build_load_skills_output(LoadSkillsOutcome {
            requested_skill_ids: &requested,
            loaded_skill_ids: &[],
            already_loaded_skill_ids: Vec::new(),
            missing_skill_ids: &missing,
            rejected_skills: HashMap::new(),
            available_skill_ids: available.clone(),
            session_loaded_skill_ids: Vec::new(),
            loaded_tools: Vec::new(),
            skill_state_version: 0,
            has_untrusted_rejection: false,
            include_available_hint: true,
        });

        assert_eq!(output.status, "error");
        assert!(output.loaded_skill_ids.is_empty());
        assert!(output.newly_loaded_skill_ids.is_empty());
        assert_eq!(output.requested_skill_ids, requested);
        assert_eq!(output.missing_skill_ids, missing);
        assert_eq!(output.available_skill_ids, available);
        assert!(output.message.contains("qbank-tools"));
        assert!(output.message.contains("dstu-tools"));
        assert!(output.message.contains("do not guess"));
        assert!(!output.message.contains("Skills loaded."));
    }

    #[test]
    fn rejected_skills_are_reported_separately_from_available_ids() {
        let requested = vec!["untrusted-skill".to_string()];
        let rejected = HashMap::from([(
            "untrusted-skill".to_string(),
            "untrusted: Skill \"untrusted-skill\" is untrusted and cannot be loaded".to_string(),
        )]);
        let available = vec!["qbank-tools".to_string()];
        let output = build_load_skills_output(LoadSkillsOutcome {
            requested_skill_ids: &requested,
            loaded_skill_ids: &[],
            already_loaded_skill_ids: Vec::new(),
            missing_skill_ids: &[],
            rejected_skills: rejected,
            available_skill_ids: available.clone(),
            session_loaded_skill_ids: Vec::new(),
            loaded_tools: Vec::new(),
            skill_state_version: 7,
            has_untrusted_rejection: true,
            include_available_hint: true,
        });

        assert_eq!(output.status, "error");
        assert_eq!(output.available_skill_ids, available);
        assert_eq!(output.rejected_skill_ids, vec!["untrusted-skill"]);
        assert!(output
            .message
            .contains("Rejected: untrusted-skill (untrusted:"));
        assert!(output.message.contains("Available skill IDs"));
        assert!(output
            .message
            .contains("Do not retry load_skills in this request"));
        assert!(!output.message.contains("Skills loaded."));
    }

    #[test]
    fn empty_request_reports_available_ids_without_loading_anything() {
        let output = build_load_skills_output(LoadSkillsOutcome {
            requested_skill_ids: &[],
            loaded_skill_ids: &[],
            already_loaded_skill_ids: Vec::new(),
            missing_skill_ids: &[],
            rejected_skills: HashMap::new(),
            available_skill_ids: vec!["qbank-tools".to_string()],
            session_loaded_skill_ids: vec!["already-loaded-tool".to_string()],
            loaded_tools: Vec::new(),
            skill_state_version: 3,
            has_untrusted_rejection: false,
            include_available_hint: true,
        });

        assert_eq!(output.status, "error");
        assert!(output.newly_loaded_skill_ids.is_empty());
        assert_eq!(output.loaded_skill_ids, vec!["already-loaded-tool"]);
        assert!(output.message.contains("No skills were requested"));
        assert!(output.message.contains("qbank-tools"));
    }

    #[test]
    fn already_loaded_ids_do_not_claim_a_new_load() {
        let requested = vec!["qbank-tools".to_string()];
        let output = build_load_skills_output(LoadSkillsOutcome {
            requested_skill_ids: &requested,
            loaded_skill_ids: &requested,
            already_loaded_skill_ids: requested.clone(),
            missing_skill_ids: &[],
            rejected_skills: HashMap::new(),
            available_skill_ids: requested.clone(),
            session_loaded_skill_ids: requested.clone(),
            loaded_tools: Vec::new(),
            skill_state_version: 2,
            has_untrusted_rejection: false,
            include_available_hint: false,
        });

        assert_eq!(output.status, "success");
        assert!(output.newly_loaded_skill_ids.is_empty());
        assert_eq!(output.already_loaded_skill_ids, requested);
        assert!(output.message.contains("Skills already loaded."));
    }
}
