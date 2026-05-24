use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use reqwest::multipart::{Form, Part};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use crate::commands::AppState;
use crate::llm_usage::{CallerType, UsageRecord};
use crate::models::{AppError, AppErrorType};

type Result<T> = std::result::Result<T, AppError>;

const DEFAULT_PROVIDER_ID: &str = "siliconflow";
const DEFAULT_SILICONFLOW_BASE_URL: &str = "https://api.siliconflow.cn/v1";
const DEFAULT_SILICONFLOW_MODEL: &str = "TeleAI/TeleSpeechASR";

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
struct SiliconFlowTranscriptionResponse {
    text: Option<String>,
    language: Option<String>,
}

fn voice_input_error(error_type: AppErrorType, code: &str, message: impl Into<String>) -> AppError {
    let payload = json!({
        "code": code,
        "message": message.into(),
    });
    AppError::new(error_type, payload.to_string())
}

fn build_voice_input_http_client() -> Result<Client> {
    Client::builder()
        .timeout(Duration::from_secs(90))
        .build()
        .map_err(|error| {
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

fn build_siliconflow_form(
    request: &VoiceInputTranscribeRequest,
    audio_bytes: Vec<u8>,
) -> Result<Form> {
    let provider_model = request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_SILICONFLOW_MODEL);
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
        .text("model", provider_model.to_string())
        .part("file", file_part);

    if let Some(language) = request
        .language
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form = form.text("language", language.to_string());
    }
    if let Some(prompt) = request
        .prompt
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        form = form.text("prompt", prompt.to_string());
    }

    Ok(form)
}

fn resolve_siliconflow_api_key(state: &AppState) -> Option<String> {
    ["builtin-siliconflow.api_key", "siliconflow.api_key"]
        .iter()
        .find_map(|key| {
            state
                .database
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

fn resolve_requested_provider_id(request: &VoiceInputTranscribeRequest) -> String {
    request
        .provider_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_PROVIDER_ID)
        .to_string()
}

fn resolve_requested_model_id(request: &VoiceInputTranscribeRequest) -> String {
    request
        .model
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(DEFAULT_SILICONFLOW_MODEL)
        .to_string()
}

fn record_voice_input_usage(
    request: &VoiceInputTranscribeRequest,
    latency_ms: u64,
    success: bool,
    error_message: Option<String>,
) {
    let mut record = UsageRecord::new(
        CallerType::VoiceInput,
        resolve_requested_model_id(request),
        0,
        0,
    )
    .with_provider_id(resolve_requested_provider_id(request))
    .with_duration(latency_ms);

    if let Some(config_id) = request
        .config_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        record = record.with_config_id(config_id.to_string());
    }

    if !success {
        record = record.with_error(error_message.unwrap_or_else(|| "Unknown error".to_string()));
    }

    crate::llm_usage::record_usage_record(record);
}

async fn transcribe_with_siliconflow(
    client: &Client,
    base_url: &str,
    api_key: &str,
    request: &VoiceInputTranscribeRequest,
) -> Result<VoiceInputTranscribeResponse> {
    let audio_bytes = decode_audio_payload(&request.audio_base64)?;
    let form = build_siliconflow_form(request, audio_bytes)?;
    let endpoint = format!("{}/audio/transcriptions", base_url.trim_end_matches('/'));

    let response = client
        .post(endpoint)
        .bearer_auth(api_key.trim())
        .multipart(form)
        .send()
        .await
        .map_err(|error| {
            let code = if error.is_timeout() {
                "timeout"
            } else {
                "network-failed"
            };
            voice_input_error(
                AppErrorType::Network,
                code,
                format!("Voice input request failed: {}", error),
            )
        })?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        let code = match status.as_u16() {
            401 | 403 => "auth-failed",
            429 => "rate-limited",
            500..=599 => "transcription-failed",
            _ => "transcription-failed",
        };
        let message = match code {
            "auth-failed" => "Voice input authentication failed. Check the SiliconFlow API key.",
            "rate-limited" => "Voice input is being rate limited by SiliconFlow.",
            _ => "Voice input transcription failed.",
        };
        return Err(voice_input_error(
            AppErrorType::LLM,
            code,
            format!("{} HTTP {} {}", message, status.as_u16(), body),
        ));
    }

    let payload = response
        .json::<SiliconFlowTranscriptionResponse>()
        .await
        .map_err(|error| {
            voice_input_error(
                AppErrorType::Validation,
                "transcription-failed",
                format!("Invalid SiliconFlow transcription response: {}", error),
            )
        })?;
    let text = payload.text.unwrap_or_default().trim().to_string();
    if text.is_empty() {
        return Err(voice_input_error(
            AppErrorType::Validation,
            "empty-transcript",
            "SiliconFlow returned an empty transcript.",
        ));
    }

    Ok(VoiceInputTranscribeResponse {
        text,
        language: payload.language,
        duration_ms: request.duration_ms,
        provider_id: DEFAULT_PROVIDER_ID.to_string(),
        model: request
            .model
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_SILICONFLOW_MODEL.to_string()),
    })
}

