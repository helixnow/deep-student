//! Chat V2 - Skills 文件系统处理器
//!
//! 提供 Tauri 命令用于前端加载、创建、更新和删除 SKILL.md 文件
//!
//! ## 安全说明
//!
//! 所有文件操作都经过路径验证，确保只能访问允许的 skills 目录：
//! - `~/.cursor/skills-cursor/` (Cursor skills)
//! - `~/.deep-student/skills/` (Deep Student skills)
//! - 系统数据目录下的 skills 文件夹

use serde::{Deserialize, Serialize};
use std::fs as std_fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use tauri::Manager;
use tokio::fs;
use tracing::{debug, info, warn};

use super::error::{ChatV2Error, ChatV2Result};

/// 获取 Tauri app_data_dir
///
/// 通过全局 AppHandle 获取 Tauri 的 app_data_dir，
/// 在 Android/iOS 上作为 `dirs::home_dir()` 的替代（后者在移动端不可靠）。
fn get_tauri_app_data_dir() -> Option<PathBuf> {
    crate::get_global_app_handle().and_then(|handle| handle.path().app_data_dir().ok())
}

/// 跨平台获取"家目录"路径
///
/// - 桌面端 (Windows/macOS/Linux): 使用 `dirs::home_dir()`
/// - 移动端 (Android/iOS): 使用 Tauri `app_data_dir`
///   （Android 上 `dirs::home_dir()` 可能返回 `None` 或不可写路径如 `/`）
fn resolve_home_dir() -> Option<PathBuf> {
    if cfg!(any(target_os = "android", target_os = "ios")) {
        get_tauri_app_data_dir()
    } else {
        dirs::home_dir()
    }
}

// ============================================================================
// 返回类型
// ============================================================================

/// Skill 目录项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillDirectoryEntry {
    /// 目录名（即 skill ID）
    pub name: String,
    /// 完整路径
    pub path: String,
}

/// Skill 文件内容
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillFileContent {
    /// 文件内容
    pub content: String,
    /// 文件路径
    pub path: String,
}

/// Skill package file entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillPackageFileEntry {
    /// Path relative to package root, using forward slashes.
    pub path: String,
    /// File size in bytes.
    pub size: u64,
}

// ============================================================================
// 路径安全验证
// ============================================================================

/// 获取允许的 skills 基础目录列表
pub(crate) fn get_allowed_skills_bases() -> Vec<PathBuf> {
    let mut bases = Vec::new();

    if let Some(home) = resolve_home_dir() {
        bases.push(home.join(".cursor").join("skills-cursor"));
        bases.push(home.join(".deep-student").join("skills"));
        // 移动端 project skills 映射到 {app_data_dir}/.skills（loader.ts resolveDefaultProjectRootDir）
        if cfg!(any(target_os = "android", target_os = "ios")) {
            bases.push(home.join(".skills"));
        }
    }

    // 桌面端额外的系统数据目录（移动端 dirs::data_dir() 不可靠，已由 resolve_home_dir 覆盖）
    if !cfg!(any(target_os = "android", target_os = "ios")) {
        if let Some(data_dir) = dirs::data_dir() {
            bases.push(data_dir.join("ds91").join("skills"));
            bases.push(data_dir.join("deep-student").join("skills"));
        }
    }

    // 当前工作目录下的标准 Skill 目录（项目内，兼容 Agent Skills 开放标准）
    if let Ok(current_dir) = std::env::current_dir() {
        bases.push(current_dir.join(".skills"));
        bases.push(current_dir.join(".agents").join("skills"));
        bases.push(current_dir.join(".claude").join("skills"));
        bases.push(current_dir.join(".github").join("skills"));
    }

    bases
}

/// shell deny 规则使用的字面技能目录模式（不依赖绝对路径解析，
/// 覆盖 `~` / 相对写法与本机以外的 home 布局）。
const SKILLS_DIR_LITERAL_PATTERNS: &[&str] = &[
    ".deep-student/skills",
    ".claude/skills",
    ".agents/skills",
    ".github/skills",
    "skills-cursor",
];

/// 判断 shell 命令正文是否命中任何技能包基目录。
///
/// 用于 `local_shell_execute` / `local_shell_preflight` 的封侧门 deny 规则：
/// agent 不允许用 shell 直接读写技能目录，安装/修改技能必须走 `skill_install`
/// 工具或技能管理 UI（治理正门）。
///
/// 匹配策略（fail-closed 方向做宽匹配）：
/// - 不区分大小写；`\` 归一为 `/` 后做子串匹配。
/// - 同时检查 `get_allowed_skills_bases()` 的各绝对基目录与字面模式
///   （`.deep-student/skills`、`.claude/skills` 等），保证
///   `C:\Users\x\.deep-student\skills` 与 `~/.deep-student/skills` 两种写法都被拦。
pub(crate) fn command_mentions_skills_directory(command: &str) -> bool {
    let normalized = command.replace('\\', "/").to_lowercase();
    if normalized.is_empty() {
        return false;
    }

    if SKILLS_DIR_LITERAL_PATTERNS
        .iter()
        .any(|pattern| normalized.contains(pattern))
    {
        return true;
    }

    for base in get_allowed_skills_bases() {
        let base_normalized = base.to_string_lossy().replace('\\', "/").to_lowercase();
        // 过短的基目录（如根目录）不做子串匹配，避免误伤所有命令
        if base_normalized.len() < 4 {
            continue;
        }
        if normalized.contains(&base_normalized) {
            return true;
        }
    }

    false
}

/// 去除 Windows `canonicalize()` 产生的 verbatim 前缀（`\\?\C:\...` → `C:\...`）
///
/// P2 修复：`canonicalize()` 在 Windows 上返回 verbatim 前缀路径（组件为
/// `Prefix(VerbatimDisk)`），而 `normalize_path()` 保留普通前缀（`Prefix(Disk)`）。
/// `Path::starts_with` 按组件比较，`VerbatimDisk('C') != Disk('C')`，两种风格混用
/// 会导致"新安装目标（不存在 → 逻辑规范化）vs 已存在 base（→ canonicalize）"的
/// 前缀比较恒为 false，误拒合法安装。统一去除 verbatim 前缀后再比较。
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let s = path.as_os_str().to_string_lossy();
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", rest));
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return PathBuf::from(rest.to_string());
        }
        path
    }
    #[cfg(not(windows))]
    {
        path
    }
}

