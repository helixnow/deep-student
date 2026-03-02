//! AnkiConnect 集成功能
//!
//! 从 commands.rs 拆分：AnkiConnect 连接、导入导出

use crate::commands::{get_template_config, AppState};
use crate::models::{AnkiCard, AnkiGenerationOptions, AppError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{State, Window};
use uuid::Uuid;

type Result<T> = std::result::Result<T, AppError>;

fn contains_cloze_markup(text: &str) -> bool {
    let t = text.trim();
    t.contains("{{c") && t.contains("}}")
}

fn card_has_cloze_markup(card: &AnkiCard) -> bool {
    if let Some(text) = card.text.as_deref() {
        if contains_cloze_markup(text) {
            return true;
        }
    }
    if contains_cloze_markup(&card.front) || contains_cloze_markup(&card.back) {
        return true;
    }
    card.extra_fields.values().any(|v| contains_cloze_markup(v))
}

// ==================== AnkiConnect集成功能 ====================

/// 检查AnkiConnect连接状态
#[tauri::command]
pub async fn check_anki_connect_status() -> Result<bool> {
    match crate::anki_connect_service::check_anki_connect_availability().await {
        Ok(available) => Ok(available),
        Err(e) => Err(AppError::validation(e)),
    }
}

/// 获取所有牌组名称
#[tauri::command]
pub async fn get_anki_deck_names() -> Result<Vec<String>> {
    match crate::anki_connect_service::get_deck_names().await {
        Ok(deck_names) => Ok(deck_names),
        Err(e) => Err(AppError::validation(e)),
    }
}

/// 🧩 兼容旧前端：保留 anki_get_deck_names 别名
#[tauri::command]
pub async fn anki_get_deck_names() -> Result<Vec<String>> {
    get_anki_deck_names().await
}

/// 获取所有笔记类型名称
#[tauri::command]
pub async fn get_anki_model_names() -> Result<Vec<String>> {
    match crate::anki_connect_service::get_model_names().await {
        Ok(model_names) => Ok(model_names),
        Err(e) => Err(AppError::validation(e)),
    }
}

/// 创建牌组（如果不存在）
#[tauri::command]
pub async fn create_anki_deck(deck_name: String) -> Result<()> {
    match crate::anki_connect_service::create_deck_if_not_exists(&deck_name).await {
        Ok(_) => Ok(()),
        Err(e) => Err(AppError::validation(e)),
    }
}
/// 将选定的卡片添加到AnkiConnect
#[tauri::command]
pub async fn add_cards_to_anki_connect(
    selected_cards: Vec<crate::models::AnkiCard>,
    deck_name: String,
    mut note_type: String,
) -> Result<Vec<Option<u64>>> {
    if selected_cards.is_empty() {
        return Err(AppError::validation("没有选择任何卡片".to_string()));
    }

    if deck_name.trim().is_empty() {
        return Err(AppError::validation("牌组名称不能为空".to_string()));
    }

    if note_type.trim().is_empty() {
        return Err(AppError::validation("笔记类型不能为空".to_string()));
    }

    // 检查是否为填空题
    let cloze_count = selected_cards
        .iter()
        .filter(|card| card_has_cloze_markup(card))
        .count();
    let all_cloze = cloze_count == selected_cards.len();

    if all_cloze {
        println!("检测到填空题，开始验证笔记类型...");

        // 检查Anki中是否存在名为"Cloze"的笔记类型
        let model_names = crate::anki_connect_service::get_model_names()
            .await
            .map_err(|e| AppError::validation(format!("获取Anki笔记类型失败: {}", e)))?;

        if !model_names.iter().any(|name| name == "Cloze") {
            return Err(AppError::validation(
                "Anki中缺少标准的'Cloze'笔记类型，请在Anki中手动添加一个。".to_string(),
            ));
        }

        // 如果用户选择的不是"Cloze"，但又是填空题，则强制使用"Cloze"
        if note_type != "Cloze" {
            println!(
                "用户选择了非标准的填空题笔记类型 '{}'，将强制使用 'Cloze'。",
                note_type
            );
            note_type = "Cloze".to_string();
        }
    }

    println!(
        "📤 开始添加 {} 张卡片到Anki牌组: {} (笔记类型: {})",
        selected_cards.len(),
        deck_name,
        note_type
    );

    // 首先尝试创建牌组（如果不存在）
    if let Err(e) = crate::anki_connect_service::create_deck_if_not_exists(&deck_name).await {
        println!("创建牌组失败（可能已存在）: {}", e);
    }

    match crate::anki_connect_service::add_notes_to_anki(selected_cards, deck_name, note_type).await
    {
        Ok(note_ids) => {
            let successful_count = note_ids.iter().filter(|id| id.is_some()).count();
            let failed_count = note_ids.len() - successful_count;

            println!(
                "卡片添加完成: 成功 {} 张, 失败 {} 张",
                successful_count, failed_count
            );

            if failed_count > 0 {
                println!("部分卡片添加失败，可能是重复卡片或格式错误");
            }

            Ok(note_ids)
        }
        Err(e) => {
            println!("添加卡片到Anki失败: {}", e);
            Err(AppError::validation(e))
        }
    }
}

/// 导入 APKG 到本机 Anki（通过 AnkiConnect）
#[tauri::command]
pub async fn import_anki_package(path: String) -> Result<bool> {
    match crate::anki_connect_service::import_apkg(&path).await {
        Ok(ok) => Ok(ok),
        Err(e) => Err(AppError::validation(e)),
    }
}

#[derive(Debug, Deserialize)]
pub struct SaveAnkiCardPayload {
    pub id: Option<String>,
    pub front: Option<String>,
    pub back: Option<String>,
    pub text: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub images: Option<Vec<String>>,
    #[serde(default)]
    pub fields: Option<HashMap<String, String>>,
    pub template_id: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SaveAnkiCardsRequest {
    pub business_session_id: Option<String>,
    pub template_id: Option<String>,
    pub cards: Vec<SaveAnkiCardPayload>,
    pub options: Option<AnkiGenerationOptions>,
}

#[derive(Debug, Serialize)]
pub struct SaveAnkiCardsResponse {
    pub saved_ids: Vec<String>,
    pub task_id: String,
}

#[tauri::command]
pub async fn save_anki_cards(
    request: SaveAnkiCardsRequest,
    state: State<'_, AppState>,
) -> Result<SaveAnkiCardsResponse> {
    if request.cards.is_empty() {
        return Err(AppError::validation(
            "No cards provided for saving".to_string(),
        ));
    }

    let database = state.anki_database.clone();
    let response = tokio::task::spawn_blocking(move || -> Result<SaveAnkiCardsResponse> {
        let subject = "未分类".to_string();
        let document_id = request
            .business_session_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string());
        let task_id = Uuid::new_v4().to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let options_json = request
            .options
            .as_ref()
            .map(|opts| serde_json::to_string(opts))
            .transpose()
            .map_err(|e| AppError::validation(format!("无法序列化制卡配置: {}", e)))?
            .unwrap_or_else(|| "{}".to_string());

        let content_segment = request
            .business_session_id
            .as_ref()
            .map(|id| format!("chat_session:{}", id))
            .unwrap_or_else(|| "chat_session:anonymous".to_string());

        let document_task = crate::models::DocumentTask {
            id: task_id.clone(),
            document_id,
            original_document_name: format!("Chat Cards {}", subject),
            segment_index: 0,
            content_segment,
            status: crate::models::TaskStatus::Completed,
            created_at: now.clone(),
            updated_at: now.clone(),
            error_message: None,
            anki_generation_options_json: options_json,
        };

        database
            .insert_document_task(&document_task)
            .map_err(|e| AppError::database(format!("插入任务失败: {}", e)))?;

        let mut saved_ids = Vec::with_capacity(request.cards.len());
        for (index, payload) in request.cards.iter().enumerate() {
            let mut fields = payload.fields.clone().unwrap_or_default();
            let front = payload
                .front
                .clone()
                .or_else(|| fields.get("Front").cloned())
                .unwrap_or_else(|| format!("Chat card {}", index + 1));
            let back = payload
                .back
                .clone()
                .or_else(|| fields.get("Back").cloned())
                .unwrap_or_else(|| "".to_string());
            let card_id = payload
                .id
                .clone()
                .filter(|id| !id.trim().is_empty())
                .unwrap_or_else(|| Uuid::new_v4().to_string());

            // 将 front/back 写回字段，确保导出时存在
            fields.entry("Front".to_string()).or_insert(front.clone());
            fields.entry("Back".to_string()).or_insert(back.clone());

            let mut card = crate::models::AnkiCard {
                front,
                back,
                text: payload.text.clone(),
                tags: payload.tags.clone().unwrap_or_default(),
                images: payload.images.clone().unwrap_or_default(),
                id: card_id.clone(),
                task_id: task_id.clone(),
                is_error_card: false,
                error_content: None,
                created_at: now.clone(),
                updated_at: now.clone(),
                extra_fields: fields,
                template_id: payload
                    .template_id
                    .clone()
                    .or_else(|| request.template_id.clone()),
            };

            if card.text.is_none() {
                card.text = card.extra_fields.get("Text").cloned();
            }

            let inserted = database
                .insert_anki_card(&card)
                .map_err(|e| AppError::database(format!("保存卡片失败: {}", e)))?;
            if inserted {
                saved_ids.push(card_id);
            }
        }

        if saved_ids.is_empty() {
            return Err(AppError::validation(
                "未能保存任何卡片，请检查输入数据".to_string(),
            ));
        }

        Ok(SaveAnkiCardsResponse { saved_ids, task_id })
    })
    .await
    .map_err(|e| {
        AppError::internal(format!(
            "save_anki_cards task join error: {}",
            e.to_string()
        ))
    })??;

    Ok(response)
}

/// 导出选定的卡片为.apkg文件
#[tauri::command]
pub async fn export_cards_as_apkg(
    selected_cards: Vec<crate::models::AnkiCard>,
    deck_name: String,
    note_type: String,
    state: State<'_, AppState>,
) -> Result<String> {
    export_cards_as_apkg_with_template(selected_cards, deck_name, note_type, None, state).await
}
/// 导出选定的卡片为.apkg文件（支持模板）
#[tauri::command]
pub async fn export_cards_as_apkg_with_template(
    selected_cards: Vec<crate::models::AnkiCard>,
    deck_name: String,
    mut note_type: String,
    template_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<String> {
    if selected_cards.is_empty() {
        return Err(AppError::validation("没有选择任何卡片".to_string()));
    }

    // 多模板导出修复：从每张卡片的 template_id 解析模板
    // 优先使用显式传入的 template_id，其次使用卡片自身的 template_id
    let effective_template_id: Option<String> = template_id.clone().or_else(|| {
        // 从卡片中取第一个有效的 template_id（所有卡片都应有 template_id）
        selected_cards.iter().find_map(|card| {
            card.template_id
                .as_deref()
                .filter(|s| !s.trim().is_empty())
                .map(|s| s.to_string())
        })
    });
    let (template_config, full_template) = if let Some(ref tid) = effective_template_id {
        let config =
            get_template_config(tid, &state.database).map_err(|e| AppError::validation(e))?;
        let full_tmpl = state
            .database
            .get_custom_template_by_id(tid)
            .map_err(|e| AppError::validation(format!("获取模板失败: {}", e)))?;
        (Some(config), full_tmpl)
    } else {
        // 没有任何模板可用 — 直接用 Basic 兜底而不是导出空壳
        (None, None)
    };

    if deck_name.trim().is_empty() {
        return Err(AppError::validation("牌组名称不能为空".to_string()));
    }

    if note_type.trim().is_empty() {
        return Err(AppError::validation("笔记类型不能为空".to_string()));
    }

    // 检查是否为填空题
    let cloze_count = selected_cards
        .iter()
        .filter(|card| card_has_cloze_markup(card))
        .count();
    let all_cloze = cloze_count == selected_cards.len();

    if all_cloze && note_type != "Cloze" {
        println!("检测到填空题，但笔记类型不是 'Cloze'。导出时将强制使用 'Cloze' 类型。");
        note_type = "Cloze".to_string();
    }

    println!(
        "📦 开始导出 {} 张卡片为.apkg文件 (笔记类型: {})",
        selected_cards.len(),
        note_type
    );

    // 生成默认文件名和路径（在移动端使用可写的临时目录，避免 iOS 权限问题）
    let sanitized_filename = format!("{}.apkg", deck_name.replace("/", "_").replace("\\", "_"));

    // 在 iOS/Android：始终使用临时目录（可写）
    // 在桌面端：优先 HOME/Downloads，不可写则回退到临时目录
    let output_path = if cfg!(any(target_os = "ios", target_os = "android")) {
        std::env::temp_dir().join(&sanitized_filename)
    } else {
        // 尝试定位 HOME/Downloads
        let home_dir = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".to_string());
        let downloads_dir = std::path::PathBuf::from(home_dir).join("Downloads");

        // 如果目录可创建/已存在则使用，否则回退到临时目录
        match std::fs::create_dir_all(&downloads_dir) {
            Ok(_) => downloads_dir.join(&sanitized_filename),
            Err(_) => std::env::temp_dir().join(&sanitized_filename),
        }
    };

    println!("📁 导出路径: {:?}", output_path);

    match crate::apkg_exporter_service::export_cards_to_apkg_with_full_template(
        selected_cards,
        deck_name,
        note_type,
        output_path.clone(),
        template_config,
        full_template,
    )
    .await
    {
        Ok(_) => {
            println!(".apkg文件导出成功: {:?}", output_path);
            Ok(output_path.to_string_lossy().to_string())
        }
        Err(e) => {
            println!(".apkg文件导出失败: {}", e);
            Err(AppError::validation(e))
        }
    }
}

/// 多模板 APKG 导出（前端导出按钮直接调用）
/// 每种 template_id 创建独立的 Anki model，每张卡片用自己的模板渲染
#[tauri::command]
pub async fn export_multi_template_apkg(
    cards: Vec<crate::models::AnkiCard>,
    deck_name: String,
    output_path: Option<String>,
    state: State<'_, AppState>,
    window: Window,
) -> Result<String> {
    if cards.is_empty() {
        return Err(AppError::validation("没有卡片可以导出"));
    }

    let db = &state.database;

    // 从卡片中收集所有唯一的 template_id，加载对应模板
    let mut template_map = std::collections::HashMap::new();
    for card in &cards {
        if let Some(tid) = card.template_id.as_deref().filter(|s| !s.trim().is_empty()) {
            if !template_map.contains_key(tid) {
                if let Ok(Some(t)) = db.get_custom_template_by_id(tid) {
                    template_map.insert(tid.to_string(), t);
                }
            }
        }
    }

    let requested_output = output_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let target_uri = requested_output
        .as_ref()
        .filter(|path| crate::unified_file_manager::is_virtual_uri(path))
        .cloned();

    let mut output_path = if let Some(path) = requested_output.as_deref() {
        if target_uri.is_some() {
            let export_dir = state
                .file_manager
                .get_writable_app_data_dir()
                .join("temp_apkg_export");
            std::fs::create_dir_all(&export_dir)
                .map_err(|e| AppError::file_system(format!("创建 APKG 临时目录失败: {}", e)))?;
            let sanitized = deck_name.replace('/', "_").replace('\\', "_");
            export_dir.join(format!("{}_{}.apkg", sanitized, Uuid::new_v4()))
        } else {
            std::path::PathBuf::from(path)
        }
    } else {
        let sanitized = deck_name.replace('/', "_").replace('\\', "_");
        let filename = format!("{}.apkg", sanitized);
        if cfg!(any(target_os = "ios", target_os = "android")) {
            std::env::temp_dir().join(&filename)
        } else {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .unwrap_or_else(|_| ".".to_string());
            let downloads = std::path::PathBuf::from(home).join("Downloads");
            match std::fs::create_dir_all(&downloads) {
                Ok(_) => downloads.join(&filename),
                Err(_) => std::env::temp_dir().join(&filename),
            }
        }
    };
    if output_path.extension().is_none() {
        output_path.set_extension("apkg");
    }

    if let Err(e) = crate::apkg_exporter_service::export_multi_template_apkg(
        cards.into_iter().filter(|c| !c.is_error_card).collect(),
        deck_name,
        output_path.clone(),
        template_map,
    )
    .await
    {
        if target_uri.is_some() {
            if let Err(cleanup_err) = std::fs::remove_file(&output_path) {
                log::warn!(
                    "[anki_export] 导出失败后清理临时 APKG 文件失败 ({}): {}",
                    output_path.display(),
                    cleanup_err
                );
            }
        }
        return Err(AppError::validation(e));
    }

    if let Some(target_path) = target_uri {
        let staged = output_path.to_string_lossy().to_string();
        if let Err(err) = crate::unified_file_manager::copy_file(&window, &staged, &target_path) {
            if let Err(cleanup_err) = std::fs::remove_file(&output_path) {
                log::warn!(
                    "[anki_export] 写入目标 URI 失败后清理临时 APKG 文件失败 ({}): {}",
                    output_path.display(),
                    cleanup_err
                );
            }
            return Err(AppError::file_system(format!("写入目标 URI 失败: {}", err)));
        }
        if let Err(e) = std::fs::remove_file(&output_path) {
            log::warn!(
                "[anki_export] 清理临时 APKG 文件失败 ({}): {}",
                output_path.display(),
                e
            );
        }
        Ok(target_path)
    } else {
        Ok(output_path.to_string_lossy().to_string())
    }
}

// 🔧 P0-30 修复：添加 batch_export_cards 和 save_json_file 命令
// =================== Batch Export Commands ===================

/// 批量导出卡片请求参数
#[derive(Debug, Deserialize, Serialize)]
pub struct BatchExportNote {
    pub fields: std::collections::HashMap<String, String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub images: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct BatchExportOptions {
    #[serde(alias = "deckName")]
    pub deck_name: Option<String>,
    #[serde(alias = "noteType")]
    pub note_type: Option<String>,
    #[serde(alias = "templateId")]
    pub template_id: Option<String>,
}

fn batch_export_note_to_anki_card(
    note: BatchExportNote,
    index: usize,
    template_id: Option<String>,
) -> crate::models::AnkiCard {
    let front = note.fields.get("Front").cloned().unwrap_or_default();
    let back = note.fields.get("Back").cloned().unwrap_or_default();
    let text = note
        .fields
        .get("Text")
        .cloned()
        .or_else(|| note.fields.get("text").cloned());

    crate::models::AnkiCard {
        id: format!("batch_{}", index),
        front,
        back,
        // APKG exporter reads `card.text` for Cloze "Text" field.
        text,
        tags: note.tags,
        images: note.images,
        extra_fields: note.fields,
        template_id,
        task_id: String::new(),
        is_error_card: false,
        error_content: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        updated_at: chrono::Utc::now().to_rfc3339(),
    }
}

/// 批量导出卡片 - 支持多种格式
#[tauri::command]
pub async fn batch_export_cards(
    notes: Vec<BatchExportNote>,
    format: String,
    options: BatchExportOptions,
    state: State<'_, AppState>,
) -> Result<String> {
    println!("📦 批量导出 {} 张卡片，格式: {}", notes.len(), format);

    let deck_name = options.deck_name.unwrap_or_else(|| "Default".to_string());
    let note_type = options.note_type.unwrap_or_else(|| "Basic".to_string());
    let anki_cards: Vec<crate::models::AnkiCard> = notes
        .into_iter()
        .enumerate()
        .map(|(i, note)| batch_export_note_to_anki_card(note, i, options.template_id.clone()))
        .collect();

    match format.as_str() {
        "apkg" => {
            // 调用现有的 APKG 导出逻辑
            export_cards_as_apkg_with_template(
                anki_cards,
                deck_name,
                note_type,
                options.template_id,
                state,
            )
            .await
        }
        "json" => {
            // JSON 导出
            let json_content = serde_json::to_string_pretty(&anki_cards)
                .map_err(|e| AppError::validation(format!("JSON 序列化失败: {}", e)))?;
            let filename = format!("anki_cards_{}.json", chrono::Utc::now().timestamp());
            save_json_file(json_content, filename).await
        }
        "anki-connect" => {
            // AnkiConnect 导出暂时返回成功（实际由前端处理）
            Ok("anki-connect export delegated to frontend".to_string())
        }
        _ => Err(AppError::validation(format!(
            "不支持的导出格式: {}",
            format
        ))),
    }
}

#[cfg(test)]
mod batch_export_tests {
    use super::*;

    #[test]
    fn test_batch_export_note_to_anki_card_sets_text_from_fields() {
        let mut fields = std::collections::HashMap::new();
        fields.insert("Front".to_string(), "".to_string());
        fields.insert("Back".to_string(), "".to_string());
        fields.insert("Text".to_string(), "a {{c1::b}} c".to_string());

        let note = BatchExportNote {
            fields,
            tags: vec![],
            images: vec![],
        };

        let card = batch_export_note_to_anki_card(note, 0, Some("cloze".to_string()));
        assert_eq!(card.text, Some("a {{c1::b}} c".to_string()));
    }

    #[test]
    fn test_batch_export_note_to_anki_card_fallback_text_key() {
        let mut fields = std::collections::HashMap::new();
        fields.insert("text".to_string(), "x {{c1::y}} z".to_string());

        let note = BatchExportNote {
            fields,
            tags: vec![],
            images: vec![],
        };

        let card = batch_export_note_to_anki_card(note, 1, None);
        assert_eq!(card.text, Some("x {{c1::y}} z".to_string()));
    }
}

/// 保存 JSON 文件到临时目录
#[tauri::command]
pub async fn save_json_file(content: String, suggested_name: String) -> Result<String> {
    println!("📝 保存 JSON 文件: {}", suggested_name);

    let trimmed = suggested_name.trim();
    let base_name = if trimmed.is_empty() {
        "anki_cards.json".to_string()
    } else {
        trimmed.to_string()
    };
    let filename = if base_name.to_lowercase().ends_with(".json") {
        base_name
    } else {
        format!("{}.json", base_name)
    };
    let output_dir = std::env::temp_dir();
    let file_path = output_dir.join(&filename);

    // 写入文件
    std::fs::write(&file_path, &content)
        .map_err(|e| AppError::validation(format!("写入文件失败: {}", e)))?;

    println!("✅ JSON 文件已保存: {:?}", file_path);
    Ok(file_path.to_string_lossy().to_string())
}
