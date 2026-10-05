use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::multipart::{Form, Part};
use reqwest::{Client, RequestBuilder};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

use crate::commands::AppState;
use crate::llm_manager::{ApiConfig, LLMManager};
use crate::llm_usage::{CallerType, UsageRecord};
use crate::models::{AppError, AppErrorType};

type Result<T> = std::result::Result<T, AppError>;

pub(crate) const DEFAULT_PROVIDER_ID: &str = "siliconflow";
pub(crate) const DEFAULT_SILICONFLOW_BASE_URL: &str = "https://api.siliconflow.cn/v1";
/// 未分配 ASR 模型时的默认转写模型（硅基流动托管的开源 Qwen3-ASR）
pub(crate) const DEFAULT_SILICONFLOW_MODEL: &str = "Qwen/Qwen3-ASR-1.7B";
/// 硅基流动已下架、由默认模型接替的 ASR 模型（旧版一键分配会把它写进 ASR 槽位）
const RETIRED_SILICONFLOW_ASR_MODELS: &[&str] = &["TeleAI/TeleSpeechASR"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct VoiceInputAsrCapability {
    pub provider_id: String,
    pub provider_name: String,
    pub model: String,
    pub configured: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInputTranscribeRequest {
    pub audio_base64: String,
    pub mime_type: String,
    pub provider_id: Option<String>,
    pub model: Option<String>,
    pub config_id: Option<String>,
    pub language: Option<String>,
    pub prompt: Option<String>,
    pub duration_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceInputTranscribeResponse {
    pub text: String,
    pub language: Option<String>,
    pub duration_ms: Option<u64>,
    pub provider_id: String,
    pub model: String,
}

#[derive(Debug, Deserialize)]
struct TranscriptionResponse {
    text: Option<String>,
    language: Option<String>,
}

/// 受管 ASR 的接口形态
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum AsrProtocol {
    /// OpenAI `/audio/transcriptions`（multipart）：硅基流动、OpenAI、vLLM 部署的开源模型、中转站
    Transcriptions,
    /// 百炼 `qwen3-asr-flash`：OpenAI 兼容 `/chat/completions` + `input_audio`
    ChatInputAudio,
}

/// 一次受管 ASR 调用的目标：用分配模型所属供应商自己的 base_url / key
#[derive(Debug, Clone)]
pub(crate) struct AsrEndpoint {
    pub provider_id: String,
    pub provider_name: String,
    pub base_url: String,
    pub api_key: String,
    pub model: String,
    pub config_id: Option<String>,
    pub headers: Vec<(String, String)>,
    pub protocol: AsrProtocol,
}

/// ASR 槽位解析失败（code 与前端语音输入的错误码对齐）
#[derive(Debug, Clone)]
pub(crate) struct AsrConfigError {
    pub code: &'static str,
    pub message: String,
    pub provider_id: String,
    pub model: String,
}

impl AsrConfigError {
    fn new(code: &'static str, message: impl Into<String>, provider_id: &str, model: &str) -> Self {
        Self {
            code,
            message: message.into(),
            provider_id: provider_id.to_string(),
            model: model.to_string(),
        }
    }

    fn into_app_error(self) -> AppError {
        let error_type = match self.code {
            "settings-required" => AppErrorType::Configuration,
            _ => AppErrorType::Validation,
        };
        voice_input_error(error_type, self.code, self.message)
    }
}

impl std::fmt::Display for AsrConfigError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.message)
    }
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|v| !v.is_empty())
}

fn is_masked_secret(value: &str) -> bool {
    let value = value.trim();
    value.is_empty() || value.chars().all(|c| c == '*')
}

/// 剥离「网关 slug_」前缀（与前端 `modelIdPrefix.ts::stripGatewayPrefix` 同一规则）
pub(crate) fn strip_gateway_prefix(model_id: &str) -> &str {
    let trimmed = model_id.trim();
    let segment = trimmed.rsplit('/').next().unwrap_or(trimmed);
    let Some(idx) = segment.find('_') else {
        return segment;
    };
    if idx == 0 {
        return segment;
    }
    let (prefix, rest) = (&segment[..idx], &segment[idx + 1..]);
    if !prefix.contains('-')
        || !rest.contains(['-', '.'])
        || !rest.chars().any(|c| c.is_ascii_alphabetic())
    {
        return segment;
    }
    rest
}

fn is_name_separator(c: char) -> bool {
    c.is_whitespace() || matches!(c, '/' | '_' | '.' | ':' | '-')
}

/// 记号后面是结尾 / 分隔符 / 版本号（含 v 前缀）
fn token_tail_ok(rest: &str) -> bool {
    let mut chars = rest.chars();
    match chars.next() {
        None => true,
        Some(c) if is_name_separator(c) || c.is_ascii_digit() => true,
        Some('v') => chars.next().is_some_and(|c| c.is_ascii_digit()),
        _ => false,
    }
}

