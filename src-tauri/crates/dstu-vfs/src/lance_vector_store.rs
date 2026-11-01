use crate::database::Database;
use crate::models::AppError;
#[cfg(feature = "lance")]
use crate::models::{DocumentChunk, DocumentChunkWithEmbedding, RetrievedChunk, VectorStoreStats};
#[cfg(feature = "lance")]
use crate::vector_store::VectorStore;
#[cfg(feature = "lance")]
use async_trait::async_trait;
#[cfg(feature = "lance")]
use std::cmp::Ordering;
#[cfg(feature = "lance")]
use std::collections::{HashMap, HashSet};
#[cfg(feature = "lance")]
use std::fs;
#[cfg(feature = "lance")]
use std::path::{Path, PathBuf};
use std::sync::Arc;
use tracing::{debug, warn};
#[cfg(feature = "lance")]
use tracing::{error, info};

#[cfg(feature = "lance")]
use rusqlite::OptionalExtension;

// ★ WI-6（mobile-slim）：移除此前的 `compile_error!` 硬门槛。
// 未启用 lance 时：SQLite 元数据方法（new / ensure_base_rag_schema 等）保持可用，
// 向量维护方法（optimize_* / delete_chat_embeddings_by_ids）降级为 no-op stub，
// 向量检索/迁移能力整体不可用（相关 impl 均已 #[cfg(feature = "lance")] 门控）。

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
    // 移除 markdown 图片标记（正则只编译一次，避免每次调用重复编译）
    static IMAGE_MD_RE: std::sync::LazyLock<regex::Regex> =
        std::sync::LazyLock::new(|| regex::Regex::new(r"!\[.*?\]\(.*?\)").expect("静态正则应合法"));
    IMAGE_MD_RE.replace_all(trimmed, "").trim().to_string()
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
use lancedb::index::scalar::{BTreeIndexBuilder, BitmapIndexBuilder};
#[cfg(feature = "lance")]
use lancedb::index::vector::IvfPqIndexBuilder;
#[cfg(feature = "lance")]
use lancedb::index::Index;
#[cfg(feature = "lance")]
use lancedb::query::{ExecutableQuery, QueryBase, QueryExecutionOptions, Select};
#[cfg(feature = "lance")]
use lancedb::table::{OptimizeAction, OptimizeOptions};
#[cfg(feature = "lance")]
use lancedb::DistanceType;
#[cfg(feature = "lance")]
use lancedb::{Connection, Table};
#[cfg(feature = "lance")]
use std::time::Instant;
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

/// LanceDB 向量存储实现（维护模式）
///
/// ⚠️ 定位说明（2026-07）：
/// - 活跃的知识库检索已迁移至 `vfs::lance_store::VfsLanceStore`，本类型
///   仅承担遗留 KB 数据（`kb_chunks_v2_d*` 宽表）与聊天向量表
///   （`chat_embeddings_v2_d*`）的维护职责：删除、优化、孤儿清理与只读迁移。
/// - 现存外部调用面：commands.rs（删除/优化/孤儿清理）、lib.rs 启动优化、
///   notes_manager（`default_lance_root_from_db_path` / `ensure_mobile_tmpdir_within`）。
/// - 请勿在新代码中引入对本类型 KB 检索 API 的依赖。
///
/// 其它说明：
/// - 向量能力仅在启用 feature "lance" 时可用；未启用时（如 mobile-slim）
///   SQLite 元数据方法可用，向量维护方法降级为 no-op stub。
/// - 文档/分块元数据仍存 SQLite；向量数据写入 LanceDB。
pub struct LanceVectorStore {
    database: Arc<Database>,
    #[allow(dead_code)]
    dim: Option<usize>,
    // ★ 2026-06-13（审阅问题 F12）：移除 emb_cache 内存向量缓存。
    // 该缓存只有写入路径（add_chunks 逐条 insert、启动预热全表扫描），
    // 从未被任何检索路径读取（搜索一律直查 Lance）；且预热任务向
    // DashMap 的 clone()（深拷贝副本）灌数据后整体丢弃，纯属浪费。
    // 删除后：省去每次写入的双份内存、启动时的全表扫描 IO，行为不变。
    // ★ 2026-07：移除恒为 None 的 `db: Option<Connection>` 字段；连接改由
    // 进程级 LANCE_CONNECTION_CACHE 按路径复用（本结构体实例生命周期极短，
    // 实例级字段无法跨命令复用连接）。
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
const OPTIMIZE_MIN_INTERVAL_KB_SECS: i64 = 1800; // 30min，与聊天表一致但独立记账
#[cfg(feature = "lance")]
const LANCE_RELEVANCE_COL: &str = "_relevance_score";
#[cfg(feature = "lance")]
const LANCE_FTS_SCORE_COL: &str = "_score";

/// KB 检索热路径的列投影：仅含下游结果构造实际读取的普通列。
/// `_distance` / `_relevance_score` / `_score` 等系统列由引擎按查询类型
/// 自动附加，不需要也不应放进 select（vendored lancedb 的 Select::Columns
/// 只作用于 scanner.project，向量/FTS 分数列独立追加；同仓库
/// vfs::lance_store::SEARCH_RESULT_COLUMNS 为同款用法）。embedding 列被
/// 显式排除——结果行的 embedding 字段本就填 Vec::new()，此前整列拉回再丢弃。
#[cfg(feature = "lance")]
const KB_SEARCH_RESULT_COLUMNS: &[&str] = &[
    "chunk_id",
    "document_id",
    "sub_library_id",
    "chunk_index",
    "text",
    "metadata",
    "created_at",
];
/// 聊天向量检索热路径的列投影（同上，排除 embedding，系统列由引擎附加）。
#[cfg(feature = "lance")]
const CHAT_SEARCH_RESULT_COLUMNS: &[&str] =
    &["message_id", "mistake_id", "role", "timestamp", "text"];

#[cfg(feature = "lance")]
const CATEGORY_KB_SQLITE: &str = "kb_sqlite_to_lance";
#[cfg(feature = "lance")]
const CATEGORY_CHAT_FALLBACK: &str = "chat_legacy_base";

/// Coordinates KB writers with destructive clear operations across all store
/// instances in this process. Multiple commands construct short-lived
/// `LanceVectorStore` values for the same path, so an instance-local lock is
/// insufficient.
#[cfg(feature = "lance")]
static KB_MUTATION_LOCK: tokio::sync::RwLock<()> = tokio::sync::RwLock::const_new(());

/// IVF-PQ 用 8-bit 码本，小表不足以训练；低于该行数走精确扫描（与
/// VfsLanceStore 的阈值保持一致，但两层实现相互独立）。
#[cfg(feature = "lance")]
const MIN_ROWS_FOR_ANN_INDEX: usize = 256;
/// 向量索引元数据版本：显式 IVF-PQ + Cosine。旧的 `Index::Auto`（L2 训练）
/// 索引与 Cosine 查询度量不一致，检测到版本不符时强制重建。
#[cfg(feature = "lance")]
const ANN_INDEX_VERSION: &str = "2026-07-ivfpq-cosine-v1";

/// 进程级 LanceDB 连接缓存（按数据库路径复用）。
/// 本结构体实例都是短生命周期（每个命令新建一个），实例字段无法复用连接，
/// 此前每次操作都重新 `lancedb::connect`。
#[cfg(feature = "lance")]
static LANCE_CONNECTION_CACHE: std::sync::OnceLock<
    tokio::sync::Mutex<HashMap<String, Connection>>,
> = std::sync::OnceLock::new();

/// 进程级"已确保索引"的表缓存（key = "<lance路径>::<表名>"）。
/// ensure_wide_table / ensure_chat_table 每次调用都会尝试 create_index，
/// 命中缓存后跳过重复的索引确保开销。小表（未建 ANN 索引）不入缓存，
/// 以便行数越过阈值后无需重启即可建立索引。
#[cfg(feature = "lance")]
static ENSURED_TABLES: std::sync::OnceLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::OnceLock::new();

/// 进程级"行数已确认越过 ANN 训练阈值"的表缓存（key 同 ensured_table_key，
/// 含 lance 数据集路径与表名）。行数跨过阈值后实际不会回落（即便删除导致
/// 回落，索引已存在，继续走索引路径也正确），命中后无需每次查询都 count_rows；
/// 未过阈值的表不入缓存，写入越过阈值后无需重启即可切回索引路径。
#[cfg(feature = "lance")]
static ANN_THRESHOLD_PASSED: std::sync::OnceLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::OnceLock::new();

/// 按路径复用 LanceDB 连接；未命中时新建并缓存。
///
/// 注意：不能在持锁期间 await `connect`——首连可能较慢（目录扫描/清单加载），
/// 持锁 await 会把所有其它路径的连接获取串行卡在同一把全局锁上。
/// 改为：锁内查缓存 → 未命中释放锁执行 connect → 重新加锁回填。
/// 并发窗口内可能有多个任务同时首连同一路径，回填时保留先到者。
#[cfg(feature = "lance")]
async fn connect_cached(path: &str) -> Result<Connection> {
    let cache = LANCE_CONNECTION_CACHE.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    {
        let guard = cache.lock().await;
        if let Some(conn) = guard.get(path) {
            return Ok(conn.clone());
        }
    }
    let conn = lancedb::connect(path)
        .execute()
        .await
        .map_err(|e| AppError::database(format!("连接 LanceDB 失败: {}", e)))?;
    let mut guard = cache.lock().await;
    Ok(guard.entry(path.to_string()).or_insert(conn).clone())
}

#[cfg(feature = "lance")]
fn ensured_table_key(path: &str, table_name: &str) -> String {
    format!("{}::{}", path, table_name)
}

#[cfg(feature = "lance")]
fn is_table_ensured(path: &str, table_name: &str) -> bool {
    ENSURED_TABLES
        .get_or_init(|| std::sync::Mutex::new(HashSet::new()))
        .lock()
        .map(|set| set.contains(&ensured_table_key(path, table_name)))
        .unwrap_or(false)
}

#[cfg(feature = "lance")]
fn mark_table_ensured(path: &str, table_name: &str) {
    if let Ok(mut set) = ENSURED_TABLES
        .get_or_init(|| std::sync::Mutex::new(HashSet::new()))
        .lock()
    {
        set.insert(ensured_table_key(path, table_name));
    }
}

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
    // ★ 2026-07 清理：删除 candidate_dim_values() 硬编码维度白名单。
    // 最后两处使用方（optimize_chat_tables、migrate_legacy_*）已改为按
    // LanceDB 实际存在的表枚举（existing_dim_tables），白名单不再有调用方。

