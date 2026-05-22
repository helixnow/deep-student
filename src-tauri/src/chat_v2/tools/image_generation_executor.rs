//! Chat V2 内置图片生成工具执行器

use async_trait::async_trait;
use base64::{engine::general_purpose::STANDARD, Engine as _};
use chrono::Utc;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE};
use serde_json::{json, Value};
use std::time::Instant;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::types::strip_tool_namespace;
use crate::chat_v2::events::event_types;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::llm_manager::ApiConfig;
use crate::vfs::repos::{VfsAttachmentRepo, VfsFolderRepo, VfsResourceRepo};
use crate::vfs::types::{
    VfsFolder, VfsResourceMetadata, VfsResourceType, VfsUploadAttachmentParams,
};

const TOOL_NAME: &str = "image_generate";
const TOOL_TIMEOUT_SECS: u64 = 300;
const DEFAULT_FOLDER_TITLE: &str = "AI 生成图片";

#[derive(Debug, Clone)]
struct ImageGenerationArgs {
    prompt: String,
    aspect_ratio: String,
    quality: String,
    purpose: Option<String>,
}

#[derive(Debug, Clone)]
struct ImageGenerationModel {
    config: ApiConfig,
    provider: String,
}

#[derive(Debug, Clone)]
struct GeneratedImageBytes {
    bytes: Vec<u8>,
    b64: String,
    mime_type: String,
    revised_prompt: Option<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct ParsedImageGenerationResponse {
    b64_json: Option<String>,
    url: Option<String>,
    revised_prompt: Option<String>,
}

/// Chat V2 内置图片生成工具。
pub struct ImageGenerationExecutor;

impl ImageGenerationExecutor {
    pub fn new() -> Self {
        Self
    }

    fn parse_args(arguments: &Value) -> Result<ImageGenerationArgs, String> {
        let prompt = arguments
            .get("prompt")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| "图片生成需要 prompt 参数".to_string())?
            .to_string();

        let aspect_ratio = arguments
            .get("aspectRatio")
            .or_else(|| arguments.get("aspect_ratio"))
            .and_then(Value::as_str)
            .unwrap_or("1:1");
        let aspect_ratio = match aspect_ratio {
            "1:1" | "4:3" | "3:4" | "16:9" | "9:16" => aspect_ratio.to_string(),
            _ => "1:1".to_string(),
        };

        let quality = arguments
            .get("quality")
            .and_then(Value::as_str)
            .unwrap_or("auto");
        let quality = match quality {
            "auto" | "low" | "medium" | "high" => quality.to_string(),
            _ => "auto".to_string(),
        };

        let purpose = arguments
            .get("purpose")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);

