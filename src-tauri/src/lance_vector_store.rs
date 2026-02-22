use crate::database::Database;
use crate::models::{
    AppError, DocumentChunk, DocumentChunkWithEmbedding, RetrievedChunk, VectorStoreStats,
};
use crate::vector_store::VectorStore;
use async_trait::async_trait;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{debug, error, info, warn};

use rusqlite::OptionalExtension;

#[cfg(not(feature = "lance"))]
compile_error!("LanceVectorStore 现已不再提供 SQLite 回退，请开启 `lance` feature");

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err<T, E: std::fmt::Display>(result: std::result::Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[LanceVectorStore] Parse error (skipped): {}", e);
            None
        }
    }
}

/// 从聊天消息内容中提取纯文本（简化版本，用于迁移兼容）
#[cfg(feature = "lance")]
fn extract_plain_text(content: &str) -> String {
    // 简单实现：移除 JSON 格式和 markdown 图片标记
    let trimmed = content.trim();
    if trimmed.starts_with('[') || trimmed.starts_with('{') {
        // 尝试解析 JSON 并提取文本
        if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(trimmed) {
            return arr
                .iter()
                .filter_map(|v| v.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join(" ");
        }
    }
    // 移除 markdown 图片标记
    let re =
        regex::Regex::new(r"!\[.*?\]\(.*?\)").unwrap_or_else(|_| regex::Regex::new("").unwrap());
    re.replace_all(trimmed, "").trim().to_string()
}
#[cfg(feature = "lance")]
use crate::llm_manager::LLMManager;
#[cfg(feature = "lance")]
use arrow_array::{
    Array, ArrayRef, FixedSizeListArray, Float32Array, Int32Array, RecordBatch,
    RecordBatchIterator, StringArray, UInt64Array,
};
#[cfg(feature = "lance")]
use arrow_schema::{DataType, Field, Schema};
#[cfg(feature = "lance")]
use lancedb::index::scalar::FtsIndexBuilder;
#[cfg(feature = "lance")]
use lancedb::index::scalar::FullTextSearchQuery;
#[cfg(feature = "lance")]
use lancedb::index::Index;
#[cfg(feature = "lance")]
use lancedb::query::{ExecutableQuery, QueryBase, QueryExecutionOptions};
#[cfg(feature = "lance")]
use lancedb::table::{OptimizeAction, OptimizeOptions};
#[cfg(feature = "lance")]
use lancedb::DistanceType;
#[cfg(feature = "lance")]
use lancedb::{Connection, Table};
#[cfg(feature = "lance")]
use std::time::{Duration, Instant};
#[cfg(feature = "lance")]

type Result<T> = std::result::Result<T, AppError>;

#[cfg(feature = "lance")]
pub fn default_lance_root_from_db_path(db_path: Option<PathBuf>) -> Result<PathBuf> {
    let base_dir = db_path
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let lance_dir = base_dir.join("lance");
    ensure_dir(&lance_dir, "创建 Lance 根目录失败")?;
    Ok(lance_dir)
}

#[cfg(all(feature = "lance", any(target_os = "ios", target_os = "android")))]
fn override_path_allowed(candidate: &Path, sandbox_root: &Path) -> bool {
    candidate.is_absolute() && candidate.starts_with(sandbox_root)
}

#[cfg(all(feature = "lance", not(any(target_os = "ios", target_os = "android"))))]
fn override_path_allowed(candidate: &Path, _sandbox_root: &Path) -> bool {
    candidate.is_absolute()
}

#[cfg(feature = "lance")]
fn ensure_dir(path: &Path, reason: &str) -> Result<()> {
    fs::create_dir_all(path).map_err(|err| {
        AppError::file_system(format!("{}: {} ({})", reason, err, path.to_string_lossy()))
    })
}

// 在移动端（Android/iOS）确保 TMP 目录位于指定沙盒根目录内，避免跨挂载点 rename 失败
#[cfg(all(feature = "lance", any(target_os = "ios", target_os = "android")))]
pub fn ensure_mobile_tmpdir_within(sandbox_root: &Path) -> Result<PathBuf> {
    let tmp_dir = sandbox_root.join("tmp");
    ensure_dir(&tmp_dir, "创建 Lance 临时目录失败")?;
    // 可写性探测，尽早暴露权限/占用问题
    {
        use std::io::Write as _;
        let probe = tmp_dir.join(".tmp_probe");
        match std::fs::File::create(&probe).and_then(|mut f| f.write_all(b"ok")) {
            Ok(_) => {
                let _ = std::fs::remove_file(&probe);
            }
            Err(err) => {
                return Err(AppError::file_system(format!(
                    "临时目录不可写: {} ({})",
                    err,
                    tmp_dir.to_string_lossy()
                )));
            }
        }
    }

    // 统一设置多种常见临时目录环境变量，确保 Arrow/Lance/依赖库均使用同一沙盒内目录
    // SAFETY: 此函数在移动端应用启动早期阶段调用（setup 钩子中），
    // 此时 tokio 运行时和 Lance 工作线程尚未启动，不存在多线程竞争。
    // 注意：如果此函数被延迟调用（在多线程环境中），则存在 UB 风险，
    // 应考虑改用 std::sync::OnceLock 或在进程启动前通过 wrapper 脚本设置。
    std::env::set_var("TMPDIR", &tmp_dir);
    std::env::set_var("TEMP", &tmp_dir);
    std::env::set_var("TMP", &tmp_dir);
    // 部分 Arrow 组件会读取该变量
    std::env::set_var("ARROW_TMP_DIR", &tmp_dir);
    // 预留给可能的 Lance 配置（安全冗余，不影响其他平台）
    std::env::set_var("LANCEDB_TMPDIR", &tmp_dir);

    Ok(tmp_dir)
}

// 非移动端：保持空操作以简化调用方逻辑
#[cfg(all(feature = "lance", not(any(target_os = "ios", target_os = "android"))))]
pub fn ensure_mobile_tmpdir_within(_sandbox_root: &Path) -> Result<PathBuf> {
    Ok(std::env::temp_dir())
}

/// LanceDB 向量存储实现（占位骨架）
///
/// 说明：
/// - 仅在启用 feature "lance" 时可用；否则 `new()` 返回配置错误。
/// - 设计上仍复用 SQLite 的结构化表与 FTS 预筛；向量数据写入 LanceDB。
pub struct LanceVectorStore {
    database: Arc<Database>,
    #[allow(dead_code)]
    dim: Option<usize>,
    #[cfg(feature = "lance")]
    db: Option<Connection>,
    // 内存向量缓存：chunk_id -> (embedding, document_id, sub_library_id)
    emb_cache: dashmap::DashMap<String, (Vec<f32>, String, Option<String>)>,
    // 简单容量上限，避免内存膨胀（非严格LRU，超限时近似清理）
    cache_cap: usize,
}

#[cfg(feature = "lance")]
pub const KB_V2_TABLE_PREFIX: &str = "kb_chunks_v2_d";
#[cfg(feature = "lance")]
const KB_LEGACY_TABLE_PREFIX: &str = "kb_embeddings_d";
#[cfg(feature = "lance")]
const CHAT_V2_TABLE_PREFIX: &str = "chat_embeddings_v2_d";
#[cfg(feature = "lance")]
const CHAT_LEGACY_TABLE_PREFIX: &str = "chat_embeddings_d";
#[cfg(feature = "lance")]
const CHAT_LEGACY_FALLBACK_TABLE: &str = "chat_embeddings";
#[cfg(feature = "lance")]
const KB_FTS_VERSION: &str = "2024-05-kb-ngram-v1";
#[cfg(feature = "lance")]
const CHAT_FTS_VERSION: &str = "2024-05-chat-ngram-v1";
#[cfg(feature = "lance")]
const OPTIMIZE_MIN_INTERVAL_CHAT_SECS: i64 = 1800; // 30min
#[cfg(feature = "lance")]
const LANCE_RELEVANCE_COL: &str = "_relevance_score";
#[cfg(feature = "lance")]
const LANCE_FTS_SCORE_COL: &str = "_score";

#[cfg(feature = "lance")]
const CATEGORY_KB_SQLITE: &str = "kb_sqlite_to_lance";
#[cfg(feature = "lance")]
const CATEGORY_CHAT_FALLBACK: &str = "chat_legacy_base";

#[cfg(feature = "lance")]
struct LanceChunkRow {
    chunk_id: String,
    document_id: String,
    sub_library_id: Option<String>,
    chunk_index: i32,
    text: String,
    metadata_json: Option<String>,
    created_at: String,
    embedding: Vec<f32>,
}

#[cfg(feature = "lance")]
pub struct LanceChatRow {
    pub message_id: String,
    pub mistake_id: String,
    pub role: String,
    pub timestamp: String,
    pub text: String,
    pub embedding: Vec<f32>,
}

#[cfg(feature = "lance")]
fn parse_bool_flag(value: &str) -> Option<bool> {
    let trimmed = value.trim();
    if trimmed.eq_ignore_ascii_case("true")
        || trimmed.eq_ignore_ascii_case("yes")
        || trimmed.eq_ignore_ascii_case("on")
        || trimmed == "1"
    {
        Some(true)
    } else if trimmed.eq_ignore_ascii_case("false")
        || trimmed.eq_ignore_ascii_case("no")
        || trimmed.eq_ignore_ascii_case("off")
        || trimmed == "0"
    {
        Some(false)
    } else {
        None
    }
}

#[derive(Debug, Clone)]
pub struct LibrarySummary {
    pub chunk_count: usize,
    pub text_bytes: usize,
    pub embedding_bytes: usize,
}

impl LanceVectorStore {
    #[cfg(feature = "lance")]
    fn candidate_dim_values() -> Vec<usize> {
        // 常见嵌入维度集合，覆盖 OpenAI/BGE/Multilingual/Qwen3-VL 等常见模型
        // 4096: Qwen3-VL-Embedding-8B 默认输出维度（多模态知识库）
        vec![256, 384, 512, 768, 1024, 1536, 2048, 3072, 4096]
    }

    #[cfg(feature = "lance")]
    fn extract_chunk_rows_from_batch(batch: &RecordBatch) -> Result<Vec<LanceChunkRow>> {
        let schema = batch.schema();
        let idx_chunk = schema
            .index_of("chunk_id")
            .map_err(|e| AppError::database(e.to_string()))?;
        let idx_doc = schema
            .index_of("document_id")
            .map_err(|e| AppError::database(e.to_string()))?;
        let idx_sub = schema.index_of("sub_library_id").ok();
        let idx_index = schema
            .index_of("chunk_index")
            .map_err(|e| AppError::database(e.to_string()))?;
        let idx_text = schema
            .index_of("text")
            .map_err(|e| AppError::database(e.to_string()))?;
        let idx_meta = schema.index_of("metadata").ok();
        let idx_created = schema
            .index_of("created_at")
            .map_err(|e| AppError::database(e.to_string()))?;

        let chunk_arr = batch
            .column(idx_chunk)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| AppError::database("chunk_id 列类型错误".to_string()))?;
        let doc_arr = batch
            .column(idx_doc)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| AppError::database("document_id 列类型错误".to_string()))?;
        let sub_arr = idx_sub.and_then(|i| {
            batch
                .column(i)
                .as_any()
                .downcast_ref::<StringArray>()
                .map(|arr| arr as &StringArray)
        });
        let idx_arr = batch
            .column(idx_index)
            .as_any()
            .downcast_ref::<arrow_array::Int32Array>()
            .ok_or_else(|| AppError::database("chunk_index 列类型错误".to_string()))?;
        let text_arr = batch
            .column(idx_text)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| AppError::database("text 列类型错误".to_string()))?;
        let meta_arr = idx_meta.and_then(|i| {
            batch
                .column(i)
                .as_any()
                .downcast_ref::<StringArray>()
                .map(|arr| arr as &StringArray)
        });
        let created_arr = batch
            .column(idx_created)
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| AppError::database("created_at 列类型错误".to_string()))?;

        let mut rows: Vec<LanceChunkRow> = Vec::with_capacity(batch.num_rows());
        for i in 0..batch.num_rows() {
            let sub_library_id = sub_arr.and_then(|arr| {
                if arr.is_null(i) {
                    None
                } else {
                    Some(arr.value(i).to_string())
                }
            });
            let metadata_json = meta_arr.and_then(|arr| {
                if arr.is_null(i) {
                    None
                } else {
                    Some(arr.value(i).to_string())
                }
            });
            rows.push(LanceChunkRow {
                chunk_id: chunk_arr.value(i).to_string(),
                document_id: doc_arr.value(i).to_string(),
                sub_library_id,
                chunk_index: idx_arr.value(i),
                text: text_arr.value(i).to_string(),
                metadata_json,
                created_at: created_arr.value(i).to_string(),
                embedding: Vec::new(),
            });
        }

        Ok(rows)
    }

    #[cfg(feature = "lance")]
    pub async fn summarize_library(&self, sub_library_id: Option<&str>) -> Result<LibrarySummary> {
        use futures_util::TryStreamExt;

        let path = self.get_lance_path()?;
        let db = lancedb::connect(&path)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;

        let filter_expr =
            sub_library_id.map(|id| format!("sub_library_id = '{}'", id.replace("'", "''")));
        let mut chunk_count: usize = 0;
        let mut text_bytes: usize = 0;
        let mut embedding_bytes: usize = 0;

        for dim in Self::candidate_dim_values() {
            let table_name = format!("{}{}", KB_V2_TABLE_PREFIX, dim);
            let tbl = match db.open_table(&table_name).execute().await {
                Ok(tbl) => tbl,
                Err(_) => continue,
            };

            let mut query = tbl.query();
            if let Some(expr) = filter_expr.as_ref() {
                query = query.only_if(expr);
            }

            let mut stream = query
                .execute()
                .await
                .map_err(|e| AppError::database(e.to_string()))?;

            while let Some(batch) = stream
                .try_next()
                .await
                .map_err(|e| AppError::database(e.to_string()))?
            {
                let schema = batch.schema();
                let idx_text = schema
                    .index_of("text")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let text_arr = batch
                    .column(idx_text)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| AppError::database("text 列类型错误".to_string()))?;
                for i in 0..text_arr.len() {
                    text_bytes += text_arr.value(i).as_bytes().len();
                }

                let idx_emb = schema
                    .index_of("embedding")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let emb_arr = batch
                    .column(idx_emb)
                    .as_any()
                    .downcast_ref::<FixedSizeListArray>()
                    .ok_or_else(|| AppError::database("embedding 列类型错误".to_string()))?;
                let width = emb_arr.value_length() as usize;
                chunk_count += emb_arr.len();
                embedding_bytes += emb_arr.len() * width * std::mem::size_of::<f32>();
            }
        }

        Ok(LibrarySummary {
            chunk_count,
            text_bytes,
            embedding_bytes,
        })
    }

    #[cfg(feature = "lance")]
    fn candidate_kb_table_names_for_scan() -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for d in Self::candidate_dim_values() {
            names.push(format!("{}{}", KB_V2_TABLE_PREFIX, d));
        }
        names
    }
    pub fn new(database: Arc<Database>) -> Result<Self> {
        // 在启用情况下，可在此读取维度 / 初始化 Lance 表等
        let store = Self {
            database,
            dim: None,
            #[cfg(feature = "lance")]
            db: None,
            emb_cache: dashmap::DashMap::new(),
            cache_cap: 100_000,
        };
        // 先确保基础 RAG 表结构（SQLite 端）存在
        store.ensure_base_rag_schema()?;
        // 冷启动预热：后台扫描 Lance 表，尽可能灌入内存缓存（最佳努力，不影响主流程）
        store.spawn_warmup_scan();
        Ok(store)
    }

    // 缓存指标（供完整性校验）
    pub fn cache_size(&self) -> usize {
        self.emb_cache.len()
    }

    pub fn sample_cache(&self, n: usize) -> Vec<(String, usize, bool, Option<String>)> {
        let mut out = Vec::new();
        for entry in self.emb_cache.iter().take(n) {
            let (emb, _doc, sub) = entry.value();
            let dim = emb.len();
            let finite = emb.iter().all(|v| v.is_finite());
            out.push((entry.key().clone(), dim, finite, sub.clone()));
        }
        out
    }

    #[cfg(feature = "lance")]
    pub fn count_lance_rows_sync(&self) -> Option<usize> {
        use futures_util::TryStreamExt;
        let path = match self.get_lance_path() {
            Ok(p) => p,
            Err(err) => {
                error!("⚠️ [Lance统计] 无法解析 Lance 路径: {}", err);
                return None;
            }
        };
        tauri::async_runtime::block_on(async move {
            let db = lancedb::connect(&path).execute().await.ok()?;
            let mut total: usize = 0;
            for name in Self::candidate_kb_table_names_for_scan() {
                if let Ok(tbl) = db.open_table(&name).execute().await {
                    if let Ok(mut stream) = tbl.query().execute().await {
                        while let Ok(Some(batch)) = stream.try_next().await {
                            total += batch.num_rows();
                        }
                    }
                }
            }
            Some(total)
        })
    }

    #[cfg(feature = "lance")]
    fn cache_maybe_trim(&self) {
        let len = self.emb_cache.len();
        if len > self.cache_cap {
            let mut removed = 0usize;
            for k in self
                .emb_cache
                .iter()
                .map(|e| e.key().clone())
                .take(len / 10)
            {
                let _ = self.emb_cache.remove(&k);
                removed += 1;
                if self.emb_cache.len() <= self.cache_cap {
                    break;
                }
            }
            warn!("⚠️ [LanceCache] 缓存超限，已近似清理 {} 条", removed);
        }
    }

    #[cfg(feature = "lance")]
    fn spawn_warmup_scan(&self) {
        use futures_util::TryStreamExt;
        let _this = self.database.clone();
        let base = match self.get_lance_path() {
            Ok(path) => path,
            Err(err) => {
                error!("⚠️ [Lance预热] 无法获取目录: {}", err);
                return;
            }
        };
        let cache = self.emb_cache.clone();
        let cap = self.cache_cap;
        tauri::async_runtime::spawn(async move {
            if cap == 0 {
                return;
            }
            // 尝试连接 Lance 并扫描所有候选表（最佳努力）
            let db = match lancedb::connect(&base).execute().await {
                Ok(db) => db,
                Err(_) => return,
            };
            let mut any_dim: Option<usize> = None;
            'table_loop: for name in Self::candidate_kb_table_names_for_scan() {
                let tbl = match db.open_table(&name).execute().await {
                    Ok(t) => t,
                    Err(_) => continue,
                };
                let mut stream = match tbl.query().execute().await {
                    Ok(s) => s,
                    Err(_) => continue,
                };
                while let Ok(Some(batch)) = stream.try_next().await {
                    let schema = batch.schema();
                    if let Ok(idx_emb) = schema.index_of("embedding") {
                        if let Some(list) = batch
                            .column(idx_emb)
                            .as_any()
                            .downcast_ref::<FixedSizeListArray>()
                        {
                            let width = list.value_length() as usize;
                            if any_dim.is_none() {
                                any_dim = Some(width);
                            }
                            let idx_id = match schema.index_of("chunk_id") {
                                Ok(i) => i,
                                Err(_) => break,
                            };
                            let id_arr =
                                match batch.column(idx_id).as_any().downcast_ref::<StringArray>() {
                                    Some(a) => a,
                                    None => break,
                                };
                            let sub_arr_opt =
                                schema.index_of("sub_library_id").ok().and_then(|i| {
                                    batch.column(i).as_any().downcast_ref::<StringArray>()
                                });
                            for i in 0..list.len() {
                                let values = list.value(i);
                                let fvals = values.as_any().downcast_ref::<Float32Array>();
                                if let Some(vec32) = fvals {
                                    let mut v = Vec::with_capacity(width);
                                    for j in 0..width {
                                        v.push(vec32.value(j));
                                    }
                                    let chunk_id = id_arr.value(i).to_string();
                                    let sub = sub_arr_opt.map(|a| a.value(i).to_string());
                                    cache.insert(chunk_id, (v, String::new(), sub));
                                    if cache.len() >= cap {
                                        break 'table_loop;
                                    }
                                }
                            }
                        }
                    }
                }
            }
            if let Some(d) = any_dim {
                // 静默预热，避免日志风暴
                let _ = (d, cache.len());
            }
        });
    }

    fn enforce_cache_cap(&self) {
        let len = self.emb_cache.len();
        if len > self.cache_cap {
            let mut removed = 0usize;
            for entry in self.emb_cache.iter() {
                if removed >= (len - self.cache_cap).min(10_000) {
                    break;
                }
                let k = entry.key().clone();
                self.emb_cache.remove(&k);
                removed += 1;
            }
        }
    }

    #[cfg(feature = "lance")]
    fn get_lance_path(&self) -> Result<String> {
        let mut dir = self.resolve_lance_base()?;
        // 移动端：强制将 TMP 定位在 Lance 基础目录内，避免跨挂载点 rename 失败
        let _ = ensure_mobile_tmpdir_within(&dir);
        dir.push("kb");
        ensure_dir(&dir, "创建 Lance KB 目录失败")?;
        Ok(dir.to_string_lossy().to_string())
    }

    pub fn get_database(&self) -> Arc<Database> {
        self.database.clone()
    }

    #[cfg(feature = "lance")]
    fn resolve_lance_base(&self) -> Result<PathBuf> {
        let default_root = default_lance_root_from_db_path(self.database.db_path())?;
        let setting_value = self
            .database
            .get_setting("rag.lance.path")
            .ok()
            .flatten()
            .map(|raw| raw.trim().to_string())
            .filter(|v| !v.is_empty());

        if let Some(raw) = setting_value {
            let candidate = PathBuf::from(&raw);
            if override_path_allowed(&candidate, &default_root) {
                match ensure_dir(&candidate, "创建自定义 Lance 目录失败") {
                    Ok(_) => {
                        // 归一化保存，避免下次读取出现多余空白
                        let normalized = candidate.to_string_lossy().to_string();
                        if normalized != raw {
                            self.database.save_setting("rag.lance.path", &normalized)?;
                        }
                        return Ok(candidate);
                    }
                    Err(err) => {
                        error!(
                            "⚠️ [Lance路径] 自定义目录不可用 {}: {}",
                            candidate.to_string_lossy(),
                            err
                        );
                    }
                }
            }

            warn!(
                "⚠️ [Lance路径] 设置 rag.lance.path=\"{}\" 无效，已回退到默认目录 {}",
                raw,
                default_root.to_string_lossy()
            );
            self.database
                .save_setting("rag.lance.path", &default_root.to_string_lossy())?;
        }

        Ok(default_root)
    }

    #[cfg(feature = "lance")]
    pub(crate) fn optimization_scope_key(scope: &str) -> String {
        format!("lance.optimize.last.{}", scope)
    }

    #[cfg(feature = "lance")]
    fn should_skip_optimization(
        &self,
        scope: &str,
        min_interval: chrono::Duration,
        force: bool,
    ) -> Result<bool> {
        if force {
            return Ok(false);
        }
        let key = Self::optimization_scope_key(scope);
        let last = self
            .database
            .get_setting(&key)
            .ok()
            .flatten()
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(&s).ok())
            .map(|dt| dt.with_timezone(&chrono::Utc));
        if let Some(last_ts) = last {
            let elapsed = chrono::Utc::now() - last_ts;
            if elapsed < min_interval {
                info!(
                    "ℹ️ [Lance优化] scope={} 距离上次优化仅 {:?}，小于阈值 {:?}，跳过自动优化。",
                    scope, elapsed, min_interval
                );
                return Ok(true);
            }
        }
        Ok(false)
    }

    #[cfg(feature = "lance")]
    fn record_optimization_timestamp(&self, scope: &str) {
        let key = Self::optimization_scope_key(scope);
        let now = chrono::Utc::now().to_rfc3339();
        if let Err(err) = self.database.save_setting(&key, &now) {
            warn!("⚠️ [Lance优化] 记录 {} 上次优化时间失败: {}", scope, err);
        }
    }

    #[cfg(feature = "lance")]
    fn resolve_delete_unverified(&self, override_flag: Option<bool>) -> bool {
        if let Some(flag) = override_flag {
            return flag;
        }
        self.database
            .get_setting("lance.optimize.delete_unverified")
            .ok()
            .flatten()
            .and_then(|raw| parse_bool_flag(&raw))
            .unwrap_or(false)
    }

    #[cfg(feature = "lance")]
    async fn optimize_table_internal(
        &self,
        table: Table,
        table_name: &str,
        older_than_days: Option<u64>,
        delete_unverified: bool,
    ) -> Result<()> {
        let prune_duration = older_than_days.and_then(|days| {
            if days == 0 {
                None
            } else {
                chrono::Duration::try_days(days as i64)
            }
        });

        if prune_duration.is_some() || delete_unverified {
            let compact_stats = table
                .optimize(OptimizeAction::Compact {
                    options: lancedb::table::CompactionOptions::default(),
                    remap_options: None,
                })
                .await
                .map_err(|e| AppError::database(e.to_string()))?;
            if let Some(metrics) = compact_stats.compaction {
                info!(
                    "✅ [Lance优化] {} Compact: +{} / -{}",
                    table_name, metrics.files_added, metrics.files_removed
                );
            }

            let prune_stats = table
                .optimize(OptimizeAction::Prune {
                    older_than: prune_duration,
                    delete_unverified: Some(delete_unverified),
                    error_if_tagged_old_versions: Some(false),
                })
                .await
                .map_err(|e| AppError::database(e.to_string()))?;
            if let Some(metrics) = prune_stats.prune {
                info!(
                    "✅ [Lance优化] {} Prune: 删除{}个旧版本, 回收{}字节",
                    table_name, metrics.old_versions, metrics.bytes_removed
                );
            }

            table
                .optimize(OptimizeAction::Index(OptimizeOptions::default()))
                .await
                .map_err(|e| AppError::database(e.to_string()))?;
            info!("✅ [Lance优化] {} Index 优化完成", table_name);
        } else {
            let stats = table
                .optimize(OptimizeAction::All)
                .await
                .map_err(|e| AppError::database(e.to_string()))?;
            if let Some(metrics) = stats.compaction {
                info!(
                    "✅ [Lance优化] {} Compact: +{} / -{}",
                    table_name, metrics.files_added, metrics.files_removed
                );
            }
            if let Some(prune) = stats.prune {
                info!(
                    "✅ [Lance优化] {} Prune: 删除{}个旧版本, 回收{}字节",
                    table_name, prune.old_versions, prune.bytes_removed
                );
            }
        }

        info!("🎉 [Lance优化] {} 优化完成", table_name);
        Ok(())
    }

    #[cfg(feature = "lance")]
    async fn optimize_table_group(
        &self,
        scope: &str,
        min_interval_secs: i64,
        table_names: Vec<String>,
        older_than_days: Option<u64>,
        delete_unverified: Option<bool>,
        force: bool,
    ) -> Result<usize> {
        let min_interval = chrono::Duration::seconds(min_interval_secs.max(0));
        if self.should_skip_optimization(scope, min_interval, force)? {
            return Ok(0);
        }
        let delete_flag = self.resolve_delete_unverified(delete_unverified);
        let path = self.get_lance_path()?;
        let conn = lancedb::connect(&path)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;
        let mut optimized = 0usize;
        let mut seen: HashSet<String> = HashSet::new();

        for name in table_names {
            if name.trim().is_empty() || !seen.insert(name.clone()) {
                continue;
            }
            match conn.open_table(&name).execute().await {
                Ok(table) => {
                    if let Err(err) = self
                        .optimize_table_internal(table, &name, older_than_days, delete_flag)
                        .await
                    {
                        error!("⚠️ [Lance优化] {} 优化失败: {}", name, err);
                    } else {
                        optimized += 1;
                    }
                }
                Err(_) => continue,
            }
        }

        if optimized == 0 {
            info!("ℹ️ [Lance优化] 未发现可优化的 Lance 表");
        } else {
            self.record_optimization_timestamp(scope);
        }
        Ok(optimized)
    }

    #[cfg(feature = "lance")]
    pub async fn optimize_chat_tables(
        &self,
        older_than_days: Option<u64>,
        delete_unverified: Option<bool>,
        force: bool,
    ) -> Result<usize> {
        let mut names: Vec<String> = Vec::new();
        for dim in Self::candidate_dim_values() {
            names.push(format!("{}{}", CHAT_V2_TABLE_PREFIX, dim));
            names.push(format!("{}{}", CHAT_LEGACY_TABLE_PREFIX, dim));
        }
        names.push(CHAT_LEGACY_FALLBACK_TABLE.to_string());

        let optimized = self
            .optimize_table_group(
                "chat",
                OPTIMIZE_MIN_INTERVAL_CHAT_SECS,
                names,
                older_than_days,
                delete_unverified,
                force,
            )
            .await?;
        if optimized > 0 {
            info!("✅ [Lance优化] 聊天向量表优化完成（{} 张表）", optimized);
        }
        Ok(optimized)
    }

    #[cfg(feature = "lance")]
    fn build_sub_library_filter(ids: &[String]) -> Option<String> {
        let mut values: Vec<String> = Vec::with_capacity(ids.len());
        for raw in ids {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let sanitized = trimmed.replace('\'', "''");
            values.push(format!("'{}'", sanitized));
        }
        if values.is_empty() {
            return None;
        }
        if values.len() == 1 {
            Some(format!("sub_library_id = {}", values[0]))
        } else {
            Some(format!("sub_library_id IN ({})", values.join(", ")))
        }
    }

    #[cfg(feature = "lance")]
    fn fts_version_key(table_name: &str) -> String {
        format!("rag.lance.fts.version.{}", table_name)
    }

    #[cfg(feature = "lance")]
    fn should_rebuild_fts(&self, table_name: &str, expected: &str) -> bool {
        self.database
            .get_setting(Self::fts_version_key(table_name).as_str())
            .ok()
            .flatten()
            .map(|v| v != expected)
            .unwrap_or(true)
    }

    #[cfg(feature = "lance")]
    fn record_fts_version(&self, table_name: &str, version: &str) {
        if let Err(err) = self
            .database
            .save_setting(Self::fts_version_key(table_name).as_str(), version)
        {
            warn!(
                "⚠️ [LanceIndex] 保存 FTS 版本信息失败 {} -> {}: {}",
                table_name, version, err
            );
        }
    }

    #[cfg(feature = "lance")]
    fn build_fts_index_builder(&self) -> FtsIndexBuilder {
        let tokenizer = self
            .database
            .get_setting("rag.hybrid.fts.tokenizer")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "ngram".to_string());

        let mut builder = FtsIndexBuilder::default().base_tokenizer(tokenizer.clone());

        let mut disable_language_filters = false;
        if tokenizer == "ngram" {
            let min_len = self
                .database
                .get_setting("rag.hybrid.fts.ngram_min")
                .ok()
                .flatten()
                .and_then(|s| s.parse::<u32>().ok())
                .map(|v| v.max(1).min(6))
                .unwrap_or(2);
            let max_len = self
                .database
                .get_setting("rag.hybrid.fts.ngram_max")
                .ok()
                .flatten()
                .and_then(|s| s.parse::<u32>().ok())
                .map(|v| v.max(min_len).min(8))
                .unwrap_or_else(|| std::cmp::max(min_len, 4));
            let prefix_only = self
                .database
                .get_setting("rag.hybrid.fts.ngram_prefix_only")
                .ok()
                .flatten()
                .map(|s| s == "1" || s.eq_ignore_ascii_case("true"))
                .unwrap_or(true);

            builder = builder
                .ngram_min_length(min_len)
                .ngram_max_length(max_len)
                .ngram_prefix_only(prefix_only);
            disable_language_filters = true;
        }

        builder = builder.max_token_length(Some(64));
        builder = builder.lower_case(true);
        if disable_language_filters {
            builder = builder.stem(false);
            builder = builder.remove_stop_words(false);
        }
        builder = builder.ascii_folding(true);

        if let Some(language) = self
            .database
            .get_setting("rag.hybrid.fts.language")
            .ok()
            .flatten()
            .filter(|s| !s.trim().is_empty())
        {
            match builder.clone().language(language.trim()) {
                Ok(updated) => builder = updated,
                Err(err) => {
                    warn!(
                        "⚠️ [LanceIndex] 设置 FTS language={} 失败: {}",
                        language.trim(),
                        err
                    );
                }
            }
        }

        builder
    }

    #[cfg(feature = "lance")]
    #[cfg(feature = "lance")]
    async fn ensure_wide_table(&self, dim: usize) -> Result<Table> {
        let path = self.get_lance_path()?;
        let db = lancedb::connect(&path)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;
        let table_name = format!("{}{}", KB_V2_TABLE_PREFIX, dim);
        let tbl = match db.open_table(&table_name).execute().await {
            Ok(tbl) => tbl,
            Err(_) => {
                let schema = Schema::new(vec![
                    Field::new("chunk_id", DataType::Utf8, false),
                    Field::new("document_id", DataType::Utf8, false),
                    Field::new("sub_library_id", DataType::Utf8, true),
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
                ]);
                let empty: Vec<std::result::Result<RecordBatch, arrow_schema::ArrowError>> =
                    Vec::new();
                let iter = RecordBatchIterator::new(empty.into_iter(), Arc::new(schema.clone()));
                db.create_table(&table_name, iter)
                    .execute()
                    .await
                    .map_err(|e| AppError::database(format!("创建 Lance 表失败: {}", e)))?
            }
        };
        let embed_idx_start = Instant::now();
        let embed_res = tbl
            .create_index(&["embedding"], Index::Auto)
            .replace(false)
            .execute()
            .await;
        if let Err(err) = embed_res {
            let msg = err.to_string();
            if !msg.contains("already exists") {
                warn!(
                    "⚠️ [LanceIndex] embedding index ensure failed on {}: {}",
                    table_name, msg
                );
            }
        } else {
            debug!(
                "⏱️ [LanceIndex] ensured embedding index on {} in {}ms",
                table_name,
                embed_idx_start.elapsed().as_millis()
            );
        }
        let rebuild_fts = self.should_rebuild_fts(&table_name, KB_FTS_VERSION);
        let fts_idx_start = Instant::now();
        let fts_builder = self.build_fts_index_builder();
        let fts_res = tbl
            .create_index(&["text"], Index::FTS(fts_builder))
            .replace(rebuild_fts)
            .execute()
            .await;
        match fts_res {
            Ok(_) => {
                self.record_fts_version(&table_name, KB_FTS_VERSION);
                debug!(
                    "⏱️ [LanceIndex] ensured FTS index on {} in {}ms",
                    table_name,
                    fts_idx_start.elapsed().as_millis()
                );
            }
            Err(err) => {
                let msg = err.to_string();
                if !msg.contains("already exists") {
                    warn!(
                        "⚠️ [LanceIndex] FTS index ensure failed on {}: {}",
                        table_name, msg
                    );
                } else if rebuild_fts {
                    warn!(
                        "⚠️ [LanceIndex] 请求重建 {} FTS 但失败: {}",
                        table_name, msg
                    );
                } else {
                    self.record_fts_version(&table_name, KB_FTS_VERSION);
                }
            }
        }
        Ok(tbl)
    }

    #[cfg(feature = "lance")]
    #[cfg(feature = "lance")]
    fn build_batch_embeddings_wide(
        &self,
        dim: usize,
        rows: &[LanceChunkRow],
    ) -> Result<(Arc<Schema>, RecordBatch)> {
        let n = rows.len();
        let mut flat: Vec<f32> = Vec::with_capacity(n * dim);
        for row in rows.iter() {
            if row.embedding.len() != dim {
                return Err(AppError::validation("embedding 维度不一致"));
            }
            flat.extend_from_slice(&row.embedding);
        }

        let schema = Arc::new(Schema::new(vec![
            Field::new("chunk_id", DataType::Utf8, false),
            Field::new("document_id", DataType::Utf8, false),
            Field::new("sub_library_id", DataType::Utf8, true),
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
        ]));

        let chunk_id_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.chunk_id.as_str()),
        ));
        let document_id_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.document_id.as_str()),
        ));
        let sub_lib_arr: ArrayRef = Arc::new(StringArray::from_iter(
            rows.iter().map(|r| r.sub_library_id.as_deref()),
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
                .map_err(|e| AppError::database(e.to_string()))?,
        );

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                chunk_id_arr,
                document_id_arr,
                sub_lib_arr,
                chunk_index_arr,
                text_arr,
                metadata_arr,
                created_at_arr,
                embedding_arr,
            ],
        )
        .map_err(|e| AppError::database(format!("构建批次失败: {}", e)))?;
        Ok((schema, batch))
    }

    #[cfg(feature = "lance")]
    fn build_batch_embeddings_chat(
        &self,
        dim: usize,
        rows: &[LanceChatRow],
    ) -> Result<(Arc<Schema>, RecordBatch)> {
        let n = rows.len();
        let mut flat: Vec<f32> = Vec::with_capacity(n * dim);
        for row in rows.iter() {
            if row.embedding.len() != dim {
                return Err(AppError::validation("embedding 维度不一致"));
            }
            flat.extend_from_slice(&row.embedding);
        }

        let schema = Arc::new(Schema::new(vec![
            Field::new("message_id", DataType::Utf8, false),
            Field::new("mistake_id", DataType::Utf8, false),
            Field::new("role", DataType::Utf8, false),
            Field::new("timestamp", DataType::Utf8, false),
            Field::new("text", DataType::Utf8, false),
            Field::new(
                "embedding",
                DataType::FixedSizeList(
                    Arc::new(Field::new("item", DataType::Float32, false)),
                    dim as i32,
                ),
                false,
            ),
        ]));

        let message_id_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.message_id.as_str()),
        ));
        let mistake_id_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.mistake_id.as_str()),
        ));
        let role_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.role.as_str()),
        ));
        let timestamp_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.timestamp.as_str()),
        ));
        let text_arr: ArrayRef = Arc::new(StringArray::from_iter_values(
            rows.iter().map(|r| r.text.as_str()),
        ));
        let values = Arc::new(Float32Array::from(flat)) as ArrayRef;
        let field_ref = Arc::new(Field::new("item", DataType::Float32, false));
        let embedding_arr: ArrayRef = Arc::new(
            FixedSizeListArray::try_new(field_ref, dim as i32, values, None)
                .map_err(|e| AppError::database(e.to_string()))?,
        );

        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![
                message_id_arr,
                mistake_id_arr,
                role_arr,
                timestamp_arr,
                text_arr,
                embedding_arr,
            ],
        )
        .map_err(|e| AppError::database(format!("构建批次失败: {}", e)))?;
        Ok((schema, batch))
    }

    #[cfg(feature = "lance")]
    async fn write_chunks_to_wide_table(&self, dim: usize, rows: &[LanceChunkRow]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let tbl = self.ensure_wide_table(dim).await?;
        let chunk_ids: Vec<String> = rows.iter().map(|r| r.chunk_id.clone()).collect();
        for batch_ids in chunk_ids.chunks(900) {
            let in_list = batch_ids
                .iter()
                .map(|s| format!("'{}'", s.replace("'", "''")))
                .collect::<Vec<_>>()
                .join(",");
            let expr = format!("chunk_id IN ({})", in_list);
            let _ = tbl.delete(expr.as_str()).await;
        }

        let (schema, batch) = self.build_batch_embeddings_wide(dim, rows)?;
        let iter = RecordBatchIterator::new(vec![Ok(batch)].into_iter(), schema);
        tbl.add(iter)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("写入 Lance 扩展表失败: {}", e)))?;
        Ok(())
    }

    #[cfg(feature = "lance")]
    fn write_chunks_to_sqlite(&self, rows: &[LanceChunkRow]) -> Result<()> {
        if rows.is_empty() {
            return Ok(());
        }
        let mut conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let tx = conn
            .transaction()
            .map_err(|e| AppError::database(format!("开启 rag_document_chunks 事务失败: {}", e)))?;
        {
            let mut stmt = tx
                .prepare("INSERT OR REPLACE INTO rag_document_chunks (id, document_id, chunk_index, text, metadata) VALUES (?1, ?2, ?3, ?4, ?5)")
                .map_err(|e| AppError::database(format!("准备写入 rag_document_chunks 语句失败: {}", e)))?;
            for row in rows {
                let metadata = row.metadata_json.as_deref().unwrap_or("{}");
                stmt.execute(rusqlite::params![
                    &row.chunk_id,
                    &row.document_id,
                    &row.chunk_index,
                    &row.text,
                    metadata
                ])
                .map_err(|e| AppError::database(format!("写入 rag_document_chunks 失败: {}", e)))?;
            }
        }
        tx.commit()
            .map_err(|e| AppError::database(format!("提交 rag_document_chunks 事务失败: {}", e)))?;
        Ok(())
    }

    #[cfg(feature = "lance")]
    async fn vector_search_rows(
        &self,
        query_embedding: &[f32],
        top_k: usize,
        sub_library_ids: Option<&[String]>,
        fetch_mul: usize,
        max_cands: usize,
    ) -> Result<Vec<(LanceChunkRow, f32)>> {
        use futures_util::TryStreamExt;

        let dim = query_embedding.len();
        let tbl = self.ensure_wide_table(dim).await?;

        let mut fetch_limit = top_k.saturating_mul(fetch_mul.max(1));
        if fetch_limit < top_k {
            fetch_limit = top_k;
        }
        if max_cands > 0 {
            fetch_limit = fetch_limit.min(max_cands);
        }
        if fetch_limit == 0 {
            fetch_limit = top_k.max(10);
        }

        let vector_start = Instant::now();
        debug!(
            "⏱️ [LanceVector] start dim={} top_k={} fetch_limit={} filters={:?}",
            dim,
            top_k,
            fetch_limit,
            sub_library_ids.map(|v| v.to_vec())
        );

        let filter_expr = sub_library_ids.and_then(Self::build_sub_library_filter);
        let mut query = tbl
            .vector_search(query_embedding)
            .map_err(|e| AppError::database(e.to_string()))?
            .distance_type(DistanceType::Cosine)
            .limit(fetch_limit);
        if let Some(ref expr) = filter_expr {
            query = query.only_if(expr.as_str());
        }
        let mut stream = query
            .execute()
            .await
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut out: Vec<(LanceChunkRow, f32)> = Vec::new();
        let mut batch_counter = 0usize;
        let mut row_counter = 0usize;
        while let Some(batch) = stream
            .try_next()
            .await
            .map_err(|e| AppError::database(e.to_string()))?
        {
            batch_counter += 1;
            row_counter += batch.num_rows();
            let schema = batch.schema();
            let idx_chunk = schema
                .index_of("chunk_id")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_doc = schema
                .index_of("document_id")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_sub = schema.index_of("sub_library_id").ok();
            let idx_index = schema
                .index_of("chunk_index")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_text = schema
                .index_of("text")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_meta = schema.index_of("metadata").ok();
            let idx_created = schema
                .index_of("created_at")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_dist = schema.index_of("_distance").ok();

            let chunk_arr = batch
                .column(idx_chunk)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("chunk_id 列类型错误".to_string()))?;
            let doc_arr = batch
                .column(idx_doc)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("document_id 列类型错误".to_string()))?;
            let sub_arr = idx_sub.and_then(|i| {
                batch
                    .column(i)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .map(|arr| arr as &StringArray)
            });
            let index_arr = batch
                .column(idx_index)
                .as_any()
                .downcast_ref::<Int32Array>()
                .ok_or_else(|| AppError::database("chunk_index 列类型错误".to_string()))?;
            let text_arr = batch
                .column(idx_text)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("text 列类型错误".to_string()))?;
            let meta_arr = idx_meta.and_then(|i| {
                batch
                    .column(i)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .map(|arr| arr as &StringArray)
            });
            let created_arr = batch
                .column(idx_created)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("created_at 列类型错误".to_string()))?;

            let mut dists: Option<Vec<f32>> = None;
            if let Some(idx) = idx_dist {
                let col = batch.column(idx);
                if let Some(arr32) = col.as_any().downcast_ref::<Float32Array>() {
                    dists = Some((0..arr32.len()).map(|j| arr32.value(j)).collect());
                } else if let Some(arr64) = col.as_any().downcast_ref::<arrow_array::Float64Array>()
                {
                    dists = Some((0..arr64.len()).map(|j| arr64.value(j) as f32).collect());
                }
            }

            for i in 0..chunk_arr.len() {
                let chunk_id = chunk_arr.value(i).to_string();
                let document_id = doc_arr.value(i).to_string();
                let sub_library_id = sub_arr.and_then(|arr| {
                    if arr.is_null(i) {
                        None
                    } else {
                        Some(arr.value(i).to_string())
                    }
                });
                let chunk_index = index_arr.value(i);
                let text = text_arr.value(i).to_string();
                let metadata_json = meta_arr.and_then(|arr| {
                    if arr.is_null(i) {
                        None
                    } else {
                        Some(arr.value(i).to_string())
                    }
                });
                let created_at = created_arr.value(i).to_string();
                let dist = dists.as_ref().map(|v| v[i]).unwrap_or(1.0);
                let score = (1.0 - dist).clamp(-1.0, 1.0);

                out.push((
                    LanceChunkRow {
                        chunk_id,
                        document_id,
                        sub_library_id,
                        chunk_index,
                        text,
                        metadata_json,
                        created_at,
                        embedding: Vec::new(),
                    },
                    score,
                ));
            }
        }

        debug!(
            "⏱️ [LanceVector] stream complete batches={} rows={} elapsed={}ms",
            batch_counter,
            row_counter,
            vector_start.elapsed().as_millis()
        );

        if let Some(filters) = sub_library_ids {
            if !filters.is_empty() {
                let set: HashSet<&str> = filters.iter().map(|s| s.as_str()).collect();
                out.retain(|(row, _)| {
                    row.sub_library_id
                        .as_deref()
                        .map(|sub| set.contains(sub))
                        .unwrap_or(false)
                });
            }
        }

        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
        if max_cands > 0 && out.len() > max_cands {
            out.truncate(max_cands);
        }

        Ok(out)
    }

    #[cfg(feature = "lance")]
    async fn hybrid_search_rows(
        &self,
        query_text: &str,
        query_embedding: &[f32],
        top_k: usize,
        sub_library_ids: Option<&[String]>,
        fetch_mul: usize,
        max_cands: usize,
    ) -> Result<Vec<(LanceChunkRow, f32)>> {
        use futures_util::TryStreamExt;

        let dim = query_embedding.len();
        let tbl = self.ensure_wide_table(dim).await?;

        let mut fetch_limit = top_k.saturating_mul(fetch_mul.max(1));
        if fetch_limit < top_k {
            fetch_limit = top_k;
        }
        if max_cands > 0 {
            fetch_limit = fetch_limit.min(max_cands);
        }
        if fetch_limit == 0 {
            fetch_limit = top_k.max(10);
        }

        let hybrid_start = Instant::now();
        debug!(
            "⏱️ [LanceHybrid] start dim={} top_k={} fetch_limit={} filters={:?}",
            dim,
            top_k,
            fetch_limit,
            sub_library_ids.map(|v| v.to_vec())
        );
        let fts_query = FullTextSearchQuery::new(query_text.to_owned());

        let filter_expr = sub_library_ids.and_then(Self::build_sub_library_filter);
        let mut query = tbl
            .query()
            .full_text_search(fts_query)
            .nearest_to(query_embedding.to_vec())
            .map_err(|e| AppError::database(e.to_string()))?
            .distance_type(DistanceType::Cosine)
            .limit(fetch_limit);
        if let Some(ref expr) = filter_expr {
            query = query.only_if(expr.as_str());
        }
        let mut stream = query
            .execute_hybrid(QueryExecutionOptions::default())
            .await
            .map_err(|e| AppError::database(e.to_string()))?;
        debug!(
            "⏱️ [LanceHybrid] execute_hybrid prepared in {}ms",
            hybrid_start.elapsed().as_millis()
        );

        let mut out: Vec<(LanceChunkRow, f32)> = Vec::new();
        let mut batch_counter = 0usize;
        let mut row_counter = 0usize;
        while let Some(batch) = stream
            .try_next()
            .await
            .map_err(|e| AppError::database(e.to_string()))?
        {
            batch_counter += 1;
            row_counter += batch.num_rows();
            let schema = batch.schema();
            let idx_chunk = schema
                .index_of("chunk_id")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_doc = schema
                .index_of("document_id")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_sub = schema.index_of("sub_library_id").ok();
            let idx_index = schema
                .index_of("chunk_index")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_text = schema
                .index_of("text")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_meta = schema.index_of("metadata").ok();
            let idx_created = schema
                .index_of("created_at")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_dist = schema.index_of("_distance").ok();
            let idx_relevance = schema.index_of(LANCE_RELEVANCE_COL).ok();
            let idx_score = schema.index_of(LANCE_FTS_SCORE_COL).ok();

            let chunk_arr = batch
                .column(idx_chunk)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("chunk_id 列类型错误".to_string()))?;
            let doc_arr = batch
                .column(idx_doc)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("document_id 列类型错误".to_string()))?;
            let sub_arr = idx_sub.and_then(|i| {
                batch
                    .column(i)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .map(|arr| arr as &StringArray)
            });
            let index_arr = batch
                .column(idx_index)
                .as_any()
                .downcast_ref::<Int32Array>()
                .ok_or_else(|| AppError::database("chunk_index 列类型错误".to_string()))?;
            let text_arr = batch
                .column(idx_text)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("text 列类型错误".to_string()))?;
            let meta_arr = idx_meta.and_then(|i| {
                batch
                    .column(i)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .map(|arr| arr as &StringArray)
            });
            let created_arr = batch
                .column(idx_created)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("created_at 列类型错误".to_string()))?;

            let mut dists: Option<Vec<f32>> = None;
            if let Some(idx) = idx_dist {
                let col = batch.column(idx);
                if let Some(arr32) = col.as_any().downcast_ref::<Float32Array>() {
                    dists = Some((0..arr32.len()).map(|j| arr32.value(j)).collect());
                } else if let Some(arr64) = col.as_any().downcast_ref::<arrow_array::Float64Array>()
                {
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

            for i in 0..chunk_arr.len() {
                let chunk_id = chunk_arr.value(i).to_string();
                let document_id = doc_arr.value(i).to_string();
                let sub_library_id = sub_arr.and_then(|arr| {
                    if arr.is_null(i) {
                        None
                    } else {
                        Some(arr.value(i).to_string())
                    }
                });
                let chunk_index = index_arr.value(i);
                let text = text_arr.value(i).to_string();
                let metadata_json = meta_arr.and_then(|arr| {
                    if arr.is_null(i) {
                        None
                    } else {
                        Some(arr.value(i).to_string())
                    }
                });
                let created_at = created_arr.value(i).to_string();

                let score = if let Some(ref rel) = relevance_scores {
                    rel[i]
                } else if let Some(ref dist_vec) = dists {
                    (1.0 - dist_vec[i]).clamp(-1.0, 1.0)
                } else if let Some(ref fts_vec) = fts_scores {
                    fts_vec[i]
                } else {
                    0.0
                };

                out.push((
                    LanceChunkRow {
                        chunk_id,
                        document_id,
                        sub_library_id,
                        chunk_index,
                        text,
                        metadata_json,
                        created_at,
                        embedding: Vec::new(),
                    },
                    score,
                ));
            }
        }

        debug!(
            "⏱️ [LanceHybrid] stream complete batches={} rows={} elapsed={}ms",
            batch_counter,
            row_counter,
            hybrid_start.elapsed().as_millis()
        );

        if let Some(filters) = sub_library_ids {
            if !filters.is_empty() {
                let set: HashSet<&str> = filters.iter().map(|s| s.as_str()).collect();
                out.retain(|(row, _)| {
                    row.sub_library_id
                        .as_deref()
                        .map(|sub| set.contains(sub))
                        .unwrap_or(false)
                });
            }
        }

        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
        if max_cands > 0 && out.len() > max_cands {
            out.truncate(max_cands);
        }

        Ok(out)
    }

    #[cfg(feature = "lance")]
    async fn open_existing_chat_tables(&self) -> Result<Vec<Table>> {
        let path = self.get_lance_path()?;
        let db = lancedb::connect(&path)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;
        let mut tables = Vec::new();
        for dim in Self::candidate_dim_values() {
            let table_name = format!("{}{}", CHAT_V2_TABLE_PREFIX, dim);
            if let Ok(tbl) = db.open_table(&table_name).execute().await {
                tables.push(tbl);
            }
        }
        Ok(tables)
    }

    #[cfg(feature = "lance")]
    pub async fn chat_vector_search_rows(
        &self,
        query_embedding: &[f32],
        top_k: usize,
        role_filter: Option<&str>,
        fetch_mul: usize,
        max_cands: usize,
    ) -> Result<Vec<(LanceChatRow, f32)>> {
        use futures_util::TryStreamExt;

        let dim = query_embedding.len();
        let tbl = self.ensure_chat_table(dim).await?;

        let mut fetch_limit = top_k.saturating_mul(fetch_mul.max(1));
        if fetch_limit < top_k {
            fetch_limit = top_k;
        }
        if max_cands > 0 {
            fetch_limit = fetch_limit.min(max_cands);
        }
        if fetch_limit == 0 {
            fetch_limit = top_k.max(10);
        }

        let mut filters: Vec<String> = Vec::new();
        if let Some(role) = role_filter {
            let trimmed = role.trim();
            if !trimmed.is_empty() {
                filters.push(format!("role = '{}'", trimmed.replace("'", "''")));
            }
        }
        let filter_expr = if filters.is_empty() {
            None
        } else {
            Some(filters.join(" AND "))
        };
        let mut query = tbl
            .vector_search(query_embedding)
            .map_err(|e| AppError::database(e.to_string()))?
            .distance_type(DistanceType::Cosine)
            .limit(fetch_limit);
        if let Some(ref expr) = filter_expr {
            query = query.only_if(expr.as_str());
        }
        let mut stream = query
            .execute()
            .await
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut out: Vec<(LanceChatRow, f32)> = Vec::new();
        while let Some(batch) = stream
            .try_next()
            .await
            .map_err(|e| AppError::database(e.to_string()))?
        {
            let schema = batch.schema();
            let idx_message = schema
                .index_of("message_id")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_mistake = schema
                .index_of("mistake_id")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_role = schema
                .index_of("role")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_timestamp = schema
                .index_of("timestamp")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_text = schema
                .index_of("text")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_dist = schema.index_of("_distance").ok();

            let message_arr = batch
                .column(idx_message)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("message_id 列类型错误".to_string()))?;
            let mistake_arr = batch
                .column(idx_mistake)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("mistake_id 列类型错误".to_string()))?;
            let role_arr = batch
                .column(idx_role)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("role 列类型错误".to_string()))?;
            let timestamp_arr = batch
                .column(idx_timestamp)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("timestamp 列类型错误".to_string()))?;
            let text_arr = batch
                .column(idx_text)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("text 列类型错误".to_string()))?;

            let mut dists: Option<Vec<f32>> = None;
            if let Some(idx) = idx_dist {
                let col = batch.column(idx);
                if let Some(arr32) = col.as_any().downcast_ref::<Float32Array>() {
                    dists = Some((0..arr32.len()).map(|j| arr32.value(j)).collect());
                } else if let Some(arr64) = col.as_any().downcast_ref::<arrow_array::Float64Array>()
                {
                    dists = Some((0..arr64.len()).map(|j| arr64.value(j) as f32).collect());
                }
            }

            for i in 0..message_arr.len() {
                let role_value = role_arr.value(i);
                if let Some(filter) = role_filter {
                    if role_value != filter {
                        continue;
                    }
                }

                let dist = dists.as_ref().map(|v| v[i]).unwrap_or(1.0);
                let score = (1.0 - dist).clamp(-1.0, 1.0);

                out.push((
                    LanceChatRow {
                        message_id: message_arr.value(i).to_string(),
                        mistake_id: mistake_arr.value(i).to_string(),
                        role: role_value.to_string(),
                        timestamp: timestamp_arr.value(i).to_string(),
                        text: text_arr.value(i).to_string(),
                        embedding: Vec::new(),
                    },
                    score,
                ));
            }
        }

        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
        if max_cands > 0 && out.len() > max_cands {
            out.truncate(max_cands);
        }

        Ok(out)
    }

    #[cfg(feature = "lance")]
    pub async fn search_chat_fulltext_rows(
        &self,
        query: &str,
        role_filter: Option<&str>,
        limit: usize,
    ) -> Result<Vec<(LanceChatRow, f32)>> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(vec![]);
        }

        let fetch_limit = limit.max(20).saturating_mul(3);
        let mut aggregate: HashMap<String, (LanceChatRow, f32)> = HashMap::new();
        let tables = self.open_existing_chat_tables().await?;
        if tables.is_empty() {
            return Ok(vec![]);
        }

        use futures_util::TryStreamExt;

        for tbl in tables {
            let mut builder = tbl.query();
            let mut filters: Vec<String> = Vec::new();
            if let Some(role) = role_filter {
                if !role.trim().is_empty() {
                    filters.push(format!("role = '{}'", role.replace("'", "''")));
                }
            }
            if !filters.is_empty() {
                let expr = filters.join(" AND ");
                builder = builder.only_if(expr.as_str());
            }

            let mut stream = builder
                .full_text_search(FullTextSearchQuery::new(trimmed.to_owned()))
                .limit(fetch_limit)
                .execute()
                .await
                .map_err(|e| AppError::database(e.to_string()))?;

            while let Some(batch) = stream
                .try_next()
                .await
                .map_err(|e| AppError::database(e.to_string()))?
            {
                let schema = batch.schema();
                let idx_message = schema
                    .index_of("message_id")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let idx_mistake = schema
                    .index_of("mistake_id")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let idx_role = schema
                    .index_of("role")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let idx_timestamp = schema
                    .index_of("timestamp")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let idx_text = schema
                    .index_of("text")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let idx_score = schema.index_of(LANCE_FTS_SCORE_COL).ok();

                let message_arr = batch
                    .column(idx_message)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| AppError::database("message_id 列类型错误".to_string()))?;
                let mistake_arr = batch
                    .column(idx_mistake)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| AppError::database("mistake_id 列类型错误".to_string()))?;
                let role_arr = batch
                    .column(idx_role)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| AppError::database("role 列类型错误".to_string()))?;
                let timestamp_arr = batch
                    .column(idx_timestamp)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| AppError::database("timestamp 列类型错误".to_string()))?;
                let text_arr = batch
                    .column(idx_text)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| AppError::database("text 列类型错误".to_string()))?;

                let mut score_vec: Option<Vec<f32>> = None;
                if let Some(idx) = idx_score {
                    if let Some(arr) = batch.column(idx).as_any().downcast_ref::<Float32Array>() {
                        score_vec = Some((0..arr.len()).map(|j| arr.value(j)).collect());
                    }
                }

                for row_idx in 0..message_arr.len() {
                    let message_id = message_arr.value(row_idx).to_string();

                    let score = score_vec
                        .as_ref()
                        .map(|scores| scores[row_idx])
                        .unwrap_or(1.0);

                    let row = LanceChatRow {
                        message_id: message_id.clone(),
                        mistake_id: mistake_arr.value(row_idx).to_string(),
                        role: role_arr.value(row_idx).to_string(),
                        timestamp: timestamp_arr.value(row_idx).to_string(),
                        text: text_arr.value(row_idx).to_string(),
                        embedding: Vec::new(),
                    };

                    match aggregate.entry(message_id) {
                        std::collections::hash_map::Entry::Occupied(mut entry) => {
                            if score > entry.get().1 {
                                entry.insert((row, score));
                            }
                        }
                        std::collections::hash_map::Entry::Vacant(entry) => {
                            entry.insert((row, score));
                        }
                    }
                }
            }
        }

        let mut results: Vec<(LanceChatRow, f32)> = aggregate.into_values().collect();
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
        if results.len() > limit {
            results.truncate(limit);
        }
        Ok(results)
    }

    #[cfg(feature = "lance")]
    pub async fn existing_chat_message_ids(&self, ids: &[String]) -> Result<HashSet<String>> {
        use futures_util::TryStreamExt;

        if ids.is_empty() {
            return Ok(HashSet::new());
        }

        let mut existing: HashSet<String> = HashSet::new();
        let tables = self.open_existing_chat_tables().await?;
        if tables.is_empty() {
            return Ok(existing);
        }

        for tbl in tables {
            for chunk in ids.chunks(900) {
                if chunk.is_empty() {
                    continue;
                }
                let in_list = chunk
                    .iter()
                    .map(|id| format!("'{}'", id.replace("'", "''")))
                    .collect::<Vec<_>>()
                    .join(",");
                if in_list.is_empty() {
                    continue;
                }
                let filter = format!("message_id IN ({})", in_list);
                let mut stream = tbl
                    .query()
                    .only_if(filter.as_str())
                    .limit(chunk.len())
                    .execute()
                    .await
                    .map_err(|e| AppError::database(e.to_string()))?;
                while let Some(batch) = stream
                    .try_next()
                    .await
                    .map_err(|e| AppError::database(e.to_string()))?
                {
                    let idx = batch
                        .schema()
                        .index_of("message_id")
                        .map_err(|e| AppError::database(e.to_string()))?;
                    let arr = batch
                        .column(idx)
                        .as_any()
                        .downcast_ref::<StringArray>()
                        .ok_or_else(|| AppError::database("message_id 列类型错误".to_string()))?;
                    for i in 0..arr.len() {
                        existing.insert(arr.value(i).to_string());
                    }
                }
            }
        }
        Ok(existing)
    }

    #[cfg(feature = "lance")]
    pub async fn count_chat_embeddings(&self) -> Result<usize> {
        let path = self.get_lance_path()?;
        let db = lancedb::connect(&path)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;
        let mut total = 0usize;
        for dim in Self::candidate_dim_values() {
            let table_name = format!("{}{}", CHAT_V2_TABLE_PREFIX, dim);
            let tbl = match db.open_table(&table_name).execute().await {
                Ok(tbl) => tbl,
                Err(_) => continue,
            };
            let count = tbl
                .count_rows(None::<String>)
                .await
                .map_err(|e| AppError::database(e.to_string()))?;
            total += count;
        }
        Ok(total)
    }

    #[cfg(feature = "lance")]
    pub async fn list_all_chat_message_ids(&self) -> Result<HashSet<String>> {
        use futures_util::TryStreamExt;

        let path = self.get_lance_path()?;
        let db = lancedb::connect(&path)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;

        let mut all_ids: HashSet<String> = HashSet::new();
        for dim in Self::candidate_dim_values() {
            let table_name = format!("{}{}", CHAT_V2_TABLE_PREFIX, dim);
            let tbl = match db.open_table(&table_name).execute().await {
                Ok(tbl) => tbl,
                Err(_) => continue,
            };

            let mut stream = tbl
                .query()
                .execute()
                .await
                .map_err(|e| AppError::database(e.to_string()))?;

            while let Some(batch) = stream
                .try_next()
                .await
                .map_err(|e| AppError::database(e.to_string()))?
            {
                let schema = batch.schema();
                let idx = schema
                    .index_of("message_id")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let arr = batch
                    .column(idx)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| AppError::database("message_id 列类型错误".to_string()))?;
                for i in 0..arr.len() {
                    all_ids.insert(arr.value(i).to_string());
                }
            }
        }

        Ok(all_ids)
    }
    #[cfg(feature = "lance")]
    fn rows_to_retrieved(
        &self,
        rows: Vec<(LanceChunkRow, f32)>,
        top_k: usize,
        per_doc_cap: usize,
    ) -> Result<Vec<RetrievedChunk>> {
        let mut rows = rows;
        rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));

        let mut doc_revision_map: HashMap<String, String> = HashMap::new();
        let mut per_doc_counts: HashMap<String, usize> = HashMap::new();
        let mut out: Vec<RetrievedChunk> = Vec::with_capacity(top_k);

        for (row, score) in rows.into_iter() {
            let doc_id = row.document_id.clone();
            let active_revision = if let Some(rev) = doc_revision_map.get(&doc_id) {
                rev.clone()
            } else {
                use rusqlite::OptionalExtension;
                let fetch_revision = || -> Result<String> {
                    let conn = self
                        .database
                        .get_conn_safe()
                        .map_err(|e| AppError::database(e.to_string()))?;
                    let stmt =
                        conn.prepare("SELECT active_revision FROM rag_documents WHERE id = ?1");
                    match stmt {
                        Ok(mut stmt) => {
                            let rev: Option<String> = stmt
                                .query_row(rusqlite::params![&doc_id], |row| row.get(0))
                                .optional()
                                .map_err(|e| AppError::database(e.to_string()))?;
                            Ok(rev.unwrap_or_else(|| "A".to_string()))
                        }
                        Err(err) => {
                            if err.to_string().contains("no such table") {
                                return Ok("A".to_string());
                            }
                            Err(AppError::database(err.to_string()))
                        }
                    }
                };
                let normalized = fetch_revision()?;
                doc_revision_map.insert(doc_id.clone(), normalized.clone());
                normalized
            };

            let row_revision = row
                .metadata_json
                .as_ref()
                .and_then(|s| serde_json::from_str::<HashMap<String, String>>(s).ok())
                .and_then(|m| m.get("revision").cloned());

            if let Some(rev) = row_revision {
                if rev != active_revision {
                    continue;
                }
            }

            if per_doc_cap > 0 {
                let entry = per_doc_counts.entry(doc_id.clone()).or_insert(0);
                if (*entry) >= per_doc_cap {
                    continue;
                }
                *entry += 1;
            }

            let metadata_map: HashMap<String, String> = row
                .metadata_json
                .as_ref()
                .and_then(|s| serde_json::from_str::<HashMap<String, String>>(s).ok())
                .unwrap_or_default();

            let chunk = DocumentChunk {
                id: row.chunk_id,
                document_id: doc_id,
                chunk_index: row.chunk_index.max(0) as usize,
                text: row.text,
                metadata: metadata_map,
            };

            out.push(RetrievedChunk { chunk, score });
            if out.len() >= top_k {
                break;
            }
        }

        Ok(out)
    }

    #[cfg(feature = "lance")]
    async fn ensure_chat_table(&self, dim: usize) -> Result<Table> {
        let path = self.get_lance_path()?;
        let db = lancedb::connect(&path)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;
        let table_name = format!("{}{}", CHAT_V2_TABLE_PREFIX, dim);
        let tbl = if let Ok(tbl) = db.open_table(&table_name).execute().await {
            tbl
        } else {
            let schema = arrow_schema::Schema::new(vec![
                arrow_schema::Field::new("message_id", arrow_schema::DataType::Utf8, false),
                arrow_schema::Field::new("mistake_id", arrow_schema::DataType::Utf8, false),
                arrow_schema::Field::new("role", arrow_schema::DataType::Utf8, false),
                arrow_schema::Field::new("timestamp", arrow_schema::DataType::Utf8, false),
                arrow_schema::Field::new("text", arrow_schema::DataType::Utf8, false),
                arrow_schema::Field::new(
                    "embedding",
                    arrow_schema::DataType::FixedSizeList(
                        Arc::new(arrow_schema::Field::new(
                            "item",
                            arrow_schema::DataType::Float32,
                            false,
                        )),
                        dim as i32,
                    ),
                    false,
                ),
            ]);
            let empty: Vec<std::result::Result<RecordBatch, arrow_schema::ArrowError>> = Vec::new();
            let iter = RecordBatchIterator::new(empty.into_iter(), Arc::new(schema.clone()));
            db.create_table(&table_name, iter)
                .execute()
                .await
                .map_err(|e| AppError::database(format!("创建 Lance 表失败: {}", e)))?
        };
        let _ = tbl
            .create_index(&["embedding"], Index::Auto)
            .replace(false)
            .execute()
            .await;
        let fts_builder = self.build_fts_index_builder();
        let rebuild_fts = self.should_rebuild_fts(&table_name, CHAT_FTS_VERSION);
        let fts_res = tbl
            .create_index(&["text"], Index::FTS(fts_builder))
            .replace(rebuild_fts)
            .execute()
            .await;
        match fts_res {
            Ok(_) => self.record_fts_version(&table_name, CHAT_FTS_VERSION),
            Err(err) => {
                let msg = err.to_string();
                if msg.contains("already exists") && !rebuild_fts {
                    self.record_fts_version(&table_name, CHAT_FTS_VERSION);
                } else {
                    warn!(
                        "⚠️ [LanceIndex] 聊天 FTS 索引确保失败 {}: {}",
                        table_name, msg
                    );
                }
            }
        }
        Ok(tbl)
    }

    #[cfg(feature = "lance")]
    pub async fn upsert_chat_embeddings_batch(&self, rows: &[LanceChatRow]) -> Result<usize> {
        if rows.is_empty() {
            return Ok(0);
        }
        let dim = rows[0].embedding.len();
        let tbl = self.ensure_chat_table(dim).await?;
        let mut sanitized: Vec<String> = Vec::with_capacity(rows.len());
        for row in rows.iter() {
            sanitized.push(row.message_id.replace("'", "''"));
        }
        for chunk in sanitized.chunks(900) {
            if chunk.is_empty() {
                continue;
            }
            let expr = format!(
                "message_id IN ({})",
                chunk
                    .iter()
                    .map(|id| format!("'{}'", id))
                    .collect::<Vec<_>>()
                    .join(",")
            );
            let _ = tbl.delete(expr.as_str()).await;
        }
        let (schema, batch) = self.build_batch_embeddings_chat(dim, rows)?;
        let iter = RecordBatchIterator::new(vec![Ok(batch)].into_iter(), schema);
        tbl.add(iter)
            .execute()
            .await
            .map_err(|e| AppError::database(e.to_string()))?;
        Ok(rows.len())
    }

    #[cfg(feature = "lance")]
    pub async fn delete_chat_embeddings_by_ids(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        let tables = self.open_existing_chat_tables().await?;
        if tables.is_empty() {
            return Ok(());
        }

        let mut batches: Vec<Vec<String>> = Vec::new();
        for chunk in ids.chunks(900) {
            batches.push(
                chunk
                    .iter()
                    .map(|id| id.replace("'", "''"))
                    .collect::<Vec<_>>(),
            );
        }

        for tbl in tables.iter() {
            for batch_ids in batches.iter() {
                if batch_ids.is_empty() {
                    continue;
                }
                let expr = format!(
                    "message_id IN ({})",
                    batch_ids
                        .iter()
                        .map(|id| format!("'{}'", id))
                        .collect::<Vec<_>>()
                        .join(","),
                );
                let _ = tbl.delete(expr.as_str()).await;
            }
        }
        Ok(())
    }

    #[cfg(feature = "lance")]
    pub async fn knn_chat_ids_via_lance(
        &self,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<(String, f32)>> {
        use futures_util::TryStreamExt;
        let fetch_limit: usize = std::cmp::max(1, limit).saturating_mul(10);
        let tbl = self.ensure_chat_table(query_embedding.len()).await?;
        let mut stream = tbl
            .vector_search(query_embedding)
            .map_err(|e| AppError::database(e.to_string()))?
            .distance_type(DistanceType::Cosine)
            .limit(fetch_limit)
            .execute()
            .await
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut out: Vec<(String, f32)> = Vec::with_capacity(limit);
        while let Some(batch) = stream
            .try_next()
            .await
            .map_err(|e| AppError::database(e.to_string()))?
        {
            let schema = batch.schema();
            let idx_id = schema
                .index_of("message_id")
                .map_err(|e| AppError::database(e.to_string()))?;
            let id_arr = batch
                .column(idx_id)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("message_id 列类型错误".to_string()))?;
            let idx_dist = schema.index_of("_distance").ok();
            let mut dists: Option<Vec<f32>> = None;
            if let Some(i) = idx_dist {
                let col = batch.column(i);
                if let Some(a32) = col.as_any().downcast_ref::<Float32Array>() {
                    dists = Some((0..a32.len()).map(|j| a32.value(j)).collect());
                } else if let Some(a64) = col.as_any().downcast_ref::<arrow_array::Float64Array>() {
                    dists = Some((0..a64.len()).map(|j| a64.value(j) as f32).collect());
                }
            }
            let rows = id_arr.len();
            for i in 0..rows {
                let dist = dists.as_ref().map(|v| v[i]).unwrap_or(1.0);
                let sim = (1.0 - dist).clamp(-1.0, 1.0);
                out.push((id_arr.value(i).to_string(), sim));
                if out.len() >= limit {
                    break;
                }
            }
            if out.len() >= limit {
                break;
            }
        }
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        if out.len() > limit {
            out.truncate(limit);
        }
        Ok(out)
    }

    #[cfg(feature = "lance")]
    fn extract_chunk_ids(batch: &RecordBatch) -> Result<Vec<String>> {
        let idx = batch
            .schema()
            .index_of("chunk_id")
            .map_err(|e| AppError::database(e.to_string()))?;
        let col = batch.column(idx);
        let arr = col
            .as_any()
            .downcast_ref::<StringArray>()
            .ok_or_else(|| AppError::database("chunk_id 列类型错误".to_string()))?;
        let mut out = Vec::with_capacity(arr.len());
        for i in 0..arr.len() {
            out.push(arr.value(i).to_string());
        }
        Ok(out)
    }

    #[cfg(feature = "lance")]
    fn load_rrf_config(&self) -> (f32, f32, f32, usize, usize, usize, usize, usize) {
        // Defaults
        let mut rrf_k: f32 = 60.0;
        let mut w_fts: f32 = 1.0;
        let mut w_vec: f32 = 1.0;
        let mut fts_mul: usize = 20;
        let mut vec_mul: usize = 3;
        let mut max_cands: usize = 1000;
        let mut per_doc_cap: usize = 2;
        let mut fetch_mul: usize = 3;

        let get = |key: &str| self.database.get_setting(key).ok().flatten();
        if let Some(v) = get("rag.hybrid.rrf.k").and_then(|s| s.parse::<f32>().ok()) {
            if v > 0.0 {
                rrf_k = v;
            }
        }
        if let Some(v) = get("rag.hybrid.rrf.fts_weight").and_then(|s| s.parse::<f32>().ok()) {
            if v > 0.0 {
                w_fts = v;
            }
        }
        if let Some(v) = get("rag.hybrid.rrf.vec_weight").and_then(|s| s.parse::<f32>().ok()) {
            if v > 0.0 {
                w_vec = v;
            }
        }
        if let Some(v) =
            get("rag.hybrid.fts.limit_multiplier").and_then(|s| s.parse::<usize>().ok())
        {
            if v >= 1 {
                fts_mul = v;
            }
        }
        if let Some(v) =
            get("rag.hybrid.vec.limit_multiplier").and_then(|s| s.parse::<usize>().ok())
        {
            if v >= 1 {
                vec_mul = v;
            }
        }
        if let Some(v) = get("rag.hybrid.max_candidates").and_then(|s| s.parse::<usize>().ok()) {
            if v >= 50 {
                max_cands = v;
            }
        }
        if let Some(v) = get("rag.hybrid.per_doc_cap").and_then(|s| s.parse::<usize>().ok()) {
            if v >= 1 {
                per_doc_cap = v;
            }
        }
        if let Some(v) =
            get("rag.hybrid.fetch_limit_multiplier").and_then(|s| s.parse::<usize>().ok())
        {
            if v >= 1 {
                fetch_mul = v;
            }
        }
        (
            rrf_k,
            w_fts,
            w_vec,
            fts_mul,
            vec_mul,
            max_cands,
            per_doc_cap,
            fetch_mul,
        )
    }
}

