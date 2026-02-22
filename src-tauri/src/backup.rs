//! # 备份系统核心模块
//!
//! 提供 Deep Student 应用的数据备份与恢复功能。
//!
//! ## 架构概览
//!
//! ```text
//! ┌─────────────────────────────────────────────────────────────────────┐
//! │                         备份系统架构                                  │
//! ├─────────────────────────────────────────────────────────────────────┤
//! │                                                                     │
//! │  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐       │
//! │  │   DataSource  │───▶│  BackupPlan   │───▶│  ZIP Archive  │       │
//! │  │   (数据源枚举)  │    │   (扫描规划)    │    │  (压缩打包)    │       │
//! │  └───────────────┘    └───────────────┘    └───────────────┘       │
//! │         │                     │                    │               │
//! │         ▼                     ▼                    ▼               │
//! │  ┌───────────────┐    ┌───────────────┐    ┌───────────────┐       │
//! │  │ P0/P1/P2 优先级│    │  file_hashes  │    │  metadata.json│       │
//! │  │ (备份策略)     │    │  (SHA256校验)  │    │  manifest.json│       │
//! │  └───────────────┘    └───────────────┘    └───────────────┘       │
//! │                                                                     │
//! └─────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! ## 核心数据源
//!
//! | 优先级 | 数据源           | 路径                    | 说明                    |
//! |--------|------------------|-------------------------|-------------------------|
//! | P0     | MistakesDb       | mistakes.db             | 核心主数据库（错题记录） |
//! | P0     | ChatV2Db         | databases/chat_v2.db    | 对话历史                |
//! | P0     | NotesDb          | notes.db                | 笔记数据                |
//! | P0     | Images           | images/                 | 用户上传图片            |
//! | P0     | Documents        | documents/              | 用户文档                |
//! | P1     | VfsDb            | vfs.db                  | 虚拟文件系统            |
//! | P2     | Lance*           | lance/                  | 向量数据库（可重建）    |
//!
//! ## 安全特性
//!
//! - **ZIP 炸弹防护**: 限制解压大小、压缩比、文件数量
//! - **ZipSlip 防护**: 路径遍历攻击防护
//! - **符号链接防护**: 跳过符号链接防止目录遍历
//! - **SHA256 校验**: 每个文件的完整性验证
//! - **磁盘空间检查**: 操作前检查可用空间
//!
//! ## 主要入口函数
//!
//! - [`export_backup`]: 手动导出备份到指定目录
//! - [`import_backup`]: 从 ZIP 文件恢复数据
//! - [`run_scheduled_backup`]: 定时自动备份
//! - [`perform_pre_restore_backup`]: 恢复前自动创建安全备份
//!
//! ## 相关模块
//!
//! - [`backup_common`]: 共享工具函数（哈希、安全检查）
//! - [`data_space`]: 数据空间管理（Slot A/B 双空间）

use crate::backup_common::{
    calculate_file_hash, check_disk_space, check_zip_security, copy_directory_safe, is_symlink,
    BACKUP_GLOBAL_LIMITER, RESILIENT_RETRY_COUNT, RESILIENT_RETRY_DELAY_MS,
};
use crate::backup_job_manager::{
    BackupJobContext, BackupJobKind, BackupJobManagerState, BackupJobPhase, BackupJobResultPayload,
};
use crate::data_space::{get_data_space_manager, Slot}; // 用于 slot_override 测试模式
use crate::database::{Database, DatabaseManager};
use crate::file_manager::FileManager;
use chrono::Utc;
use rusqlite::OpenFlags;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State, Window};
use tracing::{debug, error, info, warn};
use walkdir::WalkDir;
use zip::write::FileOptions;

use crate::commands::AppState;
type Result<T> = std::result::Result<T, AppError>;
use crate::models::AppError;
use crate::unified_file_manager::{self, MaterializedPath};

const BACKUPS_DIR_NAME: &str = "backups";
const METADATA_FILE: &str = "backup_metadata.json";
const TEMP_RESTORE_DIR: &str = "temp_restore";
const MIGRATION_CORE_BACKUPS_DIR: &str = "migration_core_backups";
const TEMP_REMOTE_UPLOAD_DIR: &str = "temp_remote_uploads";
const MAX_PARALLEL_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// 维护模式默认超时时间（30分钟）
const MAINTENANCE_MODE_TIMEOUT_SECS: u64 = 30 * 60;

/// Log WalkDir errors instead of silently discarding them.
fn log_and_skip_walkdir_err(
    result: std::result::Result<walkdir::DirEntry, walkdir::Error>,
) -> Option<walkdir::DirEntry> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[Backup] WalkDir entry error (skipped): {}", e);
            None
        }
    }
}

// ============================================================================
// P0 安全修复: 维护模式 RAII Guard with 超时机制
// ============================================================================

/// 维护模式守卫：自动管理维护模式的进入和退出
///
/// 功能：
/// - 进入维护模式时记录时间戳
/// - Drop 时自动退出维护模式
/// - 提供超时检测方法
///
/// 使用示例：
/// ```rust
/// let guard = MaintenanceGuard::enter(database.clone());
/// // 执行备份操作...
/// // guard 超出作用域时自动退出维护模式
/// ```
struct MaintenanceGuard {
    database: Arc<Database>,
    entered: bool,
    entered_at: Instant,
    timeout_secs: u64,
}

impl MaintenanceGuard {
    /// 进入维护模式
    fn enter(database: Arc<Database>) -> Result<Self> {
        Self::enter_with_timeout(database, MAINTENANCE_MODE_TIMEOUT_SECS)
    }

    /// 进入维护模式（带自定义超时）
    fn enter_with_timeout(database: Arc<Database>, timeout_secs: u64) -> Result<Self> {
        database
            .enter_maintenance_mode()
            .map_err(|err| AppError::operation_failed(format!("进入维护模式失败: {}", err)))?;

        info!("[MaintenanceGuard] 已进入维护模式");

        Ok(Self {
            database,
            entered: true,
            entered_at: Instant::now(),
            timeout_secs,
        })
    }

    /// 检查是否已进入维护模式
    fn is_entered(&self) -> bool {
        self.entered
    }

    /// 检查是否已超时
    fn is_timed_out(&self) -> bool {
        self.entered_at.elapsed().as_secs() > self.timeout_secs
    }

    /// 获取已经过的时间（秒）
    fn elapsed_secs(&self) -> u64 {
        self.entered_at.elapsed().as_secs()
    }

    /// 手动退出维护模式（通常不需要调用，Drop 会自动处理）
    fn exit(&mut self) {
        if self.entered {
            if let Err(err) = self.database.exit_maintenance_mode() {
                warn!("[MaintenanceGuard] 退出维护模式失败: {}", err);
            } else {
                info!(
                    "[MaintenanceGuard] 已退出维护模式（持续 {} 秒）",
                    self.elapsed_secs()
                );
            }
            self.entered = false;
        }
    }
}

impl Drop for MaintenanceGuard {
    fn drop(&mut self) {
        if self.entered {
            let elapsed = self.elapsed_secs();
            if elapsed > self.timeout_secs {
                warn!(
                    "[MaintenanceGuard] 维护模式超时！（已持续 {} 秒，限制 {} 秒）",
                    elapsed, self.timeout_secs
                );
            }
            if let Err(err) = self.database.exit_maintenance_mode() {
                error!("[MaintenanceGuard] Drop 时退出维护模式失败: {}", err);
            } else {
                info!(
                    "[MaintenanceGuard] Drop 时已退出维护模式（持续 {} 秒）",
                    elapsed
                );
            }
        }
    }
}

// ============================================================================
// P0 修复: 明确跳过目录规则（Section 1.5）
// ============================================================================
//
// 【导出时永久跳过】（不论选项如何）:
//   - backups/          → 备份目录本身，避免嵌套备份
//   - temp_restore/     → 恢复临时目录
//   - 符号链接          → 安全防护，防止符号链接跟随攻击
//
// 【导出时可选跳过】（根据 ExportOptions）:
//   - logs/             → 日志目录（include_logs=false 时跳过）
//   - temp/, tmp/, temp_files/, .cache/, cache/, caches/
//                       → 临时/缓存目录（include_temp=false 时跳过）
//
// 【恢复时永久跳过】:
//   - backups/          → 备份目录
//   - temp_restore/     → 恢复临时目录
//   - 符号链接          → 安全防护
//   - irec_cozo*, cozo_db*, .cozo*, irec_neo4j*
//                       → 不兼容的旧数据库格式
//
// 【设计依据】:
//   1. 安全性: 符号链接可能导致目录遍历攻击
//   2. 一致性: 备份不应包含自身
//   3. 兼容性: 旧数据库格式无法在新版本中使用
//   4. 效率: 临时文件和日志无需备份
// ============================================================================

/// 导出时临时/缓存目录跳过列表
/// 这些目录包含临时文件、缓存或构建产物，无需备份
const TEMP_SKIP_DIRS: &[&str] = &[
    // 临时目录
    "temp",
    "tmp",
    "temp_restore",
    "temp_files",
    // 缓存目录
    ".cache",
    "cache",
    "caches",
    // 版本控制（用户不太可能在应用数据目录下有这些，但安全起见）
    ".git",
    ".svn",
    ".hg",
    // 构建产物
    "node_modules",
    "target",
    "__pycache__",
    ".tox",
    "dist",
    "build",
];

/// 敏感文件模式 - 这些文件不应该被备份
/// 包含 API 密钥、凭据等敏感信息
///
/// P1 安全修复: 扩展敏感文件检测模式（批判性审查后补充）
const SENSITIVE_FILE_PATTERNS: &[&str] = &[
    // 环境变量文件
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".env.test",
    ".env.staging",
    // 凭据文件
    "credentials.json",
    "secrets.json",
    "service-account.json",
    "service_account.json",
    // 包管理器凭据
    ".npmrc",  // 可能包含 npm token
    ".pypirc", // 可能包含 PyPI token
    ".yarnrc", // 可能包含 yarn token
    // 网络凭据
    ".netrc",    // 网络认证凭据
    ".htpasswd", // HTTP 基本认证
    // 通用令牌文件
    "token",
    "token.json",
    "auth.json",
    "api_key",
    "api_key.txt",
    "apikey.txt",
    // 批判性审查后补充的模式
    ".dockercfg",       // Docker registry 凭据 (旧格式)
    "id_rsa",           // SSH RSA 私钥
    "id_ed25519",       // SSH Ed25519 私钥
    "id_ecdsa",         // SSH ECDSA 私钥
    "id_dsa",           // SSH DSA 私钥 (已废弃但仍可能存在)
    ".git-credentials", // Git 凭据存储
    "kubeconfig",       // Kubernetes 配置
    ".vault-token",     // HashiCorp Vault token
    "jwt.txt",          // JWT token 文件
    "access_token",     // 通用访问令牌
    "refresh_token",    // 刷新令牌
];

/// 敏感文件扩展名 - 这些扩展名的文件可能包含私钥或证书
const SENSITIVE_FILE_EXTENSIONS: &[&str] = &[
    ".pem",      // PEM 格式私钥/证书
    ".key",      // 私钥文件
    ".p12",      // PKCS#12 证书存储
    ".pfx",      // Windows 证书存储
    ".jks",      // Java KeyStore
    ".keystore", // 通用密钥存储
    ".ppk",      // PuTTY 私钥格式
];

/// 敏感目录模式 - 这些目录中的文件不应该被备份
const SENSITIVE_DIR_PATTERNS: &[&str] = &[
    ".ssh",    // SSH 密钥目录
    ".aws",    // AWS 凭据目录
    ".azure",  // Azure 凭据目录
    ".gcloud", // Google Cloud 凭据目录
    ".kube",   // Kubernetes 配置目录
    ".docker", // Docker 配置目录
    ".gnupg",  // GPG 密钥目录
    ".vault",  // HashiCorp Vault 目录
];

/// 恢复时不兼容数据格式跳过列表
/// 这些是旧版本的数据库格式，无法在新版本中使用
const INCOMPATIBLE_DATA_PATTERNS: &[&str] = &["irec_cozo", "cozo_db", ".cozo", "irec_neo4j"];

/// 系统文件模式 - 跨平台兼容性问题
const SYSTEM_FILE_PATTERNS: &[&str] = &[
    ".DS_Store",       // macOS
    "Thumbs.db",       // Windows
    "desktop.ini",     // Windows
    ".Spotlight-V100", // macOS Spotlight
    ".Trashes",        // macOS
];

// ============================================================================
// P0 修复: 数据源枚举器（Section 2.1）
// ============================================================================

/// 中央数据源枚举：定义所有需要备份的数据源类型
/// 备份流程使用此枚举来判断哪些数据源需要扫描
///
/// # mistakes.db 概念说明
///
/// `mistakes.db` 是本应用的**核心主数据库**（Core Primary Database）。
/// 名称源自应用最初的错题记录功能，现已演进为综合学习数据存储库。
///
/// ## 存储内容
/// - 错题记录（原始功能，mistakes 表）
/// - 学习进度与统计
/// - RAG 文档块索引（FTS5 全文搜索）
/// - 用户数据元信息
///
/// ## 路径位置
/// - macOS/Linux: `~/Library/Application Support/deep-student/slots/slotA/mistakes.db`
/// - Windows: `%APPDATA%\deep-student\slots\slotA\mistakes.db`
///
/// ## 关联文件
/// - `mistakes.db-wal`: WAL 日志（Write-Ahead Log）
/// - `mistakes.db-shm`: 共享内存文件
///
/// ## 备份优先级: P0（必须完整备份）
///
/// 注意：虽然名称为 "mistakes"，但这是历史遗留命名，实际上包含所有核心用户数据。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DataSource {
    // ========================================================================
    // SQLite 数据库（核心数据，不可重建）
    // ========================================================================
    /// 核心主数据库 - 历史名称 "mistakes.db"
    /// 存储错题记录、RAG 文档块、学习统计等核心用户数据
    /// 备份优先级: P0（必须）
    MistakesDb,

    /// 对话历史数据库 - databases/chat_v2.db
    /// 存储 AI 对话记录、上下文、变体分支
    /// 备份优先级: P0（必须）
    ChatV2Db,

    /// 笔记数据库 - notes.db
    /// 存储用户笔记、标注、摘要
    /// 备份优先级: P0（必须）
    NotesDb,

    /// 虚拟文件系统数据库 - databases/vfs.db
    /// 存储文件元数据、目录结构、标签
    /// 备份优先级: P0（必须）
    VfsDb,

    /// 研究资料数据库 - research.db
    /// 存储研究项目、文献引用
    /// 备份优先级: P1（重要）
    ResearchDb,

    /// AI 模板数据库 - template_ai.db
    /// 存储自定义 AI 提示模板
    /// 备份优先级: P1（重要）
    TemplateAiDb,

    /// 作文评分数据库 - essay_grading.db
    /// 存储作文批改记录、评分历史
    /// 备份优先级: P1（重要）
    EssayGradingDb,

    /// 画板数据库 - canvas_boards.db
    /// 存储画板/白板内容
    /// 备份优先级: P1（重要）
    CanvasBoardsDb,

    /// 教材数据库 - databases/textbooks.db
    /// 存储教材元数据、章节索引
    /// 备份优先级: P1（重要）
    TextbooksDb,

    /// 消息队列数据库 - message_queue.db
    /// 存储离线消息、任务队列
    /// 备份优先级: P2（可选，可重建）
    MessageQueueDb,

    /// 资源管理数据库 - resources.db
    /// 存储资源索引、缓存元数据
    /// 备份优先级: P2（可选）
    ResourcesDb,

    /// Anki 卡片数据库 - anki.db
    /// 存储闪卡复习数据、间隔重复状态
    /// 备份优先级: P0（必须）
    AnkiDb,

    /// 主数据库 - databases/main.db
    /// 通用主数据库（如有使用）
    /// 备份优先级: P1（重要）
    MainDb,

    // ========================================================================
    // Lance 向量数据库（可重建但耗时）
    // ========================================================================
    /// VFS 向量索引 - lance/vfs/
    /// 备份优先级: P2（可重建，但建议备份）
    LanceVfs,

    /// RAG 向量 - lance/rag/
    /// 备份优先级: P2（可重建，但建议备份）
    LanceRag,

    /// 笔记向量 - lance/notes/
    /// 备份优先级: P2（可重建，但建议备份）
    LanceNotes,

    /// 用户记忆向量 - lance/memory/
    /// 备份优先级: P2（可重建，但建议备份）
    LanceMemory,

    // ========================================================================
    // 资产文件（用户上传，不可重建）
    // ========================================================================
    /// VFS 二进制资源 - vfs_blobs/
    /// 存储 VFS 系统的二进制文件（附件、预览等）
    /// 备份优先级: P0（必须）
    VfsBlobs,

    /// 用户上传图片 - images/
    /// 备份优先级: P0（必须）
    Images,

    /// 笔记资源目录 - notes_assets/
    /// 存储笔记中的图片、附件等资源文件
    /// 备份优先级: P0（必须）
    NotesAssets,

    /// 用户文档 - documents/
    /// 备份优先级: P0（必须）
    Documents,

    /// 学科资料目录 - subjects/
    /// 包含各学科的知识库、教材资源
    /// 备份优先级: P0（必须）
    Subjects,

    /// 音频文件 - audio/
    /// 备份优先级: P1（重要）
    Audio,

    /// 视频文件 - videos/
    /// 备份优先级: P1（重要）
    Videos,

    /// 工作区目录 - workspaces/
    /// 存储 AI 工作区数据（代码、文件等）
    /// 备份优先级: P0（必须）
    Workspaces,

    // ========================================================================
    // 配置文件
    // ========================================================================
    /// 用户设置 - settings.json 等
    /// 备份优先级: P1（重要）
    Settings,
}

// ============================================================================
// 备份分级（Tiered Backup）
// ============================================================================
//
// 2026-02 更新：
// - CoreConfigChat: 配置 + chat_v2.db + llm_usage.db
// - VfsFull: vfs.db + notes.db + anki.db + vfs_blobs/documents/workspaces
// - Rebuildable: lance/ + message_queue.db
// - LargeFiles: images/notes_assets/audio/videos/subjects

/// 备份层级 - 用于分级选择备份范围（旧版自动备份系统）
///
/// 此枚举用于 BackupSettingsSection 组件的自动备份配置。
/// 注意：数据治理系统（DataGovernanceDashboard）使用不同的层级定义，
/// 参见 `src-tauri/src/data_governance/backup/mod.rs`。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackupTier {
    /// 核心配置 + 聊天记录 + LLM 使用统计
    /// 包含: settings.json, config.json, chat_v2.db, llm_usage.db
    CoreConfigChat,
    /// 全量 VFS 内容 + 笔记/Anki 数据库
    /// 包含: vfs.db, notes.db, anki.db, vfs_blobs/, documents/, workspaces/
    VfsFull,
    /// 可重建数据（Lance 向量库 + 消息队列）
    /// 包含: lance/, message_queue.db
    Rebuildable,
    /// 大文件资产（图片/音视频/附件等）
    /// 包含: images/, notes_assets/, audio/, videos/, subjects/
    LargeFiles,
}

