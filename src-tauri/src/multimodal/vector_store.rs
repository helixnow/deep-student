//! 多模态向量存储模块
//!
//! 基于 LanceDB 实现多模态页面向量的存储和检索。
//!
//! ## 设计要点
//!
//! - **表命名**: 按向量类型和维度区分
//!   - `mm_pages_v2_vl_d{dim}` - VLEmbedding 模式的多模态向量
//!   - `mm_pages_v2_text_d{dim}` - VLSummaryThenTextEmbed 模式的文本向量
//! - **向量分离**: 即使维度相同，多模态向量和文本向量也分开存储，避免检索时跨类型匹配
//! - **字段设计**: 与现有文本块表结构保持一致性，便于复用搜索逻辑
//! - **维度支持**: 支持 256-4096 维度，覆盖 Qwen3-VL-Embedding 默认输出
//!
//! 设计文档参考: docs/multimodal-knowledge-base-design.md (Section 6.2)

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use crate::database::Database;
use crate::models::AppError;
use crate::multimodal::types::SourceType;

type Result<T> = std::result::Result<T, AppError>;

#[cfg(feature = "lance")]
use arrow_array::{
    Array, ArrayRef, FixedSizeListArray, Float32Array, Int32Array, RecordBatch,
    RecordBatchIterator, StringArray,
};
#[cfg(feature = "lance")]
use arrow_schema::{DataType, Field, Schema};
#[cfg(feature = "lance")]
use futures::TryStreamExt;
#[cfg(feature = "lance")]
use lancedb::query::{ExecutableQuery, QueryBase};
#[cfg(feature = "lance")]
use lancedb::Connection;
#[cfg(feature = "lance")]
use lancedb::DistanceType;

/// VL-Embedding 模式的多模态向量表前缀
pub const MM_PAGES_VL_PREFIX: &str = "mm_pages_v2_vl_d";

/// 文本嵌入模式的文本向量表前缀
pub const MM_PAGES_TEXT_PREFIX: &str = "mm_pages_v2_text_d";

/// 多模态页面向量记录
#[derive(Debug, Clone)]
pub struct MultimodalPageRecord {
    /// 页面嵌入 ID
    pub page_id: String,
    /// 来源类型
    pub source_type: String,
    /// 来源资源 ID
    pub source_id: String,
    /// 所属知识库 ID（可选，用于过滤）
    pub sub_library_id: Option<String>,
    /// 页码（0-based）
    pub page_index: i32,
    /// 图片 Blob 哈希（用于加载原图）
    pub blob_hash: Option<String>,
    /// 文本摘要
    pub text_summary: Option<String>,
    /// JSON 元数据
    pub metadata_json: Option<String>,
    /// 创建时间
    pub created_at: String,
    /// 嵌入向量
    pub embedding: Vec<f32>,
}

/// 检索结果（带分数）
#[derive(Debug, Clone)]
pub struct SearchResult {
    pub record: MultimodalPageRecord,
    pub score: f32,
}

/// 多模态向量存储
///
/// 管理多模态页面向量的 LanceDB 存储和检索
pub struct MultimodalVectorStore {
    #[allow(dead_code)]
    database: Arc<Database>,
    #[cfg(feature = "lance")]
    lance_db: Option<Connection>,
    lance_root: PathBuf,
}

impl MultimodalVectorStore {
    /// 创建新的向量存储实例
    #[cfg(feature = "lance")]
    pub async fn new(database: Arc<Database>, lance_root: PathBuf) -> Result<Self> {
        // 确保目录存在
        if !lance_root.exists() {
            std::fs::create_dir_all(&lance_root)
                .map_err(|e| AppError::file_system(format!("创建 Lance 目录失败: {}", e)))?;
        }

        // 连接 LanceDB
        let db = lancedb::connect(lance_root.to_string_lossy().as_ref())
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;

        Ok(Self {
            database,
            lance_db: Some(db),
            lance_root,
        })
    }