/// 规范化路径，移除 `.` 和 `..` 组件（不需要路径存在）
///
/// 这是一个纯逻辑操作，不访问文件系统
fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();

    for component in path.components() {
        match component {
            Component::ParentDir => {
                // 遇到 .. 时弹出上一级目录
                normalized.pop();
            }
            Component::CurDir => {
                // 忽略 . 组件
            }
            _ => {
                normalized.push(component);
            }
        }
    }

    normalized
}

/// 验证路径是否在允许的 skills 目录范围内
///
/// ## 安全机制
/// 1. 首先尝试使用 canonicalize() 获取真实路径（处理符号链接）
/// 2. 如果路径不存在，使用逻辑规范化防止 `..` 遍历攻击
/// 3. 检查规范化后的路径是否以允许的基础目录开头
///
/// ## 参数
/// - `path`: 要验证的路径（已展开 ~ 后）
///
/// ## 返回
/// - `Ok(())` 如果路径在允许范围内
/// - `Err(ChatV2Error::InvalidInput)` 如果检测到路径遍历
pub(crate) fn validate_skill_path(path: &Path) -> ChatV2Result<()> {
    let allowed_bases = get_allowed_skills_bases();

    if allowed_bases.is_empty() {
        return Err(ChatV2Error::IoError(
            "Cannot determine allowed skills directories".to_string(),
        ));
    }

    // 尝试获取规范化路径（统一去除 verbatim 前缀，与 normalize_path 口径一致）
    let canonical_path = if path.exists() {
        // 路径存在时使用 canonicalize（处理符号链接）
        strip_verbatim_prefix(path.canonicalize().map_err(|e| {
            ChatV2Error::IoError(format!("Failed to canonicalize path {:?}: {}", path, e))
        })?)
    } else {
        // 路径不存在时使用逻辑规范化
        // 先将相对路径转为绝对路径
        let absolute = if path.is_absolute() {
            path.to_path_buf()
        } else {
            std::env::current_dir()
                .map_err(|e| ChatV2Error::IoError(format!("Failed to get current dir: {}", e)))?
                .join(path)
        };
        normalize_path(&absolute)
    };

    // 检查是否在任一允许的基础目录下
    for base in &allowed_bases {
        // 对基础目录也进行规范化（统一去除 verbatim 前缀）
        let canonical_base = if base.exists() {
            match base.canonicalize() {
                Ok(p) => strip_verbatim_prefix(p),
                Err(_) => continue, // 基础目录不存在则跳过
            }
        } else {
            normalize_path(base)
        };

        if canonical_path.starts_with(&canonical_base) {
            debug!(
                "[Skills] 路径验证通过: {:?} 在 {:?} 下",
                canonical_path, canonical_base
            );
            return Ok(());
        }
    }

    // 路径不在任何允许的目录下
    warn!("[Skills] 路径遍历检测: {:?} 不在允许的目录范围内", path);
    Err(ChatV2Error::InvalidInput(format!(
        "Path traversal detected: {:?} is not within allowed skills directories. \
         Allowed bases: {:?}",
        path, allowed_bases
    )))
}

// ============================================================================
// 辅助函数
// ============================================================================

/// 展开路径中的 ~ 为用户目录
///
/// 使用 `resolve_home_dir()` 跨平台获取家目录：
/// - 桌面端: `dirs::home_dir()`
/// - 移动端: Tauri `app_data_dir()`
pub(crate) fn expand_path(path: &str) -> PathBuf {
    if path == "~" {
        return resolve_home_dir().unwrap_or_else(|| PathBuf::from(path));
    }

    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = resolve_home_dir() {
            return home.join(stripped);
        }
    }

    PathBuf::from(path)
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// 列出 skills 目录中的子目录
///
/// ## 参数
/// - `path`: 目录路径（支持 ~ 展开）
///
/// ## 返回
/// - 目录项列表
///
/// ## 安全
/// - 验证路径在允许的 skills 目录范围内
#[tauri::command]
pub async fn skill_list_directories(path: String) -> ChatV2Result<Vec<SkillDirectoryEntry>> {
    let expanded_path = expand_path(&path);
    debug!("[Skills] 列出目录: {:?}", expanded_path);

    // 🔒 安全验证：确保路径在允许的 skills 目录内
    validate_skill_path(&expanded_path)?;

    // 检查目录是否存在
    if !expanded_path.exists() {
        debug!("[Skills] 目录不存在: {:?}", expanded_path);
        return Ok(Vec::new());
    }

    if !expanded_path.is_dir() {
        warn!("[Skills] 路径不是目录: {:?}", expanded_path);
        return Err(ChatV2Error::InvalidInput(format!(
            "Path is not a directory: {:?}",
            expanded_path
        )));
    }

    // 读取目录内容
    let mut entries = Vec::new();
    let mut dir = fs::read_dir(&expanded_path).await.map_err(|e| {
        ChatV2Error::IoError(format!(
            "Failed to read directory {:?}: {}",
            expanded_path, e
        ))
    })?;

    while let Some(entry) = dir
        .next_entry()
        .await
        .map_err(|e| ChatV2Error::IoError(format!("Failed to read directory entry: {}", e)))?
    {
        let entry_path = entry.path();

        // 只处理目录
        if entry_path.is_dir() {
            if let Some(name) = entry_path.file_name() {
                if let Some(name_str) = name.to_str() {
                    // 跳过隐藏目录
                    if name_str.starts_with('.') {
                        continue;
                    }

                    entries.push(SkillDirectoryEntry {
                        name: name_str.to_string(),
                        path: entry_path.to_string_lossy().to_string(),
                    });
                }
            }
        }
    }

    info!("[Skills] 发现 {} 个子目录", entries.len());
    Ok(entries)
}

/// 读取 skill 文件内容
///
/// ## 参数
/// - `path`: 文件路径（支持 ~ 展开）
///
/// ## 返回
/// - 文件内容和路径
///
/// ## 安全
/// - 验证路径在允许的 skills 目录范围内，防止路径遍历攻击
const MAX_PACKAGE_FILES: usize = 200;
const MAX_PACKAGE_DEPTH: usize = 4;

fn should_skip_package_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return true;
    };
    name.starts_with('.') || matches!(name, "node_modules" | "target" | "dist" | "build")
}

