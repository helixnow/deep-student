//! 自定义子代理 persona 管理工具执行器
//!
//! 让 agent 能通过对话管理 `{workspaces_dir}/agents/*.md` 下的自定义子代理
//! persona（契约 C6，见 workspace/custom_agents.rs），复刻 skill_workshop 的
//! 提案-审批两段式：
//!
//! - `custom_agent_list`（Low，只读）：列出全部 persona 文件（id、frontmatter
//!   摘要、字节数、修改时间）
//! - `custom_agent_get`（Low，只读）：读取指定 persona 全文
//! - `custom_agent_propose`（Medium）：起草新建/修改 persona，写入独立 pending
//!   提案区 `{workspaces_dir}/agents-pending/<proposal_id>/`（不与 skill 提案
//!   混用），返回 proposal id 与 diff 摘要；附带 list / reject 子动作
//! - `custom_agent_apply`（High，必审批，never-remember）：审批后原子落盘
//!   （临时文件 + rename），支持新建与覆盖；审批指纹绑定提案内容与 revision，
//!   审批后提案或目标文件变化一律 fail-closed 拒绝（TOCTOU）
//! - `custom_agent_remove`（High，必审批，never-remember）：删除指定 persona
//!
//! 安全边界：文件名只允许单层安全字符集（小写字母/数字/连字符 + `.md`），
//! 解析后必须直接落在 agents/（或 pending）目录内；目标为符号链接一律拒绝；
//! 单文件上限 64 KiB（与 custom_agents.rs 的 MAX_FILE_BYTES 对齐，超限文件
//! 加载器会跳过，写入侧提前拦截）。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use async_trait::async_trait;
use chrono::Utc;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::executor::{ExecutionContext, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::skills::is_portable_skill_path_component;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::chat_v2::workspace::{AgentProfileResolver, WorkspaceCoordinator};

pub mod tool_names {
    pub const CUSTOM_AGENT_LIST: &str = "custom_agent_list";
    pub const CUSTOM_AGENT_GET: &str = "custom_agent_get";
    pub const CUSTOM_AGENT_PROPOSE: &str = "custom_agent_propose";
    pub const CUSTOM_AGENT_APPLY: &str = "custom_agent_apply";
    pub const CUSTOM_AGENT_REMOVE: &str = "custom_agent_remove";
}

/// 与 custom_agents.rs 的 MAX_FILE_BYTES 对齐：超限文件加载器直接跳过，
/// 因此写入侧必须先行拦截，否则会落盘一个永远不生效的定义。
const MAX_PERSONA_BYTES: usize = 64 * 1024;
/// pending 提案数量上限（与 skill_workshop 一致的防滥用阈值）。
const MAX_PENDING_PROPOSALS: usize = 50;
/// 提案区内 persona 草稿文件名（提案目录下固定文件名）。
const PROPOSAL_PERSONA_FILE: &str = "persona.md";
/// 提案元数据文件名。
const PROPOSAL_META_FILE: &str = "PROPOSAL.json";
/// 文件名主干长度上限（防超长文件名滥用）。
const MAX_FILE_STEM_CHARS: usize = 64;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersonaProposalMeta {
    proposal_id: String,
    /// create | update
    action: String,
    /// 目标文件名（含 .md）
    file_name: String,
    /// frontmatter 中声明的 agent name
    agent_name: String,
    content_sha256: String,
    /// update 时记录目标文件当时的内容哈希（apply 时 TOCTOU 复核）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    previous_sha256: Option<String>,
    created_at: String,
    session_id: String,
    status: String,
}

pub struct CustomAgentExecutor {
    coordinator: Arc<WorkspaceCoordinator>,
}

impl CustomAgentExecutor {
    pub fn new(coordinator: Arc<WorkspaceCoordinator>) -> Self {
        Self { coordinator }
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

    fn agents_dir(&self) -> PathBuf {
        self.coordinator.custom_agents_dir()
    }

    fn pending_dir(&self) -> PathBuf {
        self.coordinator.custom_agents_pending_dir()
    }

    // ------------------------------------------------------------------
    // 文件名 / 路径安全
    // ------------------------------------------------------------------

    /// persona 文件名校验：单层组件、`<stem>.md`，stem 只允许小写字母/数字/
    /// 连字符（与 custom_agents.rs 的 name 字符集对齐），并通过可移植目录名
    /// 检查（Windows 保留名等）。任何路径分隔符/穿越都会被字符集直接排除。
    fn validate_file_name(raw: &str) -> Result<String, String> {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            return Err("file_name must not be empty".to_string());
        }
        let Some(stem) = trimmed.strip_suffix(".md") else {
            return Err(format!(
                "file_name '{}' must end with .md (e.g. paper-summarizer.md)",
                trimmed
            ));
        };
        if stem.is_empty() || stem.chars().count() > MAX_FILE_STEM_CHARS {
            return Err(format!(
                "file_name stem must be 1..={} characters",
                MAX_FILE_STEM_CHARS
            ));
        }
        if !stem
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(format!(
                "file_name '{}' may only contain lowercase letters, digits and hyphens before .md",
                trimmed
            ));
        }
        if !is_portable_skill_path_component(trimmed) {
            return Err(format!("file_name '{}' is not a portable file name", trimmed));
        }
        Ok(trimmed.to_string())
    }

    /// 解析目标路径并做双保险：join 后 parent 必须精确等于 base（validate_file_name
    /// 的字符集已排除穿越，此处 fail-closed 再断言一次），符号链接一律拒绝。
    fn resolve_persona_path(base: &Path, file_name: &str) -> Result<PathBuf, String> {
        let file_name = Self::validate_file_name(file_name)?;
        let candidate = base.join(&file_name);
        if candidate.parent() != Some(base)
            || candidate.file_name().and_then(|n| n.to_str()) != Some(file_name.as_str())
        {
            return Err(format!(
                "Resolved persona path escapes the agents directory: {:?}",
                candidate
            ));
        }
        if let Ok(meta) = fs::symlink_metadata(&candidate) {
            if meta.file_type().is_symlink() {
                return Err(format!(
                    "Persona path '{}' is a symlink and is not allowed",
                    file_name
                ));
            }
        }
        Ok(candidate)
    }

    // ------------------------------------------------------------------
    // 内容校验 / 摘要
    // ------------------------------------------------------------------

    /// persona 内容校验：非空、≤64 KiB、包含闭合 frontmatter、`name:` 合法
    /// 且不与内建 profile id 冲突。返回 (agent_name, description)。
    ///
    /// 与 custom_agents.rs 的加载器 fail-closed 规则对齐：写入侧提前拦截
    /// 加载器必然跳过的定义，避免落盘死文件。
    fn validate_persona_content(content: &str) -> Result<(String, Option<String>), String> {
        let bytes = content.as_bytes();
        if bytes.is_empty() {
            return Err("content must not be empty".to_string());
        }
        if bytes.len() > MAX_PERSONA_BYTES {
            return Err(format!(
                "content exceeds {} byte limit (got {} bytes); the loader skips oversized personas",
                MAX_PERSONA_BYTES,
                bytes.len()
            ));
        }

        let mut lines = content.lines();
        if lines.next().map(str::trim) != Some("---") {
            return Err(
                "content must start with a --- YAML frontmatter line (see workspace/custom_agents.rs contract)"
                    .to_string(),
            );
        }
        let mut name: Option<String> = None;
        let mut description: Option<String> = None;
        let mut base: Option<String> = None;
        let mut closed = false;
        for line in lines {
            if line.trim() == "---" {
                closed = true;
                break;
            }
            if let Some((key, value)) = line.split_once(':') {
                match key.trim() {
                    "name" => {
                        let v = value.trim();
                        if !v.is_empty() {
                            name = Some(v.to_string());
                        }
                    }
                    "description" => {
                        let v = value.trim();
                        if !v.is_empty() {
                            description = Some(v.to_string());
                        }
                    }
                    "base" => {
                        let v = value.trim();
                        if !v.is_empty() {
                            base = Some(v.to_string());
                        }
                    }
                    _ => {}
                }
            }
        }
        if !closed {
            return Err("frontmatter is not terminated by a closing --- line".to_string());
        }
        // 加载器对非内建 base 会整文件跳过（fail-closed），写入侧提前拦截
        if let Some(base) = base {
            if AgentProfileResolver::built_in(&base).is_none() {
                return Err(format!(
                    "base '{}' is not a built-in profile id (allowed: default / worker / explorer); the loader would skip this file",
                    base
                ));
            }
        }
        let Some(name) = name else {
            return Err("frontmatter must declare a non-empty 'name'".to_string());
        };
        if name.is_empty()
            || !name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(format!(
                "name '{}' is invalid: only lowercase letters, digits and hyphens are allowed",
                name
            ));
        }
        if AgentProfileResolver::built_in(&name).is_some() {
            return Err(format!(
                "name '{}' conflicts with a built-in profile id; the loader would skip this file",
                name
            ));
        }
        Ok((name, description))
    }

    /// 首行标题：frontmatter 之后第一个非空行（用于审批卡/diff 摘要）。
    fn first_heading(content: &str) -> Option<String> {
        let mut lines = content.lines();
        if lines.next().map(str::trim) != Some("---") {
            return None;
        }
        let mut closed = false;
        for line in lines.by_ref() {
            if line.trim() == "---" {
                closed = true;
                break;
            }
        }
        if !closed {
            return None;
        }
        lines
            .map(str::trim)
            .find(|line| !line.is_empty())
            .map(|line| line.chars().take(120).collect())
    }

    /// frontmatter 摘要（list 用，容忍非法文件：解析失败字段留空）。
    fn frontmatter_summary(content: &str) -> Value {
        let mut name = None;
        let mut description = None;
        let mut base = None;
        let mut lines = content.lines();
        if lines.next().map(str::trim) == Some("---") {
            for line in lines {
                if line.trim() == "---" {
                    break;
                }
                if let Some((key, value)) = line.split_once(':') {
                    let value = value.trim();
                    if value.is_empty() {
                        continue;
                    }
                    match key.trim() {
                        "name" => name = Some(value.to_string()),
                        "description" => description = Some(value.to_string()),
                        "base" => base = Some(value.to_string()),
                        _ => {}
                    }
                }
            }
        }
        json!({ "name": name, "description": description, "base": base })
    }

    // ------------------------------------------------------------------
    // 提案元数据
    // ------------------------------------------------------------------

    fn generate_proposal_id() -> String {
        let millis = Utc::now().timestamp_millis();
        let suffix: String = rand::thread_rng()
            .sample_iter(&rand::distributions::Uniform::new_inclusive(b'a', b'z'))
            .take(4)
            .map(char::from)
            .collect();
        format!("cap_{}_{}", millis, suffix)
    }

    fn validate_proposal_id(proposal_id: &str) -> Result<(), String> {
        let trimmed = proposal_id.trim();
        let valid = trimmed.starts_with("cap_")
            && trimmed.len() > 5
            && trimmed
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !valid {
            return Err(format!(
                "Invalid proposal_id '{}': expected cap_<timestamp>_<suffix>",
                proposal_id
            ));
        }
        Ok(())
    }

    /// 提案 revision 指纹：覆盖全部识别字段，审批后任一字段被篡改都会失配。
    fn proposal_revision_sha256(meta: &PersonaProposalMeta) -> String {
        let mut hasher = Sha256::new();
        for field in [
            meta.proposal_id.as_str(),
            meta.action.as_str(),
            meta.file_name.as_str(),
            meta.agent_name.as_str(),
            meta.content_sha256.as_str(),
            meta.previous_sha256.as_deref().unwrap_or(""),
            meta.created_at.as_str(),
            meta.session_id.as_str(),
            meta.status.as_str(),
        ] {
            hasher.update((field.len() as u64).to_le_bytes());
            hasher.update(field.as_bytes());
        }
        hex::encode(hasher.finalize())
    }

    fn read_proposal_meta(dir: &Path) -> Result<PersonaProposalMeta, String> {
        let text = fs::read_to_string(dir.join(PROPOSAL_META_FILE))
            .map_err(|e| format!("Failed to read {}: {}", PROPOSAL_META_FILE, e))?;
        serde_json::from_str(&text).map_err(|e| format!("Invalid {}: {}", PROPOSAL_META_FILE, e))
    }

    fn write_proposal_meta(dir: &Path, meta: &PersonaProposalMeta) -> Result<(), String> {
        fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create proposal directory: {}", e))?;
        let text = serde_json::to_string_pretty(meta)
            .map_err(|e| format!("Failed to serialize proposal meta: {}", e))?;
        Self::atomic_write(&dir.join(PROPOSAL_META_FILE), text.as_bytes())
    }

    fn count_pending_proposals(pending_root: &Path) -> Result<usize, String> {
        if !pending_root.exists() {
            return Ok(0);
        }
        let mut count = 0usize;
        for entry in
            fs::read_dir(pending_root).map_err(|e| format!("Failed to list proposals: {}", e))?
        {
            let entry = entry.map_err(|e| format!("Failed to read proposal entry: {}", e))?;
            if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            if let Ok(meta) = Self::read_proposal_meta(&entry.path()) {
                if meta.status == "pending" {
                    count += 1;
                }
            }
        }
        Ok(count)
    }

    /// 原子写入：同目录临时文件 + fsync + rename；覆盖时先把旧文件挪到
    /// backup 再发布（Windows rename 不覆盖已存在目标），失败回滚。
    fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
        let dir = target
            .parent()
            .ok_or_else(|| format!("Target path has no parent: {:?}", target))?;
        fs::create_dir_all(dir).map_err(|e| format!("Failed to create directory: {}", e))?;
        let temporary = dir.join(format!(".persona-tmp-{}", uuid::Uuid::new_v4()));
        let write_result = (|| -> Result<(), String> {
            let mut file = fs::File::create(&temporary)
                .map_err(|e| format!("Failed to create temporary file: {}", e))?;
            file.write_all(bytes)
                .map_err(|e| format!("Failed to write temporary file: {}", e))?;
            file.sync_all()
                .map_err(|e| format!("Failed to fsync temporary file: {}", e))?;
            let backup = dir.join(format!(".persona-backup-{}", uuid::Uuid::new_v4()));
            let had_target = target.exists();
            if had_target {
                fs::rename(target, &backup)
                    .map_err(|e| format!("Failed to stage previous file for replacement: {}", e))?;
            }
            if let Err(publish_error) = fs::rename(&temporary, target) {
                if had_target {
                    let _ = fs::rename(&backup, target);
                }
                return Err(format!("Failed to publish file: {}", publish_error));
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

    // ------------------------------------------------------------------
    // custom_agent_list / custom_agent_get
    // ------------------------------------------------------------------

    fn execute_list(&self) -> Result<Value, String> {
        let dir = self.agents_dir();
        let mut personas = Vec::new();
        if dir.exists() {
            let entries =
                fs::read_dir(&dir).map_err(|e| format!("Failed to list agents directory: {}", e))?;
            let mut paths: Vec<PathBuf> = entries
                .flatten()
                .map(|entry| entry.path())
                .filter(|path| {
                    path.extension()
                        .and_then(|ext| ext.to_str())
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
                })
                .collect();
            paths.sort();
            for path in paths {
                let Ok(meta) = fs::symlink_metadata(&path) else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                let file_name = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or_default()
                    .to_string();
                let modified_at = meta
                    .modified()
                    .ok()
                    .map(chrono::DateTime::<Utc>::from)
                    .map(|dt| dt.to_rfc3339());
                let frontmatter = fs::read_to_string(&path)
                    .map(|content| Self::frontmatter_summary(&content))
                    .unwrap_or_else(|_| json!({}));
                personas.push(json!({
                    "file_name": file_name,
                    "bytes": meta.len(),
                    "modified_at": modified_at,
                    "frontmatter": frontmatter,
                }));
            }
        }
        let count = personas.len();
        Ok(json!({
            "agents_dir": dir.to_string_lossy(),
            "personas": personas,
            "count": count,
            "note": "Custom subagent personas are Markdown files with YAML frontmatter (name/description/base/model/tools/skills). They are re-scanned on every subagent_call — changes take effect immediately without restart.",
        }))
    }

    fn execute_get(&self, args: &Value) -> Result<Value, String> {
        let file_name = args
            .get("file_name")
            .or_else(|| args.get("fileName"))
            .and_then(Value::as_str)
            .ok_or("file_name is required")?;
        let path = Self::resolve_persona_path(&self.agents_dir(), file_name)?;
        if !path.exists() {
            return Err(format!(
                "Persona '{}' does not exist. Use custom_agent_list to see available personas.",
                file_name
            ));
        }
        let content = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read persona '{}': {}", file_name, e))?;
        Ok(json!({
            "file_name": Self::validate_file_name(file_name)?,
            "bytes": content.len(),
            "content_sha256": Self::sha256_hex(content.as_bytes()),
            "frontmatter": Self::frontmatter_summary(&content),
            "first_heading": Self::first_heading(&content),
            "content": content,
        }))
    }

    // ------------------------------------------------------------------
    // custom_agent_propose（propose / list / reject）
    // ------------------------------------------------------------------

    fn execute_propose_draft(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        let file_name = args
            .get("file_name")
            .or_else(|| args.get("fileName"))
            .and_then(Value::as_str)
            .ok_or("file_name is required")?;
        let file_name = Self::validate_file_name(file_name)?;
        let content = args
            .get("content")
            .and_then(Value::as_str)
            .ok_or("content is required (full persona Markdown with YAML frontmatter)")?;
        let (agent_name, description) = Self::validate_persona_content(content)?;

        let pending_root = self.pending_dir();
        if Self::count_pending_proposals(&pending_root)? >= MAX_PENDING_PROPOSALS {
            return Err(format!(
                "Too many pending persona proposals (max {}). Apply or reject existing proposals first.",
                MAX_PENDING_PROPOSALS
            ));
        }

        // diff 摘要基线：现读目标文件（如存在），记录旧内容指纹供 apply TOCTOU 复核
        let target = Self::resolve_persona_path(&self.agents_dir(), &file_name)?;
        let (action, previous_sha256, previous_bytes, previous_heading) = if target.exists() {
            let previous = fs::read_to_string(&target)
                .map_err(|e| format!("Failed to read existing persona: {}", e))?;
            (
                "update",
                Some(Self::sha256_hex(previous.as_bytes())),
                Some(previous.len()),
                Self::first_heading(&previous),
            )
        } else {
            ("create", None, None, None)
        };

        let proposal_id = Self::generate_proposal_id();
        let content_sha256 = Self::sha256_hex(content.as_bytes());
        let meta = PersonaProposalMeta {
            proposal_id: proposal_id.clone(),
            action: action.to_string(),
            file_name: file_name.clone(),
            agent_name: agent_name.clone(),
            content_sha256: content_sha256.clone(),
            previous_sha256: previous_sha256.clone(),
            created_at: Utc::now().to_rfc3339(),
            session_id: ctx.session_id.clone(),
            status: "pending".to_string(),
        };
        let proposal_revision = Self::proposal_revision_sha256(&meta);

        let dir = pending_root.join(&proposal_id);
        fs::create_dir_all(&dir)
            .map_err(|e| format!("Failed to create proposal directory: {}", e))?;
        Self::atomic_write(&dir.join(PROPOSAL_PERSONA_FILE), content.as_bytes())?;
        Self::write_proposal_meta(&dir, &meta)?;

        let new_heading = Self::first_heading(content);
        let change_summary = match (action, previous_bytes) {
            ("update", Some(previous_bytes)) => format!(
                "覆盖 {}：{} → {} 字节；标题 {} → {}",
                file_name,
                previous_bytes,
                content.len(),
                previous_heading.as_deref().unwrap_or("（无）"),
                new_heading.as_deref().unwrap_or("（无）"),
            ),
            _ => format!(
                "新建 {}：{} 字节；标题 {}",
                file_name,
                content.len(),
                new_heading.as_deref().unwrap_or("（无）"),
            ),
        };

        Ok(json!({
            "proposal_id": proposal_id,
            "action": action,
            "file_name": file_name,
            "agent_name": agent_name,
            "description": description,
            "content_sha256": content_sha256,
            "proposal_revision": proposal_revision,
            "previous_sha256": previous_sha256,
            "previous_bytes": previous_bytes,
            "new_bytes": content.len(),
            "previous_heading": previous_heading,
            "new_heading": new_heading,
            "change_summary": change_summary,
            "status": "pending",
            "next_step": "Show the user the change_summary (and full draft if asked), then call custom_agent_apply with proposal_id, file_name, expected_content_sha256, expected_proposal_revision and change_summary from this result. Apply requires user approval and cannot be remembered.",
        }))
    }

    fn execute_propose_list(&self) -> Result<Value, String> {
        let pending_root = self.pending_dir();
        let mut pending = Vec::new();
        if pending_root.exists() {
            for entry in fs::read_dir(&pending_root)
                .map_err(|e| format!("Failed to list proposals: {}", e))?
            {
                let entry = entry.map_err(|e| format!("Failed to read proposal entry: {}", e))?;
                if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    continue;
                }
                let Ok(meta) = Self::read_proposal_meta(&entry.path()) else {
                    continue;
                };
                if meta.status != "pending" {
                    continue;
                }
                let proposal_revision = Self::proposal_revision_sha256(&meta);
                pending.push(json!({
                    "proposal_id": meta.proposal_id,
                    "action": meta.action,
                    "file_name": meta.file_name,
                    "agent_name": meta.agent_name,
                    "content_sha256": meta.content_sha256,
                    "previous_sha256": meta.previous_sha256,
                    "proposal_revision": proposal_revision,
                    "created_at": meta.created_at,
                }));
            }
        }
        pending.sort_by(|a, b| {
            let ta = a.get("created_at").and_then(Value::as_str).unwrap_or("");
            let tb = b.get("created_at").and_then(Value::as_str).unwrap_or("");
            tb.cmp(ta)
        });
        let count = pending.len();
        Ok(json!({ "pending": pending, "count": count }))
    }

    fn execute_propose_reject(&self, args: &Value) -> Result<Value, String> {
        let proposal_id = args
            .get("proposal_id")
            .or_else(|| args.get("proposalId"))
            .and_then(Value::as_str)
            .ok_or("proposal_id is required for reject")?;
        Self::validate_proposal_id(proposal_id)?;
        let dir = self.pending_dir().join(proposal_id);
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
            "file_name": meta.file_name,
            "message": "Proposal rejected; files retained for audit.",
        }))
    }

    fn execute_propose(&self, args: &Value, ctx: &ExecutionContext) -> Result<Value, String> {
        match args.get("action").and_then(Value::as_str).unwrap_or("propose") {
            "propose" => self.execute_propose_draft(args, ctx),
            "list" => self.execute_propose_list(),
            "reject" => self.execute_propose_reject(args),
            other => Err(format!(
                "Unsupported action '{}'. Allowed: propose, list, reject",
                other
            )),
        }
    }

    // ------------------------------------------------------------------
    // custom_agent_apply
    // ------------------------------------------------------------------

    fn execute_apply(&self, args: &Value) -> Result<Value, String> {
        let proposal_id = args
            .get("proposal_id")
            .or_else(|| args.get("proposalId"))
            .and_then(Value::as_str)
            .ok_or("proposal_id is required")?;
        Self::validate_proposal_id(proposal_id)?;
        let file_name = args
            .get("file_name")
            .or_else(|| args.get("fileName"))
            .and_then(Value::as_str)
            .ok_or("file_name is required from the reviewed proposal result")?;
        let file_name = Self::validate_file_name(file_name)?;
        let expected_content_sha256 = args
            .get("expected_content_sha256")
            .or_else(|| args.get("expectedContentSha256"))
            .and_then(Value::as_str)
            .ok_or("expected_content_sha256 is required from the reviewed proposal result")?;
        let expected_content_sha256 =
            Self::normalize_sha256(expected_content_sha256, "expected_content_sha256")?;
        let expected_proposal_revision = args
            .get("expected_proposal_revision")
            .or_else(|| args.get("expectedProposalRevision"))
            .and_then(Value::as_str)
            .ok_or("expected_proposal_revision is required from the reviewed proposal result")?;
        let expected_proposal_revision =
            Self::normalize_sha256(expected_proposal_revision, "expected_proposal_revision")?;

        let dir = self.pending_dir().join(proposal_id);
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
        if meta.file_name != file_name {
            return Err(format!(
                "Proposal target changed after approval scope was created: expected file '{}', got '{}'. Review the proposal again before applying.",
                file_name, meta.file_name
            ));
        }
        // 审批指纹复核：revision 覆盖全部元数据字段，内容哈希单独复核草稿正文
        let actual_revision = Self::proposal_revision_sha256(&meta);
        if actual_revision != expected_proposal_revision {
            return Err(format!(
                "Proposal changed after approval scope was created: expected revision {}, got {}. Review the proposal again before applying.",
                expected_proposal_revision, actual_revision
            ));
        }
        if meta.content_sha256 != expected_content_sha256 {
            return Err(format!(
                "Proposal metadata content hash changed after approval scope was created: expected {}, got {}.",
                expected_content_sha256, meta.content_sha256
            ));
        }
        let draft_path = dir.join(PROPOSAL_PERSONA_FILE);
        let draft_meta = fs::symlink_metadata(&draft_path)
            .map_err(|e| format!("Failed to inspect proposal draft: {}", e))?;
        if draft_meta.file_type().is_symlink() || !draft_meta.is_file() {
            return Err("Proposal draft must be a regular non-symlink file".to_string());
        }
        let content = fs::read_to_string(&draft_path)
            .map_err(|e| format!("Failed to read proposal draft: {}", e))?;
        if Self::sha256_hex(content.as_bytes()) != expected_content_sha256 {
            return Err(
                "Proposal draft changed after approval scope was created. Review the proposal again before applying."
                    .to_string(),
            );
        }
        // 落盘前重跑内容校验（builtin id 集合可能随版本变化，fail-closed）
        let (agent_name, _) = Self::validate_persona_content(&content)?;

        // 目标文件 TOCTOU：create 要求目标仍不存在；update 要求目标内容
        // 仍是提案时的版本（否则会覆盖用户/其他会话的手工修改）
        let agents_dir = self.agents_dir();
        let target = Self::resolve_persona_path(&agents_dir, &file_name)?;
        match meta.previous_sha256.as_deref() {
            None => {
                if target.exists() {
                    return Err(format!(
                        "Persona '{}' was created after this proposal was drafted. Call custom_agent_propose again from the current content.",
                        file_name
                    ));
                }
            }
            Some(previous) => {
                if !target.exists() {
                    return Err(format!(
                        "Persona '{}' no longer exists. Create a new proposal.",
                        file_name
                    ));
                }
                let current = fs::read(&target)
                    .map_err(|e| format!("Failed to read target persona: {}", e))?;
                let current_sha256 = Self::sha256_hex(&current);
                if current_sha256 != previous {
                    return Err(format!(
                        "Target persona changed since proposal (TOCTOU): expected {}, got {}. Call custom_agent_propose again from the current content.",
                        previous, current_sha256
                    ));
                }
            }
        }

        Self::atomic_write(&target, content.as_bytes())?;

        // 标记 applied 失败只降级为警告：目标状态已改变，重放会被上面的
        // TOCTOU 检查自然拦截（create → 目标已存在；update → previous_sha 失配）
        let mut applied_meta = meta.clone();
        applied_meta.status = "applied".to_string();
        let meta_warning = Self::write_proposal_meta(&dir, &applied_meta)
            .err()
            .map(|e| format!("persona was written, but marking the proposal applied failed: {}", e));

        let mut output = json!({
            "applied": true,
            "proposal_id": proposal_id,
            "action": meta.action,
            "file_name": file_name,
            "agent_name": agent_name,
            "path": format!("workspaces/agents/{}", file_name),
            "content_sha256": expected_content_sha256,
            "bytes": content.len(),
            "message": "Persona written to the agents directory. Profiles are re-scanned on every subagent_call, so the new/updated persona is usable immediately (profile id = frontmatter name).",
        });
        if let Some(warning) = meta_warning {
            output["warning"] = json!(warning);
        }
        Ok(output)
    }

    // ------------------------------------------------------------------
    // custom_agent_remove
    // ------------------------------------------------------------------

    fn execute_remove(&self, args: &Value) -> Result<Value, String> {
        let file_name = args
            .get("file_name")
            .or_else(|| args.get("fileName"))
            .and_then(Value::as_str)
            .ok_or("file_name is required")?;
        let file_name = Self::validate_file_name(file_name)?;
        let target = Self::resolve_persona_path(&self.agents_dir(), &file_name)?;
        if !target.exists() {
            return Err(format!(
                "Persona '{}' does not exist. Use custom_agent_list to see available personas.",
                file_name
            ));
        }
        let heading = fs::read_to_string(&target)
            .ok()
            .and_then(|content| Self::first_heading(&content));
        fs::remove_file(&target)
            .map_err(|e| format!("Failed to remove persona '{}': {}", file_name, e))?;
        Ok(json!({
            "removed": true,
            "file_name": file_name,
            "first_heading": heading,
            "path": format!("workspaces/agents/{}", file_name),
            "message": "Persona removed. It disappears from subagent profile resolution immediately; this cannot be undone.",
        }))
    }
}

