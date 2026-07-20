//! 增强 Anki 命令
//!
//! 从 commands.rs 拆分：增强版文档处理、制卡、记忆提取

use crate::commands::{export_cards_as_apkg_with_template, AppState};
use crate::models::{
    AnkiDocumentGenerationRequest, AnkiGenerationOptions, AppError, MemoryCandidate,
};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::{State, Window};

type Result<T> = std::result::Result<T, AppError>;

fn has_valid_cloze_marker(text: &str) -> bool {
    let mut search_from = 0usize;
    while let Some(relative_start) = text[search_from..].find("{{c") {
        let number_start = search_from + relative_start + 3;
        let digit_count = text[number_start..]
            .bytes()
            .take_while(u8::is_ascii_digit)
            .count();
        if digit_count == 0 {
            search_from = number_start;
            continue;
        }
        let number_end = number_start + digit_count;
        let Ok(number) = text[number_start..number_end].parse::<u64>() else {
            search_from = number_end;
            continue;
        };
        if number == 0 || !text[number_end..].starts_with("::") {
            search_from = number_end;
            continue;
        }
        let answer_start = number_end + 2;
        let remainder = &text[answer_start..];
        let Some(relative_close) = remainder.find("}}") else {
            return false;
        };
        if let Some(relative_nested) = remainder.find("{{c") {
            if relative_nested < relative_close {
                search_from = answer_start + relative_nested;
                continue;
            }
        }
        let body = &remainder[..relative_close];
        let answer = body.split_once("::").map_or(body, |(answer, _)| answer);
        if !answer.trim().is_empty() {
            return true;
        }
        search_from = answer_start + relative_close + 2;
    }
    false
}

fn has_valid_cloze_text(card: &crate::models::AnkiCard) -> bool {
    card.text.as_deref().is_some_and(has_valid_cloze_marker)
        || card.extra_fields.iter().any(|(field, value)| {
            field.trim().eq_ignore_ascii_case("text") && has_valid_cloze_marker(value)
        })
        || has_valid_cloze_marker(&card.front)
}

fn validate_anki_card_update(card: &crate::models::AnkiCard) -> Result<()> {
    if has_valid_cloze_text(card) {
        return Ok(());
    }
    if card.front.trim().is_empty() {
        return Err(AppError::validation("卡片正面不能为空"));
    }
    if card.back.trim().is_empty() {
        return Err(AppError::validation("卡片背面不能为空"));
    }
    Ok(())
}

// ★ 2026-02 清理：以下内联 JSON 清理函数已随 extract_memories_from_chat 一起删除
// - clean_ai_response_for_json_inline
// - fix_json_escape_characters_inline

// =================== Enhanced Anki Commands ===================
/// 开始文档处理 - 增强版 Anki 制卡
#[tauri::command]
pub async fn start_enhanced_document_processing(
    document_content: String,
    original_document_name: String,
    options: AnkiGenerationOptions,
    window: Window,
    state: State<'_, AppState>,
) -> Result<String> {
    println!(
        "开始增强文档处理: 文档名={}, 内容长度={}",
        original_document_name,
        document_content.len()
    );

    // 创建增强ANKI服务实例
    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );

    // 构建请求
    let request = AnkiDocumentGenerationRequest {
        document_content,
        original_document_name: Some(original_document_name),
        options: Some(options),
    };

    // 开始处理
    let document_id = enhanced_service
        .start_document_processing(request, window)
        .await?;

    println!("文档处理已启动: {}", document_id);
    Ok(document_id)
}
/// 暂停文档处理（硬暂停）
#[tauri::command]
#[allow(non_snake_case)] // Tauri 前端传入 camelCase 参数名
pub async fn pause_document_processing(
    documentId: String,
    window: Window,
    state: State<'_, AppState>,
) -> Result<bool> {
    println!("暂停文档处理: {}", documentId);
    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );
    enhanced_service
        .pause_document_processing(documentId, window)
        .await?;
    Ok(true)
}

