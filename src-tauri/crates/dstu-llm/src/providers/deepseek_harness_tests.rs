//! Final-wire regressions for the DeepSeek Harness / V4.1 API audit (2026-09-12).
use super::*;
use crate::llm_manager::{
    model2_pipeline::apply_generation_params, provider_quirks::resolve_quirks, ApiConfig,
    LLMManager,
};

const ENDPOINT: &str = "https://api.deepseek.com/v1";

#[tokio::test]
async fn deepseek_harness_http_stream_consumes_trailing_usage_before_failure() {
    use futures_util::StreamExt;
    // Exercise HTTP and the production SSE buffer with an isolated local endpoint.
    let mut server = mockito::Server::new_async().await;
    let fixture = server.mock("POST", "/v1/chat/completions")
        .match_body(mockito::Matcher::PartialJson(json!({"model": "deepseek-flash", "stream": true})))
        .with_header("content-type", "text/event-stream")
        .with_body(concat!(
            "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"length\"}]}\n\n",
            "data: {\"choices\":[],\"usage\":{\"prompt_tokens\":100,\"completion_tokens\":20,\"prompt_cache_hit_tokens\":80}}\n\n",
            "data: [DONE]\n\n"
        )).create_async().await;
    let adapter = OpenAIAdapter::new();
    let wire = adapter
        .build_request(
            ENDPOINT,
            "",
            "deepseek-flash",
            &json!({
                "model": "deepseek-flash", "stream": true,
                "messages": [{"role": "user", "content": "Explain"}]
            }),
        )
        .unwrap();
    let mut stream = reqwest::Client::builder()
        .no_proxy()
        .build()
        .unwrap()
        .post(format!("{}/v1/chat/completions", server.url()))
        .json(&wire.body)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .bytes_stream();
    let mut buffer = crate::utils::sse_buffer::SseEventBuffer::new();
    let mut events = Vec::new();
    'stream: while let Some(chunk) = stream.next().await {
        for block in buffer.process_bytes(&chunk.unwrap()) {
            let parsed = adapter.parse_stream(&block);
            let terminal = parsed
                .iter()
                .any(|event| matches!(event, StreamEvent::Done | StreamEvent::SafetyBlocked(_)));
            events.extend(parsed);
            if terminal {
                break 'stream;
            }
        }
    }
    assert!(matches!(&events[0], StreamEvent::ContentChunk(text) if text == "partial"));
    assert!(
        matches!(&events[1], StreamEvent::Usage(usage) if usage["prompt_cache_hit_tokens"] == 80)
    );
    assert!(matches!(&events[2], StreamEvent::SafetyBlocked(info) if info["reason"] == "length"));
    assert_eq!(events.len(), 3);
    fixture.assert_async().await;
}