impl DataSource {
    /// 获取数据源对应的相对路径模式
    pub fn relative_path_pattern(&self) -> &'static str {
        match self {
            DataSource::MistakesDb => "mistakes.db",
            DataSource::ChatV2Db => "databases/chat_v2.db",
            DataSource::NotesDb => "notes.db", // 或 databases/notes.db
            DataSource::VfsDb => "databases/vfs.db",
            DataSource::ResearchDb => "research.db",
            DataSource::TemplateAiDb => "template_ai.db",
            DataSource::EssayGradingDb => "essay_grading.db",
            DataSource::CanvasBoardsDb => "canvas_boards.db",
            DataSource::TextbooksDb => "databases/textbooks.db",
            DataSource::MessageQueueDb => "message_queue.db",
            DataSource::ResourcesDb => "resources.db",
            DataSource::AnkiDb => "anki.db",
            DataSource::MainDb => "databases/main.db",
            DataSource::LanceVfs => "lance/vfs/",
            DataSource::LanceRag => "lance/rag/",
            DataSource::LanceNotes => "lance/notes/",
            DataSource::LanceMemory => "lance/memory/",
            DataSource::VfsBlobs => "vfs_blobs/",
            DataSource::Images => "images/",
            DataSource::NotesAssets => "notes_assets/",
            DataSource::Documents => "documents/",
            DataSource::Subjects => "subjects/",
            DataSource::Audio => "audio/",
            DataSource::Videos => "videos/",
            DataSource::Workspaces => "workspaces/",
            DataSource::Settings => "settings.json",
        }
    }

    /// 判断数据源是否可重建
    pub fn is_rebuildable(&self) -> bool {
        matches!(
            self,
            DataSource::LanceVfs
                | DataSource::LanceRag
                | DataSource::LanceNotes
                | DataSource::LanceMemory
        )
    }

    /// 获取数据源的备份优先级
    /// - P0: 必须备份，不可丢失
    /// - P1: 重要数据，应该备份
    /// - P2: 可选数据，可重建或丢失影响较小
    ///
    /// 2026-02 更新：
    /// - 废弃数据库仍保留在此枚举中用于兼容，但在分层备份规则中已移除
    /// - 活跃数据库：chat_v2, vfs, notes, anki, llm_usage, message_queue
    /// - 废弃数据库：mistakes, research, template_ai, essay_grading, canvas_boards, textbooks, resources, main
    pub fn priority(&self) -> u8 {
        match self {
            // P0: 核心用户数据（不可重建，必须备份）
            DataSource::MistakesDb => 0, // 注意：已废弃，但保留 P0 用于迁移兼容
            DataSource::ChatV2Db => 0,
            DataSource::NotesDb => 0,
            DataSource::VfsDb => 0,
            DataSource::AnkiDb => 0,
            DataSource::VfsBlobs => 0,
            DataSource::Images => 0,
            DataSource::NotesAssets => 0,
            DataSource::Documents => 0,
            DataSource::Subjects => 0,
            DataSource::Workspaces => 0,

            // P1: 重要但可恢复（部分已废弃）
            DataSource::ResearchDb => 1,     // 废弃：可能已废弃
            DataSource::TemplateAiDb => 1,   // 废弃：无实际使用代码
            DataSource::EssayGradingDb => 1, // 废弃：迁移到 VFS
            DataSource::CanvasBoardsDb => 1, // 废弃：白板模块已移除
            DataSource::TextbooksDb => 1,    // 废弃：迁移到 VFS
            DataSource::MainDb => 1,         // 废弃：迁移到 VFS
            DataSource::Audio => 1,
            DataSource::Videos => 1,
            DataSource::Settings => 1,

            // P2: 可重建
            DataSource::MessageQueueDb => 2,
            DataSource::ResourcesDb => 2, // 废弃：被 VFS 替代
            DataSource::LanceVfs => 2,
            DataSource::LanceRag => 2,
            DataSource::LanceNotes => 2,
            DataSource::LanceMemory => 2,
        }
    }

    /// 获取所有 P0 级别的数据源
    pub fn p0_sources() -> &'static [DataSource] {
        &[
            DataSource::MistakesDb,
            DataSource::ChatV2Db,
            DataSource::NotesDb,
            DataSource::VfsDb,
            DataSource::AnkiDb,
            DataSource::VfsBlobs,
            DataSource::Images,
            DataSource::NotesAssets,
            DataSource::Documents,
            DataSource::Subjects,
            DataSource::Workspaces,
        ]
    }

    /// 检查路径是否匹配此数据源
    pub fn matches_path(&self, rel_path: &str) -> bool {
        let pattern = self.relative_path_pattern();
        let rel_lower = rel_path.to_lowercase();

        if pattern.contains('*') {
            // 通配符模式
            let parts: Vec<&str> = pattern.split('*').collect();
            if parts.len() == 2 {
                rel_lower.starts_with(parts[0]) && rel_lower.ends_with(parts[1])
            } else {
                rel_lower.contains(&pattern.replace("*", ""))
            }
        } else if pattern.ends_with('/') {
            // 目录模式
            rel_lower.starts_with(pattern) || rel_lower.starts_with(&pattern[..pattern.len() - 1])
        } else {
            // 精确文件匹配
            rel_lower == pattern || rel_lower.ends_with(&format!("/{}", pattern))
        }
    }

    /// 判断数据源是否为必须备份
    pub fn is_critical(&self) -> bool {
        !self.is_rebuildable()
    }
}

// ============================================================================
// P0 数据源完整性验证
// ============================================================================

/// P0 数据源验证结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct P0VerificationResult {
    /// 验证是否通过
    pub passed: bool,
    /// 存在的 P0 数据源
    pub present: Vec<DataSource>,
    /// 缺失的 P0 数据源（文件不存在，正常情况）
    pub missing: Vec<DataSource>,
    /// 无法访问的 P0 数据源（权限问题等，需要警告）
    pub inaccessible: Vec<(DataSource, String)>,
    /// 警告信息
    pub warnings: Vec<String>,
}

impl P0VerificationResult {
    /// 创建一个通过的结果
    pub fn passed() -> Self {
        Self {
            passed: true,
            present: Vec::new(),
            missing: Vec::new(),
            inaccessible: Vec::new(),
            warnings: Vec::new(),
        }
    }

    /// 添加警告
    pub fn add_warning(&mut self, msg: String) {
        self.warnings.push(msg);
    }
}

/// 验证备份计划中是否包含所有 P0 数据源
///
/// 检查逻辑：
/// 1. 遍历所有 P0 数据源
/// 2. 检查源目录中是否存在对应文件/目录
/// 3. 如果存在，检查是否在备份计划中
/// 4. 报告缺失和无法访问的数据源
pub fn verify_p0_data_sources(source_root: &Path, backup_files: &[String]) -> P0VerificationResult {
    let mut result = P0VerificationResult::passed();

    for source in DataSource::p0_sources() {
        let pattern = source.relative_path_pattern();
        let source_path = source_root.join(pattern.trim_end_matches('/'));

        // 检查源文件/目录是否存在
        if pattern.contains('*') {
            // 通配符模式 - 检查是否有匹配的文件
            let has_match = backup_files.iter().any(|f| source.matches_path(f));
            if has_match {
                result.present.push(*source);
            } else {
                // 检查父目录是否存在
                let parent_pattern = pattern.split('*').next().unwrap_or("");
                let parent_path = source_root.join(parent_pattern.trim_end_matches('/'));
                if parent_path.exists() {
                    // 父目录存在但没有匹配文件 - 可能是正常情况（用户还没有创建相关数据）
                    result.missing.push(*source);
                }
            }
        } else if pattern.ends_with('/') {
            // 目录模式
            if source_path.exists() {
                if source_path.is_dir() {
                    // 检查备份计划中是否包含此目录的文件
                    let has_files = backup_files.iter().any(|f| source.matches_path(f));
                    if has_files {
                        result.present.push(*source);
                    } else {
                        // 目录存在但为空或被跳过
                        match std::fs::read_dir(&source_path) {
                            Ok(mut entries) => {
                                if entries.next().is_none() {
                                    // 空目录 - 正常
                                    result.missing.push(*source);
                                } else {
                                    // 目录有内容但未备份 - 警告
                                    result.add_warning(format!(
                                        "P0 目录 {} 存在但未包含在备份中",
                                        pattern
                                    ));
                                    result
                                        .inaccessible
                                        .push((*source, "目录内容未包含在备份中".to_string()));
                                }
                            }
                            Err(e) => {
                                result
                                    .inaccessible
                                    .push((*source, format!("无法读取目录: {}", e)));
                            }
                        }
                    }
                } else {
                    result
                        .inaccessible
                        .push((*source, "路径存在但不是目录".to_string()));
                }
            } else {
                result.missing.push(*source);
            }
        } else {
            // 文件模式
            if source_path.exists() {
                // 检查是否在备份计划中
                let in_backup = backup_files.iter().any(|f| source.matches_path(f));
                if in_backup {
                    result.present.push(*source);
                } else {
                    // 文件存在但未备份 - 严重警告
                    result.add_warning(format!("⚠️ P0 文件 {} 存在但未包含在备份中！", pattern));
                    result
                        .inaccessible
                        .push((*source, "文件存在但未包含在备份中".to_string()));
                }
            } else {
                result.missing.push(*source);
            }
        }
    }

    // 如果有无法访问的 P0 数据源，验证失败
    result.passed = result.inaccessible.is_empty();

    // 记录验证结果
    if !result.passed {
        error!(
            "[Backup] P0 数据源验证失败: {} 个无法访问",
            result.inaccessible.len()
        );
        for (source, reason) in &result.inaccessible {
            error!("[Backup]   - {:?}: {}", source, reason);
        }
    } else {
        info!(
            "[Backup] P0 数据源验证通过: {} 个存在, {} 个缺失（正常）",
            result.present.len(),
            result.missing.len()
        );
    }

    result
}

/// 备份清单（manifest.json）
/// 记录 ZIP 中包含的所有数据源及其详细信息
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    /// 清单格式版本
    pub manifest_version: String,
    /// 创建时间
    pub created_at: String,
    /// 应用版本
    pub app_version: String,
    /// 包含的数据源列表
    pub data_sources: Vec<ManifestDataSource>,
    /// 总文件数
    pub total_files: usize,
    /// 总字节数
    pub total_bytes: u64,
}

/// 清单中的数据源条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManifestDataSource {
    /// 数据源类型
    pub source_type: DataSource,
    /// 在 ZIP 中的相对路径
    pub relative_path: String,
    /// 文件数量
    pub file_count: usize,
    /// 总字节数
    pub total_bytes: u64,
    /// 是否完整包含
    pub is_complete: bool,
    /// 备注
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
}

impl BackupManifest {
    /// 创建新的备份清单
    pub fn new(app_version: &str) -> Self {
        Self {
            manifest_version: "1.0".to_string(),
            created_at: Utc::now().to_rfc3339(),
            app_version: app_version.to_string(),
            data_sources: Vec::new(),
            total_files: 0,
            total_bytes: 0,
        }
    }

    /// 添加数据源条目
    pub fn add_source(&mut self, source: ManifestDataSource) {
        self.total_files += source.file_count;
        self.total_bytes += source.total_bytes;
        self.data_sources.push(source);
    }

    /// 检查是否包含指定数据源
    pub fn contains(&self, source_type: DataSource) -> bool {
        self.data_sources
            .iter()
            .any(|s| s.source_type == source_type)
    }
}

const MANIFEST_FILE: &str = "manifest.json";

#[derive(Default)]
struct ExtractionStats {
    skipped_entries: Vec<String>,
}

impl ExtractionStats {
    fn record_skip(&mut self, entry: String, reason: &str) {
        warn!("[Backup] 忽略条目: {} ({})", entry, reason);
        self.skipped_entries.push(entry);
    }

    fn is_empty(&self) -> bool {
        self.skipped_entries.is_empty()
    }
}

// 全局备份锁位于 backup_common::BACKUP_GLOBAL_LIMITER

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    #[serde(default = "default_include_logs")]
    pub include_logs: bool,
    #[serde(default)]
    pub include_temp: bool,
    #[serde(default = "default_compression_level")]
    pub compression_level: u8,
    #[serde(default)]
    pub parallelism: Option<usize>,
    #[serde(default)]
    pub whitelist_directories: Option<Vec<String>>,
    #[serde(default)]
    pub perform_lance_compaction: bool,
    #[serde(default)]
    pub output_path: Option<String>,
    /// 测试专用：覆盖目标插槽（只允许 slotC/slotD）
    #[serde(default)]
    pub slot_override: Option<String>,
    /// 精简备份模式：仅备份数据库和设置，跳过图片、知识库、音视频等大文件
    /// 适用于快速备份聊天记录和配置
    #[serde(default)]
    pub slim_backup: bool,
    /// 备份分级：按层级选择备份范围（为空则全量备份）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_tiers: Option<Vec<BackupTier>>,
}

fn default_include_logs() -> bool {
    false
}

fn default_compression_level() -> u8 {
    6
}

impl Default for ExportOptions {
    fn default() -> Self {
        // 智能并行度：检测CPU核心数，默认4（兼容低配设备），上限8
        let smart_parallelism = std::thread::available_parallelism()
            .map(|n| n.get().min(8).max(1))
            .unwrap_or(4);
        Self {
            include_logs: default_include_logs(),
            include_temp: false,
            compression_level: default_compression_level(),
            parallelism: Some(smart_parallelism),
            whitelist_directories: None,
            // ✅ 默认启用Lance Compaction：合并碎片、减少备份时间与文件体积
            perform_lance_compaction: true,
            output_path: None,
            slot_override: None,
            slim_backup: false,
            backup_tiers: None,
        }
    }
}

#[derive(Serialize, Debug)]
pub struct BackupJobHandle {
    pub job_id: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    #[serde(default)]
    pub best_effort: bool,
    #[serde(default = "default_true")]
    pub perform_integrity_check: bool,
    /// 导入后执行Lance优化的并行度（None则使用默认值4）
    #[serde(default)]
    pub parallelism: Option<usize>,
    /// 测试专用：覆盖目标插槽（只允许 slotC/slotD）
    #[serde(default)]
    pub slot_override: Option<String>,
}

fn default_true() -> bool {
    true
}

struct BackupExecutionContext {
    file_manager: Arc<FileManager>,
    database: Arc<Database>,
    database_manager: Arc<DatabaseManager>,
    window: Option<Window>,
    /// 测试专用：覆盖根目录（用于测试插槽 C/D）
    root_override: Option<PathBuf>,
    /// Chat V2 数据库引用（用于导入后重新初始化连接）
    chat_v2_db: Option<Arc<crate::chat_v2::ChatV2Database>>,
    /// VFS 数据库引用（用于导入后重新初始化连接）
    vfs_db: Option<Arc<crate::vfs::VfsDatabase>>,
}

impl Clone for BackupExecutionContext {
    fn clone(&self) -> Self {
        Self {
            file_manager: self.file_manager.clone(),
            database: self.database.clone(),
            database_manager: self.database_manager.clone(),
            window: self.window.clone(),
            root_override: self.root_override.clone(),
            chat_v2_db: self.chat_v2_db.clone(),
            vfs_db: self.vfs_db.clone(),
        }
    }
}

impl BackupExecutionContext {
    fn from_state(state: &AppState, window: &Window) -> Self {
        Self {
            file_manager: state.file_manager.clone(),
            database: state.database.clone(),
            database_manager: state.database_manager.clone(),
            window: Some(window.clone()),
            root_override: None,
            chat_v2_db: None,
            vfs_db: None,
        }
    }

    /// 设置 Chat V2 数据库引用（用于导入后重新初始化）
    fn with_chat_v2_db(mut self, db: Option<Arc<crate::chat_v2::ChatV2Database>>) -> Self {
        self.chat_v2_db = db;
        self
    }

    /// 设置 VFS 数据库引用（用于导入后重新初始化）
    fn with_vfs_db(mut self, db: Option<Arc<crate::vfs::VfsDatabase>>) -> Self {
        self.vfs_db = db;
        self
    }

    /// 创建带测试插槽覆盖的上下文
    fn from_state_with_slot_override(
        state: &AppState,
        window: &Window,
        slot_override: Option<String>,
    ) -> Result<Self> {
        let root_override = if let Some(slot_name) = slot_override {
            let slot = Slot::from_name(&slot_name)
                .ok_or_else(|| AppError::validation(format!("无效的插槽名称: {}", slot_name)))?;

            // 安全检查：只允许测试插槽 C/D
            if !slot.is_test_slot() {
                return Err(AppError::validation(
                    "slot_override 只能使用测试插槽 (slotC/slotD)".to_string(),
                ));
            }

            let mgr = get_data_space_manager()
                .ok_or_else(|| AppError::internal("数据空间管理器未初始化".to_string()))?;
            Some(mgr.slot_dir(slot))
        } else {
            None
        };

        Ok(Self {
            file_manager: state.file_manager.clone(),
            database: state.database.clone(),
            database_manager: state.database_manager.clone(),
            window: Some(window.clone()),
            root_override,
            chat_v2_db: None,
            vfs_db: None,
        })
    }

    fn app_data_root(&self) -> PathBuf {
        // 如果有覆盖路径，使用覆盖路径；否则使用默认路径
        self.root_override
            .clone()
            .unwrap_or_else(|| self.file_manager.get_writable_app_data_dir())
    }

    // fn app_handle(&self) -> AppHandle { self.app_handle.clone() }

    fn window(&self) -> Option<Window> {
        self.window.clone()
    }
}