impl LanceVectorStore {
    #[cfg(feature = "lance")]
    fn ensure_base_rag_schema(&self) -> Result<()> {
        use rusqlite::params;
        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS rag_sub_libraries (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                description TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )",
            [],
        )
        .map_err(|e| AppError::database(format!("创建分库表失败: {}", e)))?;

        let default_exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM rag_sub_libraries WHERE id='default')",
                [],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !default_exists {
            let now = chrono::Utc::now().to_rfc3339();
            let _ = conn.execute(
                "INSERT OR IGNORE INTO rag_sub_libraries (id, name, description, created_at, updated_at) VALUES ('default','default','默认知识库',?1,?1)",
                params![now],
            );
        }

        conn.execute(
            "CREATE TABLE IF NOT EXISTS rag_documents (
                id TEXT PRIMARY KEY,
                file_name TEXT NOT NULL,
                file_path TEXT,
                file_size INTEGER,
                content_type TEXT,
                total_chunks INTEGER DEFAULT 0,
                sub_library_id TEXT NOT NULL DEFAULT 'default',
                update_state TEXT NOT NULL DEFAULT 'ready',
                desired_hash TEXT,
                update_retry INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (sub_library_id) REFERENCES rag_sub_libraries (id) ON DELETE SET DEFAULT
            )",
            [],
        )
        .map_err(|e| AppError::database(format!("创建文档表失败: {}", e)))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS rag_document_chunks (
                id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL REFERENCES rag_documents(id) ON DELETE CASCADE,
                chunk_index INTEGER NOT NULL,
                text TEXT NOT NULL,
                metadata TEXT NOT NULL DEFAULT '{}'
            )",
            [],
        )
        .map_err(|e| AppError::database(format!("创建文档分块表失败: {}", e)))?;

        if let Err(e) = conn.execute(
            "ALTER TABLE rag_document_chunks ADD COLUMN metadata TEXT NOT NULL DEFAULT '{}'",
            [],
        ) {
            if !e.to_string().contains("duplicate column name") {
                return Err(AppError::database(format!(
                    "补齐 rag_document_chunks.metadata 列失败: {}",
                    e
                )));
            }
        }

        if let Err(e) = conn.execute(
            "ALTER TABLE rag_document_chunks ADD COLUMN chunk_index INTEGER NOT NULL DEFAULT 0",
            [],
        ) {
            if !e.to_string().contains("duplicate column name") {
                return Err(AppError::database(format!(
                    "补齐 rag_document_chunks.chunk_index 列失败: {}",
                    e
                )));
            }
        }

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rag_document_chunks_document ON rag_document_chunks(document_id)",
            [],
        )
        .map_err(|e| AppError::database(format!("创建文档分块索引失败: {}", e)))?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rag_document_chunks_doc_chunk ON rag_document_chunks(document_id, chunk_index)",
            [],
        )
        .map_err(|e| AppError::database(format!("创建文档分块序索引失败: {}", e)))?;

        conn.execute(
            "CREATE TABLE IF NOT EXISTS rag_vectors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chunk_id TEXT NOT NULL REFERENCES rag_document_chunks(id) ON DELETE CASCADE,
                dimension INTEGER NOT NULL DEFAULT 0,
                embedding BLOB NOT NULL
            )",
            [],
        )
        .map_err(|e| AppError::database(format!("创建向量表失败: {}", e)))?;

        if let Err(e) = conn.execute(
            "ALTER TABLE rag_vectors ADD COLUMN dimension INTEGER NOT NULL DEFAULT 0",
            [],
        ) {
            if !e.to_string().contains("duplicate column name") {
                return Err(AppError::database(format!(
                    "补齐 rag_vectors.dimension 列失败: {}",
                    e
                )));
            }
        }

        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rag_vectors_chunk ON rag_vectors(chunk_id)",
            [],
        )
        .map_err(|e| AppError::database(format!("创建向量块索引失败: {}", e)))?;
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rag_vectors_dimension ON rag_vectors(dimension)",
            [],
        )
        .map_err(|e| AppError::database(format!("创建向量维度索引失败: {}", e)))?;

        let _ = conn.prepare("SELECT sub_library_id FROM rag_documents LIMIT 1");
        let _ = conn.execute(
            "ALTER TABLE rag_documents ADD COLUMN sub_library_id TEXT NOT NULL DEFAULT 'default'",
            [],
        );
        let _ = conn.prepare("SELECT update_state FROM rag_documents LIMIT 1");
        let _ = conn.execute(
            "ALTER TABLE rag_documents ADD COLUMN update_state TEXT NOT NULL DEFAULT 'ready'",
            [],
        );
        let _ = conn.prepare("SELECT desired_hash FROM rag_documents LIMIT 1");
        let _ = conn.execute("ALTER TABLE rag_documents ADD COLUMN desired_hash TEXT", []);
        let _ = conn.prepare("SELECT update_retry FROM rag_documents LIMIT 1");
        let _ = conn.execute(
            "ALTER TABLE rag_documents ADD COLUMN update_retry INTEGER NOT NULL DEFAULT 0",
            [],
        );
        let _ = conn.prepare("SELECT active_revision FROM rag_documents LIMIT 1");
        let _ = conn.execute(
            "ALTER TABLE rag_documents ADD COLUMN active_revision TEXT NOT NULL DEFAULT 'A'",
            [],
        );

        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rag_documents_sub_library ON rag_documents(sub_library_id)",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_rag_sub_libraries_name ON rag_sub_libraries(name)",
            [],
        );

        // 静默确认，避免日志风暴
        Ok(())
    }
}
#[async_trait]
impl VectorStore for LanceVectorStore {
    async fn add_chunks(&self, chunks: Vec<DocumentChunkWithEmbedding>) -> Result<()> {
        {
            if chunks.is_empty() {
                return Ok(());
            }
            let dim = chunks[0].embedding.len();
            if dim == 0 {
                return Err(AppError::validation("embedding 维度不可为 0"));
            }
            if let Some(bad) = chunks.iter().find(|c| c.embedding.len() != dim) {
                return Err(AppError::validation(format!(
                    "检测到不一致的 embedding 维度: {} vs {}",
                    bad.embedding.len(),
                    dim
                )));
            }

            // 预先拉取文档对应的分库，复用 SQLite 文档元数据表
            let mut doc_ids: std::collections::HashSet<String> =
                std::collections::HashSet::with_capacity(chunks.len());
            for ch in &chunks {
                doc_ids.insert(ch.chunk.document_id.clone());
            }
            let mut sublib_map: std::collections::HashMap<String, Option<String>> =
                std::collections::HashMap::new();
            if !doc_ids.is_empty() {
                let conn = self
                    .database
                    .get_conn_safe()
                    .map_err(|e| AppError::database(e.to_string()))?;
                let placeholders = (0..doc_ids.len())
                    .map(|_| "?")
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT id, sub_library_id FROM rag_documents WHERE id IN ({})",
                    placeholders
                );
                let mut stmt = conn
                    .prepare(&sql)
                    .map_err(|e| AppError::database(e.to_string()))?;
                let params = rusqlite::params_from_iter(
                    doc_ids
                        .iter()
                        .map(|s| rusqlite::types::Value::Text(s.clone())),
                );
                let rows = stmt
                    .query_map(params, |row| {
                        let id: String = row.get(0)?;
                        let sub: String = row.get(1)?;
                        Ok((id, sub))
                    })
                    .map_err(|e| AppError::database(e.to_string()))?;
                for r in rows {
                    let (id, sub) = r.map_err(|e| AppError::database(e.to_string()))?;
                    sublib_map.insert(id, Some(sub));
                }
            }

            let created_at = chrono::Utc::now().to_rfc3339();
            let mut rows: Vec<LanceChunkRow> = Vec::with_capacity(chunks.len());
            for chunk_with_embedding in chunks.into_iter() {
                let DocumentChunkWithEmbedding { chunk, embedding } = chunk_with_embedding;
                let DocumentChunk {
                    id,
                    document_id,
                    chunk_index,
                    text,
                    metadata,
                } = chunk;

                let sub = sublib_map.get(&document_id).cloned().unwrap_or(None);
                self.emb_cache.insert(
                    id.clone(),
                    (embedding.clone(), document_id.clone(), sub.clone()),
                );
                self.enforce_cache_cap();

                let metadata_json = if metadata.is_empty() {
                    None
                } else {
                    Some(
                        serde_json::to_string(&metadata)
                            .map_err(|e| AppError::database(e.to_string()))?,
                    )
                };

                rows.push(LanceChunkRow {
                    chunk_id: id,
                    document_id,
                    sub_library_id: sub,
                    chunk_index: chunk_index as i32,
                    text,
                    metadata_json,
                    created_at: created_at.clone(),
                    embedding,
                });
            }

            self.write_chunks_to_sqlite(&rows)?;
            self.write_chunks_to_wide_table(dim, &rows).await?;
            Ok(())
        }
    }

    async fn search_similar_chunks(
        &self,
        query_embedding: Vec<f32>,
        top_k: usize,
    ) -> Result<Vec<RetrievedChunk>> {
        {
            let (_, _, _, _, vec_mul, max_cands, per_doc_cap, _) = self.load_rrf_config();
            let rows = self
                .vector_search_rows(&query_embedding, top_k, None, vec_mul, max_cands)
                .await?;
            self.rows_to_retrieved(rows, top_k, per_doc_cap)
        }
    }

    async fn search_similar_chunks_in_libraries(
        &self,
        query_embedding: Vec<f32>,
        top_k: usize,
        sub_library_ids: Option<Vec<String>>,
    ) -> Result<Vec<RetrievedChunk>> {
        {
            let (_, _, _, _, vec_mul, max_cands, per_doc_cap, _) = self.load_rrf_config();
            let rows = self
                .vector_search_rows(
                    &query_embedding,
                    top_k,
                    sub_library_ids.as_ref().map(|v| v.as_slice()),
                    vec_mul,
                    max_cands,
                )
                .await?;
            self.rows_to_retrieved(rows, top_k, per_doc_cap)
        }
    }

    async fn search_similar_chunks_with_prefilter(
        &self,
        query_text: &str,
        query_embedding: Vec<f32>,
        top_k: usize,
    ) -> Result<Vec<RetrievedChunk>> {
        {
            self.search_similar_chunks_in_libraries_with_prefilter(
                query_text,
                query_embedding,
                top_k,
                None,
            )
            .await
        }
    }

    async fn search_similar_chunks_in_libraries_with_prefilter(
        &self,
        query_text: &str,
        query_embedding: Vec<f32>,
        top_k: usize,
        sub_library_ids: Option<Vec<String>>,
    ) -> Result<Vec<RetrievedChunk>> {
        {
            let fts_prefilter_enabled = self
                .database
                .get_setting("rag.hybrid.fts_prefilter.enabled")
                .ok()
                .flatten()
                .map(|v| v != "0")
                .unwrap_or(true);
            if !fts_prefilter_enabled {
                info!(
                    "🔧 [RAG] 已禁用 FTS 预筛，直接执行向量检索 (top_k={} 分库={:?})",
                    top_k, sub_library_ids
                );
                return self
                    .search_similar_chunks_in_libraries(query_embedding, top_k, sub_library_ids)
                    .await;
            }

            let trimmed = query_text.trim();
            if trimmed.is_empty() {
                return self
                    .search_similar_chunks_in_libraries(query_embedding, top_k, sub_library_ids)
                    .await;
            }

            let (_, _, _, fts_mul, vec_mul, max_cands, per_doc_cap, fetch_mul) =
                self.load_rrf_config();
            let effective_mul = std::cmp::max(vec_mul, std::cmp::max(fts_mul, fetch_mul));
            let sub_slice = sub_library_ids.as_ref().map(|v| v.as_slice());

            let rows = match self
                .hybrid_search_rows(
                    trimmed,
                    &query_embedding,
                    top_k,
                    sub_slice,
                    effective_mul,
                    max_cands,
                )
                .await
            {
                Ok(rows) => rows,
                Err(err) => {
                    warn!("⚠️ [RAG] Lance 混合检索失败，回退向量检索: {}", err);
                    self.vector_search_rows(&query_embedding, top_k, sub_slice, vec_mul, max_cands)
                        .await?
                }
            };

            if rows.is_empty() {
                warn!("ℹ️ Lance 混合检索返回空结果，回退向量检索");
                let fallback_rows = self
                    .vector_search_rows(&query_embedding, top_k, sub_slice, vec_mul, max_cands)
                    .await?;
                return self.rows_to_retrieved(fallback_rows, top_k, per_doc_cap);
            }

            self.rows_to_retrieved(rows, top_k, per_doc_cap)
        }
    }

    async fn delete_chunks_by_document_id(&self, document_id: &str) -> Result<()> {
        {
            let chunks = self.load_document_chunks(document_id).await?;
            let chunk_ids: Vec<String> = chunks.into_iter().map(|c| c.id).collect();
            if !chunk_ids.is_empty() {
                self.delete_chunks_by_ids(chunk_ids).await?;
            }

            let conn = self
                .database
                .get_conn_safe()
                .map_err(|e| AppError::database(e.to_string()))?;
            if let Err(err) = conn.execute(
                "DELETE FROM rag_document_chunks WHERE document_id = ?1",
                rusqlite::params![document_id],
            ) {
                warn!(
                    "⚠️ [SQLite] 删除旧 rag_document_chunks 记录失败 ({}): {}",
                    document_id, err
                );
            }
            conn.execute(
                "DELETE FROM rag_documents WHERE id = ?1",
                rusqlite::params![document_id],
            )
            .map_err(|e| AppError::database(e.to_string()))?;
            Ok(())
        }
    }

    async fn clear_document_chunks_keep_header(&self, document_id: &str) -> Result<()> {
        {
            let chunks = self.load_document_chunks(document_id).await?;
            let chunk_ids: Vec<String> = chunks.into_iter().map(|c| c.id).collect();
            if !chunk_ids.is_empty() {
                self.delete_chunks_by_ids(chunk_ids).await?;
            }

            let conn = self
                .database
                .get_conn_safe()
                .map_err(|e| AppError::database(e.to_string()))?;
            if let Err(err) = conn.execute(
                "DELETE FROM rag_document_chunks WHERE document_id = ?1",
                rusqlite::params![document_id],
            ) {
                warn!(
                    "⚠️ [SQLite] 删除旧 rag_document_chunks 记录失败 ({}): {}",
                    document_id, err
                );
            }
            Ok(())
        }
    }

    async fn delete_chunks_by_ids(&self, chunk_ids: Vec<String>) -> Result<()> {
        {
            if chunk_ids.is_empty() {
                return Ok(());
            }

            let path = self.get_lance_path()?;
            let db = lancedb::connect(&path)
                .execute()
                .await
                .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;

            let delete_batches: Vec<Vec<String>> = chunk_ids
                .chunks(900)
                .map(|batch| batch.iter().map(|id| id.replace("'", "''")).collect())
                .collect();

            for dim in Self::candidate_dim_values() {
                let wide_name = format!("{}{}", KB_V2_TABLE_PREFIX, dim);
                if let Ok(tbl) = db.open_table(&wide_name).execute().await {
                    for ids in &delete_batches {
                        let expr = format!(
                            "chunk_id IN ({})",
                            ids.iter()
                                .map(|s| format!("'{}'", s))
                                .collect::<Vec<_>>()
                                .join(",")
                        );
                        let _ = tbl.delete(expr.as_str()).await;
                    }
                }
            }

            for cid in chunk_ids {
                let _ = self.emb_cache.remove(&cid);
            }
            Ok(())
        }
    }

    async fn load_document_chunks(&self, document_id: &str) -> Result<Vec<DocumentChunk>> {
        #[cfg(feature = "lance")]
        {
            use futures_util::TryStreamExt;
            use std::collections::HashMap;

            let path = self.get_lance_path()?;
            let db = lancedb::connect(&path)
                .execute()
                .await
                .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;

            let filter_expr = format!("document_id = '{}'", document_id.replace("'", "''"));
            let mut chunk_rows: Vec<LanceChunkRow> = Vec::new();

            for dim in Self::candidate_dim_values() {
                let table_name = format!("{}{}", KB_V2_TABLE_PREFIX, dim);
                let tbl = match db.open_table(&table_name).execute().await {
                    Ok(tbl) => tbl,
                    Err(_) => continue,
                };

                let mut query = tbl.query();
                query = query.only_if(filter_expr.as_str());
                let mut stream = query
                    .execute()
                    .await
                    .map_err(|e| AppError::database(e.to_string()))?;

                while let Some(batch) = stream
                    .try_next()
                    .await
                    .map_err(|e| AppError::database(e.to_string()))?
                {
                    let rows = Self::extract_chunk_rows_from_batch(&batch)?;
                    if !rows.is_empty() {
                        chunk_rows.extend(rows);
                    }
                }

                if !chunk_rows.is_empty() {
                    break;
                }
            }

            if chunk_rows.is_empty() {
                return Ok(Vec::new());
            }

            chunk_rows.sort_by(|a, b| a.chunk_index.cmp(&b.chunk_index));

            let mut chunks: Vec<DocumentChunk> = Vec::with_capacity(chunk_rows.len());
            for row in chunk_rows.into_iter() {
                let metadata: HashMap<String, String> = row
                    .metadata_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str::<HashMap<String, String>>(s).ok())
                    .unwrap_or_default();
                chunks.push(DocumentChunk {
                    id: row.chunk_id,
                    document_id: row.document_id,
                    chunk_index: row.chunk_index.max(0) as usize,
                    text: row.text,
                    metadata,
                });
            }

            Ok(chunks)
        }
    }

    async fn get_stats(&self) -> Result<VectorStoreStats> {
        // 先读取 SQLite 统计，再异步读取 Lance 统计，避免跨 await 持锁
        let total_documents: usize = {
            let conn = self
                .database
                .get_conn_safe()
                .map_err(|e| AppError::database(e.to_string()))?;
            let count = conn
                .query_row("SELECT COUNT(*) FROM rag_documents", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap_or(0) as usize;
            count
        };

        let summary = self.summarize_library(None).await?;
        let storage = summary.text_bytes.saturating_add(summary.embedding_bytes) as u64;
        Ok(VectorStoreStats {
            total_documents,
            total_chunks: summary.chunk_count,
            storage_size_bytes: storage,
        })
    }

    async fn clear_all(&self) -> Result<()> {
        {
            let conn = self
                .database
                .get_conn_safe()
                .map_err(|e| AppError::database(e.to_string()))?;
            {
                let tx = conn
                    .unchecked_transaction()
                    .map_err(|e| AppError::database(format!("开始事务失败: {}", e)))?;
                let _ = tx.execute("DELETE FROM rag_vectors", []);
                tx.execute("DELETE FROM rag_document_chunks", [])
                    .map_err(|e| AppError::database(e.to_string()))?;
                tx.execute("DELETE FROM rag_documents", [])
                    .map_err(|e| AppError::database(e.to_string()))?;
                tx.commit()
                    .map_err(|e| AppError::database(format!("提交事务失败: {}", e)))?;
            }
        }

        // 清空 Lance 表（遍历所有候选表，忽略不存在的表）
        let path = self.get_lance_path()?;
        if let Ok(db) = lancedb::connect(&path).execute().await {
            for name in Self::candidate_kb_table_names_for_scan() {
                if let Ok(tbl) = db.open_table(&name).execute().await {
                    let _ = tbl.delete("true").await; // 忽略错误提升容错
                }
            }
        }

        // 清空内存向量缓存
        self.emb_cache.clear();
        Ok(())
    }

    fn add_document_record_with_library(
        &self,
        document_id: &str,
        file_name: &str,
        file_path: Option<&str>,
        file_size: Option<u64>,
        sub_library_id: &str,
    ) -> Result<()> {
        // 统一由 SQLite 维护文档记录
        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        conn.execute(
            "INSERT OR REPLACE INTO rag_documents (id, file_name, file_path, file_size, sub_library_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            rusqlite::params![
                document_id,
                file_name,
                file_path,
                file_size.map(|s| s as i64),
                sub_library_id,
                chrono::Utc::now().to_rfc3339(),
                chrono::Utc::now().to_rfc3339()
            ],
        ).map_err(|e| AppError::database(format!("添加文档记录失败: {}", e)))?;
        Ok(())
    }

    fn update_document_chunk_count(&self, document_id: &str, chunk_count: usize) -> Result<()> {
        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        conn.execute(
            "UPDATE rag_documents SET total_chunks = ?1, updated_at = ?2 WHERE id = ?3",
            rusqlite::params![
                chunk_count as i32,
                chrono::Utc::now().to_rfc3339(),
                document_id
            ],
        )
        .map_err(|e| AppError::database(format!("更新文档块数失败: {}", e)))?;
        Ok(())
    }

    fn get_all_documents(&self) -> Result<Vec<serde_json::Value>> {
        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut stmt = conn.prepare(
            "SELECT id, file_name, file_path, file_size, total_chunks, created_at, updated_at FROM rag_documents ORDER BY created_at DESC"
        ).map_err(|e| AppError::database(format!("准备查询语句失败: {}", e)))?;
        let rows = stmt
            .query_map([], |row| {
                Ok(serde_json::json!({
                    "id": row.get::<_, String>(0)?,
                    "file_name": row.get::<_, String>(1)?,
                    "file_path": row.get::<_, Option<String>>(2)?,
                    "file_size": row.get::<_, Option<i64>>(3)?,
                    "total_chunks": row.get::<_, i32>(4)?,
                    "created_at": row.get::<_, String>(5)?,
                    "updated_at": row.get::<_, String>(6)?,
                }))
            })
            .map_err(|e| AppError::database(format!("查询文档列表失败: {}", e)))?;
        let mut documents = Vec::new();
        for row in rows {
            documents.push(row.map_err(|e| AppError::database(format!("读取文档行失败: {}", e)))?);
        }
        Ok(documents)
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
}

