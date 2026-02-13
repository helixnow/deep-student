//! 统一错误详情模块
//!
//! 为工具调用失败提供标准化的错误分类、建议操作和用户友好的错误处理

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// 通用错误代码分类
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ErrorCode {
    // 配置相关错误
    ConfigMissing, // 缺少必要配置
    ConfigInvalid, // 配置格式不正确
    ApiKeyMissing, // API密钥缺失
    ApiKeyInvalid, // API密钥无效

    // 网络相关错误
    NetworkUnreachable,  // 网络不可达
    NetworkTimeout,      // 网络超时
    DnsResolutionFailed, // DNS解析失败

    // HTTP相关错误
    HttpClientError,     // HTTP 4xx错误
    HttpServerError,     // HTTP 5xx错误
    HttpBadRequest,      // HTTP 400
    HttpUnauthorized,    // HTTP 401
    HttpForbidden,       // HTTP 403
    HttpNotFound,        // HTTP 404
    HttpTooManyRequests, // HTTP 429

    // 服务相关错误
    ServiceUnavailable, // 服务不可用
    RateLimit,          // 限流
    QuotaExceeded,      // 配额超限

    // 数据相关错误
    ParseError,      // 解析错误
    ValidationError, // 数据验证失败
    FormatError,     // 格式错误

    // 工具相关错误
    ToolNotFound, // 工具不存在
    ToolDisabled, // 工具被禁用
    ToolTimeout,  // 工具执行超时

    // 其他错误
    InternalError, // 内部错误
    Unknown,       // 未知错误
}

/// 用户操作建议
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActionSuggestion {
    pub action_type: String, // "settings", "retry", "contact_support", "check_network"
    pub label: String,       // 显示给用户的文本
    pub url: Option<String>, // 可选的URL（如设置页面）
    pub data: Option<serde_json::Value>, // 附加数据
}

/// 标准化错误详情
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ErrorDetails {
    pub code: ErrorCode,
    pub message: String,
    pub user_message: String,               // 用户友好的错误消息
    pub suggestions: Vec<ActionSuggestion>, // 建议的操作
    pub trace_id: Option<String>,           // 追踪ID
    pub context: Option<HashMap<String, serde_json::Value>>, // 额外上下文
}

impl ErrorDetails {
    /// 创建新的错误详情
    pub fn new(code: ErrorCode, message: String, user_message: String) -> Self {
        Self {
            code,
            message,
            user_message,
            suggestions: vec![],
            trace_id: None,
            context: None,
        }
    }

    /// 添加操作建议
    pub fn with_suggestion(mut self, suggestion: ActionSuggestion) -> Self {
        self.suggestions.push(suggestion);
        self
    }

    /// 添加追踪ID
    pub fn with_trace_id(mut self, trace_id: String) -> Self {
        self.trace_id = Some(trace_id);
        self
    }

    /// 添加上下文信息
    pub fn with_context(mut self, key: String, value: serde_json::Value) -> Self {
        self.context
            .get_or_insert_with(HashMap::new)
            .insert(key, value);
        self
    }
}

/// 错误详情构建器 - 提供常见错误的快速创建方法
pub struct ErrorDetailsBuilder;

impl ErrorDetailsBuilder {
    /// API密钥缺失错误
    pub fn api_key_missing(service: &str) -> ErrorDetails {
        ErrorDetails::new(
            ErrorCode::ApiKeyMissing,
            format!("{} API密钥未配置", service),
            format!("需要配置{}的API密钥才能使用此功能", service),
        )
        .with_suggestion(ActionSuggestion {
            action_type: "settings".to_string(),
            label: "前往设置".to_string(),
            url: Some("#/settings".to_string()),
            data: Some(serde_json::json!({"section": service.to_lowercase()})),
        })
    }

    /// API密钥无效错误
    pub fn api_key_invalid(service: &str) -> ErrorDetails {
        ErrorDetails::new(
            ErrorCode::ApiKeyInvalid,
            format!("{} API密钥无效或已过期", service),
            format!("{}的API密钥似乎无效，请检查密钥是否正确", service),
        )
        .with_suggestion(ActionSuggestion {
            action_type: "settings".to_string(),
            label: "检查API密钥".to_string(),
            url: Some("#/settings".to_string()),
            data: Some(serde_json::json!({"section": service.to_lowercase()})),
        })
        .with_suggestion(ActionSuggestion {
            action_type: "retry".to_string(),
            label: "重试".to_string(),
            url: None,
            data: None,
        })
    }

    /// 网络连接错误
    pub fn network_error(details: &str) -> ErrorDetails {
        ErrorDetails::new(
            ErrorCode::NetworkUnreachable,
            format!("网络连接失败: {}", details),
            "网络连接出现问题，请检查网络连接后重试".to_string(),
        )
        .with_suggestion(ActionSuggestion {
            action_type: "check_network".to_string(),
            label: "检查网络".to_string(),
            url: None,
            data: None,
        })
        .with_suggestion(ActionSuggestion {
            action_type: "retry".to_string(),
            label: "重试".to_string(),
            url: None,
            data: None,
        })
    }

    /// 限流错误
    pub fn rate_limit_error(service: &str, retry_after: Option<u64>) -> ErrorDetails {
        let message = if let Some(seconds) = retry_after {
            format!("{}请求过于频繁，请等待{}秒后重试", service, seconds)
        } else {
            format!("{}请求过于频繁，请稍后重试", service)
        };

        let mut error =
            ErrorDetails::new(ErrorCode::RateLimit, format!("{} 限流", service), message)
                .with_suggestion(ActionSuggestion {
                    action_type: "retry".to_string(),
                    label: "稍后重试".to_string(),
                    url: None,
                    data: retry_after.map(|s| serde_json::json!({"retry_after": s})),
                });

        if let Some(seconds) = retry_after {
            error = error.with_context(
                "retry_after_seconds".to_string(),
                serde_json::json!(seconds),
            );
        }

        error
    }