/// 名称是否是语音识别（ASR）模型。
/// 与前端 `modelIdPrefix.ts` 的 `ASR_SIGNAL_REGEX` / `ASR_EXCLUDED_REGEX` 保持同一口径。
pub(crate) fn is_asr_model_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    let normalized = lower.replace(['_', '/'], "-");
    if lower.contains("tts")
        || normalized.contains("text-to-speech")
        || normalized.contains("speech-synthesis")
        || normalized.contains("speech-generation")
    {
        return false;
    }
    let leading_ok = |i: usize| {
        lower[..i]
            .chars()
            .next_back()
            .map_or(true, is_name_separator)
    };
    let asr = lower
        .match_indices("asr")
        .any(|(i, t)| token_tail_ok(&lower[i + t.len()..]));
    let stt = lower
        .match_indices("stt")
        .any(|(i, t)| leading_ok(i) && token_tail_ok(&lower[i + t.len()..]));
    let scribe = lower.match_indices("scribe").any(|(i, t)| {
        leading_ok(i)
            && lower[i + t.len()..]
                .chars()
                .next()
                .map_or(true, is_name_separator)
    });
    asr || stt
        || scribe
        || ["transcrib", "whisper", "sensevoice", "paraformer"]
            .iter()
            .any(|needle| lower.contains(needle))
        || normalized.contains("speech-to-text")
}

/// 模型（ID 或显示名）是否是 ASR 模型；模型 ID 先剥网关前缀
pub(crate) fn is_asr_model(model: &str, display_name: &str) -> bool {
    is_asr_model_name(strip_gateway_prefix(model)) || is_asr_model_name(display_name)
}

/// 供应商是否提供 OpenAI 兼容的 ASR 接口（Anthropic / Gemini 原生 / Codex 账号没有）
pub(crate) fn asr_provider_supported(
    provider_id: Option<&str>,
    api_protocol: Option<&str>,
) -> bool {
    let provider = provider_id.map(|p| p.trim().to_ascii_lowercase());
    if matches!(
        provider.as_deref(),
        Some("anthropic" | "gemini" | "google" | "openai_codex")
    ) {
        return false;
    }
    !matches!(
        api_protocol.map(str::trim),
        Some("anthropic_messages" | "google_generate_content")
    )
}

/// 按模型名判定接口形态；只提供实时流 / 异步文件转写接口的模型返回 Err
pub(crate) fn asr_protocol_for_model(model: &str) -> std::result::Result<AsrProtocol, String> {
    let name = strip_gateway_prefix(model).to_ascii_lowercase();
    let unsupported = if name.contains("realtime") || name.contains("streaming") {
        Some("实时流式（WebSocket）")
    } else if name.contains("filetrans") {
        Some("异步文件转写")
    } else {
        None
    };
    if let Some(kind) = unsupported {
        return Err(format!(
            "{} 只提供{}接口，应用内转写需要普通 HTTP 识别接口（如 qwen3-asr-flash、Qwen/Qwen3-ASR-1.7B）",
            model.trim(),
            kind
        ));
    }
    if name.contains("qwen3-asr-flash") {
        Ok(AsrProtocol::ChatInputAudio)
    } else {
        Ok(AsrProtocol::Transcriptions)
    }
}

fn config_provider_id(cfg: &ApiConfig) -> String {
    cfg.provider_scope
        .as_deref()
        .or(cfg.provider_type.as_deref())
        .map(|p| p.trim().to_ascii_lowercase())
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| "custom".to_string())
}

fn passthrough_headers(cfg: &ApiConfig) -> Vec<(String, String)> {
    let Some(headers) = cfg.headers.as_ref() else {
        return Vec::new();
    };
    headers
        .iter()
        .filter(|(name, value)| {
            !name.eq_ignore_ascii_case("authorization")
                && !name.eq_ignore_ascii_case("content-type")
                && HeaderName::from_bytes(name.as_bytes()).is_ok()
                && HeaderValue::from_str(value).is_ok()
        })
        .map(|(name, value)| (name.clone(), value.clone()))
        .collect()
}

impl AsrEndpoint {
    pub(crate) fn new(
        provider_id: &str,
        provider_name: &str,
        base_url: &str,
        api_key: &str,
        model: &str,
        config_id: Option<String>,
    ) -> std::result::Result<Self, AsrConfigError> {
        let model = model.trim();
        let protocol = asr_protocol_for_model(model).map_err(|message| {
            AsrConfigError::new("provider-unavailable", message, provider_id, model)
        })?;
        Ok(Self {
            provider_id: provider_id.to_string(),
            provider_name: provider_name.to_string(),
            base_url: base_url.trim().to_string(),
            api_key: api_key.trim().to_string(),
            model: model.to_string(),
            config_id,
            headers: Vec::new(),
            protocol,
        })
    }

    /// 硅基流动默认端点：用户的 SiliconFlow Key 优先，其次内置 Key
    pub(crate) fn siliconflow_default(
        database: &crate::database::Database,
        model: Option<&str>,
    ) -> std::result::Result<Self, AsrConfigError> {
        let model = non_empty(model).unwrap_or(DEFAULT_SILICONFLOW_MODEL);
        let api_key = resolve_asr_api_key(database).ok_or_else(|| {
            AsrConfigError::new(
                "settings-required",
                "未配置语音识别：请在「设置 → 模型分配」选择语音识别（ASR）模型，或填写 SiliconFlow API Key 使用默认模型",
                DEFAULT_PROVIDER_ID,
                model,
            )
        })?;
        Self::new(
            DEFAULT_PROVIDER_ID,
            "SiliconFlow",
            DEFAULT_SILICONFLOW_BASE_URL,
            &api_key,
            model,
            None,
        )
    }