impl LanceVectorStore {
    #[cfg(feature = "lance")]
    fn fetch_chunks_by_ids_in_order(&self, ids: &[String]) -> Result<Vec<RetrievedChunk>> {
        if ids.is_empty() {
            return Ok(vec![]);
        }
        let path = self.get_lance_path()?;
        let wanted: HashMap<String, usize> = ids
            .iter()
            .enumerate()
            .map(|(idx, id)| (id.clone(), idx))
            .collect();

        let rows_map: HashMap<String, LanceChunkRow> =
            tauri::async_runtime::block_on(async move {
                use futures_util::TryStreamExt;
                let mut collected: HashMap<String, LanceChunkRow> = HashMap::new();
                let db = lancedb::connect(&path)
                    .execute()
                    .await
                    .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;
                let mut remaining: HashMap<String, usize> = wanted.clone();

                for dim in Self::candidate_dim_values() {
                    if remaining.is_empty() {
                        break;
                    }
                    let table_name = format!("{}{}", KB_V2_TABLE_PREFIX, dim);
                    let tbl = match db.open_table(&table_name).execute().await {
                        Ok(tbl) => tbl,
                        Err(_) => continue,
                    };
                    let keys: Vec<String> = remaining.keys().cloned().collect();
                    for batch_ids in keys.chunks(900) {
                        let in_list = batch_ids
                            .iter()
                            .map(|s| format!("'{}'", s.replace("'", "''")))
                            .collect::<Vec<_>>()
                            .join(",");
                        let filter = format!("chunk_id IN ({})", in_list);
                        let mut stream = tbl
                            .query()
                            .only_if(filter.as_str())
                            .execute()
                            .await
                            .map_err(|e| AppError::database(e.to_string()))?;
                        while let Some(batch) = stream
                            .try_next()
                            .await
                            .map_err(|e| AppError::database(e.to_string()))?
                        {
                            for row in Self::extract_chunk_rows_from_batch(&batch)? {
                                remaining.remove(&row.chunk_id);
                                collected.insert(row.chunk_id.clone(), row);
                            }
                            if remaining.is_empty() {
                                break;
                            }
                        }
                        if remaining.is_empty() {
                            break;
                        }
                    }
                }
                Ok::<_, AppError>(collected)
            })?;

        let mut out = Vec::with_capacity(ids.len());
        for id in ids {
            if let Some(row) = rows_map.get(id) {
                let metadata: HashMap<String, String> = row
                    .metadata_json
                    .as_ref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();
                out.push(RetrievedChunk {
                    chunk: DocumentChunk {
                        id: row.chunk_id.clone(),
                        document_id: row.document_id.clone(),
                        chunk_index: row.chunk_index.max(0) as usize,
                        text: row.text.clone(),
                        metadata,
                    },
                    score: 0.0,
                });
            }
        }
        Ok(out)
    }

