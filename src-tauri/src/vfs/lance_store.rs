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
    Array, ArrayRef, FixedSizeListArray, Float32Array, Int32Array, RecordBatch,
    RecordBatchIterator, StringArray,
};
use arrow_schema::{DataType, Field, Schema};
use futures_util::TryStreamExt;
use lancedb::index::scalar::FtsIndexBuilder;
use lancedb::index::scalar::FullTextSearchQuery;
use lancedb::index::Index;
use lancedb::query::{ExecutableQuery, QueryBase, QueryExecutionOptions};
use lancedb::table::{OptimizeAction, OptimizeOptions};
use lancedb::DistanceType;
use lancedb::{Connection, Table};
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

// ============================================================================
// 类型定义
// ============================================================================

/// VFS 向量行结构（对应 LanceDB 表中的一行）
#[derive(Debug, Clone)]
pub struct VfsLanceRow {
    pub embedding_id: String,
    pub resource_id: String,
    pub resource_type: String,
    pub folder_id: Option<String>,
    pub chunk_index: i32,
    pub text: String,
    pub metadata_json: Option<String>,
    pub created_at: String,
    pub embedding: Vec<f32>,
}

/// 向量检索结果
#[derive(Debug, Clone)]
pub struct VfsLanceSearchResult {
    pub embedding_id: String,
    pub resource_id: String,
    pub resource_type: String,
    pub folder_id: Option<String>,
    pub chunk_index: i32,
    pub text: String,
    pub score: f32,
    pub metadata_json: Option<String>,
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

    /// 从数据库获取已注册的维度列表
    fn get_registered_dimensions(&self, modality: &str) -> VfsResult<Vec<usize>> {
        use crate::vfs::repos::embedding_dim_repo;

        let conn = self.db.get_conn()?;
        let dims = embedding_dim_repo::list_by_modality(&conn, modality)?;
        Ok(dims.iter().map(|d| d.dimension as usize).collect())
    }

    /// 从 Lance 目录发现某个模态的实际表维度（用于维度注册表漂移兜底）。
    fn discover_dimensions_from_disk(&self, modality: &str) -> Vec<usize> {
        let mut dims = Vec::new();
        let prefix = format!("{}{}_", VFS_LANCE_TABLE_PREFIX, modality);

        let entries = match fs::read_dir(&self.lance_base_path) {
            Ok(entries) => entries,
            Err(_) => return dims,
        };

        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if let Some(suffix) = name.strip_prefix(&prefix) {
                if let Ok(dim) = suffix.parse::<usize>() {
                    dims.push(dim);
                }
            }
        }

        dims
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

