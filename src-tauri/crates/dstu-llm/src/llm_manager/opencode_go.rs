//! OpenCode Go 订阅接入（https://opencode.ai/docs/go/）。
//!
//! OpenCode Go 是面向「OpenCode 及产生同类请求的编程 agent」的订阅网关。官方对第三方
//! 客户端的要求（2026-10 核对）：
//! 1. 只发送典型的 agent 流量；
//! 2. 用自己的 User-Agent 标识身份（不得冒充浏览器、SDK 或 OpenCode）；
//! 3. 每个会话携带稳定的 `x-opencode-session`。
//!
//! 本项目据此约束：
//! - **只允许 Agent 对话**（chat_v2 主对话、子代理会话，以及该会话自身的标题生成与上下文
//!   压缩）使用 OpenCode Go。请求准备处默认拒绝，只有显式携带 Agent 会话的入口放行，见
//!   `LLMManager::prepare_agent_provider_request`；定时自动化（headless）、OCR、制卡、
//!   翻译、批改、embedding 等一律拒绝；模型 fallback 也不会把后台任务切到 OpenCode Go。
//! - 请求头使用 `DeepStudent/<版本>`，不附带浏览器伪装的 UA / Origin / Referer。
//! - 连接测试只调用公开的用量接口，不发推理请求；额度只读公开的
//!   `GET /zen/go/v1/usage`，不使用未公开的 Console 接口。

use chrono::DateTime;
use reqwest::Client;
use serde::Serialize;
use serde_json::Value;

use super::ApiConfig;

pub const VENDOR_ID: &str = "builtin-opencode-go";
pub const PROVIDER_TYPE: &str = "opencode_go";

/// OpenAI 兼容端点根（Chat Completions 与 Responses 共用）。
pub(crate) const OPENAI_BASE_URL: &str = "https://opencode.ai/inference/go/openai/v1";
/// Anthropic Messages 端点根（适配器在 `/v1` 后追加 `/messages`）。
pub(crate) const ANTHROPIC_BASE_URL: &str = "https://opencode.ai/inference/go/anthropic/v1";
/// Google generateContent 端点根（Gemini 转换器会剥离尾部版本段再按配置拼接）。
pub(crate) const GOOGLE_BASE_URL: &str = "https://opencode.ai/inference/go/google/v1beta";
/// 公开的用量接口：返回 5 小时 / 周 / 月三个窗口的已用百分比与重置时间。
pub(crate) const USAGE_URL: &str = "https://opencode.ai/zen/go/v1/usage";

pub(crate) const SESSION_HEADER: &str = "x-opencode-session";
/// 用量查询与连接测试使用的固定会话标识（不是对话流量）。
pub(crate) const USAGE_SESSION_ID: &str = "deepstudent-usage";

const SESSION_HEADER_MAX_LEN: usize = 128;

/// 非 Agent 对话（用户手动把 Go 配给制卡、翻译、自动化等功能）且调用方没有会话标识时使用的会话标识。
/// Go 只“建议”用于 Agent 对话，不再拒绝其他用途。
pub(crate) const TASK_SESSION_ID: &str = "deepstudent-task";

/// 身份标识：`DeepStudent/<版本>`。
pub(crate) fn user_agent() -> String {
    format!("DeepStudent/{}", dstu_core::APP_VERSION)
}

fn is_go_root_url(base_url: &str) -> bool {
    let Ok(url) = url::Url::parse(base_url.trim()) else {
        return false;
    };
    if !url
        .host_str()
        .is_some_and(|host| host.eq_ignore_ascii_case("opencode.ai"))
    {
        return false;
    }
    let path = url.path().trim_end_matches('/');
    path.starts_with("/inference/go") || path.starts_with("/zen/go")
}

/// 该配置是否指向 OpenCode Go：供应商 ID、供应商类型或端点任一命中即视为 Go。
///
/// 端点判定覆盖用户把 Go 的地址填进自定义供应商的情况，保证门控不被绕过。
pub fn is_opencode_go_config(config: &ApiConfig) -> bool {
    config.vendor_id.as_deref() == Some(VENDOR_ID)
        || config
            .provider_type
            .as_deref()
            .is_some_and(|provider| provider.eq_ignore_ascii_case(PROVIDER_TYPE))
        || is_go_root_url(&config.base_url)
}

