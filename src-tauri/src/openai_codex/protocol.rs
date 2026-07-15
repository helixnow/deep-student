use crate::openai_codex::error::CodexAuthError;
use crate::openai_codex::types::CodexRequestAuth;
use reqwest::header::{
    HeaderMap, HeaderName, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, USER_AGENT,
};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use url::Url;

pub const OPENAI_OAUTH_CLIENT_ID: &str = "app_EMoamEEZ73f0CkXaXp7hrann";
pub const OPENAI_OAUTH_ISSUER: &str = "https://auth.openai.com";
pub const CODEX_RESPONSES_ENDPOINT: &str = "https://chatgpt.com/backend-api/codex/responses";
pub const CODEX_USAGE_ENDPOINT: &str = "https://chatgpt.com/backend-api/wham/usage";
pub const CODEX_DEVICE_VERIFICATION_URL: &str = "https://auth.openai.com/codex/device";
pub const CODEX_CREDENTIAL_KEY: &str = "internal.oauth.openai_codex.session";
pub const OPENAI_OAUTH_SCOPE: &str = "openid profile email offline_access";
pub const CODEX_ORIGINATOR: &str = "codex_cli_rs";
pub const CODEX_RESPONSES_BETA: &str = "responses=experimental";

#[derive(Clone)]
pub(crate) struct CodexEndpointConfig {
    pub client_id: String,
    pub authorize_url: Url,
    pub token_url: Url,
    pub revoke_url: Url,
    pub device_user_code_url: Url,
    pub device_token_url: Url,
    pub device_verification_url: Url,
    pub device_redirect_url: Url,
    pub responses_url: Url,
    pub usage_url: Url,
}

impl Default for CodexEndpointConfig {
    fn default() -> Self {
        let issuer = Url::parse(OPENAI_OAUTH_ISSUER).expect("constant OAuth issuer must be valid");
        Self {
            client_id: OPENAI_OAUTH_CLIENT_ID.to_string(),
            authorize_url: issuer
                .join("/oauth/authorize")
                .expect("valid authorize URL"),
            token_url: issuer.join("/oauth/token").expect("valid token URL"),
            revoke_url: issuer.join("/oauth/revoke").expect("valid revoke URL"),
            device_user_code_url: issuer
                .join("/api/accounts/deviceauth/usercode")
                .expect("valid device user-code URL"),
            device_token_url: issuer
                .join("/api/accounts/deviceauth/token")
                .expect("valid device token URL"),
            device_verification_url: Url::parse(CODEX_DEVICE_VERIFICATION_URL)
                .expect("valid verification URL"),
            device_redirect_url: issuer
                .join("/deviceauth/callback")
                .expect("valid device redirect URL"),
            responses_url: Url::parse(CODEX_RESPONSES_ENDPOINT).expect("valid Responses URL"),
            usage_url: Url::parse(CODEX_USAGE_ENDPOINT).expect("valid usage URL"),
        }
    }
}

impl CodexEndpointConfig {
    #[cfg(test)]
    pub(crate) fn for_test(base: &str) -> Self {
        let base = Url::parse(base).expect("test base URL");
        Self {
            client_id: "test-client".to_string(),
            authorize_url: base.join("oauth/authorize").unwrap(),
            token_url: base.join("oauth/token").unwrap(),
            revoke_url: base.join("oauth/revoke").unwrap(),
            device_user_code_url: base.join("device/usercode").unwrap(),
            device_token_url: base.join("device/token").unwrap(),
            device_verification_url: base.join("device").unwrap(),
            device_redirect_url: base.join("device/callback").unwrap(),
            responses_url: base.join("codex/responses").unwrap(),
            usage_url: base.join("wham/usage").unwrap(),
        }
    }
}

pub fn codex_responses_endpoint() -> &'static str {
    CODEX_RESPONSES_ENDPOINT
}