    /// 从表名解析维度后缀（如 `kb_chunks_v2_d1792` → 1792）
    ///
    /// P1 修复：写入路径接受任意维度，但维护路径此前只遍历 `candidate_dim_values()`
    /// 硬编码白名单，非白名单维度（如 Matryoshka 截断的 1792/2560）写入后会成为
    /// "检索得到、删不掉、统计不到"的孤儿数据。改为按 LanceDB 实际存在的表枚举。
    #[cfg(feature = "lance")]
    fn parse_dim_from_table_name(name: &str, prefix: &str) -> Option<usize> {
        name.strip_prefix(prefix)
            .and_then(|suffix| suffix.parse::<usize>().ok())
    }

    /// 枚举 LanceDB 中实际存在的、带指定维度前缀的表（返回 (dim, table_name)，按 dim 升序）
    #[cfg(feature = "lance")]
    async fn existing_dim_tables(
        db: &lancedb::Connection,
        prefix: &str,
    ) -> Result<Vec<(usize, String)>> {
        let names = db
            .table_names()
            .execute()
            .await
            .map_err(|e| AppError::database(format!("枚举 Lance 表失败: {}", e)))?;
        let mut out: Vec<(usize, String)> = names
            .into_iter()
            .filter_map(|name| {
                Self::parse_dim_from_table_name(&name, prefix).map(|dim| (dim, name))
            })
            .collect();
        out.sort_unstable_by_key(|(dim, _)| *dim);
        Ok(out)
    }

    /// 只读打开指定维度的 KB 宽表。
    ///
    /// P1 修复：检索路径此前调用 `ensure_wide_table(查询向量维度)`，表不存在时会
    /// 静默创建一张空表并返回空结果——嵌入模型切换维度后所有历史数据"消失"且无任何
    /// 提示，同时读路径产生建表副作用。改为：
    /// - 表存在 → 返回 `Some(tbl)`；
    /// - 表不存在且库内没有任何 KB 维度表 → 返回 `None`（空库，正常返回空结果）；
    /// - 表不存在但存在其它维度的 KB 表 → 返回明确错误，提示嵌入模型维度不匹配需重建索引。
    #[cfg(feature = "lance")]
    async fn open_wide_table_for_read(&self, dim: usize) -> Result<Option<Table>> {
        let path = self.get_lance_path()?;
        let db = connect_cached(&path).await?;
        let table_name = format!("{}{}", KB_V2_TABLE_PREFIX, dim);
        match db.open_table(&table_name).execute().await {
            Ok(tbl) => Ok(Some(tbl)),
            Err(_) => {
                let existing = Self::existing_dim_tables(&db, KB_V2_TABLE_PREFIX)
                    .await
                    .unwrap_or_default();
                if existing.is_empty() {
                    // 空库：尚未写入任何向量，返回空结果是正确语义
                    Ok(None)
                } else {
                    let dims: Vec<usize> = existing.iter().map(|(d, _)| *d).collect();
                    warn!(
                        "⚠️ [LanceVector] 查询向量维度 {} 与库内既有维度 {:?} 不匹配，拒绝检索（嵌入模型可能已变更）",
                        dim, dims
                    );
                    Err(AppError::validation(format!(
                        "查询向量维度 {} 与知识库现有向量维度 {:?} 不匹配：嵌入模型可能已变更，请重建向量索引后再检索",
                        dim, dims
                    )))
                }
            }
        }
    }