    #[cfg(feature = "lance")]
    fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
        if a.len() != b.len() || a.is_empty() {
            return 0.0;
        }
        let mut dot = 0.0f32;
        let mut na = 0.0f32;
        let mut nb = 0.0f32;
        for i in 0..a.len() {
            dot += a[i] * b[i];
            na += a[i] * a[i];
            nb += b[i] * b[i];
        }
        if na == 0.0 || nb == 0.0 {
            0.0
        } else {
            (dot / (na.sqrt() * nb.sqrt())).clamp(-1.0, 1.0)
        }
    }

    #[cfg(feature = "lance")]
    async fn knn_ids_via_lance(
        &self,
        query_embedding: &[f32],
        limit: usize,
        sub_library_ids: Option<&[String]>,
    ) -> Result<Vec<(String, f32)>> {
        use futures_util::TryStreamExt;
        let fetch_limit: usize = std::cmp::max(1, limit).saturating_mul(10);
        let tbl = self.ensure_wide_table(query_embedding.len()).await?;

        let mut stream = tbl
            .vector_search(query_embedding)
            .map_err(|e| AppError::database(e.to_string()))?
            .distance_type(DistanceType::Cosine)
            .limit(fetch_limit)
            .execute()
            .await
            .map_err(|e| AppError::database(e.to_string()))?;

        let filter_set: Option<std::collections::HashSet<&str>> =
            sub_library_ids.map(|v| v.iter().map(|s| s.as_str()).collect());

        let mut out: Vec<(String, f32)> = Vec::with_capacity(limit);
        while let Some(batch) = stream
            .try_next()
            .await
            .map_err(|e| AppError::database(e.to_string()))?
        {
            let schema = batch.schema();
            let idx_id = schema
                .index_of("chunk_id")
                .map_err(|e| AppError::database(e.to_string()))?;
            let id_arr = batch
                .column(idx_id)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("chunk_id 列类型错误".to_string()))?;

            let idx_sub = schema.index_of("sub_library_id").ok();
            let sub_arr_opt: Option<&StringArray> =
                idx_sub.and_then(|i| batch.column(i).as_any().downcast_ref::<StringArray>());

            let idx_dist = schema.index_of("_distance").ok();
            let mut dists: Option<Vec<f32>> = None;
            if let Some(i) = idx_dist {
                let col = batch.column(i);
                if let Some(a32) = col.as_any().downcast_ref::<Float32Array>() {
                    dists = Some((0..a32.len()).map(|j| a32.value(j)).collect());
                } else if let Some(a64) = col.as_any().downcast_ref::<arrow_array::Float64Array>() {
                    dists = Some((0..a64.len()).map(|j| a64.value(j) as f32).collect());
                }
            }

            let rows = id_arr.len();
            for i in 0..rows {
                if let Some(ref set) = filter_set {
                    if let Some(sub_arr) = sub_arr_opt {
                        let sub = sub_arr.value(i);
                        if !set.contains(sub) {
                            continue;
                        }
                    } else {
                        continue;
                    }
                }
                let dist = dists.as_ref().map(|v| v[i]).unwrap_or(1.0);
                let sim = (1.0 - dist).clamp(-1.0, 1.0);
                out.push((id_arr.value(i).to_string(), sim));
                if out.len() >= limit {
                    break;
                }
            }
            if out.len() >= limit {
                break;
            }
        }

        use std::cmp::Ordering;
        out.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
        if out.len() > limit {
            out.truncate(limit);
        }
        Ok(out)
    }

    /// 自动迁移：协调 SQLite 旧向量、旧 Lance 表与聊天索引到最新 Lance 宽表结构。
    #[cfg(feature = "lance")]
    pub async fn auto_migrate_if_needed(
        database: Arc<Database>,
        llm_manager: Option<Arc<LLMManager>>,
    ) -> Result<()> {
        let mut coordinator = MigrationCoordinator::new(database, llm_manager)?;
        coordinator.run().await
    }
}

