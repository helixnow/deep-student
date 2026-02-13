//! 错误详情模块的单元测试

use deep_student_lib::error_details::{
    http_status_to_error_code, infer_error_code_from_message, ActionSuggestion, ErrorCode,
    ErrorDetails, ErrorDetailsBuilder,
};

#[test]
fn test_error_details_creation() {
    let error = ErrorDetails::new(
        ErrorCode::ApiKeyMissing,
        "API key not found".to_string(),
        "请配置API密钥".to_string(),
    );

    assert_eq!(error.code, ErrorCode::ApiKeyMissing);
    assert_eq!(error.message, "API key not found");
    assert_eq!(error.user_message, "请配置API密钥");
    assert!(error.suggestions.is_empty());
    assert!(error.trace_id.is_none());
    assert!(error.context.is_none());
}

#[test]
fn test_error_details_builder_methods() {
    let error = ErrorDetails::new(
        ErrorCode::NetworkTimeout,
        "Request timeout".to_string(),
        "网络请求超时".to_string(),
    )
    .with_suggestion(ActionSuggestion {
        action_type: "retry".to_string(),
        label: "重试".to_string(),
        url: None,
        data: None,
    })
    .with_trace_id("trace_123".to_string())
    .with_context("timeout_ms".to_string(), serde_json::json!(5000));

    assert_eq!(error.suggestions.len(), 1);
    assert_eq!(error.suggestions[0].action_type, "retry");
    assert_eq!(error.trace_id, Some("trace_123".to_string()));
    assert!(error.context.is_some());
    assert_eq!(
        error.context.as_ref().unwrap().get("timeout_ms"),
        Some(&serde_json::json!(5000))
    );
}

#[test]
fn test_error_details_builder_api_key_missing() {
    let error = ErrorDetailsBuilder::api_key_missing("OpenAI");

    assert_eq!(error.code, ErrorCode::ApiKeyMissing);
    assert!(error.message.contains("OpenAI"));
    assert!(error.user_message.contains("OpenAI"));
    assert!(!error.suggestions.is_empty());
    assert_eq!(error.suggestions[0].action_type, "settings");
    assert_eq!(error.suggestions[0].label, "前往设置");
}

#[test]
fn test_error_details_builder_api_key_invalid() {
    let error = ErrorDetailsBuilder::api_key_invalid("SerpAPI");

    assert_eq!(error.code, ErrorCode::ApiKeyInvalid);
    assert!(error.message.contains("SerpAPI"));
    assert_eq!(error.suggestions.len(), 2);

    // 应该有设置和重试两个建议
    let action_types: Vec<&str> = error
        .suggestions
        .iter()
        .map(|s| s.action_type.as_str())
        .collect();
    assert!(action_types.contains(&"settings"));
    assert!(action_types.contains(&"retry"));
}

#[test]
fn test_error_details_builder_network_error() {
    let error = ErrorDetailsBuilder::network_error("Connection refused");

    assert_eq!(error.code, ErrorCode::NetworkUnreachable);
    assert!(error.message.contains("Connection refused"));
    assert_eq!(error.suggestions.len(), 2);

    let action_types: Vec<&str> = error
        .suggestions
        .iter()
        .map(|s| s.action_type.as_str())
        .collect();
    assert!(action_types.contains(&"check_network"));
    assert!(action_types.contains(&"retry"));
}

#[test]
fn test_error_details_builder_rate_limit() {
    let error = ErrorDetailsBuilder::rate_limit_error("Tavily", Some(30));

    assert_eq!(error.code, ErrorCode::RateLimit);
    assert!(error.message.contains("Tavily"));
    assert!(error.user_message.contains("30秒"));
    assert!(!error.suggestions.is_empty());
    assert_eq!(error.suggestions[0].action_type, "retry");

    // 应该包含重试时间上下文
    assert!(error.context.is_some());
    assert_eq!(
        error.context.as_ref().unwrap().get("retry_after_seconds"),
        Some(&serde_json::json!(30))
    );
}

#[test]
fn test_error_details_builder_service_unavailable() {
    let error = ErrorDetailsBuilder::service_unavailable("Bing");

    assert_eq!(error.code, ErrorCode::ServiceUnavailable);
    assert!(error.message.contains("Bing"));
    assert_eq!(error.suggestions.len(), 2);

    let action_types: Vec<&str> = error
        .suggestions
        .iter()
        .map(|s| s.action_type.as_str())
        .collect();
    assert!(action_types.contains(&"retry"));
    assert!(action_types.contains(&"contact_support"));
}

#[test]
fn test_error_details_builder_tool_not_found() {
    let error = ErrorDetailsBuilder::tool_not_found("unknown_tool");

    assert_eq!(error.code, ErrorCode::ToolNotFound);
    assert!(error.message.contains("unknown_tool"));
    assert!(!error.suggestions.is_empty());
    assert_eq!(error.suggestions[0].action_type, "settings");
    assert!(error.suggestions[0].url.as_ref().unwrap().contains("tools"));
}

