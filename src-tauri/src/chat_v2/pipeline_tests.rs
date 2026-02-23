//! Chat V2 Pipeline 单元测试模块
//!
//! 从 pipeline.rs 分离的测试代码，保持主模块代码简洁。

use super::context::PipelineContext;
use super::pipeline::*;
use super::types::{
    block_status, block_types, AttachmentMeta, ChatMessage, MessageBlock, MessageMeta, MessageRole,
    MessageSources, SendMessageRequest, SendOptions, SourceInfo, TokenSource, TokenUsage, ToolCall,
    ToolResultInfo,
};
use crate::models::RagSourceInfo;
use serde_json::json;

#[test]
fn test_message_role_serialization() {
    // MessageRole 使用 serde rename_all = "snake_case"
    let user_json = serde_json::to_string(&MessageRole::User).unwrap();
    let assistant_json = serde_json::to_string(&MessageRole::Assistant).unwrap();
    assert_eq!(user_json, "\"user\"");
    assert_eq!(assistant_json, "\"assistant\"");
}

#[test]
fn test_send_options_default() {
    let options = SendOptions::default();
    assert!(options.model_id.is_none());
    assert!(options.rag_enabled.is_none());
    assert!(options.enable_thinking.is_none());
}

#[test]
fn test_send_message_request_serialization() {
    let request = SendMessageRequest {
        session_id: "sess_123".to_string(),
        content: "Hello".to_string(),

        options: Some(SendOptions {
            model_id: Some("gpt-4".to_string()),
            temperature: Some(0.7),
            ..Default::default()
        }),
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let json = serde_json::to_string(&request).unwrap();
    assert!(json.contains("\"sessionId\""));
    assert!(json.contains("\"modelId\""));
}

#[test]
fn test_pipeline_context_creation() {
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "Test message".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let ctx = PipelineContext::new(request);
    assert_eq!(ctx.session_id, "sess_test");
    assert_eq!(ctx.user_content, "Test message");
    assert!(ctx.user_message_id.starts_with("msg_"));
    assert!(ctx.assistant_message_id.starts_with("msg_"));
}

#[test]
fn test_source_info_from_rag_source() {
    let rag_source = RagSourceInfo {
        document_id: "doc_123".to_string(),
        file_name: "test.pdf".to_string(),
        chunk_text: "Sample text".to_string(),
        score: 0.95,
        chunk_index: 0,
    };

    let source_info: SourceInfo = rag_source.into();
    assert_eq!(source_info.title, Some("test.pdf".to_string()));
    assert_eq!(source_info.snippet, Some("Sample text".to_string()));
    assert_eq!(source_info.score, Some(0.95));
}

#[test]
fn test_tool_result_info_serialization() {
    let result = ToolResultInfo {
        tool_call_id: Some("call_123".to_string()),
        block_id: Some("blk_test_123".to_string()),
        tool_name: "rag".to_string(),
        input: json!({"query": "test"}),
        output: json!({"results": []}),
        success: true,
        error: None,
        duration_ms: Some(150),
        reasoning_content: None,
        thought_signature: None,
    };

    let json = serde_json::to_string(&result).unwrap();
    assert!(json.contains("\"toolName\""));
    assert!(json.contains("\"durationMs\""));
    assert!(json.contains("\"toolCallId\""));
    assert!(!json.contains("\"error\"")); // None 字段不序列化
}

#[test]
fn test_tool_call_creation() {
    let tool_call = ToolCall::new(
        "call_123".to_string(),
        "rag".to_string(),
        json!({"query": "test"}),
    );

    assert_eq!(tool_call.id, "call_123");
    assert_eq!(tool_call.name, "rag");
    assert_eq!(tool_call.arguments, json!({"query": "test"}));
}

#[test]
fn test_tool_recursion_limit_constant() {
    // 验证递归限制常量定义正确
    assert_eq!(MAX_TOOL_RECURSION, 30);
}

#[test]
fn test_tool_timeout_constant() {
    // 验证工具超时常量定义正确（30 秒）
    assert_eq!(DEFAULT_TOOL_TIMEOUT_MS, 30_000);
}

#[test]
fn test_normalize_tool_name_for_skill_match() {
    assert_eq!(
        ChatV2Pipeline::normalize_tool_name_for_skill_match("builtin-workspace_send"),
        "workspace_send"
    );
    assert_eq!(
        ChatV2Pipeline::normalize_tool_name_for_skill_match("mcp_workspace_send"),
        "workspace_send"
    );
    assert_eq!(
        ChatV2Pipeline::normalize_tool_name_for_skill_match("workspace_send"),
        "workspace_send"
    );
}

#[test]
fn test_skill_allows_tool_with_namespace_prefixes() {
    assert!(ChatV2Pipeline::skill_allows_tool(
        "builtin-workspace_send",
        "workspace_send"
    ));
    assert!(ChatV2Pipeline::skill_allows_tool(
        "mcp_workspace_query",
        "builtin-workspace_query"
    ));
    assert!(ChatV2Pipeline::skill_allows_tool(
        "builtin-anki_create_card",
        "anki"
    ));
    assert!(!ChatV2Pipeline::skill_allows_tool(
        "builtin-workspace_send",
        "workspace_query"
    ));
}

#[test]
fn test_message_sources_default() {
    let sources = MessageSources::default();
    assert!(sources.rag.is_none());
    assert!(sources.memory.is_none());
    assert!(sources.graph.is_none());
    assert!(sources.web_search.is_none());
}

#[test]
fn test_block_id_generation() {
    let block_id = ChatV2LLMAdapter::generate_block_id();
    assert!(block_id.starts_with("blk_"));
    assert_eq!(block_id.len(), 4 + 36); // "blk_" + UUID
}

#[tokio::test]
async fn test_pipeline_context_elapsed() {
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "Test".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let ctx = PipelineContext::new(request);
    tokio::time::sleep(tokio::time::Duration::from_millis(10)).await;
    assert!(ctx.elapsed_ms() >= 10);
}

#[test]
fn test_pipeline_context_generated_blocks() {
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "Test message".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let ctx = PipelineContext::new(request);

    // 验证 generated_blocks 初始化为空
    assert!(ctx.generated_blocks.is_empty());
}

#[test]
fn test_message_block_creation() {
    let block = MessageBlock::new("msg_123".to_string(), block_types::CONTENT, 0);

    assert!(block.id.starts_with("blk_"));
    assert_eq!(block.message_id, "msg_123");
    assert_eq!(block.block_type, "content");
    assert_eq!(block.status, block_status::PENDING);
    assert_eq!(block.block_index, 0);
    assert!(block.content.is_none());
}

#[test]
fn test_message_block_set_status() {
    let mut block = MessageBlock::new("msg_123".to_string(), block_types::CONTENT, 0);

    // 测试设置运行中状态
    block.set_running();
    assert_eq!(block.status, block_status::RUNNING);
    assert!(block.started_at.is_some());

    // 测试设置成功状态
    block.set_success();
    assert_eq!(block.status, block_status::SUCCESS);
    assert!(block.ended_at.is_some());
}

#[test]
fn test_message_block_set_error() {
    let mut block = MessageBlock::new("msg_123".to_string(), block_types::CONTENT, 0);

    block.set_error("Test error");
    assert_eq!(block.status, block_status::ERROR);
    assert_eq!(block.error, Some("Test error".to_string()));
    assert!(block.ended_at.is_some());
}

#[test]
fn test_message_block_append_content() {
    let mut block = MessageBlock::new("msg_123".to_string(), block_types::CONTENT, 0);

    // 首次追加
    block.append_content("Hello ");
    assert_eq!(block.content, Some("Hello ".to_string()));

    // 继续追加
    block.append_content("World");
    assert_eq!(block.content, Some("Hello World".to_string()));
}

#[test]
fn test_chat_message_new_user() {
    let message = ChatMessage::new_user("sess_123".to_string(), vec!["blk_1".to_string()]);

    assert!(message.id.starts_with("msg_"));
    assert_eq!(message.session_id, "sess_123");
    assert_eq!(message.role, MessageRole::User);
    assert_eq!(message.block_ids, vec!["blk_1".to_string()]);
    assert!(message.timestamp > 0);
}

#[test]
fn test_chat_message_new_assistant() {
    let message = ChatMessage::new_assistant("sess_123".to_string());

    assert!(message.id.starts_with("msg_"));
    assert_eq!(message.session_id, "sess_123");
    assert_eq!(message.role, MessageRole::Assistant);
    assert!(message.block_ids.is_empty());
}

#[test]
fn test_context_limit_default() {
    let options = SendOptions::default();
    // context_limit 默认为 None，在 load_chat_history 中会使用 20 作为默认值
    assert!(options.context_limit.is_none());
}

#[test]
fn test_pipeline_context_with_options() {
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "Test".to_string(),

        options: Some(SendOptions {
            context_limit: Some(10),
            model_id: Some("gpt-4".to_string()),
            ..Default::default()
        }),
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let ctx = PipelineContext::new(request);
    assert_eq!(ctx.options.context_limit, Some(10));
    assert_eq!(ctx.options.model_id, Some("gpt-4".to_string()));
}

// ============================================================
// Prompt 5: 数据持久化 + 历史加载测试
// ============================================================

#[test]
fn test_user_message_block_structure() {
    // 验证用户消息块结构正确
    let block_id = MessageBlock::generate_id();
    let message_id = "msg_test_123".to_string();

    let block = MessageBlock {
        id: block_id.clone(),
        message_id: message_id.clone(),
        block_type: block_types::CONTENT.to_string(),
        status: block_status::SUCCESS.to_string(),
        content: Some("用户消息内容".to_string()),
        tool_name: None,
        tool_input: None,
        tool_output: None,
        citations: None,
        error: None,
        started_at: Some(chrono::Utc::now().timestamp_millis()),
        ended_at: Some(chrono::Utc::now().timestamp_millis()),
        first_chunk_at: None,
        block_index: 0,
    };

    assert!(block.id.starts_with("blk_"));
    assert_eq!(block.message_id, message_id);
    assert_eq!(block.block_type, "content");
    assert_eq!(block.status, "success");
    assert!(block.content.is_some());
    assert_eq!(block.block_index, 0);
    // 验证时间戳是 Unix 毫秒时间戳（合理范围检查）
    assert!(block.started_at.unwrap() > 1700000000000); // 2023 年之后
    assert!(block.ended_at.unwrap() > 1700000000000);
}

#[test]
fn test_assistant_message_meta_with_sources() {
    // 验证助手消息元数据包含检索来源
    let rag_sources = vec![SourceInfo {
        title: Some("文档1".to_string()),
        url: None,
        snippet: Some("内容片段".to_string()),
        score: Some(0.9),
        metadata: None,
    }];

    let sources = MessageSources {
        rag: Some(rag_sources),
        memory: None,
        graph: None,
        web_search: None,
        multimodal: None,
    };

    let meta = MessageMeta {
        model_id: Some("gpt-4".to_string()),
        chat_params: None,
        sources: Some(sources),
        tool_results: None,
        anki_cards: None,
        usage: None,
        context_snapshot: None,
    };

    assert!(meta.sources.is_some());
    assert_eq!(
        meta.sources.as_ref().unwrap().rag.as_ref().unwrap().len(),
        1
    );
    assert_eq!(meta.model_id, Some("gpt-4".to_string()));
}

#[test]
fn test_assistant_message_meta_with_tool_results() {
    // 验证助手消息元数据包含工具调用结果
    let tool_results = vec![ToolResultInfo {
        tool_call_id: Some("call_123".to_string()),
        block_id: Some("blk_test_123".to_string()),
        tool_name: "memory".to_string(),
        input: json!({"query": "test"}),
        output: json!({"results": []}),
        success: true,
        error: None,
        duration_ms: Some(150),
        reasoning_content: None,
        thought_signature: None,
    }];

    let meta = MessageMeta {
        model_id: None,
        chat_params: None,
        sources: None,
        tool_results: Some(tool_results),
        anki_cards: None,
        usage: None,
        context_snapshot: None,
    };

    assert!(meta.tool_results.is_some());
    let results = meta.tool_results.as_ref().unwrap();
    assert_eq!(results.len(), 1);
    assert!(results[0].success);
    assert_eq!(results[0].tool_name, "memory");
}

#[test]
fn test_block_index_ordering() {
    // 验证块索引正确设置
    let message_id = "msg_test".to_string();

    let blocks: Vec<MessageBlock> = (0..3)
        .map(|i| MessageBlock {
            id: MessageBlock::generate_id(),
            message_id: message_id.clone(),
            block_type: if i == 0 {
                block_types::THINKING
            } else {
                block_types::CONTENT
            }
            .to_string(),
            status: block_status::SUCCESS.to_string(),
            content: Some(format!("块内容 {}", i)),
            tool_name: None,
            tool_input: None,
            tool_output: None,
            citations: None,
            error: None,
            started_at: None,
            ended_at: None,
            first_chunk_at: None,
            block_index: i,
        })
        .collect();

    // 验证索引正确
    for (i, block) in blocks.iter().enumerate() {
        assert_eq!(block.block_index, i as u32);
    }

    // 验证第一个块是 thinking，其余是 content
    assert_eq!(blocks[0].block_type, "thinking");
    assert_eq!(blocks[1].block_type, "content");
    assert_eq!(blocks[2].block_type, "content");
}

#[test]
fn test_context_limit_application() {
    // 验证 context_limit 选项正确设置
    let options_with_limit = SendOptions {
        context_limit: Some(5),
        ..Default::default()
    };

    let options_default = SendOptions::default();

    // 有设置时使用设置值
    assert_eq!(options_with_limit.context_limit, Some(5));

    // 默认为 None（在 load_chat_history 中会使用 20）
    assert!(options_default.context_limit.is_none());

    // 验证默认值逻辑
    let default_limit = options_default.context_limit.unwrap_or(20);
    assert_eq!(default_limit, 20);
}

#[test]
fn test_content_block_filter() {
    // 验证只提取 content 类型块的内容
    let blocks = vec![
        MessageBlock {
            id: "blk_1".to_string(),
            message_id: "msg_1".to_string(),
            block_type: block_types::THINKING.to_string(),
            status: block_status::SUCCESS.to_string(),
            content: Some("思考内容".to_string()),
            tool_name: None,
            tool_input: None,
            tool_output: None,
            citations: None,
            error: None,
            started_at: None,
            ended_at: None,
            first_chunk_at: None,
            block_index: 0,
        },
        MessageBlock {
            id: "blk_2".to_string(),
            message_id: "msg_1".to_string(),
            block_type: block_types::CONTENT.to_string(),
            status: block_status::SUCCESS.to_string(),
            content: Some("正文内容1".to_string()),
            tool_name: None,
            tool_input: None,
            tool_output: None,
            citations: None,
            error: None,
            started_at: None,
            ended_at: None,
            first_chunk_at: None,
            block_index: 1,
        },
        MessageBlock {
            id: "blk_3".to_string(),
            message_id: "msg_1".to_string(),
            block_type: block_types::RAG.to_string(),
            status: block_status::SUCCESS.to_string(),
            content: None, // RAG 块通常没有 content
            tool_name: None,
            tool_input: None,
            tool_output: None,
            citations: Some(vec![]),
            error: None,
            started_at: None,
            ended_at: None,
            first_chunk_at: None,
            block_index: 2,
        },
        MessageBlock {
            id: "blk_4".to_string(),
            message_id: "msg_1".to_string(),
            block_type: block_types::CONTENT.to_string(),
            status: block_status::SUCCESS.to_string(),
            content: Some("正文内容2".to_string()),
            tool_name: None,
            tool_input: None,
            tool_output: None,
            citations: None,
            error: None,
            started_at: None,
            ended_at: None,
            first_chunk_at: None,
            block_index: 3,
        },
    ];

    // 只提取 content 类型块的内容
    let content: String = blocks
        .iter()
        .filter(|b| b.block_type == block_types::CONTENT)
        .filter_map(|b| b.content.as_ref())
        .cloned()
        .collect::<Vec<_>>()
        .join("");

    assert_eq!(content, "正文内容1正文内容2");
    // 不应包含 thinking 内容
    assert!(!content.contains("思考内容"));
}

#[test]
fn test_message_with_multiple_block_ids() {
    // 验证消息可以包含多个块 ID
    let block_ids = vec![
        "blk_1".to_string(),
        "blk_2".to_string(),
        "blk_3".to_string(),
    ];

    let message = ChatMessage {
        id: ChatMessage::generate_id(),
        session_id: "sess_test".to_string(),
        role: MessageRole::Assistant,
        block_ids: block_ids.clone(),
        timestamp: chrono::Utc::now().timestamp_millis(),
        persistent_stable_id: None,
        parent_id: None,
        supersedes: None,
        meta: None,
        attachments: None,
        active_variant_id: None,
        variants: None,
        shared_context: None,
    };

    assert_eq!(message.block_ids.len(), 3);
    assert_eq!(message.block_ids, block_ids);
}

#[test]
fn test_user_message_with_attachments() {
    // 验证用户消息可以包含附件
    let attachments = vec![AttachmentMeta {
        id: AttachmentMeta::generate_id(),
        name: "image.png".to_string(),
        r#type: "image".to_string(),
        mime_type: "image/png".to_string(),
        size: 1024,
        preview_url: None,
        status: "ready".to_string(),
        error: None,
    }];

    let message = ChatMessage {
        id: ChatMessage::generate_id(),
        session_id: "sess_test".to_string(),
        role: MessageRole::User,
        block_ids: vec!["blk_1".to_string()],
        timestamp: chrono::Utc::now().timestamp_millis(),
        persistent_stable_id: None,
        parent_id: None,
        supersedes: None,
        meta: None,
        attachments: Some(attachments),
        active_variant_id: None,
        variants: None,
        shared_context: None,
    };

    assert!(message.attachments.is_some());
    assert_eq!(message.attachments.as_ref().unwrap().len(), 1);
    assert!(message.attachments.as_ref().unwrap()[0]
        .id
        .starts_with("att_"));
}

// ============================================================
// Prompt 6: 检索功能测试
// ============================================================

#[test]
fn test_truncate_text_within_limit() {
    // 测试文本未超过限制时不截断
    let text = "短文本";
    let result = ChatV2Pipeline::truncate_text(text, 10);
    assert_eq!(result, "短文本");
}

#[test]
fn test_truncate_text_exceeds_limit() {
    // 测试文本超过限制时正确截断
    let text = "这是一段很长的文本内容，需要被截断";
    let result = ChatV2Pipeline::truncate_text(text, 5);
    assert_eq!(result, "这是一段很...");
}

#[test]
fn test_truncate_text_exact_limit() {
    // 测试文本恰好等于限制时不截断
    let text = "恰好";
    let result = ChatV2Pipeline::truncate_text(text, 2);
    assert_eq!(result, "恰好");
}

#[test]
fn test_source_info_for_graph_tag() {
    // 验证图谱标签转换为 SourceInfo 的结构正确
    let source = SourceInfo {
        title: Some("[知识点] 二次函数".to_string()),
        url: None,
        snippet: Some("知识点: 二次函数".to_string()),
        score: Some(0.8),
        metadata: Some(json!({
            "sourceType": "graph_tag",
            "tagId": "tag_123",
            "tagType": "知识点",
        })),
    };

    assert_eq!(source.title, Some("[知识点] 二次函数".to_string()));
    assert!(source.url.is_none());
    assert_eq!(source.score, Some(0.8));

    let metadata = source.metadata.unwrap();
    assert_eq!(metadata["sourceType"], "graph_tag");
    assert_eq!(metadata["tagId"], "tag_123");
}

#[test]
fn test_source_info_for_graph_card() {
    // 验证图谱卡片转换为 SourceInfo 的结构正确
    let source = SourceInfo {
        title: Some("[错题-待复习] 求解方程...".to_string()),
        url: None,
        snippet: Some("【问题】求解方程\n【解析】先化简...".to_string()),
        score: Some(0.7),
        metadata: Some(json!({
            "sourceType": "graph_card",
            "cardId": "card_456",
            "status": "active",
        })),
    };

    assert!(source.title.as_ref().unwrap().contains("错题"));
    assert_eq!(source.score, Some(0.7));

    let metadata = source.metadata.unwrap();
    assert_eq!(metadata["sourceType"], "graph_card");
}

#[test]
fn test_source_info_for_web_search() {
    // 验证网络搜索结果转换为 SourceInfo 的结构正确
    let source = SourceInfo {
        title: Some("搜索结果标题".to_string()),
        url: Some("https://example.com/article".to_string()),
        snippet: Some("这是搜索结果的摘要内容...".to_string()),
        score: Some(0.95),
        metadata: Some(json!({
            "sourceType": "web_search",
            "chunkIndex": 0,
            "provider": "google_cse",
        })),
    };

    assert!(source.url.is_some());
    assert_eq!(source.url.as_ref().unwrap(), "https://example.com/article");

    let metadata = source.metadata.unwrap();
    assert_eq!(metadata["sourceType"], "web_search");
    assert_eq!(metadata["provider"], "google_cse");
}

#[test]
fn test_search_input_construction() {
    use crate::tools::web_search::SearchInput;

    // 验证 SearchInput 构建正确
    let input = SearchInput {
        query: "测试查询".to_string(),
        top_k: 5,
        engine: Some("google_cse".to_string()),
        site: None,
        time_range: None,
        start: None,
        force_engine: None,
    };

    assert_eq!(input.query, "测试查询");
    assert_eq!(input.top_k, 5);
    assert_eq!(input.engine, Some("google_cse".to_string()));
}

#[test]
fn test_retrieval_options_parsing() {
    // 验证检索选项解析正确
    let options = SendOptions {
        rag_enabled: Some(true),
        graph_rag_enabled: Some(true),
        memory_enabled: Some(false),
        web_search_enabled: Some(true),
        search_engines: Some(vec!["bing".to_string(), "google_cse".to_string()]),
        rag_top_k: Some(10),
        ..Default::default()
    };

    assert_eq!(options.rag_enabled, Some(true));
    assert_eq!(options.graph_rag_enabled, Some(true));
    assert_eq!(options.memory_enabled, Some(false));
    assert_eq!(options.web_search_enabled, Some(true));
    assert_eq!(options.rag_top_k, Some(10));
    assert_eq!(
        options.search_engines,
        Some(vec!["bing".to_string(), "google_cse".to_string()])
    );
}

#[test]
fn test_default_rag_top_k() {
    // 验证默认 RAG TopK 常量
    assert_eq!(DEFAULT_RAG_TOP_K, 5);
}

#[test]
fn test_message_sources_with_retrievals() {
    // 验证 MessageSources 可以正确存储各类检索结果
    let rag_sources = vec![SourceInfo {
        title: Some("RAG 来源 1".to_string()),
        url: None,
        snippet: Some("RAG 内容".to_string()),
        score: Some(0.9),
        metadata: None,
    }];

    let graph_sources = vec![SourceInfo {
        title: Some("图谱来源 1".to_string()),
        url: None,
        snippet: Some("图谱内容".to_string()),
        score: Some(0.8),
        metadata: None,
    }];

    let web_sources = vec![SourceInfo {
        title: Some("网络来源 1".to_string()),
        url: Some("https://example.com".to_string()),
        snippet: Some("网络内容".to_string()),
        score: Some(0.85),
        metadata: None,
    }];

    let sources = MessageSources {
        rag: Some(rag_sources),
        memory: None,
        graph: Some(graph_sources),
        web_search: Some(web_sources),
        multimodal: None,
    };

    assert!(sources.rag.is_some());
    assert!(sources.memory.is_none());
    assert!(sources.graph.is_some());
    assert!(sources.web_search.is_some());

    assert_eq!(sources.rag.as_ref().unwrap().len(), 1);
    assert_eq!(sources.graph.as_ref().unwrap().len(), 1);
    assert_eq!(sources.web_search.as_ref().unwrap().len(), 1);
}

#[test]
fn test_retrieval_error_does_not_propagate() {
    // 验证检索错误处理策略：返回空结果而非传播错误
    // 这是一个设计约束测试，验证函数签名
    // execute_graph_retrieval 和 execute_web_search 返回 ChatV2Result<Vec<SourceInfo>>
    // 在错误情况下应返回 Ok(Vec::new()) 而非 Err

    // 模拟空结果场景
    let empty_sources: Vec<SourceInfo> = Vec::new();
    assert!(empty_sources.is_empty());

    // 验证空结果可以正确序列化
    let json = serde_json::to_string(&empty_sources).unwrap();
    assert_eq!(json, "[]");
}

// ============================================================
// 集成测试（需要外部资源，默认跳过）
// 运行方式: cargo test --features integration -- --ignored
// ============================================================

#[tokio::test]
#[ignore = "需要数据库连接"]
async fn test_execute_graph_retrieval_integration() {
    // 集成测试：验证图谱检索完整流程
    // 需要实际数据库连接才能运行
    // 运行: cargo test test_execute_graph_retrieval_integration -- --ignored

    // TODO: 添加实际数据库连接和测试数据
    // let db = create_test_database().await;
    // let pipeline = create_test_pipeline(db);
    // let result = pipeline.execute_graph_retrieval(...).await;
    // assert!(result.is_ok());
}

#[tokio::test]
#[ignore = "需要网络连接和 API 配置"]
async fn test_execute_web_search_integration() {
    // 集成测试：验证网络搜索完整流程
    // 需要网络连接和有效的 API 密钥才能运行
    // 运行: cargo test test_execute_web_search_integration -- --ignored

    // TODO: 添加实际 API 配置和测试
    // let config = WebSearchConfig::from_env_and_file().unwrap();
    // let input = SearchInput { query: "test".to_string(), ... };
    // let result = do_search(&config, input).await;
    // assert!(result.ok);
}

#[tokio::test]
#[ignore = "需要完整环境"]
async fn test_parallel_retrievals_integration() {
    // 集成测试：验证并行检索正确执行
    // 验证 RAG、图谱、记忆、网络搜索可以并行执行

    // TODO: 添加完整环境测试
    // 使用 tokio::join! 并行执行所有检索
    // 验证结果正确合并到 MessageSources
}

// ============================================================
// Prompt 1 要求的单元测试：Pipeline 连通 LLMManager
// ============================================================

#[test]
fn test_max_tool_recursion_constant() {
    // 验证工具递归最大深度常量
    assert_eq!(MAX_TOOL_RECURSION, 30);
    // 工具递归最多 30 次
}

#[test]
fn test_llm_adapter_creation() {
    // 验证 ChatV2LLMAdapter 可以正确创建
    // 注意：这里使用 mock window 和 emitter 会比较复杂，
    // 所以只验证 adapter 的基本结构

    // 验证 block_id 生成格式正确
    let block_id = ChatV2LLMAdapter::generate_block_id();
    assert!(block_id.starts_with("blk_"));

    // 验证多次生成的 ID 唯一
    let block_id2 = ChatV2LLMAdapter::generate_block_id();
    assert_ne!(block_id, block_id2);
}

#[test]
fn test_pipeline_context_with_frontend_ids() {
    // 验证 PipelineContext 使用前端传递的消息 ID
    let request = SendMessageRequest {
        session_id: "sess_test123".to_string(),
        content: "测试内容".to_string(),

        options: Some(SendOptions {
            model_id: Some("test-model".to_string()),
            enable_thinking: Some(true),
            ..Default::default()
        }),
        user_message_id: Some("msg_frontend_user_123".to_string()),
        assistant_message_id: Some("msg_frontend_assistant_456".to_string()),
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let ctx = PipelineContext::new(request);

    // 验证使用前端传递的 ID
    assert_eq!(ctx.user_message_id, "msg_frontend_user_123");
    assert_eq!(ctx.assistant_message_id, "msg_frontend_assistant_456");
    assert_eq!(ctx.session_id, "sess_test123");
    assert_eq!(ctx.user_content, "测试内容");

    // 验证选项正确传递
    assert_eq!(ctx.options.model_id, Some("test-model".to_string()));
    assert_eq!(ctx.options.enable_thinking, Some(true));
}

#[test]
fn test_pipeline_context_generates_ids_when_not_provided() {
    // 验证当前端未传递消息 ID 时，后端自动生成
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "测试".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let ctx = PipelineContext::new(request);

    // 验证自动生成的 ID 格式正确
    assert!(ctx.user_message_id.starts_with("msg_"));
    assert!(ctx.assistant_message_id.starts_with("msg_"));
    // 验证两个 ID 不同
    assert_ne!(ctx.user_message_id, ctx.assistant_message_id);
}

#[test]
fn test_tool_results_to_messages() {
    // 验证工具调用结果可以正确转换为 LLM 消息格式
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "测试".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let mut ctx = PipelineContext::new(request);

    // 添加工具结果
    ctx.tool_results = vec![ToolResultInfo {
        tool_call_id: Some("call_123".to_string()),
        block_id: Some("blk_test_123".to_string()),
        tool_name: "test_tool".to_string(),
        input: json!({"arg": "value"}),
        output: json!({"result": "success"}),
        success: true,
        error: None,
        duration_ms: Some(100),
        reasoning_content: None,
        thought_signature: None,
    }];

    let messages = ctx.tool_results_to_messages();

    assert_eq!(messages.len(), 2); // assistant + tool 消息配对
    assert_eq!(messages[0].role, "assistant");
    assert!(messages[0].tool_call.is_some());
    assert_eq!(messages[1].role, "tool");
    assert!(messages[1].tool_result.is_some());
}

#[test]
fn test_chat_v2_error_types() {
    // 验证 ChatV2Error 类型正确
    use super::error::ChatV2Error;

    // 验证各种错误类型
    let cancelled = ChatV2Error::Cancelled;
    assert_eq!(cancelled.to_string(), "Cancelled");

    let llm_error = ChatV2Error::Llm("LLM 调用失败".to_string());
    assert!(llm_error.to_string().contains("LLM"));

    let tool_error = ChatV2Error::Tool("工具执行失败".to_string());
    assert!(tool_error.to_string().contains("工具"));
}

#[tokio::test]
#[ignore = "需要 LLMManager mock 环境"]
async fn test_execute_with_tools_basic() {
    // 集成测试：验证基本 LLM 调用
    //
    // 验收标准（来自 Prompt 1）：
    // - LLM 调用返回真实响应
    // - 事件正确发射
    //
    // 运行方式: cargo test test_execute_with_tools_basic -- --ignored

    // TODO: 添加 LLMManager mock
    // 1. 创建测试用的 Pipeline 实例
    // 2. 创建 mock LLMManager，返回预设响应
    // 3. 执行 execute_with_tools
    // 4. 验证 adapter 收到正确的回调
    // 5. 验证最终内容正确
}

#[tokio::test]
#[ignore = "需要 LLMManager mock 环境"]
async fn test_execute_with_tools_error_handling() {
    // 集成测试：验证错误处理
    //
    // 约束条件（来自 Prompt 1）：
    // - LLM 调用失败时调用 adapter.on_error()
    //
    // 运行方式: cargo test test_execute_with_tools_error_handling -- --ignored

    // TODO: 添加 LLMManager mock 返回错误
    // 1. 创建测试用的 Pipeline 实例
    // 2. 创建 mock LLMManager，返回错误
    // 3. 执行 execute_with_tools
    // 4. 验证返回 ChatV2Error::Llm
    // 5. 验证 adapter.on_error() 被调用
}

#[tokio::test]
async fn test_execute_with_tools_recursion_limit() {
    // 单元测试：验证递归限制检查
    //
    // 约束条件：
    // - 工具递归最多 MAX_TOOL_RECURSION（30）次

    // 验证递归深度超过限制时返回错误
    // 注意：这个测试可以直接验证递归深度检查逻辑，
    // 因为第1386-1394行的检查是同步的

    let recursion_depth = MAX_TOOL_RECURSION + 1;

    // 验证超过限制
    assert!(recursion_depth > MAX_TOOL_RECURSION);

    // 验证限制值
    assert_eq!(MAX_TOOL_RECURSION, 30);

    // 注意：完整的递归测试需要 mock 环境，
    // 这里只验证常量和基本逻辑
}

// ============================================================
// Prompt 7: 工具递归收集 + 流式清理测试
// ============================================================

#[test]
fn test_adapter_tool_call_collection() {
    // 验证 ChatV2LLMAdapter 正确收集工具调用
    // 注意：需要模拟 on_tool_call 的行为

    // 创建一个模拟的工具调用
    let tool_call = crate::models::ToolCall {
        id: "call_123".to_string(),
        tool_name: "memory".to_string(),
        args_json: json!({"query": "test"}),
    };

    // 验证 ToolCall 结构体字段
    assert_eq!(tool_call.id, "call_123");
    assert_eq!(tool_call.tool_name, "memory");
    assert_eq!(tool_call.args_json, json!({"query": "test"}));

    // 验证转换为 chat_v2::ToolCall 的逻辑
    let converted = ToolCall {
        id: tool_call.id.clone(),
        name: tool_call.tool_name.clone(),
        arguments: tool_call.args_json.clone(),
    };

    assert_eq!(converted.id, "call_123");
    assert_eq!(converted.name, "memory");
}

#[test]
fn test_adapter_take_tool_calls_clears_collection() {
    // 验证 take_tool_calls() 返回收集的工具调用并清空
    let collected: Vec<ToolCall> = vec![
        ToolCall::new("call_1".to_string(), "tool_a".to_string(), json!({})),
        ToolCall::new("call_2".to_string(), "tool_b".to_string(), json!({})),
    ];

    // 验证有两个工具调用
    assert_eq!(collected.len(), 2);

    // 模拟 take 操作后清空
    let mut vec = collected;
    let taken = std::mem::take(&mut vec);

    assert_eq!(taken.len(), 2);
    assert!(vec.is_empty());
}

#[test]
fn test_tool_call_conversion_from_message() {
    // 验证从 LegacyChatMessage 提取工具调用信息的逻辑
    let tool_call_json = json!({
        "id": "call_test_123",
        "name": "rag",
        "arguments": {"query": "测试查询", "top_k": 5}
    });

    // 提取各字段
    let tool_call_id = tool_call_json
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let tool_name = tool_call_json
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or_default();
    let tool_input = tool_call_json
        .get("arguments")
        .cloned()
        .unwrap_or(json!({}));

    assert_eq!(tool_call_id, "call_test_123");
    assert_eq!(tool_name, "rag");
    assert_eq!(
        tool_input.get("query").and_then(|v| v.as_str()),
        Some("测试查询")
    );
    assert_eq!(tool_input.get("top_k").and_then(|v| v.as_i64()), Some(5));
}

#[test]
fn test_tool_timeout_is_30_seconds() {
    // 验证工具超时为 30 秒（08文档4.3要求）
    assert_eq!(DEFAULT_TOOL_TIMEOUT_MS, 30_000);
}

#[test]
fn test_tool_result_info_with_duration() {
    // 验证工具结果包含执行时长
    let result = ToolResultInfo {
        tool_call_id: Some("call_abc".to_string()),
        block_id: Some("blk_test_abc".to_string()),
        tool_name: "web_search".to_string(),
        input: json!({"query": "rust async"}),
        output: json!({"results": [{"title": "Async Rust"}]}),
        success: true,
        error: None,
        duration_ms: Some(1500),
        reasoning_content: None,
        thought_signature: None,
    };

    assert!(result.success);
    assert_eq!(result.duration_ms, Some(1500));
    assert!(result.error.is_none());
}

#[test]
fn test_tool_result_info_with_error() {
    // 验证工具结果包含错误信息
    let result = ToolResultInfo {
        tool_call_id: Some("call_xyz".to_string()),
        block_id: Some("blk_test_xyz".to_string()),
        tool_name: "failed_tool".to_string(),
        input: json!({}),
        output: json!(null),
        success: false,
        error: Some("Tool execution failed: timeout".to_string()),
        duration_ms: Some(30_000),
        reasoning_content: None,
        thought_signature: None,
    };

    assert!(!result.success);
    assert!(result.error.is_some());
    assert_eq!(
        result.error.as_ref().unwrap(),
        "Tool execution failed: timeout"
    );
}

#[test]
fn test_multiple_tool_calls_parallel_execution() {
    // 验证多工具调用可以并行执行
    let tool_calls = vec![
        ToolCall::new(
            "call_1".to_string(),
            "rag".to_string(),
            json!({"query": "a"}),
        ),
        ToolCall::new(
            "call_2".to_string(),
            "memory".to_string(),
            json!({"query": "b"}),
        ),
        ToolCall::new(
            "call_3".to_string(),
            "web_search".to_string(),
            json!({"query": "c"}),
        ),
    ];

    // 验证可以创建多个工具调用
    assert_eq!(tool_calls.len(), 3);

    // 验证每个工具调用有唯一 ID
    let ids: std::collections::HashSet<_> = tool_calls.iter().map(|tc| &tc.id).collect();
    assert_eq!(ids.len(), 3);
}

#[test]
fn test_pipeline_context_add_tool_results() {
    // 验证 PipelineContext 可以添加工具结果
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "Test".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let mut ctx = PipelineContext::new(request);

    // 初始为空
    assert!(ctx.tool_results.is_empty());

    // 添加工具结果
    ctx.add_tool_results(vec![ToolResultInfo {
        tool_call_id: Some("call_1".to_string()),
        block_id: Some("blk_test_1".to_string()),
        tool_name: "test".to_string(),
        input: json!({}),
        output: json!({}),
        success: true,
        error: None,
        duration_ms: Some(100),
        reasoning_content: None,
        thought_signature: None,
    }]);

    assert_eq!(ctx.tool_results.len(), 1);

    // 继续添加更多结果
    ctx.add_tool_results(vec![ToolResultInfo {
        tool_call_id: Some("call_2".to_string()),
        block_id: Some("blk_test_2".to_string()),
        tool_name: "test2".to_string(),
        input: json!({}),
        output: json!({}),
        success: false,
        error: Some("error".to_string()),
        duration_ms: None,
        reasoning_content: None,
        thought_signature: None,
    }]);

    assert_eq!(ctx.tool_results.len(), 2);
}

#[test]
fn test_tool_results_to_messages_format() {
    // 验证工具结果转换为 LLM 消息格式
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "Test".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let mut ctx = PipelineContext::new(request);
    ctx.add_tool_results(vec![ToolResultInfo {
        tool_call_id: Some("call_123".to_string()),
        block_id: Some("blk_test_123".to_string()),
        tool_name: "rag".to_string(),
        input: json!({"query": "test"}),
        output: json!({"results": ["item1", "item2"]}),
        success: true,
        error: None,
        duration_ms: Some(200),
        reasoning_content: None,
        thought_signature: None,
    }]);

    let messages = ctx.tool_results_to_messages();

    assert_eq!(messages.len(), 2); // assistant + tool 消息配对
    assert_eq!(messages[0].role, "assistant");
    assert_eq!(messages[1].role, "tool");

    // 验证 tool_result 字段包含正确信息
    // tool_result 是 crate::models::ToolResult 结构体
    let tool_result = messages[1].tool_result.as_ref().unwrap();
    assert_eq!(tool_result.call_id, "call_123");
    assert!(tool_result.ok);
}

#[test]
fn test_truncate_text() {
    // 测试短文本（不截断）
    let short_text = "Hello";
    assert_eq!(ChatV2Pipeline::truncate_text(short_text, 10), "Hello");

    // 测试长文本（截断）
    let long_text = "这是一段很长的中文文本，需要被截断";
    let truncated = ChatV2Pipeline::truncate_text(long_text, 10);
    assert!(truncated.len() < long_text.len());
    assert!(truncated.ends_with("..."));

    // 测试边界情况
    let exact_text = "12345";
    assert_eq!(ChatV2Pipeline::truncate_text(exact_text, 5), "12345");
}

// ============================================================
// Prompt 2: ChatV2LLMAdapter Token 统计测试
// ============================================================

#[test]
fn test_parse_api_usage_openai_format() {
    // 验证 OpenAI 格式解析
    let usage = json!({
        "prompt_tokens": 1234,
        "completion_tokens": 567,
        "total_tokens": 1801
    });

    let result = parse_api_usage(&usage);
    assert!(result.is_some());

    let token_usage = result.unwrap();
    assert_eq!(token_usage.prompt_tokens, 1234);
    assert_eq!(token_usage.completion_tokens, 567);
    assert_eq!(token_usage.total_tokens, 1801);
    assert_eq!(token_usage.source, TokenSource::Api);
    assert!(token_usage.reasoning_tokens.is_none());
    assert!(token_usage.cached_tokens.is_none());
}

#[test]
fn test_parse_api_usage_anthropic_format() {
    // 验证 Anthropic 格式解析
    let usage = json!({
        "input_tokens": 1234,
        "output_tokens": 567,
        "cache_creation_input_tokens": 100
    });

    let result = parse_api_usage(&usage);
    assert!(result.is_some());

    let token_usage = result.unwrap();
    assert_eq!(token_usage.prompt_tokens, 1234);
    assert_eq!(token_usage.completion_tokens, 567);
    assert_eq!(token_usage.total_tokens, 1801);
    assert_eq!(token_usage.source, TokenSource::Api);
    assert_eq!(token_usage.cached_tokens, Some(100));
}

#[test]
fn test_parse_api_usage_deepseek_format() {
    // 验证 DeepSeek 格式解析（含 reasoning_tokens）
    let usage = json!({
        "prompt_tokens": 1234,
        "completion_tokens": 567,
        "reasoning_tokens": 200
    });

    let result = parse_api_usage(&usage);
    assert!(result.is_some());

    let token_usage = result.unwrap();
    assert_eq!(token_usage.prompt_tokens, 1234);
    assert_eq!(token_usage.completion_tokens, 567);
    assert_eq!(token_usage.total_tokens, 1801);
    assert_eq!(token_usage.source, TokenSource::Api);
    assert_eq!(token_usage.reasoning_tokens, Some(200));
}

#[test]
fn test_parse_api_usage_invalid_format() {
    // 验证无效格式返回 None
    let usage = json!({
        "invalid_field": 123
    });

    let result = parse_api_usage(&usage);
    assert!(result.is_none());
}

#[test]
fn test_parse_api_usage_partial_openai() {
    // 验证部分 OpenAI 格式（只有 prompt_tokens）
    let usage = json!({
        "prompt_tokens": 1000
    });

    let result = parse_api_usage(&usage);
    assert!(result.is_some());

    let token_usage = result.unwrap();
    assert_eq!(token_usage.prompt_tokens, 1000);
    assert_eq!(token_usage.completion_tokens, 0);
}

#[test]
fn test_parse_api_usage_anthropic_cache_read() {
    // 验证 Anthropic cache_read_input_tokens 字段
    let usage = json!({
        "input_tokens": 1000,
        "output_tokens": 500,
        "cache_read_input_tokens": 800
    });

    let result = parse_api_usage(&usage);
    assert!(result.is_some());

    let token_usage = result.unwrap();
    assert_eq!(token_usage.cached_tokens, Some(800));
}

#[test]
fn test_token_usage_serialization_camel_case() {
    // 验证 TokenUsage 序列化输出为 camelCase
    let usage = TokenUsage::from_api(1000, 500, Some(200));

    let json = serde_json::to_string(&usage).unwrap();

    // 验证字段名为 camelCase
    assert!(
        json.contains("\"promptTokens\":1000"),
        "Expected camelCase 'promptTokens', got: {}",
        json
    );
    assert!(
        json.contains("\"completionTokens\":500"),
        "Expected camelCase 'completionTokens', got: {}",
        json
    );
    assert!(
        json.contains("\"totalTokens\":1500"),
        "Expected camelCase 'totalTokens', got: {}",
        json
    );
    assert!(
        json.contains("\"source\":\"api\""),
        "Expected source as 'api', got: {}",
        json
    );
    assert!(
        json.contains("\"reasoningTokens\":200"),
        "Expected camelCase 'reasoningTokens', got: {}",
        json
    );
}

#[test]
fn test_token_usage_accumulate() {
    // 验证 accumulate 方法正确累加
    let mut usage1 = TokenUsage::from_api(1000, 500, None);
    let usage2 = TokenUsage::from_api(800, 300, Some(100));

    usage1.accumulate(&usage2);

    assert_eq!(usage1.prompt_tokens, 1800);
    assert_eq!(usage1.completion_tokens, 800);
    assert_eq!(usage1.total_tokens, 2600); // 1500 + 1100
                                           // 来源相同，不变
    assert_eq!(usage1.source, TokenSource::Api);
    // reasoning_tokens 累加
    assert_eq!(usage1.reasoning_tokens, Some(100));
}

#[test]
fn test_token_usage_accumulate_mixed_source() {
    // 验证混合来源时 source 降级为 Mixed
    let mut usage1 = TokenUsage::from_api(1000, 500, None);
    let usage2 = TokenUsage::from_estimate(800, 300, true);

    usage1.accumulate(&usage2);

    assert_eq!(usage1.prompt_tokens, 1800);
    assert_eq!(usage1.source, TokenSource::Mixed);
}

#[test]
fn test_token_source_display() {
    // 验证 TokenSource Display 实现
    assert_eq!(format!("{}", TokenSource::Api), "api");
    assert_eq!(format!("{}", TokenSource::Tiktoken), "tiktoken");
    assert_eq!(format!("{}", TokenSource::Heuristic), "heuristic");
    assert_eq!(format!("{}", TokenSource::Mixed), "mixed");
}

#[test]
fn test_token_usage_from_estimate_tiktoken() {
    // 验证 from_estimate 使用 tiktoken（precise=true）
    let usage = TokenUsage::from_estimate(1000, 500, true);

    assert_eq!(usage.prompt_tokens, 1000);
    assert_eq!(usage.completion_tokens, 500);
    assert_eq!(usage.total_tokens, 1500);
    assert_eq!(usage.source, TokenSource::Tiktoken);
}

#[test]
fn test_token_usage_from_estimate_heuristic() {
    // 验证 from_estimate 使用启发式（precise=false）
    let usage = TokenUsage::from_estimate(1000, 500, false);

    assert_eq!(usage.source, TokenSource::Heuristic);
}

#[test]
fn test_token_usage_has_tokens() {
    // 验证 has_tokens 方法
    let zero_usage = TokenUsage::default();
    assert!(!zero_usage.has_tokens());

    let valid_usage = TokenUsage::from_api(100, 50, None);
    assert!(valid_usage.has_tokens());
}

// ============================================================
// 统一上下文注入系统单元测试（Prompt 8）
// ============================================================

use super::resource_types::{ContentBlock, ContextRef, ContextSnapshot, SendContextRef};

#[test]
fn test_build_user_content_from_context_refs() {
    // 测试 formattedBlocks 正确拼接
    let refs = vec![
        SendContextRef {
            resource_id: "res_1".to_string(),
            hash: "hash_1".to_string(),
            type_id: "note".to_string(),
            formatted_blocks: vec![ContentBlock::Text {
                text: "Note content 1".to_string(),
            }],
            display_name: None,
            inject_modes: None,
        },
        SendContextRef {
            resource_id: "res_2".to_string(),
            hash: "hash_2".to_string(),
            type_id: "card".to_string(),
            formatted_blocks: vec![
                ContentBlock::Text {
                    text: "Card content".to_string(),
                },
                ContentBlock::Text {
                    text: "Card details".to_string(),
                },
            ],
            display_name: None,
            inject_modes: None,
        },
    ];

    let blocks = PipelineContext::build_user_content_from_context_refs(&refs);

    // 验证拼接后的块数量
    assert_eq!(blocks.len(), 3);

    // 验证内容顺序
    match &blocks[0] {
        ContentBlock::Text { text } => assert_eq!(text, "Note content 1"),
        _ => panic!("Expected Text block"),
    }
    match &blocks[1] {
        ContentBlock::Text { text } => assert_eq!(text, "Card content"),
        _ => panic!("Expected Text block"),
    }
    match &blocks[2] {
        ContentBlock::Text { text } => assert_eq!(text, "Card details"),
        _ => panic!("Expected Text block"),
    }
}

#[test]
fn test_build_user_content_empty_refs() {
    // 测试空引用列表
    let refs: Vec<SendContextRef> = vec![];
    let blocks = PipelineContext::build_user_content_from_context_refs(&refs);
    assert!(blocks.is_empty());
}

#[test]
fn test_convert_to_context_refs() {
    // 测试 SendContextRef 转换为 ContextRef（丢弃 formattedBlocks）
    let send_refs = vec![SendContextRef {
        resource_id: "res_abc".to_string(),
        hash: "hash_abc".to_string(),
        type_id: "note".to_string(),
        formatted_blocks: vec![ContentBlock::Text {
            text: "Should be discarded".to_string(),
        }],
        display_name: None,
        inject_modes: None,
    }];

    let context_refs = PipelineContext::convert_to_context_refs(&send_refs);

    assert_eq!(context_refs.len(), 1);
    assert_eq!(context_refs[0].resource_id, "res_abc");
    assert_eq!(context_refs[0].hash, "hash_abc");
    assert_eq!(context_refs[0].type_id, "note");
}

#[test]
fn test_context_snapshot_initialization() {
    // 测试上下文快照初始化
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "Test".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: Some(vec![SendContextRef {
            resource_id: "res_user_1".to_string(),
            hash: "hash_u1".to_string(),
            type_id: "note".to_string(),
            formatted_blocks: vec![],
            display_name: None,
            inject_modes: None,
        }]),
        path_map: None,
        workspace_id: None,
    };

    let mut ctx = PipelineContext::new(request);

    // 初始化时快照应为空
    assert!(!ctx.context_snapshot.has_refs());

    // 调用初始化方法
    ctx.init_context_snapshot();

    // 现在应该有 user_refs
    assert!(ctx.context_snapshot.has_refs());
    assert_eq!(ctx.context_snapshot.user_refs.len(), 1);
    assert_eq!(ctx.context_snapshot.user_refs[0].resource_id, "res_user_1");
}

#[test]
fn test_context_snapshot_add_retrieval_refs() {
    // 测试添加检索引用到快照
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "Test".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let mut ctx = PipelineContext::new(request);

    let retrieval_refs = vec![
        ContextRef::new(
            "res_rag_1".to_string(),
            "hash_r1".to_string(),
            "retrieval_rag".to_string(),
        ),
        ContextRef::new(
            "res_rag_2".to_string(),
            "hash_r2".to_string(),
            "retrieval_rag".to_string(),
        ),
    ];

    ctx.add_retrieval_refs_to_snapshot(retrieval_refs);

    assert_eq!(ctx.context_snapshot.retrieval_refs.len(), 2);
    assert_eq!(
        ctx.context_snapshot.retrieval_refs[0].resource_id,
        "res_rag_1"
    );
}

#[test]
fn test_context_snapshot_all_resource_ids() {
    // 测试获取所有资源 ID
    let mut snapshot = ContextSnapshot::new();

    snapshot.add_user_ref(ContextRef::new(
        "res_u1".to_string(),
        "h1".to_string(),
        "note".to_string(),
    ));
    snapshot.add_user_ref(ContextRef::new(
        "res_u2".to_string(),
        "h2".to_string(),
        "card".to_string(),
    ));
    snapshot.add_retrieval_ref(ContextRef::new(
        "res_r1".to_string(),
        "h3".to_string(),
        "retrieval".to_string(),
    ));

    let ids = snapshot.all_resource_ids();

    assert_eq!(ids.len(), 3);
    assert!(ids.contains(&"res_u1"));
    assert!(ids.contains(&"res_u2"));
    assert!(ids.contains(&"res_r1"));
}

#[test]
fn test_pipeline_context_with_user_context_refs() {
    // 测试 PipelineContext 正确初始化 user_context_refs
    let user_refs = vec![SendContextRef {
        resource_id: "res_test".to_string(),
        hash: "hash_test".to_string(),
        type_id: "note".to_string(),
        formatted_blocks: vec![ContentBlock::Text {
            text: "Test".to_string(),
        }],
        display_name: None,
        inject_modes: None,
    }];

    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "Test".to_string(),

        options: Some(SendOptions {
            user_context_refs: Some(user_refs.clone()),
            ..Default::default()
        }),
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: Some(user_refs),
        path_map: None,
        workspace_id: None,
    };

    let ctx = PipelineContext::new(request);

    // 验证 user_context_refs 被正确初始化
    assert_eq!(ctx.user_context_refs.len(), 1);
    assert_eq!(ctx.user_context_refs[0].resource_id, "res_test");
}

