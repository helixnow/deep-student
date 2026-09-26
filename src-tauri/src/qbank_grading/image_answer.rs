//! 图片作答信封（image_answer）解析与取图。
//!
//! 契约与前端 `src/api/questionBankApi.ts` 的
//! `parseImageAnswerEnvelope` / `encodeUserAnswer` 对齐：
//! `user_answer = {"type":"image_answer","images":[{id,name,mime,hash}],"text":…}`。
//! 信封只存 VFS 附件 ID 引用；评判时经 `AttachmentRepo::get_content_bounded`
//! 取回 base64 送多模态模型。上限与 essay_grading 对齐（每类 6 张 /
//! 单张 50MB / 合计 100MB）。

use serde::Deserialize;

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::VfsAttachmentRepo;

/// 信封允许的图片 MIME 白名单（与前端 IMAGE_ANSWER_MIME_TYPES 一致）
pub const IMAGE_ANSWER_MIME_TYPES: &[&str] =
    &["image/png", "image/jpeg", "image/webp", "image/gif"];

/// 单次作答的答案图片上限（与 essay_grading::MAX_IMAGES_PER_KIND 对齐）
pub const IMAGE_ANSWER_MAX_IMAGES: usize = 6;

/// 单张图片 base64 解码后上限（与 essay_grading::MAX_IMAGE_DECODED_BYTES 一致，50MB）
pub const IMAGE_ANSWER_MAX_DECODED_BYTES: usize = 50 * 1024 * 1024;

/// 所有答案图片解码后合计上限（与 essay_grading::MAX_TOTAL_IMAGE_DECODED_BYTES 一致，100MB）
pub const IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES: usize = 100 * 1024 * 1024;

/// 解析后的图片作答载荷
#[derive(Debug, Clone, PartialEq)]
pub struct ImageAnswerPayload {
    /// VFS 附件引用（id 用于取内容，name/mime/hash 供展示与日志）
    pub images: Vec<ImageAnswerImage>,
    /// 可选文字补充（信封 text 字段，缺省空串）
    pub text: String,
}

/// 信封里的单张图片引用
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct ImageAnswerImage {
    pub id: String,
    #[allow(dead_code)] // 前端契约字段；评判侧只用 id，保留以完整反序列化
    pub name: String,
    pub mime: String,
    #[allow(dead_code)]
    pub hash: String,
}

#[derive(Deserialize)]
struct EnvelopeShape {
    #[serde(rename = "type")]
    kind: String,
    images: Vec<serde_json::Value>,
    #[serde(default)]
    text: serde_json::Value,
}

/// 宽松解析图片作答信封：只认 `{"type":"image_answer",…}` 形态；
/// 结构非法、images 为空/超上限、任一元素缺字段或 mime 不在白名单 → None，
/// 调用方按原文本作答处理。
pub fn parse_image_answer_envelope(raw: &str) -> Option<ImageAnswerPayload> {
    let trimmed = raw.trim();
    if !trimmed.starts_with('{') {
        return None;
    }
    let shape: EnvelopeShape = serde_json::from_str(trimmed).ok()?;
    if shape.kind != "image_answer" {
        return None;
    }
    if shape.images.is_empty() || shape.images.len() > IMAGE_ANSWER_MAX_IMAGES {
        return None;
    }
    let mut images = Vec::with_capacity(shape.images.len());
    for value in &shape.images {
        let image: ImageAnswerImage = serde_json::from_value(value.clone()).ok()?;
        if image.id.trim().is_empty() {
            return None;
        }
        if !IMAGE_ANSWER_MIME_TYPES.contains(&image.mime.as_str()) {
            return None;
        }
        images.push(image);
    }
    let text = match shape.text {
        serde_json::Value::String(s) => s,
        serde_json::Value::Null => String::new(),
        _ => return None,
    };
    Some(ImageAnswerPayload { images, text })
}

/// 校验已取回图片的体积上限（估算口径与 essay_grading::estimated_decoded_len 一致）。
/// 超限返回结构化 Validation 错误（不静默丢图——判分丢图等于误判）。
fn validate_image_sizes(images: &[String]) -> Result<(), AppError> {
    let mut total: usize = 0;
    for (index, image) in images.iter().enumerate() {
        let bytes = estimated_decoded_len(image);
        if bytes > IMAGE_ANSWER_MAX_DECODED_BYTES {
            return Err(AppError::validation(format!(
                "答案图片第 {} 张体积超限：约 {:.1}MB（单张最大 {}MB），请压缩后重新上传",
                index + 1,
                bytes as f64 / (1024.0 * 1024.0),
                IMAGE_ANSWER_MAX_DECODED_BYTES / (1024 * 1024)
            )));
        }
        total = total.saturating_add(bytes);
    }
    if total > IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES {
        return Err(AppError::validation(format!(
            "答案图片总体积超限：约 {:.1}MB（合计最大 {}MB），请减少图片数量或压缩后重试",
            total as f64 / (1024.0 * 1024.0),
            IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES / (1024 * 1024)
        )));
    }
    Ok(())
}

/// 估算 base64 负载解码后的字节数（兼容 data URI 前缀，无需实际解码）
fn estimated_decoded_len(base64_data: &str) -> usize {
    let payload = match base64_data.split_once(',') {
        Some((prefix, rest)) if prefix.starts_with("data:") => rest,
        _ => base64_data,
    };
    payload.trim().len().saturating_mul(3) / 4
}

