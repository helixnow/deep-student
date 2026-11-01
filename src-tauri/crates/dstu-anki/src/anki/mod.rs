//! Anki 领域薄封装：卡片 CRUD 单一入口，行为委托现有 `Database` 方法。

pub mod repository;

pub use repository::AnkiCardRepository;

/// 获取模板配置（从数据库获取，支持内置和自定义模板）
///
/// 原定义在 app 的 `commands.rs`；app 以 `commands::get_template_config` 按原路径重导出。
pub fn get_template_config(
    template_id: &str,
    database: &std::sync::Arc<crate::database::Database>,
) -> std::result::Result<(String, Vec<String>, String, String, String), String> {
    // 从数据库获取模板（包括内置和自定义）
    match database.get_custom_template_by_id(template_id) {
        Ok(Some(template)) => {
            let fields = template.fields.clone();
            Ok((
                template.name,
                fields,
                template.front_template,
                template.back_template,
                template.css_style,
            ))
        }
        Ok(None) => Err(format!("模板不存在: {}", template_id)),
        Err(e) => Err(format!("获取模板失败: {}", e)),
    }
}
