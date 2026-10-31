//! qbank 对 vfs 的题目集导出接入。
//!
//! vfs 的 DSTU 导出适配器只持有 trait；真正的 `authoring::export_document`
//! 由这里注册，避免 vfs 反向依赖 qbank。

use std::sync::Arc;

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

/// 由 `extensions::register_extensions()` 的 `QbankVfsPlugin` 调用；幂等由
/// `PluginHost`（同名插件只 apply 一次）保证。
pub fn install_vfs_hooks(scope: &mut dstu_kernel::Scope) {
    if let Ok(disposer) =
        crate::vfs::hooks::register_exam_document_exporter(Arc::new(QbankExamDocumentExporter))
    {
        scope.add(disposer);
    }
}