    /// 只读打开指定维度的聊天向量表；表不存在返回 `None`（不创建表）。
    /// 与 KB 不同，聊天记忆检索是背景增强能力，维度不匹配时告警并返回空结果而非报错。
    #[cfg(feature = "lance")]
    async fn open_chat_table_for_read(&self, dim: usize) -> Result<Option<Table>> {
        let path = self.get_lance_path()?;
        let db = connect_cached(&path).await?;
        let table_name = format!("{}{}", CHAT_V2_TABLE_PREFIX, dim);
        match db.open_table(&table_name).execute().await {
            Ok(tbl) => Ok(Some(tbl)),
            Err(_) => {
                if let Ok(existing) = Self::existing_dim_tables(&db, CHAT_V2_TABLE_PREFIX).await {
                    if !existing.is_empty() {
                        let dims: Vec<usize> = existing.iter().map(|(d, _)| *d).collect();
                        warn!(
                            "⚠️ [LanceChat] 查询向量维度 {} 与聊天向量表既有维度 {:?} 不匹配，返回空结果（嵌入模型可能已变更）",
                            dim, dims
                        );
                    }
                }
                Ok(None)
            }
        }
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
        let db = connect_cached(&path).await?;

        let filter_expr =
            sub_library_id.map(|id| format!("sub_library_id = '{}'", id.replace("'", "''")));
        let mut chunk_count: usize = 0;
        let mut text_bytes: usize = 0;
        let mut embedding_bytes: usize = 0;

        // P1 修复：枚举实际存在的维度表，覆盖非白名单维度（如 1792/2560）的数据
        // P2 修复：行数用 count_rows 统计、文本字节只投影 text 列，
        // 向量字节按 行数 × 维度 × 4 计算，避免把整列 embedding 拉进内存
        for (dim, table_name) in Self::existing_dim_tables(&db, KB_V2_TABLE_PREFIX).await? {
            let tbl = match db.open_table(&table_name).execute().await {
                Ok(tbl) => tbl,
                Err(_) => continue,
            };

            let rows = tbl
                .count_rows(filter_expr.clone())
                .await
                .map_err(|e| AppError::database(e.to_string()))?;
            chunk_count += rows;
            embedding_bytes += rows * dim * std::mem::size_of::<f32>();
            if rows == 0 {
                continue;
            }

            let mut query = tbl.query().select(Select::columns(&["text"]));
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
                    text_bytes += text_arr.value(i).len();
                }
            }
        }

        Ok(LibrarySummary {
            chunk_count,
            text_bytes,
            embedding_bytes,
        })
    }

    /// 枚举实际存在的 KB 维度表名（P1 修复：不再依赖 candidate_dim_values 白名单）
    #[cfg(feature = "lance")]
    async fn existing_kb_table_names(db: &Connection) -> Vec<String> {
        Self::existing_dim_tables(db, KB_V2_TABLE_PREFIX)
            .await
            .map(|pairs| pairs.into_iter().map(|(_, name)| name).collect())
            .unwrap_or_default()
    }
    pub fn new(database: Arc<Database>) -> Result<Self> {
        // 在启用情况下，可在此读取维度 / 初始化 Lance 表等
        let store = Self {
            database,
            dim: None,
        };
        // 先确保基础 RAG 表结构（SQLite 端）存在
        store.ensure_base_rag_schema()?;
        Ok(store)
    }

    #[cfg(feature = "lance")]
    pub fn count_lance_rows_sync(&self) -> Option<usize> {
        let path = match self.get_lance_path() {
            Ok(p) => p,
            Err(err) => {
                error!("⚠️ [Lance统计] 无法解析 Lance 路径: {}", err);
                return None;
            }
        };
        let fut = async move {
            let db = connect_cached(&path).await.ok()?;
            let mut total: usize = 0;
            // P2 修复：用 count_rows 元数据统计代替全表扫描（此前连 embedding 列也一并读出）
            for name in Self::existing_kb_table_names(&db).await {
                if let Ok(tbl) = db.open_table(&name).execute().await {
                    if let Ok(count) = tbl.count_rows(None::<String>).await {
                        total += count;
                    }
                }
            }
            Some(total)
        };
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => tokio::task::block_in_place(|| handle.block_on(fut)),
            Err(_) => {
                let rt = match tokio::runtime::Runtime::new() {
                    Ok(rt) => rt,
                    Err(err) => {
                        error!("⚠️ [Lance统计] 创建临时 Tokio 运行时失败: {}", err);
                        return None;
                    }
                };
                rt.block_on(fut)
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
        let conn = connect_cached(&path).await?;
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
        }
        // 无论是否有表被优化都记录时间戳：否则空 scope（如无 KB 表）每次触发
        // 都会重新枚举+尝试打开全部表，节流形同虚设
        self.record_optimization_timestamp(scope);
        Ok(optimized)
    }

    #[cfg(feature = "lance")]
    pub async fn optimize_chat_tables(
        &self,
        older_than_days: Option<u64>,
        delete_unverified: Option<bool>,
        force: bool,
    ) -> Result<usize> {
        // P1 修复：按 LanceDB 实际存在的表枚举，不再依赖 candidate_dim_values()
        // 白名单——非白名单维度（如 Matryoshka 截断的 1792/2560）的表此前会被漏掉
        let path = self.get_lance_path()?;
        let db = connect_cached(&path).await?;
        let mut names: Vec<String> = Vec::new();
        for (_dim, name) in Self::existing_dim_tables(&db, CHAT_V2_TABLE_PREFIX).await? {
            names.push(name);
        }
        for (_dim, name) in Self::existing_dim_tables(&db, CHAT_LEGACY_TABLE_PREFIX).await? {
            names.push(name);
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

    /// 优化遗留 KB 宽表（`kb_chunks_v2_d*`）：Compact + Prune + Index。
    ///
    /// 此前 `optimize_table_internal` 唯一调用链只覆盖聊天表，KB 宽表从未被
    /// compact/prune，删除产生的旧版本与碎片文件会无限累积。节流策略与聊天表
    /// 一致（30 分钟），但使用独立的 scope key（`lance.optimize.last.kb`）。
    #[cfg(feature = "lance")]
    pub async fn optimize_kb_tables(
        &self,
        older_than_days: Option<u64>,
        delete_unverified: Option<bool>,
        force: bool,
    ) -> Result<usize> {
        let path = self.get_lance_path()?;
        let db = connect_cached(&path).await?;
        let mut names: Vec<String> = Vec::new();
        for (_dim, name) in Self::existing_dim_tables(&db, KB_V2_TABLE_PREFIX).await? {
            names.push(name);
        }

        let optimized = self
            .optimize_table_group(
                "kb",
                OPTIMIZE_MIN_INTERVAL_KB_SECS,
                names,
                older_than_days,
                delete_unverified,
                force,
            )
            .await?;
        if optimized > 0 {
            info!("✅ [Lance优化] KB 宽表优化完成（{} 张表）", optimized);
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
                .unwrap_or(false);

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
    fn ann_version_key(table_name: &str) -> String {
        format!("rag.lance.ann.version.{}", table_name)
    }

    #[cfg(feature = "lance")]
    fn should_rebuild_ann(&self, table_name: &str) -> bool {
        self.database
            .get_setting(Self::ann_version_key(table_name).as_str())
            .ok()
            .flatten()
            .map(|v| v != ANN_INDEX_VERSION)
            .unwrap_or(true)
    }

    #[cfg(feature = "lance")]
    fn record_ann_version(&self, table_name: &str) {
        if let Err(err) = self.database.save_setting(
            Self::ann_version_key(table_name).as_str(),
            ANN_INDEX_VERSION,
        ) {
            warn!(
                "⚠️ [LanceIndex] 保存 ANN 索引版本信息失败 {}: {}",
                table_name, err
            );
        }
    }

    /// 查询是否应绕过 ANN 索引走精确扫描（行数低于训练阈值的小表）。
    /// 出错时保守返回 false（沿用索引路径）。
    ///
    /// 性能：此前每次查询都 count_rows。行数跨过 256 阈值后不会回落，故一旦
    /// 确认过阈值即记入进程级缓存（key 含 lance 数据集路径+表名），后续直接
    /// 返回 false；未过阈值的表继续每次 count，写入越过阈值后无需重启即生效。
    #[cfg(feature = "lance")]
    async fn should_bypass_ann(tbl: &Table) -> bool {
        let key = ensured_table_key(tbl.dataset_uri(), tbl.name());
        let passed_set = ANN_THRESHOLD_PASSED.get_or_init(|| std::sync::Mutex::new(HashSet::new()));
        if passed_set
            .lock()
            .map(|set| set.contains(&key))
            .unwrap_or(false)
        {
            return false;
        }
        match tbl.count_rows(None::<String>).await {
            Ok(rows) => {
                if rows >= MIN_ROWS_FOR_ANN_INDEX {
                    if let Ok(mut set) = passed_set.lock() {
                        set.insert(key);
                    }
                    false
                } else {
                    true
                }
            }
            Err(_) => false,
        }
    }

    /// 确保 embedding 列 ANN 索引为显式 IVF-PQ + Cosine。
    ///
    /// 度量一致性修复：此前用 `Index::Auto`（以 L2 训练）建索引、查询时却指定
    /// `DistanceType::Cosine`，索引分区与查询度量不一致导致召回不可控。现改为
    /// 显式 Cosine 训练，并通过 SQLite 设置项记录索引版本，检测到旧版本
    /// （含历史 Auto/L2 索引）时强制重建一次。
    ///
    /// 返回"是否可缓存"：小表（行数低于 `MIN_ROWS_FOR_ANN_INDEX`）跳过建索引
    /// 并返回 false，使其在行数增长跨过阈值后仍会重试。
    #[cfg(feature = "lance")]
    async fn ensure_embedding_ann_index(&self, tbl: &Table, table_name: &str) -> bool {
        let row_count = match tbl.count_rows(None::<String>).await {
            Ok(count) => count,
            Err(err) => {
                warn!(
                    "⚠️ [LanceIndex] 统计 {} 行数失败，跳过 ANN 索引确保: {}",
                    table_name, err
                );
                return false;
            }
        };
        if row_count < MIN_ROWS_FOR_ANN_INDEX {
            debug!(
                "ℹ️ [LanceIndex] {} 行数 {} 低于阈值 {}，跳过 ANN 索引（查询走精确扫描）",
                table_name, row_count, MIN_ROWS_FOR_ANN_INDEX
            );
            return false;
        }

        let must_replace = self.should_rebuild_ann(table_name);
        let embed_idx_start = Instant::now();
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
                self.record_ann_version(table_name);
                debug!(
                    "⏱️ [LanceIndex] ensured IVF-PQ(Cosine) index on {} in {}ms",
                    table_name,
                    embed_idx_start.elapsed().as_millis()
                );
                true
            }
            Err(err) => {
                let msg = err.to_string();
                if msg.contains("already exists") && !must_replace {
                    // 版本已确认为 Cosine，索引存在即视为就绪
                    true
                } else {
                    warn!(
                        "⚠️ [LanceIndex] embedding index ensure failed on {}: {}",
                        table_name, msg
                    );
                    false
                }
            }
        }
    }

    /// 为过滤列补建标量索引（BTree/Bitmap）。失败仅降级告警，返回是否全部成功。
    #[cfg(feature = "lance")]
    async fn ensure_scalar_indexes(
        tbl: &Table,
        table_name: &str,
        btree_columns: &[&str],
        bitmap_columns: &[&str],
    ) -> bool {
        let mut all_ok = true;
        let mut plans: Vec<(&str, Index)> = Vec::new();
        for col in btree_columns.iter().copied() {
            plans.push((col, Index::BTree(BTreeIndexBuilder::default())));
        }
        for col in bitmap_columns.iter().copied() {
            plans.push((col, Index::Bitmap(BitmapIndexBuilder::default())));
        }
        for (column, index) in plans {
            if let Err(err) = tbl
                .create_index(&[column], index)
                .replace(false)
                .execute()
                .await
            {
                let msg = err.to_string();
                if !msg.contains("already exists") {
                    warn!(
                        "⚠️ [LanceIndex] 标量索引确保失败 {}.{}: {}",
                        table_name, column, msg
                    );
                    all_ok = false;
                }
            }
        }
        all_ok
    }

    #[cfg(feature = "lance")]
    async fn ensure_wide_table(&self, dim: usize) -> Result<Table> {
        let path = self.get_lance_path()?;
        let db = connect_cached(&path).await?;
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

        // 命中缓存：本进程内已确保过索引，直接返回，避免每次写入都重复 create_index
        if is_table_ensured(&path, &table_name) {
            return Ok(tbl);
        }

        let ann_ok = self.ensure_embedding_ann_index(&tbl, &table_name).await;

        let rebuild_fts = self.should_rebuild_fts(&table_name, KB_FTS_VERSION);
        let fts_idx_start = Instant::now();
        let fts_builder = self.build_fts_index_builder();
        let fts_res = tbl
            .create_index(&["text"], Index::FTS(fts_builder))
            .replace(rebuild_fts)
            .execute()
            .await;
        let mut fts_ok = true;
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
                    fts_ok = false;
                } else if rebuild_fts {
                    warn!(
                        "⚠️ [LanceIndex] 请求重建 {} FTS 但失败: {}",
                        table_name, msg
                    );
                    fts_ok = false;
                } else {
                    self.record_fts_version(&table_name, KB_FTS_VERSION);
                }
            }
        }

        let scalar_ok = Self::ensure_scalar_indexes(
            &tbl,
            &table_name,
            &["chunk_id", "document_id", "sub_library_id"],
            &[],
        )
        .await;

        // 小表（ann_ok=false）不入缓存，行数跨过阈值后可自动建立 ANN 索引
        if ann_ok && fts_ok && scalar_ok {
            mark_table_ensured(&path, &table_name);
        }
        Ok(tbl)
    }

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

        // ★ 2026-07 修复：upsert 由"先删后插"改为原子 merge_insert。
        // 旧实现非原子（delete 成功 add 失败丢数据；并发写产生重复行，只能靠
        // 读侧按 chunk_id 去重兜底），且每次写入产生两个表版本。merge_insert
        // 按 chunk_id 匹配：命中则整行更新，未命中则插入，单版本原子完成。
        let (schema, batch) = self.build_batch_embeddings_wide(dim, rows)?;
        let iter = RecordBatchIterator::new(vec![Ok(batch)].into_iter(), schema);
        let mut builder = tbl.merge_insert(&["chunk_id"]);
        builder.when_matched_update_all(None);
        builder.when_not_matched_insert_all();
        builder.execute(Box::new(iter)).await.map_err(|e| {
            AppError::database(format!("写入 Lance 扩展表失败 (merge_insert): {}", e))
        })?;
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
        // P1 修复：检索是只读路径，不创建表；维度不匹配时报错而非静默空结果
        let Some(tbl) = self.open_wide_table_for_read(dim).await? else {
            return Ok(Vec::new());
        };

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
            // P2 修复：只投影结果构造实际读取的列，避免整列拉回 embedding
            // （每行 dim*4 字节）后又在结果行填 Vec::new() 丢弃；
            // `_distance` 由引擎自动附加，不放进 select
            .select(Select::columns(KB_SEARCH_RESULT_COLUMNS))
            .limit(fetch_limit);
        // 小表未建 ANN 索引（或残留旧 L2 索引），显式走精确扫描保证召回
        if Self::should_bypass_ann(&tbl).await {
            query = query.bypass_vector_index();
        }
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
            // 空表/无匹配时可能返回不含数据列的 batch（参考
            // vfs::lance_store::extract_search_results），跳过而非报"缺列"错误
            if batch.num_rows() == 0 || schema.index_of("chunk_id").is_err() {
                continue;
            }
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
        // P1 修复：检索是只读路径，不创建表；维度不匹配时报错而非静默空结果
        let Some(tbl) = self.open_wide_table_for_read(dim).await? else {
            return Ok(Vec::new());
        };

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
            // P2 修复：只投影结果构造实际读取的列（execute_hybrid 的 FTS/向量
            // 两条支路共用本 select）；`_distance`/`_score`/`_relevance_score`
            // 由引擎与 reranker 自动附加，不放进 select
            .select(Select::columns(KB_SEARCH_RESULT_COLUMNS))
            .limit(fetch_limit);
        // 小表未建 ANN 索引（或残留旧 L2 索引），混合检索的向量支路走精确扫描
        if Self::should_bypass_ann(&tbl).await {
            query = query.bypass_vector_index();
        }
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
            // 空结果兜底：混合检索无匹配时 RRF reranker 可能返回只含分数列、
            // 不含数据列的 batch（参考 vfs::lance_store::extract_search_results_hybrid），
            // 此时跳过而非报"缺列"错误
            if batch.num_rows() == 0 || schema.index_of("chunk_id").is_err() {
                continue;
            }
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
        let db = connect_cached(&path).await?;
        let mut tables = Vec::new();
        // P1 修复：枚举实际存在的维度表，覆盖非白名单维度
        for (_dim, table_name) in Self::existing_dim_tables(&db, CHAT_V2_TABLE_PREFIX).await? {
            if let Ok(tbl) = db.open_table(&table_name).execute().await {
                tables.push(tbl);
            }
        }
        Ok(tables)
    }

    /// ⚠️ 退役计划（2026-07）：当前无任何外部调用方（聊天记忆检索链路已下线），
    /// 保留以兼容可能的并行任务；确认无依赖后随聊天向量检索 API 一并移除。
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
        // P1 修复：检索是只读路径，不创建表；维度不匹配时告警并返回空结果
        let Some(tbl) = self.open_chat_table_for_read(dim).await? else {
            return Ok(Vec::new());
        };

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
            // P2 修复：只投影结果构造实际读取的列，排除 embedding；
            // `_distance` 由引擎自动附加
            .select(Select::columns(CHAT_SEARCH_RESULT_COLUMNS))
            .limit(fetch_limit);
        // 小表未建 ANN 索引（或残留旧 L2 索引），显式走精确扫描保证召回
        if Self::should_bypass_ann(&tbl).await {
            query = query.bypass_vector_index();
        }
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
            // 空表/无匹配时可能返回不含数据列的 batch，跳过而非报"缺列"错误
            if batch.num_rows() == 0 || schema.index_of("message_id").is_err() {
                continue;
            }
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

    /// ⚠️ 退役计划（2026-07）：当前无任何外部调用方，保留以兼容可能的并行任务。
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

    /// ⚠️ 退役计划（2026-07）：当前无任何外部调用方，保留以兼容可能的并行任务。
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
                    .select(Select::columns(&["message_id"]))
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

    /// ⚠️ 退役计划（2026-07）：当前无任何外部调用方，保留以兼容可能的并行任务。
    #[cfg(feature = "lance")]
    pub async fn count_chat_embeddings(&self) -> Result<usize> {
        let path = self.get_lance_path()?;
        let db = connect_cached(&path).await?;
        let mut total = 0usize;
        // P1 修复：枚举实际存在的维度表，覆盖非白名单维度
        for (_dim, table_name) in Self::existing_dim_tables(&db, CHAT_V2_TABLE_PREFIX).await? {
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
        let db = connect_cached(&path).await?;

        let mut all_ids: HashSet<String> = HashSet::new();
        // P1 修复：枚举实际存在的维度表，覆盖非白名单维度
        // P2 修复：只投影 message_id 列，避免全行（含 embedding）扫描
        for (_dim, table_name) in Self::existing_dim_tables(&db, CHAT_V2_TABLE_PREFIX).await? {
            let tbl = match db.open_table(&table_name).execute().await {
                Ok(tbl) => tbl,
                Err(_) => continue,
            };

            let mut stream = tbl
                .query()
                .select(Select::columns(&["message_id"]))
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
        // P2 兜底：写入路径已改为原子 merge_insert，不再产生新的重复行；
        // 但历史"先删后插"时期的数据可能残留重复 chunk_id 行，检索侧仍按
        // chunk_id 去重，保留分数最高的一行（rows 已按分数降序）
        let mut seen_chunk_ids: HashSet<String> = HashSet::new();
        let mut out: Vec<RetrievedChunk> = Vec::with_capacity(top_k);

        for (row, score) in rows.into_iter() {
            if !seen_chunk_ids.insert(row.chunk_id.clone()) {
                continue;
            }
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
        let db = connect_cached(&path).await?;
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

        // 命中缓存：本进程内已确保过索引，直接返回
        if is_table_ensured(&path, &table_name) {
            return Ok(tbl);
        }

        let ann_ok = self.ensure_embedding_ann_index(&tbl, &table_name).await;

        let fts_builder = self.build_fts_index_builder();
        let rebuild_fts = self.should_rebuild_fts(&table_name, CHAT_FTS_VERSION);
        let fts_res = tbl
            .create_index(&["text"], Index::FTS(fts_builder))
            .replace(rebuild_fts)
            .execute()
            .await;
        let mut fts_ok = true;
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
                    fts_ok = false;
                }
            }
        }

        let scalar_ok =
            Self::ensure_scalar_indexes(&tbl, &table_name, &["message_id"], &["role"]).await;

        if ann_ok && fts_ok && scalar_ok {
            mark_table_ensured(&path, &table_name);
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

        // ★ 2026-07 修复：upsert 由"先删后插"改为原子 merge_insert（按
        // message_id 匹配，该表主键列，见 ensure_chat_table 的 schema），
        // 消除 delete 成功 add 失败丢数据与并发重复行的窗口，版本数减半。
        let (schema, batch) = self.build_batch_embeddings_chat(dim, rows)?;
        let iter = RecordBatchIterator::new(vec![Ok(batch)].into_iter(), schema);
        let mut builder = tbl.merge_insert(&["message_id"]);
        builder.when_matched_update_all(None);
        builder.when_not_matched_insert_all();
        builder
            .execute(Box::new(iter))
            .await
            .map_err(|e| AppError::database(format!("写入聊天向量失败 (merge_insert): {}", e)))?;
        Ok(rows.len())
    }

    #[cfg(feature = "lance")]
    pub async fn delete_chat_embeddings_by_ids(&self, ids: &[String]) -> Result<()> {
        if ids.is_empty() {
            return Ok(());
        }
        // P1 修复：删除路径纳入 KB_MUTATION_LOCK，与破坏性 clear 操作互斥
        let _mutation_guard = KB_MUTATION_LOCK.read().await;
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
                // P2 修复：此前 `let _ =` 吞掉删除失败，调用方（清空/孤儿清理）
                // 会误报成功；现改为错误上抛
                tbl.delete(expr.as_str())
                    .await
                    .map_err(|err| AppError::database(format!("删除聊天向量失败: {}", err)))?;
            }
        }
        Ok(())
    }

    /// ⚠️ 退役计划（2026-07）：当前无任何外部调用方，保留以兼容可能的并行任务。
    #[cfg(feature = "lance")]
    pub async fn knn_chat_ids_via_lance(
        &self,
        query_embedding: &[f32],
        limit: usize,
    ) -> Result<Vec<(String, f32)>> {
        use futures_util::TryStreamExt;
        let fetch_limit: usize = std::cmp::max(1, limit).saturating_mul(10);
        // P1 修复：检索是只读路径，不创建表；维度不匹配时告警并返回空结果
        let Some(tbl) = self.open_chat_table_for_read(query_embedding.len()).await? else {
            return Ok(Vec::new());
        };
        let mut query = tbl
            .vector_search(query_embedding)
            .map_err(|e| AppError::database(e.to_string()))?
            .distance_type(DistanceType::Cosine)
            // P2 修复：下游只读 message_id（`_distance` 由引擎自动附加），
            // 无需拉回整行（含 embedding）
            .select(Select::columns(&["message_id"]))
            .limit(fetch_limit);
        // 小表未建 ANN 索引（或残留旧 L2 索引），显式走精确扫描保证召回
        if Self::should_bypass_ann(&tbl).await {
            query = query.bypass_vector_index();
        }
        let mut stream = query
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
            // 空表/无匹配时可能返回不含数据列的 batch，跳过而非报"缺列"错误
            if batch.num_rows() == 0 || schema.index_of("message_id").is_err() {
                continue;
            }
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

    /// 加载混合检索的候选集/截断参数。
    ///
    /// ★ 2026-07 清理：此前名为 load_rrf_config，还会读取
    /// `rag.hybrid.rrf.k` / `rag.hybrid.rrf.fts_weight` / `rag.hybrid.rrf.vec_weight`
    /// 三个设置项，但融合打分实际由 LanceDB `execute_hybrid` 的内置 reranker
    /// 完成，这三项加载后从未生效，现已移除以免造成"可调参"的假象。
    /// 返回 (fts_mul, vec_mul, max_cands, per_doc_cap, fetch_mul)。
    #[cfg(feature = "lance")]
    fn load_hybrid_config(&self) -> (usize, usize, usize, usize, usize) {
        // Defaults
        let mut fts_mul: usize = 20;
        let mut vec_mul: usize = 3;
        let mut max_cands: usize = 1000;
        let mut per_doc_cap: usize = 2;
        let mut fetch_mul: usize = 3;

        let get = |key: &str| self.database.get_setting(key).ok().flatten();
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
        (fts_mul, vec_mul, max_cands, per_doc_cap, fetch_mul)
    }
}