    /// 已分配的模型配置：任何 OpenAI 兼容供应商（含中转站）都用它自己的 base_url / key
    pub(crate) fn from_api_config(
        cfg: &ApiConfig,
        database: &crate::database::Database,
    ) -> std::result::Result<Self, AsrConfigError> {
        let provider_id = config_provider_id(cfg);
        let is_siliconflow =
            provider_id == DEFAULT_PROVIDER_ID || cfg.base_url.contains("siliconflow");
        let model = match cfg.model.trim() {
            retired if is_siliconflow && RETIRED_SILICONFLOW_ASR_MODELS.contains(&retired) => {
                DEFAULT_SILICONFLOW_MODEL
            }
            model => model,
        };
        if !asr_provider_supported(Some(&provider_id), cfg.api_protocol.as_deref()) {
            return Err(AsrConfigError::new(
                "provider-unavailable",
                format!(
                    "供应商 {} 没有 OpenAI 兼容的语音识别接口，请改选其它供应商的 ASR 模型",
                    cfg.vendor_name.as_deref().unwrap_or(&provider_id)
                ),
                &provider_id,
                model,
            ));
        }
        let api_key = if !is_masked_secret(&cfg.api_key) {
            cfg.api_key.trim().to_string()
        } else if is_siliconflow {
            resolve_asr_api_key(database).unwrap_or_default()
        } else {
            String::new()
        };
        if api_key.is_empty() {
            return Err(AsrConfigError::new(
                "settings-required",
                format!(
                    "语音识别模型 {} 所属供应商缺少 API Key，请先在「设置 → 模型服务」填写",
                    model
                ),
                &provider_id,
                model,
            ));
        }
        let base_url = if cfg.base_url.trim().is_empty() && is_siliconflow {
            DEFAULT_SILICONFLOW_BASE_URL
        } else {
            cfg.base_url.trim()
        };
        if base_url.is_empty() {
            return Err(AsrConfigError::new(
                "settings-required",
                format!("语音识别模型 {} 所属供应商缺少 Base URL", model),
                &provider_id,
                model,
            ));
        }
        let provider_name = cfg
            .vendor_name
            .as_deref()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .unwrap_or(&provider_id)
            .to_string();
        let mut endpoint = Self::new(
            &provider_id,
            &provider_name,
            base_url,
            &api_key,
            model,
            Some(cfg.id.clone()),
        )?;
        endpoint.headers = passthrough_headers(cfg);
        Ok(endpoint)
    }

    fn url(&self, path: &str) -> String {
        let base = self.base_url.trim_end_matches('/');
        let base = base
            .strip_suffix("/audio/transcriptions")
            .or_else(|| base.strip_suffix("/chat/completions"))
            .unwrap_or(base);
        format!("{}/{}", base, path)
    }

    fn authorize(&self, request: RequestBuilder) -> RequestBuilder {
        self.headers
            .iter()
            .fold(request.bearer_auth(&self.api_key), |req, (name, value)| {
                req.header(name.as_str(), value.as_str())
            })
    }
}

/// 解析 ASR 槽位：已分配且启用的模型优先（不限供应商），未分配 / 已删除 / 已停用时回退硅基流动默认模型
pub(crate) async fn resolve_asr_endpoint(
    llm: &LLMManager,
    database: &crate::database::Database,
) -> std::result::Result<AsrEndpoint, AsrConfigError> {
    let assigned = llm
        .get_model_assignments()
        .await
        .ok()
        .and_then(|a| a.voice_input_asr_model_config_id)
        .filter(|id| !id.trim().is_empty());
    if let Some(config_id) = assigned {
        if let Ok(configs) = llm.get_api_configs().await {
            if let Some(cfg) = configs
                .iter()
                .find(|c| c.id == config_id && c.enabled && !c.model.trim().is_empty())
            {
                return AsrEndpoint::from_api_config(cfg, database);
            }
        }
    }
    AsrEndpoint::siliconflow_default(database, None)
}

fn voice_input_error(error_type: AppErrorType, code: &str, message: impl Into<String>) -> AppError {
    let payload = json!({
        "code": code,
        "message": message.into(),
    });
    AppError::new(error_type, payload.to_string())
}

fn build_voice_input_http_client() -> Result<Client> {
    build_asr_http_client(Duration::from_secs(90))
}

/// 受管 ASR 共用的 HTTP 客户端（语音输入与媒体转写）
pub(crate) fn build_asr_http_client(timeout: Duration) -> Result<Client> {
    Client::builder().timeout(timeout).build().map_err(|error| {
        voice_input_error(
            AppErrorType::Network,
            "network-failed",
            format!("Failed to create voice input HTTP client: {}", error),
        )
    })
}

fn resolve_audio_extension(mime_type: &str) -> &'static str {
    let normalized = mime_type.trim().to_ascii_lowercase();
    match normalized.as_str() {
        "audio/webm" | "audio/webm;codecs=opus" => "webm",
        "audio/mp4" | "audio/m4a" => "m4a",
        "audio/mpeg" | "audio/mp3" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "audio/ogg" | "audio/ogg;codecs=opus" => "ogg",
        "audio/flac" => "flac",
        _ => "webm",
    }
}

fn decode_audio_payload(audio_base64: &str) -> Result<Vec<u8>> {
    STANDARD.decode(audio_base64).map_err(|error| {
        voice_input_error(
            AppErrorType::Validation,
            "invalid-audio",
            format!("Invalid audio payload: {}", error),
        )
    })
}

fn build_transcriptions_form(
    request: &VoiceInputTranscribeRequest,
    model: &str,
    audio_bytes: Vec<u8>,
) -> Result<Form> {
    let extension = resolve_audio_extension(&request.mime_type);
    let file_part = Part::bytes(audio_bytes)
        .file_name(format!("voice-input.{}", extension))
        .mime_str(request.mime_type.trim())
        .map_err(|error| {
            voice_input_error(
                AppErrorType::Validation,
                "invalid-audio",
                format!("Unsupported audio mime type: {}", error),
            )
        })?;

    let mut form = Form::new()
        .text("model", model.to_string())
        .part("file", file_part);

    if let Some(language) = non_empty(request.language.as_deref()) {
        form = form.text("language", language.to_string());
    }
    if let Some(prompt) = non_empty(request.prompt.as_deref()) {
        form = form.text("prompt", prompt.to_string());
    }

    Ok(form)
}