pub fn build_codex_request_headers(
    auth: &CodexRequestAuth,
    session_id: &str,
) -> Result<HeaderMap, CodexAuthError> {
    let mut headers = HeaderMap::new();
    let bearer = HeaderValue::from_str(&format!("Bearer {}", auth.access_token()))
        .map_err(|_| CodexAuthError::InvalidHeader)?;
    let session_id =
        HeaderValue::from_str(session_id).map_err(|_| CodexAuthError::InvalidHeader)?;
    let user_agent = HeaderValue::from_str(&format!("deep-student/{}", env!("CARGO_PKG_VERSION")))
        .map_err(|_| CodexAuthError::InvalidHeader)?;

    let account_id = auth.account_id().trim();
    if account_id.is_empty() {
        return Err(CodexAuthError::MissingAccountId);
    }
    let account_id =
        HeaderValue::from_str(account_id).map_err(|_| CodexAuthError::InvalidHeader)?;

    headers.insert(AUTHORIZATION, bearer);
    headers.insert(HeaderName::from_static("chatgpt-account-id"), account_id);
    headers.insert(
        HeaderName::from_static("originator"),
        HeaderValue::from_static(CODEX_ORIGINATOR),
    );
    headers.insert(
        HeaderName::from_static("openai-beta"),
        HeaderValue::from_static(CODEX_RESPONSES_BETA),
    );
    headers.insert(HeaderName::from_static("session-id"), session_id.clone());
    headers.insert(HeaderName::from_static("session_id"), session_id.clone());
    headers.insert(HeaderName::from_static("conversation_id"), session_id);
    if auth.is_fedramp() {
        headers.insert(
            HeaderName::from_static("x-openai-fedramp"),
            HeaderValue::from_static("true"),
        );
    }
    headers.insert(USER_AGENT, user_agent);
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    headers.insert(
        ACCEPT,
        HeaderValue::from_static("text/event-stream, application/json"),
    );
    Ok(headers)
}

pub fn prepare_codex_responses_body(body: &Value) -> Result<Value, CodexAuthError> {
    let mut payload = body
        .as_object()
        .cloned()
        .ok_or(CodexAuthError::InvalidRequestBody("expected a JSON object"))?;

    let model = payload
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or_default();
    if model.is_empty() {
        return Err(CodexAuthError::InvalidRequestBody("model is required"));
    }
    if !payload.contains_key("input") {
        return Err(CodexAuthError::InvalidRequestBody(
            "Responses input is required",
        ));
    }

    payload.insert("store".to_string(), Value::Bool(false));
    // The ChatGPT Codex transport is SSE-only. Non-streaming application callers
    // are bridged back to a canonical Responses JSON object after the request.
    payload.insert("stream".to_string(), Value::Bool(true));

    let mut include = payload
        .remove("include")
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    if !include
        .iter()
        .any(|value| value.as_str() == Some("reasoning.encrypted_content"))
    {
        include.push(json!("reasoning.encrypted_content"));
    }
    payload.insert("include".to_string(), Value::Array(include));

    // The ChatGPT Codex endpoint rejects public-API sampling and output-limit fields.
    payload.remove("max_output_tokens");
    payload.remove("max_completion_tokens");
    payload.remove("max_tokens");
    payload.remove("max_total_tokens");
    payload.remove("temperature");
    payload.remove("top_p");

    Ok(Value::Object(payload))
}

#[derive(Default)]
struct CodexSseAccumulator {
    final_response: Option<Value>,
    output_items: BTreeMap<u64, Value>,
    output_text: String,
    reasoning_text: String,
    usage: Option<Value>,
    response_id: Option<String>,
    model: Option<String>,
    error: Option<Value>,
    saw_json_event: bool,
}