impl LanceVectorStore {
    /// 按 chunk_id 删除 Lance 宽表数据（不加锁版本）。
    ///
    /// 调用方必须已持有 `KB_MUTATION_LOCK`（读或写）。tokio RwLock 为写优先，
    /// 同一任务内嵌套二次加读锁在有等待写者时会死锁，故删除入口统一在
    /// trait 方法层加锁一次，内部复用本函数。
    #[cfg(feature = "lance")]
    async fn delete_chunks_by_ids_inner(&self, chunk_ids: &[String]) -> Result<()> {
        if chunk_ids.is_empty() {
            return Ok(());
        }

        let path = self.get_lance_path()?;
        let db = connect_cached(&path).await?;

        let delete_batches: Vec<Vec<String>> = chunk_ids
            .chunks(900)
            .map(|batch| batch.iter().map(|id| id.replace("'", "''")).collect())
            .collect();

        // P1 修复：枚举实际存在的维度表，非白名单维度的数据也能被删除
        for (_dim, wide_name) in Self::existing_dim_tables(&db, KB_V2_TABLE_PREFIX).await? {
            let tbl = match db.open_table(&wide_name).execute().await {
                Ok(tbl) => tbl,
                Err(err) => {
                    return Err(AppError::database(format!(
                        "打开 Lance 表 {} 失败，中止删除以避免残留: {}",
                        wide_name, err
                    )));
                }
            };
            for ids in &delete_batches {
                let expr = format!(
                    "chunk_id IN ({})",
                    ids.iter()
                        .map(|s| format!("'{}'", s))
                        .collect::<Vec<_>>()
                        .join(",")
                );
                // P2 修复：删除失败此前仅 warn 吞错，调用方误以为删除成功而
                // 留下"检索得到但已应删除"的僵尸向量。现改为错误上抛。
                tbl.delete(expr.as_str()).await.map_err(|err| {
                    AppError::database(format!("从表 {} 删除 chunk 失败: {}", wide_name, err))
                })?;
            }
        }

        Ok(())
    }

