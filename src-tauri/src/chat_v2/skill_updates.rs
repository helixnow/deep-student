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

/// 与 `SkillInstallExecutor` / ClawHub 安装写入的 provenance JSON 对齐（camelCase）。
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
    /// ClawHub 安装时写入的 slug（优先于 sourceDetail 解析）
    #[serde(default)]
    clawhub_slug: Option<String>,
    /// ClawHub 安装时写入的 version
    #[serde(default)]
    clawhub_version: Option<String>,
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

/// 解析 ClawHub provenance 中的 slug + 已安装 version。
fn resolve_clawhub_identity(provenance: &StoredProvenance) -> Result<(String, String), String> {
    if let Some(slug) = provenance
        .clawhub_slug
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        let version = provenance
            .clawhub_version
            .as_ref()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                super::clawhub_client::decode_clawhub_provenance(&provenance.source_detail)
                    .ok()
                    .map(|(_, v)| v)
            })
            .unwrap_or_default();
        return Ok((slug.to_string(), version));
    }
    super::clawhub_client::decode_clawhub_provenance(&provenance.source_detail)
}

/// 重新获取上游的**规范技能包字节**：
/// - `url` 来源：直接下载 zip
/// - `tap` 来源：下载仓库 zip 后确定性重打包技能子目录
/// - `clawhub` 来源：经 ClawHub 下载（含 GitHub handoff）
async fn refetch_package_bytes(
    fetch: &FetchExecutor,
    provenance: &StoredProvenance,
) -> Result<(Vec<u8>, Option<String>), String> {
    match provenance.source_kind.as_str() {
        "url" => {
            let bytes = fetch
                .download_https_bytes(&provenance.source_detail, MAX_SKILL_PACKAGE_ZIP_BYTES)
                .await?;
            Ok((bytes, None))
        }
        "tap" => {
            let (zip_url, subdir) =
                super::skill_taps::decode_tap_source_detail(&provenance.source_detail)?;
            let (repo_bytes, resolved_url) =
                super::skill_taps::fetch_repo_zip(fetch, &[zip_url]).await?;
            let fallback = super::skill_taps::repo_name_from_zip_url(&resolved_url);
            let bytes = tokio::task::spawn_blocking(move || {
                super::skill_taps::repack_skill_subdir(&repo_bytes, &subdir, &fallback)
            })
            .await
            .map_err(|e| format!("Repack task failed: {}", e))??;
            Ok((bytes, None))
        }
        "clawhub" => {
            let (slug, _installed_version) = resolve_clawhub_identity(provenance)?;
            let client = super::clawhub_client::ClawHubClient::shared()?;
            // 先取 latest version，再按该 version 下载
            let remote_version = match client.skill_detail(&slug).await {
                Ok(detail) if !detail.version.trim().is_empty() => detail.version,
                _ => String::new(),
            };
            let downloaded = client
                .download_package_bytes(
                    &slug,
                    if remote_version.is_empty() {
                        None
                    } else {
                        Some(remote_version.as_str())
                    },
                )
                .await?;
            let version = if !downloaded.version.is_empty() {
                downloaded.version
            } else {
                remote_version
            };
            Ok((downloaded.bytes, Some(version)))
        }
        other => Err(format!("Source kind '{}' is not refetchable", other)),
    }
}

fn is_refetchable_kind(source_kind: &str) -> bool {
    matches!(source_kind, "url" | "tap" | "clawhub")
}

async fn check_clawhub_one(
    skill_id: String,
    provenance: StoredProvenance,
) -> SkillUpdateCheckResult {
    let source_summary = provenance.source_detail.clone();
    let (slug, installed_version) = match resolve_clawhub_identity(&provenance) {
        Ok(identity) => identity,
        Err(e) => {
            return SkillUpdateCheckResult {
                skill_id,
                checkable: true,
                update_available: false,
                source_kind: provenance.source_kind,
                source_summary,
                current_sha256: provenance.package_sha256,
                remote_sha256: None,
                error: Some(e),
            };
        }
    };

    let client = match super::clawhub_client::ClawHubClient::shared() {
        Ok(c) => c,
        Err(e) => {
            return SkillUpdateCheckResult {
                skill_id,
                checkable: true,
                update_available: false,
                source_kind: provenance.source_kind,
                source_summary,
                current_sha256: installed_version,
                remote_sha256: None,
                error: Some(e),
            };
        }
    };

    match client.skill_detail(&slug).await {
        Ok(detail) => {
            let remote_version = detail.version;
            let outdated = super::clawhub_client::clawhub_version_outdated(
                &installed_version,
                &remote_version,
            );
            SkillUpdateCheckResult {
                skill_id,
                checkable: true,
                update_available: outdated,
                source_kind: provenance.source_kind,
                source_summary,
                // ClawHub 检查以 version 为准；复用 sha 字段承载版本字符串便于前端展示
                current_sha256: installed_version,
                remote_sha256: if remote_version.is_empty() {
                    None
                } else {
                    Some(remote_version)
                },
                error: None,
            }
        }
        Err(e) => SkillUpdateCheckResult {
            skill_id,
            checkable: true,
            update_available: false,
            source_kind: provenance.source_kind,
            source_summary,
            current_sha256: installed_version,
            remote_sha256: None,
            error: Some(e),
        },
    }
}