impl CodexSseAccumulator {
    fn absorb(&mut self, event: Value) {
        self.saw_json_event = true;
        let event_type = event.get("type").and_then(Value::as_str).unwrap_or("");

        if let Some(response) = event.get("response").filter(|value| value.is_object()) {
            self.capture_response_metadata(response);
            if matches!(
                event_type,
                "response.completed" | "response.done" | "response.failed" | "response.incomplete"
            ) {
                self.final_response = Some(response.clone());
            }
        }
        if let Some(usage) = event.get("usage").filter(|value| value.is_object()) {
            self.usage = Some(usage.clone());
        }

        match event_type {
            "response.output_text.delta" => {
                append_string(&mut self.output_text, event.get("delta"));
            }
            "response.output_text.done" => {
                replace_with_final_string(&mut self.output_text, event.get("text"));
            }
            "response.reasoning_text.delta" | "response.reasoning_summary_text.delta" => {
                append_string(&mut self.reasoning_text, event.get("delta"));
            }
            "response.reasoning_text.done" | "response.reasoning_summary_text.done" => {
                replace_with_final_string(&mut self.reasoning_text, event.get("text"));
            }
            "response.output_item.added" | "response.output_item.done" => {
                if let Some(item) = event.get("item").filter(|value| value.is_object()) {
                    let index = event_index(&event, self.output_items.len() as u64);
                    self.output_items.insert(index, item.clone());
                }
            }
            "response.content_part.added" | "response.content_part.done" => {
                if let Some(part) = event.get("part") {
                    let part_type = part.get("type").and_then(Value::as_str).unwrap_or("");
                    if matches!(part_type, "output_text" | "text") {
                        replace_with_final_string(&mut self.output_text, part.get("text"));
                    }
                }
            }
            "response.function_call_arguments.delta" => {
                self.update_tool_arguments(&event, "arguments", "delta", "function_call");
            }
            "response.function_call_arguments.done" => {
                self.update_tool_arguments(&event, "arguments", "arguments", "function_call");
            }
            "response.custom_tool_call_input.delta" => {
                self.update_tool_arguments(&event, "input", "delta", "custom_tool_call");
            }
            "response.custom_tool_call_input.done" => {
                self.update_tool_arguments(&event, "input", "input", "custom_tool_call");
            }
            "error" => {
                self.error = Some(canonical_stream_error(&event));
            }
            _ => {}
        }
    }

    fn capture_response_metadata(&mut self, response: &Value) {
        if self.response_id.is_none() {
            self.response_id = response
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }
        if self.model.is_none() {
            self.model = response
                .get("model")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
        }
        if let Some(usage) = response.get("usage").filter(|value| value.is_object()) {
            self.usage = Some(usage.clone());
        }
    }

    fn update_tool_arguments(
        &mut self,
        event: &Value,
        item_field: &str,
        event_field: &str,
        item_type: &str,
    ) {
        let index = event_index(event, self.output_items.len() as u64);
        let value = event
            .get(event_field)
            .and_then(Value::as_str)
            .unwrap_or_default();
        let item = self.output_items.entry(index).or_insert_with(|| {
            let mut item = serde_json::Map::new();
            item.insert("type".to_string(), Value::String(item_type.to_string()));
            for key in ["id", "item_id", "call_id", "name"] {
                if let Some(value) = event.get(key).and_then(Value::as_str) {
                    let target = if key == "item_id" { "id" } else { key };
                    item.insert(target.to_string(), Value::String(value.to_string()));
                }
            }
            Value::Object(item)
        });

        let Some(object) = item.as_object_mut() else {
            return;
        };
        if event_field == "delta" {
            let entry = object
                .entry(item_field.to_string())
                .or_insert_with(|| Value::String(String::new()));
            if let Some(current) = entry.as_str() {
                *entry = Value::String(format!("{current}{value}"));
            }
        } else if !value.is_empty() {
            object.insert(item_field.to_string(), Value::String(value.to_string()));
        }
    }