    /// 不启用 lance feature 时的占位实现
    #[cfg(not(feature = "lance"))]
    pub async fn new(database: Arc<Database>, lance_root: PathBuf) -> Result<Self> {
        Ok(Self {
            database,
            lance_root,
        })
    }

    /// 获取 VL-Embedding 模式的表名
    fn table_name_vl(dim: usize) -> String {
        format!("{}{}", MM_PAGES_VL_PREFIX, dim)
    }

    /// 获取文本嵌入模式的表名
    fn table_name_text(dim: usize) -> String {
        format!("{}{}", MM_PAGES_TEXT_PREFIX, dim)
    }

    /// 根据向量类型获取表名
    ///
    /// - `vector_type`: "vl" 或 "text"
    pub fn table_name_by_type(vector_type: &str, dim: usize) -> String {
        match vector_type {
            "vl" => Self::table_name_vl(dim),
            "text" => Self::table_name_text(dim),
            _ => Self::table_name_vl(dim), // 默认使用 VL 表
        }
    }

    /// 获取常见的维度列表（用于统计和优化）
    ///
    /// 注意：系统支持任意维度，此列表仅用于统计时遍历常见维度
    pub fn common_dimensions() -> Vec<usize> {
        vec![256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096]
    }

    /// 检查维度是否在合理范围内
    ///
    /// 支持任意维度，但限制在 64-8192 范围内以确保合理性
    pub fn is_dimension_valid(dim: usize) -> bool {
        dim >= 64 && dim <= 8192
    }

    /// 列出所有有数据的维度（向后兼容，返回所有类型的维度）
    ///
    /// 动态扫描 LanceDB 中的 mm_pages_v2_* 表，返回所有**非空**维度列表
    #[cfg(feature = "lance")]
    pub async fn list_available_dimensions(&self) -> Result<Vec<usize>> {
        let dims_by_type = self.list_available_dimensions_by_type().await?;
        let mut all_dims: Vec<usize> = dims_by_type
            .into_iter()
            .flat_map(|(_, dims)| dims)
            .collect();
        all_dims.sort();
        all_dims.dedup();
        Ok(all_dims)
    }

    #[cfg(not(feature = "lance"))]
    pub async fn list_available_dimensions(&self) -> Result<Vec<usize>> {
        Err(AppError::configuration("Lance feature 未启用"))
    }

    /// 列出按向量类型区分的可用维度
    ///
    /// 返回 HashMap<向量类型, Vec<维度>>
    /// - "vl": VLEmbedding 模式的多模态向量表
    /// - "text": VLSummaryThenTextEmbed 模式的文本向量表
    #[cfg(feature = "lance")]
    pub async fn list_available_dimensions_by_type(&self) -> Result<HashMap<String, Vec<usize>>> {
        let db = self
            .lance_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("LanceDB 未初始化"))?;

        let table_names = db.table_names().execute().await.unwrap_or_default();
        let mut result: HashMap<String, Vec<usize>> = HashMap::new();

        for table_name in table_names {
            // 尝试解析 VL 类型表
            if let Some(dim_str) = table_name.strip_prefix(MM_PAGES_VL_PREFIX) {
                if let Ok(dim) = dim_str.parse::<usize>() {
                    if let Ok(table) = db.open_table(&table_name).execute().await {
                        if let Ok(count) = table.count_rows(None).await {
                            if count > 0 {
                                result.entry("vl".to_string()).or_default().push(dim);
                            }
                        }
                    }
                }
            }
            // 尝试解析 Text 类型表
            else if let Some(dim_str) = table_name.strip_prefix(MM_PAGES_TEXT_PREFIX) {
                if let Ok(dim) = dim_str.parse::<usize>() {
                    if let Ok(table) = db.open_table(&table_name).execute().await {
                        if let Ok(count) = table.count_rows(None).await {
                            if count > 0 {
                                result.entry("text".to_string()).or_default().push(dim);
                            }
                        }
                    }
                }
            }
        }