fn relative_package_path(root: &Path, path: &Path) -> Option<String> {
    let relative = path.strip_prefix(root).ok()?;
    let value = relative.to_string_lossy().replace('\\', "/");
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn collect_package_files(
    root: &Path,
    current: &Path,
    depth: usize,
    entries: &mut Vec<SkillPackageFileEntry>,
) -> ChatV2Result<()> {
    if entries.len() >= MAX_PACKAGE_FILES || depth > MAX_PACKAGE_DEPTH {
        return Ok(());
    }

    let read_dir = std_fs::read_dir(current).map_err(|e| {
        ChatV2Error::IoError(format!("Failed to read package directory {:?}: {}", current, e))
    })?;

    for entry in read_dir {
        if entries.len() >= MAX_PACKAGE_FILES {
            break;
        }

        let entry = entry.map_err(|e| {
            ChatV2Error::IoError(format!("Failed to read package directory entry: {}", e))
        })?;
        let path = entry.path();
        let file_type = entry.file_type().map_err(|e| {
            ChatV2Error::IoError(format!("Failed to read package file type {:?}: {}", path, e))
        })?;

        if file_type.is_symlink() {
            continue;
        }

        if file_type.is_dir() {
            if !should_skip_package_dir(&path) {
                collect_package_files(root, &path, depth + 1, entries)?;
            }
            continue;
        }

        if !file_type.is_file() {
            continue;
        }

        let Some(relative_path) = relative_package_path(root, &path) else {
            continue;
        };
        let size = entry.metadata().map(|metadata| metadata.len()).unwrap_or(0);
        entries.push(SkillPackageFileEntry {
            path: relative_path,
            size,
        });
    }

    Ok(())
}

/// Canonicalize and validate a skill package root for local runtime reads.
///
/// This is intentionally stricter than generic skill path validation: callers
/// must point at an existing directory that contains SKILL.md.
pub(crate) fn canonicalize_skill_package_root(raw_path: &str) -> ChatV2Result<PathBuf> {
    let expanded_path = expand_path(raw_path);
    validate_skill_path(&expanded_path)?;

    if !expanded_path.exists() {
        return Err(ChatV2Error::ResourceNotFound(format!(
            "Skill package root not found: {:?}",
            expanded_path
        )));
    }

    if !expanded_path.is_dir() {
        return Err(ChatV2Error::InvalidInput(format!(
            "Skill package root is not a directory: {:?}",
            expanded_path
        )));
    }

    let skill_file = expanded_path.join("SKILL.md");
    if !skill_file.exists() {
        return Err(ChatV2Error::InvalidInput(format!(
            "Not a valid skill package directory (missing SKILL.md): {:?}",
            expanded_path
        )));
    }

    expanded_path.canonicalize().map_err(|e| {
        ChatV2Error::IoError(format!(
            "Failed to canonicalize skill package root {:?}: {}",
            expanded_path, e
        ))
    })
}

#[tauri::command]
pub async fn skill_list_package_files(path: String) -> ChatV2Result<Vec<SkillPackageFileEntry>> {
    let expanded_path = expand_path(&path);
    debug!("[Skills] list package files: {:?}", expanded_path);

    let package_root = match canonicalize_skill_package_root(&path) {
        Ok(path) => path,
        Err(ChatV2Error::ResourceNotFound(_)) => {
            return Ok(Vec::new());
        }
        Err(err) => return Err(err),
    };

    if !package_root.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    collect_package_files(&package_root, &package_root, 0, &mut entries)?;
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(entries)
}

/// Read a SKILL.md file after validating it is under an allowed skills path.
#[tauri::command]
pub async fn skill_read_file(path: String) -> ChatV2Result<SkillFileContent> {
    let expanded_path = expand_path(&path);
    debug!("[Skills] 读取文件: {:?}", expanded_path);

    // 🔒 安全验证：确保路径在允许的 skills 目录内
    validate_skill_path(&expanded_path)?;

    // 检查文件是否存在
    if !expanded_path.exists() {
        return Err(ChatV2Error::ResourceNotFound(format!(
            "File not found: {:?}",
            expanded_path
        )));
    }

    if !expanded_path.is_file() {
        return Err(ChatV2Error::InvalidInput(format!(
            "Path is not a file: {:?}",
            expanded_path
        )));
    }

    // 读取文件内容
    let content = fs::read_to_string(&expanded_path).await.map_err(|e| {
        ChatV2Error::IoError(format!("Failed to read file {:?}: {}", expanded_path, e))
    })?;

    Ok(SkillFileContent {
        content,
        path: expanded_path.to_string_lossy().to_string(),
    })
}

/// 创建新技能
///
/// ## 参数
/// - `base_path`: 基础目录路径（如 ~/.deep-student/skills）
/// - `skill_id`: 技能 ID（将作为目录名）
/// - `content`: SKILL.md 文件内容
///
/// ## 返回
/// - 创建的文件信息
///
/// ## 安全
/// - 验证基础路径在允许的 skills 目录范围内
/// - 验证 skill_id 只包含安全字符
#[tauri::command]
pub async fn skill_create(
    base_path: String,
    skill_id: String,
    content: String,
) -> ChatV2Result<SkillFileContent> {
    // 验证 skill_id 格式（只允许字母、数字、连字符、下划线）
    if !skill_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err(ChatV2Error::InvalidInput(
            "Skill ID can only contain letters, numbers, hyphens, and underscores".to_string(),
        ));
    }

    if skill_id.is_empty() {
        return Err(ChatV2Error::InvalidInput(
            "Skill ID cannot be empty".to_string(),
        ));
    }

    let expanded_base = expand_path(&base_path);
    let skill_dir = expanded_base.join(&skill_id);
    let skill_file = skill_dir.join("SKILL.md");

    debug!("[Skills] 创建技能: {} -> {:?}", skill_id, skill_file);

    // 🔒 安全验证：确保目标路径在允许的 skills 目录内
    // 验证最终文件路径（包含 skill_id）以防止任何遍历尝试
    validate_skill_path(&skill_file)?;

    // 检查目录是否已存在
    if skill_dir.exists() {
        return Err(ChatV2Error::InvalidInput(format!(
            "Skill directory already exists: {:?}",
            skill_dir
        )));
    }

    // 确保基础目录存在
    if !expanded_base.exists() {
        fs::create_dir_all(&expanded_base).await.map_err(|e| {
            ChatV2Error::IoError(format!(
                "Failed to create base directory {:?}: {}",
                expanded_base, e
            ))
        })?;
    }

    // 创建技能目录
    fs::create_dir(&skill_dir).await.map_err(|e| {
        ChatV2Error::IoError(format!(
            "Failed to create skill directory {:?}: {}",
            skill_dir, e
        ))
    })?;

    // 写入 SKILL.md 文件
    fs::write(&skill_file, &content).await.map_err(|e| {
        ChatV2Error::IoError(format!(
            "Failed to write skill file {:?}: {}",
            skill_file, e
        ))
    })?;

    info!("[Skills] 技能创建成功: {}", skill_id);

    Ok(SkillFileContent {
        content,
        path: skill_file.to_string_lossy().to_string(),
    })
}