#[test]
fn deepseek_harness_failure_at_eof_and_request_reuse_are_isolated() {
    let adapter = OpenAIAdapter::new();
    for endpoint in [ENDPOINT, "https://api.openai.com/v1", ENDPOINT] {
        adapter
            .build_request(endpoint, "", "deepseek-flash", &json!({}))
            .unwrap();
        adapter.parse_stream(r#"data: {"choices":[{"delta":{},"finish_reason":"length"}]}"#);
        let terminal = adapter.finish_stream();
        if endpoint == ENDPOINT {
            assert!(
                matches!(terminal.as_slice(), [StreamEvent::SafetyBlocked(info)] if info["reason"] == "length")
            );
        } else {
            assert!(matches!(terminal.as_slice(), [StreamEvent::Done]));
        }
        assert!(adapter.finish_stream().is_empty());
    }
}

#[test]
fn deepseek_harness_request_modes_survive_both_transports() {
    for (enabled, effort, expected_effort) in [
        (true, "low", "low"),
        (true, "xhigh", "high"),
        (true, "max", "max"),
        (false, "max", "none"),
    ] {
        let config = ApiConfig {
            model: "deepseek-flash".into(),
            model_adapter: "deepseek".into(),
            provider_type: Some("deepseek".into()),
            base_url: ENDPOINT.into(),
            supports_reasoning: true,
            is_reasoning: true,
            enable_thinking: Some(enabled),
            reasoning_effort: Some(effort.into()),
            top_p_override: Some(0.97),
            max_output_tokens: 1024,
            temperature: 0.7,
            ..Default::default()
        };
        let mut body = json!({
            "messages": [{"role": "user", "content": "Explain the chart."}],
            "tools": [{"type": "function", "function": {"name": "read_chart", "parameters": {"type": "object", "properties": {}}}}],
            "stream": true,
            "frequency_penalty": 0.5
        });
        LLMManager::apply_reasoning_config(&mut body, &config, Some(enabled));
        apply_generation_params(&mut body, &config, &resolve_quirks(&config));
        let chat = OpenAIAdapter::new()
            .build_request(ENDPOINT, "", &config.model, &body)
            .unwrap()
            .body;
        let responses = OpenAIResponsesAdapter::new()
            .build_request(ENDPOINT, "", &config.model, &body)
            .unwrap()
            .body;
        assert_eq!(
            chat["max_tokens"],
            json!(1024),
            "explicit budgets also apply at max effort"
        );
        assert!(chat.get("max_completion_tokens").is_none());
        assert_eq!(responses["max_output_tokens"], json!(1024));
        assert_eq!(responses["reasoning"]["effort"], json!(expected_effort));
        assert!(responses.get("thinking").is_none());
        for wire in [&chat, &responses] {
            assert!(wire.get("frequency_penalty").is_none());
            if enabled {
                assert!((wire["top_p"].as_f64().unwrap() - 0.97).abs() < 0.00001);
                assert!(wire.get("temperature").is_none());
            } else {
                assert!(wire.get("top_p").is_none());
                assert!(wire.get("temperature").is_some());
            }
        }
    }
}

#[test]
fn deepseek_harness_responses_replays_chat_cot_without_duplicating_native_items() {
    let native = json!({"type": "reasoning", "id": "reason-2", "content": [{"type": "reasoning_text", "text": "second thought"}]});
    let body = json!({"messages": [
        {"role": "user", "content": "Read the note"},
        {"role": "assistant", "content": "", "reasoning_content": "first thought",
         "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "read_note", "arguments": "{}"}}]},
        {"role": "tool", "tool_call_id": "call-1", "content": "note content"},
        {"role": "assistant", "content": "answer", "reasoning_content": "second thought", "response_reasoning_item": native},
        {"role": "user", "content": "Explain more"}
    ]});
    let result = OpenAIResponsesAdapter::new()
        .build_request(ENDPOINT, "", "deepseek-flash", &body)
        .unwrap()
        .body;
    let input = result["input"].as_array().unwrap();
    let reasoning: Vec<_> = input.iter().filter(|v| v["type"] == "reasoning").collect();
    assert_eq!(reasoning.len(), 2);
    assert_eq!(reasoning[0]["content"][0]["text"], "first thought");
    assert_eq!(reasoning[1], &native);
    let call = input
        .iter()
        .position(|v| v["type"] == "function_call")
        .unwrap();
    assert!(input[..call].iter().any(|v| v["type"] == "reasoning"));

    let openai = OpenAIResponsesAdapter::new()
        .build_request("https://api.openai.com/v1", "", "gpt-5", &body)
        .unwrap()
        .body;
    assert_eq!(
        openai["input"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|v| v["type"] == "reasoning")
            .count(),
        1
    );
}

#[test]
fn deepseek_harness_system_update_keeps_history_position() {
    let body = json!({"messages": [
        {"role": "system", "content": "original instructions"},
        {"role": "user", "content": "question"},
        {"role": "assistant", "content": "answer"},
        {"role": "system", "content": "replacement instructions"},
        {"role": "user", "content": "follow up"}
    ]});
    let result = OpenAIResponsesAdapter::new()
        .build_request(ENDPOINT, "", "deepseek-flash", &body)
        .unwrap()
        .body;
    assert_eq!(result["instructions"], "original instructions");
    assert_eq!(result["input"][2]["role"], "system");
    assert_eq!(
        result["input"][2]["content"][0]["text"],
        "replacement instructions"
    );
}

#[test]
fn deepseek_harness_failed_finish_is_not_successful_partial_output() {
    for reason in [
        "length",
        "content_filter",
        "insufficient_system_resource",
        "aborted",
    ] {
        let adapter = OpenAIAdapter::new();
        adapter
            .build_request(ENDPOINT, "", "deepseek-flash", &json!({}))
            .unwrap();
        let events = adapter.parse_stream(&format!("data: {}", json!({
            "choices": [{"delta": {"content": "partial answer"}, "finish_reason": reason}],
            "usage": {"prompt_tokens": 100, "completion_tokens": 20, "prompt_cache_hit_tokens": 80}
        })));
        assert!(!events
            .iter()
            .any(|event| matches!(event, StreamEvent::SafetyBlocked(_) | StreamEvent::Done)));
        assert!(events
            .iter()
            .any(|event| matches!(event, StreamEvent::Usage(_))));
        let terminal = adapter.parse_stream("data: [DONE]");
        assert!(
            matches!(terminal.as_slice(), [StreamEvent::SafetyBlocked(info)] if info["reason"] == reason)
        );
        assert!(adapter.finish_stream().is_empty());
    }
    let adapter = OpenAIAdapter::new();
    let events =
        adapter.parse_stream(r#"data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}"#);
    assert!(!events
        .iter()
        .any(|event| matches!(event, StreamEvent::SafetyBlocked(_))));
}

#[test]
fn deepseek_harness_nonofficial_transports_keep_existing_behavior() {
    for endpoint in [
        "https://api.openai.com/v1",
        "https://openrouter.ai/api/v1",
        "https://api.siliconflow.cn/v1",
        "https://proxy.example/v1",
        "https://api.deepseek.com.proxy.example/v1",
    ] {
        let body = json!({"messages":[{"role":"system","content":"first"},{"role":"user","content":"question"},{"role":"assistant","content":"answer","reasoning_content":"thought"},{"role":"system","content":"second"}],"top_p":0.7,"thinking":{"type":"disabled"}});
        let adapter = OpenAIAdapter::new();
        let chat = adapter
            .build_request(endpoint, "", "deepseek-flash", &body)
            .unwrap()
            .body;
        assert_eq!(chat["top_p"], json!(0.7), "{endpoint}");
        let response = OpenAIResponsesAdapter::new()
            .build_request(endpoint, "", "deepseek-flash", &body)
            .unwrap()
            .body;
        assert!(response.get("top_p").is_none(), "{endpoint}");
        assert!(!response["input"]
            .as_array()
            .unwrap()
            .iter()
            .any(|item| item["type"] == "reasoning"));
        for reason in ["length", "content_filter", "provider_custom_stop"] {
            let events = adapter.parse_stream(&format!(
                "data: {}",
                json!({"choices":[{"delta":{},"finish_reason":reason}]})
            ));
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, StreamEvent::SafetyBlocked(_))),
                "{endpoint}: {reason}"
            );
            assert!(matches!(
                adapter.finish_stream().as_slice(),
                [StreamEvent::Done]
            ));
        }
    }
}

