//! VFS 统一索引 Tauri Commands
//!
//! 提供统一索引的前端接口
//!
//! ★ 2026-01 统一架构：所有索引操作通过 VfsFullIndexingService 执行

use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;
use crate::vfs::index_service::{IndexStatusSummary, UnitIndexStatus, VfsIndexService};
use crate::vfs::indexing::{VfsFullIndexingService, VfsIndexingService};
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::repos::VfsIndexStateRepo;
use crate::vfs::unit_builder::UnitBuildInput;
use std::sync::Arc;
use tauri::State;

/// 获取索引状态总览
#[tauri::command]
pub async fn vfs_unified_index_status(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<IndexStatusSummary, String> {
    let service = VfsIndexService::new(vfs_db.inner().clone());
    service.get_status_summary().map_err(|e| e.to_string())
}

/// 获取资源的 Units 列表
#[tauri::command]
pub async fn vfs_get_resource_units(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    resource_id: String,
) -> Result<Vec<UnitIndexStatus>, String> {
    let service = VfsIndexService::new(vfs_db.inner().clone());
    service
        .get_resource_units(&resource_id)
        .map_err(|e| e.to_string())
}

/// 重新索引 Unit
#[tauri::command]
pub async fn vfs_reindex_unit(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    unit_id: String,
    mode: String, // "text" | "mm" | "both"
) -> Result<bool, String> {
    let service = VfsIndexService::new(vfs_db.inner().clone());
    service
        .reset_unit_index(&unit_id, &mode)
        .map_err(|e| e.to_string())?;
    Ok(true)
}

/// 批量索引待处理 Units（返回处理结果）
///
/// ★ 2026-01 修复：集成 VfsFullIndexingService 实现真正的批量索引
#[tauri::command]
pub async fn vfs_unified_batch_index(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    llm_manager: State<'_, Arc<LLMManager>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    mode: String, // "text" | "mm" | "both"
    batch_size: Option<i32>,
) -> Result<BatchIndexResult, String> {
    let limit = batch_size.unwrap_or(10) as u32;

    log::info!(
        "[VFS::index_handlers] vfs_unified_batch_index: mode={}, batch_size={}",
        mode,
        limit
    );

    // 文本模态使用 VfsFullIndexingService
    if mode == "text" || mode == "both" {
        // 获取索引配置
        let indexing_service = VfsIndexingService::new(Arc::clone(&vfs_db));
        let config = indexing_service
            .get_indexing_config()
            .map_err(|e| e.to_string())?;

        let pending = VfsIndexStateRepo::get_pending_resources(&vfs_db, limit, config.max_retries)
            .map_err(|e| e.to_string())?;

        if pending.is_empty() {
            return Ok(BatchIndexResult {
                success_count: 0,
                fail_count: 0,
                total: 0,
            });
        }

        let full_indexing_service = VfsFullIndexingService::new(
            Arc::clone(&vfs_db),
            Arc::clone(&llm_manager),
            Arc::clone(lance_store.inner()),
        )
        .map_err(|e| e.to_string())?;

        let (success, fail) = full_indexing_service
            .process_pending_batch(limit)
            .await
            .map_err(|e| e.to_string())?;

        log::info!(
            "[VFS::index_handlers] vfs_unified_batch_index completed: success={}, fail={}",
            success,
            fail
        );

        return Ok(BatchIndexResult {
            success_count: success as i32,
            fail_count: fail as i32,
            total: (success + fail) as i32,
        });
    }

    // 多模态索引暂不支持，返回空结果
    Ok(BatchIndexResult {
        success_count: 0,
        fail_count: 0,
        total: 0,
    })
}

/// 批量索引结果
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BatchIndexResult {
    pub success_count: i32,
    pub fail_count: i32,
    pub total: i32,
}

/// 删除索引操作的结构化结果
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteIndexResult {
    /// SQLite 记录是否删除成功
    pub sqlite_ok: bool,
    /// Lance text 向量是否删除成功
    pub lance_text_ok: bool,
    /// Lance multimodal 向量是否删除成功
    pub lance_mm_ok: bool,
    /// 警告信息列表
    pub warnings: Vec<String>,
    /// 是否可重试（Lance 失败时为 true）
    pub retryable: bool,
}

/// 同步资源的 Units
#[tauri::command]
pub async fn vfs_sync_resource_units(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    resource_id: String,
    resource_type: String,
    data: Option<String>,
    ocr_text: Option<String>,
    ocr_pages_json: Option<String>,
    blob_hash: Option<String>,
    page_count: Option<i32>,
    extracted_text: Option<String>,
    preview_json: Option<String>,
) -> Result<Vec<UnitIndexStatus>, String> {
    let service = VfsIndexService::new(vfs_db.inner().clone());

    let input = UnitBuildInput {
        resource_id,
        resource_type,
        data,
        ocr_text,
        ocr_pages_json,
        blob_hash,
        page_count,
        extracted_text,
        preview_json,
    };

    let units = service
        .sync_resource_units(input)
        .map_err(|e| e.to_string())?;
    Ok(units.into_iter().map(UnitIndexStatus::from).collect())
}

/// 删除资源索引
///
/// ★ C-3 修复：同步删除 SQLite 记录和 LanceDB 向量数据（text + multimodal）
/// ★ P1-2 修复：返回结构化的部分失败结果，而非简单的 bool
#[tauri::command]
pub async fn vfs_delete_resource_index(
    vfs_db: State<'_, Arc<VfsDatabase>>,
    lance_store: State<'_, Arc<VfsLanceStore>>,
    resource_id: String,
) -> Result<DeleteIndexResult, String> {
    log::info!(
        "[VFS::index_handlers] vfs_delete_resource_index: resource_id={}",
        resource_id
    );

    let mut result = DeleteIndexResult {
        sqlite_ok: false,
        lance_text_ok: false,
        lance_mm_ok: false,
        warnings: Vec::new(),
        retryable: false,
    };

    let service = VfsIndexService::new(vfs_db.inner().clone());

    // 1. 删除 SQLite 记录（获取需要清理的 LanceDB row IDs）
    let delete_result = match service.delete_resource_index(&resource_id) {
        Ok(r) => {
            result.sqlite_ok = true;
            r
        }
        Err(e) => {
            result
                .warnings
                .push(format!("SQLite deletion failed: {}", e));
            result.retryable = true;
            return Ok(result);
        }
    };

    // 2. 删除 LanceDB 向量数据（text 和 multimodal 两种 modality）
    // ★ C-3 修复：即使 lance_row_ids 为空也尝试删除，以清理可能的历史遗留数据
    match lance_store.delete_by_resource("text", &resource_id).await {
        Ok(_) => {
            result.lance_text_ok = true;
        }
        Err(e) => {
            log::warn!(
                "[VFS::index_handlers] Failed to delete text vectors for resource {}: {}",
                resource_id,
                e
            );
            result
                .warnings
                .push(format!("Failed to delete text vectors: {}", e));
            result.retryable = true;
        }
    }

    match lance_store
        .delete_by_resource("multimodal", &resource_id)
        .await
    {
        Ok(_) => {
            result.lance_mm_ok = true;
        }
        Err(e) => {
            log::warn!(
                "[VFS::index_handlers] Failed to delete multimodal vectors for resource {}: {}",
                resource_id,
                e
            );
            result
                .warnings
                .push(format!("Failed to delete multimodal vectors: {}", e));
            result.retryable = true;
        }
    }

    log::info!(
        "[VFS::index_handlers] Deleted {} units and {} LanceDB vectors for resource {}",
        delete_result.deleted_unit_count,
        delete_result.lance_row_ids.len(),
        resource_id
    );

    Ok(result)
}

/// 获取已注册的向量维度
#[tauri::command]
pub async fn vfs_list_embedding_dims(
    vfs_db: State<'_, Arc<VfsDatabase>>,
) -> Result<Vec<EmbeddingDimInfo>, String> {
    let service = VfsIndexService::new(vfs_db.inner().clone());
    let dims = service.list_dimensions().map_err(|e| e.to_string())?;
    Ok(dims
        .into_iter()
        .map(|d| EmbeddingDimInfo {
            dimension: d.dimension,
            modality: d.modality,
            lance_table_name: d.lance_table_name,
            record_count: d.record_count,
        })
        .collect())
}

/// 向量维度信息
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingDimInfo {
    pub dimension: i32,
    pub modality: String,
    pub lance_table_name: String,
    pub record_count: i64,
}