fn normalize_rel_path(rel: &Path) -> String {
    let mut path = rel
        .components()
        .map(|c| c.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/");
    if rel.as_os_str().is_empty() {
        path.clear();
    }
    path
}

fn normalize_dir_path(mut path: String) -> String {
    if !path.is_empty() && !path.ends_with('/') {
        path.push('/');
    }
    path
}

#[derive(Debug, Clone)]
struct BackupPlanEntry {
    absolute: PathBuf,
    relative: String,
    size: u64,
}

#[derive(Debug, Default)]
struct BackupPlan {
    directories: Vec<String>,
    files: Vec<BackupPlanEntry>,
    total_size: u64,
}

impl BackupPlan {
    fn total_files(&self) -> usize {
        self.files.len()
    }
}

fn build_whitelist(options: &ExportOptions) -> Option<Vec<PathBuf>> {
    options.whitelist_directories.as_ref().map(|paths| {
        paths
            .iter()
            .filter_map(|raw| {
                let trimmed = raw.trim();
                if trimmed.is_empty() {
                    None
                } else {
                    Some(PathBuf::from(trimmed))
                }
            })
            .collect::<Vec<_>>()
    })
}

fn dir_allowed_by_whitelist(rel: &Path, whitelist: &[PathBuf]) -> bool {
    if rel.as_os_str().is_empty() {
        return true;
    }
    whitelist
        .iter()
        .any(|allow| allow.starts_with(rel) || rel.starts_with(allow))
}

fn file_allowed_by_whitelist(rel: &Path, whitelist: &[PathBuf]) -> bool {
    whitelist.iter().any(|allow| rel.starts_with(allow))
}

fn should_skip_logs(rel: &Path, options: &ExportOptions) -> bool {
    if options.include_logs {
        return false;
    }
    rel.components().any(|c| c.as_os_str() == "logs")
}

fn should_skip_temp(rel: &Path, options: &ExportOptions) -> bool {
    if options.include_temp {
        return false;
    }
    // 使用统一的跳过目录常量 TEMP_SKIP_DIRS
    rel.components()
        .any(|c| TEMP_SKIP_DIRS.contains(&c.as_os_str().to_string_lossy().as_ref()))
}

/// 检查是否为敏感文件（包含 API 密钥、凭据等）
///
/// P1 安全修复: 扩展敏感文件检测逻辑
/// 检查：
/// 1. 敏感文件名模式 (SENSITIVE_FILE_PATTERNS)
/// 2. 敏感文件扩展名 (SENSITIVE_FILE_EXTENSIONS)
/// 3. 敏感目录 (SENSITIVE_DIR_PATTERNS)
pub(crate) fn should_skip_sensitive_file(rel: &Path) -> bool {
    // 检查是否在敏感目录中
    for component in rel.components() {
        let comp_str = component.as_os_str().to_string_lossy();
        if SENSITIVE_DIR_PATTERNS
            .iter()
            .any(|p| comp_str.eq_ignore_ascii_case(p))
        {
            warn!("[Backup] 跳过敏感目录中的文件（安全防护）: {:?}", rel);
            return true;
        }
    }

    if let Some(file_name) = rel.file_name() {
        let name = file_name.to_string_lossy();

        // 检查敏感文件名模式
        if SENSITIVE_FILE_PATTERNS
            .iter()
            .any(|p| name.eq_ignore_ascii_case(p))
        {
            warn!("[Backup] 跳过敏感文件（安全防护）: {:?}", rel);
            return true;
        }

        // 检查敏感文件扩展名
        let name_lower = name.to_lowercase();
        if SENSITIVE_FILE_EXTENSIONS
            .iter()
            .any(|ext| name_lower.ends_with(ext))
        {
            warn!(
                "[Backup] 跳过可能包含私钥/证书的文件（安全防护）: {:?}",
                rel
            );
            return true;
        }
    }
    false
}

/// 检查是否为系统文件（跨平台兼容性）
pub(crate) fn should_skip_system_file(rel: &Path) -> bool {
    if let Some(file_name) = rel.file_name() {
        let name = file_name.to_string_lossy();
        SYSTEM_FILE_PATTERNS
            .iter()
            .any(|p| name.eq_ignore_ascii_case(p))
    } else {
        false
    }
}

/// 精简备份模式下需要跳过的目录
/// 这些目录包含大文件（图片、文档、音视频、向量库），精简备份时跳过以加快速度
const SLIM_BACKUP_SKIP_DIRS: &[&str] = &[
    "images",       // 用户上传图片
    "notes_assets", // 笔记资源（图片、附件）
    "documents",    // 用户文档
    "audio",        // 音频文件
    "videos",       // 视频文件
    "lance",        // Lance 向量数据库（可重建）
];

// ============================================================================
// 备份分级（Tiered Backup）规则
// ============================================================================
//
// 2026-02 更新：根据数据库使用情况调研结果更新
//
// 活跃数据库：
// - mistakes.db: 主数据库（历史命名），包含 anki_cards、settings 等活跃表（P0）
// - chat_v2.db: Chat V2 核心（P0）
// - vfs.db: VFS 统一存储（P0）
// - notes.db: 笔记系统，正在迁移到 VFS（P0）
// - anki.db: Anki 卡片（P0）
// - message_queue.db: 消息队列（P2）
// - llm_usage.db: LLM 使用统计（P0）
//
// mistakes.db 特别说明：
// - 仍需备份：包含 anki_cards、settings、review_analyses 等活跃表
// - 部分废弃：只有 mistakes 表和 chat_messages 表的错题业务功能已废弃
//
// 已废弃（不再主动备份）：
// - resources.db: 被 VFS 替代
// - research.db, template_ai.db, essay_grading.db, canvas_boards.db: 均已废弃
// - textbooks.db, main.db: 迁移到 VFS

const TIER_CORE_FILES: &[&str] = &[
    // 配置文件
    "settings.json",
    "webview_settings.json",
    "config.json",
    "slots_state.json",
    // 核心数据库
    "databases/chat_v2.db",
    "chat_v2.db",
    // 主数据库（历史命名 mistakes.db，包含 anki_cards、settings 等活跃表）
    "mistakes.db",
    // LLM 使用统计（记录所有 LLM 调用）
    "llm_usage.db",
];
const TIER_CORE_DIRS: &[&str] = &["config"];
const TIER_VFS_FILES: &[&str] = &[
    // VFS 核心数据库
    "databases/vfs.db",
    "vfs.db",
    // 笔记数据库（正在迁移到 VFS，但仍活跃）
    "notes.db",
    // Anki 卡片数据库（独立存储）
    "anki.db",
];
const TIER_VFS_DIRS: &[&str] = &["vfs_blobs", "documents", "workspaces"];
const TIER_REBUILDABLE_FILES: &[&str] = &[
    // 消息队列（可重建）
    "message_queue.db",
    // 注意：resources.db 已废弃，被 VFS 替代
];
const TIER_REBUILDABLE_DIRS: &[&str] = &["lance"];
const TIER_LARGE_DIRS: &[&str] = &["images", "notes_assets", "audio", "videos", "subjects"];

#[derive(Debug, Clone)]
struct TieredBackupRules {
    allowed_files: std::collections::HashSet<String>,
    allowed_dirs: std::collections::HashSet<String>,
}

impl TieredBackupRules {
    fn from_options(options: &ExportOptions) -> Option<Self> {
        let tiers = options
            .backup_tiers
            .as_ref()
            .filter(|list| !list.is_empty())?;

        let mut allowed_files = std::collections::HashSet::new();
        let mut allowed_dirs = std::collections::HashSet::new();

        let mut add_file = |path: &str| {
            let norm = path.trim_matches('/').to_lowercase();
            if !norm.is_empty() {
                allowed_files.insert(norm);
            }
        };

        let mut add_dir = |path: &str| {
            let mut norm = path.trim_matches('/').to_lowercase();
            if norm.ends_with('/') {
                norm.pop();
            }
            if !norm.is_empty() {
                allowed_dirs.insert(norm);
            }
        };

        for tier in tiers {
            match tier {
                BackupTier::CoreConfigChat => {
                    for file in TIER_CORE_FILES {
                        add_file(file);
                    }
                    for dir in TIER_CORE_DIRS {
                        add_dir(dir);
                    }
                }
                BackupTier::VfsFull => {
                    for file in TIER_VFS_FILES {
                        add_file(file);
                    }
                    for dir in TIER_VFS_DIRS {
                        add_dir(dir);
                    }
                }
                BackupTier::Rebuildable => {
                    for file in TIER_REBUILDABLE_FILES {
                        add_file(file);
                    }
                    for dir in TIER_REBUILDABLE_DIRS {
                        add_dir(dir);
                    }
                }
                BackupTier::LargeFiles => {
                    for dir in TIER_LARGE_DIRS {
                        add_dir(dir);
                    }
                }
            }
        }

        Some(Self {
            allowed_files,
            allowed_dirs,
        })
    }

    fn allows_file(&self, rel: &str) -> bool {
        if self.allowed_files.contains(rel) {
            return true;
        }
        for dir in &self.allowed_dirs {
            let prefix = format!("{}/", dir);
            if rel.starts_with(&prefix) {
                return true;
            }
        }
        false
    }

    fn allows_dir(&self, rel: &str) -> bool {
        if rel.is_empty() {
            return true;
        }
        if self.allowed_dirs.contains(rel) {
            return true;
        }
        let rel_prefix = format!("{}/", rel);
        if self
            .allowed_files
            .iter()
            .any(|file| file.starts_with(&rel_prefix))
        {
            return true;
        }
        if self
            .allowed_dirs
            .iter()
            .any(|dir| dir.starts_with(&rel_prefix) || rel.starts_with(&format!("{}/", dir)))
        {
            return true;
        }
        false
    }
}

/// 检查精简备份模式下是否应跳过此路径
fn should_skip_for_slim_backup(rel: &Path, options: &ExportOptions) -> bool {
    if !options.slim_backup {
        return false;
    }

    // 检查路径是否以任何跳过目录开头
    for skip_dir in SLIM_BACKUP_SKIP_DIRS {
        if rel.starts_with(skip_dir) {
            return true;
        }
    }
    false
}

fn should_skip_for_tiered_backup(
    rel: &Path,
    is_dir: bool,
    tier_rules: Option<&TieredBackupRules>,
) -> bool {
    let Some(rules) = tier_rules else {
        return false;
    };
    let rel_norm = normalize_rel_path(rel).to_lowercase();
    if rel_norm.is_empty() {
        return false;
    }
    if is_dir {
        !rules.allows_dir(&rel_norm)
    } else {
        !rules.allows_file(&rel_norm)
    }
}

fn has_backup_tiers(options: &ExportOptions) -> bool {
    options
        .backup_tiers
        .as_ref()
        .map_or(false, |tiers| !tiers.is_empty())
}

fn tiers_include(options: &ExportOptions, tier: BackupTier) -> bool {
    options
        .backup_tiers
        .as_ref()
        .map_or(false, |tiers| tiers.contains(&tier))
}

fn includes_core_config(options: &ExportOptions) -> bool {
    !has_backup_tiers(options) || tiers_include(options, BackupTier::CoreConfigChat)
}

fn includes_rebuildable(options: &ExportOptions) -> bool {
    !has_backup_tiers(options) || tiers_include(options, BackupTier::Rebuildable)
}

fn should_skip_path(
    rel: &Path,
    options: &ExportOptions,
    is_dir: bool,
    tier_rules: Option<&TieredBackupRules>,
) -> bool {
    should_skip_logs(rel, options)
        || should_skip_temp(rel, options)
        || should_skip_sensitive_file(rel)
        || should_skip_system_file(rel)
        || should_skip_for_slim_backup(rel, options)
        || should_skip_for_tiered_backup(rel, is_dir, tier_rules)
}

fn build_backup_plan(
    root: &Path,
    options: &ExportOptions,
    whitelist: Option<&[PathBuf]>,
    job: Option<&BackupJobContext>,
) -> Result<BackupPlan> {
    let mut plan = BackupPlan::default();
    let mut dir_set: std::collections::HashSet<String> = std::collections::HashSet::new();
    let tier_rules = TieredBackupRules::from_options(options);

    let mut walker = WalkDir::new(root).into_iter();
    let mut scanned_entries = 0usize;

    while let Some(entry) = walker.next() {
        if let Some(job_ctx) = job {
            if job_ctx.is_cancelled() {
                return Err(AppError::operation_failed("备份任务已取消"));
            }
        }

        let entry = match entry {
            Ok(e) => e,
            Err(err) => {
                warn!("[Backup] 遍历备份目录失败: {}", err);
                continue;
            }
        };

        let path = entry.path();
        let rel = match path.strip_prefix(root) {
            Ok(rel) => rel,
            Err(_) => continue,
        };

        if rel.as_os_str().is_empty() {
            continue;
        }

        // ====================================================================
        // P0 安全检查: 符号链接防护
        // 跳过符号链接，防止符号链接跟随攻击
        // ====================================================================
        if is_symlink(path) {
            warn!("[Backup] 跳过符号链接 (安全防护): {:?}", path);
            if entry.file_type().is_dir() {
                walker.skip_current_dir();
            }
            continue;
        }

        // 跳过备份目录与临时目录
        if rel.starts_with(BACKUPS_DIR_NAME)
            || rel.starts_with(TEMP_RESTORE_DIR)
            || rel.starts_with(MIGRATION_CORE_BACKUPS_DIR)
        {
            walker.skip_current_dir();
            continue;
        }

        // 目录过滤
        if entry.file_type().is_dir() {
            let normalized = normalize_rel_path(rel);

            if should_skip_path(rel, options, true, tier_rules.as_ref()) {
                debug!("[Backup] 跳过目录(根据选项): {}", normalized);
                walker.skip_current_dir();
                continue;
            }

            if let Some(list) = whitelist {
                if !dir_allowed_by_whitelist(rel, list) {
                    debug!("[Backup] 跳过目录(白名单): {}", normalized);
                    walker.skip_current_dir();
                    continue;
                }
            }

            if !normalized.is_empty() {
                let dir_key = normalize_dir_path(normalized.clone());
                if dir_set.insert(dir_key.clone()) {
                    plan.directories.push(dir_key);
                }
            }
            continue;
        }

        scanned_entries += 1;
        if scanned_entries % 200 == 0 {
            let _ = emit_progress(
                job,
                None,
                ImportProgress {
                    phase: "scan".to_string(),
                    progress: 2.0,
                    message: format!("扫描中文件数: {}", scanned_entries),
                    current_file: None,
                    total_files: 0,
                    processed_files: scanned_entries,
                },
            );
        }

        if is_sqlite_aux_file(
            entry
                .path()
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("")),
        ) {
            continue;
        }

        if should_skip_path(rel, options, false, tier_rules.as_ref()) {
            continue;
        }

        if let Some(list) = whitelist {
            if !file_allowed_by_whitelist(rel, list) {
                continue;
            }
        }

        let normalized = normalize_rel_path(rel);
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(err) => {
                warn!("[Backup] 读取文件元数据失败 {:?}: {}", entry.path(), err);
                continue;
            }
        };

        plan.total_size += metadata.len();
        if let Some(parent) = rel.parent() {
            if !parent.as_os_str().is_empty() {
                let parent_norm = normalize_dir_path(normalize_rel_path(parent));
                if dir_set.insert(parent_norm.clone()) {
                    plan.directories.push(parent_norm);
                }
            }
        }

        plan.files.push(BackupPlanEntry {
            absolute: path.to_path_buf(),
            relative: normalized,
            size: metadata.len(),
        });
    }

    if options.include_logs {
        if let Some(external_logs) = locate_logs_dir(root) {
            // ================================================================
            // 安全修复: 检查外部日志目录本身是否为符号链接
            // ================================================================
            if is_symlink(&external_logs) {
                warn!("[Backup] 跳过符号链接的外部日志目录: {:?}", external_logs);
            } else if !external_logs.starts_with(root) {
                debug!("[Backup] 包含外部日志目录: {:?}", external_logs);
                let mut log_walker = WalkDir::new(&external_logs).into_iter();
                while let Some(entry) = log_walker.next() {
                    let entry = match entry {
                        Ok(e) => e,
                        Err(err) => {
                            warn!("[Backup] 遍历日志目录失败: {}", err);
                            continue;
                        }
                    };
                    // 安全修复: 跳过符号链接文件
                    if is_symlink(entry.path()) {
                        warn!("[Backup] 跳过符号链接: {:?}", entry.path());
                        continue;
                    }
                    let relative_in_logs = match entry.path().strip_prefix(&external_logs) {
                        Ok(rel) => rel,
                        Err(_) => continue,
                    };
                    let mut rel_zip = PathBuf::from("logs");
                    if !relative_in_logs.as_os_str().is_empty() {
                        rel_zip.push(relative_in_logs);
                    }
                    if entry.file_type().is_dir() {
                        let normalized = normalize_dir_path(normalize_rel_path(&rel_zip));
                        if !normalized.is_empty() && dir_set.insert(normalized.clone()) {
                            plan.directories.push(normalized);
                        }
                    } else {
                        let metadata = match entry.metadata() {
                            Ok(m) => m,
                            Err(err) => {
                                warn!(
                                    "[Backup] 读取日志文件元数据失败 {:?}: {}",
                                    entry.path(),
                                    err
                                );
                                continue;
                            }
                        };
                        plan.total_size += metadata.len();
                        if let Some(parent) = rel_zip.parent() {
                            if !parent.as_os_str().is_empty() {
                                let parent_norm = normalize_dir_path(normalize_rel_path(parent));
                                if dir_set.insert(parent_norm.clone()) {
                                    plan.directories.push(parent_norm);
                                }
                            }
                        }

                        plan.files.push(BackupPlanEntry {
                            absolute: entry.path().to_path_buf(),
                            relative: normalize_rel_path(&rel_zip),
                            size: metadata.len(),
                        });
                    }
                }
            }
        }
    }

    plan.files.sort_by(|a, b| a.relative.cmp(&b.relative));

    plan.directories.sort();
    plan.directories.dedup();

    let _ = emit_progress(
        job,
        None,
        ImportProgress {
            phase: "scan".to_string(),
            progress: 8.0,
            message: format!("扫描完成，共计 {} 个文件", plan.total_files()),
            current_file: None,
            total_files: plan.total_files(),
            processed_files: plan.total_files(),
        },
    );

    Ok(plan)
}

/// 检查在恢复过程中是否应该跳过某个文件/目录
/// 主要用于跳过不兼容的旧数据库格式（如 Cozo）
/// 使用统一的跳过模式常量 INCOMPATIBLE_DATA_PATTERNS
fn should_skip_during_restore(file_name: &std::ffi::OsStr) -> bool {
    if let Some(name) = file_name.to_str() {
        // 使用统一的不兼容数据格式跳过列表
        for pattern in INCOMPATIBLE_DATA_PATTERNS {
            if name.contains(pattern) {
                return true;
            }
        }
    }
    false
}

/// 判断是否为 SQLite 的临时文件（WAL/SHM）
fn is_sqlite_aux_file(file_name: &std::ffi::OsStr) -> bool {
    if let Some(name) = file_name.to_str() {
        let lower = name.to_lowercase();
        // 常见形式：*.db-wal / *.db-shm
        return lower.ends_with(".db-wal")
            || lower.ends_with(".db-shm")
            || lower.ends_with("-wal")
            || lower.ends_with("-shm");
    }
    false
}

/// 带重试的删除/复制，缓解 Windows 上短暂占用导致的瞬时失败
fn resilient_remove_file(path: &Path) -> std::io::Result<()> {
    let mut last_err: Option<std::io::Error> = None;
    // P3 修复: 使用常量替代硬编码的魔法数字
    for _ in 0..RESILIENT_RETRY_COUNT {
        // 尝试移除只读属性
        if let Ok(md) = fs::metadata(path) {
            let mut perms = md.permissions();
            if perms.readonly() {
                perms.set_readonly(false);
                let _ = fs::set_permissions(path, perms);
            }
        }
        match fs::remove_file(path) {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(Duration::from_millis(RESILIENT_RETRY_DELAY_MS));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "unknown error")))
}

