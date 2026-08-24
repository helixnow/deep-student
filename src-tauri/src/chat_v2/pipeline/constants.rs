// ============================================================
// 常量定义
// ============================================================

/// 工具递归最大深度
pub(crate) const MAX_TOOL_RECURSION: u32 = 30;

/// 计算工具循环的有效最大轮数
///
/// 🔧 2026-07（短板 #13）：单变体递归路径与多变体轮询路径共用此函数，
/// 消除多变体硬编码 `MAX_TOOL_ROUNDS = 10` 造成的行为不一致：
/// - 用户显式配置 `options.max_tool_recursion` 时以其为准，clamp 到 1–100；
/// - 未配置时回退 MAX_TOOL_RECURSION（30）。
pub(crate) fn effective_max_tool_rounds(max_tool_recursion: Option<u32>) -> u32 {
    max_tool_recursion
        .unwrap_or(MAX_TOOL_RECURSION)
        .clamp(1, 100)
}

/// 默认工具超时（毫秒）
pub(crate) const DEFAULT_TOOL_TIMEOUT_MS: u64 = 30_000;

/// 默认检索 TopK
pub(crate) const DEFAULT_RAG_TOP_K: u32 = 5;

/// 默认图谱检索 TopK
pub(crate) const DEFAULT_GRAPH_TOP_K: u32 = 10;

/// 默认多模态检索 TopK
pub(crate) const DEFAULT_MULTIMODAL_TOP_K: u32 = 10;

/// 🔧 P1修复：默认历史消息数量限制（条数，非 token）
/// context_limit 应该用于 LLM 的 token 限制，不应误用于消息条数
pub(crate) const DEFAULT_MAX_HISTORY_MESSAGES: usize = 50;

/// 消息条数上限的放宽上界（防御病态大 context_limit 导致 DB 全量加载）
pub(crate) const MAX_HISTORY_MESSAGES_CAP: usize = 400;

/// 🔧 P1-6 修复：条数上限与 token 预算解耦 → 按 token 预算推导条数上限。
///
/// 之前 DEFAULT_MAX_HISTORY_MESSAGES=50 是无条件硬砍：即使用户配置了 200K
/// context_limit（token 充裕），第 51 条消息仍被丢弃，造成"预算够却丢轮次"。
/// 现按「50 条 ≈ 32K token（默认预算）」的历史比例线性放宽：
/// 平均每条消息按 ~640 token 折算，budget/640 条，下限保持 50，上限 400
/// （条数只是第一道粗筛，精确裁剪仍由 trim_history_by_token_budget 完成）。
pub(crate) fn effective_max_history_messages(context_limit: Option<u32>) -> usize {
    let budget = effective_history_token_budget(context_limit);
    (budget / 640).clamp(DEFAULT_MAX_HISTORY_MESSAGES, MAX_HISTORY_MESSAGES_CAP)
}

/// 历史消息 token 预算上限（启发式估算）
/// 超过此预算时从最旧消息开始裁剪，避免上下文溢出
///
/// 🔧 P1-2 修复（07 报告）：本常量仅作为「用户未配置 context_limit 时」的回退值，
/// 不再用 min() 单向压低用户显式配置（之前 128K 配置会被静默钳到 32K，
/// 导致 compaction 的 163K+ 触发阈值在普通长对话中永远不可达）。
/// 统一通过 `effective_history_token_budget` 取值。
pub(crate) const DEFAULT_MAX_HISTORY_TOKENS: usize = 32_000;

/// 计算历史裁剪的有效 token 预算：
/// - 用户显式配置了 context_limit（>0）时以其为权威值（与 compaction 的
///   usable_tokens 口径协调，由 LLM 层的 max_input_tokens_override 兜底防御）；
/// - 未配置或非法值（0）时回退 DEFAULT_MAX_HISTORY_TOKENS。
pub(crate) fn effective_history_token_budget(context_limit: Option<u32>) -> usize {
    match context_limit {
        Some(v) if v > 0 => v as usize,
        _ => DEFAULT_MAX_HISTORY_TOKENS,
    }
}

