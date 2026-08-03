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
            "docx" => features.extend([
                Self::matching_feature(
                    &parts,
                    "tracked_revisions",
                    "high",
                    |_| false,
                    &[b"<w:ins", b"<w:del", b"<w:moveFrom", b"<w:moveTo"],
                ),
                Self::matching_feature(
                    &parts,
                    "comments",
                    "high",
                    |name| name.starts_with("word/comments"),
                    &[],
                ),
                Self::matching_feature(
                    &parts,
                    "fields",
                    "medium",
                    |_| false,
                    &[b"<w:fldSimple", b"<w:instrText", b"<w:fldChar"],
                ),
                Self::matching_feature(
                    &parts,
                    "footnotes_endnotes",
                    "medium",
                    |name| name == "word/footnotes.xml" || name == "word/endnotes.xml",
                    &[],
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
            "pptx" => features.extend([
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
}
