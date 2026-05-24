//! 流式格式回归测试夹具（M-06 Audit 6）
//!
//! 这个模块为所有 12 个 `RequestAdapter` 实现提供统一的 SSE 解析回归测试。
//! 它的作用 **不是** 测试 `RequestAdapter::apply_reasoning_config`（每个适配器
//! 有自己的针对性单测），而是验证：每个供应商发回的真实流式 chunk 在
//! 路由到对应的 `ProviderAdapter`（解析层）后，能稳定产出预期事件。
//!
//! ## 路由表
//! `RequestAdapter::id()` -> `ProviderAdapter` 解析器:
//! - `"anthropic"` -> `AnthropicAdapter`
//! - `"google"` / `"gemini"` -> `GeminiAdapter`
//! - 其余 10 个 (`general`, `deepseek`, `doubao`, `ernie`, `grok`, `minimax`,
//!   `mistral`, `moonshot`, `qwen`, `zhipu`) -> `OpenAIAdapter`（OpenAI 兼容协议）
//!
//! 路由规则与 `llm_manager::mod` 中 `match config.model_adapter.as_str()` 的
//! 分支语义保持一致。
//!
//! ## 夹具来源
//! 每个夹具都基于供应商官方文档的 SSE 示例，必要时做了最小化裁剪
//! （只保留触发关键路径所需的 chunk）。
//!
//! ## 谨慎事项
//! - 这些测试 **只验证解析层**，不发起任何 HTTP。
//! - 如发现真实 bug，可以使用 `#[ignore = "..."]` 标注，并在审计报告中跟进，
//!   但目前所有 24 个测试都应通过。

#![cfg(test)]

use crate::llm_manager::adapters::{
    AnthropicAdapter as AnthropicReqAdapter, DeepSeekAdapter, DoubaoAdapter, ErnieAdapter,
    GeminiAdapter as GeminiReqAdapter, GenericOpenAIAdapter, GrokAdapter, MiniMaxAdapter,
    MistralAdapter, MoonshotAdapter, QwenAdapter, RequestAdapter, ZhipuAdapter,
};
use crate::providers::{
    AnthropicAdapter as AnthropicParser, GeminiAdapter as GeminiParser, OpenAIAdapter,
    ProviderAdapter, StreamEvent,
};

// ============================================================
// 路由层：把 RequestAdapter::id() 映射到对应的 ProviderAdapter 解析器
// ============================================================

/// 根据请求适配器的 id 选择对应的流式解析器。
///
/// 该函数与 `llm_manager` 主路径 (`model2_pipeline.rs` 中
/// `match config.model_adapter.as_str()`) 的路由规则保持一致：
/// `"google" | "gemini"` 走 Gemini，`"anthropic" | "claude"` 走 Anthropic，
/// 其余统一走 OpenAI 兼容协议。
fn parser_for(adapter: &dyn RequestAdapter) -> Box<dyn ProviderAdapter> {
    match adapter.id() {
        "anthropic" | "claude" => Box::new(AnthropicParser::new()),
        "google" | "gemini" => Box::new(GeminiParser::new()),
        _ => Box::new(OpenAIAdapter),
    }
}

// ============================================================
// 通用断言工具
// ============================================================

/// 把整段 SSE fixture 按行切给解析器，收集所有事件。
fn drive_parser(parser: &dyn ProviderAdapter, fixture: &str) -> Vec<StreamEvent> {
    let mut events = Vec::new();
    for line in fixture.lines() {
        // 真实 SSE 中可能有 `event: xxx` 行，OpenAI/Anthropic 解析器
        // 已经只看 `data: ` 开头的行，其它会被忽略，安全起见全部喂入。
        events.extend(parser.parse_stream(line));
    }
    events
}

/// 收集所有 `ContentChunk` 文本片段，拼接成完整字符串
fn collect_content(events: &[StreamEvent]) -> String {
    events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::ContentChunk(s) => Some(s.as_str()),
            _ => None,
        })
        .collect::<String>()
}