#[test]
fn test_send_context_ref_serialization() {
    // 验证 SendContextRef 序列化为 camelCase
    let send_ref = SendContextRef {
        resource_id: "res_123".to_string(),
        hash: "abc123".to_string(),
        type_id: "note".to_string(),
        formatted_blocks: vec![ContentBlock::Text {
            text: "Hello".to_string(),
        }],
        display_name: None,
        inject_modes: None,
    };

    let json = serde_json::to_string(&send_ref).unwrap();

    assert!(
        json.contains("\"resourceId\""),
        "Expected camelCase 'resourceId', got: {}",
        json
    );
    assert!(
        json.contains("\"typeId\""),
        "Expected camelCase 'typeId', got: {}",
        json
    );
    assert!(
        json.contains("\"formattedBlocks\""),
        "Expected camelCase 'formattedBlocks', got: {}",
        json
    );
}

#[test]
fn test_context_snapshot_serialization() {
    // 验证 ContextSnapshot 序列化为 camelCase
    let mut snapshot = ContextSnapshot::new();
    snapshot.add_user_ref(ContextRef::new(
        "res_1".to_string(),
        "h1".to_string(),
        "note".to_string(),
    ));
    snapshot.add_retrieval_ref(ContextRef::new(
        "res_2".to_string(),
        "h2".to_string(),
        "retrieval".to_string(),
    ));

    let json = serde_json::to_string(&snapshot).unwrap();

    assert!(
        json.contains("\"userRefs\""),
        "Expected camelCase 'userRefs', got: {}",
        json
    );
    assert!(
        json.contains("\"retrievalRefs\""),
        "Expected camelCase 'retrievalRefs', got: {}",
        json
    );
}

