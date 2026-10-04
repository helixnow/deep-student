//! HEIC/HEIF → JPEG 原生转码桥（Android）。
//!
//! 背景：
//! - 前端旧方案 heic2any 的 Emscripten/embind 胶水在运行期用 `new Function`
//!   生成调用器，release CSP `script-src 'self'` 下必然抛 EvalError，
//!   转码 100% 失败并静默回退为原始 HEIC（缩略图破裂、LLM 供应商拒收）。
//! - 不放宽 CSP 的前提下，解码只能交给平台原生解码器：
//!   WebKit（macOS/iOS）在前端用 `createImageBitmap` + canvas 完成；
//!   Android System WebView 不支持 HEIC，但 Android 9+ 的 `ImageDecoder`
//!   原生支持 HEIF，由 Kotlin 插件 `HeicDecoderPlugin` 完成解码 + JPEG 编码。
//! - 纯 Rust 侧没有成熟的 HEVC 解码器，因此 Rust 只负责搬运字节：
//!   原始字节经 raw IPC body 进来 → 写入应用缓存临时文件 → Kotlin 解码写出
//!   JPEG 临时文件 → Rust 读回并以 `ipc::Response` 原始二进制返回。
//!   避免把数 MB 的 base64 塞进 JSON / JNI 通道。
//!
//! 配套文件（版本控制内的受控副本，构建时同步进 gen/android）：
//! - `src-tauri/mobile/android/HeicDecoderPlugin.kt`

use crate::models::AppError;
use tauri::plugin::TauriPlugin;
use tauri::AppHandle;

type Result<T> = std::result::Result<T, AppError>;

/// 与 VFS 图片上限（attachment_repo MAX_IMAGE_BYTES）保持一致。
const MAX_HEIC_INPUT_BYTES: usize = 50 * 1024 * 1024;
/// 输出像素上限：约 16MP，低于 iOS canvas 面积上限且远超 LLM 视觉输入所需分辨率。
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const MAX_OUTPUT_PIXELS: u64 = 16_000_000;
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
const JPEG_QUALITY: u8 = 90;

/// 持有 Android 插件 handle 的托管状态。
#[cfg(target_os = "android")]
pub(crate) struct HeicDecoderHandle(pub(crate) tauri::plugin::PluginHandle<tauri::Wry>);

pub fn init() -> TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("heic-decoder")
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            {
                let handle =
                    api.register_android_plugin("com.deepstudent.app", "HeicDecoderPlugin")?;
                tauri::Manager::manage(app, HeicDecoderHandle(handle));
            }
            let _ = app;
            let _ = api;
            Ok(())
        })
        .build()
}

fn extract_raw_body(request: &tauri::ipc::Request<'_>) -> Result<Vec<u8>> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => {
            if bytes.is_empty() {
                return Err(AppError::validation("HEIC_INVALID_INPUT: empty image body"));
            }
            if bytes.len() > MAX_HEIC_INPUT_BYTES {
                return Err(AppError::validation(format!(
                    "HEIC_INVALID_INPUT: image exceeds {} MB",
                    MAX_HEIC_INPUT_BYTES / 1024 / 1024
                )));
            }
            Ok(bytes.clone())
        }
        _ => Err(AppError::validation(
            "HEIC_INVALID_INPUT: expected raw binary request body",
        )),
    }
}

/// 把 HEIC/HEIF 原始字节转为 JPEG 原始字节。
///
/// 仅 Android 有原生实现；其他平台返回 `HEIC_UNSUPPORTED_PLATFORM`
/// （桌面/iOS 由前端 WebView 原生解码，不应走到这里）。
/// 请求体必须是 raw 二进制（前端 `invoke(cmd, uint8Array)`）。
#[tauri::command]
pub async fn convert_heic_to_jpeg(
    app: AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response> {
    let input = extract_raw_body(&request)?;

    #[cfg(target_os = "android")]
    {
        use tauri::Manager;

        let state = app
            .try_state::<HeicDecoderHandle>()
            .ok_or_else(|| AppError::unknown("HEIC_DECODE_FAILED: heic-decoder plugin not initialized"))?;
        let plugin = state.0.clone();

        let cache_dir = app
            .path()
            .app_cache_dir()
            .map_err(|e| AppError::file_system(format!("HEIC_DECODE_FAILED: cache dir: {e}")))?
            .join("heic-convert");
        let token = uuid::Uuid::new_v4().simple().to_string();
        let input_path = cache_dir.join(format!("{token}.heic"));
        let output_path = cache_dir.join(format!("{token}.jpg"));

        let result = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>> {
            std::fs::create_dir_all(&cache_dir)
                .map_err(|e| AppError::file_system(format!("HEIC_DECODE_FAILED: {e}")))?;
            let outcome = (|| -> Result<Vec<u8>> {
                std::fs::write(&input_path, &input)
                    .map_err(|e| AppError::file_system(format!("HEIC_DECODE_FAILED: {e}")))?;
                let payload = serde_json::json!({
                    "inputPath": input_path.to_string_lossy(),
                    "outputPath": output_path.to_string_lossy(),
                    "quality": JPEG_QUALITY,
                    "maxPixels": MAX_OUTPUT_PIXELS,
                });
                plugin
                    .run_mobile_plugin::<serde_json::Value>("convertToJpeg", payload)
                    .map_err(|e| AppError::unknown(e.to_string()))?;
                let jpeg = std::fs::read(&output_path)
                    .map_err(|e| AppError::file_system(format!("HEIC_DECODE_FAILED: {e}")))?;
                if jpeg.is_empty() {
                    return Err(AppError::unknown("HEIC_DECODE_FAILED: empty JPEG output"));
                }
                Ok(jpeg)
            })();
            let _ = std::fs::remove_file(&input_path);
            let _ = std::fs::remove_file(&output_path);
            outcome
        })
        .await
        .map_err(|e| AppError::unknown(format!("HEIC_DECODE_FAILED: task join error: {e}")))??;

        return Ok(tauri::ipc::Response::new(result));
    }

    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, input);
        Err(AppError::validation(
            "HEIC_UNSUPPORTED_PLATFORM: native HEIC conversion is only available on Android",
        ))
    }
}

