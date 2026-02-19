//! # Backup 模块
//!
//! 原子性备份/恢复系统。
//!
//! ## 设计原则
//!
//! 1. **原子性**：使用 SQLite Backup API，确保数据一致性
//! 2. **可验证**：每个文件都有 SHA256 校验和
//! 3. **可回滚**：恢复前自动备份当前数据，失败时可回滚
//! 4. **增量支持**：基于变更日志的增量备份
//! 5. **资产支持**：支持备份图片、文档、音视频等资产文件
//!
//! ## SQLite Backup API
//!
//! 使用 `sqlite3_backup_*` API 而非文件复制，确保 WAL 模式下的一致性：
//!
//! ```rust
//! // 备份前强制 checkpoint
//! conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
//!
//! // 使用 Backup API
//! let backup = rusqlite::backup::Backup::new(src, &mut dst)?;
//! backup.run_to_completion(5, Duration::from_millis(100), None)?;
//! ```
//!
//! ## 组件
//!
//! - `manager`: 备份管理器
//! - `incremental`: 增量备份（基于变更日志）
//! - `assets`: 资产文件备份

pub mod assets;

pub mod zip_export;

use rusqlite::backup::Backup;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use tracing::{debug, error, info, warn};
use uuid::Uuid;
use walkdir::WalkDir;

/// 记录并跳过迭代中的错误，避免静默丢弃
fn log_and_skip_err<T, E: std::fmt::Display>(result: Result<T, E>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[Backup] Row parse error (skipped): {}", e);
            None
        }
    }
}

#[cfg(feature = "data_governance")]
use crate::data_governance::schema_registry::DatabaseId;

pub use zip_export::{export_backup_to_zip, ZipExportError, ZipExportOptions, ZipExportResult};

// 重新导出资产模块的公共类型
pub use assets::{
    AssetBackupConfig, AssetBackupError, AssetBackupResult, AssetType, AssetTypeStats,
    AssetVerifyError, BackedUpAsset,
};

/// 备份清单版本
const MANIFEST_VERSION: &str = "1.0.0";

/// 当前应用支持的最大 manifest 主版本号
/// 用于 restore() 版本兼容性检查：拒绝来自未来主版本的备份
const MANIFEST_MAX_SUPPORTED_MAJOR: u64 = 1;

/// 清单文件名
const MANIFEST_FILENAME: &str = "manifest.json";

/// 预恢复备份目录名
const PRE_RESTORE_DIR: &str = ".pre_restore";

/// 生成安全且高概率唯一的备份 ID（目录名）
///
/// 约束：
/// - 仅包含 `[0-9A-Za-z]`、`_`，满足后端 `validate_backup_id` 的允许字符集
/// - 带时间戳前缀，便于排序与排查
fn generate_backup_id_at(now: chrono::DateTime<chrono::Utc>, suffix: Option<&str>) -> String {
    let timestamp = now.format("%Y%m%d_%H%M%S").to_string();
    let millis = now.timestamp_subsec_millis();
    let rand8 = &Uuid::new_v4().simple().to_string()[..8];

    match suffix {
        Some(s) if !s.trim().is_empty() => {
            format!("{}_{}_{:03}_{}", timestamp, rand8, millis, s.trim())
        }
        _ => format!("{}_{}_{:03}", timestamp, rand8, millis),
    }
}

fn generate_backup_id(suffix: Option<&str>) -> String {
    generate_backup_id_at(chrono::Utc::now(), suffix)
}

/// 备份清单
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupManifest {
    /// 清单版本
    pub version: String,
    /// 应用版本
    pub app_version: String,
    /// 创建时间
    pub created_at: String,
    /// 平台
    pub platform: String,
    /// 各数据库的 schema 版本
    pub schema_versions: HashMap<String, u32>,
    /// 文件列表（数据库文件）
    pub files: Vec<BackupFile>,
    /// 是否增量备份
    pub is_incremental: bool,
    /// 增量备份的基础版本（如果是增量）
    pub incremental_base: Option<String>,
    /// 备份 ID（唯一标识符）
    #[serde(default)]
    pub backup_id: String,
    /// 资产备份结果（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<assets::AssetBackupResult>,
}

impl BackupManifest {
    /// 创建新的备份清单
    pub fn new(app_version: &str) -> Self {
        let now = chrono::Utc::now();
        Self {
            version: MANIFEST_VERSION.to_string(),
            app_version: app_version.to_string(),
            created_at: now.to_rfc3339(),
            platform: std::env::consts::OS.to_string(),
            schema_versions: HashMap::new(),
            files: Vec::new(),
            is_incremental: false,
            incremental_base: None,
            backup_id: generate_backup_id_at(now, None),
            assets: None,
        }
    }

    /// 添加文件到清单
    pub fn add_file(&mut self, file: BackupFile) {
        self.files.push(file);
    }

    /// 设置 schema 版本
    pub fn set_schema_version(&mut self, db_name: &str, version: u32) {
        self.schema_versions.insert(db_name.to_string(), version);
    }

    /// 保存清单到文件（原子写入）
    ///
    /// 使用"临时文件 + 原子重命名"模式，确保写入过程中断时不会丢失数据。
    /// 1. 先写入临时文件 (.json.tmp)
    /// 2. 同步到磁盘
    /// 3. 原子重命名为目标文件
    pub fn save_to_file(&self, path: &Path) -> Result<(), BackupError> {
        let json = serde_json::to_string_pretty(self)
            .map_err(|e| BackupError::Manifest(format!("序列化清单失败: {}", e)))?;

        // 1. 写入临时文件
        let temp_path = path.with_extension("json.tmp");
        let mut file = File::create(&temp_path)?;
        file.write_all(json.as_bytes())?;

        // 2. 同步到磁盘，确保数据完全写入
        file.sync_all()?;

        // 3. 原子重命名（在同一文件系统上是原子操作）
        fs::rename(&temp_path, path).map_err(|e| {
            // 重命名失败时尝试清理临时文件
            let _ = fs::remove_file(&temp_path);
            BackupError::Io(e)
        })?;

        Ok(())
    }

    /// 从文件加载清单
    pub fn load_from_file(path: &Path) -> Result<Self, BackupError> {
        let content = fs::read_to_string(path)?;
        serde_json::from_str(&content)
            .map_err(|e| BackupError::Manifest(format!("解析清单失败: {}", e)))
    }
}

/// 备份文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupFile {
    /// 相对路径
    pub path: String,
    /// 文件大小
    pub size: u64,
    /// SHA256 校验和
    pub sha256: String,
    /// 数据库标识（可选）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub database_id: Option<String>,
}

/// 备份配置
pub struct BackupConfig {
    /// 应用数据目录
    pub app_data_dir: PathBuf,
    /// 应用版本
    pub app_version: String,
    /// 备份进度回调（可选）
    pub progress_callback: Option<Box<dyn Fn(BackupProgress) + Send + Sync>>,
}

impl std::fmt::Debug for BackupConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BackupConfig")
            .field("app_data_dir", &self.app_data_dir)
            .field("app_version", &self.app_version)
            .field(
                "progress_callback",
                &self.progress_callback.as_ref().map(|_| "<callback>"),
            )
            .finish()
    }
}

/// 备份进度信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupProgress {
    /// 当前阶段
    pub stage: BackupStage,
    /// 当前数据库
    pub current_database: Option<String>,
    /// 已完成的数据库数量
    pub completed_databases: usize,
    /// 总数据库数量
    pub total_databases: usize,
    /// 阶段进度 (0.0 - 1.0)
    pub stage_progress: f64,
}

/// 备份阶段
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum BackupStage {
    /// 准备中
    Preparing,
    /// 执行 WAL checkpoint
    Checkpoint,
    /// 复制数据库
    CopyingDatabase,
    /// 计算校验和
    ComputingChecksum,
    /// 生成清单
    GeneratingManifest,
    /// 完成
    Completed,
}

/// 备份错误
#[derive(Debug, thiserror::Error)]
pub enum BackupError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("Database error: {0}")]
    Database(String),

    #[error("Checksum mismatch: expected {expected}, got {actual}")]
    ChecksumMismatch { expected: String, actual: String },

    #[error("Manifest error: {0}")]
    Manifest(String),

    #[error("Restore failed: {0}")]
    RestoreFailed(String),

    #[error("File not found: {0}")]
    FileNotFound(String),

    #[error("Integrity check failed: {0}")]
    IntegrityCheckFailed(String),

    #[error("Backup directory error: {0}")]
    BackupDirectory(String),

    #[error("Version incompatible: {0}")]
    VersionIncompatible(String),

    #[error("Incremental restore not supported: {0}")]
    IncrementalRestoreNotSupported(String),

    #[error("Not implemented: {0}")]
    NotImplemented(String),
}

impl From<rusqlite::Error> for BackupError {
    fn from(err: rusqlite::Error) -> Self {
        BackupError::Database(err.to_string())
    }
}

/// 备份验证结果
///
/// 包含数据库和资产文件的验证结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupVerifyResult {
    /// 是否全部有效
    pub is_valid: bool,
    /// 数据库验证错误
    pub database_errors: Vec<String>,
    /// 资产验证错误
    pub asset_errors: Vec<AssetVerifyError>,
}

impl BackupVerifyResult {
    /// 创建一个表示全部有效的结果
    pub fn valid() -> Self {
        Self {
            is_valid: true,
            database_errors: Vec::new(),
            asset_errors: Vec::new(),
        }
    }

    /// 获取错误总数
    pub fn total_errors(&self) -> usize {
        self.database_errors.len() + self.asset_errors.len()
    }
}

// ============================================================================
// 分层备份 (Tiered Backup) 类型定义
// ============================================================================

/// 备份层级
///
/// 定义数据的重要性和可重建性，用于分层备份策略：
/// - Core: 最核心的用户数据，必须备份
/// - Important: 重要数据，建议备份
/// - Rebuildable: 可重建的数据（如向量索引），可选备份
/// - LargeAssets: 大型资产文件，按需备份
///
/// ## 2026-02 更新说明
///
/// 根据数据库使用情况调研，层级内容已更新：
/// - Core (P0): chat_v2.db, vfs.db, mistakes.db（核心用户数据）
/// - Important (P1): llm_usage.db + notes_assets/（LLM 使用记录、笔记资产）
/// - Rebuildable (P2): lance/（向量索引，可重建）
/// - LargeAssets (P3): images/, documents/, videos/（大型资产文件）
///
/// ## mistakes.db 特别说明
///
/// `mistakes.db` 是应用的**主数据库**（历史命名来源于错题功能）：
/// - **仍需备份**：包含 anki_cards、settings、review_analyses 等活跃表
/// - **部分废弃**：只有 `mistakes` 表和 `chat_messages` 表的错题业务功能已废弃
///
/// ## 已废弃的独立数据库（不再纳入备份层级）
/// - notes.db：正在迁移到 VFS
/// - anki.db：制卡数据，通过 VFS 上下文访问
/// - research.db, template_ai.db, essay_grading.db, canvas_boards.db：均已废弃
/// - textbooks.db, resources.db, main.db：已迁移到 VFS
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupTier {
    /// 核心数据（P0）：chat_v2, vfs, mistakes（主数据库）
    /// 这些是用户最核心的数据，丢失后无法恢复
    Core,
    /// 重要数据（P1）：+ llm_usage, notes_assets
    /// 重要但非核心的数据（LLM 使用统计等）
    Important,
    /// 可重建数据（P2）：+ lance (向量索引)
    /// 可以通过重新处理原始数据重建
    Rebuildable,
    /// 大型资产（P3）：+ images, documents, videos
    /// 大型文件，可能需要单独处理
    LargeAssets,
}

impl BackupTier {
    /// 获取此层级包含的数据库
    ///
    /// ## 2026-02 更新说明
    ///
    /// `Mistakes` 数据库（mistakes.db）仍需备份，原因：
    /// - 这是应用的**主数据库**（历史命名来源于错题功能）
    /// - 包含活跃表：review_analyses、anki_cards、settings、document_tasks 等
    /// - 只有 `mistakes` 表和 `chat_messages` 表的错题业务功能已废弃
    pub fn databases(&self) -> Vec<DatabaseId> {
        match self {
            BackupTier::Core => vec![
                DatabaseId::ChatV2,
                DatabaseId::Vfs,
                DatabaseId::Mistakes, // 主数据库，包含 anki_cards、settings 等活跃表
            ],
            BackupTier::Important => vec![
                DatabaseId::LlmUsage,
                // LLM 使用统计数据库，记录所有 LLM 调用的 token 使用
            ],
            BackupTier::Rebuildable => vec![
                // Lance 向量索引不是 SQLite 数据库，通过 asset_directories() 处理
            ],
            BackupTier::LargeAssets => vec![
                // 大型资产文件，不是数据库，通过 asset_directories() 处理
            ],
        }
    }

    /// 获取此层级包含的资产目录
    pub fn asset_directories(&self) -> Vec<&'static str> {
        match self {
            BackupTier::Core => vec![],
            BackupTier::Important => vec!["notes_assets", "vfs_blobs"],
            BackupTier::Rebuildable => vec!["lance"],
            BackupTier::LargeAssets => vec!["images", "documents", "videos", "assets"],
        }
    }

    /// 获取层级的优先级（数字越小优先级越高）
    pub fn priority(&self) -> u8 {
        match self {
            BackupTier::Core => 0,
            BackupTier::Important => 1,
            BackupTier::Rebuildable => 2,
            BackupTier::LargeAssets => 3,
        }
    }

    /// 返回所有层级（按优先级排序）
    pub fn all_ordered() -> Vec<BackupTier> {
        vec![
            BackupTier::Core,
            BackupTier::Important,
            BackupTier::Rebuildable,
            BackupTier::LargeAssets,
        ]
    }
}