        // 排序
        for dims in result.values_mut() {
            dims.sort();
            dims.dedup();
        }

        Ok(result)
    }

    #[cfg(not(feature = "lance"))]
    pub async fn list_available_dimensions_by_type(&self) -> Result<HashMap<String, Vec<usize>>> {
        Err(AppError::configuration("Lance feature 未启用"))
    }

    /// 在指定维度和向量类型的表中搜索
    ///
    /// ## 参数
    /// - `vector_type`: 向量类型 ("vl" 或 "text")
    /// - `dim`: 向量维度
    /// - `query_embedding`: 查询向量
    /// - `top_k`: 返回数量
    /// - `sub_library_ids`: 子库过滤
    #[cfg(feature = "lance")]
    pub async fn search_in_dimension_typed(
        &self,
        vector_type: &str,
        dim: usize,
        query_embedding: &[f32],
        top_k: usize,
        sub_library_ids: Option<&[String]>,
    ) -> Result<Vec<SearchResult>> {
        if query_embedding.len() != dim {
            return Err(AppError::configuration(format!(
                "查询向量维度 ({}) 与目标维度 ({}) 不匹配",
                query_embedding.len(),
                dim
            )));
        }

        let db = self
            .lance_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("LanceDB 未初始化"))?;

        let table_name = Self::table_name_by_type(vector_type, dim);

        // 直接尝试打开表，如果不存在则返回空结果（避免重复调用 table_names）
        let table = match db.open_table(&table_name).execute().await {
            Ok(t) => t,
            Err(_) => return Ok(Vec::new()),
        };

        // 构建查询
        let mut query = table
            .vector_search(query_embedding.to_vec())
            .map_err(|e| AppError::database(format!("构建向量搜索失败: {}", e)))?
            .distance_type(DistanceType::Cosine)
            .limit(top_k);

        // 添加子库过滤
        if let Some(lib_ids) = sub_library_ids {
            if !lib_ids.is_empty() {
                let filter = format!(
                    "sub_library_id IN ({})",
                    lib_ids
                        .iter()
                        .map(|id| format!("'{}'", id.replace('\'', "''")))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                query = query.only_if(filter);
            }
        }

        // 执行查询
        let batches = query
            .execute()
            .await
            .map_err(|e| AppError::database(format!("执行向量搜索失败: {}", e)))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| AppError::database(format!("收集搜索结果失败: {}", e)))?;

        // 解析结果
        let mut results = Vec::new();
        for batch in batches {
            results.extend(Self::batch_to_search_results(&batch)?);
        }

        // 按分数排序
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(results.into_iter().take(top_k).collect())
    }

    #[cfg(not(feature = "lance"))]
    pub async fn search_in_dimension_typed(
        &self,
        _vector_type: &str,
        _dim: usize,
        _query_embedding: &[f32],
        _top_k: usize,
        _sub_library_ids: Option<&[String]>,
    ) -> Result<Vec<SearchResult>> {
        Err(AppError::configuration("Lance feature 未启用"))
    }

    /// 插入或更新多模态页面向量
    ///
    /// ## 参数
    /// - `records`: 页面向量记录
    /// - `vector_type`: 向量类型 ("vl" 或 "text")
    #[cfg(feature = "lance")]
    pub async fn upsert_pages(
        &self,
        records: &[MultimodalPageRecord],
        vector_type: &str,
    ) -> Result<usize> {
        if records.is_empty() {
            return Ok(0);
        }

        // 获取向量维度
        let dim = records
            .first()
            .map(|r| r.embedding.len())
            .ok_or_else(|| AppError::internal("记录的嵌入向量为空"))?;

        if !Self::is_dimension_valid(dim) {
            return Err(AppError::configuration(format!(
                "向量维度超出合理范围: {}，有效范围: 64-8192",
                dim
            )));
        }

        let db = self
            .lance_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("LanceDB 未初始化"))?;

        let table_name = Self::table_name_by_type(vector_type, dim);

        // 构建 schema
        let schema = Self::create_schema(dim);

        // 构建 RecordBatch
        let batch = Self::records_to_batch(records, &schema)?;

        // 打开或创建表
        let table_exists = db
            .table_names()
            .execute()
            .await
            .map(|names| names.contains(&table_name))
            .unwrap_or(false);

        if table_exists {
            // 表存在，使用 merge_insert 进行 upsert
            let table =
                db.open_table(&table_name).execute().await.map_err(|e| {
                    AppError::database(format!("打开表 {} 失败: {}", table_name, e))
                })?;

            // 先删除已存在的记录
            let page_ids: Vec<String> = records.iter().map(|r| r.page_id.clone()).collect();
            let filter = format!(
                "page_id IN ({})",
                page_ids
                    .iter()
                    .map(|id| format!("'{}'", id.replace('\'', "''")))
                    .collect::<Vec<_>>()
                    .join(", ")
            );

            // 删除旧记录
            let _ = table.delete(&filter).await;

            // 添加新记录
            let batches = RecordBatchIterator::new(vec![Ok(batch)], schema);
            table
                .add(batches)
                .execute()
                .await
                .map_err(|e| AppError::database(format!("添加记录失败: {}", e)))?;
        } else {
            // 表不存在，创建新表
            let batches = RecordBatchIterator::new(vec![Ok(batch)], schema.clone());
            db.create_table(&table_name, batches)
                .execute()
                .await
                .map_err(|e| AppError::database(format!("创建表 {} 失败: {}", table_name, e)))?;

            log::info!("📊 创建多模态页面表: {} (维度 {})", table_name, dim);
        }

        Ok(records.len())
    }

    #[cfg(not(feature = "lance"))]
    pub async fn upsert_pages(
        &self,
        _records: &[MultimodalPageRecord],
        _vector_type: &str,
    ) -> Result<usize> {
        Err(AppError::configuration("Lance feature 未启用"))
    }

    /// 删除指定来源的所有页面向量
    ///
    /// 会遍历所有类型（vl/text）和所有维度的表
    #[cfg(feature = "lance")]
    pub async fn delete_by_source(
        &self,
        source_type: SourceType,
        source_id: &str,
    ) -> Result<usize> {
        let db = self
            .lance_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("LanceDB 未初始化"))?;

        let filter = format!(
            "source_type = '{}' AND source_id = '{}'",
            source_type.as_str(),
            source_id.replace('\'', "''")
        );

        let mut deleted = 0;

        // 获取所有表名，遍历所有多模态页面表（vl 和 text 类型）
        let table_names = db.table_names().execute().await.unwrap_or_default();
        for table_name in table_names {
            // 匹配 mm_pages_v2_vl_d* 和 mm_pages_v2_text_d*
            let is_mm_table = table_name.starts_with(MM_PAGES_VL_PREFIX)
                || table_name.starts_with(MM_PAGES_TEXT_PREFIX);

            if is_mm_table {
                if let Ok(table) = db.open_table(&table_name).execute().await {
                    if table.delete(&filter).await.is_ok() {
                        deleted += 1;
                    }
                }
            }
        }

        Ok(deleted)
    }

    #[cfg(not(feature = "lance"))]
    pub async fn delete_by_source(
        &self,
        _source_type: SourceType,
        _source_id: &str,
    ) -> Result<usize> {
        Err(AppError::configuration("Lance feature 未启用"))
    }

    /// 删除指定页面的向量
    #[cfg(feature = "lance")]
    pub async fn delete_pages(
        &self,
        page_ids: &[String],
        vector_type: &str,
        dim: usize,
    ) -> Result<usize> {
        if page_ids.is_empty() {
            return Ok(0);
        }

        let db = self
            .lance_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("LanceDB 未初始化"))?;

        let table_name = Self::table_name_by_type(vector_type, dim);
        let table = db
            .open_table(&table_name)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("打开表 {} 失败: {}", table_name, e)))?;

        let filter = format!(
            "page_id IN ({})",
            page_ids
                .iter()
                .map(|id| format!("'{}'", id.replace('\'', "''")))
                .collect::<Vec<_>>()
                .join(", ")
        );

        table
            .delete(&filter)
            .await
            .map_err(|e| AppError::database(format!("删除记录失败: {}", e)))?;

        Ok(page_ids.len())
    }

    #[cfg(not(feature = "lance"))]
    pub async fn delete_pages(
        &self,
        _page_ids: &[String],
        _vector_type: &str,
        _dim: usize,
    ) -> Result<usize> {
        Err(AppError::configuration("Lance feature 未启用"))
    }

    /// 向量搜索（遗留方法，默认使用 VL 类型表）
    #[cfg(feature = "lance")]
    #[allow(dead_code)]
    pub async fn search(
        &self,
        query_embedding: &[f32],
        top_k: usize,
        sub_library_ids: Option<&[String]>,
    ) -> Result<Vec<SearchResult>> {
        let dim = query_embedding.len();

        let db = self
            .lance_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("LanceDB 未初始化"))?;

        let table_name = Self::table_name_vl(dim);

        // 检查表是否存在
        let table_exists = db
            .table_names()
            .execute()
            .await
            .map(|names| names.contains(&table_name))
            .unwrap_or(false);

        if !table_exists {
            return Ok(Vec::new());
        }

        let table = db
            .open_table(&table_name)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("打开表 {} 失败: {}", table_name, e)))?;

        // 构建查询
        let mut query = table
            .vector_search(query_embedding.to_vec())
            .map_err(|e| AppError::database(format!("构建向量搜索失败: {}", e)))?
            .distance_type(DistanceType::Cosine)
            .limit(top_k);

        // 添加子库过滤
        if let Some(lib_ids) = sub_library_ids {
            if !lib_ids.is_empty() {
                let filter = format!(
                    "sub_library_id IN ({})",
                    lib_ids
                        .iter()
                        .map(|id| format!("'{}'", id.replace('\'', "''")))
                        .collect::<Vec<_>>()
                        .join(", ")
                );
                query = query.only_if(filter);
            }
        }

        // 执行查询
        let batches = query
            .execute()
            .await
            .map_err(|e| AppError::database(format!("执行向量搜索失败: {}", e)))?
            .try_collect::<Vec<_>>()
            .await
            .map_err(|e| AppError::database(format!("收集搜索结果失败: {}", e)))?;

        // 解析结果
        let mut results = Vec::new();
        for batch in batches {
            results.extend(Self::batch_to_search_results(&batch)?);
        }

        // 按分数排序
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(results.into_iter().take(top_k).collect())
    }

    #[cfg(not(feature = "lance"))]
    pub async fn search(
        &self,
        _query_embedding: &[f32],
        _top_k: usize,
        _sub_library_ids: Option<&[String]>,
    ) -> Result<Vec<SearchResult>> {
        Err(AppError::configuration("Lance feature 未启用"))
    }

    /// 获取指定维度表的统计信息（遗留方法，默认使用 VL 类型表）
    #[cfg(feature = "lance")]
    #[allow(dead_code)]
    pub async fn get_stats(&self, dim: usize) -> Result<(usize, usize)> {
        let db = self
            .lance_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("LanceDB 未初始化"))?;

        let table_name = Self::table_name_vl(dim);

        // 检查表是否存在
        let table_exists = db
            .table_names()
            .execute()
            .await
            .map(|names| names.contains(&table_name))
            .unwrap_or(false);

        if !table_exists {
            return Ok((0, 0));
        }

        let table = db
            .open_table(&table_name)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("打开表 {} 失败: {}", table_name, e)))?;

        let count = table.count_rows(None).await.unwrap_or(0) as usize;

        // 估算存储大小
        let estimated_bytes = count * (dim * 4 + 500); // 向量 + 元数据估算

        Ok((count, estimated_bytes))
    }

    #[cfg(not(feature = "lance"))]
    pub async fn get_stats(&self, _dim: usize) -> Result<(usize, usize)> {
        Err(AppError::configuration("Lance feature 未启用"))
    }

    /// 获取所有维度的统计信息
    #[cfg(feature = "lance")]
    pub async fn get_all_stats(&self) -> Result<HashMap<usize, (usize, usize)>> {
        let db = self
            .lance_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("LanceDB 未初始化"))?;

        let mut stats = HashMap::new();

        // 动态发现所有多模态页面表（vl 和 text 类型）
        let table_names = db.table_names().execute().await.unwrap_or_default();
        for table_name in table_names {
            // 解析 VL 类型表
            if let Some(dim_str) = table_name.strip_prefix(MM_PAGES_VL_PREFIX) {
                if let Ok(dim) = dim_str.parse::<usize>() {
                    if let Ok(table) = db.open_table(&table_name).execute().await {
                        if let Ok(count) = table.count_rows(None).await {
                            if count > 0 {
                                let estimated_bytes = count as usize * (dim * 4 + 500);
                                let entry = stats.entry(dim).or_insert((0, 0));
                                entry.0 += count as usize;
                                entry.1 += estimated_bytes;
                            }
                        }
                    }
                }
            }
            // 解析 Text 类型表
            else if let Some(dim_str) = table_name.strip_prefix(MM_PAGES_TEXT_PREFIX) {
                if let Ok(dim) = dim_str.parse::<usize>() {
                    if let Ok(table) = db.open_table(&table_name).execute().await {
                        if let Ok(count) = table.count_rows(None).await {
                            if count > 0 {
                                let estimated_bytes = count as usize * (dim * 4 + 500);
                                let entry = stats.entry(dim).or_insert((0, 0));
                                entry.0 += count as usize;
                                entry.1 += estimated_bytes;
                            }
                        }
                    }
                }
            }
        }

        Ok(stats)
    }

    #[cfg(not(feature = "lance"))]
    pub async fn get_all_stats(&self) -> Result<HashMap<usize, (usize, usize)>> {
        Err(AppError::configuration("Lance feature 未启用"))
    }

    // ============================================================================
    // 辅助方法
    // ============================================================================

    /// 创建表 schema
    #[cfg(feature = "lance")]
    fn create_schema(dim: usize) -> Arc<Schema> {
        Arc::new(Schema::new(vec![
            Field::new("page_id", DataType::Utf8, false),
            Field::new("source_type", DataType::Utf8, false),
            Field::new("source_id", DataType::Utf8, false),
            Field::new("sub_library_id", DataType::Utf8, true),
            Field::new("page_index", DataType::Int32, false),
            Field::new("blob_hash", DataType::Utf8, true),
            Field::new("text_summary", DataType::Utf8, true),
            Field::new("metadata_json", DataType::Utf8, true),
            Field::new("created_at", DataType::Utf8, false),
            Field::new(
                "vector",
                DataType::FixedSizeList(
                    Arc::new(Field::new("item", DataType::Float32, true)),
                    dim as i32,
                ),
                false,
            ),
        ]))
    }

    /// 将记录转换为 RecordBatch
    #[cfg(feature = "lance")]
    fn records_to_batch(
        records: &[MultimodalPageRecord],
        schema: &Arc<Schema>,
    ) -> Result<RecordBatch> {
        let dim = records.first().map(|r| r.embedding.len()).unwrap_or(0);

        let page_ids: Vec<&str> = records.iter().map(|r| r.page_id.as_str()).collect();
        let source_types: Vec<&str> = records.iter().map(|r| r.source_type.as_str()).collect();
        let source_ids: Vec<&str> = records.iter().map(|r| r.source_id.as_str()).collect();
        let sub_library_ids: Vec<Option<&str>> = records
            .iter()
            .map(|r| r.sub_library_id.as_deref())
            .collect();
        let page_indices: Vec<i32> = records.iter().map(|r| r.page_index).collect();
        let blob_hashes: Vec<Option<&str>> =
            records.iter().map(|r| r.blob_hash.as_deref()).collect();
        let text_summaries: Vec<Option<&str>> =
            records.iter().map(|r| r.text_summary.as_deref()).collect();
        let metadata_jsons: Vec<Option<&str>> =
            records.iter().map(|r| r.metadata_json.as_deref()).collect();
        let created_ats: Vec<&str> = records.iter().map(|r| r.created_at.as_str()).collect();

        // 构建向量数组（nullable 必须与 schema 定义一致）
        let all_values: Vec<f32> = records.iter().flat_map(|r| r.embedding.clone()).collect();
        let values = Arc::new(Float32Array::from(all_values)) as ArrayRef;
        let field_ref = Arc::new(Field::new("item", DataType::Float32, true));
        let vector_array = FixedSizeListArray::try_new(field_ref, dim as i32, values, None)
            .map_err(|e| AppError::internal(format!("创建向量数组失败: {}", e)))?;

        let columns: Vec<ArrayRef> = vec![
            Arc::new(StringArray::from(page_ids)),
            Arc::new(StringArray::from(source_types)),
            Arc::new(StringArray::from(source_ids)),
            Arc::new(StringArray::from(sub_library_ids)),
            Arc::new(Int32Array::from(page_indices)),
            Arc::new(StringArray::from(blob_hashes)),
            Arc::new(StringArray::from(text_summaries)),
            Arc::new(StringArray::from(metadata_jsons)),
            Arc::new(StringArray::from(created_ats)),
            Arc::new(vector_array),
        ];

        RecordBatch::try_new(schema.clone(), columns)
            .map_err(|e| AppError::internal(format!("创建 RecordBatch 失败: {}", e)))
    }

    /// 从 RecordBatch 解析搜索结果
    #[cfg(feature = "lance")]
    fn batch_to_search_results(batch: &RecordBatch) -> Result<Vec<SearchResult>> {
        let schema = batch.schema();
        let num_rows = batch.num_rows();

        if num_rows == 0 {
            return Ok(Vec::new());
        }

        // 获取各列的索引
        let idx_page_id = schema.index_of("page_id").unwrap_or(0);
        let idx_source_type = schema.index_of("source_type").unwrap_or(1);
        let idx_source_id = schema.index_of("source_id").unwrap_or(2);
        let idx_sub_library = schema.index_of("sub_library_id").unwrap_or(3);
        let idx_page_index = schema.index_of("page_index").unwrap_or(4);
        let idx_blob_hash = schema.index_of("blob_hash").unwrap_or(5);
        let idx_text_summary = schema.index_of("text_summary").unwrap_or(6);
        let idx_metadata = schema.index_of("metadata_json").unwrap_or(7);
        let idx_created_at = schema.index_of("created_at").unwrap_or(8);
        let idx_distance = schema.index_of("_distance").ok();

        // 获取数组
        let page_ids = batch
            .column(idx_page_id)
            .as_any()
            .downcast_ref::<StringArray>();
        let source_types = batch
            .column(idx_source_type)
            .as_any()
            .downcast_ref::<StringArray>();
        let source_ids = batch
            .column(idx_source_id)
            .as_any()
            .downcast_ref::<StringArray>();
        let sub_library_ids = batch
            .column(idx_sub_library)
            .as_any()
            .downcast_ref::<StringArray>();
        let page_indices = batch
            .column(idx_page_index)
            .as_any()
            .downcast_ref::<Int32Array>();
        let blob_hashes = batch
            .column(idx_blob_hash)
            .as_any()
            .downcast_ref::<StringArray>();
        let text_summaries = batch
            .column(idx_text_summary)
            .as_any()
            .downcast_ref::<StringArray>();
        let metadata_jsons = batch
            .column(idx_metadata)
            .as_any()
            .downcast_ref::<StringArray>();
        let created_ats = batch
            .column(idx_created_at)
            .as_any()
            .downcast_ref::<StringArray>();

        let distances =
            idx_distance.and_then(|idx| batch.column(idx).as_any().downcast_ref::<Float32Array>());

        let mut results = Vec::with_capacity(num_rows);

        for i in 0..num_rows {
            let page_id = page_ids.and_then(|a| a.value(i).into()).unwrap_or_default();
            let source_type = source_types
                .and_then(|a| a.value(i).into())
                .unwrap_or_default();
            let source_id = source_ids
                .and_then(|a| a.value(i).into())
                .unwrap_or_default();

            let sub_library_id = sub_library_ids.and_then(|a| {
                if a.is_null(i) {
                    None
                } else {
                    Some(a.value(i).to_string())
                }
            });

            let page_index = page_indices.map(|a| a.value(i)).unwrap_or(0);

            let blob_hash = blob_hashes.and_then(|a| {
                if a.is_null(i) {
                    None
                } else {
                    Some(a.value(i).to_string())
                }
            });

            let text_summary = text_summaries.and_then(|a| {
                if a.is_null(i) {
                    None
                } else {
                    Some(a.value(i).to_string())
                }
            });

            let metadata_json = metadata_jsons.and_then(|a| {
                if a.is_null(i) {
                    None
                } else {
                    Some(a.value(i).to_string())
                }
            });

            let created_at = created_ats
                .and_then(|a| a.value(i).into())
                .unwrap_or_default();

            // 计算分数（cosine distance 转换为 similarity score）
            let distance = distances.map(|a| a.value(i)).unwrap_or(0.0);
            let score = 1.0 - distance; // cosine distance 转换为 similarity

            results.push(SearchResult {
                record: MultimodalPageRecord {
                    page_id: page_id.to_string(),
                    source_type: source_type.to_string(),
                    source_id: source_id.to_string(),
                    sub_library_id,
                    page_index,
                    blob_hash,
                    text_summary,
                    metadata_json,
                    created_at: created_at.to_string(),
                    embedding: Vec::new(), // 搜索结果不返回完整向量
                },
                score,
            });
        }

        Ok(results)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_table_name() {
        assert_eq!(
            MultimodalVectorStore::table_name_by_type("vl", 768),
            "mm_pages_v2_vl_d768"
        );
        assert_eq!(
            MultimodalVectorStore::table_name_by_type("vl", 4096),
            "mm_pages_v2_vl_d4096"
        );
        assert_eq!(
            MultimodalVectorStore::table_name_by_type("text", 768),
            "mm_pages_v2_text_d768"
        );
    }

    #[test]
    fn test_common_dimensions() {
        let dims = MultimodalVectorStore::common_dimensions();
        assert!(dims.contains(&768));
        assert!(dims.contains(&4096));
    }

    #[test]
    fn test_is_dimension_valid() {
        // 有效维度范围内
        assert!(MultimodalVectorStore::is_dimension_valid(768));
        assert!(MultimodalVectorStore::is_dimension_valid(4096));
        assert!(MultimodalVectorStore::is_dimension_valid(1536));
        // 任意维度（只要在合理范围内）
        assert!(MultimodalVectorStore::is_dimension_valid(999));
        assert!(MultimodalVectorStore::is_dimension_valid(100));
        // 超出范围
        assert!(!MultimodalVectorStore::is_dimension_valid(32));
        assert!(!MultimodalVectorStore::is_dimension_valid(10000));
    }
}