/// 取消文档处理（仅停止生成，保留已生成的任务与卡片）
#[tauri::command]
#[allow(non_snake_case)] // Tauri 前端传入 camelCase 参数名
pub async fn cancel_document_processing(
    documentId: String,
    window: Window,
    state: State<'_, AppState>,
) -> Result<bool> {
    println!("取消文档处理: {}", documentId);
    if documentId.is_empty() {
        return Err(AppError::validation("文档ID不能为空"));
    }
    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );
    enhanced_service
        .cancel_document_processing(documentId, window)
        .await?;
    Ok(true)
}

/// 恢复文档处理
#[tauri::command]
#[allow(non_snake_case)] // Tauri 前端传入 camelCase 参数名
pub async fn resume_document_processing(
    documentId: String,
    window: Window,
    state: State<'_, AppState>,
) -> Result<bool> {
    println!("恢复文档处理: {}", documentId);
    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );
    enhanced_service
        .resume_document_processing(documentId, window)
        .await?;
    Ok(true)
}

/// 获取文档处理状态（调试/前端校验用）
#[tauri::command]
#[allow(non_snake_case)] // Tauri 前端传入 camelCase 参数名
pub async fn get_document_processing_state(
    documentId: String,
    state: State<'_, AppState>,
) -> Result<crate::enhanced_anki_service::DocumentStateDto> {
    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );
    Ok(enhanced_service.get_document_state(documentId).await)
}

/// 获取文档任务计数（冒烟测试/调试用途）
#[tauri::command]
#[allow(non_snake_case)] // Tauri 前端传入 camelCase 参数名
pub async fn get_document_task_counts(
    documentId: String,
    state: State<'_, AppState>,
) -> Result<crate::enhanced_anki_service::DocumentTaskCountsDto> {
    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );
    Ok(enhanced_service.get_document_task_counts(documentId).await)
}

/// 手动触发任务处理
#[tauri::command]
pub async fn trigger_task_processing(
    task_id: String,
    window: Window,
    state: State<'_, AppState>,
) -> Result<()> {
    println!("触发任务处理: {}", task_id);

    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );

    enhanced_service
        .trigger_task_processing(task_id, window)
        .await?;
    Ok(())
}

/// 获取文档的所有任务
#[tauri::command]
#[allow(non_snake_case)] // Tauri 前端传入 camelCase 参数名
pub async fn get_document_tasks(
    documentId: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::DocumentTask>> {
    println!("获取文档任务列表: {}", documentId);

    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );

    let tasks = enhanced_service.get_document_tasks(documentId)?;
    println!("找到 {} 个任务", tasks.len());
    Ok(tasks)
}
/// 获取任务的所有卡片
#[tauri::command]
pub async fn get_task_cards(
    task_id: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::AnkiCard>> {
    println!("🃏 获取任务卡片: {}", task_id);

    // 统一使用 Anki 专属数据库句柄（与制卡写入路径一致），
    // 避免未来拆库时读写落在不同数据库
    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );

    let cards = enhanced_service.get_task_cards(task_id)?;
    println!("找到 {} 张卡片", cards.len());
    Ok(cards)
}
/// 更新ANKI卡片
#[tauri::command]
pub async fn update_anki_card(
    card: crate::models::AnkiCard,
    state: State<'_, AppState>,
) -> Result<()> {
    println!("更新ANKI卡片: {}", card.id);

    // Cloze 的 Text 是有效内容，Extra/back 可以为空；Basic 仍需完整正反面。
    validate_anki_card_update(&card)?;

    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );

    enhanced_service.update_anki_card(card)?;
    println!("卡片更新成功");
    Ok(())
}

/// 删除ANKI卡片
#[tauri::command]
pub async fn delete_anki_card(card_id: String, state: State<'_, AppState>) -> Result<bool> {
    println!("删除ANKI卡片: {}", card_id);

    if card_id.is_empty() {
        return Err(AppError::validation("卡片ID不能为空"));
    }

    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );

    enhanced_service.delete_anki_card(card_id)?;
    println!("卡片删除成功");
    Ok(true)
}