fn resilient_remove_dir_all(path: &Path) -> std::io::Result<()> {
    let mut last_err: Option<std::io::Error> = None;
    // P3 修复: 使用常量替代硬编码的魔法数字
    for _ in 0..RESILIENT_RETRY_COUNT {
        // 递归清除只读属性
        if path.exists() {
            let _ = (|| -> std::io::Result<()> {
                for entry in WalkDir::new(path)
                    .into_iter()
                    .filter_map(log_and_skip_walkdir_err)
                {
                    let p = entry.path();
                    if p.is_file() {
                        if let Ok(md) = fs::metadata(p) {
                            if md.permissions().readonly() {
                                let mut perms = md.permissions();
                                perms.set_readonly(false);
                                let _ = fs::set_permissions(p, perms);
                            }
                        }
                    }
                }
                Ok(())
            })();
        }
        match fs::remove_dir_all(path) {
            Ok(_) => return Ok(()),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(Duration::from_millis(RESILIENT_RETRY_DELAY_MS + 50));
                // 目录操作稍长延迟
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "unknown error")))
}

fn resilient_copy_file(src: &Path, dst: &Path) -> std::io::Result<u64> {
    if let Some(parent) = dst.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut last_err: Option<std::io::Error> = None;
    // P3 修复: 使用常量替代硬编码的魔法数字
    for _ in 0..RESILIENT_RETRY_COUNT {
        match fs::copy(src, dst) {
            Ok(n) => return Ok(n),
            Err(e) => {
                last_err = Some(e);
                std::thread::sleep(Duration::from_millis(RESILIENT_RETRY_DELAY_MS));
            }
        }
    }
    Err(last_err.unwrap_or_else(|| std::io::Error::new(std::io::ErrorKind::Other, "unknown error")))
}

