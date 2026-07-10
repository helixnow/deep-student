//! AnkiConnect 集成功能
//!
//! 从 commands.rs 拆分：AnkiConnect 连接、导入导出

use crate::commands::{get_template_config, AppState};
use crate::models::{AnkiCard, AnkiGenerationOptions, AppError};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
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

pub(crate) fn sanitize_filename_component(raw: &str, fallback: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return fallback.to_string();
    }

    // 仅保留最后一个 path segment，避免路径穿越/绝对路径覆盖
    let base = Path::new(trimmed)
        .file_name()
        .and_then(|v| v.to_str())
        .unwrap_or(fallback);

    let mut sanitized = base
        .chars()
        .map(|ch| {
            if ch.is_control() || matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                ch
            }
        })
        .collect::<String>();

    sanitized = sanitized.trim().trim_matches('.').to_string();
    while sanitized.contains("..") {
        sanitized = sanitized.replace("..", ".");
    }

    if sanitized.is_empty() || sanitized == "." || sanitized == ".." {
        fallback.to_string()
    } else {
        sanitized
    }
}

pub(crate) fn sanitize_filename_with_extension(
    raw: &str,
    fallback_name: &str,
    extension: &str,
) -> String {
    let safe = sanitize_filename_component(raw, fallback_name);
    let required_ext = extension.trim_start_matches('.');
    if safe
        .to_lowercase()
        .ends_with(&format!(".{}", required_ext.to_lowercase()))
    {
        safe
    } else {
        format!("{}.{}", safe, required_ext)
    }
}

