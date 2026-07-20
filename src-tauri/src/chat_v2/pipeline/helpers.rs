use super::*;
use crate::canonical_tools::{
    encode_tool_name_for_api, prepare_external_tool, ApiNameSource, CanonicalExternalToolConfig,
};
use crate::chat_v2::tools::types::EXTERNAL_MCP_TOOL_PREFIX;
use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone)]
struct HistoryUnit {
    start: usize,
    end: usize,
    is_pinned: bool,
    token_estimate: usize,
}

fn history_unit_token_estimate(msg: &LegacyChatMessage) -> usize {
    use crate::utils::token_budget::estimate_tokens;

    let mut total = estimate_tokens(&msg.content);
    if let Some(thinking) = &msg.thinking_content {
        total = total.saturating_add(estimate_tokens(thinking));
    }
    if let Some(tool_call) = &msg.tool_call {
        total = total.saturating_add(estimate_tokens(&tool_call.args_json.to_string()));
    }
    if let Some(tool_result) = &msg.tool_result {
        if let Some(data) = &tool_result.data_json {
            total = total.saturating_add(estimate_tokens(&data.to_string()));
        }
        if let Some(error) = &tool_result.error {
            total = total.saturating_add(estimate_tokens(error));
        }
    }
    if let Some(image_base64) = &msg.image_base64 {
        for image in image_base64 {
            total = total.saturating_add(image.len() / 4);
        }
    }
    if let Some(doc_attachments) = &msg.doc_attachments {
        for doc in doc_attachments {
            if let Some(text) = &doc.text_content {
                total = total.saturating_add(estimate_tokens(text));
            }
            if let Some(base64) = &doc.base64_content {
                total = total.saturating_add(base64.len() / 4);
            }
        }
    }
    total
}

fn is_pinned_history_message(msg: &LegacyChatMessage) -> bool {
    is_transient_llm_only_message(msg)
        || msg.metadata.as_ref().is_some_and(|metadata| {
            metadata.get("kind").and_then(Value::as_str) == Some("compaction_summary")
        })
}

fn group_history_units(history: &[LegacyChatMessage]) -> Vec<HistoryUnit> {
    let mut units = Vec::new();
    let mut i = 0usize;

    while i < history.len() {
        let start = i;
        let mut end = i + 1;
        let pinned = is_pinned_history_message(&history[i]);
        if !pinned {
            while end < history.len()
                && !is_pinned_history_message(&history[end])
                && history[end].role != "user"
            {
                end += 1;
            }
        }
        let total = history[start..end]
            .iter()
            .map(history_unit_token_estimate)
            .sum();

        units.push(HistoryUnit {
            start,
            end,
            is_pinned: pinned,
            token_estimate: total,
        });
        i = end;
    }

    units
}

// ============================================================
// 类型转换实现
// ============================================================

/// 从 RagSourceInfo 转换为 SourceInfo
impl From<RagSourceInfo> for SourceInfo {
    fn from(rag: RagSourceInfo) -> Self {
        Self {
            title: Some(rag.file_name.clone()),
            url: None,
            snippet: Some(rag.chunk_text.clone()),
            score: Some(rag.score),
            metadata: Some(json!({
                "documentId": rag.document_id,
                "chunkIndex": rag.chunk_index,
            })),
        }
    }
}

// ============================================================
// 辅助函数（改进 3 & 5）
// ============================================================