/// 在导出前对所有 SQLite 数据库进行 checkpoint，尽量将 WAL 合并进主库
fn checkpoint_all_sqlite_dbs(root: &Path, ctx: &BackupExecutionContext) {
    // 1) 主库（通过连接池执行 checkpoint）
    if let Ok(conn) = ctx.database_manager.get_conn() {
        let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    }
    // 2) 遍历 app_data 下其他 SQLite 主库
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_map(log_and_skip_walkdir_err)
    {
        let path = entry.path();
        if path.is_file()
            && path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .ends_with(".db")
        {
            // 尝试以读写方式打开并 checkpoint；失败则忽略
            if let Ok(conn) =
                rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE)
            {
                let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
            }
        }
    }
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct BackupMetadata {
    pub version: String,
    pub app_version: String,
    pub created_at: String,
    pub platform: String,
    pub total_files: usize,
    pub total_size: u64,
    /// 文件校验和映射: 相对路径 -> SHA256哈希
    /// 用于导入时验证文件完整性
    #[serde(default)] // 兼容旧版本备份（无此字段）
    pub file_checksums: HashMap<String, String>,
    pub statistics: BackupStatistics,
    /// 备份过程中产生的警告信息
    /// 例如: P0 数据源缺失、完整性检查警告等
    #[serde(default)]
    pub warnings: Vec<String>,
    /// 分级备份信息（为空表示全量备份）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backup_tiers: Option<Vec<BackupTier>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Default)]
pub struct BackupStatistics {
    /// 会话数量（旧版字段名: total_mistakes）
    #[serde(default, alias = "total_mistakes")]
    pub sessions_count: usize,
    /// 图片数量（旧版字段名: total_images）
    #[serde(default, alias = "total_images")]
    pub images_count: usize,
    /// 笔记数量（旧版字段名: total_tags）
    #[serde(default, alias = "total_tags")]
    pub notes_count: usize,
    /// 文档数量（旧版字段名: total_knowledge_cards）
    #[serde(default, alias = "total_knowledge_cards")]
    pub documents_count: usize,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct ImportProgress {
    pub phase: String,
    pub progress: f32,
    pub message: String,
    pub current_file: Option<String>,
    pub total_files: usize,
    pub processed_files: usize,
}

/// Helper – return the application data root directory.
fn app_data_root(state: &AppState) -> PathBuf {
    // 使用 FileManager 的自适应可写目录
    state.file_manager.get_writable_app_data_dir()
}

/// Helper – return `<app_data>/backups` directory, create if missing
fn ensure_backups_dir(root: &Path) -> std::io::Result<PathBuf> {
    let dir = root.join(BACKUPS_DIR_NAME);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn locate_logs_dir(root: &Path) -> Option<PathBuf> {
    let inline_logs = root.join("logs");
    if inline_logs.exists() {
        return Some(inline_logs);
    }
    let parent = root.parent()?;
    if parent
        .file_name()
        .and_then(|n| n.to_str())
        .map(|name| name == "slots")
        .unwrap_or(false)
    {
        if let Some(base) = parent.parent() {
            let shared_logs = base.join("logs");
            if shared_logs.exists() {
                return Some(shared_logs);
            }
        }
    }
    None
}

/// 发送进度更新到前端或任务管理器
fn emit_progress(
    job: Option<&BackupJobContext>,
    window: Option<&Window>,
    progress: ImportProgress,
) -> Result<()> {
    if let Some(job_ctx) = job {
        let phase = map_phase(&progress.phase);
        job_ctx.mark_running(
            phase,
            progress.progress,
            Some(progress.message.clone()),
            progress.processed_files as u64,
            progress.total_files as u64,
        );
        job_ctx.emit_legacy_progress(&progress);
    }

    if let Some(win) = window {
        win.emit("backup-import-progress", &progress)
            .map_err(|e| AppError::internal(format!("发送进度事件失败: {}", e)))?;
    }

    Ok(())
}

fn map_phase(phase: &str) -> BackupJobPhase {
    match phase {
        "scan" => BackupJobPhase::Scan,
        "checkpoint" => BackupJobPhase::Checkpoint,
        "compression" | "compress" => BackupJobPhase::Compress,
        "verify" => BackupJobPhase::Verify,
        "extract" => BackupJobPhase::Extract,
        "replacing" | "replace" => BackupJobPhase::Replace,
        "cleanup" => BackupJobPhase::Cleanup,
        "complete" => BackupJobPhase::Completed,
        "failed" => BackupJobPhase::Failed,
        _ => BackupJobPhase::Scan,
    }
}

/// 收集备份统计信息
/// 当前返回默认值；后续可从 Chat V2 / VFS 等数据源填充实际统计
fn collect_backup_statistics(_ctx: &BackupExecutionContext) -> Result<BackupStatistics> {
    Ok(BackupStatistics::default())
}

/// 创建备份元数据
fn create_backup_metadata(
    plan: &BackupPlan,
    ctx: &BackupExecutionContext,
    options: &ExportOptions,
) -> Result<BackupMetadata> {
    let statistics = collect_backup_statistics(ctx)?;

    Ok(BackupMetadata {
        version: "2.0".to_string(),
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: Utc::now().to_rfc3339(),
        platform: std::env::consts::OS.to_string(),
        total_files: plan.total_files(),
        total_size: plan.total_size,
        file_checksums: HashMap::new(), // 将在 build_zip_with_metadata 中填充
        statistics,
        warnings: Vec::new(), // P0 验证等阶段会填充警告
        backup_tiers: options
            .backup_tiers
            .as_ref()
            .filter(|tiers| !tiers.is_empty())
            .cloned(),
    })
}

/// Build a zip archive containing everything under `root`, except the backups directory itself.
/// 增强版：包含元数据和进度反馈
/// 返回计算的文件校验和
fn write_small_batch(
    batch: &[usize],
    plan: &BackupPlan,
    zip: &mut zip::ZipWriter<File>,
    file_options: &FileOptions,
    job: Option<&BackupJobContext>,
    window: Option<&Window>,
    total_files: usize,
    processed_before: &mut usize,
) -> Result<Vec<(String, String)>> {
    if batch.is_empty() {
        return Ok(Vec::new());
    }

    // 流式处理每个文件，避免 read_to_end 带来的内存峰值。
    let mut checksums = Vec::with_capacity(batch.len());
    for idx in batch {
        let entry = &plan.files[*idx];
        let (relative, hash) = write_single_file(
            entry,
            zip,
            file_options,
            job,
            window,
            total_files,
            processed_before,
        )?;
        checksums.push((relative, hash));
    }

    Ok(checksums)
}

/// 写入单个大文件并计算哈希（流式处理，避免 OOM）
/// 返回 (相对路径, SHA256哈希)
///
/// P0 修复: 使用流式读写替代 read_to_end，防止大文件导致内存溢出
fn write_single_file(
    entry: &BackupPlanEntry,
    zip: &mut zip::ZipWriter<File>,
    file_options: &FileOptions,
    job: Option<&BackupJobContext>,
    window: Option<&Window>,
    total_files: usize,
    processed_before: &mut usize,
) -> Result<(String, String)> {
    if let Some(job_ctx) = job {
        if job_ctx.is_cancelled() {
            return Err(AppError::operation_failed("备份任务已取消"));
        }
    }

    // 流式处理：使用固定大小缓冲区（64KB），边读边写边计算哈希
    const CHUNK_SIZE: usize = 64 * 1024; // 64KB 缓冲区

    let file = File::open(&entry.absolute)
        .map_err(|e| AppError::file_system(format!("打开文件失败 {:?}: {}", entry.absolute, e)))?;
    let mut reader = BufReader::with_capacity(CHUNK_SIZE, file);
    let mut hasher = Sha256::new();

    // 先启动 ZIP 条目
    zip.start_file(&entry.relative, file_options.clone())
        .map_err(|e| {
            AppError::file_system(format!("写入 Zip 条目失败 {}: {}", entry.relative, e))
        })?;

    // 流式读取、计算哈希、写入 ZIP
    let mut buffer = vec![0u8; CHUNK_SIZE];
    loop {
        let bytes_read = reader.read(&mut buffer).map_err(|e| {
            AppError::file_system(format!("读取文件失败 {:?}: {}", entry.absolute, e))
        })?;

        if bytes_read == 0 {
            break; // EOF
        }

        let chunk = &buffer[..bytes_read];
        hasher.update(chunk);
        zip.write_all(chunk).map_err(|e| {
            AppError::file_system(format!("写入 Zip 内容失败 {}: {}", entry.relative, e))
        })?;
    }

    let hash = format!("{:x}", hasher.finalize());

    *processed_before += 1;
    let progress = 30.0 + (*processed_before as f32 / total_files as f32) * 60.0;
    let _ = emit_progress(
        job,
        window,
        ImportProgress {
            phase: "compress".to_string(),
            progress,
            message: format!("压缩文件 {}/{}", processed_before, total_files),
            current_file: Some(entry.relative.clone()),
            total_files,
            processed_files: *processed_before,
        },
    );

    Ok((entry.relative.clone(), hash))
}

/// 从备份计划构建清单
fn build_manifest_from_plan(plan: &BackupPlan, metadata: &BackupMetadata) -> BackupManifest {
    let mut manifest = BackupManifest::new(&metadata.app_version);

    // 按路径前缀分组文件，识别数据源
    let mut source_stats: HashMap<DataSource, (usize, u64)> = HashMap::new();

    for entry in &plan.files {
        let rel_lower = entry.relative.to_lowercase();

        // 识别数据源类型
        let source = if rel_lower.ends_with("mistakes.db") {
            Some(DataSource::MistakesDb)
        } else if rel_lower.contains("databases/chat_v2.db") {
            Some(DataSource::ChatV2Db)
        } else if rel_lower.ends_with("notes.db") && !rel_lower.contains("lance/") {
            Some(DataSource::NotesDb)
        } else if rel_lower.ends_with("vfs.db") {
            Some(DataSource::VfsDb)
        } else if rel_lower.ends_with("research.db") {
            Some(DataSource::ResearchDb)
        } else if rel_lower.ends_with("template_ai.db") {
            Some(DataSource::TemplateAiDb)
        } else if rel_lower.ends_with("essay_grading.db") {
            Some(DataSource::EssayGradingDb)
        } else if rel_lower.ends_with("canvas_boards.db") {
            Some(DataSource::CanvasBoardsDb)
        } else if rel_lower.contains("databases/textbooks.db") {
            Some(DataSource::TextbooksDb)
        } else if rel_lower.ends_with("message_queue.db") {
            Some(DataSource::MessageQueueDb)
        } else if rel_lower.ends_with("resources.db") {
            Some(DataSource::ResourcesDb)
        } else if rel_lower.ends_with("anki.db") {
            Some(DataSource::AnkiDb)
        } else if rel_lower.contains("databases/main.db") {
            Some(DataSource::MainDb)
        } else if rel_lower.starts_with("lance/vfs/") {
            Some(DataSource::LanceVfs)
        } else if rel_lower.starts_with("lance/rag/") {
            Some(DataSource::LanceRag)
        } else if rel_lower.starts_with("lance/notes/") {
            Some(DataSource::LanceNotes)
        } else if rel_lower.starts_with("lance/memory/") {
            Some(DataSource::LanceMemory)
        } else if rel_lower.starts_with("images/") {
            Some(DataSource::Images)
        } else if rel_lower.starts_with("notes_assets/") {
            Some(DataSource::NotesAssets)
        } else if rel_lower.starts_with("documents/") {
            Some(DataSource::Documents)
        } else if rel_lower.starts_with("subjects/") {
            Some(DataSource::Subjects)
        } else if rel_lower.starts_with("audio/") {
            Some(DataSource::Audio)
        } else if rel_lower.starts_with("videos/") {
            Some(DataSource::Videos)
        } else if rel_lower == "settings.json" {
            Some(DataSource::Settings)
        } else {
            None
        };

        if let Some(src) = source {
            let stats = source_stats.entry(src).or_insert((0, 0));
            stats.0 += 1;
            stats.1 += entry.size;
        }
    }

    // 转换为清单条目
    for (source_type, (file_count, total_bytes)) in source_stats {
        manifest.add_source(ManifestDataSource {
            source_type,
            relative_path: source_type.relative_path_pattern().to_string(),
            file_count,
            total_bytes,
            is_complete: true,
            notes: None,
        });
    }

    manifest
}

fn build_zip_with_metadata(
    plan: &BackupPlan,
    target_zip: &Path,
    metadata: &mut BackupMetadata,
    options: &ExportOptions,
    job: Option<&BackupJobContext>,
    window: Option<&Window>,
    maintenance_guard: Option<&MaintenanceGuard>,
) -> Result<()> {
    let file = File::create(target_zip)
        .map_err(|e| AppError::file_system(format!("创建备份文件失败: {}", e)))?;
    let mut zip = zip::ZipWriter::new(file);
    let compression_level = options.compression_level.min(9);
    let compression_method = if compression_level == 0 {
        zip::CompressionMethod::Stored
    } else {
        zip::CompressionMethod::Deflated
    };
    let mut file_options = FileOptions::default().compression_method(compression_method);
    if compression_level > 0 {
        file_options = file_options.compression_level(Some(compression_level as i32));
    }
    let dir_options = FileOptions::default().compression_method(zip::CompressionMethod::Stored);

    // 先写入目录结构
    for dir in &plan.directories {
        if dir.is_empty() {
            continue;
        }
        zip.add_directory(dir, dir_options.clone())
            .map_err(|e| AppError::file_system(format!("写入 Zip 目录失败 {}: {}", dir, e)))?;
    }

    let mut processed_files = 0usize;
    let total_files = plan.total_files().max(1);
    let parallelism = options.parallelism.unwrap_or(1).max(1);
    let mut batch: Vec<usize> = Vec::new();
    let mut all_checksums: Vec<(String, String)> = Vec::new();

    for (idx, entry) in plan.files.iter().enumerate() {
        // P0 修复: 定期检查维护模式是否超时，防止无限期占用
        if let Some(guard) = maintenance_guard {
            if guard.is_timed_out() {
                error!(
                    "[build_zip_with_metadata] 维护模式超时（已持续 {} 秒，限制 {} 秒），中止压缩（已处理 {}/{} 个文件）",
                    guard.elapsed_secs(),
                    guard.timeout_secs,
                    processed_files,
                    total_files
                );
                return Err(AppError::operation_failed(format!(
                    "备份压缩超时：维护模式已持续 {} 秒超过 {} 秒限制，已处理 {}/{} 个文件。请减少备份范围或增加超时时间后重试",
                    guard.elapsed_secs(),
                    guard.timeout_secs,
                    processed_files,
                    total_files
                )));
            }
        }

        if parallelism > 1 && entry.size <= MAX_PARALLEL_FILE_BYTES {
            batch.push(idx);
            if batch.len() >= parallelism {
                let checksums = write_small_batch(
                    &batch,
                    plan,
                    &mut zip,
                    &file_options,
                    job,
                    window,
                    total_files,
                    &mut processed_files,
                )?;
                all_checksums.extend(checksums);
                batch.clear();
            }
        } else {
            if !batch.is_empty() {
                let checksums = write_small_batch(
                    &batch,
                    plan,
                    &mut zip,
                    &file_options,
                    job,
                    window,
                    total_files,
                    &mut processed_files,
                )?;
                all_checksums.extend(checksums);
                batch.clear();
            }
            let (path, hash) = write_single_file(
                entry,
                &mut zip,
                &file_options,
                job,
                window,
                total_files,
                &mut processed_files,
            )?;
            all_checksums.push((path, hash));
        }
    }

    if !batch.is_empty() {
        let checksums = write_small_batch(
            &batch,
            plan,
            &mut zip,
            &file_options,
            job,
            window,
            total_files,
            &mut processed_files,
        )?;
        all_checksums.extend(checksums);
    }

    // 将所有校验和存入 metadata
    for (path, hash) in all_checksums {
        metadata.file_checksums.insert(path, hash);
    }
    info!(
        "已计算 {} 个文件的 SHA256 校验和",
        metadata.file_checksums.len()
    );

    // 最后写入元数据文件（包含完整的 file_checksums）
    info!("[Backup] 写入备份元数据: {}", METADATA_FILE);
    zip.start_file(METADATA_FILE, file_options.clone())
        .map_err(|e| AppError::file_system(format!("写入元数据文件失败: {}", e)))?;
    let metadata_json = serde_json::to_string_pretty(&metadata)
        .map_err(|e| AppError::internal(format!("序列化元数据失败: {}", e)))?;
    zip.write_all(metadata_json.as_bytes())
        .map_err(|e| AppError::file_system(format!("写入元数据内容失败: {}", e)))?;
    debug!("[Backup] 元数据写入完成，大小 {} 字节", metadata_json.len());

    // P0 修复: 写入备份清单（Section 2.2）
    // manifest.json 记录所有已打包数据源及其统计信息
    let manifest = build_manifest_from_plan(plan, metadata);
    info!(
        "写入备份清单: {} (包含 {} 个数据源)",
        MANIFEST_FILE,
        manifest.data_sources.len()
    );
    zip.start_file(MANIFEST_FILE, file_options.clone())
        .map_err(|e| AppError::file_system(format!("写入清单文件失败: {}", e)))?;
    let manifest_json = serde_json::to_string_pretty(&manifest)
        .map_err(|e| AppError::internal(format!("序列化清单失败: {}", e)))?;
    zip.write_all(manifest_json.as_bytes())
        .map_err(|e| AppError::file_system(format!("写入清单内容失败: {}", e)))?;
    debug!("[Backup] 清单写入完成，大小 {} 字节", manifest_json.len());

    zip.finish()
        .map_err(|e| AppError::file_system(format!("完成 Zip 写入失败: {}", e)))?;
    Ok(())
}

fn run_export_job(ctx: BackupExecutionContext, options: ExportOptions, job_ctx: BackupJobContext) {
    use log::warn;
    use std::fs;

    #[derive(Debug)]
    enum PathTarget {
        Local(PathBuf),
        Virtual(String),
    }

    impl PathTarget {
        fn from(raw: String) -> Self {
            let trimmed = raw.trim().to_string();
            if trimmed.starts_with("content://")
                || trimmed.starts_with("asset://")
                || trimmed.starts_with("ph://")
                || trimmed.starts_with("image://")
                || trimmed.starts_with("camera://")
            {
                PathTarget::Virtual(trimmed)
            } else {
                // 处理 file:// 前缀，移除后创建本地路径
                let normalized = if let Some(stripped) = trimmed.strip_prefix("file://") {
                    stripped.to_string()
                } else if let Some(stripped) = trimmed.strip_prefix("tauri://localhost/") {
                    format!("/{}", stripped)
                } else if let Some(stripped) = trimmed.strip_prefix("tauri://") {
                    format!("/{}", stripped)
                } else {
                    trimmed
                };
                PathTarget::Local(PathBuf::from(normalized))
            }
        }
    }

    let job_id = job_ctx.job_id.clone();
    let start = Instant::now();
    let whitelist = build_whitelist(&options);

    let result: Result<()> = (|| {
        job_ctx.mark_running(
            BackupJobPhase::Scan,
            2.0,
            Some("开始扫描备份内容".to_string()),
            0,
            0,
        );

        let root = ctx.app_data_root();
        let backups_dir =
            ensure_backups_dir(&root).map_err(|e| AppError::file_system(e.to_string()))?;
        let default_name = format!("dstu-backup-{}.zip", Utc::now().format("%Y%m%d-%H%M%S"));
        let temp_zip = backups_dir.join(&default_name);

        let mut plan = build_backup_plan(&root, &options, whitelist.as_deref(), Some(&job_ctx))?;
        job_ctx.mark_running(
            BackupJobPhase::Scan,
            12.0,
            Some(format!("扫描完成，共 {} 个文件", plan.total_files())),
            plan.total_files() as u64,
            plan.total_files() as u64,
        );

        if job_ctx.is_cancelled() {
            job_ctx.cancelled(Some("用户取消导出任务".to_string()));
            return Err(AppError::operation_failed("备份任务已取消"));
        }

        // ====================================================================
        // P0 修复: 导出时进入可控冻结态，避免并发写入导致快照不一致
        // ====================================================================
        job_ctx.mark_running(
            BackupJobPhase::Checkpoint,
            15.0,
            Some("进入维护模式，准备数据快照...".to_string()),
            0,
            0,
        );

        // 进入维护模式（使用 RAII Guard 确保退出）
        let _maintenance_guard = MaintenanceGuard::enter(ctx.database.clone())?;

        job_ctx.mark_running(
            BackupJobPhase::Checkpoint,
            18.0,
            Some("执行数据库 checkpoint".to_string()),
            0,
            0,
        );
        checkpoint_all_sqlite_dbs(&root, &ctx);

        if options.perform_lance_compaction && includes_rebuildable(&options) {
            job_ctx.mark_running(
                BackupJobPhase::Checkpoint,
                24.0,
                Some("执行 Lance compaction（合并碎片、优化性能）...".to_string()),
                0,
                0,
            );
            // 旧 RAG 已废弃，跳过 Lance 优化
            info!("[Backup] 跳过 Lance Compaction（旧 RAG 已废弃）");
            job_ctx.mark_running(
                BackupJobPhase::Checkpoint,
                28.0,
                Some("跳过 Lance 优化".to_string()),
                0,
                0,
            );
        } else if options.perform_lance_compaction {
            job_ctx.mark_running(
                BackupJobPhase::Checkpoint,
                24.0,
                Some("分级备份未包含可重建数据，跳过 Lance 优化".to_string()),
                0,
                0,
            );
        }

        plan = build_backup_plan(&root, &options, whitelist.as_deref(), Some(&job_ctx))?;

        // ====================================================================
        // P1 修复: 将 state.json 纳入备份范围
        // state.json 记录当前活动的数据空间（slotA/slotB），位于 slots/ 目录下
        // ====================================================================
        if includes_core_config(&options) {
            if let Some(parent) = root.parent() {
                // root 是 slots/slotX，parent 是 slots/
                let state_json_path = parent.join("state.json");
                if state_json_path.exists() && state_json_path.is_file() {
                    // 检查不是符号链接
                    if !is_symlink(&state_json_path) {
                        if let Ok(state_metadata) = fs::metadata(&state_json_path) {
                            let state_size = state_metadata.len();
                            plan.files.push(BackupPlanEntry {
                                absolute: state_json_path,
                                relative: "slots_state.json".to_string(), // 使用特殊名称避免与 settings.json 混淆
                                size: state_size,
                            });
                            plan.total_size += state_size;
                            info!(
                                "[BackupExport] 已将 state.json 加入备份计划 ({} bytes)",
                                state_size
                            );
                        }
                    }
                }
            }
        } else {
            info!("[BackupExport] 分级备份未包含核心配置，跳过 slots/state.json");
        }

        job_ctx.mark_running(
            BackupJobPhase::Scan,
            32.0,
            Some("刷新备份计划".to_string()),
            plan.total_files() as u64,
            plan.total_files() as u64,
        );

        let mut metadata = create_backup_metadata(&plan, &ctx, &options)?;

        // ====================================================================
        // P0 验证: 确保所有关键数据源都已包含在备份计划中
        // ====================================================================
        if has_backup_tiers(&options) {
            job_ctx.mark_running(
                BackupJobPhase::Scan,
                34.0,
                Some("分级备份：跳过 P0 完整性验证".to_string()),
                0,
                0,
            );
            info!("[BackupExport] 分级备份模式，跳过 P0 完整性验证");
            metadata
                .warnings
                .push("分级备份模式：未执行 P0 完整性验证".to_string());
        } else {
            job_ctx.mark_running(
                BackupJobPhase::Scan,
                34.0,
                Some("验证 P0 数据源完整性...".to_string()),
                0,
                0,
            );

            let backup_files: Vec<String> = plan.files.iter().map(|e| e.relative.clone()).collect();
            let p0_result = verify_p0_data_sources(&root, &backup_files);

            if !p0_result.inaccessible.is_empty() {
                // P0 数据源无法访问 - 记录严重警告但继续（用户可能需要这些数据）
                for (source, reason) in &p0_result.inaccessible {
                    warn!("[Backup] P0 数据源 {:?} 无法访问: {}", source, reason);
                    metadata
                        .warnings
                        .push(format!("P0 数据源 {:?} 未包含在备份中: {}", source, reason));
                }
            }

            for warning in &p0_result.warnings {
                warn!("{}", warning);
                metadata.warnings.push(warning.clone());
            }

            info!(
                "[BackupExport] P0 验证完成: {} 个存在, {} 个缺失, {} 个无法访问",
                p0_result.present.len(),
                p0_result.missing.len(),
                p0_result.inaccessible.len()
            );
        }

        if job_ctx.is_cancelled() {
            job_ctx.cancelled(Some("用户取消导出任务".to_string()));
            let _ = fs::remove_file(&temp_zip);
            return Err(AppError::operation_failed("备份任务已取消"));
        }

        job_ctx.mark_running(
            BackupJobPhase::Compress,
            36.0,
            Some("开始压缩备份数据".to_string()),
            0,
            plan.total_files() as u64,
        );

        // P1-3 修复: 确保 ZIP 构建失败时清理部分文件并保存进度信息
        if let Err(e) = build_zip_with_metadata(
            &plan,
            &temp_zip,
            &mut metadata,
            &options,
            Some(&job_ctx),
            None,
            Some(&_maintenance_guard),
        ) {
            error!("[Backup] ZIP 构建失败，清理部分文件: {:?}", temp_zip);
            let _ = fs::remove_file(&temp_zip);

            // P1 优化: 保存失败时的进度信息，帮助用户了解导出状态
            let checkpoint_path = backups_dir.join("export_checkpoint.json");
            let checkpoint_info = serde_json::json!({
                "failed_at": Utc::now().to_rfc3339(),
                "total_files": plan.total_files(),
                "total_size_bytes": plan.total_size,
                "error": e.to_string(),
                "can_retry": true,
                "hint": "导出失败，请检查磁盘空间后重试"
            });
            if let Ok(checkpoint_json) = serde_json::to_string_pretty(&checkpoint_info) {
                let _ = fs::write(&checkpoint_path, checkpoint_json);
                info!("[BackupExport] 已保存导出检查点到 {:?}", checkpoint_path);
            }

            job_ctx.fail(format!("备份压缩失败: {}", e));
            return Err(e);
        }

        if job_ctx.is_cancelled() {
            job_ctx.cancelled(Some("用户取消导出任务".to_string()));
            let _ = fs::remove_file(&temp_zip);
            return Err(AppError::operation_failed("备份任务已取消"));
        }

        job_ctx.mark_running(
            BackupJobPhase::Verify,
            94.0,
            Some("验证备份完整性".to_string()),
            0,
            0,
        );

        let _verification_metadata = validate_zip_metadata(&temp_zip, Some(&job_ctx), None)?;

        // 处理用户期望的输出路径
        if let Some(raw_output_path) = options.output_path.as_ref() {
            info!(
                "[BackupJob] 用户请求导出路径（原始字符串）: {}",
                raw_output_path
            );
        } else {
            info!(
                "[BackupJob] 未指定导出路径，默认保存在应用数据目录 ({}).",
                temp_zip.display()
            );
        }

        let mut final_target = options.output_path.clone().map(|p| p.trim().to_string());
        let target_kind = final_target
            .as_ref()
            .map(|raw| PathTarget::from(raw.clone()));

        let mut resolved_path = temp_zip.clone();

        match target_kind {
            Some(PathTarget::Local(dest)) => {
                info!("[BackupJob] 输出路径解析为本地路径: {}", dest.display());
                if dest != temp_zip {
                    if let Some(parent) = dest.parent() {
                        if let Err(err) = fs::create_dir_all(parent) {
                            let _ = fs::remove_file(&temp_zip);
                            return Err(AppError::file_system(format!(
                                "创建导出目录失败: {} ({})",
                                err,
                                parent.to_string_lossy()
                            )));
                        } else {
                            info!("[BackupJob] 已确保用户目录存在: {}", parent.display());
                        }
                    }

                    info!(
                        "[BackupJob] 开始移动备份文件: {} -> {}",
                        temp_zip.display(),
                        dest.display()
                    );

                    if let Err(err) = fs::rename(&temp_zip, &dest) {
                        let _ = fs::remove_file(&temp_zip);
                        return Err(AppError::file_system(format!("移动备份文件失败: {}", err)));
                    }
                    resolved_path = dest;
                    final_target = Some(resolved_path.to_string_lossy().to_string());
                    info!(
                        "[BackupJob] 备份文件已移动到用户目录: {}",
                        resolved_path.display()
                    );
                } else {
                    info!(
                        "[BackupJob] 用户请求路径与临时文件相同，保持在应用目录: {}",
                        dest.display()
                    );
                }
            }
            Some(PathTarget::Virtual(uri)) => {
                info!(
                    "[BackupJob] 输出路径解析为虚拟 URI，经统一文件管理器写入: {}",
                    uri
                );
                let window = ctx.window().ok_or_else(|| {
                    AppError::operation_failed("缺少有效窗口上下文，无法写入外部目录")
                })?;
                match unified_file_manager::copy_file(
                    &window,
                    &temp_zip.to_string_lossy().to_string(),
                    &uri,
                ) {
                    Ok(_) => {
                        if let Err(err) = fs::remove_file(&temp_zip) {
                            warn!("[Backup] 复制成功但删除临时文件失败: {}", err);
                        }
                        resolved_path = PathBuf::from(uri.clone());
                        final_target = Some(uri);
                        info!(
                            "[BackupJob] 备份文件已复制到虚拟目标，临时文件已清理: {}",
                            resolved_path.display()
                        );
                    }
                    Err(err) => {
                        let _ = fs::remove_file(&temp_zip);
                        return Err(AppError::file_system(format!("复制备份文件失败: {}", err)));
                    }
                }
            }
            None => {
                final_target = Some(temp_zip.to_string_lossy().to_string());
                info!(
                    "[BackupJob] 没有提供输出路径，备份文件保存在默认目录: {}",
                    temp_zip.display()
                );
            }
        }

        // MaintenanceGuard 会在作用域结束时自动退出维护模式

        let duration = start.elapsed().as_millis() as u64;
        job_ctx.complete(
            Some("备份导出完成".to_string()),
            plan.total_files() as u64,
            plan.total_files() as u64,
            BackupJobResultPayload {
                success: true,
                output_path: final_target.clone(),
                resolved_path: Some(resolved_path.to_string_lossy().to_string()),
                message: Some("备份导出完成".to_string()),
                error: None,
                duration_ms: Some(duration),
                stats: Some(serde_json::json!({
                    "totalFiles": metadata.total_files,
                    "totalSize": metadata.total_size,
                    "compressionLevel": options.compression_level,
                    "includeLogs": options.include_logs,
                    "includeTemp": options.include_temp,
                })),
                requires_restart: false,
                checkpoint_path: None,
                resumable_job_id: None,
            },
        );

        Ok(())
    })();

    // MaintenanceGuard 会在作用域结束时自动退出维护模式
    if let Err(err) = result {
        error!("[BackupJob] 导出任务失败 job_id={} err={}", job_id, err);
        job_ctx.fail(err.message.clone());
    }
}

fn run_import_job(
    ctx: BackupExecutionContext,
    archive_path: PathBuf,
    options: ImportOptions,
    job_ctx: BackupJobContext,
) {
    let job_id = job_ctx.job_id.clone();
    let start = Instant::now();
    let result: Result<()> = (|| {
        if !archive_path.exists() {
            return Err(AppError::not_found("备份文件不存在"));
        }

        job_ctx.mark_running(
            BackupJobPhase::Scan,
            4.0,
            Some("验证备份文件".to_string()),
            0,
            0,
        );

        let metadata = validate_zip_metadata(&archive_path, Some(&job_ctx), None)?;

        let root = ctx.app_data_root();

        // ====================================================================
        // P2 安全检查: 磁盘空间预检查
        // ====================================================================
        let required_space = metadata.total_size * 3;
        if let Err(e) = check_disk_space(&root, required_space) {
            return Err(AppError::validation(format!(
                "磁盘空间不足，无法安全导入备份: {}",
                e
            )));
        }
        info!(
            "磁盘空间检查通过: 需要 {:.2} GB",
            required_space as f64 / 1024.0 / 1024.0 / 1024.0
        );

        let temp_dir = root.join(TEMP_RESTORE_DIR);
        if temp_dir.exists() {
            resilient_remove_dir_all(&temp_dir)
                .map_err(|e| AppError::file_system(format!("清理临时目录失败: {}", e)))?;
        }

        // ====================================================================
        // P0 修复: 将维护模式提前到 checkpoint 和 backup_current_data 之前
        // 确保在备份当前 SQLite 文件时，数据库不会被并发写入
        // ====================================================================
        job_ctx.mark_running(
            BackupJobPhase::Checkpoint,
            16.0,
            Some("进入维护模式...".to_string()),
            0,
            0,
        );
        let _maintenance_guard = MaintenanceGuard::enter(ctx.database.clone())?;

        job_ctx.mark_running(
            BackupJobPhase::Extract,
            18.0,
            Some("解压备份文件".to_string()),
            0,
            metadata.total_files as u64,
        );

        let extraction_stats = extract_to_temp_dir(
            &archive_path,
            &temp_dir,
            &metadata,
            Some(&job_ctx),
            options.best_effort,
            Some(&_maintenance_guard),
        )?;

        if job_ctx.is_cancelled() {
            job_ctx.cancelled(Some("用户取消导入任务".to_string()));
            let _ = resilient_remove_dir_all(&temp_dir);
            return Err(AppError::operation_failed("备份任务已取消"));
        }

        job_ctx.mark_running(
            BackupJobPhase::Checkpoint,
            26.0,
            Some("执行数据库 checkpoint".to_string()),
            0,
            0,
        );
        checkpoint_all_sqlite_dbs(&root, &ctx);

        let backups_dir =
            ensure_backups_dir(&root).map_err(|e| AppError::file_system(e.to_string()))?;

        job_ctx.mark_running(
            BackupJobPhase::Replace,
            34.0,
            Some("备份当前数据".to_string()),
            0,
            0,
        );
        let pre_backup_dir = backup_current_data(&root, &backups_dir)?;

        job_ctx.mark_running(
            BackupJobPhase::Replace,
            48.0,
            Some("清理旧数据".to_string()),
            0,
            0,
        );
        for entry in fs::read_dir(&root).map_err(|e| AppError::file_system(e.to_string()))? {
            let entry = entry.map_err(|e| AppError::file_system(e.to_string()))?;
            let path = entry.path();
            if path.file_name().map_or(false, |n| n == BACKUPS_DIR_NAME)
                || path.file_name().map_or(false, |n| n == TEMP_RESTORE_DIR)
                || path
                    .file_name()
                    .map_or(false, |n| n == MIGRATION_CORE_BACKUPS_DIR)
            {
                continue;
            }
            if path.is_file() {
                resilient_remove_file(&path).map_err(|e| {
                    AppError::file_system(format!("删除文件失败 {:?}: {}", path, e))
                })?;
            } else {
                resilient_remove_dir_all(&path).map_err(|e| {
                    AppError::file_system(format!("删除目录失败 {:?}: {}", path, e))
                })?;
            }
        }

        job_ctx.mark_running(
            BackupJobPhase::Replace,
            62.0,
            Some("复制新数据".to_string()),
            0,
            0,
        );

        fn copy_dir_contents(src_dir: &Path, dst_dir: &Path) -> Result<()> {
            for entry in fs::read_dir(src_dir)
                .map_err(|e| AppError::file_system(format!("读取目录失败 {:?}: {}", src_dir, e)))?
            {
                let entry =
                    entry.map_err(|e| AppError::file_system(format!("读取目录项失败: {}", e)))?;
                let src = entry.path();
                let file_name = entry.file_name();
                let dst = dst_dir.join(&file_name);

                // ================================================================
                // 安全修复: 跳过符号链接防止目录遍历攻击
                // ================================================================
                if is_symlink(&src) {
                    warn!("[Backup] 跳过符号链接: {:?}", src);
                    continue;
                }

                if should_skip_during_restore(&file_name) {
                    warn!("[Backup] 跳过不兼容的文件/目录: {:?}", file_name);
                    continue;
                }

                if src.is_file() {
                    if is_sqlite_aux_file(&file_name) {
                        continue;
                    }
                    if let Some(parent) = dst.parent() {
                        fs::create_dir_all(parent).map_err(|e| {
                            AppError::file_system(format!("创建父目录失败 {:?}: {}", parent, e))
                        })?;
                    }
                    resilient_copy_file(&src, &dst).map_err(|e| {
                        AppError::file_system(format!("复制文件失败 {:?} -> {:?}: {}", src, dst, e))
                    })?;
                } else if src.is_dir() {
                    fs::create_dir_all(&dst).map_err(|e| {
                        AppError::file_system(format!("创建目录失败 {:?}: {}", dst, e))
                    })?;
                    copy_dir_contents(&src, &dst)?;
                }
            }
            Ok(())
        }

        if let Err(err) = copy_dir_contents(&temp_dir, &root) {
            error!("[Rollback] 复制新数据失败，触发回滚: {}", err);
            job_ctx.mark_running(
                BackupJobPhase::Replace,
                82.0,
                Some("复制失败，开始回滚".to_string()),
                0,
                0,
            );

            perform_rollback(&root, &pre_backup_dir, &temp_dir)?;
            return Err(err);
        }

        // ====================================================================
        // P1 修复: 恢复 slots_state.json 到正确位置
        // 备份中的 slots_state.json 需要恢复到 slots/state.json
        // ====================================================================
        let slots_state_in_root = root.join("slots_state.json");
        if slots_state_in_root.exists() && slots_state_in_root.is_file() {
            if let Some(parent) = root.parent() {
                let target_state_json = parent.join("state.json");
                match fs::rename(&slots_state_in_root, &target_state_json) {
                    Ok(_) => {
                        info!(
                            "[BackupImport] 已恢复 state.json 到 {:?}",
                            target_state_json
                        );
                    }
                    Err(rename_err) => {
                        // 如果 rename 失败（跨文件系统），尝试复制后删除
                        match fs::copy(&slots_state_in_root, &target_state_json) {
                            Ok(_) => {
                                let _ = fs::remove_file(&slots_state_in_root);
                                info!(
                                    "[BackupImport] 已复制 state.json 到 {:?}",
                                    target_state_json
                                );
                            }
                            Err(copy_err) => {
                                warn!(
                                    "[BackupImport] 恢复 state.json 失败 (rename: {}, copy: {})，数据空间状态可能需要手动配置",
                                    rename_err, copy_err
                                );
                            }
                        }
                    }
                }
            }
        }

        // ====================================================================
        // P0 强化: 恢复后对所有 SQLite 数据库执行 PRAGMA integrity_check
        // 如果核心数据库损坏，自动回滚到 pre_restore 备份
        // ====================================================================
        job_ctx.mark_running(
            BackupJobPhase::Verify,
            88.0,
            Some("执行恢复后完整性检查".to_string()),
            0,
            0,
        );

        let integrity_failures = run_post_restore_integrity_check(&root);
        if !integrity_failures.is_empty() {
            error!(
                "[PostRestoreVerify] 恢复后 PRAGMA integrity_check 失败 ({} 个数据库)，触发自动回滚",
                integrity_failures.len()
            );
            for fail in &integrity_failures {
                error!("[PostRestoreVerify] 损坏的数据库: {}", fail);
            }

            job_ctx.mark_running(
                BackupJobPhase::Replace,
                89.0,
                Some("数据库完整性校验失败，自动回滚中...".to_string()),
                0,
                0,
            );

            perform_rollback(&root, &pre_backup_dir, &temp_dir)?;
            return Err(AppError::operation_failed(format!(
                "恢复的数据库完整性校验失败，已自动回滚到恢复前状态。\
                 损坏的数据库: {}。备份文件可能已损坏，请尝试使用其他备份。",
                integrity_failures.join(", ")
            )));
        }

        // 额外的非阻塞完整性警告（与旧逻辑兼容）
        if options.perform_integrity_check {
            let warnings = run_integrity_checks(&root);
            if !warnings.is_empty() {
                for warning in &warnings {
                    warn!("[Backup] 恢复后完整性警告: {}", warning);
                }
            }
        }

        job_ctx.mark_running(
            BackupJobPhase::Cleanup,
            94.0,
            Some("清理临时文件".to_string()),
            0,
            0,
        );
        let _ = resilient_remove_dir_all(&temp_dir);

        // ✅ 恢复后强制执行Lance Compaction，合并备份中的碎片文件
        job_ctx.mark_running(
            BackupJobPhase::Cleanup,
            94.0,
            Some("优化Lance数据库（合并碎片）...".to_string()),
            0,
            0,
        );
        // 旧 RAG 已废弃，跳过 Lance 优化
        info!("[Backup] 跳过恢复后 Lance 优化（旧 RAG 已废弃）");
        job_ctx.mark_running(
            BackupJobPhase::Cleanup,
            96.0,
            Some("跳过 Lance 优化".to_string()),
            0,
            0,
        );

        // MaintenanceGuard 会在作用域结束时自动退出维护模式

        // ★ P0 修复：备份导入后重新初始化数据库连接池
        // 解决问题：导入后选择"稍后重启（继续使用）"时，内存中的数据库连接仍指向旧数据
        job_ctx.mark_running(
            BackupJobPhase::Cleanup,
            98.0,
            Some("刷新数据库连接...".to_string()),
            0,
            0,
        );

        let mut requires_restart = false;

        // 重新初始化 Chat V2 数据库连接
        if let Some(ref chat_v2_db) = ctx.chat_v2_db {
            match chat_v2_db.reinitialize() {
                Ok(()) => {
                    info!("[BackupJob] Chat V2 数据库连接已刷新");
                }
                Err(e) => {
                    warn!(
                        "[BackupJob] Chat V2 数据库连接刷新失败: {}，需要重启应用",
                        e
                    );
                    requires_restart = true;
                }
            }
        }

        // 重新初始化 VFS 数据库连接
        if let Some(ref vfs_db) = ctx.vfs_db {
            match vfs_db.reinitialize() {
                Ok(()) => {
                    info!("[BackupJob] VFS 数据库连接已刷新");
                }
                Err(e) => {
                    warn!("[BackupJob] VFS 数据库连接刷新失败: {}，需要重启应用", e);
                    requires_restart = true;
                }
            }
        }

        let duration = start.elapsed().as_millis() as u64;
        let message = if requires_restart {
            "数据恢复完成，但需要重启应用才能完全生效".to_string()
        } else {
            "数据恢复完成".to_string()
        };

        job_ctx.complete(
            Some(message.clone()),
            metadata.total_files as u64,
            metadata.total_files as u64,
            BackupJobResultPayload {
                success: true,
                output_path: None,
                resolved_path: None,
                message: Some(message),
                error: None,
                duration_ms: Some(duration),
                stats: Some(serde_json::json!({
                    "totalFiles": metadata.total_files,
                    "skippedEntries": extraction_stats.skipped_entries,
                })),
                requires_restart,
                checkpoint_path: None,
                resumable_job_id: None,
            },
        );

        Ok(())
    })();

    if let Err(err) = result {
        error!("[BackupJob] 导入任务失败 job_id={} err={}", job_id, err);
        job_ctx.fail(err.message.clone());
    }
}

/// 对恢复后的 SQLite 数据库执行完整性检查
/// P0 修复: 扩大覆盖面，检查所有关键数据库
fn run_integrity_checks(root: &Path) -> Vec<String> {
    let mut warnings = Vec::new();

    // 辅助函数：检查单个数据库
    fn check_db(path: &Path, name: &str, use_quick: bool) -> Option<String> {
        if !path.exists() {
            return None; // 数据库不存在不算错误（用户可能未使用该功能）
        }
        match rusqlite::Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(conn) => {
                let pragma = if use_quick {
                    "PRAGMA quick_check;"
                } else {
                    "PRAGMA integrity_check;"
                };
                match conn.query_row(pragma, [], |r| r.get::<_, String>(0)) {
                    Ok(val) => {
                        if val.to_lowercase() != "ok" {
                            Some(format!("{} 完整性检查返回: {}", name, val))
                        } else {
                            None
                        }
                    }
                    Err(e) => Some(format!("{} 完整性检查失败: {}", name, e)),
                }
            }
            Err(e) => Some(format!("无法打开 {} 进行检查: {}", name, e)),
        }
    }

    // ========================================================================
    // P0 核心数据库（必须存在）
    // ========================================================================
    let main_db = root.join("mistakes.db");
    if main_db.exists() {
        if let Some(w) = check_db(&main_db, "mistakes.db", false) {
            warnings.push(w);
        }
    } else {
        warnings.push("未找到 mistakes.db（主数据库）".to_string());
    }

    // ========================================================================
    // P0 扩展数据库（存在则检查）
    // ========================================================================
    let databases_to_check = [
        // 根目录数据库
        (root.join("notes.db"), "notes.db"),
        (root.join("research.db"), "research.db"),
        (root.join("template_ai.db"), "template_ai.db"),
        (root.join("essay_grading.db"), "essay_grading.db"),
        (root.join("canvas_boards.db"), "canvas_boards.db"),
        (root.join("message_queue.db"), "message_queue.db"),
        (root.join("resources.db"), "resources.db"),
        (root.join("anki.db"), "anki.db"),
        (root.join("vfs.db"), "vfs.db"),
        // databases/ 子目录数据库
        (root.join("databases/chat_v2.db"), "databases/chat_v2.db"),
        (root.join("databases/notes.db"), "databases/notes.db"),
        (
            root.join("databases/textbooks.db"),
            "databases/textbooks.db",
        ),
        (root.join("databases/main.db"), "databases/main.db"),
    ];

    for (path, name) in databases_to_check {
        if let Some(w) = check_db(&path, name, false) {
            warnings.push(w);
        }
    }

    // ========================================================================
    // 检查 canvas_boards.db（可能在子目录中）
    // ========================================================================
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_map(log_and_skip_walkdir_err)
    {
        let p = entry.path();
        if p.is_file() && p.file_name() == Some(std::ffi::OsStr::new("canvas_boards.db")) {
            // 跳过根目录的（已经检查过）
            if p.parent() != Some(root) {
                if let Some(w) = check_db(p, &p.display().to_string(), true) {
                    warnings.push(w);
                }
            }
        }
    }

    // ========================================================================
    // P0 修复: 检查 Lance 向量数据库完整性
    // ========================================================================
    let lance_dirs = [
        ("lance/vfs", "VFS 向量库"),
        ("lance/rag", "RAG 向量库"),
        ("lance/notes", "笔记向量库"),
        ("lance/memory", "记忆向量库"),
    ];

    for (lance_dir, name) in lance_dirs {
        let lance_path = root.join(lance_dir);
        if lance_path.exists() && lance_path.is_dir() {
            // 检查 Lance 目录结构完整性
            let has_data_dir = lance_path.join("data").exists();
            let has_manifest = WalkDir::new(&lance_path)
                .max_depth(2)
                .into_iter()
                .filter_map(log_and_skip_walkdir_err)
                .any(|e| e.file_name().to_string_lossy().ends_with(".manifest"));

            if !has_data_dir && !has_manifest {
                warnings.push(format!(
                    "{} ({}) 目录结构不完整，可能需要重建索引",
                    name, lance_dir
                ));
            } else {
                // 检查是否有损坏的文件（.lance 文件应该可读）
                let mut lance_file_count = 0;
                let mut readable_count = 0;
                for entry in WalkDir::new(&lance_path)
                    .max_depth(3)
                    .into_iter()
                    .filter_map(log_and_skip_walkdir_err)
                {
                    let p = entry.path();
                    if p.is_file() && p.extension().map_or(false, |ext| ext == "lance") {
                        lance_file_count += 1;
                        if std::fs::File::open(p).is_ok() {
                            readable_count += 1;
                        }
                    }
                }

                if lance_file_count > 0 && readable_count < lance_file_count {
                    warnings.push(format!(
                        "{} ({}) 有 {} 个文件无法读取（共 {} 个）",
                        name,
                        lance_dir,
                        lance_file_count - readable_count,
                        lance_file_count
                    ));
                }
            }
        }
    }

    warnings
}

/// 运行数据库完整性检查（手动）
///
/// **Deprecated**: 请使用数据治理系统 `data_governance_run_health_check` 代替。
/// 此命令将在未来版本中移除。
#[deprecated(note = "请使用 data_governance_run_health_check 代替，此命令将在未来版本中移除")]
#[tauri::command]
pub async fn run_data_integrity_check(state: State<'_, AppState>) -> Result<String> {
    let root = app_data_root(&state);
    let warnings = run_integrity_checks(&root);
    if warnings.is_empty() {
        Ok("✅ 完整性检查通过".to_string())
    } else {
        let mut msg = format!("⚠️ 完整性检查发现 {} 项警告:\n", warnings.len());
        for w in warnings {
            msg.push_str(&format!("- {}\n", w));
        }
        Ok(msg)
    }
}

/// 验证ZIP文件中的元数据
fn validate_zip_metadata(
    zip_path: &Path,
    job: Option<&BackupJobContext>,
    window: Option<&Window>,
) -> Result<BackupMetadata> {
    let _ = emit_progress(
        job,
        window,
        ImportProgress {
            phase: "validation".to_string(),
            progress: 0.0,
            message: "验证备份文件".to_string(),
            current_file: None,
            total_files: 0,
            processed_files: 0,
        },
    );

    info!("[Backup] 验证备份文件: {:?}", zip_path);

    // ========================================================================
    // P0 安全检查: ZIP 炸弹防护
    // ========================================================================
    info!("[Backup] 执行 ZIP 安全检查...");
    let security_check = check_zip_security(zip_path)?;
    security_check.validate()?;
    info!(
        "ZIP 安全检查通过: {} 个文件, {:.2} MB 解压后大小, 压缩比 {:.1}:1",
        security_check.file_count,
        security_check.total_uncompressed_size as f64 / 1024.0 / 1024.0,
        security_check.compression_ratio
    );

    let file = File::open(zip_path)
        .map_err(|e| AppError::file_system(format!("打开备份文件失败: {}", e)))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AppError::file_system(format!("解析ZIP文件失败: {}", e)))?;
    let total_entries = zip.len();
    let has_metadata = zip.by_name(METADATA_FILE).is_ok();

    let mut actual_total_size = 0u64;
    let mut image_count = 0usize;
    let mut db_exists = false;
    let mut file_list: Vec<(String, u64)> = Vec::with_capacity(total_entries as usize);

    for i in 0..total_entries {
        if let Ok(file) = zip.by_index(i) {
            let name = file.name().to_string();
            let size = file.size();
            actual_total_size += size;
            file_list.push((name.clone(), size));

            if name.contains("images/")
                && (name.ends_with(".png") || name.ends_with(".jpg") || name.ends_with(".jpeg"))
            {
                image_count += 1;
            }
            if name.ends_with("mistakes.db") {
                db_exists = true;
            }
        }
    }

    debug!(
        "[Backup] ZIP统计: files={} total_size={} image_files={} db_exists={}",
        total_entries, actual_total_size, image_count, db_exists
    );

    let mut metadata = if has_metadata {
        match zip.by_name(METADATA_FILE) {
            Ok(mut metadata_file) => {
                let mut content = String::new();
                metadata_file
                    .read_to_string(&mut content)
                    .map_err(|e| AppError::file_system(format!("读取元数据失败: {}", e)))?;
                debug!("[Backup] 读取元数据文件成功，长度 {} 字符", content.len());
                serde_json::from_str::<BackupMetadata>(&content)
                    .map_err(|e| AppError::validation(format!("元数据格式错误: {}", e)))?
            }
            Err(_) => {
                return Err(AppError::internal("元数据文件存在但无法读取".to_string()));
            }
        }
    } else {
        warn!("[Backup] 备份文件缺少元数据，使用兼容模式 (旧版本备份)");
        let _ = emit_progress(
            job,
            window,
            ImportProgress {
                phase: "warning".to_string(),
                progress: 40.0,
                message: "检测到旧版本备份，导入后请立即创建新备份".to_string(),
                current_file: None,
                total_files: total_entries as usize,
                processed_files: 0,
            },
        );

        BackupMetadata {
            version: "1.0".to_string(),
            app_version: "unknown".to_string(),
            created_at: "unknown".to_string(),
            platform: "unknown".to_string(),
            total_files: total_entries,
            total_size: actual_total_size,
            file_checksums: HashMap::new(), // 旧版本备份无校验和
            statistics: BackupStatistics {
                images_count: image_count,
                ..BackupStatistics::default()
            },
            warnings: Vec::new(),
            backup_tiers: None,
        }
    };

    if metadata.total_size == 0 {
        metadata.total_size = actual_total_size;
    }

    let verbose = std::env::var("BACKUP_VERBOSE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if verbose {
        debug!("[Backup] ZIP 文件完整列表 (verbose 模式)");
        for (name, size) in &file_list {
            debug!("  • {} ({} bytes)", name, size);
        }
    } else if !file_list.is_empty() {
        let head = file_list.iter().take(3);
        let tail = file_list.iter().rev().take(3);
        debug!("[Backup] ZIP 文件列表预览:");
        for (name, size) in head {
            debug!("  • {} ({} bytes)", name, size);
        }
        if file_list.len() > 6 {
            debug!("  • ... 共 {} 个条目 ...", file_list.len());
        }
        for (name, size) in tail.rev() {
            debug!("  • {} ({} bytes)", name, size);
        }
    }

    let _ = emit_progress(
        job,
        window,
        ImportProgress {
            phase: "validation".to_string(),
            progress: 100.0,
            message: "备份验证完成".to_string(),
            current_file: None,
            total_files: metadata.total_files,
            processed_files: metadata.total_files,
        },
    );

    Ok(metadata)
}

/// 解压备份文件到临时目录
///
/// # 安全特性
/// - 实时大小监控：防止 ZIP 炸弹攻击
/// - ZipSlip 防护：防止路径遍历攻击
/// - 符号链接检测：跳过可能的符号链接条目
fn extract_to_temp_dir(
    zip_path: &Path,
    temp_dir: &Path,
    metadata: &BackupMetadata,
    job: Option<&BackupJobContext>,
    best_effort: bool,
    maintenance_guard: Option<&MaintenanceGuard>,
) -> Result<ExtractionStats> {
    use crate::backup_common::MAX_UNCOMPRESSED_SIZE;

    fs::create_dir_all(temp_dir)
        .map_err(|e| AppError::file_system(format!("创建临时目录失败: {}", e)))?;

    let file = File::open(zip_path)
        .map_err(|e| AppError::file_system(format!("打开备份文件失败: {}", e)))?;
    let mut zip = zip::ZipArchive::new(file)
        .map_err(|e| AppError::file_system(format!("解析ZIP文件失败: {}", e)))?;

    let total_files = zip.len();
    info!("[Backup] 解压备份，总条目 {}", total_files);

    // P0 安全修复: 实时大小监控，防止 ZIP 炸弹绕过预检查
    let mut total_bytes_extracted: u64 = 0;

    let verbose = std::env::var("BACKUP_VERBOSE")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);
    if verbose {
        debug!("[Backup] ZIP 文件条目列表:");
        for i in 0..total_files {
            if let Ok(file) = zip.by_index(i) {
                debug!("  [{}] {}", i, file.name());
            }
        }
    }

    let mut stats = ExtractionStats::default();

    for i in 0..total_files {
        // P0 修复: 定期检查维护模式是否超时，防止无限期占用
        if let Some(guard) = maintenance_guard {
            if guard.is_timed_out() {
                error!(
                    "[extract_to_temp_dir] 维护模式超时（已持续 {} 秒，限制 {} 秒），中止解压（已处理 {}/{} 个条目）",
                    guard.elapsed_secs(),
                    guard.timeout_secs,
                    i,
                    total_files
                );
                // 清理已解压的文件
                let _ = fs::remove_dir_all(temp_dir);
                return Err(AppError::operation_failed(format!(
                    "备份解压超时：维护模式已持续 {} 秒超过 {} 秒限制，已处理 {}/{} 个条目。请减少备份范围或增加超时时间后重试",
                    guard.elapsed_secs(),
                    guard.timeout_secs,
                    i,
                    total_files
                )));
            }
        }

        let mut file = zip
            .by_index(i)
            .map_err(|e| AppError::file_system(format!("读取ZIP条目失败: {}", e)))?;

        let file_name = file.name().to_string();

        // 跳过元数据文件，它已经被读取过了
        if file_name == METADATA_FILE {
            debug!("[Backup] 跳过元数据文件: {}", file_name);
            continue;
        }

        // ====================================================================
        // P0/P1 安全修复: 增强 ZipSlip 防护（跨平台符号链接检测）
        // ====================================================================

        // Unix 符号链接检测
        #[cfg(unix)]
        {
            if let Some(mode) = file.unix_mode() {
                const S_IFLNK: u32 = 0o120000;
                if mode & 0o170000 == S_IFLNK {
                    warn!(
                        "[Backup] 安全警告: 跳过 ZIP 中的符号链接条目 (Unix): {}",
                        file_name
                    );
                    stats.record_skip(file_name.clone(), "符号链接条目已跳过 (Unix)");
                    continue;
                }
            }
        }

        // P1 安全修复: Windows 符号链接检测
        // 跨平台检测：即使在 Windows 上也检查 Unix 模式（ZIP 可能由 Unix 工具创建）
        #[cfg(windows)]
        {
            // 检查 Unix 模式
            if let Some(mode) = file.unix_mode() {
                const S_IFLNK: u32 = 0o120000;
                if mode & 0o170000 == S_IFLNK {
                    warn!(
                        "[Backup] 安全警告: 跳过 ZIP 中的符号链接条目 (Unix mode on Windows): {}",
                        file_name
                    );
                    stats.record_skip(file_name.clone(), "符号链接条目已跳过 (Unix mode)");
                    continue;
                }
            }

            // 启发式检测：跳过 Windows 快捷方式 (.lnk) 文件
            // 注意：.lnk 是 Shell 快捷方式，不是真正的 NTFS 符号链接
            // 但它们可能指向敏感位置，出于安全考虑跳过
            let name_lower = file_name.to_lowercase();
            if name_lower.ends_with(".lnk") {
                warn!(
                    "[Backup] 安全警告: 跳过 ZIP 中的 Windows 快捷方式: {}",
                    file_name
                );
                stats.record_skip(file_name.clone(), "Windows 快捷方式已跳过");
                continue;
            }
        }

        // 安全处理路径：
        // 1. 检查绝对路径和危险组件
        // 2. 只保留 Normal 组件
        // 3. 验证最终路径在目标目录内
        let mut rel = std::path::PathBuf::new();
        let mut has_dangerous_component = false;
        for comp in std::path::Path::new(&file_name).components() {
            match comp {
                std::path::Component::Normal(c) => rel.push(c),
                std::path::Component::RootDir | std::path::Component::Prefix(_) => {
                    // 绝对路径检测 - 严重安全风险
                    warn!("[Backup] 安全警告: ZIP 包含绝对路径: {}", file_name);
                    has_dangerous_component = true;
                    break;
                }
                std::path::Component::ParentDir => {
                    // .. 路径遍历尝试
                    warn!(
                        "[Backup] 安全警告: ZIP 包含路径遍历尝试 (..): {}",
                        file_name
                    );
                    // 不 break，继续处理后续组件（已跳过此组件）
                }
                std::path::Component::CurDir => {
                    // . 组件，忽略
                }
            }
        }

        if has_dangerous_component {
            let msg = format!("跳过危险路径: {}", file_name);
            stats.record_skip(file_name.clone(), &msg);
            continue;
        }

        let out_path = temp_dir.join(&rel);

        // 最终安全验证: 确保路径仍在目标目录内
        let canonical_temp = temp_dir
            .canonicalize()
            .unwrap_or_else(|_| temp_dir.to_path_buf());
        if let Ok(canonical_out) = out_path.canonicalize() {
            if !canonical_out.starts_with(&canonical_temp) {
                let msg = format!("路径遍历攻击检测: {} -> {:?}", file_name, canonical_out);
                error!("{}", msg);
                stats.record_skip(file_name.clone(), &msg);
                continue;
            }
        }
        // 注: 如果 out_path 不存在，canonicalize 会失败，此时检查父目录
        else if let Some(parent) = out_path.parent() {
            if let Ok(canonical_parent) = parent.canonicalize() {
                if !canonical_parent.starts_with(&canonical_temp) {
                    let msg = format!(
                        "路径遍历攻击检测(父目录): {} -> {:?}",
                        file_name, canonical_parent
                    );
                    error!("{}", msg);
                    stats.record_skip(file_name.clone(), &msg);
                    continue;
                }
            }
        }

        debug!("[Backup] 解压: {} -> {:?}", file_name, out_path);

        let _ = emit_progress(
            job,
            None,
            ImportProgress {
                phase: "extraction".to_string(),
                progress: ((i + 1) as f32 / total_files as f32) * 100.0,
                message: format!("解压文件 {}/{}", i + 1, total_files),
                current_file: Some(file_name.clone()),
                total_files: metadata.total_files,
                processed_files: i + 1,
            },
        );

        if file_name.ends_with('/') {
            if let Err(e) = fs::create_dir_all(&out_path) {
                let msg = format!("创建目录失败 {:?}: {}", out_path, e);
                if best_effort {
                    stats.record_skip(file_name.clone(), &msg);
                    continue;
                }
                return Err(AppError::file_system(msg));
            }
            continue;
        }

        if let Some(p) = out_path.parent() {
            if let Err(e) = fs::create_dir_all(p) {
                let msg = format!("创建父目录失败 {:?}: {}", p, e);
                if best_effort {
                    stats.record_skip(file_name.clone(), &msg);
                    continue;
                }
                return Err(AppError::file_system(msg));
            }
        }

        let mut outfile = match File::create(&out_path) {
            Ok(f) => f,
            Err(e) => {
                let msg = format!("创建文件失败 {:?}: {}", out_path, e);
                if best_effort {
                    stats.record_skip(file_name.clone(), &msg);
                    continue;
                }
                return Err(AppError::file_system(msg));
            }
        };
        let bytes_written = match std::io::copy(&mut file, &mut outfile) {
            Ok(written) => written,
            Err(e) => {
                let msg = format!("写入文件失败 {:?}: {}", out_path, e);
                if best_effort {
                    stats.record_skip(file_name.clone(), &msg);
                    continue;
                }
                return Err(AppError::file_system(msg));
            }
        };

        // P0 安全修复: 实时大小监控
        total_bytes_extracted += bytes_written;
        if total_bytes_extracted > MAX_UNCOMPRESSED_SIZE {
            // 清理已解压的文件
            let _ = fs::remove_dir_all(temp_dir);
            return Err(AppError::validation(format!(
                "ZIP 炸弹检测：解压总大小 {} 超过限制 {} (10GB)，已中止并清理",
                total_bytes_extracted, MAX_UNCOMPRESSED_SIZE
            )));
        }

        debug!(
            "写入 {} 字节 (累计 {} 字节)",
            bytes_written, total_bytes_extracted
        );

        // 验证文件校验和（如果元数据中有记录）
        if let Some(expected_hash) = metadata.file_checksums.get(&file_name) {
            match calculate_file_hash(&out_path) {
                Ok(actual_hash) => {
                    if &actual_hash != expected_hash {
                        let msg = format!(
                            "文件 {} 校验和不匹配: 期望 {}, 实际 {}",
                            file_name, expected_hash, actual_hash
                        );
                        if best_effort {
                            warn!("{}", msg);
                            stats.record_skip(file_name.clone(), &msg);
                            // 删除损坏的文件
                            let _ = fs::remove_file(&out_path);
                            continue;
                        }
                        return Err(AppError::validation(msg));
                    }
                    debug!("[Backup] 校验和验证通过: {}", file_name);
                }
                Err(e) => {
                    let msg = format!("计算校验和失败 {}: {}", file_name, e);
                    if best_effort {
                        warn!("{}", msg);
                        stats.record_skip(file_name.clone(), &msg);
                        continue;
                    }
                    return Err(e);
                }
            }
        }
    }

    debug!("[Backup] 验证解压结果");
    fn list_files(dir: &Path, prefix: &Path) -> std::io::Result<()> {
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();
            if path.is_file() {
                let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
                debug!(
                    "  解压完成: {:?} ({} bytes)",
                    path.strip_prefix(prefix).unwrap_or(&path),
                    size
                );
            } else if path.is_dir() {
                list_files(&path, prefix)?;
            }
        }
        Ok(())
    }
    let _ = list_files(temp_dir, temp_dir);

    Ok(stats)
}