#[test]
fn test_error_details_builder_tool_timeout() {
    let error = ErrorDetailsBuilder::tool_timeout("web_search", 10000);

    assert_eq!(error.code, ErrorCode::ToolTimeout);
    assert!(error.message.contains("web_search"));
    assert!(error.user_message.contains("10000毫秒"));
    assert!(!error.suggestions.is_empty());
    assert_eq!(error.suggestions[0].action_type, "retry");

    // 应该包含超时时间上下文
    assert!(error.context.is_some());
    assert_eq!(
        error.context.as_ref().unwrap().get("timeout_ms"),
        Some(&serde_json::json!(10000))
    );
}

#[test]
fn test_error_details_builder_parse_error() {
    let error = ErrorDetailsBuilder::parse_error("JSON", "Unexpected token at line 5");

    assert_eq!(error.code, ErrorCode::ParseError);
    assert!(error.message.contains("JSON"));
    assert!(error.message.contains("Unexpected token"));
    assert_eq!(error.suggestions.len(), 2);

    let action_types: Vec<&str> = error
        .suggestions
        .iter()
        .map(|s| s.action_type.as_str())
        .collect();
    assert!(action_types.contains(&"retry"));
    assert!(action_types.contains(&"contact_support"));
}

#[test]
fn test_http_status_to_error_code() {
    assert_eq!(http_status_to_error_code(400), ErrorCode::HttpBadRequest);
    assert_eq!(http_status_to_error_code(401), ErrorCode::HttpUnauthorized);
    assert_eq!(http_status_to_error_code(403), ErrorCode::HttpForbidden);
    assert_eq!(http_status_to_error_code(404), ErrorCode::HttpNotFound);
    assert_eq!(
        http_status_to_error_code(429),
        ErrorCode::HttpTooManyRequests
    );
    assert_eq!(http_status_to_error_code(450), ErrorCode::HttpClientError); // Other 4xx
    assert_eq!(http_status_to_error_code(500), ErrorCode::HttpServerError);
    assert_eq!(http_status_to_error_code(502), ErrorCode::HttpServerError);
    assert_eq!(http_status_to_error_code(200), ErrorCode::Unknown); // Success status
}

#[test]
fn test_infer_error_code_from_message() {
    assert_eq!(
        infer_error_code_from_message("API key is missing"),
        ErrorCode::ApiKeyMissing
    );
    assert_eq!(
        infer_error_code_from_message("Invalid api_key provided"),
        ErrorCode::ApiKeyInvalid
    );
    assert_eq!(
        infer_error_code_from_message("Request timeout occurred"),
        ErrorCode::NetworkTimeout
    );
    assert_eq!(
        infer_error_code_from_message("Network connection failed"),
        ErrorCode::NetworkUnreachable
    );
    assert_eq!(
        infer_error_code_from_message("Too many requests, rate limit exceeded"),
        ErrorCode::RateLimit
    );
    assert_eq!(
        infer_error_code_from_message("Quota exceeded for this month"),
        ErrorCode::QuotaExceeded
    );
    assert_eq!(
        infer_error_code_from_message("Failed to parse JSON response"),
        ErrorCode::ParseError
    );
    assert_eq!(
        infer_error_code_from_message("Tool not found"),
        ErrorCode::ToolNotFound
    );
    assert_eq!(
        infer_error_code_from_message("Tool is disabled"),
        ErrorCode::ToolDisabled
    );
    assert_eq!(
        infer_error_code_from_message("Something went wrong"),
        ErrorCode::Unknown
    );
}

#[test]
fn test_error_details_serialization() {
    let error = ErrorDetailsBuilder::api_key_missing("TestService")
        .with_trace_id("test_trace_123".to_string())
        .with_context("service_type".to_string(), serde_json::json!("search"));

    let json = serde_json::to_string(&error).expect("Failed to serialize error details");
    assert!(json.contains("API_KEY_MISSING"));
    assert!(json.contains("TestService"));
    assert!(json.contains("test_trace_123"));
    assert!(json.contains("service_type"));

    let deserialized: ErrorDetails =
        serde_json::from_str(&json).expect("Failed to deserialize error details");
    assert_eq!(deserialized.code, ErrorCode::ApiKeyMissing);
    assert_eq!(deserialized.trace_id, Some("test_trace_123".to_string()));
}

#[test]
fn test_action_suggestion_serialization() {
    let suggestion = ActionSuggestion {
        action_type: "settings".to_string(),
        label: "检查设置".to_string(),
        url: Some("https://example.com/settings".to_string()),
        data: Some(serde_json::json!({"section": "api_keys"})),
    };

    let json = serde_json::to_string(&suggestion).expect("Failed to serialize action suggestion");
    assert!(json.contains("settings"));
    assert!(json.contains("检查设置"));
    assert!(json.contains("https://example.com/settings"));
    assert!(json.contains("api_keys"));

    let deserialized: ActionSuggestion =
        serde_json::from_str(&json).expect("Failed to deserialize action suggestion");
    assert_eq!(deserialized.action_type, "settings");
    assert_eq!(deserialized.label, "检查设置");
    assert_eq!(
        deserialized.url,
        Some("https://example.com/settings".to_string())
    );
}