/// 分层备份资产配置
///
/// 专用于分层备份的简化资产配置。
/// 与 `assets::AssetBackupConfig` 不同，这个配置更简单，
/// 主要用于 `backup_tiered` 方法。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TieredAssetConfig {
    /// 最大单个文件大小（字节）
    /// 超过此大小的文件将被跳过
    #[serde(default = "default_tiered_max_file_size")]
    pub max_file_size: u64,
    /// 包含的文件扩展名（空表示全部）
    #[serde(default)]
    pub include_extensions: Vec<String>,
    /// 排除的文件扩展名
    #[serde(default)]
    pub exclude_extensions: Vec<String>,
    /// 是否包含隐藏文件
    #[serde(default)]
    pub include_hidden: bool,
    /// 是否跟随符号链接
    #[serde(default)]
    pub follow_symlinks: bool,
    /// 筛选的资产类型（空表示全部类型）
    /// 前端可选择只备份特定类型的资产（如仅图片、仅文档等）
    #[serde(default)]
    pub asset_types: Vec<AssetType>,
}

fn default_tiered_max_file_size() -> u64 {
    100 * 1024 * 1024 // 100MB
}

impl Default for TieredAssetConfig {
    fn default() -> Self {
        Self {
            max_file_size: default_tiered_max_file_size(),
            include_extensions: vec![],
            exclude_extensions: vec!["tmp".to_string(), "temp".to_string(), "cache".to_string()],
            include_hidden: false,
            follow_symlinks: false,
            asset_types: vec![],
        }
    }
}

/// 备份选择配置
///
/// 允许用户自定义要备份的内容：
/// - 按层级选择
/// - 显式包含/排除特定数据库
/// - 配置资产备份选项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BackupSelection {
    /// 要备份的层级（空表示全量）
    #[serde(default)]
    pub tiers: Vec<BackupTier>,
    /// 显式包含的数据库（覆盖层级设置）
    #[serde(default)]
    pub include_databases: Vec<String>,
    /// 显式排除的数据库
    #[serde(default)]
    pub exclude_databases: Vec<String>,
    /// 是否包含资产文件
    #[serde(default = "default_include_assets")]
    pub include_assets: bool,
    /// 资产配置（可选）
    #[serde(default)]
    pub asset_config: Option<TieredAssetConfig>,
}

fn default_include_assets() -> bool {
    false
}

impl Default for BackupSelection {
    fn default() -> Self {
        Self::full()
    }
}

impl BackupSelection {
    /// 精简备份（仅核心数据库）
    pub fn slim() -> Self {
        Self {
            tiers: vec![BackupTier::Core],
            include_databases: vec![],
            exclude_databases: vec![],
            include_assets: false,
            asset_config: None,
        }
    }

    /// 最小备份（核心 + 重要）
    pub fn minimal() -> Self {
        Self {
            tiers: vec![BackupTier::Core, BackupTier::Important],
            include_databases: vec![],
            exclude_databases: vec![],
            include_assets: false,
            asset_config: None,
        }
    }

    /// 完整备份（所有数据库和资产）
    pub fn full() -> Self {
        Self {
            tiers: BackupTier::all_ordered(),
            include_databases: vec![],
            exclude_databases: vec![],
            include_assets: true,
            asset_config: Some(TieredAssetConfig::default()),
        }
    }

    /// 仅数据库备份（不含资产）
    pub fn databases_only() -> Self {
        Self {
            tiers: vec![BackupTier::Core, BackupTier::Important],
            include_databases: vec![],
            exclude_databases: vec![],
            include_assets: false,
            asset_config: None,
        }
    }

    /// 检查数据库是否应该被备份
    pub fn should_backup_database(&self, db_id: &DatabaseId) -> bool {
        let db_name = db_id.as_str().to_string();

        // 显式排除优先
        if self.exclude_databases.contains(&db_name) {
            return false;
        }

        // 显式包含
        if self.include_databases.contains(&db_name) {
            return true;
        }

        // 按层级判断
        for tier in &self.tiers {
            if tier.databases().contains(db_id) {
                return true;
            }
        }

        // 如果没有指定层级，默认备份所有核心数据库
        if self.tiers.is_empty() {
            return BackupTier::Core.databases().contains(db_id);
        }

        false
    }

    /// 获取需要备份的资产目录
    pub fn get_asset_directories(&self) -> Vec<&'static str> {
        if !self.include_assets {
            return vec![];
        }

        let mut dirs: HashSet<&'static str> = HashSet::new();
        for tier in &self.tiers {
            for dir in tier.asset_directories() {
                dirs.insert(dir);
            }
        }
        dirs.into_iter().collect()
    }
}

/// 分层备份结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TieredBackupResult {
    /// 备份清单
    pub manifest: BackupManifest,
    /// 备份的层级
    pub backed_up_tiers: Vec<BackupTier>,
    /// 各层级的文件数量
    pub tier_file_counts: HashMap<String, usize>,
    /// 各层级的大小（字节）
    pub tier_sizes: HashMap<String, u64>,
    /// 跳过的文件（超过大小限制等）
    pub skipped_files: Vec<SkippedFile>,
    /// 总耗时（毫秒）
    pub duration_ms: u64,
}

/// 跳过的文件信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SkippedFile {
    /// 文件路径
    pub path: String,
    /// 跳过原因
    pub reason: String,
}

/// 变更日志表 SQL（用于增量备份）
pub const CHANGE_LOG_TABLE_SQL: &str = r#"
    CREATE TABLE IF NOT EXISTS __change_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('INSERT', 'UPDATE', 'DELETE')),
        changed_at TEXT NOT NULL DEFAULT (datetime('now')),
        sync_version INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_change_log_sync_version ON __change_log(sync_version);
    CREATE INDEX IF NOT EXISTS idx_change_log_changed_at ON __change_log(changed_at);
"#;

/// 备份管理器
///
/// 负责执行数据库的完整备份、增量备份、恢复和验证操作。
/// 使用 SQLite Backup API 确保备份的原子性和一致性。
pub struct BackupManager {
    /// 备份目录
    backup_dir: PathBuf,
    /// 应用数据目录
    app_data_dir: PathBuf,
    /// 应用版本
    app_version: String,
    /// 可选的进度回调：(当前数据库索引, 数据库总数, 数据库名称, 已复制页数, 总页数)
    progress_callback: Option<Box<dyn Fn(usize, usize, &str, i32, i32) + Send + Sync>>,
}

impl BackupManager {
    /// 创建新的备份管理器
    pub fn new(backup_dir: PathBuf) -> Self {
        Self {
            backup_dir,
            app_data_dir: PathBuf::new(),
            app_version: String::from("unknown"),
            progress_callback: None,
        }
    }

    /// 使用完整配置创建备份管理器
    pub fn with_config(backup_dir: PathBuf, config: BackupConfig) -> Self {
        Self {
            backup_dir,
            app_data_dir: config.app_data_dir,
            app_version: config.app_version,
            progress_callback: None,
        }
    }

    /// 设置进度回调：(当前数据库索引, 数据库总数, 数据库名称, 已复制页数, 总页数)
    pub fn set_progress_callback<F>(&mut self, callback: F)
    where
        F: Fn(usize, usize, &str, i32, i32) + Send + Sync + 'static,
    {
        self.progress_callback = Some(Box::new(callback));
    }

    /// 设置应用数据目录
    pub fn set_app_data_dir(&mut self, dir: PathBuf) {
        self.app_data_dir = dir;
    }

    /// 设置应用版本
    pub fn set_app_version(&mut self, version: String) {
        self.app_version = version;
    }

    /// 获取备份目录
    pub fn backup_dir(&self) -> &Path {
        &self.backup_dir
    }

    /// 创建一个新的、不会与现有备份冲突的备份子目录
    ///
    /// 关键保证：
    /// - `backup_id` **必须** 与目录名一致（否则删除/验证/恢复会失效）
    /// - 使用 `create_dir` 而不是 `create_dir_all`，避免“目录已存在但继续写入”导致的覆盖风险
    fn create_unique_backup_subdir(
        &self,
        suffix: Option<&str>,
    ) -> Result<(String, PathBuf), BackupError> {
        // 确保根目录存在
        if !self.backup_dir.exists() {
            fs::create_dir_all(&self.backup_dir)?;
        }

        for _ in 0..10 {
            let backup_id = generate_backup_id(suffix);
            let backup_subdir = self.backup_dir.join(&backup_id);

            match fs::create_dir(&backup_subdir) {
                Ok(()) => return Ok((backup_id, backup_subdir)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(BackupError::Io(e)),
            }
        }

        Err(BackupError::BackupDirectory(
            "无法生成唯一备份目录（多次尝试均冲突）".to_string(),
        ))
    }

    /// 获取数据库文件路径
    ///
    /// 注意：`app_data_dir` 是 Tauri 根数据目录（如 `com.deepstudent.app`），
    /// 实际数据库存储在活动数据空间目录（如 `slots/slotA`）中。
    pub(crate) fn get_database_path(&self, id: &DatabaseId) -> PathBuf {
        let active_dir = crate::data_space::get_data_space_manager()
            .map(|mgr| mgr.active_dir())
            .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));

