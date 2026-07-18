//! Chat V2 - 技能更新检查与一键更新
//!
//! 基于 `skill.provenance.<skill_id>` 中记录的安装来源（HTTPS zip URL）与
//! `package_sha256`，重新拉取上游包并对比内容哈希（对标 Hermes 的
//! `skills check` / `skills update` drift 检测）。
//!
//! ## 安全说明
//! - 只有 `source_kind == "url"` 的技能可远程复查；runtime_path 来源不可重取。
//! - 更新走与 `skill_install` 相同的 staging → 原子发布路径，写回 provenance。
//! - 更新后的包内容已变化，既有信任指纹自动失效（fail-closed），需用户重新信任。

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::State;

use super::error::{ChatV2Error, ChatV2Result};
use super::skills::{
    install_skill_package_from_zip_bytes, prepare_skill_package_from_zip_bytes,
    DEFAULT_AGENT_SKILLS_BASE, MAX_SKILL_PACKAGE_ZIP_BYTES,
};
use super::tools::fetch_executor::FetchExecutor;
use super::tools::skill_install_executor::AGENT_INSTALLED_MARKER;
use crate::commands::AppState;

const PROVENANCE_SETTINGS_PREFIX: &str = "skill.provenance.";

/// 与 `SkillInstallExecutor` 写入的 provenance JSON 对齐（camelCase）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProvenance {
    source_kind: String,
    source_detail: String,
    package_sha256: String,
    #[serde(default)]
    risk_level: String,
    #[serde(default)]
    installed_at: String,
    #[serde(default)]
    session_id: String,
}

/// 单个技能的更新检查结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateCheckResult {
    pub skill_id: String,
    /// 是否可远程复查（url 来源才可）
    pub checkable: bool,
    /// 有可用更新（远程哈希与本地记录不同）
    pub update_available: bool,
    pub source_kind: String,
    pub source_summary: String,
    pub current_sha256: String,
    pub remote_sha256: Option<String>,
    pub error: Option<String>,
}

/// 一键更新结果
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillUpdateApplyResult {
    pub skill_id: String,
    pub updated: bool,
    pub package_sha256: String,
    pub risk_level: String,
    pub path: String,
    /// 更新后的包默认未信任，需用户在技能管理中重新信任
    pub trust_status: String,
}

