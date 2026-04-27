use super::*;
use std::collections::{HashMap, HashSet};

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

/// Sanitize tool name for LLM API compatibility.
/// OpenAI requires function names to match `^[a-zA-Z0-9_-]+$`.
/// Replaces any non-matching character (e.g. `:`, `.`, `/`) with `_`.
pub(crate) fn sanitize_tool_name_for_api(name: &str) -> String {
    name.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
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

const TRANSIENT_SKILL_METADATA_KIND: &str = "skill_instruction";

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
pub(crate) fn estimate_token_count(text: &str) -> usize {
    let mut cjk_chars = 0usize;
    let mut ascii_chars = 0usize;
    for c in text.chars() {
        if c.is_ascii() {
            ascii_chars += 1;
        } else {
            cjk_chars += 1;
        }
    }
    let tokens =
        (cjk_chars as f64 * CHARS_PER_TOKEN_CJK) + (ascii_chars as f64 * CHARS_PER_TOKEN_ASCII);
    tokens.ceil() as usize
}

/// 按 token 预算裁剪聊天历史（从最旧消息开始移除）
pub(crate) fn trim_history_by_token_budget(
    history: &mut Vec<LegacyChatMessage>,
    max_tokens: usize,
) {
    let mut total_tokens: usize = history
        .iter()
        .map(|m| estimate_token_count(&m.content))
        .sum();

    let original_len = history.len();
    while total_tokens > max_tokens
        && history
            .iter()
            .filter(|m| !is_transient_skill_message(m))
            .count()
            > 2
    {
        let Some(remove_idx) = history.iter().position(|m| !is_transient_skill_message(m)) else {
            break;
        };
        let removed = history.remove(remove_idx);
        total_tokens = total_tokens.saturating_sub(estimate_token_count(&removed.content));
    }

    if history.len() < original_len {
        log::info!(
            "[ChatV2::pipeline] Token budget trim: {} -> {} messages (budget={}, remaining≈{})",
            original_len,
            history.len(),
            max_tokens,
            total_tokens
        );
    }
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
}