        Self::resolve_database_path_in_dir(&active_dir, id)
    }

    /// 在指定目录下解析数据库文件路径（不依赖 active slot）
    ///
    /// 用于恢复到非活跃插槽等场景。
    pub(crate) fn resolve_database_path_in_dir(base_dir: &Path, id: &DatabaseId) -> PathBuf {
        match id {
            // VFS 数据库在 databases 子目录
            DatabaseId::Vfs => base_dir.join("databases").join("vfs.db"),
            // ChatV2 数据库直接在空间根目录
            DatabaseId::ChatV2 => base_dir.join("chat_v2.db"),
            // Mistakes 数据库直接在空间根目录
            DatabaseId::Mistakes => base_dir.join("mistakes.db"),
            // LLM Usage 数据库直接在空间根目录
            DatabaseId::LlmUsage => base_dir.join("llm_usage.db"),
        }
    }

    /// 获取备份中的数据库文件路径
    pub(crate) fn get_backup_database_path(&self, backup_dir: &Path, id: &DatabaseId) -> PathBuf {
        backup_dir.join(format!("{}.db", id.as_str()))
    }

    /// 执行完整备份
    ///
    /// ## 执行步骤
    ///
    /// 1. 创建带时间戳的备份目录
    /// 2. 对每个数据库执行 WAL checkpoint
    /// 3. 使用 SQLite Backup API 复制数据库
    /// 4. 计算每个文件的 SHA256 校验和
    /// 5. 生成并保存清单文件
    ///
    /// ## 返回
    ///
    /// 成功时返回包含所有备份文件信息的 `BackupManifest`
    pub fn backup_full(&self) -> Result<BackupManifest, BackupError> {
        info!("开始执行完整备份");

        // 1. 创建备份目录
        let (backup_id, backup_subdir) = self.create_unique_backup_subdir(None)?;

        info!("备份目录: {:?}", backup_subdir);

        // 2. 创建清单
        let mut manifest = BackupManifest::new(&self.app_version);
        manifest.backup_id = backup_id;

        // 3. 备份所有数据库
        let all_dbs = DatabaseId::all_ordered();
        let total = all_dbs.len();
        for (idx, db_id) in all_dbs.into_iter().enumerate() {
            let db_path = self.get_database_path(&db_id);

            // 检查数据库是否存在
            if !db_path.exists() {
                warn!("数据库不存在，跳过: {:?}", db_path);
                continue;
            }

            // 发送进度回调
            if let Some(ref cb) = self.progress_callback {
                cb(idx, total, db_id.as_str(), 0, 0);
            }

            info!("备份数据库: {:?} -> {:?}", db_id, db_path);

            // 备份单个数据库
            let backup_file =
                self.backup_single_database(&db_id, &db_path, &backup_subdir, idx, total)?;
            manifest.add_file(backup_file);

            // 获取 schema 版本
            let version = self.get_schema_version(&db_path)?;
            manifest.set_schema_version(db_id.as_str(), version);
        }

        // 3.5 备份加密密钥（跨设备恢复支持）
        match self.backup_crypto_keys(&backup_subdir) {
            Ok(count) => {
                if count > 0 {
                    info!("加密密钥备份完成: {} 个文件", count);
                }
            }
            Err(e) => {
                // 加密密钥备份失败不阻塞整体备份，记录警告
                warn!("加密密钥备份失败（API 密钥可能无法跨设备恢复）: {}", e);
            }
        }

        // 3.6 备份工作区数据库（ws_*.db）
        let active_dir_for_ws = crate::data_space::get_data_space_manager()
            .map(|mgr| mgr.active_dir())
            .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));
        match self.backup_workspace_databases(&active_dir_for_ws, &backup_subdir) {
            Ok(count) => {
                if count > 0 {
                    info!("工作区数据库备份完成: {} 个", count);
                }
            }
            Err(e) => {
                warn!("工作区数据库备份失败（非致命）: {}", e);
            }
        }

        // 4. 保存清单
        let manifest_path = backup_subdir.join(MANIFEST_FILENAME);
        manifest.save_to_file(&manifest_path)?;

        info!("备份完成，共 {} 个文件", manifest.files.len());

        Ok(manifest)
    }

    /// 执行包含资产的完整备份
    ///
    /// ## 执行步骤
    ///
    /// 1. 执行数据库备份
    /// 2. 根据配置备份资产文件
    /// 3. 生成包含资产信息的清单
    ///
    /// ## 参数
    ///
    /// - `asset_config`: 资产备份配置（None 表示使用默认配置）
    ///
    /// ## 返回
    ///
    /// 成功时返回包含所有备份文件信息的 `BackupManifest`
    pub fn backup_with_assets(
        &self,
        asset_config: Option<assets::AssetBackupConfig>,
    ) -> Result<BackupManifest, BackupError> {
        info!("开始执行包含资产的完整备份");

        // 1. 创建备份目录
        let (backup_id, backup_subdir) = self.create_unique_backup_subdir(None)?;

        info!("备份目录: {:?}", backup_subdir);

        // 2. 创建清单
        let mut manifest = BackupManifest::new(&self.app_version);
        manifest.backup_id = backup_id;

        // 3. 备份所有数据库
        let all_dbs = DatabaseId::all_ordered();
        let total = all_dbs.len();
        for (idx, db_id) in all_dbs.into_iter().enumerate() {
            let db_path = self.get_database_path(&db_id);

            // 检查数据库是否存在
            if !db_path.exists() {
                warn!("数据库不存在，跳过: {:?}", db_path);
                continue;
            }

            // 发送进度回调
            if let Some(ref cb) = self.progress_callback {
                cb(idx, total, db_id.as_str(), 0, 0);
            }

            info!("备份数据库: {:?} -> {:?}", db_id, db_path);

            // 备份单个数据库
            let backup_file =
                self.backup_single_database(&db_id, &db_path, &backup_subdir, idx, total)?;
            manifest.add_file(backup_file);

            // 获取 schema 版本
            let version = self.get_schema_version(&db_path)?;
            manifest.set_schema_version(db_id.as_str(), version);
        }

        // 3.5 备份加密密钥（跨设备恢复支持）
        match self.backup_crypto_keys(&backup_subdir) {
            Ok(count) => {
                if count > 0 {
                    info!("加密密钥备份完成: {} 个文件", count);
                }
            }
            Err(e) => {
                warn!("加密密钥备份失败（API 密钥可能无法跨设备恢复）: {}", e);
            }
        }

        // 3.6 备份工作区数据库（ws_*.db）
        let active_dir_for_ws = crate::data_space::get_data_space_manager()
            .map(|mgr| mgr.active_dir())
            .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));
        match self.backup_workspace_databases(&active_dir_for_ws, &backup_subdir) {
            Ok(count) => {
                if count > 0 {
                    info!("工作区数据库备份完成: {} 个", count);
                }
            }
            Err(e) => {
                warn!("工作区数据库备份失败（非致命）: {}", e);
            }
        }

        // 4. 备份资产文件
        let config = asset_config.unwrap_or_default();
        if !config.asset_types.is_empty() {
            info!("开始备份资产文件: {:?} 种类型", config.asset_types.len());

            // 使用活动数据空间目录扫描资产（与运行时 FileManager 绑定的位置一致）
            let active_asset_dir = crate::data_space::get_data_space_manager()
                .map(|mgr| mgr.active_dir())
                .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));
            match assets::backup_assets(&active_asset_dir, &backup_subdir, &config) {
                Ok(asset_result) => {
                    info!(
                        "资产备份完成: {} 个文件, {} 字节",
                        asset_result.total_files, asset_result.total_size
                    );
                    manifest.assets = Some(asset_result);
                }
                Err(e) => {
                    error!("资产备份失败: {}", e);
                    return Err(BackupError::RestoreFailed(format!(
                        "资产备份失败，已中止本次备份: {}",
                        e
                    )));
                }
            }
        }

        // 5. 保存清单
        let manifest_path = backup_subdir.join(MANIFEST_FILENAME);
        manifest.save_to_file(&manifest_path)?;

        let asset_files = manifest.assets.as_ref().map(|a| a.total_files).unwrap_or(0);
        info!(
            "备份完成: {} 个数据库文件, {} 个资产文件",
            manifest.files.len(),
            asset_files
        );

        Ok(manifest)
    }

    /// 备份加密密钥文件到备份目录
    ///
    /// 包含 `.master_key`（CryptoService 主密钥）和 `.secure/` 目录（SecureStore 密钥种子 + 加密凭据）。
    /// 这些文件在跨设备恢复时必须一并还原，否则 API 密钥将无法解密。
    pub fn backup_crypto_keys(&self, backup_subdir: &Path) -> Result<usize, BackupError> {
        let master_key_path = self.app_data_dir.join(".master_key");
        let secure_dir = self.app_data_dir.join(".secure");

        // 无加密文件时跳过，避免创建空目录
        if !master_key_path.exists() && !(secure_dir.exists() && secure_dir.is_dir()) {
            return Ok(0);
        }

        let crypto_dest = backup_subdir.join("crypto");
        fs::create_dir_all(&crypto_dest)?;

        let mut count = 0;

        // 1. 备份 .master_key
        if master_key_path.exists() {
            let dest = crypto_dest.join(".master_key");
            fs::copy(&master_key_path, &dest).map_err(|e| {
                BackupError::RestoreFailed(format!("备份 .master_key 失败: {}", e))
            })?;
            count += 1;
            info!("[Backup] 已备份 .master_key");
        }

        // 2. 备份 .secure/ 目录（.key_seed + *.enc）
        if secure_dir.exists() && secure_dir.is_dir() {
            let secure_dest = crypto_dest.join(".secure");
            fs::create_dir_all(&secure_dest)?;

            let mut secure_count = 0usize;
            for entry in fs::read_dir(&secure_dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.is_file() {
                    if let Some(file_name) = path.file_name() {
                        let dest = secure_dest.join(file_name);
                        fs::copy(&path, &dest).map_err(|e| {
                            BackupError::RestoreFailed(format!(
                                "备份 .secure/{} 失败: {}",
                                file_name.to_string_lossy(),
                                e
                            ))
                        })?;
                        secure_count += 1;
                    }
                }
            }
            count += secure_count;
            info!("[Backup] 已备份 .secure/ 目录: {} 个文件", secure_count);
        }

        Ok(count)
    }

    /// 从备份目录恢复加密密钥文件到应用数据目录
    ///
    /// 恢复 `.master_key` 和 `.secure/` 目录，使跨设备恢复后 API 密钥可正常解密。
    /// 仅在备份中包含 crypto/ 子目录时执行。
    pub fn restore_crypto_keys(&self, backup_subdir: &Path) -> Result<usize, BackupError> {
        let crypto_src = backup_subdir.join("crypto");
        if !crypto_src.exists() || !crypto_src.is_dir() {
            info!("[Restore] 备份中无加密密钥文件（旧版备份），跳过");
            return Ok(0);
        }

        let mut count = 0;

        // 1. 恢复 .master_key
        let master_key_src = crypto_src.join(".master_key");
        if master_key_src.exists() {
            let dest = self.app_data_dir.join(".master_key");
            fs::copy(&master_key_src, &dest).map_err(|e| {
                BackupError::RestoreFailed(format!("恢复 .master_key 失败: {}", e))
            })?;
            count += 1;
            info!("[Restore] 已恢复 .master_key");
        }

        // 2. 恢复 .secure/ 目录
        let secure_src = crypto_src.join(".secure");
        if secure_src.exists() && secure_src.is_dir() {
            let secure_dest = self.app_data_dir.join(".secure");
            fs::create_dir_all(&secure_dest)?;

            let mut secure_count = 0usize;
            for entry in fs::read_dir(&secure_src)? {
                let entry = entry?;
                let path = entry.path();
                if path.is_file() {
                    if let Some(file_name) = path.file_name() {
                        let dest = secure_dest.join(file_name);
                        fs::copy(&path, &dest).map_err(|e| {
                            BackupError::RestoreFailed(format!(
                                "恢复 .secure/{} 失败: {}",
                                file_name.to_string_lossy(),
                                e
                            ))
                        })?;
                        secure_count += 1;
                    }
                }
            }
            count += secure_count;
            info!("[Restore] 已恢复 .secure/ 目录: {} 个文件", secure_count);
        }

        Ok(count)
    }

    /// 恢复包含资产的备份
    ///
    /// ## 参数
    ///
    /// - `manifest`: 备份清单
    /// - `restore_assets`: 是否恢复资产文件
    ///
    /// ## 返回
    ///
    /// 成功时返回恢复的资产数量
    pub fn restore_with_assets(
        &self,
        manifest: &BackupManifest,
        restore_assets: bool,
    ) -> Result<usize, BackupError> {
        info!(
            "开始恢复备份（含资产）: {}, restore_assets={}",
            manifest.backup_id, restore_assets
        );

        // 0. 版本兼容性检查（与 restore() 保持一致）
        self.check_manifest_compatibility(manifest)?;

        // 1. 获取备份目录
        let backup_subdir = self.backup_dir.join(&manifest.backup_id);
        if !backup_subdir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份目录不存在: {:?}",
                backup_subdir
            )));
        }

        // 2. 验证备份完整性
        self.verify_internal(manifest, &backup_subdir)?;

        // 3. 创建预恢复备份
        let pre_restore_dir = self.backup_dir.join(PRE_RESTORE_DIR);
        self.create_pre_restore_backup(&pre_restore_dir)?;

        // 4. 恢复每个数据库
        let mut restore_errors: Vec<String> = Vec::new();

        for backup_file in &manifest.files {
            // 只恢复数据库文件
            if !backup_file.path.ends_with(".db") {
                continue;
            }

            let db_id_str = backup_file.database_id.as_ref().ok_or_else(|| {
                BackupError::Manifest(format!("备份文件缺少 database_id: {}", backup_file.path))
            })?;

            let db_id = match db_id_str.as_str() {
                "vfs" => DatabaseId::Vfs,
                "chat_v2" => DatabaseId::ChatV2,
                "mistakes" => DatabaseId::Mistakes,
                "llm_usage" => DatabaseId::LlmUsage,
                _ => {
                    // 理论上 check_manifest_compatibility 已经拦截；这里做最后一道防线。
                    let msg = format!("备份中包含未知的数据库 ID: {}", db_id_str);
                    error!("{}", msg);
                    restore_errors.push(msg);
                    continue;
                }
            };

            match self.restore_single_database(&db_id, &backup_subdir) {
                Ok(()) => {
                    info!("恢复数据库成功: {:?}", db_id);
                }
                Err(e) => {
                    error!("恢复数据库失败: {:?}, 错误: {}", db_id, e);
                    restore_errors.push(format!("{:?}: {}", db_id, e));
                }
            }
        }

        // 4.5 恢复加密密钥（跨设备恢复支持）
        match self.restore_crypto_keys(&backup_subdir) {
            Ok(count) => {
                if count > 0 {
                    info!("加密密钥恢复完成: {} 个文件", count);
                }
            }
            Err(e) => {
                warn!("加密密钥恢复失败（API 密钥可能需要重新配置）: {}", e);
            }
        }

        // 5. 恢复资产文件（如果需要）
        let mut restored_assets = 0;
        if restore_assets {
            let active_restore_dir = crate::data_space::get_data_space_manager()
                .map(|mgr| mgr.active_dir())
                .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));

            if let Some(asset_result) = &manifest.assets {
                info!("开始恢复资产文件: {} 个", asset_result.total_files);
                match assets::restore_assets(
                    &backup_subdir,
                    &active_restore_dir,
                    &asset_result.files,
                ) {
                    Ok(count) => {
                        restored_assets = count;
                        info!("资产恢复完成: {} 个文件", count);
                    }
                    Err(e) => {
                        error!("资产恢复失败: {}", e);
                        restore_errors.push(format!("资产恢复: {}", e));
                    }
                }
            } else {
                // manifest.assets 为 None 时，尝试直接扫描备份目录中的 assets/ 子目录
                let assets_dir = backup_subdir.join("assets");
                if assets_dir.exists() && assets_dir.is_dir() {
                    info!(
                        "manifest.assets 为空，但备份目录中存在 assets/，尝试直接复制恢复: {:?}",
                        assets_dir
                    );
                    match assets::restore_assets_from_dir(&assets_dir, &active_restore_dir) {
                        Ok(count) => {
                            restored_assets = count;
                            info!("资产目录直接恢复完成: {} 个文件", count);
                        }
                        Err(e) => {
                            error!("资产目录直接恢复失败: {}", e);
                            restore_errors.push(format!("资产目录恢复: {}", e));
                        }
                    }
                } else {
                    warn!("备份中无资产文件可恢复 (manifest.assets=None, assets/ 目录不存在)");
                }
            }
        }

        // 6. 检查是否有错误
        if !restore_errors.is_empty() {
            error!("恢复失败，尝试自动回滚到预恢复备份: {:?}", pre_restore_dir);
            let rollback_result = self.rollback_from_pre_restore(&pre_restore_dir);
            return Err(match rollback_result {
                Ok(()) => BackupError::RestoreFailed(format!(
                    "部分恢复失败并已自动回滚: {:?}",
                    restore_errors
                )),
                Err(rollback_err) => BackupError::RestoreFailed(format!(
                    "部分恢复失败且自动回滚失败: {:?}; 回滚错误: {}",
                    restore_errors, rollback_err
                )),
            });
        }

        info!(
            "恢复完成: 数据库文件={}, 资产文件={}，预恢复备份保留在: {:?}",
            manifest.files.len(),
            restored_assets,
            pre_restore_dir
        );

        Ok(restored_assets)
    }

    /// 恢复备份到指定目标目录（用于恢复到非活跃插槽，零文件冲突）
    ///
    /// 与 `restore_with_assets` 的区别：
    /// - 数据库和资产写入 `target_dir` 而非 `active_dir`
    /// - 不创建预恢复备份（目标是空的非活跃插槽，无需回滚）
    /// - 不需要维护模式（不涉及正在使用的文件）
    ///
    /// ## 返回
    ///
    /// 成功时返回恢复的资产数量
    pub fn restore_with_assets_to_dir(
        &self,
        manifest: &BackupManifest,
        restore_assets: bool,
        target_dir: &Path,
    ) -> Result<usize, BackupError> {
        info!(
            "开始恢复备份到目标目录: {}, backup_id={}, restore_assets={}",
            target_dir.display(),
            manifest.backup_id,
            restore_assets
        );

        // 0. 版本兼容性检查
        self.check_manifest_compatibility(manifest)?;

        // 1. 获取备份目录
        let backup_subdir = self.backup_dir.join(&manifest.backup_id);
        if !backup_subdir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份目录不存在: {:?}",
                backup_subdir
            )));
        }

        // 2. 验证备份完整性
        self.verify_internal(manifest, &backup_subdir)?;

        // 3. 确保目标目录存在
        fs::create_dir_all(target_dir)?;

        // 4. 恢复每个数据库到目标目录
        let mut restore_errors: Vec<String> = Vec::new();

        for backup_file in &manifest.files {
            if !backup_file.path.ends_with(".db") {
                continue;
            }

            let db_id_str = backup_file.database_id.as_ref().ok_or_else(|| {
                BackupError::Manifest(format!("备份文件缺少 database_id: {}", backup_file.path))
            })?;

            let db_id = match db_id_str.as_str() {
                "vfs" => DatabaseId::Vfs,
                "chat_v2" => DatabaseId::ChatV2,
                "mistakes" => DatabaseId::Mistakes,
                "llm_usage" => DatabaseId::LlmUsage,
                _ => {
                    let msg = format!("备份中包含未知的数据库 ID: {}", db_id_str);
                    error!("{}", msg);
                    restore_errors.push(msg);
                    continue;
                }
            };

            match self.restore_single_database_to_dir(&db_id, &backup_subdir, target_dir) {
                Ok(()) => {
                    info!("恢复数据库成功: {:?} -> {}", db_id, target_dir.display());
                }
                Err(e) => {
                    error!("恢复数据库失败: {:?}, 错误: {}", db_id, e);
                    restore_errors.push(format!("{:?}: {}", db_id, e));
                }
            }
        }

        // 5. 恢复资产文件到目标目录
        let mut restored_assets = 0;
        if restore_assets {
            if let Some(asset_result) = &manifest.assets {
                info!("开始恢复资产文件到目标目录: {} 个", asset_result.total_files);
                match assets::restore_assets(
                    &backup_subdir,
                    target_dir,
                    &asset_result.files,
                ) {
                    Ok(count) => {
                        restored_assets = count;
                        info!("资产恢复完成: {} 个文件", count);
                    }
                    Err(e) => {
                        error!("资产恢复失败: {}", e);
                        restore_errors.push(format!("资产恢复: {}", e));
                    }
                }
            } else {
                let assets_dir = backup_subdir.join("assets");
                if assets_dir.exists() && assets_dir.is_dir() {
                    info!("manifest.assets 为空，尝试从 assets/ 目录直接恢复");
                    match assets::restore_assets_from_dir(&assets_dir, target_dir) {
                        Ok(count) => {
                            restored_assets = count;
                            info!("资产目录直接恢复完成: {} 个文件", count);
                        }
                        Err(e) => {
                            error!("资产目录直接恢复失败: {}", e);
                            restore_errors.push(format!("资产目录恢复: {}", e));
                        }
                    }
                }
            }
        }

        // 6. 检查是否有错误（非活跃插槽恢复失败不回滚，直接报错）
        if !restore_errors.is_empty() {
            return Err(BackupError::RestoreFailed(format!(
                "恢复到目标目录失败: {:?}",
                restore_errors
            )));
        }

        info!(
            "恢复到目标目录完成: 数据库={}, 资产={}, 目标={}",
            manifest.files.iter().filter(|f| f.path.ends_with(".db")).count(),
            restored_assets,
            target_dir.display()
        );

        Ok(restored_assets)
    }

    /// 验证包含资产的备份
    ///
    /// ## 参数
    ///
    /// - `manifest`: 备份清单
    ///
    /// ## 返回
    ///
    /// 验证结果，包含数据库和资产的验证错误
    pub fn verify_with_assets(
        &self,
        manifest: &BackupManifest,
    ) -> Result<BackupVerifyResult, BackupError> {
        let backup_subdir = self.backup_dir.join(&manifest.backup_id);
        if !backup_subdir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份目录不存在: {:?}",
                backup_subdir
            )));
        }

        // 验证数据库文件
        let db_result = self.verify_internal(manifest, &backup_subdir);
        let db_errors = match db_result {
            Ok(()) => Vec::new(),
            Err(e) => vec![e.to_string()],
        };

        // 验证资产文件
        let asset_errors = if let Some(asset_result) = &manifest.assets {
            match assets::verify_assets(&backup_subdir, &asset_result.files) {
                Ok(errors) => errors,
                Err(e) => {
                    vec![assets::AssetVerifyError {
                        path: "assets".to_string(),
                        error_type: "verify_failed".to_string(),
                        message: e.to_string(),
                    }]
                }
            }
        } else {
            Vec::new()
        };

        Ok(BackupVerifyResult {
            is_valid: db_errors.is_empty() && asset_errors.is_empty(),
            database_errors: db_errors,
            asset_errors,
        })
    }

    /// 备份单个数据库
    ///
    /// 使用 SQLite Backup API 进行原子性备份。
    ///
    /// ## 竞态保护（Issue #10）
    ///
    /// checkpoint 和 Backup API 之间存在竞态窗口：
    /// 如果在 checkpoint 完成后、Backup 开始前有新写入，WAL 中的数据可能
    /// 未被 checkpoint 合并到主文件。虽然 Backup API 本身会拷贝 WAL 中的
    /// 未合并数据，但 TRUNCATE checkpoint 可能已清空 WAL。
    ///
    /// 解决方案：使用 BEGIN IMMEDIATE 获取写锁，阻止 checkpoint-Backup
    /// 窗口期间的并发写入，确保备份的一致性。
    fn backup_single_database(
        &self,
        db_id: &DatabaseId,
        source_path: &Path,
        backup_dir: &Path,
        db_idx: usize,
        total_dbs: usize,
    ) -> Result<BackupFile, BackupError> {
        // 1. 打开源数据库
        let src_conn = Connection::open(source_path)?;

        // 2. 执行 WAL checkpoint，确保所有数据写入主数据库文件
        //
        // ## 竞态说明（Issue #10）
        //
        // checkpoint 和 Backup API 之间理论上存在竞态窗口（新写入可能在 checkpoint 后进入 WAL）。
        // 但 SQLite Backup API 会自动处理：
        // - run_to_completion 分批拷贝页面，如果源页面在拷贝过程中被修改，
        //   Backup API 会重新拷贝受影响的页面
        // - 这保证了备份是某一时刻的一致性快照
        //
        // 因此不需要额外的事务锁定（BEGIN IMMEDIATE 会阻塞 checkpoint 导致死锁）。
        debug!("执行 WAL checkpoint: {:?}", db_id);
        src_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;

        // 3. 创建目标文件路径
        let dest_path = self.get_backup_database_path(backup_dir, db_id);

        // 4. 打开目标数据库
        let mut dest_conn = Connection::open(&dest_path)?;

        // 5. 使用 Backup API 复制数据库（手动 step 循环，支持页面级进度）
        debug!("使用 Backup API 复制: {:?} -> {:?}", source_path, dest_path);
        {
            let backup = Backup::new(&src_conn, &mut dest_conn)?;

            // 手动分批复制，每次 100 页，间隔 50ms
            // 每批复制后通过回调报告页面级进度
            use rusqlite::backup::StepResult;
            loop {
                let step_result = backup.step(100)?;

                // 报告页面级进度
                if let Some(ref cb) = self.progress_callback {
                    let p = backup.progress();
                    let copied = p.pagecount - p.remaining;
                    cb(db_idx, total_dbs, db_id.as_str(), copied, p.pagecount);
                }

                match step_result {
                    StepResult::Done => break,
                    StepResult::More | StepResult::Busy | StepResult::Locked => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    _ => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                }
            }
        }

        // 6. 确保目标数据库完全写入
        dest_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;

        // 8. 关闭连接
        drop(dest_conn);
        drop(src_conn);

        // 8. 计算校验和
        let sha256 = calculate_file_sha256(&dest_path)?;
        let size = fs::metadata(&dest_path)?.len();

        debug!(
            "数据库备份完成: {:?}, size={}, sha256={}",
            db_id, size, sha256
        );

        Ok(BackupFile {
            path: format!("{}.db", db_id.as_str()),
            size,
            sha256,
            database_id: Some(db_id.as_str().to_string()),
        })
    }

    /// 获取数据库的 schema 版本
    fn get_schema_version(&self, db_path: &Path) -> Result<u32, BackupError> {
        let conn = Connection::open(db_path)?;

        // 检查 refinery_schema_history 表是否存在
        let table_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='refinery_schema_history')",
            [],
            |row| row.get(0),
        )?;

        if !table_exists {
            return Ok(0);
        }

        // 获取最大版本号
        let version: Option<i32> = conn.query_row(
            "SELECT MAX(version) FROM refinery_schema_history",
            [],
            |row| row.get(0),
        )?;

        Ok(version.unwrap_or(0) as u32)
    }

    /// 执行增量备份
    ///
    /// 基于变更日志表 `__change_log` 导出自上次备份以来的变更。
    ///
    /// ## 参数
    ///
    /// * `base_version` - 基础备份的版本标识（backup_id）
    ///
    /// ## 注意
    ///
    /// 需要应用层在数据变更时维护 `__change_log` 表
    pub fn backup_incremental(&self, base_version: &str) -> Result<BackupManifest, BackupError> {
        info!("开始执行增量备份，基础版本: {}", base_version);

        // 验证基础备份存在
        let base_backup_dir = self.backup_dir.join(base_version);
        if !base_backup_dir.exists() {
            return Err(BackupError::Manifest(format!(
                "基础备份不存在: {}",
                base_version
            )));
        }

        // 创建增量备份目录
        let (backup_id, backup_subdir) = self.create_unique_backup_subdir(Some("incr"))?;

        let mut manifest = BackupManifest::new(&self.app_version);
        manifest.backup_id = backup_id;
        manifest.is_incremental = true;
        manifest.incremental_base = Some(base_version.to_string());

        // 对每个数据库导出变更
        for db_id in DatabaseId::all_ordered() {
            let db_path = self.get_database_path(&db_id);

            if !db_path.exists() {
                continue;
            }

            // 导出变更日志
            if let Some(backup_file) =
                self.export_changes(&db_id, &db_path, &backup_subdir, base_version)?
            {
                manifest.add_file(backup_file);
            }
        }

        // 保存清单
        let manifest_path = backup_subdir.join(MANIFEST_FILENAME);
        manifest.save_to_file(&manifest_path)?;

        info!("增量备份完成，共 {} 个变更文件", manifest.files.len());

        Ok(manifest)
    }

    /// 导出数据库的变更日志
    fn export_changes(
        &self,
        db_id: &DatabaseId,
        db_path: &Path,
        backup_dir: &Path,
        _base_version: &str,
    ) -> Result<Option<BackupFile>, BackupError> {
        let conn = Connection::open(db_path)?;

        // 检查变更日志表是否存在
        let table_exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='__change_log')",
            [],
            |row| row.get(0),
        )?;

        if !table_exists {
            debug!("数据库 {:?} 无变更日志表，跳过增量备份", db_id);
            return Ok(None);
        }

        // 查询未同步的变更
        let mut stmt = conn.prepare(
            "SELECT id, table_name, record_id, operation, changed_at, sync_version
             FROM __change_log
             WHERE sync_version = 0
             ORDER BY id ASC",
        )?;

        let changes: Vec<ChangeLogEntry> = stmt
            .query_map([], |row| {
                Ok(ChangeLogEntry {
                    id: row.get(0)?,
                    table_name: row.get(1)?,
                    record_id: row.get(2)?,
                    operation: row.get(3)?,
                    changed_at: row.get(4)?,
                    sync_version: row.get(5)?,
                })
            })?
            .filter_map(log_and_skip_err)
            .collect();

        if changes.is_empty() {
            debug!("数据库 {:?} 无新变更", db_id);
            return Ok(None);
        }

        // 序列化变更日志
        let changes_json = serde_json::to_string_pretty(&changes)
            .map_err(|e| BackupError::Manifest(format!("序列化变更日志失败: {}", e)))?;

        // 保存到文件
        let changes_path = backup_dir.join(format!("{}_changes.json", db_id.as_str()));
        let mut file = File::create(&changes_path)?;
        file.write_all(changes_json.as_bytes())?;
        file.sync_all()?;

        // 计算校验和
        let sha256 = calculate_file_sha256(&changes_path)?;
        let size = fs::metadata(&changes_path)?.len();

        info!("导出数据库 {:?} 的 {} 条变更记录", db_id, changes.len());

        Ok(Some(BackupFile {
            path: format!("{}_changes.json", db_id.as_str()),
            size,
            sha256,
            database_id: Some(db_id.as_str().to_string()),
        }))
    }

    /// 验证备份清单的版本兼容性
    ///
    /// ## 检查项
    ///
    /// 1. manifest 格式版本不超过当前应用支持的主版本
    /// 2. 增量备份不允许直接 restore（需要先合并）
    /// 3. schema 版本不超过当前应用已知的最新版本（防止未来版本数据覆盖）
    ///
    /// ## 错误
    ///
    /// - `BackupError::VersionIncompatible` - 版本不兼容，附带可操作的错误提示
    /// - `BackupError::IncrementalRestoreNotSupported` - 增量备份不支持直接恢复
    pub(crate) fn check_manifest_compatibility(
        &self,
        manifest: &BackupManifest,
    ) -> Result<(), BackupError> {
        // 1. 检查 manifest 格式版本
        let manifest_major = manifest
            .version
            .split('.')
            .next()
            .and_then(|s| s.parse::<u64>().ok())
            .unwrap_or(0);

        if manifest_major > MANIFEST_MAX_SUPPORTED_MAJOR {
            return Err(BackupError::VersionIncompatible(format!(
                "备份清单版本 {} 高于当前应用支持的最大版本 {}.x.x。请升级应用后重试恢复。",
                manifest.version, MANIFEST_MAX_SUPPORTED_MAJOR
            )));
        }

        // 2. 增量备份不支持直接恢复
        if manifest.is_incremental {
            return Err(BackupError::IncrementalRestoreNotSupported(
                "增量备份不支持直接恢复。请使用完整备份进行恢复，或等待后续版本支持增量恢复合并。"
                    .to_string(),
            ));
        }

        // 3. 检查 schema 版本兼容性（防止用未来版本的备份覆盖当前数据）
        #[cfg(feature = "data_governance")]
        {
            use crate::data_governance::migration::ALL_MIGRATION_SETS;
            use std::collections::HashSet;

            // fail-close：拒绝包含未知数据库的备份（避免“恢复成功但数据缺失”）
            //
            // 过去的实现会把未知数据库当作 max_known_version=0，
            // 进而跳过版本上限检查，并在 restore() 中静默跳过未知数据库文件。
            let known_db_ids: HashSet<&str> = DatabaseId::all_ordered()
                .into_iter()
                .map(|id| id.as_str())
                .collect();

            // 基于 schema_versions 的未知数据库检测
            for db_name in manifest.schema_versions.keys() {
                if !known_db_ids.contains(db_name.as_str()) {
                    return Err(BackupError::VersionIncompatible(format!(
                        "备份中包含当前应用未知的数据库 \"{}\"。为避免数据丢失，当前版本不会忽略该数据库。请升级应用到与备份兼容的版本后重试恢复。",
                        db_name
                    )));
                }
            }

            // 基于 files.database_id 的未知数据库检测
            for backup_file in &manifest.files {
                if !backup_file.path.ends_with(".db") {
                    continue;
                }
                let db_id_str = backup_file.database_id.as_deref().ok_or_else(|| {
                    BackupError::Manifest(format!("备份文件缺少 database_id: {}", backup_file.path))
                })?;
                if !known_db_ids.contains(db_id_str) {
                    return Err(BackupError::VersionIncompatible(format!(
                        "备份中包含当前应用未知的数据库 \"{}\"（文件: {}）。请升级应用到与备份兼容的版本后重试恢复。",
                        db_id_str, backup_file.path
                    )));
                }
            }

            for (db_name, &backup_schema_version) in &manifest.schema_versions {
                // 上面已检查 db_name 一定是已知数据库；这里若仍找不到则视为不一致并 fail-close。
                let max_known_version = ALL_MIGRATION_SETS
                    .iter()
                    .find(|set| set.database_name == db_name)
                    .ok_or_else(|| {
                        BackupError::VersionIncompatible(format!(
                            "备份中包含当前应用未知的数据库 \"{}\"。请升级应用到与备份兼容的版本后重试恢复。",
                            db_name
                        ))
                    })?
                    .latest_version() as u32;

                if backup_schema_version > max_known_version {
                    return Err(BackupError::VersionIncompatible(format!(
                        "备份中数据库 {} 的 schema 版本 (v{}) 高于当前应用支持的最新版本 (v{})。\
                         请升级应用到与备份兼容的版本后重试。",
                        db_name, backup_schema_version, max_known_version
                    )));
                }
            }
        }

        info!(
            "备份版本兼容性检查通过: manifest={}, schema_versions={:?}",
            manifest.version, manifest.schema_versions
        );

        Ok(())
    }

    /// 恢复备份
    ///
    /// ## 执行步骤
    ///
    /// 1. 验证清单版本兼容性
    /// 2. 验证清单和所有文件的校验和
    /// 3. 创建预恢复备份（用于回滚）
    /// 4. 使用 SQLite Backup API 恢复每个数据库
    /// 5. 验证恢复结果
    ///
    /// ## 安全机制
    ///
    /// - 恢复前检查备份版本，拒绝不兼容的未来版本
    /// - 恢复前自动备份当前数据到 `.pre_restore` 目录
    /// - 恢复失败时可通过预恢复备份回滚
    pub fn restore(&self, manifest: &BackupManifest) -> Result<(), BackupError> {
        info!("开始恢复备份: {}", manifest.backup_id);

        // 1. 版本兼容性检查
        self.check_manifest_compatibility(manifest)?;

        // 2. 获取备份目录
        let backup_subdir = self.backup_dir.join(&manifest.backup_id);
        if !backup_subdir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份目录不存在: {:?}",
                backup_subdir
            )));
        }

        // 3. 验证备份完整性
        self.verify_internal(manifest, &backup_subdir)?;

        // 3. 创建预恢复备份
        let pre_restore_dir = self.backup_dir.join(PRE_RESTORE_DIR);
        self.create_pre_restore_backup(&pre_restore_dir)?;

        // 4. 恢复每个数据库
        let mut restore_errors: Vec<String> = Vec::new();

        for backup_file in &manifest.files {
            // 只恢复数据库文件
            if !backup_file.path.ends_with(".db") {
                continue;
            }

            let db_id_str = backup_file.database_id.as_ref().ok_or_else(|| {
                BackupError::Manifest(format!("备份文件缺少 database_id: {}", backup_file.path))
            })?;

            let db_id = match db_id_str.as_str() {
                "vfs" => DatabaseId::Vfs,
                "chat_v2" => DatabaseId::ChatV2,
                "mistakes" => DatabaseId::Mistakes,
                "llm_usage" => DatabaseId::LlmUsage,
                _ => {
                    // 理论上 check_manifest_compatibility 已经拦截；这里做最后一道防线。
                    let msg = format!("备份中包含未知的数据库 ID: {}", db_id_str);
                    error!("{}", msg);
                    restore_errors.push(msg);
                    continue;
                }
            };

            match self.restore_single_database(&db_id, &backup_subdir) {
                Ok(()) => {
                    info!("恢复数据库成功: {:?}", db_id);
                }
                Err(e) => {
                    error!("恢复数据库失败: {:?}, 错误: {}", db_id, e);
                    restore_errors.push(format!("{:?}: {}", db_id, e));
                }
            }
        }

        // 4.5 恢复加密密钥（跨设备恢复支持）
        match self.restore_crypto_keys(&backup_subdir) {
            Ok(count) => {
                if count > 0 {
                    info!("加密密钥恢复完成: {} 个文件", count);
                }
            }
            Err(e) => {
                warn!("加密密钥恢复失败（API 密钥可能需要重新配置）: {}", e);
            }
        }

        // 5. 检查是否有错误
        if !restore_errors.is_empty() {
            error!("恢复失败，尝试自动回滚到预恢复备份: {:?}", pre_restore_dir);
            let rollback_result = self.rollback_from_pre_restore(&pre_restore_dir);
            return Err(match rollback_result {
                Ok(()) => BackupError::RestoreFailed(format!(
                    "部分数据库恢复失败并已自动回滚: {:?}",
                    restore_errors
                )),
                Err(rollback_err) => BackupError::RestoreFailed(format!(
                    "部分数据库恢复失败且自动回滚失败: {:?}; 回滚错误: {}",
                    restore_errors, rollback_err
                )),
            });
        }

        // 6. 清理预恢复备份（可选，保留以防万一）
        info!("恢复完成，预恢复备份保留在: {:?}", pre_restore_dir);

        Ok(())
    }

    pub(crate) fn rollback_from_pre_restore(
        &self,
        pre_restore_dir: &Path,
    ) -> Result<(), BackupError> {
        if !pre_restore_dir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "预恢复备份不存在: {:?}",
                pre_restore_dir
            )));
        }

        for db_id in DatabaseId::all_ordered() {
            let backup_path = self.get_backup_database_path(pre_restore_dir, &db_id);
            if backup_path.exists() {
                self.restore_single_database(&db_id, pre_restore_dir)?;
            }
        }

        Ok(())
    }

    /// 创建预恢复备份
    pub(crate) fn create_pre_restore_backup(
        &self,
        pre_restore_dir: &Path,
    ) -> Result<(), BackupError> {
        // 清理旧的预恢复备份
        if pre_restore_dir.exists() {
            fs::remove_dir_all(pre_restore_dir)?;
        }
        fs::create_dir_all(pre_restore_dir)?;

        info!("创建预恢复备份: {:?}", pre_restore_dir);

        // 备份所有存在的数据库
        let all_dbs = DatabaseId::all_ordered();
        let total_dbs = all_dbs.len();
        for (idx, db_id) in all_dbs.into_iter().enumerate() {
            let db_path = self.get_database_path(&db_id);

            if db_path.exists() {
                self.backup_single_database(&db_id, &db_path, pre_restore_dir, idx, total_dbs)?;
            }
        }

        Ok(())
    }

    /// 恢复单个数据库（写入活跃插槽，旧接口保留兼容）
    pub(crate) fn restore_single_database(
        &self,
        db_id: &DatabaseId,
        backup_dir: &Path,
    ) -> Result<(), BackupError> {
        let target_path = self.get_database_path(db_id);
        self.restore_single_database_to_path(db_id, backup_dir, &target_path)
    }

    /// 恢复单个数据库到指定目标目录（用于恢复到非活跃插槽）
    pub(crate) fn restore_single_database_to_dir(
        &self,
        db_id: &DatabaseId,
        backup_dir: &Path,
        target_dir: &Path,
    ) -> Result<(), BackupError> {
        let target_path = Self::resolve_database_path_in_dir(target_dir, db_id);
        self.restore_single_database_to_path(db_id, backup_dir, &target_path)
    }

    /// 恢复单个数据库到指定路径（内部实现）
    fn restore_single_database_to_path(
        &self,
        db_id: &DatabaseId,
        backup_dir: &Path,
        target_path: &Path,
    ) -> Result<(), BackupError> {
        let backup_path = self.get_backup_database_path(backup_dir, db_id);

        if !backup_path.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份文件不存在: {:?}",
                backup_path
            )));
        }

        // 确保目标目录存在
        if let Some(parent) = target_path.parent() {
            fs::create_dir_all(parent)?;
        }

        // 如果目标数据库存在，先关闭 WAL
        if target_path.exists() {
            let existing_conn = Connection::open(&target_path)?;
            existing_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            drop(existing_conn);

            // 删除 WAL 和 SHM 文件
            let wal_path = target_path.with_extension("db-wal");
            let shm_path = target_path.with_extension("db-shm");
            if wal_path.exists() {
                fs::remove_file(&wal_path)?;
            }
            if shm_path.exists() {
                fs::remove_file(&shm_path)?;
            }
        }

        // 使用 Backup API 恢复
        let src_conn = Connection::open(&backup_path)?;
        let mut dest_conn = Connection::open(&target_path)?;

        // 显式设置 busy_timeout，避免 Windows 文件锁场景下无界等待
        src_conn.pragma_update(None, "busy_timeout", 5000i64)?;
        dest_conn.pragma_update(None, "busy_timeout", 5000i64)?;

        debug!("恢复数据库: {:?} -> {:?}", backup_path, target_path);

        {
            let backup = Backup::new(&src_conn, &mut dest_conn)?;
            use rusqlite::backup::StepResult;

            // P0 修复：避免 Busy/Locked 时无限阻塞（Windows 下会表现为恢复进度长期卡住）
            const STEP_PAGES: i32 = 100;
            const RETRY_SLEEP_MS: u64 = 100;
            const MAX_BUSY_RETRIES: u32 = 600; // 约 60 秒

            let mut busy_retries: u32 = 0;

            loop {
                let step_result = backup.step(STEP_PAGES)?;
                match step_result {
                    StepResult::Done => break,
                    StepResult::More => {
                        // 复制有进展，重置 Busy/Locked 计数
                        busy_retries = 0;
                    }
                    StepResult::Busy | StepResult::Locked => {
                        busy_retries = busy_retries.saturating_add(1);
                        if busy_retries % 50 == 0 {
                            let p = backup.progress();
                            warn!(
                                "[data_governance] 恢复数据库等待锁释放: db={:?}, retry={}/{}, remaining_pages={}/{}",
                                db_id,
                                busy_retries,
                                MAX_BUSY_RETRIES,
                                p.remaining,
                                p.pagecount
                            );
                        }

                        if busy_retries >= MAX_BUSY_RETRIES {
                            return Err(BackupError::RestoreFailed(format!(
                                "恢复数据库超时：目标数据库持续被锁定（db={:?}, target={}）",
                                db_id,
                                target_path.display()
                            )));
                        }

                        std::thread::sleep(Duration::from_millis(RETRY_SLEEP_MS));
                    }
                    _ => {
                        std::thread::sleep(Duration::from_millis(RETRY_SLEEP_MS));
                    }
                }
            }
        }

        // 执行完整性检查
        let integrity_result: String =
            dest_conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;

        if integrity_result != "ok" {
            return Err(BackupError::IntegrityCheckFailed(format!(
                "恢复后完整性检查失败: {}",
                integrity_result
            )));
        }

        debug!("数据库恢复并验证成功: {:?}", db_id);

        Ok(())
    }

    /// 验证备份完整性
    ///
    /// ## 检查项目
    ///
    /// 1. 所有清单中的文件都存在
    /// 2. 每个文件的 SHA256 校验和正确
    /// 3. 每个数据库通过 `PRAGMA integrity_check`
    pub fn verify(&self, manifest: &BackupManifest) -> Result<(), BackupError> {
        let backup_subdir = self.backup_dir.join(&manifest.backup_id);
        if !backup_subdir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份目录不存在: {:?}",
                backup_subdir
            )));
        }

        self.verify_internal(manifest, &backup_subdir)
    }

    /// 内部验证方法
    pub(crate) fn verify_internal(
        &self,
        manifest: &BackupManifest,
        backup_dir: &Path,
    ) -> Result<(), BackupError> {
        info!("验证备份: {}", manifest.backup_id);

        let mut errors: Vec<String> = Vec::new();

        for backup_file in &manifest.files {
            let file_path = backup_dir.join(&backup_file.path);

            // 1. 检查文件存在
            if !file_path.exists() {
                errors.push(format!("文件不存在: {}", backup_file.path));
                continue;
            }

            // 2. 验证校验和
            let actual_sha256 = match calculate_file_sha256(&file_path) {
                Ok(hash) => hash,
                Err(e) => {
                    errors.push(format!("计算校验和失败 {}: {}", backup_file.path, e));
                    continue;
                }
            };

            if actual_sha256 != backup_file.sha256 {
                errors.push(format!(
                    "校验和不匹配 {}: expected={}, actual={}",
                    backup_file.path, backup_file.sha256, actual_sha256
                ));
                continue;
            }

            // 3. 验证数据库完整性（仅对 .db 文件）
            if backup_file.path.ends_with(".db") {
                match self.verify_database_integrity(&file_path) {
                    Ok(()) => {
                        debug!("文件验证通过: {}", backup_file.path);
                    }
                    Err(e) => {
                        errors.push(format!("数据库完整性检查失败 {}: {}", backup_file.path, e));
                    }
                }
            } else {
                debug!("文件验证通过: {}", backup_file.path);
            }
        }

        // 验证清单文件
        let manifest_path = backup_dir.join(MANIFEST_FILENAME);
        if !manifest_path.exists() {
            errors.push("清单文件不存在".to_string());
        }

        if errors.is_empty() {
            info!("备份验证通过: {} 个文件", manifest.files.len());
            Ok(())
        } else {
            let error_count = errors.len();
            Err(BackupError::Manifest(format!(
                "备份验证失败（{} 个错误）。备份可能已损坏，请使用其他备份或重新创建备份。\n详情:\n{}",
                error_count,
                errors.join("\n")
            )))
        }
    }

    /// 验证数据库文件完整性
    fn verify_database_integrity(&self, db_path: &Path) -> Result<(), BackupError> {
        let conn = Connection::open(db_path)?;

        // 执行完整性检查
        let result: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;

        if result == "ok" {
            Ok(())
        } else {
            Err(BackupError::IntegrityCheckFailed(result))
        }
    }

    // =========================================================================
    // 工作区数据库备份/恢复（ws_*.db，位于 active_dir/workspaces/）
    // =========================================================================

    /// 使用 SQLite Backup API 备份任意路径的数据库（不依赖 DatabaseId）
    fn backup_db_at_path(src_path: &Path, dest_path: &Path) -> Result<(), BackupError> {
        let src_conn = Connection::open(src_path)?;
        src_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;

        let mut dest_conn = Connection::open(dest_path)?;
        {
            let backup = Backup::new(&src_conn, &mut dest_conn)?;
            use rusqlite::backup::StepResult;
            loop {
                match backup.step(100)? {
                    StepResult::Done => break,
                    _ => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        }
        dest_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        drop(dest_conn);
        drop(src_conn);
        Ok(())
    }

    /// 使用 SQLite Backup API 恢复任意路径的数据库（不依赖 DatabaseId）
    fn restore_db_at_path(src_path: &Path, dest_path: &Path) -> Result<(), BackupError> {
        if !src_path.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份文件不存在: {:?}",
                src_path
            )));
        }
        if let Some(parent) = dest_path.parent() {
            fs::create_dir_all(parent)?;
        }
        // 目标存在时先关闭 WAL
        if dest_path.exists() {
            let conn = Connection::open(dest_path)?;
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
            drop(conn);
            let wal = dest_path.with_extension("db-wal");
            let shm = dest_path.with_extension("db-shm");
            if wal.exists() { let _ = fs::remove_file(&wal); }
            if shm.exists() { let _ = fs::remove_file(&shm); }
        }
        let src_conn = Connection::open(src_path)?;
        let mut dest_conn = Connection::open(dest_path)?;
        src_conn.pragma_update(None, "busy_timeout", 5000i64)?;
        dest_conn.pragma_update(None, "busy_timeout", 5000i64)?;
        {
            let backup = Backup::new(&src_conn, &mut dest_conn)?;
            use rusqlite::backup::StepResult;
            let mut busy_retries: u32 = 0;
            loop {
                match backup.step(100)? {
                    StepResult::Done => break,
                    StepResult::More => { busy_retries = 0; }
                    StepResult::Busy | StepResult::Locked => {
                        busy_retries += 1;
                        if busy_retries >= 600 {
                            return Err(BackupError::RestoreFailed(format!(
                                "恢复工作区数据库超时: {:?}",
                                dest_path
                            )));
                        }
                        std::thread::sleep(Duration::from_millis(100));
                    }
                    _ => std::thread::sleep(Duration::from_millis(50)),
                }
            }
        }
        dest_conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")?;
        drop(dest_conn);
        drop(src_conn);
        Ok(())
    }

    /// 备份工作区数据库（ws_*.db → backup_dir/workspaces/ws_*.db）
    ///
    /// 使用 SQLite Backup API，对每个打开中的 WAL 模式数据库都是安全的。
    /// 备份失败不阻断主流程（返回已成功备份数量）。
    fn backup_workspace_databases(
        &self,
        active_dir: &Path,
        backup_dir: &Path,
    ) -> Result<usize, BackupError> {
        let src_dir = active_dir.join("workspaces");
        if !src_dir.exists() {
            return Ok(0);
        }
        let dest_dir = backup_dir.join("workspaces");
        fs::create_dir_all(&dest_dir)?;

        let mut count = 0usize;
        for entry in fs::read_dir(&src_dir)? {
            let entry = entry?;
            let src = entry.path();
            let name = src.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with("ws_") || !name.ends_with(".db") {
                continue;
            }
            let dest = dest_dir.join(&*name);
            match Self::backup_db_at_path(&src, &dest) {
                Ok(()) => {
                    count += 1;
                    debug!("备份工作区数据库: {:?} -> {:?}", src, dest);
                }
                Err(e) => {
                    warn!("备份工作区数据库失败（跳过）: {:?}: {}", src, e);
                }
            }
        }
        if count > 0 {
            info!("工作区数据库备份完成: {} 个", count);
        }
        Ok(count)
    }

    /// 恢复工作区数据库（backup_dir/workspaces/ws_*.db → target_dir/workspaces/ws_*.db）
    ///
    /// 恢复失败记录警告但不阻断主流程。
    fn restore_workspace_databases(
        &self,
        backup_dir: &Path,
        target_dir: &Path,
    ) -> Result<usize, BackupError> {
        let src_dir = backup_dir.join("workspaces");
        if !src_dir.exists() {
            return Ok(0);
        }
        let dest_dir = target_dir.join("workspaces");
        fs::create_dir_all(&dest_dir)?;

        let mut count = 0usize;
        for entry in fs::read_dir(&src_dir)? {
            let entry = entry?;
            let src = entry.path();
            let name = src.file_name().unwrap_or_default().to_string_lossy();
            if !name.starts_with("ws_") || !name.ends_with(".db") {
                continue;
            }
            let dest = dest_dir.join(&*name);
            match Self::restore_db_at_path(&src, &dest) {
                Ok(()) => {
                    count += 1;
                    debug!("恢复工作区数据库: {:?} -> {:?}", src, dest);
                }
                Err(e) => {
                    warn!("恢复工作区数据库失败（跳过）: {:?}: {}", src, e);
                }
            }
        }
        if count > 0 {
            info!("工作区数据库恢复完成: {} 个", count);
        }
        Ok(count)
    }

    /// 列出所有备份
    pub fn list_backups(&self) -> Result<Vec<BackupManifest>, BackupError> {
        let mut backups = Vec::new();

        if !self.backup_dir.exists() {
            return Ok(backups);
        }

        for entry in fs::read_dir(&self.backup_dir)? {
            let entry = entry?;
            let path = entry.path();

            if path.is_dir() {
                let manifest_path = path.join(MANIFEST_FILENAME);
                if manifest_path.exists() {
                    match BackupManifest::load_from_file(&manifest_path) {
                        Ok(mut manifest) => {
                            // 关键约束：backup_id 必须与目录名一致，否则删除/验证/恢复会失效。
                            // 为兼容历史数据（曾出现增量备份目录名与 manifest.backup_id 不一致的问题），这里强制以目录名为准。
                            if let Some(dir_name) =
                                path.file_name().map(|n| n.to_string_lossy().to_string())
                            {
                                if manifest.backup_id != dir_name {
                                    warn!(
                                        "备份清单 backup_id 与目录名不一致，将以目录名为准: manifest.backup_id={}, dir={}",
                                        manifest.backup_id, dir_name
                                    );
                                    manifest.backup_id = dir_name;
                                }
                            }
                            backups.push(manifest);
                        }
                        Err(e) => {
                            warn!("无法加载备份清单 {:?}: {}", manifest_path, e);
                        }
                    }
                }
            }
        }

        // 按创建时间排序（最新的在前）
        backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));

        Ok(backups)
    }

    /// 删除指定的备份
    pub fn delete_backup(&self, backup_id: &str) -> Result<(), BackupError> {
        let backup_dir = self.backup_dir.join(backup_id);

        if !backup_dir.exists() {
            return Err(BackupError::FileNotFound(format!(
                "备份不存在: {}",
                backup_id
            )));
        }

        fs::remove_dir_all(&backup_dir)?;
        info!("已删除备份: {}", backup_id);

        Ok(())
    }

    /// 清理旧备份，保留指定数量
    pub fn cleanup_old_backups(&self, keep_count: usize) -> Result<Vec<String>, BackupError> {
        let mut backups = self.list_backups()?;
        let mut deleted = Vec::new();

        // 只保留完整备份用于计数
        backups.retain(|b| !b.is_incremental);

        if backups.len() <= keep_count {
            return Ok(deleted);
        }

        // 删除超出数量的旧备份
        for backup in backups.iter().skip(keep_count) {
            match self.delete_backup(&backup.backup_id) {
                Ok(()) => deleted.push(backup.backup_id.clone()),
                Err(e) => {
                    warn!("删除旧备份失败 {}: {}", backup.backup_id, e);
                }
            }
        }

        info!("清理旧备份完成，删除 {} 个", deleted.len());

        Ok(deleted)
    }

    // ========================================================================
    // 分层备份 (Tiered Backup) 方法
    // ========================================================================

    /// 分层备份
    ///
    /// 根据 `BackupSelection` 配置执行分层备份，支持：
    /// - 按层级选择要备份的数据
    /// - 显式包含/排除特定数据库
    /// - 可选备份资产文件
    ///
    /// ## 参数
    ///
    /// * `selection` - 备份选择配置
    ///
    /// ## 返回
    ///
    /// `TieredBackupResult` 包含备份清单和统计信息
    pub fn backup_tiered(
        &self,
        selection: &BackupSelection,
    ) -> Result<TieredBackupResult, BackupError> {
        let start = std::time::Instant::now();
        info!("开始执行分层备份，层级: {:?}", selection.tiers);

        // 1. 创建备份目录
        let (backup_id, backup_subdir) = self.create_unique_backup_subdir(Some("tiered"))?;

        info!("分层备份目录: {:?}", backup_subdir);

        // 2. 创建清单
        let mut manifest = BackupManifest::new(&self.app_version);
        manifest.backup_id = backup_id;

        // 3. 统计信息
        let mut tier_file_counts: HashMap<String, usize> = HashMap::new();
        let mut tier_sizes: HashMap<String, u64> = HashMap::new();
        let mut skipped_files: Vec<SkippedFile> = Vec::new();
        let mut backed_up_tiers: Vec<BackupTier> = Vec::new();

        // 4. 备份数据库
        let all_dbs = DatabaseId::all_ordered();
        let selected_dbs: Vec<_> = all_dbs
            .into_iter()
            .filter(|db_id| selection.should_backup_database(db_id))
            .collect();
        let total_selected = selected_dbs.len();

        for (idx, db_id) in selected_dbs.into_iter().enumerate() {
            let db_path = self.get_database_path(&db_id);

            // 检查数据库是否存在
            if !db_path.exists() {
                warn!("数据库不存在，跳过: {:?}", db_path);
                continue;
            }

            // 发送进度回调
            if let Some(ref cb) = self.progress_callback {
                cb(idx, total_selected, db_id.as_str(), 0, 0);
            }

            info!("备份数据库: {:?} -> {:?}", db_id, db_path);

            // 备份单个数据库
            let backup_file =
                self.backup_single_database(&db_id, &db_path, &backup_subdir, idx, total_selected)?;

            // 确定此数据库属于哪个层级
            let tier = self.get_database_tier(&db_id);
            let tier_name = format!("{:?}", tier);

            *tier_file_counts.entry(tier_name.clone()).or_insert(0) += 1;
            *tier_sizes.entry(tier_name).or_insert(0) += backup_file.size;

            manifest.add_file(backup_file);

            // 获取 schema 版本
            let version = self.get_schema_version(&db_path)?;
            manifest.set_schema_version(db_id.as_str(), version);
        }

        // 5. 备份资产文件（如果启用）
        if selection.include_assets {
            let asset_config = selection.asset_config.clone().unwrap_or_default();
            let asset_dirs = selection.get_asset_directories();

            // 使用活动数据空间目录查找资产（与运行时 FileManager 绑定位置一致）
            let active_asset_base = crate::data_space::get_data_space_manager()
                .map(|mgr| mgr.active_dir())
                .unwrap_or_else(|| self.app_data_dir.join("slots").join("slotA"));

            // 如果指定了 asset_types，只备份匹配的目录；否则按 tier 全部备份
            let allowed_dirs: std::collections::HashSet<&str> =
                if !asset_config.asset_types.is_empty() {
                    asset_config
                        .asset_types
                        .iter()
                        .map(|t| t.relative_path())
                        .collect()
                } else {
                    asset_dirs.iter().copied().collect()
                };

            for dir_name in asset_dirs {
                // 跳过不在 asset_types 筛选列表中的目录
                if !allowed_dirs.contains(dir_name) {
                    debug!("资产目录 {} 不在 asset_types 筛选列表中，跳过", dir_name);
                    continue;
                }

                let asset_dir = active_asset_base.join(dir_name);
                if !asset_dir.exists() {
                    debug!("资产目录不存在，跳过: {:?}", asset_dir);
                    continue;
                }

                info!("备份资产目录: {:?}", asset_dir);

                let (files, skipped) = self.backup_asset_directory(
                    &asset_dir,
                    dir_name,
                    &backup_subdir,
                    &asset_config,
                )?;

                for file in files {
                    let tier_name = "LargeAssets".to_string();
                    *tier_file_counts.entry(tier_name.clone()).or_insert(0) += 1;
                    *tier_sizes.entry(tier_name).or_insert(0) += file.size;
                    manifest.add_file(file);
                }

                skipped_files.extend(skipped);
            }
        }

        // 6. 记录备份的层级
        for tier in BackupTier::all_ordered() {
            let tier_name = format!("{:?}", tier);
            if tier_file_counts.contains_key(&tier_name) {
                backed_up_tiers.push(tier);
            }
        }

        // 7. 保存清单
        let manifest_path = backup_subdir.join(MANIFEST_FILENAME);
        manifest.save_to_file(&manifest_path)?;

        let duration_ms = start.elapsed().as_millis() as u64;

        info!(
            "分层备份完成，共 {} 个文件，耗时 {}ms",
            manifest.files.len(),
            duration_ms
        );

        Ok(TieredBackupResult {
            manifest,
            backed_up_tiers,
            tier_file_counts,
            tier_sizes,
            skipped_files,
            duration_ms,
        })
    }

    /// 获取数据库所属的层级
    fn get_database_tier(&self, db_id: &DatabaseId) -> BackupTier {
        for tier in BackupTier::all_ordered() {
            if tier.databases().contains(db_id) {
                return tier;
            }
        }
        // 默认为 Important 层级
        BackupTier::Important
    }

    /// 备份资产目录
    ///
    /// 遍历目录并备份符合条件的文件
    fn backup_asset_directory(
        &self,
        source_dir: &Path,
        dir_name: &str,
        backup_dir: &Path,
        config: &TieredAssetConfig,
    ) -> Result<(Vec<BackupFile>, Vec<SkippedFile>), BackupError> {
        let mut files = Vec::new();
        let mut skipped = Vec::new();

        // 创建目标目录
        let target_dir = backup_dir.join(dir_name);
        fs::create_dir_all(&target_dir)?;

        // 遍历源目录
        let walker = WalkDir::new(source_dir)
            .follow_links(config.follow_symlinks)
            .into_iter()
            .filter_entry(|e| {
                // 过滤隐藏文件
                if !config.include_hidden {
                    if let Some(name) = e.file_name().to_str() {
                        if name.starts_with('.') {
                            return false;
                        }
                    }
                }
                true
            });

        for entry in walker {
            let entry = match entry {
                Ok(e) => e,
                Err(e) => {
                    warn!("遍历目录错误: {}", e);
                    continue;
                }
            };

            // 只处理文件
            if !entry.file_type().is_file() {
                continue;
            }

            let path = entry.path();
            let relative_path = path
                .strip_prefix(source_dir)
                .map_err(|_| BackupError::BackupDirectory("无法计算相对路径".to_string()))?;

            // 检查文件扩展名
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                let ext_lower = ext.to_lowercase();

                // 排除的扩展名
                if config
                    .exclude_extensions
                    .iter()
                    .any(|e| e.to_lowercase() == ext_lower)
                {
                    skipped.push(SkippedFile {
                        path: relative_path.to_string_lossy().to_string(),
                        reason: format!("排除的扩展名: {}", ext),
                    });
                    continue;
                }

                // 包含的扩展名（如果指定了的话）
                if !config.include_extensions.is_empty()
                    && !config
                        .include_extensions
                        .iter()
                        .any(|e| e.to_lowercase() == ext_lower)
                {
                    skipped.push(SkippedFile {
                        path: relative_path.to_string_lossy().to_string(),
                        reason: format!("不在包含列表中: {}", ext),
                    });
                    continue;
                }
            }

            // 检查文件大小
            let metadata = fs::metadata(path)?;
            if metadata.len() > config.max_file_size {
                skipped.push(SkippedFile {
                    path: relative_path.to_string_lossy().to_string(),
                    reason: format!(
                        "文件过大: {} bytes > {} bytes",
                        metadata.len(),
                        config.max_file_size
                    ),
                });
                continue;
            }

            // 复制文件
            let target_path = target_dir.join(relative_path);
            if let Some(parent) = target_path.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::copy(path, &target_path)?;

            // 计算校验和
            let sha256 = calculate_file_sha256(&target_path)?;

            files.push(BackupFile {
                path: format!("{}/{}", dir_name, relative_path.to_string_lossy()),
                size: metadata.len(),
                sha256,
                database_id: None,
            });
        }

        debug!(
            "资产目录 {} 备份完成：{} 个文件，{} 个跳过",
            dir_name,
            files.len(),
            skipped.len()
        );

        Ok((files, skipped))
    }
}

