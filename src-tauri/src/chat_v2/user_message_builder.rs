//! 用户消息统一构建模块
//!
//! 本模块提供用户消息的统一创建逻辑，确保所有持久化路径的一致性。
//! 所有需要创建用户消息的位置都应该使用本模块的函数，避免代码重复和不一致。
//!
//! ## 设计原则
//! - **单一职责**：只处理用户消息的构建，不处理数据库操作
//! - **完整性**：处理所有用户消息相关字段（attachments, context_snapshot, meta 等）
//! - **一致性**：确保单变体/多变体模式使用相同的转换逻辑

use base64::Engine;

use super::resource_types::{ContextRef, ContextSnapshot};
use super::types::{
    block_status, block_types, AttachmentInput, AttachmentMeta, ChatMessage, MessageBlock,
    MessageMeta, MessageRole,
};

// ============================================================================
// 参数和结果类型
// ============================================================================

/// 用户消息创建参数
///
/// 封装创建用户消息所需的所有参数，调用方无需关心内部实现细节。
#[derive(Debug, Clone)]
pub struct UserMessageParams {
    /// 消息 ID（可选，不提供则自动生成）
    pub id: Option<String>,
    /// 会话 ID
    pub session_id: String,
    /// 用户消息内容
    pub content: String,
    /// 附件列表
    pub attachments: Vec<AttachmentInput>,
    /// 上下文快照（完整快照，函数内部会提取 userRefs）
    pub context_snapshot: Option<ContextSnapshot>,
    /// 时间戳（可选，不提供则使用当前时间）
    pub timestamp: Option<i64>,
}

impl UserMessageParams {
    /// 创建最小化参数（仅必填字段）
    pub fn new(session_id: String, content: String) -> Self {
        Self {
            id: None,
            session_id,
            content,
            attachments: Vec::new(),
            context_snapshot: None,
            timestamp: None,
        }
    }

    /// 设置消息 ID
    pub fn with_id(mut self, id: String) -> Self {
        self.id = Some(id);
        self
    }

    /// 设置附件
    pub fn with_attachments(mut self, attachments: Vec<AttachmentInput>) -> Self {
        self.attachments = attachments;
        self
    }

    /// 设置上下文快照
    pub fn with_context_snapshot(mut self, snapshot: ContextSnapshot) -> Self {
        self.context_snapshot = Some(snapshot);
        self
    }

    /// 设置时间戳
    pub fn with_timestamp(mut self, timestamp: i64) -> Self {
        self.timestamp = Some(timestamp);
        self
    }
}

/// 用户消息创建结果
///
/// 包含创建的消息和对应的内容块，调用方直接保存即可。
#[derive(Debug, Clone)]
pub struct UserMessageResult {
    /// 用户消息
    pub message: ChatMessage,
    /// 用户消息内容块
    pub block: MessageBlock,
}

// ============================================================================
// 核心构建函数
// ============================================================================

/// 统一构建用户消息
///
/// 这是创建用户消息的**唯一入口**，确保所有路径使用相同逻辑：
/// - 附件转换（AttachmentInput → AttachmentMeta）
/// - 上下文快照提取（只保留 userRefs）
/// - 消息和块的创建
///
/// ## 示例
/// ```rust
/// let params = UserMessageParams::new(session_id, content)
///     .with_id(user_message_id)
///     .with_attachments(attachments)
///     .with_context_snapshot(ctx.context_snapshot.clone());
/// let result = build_user_message(params);
/// // 保存 result.message 和 result.block 到数据库
/// ```
pub fn build_user_message(params: UserMessageParams) -> UserMessageResult {
    let now_ms = params.timestamp.unwrap_or_else(|| {
        log::warn!("[UserMessageBuilder] No timestamp provided, falling back to current time");
        chrono::Utc::now().timestamp_millis()
    });
    let message_id = params.id.unwrap_or_else(ChatMessage::generate_id);
    let block_id = MessageBlock::generate_id();

    // 1. 转换附件
    let attachments_meta = if params.attachments.is_empty() {
        None
    } else {
        Some(
            params
                .attachments
                .iter()
                .map(convert_attachment_input_to_meta)
                .collect(),
        )
    };

    // 2. 提取用户上下文快照（只保留 userRefs）
    let user_context_snapshot = params
        .context_snapshot
        .as_ref()
        .and_then(extract_user_refs_snapshot);

    // 3. 构建消息元数据
    let meta = if user_context_snapshot.is_some() {
        Some(MessageMeta {
            context_snapshot: user_context_snapshot,
            ..Default::default()
        })
    } else {
        None
    };

    // 4. 创建消息
    let message = ChatMessage {
        id: message_id.clone(),
        session_id: params.session_id,
        role: MessageRole::User,
        block_ids: vec![block_id.clone()],
        timestamp: now_ms,
        persistent_stable_id: None,
        parent_id: None,
        supersedes: None,
        meta,
        attachments: attachments_meta,
        active_variant_id: None,
        variants: None,
        shared_context: None,
    };

    // 5. 创建内容块
    let block = MessageBlock {
        id: block_id,
        message_id,
        block_type: block_types::CONTENT.to_string(),
        status: block_status::SUCCESS.to_string(),
        content: Some(params.content),
        tool_name: None,
        tool_input: None,
        tool_output: None,
        citations: None,
        error: None,
        started_at: Some(now_ms),
        ended_at: Some(now_ms),
        // 🔧 用户消息块：使用 now_ms 作为 first_chunk_at
        first_chunk_at: Some(now_ms),
        block_index: 0,
    };

    UserMessageResult { message, block }
}