async fn check_one(
    fetch: &FetchExecutor,
    skill_id: String,
    provenance: StoredProvenance,
) -> SkillUpdateCheckResult {
    let source_summary = provenance.source_detail.clone();
    if provenance.source_kind == "clawhub" {
        return check_clawhub_one(skill_id, provenance).await;
    }

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
        Ok((bytes, _remote_version)) => {
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
) -> Result<Vec<SkillUpdateCheckResult>, String> {
    skill_check_updates_impl(state, skill_ids)
        .await
        .map_err(String::from)
}

async fn skill_check_updates_impl(
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
) -> Result<SkillUpdateApplyResult, String> {
    skill_update_from_source_impl(state, skill_id)
        .await
        .map_err(String::from)
}

async fn skill_update_from_source_impl(
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
    let (bytes, clawhub_remote_version) = refetch_package_bytes(&fetch, &provenance)
        .await
        .map_err(ChatV2Error::IoError)?;
    let remote_sha256 = sha256_hex(&bytes);

    let clawhub_version_bumped = provenance.source_kind == "clawhub"
        && clawhub_remote_version
            .as_ref()
            .map(|remote| {
                let installed = provenance
                    .clawhub_version
                    .clone()
                    .or_else(|| resolve_clawhub_identity(&provenance).ok().map(|(_, v)| v))
                    .unwrap_or_default();
                super::clawhub_client::clawhub_version_outdated(&installed, remote)
            })
            .unwrap_or(false);

    if remote_sha256 == provenance.package_sha256 && !clawhub_version_bumped {
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

    let (source_detail, clawhub_slug, clawhub_version) = if provenance.source_kind == "clawhub" {
        let (slug, _) = resolve_clawhub_identity(&provenance).map_err(ChatV2Error::InvalidInput)?;
        let version = clawhub_remote_version
            .clone()
            .filter(|v| !v.trim().is_empty())
            .unwrap_or_else(|| {
                provenance
                    .clawhub_version
                    .clone()
                    .unwrap_or_else(|| "unknown".to_string())
            });
        let detail = super::clawhub_client::encode_clawhub_provenance(&slug, &version);
        (detail, Some(slug), Some(version))
    } else {
        (provenance.source_detail.clone(), None, None)
    };

    let mut new_provenance = json!({
        "sourceKind": provenance.source_kind,
        "sourceDetail": source_detail,
        "packageSha256": prepared.result().package_sha256,
        "riskLevel": prepared.result().risk_level,
        "installedAt": chrono::Utc::now().to_rfc3339(),
        "sessionId": provenance.session_id,
        "updatedFromSha256": provenance.package_sha256,
    });
    if let Some(slug) = clawhub_slug {
        new_provenance["clawhubSlug"] = json!(slug);
    }
    if let Some(version) = clawhub_version {
        new_provenance["clawhubVersion"] = json!(version);
    }
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

    #[test]
    fn clawhub_provenance_identity_prefers_explicit_fields() {
        let provenance = StoredProvenance {
            source_kind: "clawhub".to_string(),
            source_detail: "clawhub:old-slug@0.9.0".to_string(),
            package_sha256: "abc".to_string(),
            risk_level: "low".to_string(),
            installed_at: String::new(),
            session_id: String::new(),
            clawhub_slug: Some("sonoscli".to_string()),
            clawhub_version: Some("1.0.0".to_string()),
        };
        let (slug, version) = resolve_clawhub_identity(&provenance).expect("identity");
        assert_eq!(slug, "sonoscli");
        assert_eq!(version, "1.0.0");
    }

    #[test]
    fn clawhub_is_refetchable_kind() {
        assert!(is_refetchable_kind("clawhub"));
        assert!(is_refetchable_kind("url"));
        assert!(!is_refetchable_kind("runtime_path"));
    }

    #[test]
    fn clawhub_provenance_json_roundtrip_keeps_version_fields() {
        let raw = r#"{
            "sourceKind": "clawhub",
            "sourceDetail": "clawhub:sonoscli@1.0.0",
            "packageSha256": "abc",
            "riskLevel": "low",
            "installedAt": "2026-07-18T00:00:00Z",
            "sessionId": "skills_management",
            "clawhubSlug": "sonoscli",
            "clawhubVersion": "1.0.0"
        }"#;
        let parsed: StoredProvenance = serde_json::from_str(raw).expect("parse clawhub provenance");
        assert_eq!(parsed.source_kind, "clawhub");
        assert_eq!(parsed.clawhub_slug.as_deref(), Some("sonoscli"));
        assert_eq!(parsed.clawhub_version.as_deref(), Some("1.0.0"));
        assert!(super::super::clawhub_client::clawhub_version_outdated(
            parsed.clawhub_version.as_deref().unwrap_or(""),
            "1.1.0"
        ));
    }
}