/// 按生效协议选择 OpenCode Go 的端点根。
///
/// 只改写官方 Go 根地址；用户自定义的其他地址原样保留。
pub(crate) fn base_url_for_protocol(current_base_url: &str, effective_protocol: &str) -> String {
    if !is_go_root_url(current_base_url) {
        return current_base_url.to_string();
    }
    match effective_protocol {
        "anthropic_messages" => ANTHROPIC_BASE_URL,
        "google_generate_content" => GOOGLE_BASE_URL,
        _ => OPENAI_BASE_URL,
    }
    .to_string()
}

/// `x-opencode-session` 的值：只保留安全字符并限长，空值回落到 `None`。
pub(crate) fn session_header_value(session_id: &str) -> Option<String> {
    let sanitized: String = session_id
        .trim()
        .chars()
        .filter(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.' | ':'))
        .take(SESSION_HEADER_MAX_LEN)
        .collect();
    (!sanitized.is_empty()).then_some(sanitized)
}

/// OpenCode Go 请求必须携带的身份头。
pub(crate) fn identity_headers(session_id: &str) -> Vec<(String, String)> {
    let mut headers = vec![("User-Agent".to_string(), user_agent())];
    if let Some(session) = session_header_value(session_id) {
        headers.push((SESSION_HEADER.to_string(), session));
    }
    headers
}

// ============================================================================
// 内置模型
// ============================================================================

/// 内置的 OpenCode Go 模型（与官方端点表对齐，2026-10-31 核对）。
///
/// 未内置：Muse Spark / Iceman 等 Contributor 型号（官方说明其数据可用于训练），以及
/// 限时免费型号。用户仍可在供应商下手动添加，协议需按官方端点表选择。
pub struct GoBuiltinModel {
    pub id: &'static str,
    pub label: &'static str,
    pub model: &'static str,
    pub protocol: &'static str,
    pub is_multimodal: bool,
    pub is_reasoning: bool,
    pub max_output_tokens: u32,
}

const fn go_model(
    id: &'static str,
    label: &'static str,
    model: &'static str,
    protocol: &'static str,
    is_multimodal: bool,
    is_reasoning: bool,
) -> GoBuiltinModel {
    GoBuiltinModel {
        id,
        label,
        model,
        protocol,
        is_multimodal,
        is_reasoning,
        max_output_tokens: 32_768,
    }
}

const CHAT: &str = "openai_chat_completions";
const RESPONSES: &str = "openai_responses";
const MESSAGES: &str = "anthropic_messages";
const GOOGLE: &str = "google_generate_content";

pub const BUILTIN_MODELS: &[GoBuiltinModel] = &[
    go_model(
        "builtin-opencode-go-deepseek-v4.1-flash",
        "DeepSeek V4.1 Flash (Go)",
        "deepseek-v4.1-flash",
        CHAT,
        true,
        false,
    ),
    go_model(
        "builtin-opencode-go-deepseek-v4-pro",
        "DeepSeek V4 Pro (Go)",
        "deepseek-v4-pro",
        CHAT,
        false,
        false,
    ),
    go_model(
        "builtin-opencode-go-glm-5.3",
        "GLM-5.3 (Go)",
        "glm-5.3",
        CHAT,
        false,
        false,
    ),
    go_model(
        "builtin-opencode-go-glm-5.3-flash",
        "GLM-5.3-Flash (Go)",
        "glm-5.3-flash",
        CHAT,
        false,
        false,
    ),
    go_model(
        "builtin-opencode-go-kimi-k3",
        "Kimi K3 (Go)",
        "kimi-k3",
        CHAT,
        false,
        false,
    ),
    go_model(
        "builtin-opencode-go-kimi-k3.1-pro",
        "Kimi K3.1 Pro (Go)",
        "kimi-k3.1-pro",
        CHAT,
        false,
        false,
    ),
    go_model(
        "builtin-opencode-go-mimo-v2.6-pro",
        "MiMo-V2.6-Pro (Go)",
        "mimo-v2.6-pro",
        CHAT,
        false,
        false,
    ),
    go_model(
        "builtin-opencode-go-qwen3.8-max",
        "Qwen3.8 Max (Go)",
        "qwen3.8-max",
        MESSAGES,
        false,
        false,
    ),
    go_model(
        "builtin-opencode-go-qwen3.8-flash",
        "Qwen3.8 Flash (Go)",
        "qwen3.8-flash",
        MESSAGES,
        false,
        false,
    ),
    go_model(
        "builtin-opencode-go-minimax-m3",
        "MiniMax M3 (Go)",
        "minimax-m3",
        MESSAGES,
        false,
        false,
    ),
    go_model(
        "builtin-opencode-go-claude-haiku-5-5",
        "Claude Haiku 5.5 (Go)",
        "claude-haiku-5-5",
        MESSAGES,
        true,
        true,
    ),
    go_model(
        "builtin-opencode-go-gpt-6-luna",
        "GPT 6 Luna (Go)",
        "gpt-6-luna",
        RESPONSES,
        true,
        true,
    ),
    go_model(
        "builtin-opencode-go-gemini-4-argon",
        "Gemini 4 Argon (Go)",
        "gemini-4-argon",
        GOOGLE,
        true,
        false,
    ),
];

/// 协议对应的请求方言适配器（`model_adapter`）。
pub(crate) fn model_adapter_for_protocol(protocol: &str) -> &'static str {
    match protocol {
        MESSAGES => "anthropic",
        GOOGLE => "google",
        _ => "general",
    }
}