pub(crate) fn build_safe_output_path(
    output_dir: &Path,
    suggested_name: &str,
    fallback_name: &str,
    extension: &str,
) -> PathBuf {
    let safe_name = sanitize_filename_with_extension(suggested_name, fallback_name, extension);
    output_dir.join(safe_name)
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
///
/// 返回同步明细报告（新增/重复/失败分开统计）：
/// - 全部已存在（duplicates == total）属于幂等成功，返回 Ok 而非错误，
///   由前端按 `added == 0 && failed == 0` 展示"均已存在"提示；
/// - 仅当存在真实失败且无任何新增时返回 Err。
#[tauri::command]
pub async fn add_cards_to_anki_connect(
    selected_cards: Vec<crate::models::AnkiCard>,
    deck_name: String,
    mut note_type: String,
    state: State<'_, AppState>,
) -> Result<crate::anki_connect_service::AnkiSyncReport> {
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

    let mut card_models: HashMap<String, String> = HashMap::new();
    let mut templates_by_model: HashMap<String, crate::models::CustomAnkiTemplate> = HashMap::new();
    for card in &selected_cards {
        let Some(template_id) = card
            .template_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        if card.id.trim().is_empty() {
            continue;
        }
        if let Ok(Some(template)) = state.database.get_custom_template_by_id(template_id) {
            let model_name = template.note_type.trim();
            if !model_name.is_empty() {
                card_models.insert(card.id.clone(), model_name.to_string());
                templates_by_model
                    .entry(model_name.to_string())
                    .or_insert(template);
            }
        }
    }

    // 保留卡片 id 顺序，供 Sync 成功后按位回写 anki_note_id receipt
    let card_ids: Vec<String> = selected_cards.iter().map(|c| c.id.clone()).collect();

    // D1 修复：detailed 版本会自动创建缺失模型、用 canAddNotes 把重复与失败分开
    match crate::anki_connect_service::add_notes_to_anki_detailed(
        selected_cards,
        deck_name,
        note_type,
        card_models,
        templates_by_model,
    )
    .await
    {
        Ok(report) => {
            println!(
                "卡片添加完成: 新增 {} 张, 重复 {} 张, 失败 {} 张{}",
                report.added,
                report.duplicates,
                report.failed,
                if report.created_models.is_empty() {
                    String::new()
                } else {
                    format!("（自动创建模型: {}）", report.created_models.join(", "))
                }
            );

            if report.added == 0 && report.failed > 0 {
                let mut reason = String::from("所有卡片同步失败");
                if report.duplicates > 0 {
                    reason.push_str(&format!("（其中 {} 张为重复卡片）", report.duplicates));
                }
                reason.push_str("。请检查 Anki 中是否存在对应笔记类型、卡片字段是否为空");
                Err(AppError::validation(reason))
            } else {
                // M4：按卡片回写 note id + export_status='synced'
                if report.added > 0 {
                    match state
                        .database
                        .write_anki_export_receipts(&card_ids, &report.note_ids)
                    {
                        Ok(n) => {
                            if n > 0 {
                                println!("✅ Anki export receipt 已回写 {} 张卡片", n);
                            }
                        }
                        Err(e) => {
                            // receipt 失败不阻断同步成功（Anki 侧已写入）
                            log::warn!("[add_cards_to_anki_connect] receipt 回写失败: {}", e);
                        }
                    }
                }
                // 含"全部已存在"的幂等成功：duplicates 信息随报告返回前端展示
                Ok(report)
            }
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
    pub document_id: Option<String>,
    pub business_session_id: Option<String>,
    pub message_stable_id: Option<String>,
    pub block_id: Option<String>,
    pub template_id: Option<String>,
    pub cards: Vec<SaveAnkiCardPayload>,
    pub options: Option<AnkiGenerationOptions>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveAnkiCardFailure {
    pub id: String,
    pub error: String,
}

/// `save_anki_cards` 诚实语义响应：
/// - `saved_ids`：本次真正新插入
/// - `duplicated_ids`：已存在且 UPDATE 命中（按 id 更新）
/// - `skipped_ids`：INSERT 被 IGNORE 且 UPDATE 0 行（内容去重/幽灵 id）
/// - `failed`：单卡更新失败明细
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SaveAnkiCardsResponse {
    pub saved_ids: Vec<String>,
    pub task_id: String,
    #[serde(default)]
    pub skipped_ids: Vec<String>,
    #[serde(default)]
    pub duplicated_ids: Vec<String>,
    #[serde(default)]
    pub failed: Vec<SaveAnkiCardFailure>,
}

impl Default for SaveAnkiCardsResponse {
    fn default() -> Self {
        Self {
            saved_ids: Vec::new(),
            task_id: String::new(),
            skipped_ids: Vec::new(),
            duplicated_ids: Vec::new(),
            failed: Vec::new(),
        }
    }
}

/// 单卡 UPDATE 回退结果分类（可单测）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum CardUpdateClassify {
    Duplicated,
    Skipped,
}

pub(crate) fn classify_update_rows_affected(rows_affected: usize) -> CardUpdateClassify {
    if rows_affected > 0 {
        CardUpdateClassify::Duplicated
    } else {
        CardUpdateClassify::Skipped
    }
}

/// 将「未插入」卡片的 UPDATE 结果归入 duplicated / skipped / failed。
pub(crate) fn apply_update_fallback_outcome(
    card_id: &str,
    update_result: std::result::Result<usize, String>,
    duplicated_ids: &mut Vec<String>,
    skipped_ids: &mut Vec<String>,
    failed: &mut Vec<SaveAnkiCardFailure>,
) {
    match update_result {
        Ok(rows) => match classify_update_rows_affected(rows) {
            CardUpdateClassify::Duplicated => duplicated_ids.push(card_id.to_string()),
            CardUpdateClassify::Skipped => skipped_ids.push(card_id.to_string()),
        },
        Err(error) => failed.push(SaveAnkiCardFailure {
            id: card_id.to_string(),
            error,
        }),
    }
}

/// 是否视为可接受的保存结果（含「全部已存在/跳过」幂等成功）。
pub(crate) fn save_anki_cards_outcome_is_acceptable(response: &SaveAnkiCardsResponse) -> bool {
    if !response.saved_ids.is_empty() || !response.duplicated_ids.is_empty() {
        return true;
    }
    // 全部跳过且无失败：内容去重幂等成功
    !response.skipped_ids.is_empty() && response.failed.is_empty()
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
            .document_id
            .clone()
            .filter(|id| !id.trim().is_empty())
            .or_else(|| request.block_id.clone().filter(|id| !id.trim().is_empty()))
            .or_else(|| {
                request
                    .message_stable_id
                    .clone()
                    .filter(|id| !id.trim().is_empty())
            })
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
            .document_id
            .as_ref()
            .filter(|id| !id.trim().is_empty())
            .map(|id| format!("chat_document:{}", id))
            .or_else(|| {
                request
                    .block_id
                    .as_ref()
                    .filter(|id| !id.trim().is_empty())
                    .map(|id| format!("chat_block:{}", id))
            })
            .or_else(|| {
                request
                    .message_stable_id
                    .as_ref()
                    .filter(|id| !id.trim().is_empty())
                    .map(|id| format!("chat_message:{}", id))
            })
            .or_else(|| {
                request
                    .business_session_id
                    .as_ref()
                    .filter(|id| !id.trim().is_empty())
                    .map(|id| format!("chat_session:{}", id))
            })
            .unwrap_or_else(|| "chat_session:anonymous".to_string());

        let document_task = crate::models::DocumentTask {
            id: task_id.clone(),
            document_id,
            original_document_name: format!("Chat Cards {}", subject),
            segment_index: 0,
            content_segment,
            status: crate::models::TaskStatus::Pending,
            created_at: now.clone(),
            updated_at: now.clone(),
            error_message: None,
            anki_generation_options_json: options_json,
        };

        let mut cards_to_insert = Vec::with_capacity(request.cards.len());
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

            cards_to_insert.push(card);
        }

        let mut document_task = document_task;
        document_task.status = crate::models::TaskStatus::Completed;

        let mut saved_ids = Vec::new();
        let mut duplicated_ids = Vec::new();
        let mut skipped_ids = Vec::new();
        let mut failed = Vec::new();

        match database.save_document_task_with_cards_atomic(&document_task, &cards_to_insert) {
            Ok(inserted_ids) => {
                saved_ids = inserted_ids;
                let inserted_set: std::collections::HashSet<&str> =
                    saved_ids.iter().map(|id| id.as_str()).collect();
                // 部分 INSERT 被 IGNORE 的卡片：尝试按 id 更新；0 行记为 skipped
                for card in &cards_to_insert {
                    if inserted_set.contains(card.id.as_str()) {
                        continue;
                    }
                    let update_result = database
                        .update_anki_card_rows(card)
                        .map_err(|e| format!("更新已有卡片失败: {}", e));
                    apply_update_fallback_outcome(
                        &card.id,
                        update_result,
                        &mut duplicated_ids,
                        &mut skipped_ids,
                        &mut failed,
                    );
                }
            }
            Err(e) if e.to_string().contains("no_cards_saved_in_atomic_insert") => {
                // 全部 IGNORE：逐卡 UPDATE，禁止把 0 行当 saved
                for card in &cards_to_insert {
                    let update_result = database
                        .update_anki_card_rows(card)
                        .map_err(|e| format!("更新已有卡片失败: {}", e));
                    apply_update_fallback_outcome(
                        &card.id,
                        update_result,
                        &mut duplicated_ids,
                        &mut skipped_ids,
                        &mut failed,
                    );
                }
            }
            Err(e) => {
                return Err(AppError::database(format!("保存卡片事务失败: {}", e)));
            }
        }

        if let Some(session_id) = request
            .business_session_id
            .as_ref()
            .filter(|id| !id.trim().is_empty())
        {
            database
                .set_document_session_source(&document_task.document_id, session_id)
                .map_err(|e| AppError::database(format!("保存文档来源会话失败: {}", e)))?;
        }

        let response = SaveAnkiCardsResponse {
            saved_ids,
            task_id,
            skipped_ids,
            duplicated_ids,
            failed,
        };

        if !save_anki_cards_outcome_is_acceptable(&response) {
            if !response.failed.is_empty() {
                let detail = response
                    .failed
                    .iter()
                    .map(|f| format!("{}: {}", f.id, f.error))
                    .collect::<Vec<_>>()
                    .join("; ");
                return Err(AppError::validation(format!(
                    "未能保存任何卡片：{}",
                    detail
                )));
            }
            return Err(AppError::validation(
                "未能保存任何卡片，请检查输入数据".to_string(),
            ));
        }

        Ok(response)
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
        // 模板缺失（如已被删除）时不中断整批导出：警告后回退默认 Basic 模板，
        // 与 EnhancedAnkiService::export_apkg_for_selection 行为保持一致
        let config = match get_template_config(tid, &state.database) {
            Ok(config) => Some(config),
            Err(e) => {
                log::warn!(
                    "获取模板配置失败 - 模板ID: {}, 错误: {}，将使用默认模板继续导出",
                    tid,
                    e
                );
                None
            }
        };
        let full_tmpl = match state.database.get_custom_template_by_id(tid) {
            Ok(tmpl) => tmpl,
            Err(e) => {
                log::warn!("获取完整模板失败 - 模板ID: {}, 错误: {}，回退默认模板", tid, e);
                None
            }
        };
        (config, full_tmpl)
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
    let sanitized_filename = sanitize_filename_with_extension(&deck_name, "anki_cards", "apkg");

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
            let sanitized = sanitize_filename_component(&deck_name, "anki_cards");
            export_dir.join(format!("{}_{}.apkg", sanitized, Uuid::new_v4()))
        } else {
            let candidate = std::path::PathBuf::from(path);
            let parent = candidate
                .parent()
                .map(|p| p.to_path_buf())
                .unwrap_or_default();
            let file_name = candidate
                .file_name()
                .and_then(|v| v.to_str())
                .unwrap_or("anki_cards");
            parent.join(sanitize_filename_with_extension(
                file_name,
                "anki_cards",
                "apkg",
            ))
        }
    } else {
        let filename = sanitize_filename_with_extension(&deck_name, "anki_cards", "apkg");
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
mod save_anki_cards_semantics_tests {
    use super::*;

    #[test]
    fn classify_update_rows_affected_distinguishes_duplicated_and_skipped() {
        assert_eq!(
            classify_update_rows_affected(1),
            CardUpdateClassify::Duplicated
        );
        assert_eq!(
            classify_update_rows_affected(0),
            CardUpdateClassify::Skipped
        );
    }

    #[test]
    fn apply_update_fallback_outcome_buckets_results() {
        let mut duplicated = Vec::new();
        let mut skipped = Vec::new();
        let mut failed = Vec::new();

        apply_update_fallback_outcome("a", Ok(1), &mut duplicated, &mut skipped, &mut failed);
        apply_update_fallback_outcome("b", Ok(0), &mut duplicated, &mut skipped, &mut failed);
        apply_update_fallback_outcome(
            "c",
            Err("UNIQUE constraint failed".into()),
            &mut duplicated,
            &mut skipped,
            &mut failed,
        );

        assert_eq!(duplicated, vec!["a".to_string()]);
        assert_eq!(skipped, vec!["b".to_string()]);
        assert_eq!(failed.len(), 1);
        assert_eq!(failed[0].id, "c");
        assert!(failed[0].error.contains("UNIQUE"));
    }

    #[test]
    fn save_outcome_accepts_all_skipped_without_failures() {
        let response = SaveAnkiCardsResponse {
            saved_ids: vec![],
            task_id: "t1".into(),
            skipped_ids: vec!["ghost-1".into()],
            duplicated_ids: vec![],
            failed: vec![],
        };
        assert!(save_anki_cards_outcome_is_acceptable(&response));
    }

    #[test]
    fn save_outcome_rejects_empty_with_failures_only() {
        let response = SaveAnkiCardsResponse {
            saved_ids: vec![],
            task_id: "t1".into(),
            skipped_ids: vec![],
            duplicated_ids: vec![],
            failed: vec![SaveAnkiCardFailure {
                id: "x".into(),
                error: "boom".into(),
            }],
        };
        assert!(!save_anki_cards_outcome_is_acceptable(&response));
    }

    #[test]
    fn save_response_serde_defaults_new_fields() {
        let json = r#"{"savedIds":["a"],"taskId":"t1"}"#;
        let parsed: SaveAnkiCardsResponse =
            serde_json::from_str(json).expect("compat deserialize");
        assert_eq!(parsed.saved_ids, vec!["a".to_string()]);
        assert_eq!(parsed.task_id, "t1");
        assert!(parsed.skipped_ids.is_empty());
        assert!(parsed.duplicated_ids.is_empty());
        assert!(parsed.failed.is_empty());
    }

    #[test]
    fn save_response_serializes_camel_case() {
        let response = SaveAnkiCardsResponse {
            saved_ids: vec!["s1".into()],
            task_id: "t1".into(),
            skipped_ids: vec!["k1".into()],
            duplicated_ids: vec!["d1".into()],
            failed: vec![SaveAnkiCardFailure {
                id: "f1".into(),
                error: "err".into(),
            }],
        };
        let value = serde_json::to_value(&response).expect("serialize");
        assert_eq!(value["savedIds"][0], "s1");
        assert_eq!(value["taskId"], "t1");
        assert_eq!(value["skippedIds"][0], "k1");
        assert_eq!(value["duplicatedIds"][0], "d1");
        assert_eq!(value["failed"][0]["id"], "f1");
        assert_eq!(value["failed"][0]["error"], "err");
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

    #[test]
    fn test_sanitize_filename_component_strips_path_segments() {
        let got = sanitize_filename_component("../unsafe/../../deck?.apkg", "fallback");
        assert_eq!(got, "deck_.apkg");
    }

    #[test]
    fn test_sanitize_filename_with_extension_normalizes_suffix() {
        let got = sanitize_filename_with_extension(" deck-name ", "fallback", "apkg");
        assert_eq!(got, "deck-name.apkg");
    }
}

/// 保存 JSON 文件到临时目录
#[tauri::command]
pub async fn save_json_file(content: String, suggested_name: String) -> Result<String> {
    println!("📝 保存 JSON 文件: {}", suggested_name);

    let trimmed = suggested_name.trim();
    let filename = sanitize_filename_with_extension(trimmed, "anki_cards", "json");
    let output_dir = std::env::temp_dir();
    let file_path = build_safe_output_path(&output_dir, &filename, "anki_cards", "json");

    // 写入文件
    std::fs::write(&file_path, &content)
        .map_err(|e| AppError::validation(format!("写入文件失败: {}", e)))?;

    println!("✅ JSON 文件已保存: {:?}", file_path);
    Ok(file_path.to_string_lossy().to_string())
}