// ============================================================================
// 回滚与恢复后完整性验证
// ============================================================================

/// 执行完整的回滚操作，带有详细日志、完整性检查和用户建议
///
/// # 回滚流程
/// 1. 清理 root 中当前（可能不完整的）数据
/// 2. 从 pre_backup_dir 复制回原始数据
/// 3. 记录每个被回滚的文件
/// 4. 回滚后执行数据完整性检查
/// 5. 输出用户可操作的建议
fn perform_rollback(root: &Path, pre_backup_dir: &Path, temp_dir: &Path) -> Result<()> {
    info!(
        "[Rollback] 开始回滚操作: 从 {:?} 恢复数据到 {:?}",
        pre_backup_dir, root
    );

    // Step 1: 清理 root 中当前的残留数据
    let mut cleaned_count = 0usize;
    for entry in fs::read_dir(root).map_err(|e| AppError::file_system(e.to_string()))? {
        let entry = entry.map_err(|e| AppError::file_system(e.to_string()))?;
        let path = entry.path();
        if path.file_name().map_or(false, |n| n == BACKUPS_DIR_NAME)
            || path.file_name().map_or(false, |n| n == TEMP_RESTORE_DIR)
            || path
                .file_name()
                .map_or(false, |n| n == MIGRATION_CORE_BACKUPS_DIR)
        {
            continue;
        }
        if path.is_file() {
            let _ = resilient_remove_file(&path);
            cleaned_count += 1;
        } else {
            let _ = resilient_remove_dir_all(&path);
            cleaned_count += 1;
        }
    }
    info!("[Rollback] 已清理 {} 个顶级文件/目录", cleaned_count);

    // Step 2: 从 pre_backup_dir 复制数据回来，记录每个文件
    let mut rolled_back_files = 0usize;
    let mut rolled_back_dirs = 0usize;
    let mut rolled_back_db_files: Vec<String> = Vec::new();

    fn copy_back_with_log(
        src_dir: &Path,
        dst_dir: &Path,
        files_count: &mut usize,
        dirs_count: &mut usize,
        db_files: &mut Vec<String>,
        depth: usize,
    ) -> std::io::Result<()> {
        for entry in fs::read_dir(src_dir)? {
            let entry = entry?;
            let src = entry.path();
            let dst = dst_dir.join(entry.file_name());

            // 安全检查: 跳过符号链接
            if is_symlink(&src) {
                warn!("[Rollback] 跳过符号链接: {:?}", src);
                continue;
            }

            if src.is_file() {
                resilient_copy_file(&src, &dst)?;
                *files_count += 1;

                // 记录数据库文件
                if let Some(ext) = src.extension() {
                    if ext == "db" {
                        let name = entry.file_name().to_string_lossy().to_string();
                        db_files.push(name.clone());
                        info!("[Rollback] 已回滚数据库文件: {:?}", src);
                    }
                }

                // 前两层的文件都记录日志
                if depth < 2 {
                    debug!("[Rollback] 已回滚文件: {:?}", entry.file_name());
                }
            } else if src.is_dir() {
                fs::create_dir_all(&dst)?;
                *dirs_count += 1;
                copy_back_with_log(&src, &dst, files_count, dirs_count, db_files, depth + 1)?;
            }
        }
        Ok(())
    }

    // 尝试回滚
    if let Err(rollback_err) = copy_back_with_log(
        pre_backup_dir,
        root,
        &mut rolled_back_files,
        &mut rolled_back_dirs,
        &mut rolled_back_db_files,
        0,
    ) {
        error!(
            "[Rollback] 回滚失败: {}。已回滚 {} 个文件、{} 个目录",
            rollback_err, rolled_back_files, rolled_back_dirs
        );
        // 清理临时目录
        let _ = resilient_remove_dir_all(temp_dir);

        error!(
            "[Rollback] ⚠️ 数据可能处于不一致状态！\n\
             用户建议:\n\
             1. 恢复前的数据备份保存在: {}\n\
             2. 可以手动将该目录中的文件复制回应用数据目录\n\
             3. 如果无法手动恢复，请尝试使用其他备份文件重新导入\n\
             4. 联系技术支持并提供日志文件以获取帮助",
            pre_backup_dir.display()
        );

        return Err(AppError::file_system(format!(
            "导入失败且回滚也失败！回滚错误: {}。\n\
             数据可能处于不一致状态，请检查 {} 目录手动恢复。",
            rollback_err,
            pre_backup_dir.display()
        )));
    }

    // Step 3: 回滚后完整性检查
    info!(
        "[Rollback] 回滚复制完成: {} 个文件, {} 个目录 (其中 {} 个数据库文件)",
        rolled_back_files,
        rolled_back_dirs,
        rolled_back_db_files.len()
    );

    let post_rollback_warnings = run_integrity_checks(root);
    if post_rollback_warnings.is_empty() {
        info!("[Rollback] ✅ 回滚后数据完整性检查通过");
    } else {
        warn!(
            "[Rollback] ⚠️ 回滚后数据完整性检查发现 {} 项警告:",
            post_rollback_warnings.len()
        );
        for w in &post_rollback_warnings {
            warn!("[Rollback]   - {}", w);
        }
    }

    // Step 4: 输出用户建议
    info!(
        "[Rollback] 回滚成功，数据已恢复到导入前状态。\n\
         用户提示:\n\
         - 恢复前的数据备份保存在: {}\n\
         - 此备份目录可用于手动恢复或问题排查\n\
         - 已回滚的数据库文件: {:?}",
        pre_backup_dir.display(),
        rolled_back_db_files
    );

    // 清理临时目录
    let _ = resilient_remove_dir_all(temp_dir);

    Ok(())
}