    fn finish(mut self) -> Result<Value, CodexAuthError> {
        if !self.saw_json_event {
            return Err(CodexAuthError::MalformedResponse {
                field: "Codex SSE response",
            });
        }

        self.apply_tool_argument_fallbacks();
        let fallback_output = self.fallback_output();
        if let Some(mut response) = self.final_response {
            if let Some(object) = response.as_object_mut() {
                let output_missing = object
                    .get("output")
                    .and_then(Value::as_array)
                    .is_none_or(Vec::is_empty);
                if output_missing && !fallback_output.is_empty() {
                    object.insert("output".to_string(), Value::Array(fallback_output));
                }
                if object.get("usage").is_none_or(Value::is_null) {
                    if let Some(usage) = self.usage {
                        object.insert("usage".to_string(), usage);
                    }
                }
            }
            return Ok(response);
        }

        let failed = self.error.is_some();
        let mut response = json!({
            "id": self.response_id.unwrap_or_else(|| "resp_codex_bridge".to_string()),
            "object": "response",
            "status": if failed { "failed" } else { "completed" },
            "output": fallback_output,
        });
        if let Some(model) = self.model {
            response["model"] = Value::String(model);
        }
        if let Some(usage) = self.usage {
            response["usage"] = usage;
        }
        if let Some(error) = self.error {
            response["error"] = error;
        }
        Ok(response)
    }

    fn apply_tool_argument_fallbacks(&mut self) {
        for item in self.output_items.values_mut() {
            let Some(object) = item.as_object_mut() else {
                continue;
            };
            match object.get("type").and_then(Value::as_str) {
                Some("function_call") => {
                    object
                        .entry("arguments".to_string())
                        .or_insert_with(|| Value::String("{}".to_string()));
                }
                Some("custom_tool_call") => {
                    object
                        .entry("input".to_string())
                        .or_insert_with(|| Value::String(String::new()));
                }
                _ => {}
            }
        }
    }

    fn fallback_output(&self) -> Vec<Value> {
        let mut output: Vec<Value> = self.output_items.values().cloned().collect();
        let has_reasoning = output
            .iter()
            .any(|item| item.get("type").and_then(Value::as_str) == Some("reasoning"));
        if !self.reasoning_text.is_empty() && !has_reasoning {
            output.insert(
                0,
                json!({
                    "type": "reasoning",
                    "summary": [{"type": "summary_text", "text": self.reasoning_text.clone()}],
                }),
            );
        }

        let has_output_text = output.iter().any(item_contains_output_text);
        if !self.output_text.is_empty() && !has_output_text {
            output.push(json!({
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{
                    "type": "output_text",
                    "text": self.output_text.clone(),
                    "annotations": [],
                }],
            }));
        }
        output
    }
}

/// Convert the SSE-only ChatGPT Codex transport into the canonical JSON shape
/// expected by existing non-streaming Responses callers.
pub fn codex_sse_to_responses_json(body: &str) -> Result<Value, CodexAuthError> {
    let mut accumulator = CodexSseAccumulator::default();
    let mut event_name: Option<String> = None;
    let mut data_lines: Vec<String> = Vec::new();

    for raw_line in body.lines().chain(std::iter::once("")) {
        let line = raw_line.trim_end_matches('\r');
        if line.is_empty() {
            if !data_lines.is_empty() {
                let data = data_lines.join("\n");
                if data.trim() != "[DONE]" {
                    if let Ok(mut event) = serde_json::from_str::<Value>(&data) {
                        if event.get("type").is_none() {
                            if let (Some(name), Some(object)) =
                                (event_name.as_ref(), event.as_object_mut())
                            {
                                object.insert("type".to_string(), Value::String(name.clone()));
                            }
                        }
                        accumulator.absorb(event);
                    }
                }
            }
            event_name = None;
            data_lines.clear();
            continue;
        }
        if line.starts_with(':') {
            continue;
        }
        if let Some(name) = line.strip_prefix("event:") {
            event_name = Some(name.trim().to_string());
        } else if let Some(data) = line.strip_prefix("data:") {
            data_lines.push(data.trim_start().to_string());
        }
    }

    accumulator.finish()
}

fn event_index(event: &Value, fallback: u64) -> u64 {
    event
        .get("output_index")
        .or_else(|| event.get("item_index"))
        .and_then(Value::as_u64)
        .unwrap_or(fallback)
}