/// 受管 ASR（SiliconFlow）API Key：用户配置优先，其次内置 Key
pub(crate) fn resolve_asr_api_key(database: &crate::database::Database) -> Option<String> {
    ["builtin-siliconflow.api_key", "siliconflow.api_key"]
        .iter()
        .find_map(|key| {
            database
                .get_secret(key)
                .ok()
                .flatten()
                .filter(|value| !value.trim().is_empty())
        })
        .or_else(|| {
            [
                option_env!("SILICONFLOW_BUILTIN_TEXT_KEY"),
                option_env!("SILICONFLOW_BUILTIN_VISION_KEY"),
                option_env!("SILICONFLOW_BUILTIN_EMBED_KEY"),
            ]
            .into_iter()
            .flatten()
            .find(|value| !value.trim().is_empty())
            .map(|value| value.to_string())
        })
}

/// 当前 ASR 槽位的可用性（Agent 媒体工具的能力探测用）
pub(crate) async fn voice_input_asr_capability(state: &AppState) -> VoiceInputAsrCapability {
    match resolve_asr_endpoint(&state.llm_manager, &state.database).await {
        Ok(endpoint) => VoiceInputAsrCapability {
            provider_id: endpoint.provider_id,
            provider_name: endpoint.provider_name,
            model: endpoint.model,
            configured: true,
        },
        Err(error) => VoiceInputAsrCapability {
            provider_name: error.provider_id.clone(),
            provider_id: error.provider_id,
            model: error.model,
            configured: false,
        },
    }
}

fn record_voice_input_usage(
    provider_id: &str,
    model: &str,
    config_id: Option<&str>,
    latency_ms: u64,
    success: bool,
    error_message: Option<String>,
) {
    record_asr_usage(
        CallerType::VoiceInput,
        provider_id,
        model,
        config_id,
        latency_ms,
        success,
        error_message,
    );
}

/// 记录一次受管 ASR 调用（语音输入 / 媒体转写共用）
pub(crate) fn record_asr_usage(
    caller: CallerType,
    provider_id: &str,
    model: &str,
    config_id: Option<&str>,
    latency_ms: u64,
    success: bool,
    error_message: Option<String>,
) {
    let mut record = UsageRecord::new(caller, model.to_string(), 0, 0)
        .with_provider_id(provider_id.to_string())
        // ASR 端点不返回 token usage，0/0 是本地占位而非 API 实测；
        // 不标注会落 schema 默认 "api"，把无测量伪装成实测
        .with_token_source(crate::chat_v2::types::TokenSource::Heuristic.to_string())
        .with_duration(latency_ms);

    if let Some(config_id) = config_id.map(str::trim).filter(|value| !value.is_empty()) {
        record = record.with_config_id(config_id.to_string());
    }

    if !success {
        record = record.with_error(error_message.unwrap_or_else(|| "Unknown error".to_string()));
    }

    crate::llm_usage::record_usage_record(record);
}

/// 受管 ASR HTTP 调用错误（保留状态码与 Retry-After，供媒体转写做 AIMD / 重试决策）
#[derive(Debug, Clone)]
pub enum AsrHttpError {
    /// 传输层失败（连接 / 超时）
    Transport { timeout: bool, message: String },
    /// 非 2xx 响应
    Status {
        status: u16,
        retry_after: Option<Duration>,
        body: String,
    },
}

impl std::fmt::Display for AsrHttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AsrHttpError::Transport { message, .. } => write!(f, "{}", message),
            AsrHttpError::Status { status, body, .. } => write!(f, "HTTP {} {}", status, body),
        }
    }
}

/// 解析 Retry-After（秒数或 HTTP-date）
pub(crate) fn parse_retry_after(value: &str) -> Option<Duration> {
    let value = value.trim();
    if let Ok(secs) = value.parse::<u64>() {
        return Some(Duration::from_secs(secs.min(600)));
    }
    let when = chrono::DateTime::parse_from_rfc2822(value).ok()?;
    let delta = when.timestamp_millis() - chrono::Utc::now().timestamp_millis();
    Some(Duration::from_millis(delta.clamp(0, 600_000) as u64))
}

async fn send_asr_request(request: RequestBuilder) -> std::result::Result<String, AsrHttpError> {
    let response = request
        .send()
        .await
        .map_err(|error| AsrHttpError::Transport {
            timeout: error.is_timeout(),
            message: format!("ASR request failed: {}", error),
        })?;

    let status = response.status();
    if !status.is_success() {
        let retry_after = response
            .headers()
            .get(reqwest::header::RETRY_AFTER)
            .and_then(|v| v.to_str().ok())
            .and_then(parse_retry_after);
        let body = response.text().await.unwrap_or_default();
        return Err(AsrHttpError::Status {
            status: status.as_u16(),
            retry_after,
            body: body.chars().take(500).collect(),
        });
    }

    response
        .text()
        .await
        .map_err(|error| AsrHttpError::Transport {
            timeout: error.is_timeout(),
            message: format!("ASR response read failed: {}", error),
        })
}

