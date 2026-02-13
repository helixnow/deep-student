//! DSTU 访达协议层 (DS-Tauri-Unified Finder Protocol)
//!
//! DSTU 是 VFS 与上层应用之间的统一访问接口，类似于操作系统的文件管理器协议。
//! 提供文件系统语义的统一接口，使所有模块（笔记、教材、题目集等）可以通过相同的 API 访问资源。
//!
//! ## 设计目标
//! 1. **统一访问接口**：所有模块通过 DSTU 访问资源，消除各模块直接访问不同数据库的混乱
//! 2. **文件系统语义**：使用路径（path）定位资源，支持目录遍历、移动、复制等操作
//! 3. **解耦存储实现**：DSTU 不关心 VFS 内部实现，便于未来扩展
//!
//! ## 路径规范
//! ```text
//! 路径格式：/{folder_path}/{resource_id}
//!
//! 示例：
//! - /高考复习/函数/note_abc123   → 在"高考复习/函数"文件夹下的笔记
//! - /我的教材/tb_xyz789          → 在"我的教材"文件夹下的教材
//! - /exam_sheet_001              → 根目录下的题目集（无文件夹）
//! - /                            → 根目录
//! - /@trash                      → 回收站（虚拟路径）
//! ```
//!
//! ## 模块结构
//! - `types` - DSTU 类型定义（DstuNode、DstuNodeType 等）
//! - `error` - 错误类型（DstuError、DstuResult）
//! - `path_parser` - 路径解析器
//! - `handlers` - Tauri 命令处理器（Prompt 5 实现）

pub mod error;
pub mod exam_formatter;
pub mod folder_handlers;
pub mod handler_utils; // 路径工具和节点转换器
pub mod handlers;
pub mod path_parser;
pub mod path_types; // 新增：契约 C1 类型定义
pub mod trash_handlers;
pub mod types;

// ============================================================================
// 重导出核心类型
// ============================================================================

// 错误类型
pub use error::{DstuError, DstuResult};

// 路径解析器（辅助函数）
pub use path_parser::{build_simple_resource_path, get_parent_path, get_path_name, is_parent_path};

// 路径解析器（新 API，契约 B/C1）
pub use path_parser::{
    build_real_path, extract_folder_path, extract_resource_id, get_resource_type, is_valid_path,
    is_valid_resource_id, parse_real_path, RealParsedPath, RESOURCE_ID_PREFIXES,
    VIRTUAL_PATH_TYPES,
};

// 路径类型（契约 C1）
pub use path_types::{
    get_resource_type_from_id, is_virtual_path_type, ParsedPath as NewParsedPath,
};

// 核心类型
pub use types::{
    BatchMoveRequest,
    DstuCreateOptions,
    DstuListOptions,
    DstuNode,
    DstuNodeType,
    // 契约 C: 真实路径架构类型（文档 28）
    DstuParsedPath,
    DstuWatchEvent,
    DstuWatchEventType,
    PathCacheEntry,
    ResourceLocation,
};

// handlers 导出（Prompt 5 实现）
pub use handlers::{
    dstu_batch_move,
    dstu_build_path,
    dstu_copy,
    dstu_create,
    dstu_delete,
    // 批量操作命令
    dstu_delete_many,
    dstu_get,
    dstu_get_content,
    // 题目集识别多模态内容获取（文档 25 实现）
    dstu_get_exam_content,
    dstu_get_path_by_id,
    dstu_get_resource_by_path,
    // E2: 资源定位
    dstu_get_resource_location,
    dstu_list,
    dstu_list_deleted,
    dstu_move,
    dstu_move_many,
    // E3: 移动操作
    dstu_move_to_folder,
    // 契约 E: 真实路径架构命令（文档 28 Prompt 5）
    // E1: 路径解析
    dstu_parse_path,
    dstu_purge,
    dstu_purge_all,
    // E4: 路径缓存
    dstu_refresh_path_cache,
    dstu_restore,
    dstu_restore_many,
    dstu_search,
    // 文件夹内搜索
    dstu_search_in_folder,
    // 通用能力命令
    dstu_set_favorite,
    dstu_set_metadata,
    dstu_update,
};

// folder_handlers 导出（文档 23 Prompt 3/4 实现）
pub use folder_handlers::{
    // D2: 内容管理
    dstu_folder_add_item,
    // D1: 文件夹管理
    dstu_folder_create,
    dstu_folder_delete,
    dstu_folder_get,
    // D4: 上下文注入专用（Prompt 4 核心功能）
    dstu_folder_get_all_resources,
    // P2: 面包屑（27-DSTU统一虚拟路径架构改造设计.md）
    dstu_folder_get_breadcrumbs,
    dstu_folder_get_items,
    dstu_folder_get_tree,
    // D3: 查询
    dstu_folder_list,
    dstu_folder_move,
    dstu_folder_move_item,
    dstu_folder_remove_item,
    dstu_folder_rename,
    // D5: 排序
    dstu_folder_reorder,
    dstu_folder_reorder_items,
    dstu_folder_set_expanded,
    BreadcrumbItem,
};
