//! VFS 统一索引服务
//!
//! 管理 Unit 的同步、索引和状态查询

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsError;
use crate::vfs::repos::index_segment_repo::{CreateSegmentInput, VfsIndexSegment};
use crate::vfs::repos::index_unit_repo::{IndexState, VfsIndexUnit};
use crate::vfs::repos::{embedding_dim_repo, index_segment_repo, index_unit_repo};
use crate::vfs::unit_builder::{UnitBuildInput, UnitBuilderRegistry};
use rusqlite::Connection;
use std::sync::Arc;

/// 索引状态总览
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatusSummary {
    pub total_units: i64,
    pub text_stats: StateStats,
    pub mm_stats: StateStats,
    pub dimensions: Vec<DimensionStat>,
}

/// 各状态统计
#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StateStats {
    pub pending: i64,
    pub indexing: i64,
    pub indexed: i64,
    pub failed: i64,
    pub disabled: i64,
}

/// 维度统计
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionStat {
    pub dimension: i32,
    pub modality: String,
    pub count: i64,
}

/// 索引删除结果
///
/// ★ C-3 修复：返回待删除的 LanceDB row IDs，强制调用方处理
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteIndexResult {
    /// 被删除的资源 ID
    pub resource_id: String,
    /// 已删除的 Unit 数量
    pub deleted_unit_count: usize,
    /// 需要从 LanceDB 删除的 row IDs
    ///
    /// ⚠️ 调用方必须使用这些 IDs 清理 LanceDB，否则会导致孤立向量
    pub lance_row_ids: Vec<String>,
}

/// Unit 索引状态（前端 DTO）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnitIndexStatus {
    pub unit_id: String,
    pub resource_id: String,
    pub unit_index: i32,
    pub has_image: bool,
    pub has_text: bool,
    pub text_source: Option<String>,
    pub text_required: bool,
    pub text_state: String,
    pub text_error: Option<String>,
    pub text_chunk_count: i32,
    pub text_embedding_dim: Option<i32>,
    pub mm_required: bool,
    pub mm_state: String,
    pub mm_error: Option<String>,
    pub mm_embedding_dim: Option<i32>,
    pub updated_at: i64,
}

impl From<VfsIndexUnit> for UnitIndexStatus {
    fn from(u: VfsIndexUnit) -> Self {
        Self {
            unit_id: u.id,
            resource_id: u.resource_id,
            unit_index: u.unit_index,
            has_image: u.image_blob_hash.is_some(),
            has_text: u.text_content.is_some(),
            text_source: u.text_source,
            text_required: u.text_required,
            text_state: u.text_state.as_str().to_string(),
            text_error: u.text_error,
            text_chunk_count: u.text_chunk_count,
            text_embedding_dim: u.text_embedding_dim,
            mm_required: u.mm_required,
            mm_state: u.mm_state.as_str().to_string(),
            mm_error: u.mm_error,
            mm_embedding_dim: u.mm_embedding_dim,
            updated_at: u.updated_at,
        }
    }
}

/// VFS 索引服务
pub struct VfsIndexService {
    db: Arc<VfsDatabase>,
    builder_registry: UnitBuilderRegistry,
}

impl VfsIndexService {
    pub fn new(db: Arc<VfsDatabase>) -> Self {
        Self {
            db,
            builder_registry: UnitBuilderRegistry::new(),
        }
    }

    /// 同步资源的 Units
    ///
    /// 根据资源数据生成 Units 列表，与数据库中的现有 Units 进行增量同步
    pub fn sync_resource_units(
        &self,
        input: UnitBuildInput,
    ) -> Result<Vec<VfsIndexUnit>, VfsError> {
        let conn = self.db.get_conn()?;
        self.sync_resource_units_with_conn(&conn, input)
    }

    pub fn sync_resource_units_with_conn(
        &self,
        conn: &Connection,
        input: UnitBuildInput,
    ) -> Result<Vec<VfsIndexUnit>, VfsError> {
        let output =
            self.builder_registry
                .build(&input)
                .ok_or_else(|| VfsError::InvalidArgument {
                    param: "resource_type".to_string(),
                    reason: format!("Unsupported resource type: {}", input.resource_type),
                })?;

        let sync_result = index_unit_repo::sync_units(conn, &input.resource_id, output.units)?;

        if !sync_result.orphaned_lance_row_ids.is_empty() {
            log::warn!(
                "[VfsIndexService] sync_resource_units: {} orphaned LanceDB vectors for resource {} (lance_row_ids: {:?}). These should be cleaned up by the next full index or manual cleanup.",
                sync_result.orphaned_lance_row_ids.len(),
                input.resource_id,
                sync_result.orphaned_lance_row_ids
            );
        }

        Ok(sync_result.units)
    }

