//! 题目集 AI 出题 - 参考资料收集（注入模式解析）
//!
//! 2026-09-09 改造（决策见 docs/dev/ai-qbank-generation-v3-plan-2026-09-08.md §2.4）：
//! 从「纯文本提取」升级为「注入模式解析」，复用对话侧 PDF 注入模式的数据来源。
//!
//! 优先级：
//! ① 上传文件 sha256 命中资源库 → 复用该文件的文本层/OCR 结果（零成本）
//! ② 文本层提取（资源库 extracted_text/OCR、上传文件 DocumentParser）
//! ③ 出题模型多模态 → 页面图作为 image 内容块（无需 OCR）
//! ④ 都没有 → 记录 skipped（前端提示；OCR 回退已被用户否决，不触发 OCR）
//!
//! 修复背景：用户上传的扫描版 PDF（无文本层）此前被静默跳过，AI 完全没用该文件
//! 出题（生产日志 2026-09-08 18:16:23：`参考资料收集完成：0 份`）。

use std::sync::Arc;

use base64::Engine as _;
use serde_json::Value;
use sha2::{Digest, Sha256};

use crate::document_parser::DocumentParser;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};
use crate::vfs::VfsError;

use super::types::{
    QbankGenerationRequest, ReferenceImage, ReferenceText, ReferenceTextSource, SkippedReference,
    REFERENCE_FILES_MAX_COUNT, REFERENCE_IMAGE_MAX_PAGES, REFERENCE_TEXT_MIN_CHARS,
};

/// 参考资料收集结果（文本 + 页面图 + 跳过明细）
#[derive(Debug, Default)]
pub struct ReferenceBundle {
    /// 文本类参考资料（进 prompt 的「## 参考资料」段）
    pub texts: Vec<ReferenceText>,
    /// 页面图参考资料（多模态模型的 image 内容块）
    pub images: Vec<ReferenceImage>,
    /// 被跳过的文件（前端提示用）
    pub skipped: Vec<SkippedReference>,
}

impl ReferenceBundle {
    /// 是否没有任何可注入的参考资料
    pub fn is_empty(&self) -> bool {
        self.texts.is_empty() && self.images.is_empty()
    }

    /// 注入 prompt 的参考资料条目数（文本份数 + 图片页数）
    pub fn used_count(&self) -> usize {
        self.texts.len() + self.images.len()
    }
}

/// 收集参考资料（文本 + 页面图）。
///
/// `model_is_multimodal`：出题模型是否支持视觉（`ApiConfig.is_multimodal`）。
/// 仅在文本层无效且模型支持视觉时才走页面图直读。
pub async fn collect_references(
    vfs_db: &Arc<VfsDatabase>,
    request: &QbankGenerationRequest,
    model_is_multimodal: bool,
) -> Result<ReferenceBundle, VfsError> {
    let mut bundle = ReferenceBundle::default();

    let total_requested = request.reference_file_ids.len() + request.reference_files_base64.len();
    if total_requested > REFERENCE_FILES_MAX_COUNT {
        log::warn!(
            "[QbankGeneration] 参考文件数 {} 超上限 {}，多余的将忽略",
            total_requested,
            REFERENCE_FILES_MAX_COUNT
        );
    }
    log::info!(
        "[QbankGeneration] 开始收集参考资料：资源库 {} 份 / 上传 {} 份，模型多模态={}",
        request.reference_file_ids.len(),
        request.reference_files_base64.len(),
        model_is_multimodal
    );

    let mut processed = 0usize;

    // ① 资源库文件
    for file_id in request.reference_file_ids.iter() {
        if processed >= REFERENCE_FILES_MAX_COUNT {
            break;
        }
        processed += 1;
        collect_from_library(vfs_db, file_id, &mut bundle, model_is_multimodal).await;
    }

    // ② 前端临时上传文件
    for upload in request.reference_files_base64.iter() {
        if processed >= REFERENCE_FILES_MAX_COUNT {
            break;
        }
        processed += 1;
        collect_from_upload(vfs_db, &upload.name, &upload.base64, &mut bundle, model_is_multimodal)
            .await;
    }

    // C4：注入前可审计日志（RULES.txt 第 5 条）
    log::info!(
        "[QbankGeneration] 参考资料收集完成：文本 {} 份（{} 字符），图片 {} 页，跳过 {} 份",
        bundle.texts.len(),
        bundle.texts.iter().map(|t| t.text.chars().count()).sum::<usize>(),
        bundle.images.len(),
        bundle.skipped.len()
    );
    for text in &bundle.texts {
        log::info!(
            "[QbankGeneration]   文本参考资料: {} ({:?}, {} 字符)",
            text.name,
            text.source,
            text.text.chars().count()
        );
    }
    for image in &bundle.images {
        log::info!(
            "[QbankGeneration]   图片参考资料: {} 第 {} 页 ({}, {} KB)",
            image.name,
            image.page,
            image.media_type,
            image.base64.len() / 1024
        );
    }
    for skipped in &bundle.skipped {
        log::warn!(
            "[QbankGeneration]   跳过: {} (reason={}, detail={:?})",
            skipped.name,
            skipped.reason,
            skipped.detail
        );
    }

    Ok(bundle)
}

