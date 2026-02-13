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
use std::path::{Component, Path, PathBuf};
use tokio::fs;
use tracing::{debug, info, warn};

use super::error::{ChatV2Error, ChatV2Result};

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

// ============================================================================
// 路径安全验证
// ============================================================================

/// 获取允许的 skills 基础目录列表
fn get_allowed_skills_bases() -> Vec<PathBuf> {
    let mut bases = Vec::new();

    // 用户主目录下的 skills 目录
    if let Some(home) = dirs::home_dir() {
        // Cursor skills 目录
        bases.push(home.join(".cursor").join("skills-cursor"));
        // Deep Student skills 目录
        bases.push(home.join(".deep-student").join("skills"));
    }

    // 系统数据目录下的 skills
    if let Some(data_dir) = dirs::data_dir() {
        bases.push(data_dir.join("ds91").join("skills"));
        bases.push(data_dir.join("deep-student").join("skills"));
    }

    // 当前工作目录下的 .skills（项目内技能目录）
    if let Ok(current_dir) = std::env::current_dir() {
        bases.push(current_dir.join(".skills"));
    }

    bases
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
fn validate_skill_path(path: &Path) -> ChatV2Result<()> {
    let allowed_bases = get_allowed_skills_bases();

    if allowed_bases.is_empty() {
        return Err(ChatV2Error::IoError(
            "Cannot determine allowed skills directories".to_string(),
        ));
    }

    // 尝试获取规范化路径
    let canonical_path = if path.exists() {
        // 路径存在时使用 canonicalize（处理符号链接）
        path.canonicalize().map_err(|e| {
            ChatV2Error::IoError(format!("Failed to canonicalize path {:?}: {}", path, e))
        })?
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
        // 对基础目录也进行规范化
        let canonical_base = if base.exists() {
            match base.canonicalize() {
                Ok(p) => p,
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
fn expand_path(path: &str) -> PathBuf {
    if path == "~" {
        return dirs::home_dir().unwrap_or_else(|| PathBuf::from(path));
    }

    if let Some(stripped) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
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