    // 纯 SQLite 元数据表结构，无 lance 依赖；`new()` 在所有 feature 组合下都会调用
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

        // ★ 2026-07：不再创建僵尸表 rag_vectors。新写入路径早已不落该表，
        // 此前仍无条件 CREATE 导致新装环境凭空多一张空表。历史库中已存在的
        // rag_vectors 仅保留只读迁移用途（见 MigrationCoordinator::migrate_sqlite_vectors，
        // 内部有 table_exists 守卫），clear_all 亦按存在性判断后再清理。

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

// 未启用 lance 时的外部调用面 stub（commands.rs / lib.rs 启动优化仍可编译运行）
#[cfg(not(feature = "lance"))]
impl LanceVectorStore {
    pub async fn optimize_chat_tables(
        &self,
        _older_than_days: Option<u64>,
        _delete_unverified: Option<bool>,
        _force: bool,
    ) -> Result<usize> {
        debug!("[LanceVectorStore] optimize_chat_tables skipped: lance feature disabled");
        Ok(0)
    }

    pub async fn optimize_kb_tables(
        &self,
        _older_than_days: Option<u64>,
        _delete_unverified: Option<bool>,
        _force: bool,
    ) -> Result<usize> {
        debug!("[LanceVectorStore] optimize_kb_tables skipped: lance feature disabled");
        Ok(0)
    }

