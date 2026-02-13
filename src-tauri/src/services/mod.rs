// ★ data_migration_service, enhanced_image_service 模块已移除

#[derive(Clone, serde::Serialize)]
pub struct LogEntry {
    pub timestamp: String,
    pub level: String,
    pub message: String,
}
