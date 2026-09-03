use anyhow::Result;
use deep_student_lib::apkg_exporter_service::{
    export_cards_to_apkg_with_full_template, export_multi_template_apkg_report,
    MAX_EXPORT_MEDIA_FILE_BYTES,
};
use deep_student_lib::models::{AnkiCard, CustomAnkiTemplate};
use rusqlite::Connection;
use std::collections::HashMap;
use std::io::Read;
use tempfile::tempdir;

#[tokio::test]
async fn test_export_all_templates() -> Result<()> {
    // 打开主数据库
    let conn = Connection::open("../deep-student.db")?;
    let has_templates_table: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='custom_anki_templates')",
        [],
        |row| row.get(0),
    )?;
    let mut templates = Vec::new();
    if !has_templates_table {
        templates.push(CustomAnkiTemplate {
            id: "test-basic-template".to_string(),
            name: "Test Basic".to_string(),
            description: String::new(),
            author: None,
            version: "1.0.0".to_string(),
            preview_front: "Front".to_string(),
            preview_back: "Back".to_string(),
            note_type: "Basic".to_string(),
            fields: vec!["Front".to_string(), "Back".to_string()],
            generation_prompt: String::new(),
            front_template: "{{Front}}".to_string(),
            back_template: "{{Back}}".to_string(),
            css_style: String::new(),
            field_extraction_rules: HashMap::new(),
            created_at: chrono::Utc::now(),
            updated_at: chrono::Utc::now(),
            is_active: true,
            is_built_in: true,
            preview_data_json: None,
        });
    }
    // 查询所有自定义模板
    if has_templates_table {
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
            templates.push(tmpl?);
        }
    }

    for tmpl in templates {
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

fn media_card(front: &str, back: &str, images: Vec<String>) -> AnkiCard {
    AnkiCard {
        front: front.to_string(),
        back: back.to_string(),
        text: None,
        tags: vec!["media-integration".to_string()],
        images,
        id: uuid::Uuid::new_v4().to_string(),
        task_id: String::new(),
        is_error_card: false,
        error_content: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
        extra_fields: HashMap::new(),
        template_id: None,
    }
}

/// 导出报告契约：引用的本地媒体被打进 zip（清单键 "0","1",... 指向文件名），
/// 磁盘缺失的媒体进入 missing_media 而不是让导出失败或静默丢弃。
#[tokio::test]
async fn test_export_report_packs_referenced_media_and_reports_missing() -> Result<()> {
    let media_src = tempdir()?;
    let img_path = media_src.path().join("photo.png");
    std::fs::write(&img_path, b"photo-bytes")?;
    let audio_path = media_src.path().join("voice.mp3");
    std::fs::write(&audio_path, b"voice-bytes")?;
    let missing_path = media_src.path().join("not-there.gif");

    let cards = vec![media_card(
        "front <img src=\"photo.png\"> [sound:voice.mp3]",
        "back",
        vec![
            img_path.to_string_lossy().to_string(),
            audio_path.to_string_lossy().to_string(),
            missing_path.to_string_lossy().to_string(),
        ],
    )];

    let out_dir = tempdir()?;
    let apkg_path = out_dir.path().join("media-report.apkg");
    let report = export_multi_template_apkg_report(
        cards,
        "MediaReportDeck".to_string(),
        apkg_path.clone(),
        HashMap::new(),
    )
    .await
    .map_err(|e| anyhow::anyhow!(e))?;

    assert_eq!(report.exported_media, 2);
    assert_eq!(
        report.missing_media,
        vec![missing_path.to_string_lossy().to_string()]
    );

    // zip 内容验证：media 清单 + 数字条目字节
    let file = std::fs::File::open(&apkg_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut manifest_raw = String::new();
    archive
        .by_name("media")?
        .read_to_string(&mut manifest_raw)?;
    let manifest: HashMap<String, String> = serde_json::from_str(&manifest_raw)?;
    let mut names = manifest.values().cloned().collect::<Vec<_>>();
    names.sort();
    assert_eq!(names, vec!["photo.png", "voice.mp3"]);
    for (key, name) in &manifest {
        let mut bytes = Vec::new();
        archive.by_name(key)?.read_to_end(&mut bytes)?;
        let expected: &[u8] = if name == "photo.png" {
            b"photo-bytes"
        } else {
            b"voice-bytes"
        };
        assert_eq!(bytes, expected, "media entry {name}");
    }
    Ok(())
}

/// 超大媒体保护：超过导出上限的文件跳过并进入 missing_media + 告警，导出不中断。
#[tokio::test]
async fn test_export_report_skips_oversized_media_file() -> Result<()> {
    let media_src = tempdir()?;
    let ok_path = media_src.path().join("small.png");
    std::fs::write(&ok_path, b"small-bytes")?;
    // 稀疏文件：逻辑大小超限，不占真实磁盘
    let big_path = media_src.path().join("huge.bin");
    let big = std::fs::File::create(&big_path)?;
    big.set_len(MAX_EXPORT_MEDIA_FILE_BYTES + 1)?;
    drop(big);

    let cards = vec![media_card(
        "front <img src=\"small.png\">",
        "back <img src=\"huge.bin\">",
        vec![
            ok_path.to_string_lossy().to_string(),
            big_path.to_string_lossy().to_string(),
        ],
    )];

    let out_dir = tempdir()?;
    let apkg_path = out_dir.path().join("oversized-media.apkg");
    let report = export_multi_template_apkg_report(
        cards,
        "OversizedDeck".to_string(),
        apkg_path.clone(),
        HashMap::new(),
    )
    .await
    .map_err(|e| anyhow::anyhow!(e))?;

    assert_eq!(report.exported_media, 1);
    assert_eq!(
        report.missing_media,
        vec![big_path.to_string_lossy().to_string()]
    );
    assert!(report
        .warnings
        .iter()
        .any(|warning| warning.contains("huge.bin") && warning.contains("上限")));

    // zip 内只有安全大小的媒体
    let file = std::fs::File::open(&apkg_path)?;
    let mut archive = zip::ZipArchive::new(file)?;
    let mut manifest_raw = String::new();
    archive
        .by_name("media")?
        .read_to_string(&mut manifest_raw)?;
    let manifest: HashMap<String, String> = serde_json::from_str(&manifest_raw)?;
    assert_eq!(manifest.len(), 1);
    assert_eq!(manifest.get("0").map(String::as_str), Some("small.png"));
    Ok(())
}
