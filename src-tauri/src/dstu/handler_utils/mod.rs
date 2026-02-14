//! DSTU 处理器工具模块
//!
//! 提供路径解析、节点转换、CRUD 辅助函数等

pub mod content_helpers;
pub mod crud;
pub mod delete_helpers;
pub mod list_helpers;
pub mod node_converters;
pub mod path_utils;
pub mod search_helpers;

// Note: The following empty modules have been removed:
// - batch.rs
// - migration.rs
// - move_copy.rs
// - path_commands.rs
// - search.rs (different from search_helpers.rs)
// - trash.rs

// 重导出路径工具
pub use path_utils::{
    extract_resource_info, extract_simple_id, infer_resource_type_from_id, is_uuid_format,
};

// 重导出节点转换器
pub use node_converters::{
    attachment_to_dstu_node, create_type_folder, emit_watch_event, essay_to_dstu_node,
    exam_to_dstu_node, file_to_dstu_node, generate_resource_id, item_type_to_dstu_node_type,
    mindmap_to_dstu_node, note_to_dstu_node, parse_timestamp, session_to_dstu_node,
    textbook_to_dstu_node, translation_to_dstu_node,
};

// 重导出 CRUD 辅助函数
pub use crud::{
    fallback_lookup_uuid_resource, fetch_resource_as_dstu_node, get_resource_by_type_and_id,
    get_resource_folder_path,
};

// 重导出列表辅助函数
pub use list_helpers::{
    list_resources_by_type_with_folder_path, list_unassigned_essays, list_unassigned_exams,
    list_unassigned_notes, list_unassigned_textbooks, list_unassigned_translations,
};

// 重导出删除辅助函数
pub use delete_helpers::{
    delete_resource_by_type, delete_resource_by_type_with_conn, purge_resource_by_type,
    restore_resource_by_type, restore_resource_by_type_with_conn,
};

// 重导出内容辅助函数
pub use content_helpers::{
    get_content_by_type, get_content_by_type_paged, get_file_total_pages, update_content_by_type,
};

// 重导出搜索辅助函数
pub use search_helpers::{
    search_all, search_essays, search_exams, search_files, search_images, search_mindmaps,
    search_notes, search_textbooks, search_translations,
};