/// POST `{base_url}/audio/transcriptions`（multipart），成功返回响应体文本
pub(crate) async fn post_asr_form(
    client: &Client,
    endpoint: &AsrEndpoint,
    form: Form,
) -> std::result::Result<String, AsrHttpError> {
    let request = endpoint
        .authorize(client.post(endpoint.url("audio/transcriptions")))
        .multipart(form);
    send_asr_request(request).await
}

/// `asr_options.language` 只认主语言码（zh / en / yue …）
fn chat_asr_language(language: Option<&str>) -> Option<String> {
    let primary = non_empty(language)?
        .split(['-', '_'])
        .next()?
        .to_ascii_lowercase();
    (!primary.is_empty() && primary != "auto").then_some(primary)
}

/// POST `{base_url}/chat/completions`，音频以 `input_audio` Data URL 传入（百炼 qwen3-asr-flash），
/// 成功返回响应体文本
pub(crate) async fn post_asr_chat_input_audio(
    client: &Client,
    endpoint: &AsrEndpoint,
    audio: &[u8],
    mime_type: &str,
    language: Option<&str>,
) -> std::result::Result<String, AsrHttpError> {
    let mime = mime_type.split(';').next().unwrap_or("").trim();
    let mime = if mime.is_empty() { "audio/wav" } else { mime };
    let mut body = json!({
        "model": endpoint.model,
        "messages": [{
            "role": "user",
            "content": [{
                "type": "input_audio",
                "input_audio": { "data": format!("data:{};base64,{}", mime, STANDARD.encode(audio)) },
            }],
        }],
        "stream": false,
    });
    if let Some(language) = chat_asr_language(language) {
        body["asr_options"] = json!({ "language": language });
    }
    let request = endpoint
        .authorize(client.post(endpoint.url("chat/completions")))
        .json(&body);
    send_asr_request(request).await
}

/// 去掉 Qwen3-ASR 原始输出里的 `language Chinese<asr_text>` 前缀
pub(crate) fn clean_asr_text(text: &str) -> String {
    const MARKER: &str = "<asr_text>";
    let trimmed = text.trim();
    match trimmed.find(MARKER) {
        Some(idx) if idx == 0 || trimmed[..idx].trim_start().starts_with("language") => {
            trimmed[idx + MARKER.len()..].trim().to_string()
        }
        _ => trimmed.to_string(),
    }
}

/// 解析 chat 形态的识别结果：`choices[0].message.content`（字符串或 text 片段数组）
pub(crate) fn parse_chat_transcript(
    body: &str,
) -> std::result::Result<(String, Option<String>), String> {
    let value: Value =
        serde_json::from_str(body).map_err(|e| format!("Invalid ASR response: {}", e))?;
    let message = value
        .pointer("/choices/0/message")
        .ok_or_else(|| "Invalid ASR response: missing choices[0].message".to_string())?;
    let text = match message.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => return Err("Invalid ASR response: missing message content".to_string()),
    };
    let language = message
        .get("annotations")
        .and_then(Value::as_array)
        .and_then(|items| {
            items
                .iter()
                .find_map(|item| item.get("language").and_then(Value::as_str))
        })
        .map(str::to_string);
    Ok((clean_asr_text(&text), language))
}

fn map_transcribe_http_error(endpoint: &AsrEndpoint, error: AsrHttpError) -> AppError {
    match error {
        AsrHttpError::Transport { timeout, message } => voice_input_error(
            AppErrorType::Network,
            if timeout { "timeout" } else { "network-failed" },
            format!("Voice input request failed: {}", message),
        ),
        AsrHttpError::Status { status, body, .. } => {
            let code = match status {
                401 | 403 => "auth-failed",
                429 => "rate-limited",
                _ => "transcription-failed",
            };
            let message = match code {
                "auth-failed" => format!(
                    "Voice input authentication failed. Check the {} API key.",
                    endpoint.provider_name
                ),
                "rate-limited" => format!(
                    "Voice input is being rate limited by {}.",
                    endpoint.provider_name
                ),
                _ => "Voice input transcription failed.".to_string(),
            };
            voice_input_error(
                AppErrorType::LLM,
                code,
                format!("{} HTTP {} {}", message, status, body),
            )
        }
    }
}

fn invalid_transcription_response(endpoint: &AsrEndpoint, detail: String) -> AppError {
    voice_input_error(
        AppErrorType::Validation,
        "transcription-failed",
        format!(
            "Invalid {} transcription response: {}",
            endpoint.provider_name, detail
        ),
    )
}

async fn transcribe_with_endpoint(
    client: &Client,
    endpoint: &AsrEndpoint,
    request: &VoiceInputTranscribeRequest,
) -> Result<VoiceInputTranscribeResponse> {
    let audio_bytes = decode_audio_payload(&request.audio_base64)?;

    let (text, language) = match endpoint.protocol {
        AsrProtocol::Transcriptions => {
            let form = build_transcriptions_form(request, &endpoint.model, audio_bytes)?;
            let body = post_asr_form(client, endpoint, form)
                .await
                .map_err(|error| map_transcribe_http_error(endpoint, error))?;
            let payload = serde_json::from_str::<TranscriptionResponse>(&body)
                .map_err(|error| invalid_transcription_response(endpoint, error.to_string()))?;
            (
                clean_asr_text(&payload.text.unwrap_or_default()),
                payload.language,
            )
        }
        AsrProtocol::ChatInputAudio => {
            let body = post_asr_chat_input_audio(
                client,
                endpoint,
                &audio_bytes,
                &request.mime_type,
                request.language.as_deref(),
            )
            .await
            .map_err(|error| map_transcribe_http_error(endpoint, error))?;
            parse_chat_transcript(&body)
                .map_err(|detail| invalid_transcription_response(endpoint, detail))?
        }
    };

    if text.is_empty() {
        return Err(voice_input_error(
            AppErrorType::Validation,
            "empty-transcript",
            format!("{} returned an empty transcript.", endpoint.provider_name),
        ));
    }

    Ok(VoiceInputTranscribeResponse {
        text,
        language,
        duration_ms: request.duration_ms,
        provider_id: endpoint.provider_id.clone(),
        model: endpoint.model.clone(),
    })
}