        Ok(ImageGenerationArgs {
            prompt,
            aspect_ratio,
            quality,
            purpose,
        })
    }

    async fn resolve_model(ctx: &ExecutionContext) -> Result<ImageGenerationModel, String> {
        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or_else(|| "LLM 管理器不可用，无法读取生图模型配置".to_string())?;
        let assignments = llm_manager
            .get_model_assignments()
            .await
            .map_err(|e| format!("读取模型分配失败: {}", e))?;
        let configs = llm_manager
            .get_api_configs()
            .await
            .map_err(|e| format!("读取 API 配置失败: {}", e))?;

        if let Some(config_id) = assignments
            .image_generation_model_config_id
            .as_deref()
            .filter(|id| !id.trim().is_empty())
        {
            let cfg = configs
                .iter()
                .find(|cfg| cfg.id == config_id)
                .cloned()
                .ok_or_else(|| format!("已选择的生图模型不存在: {}", config_id))?;
            Self::validate_model_config(&cfg)?;
            return Ok(ImageGenerationModel {
                provider: provider_label(&cfg),
                config: cfg,
            });
        }

        let cfg = configs
            .iter()
            .find(|cfg| cfg.enabled && is_image_generation_config(cfg))
            .cloned()
            .ok_or_else(|| "未配置可用的生图模型，请先在设置中选择“生图模型”".to_string())?;
        Self::validate_model_config(&cfg)?;
        Ok(ImageGenerationModel {
            provider: provider_label(&cfg),
            config: cfg,
        })
    }

    fn validate_model_config(config: &ApiConfig) -> Result<(), String> {
        if config.base_url.trim().is_empty() {
            return Err("生图模型缺少 Base URL".to_string());
        }
        if config.model.trim().is_empty() {
            return Err("生图模型缺少 model 名称".to_string());
        }
        if config.api_key.trim().is_empty()
            || config.api_key.trim() == "***"
            || config.api_key.trim().chars().all(|c| c == '*')
        {
            return Err("生图模型缺少 API key".to_string());
        }
        if !config.enabled {
            return Err("生图模型未启用，或 API key 不可用".to_string());
        }
        Ok(())
    }

    async fn request_image(
        args: &ImageGenerationArgs,
        model: &ImageGenerationModel,
    ) -> Result<GeneratedImageBytes, String> {
        let (_, _, size) = image_size_for_config(Some(&model.config), &args.aspect_ratio);
        let endpoint = build_image_generation_url(&model.config.base_url)?;
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(TOOL_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("创建生图 HTTP 客户端失败: {}", e))?;

        let payload = json!({
            "model": model.config.model,
            "prompt": args.prompt,
            "size": size,
            "quality": args.quality,
            "n": 1,
        });

        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {}", model.config.api_key.trim()))
                .map_err(|e| format!("API key 头部格式无效: {}", e))?,
        );
        headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
        if let Some(extra_headers) = &model.config.headers {
            for (key, value) in extra_headers {
                if key.eq_ignore_ascii_case("authorization")
                    || key.eq_ignore_ascii_case("content-type")
                {
                    continue;
                }
                let Ok(name) = HeaderName::from_bytes(key.as_bytes()) else {
                    log::warn!(
                        "[ImageGenerationExecutor] Skip invalid header name: {}",
                        key
                    );
                    continue;
                };
                let Ok(value) = HeaderValue::from_str(value) else {
                    log::warn!(
                        "[ImageGenerationExecutor] Skip invalid header value: {}",
                        key
                    );
                    continue;
                };
                headers.insert(name, value);
            }
        }

        let response = client
            .post(endpoint)
            .headers(headers)
            .json(&payload)
            .send()
            .await
            .map_err(|e| format!("生图请求失败: {}", e))?;
        let status = response.status();
        let body = response
            .text()
            .await
            .map_err(|e| format!("读取生图响应失败: {}", e))?;
        let value: Value = serde_json::from_str(&body)
            .map_err(|e| format!("生图响应不是有效 JSON: {}，body={}", e, shorten(&body, 280)))?;

        if !status.is_success() {
            return Err(extract_image_api_error(&value)
                .unwrap_or_else(|| format!("生图接口返回 HTTP {}", status)));
        }

        let parsed = parse_image_generation_response(&value)?;
        if let Some(b64) = parsed.b64_json {
            let bytes = decode_base64_image_payload(&b64)?;
            let mime_type =
                infer_image_mime_type(&bytes).unwrap_or_else(|| "image/png".to_string());
            return Ok(GeneratedImageBytes {
                b64: STANDARD.encode(&bytes),
                bytes,
                mime_type,
                revised_prompt: parsed.revised_prompt,
            });
        }

        let url = parsed
            .url
            .ok_or_else(|| "生图响应没有 b64_json 或 url".to_string())?;
        let downloaded = download_image_url(&client, &url, parsed.revised_prompt).await?;
        Ok(downloaded)
    }

    fn emit_start(
        ctx: &ExecutionContext,
        args: &ImageGenerationArgs,
        model: &str,
        config: Option<&ApiConfig>,
    ) {
        let (width, height, _) = image_size_for_config(config, &args.aspect_ratio);
        ctx.emitter.emit_start_with_meta(
            event_types::IMAGE_GEN,
            &ctx.message_id,
            Some(&ctx.block_id),
            Some(json!({
                "prompt": args.prompt,
                "width": width,
                "height": height,
                "model": model,
                "params": {
                    "aspectRatio": args.aspect_ratio,
                    "quality": args.quality,
                    "purpose": args.purpose,
                }
            })),
            ctx.variant_id.as_deref(),
            ctx.skill_state_version,
            ctx.round_id.as_deref(),
        );
    }

    fn emit_end(ctx: &ExecutionContext, output: Value) {
        ctx.emitter.emit_end_with_meta(
            event_types::IMAGE_GEN,
            &ctx.block_id,
            Some(output),
            ctx.variant_id.as_deref(),
            ctx.skill_state_version,
            ctx.round_id.as_deref(),
        );
    }

    fn emit_error(ctx: &ExecutionContext, error: &str) {
        ctx.emitter.emit_error_with_meta(
            event_types::IMAGE_GEN,
            &ctx.block_id,
            error,
            ctx.variant_id.as_deref(),
            ctx.skill_state_version,
            ctx.round_id.as_deref(),
        );
    }

    fn save_to_vfs(
        ctx: &ExecutionContext,
        args: &ImageGenerationArgs,
        model: &ImageGenerationModel,
        generated: &GeneratedImageBytes,
        width: u32,
        height: u32,
    ) -> Result<Value, String> {
        let vfs_db = ctx
            .vfs_db
            .as_ref()
            .ok_or_else(|| "VFS 数据库不可用，无法保存生成图片".to_string())?;
        let folder_id = ensure_image_generation_folder(vfs_db)?;
        let file_name = build_image_file_name(&generated.mime_type);

        let upload_result = VfsAttachmentRepo::upload_with_folder(
            vfs_db,
            VfsUploadAttachmentParams {
                name: file_name.clone(),
                mime_type: generated.mime_type.clone(),
                base64_content: generated.b64.clone(),
                attachment_type: Some("image".to_string()),
            },
            Some(&folder_id),
        )
        .map_err(|e| format!("保存生成图片到 VFS 失败: {}", e))?;

        let created_at = Utc::now().to_rfc3339();
        let ref_data = json!({
            "refs": [{
                "sourceId": upload_result.source_id.clone(),
                "resourceHash": upload_result.resource_hash.clone(),
                "type": "image",
                "name": file_name.clone(),
                "resourceId": upload_result.attachment.resource_id.clone(),
            }],
            "totalCount": 1,
            "truncated": false,
        });
        let metadata = VfsResourceMetadata {
            name: Some(file_name.clone()),
            title: Some(file_name.clone()),
            mime_type: Some(generated.mime_type.clone()),
            size: Some(generated.bytes.len() as u64),
            source: Some("image_generation".to_string()),
            extra: Some(json!({
                "source": "image_generation",
                "prompt": args.prompt,
                "model": model.config.model,
                "provider": model.provider,
                "aspectRatio": args.aspect_ratio,
                "quality": args.quality,
                "purpose": args.purpose,
                "createdAt": created_at,
                "revisedPrompt": generated.revised_prompt.clone(),
                "sourceId": upload_result.source_id.clone(),
                "attachmentHash": upload_result.resource_hash.clone(),
                "folderId": folder_id,
            })),
        };

        let wrapper = VfsResourceRepo::create_or_reuse(
            vfs_db,
            VfsResourceType::Image,
            &serde_json::to_string(&ref_data)
                .map_err(|e| format!("序列化图片上下文引用失败: {}", e))?,
            Some(&upload_result.source_id),
            None,
            Some(&metadata),
        )
        .map_err(|e| format!("创建生成图片上下文引用失败: {}", e))?;

        Ok(json!({
            "imageUrl": format!("data:{};base64,{}", generated.mime_type, generated.b64),
            "sourceId": upload_result.source_id,
            "resourceId": wrapper.resource_id,
            "resourceHash": wrapper.hash,
            "attachmentHash": upload_result.resource_hash,
            "mimeType": generated.mime_type,
            "width": width,
            "height": height,
            "prompt": args.prompt,
            "model": model.config.model,
            "provider": model.provider,
            "params": {
                "aspectRatio": args.aspect_ratio,
                "quality": args.quality,
                "purpose": args.purpose,
            },
            "revisedPrompt": generated.revised_prompt.clone(),
            "fileName": file_name,
            "folderId": folder_id,
        }))
    }
}

