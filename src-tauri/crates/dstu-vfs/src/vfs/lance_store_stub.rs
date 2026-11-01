//! VfsLanceStore 的 no-op stub（`lance` feature 未启用时编译，如 mobile-slim）
//!
//! 目标：保持与 `lance_store.rs` 相同的公开 API 面，使 ~30 个消费方
//! （unified_retriever / indexing / embedding_service / handlers 等）无需逐一
//! 添加 `#[cfg(feature = "lance")]` 门控。
//!
//! ## Stub 语义约定
//! - **读路径**（vector/fts/hybrid 检索、stats、diagnose）：返回空结果，
//!   使 SQLite/FTS 检索路径可以继续工作（与 canvas_executor 的
//!   not(lance) 空结果 + warning 先例一致）。
//! - **删除/清理路径**（delete_by_*、clear_all、optimize_*、sweep 等）：
//!   返回 Ok(0)/Ok(())——未启用 lance 时不存在向量数据，删除操作空成立。
//! - **写入/建 profile 路径**（write_chunks、ensure_model_profile*、
//!   next_unit_generation）：返回 `VfsError::InvalidState`，让索引流水线
//!   显式失败并进入 INDEX_STATE_FAILED，而非静默丢弃 embedding 数据。
//!
//! 运行时行为的进一步裁剪（如移动端直接禁用 embedding 生成）属于 WI-6
//! 后续轮次（R3+）的工作，本文件仅保证编译完整性与诚实降级。

use std::sync::Arc;

