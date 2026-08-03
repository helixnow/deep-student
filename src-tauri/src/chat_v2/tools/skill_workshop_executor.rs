//! Agent 技能 workshop 提案工具执行器
//!
//! - `skill_workshop_propose`（Medium）：提案创建/更新/列表/拒绝，写入 pending 区
//! - `skill_workshop_apply`（High，必审批）：校验提案完整性后写入活体技能目录 + provenance

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use async_trait::async_trait;
use base64::{engine::general_purpose, Engine as _};
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::skill_install_executor::{AGENT_INSTALLED_MARKER, POST_WRITE_TRUST_NEXT_STEP};
use super::strip_tool_namespace;
use crate::chat_v2::skills::{
    assess_skill_package_risk, expand_path, is_portable_skill_path_component, validate_skill_path,
    StagedSkillDirectory, DEFAULT_AGENT_SKILLS_BASE,
};
use crate::chat_v2::types::{ToolCall, ToolResultInfo};

pub mod tool_names {
    pub const SKILL_WORKSHOP_PROPOSE: &str = "skill_workshop_propose";
    pub const SKILL_WORKSHOP_APPLY: &str = "skill_workshop_apply";
}

const PROPOSALS_SUBDIR: &str = "skill_proposals";
const SKILL_FILE_NAME: &str = "SKILL.md";
const PROPOSAL_META_FILE: &str = "PROPOSAL.json";
const APPLY_SUCCESS_MESSAGE: &str =
    "Skill written to ~/.deep-student/skills. It is untrusted by default — call skill_trust_request with action=inspect then grant before the skill body injects or package scripts can run via SKILL_DIR. Do not load_skills until trust is granted. Skills management is only a backup.";
const MAX_CONTENT_BYTES: usize = 40_000;
const MAX_PACKAGE_FILES: usize = 256;
const MAX_PACKAGE_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PACKAGE_TOTAL_BYTES: usize = 32 * 1024 * 1024;
const MAX_PENDING_PROPOSALS: usize = 50;
const PROVENANCE_SETTINGS_PREFIX: &str = "skill.provenance.";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposalMeta {
    proposal_id: String,
    action: String,
    skill_id: String,
    content_sha256: String,
    created_at: String,
    session_id: String,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    package_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    files: Vec<ProposalFileMeta>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_package_sha256: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    previous_files: Vec<ProposalFileMeta>,
    #[serde(default = "default_package_version")]
    package_version: u64,
}