impl Default for ImageGenerationExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for ImageGenerationExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        strip_tool_namespace(tool_name) == TOOL_NAME
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let args = match Self::parse_args(&call.arguments) {
            Ok(args) => args,
            Err(error) => {
                Self::emit_error(ctx, &error);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        let model = match Self::resolve_model(ctx).await {
            Ok(model) => model,
            Err(error) => {
                Self::emit_start(ctx, &args, "", None);
                Self::emit_error(ctx, &error);
                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    start_time.elapsed().as_millis() as u64,
                );
                let _ = ctx.save_tool_block(&result);
                return Ok(result);
            }
        };

        Self::emit_start(ctx, &args, &model.config.model, Some(&model.config));
        let (requested_width, requested_height, _) =
            image_size_for_config(Some(&model.config), &args.aspect_ratio);

        let result = match Self::request_image(&args, &model).await {
            Ok(generated) => {
                let (width, height) = image_dimensions(&generated.bytes)
                    .unwrap_or((requested_width, requested_height));
                match Self::save_to_vfs(ctx, &args, &model, &generated, width, height) {
                    Ok(output) => {
                        Self::emit_end(ctx, output.clone());
                        ToolResultInfo::success(
                            Some(call.id.clone()),
                            Some(ctx.block_id.clone()),
                            call.name.clone(),
                            call.arguments.clone(),
                            output,
                            start_time.elapsed().as_millis() as u64,
                        )
                    }
                    Err(error) => {
                        Self::emit_error(ctx, &error);
                        ToolResultInfo::failure(
                            Some(call.id.clone()),
                            Some(ctx.block_id.clone()),
                            call.name.clone(),
                            call.arguments.clone(),
                            error,
                            start_time.elapsed().as_millis() as u64,
                        )
                    }
                }
            }
            Err(error) => {
                Self::emit_error(ctx, &error);
                ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    start_time.elapsed().as_millis() as u64,
                )
            }
        };

        if let Err(e) = ctx.save_tool_block(&result) {
            log::warn!("[ImageGenerationExecutor] Failed to save tool block: {}", e);
        }
        Ok(result)
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn name(&self) -> &'static str {
        "ImageGenerationExecutor"
    }
}