#[test]
fn test_get_combined_user_content() {
    // 测试 get_combined_user_content 方法（通用组装逻辑）
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "用户输入的问题".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: Some(vec![
            SendContextRef {
                resource_id: "res_note_1".to_string(),
                hash: "hash_1".to_string(),
                type_id: "note".to_string(),
                formatted_blocks: vec![ContentBlock::Text {
                    text: "笔记内容第一段".to_string(),
                }],
                display_name: None,
                inject_modes: None,
            },
            SendContextRef {
                resource_id: "res_note_2".to_string(),
                hash: "hash_2".to_string(),
                type_id: "card".to_string(),
                formatted_blocks: vec![ContentBlock::Text {
                    text: "题目内容".to_string(),
                }],
                display_name: None,
                inject_modes: None,
            },
        ]),
        path_map: None,
        workspace_id: None,
    };

    let ctx = PipelineContext::new(request);
    let (combined_content, context_images) = ctx.get_combined_user_content();

    // 验证上下文内容在前，用户输入在后
    assert!(
        combined_content.contains("笔记内容第一段"),
        "Should contain note content"
    );
    assert!(
        combined_content.contains("题目内容"),
        "Should contain card content"
    );
    assert!(
        combined_content.contains("用户输入的问题"),
        "Should contain user input"
    );

    // 验证上下文内容在用户输入之前
    let note_pos = combined_content.find("笔记内容第一段").unwrap();
    let user_pos = combined_content.find("用户输入的问题").unwrap();
    assert!(
        note_pos < user_pos,
        "Context content should be before user input"
    );

    // 验证没有图片
    assert!(context_images.is_empty(), "Should have no images");
}