/// 资源库文件：文本层/OCR 优先，无效则（多模态模型）取页面图
async fn collect_from_library(
    vfs_db: &Arc<VfsDatabase>,
    file_id: &str,
    bundle: &mut ReferenceBundle,
    model_is_multimodal: bool,
) {
    // 1. 元数据 + 文本层（连接在块内释放，后续 blob 读取会重新取连接）
    let (name, text, has_ocr) = {
        let conn = match vfs_db.get_conn_safe() {
            Ok(c) => c,
            Err(e) => {
                bundle.skipped.push(SkippedReference::with_detail(
                    file_id,
                    "read_failed",
                    e.to_string(),
                ));
                return;
            }
        };
        let file = match VfsFileRepo::get_file_with_conn(&conn, file_id) {
            Ok(Some(f)) => f,
            Ok(None) => {
                log::warn!("[QbankGeneration] 参考文件不存在: {}", file_id);
                bundle
                    .skipped
                    .push(SkippedReference::new(file_id, "file_not_found"));
                return;
            }
            Err(e) => {
                bundle.skipped.push(SkippedReference::with_detail(
                    file_id,
                    "read_failed",
                    e.to_string(),
                ));
                return;
            }
        };
        let name = file.file_name.clone();
        let text =
            crate::vfs::ref_handlers::extract_file_text_with_strategy(&conn, file_id, &name, None);
        // 是否有现成 OCR 结果（用于标注来源，不触发新 OCR）
        let has_ocr =
            crate::vfs::ref_handlers::get_ocr_pages_text_with_conn(&conn, file_id).is_some();
        (name, text, has_ocr)
    };

    // 2. 文本层有效 → 直接注入
    if let Some(text) = text
        .as_deref()
        .map(str::trim)
        .filter(|t| t.chars().count() >= REFERENCE_TEXT_MIN_CHARS)
    {
        bundle.texts.push(ReferenceText {
            name,
            text: text.to_string(),
            source: if has_ocr {
                ReferenceTextSource::LibraryOcr
            } else {
                ReferenceTextSource::TextLayer
            },
        });
        return;
    }

    // 3. 文本层无效（扫描件）→ 多模态模型直读页面图
    if model_is_multimodal {
        match collect_library_page_images(vfs_db, file_id, &name) {
            Ok(images) if !images.is_empty() => {
                log::info!(
                    "[QbankGeneration] 资源库文件 {} 文本层无效，改用页面图直读（{} 页）",
                    name,
                    images.len()
                );
                bundle.images.extend(images);
                return;
            }
            Ok(_) => {
                log::warn!("[QbankGeneration] 资源库文件 {} 无可用页面图", name);
            }
            Err(e) => {
                log::warn!("[QbankGeneration] 资源库文件 {} 页面图读取失败: {}", name, e);
            }
        }
    }

    // 4. 失败：记录原因（OCR 回退已否决，不触发 OCR）
    let reason = if model_is_multimodal {
        "text_extract_failed"
    } else {
        "model_not_multimodal"
    };
    bundle.skipped.push(SkippedReference::with_detail(
        name,
        reason,
        if model_is_multimodal {
            "未提取到文本层，且没有可用的页面图"
        } else {
            "该文件是扫描件（无文本层），当前出题模型不支持读图"
        },
    ));
}

