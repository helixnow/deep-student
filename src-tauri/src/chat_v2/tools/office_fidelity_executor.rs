//! Read-only fidelity inventory for managed Office and PDF files.

use std::fs;
use std::io::{Cursor, Read};
use std::time::Instant;

use async_trait::async_trait;
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::{
    normalize_runtime_relative_path, revalidate_runtime_root, runtime_root_by_id,
};
use crate::chat_v2::task_objects::TaskObjectHandle;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;

pub const OFFICE_FIDELITY_CONTRACT: &str = "office-fidelity-inspection/v1";
const MAX_SOURCE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_PART_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PARTS: usize = 20_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FeatureEvidence {
    feature: &'static str,
    present: bool,
    risk: &'static str,
    count: usize,
    evidence_parts: Vec<String>,
    feature_hash: Option<String>,
}

#[derive(Debug)]
struct PackagePart {
    name: String,
    bytes: Vec<u8>,
}

/// ★ G06-P0：Office 编辑路径强制 preflight 的判定结果。
///
/// 由只读清点（`inspect_bytes`）派生，供编辑执行器（`xlsx_edit_cells` 等）
/// 在写入前消费 `completionGate`：
/// - critical 特征（macros / digital_signatures / external_links / 加密容器）
///   → 必须拒绝 round-trip 编辑（umya-spreadsheet 会静默丢失这些特征）；
/// - high 特征（charts / pivot_tables / defined_names / data_validation /
///   formulas …）→ 允许编辑，但交付结果必须附 fidelity warning。
#[derive(Debug, Clone)]
pub struct EditPreflight {
    pub format: String,
    pub risk: String,
    pub source_sha256: String,
    pub feature_set_hash: String,
    pub critical_features: Vec<String>,
    pub high_features: Vec<String>,
}

impl EditPreflight {
    pub fn has_critical(&self) -> bool {
        !self.critical_features.is_empty()
    }
}

pub struct OfficeFidelityExecutor;

impl OfficeFidelityExecutor {
    pub fn new() -> Self {
        Self
    }

    fn parse_source(args: &Value) -> Result<TaskObjectHandle, String> {
        let source = args.get("source").unwrap_or(args);
        let handle = source
            .get("object_handle")
            .or_else(|| source.get("objectHandle"))
            .unwrap_or(source);
        let parsed: TaskObjectHandle = serde_json::from_value(handle.clone())
            .map_err(|error| format!("OFFICE_FIDELITY_INVALID_SOURCE: {error}"))?;
        parsed
            .validate()
            .map_err(|error| format!("OFFICE_FIDELITY_INVALID_SOURCE: {error}"))?;
        if !parsed.capabilities.readable {
            return Err("OFFICE_FIDELITY_UNAUTHORIZED: source is not readable".into());
        }
        Ok(parsed)
    }

    fn load_source(
        args: &Value,
        ctx: &ExecutionContext,
    ) -> Result<(TaskObjectHandle, Vec<u8>), String> {
        let handle = Self::parse_source(args)?;
        let bytes = if let Some(locator) = handle.locator.as_ref() {
            let relative = normalize_runtime_relative_path(Some(&locator.relative_path))?;
            let state = ctx
                .window_ref()
                .try_state::<AppState>()
                .ok_or("OFFICE_FIDELITY_UNAVAILABLE: AppState is not registered")?;
            let root = runtime_root_by_id(
                ctx.window_ref().app_handle(),
                &state.database,
                &ctx.session_id,
                ctx.skill_package_roots.as_ref(),
                Some(&locator.root_id),
                false,
            )?;
            let root_canon = revalidate_runtime_root(&state.database, &root)?;
            let target = root_canon.join(relative);
            let target_canon = target
                .canonicalize()
                .map_err(|error| format!("OFFICE_FIDELITY_SOURCE_NOT_FOUND: {error}"))?;
            if !target_canon.starts_with(&root_canon) || !target_canon.is_file() {
                return Err("OFFICE_FIDELITY_UNAUTHORIZED: source escaped its runtime root".into());
            }
            let metadata = target_canon
                .metadata()
                .map_err(|error| format!("OFFICE_FIDELITY_SOURCE_READ_FAILED: {error}"))?;
            if metadata.len() > MAX_SOURCE_BYTES {
                return Err(format!(
                    "OFFICE_FIDELITY_TOO_LARGE: {} bytes exceeds {} bytes",
                    metadata.len(),
                    MAX_SOURCE_BYTES
                ));
            }
            fs::read(&target_canon)
                .map_err(|error| format!("OFFICE_FIDELITY_SOURCE_READ_FAILED: {error}"))?
        } else if let Some(provider) = handle.provider_ref.as_ref() {
            if provider.provider != "deep-student-vfs" {
                return Err(
                    "OFFICE_FIDELITY_UNSUPPORTED_SOURCE: provider reference is not an authorized Deep Student VFS file"
                        .into(),
                );
            }
            let vfs_db = ctx
                .vfs_db
                .as_ref()
                .ok_or("OFFICE_FIDELITY_UNAVAILABLE: VFS database is not registered")?;
            let file = crate::vfs::repos::VfsFileRepo::get_file(vfs_db, &provider.external_id)
                .map_err(|error| format!("OFFICE_FIDELITY_SOURCE_READ_FAILED: {error}"))?
                .ok_or("OFFICE_FIDELITY_SOURCE_NOT_FOUND: VFS file does not exist")?;
            let blob_hash = file
                .blob_hash
                .as_deref()
                .ok_or("OFFICE_FIDELITY_UNSUPPORTED_SOURCE: VFS file has no managed blob")?;
            let blob_path = crate::vfs::repos::VfsBlobRepo::get_blob_path(vfs_db, blob_hash)
                .map_err(|error| format!("OFFICE_FIDELITY_SOURCE_READ_FAILED: {error}"))?
                .ok_or("OFFICE_FIDELITY_SOURCE_NOT_FOUND: VFS blob does not exist")?;
            let metadata = blob_path
                .metadata()
                .map_err(|error| format!("OFFICE_FIDELITY_SOURCE_READ_FAILED: {error}"))?;
            if metadata.len() > MAX_SOURCE_BYTES {
                return Err(format!(
                    "OFFICE_FIDELITY_TOO_LARGE: {} bytes exceeds {} bytes",
                    metadata.len(),
                    MAX_SOURCE_BYTES
                ));
            }
            fs::read(&blob_path)
                .map_err(|error| format!("OFFICE_FIDELITY_SOURCE_READ_FAILED: {error}"))?
        } else {
            return Err(
                "OFFICE_FIDELITY_UNSUPPORTED_SOURCE: source needs a managed locator or authorized Deep Student VFS provider reference"
                    .into(),
            );
        };
        let source_hash = hex::encode(Sha256::digest(&bytes));
        if let Some(expected) = handle.sha256.as_deref() {
            if !expected.eq_ignore_ascii_case(&source_hash) {
                return Err(
                    "OFFICE_FIDELITY_SOURCE_CHANGED: TaskObjectHandle SHA-256 mismatch".into(),
                );
            }
        }
        Ok((handle, bytes))
    }