/// 更新技能文件
///
/// ## 参数
/// - `path`: SKILL.md 文件完整路径
/// - `content`: 新的文件内容
///
/// ## 返回
/// - 更新后的文件信息
///
/// ## 安全
/// - 验证路径在允许的 skills 目录范围内，防止路径遍历攻击
#[tauri::command]
pub async fn skill_update(path: String, content: String) -> ChatV2Result<SkillFileContent> {
    let expanded_path = expand_path(&path);
    debug!("[Skills] 更新文件: {:?}", expanded_path);

    // 🔒 安全验证：确保路径在允许的 skills 目录内
    validate_skill_path(&expanded_path)?;

    // 检查文件是否存在
    if !expanded_path.exists() {
        return Err(ChatV2Error::ResourceNotFound(format!(
            "File not found: {:?}",
            expanded_path
        )));
    }

    if !expanded_path.is_file() {
        return Err(ChatV2Error::InvalidInput(format!(
            "Path is not a file: {:?}",
            expanded_path
        )));
    }

    // 写入新内容
    fs::write(&expanded_path, &content).await.map_err(|e| {
        ChatV2Error::IoError(format!("Failed to write file {:?}: {}", expanded_path, e))
    })?;

    info!("[Skills] 文件更新成功: {:?}", expanded_path);

    Ok(SkillFileContent {
        content,
        path: expanded_path.to_string_lossy().to_string(),
    })
}

/// 删除技能目录
///
/// ## 参数
/// - `path`: 技能目录路径
///
/// ## 返回
/// - 成功则返回 ()
///
/// ## 安全
/// - 验证路径在允许的 skills 目录范围内，防止路径遍历攻击
/// - 额外检查目录中必须有 SKILL.md 文件
#[tauri::command]
pub async fn skill_delete(path: String) -> ChatV2Result<()> {
    let expanded_path = expand_path(&path);
    debug!("[Skills] 删除目录: {:?}", expanded_path);

    // 🔒 安全验证：确保路径在允许的 skills 目录内
    validate_skill_path(&expanded_path)?;

    // 检查目录是否存在
    if !expanded_path.exists() {
        return Err(ChatV2Error::ResourceNotFound(format!(
            "Directory not found: {:?}",
            expanded_path
        )));
    }

    if !expanded_path.is_dir() {
        return Err(ChatV2Error::InvalidInput(format!(
            "Path is not a directory: {:?}",
            expanded_path
        )));
    }

    // 安全检查：确保目录中有 SKILL.md 文件（防止误删其他目录）
    let skill_file = expanded_path.join("SKILL.md");
    if !skill_file.exists() {
        return Err(ChatV2Error::InvalidInput(format!(
            "Not a valid skill directory (missing SKILL.md): {:?}",
            expanded_path
        )));
    }

    // 删除目录及其内容
    fs::remove_dir_all(&expanded_path).await.map_err(|e| {
        ChatV2Error::IoError(format!(
            "Failed to delete directory {:?}: {}",
            expanded_path, e
        ))
    })?;

    info!("[Skills] 目录删除成功: {:?}", expanded_path);

    Ok(())
}

/// Zip 技能包导入结果（装前扫描摘要）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkillImportZipResult {
    pub skill_id: String,
    pub path: String,
    pub files_extracted: usize,
    pub scripts_count: usize,
    pub references_count: usize,
    pub allowed_tools_count: usize,
    /// zip 包文件本体的 SHA-256，供审计与后续信任链使用
    pub package_sha256: String,
    /// 启发式风险分级："low" | "medium" | "high"（只提示不拦截）
    pub risk_level: String,
    /// machine-readable 风险信号 key（如 "shell_tools"、"binary_files"）
    pub risk_signals: Vec<String>,
    /// 运行时依赖探测结果（requires.bins/env），可选以保持向后兼容
    #[serde(skip_serializing_if = "Option::is_none")]
    pub requires: Option<crate::chat_v2::skill_requires::SkillRequiresProbe>,
}

fn is_safe_zip_entry(name: &str) -> bool {
    let normalized = name.replace('\\', "/");
    if normalized.is_empty() || normalized.starts_with('/') {
        return false;
    }
    if normalized.split('/').any(|part| part == "..") {
        return false;
    }
    for part in normalized.split('/') {
        if matches!(part, "node_modules" | ".git" | "target" | "dist" | "build") {
            return false;
        }
    }
    true
}

fn zip_skill_prefix(entry_names: &[String]) -> Option<(String, String)> {
    for name in entry_names {
        let norm = name.replace('\\', "/");
        if norm.eq_ignore_ascii_case("SKILL.md") {
            return Some(("".to_string(), "imported-skill".to_string()));
        }
        if norm.ends_with("/SKILL.md") {
            let parts: Vec<&str> = norm.split('/').filter(|p| !p.is_empty()).collect();
            if parts.len() >= 2 {
                let skill_id = parts[parts.len() - 2].to_string();
                let prefix = format!("{}/", parts[..parts.len() - 1].join("/"));
                return Some((prefix, skill_id));
            }
        }
    }
    None
}

fn count_yaml_list_items(content: &str, key: &str) -> usize {
    let mut in_block = false;
    let mut count = 0;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with(&format!("{}:", key)) || trimmed.starts_with(&format!("{} ", key)) {
            in_block = true;
            continue;
        }
        if in_block {
            if trimmed.starts_with("- ") {
                count += 1;
            } else if !trimmed.is_empty() && !trimmed.starts_with('#') && !trimmed.starts_with('-') {
                break;
            }
        }
    }
    count
}

// ============================================================================
// 装前风险分级（本地启发式，只提示不拦截；拦截由 allowedTools fail-closed 与运行时审批承担）
// ============================================================================

/// 可执行/库类二进制扩展名 → "binary_files" 信号
const RISK_BINARY_EXTENSIONS: &[&str] = &[
    "exe", "dll", "so", "dylib", "node", "bin", "com", "msi", "scr", "jar", "wasm",
];