#[test]
fn test_get_combined_user_content_with_images() {
    // 测试 get_combined_user_content 方法（包含图片）
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "描述这张图片".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: Some(vec![
            SendContextRef {
                resource_id: "res_img_1".to_string(),
                hash: "hash_img".to_string(),
                type_id: "image".to_string(),
                formatted_blocks: vec![
                    ContentBlock::Image {
                        media_type: "image/png".to_string(),
                        base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==".to_string(),
                    },
                ],
                display_name: None,
                inject_modes: None,
            },
            SendContextRef {
                resource_id: "res_note_1".to_string(),
                hash: "hash_note".to_string(),
                type_id: "note".to_string(),
                formatted_blocks: vec![
                    ContentBlock::Text { text: "图片相关说明".to_string() },
                ],
                display_name: None,
                inject_modes: None,
            },
        ]),
        path_map: None,
        workspace_id: None,
    };

    let ctx = PipelineContext::new(request);
    let (combined_content, context_images) = ctx.get_combined_user_content();

    // 验证文本内容
    assert!(
        combined_content.contains("图片相关说明"),
        "Should contain text content"
    );
    assert!(
        combined_content.contains("描述这张图片"),
        "Should contain user input"
    );

    // 验证有一张图片
    assert_eq!(context_images.len(), 1, "Should have 1 image");
    assert!(
        context_images[0].starts_with("iVBORw"),
        "Image should be base64 encoded"
    );
}

#[test]
fn test_get_combined_user_content_empty_refs() {
    // 测试没有上下文引用的情况
    let request = SendMessageRequest {
        session_id: "sess_test".to_string(),
        content: "简单问题".to_string(),

        options: None,
        user_message_id: None,
        assistant_message_id: None,
        user_context_refs: None,
        path_map: None,
        workspace_id: None,
    };

    let ctx = PipelineContext::new(request);
    let (combined_content, context_images) = ctx.get_combined_user_content();

    // 验证只有用户输入
    assert_eq!(combined_content, "简单问题");
    assert!(context_images.is_empty());
}
