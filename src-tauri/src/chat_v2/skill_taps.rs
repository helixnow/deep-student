//! Chat V2 - Tap 式技能源（GitHub 仓库即技能目录）
//!
//! 技能源解析：任何一个包含
//! 若干 `SKILL.md` 技能目录的 GitHub 仓库都可以作为"技能源"被浏览与安装。
//!
//! ## 流程
//! 1. `skill_tap_catalog`：把仓库 URL 规范化为 codeload zip 直链，下载后
//!    只读扫描出所有技能条目（名称/描述/版本），不落盘。
//! 2. `skill_tap_install`：重新下载仓库 zip，把选定子目录**确定性重打包**
//!    为规范技能包（技能目录为 zip 顶层），复用 `skill_import_zip` 的
//!    扫描/风险分级/staging 安装内核，并写入 `tap` 来源 provenance。
//! 3. 更新检查（`skill_updates`）对 `tap` 来源重放"下载 + 重打包 + 哈希
//!    对比"，因为重打包是确定性的，子目录未变化时哈希不变。
//!
//! ## 安全
//! - 下载复用 FetchExecutor（仅 https、SSRF 防护、64MB 上限）。
//! - 重打包后的包走与 zip 导入完全相同的限额 / 路径校验 / 风险分级。
//! - 技能目录写入仍只经 staging → 原子发布，默认 untrusted。

use std::io::{Read, Write};

use serde::Serialize;
use serde_json::json;
use tauri::State;

use super::error::{ChatV2Error, ChatV2Result};
use super::skills::{
    install_skill_package_from_zip_bytes, prepare_skill_package_from_zip_bytes,
    SkillImportZipResult, DEFAULT_AGENT_SKILLS_BASE, MAX_SKILL_PACKAGE_ZIP_BYTES,
};
use super::tools::fetch_executor::FetchExecutor;
use super::tools::skill_install_executor::AGENT_INSTALLED_MARKER;
use crate::commands::AppState;

/// 目录里最多列出的技能数
const MAX_CATALOG_SKILLS: usize = 200;
/// 技能子目录相对仓库根的最大深度
const MAX_SKILL_DIR_DEPTH: usize = 4;
/// 读取 SKILL.md 做元数据摘要的字节上限
const MAX_SKILL_MD_PREVIEW_BYTES: u64 = 256 * 1024;

// ============================================================================
// 返回类型
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TapCatalogEntry {
    /// 相对仓库根的技能目录（根目录技能为空串）
    pub subdir: String,
    /// 技能目录名（即安装后的 skill_id）
    pub skill_id: String,
    pub name: String,
    pub description: String,
    pub version: String,
    /// 该技能目录下的文件数
    pub file_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TapCatalog {
    /// 用户输入的仓库 URL（原样回显）
    pub repo_url: String,
    /// 解析出的 codeload zip 直链（用于 provenance 与更新检查）
    pub resolved_zip_url: String,
    pub skills: Vec<TapCatalogEntry>,
}

// ============================================================================
// URL 规范化
// ============================================================================

/// 把 GitHub 仓库 URL 规范化为候选 codeload zip 直链。
///
/// 支持：
/// - `https://github.com/{owner}/{repo}`（可带 `.git` / 尾斜杠）
/// - `https://github.com/{owner}/{repo}/tree/{ref}`（ref 为分支/标签/sha）
/// - 已是 `https://codeload.github.com/...` 直链时原样返回
///
/// 未带 ref 时返回 main、master 两个候选。
pub(crate) fn resolve_codeload_candidates(repo_url: &str) -> Result<Vec<String>, String> {
    let trimmed = repo_url.trim().trim_end_matches('/');
    if trimmed.starts_with("https://codeload.github.com/") {
        return Ok(vec![trimmed.to_string()]);
    }

    let rest = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("https://www.github.com/"))
        .ok_or("Only https://github.com/{owner}/{repo} tap sources are supported")?;

    let segments: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
    if segments.len() < 2 {
        return Err("Repository URL must include owner and repo".to_string());
    }
    let owner = segments[0];
    let repo = segments[1].trim_end_matches(".git");
    if owner.is_empty() || repo.is_empty() {
        return Err("Repository URL must include owner and repo".to_string());
    }

    // /tree/{ref}（忽略 ref 之后的子路径——目录扫描会列出全部技能）
    if segments.len() >= 4 && segments[2] == "tree" {
        let reference = segments[3];
        return Ok(vec![format!(
            "https://codeload.github.com/{}/{}/zip/{}",
            owner, repo, reference
        )]);
    }

    Ok(vec![
        format!(
            "https://codeload.github.com/{}/{}/zip/refs/heads/main",
            owner, repo
        ),
        format!(
            "https://codeload.github.com/{}/{}/zip/refs/heads/master",
            owner, repo
        ),
    ])
}