fn is_valid_skill_id(skill_id: &str) -> bool {
    !skill_id.is_empty()
        && skill_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

fn load_provenance(
    db: &crate::database::Database,
    skill_id: &str,
) -> ChatV2Result<StoredProvenance> {
    let key = format!("{}{}", PROVENANCE_SETTINGS_PREFIX, skill_id);
    let raw = db
        .get_setting(&key)
        .map_err(|e| ChatV2Error::IoError(format!("Failed to read skill provenance: {}", e)))?
        .ok_or_else(|| {
            ChatV2Error::ResourceNotFound(format!(
                "No install provenance recorded for skill '{}'; only link/zip-installed skills can be update-checked",
                skill_id
            ))
        })?;
    serde_json::from_str(&raw).map_err(|e| {
        ChatV2Error::IoError(format!(
            "Corrupted provenance record for skill '{}': {}",
            skill_id, e
        ))
    })
}

/// 重新获取上游的**规范技能包字节**：
/// - `url` 来源：直接下载 zip
/// - `tap` 来源：下载仓库 zip 后确定性重打包技能子目录
async fn refetch_package_bytes(
    fetch: &FetchExecutor,
    provenance: &StoredProvenance,
) -> Result<Vec<u8>, String> {
    match provenance.source_kind.as_str() {
        "url" => {
            fetch
                .download_https_bytes(&provenance.source_detail, MAX_SKILL_PACKAGE_ZIP_BYTES)
                .await
        }
        "tap" => {
            let (zip_url, subdir) =
                super::skill_taps::decode_tap_source_detail(&provenance.source_detail)?;
            let (repo_bytes, resolved_url) =
                super::skill_taps::fetch_repo_zip(fetch, &[zip_url]).await?;
            let fallback = super::skill_taps::repo_name_from_zip_url(&resolved_url);
            tokio::task::spawn_blocking(move || {
                super::skill_taps::repack_skill_subdir(&repo_bytes, &subdir, &fallback)
            })
            .await
            .map_err(|e| format!("Repack task failed: {}", e))?
        }
        other => Err(format!("Source kind '{}' is not refetchable", other)),
    }
}

fn is_refetchable_kind(source_kind: &str) -> bool {
    matches!(source_kind, "url" | "tap")
}

async fn check_one(
    fetch: &FetchExecutor,
    skill_id: String,
    provenance: StoredProvenance,
) -> SkillUpdateCheckResult {
    let source_summary = provenance.source_detail.clone();
    if !is_refetchable_kind(&provenance.source_kind) {
        return SkillUpdateCheckResult {
            skill_id,
            checkable: false,
            update_available: false,
            source_kind: provenance.source_kind,
            source_summary,
            current_sha256: provenance.package_sha256,
            remote_sha256: None,
            error: None,
        };
    }

    match refetch_package_bytes(fetch, &provenance).await {
        Ok(bytes) => {
            let remote = sha256_hex(&bytes);
            let changed = remote != provenance.package_sha256;
            SkillUpdateCheckResult {
                skill_id,
                checkable: true,
                update_available: changed,
                source_kind: provenance.source_kind,
                source_summary,
                current_sha256: provenance.package_sha256,
                remote_sha256: Some(remote),
                error: None,
            }
        }
        Err(e) => SkillUpdateCheckResult {
            skill_id,
            checkable: true,
            update_available: false,
            source_kind: provenance.source_kind,
            source_summary,
            current_sha256: provenance.package_sha256,
            remote_sha256: None,
            error: Some(e),
        },
    }
}

/// 检查已安装技能的上游更新。
///
/// - `skill_ids` 省略时检查所有带 provenance 记录的技能。
/// - 单个技能的下载失败不会使整个调用失败（错误记录在对应条目）。
#[tauri::command]
pub async fn skill_check_updates(
    state: State<'_, AppState>,
    skill_ids: Option<Vec<String>>,
) -> ChatV2Result<Vec<SkillUpdateCheckResult>> {
    let entries = state
        .database
        .get_settings_by_prefix(PROVENANCE_SETTINGS_PREFIX)
        .map_err(|e| ChatV2Error::IoError(format!("Failed to list skill provenance: {}", e)))?;

    let filter: Option<std::collections::HashSet<String>> =
        skill_ids.map(|ids| ids.into_iter().collect());

    let mut targets: Vec<(String, StoredProvenance)> = Vec::new();
    for (key, value, _updated_at) in entries {
        let Some(skill_id) = key.strip_prefix(PROVENANCE_SETTINGS_PREFIX) else {
            continue;
        };
        if !is_valid_skill_id(skill_id) {
            continue;
        }
        if let Some(filter) = &filter {
            if !filter.contains(skill_id) {
                continue;
            }
        }
        match serde_json::from_str::<StoredProvenance>(&value) {
            Ok(provenance) => targets.push((skill_id.to_string(), provenance)),
            Err(e) => {
                log::warn!(
                    "[SkillUpdates] Skipping corrupted provenance for '{}': {}",
                    skill_id,
                    e
                );
            }
        }
    }

    let fetch = FetchExecutor::new();
    let mut results = Vec::with_capacity(targets.len());
    for (skill_id, provenance) in targets {
        results.push(check_one(&fetch, skill_id, provenance).await);
    }
    Ok(results)
}

/// 按 provenance 记录的 URL 重新安装（更新）一个技能。
///
/// 走与 `skill_install` 相同的 staging → 原子发布路径；更新后写回新的
/// provenance（保留来源），并保留 `AGENT_INSTALLED.json` 溯源 marker。
/// 包内容变化会使既有信任指纹失效，技能回到未信任状态。
#[tauri::command]
pub async fn skill_update_from_source(
    state: State<'_, AppState>,
    skill_id: String,
) -> ChatV2Result<SkillUpdateApplyResult> {
    let skill_id = skill_id.trim().to_string();
    if !is_valid_skill_id(&skill_id) {
        return Err(ChatV2Error::InvalidInput(
            "Skill ID can only contain letters, numbers, hyphens, and underscores".to_string(),
        ));
    }

    let provenance = load_provenance(&state.database, &skill_id)?;
    if !is_refetchable_kind(&provenance.source_kind) {
        return Err(ChatV2Error::InvalidInput(format!(
            "Skill '{}' was installed from a non-refetchable source ({}); reinstall it manually",
            skill_id, provenance.source_kind
        )));
    }

    let fetch = FetchExecutor::new();
    let bytes = refetch_package_bytes(&fetch, &provenance)
        .await
        .map_err(ChatV2Error::IoError)?;
    let remote_sha256 = sha256_hex(&bytes);

    if remote_sha256 == provenance.package_sha256 {
        return Ok(SkillUpdateApplyResult {
            skill_id,
            updated: false,
            package_sha256: provenance.package_sha256,
            risk_level: provenance.risk_level,
            path: String::new(),
            trust_status: "unchanged".to_string(),
        });
    }

    // 先 dry-run 扫描确认包目标 id 未漂移（防止上游把包换成另一个技能）
    let scan =
        install_skill_package_from_zip_bytes(bytes.clone(), DEFAULT_AGENT_SKILLS_BASE, true, true)
            .await?;
    if scan.skill_id != skill_id {
        return Err(ChatV2Error::InvalidInput(format!(
            "Upstream package now installs '{}' instead of '{}'; refusing to update. Reinstall it as a new skill if intended.",
            scan.skill_id, skill_id
        )));
    }

    let prepared =
        prepare_skill_package_from_zip_bytes(bytes, DEFAULT_AGENT_SKILLS_BASE, true).await?;

    let new_provenance = json!({
        "sourceKind": provenance.source_kind,
        "sourceDetail": provenance.source_detail,
        "packageSha256": prepared.result().package_sha256,
        "riskLevel": prepared.result().risk_level,
        "installedAt": chrono::Utc::now().to_rfc3339(),
        "sessionId": provenance.session_id,
        "updatedFromSha256": provenance.package_sha256,
    });
    let provenance_json = serde_json::to_string_pretty(&new_provenance)
        .map_err(|e| ChatV2Error::IoError(format!("Failed to serialize provenance: {}", e)))?;
    prepared
        .write_staged_file(AGENT_INSTALLED_MARKER, provenance_json.as_bytes())
        .map_err(ChatV2Error::IoError)?;

    let (installed, committed) = prepared.commit()?;

    let key = format!("{}{}", PROVENANCE_SETTINGS_PREFIX, skill_id);
    if let Err(persist_error) = state.database.save_setting(&key, &provenance_json) {
        return match committed.rollback() {
            Ok(()) => Err(ChatV2Error::IoError(format!(
                "Failed to persist updated provenance ({}); the previous skill was restored.",
                persist_error
            ))),
            Err(rollback_error) => Err(ChatV2Error::IoError(format!(
                "Failed to persist updated provenance ({}), and failed to restore the previous skill ({}).",
                persist_error, rollback_error
            ))),
        };
    }
    committed.finalize();

    log::info!(
        "[SkillUpdates] Skill '{}' updated from {} (sha256 {} -> {})",
        skill_id,
        provenance.source_detail,
        provenance.package_sha256,
        installed.package_sha256
    );

    Ok(SkillUpdateApplyResult {
        skill_id,
        updated: true,
        package_sha256: installed.package_sha256,
        risk_level: installed.risk_level,
        path: installed.path,
        trust_status: "untrusted".to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provenance_json_roundtrip_matches_installer_shape() {
        let raw = r#"{
            "sourceKind": "url",
            "sourceDetail": "https://example.com/pkg.zip",
            "packageSha256": "abc",
            "riskLevel": "low",
            "installedAt": "2026-07-18T00:00:00Z",
            "sessionId": "sess_x"
        }"#;
        let parsed: StoredProvenance = serde_json::from_str(raw).expect("parse provenance");
        assert_eq!(parsed.source_kind, "url");
        assert_eq!(parsed.source_detail, "https://example.com/pkg.zip");
        assert_eq!(parsed.package_sha256, "abc");
    }

    #[test]
    fn skill_id_validation_rejects_path_like_ids() {
        assert!(is_valid_skill_id("pdf-tools"));
        assert!(is_valid_skill_id("skill_1"));
        assert!(!is_valid_skill_id(""));
        assert!(!is_valid_skill_id("../evil"));
        assert!(!is_valid_skill_id("a/b"));
    }
}