fn image_size_for_aspect_ratio(aspect_ratio: &str) -> (u32, u32, String) {
    let (width, height) = match aspect_ratio {
        "4:3" | "16:9" => (1536, 1024),
        "3:4" | "9:16" => (1024, 1536),
        _ => (1024, 1024),
    };
    (width, height, format!("{}x{}", width, height))
}

fn image_size_for_sensenova(aspect_ratio: &str) -> (u32, u32, String) {
    let (width, height) = match aspect_ratio {
        "4:3" => (2368, 1760),
        "16:9" => (2752, 1536),
        "3:4" => (1760, 2368),
        "9:16" => (1536, 2752),
        _ => (2048, 2048),
    };
    (width, height, format!("{}x{}", width, height))
}

fn image_size_for_config(config: Option<&ApiConfig>, aspect_ratio: &str) -> (u32, u32, String) {
    if config.is_some_and(is_sensenova_config) {
        return image_size_for_sensenova(aspect_ratio);
    }
    image_size_for_aspect_ratio(aspect_ratio)
}

fn build_image_generation_url(base_url: &str) -> Result<String, String> {
    let trimmed = base_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("Base URL 为空".to_string());
    }
    reqwest::Url::parse(trimmed).map_err(|e| format!("Base URL 无效: {}", e))?;
    if trimmed.ends_with("/images/generations") {
        Ok(trimmed.to_string())
    } else {
        Ok(format!("{}/images/generations", trimmed))
    }
}

fn parse_image_generation_response(value: &Value) -> Result<ParsedImageGenerationResponse, String> {
    if let Some(message) = extract_image_api_error(value) {
        return Err(message);
    }

    let first = value
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "生图响应缺少 data[0]".to_string())?;

    let parsed = ParsedImageGenerationResponse {
        b64_json: first
            .get("b64_json")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(ToString::to_string),
        url: first
            .get("url")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(ToString::to_string),
        revised_prompt: first
            .get("revised_prompt")
            .or_else(|| first.get("revisedPrompt"))
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            .map(ToString::to_string),
    };

    if parsed.b64_json.is_none() && parsed.url.is_none() {
        return Err("生图响应缺少 b64_json 或 url".to_string());
    }

    Ok(parsed)
}

fn extract_image_api_error(value: &Value) -> Option<String> {
    value
        .get("error")
        .and_then(|err| {
            err.get("message")
                .and_then(Value::as_str)
                .or_else(|| err.as_str())
        })
        .map(|message| {
            if message.to_lowercase().contains("policy") {
                format!("图片生成被安全策略拒绝: {}", message)
            } else {
                message.to_string()
            }
        })
}

