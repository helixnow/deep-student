use anyhow::Result;
use deep_student_lib::apkg_exporter_service::export_cards_to_apkg_with_full_template;
use deep_student_lib::models::{AnkiCard, CustomAnkiTemplate};
use rusqlite::Connection;
use std::collections::HashMap;
use tempfile::tempdir;

#[tokio::test]
async fn test_export_all_templates() -> Result<()> {
    // 打开主数据库
    let conn = Connection::open("../deep-student.db")?;
    // 查询所有自定义模板
    let mut stmt = conn.prepare("SELECT id, name, note_type, fields_json, front_template, back_template, css_style FROM custom_anki_templates WHERE is_active=1")?;
    let templates_iter = stmt.query_map([], |row| {
        let fields_json: String = row.get(3)?;
        let fields: Vec<String> = serde_json::from_str(&fields_json).unwrap_or_default();
        Ok(CustomAnkiTemplate {
            id: row.get(0)?,
            name: row.get(1)?,
            description: String::new(),
            author: None,
            version: String::new(),
            preview_front: String::new(),
            preview_back: String::new(),
            note_type: row.get(2)?,
            fields,
            generation_prompt: String::new(),
            front_template: row.get(4)?,
            back_template: row.get(5)?,
            css_style: row.get(6)?,
            field_extraction_rules: HashMap::new(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            is_active: true,
            is_built_in: false,
            preview_data_json: None,
        })
    })?;

    for tmpl in templates_iter {
        let tmpl = tmpl?;
        // 构造示例卡片
        let card = AnkiCard {
            front: if tmpl.preview_front.trim().is_empty() {
                tmpl.front_template.clone()
            } else {
                tmpl.preview_front.clone()
            },
            back: if tmpl.preview_back.trim().is_empty() {
                tmpl.back_template.clone()
            } else {
                tmpl.preview_back.clone()
            },
            text: None,
            tags: vec!["integration-test".to_string()],
            images: vec![],
            id: uuid::Uuid::new_v4().to_string(),
            task_id: String::new(),
            is_error_card: false,
            error_content: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            updated_at: chrono::Utc::now().to_rfc3339(),
            extra_fields: HashMap::new(),
            template_id: Some(tmpl.id.clone()),
        };
        // 临时目录
        let tmp = tempdir()?;
        let apkg_path = tmp.path().join(format!("{}.apkg", tmpl.id));

        // 调用导出
        export_cards_to_apkg_with_full_template(
            vec![card],
            "TestDeck".to_string(),
            tmpl.note_type.clone(),
            apkg_path.clone(),
            Some((
                tmpl.id.clone(),
                tmpl.fields.clone(),
                tmpl.front_template.clone(),
                tmpl.back_template.clone(),
                tmpl.css_style.clone(),
            )),
            Some(tmpl.clone()),
        )
        .await
        .map_err(|e: String| anyhow::anyhow!(e))?;

        // 验证生成文件
        assert!(
            apkg_path.exists(),
            "apkg file for template {} not generated",
            tmpl.id
        );
    }

    Ok(())
}