/// 删除文档任务及其所有卡片
#[tauri::command]
pub async fn delete_document_task(task_id: String, state: State<'_, AppState>) -> Result<bool> {
    println!("删除文档任务: {}", task_id);

    if task_id.is_empty() {
        return Err(AppError::validation("任务ID不能为空"));
    }

    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );

    enhanced_service.delete_document_task(task_id)?;
    println!("任务删除成功");
    Ok(true)
}

/// 删除整个文档会话（所有任务和卡片）
#[tauri::command]
#[allow(non_snake_case)] // Tauri 前端传入 camelCase 参数名
pub async fn delete_document_session(
    documentId: String,
    state: State<'_, AppState>,
) -> Result<bool> {
    println!("删除文档会话: {}", documentId);

    if documentId.is_empty() {
        return Err(AppError::validation("文档ID不能为空"));
    }

    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );

    enhanced_service.delete_document_session(documentId).await?;
    println!("文档会话删除成功");
    Ok(true)
}
/// 导出选定内容为APKG文件
#[tauri::command]
#[allow(non_snake_case)] // Tauri 前端传入 camelCase 参数名
pub async fn export_apkg_for_selection(
    documentId: Option<String>,
    taskIds: Option<Vec<String>>,
    cardIds: Option<Vec<String>>,
    options: AnkiGenerationOptions,
    state: State<'_, AppState>,
) -> Result<String> {
    println!("📦 导出选定内容为APKG文件");

    // 验证至少选择了一种导出内容
    if documentId.is_none() && taskIds.is_none() && cardIds.is_none() {
        return Err(AppError::validation(
            "必须选择要导出的内容（文档、任务或卡片）",
        ));
    }

    let enhanced_service = crate::enhanced_anki_service::EnhancedAnkiService::new(
        state.anki_database.clone(),
        state.llm_manager.clone(),
    );

    let export_path = enhanced_service
        .export_apkg_for_selection(documentId, taskIds, cardIds, options)
        .await?;

    println!("APKG文件导出成功: {}", export_path);
    Ok(export_path)
}

/// 获取文档的所有卡片（用于导出预览）
#[tauri::command]
#[allow(non_snake_case)] // Tauri 前端传入 camelCase 参数名
pub async fn get_document_cards(
    documentId: String,
    state: State<'_, AppState>,
) -> Result<Vec<crate::models::AnkiCard>> {
    println!("获取文档的所有卡片: {}", documentId);

    let cards = crate::anki::AnkiCardRepository::list_by_document(
        state.anki_database.as_ref(),
        &documentId,
    )
    .map_err(|e| AppError::database(format!("获取文档卡片失败: {}", e)))?;

    println!("找到 {} 张卡片", cards.len());
    Ok(cards)
}

fn build_anki_library_list_response(
    items: Vec<crate::models::AnkiLibraryCard>,
    page: u32,
    page_size: u32,
    total: u64,
    review_states: Vec<crate::fsrs_review_service::FsrsAgentReviewStateSnapshot>,
) -> Result<serde_json::Value> {
    let mut reviews_by_card = review_states
        .into_iter()
        .map(|state| (state.anki_card_id.clone(), state))
        .collect::<HashMap<_, _>>();

    let items = items
        .into_iter()
        .map(|item| {
            let card_id = item.card.id.clone();
            let version = item.card.updated_at.clone();
            let review_state = reviews_by_card.remove(&card_id);
            let review_version = review_state.as_ref().map(|state| state.review_version);
            let latest_review = review_state.and_then(|state| {
                state.latest_review.map(|latest| {
                    serde_json::json!({
                        "logId": latest.log_id,
                        "reviewedAt": chrono::DateTime::<chrono::Utc>::from_timestamp_millis(
                            latest.review_ms,
                        )
                        .map(|timestamp| timestamp.to_rfc3339()),
                        "rating": latest.rating,
                        "undoable": latest.undoable,
                    })
                })
            });
            let mut value = serde_json::to_value(item)
                .map_err(|error| AppError::internal(format!("序列化卡片库条目失败: {error}")))?;
            let object = value
                .as_object_mut()
                .ok_or_else(|| AppError::internal("卡片库条目序列化结果不是对象"))?;
            object.insert("version".to_string(), serde_json::Value::String(version));
            object.insert(
                "reviewVersion".to_string(),
                serde_json::to_value(review_version).map_err(|error| {
                    AppError::internal(format!("序列化卡片复习版本失败: {error}"))
                })?,
            );
            object.insert(
                "latestReview".to_string(),
                latest_review.unwrap_or(serde_json::Value::Null),
            );
            Ok(value)
        })
        .collect::<Result<Vec<_>>>()?;

    Ok(serde_json::json!({
        "items": items,
        "page": page,
        "pageSize": page_size,
        "total": total,
    }))
}

