// 在 database.rs 的 update_custom_template 函数中添加调试日志：

/// 更新自定义模板
pub fn update_custom_template(&self, template_id: &str, request: &crate::models::UpdateTemplateRequest) -> Result<()> {
    let conn = self.get_conn_safe()?;
    let now = Utc::now().to_rfc3339();

    // 添加调试日志
    println!("=== Update Template Debug ===");
    println!("Template ID: {}", template_id);
    println!("Request preview_data_json: {:?}", request.preview_data_json);

    // 先获取当前版本号
    let current_version = conn.query_row(
        "SELECT version FROM custom_anki_templates WHERE id = ?1",
        params![template_id],
        |row| row.get::<_, String>(0)
    ).unwrap_or_else(|_| "1.0.0".to_string());

    // 自动递增版本号
    let new_version = Self::increment_version(&current_version);

    let mut query_parts = Vec::new();
    let mut params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

    // ... 其他字段处理 ...

    if let Some(preview_data_json) = &request.preview_data_json {
        println!("Adding preview_data_json to query: {}", preview_data_json);
        query_parts.push("preview_data_json = ?".to_string());
        params.push(Box::new(preview_data_json.clone()));
    } else {
        println!("No preview_data_json in request");
    }

    // ... 执行更新 ...

    // 验证更新后的数据
    let updated_preview = conn.query_row(
        "SELECT preview_data_json FROM custom_anki_templates WHERE id = ?1",
        params![template_id],
        |row| row.get::<_, Option<String>>(0)
    )?;

    println!("After update, preview_data_json in DB: {:?}", updated_preview);

    Ok(())
}