/// 收集所有 `ToolCall` 事件
fn collect_tool_calls(events: &[StreamEvent]) -> Vec<&serde_json::Value> {
    events
        .iter()
        .filter_map(|e| match e {
            StreamEvent::ToolCall(v) => Some(v),
            _ => None,
        })
        .collect()
}

/// 文本流断言：把 `ContentChunk` 拼起来等于 `expected`
fn assert_streaming_text<A: RequestAdapter>(adapter: A, fixture: &str, expected: &str) {
    let parser = parser_for(&adapter);
    let events = drive_parser(parser.as_ref(), fixture);
    let combined = collect_content(&events);
    assert_eq!(
        combined,
        expected,
        "[{}] streaming text mismatch.\n  parsed events = {:#?}",
        adapter.id(),
        events
    );
}

/// 工具调用流断言：解析后至少存在一次工具调用，且函数名 & 参数符合预期
///
/// `expected_args_json`: 期望的参数 JSON（去除空白后比较）
fn assert_streaming_tool_call<A: RequestAdapter>(
    adapter: A,
    fixture: &str,
    expected_name: &str,
    expected_args_json: serde_json::Value,
) {
    let parser = parser_for(&adapter);
    let events = drive_parser(parser.as_ref(), fixture);
    let calls = collect_tool_calls(&events);
    assert!(
        !calls.is_empty(),
        "[{}] expected at least one tool_call, got events = {:#?}",
        adapter.id(),
        events
    );

    // 重建完整工具调用：name 取第一次非空 name，arguments 拼接所有 deltas
    let mut name = String::new();
    let mut args_buffer = String::new();
    let mut id = String::new();
    for tc in &calls {
        // 兼容两种结构：
        //  - OpenAI delta: {"index":0,"id":"...","function":{"name":"...","arguments":"..."}}
        //  - Anthropic/Gemini 完整版: 同 OpenAI 但 arguments 是完整 JSON 字符串
        if name.is_empty() {
            if let Some(n) = tc
                .get("function")
                .and_then(|f| f.get("name"))
                .and_then(|v| v.as_str())
            {
                if !n.is_empty() {
                    name = n.to_string();
                }
            }
        }
        if id.is_empty() {
            if let Some(i) = tc.get("id").and_then(|v| v.as_str()) {
                if !i.is_empty() {
                    id = i.to_string();
                }
            }
        }
        if let Some(args) = tc
            .get("function")
            .and_then(|f| f.get("arguments"))
            .and_then(|v| v.as_str())
        {
            args_buffer.push_str(args);
        }
    }

    assert_eq!(
        name,
        expected_name,
        "[{}] tool name mismatch. raw calls = {:#?}",
        adapter.id(),
        calls
    );

    // arguments 可能被分成多片增量（OpenAI 风格）或完整 JSON（Anthropic/Gemini）
    let parsed_args: serde_json::Value =
        serde_json::from_str(args_buffer.trim()).unwrap_or_else(|_| {
            panic!(
                "[{}] arguments not valid JSON: {:?}",
                adapter.id(),
                args_buffer
            )
        });

    assert_eq!(
        parsed_args,
        expected_args_json,
        "[{}] tool arguments mismatch. raw calls = {:#?}",
        adapter.id(),
        calls
    );
}

// ============================================================
// 共享 fixture：OpenAI 兼容格式
// ============================================================
//
// 10 个适配器（除 Anthropic/Gemini）都消费 OpenAI 兼容协议，但每家
// 在细节上略有差异（reasoning_content / 多余字段 / [DONE] 行）。
// 下面的 fixture 都来自各家官方 SSE 文档示例的最小化版本。