#[cfg(feature = "lance")]
#[derive(Debug, Clone, Default)]
struct MigrationProgress {
    status: String,
    last_cursor: Option<String>,
    total_processed: i64,
    last_error: Option<String>,
}

#[cfg(feature = "lance")]
struct MigrationCoordinator {
    database: Arc<Database>,
    store: LanceVectorStore,
    lance_path: String,
    llm_manager: Option<Arc<LLMManager>>,
}

#[cfg(feature = "lance")]
impl MigrationCoordinator {
    fn new(database: Arc<Database>, llm_manager: Option<Arc<LLMManager>>) -> Result<Self> {
        let store = LanceVectorStore::new(database.clone())?;
        let lance_path = store.get_lance_path()?;
        Ok(Self {
            database,
            store,
            lance_path,
            llm_manager,
        })
    }

    async fn run(&mut self) -> Result<()> {
        self.ensure_progress_record(CATEGORY_KB_SQLITE)?;
        self.ensure_progress_record(CATEGORY_CHAT_FALLBACK)?;

        self.migrate_sqlite_vectors().await?;
        self.migrate_legacy_kb_tables().await?;
        self.migrate_legacy_chat_tables().await?;
        self.verify_and_finalize().await
    }

    async fn migrate_sqlite_vectors(&mut self) -> Result<()> {
        let mut progress = self.load_progress(CATEGORY_KB_SQLITE)?;
        if progress.status == "completed" {
            return Ok(());
        }

        let total = self.count_sqlite_vectors()?;
        if total == 0 {
            self.update_progress(
                CATEGORY_KB_SQLITE,
                "completed",
                None,
                Some(progress.total_processed),
                None,
            )?;
            return Ok(());
        }

        let mut last_cursor = progress.last_cursor.clone();
        loop {
            let (batch, new_cursor) = self.fetch_sqlite_batch(last_cursor.as_deref(), 512)?;
            if batch.is_empty() {
                self.update_progress(
                    CATEGORY_KB_SQLITE,
                    "completed",
                    last_cursor.as_deref(),
                    Some(progress.total_processed),
                    None,
                )?;
                break;
            }

            let batch_len = batch.len() as i64;
            self.write_chunks_grouped(batch).await?;
            if let Some(cursor) = new_cursor.as_ref() {
                last_cursor = Some(cursor.clone());
            }
            progress.total_processed += batch_len;
            self.update_progress(
                CATEGORY_KB_SQLITE,
                "in_progress",
                last_cursor.as_deref(),
                Some(progress.total_processed),
                None,
            )?;
        }

        Ok(())
    }