    fn read_package(bytes: &[u8]) -> Result<Vec<PackagePart>, String> {
        let mut archive = zip::ZipArchive::new(Cursor::new(bytes))
            .map_err(|error| format!("OFFICE_FIDELITY_INVALID_OOXML: {error}"))?;
        if archive.len() > MAX_PARTS {
            return Err(format!(
                "OFFICE_FIDELITY_PACKAGE_LIMIT: {} parts exceeds {}",
                archive.len(),
                MAX_PARTS
            ));
        }
        let mut total = 0u64;
        let mut parts = Vec::with_capacity(archive.len());
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("OFFICE_FIDELITY_INVALID_OOXML: {error}"))?;
            if entry.is_dir() {
                continue;
            }
            if entry.size() > MAX_PART_BYTES {
                return Err(format!(
                    "OFFICE_FIDELITY_PACKAGE_LIMIT: part '{}' exceeds {} bytes",
                    entry.name(),
                    MAX_PART_BYTES
                ));
            }
            total = total
                .checked_add(entry.size())
                .ok_or("OFFICE_FIDELITY_PACKAGE_LIMIT: package size overflow")?;
            if total > MAX_PACKAGE_BYTES {
                return Err(format!(
                    "OFFICE_FIDELITY_PACKAGE_LIMIT: uncompressed package exceeds {} bytes",
                    MAX_PACKAGE_BYTES
                ));
            }
            let mut part_bytes = Vec::with_capacity(entry.size() as usize);
            entry
                .read_to_end(&mut part_bytes)
                .map_err(|error| format!("OFFICE_FIDELITY_INVALID_OOXML: {error}"))?;
            parts.push(PackagePart {
                name: entry.name().replace('\\', "/"),
                bytes: part_bytes,
            });
        }
        Ok(parts)
    }

    fn package_format(parts: &[PackagePart]) -> Result<&'static str, String> {
        let has_content_types = parts.iter().any(|part| part.name == "[Content_Types].xml");
        if !has_content_types {
            return Err("OFFICE_FIDELITY_INVALID_OOXML: missing [Content_Types].xml".into());
        }
        if parts.iter().any(|part| part.name.starts_with("word/")) {
            Ok("docx")
        } else if parts.iter().any(|part| part.name.starts_with("xl/")) {
            Ok("xlsx")
        } else if parts.iter().any(|part| part.name.starts_with("ppt/")) {
            Ok("pptx")
        } else {
            Err("OFFICE_FIDELITY_UNSUPPORTED_FORMAT: ZIP is not DOCX, XLSX or PPTX".into())
        }
    }

    /// 以"部件级谓词"（可同时看名字与内容）匹配的特征变体——用于
    /// comments/footnotes_endnotes 这类需要区分真实内容与空样板的特征。
    fn matching_feature_if(
        parts: &[PackagePart],
        feature: &'static str,
        risk: &'static str,
        part_matches: impl Fn(&PackagePart) -> bool,
    ) -> FeatureEvidence {
        let matched: Vec<&PackagePart> = parts.iter().filter(|part| part_matches(part)).collect();
        let mut hasher = Sha256::new();
        for part in &matched {
            hasher.update(part.name.as_bytes());
            hasher.update([0]);
            hasher.update(Sha256::digest(&part.bytes));
        }
        FeatureEvidence {
            feature,
            present: !matched.is_empty(),
            risk,
            count: matched.len(),
            evidence_parts: matched.iter().map(|part| part.name.clone()).collect(),
            feature_hash: (!matched.is_empty()).then(|| hex::encode(hasher.finalize())),
        }
    }

    fn matching_feature(
        parts: &[PackagePart],
        feature: &'static str,
        risk: &'static str,
        path_matches: impl Fn(&str) -> bool,
        markers: &[&[u8]],
    ) -> FeatureEvidence {
        let matched: Vec<&PackagePart> = parts
            .iter()
            .filter(|part| {
                path_matches(&part.name)
                    || markers
                        .iter()
                        .any(|marker| contains_bytes(&part.bytes, marker))
            })
            .collect();
        let mut hasher = Sha256::new();
        for part in &matched {
            hasher.update(part.name.as_bytes());
            hasher.update([0]);
            hasher.update(Sha256::digest(&part.bytes));
        }
        FeatureEvidence {
            feature,
            present: !matched.is_empty(),
            risk,
            count: matched.len(),
            evidence_parts: matched.iter().map(|part| part.name.clone()).collect(),
            feature_hash: (!matched.is_empty()).then(|| hex::encode(hasher.finalize())),
        }
    }

    fn inspect_ooxml(bytes: &[u8]) -> Result<Value, String> {
        let parts = Self::read_package(bytes)?;
        let format = Self::package_format(&parts)?;
        let mut features = vec![
            Self::matching_feature(
                &parts,
                "macros",
                "critical",
                |name| {
                    let lower = name.to_ascii_lowercase();
                    lower.ends_with("vbaproject.bin") || lower.contains("macrosheets/")
                },
                &[],
            ),
            Self::matching_feature(
                &parts,
                "digital_signatures",
                "critical",
                |name| {
                    let lower = name.to_ascii_lowercase();
                    lower.starts_with("_xmlsignatures/") || lower.contains("signature")
                },
                &[],
            ),
        ];
        match format {
            // ★ G06-P1：docx 编辑路径（replace_text）是 docx-rs 文本级全量重建，
            // 一切非纯文本/基础表格结构都会静默丢失——因此修订/内容控件/图片/
            // OLE/复杂页眉页脚/TOC 域升级为 critical 门禁特征。
            "docx" => features.extend([
                // 注意标记必须比 "<w:ins" 更精确：表格边框 <w:insideH/<w:insideV
                // 会以 "<w:ins" 开头，若不作区分会把普通表格误判为修订文档。
                Self::matching_feature(
                    &parts,
                    "tracked_revisions",
                    "critical",
                    |_| false,
                    &[
                        b"<w:ins ",
                        b"<w:ins>",
                        b"<w:del ",
                        b"<w:del>",
                        b"<w:moveFrom ",
                        b"<w:moveFrom>",
                        b"<w:moveTo ",
                        b"<w:moveTo>",
                    ],
                ),
                Self::matching_feature(
                    &parts,
                    "content_controls",
                    "critical",
                    |_| false,
                    &[b"<w:sdt>", b"<w:sdt "],
                ),
                // TOC / 交叉引用域（重建后域指令与缓存结果一并丢失，正文出现空洞）。
                // 仅针对指令文本特征（TOC \o / PAGEREF / REF / NOTEREF），
                // 普通 PAGE 等页码域仍由 medium 级 fields 记录。
                Self::matching_feature(
                    &parts,
                    "toc_crossref_fields",
                    "critical",
                    |_| false,
                    &[b" TOC \\o", b" TOC \\h", b"PAGEREF ", b" REF ", b"NOTEREF "],
                ),
                Self::matching_feature(
                    &parts,
                    "images",
                    "critical",
                    |name| name.starts_with("word/media/"),
                    &[],
                ),
                Self::matching_feature(
                    &parts,
                    "embedded_ole",
                    "critical",
                    |name| name.starts_with("word/embeddings/") || name.starts_with("word/activeX/"),
                    &[b"oleObject"],
                ),
                Self::matching_feature(
                    &parts,
                    "complex_headers_footers",
                    "critical",
                    |_| false,
                    &[b"<w:evenAndOddHeaders", b"<w:titlePg"],
                ),
                Self::matching_feature(
                    &parts,
                    "headers_footers",
                    "high",
                    |name| name.starts_with("word/header") || name.starts_with("word/footer"),
                    &[],
                ),
                // 批注/脚注按"真实内容"判定而非部件存在性：docx-rs 默认包恒带
                // 空 comments.xml/footnotes.xml（无 <w:comment> 条目、仅 separator
                // 样板脚注），按部件名匹配会让全部自产文档都背 fidelity warning。
                Self::matching_feature_if(
                    &parts,
                    "comments",
                    "high",
                    |part| {
                        part.name == "word/comments.xml"
                            && contains_bytes(&part.bytes, b"<w:comment ")
                    },
                ),
                // 文本重建会整体丢弃脚注/尾注（真实内容丢失）——由 medium 升为 high，
                // 使编辑交付结果附 fidelity warning。
                Self::matching_feature_if(
                    &parts,
                    "footnotes_endnotes",
                    "high",
                    |part| {
                        part.name == "word/footnotes.xml" && has_real_note(&part.bytes, b"<w:footnote ")
                            || part.name == "word/endnotes.xml"
                                && has_real_note(&part.bytes, b"<w:endnote ")
                    },
                ),
                Self::matching_feature(
                    &parts,
                    "fields",
                    "medium",
                    |_| false,
                    &[b"<w:fldSimple", b"<w:instrText", b"<w:fldChar"],
                ),
            ]),
            "xlsx" => features.extend([
                Self::matching_feature(
                    &parts,
                    "formulas",
                    "high",
                    |name| name.starts_with("xl/calcChain"),
                    &[b"<f>", b"<f "],
                ),
                Self::matching_feature(
                    &parts,
                    "defined_names",
                    "high",
                    |_| false,
                    &[b"<definedNames", b"<definedName"],
                ),
                Self::matching_feature(
                    &parts,
                    "data_validation",
                    "high",
                    |_| false,
                    &[b"<dataValidations", b"<dataValidation"],
                ),
                Self::matching_feature(
                    &parts,
                    "charts",
                    "high",
                    |name| name.starts_with("xl/charts/"),
                    &[],
                ),
                Self::matching_feature(
                    &parts,
                    "pivot_tables",
                    "high",
                    |name| {
                        name.starts_with("xl/pivotTables/") || name.starts_with("xl/pivotCache/")
                    },
                    &[],
                ),
                Self::matching_feature(
                    &parts,
                    "external_links",
                    "critical",
                    |name| name.starts_with("xl/externalLinks/"),
                    &[b"externalLink"],
                ),
            ]),
            // ★ G06-P1：pptx 编辑路径（replace_text）是 markdown spec 文本级
            // 全量重建——媒体/嵌入对象必然丢失（critical）；母版/备注/动画/图表/
            // SmartArt 同样丢失但无法词法区分默认与自定义母版，保守放行并附
            // fidelity warning（与 xlsx 的 high 语义对齐）。
            "pptx" => features.extend([
                Self::matching_feature(
                    &parts,
                    "media",
                    "critical",
                    |name| name.starts_with("ppt/media/"),
                    &[],
                ),
                Self::matching_feature(
                    &parts,
                    "embedded_ole",
                    "critical",
                    |name| name.starts_with("ppt/embeddings/"),
                    &[b"oleObject"],
                ),
                Self::matching_feature(
                    &parts,
                    "slide_masters",
                    "high",
                    |name| {
                        name.starts_with("ppt/slideMasters/")
                            || name.starts_with("ppt/slideLayouts/")
                    },
                    &[],
                ),
                Self::matching_feature(
                    &parts,
                    "speaker_notes",
                    "high",
                    |name| {
                        name.starts_with("ppt/notesSlides/")
                            || name.starts_with("ppt/notesMasters/")
                    },
                    &[],
                ),
                Self::matching_feature(
                    &parts,
                    "animations_timing",
                    "high",
                    |_| false,
                    &[b"<p:timing", b"<p:anim", b"<p:transition"],
                ),
                Self::matching_feature(
                    &parts,
                    "charts",
                    "high",
                    |name| name.starts_with("ppt/charts/"),
                    &[],
                ),
                Self::matching_feature(
                    &parts,
                    "diagrams",
                    "high",
                    |name| name.starts_with("ppt/diagrams/"),
                    &[],
                ),
            ]),
            _ => unreachable!(),
        }
        Ok(Self::inventory_result(format, bytes, features, true))
    }

    fn pdf_feature(
        bytes: &[u8],
        feature: &'static str,
        risk: &'static str,
        markers: &[&[u8]],
    ) -> FeatureEvidence {
        let positions: Vec<usize> = markers
            .iter()
            .flat_map(|marker| find_all(bytes, marker))
            .collect();
        let mut hasher = Sha256::new();
        for position in &positions {
            let start = position.saturating_sub(128);
            let end = (*position + 256).min(bytes.len());
            hasher.update((*position as u64).to_le_bytes());
            hasher.update(&bytes[start..end]);
        }
        FeatureEvidence {
            feature,
            present: !positions.is_empty(),
            risk,
            count: positions.len(),
            evidence_parts: positions
                .iter()
                .map(|position| format!("byte:{position}"))
                .collect(),
            feature_hash: (!positions.is_empty()).then(|| hex::encode(hasher.finalize())),
        }
    }

    fn inspect_pdf(bytes: &[u8]) -> Result<Value, String> {
        if !bytes.starts_with(b"%PDF-") {
            return Err("OFFICE_FIDELITY_INVALID_PDF: missing PDF signature".into());
        }
        let features = vec![
            Self::pdf_feature(bytes, "forms", "high", &[b"/AcroForm", b"/XFA"]),
            Self::pdf_feature(
                bytes,
                "digital_signatures",
                "critical",
                &[b"/Type /Sig", b"/SigFlags", b"/ByteRange"],
            ),
            Self::pdf_feature(
                bytes,
                "attachments",
                "high",
                &[b"/EmbeddedFiles", b"/Filespec", b"/EmbeddedFile"],
            ),
            Self::pdf_feature(bytes, "encryption", "critical", &[b"/Encrypt"]),
        ];
        Ok(Self::inventory_result("pdf", bytes, features, false))
    }

    fn inventory_result(
        format: &str,
        bytes: &[u8],
        features: Vec<FeatureEvidence>,
        complete_detection: bool,
    ) -> Value {
        let unsupported: Vec<&str> = features
            .iter()
            .filter(|feature| feature.present)
            .map(|feature| feature.feature)
            .collect();
        let risk = if features
            .iter()
            .any(|feature| feature.present && feature.risk == "critical")
        {
            "critical"
        } else if features
            .iter()
            .any(|feature| feature.present && feature.risk == "high")
        {
            "high"
        } else if features
            .iter()
            .any(|feature| feature.present && feature.risk == "medium")
        {
            "medium"
        } else {
            "low"
        };
        let requires_human_review = !complete_detection || !unsupported.is_empty();
        let risk = if !complete_detection && risk == "low" {
            "medium"
        } else {
            risk
        };
        let source_sha256 = hex::encode(Sha256::digest(bytes));
        let feature_set_hash = hash_json(&features);
        json!({
            "contract": OFFICE_FIDELITY_CONTRACT,
            "format": format,
            "readOnly": true,
            "sourceSha256": source_sha256,
            "supported": ["package_feature_inventory", "feature_presence_detection", "auditable_feature_hashes"],
            "preserved": ["source_bytes_unchanged_by_inspection"],
            "unsupported": unsupported,
            "features": features,
            "featureSetHash": feature_set_hash,
            "risk": risk,
            "requiresHumanReview": requires_human_review,
            "requires_human_review": requires_human_review,
            "inspectionCoverage": if complete_detection {
                "complete_for_listed_ooxml_package_features"
            } else {
                "partial_lexical_or_encrypted_container_detection"
            },
            "limitations": if complete_detection {
                Vec::<&str>::new()
            } else {
                vec!["compressed PDF object streams or encrypted container contents may hide features"]
            },
            "completionGate": {
                "automatedEditAllowed": !requires_human_review,
                "defaultMacroOrSignatureAction": "refuse",
                "explicitStripPolicy": "macro_policy=strip",
                "signatureInvalidationLabelRequired": true,
                "preservationClaimAllowed": false,
            },
            "secretPrompt": {
                "supported": false,
                "reasonCode": "DECRYPTOR_INTEGRATION_UNAVAILABLE",
                "reason": "SecretPrompt handles are isolated from chat and logs, but no Office/PDF decryptor consumes them yet"
            }
        })
    }

    fn inspect_bytes(bytes: &[u8]) -> Result<Value, String> {
        if bytes.starts_with(b"%PDF-") {
            Self::inspect_pdf(bytes)
        } else if bytes.starts_with(b"PK\x03\x04") {
            Self::inspect_ooxml(bytes)
        } else if bytes.starts_with(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1") {
            let feature = FeatureEvidence {
                feature: "encryption_or_legacy_compound_container",
                present: true,
                risk: "critical",
                count: 1,
                evidence_parts: vec!["cfb-header".into()],
                feature_hash: Some(hex::encode(Sha256::digest(&bytes[..bytes.len().min(512)]))),
            };
            Ok(Self::inventory_result(
                "encrypted_office_or_legacy_cfb",
                bytes,
                vec![feature],
                false,
            ))
        } else {
            Err(
                "OFFICE_FIDELITY_UNSUPPORTED_FORMAT: expected DOCX, XLSX, PPTX or PDF signature"
                    .into(),
            )
        }
    }

    /// ★ G06-P0：供 Office 编辑执行器复用的 preflight 入口。
    ///
    /// 与 `builtin-office_fidelity_inspect` 共享同一份只读清点逻辑
    /// （`inspect_bytes`），保证编辑路径消费的 gate 与工具暴露的报告一致。
    /// 输入为源文件原始字节（调用方已完成加载与大小检查）。
    pub fn preflight_for_edit(bytes: &[u8]) -> Result<EditPreflight, String> {
        let report = Self::inspect_bytes(bytes)?;
        let mut critical_features = Vec::new();
        let mut high_features = Vec::new();
        if let Some(features) = report["features"].as_array() {
            for feature in features {
                if feature["present"].as_bool() != Some(true) {
                    continue;
                }
                let Some(name) = feature["feature"].as_str() else {
                    continue;
                };
                match feature["risk"].as_str() {
                    Some("critical") => critical_features.push(name.to_string()),
                    Some("high") => high_features.push(name.to_string()),
                    _ => {}
                }
            }
        }
        Ok(EditPreflight {
            format: report["format"].as_str().unwrap_or_default().to_string(),
            risk: report["risk"].as_str().unwrap_or_default().to_string(),
            source_sha256: report["sourceSha256"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            feature_set_hash: report["featureSetHash"]
                .as_str()
                .unwrap_or_default()
                .to_string(),
            critical_features,
            high_features,
        })
    }

    async fn execute_inspect(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let (handle, bytes) = Self::load_source(args, ctx)?;
        let mut output = Self::inspect_bytes(&bytes)?;
        output["ok"] = json!(true);
        output["sourceHandleId"] = json!(handle.handle_id);
        output["sourceDisplayName"] = json!(handle.display_name);
        Ok(output)
    }
}