// ============================================================================
// 用量（公开接口）
// ============================================================================

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeGoUsageWindow {
    /// `five_hour` / `weekly` / `monthly`
    pub window: String,
    pub used_percent: f64,
    /// 毫秒时间戳；接口未给出或无法解析时为 None。
    pub resets_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenCodeGoUsage {
    pub windows: Vec<OpenCodeGoUsageWindow>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum OpenCodeGoUsageError {
    /// 401 + `api_key_expired`
    KeyExpired,
    /// 其他 401 / 403：密钥无效或该工作区没有 Go 订阅
    Unauthorized,
    Http(u16),
    Network(String),
    Malformed,
}

impl OpenCodeGoUsageError {
    /// 与连接测试的失败分类保持一致。
    pub fn category(&self) -> &'static str {
        match self {
            Self::KeyExpired | Self::Unauthorized => "auth",
            Self::Http(status) if *status == 429 => "rate_limit",
            Self::Http(status) if *status >= 500 => "server",
            Self::Http(_) => "provider_error",
            Self::Network(_) => "network",
            Self::Malformed => "format",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::KeyExpired => {
                "OpenCode Go API Key 已过期，请在 OpenCode Console 重新生成后填入".to_string()
            }
            Self::Unauthorized => {
                "OpenCode Go 鉴权失败：API Key 无效，或该账号没有有效的 Go 订阅".to_string()
            }
            Self::Http(status) => format!("OpenCode Go 用量接口返回 HTTP {status}"),
            Self::Network(error) => format!("无法连接 OpenCode Go：{error}"),
            Self::Malformed => "OpenCode Go 用量数据无法解析".to_string(),
        }
    }
}

fn value_as_f64(value: &Value) -> Option<f64> {
    match value {
        Value::Number(number) => number.as_f64(),
        Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
    .filter(|number| number.is_finite())
}

/// 重置时间：ISO 8601 字符串，或秒 / 毫秒时间戳。
fn value_as_timestamp_ms(value: &Value) -> Option<i64> {
    if let Some(text) = value.as_str() {
        if let Ok(parsed) = DateTime::parse_from_rfc3339(text.trim()) {
            return Some(parsed.timestamp_millis());
        }
    }
    let raw = value_as_f64(value)?;
    let millis = if raw < 1_000_000_000_000.0 {
        raw * 1000.0
    } else {
        raw
    };
    Some(millis as i64)
}

pub(crate) fn parse_usage(payload: &Value) -> Result<OpenCodeGoUsage, OpenCodeGoUsageError> {
    let usage = payload
        .get("usage")
        .and_then(Value::as_object)
        .ok_or(OpenCodeGoUsageError::Malformed)?;
    let mut windows = Vec::new();
    for (window, key) in [
        ("five_hour", "rolling"),
        ("weekly", "weekly"),
        ("monthly", "monthly"),
    ] {
        let Some(entry) = usage.get(key) else {
            continue;
        };
        // 单个窗口损坏只丢弃该窗口，不影响其余窗口。
        let Some(percent) = entry.get("percent").and_then(value_as_f64) else {
            continue;
        };
        windows.push(OpenCodeGoUsageWindow {
            window: window.to_string(),
            used_percent: percent.clamp(0.0, 100.0),
            resets_at_ms: entry.get("resetsAt").and_then(value_as_timestamp_ms),
        });
    }
    if windows.is_empty() {
        return Err(OpenCodeGoUsageError::Malformed);
    }
    Ok(OpenCodeGoUsage { windows })
}

fn is_key_expired_body(body: &Value) -> bool {
    body.pointer("/error/code").and_then(Value::as_str) == Some("api_key_expired")
}

/// 查询订阅用量。同时用作连接测试：只读、不消耗额度、不产生推理流量。
pub async fn fetch_usage(
    client: &Client,
    api_key: &str,
) -> Result<OpenCodeGoUsage, OpenCodeGoUsageError> {
    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err(OpenCodeGoUsageError::Unauthorized);
    }
    let response = client
        .get(USAGE_URL)
        .header("Accept", "application/json")
        .header("User-Agent", user_agent())
        .header(SESSION_HEADER, USAGE_SESSION_ID)
        .bearer_auth(api_key)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|error| OpenCodeGoUsageError::Network(error.without_url().to_string()))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or(Value::Null);
    if status.as_u16() == 401 && is_key_expired_body(&body) {
        return Err(OpenCodeGoUsageError::KeyExpired);
    }
    if matches!(status.as_u16(), 401 | 403) {
        return Err(OpenCodeGoUsageError::Unauthorized);
    }
    if !status.is_success() {
        return Err(OpenCodeGoUsageError::Http(status.as_u16()));
    }
    parse_usage(&body)
}