    fn count_sqlite_vectors(&self) -> Result<i64> {
        if !self.table_exists("rag_vectors")? {
            return Ok(0);
        }
        if !self.table_exists("rag_document_chunks")? {
            warn!("⚠️ [LanceMigration] 检测到缺失 rag_document_chunks 表，跳过旧版向量迁移");
            return Ok(0);
        }

        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let count = conn.query_row("SELECT COUNT(*) FROM rag_vectors", [], |row| {
            row.get::<_, i64>(0)
        });
        match count {
            Ok(value) => Ok(value),
            Err(_) => Ok(0),
        }
    }

    fn fetch_sqlite_batch(
        &self,
        last_cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<DocumentChunkWithEmbedding>, Option<String>)> {
        if !self.table_exists("rag_vectors")? {
            return Ok((Vec::new(), None));
        }
        if !self.table_exists("rag_document_chunks")? {
            return Ok((Vec::new(), None));
        }
        let guard = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let conn = &*guard;

        let sql = if last_cursor.is_some() {
            "SELECT c.id, c.document_id, c.chunk_index, c.text, c.metadata, v.embedding \
             FROM rag_document_chunks c JOIN rag_vectors v ON v.chunk_id = c.id \
             WHERE c.id > ?1 ORDER BY c.id LIMIT ?2"
        } else {
            "SELECT c.id, c.document_id, c.chunk_index, c.text, c.metadata, v.embedding \
             FROM rag_document_chunks c JOIN rag_vectors v ON v.chunk_id = c.id \
             ORDER BY c.id LIMIT ?1"
        };

        let mut stmt = conn
            .prepare(sql)
            .map_err(|e| AppError::database(e.to_string()))?;

        fn map_row(
            row: &rusqlite::Row<'_>,
        ) -> rusqlite::Result<(String, String, i32, String, String, Vec<u8>)> {
            let chunk_id: String = row.get(0)?;
            let document_id: String = row.get(1)?;
            let chunk_index: i32 = row.get(2)?;
            let text: String = row.get(3)?;
            let metadata_json: String = row.get(4)?;
            let blob: Vec<u8> = row.get(5)?;
            Ok((
                chunk_id,
                document_id,
                chunk_index,
                text,
                metadata_json,
                blob,
            ))
        }

        let rows = match last_cursor {
            Some(cursor) => stmt.query_map(rusqlite::params![cursor, limit as i64], map_row),
            None => stmt.query_map(rusqlite::params![limit as i64], map_row),
        }
        .map_err(|e| AppError::database(e.to_string()))?;

        let mut chunks: Vec<DocumentChunkWithEmbedding> = Vec::new();
        let mut last_id: Option<String> = None;
        for row in rows {
            let (chunk_id, document_id, chunk_index, text, metadata_json, blob) =
                row.map_err(|e| AppError::database(e.to_string()))?;
            if let Some(embedding) = Self::blob_to_vec(&blob) {
                let metadata: HashMap<String, String> =
                    serde_json::from_str(&metadata_json).unwrap_or_default();
                chunks.push(DocumentChunkWithEmbedding {
                    chunk: DocumentChunk {
                        id: chunk_id.clone(),
                        document_id,
                        chunk_index: chunk_index.max(0) as usize,
                        text,
                        metadata,
                    },
                    embedding,
                });
                last_id = Some(chunk_id);
            }
        }

        Ok((chunks, last_id))
    }

