use super::*;

// ============================================================
// 常量定义
// ============================================================

/// 工具递归最大深度
pub(crate) const MAX_TOOL_RECURSION: u32 = 30;

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

/// 历史消息 token 预算上限（启发式估算）
/// 超过此预算时从最旧消息开始裁剪，避免上下文溢出
pub(crate) const DEFAULT_MAX_HISTORY_TOKENS: usize = 32_000;

/// 中文字符的 token 估算系数（1 个中文字 ≈ 1.5 tokens）
pub(crate) const CHARS_PER_TOKEN_CJK: f64 = 1.5;

/// ASCII 字符的 token 估算系数（约 4 个字符 ≈ 1 token）
pub(crate) const CHARS_PER_TOKEN_ASCII: f64 = 0.25;

/// 🔧 P1修复：LLM 流式调用超时（秒）
/// 流式响应需要较长时间，设置为 10 分钟
pub(crate) const LLM_STREAM_TIMEOUT_SECS: u64 = 600;

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