async fn download_image_url(
    client: &reqwest::Client,
    url: &str,
    revised_prompt: Option<String>,
) -> Result<GeneratedImageBytes, String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("生图 URL 无效: {}", e))?;
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return Err("生图 URL 只支持 http/https".to_string());
    }

    let response = client
        .get(parsed)
        .send()
        .await
        .map_err(|e| format!("下载生成图片失败: {}", e))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("下载生成图片返回 HTTP {}", status));
    }
    let content_type = response
        .headers()
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .filter(|value| value.starts_with("image/"))
        .map(ToString::to_string);
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取生成图片 bytes 失败: {}", e))?
        .to_vec();
    let mime_type = content_type
        .or_else(|| infer_image_mime_type(&bytes))
        .unwrap_or_else(|| "image/png".to_string());
    let b64 = STANDARD.encode(&bytes);

    Ok(GeneratedImageBytes {
        bytes,
        b64,
        mime_type,
        revised_prompt,
    })
}

fn decode_base64_image_payload(payload: &str) -> Result<Vec<u8>, String> {
    let data = payload
        .split_once(',')
        .filter(|(prefix, _)| prefix.starts_with("data:"))
        .map(|(_, data)| data)
        .unwrap_or(payload)
        .trim();
    STANDARD
        .decode(data)
        .map_err(|e| format!("解析生图 base64 失败: {}", e))
}

fn infer_image_mime_type(bytes: &[u8]) -> Option<String> {
    let format = image::guess_format(bytes).ok()?;
    let mime = match format {
        image::ImageFormat::Png => "image/png",
        image::ImageFormat::Jpeg => "image/jpeg",
        image::ImageFormat::Gif => "image/gif",
        image::ImageFormat::WebP => "image/webp",
        image::ImageFormat::Bmp => "image/bmp",
        image::ImageFormat::Tiff => "image/tiff",
        _ => return None,
    };
    Some(mime.to_string())
}

fn image_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    let image = image::load_from_memory(bytes).ok()?;
    Some((image.width(), image.height()))
}

fn ensure_image_generation_folder(
    vfs_db: &crate::vfs::database::VfsDatabase,
) -> Result<String, String> {
    let conn = vfs_db.get_conn_safe().map_err(|e| e.to_string())?;
    if let Some(folder) = VfsFolderRepo::list_folders_by_parent_with_conn(&conn, None)
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|folder| folder.title == DEFAULT_FOLDER_TITLE)
    {
        return Ok(folder.id);
    }

    let folder = VfsFolder::new(
        DEFAULT_FOLDER_TITLE.to_string(),
        None,
        Some("image".to_string()),
        Some("blue".to_string()),
    );
    VfsFolderRepo::create_folder_with_conn(&conn, &folder).map_err(|e| e.to_string())?;
    Ok(folder.id)
}

fn build_image_file_name(mime_type: &str) -> String {
    let extension = match mime_type {
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/bmp" => "bmp",
        _ => "png",
    };
    format!(
        "ai-generated-image-{}.{}",
        Utc::now().format("%Y%m%d-%H%M%S"),
        extension
    )
}

fn is_image_generation_config(config: &ApiConfig) -> bool {
    config.is_image_generation || looks_like_image_generation_model(config)
}

fn looks_like_image_generation_model(config: &ApiConfig) -> bool {
    let haystack = format!(
        "{} {} {}",
        config.name,
        config.model,
        config.provider_type.as_deref().unwrap_or_default()
    )
    .to_lowercase();
    ["gpt-image", "dall-e", "image", "imagen", "flux"]
        .iter()
        .any(|needle| haystack.contains(needle))
}

fn provider_label(config: &ApiConfig) -> String {
    config
        .vendor_name
        .clone()
        .or_else(|| config.provider_type.clone())
        .unwrap_or_else(|| "OpenAI Compatible".to_string())
}

fn is_sensenova_config(config: &ApiConfig) -> bool {
    let haystack = format!(
        "{} {} {} {}",
        config.vendor_name.as_deref().unwrap_or_default(),
        config.provider_type.as_deref().unwrap_or_default(),
        config.model,
        config.base_url,
    )
    .to_lowercase();

    haystack.contains("sensenova") || haystack.contains("sense nova")
}