/// 按候选顺序下载仓库 zip，返回 (bytes, 命中的 URL)。
pub(crate) async fn fetch_repo_zip(
    fetch: &FetchExecutor,
    candidates: &[String],
) -> Result<(Vec<u8>, String), String> {
    let mut last_error = String::from("No download candidates");
    for url in candidates {
        match fetch
            .download_https_bytes(url, MAX_SKILL_PACKAGE_ZIP_BYTES)
            .await
        {
            Ok(bytes) => return Ok((bytes, url.clone())),
            Err(e) => last_error = format!("{}: {}", url, e),
        }
    }
    Err(format!("Failed to download repository zip: {}", last_error))
}

// ============================================================================
// 仓库 zip 扫描
// ============================================================================

fn is_valid_skill_dir_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
}

/// GitHub 仓库 zip 的顶层前缀（`{repo}-{ref}/`）。
fn repo_zip_top_prefix(entry_names: &[String]) -> Option<String> {
    let first = entry_names.first()?;
    let prefix_end = first.find('/')?;
    let prefix = &first[..=prefix_end];
    if entry_names.iter().all(|n| n.starts_with(prefix)) {
        Some(prefix.to_string())
    } else {
        None
    }
}

/// 从 SKILL.md 文本提取 name/description/version 的轻量摘要。
///
/// 只做单行 `key: value` 解析（含引号剥离），多行块取首行；解析失败时
/// 回退为空串，由前端用目录名兜底展示。
fn extract_skill_summary(content: &str) -> (String, String, String) {
    let Some(frontmatter) = super::skill_requires::extract_frontmatter(content) else {
        return (String::new(), String::new(), String::new());
    };
    let get = |key: &str| -> String {
        for line in frontmatter.lines() {
            let Some(rest) = line.strip_prefix(key) else {
                continue;
            };
            let Some(value) = rest.strip_prefix(':') else {
                continue;
            };
            let value = value.trim();
            if value.is_empty() || value == "|" || value == ">" || value == ">-" || value == "|-" {
                continue;
            }
            return value.trim_matches('"').trim_matches('\'').to_string();
        }
        String::new()
    };
    (get("name"), get("description"), get("version"))
}

/// 扫描仓库 zip，列出所有技能条目。
fn scan_repo_zip_for_catalog(zip_bytes: &[u8]) -> Result<Vec<TapCatalogEntry>, String> {
    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid repository zip: {}", e))?;

    let mut entry_names = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| format!("Zip read error: {}", e))?;
        entry_names.push(file.name().to_string());
    }
    let prefix = repo_zip_top_prefix(&entry_names).unwrap_or_default();

    // 收集候选 SKILL.md（相对仓库根）
    let mut skill_md_indexes: Vec<(usize, String)> = Vec::new();
    for (i, raw_name) in entry_names.iter().enumerate() {
        let norm = raw_name.replace('\\', "/");
        let Some(relative) = norm.strip_prefix(&prefix) else {
            continue;
        };
        if relative.contains("..") {
            continue;
        }
        // 跳过隐藏目录（.git / .github 等）
        if relative.split('/').any(|seg| seg.starts_with('.')) {
            continue;
        }
        let is_skill_md = relative == "SKILL.md" || relative.ends_with("/SKILL.md");
        if !is_skill_md {
            continue;
        }
        let depth = relative.matches('/').count();
        if depth > MAX_SKILL_DIR_DEPTH {
            continue;
        }
        skill_md_indexes.push((i, relative.to_string()));
        if skill_md_indexes.len() >= MAX_CATALOG_SKILLS {
            break;
        }
    }

    let mut entries = Vec::with_capacity(skill_md_indexes.len());
    for (index, relative) in skill_md_indexes {
        let subdir = relative
            .strip_suffix("SKILL.md")
            .unwrap_or("")
            .trim_end_matches('/')
            .to_string();
        let skill_id = if subdir.is_empty() {
            // 根目录技能：目录名不可得，用占位（安装时以仓库名兜底）
            String::new()
        } else {
            subdir.rsplit('/').next().unwrap_or("").to_string()
        };
        if !subdir.is_empty() && !is_valid_skill_dir_name(&skill_id) {
            continue;
        }

        let mut content = String::new();
        {
            let file = archive
                .by_index(index)
                .map_err(|e| format!("Zip read error: {}", e))?;
            if file.size() <= MAX_SKILL_MD_PREVIEW_BYTES {
                let mut reader = file.take(MAX_SKILL_MD_PREVIEW_BYTES);
                let mut buf = Vec::new();
                if reader.read_to_end(&mut buf).is_ok() {
                    content = String::from_utf8_lossy(&buf).to_string();
                }
            }
        }
        let (name, description, version) = extract_skill_summary(&content);

        let dir_prefix = if subdir.is_empty() {
            prefix.clone()
        } else {
            format!("{}{}/", prefix, subdir)
        };
        let file_count = entry_names
            .iter()
            .filter(|n| {
                let norm = n.replace('\\', "/");
                norm.starts_with(&dir_prefix) && !norm.ends_with('/')
            })
            .count();

        entries.push(TapCatalogEntry {
            subdir,
            skill_id,
            name,
            description,
            version,
            file_count,
        });
    }

    // 子目录技能优先、按路径排序，根目录技能放最后
    entries.sort_by(|a, b| (a.subdir.is_empty(), &a.subdir).cmp(&(b.subdir.is_empty(), &b.subdir)));
    Ok(entries)
}