impl Default for OfficeFidelityExecutor {
    fn default() -> Self {
        Self::new()
    }
}

// ============================================================================
// G06-P1：格式无关的编辑门禁骨架（docx / pptx / xlsx 共用）
// ============================================================================

/// 各格式执行器提供的门禁措辞。骨架逻辑（critical 拒绝 / high 警告）与格式
/// 无关，差异只在写路径名称与办公套件名称。
///
/// - `write_path`：写路径描述，嵌入拒绝原因，如 "umya-spreadsheet round-trip
///   编辑"（xlsx）/ "docx-rs 文本重建"（docx）。
/// - `office_apps`：提示用户核对的办公套件，如 "Excel/WPS"。
/// - `high_features_dropped`：high 特征的处置语义。xlsx 的 umya round-trip
///   下 high 特征多数保留但有降级风险（false）；docx/pptx 的文本级全量重建
///   必然丢弃 high 特征（true），warning 文案与语义标记相应切换。
#[derive(Debug, Clone, Copy)]
pub struct EditGateWording {
    pub write_path: &'static str,
    pub office_apps: &'static str,
    pub high_features_dropped: bool,
}

/// critical 特征门禁：源文件含 critical 特征时拒绝编辑（写路径会静默丢失
/// 这些特征）。错误为结构化 JSON（含特征清单与副本模式提示），供所有
/// Office 编辑执行器统一返回。
pub fn enforce_edit_preflight(
    preflight: &EditPreflight,
    wording: &EditGateWording,
) -> Result<(), String> {
    if !preflight.has_critical() {
        return Ok(());
    }
    Err(format!(
        "OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES: {}",
        json!({
            "error_code": "OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES",
            "critical_features": preflight.critical_features,
            "source_sha256": preflight.source_sha256,
            "reason": format!(
                "源文件包含 critical 保真特征，{}会静默丢失这些特征，已拒绝编辑",
                wording.write_path
            ),
            "hint": format!(
                "可改用副本模式：在 {} 中打开原文件手动编辑，或先另存为去除上述特征的副本后再对本工具编辑副本；完整特征清单可用 builtin-office_fidelity_inspect 查看",
                wording.office_apps
            ),
        })
    ))
}