    /// 获取资源的所有 Units
    pub fn get_resource_units(&self, resource_id: &str) -> Result<Vec<UnitIndexStatus>, VfsError> {
        let conn = self.db.get_conn()?;
        let units = index_unit_repo::get_by_resource(&conn, resource_id)?;
        Ok(units.into_iter().map(UnitIndexStatus::from).collect())
    }

    /// 获取索引状态总览
    pub fn get_status_summary(&self) -> Result<IndexStatusSummary, VfsError> {
        let conn = self.db.get_conn()?;
        let stats = index_unit_repo::get_stats(&conn)?;
        let dim_stats = index_segment_repo::get_modality_dim_stats(&conn)?;

        Ok(IndexStatusSummary {
            total_units: stats.total,
            text_stats: StateStats {
                pending: stats.text_pending,
                indexing: stats.text_indexing,
                indexed: stats.text_indexed,
                failed: stats.text_failed,
                disabled: stats.text_disabled,
            },
            mm_stats: StateStats {
                pending: stats.mm_pending,
                indexing: stats.mm_indexing,
                indexed: stats.mm_indexed,
                failed: stats.mm_failed,
                disabled: stats.mm_disabled,
            },
            dimensions: dim_stats
                .into_iter()
                .map(|s| DimensionStat {
                    dimension: s.embedding_dim,
                    modality: s.modality,
                    count: s.count,
                })
                .collect(),
        })
    }

    /// 获取待文本索引的 Units
    pub fn list_pending_text(&self, limit: i32) -> Result<Vec<VfsIndexUnit>, VfsError> {
        let conn = self.db.get_conn()?;
        index_unit_repo::list_pending_text(&conn, limit)
    }

    /// 获取待多模态索引的 Units
    pub fn list_pending_mm(&self, limit: i32) -> Result<Vec<VfsIndexUnit>, VfsError> {
        let conn = self.db.get_conn()?;
        index_unit_repo::list_pending_mm(&conn, limit)
    }

    /// 设置 Unit 文本索引状态为 indexing
    pub fn set_text_indexing(&self, unit_id: &str) -> Result<(), VfsError> {
        let conn = self.db.get_conn()?;
        index_unit_repo::set_text_state(&conn, unit_id, IndexState::Indexing, None)
    }

    /// 设置 Unit 文本索引完成
    pub fn set_text_indexed(
        &self,
        unit_id: &str,
        chunk_count: i32,
        embedding_dim: i32,
    ) -> Result<(), VfsError> {
        let conn = self.db.get_conn()?;
        index_unit_repo::set_text_indexed(&conn, unit_id, chunk_count, embedding_dim)
    }

    /// 设置 Unit 文本索引失败
    pub fn set_text_failed(&self, unit_id: &str, error: &str) -> Result<(), VfsError> {
        let conn = self.db.get_conn()?;
        index_unit_repo::set_text_state(&conn, unit_id, IndexState::Failed, Some(error))
    }

    /// 设置 Unit 多模态索引状态为 indexing
    pub fn set_mm_indexing(&self, unit_id: &str) -> Result<(), VfsError> {
        let conn = self.db.get_conn()?;
        index_unit_repo::set_mm_state(&conn, unit_id, IndexState::Indexing, None)
    }

    /// 设置 Unit 多模态索引完成
    pub fn set_mm_indexed(&self, unit_id: &str, embedding_dim: i32) -> Result<(), VfsError> {
        let conn = self.db.get_conn()?;
        index_unit_repo::set_mm_indexed(&conn, unit_id, embedding_dim)
    }

    /// 设置 Unit 多模态索引失败
    pub fn set_mm_failed(&self, unit_id: &str, error: &str) -> Result<(), VfsError> {
        let conn = self.db.get_conn()?;
        index_unit_repo::set_mm_state(&conn, unit_id, IndexState::Failed, Some(error))
    }

    /// 重置 Unit 索引状态（用于重新索引）
    pub fn reset_unit_index(&self, unit_id: &str, mode: &str) -> Result<(), VfsError> {
        let conn = self.db.get_conn()?;

        match mode {
            "text" => {
                index_unit_repo::set_text_state(&conn, unit_id, IndexState::Pending, None)?;
            }
            "mm" => {
                index_unit_repo::set_mm_state(&conn, unit_id, IndexState::Pending, None)?;
            }
            "both" | _ => {
                index_unit_repo::set_text_state(&conn, unit_id, IndexState::Pending, None)?;
                index_unit_repo::set_mm_state(&conn, unit_id, IndexState::Pending, None)?;
            }
        }

        Ok(())
    }