/// 恢复后对所有 SQLite 数据库执行 PRAGMA integrity_check
///
/// 返回失败的数据库列表（名称+错误详情）。
/// 空列表表示所有数据库完整性校验通过。
fn run_post_restore_integrity_check(root: &Path) -> Vec<String> {
    let mut failures = Vec::new();

    // 收集所有需要检查的数据库文件（.db, .sqlite, .sqlite3）
    let db_files = collect_db_files(root, root, true);

    info!(
        "[PostRestoreVerify] 开始对 {} 个数据库执行 PRAGMA integrity_check",
        db_files.len()
    );

    for db_rel in &db_files {
        let db_path = root.join(db_rel);
        if !db_path.exists() {
            continue;
        }

        let db_name = db_rel.display().to_string();

        match rusqlite::Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY) {
            Ok(conn) => {
                match conn.query_row("PRAGMA integrity_check;", [], |r| r.get::<_, String>(0)) {
                    Ok(val) => {
                        if val.to_lowercase() != "ok" {
                            let msg = format!("{}: integrity_check 返回异常 - {}", db_name, val);
                            error!("[PostRestoreVerify] {}", msg);
                            failures.push(msg);
                        } else {
                            debug!("[PostRestoreVerify] ✅ {} integrity_check 通过", db_name);
                        }
                    }
                    Err(e) => {
                        let msg = format!("{}: integrity_check 执行失败 - {}", db_name, e);
                        error!("[PostRestoreVerify] {}", msg);
                        failures.push(msg);
                    }
                }
            }
            Err(e) => {
                let msg = format!("{}: 无法打开数据库进行完整性检查 - {}", db_name, e);
                error!("[PostRestoreVerify] {}", msg);
                failures.push(msg);
            }
        }
    }

    if failures.is_empty() {
        info!(
            "[PostRestoreVerify] ✅ 所有 {} 个数据库 PRAGMA integrity_check 通过",
            db_files.len()
        );
    }

    failures
}

/// 递归统计目录下的文件数量（跳过符号链接、backups、temp_restore）
fn count_files_recursive(dir: &Path, skip_backup_dirs: bool) -> usize {
    let mut count = 0usize;
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return 0,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let file_name = entry.file_name();
        if skip_backup_dirs
            && (file_name == BACKUPS_DIR_NAME
                || file_name == TEMP_RESTORE_DIR
                || file_name == MIGRATION_CORE_BACKUPS_DIR)
        {
            continue;
        }
        if is_symlink(&path) {
            continue;
        }
        if path.is_file() {
            count += 1;
        } else if path.is_dir() {
            count += count_files_recursive(&path, false);
        }
    }
    count
}

