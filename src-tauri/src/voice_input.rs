//! 语音输入（受管 ASR）。实现见 `dstu_media::voice_input`，这里按原路径重导出。
//!
//! `voice_input_transcribe` 命令与 `voice_input_asr_capability` /
//! `voice_input_transcribe_with_state`（Agent 媒体工具用）取 `AppState`（定义在 app），
//! 以同名同签名的薄包装留在这里，实现体在 dstu-media 的 `*_with*` 函数。

pub use dstu_media::voice_input::*;

use tauri::State;

use crate::commands::AppState;
use crate::models::AppError;

type Result<T> = std::result::Result<T, AppError>;

/// 当前 ASR 槽位的可用性（Agent 媒体工具的能力探测用）
pub(crate) async fn voice_input_asr_capability(state: &AppState) -> VoiceInputAsrCapability {
    voice_input_asr_capability_with(&state.llm_manager, &state.database).await
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
    voice_input_transcribe_with_services(request, &state.llm_manager, &state.database).await
}
