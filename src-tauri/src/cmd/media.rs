//! 媒体处理命令（移动端支撑）
//!
//! 提供 `compress_image`：上传前在 Rust 侧压缩图片（长边缩放 + JPEG 重编码），
//! 供聊天附件 / 笔记资产（`notes_save_asset`）上传链路在弱网/移动端降低载荷。
//! 前端接线由 UI 代理后续完成，本模块零业务耦合。

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use image::imageops::FilterType;
use serde::Serialize;

/// 默认长边上限（px）
const DEFAULT_MAX_EDGE: u32 = 2048;
/// 默认 JPEG 质量
const DEFAULT_QUALITY: u8 = 80;

/// 压缩结果
///
/// `output_mode = "bytes"`（默认）时填充 `bytes_base64`；
/// `output_mode = "file"` 时填充 `file_path`（系统临时目录下的 .jpg，
/// 调用方使用完毕后自行决定是否清理）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressImageResult {
    /// 压缩后图片（base64 编码 JPEG），output_mode = "bytes" 时返回
    pub bytes_base64: Option<String>,
    /// 压缩后临时文件路径，output_mode = "file" 时返回
    pub file_path: Option<String>,
    /// 压缩后尺寸
    pub width: u32,
    pub height: u32,
    /// 原始尺寸
    pub original_width: u32,
    pub original_height: u32,
    /// 原始字节数
    pub original_size: u64,
    /// 压缩后字节数
    pub compressed_size: u64,
    /// 输出格式（固定 "jpeg"）
    pub format: String,
}

/// 压缩图片（长边缩放 + JPEG 重编码）
///
/// ## 参数（source_path / bytes_base64 二选一，同时提供时优先 source_path）
/// - `source_path`: 源图片的绝对路径
/// - `bytes_base64`: 源图片 bytes 的 base64 编码
/// - `max_edge`: 长边上限（px），缺省 2048；源图长边不超过该值时不缩放
/// - `quality`: JPEG 质量 1-100，缺省 80（clamp 到 [10, 95]）
/// - `output_mode`: `"bytes"`（缺省，返回 base64）或 `"file"`（写入临时文件返回路径）
///
/// ## 说明
/// - 输出统一为 JPEG（带 alpha 的源图会先合成到 RGB），移动端上传场景以体积优先。
/// - CPU 密集操作在 `spawn_blocking` 中执行，不阻塞异步 runtime。
#[tauri::command]
pub async fn compress_image(
    source_path: Option<String>,
    bytes_base64: Option<String>,
    max_edge: Option<u32>,
    quality: Option<u8>,
    output_mode: Option<String>,
) -> Result<CompressImageResult, String> {
    tokio::task::spawn_blocking(move || {
        compress_image_blocking(source_path, bytes_base64, max_edge, quality, output_mode)
    })
    .await
    .map_err(|e| format!("图片压缩任务调度失败: {}", e))?
}

fn compress_image_blocking(
    source_path: Option<String>,
    bytes_base64: Option<String>,
    max_edge: Option<u32>,
    quality: Option<u8>,
    output_mode: Option<String>,
) -> Result<CompressImageResult, String> {
    // 1. 取源 bytes
    let source_bytes: Vec<u8> = match (source_path.as_deref(), bytes_base64.as_deref()) {
        (Some(path), _) => {
            std::fs::read(path).map_err(|e| format!("读取源图片失败 ({}): {}", path, e))?
        }
        (None, Some(b64)) => BASE64
            .decode(b64)
            .map_err(|e| format!("base64 解码失败: {}", e))?,
        (None, None) => {
            return Err("必须提供 sourcePath 或 bytesBase64 之一".to_string());
        }
    };
    let original_size = source_bytes.len() as u64;

    // 2. 解码
    let img = image::load_from_memory(&source_bytes)
        .map_err(|e| format!("图片解码失败: {}", e))?;
    let (original_width, original_height) = (img.width(), img.height());

    // 3. 长边缩放（不放大）
    let max_edge = max_edge.unwrap_or(DEFAULT_MAX_EDGE).max(1);
    let longest = original_width.max(original_height);
    let img = if longest > max_edge {
        // resize 保持宽高比，以 (max_edge, max_edge) 为包围盒
        img.resize(max_edge, max_edge, FilterType::Triangle)
    } else {
        img
    };
    let (width, height) = (img.width(), img.height());

    // 4. JPEG 重编码（丢弃 alpha，体积优先）
    let quality = quality.unwrap_or(DEFAULT_QUALITY).clamp(10, 95);
    let rgb = image::DynamicImage::ImageRgb8(img.to_rgb8());
    let mut encoded: Vec<u8> = Vec::new();
    {
        let mut cursor = std::io::Cursor::new(&mut encoded);
        rgb.write_to(&mut cursor, image::ImageOutputFormat::Jpeg(quality))
            .map_err(|e| format!("JPEG 编码失败: {}", e))?;
    }
    let compressed_size = encoded.len() as u64;

    // 5. 按输出模式返回
    let as_file = matches!(output_mode.as_deref(), Some("file"));
    if as_file {
        let file_path = std::env::temp_dir().join(format!(
            "dstu_compressed_{}.jpg",
            uuid::Uuid::new_v4().simple()
        ));
        std::fs::write(&file_path, &encoded)
            .map_err(|e| format!("写入临时文件失败: {}", e))?;
        Ok(CompressImageResult {
            bytes_base64: None,
            file_path: Some(file_path.to_string_lossy().into_owned()),
            width,
            height,
            original_width,
            original_height,
            original_size,
            compressed_size,
            format: "jpeg".to_string(),
        })
    } else {
        Ok(CompressImageResult {
            bytes_base64: Some(BASE64.encode(&encoded)),
            file_path: None,
            width,
            height,
            original_width,
            original_height,
            original_size,
            compressed_size,
            format: "jpeg".to_string(),
        })
    }
}