fn shorten(value: &str, max_len: usize) -> String {
    if value.len() <= max_len {
        return value.to_string();
    }
    let mut out = String::new();
    for ch in value.chars() {
        if out.len() + ch.len_utf8() > max_len {
            break;
        }
        out.push(ch);
    }
    format!("{}...", out)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn maps_supported_aspect_ratios_to_openai_image_sizes() {
        assert_eq!(
            image_size_for_aspect_ratio("1:1"),
            (1024, 1024, "1024x1024".to_string())
        );
        assert_eq!(
            image_size_for_aspect_ratio("4:3"),
            (1536, 1024, "1536x1024".to_string())
        );
        assert_eq!(
            image_size_for_aspect_ratio("16:9"),
            (1536, 1024, "1536x1024".to_string())
        );
        assert_eq!(
            image_size_for_aspect_ratio("3:4"),
            (1024, 1536, "1024x1536".to_string())
        );
        assert_eq!(
            image_size_for_aspect_ratio("9:16"),
            (1024, 1536, "1024x1536".to_string())
        );
        assert_eq!(
            image_size_for_aspect_ratio("unexpected"),
            (1024, 1024, "1024x1024".to_string())
        );
    }

    #[test]
    fn maps_supported_aspect_ratios_to_sensenova_image_sizes() {
        let config = ApiConfig {
            name: "SenseNova Image".to_string(),
            model: "sense-image-v1".to_string(),
            vendor_name: Some("SenseNova".to_string()),
            provider_type: Some("openai-compatible".to_string()),
            base_url: "https://api.sensenova.cn/compatible-mode/v1".to_string(),
            ..Default::default()
        };

        assert_eq!(
            image_size_for_config(Some(&config), "1:1"),
            (2048, 2048, "2048x2048".to_string())
        );
        assert_eq!(
            image_size_for_config(Some(&config), "4:3"),
            (2368, 1760, "2368x1760".to_string())
        );
        assert_eq!(
            image_size_for_config(Some(&config), "16:9"),
            (2752, 1536, "2752x1536".to_string())
        );
        assert_eq!(
            image_size_for_config(Some(&config), "3:4"),
            (1760, 2368, "1760x2368".to_string())
        );
        assert_eq!(
            image_size_for_config(Some(&config), "9:16"),
            (1536, 2752, "1536x2752".to_string())
        );
        assert_eq!(
            image_size_for_config(Some(&config), "unexpected"),
            (2048, 2048, "2048x2048".to_string())
        );
    }

    #[test]
    fn builds_image_generation_endpoint_without_double_slashes() {
        assert_eq!(
            build_image_generation_url("https://api.openai.com/v1").unwrap(),
            "https://api.openai.com/v1/images/generations"
        );
        assert_eq!(
            build_image_generation_url("https://api.openai.com/v1/").unwrap(),
            "https://api.openai.com/v1/images/generations"
        );
        assert_eq!(
            build_image_generation_url("https://proxy.example/images/generations").unwrap(),
            "https://proxy.example/images/generations"
        );
    }

    #[test]
    fn parses_b64_json_before_url_response() {
        let parsed = parse_image_generation_response(&json!({
            "data": [{
                "b64_json": "aW1hZ2U=",
                "url": "https://example.com/image.png",
                "revised_prompt": "cleaned prompt"
            }]
        }))
        .unwrap();

        assert_eq!(parsed.b64_json.as_deref(), Some("aW1hZ2U="));
        assert_eq!(parsed.url.as_deref(), Some("https://example.com/image.png"));
        assert_eq!(parsed.revised_prompt.as_deref(), Some("cleaned prompt"));
    }

    #[test]
    fn returns_openai_error_message_when_present() {
        let err = parse_image_generation_response(&json!({
            "error": { "message": "content policy violation" }
        }))
        .unwrap_err();

        assert!(err.contains("content policy violation"));
    }

    #[test]
    fn decodes_data_url_base64_payloads() {
        let bytes = decode_base64_image_payload("data:image/png;base64,aW1hZ2U=").unwrap();
        assert_eq!(bytes, b"image");
    }

    #[test]
    fn recognizes_explicit_image_generation_model_flag() {
        let config = ApiConfig {
            name: "Learning Illustration".to_string(),
            model: "custom-render-v1".to_string(),
            provider_type: Some("openai-compatible".to_string()),
            is_image_generation: true,
            ..Default::default()
        };

        assert!(is_image_generation_config(&config));
    }
}
