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
