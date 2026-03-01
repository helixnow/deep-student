use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;
use tracing::{info, warn};

use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;
use crate::vfs::indexing::VfsFullIndexingService;
use crate::vfs::lance_store::VfsLanceStore;

use super::audit_log::{self, MemoryAuditLogItem};
use super::service::{
    MemoryConfigOutput, MemoryListItem, MemorySearchResult, MemoryService, MemoryWriteOutput,
    SmartWriteOutput, WriteMode,
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchOperationResult {
    pub total: usize,
    pub succeeded: usize,
    pub failed: usize,
    pub errors: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReadOutput {
    pub note_id: String,
    pub title: String,
    pub content: String,
    pub folder_path: String,
    pub updated_at: String,
}

fn get_memory_service(
    vfs_db: &Arc<VfsDatabase>,
    lance_store: &Arc<VfsLanceStore>,
    llm_manager: &Arc<LLMManager>,
) -> MemoryService {
    MemoryService::new(vfs_db.clone(), lance_store.clone(), llm_manager.clone())
}

/// 写入后触发单资源索引，保证 write-then-search SLA。
/// 索引成功后标记为 indexed，防止批量 worker 重复处理。
fn trigger_immediate_index(
    vfs_db: Arc<VfsDatabase>,
    llm_manager: Arc<LLMManager>,
    lance_store: Arc<VfsLanceStore>,
    resource_id: String,
) {
    tokio::spawn(async move {
        let db_ref = vfs_db.clone();
        let indexing_service = match VfsFullIndexingService::new(vfs_db, llm_manager, lance_store) {
            Ok(svc) => svc,
            Err(e) => {
                warn!(
                    "[Memory] Failed to create indexing service for immediate index of {}: {}",
                    resource_id, e
                );
                return;
            }
        };

        match indexing_service
            .index_resource(&resource_id, None, None)
            .await
        {
            Ok((chunk_count, dim)) => {
                if let Err(e) = crate::vfs::repos::embedding_repo::VfsIndexStateRepo::mark_indexed(
                    &db_ref,
                    &resource_id,
                    &format!("mem_handler_{}", chrono::Utc::now().timestamp_millis()),
                ) {
                    warn!("[Memory] Failed to mark indexed after immediate indexing: {}", e);
                }
                info!(
                    "[Memory] Immediate index completed for resource {} ({} chunks, dim={})",
                    resource_id, chunk_count, dim
                );
            }
            Err(e) => {
                warn!(
                    "[Memory] Immediate index failed for resource {} (will retry in next batch): {}",
                    resource_id, e
                );
            }
        }
    });
}

#[tauri::command]
pub async fn memory_get_config(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<MemoryConfigOutput, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service.get_config().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn memory_set_root_folder(
    folder_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<(), String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service
        .set_root_folder(&folder_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn memory_set_privacy_mode(
    enabled: bool,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<(), String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service.set_privacy_mode(enabled).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn memory_create_root_folder(
    title: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<String, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service
        .create_root_folder(&title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn memory_get_or_create_root_folder(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<String, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service
        .get_or_create_root_folder()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn memory_search(
    query: String,
    top_k: Option<usize>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<Vec<MemorySearchResult>, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let k = top_k.unwrap_or(5);
    service.search_with_rerank(&query, k, false).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn memory_read(
    note_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<Option<MemoryReadOutput>, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);

    match service.read(&note_id).map_err(|e| e.to_string())? {
        Some((note, content)) => {
            let folder_path = service
                .get_note_folder_path(&note_id)
                .map_err(|e| e.to_string())?;

            Ok(Some(MemoryReadOutput {
                note_id: note.id,
                title: note.title,
                content,
                folder_path,
                updated_at: note.updated_at,
            }))
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub async fn memory_write(
    note_id: Option<String>,
    folder_path: Option<String>,
    title: String,
    content: String,
    mode: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<MemoryWriteOutput, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let write_mode = mode
        .map(|m| WriteMode::from_str(&m))
        .unwrap_or(WriteMode::Create);

    let result = if let Some(target_note_id) = note_id {
        match write_mode {
            WriteMode::Append => {
                let current = service
                    .read(&target_note_id)
                    .map_err(|e| e.to_string())?
                    .map(|(_, existing)| existing)
                    .unwrap_or_default();
                let final_content = if current.is_empty() {
                    content.clone()
                } else {
                    format!("{}\n\n{}", current, content)
                };
                service
                    .update_by_id(&target_note_id, Some(&title), Some(&final_content))
                    .map_err(|e| e.to_string())?
            }
            _ => service
                .update_by_id(&target_note_id, Some(&title), Some(&content))
                .map_err(|e| e.to_string())?,
        }
    } else {
        service
            .write(folder_path.as_deref(), &title, &content, write_mode)
            .map_err(|e| e.to_string())?
    };

    // ★ P2-2 修复：写入后立即触发索引，保证 write-then-search SLA
    trigger_immediate_index(
        Arc::clone(vfs_db.inner()),
        Arc::clone(llm_manager.inner()),
        Arc::clone(lance_store.inner()),
        result.resource_id.clone(),
    );

    Ok(result)
}

#[tauri::command]
pub async fn memory_list(
    folder_path: Option<String>,
    limit: Option<u32>,
    offset: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<Vec<MemoryListItem>, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service
        .list(
            folder_path.as_deref(),
            limit.unwrap_or(100),
            offset.unwrap_or(0),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn memory_get_tree(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<Option<crate::vfs::types::FolderTreeNode>, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service.get_tree().map_err(|e| e.to_string())
}

/// 添加记忆关联（双向）
#[tauri::command]
pub async fn memory_add_relation(
    note_id_a: String,
    note_id_b: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<(), String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service.add_relation(&note_id_a, &note_id_b).map_err(|e| e.to_string())
}

/// 移除记忆关联（双向）
#[tauri::command]
pub async fn memory_remove_relation(
    note_id_a: String,
    note_id_b: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<(), String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service.remove_relation(&note_id_a, &note_id_b).map_err(|e| e.to_string())
}

/// 获取关联记忆 ID 列表
#[tauri::command]
pub async fn memory_get_related(
    note_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<Vec<String>, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service.get_related_ids(&note_id).map_err(|e| e.to_string())
}

/// 更新记忆标签
#[tauri::command]
pub async fn memory_update_tags(
    note_id: String,
    tags: Vec<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<(), String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service.update_tags(&note_id, tags).map_err(|e| e.to_string())
}

/// 获取记忆标签
#[tauri::command]
pub async fn memory_get_tags(
    note_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<Vec<String>, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service.get_tags(&note_id).map_err(|e| e.to_string())
}

/// 批量删除记忆
#[tauri::command]
pub async fn memory_batch_delete(
    note_ids: Vec<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<BatchOperationResult, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let total = note_ids.len();
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for note_id in &note_ids {
        match service.delete(note_id).await {
            Ok(()) => succeeded += 1,
            Err(e) => {
                failed += 1;
                if errors.len() < 5 {
                    errors.push(format!("{}: {}", note_id, e));
                }
            }
        }
    }

    Ok(BatchOperationResult { total, succeeded, failed, errors })
}

/// 批量移动记忆到指定文件夹
#[tauri::command]
pub async fn memory_batch_move(
    note_ids: Vec<String>,
    target_folder_path: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<BatchOperationResult, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let total = note_ids.len();
    let mut succeeded = 0usize;
    let mut failed = 0usize;
    let mut errors: Vec<String> = Vec::new();

    for note_id in &note_ids {
        match service.move_to_folder(note_id, &target_folder_path) {
            Ok(()) => succeeded += 1,
            Err(e) => {
                failed += 1;
                if errors.len() < 5 {
                    errors.push(format!("{}: {}", note_id, e));
                }
            }
        }
    }

    Ok(BatchOperationResult { total, succeeded, failed, errors })
}

/// 移动记忆到指定文件夹路径
#[tauri::command]
pub async fn memory_move_to_folder(
    note_id: String,
    target_folder_path: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<(), String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service
        .move_to_folder(&note_id, &target_folder_path)
        .map_err(|e| e.to_string())
}

// ★ 修复风险2：按 note_id 更新记忆
#[tauri::command]
pub async fn memory_update_by_id(
    note_id: String,
    title: Option<String>,
    content: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<MemoryWriteOutput, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let result = service
        .update_by_id(&note_id, title.as_deref(), content.as_deref())
        .map_err(|e| e.to_string())?;

    // ★ P2-2 修复：更新后立即触发索引，保证 write-then-search SLA
    trigger_immediate_index(
        Arc::clone(vfs_db.inner()),
        Arc::clone(llm_manager.inner()),
        Arc::clone(lance_store.inner()),
        result.resource_id.clone(),
    );

    Ok(result)
}

// ★ 修复风险3：删除记忆
#[tauri::command]
pub async fn memory_delete(
    note_id: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<(), String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    service.delete(&note_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn memory_set_auto_create_subfolders(
    enabled: bool,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<(), String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let cfg = super::config::MemoryConfig::new(service.vfs_db_ref().clone());
    cfg.set_auto_create_subfolders(enabled)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn memory_set_default_category(
    category: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<(), String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let cfg = super::config::MemoryConfig::new(service.vfs_db_ref().clone());
    cfg.set_default_category(&category)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn memory_set_auto_extract_frequency(
    frequency: String,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<(), String> {
    let freq = super::config::AutoExtractFrequency::from_str_lossy(&frequency);
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let cfg = super::config::MemoryConfig::new(service.vfs_db_ref().clone());
    cfg.set_auto_extract_frequency(freq)
        .map_err(|e| e.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryExportItem {
    pub title: String,
    pub content: String,
    pub folder: String,
    pub updated_at: String,
}

#[tauri::command]
pub async fn memory_export_all(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<Vec<MemoryExportItem>, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let items = service.list(None, 500, 0).map_err(|e| e.to_string())?;

    let mut results = Vec::with_capacity(items.len());
    for item in &items {
        let content = service
            .read(&item.id)
            .map_err(|e| e.to_string())?
            .map(|(_, c)| c)
            .unwrap_or_default();
        results.push(MemoryExportItem {
            title: item.title.clone(),
            content,
            folder: item.folder_path.clone(),
            updated_at: item.updated_at.clone(),
        });
    }
    Ok(results)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProfileSection {
    pub category: String,
    pub content: String,
}

#[tauri::command]
pub async fn memory_get_profile(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<Vec<MemoryProfileSection>, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let root_id = match service.get_root_folder_id().map_err(|e| e.to_string())? {
        Some(id) => id,
        None => return Ok(vec![]),
    };

    let cat_mgr = super::category_manager::MemoryCategoryManager::new(
        service.vfs_db_ref().clone(),
        llm_manager.inner().clone(),
    );

    let categories = cat_mgr
        .load_all_category_summaries(&root_id)
        .map_err(|e| e.to_string())?;

    if !categories.is_empty() {
        return Ok(categories
            .into_iter()
            .map(|(cat, content)| MemoryProfileSection {
                category: cat,
                content,
            })
            .collect());
    }

    match service.get_profile_summary().map_err(|e| e.to_string())? {
        Some(profile) => Ok(vec![MemoryProfileSection {
            category: "画像".to_string(),
            content: profile,
        }]),
        None => Ok(vec![]),
    }
}

#[tauri::command]
pub async fn memory_write_smart(
    folder_path: Option<String>,
    title: String,
    content: String,
    memory_type: Option<String>,
    memory_purpose: Option<String>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<SmartWriteOutput, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let mem_type = memory_type
        .as_deref()
        .map(super::service::MemoryType::from_str)
        .unwrap_or(super::service::MemoryType::Fact);
    let purpose = memory_purpose
        .as_deref()
        .map(super::service::MemoryPurpose::from_str);
    let result = service
        .write_smart_with_source(
            folder_path.as_deref(),
            &title,
            &content,
            super::audit_log::MemoryOpSource::Handler,
            None,
            mem_type,
            purpose,
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(result)
}

#[tauri::command]
pub async fn memory_get_audit_logs(
    limit: Option<u32>,
    offset: Option<u32>,
    source_filter: Option<String>,
    operation_filter: Option<String>,
    success_filter: Option<bool>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<MemoryAuditLogItem>, String> {
    let limit = limit.unwrap_or(50);
    let offset = offset.unwrap_or(0);
    audit_log::query_audit_logs(
        &vfs_db,
        limit,
        offset,
        source_filter.as_deref(),
        operation_filter.as_deref(),
        success_filter,
    )
    .map_err(|e| e.to_string())
}

/// 将记忆导出为 ChatAnki 卡片格式的文档内容
///
/// 筛选记忆后，格式化为结构化文本，返回给前端。
/// 前端可将此文本传入 chatanki_run 工具触发制卡。
#[tauri::command]
pub async fn memory_to_anki_document(
    folder_path: Option<String>,
    purpose_filter: Option<String>,
    limit: Option<u32>,
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    llm_manager: State<'_, Arc<LLMManager>>,
) -> Result<MemoryAnkiDocument, String> {
    let service = get_memory_service(&vfs_db, &lance_store, &llm_manager);
    let limit = limit.unwrap_or(200);
    let items = service
        .list(folder_path.as_deref(), limit, 0)
        .map_err(|e| e.to_string())?;

    let purpose = purpose_filter.as_deref();

    let mut lines = Vec::new();
    let mut count = 0usize;

    for item in &items {
        if item.title.starts_with("__") {
            continue;
        }
        if let Some(p) = purpose {
            if item.memory_purpose != p {
                continue;
            }
        }

        let content = crate::vfs::repos::note_repo::VfsNoteRepo::get_note_content(&vfs_db, &item.id)
            .map_err(|e| e.to_string())?
            .unwrap_or_default();

        let text = if content.is_empty() { &item.title } else { &content };

        lines.push(format!(
            "## {}\n\n{}\n\n---\n",
            item.title, text
        ));
        count += 1;
    }

    let document_content = if lines.is_empty() {
        String::new()
    } else {
        format!(
            "# 用户记忆知识卡片\n\n以下是从用户记忆库中提取的 {} 条记忆，请为每条生成对应的 Anki 卡片。\n\n{}",
            count,
            lines.join("\n")
        )
    };

    Ok(MemoryAnkiDocument {
        document_content,
        memory_count: count,
        document_name: format!("记忆卡片_{}", chrono::Local::now().format("%Y%m%d")),
    })
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAnkiDocument {
    pub document_content: String,
    pub memory_count: usize,
    pub document_name: String,
}