// ============================================================================
// 附件转换
// ============================================================================

/// 统一附件转换：AttachmentInput → AttachmentMeta
///
/// 处理所有类型的附件（image/audio/video/document/other），
/// 并构建 preview_url（data URL）用于历史消息和重试/编辑重发。
pub fn convert_attachment_input_to_meta(input: &AttachmentInput) -> AttachmentMeta {
    // 1. 推断附件类型
    let attachment_type = infer_attachment_type(&input.mime_type);

    // 2. 计算实际文件大小（base64 解码后）
    // base64 编码后大小约为原始大小的 4/3
    let actual_size = input
        .base64_content
        .as_ref()
        .map(|c| (c.len() as u64 * 3) / 4)
        .unwrap_or(0);

    // 3. 构建 preview_url（data URL）
    // 所有类型都需要保存内容，否则历史消息中的附件无法正确传递给 LLM
    let preview_url = build_preview_url(input);

    AttachmentMeta {
        id: AttachmentMeta::generate_id(),
        name: input.name.clone(),
        r#type: attachment_type.to_string(),
        mime_type: input.mime_type.clone(),
        size: actual_size,
        preview_url,
        status: "ready".to_string(),
        error: None,
    }
}

/// 推断附件类型
fn infer_attachment_type(mime_type: &str) -> &'static str {
    if mime_type.starts_with("image/") {
        "image"
    } else if mime_type.starts_with("audio/") {
        "audio"
    } else if mime_type.starts_with("video/") {
        "video"
    } else if mime_type.starts_with("application/pdf")
        || mime_type.starts_with("text/")
        || mime_type.contains("document")
        || mime_type.contains("word")
        || mime_type.contains("excel")
        || mime_type.contains("spreadsheet")
    {
        "document"
    } else {
        "other"
    }
}

/// 构建 preview_url（data URL）
fn build_preview_url(input: &AttachmentInput) -> Option<String> {
    if let Some(ref text) = input.text_content {
        // 文本类型：使用 text_content
        let encoded = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
        Some(format!("data:{};base64,{}", input.mime_type, encoded))
    } else if let Some(ref content) = input.base64_content {
        // 二进制类型：使用 base64_content
        Some(format!("data:{};base64,{}", input.mime_type, content))
    } else {
        None
    }
}

// ============================================================================
// 上下文快照处理
// ============================================================================

/// 提取用户上下文快照（只保留 userRefs）
///
/// 用户消息只需要保存 userRefs（用户添加的上下文引用），
/// retrievalRefs 由助手消息保存。
pub fn extract_user_refs_snapshot(snapshot: &ContextSnapshot) -> Option<ContextSnapshot> {
    if snapshot.user_refs.is_empty() {
        return None;
    }

    let mut user_only_snapshot = ContextSnapshot::new();
    for user_ref in &snapshot.user_refs {
        user_only_snapshot.add_user_ref(user_ref.clone());
    }
    Some(user_only_snapshot)
}

