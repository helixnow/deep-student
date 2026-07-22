//! Agent 技能包自装工具执行器
//!
//! - `skill_scan`（Low）：只扫描 zip，不写盘
//! - `skill_install`（High，必审批）：重新取源 → 校验 sha256 → 安装 → provenance

use std::fs;
use std::time::Instant;

use async_trait::async_trait;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;
use tokio::io::AsyncReadExt;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::fetch_executor::FetchExecutor;
use super::strip_tool_namespace;
use crate::chat_v2::runtime_roots::{normalize_runtime_relative_path, runtime_root_by_id};
use crate::chat_v2::skill_requires::format_missing_requires_hints;
use crate::chat_v2::skills::{
    install_skill_package_from_zip_bytes, prepare_skill_package_from_zip_bytes,
    SkillImportZipResult, DEFAULT_AGENT_SKILLS_BASE, MAX_SKILL_PACKAGE_ZIP_BYTES,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::commands::AppState;
use crate::utils::text::safe_truncate;

pub mod tool_names {
    pub const SKILL_SCAN: &str = "skill_scan";
    pub const SKILL_INSTALL: &str = "skill_install";
}

/// 技能目录内的 agent 安装溯源 marker（须可被 packageFiles 索引，不用点前缀）。
pub(crate) const AGENT_INSTALLED_MARKER: &str = "AGENT_INSTALLED.json";

/// 安装/workshop 写入成功后的信任正门 next_step（与 skill_trust_request inspect 风格对齐）。
pub(crate) const POST_WRITE_TRUST_NEXT_STEP: &str =
    "Call skill_trust_request with action=inspect and this skill_id to get the live package_sha256 and risk_level; explain the reason and risk summary to the user, then call skill_trust_request with action=grant using expected_package_sha256 set to package_sha256 and declared_risk_level set to risk_level from inspect. Grant requires user approval and cannot be remembered. Skills management UI is only a backup. After grant succeeds, do not call load_skills in the same tool loop: this request keeps its pre-grant runtime catalog snapshot, and the skill becomes loadable on the next user turn.";

const INSTALL_SUCCESS_MESSAGE: &str =
    "Skill package installed to ~/.deep-student/skills. It is untrusted by default — call skill_trust_request with action=inspect then grant before the skill body injects or package scripts can run via SKILL_DIR. Skills management is only a backup.";

const PROVENANCE_SETTINGS_PREFIX: &str = "skill.provenance.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillInstallProvenance {
    source_kind: String,
    source_detail: String,
    package_sha256: String,
    risk_level: String,
    installed_at: String,
    session_id: String,
}

#[derive(Debug, Clone)]
struct ParsedSource {
    kind: String,
    detail: String,
    summary: String,
}

pub struct SkillInstallExecutor {
    fetch: FetchExecutor,
}

impl Default for SkillInstallExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillInstallExecutor {
    pub fn new() -> Self {
        Self {
            fetch: FetchExecutor::new(),
        }
    }

    fn strip_namespace(tool_name: &str) -> &str {
        strip_tool_namespace(tool_name)
    }