/// 请求带了 configId → 用该模型配置；只带 SiliconFlow 模型名 → 硅基流动默认端点；
/// 什么都没指定（Agent 媒体工具）→ 跟随 ASR 槽位
async fn resolve_request_endpoint(
    request: &VoiceInputTranscribeRequest,
    state: &AppState,
) -> std::result::Result<AsrEndpoint, AsrConfigError> {
    let requested_provider = non_empty(request.provider_id.as_deref());
    let requested_model = non_empty(request.model.as_deref());

    if let Some(config_id) = non_empty(request.config_id.as_deref()) {
        let provider = requested_provider.unwrap_or(DEFAULT_PROVIDER_ID);
        let model = requested_model.unwrap_or_default();
        let configs = state.llm_manager.get_api_configs().await.map_err(|e| {
            AsrConfigError::new(
                "model-config-missing",
                format!("读取模型配置失败: {}", e),
                provider,
                model,
            )
        })?;
        let cfg = configs.iter().find(|c| c.id == config_id).ok_or_else(|| {
            AsrConfigError::new(
                "model-config-missing",
                format!("语音识别模型配置不存在: {}", config_id),
                provider,
                model,
            )
        })?;
        if !cfg.enabled {
            return Err(AsrConfigError::new(
                "model-disabled",
                format!("语音识别模型 {} 已停用", cfg.model),
                provider,
                &cfg.model,
            ));
        }
        return AsrEndpoint::from_api_config(cfg, &state.database);
    }

    if requested_provider.is_none() && requested_model.is_none() {
        return resolve_asr_endpoint(&state.llm_manager, &state.database).await;
    }

    let provider = requested_provider.unwrap_or(DEFAULT_PROVIDER_ID);
    if !provider.eq_ignore_ascii_case(DEFAULT_PROVIDER_ID) {
        return Err(AsrConfigError::new(
            "provider-unavailable",
            format!(
                "Voice input provider {} needs a model configuration (configId)",
                provider
            ),
            provider,
            requested_model.unwrap_or_default(),
        ));
    }
    AsrEndpoint::siliconflow_default(&state.database, requested_model)
}

#[tauri::command(rename_all = "camelCase")]
pub async fn voice_input_transcribe(
    request: VoiceInputTranscribeRequest,
    state: State<'_, AppState>,
) -> Result<VoiceInputTranscribeResponse> {
    voice_input_transcribe_with_state(request, &state).await
}