/// 用于 `fetch_usage` 的 HTTP 客户端：不跟随重定向，避免 Bearer 被转发到其他源。
pub fn usage_client() -> Result<Client, OpenCodeGoUsageError> {
    Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|error| OpenCodeGoUsageError::Network(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn config(vendor_id: Option<&str>, provider_type: Option<&str>, base_url: &str) -> ApiConfig {
        ApiConfig {
            vendor_id: vendor_id.map(str::to_string),
            provider_type: provider_type.map(str::to_string),
            base_url: base_url.to_string(),
            ..Default::default()
        }
    }

    #[test]
    fn detects_go_by_vendor_provider_or_endpoint() {
        assert!(is_opencode_go_config(&config(
            Some(VENDOR_ID),
            None,
            "https://example.com/v1"
        )));
        assert!(is_opencode_go_config(&config(
            None,
            Some("opencode_go"),
            "https://example.com/v1"
        )));
        // 自定义供应商填了 Go 地址也必须被识别，门控不能被绕过。
        assert!(is_opencode_go_config(&config(
            Some("custom-1"),
            Some("openai"),
            "https://opencode.ai/inference/go/openai/v1/"
        )));
        assert!(is_opencode_go_config(&config(
            None,
            None,
            "https://OpenCode.ai/zen/go/v1"
        )));
        assert!(!is_opencode_go_config(&config(
            Some("builtin-deepseek"),
            Some("deepseek"),
            "https://api.deepseek.com/v1"
        )));
        // Zen（按量付费）不是 Go 订阅。
        assert!(!is_opencode_go_config(&config(
            None,
            Some("openai"),
            "https://opencode.ai/zen/v1"
        )));
    }

    #[test]
    fn maps_base_url_by_protocol_only_for_go_roots() {
        assert_eq!(
            base_url_for_protocol(OPENAI_BASE_URL, "anthropic_messages"),
            ANTHROPIC_BASE_URL
        );
        assert_eq!(
            base_url_for_protocol(OPENAI_BASE_URL, "google_generate_content"),
            GOOGLE_BASE_URL
        );
        assert_eq!(
            base_url_for_protocol(ANTHROPIC_BASE_URL, "openai_responses"),
            OPENAI_BASE_URL
        );
        assert_eq!(
            base_url_for_protocol(OPENAI_BASE_URL, "openai_chat_completions"),
            OPENAI_BASE_URL
        );
        assert_eq!(
            base_url_for_protocol("https://proxy.example.com/v1", "anthropic_messages"),
            "https://proxy.example.com/v1"
        );
    }

    #[test]
    fn identity_headers_use_own_user_agent_and_session() {
        let headers = identity_headers("sess_01HX-abc");
        assert_eq!(
            headers[0],
            (
                "User-Agent".to_string(),
                format!("DeepStudent/{}", dstu_core::APP_VERSION)
            )
        );
        assert_eq!(
            headers[1],
            (SESSION_HEADER.to_string(), "sess_01HX-abc".to_string())
        );
        assert!(!headers[0].1.contains("Mozilla"));
    }

    #[test]
    fn session_header_is_sanitized_and_bounded() {
        assert_eq!(
            session_header_value(" a b\r\nc/d "),
            Some("abcd".to_string())
        );
        assert_eq!(session_header_value("  "), None);
        assert_eq!(
            session_header_value(&"x".repeat(500)).map(|value| value.len()),
            Some(SESSION_HEADER_MAX_LEN)
        );
    }

    #[test]
    fn builtin_models_keep_official_ids_and_protocols() {
        for model in BUILTIN_MODELS {
            assert!(model.id.starts_with("builtin-opencode-go-"));
            assert!(matches!(
                model.protocol,
                "openai_chat_completions"
                    | "openai_responses"
                    | "anthropic_messages"
                    | "google_generate_content"
            ));
            // 模型 ID 原样透传（第三方客户端曾因把 `.` 改成 `-` 被拒）。
            assert!(!model.model.contains("contributor"));
        }
        let ids: std::collections::HashSet<_> = BUILTIN_MODELS.iter().map(|m| m.id).collect();
        assert_eq!(ids.len(), BUILTIN_MODELS.len());
        assert!(BUILTIN_MODELS
            .iter()
            .any(|m| m.model == "deepseek-v4.1-flash" && m.protocol == CHAT));
        assert!(BUILTIN_MODELS
            .iter()
            .any(|m| m.model == "qwen3.8-max" && m.protocol == MESSAGES));
    }

    /// 内置模型必须与官网生成的额度表一致（ID 存在且协议相同、非训练型号）。
    #[test]
    fn builtin_models_match_official_plans_table() {
        let plans: Value = serde_json::from_str(include_str!(
            "../../../../../scripts/opencode-go-plans.json"
        ))
        .expect("plans json");
        let models = plans["models"].as_array().expect("models");
        for builtin in BUILTIN_MODELS {
            let official = models
                .iter()
                .find(|model| model["id"] == builtin.model)
                .unwrap_or_else(|| panic!("{} 不在官方额度表中", builtin.model));
            assert_eq!(official["protocol"], builtin.protocol, "{}", builtin.model);
            assert_eq!(
                official["training_permitted"], false,
                "{} 允许训练，不应内置",
                builtin.model
            );
            assert!(
                official["monthly_limit_usd"]["go"].is_number(),
                "{} 应为付费额度型号",
                builtin.model
            );
        }
    }

    #[test]
    fn parses_usage_windows() {
        let usage = parse_usage(&json!({
            "usage": {
                "rolling": {"percent": 12, "resetsAt": "2026-10-31T12:00:00Z"},
                "weekly": {"percent": "40.5", "resetsAt": 1_793_000_000},
                "monthly": {"percent": 140, "resetsAt": 1_793_000_000_000_i64}
            }
        }))
        .unwrap();
        assert_eq!(usage.windows.len(), 3);
        assert_eq!(usage.windows[0].window, "five_hour");
        assert_eq!(usage.windows[0].used_percent, 12.0);
        assert_eq!(
            usage.windows[0].resets_at_ms,
            Some(
                DateTime::parse_from_rfc3339("2026-10-31T12:00:00Z")
                    .unwrap()
                    .timestamp_millis()
            )
        );
        assert_eq!(usage.windows[1].used_percent, 40.5);
        assert_eq!(usage.windows[1].resets_at_ms, Some(1_793_000_000_000));
        assert_eq!(usage.windows[2].used_percent, 100.0);
        assert_eq!(usage.windows[2].resets_at_ms, Some(1_793_000_000_000));
    }

    #[test]
    fn usage_drops_only_broken_windows() {
        let usage = parse_usage(&json!({
            "usage": {"rolling": {"percent": "n/a"}, "weekly": {"percent": 3}}
        }))
        .unwrap();
        assert_eq!(usage.windows.len(), 1);
        assert_eq!(usage.windows[0].window, "weekly");
        assert_eq!(usage.windows[0].resets_at_ms, None);
        assert_eq!(
            parse_usage(&json!({"usage": {}})),
            Err(OpenCodeGoUsageError::Malformed)
        );
        assert_eq!(
            parse_usage(&json!({})),
            Err(OpenCodeGoUsageError::Malformed)
        );
    }

    #[test]
    fn recognizes_expired_key_body() {
        assert!(is_key_expired_body(
            &json!({"error": {"code": "api_key_expired"}})
        ));
        assert!(!is_key_expired_body(&json!({"error": {"code": "invalid"}})));
    }
}