/// 构建交付结果中的 fidelity warning。
/// 触发条件：源文件含 high 风险特征，或任一 extra 明细列表非空（如 xlsx 的
/// overwritten_formula_cells）。普通文件返回 None，结果 JSON 不出现该字段。
/// `extra_fields` 为格式专属的附加明细（键名 → 字符串列表），原样并入输出。
pub fn build_edit_fidelity_warning(
    preflight: &EditPreflight,
    wording: &EditGateWording,
    extra_fields: &[(&str, Vec<String>)],
) -> Option<Value> {
    let extras_empty = extra_fields.iter().all(|(_, values)| values.is_empty());
    if preflight.high_features.is_empty() && extras_empty {
        return None;
    }
    let message = if wording.high_features_dropped {
        format!(
            "源文件包含的特征在{}中会被丢弃（产物仅保留受支持的文本与表格结构），且未做编辑后结构对比，建议在 {} 中打开产物核对",
            wording.write_path, wording.office_apps
        )
    } else {
        format!(
            "源文件包含高保真风险特征，本次编辑未做编辑后结构对比，建议在 {} 中打开产物核对",
            wording.office_apps
        )
    };
    let mut warning = json!({
        "contract": OFFICE_FIDELITY_CONTRACT,
        "risk": preflight.risk,
        "source_sha256": preflight.source_sha256,
        "feature_set_hash": preflight.feature_set_hash,
        "preserved_at_risk_features": preflight.high_features,
        "post_edit_comparison": "not_performed",
        "message": message,
    });
    if wording.high_features_dropped {
        warning["write_path_semantics"] = json!("text_only_rebuild_drops_listed_features");
    }
    for (key, values) in extra_fields {
        warning[*key] = json!(values);
    }
    Some(warning)
}

