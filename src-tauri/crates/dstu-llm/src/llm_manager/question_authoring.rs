//! Complete structured question requests through the existing provider adapters.
use super::{effective_max_tokens, single_shot_stream::SingleShotOptions, ApiConfig, LLMManager};
use crate::models::AppError;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

static JSON_UNSUPPORTED: LazyLock<Mutex<HashMap<String, Instant>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[derive(Debug, Clone)]
pub struct QuestionJsonCompletion {
    pub content: String,
    pub finish_reason: Option<String>,
    pub usage: Option<Value>,
    pub json_mode: bool,
}

fn complete_json_payload(content: &str) -> Result<String, serde_json::Error> {
    let text = content.trim().trim_start_matches('\u{feff}').trim();
    // Remove only a complete transport wrapper. Never search for a JSON
    // substring or repair/truncate an incomplete model response.
    let text = if let Some(fenced) = text
        .strip_prefix("```json\n")
        .or_else(|| text.strip_prefix("```\n"))
    {
        fenced.strip_suffix("```").unwrap_or(text).trim()
    } else {
        text
    };
    serde_json::from_str::<serde_json::Map<String, Value>>(text)?;
    Ok(text.to_string())
}

fn compatibility_key(config: &ApiConfig) -> String {
    format!(
        "{}|{}|{}|{:?}|{}|{:?}",
        config.id,
        config.base_url,
        config.model,
        config.api_protocol,
        config.model_adapter,
        config.extra_body
    )
}

pub(crate) fn rejects_json_mode(error: &AppError) -> bool {
    let Some(details) = error.details.as_ref() else {
        return false;
    };
    if !matches!(
        details.get("status").and_then(Value::as_u64),
        Some(400 | 422)
    ) {
        return false;
    }
    let message = format!(
        "{} {}",
        error.message,
        details.get("body").unwrap_or(&Value::Null)
    )
    .to_ascii_lowercase();
    let parameter = [
        "response_format",
        "json_object",
        "responsemime",
        "response_mime",
        "output_config",
        "text.format",
    ]
    .iter()
    .any(|word| message.contains(word));
    let unsupported = [
        "unsupported",
        "not supported",
        "not support",
        "unknown parameter",
        "unrecognized",
        "not permitted",
        "not allowed",
        "invalid parameter",
        "不支持",
    ]
    .iter()
    .any(|word| message.contains(word));
    parameter && unsupported
}

pub(crate) fn request_body(
    config: &ApiConfig,
    system: &str,
    content: Value,
    json_mode: bool,
) -> Value {
    // Keep the dedicated output contract after the final source page as well
    // as in system. Some reasoning-model relays otherwise answer the last
    // page's natural-language task in Markdown despite accepting JSON mode.
    let output_contract = format!(
        "END OF SOURCE DATA. The following is the output contract, not document content.\n\
         Return exactly one complete JSON object. Do not render a Markdown question list, a report, or code fences.\n\
         The first non-whitespace character must be {{ and the last must be }}.\n\
         Apply the following task instructions to ALL original evidence above; never summarize or discard source pages:\n{system}"
    );
    let content = match content {
        Value::Array(mut parts) => {
            parts.push(json!({"type":"text","text":output_contract}));
            Value::Array(parts)
        }
        Value::String(text) => json!(format!("{text}\n\n{output_contract}")),
        other => other,
    };
    let mut body = json!({"model":config.model,"messages":[{"role":"system","content":system},{"role":"user","content":content}],
        "temperature":config.temperature,"max_tokens":effective_max_tokens(config.max_output_tokens,config.max_tokens_limit)});
    if let Some(value) = config.top_p_override {
        body["top_p"] = json!(value);
    }
    if let Some(value) = config.frequency_penalty_override {
        body["frequency_penalty"] = json!(value);
    }
    if let Some(value) = config.presence_penalty_override {
        body["presence_penalty"] = json!(value);
    }
    if json_mode {
        body["response_format"] = json!({"type":"json_object"});
    }
    LLMManager::apply_reasoning_config(&mut body, config, None);
    if !json_mode {
        // extra_body must not re-enable a parameter rejected on this attempt.
        body.as_object_mut().unwrap().remove("response_format");
    }
    body
}