#[tauri::command(rename_all = "camelCase")]
pub async fn voice_input_transcribe(
    request: VoiceInputTranscribeRequest,
    state: State<'_, AppState>,
) -> Result<VoiceInputTranscribeResponse> {
    let provider_id = resolve_requested_provider_id(&request);
    let started_at = Instant::now();

    if provider_id != DEFAULT_PROVIDER_ID {
        let error = voice_input_error(
            AppErrorType::Validation,
            "provider-unavailable",
            format!("Voice input provider is not supported yet: {}", provider_id),
        );
        record_voice_input_usage(
            &request,
            started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
            false,
            Some(error.message.clone()),
        );
        return Err(error);
    }

    let api_key = match resolve_siliconflow_api_key(&state) {
        Some(value) => value,
        None => {
            let error = voice_input_error(
                AppErrorType::Configuration,
                "settings-required",
                "Configure a SiliconFlow API key in Settings before using voice input.",
            );
            record_voice_input_usage(
                &request,
                started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                false,
                Some(error.message.clone()),
            );
            return Err(error);
        }
    };

    let client = match build_voice_input_http_client() {
        Ok(client) => client,
        Err(error) => {
            record_voice_input_usage(
                &request,
                started_at.elapsed().as_millis().min(u64::MAX as u128) as u64,
                false,
                Some(error.message.clone()),
            );
            return Err(error);
        }
    };

    let result =
        transcribe_with_siliconflow(&client, DEFAULT_SILICONFLOW_BASE_URL, &api_key, &request)
            .await;
    let latency_ms = started_at.elapsed().as_millis().min(u64::MAX as u128) as u64;

    match result {
        Ok(response) => {
            record_voice_input_usage(&request, latency_ms, true, None);
            Ok(response)
        }
        Err(error) => {
            record_voice_input_usage(&request, latency_ms, false, Some(error.message.clone()));
            Err(error)
        }
    }
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
            model: Some("TeleAI/TeleSpeechASR".to_string()),
            config_id: Some("voice-asr".to_string()),
            language: Some("zh".to_string()),
            prompt: Some("medical dictation".to_string()),
            duration_ms: Some(1500),
        }
    }

    #[tokio::test]
    async fn transcribe_with_siliconflow_posts_multipart_form() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .match_header("authorization", "Bearer sk-test")
            .match_body(Matcher::Regex("name=\"model\"".to_string()))
            .match_body(Matcher::Regex("TeleAI/TeleSpeechASR".to_string()))
            .match_body(Matcher::Regex("name=\"language\"".to_string()))
            .match_body(Matcher::Regex("medical dictation".to_string()))
            .match_body(Matcher::Regex("name=\"file\"".to_string()))
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
        let result = transcribe_with_siliconflow(
            &client,
            &format!("{}/v1", server.url()),
            "sk-test",
            &sample_request(),
        )
        .await
        .unwrap();

        assert_eq!(result.text, "你好，世界");
        assert_eq!(result.language.as_deref(), Some("zh"));
        assert_eq!(result.provider_id, "siliconflow");
        assert_eq!(result.model, "TeleAI/TeleSpeechASR");
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_with_siliconflow_maps_401_to_auth_failed() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(401)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error":"unauthorized"}"#)
            .create_async()
            .await;

        let client = build_voice_input_http_client().unwrap();
        let error = transcribe_with_siliconflow(
            &client,
            &format!("{}/v1", server.url()),
            "sk-test",
            &sample_request(),
        )
        .await
        .unwrap_err();

        assert!(error.message.contains("\"code\":\"auth-failed\""));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_with_siliconflow_maps_429_to_rate_limited() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(429)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error":"too many requests"}"#)
            .create_async()
            .await;

        let client = build_voice_input_http_client().unwrap();
        let error = transcribe_with_siliconflow(
            &client,
            &format!("{}/v1", server.url()),
            "sk-test",
            &sample_request(),
        )
        .await
        .unwrap_err();

        assert!(error.message.contains("\"code\":\"rate-limited\""));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_with_siliconflow_maps_5xx_to_transcription_failed() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(503)
            .with_header("content-type", "application/json")
            .with_body(r#"{"error":"unavailable"}"#)
            .create_async()
            .await;

        let client = build_voice_input_http_client().unwrap();
        let error = transcribe_with_siliconflow(
            &client,
            &format!("{}/v1", server.url()),
            "sk-test",
            &sample_request(),
        )
        .await
        .unwrap_err();

        assert!(error.message.contains("\"code\":\"transcription-failed\""));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_with_siliconflow_rejects_empty_transcripts() {
        let mut server = Server::new_async().await;
        let mock = server
            .mock("POST", "/v1/audio/transcriptions")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_body("{\"text\":\"   \"}")
            .create_async()
            .await;

        let client = build_voice_input_http_client().unwrap();
        let error = transcribe_with_siliconflow(
            &client,
            &format!("{}/v1", server.url()),
            "sk-test",
            &sample_request(),
        )
        .await
        .unwrap_err();

        assert!(error.message.contains("\"code\":\"empty-transcript\""));
        mock.assert_async().await;
    }

    #[tokio::test]
    async fn transcribe_with_siliconflow_maps_transport_failures_to_network_codes() {
        let client = build_voice_input_http_client().unwrap();
        let error =
            transcribe_with_siliconflow(&client, "http://[::1", "sk-test", &sample_request())
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
