/// Tauri TTS 模块 - 可选的系统级语音合成
///
/// 当 WebView 的 Web Speech API 不可用时，使用系统 TTS 作为备选方案
///
/// 平台支持：
/// - Windows: SAPI (默认) 或 Windows.Media.SpeechSynthesis
/// - macOS: AVSpeechSynthesizer
/// - Linux: espeak / speech-dispatcher
use crate::models::AppError;

// Windows TTS 需要额外的 crate 依赖，暂不启用
// #[cfg(target_os = "windows")]
// use windows::Media::SpeechSynthesis::{SpeechSynthesizer, SpeechSynthesisStream};

/// TTS 请求参数
#[derive(Debug, serde::Deserialize)]
pub struct TTSRequest {
    pub text: String,
    pub lang: Option<String>,
    pub rate: Option<f32>,
    pub volume: Option<f32>,
}

/// 检查 TTS 是否可用
#[tauri::command]
pub async fn tts_check_available() -> Result<bool, AppError> {
    #[cfg(target_os = "windows")]
    {
        // Windows 通常都有 TTS
        Ok(true)
    }

    #[cfg(target_os = "macos")]
    {
        // macOS 通常都有 TTS
        Ok(true)
    }

    #[cfg(target_os = "linux")]
    {
        // Linux 需要检查 espeak 或 speech-dispatcher
        use std::process::Command;
        let has_espeak = Command::new("which")
            .arg("espeak")
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);

        Ok(has_espeak)
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Ok(false)
    }
}

/// 朗读文本
#[tauri::command]
pub async fn tts_speak(
    text: String,
    lang: Option<String>,
    rate: Option<f32>,
    volume: Option<f32>,
) -> Result<(), AppError> {
    println!(
        "🔊 TTS 朗读: lang={:?}, rate={:?}, volume={:?}",
        lang, rate, volume
    );

    #[cfg(target_os = "windows")]
    {
        speak_windows(&text, lang.as_deref(), rate, volume).await
    }

    #[cfg(target_os = "macos")]
    {
        speak_macos(&text, lang.as_deref(), rate, volume).await
    }

    #[cfg(target_os = "linux")]
    {
        speak_linux(&text, lang.as_deref(), rate, volume).await
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        Err(AppError::not_implemented("当前平台不支持 TTS"))
    }
}

/// 停止朗读
#[tauri::command]
pub async fn tts_stop() -> Result<(), AppError> {
    // 注意：实际实现需要维护全局状态来跟踪正在进行的朗读
    // 这里只是一个简化的示例
    println!("🛑 停止 TTS 朗读");
    Ok(())
}

// ============================================================================
// 平台特定实现
// ============================================================================

#[cfg(target_os = "windows")]
async fn speak_windows(
    text: &str,
    _lang: Option<&str>,
    _rate: Option<f32>,
    _volume: Option<f32>,
) -> Result<(), AppError> {
    // Windows SAPI 实现
    // 注意：这需要 windows crate 依赖，目前先返回不支持
    Err(AppError::not_implemented(
        "Windows TTS 需要额外配置，请使用 Web Speech API",
    ))
}

#[cfg(target_os = "macos")]
async fn speak_macos(
    text: &str,
    lang: Option<&str>,
    rate: Option<f32>,
    _volume: Option<f32>,
) -> Result<(), AppError> {
    let text = text.to_string();
    let lang = lang.map(|value| value.to_string());

    // `say` 会阻塞直到整段语音播放完成，放到 spawn_blocking，避免阻塞异步运行时 worker 线程。
    tokio::task::spawn_blocking(move || {
        use std::process::Command;

        // 使用 macOS 的 say 命令
        let mut cmd = Command::new("say");

        // 设置语言/语音
        if let Some(lang_code) = lang.as_deref() {
            let voice = match lang_code {
                "zh-CN" | "zh" => "Ting-Ting",
                "en-US" | "en" => "Alex",
                "ja-JP" | "ja" => "Kyoko",
                _ => "Alex",
            };
            cmd.arg("-v").arg(voice);
        }

        // 设置语速（say 命令使用 words per minute）
        if let Some(r) = rate {
            let wpm = (175.0 * r) as u32; // 默认 175 wpm
            cmd.arg("-r").arg(wpm.to_string());
        }

        cmd.arg(&text);

        let output = cmd
            .output()
            .map_err(|e| AppError::internal(format!("执行 say 命令失败: {}", e)))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(AppError::internal(format!("TTS 失败: {}", stderr)))
        }
    })
    .await
    .map_err(|e| AppError::internal(format!("TTS 任务调度失败: {}", e)))?
}

#[cfg(target_os = "linux")]
async fn speak_linux(
    text: &str,
    lang: Option<&str>,
    rate: Option<f32>,
    _volume: Option<f32>,
) -> Result<(), AppError> {
    let text = text.to_string();
    let lang = lang.map(|value| value.to_string());

    // espeak 会阻塞直到整段语音播放完成，放到 spawn_blocking，避免阻塞异步运行时 worker 线程。
    tokio::task::spawn_blocking(move || {
        use std::process::Command;

        // 使用 espeak 命令
        let mut cmd = Command::new("espeak");

        // 设置语言
        if let Some(lang_code) = lang.as_deref() {
            let espeak_lang = match lang_code {
                "zh-CN" | "zh" => "zh",
                "en-US" | "en" => "en",
                "ja-JP" | "ja" => "ja",
                _ => "en",
            };
            cmd.arg("-v").arg(espeak_lang);
        }

        // 设置语速 (espeak 使用 words per minute)
        if let Some(r) = rate {
            let wpm = (175.0 * r) as u32;
            cmd.arg("-s").arg(wpm.to_string());
        }

        cmd.arg(&text);

        let output = cmd
            .output()
            .map_err(|e| AppError::internal(format!("执行 espeak 命令失败: {}", e)))?;

        if output.status.success() {
            Ok(())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(AppError::internal(format!("TTS 失败: {}", stderr)))
        }
    })
    .await
    .map_err(|e| AppError::internal(format!("TTS 任务调度失败: {}", e)))?
}
