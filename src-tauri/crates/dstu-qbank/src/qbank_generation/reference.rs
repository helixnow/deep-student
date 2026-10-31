//! 出题参考资料：按原始文件准备完整 SourceBundle。
//!
//! 不再截断长正文，也不按固定页数裁剪 PDF/图片。每个资源库文件或临时上传文件
//! 都尽量走与题目导入相同的 `load_source_bundle`，只重命名 source_id 以支持
//! 多文件合并。读取失败进入 `skipped` 并回传前端，不静默丢弃用户提供的材料。

use std::collections::HashMap;
use std::sync::Arc;

use base64::Engine as _;
use serde_json::{json, Value};
use sha2::Digest;

use crate::models::AppError;
use crate::question_authoring_runner::{load_source_bundle, SourceBundle};
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{VfsBlobRepo, VfsFileRepo};

use super::types::{QbankGenerationRequest, SkippedReference};

#[derive(Debug)]
pub struct ReferenceBundle {
    pub bundle: SourceBundle,
    pub skipped: Vec<SkippedReference>,
}

impl ReferenceBundle {
    fn empty() -> Self {
        Self {
            bundle: SourceBundle {
                sources: Vec::new(),
                pages: Vec::new(),
                text: String::new(),
                format: "none".to_string(),
            },
            skipped: Vec::new(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.bundle.sources.is_empty()
            && self.bundle.pages.is_empty()
            && self.bundle.text.trim().is_empty()
    }

    pub fn used_count(&self) -> usize {
        self.bundle.sources.len() + self.bundle.pages.len()
    }

    pub fn has_media_anchors(&self) -> bool {
        crate::study_loop::media_source::contains_media_anchor(&self.bundle.text)
    }
}

enum PreparedSource {
    Content {
        name: String,
        format: String,
        base64: String,
    },
    Text {
        name: String,
        text: String,
    },
}

pub async fn collect_references(
    vfs_db: &Arc<VfsDatabase>,
    request: &QbankGenerationRequest,
    _model_is_multimodal: bool,
) -> Result<ReferenceBundle, AppError> {
    let mut out = ReferenceBundle::empty();
    let mut index = 0usize;

    for file_id in &request.reference_file_ids {
        match library_source(vfs_db, file_id).await {
            Ok(PreparedSource::Content {
                name,
                format,
                base64,
            }) => {
                merge_loaded(
                    vfs_db,
                    &mut out,
                    index,
                    &name,
                    &format,
                    load_source_bundle(vfs_db, &base64, &format, &name).await,
                );
                index += 1;
            }
            Ok(PreparedSource::Text { name, text }) => {
                merge_text(&mut out, index, &name, &text);
                index += 1;
            }
            Err((reason, detail)) => out
                .skipped
                .push(SkippedReference::with_detail(file_id, reason, detail)),
        }
    }
    for upload in &request.reference_files_base64 {
        let format = extension(&upload.name);
        merge_loaded(
            vfs_db,
            &mut out,
            index,
            &upload.name,
            &format,
            load_source_bundle(vfs_db, &upload.base64, &format, &upload.name).await,
        );
        index += 1;
    }

    log::info!(
        "[QbankGeneration] 参考资料准备完成：来源 {}，页图 {}，跳过 {}，正文 {} 字符",
        out.bundle.sources.len(),
        out.bundle.pages.len(),
        out.skipped.len(),
        out.bundle.text.chars().count()
    );
    Ok(out)
}

fn merge_loaded(
    _vfs_db: &Arc<VfsDatabase>,
    out: &mut ReferenceBundle,
    index: usize,
    name: &str,
    format: &str,
    loaded: Result<SourceBundle, AppError>,
) {
    match loaded {
        Ok(mut bundle) => {
            let alias = format!("r{}", index + 1);
            let mut ids = HashMap::new();
            for source in &mut bundle.sources {
                let old = source["source_id"].as_str().unwrap_or("s1").to_string();
                let new_id = format!("{}_{}", alias, old);
                source["source_id"] = json!(new_id);
                ids.insert(old, new_id);
            }
            for page in &mut bundle.pages {
                if let Some(new_id) = ids.get(&page.source_id) {
                    page.source_id = new_id.clone();
                }
            }
            if !bundle.text.trim().is_empty() {
                out.bundle.text.push_str(&format!(
                    "\n\n===== 参考文件 r{}：{} =====\n{}",
                    index + 1,
                    name,
                    bundle.text
                ));
            }
            out.bundle.sources.extend(bundle.sources);
            out.bundle.pages.extend(bundle.pages);
            if out.bundle.format == "none" {
                out.bundle.format = format.to_string();
            } else if out.bundle.format != format {
                out.bundle.format = "mixed".to_string();
            }
        }
        Err(error) => {
            log::warn!(
                "[QbankGeneration] 参考文件 {} 准备失败: {}",
                name,
                error.message
            );
            out.skipped.push(SkippedReference::with_detail(
                name,
                "read_failed",
                error.message,
            ));
        }
    }
}

fn merge_text(out: &mut ReferenceBundle, index: usize, name: &str, text: &str) {
    let source_id = format!("r{}_s1", index + 1);
    out.bundle.sources.push(json!({
        "source_id": source_id,
        "name": name,
        "format": "media_transcript",
        "page_count": null,
        "content_hash":hex::encode(sha2::Sha256::digest(text.as_bytes())),
    }));
    out.bundle.text.push_str(&format!(
        "\n\n===== 参考文件 r{}：{} =====\n{}",
        index + 1,
        name,
        text
    ));
}

async fn library_source(
    vfs_db: &Arc<VfsDatabase>,
    file_id: &str,
) -> Result<PreparedSource, (String, String)> {
    let file = {
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| ("read_failed".to_string(), e.to_string()))?;
        VfsFileRepo::get_file_with_conn(&conn, file_id)
            .map_err(|e| ("read_failed".to_string(), e.to_string()))?
            .ok_or_else(|| ("file_not_found".to_string(), file_id.to_string()))?
    };

    if matches!(file.file_type.as_str(), "audio" | "video") {
        let text = {
            let conn = vfs_db
                .get_conn_safe()
                .map_err(|e| ("read_failed".to_string(), e.to_string()))?;
            crate::vfs::ref_handlers::extract_file_text_with_strategy(
                &conn,
                file_id,
                &file.file_name,
                None,
            )
            .map(|text| {
                crate::study_loop::media_source::prepare_media_text_for_generation(
                    &conn, file_id, text,
                )
            })
            .ok_or_else(|| {
                (
                    "text_extract_failed".to_string(),
                    "音视频转写文本不可用".to_string(),
                )
            })?
        };
        return Ok(PreparedSource::Text {
            name: file.file_name,
            text,
        });
    }

    let format = extension(&file.file_name);
    let bytes = if let Some(hash) = file.blob_hash.as_deref() {
        let path = VfsBlobRepo::get_blob_path(vfs_db, hash)
            .map_err(|e| ("read_failed".to_string(), e.to_string()))?
            .ok_or_else(|| ("read_failed".to_string(), format!("blob 不存在: {}", hash)))?;
        std::fs::read(path).map_err(|e| ("read_failed".to_string(), e.to_string()))?
    } else if let Some(text) = file.extracted_text.as_deref() {
        return Ok(PreparedSource::Text {
            name: file.file_name,
            text: text.to_string(),
        });
    } else {
        return Err((
            "read_failed".to_string(),
            "文件没有 blob 或已提取文本".to_string(),
        ));
    };
    Ok(PreparedSource::Content {
        name: file.file_name,
        format,
        base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

fn extension(name: &str) -> String {
    name.rsplit_once('.')
        .map(|(_, ext)| ext.to_ascii_lowercase())
        .filter(|ext| !ext.is_empty())
        .unwrap_or_else(|| "txt".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_is_lowercase_and_has_text_fallback() {
        assert_eq!(extension("A.PDF"), "pdf");
        assert_eq!(extension("notes"), "txt");
    }

    #[test]
    fn empty_bundle_reports_no_references() {
        let bundle = ReferenceBundle::empty();
        assert!(bundle.is_empty());
        assert_eq!(bundle.used_count(), 0);
    }
}
