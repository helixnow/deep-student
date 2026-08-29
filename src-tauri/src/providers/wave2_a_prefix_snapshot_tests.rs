//! Wave2-A R7 #7：post-adapter body 前缀段快照对比（只写不跑）。
//!
//! 供应商侧 prompt cache（OpenAI automatic prefix cache / GPT-5.6+ 显式断点、
//! Anthropic ephemeral 断点、DeepSeek 自动前缀缓存）都要求：同一会话连续
//! 两次请求经适配器转换后的**稳定前缀段**（tools 定义 + system/instructions）
//! 在线路字节层面逐字节相等，否则缓存必然 miss。本文件对三条转换路径做
//! 快照级（serde_json 序列化字节）对比：
//!
//! - OpenAI Chat Completions：`OpenAIAdapter::build_request`
//!   （`sanitize_openai_request_body` 之后的 body；DeepSeek chat 走同一路径）
//! - OpenAI Responses：`OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint`
//!   （gpt-5.6 官方端点 → input[0] developer 显式断点块；
//!   DeepSeek Responses → 顶层 instructions + 自动前缀缓存）
//! - Anthropic Messages：`AnthropicAdapter::convert_openai_to_anthropic`
//!   （system 尾 / tools 尾自动补 ephemeral 断点，ROUND-02 P2-11）
//!
//! 注意：serde_json 启用 preserve_order（Cargo.toml），因此同一构造路径
//! 产生的 Value 序列化字节是确定的——两次请求前缀段若构造自相同输入，
//! 字节必须完全一致；任何 marker 漂移、字段顺序抖动、归一化不稳定都会
//! 在这里以字节 diff 形式暴露。
//!
//! 接线：本文件需要在 providers/mod.rs 中以
//! `#[cfg(test)] mod wave2_a_prefix_snapshot_tests;` 声明后才会编译，
//! 按本轮任务约定由集成轮统一接线，此处不改 mod.rs。

#![cfg(test)]

use super::{AnthropicAdapter, OpenAIAdapter, OpenAIResponsesAdapter, ProviderAdapter};
use serde_json::{json, Value};

// ============================================================
// 夹具：两次连续请求共享的稳定前缀（system + tools）与变化的会话尾部
// ============================================================

fn system_message() -> Value {
    json!({
        "role": "system",
        "content": "你是 Deep Student 的学习助手。回答保持简洁，需要资料时优先调用工具检索。"
    })
}

fn tool_definitions() -> Value {
    json!([
        {
            "type": "function",
            "function": {
                "name": "search_notes",
                "description": "按关键词检索本地笔记",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": { "type": "string" },
                        "limit": { "type": "integer" }
                    },
                    "required": ["query"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "create_card",
                "description": "创建一张 Anki 卡片",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "front": { "type": "string" },
                        "back": { "type": "string" }
                    },
                    "required": ["front", "back"]
                }
            }
        },
        {
            // 故意缺 parameters：sanitize/convert 会补默认 schema，
            // 两次请求的归一化结果必须字节一致
            "type": "function",
            "function": {
                "name": "list_decks",
                "description": "列出全部牌组"
            }
        }
    ])
}

/// 第 1 次请求的会话尾部：单条 user 消息。
fn first_turn_messages() -> Vec<Value> {
    vec![json!({ "role": "user", "content": "帮我总结昨天的错题" })]
}

/// 第 2 次请求的会话尾部：第 1 轮 + 助手工具调用 + 工具结果 + 新 user 消息，
/// 模拟 agent 工具循环里最常见的"仅尾部追加"形态。
fn second_turn_messages() -> Vec<Value> {
    let mut messages = first_turn_messages();
    messages.push(json!({
        "role": "assistant",
        "content": "",
        "tool_calls": [{
            "id": "call_1",
            "type": "function",
            "function": {
                "name": "search_notes",
                "arguments": "{\"query\":\"错题\"}"
            }
        }]
    }));
    messages.push(json!({
        "role": "tool",
        "tool_call_id": "call_1",
        "content": "共 3 道错题：一元二次方程、余弦定理、电磁感应"
    }));
    messages.push(json!({ "role": "user", "content": "把第一道整理成卡片" }));
    messages
}

/// 组装 OpenAI Chat Completions 形状的入站 body：
/// system 在首位，tools/tool_choice 固定，会话尾部由调用方传入。
fn request_body(turn_messages: Vec<Value>) -> Value {
    let mut messages = vec![system_message()];
    messages.extend(turn_messages);
    json!({
        "messages": messages,
        "tools": tool_definitions(),
        "tool_choice": "auto",
        "stream": true,
        "max_tokens": 2048
    })
}

// ============================================================
// 快照工具：段级字节序列化 + 逐字节相等断言
// ============================================================

