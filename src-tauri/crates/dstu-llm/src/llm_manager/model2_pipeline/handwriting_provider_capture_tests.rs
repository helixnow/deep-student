//! Local-wire acceptance tests for handwritten PNG delivery through the production chat pipeline.
//! These exercise legacy `ChatMessage` assembly, the selected provider adapter, and real HTTP
//! serialization to a loopback-only capture server; they never call an external API.
#![cfg(test)]

use crate::llm_manager::{routing, ApiConfig, LLMManager, NoopStreamSink};
use crate::models::{ChatMessage, MultimodalContentPart};
use hyper::service::{make_service_fn, service_fn};
use hyper::{Body, Request, Response};
use serde_json::{json, Value};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};
use tempfile::TempDir;

#[derive(Clone, Copy)]
enum Protocol {
    OpenAiChat,
    OpenAiResponses,
    Anthropic,
}

impl Protocol {
    fn config(self, base_url: String) -> ApiConfig {
        let (api_protocol, provider_type, model_adapter, model) = match self {
            Self::OpenAiChat => (
                "openai_chat_completions",
                "custom",
                "general",
                "gpt-4o-mini",
            ),
            Self::OpenAiResponses => ("openai_responses", "custom", "general", "gpt-5.5"),
            Self::Anthropic => (
                "anthropic_messages",
                "anthropic",
                "anthropic",
                "claude-sonnet-4-5",
            ),
        };
        ApiConfig {
            id: "handwriting-provider-capture-test".to_string(),
            name: "loopback handwriting capture".to_string(),
            provider_type: Some(provider_type.to_string()),
            provider_scope: Some(provider_type.to_string()),
            api_protocol: Some(api_protocol.to_string()),
            supports_openai_responses: (matches!(self, Self::OpenAiResponses)).then_some(true),
            model_adapter: model_adapter.to_string(),
            base_url,
            model: model.to_string(),
            api_key: "local-test-key-only".to_string(),
            is_multimodal: true,
            supports_tools: true,
            enabled: true,
            ..Default::default()
        }
    }
}

fn png_base64() -> String {
    use base64::Engine as _;
    use image::ImageEncoder as _;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(&[255, 0, 0, 255], 1, 1, image::ColorType::Rgba8)
        .expect("encode test PNG");
    base64::engine::general_purpose::STANDARD.encode(png)
}

fn history_with_tools_and_image() -> Vec<ChatMessage> {
    let now = chrono::Utc::now();
    let messages = vec![
        json!({
            "role": "assistant", "content": "",
            "timestamp": now,
            "tool_call": {
                "id": "call_parallel_a", "tool_name": "lookup_alpha",
                "args_json": {"key": "alpha"}
            }
        }),
        json!({
            "role": "assistant", "content": "",
            "timestamp": now,
            "tool_call": {
                "id": "call_parallel_b", "tool_name": "lookup_beta",
                "args_json": {"key": "beta"}
            }
        }),
        json!({
            "role": "tool", "content": "alpha result", "timestamp": now,
            "tool_result": {"call_id": "call_parallel_a", "ok": true, "data_json": {"value": "A"}}
        }),
        json!({
            "role": "tool", "content": "beta result", "timestamp": now,
            "tool_result": {"call_id": "call_parallel_b", "ok": true, "data_json": {"value": "B"}}
        }),
        json!({
            "role": "user", "content": "Read this handwritten note.", "timestamp": now
        }),
    ];
    let mut history: Vec<ChatMessage> = messages
        .into_iter()
        .map(|message| serde_json::from_value(message).expect("valid legacy ChatMessage"))
        .collect();
    history
        .last_mut()
        .expect("final user message")
        .multimodal_content = Some(vec![
        MultimodalContentPart::text("Read this handwritten note."),
        MultimodalContentPart::ImageUrl {
            media_type: "image/png".to_string(),
            base64: png_base64(),
        },
    ]);
    history
}

fn create_test_llm_manager(temp_dir: &TempDir) -> LLMManager {
    use crate::database::Database;
    use crate::file_manager::FileManager;
    let db_path = temp_dir.path().join("handwriting-provider-capture.db");
    let conn = rusqlite::Connection::open(&db_path).expect("open test db");
    conn.execute(
        "CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL
        )",
        [],
    )
    .expect("create settings table");
    let db = Arc::new(Database::new(&db_path).expect("create test database"));
    let file_manager =
        Arc::new(FileManager::new(temp_dir.path().to_path_buf()).expect("create file manager"));
    LLMManager::new(db, file_manager).expect("create llm manager")
}