#[async_trait]
impl ToolExecutor for OfficeFidelityExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        strip_tool_namespace(tool_name) == "office_fidelity_inspect"
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let started = Instant::now();
        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));
        let result = self.execute_inspect(&call.arguments, ctx).await;
        let duration = started.elapsed().as_millis() as u64;
        let info = match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({ "result": output, "durationMs": duration })));
                ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                )
            }
            Err(error) => {
                ctx.emit_tool_call_error(&error);
                ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error,
                    duration,
                )
            }
        };
        if let Err(error) = ctx.save_tool_block(&info) {
            log::warn!("[OfficeFidelityExecutor] Failed to save tool block: {error}");
        }
        Ok(info)
    }

    fn sensitivity_level(&self, _tool_name: &str) -> ToolSensitivity {
        ToolSensitivity::Low
    }

    fn concurrency_class(&self, _tool_name: &str) -> ToolConcurrency {
        ToolConcurrency::ReadOnly
    }

    fn name(&self) -> &'static str {
        "OfficeFidelityExecutor"
    }
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty()
        && haystack
            .windows(needle.len())
            .any(|window| window == needle)
}

/// 脚注/尾注部件中是否存在真实条目：docx-rs/Word 的默认包里恒有
/// separator / continuationSeparator 样板条目（不算用户内容），
/// 逐标签检查，存在任何非 separator 条目才视为真实。
fn has_real_note(bytes: &[u8], tag: &[u8]) -> bool {
    for start in find_all(bytes, tag) {
        let end = bytes[start..]
            .iter()
            .position(|&b| b == b'>')
            .map(|p| start + p)
            .unwrap_or(bytes.len());
        let tag_lower: Vec<u8> = bytes[start..end]
            .iter()
            .map(|b| b.to_ascii_lowercase())
            .collect();
        if !contains_bytes(&tag_lower, b"separator") {
            return true;
        }
    }
    false
}