use tracing::{debug, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::embedding_dim_repo::VfsIndexProfile;

/// 未启用 lance 时统一的错误文案
const LANCE_DISABLED_MSG: &str = "向量索引功能未启用（当前构建未包含 lance feature）";

fn lance_disabled_err() -> VfsError {
    VfsError::InvalidState {
        message: LANCE_DISABLED_MSG.to_string(),
    }
}

// ============================================================================
// 类型定义（与 lance_store.rs 保持字段一致）
// ============================================================================

/// VFS 向量行结构（对应 LanceDB 表中的一行）
#[derive(Debug, Clone)]
pub struct VfsLanceRow {
    pub embedding_id: String,
    pub resource_id: String,
    pub unit_id: String,
    pub resource_type: String,
    pub folder_id: Option<String>,
    pub chunk_index: i32,
    pub text: String,
    pub metadata_json: Option<String>,
    pub created_at: String,
    pub index_profile_id: String,
    pub generation: i64,
    pub embedding: Vec<f32>,
}

/// 向量检索结果
#[derive(Debug, Clone)]
pub struct VfsLanceSearchResult {
    pub embedding_id: String,
    pub resource_id: String,
    pub unit_id: String,
    pub resource_type: String,
    pub folder_id: Option<String>,
    pub chunk_index: i32,
    pub text: String,
    pub score: f32,
    pub metadata_json: Option<String>,
    pub index_profile_id: String,
    pub generation: i64,
    /// 页面索引（用于 PDF/教材定位，从 metadata_json 解析）
    pub page_index: Option<i32>,
    /// 来源 ID（从 metadata_json 解析）
    pub source_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LanceTableDiagnostic {
    pub table_name: String,
    pub dimension: usize,
    pub row_count: usize,
    pub columns: Vec<String>,
    pub has_metadata_column: bool,
    pub has_embedding_id_column: bool,
    pub has_resource_id_column: bool,
    pub has_text_column: bool,
    pub sample_metadata: Vec<Option<String>>,
    pub metadata_with_page_index: usize,
    pub metadata_null_count: usize,
    pub schema_valid: bool,
    pub issue_description: Option<String>,
}

// ============================================================================
// VfsLanceStore stub
// ============================================================================

/// VFS LanceDB 向量存储（stub：lance feature 未启用）
pub struct VfsLanceStore {
    #[allow(dead_code)]
    db: Arc<VfsDatabase>,
}

impl VfsLanceStore {
    /// 创建 stub 实例（始终成功，避免影响应用启动流程）
    pub fn new(db: Arc<VfsDatabase>) -> VfsResult<Self> {
        warn!("[VfsLanceStore] lance feature 未启用，向量存储运行在 no-op stub 模式");
        Ok(Self { db })
    }

    // ------------------------------------------------------------------
    // 写入 / profile 管理：显式失败，避免静默丢数据
    // ------------------------------------------------------------------

    pub fn ensure_model_profile(
        &self,
        _modality: &str,
        _dim: usize,
        _model_config_id: &str,
        _model_name: Option<&str>,
    ) -> VfsResult<VfsIndexProfile> {
        Err(lance_disabled_err())
    }

    pub fn ensure_model_profile_with_fingerprint(
        &self,
        _modality: &str,
        _dim: usize,
        _model_config_id: &str,
        _model_name: Option<&str>,
        _expected_fingerprint: &str,
    ) -> VfsResult<VfsIndexProfile> {
        Err(lance_disabled_err())
    }

    pub fn next_unit_generation(&self, _unit_id: &str, _modality: &str) -> VfsResult<i64> {
        Err(lance_disabled_err())
    }

    pub async fn write_chunks(&self, _modality: &str, _rows: &[VfsLanceRow]) -> VfsResult<()> {
        Err(lance_disabled_err())
    }

    // ------------------------------------------------------------------
    // 删除 / 清理：无向量数据，空成立地成功
    // ------------------------------------------------------------------

    pub async fn drop_table(&self, _table_name: &str) -> VfsResult<()> {
        Ok(())
    }

    pub async fn sweep_retired_profile_tables(&self) -> VfsResult<usize> {
        Ok(0)
    }

    pub async fn delete_by_resource(
        &self,
        _modality: &str,
        _resource_id: &str,
    ) -> VfsResult<usize> {
        Ok(0)
    }

    pub async fn delete_by_resource_except_dim(
        &self,
        _modality: &str,
        _resource_id: &str,
        _keep_dim: usize,
    ) -> VfsResult<usize> {
        Ok(0)
    }

    pub async fn delete_by_resource_except_ids(
        &self,
        _modality: &str,
        _resource_id: &str,
        _keep_ids: &[String],
    ) -> VfsResult<usize> {
        Ok(0)
    }

    pub async fn delete_by_unit_except_ids(
        &self,
        _modality: &str,
        _resource_id: &str,
        _unit_id: &str,
        _keep_ids: &[String],
    ) -> VfsResult<usize> {
        Ok(0)
    }

    pub async fn delete_by_embedding_ids(
        &self,
        _modality: &str,
        _embedding_ids: &[String],
    ) -> VfsResult<usize> {
        Ok(0)
    }

    pub async fn discard_uncommitted_rows(
        &self,
        _modality: &str,
        _resource_id: &str,
        _embedding_ids: &[String],
    ) -> VfsResult<()> {
        Ok(())
    }

    pub async fn clear_all(&self, _modality: &str) -> VfsResult<usize> {
        Ok(0)
    }

    // ------------------------------------------------------------------
    // 检索：优雅降级为空结果（SQLite/FTS 路径不受影响）
    // ------------------------------------------------------------------

    pub async fn vector_search(
        &self,
        _modality: &str,
        _query_embedding: &[f32],
        _top_k: usize,
        _folder_ids: Option<&[String]>,
        _resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        debug!("[VfsLanceStore] vector_search skipped: lance feature disabled");
        Ok(Vec::new())
    }

    pub async fn vector_search_full(
        &self,
        _modality: &str,
        _query_embedding: &[f32],
        _top_k: usize,
        _folder_ids: Option<&[String]>,
        _resource_ids: Option<&[String]>,
        _resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        debug!("[VfsLanceStore] vector_search_full skipped: lance feature disabled");
        Ok(Vec::new())
    }

    pub async fn ensure_profile_ready(&self, _profile_id: &str) -> VfsResult<()> {
        Ok(())
    }

    pub async fn vector_search_profile_full(
        &self,
        _profile_id: &str,
        _query_embedding: &[f32],
        _top_k: usize,
        _folder_ids: Option<&[String]>,
        _resource_ids: Option<&[String]>,
        _resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        debug!("[VfsLanceStore] vector_search_profile_full skipped: lance feature disabled");
        Ok(Vec::new())
    }

    pub async fn fts_search_profile_full(
        &self,
        _profile_id: &str,
        _query_text: &str,
        _top_k: usize,
        _folder_ids: Option<&[String]>,
        _resource_ids: Option<&[String]>,
        _resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        debug!("[VfsLanceStore] fts_search_profile_full skipped: lance feature disabled");
        Ok(Vec::new())
    }

    pub async fn hybrid_search(
        &self,
        _modality: &str,
        _query_text: &str,
        _query_embedding: &[f32],
        _top_k: usize,
        _folder_ids: Option<&[String]>,
        _resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        debug!("[VfsLanceStore] hybrid_search skipped: lance feature disabled");
        Ok(Vec::new())
    }

    pub async fn hybrid_search_full(
        &self,
        _modality: &str,
        _query_text: &str,
        _query_embedding: &[f32],
        _top_k: usize,
        _folder_ids: Option<&[String]>,
        _resource_ids: Option<&[String]>,
        _resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        debug!("[VfsLanceStore] hybrid_search_full skipped: lance feature disabled");
        Ok(Vec::new())
    }

    // ------------------------------------------------------------------
    // 维护 / 诊断
    // ------------------------------------------------------------------

    pub async fn optimize_table(&self, _modality: &str, _dim: usize) -> VfsResult<()> {
        Ok(())
    }

    pub async fn optimize_all(&self, _modality: &str) -> VfsResult<usize> {
        Ok(0)
    }

    pub async fn maybe_optimize_all(&self) -> VfsResult<usize> {
        Ok(0)
    }

    pub async fn get_table_stats(&self, _modality: &str) -> VfsResult<Vec<(String, usize)>> {
        Ok(Vec::new())
    }

    pub async fn diagnose_table_schema(
        &self,
        _modality: &str,
    ) -> VfsResult<Vec<LanceTableDiagnostic>> {
        Ok(Vec::new())
    }
}