async fn captured_production_request(protocol: Protocol) -> Value {
    let captured = Arc::new(Mutex::new(None::<Value>));
    let captured_by_server = captured.clone();
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback only");
    listener
        .set_nonblocking(true)
        .expect("nonblocking listener");
    let address = listener.local_addr().expect("listener address");
    let server = hyper::Server::from_tcp(listener)
        .expect("hyper loopback server")
        .serve(make_service_fn(move |_| {
            let captured = captured_by_server.clone();
            async move {
                Ok::<_, Infallible>(service_fn(move |request: Request<Body>| {
                    let captured = captured.clone();
                    async move {
                        let expected_path = match protocol {
                            Protocol::OpenAiChat => "/v1/chat/completions",
                            Protocol::OpenAiResponses => "/v1/responses",
                            Protocol::Anthropic => "/v1/messages",
                        };
                        assert_eq!(request.uri().path(), expected_path);
                        let bytes = hyper::body::to_bytes(request.into_body()).await.unwrap();
                        *captured.lock().unwrap() =
                            Some(serde_json::from_slice(&bytes).expect("valid captured JSON"));
                        let body = match protocol {
                            Protocol::OpenAiChat => concat!(
                                "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"ok\"},\"finish_reason\":null}]}\n\n",
                                "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n",
                                "data: [DONE]\n\n"
                            ),
                            Protocol::OpenAiResponses => concat!(
                                "event: response.output_text.delta\ndata: {\"delta\":\"ok\"}\n\n",
                                "event: response.completed\ndata: {\"response\":{\"output_text\":\"ok\"}}\n\n"
                            ),
                            Protocol::Anthropic => concat!(
                                "event: message_start\ndata: {\"type\":\"message_start\",\"message\":{\"id\":\"msg_local\",\"type\":\"message\",\"role\":\"assistant\",\"content\":[],\"model\":\"claude-sonnet-4-5\",\"stop_reason\":null,\"stop_sequence\":null,\"usage\":{\"input_tokens\":1,\"output_tokens\":0}}}\n\n",
                                "event: content_block_start\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                                "event: content_block_delta\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
                                "event: content_block_stop\ndata: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                                "event: message_delta\ndata: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\",\"stop_sequence\":null},\"usage\":{\"output_tokens\":1}}\n\n",
                                "event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n"
                            ),
                        };
                        Ok::<_, Infallible>(Response::builder()
                            .status(200)
                            .header("content-type", "text/event-stream; charset=utf-8")
                            .body(Body::from(body))
                            .unwrap())
                    }
                }))
            }
        }));
    let server_task = tokio::spawn(async move {
        let _ = server.await;
    });

    let temp_dir = TempDir::new().expect("temp dir");
    let mut manager = create_test_llm_manager(&temp_dir);
    manager.client = reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(std::time::Duration::from_secs(2))
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .expect("bounded proxy-free local HTTP client");
    let config = protocol.config(format!("http://{address}/v1"));
    let history = history_with_tools_and_image();
    let stream_event = format!(
        "provider_handwriting_{}",
        match protocol {
            Protocol::OpenAiChat => "chat",
            Protocol::OpenAiResponses => "responses",
            Protocol::Anthropic => "anthropic",
        }
    );
    let outcome = tokio::time::timeout(
        std::time::Duration::from_secs(15),
        manager.call_unified_model_2_stream_with_config(
            config,
            routing::ESTABLISH_RETRIES_WITHOUT_FALLBACK,
            &std::collections::HashMap::new(),
            &history,
            "",
            false,
            false,
            Some("provider_handwriting_acceptance"),
            &NoopStreamSink,
            &stream_event,
            Some("local-handwriting-acceptance"),
            None,
            true,
            None,
            None,
        ),
    )
    .await;
    server_task.abort();
    outcome
        .expect("bounded local provider request should complete")
        .expect("production chat path should accept local provider response");
    let captured_body = captured.lock().unwrap().take();
    captured_body.expect("production HTTP request reached local capture server")
}

