//! Agent 技能 workshop 提案工具执行器
//!
//! - `skill_workshop_propose`（Medium）：提案创建/更新/列表/拒绝，写入 pending 区
//! - `skill_workshop_apply`（High，必审批）：校验提案完整性后写入活体技能目录 + provenance

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Instant;

use async_trait::async_trait;
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::Manager;

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::skill_install_executor::AGENT_INSTALLED_MARKER;
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
const MAX_CONTENT_BYTES: usize = 40_000;
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
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentWorkshopMarker {
    source_kind: String,
    proposal_id: String,
    content_sha256: String,
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
}

pub struct SkillWorkshopExecutor;

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
        ] {
            hasher.update((field.len() as u64).to_le_bytes());
            hasher.update(field.as_bytes());
        }
        hex::encode(hasher.finalize())
    }

    fn assess_content_risk(content: &[u8]) -> (String, Vec<String>) {
        assess_skill_package_risk(&[(SKILL_FILE_NAME.to_string(), content.to_vec())])
    }

    fn verify_approved_proposal(
        meta: &ProposalMeta,
        proposal_bytes: &[u8],
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
        let actual_sha256 = Self::sha256_hex(proposal_bytes);
        if actual_sha256 != expected_content_sha256 {
            return Err(format!(
                "Proposal SKILL.md changed after approval scope was created: expected {}, got {}. Review the proposal again before applying.",
                expected_content_sha256, actual_sha256
            ));
        }
        Ok(actual_sha256)
    }

    fn proposals_root(ctx: &ExecutionContext) -> Result<PathBuf, String> {
        let app_data = ctx
            .window
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
    fn write_proposal_files(dir: &Path, content: &str, meta: &ProposalMeta) -> Result<(), String> {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create proposal directory: {}", e))?;
        let skill_path = dir.join(SKILL_FILE_NAME);
        let mut skill_file = fs::File::create(&skill_path)
            .map_err(|e| format!("Failed to create proposal SKILL.md: {}", e))?;
        skill_file
            .write_all(content.as_bytes())
            .map_err(|e| format!("Failed to write proposal SKILL.md: {}", e))?;
        skill_file
            .sync_all()
            .map_err(|e| format!("Failed to fsync proposal SKILL.md: {}", e))?;
        Self::write_proposal_meta(dir, meta)
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
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("content is required (full SKILL.md text with frontmatter)")?;

        Self::validate_skill_id(skill_id)?;
        Self::validate_content(content)?;

        if Self::count_pending_proposals(proposals_root)? >= MAX_PENDING_PROPOSALS {
            return Err(format!(
                "Too many pending proposals (max {}). Reject or apply existing proposals first.",
                MAX_PENDING_PROPOSALS
            ));
        }

        let proposal_id = Self::generate_proposal_id();
        let content_sha256 = Self::sha256_hex(content.as_bytes());
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
        };
        let proposal_revision = Self::proposal_revision_sha256(&meta);
        let (risk_level, risk_signals) = Self::assess_content_risk(content.as_bytes());

        Self::write_proposal_files(&dir, content, &meta)?;

        Ok(json!({
            "proposal_id": proposal_id,
            "action": "propose_create",
            "skill_id": skill_id,
            "content_sha256": content_sha256,
            "proposal_revision": proposal_revision,
            "content_length": content.len(),
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
        let content = args
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("content is required (full SKILL.md text with frontmatter)")?;

        Self::validate_skill_id(skill_id)?;
        Self::validate_content(content)?;

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

        if Self::count_pending_proposals(proposals_root)? >= MAX_PENDING_PROPOSALS {
            return Err(format!(
                "Too many pending proposals (max {}). Reject or apply existing proposals first.",
                MAX_PENDING_PROPOSALS
            ));
        }

        let proposal_id = Self::generate_proposal_id();
        let content_sha256 = Self::sha256_hex(content.as_bytes());
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
        };
        let proposal_revision = Self::proposal_revision_sha256(&meta);
        let (risk_level, risk_signals) = Self::assess_content_risk(content.as_bytes());

        Self::write_proposal_files(&dir, content, &meta)?;

        Ok(json!({
            "proposal_id": proposal_id,
            "action": "propose_update",
            "skill_id": skill_id,
            "content_sha256": content_sha256,
            "proposal_revision": proposal_revision,
            "previous_sha256": meta.previous_sha256,
            "content_length": content.len(),
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
        risk_level: &str,
    ) -> Result<(String, String), String> {
        let marker = AgentWorkshopMarker {
            source_kind: "agent_workshop".to_string(),
            proposal_id: proposal_id.to_string(),
            content_sha256: content_sha256.to_string(),
            installed_at: Utc::now().to_rfc3339(),
            session_id: ctx.session_id.clone(),
        };
        let marker_text = serde_json::to_string_pretty(&marker)
            .map_err(|e| format!("Failed to serialize marker: {}", e))?;

        let provenance = SkillWorkshopProvenance {
            source_kind: "agent_workshop".to_string(),
            source_detail: proposal_id.to_string(),
            package_sha256: content_sha256.to_string(),
            risk_level: risk_level.to_string(),
            installed_at: marker.installed_at.clone(),
            session_id: ctx.session_id.clone(),
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

        let proposal_content_path = dir.join(SKILL_FILE_NAME);
        let proposal_bytes = fs::read(&proposal_content_path)
            .map_err(|e| format!("Failed to read proposal SKILL.md: {}", e))?;
        let actual_sha256 = Self::verify_approved_proposal(
            &meta,
            &proposal_bytes,
            &expected_content_sha256,
            &expected_proposal_revision,
        )?;
        let (risk_level, risk_signals) = Self::assess_content_risk(&proposal_bytes);

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

        std::str::from_utf8(&proposal_bytes)
            .map_err(|e| format!("Proposal SKILL.md is not valid UTF-8: {}", e))?;

        let commit_overwrite = meta.action == "propose_update" || overwrite;
        let (marker_text, provenance_text) =
            Self::provenance_payloads(ctx, proposal_id, &actual_sha256, &risk_level)?;
        let preserve_existing = skill_dir.exists();
        let staged = tokio::task::spawn_blocking(move || {
            let staged = StagedSkillDirectory::new(skill_dir, commit_overwrite, preserve_existing)?;
            staged.write_file(SKILL_FILE_NAME, &proposal_bytes)?;
            staged.write_file(AGENT_INSTALLED_MARKER, marker_text.as_bytes())?;
            Ok::<StagedSkillDirectory, String>(staged)
        })
        .await
        .map_err(|error| format!("Skill workshop staging task failed: {}", error))??;

        // Re-check update proposals while holding the shared skill commit lock, then
        // publish SKILL.md and the untrusted marker as one staged directory swap.
        let committed = if meta.action == "propose_update" {
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
            "risk_level": risk_level,
            "risk_signals": risk_signals,
            "trust_status": "untrusted",
            "message": "Skill written to ~/.deep-student/skills. It is untrusted by default — the user must trust it in Skills management before package scripts can run via SKILL_DIR. On the next turn you may load_skills to use the skill body.",
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
        };
        let reviewed_revision = SkillWorkshopExecutor::proposal_revision_sha256(&meta);
        assert!(SkillWorkshopExecutor::verify_approved_proposal(
            &meta,
            reviewed_content,
            &reviewed_hash,
            &reviewed_revision,
        )
        .is_ok());

        let changed_body = b"---\nname: reviewed\n---\nmalicious replacement";
        let body_error = SkillWorkshopExecutor::verify_approved_proposal(
            &meta,
            changed_body,
            &reviewed_hash,
            &reviewed_revision,
        )
        .expect_err("SKILL.md changed after approval must fail");
        assert!(body_error.contains("SKILL.md changed after approval"));

        let mut replaced_proposal = meta.clone();
        replaced_proposal.content_sha256 = SkillWorkshopExecutor::sha256_hex(changed_body);
        let replacement_error = SkillWorkshopExecutor::verify_approved_proposal(
            &replaced_proposal,
            changed_body,
            &reviewed_hash,
            &reviewed_revision,
        )
        .expect_err("updating both proposal metadata and content must not refresh approval");
        assert!(replacement_error.contains("Proposal changed after approval"));

        let mut retargeted = meta.clone();
        retargeted.skill_id = "different-target".to_string();
        let retarget_error = SkillWorkshopExecutor::verify_approved_proposal(
            &retargeted,
            reviewed_content,
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
        let (risk_level, signals) = SkillWorkshopExecutor::assess_content_risk(content);
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
        };

        let result =
            SkillWorkshopExecutor::write_proposal_files(&dir, "---\nname: t\n---\nbody", &meta);
        assert!(result.is_ok(), "write_proposal_files failed: {:?}", result);
        assert!(dir.join(SKILL_FILE_NAME).exists());
        assert!(dir.join(PROPOSAL_META_FILE).exists());

        let read_back = SkillWorkshopExecutor::read_proposal_meta(&dir).expect("read meta back");
        assert_eq!(read_back.proposal_id, "wp_1234567890_abcd");
        assert_eq!(read_back.status, "pending");

        let _ = fs::remove_dir_all(&root);
    }
}