    /// 删除资源的所有索引数据（仅 SQLite）
    ///
    /// 返回需要从 LanceDB 删除的 row IDs，调用方**必须**处理这些 IDs。
    ///
    /// ## 推荐使用方式
    /// ```ignore
    /// // 1. 删除 SQLite 记录并获取 lance_row_ids
    /// let lance_row_ids = index_service.delete_resource_index(resource_id)?;
    /// // 2. 异步删除 LanceDB 向量（必须执行！）
    /// if !lance_row_ids.is_empty() {
    ///     lance_store.delete_by_resource("text", resource_id).await?;
    ///     lance_store.delete_by_resource("multimodal", resource_id).await?;
    /// }
    /// ```
    ///
    /// ## ⚠️ 数据一致性警告
    /// 如果调用方不处理返回的 `lance_row_ids`，将导致 LanceDB 中存在孤立向量，
    /// 这些向量可能在 RAG 检索中被错误返回。
    pub fn delete_resource_index(&self, resource_id: &str) -> Result<DeleteIndexResult, VfsError> {
        let conn = self.db.get_conn()?;

        // 获取所有 Units
        let units = index_unit_repo::get_by_resource(&conn, resource_id)?;

        // 收集所有需要从 LanceDB 删除的 row IDs
        let mut lance_row_ids = Vec::new();
        for unit in &units {
            let ids = index_segment_repo::list_lance_row_ids_by_unit(&conn, &unit.id)?;
            lance_row_ids.extend(ids);
        }

        let row_id_count = lance_row_ids.len();
        let unit_count = units.len();

        // 删除 Units（Segments 会级联删除）
        index_unit_repo::delete_by_resource(&conn, resource_id)?;

        // 同步刷新维度计数，避免 record_count 漂移
        embedding_dim_repo::refresh_counts_from_segments(&conn)?;

        if row_id_count > 0 {
            tracing::info!(
                "[VfsIndexService] Deleted {} units, {} LanceDB row IDs pending for resource {}",
                unit_count,
                row_id_count,
                resource_id
            );
        }

        Ok(DeleteIndexResult {
            resource_id: resource_id.to_string(),
            deleted_unit_count: unit_count,
            lance_row_ids,
        })
    }

    /// 完整删除资源索引（SQLite + LanceDB）
    ///
    /// 这是一个便捷方法，自动处理 SQLite 和 LanceDB 的同步删除。
    /// 推荐在需要完整删除索引时使用此方法。
    ///
    /// ★ C-3 修复：同时删除 text 和 multimodal 两种 modality 的向量
    pub async fn delete_resource_index_full(
        &self,
        resource_id: &str,
        lance_store: &crate::vfs::lance_store::VfsLanceStore,
    ) -> Result<DeleteIndexResult, VfsError> {
        // 1. 删除 SQLite 记录
        let result = self.delete_resource_index(resource_id)?;

        // 2. 删除 LanceDB 向量（text + multimodal 两种 modality）
        // 即使 lance_row_ids 为空也尝试删除，因为可能存在历史遗留数据
        lance_store.delete_by_resource("text", resource_id).await?;
        lance_store
            .delete_by_resource("multimodal", resource_id)
            .await?;

        if result.deleted_unit_count > 0 || !result.lance_row_ids.is_empty() {
            tracing::info!(
                "[VfsIndexService] Full deletion completed for resource {}: {} units, {} vectors",
                resource_id,
                result.deleted_unit_count,
                result.lance_row_ids.len()
            );
        }

        Ok(result)
    }

    /// 创建 Segment 记录
    pub fn create_segment(&self, input: CreateSegmentInput) -> Result<VfsIndexSegment, VfsError> {
        let conn = self.db.get_conn()?;
        index_segment_repo::create(&conn, input)
    }

    /// 批量创建 Segments
    pub fn batch_create_segments(
        &self,
        inputs: Vec<CreateSegmentInput>,
    ) -> Result<Vec<VfsIndexSegment>, VfsError> {
        let conn = self.db.get_conn()?;
        index_segment_repo::batch_create(&conn, inputs)
    }

    /// 注册维度
    pub fn register_dimension(&self, dimension: i32, modality: &str) -> Result<(), VfsError> {
        let conn = self.db.get_conn()?;
        embedding_dim_repo::register(&conn, dimension, modality)?;
        Ok(())
    }

    /// 获取所有注册的维度
    pub fn list_dimensions(&self) -> Result<Vec<embedding_dim_repo::VfsEmbeddingDim>, VfsError> {
        let conn = self.db.get_conn()?;
        embedding_dim_repo::list_all(&conn)
    }

    /// 获取 Unit by ID
    pub fn get_unit_by_id(&self, unit_id: &str) -> Result<Option<VfsIndexUnit>, VfsError> {
        let conn = self.db.get_conn()?;
        index_unit_repo::get_by_id(&conn, unit_id)
    }
}
