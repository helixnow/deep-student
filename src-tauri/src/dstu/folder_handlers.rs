//! DSTU 文件夹命令处理器
//!
//! 提供 DSTU 访达协议层的文件夹管理 Tauri 命令，包括：
//! - D1: 文件夹管理（create, get, rename, delete, move, set_expanded）
//! - D2: 内容管理（add_item, remove_item, move_item）
//! - D3: 查询（list, get_tree, get_items）
//! - D5: 排序（reorder, reorder_items）
//!
//! ## 设计原则
//! - 所有命令前缀 `dstu_folder_`
//! - 返回 `Result<T, String>` 格式
//! - 使用 `#[serde(rename_all = "camelCase")]`
//! - 异步命令使用 `tokio::task::spawn_blocking`
//!
//! ## 实现状态
//! - ✅ 命令签名已固定，符合契约 D
//! - ✅ 所有命令已接线到 VfsFolderRepo 真实实现

use std::sync::Arc;

use tauri::State;
use tracing::{error, info, warn};

use crate::vfs::{
    folder_errors, FolderResourcesResult, FolderTreeNode, VfsDatabase, VfsFolder, VfsFolderItem,
    VfsFolderRepo, MAX_FOLDER_TITLE_LENGTH, MAX_INJECT_RESOURCES,
};

// ============================================================================
// 参数验证辅助函数
// ============================================================================

/// 验证字符串是否包含控制字符或危险字符
fn contains_invalid_chars(s: &str) -> bool {
    s.chars().any(|c| {
        c.is_control() || c == '\0' // 拒绝所有控制字符包括NULL
    })
}

/// HIGH-R002修复: 检测Unicode全角和零宽字符绕过
fn contains_unicode_bypass_chars(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(
            c,
            '\u{FF0F}' |  // 全角斜杠 ／
            '\u{FF3C}' |  // 全角反斜杠 ＼
            '\u{2044}' |  // 分数斜杠 ⁄
            '\u{2215}' |  // 除法斜杠 ∕
            '\u{29F8}' |  // 大斜杠 ⧸
            '\u{200B}' |  // 零宽空格
            '\u{200C}' |  // 零宽非连接符
            '\u{200D}' |  // 零宽连接符
            '\u{FEFF}' // 零宽非断空格 (BOM)
        )
    })
}

/// 验证字符串长度和字符集
fn validate_string_input(s: &str, field_name: &str, max_len: usize) -> Result<(), String> {
    if contains_invalid_chars(s) {
        warn!(
            "[DSTU::folder_handlers] validate_string_input: {} contains invalid control characters",
            field_name
        );
        return Err(format!("{} 包含非法字符", field_name));
    }
    // HIGH-R002修复: 检测Unicode规范化绕过
    if contains_unicode_bypass_chars(s) {
        warn!(
            "[DSTU::folder_handlers] validate_string_input: {} contains Unicode bypass characters",
            field_name
        );
        return Err(format!("{} 包含非法Unicode字符", field_name));
    }
    // 验证路径分隔符（MEDIUM-009修复）
    if s.contains('/') || s.contains('\\') || s.contains("..") {
        warn!(
            "[DSTU::folder_handlers] validate_string_input: {} contains path separators",
            field_name
        );
        return Err(format!("{} 不能包含路径分隔符", field_name));
    }
    if s.len() > max_len {
        warn!(
            "[DSTU::folder_handlers] validate_string_input: {} exceeds max length {}",
            field_name, max_len
        );
        return Err(format!("{} 长度超过限制", field_name));
    }
    Ok(())
}

/// 验证颜色格式是否合法
fn is_valid_color(color_str: &str) -> bool {
    if color_str.is_empty() {
        return true; // 空字符串允许
    }

    // HIGH-R003修复: 确保颜色字符串只包含ASCII字符（防止全角十六进制绕过）
    if !color_str.is_ascii() {
        return false;
    }

    // 只允许 #RRGGBB 格式
    if color_str.len() == 7 && color_str.starts_with('#') {
        return color_str[1..].chars().all(|c| c.is_ascii_hexdigit());
    }

    // 或预定义颜色名称
    matches!(
        color_str,
        "red" | "blue" | "green" | "yellow" | "purple" | "orange" | "pink" | "gray" | "cyan"
    )
}

// ============================================================================
// D1: 文件夹管理命令
// ============================================================================