#[test]
fn deepseek_harness_hosted_xhigh_keeps_legacy_max_mapping() {
    for (endpoint, provider) in [
        ("https://api.siliconflow.cn/v1", "siliconflow"),
        ("https://proxy.example/v1", "deepseek"),
    ] {
        let config = ApiConfig {
            base_url: endpoint.into(),
            provider_type: Some(provider.into()),
            model: "deepseek-v4-flash".into(),
            model_adapter: "deepseek".into(),
            supports_reasoning: true,
            enable_thinking: Some(true),
            reasoning_effort: Some("xhigh".into()),
            ..Default::default()
        };
        let mut body = json!({});
        LLMManager::apply_reasoning_config(&mut body, &config, Some(true));
        assert_eq!(body["reasoning_effort"], "max", "{endpoint}");
        assert!(
            !crate::llm_manager::adapters::apply_official_deepseek_generation_params(
                &mut body, &config
            )
        );
    }
}

// ============================================================================
// 统一五档映射的端到端验证（2026-10-03，方案 F）
//
// 单元测试验证映射函数本身；这里验证**真实请求路径**：
//   config → LLMManager::apply_reasoning_config → ProviderAdapter::build_request
// 即断言最终发到线上的 body，确保映射没有被后续环节覆盖或绕过。
// ============================================================================

#[test]
fn unified_five_levels_reach_the_wire_for_official_openai() {
    // 官方 OpenAI + Chat Completions：gpt-6 的 max 必须被吸附为 xhigh，
    // 因为 Chat Completions 路径发 max 会返回 400。
    let config = ApiConfig {
        model: "gpt-6-sol".into(),
        model_adapter: "openai".into(),
        provider_type: Some("openai".into()),
        base_url: "https://api.openai.com/v1".into(),
        api_protocol: Some("openai_chat_completions".into()),
        supports_reasoning: true,
        is_reasoning: true,
        enable_thinking: Some(true),
        reasoning_effort: Some("max".into()),
        ..Default::default()
    };
    let mut body = json!({"messages": [{"role": "user", "content": "hi"}], "stream": true});
    LLMManager::apply_reasoning_config(&mut body, &config, Some(true));

    let wire = OpenAIAdapter::new()
        .build_request(&config.base_url, "", &config.model, &body)
        .unwrap()
        .body;

    assert_eq!(
        wire["reasoning_effort"], "xhigh",
        "Chat Completions 路径的 max 必须吸附为 xhigh；实际 body={wire}"
    );
}