/// 上传文件：sha256 查重 → 文本层 → （多模态）栅格化页面图
async fn collect_from_upload(
    vfs_db: &Arc<VfsDatabase>,
    name: &str,
    base64: &str,
    bundle: &mut ReferenceBundle,
    model_is_multimodal: bool,
) {
    // 0. 解码
    let bytes = match base64::engine::general_purpose::STANDARD.decode(base64) {
        Ok(b) => b,
        Err(e) => {
            bundle.skipped.push(SkippedReference::with_detail(
                name,
                "read_failed",
                format!("base64 解码失败: {}", e),
            ));
            return;
        }
    };

    // 1. sha256 查重：命中资源库已有文件则直接复用其提取结果（零成本）
    let sha256 = hex::encode(Sha256::digest(&bytes));
    let existing_id: Option<String> = match vfs_db.get_conn_safe() {
        Ok(conn) => conn
            .query_row(
                "SELECT id FROM files WHERE sha256 = ?1 AND deleted_at IS NULL LIMIT 1",
                rusqlite::params![sha256],
                |row| row.get::<_, String>(0),
            )
            .ok(),
        Err(_) => None,
    };
    if let Some(file_id) = existing_id {
        log::info!(
            "[QbankGeneration] 上传文件 {} 命中资源库已有文件 {}（sha256 查重），复用其提取结果",
            name,
            file_id
        );
        collect_from_library(vfs_db, &file_id, bundle, model_is_multimodal).await;
        return;
    }

    // 2. 文本层提取
    let parser = DocumentParser::new();
    let text = parser.extract_text_from_base64(name, base64).ok();
    if let Some(text) = text
        .as_deref()
        .map(str::trim)
        .filter(|t| t.chars().count() >= REFERENCE_TEXT_MIN_CHARS)
    {
        bundle.texts.push(ReferenceText {
            name: name.to_string(),
            text: text.to_string(),
            source: ReferenceTextSource::TextLayer,
        });
        return;
    }

    // 3. 多模态模型 + PDF → 栅格化页面图直读
    let is_pdf = name.to_ascii_lowercase().ends_with(".pdf");
    if model_is_multimodal && is_pdf {
        match rasterize_pdf_to_images(vfs_db, &bytes, name).await {
            Ok(images) if !images.is_empty() => {
                log::info!(
                    "[QbankGeneration] 上传文件 {} 文本层无效，改用页面图直读（{} 页）",
                    name,
                    images.len()
                );
                bundle.images.extend(images);
                return;
            }
            Ok(_) => log::warn!("[QbankGeneration] 上传文件 {} 栅格化后无页面图", name),
            Err(e) => log::warn!("[QbankGeneration] 上传文件 {} 栅格化失败: {}", name, e),
        }
    }

    // 4. 失败：记录原因
    let detail = if !model_is_multimodal {
        "该文件没有文本层（可能是扫描件），当前出题模型不支持读图"
    } else if is_pdf {
        "未提取到文本层，页面图栅格化也失败"
    } else {
        "未提取到文本（该格式不支持文本提取）"
    };
    bundle.skipped.push(SkippedReference::with_detail(
        name,
        if model_is_multimodal {
            "text_extract_failed"
        } else {
            "model_not_multimodal"
        },
        detail,
    ));
}