// ============================================================================
// 确定性重打包
// ============================================================================

/// 把仓库 zip 中的技能子目录重打包为规范技能包（技能目录为 zip 顶层）。
///
/// 输出是确定性的：条目按路径排序、固定压缩参数与时间戳，同一子目录内容
/// 必然产生相同字节序列——更新检查以重打包结果的 sha256 判断上游漂移。
pub(crate) fn repack_skill_subdir(
    repo_zip: &[u8],
    subdir: &str,
    fallback_dir_name: &str,
) -> Result<Vec<u8>, String> {
    let cursor = std::io::Cursor::new(repo_zip);
    let mut archive =
        zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid repository zip: {}", e))?;

    let mut entry_names = Vec::with_capacity(archive.len());
    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| format!("Zip read error: {}", e))?;
        entry_names.push(file.name().to_string());
    }
    let prefix = repo_zip_top_prefix(&entry_names).unwrap_or_default();

    let subdir = subdir.trim_matches('/');
    if subdir.contains("..") {
        return Err("Invalid skill subdirectory".to_string());
    }
    let dir_name = if subdir.is_empty() {
        fallback_dir_name.to_string()
    } else {
        subdir.rsplit('/').next().unwrap_or("").to_string()
    };
    if !is_valid_skill_dir_name(&dir_name) {
        return Err(format!("Invalid skill directory name: {}", dir_name));
    }

    let dir_prefix = if subdir.is_empty() {
        prefix.clone()
    } else {
        format!("{}{}/", prefix, subdir)
    };

    // 收集 (输出路径, 原始索引)，按输出路径排序保证确定性
    let mut members: Vec<(String, usize)> = Vec::new();
    for (i, raw_name) in entry_names.iter().enumerate() {
        let norm = raw_name.replace('\\', "/");
        if !norm.starts_with(&dir_prefix) || norm.ends_with('/') {
            continue;
        }
        let relative = &norm[dir_prefix.len()..];
        if relative.is_empty() || relative.contains("..") {
            continue;
        }
        // 排除隐藏文件/目录（.git、.DS_Store 等）；空段（绝对路径 "/x" 或
        // "a//b"）一并拒绝，防止畸形条目混入重打包结果
        if relative
            .split('/')
            .any(|seg| seg.is_empty() || seg.starts_with('.'))
        {
            continue;
        }
        members.push((format!("{}/{}", dir_name, relative), i));
    }
    if members.is_empty() {
        return Err(format!("No files found under skill directory '{}'", subdir));
    }
    members.sort_by(|a, b| a.0.cmp(&b.0));

    let mut out = std::io::Cursor::new(Vec::new());
    {
        let mut writer = zip::ZipWriter::new(&mut out);
        let options = zip::write::FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .last_modified_time(zip::DateTime::default());
        let mut total: u64 = 0;
        for (out_path, index) in members {
            let mut file = archive
                .by_index(index)
                .map_err(|e| format!("Zip read error: {}", e))?;
            let mut buf = Vec::with_capacity(file.size().min(64 * 1024) as usize);
            file.read_to_end(&mut buf)
                .map_err(|e| format!("Zip read error: {}", e))?;
            total = total.saturating_add(buf.len() as u64);
            if total > MAX_SKILL_PACKAGE_ZIP_BYTES {
                return Err(format!(
                    "Skill directory exceeds the {} byte package limit",
                    MAX_SKILL_PACKAGE_ZIP_BYTES
                ));
            }
            writer
                .start_file(&out_path, options)
                .map_err(|e| format!("Zip write error: {}", e))?;
            writer
                .write_all(&buf)
                .map_err(|e| format!("Zip write error: {}", e))?;
        }
        writer
            .finish()
            .map_err(|e| format!("Zip write error: {}", e))?;
    }
    let bytes = out.into_inner();
    if bytes.len() as u64 > MAX_SKILL_PACKAGE_ZIP_BYTES {
        return Err(format!(
            "Repacked skill package exceeds the {} byte limit",
            MAX_SKILL_PACKAGE_ZIP_BYTES
        ));
    }
    Ok(bytes)
}