/// 分页查询卡片库（Prompt C）
#[tauri::command]
pub async fn list_anki_library_cards(
    request: crate::models::ListAnkiCardsRequest,
    state: State<'_, AppState>,
) -> Result<serde_json::Value> {
    let page = request.page.unwrap_or(1).max(1);
    let page_size = request.page_size.unwrap_or(12).clamp(1, 200);
    let (items, total) = state
        .anki_database
        .list_anki_library_cards(
            None,
            request.template_id.as_deref(),
            request.search.as_deref(),
            page,
            page_size,
        )
        .map_err(|e| AppError::database(format!("获取卡片库失败: {}", e)))?;

    let card_ids = items
        .iter()
        .map(|item| item.card.id.clone())
        .collect::<Vec<_>>();
    let review_service =
        crate::fsrs_review_service::FsrsReviewService::new(state.anki_database.clone());
    let mut review_states = Vec::with_capacity(card_ids.len());
    for chunk in card_ids.chunks(100) {
        review_states.extend(
            review_service
                .get_review_states_for_library(crate::database::AnkiLibraryScope::agent(), chunk)?,
        );
    }

    build_anki_library_list_response(items, page, page_size, total, review_states)
}

/// 🔧 Phase 1: 恢复卡住的制卡任务（崩溃恢复）
#[tauri::command]
pub async fn recover_stuck_document_tasks(state: State<'_, AppState>) -> Result<u32> {
    log::info!("[enhanced_anki] Recovering stuck document tasks...");
    let count = state
        .anki_database
        .recover_stuck_document_tasks()
        .map_err(|e| AppError::database(format!("恢复卡住任务失败: {}", e)))?;
    log::info!("[enhanced_anki] Recovered {} stuck tasks", count);
    Ok(count)
}