/// 读取资源库 PDF 的页面图（优先压缩版 blob），最多 REFERENCE_IMAGE_MAX_PAGES 页
fn collect_library_page_images(
    vfs_db: &Arc<VfsDatabase>,
    file_id: &str,
    name: &str,
) -> Result<Vec<ReferenceImage>, VfsError> {
    // 1. 读取 preview_json（连接在块内释放）
    let preview_json: Option<String> = {
        let conn = vfs_db.get_conn_safe()?;
        conn.query_row(
            r#"SELECT preview_json FROM files
               WHERE (id = ?1 OR resource_id = ?1) AND deleted_at IS NULL
               ORDER BY CASE WHEN id = ?1 THEN 0 ELSE 1 END LIMIT 1"#,
            rusqlite::params![file_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };
    let Some(preview_json) = preview_json.filter(|j| !j.trim().is_empty()) else {
        return Ok(Vec::new());
    };
    let preview: Value = serde_json::from_str(&preview_json)
        .map_err(|e| VfsError::Other(format!("preview_json 解析失败: {}", e)))?;
    let Some(pages) = preview.get("pages").and_then(|p| p.as_array()) else {
        return Ok(Vec::new());
    };

    let mut images = Vec::new();
    for (idx, page) in pages.iter().enumerate() {
        if images.len() >= REFERENCE_IMAGE_MAX_PAGES {
            log::info!(
                "[QbankGeneration] 文件 {} 页面图超过 {} 页上限，截断",
                name,
                REFERENCE_IMAGE_MAX_PAGES
            );
            break;
        }
        let compressed_hash = page
            .get("compressedBlobHash")
            .or_else(|| page.get("compressed_blob_hash"))
            .and_then(|h| h.as_str());
        let original_hash = page
            .get("blobHash")
            .or_else(|| page.get("blob_hash"))
            .and_then(|h| h.as_str());

        let picked = compressed_hash.or(original_hash);
        let Some(hash) = picked else { continue };
        let Some(path) = VfsBlobRepo::get_blob_path(vfs_db, hash)? else {
            continue;
        };
        let Ok(content) = std::fs::read(&path) else {
            continue;
        };
        let media_type = if compressed_hash.is_some() {
            "image/jpeg".to_string()
        } else {
            page.get("mimeType")
                .or_else(|| page.get("mime_type"))
                .and_then(|m| m.as_str())
                .unwrap_or("image/png")
                .to_string()
        };
        images.push(ReferenceImage {
            name: name.to_string(),
            page: idx + 1,
            media_type,
            base64: base64::engine::general_purpose::STANDARD.encode(&content),
        });
    }
    Ok(images)
}

/// 上传 PDF 栅格化为页面图（仅当文本层无效且模型支持视觉时调用）
///
/// 注意：`PageRasterizer::rasterize_pdf` 会把页面图写入 vfs blob 但不建 files 记录，
/// 属于「无主 blob」（与对话侧 question_import_service 的用法一致）。
async fn rasterize_pdf_to_images(
    vfs_db: &Arc<VfsDatabase>,
    bytes: &[u8],
    name: &str,
) -> Result<Vec<ReferenceImage>, VfsError> {
    let base64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    let db = vfs_db.clone();
    let result = tokio::task::spawn_blocking(move || {
        crate::page_rasterizer::PageRasterizer::rasterize_pdf(&base64, &db)
    })
    .await
    .map_err(|e| VfsError::Other(format!("栅格化任务调度失败: {}", e)))?;

    let raster = match result {
        Ok(r) => r,
        Err(e) => {
            log::warn!("[QbankGeneration] PDF 栅格化失败: {}", e);
            return Ok(Vec::new());
        }
    };

    let mut images = Vec::new();
    for page in raster.pages.iter().take(REFERENCE_IMAGE_MAX_PAGES) {
        let Ok(content) = crate::page_rasterizer::load_page_image_bytes(vfs_db, &page.blob_hash)
        else {
            continue;
        };
        images.push(ReferenceImage {
            name: name.to_string(),
            page: page.page_index + 1,
            media_type: "image/jpeg".to_string(),
            base64: base64::engine::general_purpose::STANDARD.encode(&content),
        });
    }
    Ok(images)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundle_counts_texts_and_images() {
        let mut bundle = ReferenceBundle::default();
        assert!(bundle.is_empty());
        assert_eq!(bundle.used_count(), 0);
        bundle.texts.push(ReferenceText {
            name: "a.pdf".to_string(),
            text: "内容".to_string(),
            source: ReferenceTextSource::TextLayer,
        });
        bundle.images.push(ReferenceImage {
            name: "a.pdf".to_string(),
            page: 1,
            media_type: "image/jpeg".to_string(),
            base64: "abc".to_string(),
        });
        assert!(!bundle.is_empty());
        assert_eq!(bundle.used_count(), 2);
    }

    #[test]
    fn skipped_reference_serializes_reason_code() {
        let skipped = SkippedReference::with_detail("扫描件.pdf", "model_not_multimodal", "不支持读图");
        let json = serde_json::to_value(&skipped).expect("serialize");
        assert_eq!(json["name"], "扫描件.pdf");
        assert_eq!(json["reason"], "model_not_multimodal");
        assert_eq!(json["detail"], "不支持读图");
    }
}