/// 从 ContextRef 列表创建用户上下文快照
pub fn create_user_refs_snapshot(user_refs: &[ContextRef]) -> Option<ContextSnapshot> {
    if user_refs.is_empty() {
        return None;
    }

    let mut snapshot = ContextSnapshot::new();
    for user_ref in user_refs {
        snapshot.add_user_ref(user_ref.clone());
    }
    Some(snapshot)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_user_message_minimal() {
        let params = UserMessageParams::new("session_123".to_string(), "Hello".to_string());
        let result = build_user_message(params);

        assert!(result.message.id.starts_with("msg_"));
        assert_eq!(result.message.session_id, "session_123");
        assert_eq!(result.message.role, MessageRole::User);
        assert_eq!(result.block.content, Some("Hello".to_string()));
        assert!(result.message.attachments.is_none());
        assert!(result.message.meta.is_none());
    }

    #[test]
    fn test_build_user_message_with_id() {
        let params = UserMessageParams::new("session_123".to_string(), "Hello".to_string())
            .with_id("msg_custom_id".to_string());
        let result = build_user_message(params);

        assert_eq!(result.message.id, "msg_custom_id");
        assert_eq!(result.block.message_id, "msg_custom_id");
    }

    #[test]
    fn test_convert_attachment_image() {
        let input = AttachmentInput {
            name: "test.png".to_string(),
            mime_type: "image/png".to_string(),
            base64_content: Some("iVBORw0KGgo=".to_string()),
            text_content: None,
            metadata: None,
        };

        let meta = convert_attachment_input_to_meta(&input);

        assert_eq!(meta.r#type, "image");
        assert_eq!(meta.name, "test.png");
        assert!(meta.preview_url.is_some());
        assert!(meta
            .preview_url
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    #[test]
    fn test_convert_attachment_document() {
        let input = AttachmentInput {
            name: "doc.pdf".to_string(),
            mime_type: "application/pdf".to_string(),
            base64_content: None,
            text_content: Some("PDF content".to_string()),
            metadata: None,
        };

        let meta = convert_attachment_input_to_meta(&input);

        assert_eq!(meta.r#type, "document");
        assert!(meta.preview_url.is_some());
    }

    #[test]
    fn test_convert_attachment_audio() {
        let input = AttachmentInput {
            name: "audio.mp3".to_string(),
            mime_type: "audio/mpeg".to_string(),
            base64_content: Some("base64audio".to_string()),
            text_content: None,
            metadata: None,
        };

        let meta = convert_attachment_input_to_meta(&input);

        assert_eq!(meta.r#type, "audio");
    }

    #[test]
    fn test_convert_attachment_video() {
        let input = AttachmentInput {
            name: "video.mp4".to_string(),
            mime_type: "video/mp4".to_string(),
            base64_content: Some("base64video".to_string()),
            text_content: None,
            metadata: None,
        };

        let meta = convert_attachment_input_to_meta(&input);

        assert_eq!(meta.r#type, "video");
    }

    #[test]
    fn test_extract_user_refs_snapshot_empty() {
        let snapshot = ContextSnapshot::new();
        let result = extract_user_refs_snapshot(&snapshot);
        assert!(result.is_none());
    }

    #[test]
    fn test_extract_user_refs_snapshot_with_refs() {
        let mut snapshot = ContextSnapshot::new();
        snapshot.add_user_ref(ContextRef::new("res_1", "hash_1", "note"));

        let result = extract_user_refs_snapshot(&snapshot);

        assert!(result.is_some());
        let extracted = result.unwrap();
        assert_eq!(extracted.user_refs.len(), 1);
        assert!(extracted.retrieval_refs.is_empty());
    }

    #[test]
    fn test_build_user_message_with_context_snapshot() {
        let mut snapshot = ContextSnapshot::new();
        snapshot.add_user_ref(ContextRef::new("res_1", "hash_1", "note"));
        // 添加 retrieval_ref，但它不应该出现在用户消息中
        snapshot.add_retrieval_ref(ContextRef::new("res_2", "hash_2", "retrieval"));

        let params = UserMessageParams::new("session_123".to_string(), "Hello".to_string())
            .with_context_snapshot(snapshot);
        let result = build_user_message(params);

        assert!(result.message.meta.is_some());
        let meta = result.message.meta.unwrap();
        assert!(meta.context_snapshot.is_some());
        let ctx_snapshot = meta.context_snapshot.unwrap();
        // 只有 userRefs，没有 retrievalRefs
        assert_eq!(ctx_snapshot.user_refs.len(), 1);
        assert!(ctx_snapshot.retrieval_refs.is_empty());
    }
}