#[async_trait]
impl ToolExecutor for CustomAgentExecutor {
    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let short = Self::strip_namespace(&call.name);

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match short {
            tool_names::CUSTOM_AGENT_LIST => self.execute_list(),
            tool_names::CUSTOM_AGENT_GET => self.execute_get(&call.arguments),
            tool_names::CUSTOM_AGENT_PROPOSE => self.execute_propose(&call.arguments, ctx),
            tool_names::CUSTOM_AGENT_APPLY => self.execute_apply(&call.arguments),
            tool_names::CUSTOM_AGENT_REMOVE => self.execute_remove(&call.arguments),
            other => Err(format!("Unsupported custom agent tool: {}", other)),
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
                    log::warn!("[CustomAgentExecutor] Failed to save tool block: {}", e);
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
                    log::warn!("[CustomAgentExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn can_handle(&self, tool_name: &str) -> bool {
        matches!(
            Self::strip_namespace(tool_name),
            tool_names::CUSTOM_AGENT_LIST
                | tool_names::CUSTOM_AGENT_GET
                | tool_names::CUSTOM_AGENT_PROPOSE
                | tool_names::CUSTOM_AGENT_APPLY
                | tool_names::CUSTOM_AGENT_REMOVE
        )
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        match Self::strip_namespace(tool_name) {
            // 落盘/删除是权限升级类操作：High + never-remember
            // （见 approval_scope::PRIVILEGE_ESCALATION_TOOLS）
            tool_names::CUSTOM_AGENT_APPLY | tool_names::CUSTOM_AGENT_REMOVE => {
                ToolSensitivity::High
            }
            tool_names::CUSTOM_AGENT_PROPOSE => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn name(&self) -> &'static str {
        "CustomAgentExecutor"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_executor() -> (tempfile::TempDir, CustomAgentExecutor) {
        let temp = tempfile::tempdir().expect("temp dir");
        let coordinator = Arc::new(WorkspaceCoordinator::new(temp.path().to_path_buf()));
        (temp, CustomAgentExecutor::new(coordinator))
    }

    const VALID_PERSONA: &str =
        "---\nname: paper-summarizer\ndescription: 论文摘要\nbase: explorer\n---\n# 论文摘要员\n正文。\n";

    #[test]
    fn file_name_validation_rejects_traversal_and_bad_charsets() {
        assert!(CustomAgentExecutor::validate_file_name("paper-summarizer.md").is_ok());
        assert!(CustomAgentExecutor::validate_file_name("a1-b2.md").is_ok());
        for bad in [
            "",
            "noext",
            "Upper.md",
            "has space.md",
            "under_score.md",
            "../evil.md",
            "a/b.md",
            "a\\b.md",
            ".md",
            "con.md",
            "x.MD",
        ] {
            assert!(
                CustomAgentExecutor::validate_file_name(bad).is_err(),
                "accepted {bad:?}"
            );
        }
    }

    #[test]
    fn resolve_persona_path_stays_within_base_and_rejects_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let base = temp.path().join("agents");
        fs::create_dir_all(&base).unwrap();
        let resolved = CustomAgentExecutor::resolve_persona_path(&base, "ok-agent.md").unwrap();
        assert_eq!(resolved.parent(), Some(base.as_path()));

        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            fs::write(temp.path().join("outside.md"), "x").unwrap();
            symlink(temp.path().join("outside.md"), base.join("link-agent.md")).unwrap();
            assert!(CustomAgentExecutor::resolve_persona_path(&base, "link-agent.md").is_err());
        }
    }

    #[test]
    fn content_validation_enforces_frontmatter_name_and_size() {
        assert!(CustomAgentExecutor::validate_persona_content(VALID_PERSONA).is_ok());
        // 缺 frontmatter / 未闭合 / 缺 name / 非法 name / builtin 冲突 / 超限
        assert!(CustomAgentExecutor::validate_persona_content("# no frontmatter").is_err());
        assert!(CustomAgentExecutor::validate_persona_content("---\nname: x").is_err());
        assert!(CustomAgentExecutor::validate_persona_content("---\nbase: worker\n---\nBody").is_err());
        assert!(
            CustomAgentExecutor::validate_persona_content("---\nname: Upper-Case\n---\nBody")
                .is_err()
        );
        assert!(
            CustomAgentExecutor::validate_persona_content("---\nname: worker\n---\nBody").is_err()
        );
        // 非内建 base：加载器会跳过，写入侧必须拦截
        assert!(CustomAgentExecutor::validate_persona_content(
            "---\nname: ok-agent\nbase: not-a-builtin\n---\nBody"
        )
        .is_err());
        let huge = format!("---\nname: big-agent\n---\n{}", "x".repeat(MAX_PERSONA_BYTES));
        assert!(CustomAgentExecutor::validate_persona_content(&huge).is_err());
    }

    #[test]
    fn proposal_id_validation_rejects_path_injection() {
        assert!(CustomAgentExecutor::validate_proposal_id("cap_1234567890_abcd").is_ok());
        assert!(CustomAgentExecutor::validate_proposal_id("../etc").is_err());
        assert!(CustomAgentExecutor::validate_proposal_id("cap_../../x").is_err());
        assert!(CustomAgentExecutor::validate_proposal_id("wp_1234_abcd").is_err());
        let id = CustomAgentExecutor::generate_proposal_id();
        assert!(CustomAgentExecutor::validate_proposal_id(&id).is_ok());
    }

    #[test]
    fn proposal_revision_detects_tampering() {
        let meta = PersonaProposalMeta {
            proposal_id: "cap_1234567890_abcd".to_string(),
            action: "create".to_string(),
            file_name: "paper-summarizer.md".to_string(),
            agent_name: "paper-summarizer".to_string(),
            content_sha256: CustomAgentExecutor::sha256_hex(VALID_PERSONA.as_bytes()),
            previous_sha256: None,
            created_at: "2026-07-20T00:00:00Z".to_string(),
            session_id: "sess_test".to_string(),
            status: "pending".to_string(),
        };
        let revision = CustomAgentExecutor::proposal_revision_sha256(&meta);
        let mut retargeted = meta.clone();
        retargeted.file_name = "other-agent.md".to_string();
        assert_ne!(
            revision,
            CustomAgentExecutor::proposal_revision_sha256(&retargeted)
        );
        let mut replaced = meta.clone();
        replaced.content_sha256 = CustomAgentExecutor::sha256_hex(b"malicious");
        assert_ne!(
            revision,
            CustomAgentExecutor::proposal_revision_sha256(&replaced)
        );
    }

    #[test]
    fn propose_then_apply_writes_persona_and_blocks_replay() {
        let (_temp, executor) = make_executor();
        let ctx_session = "sess_test".to_string();

        // 直接走内部方法（不依赖 ExecutionContext / Tauri window）
        let pending_root = executor.pending_dir();
        let meta = PersonaProposalMeta {
            proposal_id: CustomAgentExecutor::generate_proposal_id(),
            action: "create".to_string(),
            file_name: "paper-summarizer.md".to_string(),
            agent_name: "paper-summarizer".to_string(),
            content_sha256: CustomAgentExecutor::sha256_hex(VALID_PERSONA.as_bytes()),
            previous_sha256: None,
            created_at: Utc::now().to_rfc3339(),
            session_id: ctx_session,
            status: "pending".to_string(),
        };
        let dir = pending_root.join(&meta.proposal_id);
        fs::create_dir_all(&dir).unwrap();
        CustomAgentExecutor::atomic_write(
            &dir.join(PROPOSAL_PERSONA_FILE),
            VALID_PERSONA.as_bytes(),
        )
        .unwrap();
        CustomAgentExecutor::write_proposal_meta(&dir, &meta).unwrap();
        let revision = CustomAgentExecutor::proposal_revision_sha256(&meta);

        let apply_args = json!({
            "proposal_id": meta.proposal_id,
            "file_name": "paper-summarizer.md",
            "expected_content_sha256": meta.content_sha256,
            "expected_proposal_revision": revision,
        });
        let output = executor.execute_apply(&apply_args).expect("apply ok");
        assert_eq!(output["applied"], json!(true));
        let target = executor.agents_dir().join("paper-summarizer.md");
        assert_eq!(fs::read_to_string(&target).unwrap(), VALID_PERSONA);

        // 重放：提案已 applied，且 create 目标已存在 → 双重拦截
        let replay = executor.execute_apply(&apply_args);
        assert!(replay.is_err());

        // remove：删除后文件消失
        let removed = executor
            .execute_remove(&json!({ "file_name": "paper-summarizer.md" }))
            .expect("remove ok");
        assert_eq!(removed["removed"], json!(true));
        assert!(!target.exists());
    }

    #[test]
    fn apply_rejects_target_drift_toctou() {
        let (_temp, executor) = make_executor();
        let agents_dir = executor.agents_dir();
        fs::create_dir_all(&agents_dir).unwrap();
        // 提案是 create，但审批期间目标文件被别人创建了
        let meta = PersonaProposalMeta {
            proposal_id: CustomAgentExecutor::generate_proposal_id(),
            action: "create".to_string(),
            file_name: "drift-agent.md".to_string(),
            agent_name: "drift-agent".to_string(),
            content_sha256: CustomAgentExecutor::sha256_hex(VALID_PERSONA.as_bytes()),
            previous_sha256: None,
            created_at: Utc::now().to_rfc3339(),
            session_id: "sess_test".to_string(),
            status: "pending".to_string(),
        };
        let dir = executor.pending_dir().join(&meta.proposal_id);
        fs::create_dir_all(&dir).unwrap();
        CustomAgentExecutor::atomic_write(
            &dir.join(PROPOSAL_PERSONA_FILE),
            VALID_PERSONA.as_bytes(),
        )
        .unwrap();
        CustomAgentExecutor::write_proposal_meta(&dir, &meta).unwrap();
        let revision = CustomAgentExecutor::proposal_revision_sha256(&meta);
        fs::write(agents_dir.join("drift-agent.md"), "---\nname: drift-agent\n---\nManual").unwrap();

        let error = executor
            .execute_apply(&json!({
                "proposal_id": meta.proposal_id,
                "file_name": "drift-agent.md",
                "expected_content_sha256": meta.content_sha256,
                "expected_proposal_revision": revision,
            }))
            .expect_err("target drift must fail");
        assert!(error.contains("created after this proposal"));
    }

    #[test]
    fn sensitivity_mapping_matches_governance_contract() {
        let (_temp, executor) = make_executor();
        assert_eq!(
            executor.sensitivity_level("builtin-custom_agent_list"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-custom_agent_get"),
            ToolSensitivity::Low
        );
        assert_eq!(
            executor.sensitivity_level("builtin-custom_agent_propose"),
            ToolSensitivity::Medium
        );
        assert_eq!(
            executor.sensitivity_level("builtin-custom_agent_apply"),
            ToolSensitivity::High
        );
        assert_eq!(
            executor.sensitivity_level("builtin-custom_agent_remove"),
            ToolSensitivity::High
        );
        for name in [
            "custom_agent_list",
            "builtin-custom_agent_get",
            "custom_agent_propose",
            "builtin-custom_agent_apply",
            "custom_agent_remove",
        ] {
            assert!(executor.can_handle(name), "{name}");
        }
        assert!(!executor.can_handle("subagent_call"));
    }
}