// ============================================================
// 🔧 P1-5：token 估算与预算分配口径（单一事实来源说明）
// ============================================================
//
// **估算实现统一**：全 pipeline 的启发式 token 估算统一收敛到
// `crate::utils::token_budget::estimate_tokens`（ASCII 字母数字 ≈0.25、
// 空白 ≈0.05、标点 ≈0.30、CJK ≈1.0、其它多字节 ≈0.8 token/字符）。
// `helpers::estimate_token_count` 仅作转发别名保留（历史调用点兼容），
// 不再维护第二套字符系数（原 CHARS_PER_TOKEN_CJK/ASCII 已删除）。
// 需要模型感知精确计数时用 `estimate_tokens_with_model`（tiktoken feature）。
//
// **预算分配总览**（context_limit = 用户配置的输入 token 权威值）：
// - 历史消息：`effective_history_token_budget(context_limit)`，未配置回退 32K；
//   先按 `effective_max_history_messages` 粗筛条数，再按 token 精确裁剪
//   （`trim_history_by_token_budget`，从最旧非 pinned 单元开始移除）。
// - 瞬态技能注入：与历史共用同一 context_limit 口径（单变体 tool_loop 与
//   多变体路径均直接采用显式 `context_limit`，不足时按 tier 顺序丢弃）。
// - compaction 触发：`usable = context_window - effective_max_output`，
//   used ≥ usable×0.85 触发（见 compaction.rs），与本文件预算相互独立——
//   compaction 基于 provider 真实 usage，此处基于启发式估算，
//   由 LLM 层 max_input_tokens_override 兜底防御。

/// 🔧 P1修复：LLM 流式调用超时（秒）
/// 流式响应需要较长时间，设置为 10 分钟
///
/// 🔧 F2 修复后语义：作为「空闲超时」使用 —— 流式期间只要有数据持续到达就不会
/// 触发；连续 10 分钟无任何 chunk/usage/工具调用增量才判定为挂起。
pub(crate) const LLM_STREAM_TIMEOUT_SECS: u64 = 600;

/// 🔧 F2 修复：LLM 流式调用绝对时长上限（秒）
/// 即使流式持续健康输出，单次 LLM 调用也不允许超过 2 小时（防御病态慢滴流）
pub(crate) const LLM_STREAM_MAX_TOTAL_SECS: u64 = 7_200;

/// 🔧 P1修复：LLM 非流式调用超时（秒）
/// 用于摘要生成等简单调用，设置为 2 分钟
pub(crate) const LLM_NON_STREAM_TIMEOUT_SECS: u64 = 120;

/// 判断一个字符串是否是 API 配置 ID 格式（而非模型显示名称）
///
/// 配置 ID 有两种已知格式：
/// 1. `builtin-*` — 内置模型配置（如 "builtin-deepseek-chat"）
/// 2. UUID v4 — 用户自建模型配置（如 "a1b2c3d4-e5f6-7890-abcd-ef1234567890"，36字符 8-4-4-4-12）
///
/// 不属于以上格式的字符串被认为是模型显示名称（如 "Qwen/Qwen3-8B"、"deepseek-chat"）。
pub(crate) fn is_config_id_format(id: &str) -> bool {
    if id.is_empty() {
        return false;
    }
    // 1. 内置配置 ID
    if id.starts_with("builtin-") {
        return true;
    }
    // 2. UUID v4 格式: 8-4-4-4-12 hex digits (total 36 chars with 4 hyphens)
    id.len() == 36
        && id.chars().filter(|c| *c == '-').count() == 4
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

/// 截断预览文本到指定字符数（用于笔记工具 diff 预览）
pub(crate) fn truncate_preview(text: &str, max_chars: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max_chars {
        text.to_string()
    } else {
        let truncated: String = chars[..max_chars].iter().collect();
        format!("{}...", truncated)
    }
}

#[cfg(test)]
mod budget_tests {
    use super::*;

    /// 🔧 P1-2 回归：显式 context_limit 不再被 32K 常量 min() 钳制
    #[test]
    fn test_effective_history_token_budget_respects_user_config() {
        // 用户配置大于默认值时以用户配置为准（之前会被钳到 32K）
        assert_eq!(effective_history_token_budget(Some(128_000)), 128_000);
        // 用户配置小于默认值时同样以用户配置为准
        assert_eq!(effective_history_token_budget(Some(8_000)), 8_000);
        // 未配置 / 非法值回退默认
        assert_eq!(
            effective_history_token_budget(None),
            DEFAULT_MAX_HISTORY_TOKENS
        );
        assert_eq!(
            effective_history_token_budget(Some(0)),
            DEFAULT_MAX_HISTORY_TOKENS
        );
    }
}

// ============================================================
// 检索结果过滤配置（改进 3）
// ============================================================

/// 检索结果绝对最低分阈值
/// 低于此分数的结果直接剔除
pub(crate) const RETRIEVAL_MIN_SCORE: f32 = 0.3;

/// 检索结果相对阈值
/// 保留 >= 最高分 * 此比例的结果
pub(crate) const RETRIEVAL_RELATIVE_THRESHOLD: f32 = 0.5;

/// 批量重试变体参数
#[derive(Debug, Clone)]
pub(crate) struct VariantRetrySpec {
    pub variant_id: String,
    pub model_id: String,
    pub config_id: String,
    pub meta: Option<crate::chat_v2::types::VariantMeta>,
}
