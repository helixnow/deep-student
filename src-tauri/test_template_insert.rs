use chrono::Utc;
use rusqlite::{params, Connection};
use std::collections::HashMap;

fn main() {
    println!("测试内置模板插入...");
    
    // 打开数据库连接
    let conn = Connection::open("app_data/mistakes.db").expect("无法打开数据库");
    
    // 插入一个测试模板
    let now = Utc::now().to_rfc3339();
    let fields = vec!["Front", "Back", "Notes", "Tags"];
    let field_extraction_rules = HashMap::from([
        ("Front".to_string(), serde_json::json!({"field_type": "Text", "is_required": true, "default_value": "", "validation_pattern": null, "description": "Front 字段"})),
        ("Back".to_string(), serde_json::json!({"field_type": "Text", "is_required": true, "default_value": "", "validation_pattern": null, "description": "Back 字段"})),
        ("Notes".to_string(), serde_json::json!({"field_type": "Text", "is_required": false, "default_value": "", "validation_pattern": null, "description": "Notes 字段"})),
        ("Tags".to_string(), serde_json::json!({"field_type": "Array", "is_required": false, "default_value": "[]", "validation_pattern": null, "description": "Tags 字段"})),
    ]);
    
    let result = conn.execute(
        "INSERT OR REPLACE INTO custom_anki_templates 
         (id, name, description, author, version, preview_front, preview_back, note_type,
          fields_json, generation_prompt, front_template, back_template, css_style,
          field_extraction_rules_json, created_at, updated_at, is_active, is_built_in)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 1, 1)",
        params![
            "test-minimal-card",
            "测试极简卡片",
            "测试插入",
            "系统内置",
            "1.0.0",
            "测试前面",
            "测试后面",
            "Basic",
            serde_json::to_string(&fields).unwrap(),
            "测试prompt",
            "<div>{{Front}}</div>",
            "<div>{{Back}}</div>",
            ".card { font-size: 16px; }",
            serde_json::to_string(&field_extraction_rules).unwrap(),
            &now,
            &now
        ],
    );
    
    match result {
        Ok(rows) => println!("✅ 成功插入 {} 行", rows),
        Err(e) => println!("❌ 插入失败: {}", e),
    }
    
    // 查询插入结果
    let count: i32 = conn.query_row(
        "SELECT COUNT(*) FROM custom_anki_templates WHERE is_built_in = 1",
        [],
        |row| row.get(0),
    ).unwrap();
    
    println!("📊 当前内置模板数量: {}", count);
}