/// 创建文件夹
///
/// ## 参数
/// - `title`: 文件夹标题
/// - `parent_id`: 父文件夹 ID（可选，NULL 表示根级）
/// - `icon`: 图标标识（可选）
/// - `color`: 颜色标识（可选）
///
/// ## 返回
/// 新创建的文件夹
///
/// ## 约束
/// - 标题长度不超过 100 字符
/// - 深度不超过 10 层
/// - 文件夹数不超过 500 个
#[tauri::command]
pub async fn dstu_folder_create(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    title: String,
    parent_id: Option<String>,
    icon: Option<String>,
    color: Option<String>,
) -> Result<VfsFolder, String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_create: title={}, parent_id={:?}",
        title, parent_id
    );

    // 验证标题非空
    if title.trim().is_empty() {
        return Err("文件夹标题不能为空".to_string());
    }

    // 验证标题长度和字符集
    validate_string_input(&title, "文件夹标题", MAX_FOLDER_TITLE_LENGTH)?;

    // 验证icon（如果提供）
    if let Some(ref icon_str) = icon {
        validate_string_input(icon_str, "图标", 50)?;
    }

    // 验证color（如果提供）- CRITICAL-003修复
    if let Some(ref color_str) = color {
        if !is_valid_color(color_str) {
            warn!(
                "[DSTU::folder_handlers] dstu_folder_create: invalid color format: {}",
                color_str
            );
            return Err("颜色格式错误，请使用 #RRGGBB 格式或预定义颜色名称".to_string());
        }
    }

    // 特殊处理 "root" - 转换为 None（根级文件夹）
    let actual_parent_id = match parent_id.as_deref() {
        Some("root") | Some("") => None,
        _ => parent_id,
    };

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        let conn = match vfs_db.get_conn_safe() {
            Ok(c) => c,
            Err(e) => {
                error!(
                    "[DSTU::folder_handlers] dstu_folder_create: get_conn_safe FAILED - error={}",
                    e
                );
                return Err(e.to_string());
            }
        };

        // 创建文件夹对象
        let folder = VfsFolder::new(title, actual_parent_id, icon, color);

        // 使用 FolderRepo 创建文件夹（包含深度/数量检查）
        match VfsFolderRepo::create_folder_with_conn(&conn, &folder) {
            Ok(()) => {
                info!(
                    "[DSTU::folder_handlers] dstu_folder_create: SUCCESS - folder_id={}",
                    folder.id
                );
                Ok(folder)
            }
            Err(e) => {
                error!(
                    "[DSTU::folder_handlers] dstu_folder_create: FAILED - error={}",
                    e
                );
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 获取文件夹详情
///
/// ## 参数
/// - `folder_id`: 文件夹 ID
///
/// ## 返回
/// 文件夹详情，不存在时返回 None
#[tauri::command]
pub async fn dstu_folder_get(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_id: String,
) -> Result<Option<VfsFolder>, String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_get: folder_id={}",
        folder_id
    );

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(
        move || match VfsFolderRepo::get_folder(&vfs_db, &folder_id) {
            Ok(folder) => {
                info!(
                    "[DSTU::folder_handlers] dstu_folder_get: SUCCESS - folder_id={}, found={}",
                    folder_id,
                    folder.is_some()
                );
                Ok(folder)
            }
            Err(e) => {
                error!(
                    "[DSTU::folder_handlers] dstu_folder_get: FAILED - folder_id={}, error={}",
                    folder_id, e
                );
                Err(e.to_string())
            }
        },
    )
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 重命名文件夹
///
/// ## 参数
/// - `folder_id`: 文件夹 ID
/// - `title`: 新标题
#[tauri::command]
pub async fn dstu_folder_rename(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_id: String,
    title: String,
) -> Result<(), String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_rename: folder_id={}, title={}",
        folder_id, title
    );

    // 验证标题非空
    if title.trim().is_empty() {
        return Err("文件夹标题不能为空".to_string());
    }

    // 验证标题长度和字符集
    validate_string_input(&title, "文件夹标题", MAX_FOLDER_TITLE_LENGTH)?;

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        // 获取现有文件夹
        let mut folder = match VfsFolderRepo::get_folder(&vfs_db, &folder_id) {
            Ok(Some(f)) => f,
            Ok(None) => {
                warn!("[DSTU::folder_handlers] dstu_folder_rename: FAILED - folder not found: {}", folder_id);
                return Err("资源不存在".to_string());
            }
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_rename: FAILED - get_folder error={}", e);
                return Err(e.to_string());
            }
        };

        // 更新标题
        folder.title = title.clone();

        // 保存更新
        match VfsFolderRepo::update_folder(&vfs_db, &folder) {
            Ok(()) => {
                info!("[DSTU::folder_handlers] dstu_folder_rename: SUCCESS - folder_id={}, new_title={}", folder_id, title);
                Ok(())
            }
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_rename: FAILED - update_folder error={}", e);
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 删除文件夹
///
/// 软删除文件夹（移到回收站）。级联软删除所有子文件夹和内容项。
///
/// ## 参数
/// - `folder_id`: 文件夹 ID
#[tauri::command]
pub async fn dstu_folder_delete(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_id: String,
) -> Result<(), String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_delete: folder_id={}",
        folder_id
    );

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        // 软删除文件夹，级联软删除子文件夹和内容项（设置 deleted_at）
        match VfsFolderRepo::delete_folder(&vfs_db, &folder_id) {
            Ok(()) => {
                info!(
                    "[DSTU::folder_handlers] dstu_folder_delete: SUCCESS - folder_id={}",
                    folder_id
                );
                Ok(())
            }
            Err(e) => {
                error!(
                    "[DSTU::folder_handlers] dstu_folder_delete: FAILED - folder_id={}, error={}",
                    folder_id, e
                );
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 移动文件夹
///
/// 将文件夹移动到另一个父文件夹下。
///
/// ## 参数
/// - `folder_id`: 文件夹 ID
/// - `new_parent_id`: 新父文件夹 ID（NULL 表示移动到根级）
///
/// ## 约束
/// - 不能移动到自己的子文件夹下（循环引用检查）
/// - 移动后深度不能超过 10 层
#[tauri::command]
pub async fn dstu_folder_move(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_id: String,
    new_parent_id: Option<String>,
) -> Result<(), String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_move: folder_id={}, new_parent_id={:?}",
        folder_id, new_parent_id
    );

    // 检查是否移动到自己
    if let Some(ref parent_id) = new_parent_id {
        if parent_id == &folder_id {
            return Err(folder_errors::INVALID_PARENT.to_string());
        }
    }

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        // 调用 FolderRepo 移动文件夹（内部包含所有验证）
        match VfsFolderRepo::move_folder(&vfs_db, &folder_id, new_parent_id.as_deref()) {
            Ok(()) => {
                info!("[DSTU::folder_handlers] dstu_folder_move: SUCCESS - folder_id={}, new_parent_id={:?}", folder_id, new_parent_id);
                Ok(())
            }
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_move: FAILED - folder_id={}, new_parent_id={:?}, error={}", folder_id, new_parent_id, e);
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 设置文件夹展开状态
///
/// ## 参数
/// - `folder_id`: 文件夹 ID
/// - `is_expanded`: 是否展开
#[tauri::command]
pub async fn dstu_folder_set_expanded(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_id: String,
    is_expanded: bool,
) -> Result<(), String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_set_expanded: folder_id={}, is_expanded={}",
        folder_id, is_expanded
    );

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        match VfsFolderRepo::set_folder_expanded(&vfs_db, &folder_id, is_expanded) {
            Ok(()) => {
                info!("[DSTU::folder_handlers] dstu_folder_set_expanded: SUCCESS - folder_id={}, is_expanded={}", folder_id, is_expanded);
                Ok(())
            }
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_set_expanded: FAILED - folder_id={}, is_expanded={}, error={}", folder_id, is_expanded, e);
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ============================================================================
// D2: 文件夹内容管理命令
// ============================================================================

/// 添加内容到文件夹
///
/// 将资源（笔记、教材等）添加到指定文件夹。
///
/// ## 参数
/// - `folder_id`: 文件夹 ID（NULL 表示根级）
/// - `item_type`: 资源类型（note|textbook|exam|translation|essay）
/// - `item_id`: 资源 ID
///
/// ## 返回
/// 新创建的文件夹内容项
///
/// ## 约束
/// - 同一资源只能存在于一个文件夹中
#[tauri::command]
pub async fn dstu_folder_add_item(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_id: Option<String>,
    item_type: String,
    item_id: String,
) -> Result<VfsFolderItem, String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_add_item: folder_id={:?}, item_type={}, item_id={}",
        folder_id, item_type, item_id
    );

    // 验证 item_type
    // ★ P0-3 修复：扩展支持 image/file 类型，与 moveItem、附件、引用模式保持一致
    // ★ 知识导图集成：添加 mindmap 类型支持
    let valid_types = [
        "note",
        "textbook",
        "exam",
        "translation",
        "essay",
        "image",
        "file",
        "mindmap",
    ];
    if !valid_types.contains(&item_type.as_str()) {
        warn!(
            "[DSTU::folder_handlers] dstu_folder_add_item: invalid item_type: {}",
            item_type
        );
        return Err("参数格式错误".to_string());
    }

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        // 检查文件夹存在性（如果指定了文件夹）
        if let Some(ref fid) = folder_id {
            match VfsFolderRepo::folder_exists(&vfs_db, fid) {
                Ok(exists) => {
                    if !exists {
                        warn!("[DSTU::folder_handlers] dstu_folder_add_item: FAILED - folder not found: {}", fid);
                        return Err("目标文件夹不存在".to_string());
                    }
                }
                Err(e) => {
                    error!("[DSTU::folder_handlers] dstu_folder_add_item: FAILED - folder_exists error={}", e);
                    return Err(e.to_string());
                }
            }
        }

        // 创建 folder_item
        let item = VfsFolderItem::new(
            folder_id.clone(),
            item_type.clone(),
            item_id.clone(),
        );

        // 添加到文件夹（使用 INSERT OR REPLACE 处理唯一约束）
        match VfsFolderRepo::add_item_to_folder(&vfs_db, &item) {
            Ok(()) => {
                info!("[DSTU::folder_handlers] dstu_folder_add_item: SUCCESS - item_id={}, folder_id={:?}", item_id, folder_id);
                Ok(item)
            }
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_add_item: FAILED - item_id={}, folder_id={:?}, error={}", item_id, folder_id, e);
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 从文件夹移除内容
///
/// 将资源从所有文件夹中移除（实际上是删除 folder_items 记录）。
///
/// ## 参数
/// - `item_type`: 资源类型
/// - `item_id`: 资源 ID
#[tauri::command]
pub async fn dstu_folder_remove_item(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    item_type: String,
    item_id: String,
) -> Result<(), String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_remove_item: item_type={}, item_id={}",
        item_type, item_id
    );

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        match VfsFolderRepo::remove_item_from_folder(&vfs_db, &item_type, &item_id) {
            Ok(()) => {
                info!("[DSTU::folder_handlers] dstu_folder_remove_item: SUCCESS - item_id={}", item_id);
                Ok(())
            }
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_remove_item: FAILED - item_id={}, error={}", item_id, e);
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 移动内容到另一文件夹
///
/// ## 参数
/// - `item_type`: 资源类型
/// - `item_id`: 资源 ID
/// - `new_folder_id`: 新文件夹 ID（NULL 表示移动到根级）
#[tauri::command]
pub async fn dstu_folder_move_item(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    item_type: String,
    item_id: String,
    new_folder_id: Option<String>,
) -> Result<(), String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_move_item: item_type={}, item_id={}, new_folder_id={:?}",
        item_type, item_id, new_folder_id
    );

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        info!(
            "[DSTU::folder_handlers] dstu_folder_move_item: entering spawn_blocking for item {}",
            item_id
        );

        match VfsFolderRepo::move_item_to_folder(&vfs_db, &item_type, &item_id, new_folder_id.as_deref()) {
            Ok(()) => {
                info!(
                    "[DSTU::folder_handlers] dstu_folder_move_item: SUCCESS - moved item {} to folder {:?}",
                    item_id, new_folder_id
                );
                Ok(())
            }
            Err(e) => {
                error!(
                    "[DSTU::folder_handlers] dstu_folder_move_item: FAILED - item={}, error={}",
                    item_id, e
                );
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ============================================================================
// D3: 查询命令
// ============================================================================

/// 列出所有文件夹
///
/// ## 返回
/// 文件夹列表（扁平结构）
#[tauri::command]
pub async fn dstu_folder_list(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<VfsFolder>, String> {
    info!("[DSTU::folder_handlers] dstu_folder_list");

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || match VfsFolderRepo::list_all_folders(&vfs_db) {
        Ok(folders) => {
            info!(
                "[DSTU::folder_handlers] dstu_folder_list: SUCCESS - count={}",
                folders.len()
            );
            Ok(folders)
        }
        Err(e) => {
            error!(
                "[DSTU::folder_handlers] dstu_folder_list: FAILED - error={}",
                e
            );
            Err(e.to_string())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 获取文件夹树结构
///
/// ## 返回
/// 文件夹树（递归结构，包含子文件夹和内容项）
#[tauri::command]
pub async fn dstu_folder_get_tree(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<FolderTreeNode>, String> {
    info!("[DSTU::folder_handlers] dstu_folder_get_tree");

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || match VfsFolderRepo::get_folder_tree_all(&vfs_db) {
        Ok(tree) => {
            info!(
                "[DSTU::folder_handlers] dstu_folder_get_tree: SUCCESS - root_nodes={}",
                tree.len()
            );
            Ok(tree)
        }
        Err(e) => {
            error!(
                "[DSTU::folder_handlers] dstu_folder_get_tree: FAILED - error={}",
                e
            );
            Err(e.to_string())
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 获取文件夹下所有内容项
///
/// ## 参数
/// - `folder_id`: 文件夹 ID（NULL 表示根级内容）
///
/// ## 返回
/// 内容项列表
#[tauri::command]
pub async fn dstu_folder_get_items(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_id: Option<String>,
) -> Result<Vec<VfsFolderItem>, String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_get_items: folder_id={:?}",
        folder_id
    );

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        match VfsFolderRepo::get_folder_items_all(&vfs_db, folder_id.as_deref()) {
            Ok(items) => {
                info!("[DSTU::folder_handlers] dstu_folder_get_items: SUCCESS - folder_id={:?}, count={}", folder_id, items.len());
                Ok(items)
            }
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_get_items: FAILED - folder_id={:?}, error={}", folder_id, e);
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ============================================================================
// D4: 上下文注入专用命令（Prompt 4 核心功能）
// ============================================================================

/// 获取文件夹内所有资源（用于 Chat V2 上下文注入）
///
/// 递归获取文件夹内所有资源，包括子文件夹中的资源。
/// 返回结构化的资源列表，可直接用于创建 ContextRef。
///
/// ## 参数
/// - `folder_id`: 文件夹 ID
/// - `include_subfolders`: 是否包含子文件夹（默认 true）
/// - `include_content`: 是否加载资源内容（默认 false，提高性能）
///
/// ## 返回
/// `FolderResourcesResult` 包含：
/// - `folder_id`: 文件夹 ID
/// - `folder_title`: 文件夹标题
/// - `path`: 文件夹完整路径（如 "高考复习/函数"）
/// - `total_count`: 资源总数
/// - `resources`: 资源列表（每个包含 item_type, item_id, title, path, content）
///
/// ## 约束
/// - 递归深度最大 10 层（契约 F）
/// - 资源数超过 50 个时会记录警告（契约 F 批量注入限制）
///
/// ## 使用场景
/// 1. 用户在 Chat V2 中选择注入文件夹
/// 2. 前端调用此命令获取文件夹内所有资源
/// 3. 根据返回的 resources 列表创建 ContextRef
#[tauri::command]
pub async fn dstu_folder_get_all_resources(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_id: String,
    include_subfolders: bool,
    include_content: bool,
) -> Result<FolderResourcesResult, String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_get_all_resources: folder_id={}, include_subfolders={}, include_content={}",
        folder_id, include_subfolders, include_content
    );

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        // 调用 FolderRepo 的递归查询方法
        match VfsFolderRepo::get_all_resources(
            &vfs_db,
            &folder_id,
            include_subfolders,
            include_content,
        ) {
            Ok(result) => {
                // 检查资源数量限制
                if result.total_count > MAX_INJECT_RESOURCES {
                    warn!(
                        "[DSTU::folder_handlers] Folder {} contains {} resources, exceeds recommended limit {}",
                        folder_id,
                        result.total_count,
                        MAX_INJECT_RESOURCES
                    );
                }
                info!("[DSTU::folder_handlers] dstu_folder_get_all_resources: SUCCESS - folder_id={}, total_count={}", folder_id, result.total_count);
                Ok(result)
            }
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_get_all_resources: FAILED - folder_id={}, error={}", folder_id, e);
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ============================================================================
// D5: 排序命令
// ============================================================================

/// 重新排序文件夹
///
/// 按给定顺序更新文件夹的 sort_order。
///
/// ## 参数
/// - `folder_ids`: 文件夹 ID 列表（按期望顺序排列）
#[tauri::command]
pub async fn dstu_folder_reorder(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_ids: Vec<String>,
) -> Result<(), String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_reorder: folder_ids={:?}",
        folder_ids
    );

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        match VfsFolderRepo::reorder_folders(&vfs_db, &folder_ids) {
            Ok(()) => {
                info!(
                    "[DSTU::folder_handlers] dstu_folder_reorder: SUCCESS - count={}",
                    folder_ids.len()
                );
                Ok(())
            }
            Err(e) => {
                error!(
                    "[DSTU::folder_handlers] dstu_folder_reorder: FAILED - error={}",
                    e
                );
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 重新排序文件夹内容项
///
/// 按给定顺序更新内容项的 sort_order。
///
/// ## 参数
/// - `folder_id`: 文件夹 ID（NULL 表示根级）
/// - `item_ids`: 内容项 ID 列表（按期望顺序排列）
#[tauri::command]
pub async fn dstu_folder_reorder_items(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_id: Option<String>,
    item_ids: Vec<String>,
) -> Result<(), String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_reorder_items: folder_id={:?}, item_ids={:?}",
        folder_id, item_ids
    );

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        match VfsFolderRepo::reorder_items(&vfs_db, folder_id.as_deref(), &item_ids) {
            Ok(()) => {
                info!("[DSTU::folder_handlers] dstu_folder_reorder_items: SUCCESS - folder_id={:?}, count={}", folder_id, item_ids.len());
                Ok(())
            }
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_reorder_items: FAILED - folder_id={:?}, error={}", folder_id, e);
                Err(e.to_string())
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ============================================================================
// P2: 面包屑路径解析（27-DSTU统一虚拟路径架构改造设计.md）
// ============================================================================

/// 面包屑项
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreadcrumbItem {
    /// 文件夹 ID
    pub id: String,
    /// 文件夹名称
    pub name: String,
}

/// 获取文件夹的面包屑路径
///
/// P2 改造：从后端获取面包屑，移除前端维护
///
/// ## 参数
/// - `folder_id`: 文件夹 ID
///
/// ## 返回
/// 从根到当前文件夹的面包屑列表（不包含科目根）
#[tauri::command]
pub async fn dstu_folder_get_breadcrumbs(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    folder_id: String,
) -> Result<Vec<BreadcrumbItem>, String> {
    info!(
        "[DSTU::folder_handlers] dstu_folder_get_breadcrumbs: folder_id={}",
        folder_id
    );

    let vfs_db = vfs_db.inner().clone();

    tokio::task::spawn_blocking(move || {
        let conn = match vfs_db.get_conn_safe() {
            Ok(c) => c,
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_get_breadcrumbs: get_conn_safe FAILED - error={}", e);
                return Err(e.to_string());
            }
        };

        // 使用递归 CTE 向上追溯到根文件夹
        let mut stmt = match conn.prepare(
            r#"
            WITH RECURSIVE folder_path AS (
                SELECT id, parent_id, title, 1 as depth
                FROM folders WHERE id = ?1
                UNION ALL
                SELECT f.id, f.parent_id, f.title, fp.depth + 1
                FROM folders f JOIN folder_path fp ON f.id = fp.parent_id
                WHERE fp.depth < 11
            )
            SELECT id, title FROM folder_path ORDER BY depth DESC
            "#,
        ) {
            Ok(s) => s,
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_get_breadcrumbs: prepare FAILED - folder_id={}, error={}", folder_id, e);
                return Err("数据库查询失败".to_string());
            }
        };

        let breadcrumbs_result: Result<Vec<BreadcrumbItem>, _> = stmt
            .query_map(rusqlite::params![&folder_id], |row| {
                Ok(BreadcrumbItem {
                    id: row.get(0)?,
                    name: row.get(1)?,
                })
            })
            .map_err(|e| format!("Query failed: {}", e))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Collect failed: {}", e));

        match breadcrumbs_result {
            Ok(breadcrumbs) => {
                info!("[DSTU::folder_handlers] dstu_folder_get_breadcrumbs: SUCCESS - folder_id={}, count={}", folder_id, breadcrumbs.len());
                Ok(breadcrumbs)
            }
            Err(e) => {
                error!("[DSTU::folder_handlers] dstu_folder_get_breadcrumbs: FAILED - folder_id={}, error={}", folder_id, e);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vfs::{MAX_FOLDERS_PER_SUBJECT, MAX_FOLDER_DEPTH};

    #[test]
    fn test_valid_item_types() {
        let valid_types = ["note", "textbook", "exam", "translation", "essay"];
        for t in valid_types {
            assert!(["note", "textbook", "exam", "translation", "essay"].contains(&t));
        }
    }

    #[test]
    fn test_folder_id_format() {
        let id = VfsFolder::generate_id();
        assert!(id.starts_with("fld_"));
        assert_eq!(id.len(), 14); // "fld_" + 10 chars
    }

    #[test]
    fn test_folder_item_id_format() {
        let id = VfsFolderItem::generate_id();
        assert!(id.starts_with("fi_"));
        assert_eq!(id.len(), 13); // "fi_" + 10 chars
    }

    #[test]
    fn test_title_validation() {
        // 空标题应该被拒绝
        let empty_title = "";
        assert!(empty_title.trim().is_empty());

        // 只有空格的标题应该被拒绝
        let whitespace_title = "   ";
        assert!(whitespace_title.trim().is_empty());

        // 超长标题应该被拒绝
        let long_title = "a".repeat(MAX_FOLDER_TITLE_LENGTH + 1);
        assert!(long_title.len() > MAX_FOLDER_TITLE_LENGTH);
    }

    #[test]
    fn test_folder_constraints() {
        assert_eq!(MAX_FOLDER_DEPTH, 10);
        assert_eq!(MAX_FOLDERS_PER_SUBJECT, 500);
        assert_eq!(MAX_FOLDER_TITLE_LENGTH, 100);
    }

    #[test]
    fn test_folder_error_codes() {
        assert_eq!(folder_errors::NOT_FOUND, "FOLDER_NOT_FOUND");
        assert_eq!(folder_errors::DEPTH_EXCEEDED, "FOLDER_DEPTH_EXCEEDED");
        assert_eq!(folder_errors::INVALID_PARENT, "INVALID_PARENT");
        assert_eq!(folder_errors::COUNT_EXCEEDED, "FOLDER_COUNT_EXCEEDED");
    }

    #[test]
    fn test_vfs_folder_new() {
        let folder = VfsFolder::new(
            "高考复习".to_string(),
            None,
            Some("folder".to_string()),
            Some("#FF0000".to_string()),
        );

        assert!(folder.id.starts_with("fld_"));
        assert_eq!(folder.title, "高考复习");
        assert!(folder.parent_id.is_none());
        assert_eq!(folder.icon, Some("folder".to_string()));
        assert_eq!(folder.color, Some("#FF0000".to_string()));
        assert!(folder.is_expanded);
        assert_eq!(folder.sort_order, 0);
        assert!(folder.created_at > 0);
        assert!(folder.updated_at > 0);
    }

    #[test]
    fn test_vfs_folder_item_new() {
        let item = VfsFolderItem::new(
            Some("fld_abc123".to_string()),
            "note".to_string(),
            "note_xyz789".to_string(),
        );

        assert!(item.id.starts_with("fi_"));
        assert_eq!(item.folder_id, Some("fld_abc123".to_string()));
        assert_eq!(item.item_type, "note");
        assert_eq!(item.item_id, "note_xyz789");
        assert_eq!(item.sort_order, 0);
        assert!(item.created_at > 0);
    }

    #[test]
    fn test_vfs_folder_serialization() {
        let folder = VfsFolder::new("测试文件夹".to_string(), None, None, None);

        let json = serde_json::to_string(&folder).unwrap();

        // 验证 camelCase 序列化
        assert!(json.contains("\"isExpanded\""));
        assert!(json.contains("\"sortOrder\""));
        assert!(json.contains("\"createdAt\""));
        assert!(json.contains("\"updatedAt\""));

        // None 字段应该被跳过
        assert!(!json.contains("\"parentId\""));
        assert!(!json.contains("\"icon\""));
        assert!(!json.contains("\"color\""));
    }

    #[test]
    fn test_vfs_folder_item_serialization() {
        let item = VfsFolderItem::new(None, "textbook".to_string(), "tb_abc123".to_string());

        let json = serde_json::to_string(&item).unwrap();

        // 验证 camelCase 序列化
        assert!(json.contains("\"itemType\""));
        assert!(json.contains("\"itemId\""));
        assert!(json.contains("\"sortOrder\""));
        assert!(json.contains("\"createdAt\""));

        // None 字段应该被跳过
        assert!(!json.contains("\"folderId\""));
    }
}