#[test]
fn unified_five_levels_reach_the_wire_for_official_gpt6_responses() {
    // 官方 OpenAI + Responses：max 是合法档，必须原样透传（不吸附）。
    let config = ApiConfig {
        model: "gpt-6-sol".into(),
        model_adapter: "openai".into(),
        provider_type: Some("openai".into()),
        base_url: "https://api.openai.com/v1".into(),
        api_protocol: Some("openai_responses".into()),
        supports_openai_responses: Some(true),
        supports_reasoning: true,
        is_reasoning: true,
        enable_thinking: Some(true),
        reasoning_effort: Some("max".into()),
        ..Default::default()
    };
    let mut body = json!({"messages": [{"role": "user", "content": "hi"}], "stream": true});
    LLMManager::apply_reasoning_config(&mut body, &config, Some(true));

    let wire = OpenAIResponsesAdapter::new()
        .build_request(&config.base_url, "", &config.model, &body)
        .unwrap()
        .body;

    assert_eq!(
        wire["reasoning"]["effort"], "max",
        "Responses 路径必须保留 max；实际 body={wire}"
    );
}

#[test]
fn unified_five_levels_reach_the_wire_for_relay_passthrough() {
    // 中转渠道：五档原样透传，不做任何裁剪（中转站自行完成上游映射）。
    for level in ["low", "medium", "high", "xhigh", "max"] {
        let config = ApiConfig {
            model: format!("some-relay-gpt-6-sol-{level}"),
            model_adapter: "general".into(),
            provider_type: Some("custom".into()),
            provider_scope: Some("custom".into()),
            base_url: "https://relay.example.com/v1".into(),
            api_protocol: Some("openai_chat_completions".into()),
            supports_reasoning: true,
            is_reasoning: true,
            enable_thinking: Some(true),
            reasoning_effort: Some(level.into()),
            ..Default::default()
        };
        let mut body = json!({"messages": [{"role": "user", "content": "hi"}], "stream": true});
        LLMManager::apply_reasoning_config(&mut body, &config, Some(true));

        let wire = OpenAIAdapter::new()
            .build_request(&config.base_url, "", &config.model, &body)
            .unwrap()
            .body;

        assert_eq!(
            wire["reasoning_effort"], level,
            "中转渠道必须原样透传 {level}；实际 body={wire}"
        );
    }
}

#[test]
fn unified_five_levels_reach_the_wire_for_official_deepseek() {
    // 官方 DeepSeek：xhigh 按官方映射表落到 high（而非就近吸附到 max）。
    let config = ApiConfig {
        model: "deepseek-v4-pro".into(),
        model_adapter: "deepseek".into(),
        provider_type: Some("deepseek".into()),
        base_url: ENDPOINT.into(),
        supports_reasoning: true,
        is_reasoning: true,
        enable_thinking: Some(true),
        reasoning_effort: Some("xhigh".into()),
        ..Default::default()
    };
    let mut body = json!({"messages": [{"role": "user", "content": "hi"}], "stream": true});
    LLMManager::apply_reasoning_config(&mut body, &config, Some(true));

    assert_eq!(
        body["reasoning_effort"], "high",
        "官方 DeepSeek 的 xhigh 必须按官方表落到 high；实际 body={body}"
    );
}

#[test]
fn unified_five_levels_reach_the_wire_for_glm53_and_kimi_k3() {
    // GLM-5.3 与 Kimi K3：官方仅 low/high/max。
    // medium → high（就近吸附），且不可关闭。
    for (adapter, model, endpoint) in [
        ("zhipu", "glm-5.3", "https://open.bigmodel.cn/api/paas/v4"),
        ("moonshot", "kimi-k3", "https://api.moonshot.cn/v1"),
    ] {
        let config = ApiConfig {
            model: model.into(),
            model_adapter: adapter.into(),
            provider_type: Some(adapter.into()),
            base_url: endpoint.into(),
            supports_reasoning: true,
            is_reasoning: true,
            enable_thinking: Some(true),
            reasoning_effort: Some("medium".into()),
            ..Default::default()
        };
        let mut body = json!({"messages": [{"role": "user", "content": "hi"}], "stream": true});
        LLMManager::apply_reasoning_config(&mut body, &config, Some(true));

        assert_eq!(
            body["reasoning_effort"], "high",
            "{model} 的 medium 必须映射为 high；实际 body={body}"
        );
    }
}

#[test]
fn unified_five_levels_reach_the_wire_for_gemini_low() {
    // Gemini 3 Pro：low 是合法档，不得被静默升到 high（本次修复的 bug）。
    let config = ApiConfig {
        model: "gemini-3.1-pro-preview".into(),
        model_adapter: "google".into(),
        provider_type: Some("google".into()),
        base_url: "https://generativelanguage.googleapis.com".into(),
        supports_reasoning: true,
        is_reasoning: true,
        enable_thinking: Some(true),
        reasoning_effort: Some("low".into()),
        ..Default::default()
    };
    let mut body = json!({"messages": [{"role": "user", "content": "hi"}], "stream": true});
    LLMManager::apply_reasoning_config(&mut body, &config, Some(true));

    assert_eq!(
        body["thinkingConfig"]["thinkingLevel"], "low",
        "Gemini 3 Pro 的 low 必须保留为 low；实际 body={body}"
    );
}