/// Shared managed ASR entry point for voice input and agent media tools.
/// It only uses application-managed credentials/configuration and never
/// installs packages or mutates the host environment.
pub(crate) async fn voice_input_transcribe_with_state(
    request: VoiceInputTranscribeRequest,
    state: &AppState,
) -> Result<VoiceInputTranscribeResponse> {
    let started_at = Instant::now();
    let elapsed_ms = |started: Instant| started.elapsed().as_millis().min(u64::MAX as u128) as u64;

    let endpoint = match resolve_request_endpoint(&request, state).await {
        Ok(endpoint) => endpoint,
        Err(error) => {
            record_voice_input_usage(
                &error.provider_id,
                &error.model,
                request.config_id.as_deref(),
                elapsed_ms(started_at),
                false,
                Some(error.message.clone()),
            );
            return Err(error.into_app_error());
        }
    };

    let result = match build_voice_input_http_client() {
        Ok(client) => transcribe_with_endpoint(&client, &endpoint, &request).await,
        Err(error) => Err(error),
    };
    record_voice_input_usage(
        &endpoint.provider_id,
        &endpoint.model,
        endpoint.config_id.as_deref(),
        elapsed_ms(started_at),
        result.is_ok(),
        result.as_ref().err().map(|error| error.message.clone()),
    );
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use mockito::{Matcher, Server};

    fn sample_request() -> VoiceInputTranscribeRequest {
        VoiceInputTranscribeRequest {
            audio_base64: STANDARD.encode(b"fake-audio"),
            mime_type: "audio/webm".to_string(),
            provider_id: Some("siliconflow".to_string()),
            model: Some("Qwen/Qwen3-ASR-1.7B".to_string()),
            config_id: Some("voice-asr".to_string()),
            language: Some("zh".to_string()),
            prompt: Some("medical dictation".to_string()),
            duration_ms: Some(1500),
        }
    }

    fn endpoint(base_url: &str, model: &str) -> AsrEndpoint {
        AsrEndpoint::new(
            "siliconflow",
            "SiliconFlow",
            base_url,
            "sk-test",
            model,
            Some("voice-asr".into()),
        )
        .unwrap()
    }

    fn sf_endpoint(server: &Server) -> AsrEndpoint {
        endpoint(&format!("{}/v1", server.url()), "Qwen/Qwen3-ASR-1.7B")
    }

    fn api_config(provider_type: &str, model: &str, api_key: &str) -> ApiConfig {
        ApiConfig {
            id: "cfg-asr".into(),
            name: model.into(),
            vendor_name: Some("统一出口".into()),
            provider_type: Some(provider_type.into()),
            base_url: "http://relay.example.test/v1/".into(),
            api_key: api_key.into(),
            model: model.into(),
            enabled: true,
            headers: Some(std::collections::HashMap::from([
                ("X-Relay-Tenant".to_string(), "deep-student".to_string()),
                ("Authorization".to_string(), "Bearer hijack".to_string()),
            ])),
            ..ApiConfig::default()
        }
    }

    #[test]
    fn asr_names_cover_suffix_style_and_exclude_tts() {
        for name in [
            "Qwen/Qwen3-ASR-1.7B",
            "qwen3-asr-flash",
            "XingChenAGI/XingChenASR-V3.2-Ultra",
            "XingChenAGI/XingChenASR-Diarize-V3.0",
            "TeleAI/TeleSpeechASR",
            "FunAudioLLM/SenseVoiceSmall",
            "whisper-large-v3-turbo",
            "gpt-4o-mini-transcribe",
            "paraformer-v2",
            "elevenlabs/scribe_v1",
            "google/stt-v2",
            "fun-asr",
        ] {
            assert!(is_asr_model_name(name), "{name} should be ASR");
        }
        for name in [
            "FunAudioLLM/CosyVoice2-0.5B",
            "qwen3-tts-flash",
            "gpt-4o-mini-tts",
            "Qwen/Qwen3-Omni-30B-A3B-Captioner",
            "deepseek-v4-pro",
            "image-describe-v1",
            "",
        ] {
            assert!(!is_asr_model_name(name), "{name} should not be ASR");
        }
        assert!(is_asr_model("relay-gw_qwen3-asr-flash", ""));
        assert!(!is_asr_model("asr-gateway_gpt-5.6", "GPT 5.6"));
    }

    #[test]
    fn protocol_follows_model_family() {
        assert_eq!(
            asr_protocol_for_model("qwen3-asr-flash").unwrap(),
            AsrProtocol::ChatInputAudio
        );
        assert_eq!(
            asr_protocol_for_model("aliyun/qwen3-asr-flash-2026-02-10").unwrap(),
            AsrProtocol::ChatInputAudio
        );
        assert_eq!(
            asr_protocol_for_model("Qwen/Qwen3-ASR-1.7B").unwrap(),
            AsrProtocol::Transcriptions
        );
        assert_eq!(
            asr_protocol_for_model("whisper-1").unwrap(),
            AsrProtocol::Transcriptions
        );
        assert!(asr_protocol_for_model("qwen3-asr-flash-realtime").is_err());
        assert!(asr_protocol_for_model("qwen3-asr-flash-filetrans").is_err());
        assert!(asr_protocol_for_model("qwen-audio-3.1-asr-flash-streaming").is_err());
    }

    #[test]
    fn provider_support_excludes_non_openai_protocols() {
        assert!(asr_provider_supported(Some("siliconflow"), None));
        assert!(asr_provider_supported(
            Some("custom"),
            Some("openai_chat_completions")
        ));
        assert!(asr_provider_supported(
            Some("openai"),
            Some("openai_responses")
        ));
        assert!(asr_provider_supported(None, None));
        assert!(!asr_provider_supported(Some("anthropic"), None));
        assert!(!asr_provider_supported(Some("openai_codex"), None));
        assert!(!asr_provider_supported(
            Some("custom"),
            Some("google_generate_content")
        ));
    }

    #[test]
    fn relay_config_uses_its_own_base_url_key_and_headers() {
        let db_dir = tempfile::tempdir().unwrap();
        let db = crate::database::Database::new(&db_dir.path().join("t.db")).unwrap();
        let cfg = api_config("custom", "Qwen/Qwen3-ASR-0.6B", "sk-relay");
        let endpoint = AsrEndpoint::from_api_config(&cfg, &db).unwrap();
        assert_eq!(endpoint.provider_id, "custom");
        assert_eq!(endpoint.provider_name, "统一出口");
        assert_eq!(endpoint.api_key, "sk-relay");
        assert_eq!(endpoint.config_id.as_deref(), Some("cfg-asr"));
        assert_eq!(endpoint.protocol, AsrProtocol::Transcriptions);
        assert_eq!(
            endpoint.url("audio/transcriptions"),
            "http://relay.example.test/v1/audio/transcriptions"
        );
        assert_eq!(
            endpoint.headers,
            vec![("X-Relay-Tenant".to_string(), "deep-student".to_string())]
        );

        let missing_key = api_config("custom", "whisper-1", "***");
        assert_eq!(
            AsrEndpoint::from_api_config(&missing_key, &db)
                .unwrap_err()
                .code,
            "settings-required"
        );
        let anthropic = api_config("anthropic", "whisper-1", "sk");
        assert_eq!(
            AsrEndpoint::from_api_config(&anthropic, &db)
                .unwrap_err()
                .code,
            "provider-unavailable"
        );
        let realtime = api_config("qwen", "qwen3-asr-flash-realtime", "sk");
        assert_eq!(
            AsrEndpoint::from_api_config(&realtime, &db)
                .unwrap_err()
                .code,
            "provider-unavailable"
        );
        // 旧版一键分配写入的已下架模型由默认模型接替
        let retired = api_config("siliconflow", "TeleAI/TeleSpeechASR", "sk-sf");
        assert_eq!(
            AsrEndpoint::from_api_config(&retired, &db).unwrap().model,
            DEFAULT_SILICONFLOW_MODEL
        );
    }

    #[test]
    fn endpoint_url_tolerates_full_endpoint_base_urls() {
        let ep = endpoint(
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions",
            "qwen3-asr-flash",
        );
        assert_eq!(
            ep.url("chat/completions"),
            "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"
        );
    }

    #[test]
    fn chat_transcript_parsing_strips_qwen_language_prefix() {
        let (text, language) = parse_chat_transcript(
            r#"{"choices":[{"message":{"role":"assistant","content":"欢迎使用阿里云。","annotations":[{"type":"audio_info","language":"zh","emotion":"neutral"}]}}]}"#,
        )
        .unwrap();
        assert_eq!(text, "欢迎使用阿里云。");
        assert_eq!(language.as_deref(), Some("zh"));

        let (text, _) = parse_chat_transcript(
            r#"{"choices":[{"message":{"content":[{"type":"text","text":"language Chinese<asr_text>你好"}]}}]}"#,
        )
        .unwrap();
        assert_eq!(text, "你好");
        assert!(parse_chat_transcript(r#"{"choices":[]}"#).is_err());
        assert_eq!(clean_asr_text("  plain text "), "plain text");
        assert_eq!(chat_asr_language(Some("zh-CN")).as_deref(), Some("zh"));
        assert_eq!(chat_asr_language(Some("auto")), None);
    }

    #[tokio::test]
    async fn transcribe_with_transcriptions_endpoint_posts_multipart_form() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .match_header("authorization", "Bearer sk-test")
            .match_body(Matcher::AllOf(vec![
                Matcher::Regex("name=\"model\"".to_string()),
                Matcher::Regex("Qwen/Qwen3-ASR-1.7B".to_string()),
                Matcher::Regex("name=\"language\"".to_string()),
                Matcher::Regex("medical dictation".to_string()),
                Matcher::Regex("name=\"file\"".to_string()),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"text":"你好，世界","language":"zh"}"#)
            .create_async()
            .await;

        let client = Client::builder()
            .timeout(Duration::from_secs(2))
            .no_proxy()
            .build()
            .unwrap();
        let result = transcribe_with_endpoint(&client, &sf_endpoint(&server), &sample_request())
            .await
            .unwrap();

        assert_eq!(result.text, "你好，世界");
        assert_eq!(result.language.as_deref(), Some("zh"));
        assert_eq!(result.provider_id, "siliconflow");
        assert_eq!(result.model, "Qwen/Qwen3-ASR-1.7B");
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_with_qwen_flash_posts_input_audio_chat_request() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/compatible-mode/v1/chat/completions")
            .match_header("authorization", "Bearer sk-test")
            .match_body(Matcher::AllOf(vec![
                Matcher::PartialJson(json!({
                    "model": "qwen3-asr-flash",
                    "stream": false,
                    "asr_options": { "language": "zh" },
                })),
                Matcher::Regex(
                    r#""type":"input_audio".*"data":"data:audio/webm;base64,"#.to_string(),
                ),
            ]))
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body(r#"{"choices":[{"message":{"role":"assistant","content":"转写结果"}}]}"#)
            .create_async()
            .await;

        let client = Client::builder().no_proxy().build().unwrap();
        let ep = endpoint(
            &format!("{}/compatible-mode/v1", server.url()),
            "qwen3-asr-flash",
        );
        let result = transcribe_with_endpoint(&client, &ep, &sample_request())
            .await
            .unwrap();
        assert_eq!(result.text, "转写结果");
        assert_eq!(result.model, "qwen3-asr-flash");
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_maps_401_to_auth_failed() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(401)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error":"unauthorized"}"#)
            .create_async()
            .await;

        let client = build_voice_input_http_client().unwrap();
        let error = transcribe_with_endpoint(&client, &sf_endpoint(&server), &sample_request())
            .await
            .unwrap_err();

        assert!(error.message.contains("\"code\":\"auth-failed\""));
        assert!(error.message.contains("SiliconFlow API key"));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_maps_429_to_rate_limited() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(429)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error":"too many requests"}"#)
            .create_async()
            .await;

        let client = build_voice_input_http_client().unwrap();
        let error = transcribe_with_endpoint(&client, &sf_endpoint(&server), &sample_request())
            .await
            .unwrap_err();

        assert!(error.message.contains("\"code\":\"rate-limited\""));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_maps_5xx_to_transcription_failed() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(503)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error":"unavailable"}"#)
            .create_async()
            .await;

        let client = build_voice_input_http_client().unwrap();
        let error = transcribe_with_endpoint(&client, &sf_endpoint(&server), &sample_request())
            .await
            .unwrap_err();

        assert!(error.message.contains("\"code\":\"transcription-failed\""));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_rejects_empty_transcripts() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("{\"text\":\"   \"}")
            .create_async()
            .await;

        let client = build_voice_input_http_client().unwrap();
        let error = transcribe_with_endpoint(&client, &sf_endpoint(&server), &sample_request())
            .await
            .unwrap_err();

        assert!(error.message.contains("\"code\":\"empty-transcript\""));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_maps_transport_failures_to_network_codes() {
        let client = build_voice_input_http_client().unwrap();
        let error = transcribe_with_endpoint(
            &client,
            &endpoint("http://[::1", "Qwen/Qwen3-ASR-1.7B"),
            &sample_request(),
        )
        .await
        .unwrap_err();

        assert!(
            matches!(error.error_type, AppErrorType::Network),
            "unexpected transport error: {:?} {}",
            error.error_type,
            error.message
        );
        let payload: serde_json::Value = serde_json::from_str(&error.message).unwrap();
        let code = payload
            .get("code")
            .and_then(|value| value.as_str())
            .unwrap_or("");
        assert!(matches!(code, "network-failed" | "timeout"));
    }
}