/// 通用 OpenAI 文本流（vanilla chat.completion.chunk）
const OPENAI_TEXT_FIXTURE: &str = "\
data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"role\":\"assistant\"},\"index\":0}]}
data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"Hello\"},\"index\":0}]}
data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\", \"},\"index\":0}]}
data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{\"content\":\"world\"},\"index\":0}]}
data: {\"id\":\"chatcmpl-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"delta\":{},\"index\":0,\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":3,\"total_tokens\":8}}
data: [DONE]
";

/// 通用 OpenAI 工具调用流（拆成 name + 多片 arguments delta）
const OPENAI_TOOL_FIXTURE: &str = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_abc\",\"type\":\"function\",\"function\":{\"name\":\"get_weather\",\"arguments\":\"\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"city\\\":\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"\\\"Paris\\\"}\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}
data: [DONE]
";

// ============================================================
// 适配器 1: GenericOpenAI (vanilla OpenAI 兼容)
// ============================================================

#[test]
fn streaming_text_generic_openai() {
    assert_streaming_text(GenericOpenAIAdapter, OPENAI_TEXT_FIXTURE, "Hello, world");
}

#[test]
fn streaming_tool_call_generic_openai() {
    assert_streaming_tool_call(
        GenericOpenAIAdapter,
        OPENAI_TOOL_FIXTURE,
        "get_weather",
        serde_json::json!({"city": "Paris"}),
    );
}

// ============================================================
// 适配器 2: DeepSeek（OpenAI 兼容 + reasoning_content）
// 文档: https://api-docs.deepseek.com/api/create-chat-completion
// ============================================================

const DEEPSEEK_TEXT_FIXTURE: &str = "\
data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"思考中...\"}}]}
data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"答案是 \"}}]}
data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"42\"}}]}
data: {\"id\":\"x\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4,\"total_tokens\":14}}
data: [DONE]
";

const DEEPSEEK_TOOL_FIXTURE: &str = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_1\",\"type\":\"function\",\"function\":{\"name\":\"search\",\"arguments\":\"\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"q\\\":\\\"deepseek\\\"}\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}
data: [DONE]
";

#[test]
fn streaming_text_deepseek() {
    assert_streaming_text(DeepSeekAdapter, DEEPSEEK_TEXT_FIXTURE, "答案是 42");
}

#[test]
fn streaming_tool_call_deepseek() {
    assert_streaming_tool_call(
        DeepSeekAdapter,
        DEEPSEEK_TOOL_FIXTURE,
        "search",
        serde_json::json!({"q": "deepseek"}),
    );
}

// ============================================================
// 适配器 3: Doubao (火山方舟 ARK)
// 文档: https://www.volcengine.com/docs/82379/1099475
// ============================================================

const DOUBAO_TEXT_FIXTURE: &str = "\
data: {\"id\":\"021\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"model\":\"doubao-seed-1-6\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"\"}}]}
data: {\"id\":\"021\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"豆\"}}]}
data: {\"id\":\"021\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"包\"}}]}
data: {\"id\":\"021\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"你好\"}}]}
data: {\"id\":\"021\",\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":3,\"total_tokens\":6}}
data: [DONE]
";

const DOUBAO_TOOL_FIXTURE: &str = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_doubao_1\",\"type\":\"function\",\"function\":{\"name\":\"book_flight\",\"arguments\":\"\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"city\\\":\\\"Shanghai\\\"}\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}
data: [DONE]
";

#[test]
fn streaming_text_doubao() {
    assert_streaming_text(DoubaoAdapter, DOUBAO_TEXT_FIXTURE, "豆包你好");
}

#[test]
fn streaming_tool_call_doubao() {
    assert_streaming_tool_call(
        DoubaoAdapter,
        DOUBAO_TOOL_FIXTURE,
        "book_flight",
        serde_json::json!({"city": "Shanghai"}),
    );
}

// ============================================================
// 适配器 4: Ernie (百度千帆 v2，OpenAI 兼容)
// 文档: https://cloud.baidu.com/doc/qianfan-api/s/Wm9cuofb1
// ============================================================

const ERNIE_TEXT_FIXTURE: &str = "\
data: {\"id\":\"as-1\",\"object\":\"chat.completion.chunk\",\"created\":1700000000,\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"文心\"},\"flag\":0}]}
data: {\"id\":\"as-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"一言\"}}]}
data: {\"id\":\"as-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"，您好\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":3,\"total_tokens\":7}}
data: [DONE]
";

const ERNIE_TOOL_FIXTURE: &str = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_ernie_1\",\"type\":\"function\",\"function\":{\"name\":\"check_balance\",\"arguments\":\"\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"user_id\\\":12345}\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}
data: [DONE]
";

#[test]
fn streaming_text_ernie() {
    assert_streaming_text(ErnieAdapter, ERNIE_TEXT_FIXTURE, "文心一言，您好");
}

#[test]
fn streaming_tool_call_ernie() {
    assert_streaming_tool_call(
        ErnieAdapter,
        ERNIE_TOOL_FIXTURE,
        "check_balance",
        serde_json::json!({"user_id": 12345}),
    );
}

// ============================================================
// 适配器 5: Grok (xAI, OpenAI 兼容)
// 文档: https://docs.x.ai/docs/api-reference#chat-completions
// ============================================================

const GROK_TEXT_FIXTURE: &str = "\
data: {\"id\":\"grok-1\",\"object\":\"chat.completion.chunk\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Grok\"}}]}
data: {\"id\":\"grok-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" here\"}}]}
data: {\"id\":\"grok-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"!\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2,\"total_tokens\":5}}
data: [DONE]
";

const GROK_TOOL_FIXTURE: &str = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_grok_1\",\"type\":\"function\",\"function\":{\"name\":\"web_search\",\"arguments\":\"\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"query\\\":\\\"xai news\\\"}\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}
data: [DONE]
";

#[test]
fn streaming_text_grok() {
    assert_streaming_text(GrokAdapter, GROK_TEXT_FIXTURE, "Grok here!");
}

#[test]
fn streaming_tool_call_grok() {
    assert_streaming_tool_call(
        GrokAdapter,
        GROK_TOOL_FIXTURE,
        "web_search",
        serde_json::json!({"query": "xai news"}),
    );
}

// ============================================================
// 适配器 6: MiniMax (M1, abab, MiniMax-Reasoner)
// 文档: https://platform.minimaxi.com/document/ChatCompletion
// ============================================================

const MINIMAX_TEXT_FIXTURE: &str = "\
data: {\"id\":\"mm-1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"海螺\"}}]}
data: {\"id\":\"mm-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"AI\"}}]}
data: {\"id\":\"mm-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"问候\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":3,\"total_tokens\":6}}
data: [DONE]
";

const MINIMAX_TOOL_FIXTURE: &str = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_mm_1\",\"type\":\"function\",\"function\":{\"name\":\"translate\",\"arguments\":\"\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"text\\\":\\\"hi\\\"}\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}
data: [DONE]
";

#[test]
fn streaming_text_minimax() {
    assert_streaming_text(MiniMaxAdapter, MINIMAX_TEXT_FIXTURE, "海螺AI问候");
}

#[test]
fn streaming_tool_call_minimax() {
    assert_streaming_tool_call(
        MiniMaxAdapter,
        MINIMAX_TOOL_FIXTURE,
        "translate",
        serde_json::json!({"text": "hi"}),
    );
}

// ============================================================
// 适配器 7: Mistral (la plateforme, OpenAI 兼容)
// 文档: https://docs.mistral.ai/api/#tag/chat
// ============================================================

const MISTRAL_TEXT_FIXTURE: &str = "\
data: {\"id\":\"mst-1\",\"object\":\"chat.completion.chunk\",\"model\":\"mistral-large-latest\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Bon\"}}]}
data: {\"id\":\"mst-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"jour\"}}]}
data: {\"id\":\"mst-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"!\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":2,\"total_tokens\":4}}
data: [DONE]
";

const MISTRAL_TOOL_FIXTURE: &str = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_mst_1\",\"type\":\"function\",\"function\":{\"name\":\"order_baguette\",\"arguments\":\"\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"qty\\\":2}\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}
data: [DONE]
";

#[test]
fn streaming_text_mistral() {
    assert_streaming_text(MistralAdapter, MISTRAL_TEXT_FIXTURE, "Bonjour!");
}

#[test]
fn streaming_tool_call_mistral() {
    assert_streaming_tool_call(
        MistralAdapter,
        MISTRAL_TOOL_FIXTURE,
        "order_baguette",
        serde_json::json!({"qty": 2}),
    );
}

// ============================================================
// 适配器 8: Moonshot (Kimi, OpenAI 兼容)
// 文档: https://platform.moonshot.cn/docs/api/chat
// ============================================================

const MOONSHOT_TEXT_FIXTURE: &str = "\
data: {\"id\":\"cmpl-kimi\",\"object\":\"chat.completion.chunk\",\"model\":\"kimi-k2\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"Kimi\"}}]}
data: {\"id\":\"cmpl-kimi\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\" 上线\"}}]}
data: {\"id\":\"cmpl-kimi\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"。\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":3,\"total_tokens\":7}}
data: [DONE]
";

const MOONSHOT_TOOL_FIXTURE: &str = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_kimi_1\",\"type\":\"function\",\"function\":{\"name\":\"summarize\",\"arguments\":\"\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"doc_id\\\":\\\"abc\\\"}\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}
data: [DONE]
";

#[test]
fn streaming_text_moonshot() {
    assert_streaming_text(MoonshotAdapter, MOONSHOT_TEXT_FIXTURE, "Kimi 上线。");
}

#[test]
fn streaming_tool_call_moonshot() {
    assert_streaming_tool_call(
        MoonshotAdapter,
        MOONSHOT_TOOL_FIXTURE,
        "summarize",
        serde_json::json!({"doc_id": "abc"}),
    );
}

// ============================================================
// 适配器 9: Qwen (DashScope OpenAI 兼容入口)
// 文档: https://help.aliyun.com/zh/dashscope/developer-reference/api-details
// ============================================================

const QWEN_TEXT_FIXTURE: &str = "\
data: {\"id\":\"qw-1\",\"object\":\"chat.completion.chunk\",\"model\":\"qwen-max\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"通义\"}}]}
data: {\"id\":\"qw-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"千问\"}}]}
data: {\"id\":\"qw-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"在此\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":3,\"total_tokens\":6}}
data: [DONE]
";

const QWEN_TOOL_FIXTURE: &str = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_qwen_1\",\"type\":\"function\",\"function\":{\"name\":\"calc\",\"arguments\":\"\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"expr\\\":\\\"1+1\\\"}\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}
data: [DONE]
";

#[test]
fn streaming_text_qwen() {
    assert_streaming_text(QwenAdapter, QWEN_TEXT_FIXTURE, "通义千问在此");
}

#[test]
fn streaming_tool_call_qwen() {
    assert_streaming_tool_call(
        QwenAdapter,
        QWEN_TOOL_FIXTURE,
        "calc",
        serde_json::json!({"expr": "1+1"}),
    );
}

// ============================================================
// 适配器 10: Zhipu (智谱 GLM, OpenAI 兼容)
// 文档: https://bigmodel.cn/dev/api/normal-model/glm-4
// ============================================================

const ZHIPU_TEXT_FIXTURE: &str = "\
data: {\"id\":\"zp-1\",\"object\":\"chat.completion.chunk\",\"model\":\"glm-4-plus\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"智谱\"}}]}
data: {\"id\":\"zp-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"GLM\"}}]}
data: {\"id\":\"zp-1\",\"choices\":[{\"index\":0,\"delta\":{\"content\":\"已就绪\"},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":2,\"completion_tokens\":3,\"total_tokens\":5}}
data: [DONE]
";

const ZHIPU_TOOL_FIXTURE: &str = "\
data: {\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"tool_calls\":[{\"index\":0,\"id\":\"call_zp_1\",\"type\":\"function\",\"function\":{\"name\":\"web_browser\",\"arguments\":\"\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"url\\\":\\\"https://example.com\\\"}\"}}]}}]}
data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}
data: [DONE]
";

#[test]
fn streaming_text_zhipu() {
    assert_streaming_text(ZhipuAdapter, ZHIPU_TEXT_FIXTURE, "智谱GLM已就绪");
}

#[test]
fn streaming_tool_call_zhipu() {
    assert_streaming_tool_call(
        ZhipuAdapter,
        ZHIPU_TOOL_FIXTURE,
        "web_browser",
        serde_json::json!({"url": "https://example.com"}),
    );
}

// ============================================================
// 适配器 11: Anthropic (Claude Messages SSE)
// 文档: https://docs.anthropic.com/en/api/messages-streaming
// ============================================================

/// Anthropic 文本流：message_start -> content_block_start -> content_block_delta(text_delta)*
/// -> content_block_stop -> message_delta -> message_stop
const ANTHROPIC_TEXT_FIXTURE: &str = "\
event: message_start
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_01\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4\",\"usage\":{\"input_tokens\":10,\"output_tokens\":1}}}

event: content_block_start
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}

event: content_block_delta
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"Hi \"}}

event: content_block_delta
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"there\"}}

event: content_block_delta
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"!\"}}

event: content_block_stop
data: {\"type\":\"content_block_stop\",\"index\":0}

event: message_delta
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"input_tokens\":10,\"output_tokens\":3}}

event: message_stop
data: {\"type\":\"message_stop\"}
";

/// Anthropic 工具调用流：content_block_start(tool_use) -> input_json_delta* -> content_block_stop
const ANTHROPIC_TOOL_FIXTURE: &str = "\
event: message_start
data: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_02\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4\",\"usage\":{\"input_tokens\":12,\"output_tokens\":1}}}

event: content_block_start
data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"tool_use\",\"id\":\"toolu_01\",\"name\":\"get_stock_price\",\"input\":{}}}

event: content_block_delta
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"{\\\"ticker\\\":\"}}

event: content_block_delta
data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"input_json_delta\",\"partial_json\":\"\\\"AAPL\\\"}\"}}

event: content_block_stop
data: {\"type\":\"content_block_stop\",\"index\":0}

event: message_delta
data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"tool_use\"},\"usage\":{\"input_tokens\":12,\"output_tokens\":20}}

event: message_stop
data: {\"type\":\"message_stop\"}
";

#[test]
fn streaming_text_anthropic() {
    assert_streaming_text(AnthropicReqAdapter, ANTHROPIC_TEXT_FIXTURE, "Hi there!");
}

#[test]
fn streaming_tool_call_anthropic() {
    assert_streaming_tool_call(
        AnthropicReqAdapter,
        ANTHROPIC_TOOL_FIXTURE,
        "get_stock_price",
        serde_json::json!({"ticker": "AAPL"}),
    );
}

// ============================================================
// 适配器 12: Gemini (Google Generative AI, candidates.content.parts)
// 文档: https://ai.google.dev/api/generate-content#method:-models.streamgeneratecontent
// ============================================================

const GEMINI_TEXT_FIXTURE: &str = "\
data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"Hello\"}]},\"index\":0}]}
data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\" from \"}]},\"index\":0}]}
data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"text\":\"Gemini\"}]},\"finishReason\":\"STOP\",\"index\":0}],\"usageMetadata\":{\"promptTokenCount\":5,\"candidatesTokenCount\":3,\"totalTokenCount\":8}}
";

/// Gemini 工具调用：functionCall part 在 candidates.content.parts 里一次性下发
/// （Gemini 不像 OpenAI 那样把 arguments 切片）
const GEMINI_TOOL_FIXTURE: &str = "\
data: {\"candidates\":[{\"content\":{\"role\":\"model\",\"parts\":[{\"functionCall\":{\"name\":\"find_movies\",\"args\":{\"location\":\"Mountain View\",\"genre\":\"comedy\"}}}]},\"finishReason\":\"STOP\",\"index\":0}],\"usageMetadata\":{\"promptTokenCount\":15,\"candidatesTokenCount\":12,\"totalTokenCount\":27}}
";

#[test]
fn streaming_text_gemini() {
    assert_streaming_text(GeminiReqAdapter, GEMINI_TEXT_FIXTURE, "Hello from Gemini");
}

#[test]
fn streaming_tool_call_gemini() {
    assert_streaming_tool_call(
        GeminiReqAdapter,
        GEMINI_TOOL_FIXTURE,
        "find_movies",
        serde_json::json!({"location": "Mountain View", "genre": "comedy"}),
    );
}

// ============================================================
// 跨适配器结构性回归
// ============================================================

/// OpenAI 兼容流：完整跑下来必须有 Usage 事件 & Done 事件
#[test]
fn openai_compatible_emits_usage_and_done() {
    let parser = OpenAIAdapter;
    let events = drive_parser(&parser, OPENAI_TEXT_FIXTURE);

    let has_usage = events.iter().any(|e| matches!(e, StreamEvent::Usage(_)));
    let has_done = events.iter().any(|e| matches!(e, StreamEvent::Done));
    assert!(
        has_usage,
        "expected usage event in OpenAI fixture, events = {:#?}",
        events
    );
    assert!(
        has_done,
        "expected [DONE] event in OpenAI fixture, events = {:#?}",
        events
    );
}

/// Anthropic 流：必须收到 message_stop -> Done & message_delta -> Usage
#[test]
fn anthropic_emits_usage_and_done() {
    let parser = AnthropicParser::new();
    let events = drive_parser(&parser, ANTHROPIC_TEXT_FIXTURE);

    let has_usage = events.iter().any(|e| matches!(e, StreamEvent::Usage(_)));
    let has_done = events.iter().any(|e| matches!(e, StreamEvent::Done));
    assert!(
        has_usage,
        "expected usage event in Anthropic fixture, events = {:#?}",
        events
    );
    assert!(
        has_done,
        "expected message_stop -> Done in Anthropic fixture, events = {:#?}",
        events
    );
}

/// Gemini 流：必须从 usageMetadata 解析出 Usage 事件
#[test]
fn gemini_emits_usage() {
    let parser = GeminiParser::new();
    let events = drive_parser(&parser, GEMINI_TEXT_FIXTURE);

    let has_usage = events.iter().any(|e| matches!(e, StreamEvent::Usage(_)));
    assert!(
        has_usage,
        "expected usage event in Gemini fixture, events = {:#?}",
        events
    );
}

/// 错误鲁棒性：非 `data:` 行 / 空数据行 / 损坏 JSON 都应被静默忽略，不能 panic
#[test]
fn parsers_silently_ignore_garbage_lines() {
    let garbage = "\
: heartbeat
event: ping
data:
data: this-is-not-json
data: {\"choices\":[{\"delta\":{\"content\":\"survived\"}}]}
";
    // OpenAI parser
    let openai = OpenAIAdapter;
    let events = drive_parser(&openai, garbage);
    let combined = collect_content(&events);
    assert_eq!(
        combined, "survived",
        "OpenAI parser should recover after garbage"
    );

    // Anthropic parser - garbage should not panic
    let anthropic = AnthropicParser::new();
    let _ = drive_parser(&anthropic, garbage);

    // Gemini parser - garbage should not panic
    let gemini = GeminiParser::new();
    let _ = drive_parser(&gemini, garbage);
}