/// 按信封引用逐张取回图片 base64 内容。
///
/// 任一附件取不到（已删除 / 云同步未到 / 引用悬空）→ 整体报错并点名缺失的
/// 附件 ID：图片作答判分丢图等于判空白卷，绝不静默降级为纯文本。
pub fn fetch_image_answer_contents(
    db: &VfsDatabase,
    payload: &ImageAnswerPayload,
) -> Result<Vec<String>, AppError> {
    let mut contents = Vec::with_capacity(payload.images.len());
    for image in &payload.images {
        let content = VfsAttachmentRepo::get_content_bounded(
            db,
            &image.id,
            IMAGE_ANSWER_MAX_DECODED_BYTES as u64,
        )
        .map_err(|e| AppError::database(format!("读取答案图片失败（附件 {}）：{}", image.id, e)))?
        .ok_or_else(|| {
            AppError::not_found(format!(
                "答案图片不存在或尚未同步到本机（附件 {}），无法评判。请重新上传该图片。",
                image.id
            ))
        })?;
        contents.push(content);
    }
    validate_image_sizes(&contents)?;
    Ok(contents)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn envelope_json(images: serde_json::Value, text: serde_json::Value) -> String {
        serde_json::json!({ "type": "image_answer", "images": images, "text": text }).to_string()
    }

    fn image_value(id: &str, mime: &str) -> serde_json::Value {
        serde_json::json!({ "id": id, "name": format!("{id}.jpg"), "mime": mime, "hash": format!("h-{id}") })
    }

    #[test]
    fn parses_valid_envelope_with_text() {
        let raw = envelope_json(
            serde_json::json!([
                image_value("a", "image/png"),
                image_value("b", "image/jpeg")
            ]),
            serde_json::json!("第三步没写完"),
        );
        let payload = parse_image_answer_envelope(&raw).expect("envelope");
        assert_eq!(payload.images.len(), 2);
        assert_eq!(payload.images[0].id, "a");
        assert_eq!(payload.text, "第三步没写完");
    }

    #[test]
    fn parses_envelope_without_text() {
        let raw = r#"{"type":"image_answer","images":[{"id":"a","name":"a.jpg","mime":"image/jpeg","hash":"h"}]}"#;
        let payload = parse_image_answer_envelope(raw).expect("envelope");
        assert_eq!(payload.text, "");
    }

    #[test]
    fn rejects_non_envelope_shapes() {
        assert!(parse_image_answer_envelope("手写答案").is_none());
        assert!(parse_image_answer_envelope(r#"["a","b"]"#).is_none());
        // type 不是 image_answer（matching 作答等既有 JSON 形态不受影响）
        assert!(parse_image_answer_envelope(r#"{"type":"text","images":[]}"#).is_none());
        assert!(parse_image_answer_envelope(r#"{"pairs":[{"left":"L1","right":"R1"}]}"#).is_none());
        // fill_blank 多空 JSON 数组形态
        assert!(parse_image_answer_envelope(r#"["ans1","ans2"]"#).is_none());
    }

    #[test]
    fn rejects_empty_over_cap_or_invalid_entries() {
        assert!(parse_image_answer_envelope(&envelope_json(
            serde_json::json!([]),
            serde_json::json!("")
        ))
        .is_none());
        let too_many: Vec<serde_json::Value> = (0..=IMAGE_ANSWER_MAX_IMAGES)
            .map(|i| image_value(&format!("i{i}"), "image/png"))
            .collect();
        assert!(parse_image_answer_envelope(&envelope_json(
            too_many.into(),
            serde_json::json!("")
        ))
        .is_none());
        // mime 不在白名单
        assert!(parse_image_answer_envelope(&envelope_json(
            serde_json::json!([image_value("a", "application/pdf")]),
            serde_json::json!("")
        ))
        .is_none());
        // 缺字段 / 空 id
        assert!(parse_image_answer_envelope(&envelope_json(
            serde_json::json!([{ "id": "a", "mime": "image/png" }]),
            serde_json::json!("")
        ))
        .is_none());
        assert!(parse_image_answer_envelope(&envelope_json(
            serde_json::json!([image_value("  ", "image/png")]),
            serde_json::json!("")
        ))
        .is_none());
        // text 非字符串
        assert!(parse_image_answer_envelope(&envelope_json(
            serde_json::json!([image_value("a", "image/png")]),
            serde_json::json!(42)
        ))
        .is_none());
    }

    #[test]
    fn validates_image_sizes_with_essay_aligned_limits() {
        // estimated_decoded_len = len*3/4：触发单张 50MB 上限需 base64 长度 > 4/3*50MB
        let oversized = "A".repeat(IMAGE_ANSWER_MAX_DECODED_BYTES / 3 * 4 + 1024);
        let err = validate_image_sizes(&[oversized]).unwrap_err();
        assert!(err.message.contains("单张最大"));

        // 三张各自合法（~34.9MB 解码估算，<50MB 单张上限）但合计 ≥100MB
        let third = "A".repeat(IMAGE_ANSWER_MAX_TOTAL_DECODED_BYTES / 9 * 4 + 16);
        let err = validate_image_sizes(&[third.clone(), third.clone(), third.clone()]).unwrap_err();
        assert!(err.message.contains("总体积超限"));

        // 合法：一张 ~1MB
        let ok = "A".repeat(1024 * 1024 / 3);
        assert!(validate_image_sizes(&[ok]).is_ok());
    }
}