fn append_string(target: &mut String, value: Option<&Value>) {
    if let Some(value) = value.and_then(Value::as_str) {
        target.push_str(value);
    }
}

fn replace_with_final_string(target: &mut String, value: Option<&Value>) {
    let Some(value) = value.and_then(Value::as_str) else {
        return;
    };
    if !value.is_empty() {
        target.clear();
        target.push_str(value);
    }
}

fn item_contains_output_text(item: &Value) -> bool {
    item.get("content")
        .and_then(Value::as_array)
        .is_some_and(|content| {
            content.iter().any(|part| {
                matches!(
                    part.get("type").and_then(Value::as_str),
                    Some("output_text" | "text")
                )
            })
        })
}

fn canonical_stream_error(event: &Value) -> Value {
    let source = event.get("error").unwrap_or(event);
    let raw_code = source
        .get("code")
        .or_else(|| source.get("type"))
        .and_then(Value::as_str)
        .unwrap_or("response_stream_error");
    let code: String = raw_code
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.'))
        .take(64)
        .collect();
    json!({
        "code": if code.is_empty() { "response_stream_error" } else { code.as_str() },
        "type": "response_stream_error",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openai_codex::types::{StoredCodexSession, SESSION_SCHEMA_VERSION};

    #[test]
    fn endpoint_config_can_be_overridden_for_http_tests() {
        let config = CodexEndpointConfig::for_test("http://127.0.0.1:3456/");
        assert_eq!(
            config.token_url.as_str(),
            "http://127.0.0.1:3456/oauth/token"
        );
        assert_eq!(
            config.responses_url.as_str(),
            "http://127.0.0.1:3456/codex/responses"
        );
        assert_eq!(
            config.usage_url.as_str(),
            "http://127.0.0.1:3456/wham/usage"
        );
    }

    #[test]
    fn request_headers_contain_codex_auth_without_debuggable_dto_tokens() {
        let session = StoredCodexSession {
            schema_version: SESSION_SCHEMA_VERSION,
            access_token: "secret-access".to_string(),
            refresh_token: "secret-refresh".to_string(),
            id_token: None,
            expires_at_unix_ms: 1,
            account_id: "acct_123".to_string(),
            email: None,
            plan_type: None,
            is_fedramp: true,
            last_refresh_at: None,
        };
        let auth = CodexRequestAuth::new(&session, 1);
        let headers = build_codex_request_headers(&auth, "session-1").unwrap();
        assert_eq!(headers["chatgpt-account-id"], "acct_123");
        assert_eq!(headers["originator"], CODEX_ORIGINATOR);
        assert_eq!(headers["openai-beta"], CODEX_RESPONSES_BETA);
        assert_eq!(headers["session-id"], "session-1");
        assert_eq!(headers["session_id"], "session-1");
        assert_eq!(headers["conversation_id"], "session-1");
        assert_eq!(headers["authorization"], "Bearer secret-access");
        assert_eq!(headers["x-openai-fedramp"], "true");
    }

    #[test]
    fn request_headers_reject_missing_account_id() {
        let session = StoredCodexSession {
            schema_version: SESSION_SCHEMA_VERSION,
            access_token: "secret-access".to_string(),
            refresh_token: "secret-refresh".to_string(),
            id_token: None,
            expires_at_unix_ms: 1,
            account_id: " ".to_string(),
            email: None,
            plan_type: None,
            is_fedramp: false,
            last_refresh_at: None,
        };
        let auth = CodexRequestAuth::new(&session, 1);
        assert!(matches!(
            build_codex_request_headers(&auth, "session-1"),
            Err(CodexAuthError::MissingAccountId)
        ));
    }

    #[test]
    fn responses_body_is_sanitized_for_codex() {
        let body = json!({
            "model": "gpt-5.4",
            "input": [{"role": "user", "content": [{"type": "input_text", "text": "hi"}]}],
            "store": true,
            "stream": false,
            "include": ["file_search_call.results"],
            "max_output_tokens": 100,
            "max_completion_tokens": 101,
            "max_tokens": 102,
            "max_total_tokens": 103,
            "temperature": 0.2,
            "top_p": 0.8,
            "reasoning": {"effort": "xhigh", "summary": "auto"}
        });
        let prepared = prepare_codex_responses_body(&body).unwrap();
        assert_eq!(prepared["store"], false);
        assert_eq!(prepared["stream"], true);
        assert!(prepared["max_output_tokens"].is_null());
        assert!(prepared["max_completion_tokens"].is_null());
        assert!(prepared["max_tokens"].is_null());
        assert!(prepared["max_total_tokens"].is_null());
        assert!(prepared["temperature"].is_null());
        assert!(prepared["top_p"].is_null());
        assert_eq!(prepared["reasoning"]["effort"], json!("xhigh"));
        assert!(prepared["include"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == "reasoning.encrypted_content"));
    }

    #[test]
    fn sse_bridge_aggregates_text_reasoning_tools_and_usage() {
        let body = concat!(
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_1\",\"model\":\"gpt-5.4\"}}\n\n",
            "data: {\"type\":\"response.reasoning_summary_text.delta\",\"delta\":\"think\"}\n\n",
            "data: {\"type\":\"response.output_item.added\",\"output_index\":0,\"item\":{\"type\":\"function_call\",\"call_id\":\"call_1\",\"name\":\"lookup\",\"arguments\":\"\"}}\n\n",
            "data: {\"type\":\"response.function_call_arguments.delta\",\"output_index\":0,\"delta\":\"{\\\"q\\\":\"}\n\n",
            "data: {\"type\":\"response.function_call_arguments.done\",\"output_index\":0,\"arguments\":\"{\\\"q\\\":\\\"rust\\\"}\"}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hel\"}\n\n",
            "data: {\"type\":\"response.output_text.done\",\"text\":\"Hello\"}\n\n",
            "data: {\"type\":\"response.usage\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2}}\n\n",
            "data: [DONE]\n\n",
        );

        let response = codex_sse_to_responses_json(body).unwrap();
        assert_eq!(response["id"], "resp_1");
        assert_eq!(response["model"], "gpt-5.4");
        assert_eq!(response["status"], "completed");
        assert_eq!(response["usage"]["input_tokens"], 3);
        let output = response["output"].as_array().unwrap();
        assert!(output.iter().any(|item| {
            item["type"] == "reasoning"
                && item["summary"][0]["text"] == Value::String("think".to_string())
        }));
        assert!(output.iter().any(|item| {
            item["type"] == "function_call"
                && item["arguments"] == Value::String("{\"q\":\"rust\"}".to_string())
        }));
        assert!(output.iter().any(|item| {
            item["type"] == "message"
                && item["content"][0]["text"] == Value::String("Hello".to_string())
        }));
    }

    #[test]
    fn sse_bridge_prefers_terminal_response_and_canonicalizes_errors() {
        let completed = concat!(
            "event: response.done\n",
            "data: {\"response\":{\"id\":\"resp_done\",\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"content\":[{\"type\":\"output_text\",\"text\":\"final\"}]}],\"usage\":{\"total_tokens\":9}}}\n\n",
        );
        let response = codex_sse_to_responses_json(completed).unwrap();
        assert_eq!(response["id"], "resp_done");
        assert_eq!(response["output"][0]["content"][0]["text"], "final");
        assert_eq!(response["usage"]["total_tokens"], 9);

        let failed = "data: {\"type\":\"error\",\"error\":{\"code\":\"rate_limit_exceeded\",\"message\":\"sensitive detail\"}}\n\n";
        let response = codex_sse_to_responses_json(failed).unwrap();
        assert_eq!(response["status"], "failed");
        assert_eq!(response["error"]["code"], "rate_limit_exceeded");
        assert!(!response.to_string().contains("sensitive detail"));
    }
}