/// 🔧 Phase 1: 按 document_id 汇总任务列表（任务管理页面）
#[tauri::command]
pub async fn list_document_sessions(
    limit: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Vec<serde_json::Value>> {
    let limit = limit.unwrap_or(50);

    // 诊断：打印 DB 路径和 document_tasks 表行数
    let mut diag_count: i64 = -1;
    if let Some(path) = state.anki_database.db_path() {
        tracing::info!("[list_document_sessions] DB path: {:?}", path);
    }
    if let Ok(conn) = state.anki_database.get_conn_safe() {
        diag_count = conn
            .query_row("SELECT COUNT(*) FROM document_tasks", [], |row| row.get(0))
            .unwrap_or(-1);
        let card_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM anki_cards", [], |row| row.get(0))
            .unwrap_or(-1);
        // 检查 source_session_id 列是否存在
        let has_col: bool = conn
            .query_row(
                "SELECT COUNT(*) FROM pragma_table_info('document_tasks') WHERE name='source_session_id'",
                [],
                |row| row.get::<_, i32>(0).map(|c| c > 0),
            )
            .unwrap_or(false);
        tracing::info!(
            "[list_document_sessions] document_tasks rows={}, anki_cards rows={}, has_source_session_id={}",
            diag_count, card_count, has_col
        );
    }

    let sessions = match state.anki_database.list_document_sessions(limit) {
        Ok(s) => {
            tracing::info!("[list_document_sessions] returned {} sessions", s.len());
            if s.is_empty() && diag_count > 0 {
                tracing::warn!(
                    "[list_document_sessions] BUG: document_tasks has {} rows but query returned 0 sessions!",
                    diag_count
                );
            }
            s
        }
        Err(e) => {
            tracing::error!("[list_document_sessions] SQL query FAILED: {:?}", e);
            return Err(AppError::database(format!("获取任务列表失败: {}", e)));
        }
    };
    Ok(sessions)
}

/// 🔧 Phase 2: 卡片统计数据
#[tauri::command]
pub async fn get_anki_stats(state: State<'_, AppState>) -> Result<serde_json::Value> {
    state
        .anki_database
        .get_anki_stats()
        .map_err(|e| AppError::database(format!("获取统计失败: {}", e)))
}

/// 导出/下载卡片库
#[tauri::command]
pub async fn export_anki_cards(
    request: crate::models::ExportAnkiCardsRequest,
    state: State<'_, AppState>,
) -> Result<crate::models::ExportAnkiCardsResponse> {
    if request.ids.is_empty() {
        return Err(AppError::validation("没有选择任何卡片"));
    }

    let cards = state
        .anki_database
        .get_cards_by_ids(&request.ids)
        .map_err(|e| AppError::database(format!("加载卡片失败: {}", e)))?;
    if cards.is_empty() {
        return Err(AppError::not_found("未找到卡片"));
    }

    let format = request.format.trim().to_lowercase();
    if format == "json" {
        let filename = format!(
            "anki_cards_{}.json",
            chrono::Utc::now().format("%Y%m%d%H%M%S")
        );
        let output_path = std::env::temp_dir().join(filename);
        let payload = serde_json::to_string_pretty(&cards)
            .map_err(|e| AppError::internal(format!("序列化卡片失败: {}", e)))?;
        std::fs::write(&output_path, payload)
            .map_err(|e| AppError::file_system(format!("写入卡片JSON失败: {}", e)))?;
        let size_bytes = std::fs::metadata(&output_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        return Ok(crate::models::ExportAnkiCardsResponse {
            file_path: output_path.to_string_lossy().to_string(),
            size_bytes,
            format: "json".to_string(),
        });
    }

    let deck_name = request
        .deck_name
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "ChatAnki".to_string());
    let note_type = request
        .note_type
        .clone()
        .filter(|v| !v.trim().is_empty())
        .unwrap_or_else(|| "Basic".to_string());

    let file_path = export_cards_as_apkg_with_template(
        cards,
        deck_name,
        note_type,
        request.template_id.clone(),
        state,
    )
    .await?;
    let size_bytes = std::fs::metadata(&file_path)
        .map(|meta| meta.len())
        .unwrap_or(0);

    Ok(crate::models::ExportAnkiCardsResponse {
        file_path,
        size_bytes,
        format: "apkg".to_string(),
    })
}

/// 待处理记忆候选响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PendingMemoryCandidatesResponse {
    pub conversation_id: String,
    #[serde(default)] // subject 已废弃，保留字段以兼容旧数据
    pub subject: String,
    pub candidates: Vec<MemoryCandidate>,
    pub created_at: String,
}

