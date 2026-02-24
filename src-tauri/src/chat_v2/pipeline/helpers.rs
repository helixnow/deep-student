use super::*;


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

/// Sanitize tool name for LLM API compatibility.
/// OpenAI requires function names to match `^[a-zA-Z0-9_-]+$`.
/// Replaces any non-matching character (e.g. `:`, `.`, `/`) with `_`.
pub(crate) fn sanitize_tool_name_for_api(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect()
}

pub(crate) fn approval_scope_setting_key(tool_name: &str, arguments: &Value) -> String {
    let serialized = serde_json::to_string(arguments).unwrap_or_else(|_| "null".to_string());
    let mut hasher = Sha256::new();
    hasher.update(serialized.as_bytes());
    let fingerprint = hex::encode(hasher.finalize());
    format!("tool_approval.scope.{}.{}", tool_name, fingerprint)
}

/// 工具审批结果枚举
///
/// 区分用户主动操作与系统异常，使调用方能给出精确的错误消息。
/// - `Approved`：用户同意执行
/// - `Rejected`：用户明确拒绝
/// - `Timeout`：等待审批超时
/// - `ChannelClosed`：审批通道异常关闭
pub(crate) enum ApprovalOutcome {
    /// 用户同意执行
    Approved,
    /// 用户明确拒绝
    Rejected,
    /// 等待审批超时
    Timeout,
    /// 审批通道异常关闭
    ChannelClosed,
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

/// 🆕 2026-02-22: 为已激活的默认技能自动注入合成 load_skills 工具交互
///
/// 模型对 `role: tool` 结果中的指令遵循度远高于 user message 中的 XML 块。
/// 此函数在消息历史开头 prepend 一对合成的 assistant(tool_call) + tool(result) 消息，
/// 与真实 `load_skills` 返回格式完全一致。
///
/// 跳过条件：
/// - 没有 active_skill_ids 或 skill_contents
/// - 历史中已存在真实的 load_skills 调用（避免 regenerate/retry 时重复注入）
pub(crate) fn inject_synthetic_load_skills(
    chat_history: &mut Vec<LegacyChatMessage>,
    options: &SendOptions,
) {
    let active_ids = match options.active_skill_ids.as_ref() {
        Some(ids) if !ids.is_empty() => ids,
        _ => {
            log::debug!("[ChatV2::pipeline] inject_synthetic_load_skills: skipped (active_skill_ids is None/empty)");
            return;
        }
    };
    let skill_contents = match options.skill_contents.as_ref() {
        Some(sc) if !sc.is_empty() => sc,
        _ => {
            log::info!(
                "[ChatV2::pipeline] inject_synthetic_load_skills: active_skill_ids={:?} but skill_contents is None/empty!",
                active_ids
            );
            return;
        }
    };

    // 收集有内容的已激活技能
    let skills_to_inject: Vec<(&String, &String)> = active_ids
        .iter()
        .filter_map(|id| skill_contents.get(id).map(|content| (id, content)))
        .collect();

    if skills_to_inject.is_empty() {
        log::info!(
            "[ChatV2::pipeline] inject_synthetic_load_skills: no match! active_ids={:?}, skill_contents_keys={:?}",
            active_ids,
            skill_contents.keys().collect::<Vec<_>>()
        );
        return;
    }

    // 检查历史中是否已有真实的 load_skills 调用（regenerate/retry 场景）
    let has_existing_load_skills = chat_history.iter().any(|m| {
        m.tool_call
            .as_ref()
            .map_or(false, |tc| SkillsExecutor::is_load_skills_tool(&tc.tool_name))
    });

    if has_existing_load_skills {
        log::debug!(
            "[ChatV2::pipeline] Skipping synthetic load_skills: history already contains real load_skills call"
        );
        return;
    }

    // 构建合成的 load_skills 工具交互（与 SkillsExecutor 输出格式一致）
    let skill_ids: Vec<&str> = skills_to_inject.iter().map(|(id, _)| id.as_str()).collect();
    let tool_call_id = format!("tc_auto_skills_{}", uuid::Uuid::new_v4().simple());

    // 1. 合成 assistant 消息（tool_call: load_skills）
    let tool_call_args = json!({ "skills": skill_ids });
    let mut assistant_msg = make_empty_message("assistant", String::new());
    assistant_msg.tool_call = Some(crate::models::ToolCall {
        id: tool_call_id.clone(),
        tool_name: "load_skills".to_string(),
        args_json: tool_call_args,
    });

    // 2. 构建工具结果内容（与 SkillsExecutor 格式一致）
    let mut content_parts: Vec<String> = Vec::with_capacity(skills_to_inject.len() + 1);
    for (skill_id, content) in &skills_to_inject {
        content_parts.push(format!(
            "<skill_loaded id=\"{}\">\n<instructions>\n{}\n</instructions>\n</skill_loaded>",
            skill_id, content
        ));
    }
    content_parts.push(format!(
        "\n共加载 {} 个技能。这些工具现在可以使用了。",
        skills_to_inject.len()
    ));
    let full_content = content_parts.join("\n");
    let content_len = full_content.len();

    let mut tool_msg = make_empty_message("tool", full_content);
    tool_msg.tool_result = Some(crate::models::ToolResult {
        call_id: tool_call_id,
        ok: true,
        error: None,
        error_details: None,
        data_json: None,
        usage: None,
        citations: None,
    });

    // 3. Prepend 到消息历史开头（这两条消息会出现在 [LLM_REVIEW_DEBUG] 请求体日志中）
    log::info!(
        "[ChatV2::pipeline] 🆕 Synthetic load_skills injected: {} skill(s) {:?}, content_len={}, history {} -> {} messages",
        skills_to_inject.len(),
        skill_ids,
        content_len,
        chat_history.len(),
        chat_history.len() + 2
    );
    chat_history.insert(0, assistant_msg);
    chat_history.insert(1, tool_msg);
}