    async fn write_chunks_grouped(&self, chunks: Vec<DocumentChunkWithEmbedding>) -> Result<()> {
        if chunks.is_empty() {
            return Ok(());
        }
        let mut grouped: HashMap<usize, Vec<DocumentChunkWithEmbedding>> = HashMap::new();
        for chunk in chunks.into_iter() {
            let dim = chunk.embedding.len();
            grouped.entry(dim).or_default().push(chunk);
        }

        for (_, group) in grouped.into_iter() {
            if !group.is_empty() {
                self.store.add_chunks(group).await?;
            }
        }
        Ok(())
    }

    async fn migrate_legacy_kb_tables(&mut self) -> Result<()> {
        let dims = LanceVectorStore::candidate_dim_values();
        for dim in dims {
            let category = format!("{}_{}", KB_LEGACY_TABLE_PREFIX, dim);
            self.ensure_progress_record(&category)?;
            let mut progress = self.load_progress(&category)?;
            if progress.status == "completed" {
                continue;
            }

            let legacy_tbl = match self
                .open_table(&format!("{}{}", KB_LEGACY_TABLE_PREFIX, dim))
                .await?
            {
                Some(tbl) => tbl,
                None => {
                    self.update_progress(
                        &category,
                        "completed",
                        None,
                        Some(progress.total_processed),
                        None,
                    )?;
                    continue;
                }
            };

            loop {
                let (rows, new_cursor) = self
                    .fetch_legacy_kb_batch(&legacy_tbl, progress.last_cursor.as_deref(), 400)
                    .await?;
                if rows.is_empty() {
                    self.update_progress(
                        &category,
                        "completed",
                        progress.last_cursor.as_deref(),
                        Some(progress.total_processed),
                        None,
                    )?;
                    break;
                }

                let chunk_ids: Vec<String> = rows.iter().map(|r| r.chunk_id.clone()).collect();
                let chunk_map = self.load_chunk_metadata(&chunk_ids)?;

                let mut batch: Vec<DocumentChunkWithEmbedding> = Vec::with_capacity(rows.len());
                let mut missing_chunks: Vec<String> = Vec::new();
                for row in rows.into_iter() {
                    if let Some(meta) = chunk_map.get(&row.chunk_id) {
                        batch.push(DocumentChunkWithEmbedding {
                            chunk: DocumentChunk {
                                id: row.chunk_id.clone(),
                                document_id: meta.document_id.clone(),
                                chunk_index: meta.chunk_index,
                                text: meta.text.clone(),
                                metadata: meta.metadata.clone(),
                            },
                            embedding: row.embedding,
                        });
                    } else {
                        missing_chunks.push(row.chunk_id.clone());
                    }
                }

                let mut last_error: Option<String> = None;
                if !missing_chunks.is_empty() {
                    let sample: Vec<String> = missing_chunks.iter().take(5).cloned().collect();
                    let message = format!(
                        "检测到 {} 个旧向量缺少文档块样本: {}",
                        missing_chunks.len(),
                        sample.join(", ")
                    );
                    warn!("⚠️ [Migration] {}", message);
                    last_error = Some(message);
                }

                if !batch.is_empty() {
                    let processed = batch.len() as i64;
                    self.write_chunks_grouped(batch).await?;
                    progress.total_processed += processed;
                }
                progress.last_cursor = new_cursor.clone();
                self.update_progress(
                    &category,
                    "in_progress",
                    progress.last_cursor.as_deref(),
                    Some(progress.total_processed),
                    last_error.as_deref(),
                )?;

                if new_cursor.is_none() {
                    break;
                }
            }
        }
        Ok(())
    }

    async fn migrate_legacy_chat_tables(&mut self) -> Result<()> {
        let dims = LanceVectorStore::candidate_dim_values();
        for dim in dims {
            let category = format!("chat_legacy_{}", dim);
            self.ensure_progress_record(&category)?;
            let mut progress = self.load_progress(&category)?;
            if progress.status == "completed" {
                continue;
            }

            let legacy_table_name = format!("{}{}", CHAT_LEGACY_TABLE_PREFIX, dim);
            let legacy_tbl = match self.open_table(&legacy_table_name).await? {
                Some(tbl) => tbl,
                None => continue,
            };

            loop {
                let (rows, new_cursor) = self
                    .fetch_legacy_chat_batch(&legacy_tbl, progress.last_cursor.as_deref(), 400)
                    .await?;
                if rows.is_empty() {
                    self.update_progress(
                        &category,
                        "completed",
                        progress.last_cursor.as_deref(),
                        Some(progress.total_processed),
                        None,
                    )?;
                    break;
                }

                let message_ids: Vec<i64> = rows
                    .iter()
                    .filter_map(|row| log_and_skip_err(row.message_id.parse::<i64>()))
                    .collect();
                let message_map = self.load_chat_messages(&message_ids)?;

                let mut payload: Vec<LanceChatRow> = Vec::with_capacity(rows.len());
                let mut missing_msgs: Vec<String> = Vec::new();
                for row in rows.into_iter() {
                    if let Ok(message_id) = row.message_id.parse::<i64>() {
                        if let Some((mistake_id, role, content, timestamp)) =
                            message_map.get(&message_id)
                        {
                            payload.push(LanceChatRow {
                                message_id: row.message_id.clone(),
                                mistake_id: mistake_id.clone(),
                                role: role.clone(),
                                timestamp: timestamp.clone(),
                                text: extract_plain_text(content),
                                embedding: row.embedding,
                            });
                        } else if missing_msgs.len() < 20 {
                            missing_msgs.push(row.message_id.clone());
                        }
                    }
                }

                let mut last_error: Option<String> = None;
                if !missing_msgs.is_empty() {
                    let message = format!(
                        "旧聊天向量缺少 {} 条消息记录，样例: {}",
                        missing_msgs.len(),
                        missing_msgs
                            .iter()
                            .take(5)
                            .cloned()
                            .collect::<Vec<_>>()
                            .join(", ")
                    );
                    warn!("⚠️ [Migration] {}", message);
                    last_error = Some(message);
                }

                if !payload.is_empty() {
                    let processed = payload.len() as i64;
                    self.store.upsert_chat_embeddings_batch(&payload).await?;
                    progress.total_processed += processed;
                }
                progress.last_cursor = new_cursor.clone();
                self.update_progress(
                    &category,
                    "in_progress",
                    progress.last_cursor.as_deref(),
                    Some(progress.total_processed),
                    last_error.as_deref(),
                )?;

                if new_cursor.is_none() {
                    break;
                }
            }
        }

        // 兼容旧的 chat_embeddings（无维度后缀）
        let mut base_progress = self.load_progress(CATEGORY_CHAT_FALLBACK)?;
        if base_progress.status != "completed" {
            if let Some(tbl) = self.open_table(CHAT_LEGACY_FALLBACK_TABLE).await? {
                loop {
                    let (rows, new_cursor) = self
                        .fetch_legacy_chat_batch(&tbl, base_progress.last_cursor.as_deref(), 400)
                        .await?;
                    if rows.is_empty() {
                        self.update_progress(
                            CATEGORY_CHAT_FALLBACK,
                            "completed",
                            base_progress.last_cursor.as_deref(),
                            Some(base_progress.total_processed),
                            None,
                        )?;
                        break;
                    }

                    let message_ids: Vec<i64> = rows
                        .iter()
                        .filter_map(|row| log_and_skip_err(row.message_id.parse::<i64>()))
                        .collect();
                    let message_map = self.load_chat_messages(&message_ids)?;

                    let mut payload: Vec<LanceChatRow> = Vec::with_capacity(rows.len());
                    let mut missing_msgs: Vec<String> = Vec::new();
                    for row in rows.into_iter() {
                        if let Ok(message_id) = row.message_id.parse::<i64>() {
                            if let Some((mistake_id, role, content, timestamp)) =
                                message_map.get(&message_id)
                            {
                                payload.push(LanceChatRow {
                                    message_id: row.message_id.clone(),
                                    mistake_id: mistake_id.clone(),
                                    role: role.clone(),
                                    timestamp: timestamp.clone(),
                                    text: extract_plain_text(content),
                                    embedding: row.embedding,
                                });
                            } else if missing_msgs.len() < 20 {
                                missing_msgs.push(row.message_id.clone());
                            }
                        }
                    }

                    let mut last_error: Option<String> = None;
                    if !missing_msgs.is_empty() {
                        let message = format!(
                            "旧聊天向量缺少 {} 条消息记录，样例: {}",
                            missing_msgs.len(),
                            missing_msgs
                                .iter()
                                .take(5)
                                .cloned()
                                .collect::<Vec<_>>()
                                .join(", ")
                        );
                        warn!("⚠️ [Migration] {}", message);
                        last_error = Some(message);
                    }

                    if !payload.is_empty() {
                        let processed = payload.len() as i64;
                        self.store.upsert_chat_embeddings_batch(&payload).await?;
                        base_progress.total_processed += processed;
                    }
                    base_progress.last_cursor = new_cursor.clone();
                    self.update_progress(
                        CATEGORY_CHAT_FALLBACK,
                        "in_progress",
                        base_progress.last_cursor.as_deref(),
                        Some(base_progress.total_processed),
                        last_error.as_deref(),
                    )?;

                    if new_cursor.is_none() {
                        break;
                    }
                }
            } else {
                self.update_progress(
                    CATEGORY_CHAT_FALLBACK,
                    "completed",
                    None,
                    Some(base_progress.total_processed),
                    None,
                )?;
            }
        }

        Ok(())
    }