/// 查询待处理的记忆候选
#[tauri::command]
pub async fn get_pending_memory_candidates(
    conversation_id: String,
    state: State<'_, AppState>,
) -> Result<Option<PendingMemoryCandidatesResponse>> {
    let trimmed_id = conversation_id.trim().to_string();
    if trimmed_id.is_empty() {
        return Err(AppError::validation("conversation_id 不能为空".to_string()));
    }

    // 兼容前端传入的 chat-xxx 格式 ID
    let normalized_id = trimmed_id
        .strip_prefix("chat-")
        .unwrap_or(&trimmed_id)
        .to_string();

    let conn = state.database.get_conn_safe()?;

    // 清理过期的候选
    conn.execute(
        "DELETE FROM pending_memory_candidates WHERE expires_at < datetime('now')",
        [],
    )?;

    // 查询待处理的候选
    let mut stmt = conn.prepare(
        "SELECT subject, content, category, origin, user_edited, created_at
         FROM pending_memory_candidates
         WHERE conversation_id = ?1 AND status = 'pending'
         ORDER BY id ASC",
    )?;

    let mut rows = stmt.query(params![&normalized_id])?;
    let mut candidates = Vec::new();
    let mut subject = String::new();
    let mut created_at = String::new();

    while let Some(row) = rows.next()? {
        if subject.is_empty() {
            subject = row.get(0)?;
            created_at = row.get(5)?;
        }
        candidates.push(MemoryCandidate {
            content: row.get(1)?,
            category: row.get(2)?,
        });
    }

    if candidates.is_empty() {
        return Ok(None);
    }

    Ok(Some(PendingMemoryCandidatesResponse {
        conversation_id: normalized_id,
        subject,
        candidates,
        created_at,
    }))
}

/// 清除/忽略待处理的记忆候选
#[tauri::command]
pub async fn dismiss_pending_memory_candidates(
    conversation_id: String,
    state: State<'_, AppState>,
) -> Result<u32> {
    let trimmed_id = conversation_id.trim().to_string();
    if trimmed_id.is_empty() {
        return Err(AppError::validation("conversation_id 不能为空".to_string()));
    }

    // 兼容前端传入的 chat-xxx 格式 ID
    let normalized_id = trimmed_id
        .strip_prefix("chat-")
        .unwrap_or(&trimmed_id)
        .to_string();

    let conn = state.database.get_conn_safe()?;

    let affected = conn.execute(
        "UPDATE pending_memory_candidates SET status = 'dismissed' WHERE conversation_id = ?1 AND status = 'pending'",
        params![&normalized_id],
    )?;

    println!("已忽略 {} 条待处理记忆候选: {}", affected, normalized_id);
    Ok(affected as u32)
}

/// 标记待处理记忆候选为已保存
#[tauri::command]
pub async fn mark_pending_memory_candidates_saved(
    conversation_id: String,
    state: State<'_, AppState>,
) -> Result<u32> {
    let trimmed_id = conversation_id.trim().to_string();
    if trimmed_id.is_empty() {
        return Err(AppError::validation("conversation_id 不能为空".to_string()));
    }

    // 兼容前端传入的 chat-xxx 格式 ID
    let normalized_id = trimmed_id
        .strip_prefix("chat-")
        .unwrap_or(&trimmed_id)
        .to_string();

    let conn = state.database.get_conn_safe()?;

    let affected = conn.execute(
        "UPDATE pending_memory_candidates SET status = 'saved' WHERE conversation_id = ?1 AND status = 'pending'",
        params![&normalized_id],
    )?;

    println!(
        "已标记 {} 条待处理记忆候选为已保存: {}",
        affected, normalized_id
    );
    Ok(affected as u32)
}

// ★ 2026-02 清理：以下辅助函数已随 extract_memories_from_chat 一起删除
// - build_memory_extraction_prompt
// - parse_memory_candidates
// - coerce_value_to_memory_candidates

#[cfg(test)]
mod tests {
    use crate::fsrs_review_service::{FsrsAgentLatestReviewSnapshot, FsrsAgentReviewStateSnapshot};
    use crate::models::{AnkiCard, AnkiLibraryCard};
    use std::collections::HashMap;

    fn validation_card(front: &str, back: &str, text: Option<&str>) -> AnkiCard {
        AnkiCard {
            front: front.to_string(),
            back: back.to_string(),
            text: text.map(str::to_string),
            tags: Vec::new(),
            images: Vec::new(),
            id: "card-validation".to_string(),
            task_id: "task-validation".to_string(),
            is_error_card: false,
            error_content: None,
            created_at: String::new(),
            updated_at: String::new(),
            extra_fields: HashMap::new(),
            template_id: None,
        }
    }