    /// 服务不可用错误
    pub fn service_unavailable(service: &str) -> ErrorDetails {
        ErrorDetails::new(
            ErrorCode::ServiceUnavailable,
            format!("{} 服务当前不可用", service),
            format!("{}服务暂时不可用，可能正在维护中", service),
        )
        .with_suggestion(ActionSuggestion {
            action_type: "retry".to_string(),
            label: "稍后重试".to_string(),
            url: None,
            data: None,
        })
        .with_suggestion(ActionSuggestion {
            action_type: "contact_support".to_string(),
            label: "联系支持".to_string(),
            url: None,
            data: Some(serde_json::json!({"service": service})),
        })
    }

    /// 工具不存在错误
    pub fn tool_not_found(tool_name: &str) -> ErrorDetails {
        ErrorDetails::new(
            ErrorCode::ToolNotFound,
            format!("工具 '{}' 不存在", tool_name),
            format!("请求的工具'{}'未找到，可能已被移除或重命名", tool_name),
        )
        .with_suggestion(ActionSuggestion {
            action_type: "settings".to_string(),
            label: "查看可用工具".to_string(),
            url: Some("#/settings/tools".to_string()),
            data: None,
        })
    }

    /// 工具超时错误
    pub fn tool_timeout(tool_name: &str, timeout_ms: u64) -> ErrorDetails {
        ErrorDetails::new(
            ErrorCode::ToolTimeout,
            format!("工具 '{}' 执行超时", tool_name),
            format!("工具执行时间超过{}毫秒限制", timeout_ms),
        )
        .with_suggestion(ActionSuggestion {
            action_type: "retry".to_string(),
            label: "重试".to_string(),
            url: None,
            data: None,
        })
        .with_context("timeout_ms".to_string(), serde_json::json!(timeout_ms))
    }

    /// 通用解析错误
    pub fn parse_error(content_type: &str, details: &str) -> ErrorDetails {
        ErrorDetails::new(
            ErrorCode::ParseError,
            format!("解析{}失败: {}", content_type, details),
            format!("服务返回的数据格式异常，无法正确解析"),
        )
        .with_suggestion(ActionSuggestion {
            action_type: "retry".to_string(),
            label: "重试".to_string(),
            url: None,
            data: None,
        })
        .with_suggestion(ActionSuggestion {
            action_type: "contact_support".to_string(),
            label: "报告问题".to_string(),
            url: None,
            data: Some(
                serde_json::json!({"error_type": "parse_error", "content_type": content_type}),
            ),
        })
    }
}

/// 从HTTP状态码转换为错误代码
pub fn http_status_to_error_code(status: u16) -> ErrorCode {
    match status {
        400 => ErrorCode::HttpBadRequest,
        401 => ErrorCode::HttpUnauthorized,
        403 => ErrorCode::HttpForbidden,
        404 => ErrorCode::HttpNotFound,
        429 => ErrorCode::HttpTooManyRequests,
        400..=499 => ErrorCode::HttpClientError,
        500..=599 => ErrorCode::HttpServerError,
        _ => ErrorCode::Unknown,
    }
}

/// 从错误字符串推断错误类型（简单的启发式方法）
pub fn infer_error_code_from_message(message: &str) -> ErrorCode {
    let message_lower = message.to_lowercase();

    if message_lower.contains("api key") || message_lower.contains("api_key") {
        if message_lower.contains("missing") || message_lower.contains("not found") {
            ErrorCode::ApiKeyMissing
        } else {
            ErrorCode::ApiKeyInvalid
        }
    } else if message_lower.contains("timeout") {
        ErrorCode::NetworkTimeout
    } else if message_lower.contains("network") || message_lower.contains("connection") {
        ErrorCode::NetworkUnreachable
    } else if message_lower.contains("rate limit") || message_lower.contains("too many requests") {
        ErrorCode::RateLimit
    } else if message_lower.contains("quota") {
        ErrorCode::QuotaExceeded
    } else if message_lower.contains("parse") || message_lower.contains("json") {
        ErrorCode::ParseError
    } else if message_lower.contains("not found") {
        ErrorCode::ToolNotFound
    } else if message_lower.contains("disabled") {
        ErrorCode::ToolDisabled
    } else {
        ErrorCode::Unknown
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_error_details_builder() {
        let error = ErrorDetailsBuilder::api_key_missing("OpenAI");
        assert_eq!(error.code, ErrorCode::ApiKeyMissing);
        assert!(!error.suggestions.is_empty());
        assert_eq!(error.suggestions[0].action_type, "settings");
    }

    #[test]
    fn test_http_status_conversion() {
        assert_eq!(http_status_to_error_code(401), ErrorCode::HttpUnauthorized);
        assert_eq!(
            http_status_to_error_code(429),
            ErrorCode::HttpTooManyRequests
        );
        assert_eq!(http_status_to_error_code(500), ErrorCode::HttpServerError);
    }

    #[test]
    fn test_error_inference() {
        assert_eq!(
            infer_error_code_from_message("API key is missing"),
            ErrorCode::ApiKeyMissing
        );
        assert_eq!(
            infer_error_code_from_message("Request timeout"),
            ErrorCode::NetworkTimeout
        );
        assert_eq!(
            infer_error_code_from_message("Too many requests"),
            ErrorCode::RateLimit
        );
    }
}