/// 从 codeload URL 推导仓库名（根目录技能的目录名兜底）。
pub(crate) fn repo_name_from_zip_url(zip_url: &str) -> String {
    // https://codeload.github.com/{owner}/{repo}/zip/...
    let rest = zip_url
        .strip_prefix("https://codeload.github.com/")
        .unwrap_or("");
    let mut parts = rest.split('/');
    let _owner = parts.next();
    let repo = parts.next().unwrap_or("");
    let sanitized: String = repo
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    if sanitized.is_empty() {
        "imported-skill".to_string()
    } else {
        sanitized
    }
}

// ============================================================================
// Provenance（与 skill_install / skill_updates 的记录格式对齐）
// ============================================================================

const PROVENANCE_SETTINGS_PREFIX: &str = "skill.provenance.";

/// tap 来源 detail 编码：`{codeload_zip_url}#{subdir}`
pub(crate) fn encode_tap_source_detail(zip_url: &str, subdir: &str) -> String {
    format!("{}#{}", zip_url, subdir)
}

/// 解析 tap 来源 detail，返回 (zip_url, subdir)。
pub(crate) fn decode_tap_source_detail(detail: &str) -> Result<(String, String), String> {
    let (url, subdir) = detail
        .rsplit_once('#')
        .ok_or("Corrupted tap provenance detail (missing #subdir)")?;
    if !url.starts_with("https://") {
        return Err("Corrupted tap provenance detail (invalid url)".to_string());
    }
    Ok((url.to_string(), subdir.to_string()))
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// 浏览 tap 技能源：下载仓库 zip 并列出全部技能条目（只读，不落盘）。
#[tauri::command]
pub async fn skill_tap_catalog(repo_url: String) -> Result<TapCatalog, String> {
    skill_tap_catalog_impl(repo_url).await.map_err(String::from)
}

async fn skill_tap_catalog_impl(repo_url: String) -> ChatV2Result<TapCatalog> {
    let candidates = resolve_codeload_candidates(&repo_url).map_err(ChatV2Error::InvalidInput)?;
    let fetch = FetchExecutor::new();
    let (bytes, resolved_zip_url) = fetch_repo_zip(&fetch, &candidates)
        .await
        .map_err(ChatV2Error::IoError)?;
    let skills = tokio::task::spawn_blocking(move || scan_repo_zip_for_catalog(&bytes))
        .await
        .map_err(|e| ChatV2Error::IoError(format!("Catalog scan task failed: {}", e)))?
        .map_err(ChatV2Error::InvalidInput)?;

    Ok(TapCatalog {
        repo_url,
        resolved_zip_url,
        skills,
    })
}

/// 从 tap 技能源安装（或 dry_run 装前扫描）一个技能子目录。
///
/// `dry_run=true` 时只做重打包 + 扫描（含风险分级），不写盘；确认后再以
/// `dry_run=false` 安装，写入 `tap` 来源 provenance 供后续更新检查。
#[tauri::command]
pub async fn skill_tap_install(
    state: State<'_, AppState>,
    zip_url: String,
    subdir: String,
    overwrite: bool,
    dry_run: Option<bool>,
    expected_package_sha256: Option<String>,
) -> Result<SkillImportZipResult, String> {
    skill_tap_install_impl(
        state,
        zip_url,
        subdir,
        overwrite,
        dry_run,
        expected_package_sha256,
    )
    .await
    .map_err(String::from)
}

async fn skill_tap_install_impl(
    state: State<'_, AppState>,
    zip_url: String,
    subdir: String,
    overwrite: bool,
    dry_run: Option<bool>,
    expected_package_sha256: Option<String>,
) -> ChatV2Result<SkillImportZipResult> {
    let dry_run = dry_run.unwrap_or(false);
    if !zip_url.starts_with("https://codeload.github.com/") {
        return Err(ChatV2Error::InvalidInput(
            "zip_url must be a resolved codeload.github.com link from skill_tap_catalog"
                .to_string(),
        ));
    }

    let fetch = FetchExecutor::new();
    let (repo_bytes, resolved_url) = fetch_repo_zip(&fetch, std::slice::from_ref(&zip_url))
        .await
        .map_err(ChatV2Error::IoError)?;

    let fallback_name = repo_name_from_zip_url(&resolved_url);
    let subdir_for_pack = subdir.clone();
    let package_bytes = tokio::task::spawn_blocking(move || {
        repack_skill_subdir(&repo_bytes, &subdir_for_pack, &fallback_name)
    })
    .await
    .map_err(|e| ChatV2Error::IoError(format!("Repack task failed: {}", e)))?
    .map_err(ChatV2Error::InvalidInput)?;

    if dry_run {
        return install_skill_package_from_zip_bytes(
            package_bytes,
            DEFAULT_AGENT_SKILLS_BASE,
            overwrite,
            true,
        )
        .await;
    }

    let prepared =
        prepare_skill_package_from_zip_bytes(package_bytes, DEFAULT_AGENT_SKILLS_BASE, overwrite)
            .await?;
    let expected = expected_package_sha256
        .as_deref()
        .ok_or_else(|| {
            ChatV2Error::InvalidInput(
                "expectedPackageSha256 is required when installing a tap skill".to_string(),
            )
        })?
        .trim()
        .to_ascii_lowercase();
    if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(ChatV2Error::InvalidInput(
            "expectedPackageSha256 must be a 64-character SHA-256 digest".to_string(),
        ));
    }
    let actual = prepared.result().package_sha256.to_ascii_lowercase();
    let digest_matches = actual
        .as_bytes()
        .iter()
        .zip(expected.as_bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0;
    if !digest_matches {
        return Err(ChatV2Error::InvalidInput(format!(
            "Tap package changed after confirmation: expected {}, got {}",
            expected, actual
        )));
    }

    let skill_id = prepared.result().skill_id.clone();
    let provenance = json!({
        "sourceKind": "tap",
        "sourceDetail": encode_tap_source_detail(&resolved_url, &subdir),
        "packageSha256": prepared.result().package_sha256,
        "riskLevel": prepared.result().risk_level,
        "installedAt": chrono::Utc::now().to_rfc3339(),
        "sessionId": "skills_management",
    });
    let provenance_json = serde_json::to_string_pretty(&provenance)
        .map_err(|e| ChatV2Error::IoError(format!("Failed to serialize provenance: {}", e)))?;
    prepared
        .write_staged_file(AGENT_INSTALLED_MARKER, provenance_json.as_bytes())
        .map_err(ChatV2Error::IoError)?;

    let (installed, committed) = prepared.commit()?;

    let key = format!("{}{}", PROVENANCE_SETTINGS_PREFIX, skill_id);
    if let Err(persist_error) = state.database.save_setting(&key, &provenance_json) {
        return match committed.rollback() {
            Ok(()) => Err(ChatV2Error::IoError(format!(
                "Failed to persist tap provenance ({}); the install was rolled back.",
                persist_error
            ))),
            Err(rollback_error) => Err(ChatV2Error::IoError(format!(
                "Failed to persist tap provenance ({}), and rollback also failed ({}).",
                persist_error, rollback_error
            ))),
        };
    }
    committed.finalize();

    log::info!(
        "[SkillTaps] Installed '{}' from {}#{} (sha256={})",
        installed.skill_id,
        resolved_url,
        subdir,
        installed.package_sha256
    );
    Ok(installed)
}

// ============================================================================
// 导出为 tap 结构
// ============================================================================

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TapExportResult {
    pub path: String,
    pub skill_count: usize,
    pub file_count: usize,
}

/// 把已安装的用户技能导出为 tap 结构 zip：
///
/// ```text
/// export.zip
/// ├── README.md          （技能清单，可直接作为 GitHub 仓库首页）
/// ├── <skill-a>/SKILL.md + scripts/ + ...
/// └── <skill-b>/SKILL.md + ...
/// ```
///
/// 解压推到 GitHub 仓库后即可作为技能源被「技能源」浏览器或
/// `skill_tap_catalog` 消费——发布/分享闭环。
///
/// Android 的保存对话框返回 `content://` URI（不透明 ID，常无 `.zip` 扩展名）：
/// 先把 zip 写到应用私有暂存文件，再经 `unified_file_manager::copy_file`
/// （ContentResolver 写入 + 回读校验）落到目标 URI。
#[tauri::command]
pub async fn skill_export_tap(
    window: tauri::Window,
    state: State<'_, AppState>,
    skill_ids: Vec<String>,
    dest_path: String,
) -> Result<TapExportResult, String> {
    let staging_dir = state
        .file_manager
        .get_writable_app_data_dir()
        .join("temp_skill_tap_export");
    let write_virtual = move |staged: String, target: String| {
        crate::unified_file_manager::copy_file(&window, &staged, &target)
            .map(|_| ())
            .map_err(|e| e.to_string())
    };
    skill_export_tap_impl(skill_ids, dest_path, staging_dir, write_virtual)
        .await
        .map_err(String::from)
}

/// 校验导出目标；返回是否为虚拟 URI（content:// 等）。
///
/// 虚拟 URI 由系统保存对话框生成，名称不可控（`/document/446`），
/// 只对本地路径要求 `.zip` 扩展名。
fn validate_tap_export_destination(dest_path: &str) -> ChatV2Result<bool> {
    if crate::unified_file_manager::is_virtual_uri(dest_path) {
        return Ok(true);
    }
    crate::unified_file_manager::reject_double_encoded_virtual_uri(dest_path)
        .map_err(|e| ChatV2Error::InvalidInput(e.to_string()))?;
    let dest = std::path::Path::new(dest_path);
    if dest.extension().and_then(|e| e.to_str()) != Some("zip") {
        return Err(ChatV2Error::InvalidInput(
            "Destination must be a .zip file".to_string(),
        ));
    }
    Ok(false)
}

/// 把打好的 zip 字节写到目标；虚拟 URI 走「暂存文件 → write_virtual」，
/// 无论成败都清理暂存文件。返回写入的目标（本地路径或原始 URI）。
fn write_tap_export_zip<F>(
    bytes: Vec<u8>,
    dest_path: &str,
    dest_is_virtual: bool,
    staging_dir: &std::path::Path,
    write_virtual: F,
) -> Result<String, String>
where
    F: FnOnce(String, String) -> Result<(), String>,
{
    if !dest_is_virtual {
        let dest = std::path::Path::new(dest_path);
        std::fs::write(dest, bytes)
            .map_err(|e| format!("Failed to write {}: {}", dest.display(), e))?;
        return Ok(dest.display().to_string());
    }

    std::fs::create_dir_all(staging_dir)
        .map_err(|e| format!("Failed to create staging dir: {}", e))?;
    let staged = staging_dir.join(format!("skills_tap_{}.zip", uuid::Uuid::new_v4()));
    let result = std::fs::write(&staged, bytes)
        .map_err(|e| format!("Failed to stage export {}: {}", staged.display(), e))
        .and_then(|()| {
            write_virtual(
                staged.to_string_lossy().to_string(),
                dest_path.trim().to_string(),
            )
            .map_err(|e| format!("Failed to write {}: {}", dest_path, e))
        });
    if let Err(e) = std::fs::remove_file(&staged) {
        if e.kind() != std::io::ErrorKind::NotFound {
            log::warn!(
                "[SkillTaps] Failed to remove staged export {}: {}",
                staged.display(),
                e
            );
        }
    }
    result.map(|()| dest_path.trim().to_string())
}

async fn skill_export_tap_impl<F>(
    skill_ids: Vec<String>,
    dest_path: String,
    staging_dir: std::path::PathBuf,
    write_virtual: F,
) -> ChatV2Result<TapExportResult>
where
    F: FnOnce(String, String) -> Result<(), String> + Send + 'static,
{
    if skill_ids.is_empty() {
        return Err(ChatV2Error::InvalidInput("No skills selected".to_string()));
    }
    if skill_ids.len() > 64 {
        return Err(ChatV2Error::InvalidInput(
            "Too many skills (max 64)".to_string(),
        ));
    }
    for id in &skill_ids {
        if !is_valid_skill_dir_name(id) {
            return Err(ChatV2Error::InvalidInput(format!(
                "Invalid skill id: {}",
                id
            )));
        }
    }
    let dest_is_virtual = validate_tap_export_destination(&dest_path)?;

    let base = super::skills::expand_path(DEFAULT_AGENT_SKILLS_BASE);
    let result = tokio::task::spawn_blocking(move || -> Result<TapExportResult, String> {
        let mut out = std::io::Cursor::new(Vec::new());
        let mut file_count = 0usize;
        let mut skill_count = 0usize;
        let mut readme_lines: Vec<String> = vec![
            "# Skills Tap".to_string(),
            String::new(),
            "Exported from Deep Student. Push this directory to a GitHub repository,".to_string(),
            "then anyone can browse & install these skills via a skill source (tap) URL."
                .to_string(),
            String::new(),
            "## Skills".to_string(),
            String::new(),
        ];
        {
            let mut writer = zip::ZipWriter::new(&mut out);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated)
                .last_modified_time(zip::DateTime::default());
            let mut total: u64 = 0;

            for skill_id in &skill_ids {
                let skill_dir = base.join(skill_id);
                if !skill_dir.is_dir() {
                    return Err(format!("Skill directory not found: {}", skill_id));
                }
                let mut summary = (String::new(), String::new(), String::new());
                let mut members: Vec<(String, std::path::PathBuf)> = Vec::new();
                for entry in walkdir::WalkDir::new(&skill_dir).follow_links(false) {
                    let entry = entry.map_err(|e| format!("Failed to read skill files: {}", e))?;
                    if !entry.file_type().is_file() {
                        continue;
                    }
                    let rel = entry
                        .path()
                        .strip_prefix(&skill_dir)
                        .map_err(|e| format!("Path error: {}", e))?
                        .to_string_lossy()
                        .replace('\\', "/");
                    // 跳过隐藏文件与安装溯源 marker（不属于技能内容）
                    if rel.split('/').any(|seg| seg.starts_with('.'))
                        || rel == "AGENT_INSTALLED.json"
                    {
                        continue;
                    }
                    if rel == "SKILL.md" {
                        if let Ok(content) = std::fs::read_to_string(entry.path()) {
                            summary = extract_skill_summary(&content);
                        }
                    }
                    members.push((format!("{}/{}", skill_id, rel), entry.path().to_path_buf()));
                }
                if members.is_empty() {
                    return Err(format!("Skill '{}' has no exportable files", skill_id));
                }
                members.sort_by(|a, b| a.0.cmp(&b.0));

                for (out_path, fs_path) in members {
                    let bytes = std::fs::read(&fs_path)
                        .map_err(|e| format!("Failed to read {}: {}", out_path, e))?;
                    total = total.saturating_add(bytes.len() as u64);
                    if total > MAX_SKILL_PACKAGE_ZIP_BYTES {
                        return Err(format!(
                            "Export exceeds the {} byte limit",
                            MAX_SKILL_PACKAGE_ZIP_BYTES
                        ));
                    }
                    writer
                        .start_file(&out_path, options)
                        .map_err(|e| format!("Zip write error: {}", e))?;
                    writer
                        .write_all(&bytes)
                        .map_err(|e| format!("Zip write error: {}", e))?;
                    file_count += 1;
                }

                let (name, description, version) = summary;
                let display = if name.is_empty() {
                    skill_id.clone()
                } else {
                    name
                };
                let ver = if version.is_empty() {
                    String::new()
                } else {
                    format!(" (v{})", version)
                };
                readme_lines.push(format!(
                    "- **{}**{} — `{}/`：{}",
                    display, ver, skill_id, description
                ));
                skill_count += 1;
            }

            readme_lines.push(String::new());
            writer
                .start_file("README.md", options)
                .map_err(|e| format!("Zip write error: {}", e))?;
            writer
                .write_all(readme_lines.join("\n").as_bytes())
                .map_err(|e| format!("Zip write error: {}", e))?;
            file_count += 1;
            writer
                .finish()
                .map_err(|e| format!("Zip write error: {}", e))?;
        }

        let path = write_tap_export_zip(
            out.into_inner(),
            &dest_path,
            dest_is_virtual,
            &staging_dir,
            write_virtual,
        )?;
        Ok(TapExportResult {
            path,
            skill_count,
            file_count,
        })
    })
    .await
    .map_err(|e| ChatV2Error::IoError(format!("Export task failed: {}", e)))?
    .map_err(ChatV2Error::IoError)?;

    log::info!(
        "[SkillTaps] Exported {} skills ({} files) to {}",
        result.skill_count,
        result.file_count,
        result.path
    );
    Ok(result)
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn build_repo_zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Deflated);
            for (path, content) in files {
                writer.start_file(*path, options).unwrap();
                writer.write_all(content.as_bytes()).unwrap();
            }
            writer.finish().unwrap();
        }
        cursor.into_inner()
    }

    const REPO: &str = "my-skills-main/";

    fn sample_repo() -> Vec<u8> {
        build_repo_zip(&[
            (
                &format!("{}skills/pdf-tools/SKILL.md", REPO),
                "---\nname: PDF 工具\ndescription: 处理 PDF\nversion: 1.2.0\n---\n\n# body\n",
            ),
            (
                &format!("{}skills/pdf-tools/scripts/run.py", REPO),
                "print('hi')\n",
            ),
            (
                &format!("{}skills/note-taker/SKILL.md", REPO),
                "---\nname: \"Note Taker\"\ndescription: takes notes\n---\nbody\n",
            ),
            (&format!("{}README.md", REPO), "# readme\n"),
            (&format!("{}.github/workflows/ci.yml", REPO), "on: push\n"),
        ])
    }

    #[test]
    fn resolves_repo_url_to_codeload_candidates() {
        let candidates = resolve_codeload_candidates("https://github.com/foo/bar").unwrap();
        assert_eq!(candidates.len(), 2);
        assert!(candidates[0].contains("/foo/bar/zip/refs/heads/main"));
        assert!(candidates[1].contains("/foo/bar/zip/refs/heads/master"));

        let with_ref = resolve_codeload_candidates("https://github.com/foo/bar/tree/dev").unwrap();
        assert_eq!(
            with_ref,
            vec!["https://codeload.github.com/foo/bar/zip/dev"]
        );

        assert!(resolve_codeload_candidates("https://gitlab.com/foo/bar").is_err());
        assert!(resolve_codeload_candidates("https://github.com/foo").is_err());
    }

    #[test]
    fn catalog_lists_skills_and_skips_hidden_dirs() {
        let entries = scan_repo_zip_for_catalog(&sample_repo()).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].skill_id, "note-taker");
        assert_eq!(entries[0].name, "Note Taker");
        assert_eq!(entries[1].skill_id, "pdf-tools");
        assert_eq!(entries[1].name, "PDF 工具");
        assert_eq!(entries[1].version, "1.2.0");
        assert_eq!(entries[1].file_count, 2);
    }

    #[test]
    fn repack_is_deterministic_and_canonical() {
        let repo = sample_repo();
        let a = repack_skill_subdir(&repo, "skills/pdf-tools", "fallback").unwrap();
        let b = repack_skill_subdir(&repo, "skills/pdf-tools", "fallback").unwrap();
        assert_eq!(a, b, "repack must be byte-identical for the same input");

        // 重打包结果应是规范技能包：顶层为技能目录
        let cursor = std::io::Cursor::new(&a);
        let mut archive = zip::ZipArchive::new(cursor).unwrap();
        let mut names: Vec<String> = (0..archive.len())
            .map(|i| archive.by_index(i).unwrap().name().to_string())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec![
                "pdf-tools/SKILL.md".to_string(),
                "pdf-tools/scripts/run.py".to_string(),
            ]
        );
    }

    #[test]
    fn repack_rejects_missing_subdir() {
        assert!(repack_skill_subdir(&sample_repo(), "skills/nope", "fb").is_err());
    }

    #[test]
    fn tap_export_destination_accepts_opaque_content_uri_only_for_virtual() {
        assert_eq!(
            validate_tap_export_destination(
                "content://com.android.providers.downloads.documents/document/446"
            )
            .unwrap(),
            true
        );
        assert_eq!(
            validate_tap_export_destination("/tmp/my-skills-tap.zip").unwrap(),
            false
        );
        assert!(validate_tap_export_destination("/tmp/my-skills-tap").is_err());
        assert!(validate_tap_export_destination("/tmp/my-skills-tap.txt").is_err());
        // 双重编码的 content URI 不得被当作本地路径放行
        assert!(validate_tap_export_destination(
            "content%3A%2F%2Fcom.android.providers.downloads.documents%2Fdocument%2F446.zip"
        )
        .is_err());
    }

    #[test]
    fn tap_export_virtual_destination_goes_through_staging_and_cleans_up() {
        let staging = tempfile::tempdir().expect("tempdir");
        let target = "content://com.android.externalstorage.documents/document/primary%3Atap";
        let mut seen: Option<(String, Vec<u8>)> = None;
        let path = write_tap_export_zip(
            b"PK\x03\x04zip".to_vec(),
            target,
            true,
            staging.path(),
            |staged, dest| {
                let bytes = std::fs::read(&staged).map_err(|e| e.to_string())?;
                seen = Some((dest, bytes));
                Ok(())
            },
        )
        .expect("virtual export");
        assert_eq!(path, target);
        let (dest, bytes) = seen.expect("write_virtual called");
        assert_eq!(dest, target);
        assert_eq!(bytes, b"PK\x03\x04zip");
        assert_eq!(
            std::fs::read_dir(staging.path()).unwrap().count(),
            0,
            "staged file must be removed"
        );

        // 写入失败也要清理暂存文件并上抛错误
        let err = write_tap_export_zip(b"PK".to_vec(), target, true, staging.path(), |_, _| {
            Err("provider refused".to_string())
        })
        .expect_err("failure must surface");
        assert!(err.contains("provider refused"));
        assert_eq!(std::fs::read_dir(staging.path()).unwrap().count(), 0);
    }

    #[test]
    fn tap_export_local_destination_writes_directly() {
        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("tap.zip");
        let dest_str = dest.to_string_lossy().to_string();
        let path = write_tap_export_zip(
            b"PK".to_vec(),
            &dest_str,
            false,
            &dir.path().join("staging"),
            |_, _| panic!("local destinations must not use write_virtual"),
        )
        .expect("local export");
        assert_eq!(path, dest.display().to_string());
        assert_eq!(std::fs::read(&dest).unwrap(), b"PK");
        assert!(!dir.path().join("staging").exists());
    }

    #[test]
    fn tap_detail_roundtrip() {
        let detail = encode_tap_source_detail(
            "https://codeload.github.com/foo/bar/zip/refs/heads/main",
            "skills/pdf-tools",
        );
        let (url, subdir) = decode_tap_source_detail(&detail).unwrap();
        assert_eq!(
            url,
            "https://codeload.github.com/foo/bar/zip/refs/heads/main"
        );
        assert_eq!(subdir, "skills/pdf-tools");
    }
}
