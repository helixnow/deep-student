//! 共享的辅助函数和常量

use std::path::Path;

/// 临时 RAG 上传目录名
pub const TEMP_RAG_UPLOAD_DIR: &str = "temp_rag_uploads";

/// 保留旧调用以兼容 legacy 代码路径
pub fn sanitize_file_path(input: &str) -> String {
    crate::unified_file_manager::sanitize_for_legacy(input)
}

pub fn normalize_dir_prefix(path: &Path) -> String {
    let normalized = path.to_string_lossy().replace('\\', "/");
    normalized.trim_end_matches('/').to_string()
}