fn default_package_version() -> u64 {
    1
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProposalFileMeta {
    path: String,
    sha256: String,
    size: usize,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProposalFileInput {
    path: String,
    #[serde(default)]
    content: Option<String>,
    #[serde(default, alias = "content_base64")]
    content_base64: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentWorkshopMarker {
    source_kind: String,
    proposal_id: String,
    content_sha256: String,
    #[serde(default)]
    package_sha256: String,
    #[serde(default = "default_package_version")]
    package_version: u64,
    #[serde(default)]
    files: Vec<ProposalFileMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_package_sha256: Option<String>,
    installed_at: String,
    session_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillWorkshopProvenance {
    source_kind: String,
    source_detail: String,
    package_sha256: String,
    risk_level: String,
    installed_at: String,
    session_id: String,
    package_version: u64,
    files: Vec<ProposalFileMeta>,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_package_sha256: Option<String>,
}

pub struct SkillWorkshopExecutor;

impl Default for SkillWorkshopExecutor {
    fn default() -> Self {
        Self::new()
    }
}

impl SkillWorkshopExecutor {
    pub fn new() -> Self {
        Self
    }

    fn strip_namespace(tool_name: &str) -> &str {
        strip_tool_namespace(tool_name)
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        hex::encode(Sha256::digest(bytes))
    }

    fn normalize_sha256(raw: &str, field: &str) -> Result<String, String> {
        let normalized = raw.trim().to_ascii_lowercase();
        if normalized.len() != 64 || !normalized.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(format!(
                "{} must be a 64-character SHA-256 hex digest",
                field
            ));
        }
        Ok(normalized)
    }

    fn proposal_revision_sha256(meta: &ProposalMeta) -> String {
        let mut hasher = Sha256::new();
        for field in [
            meta.proposal_id.as_str(),
            meta.action.as_str(),
            meta.skill_id.as_str(),
            meta.content_sha256.as_str(),
            meta.created_at.as_str(),
            meta.session_id.as_str(),
            meta.status.as_str(),
            meta.previous_sha256.as_deref().unwrap_or(""),
            meta.package_sha256.as_deref().unwrap_or(""),
            meta.previous_package_sha256.as_deref().unwrap_or(""),
        ] {
            hasher.update((field.len() as u64).to_le_bytes());
            hasher.update(field.as_bytes());
        }
        hasher.update(meta.package_version.to_le_bytes());
        for file in &meta.files {
            for field in [file.path.as_str(), file.sha256.as_str()] {
                hasher.update((field.len() as u64).to_le_bytes());
                hasher.update(field.as_bytes());
            }
            hasher.update((file.size as u64).to_le_bytes());
        }
        for file in &meta.previous_files {
            for field in [file.path.as_str(), file.sha256.as_str()] {
                hasher.update((field.len() as u64).to_le_bytes());
                hasher.update(field.as_bytes());
            }
            hasher.update((file.size as u64).to_le_bytes());
        }
        hex::encode(hasher.finalize())
    }

    fn assess_package_risk(files: &[(String, Vec<u8>)]) -> (String, Vec<String>) {
        assess_skill_package_risk(files)
    }

    fn normalize_package_path(raw: &str) -> Result<String, String> {
        if raw.is_empty() || raw.contains('\\') || Path::new(raw).is_absolute() {
            return Err(format!("Invalid skill package path: {:?}", raw));
        }
        let mut parts = Vec::new();
        for component in Path::new(raw).components() {
            match component {
                std::path::Component::Normal(part) => {
                    let part = part
                        .to_str()
                        .ok_or_else(|| format!("Skill package path is not UTF-8: {:?}", raw))?;
                    if part.is_empty() || part == "." || part == ".." {
                        return Err(format!("Invalid skill package path: {:?}", raw));
                    }
                    parts.push(part);
                }
                _ => return Err(format!("Invalid skill package path: {:?}", raw)),
            }
        }
        let normalized = parts.join("/");
        let normalized_lower = normalized.to_ascii_lowercase();
        let allowed = normalized.eq_ignore_ascii_case(SKILL_FILE_NAME)
            || [
                "scripts/",
                "references/",
                "assets/",
                "agents/",
                "templates/",
                "examples/",
            ]
            .iter()
            .any(|prefix| normalized_lower.starts_with(prefix))
            || normalized_lower == "_meta.json"
            || normalized_lower == "skill-card.md"
            || (!normalized_lower.contains('/')
                && (normalized_lower == "readme"
                    || normalized_lower.starts_with("readme.")
                    || normalized_lower == "license"
                    || normalized_lower.starts_with("license.")));
        if !allowed {
            return Err(format!(
                "Skill package path '{}' is outside the supported Agent Skills package layout (SKILL.md, scripts/, references/, assets/, agents/, templates/, examples/, README*, LICENSE*, _meta.json, skill-card.md)",
                raw
            ));
        }
        if normalized.eq_ignore_ascii_case(SKILL_FILE_NAME) {
            Ok(SKILL_FILE_NAME.to_string())
        } else {
            Ok(normalized)
        }
    }

    pub(crate) fn package_sha256(files: &[(String, Vec<u8>)]) -> String {
        let mut ordered: Vec<_> = files.iter().collect();
        ordered.sort_by(|left, right| left.0.cmp(&right.0));
        let mut hasher = Sha256::new();
        for (path, bytes) in ordered {
            hasher.update((path.len() as u64).to_le_bytes());
            hasher.update(path.as_bytes());
            hasher.update((bytes.len() as u64).to_le_bytes());
            hasher.update(bytes);
        }
        hex::encode(hasher.finalize())
    }

    fn package_file_meta(files: &[(String, Vec<u8>)]) -> Vec<ProposalFileMeta> {
        let mut result: Vec<_> = files
            .iter()
            .map(|(path, bytes)| ProposalFileMeta {
                path: path.clone(),
                sha256: Self::sha256_hex(bytes),
                size: bytes.len(),
            })
            .collect();
        result.sort_by(|left, right| left.path.cmp(&right.path));
        result
    }

    fn validate_package_files(
        mut files: Vec<(String, Vec<u8>)>,
    ) -> Result<Vec<(String, Vec<u8>)>, String> {
        if files.is_empty() {
            return Err("files must contain SKILL.md".to_string());
        }
        if files.len() > MAX_PACKAGE_FILES {
            return Err(format!(
                "Skill package exceeds {} file limit",
                MAX_PACKAGE_FILES
            ));
        }
        let mut seen = HashSet::new();
        let mut total = 0usize;
        for (path, bytes) in &mut files {
            *path = Self::normalize_package_path(path)?;
            let folded = path.to_lowercase();
            if !seen.insert(folded) {
                return Err(format!("Skill package contains duplicate path: {}", path));
            }
            if bytes.len() > MAX_PACKAGE_FILE_BYTES {
                return Err(format!(
                    "Skill package file '{}' exceeds {} byte limit",
                    path, MAX_PACKAGE_FILE_BYTES
                ));
            }
            total = total
                .checked_add(bytes.len())
                .ok_or("Skill package total size overflow")?;
            if total > MAX_PACKAGE_TOTAL_BYTES {
                return Err(format!(
                    "Skill package exceeds {} byte total limit",
                    MAX_PACKAGE_TOTAL_BYTES
                ));
            }
        }
        let skill = files
            .iter()
            .find(|(path, _)| path == SKILL_FILE_NAME)
            .ok_or("Skill package must contain SKILL.md")?;
        let content = std::str::from_utf8(&skill.1)
            .map_err(|e| format!("SKILL.md is not valid UTF-8: {}", e))?;
        Self::validate_content(content)?;
        files.sort_by(|left, right| left.0.cmp(&right.0));
        Ok(files)
    }

    fn package_files_from_args(args: &Value) -> Result<(Vec<(String, Vec<u8>)>, bool), String> {
        if let Some(value) = args.get("files") {
            let inputs: Vec<ProposalFileInput> = serde_json::from_value(value.clone())
                .map_err(|e| format!("Invalid files list: {}", e))?;
            let mut files = Vec::with_capacity(inputs.len());
            for input in inputs {
                let bytes = match (input.content, input.content_base64) {
                    (Some(content), None) => content.into_bytes(),
                    (None, Some(encoded)) => general_purpose::STANDARD
                        .decode(encoded.trim())
                        .map_err(|e| {
                            format!("Invalid base64 content for '{}': {}", input.path, e)
                        })?,
                    (Some(_), Some(_)) => {
                        return Err(format!(
                            "File '{}' must provide exactly one of content or content_base64",
                            input.path
                        ))
                    }
                    (None, None) => {
                        return Err(format!(
                            "File '{}' must provide content or content_base64",
                            input.path
                        ))
                    }
                };
                files.push((input.path, bytes));
            }
            return Ok((Self::validate_package_files(files)?, true));
        }
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("content or files is required")?;
        Self::validate_content(content)?;
        Ok((
            vec![(SKILL_FILE_NAME.to_string(), content.as_bytes().to_vec())],
            false,
        ))
    }

    pub(crate) fn read_package_directory(root: &Path) -> Result<Vec<(String, Vec<u8>)>, String> {
        let mut files = Vec::new();
        if !root.exists() {
            return Err(format!("Skill directory does not exist: {:?}", root));
        }
        for entry in walkdir::WalkDir::new(root).follow_links(false) {
            let entry = entry.map_err(|e| format!("Failed to inspect skill package: {}", e))?;
            if entry.path() == root {
                continue;
            }
            if entry.file_type().is_symlink() {
                return Err(format!(
                    "Skill packages may not contain symlinks: {:?}",
                    entry.path()
                ));
            }
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|e| format!("Failed to resolve package path: {}", e))?
                .to_string_lossy()
                .replace('\\', "/");
            if relative == AGENT_INSTALLED_MARKER {
                continue;
            }
            files.push((
                relative,
                fs::read(entry.path())
                    .map_err(|e| format!("Failed to read package file: {}", e))?,
            ));
        }
        Self::validate_package_files(files)
    }

    fn verify_approved_proposal(
        meta: &ProposalMeta,
        proposal_files: &[(String, Vec<u8>)],
        expected_content_sha256: &str,
        expected_proposal_revision: &str,
    ) -> Result<String, String> {
        let actual_revision = Self::proposal_revision_sha256(meta);
        if actual_revision != expected_proposal_revision {
            return Err(format!(
                "Proposal changed after approval scope was created: expected revision {}, got {}. Review the proposal again before applying.",
                expected_proposal_revision, actual_revision
            ));
        }
        if meta.content_sha256 != expected_content_sha256 {
            return Err(format!(
                "Proposal metadata content hash changed after approval scope was created: expected {}, got {}. Review the proposal again before applying.",
                expected_content_sha256, meta.content_sha256
            ));
        }
        let proposal_bytes = proposal_files
            .iter()
            .find(|(path, _)| path == SKILL_FILE_NAME)
            .map(|(_, bytes)| bytes.as_slice())
            .ok_or("Proposal package is missing SKILL.md")?;
        let actual_sha256 = Self::sha256_hex(proposal_bytes);
        if actual_sha256 != expected_content_sha256 {
            return Err(format!(
                "Proposal SKILL.md changed after approval scope was created: expected {}, got {}. Review the proposal again before applying.",
                expected_content_sha256, actual_sha256
            ));
        }
        if let Some(expected_package_sha256) = meta.package_sha256.as_deref() {
            let actual_package_sha256 = Self::package_sha256(proposal_files);
            if actual_package_sha256 != expected_package_sha256 {
                return Err(format!(
                    "Proposal package changed after approval scope was created: expected {}, got {}. Review the proposal again before applying.",
                    expected_package_sha256, actual_package_sha256
                ));
            }
            if Self::package_file_meta(proposal_files) != meta.files {
                return Err("Proposal file manifest changed after approval scope was created. Review the proposal again before applying.".to_string());
            }
        }
        Ok(actual_sha256)
    }

    fn proposals_root(ctx: &ExecutionContext) -> Result<PathBuf, String> {
        let app_data = ctx
            .window_ref()
            .app_handle()
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to resolve app_data_dir: {}", e))?;
        Ok(app_data.join(PROPOSALS_SUBDIR))
    }

    fn generate_proposal_id() -> String {
        let millis = Utc::now().timestamp_millis();
        let suffix: String = rand::thread_rng()
            .sample_iter(&rand::distributions::Uniform::new_inclusive(b'a', b'z'))
            .take(4)
            .map(char::from)
            .collect();
        format!("wp_{}_{}", millis, suffix)
    }

    fn validate_proposal_id(proposal_id: &str) -> Result<(), String> {
        let trimmed = proposal_id.trim();
        if trimmed.is_empty() {
            return Err("proposal_id must not be empty".to_string());
        }
        let valid = trimmed.starts_with("wp_")
            && trimmed.len() > 4
            && trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            return Err(format!(
                "Invalid proposal_id '{}': expected wp_<timestamp>_<suffix>",
                proposal_id
            ));
        }
        Ok(())
    }

    fn validate_skill_id(skill_id: &str) -> Result<(), String> {
        let trimmed = skill_id.trim();
        if trimmed.is_empty() {
            return Err("skill_id must not be empty".to_string());
        }
        if !trimmed
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
            || !is_portable_skill_path_component(trimmed)
        {
            return Err(
                "skill_id must be a portable directory name containing only letters, numbers, hyphens, and underscores"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn validate_content(content: &str) -> Result<(), String> {
        let bytes = content.as_bytes();
        if bytes.is_empty() {
            return Err("content must not be empty".to_string());
        }
        if bytes.len() > MAX_CONTENT_BYTES {
            return Err(format!(
                "content exceeds {} byte limit (got {} bytes)",
                MAX_CONTENT_BYTES,
                bytes.len()
            ));
        }
        let trimmed_start = content.trim_start();
        let mut lines = trimmed_start.lines();
        if lines.next() != Some("---") || !lines.any(|line| line == "---") {
            return Err(
                "content must contain a complete YAML frontmatter block delimited by exact --- lines"
                    .to_string(),
            );
        }
        Ok(())
    }

    fn proposal_dir(root: &Path, proposal_id: &str) -> PathBuf {
        root.join(proposal_id)
    }

    fn read_proposal_meta(dir: &Path) -> Result<ProposalMeta, String> {
        let meta_path = dir.join(PROPOSAL_META_FILE);
        let text = fs::read_to_string(&meta_path)
            .map_err(|e| format!("Failed to read {}: {}", PROPOSAL_META_FILE, e))?;
        serde_json::from_str(&text).map_err(|e| format!("Invalid {}: {}", PROPOSAL_META_FILE, e))
    }

    fn write_proposal_meta(dir: &Path, meta: &ProposalMeta) -> Result<(), String> {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create proposal directory: {}", e))?;
        let json_text = serde_json::to_string_pretty(meta)
            .map_err(|e| format!("Failed to serialize proposal meta: {}", e))?;
        let target = dir.join(PROPOSAL_META_FILE);
        let temporary = dir.join(format!(
            ".{}.tmp-{}",
            PROPOSAL_META_FILE,
            uuid::Uuid::new_v4()
        ));
        let write_result = (|| -> Result<(), String> {
            let mut file = fs::File::create(&temporary)
                .map_err(|e| format!("Failed to create temporary proposal meta: {}", e))?;
            file.write_all(json_text.as_bytes())
                .map_err(|e| format!("Failed to write temporary proposal meta: {}", e))?;
            file.sync_all()
                .map_err(|e| format!("Failed to fsync temporary proposal meta: {}", e))?;
            let backup = dir.join(format!(
                ".{}.backup-{}",
                PROPOSAL_META_FILE,
                uuid::Uuid::new_v4()
            ));
            let had_target = target.exists();
            if had_target {
                fs::rename(&target, &backup).map_err(|e| {
                    format!(
                        "Failed to stage previous {} for replacement: {}",
                        PROPOSAL_META_FILE, e
                    )
                })?;
            }
            if let Err(publish_error) = fs::rename(&temporary, &target) {
                if had_target {
                    let _ = fs::rename(&backup, &target);
                }
                return Err(format!(
                    "Failed to publish {}: {}",
                    PROPOSAL_META_FILE, publish_error
                ));
            }
            if had_target {
                let _ = fs::remove_file(backup);
            }
            Ok(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        write_result
    }

    /// 写入提案目录（SKILL.md + PROPOSAL.json）。
    ///
    /// P1 修复：提案目录是全新目录，必须先 `create_dir_all` 再写 SKILL.md，
    /// 否则 `fs::write` 对不存在的目录直接返回 NotFound，propose_create/propose_update 必失败。
    fn write_proposal_files(
        dir: &Path,
        files: &[(String, Vec<u8>)],
        meta: &ProposalMeta,
    ) -> Result<(), String> {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create proposal directory: {}", e))?;
        for (relative, bytes) in files {
            let target = dir.join(relative);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to create proposal package directory: {}", e))?;
            }
            let mut file = fs::File::create(&target)
                .map_err(|e| format!("Failed to create proposal file '{}': {}", relative, e))?;
            file.write_all(bytes)
                .map_err(|e| format!("Failed to write proposal file '{}': {}", relative, e))?;
            file.sync_all()
                .map_err(|e| format!("Failed to fsync proposal file '{}': {}", relative, e))?;
        }
        Self::write_proposal_meta(dir, meta)
    }

    fn read_proposal_package(
        dir: &Path,
        meta: &ProposalMeta,
    ) -> Result<Vec<(String, Vec<u8>)>, String> {
        if meta.files.is_empty() {
            let bytes = fs::read(dir.join(SKILL_FILE_NAME))
                .map_err(|e| format!("Failed to read proposal SKILL.md: {}", e))?;
            return Self::validate_package_files(vec![(SKILL_FILE_NAME.to_string(), bytes)]);
        }
        let mut by_path = HashMap::new();
        for file in &meta.files {
            let normalized = Self::normalize_package_path(&file.path)?;
            let target = dir.join(&normalized);
            let metadata = fs::symlink_metadata(&target)
                .map_err(|e| format!("Failed to inspect proposal file '{}': {}", normalized, e))?;
            if metadata.file_type().is_symlink() || !metadata.is_file() {
                return Err(format!(
                    "Proposal file '{}' must be a regular non-symlink file",
                    normalized
                ));
            }
            let bytes = fs::read(&target)
                .map_err(|e| format!("Failed to read proposal file '{}': {}", normalized, e))?;
            by_path.insert(normalized, bytes);
        }
        let files: Vec<_> = by_path.into_iter().collect();
        Self::validate_package_files(files)
    }

    fn count_pending_proposals(root: &Path) -> Result<usize, String> {
        if !root.exists() {
            return Ok(0);
        }
        let mut count = 0usize;
        for entry in fs::read_dir(root).map_err(|e| format!("Failed to list proposals: {}", e))? {
            let entry = entry.map_err(|e| format!("Failed to read proposal entry: {}", e))?;
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let meta = Self::read_proposal_meta(&entry.path());
            if let Ok(m) = meta {
                if m.status == "pending" {
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    fn skill_target_path(skill_id: &str) -> Result<PathBuf, String> {
        let base = expand_path(DEFAULT_AGENT_SKILLS_BASE);
        let skill_file = base.join(skill_id).join(SKILL_FILE_NAME);
        validate_skill_path(&skill_file).map_err(|e| e.to_string())?;
        Ok(skill_file)
    }

    fn relative_skill_display(skill_id: &str) -> String {
        format!(
            "{}/{}/{}",
            DEFAULT_AGENT_SKILLS_BASE, skill_id, SKILL_FILE_NAME
        )
    }

    fn execute_propose_create(
        args: &Value,
        ctx: &ExecutionContext,
        proposals_root: &Path,
    ) -> Result<Value, String> {
        let skill_id = args
            .get("skill_id")
            .or_else(|| args.get("skillId"))
            .and_then(|v| v.as_str())
            .ok_or("skill_id is required for propose_create")?;
        Self::validate_skill_id(skill_id)?;
        let (files, is_full_package) = Self::package_files_from_args(args)?;
        let skill_bytes = files
            .iter()
            .find(|(path, _)| path == SKILL_FILE_NAME)
            .ok_or("Proposal package is missing SKILL.md")?
            .1
            .as_slice();

        if Self::count_pending_proposals(proposals_root)? >= MAX_PENDING_PROPOSALS {
            return Err(format!(
                "Too many pending proposals (max {}). Reject or apply existing proposals first.",
                MAX_PENDING_PROPOSALS
            ));
        }

        let proposal_id = Self::generate_proposal_id();
        let content_sha256 = Self::sha256_hex(skill_bytes);
        let package_sha256 = Self::package_sha256(&files);
        let file_manifest = Self::package_file_meta(&files);
        let dir = Self::proposal_dir(proposals_root, &proposal_id);

        let meta = ProposalMeta {
            proposal_id: proposal_id.clone(),
            action: "propose_create".to_string(),
            skill_id: skill_id.to_string(),
            content_sha256: content_sha256.clone(),
            created_at: Utc::now().to_rfc3339(),
            session_id: ctx.session_id.clone(),
            status: "pending".to_string(),
            previous_sha256: None,
            package_sha256: Some(package_sha256.clone()),
            files: file_manifest.clone(),
            previous_package_sha256: None,
            previous_files: Vec::new(),
            package_version: 1,
        };
        let proposal_revision = Self::proposal_revision_sha256(&meta);
        let (risk_level, risk_signals) = Self::assess_package_risk(&files);

        Self::write_proposal_files(&dir, &files, &meta)?;

        Ok(json!({
            "proposal_id": proposal_id,
            "action": "propose_create",
            "skill_id": skill_id,
            "content_sha256": content_sha256,
            "proposal_revision": proposal_revision,
            "content_length": skill_bytes.len(),
            "package_sha256": package_sha256,
            "package_version": 1,
            "files": file_manifest,
            "full_package": is_full_package,
            "risk_level": risk_level,
            "risk_signals": risk_signals,
            "status": "pending",
            "next_step": "After user reviews the proposal, call skill_workshop_apply with proposal_id, skill_id, expected_content_sha256, and expected_proposal_revision from this result. Apply requires user approval and cannot be remembered.",
        }))
    }

    fn execute_propose_update(
        args: &Value,
        ctx: &ExecutionContext,
        proposals_root: &Path,
    ) -> Result<Value, String> {
        let skill_id = args
            .get("skill_id")
            .or_else(|| args.get("skillId"))
            .and_then(|v| v.as_str())
            .ok_or("skill_id is required for propose_update")?;
        Self::validate_skill_id(skill_id)?;
        let (mut files, is_full_package) = Self::package_files_from_args(args)?;

        let target = Self::skill_target_path(skill_id)?;
        if !target.exists() {
            return Err(format!(
                "Skill '{}' does not exist at {}. Use propose_create for new skills.",
                skill_id,
                Self::relative_skill_display(skill_id)
            ));
        }

        let existing_bytes =
            fs::read(&target).map_err(|e| format!("Failed to read existing SKILL.md: {}", e))?;
        let previous_sha256 = Self::sha256_hex(&existing_bytes);
        let existing_package =
            Self::read_package_directory(target.parent().ok_or("Invalid skill target path")?)?;
        let previous_package_sha256 = Self::package_sha256(&existing_package);
        let previous_files = Self::package_file_meta(&existing_package);
        // The legacy content-only API means "replace SKILL.md". Materialize the
        // complete effective package in the proposal so apply remains atomic and
        // package provenance covers resources retained from the previous version.
        if !is_full_package {
            let new_skill = files.pop().ok_or("Legacy proposal is missing SKILL.md")?;
            files = existing_package.clone();
            if let Some(slot) = files.iter_mut().find(|(path, _)| path == SKILL_FILE_NAME) {
                *slot = new_skill;
            } else {
                files.push(new_skill);
            }
            files = Self::validate_package_files(files)?;
        }
        let skill_bytes = files
            .iter()
            .find(|(path, _)| path == SKILL_FILE_NAME)
            .ok_or("Proposal package is missing SKILL.md")?
            .1
            .as_slice();
        let previous_version =
            fs::read_to_string(target.parent().unwrap().join(AGENT_INSTALLED_MARKER))
                .ok()
                .and_then(|text| serde_json::from_str::<AgentWorkshopMarker>(&text).ok())
                .map(|marker| marker.package_version)
                .unwrap_or(0);

        if Self::count_pending_proposals(proposals_root)? >= MAX_PENDING_PROPOSALS {
            return Err(format!(
                "Too many pending proposals (max {}). Reject or apply existing proposals first.",
                MAX_PENDING_PROPOSALS
            ));
        }

        let proposal_id = Self::generate_proposal_id();
        let content_sha256 = Self::sha256_hex(skill_bytes);
        let package_sha256 = Self::package_sha256(&files);
        let file_manifest = Self::package_file_meta(&files);
        let dir = Self::proposal_dir(proposals_root, &proposal_id);

        let meta = ProposalMeta {
            proposal_id: proposal_id.clone(),
            action: "propose_update".to_string(),
            skill_id: skill_id.to_string(),
            content_sha256: content_sha256.clone(),
            created_at: Utc::now().to_rfc3339(),
            session_id: ctx.session_id.clone(),
            status: "pending".to_string(),
            previous_sha256: Some(previous_sha256),
            package_sha256: Some(package_sha256.clone()),
            files: file_manifest.clone(),
            previous_package_sha256: Some(previous_package_sha256.clone()),
            previous_files,
            package_version: previous_version.saturating_add(1).max(1),
        };
        let proposal_revision = Self::proposal_revision_sha256(&meta);
        let (risk_level, risk_signals) = Self::assess_package_risk(&files);

        Self::write_proposal_files(&dir, &files, &meta)?;

        Ok(json!({
            "proposal_id": proposal_id,
            "action": "propose_update",
            "skill_id": skill_id,
            "content_sha256": content_sha256,
            "proposal_revision": proposal_revision,
            "previous_sha256": meta.previous_sha256,
            "content_length": skill_bytes.len(),
            "package_sha256": package_sha256,
            "package_version": meta.package_version,
            "previous_package_sha256": previous_package_sha256,
            "files": file_manifest,
            "full_package": is_full_package,
            "risk_level": risk_level,
            "risk_signals": risk_signals,
            "status": "pending",
            "next_step": "After user reviews the diff, call skill_workshop_apply with proposal_id, skill_id, expected_content_sha256, and expected_proposal_revision from this result. Apply requires user approval and cannot be remembered.",
        }))
    }

    fn execute_list(proposals_root: &Path) -> Result<Value, String> {
        if !proposals_root.exists() {
            return Ok(json!({ "pending": [], "count": 0 }));
        }

        let mut pending = Vec::new();
        for entry in
            fs::read_dir(proposals_root).map_err(|e| format!("Failed to list proposals: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read proposal entry: {}", e))?;
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let dir = entry.path();
            let meta = match Self::read_proposal_meta(&dir) {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.status != "pending" {
                continue;
            }
            let content_len = fs::metadata(dir.join(SKILL_FILE_NAME))
                .map(|m| m.len() as usize)
                .unwrap_or(0);
            let proposal_revision = Self::proposal_revision_sha256(&meta);
            pending.push(json!({
                "proposal_id": meta.proposal_id,
                "action": meta.action,
                "skill_id": meta.skill_id,
                "content_sha256": meta.content_sha256,
                "package_sha256": meta.package_sha256,
                "package_version": meta.package_version,
                "previous_package_sha256": meta.previous_package_sha256,
                "files": meta.files,
                "proposal_revision": proposal_revision,
                "created_at": meta.created_at,
                "content_length": content_len,
            }));
        }

        pending.sort_by(|a, b| {
            let ta = a.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
            let tb = b.get("created_at").and_then(|v| v.as_str()).unwrap_or("");
            tb.cmp(ta)
        });

        let count = pending.len();
        Ok(json!({ "pending": pending, "count": count }))
    }

    fn execute_reject(args: &Value, proposals_root: &Path) -> Result<Value, String> {
        let proposal_id = args
            .get("proposal_id")
            .or_else(|| args.get("proposalId"))
            .and_then(|v| v.as_str())
            .ok_or("proposal_id is required for reject")?;
        Self::validate_proposal_id(proposal_id)?;

        let dir = Self::proposal_dir(proposals_root, proposal_id);
        if !dir.exists() {
            return Err(format!("Proposal '{}' not found", proposal_id));
        }

        let mut meta = Self::read_proposal_meta(&dir)?;
        if meta.status != "pending" {
            return Err(format!(
                "Proposal '{}' status is '{}' (only pending proposals can be rejected)",
                proposal_id, meta.status
            ));
        }
        meta.status = "rejected".to_string();
        Self::write_proposal_meta(&dir, &meta)?;

        Ok(json!({
            "proposal_id": proposal_id,
            "status": "rejected",
            "skill_id": meta.skill_id,
            "message": "Proposal rejected; files retained for audit.",
        }))
    }

    async fn execute_propose(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let action = args
            .get("action")
            .and_then(|v| v.as_str())
            .ok_or("action is required (propose_create | propose_update | list | reject)")?;

        let proposals_root = Self::proposals_root(ctx)?;

        match action {
            "propose_create" => Self::execute_propose_create(args, ctx, &proposals_root),
            "propose_update" => Self::execute_propose_update(args, ctx, &proposals_root),
            "list" => Self::execute_list(&proposals_root),
            "reject" => Self::execute_reject(args, &proposals_root),
            other => Err(format!(
                "Unsupported action '{}'. Allowed: propose_create, propose_update, list, reject",
                other
            )),
        }
    }

    fn provenance_payloads(
        ctx: &ExecutionContext,
        proposal_id: &str,
        content_sha256: &str,
        package_sha256: &str,
        package_version: u64,
        files: &[ProposalFileMeta],
        previous_package_sha256: Option<&str>,
        risk_level: &str,
    ) -> Result<(String, String), String> {
        let marker = AgentWorkshopMarker {
            source_kind: "agent_workshop".to_string(),
            proposal_id: proposal_id.to_string(),
            content_sha256: content_sha256.to_string(),
            package_sha256: package_sha256.to_string(),
            package_version,
            files: files.to_vec(),
            previous_package_sha256: previous_package_sha256.map(str::to_string),
            installed_at: Utc::now().to_rfc3339(),
            session_id: ctx.session_id.clone(),
        };
        let marker_text = serde_json::to_string_pretty(&marker)
            .map_err(|e| format!("Failed to serialize marker: {}", e))?;

        let provenance = SkillWorkshopProvenance {
            source_kind: "agent_workshop".to_string(),
            source_detail: proposal_id.to_string(),
            package_sha256: package_sha256.to_string(),
            risk_level: risk_level.to_string(),
            installed_at: marker.installed_at.clone(),
            session_id: ctx.session_id.clone(),
            package_version,
            files: files.to_vec(),
            previous_package_sha256: previous_package_sha256.map(str::to_string),
        };
        let provenance_text = serde_json::to_string_pretty(&provenance)
            .map_err(|e| format!("Failed to serialize provenance: {}", e))?;

        Ok((marker_text, provenance_text))
    }

    fn persist_provenance(
        ctx: &ExecutionContext,
        skill_id: &str,
        provenance_text: &str,
    ) -> Result<Option<Option<String>>, String> {
        if let Some(db) = ctx.main_db.as_ref() {
            let key = format!("{}{}", PROVENANCE_SETTINGS_PREFIX, skill_id);
            let previous = db
                .get_setting(&key)
                .map_err(|e| format!("Failed to read previous skill provenance: {}", e))?;
            db.save_setting(&key, provenance_text)
                .map_err(|e| format!("Failed to persist skill provenance: {}", e))?;
            Ok(Some(previous))
        } else {
            log::warn!(
                "[SkillWorkshopExecutor] main_db unavailable; provenance for '{}' written only to marker file",
                skill_id
            );
            Ok(None)
        }
    }

    fn restore_provenance(
        ctx: &ExecutionContext,
        skill_id: &str,
        previous: Option<Option<String>>,
    ) -> Result<(), String> {
        let Some(previous) = previous else {
            return Ok(());
        };
        let db = ctx
            .main_db
            .as_ref()
            .ok_or("main_db disappeared while restoring provenance")?;
        let key = format!("{}{}", PROVENANCE_SETTINGS_PREFIX, skill_id);
        match previous {
            Some(value) => db
                .save_setting(&key, &value)
                .map_err(|e| format!("Failed to restore previous skill provenance: {}", e)),
            None => db
                .delete_setting(&key)
                .map(|_| ())
                .map_err(|e| format!("Failed to remove newly written skill provenance: {}", e)),
        }
    }

    async fn execute_apply(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let proposal_id = args
            .get("proposal_id")
            .or_else(|| args.get("proposalId"))
            .and_then(|v| v.as_str())
            .ok_or("proposal_id is required")?;
        Self::validate_proposal_id(proposal_id)?;

        let expected_content_sha256 = args
            .get("expected_content_sha256")
            .or_else(|| args.get("expectedContentSha256"))
            .and_then(|value| value.as_str())
            .ok_or("expected_content_sha256 is required from the reviewed proposal result")?;
        let expected_content_sha256 =
            Self::normalize_sha256(expected_content_sha256, "expected_content_sha256")?;
        let expected_proposal_revision = args
            .get("expected_proposal_revision")
            .or_else(|| args.get("expectedProposalRevision"))
            .and_then(|value| value.as_str())
            .ok_or("expected_proposal_revision is required from the reviewed proposal result")?;
        let expected_proposal_revision =
            Self::normalize_sha256(expected_proposal_revision, "expected_proposal_revision")?;
        let expected_skill_id = args
            .get("skill_id")
            .or_else(|| args.get("skillId"))
            .and_then(|value| value.as_str())
            .ok_or("skill_id is required from the reviewed proposal result")?;
        Self::validate_skill_id(expected_skill_id)?;

        let overwrite = args
            .get("overwrite")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let proposals_root = Self::proposals_root(ctx)?;
        let dir = Self::proposal_dir(&proposals_root, proposal_id);
        if !dir.exists() {
            return Err(format!("Proposal '{}' not found", proposal_id));
        }

        let meta = Self::read_proposal_meta(&dir)?;
        if meta.status != "pending" {
            return Err(format!(
                "Proposal '{}' status is '{}' (only pending proposals can be applied)",
                proposal_id, meta.status
            ));
        }
        if meta.skill_id != expected_skill_id {
            return Err(format!(
                "Proposal target changed after approval scope was created: expected skill_id '{}', got '{}'. Review the proposal again before applying.",
                expected_skill_id, meta.skill_id
            ));
        }

        let proposal_files = Self::read_proposal_package(&dir, &meta)?;
        let actual_sha256 = Self::verify_approved_proposal(
            &meta,
            &proposal_files,
            &expected_content_sha256,
            &expected_proposal_revision,
        )?;
        let package_sha256 = Self::package_sha256(&proposal_files);
        let file_manifest = Self::package_file_meta(&proposal_files);
        let (risk_level, risk_signals) = Self::assess_package_risk(&proposal_files);

        let target = Self::skill_target_path(&meta.skill_id)?;
        let skill_dir = target
            .parent()
            .ok_or("Invalid skill target path")?
            .to_path_buf();

        if meta.action == "propose_update" {
            let previous = meta
                .previous_sha256
                .as_deref()
                .ok_or("propose_update proposal missing previous_sha256 in meta")?;
            if !target.exists() {
                return Err(format!(
                    "Target skill '{}' no longer exists. Create a new proposal.",
                    meta.skill_id
                ));
            }
            let current_bytes =
                fs::read(&target).map_err(|e| format!("Failed to read target SKILL.md: {}", e))?;
            let current_sha256 = Self::sha256_hex(&current_bytes);
            if current_sha256 != previous {
                return Err(format!(
                    "Target SKILL.md changed since proposal (TOCTOU): expected previous_sha256 {}, got {}. The live skill was modified — call propose_update again with the current content.",
                    previous, current_sha256
                ));
            }
            let current_package = Self::read_package_directory(&skill_dir)?;
            let current_package_sha256 = Self::package_sha256(&current_package);
            let expected_previous_package =
                meta.previous_package_sha256.as_deref().unwrap_or(previous);
            if current_package_sha256 != expected_previous_package {
                return Err(format!(
                    "Target skill package changed since proposal (TOCTOU): expected {}, got {}. Create a new proposal from the current package.",
                    expected_previous_package, current_package_sha256
                ));
            }
        } else if meta.action == "propose_create" {
            if skill_dir.exists() && !overwrite {
                return Err(format!(
                    "Skill directory already exists at {}. Pass overwrite=true to replace, or choose a different skill_id.",
                    Self::relative_skill_display(&meta.skill_id)
                ));
            }
        } else {
            return Err(format!("Unsupported proposal action '{}'", meta.action));
        }

        let commit_overwrite = meta.action == "propose_update" || overwrite;
        let (marker_text, provenance_text) = Self::provenance_payloads(
            ctx,
            proposal_id,
            &actual_sha256,
            &package_sha256,
            meta.package_version,
            &file_manifest,
            meta.previous_package_sha256.as_deref(),
            &risk_level,
        )?;
        // Legacy content-only updates preserve existing package resources. Full package
        // proposals replace the entire package so removed files cannot survive an update.
        let preserve_existing = skill_dir.exists() && meta.files.is_empty();
        let staged_files = proposal_files.clone();
        let staged = tokio::task::spawn_blocking(move || {
            let staged = StagedSkillDirectory::new(skill_dir, commit_overwrite, preserve_existing)?;
            for (relative, bytes) in staged_files {
                staged.write_file(&relative, &bytes)?;
            }
            staged.write_file(AGENT_INSTALLED_MARKER, marker_text.as_bytes())?;
            Ok::<StagedSkillDirectory, String>(staged)
        })
        .await
        .map_err(|error| format!("Skill workshop staging task failed: {}", error))??;

        // Re-check update proposals while holding the shared skill commit lock, then
        // publish SKILL.md and the untrusted marker as one staged directory swap.
        let committed = if meta.action == "propose_update" && !meta.previous_files.is_empty() {
            let expected: Vec<_> = meta
                .previous_files
                .iter()
                .map(|file| (file.path.clone(), file.sha256.clone()))
                .collect();
            staged.commit_if_manifest_unchanged(&expected, &[AGENT_INSTALLED_MARKER])?
        } else if meta.action == "propose_update" {
            staged.commit_if_file_unchanged(
                SKILL_FILE_NAME,
                meta.previous_sha256
                    .as_deref()
                    .ok_or("propose_update proposal missing previous_sha256 in meta")?,
            )?
        } else {
            staged.commit()?
        };

        let previous_provenance = match Self::persist_provenance(
            ctx,
            &meta.skill_id,
            &provenance_text,
        ) {
            Ok(previous) => previous,
            Err(provenance_error) => {
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
        };

        let mut applied_meta = meta.clone();
        applied_meta.status = "applied".to_string();
        if let Err(meta_error) = Self::write_proposal_meta(&dir, &applied_meta) {
            let provenance_restore =
                Self::restore_provenance(ctx, &meta.skill_id, previous_provenance);
            let skill_rollback = committed.rollback();
            return match (provenance_restore, skill_rollback) {
                (Ok(()), Ok(())) => Err(format!(
                    "Failed to mark proposal as applied ({}); provenance and the live skill were restored.",
                    meta_error
                )),
                (restore, rollback) => Err(format!(
                    "Failed to mark proposal as applied ({}); rollback was incomplete (provenance={:?}, skill={:?}).",
                    meta_error, restore.err(), rollback.err()
                )),
            };
        }
        committed.finalize();

        Ok(json!({
            "applied": true,
            "proposal_id": proposal_id,
            "action": applied_meta.action,
            "skill_id": applied_meta.skill_id,
            "path": Self::relative_skill_display(&applied_meta.skill_id),
            "content_sha256": actual_sha256,
            "package_sha256": package_sha256,
            "package_version": applied_meta.package_version,
            "previous_package_sha256": applied_meta.previous_package_sha256,
            "files": file_manifest,
            "risk_level": risk_level,
            "risk_signals": risk_signals,
            "trust_status": "untrusted",
            "message": APPLY_SUCCESS_MESSAGE,
            "next_step": POST_WRITE_TRUST_NEXT_STEP,
        }))
    }
}

#[async_trait]
impl ToolExecutor for SkillWorkshopExecutor {
    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let short = Self::strip_namespace(&call.name);

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match short {
            tool_names::SKILL_WORKSHOP_PROPOSE => self.execute_propose(&call.arguments, ctx).await,
            tool_names::SKILL_WORKSHOP_APPLY => self.execute_apply(&call.arguments, ctx).await,
            other => Err(format!("Unsupported skill workshop tool: {}", other)),
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
                    log::warn!("[SkillWorkshopExecutor] Failed to save tool block: {}", e);
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
                    log::warn!("[SkillWorkshopExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            Self::strip_namespace(tool_name),
            tool_names::SKILL_WORKSHOP_PROPOSE | tool_names::SKILL_WORKSHOP_APPLY
        )
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        if Self::strip_namespace(tool_name) == tool_names::SKILL_WORKSHOP_APPLY {
            ToolSensitivity::High
        } else {
            ToolSensitivity::Medium
        }
    }

    fn name(&self) -> &'static str {
        "SkillWorkshopExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_skill_id_rejects_invalid_chars() {
        assert!(SkillWorkshopExecutor::validate_skill_id("good-skill_1").is_ok());
        assert!(SkillWorkshopExecutor::validate_skill_id("../evil").is_err());
        assert!(SkillWorkshopExecutor::validate_skill_id("CON").is_err());
        assert!(SkillWorkshopExecutor::validate_skill_id("LPT1").is_err());
        assert!(SkillWorkshopExecutor::validate_skill_id("").is_err());
    }

    #[test]
    fn validate_content_requires_frontmatter_and_size() {
        let ok = "---\nname: test\n---\n# Body";
        assert!(SkillWorkshopExecutor::validate_content(ok).is_ok());
        assert!(SkillWorkshopExecutor::validate_content("# no frontmatter").is_err());
        assert!(SkillWorkshopExecutor::validate_content("---\nname: missing-close").is_err());
        assert!(SkillWorkshopExecutor::validate_content("----\nname: invalid\n---").is_err());
        let huge = format!("---\n{}", "x".repeat(MAX_CONTENT_BYTES));
        assert!(SkillWorkshopExecutor::validate_content(&huge).is_err());
    }

    #[test]
    fn validate_proposal_id_rejects_path_injection() {
        assert!(SkillWorkshopExecutor::validate_proposal_id("wp_1234567890_abcd").is_ok());
        assert!(SkillWorkshopExecutor::validate_proposal_id("../etc/passwd").is_err());
        assert!(SkillWorkshopExecutor::validate_proposal_id("wp_../../x").is_err());
    }

    #[test]
    fn generate_proposal_id_matches_expected_pattern() {
        let id = SkillWorkshopExecutor::generate_proposal_id();
        assert!(id.starts_with("wp_"));
        let parts: Vec<&str> = id.splitn(3, '_').collect();
        assert_eq!(parts.len(), 3);
        assert!(parts[1].chars().all(|c| c.is_ascii_digit()));
        assert_eq!(parts[2].len(), 4);
    }

    #[test]
    fn sha256_hex_is_deterministic() {
        let a = SkillWorkshopExecutor::sha256_hex(b"hello");
        let b = SkillWorkshopExecutor::sha256_hex(b"hello");
        assert_eq!(a, b);
        assert_eq!(a.len(), 64);
    }

    #[test]
    fn approved_proposal_hash_and_revision_reject_post_approval_tampering() {
        let reviewed_content = b"---\nname: reviewed\n---\nbody";
        let reviewed_files = vec![(SKILL_FILE_NAME.to_string(), reviewed_content.to_vec())];
        let reviewed_hash = SkillWorkshopExecutor::sha256_hex(reviewed_content);
        let meta = ProposalMeta {
            proposal_id: "wp_1234567890_abcd".to_string(),
            action: "propose_create".to_string(),
            skill_id: "reviewed-skill".to_string(),
            content_sha256: reviewed_hash.clone(),
            created_at: "2026-07-11T00:00:00Z".to_string(),
            session_id: "sess_review".to_string(),
            status: "pending".to_string(),
            previous_sha256: None,
            package_sha256: None,
            files: Vec::new(),
            previous_package_sha256: None,
            previous_files: Vec::new(),
            package_version: 1,
        };
        let reviewed_revision = SkillWorkshopExecutor::proposal_revision_sha256(&meta);
        assert!(SkillWorkshopExecutor::verify_approved_proposal(
            &meta,
            &reviewed_files,
            &reviewed_hash,
            &reviewed_revision,
        )
        .is_ok());

        let changed_body = b"---\nname: reviewed\n---\nmalicious replacement";
        let changed_files = vec![(SKILL_FILE_NAME.to_string(), changed_body.to_vec())];
        let body_error = SkillWorkshopExecutor::verify_approved_proposal(
            &meta,
            &changed_files,
            &reviewed_hash,
            &reviewed_revision,
        )
        .expect_err("SKILL.md changed after approval must fail");
        assert!(body_error.contains("SKILL.md changed after approval"));

        let mut replaced_proposal = meta.clone();
        replaced_proposal.content_sha256 = SkillWorkshopExecutor::sha256_hex(changed_body);
        let replacement_error = SkillWorkshopExecutor::verify_approved_proposal(
            &replaced_proposal,
            &changed_files,
            &reviewed_hash,
            &reviewed_revision,
        )
        .expect_err("updating both proposal metadata and content must not refresh approval");
        assert!(replacement_error.contains("Proposal changed after approval"));

        let mut retargeted = meta.clone();
        retargeted.skill_id = "different-target".to_string();
        let retarget_error = SkillWorkshopExecutor::verify_approved_proposal(
            &retargeted,
            &reviewed_files,
            &reviewed_hash,
            &reviewed_revision,
        )
        .expect_err("retargeting an approved proposal must fail");
        assert!(retarget_error.contains("Proposal changed after approval"));
    }

    #[test]
    fn approval_hash_fields_require_full_sha256() {
        assert!(SkillWorkshopExecutor::normalize_sha256("abc", "expected").is_err());
        assert!(SkillWorkshopExecutor::normalize_sha256(
            "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF",
            "expected",
        )
        .is_ok());
    }

    #[test]
    fn workshop_content_uses_the_package_risk_model() {
        let content =
            b"---\nallowed-tools:\n  - local_shell\n  - fetch\n---\nRun curl with an api_key";
        let (risk_level, signals) = SkillWorkshopExecutor::assess_package_risk(&[(
            SKILL_FILE_NAME.to_string(),
            content.to_vec(),
        )]);
        assert_eq!(risk_level, "high");
        assert!(signals.contains(&"shell_tools".to_string()));
        assert!(signals.contains(&"network_tools".to_string()));
        assert!(signals.contains(&"credential_keywords".to_string()));
    }

    /// P1 回归：提案目录不存在时也能写入（先 create_dir_all 再写 SKILL.md）
    #[test]
    fn write_proposal_files_creates_missing_directories() {
        let root = std::env::temp_dir().join(format!(
            "ds_workshop_test_{}_{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        // 模拟真实场景：proposals_root 与 proposal_dir 都尚不存在
        let dir = root.join("wp_1234567890_abcd");
        assert!(!dir.exists());

        let meta = ProposalMeta {
            proposal_id: "wp_1234567890_abcd".to_string(),
            action: "propose_create".to_string(),
            skill_id: "test-skill".to_string(),
            content_sha256: SkillWorkshopExecutor::sha256_hex(b"---\nname: t\n---\nbody"),
            created_at: Utc::now().to_rfc3339(),
            session_id: "sess_test".to_string(),
            status: "pending".to_string(),
            previous_sha256: None,
            package_sha256: None,
            files: Vec::new(),
            previous_package_sha256: None,
            previous_files: Vec::new(),
            package_version: 1,
        };

        let files = vec![(
            SKILL_FILE_NAME.to_string(),
            b"---\nname: t\n---\nbody".to_vec(),
        )];
        let result = SkillWorkshopExecutor::write_proposal_files(&dir, &files, &meta);
        assert!(result.is_ok(), "write_proposal_files failed: {:?}", result);
        assert!(dir.join(SKILL_FILE_NAME).exists());
        assert!(dir.join(PROPOSAL_META_FILE).exists());

        let read_back = SkillWorkshopExecutor::read_proposal_meta(&dir).expect("read meta back");
        assert_eq!(read_back.proposal_id, "wp_1234567890_abcd");
        assert_eq!(read_back.status, "pending");

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn package_validation_accepts_resources_and_rejects_path_attacks() {
        let valid = vec![
            (
                SKILL_FILE_NAME.to_string(),
                b"---\nname: t\n---\nbody".to_vec(),
            ),
            ("scripts/run.sh".to_string(), b"echo ok".to_vec()),
            ("references/guide.md".to_string(), b"guide".to_vec()),
            ("assets/icon.bin".to_string(), vec![0, 1, 2]),
            ("agents/openai.yaml".to_string(), b"interface: {}".to_vec()),
            ("templates/report.md".to_string(), b"template".to_vec()),
            ("examples/sample.md".to_string(), b"example".to_vec()),
            ("README.md".to_string(), b"readme".to_vec()),
            ("README.en.md".to_string(), b"english readme".to_vec()),
            ("LICENSE.txt".to_string(), b"license".to_vec()),
            ("_meta.json".to_string(), b"{}".to_vec()),
            ("skill-card.md".to_string(), b"card".to_vec()),
        ];
        assert!(SkillWorkshopExecutor::validate_package_files(valid).is_ok());
        for path in [
            "/tmp/x",
            "../x",
            "scripts/../x",
            "other/file.txt",
            "scripts\\x",
        ] {
            let files = vec![
                (
                    SKILL_FILE_NAME.to_string(),
                    b"---\nname: t\n---\nbody".to_vec(),
                ),
                (path.to_string(), b"x".to_vec()),
            ];
            assert!(
                SkillWorkshopExecutor::validate_package_files(files).is_err(),
                "accepted {path}"
            );
        }
    }

    #[test]
    fn package_validation_rejects_case_folded_duplicates() {
        let files = vec![
            (
                SKILL_FILE_NAME.to_string(),
                b"---\nname: t\n---\nbody".to_vec(),
            ),
            ("scripts/Run.sh".to_string(), b"one".to_vec()),
            ("scripts/run.sh".to_string(), b"two".to_vec()),
        ];
        assert!(SkillWorkshopExecutor::validate_package_files(files).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn proposal_reader_rejects_symlink_substitution() {
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("ds_workshop_symlink_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("scripts")).unwrap();
        fs::write(root.join(SKILL_FILE_NAME), "---\nname: t\n---\nbody").unwrap();
        symlink(root.join(SKILL_FILE_NAME), root.join("scripts/run.sh")).unwrap();
        let skill = fs::read(root.join(SKILL_FILE_NAME)).unwrap();
        let meta = ProposalMeta {
            proposal_id: "wp_1234567890_abcd".to_string(),
            action: "propose_create".to_string(),
            skill_id: "test-skill".to_string(),
            content_sha256: SkillWorkshopExecutor::sha256_hex(&skill),
            created_at: Utc::now().to_rfc3339(),
            session_id: "sess_test".to_string(),
            status: "pending".to_string(),
            previous_sha256: None,
            package_sha256: None,
            files: vec![
                ProposalFileMeta {
                    path: SKILL_FILE_NAME.to_string(),
                    sha256: SkillWorkshopExecutor::sha256_hex(&skill),
                    size: skill.len(),
                },
                ProposalFileMeta {
                    path: "scripts/run.sh".to_string(),
                    sha256: "0".repeat(64),
                    size: 1,
                },
            ],
            previous_package_sha256: None,
            previous_files: Vec::new(),
            package_version: 1,
        };
        assert!(SkillWorkshopExecutor::read_proposal_package(&root, &meta).is_err());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn apply_success_narrative_routes_through_skill_trust_request() {
        assert!(APPLY_SUCCESS_MESSAGE.contains("skill_trust_request"));
        assert!(APPLY_SUCCESS_MESSAGE.contains("Do not load_skills until trust is granted"));
        assert!(APPLY_SUCCESS_MESSAGE.contains("Skills management is only a backup"));
        assert!(!APPLY_SUCCESS_MESSAGE.contains("user must trust it in Skills management"));
        assert!(!APPLY_SUCCESS_MESSAGE.contains("On the next turn you may load_skills"));

        assert!(POST_WRITE_TRUST_NEXT_STEP.contains("action=inspect"));
        assert!(POST_WRITE_TRUST_NEXT_STEP.contains("action=grant"));
        assert!(POST_WRITE_TRUST_NEXT_STEP.contains("Skills management UI is only a backup"));
    }
}