    fn risk_rank(level: &str) -> u8 {
        match level.to_ascii_lowercase().as_str() {
            "high" => 3,
            "medium" => 2,
            _ => 1,
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn normalize_sha256(raw: &str) -> Result<String, String> {
        let trimmed = raw.trim().to_ascii_lowercase();
        if trimmed.len() != 64 || !trimmed.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err("expected_sha256 must be a 64-character hex SHA-256 digest".to_string());
        }
        Ok(trimmed)
    }

    fn expected_skill_id(args: &Value) -> Result<String, String> {
        let skill_id = args
            .get("skill_id")
            .or_else(|| args.get("skillId"))
            .and_then(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("skill_id is required (use skill_id from skill_scan)")?;
        Ok(skill_id.to_string())
    }

    fn verify_expected_skill_id(expected: &str, actual: &str) -> Result<(), String> {
        if expected == actual {
            return Ok(());
        }
        Err(format!(
            "Skill target mismatch: approval expected skill_id '{}', but the scanned package installs '{}'. Run skill_scan again and use its exact skill_id.",
            expected, actual
        ))
    }

    fn parse_source(args: &Value) -> Result<ParsedSource, String> {
        let source = args
            .get("source")
            .ok_or("source is required ({ url } or { root_id, path })")?;

        if let Some(url) = source.get("url").and_then(|v| v.as_str()) {
            let trimmed = url.trim();
            if trimmed.is_empty() {
                return Err("source.url must not be empty".to_string());
            }
            let parsed =
                reqwest::Url::parse(trimmed).map_err(|e| format!("Invalid source.url: {}", e))?;
            if parsed.scheme() != "https" {
                return Err(
                    "source.url must use https:// (http and other schemes are blocked)".to_string(),
                );
            }
            let summary = safe_truncate(trimmed, 80);
            return Ok(ParsedSource {
                kind: "url".to_string(),
                detail: trimmed.to_string(),
                summary,
            });
        }

        let root_id = source
            .get("root_id")
            .or_else(|| source.get("rootId"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or("source must include url or root_id + path")?;
        let path = source
            .get("path")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .ok_or("source.path is required when using root_id")?;

        let root_lower = root_id.to_ascii_lowercase();
        if root_lower != "temp" && root_lower != "artifacts" {
            return Err(format!(
                "source.root_id must be temp or artifacts, got '{}'",
                root_id
            ));
        }

        let summary = format!("{}:{}", root_lower, path.replace('\\', "/"));
        Ok(ParsedSource {
            kind: "runtime_path".to_string(),
            detail: summary.clone(),
            summary,
        })
    }

    async fn fetch_zip_bytes(
        &self,
        source: &ParsedSource,
        ctx: &ExecutionContext,
    ) -> Result<Vec<u8>, String> {
        match source.kind.as_str() {
            "url" => {
                self.fetch
                    .download_https_bytes(&source.detail, MAX_SKILL_PACKAGE_ZIP_BYTES)
                    .await
            }
            "runtime_path" => Self::read_zip_from_runtime(source, ctx).await,
            other => Err(format!("Unsupported source kind '{}'", other)),
        }
    }

    async fn read_zip_from_runtime(
        source: &ParsedSource,
        ctx: &ExecutionContext,
    ) -> Result<Vec<u8>, String> {
        let (root_id, rel_path) = source
            .detail
            .split_once(':')
            .ok_or("Invalid runtime_path source detail")?;
        let relative = normalize_runtime_relative_path(Some(rel_path))?;
        let state = ctx.window_ref().state::<AppState>();
        let root = runtime_root_by_id(
            ctx.window_ref().app_handle(),
            &state.database,
            &ctx.session_id,
            ctx.skill_package_roots.as_ref(),
            Some(root_id),
            true,
        )?;
        let root_canon = root
            .path
            .canonicalize()
            .map_err(|e| format!("Failed to canonicalize runtime root: {}", e))?;
        let target = root.path.join(&relative);
        if !target.exists() {
            return Err(format!(
                "Skill package file not found at {}",
                source.summary
            ));
        }
        let target_canon = target
            .canonicalize()
            .map_err(|e| format!("Failed to resolve skill package path: {}", e))?;
        if !target_canon.starts_with(&root_canon) {
            return Err("Path escapes the selected runtime root".to_string());
        }
        let meta = fs::metadata(&target_canon)
            .map_err(|e| format!("Failed to stat skill package file: {}", e))?;
        if !meta.is_file() {
            return Err("Skill package source must be a regular file".to_string());
        }
        if meta.len() > MAX_SKILL_PACKAGE_ZIP_BYTES {
            return Err(format!(
                "Skill package too large ({} bytes > {} bytes)",
                meta.len(),
                MAX_SKILL_PACKAGE_ZIP_BYTES
            ));
        }
        let file = tokio::fs::File::open(&target_canon)
            .await
            .map_err(|e| format!("Failed to open skill package file: {}", e))?;
        let mut bytes = Vec::with_capacity(meta.len().min(MAX_SKILL_PACKAGE_ZIP_BYTES) as usize);
        file.take(MAX_SKILL_PACKAGE_ZIP_BYTES + 1)
            .read_to_end(&mut bytes)
            .await
            .map_err(|e| format!("Failed to read skill package file: {}", e))?;
        if bytes.len() as u64 > MAX_SKILL_PACKAGE_ZIP_BYTES {
            return Err(format!(
                "Skill package grew beyond the {} byte limit while being read",
                MAX_SKILL_PACKAGE_ZIP_BYTES
            ));
        }
        Ok(bytes)
    }

    fn scan_result_payload(result: &SkillImportZipResult, source: &ParsedSource) -> Value {
        let mut next_step = "After user confirms, call skill_install with the same source and expected_sha256 set to package_sha256 from this scan.".to_string();
        let mut payload = json!({
            "skill_id": result.skill_id,
            "package_sha256": result.package_sha256,
            "risk_level": result.risk_level,
            "risk_signals": result.risk_signals,
            "scripts_count": result.scripts_count,
            "references_count": result.references_count,
            "allowed_tools_count": result.allowed_tools_count,
            "source_summary": source.summary,
            "install_path_preview": result.path,
            "files_extracted": result.files_extracted,
        });
        if let Some(requires) = &result.requires {
            payload["requires"] = serde_json::to_value(requires).unwrap_or(Value::Null);
            if requires.missing_count > 0 {
                let hints = format_missing_requires_hints(requires);
                if !hints.is_empty() {
                    payload["missing_requires_hints"] = json!(hints);
                }
                let missing_python: Vec<&str> = requires
                    .python_packages
                    .iter()
                    .filter(|pkg| !pkg.found)
                    .map(|pkg| pkg.name.as_str())
                    .collect();
                if !missing_python.is_empty() {
                    next_step = format!(
                        "Missing Python packages ({}). After user confirms, call skill_install with the same source and expected_sha256 set to package_sha256 from this scan; after trust is granted, propose local_shell_execute to install them (prefer `uv pip install ...` or `python3 -m pip install ...`).",
                        missing_python.join(", ")
                    );
                }
            }
        }
        payload["next_step"] = json!(next_step);
        payload
    }

    async fn execute_scan(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let source = Self::parse_source(args)?;
        let bytes = self.fetch_zip_bytes(&source, ctx).await?;
        let result =
            install_skill_package_from_zip_bytes(bytes, DEFAULT_AGENT_SKILLS_BASE, false, true)
                .await
                .map_err(|e| e.to_string())?;
        Ok(Self::scan_result_payload(&result, &source))
    }

    fn provenance_json(
        ctx: &ExecutionContext,
        source: &ParsedSource,
        package_sha256: &str,
        risk_level: &str,
    ) -> Result<String, String> {
        let provenance = SkillInstallProvenance {
            source_kind: source.kind.clone(),
            source_detail: source.detail.clone(),
            package_sha256: package_sha256.to_string(),
            risk_level: risk_level.to_string(),
            installed_at: Utc::now().to_rfc3339(),
            session_id: ctx.session_id.clone(),
        };
        serde_json::to_string_pretty(&provenance)
            .map_err(|e| format!("Failed to serialize provenance: {}", e))
    }

    fn persist_provenance(
        ctx: &ExecutionContext,
        skill_id: &str,
        json_text: &str,
    ) -> Result<(), String> {
        if let Some(db) = ctx.main_db.as_ref() {
            let key = format!("{}{}", PROVENANCE_SETTINGS_PREFIX, skill_id);
            db.save_setting(&key, json_text)
                .map_err(|e| format!("Failed to persist skill provenance: {}", e))?;
        } else {
            log::warn!(
                "[SkillInstallExecutor] main_db unavailable; provenance for '{}' written only to marker file",
                skill_id
            );
        }
        Ok(())
    }

    async fn execute_install(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let expected_sha256 = args
            .get("expected_sha256")
            .or_else(|| args.get("expectedSha256"))
            .and_then(|v| v.as_str())
            .ok_or("expected_sha256 is required (use package_sha256 from skill_scan)")?;
        let expected_sha256 = Self::normalize_sha256(expected_sha256)?;
        let expected_skill_id = Self::expected_skill_id(args)?;

        let declared_risk = args
            .get("declared_risk_level")
            .or_else(|| args.get("declaredRiskLevel"))
            .and_then(|v| v.as_str())
            .unwrap_or("low")
            .to_ascii_lowercase();
        if !matches!(declared_risk.as_str(), "low" | "medium" | "high") {
            return Err("declared_risk_level must be low, medium, or high".to_string());
        }

        let overwrite = args
            .get("overwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let source = Self::parse_source(args)?;
        let bytes = self.fetch_zip_bytes(&source, ctx).await?;
        let actual_sha256 = Self::sha256_hex(&bytes);
        if actual_sha256 != expected_sha256 {
            return Err(format!(
                "Package SHA-256 mismatch: expected {}, got {}. The package may have changed since skill_scan — run skill_scan again.",
                expected_sha256, actual_sha256
            ));
        }

        let prepared =
            prepare_skill_package_from_zip_bytes(bytes, DEFAULT_AGENT_SKILLS_BASE, overwrite)
                .await
                .map_err(|e| e.to_string())?;

        Self::verify_expected_skill_id(&expected_skill_id, &prepared.result().skill_id)?;

        if Self::risk_rank(&prepared.result().risk_level) > Self::risk_rank(&declared_risk) {
            return Err(format!(
                "Detected risk_level '{}' is higher than declared_risk_level '{}'. Run skill_scan again and update declared_risk_level before installing.",
                prepared.result().risk_level, declared_risk
            ));
        }

        let provenance_json = Self::provenance_json(
            ctx,
            &source,
            &prepared.result().package_sha256,
            &prepared.result().risk_level,
        )?;
        prepared
            .write_staged_file(AGENT_INSTALLED_MARKER, provenance_json.as_bytes())
            .map_err(|e| format!("Failed to stage agent provenance marker: {}", e))?;

        // The marker is part of the same staged directory as SKILL.md. Only after the
        // complete directory is published do we update the secondary DB index. A DB
        // failure rolls the directory swap back to the previous skill.
        let (installed, committed) = prepared.commit().map_err(|e| e.to_string())?;
        if let Err(provenance_error) =
            Self::persist_provenance(ctx, &installed.skill_id, &provenance_json)
        {
            return match committed.rollback() {
                Ok(()) => Err(format!(
                    "Failed to persist agent provenance ({}); the previous skill was restored.",
                    provenance_error
                )),
                Err(rollback_error) => Err(format!(
                    "Failed to persist agent provenance ({}), and failed to restore the previous skill ({}).",
                    provenance_error, rollback_error
                )),
            };
        }
        committed.finalize();

        let missing_hints = installed
            .requires
            .as_ref()
            .filter(|probe| probe.missing_count > 0)
            .map(format_missing_requires_hints)
            .unwrap_or_default();

        let mut message = INSTALL_SUCCESS_MESSAGE.to_string();
        if !missing_hints.is_empty() {
            message.push_str(" Some runtime dependencies are missing; see missing_requires_hints.");
        }

        let mut output = json!({
            "installed": true,
            "skill_id": installed.skill_id,
            "path": installed.path,
            "package_sha256": installed.package_sha256,
            "risk_level": installed.risk_level,
            "risk_signals": installed.risk_signals,
            "scripts_count": installed.scripts_count,
            "references_count": installed.references_count,
            "allowed_tools_count": installed.allowed_tools_count,
            "source_summary": source.summary,
            "trust_status": "untrusted",
            "message": message,
            "next_step": POST_WRITE_TRUST_NEXT_STEP,
        });
        if let Some(requires) = &installed.requires {
            output["requires"] = serde_json::to_value(requires).unwrap_or(Value::Null);
        }
        if !missing_hints.is_empty() {
            output["missing_requires_hints"] = json!(missing_hints);
        }

        Ok(output)
    }
}

#[async_trait]
impl ToolExecutor for SkillInstallExecutor {
    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let short = Self::strip_namespace(&call.name);

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match short {
            tool_names::SKILL_SCAN => self.execute_scan(&call.arguments, ctx).await,
            tool_names::SKILL_INSTALL => self.execute_install(&call.arguments, ctx).await,
            other => Err(format!("Unsupported skill install tool: {}", other)),
        };

        let duration = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(output) => {
                ctx.emit_tool_call_end(Some(json!({
                    "result": output,
                    "durationMs": duration,
                })));

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    output,
                    duration,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[SkillInstallExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(error_msg) => {
                ctx.emit_tool_call_error(&error_msg);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    error_msg,
                    duration,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[SkillInstallExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            Self::strip_namespace(tool_name),
            tool_names::SKILL_SCAN | tool_names::SKILL_INSTALL
        )
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        if Self::strip_namespace(tool_name) == tool_names::SKILL_INSTALL {
            ToolSensitivity::High
        } else {
            ToolSensitivity::Low
        }
    }

    fn name(&self) -> &'static str {
        "SkillInstallExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn risk_rank_orders_levels() {
        assert!(
            SkillInstallExecutor::risk_rank("high") > SkillInstallExecutor::risk_rank("medium")
        );
        assert!(SkillInstallExecutor::risk_rank("medium") > SkillInstallExecutor::risk_rank("low"));
    }

    #[test]
    fn parse_url_source_requires_https() {
        let args = json!({ "source": { "url": "http://example.com/pkg.zip" } });
        assert!(SkillInstallExecutor::parse_source(&args).is_err());
        let ok = json!({ "source": { "url": "https://example.com/pkg.zip" } });
        let parsed = SkillInstallExecutor::parse_source(&ok).unwrap();
        assert_eq!(parsed.kind, "url");
    }

    #[test]
    fn parse_runtime_source_only_allows_temp_and_artifacts() {
        let bad = json!({ "source": { "root_id": "workspace", "path": "x.zip" } });
        assert!(SkillInstallExecutor::parse_source(&bad).is_err());
        let ok = json!({ "source": { "root_id": "temp", "path": "attachments/pkg.zip" } });
        let parsed = SkillInstallExecutor::parse_source(&ok).unwrap();
        assert_eq!(parsed.kind, "runtime_path");
        assert!(parsed.summary.contains("temp:"));
    }

    #[test]
    fn normalize_sha256_rejects_invalid() {
        assert!(SkillInstallExecutor::normalize_sha256("abc").is_err());
        assert!(SkillInstallExecutor::normalize_sha256(
            "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        )
        .is_ok());
    }

    #[test]
    fn expected_skill_id_must_match_scanned_package_target() {
        assert!(SkillInstallExecutor::verify_expected_skill_id("reviewed", "reviewed").is_ok());
        let error = SkillInstallExecutor::verify_expected_skill_id("reviewed", "different")
            .expect_err("approval target mismatch must fail closed");
        assert!(error.contains("approval expected skill_id 'reviewed'"));
    }

    #[test]
    fn url_source_summary_truncates_multibyte_text_without_panicking() {
        let url = format!("https://example.com/{}中文", "a".repeat(70));
        let parsed = SkillInstallExecutor::parse_source(&json!({ "source": { "url": url } }))
            .expect("unicode URL should parse");
        assert!(parsed.summary.is_char_boundary(parsed.summary.len()));
        assert!(parsed.summary.chars().count() <= 83);
        assert!(parsed.summary.ends_with("..."));
    }

    #[test]
    fn install_success_narrative_routes_through_skill_trust_request() {
        assert!(INSTALL_SUCCESS_MESSAGE.contains("skill_trust_request"));
        assert!(INSTALL_SUCCESS_MESSAGE.contains("action=inspect then grant"));
        assert!(INSTALL_SUCCESS_MESSAGE.contains("Skills management is only a backup"));
        assert!(!INSTALL_SUCCESS_MESSAGE.contains("user must trust it in Skills management"));

        assert!(POST_WRITE_TRUST_NEXT_STEP.contains("skill_trust_request"));
        assert!(POST_WRITE_TRUST_NEXT_STEP.contains("action=inspect"));
        assert!(POST_WRITE_TRUST_NEXT_STEP.contains("action=grant"));
        assert!(POST_WRITE_TRUST_NEXT_STEP.contains("expected_package_sha256"));
        assert!(POST_WRITE_TRUST_NEXT_STEP.contains("declared_risk_level"));
        assert!(POST_WRITE_TRUST_NEXT_STEP.contains("Skills management UI is only a backup"));
        assert!(POST_WRITE_TRUST_NEXT_STEP.contains("After trust is granted, load_skills"));
    }
}
