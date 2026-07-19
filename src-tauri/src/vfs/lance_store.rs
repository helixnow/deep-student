//! VFS LanceDB 向量存储模块
//!
//! 将向量化能力内化为 VFS 的索引层，复用 LanceVectorStore 核心逻辑。
//!
//! ## 与旧 RAG 系统的差异
//! - `document_id` → `resource_id`（关联 VFS 资源）
//! - `sub_library_id` → `folder_id`（文件夹过滤，可选）
//! - 新增 `resource_type` 字段
//! - 表命名：`vfs_emb_{modality}_{dim}`

use std::cmp::Ordering;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use arrow_array::{
    Array, ArrayRef, FixedSizeListArray, Float32Array, Int32Array, Int64Array, RecordBatch,
    RecordBatchIterator, StringArray,
};
use arrow_schema::{DataType, Field, Schema};
use futures_util::TryStreamExt;
use lancedb::index::scalar::FtsIndexBuilder;
use lancedb::index::scalar::FullTextSearchQuery;
use lancedb::index::scalar::{BTreeIndexBuilder, BitmapIndexBuilder};
use lancedb::index::vector::IvfPqIndexBuilder;
use lancedb::index::Index;
use lancedb::query::{ExecutableQuery, QueryBase, Select};
use lancedb::table::{NewColumnTransform, OptimizeAction, OptimizeOptions};
use lancedb::DistanceType;
use lancedb::{Connection, Table};
use rusqlite::OptionalExtension;
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};

// ============================================================================
// 常量定义
// ============================================================================

/// VFS 向量表前缀
const VFS_LANCE_TABLE_PREFIX: &str = "vfs_emb_";

/// FTS 版本标识
const VFS_FTS_VERSION: &str = "2026-01-vfs-ngram-v1";

/// 优化最小间隔（秒）
const OPTIMIZE_MIN_INTERVAL_SECS: i64 = 600; // 10min

/// Lance 相关性得分列名
const LANCE_RELEVANCE_COL: &str = "_relevance_score";
const LANCE_FTS_SCORE_COL: &str = "_score";

/// IVF-PQ uses 8-bit codebooks and should not be trained on tiny local tables.
const MIN_ROWS_FOR_ANN_INDEX: usize = 256;
const ANN_INDEX_VERSION: i32 = 1;
const SEARCH_RESULT_COLUMNS: &[&str] = &[
    "embedding_id",
    "resource_id",
    "unit_id",
    "resource_type",
    "folder_id",
    "chunk_index",
    "text",
    "metadata",
    "index_profile_id",
    "generation",
];

/// Prevents a concurrent indexing batch from repopulating a table between
/// clear_all's delete and verification steps. The lock is process-wide because
/// VfsLanceStore can be constructed more than once for the same VFS database.
static VFS_MUTATION_LOCK: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

// ============================================================================
// 类型定义
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
// VfsLanceStore 实现
// ============================================================================

/// VFS LanceDB 向量存储
///
/// 复用 LanceVectorStore 的核心逻辑，适配 VFS 资源模型。
pub struct VfsLanceStore {
    db: Arc<VfsDatabase>,
    lance_base_path: PathBuf,
    connection: tokio::sync::OnceCell<Connection>,
    /// ★ 2026-06-12（本轮审阅）：已确认过"表存在 + 两类索引就绪"的表名缓存。
    /// ensure_table 在每次搜索/写入都会被调用，此前每次都重发两个 create_index
    /// 请求（依赖 "already exists" 报错当 no-op），高频检索下开销可观。
    /// 仅当索引确认成功（或已存在）才入缓存；失败（如空表暂不能建索引）不缓存，
    /// 保留下次调用重试自愈的机会。
    ensured_tables: std::sync::Mutex<std::collections::HashSet<String>>,
}

impl VfsLanceStore {
    /// 创建新的 VfsLanceStore 实例
    pub fn new(db: Arc<VfsDatabase>) -> VfsResult<Self> {
        let lance_base_path = Self::resolve_lance_base(&db)?;

        info!(
            "[VfsLanceStore] Initialized with base path: {}",
            lance_base_path.display()
        );

        Ok(Self {
            db,
            lance_base_path,
            connection: tokio::sync::OnceCell::new(),
            ensured_tables: std::sync::Mutex::new(std::collections::HashSet::new()),
        })
    }

    /// Bind a concrete embedding model before any rows are written.  The repo
    /// rejects replacement when a populated vector space belongs to another
    /// model, preventing same-dimension cross-model contamination.
    pub fn ensure_model_profile(
        &self,
        modality: &str,
        dim: usize,
        model_config_id: &str,
        model_name: Option<&str>,
    ) -> VfsResult<crate::vfs::repos::embedding_dim_repo::VfsIndexProfile> {
        let protocol =
            crate::vfs::repos::embedding_dim_repo::embedding_protocol_for_modality(modality)?;
        let effective_model_name = model_name.unwrap_or(model_config_id);
        let expected_fingerprint = crate::vfs::repos::embedding_dim_repo::model_fingerprint(
            model_config_id,
            effective_model_name,
            protocol,
        );
        self.ensure_model_profile_with_fingerprint(
            modality,
            dim,
            model_config_id,
            Some(effective_model_name),
            &expected_fingerprint,
        )
    }

    pub fn ensure_model_profile_with_fingerprint(
        &self,
        modality: &str,
        dim: usize,
        model_config_id: &str,
        model_name: Option<&str>,
        expected_fingerprint: &str,
    ) -> VfsResult<crate::vfs::repos::embedding_dim_repo::VfsIndexProfile> {
        let conn = self.db.get_conn()?;
        let effective_model_name = model_name.unwrap_or(model_config_id);
        if let Some(current) =
            crate::vfs::repos::embedding_dim_repo::get_by_key(&conn, dim as i32, modality)?
        {
            let same_profile = current.model_fingerprint.as_deref() == Some(expected_fingerprint);
            // A recorded legacy profile only proves which configuration ID was
            // used. Its display/model metadata and transport identity were not
            // canonical, so let the repository roll it into the current strong
            // fingerprint instead of rejecting the first rebuild as stale.
            let expected_legacy_fingerprint = format!("legacy:model-config:{model_config_id}");
            let legacy_profile_for_config = current.model_fingerprint.as_deref()
                == Some(expected_legacy_fingerprint.as_str())
                && current.model_config_id.as_deref() == Some(model_config_id);
            if current.record_count > 0 && !same_profile && !legacy_profile_for_config {
                return Err(VfsError::InvalidState {
                    message: format!(
                        "Embedding result for {}/{} is stale; writable {}:{} profile is {:?}",
                        model_config_id,
                        effective_model_name,
                        modality,
                        dim,
                        current.model_fingerprint
                    ),
                });
            }
        }
        let registered = crate::vfs::repos::embedding_dim_repo::register_with_model_fingerprint(
            &conn,
            dim as i32,
            modality,
            Some(model_config_id),
            model_name,
            Some(expected_fingerprint),
        )?;
        let profile_id = registered.active_profile_id.ok_or_else(|| {
            VfsError::Other(format!(
                "Index profile was not created for {}:{} model {}",
                modality, dim, model_config_id
            ))
        })?;
        crate::vfs::repos::embedding_dim_repo::get_active_profile(&conn, dim as i32, modality)?
            .filter(|profile| profile.id == profile_id)
            .ok_or_else(|| {
                VfsError::Other(format!(
                    "Active index profile {} could not be resolved",
                    profile_id
                ))
            })
    }