    pub async fn delete_chat_embeddings_by_ids(&self, _ids: &[String]) -> Result<()> {
        debug!("[LanceVectorStore] delete_chat_embeddings_by_ids skipped: lance feature disabled");
        Ok(())
    }
}

#[cfg(feature = "lance")]
#[async_trait]
impl VectorStore for LanceVectorStore {
    async fn add_chunks(&self, chunks: Vec<DocumentChunkWithEmbedding>) -> Result<()> {
        {
            if chunks.is_empty() {
                return Ok(());
            }
            let _mutation_guard = KB_MUTATION_LOCK.read().await;
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

            // ★ P1（2026-07 修复）：与 VFS 栈契约对齐——先写 Lance 再写 SQLite。
            // 旧顺序（先 SQLite 后 Lance）在 Lance 写入失败时留下脏元数据：
            // rag_document_chunks 里有块、Lance 无向量，文档呈"已索引但检索不到"。
            // 现在 Lance 失败直接中止（SQLite 未动，可整体重试）；SQLite 失败则
            // 补偿删除刚写入的 Lance 行，两侧回到写入前状态。
            self.write_chunks_to_wide_table(dim, &rows).await?;
            if let Err(sqlite_err) = self.write_chunks_to_sqlite(&rows) {
                let chunk_ids: Vec<String> = rows.iter().map(|r| r.chunk_id.clone()).collect();
                // 已持有 KB_MUTATION_LOCK 读锁，直接用不加锁的内部删除
                if let Err(cleanup_err) = self.delete_chunks_by_ids_inner(&chunk_ids).await {
                    return Err(AppError::database(format!(
                        "写入 SQLite 分块元数据失败: {}; 且补偿删除 Lance 行失败（存在孤儿向量，需重建该文档索引）: {}",
                        sqlite_err, cleanup_err
                    )));
                }
                return Err(sqlite_err);
            }
            Ok(())
        }
    }