fn assert_tool_pair_order_and_image_bytes(body: &Value, protocol: Protocol) {
    use base64::Engine as _;
    let image = png_base64();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&image)
        .expect("decode fixture image");
    assert_eq!(&bytes[..8], b"\x89PNG\r\n\x1a\n", "fixture is a PNG");

    match protocol {
        Protocol::OpenAiChat => {
            let messages = body["messages"].as_array().expect("chat messages");
            assert_eq!(messages[1]["tool_calls"][0]["id"], "call_parallel_a");
            assert_eq!(messages[1]["tool_calls"][1]["id"], "call_parallel_b");
            assert_eq!(messages[2]["tool_call_id"], "call_parallel_a");
            assert_eq!(messages[2]["content"], "alpha result");
            assert_eq!(messages[3]["tool_call_id"], "call_parallel_b");
            assert_eq!(messages[3]["content"], "beta result");
            let part = messages[4]["content"]
                .as_array()
                .unwrap()
                .iter()
                .find(|part| part["type"] == "image_url")
                .expect("typed OpenAI image block");
            assert_eq!(
                part["image_url"]["url"],
                format!("data:image/png;base64,{image}")
            );
            assert!(
                part.get("image_url").is_some(),
                "must not pass the image only as a string"
            );
        }
        Protocol::OpenAiResponses => {
            let input = body["input"].as_array().expect("Responses input");
            let first_call = input
                .iter()
                .position(|item| {
                    item["type"] == "function_call" && item["call_id"] == "call_parallel_a"
                })
                .unwrap();
            let second_call = input
                .iter()
                .position(|item| {
                    item["type"] == "function_call" && item["call_id"] == "call_parallel_b"
                })
                .unwrap();
            let first_result = input
                .iter()
                .position(|item| {
                    item["type"] == "function_call_output" && item["call_id"] == "call_parallel_a"
                })
                .unwrap();
            let second_result = input
                .iter()
                .position(|item| {
                    item["type"] == "function_call_output" && item["call_id"] == "call_parallel_b"
                })
                .unwrap();
            assert!(
                first_call < second_call
                    && second_call < first_result
                    && first_result < second_result,
                "parallel calls and associated outputs preserve history order"
            );
            let image_location = input.iter().enumerate().find_map(|(message_index, item)| {
                if item["role"] != "user"
                    || item
                        .get("type")
                        .is_some_and(|kind| kind.as_str() != Some("message"))
                {
                    return None;
                }
                let part_index = item["content"]
                    .as_array()?
                    .iter()
                    .position(|part| part["type"] == "input_image")?;
                Some((message_index, part_index))
            });
            assert!(
                image_location.is_some(),
                "typed Responses input_image block missing; captured body: {}",
                body
            );
            let (user_message_index, image_part_index) = image_location.unwrap();
            assert!(
                second_result < user_message_index,
                "handwriting image must follow all tool results; captured body: {}",
                body
            );
            let image_part = &input[user_message_index]["content"][image_part_index];
            assert_eq!(
                image_part["image_url"],
                format!("data:image/png;base64,{image}"),
                "captured body: {}",
                body
            );
        }
        Protocol::Anthropic => {
            let messages = body["messages"].as_array().expect("Anthropic messages");
            let calls = messages
                .iter()
                .find(|message| message["role"] == "assistant")
                .and_then(|message| message["content"].as_array())
                .expect("assistant tool uses");
            assert_eq!(calls[0]["type"], "tool_use");
            assert_eq!(calls[0]["id"], "call_parallel_a");
            assert_eq!(calls[0]["name"], "lookup_alpha");
            assert_eq!(calls[1]["type"], "tool_use");
            assert_eq!(calls[1]["id"], "call_parallel_b");
            assert_eq!(calls[1]["name"], "lookup_beta");
            let ordered_blocks = messages
                .iter()
                .enumerate()
                .flat_map(|(message_index, message)| {
                    message["content"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .enumerate()
                        .map(move |(block_index, block)| (message_index, block_index, block))
                })
                .collect::<Vec<_>>();
            let results = ordered_blocks
                .iter()
                .filter(|(_, _, block)| block["type"] == "tool_result")
                .collect::<Vec<_>>();
            assert_eq!(
                results.len(),
                2,
                "expected both tool result blocks; captured body: {}",
                body
            );
            assert_eq!(
                results[0].2["tool_use_id"], "call_parallel_a",
                "captured body: {}",
                body
            );
            assert_eq!(
                results[0].2["content"][0]["text"], "alpha result",
                "captured body: {}",
                body
            );
            assert_eq!(
                results[1].2["tool_use_id"], "call_parallel_b",
                "captured body: {}",
                body
            );
            assert_eq!(
                results[1].2["content"][0]["text"], "beta result",
                "captured body: {}",
                body
            );
            let image_location = ordered_blocks
                .iter()
                .find(|(_, _, block)| block["type"] == "image")
                .map(|(message_index, block_index, _)| (*message_index, *block_index));
            assert!(
                image_location.is_some(),
                "typed Anthropic image block missing; captured body: {}",
                body
            );
            let image_location = image_location.unwrap();
            assert!(
                (results[1].0, results[1].1) < image_location,
                "handwriting image must follow both tool results; captured body: {}",
                body
            );
            let image_block = &ordered_blocks
                .iter()
                .find(|(_, _, block)| block["type"] == "image")
                .expect("image location checked above")
                .2;
            assert_eq!(image_block["source"]["type"], "base64");
            assert_eq!(image_block["source"]["media_type"], "image/png");
            assert_eq!(image_block["source"]["data"], image);
        }
    }

    // Decode each expected wire image and compare bytes so a data URL string alone cannot pass.
    let delivered = match protocol {
        Protocol::OpenAiChat => body["messages"][4]["content"]
            .as_array()
            .unwrap()
            .iter()
            .find(|part| part["type"] == "image_url")
            .unwrap()["image_url"]["url"]
            .as_str()
            .unwrap()
            .to_string(),
        Protocol::OpenAiResponses => body["input"]
            .as_array()
            .unwrap()
            .iter()
            .find_map(|item| {
                let outer_type = item.get("type").and_then(Value::as_str);
                if item["role"] != "user" || outer_type.is_some_and(|kind| kind != "message") {
                    return None;
                }
                item["content"]
                    .as_array()?
                    .iter()
                    .find(|part| part["type"] == "input_image")?["image_url"]
                    .as_str()
                    .map(str::to_string)
            })
            .unwrap_or_else(|| {
                panic!(
                    "typed Responses user input_image missing; captured body: {}",
                    body
                )
            }),
        Protocol::Anthropic => body["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|message| {
                message["role"] == "user"
                    && message["content"]
                        .as_array()
                        .is_some_and(|parts| parts.iter().any(|part| part["type"] == "image"))
            })
            .unwrap()["content"]
            .as_array()
            .unwrap()
            .iter()
            .find(|part| part["type"] == "image")
            .unwrap()["source"]["data"]
            .as_str()
            .unwrap()
            .to_string(),
    };
    let wire_base64 = if matches!(protocol, Protocol::Anthropic) {
        delivered
    } else {
        delivered
            .strip_prefix("data:image/png;base64,")
            .expect("PNG data URL prefix")
            .to_string()
    };
    let wire_bytes = base64::engine::general_purpose::STANDARD
        .decode(wire_base64)
        .expect("decode wire image");
    assert_eq!(
        wire_bytes, bytes,
        "captured request must carry the exact generated PNG bytes"
    );
}

#[tokio::test]
async fn local_openai_chat_completions_request_carries_handwriting_png_after_parallel_tools() {
    let body = captured_production_request(Protocol::OpenAiChat).await;
    assert_tool_pair_order_and_image_bytes(&body, Protocol::OpenAiChat);
}

#[tokio::test]
async fn local_openai_responses_request_carries_typed_handwriting_png_after_parallel_tools() {
    let body = captured_production_request(Protocol::OpenAiResponses).await;
    assert_tool_pair_order_and_image_bytes(&body, Protocol::OpenAiResponses);
}

#[tokio::test]
async fn local_anthropic_request_carries_base64_handwriting_png_after_parallel_tools() {
    let body = captured_production_request(Protocol::Anthropic).await;
    assert_tool_pair_order_and_image_bytes(&body, Protocol::Anthropic);
}