fn find_all(haystack: &[u8], needle: &[u8]) -> Vec<usize> {
    if needle.is_empty() {
        return Vec::new();
    }
    haystack
        .windows(needle.len())
        .enumerate()
        .filter_map(|(index, window)| (window == needle).then_some(index))
        .collect()
}

fn hash_json(value: &impl Serialize) -> String {
    let bytes = serde_json::to_vec(value).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn package(parts: &[(&str, &[u8])]) -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        {
            let mut zip = zip::ZipWriter::new(&mut output);
            let options = zip::write::FileOptions::default();
            for (name, bytes) in parts {
                zip.start_file(*name, options).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
        }
        output.into_inner()
    }

    #[test]
    fn docx_inventory_detects_macro_signature_and_revision_without_executing() {
        let bytes = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", b"<w:document><w:ins/></w:document>"),
            ("word/vbaProject.bin", b"not executable by inspector"),
            ("_xmlsignatures/sig1.xml", b"<Signature/>"),
        ]);
        let result = OfficeFidelityExecutor::inspect_bytes(&bytes).unwrap();
        assert_eq!(result["format"], "docx");
        assert_eq!(result["risk"], "critical");
        assert_eq!(result["requiresHumanReview"], true);
        assert_eq!(result["completionGate"]["automatedEditAllowed"], false);
        assert_eq!(
            result["completionGate"]["defaultMacroOrSignatureAction"],
            "refuse"
        );
        assert!(result["unsupported"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value.as_str() == Some("macros")));
    }

    #[test]
    fn xlsx_inventory_hashes_formula_validation_chart_pivot_and_external_link_evidence() {
        let bytes = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            (
                "xl/workbook.xml",
                b"<definedNames><definedName/></definedNames>",
            ),
            (
                "xl/worksheets/sheet1.xml",
                b"<worksheet><f>A1+1</f><dataValidations/></worksheet>",
            ),
            ("xl/charts/chart1.xml", b"<chart/>"),
            ("xl/pivotTables/pivotTable1.xml", b"<pivot/>"),
            ("xl/externalLinks/externalLink1.xml", b"<externalLink/>"),
        ]);
        let result = OfficeFidelityExecutor::inspect_bytes(&bytes).unwrap();
        assert_eq!(result["format"], "xlsx");
        assert!(result["featureSetHash"].as_str().unwrap().len() == 64);
        assert!(result["features"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|feature| feature["present"] == true)
            .all(|feature| feature["featureHash"]
                .as_str()
                .is_some_and(|hash| hash.len() == 64)));
    }

    #[test]
    fn pdf_inventory_reports_forms_signatures_attachments_and_encryption() {
        let bytes = b"%PDF-1.7\n1 0 obj << /AcroForm 2 0 R /Type /Sig /EmbeddedFiles 3 0 R /Encrypt 4 0 R >>";
        let result = OfficeFidelityExecutor::inspect_bytes(bytes).unwrap();
        assert_eq!(result["format"], "pdf");
        assert_eq!(result["risk"], "critical");
        assert_eq!(result["requires_human_review"], true);
        assert_eq!(
            result["inspectionCoverage"],
            "partial_lexical_or_encrypted_container_detection"
        );
        assert_eq!(result["secretPrompt"]["supported"], false);
        assert_eq!(
            result["secretPrompt"]["reasonCode"],
            "DECRYPTOR_INTEGRATION_UNAVAILABLE"
        );
    }

    #[test]
    fn preflight_for_edit_separates_critical_from_high_features() {
        let bytes = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("xl/workbook.xml", b"<workbook/>"),
            (
                "xl/worksheets/sheet1.xml",
                b"<worksheet><f>A1+1</f></worksheet>",
            ),
            ("xl/charts/chart1.xml", b"<chart/>"),
            ("xl/vbaProject.bin", b"macro payload"),
            ("xl/externalLinks/externalLink1.xml", b"<externalLink/>"),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        assert_eq!(preflight.format, "xlsx");
        assert_eq!(preflight.risk, "critical");
        assert!(preflight.has_critical());
        assert!(preflight
            .critical_features
            .iter()
            .any(|f| f == "macros"));
        assert!(preflight
            .critical_features
            .iter()
            .any(|f| f == "external_links"));
        // high 特征与 critical 分桶，不互相污染
        assert!(preflight.high_features.iter().any(|f| f == "charts"));
        assert!(preflight.high_features.iter().any(|f| f == "formulas"));
        assert!(!preflight.high_features.iter().any(|f| f == "macros"));
        assert_eq!(preflight.source_sha256.len(), 64);
        assert_eq!(preflight.feature_set_hash.len(), 64);
    }

    #[test]
    fn preflight_for_edit_plain_xlsx_has_no_gate_features() {
        let bytes = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("xl/workbook.xml", b"<workbook/>"),
            ("xl/worksheets/sheet1.xml", b"<worksheet/>"),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        assert_eq!(preflight.format, "xlsx");
        assert!(!preflight.has_critical());
        assert!(preflight.critical_features.is_empty());
        assert!(preflight.high_features.is_empty());
    }

    // ========================================================================
    // G06-P1：docx / pptx 特征检测（编辑路径 = 文本级全量重建）
    // ========================================================================

    #[test]
    fn docx_preflight_blocks_revisions_sdt_images_and_ole() {
        let bytes = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            (
                "word/document.xml",
                br#"<w:document><w:ins w:id="1" w:author="a"><w:r><w:t>x</w:t></w:r></w:ins><w:sdt><w:sdtContent/></w:sdt></w:document>"#,
            ),
            ("word/media/image1.png", b"png-bytes"),
            ("word/embeddings/oleObject1.xlsx", b"ole-payload"),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        assert_eq!(preflight.format, "docx");
        assert!(preflight.has_critical());
        for expected in [
            "tracked_revisions",
            "content_controls",
            "images",
            "embedded_ole",
        ] {
            assert!(
                preflight.critical_features.iter().any(|f| f == expected),
                "critical feature '{expected}' missing: {:?}",
                preflight.critical_features
            );
        }
    }

    #[test]
    fn docx_preflight_table_borders_are_not_revisions() {
        // <w:insideH>/<w:insideV> 以 "<w:ins" 开头，不得误判为修订标记
        let bytes = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            (
                "word/document.xml",
                br#"<w:document><w:tbl><w:tblBorders><w:insideH w:val="single"/><w:insideV w:val="single"/></w:tblBorders></w:tbl></w:document>"#,
            ),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        assert!(!preflight.has_critical());
        assert!(!preflight
            .critical_features
            .iter()
            .any(|f| f == "tracked_revisions"));
    }

    #[test]
    fn docx_preflight_plain_header_warns_but_complex_header_blocks() {
        // 普通页眉页脚：high（放行 + warning）
        let plain = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", b"<w:document/>"),
            ("word/header1.xml", b"<w:hdr/>"),
            ("word/footer1.xml", b"<w:ftr/>"),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&plain).unwrap();
        assert!(!preflight.has_critical());
        assert!(preflight
            .high_features
            .iter()
            .any(|f| f == "headers_footers"));
        // titlePg / evenAndOddHeaders → 页眉页脚关系复杂：critical（拒绝）
        let complex = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            (
                "word/document.xml",
                b"<w:document><w:sectPr><w:titlePg/></w:sectPr></w:document>",
            ),
            ("word/header1.xml", b"<w:hdr/>"),
            ("word/header2.xml", b"<w:hdr/>"),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&complex).unwrap();
        assert!(preflight.has_critical());
        assert!(preflight
            .critical_features
            .iter()
            .any(|f| f == "complex_headers_footers"));
    }

    #[test]
    fn docx_preflight_toc_and_crossref_fields_are_critical_but_plain_fields_not() {
        let toc = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            (
                "word/document.xml",
                br#"<w:document><w:p><w:instrText xml:space="preserve"> TOC \o "1-3" \h </w:instrText></w:p></w:document>"#,
            ),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&toc).unwrap();
        assert!(preflight
            .critical_features
            .iter()
            .any(|f| f == "toc_crossref_fields"));
        // 普通页码域（PAGE）不升级为 critical，仅 medium 记录、不进门禁桶
        let page_field = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            (
                "word/footer1.xml",
                br#"<w:ftr><w:p><w:instrText xml:space="preserve"> PAGE </w:instrText></w:p></w:ftr>"#,
            ),
            ("word/document.xml", b"<w:document/>"),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&page_field).unwrap();
        assert!(!preflight
            .critical_features
            .iter()
            .any(|f| f == "toc_crossref_fields"));
        assert!(!preflight.has_critical());
    }

    #[test]
    fn docx_preflight_footnotes_and_comments_warn_without_blocking() {
        let bytes = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("word/document.xml", b"<w:document/>"),
            (
                "word/footnotes.xml",
                br#"<w:footnotes><w:footnote w:type="separator" w:id="-1"/><w:footnote w:id="1"><w:p/></w:footnote></w:footnotes>"#,
            ),
            (
                "word/comments.xml",
                br#"<w:comments><w:comment w:id="0" w:author="a"><w:p/></w:comment></w:comments>"#,
            ),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        assert!(!preflight.has_critical());
        assert!(preflight
            .high_features
            .iter()
            .any(|f| f == "footnotes_endnotes"));
        assert!(preflight.high_features.iter().any(|f| f == "comments"));
    }

    #[test]
    fn pptx_preflight_blocks_media_and_ole() {
        let bytes = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("ppt/presentation.xml", b"<p:presentation/>"),
            ("ppt/media/image1.png", b"png-bytes"),
            ("ppt/embeddings/oleObject1.bin", b"ole-payload"),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        assert_eq!(preflight.format, "pptx");
        assert!(preflight.has_critical());
        assert!(preflight.critical_features.iter().any(|f| f == "media"));
        assert!(preflight
            .critical_features
            .iter()
            .any(|f| f == "embedded_ole"));
    }

    #[test]
    fn pptx_preflight_masters_notes_charts_warn_without_blocking() {
        let bytes = package(&[
            ("[Content_Types].xml", b"<Types/>"),
            ("ppt/presentation.xml", b"<p:presentation/>"),
            ("ppt/slideMasters/slideMaster1.xml", b"<p:sldMaster/>"),
            ("ppt/slideLayouts/slideLayout1.xml", b"<p:sldLayout/>"),
            ("ppt/notesSlides/notesSlide1.xml", b"<p:notes/>"),
            ("ppt/charts/chart1.xml", b"<c:chart/>"),
            ("ppt/diagrams/data1.xml", b"<dgm/>"),
            (
                "ppt/slides/slide1.xml",
                b"<p:sld><p:timing/></p:sld>",
            ),
        ]);
        let preflight = OfficeFidelityExecutor::preflight_for_edit(&bytes).unwrap();
        // 母版/版式无法词法区分默认与自定义 → 保守放行 + warning
        assert!(!preflight.has_critical());
        for expected in [
            "slide_masters",
            "speaker_notes",
            "charts",
            "diagrams",
            "animations_timing",
        ] {
            assert!(
                preflight.high_features.iter().any(|f| f == expected),
                "high feature '{expected}' missing: {:?}",
                preflight.high_features
            );
        }
    }

    // ========================================================================
    // G06-P1：格式无关门禁骨架（enforce_edit_preflight / build_edit_fidelity_warning）
    // ========================================================================

    fn preflight_fixture(critical: &[&str], high: &[&str]) -> EditPreflight {
        EditPreflight {
            format: "docx".to_string(),
            risk: if critical.is_empty() { "high" } else { "critical" }.to_string(),
            source_sha256: "a".repeat(64),
            feature_set_hash: "b".repeat(64),
            critical_features: critical.iter().map(|f| f.to_string()).collect(),
            high_features: high.iter().map(|f| f.to_string()).collect(),
        }
    }

    #[test]
    fn shared_gate_error_carries_format_specific_wording() {
        let preflight = preflight_fixture(&["images"], &[]);
        let docx_wording = EditGateWording {
            write_path: "docx-rs 文本重建",
            office_apps: "Word/WPS",
            high_features_dropped: true,
        };
        let err = enforce_edit_preflight(&preflight, &docx_wording).unwrap_err();
        assert!(err.contains("OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES"));
        assert!(err.contains("images"));
        assert!(err.contains("docx-rs 文本重建"));
        assert!(err.contains("Word/WPS"));
        assert!(err.contains("副本"));
        // xlsx 措辞保持 G06-P0 原文（round-trip 语义 + Excel/WPS）
        let xlsx_wording = EditGateWording {
            write_path: "umya-spreadsheet round-trip 编辑",
            office_apps: "Excel/WPS",
            high_features_dropped: false,
        };
        let err = enforce_edit_preflight(&preflight, &xlsx_wording).unwrap_err();
        assert!(err.contains("umya-spreadsheet round-trip 编辑会静默丢失这些特征"));
        assert!(err.contains("Excel/WPS"));
        // 无 critical → 放行
        let clean = preflight_fixture(&[], &["comments"]);
        assert!(enforce_edit_preflight(&clean, &docx_wording).is_ok());
    }

    #[test]
    fn shared_warning_switches_semantics_by_write_path() {
        let preflight = preflight_fixture(&[], &["comments"]);
        let rebuild_wording = EditGateWording {
            write_path: "pptx spec 文本重建",
            office_apps: "PowerPoint/WPS",
            high_features_dropped: true,
        };
        let warning =
            build_edit_fidelity_warning(&preflight, &rebuild_wording, &[]).unwrap();
        assert_eq!(
            warning["preserved_at_risk_features"],
            json!(["comments"])
        );
        assert_eq!(warning["post_edit_comparison"], "not_performed");
        assert_eq!(
            warning["write_path_semantics"],
            "text_only_rebuild_drops_listed_features"
        );
        assert!(warning["message"].as_str().unwrap().contains("PowerPoint/WPS"));
        // round-trip 语义（xlsx）：无 write_path_semantics 键，message 保持 P0 原文
        let roundtrip_wording = EditGateWording {
            write_path: "umya-spreadsheet round-trip 编辑",
            office_apps: "Excel/WPS",
            high_features_dropped: false,
        };
        let warning = build_edit_fidelity_warning(
            &preflight,
            &roundtrip_wording,
            &[("overwritten_formula_cells", Vec::new())],
        )
        .unwrap();
        assert!(warning.get("write_path_semantics").is_none());
        assert_eq!(
            warning["message"].as_str().unwrap(),
            "源文件包含高保真风险特征，本次编辑未做编辑后结构对比，建议在 Excel/WPS 中打开产物核对"
        );
        assert_eq!(
            warning["overwritten_formula_cells"],
            json!(Vec::<String>::new())
        );
        // 无 high 且 extras 全空 → None；extras 非空 → 仍触发（公式覆盖语义）
        let clean = preflight_fixture(&[], &[]);
        assert!(build_edit_fidelity_warning(&clean, &roundtrip_wording, &[]).is_none());
        assert!(build_edit_fidelity_warning(
            &clean,
            &roundtrip_wording,
            &[("overwritten_formula_cells", vec!["Sheet1!B1".to_string()])],
        )
        .is_some());
    }
}