    async fn search_similar_chunks(
        &self,
        query_embedding: Vec<f32>,
        top_k: usize,
    ) -> Result<Vec<RetrievedChunk>> {
        {
            let (_, vec_mul, max_cands, per_doc_cap, _) = self.load_hybrid_config();
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
            let (_, vec_mul, max_cands, per_doc_cap, _) = self.load_hybrid_config();
            let rows = self
                .vector_search_rows(
                    &query_embedding,
                    top_k,
                    sub_library_ids.as_deref(),
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

            let (fts_mul, vec_mul, max_cands, per_doc_cap, fetch_mul) = self.load_hybrid_config();
            let effective_mul = std::cmp::max(vec_mul, std::cmp::max(fts_mul, fetch_mul));
            let sub_slice = sub_library_ids.as_deref();

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
            // P1 修复：删除路径此前不参与 KB_MUTATION_LOCK，可能与 clear_all 竞争
            let _mutation_guard = KB_MUTATION_LOCK.read().await;
            let chunks = self.load_document_chunks(document_id).await?;
            let chunk_ids: Vec<String> = chunks.into_iter().map(|c| c.id).collect();
            if !chunk_ids.is_empty() {
                self.delete_chunks_by_ids_inner(&chunk_ids).await?;
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
            // P1 修复：删除路径此前不参与 KB_MUTATION_LOCK，可能与 clear_all 竞争
            let _mutation_guard = KB_MUTATION_LOCK.read().await;
            let chunks = self.load_document_chunks(document_id).await?;
            let chunk_ids: Vec<String> = chunks.into_iter().map(|c| c.id).collect();
            if !chunk_ids.is_empty() {
                self.delete_chunks_by_ids_inner(&chunk_ids).await?;
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
            // P1 修复：删除路径此前不参与 KB_MUTATION_LOCK，可能与 clear_all 竞争
            let _mutation_guard = KB_MUTATION_LOCK.read().await;
            self.delete_chunks_by_ids_inner(&chunk_ids).await
        }
    }

    async fn load_document_chunks(&self, document_id: &str) -> Result<Vec<DocumentChunk>> {
        #[cfg(feature = "lance")]
        {
            use futures_util::TryStreamExt;
            use std::collections::HashMap;

            let path = self.get_lance_path()?;
            let db = connect_cached(&path).await?;

            let filter_expr = format!("document_id = '{}'", document_id.replace("'", "''"));
            let mut chunk_rows: Vec<LanceChunkRow> = Vec::new();
            let mut seen_chunk_ids: std::collections::HashSet<String> =
                std::collections::HashSet::new();

            // P1 修复：枚举实际存在的维度表且不在首个非空表提前 break —— 模型切换期间
            // 文档可能同时分布在多个维度表，需全部收集（按 chunk_id 去重）
            for (_dim, table_name) in Self::existing_dim_tables(&db, KB_V2_TABLE_PREFIX).await? {
                let tbl = match db.open_table(&table_name).execute().await {
                    Ok(tbl) => tbl,
                    Err(_) => continue,
                };

                // P2 修复：只投影元数据列，避免读出整列 embedding
                let mut query = tbl.query().select(Select::columns(&[
                    "chunk_id",
                    "document_id",
                    "sub_library_id",
                    "chunk_index",
                    "text",
                    "metadata",
                    "created_at",
                ]));
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
                    for row in Self::extract_chunk_rows_from_batch(&batch)? {
                        if seen_chunk_ids.insert(row.chunk_id.clone()) {
                            chunk_rows.push(row);
                        }
                    }
                }
            }

            if chunk_rows.is_empty() {
                return Ok(Vec::new());
            }

            chunk_rows.sort_by_key(|a| a.chunk_index);

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

            conn.query_row("SELECT COUNT(*) FROM rag_documents", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap_or(0) as usize
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
        let _mutation_guard = KB_MUTATION_LOCK.write().await;
        // Clear and verify every actual KB table before deleting SQLite
        // metadata. The previous implementation swallowed connect/open/delete
        // errors and could report success while searchable vectors remained.
        let path = self.get_lance_path()?;
        let db = connect_cached(&path).await?;
        let mut table_names: Vec<String> = Self::existing_dim_tables(&db, KB_V2_TABLE_PREFIX)
            .await?
            .into_iter()
            .map(|(_, name)| name)
            .collect();
        table_names.extend(
            Self::existing_dim_tables(&db, KB_LEGACY_TABLE_PREFIX)
                .await?
                .into_iter()
                .map(|(_, name)| name),
        );
        table_names.sort();
        table_names.dedup();

        for name in table_names {
            let table = db.open_table(&name).execute().await.map_err(|e| {
                AppError::database(format!("打开待清空 Lance 表 {} 失败: {}", name, e))
            })?;
            table
                .delete("true")
                .await
                .map_err(|e| AppError::database(format!("清空 Lance 表 {} 失败: {}", name, e)))?;
            let remaining = table.count_rows(None::<String>).await.map_err(|e| {
                AppError::database(format!("校验 Lance 表 {} 清空结果失败: {}", name, e))
            })?;
            if remaining != 0 {
                return Err(AppError::database(format!(
                    "Lance 表 {} 清空后仍残留 {} 行",
                    name, remaining
                )));
            }
        }

        {
            let conn = self
                .database
                .get_conn_safe()
                .map_err(|e| AppError::database(e.to_string()))?;
            {
                let tx = conn
                    .unchecked_transaction()
                    .map_err(|e| AppError::database(format!("开始事务失败: {}", e)))?;
                // rag_vectors 已停止创建（仅历史库存在），按存在性判断后清理
                let legacy_vectors_exists: bool = tx
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='rag_vectors')",
                        [],
                        |row| row.get(0),
                    )
                    .unwrap_or(false);
                if legacy_vectors_exists {
                    tx.execute("DELETE FROM rag_vectors", [])
                        .map_err(|e| AppError::database(e.to_string()))?;
                }
                tx.execute("DELETE FROM rag_document_chunks", [])
                    .map_err(|e| AppError::database(e.to_string()))?;
                tx.execute("DELETE FROM rag_documents", [])
                    .map_err(|e| AppError::database(e.to_string()))?;
                tx.commit()
                    .map_err(|e| AppError::database(format!("提交事务失败: {}", e)))?;
            }
        }

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
    // ★ 2026-07 死代码清理：删除本 impl 块中三个无任何调用方的私有函数
    // `fetch_chunks_by_ids_in_order` / `cosine_similarity` / `knn_ids_via_lance`。

    /// 自动迁移：协调 SQLite 旧向量、旧 Lance 表与聊天索引到最新 Lance 宽表结构。
    #[cfg(feature = "lance")]
    #[deprecated(note = "死入口：当前无任何调用方（启动流程已不再触发遗留迁移）。\
                保留供手工数据抢修使用，确认无并行任务依赖后可删除。")]
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
        // P1 修复：枚举 LanceDB 实际存在的旧表，不再依赖 candidate_dim_values()
        // 白名单，避免漏掉非常见维度的遗留数据
        let db = connect_cached(&self.lance_path).await?;
        let legacy_tables =
            LanceVectorStore::existing_dim_tables(&db, KB_LEGACY_TABLE_PREFIX).await?;
        for (dim, legacy_table_name) in legacy_tables {
            let category = format!("{}_{}", KB_LEGACY_TABLE_PREFIX, dim);
            self.ensure_progress_record(&category)?;
            let mut progress = self.load_progress(&category)?;
            if progress.status == "completed" {
                continue;
            }

            let legacy_tbl = match self.open_table(&legacy_table_name).await? {
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
        // P1 修复：枚举 LanceDB 实际存在的旧表，不再依赖 candidate_dim_values() 白名单
        let db = connect_cached(&self.lance_path).await?;
        let legacy_tables =
            LanceVectorStore::existing_dim_tables(&db, CHAT_LEGACY_TABLE_PREFIX).await?;
        for (dim, legacy_table_name) in legacy_tables {
            let category = format!("chat_legacy_{}", dim);
            self.ensure_progress_record(&category)?;
            let mut progress = self.load_progress(&category)?;
            if progress.status == "completed" {
                continue;
            }

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

    // ★ 2026-07 死代码清理：删除无调用方的 `spawn_verification_retry`
    // （其唯一潜在触发点 schedule_chat_backfill 早已被注释停用）。

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
        let db = connect_cached(&self.lance_path).await?;
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
            builder = builder.only_if(format!("_rowid > {}", cursor));
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
            builder = builder.only_if(format!("_rowid > {}", cursor));
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
        let db = connect_cached(&self.lance_path).await?;
        let mut total = 0usize;
        // P1 修复：枚举实际存在的维度表，覆盖非白名单维度
        for (_dim, table_name) in
            LanceVectorStore::existing_dim_tables(&db, KB_V2_TABLE_PREFIX).await?
        {
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
        let db = connect_cached(&self.lance_path).await?;
        let mut total = 0usize;
        // P1 修复：枚举实际存在的维度表，覆盖非白名单维度
        for (_dim, table_name) in
            LanceVectorStore::existing_dim_tables(&db, CHAT_V2_TABLE_PREFIX).await?
        {
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
        if !blob.len().is_multiple_of(4) {
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

#[cfg(all(test, feature = "lance"))]
mod tests {
    use super::*;

    /// P1 回归：维度表名解析必须覆盖任意维度（含非白名单维度），且拒绝无关表名
    #[test]
    fn parse_dim_from_table_name_accepts_any_dim_and_rejects_others() {
        // 白名单维度
        assert_eq!(
            LanceVectorStore::parse_dim_from_table_name("kb_chunks_v2_d1024", KB_V2_TABLE_PREFIX),
            Some(1024)
        );
        // 非白名单维度（Matryoshka 截断等）也必须能识别
        assert_eq!(
            LanceVectorStore::parse_dim_from_table_name("kb_chunks_v2_d1792", KB_V2_TABLE_PREFIX),
            Some(1792)
        );
        assert_eq!(
            LanceVectorStore::parse_dim_from_table_name("kb_chunks_v2_d2560", KB_V2_TABLE_PREFIX),
            Some(2560)
        );
        // 前缀不符 / 后缀非数字 → None
        assert_eq!(
            LanceVectorStore::parse_dim_from_table_name(
                "chat_embeddings_v2_d1024",
                KB_V2_TABLE_PREFIX
            ),
            None
        );
        assert_eq!(
            LanceVectorStore::parse_dim_from_table_name("kb_chunks_v2_dabc", KB_V2_TABLE_PREFIX),
            None
        );
        assert_eq!(
            LanceVectorStore::parse_dim_from_table_name("unrelated_table", KB_V2_TABLE_PREFIX),
            None
        );
    }

    /// P2 回归：检索侧按 chunk_id 去重，保留分数最高的一行
    #[test]
    fn rows_to_retrieved_input_dedup_semantics() {
        // rows_to_retrieved 需要 Database 实例，这里验证去重前置逻辑的排序假设：
        // 输入按分数降序排序后，首个出现的 chunk_id 即为最高分行
        let mut rows: Vec<(String, f32)> = vec![
            ("c1".to_string(), 0.5),
            ("c1".to_string(), 0.9),
            ("c2".to_string(), 0.7),
        ];
        rows.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(Ordering::Equal));
        let mut seen: HashSet<String> = HashSet::new();
        let deduped: Vec<(String, f32)> = rows
            .into_iter()
            .filter(|(id, _)| seen.insert(id.clone()))
            .collect();
        assert_eq!(deduped.len(), 2);
        assert_eq!(deduped[0], ("c1".to_string(), 0.9));
        assert_eq!(deduped[1], ("c2".to_string(), 0.7));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn clear_all_success_means_sqlite_and_every_lance_table_are_empty() {
        let temp_dir = tempfile::TempDir::new().expect("create temp dir");
        let database = Arc::new(
            Database::new(&temp_dir.path().join("clear-all.db")).expect("create test database"),
        );
        let store = LanceVectorStore::new(database.clone()).expect("create Lance store");
        store
            .add_document_record_with_library("doc-clear", "clear.txt", None, None, "default")
            .expect("add document record");
        store
            .add_chunks(vec![DocumentChunkWithEmbedding {
                chunk: DocumentChunk {
                    id: "chunk-clear".to_string(),
                    document_id: "doc-clear".to_string(),
                    chunk_index: 0,
                    text: "vector that must be removed".to_string(),
                    metadata: HashMap::new(),
                },
                // Deliberately use a non-candidate dimension so clear_all must
                // enumerate actual tables rather than a hard-coded list.
                embedding: vec![0.1, 0.2, 0.3],
            }])
            .await
            .expect("write Lance row");

        let path = store.get_lance_path().expect("resolve Lance path");
        let lance = lancedb::connect(&path)
            .execute()
            .await
            .expect("connect Lance");
        let table_name = format!("{}3", KB_V2_TABLE_PREFIX);
        let table = lance
            .open_table(&table_name)
            .execute()
            .await
            .expect("open written table");
        assert_eq!(table.count_rows(None::<String>).await.unwrap(), 1);

        store.clear_all().await.expect("clear_all should succeed");

        let cleared_table = lance
            .open_table(&table_name)
            .execute()
            .await
            .expect("reopen cleared table");
        assert_eq!(cleared_table.count_rows(None::<String>).await.unwrap(), 0);
        let conn = database.get_conn_safe().expect("open SQLite");
        // rag_vectors 已停止创建（仅历史库存在），存在时才校验清空
        for sqlite_table in ["rag_vectors", "rag_document_chunks", "rag_documents"] {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
                    [sqlite_table],
                    |row| row.get(0),
                )
                .expect("probe SQLite table existence");
            if !exists {
                assert_eq!(
                    sqlite_table, "rag_vectors",
                    "{} 应始终存在，缺失说明建表逻辑被破坏",
                    sqlite_table
                );
                continue;
            }
            let count: i64 = conn
                .query_row(
                    &format!("SELECT COUNT(*) FROM {}", sqlite_table),
                    [],
                    |row| row.get(0),
                )
                .expect("count cleared SQLite table");
            assert_eq!(count, 0, "{} must be empty after clear_all", sqlite_table);
        }
    }
}