fn segment_bytes(label: &str, segment: &Value) -> Vec<u8> {
    assert!(
        !segment.is_null(),
        "{label} 段缺失（Null），前缀对比失去意义"
    );
    serde_json::to_vec(segment).unwrap_or_else(|err| panic!("{label} 段序列化失败: {err}"))
}

fn assert_segment_byte_identical(label: &str, first: &Value, second: &Value) {
    let first_bytes = segment_bytes(label, first);
    let second_bytes = segment_bytes(label, second);
    assert_eq!(
        first_bytes, second_bytes,
        "{label} 稳定前缀段在连续两次请求间应逐字节相等（否则供应商缓存必 miss）：\n\
         第一次: {first}\n第二次: {second}"
    );
}

// ============================================================
// OpenAI Chat Completions（sanitize 之后的 post-adapter body）
// ============================================================

#[test]
fn openai_chat_prefix_segments_byte_identical_across_consecutive_requests() {
    let adapter = OpenAIAdapter::new();

    let first = adapter
        .build_request(
            "https://api.openai.com/v1",
            "sk-test",
            "gpt-4.1",
            &request_body(first_turn_messages()),
        )
        .expect("first request should build");
    let second = adapter
        .build_request(
            "https://api.openai.com/v1",
            "sk-test",
            "gpt-4.1",
            &request_body(second_turn_messages()),
        )
        .expect("second request should build");

    // 前缀段 1：system 消息（messages[0]）必须原样保留在首位
    assert_eq!(first.body["messages"][0]["role"], json!("system"));
    assert_segment_byte_identical(
        "OpenAI chat system 消息",
        &first.body["messages"][0],
        &second.body["messages"][0],
    );

    // 前缀段 2：sanitize 归一化后的 tools 数组（含缺省 parameters 的补全）
    assert_segment_byte_identical(
        "OpenAI chat tools",
        &first.body["tools"],
        &second.body["tools"],
    );
    let tools = first.body["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 3, "三个工具定义都应保留");
    assert_eq!(
        tools[2]["function"]["parameters"],
        json!({ "type": "object", "properties": {} }),
        "缺省 parameters 应被稳定归一化为空对象 schema"
    );
}

// ============================================================
// OpenAI Responses（gpt-5.6 官方端点：developer 显式断点块）
// ============================================================

#[test]
fn openai_responses_developer_breakpoint_prefix_byte_identical_across_consecutive_requests() {
    let first = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
        "gpt-5.6",
        &request_body(first_turn_messages()),
        "https://api.openai.com/v1",
    );
    let second = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
        "gpt-5.6",
        &request_body(second_turn_messages()),
        "https://api.openai.com/v1",
    );

    // GPT-5.6 官方端点：system 指令改放 input[0] developer 块并打显式断点
    //（ROUND-02 P2-12），该块是"断点处精确匹配"缓存的锚点，必须字节稳定
    assert_eq!(first["input"][0]["role"], json!("developer"));
    assert_eq!(
        first["input"][0]["content"][0]["prompt_cache_breakpoint"]["mode"],
        json!("explicit")
    );
    assert_segment_byte_identical(
        "OpenAI Responses developer 断点块",
        &first["input"][0],
        &second["input"][0],
    );

    // tools 段：Responses 扁平工具形状，两次请求必须字节一致
    assert_segment_byte_identical("OpenAI Responses tools", &first["tools"], &second["tools"]);
    assert_eq!(
        first["tools"][0]["type"],
        json!("function"),
        "Responses 工具应为扁平 function 形状"
    );

    // 会话尾部确实在变（防止夹具退化成两次相同请求的自比较）
    let first_input = first["input"].as_array().expect("input array");
    let second_input = second["input"].as_array().expect("input array");
    assert!(
        second_input.len() > first_input.len(),
        "第二次请求应只在尾部追加消息"
    );
}

// ============================================================
// Anthropic Messages（system/tools 尾部 ephemeral 断点必须落点稳定）
// ============================================================