/// 常见媒体/字体扩展名：内容含 NUL 字节也不算 "binary_files"（非可执行载体）
const RISK_MEDIA_EXTENSIONS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "svg", "pdf", "woff", "woff2", "ttf", "otf",
    "eot", "mp3", "mp4", "wav", "avif",
];

/// scripts/ 下的可执行脚本扩展名 → "executable_scripts" 信号
const RISK_SCRIPT_EXTENSIONS: &[&str] = &["ps1", "sh", "bat", "cmd", "py", "js"];

/// SKILL.md（frontmatter + 正文）中的 shell 类关键字 → "shell_tools" 信号
const RISK_SHELL_KEYWORDS: &[&str] = &["shell", "execute_command", "local_shell"];

/// SKILL.md 中的网络类工具关键字 → "network_tools" 信号
const RISK_NETWORK_KEYWORDS: &[&str] = &["fetch", "curl", "wget", "http_request", "web_search"];

/// 任意文本文件中的凭据类关键字 → "credential_keywords" 信号
const RISK_CREDENTIAL_KEYWORDS: &[&str] = &["token", "secret", "password", "api_key", "credential"];

fn risk_file_extension(normalized_lower: &str) -> &str {
    let file_name = normalized_lower.rsplit('/').next().unwrap_or(normalized_lower);
    match file_name.rsplit_once('.') {
        Some((stem, ext)) if !stem.is_empty() => ext,
        _ => "",
    }
}

/// 对解压出的技能包文件做纯本地静态启发式扫描，返回 (risk_level, risk_signals)。
///
/// 分级规则：
/// - binary_files 或 credential_keywords 或 (shell_tools + network_tools 同时) → "high"
/// - shell_tools / network_tools / executable_scripts / external_urls 任一 → "medium"
/// - 否则 → "low"
fn assess_skill_package_risk(files: &[(String, Vec<u8>)]) -> (String, Vec<String>) {
    let mut shell_tools = false;
    let mut network_tools = false;
    let mut executable_scripts = false;
    let mut external_urls = false;
    let mut credential_keywords = false;
    let mut binary_files = false;

    for (relative, bytes) in files {
        let norm = relative.replace('\\', "/").to_lowercase();
        let ext = risk_file_extension(&norm);

        if RISK_BINARY_EXTENSIONS.contains(&ext) {
            binary_files = true;
            continue;
        }
        if bytes.contains(&0u8) {
            // 含 NUL 字节视为二进制；媒体/字体类载体不计入信号
            if !RISK_MEDIA_EXTENSIONS.contains(&ext) {
                binary_files = true;
            }
            continue;
        }

        if norm.starts_with("scripts/") && RISK_SCRIPT_EXTENSIONS.contains(&ext) {
            executable_scripts = true;
        }

        let text = String::from_utf8_lossy(bytes).to_lowercase();
        if text.contains("http://") || text.contains("https://") {
            external_urls = true;
        }
        if RISK_CREDENTIAL_KEYWORDS.iter().any(|k| text.contains(k)) {
            credential_keywords = true;
        }
        // shell / network 信号只看 SKILL.md（frontmatter + 正文）
        if norm == "skill.md" {
            if RISK_SHELL_KEYWORDS.iter().any(|k| text.contains(k)) {
                shell_tools = true;
            }
            if RISK_NETWORK_KEYWORDS.iter().any(|k| text.contains(k)) {
                network_tools = true;
            }
        }
    }

    let mut signals = Vec::new();
    if shell_tools {
        signals.push("shell_tools".to_string());
    }
    if network_tools {
        signals.push("network_tools".to_string());
    }
    if executable_scripts {
        signals.push("executable_scripts".to_string());
    }
    if external_urls {
        signals.push("external_urls".to_string());
    }
    if credential_keywords {
        signals.push("credential_keywords".to_string());
    }
    if binary_files {
        signals.push("binary_files".to_string());
    }

    let level = if binary_files || credential_keywords || (shell_tools && network_tools) {
        "high"
    } else if shell_tools || network_tools || executable_scripts || external_urls {
        "medium"
    } else {
        "low"
    };

    (level.to_string(), signals)
}

/// zip 扫描阶段（spawn_blocking 闭包）的产出
struct ZipScanOutcome {
    skill_id: String,
    files: Vec<(String, Vec<u8>)>,
    package_sha256: String,
    risk_level: String,
    risk_signals: Vec<String>,
}

/// agent 自装技能的默认安装基目录（`skill_install` executor 使用）。
pub(crate) const DEFAULT_AGENT_SKILLS_BASE: &str = "~/.deep-student/skills";

/// 技能包 zip 本体（压缩态字节）的大小上限，与解压总量限额一致。
pub(crate) const MAX_SKILL_PACKAGE_ZIP_BYTES: u64 = 64 * 1024 * 1024;

