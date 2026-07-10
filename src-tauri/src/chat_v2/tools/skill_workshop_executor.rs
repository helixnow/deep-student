//! Agent 技能 workshop 提案工具执行器
//!
//! - `skill_workshop_propose`（Medium）：提案创建/更新/列表/拒绝，写入 pending 区
//! - `skill_workshop_apply`（High，必审批）：校验提案完整性后写入活体技能目录 + provenance

use std::fs;
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
    expand_path, validate_skill_path, DEFAULT_AGENT_SKILLS_BASE,
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
        {
            return Err(
                "skill_id can only contain letters, numbers, hyphens, and underscores".to_string(),
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
        if !trimmed_start.starts_with("---") {
            return Err(
                "content must begin with YAML frontmatter (---); include a valid SKILL.md header"
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
        fs::write(dir.join(PROPOSAL_META_FILE), json_text)
            .map_err(|e| format!("Failed to write {}: {}", PROPOSAL_META_FILE, e))
    }

    /// 写入提案目录（SKILL.md + PROPOSAL.json）。
    ///
    /// P1 修复：提案目录是全新目录，必须先 `create_dir_all` 再写 SKILL.md，
    /// 否则 `fs::write` 对不存在的目录直接返回 NotFound，propose_create/propose_update 必失败。
    fn write_proposal_files(dir: &Path, content: &str, meta: &ProposalMeta) -> Result<(), String> {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create proposal directory: {}", e))?;
        fs::write(dir.join(SKILL_FILE_NAME), content)
            .map_err(|e| format!("Failed to write proposal SKILL.md: {}", e))?;
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
        format!("{}/{}/{}", DEFAULT_AGENT_SKILLS_BASE, skill_id, SKILL_FILE_NAME)
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

        Self::write_proposal_files(&dir, content, &meta)?;

        Ok(json!({
            "proposal_id": proposal_id,
            "action": "propose_create",
            "skill_id": skill_id,
            "content_sha256": content_sha256,
            "content_length": content.len(),
            "status": "pending",
            "next_step": "After user reviews the proposal, call skill_workshop_apply with proposal_id. Apply requires user approval and cannot be remembered.",
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

        let existing_bytes = fs::read(&target)
            .map_err(|e| format!("Failed to read existing SKILL.md: {}", e))?;
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

        Self::write_proposal_files(&dir, content, &meta)?;

        Ok(json!({
            "proposal_id": proposal_id,
            "action": "propose_update",
            "skill_id": skill_id,
            "content_sha256": content_sha256,
            "previous_sha256": meta.previous_sha256,
            "content_length": content.len(),
            "status": "pending",
            "next_step": "After user reviews the diff, call skill_workshop_apply with proposal_id. Apply requires user approval and cannot be remembered.",
        }))
    }

    fn execute_list(proposals_root: &Path) -> Result<Value, String> {
        if !proposals_root.exists() {
            return Ok(json!({ "pending": [], "count": 0 }));
        }

        let mut pending = Vec::new();
        for entry in fs::read_dir(proposals_root)
            .map_err(|e| format!("Failed to list proposals: {}", e))?
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
            pending.push(json!({
                "proposal_id": meta.proposal_id,
                "action": meta.action,
                "skill_id": meta.skill_id,
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

    fn write_provenance_and_marker(
        ctx: &ExecutionContext,
        skill_id: &str,
        skill_dir: &Path,
        proposal_id: &str,
        content_sha256: &str,
    ) -> Result<(), String> {
        let marker = AgentWorkshopMarker {
            source_kind: "agent_workshop".to_string(),
            proposal_id: proposal_id.to_string(),
            content_sha256: content_sha256.to_string(),
            installed_at: Utc::now().to_rfc3339(),
            session_id: ctx.session_id.clone(),
        };
        let marker_text = serde_json::to_string_pretty(&marker)
            .map_err(|e| format!("Failed to serialize marker: {}", e))?;

        fs::write(skill_dir.join(AGENT_INSTALLED_MARKER), &marker_text).map_err(|e| {
            format!(
                "Failed to write {} marker: {}",
                AGENT_INSTALLED_MARKER, e
            )
        })?;

        let provenance = SkillWorkshopProvenance {
            source_kind: "agent_workshop".to_string(),
            source_detail: proposal_id.to_string(),
            package_sha256: content_sha256.to_string(),
            risk_level: "low".to_string(),
            installed_at: marker.installed_at.clone(),
            session_id: ctx.session_id.clone(),
        };
        let provenance_text = serde_json::to_string_pretty(&provenance)
            .map_err(|e| format!("Failed to serialize provenance: {}", e))?;

        if let Some(db) = ctx.main_db.as_ref() {
            let key = format!("{}{}", PROVENANCE_SETTINGS_PREFIX, skill_id);
            db.save_setting(&key, &provenance_text)
                .map_err(|e| format!("Failed to persist skill provenance: {}", e))?;
        } else {
            log::warn!(
                "[SkillWorkshopExecutor] main_db unavailable; provenance for '{}' written only to marker file",
                skill_id
            );
        }
        Ok(())
    }

    async fn execute_apply(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let proposal_id = args
            .get("proposal_id")
            .or_else(|| args.get("proposalId"))
            .and_then(|v| v.as_str())
            .ok_or("proposal_id is required")?;
        Self::validate_proposal_id(proposal_id)?;

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

        let proposal_content_path = dir.join(SKILL_FILE_NAME);
        let proposal_bytes = fs::read(&proposal_content_path)
            .map_err(|e| format!("Failed to read proposal SKILL.md: {}", e))?;
        let actual_sha256 = Self::sha256_hex(&proposal_bytes);
        if actual_sha256 != meta.content_sha256 {
            return Err(format!(
                "Proposal content SHA-256 mismatch: expected {}, got {}. The proposal files may have been tampered with — create a new proposal.",
                meta.content_sha256, actual_sha256
            ));
        }

        let target = Self::skill_target_path(&meta.skill_id)?;
        let skill_dir = target
            .parent()
            .ok_or("Invalid skill target path")?;

        if meta.action == "propose_update" {
            let previous = meta.previous_sha256.as_deref().ok_or(
                "propose_update proposal missing previous_sha256 in meta",
            )?;
            if !target.exists() {
                return Err(format!(
                    "Target skill '{}' no longer exists. Create a new proposal.",
                    meta.skill_id
                ));
            }
            let current_bytes = fs::read(&target)
                .map_err(|e| format!("Failed to read target SKILL.md: {}", e))?;
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

        let content = String::from_utf8(proposal_bytes)
            .map_err(|e| format!("Proposal SKILL.md is not valid UTF-8: {}", e))?;

        let created_dir = !skill_dir.exists();
        if created_dir {
            fs::create_dir_all(skill_dir)
                .map_err(|e| format!("Failed to create skill directory: {}", e))?;
        }

        // P1 修复（fail-closed）：先写 AGENT_INSTALLED.json marker，再写 SKILL.md 内容。
        // 前端信任判定以"marker 缺失即 trusted"为默认，若先写内容后写 marker、
        // 且 marker 写入失败，agent 产出的技能会被误判为受信任（违反 ADR-B3）。
        // 反过来的顺序下：marker 失败则活体内容未被改动；内容写入失败则技能带 marker
        // （untrusted）——两个失败方向都安全。
        if let Err(marker_err) = Self::write_provenance_and_marker(
            ctx,
            &meta.skill_id,
            skill_dir,
            proposal_id,
            &actual_sha256,
        ) {
            if created_dir {
                let _ = fs::remove_dir_all(skill_dir);
            }
            return Err(format!(
                "Failed to record agent provenance ({}); the live skill was not modified.",
                marker_err
            ));
        }

        if let Err(write_err) = fs::write(&target, &content) {
            if created_dir {
                let _ = fs::remove_dir_all(skill_dir);
            }
            return Err(format!("Failed to write SKILL.md: {}", write_err));
        }

        let mut applied_meta = meta.clone();
        applied_meta.status = "applied".to_string();
        Self::write_proposal_meta(&dir, &applied_meta)?;

        Ok(json!({
            "applied": true,
            "proposal_id": proposal_id,
            "action": applied_meta.action,
            "skill_id": applied_meta.skill_id,
            "path": Self::relative_skill_display(&applied_meta.skill_id),
            "content_sha256": actual_sha256,
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
            tool_names::SKILL_WORKSHOP_PROPOSE => {
                self.execute_propose(&call.arguments, ctx).await
            }
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
        assert!(SkillWorkshopExecutor::validate_skill_id("").is_err());
    }

    #[test]
    fn validate_content_requires_frontmatter_and_size() {
        let ok = "---\nname: test\n---\n# Body";
        assert!(SkillWorkshopExecutor::validate_content(ok).is_ok());
        assert!(SkillWorkshopExecutor::validate_content("# no frontmatter").is_err());
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