#[test]
fn anthropic_system_and_tools_prefix_byte_identical_across_consecutive_requests() {
    let adapter = AnthropicAdapter::new();

    let first = serde_json::to_value(
        adapter.convert_openai_to_anthropic("claude-fable-5", &request_body(first_turn_messages())),
    )
    .expect("first request should serialize");
    let second = serde_json::to_value(
        adapter
            .convert_openai_to_anthropic("claude-fable-5", &request_body(second_turn_messages())),
    )
    .expect("second request should serialize");

    // 前缀段 1：system 块数组（含自动补在尾块上的 ephemeral 断点，P2-11）
    assert_segment_byte_identical("Anthropic system", &first["system"], &second["system"]);
    let system_blocks = first["system"].as_array().expect("system blocks");
    assert_eq!(
        system_blocks
            .last()
            .and_then(|block| block.get("cache_control")),
        Some(&json!({ "type": "ephemeral" })),
        "system 尾块应自动带 ephemeral 断点且两次落点一致"
    );

    // 前缀段 2：tools 数组（尾工具同样自动补 ephemeral 断点）
    assert_segment_byte_identical("Anthropic tools", &first["tools"], &second["tools"]);
    let tools = first["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 3);
    assert_eq!(
        tools.last().and_then(|tool| tool.get("cache_control")),
        Some(&json!({ "type": "ephemeral" })),
        "tools 尾条目应自动带 ephemeral 断点且两次落点一致"
    );
    assert!(
        tools[..tools.len() - 1]
            .iter()
            .all(|tool| tool.get("cache_control").is_none()),
        "非尾部工具不应出现漂移的缓存断点"
    );
}

// ============================================================
// DeepSeek：chat（OpenAI 兼容路径）与 Responses（顶层 instructions）
// ============================================================

#[test]
fn deepseek_chat_prefix_segments_byte_identical_across_consecutive_requests() {
    let adapter = OpenAIAdapter::new();

    let first = adapter
        .build_request(
            "https://api.deepseek.com/v1",
            "sk-test",
            "deepseek-chat",
            &request_body(first_turn_messages()),
        )
        .expect("first request should build");
    let second = adapter
        .build_request(
            "https://api.deepseek.com/v1",
            "sk-test",
            "deepseek-chat",
            &request_body(second_turn_messages()),
        )
        .expect("second request should build");

    assert_segment_byte_identical(
        "DeepSeek chat system 消息",
        &first.body["messages"][0],
        &second.body["messages"][0],
    );
    assert_segment_byte_identical(
        "DeepSeek chat tools",
        &first.body["tools"],
        &second.body["tools"],
    );

    // DeepSeek 端点不是 api.openai.com：不得注入 stream_options 等
    // 官方端点专属扩展，否则前缀之外的 body 形状也会因端点漂移
    assert!(
        first.body.get("stream_options").is_none(),
        "非官方 OpenAI 端点不应注入 stream_options"
    );
}

#[test]
fn deepseek_responses_instructions_prefix_byte_identical_across_consecutive_requests() {
    let first = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
        "deepseek-v4-flash",
        &request_body(first_turn_messages()),
        "https://api.deepseek.com/v1",
    );
    let second = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
        "deepseek-v4-flash",
        &request_body(second_turn_messages()),
        "https://api.deepseek.com/v1",
    );

    // DeepSeek Responses 无 prompt_cache_breakpoint 字段，靠自动前缀缓存：
    // system 必须留在顶层 instructions 且逐字节稳定（ROUND-02 P2-12 的反向门控）
    assert_segment_byte_identical(
        "DeepSeek Responses instructions",
        &first["instructions"],
        &second["instructions"],
    );
    assert!(
        first["instructions"].as_str().is_some(),
        "instructions 应为顶层字符串"
    );
    assert_eq!(
        first["input"][0]["role"],
        json!("user"),
        "不支持显式断点的模型不应注入 developer 断点块"
    );

    assert_segment_byte_identical(
        "DeepSeek Responses tools",
        &first["tools"],
        &second["tools"],
    );
}

// ============================================================
// 确定性护栏：同一入站 body 重复转换，post-adapter body 全量字节一致
//（preserve_order 前提下的序列化确定性；任何非确定迭代/随机 id 都会在此暴露）
// ============================================================

#[test]
fn reconverting_identical_body_is_fully_byte_deterministic_for_all_three_providers() {
    let body = request_body(first_turn_messages());

    let openai = OpenAIAdapter::new();
    let openai_first = openai
        .build_request("https://api.openai.com/v1", "sk-test", "gpt-4.1", &body)
        .expect("build")
        .body;
    let openai_second = openai
        .build_request("https://api.openai.com/v1", "sk-test", "gpt-4.1", &body)
        .expect("build")
        .body;
    assert_eq!(
        segment_bytes("OpenAI 全量 body", &openai_first),
        segment_bytes("OpenAI 全量 body", &openai_second),
    );

    let anthropic = AnthropicAdapter::new();
    let anthropic_first =
        serde_json::to_value(anthropic.convert_openai_to_anthropic("claude-fable-5", &body))
            .expect("serialize");
    let anthropic_second =
        serde_json::to_value(anthropic.convert_openai_to_anthropic("claude-fable-5", &body))
            .expect("serialize");
    assert_eq!(
        segment_bytes("Anthropic 全量 body", &anthropic_first),
        segment_bytes("Anthropic 全量 body", &anthropic_second),
    );

    let deepseek_first = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
        "deepseek-v4-flash",
        &body,
        "https://api.deepseek.com/v1",
    );
    let deepseek_second = OpenAIResponsesAdapter::convert_to_responses_format_for_endpoint(
        "deepseek-v4-flash",
        &body,
        "https://api.deepseek.com/v1",
    );
    assert_eq!(
        segment_bytes("DeepSeek Responses 全量 body", &deepseek_first),
        segment_bytes("DeepSeek Responses 全量 body", &deepseek_second),
    );
}