/// 对 zip 字节做扫描：sha256 + 解压到内存（三重限额 + 路径校验）+ 风险分级。
///
/// 这是 `skill_import_zip` 与 `skill_install` 共用的只读扫描内核，不写盘。
fn scan_skill_zip_bytes(zip_bytes: &[u8]) -> Result<ZipScanOutcome, String> {
    const MAX_ZIP_ENTRIES: usize = 2000;
    const MAX_ZIP_FILE_BYTES: u64 = 8 * 1024 * 1024;
    const MAX_ZIP_TOTAL_BYTES: u64 = 64 * 1024 * 1024;

    let package_sha256 = {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(zip_bytes);
        format!("{:x}", hasher.finalize())
    };

    let cursor = std::io::Cursor::new(zip_bytes);
    let mut archive = zip::ZipArchive::new(cursor).map_err(|e| format!("Invalid zip: {}", e))?;

    if archive.len() > MAX_ZIP_ENTRIES {
        return Err(format!(
            "Zip contains too many entries ({} > {})",
            archive.len(),
            MAX_ZIP_ENTRIES
        ));
    }

    let mut entry_names = Vec::new();
    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| format!("Zip read error: {}", e))?;
        entry_names.push(file.name().to_string());
    }

    let (prefix, skill_id) = zip_skill_prefix(&entry_names)
        .ok_or_else(|| "Zip must contain a SKILL.md (at root or in a skill folder)".to_string())?;

    if !skill_id
        .chars()
        .all(|c| c.is_alphanumeric() || c == '-' || c == '_')
    {
        return Err("Skill folder name contains invalid characters".to_string());
    }

    let mut extracted: Vec<(String, Vec<u8>)> = Vec::new();
    let mut total_bytes: u64 = 0;
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Zip read error: {}", e))?;
        if file.is_dir() || file.name().ends_with('/') {
            continue;
        }
        let raw_name = file.name().to_string();
        if !is_safe_zip_entry(&raw_name) {
            continue;
        }
        // 防 zip bomb：按声明的解压后大小限制单文件和总量
        if file.size() > MAX_ZIP_FILE_BYTES {
            return Err(format!(
                "Zip entry too large: {} ({} bytes > {} bytes)",
                raw_name,
                file.size(),
                MAX_ZIP_FILE_BYTES
            ));
        }
        total_bytes = total_bytes.saturating_add(file.size());
        if total_bytes > MAX_ZIP_TOTAL_BYTES {
            return Err(format!(
                "Zip uncompressed size exceeds limit ({} bytes)",
                MAX_ZIP_TOTAL_BYTES
            ));
        }
        let norm = raw_name.replace('\\', "/");
        let relative = if prefix.is_empty() {
            norm
        } else if let Some(stripped) = norm.strip_prefix(&prefix) {
            stripped.to_string()
        } else {
            continue;
        };
        if relative.is_empty() || relative.contains("..") {
            continue;
        }
        let mut buf = Vec::new();
        // take() 上限防止 zip 头声明大小与实际解压量不符
        let mut limited = file.take(MAX_ZIP_FILE_BYTES + 1);
        limited
            .read_to_end(&mut buf)
            .map_err(|e| format!("Failed to read zip entry: {}", e))?;
        if buf.len() as u64 > MAX_ZIP_FILE_BYTES {
            return Err(format!(
                "Zip entry decompressed larger than declared: {}",
                raw_name
            ));
        }
        extracted.push((relative, buf));
    }

    if extracted.is_empty() {
        return Err("No extractable files found in zip".to_string());
    }

    let (risk_level, risk_signals) = assess_skill_package_risk(&extracted);

    Ok(ZipScanOutcome {
        skill_id,
        files: extracted,
        package_sha256,
        risk_level,
        risk_signals,
    })
}

/// 从 zip 字节安装（或 dry_run 扫描）技能包到指定 base 目录。
///
/// `skill_import_zip` Tauri command 与 `skill_install` agent executor 共用的
/// 完整内核：读 zip 字节 → sha256 → 解压扫描（限额 + 路径校验）→ 风险分级 →
/// （非 dry_run 时）写盘安装。行为与原 `skill_import_zip` 内联实现一致。
///
/// 安全：拒绝路径遍历、隐藏目录、符号链接式路径；只解压到新建的 skill 子目录；
/// zip 本体超过 `MAX_SKILL_PACKAGE_ZIP_BYTES` 直接拒绝。
pub(crate) async fn install_skill_package_from_zip_bytes(
    zip_bytes: Vec<u8>,
    base_path: &str,
    overwrite: bool,
    dry_run: bool,
) -> ChatV2Result<SkillImportZipResult> {
    if zip_bytes.is_empty() {
        return Err(ChatV2Error::InvalidInput(
            "Skill package is empty".to_string(),
        ));
    }
    if zip_bytes.len() as u64 > MAX_SKILL_PACKAGE_ZIP_BYTES {
        return Err(ChatV2Error::InvalidInput(format!(
            "Skill package too large ({} bytes > {} bytes)",
            zip_bytes.len(),
            MAX_SKILL_PACKAGE_ZIP_BYTES
        )));
    }

    let expanded_base = expand_path(base_path);
    validate_skill_path(&expanded_base)?;

    let scan = tokio::task::spawn_blocking(move || scan_skill_zip_bytes(&zip_bytes))
        .await
        .map_err(|e| ChatV2Error::IoError(format!("Zip import task failed: {}", e)))?
        .map_err(ChatV2Error::InvalidInput)?;

    let ZipScanOutcome {
        skill_id,
        files,
        package_sha256,
        risk_level,
        risk_signals,
    } = scan;
    let skill_dir = expanded_base.join(&skill_id);
    let skill_file = skill_dir.join("SKILL.md");

    validate_skill_path(&skill_file)?;

    // 装前扫描计数（dry_run 与实际安装共用，不依赖写盘）
    let mut scripts_count = 0usize;
    let mut references_count = 0usize;
    let mut skill_md_content = String::new();
    for (relative, bytes) in &files {
        let lower = relative.replace('\\', "/").to_lowercase();
        if lower.starts_with("scripts/") {
            scripts_count += 1;
        }
        if lower.starts_with("references/") {
            references_count += 1;
        }
        if lower == "skill.md" {
            skill_md_content = String::from_utf8_lossy(bytes).to_string();
        }
    }
    let allowed_tools_count = if skill_md_content.is_empty() {
        0
    } else {
        count_yaml_list_items(&skill_md_content, "allowed-tools")
            + count_yaml_list_items(&skill_md_content, "allowedTools")
    };

    let requires = if skill_md_content.is_empty() {
        None
    } else {
        let declared =
            crate::chat_v2::skill_requires::parse_requires_from_skill_md(&skill_md_content);
        Some(
            crate::chat_v2::skill_requires::probe_requires(declared)
                .await,
        )
    };

    // 扫描先行：dry_run 只返回扫描结果（含风险分级），不写盘、不删已有目录
    if dry_run {
        info!(
            "[Skills] Zip dry-run scan complete: {} files, risk={} (sha256={})",
            files.len(),
            risk_level,
            package_sha256
        );
        return Ok(SkillImportZipResult {
            skill_id,
            path: skill_dir.to_string_lossy().to_string(),
            files_extracted: files.len(),
            scripts_count,
            references_count,
            allowed_tools_count,
            package_sha256,
            risk_level,
            risk_signals,
            requires,
        });
    }

    if skill_dir.exists() && !overwrite {
        return Err(ChatV2Error::InvalidInput(format!(
            "Skill directory already exists: {:?}. Pass overwrite=true to replace.",
            skill_dir
        )));
    }

    if skill_dir.exists() {
        fs::remove_dir_all(&skill_dir).await.map_err(|e| {
            ChatV2Error::IoError(format!("Failed to remove existing skill dir: {}", e))
        })?;
    }

    if !expanded_base.exists() {
        fs::create_dir_all(&expanded_base).await.map_err(|e| {
            ChatV2Error::IoError(format!("Failed to create base directory: {}", e))
        })?;
    }

    fs::create_dir(&skill_dir).await.map_err(|e| {
        ChatV2Error::IoError(format!("Failed to create skill directory: {}", e))
    })?;

    for (relative, bytes) in &files {
        let target = skill_dir.join(relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).await.map_err(|e| {
                ChatV2Error::IoError(format!("Failed to create parent dir: {}", e))
            })?;
        }
        validate_skill_path(&target)?;
        fs::write(&target, bytes).await.map_err(|e| {
            ChatV2Error::IoError(format!("Failed to write {:?}: {}", target, e))
        })?;
    }

    info!(
        "[Skills] Zip import complete: {} files -> {:?} (risk={}, sha256={})",
        files.len(),
        skill_dir,
        risk_level,
        package_sha256
    );

    Ok(SkillImportZipResult {
        skill_id,
        path: skill_dir.to_string_lossy().to_string(),
        files_extracted: files.len(),
        scripts_count,
        references_count,
        allowed_tools_count,
        package_sha256,
        risk_level,
        risk_signals,
        requires,
    })
}