/// 变更日志条目
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChangeLogEntry {
    id: i64,
    table_name: String,
    record_id: String,
    operation: String,
    changed_at: String,
    sync_version: i64,
}

/// 计算文件的 SHA256 校验和
pub(crate) fn calculate_file_sha256(path: &Path) -> Result<String, BackupError> {
    let file = File::open(path)?;
    let mut reader = BufReader::new(file);
    let mut hasher = Sha256::new();

    let mut buffer = [0u8; 8192];
    loop {
        let bytes_read = reader.read(&mut buffer)?;
        if bytes_read == 0 {
            break;
        }
        hasher.update(&buffer[..bytes_read]);
    }

    let result = hasher.finalize();
    Ok(hex::encode(result))
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_env() -> (BackupManager, TempDir, TempDir) {
        let backup_dir = TempDir::new().unwrap();
        let app_data_dir = TempDir::new().unwrap();

        let mut manager = BackupManager::new(backup_dir.path().to_path_buf());
        manager.set_app_data_dir(app_data_dir.path().to_path_buf());
        manager.set_app_version("1.0.0".to_string());

        (manager, backup_dir, app_data_dir)
    }

    fn create_test_database(path: &Path) -> rusqlite::Result<()> {
        let conn = Connection::open(path)?;
        conn.execute_batch(
            "CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO test_table (name) VALUES ('test1'), ('test2');",
        )?;
        Ok(())
    }

    #[test]
    fn test_new_manager() {
        let dir = TempDir::new().unwrap();
        let manager = BackupManager::new(dir.path().to_path_buf());
        assert_eq!(manager.backup_dir(), dir.path());
    }

    #[test]
    fn test_list_backups_overrides_manifest_backup_id_with_dir_name() {
        let backup_dir = TempDir::new().unwrap();

        // 历史问题复现：目录名与 manifest.backup_id 不一致
        let backup_dir_name = "20260207_120000_incr";
        let backup_subdir = backup_dir.path().join(backup_dir_name);
        std::fs::create_dir_all(&backup_subdir).unwrap();

        let mut manifest = BackupManifest::new("1.0.0-test");
        manifest.backup_id = "WRONG_ID".to_string();
        manifest
            .save_to_file(&backup_subdir.join(MANIFEST_FILENAME))
            .unwrap();

        let manager = BackupManager::new(backup_dir.path().to_path_buf());
        let backups = manager.list_backups().unwrap();

        assert_eq!(backups.len(), 1);
        assert_eq!(backups[0].backup_id, backup_dir_name);
    }

    #[test]
    fn test_manifest_serialization() {
        let mut manifest = BackupManifest::new("1.0.0");
        manifest.add_file(BackupFile {
            path: "test.db".to_string(),
            size: 1024,
            sha256: "abc123".to_string(),
            database_id: Some("test".to_string()),
        });
        manifest.set_schema_version("test", 1);

        let json = serde_json::to_string(&manifest).unwrap();
        let loaded: BackupManifest = serde_json::from_str(&json).unwrap();

        assert_eq!(loaded.version, manifest.version);
        assert_eq!(loaded.files.len(), 1);
        assert_eq!(loaded.schema_versions.get("test"), Some(&1));
    }

    #[test]
    fn test_backup_and_restore_single_database() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();

        // 创建测试数据库目录（模拟活动数据空间 slots/slotA）
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        // 创建 VFS 测试数据库
        let vfs_db_path = db_dir.join("vfs.db");
        create_test_database(&vfs_db_path).unwrap();

        // 执行备份
        let manifest = manager.backup_full().unwrap();

        assert!(!manifest.files.is_empty());
        assert!(manifest.files.iter().any(|f| f.path == "vfs.db"));

        // 验证备份
        manager.verify(&manifest).unwrap();

        // 删除原始数据库
        fs::remove_file(&vfs_db_path).unwrap();

        // 恢复
        manager.restore(&manifest).unwrap();

        // 验证恢复后的数据库
        assert!(vfs_db_path.exists());
        let conn = Connection::open(&vfs_db_path).unwrap();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn test_verify_checksum_mismatch() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();

        // 创建测试数据库（模拟活动数据空间 slots/slotA）
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();
        let vfs_db_path = db_dir.join("vfs.db");
        create_test_database(&vfs_db_path).unwrap();

        // 执行备份
        let manifest = manager.backup_full().unwrap();

        // 修改备份文件
        let backup_subdir = backup_dir.path().join(&manifest.backup_id);
        let backup_file = backup_subdir.join("vfs.db");
        fs::write(&backup_file, "corrupted").unwrap();

        // 验证应该失败
        let result = manager.verify(&manifest);
        assert!(result.is_err());
    }

    #[test]
    fn test_list_and_cleanup_backups() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();

        // 创建测试数据库（模拟活动数据空间 slots/slotA）
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();
        let vfs_db_path = db_dir.join("vfs.db");
        create_test_database(&vfs_db_path).unwrap();

        // 创建多个备份（增加间隔确保时间戳不同）
        for _ in 0..3 {
            manager.backup_full().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(1100)); // 确保时间戳不同
        }

        // 列出备份
        let backups = manager.list_backups().unwrap();
        assert!(
            backups.len() >= 2,
            "Expected at least 2 backups, got {}",
            backups.len()
        );

        // 清理旧备份，保留 1 个
        let backup_count_before = backups.len();
        let deleted = manager.cleanup_old_backups(1).unwrap();
        assert!(
            deleted.len() >= backup_count_before.saturating_sub(1),
            "Should delete backups beyond keep_count"
        );

        // 验证剩余备份数量
        let remaining = manager.list_backups().unwrap();
        assert!(
            remaining.len() <= 1,
            "Should have at most 1 backup remaining"
        );
    }

    #[test]
    fn test_calculate_file_sha256() {
        let dir = TempDir::new().unwrap();
        let file_path = dir.path().join("test.txt");
        fs::write(&file_path, "hello world").unwrap();

        let hash = calculate_file_sha256(&file_path).unwrap();

        // SHA256 of "hello world"
        assert_eq!(
            hash,
            "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9"
        );
    }

    #[test]
    fn test_backup_nonexistent_database() {
        let (manager, _backup_dir, _app_data_dir) = setup_test_env();

        // 不创建任何数据库，执行备份
        let manifest = manager.backup_full().unwrap();

        // 应该成功但文件列表为空
        assert!(manifest.files.is_empty());
    }

    #[test]
    fn test_manifest_save_and_load() {
        let dir = TempDir::new().unwrap();
        let manifest_path = dir.path().join("manifest.json");

        let mut manifest = BackupManifest::new("2.0.0");
        manifest.set_schema_version("vfs", 3);
        manifest.add_file(BackupFile {
            path: "vfs.db".to_string(),
            size: 2048,
            sha256: "def456".to_string(),
            database_id: Some("vfs".to_string()),
        });

        // 保存
        manifest.save_to_file(&manifest_path).unwrap();

        // 加载
        let loaded = BackupManifest::load_from_file(&manifest_path).unwrap();

        assert_eq!(loaded.app_version, "2.0.0");
        assert_eq!(loaded.schema_versions.get("vfs"), Some(&3));
        assert_eq!(loaded.files.len(), 1);
    }

    // ========================================================================
    // 恢复操作集成测试
    // ========================================================================

    /// 测试 1: 正常恢复流程
    ///
    /// 创建备份 → 修改数据（增删改） → 恢复 → 验证数据恢复到备份时状态
    #[test]
    fn test_restore_reverts_data_to_backup_state() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();

        // 创建测试数据库（模拟活动数据空间 slots/slotA）
        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        let vfs_db_path = db_dir.join("vfs.db");
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO test_table (name) VALUES ('original_row1'), ('original_row2');",
        )
        .unwrap();
        drop(conn);

        // 创建备份
        let manifest = manager.backup_full().unwrap();

        // 修改数据：删除一行、添加一行、更新一行
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute("DELETE FROM test_table WHERE name = 'original_row1'", [])
            .unwrap();
        conn.execute("INSERT INTO test_table (name) VALUES ('new_row3')", [])
            .unwrap();
        conn.execute(
            "UPDATE test_table SET name = 'modified_row2' WHERE name = 'original_row2'",
            [],
        )
        .unwrap();

        // 确认数据已被修改
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2); // 'modified_row2' + 'new_row3'
        let has_new: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'new_row3')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_new,
            "Precondition: new_row3 should exist before restore"
        );
        drop(conn);

        // 执行恢复
        manager.restore(&manifest).unwrap();

        // 验证数据恢复到备份时状态
        let conn = Connection::open(&vfs_db_path).unwrap();
        let count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(count, 2, "Should have exactly 2 rows as in original backup");

        let mut stmt = conn
            .prepare("SELECT name FROM test_table ORDER BY name")
            .unwrap();
        let names: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert_eq!(
            names,
            vec!["original_row1", "original_row2"],
            "Data should revert to backup state"
        );

        // new_row3 不应存在
        let has_new: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'new_row3')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !has_new,
            "new_row3 should not exist after restore to backup state"
        );

        // modified_row2 应恢复为 original_row2
        let has_original: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'original_row2')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            has_original,
            "original_row2 should be restored (not modified_row2)"
        );
    }

    /// 测试 2: 恢复后完整性检查
    ///
    /// 创建带索引和外键的复杂数据库 → 备份 → 恢复 → PRAGMA integrity_check 通过
    #[test]
    fn test_restore_integrity_check_passes_on_restored_db() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        // 创建一个包含索引和外键引用的复杂数据库
        let vfs_db_path = db_dir.join("vfs.db");
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute_batch(
            "PRAGMA foreign_keys = ON;
             CREATE TABLE items (
                 id INTEGER PRIMARY KEY,
                 value TEXT NOT NULL,
                 created_at INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE tags (
                 id INTEGER PRIMARY KEY,
                 item_id INTEGER NOT NULL REFERENCES items(id),
                 tag TEXT NOT NULL
             );
             CREATE INDEX idx_tags_item ON tags(item_id);
             CREATE INDEX idx_items_value ON items(value);
             INSERT INTO items (id, value, created_at) VALUES (1, 'item_alpha', 1000);
             INSERT INTO items (id, value, created_at) VALUES (2, 'item_beta', 2000);
             INSERT INTO items (id, value, created_at) VALUES (3, 'item_gamma', 3000);
             INSERT INTO tags (item_id, tag) VALUES (1, 'rust');
             INSERT INTO tags (item_id, tag) VALUES (1, 'systems');
             INSERT INTO tags (item_id, tag) VALUES (2, 'python');
             INSERT INTO tags (item_id, tag) VALUES (3, 'sql');",
        )
        .unwrap();
        drop(conn);

        // 备份
        let manifest = manager.backup_full().unwrap();

        // 删除原始数据库
        fs::remove_file(&vfs_db_path).unwrap();
        // 删除 WAL/SHM 文件（如果存在）
        let _ = fs::remove_file(vfs_db_path.with_extension("db-wal"));
        let _ = fs::remove_file(vfs_db_path.with_extension("db-shm"));

        // 恢复
        manager.restore(&manifest).unwrap();

        // 显式验证完整性
        let conn = Connection::open(&vfs_db_path).unwrap();

        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            integrity, "ok",
            "PRAGMA integrity_check should pass after restore"
        );

        // 验证索引仍然存在
        let idx_count: i32 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(
            idx_count, 2,
            "Both user-created indexes should exist after restore"
        );

        // 验证数据完整性
        let item_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))
            .unwrap();
        assert_eq!(item_count, 3, "All 3 items should be restored");

        let tag_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM tags", [], |row| row.get(0))
            .unwrap();
        assert_eq!(tag_count, 4, "All 4 tags should be restored");

        // 验证外键关系完整（PRAGMA foreign_key_check 返回空 = 无违规）
        conn.execute_batch("PRAGMA foreign_keys = ON").unwrap();
        let mut fk_stmt = conn.prepare("PRAGMA foreign_key_check").unwrap();
        let fk_violations: Vec<String> = fk_stmt
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(
            fk_violations.is_empty(),
            "No foreign key violations should exist after restore, got: {:?}",
            fk_violations
        );
    }

    /// 测试 3: 恢复损坏备份
    ///
    /// 创建有效备份 → 损坏 .db 文件（保持 SHA256 正确）→ 验证恢复被拒绝
    #[test]
    fn test_restore_rejects_corrupted_backup_db() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        let vfs_db_path = db_dir.join("vfs.db");
        create_test_database(&vfs_db_path).unwrap();

        // 创建有效备份
        let mut manifest = manager.backup_full().unwrap();

        // 损坏备份中的 .db 文件：保留 SQLite 头部但翻转内部数据页
        let backup_subdir = backup_dir.path().join(&manifest.backup_id);
        let backup_db = backup_subdir.join("vfs.db");
        let mut data = fs::read(&backup_db).unwrap();

        // 保留前 100 字节（SQLite 头部），损坏后面的数据页
        if data.len() > 200 {
            for byte in data[100..200].iter_mut() {
                *byte = 0xFF;
            }
        }
        fs::write(&backup_db, &data).unwrap();

        // 更新 manifest 中的 SHA256，使校验和匹配损坏后的文件
        // 这样可以测试 integrity_check 阶段是否能发现损坏
        let corrupted_sha = calculate_file_sha256(&backup_db).unwrap();
        let corrupted_size = fs::metadata(&backup_db).unwrap().len();
        for file in &mut manifest.files {
            if file.path == "vfs.db" {
                file.sha256 = corrupted_sha.clone();
                file.size = corrupted_size;
            }
        }
        // 重新保存 manifest
        manifest
            .save_to_file(&backup_subdir.join(MANIFEST_FILENAME))
            .unwrap();

        // 恢复应失败（verify_internal 的 integrity_check 阶段会检测到损坏）
        let result = manager.restore(&manifest);
        assert!(
            result.is_err(),
            "Restore should reject backup with corrupted .db file"
        );

        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("integrity")
                || err_msg.contains("not a database")
                || err_msg.contains("完整性")
                || err_msg.contains("验证失败")
                || err_msg.contains("损坏"),
            "Error should mention integrity/corruption issue, got: {}",
            err_msg
        );
    }

    /// 测试 4: 恢复时写入失败的优雅处理（模拟磁盘空间不足）
    ///
    /// 通过设置目标目录只读来模拟无法写入的场景（Unix only）。
    /// 验证恢复操作不会 panic，而是返回可操作的错误信息。
    #[cfg(unix)]
    #[test]
    fn test_restore_handles_write_failure_gracefully() {
        use std::os::unix::fs::PermissionsExt;

        let (manager, backup_dir, app_data_dir) = setup_test_env();

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        let vfs_db_path = db_dir.join("vfs.db");
        create_test_database(&vfs_db_path).unwrap();

        // 创建有效备份
        let manifest = manager.backup_full().unwrap();

        // 将备份根目录设为只读，阻止创建 .pre_restore 目录
        // 这模拟了磁盘空间不足或权限问题导致无法创建预恢复备份
        let perms_original = fs::metadata(backup_dir.path()).unwrap().permissions();
        let mut perms_readonly = perms_original.clone();
        perms_readonly.set_mode(0o555);
        fs::set_permissions(backup_dir.path(), perms_readonly).unwrap();

        // 尝试恢复
        let result = manager.restore(&manifest);

        // 恢复原始权限（确保 TempDir 清理不会失败）
        let mut perms_restore = fs::metadata(backup_dir.path()).unwrap().permissions();
        perms_restore.set_mode(0o755);
        fs::set_permissions(backup_dir.path(), perms_restore).unwrap();

        // 验证：不应 panic，应返回明确的 IO 错误
        assert!(
            result.is_err(),
            "Restore should fail when pre_restore backup directory cannot be created"
        );

        let err_msg = format!("{}", result.unwrap_err());
        assert!(
            err_msg.contains("IO")
                || err_msg.contains("Permission")
                || err_msg.contains("denied")
                || err_msg.contains("permission")
                || err_msg.contains("read-only"),
            "Error should indicate IO/permission failure, got: {}",
            err_msg
        );
    }

    /// 测试 5: 恢复后 schema 版本验证
    ///
    /// 创建包含 refinery_schema_history 的数据库 → 备份 → 恢复 →
    /// 验证恢复后的 schema 版本与备份清单中记录的一致
    #[test]
    fn test_restore_schema_version_matches_backup_metadata() {
        let (manager, _backup_dir, app_data_dir) = setup_test_env();

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        // 创建包含 schema 版本记录的 VFS 数据库
        let vfs_db_path = db_dir.join("vfs.db");
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO test_table (name) VALUES ('versioned_data');
             CREATE TABLE refinery_schema_history (
                 version INTEGER PRIMARY KEY,
                 name TEXT,
                 applied_on TEXT,
                 checksum TEXT
             );
             INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (20260130, 'init', '2026-01-30T00:00:00Z', 'abc123');
             INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (20260201, 'add_indexes', '2026-02-01T00:00:00Z', 'def456');
             INSERT INTO refinery_schema_history (version, name, applied_on, checksum)
             VALUES (20260207, 'add_sync_support', '2026-02-07T00:00:00Z', 'ghi789');",
        )
        .unwrap();
        drop(conn);

        // 执行备份
        let manifest = manager.backup_full().unwrap();

        // 验证 manifest 中正确记录了 schema 版本
        let recorded_version = manifest.schema_versions.get("vfs");
        assert_eq!(
            recorded_version,
            Some(&20260207),
            "Manifest should record the latest schema version (MAX of refinery_schema_history)"
        );

        // 删除原数据库
        fs::remove_file(&vfs_db_path).unwrap();
        let _ = fs::remove_file(vfs_db_path.with_extension("db-wal"));
        let _ = fs::remove_file(vfs_db_path.with_extension("db-shm"));

        // 恢复
        manager.restore(&manifest).unwrap();

        // 验证恢复后的 schema 版本与备份清单一致
        let conn = Connection::open(&vfs_db_path).unwrap();

        let restored_version: i32 = conn
            .query_row(
                "SELECT MAX(version) FROM refinery_schema_history",
                [],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(
            restored_version as u32,
            *recorded_version.unwrap(),
            "Restored schema version should match backup metadata"
        );

        // 验证所有历史记录都完整保留
        let history_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM refinery_schema_history", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(
            history_count, 3,
            "All 3 schema history records should be preserved after restore"
        );

        // 验证数据也一并恢复
        let data: String = conn
            .query_row("SELECT name FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            data, "versioned_data",
            "User data should be restored alongside schema history"
        );
    }

    /// 测试 6: pre_restore 备份创建和回滚机制
    ///
    /// Phase 1: 创建 v1 数据 → 备份
    /// Phase 2: 修改为 v2 数据
    /// Phase 3: 恢复 v1 备份
    /// Phase 4: 验证 pre_restore 备份包含 v2 数据
    /// Phase 5: 通过 rollback 恢复 v2 数据 → 验证回滚成功
    #[test]
    fn test_pre_restore_backup_and_rollback_mechanism() {
        let (manager, backup_dir, app_data_dir) = setup_test_env();

        let active_dir = app_data_dir.path().join("slots").join("slotA");
        let db_dir = active_dir.join("databases");
        fs::create_dir_all(&db_dir).unwrap();

        // Phase 1: 创建 v1 数据并备份
        let vfs_db_path = db_dir.join("vfs.db");
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute_batch(
            "CREATE TABLE test_table (id INTEGER PRIMARY KEY, name TEXT);
             INSERT INTO test_table (name) VALUES ('v1_alpha');
             INSERT INTO test_table (name) VALUES ('v1_beta');",
        )
        .unwrap();
        drop(conn);

        let v1_manifest = manager.backup_full().unwrap();

        // Phase 2: 修改为 v2 数据
        let conn = Connection::open(&vfs_db_path).unwrap();
        conn.execute(
            "UPDATE test_table SET name = 'v2_alpha' WHERE name = 'v1_alpha'",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO test_table (name) VALUES ('v2_gamma')", [])
            .unwrap();
        conn.execute("DELETE FROM test_table WHERE name = 'v1_beta'", [])
            .unwrap();
        // v2 状态: ['v2_alpha', 'v2_gamma']
        let v2_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(v2_count, 2, "Precondition: v2 should have 2 rows");
        drop(conn);

        // Phase 3: 恢复到 v1
        manager.restore(&v1_manifest).unwrap();

        // Phase 4: 验证 pre_restore 备份已创建且包含 v2 数据
        let pre_restore_dir = backup_dir.path().join(PRE_RESTORE_DIR);
        assert!(
            pre_restore_dir.exists(),
            "Pre-restore backup directory should be created during restore"
        );

        let pre_restore_vfs = pre_restore_dir.join("vfs.db");
        assert!(
            pre_restore_vfs.exists(),
            "Pre-restore VFS backup should exist"
        );

        // 验证 pre_restore 备份的内容是 v2 数据（恢复前的状态）
        let pre_conn = Connection::open(&pre_restore_vfs).unwrap();
        let pre_count: i32 = pre_conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            pre_count, 2,
            "Pre-restore backup should contain 2 rows (v2 state)"
        );

        let has_v2_alpha: bool = pre_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'v2_alpha')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_v2_alpha, "Pre-restore backup should contain v2_alpha");
        let has_v2_gamma: bool = pre_conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'v2_gamma')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_v2_gamma, "Pre-restore backup should contain v2_gamma");
        drop(pre_conn);

        // 验证主数据库已恢复到 v1
        let conn = Connection::open(&vfs_db_path).unwrap();
        let restored_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            restored_count, 2,
            "Main database should have 2 rows (v1 state)"
        );
        let has_v1_alpha: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'v1_alpha')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_v1_alpha, "Main database should contain v1_alpha");
        drop(conn);

        // Phase 5: 测试回滚 — 从 pre_restore 备份恢复 v2 数据
        manager.rollback_from_pre_restore(&pre_restore_dir).unwrap();

        // 验证回滚后数据库恢复到 v2 状态
        let conn = Connection::open(&vfs_db_path).unwrap();
        let after_rollback_count: i32 = conn
            .query_row("SELECT COUNT(*) FROM test_table", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            after_rollback_count, 2,
            "After rollback, should have 2 rows (v2 state)"
        );

        let has_v2_after: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'v2_alpha')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(has_v2_after, "After rollback, v2_alpha should be restored");

        let has_v1_after: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM test_table WHERE name = 'v1_alpha')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !has_v1_after,
            "After rollback, v1_alpha should NOT exist (v2 state has v2_alpha)"
        );

        // 完整性检查
        let integrity: String = conn
            .query_row("PRAGMA integrity_check", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            integrity, "ok",
            "Database should pass integrity check after rollback"
        );
    }
}