impl LLMManager {
    pub async fn resolve_question_authoring_config(
        &self,
        model_id: Option<&str>,
    ) -> Result<ApiConfig, AppError> {
        let config = match model_id {
            Some(id) => self
                .get_api_configs()
                .await?
                .into_iter()
                .find(|c| c.id == id)
                .ok_or_else(|| AppError::configuration(format!("找不到指定的解析模型: {id}")))?,
            None => self.get_model2_config().await?,
        };
        if !config.enabled
            || config.is_embedding
            || config.is_reranker
            || config.is_image_generation
        {
            return Err(AppError::configuration("解析模型必须是已启用的对话模型"));
        }
        if config.max_output_tokens == 0
            || config.max_tokens_limit == Some(0)
            || config.context_window == Some(0)
        {
            return Err(AppError::configuration("模型 token 配置必须为正数"));
        }
        Ok(config)
    }

    pub async fn run_question_json(
        &self,
        config: &ApiConfig,
        system_prompt: &str,
        user_content: Value,
        cancel: Option<CancellationToken>,
    ) -> Result<QuestionJsonCompletion, AppError> {
        let key = compatibility_key(config);
        let mut json_mode = !JSON_UNSUPPORTED
            .lock()
            .map(|mut cache| {
                cache.retain(|_, when| when.elapsed() < Duration::from_secs(900));
                cache.contains_key(&key)
            })
            .unwrap_or(false);
        let api_key = self.decrypt_api_key(&config.api_key)?;
        let mut opts =
            SingleShotOptions::new(format!("题目文档解析({})", config.model)).with_max_retries(0);
        opts.cancel = cancel;
        // This is a transport memory bound derived from configured output, not
        // an additional token limit or permission to truncate source content.
        opts.max_stream_bytes =
            (effective_max_tokens(config.max_output_tokens, config.max_tokens_limit) as usize)
                .saturating_mul(2048)
                .max(32 * 1024 * 1024);
        loop {
            let body = request_body(config, system_prompt, user_content.clone(), json_mode);
            let result = self
                .single_shot_completion(
                    config,
                    &body,
                    Some(&api_key),
                    None,
                    "题目解析请求构建失败",
                    &opts,
                    None,
                )
                .await;
            let completion = match result {
                Err(error) if json_mode && rejects_json_mode(&error) => {
                    json_mode = false;
                    if let Ok(mut cache) = JSON_UNSUPPORTED.lock() {
                        cache.insert(key.clone(), Instant::now());
                    }
                    log::info!(
                        "[QuestionAuthoring] {} rejects JSON mode; retrying complete input once",
                        config.model
                    );
                    continue;
                }
                other => other?,
            };
            if completion.aborted
                || completion.interrupted.is_some()
                || matches!(
                    completion.finish_reason.as_deref(),
                    Some("length" | "max_tokens" | "max_output_tokens" | "MAX_TOKENS")
                )
            {
                return Err(AppError::with_details(
                    crate::models::AppErrorType::LLM,
                    "题目解析结果被截断，未创建正式题目。请调整所选模型的输出/上下文配置后重试。"
                        .to_string(),
                    json!({"code":"INCOMPLETE_OUTPUT","finish_reason":completion.finish_reason,"raw_response":completion.content}),
                ));
            }
            let content = complete_json_payload(&completion.content).map_err(
                |e| {
                    AppError::with_details(
                        crate::models::AppErrorType::LLM,
                        format!("题目解析未返回完整 JSON 对象: {e}"),
                        json!({"code":"INVALID_JSON","raw_response":completion.content,"model":config.model,"json_mode":json_mode,"finish_reason":completion.finish_reason,"reasoning_bytes":completion.reasoning_bytes,"usage":completion.usage}),
                    )
                },
            )?;
            return Ok(QuestionJsonCompletion {
                content,
                finish_reason: completion.finish_reason,
                usage: completion.usage,
                json_mode,
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AppErrorType;
    #[test]
    fn complete_fence_is_transport_only_and_never_repairs_a_prefix() {
        assert_eq!(
            complete_json_payload("```json\n{\"questions\":[]}\n```").unwrap(),
            "{\"questions\":[]}"
        );
        for text in [
            "```json\n{\"questions\":[",
            "prefix {\"questions\":[]}",
            "{\"questions\":[]} trailing",
            "[]",
        ] {
            assert!(complete_json_payload(text).is_err(), "{text}");
        }
    }
    #[test]
    fn only_explicit_parameter_incompatibility_disables_json() {
        for status in [401, 403, 413, 429, 500] {
            let e = AppError::with_details(
                AppErrorType::LLM,
                "unsupported response_format",
                json!({"status":status,"body":"unsupported json_object"}),
            );
            assert!(!rejects_json_mode(&e));
        }
        assert!(rejects_json_mode(&AppError::with_details(
            AppErrorType::LLM,
            "bad request",
            json!({"status":400,"body":"response_format json_object is not supported"})
        )));
        assert!(!rejects_json_mode(&AppError::with_details(
            AppErrorType::LLM,
            "bad request",
            json!({"status":400,"body":"context length exceeded"})
        )));
    }
    #[test]
    fn configured_output_and_full_input_are_preserved() {
        let config = ApiConfig {
            max_output_tokens: 65536,
            max_tokens_limit: Some(131072),
            temperature: 0.6,
            ..Default::default()
        };
        let text = "complete source".repeat(10000);
        let body = request_body(&config, "JSON", json!(text), true);
        assert_eq!(body["max_tokens"], 65536);
        assert!(body["messages"][1]["content"]
            .as_str()
            .unwrap()
            .starts_with(&text));
        assert_eq!(body["response_format"]["type"], "json_object");
        assert!(request_body(&config, "JSON", json!("x"), false)
            .get("response_format")
            .is_none());
    }

    async fn mock_completion(
        status: u16,
        reject_once: bool,
        finish: &str,
        pages: usize,
    ) -> (Result<QuestionJsonCompletion, AppError>, usize, Vec<Value>) {
        use hyper::service::{make_service_fn, service_fn};
        use hyper::{Body, Response, Server};
        use std::sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        };
        let hits = Arc::new(AtomicUsize::new(0));
        let bodies = Arc::new(Mutex::new(Vec::new()));
        let h = hits.clone();
        let b = bodies.clone();
        let finish = finish.to_string();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let server=Server::from_tcp(listener).unwrap().serve(make_service_fn(move |_| {
            let h=h.clone();let b=b.clone();let finish=finish.clone();
            async move {Ok::<_,std::convert::Infallible>(service_fn(move |request:hyper::Request<Body>| {
                let h=h.clone();let b=b.clone();let finish=finish.clone();
                async move {
                    let bytes=hyper::body::to_bytes(request.into_body()).await.unwrap();
                    let body:Value=serde_json::from_slice(&bytes).unwrap();b.lock().unwrap().push(body);
                    let index=h.fetch_add(1,Ordering::SeqCst);
                    let response=if status!=200 && (!reject_once || index==0) {
                        Response::builder().status(status).header("content-type","application/json").body(Body::from("{\"error\":{\"message\":\"response_format json_object is not supported\"}}")).unwrap()
                    } else {
                        let answer=json!({"schema_version":2,"questions":[]}).to_string();
                        let delta=json!({"choices":[{"index":0,"delta":{"content":answer},"finish_reason":null}]}).to_string();
                        let terminal=json!({"choices":[{"index":0,"delta":{},"finish_reason":finish}]}).to_string();
                        Response::builder().header("content-type","text/event-stream").body(Body::from(format!("data: {delta}\n\ndata: {terminal}\n\ndata: [DONE]\n\n"))).unwrap()
                    };
                    Ok::<_,std::convert::Infallible>(response)
                }
            }))}
        }));
        let task = tokio::spawn(server);
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("settings.db");
        let conn = rusqlite::Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE settings (key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)").unwrap();
        drop(conn);
        let db = Arc::new(crate::database::Database::new(&path).unwrap());
        let files =
            Arc::new(crate::file_manager::FileManager::new(temp.path().to_path_buf()).unwrap());
        let llm = LLMManager::new(db, files).unwrap();
        let config = ApiConfig {
            id: format!("mock-{address}"),
            name: "mock".into(),
            model: "mock".into(),
            base_url: format!("http://{address}/v1"),
            api_key: "mock-key".into(),
            api_protocol: Some("openai_chat_completions".into()),
            enabled: true,
            is_multimodal: true,
            max_output_tokens: 65536,
            ..Default::default()
        };
        let mut input = vec![json!({"type":"text","text":"full source"})];
        for page in 1..=pages {
            input.push(json!({"type":"text","text":format!("page={page}")}));
            input
                .push(json!({"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}));
        }
        let result = llm
            .run_question_json(&config, "Return JSON", json!(input), None)
            .await;
        let total = hits.load(Ordering::SeqCst);
        let bodies = bodies.lock().unwrap().clone();
        task.abort();
        (result, total, bodies)
    }
    #[tokio::test]
    async fn whole_small_documents_use_one_main_request() {
        for pages in [1, 19, 20] {
            let (result, hits, bodies) = mock_completion(200, false, "stop", pages).await;
            assert!(result.is_ok(), "{result:?}");
            assert_eq!(hits, 1);
            assert_eq!(bodies[0]["max_tokens"], 65536);
            assert_eq!(
                bodies[0]["messages"][1]["content"]
                    .as_array()
                    .unwrap()
                    .len(),
                2 + pages * 2
            );
        }
    }

    #[test]
    fn deepseek_keeps_model_settings_and_repeats_json_contract_after_all_visual_sources() {
        let config = ApiConfig {
            model: "tree-deepseek-v4.1-flash".into(),
            model_adapter: "deepseek".into(),
            provider_type: Some("custom".into()),
            provider_scope: Some("custom".into()),
            api_protocol: Some("openai_chat_completions".into()),
            base_url: "https://relay.example/v1".into(),
            is_multimodal: true,
            is_reasoning: true,
            supports_reasoning: true,
            thinking_enabled: true,
            enable_thinking: Some(true),
            reasoning_effort: Some("max".into()),
            max_output_tokens: 128000,
            ..Default::default()
        };
        let system =
            "Return JSON matching {\"schema_version\":2,\"mode\":\"extract\",\"questions\":[]}";
        let evidence = json!([{"type":"text","text":"完整原文"},{"type":"image_url","image_url":{"url":"data:image/png;base64,AAAA"}}]);
        let body = request_body(&config, system, evidence.clone(), true);
        let parts = body["messages"][1]["content"].as_array().unwrap();
        assert_eq!(&parts[..2], evidence.as_array().unwrap());
        assert!(parts.last().unwrap()["text"]
            .as_str()
            .unwrap()
            .contains(system));
        let mut adapted = json!({"temperature":config.temperature,"max_tokens":128000});
        LLMManager::apply_reasoning_config(&mut adapted, &config, None);
        for parameter in ["thinking", "reasoning_effort", "temperature"] {
            assert_eq!(body.get(parameter), adapted.get(parameter));
        }
        assert_eq!(body["max_tokens"], 128000);
        assert_eq!(body["response_format"]["type"], "json_object");
        let retry = request_body(&config, system, evidence, false);
        assert_eq!(body["messages"], retry["messages"]);
        assert!(retry.get("response_format").is_none());
    }
    #[tokio::test]
    async fn explicit_json_rejection_retries_once_with_identical_evidence() {
        let (result, hits, bodies) = mock_completion(400, true, "stop", 20).await;
        assert!(result.is_ok(), "{result:?}");
        assert_eq!(hits, 2);
        assert_eq!(bodies[0]["response_format"]["type"], "json_object");
        assert!(bodies[1].get("response_format").is_none());
        assert_eq!(bodies[0]["messages"], bodies[1]["messages"]);
    }
    #[tokio::test]
    async fn auth_rate_and_length_errors_never_become_json_fallback_success() {
        for status in [401, 429, 413, 500] {
            let (result, hits, _) = mock_completion(status, false, "stop", 1).await;
            assert!(result.is_err());
            assert_eq!(hits, 1);
        }
        let (result, hits, _) = mock_completion(200, false, "length", 1).await;
        assert!(result.is_err());
        assert_eq!(hits, 1);
    }
}