/// 从 zip 包导入 Skill 到指定 base 目录（默认 ~/.deep-student/skills）。
///
/// 安全：拒绝路径遍历、隐藏目录、符号链接式路径；只解压到新建的 skill 子目录。
/// `dry_run=true` 时只扫描（含风险分级），不写盘、不删除已有目录，
/// `path` 返回预计安装路径；省略该参数等价于 false，向后兼容。
///
/// 内核逻辑已抽为 [`install_skill_package_from_zip_bytes`]，与 agent 侧的
/// `skill_install` executor 共用；本 command 只负责把 zip 文件读为字节。
#[tauri::command]
pub async fn skill_import_zip(
    zip_path: String,
    base_path: String,
    overwrite: bool,
    dry_run: Option<bool>,
) -> ChatV2Result<SkillImportZipResult> {
    let dry_run = dry_run.unwrap_or(false);
    let expanded_zip = expand_path(&zip_path);
    if !expanded_zip.is_file() {
        return Err(ChatV2Error::InvalidInput(format!(
            "Zip file not found: {:?}",
            expanded_zip
        )));
    }

    let metadata = fs::metadata(&expanded_zip).await.map_err(|e| {
        ChatV2Error::IoError(format!("Failed to inspect zip {:?}: {}", expanded_zip, e))
    })?;
    if metadata.len() > MAX_SKILL_PACKAGE_ZIP_BYTES {
        return Err(ChatV2Error::InvalidInput(format!(
            "Zip file too large ({} bytes > {} bytes)",
            metadata.len(),
            MAX_SKILL_PACKAGE_ZIP_BYTES
        )));
    }

    let zip_bytes = fs::read(&expanded_zip).await.map_err(|e| {
        ChatV2Error::IoError(format!("Failed to read zip {:?}: {}", expanded_zip, e))
    })?;

    install_skill_package_from_zip_bytes(zip_bytes, &base_path, overwrite, dry_run).await
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn text_file(path: &str, content: &str) -> (String, Vec<u8>) {
        (path.to_string(), content.as_bytes().to_vec())
    }

    #[test]
    fn risk_low_for_plain_document_package() {
        let files = vec![
            text_file("SKILL.md", "---\nname: demo\n---\n一份纯文档写作技巧说明。"),
            text_file("references/guide.md", "只包含离线引用内容，无任何链接。"),
        ];
        let (level, signals) = assess_skill_package_risk(&files);
        assert_eq!(level, "low");
        assert!(signals.is_empty(), "unexpected signals: {:?}", signals);
    }

    #[test]
    fn risk_medium_for_scripts_and_external_urls() {
        let files = vec![
            text_file("SKILL.md", "---\nname: demo\n---\n参见 https://example.com/manual 获取手册。"),
            text_file("scripts/run.py", "print('hello')"),
        ];
        let (level, signals) = assess_skill_package_risk(&files);
        assert_eq!(level, "medium");
        assert!(signals.contains(&"executable_scripts".to_string()));
        assert!(signals.contains(&"external_urls".to_string()));
        assert!(!signals.contains(&"binary_files".to_string()));
    }

    #[test]
    fn risk_high_for_shell_plus_network_tools() {
        let files = vec![text_file(
            "SKILL.md",
            "---\nallowed-tools:\n  - local_shell\n  - fetch\n---\n运行 curl 拉取数据后在本地处理。",
        )];
        let (level, signals) = assess_skill_package_risk(&files);
        assert_eq!(level, "high");
        assert!(signals.contains(&"shell_tools".to_string()));
        assert!(signals.contains(&"network_tools".to_string()));
    }

    #[test]
    fn risk_high_for_binary_files() {
        let files = vec![
            text_file("SKILL.md", "---\nname: demo\n---\n纯文档说明。"),
            ("bin/helper.exe".to_string(), vec![0x4D, 0x5A, 0x00, 0x01]),
        ];
        let (level, signals) = assess_skill_package_risk(&files);
        assert_eq!(level, "high");
        assert!(signals.contains(&"binary_files".to_string()));
    }

    #[test]
    fn risk_high_for_credential_keywords() {
        let files = vec![
            text_file("SKILL.md", "---\nname: demo\n---\n纯文档说明。"),
            text_file("references/setup.md", "请在环境变量中配置 api_key 后使用。"),
        ];
        let (level, signals) = assess_skill_package_risk(&files);
        assert_eq!(level, "high");
        assert!(signals.contains(&"credential_keywords".to_string()));
    }

    // ------------------------------------------------------------------
    // shell 封侧门：命令命中技能目录检测
    // ------------------------------------------------------------------

    #[test]
    fn skills_dir_deny_matches_windows_backslash_paths() {
        assert!(command_mentions_skills_directory(
            r"Copy-Item payload.zip C:\Users\x\.deep-student\skills\evil\"
        ));
        assert!(command_mentions_skills_directory(
            r"Set-Content C:\Users\x\.claude\skills\evil\SKILL.md bad"
        ));
        assert!(command_mentions_skills_directory(
            r"dir C:\Users\x\.cursor\skills-cursor"
        ));
    }

    #[test]
    fn skills_dir_deny_matches_forward_slash_and_tilde_paths() {
        assert!(command_mentions_skills_directory(
            "cp payload.zip ~/.deep-student/skills/evil/"
        ));
        assert!(command_mentions_skills_directory(
            "cat ./.agents/skills/foo/SKILL.md"
        ));
        assert!(command_mentions_skills_directory(
            "ls .github/skills"
        ));
    }

    #[test]
    fn skills_dir_deny_is_case_insensitive() {
        assert!(command_mentions_skills_directory(
            r"echo x > C:\USERS\X\.DEEP-STUDENT\SKILLS\a\SKILL.md"
        ));
    }

    #[test]
    fn skills_dir_deny_matches_resolved_allowed_bases() {
        // get_allowed_skills_bases 的绝对基目录形式（本机 home 展开后）也必须命中
        for base in get_allowed_skills_bases() {
            let base_str = base.to_string_lossy().to_string();
            if base_str.len() < 4 {
                continue;
            }
            let cmd = format!("Get-ChildItem \"{}\"", base_str);
            assert!(
                command_mentions_skills_directory(&cmd),
                "expected deny for base {:?}",
                base_str
            );
        }
    }

    #[test]
    fn skills_dir_deny_ignores_unrelated_commands() {
        assert!(!command_mentions_skills_directory("git status --short"));
        assert!(!command_mentions_skills_directory(
            "python scripts/convert.py --input data.xlsx"
        ));
        assert!(!command_mentions_skills_directory(""));
    }

    // ------------------------------------------------------------------
    // P2 回归：Windows verbatim 前缀统一（canonicalize vs normalize_path）
    // ------------------------------------------------------------------

    #[cfg(windows)]
    #[test]
    fn strip_verbatim_prefix_normalizes_disk_and_unc() {
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\C:\Users\x\.deep-student\skills")),
            PathBuf::from(r"C:\Users\x\.deep-student\skills")
        );
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"\\?\UNC\server\share\skills")),
            PathBuf::from(r"\\server\share\skills")
        );
        // 非 verbatim 路径保持不变
        assert_eq!(
            strip_verbatim_prefix(PathBuf::from(r"C:\Users\x")),
            PathBuf::from(r"C:\Users\x")
        );
    }

    /// 已存在的 base（canonicalize → 曾为 verbatim）与不存在的新建子路径
    /// （逻辑规范化 → 普通前缀）比较必须通过
    #[test]
    fn canonicalized_existing_base_matches_logical_child_path() {
        let base = std::env::temp_dir().join(format!("ds_skills_vp_test_{}", std::process::id()));
        std_fs::create_dir_all(&base).expect("create temp base");

        let canonical_base = strip_verbatim_prefix(base.canonicalize().expect("canonicalize base"));
        // 模拟 validate_skill_path 对"尚不存在的安装目标"的逻辑规范化
        let child = normalize_path(&canonical_base.join("new-skill").join("SKILL.md"));
        assert!(
            child.starts_with(&canonical_base),
            "child {:?} should start with base {:?}",
            child,
            canonical_base
        );

        let _ = std_fs::remove_dir_all(&base);
    }

    // ------------------------------------------------------------------
    // zip 字节内核：scan/install 分流 + overwrite 保护
    // ------------------------------------------------------------------

    fn build_test_zip(files: &[(&str, &str)]) -> Vec<u8> {
        use std::io::Write as _;
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut writer = zip::ZipWriter::new(&mut cursor);
            let options = zip::write::FileOptions::default();
            for (name, content) in files {
                writer.start_file(*name, options).expect("start zip entry");
                writer
                    .write_all(content.as_bytes())
                    .expect("write zip entry");
            }
            writer.finish().expect("finish zip");
        }
        cursor.into_inner()
    }

    #[tokio::test]
    async fn install_from_zip_bytes_rejects_empty_and_invalid_input() {
        let base = std::env::current_dir()
            .expect("current dir")
            .join(".skills");
        let base_str = base.to_string_lossy().to_string();

        assert!(
            install_skill_package_from_zip_bytes(Vec::new(), &base_str, false, true)
                .await
                .is_err(),
            "empty bytes must be rejected"
        );
        assert!(
            install_skill_package_from_zip_bytes(vec![1, 2, 3, 4], &base_str, false, true)
                .await
                .is_err(),
            "non-zip bytes must be rejected"
        );
    }

    #[tokio::test]
    async fn install_from_zip_bytes_scan_then_install_with_overwrite_guard() {
        let skill_id = format!("zipcore-test-{}", std::process::id());
        let zip_bytes = build_test_zip(&[
            (
                &format!("{}/SKILL.md", skill_id),
                "---\nname: zip core test\n---\n纯文档技能。",
            ),
            (
                &format!("{}/references/guide.md", skill_id),
                "离线参考内容。",
            ),
        ]);

        let base = std::env::current_dir()
            .expect("current dir")
            .join(".skills");
        let base_str = base.to_string_lossy().to_string();
        let skill_dir = base.join(&skill_id);
        let _ = std_fs::remove_dir_all(&skill_dir);

        // 1) scan（dry_run）：返回扫描结果，不写盘
        let scan = install_skill_package_from_zip_bytes(zip_bytes.clone(), &base_str, false, true)
            .await
            .expect("dry-run scan should succeed");
        assert_eq!(scan.skill_id, skill_id);
        assert_eq!(scan.files_extracted, 2);
        assert_eq!(scan.references_count, 1);
        assert_eq!(scan.risk_level, "low");
        assert_eq!(scan.package_sha256.len(), 64);
        assert!(
            !skill_dir.exists(),
            "dry-run scan must not write to disk"
        );

        // 2) install：写盘，SKILL.md 落地
        let installed =
            install_skill_package_from_zip_bytes(zip_bytes.clone(), &base_str, false, false)
                .await
                .expect("install should succeed");
        assert_eq!(installed.package_sha256, scan.package_sha256);
        assert!(skill_dir.join("SKILL.md").is_file());
        assert!(skill_dir.join("references").join("guide.md").is_file());

        // 3) 同名已存在且 overwrite=false → 拒绝
        let err = install_skill_package_from_zip_bytes(zip_bytes.clone(), &base_str, false, false)
            .await
            .expect_err("existing skill dir without overwrite must fail");
        assert!(err.to_string().contains("already exists"));

        // 4) overwrite=true → 允许替换
        install_skill_package_from_zip_bytes(zip_bytes, &base_str, true, false)
            .await
            .expect("overwrite install should succeed");
        assert!(skill_dir.join("SKILL.md").is_file());

        let _ = std_fs::remove_dir_all(&skill_dir);
    }
}