    fn library_card(id: &str, updated_at: &str, enqueued: bool) -> AnkiLibraryCard {
        AnkiLibraryCard {
            card: AnkiCard {
                id: id.to_string(),
                updated_at: updated_at.to_string(),
                ..validation_card("front", "back", None)
            },
            source_type: Some("chatanki".to_string()),
            source_id: Some("document-1".to_string()),
            state_id: enqueued.then(|| format!("state-{id}")),
            state: enqueued.then_some(0),
            due_ms: enqueued.then_some(1_784_000_000_000),
            suspended: false,
            enqueued,
            is_due: enqueued,
        }
    }

    #[test]
    fn library_list_response_exposes_independent_content_and_review_versions() {
        let response = super::build_anki_library_list_response(
            vec![
                library_card("card-reviewed", "content-v2", true),
                library_card("card-unenqueued", "content-v1", false),
            ],
            2,
            20,
            22,
            vec![FsrsAgentReviewStateSnapshot {
                anki_card_id: "card-reviewed".to_string(),
                card_state_id: "state-card-reviewed".to_string(),
                state: 0,
                suspended: false,
                due_ms: 1_784_000_000_000,
                last_review_ms: Some(1_783_999_000_000),
                review_version: 7,
                latest_review: Some(FsrsAgentLatestReviewSnapshot {
                    log_id: "log-7".to_string(),
                    rating: 3,
                    review_ms: 1_783_999_000_000,
                    undoable: true,
                }),
            }],
        )
        .expect("library response");

        assert_eq!(response["page"], 2);
        assert_eq!(response["pageSize"], 20);
        assert_eq!(response["total"], 22);
        assert_eq!(response["items"][0]["version"], "content-v2");
        assert_eq!(response["items"][0]["reviewVersion"], 7);
        assert_eq!(response["items"][0]["latestReview"]["logId"], "log-7");
        assert_eq!(response["items"][0]["latestReview"]["rating"], 3);
        assert_eq!(response["items"][0]["latestReview"]["undoable"], true);
        assert!(response["items"][0]["latestReview"]["reviewedAt"].is_string());
        assert_eq!(response["items"][1]["version"], "content-v1");
        assert!(response["items"][1]["reviewVersion"].is_null());
        assert!(response["items"][1]["latestReview"].is_null());
    }

    #[test]
    fn valid_cloze_text_allows_an_empty_back() {
        let card = validation_card(
            "The {{c1::answer}} remains editable",
            "",
            Some("The {{c1::answer}} remains editable"),
        );
        assert!(super::has_valid_cloze_text(&card));
        assert!(super::validate_anki_card_update(&card).is_ok());

        let mut custom_fields = validation_card("", "", None);
        custom_fields.extra_fields.insert(
            "Text".to_string(),
            "Multiple {{c2::deletions::hint}} work".to_string(),
        );
        assert!(super::has_valid_cloze_text(&custom_fields));
        assert!(super::validate_anki_card_update(&custom_fields).is_ok());
    }

    #[test]
    fn malformed_or_empty_cloze_text_does_not_bypass_basic_validation() {
        for text in ["plain text", "{{c0::zero}}", "{{c1::}}", "{{c1::open"] {
            let card = validation_card(text, "", Some(text));
            assert!(
                !super::has_valid_cloze_text(&card),
                "unexpectedly valid: {text}"
            );
            assert_eq!(
                super::validate_anki_card_update(&card)
                    .expect_err("invalid Cloze cannot bypass Basic validation")
                    .message,
                "卡片背面不能为空"
            );
        }
    }

    #[test]
    fn get_document_tasks_uses_anki_database() {
        let source = include_str!("enhanced_anki.rs");
        let function = source
            .split_once("pub async fn get_document_tasks(")
            .expect("get_document_tasks command must exist")
            .1
            .split_once("pub async fn get_task_cards(")
            .expect("get_task_cards command must follow get_document_tasks")
            .0;

        assert!(
            function.contains("state.anki_database.clone()"),
            "get_document_tasks must read document_tasks from the Anki database"
        );
        assert!(
            !function.contains("state.database.clone()"),
            "get_document_tasks must not fall back to the legacy primary database"
        );
    }
}