    /// 解析 Lance 基础目录
    fn resolve_lance_base(db: &VfsDatabase) -> VfsResult<PathBuf> {
        let vfs_db_path = db.db_path();
        let base_dir = vfs_db_path
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));

        let lance_dir = base_dir.join("lance").join("vfs");
        Self::ensure_dir(&lance_dir)?;

        Ok(lance_dir)
    }

    /// 确保目录存在
    fn ensure_dir(path: &Path) -> VfsResult<()> {
        fs::create_dir_all(path).map_err(|e| {
            VfsError::Other(format!("创建 Lance 目录失败: {} - {}", path.display(), e))
        })
    }

    pub fn next_unit_generation(&self, unit_id: &str, modality: &str) -> VfsResult<i64> {
        let conn = self.db.get_conn()?;
        let column = match modality {
            "text" => "text_generation",
            "image" | "multimodal" => "mm_generation",
            _ => {
                return Err(VfsError::InvalidArgument {
                    param: "modality".to_string(),
                    reason: format!("Unsupported modality: {}", modality),
                })
            }
        };
        let sql = format!("SELECT {} FROM vfs_index_units WHERE id = ?1", column);
        let current = conn
            .query_row(&sql, rusqlite::params![unit_id], |row| row.get::<_, i64>(0))
            .map_err(|error| match error {
                rusqlite::Error::QueryReturnedNoRows => VfsError::NotFound {
                    resource_type: "IndexUnit".to_string(),
                    id: unit_id.to_string(),
                },
                other => VfsError::Database(other.to_string()),
            })?;
        Ok(current.saturating_add(1))
    }

    fn retain_active_unit_generations(
        &self,
        modality: &str,
        results: Vec<VfsLanceSearchResult>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        use std::collections::HashMap;

        let conn = self.db.get_conn()?;
        let (profile_column, generation_column) = match modality {
            "text" => ("text_profile_id", "text_generation"),
            "image" | "multimodal" => ("mm_profile_id", "mm_generation"),
            _ => return Ok(Vec::new()),
        };
        let state_column = if modality == "text" {
            "index_state"
        } else {
            "mm_index_state"
        };
        let sql = format!(
            "SELECT u.{}, u.{},
                    CASE WHEN r.id IS NULL THEN 1
                         WHEN r.deleted_at IS NULL AND COALESCE(r.{}, 'pending') <> 'disabled'
                         THEN 1 ELSE 0 END
             FROM vfs_index_units u
             LEFT JOIN resources r ON r.id = u.resource_id
             WHERE u.id = ?1",
            profile_column, generation_column, state_column
        );
        let mut active: HashMap<String, Option<(Option<String>, i64, bool)>> = HashMap::new();
        let mut legacy_allowed: HashMap<String, bool> = HashMap::new();
        let mut filtered = Vec::with_capacity(results.len());
        for result in results {
            // Legacy rows were created before unit provenance existed.  They
            // remain readable only as generation zero during the migration
            // rebuild window.
            if result.unit_id.is_empty() {
                let allowed = *legacy_allowed
                    .entry(result.resource_id.clone())
                    .or_insert_with(|| {
                        conn.query_row(
                            &format!(
                                "SELECT deleted_at IS NULL AND COALESCE({}, 'pending') <> 'disabled'
                                 FROM resources WHERE id = ?1",
                                state_column
                            ),
                            rusqlite::params![result.resource_id],
                            |row| row.get::<_, bool>(0),
                        )
                        .optional()
                        .ok()
                        .flatten()
                        .unwrap_or(true)
                    });
                if result.generation == 0 && allowed {
                    filtered.push(result);
                }
                continue;
            }
            let state = active.entry(result.unit_id.clone()).or_insert_with(|| {
                conn.query_row(&sql, rusqlite::params![result.unit_id], |row| {
                    Ok((
                        row.get::<_, Option<String>>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i32>(2)? != 0,
                    ))
                })
                .optional()
                .ok()
                .flatten()
            });
            if state
                .as_ref()
                .is_some_and(|(profile_id, generation, allowed)| {
                    *allowed
                        && *generation == result.generation
                        && profile_id.as_deref() == Some(result.index_profile_id.as_str())
                })
            {
                filtered.push(result);
            }
        }
        Ok(filtered)
    }

    /// 获取 Lance 连接路径
    fn get_lance_path(&self) -> String {
        self.lance_base_path.to_string_lossy().to_string()
    }

    /// 获取缓存的 LanceDB 连接（首次调用时建立连接）
    async fn connect(&self) -> VfsResult<&Connection> {
        self.connection
            .get_or_try_init(|| async {
                let path = self.get_lance_path();
                lancedb::connect(&path)
                    .execute()
                    .await
                    .map_err(|e| VfsError::Other(format!("连接 LanceDB 失败: {}", e)))
            })
            .await
    }

    /// 获取表名
    fn table_name(modality: &str, dim: usize) -> String {
        format!("{}{}_{}", VFS_LANCE_TABLE_PREFIX, modality, dim)
    }

    /// Resolve the sole active table for a search/write route.  Tables found
    /// only on disk are never implicitly searched because they may belong to a
    /// retired model with the same output dimension.
    fn active_table_name(&self, modality: &str, dim: usize) -> VfsResult<String> {
        use crate::vfs::repos::embedding_dim_repo;

        let conn = self.db.get_conn()?;
        Ok(embedding_dim_repo::get_by_key(&conn, dim as i32, modality)?
            .map(|registered| registered.lance_table_name)
            .unwrap_or_else(|| Self::table_name(modality, dim)))
    }

    /// 从数据库获取已注册的维度列表
    fn get_registered_dimensions(&self, modality: &str) -> VfsResult<Vec<usize>> {
        use crate::vfs::repos::embedding_dim_repo;

        let conn = self.db.get_conn()?;
        let dims = embedding_dim_repo::list_by_modality(&conn, modality)?;
        Ok(dims.iter().map(|d| d.dimension as usize).collect())
    }

    /// Discover legacy and profiled Lance tables for diagnostics/cleanup only.
    fn discover_tables_from_disk(&self, modality: &str) -> Vec<(String, usize)> {
        let mut tables = Vec::new();
        let prefix = format!("{}{}_", VFS_LANCE_TABLE_PREFIX, modality);

        let entries = match fs::read_dir(&self.lance_base_path) {
            Ok(entries) => entries,
            Err(_) => return tables,
        };

        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            let table_name = name.strip_suffix(".lance").unwrap_or(&name);
            if let Some(suffix) = table_name.strip_prefix(&prefix) {
                if let Some(dim_part) = suffix.split('_').next() {
                    if let Ok(dim) = dim_part.parse::<usize>() {
                        tables.push((table_name.to_string(), dim));
                    }
                }
            }
        }

        tables.sort();
        tables.dedup();
        tables
    }

    fn discover_dimensions_from_disk(&self, modality: &str) -> Vec<usize> {
        self.discover_tables_from_disk(modality)
            .into_iter()
            .map(|(_, dim)| dim)
            .collect()
    }

    fn cleanup_table_names(&self, modality: &str) -> VfsResult<Vec<String>> {
        use crate::vfs::repos::embedding_dim_repo;

        let conn = self.db.get_conn()?;
        let mut names = embedding_dim_repo::list_by_modality(&conn, modality)?
            .into_iter()
            .map(|dim| dim.lance_table_name)
            .collect::<Vec<_>>();
        names.extend(
            self.discover_tables_from_disk(modality)
                .into_iter()
                .map(|(name, _)| name),
        );
        names.sort();
        names.dedup();
        Ok(names)
    }

    fn table_has_only_unreferenced_retired_profiles(&self, table_name: &str) -> VfsResult<bool> {
        let conn = self.db.get_conn()?;
        let (profile_count, unsafe_profile_count): (i64, i64) = conn.query_row(
            "SELECT COUNT(*),
                    COALESCE(SUM(CASE
                        WHEN p.state = 'retired'
                         AND NOT EXISTS (
                            SELECT 1 FROM vfs_index_segments s
                            WHERE s.index_profile_id = p.id
                         )
                         AND NOT EXISTS (
                            SELECT 1 FROM vfs_embedding_dims d
                            WHERE d.active_profile_id = p.id
                         )
                         AND NOT EXISTS (
                            SELECT 1 FROM vfs_index_units u
                            WHERE u.text_profile_id = p.id OR u.mm_profile_id = p.id
                         )
                        THEN 0 ELSE 1 END), 0)
             FROM vfs_index_profiles p
             WHERE p.lance_table_name = ?1",
            rusqlite::params![table_name],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let dimension_still_points_to_table: bool = conn.query_row(
            "SELECT EXISTS(
                SELECT 1 FROM vfs_embedding_dims WHERE lance_table_name = ?1
             )",
            rusqlite::params![table_name],
            |row| row.get(0),
        )?;
        Ok(profile_count > 0 && unsafe_profile_count == 0 && !dimension_still_points_to_table)
    }

    fn retired_profile_table_candidates(&self) -> VfsResult<Vec<String>> {
        let table_names = {
            let conn = self.db.get_conn()?;
            let mut stmt = conn.prepare(
                "SELECT DISTINCT lance_table_name
                 FROM vfs_index_profiles
                 WHERE state = 'retired'
                 ORDER BY lance_table_name",
            )?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))?
                .collect::<Result<Vec<_>, _>>()?;
            rows
        };
        table_names
            .into_iter()
            .filter_map(|table_name| {
                match self.table_has_only_unreferenced_retired_profiles(&table_name) {
                    Ok(true) => Some(Ok(table_name)),
                    Ok(false) => None,
                    Err(error) => Some(Err(error)),
                }
            })
            .collect()
    }

    async fn sweep_retired_profile_tables_inner<F>(&self, mut pre_drop: F) -> VfsResult<usize>
    where
        F: FnMut(&str) -> VfsResult<()>,
    {
        // Retired profile rows remain as durable retry intents after a successful
        // drop. Local Lance tables are directory-backed, so avoid reopening the
        // catalog on every worker tick once all candidate directories are gone.
        // A failed drop leaves its directory in place and remains retryable.
        let candidates = self
            .retired_profile_table_candidates()?
            .into_iter()
            .filter(|table_name| {
                self.lance_base_path
                    .join(format!("{table_name}.lance"))
                    .exists()
            })
            .collect::<Vec<_>>();
        if candidates.is_empty() {
            return Ok(0);
        }
        let existing_tables = self
            .connect()
            .await?
            .table_names()
            .execute()
            .await
            .map_err(|error| {
                VfsError::Other(format!(
                    "list Lance tables for retired sweep failed: {error}"
                ))
            })?;
        let mut dropped = 0usize;
        let mut first_error = None;
        for table_name in candidates {
            if !existing_tables.contains(&table_name) {
                continue;
            }
            if let Err(error) = pre_drop(&table_name) {
                if first_error.is_none() {
                    first_error = Some(error);
                }
                continue;
            }
            match self.drop_table(&table_name).await {
                Ok(()) => dropped += 1,
                Err(error) if first_error.is_none() => first_error = Some(error),
                Err(_) => {}
            }
        }
        if let Some(error) = first_error {
            Err(error)
        } else {
            Ok(dropped)
        }
    }

    async fn ensure_lifecycle_columns(
        &self,
        table: &Table,
        modality: &str,
        dim: usize,
        explicit_profile_id: Option<&str>,
    ) -> VfsResult<()> {
        let schema = table.schema().await.map_err(|error| {
            VfsError::Other(format!("读取 Lance 生命周期 schema 失败: {}", error))
        })?;
        let profile_id = if let Some(profile_id) = explicit_profile_id {
            profile_id.to_string()
        } else {
            let conn = self.db.get_conn()?;
            crate::vfs::repos::embedding_dim_repo::get_by_key(&conn, dim as i32, modality)?
                .and_then(|dim| dim.active_profile_id)
                .unwrap_or_else(|| format!("profile_legacy_{}_{}", modality, dim))
        };
        let escaped_profile = profile_id.replace("'", "''");
        let mut expressions: Vec<(String, String)> = Vec::new();
        if schema.field_with_name("unit_id").is_err() {
            expressions.push(("unit_id".to_string(), "''".to_string()));
        }
        if schema.field_with_name("index_profile_id").is_err() {
            expressions.push((
                "index_profile_id".to_string(),
                format!("'{}'", escaped_profile),
            ));
        }
        if schema.field_with_name("generation").is_err() {
            expressions.push(("generation".to_string(), "CAST(0 AS BIGINT)".to_string()));
        }
        if !expressions.is_empty() {
            table
                .add_columns(NewColumnTransform::SqlExpressions(expressions), None)
                .await
                .map_err(|error| {
                    VfsError::Other(format!(
                        "升级 legacy Lance 表生命周期列失败 ({}:{}): {}",
                        modality, dim, error
                    ))
                })?;
        }
        Ok(())
    }

    fn get_all_registered_dimensions(&self) -> VfsResult<Vec<(String, usize)>> {
        use crate::vfs::repos::embedding_dim_repo;

        let conn = self.db.get_conn()?;
        let dims = embedding_dim_repo::list_all(&conn)?;
        Ok(dims
            .iter()
            .map(|d| (d.modality.clone(), d.dimension as usize))
            .collect())
    }

    // ========================================================================
    // 表管理
    // ========================================================================

    /// 删除指定的 LanceDB 表（S2 fix: 维度删除时清理向量数据）
    ///
    /// 如果表不存在则静默返回 Ok。
    pub async fn drop_table(&self, table_name: &str) -> VfsResult<()> {
        let conn = self.connect().await?;
        // 同步失效 ensure_table 的"已就绪"缓存，避免 drop 后用过期标记跳过重建
        if let Ok(mut set) = self.ensured_tables.lock() {
            set.remove(table_name);
        }
        match conn.drop_table(table_name, &[]).await {
            Ok(_) => {
                info!("[VfsLanceStore] Dropped table: {}", table_name);
                Ok(())
            }
            Err(e) => {
                let msg = e.to_string();
                // 表不存在不算错误
                if msg.contains("not found")
                    || msg.contains("does not exist")
                    || msg.contains("Table not found")
                {
                    debug!(
                        "[VfsLanceStore] Table {} does not exist, skip drop",
                        table_name
                    );
                    Ok(())
                } else {
                    Err(VfsError::Other(format!(
                        "Failed to drop Lance table {}: {}",
                        table_name, e
                    )))
                }
            }
        }
    }

    /// Repeatedly reclaim physical tables whose profiles are durably retired and
    /// no longer referenced by dimensions, Units, or Segment manifests. Retired
    /// profile rows remain the retry intent when a drop fails or the app exits.
    pub async fn sweep_retired_profile_tables(&self) -> VfsResult<usize> {
        self.sweep_retired_profile_tables_inner(|_| Ok(())).await
    }

    /// 确保向量表存在（动态创建）
    pub async fn ensure_table(&self, modality: &str, dim: usize) -> VfsResult<Table> {
        let conn = self.connect().await?;
        let table_name = self.active_table_name(modality, dim)?;

        // 快路径：本进程已确认过该表与索引，直接打开
        let already_ensured = self
            .ensured_tables
            .lock()
            .map(|set| set.contains(&table_name))
            .unwrap_or(false);

        let tbl = match conn.open_table(&table_name).execute().await {
            Ok(tbl) => {
                if already_ensured {
                    return Ok(tbl);
                }
                tbl
            }
            Err(lancedb::Error::TableNotFound { .. }) => {
                // 打不开则视为表缺失：清掉可能过期的缓存标记后重建
                if let Ok(mut set) = self.ensured_tables.lock() {
                    set.remove(&table_name);
                }
                // 创建新表
                let schema = Self::build_schema(dim);
                let empty: Vec<std::result::Result<RecordBatch, arrow_schema::ArrowError>> =
                    Vec::new();
                let iter = RecordBatchIterator::new(empty.into_iter(), Arc::new(schema));

                conn.create_table(&table_name, iter)
                    .execute()
                    .await
                    .map_err(|e| VfsError::Other(format!("创建 Lance 表失败: {}", e)))?
            }
            Err(error) => {
                return Err(VfsError::Other(format!(
                    "打开 Lance 表 {} 失败: {}",
                    table_name, error
                )))
            }
        };

        self.ensure_lifecycle_columns(&tbl, modality, dim, None)
            .await?;

        let row_count = tbl.count_rows(None).await.map_err(|error| {
            VfsError::Other(format!("统计 Lance 表 {} 行数失败: {}", table_name, error))
        })?;

        // Existing Index::Auto indices were trained with L2.  Never allow one
        // to answer a cosine query: tiny tables use exact search, larger tables
        // are rebuilt once with an explicit cosine metric.
        let embed_ok = if row_count < MIN_ROWS_FOR_ANN_INDEX {
            let sql_conn = self.db.get_conn()?;
            let _ = crate::vfs::repos::embedding_dim_repo::set_ann_status(
                &sql_conn,
                dim as i32,
                modality,
                "exact",
                ANN_INDEX_VERSION,
            );
            true
        } else {
            let dim_state = {
                let sql_conn = self.db.get_conn()?;
                crate::vfs::repos::embedding_dim_repo::get_by_key(&sql_conn, dim as i32, modality)?
            };
            let must_replace = dim_state.as_ref().is_some_and(|state| {
                state.ann_metric != "cosine" || state.ann_index_version != ANN_INDEX_VERSION
            });
            let embed_start = Instant::now();
            match tbl
                .create_index(
                    &["embedding"],
                    Index::IvfPq(IvfPqIndexBuilder::default().distance_type(DistanceType::Cosine)),
                )
                .replace(must_replace)
                .execute()
                .await
            {
                Ok(_) => {
                    let sql_conn = self.db.get_conn()?;
                    crate::vfs::repos::embedding_dim_repo::set_ann_status(
                        &sql_conn,
                        dim as i32,
                        modality,
                        "cosine",
                        ANN_INDEX_VERSION,
                    )?;
                    debug!(
                        "[VfsLanceStore] ensured cosine embedding index on {} in {}ms",
                        table_name,
                        embed_start.elapsed().as_millis()
                    );
                    true
                }
                Err(error) if !must_replace && error.to_string().contains("already exists") => true,
                Err(error) => {
                    return Err(VfsError::Other(format!(
                        "创建 Cosine IVF-PQ 索引失败 (table={}, rows={}): {}",
                        table_name, row_count, error
                    )))
                }
            }
        };

        // 确保 FTS 索引
        let fts_start = Instant::now();
        let fts_builder = self.build_fts_index_builder();
        let fts_res = tbl
            .create_index(&["text"], Index::FTS(fts_builder))
            .replace(false)
            .execute()
            .await;

        let mut fts_ok = true;
        match fts_res {
            Ok(_) => {
                debug!(
                    "[VfsLanceStore] ensured FTS index on {} in {}ms",
                    table_name,
                    fts_start.elapsed().as_millis()
                );
            }
            Err(err) => {
                let msg = err.to_string();
                if !msg.contains("already exists") {
                    fts_ok = false;
                    warn!(
                        "[VfsLanceStore] FTS index ensure failed on {}: {}",
                        table_name, msg
                    );
                }
            }
        }

        let mut scalar_ok = true;
        for (column, index) in [
            ("resource_id", Index::BTree(BTreeIndexBuilder::default())),
            ("folder_id", Index::BTree(BTreeIndexBuilder::default())),
            (
                "resource_type",
                Index::Bitmap(BitmapIndexBuilder::default()),
            ),
        ] {
            if let Err(error) = tbl
                .create_index(&[column], index)
                .replace(false)
                .execute()
                .await
            {
                if !error.to_string().contains("already exists") {
                    scalar_ok = false;
                    warn!(
                        "[VfsLanceStore] scalar index ensure failed on {}.{}: {}",
                        table_name, column, error
                    );
                }
            }
        }

        // Keep exact-search tables uncached so they can cross the ANN threshold
        // after later writes without an application restart.
        if embed_ok && fts_ok && scalar_ok && row_count >= MIN_ROWS_FOR_ANN_INDEX {
            if let Ok(mut set) = self.ensured_tables.lock() {
                set.insert(table_name);
            }
        }

        Ok(tbl)
    }

    /// 构建表 Schema
    fn build_schema(dim: usize) -> Schema {
        Schema::new(vec![
            Field::new("embedding_id", DataType::Utf8, false),
            Field::new("resource_id", DataType::Utf8, false),
            Field::new("unit_id", DataType::Utf8, false),
            Field::new("resource_type", DataType::Utf8, false),
            Field::new("folder_id", DataType::Utf8, true),
            Field::new("chunk_index", DataType::Int32, false),
            Field::new("text", DataType::Utf8, false),
            Field::new("metadata", DataType::Utf8, true),
            Field::new("created_at", DataType::Utf8, false),
            Field::new("index_profile_id", DataType::Utf8, false),
            Field::new("generation", DataType::Int64, false),
            Field::new(
                "embedding",
                DataType::FixedSizeList(
                    Arc::new(Field::new("item", DataType::Float32, false)),
                    dim as i32,
                ),
                false,
            ),
        ])
    }

    /// 构建 FTS 索引配置
    fn build_fts_index_builder(&self) -> FtsIndexBuilder {
        // ngram 分词器：prefix_only=false 确保 CJK 文本任意位置子串均可召回
        // (prefix_only=true 会导致搜索"学习"无法匹配"机器学习")
        FtsIndexBuilder::default()
            .base_tokenizer("ngram".to_string())
            .ngram_min_length(2)
            .ngram_max_length(4)
            .ngram_prefix_only(false)
            .max_token_length(Some(64))
            .lower_case(true)
            .stem(false)
            .remove_stop_words(false)
            .ascii_folding(true)
    }

    // ========================================================================
    // 写入操作
    // ========================================================================

    /// 批量写入向量数据
    pub async fn write_chunks(&self, modality: &str, rows: &[VfsLanceRow]) -> VfsResult<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let _mutation_guard = VFS_MUTATION_LOCK.read().await;

        let dim = rows[0].embedding.len();
        let profile_id = rows[0].index_profile_id.as_str();
        if profile_id.is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "index_profile_id".to_string(),
                reason: "Vector rows must identify their index profile".to_string(),
            });
        }
        if rows.iter().any(|row| {
            row.index_profile_id != profile_id
                || row.embedding.len() != dim
                || row.unit_id.is_empty()
                || row.generation < 0
        }) {
            return Err(VfsError::InvalidArgument {
                param: "rows".to_string(),
                reason: "A Lance write batch must use one profile and dimension, with non-empty Unit IDs and non-negative generations".to_string(),
            });
        }

        // Route by immutable profile identity instead of the mutable
        // dimension-level pointer.  A same-dimension model switch can happen
        // while an embedding request is in flight; resolving the table from
        // the rows prevents those vectors from contaminating the new space.
        let profile = {
            let conn = self.db.get_conn()?;
            let profile =
                crate::vfs::repos::embedding_dim_repo::get_profile_by_id(&conn, profile_id)?
                    .ok_or_else(|| VfsError::NotFound {
                        resource_type: "IndexProfile".to_string(),
                        id: profile_id.to_string(),
                    })?;
            let is_current_write_profile =
                crate::vfs::repos::embedding_dim_repo::get_active_profile(
                    &conn, dim as i32, modality,
                )?
                .is_some_and(|active| active.id == profile.id);
            if profile.dimension as usize != dim
                || profile.modality != modality
                || !matches!(profile.state.as_str(), "active" | "building")
                || !is_current_write_profile
            {
                return Err(VfsError::InvalidState {
                    message: format!(
                        "Index profile {} is no longer the writable {}:{} profile",
                        profile.id, modality, dim
                    ),
                });
            }
            profile
        };

        let with_metadata = rows.iter().filter(|r| r.metadata_json.is_some()).count();
        info!(
            "[VfsLanceStore] write_chunks: dim={}, rows={}, with_metadata={}",
            dim,
            rows.len(),
            with_metadata
        );
        if with_metadata > 0 {
            if let Some(first_meta) = rows.iter().find_map(|r| r.metadata_json.as_ref()) {
                info!("[VfsLanceStore] sample metadata_json: {}", first_meta);
            }
        }

        let tbl = self.open_profile_table(&profile).await?;
        let row_count_before = tbl.count_rows(None).await.map_err(|error| {
            VfsError::Other(format!(
                "Count rows before profile write {} failed: {}",
                profile.lance_table_name, error
            ))
        })?;

        let (schema, batch) = self.build_batch(dim, rows)?;
        let iter = RecordBatchIterator::new(vec![Ok(batch)].into_iter(), schema);

        let mut builder = tbl.merge_insert(&["embedding_id"]);
        builder.when_matched_update_all(None);
        builder.when_not_matched_insert_all();
        builder
            .execute(Box::new(iter))
            .await
            .map_err(|e| VfsError::Other(format!("写入 Lance 表失败 (merge_insert): {}", e)))?;

        if row_count_before < MIN_ROWS_FOR_ANN_INDEX
            && row_count_before.saturating_add(rows.len()) >= MIN_ROWS_FOR_ANN_INDEX
        {
            if let Ok(mut ensured) = self.ensured_tables.lock() {
                ensured.remove(&profile.lance_table_name);
            }
        }

        info!(
            "[VfsLanceStore] Wrote {} chunks to {} (merge_insert)",
            rows.len(),
            profile.lance_table_name
        );

        Ok(())
    }

    /// 构建 RecordBatch
    fn build_batch(
        &self,
        dim: usize,
        rows: &[VfsLanceRow],
    ) -> VfsResult<(Arc<Schema>, RecordBatch)> {
        let n = rows.len();
        let mut flat: Vec<f32> = Vec::with_capacity(n * dim);

        for row in rows.iter() {
            if row.embedding.len() != dim {
                return Err(VfsError::InvalidArgument {
                    param: "embedding".to_string(),
                    reason: format!("维度不一致: expected {}, got {}", dim, row.embedding.len()),
                });
            }
            flat.extend_from_slice(&row.embedding);
        }

        let schema = Arc::new(Self::build_schema(dim));

        let embedding_id_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.embedding_id.as_str()),
        ));
        let resource_id_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.resource_id.as_str()),
        ));
        let unit_id_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.unit_id.as_str()),
        ));
        let resource_type_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.resource_type.as_str()),
        ));
        let folder_id_arr: ArrayRef = Arc::new(StringArray::from_iter(
            rows.iter().map(|r| r.folder_id.as_deref()),
        ));
        let chunk_index_arr: ArrayRef = Arc::new(Int32Array::from_iter_values(
            rows.iter().map(|r| r.chunk_index),
        ));
        let text_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.text.as_str()),
        ));
        let metadata_arr: ArrayRef = Arc::new(StringArray::from_iter(
            rows.iter().map(|r| r.metadata_json.as_deref()),
        ));
        let created_at_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.created_at.as_str()),
        ));
        let index_profile_id_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.index_profile_id.as_str()),
        ));
        let generation_arr: ArrayRef = Arc::new(Int64Array::from_iter_values(
            rows.iter().map(|r| r.generation),
        ));

        let values = Arc::new(Float32Array::from(flat)) as ArrayRef;
        let field_ref = Arc::new(Field::new("item", DataType::Float32, false));
        let embedding_arr: ArrayRef = Arc::new(
            FixedSizeListArray::try_new(field_ref, dim as i32, values, None)
                .map_err(|e| VfsError::Other(format!("构建 embedding 数组失败: {}", e)))?,
        );

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                embedding_id_arr,
                resource_id_arr,
                unit_id_arr,
                resource_type_arr,
                folder_id_arr,
                chunk_index_arr,
                text_arr,
                metadata_arr,
                created_at_arr,
                index_profile_id_arr,
                generation_arr,
                embedding_arr,
            ],
        )
        .map_err(|e| VfsError::Other(format!("构建批次失败: {}", e)))?;

        Ok((schema, batch))
    }

    /// 删除资源的所有向量
    ///
    /// ★ 2026-06-13（第二轮审阅 F13）：表级删除失败不再静默吞掉（与
    /// delete_by_embedding_ids 的 F8 修复同模式）。此前 is_ok() 吞错导致：
    /// 1. index_handlers 的 DeleteIndexResult.lance*Ok/retryable 契约失真
    ///    （删除失败仍上报成功，前端永远看不到可重试状态）；
    /// 2. indexing.rs delete_resource_index 在 mm 向量删除失败时照删
    ///    SQLite 元数据，孤儿向量无人再清。
    ///
    /// 所有调用方都已有 Err 处理分支（warn / 传播 / `let _ =`），行为兼容。
    pub async fn delete_by_resource(&self, modality: &str, resource_id: &str) -> VfsResult<usize> {
        let conn = self.connect().await?;
        let mut deleted = 0usize;

        let mut first_err: Option<VfsError> = None;
        for table_name in self.cleanup_table_names(modality)? {
            match conn.open_table(&table_name).execute().await {
                Ok(tbl) => {
                    let expr = format!("resource_id = '{}'", resource_id.replace("'", "''"));
                    match tbl.delete(expr.as_str()).await {
                        Ok(_) => deleted += 1,
                        Err(e) => {
                            warn!(
                                "[VfsLanceStore] delete_by_resource failed on table {}: {}",
                                table_name, e
                            );
                            if first_err.is_none() {
                                first_err = Some(VfsError::Other(format!(
                                    "delete_by_resource failed on {}: {}",
                                    table_name, e
                                )));
                            }
                        }
                    }
                }
                Err(lancedb::Error::TableNotFound { .. }) => {}
                Err(error) if first_err.is_none() => {
                    first_err = Some(VfsError::Other(format!(
                        "open table for delete_by_resource failed on {}: {}",
                        table_name, error
                    )));
                }
                Err(_) => {}
            }
        }

        if let Some(e) = first_err {
            return Err(e);
        }

        debug!(
            "[VfsLanceStore] Deleted vectors for resource {} from {} tables",
            resource_id, deleted
        );

        Ok(deleted)
    }

    /// 删除资源向量，但保留指定维度的表（用于无空窗重建流程）。
    pub async fn delete_by_resource_except_dim(
        &self,
        modality: &str,
        resource_id: &str,
        keep_dim: usize,
    ) -> VfsResult<usize> {
        let conn = self.connect().await?;
        let mut deleted = 0usize;

        let keep_table = self.active_table_name(modality, keep_dim)?;

        // ★ 2026-06-13（第二轮审阅 F13）：同 delete_by_resource，删除失败上报错误。
        let mut first_err: Option<VfsError> = None;
        for table_name in self.cleanup_table_names(modality)? {
            if table_name == keep_table {
                continue;
            }
            if let Ok(tbl) = conn.open_table(&table_name).execute().await {
                let expr = format!("resource_id = '{}'", resource_id.replace("'", "''"));
                match tbl.delete(expr.as_str()).await {
                    Ok(_) => deleted += 1,
                    Err(e) => {
                        warn!(
                            "[VfsLanceStore] delete_by_resource_except_dim failed on table {}: {}",
                            table_name, e
                        );
                        if first_err.is_none() {
                            first_err = Some(VfsError::Other(format!(
                                "delete_by_resource_except_dim failed on {}: {}",
                                table_name, e
                            )));
                        }
                    }
                }
            }
        }

        if let Some(e) = first_err {
            return Err(e);
        }

        debug!(
            "[VfsLanceStore] Deleted vectors for resource {} from {} tables (keep_dim={})",
            resource_id, deleted, keep_dim
        );

        Ok(deleted)
    }

    /// 删除资源的旧向量，但保留指定的 embedding_id 集合。
    ///
    /// 用于"先写后删"原子性保护：新嵌入写入 Lance 后，通过排除新 embedding_id
    /// 来安全清理旧批次残留，避免先删后写导致的检索空窗。
    pub async fn delete_by_resource_except_ids(
        &self,
        modality: &str,
        resource_id: &str,
        keep_ids: &[String],
    ) -> VfsResult<usize> {
        let conn = self.connect().await?;
        let mut deleted = 0usize;

        let escaped_resource_id = resource_id.replace("'", "''");

        // ★ 2026-06-13（第二轮审阅 F13）：同 delete_by_resource，删除失败上报错误。
        let mut first_err: Option<VfsError> = None;
        for table_name in self.cleanup_table_names(modality)? {
            if let Ok(tbl) = conn.open_table(&table_name).execute().await {
                let expr = if keep_ids.is_empty() {
                    format!("resource_id = '{}'", escaped_resource_id)
                } else {
                    let in_list = keep_ids
                        .iter()
                        .map(|s| format!("'{}'", s.replace("'", "''")))
                        .collect::<Vec<_>>()
                        .join(",");
                    format!(
                        "resource_id = '{}' AND embedding_id NOT IN ({})",
                        escaped_resource_id, in_list
                    )
                };
                match tbl.delete(expr.as_str()).await {
                    Ok(_) => deleted += 1,
                    Err(e) => {
                        warn!(
                            "[VfsLanceStore] delete_by_resource_except_ids failed on table {}: {}",
                            table_name, e
                        );
                        if first_err.is_none() {
                            first_err = Some(VfsError::Other(format!(
                                "delete_by_resource_except_ids failed on {}: {}",
                                table_name, e
                            )));
                        }
                    }
                }
            }
        }

        if let Some(e) = first_err {
            return Err(e);
        }

        debug!(
            "[VfsLanceStore] Deleted old vectors for resource {} from {} tables (kept {} embedding ids)",
            resource_id, deleted, keep_ids.len()
        );

        Ok(deleted)
    }

    /// Delete superseded generations for one Unit after SQLite has atomically
    /// activated the new generation.  Empty unit_id rows are legacy rows and
    /// are included during the first rebuild of a resource.
    pub async fn delete_by_unit_except_ids(
        &self,
        modality: &str,
        resource_id: &str,
        unit_id: &str,
        keep_ids: &[String],
    ) -> VfsResult<usize> {
        let conn = self.connect().await?;
        let escaped_resource = resource_id.replace("'", "''");
        let escaped_unit = unit_id.replace("'", "''");
        let keep_clause = if keep_ids.is_empty() {
            String::new()
        } else {
            let values = keep_ids
                .iter()
                .map(|id| format!("'{}'", id.replace("'", "''")))
                .collect::<Vec<_>>()
                .join(",");
            format!(" AND embedding_id NOT IN ({})", values)
        };
        let expr = format!(
            "resource_id = '{}' AND (unit_id = '{}' OR unit_id = ''){}",
            escaped_resource, escaped_unit, keep_clause
        );
        let mut deleted = 0usize;
        let mut first_error = None;
        for table_name in self.cleanup_table_names(modality)? {
            match conn.open_table(&table_name).execute().await {
                Ok(table) => {
                    let schema = match table.schema().await {
                        Ok(schema) => schema,
                        Err(error) => {
                            if first_error.is_none() {
                                first_error = Some(VfsError::Other(format!(
                                    "read schema for unit cleanup failed on {}: {}",
                                    table_name, error
                                )));
                            }
                            continue;
                        }
                    };
                    let missing_lifecycle_columns = ["unit_id", "index_profile_id", "generation"]
                        .into_iter()
                        .filter(|column| schema.field_with_name(column).is_err())
                        .collect::<Vec<_>>();
                    if !missing_lifecycle_columns.is_empty() {
                        if self.table_has_only_unreferenced_retired_profiles(&table_name)? {
                            drop(table);
                            match self.drop_table(&table_name).await {
                                Ok(()) => {
                                    deleted += 1;
                                    info!(
                                        "[VfsLanceStore] Dropped unreferenced retired legacy table {}",
                                        table_name
                                    );
                                }
                                Err(error) if first_error.is_none() => {
                                    first_error = Some(error);
                                }
                                Err(_) => {}
                            }
                        } else {
                            debug!(
                                "[VfsLanceStore] Skipping per-Unit cleanup on referenced legacy table {} missing {:?}; retirement sweep will retry whole-table reclamation after references reach zero",
                                table_name, missing_lifecycle_columns
                            );
                        }
                        continue;
                    }
                    match table.delete(&expr).await {
                        Ok(_) => deleted += 1,
                        Err(error) if first_error.is_none() => {
                            first_error = Some(VfsError::Other(format!(
                                "delete_by_unit_except_ids failed on {}: {}",
                                table_name, error
                            )));
                        }
                        Err(_) => {}
                    }
                }
                Err(lancedb::Error::TableNotFound { .. }) => {}
                Err(error) if first_error.is_none() => {
                    first_error = Some(VfsError::Other(format!(
                        "open table for unit cleanup failed on {}: {}",
                        table_name, error
                    )));
                }
                Err(_) => {}
            }
        }
        if let Some(error) = first_error {
            Err(error)
        } else {
            Ok(deleted)
        }
    }

    /// 按 embedding_id 批量删除向量（用于元数据写入失败后的补偿回滚）。
    pub async fn delete_by_embedding_ids(
        &self,
        modality: &str,
        embedding_ids: &[String],
    ) -> VfsResult<usize> {
        if embedding_ids.is_empty() {
            return Ok(0);
        }

        let conn = self.connect().await?;
        let mut deleted = 0usize;

        let in_list = embedding_ids
            .iter()
            .map(|s| format!("'{}'", s.replace("'", "''")))
            .collect::<Vec<_>>()
            .join(",");
        let expr = format!("embedding_id IN ({})", in_list);

        // ★ 2026-06-12（本轮审阅）：表级删除失败不再静默吞掉。
        // drain_lance_orphan_queue 依赖本函数的 Err 来保留队列条目并递增 retry_count；
        // 此前 is_ok() 吞错导致"删除失败但出队"，孤儿向量清理保证失效。
        // 仍保持 best-effort：先尝试所有表，最后统一上报第一个错误。
        let mut first_err: Option<VfsError> = None;
        for table_name in self.cleanup_table_names(modality)? {
            match conn.open_table(&table_name).execute().await {
                Ok(tbl) => match tbl.delete(expr.as_str()).await {
                    Ok(_) => deleted += 1,
                    Err(e) => {
                        warn!(
                            "[VfsLanceStore] delete_by_embedding_ids failed on table {}: {}",
                            table_name, e
                        );
                        if first_err.is_none() {
                            first_err = Some(VfsError::Other(format!(
                                "delete_by_embedding_ids failed on {}: {}",
                                table_name, e
                            )));
                        }
                    }
                },
                Err(lancedb::Error::TableNotFound { .. }) => {}
                Err(error) => {
                    warn!(
                        "[VfsLanceStore] open table for delete_by_embedding_ids failed on {}: {}",
                        table_name, error
                    );
                    if first_err.is_none() {
                        first_err = Some(VfsError::Other(format!(
                            "open table for delete_by_embedding_ids failed on {}: {}",
                            table_name, error
                        )));
                    }
                }
            }
        }

        if let Some(e) = first_err {
            return Err(e);
        }
        Ok(deleted)
    }

    /// Reclaim rows that were written to Lance but never committed to the
    /// SQLite Segment manifest.  The deletion intent is persisted before the
    /// async fast path so a crash or transient Lance failure cannot leak rows.
    pub async fn discard_uncommitted_rows(
        &self,
        modality: &str,
        resource_id: &str,
        embedding_ids: &[String],
    ) -> VfsResult<()> {
        if embedding_ids.is_empty() {
            return Ok(());
        }
        {
            let conn = self.db.get_conn()?;
            for embedding_id in embedding_ids {
                crate::vfs::repos::index_segment_repo::enqueue_lance_orphan(
                    &conn,
                    embedding_id,
                    Some(resource_id),
                )?;
            }
        }

        self.delete_by_embedding_ids(modality, embedding_ids)
            .await?;

        let conn = self.db.get_conn()?;
        for embedding_id in embedding_ids {
            conn.execute(
                "DELETE FROM __lance_orphan_queue WHERE lance_row_id = ?1",
                rusqlite::params![embedding_id],
            )?;
        }
        Ok(())
    }

    // ========================================================================
    // 检索操作
    // ========================================================================

    /// 向量检索
    pub async fn vector_search(
        &self,
        modality: &str,
        query_embedding: &[f32],
        top_k: usize,
        folder_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        self.vector_search_full(
            modality,
            query_embedding,
            top_k,
            folder_ids,
            None,
            resource_types,
        )
        .await
    }

    /// Legacy dimension-only vector lookup is disabled because a bare vector does not
    /// identify the model fingerprint/profile that produced it.
    pub async fn vector_search_full(
        &self,
        modality: &str,
        query_embedding: &[f32],
        top_k: usize,
        folder_ids: Option<&[String]>,
        resource_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        let _ = (
            modality,
            query_embedding,
            top_k,
            folder_ids,
            resource_ids,
            resource_types,
        );
        Err(VfsError::InvalidState {
            message: "dimension-only VFS vector search is disabled; use vector_search_profile_full with a planner-selected profile_id"
                .to_string(),
        })
    }

    fn resolve_active_profile_for_search(
        &self,
        profile_id: &str,
    ) -> VfsResult<crate::vfs::repos::embedding_dim_repo::VfsIndexProfile> {
        let conn = self.db.get_conn()?;
        let profile = crate::vfs::repos::embedding_dim_repo::get_profile_by_id(&conn, profile_id)?
            .ok_or_else(|| VfsError::NotFound {
                resource_type: "IndexProfile".to_string(),
                id: profile_id.to_string(),
            })?;
        let referenced: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM vfs_index_segments WHERE index_profile_id = ?1)
                    OR EXISTS(SELECT 1 FROM vfs_embedding_dims WHERE active_profile_id = ?1)",
            rusqlite::params![profile_id],
            |row| row.get(0),
        )?;
        if !matches!(profile.state.as_str(), "active" | "building" | "queryable") || !referenced {
            return Err(VfsError::InvalidState {
                message: format!("Index profile {} is not queryable", profile_id),
            });
        }
        Ok(profile)
    }

    async fn ensure_profile_secondary_indexes(&self, table: &Table, table_name: &str) -> bool {
        let mut all_ready = true;
        if let Err(error) = table
            .create_index(&["text"], Index::FTS(self.build_fts_index_builder()))
            .replace(false)
            .execute()
            .await
        {
            if !error.to_string().contains("already exists") {
                all_ready = false;
                warn!(
                    "[VfsLanceStore] profile FTS index ensure failed on {}: {}",
                    table_name, error
                );
            }
        }
        for (column, index) in [
            ("resource_id", Index::BTree(BTreeIndexBuilder::default())),
            ("folder_id", Index::BTree(BTreeIndexBuilder::default())),
            (
                "resource_type",
                Index::Bitmap(BitmapIndexBuilder::default()),
            ),
        ] {
            if let Err(error) = table
                .create_index(&[column], index)
                .replace(false)
                .execute()
                .await
            {
                if !error.to_string().contains("already exists") {
                    all_ready = false;
                    warn!(
                        "[VfsLanceStore] profile scalar index ensure failed on {}.{}: {}",
                        table_name, column, error
                    );
                }
            }
        }
        all_ready
    }

    async fn open_profile_table(
        &self,
        profile: &crate::vfs::repos::embedding_dim_repo::VfsIndexProfile,
    ) -> VfsResult<Table> {
        let connection = self.connect().await?;
        let table = match connection
            .open_table(&profile.lance_table_name)
            .execute()
            .await
        {
            Ok(table) => table,
            Err(lancedb::Error::TableNotFound { .. })
                if matches!(profile.state.as_str(), "active" | "building") =>
            {
                if let Ok(mut ensured) = self.ensured_tables.lock() {
                    ensured.remove(&profile.lance_table_name);
                }
                let empty: Vec<Result<RecordBatch, arrow_schema::ArrowError>> = Vec::new();
                let batches = RecordBatchIterator::new(
                    empty.into_iter(),
                    Arc::new(Self::build_schema(profile.dimension as usize)),
                );
                connection
                    .create_table(&profile.lance_table_name, batches)
                    .execute()
                    .await
                    .map_err(|error| {
                        VfsError::Other(format!(
                            "创建 profile Lance 表 {} 失败: {}",
                            profile.lance_table_name, error
                        ))
                    })?
            }
            Err(error) => {
                return Err(VfsError::Other(format!(
                    "打开 profile Lance 表 {} 失败: {}",
                    profile.lance_table_name, error
                )))
            }
        };
        if self
            .ensured_tables
            .lock()
            .map(|ensured| ensured.contains(&profile.lance_table_name))
            .unwrap_or(false)
        {
            return Ok(table);
        }

        self.ensure_lifecycle_columns(
            &table,
            &profile.modality,
            profile.dimension as usize,
            Some(&profile.id),
        )
        .await?;

        let row_count = table.count_rows(None).await.map_err(|error| {
            VfsError::Other(format!(
                "统计 profile Lance 表 {} 失败: {}",
                profile.lance_table_name, error
            ))
        })?;
        if row_count >= MIN_ROWS_FOR_ANN_INDEX {
            let must_replace =
                profile.ann_metric != "cosine" || profile.ann_index_version != ANN_INDEX_VERSION;
            match table
                .create_index(
                    &["embedding"],
                    Index::IvfPq(IvfPqIndexBuilder::default().distance_type(DistanceType::Cosine)),
                )
                .replace(must_replace)
                .execute()
                .await
            {
                Ok(_) => {
                    let conn = self.db.get_conn()?;
                    crate::vfs::repos::embedding_dim_repo::set_profile_ann_status(
                        &conn,
                        &profile.id,
                        "cosine",
                        ANN_INDEX_VERSION,
                    )?;
                }
                Err(error) if !must_replace && error.to_string().contains("already exists") => {}
                Err(error) => {
                    return Err(VfsError::Other(format!(
                        "创建 profile Cosine IVF-PQ 索引失败 {}: {}",
                        profile.lance_table_name, error
                    )))
                }
            }
        } else {
            let conn = self.db.get_conn()?;
            crate::vfs::repos::embedding_dim_repo::set_profile_ann_status(
                &conn,
                &profile.id,
                "exact",
                ANN_INDEX_VERSION,
            )?;
        }
        let secondary_ready = self
            .ensure_profile_secondary_indexes(&table, &profile.lance_table_name)
            .await;
        if secondary_ready {
            if let Ok(mut ensured) = self.ensured_tables.lock() {
                ensured.insert(profile.lance_table_name.clone());
            }
        }
        Ok(table)
    }

    /// Materialize lifecycle columns and repair all physical indexes for a
    /// queryable profile.  Capability discovery calls this before taking its
    /// immutable snapshot so a migrated legacy-L2 table can become cosine
    /// compatible instead of remaining permanently excluded from planning.
    pub async fn ensure_profile_ready(&self, profile_id: &str) -> VfsResult<()> {
        let profile = self.resolve_active_profile_for_search(profile_id)?;
        self.open_profile_table(&profile).await?;
        Ok(())
    }

    pub async fn vector_search_profile_full(
        &self,
        profile_id: &str,
        query_embedding: &[f32],
        top_k: usize,
        folder_ids: Option<&[String]>,
        resource_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        let profile = self.resolve_active_profile_for_search(profile_id)?;
        if profile.dimension as usize != query_embedding.len() {
            return Err(VfsError::InvalidArgument {
                param: "query_embedding".to_string(),
                reason: format!(
                    "Profile {} expects dimension {}, got {}",
                    profile_id,
                    profile.dimension,
                    query_embedding.len()
                ),
            });
        }
        let table = self.open_profile_table(&profile).await?;
        let row_count = table
            .count_rows(None)
            .await
            .map_err(|error| VfsError::Other(format!("统计 profile 查询表失败: {}", error)))?;
        let filter = Self::build_filter_expr_full(folder_ids, resource_ids, resource_types);
        let mut query = table
            .vector_search(query_embedding)
            .map_err(|error| VfsError::Other(format!("profile 向量查询构建失败: {}", error)))?
            .distance_type(DistanceType::Cosine)
            .select(Select::columns(SEARCH_RESULT_COLUMNS))
            .limit((top_k.saturating_mul(3)).max(20).min(500));
        if row_count < MIN_ROWS_FOR_ANN_INDEX {
            query = query.bypass_vector_index();
        }
        if let Some(filter) = filter.as_deref() {
            query = query.only_if(filter);
        }
        let mut stream = query
            .execute()
            .await
            .map_err(|error| VfsError::Other(format!("profile 向量查询执行失败: {}", error)))?;
        let mut results = Vec::new();
        while let Some(batch) = stream
            .try_next()
            .await
            .map_err(|error| VfsError::Other(format!("profile 向量查询流读取失败: {}", error)))?
        {
            results.extend(Self::extract_search_results(&batch)?);
        }
        let mut results = self.retain_active_unit_generations(&profile.modality, results)?;
        results.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(Ordering::Equal)
        });
        results.truncate(top_k);
        Ok(results)
    }

    pub async fn fts_search_profile_full(
        &self,
        profile_id: &str,
        query_text: &str,
        top_k: usize,
        folder_ids: Option<&[String]>,
        resource_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        let profile = self.resolve_active_profile_for_search(profile_id)?;
        let table = self.open_profile_table(&profile).await?;
        let filter = Self::build_filter_expr_full(folder_ids, resource_ids, resource_types);
        let mut query = table
            .query()
            .full_text_search(FullTextSearchQuery::new(query_text.to_string()))
            .select(Select::columns(SEARCH_RESULT_COLUMNS))
            .limit((top_k.saturating_mul(3)).max(20).min(500));
        if let Some(filter) = filter.as_deref() {
            query = query.only_if(filter);
        }
        let mut stream = query
            .execute()
            .await
            .map_err(|error| VfsError::Other(format!("FTS 查询执行失败: {}", error)))?;
        let mut results = Vec::new();
        while let Some(batch) = stream
            .try_next()
            .await
            .map_err(|error| VfsError::Other(format!("FTS 查询流读取失败: {}", error)))?
        {
            results.extend(Self::extract_search_results_hybrid(&batch)?);
        }
        let mut results = self.retain_active_unit_generations(&profile.modality, results)?;
        results.sort_by(|left, right| {
            right
                .score
                .partial_cmp(&left.score)
                .unwrap_or(Ordering::Equal)
        });
        results.truncate(top_k);
        Ok(results)
    }

    /// 混合检索（FTS + Vector）
    pub async fn hybrid_search(
        &self,
        modality: &str,
        query_text: &str,
        query_embedding: &[f32],
        top_k: usize,
        folder_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        self.hybrid_search_full(
            modality,
            query_text,
            query_embedding,
            top_k,
            folder_ids,
            None,
            resource_types,
        )
        .await
    }

    /// Legacy dimension-only hybrid lookup is disabled because a bare vector does not
    /// identify the model fingerprint/profile that produced it.
    pub async fn hybrid_search_full(
        &self,
        modality: &str,
        query_text: &str,
        query_embedding: &[f32],
        top_k: usize,
        folder_ids: Option<&[String]>,
        resource_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        let _ = (
            modality,
            query_text,
            query_embedding,
            top_k,
            folder_ids,
            resource_ids,
            resource_types,
        );
        Err(VfsError::InvalidState {
            message:
                "dimension-only VFS hybrid search is disabled; use planner-owned profile routes"
                    .to_string(),
        })
    }

    /// 构建过滤表达式
    fn build_filter_expr(
        folder_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> Option<String> {
        Self::build_filter_expr_full(folder_ids, None, resource_types)
    }

    /// 构建完整过滤表达式（支持 resource_ids）
    fn build_filter_expr_full(
        folder_ids: Option<&[String]>,
        resource_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> Option<String> {
        let mut parts = Vec::new();

        // 文件夹过滤
        if let Some(ids) = folder_ids {
            let values: Vec<String> = ids
                .iter()
                .filter(|s| !s.trim().is_empty())
                .map(|s| format!("'{}'", s.replace("'", "''")))
                .collect();

            if !values.is_empty() {
                if values.len() == 1 {
                    parts.push(format!("folder_id = {}", values[0]));
                } else {
                    parts.push(format!("folder_id IN ({})", values.join(", ")));
                }
            }
        }

        // 🆕 资源 ID 过滤（精确到特定文档）
        if let Some(ids) = resource_ids {
            let values: Vec<String> = ids
                .iter()
                .filter(|s| !s.trim().is_empty())
                .map(|s| format!("'{}'", s.replace("'", "''")))
                .collect();

            if !values.is_empty() {
                if values.len() == 1 {
                    parts.push(format!("resource_id = {}", values[0]));
                } else {
                    parts.push(format!("resource_id IN ({})", values.join(", ")));
                }
            }
        }

        // 资源类型过滤
        if let Some(types) = resource_types {
            let values: Vec<String> = types
                .iter()
                .filter(|s| !s.trim().is_empty())
                .map(|s| format!("'{}'", s.replace("'", "''")))
                .collect();

            if !values.is_empty() {
                if values.len() == 1 {
                    parts.push(format!("resource_type = {}", values[0]));
                } else {
                    parts.push(format!("resource_type IN ({})", values.join(", ")));
                }
            }
        }

        if parts.is_empty() {
            None
        } else {
            Some(parts.join(" AND "))
        }
    }

    /// 从批次中提取搜索结果（向量检索）
    fn extract_search_results(batch: &RecordBatch) -> VfsResult<Vec<VfsLanceSearchResult>> {
        let schema = batch.schema();

        // 当表为空或无匹配时，可能返回不含数据列的 batch，直接返回空结果
        if batch.num_rows() == 0 || schema.index_of("embedding_id").is_err() {
            debug!(
                "[VfsLanceStore] extract_search_results: skipping batch with {} rows, fields={:?}",
                batch.num_rows(),
                schema
                    .fields()
                    .iter()
                    .map(|f| f.name().as_str())
                    .collect::<Vec<_>>()
            );
            return Ok(Vec::new());
        }

        let idx_emb_id = schema
            .index_of("embedding_id")
            .map_err(|e| VfsError::Other(format!("缺少 embedding_id 列: {}", e)))?;
        let idx_res_id = schema
            .index_of("resource_id")
            .map_err(|e| VfsError::Other(format!("缺少 resource_id 列: {}", e)))?;
        let idx_unit_id = schema
            .index_of("unit_id")
            .map_err(|e| VfsError::Other(format!("缺少 unit_id 列: {}", e)))?;
        let idx_res_type = schema
            .index_of("resource_type")
            .map_err(|e| VfsError::Other(format!("缺少 resource_type 列: {}", e)))?;
        let idx_folder = schema.index_of("folder_id").ok();
        let idx_chunk = schema
            .index_of("chunk_index")
            .map_err(|e| VfsError::Other(format!("缺少 chunk_index 列: {}", e)))?;
        let idx_text = schema
            .index_of("text")
            .map_err(|e| VfsError::Other(format!("缺少 text 列: {}", e)))?;
        let idx_meta = schema.index_of("metadata").ok();
        let idx_profile_id = schema
            .index_of("index_profile_id")
            .map_err(|e| VfsError::Other(format!("缺少 index_profile_id 列: {}", e)))?;
        let idx_generation = schema
            .index_of("generation")
            .map_err(|e| VfsError::Other(format!("缺少 generation 列: {}", e)))?;
        let idx_dist = schema.index_of("_distance").ok();

        let emb_id_arr = batch
            .column(idx_emb_id)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("embedding_id 列类型错误".to_string()))?;
        let res_id_arr = batch
            .column(idx_res_id)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("resource_id 列类型错误".to_string()))?;
        let unit_id_arr = batch
            .column(idx_unit_id)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("unit_id 列类型错误".to_string()))?;
        let res_type_arr = batch
            .column(idx_res_type)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("resource_type 列类型错误".to_string()))?;
        let folder_arr =
            idx_folder.and_then(|i| batch.column(i).as_any().downcast_ref::<StringArray>());
        let chunk_arr = batch
            .column(idx_chunk)
            .as_any()
            .downcast_ref::<Int32Array>()
            .ok_or_else(|| VfsError::Other("chunk_index 列类型错误".to_string()))?;
        let text_arr = batch
            .column(idx_text)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("text 列类型错误".to_string()))?;
        let meta_arr =
            idx_meta.and_then(|i| batch.column(i).as_any().downcast_ref::<StringArray>());
        let profile_id_arr = batch
            .column(idx_profile_id)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("index_profile_id 列类型错误".to_string()))?;
        let generation_arr = batch
            .column(idx_generation)
            .as_any()
            .downcast_ref::<Int64Array>()
            .ok_or_else(|| VfsError::Other("generation 列类型错误".to_string()))?;

        // 解析距离/分数
        let mut dists: Option<Vec<f32>> = None;
        if let Some(idx) = idx_dist {
            let col = batch.column(idx);
            if let Some(arr32) = col.as_any().downcast_ref::<Float32Array>() {
                dists = Some((0..arr32.len()).map(|j| arr32.value(j)).collect());
            } else if let Some(arr64) = col.as_any().downcast_ref::<arrow_array::Float64Array>() {
                dists = Some((0..arr64.len()).map(|j| arr64.value(j) as f32).collect());
            }
        }

        let mut results = Vec::with_capacity(batch.num_rows());
        for i in 0..batch.num_rows() {
            let dist = dists.as_ref().map(|v| v[i]).unwrap_or(1.0);
            let score = (1.0 - dist).clamp(-1.0, 1.0);

            // 诊断日志：查看实际距离值
            if i < 3 {
                debug!(
                    "[VfsLanceStore] Result {}: _distance={:.6}, score={:.6}",
                    i, dist, score
                );
            }

            let metadata_json = meta_arr.and_then(|arr| {
                if arr.is_null(i) {
                    None
                } else {
                    Some(arr.value(i).to_string())
                }
            });
            let (page_index, source_id) = Self::parse_metadata_fields(&metadata_json);

            results.push(VfsLanceSearchResult {
                embedding_id: emb_id_arr.value(i).to_string(),
                resource_id: res_id_arr.value(i).to_string(),
                unit_id: unit_id_arr.value(i).to_string(),
                resource_type: res_type_arr.value(i).to_string(),
                folder_id: folder_arr.and_then(|arr| {
                    if arr.is_null(i) {
                        None
                    } else {
                        Some(arr.value(i).to_string())
                    }
                }),
                chunk_index: chunk_arr.value(i),
                text: text_arr.value(i).to_string(),
                score,
                metadata_json,
                index_profile_id: profile_id_arr.value(i).to_string(),
                generation: generation_arr.value(i),
                page_index,
                source_id,
            });
        }

        Ok(results)
    }

    /// 从批次中提取搜索结果（混合检索）
    fn extract_search_results_hybrid(batch: &RecordBatch) -> VfsResult<Vec<VfsLanceSearchResult>> {
        let schema = batch.schema();

        // 当表为空或混合检索无匹配时，LanceDB 的 RRF reranker 可能只返回分数列
        // （如 _score, _relevance_score），不包含数据列。此时直接返回空结果。
        if batch.num_rows() == 0 || schema.index_of("embedding_id").is_err() {
            debug!(
                "[VfsLanceStore] extract_search_results_hybrid: skipping batch with {} rows, fields={:?}",
                batch.num_rows(),
                schema.fields().iter().map(|f| f.name().as_str()).collect::<Vec<_>>()
            );
            return Ok(Vec::new());
        }

        let idx_emb_id = schema
            .index_of("embedding_id")
            .map_err(|e| VfsError::Other(format!("缺少 embedding_id 列: {}", e)))?;
        let idx_res_id = schema
            .index_of("resource_id")
            .map_err(|e| VfsError::Other(format!("缺少 resource_id 列: {}", e)))?;
        let idx_unit_id = schema
            .index_of("unit_id")
            .map_err(|e| VfsError::Other(format!("缺少 unit_id 列: {}", e)))?;
        let idx_res_type = schema
            .index_of("resource_type")
            .map_err(|e| VfsError::Other(format!("缺少 resource_type 列: {}", e)))?;
        let idx_folder = schema.index_of("folder_id").ok();
        let idx_chunk = schema
            .index_of("chunk_index")
            .map_err(|e| VfsError::Other(format!("缺少 chunk_index 列: {}", e)))?;
        let idx_text = schema
            .index_of("text")
            .map_err(|e| VfsError::Other(format!("缺少 text 列: {}", e)))?;
        let idx_meta = schema.index_of("metadata").ok();
        let idx_profile_id = schema
            .index_of("index_profile_id")
            .map_err(|e| VfsError::Other(format!("缺少 index_profile_id 列: {}", e)))?;
        let idx_generation = schema
            .index_of("generation")
            .map_err(|e| VfsError::Other(format!("缺少 generation 列: {}", e)))?;
        let idx_dist = schema.index_of("_distance").ok();
        let idx_relevance = schema.index_of(LANCE_RELEVANCE_COL).ok();
        let idx_score = schema.index_of(LANCE_FTS_SCORE_COL).ok();

        let emb_id_arr = batch
            .column(idx_emb_id)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("embedding_id 列类型错误".to_string()))?;
        let res_id_arr = batch
            .column(idx_res_id)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("resource_id 列类型错误".to_string()))?;
        let unit_id_arr = batch
            .column(idx_unit_id)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("unit_id 列类型错误".to_string()))?;
        let res_type_arr = batch
            .column(idx_res_type)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("resource_type 列类型错误".to_string()))?;
        let folder_arr =
            idx_folder.and_then(|i| batch.column(i).as_any().downcast_ref::<StringArray>());
        let chunk_arr = batch
            .column(idx_chunk)
            .as_any()
            .downcast_ref::<Int32Array>()
            .ok_or_else(|| VfsError::Other("chunk_index 列类型错误".to_string()))?;
        let text_arr = batch
            .column(idx_text)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("text 列类型错误".to_string()))?;
        let meta_arr =
            idx_meta.and_then(|i| batch.column(i).as_any().downcast_ref::<StringArray>());
        let profile_id_arr = batch
            .column(idx_profile_id)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| VfsError::Other("index_profile_id 列类型错误".to_string()))?;
        let generation_arr = batch
            .column(idx_generation)
            .as_any()
            .downcast_ref::<Int64Array>()
            .ok_or_else(|| VfsError::Other("generation 列类型错误".to_string()))?;

        // 解析距离/分数
        let mut dists: Option<Vec<f32>> = None;
        if let Some(idx) = idx_dist {
            let col = batch.column(idx);
            if let Some(arr32) = col.as_any().downcast_ref::<Float32Array>() {
                dists = Some((0..arr32.len()).map(|j| arr32.value(j)).collect());
            } else if let Some(arr64) = col.as_any().downcast_ref::<arrow_array::Float64Array>() {
                dists = Some((0..arr64.len()).map(|j| arr64.value(j) as f32).collect());
            }
        }

        let mut relevance_scores: Option<Vec<f32>> = None;
        if let Some(idx) = idx_relevance {
            if let Some(arr) = batch.column(idx).as_any().downcast_ref::<Float32Array>() {
                relevance_scores = Some((0..arr.len()).map(|j| arr.value(j)).collect());
            }
        }

        let mut fts_scores: Option<Vec<f32>> = None;
        if let Some(idx) = idx_score {
            if let Some(arr) = batch.column(idx).as_any().downcast_ref::<Float32Array>() {
                fts_scores = Some((0..arr.len()).map(|j| arr.value(j)).collect());
            }
        }

        let mut results = Vec::with_capacity(batch.num_rows());
        for i in 0..batch.num_rows() {
            let dist_val = dists.as_ref().map(|v| v[i]);
            let rel_val = relevance_scores.as_ref().map(|v| v[i]);
            let fts_val = fts_scores.as_ref().map(|v| v[i]);

            let score = if let Some(ref rel) = relevance_scores {
                rel[i]
            } else if let Some(ref dist_vec) = dists {
                (1.0 - dist_vec[i]).clamp(-1.0, 1.0)
            } else if let Some(ref fts_vec) = fts_scores {
                fts_vec[i]
            } else {
                0.0
            };

            // 诊断日志：查看混合检索的各项得分
            if i < 3 {
                info!(
                    "[VfsLanceStore] Hybrid Result {}: _distance={:?}, _relevance={:?}, _fts={:?}, final_score={:.6}",
                    i, dist_val, rel_val, fts_val, score
                );
            }

            let metadata_json = meta_arr.and_then(|arr| {
                if arr.is_null(i) {
                    None
                } else {
                    Some(arr.value(i).to_string())
                }
            });
            let (page_index, source_id) = Self::parse_metadata_fields(&metadata_json);

            results.push(VfsLanceSearchResult {
                embedding_id: emb_id_arr.value(i).to_string(),
                resource_id: res_id_arr.value(i).to_string(),
                unit_id: unit_id_arr.value(i).to_string(),
                resource_type: res_type_arr.value(i).to_string(),
                folder_id: folder_arr.and_then(|arr| {
                    if arr.is_null(i) {
                        None
                    } else {
                        Some(arr.value(i).to_string())
                    }
                }),
                chunk_index: chunk_arr.value(i),
                text: text_arr.value(i).to_string(),
                score,
                metadata_json,
                index_profile_id: profile_id_arr.value(i).to_string(),
                generation: generation_arr.value(i),
                page_index,
                source_id,
            });
        }

        Ok(results)
    }

    /// 从 metadata_json 中解析 page_index 和 source_id
    fn parse_metadata_fields(metadata_json: &Option<String>) -> (Option<i32>, Option<String>) {
        let Some(json_str) = metadata_json else {
            return (None, None);
        };
        let Ok(json) = serde_json::from_str::<serde_json::Value>(json_str) else {
            return (None, None);
        };
        let page_index = json
            .get("page_index")
            .and_then(|v| v.as_i64())
            .map(|v| v as i32);
        let source_id = json
            .get("source_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        (page_index, source_id)
    }

    // ========================================================================
    // 表优化
    // ========================================================================

    /// 优化指定表
    pub async fn optimize_table(&self, modality: &str, dim: usize) -> VfsResult<()> {
        let table_name = self.active_table_name(modality, dim)?;
        if let Ok(mut ensured) = self.ensured_tables.lock() {
            ensured.remove(&table_name);
        }
        let conn = self.connect().await?;

        let tbl = match conn.open_table(&table_name).execute().await {
            Ok(tbl) => tbl,
            Err(lancedb::Error::TableNotFound { .. }) => return Ok(()),
            Err(error) => {
                return Err(VfsError::Other(format!(
                    "打开待优化 Lance 表 {} 失败: {}",
                    table_name, error
                )))
            }
        };

        let start = Instant::now();

        // Compact
        let compact_stats = tbl
            .optimize(OptimizeAction::Compact {
                options: lancedb::table::CompactionOptions::default(),
                remap_options: None,
            })
            .await
            .map_err(|e| VfsError::Other(format!("Compact 优化失败: {}", e)))?;

        if let Some(metrics) = compact_stats.compaction {
            info!(
                "[VfsLanceStore] {} Compact: +{} / -{}",
                table_name, metrics.files_added, metrics.files_removed
            );
        }

        // Prune
        let prune_stats = tbl
            .optimize(OptimizeAction::Prune {
                older_than: chrono::Duration::try_days(7),
                delete_unverified: Some(false),
                error_if_tagged_old_versions: Some(false),
            })
            .await
            .map_err(|e| VfsError::Other(format!("Prune 优化失败: {}", e)))?;

        if let Some(metrics) = prune_stats.prune {
            info!(
                "[VfsLanceStore] {} Prune: 删除{}个旧版本, 回收{}字节",
                table_name, metrics.old_versions, metrics.bytes_removed
            );
        }

        // Index
        tbl.optimize(OptimizeAction::Index(OptimizeOptions::default()))
            .await
            .map_err(|e| VfsError::Other(format!("Index 优化失败: {}", e)))?;

        info!(
            "[VfsLanceStore] {} 优化完成，耗时 {}ms",
            table_name,
            start.elapsed().as_millis()
        );

        Ok(())
    }

    /// 优化所有表
    pub async fn optimize_all(&self, modality: &str) -> VfsResult<usize> {
        let mut optimized = 0usize;

        let dims = self.get_registered_dimensions(modality)?;
        for dim in dims {
            self.optimize_table(modality, dim).await?;
            optimized += 1;
        }

        Ok(optimized)
    }

    /// 获取表统计信息
    pub async fn get_table_stats(&self, modality: &str) -> VfsResult<Vec<(String, usize)>> {
        let conn = self.connect().await?;
        let mut stats = Vec::new();

        let table_names = {
            let sql_conn = self.db.get_conn()?;
            crate::vfs::repos::embedding_dim_repo::list_by_modality(&sql_conn, modality)?
                .into_iter()
                .map(|dim| dim.lance_table_name)
                .collect::<Vec<_>>()
        };
        for table_name in table_names {
            if let Ok(tbl) = conn.open_table(&table_name).execute().await {
                if let Ok(count) = tbl.count_rows(None).await {
                    if count > 0 {
                        stats.push((table_name, count));
                    }
                }
            }
        }

        Ok(stats)
    }

    /// ★ 2026-01 诊断：获取 Lance 表 schema 诊断信息
    ///
    /// 检查表是否存在 metadata 列，用于排查 pageIndex 为 null 的问题
    pub async fn diagnose_table_schema(
        &self,
        modality: &str,
    ) -> VfsResult<Vec<LanceTableDiagnostic>> {
        let conn = self.connect().await?;
        let mut diagnostics = Vec::new();

        let prefix = format!("{}{}_", VFS_LANCE_TABLE_PREFIX, modality);
        for table_name in self.cleanup_table_names(modality)? {
            let dimension = table_name
                .strip_prefix(&prefix)
                .and_then(|suffix| suffix.split('_').next())
                .and_then(|value| value.parse::<usize>().ok())
                .unwrap_or(0);
            if let Ok(tbl) = conn.open_table(&table_name).execute().await {
                // 获取表 schema
                let schema = tbl
                    .schema()
                    .await
                    .map_err(|e| VfsError::Other(format!("获取 schema 失败: {}", e)))?;
                let columns: Vec<String> = schema
                    .fields()
                    .iter()
                    .map(|f| f.name().to_string())
                    .collect();

                // 检查关键列
                let has_metadata = columns.contains(&"metadata".to_string());
                let has_embedding_id = columns.contains(&"embedding_id".to_string());
                let has_resource_id = columns.contains(&"resource_id".to_string());
                let has_text = columns.contains(&"text".to_string());

                // 获取行数
                let row_count = tbl.count_rows(None).await.unwrap_or(0);

                // 抽样检查 metadata 列内容
                let mut sample_metadata: Vec<Option<String>> = Vec::new();
                let mut metadata_with_page_index = 0usize;
                let mut metadata_null_count = 0usize;

                if has_metadata && row_count > 0 {
                    if let Ok(mut stream) = tbl.query().execute().await {
                        let mut total_checked = 0usize;
                        while let Ok(Some(batch)) = stream.try_next().await {
                            let batch_schema = batch.schema();
                            if let Ok(idx) = batch_schema.index_of("metadata") {
                                if let Some(arr) =
                                    batch.column(idx).as_any().downcast_ref::<StringArray>()
                                {
                                    for i in 0..arr.len() {
                                        if arr.is_null(i) {
                                            metadata_null_count += 1;
                                        } else {
                                            let val = arr.value(i).to_string();
                                            if val.contains("page_index")
                                                && !val.contains("\"page_index\":null")
                                            {
                                                metadata_with_page_index += 1;
                                            }
                                            if sample_metadata.len() < 10 {
                                                sample_metadata.push(Some(val));
                                            }
                                        }
                                        total_checked += 1;
                                    }
                                }
                            }
                        }
                        for _ in sample_metadata.len()..10.min(metadata_null_count) {
                            sample_metadata.push(None);
                        }
                    }
                }

                diagnostics.push(LanceTableDiagnostic {
                    table_name,
                    dimension,
                    row_count,
                    columns,
                    has_metadata_column: has_metadata,
                    has_embedding_id_column: has_embedding_id,
                    has_resource_id_column: has_resource_id,
                    has_text_column: has_text,
                    sample_metadata,
                    metadata_with_page_index,
                    metadata_null_count,
                    schema_valid: has_metadata && has_embedding_id && has_resource_id && has_text,
                    issue_description: if !has_metadata {
                        Some("缺少 metadata 列，pageIndex 将始终为 null。需要重建表或迁移 schema。".to_string())
                    } else if metadata_with_page_index == 0 && row_count > 0 {
                        Some("metadata 列存在但所有记录的 page_index 都为 null，可能是索引时未正确设置。".to_string())
                    } else {
                        None
                    },
                });
            }
        }

        Ok(diagnostics)
    }

    /// 清除指定模态的所有向量数据
    ///
    /// 删除所有维度表中的全部数据
    pub async fn clear_all(&self, modality: &str) -> VfsResult<usize> {
        let _mutation_guard = VFS_MUTATION_LOCK.write().await;
        let conn = self.connect().await?;
        let prefix = format!("{}{}_", VFS_LANCE_TABLE_PREFIX, modality);
        let mut table_names: Vec<String> = conn
            .table_names()
            .execute()
            .await
            .map_err(|e| VfsError::Other(format!("枚举 Lance 表失败: {}", e)))?
            .into_iter()
            .filter(|name| {
                name.strip_prefix(&prefix)
                    .and_then(|suffix| suffix.split('_').next())
                    .and_then(|dimension| dimension.parse::<usize>().ok())
                    .is_some()
            })
            .collect();
        table_names.sort();

        for table_name in &table_names {
            let table = conn.open_table(table_name).execute().await.map_err(|e| {
                VfsError::Other(format!("打开待清空 Lance 表 {} 失败: {}", table_name, e))
            })?;
            table.delete("true").await.map_err(|e| {
                VfsError::Other(format!("清空 Lance 表 {} 失败: {}", table_name, e))
            })?;
            let remaining = table.count_rows(None::<String>).await.map_err(|e| {
                VfsError::Other(format!("校验 Lance 表 {} 清空结果失败: {}", table_name, e))
            })?;
            if remaining != 0 {
                return Err(VfsError::Other(format!(
                    "Lance 表 {} 清空后仍残留 {} 行",
                    table_name, remaining
                )));
            }
            info!("[VfsLanceStore] Cleared all data from table {}", table_name);
        }

        info!(
            "[VfsLanceStore] Cleared {} tables for modality {}",
            table_names.len(),
            modality
        );

        Ok(table_names.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_table_name() {
        assert_eq!(VfsLanceStore::table_name("text", 768), "vfs_emb_text_768");
        assert_eq!(
            VfsLanceStore::table_name("multimodal", 4096),
            "vfs_emb_multimodal_4096"
        );
    }

    #[tokio::test]
    async fn dimension_only_search_apis_reject_bare_vectors() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let store = VfsLanceStore::new(Arc::new(db)).unwrap();
        let vector = store
            .vector_search_full("text", &[0.0; 64], 5, None, None, None)
            .await
            .expect_err("dimension-only vector lookup must be disabled");
        assert!(vector.to_string().contains("profile_id"));

        let hybrid = store
            .hybrid_search_full("text", "query", &[0.0; 64], 5, None, None, None)
            .await
            .expect_err("dimension-only hybrid lookup must be disabled");
        assert!(hybrid.to_string().contains("planner-owned"));
    }

    #[test]
    fn stale_embedding_result_cannot_switch_the_writable_profile_back() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let store = VfsLanceStore::new(Arc::new(db)).unwrap();
        let profile_a = store
            .ensure_model_profile("text", 64, "cfg-a", Some("model-a"))
            .unwrap();
        let conn = store.db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE vfs_embedding_dims SET record_count = 1
             WHERE dimension = 64 AND modality = 'text'",
            [],
        )
        .unwrap();
        crate::vfs::repos::embedding_dim_repo::register_with_model(
            &conn,
            64,
            "text",
            Some("cfg-b"),
            Some("model-b"),
        )
        .unwrap();
        let profile_b =
            crate::vfs::repos::embedding_dim_repo::get_active_profile(&conn, 64, "text")
                .unwrap()
                .unwrap();
        assert_ne!(profile_a.id, profile_b.id);
        drop(conn);

        let stale = store.ensure_model_profile("text", 64, "cfg-a", Some("model-a"));
        assert!(matches!(stale, Err(VfsError::InvalidState { .. })));
        let conn = store.db.get_conn_safe().unwrap();
        assert_eq!(
            crate::vfs::repos::embedding_dim_repo::get_active_profile(&conn, 64, "text")
                .unwrap()
                .unwrap()
                .id,
            profile_b.id
        );
    }

    #[test]
    fn legacy_profile_rolls_to_strong_fingerprint_without_a_query_gap() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let store = VfsLanceStore::new(Arc::new(db)).unwrap();
        let legacy = store
            .ensure_model_profile("text", 64, "cfg-legacy", Some("Legacy display name"))
            .unwrap();
        let conn = store.db.get_conn_safe().unwrap();
        let now = chrono::Utc::now().timestamp_millis();
        conn.execute(
            "UPDATE vfs_embedding_dims
             SET record_count = 1,
                 model_fingerprint = 'legacy:model-config:cfg-legacy',
                 model_name = 'Provider - model-real'
             WHERE dimension = 64 AND modality = 'text'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE vfs_index_profiles
             SET model_fingerprint = 'legacy:model-config:cfg-legacy',
                 model_name = 'Provider - model-real', ann_metric = 'legacy_l2'
             WHERE id = ?1",
            rusqlite::params![legacy.id],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO resources
             (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
             VALUES ('resource-legacy-roll', 'hash-legacy-roll', 'note', 'inline',
                     'legacy text', 0, 'indexed', ?1, ?1)",
            rusqlite::params![now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_units
             (id, resource_id, unit_index, text_content, text_required, text_state,
              text_embedding_dim, text_profile_id, text_generation, created_at, updated_at)
             VALUES ('unit-legacy-roll', 'resource-legacy-roll', 0, 'legacy text', 1,
                     'indexed', 64, ?1, 0, ?2, ?2)",
            rusqlite::params![legacy.id, now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO vfs_index_segments
             (id, unit_id, segment_index, modality, embedding_dim, lance_row_id,
              index_profile_id, generation, created_at, updated_at)
             VALUES ('segment-legacy-roll', 'unit-legacy-roll', 0, 'text', 64,
                     'embedding-legacy-roll', ?1, 0, ?2, ?2)",
            rusqlite::params![legacy.id, now],
        )
        .unwrap();
        drop(conn);

        let strong_fingerprint =
            crate::vfs::repos::embedding_dim_repo::model_fingerprint_with_transport(
                "cfg-legacy",
                "model-real",
                "text-embedding-v1",
                Some("openai-compatible"),
                Some("custom"),
                Some("https://example.com/v1"),
                Some("openai"),
                Some("openai"),
            );
        let strong = store
            .ensure_model_profile_with_fingerprint(
                "text",
                64,
                "cfg-legacy",
                Some("model-real"),
                &strong_fingerprint,
            )
            .unwrap();

        assert_ne!(strong.id, legacy.id);
        assert_ne!(strong.lance_table_name, legacy.lance_table_name);
        assert_eq!(strong.model_fingerprint, strong_fingerprint);
        assert_eq!(strong.state, "building");

        let conn = store.db.get_conn_safe().unwrap();
        let old_profile: (String, String) = conn
            .query_row(
                "SELECT model_fingerprint, state FROM vfs_index_profiles WHERE id = ?1",
                rusqlite::params![legacy.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let active_binding: (String, String) = conn
            .query_row(
                "SELECT active_profile_id, model_fingerprint
                 FROM vfs_embedding_dims
                 WHERE dimension = 64 AND modality = 'text'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        let pending: (String, String, String) = conn
            .query_row(
                "SELECT u.text_state, u.text_profile_id, r.index_state
                 FROM vfs_index_units u
                 JOIN resources r ON r.id = u.resource_id
                 WHERE u.id = 'unit-legacy-roll'",
                [],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(
            old_profile,
            (
                "legacy:model-config:cfg-legacy".to_string(),
                "queryable".to_string()
            )
        );
        assert_eq!(
            active_binding,
            (strong.id.clone(), strong_fingerprint.clone())
        );
        assert_eq!(
            pending,
            (
                "pending".to_string(),
                legacy.id.clone(),
                "pending".to_string()
            )
        );
        drop(conn);

        let stale_legacy_batch = store.ensure_model_profile_with_fingerprint(
            "text",
            64,
            "cfg-legacy",
            Some("Provider - model-real"),
            "legacy:model-config:cfg-legacy",
        );
        assert!(matches!(
            stale_legacy_batch,
            Err(VfsError::InvalidState { .. })
        ));
        let conn = store.db.get_conn_safe().unwrap();
        let still_active: String = conn
            .query_row(
                "SELECT active_profile_id FROM vfs_embedding_dims
                 WHERE dimension = 64 AND modality = 'text'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(still_active, strong.id);
    }

    #[test]
    fn legacy_upgrade_rejects_unbound_or_mismatched_config_profiles() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let store = VfsLanceStore::new(Arc::new(db)).unwrap();
        let profile = store
            .ensure_model_profile("text", 64, "cfg-bound", Some("model-real"))
            .unwrap();
        let conn = store.db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE vfs_embedding_dims
             SET record_count = 1,
                 model_fingerprint = 'legacy:unbound:text:64',
                 model_config_id = 'cfg-bound'
             WHERE dimension = 64 AND modality = 'text'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE vfs_index_profiles
             SET model_fingerprint = 'legacy:unbound:text:64',
                 model_config_id = 'cfg-bound'
             WHERE id = ?1",
            rusqlite::params![profile.id],
        )
        .unwrap();
        drop(conn);

        let unbound = store.ensure_model_profile("text", 64, "cfg-bound", Some("model-real"));
        assert!(matches!(unbound, Err(VfsError::InvalidState { .. })));

        let conn = store.db.get_conn_safe().unwrap();
        conn.execute(
            "UPDATE vfs_embedding_dims
             SET model_fingerprint = 'legacy:model-config:cfg-bound',
                 model_config_id = 'cfg-other'
             WHERE dimension = 64 AND modality = 'text'",
            [],
        )
        .unwrap();
        conn.execute(
            "UPDATE vfs_index_profiles
             SET model_fingerprint = 'legacy:model-config:cfg-bound',
                 model_config_id = 'cfg-other'
             WHERE id = ?1",
            rusqlite::params![profile.id],
        )
        .unwrap();
        drop(conn);

        let mismatched = store.ensure_model_profile("text", 64, "cfg-bound", Some("model-real"));
        assert!(matches!(mismatched, Err(VfsError::InvalidState { .. })));
        let conn = store.db.get_conn_safe().unwrap();
        let active_profile_id: String = conn
            .query_row(
                "SELECT active_profile_id FROM vfs_embedding_dims
                 WHERE dimension = 64 AND modality = 'text'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_profile_id, profile.id);
    }

    #[test]
    fn test_build_filter_expr() {
        // 无过滤
        assert_eq!(VfsLanceStore::build_filter_expr(None, None), None);

        // 单个文件夹
        let folders = vec!["folder1".to_string()];
        let expr = VfsLanceStore::build_filter_expr(Some(&folders), None);
        assert_eq!(expr, Some("folder_id = 'folder1'".to_string()));

        // 多个文件夹
        let folders = vec!["folder1".to_string(), "folder2".to_string()];
        let expr = VfsLanceStore::build_filter_expr(Some(&folders), None);
        assert_eq!(
            expr,
            Some("folder_id IN ('folder1', 'folder2')".to_string())
        );

        // 单个类型
        let types = vec!["note".to_string()];
        let expr = VfsLanceStore::build_filter_expr(None, Some(&types));
        assert_eq!(expr, Some("resource_type = 'note'".to_string()));

        // 组合过滤
        let folders = vec!["folder1".to_string()];
        let types = vec!["note".to_string(), "textbook".to_string()];
        let expr = VfsLanceStore::build_filter_expr(Some(&folders), Some(&types));
        assert_eq!(
            expr,
            Some("folder_id = 'folder1' AND resource_type IN ('note', 'textbook')".to_string())
        );
    }

    async fn create_legacy_table_without_lifecycle_columns(
        store: &VfsLanceStore,
        table_name: &str,
    ) {
        let schema = Arc::new(Schema::new(vec![
            Field::new("embedding_id", DataType::Utf8, false),
            Field::new("resource_id", DataType::Utf8, false),
            Field::new("resource_type", DataType::Utf8, false),
            Field::new("folder_id", DataType::Utf8, true),
            Field::new("chunk_index", DataType::Int32, false),
            Field::new("text", DataType::Utf8, false),
            Field::new("metadata", DataType::Utf8, true),
            Field::new("created_at", DataType::Utf8, false),
            Field::new(
                "embedding",
                DataType::FixedSizeList(Arc::new(Field::new("item", DataType::Float32, false)), 64),
                false,
            ),
        ]));
        let embedding_values: ArrayRef = Arc::new(Float32Array::from(vec![0.2; 128]));
        let embeddings: ArrayRef = Arc::new(
            FixedSizeListArray::try_new(
                Arc::new(Field::new("item", DataType::Float32, false)),
                64,
                embedding_values,
                None,
            )
            .unwrap(),
        );
        let batch = RecordBatch::try_new(
            Arc::clone(&schema),
            vec![
                Arc::new(StringArray::from(vec![
                    "legacy-orphan",
                    "legacy-still-live",
                ])),
                Arc::new(StringArray::from(vec![
                    "legacy-resource",
                    "legacy-resource",
                ])),
                Arc::new(StringArray::from(vec!["note", "note"])),
                Arc::new(StringArray::from(vec![None::<&str>, None::<&str>])),
                Arc::new(Int32Array::from(vec![0, 1])),
                Arc::new(StringArray::from(vec!["old chunk", "other old chunk"])),
                Arc::new(StringArray::from(vec![None::<&str>, None::<&str>])),
                Arc::new(StringArray::from(vec![
                    "2026-01-01T00:00:00Z",
                    "2026-01-01T00:00:00Z",
                ])),
                embeddings,
            ],
        )
        .unwrap();
        let batches = RecordBatchIterator::new(
            vec![Ok::<_, arrow_schema::ArrowError>(batch)].into_iter(),
            schema,
        );
        store
            .connect()
            .await
            .unwrap()
            .create_table(table_name, batches)
            .execute()
            .await
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn legacy_cleanup_preserves_queryable_tables_and_retirement_sweep_retries() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let store = VfsLanceStore::new(Arc::new(db)).expect("create VFS Lance store");
        let legacy = store
            .ensure_model_profile("text", 64, "cfg-legacy-cleanup", Some("legacy-model"))
            .expect("create legacy profile metadata");
        {
            let conn = store.db.get_conn_safe().unwrap();
            conn.execute(
                "UPDATE vfs_index_profiles SET state = 'queryable' WHERE id = ?1",
                rusqlite::params![legacy.id],
            )
            .unwrap();
        }
        create_legacy_table_without_lifecycle_columns(&store, &legacy.lance_table_name).await;

        assert_eq!(
            store
                .delete_by_unit_except_ids(
                    "text",
                    "legacy-resource",
                    "unit-current",
                    &["new-row".to_string()],
                )
                .await
                .expect("legacy per-unit cleanup must be a safe no-op"),
            0
        );
        let legacy_table = store
            .connect()
            .await
            .unwrap()
            .open_table(&legacy.lance_table_name)
            .execute()
            .await
            .unwrap();
        assert_eq!(legacy_table.count_rows(None::<String>).await.unwrap(), 2);
        drop(legacy_table);

        let replacement = store
            .ensure_model_profile("text", 64, "cfg-replacement", Some("replacement-model"))
            .expect("roll writable profile forward");
        assert_ne!(replacement.id, legacy.id);
        assert!(store
            .retired_profile_table_candidates()
            .unwrap()
            .contains(&legacy.lance_table_name));

        let simulated_failure = store
            .sweep_retired_profile_tables_inner(|table_name| {
                Err(VfsError::Other(format!(
                    "simulated table occupancy for {table_name}"
                )))
            })
            .await;
        assert!(simulated_failure.is_err());
        assert!(store
            .connect()
            .await
            .unwrap()
            .table_names()
            .execute()
            .await
            .unwrap()
            .contains(&legacy.lance_table_name));
        assert!(store
            .retired_profile_table_candidates()
            .unwrap()
            .contains(&legacy.lance_table_name));

        assert_eq!(
            store.sweep_retired_profile_tables().await.unwrap(),
            1,
            "the durable retired profile must retry on the next sweep"
        );
        assert_eq!(store.sweep_retired_profile_tables().await.unwrap(), 0);
        let table_names = store
            .connect()
            .await
            .unwrap()
            .table_names()
            .execute()
            .await
            .unwrap();
        assert!(!table_names.contains(&legacy.lance_table_name));
        let conn = store.db.get_conn_safe().unwrap();
        assert_eq!(
            crate::vfs::repos::embedding_dim_repo::get_profile_by_id(&conn, &legacy.id)
                .unwrap()
                .unwrap()
                .state,
            "retired"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clear_all_discovers_actual_tables_and_verifies_no_rows_remain() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let store = VfsLanceStore::new(Arc::new(db)).expect("create VFS Lance store");
        let profile = store
            .ensure_model_profile("text", 64, "cfg-clear", Some("model-clear"))
            .expect("create writable profile");
        {
            let conn = store.db.get_conn_safe().unwrap();
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "INSERT INTO resources
                 (id, hash, type, storage_mode, data, ref_count, created_at, updated_at)
                 VALUES ('resource-clear', 'hash-resource-clear', 'note', 'inline', 'text', 0, ?1, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO vfs_index_units
                 (id, resource_id, unit_index, text_content, text_required, text_state,
                  text_profile_id, text_generation, created_at, updated_at)
                 VALUES ('unit-clear', 'resource-clear', 0, 'text', 1, 'indexing', ?1, 1, ?2, ?2)",
                rusqlite::params![profile.id, now],
            )
            .unwrap();
        }
        store
            .write_chunks(
                "text",
                &[VfsLanceRow {
                    embedding_id: "emb-clear".to_string(),
                    resource_id: "resource-clear".to_string(),
                    unit_id: "unit-clear".to_string(),
                    resource_type: "note".to_string(),
                    folder_id: None,
                    chunk_index: 0,
                    text: "vector that must be removed".to_string(),
                    metadata_json: None,
                    created_at: chrono::Utc::now().to_rfc3339(),
                    index_profile_id: profile.id.clone(),
                    generation: 1,
                    embedding: vec![0.1; 64],
                }],
            )
            .await
            .expect("write VFS Lance row");

        let table = store
            .connect()
            .await
            .expect("connect Lance")
            .open_table(&profile.lance_table_name)
            .execute()
            .await
            .expect("open written table");
        assert_eq!(table.count_rows(None::<String>).await.unwrap(), 1);

        assert_eq!(store.clear_all("text").await.expect("clear text"), 1);
        let cleared_table = store
            .connect()
            .await
            .expect("connect Lance")
            .open_table(&profile.lance_table_name)
            .execute()
            .await
            .expect("reopen cleared table");
        assert_eq!(cleared_table.count_rows(None::<String>).await.unwrap(), 0);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn tiny_legacy_profile_repairs_to_exact_and_unit_generation_is_authoritative() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let store = VfsLanceStore::new(Arc::new(db)).expect("create VFS Lance store");
        let profile = store
            .ensure_model_profile("text", 64, "cfg-generation", Some("model-generation"))
            .expect("create profile");
        {
            let conn = store.db.get_conn_safe().unwrap();
            let now = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "INSERT INTO resources
                 (id, hash, type, storage_mode, data, ref_count, index_state, created_at, updated_at)
                 VALUES ('resource-generation', 'hash-generation', 'note', 'inline', 'text', 0, 'pending', ?1, ?1)",
                rusqlite::params![now],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO vfs_index_units
                 (id, resource_id, unit_index, text_content, text_required, text_state,
                  text_profile_id, text_generation, created_at, updated_at)
                 VALUES ('unit-generation', 'resource-generation', 0, 'text', 1, 'indexed', ?1, 1, ?2, ?2)",
                rusqlite::params![profile.id, now],
            )
            .unwrap();
        }

        let make_row = |id: &str, generation: i64| VfsLanceRow {
            embedding_id: id.to_string(),
            resource_id: "resource-generation".to_string(),
            unit_id: "unit-generation".to_string(),
            resource_type: "note".to_string(),
            folder_id: None,
            chunk_index: generation as i32,
            text: format!("generation {}", generation),
            metadata_json: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            index_profile_id: profile.id.clone(),
            generation,
            embedding: vec![0.25; 64],
        };
        store
            .write_chunks(
                "text",
                &[
                    make_row("emb-generation-1", 1),
                    make_row("emb-generation-2", 2),
                ],
            )
            .await
            .unwrap();

        {
            let conn = store.db.get_conn_safe().unwrap();
            conn.execute(
                "UPDATE vfs_index_profiles SET ann_metric = 'legacy_l2', ann_index_version = 0
                 WHERE id = ?1",
                rusqlite::params![profile.id],
            )
            .unwrap();
        }
        store
            .ensured_tables
            .lock()
            .unwrap()
            .remove(&profile.lance_table_name);
        store.ensure_profile_ready(&profile.id).await.unwrap();
        let repaired = {
            let conn = store.db.get_conn_safe().unwrap();
            crate::vfs::repos::embedding_dim_repo::get_profile_by_id(&conn, &profile.id)
                .unwrap()
                .unwrap()
        };
        assert_eq!(repaired.ann_metric, "exact");
        assert_eq!(repaired.ann_index_version, ANN_INDEX_VERSION);
        assert!(store
            .ensured_tables
            .lock()
            .unwrap()
            .contains(&profile.lance_table_name));
        store.ensure_profile_ready(&profile.id).await.unwrap();

        let generation_one = store
            .vector_search_profile_full(&profile.id, &vec![0.25; 64], 10, None, None, None)
            .await
            .unwrap();
        assert_eq!(generation_one.len(), 1);
        assert_eq!(generation_one[0].embedding_id, "emb-generation-1");

        {
            let conn = store.db.get_conn_safe().unwrap();
            crate::vfs::repos::index_unit_repo::set_index_profile(
                &conn,
                "unit-generation",
                "text",
                &profile.id,
                2,
            )
            .unwrap();
        }
        let generation_two = store
            .vector_search_profile_full(&profile.id, &vec![0.25; 64], 10, None, None, None)
            .await
            .unwrap();
        assert_eq!(generation_two.len(), 1);
        assert_eq!(generation_two[0].embedding_id, "emb-generation-2");
    }
}