/// 收集目录下所有数据库文件的相对路径
///
/// 匹配扩展名: .db, .sqlite, .sqlite3
/// 与 data_space.rs 的 verify_slot_integrity 保持一致
fn collect_db_files(dir: &Path, base: &Path, skip_backup_dirs: bool) -> Vec<PathBuf> {
    /// 数据库文件扩展名白名单（与 data_space::verify_slot_integrity 一致）
    const DB_EXTENSIONS: &[&str] = &["db", "sqlite", "sqlite3"];

    let mut result = Vec::new();
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return result,
    };
    for entry in entries.filter_map(|e| e.ok()) {
        let path = entry.path();
        let file_name = entry.file_name();
        if skip_backup_dirs
            && (file_name == BACKUPS_DIR_NAME
                || file_name == TEMP_RESTORE_DIR
                || file_name == MIGRATION_CORE_BACKUPS_DIR)
        {
            continue;
        }
        if is_symlink(&path) {
            continue;
        }
        if path.is_file() {
            if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
                if DB_EXTENSIONS.contains(&ext) {
                    if let Ok(rel) = path.strip_prefix(base) {
                        result.push(rel.to_path_buf());
                    }
                }
            }
        } else if path.is_dir() {
            result.extend(collect_db_files(&path, base, false));
        }
    }
    result
}

/// pre_restore 备份完整性验证结果
struct PreRestoreVerification {
    /// 源目录文件总数
    source_file_count: usize,
    /// 备份目录文件总数
    backup_file_count: usize,
    /// 缺失的数据库文件列表
    missing_db_files: Vec<PathBuf>,
    /// 差异百分比
    difference_pct: f64,
}

/// 验证 pre_restore 备份的完整性
///
/// 对比源目录和备份目录的文件数量，检查关键 *.db 文件是否都被正确复制。
/// 差异超过 5% 时记录警告但不阻止恢复流程。
fn verify_pre_restore_backup(source_root: &Path, backup_dir: &Path) -> PreRestoreVerification {
    let source_count = count_files_recursive(source_root, true);
    let backup_count = count_files_recursive(backup_dir, false);

    let difference_pct = if source_count > 0 {
        ((source_count as f64 - backup_count as f64).abs() / source_count as f64) * 100.0
    } else {
        0.0
    };

    // 收集源目录中的所有 .db 文件
    let source_dbs = collect_db_files(source_root, source_root, true);
    let mut missing_dbs = Vec::new();

    for db_rel in &source_dbs {
        let backup_db = backup_dir.join(db_rel);
        if !backup_db.exists() {
            missing_dbs.push(db_rel.clone());
        } else {
            // 验证文件大小不为 0（可能是复制中断）
            if let Ok(meta) = fs::metadata(&backup_db) {
                if meta.len() == 0 {
                    warn!("[PreRestoreVerify] 数据库备份文件为空: {:?}", db_rel);
                    missing_dbs.push(db_rel.clone());
                }
            }
        }
    }

    // 记录详细验证日志
    info!(
        "[PreRestoreVerify] 文件数量对比: 源={}, 备份={}, 差异={:.1}%",
        source_count, backup_count, difference_pct
    );

    if difference_pct > 5.0 {
        warn!(
            "[PreRestoreVerify] ⚠️ pre_restore 备份文件数量差异超过 5% 阈值 ({:.1}%)! \
             源目录 {} 个文件, 备份目录 {} 个文件。\
             回滚时数据可能不完整，但恢复操作将继续。",
            difference_pct, source_count, backup_count
        );
    }

    if !missing_dbs.is_empty() {
        warn!(
            "[PreRestoreVerify] ⚠️ 以下关键数据库文件未被正确备份: {:?}",
            missing_dbs
        );
    } else {
        info!(
            "[PreRestoreVerify] ✅ 所有 {} 个数据库文件已正确备份",
            source_dbs.len()
        );
    }

    PreRestoreVerification {
        source_file_count: source_count,
        backup_file_count: backup_count,
        missing_db_files: missing_dbs,
        difference_pct,
    }
}

/// 拷贝当前 app_data 目录至备份目录 (pre-restore)
fn backup_current_data(root: &Path, backups_dir: &Path) -> Result<PathBuf> {
    let ts = Utc::now().format("%Y%m%d-%H%M%S");
    let dst = backups_dir.join(format!("pre-restore-{}", ts));

    info!("[Backup] 备份源目录: {:?}", root);
    info!("[Backup] 备份目标目录: {:?}", dst);

    // 创建目标目录
    fs::create_dir_all(&dst)
        .map_err(|e| AppError::file_system(format!("创建备份目录失败: {}", e)))?;

    // 逐个复制文件和目录，但跳过backups目录
    for entry in
        fs::read_dir(root).map_err(|e| AppError::file_system(format!("读取源目录失败: {}", e)))?
    {
        let entry = entry.map_err(|e| AppError::file_system(format!("读取目录项失败: {}", e)))?;
        let path = entry.path();
        let file_name = entry.file_name();

        // 跳过backups目录和临时目录
        if file_name == BACKUPS_DIR_NAME
            || file_name == TEMP_RESTORE_DIR
            || file_name == MIGRATION_CORE_BACKUPS_DIR
        {
            debug!("[Backup] 跳过目录: {:?}", file_name);
            continue;
        }

        let dst_path = dst.join(&file_name);

        // P1 安全修复: 跳过符号链接，防止跟随符号链接复制敏感数据
        if is_symlink(&path) {
            warn!("[Backup] 跳过符号链接 (安全防护): {:?}", path);
            continue;
        }

        if path.is_file() {
            resilient_copy_file(&path, &dst_path)
                .map_err(|e| AppError::file_system(format!("复制文件失败 {:?}: {}", path, e)))?;
        } else if path.is_dir() {
            // P1 安全修复: 使用安全的目录复制函数，在每个层级检查符号链接
            // 替代 fs_extra::dir::copy，避免跟随目录内部的符号链接
            copy_directory_safe(&path, &dst)?;
        }
    }

    // ========================================================================
    // P1 强化: 验证 pre_restore 备份完整性
    // ========================================================================
    let verification = verify_pre_restore_backup(root, &dst);

    if !verification.missing_db_files.is_empty() {
        // 核心数据库列表：缺失任一则拒绝继续恢复
        const CRITICAL_DBS: &[&str] = &["mistakes.db", "chat_v2.db", "vfs.db"];

        let missing_critical: Vec<&PathBuf> = verification
            .missing_db_files
            .iter()
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .map(|n| CRITICAL_DBS.contains(&n))
                    .unwrap_or(false)
            })
            .collect();

        if !missing_critical.is_empty() {
            error!(
                "[BackupImport] pre_restore 备份缺失核心数据库文件，拒绝继续恢复。\
                 缺失核心数据库: {:?}。备份目录: {:?}",
                missing_critical, dst
            );
            return Err(AppError::validation(format!(
                "pre_restore 安全备份失败：核心数据库 {:?} 未被正确备份，\
                 恢复操作已中止以保护数据安全。请检查磁盘空间后重试。",
                missing_critical
            )));
        }

        // 非核心数据库缺失：降级为警告，继续恢复
        warn!(
            "[BackupImport] pre_restore 备份缺失 {} 个非核心数据库文件，回滚数据可能不完整。\
             缺失列表: {:?}。备份目录: {:?}",
            verification.missing_db_files.len(),
            verification.missing_db_files,
            dst
        );
    }

    Ok(dst)
}

// 旧备份导出/预检 Tauri 命令已移除；统一使用 data_governance_* 命令链路。

async fn start_import_job(
    state: State<'_, AppState>,
    backup_job_state: State<'_, BackupJobManagerState>,
    window: Window,
    archive_path: PathBuf,
    materialized_guard: Option<MaterializedPath>,
    options: ImportOptions,
) -> Result<String> {
    // P2 修复: 避免使用 expect，改用 map_err 转换错误
    let permit = BACKUP_GLOBAL_LIMITER
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| AppError::internal("备份信号量已关闭".to_string()))?;

    let job_manager = backup_job_state.get();
    let job_ctx = job_manager.create_job(BackupJobKind::Import);
    let job_id = job_ctx.job_id.clone();

    // 获取 Chat V2 和 VFS 数据库引用（用于导入后重新初始化连接）
    let app_handle = window.app_handle();
    let chat_v2_db: Option<Arc<crate::chat_v2::ChatV2Database>> = app_handle
        .try_state::<Arc<crate::chat_v2::ChatV2Database>>()
        .map(|s| s.inner().clone());
    let vfs_db: Option<Arc<crate::vfs::VfsDatabase>> = app_handle
        .try_state::<Arc<crate::vfs::VfsDatabase>>()
        .map(|s| s.inner().clone());

    // 支持 slot_override 用于测试
    let ctx = if options.slot_override.is_some() {
        BackupExecutionContext::from_state_with_slot_override(
            &state,
            &window,
            options.slot_override.clone(),
        )?
        .with_chat_v2_db(chat_v2_db)
        .with_vfs_db(vfs_db)
    } else {
        BackupExecutionContext::from_state(&state, &window)
            .with_chat_v2_db(chat_v2_db)
            .with_vfs_db(vfs_db)
    };
    let archive_buf = fs::canonicalize(&archive_path).unwrap_or_else(|_| archive_path.clone());

    info!(
        "[BackupJob] 导入任务启动 job_id={} path={:?}",
        job_id, archive_buf
    );

    let opts_clone = options.clone();
    let job_clone = job_ctx.clone();
    let _job_id_clone = job_id.clone();
    let guard_to_move = materialized_guard;

    let job_id_for_log = job_id.clone();
    tauri::async_runtime::spawn(async move {
        let _permit = permit;
        let ctx_clone = ctx.clone();
        if let Err(join_err) = tokio::task::spawn_blocking(move || {
            let _guard = guard_to_move;
            run_import_job(ctx_clone, archive_buf, opts_clone, job_clone);
        })
        .await
        {
            error!(
                "[BackupJob] 导入任务线程异常 job_id={} err={}",
                job_id_for_log, join_err
            );
        }
    });

    Ok(job_id)
}

pub(crate) fn materialize_backup_path(
    window: &Window,
    raw_path: &str,
    state: &State<'_, AppState>,
) -> Result<MaterializedPath> {
    let root = app_data_root(state);
    let temp_dir = root.join(TEMP_REMOTE_UPLOAD_DIR);
    unified_file_manager::ensure_local_path(window, raw_path, &temp_dir)
}

// 旧 ZIP 导入 Tauri 命令已移除；统一使用 data_governance_import_zip。

/// 获取指定备份文件的元数据信息
///
/// **Deprecated**: 请使用数据治理系统 `data_governance_verify_backup` 代替。
/// 此命令将在未来版本中移除。
#[deprecated(note = "请使用 data_governance_verify_backup 代替，此命令将在未来版本中移除")]
#[tauri::command]
pub async fn get_backup_info(
    archive_path: String,
    state: State<'_, AppState>,
    window: Window,
) -> Result<BackupMetadata> {
    let archive_guard = materialize_backup_path(&window, archive_path.as_str(), &state)?;
    let archive_path = archive_guard.path().to_path_buf();

    if !archive_path.exists() {
        return Err(AppError::not_found("备份文件不存在".to_string()));
    }

    validate_zip_metadata(&archive_path, None, None)
}

pub(crate) async fn perform_auto_backup_export(
    database: Arc<Database>,
    database_manager: Arc<DatabaseManager>,
    file_manager: Arc<FileManager>,
    backup_dir: PathBuf,
    options: ExportOptions,
) -> Result<PathBuf> {
    let _permit = BACKUP_GLOBAL_LIMITER
        .clone()
        .acquire_owned()
        .await
        .map_err(|_| AppError::internal("备份信号量已关闭".to_string()))?;

    let ctx = BackupExecutionContext {
        file_manager,
        database,
        database_manager,
        window: None,
        root_override: None,
        chat_v2_db: None,
        vfs_db: None,
    };

    let root = ctx.app_data_root();
    fs::create_dir_all(&backup_dir)
        .map_err(|e| AppError::file_system(format!("创建备份目录失败: {}", e)))?;

    let backup_name = format!("auto-backup-{}.zip", Utc::now().format("%Y%m%d-%H%M%S"));
    let backups_dir =
        ensure_backups_dir(&root).map_err(|e| AppError::file_system(e.to_string()))?;
    let temp_zip = backups_dir.join(&backup_name);
    let final_target = backup_dir.join(&backup_name);

    let whitelist = build_whitelist(&options);

    // 进入维护模式并刷新 WAL，避免快照不一致
    let _maintenance_guard = MaintenanceGuard::enter(ctx.database.clone())?;
    checkpoint_all_sqlite_dbs(&root, &ctx);

    if options.perform_lance_compaction && includes_rebuildable(&options) {
        // 旧 RAG 已废弃，跳过 Lance 优化
        info!("[Backup] 跳过 Lance Compaction（旧 RAG 已废弃）");
    } else if options.perform_lance_compaction {
        info!("[Backup] 跳过 Lance Compaction（分级备份未包含可重建数据）");
    }

    // 在维护模式下扫描文件，确保快照一致性
    let mut plan = build_backup_plan(&root, &options, whitelist.as_deref(), None)?;

    // 将 slots/state.json 纳入备份范围
    if includes_core_config(&options) {
        if let Some(parent) = root.parent() {
            let state_json_path = parent.join("state.json");
            if state_json_path.exists()
                && state_json_path.is_file()
                && !is_symlink(&state_json_path)
            {
                if let Ok(state_metadata) = fs::metadata(&state_json_path) {
                    let state_size = state_metadata.len();
                    plan.files.push(BackupPlanEntry {
                        absolute: state_json_path,
                        relative: "slots_state.json".to_string(),
                        size: state_size,
                    });
                    plan.total_size += state_size;
                }
            }
        }
    } else {
        info!("[BackupExport] 分级备份未包含核心配置，跳过 slots/state.json");
    }

    let mut metadata = create_backup_metadata(&plan, &ctx, &options)?;

    // 验证 P0 数据源完整性
    if has_backup_tiers(&options) {
        info!("[BackupExport] 分级备份模式，跳过 P0 完整性验证");
        metadata
            .warnings
            .push("分级备份模式：未执行 P0 完整性验证".to_string());
    } else {
        let backup_files: Vec<String> = plan.files.iter().map(|e| e.relative.clone()).collect();
        let p0_result = verify_p0_data_sources(&root, &backup_files);
        if !p0_result.inaccessible.is_empty() {
            for (source, reason) in &p0_result.inaccessible {
                warn!("[Backup] P0 数据源 {:?} 无法访问: {}", source, reason);
                metadata
                    .warnings
                    .push(format!("P0 数据源 {:?} 未包含在备份中: {}", source, reason));
            }
        }
        for warning in &p0_result.warnings {
            warn!("{}", warning);
            metadata.warnings.push(warning.clone());
        }
    }

    if let Err(e) = build_zip_with_metadata(
        &plan,
        &temp_zip,
        &mut metadata,
        &options,
        None,
        None,
        Some(&_maintenance_guard),
    ) {
        // 清理部分写入的临时 ZIP 文件
        error!("[AutoBackup] ZIP 构建失败，清理临时文件: {:?}", temp_zip);
        let _ = fs::remove_file(&temp_zip);
        return Err(e);
    }

    if final_target != temp_zip {
        if let Some(parent) = final_target.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| AppError::file_system(format!("创建目录失败 {:?}: {}", parent, e)))?;
        }
        match fs::rename(&temp_zip, &final_target) {
            Ok(_) => {}
            Err(rename_err) => {
                fs::copy(&temp_zip, &final_target).map_err(|e| {
                    AppError::file_system(format!(
                        "移动备份失败（rename: {}, copy: {}）",
                        rename_err, e
                    ))
                })?;
                let _ = fs::remove_file(&temp_zip);
            }
        }
    }

    Ok(final_target)
}

// 旧自动备份 Tauri 命令已移除；自动调度由 backup_config + data_governance 链路负责。
// should_create_backup / cleanup_old_auto_backups 已废弃并删除，
// 实际调度使用 backup_config.rs 中的 cleanup_old_backups。

/// 获取备份列表
///
/// **Deprecated**: 请使用数据治理系统 `data_governance_get_backup_list` 代替。
/// 此命令将在未来版本中移除。
#[deprecated(note = "请使用 data_governance_get_backup_list 代替，此命令将在未来版本中移除")]
#[tauri::command]
pub async fn get_backup_list(state: State<'_, AppState>) -> Result<Vec<BackupInfo>> {
    let root = app_data_root(&state);
    let backups_dir =
        ensure_backups_dir(&root).map_err(|e| AppError::file_system(e.to_string()))?;

    let mut backups = Vec::new();

    for entry in fs::read_dir(&backups_dir).map_err(|e| AppError::file_system(e.to_string()))? {
        let entry = entry.map_err(|e| AppError::file_system(e.to_string()))?;
        let path = entry.path();

        if path.extension().map_or(false, |ext| ext == "zip") {
            let metadata = fs::metadata(&path)
                .map_err(|e| AppError::file_system(format!("获取文件元数据失败: {}", e)))?;

            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();

            let is_auto = file_name.starts_with("auto-backup-");
            let size = metadata.len();
            let modified = metadata
                .modified()
                .ok()
                .map(|t| chrono::DateTime::<Utc>::from(t).to_rfc3339())
                .unwrap_or_else(|| "unknown".to_string());

            backups.push(BackupInfo {
                file_name,
                file_path: path.to_string_lossy().to_string(),
                size,
                created_at: modified,
                is_auto_backup: is_auto,
            });
        }
    }

    // 按创建时间排序（最新的在前）
    backups.sort_by(|a, b| b.created_at.cmp(&a.created_at));

    Ok(backups)
}

#[derive(Serialize, Deserialize)]
pub struct BackupInfo {
    pub file_name: String,
    pub file_path: String,
    pub size: u64,
    pub created_at: String,
    pub is_auto_backup: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_count_files_recursive_skips_migration_core_backups() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();

        fs::write(root.join("chat_v2.db"), b"x").unwrap();
        fs::create_dir_all(root.join(MIGRATION_CORE_BACKUPS_DIR)).unwrap();
        fs::write(
            root.join(MIGRATION_CORE_BACKUPS_DIR).join("snapshot.db"),
            b"y",
        )
        .unwrap();

        let count = count_files_recursive(root, true);
        assert_eq!(count, 1, "应跳过 migration_core_backups 下的文件");
    }

    #[test]
    fn test_collect_db_files_skips_migration_core_backups() {
        let temp = TempDir::new().unwrap();
        let root = temp.path();

        fs::write(root.join("mistakes.db"), b"x").unwrap();
        fs::create_dir_all(root.join(MIGRATION_CORE_BACKUPS_DIR)).unwrap();
        fs::write(
            root.join(MIGRATION_CORE_BACKUPS_DIR).join("old_vfs.db"),
            b"y",
        )
        .unwrap();

        let files = collect_db_files(root, root, true);
        let file_names: Vec<String> = files
            .iter()
            .map(|p| p.to_string_lossy().to_string())
            .collect();
        assert_eq!(file_names, vec!["mistakes.db".to_string()]);
    }
}