/// 过滤低相关性的检索结果（改进 3）
///
/// 使用阈值过滤和动态截断策略：
/// 1. 绝对阈值：score < min_score 的结果直接剔除
/// 2. 相对阈值：score < max_score * relative_threshold 的结果剔除
/// 3. 最大保留：保留最多 max_results 条结果
///
/// # 参数
/// - `sources`: 原始检索结果
/// - `min_score`: 绝对最低分阈值
/// - `relative_threshold`: 相对阈值（相对于最高分的比例）
/// - `max_results`: 最大保留数量
///
/// # 返回
/// 过滤后的检索结果（已按分数排序）
pub(crate) fn filter_retrieval_results(
    sources: Vec<SourceInfo>,
    min_score: f32,
    relative_threshold: f32,
    max_results: usize,
) -> Vec<SourceInfo> {
    if sources.is_empty() {
        return sources;
    }

    // 获取最高分
    let max_score = sources
        .iter()
        .filter_map(|s| s.score)
        .fold(0.0f32, |a, b| a.max(b));

    // 计算动态阈值：取绝对阈值和相对阈值中的较大者
    let dynamic_threshold = min_score.max(max_score * relative_threshold);

    // 过滤后按分数降序再截断，避免输入无序时丢失高分结果
    let before_count = sources.len();
    let mut sorted_all = sources.clone();
    sorted_all.sort_by(|a, b| {
        b.score
            .unwrap_or(0.0)
            .partial_cmp(&a.score.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let mut filtered: Vec<SourceInfo> = sources
        .into_iter()
        .filter(|s| s.score.unwrap_or(0.0) >= dynamic_threshold)
        .collect();

    filtered.sort_by(|a, b| {
        b.score
            .unwrap_or(0.0)
            .partial_cmp(&a.score.unwrap_or(0.0))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // 全部被阈值过滤时，保留 top1 作为保底，避免“有召回但被全滤空”导致上下文断裂。
    if filtered.is_empty() && !sorted_all.is_empty() {
        filtered.push(sorted_all[0].clone());
    }

    filtered.truncate(max_results);

    let after_count = filtered.len();
    if before_count != after_count {
        log::debug!(
            "[ChatV2::pipeline] Filtered retrieval results: {} -> {} (threshold={:.3}, max_score={:.3})",
            before_count,
            after_count,
            dynamic_threshold,
            max_score
        );
    }

    filtered
}

/// Normalize tool names for LLM APIs and reject blank names early.
pub(crate) fn normalize_tool_name_for_api(name: &str) -> Option<String> {
    encode_tool_name_for_api(name)
}

pub(crate) fn external_tool_raw_name(tool_name: &str) -> String {
    if tool_name.starts_with(BUILTIN_NAMESPACE) {
        tool_name.to_string()
    } else {
        format!("{}{}", EXTERNAL_MCP_TOOL_PREFIX, tool_name)
    }
}

#[derive(Debug, Clone)]
pub(crate) struct PreparedExternalToolSchema {
    pub api_name: String,
    pub raw_tool_name: String,
    pub preferred_server_id: Option<String>,
    pub schema: Value,
}

/// 加载 MCP 工具策略（whitelist/blacklist），并应用 `mcp.tools.advertise_all_tools`。
///
/// 三态语义（由 `is_mcp_tool_allowed_by_policy` 的"空白名单=全放行"配合实现）：
/// - advertise_all = true                → 返回空白名单（跳过白名单过滤，黑名单仍然生效）；
/// - advertise_all = false 且白名单非空  → 按白名单过滤（现行为）；
/// - advertise_all = false 且白名单为空  → 全放行（保持既有默认，不能突然禁掉用户工具）。
pub(crate) fn load_mcp_tool_policy(
    main_db: Option<&Arc<MainDatabase>>,
) -> (Vec<String>, Vec<String>) {
    let load_list = |key: &str| -> Vec<String> {
        main_db
            .and_then(|db| db.get_setting(key).ok().flatten())
            .map(|raw| {
                raw.split(',')
                    .map(str::trim)
                    .filter(|entry| !entry.is_empty())
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };
    let advertise_all = main_db
        .and_then(|db| {
            db.get_setting("mcp.tools.advertise_all_tools")
                .ok()
                .flatten()
        })
        .map(|raw| matches!(raw.trim().to_ascii_lowercase().as_str(), "true" | "1"))
        .unwrap_or(false);
    let whitelist = if advertise_all {
        Vec::new()
    } else {
        load_list("mcp.tools.whitelist")
    };
    (whitelist, load_list("mcp.tools.blacklist"))
}

/// Deny-first MCP policy shared by single- and multi-variant pipelines.
/// Only schemas without an external server identity are trusted builtins.
/// 空白名单 = 全放行；advertise_all_tools 通过 `load_mcp_tool_policy`
/// 清空白名单来实现"广告全部工具"（黑名单始终 deny-first）。
pub(crate) fn is_mcp_tool_allowed_by_policy(
    tool: &crate::chat_v2::types::McpToolSchema,
    whitelist: &[String],
    blacklist: &[String],
) -> bool {
    if blacklist.iter().any(|blocked| blocked == &tool.name) {
        return false;
    }
    if tool.server_id.is_none() && tool.name.starts_with(BUILTIN_NAMESPACE) {
        return true;
    }
    whitelist.is_empty() || whitelist.iter().any(|allowed| allowed == &tool.name)
}

pub(crate) fn prepare_external_tool_schema(
    tool: &crate::chat_v2::types::McpToolSchema,
    include_server_suffix: bool,
) -> Option<PreparedExternalToolSchema> {
    if tool
        .server_id
        .as_deref()
        .is_some_and(|server_id| server_id.trim().is_empty())
    {
        return None;
    }
    // `load_skills` is a trusted local control tool when it has no MCP source.
    // Giving it the generic `mcp_` prefix makes the executor registry route it
    // to the external bridge instead of SkillsExecutor. An external server that
    // advertises the same name must remain isolated behind the MCP namespace.
    let trusted_load_skills = tool.server_id.is_none()
        && matches!(
            tool.name.as_str(),
            "load_skills" | "builtin-load_skills" | "builtin:load_skills" | "mcp_load_skills"
        );
    let bridge_name = if trusted_load_skills {
        "load_skills"
    } else {
        tool.name.as_str()
    };
    let prepared = prepare_external_tool(
        bridge_name,
        tool.server_id.as_deref(),
        tool.description.as_deref(),
        tool.input_schema.as_ref(),
        CanonicalExternalToolConfig {
            internal_prefix: Some(if trusted_load_skills {
                BUILTIN_NAMESPACE
            } else {
                EXTERNAL_MCP_TOOL_PREFIX
            }),
            // `server_id` is the source marker for selected external MCP
            // schemas. Only trusted builtin/skill schemas (no server_id) may
            // retain `builtin-`; otherwise an external server could claim a
            // builtin executor name and cross the execution boundary.
            preserve_prefix: tool.server_id.is_none().then_some(BUILTIN_NAMESPACE),
            api_name_prefix: None,
            include_server_suffix: include_server_suffix && tool.server_id.is_some(),
            api_name_source: ApiNameSource::InternalToolName,
        },
    )?;

    Some(PreparedExternalToolSchema {
        api_name: prepared.api_name,
        raw_tool_name: prepared.internal_tool_name,
        preferred_server_id: prepared.preferred_server_id,
        schema: prepared.schema,
    })
}

pub(crate) fn approval_scope_setting_key(tool_name: &str, arguments: &Value) -> String {
    // 🔧 M-081 修复（P2）：统一入口，v2 优先，未知工具 fallback v1
    use crate::chat_v2::approval_scope;
    approval_scope::make_setting_key(tool_name, arguments)
}

/// 工具审批结果枚举
///
/// 区分用户主动操作与系统异常，使调用方能给出精确的错误消息。
/// - `Approved`：用户同意执行
/// - `Rejected`：用户明确拒绝
/// - `Timeout`：等待审批超时
/// - `ChannelClosed`：审批通道异常关闭
/// - `Cancelled`：流被取消（用户停止生成），无需继续等待
pub(crate) enum ApprovalOutcome {
    /// 用户同意执行
    Approved,
    /// 用户明确拒绝（可携带用户填写的拒绝理由，回传给模型）
    Rejected { reason: Option<String> },
    /// 等待审批超时
    Timeout,
    /// 审批通道异常关闭
    ChannelClosed,
    /// 流被取消（用户停止生成）
    Cancelled,
}

/// LLM 流式等待结果（🔧 F2 修复）
pub(crate) enum LlmStreamWaitOutcome<T> {
    /// LLM 调用完成（成功或失败由内层 Result 表达）
    Completed(T),
    /// 空闲超时：连续 idle_secs 秒未收到任何流式数据
    IdleTimeout { idle_secs: u64 },
    /// 绝对时长超限：总时长达到上限（防御病态慢滴流）
    TotalTimeout { total_secs: u64 },
}

/// 聊天流空闲超时配置（每次请求时从设置读取，改动无需重启即生效）
///
/// 对应设置界面「参数调整」分区：
/// - `chat.stream.timeout_ms`：空闲超时毫秒数，空/非法/0 回退默认 `LLM_STREAM_TIMEOUT_SECS`；
/// - `chat.stream.auto_cancel_on_timeout`：默认 true；false 时空闲超时仅告警不断流
///   （绝对上限 `LLM_STREAM_MAX_TOTAL_SECS` 仍然生效）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct StreamIdleConfig {
    pub idle_limit: Duration,
    pub cancel_on_idle: bool,
}

pub(crate) fn load_stream_idle_config(main_db: Option<&Arc<MainDatabase>>) -> StreamIdleConfig {
    let read = |key: &str| main_db.and_then(|db| db.get_setting(key).ok().flatten());
    let idle_secs = read("chat.stream.timeout_ms")
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|ms| *ms > 0)
        .map(|ms| ms.div_ceil(1000).max(1))
        .unwrap_or(LLM_STREAM_TIMEOUT_SECS);
    let cancel_on_idle = read("chat.stream.auto_cancel_on_timeout")
        .map(|raw| {
            let lowered = raw.trim().to_ascii_lowercase();
            !(lowered == "0" || lowered == "false")
        })
        .unwrap_or(true);
    StreamIdleConfig {
        idle_limit: Duration::from_secs(idle_secs),
        cancel_on_idle,
    }
}

/// 以「空闲超时 + 绝对上限」语义等待 LLM 流式调用完成（🔧 F2 修复）
///
/// 旧实现 `timeout(LLM_STREAM_TIMEOUT_SECS, llm_future)` 把 600s 当作整个流的
/// 总时长上限：长 agentic 生成（>10min）即使流式健康也会被强制掐断。
/// 新语义：
/// - 每 10s 醒来检查一次 `idle_elapsed()`（由 adapter 在每次收到 chunk 时刷新）；
/// - 连续 `idle_limit` 无任何数据 → `IdleTimeout`（真正的挂起）；
/// - 总时长达到 `total_limit` → `TotalTimeout`（防御性绝对上限）。
///
/// `cancel_on_idle`（对应设置 `chat.stream.auto_cancel_on_timeout`）为 false 时，
/// 空闲超时不再返回 `IdleTimeout` 断流，仅在首次越限时打一条 warn 日志继续等待；
/// 绝对上限 `total_limit` 不受该开关影响。
pub(crate) async fn wait_llm_stream_with_idle_timeout<F>(
    fut: F,
    idle_limit: std::time::Duration,
    total_limit: std::time::Duration,
    cancel_on_idle: bool,
    idle_elapsed: impl Fn() -> std::time::Duration,
) -> LlmStreamWaitOutcome<F::Output>
where
    F: std::future::Future,
{
    const CHECK_INTERVAL: std::time::Duration = std::time::Duration::from_secs(10);
    let started = std::time::Instant::now();
    let mut idle_warned = false;
    tokio::pin!(fut);
    loop {
        match tokio::time::timeout(CHECK_INTERVAL, &mut fut).await {
            Ok(output) => return LlmStreamWaitOutcome::Completed(output),
            Err(_) => {
                let idle = idle_elapsed();
                if idle >= idle_limit {
                    if cancel_on_idle {
                        return LlmStreamWaitOutcome::IdleTimeout {
                            idle_secs: idle.as_secs(),
                        };
                    }
                    if !idle_warned {
                        idle_warned = true;
                        log::warn!(
                            "[ChatV2::pipeline] LLM stream idle for {}s (limit {}s); auto_cancel_on_timeout=false, keep waiting until absolute limit {}s",
                            idle.as_secs(),
                            idle_limit.as_secs(),
                            total_limit.as_secs()
                        );
                    }
                } else if idle_warned {
                    // 恢复收到数据后重置告警，允许下次再次越限时提示
                    idle_warned = false;
                }
                let total = started.elapsed();
                if total >= total_limit {
                    return LlmStreamWaitOutcome::TotalTimeout {
                        total_secs: total.as_secs(),
                    };
                }
            }
        }
    }
}

/// 验证工具调用链完整性（改进 5）
///
/// 检查聊天历史中的工具调用链是否完整：
/// - 每个 tool_call 必须有对应的 tool_result
/// - 记录未完成的调用数量
///
/// # 返回
/// - true: 工具链完整
/// - false: 存在未完成的工具调用
pub(crate) fn validate_tool_chain(chat_history: &[LegacyChatMessage]) -> bool {
    use std::collections::HashSet;

    let mut pending_calls: HashSet<String> = HashSet::new();

    for msg in chat_history {
        // 记录新的工具调用
        if let Some(ref tc) = msg.tool_call {
            pending_calls.insert(tc.id.clone());
        }
        // 移除已完成的工具调用
        if let Some(ref tr) = msg.tool_result {
            pending_calls.remove(&tr.call_id);
        }
    }

    if !pending_calls.is_empty() {
        log::warn!(
            "[ChatV2::pipeline] Incomplete tool chain detected: {} pending call(s): {:?}",
            pending_calls.len(),
            pending_calls
        );
    }

    pending_calls.is_empty()
}

/// 🔧 P0-2 修复：修复破损的工具调用链，保证送往 LLM 的消息序列协议合法。
///
/// 之前 `validate_tool_chain` 只 warn 不修复，破损序列仍被送给 provider，
/// 会触发协议错误（如 OpenAI "tool_calls must be followed by tool messages"、
/// Anthropic "unexpected tool_use_id"）。本函数做两类修复：
/// 1. **悬挂 tool_call**（有调用无结果）：在该 assistant(tool_call) 消息及其后
///    连续 tool 消息之后，合成一条占位 tool 结果消息（"result unavailable"），
///    让 LLM 知道该调用未完成而非协议断裂；
/// 2. **孤儿 tool result**（有结果无调用）：直接丢弃该 tool 消息。
///
/// 仅在 `validate_tool_chain` 返回 false 时调用（正常路径零开销）。
pub(crate) fn repair_tool_chain(chat_history: &mut Vec<LegacyChatMessage>) {
    use std::collections::HashSet;

    let call_ids: HashSet<String> = chat_history
        .iter()
        .filter_map(|m| m.tool_call.as_ref().map(|tc| tc.id.clone()))
        .collect();
    let result_ids: HashSet<String> = chat_history
        .iter()
        .filter_map(|m| m.tool_result.as_ref().map(|tr| tr.call_id.clone()))
        .collect();

    // 1. 丢弃孤儿 tool result（无对应 tool_call）
    let before_len = chat_history.len();
    chat_history.retain(|m| {
        m.tool_result
            .as_ref()
            .map(|tr| call_ids.contains(&tr.call_id))
            .unwrap_or(true)
    });
    let dropped_orphans = before_len - chat_history.len();

    // 2. 为悬挂 tool_call 合成占位结果消息
    let dangling: Vec<String> = call_ids.difference(&result_ids).cloned().collect();
    let mut synthesized = 0usize;
    for call_id in &dangling {
        // 定位携带该 tool_call 的 assistant 消息
        let Some(call_idx) = chat_history
            .iter()
            .position(|m| m.tool_call.as_ref().is_some_and(|tc| tc.id == *call_id))
        else {
            continue;
        };
        // 跳过其后连续的 tool 结果消息（保持同轮 tool 消息分组不被打断）
        let mut insert_at = call_idx + 1;
        while insert_at < chat_history.len() && chat_history[insert_at].tool_result.is_some() {
            insert_at += 1;
        }

        let placeholder = "Error: tool result unavailable (execution was interrupted before a result was recorded)";
        let mut tool_msg = make_empty_message("tool", placeholder.to_string());
        tool_msg.tool_result = Some(crate::models::ToolResult {
            call_id: call_id.clone(),
            ok: false,
            error: Some(placeholder.to_string()),
            error_details: None,
            data_json: None,
            usage: None,
            citations: None,
        });
        chat_history.insert(insert_at, tool_msg);
        synthesized += 1;
    }

    if dropped_orphans > 0 || synthesized > 0 {
        log::warn!(
            "[ChatV2::pipeline] Repaired broken tool chain: dropped {} orphan tool result(s), synthesized {} placeholder result(s) for dangling call(s): {:?}",
            dropped_orphans,
            synthesized,
            dangling
        );
    }
}

/// 构建一个仅含 role/content 的空 ChatMessage，其余字段均为 None/默认值。
/// 用于合成消息构造，避免重复罗列 15+ 个 None 字段。
pub(crate) fn make_empty_message(role: &str, content: String) -> LegacyChatMessage {
    LegacyChatMessage {
        role: role.to_string(),
        content,
        timestamp: chrono::Utc::now(),
        thinking_content: None,
        thought_signature: None,
        rag_sources: None,
        memory_sources: None,
        graph_sources: None,
        web_search_sources: None,
        image_paths: None,
        image_base64: None,
        doc_attachments: None,
        multimodal_content: None,
        tool_call: None,
        tool_result: None,
        overrides: None,
        relations: None,
        persistent_stable_id: None,
        metadata: None,
    }
}

const TRANSIENT_SKILL_METADATA_KIND: &str = "skill_instruction";
const TRANSIENT_REQUEST_ANCHOR_METADATA_KIND: &str = "request_context_anchor";

#[derive(Debug, Clone, Default)]
pub(crate) struct SkillInjectionAudit {
    pub injected_skill_ids: Vec<String>,
    pub dropped_skill_ids: Vec<String>,
    pub missing_skill_ids: Vec<String>,
    pub estimated_tokens: usize,
    pub skill_state_version: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct TransientSkillMessages {
    pub messages: Vec<LegacyChatMessage>,
    pub audit: SkillInjectionAudit,
}

pub(crate) fn is_transient_skill_message(msg: &LegacyChatMessage) -> bool {
    msg.metadata.as_ref().is_some_and(|metadata| {
        metadata.get("kind").and_then(Value::as_str) == Some(TRANSIENT_SKILL_METADATA_KIND)
            && metadata
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false)
    })
}

pub(crate) fn is_transient_llm_only_message(msg: &LegacyChatMessage) -> bool {
    is_transient_skill_message(msg)
        || msg.metadata.as_ref().is_some_and(|metadata| {
            metadata.get("kind").and_then(Value::as_str)
                == Some(TRANSIENT_REQUEST_ANCHOR_METADATA_KIND)
                && metadata
                    .get("hidden")
                    .and_then(Value::as_bool)
                    .unwrap_or(false)
        })
}

fn escape_xml_attr(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('"', "&quot;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn push_skill_with_dependencies(
    skill_id: &str,
    tier: u8,
    dependencies: Option<&HashMap<String, Vec<String>>>,
    seen: &mut HashSet<String>,
    visiting: &mut HashSet<String>,
    ordered: &mut Vec<(String, u8)>,
) {
    if seen.contains(skill_id) {
        return;
    }
    if !visiting.insert(skill_id.to_string()) {
        log::warn!(
            "[ChatV2::pipeline] Skill dependency cycle detected at '{}'; skipping recursive edge",
            skill_id
        );
        return;
    }

    if let Some(deps) = dependencies.and_then(|map| map.get(skill_id)) {
        let mut deps = deps.clone();
        deps.sort();
        deps.dedup();
        for dep in deps {
            push_skill_with_dependencies(&dep, tier, dependencies, seen, visiting, ordered);
        }
    }

    visiting.remove(skill_id);
    if seen.insert(skill_id.to_string()) {
        ordered.push((skill_id.to_string(), tier));
    }
}

fn ordered_skill_ids_for_injection(
    skill_state: &super::super::types::SessionSkillState,
    dependencies: Option<&HashMap<String, Vec<String>>>,
) -> Vec<(String, u8)> {
    let mut ordered = Vec::new();
    let mut seen = HashSet::new();
    let mut visiting = HashSet::new();

    let mut push_group = |ids: &[String], tier: u8| {
        let mut sorted = ids.to_vec();
        sorted.sort();
        sorted.dedup();
        for skill_id in sorted {
            push_skill_with_dependencies(
                &skill_id,
                tier,
                dependencies,
                &mut seen,
                &mut visiting,
                &mut ordered,
            );
        }
    };

    push_group(&skill_state.manual_pinned_skill_ids, 0);
    push_group(&skill_state.mode_required_bundle_ids, 1);
    push_group(&skill_state.agentic_session_skill_ids, 2);
    push_group(&skill_state.branch_local_skill_ids, 3);

    ordered
}

fn make_transient_skill_message(skill_id: &str, content: &str) -> LegacyChatMessage {
    let mut msg = make_empty_message(
        "user",
        format!(
            "<skill_instructions id=\"{}\">\n{}\n</skill_instructions>",
            escape_xml_attr(skill_id),
            content
        ),
    );
    msg.metadata = Some(json!({
        "kind": TRANSIENT_SKILL_METADATA_KIND,
        "hidden": true,
        "skillId": skill_id,
    }));
    msg
}

fn make_transient_request_anchor_message() -> LegacyChatMessage {
    let mut msg = make_empty_message(
        "user",
        "<request_context>Transient skill instructions for this request follow.</request_context>"
            .to_string(),
    );
    msg.metadata = Some(json!({
        "kind": TRANSIENT_REQUEST_ANCHOR_METADATA_KIND,
        "hidden": true,
    }));
    msg
}

pub(crate) fn insert_transient_skill_messages(
    messages: &mut Vec<LegacyChatMessage>,
    insertion_index: usize,
    transient_skill_messages: Vec<LegacyChatMessage>,
) {
    if transient_skill_messages.is_empty() {
        return;
    }

    let mut insert_at = insertion_index.min(messages.len());
    if insert_at == 0 {
        messages.insert(0, make_transient_request_anchor_message());
        insert_at = 1;
    }

    messages.splice(insert_at..insert_at, transient_skill_messages);
}

pub(crate) fn build_transient_skill_messages(
    skill_state: &super::super::types::SessionSkillState,
    skill_contents: &HashMap<String, String>,
    skill_dependencies: Option<&HashMap<String, Vec<String>>>,
    token_budget: Option<usize>,
) -> Vec<LegacyChatMessage> {
    build_transient_skill_messages_with_audit(
        skill_state,
        skill_contents,
        skill_dependencies,
        token_budget,
    )
    .messages
}

pub(crate) fn build_transient_skill_messages_with_audit(
    skill_state: &super::super::types::SessionSkillState,
    skill_contents: &HashMap<String, String>,
    skill_dependencies: Option<&HashMap<String, Vec<String>>>,
    token_budget: Option<usize>,
) -> TransientSkillMessages {
    let mut result = TransientSkillMessages {
        audit: SkillInjectionAudit {
            skill_state_version: skill_state.version,
            ..Default::default()
        },
        ..Default::default()
    };

    let ordered_skill_ids = ordered_skill_ids_for_injection(skill_state, skill_dependencies);
    if ordered_skill_ids.is_empty() {
        return result;
    }

    let mut remaining_budget = token_budget.unwrap_or(usize::MAX);
    for (skill_id, _tier) in ordered_skill_ids {
        let Some(content) = skill_contents.get(&skill_id) else {
            log::warn!(
                "[ChatV2::pipeline] Transient skill injection skipped missing content: {}",
                skill_id
            );
            result.audit.missing_skill_ids.push(skill_id);
            continue;
        };

        let message = make_transient_skill_message(&skill_id, content);
        let estimated_tokens = estimate_token_count(&message.content);
        if estimated_tokens > remaining_budget {
            result.audit.dropped_skill_ids.push(skill_id);
            continue;
        }

        remaining_budget = remaining_budget.saturating_sub(estimated_tokens);
        result.audit.estimated_tokens += estimated_tokens;
        result.audit.injected_skill_ids.push(skill_id);
        result.messages.push(message);
    }

    result
}

impl ChatV2Pipeline {
    /// 🆕 发射 `context_trimmed` 事件（消费 ctx 上挂起的截断报告）。
    ///
    /// 去重策略：同一轮流式（同一个 PipelineContext 生命周期）内最多发一次，
    /// 避免工具环内多次重载历史时刷屏。
    pub(crate) fn notify_context_trimmed(
        &self,
        ctx: &mut PipelineContext,
        emitter: &ChatV2EventEmitter,
    ) {
        let Some(report) = ctx.pending_context_trim.take() else {
            return;
        };
        if report.dropped_messages == 0 || ctx.context_trim_notified {
            return;
        }
        ctx.context_trim_notified = true;
        emitter.emit_context_trimmed(
            report.dropped_messages,
            (report.dropped_tokens > 0).then_some(report.dropped_tokens),
        );
    }

    pub(crate) fn load_effective_session_skill_state(
        &self,
        session_id: &str,
        options: &SendOptions,
    ) -> super::super::types::SessionSkillState {
        let replay_with_runtime_snapshot = options.replay_mode
            == Some(super::super::types::ReplayMode::Original)
            && options.replay_skill_contents.is_some();
        let mut state = if replay_with_runtime_snapshot {
            super::super::types::SessionSkillState::default()
        } else {
            match ChatV2Repo::load_session_state_v2(&self.db, session_id) {
                Ok(Some(state)) => state.resolved_skill_state(),
                Ok(None) => super::super::types::SessionSkillState::default(),
                Err(err) => {
                    log::warn!(
                        "[ChatV2::pipeline] Failed to load session skill state for transient injection: session_id={}, error={}",
                        session_id,
                        err
                    );
                    super::super::types::SessionSkillState::default()
                }
            }
        };

        if let Some(active_ids) = &options.active_skill_ids {
            state.manual_pinned_skill_ids = active_ids.clone();
            state.manual_pinned_skill_ids.sort();
            state.manual_pinned_skill_ids.dedup();
        }

        if let Some(replay_skill_contents) = options.replay_skill_contents.as_ref() {
            if options.replay_mode == Some(super::super::types::ReplayMode::Original) {
                let pinned: HashSet<String> =
                    state.manual_pinned_skill_ids.iter().cloned().collect();
                let mut replay_loaded_ids: Vec<String> = replay_skill_contents
                    .keys()
                    .filter(|skill_id| !pinned.contains(*skill_id))
                    .cloned()
                    .collect();
                replay_loaded_ids.sort();
                replay_loaded_ids.dedup();
                state.agentic_session_skill_ids = replay_loaded_ids;
            }
        }

        state
    }
}

/// 启发式估算文本的 token 数量（支持中英混排）
///
/// 🔧 P1-5 修复：统一到 `utils::token_budget::estimate_tokens` 单一口径，
/// 消除与 `history_unit_token_estimate`（同文件上方，已用 token_budget）的
/// 双轨漂移。本函数仅作转发别名保留，勿在此重新实现估算逻辑。
pub(crate) fn estimate_token_count(text: &str) -> usize {
    crate::utils::token_budget::estimate_tokens(text)
}

/// FIFO 截断结果（供 `context_trimmed` 事件上报使用）
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct TrimOutcome {
    /// 实际丢弃的消息条数
    pub dropped_messages: usize,
    /// 丢弃消息的估算 token 总量
    pub dropped_tokens: usize,
}

/// 按 token 预算裁剪聊天历史（从最旧消息开始移除）
///
/// 🆕 返回实际丢弃的消息数与估算 token 量；调用方据此发射 `context_trimmed`
/// 事件让用户感知"无声丢消息"（仅在 dropped_messages > 0 时应发射）。
pub(crate) fn trim_history_by_token_budget(
    history: &mut Vec<LegacyChatMessage>,
    max_tokens: usize,
) -> TrimOutcome {
    let units = group_history_units(history);
    let mut total_tokens: usize = units.iter().map(|u| u.token_estimate).sum();

    let original_len = history.len();
    let mut dropped_tokens = 0usize;
    let mut removable_units: Vec<HistoryUnit> =
        units.into_iter().filter(|u| !u.is_pinned).collect();

    while total_tokens > max_tokens && removable_units.len() > 2 {
        let Some(unit) = removable_units.first().cloned() else {
            break;
        };
        history.drain(unit.start..unit.end);
        total_tokens = total_tokens.saturating_sub(unit.token_estimate);
        dropped_tokens = dropped_tokens.saturating_add(unit.token_estimate);
        removable_units.remove(0);

        for remaining in &mut removable_units {
            if remaining.start >= unit.end {
                remaining.start -= unit.end - unit.start;
                remaining.end -= unit.end - unit.start;
            }
        }
    }

    let dropped_messages = original_len - history.len();
    if dropped_messages > 0 {
        log::info!(
            "[ChatV2::pipeline] Token budget trim: {} -> {} messages (budget={}, remaining≈{})",
            original_len,
            history.len(),
            max_tokens,
            total_tokens
        );
    }
    TrimOutcome {
        dropped_messages,
        dropped_tokens,
    }
}

// ============================================================
// 🆕 零成本前置层：microcompact 式旧工具输出占位符化
// ============================================================

/// 保留最近 K 个 user 轮的工具输出原文；更早轮次的工具输出替换为占位符。
pub(crate) const MICROCOMPACT_KEEP_RECENT_USER_TURNS: usize = 3;
/// 小于该 token 量的工具输出不值得占位符化（占位符本身也占空间）
const MICROCOMPACT_MIN_TOKENS: usize = 256;

/// 无损瘦身：把「最近 K 个 user 轮之外」的旧工具调用输出替换为占位符。
///
/// - 仅影响发给模型的内存视图，不动数据库（原文仍在会话记录中）；
/// - 不破坏 tool call/result 配对：tool_result 结构保留（call_id 不变），
///   只替换 content 与 data_json 的内容，`validate_tool_chain` 不受影响；
/// - pinned 消息（瞬态技能注入 / compaction summary 伪消息）不受影响；
/// - 占位符对相同输入是确定性的（token 估算确定），跨轮次重建视图时
///   前缀稳定，不会反复打破 provider prompt cache。
///
/// 返回被占位符化的工具输出条数。
pub(crate) fn microcompact_old_tool_outputs(
    history: &mut [LegacyChatMessage],
    keep_recent_user_turns: usize,
) -> usize {
    // 以真实 user 消息（非 pinned）为轮次边界，找到「最近 K 轮」的起点。
    let user_indices: Vec<usize> = history
        .iter()
        .enumerate()
        .filter(|(_, m)| m.role == "user" && !is_pinned_history_message(m))
        .map(|(i, _)| i)
        .collect();
    if user_indices.len() <= keep_recent_user_turns {
        return 0;
    }
    let protect_from = user_indices[user_indices.len() - keep_recent_user_turns];

    // call_id -> tool_name 映射（占位符里带上工具名，帮助模型理解被省略的内容）
    let tool_names: HashMap<String, String> = history
        .iter()
        .filter_map(|m| {
            m.tool_call
                .as_ref()
                .map(|tc| (tc.id.clone(), tc.tool_name.clone()))
        })
        .collect();

    let mut replaced = 0usize;
    for msg in history.iter_mut().take(protect_from) {
        if is_pinned_history_message(msg) {
            continue;
        }
        let Some(tool_result) = msg.tool_result.as_mut() else {
            continue;
        };
        let tokens = estimate_token_count(&msg.content);
        if tokens < MICROCOMPACT_MIN_TOKENS {
            continue;
        }
        let tool_name = tool_names
            .get(&tool_result.call_id)
            .map(String::as_str)
            .unwrap_or("unknown");
        let placeholder = format!(
            "[旧工具输出已省略：{}，原约 {} tokens；原文保留在会话记录中]",
            tool_name, tokens
        );
        msg.content = placeholder.clone();
        tool_result.data_json = Some(Value::String(placeholder));
        replaced += 1;
    }
    replaced
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_transient_skill_messages_orders_dependencies_before_parents() {
        let skill_state = crate::chat_v2::types::SessionSkillState {
            manual_pinned_skill_ids: vec!["manual-a".to_string()],
            agentic_session_skill_ids: vec!["agentic-a".to_string()],
            branch_local_skill_ids: vec!["branch-a".to_string()],
            version: 7,
            ..Default::default()
        };
        let skill_contents = HashMap::from([
            ("dep-a".to_string(), "dependency-a".to_string()),
            ("manual-a".to_string(), "manual-body".to_string()),
            ("agentic-a".to_string(), "agentic-body".to_string()),
            ("dep-b".to_string(), "dependency-b".to_string()),
            ("branch-a".to_string(), "branch-body".to_string()),
        ]);
        let skill_dependencies = HashMap::from([
            ("manual-a".to_string(), vec!["dep-a".to_string()]),
            ("branch-a".to_string(), vec!["dep-b".to_string()]),
        ]);

        let injected = build_transient_skill_messages_with_audit(
            &skill_state,
            &skill_contents,
            Some(&skill_dependencies),
            None,
        );

        assert_eq!(
            injected.audit.injected_skill_ids,
            vec![
                "dep-a".to_string(),
                "manual-a".to_string(),
                "agentic-a".to_string(),
                "dep-b".to_string(),
                "branch-a".to_string(),
            ]
        );
        assert_eq!(injected.audit.skill_state_version, 7);
        assert_eq!(injected.messages.len(), 5);
        assert!(injected.messages.iter().all(is_transient_skill_message));
    }

    #[test]
    fn test_insert_transient_skill_messages_keeps_skill_instruction_off_first_position() {
        let mut messages = Vec::new();
        insert_transient_skill_messages(
            &mut messages,
            0,
            vec![make_transient_skill_message("skill-a", "private body")],
        );

        assert_eq!(messages.len(), 2);
        assert!(is_transient_llm_only_message(&messages[0]));
        assert!(!is_transient_skill_message(&messages[0]));
        assert!(is_transient_skill_message(&messages[1]));
    }

    #[test]
    fn test_trim_history_by_token_budget_preserves_transient_skill_messages() {
        let mut history = vec![
            make_empty_message("user", "oldest user message".to_string()),
            make_transient_skill_message("skill-a", "skill body"),
            make_empty_message("assistant", "assistant reply".to_string()),
            make_empty_message("user", "latest user turn".to_string()),
        ];

        trim_history_by_token_budget(
            &mut history,
            estimate_token_count("skill bodyassistant replylatest user turn"),
        );

        assert_eq!(history.len(), 3);
        assert!(is_transient_skill_message(&history[0]));
        assert_eq!(history[1].content, "assistant reply");
        assert_eq!(history[2].content, "latest user turn");
    }

    #[test]
    fn test_trim_history_by_token_budget_counts_tool_payloads() {
        let mut tool_call_message = make_empty_message("assistant", String::new());
        tool_call_message.tool_call = Some(crate::models::ToolCall {
            id: "call-1".to_string(),
            tool_name: "builtin_fetch".to_string(),
            args_json: json!({ "payload": "x".repeat(4000) }),
        });

        let mut tool_result_message = make_empty_message("tool", "ok".to_string());
        tool_result_message.tool_result = Some(crate::models::ToolResult {
            call_id: "call-1".to_string(),
            ok: true,
            error: None,
            error_details: None,
            data_json: Some(json!({ "result": "y".repeat(4000) })),
            usage: None,
            citations: None,
        });

        let mut history = vec![
            make_empty_message("user", "oldest user message".to_string()),
            tool_call_message,
            tool_result_message,
            make_empty_message("assistant", "latest assistant reply".to_string()),
            make_empty_message("user", "latest user turn".to_string()),
        ];

        trim_history_by_token_budget(
            &mut history,
            estimate_token_count("latest assistant replylatest user turn"),
        );

        assert_eq!(history.len(), 2);
        assert_eq!(history[0].content, "latest assistant reply");
        assert_eq!(history[1].content, "latest user turn");
    }

    #[test]
    fn test_trim_history_by_token_budget_removes_complete_tool_rounds() {
        let mut tool_call_message = make_empty_message("assistant", String::new());
        tool_call_message.tool_call = Some(crate::models::ToolCall {
            id: "call-1".to_string(),
            tool_name: "builtin_fetch".to_string(),
            args_json: json!({ "query": "enzyme kinetics" }),
        });

        let mut tool_result_message = make_empty_message("tool", "ok".to_string());
        tool_result_message.tool_result = Some(crate::models::ToolResult {
            call_id: "call-1".to_string(),
            ok: true,
            error: None,
            error_details: None,
            data_json: Some(json!({ "result": "Michaelis-Menten" })),
            usage: None,
            citations: None,
        });

        let mut history = vec![
            make_empty_message("user", "turn 1".to_string()),
            tool_call_message,
            tool_result_message,
            make_empty_message("assistant", "turn 2 assistant".to_string()),
            make_empty_message("user", "turn 2 user".to_string()),
        ];

        trim_history_by_token_budget(
            &mut history,
            estimate_token_count("turn 2 assistantturn 2 user"),
        );

        assert_eq!(history.len(), 2);
        assert!(history
            .iter()
            .all(|msg| msg.tool_call.is_none() && msg.tool_result.is_none()));
        assert_eq!(history[0].content, "turn 2 assistant");
        assert_eq!(history[1].content, "turn 2 user");
    }

    /// 🆕 trim 返回值：报告实际丢弃的条数与 token 估算，未丢弃时为零
    #[test]
    fn test_trim_history_reports_dropped_stats() {
        let mut history = vec![
            make_empty_message("user", "old ".repeat(200)),
            make_empty_message("assistant", "old reply ".repeat(200)),
            make_empty_message("user", "turn 2".to_string()),
            make_empty_message("assistant", "turn 2 reply".to_string()),
            make_empty_message("user", "latest".to_string()),
        ];

        // 预算充足 → 不丢弃
        let outcome = trim_history_by_token_budget(&mut history.clone(), usize::MAX);
        assert_eq!(outcome, TrimOutcome::default());

        // 预算紧张 → 丢弃最旧单元并上报统计
        let outcome = trim_history_by_token_budget(
            &mut history,
            estimate_token_count("turn 2turn 2 replylatest"),
        );
        assert!(outcome.dropped_messages > 0);
        assert!(outcome.dropped_tokens > 0);
        assert_eq!(outcome.dropped_messages, 5 - history.len());
    }

    /// 🆕 microcompact：旧轮次工具输出替换为占位符，最近 K 轮保留原文，
    /// 且 tool call/result 配对不被破坏（validate_tool_chain 仍通过）
    #[test]
    fn test_microcompact_replaces_only_old_tool_outputs() {
        let big_output = "tool output data ".repeat(200);
        let make_tool_round = |call_id: &str, user_text: &str| {
            let mut call = make_empty_message("assistant", String::new());
            call.tool_call = Some(crate::models::ToolCall {
                id: call_id.to_string(),
                tool_name: "web_search".to_string(),
                args_json: json!({ "q": "x" }),
            });
            let mut result = make_empty_message("tool", big_output.clone());
            result.tool_result = Some(crate::models::ToolResult {
                call_id: call_id.to_string(),
                ok: true,
                error: None,
                error_details: None,
                data_json: Some(json!({ "data": big_output.clone() })),
                usage: None,
                citations: None,
            });
            vec![
                make_empty_message("user", user_text.to_string()),
                call,
                result,
                make_empty_message("assistant", "answer".to_string()),
            ]
        };

        // 5 个 user 轮，前 2 轮的工具输出应被占位符化（K=3）
        let mut history: Vec<LegacyChatMessage> = Vec::new();
        for i in 0..5 {
            history.extend(make_tool_round(&format!("call-{}", i), &format!("turn {}", i)));
        }

        let replaced =
            microcompact_old_tool_outputs(&mut history, MICROCOMPACT_KEEP_RECENT_USER_TURNS);
        assert_eq!(replaced, 2, "只有最近 3 轮之外的 2 个工具输出被替换");

        // 被替换的是前两轮的 tool 消息
        let tool_msgs: Vec<&LegacyChatMessage> =
            history.iter().filter(|m| m.tool_result.is_some()).collect();
        assert_eq!(tool_msgs.len(), 5);
        assert!(tool_msgs[0].content.contains("旧工具输出已省略"));
        assert!(tool_msgs[0].content.contains("web_search"));
        assert!(tool_msgs[1].content.contains("旧工具输出已省略"));
        for recent in &tool_msgs[2..] {
            assert_eq!(recent.content, big_output, "最近 3 轮的工具输出必须保留原文");
        }
        // call_id 配对完整（占位符化不破坏工具链协议）
        assert!(validate_tool_chain(&history));
    }

    /// 🆕 microcompact：pinned 消息（技能注入/压缩摘要伪消息）与短输出不受影响
    #[test]
    fn test_microcompact_skips_pinned_and_small_outputs() {
        let mut small_result = make_empty_message("tool", "tiny".to_string());
        small_result.tool_result = Some(crate::models::ToolResult {
            call_id: "call-small".to_string(),
            ok: true,
            error: None,
            error_details: None,
            data_json: Some(json!("tiny")),
            usage: None,
            citations: None,
        });
        let mut summary_msg = make_empty_message("user", "compacted summary".to_string());
        summary_msg.metadata = Some(json!({ "kind": "compaction_summary" }));

        let mut history = vec![
            summary_msg,
            make_empty_message("user", "turn 0".to_string()),
            small_result,
            make_empty_message("user", "turn 1".to_string()),
            make_empty_message("user", "turn 2".to_string()),
            make_empty_message("user", "turn 3".to_string()),
        ];

        let replaced =
            microcompact_old_tool_outputs(&mut history, MICROCOMPACT_KEEP_RECENT_USER_TURNS);
        assert_eq!(replaced, 0, "小输出不值得占位符化");
        assert_eq!(history[0].content, "compacted summary");
        assert_eq!(history[2].content, "tiny");

        // user 轮数不足 K 时完全不动
        let mut short_history = vec![
            make_empty_message("user", "only turn".to_string()),
            make_empty_message("assistant", "reply".to_string()),
        ];
        assert_eq!(
            microcompact_old_tool_outputs(&mut short_history, MICROCOMPACT_KEEP_RECENT_USER_TURNS),
            0
        );
    }

    #[test]
    fn test_normalize_tool_name_for_api_rejects_blank_names() {
        assert_eq!(normalize_tool_name_for_api(""), None);
        assert_eq!(normalize_tool_name_for_api("   "), None);
    }

    #[test]
    fn test_normalize_tool_name_for_api_encodes_invalid_names_losslessly() {
        let normalized =
            normalize_tool_name_for_api(" mcp:fetch/url ").expect("name should normalize");
        assert_ne!(normalized, "mcp:fetch/url");
        assert_eq!(
            crate::canonical_tools::decode_tool_name_from_api(&normalized),
            Some("mcp:fetch/url".to_string())
        );
    }

    #[test]
    fn test_prepare_external_tool_schema_builds_namespaced_payload() {
        let tool = crate::chat_v2::types::McpToolSchema {
            name: "fetch:url".to_string(),
            server_id: Some(" server:alpha ".to_string()),
            description: Some("Fetch a URL".to_string()),
            input_schema: Some(json!({ "type": "object" })),
        };

        let prepared =
            prepare_external_tool_schema(&tool, true).expect("schema should be prepared");

        assert_eq!(prepared.raw_tool_name, "mcp_fetch:url");
        assert_eq!(
            prepared.preferred_server_id.as_deref(),
            Some("server:alpha")
        );
        assert_eq!(
            crate::canonical_tools::decode_tool_name_from_api(&prepared.api_name),
            Some("[\"mcp-route-v1\",\"mcp_fetch:url\",\"server:alpha\"]".to_string())
        );
        assert_eq!(
            prepared.schema["function"]["name"],
            json!(prepared.api_name)
        );
    }

    #[test]
    fn test_prepare_external_tool_schema_rejects_blank_tool_name() {
        let tool = crate::chat_v2::types::McpToolSchema {
            name: "   ".to_string(),
            server_id: None,
            description: None,
            input_schema: None,
        };

        assert!(prepare_external_tool_schema(&tool, false).is_none());
    }

    #[test]
    fn test_prepare_external_tool_schema_namespaces_external_builtin_name() {
        let tool = crate::chat_v2::types::McpToolSchema {
            name: "builtin-workspace_file_read".to_string(),
            server_id: Some("external-server".to_string()),
            description: None,
            input_schema: Some(json!({ "type": "object" })),
        };

        let prepared =
            prepare_external_tool_schema(&tool, false).expect("schema should be prepared");

        assert_eq!(prepared.raw_tool_name, "mcp_builtin-workspace_file_read");
        assert_eq!(
            crate::canonical_tools::decode_tool_name_from_api(&prepared.api_name),
            Some("mcp_builtin-workspace_file_read".to_string())
        );
    }

    #[test]
    fn test_prepare_external_tool_schema_preserves_trusted_builtin_name() {
        let tool = crate::chat_v2::types::McpToolSchema {
            name: "builtin-workspace_file_read".to_string(),
            server_id: None,
            description: None,
            input_schema: Some(json!({ "type": "object" })),
        };

        let prepared =
            prepare_external_tool_schema(&tool, false).expect("schema should be prepared");

        assert_eq!(prepared.raw_tool_name, "builtin-workspace_file_read");
        assert_eq!(
            crate::canonical_tools::decode_tool_name_from_api(&prepared.api_name),
            Some("builtin-workspace_file_read".to_string())
        );
    }

    #[test]
    fn test_prepare_external_tool_schema_rejects_blank_server_id() {
        let tool = crate::chat_v2::types::McpToolSchema {
            name: "web_search".to_string(),
            server_id: Some("   ".to_string()),
            description: None,
            input_schema: Some(json!({ "type": "object" })),
        };

        assert!(prepare_external_tool_schema(&tool, true).is_none());
    }

    #[test]
    fn test_prepare_external_tool_schema_routes_trusted_load_skills_to_builtin() {
        let tool = crate::chat_v2::types::McpToolSchema {
            name: "load_skills".to_string(),
            server_id: None,
            description: Some("Load skills".to_string()),
            input_schema: Some(json!({ "type": "object" })),
        };

        let prepared =
            prepare_external_tool_schema(&tool, true).expect("schema should be prepared");

        assert_eq!(prepared.raw_tool_name, "builtin-load_skills");
        assert_eq!(prepared.api_name, "builtin-load_skills");
        assert_eq!(prepared.preferred_server_id, None);
        assert!(crate::chat_v2::tools::SkillsExecutor::is_load_skills_tool(
            &prepared.raw_tool_name
        ));
        assert!(!crate::chat_v2::tools::types::is_external_mcp_tool_name(
            &prepared.raw_tool_name
        ));
    }

    #[test]
    fn test_prepare_external_tool_schema_keeps_external_load_skills_isolated() {
        let tool = crate::chat_v2::types::McpToolSchema {
            name: "load_skills".to_string(),
            server_id: Some("external-server".to_string()),
            description: Some("External tool".to_string()),
            input_schema: Some(json!({ "type": "object" })),
        };

        let prepared =
            prepare_external_tool_schema(&tool, true).expect("schema should be prepared");

        assert_eq!(prepared.raw_tool_name, "mcp_load_skills");
        assert!(crate::chat_v2::tools::types::is_external_mcp_tool_name(
            &prepared.raw_tool_name
        ));
        assert_eq!(
            crate::canonical_tools::decode_tool_name_from_api(&prepared.api_name),
            Some("[\"mcp-route-v1\",\"mcp_load_skills\",\"external-server\"]".to_string())
        );
    }

    #[test]
    fn mcp_policy_is_deny_first_and_external_builtin_names_are_not_exempt() {
        let trusted_builtin = crate::chat_v2::types::McpToolSchema {
            name: "builtin-workspace_file_read".to_string(),
            server_id: None,
            description: None,
            input_schema: None,
        };
        let spoofed_builtin = crate::chat_v2::types::McpToolSchema {
            name: "builtin-execute_command".to_string(),
            server_id: Some("external-server".to_string()),
            description: None,
            input_schema: None,
        };

        assert!(is_mcp_tool_allowed_by_policy(
            &trusted_builtin,
            &["some_other_tool".to_string()],
            &[],
        ));
        assert!(!is_mcp_tool_allowed_by_policy(
            &trusted_builtin,
            &[],
            &[trusted_builtin.name.clone()],
        ));
        assert!(!is_mcp_tool_allowed_by_policy(
            &spoofed_builtin,
            &["some_other_tool".to_string()],
            &[],
        ));
        assert!(is_mcp_tool_allowed_by_policy(
            &spoofed_builtin,
            &[spoofed_builtin.name.clone()],
            &[],
        ));
        assert!(!is_mcp_tool_allowed_by_policy(
            &spoofed_builtin,
            &[spoofed_builtin.name.clone()],
            &[spoofed_builtin.name.clone()],
        ));
    }
}
