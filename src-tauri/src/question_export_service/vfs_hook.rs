//! qbank 对 vfs 的题目集导出接入。
//!
//! vfs 的 DSTU 导出适配器只持有 trait；真正的 `authoring::export_document`
//! 由这里注册，避免 vfs 反向依赖 qbank。

use std::sync::Arc;
use std::sync::Once;

use serde_json::Value;

use crate::vfs::database::VfsDatabase;
use crate::vfs::hooks::ExamDocumentExporter;

struct QbankExamDocumentExporter;

impl ExamDocumentExporter for QbankExamDocumentExporter {
    fn export_document(&self, db: &VfsDatabase, exam_id: &str) -> Result<Value, String> {
        crate::question_export_service::authoring::export_document(db, exam_id)
            .map_err(|error| error.to_string())
    }
}

/// 由 `extensions::register_extensions()` 在启动时调用；幂等。
pub fn install_vfs_hooks() {
    static INSTALL: Once = Once::new();
    INSTALL.call_once(|| {
        crate::vfs::hooks::register_exam_document_exporter(Arc::new(QbankExamDocumentExporter));
    });
}