    async fn verify_and_finalize(&mut self) -> Result<()> {
        let expected_chunks = self.expected_kb_chunk_total()?;
        let actual_chunks = self.total_wide_chunk_rows().await?;
        let chat_expected = self.expected_chat_message_total()?;
        let chat_actual = self.total_chat_rows().await?;

        if expected_chunks > 0 && actual_chunks < expected_chunks {
            warn!(
                "⚠️ [Migration] Lance 宽表行数不足: 预期 {} 实际 {}，将继续等待迁移",
                expected_chunks, actual_chunks
            );
            let _ = self
                .database
                .save_setting("rag.lance.migration.completed", "0");
            return Ok(());
        }

        if chat_expected > 0 && chat_actual < chat_expected {
            warn!(
                "⚠️ [Migration] 聊天向量迁移不完整: 预期 {} 实际 {}，将继续等待迁移",
                chat_expected, chat_actual
            );
            let _ = self
                .database
                .save_setting("rag.lance.migration.completed", "0");
            // self.schedule_chat_backfill(chat_expected.saturating_sub(chat_actual));
            return Ok(());
        }

        self.update_progress(CATEGORY_KB_SQLITE, "completed", None, None, None)?;
        self.update_progress(CATEGORY_CHAT_FALLBACK, "completed", None, None, None)?;

        let _ = self
            .database
            .save_setting("rag.lance.migration.completed", "1");
        Ok(())
    }

    async fn spawn_verification_retry(
        database: Arc<Database>,
        initial_delay: Duration,
        max_attempts: u32,
    ) {
        let mut attempts = max_attempts;
        let mut delay = initial_delay;
        while attempts > 0 {
            tokio::time::sleep(delay).await;
            match MigrationCoordinator::new(database.clone(), None) {
                Ok(mut coordinator) => match coordinator.verify_and_finalize().await {
                    Ok(_) => return,
                    Err(err) => {
                        error!(
                            "⚠️ [Migration] 回填后验证失败（剩余重试 {} 次）: {}",
                            attempts.saturating_sub(1),
                            err
                        );
                    }
                },
                Err(err) => {
                    error!(
                        "⚠️ [Migration] 构建验证协调器失败（剩余重试 {} 次）: {}",
                        attempts.saturating_sub(1),
                        err
                    );
                }
            }
            attempts -= 1;
            delay = delay.saturating_mul(2);
        }
    }

    fn load_chunk_metadata(&self, chunk_ids: &[String]) -> Result<HashMap<String, ChunkMeta>> {
        if chunk_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; chunk_ids.len()].join(",");
        let sql = format!(
            "SELECT id, document_id, chunk_index, text, metadata FROM rag_document_chunks WHERE id IN ({})",
            placeholders
        );
        let guard = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let conn = &*guard;
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::database(e.to_string()))?;
        let params = rusqlite::params_from_iter(chunk_ids.iter());
        let rows = stmt
            .query_map(params, |row| {
                let id: String = row.get(0)?;
                let document_id: String = row.get(1)?;
                let chunk_index: i32 = row.get(2)?;
                let text: String = row.get(3)?;
                let metadata_json: String = row.get(4)?;
                Ok((id, document_id, chunk_index, text, metadata_json))
            })
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut map = HashMap::new();
        for row in rows {
            let (id, document_id, chunk_index, text, metadata_json) =
                row.map_err(|e| AppError::database(e.to_string()))?;
            let metadata: HashMap<String, String> =
                serde_json::from_str(&metadata_json).unwrap_or_default();
            map.insert(
                id,
                ChunkMeta {
                    document_id,
                    chunk_index: chunk_index.max(0) as usize,
                    text,
                    metadata,
                },
            );
        }
        Ok(map)
    }

    async fn open_table(&self, name: &str) -> Result<Option<Table>> {
        let db = lancedb::connect(&self.lance_path)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;
        match db.open_table(name).execute().await {
            Ok(tbl) => Ok(Some(tbl)),
            Err(_) => Ok(None),
        }
    }

    async fn fetch_legacy_kb_batch(
        &self,
        tbl: &Table,
        last_cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<LegacyChunkRow>, Option<String>)> {
        use futures_util::TryStreamExt;

        let mut builder = tbl.query().with_row_id();
        if let Some(cursor) = last_cursor {
            builder = builder.only_if(&format!("_rowid > {}", cursor));
        }
        let mut stream = builder
            .limit(limit)
            .execute()
            .await
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut rows: Vec<LegacyChunkRow> = Vec::new();
        let mut last_row_id: Option<u64> = None;
        while rows.len() < limit {
            let maybe_batch = stream
                .try_next()
                .await
                .map_err(|e| AppError::database(e.to_string()))?;
            let batch = match maybe_batch {
                Some(batch) => batch,
                None => break,
            };

            let schema = batch.schema();
            let idx_row = schema
                .index_of("_rowid")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_chunk = schema
                .index_of("chunk_id")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_sub = schema.index_of("sub_library_id").ok();
            let idx_emb = schema
                .index_of("embedding")
                .map_err(|e| AppError::database(e.to_string()))?;

            let row_arr = batch
                .column(idx_row)
                .as_any()
                .downcast_ref::<UInt64Array>()
                .ok_or_else(|| AppError::database("_rowid 列类型错误".to_string()))?;
            let chunk_arr = batch
                .column(idx_chunk)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("chunk_id 列类型错误".to_string()))?;
            let sub_arr = idx_sub.and_then(|i| {
                batch
                    .column(i)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .map(|arr| arr as &StringArray)
            });
            let emb_arr = batch
                .column(idx_emb)
                .as_any()
                .downcast_ref::<FixedSizeListArray>()
                .ok_or_else(|| AppError::database("embedding 列类型错误".to_string()))?;

            let width = emb_arr.value_length() as usize;
            for row_idx in 0..chunk_arr.len() {
                let row_id = row_arr.value(row_idx);
                let sub = sub_arr.and_then(|arr| {
                    if arr.is_null(row_idx) {
                        None
                    } else {
                        Some(arr.value(row_idx).to_string())
                    }
                });
                let values = emb_arr.value(row_idx);
                let vec32 = values
                    .as_any()
                    .downcast_ref::<Float32Array>()
                    .ok_or_else(|| AppError::database("embedding item 类型错误".to_string()))?;
                let mut embedding = Vec::with_capacity(width);
                for i in 0..width {
                    embedding.push(vec32.value(i));
                }
                rows.push(LegacyChunkRow {
                    row_id,
                    chunk_id: chunk_arr.value(row_idx).to_string(),
                    sub_library_id: sub,
                    embedding,
                });
                last_row_id = Some(row_id);
                if rows.len() >= limit {
                    break;
                }
            }
        }

        let next_cursor = last_row_id.map(|v| v.to_string());
        Ok((rows, next_cursor))
    }

    async fn fetch_legacy_chat_batch(
        &self,
        tbl: &Table,
        last_cursor: Option<&str>,
        limit: usize,
    ) -> Result<(Vec<LegacyChatRow>, Option<String>)> {
        use futures_util::TryStreamExt;

        let mut builder = tbl.query().with_row_id();
        if let Some(cursor) = last_cursor {
            builder = builder.only_if(&format!("_rowid > {}", cursor));
        }
        let mut stream = builder
            .limit(limit)
            .execute()
            .await
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut rows: Vec<LegacyChatRow> = Vec::new();
        let mut last_row_id: Option<u64> = None;
        while rows.len() < limit {
            let maybe_batch = stream
                .try_next()
                .await
                .map_err(|e| AppError::database(e.to_string()))?;
            let batch = match maybe_batch {
                Some(batch) => batch,
                None => break,
            };

            let schema = batch.schema();
            let idx_row = schema
                .index_of("_rowid")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_message = schema
                .index_of("message_id")
                .map_err(|e| AppError::database(e.to_string()))?;
            let idx_emb = schema
                .index_of("embedding")
                .map_err(|e| AppError::database(e.to_string()))?;

            let row_arr = batch
                .column(idx_row)
                .as_any()
                .downcast_ref::<UInt64Array>()
                .ok_or_else(|| AppError::database("_rowid 列类型错误".to_string()))?;
            let msg_arr = batch
                .column(idx_message)
                .as_any()
                .downcast_ref::<StringArray>()
                .ok_or_else(|| AppError::database("message_id 列类型错误".to_string()))?;
            let emb_arr = batch
                .column(idx_emb)
                .as_any()
                .downcast_ref::<FixedSizeListArray>()
                .ok_or_else(|| AppError::database("embedding 列类型错误".to_string()))?;

            let width = emb_arr.value_length() as usize;
            for row_idx in 0..msg_arr.len() {
                let values = emb_arr.value(row_idx);
                let vec32 = values
                    .as_any()
                    .downcast_ref::<Float32Array>()
                    .ok_or_else(|| AppError::database("embedding item 类型错误".to_string()))?;
                let mut embedding = Vec::with_capacity(width);
                for i in 0..width {
                    embedding.push(vec32.value(i));
                }
                rows.push(LegacyChatRow {
                    row_id: row_arr.value(row_idx),
                    message_id: msg_arr.value(row_idx).to_string(),
                    embedding,
                });
                last_row_id = Some(row_arr.value(row_idx));
                if rows.len() >= limit {
                    break;
                }
            }
        }
        let next_cursor = last_row_id.map(|v| v.to_string());
        Ok((rows, next_cursor))
    }
    fn load_chat_messages(
        &self,
        ids: &[i64],
    ) -> Result<HashMap<i64, (String, String, String, String)>> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT m.id, m.mistake_id, m.role, m.content, m.timestamp \
             FROM chat_messages m \
             WHERE m.id IN ({})",
            placeholders
        );
        let guard = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let conn = &*guard;
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::database(e.to_string()))?;
        let params = rusqlite::params_from_iter(ids.iter());
        let rows = stmt
            .query_map(params, |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|e| AppError::database(e.to_string()))?;

        let mut map = HashMap::new();
        for row in rows {
            let (id, mistake_id, role, content, timestamp) =
                row.map_err(|e| AppError::database(e.to_string()))?;
            map.insert(id, (mistake_id, role, content, timestamp));
        }
        Ok(map)
    }

    fn ensure_progress_record(&self, category: &str) -> Result<()> {
        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        conn.execute(
            "INSERT INTO migration_progress (category, status, total_processed) VALUES (?1, 'pending', 0) \
             ON CONFLICT(category) DO NOTHING",
            rusqlite::params![category],
        )
        .map_err(|e| AppError::database(e.to_string()))?;
        Ok(())
    }

    fn load_progress(&self, category: &str) -> Result<MigrationProgress> {
        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let result = conn
            .query_row(
                "SELECT status, last_cursor, total_processed, last_error FROM migration_progress WHERE category=?1",
                rusqlite::params![category],
                |row| {
                    Ok(MigrationProgress {
                        status: row.get::<_, String>(0)?,
                        last_cursor: row.get::<_, Option<String>>(1)?,
                        total_processed: row.get::<_, i64>(2)?,
                        last_error: row.get::<_, Option<String>>(3)?,
                    })
                },
            )
            .optional()
            .map_err(|e| AppError::database(e.to_string()))?;
        let mut progress = result.unwrap_or_default();
        if progress.status.is_empty() {
            progress.status = "pending".to_string();
        }
        Ok(progress)
    }

    fn update_progress(
        &self,
        category: &str,
        status: &str,
        last_cursor: Option<&str>,
        total_processed: Option<i64>,
        last_error: Option<&str>,
    ) -> Result<()> {
        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        conn.execute(
            "UPDATE migration_progress
             SET status = ?2,
                 last_cursor = CASE WHEN ?3 IS NULL THEN last_cursor ELSE ?3 END,
                 total_processed = CASE WHEN ?4 IS NULL THEN total_processed ELSE ?4 END,
                 last_error = ?5,
                 updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
             WHERE category = ?1",
            rusqlite::params![category, status, last_cursor, total_processed, last_error],
        )
        .map_err(|e| AppError::database(e.to_string()))?;
        Ok(())
    }

    fn expected_kb_chunk_total(&self) -> Result<usize> {
        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        conn.query_row("SELECT COUNT(*) FROM rag_document_chunks", [], |row| {
            row.get::<_, i64>(0)
        })
        .map(|count| count.max(0) as usize)
        .map_err(|e| AppError::database(e.to_string()))
    }

    fn expected_chat_message_total(&self) -> Result<usize> {
        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        conn.query_row(
            "SELECT COUNT(*) FROM chat_messages WHERE role='user'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map(|count| count.max(0) as usize)
        .map_err(|e| AppError::database(e.to_string()))
    }

    async fn total_wide_chunk_rows(&self) -> Result<usize> {
        let db = lancedb::connect(&self.lance_path)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;
        let mut total = 0usize;
        for dim in LanceVectorStore::candidate_dim_values() {
            let table_name = format!("{}{}", KB_V2_TABLE_PREFIX, dim);
            if let Ok(tbl) = db.open_table(&table_name).execute().await {
                total += tbl
                    .count_rows(None)
                    .await
                    .map_err(|e| AppError::database(e.to_string()))?;
            }
        }
        Ok(total)
    }

    async fn total_chat_rows(&self) -> Result<usize> {
        let db = lancedb::connect(&self.lance_path)
            .execute()
            .await
            .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;
        let mut total = 0usize;
        for dim in LanceVectorStore::candidate_dim_values() {
            let table_name = format!("{}{}", CHAT_V2_TABLE_PREFIX, dim);
            if let Ok(tbl) = db.open_table(&table_name).execute().await {
                total += tbl
                    .count_rows(None)
                    .await
                    .map_err(|e| AppError::database(e.to_string()))?;
            }
        }
        Ok(total)
    }

    fn blob_to_vec(blob: &[u8]) -> Option<Vec<f32>> {
        if blob.len() % 4 != 0 {
            return None;
        }
        let mut out = Vec::with_capacity(blob.len() / 4);
        for chunk in blob.chunks_exact(4) {
            out.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
        }
        Some(out)
    }

    fn table_exists(&self, name: &str) -> Result<bool> {
        let conn = self
            .database
            .get_conn_safe()
            .map_err(|e| AppError::database(e.to_string()))?;
        let exists = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                rusqlite::params![name],
                |row| row.get::<_, i64>(0),
            )
            .unwrap_or(0)
            == 1;
        Ok(exists)
    }
}

#[cfg(feature = "lance")]
struct LegacyChunkRow {
    row_id: u64,
    chunk_id: String,
    sub_library_id: Option<String>,
    embedding: Vec<f32>,
}

#[cfg(feature = "lance")]
struct LegacyChatRow {
    row_id: u64,
    message_id: String,
    embedding: Vec<f32>,
}

#[cfg(feature = "lance")]
struct ChunkMeta {
    document_id: String,
    chunk_index: usize,
    text: String,
    metadata: HashMap<String, String>,
}