    /// 确保向量表存在（动态创建）
    pub async fn ensure_table(&self, modality: &str, dim: usize) -> VfsResult<Table> {
        let conn = self.connect().await?;
        let table_name = Self::table_name(modality, dim);

        let tbl = match conn.open_table(&table_name).execute().await {
            Ok(tbl) => tbl,
            Err(_) => {
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
        };

        // 确保向量索引
        let embed_start = Instant::now();
        let embed_res = tbl
            .create_index(&["embedding"], Index::Auto)
            .replace(false)
            .execute()
            .await;

        if let Err(err) = embed_res {
            let msg = err.to_string();
            if !msg.contains("already exists") {
                warn!(
                    "[VfsLanceStore] embedding index ensure failed on {}: {}",
                    table_name, msg
                );
            }
        } else {
            debug!(
                "[VfsLanceStore] ensured embedding index on {} in {}ms",
                table_name,
                embed_start.elapsed().as_millis()
            );
        }

        // 确保 FTS 索引
        let fts_start = Instant::now();
        let fts_builder = self.build_fts_index_builder();
        let fts_res = tbl
            .create_index(&["text"], Index::FTS(fts_builder))
            .replace(false)
            .execute()
            .await;

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
                    warn!(
                        "[VfsLanceStore] FTS index ensure failed on {}: {}",
                        table_name, msg
                    );
                }
            }
        }

        Ok(tbl)
    }

    /// 构建表 Schema
    fn build_schema(dim: usize) -> Schema {
        Schema::new(vec![
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

        let dim = rows[0].embedding.len();

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

        let tbl = self.ensure_table(modality, dim).await?;

        let (schema, batch) = self.build_batch(dim, rows)?;
        let iter = RecordBatchIterator::new(vec![Ok(batch)].into_iter(), schema);

        let mut builder = tbl.merge_insert(&["embedding_id"]);
        builder.when_matched_update_all(None);
        builder.when_not_matched_insert_all();
        builder
            .execute(Box::new(iter))
            .await
            .map_err(|e| VfsError::Other(format!("写入 Lance 表失败 (merge_insert): {}", e)))?;

        info!(
            "[VfsLanceStore] Wrote {} chunks to {} (merge_insert)",
            rows.len(),
            Self::table_name(modality, dim)
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
                resource_type_arr,
                folder_id_arr,
                chunk_index_arr,
                text_arr,
                metadata_arr,
                created_at_arr,
                embedding_arr,
            ],
        )
        .map_err(|e| VfsError::Other(format!("构建批次失败: {}", e)))?;

        Ok((schema, batch))
    }

    /// 删除资源的所有向量
    pub async fn delete_by_resource(&self, modality: &str, resource_id: &str) -> VfsResult<usize> {
        let conn = self.connect().await?;
        let mut deleted = 0usize;

        let mut dims = self.get_registered_dimensions(modality)?;
        for dim in self.discover_dimensions_from_disk(modality) {
            if !dims.contains(&dim) {
                dims.push(dim);
            }
        }

        dims.sort_unstable();
        dims.dedup();

        for dim in dims {
            let table_name = Self::table_name(modality, dim);
            if let Ok(tbl) = conn.open_table(&table_name).execute().await {
                let expr = format!("resource_id = '{}'", resource_id.replace("'", "''"));
                if tbl.delete(expr.as_str()).await.is_ok() {
                    deleted += 1;
                }
            }
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

        let mut dims = self.get_registered_dimensions(modality)?;
        for dim in self.discover_dimensions_from_disk(modality) {
            if !dims.contains(&dim) {
                dims.push(dim);
            }
        }

        dims.sort_unstable();
        dims.dedup();

        for dim in dims {
            if dim == keep_dim {
                continue;
            }
            let table_name = Self::table_name(modality, dim);
            if let Ok(tbl) = conn.open_table(&table_name).execute().await {
                let expr = format!("resource_id = '{}'", resource_id.replace("'", "''"));
                if tbl.delete(expr.as_str()).await.is_ok() {
                    deleted += 1;
                }
            }
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

        let mut dims = self.get_registered_dimensions(modality)?;
        for dim in self.discover_dimensions_from_disk(modality) {
            if !dims.contains(&dim) {
                dims.push(dim);
            }
        }

        dims.sort_unstable();
        dims.dedup();

        let escaped_resource_id = resource_id.replace("'", "''");

        for dim in dims {
            let table_name = Self::table_name(modality, dim);
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
                if tbl.delete(expr.as_str()).await.is_ok() {
                    deleted += 1;
                }
            }
        }

        debug!(
            "[VfsLanceStore] Deleted old vectors for resource {} from {} tables (kept {} embedding ids)",
            resource_id, deleted, keep_ids.len()
        );

        Ok(deleted)
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

        let mut dims = self.get_registered_dimensions(modality)?;
        for dim in self.discover_dimensions_from_disk(modality) {
            if !dims.contains(&dim) {
                dims.push(dim);
            }
        }
        dims.sort_unstable();
        dims.dedup();

        let in_list = embedding_ids
            .iter()
            .map(|s| format!("'{}'", s.replace("'", "''")))
            .collect::<Vec<_>>()
            .join(",");
        let expr = format!("embedding_id IN ({})", in_list);

        for dim in dims {
            let table_name = Self::table_name(modality, dim);
            if let Ok(tbl) = conn.open_table(&table_name).execute().await {
                if tbl.delete(expr.as_str()).await.is_ok() {
                    deleted += 1;
                }
            }
        }

        Ok(deleted)
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

    /// 向量检索（支持 resource_ids 过滤）
    pub async fn vector_search_full(
        &self,
        modality: &str,
        query_embedding: &[f32],
        top_k: usize,
        folder_ids: Option<&[String]>,
        resource_ids: Option<&[String]>,
        resource_types: Option<&[String]>,
    ) -> VfsResult<Vec<VfsLanceSearchResult>> {
        let dim = query_embedding.len();
        let tbl = self.ensure_table(modality, dim).await?;

        let fetch_limit = (top_k * 3).max(20).min(500);

        // 诊断日志：查询向量范数
        let query_norm: f32 = query_embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
        info!(
            "[VfsLanceStore] vector_search: dim={}, query_norm={:.6}, top_k={}, fetch_limit={}",
            dim, query_norm, top_k, fetch_limit
        );

        let start = Instant::now();
        debug!(
            "[VfsLanceStore] vector_search: dim={}, top_k={}, fetch_limit={}, folders={:?}, resources={:?}, types={:?}",
            dim, top_k, fetch_limit, folder_ids, resource_ids, resource_types
        );

        // 构建过滤表达式
        let filter_expr = Self::build_filter_expr_full(folder_ids, resource_ids, resource_types);

        let mut query = tbl
            .vector_search(query_embedding)
            .map_err(|e| VfsError::Other(format!("向量查询构建失败: {}", e)))?
            .distance_type(DistanceType::Cosine)
            .limit(fetch_limit);

        if let Some(ref expr) = filter_expr {
            query = query.only_if(expr.as_str());
        }

        let mut stream = query
            .execute()
            .await
            .map_err(|e| VfsError::Other(format!("向量查询执行失败: {}", e)))?;

        let mut results = Vec::new();
        while let Some(batch) = stream
            .try_next()
            .await
            .map_err(|e| VfsError::Other(format!("向量查询流读取失败: {}", e)))?
        {
            let batch_results = Self::extract_search_results(&batch)?;
            results.extend(batch_results);
        }

        // 按分数排序并截断
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
        results.truncate(top_k);

        info!(
            "[VfsLanceStore] vector_search completed: {} results in {}ms",
            results.len(),
            start.elapsed().as_millis()
        );

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

    /// 混合检索（支持 resource_ids 过滤）
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
        let dim = query_embedding.len();
        let tbl = self.ensure_table(modality, dim).await?;

        let fetch_limit = (top_k * 3).max(20).min(500);

        // 诊断日志：查询向量范数
        let query_norm: f32 = query_embedding.iter().map(|x| x * x).sum::<f32>().sqrt();
        info!(
            "[VfsLanceStore] hybrid_search: dim={}, query_norm={:.6}, top_k={}, query='{}'",
            dim, query_norm, top_k, query_text
        );

        let start = Instant::now();
        debug!(
            "[VfsLanceStore] hybrid_search: dim={}, top_k={}, query='{}', resources={:?}",
            dim, top_k, query_text, resource_ids
        );

        let fts_query = FullTextSearchQuery::new(query_text.to_owned());
        let filter_expr = Self::build_filter_expr_full(folder_ids, resource_ids, resource_types);

        let mut query = tbl
            .query()
            .full_text_search(fts_query)
            .nearest_to(query_embedding.to_vec())
            .map_err(|e| VfsError::Other(format!("混合查询构建失败: {}", e)))?
            .distance_type(DistanceType::Cosine)
            .limit(fetch_limit);

        if let Some(ref expr) = filter_expr {
            query = query.only_if(expr.as_str());
        }

        let mut stream = query
            .execute_hybrid(QueryExecutionOptions::default())
            .await
            .map_err(|e| VfsError::Other(format!("混合查询执行失败: {}", e)))?;

        let mut results = Vec::new();
        while let Some(batch) = stream
            .try_next()
            .await
            .map_err(|e| VfsError::Other(format!("混合查询流读取失败: {}", e)))?
        {
            let batch_results = Self::extract_search_results_hybrid(&batch)?;
            results.extend(batch_results);
        }

        // 按分数排序并截断
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
        results.truncate(top_k);

        // 归一化 RRF 得分到 [0, 1] 范围，使最高分接近 1.0
        // RRF 得分公式: 1 / (k + rank)，k=60 时最大约 0.0164
        if !results.is_empty() {
            let max_score = results.iter().map(|r| r.score).fold(0.0f32, f32::max);
            if max_score > 0.0 {
                for r in results.iter_mut() {
                    r.score = (r.score / max_score).clamp(0.0, 1.0);
                }
            }
        }

        info!(
            "[VfsLanceStore] hybrid_search completed: {} results in {}ms",
            results.len(),
            start.elapsed().as_millis()
        );

        Ok(results)
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
        let table_name = Self::table_name(modality, dim);
        let conn = self.connect().await?;

        let tbl = match conn.open_table(&table_name).execute().await {
            Ok(tbl) => tbl,
            Err(_) => return Ok(()), // 表不存在，跳过
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
            if self.optimize_table(modality, dim).await.is_ok() {
                optimized += 1;
            }
        }

        Ok(optimized)
    }

    /// 获取表统计信息
    pub async fn get_table_stats(&self, modality: &str) -> VfsResult<Vec<(String, usize)>> {
        let conn = self.connect().await?;
        let mut stats = Vec::new();

        let dims = self.get_registered_dimensions(modality)?;
        for dim in dims {
            let table_name = Self::table_name(modality, dim);
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

        let dims = self.get_registered_dimensions(modality)?;
        for dim in dims {
            let table_name = Self::table_name(modality, dim);
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
                    dimension: dim,
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
        let conn = self.connect().await?;
        let mut deleted_tables = 0usize;

        let dims = self.get_registered_dimensions(modality)?;
        for dim in dims {
            let table_name = Self::table_name(modality, dim);
            if let Ok(tbl) = conn.open_table(&table_name).execute().await {
                // 删除表中所有数据
                if tbl.delete("true").await.is_ok() {
                    deleted_tables += 1;
                    info!("[VfsLanceStore] Cleared all data from table {}", table_name);
                }
            }
        }

        info!(
            "[VfsLanceStore] Cleared {} tables for modality {}",
            deleted_tables, modality
        );

        Ok(deleted_tables)
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
}
