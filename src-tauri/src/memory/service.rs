use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;
use std::sync::{Arc, RwLock};
use std::time::Duration;
use tracing::{debug, info, warn};

use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::indexing::VfsFullIndexingService;
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::index_unit_repo;
use crate::vfs::repos::note_repo::VfsNoteRepo;
use crate::vfs::types::{
    FolderTreeNode, VfsCreateNoteParams, VfsFolder, VfsNote, VfsUpdateNoteParams,
};

/// 文件夹树缓存，避免每次搜索/列表都执行 CTE 递归查询
struct FolderIdCache {
    root_id: String,
    folder_ids: Vec<String>,
}

use super::audit_log::{MemoryAuditLogger, MemoryOpSource, MemoryOpType, OpTimer};
use super::auto_extractor::MemoryAutoExtractor;
use super::config::MemoryConfig;
use super::llm_decision::{
    MemoryDecisionResponse, MemoryEvent, MemoryLLMDecision, SimilarMemorySummary,
};
use super::query_rewriter::MemoryQueryRewriter;
use super::reranker::MemoryReranker;

const SMART_WRITE_MUTATION_CONFIDENCE_THRESHOLD: f32 = 0.65;
const SMART_WRITE_IDEMPOTENCY_RETENTION_HOURS: i64 = 24;
const SMART_WRITE_IDEMPOTENCY_IN_PROGRESS: &str = "IN_PROGRESS";
const SMART_WRITE_IDEMPOTENCY_LEASE_MS: i64 = 5 * 60 * 1000;

#[derive(Debug, Clone)]
struct SmartWriteReservation {
    key: String,
    owner_token: String,
}

struct CommittedSmartWrite {
    output: SmartWriteOutput,
    deleted_resource_id: Option<String>,
}

#[cfg(test)]
static SMART_WRITE_FAIL_BEFORE_RECEIPT_KEY: std::sync::Mutex<Option<String>> =
    std::sync::Mutex::new(None);

/// 记忆类型标签前缀
const TAG_TYPE_PREFIX: &str = "_type:";
/// 记忆目的标签前缀
const TAG_PURPOSE_PREFIX: &str = "_purpose:";
/// 记忆关联引用标签前缀（轻量关联，不依赖关系表）
const TAG_REF_PREFIX: &str = "_ref:";

/// 记忆类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum MemoryType {
    /// 原子事实（默认）：关于用户的简短陈述句，≤80 字
    #[default]
    Fact,
    /// 学习记忆：用户明确要求保存的词汇/知识点/错题要点等学习内容
    Study,
    /// 经验笔记：用户明确要求保存的方法论、经验、技巧等，≤2000 字
    Note,
}

impl MemoryType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Fact => "fact",
            Self::Study => "study",
            Self::Note => "note",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "study" => Self::Study,
            "note" => Self::Note,
            _ => Self::Fact,
        }
    }

    pub fn to_tag(&self) -> String {
        format!("{}{}", TAG_TYPE_PREFIX, self.as_str())
    }

    pub fn from_tags(tags: &[String]) -> Self {
        tags.iter()
            .find_map(|t| t.strip_prefix(TAG_TYPE_PREFIX))
            .map(Self::from_str)
            .unwrap_or(Self::Fact)
    }

    pub fn max_content_chars(&self) -> usize {
        match self {
            Self::Fact => 200,
            Self::Study => 4000,
            Self::Note => 2000,
        }
    }
}

/// 记忆目的（重要程度分类，影响检索时加权和 system prompt 注入策略）
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
#[derive(Default)]
pub enum MemoryPurpose {
    /// 内化型：用户需要理解并记忆的核心内容（最高优先级）
    Internalized,
    /// 记忆型：仅需单独记忆的事实（中高优先级）
    #[default]
    Memorized,
    /// 补充知识型：辅助理解的补充内容（中低优先级）
    Supplementary,
    /// 系统型：系统用于理解用户的元信息（不直接呈现给用户）
    Systemic,
}

impl MemoryPurpose {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Internalized => "internalized",
            Self::Memorized => "memorized",
            Self::Supplementary => "supplementary",
            Self::Systemic => "systemic",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "internalized" => Self::Internalized,
            "supplementary" => Self::Supplementary,
            "systemic" => Self::Systemic,
            _ => Self::Memorized,
        }
    }

    pub fn to_tag(&self) -> String {
        format!("{}{}", TAG_PURPOSE_PREFIX, self.as_str())
    }

    pub fn from_tags(tags: &[String]) -> Self {
        tags.iter()
            .find_map(|t| t.strip_prefix(TAG_PURPOSE_PREFIX))
            .map(Self::from_str)
            .unwrap_or(Self::Memorized)
    }

    /// 检索时权重系数：内化型最重要，系统型最低
    pub fn search_weight(&self) -> f32 {
        match self {
            Self::Internalized => 1.4,
            Self::Memorized => 1.0,
            Self::Supplementary => 0.8,
            Self::Systemic => 0.65,
        }
    }
}

/// 系统笔记统一存放的子文件夹标题（__user_profile__ 和 __cat_*__ 等不再散落在根目录）
const SYSTEM_FOLDER_TITLE: &str = "__system__";

/// 用户画像摘要笔记的保留标题
const PROFILE_NOTE_TITLE: &str = "__user_profile__";
/// 用户可写记忆标题/路径不允许使用该前缀，避免篡改系统保留笔记
const RESERVED_SYSTEM_PREFIX: &str = "__";
/// 画像摘要的最大条目数
const PROFILE_MAX_ITEMS: usize = 15;
/// 标记记忆被搜索命中的 tag 前缀
const TAG_HITS_PREFIX: &str = "_hits:";
/// 标记记忆最后命中时间的 tag 前缀
const TAG_LAST_HIT_PREFIX: &str = "_last_hit:";
/// 时间衰减半衰期（天）：超过此天数的记忆搜索分数减半
const TIME_DECAY_HALF_LIFE_DAYS: f64 = 60.0;

fn should_downgrade_smart_mutation(event: &MemoryEvent, confidence: f32) -> bool {
    matches!(
        event,
        MemoryEvent::UPDATE | MemoryEvent::APPEND | MemoryEvent::DELETE
    ) && confidence < SMART_WRITE_MUTATION_CONFIDENCE_THRESHOLD
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResult {
    pub note_id: String,
    pub note_title: String,
    pub folder_path: String,
    pub chunk_text: String,
    pub score: f32,
    /// 笔记的 updated_at（ISO 8601），用于时间衰减计算
    #[serde(skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

/// 搜索用途（控制是否写入命中反馈）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SearchPurpose {
    /// 用户实际检索：记录命中统计，参与后续进化反馈
    UserRetrieval,
    /// 内部去重/决策检索：只读，不记录命中
    InternalDedup,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListItem {
    pub id: String,
    pub title: String,
    pub folder_path: String,
    pub updated_at: String,
    /// 搜索命中次数（从 tags `_hits:N` 提取）
    #[serde(default)]
    pub hits: u32,
    /// 是否被标记为重要（tags 包含 `_important`）
    #[serde(default)]
    pub is_important: bool,
    /// 是否被标记为过时（tags 包含 `_stale`）
    #[serde(default)]
    pub is_stale: bool,
    /// 记忆类型：fact（原子事实）| study（学习记忆）| note（经验笔记）
    #[serde(default)]
    pub memory_type: String,
    /// 记忆目的：internalized | memorized | supplementary | systemic
    #[serde(default)]
    pub memory_purpose: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Create,
    Update,
    Append,
}

impl WriteMode {
    pub fn from_str(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "update" => WriteMode::Update,
            "append" => WriteMode::Append,
            "create" => WriteMode::Create,
            _ => {
                warn!("[Memory] Unknown WriteMode '{}', defaulting to Create", s);
                WriteMode::Create
            }
        }
    }
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConfigOutput {
    pub memory_root_folder_id: Option<String>,
    pub memory_root_folder_title: Option<String>,
    pub auto_create_subfolders: bool,
    pub default_category: String,
    pub privacy_mode: bool,
    pub auto_extract_frequency: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWriteOutput {
    pub note_id: String,
    pub is_new: bool,
    /// 写入资源的 resource_id，用于触发即时索引以保证 write-then-search SLA
    pub resource_id: String,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SmartWriteOutput {
    pub note_id: String,
    pub event: String,
    pub is_new: bool,
    pub confidence: f32,
    pub reason: String,
    /// 写入资源的 resource_id，用于触发即时索引。
    /// 当 event 为 NONE 时为 None（无写入发生）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    /// 是否因低置信度被降级为 NONE（LLM 应提示用户确认）
    #[serde(default)]
    pub downgraded: bool,
}

#[derive(Clone)]
pub struct MemoryService {
    config: MemoryConfig,
    vfs_db: Arc<VfsDatabase>,
    lance_store: Arc<VfsLanceStore>,
    llm_manager: Arc<LLMManager>,
    folder_cache: Arc<RwLock<Option<FolderIdCache>>>,
    audit_logger: MemoryAuditLogger,
}

impl MemoryService {
    pub fn new(
        vfs_db: Arc<VfsDatabase>,
        lance_store: Arc<VfsLanceStore>,
        llm_manager: Arc<LLMManager>,
    ) -> Self {
        let audit_logger = MemoryAuditLogger::new(vfs_db.clone());
        Self {
            config: MemoryConfig::new(vfs_db.clone()),
            vfs_db,
            lance_store,
            llm_manager,
            folder_cache: Arc::new(RwLock::new(None)),
            audit_logger,
        }
    }

    pub fn audit_logger(&self) -> &MemoryAuditLogger {
        &self.audit_logger
    }

    pub fn vfs_db_ref(&self) -> &Arc<VfsDatabase> {
        &self.vfs_db
    }

    /// 获取或创建系统文件夹（用于存放 __user_profile__、__cat_*__ 等系统笔记）
    pub fn get_or_create_system_folder_id(&self) -> VfsResult<String> {
        let _guard = super::lock_memory_structure();
        self.get_or_create_system_folder_id_unlocked()
    }

    pub(crate) fn get_or_create_system_folder_id_unlocked(&self) -> VfsResult<String> {
        let root_id = self.config.get_or_create_root_folder()?;
        if let Some(id) = self.find_system_folder_id(&root_id)? {
            return Ok(id);
        }
        let folder = VfsFolder::new(
            SYSTEM_FOLDER_TITLE.to_string(),
            Some(root_id.clone()),
            None,
            None,
        );
        VfsFolderRepo::create_folder(&self.vfs_db, &folder)?;
        self.invalidate_folder_cache();
        debug!("[Memory] Created system folder: {}", folder.id);
        Ok(folder.id)
    }

    fn find_system_folder_id(&self, root_id: &str) -> VfsResult<Option<String>> {
        let children = VfsFolderRepo::list_folders_by_parent(&self.vfs_db, Some(root_id))?;
        Ok(children
            .iter()
            .find(|f| f.title == SYSTEM_FOLDER_TITLE)
            .map(|f| f.id.clone()))
    }

    fn is_reserved_system_name(name: &str) -> bool {
        name.trim_start().starts_with(RESERVED_SYSTEM_PREFIX)
    }

    fn fact_hard_reject_reason(title: &str, content: &str) -> Option<&'static str> {
        let combined = format!("{}\n{}", title, content).to_lowercase();
        let knowledge_keywords = [
            "知识点",
            "词汇",
            "单词",
            "释义",
            "例句",
            "语法",
            "定理",
            "公式",
            "概念",
            "题干",
            "选项",
            "答案",
            "解题",
            "错题",
            "文档摘要",
            "章节概要",
        ];
        if knowledge_keywords.iter().any(|kw| combined.contains(kw)) {
            return Some(
                "fact 类型只允许保存用户事实；检测到学科知识/题目内容，请改用 memory_type='study' 或 'note'。",
            );
        }

        let pos_markers = [" n.", " v.", " adj.", " adv.", " prep.", " pron."];
        let looks_like_vocab = pos_markers.iter().any(|marker| combined.contains(marker))
            && (content.contains('/') || content.contains('=') || content.contains('＝'));
        if looks_like_vocab {
            return Some("fact 类型不适合保存词汇释义；请改用 memory_type='study'。");
        }

        None
    }

    fn non_fact_type_tag(memory_type: MemoryType) -> Option<String> {
        match memory_type {
            MemoryType::Fact => None,
            _ => Some(memory_type.to_tag()),
        }
    }

    fn same_text(lhs: &str, rhs: &str) -> bool {
        lhs.trim() == rhs.trim()
    }

    fn purpose_matches(tags: &[String], purpose: Option<MemoryPurpose>) -> bool {
        MemoryPurpose::from_tags(tags) == purpose.unwrap_or_default()
    }

    fn validate_user_writable_title(title: &str) -> VfsResult<()> {
        if Self::is_reserved_system_name(title) {
            return Err(VfsError::InvalidArgument {
                param: "title".to_string(),
                reason: "标题使用系统保留前缀 '__'，请更换标题".to_string(),
            });
        }
        Ok(())
    }

    fn validate_user_writable_folder_path(path: Option<&str>) -> VfsResult<()> {
        let Some(path) = path else {
            return Ok(());
        };
        for segment in path.split('/').filter(|s| !s.trim().is_empty()) {
            if Self::is_reserved_system_name(segment) {
                return Err(VfsError::InvalidArgument {
                    param: "folder_path".to_string(),
                    reason: "路径包含系统保留目录（'__*'）".to_string(),
                });
            }
        }
        Ok(())
    }

    /// 获取记忆文件夹 ID 列表（带缓存）
    fn get_memory_folder_ids(&self, root_id: &str) -> VfsResult<Vec<String>> {
        {
            let cache = self.folder_cache.read().unwrap_or_else(|p| p.into_inner());
            if let Some(ref c) = *cache {
                if c.root_id == root_id {
                    return Ok(c.folder_ids.clone());
                }
            }
        }
        let folder_ids = VfsFolderRepo::get_folder_ids_recursive(&self.vfs_db, root_id)?;
        {
            let mut cache = self.folder_cache.write().unwrap_or_else(|p| p.into_inner());
            *cache = Some(FolderIdCache {
                root_id: root_id.to_string(),
                folder_ids: folder_ids.clone(),
            });
        }
        debug!(
            "[Memory] Folder cache populated: {} folders",
            folder_ids.len()
        );
        Ok(folder_ids)
    }

    /// 使文件夹缓存失效（在文件夹结构变更后调用）
    fn invalidate_folder_cache(&self) {
        let mut cache = self.folder_cache.write().unwrap_or_else(|p| p.into_inner());
        *cache = None;
    }

    pub fn get_config(&self) -> VfsResult<MemoryConfigOutput> {
        let configured_root_id = self.config.get_root_folder_id()?;
        let (root_id, root_title) = if let Some(ref id) = configured_root_id {
            if let Some(folder) = VfsFolderRepo::get_folder(&self.vfs_db, id)? {
                (Some(id.clone()), Some(folder.title))
            } else {
                (None, None)
            }
        } else {
            (None, None)
        };

        Ok(MemoryConfigOutput {
            memory_root_folder_id: root_id,
            memory_root_folder_title: root_title,
            auto_create_subfolders: self.config.is_auto_create_subfolders()?,
            default_category: self.config.get_default_category()?,
            privacy_mode: self.config.is_privacy_mode()?,
            auto_extract_frequency: self
                .config
                .get_auto_extract_frequency()?
                .as_str()
                .to_string(),
        })
    }

    pub fn set_root_folder(&self, folder_id: &str) -> VfsResult<()> {
        if !VfsFolderRepo::folder_exists(&self.vfs_db, folder_id)? {
            return Err(VfsError::NotFound {
                resource_type: "Folder".to_string(),
                id: folder_id.to_string(),
            });
        }
        if let Some(folder) = VfsFolderRepo::get_folder(&self.vfs_db, folder_id)? {
            if Self::is_reserved_system_name(&folder.title) {
                return Err(VfsError::InvalidArgument {
                    param: "folder_id".to_string(),
                    reason: "记忆根目录不能使用系统保留目录（'__*'）".to_string(),
                });
            }
        }
        self.config.set_root_folder_id(folder_id)?;
        self.invalidate_folder_cache();
        info!("[Memory] Set root folder: {}", folder_id);
        Ok(())
    }

    /// 立即索引资源（同步生成嵌入 + 写入 LanceDB），确保后续向量搜索能找到。
    /// 索引成功后标记为 indexed，防止批量 worker 和 handler 重复处理。
    ///
    /// 公开别名 `index_resource_immediately`，供 MemoryToolExecutor 等外部调用方使用。
    pub async fn index_resource_immediately(&self, resource_id: &str) {
        self.index_immediately(resource_id).await;
    }

    async fn index_immediately(&self, resource_id: &str) {
        match VfsFullIndexingService::new(
            self.vfs_db.clone(),
            self.llm_manager.clone(),
            self.lance_store.clone(),
        ) {
            Ok(svc) => match svc.index_resource(resource_id, None, None).await {
                Ok((chunks, _dim)) => {
                    if let Err(e) = VfsIndexStateRepo::mark_indexed(
                        &self.vfs_db,
                        resource_id,
                        &format!("mem_imm_{}", chrono::Utc::now().timestamp_millis()),
                    ) {
                        warn!(
                            "[Memory] Failed to mark indexed after immediate indexing: {}",
                            e
                        );
                    }
                    info!(
                        "[Memory] Immediate indexing succeeded: resource={}, chunks={}",
                        resource_id, chunks
                    );
                }
                Err(e) => {
                    warn!(
                        "[Memory] Immediate indexing failed (will retry via pending): {}",
                        e
                    );
                }
            },
            Err(e) => {
                warn!("[Memory] Failed to create indexing service: {}", e);
            }
        }
    }

    pub fn set_privacy_mode(&self, enabled: bool) -> VfsResult<()> {
        self.config.set_privacy_mode(enabled)?;
        info!("[Memory] Set privacy mode: {}", enabled);
        Ok(())
    }

    pub fn create_root_folder(&self, title: &str) -> VfsResult<String> {
        self.config.create_root_folder(title)
    }

    pub fn get_or_create_root_folder(&self) -> VfsResult<String> {
        let _guard = super::lock_memory_structure();
        self.get_or_create_root_folder_unlocked()
    }

    pub(crate) fn get_or_create_root_folder_unlocked(&self) -> VfsResult<String> {
        self.config.get_or_create_root_folder()
    }

    fn ensure_root_folder_id(&self) -> VfsResult<String> {
        let _guard = super::lock_memory_structure();
        self.config.get_or_create_root_folder()
    }

    /// 在写入/更新/删除后触发统一维护流程（画像刷新 + 分类刷新 + 自进化）
    ///
    /// - 设计为 fire-and-forget，不阻塞主写路径
    /// - 分类刷新使用频率档位阈值控制，避免每次写入都触发 LLM 聚合
    pub fn spawn_post_write_maintenance(&self) {
        let svc = self.clone();
        let vfs_db = self.vfs_db.clone();
        let llm_manager = self.llm_manager.clone();

        crate::background_tasks::BACKGROUND_TASKS.spawn(async move {
            let svc_for_profile = svc.clone();
            match tokio::task::spawn_blocking(move || svc_for_profile.refresh_profile_summary())
                .await
            {
                Ok(Ok(())) => {}
                Ok(Err(e)) => warn!("[Memory] Post-write profile refresh failed: {}", e),
                Err(e) => warn!(
                    "[Memory] Post-write profile refresh task join failed: {}",
                    e
                ),
            }

            let mem_cfg = MemoryConfig::new(vfs_db.clone());
            let frequency = mem_cfg
                .get_auto_extract_frequency()
                .unwrap_or(super::config::AutoExtractFrequency::Balanced);
            let privacy_mode = mem_cfg.is_privacy_mode().unwrap_or(false);

            if !privacy_mode {
                let should_refresh = match svc.count_active_memories() {
                    Ok(total) => frequency.should_refresh_categories(total as usize),
                    Err(_) => false,
                };

                if should_refresh {
                    let cat_mgr = super::category_manager::MemoryCategoryManager::new(
                        vfs_db.clone(),
                        llm_manager.clone(),
                    );
                    if let Err(e) = cat_mgr.refresh_all_categories(&svc).await {
                        warn!("[Memory] Post-write category refresh failed: {}", e);
                    }
                }
            }

            let evolution = super::evolution::MemoryEvolution::new(vfs_db);
            evolution.run_throttled(&svc, frequency.evolution_interval_ms());

            // 三层记忆：日志→画像晋升 pass（频率跟随现有 evolution 周期）
            // 隐私模式下跳过——晋升需要把日志内容送入 LLM
            if !privacy_mode {
                evolution
                    .run_promotion_throttled(&svc, llm_manager, frequency.evolution_interval_ms())
                    .await;
            }
        });
    }

    pub async fn search(&self, query: &str, top_k: usize) -> VfsResult<Vec<MemorySearchResult>> {
        self.search_for_purpose(query, top_k, SearchPurpose::UserRetrieval)
            .await
    }

    pub async fn search_for_purpose(
        &self,
        query: &str,
        top_k: usize,
        purpose: SearchPurpose,
    ) -> VfsResult<Vec<MemorySearchResult>> {
        self.search_unified_for_purpose(query, top_k, purpose).await
    }

    /// 使用预计算 embedding 搜索记忆（避免重复调用 Embedding API）
    ///
    /// unified_search 可先生成一次 embedding，同时传给 VFS 文本搜索和记忆搜索。
    pub async fn search_with_embedding(
        &self,
        query: &str,
        query_embedding: &[f32],
        top_k: usize,
    ) -> VfsResult<Vec<MemorySearchResult>> {
        self.search_with_embedding_for_purpose(
            query,
            query_embedding,
            top_k,
            SearchPurpose::UserRetrieval,
        )
        .await
    }

    pub async fn search_with_embedding_for_purpose(
        &self,
        query: &str,
        _query_embedding: &[f32],
        top_k: usize,
        purpose: SearchPurpose,
    ) -> VfsResult<Vec<MemorySearchResult>> {
        // A bare vector has no model/profile fingerprint. Keep this signature for callers that
        // still precompute an embedding, but never let it select a VFS vector space.
        self.search_unified_for_purpose(query, top_k, purpose).await
    }

    async fn search_unified_for_purpose(
        &self,
        query: &str,
        top_k: usize,
        purpose: SearchPurpose,
    ) -> VfsResult<Vec<MemorySearchResult>> {
        if top_k == 0 {
            return Ok(vec![]);
        }

        if self.config.is_privacy_mode()? {
            warn!("[Memory] Privacy mode enabled, skipping unified retrieval");
            return Ok(vec![]);
        }

        let root_id = self.ensure_root_folder_id()?;

        let folder_ids = self.get_memory_folder_ids(&root_id)?;
        if folder_ids.is_empty() {
            return Ok(vec![]);
        }

        let retrieval_k = top_k.saturating_mul(3);
        let retriever = crate::vfs::VfsUnifiedRetriever::new(
            Arc::clone(&self.vfs_db),
            Arc::clone(&self.lance_store),
            Arc::clone(&self.llm_manager),
        );
        let response = retriever
            .search(crate::vfs::UnifiedRetrievalRequest {
                query_text: Some(query.to_string()),
                query_image_base64: None,
                query_image_media_type: None,
                query_modality: crate::vfs::QueryModality::Text,
                top_k: retrieval_k,
                folder_ids: Some(folder_ids),
                resource_ids: None,
                resource_types: Some(vec!["note".to_string()]),
            })
            .await?;
        let best_rrf_score = response
            .result
            .hits
            .first()
            .map(|fused| fused.rrf_score)
            .unwrap_or(0.0);

        let mut results = Vec::new();
        let mut seen_note_ids: HashSet<String> = HashSet::new();
        for fused in response.result.hits {
            let resource_id = &fused.hit.identity.resource_id;
            let note = self.get_note_by_resource_id(resource_id)?;
            if let Some(note) = note {
                if !self.is_note_in_memory_root(&note.id, &root_id)? {
                    continue;
                }
                if !seen_note_ids.insert(note.id.clone()) {
                    continue;
                }

                let folder_path = self.get_note_folder_path(&note.id)?;
                let tag_weight = Self::compute_tag_weight(&note.tags);
                let retrieval_score = if fused.rrf_score.is_finite()
                    && best_rrf_score.is_finite()
                    && best_rrf_score > 0.0
                {
                    (fused.rrf_score / best_rrf_score).clamp(0.0, 1.0) as f32
                } else {
                    0.0
                };
                results.push(MemorySearchResult {
                    note_id: note.id,
                    note_title: note.title,
                    folder_path,
                    chunk_text: fused.hit.text,
                    score: retrieval_score * tag_weight,
                    updated_at: Some(note.updated_at),
                });

                // 收集完整候选集（retrieval_k = 3 * top_k），
                // 时间衰减必须在截断前应用，否则新近记忆会被旧的高分记忆永久挤出
                if results.len() >= retrieval_k {
                    break;
                }
            }
        }

        // 应用时间衰减 → 按衰减后分数重排 → 再截断到 top_k
        self.apply_time_decay(&mut results);
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        results.truncate(top_k);

        if purpose == SearchPurpose::UserRetrieval {
            // 异步记录命中（不阻塞搜索返回）
            let hit_ids: Vec<String> = results.iter().map(|r| r.note_id.clone()).collect();
            if !hit_ids.is_empty() {
                let svc = self.clone();
                tokio::task::spawn_blocking(move || svc.record_search_hits(&hit_ids));
            }
        }

        debug!(
            "[Memory] Search '{}' returned {} results (with time decay)",
            query,
            results.len()
        );
        Ok(results)
    }

    pub fn read(&self, note_id: &str) -> VfsResult<Option<(VfsNote, String)>> {
        let root_id = self.ensure_root_folder_id()?;

        let note = match VfsNoteRepo::get_note(&self.vfs_db, note_id)? {
            Some(note) => note,
            None => return Ok(None),
        };

        if !self.is_note_in_memory_root(note_id, &root_id)? {
            return Ok(None);
        }

        let content = VfsNoteRepo::get_note_content(&self.vfs_db, note_id)?.unwrap_or_default();
        Ok(Some((note, content)))
    }

    pub fn write(
        &self,
        folder_path: Option<&str>,
        title: &str,
        content: &str,
        mode: WriteMode,
    ) -> VfsResult<MemoryWriteOutput> {
        self.write_typed(folder_path, title, content, mode, MemoryType::Fact, None)
    }

    pub fn write_typed(
        &self,
        folder_path: Option<&str>,
        title: &str,
        content: &str,
        mode: WriteMode,
        memory_type: MemoryType,
        purpose: Option<MemoryPurpose>,
    ) -> VfsResult<MemoryWriteOutput> {
        if title.trim().is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "title".to_string(),
                reason: "标题不能为空".to_string(),
            });
        }
        Self::validate_user_writable_title(title)?;
        Self::validate_user_writable_folder_path(folder_path)?;
        if MemoryAutoExtractor::contains_sensitive_pattern_pub(title)
            || MemoryAutoExtractor::contains_sensitive_pattern_pub(content)
        {
            return Err(VfsError::InvalidArgument {
                param: "title/content".to_string(),
                reason: "包含敏感信息（手机号/身份证/银行卡/邮箱/密码）".to_string(),
            });
        }
        let max_chars = memory_type.max_content_chars();
        if content.chars().count() > max_chars {
            return Err(VfsError::InvalidArgument {
                param: "content".to_string(),
                reason: format!(
                    "内容超过 {} 字限制（类型: {}）",
                    max_chars,
                    memory_type.as_str()
                ),
            });
        }

        let target_folder_id =
            self.resolve_write_target_folder_id_synchronized(folder_path, true)?;

        let mut type_tags = Self::non_fact_type_tag(memory_type)
            .map(|tag| vec![tag])
            .unwrap_or_default();
        if let Some(p) = purpose {
            type_tags.push(p.to_tag());
        }

        match mode {
            WriteMode::Create => {
                let note = VfsNoteRepo::create_note_in_folder(
                    &self.vfs_db,
                    VfsCreateNoteParams {
                        title: title.to_string(),
                        content: content.to_string(),
                        tags: type_tags.clone(),
                    },
                    target_folder_id.as_deref(),
                )?;
                // ★ P2-2 修复：写入后触发索引入队
                if let Err(e) = VfsIndexStateRepo::mark_pending(&self.vfs_db, &note.resource_id) {
                    warn!("[Memory] Failed to mark pending for indexing: {}", e);
                }
                info!(
                    "[Memory] Created note: {} (resource_id={}) in {:?} — marked pending for immediate indexing",
                    note.id, note.resource_id, folder_path
                );
                Ok(MemoryWriteOutput {
                    note_id: note.id,
                    is_new: true,
                    resource_id: note.resource_id,
                })
            }
            WriteMode::Update | WriteMode::Append => {
                let existing = self.find_note_by_title(target_folder_id.as_deref(), title)?;
                if let Some(note) = existing {
                    let final_content = if mode == WriteMode::Append {
                        let current = VfsNoteRepo::get_note_content(&self.vfs_db, &note.id)?
                            .unwrap_or_default();
                        format!("{}\n\n{}", current, content)
                    } else {
                        content.to_string()
                    };

                    let updated_note = VfsNoteRepo::update_note(
                        &self.vfs_db,
                        &note.id,
                        VfsUpdateNoteParams {
                            title: Some(title.to_string()),
                            content: Some(final_content),
                            tags: None,
                            expected_updated_at: Some(note.updated_at.clone()),
                        },
                    )?;
                    // ★ P2-2 修复：更新后触发索引入队
                    if let Err(e) =
                        VfsIndexStateRepo::mark_pending(&self.vfs_db, &updated_note.resource_id)
                    {
                        warn!("[Memory] Failed to mark pending for indexing: {}", e);
                    }
                    info!(
                        "[Memory] Updated note: {} (resource_id={}) — marked pending for immediate indexing",
                        note.id, updated_note.resource_id
                    );
                    Ok(MemoryWriteOutput {
                        note_id: note.id,
                        is_new: false,
                        resource_id: updated_note.resource_id,
                    })
                } else {
                    let note = VfsNoteRepo::create_note_in_folder(
                        &self.vfs_db,
                        VfsCreateNoteParams {
                            title: title.to_string(),
                            content: content.to_string(),
                            tags: type_tags,
                        },
                        target_folder_id.as_deref(),
                    )?;
                    if let Err(e) = VfsIndexStateRepo::mark_pending(&self.vfs_db, &note.resource_id)
                    {
                        warn!("[Memory] Failed to mark pending for indexing: {}", e);
                    }
                    info!(
                        "[Memory] Created note (mode={}, resource_id={}): {} — marked pending for immediate indexing",
                        if mode == WriteMode::Update {
                            "update"
                        } else {
                            "append"
                        },
                        note.resource_id,
                        note.id
                    );
                    Ok(MemoryWriteOutput {
                        note_id: note.id,
                        is_new: true,
                        resource_id: note.resource_id,
                    })
                }
            }
        }
    }

    fn memory_tags(memory_type: MemoryType, purpose: Option<MemoryPurpose>) -> Vec<String> {
        let mut tags = Self::non_fact_type_tag(memory_type)
            .map(|tag| vec![tag])
            .unwrap_or_default();
        if let Some(purpose) = purpose {
            tags.push(purpose.to_tag());
        }
        tags
    }

    fn commit_idempotent_smart_mutation<F>(
        &self,
        reservation: &SmartWriteReservation,
        mutation: F,
    ) -> VfsResult<CommittedSmartWrite>
    where
        F: FnOnce(&Connection) -> VfsResult<CommittedSmartWrite>,
    {
        let conn = self.vfs_db.get_conn_safe()?;
        conn.execute_batch("BEGIN IMMEDIATE")?;
        let result = (|| {
            self.renew_smart_write_reservation_with_conn(&conn, reservation)?;
            let committed = mutation(&conn)?;
            #[cfg(test)]
            {
                let mut fault_key = SMART_WRITE_FAIL_BEFORE_RECEIPT_KEY
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if fault_key.as_deref() == Some(reservation.key.as_str()) {
                    *fault_key = None;
                    return Err(VfsError::Other(
                        "injected failure before idempotency receipt".to_string(),
                    ));
                }
            }
            self.cache_smart_write_result_with_conn(&conn, reservation, &committed.output)?;
            Ok(committed)
        })();

        match result {
            Ok(committed) => {
                if let Err(error) = conn.execute_batch("COMMIT") {
                    let _ = conn.execute_batch("ROLLBACK");
                    return Err(error.into());
                }
                Ok(committed)
            }
            Err(error) => {
                let _ = conn.execute_batch("ROLLBACK");
                Err(error)
            }
        }
    }

    #[cfg(test)]
    pub(crate) fn fail_next_idempotent_write_before_receipt(idempotency_key: &str) {
        let mut fault_key = SMART_WRITE_FAIL_BEFORE_RECEIPT_KEY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        *fault_key = Some(idempotency_key.to_string());
    }

    fn create_smart_memory(
        &self,
        folder_path: Option<&str>,
        title: &str,
        content: &str,
        memory_type: MemoryType,
        purpose: Option<MemoryPurpose>,
        reservation: Option<&SmartWriteReservation>,
        event: &str,
        confidence: f32,
        reason: String,
    ) -> VfsResult<SmartWriteOutput> {
        let Some(reservation) = reservation else {
            let result = self.write_typed(
                folder_path,
                title,
                content,
                WriteMode::Create,
                memory_type,
                purpose,
            )?;
            return Ok(SmartWriteOutput {
                note_id: result.note_id,
                event: event.to_string(),
                is_new: true,
                confidence,
                reason,
                resource_id: Some(result.resource_id),
                downgraded: false,
            });
        };

        let target_folder_id =
            self.resolve_write_target_folder_id_synchronized(folder_path, true)?;
        let tags = Self::memory_tags(memory_type, purpose);
        self.commit_idempotent_smart_mutation(reservation, |conn| {
            let note = VfsNoteRepo::create_note_in_folder_uncommitted(
                conn,
                VfsCreateNoteParams {
                    title: title.to_string(),
                    content: content.to_string(),
                    tags,
                },
                target_folder_id.as_deref(),
            )?;
            VfsIndexStateRepo::set_index_state_with_conn(
                conn,
                &note.resource_id,
                crate::vfs::repos::embedding_repo::INDEX_STATE_PENDING,
                None,
                None,
            )?;
            Ok(CommittedSmartWrite {
                output: SmartWriteOutput {
                    note_id: note.id,
                    event: event.to_string(),
                    is_new: true,
                    confidence,
                    reason,
                    resource_id: Some(note.resource_id),
                    downgraded: false,
                },
                deleted_resource_id: None,
            })
        })
        .map(|committed| committed.output)
    }

    fn update_smart_memory(
        &self,
        note_id: &str,
        title: Option<&str>,
        content: &str,
        append: bool,
        memory_type: MemoryType,
        purpose: Option<MemoryPurpose>,
        source: MemoryOpSource,
        session_id: Option<&str>,
        reservation: Option<&SmartWriteReservation>,
        event: &str,
        confidence: f32,
        reason: String,
    ) -> VfsResult<SmartWriteOutput> {
        let Some(reservation) = reservation else {
            let final_content = if append {
                self.ensure_note_in_memory_root(note_id)?;
                let current =
                    VfsNoteRepo::get_note_content(&self.vfs_db, note_id)?.unwrap_or_default();
                format!("{}\n\n{}", current, content)
            } else {
                content.to_string()
            };
            let result = self.update_by_id_with_source(
                note_id,
                title,
                Some(&final_content),
                source,
                session_id,
            )?;
            if let Err(error) = self.sync_note_system_tags(note_id, memory_type, purpose) {
                warn!(
                    "[Memory] Failed to sync system tags after {} {}: {}",
                    event, note_id, error
                );
            }
            return Ok(SmartWriteOutput {
                note_id: result.note_id,
                event: event.to_string(),
                is_new: false,
                confidence,
                reason,
                resource_id: Some(result.resource_id),
                downgraded: false,
            });
        };

        let root_id = self.ensure_root_folder_id()?;
        self.ensure_note_in_memory_root(note_id)?;
        let mut allowed_folder_ids: HashSet<String> =
            self.get_memory_folder_ids(&root_id)?.into_iter().collect();
        allowed_folder_ids.insert(root_id);

        self.commit_idempotent_smart_mutation(reservation, |conn| {
            let folder_id: Option<String> = conn
                .query_row(
                    "SELECT folder_id FROM folder_items WHERE item_type = 'note' AND item_id = ?1 AND deleted_at IS NULL LIMIT 1",
                    params![note_id],
                    |row| row.get(0),
                )
                .optional()?;
            if !folder_id
                .as_ref()
                .map(|id| allowed_folder_ids.contains(id))
                .unwrap_or(false)
            {
                return Err(VfsError::NotFound {
                    resource_type: "MemoryNote".to_string(),
                    id: note_id.to_string(),
                });
            }

            let (note, current_content) =
                VfsNoteRepo::get_note_with_content_with_conn(conn, note_id)?.ok_or_else(|| {
                    VfsError::NotFound {
                        resource_type: "Note".to_string(),
                        id: note_id.to_string(),
                    }
                })?;
            let final_content = if append {
                format!("{}\n\n{}", current_content, content)
            } else {
                content.to_string()
            };
            if MemoryAutoExtractor::contains_sensitive_pattern_pub(&final_content) {
                return Err(VfsError::InvalidArgument {
                    param: "content".to_string(),
                    reason: "内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码）".to_string(),
                });
            }
            let existing_type = MemoryType::from_tags(&note.tags);
            let max_chars = existing_type.max_content_chars();
            if final_content.chars().count() > max_chars {
                return Err(VfsError::InvalidArgument {
                    param: "content".to_string(),
                    reason: format!(
                        "内容超过 {} 字限制（类型: {}）",
                        max_chars,
                        existing_type.as_str()
                    ),
                });
            }
            if let Some(title) = title {
                Self::validate_user_writable_title(title)?;
            }

            let mut tags: Vec<String> = note
                .tags
                .iter()
                .filter(|tag| {
                    !tag.starts_with(TAG_TYPE_PREFIX) && !tag.starts_with(TAG_PURPOSE_PREFIX)
                })
                .cloned()
                .collect();
            tags.extend(Self::memory_tags(memory_type, purpose));
            let updated = VfsNoteRepo::update_note_with_conn(
                conn,
                note_id,
                VfsUpdateNoteParams {
                    title: title.map(str::to_string),
                    content: Some(final_content),
                    tags: Some(tags),
                    expected_updated_at: Some(note.updated_at),
                },
            )?;
            VfsIndexStateRepo::set_index_state_with_conn(
                conn,
                &updated.resource_id,
                crate::vfs::repos::embedding_repo::INDEX_STATE_PENDING,
                None,
                None,
            )?;
            Ok(CommittedSmartWrite {
                output: SmartWriteOutput {
                    note_id: updated.id,
                    event: event.to_string(),
                    is_new: false,
                    confidence,
                    reason,
                    resource_id: Some(updated.resource_id),
                    downgraded: false,
                },
                deleted_resource_id: None,
            })
        })
        .map(|committed| committed.output)
    }

    async fn delete_and_replace_smart_memory(
        &self,
        target_note_id: &str,
        folder_path: Option<&str>,
        title: &str,
        content: &str,
        memory_type: MemoryType,
        purpose: Option<MemoryPurpose>,
        source: MemoryOpSource,
        session_id: Option<&str>,
        reservation: Option<&SmartWriteReservation>,
        confidence: f32,
        reason: String,
    ) -> VfsResult<SmartWriteOutput> {
        let Some(reservation) = reservation else {
            self.delete_with_source(target_note_id, source, session_id)
                .await?;
            return self.create_smart_memory(
                folder_path,
                title,
                content,
                memory_type,
                purpose,
                None,
                "DELETE",
                confidence,
                reason,
            );
        };

        let root_id = self.ensure_root_folder_id()?;
        self.ensure_note_in_memory_root(target_note_id)?;
        let mut allowed_folder_ids: HashSet<String> =
            self.get_memory_folder_ids(&root_id)?.into_iter().collect();
        allowed_folder_ids.insert(root_id.clone());
        let target_folder_id =
            self.resolve_write_target_folder_id_synchronized(folder_path, true)?;
        let tags = Self::memory_tags(memory_type, purpose);

        let committed = self.commit_idempotent_smart_mutation(reservation, |conn| {
            let folder_id: Option<String> = conn
                .query_row(
                    "SELECT folder_id FROM folder_items WHERE item_type = 'note' AND item_id = ?1 AND deleted_at IS NULL LIMIT 1",
                    params![target_note_id],
                    |row| row.get(0),
                )
                .optional()?;
            if !folder_id
                .as_ref()
                .map(|id| allowed_folder_ids.contains(id))
                .unwrap_or(false)
            {
                return Err(VfsError::NotFound {
                    resource_type: "MemoryNote".to_string(),
                    id: target_note_id.to_string(),
                });
            }
            let old_note = VfsNoteRepo::get_note_with_conn(conn, target_note_id)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "Note".to_string(),
                    id: target_note_id.to_string(),
                }
            })?;
            VfsNoteRepo::delete_note_with_folder_item_with_conn(conn, target_note_id)?;
            index_unit_repo::purge_index_artifacts_by_resource(conn, &old_note.resource_id)?;
            VfsIndexStateRepo::set_index_state_with_conn(
                conn,
                &old_note.resource_id,
                "disabled",
                None,
                Some("note deleted"),
            )?;

            let replacement = VfsNoteRepo::create_note_in_folder_uncommitted(
                conn,
                VfsCreateNoteParams {
                    title: title.to_string(),
                    content: content.to_string(),
                    tags,
                },
                target_folder_id.as_deref(),
            )?;
            VfsIndexStateRepo::set_index_state_with_conn(
                conn,
                &replacement.resource_id,
                crate::vfs::repos::embedding_repo::INDEX_STATE_PENDING,
                None,
                None,
            )?;
            Ok(CommittedSmartWrite {
                output: SmartWriteOutput {
                    note_id: replacement.id,
                    event: "DELETE".to_string(),
                    is_new: true,
                    confidence,
                    reason,
                    resource_id: Some(replacement.resource_id),
                    downgraded: false,
                },
                deleted_resource_id: Some(old_note.resource_id),
            })
        })?;

        if let Some(resource_id) = committed.deleted_resource_id.as_deref() {
            if let Err(error) = self
                .lance_store
                .delete_by_resource("text", resource_id)
                .await
            {
                warn!(
                    "[Memory] Failed to delete Lance rows for {} after atomic replacement: {}",
                    resource_id, error
                );
            }
        }
        Ok(committed.output)
    }

    fn upsert_study_memory(
        &self,
        folder_path: Option<&str>,
        title: &str,
        content: &str,
        purpose: Option<MemoryPurpose>,
    ) -> VfsResult<SmartWriteOutput> {
        let target_folder_id =
            self.resolve_write_target_folder_id_synchronized(folder_path, true)?;
        let existing = self.find_note_by_title(target_folder_id.as_deref(), title)?;

        if let Some(note) = existing {
            let existing_type = MemoryType::from_tags(&note.tags);
            if existing_type == MemoryType::Study {
                let existing_content =
                    VfsNoteRepo::get_note_content(&self.vfs_db, &note.id)?.unwrap_or_default();
                if Self::same_text(&existing_content, content)
                    && Self::purpose_matches(&note.tags, purpose)
                {
                    return Ok(SmartWriteOutput {
                        note_id: note.id,
                        event: "NONE".to_string(),
                        is_new: false,
                        confidence: 1.0,
                        reason: "同名学习记忆已存在，内容一致，跳过写入".to_string(),
                        resource_id: None,
                        downgraded: false,
                    });
                }

                let updated = self.update_by_id(&note.id, Some(title), Some(content))?;
                self.sync_note_system_tags(&note.id, MemoryType::Study, purpose)?;
                return Ok(SmartWriteOutput {
                    note_id: updated.note_id,
                    event: "UPDATE".to_string(),
                    is_new: false,
                    confidence: 1.0,
                    reason: "同名学习记忆已存在，已更新内容".to_string(),
                    resource_id: Some(updated.resource_id),
                    downgraded: false,
                });
            }
        }

        let result = self.write_typed(
            folder_path,
            title,
            content,
            WriteMode::Create,
            MemoryType::Study,
            purpose,
        )?;
        Ok(SmartWriteOutput {
            note_id: result.note_id,
            event: "ADD".to_string(),
            is_new: true,
            confidence: 1.0,
            reason: "学习记忆类型，已写入".to_string(),
            resource_id: Some(result.resource_id),
            downgraded: false,
        })
    }

    pub fn write_explicit_memory(
        &self,
        folder_path: Option<&str>,
        title: &str,
        content: &str,
        memory_type: MemoryType,
        purpose: Option<MemoryPurpose>,
    ) -> VfsResult<SmartWriteOutput> {
        let purpose = match (memory_type, purpose) {
            (MemoryType::Fact, p) => p,
            (_, Some(MemoryPurpose::Systemic)) => Some(MemoryPurpose::Memorized),
            (_, p) => p,
        };
        match memory_type {
            MemoryType::Note => {
                let result = self.write_typed(
                    folder_path,
                    title,
                    content,
                    WriteMode::Create,
                    MemoryType::Note,
                    purpose,
                )?;
                Ok(SmartWriteOutput {
                    note_id: result.note_id,
                    event: "ADD".to_string(),
                    is_new: true,
                    confidence: 1.0,
                    reason: "经验笔记类型，直接写入".to_string(),
                    resource_id: Some(result.resource_id),
                    downgraded: false,
                })
            }
            MemoryType::Study => self.upsert_study_memory(folder_path, title, content, purpose),
            MemoryType::Fact => Err(VfsError::InvalidArgument {
                param: "memory_type".to_string(),
                reason: "fact 不是显式学习内容写入类型".to_string(),
            }),
        }
    }

    fn write_explicit_memory_idempotent(
        &self,
        folder_path: Option<&str>,
        title: &str,
        content: &str,
        memory_type: MemoryType,
        purpose: Option<MemoryPurpose>,
        source: MemoryOpSource,
        session_id: Option<&str>,
        reservation: Option<&SmartWriteReservation>,
    ) -> VfsResult<SmartWriteOutput> {
        let purpose = match (memory_type, purpose) {
            (MemoryType::Fact, purpose) => purpose,
            (_, Some(MemoryPurpose::Systemic)) => Some(MemoryPurpose::Memorized),
            (_, purpose) => purpose,
        };
        match memory_type {
            MemoryType::Note => self.create_smart_memory(
                folder_path,
                title,
                content,
                MemoryType::Note,
                purpose,
                reservation,
                "ADD",
                1.0,
                "经验笔记类型，直接写入".to_string(),
            ),
            MemoryType::Study => {
                let target_folder_id =
                    self.resolve_write_target_folder_id_synchronized(folder_path, true)?;
                let existing = self.find_note_by_title(target_folder_id.as_deref(), title)?;
                if let Some(note) = existing {
                    if MemoryType::from_tags(&note.tags) == MemoryType::Study {
                        let existing_content =
                            VfsNoteRepo::get_note_content(&self.vfs_db, &note.id)?
                                .unwrap_or_default();
                        if Self::same_text(&existing_content, content)
                            && Self::purpose_matches(&note.tags, purpose)
                        {
                            return Ok(SmartWriteOutput {
                                note_id: note.id,
                                event: "NONE".to_string(),
                                is_new: false,
                                confidence: 1.0,
                                reason: "同名学习记忆已存在，内容一致，跳过写入".to_string(),
                                resource_id: None,
                                downgraded: false,
                            });
                        }
                        return self.update_smart_memory(
                            &note.id,
                            Some(title),
                            content,
                            false,
                            MemoryType::Study,
                            purpose,
                            source,
                            session_id,
                            reservation,
                            "UPDATE",
                            1.0,
                            "同名学习记忆已存在，已更新内容".to_string(),
                        );
                    }
                }
                self.create_smart_memory(
                    folder_path,
                    title,
                    content,
                    MemoryType::Study,
                    purpose,
                    reservation,
                    "ADD",
                    1.0,
                    "学习记忆类型，已写入".to_string(),
                )
            }
            MemoryType::Fact => Err(VfsError::InvalidArgument {
                param: "memory_type".to_string(),
                reason: "fact 不是显式学习内容写入类型".to_string(),
            }),
        }
    }

    /// 智能写入记忆（使用 LLM 决策）
    ///
    /// 自动判断应该新增、更新还是追加到现有记忆
    pub async fn write_smart(
        &self,
        folder_path: Option<&str>,
        title: &str,
        content: &str,
    ) -> VfsResult<SmartWriteOutput> {
        self.write_smart_with_source(
            folder_path,
            title,
            content,
            MemoryOpSource::Handler,
            None,
            MemoryType::Fact,
            None,
            None,
        )
        .await
    }

    /// 智能写入（带来源标记、记忆类型和目的）
    pub async fn write_smart_with_source(
        &self,
        folder_path: Option<&str>,
        title: &str,
        content: &str,
        source: MemoryOpSource,
        session_id: Option<&str>,
        memory_type: MemoryType,
        purpose: Option<MemoryPurpose>,
        idempotency_key: Option<&str>,
    ) -> VfsResult<SmartWriteOutput> {
        let timer = OpTimer::start();
        self.ensure_root_folder_id()?;

        if title.trim().is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "title".to_string(),
                reason: "标题不能为空".to_string(),
            });
        }
        Self::validate_user_writable_title(title)?;
        Self::validate_user_writable_folder_path(folder_path)?;

        if content.trim().is_empty() {
            return Ok(SmartWriteOutput {
                note_id: String::new(),
                event: "NONE".to_string(),
                is_new: false,
                confidence: 1.0,
                reason: "内容为空，跳过写入".to_string(),
                resource_id: None,
                downgraded: false,
            });
        }

        let idempotency_key = idempotency_key.and_then(|k| {
            let trimmed = k.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });
        let mut reservation = None;
        if let Some(key) = idempotency_key {
            for attempt in 0..=20 {
                if let Some(cached) = self.get_cached_smart_write_result(key)? {
                    return Ok(cached);
                }
                if let Some(acquired) = self.try_reserve_smart_write_key(key)? {
                    reservation = Some(acquired);
                    break;
                }
                if attempt < 20 {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            }
            if reservation.is_none() {
                return Err(VfsError::Conflict {
                    key: "memory.idempotency.in_progress".to_string(),
                    message: "同一幂等键请求正在处理中，请稍后重试".to_string(),
                });
            }
        }

        // 🔧 幂等预留泄漏修复：预留成功后，任何 Err 早退路径都必须清掉 in_progress
        // 预留，否则该幂等键会卡死到 TTL 过期（后续同 key 请求一直拿到 Conflict）。
        // decision 主路径的 Err 已由函数末尾统一清理；这里覆盖主路径之前的早退点。
        let cleanup_on_err = |e: VfsError| -> VfsError {
            if let Some(reservation) = reservation.as_ref() {
                let _ = self.clear_smart_write_reservation(reservation);
            }
            e
        };

        if MemoryAutoExtractor::contains_sensitive_pattern_pub(content)
            || MemoryAutoExtractor::contains_sensitive_pattern_pub(title)
        {
            let output = SmartWriteOutput {
                note_id: String::new(),
                event: "FILTERED".to_string(),
                is_new: false,
                confidence: 1.0,
                reason: "内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码），已拦截。".to_string(),
                resource_id: None,
                downgraded: false,
            };
            self.audit_logger
                .log_filtered(source, title, content, &output.reason);
            self.finalize_idempotency_result(reservation.as_ref(), &output)?;
            return Ok(output);
        }

        let max_chars = memory_type.max_content_chars();
        if content.chars().count() > max_chars {
            let output = SmartWriteOutput {
                note_id: String::new(),
                event: "FILTERED".to_string(),
                is_new: false,
                confidence: 1.0,
                reason: format!(
                    "内容超过 {} 字限制（类型: {}）",
                    max_chars,
                    memory_type.as_str()
                ),
                resource_id: None,
                downgraded: false,
            };
            self.audit_logger
                .log_filtered(source, title, content, &output.reason);
            self.finalize_idempotency_result(reservation.as_ref(), &output)?;
            return Ok(output);
        }

        if memory_type == MemoryType::Note {
            self.renew_smart_write_reservation(reservation.as_ref())?;
            let output = self
                .write_explicit_memory_idempotent(
                    folder_path,
                    title,
                    content,
                    MemoryType::Note,
                    purpose,
                    source,
                    session_id,
                    reservation.as_ref(),
                )
                .map_err(cleanup_on_err)?;
            self.finalize_idempotency_result(reservation.as_ref(), &output)?;
            self.audit_logger.log_write_smart_result(
                source,
                title,
                content,
                folder_path,
                &output,
                timer.elapsed_ms(),
                session_id,
            );
            if let Some(resource_id) = &output.resource_id {
                self.index_immediately(resource_id).await;
            }
            return Ok(output);
        }

        if memory_type == MemoryType::Study {
            self.renew_smart_write_reservation(reservation.as_ref())?;
            let output = self
                .write_explicit_memory_idempotent(
                    folder_path,
                    title,
                    content,
                    MemoryType::Study,
                    purpose,
                    source,
                    session_id,
                    reservation.as_ref(),
                )
                .map_err(cleanup_on_err)?;
            self.finalize_idempotency_result(reservation.as_ref(), &output)?;
            self.audit_logger.log_write_smart_result(
                source,
                title,
                content,
                folder_path,
                &output,
                timer.elapsed_ms(),
                session_id,
            );
            if let Some(resource_id) = &output.resource_id {
                self.index_immediately(resource_id).await;
            }
            return Ok(output);
        }

        if let Some(reason) = Self::fact_hard_reject_reason(title, content) {
            let output = SmartWriteOutput {
                note_id: String::new(),
                event: "FILTERED".to_string(),
                is_new: false,
                confidence: 1.0,
                reason: reason.to_string(),
                resource_id: None,
                downgraded: false,
            };
            self.audit_logger
                .log_filtered(source, title, content, reason);
            self.finalize_idempotency_result(reservation.as_ref(), &output)?;
            return Ok(output);
        }

        if self.config.is_privacy_mode().map_err(cleanup_on_err)? {
            // 隐私模式下使用本地标题匹配做基础去重（不涉及外部 API 调用）
            let target_folder_id = self
                .resolve_write_target_folder_id_synchronized(folder_path, false)
                .map_err(cleanup_on_err)?;
            if let Some(existing) = self
                .find_note_by_title(target_folder_id.as_deref(), title)
                .map_err(cleanup_on_err)?
            {
                let output = SmartWriteOutput {
                    note_id: existing.id,
                    event: "NONE".to_string(),
                    is_new: false,
                    confidence: 1.0,
                    reason: "隐私模式：同名记忆已存在（本地标题去重）".to_string(),
                    resource_id: None,
                    downgraded: false,
                };
                self.finalize_idempotency_result(reservation.as_ref(), &output)?;
                return Ok(output);
            }
            self.renew_smart_write_reservation(reservation.as_ref())?;
            let output = self
                .create_smart_memory(
                    folder_path,
                    title,
                    content,
                    memory_type,
                    purpose,
                    reservation.as_ref(),
                    "ADD",
                    1.0,
                    "隐私模式已启用，跳过 LLM 决策并安全降级为新增".to_string(),
                )
                .map_err(cleanup_on_err)?;
            self.finalize_idempotency_result(reservation.as_ref(), &output)?;
            return Ok(output);
        }

        // 1. 先搜索相似记忆（扩大范围以提高冲突检测覆盖率）
        //    embedding 不可用时降级为空结果（跳过去重，直接走 ADD 路径）
        let similar_results = match self
            .search_for_purpose(content, 15, SearchPurpose::InternalDedup)
            .await
        {
            Ok(r) => r,
            Err(e) => {
                warn!(
                    "[Memory] Similar search failed (embedding unavailable?), skipping dedup: {}",
                    e
                );
                vec![]
            }
        };

        // 2. 转换为 LLM 决策需要的格式
        let similar_summaries: Vec<SimilarMemorySummary> = similar_results
            .iter()
            .map(|r| SimilarMemorySummary {
                note_id: r.note_id.clone(),
                title: r.note_title.clone(),
                content_preview: r.chunk_text.clone(),
            })
            .collect();
        let similar_note_ids: HashSet<String> =
            similar_results.iter().map(|r| r.note_id.clone()).collect();

        // 3. 调用 LLM 决策（失败时安全降级为 ADD，不阻塞用户写入意图）
        let llm_decision = MemoryLLMDecision::new(self.llm_manager.clone());
        let decision = match llm_decision
            .decide(content, Some(title), &similar_summaries)
            .await
        {
            Ok(d) => d,
            Err(e) => {
                tracing::warn!("[Memory] LLM 决策失败，降级为 ADD: {}", e);
                MemoryDecisionResponse {
                    event: MemoryEvent::ADD,
                    target_note_id: None,
                    confidence: 0.6,
                    reason: format!("LLM 决策失败（{}），降级为新增", e),
                }
            }
        };

        info!(
            "[Memory] Smart write decision: {:?}, target={:?}, confidence={:.2}",
            decision.event, decision.target_note_id, decision.confidence
        );

        // 低置信度保护：避免 UPDATE/APPEND 误判直接污染记忆。
        if should_downgrade_smart_mutation(&decision.event, decision.confidence) {
            let existing_id = similar_results
                .first()
                .map(|r| r.note_id.clone())
                .unwrap_or_default();
            let output = SmartWriteOutput {
                note_id: existing_id,
                event: "NONE".to_string(),
                is_new: false,
                confidence: decision.confidence,
                reason: format!(
                    "{}（置信度 {:.2} 低于阈值 {:.2}，降级为 NONE）",
                    decision.reason, decision.confidence, SMART_WRITE_MUTATION_CONFIDENCE_THRESHOLD
                ),
                resource_id: None,
                downgraded: true,
            };
            self.finalize_idempotency_result(reservation.as_ref(), &output)?;
            return Ok(output);
        }

        // 4. 根据决策执行操作
        self.renew_smart_write_reservation(reservation.as_ref())?;
        let result: VfsResult<SmartWriteOutput> = async {
            match decision.event {
                MemoryEvent::ADD => self.create_smart_memory(
                    folder_path,
                    title,
                    content,
                    memory_type,
                    purpose,
                    reservation.as_ref(),
                    "ADD",
                    decision.confidence,
                    decision.reason,
                ),
                MemoryEvent::UPDATE => {
                    if let Some(target_id) = decision.target_note_id {
                        if !similar_note_ids.contains(&target_id) {
                            self.create_smart_memory(
                                folder_path,
                                title,
                                content,
                                memory_type,
                                purpose,
                                reservation.as_ref(),
                                "ADD",
                                decision.confidence,
                                format!(
                                    "{}（target_note_id 不在候选集中，降级为 ADD）",
                                    decision.reason
                                ),
                            )
                        } else {
                            match self.update_smart_memory(
                                &target_id,
                                Some(title),
                                content,
                                false,
                                memory_type,
                                purpose,
                                source,
                                session_id,
                                reservation.as_ref(),
                                "UPDATE",
                                decision.confidence,
                                decision.reason.clone(),
                            ) {
                                Ok(output) => Ok(output),
                                Err(VfsError::NotFound { .. }) => self.create_smart_memory(
                                    folder_path,
                                    title,
                                    content,
                                    memory_type,
                                    purpose,
                                    reservation.as_ref(),
                                    "ADD",
                                    decision.confidence,
                                    format!(
                                        "{}（target_note_id 无效，降级为 ADD）",
                                        decision.reason
                                    ),
                                ),
                                Err(error) => Err(error),
                            }
                        }
                    } else {
                        self.create_smart_memory(
                            folder_path,
                            title,
                            content,
                            memory_type,
                            purpose,
                            reservation.as_ref(),
                            "ADD",
                            decision.confidence,
                            "UPDATE 决策但无目标 ID，降级为 ADD".to_string(),
                        )
                    }
                }
                MemoryEvent::APPEND => {
                    if let Some(target_id) = decision.target_note_id {
                        if !similar_note_ids.contains(&target_id) {
                            self.create_smart_memory(
                                folder_path,
                                title,
                                content,
                                memory_type,
                                purpose,
                                reservation.as_ref(),
                                "ADD",
                                decision.confidence,
                                format!(
                                    "{}（target_note_id 不在候选集中，降级为 ADD）",
                                    decision.reason
                                ),
                            )
                        } else {
                            match self.update_smart_memory(
                                &target_id,
                                None,
                                content,
                                true,
                                memory_type,
                                purpose,
                                source,
                                session_id,
                                reservation.as_ref(),
                                "APPEND",
                                decision.confidence,
                                decision.reason.clone(),
                            ) {
                                Ok(output) => Ok(output),
                                Err(VfsError::NotFound { .. }) => self.create_smart_memory(
                                    folder_path,
                                    title,
                                    content,
                                    memory_type,
                                    purpose,
                                    reservation.as_ref(),
                                    "ADD",
                                    decision.confidence,
                                    format!(
                                        "{}（target_note_id 无效，降级为 ADD）",
                                        decision.reason
                                    ),
                                ),
                                Err(error) => Err(error),
                            }
                        }
                    } else {
                        self.create_smart_memory(
                            folder_path,
                            title,
                            content,
                            memory_type,
                            purpose,
                            reservation.as_ref(),
                            "ADD",
                            decision.confidence,
                            "APPEND 决策但无目标 ID，降级为 ADD".to_string(),
                        )
                    }
                }
                MemoryEvent::DELETE => {
                    if let Some(target_id) = decision.target_note_id {
                        if !similar_note_ids.contains(&target_id) {
                            self.create_smart_memory(
                                folder_path,
                                title,
                                content,
                                memory_type,
                                purpose,
                                reservation.as_ref(),
                                "ADD",
                                decision.confidence,
                                format!(
                                    "{}（target_note_id 不在候选集中，降级为 ADD）",
                                    decision.reason
                                ),
                            )
                        } else {
                            self.delete_and_replace_smart_memory(
                                &target_id,
                                folder_path,
                                title,
                                content,
                                memory_type,
                                purpose,
                                source,
                                session_id,
                                reservation.as_ref(),
                                decision.confidence,
                                format!("{}（已删除矛盾记忆 {}）", decision.reason, target_id),
                            )
                            .await
                        }
                    } else {
                        self.create_smart_memory(
                            folder_path,
                            title,
                            content,
                            memory_type,
                            purpose,
                            reservation.as_ref(),
                            "ADD",
                            decision.confidence,
                            "DELETE 决策但无目标 ID，降级为 ADD".to_string(),
                        )
                    }
                }
                MemoryEvent::NONE => {
                    let existing_id = similar_results
                        .first()
                        .map(|result| result.note_id.clone())
                        .unwrap_or_default();
                    Ok(SmartWriteOutput {
                        note_id: existing_id,
                        event: "NONE".to_string(),
                        is_new: false,
                        confidence: decision.confidence,
                        reason: decision.reason,
                        resource_id: None,
                        downgraded: false,
                    })
                }
            }
        }
        .await;

        match &result {
            Ok(output) => {
                // Persist the replayable result before any asynchronous index
                // work. A caller retry after indexing is interrupted must see
                // the completed write instead of executing the mutation again.
                self.finalize_idempotency_result(reservation.as_ref(), output)?;
                self.audit_logger.log_write_smart_result(
                    source,
                    title,
                    content,
                    folder_path,
                    output,
                    timer.elapsed_ms(),
                    session_id,
                );
                if let Some(resource_id) = &output.resource_id {
                    self.index_immediately(resource_id).await;
                }
            }
            Err(e) => {
                self.audit_logger.log_error(
                    source,
                    MemoryOpType::WriteSmart,
                    Some(title),
                    Some(content),
                    folder_path,
                    &e.to_string(),
                    session_id,
                    timer.elapsed_ms(),
                );
                if let Some(reservation) = reservation.as_ref() {
                    let _ = self.clear_smart_write_reservation(reservation);
                }
            }
        }

        result
    }

    /// 带重排序的增强搜索
    pub async fn search_with_rerank(
        &self,
        query: &str,
        top_k: usize,
        use_query_rewrite: bool,
    ) -> VfsResult<Vec<MemorySearchResult>> {
        if self.config.is_privacy_mode()? {
            warn!("[Memory] Privacy mode enabled, skipping search_with_rerank (no external API calls)");
            return Ok(vec![]);
        }

        let final_query = if use_query_rewrite {
            let rewriter = MemoryQueryRewriter::new(self.llm_manager.clone());
            match rewriter.rewrite_simple(query).await {
                Ok(q) => q,
                Err(e) => {
                    warn!("[Memory] Query rewrite failed: {}, using original", e);
                    query.to_string()
                }
            }
        } else {
            query.to_string()
        };

        let reranker = MemoryReranker::new(self.llm_manager.clone()).await;
        let retrieval_k = if reranker.has_reranker_api() {
            top_k * 2
        } else {
            top_k
        };

        let results = self.search(&final_query, retrieval_k).await?;

        let reranked = reranker
            .rerank(query, results)
            .await
            .map_err(|e| VfsError::Other(format!("Rerank failed: {}", e)))?;

        Ok(reranked.into_iter().take(top_k).collect())
    }

    pub fn list(
        &self,
        folder_path: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<MemoryListItem>> {
        self.list_internal(folder_path, limit, offset, true)
    }

    pub fn list_shallow(
        &self,
        folder_path: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<MemoryListItem>> {
        self.list_internal(folder_path, limit, offset, false)
    }

    pub fn count_active_memories(&self) -> VfsResult<u32> {
        let root_id = self.ensure_root_folder_id()?;
        let folder_ids = self.get_memory_folder_ids(&root_id)?;
        if folder_ids.is_empty() {
            return Ok(0);
        }

        let conn = self.vfs_db.get_conn_safe()?;
        let placeholders = vec!["?"; folder_ids.len()].join(", ");
        let sql = format!(
            r#"
            SELECT COUNT(DISTINCT n.id)
            FROM notes n
            JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
            WHERE fi.folder_id IN ({}) AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
              AND n.title NOT LIKE '\_\_%\_\_%' ESCAPE '\'
            "#,
            placeholders
        );
        let mut stmt = conn.prepare(&sql)?;
        let params: Vec<rusqlite::types::Value> = folder_ids
            .into_iter()
            .map(rusqlite::types::Value::from)
            .collect();
        let total: i64 = stmt.query_row(rusqlite::params_from_iter(params), |row| row.get(0))?;
        Ok(total.max(0) as u32)
    }

    fn list_internal(
        &self,
        folder_path: Option<&str>,
        limit: u32,
        offset: u32,
        recursive: bool,
    ) -> VfsResult<Vec<MemoryListItem>> {
        let root_id = self.ensure_root_folder_id()?;

        let target_root_id = if let Some(path) = folder_path {
            if path.is_empty() {
                root_id.clone()
            } else {
                match self.resolve_path_to_folder_id(&root_id, path)? {
                    Some(folder_id) => folder_id,
                    None => return Ok(vec![]),
                }
            }
        } else {
            root_id.clone()
        };

        let folder_ids = if recursive {
            self.get_memory_folder_ids(&target_root_id)?
        } else {
            vec![target_root_id.clone()]
        };
        if folder_ids.is_empty() {
            return Ok(vec![]);
        }

        let conn = self.vfs_db.get_conn_safe()?;
        let placeholders = vec!["?"; folder_ids.len()].join(", ");
        let sql = format!(
            r#"
            SELECT DISTINCT n.id
            FROM notes n
            JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
            WHERE fi.folder_id IN ({}) AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
              AND n.title NOT LIKE '\_\_%\_\_%' ESCAPE '\'
            ORDER BY n.updated_at DESC
            LIMIT ? OFFSET ?
            "#,
            placeholders
        );

        let mut stmt = conn.prepare(&sql)?;
        let mut params: Vec<rusqlite::types::Value> = folder_ids
            .into_iter()
            .map(rusqlite::types::Value::from)
            .collect();
        params.push(rusqlite::types::Value::from(i64::from(limit)));
        params.push(rusqlite::types::Value::from(i64::from(offset)));

        let note_ids = stmt
            .query_map(rusqlite::params_from_iter(params), |row| {
                row.get::<_, String>(0)
            })?
            .collect::<Result<Vec<String>, _>>()?;

        let mut items = Vec::new();
        for note_id in note_ids {
            if let Some(note) = VfsNoteRepo::get_note(&self.vfs_db, &note_id)? {
                let folder_path = self.get_note_folder_path(&note.id)?;
                let hits = Self::extract_hits_from_tags(&note.tags);
                let is_important = note.tags.iter().any(|t| t == "_important");
                let is_stale = note.tags.iter().any(|t| t == "_stale");
                let memory_type = MemoryType::from_tags(&note.tags);
                let memory_purpose = MemoryPurpose::from_tags(&note.tags);
                items.push(MemoryListItem {
                    id: note.id,
                    title: note.title,
                    folder_path,
                    updated_at: note.updated_at,
                    hits,
                    is_important,
                    is_stale,
                    memory_type: memory_type.as_str().to_string(),
                    memory_purpose: memory_purpose.as_str().to_string(),
                });
            }
        }

        Ok(items)
    }

    fn extract_hits_from_tags(tags: &[String]) -> u32 {
        tags.iter()
            .find_map(|t| t.strip_prefix(TAG_HITS_PREFIX).and_then(|v| v.parse().ok()))
            .unwrap_or(0)
    }

    pub fn get_tree(&self) -> VfsResult<Option<FolderTreeNode>> {
        let root_id = self.ensure_root_folder_id()?;

        let root_folder = match VfsFolderRepo::get_folder(&self.vfs_db, &root_id)? {
            Some(f) => f,
            None => return Ok(None),
        };

        let conn = self.vfs_db.get_conn_safe()?;
        let children = self.build_subtree(&conn, &root_id)?;
        let items = VfsFolderRepo::list_items_by_folder(&self.vfs_db, Some(&root_id))?;

        Ok(Some(FolderTreeNode {
            folder: root_folder,
            children,
            items,
        }))
    }

    fn build_subtree(
        &self,
        conn: &rusqlite::Connection,
        parent_id: &str,
    ) -> VfsResult<Vec<FolderTreeNode>> {
        let children_folders =
            VfsFolderRepo::list_folders_by_parent_with_conn(conn, Some(parent_id))?;
        let mut nodes = Vec::new();

        for folder in children_folders {
            let sub_children = self.build_subtree(conn, &folder.id)?;
            let items = VfsFolderRepo::list_items_by_folder_with_conn(conn, Some(&folder.id))?;
            nodes.push(FolderTreeNode {
                folder,
                children: sub_children,
                items,
            });
        }

        nodes.sort_by_key(|a| a.folder.sort_order);
        Ok(nodes)
    }

    fn ensure_folder(&self, root_id: &str, path: &str) -> VfsResult<String> {
        let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let mut current_parent_id = root_id.to_string();

        for part in parts {
            let children =
                VfsFolderRepo::list_folders_by_parent(&self.vfs_db, Some(&current_parent_id))?;

            let existing = children.iter().find(|f| f.title == part);
            if let Some(folder) = existing {
                current_parent_id = folder.id.clone();
            } else {
                let new_folder = VfsFolder::new(
                    part.to_string(),
                    Some(current_parent_id.clone()),
                    None,
                    None,
                );
                VfsFolderRepo::create_folder(&self.vfs_db, &new_folder)?;
                self.invalidate_folder_cache();
                debug!(
                    "[Memory] Created subfolder: {} under {}",
                    part, current_parent_id
                );
                current_parent_id = new_folder.id;
            }
        }

        Ok(current_parent_id)
    }

    fn resolve_path_to_folder_id(&self, root_id: &str, path: &str) -> VfsResult<Option<String>> {
        let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
        let mut current_parent_id = root_id.to_string();

        for part in parts {
            let children =
                VfsFolderRepo::list_folders_by_parent(&self.vfs_db, Some(&current_parent_id))?;

            let existing = children.iter().find(|f| f.title == part);
            if let Some(folder) = existing {
                current_parent_id = folder.id.clone();
            } else {
                return Ok(None);
            }
        }

        Ok(Some(current_parent_id))
    }

    fn resolve_write_target_folder_id_synchronized(
        &self,
        folder_path: Option<&str>,
        strict_missing: bool,
    ) -> VfsResult<Option<String>> {
        let _guard = super::lock_memory_structure();
        let root_id = self.config.get_or_create_root_folder()?;
        self.resolve_write_target_folder_id(folder_path, strict_missing, &root_id)
    }

    fn resolve_write_target_folder_id(
        &self,
        folder_path: Option<&str>,
        strict_missing: bool,
        root_id: &str,
    ) -> VfsResult<Option<String>> {
        let auto_create_subfolders = self.config.is_auto_create_subfolders()?;
        let default_category = self.config.get_default_category()?;
        let has_default_category = !default_category.trim().is_empty();

        if let Some(path) = folder_path {
            if path.is_empty() {
                if has_default_category {
                    if auto_create_subfolders {
                        return Ok(Some(self.ensure_folder(root_id, &default_category)?));
                    }
                    if let Some(existing_default) =
                        self.resolve_path_to_folder_id(root_id, &default_category)?
                    {
                        return Ok(Some(existing_default));
                    }
                }
                return Ok(Some(root_id.to_string()));
            }

            if auto_create_subfolders {
                return Ok(Some(self.ensure_folder(root_id, path)?));
            }

            let found = self.resolve_path_to_folder_id(root_id, path)?;
            if strict_missing {
                let folder_id = found.ok_or_else(|| VfsError::NotFound {
                    resource_type: "Folder".to_string(),
                    id: path.to_string(),
                })?;
                Ok(Some(folder_id))
            } else {
                Ok(found.or_else(|| Some(root_id.to_string())))
            }
        } else if has_default_category {
            if auto_create_subfolders {
                Ok(Some(self.ensure_folder(root_id, &default_category)?))
            } else {
                Ok(self
                    .resolve_path_to_folder_id(root_id, &default_category)?
                    .or_else(|| Some(root_id.to_string())))
            }
        } else {
            Ok(Some(root_id.to_string()))
        }
    }

    fn get_cached_smart_write_result(
        &self,
        idempotency_key: &str,
    ) -> VfsResult<Option<SmartWriteOutput>> {
        let conn = self.vfs_db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();
        let ttl_ms = SMART_WRITE_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000;
        let min_created_at = now_ms - ttl_ms;

        conn.execute(
            r#"
            DELETE FROM memory_write_idempotency
            WHERE created_at < ?1
              AND event != ?2
              AND substr(idempotency_key, 1, length('compaction_flush:')) != 'compaction_flush:'
            "#,
            params![min_created_at, SMART_WRITE_IDEMPOTENCY_IN_PROGRESS],
        )?;

        let row = conn
            .query_row(
                r#"
                SELECT note_id, event, is_new, confidence, reason, resource_id, downgraded
                FROM memory_write_idempotency
                WHERE idempotency_key = ?1
                  AND event != ?2
                LIMIT 1
                "#,
                params![idempotency_key, SMART_WRITE_IDEMPOTENCY_IN_PROGRESS],
                |row| {
                    Ok(SmartWriteOutput {
                        note_id: row.get::<_, Option<String>>(0)?.unwrap_or_default(),
                        event: row.get(1)?,
                        is_new: row.get::<_, i32>(2)? != 0,
                        confidence: row.get(3)?,
                        reason: row.get(4)?,
                        resource_id: row.get(5)?,
                        downgraded: row.get::<_, i32>(6)? != 0,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    /// Compaction receipts outlive the normal 24-hour replay cache because a
    /// crashed chat ledger may be resumed after a long offline period. The
    /// compaction coordinator removes them only after its durable ledger has
    /// recorded completion for the segment.
    pub(crate) fn clear_completed_idempotency_receipts_with_prefix(
        &self,
        prefix: &str,
    ) -> VfsResult<usize> {
        if prefix.is_empty() || !prefix.starts_with("compaction_flush:") {
            return Err(VfsError::InvalidArgument {
                param: "idempotency_prefix".to_string(),
                reason: "仅允许清理 compaction_flush receipt 前缀".to_string(),
            });
        }
        let conn = self.vfs_db.get_conn_safe()?;
        conn.execute(
            r#"
            DELETE FROM memory_write_idempotency
            WHERE substr(idempotency_key, 1, length(?1)) = ?1
              AND event != ?2
            "#,
            params![prefix, SMART_WRITE_IDEMPOTENCY_IN_PROGRESS],
        )
        .map_err(Into::into)
    }

    fn try_reserve_smart_write_key(
        &self,
        idempotency_key: &str,
    ) -> VfsResult<Option<SmartWriteReservation>> {
        let conn = self.vfs_db.get_conn_safe()?;
        let now_ms = chrono::Utc::now().timestamp_millis();
        let owner_token = uuid::Uuid::new_v4().to_string();
        let inserted = conn.execute(
            r#"
            INSERT OR IGNORE INTO memory_write_idempotency
              (idempotency_key, note_id, event, is_new, confidence, reason, resource_id, downgraded, created_at)
            VALUES (?1, ?2, ?3, 0, 1.0, ?4, NULL, 0, ?5)
            "#,
            params![
                idempotency_key,
                "",
                SMART_WRITE_IDEMPOTENCY_IN_PROGRESS,
                owner_token,
                now_ms
            ],
        )?;
        if inserted > 0 {
            return Ok(Some(SmartWriteReservation {
                key: idempotency_key.to_string(),
                owner_token,
            }));
        }

        // A process can die after reserving a key. Reclaim only an expired
        // IN_PROGRESS lease, and fence the previous owner with a fresh token.
        let stale_before = now_ms - SMART_WRITE_IDEMPOTENCY_LEASE_MS;
        let reclaimed = conn.execute(
            r#"
            UPDATE memory_write_idempotency
            SET reason = ?1, created_at = ?2
            WHERE idempotency_key = ?3
              AND event = ?4
              AND created_at <= ?5
            "#,
            params![
                owner_token,
                now_ms,
                idempotency_key,
                SMART_WRITE_IDEMPOTENCY_IN_PROGRESS,
                stale_before
            ],
        )?;
        Ok((reclaimed > 0).then(|| SmartWriteReservation {
            key: idempotency_key.to_string(),
            owner_token,
        }))
    }

    fn renew_smart_write_reservation(
        &self,
        reservation: Option<&SmartWriteReservation>,
    ) -> VfsResult<()> {
        let Some(reservation) = reservation else {
            return Ok(());
        };
        let conn = self.vfs_db.get_conn_safe()?;
        self.renew_smart_write_reservation_with_conn(&conn, reservation)
    }

    fn renew_smart_write_reservation_with_conn(
        &self,
        conn: &Connection,
        reservation: &SmartWriteReservation,
    ) -> VfsResult<()> {
        let renewed = conn.execute(
            r#"
            UPDATE memory_write_idempotency
            SET created_at = ?1
            WHERE idempotency_key = ?2 AND event = ?3 AND reason = ?4
            "#,
            params![
                chrono::Utc::now().timestamp_millis(),
                reservation.key,
                SMART_WRITE_IDEMPOTENCY_IN_PROGRESS,
                reservation.owner_token
            ],
        )?;
        if renewed == 0 {
            return Err(VfsError::Conflict {
                key: "memory.idempotency.lease_lost".to_string(),
                message: "幂等写入租约已失效，已阻止旧执行者提交".to_string(),
            });
        }
        Ok(())
    }

    fn clear_smart_write_reservation(&self, reservation: &SmartWriteReservation) -> VfsResult<()> {
        let conn = self.vfs_db.get_conn_safe()?;
        conn.execute(
            "DELETE FROM memory_write_idempotency WHERE idempotency_key = ?1 AND event = ?2 AND reason = ?3",
            params![
                reservation.key,
                SMART_WRITE_IDEMPOTENCY_IN_PROGRESS,
                reservation.owner_token
            ],
        )?;
        Ok(())
    }

    fn cache_smart_write_result(
        &self,
        reservation: &SmartWriteReservation,
        output: &SmartWriteOutput,
    ) -> VfsResult<()> {
        let conn = self.vfs_db.get_conn_safe()?;
        self.cache_smart_write_result_with_conn(&conn, reservation, output)
    }

    fn cache_smart_write_result_with_conn(
        &self,
        conn: &Connection,
        reservation: &SmartWriteReservation,
        output: &SmartWriteOutput,
    ) -> VfsResult<()> {
        let now_ms = chrono::Utc::now().timestamp_millis();
        let updated = conn.execute(
            r#"
            UPDATE memory_write_idempotency
            SET note_id = ?1,
                event = ?2,
                is_new = ?3,
                confidence = ?4,
                reason = ?5,
                resource_id = ?6,
                downgraded = ?7,
                created_at = ?8
            WHERE idempotency_key = ?9
              AND event = ?10
              AND reason = ?11
            "#,
            params![
                if output.note_id.is_empty() {
                    None::<String>
                } else {
                    Some(output.note_id.clone())
                },
                output.event,
                if output.is_new { 1 } else { 0 },
                output.confidence,
                output.reason,
                output.resource_id.clone(),
                if output.downgraded { 1 } else { 0 },
                now_ms,
                reservation.key,
                SMART_WRITE_IDEMPOTENCY_IN_PROGRESS,
                reservation.owner_token,
            ],
        )?;
        if updated == 0 {
            return Err(VfsError::Conflict {
                key: "memory.idempotency.lease_lost".to_string(),
                message: "幂等写入租约已失效，拒绝覆盖其他执行者的结果".to_string(),
            });
        }
        Ok(())
    }

    fn finalize_idempotency_result(
        &self,
        reservation: Option<&SmartWriteReservation>,
        output: &SmartWriteOutput,
    ) -> VfsResult<()> {
        let Some(reservation) = reservation else {
            return Ok(());
        };
        if let Some(cached) = self.get_cached_smart_write_result(&reservation.key)? {
            if cached == *output {
                return Ok(());
            }
            return Err(VfsError::Conflict {
                key: "memory.idempotency.result_mismatch".to_string(),
                message: "同一幂等键已提交不同结果".to_string(),
            });
        }
        self.cache_smart_write_result(reservation, output)
    }

    fn find_note_by_title(
        &self,
        folder_id: Option<&str>,
        title: &str,
    ) -> VfsResult<Option<VfsNote>> {
        let conn = self.vfs_db.get_conn_safe()?;
        let note: Option<VfsNote> = if let Some(fid) = folder_id {
            conn.query_row(
                r#"
                SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite,
                       n.created_at, n.updated_at, n.deleted_at
                FROM notes n
                JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
                WHERE n.title = ?1 AND fi.folder_id = ?2
                  AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
                LIMIT 1
                "#,
                params![title, fid],
                |row| {
                    let tags_json: String = row.get(3)?;
                    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                    Ok(VfsNote {
                        id: row.get(0)?,
                        resource_id: row.get(1)?,
                        title: row.get(2)?,
                        tags,
                        is_favorite: row.get::<_, i32>(4)? != 0,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                        deleted_at: row.get(7)?,
                    })
                },
            )
            .ok()
        } else {
            // 无 folder_id 时限制在记忆根文件夹范围内搜索，避免匹配到记忆之外的同名笔记
            let root_id = self.ensure_root_folder_id().ok();
            if let Some(ref rid) = root_id {
                conn.query_row(
                    r#"
                    SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite,
                           n.created_at, n.updated_at, n.deleted_at
                    FROM notes n
                    JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
                    WHERE n.title = ?1 AND fi.folder_id = ?2
                      AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
                    LIMIT 1
                    "#,
                    params![title, rid],
                    |row| {
                        let tags_json: String = row.get(3)?;
                        let tags: Vec<String> =
                            serde_json::from_str(&tags_json).unwrap_or_default();
                        Ok(VfsNote {
                            id: row.get(0)?,
                            resource_id: row.get(1)?,
                            title: row.get(2)?,
                            tags,
                            is_favorite: row.get::<_, i32>(4)? != 0,
                            created_at: row.get(5)?,
                            updated_at: row.get(6)?,
                            deleted_at: row.get(7)?,
                        })
                    },
                )
                .ok()
            } else {
                None
            }
        };
        Ok(note)
    }

    fn get_note_by_resource_id(&self, resource_id: &str) -> VfsResult<Option<VfsNote>> {
        let conn = self.vfs_db.get_conn_safe()?;
        let note: Option<VfsNote> = conn
            .query_row(
                r#"
                SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at
                FROM notes WHERE resource_id = ?1 AND deleted_at IS NULL
                "#,
                params![resource_id],
                |row| {
                    let tags_json: String = row.get(3)?;
                    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                    Ok(VfsNote {
                        id: row.get(0)?,
                        resource_id: row.get(1)?,
                        title: row.get(2)?,
                        tags,
                        is_favorite: row.get::<_, i32>(4)? != 0,
                        created_at: row.get(5)?,
                        updated_at: row.get(6)?,
                        deleted_at: row.get(7)?,
                    })
                },
            )
            .ok();
        Ok(note)
    }

    pub fn get_note_folder_path(&self, note_id: &str) -> VfsResult<String> {
        let location = VfsNoteRepo::get_note_location(&self.vfs_db, note_id)?;
        Ok(location.map(|l| l.folder_path).unwrap_or_default())
    }

    /// 返回记忆根目录内的相对文件夹路径，根目录本身表示为 ""。
    ///
    /// 写入与移动 API 接收的都是相对路径；该方法用于生成可直接回传给这些 API 的
    /// 当前位置，避免把记忆根目录标题再次创建成嵌套目录。
    pub fn get_note_relative_folder_path(&self, note_id: &str) -> VfsResult<String> {
        let root_id = self.ensure_root_folder_id()?;
        let root_path = VfsFolderRepo::build_folder_path(&self.vfs_db, &root_id)?;
        let absolute_path = self.get_note_folder_path(note_id)?;
        if absolute_path == root_path {
            return Ok(String::new());
        }
        let relative_prefix = format!("{root_path}/");
        Ok(absolute_path
            .strip_prefix(&relative_prefix)
            .unwrap_or(&absolute_path)
            .to_string())
    }

    // ========================================================================
    // ★ 修复风险2：按 note_id 更新记忆
    // ========================================================================

    /// 按 note_id 更新记忆（避免标题冲突）
    pub fn update_by_id(
        &self,
        note_id: &str,
        title: Option<&str>,
        content: Option<&str>,
    ) -> VfsResult<MemoryWriteOutput> {
        self.update_by_id_with_source(note_id, title, content, MemoryOpSource::Handler, None)
    }

    pub fn update_by_id_with_source(
        &self,
        note_id: &str,
        title: Option<&str>,
        content: Option<&str>,
        source: MemoryOpSource,
        session_id: Option<&str>,
    ) -> VfsResult<MemoryWriteOutput> {
        if title.is_none() && content.is_none() {
            return Err(VfsError::InvalidArgument {
                param: "title/content".to_string(),
                reason: "至少需要提供 title 或 content 之一".to_string(),
            });
        }

        let timer = OpTimer::start();
        let note = self.ensure_note_in_memory_root(note_id)?;
        let memory_type = MemoryType::from_tags(&note.tags);

        if let Some(new_title) = title {
            if new_title.trim().is_empty() {
                return Err(VfsError::InvalidArgument {
                    param: "title".to_string(),
                    reason: "标题不能为空".to_string(),
                });
            }
            Self::validate_user_writable_title(new_title)?;
            if MemoryAutoExtractor::contains_sensitive_pattern_pub(new_title) {
                return Err(VfsError::InvalidArgument {
                    param: "title".to_string(),
                    reason: "标题包含敏感信息（手机号/身份证/银行卡/邮箱/密码）".to_string(),
                });
            }
        }

        if let Some(new_content) = content {
            if MemoryAutoExtractor::contains_sensitive_pattern_pub(new_content) {
                return Err(VfsError::InvalidArgument {
                    param: "content".to_string(),
                    reason: "内容包含敏感信息（手机号/身份证/银行卡/邮箱/密码）".to_string(),
                });
            }
            let max_chars = memory_type.max_content_chars();
            if new_content.chars().count() > max_chars {
                return Err(VfsError::InvalidArgument {
                    param: "content".to_string(),
                    reason: format!(
                        "内容超过 {} 字限制（类型: {}）",
                        max_chars,
                        memory_type.as_str()
                    ),
                });
            }
        }

        let updated_note = VfsNoteRepo::update_note(
            &self.vfs_db,
            note_id,
            VfsUpdateNoteParams {
                title: title.map(|s| s.to_string()),
                content: content.map(|s| s.to_string()),
                tags: None,
                expected_updated_at: Some(note.updated_at.clone()),
            },
        )?;

        if let Err(e) = VfsIndexStateRepo::mark_pending(&self.vfs_db, &updated_note.resource_id) {
            warn!("[Memory] Failed to mark pending for indexing: {}", e);
        }

        info!(
            "[Memory] Updated note by ID: {} (resource_id={}) — marked pending for immediate indexing",
            note_id, updated_note.resource_id
        );

        self.audit_logger.log(&super::audit_log::MemoryAuditEntry {
            source,
            operation: MemoryOpType::Update,
            success: true,
            note_id: Some(note.id.clone()),
            title: title.map(|s| s.to_string()),
            content_preview: content.map(|s| s.to_string()),
            folder: None,
            event: Some("UPDATE".to_string()),
            confidence: None,
            reason: None,
            session_id: session_id.map(|s| s.to_string()),
            duration_ms: Some(timer.elapsed_ms()),
            extra_json: None,
        });

        Ok(MemoryWriteOutput {
            note_id: note.id,
            is_new: false,
            resource_id: updated_note.resource_id,
        })
    }

    // ========================================================================
    // ★ 修复风险3：删除记忆
    // ========================================================================

    /// 删除记忆（软删除）
    pub async fn delete(&self, note_id: &str) -> VfsResult<()> {
        self.delete_with_source(note_id, MemoryOpSource::Handler, None)
            .await
    }

    pub async fn delete_with_source(
        &self,
        note_id: &str,
        source: MemoryOpSource,
        session_id: Option<&str>,
    ) -> VfsResult<()> {
        let timer = OpTimer::start();
        let note = self.ensure_note_in_memory_root(note_id)?;
        let note_title = note.title.clone();

        VfsNoteRepo::delete_note_with_folder_item(&self.vfs_db, note_id)?;
        // 先完成主存储删除，再做索引侧清理，避免“笔记还在但向量已删”的半成功状态。
        if let Err(e) = self
            .lance_store
            .delete_by_resource("text", &note.resource_id)
            .await
        {
            warn!(
                "[Memory] Failed to delete lance index for {} (will rely on disabled state): {}",
                note.resource_id, e
            );
        }
        if let Ok(conn) = self.vfs_db.get_conn() {
            // ★ A2-X1：改用 purge_index_artifacts_by_resource——删除 units 前先把段的
            // lance_row_id 入 __lance_orphan_queue。即便上面的直接 Lance 删除失败（仅 warn），
            // 后台 drain 也能兜底清理孤儿向量；幂等，重复入列/删除均安全。
            if let Err(e) =
                index_unit_repo::purge_index_artifacts_by_resource(&conn, &note.resource_id)
            {
                warn!(
                    "[Memory] Failed to purge index artifacts for {}: {}",
                    note.resource_id, e
                );
            }
        }
        if let Err(e) = VfsIndexStateRepo::mark_disabled_with_reason(
            &self.vfs_db,
            &note.resource_id,
            "note deleted",
        ) {
            warn!(
                "[Memory] Failed to mark index disabled for {}: {}",
                note.resource_id, e
            );
        }
        info!("[Memory] Deleted note: {}", note_id);

        self.audit_logger.log(&super::audit_log::MemoryAuditEntry {
            source,
            operation: MemoryOpType::Delete,
            success: true,
            note_id: Some(note_id.to_string()),
            title: Some(note_title),
            content_preview: None,
            folder: None,
            event: Some("DELETE".to_string()),
            confidence: None,
            reason: None,
            session_id: session_id.map(|s| s.to_string()),
            duration_ms: Some(timer.elapsed_ms()),
            extra_json: None,
        });

        Ok(())
    }

    // ========================================================================
    // 关联型记忆（轻量 _ref: 标签方案）
    // ========================================================================

    fn validate_expected_note_version(note: &VfsNote, expected_updated_at: &str) -> VfsResult<()> {
        let expected_updated_at = expected_updated_at.trim();
        if expected_updated_at.is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "expected_updated_at".to_string(),
                reason: "expected_updated_at must not be empty".to_string(),
            });
        }
        if note.updated_at != expected_updated_at {
            return Err(VfsError::Conflict {
                key: "notes.conflict".to_string(),
                message: "The memory note has changed since it was read; refresh before retrying."
                    .to_string(),
            });
        }
        Ok(())
    }

    /// 添加记忆关联（双向）：A 和 B 互相引用。
    ///
    /// 旧 handler 仍可使用该入口；它会读取一次最新版本并透传到 OCC 实现。
    pub fn add_relation(&self, note_id_a: &str, note_id_b: &str) -> VfsResult<()> {
        let note_a = self.ensure_note_in_memory_root(note_id_a)?;
        let note_b = self.ensure_note_in_memory_root(note_id_b)?;
        self.add_relation_with_occ(
            note_id_a,
            &note_a.updated_at,
            note_id_b,
            &note_b.updated_at,
            MemoryOpSource::Handler,
            None,
        )
        .map(|_| ())
    }

    /// 使用调用方读取到的两个 `updated_at` 版本原子添加双向关联。
    ///
    /// 返回 A、B 的写后快照以及本次是否实际改变了关系。
    pub fn add_relation_with_occ(
        &self,
        note_id_a: &str,
        expected_updated_at_a: &str,
        note_id_b: &str,
        expected_updated_at_b: &str,
        source: MemoryOpSource,
        session_id: Option<&str>,
    ) -> VfsResult<(VfsNote, VfsNote, bool)> {
        if note_id_a == note_id_b {
            return Err(VfsError::Other("不能将记忆与自身建立关联".to_string()));
        }
        self.ensure_note_in_memory_root(note_id_a)?;
        self.ensure_note_in_memory_root(note_id_b)?;
        let conn = self.vfs_db.get_conn_safe()?;
        let note_a = VfsNoteRepo::get_note_with_conn(&conn, note_id_a)?.ok_or_else(|| {
            VfsError::NotFound {
                resource_type: "MemoryNote".to_string(),
                id: note_id_a.to_string(),
            }
        })?;
        let note_b = VfsNoteRepo::get_note_with_conn(&conn, note_id_b)?.ok_or_else(|| {
            VfsError::NotFound {
                resource_type: "MemoryNote".to_string(),
                id: note_id_b.to_string(),
            }
        })?;
        Self::validate_expected_note_version(&note_a, expected_updated_at_a)?;
        Self::validate_expected_note_version(&note_b, expected_updated_at_b)?;

        let ref_tag_ab = format!("{}{}", TAG_REF_PREFIX, note_id_b);
        let ref_tag_ba = format!("{}{}", TAG_REF_PREFIX, note_id_a);
        conn.execute("SAVEPOINT memory_add_relation", [])?;
        let tx_result: VfsResult<(VfsNote, VfsNote, bool)> = (|| {
            let mut tags_a = note_a.tags.clone();
            let changed_a = !tags_a.contains(&ref_tag_ab);
            let updated_a = if changed_a {
                tags_a.push(ref_tag_ab);
                VfsNoteRepo::update_note_with_conn(
                    &conn,
                    note_id_a,
                    VfsUpdateNoteParams {
                        tags: Some(tags_a),
                        expected_updated_at: Some(note_a.updated_at.clone()),
                        ..Default::default()
                    },
                )?
            } else {
                note_a.clone()
            };

            let mut tags_b = note_b.tags.clone();
            let changed_b = !tags_b.contains(&ref_tag_ba);
            let updated_b = if changed_b {
                tags_b.push(ref_tag_ba);
                VfsNoteRepo::update_note_with_conn(
                    &conn,
                    note_id_b,
                    VfsUpdateNoteParams {
                        tags: Some(tags_b),
                        expected_updated_at: Some(note_b.updated_at.clone()),
                        ..Default::default()
                    },
                )?
            } else {
                note_b.clone()
            };
            Ok((updated_a, updated_b, changed_a || changed_b))
        })();
        let result = match tx_result {
            Ok(result) => {
                conn.execute("RELEASE memory_add_relation", [])?;
                result
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO memory_add_relation", []);
                let _ = conn.execute("RELEASE memory_add_relation", []);
                return Err(e);
            }
        };

        info!("[Memory] Added relation: {} <-> {}", note_id_a, note_id_b);

        self.audit_logger.log(&super::audit_log::MemoryAuditEntry {
            source,
            operation: MemoryOpType::AddRelation,
            success: true,
            note_id: Some(note_id_a.to_string()),
            title: None,
            content_preview: None,
            folder: None,
            event: None,
            confidence: None,
            reason: Some(format!("关联 {} <-> {}", note_id_a, note_id_b)),
            session_id: session_id.map(str::to_string),
            duration_ms: None,
            extra_json: None,
        });

        Ok(result)
    }

    /// 移除记忆关联（双向）
    pub fn remove_relation(&self, note_id_a: &str, note_id_b: &str) -> VfsResult<()> {
        let note_a = self.ensure_note_in_memory_root(note_id_a)?;
        let note_b = self.ensure_note_in_memory_root(note_id_b)?;
        self.remove_relation_with_occ(
            note_id_a,
            &note_a.updated_at,
            note_id_b,
            &note_b.updated_at,
            MemoryOpSource::Handler,
            None,
        )
        .map(|_| ())
    }

    /// 使用调用方读取到的两个 `updated_at` 版本原子移除双向关联。
    pub fn remove_relation_with_occ(
        &self,
        note_id_a: &str,
        expected_updated_at_a: &str,
        note_id_b: &str,
        expected_updated_at_b: &str,
        source: MemoryOpSource,
        session_id: Option<&str>,
    ) -> VfsResult<(VfsNote, VfsNote, bool)> {
        if note_id_a == note_id_b {
            return Err(VfsError::InvalidArgument {
                param: "note_id_b".to_string(),
                reason: "relation endpoints must be different".to_string(),
            });
        }
        self.ensure_note_in_memory_root(note_id_a)?;
        self.ensure_note_in_memory_root(note_id_b)?;
        let conn = self.vfs_db.get_conn_safe()?;
        let note_a = VfsNoteRepo::get_note_with_conn(&conn, note_id_a)?.ok_or_else(|| {
            VfsError::NotFound {
                resource_type: "MemoryNote".to_string(),
                id: note_id_a.to_string(),
            }
        })?;
        let note_b = VfsNoteRepo::get_note_with_conn(&conn, note_id_b)?.ok_or_else(|| {
            VfsError::NotFound {
                resource_type: "MemoryNote".to_string(),
                id: note_id_b.to_string(),
            }
        })?;
        Self::validate_expected_note_version(&note_a, expected_updated_at_a)?;
        Self::validate_expected_note_version(&note_b, expected_updated_at_b)?;

        let ref_tag_ab = format!("{}{}", TAG_REF_PREFIX, note_id_b);
        let ref_tag_ba = format!("{}{}", TAG_REF_PREFIX, note_id_a);
        conn.execute("SAVEPOINT memory_remove_relation", [])?;
        let tx_result: VfsResult<(VfsNote, VfsNote, bool)> = (|| {
            let tags_a: Vec<String> = note_a
                .tags
                .iter()
                .filter(|t| *t != &ref_tag_ab)
                .cloned()
                .collect();
            let changed_a = tags_a.len() != note_a.tags.len();
            let updated_a = if changed_a {
                VfsNoteRepo::update_note_with_conn(
                    &conn,
                    note_id_a,
                    VfsUpdateNoteParams {
                        tags: Some(tags_a),
                        expected_updated_at: Some(note_a.updated_at.clone()),
                        ..Default::default()
                    },
                )?
            } else {
                note_a.clone()
            };

            let tags_b: Vec<String> = note_b
                .tags
                .iter()
                .filter(|t| *t != &ref_tag_ba)
                .cloned()
                .collect();
            let changed_b = tags_b.len() != note_b.tags.len();
            let updated_b = if changed_b {
                VfsNoteRepo::update_note_with_conn(
                    &conn,
                    note_id_b,
                    VfsUpdateNoteParams {
                        tags: Some(tags_b),
                        expected_updated_at: Some(note_b.updated_at.clone()),
                        ..Default::default()
                    },
                )?
            } else {
                note_b.clone()
            };
            Ok((updated_a, updated_b, changed_a || changed_b))
        })();
        let result = match tx_result {
            Ok(result) => {
                conn.execute("RELEASE memory_remove_relation", [])?;
                result
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO memory_remove_relation", []);
                let _ = conn.execute("RELEASE memory_remove_relation", []);
                return Err(e);
            }
        };

        info!("[Memory] Removed relation: {} <-> {}", note_id_a, note_id_b);

        self.audit_logger.log(&super::audit_log::MemoryAuditEntry {
            source,
            operation: MemoryOpType::RemoveRelation,
            success: true,
            note_id: Some(note_id_a.to_string()),
            title: None,
            content_preview: None,
            folder: None,
            event: None,
            confidence: None,
            reason: Some(format!("解除关联 {} <-> {}", note_id_a, note_id_b)),
            session_id: session_id.map(str::to_string),
            duration_ms: None,
            extra_json: None,
        });

        Ok(result)
    }

    /// 获取与指定记忆关联的所有记忆 ID
    pub fn get_related_ids(&self, note_id: &str) -> VfsResult<Vec<String>> {
        let note = self.ensure_note_in_memory_root(note_id)?;
        Ok(note
            .tags
            .iter()
            .filter_map(|t| t.strip_prefix(TAG_REF_PREFIX).map(|s| s.to_string()))
            .collect())
    }

    // ========================================================================
    // 标签管理
    // ========================================================================

    /// 更新记忆的标签列表（保护系统标签）
    ///
    /// 系统标签（以 `_` 开头）会自动保留，用户只能修改非系统标签。
    /// 传入的 tags 中以 `_` 开头的条目会被静默忽略。
    pub fn update_tags(&self, note_id: &str, user_tags: Vec<String>) -> VfsResult<()> {
        let note = self.ensure_note_in_memory_root(note_id)?;
        self.update_tags_with_occ(
            note_id,
            &note.updated_at,
            user_tags,
            MemoryOpSource::Handler,
            None,
        )
        .map(|_| ())
    }

    /// 使用调用方读取到的 `updated_at` 更新用户标签，系统标签始终保留。
    /// 返回写前与写后快照。
    pub fn update_tags_with_occ(
        &self,
        note_id: &str,
        expected_updated_at: &str,
        user_tags: Vec<String>,
        source: MemoryOpSource,
        session_id: Option<&str>,
    ) -> VfsResult<(VfsNote, VfsNote)> {
        let note = self.ensure_note_in_memory_root(note_id)?;
        Self::validate_expected_note_version(&note, expected_updated_at)?;

        let system_tags: Vec<String> = note
            .tags
            .iter()
            .filter(|t| t.starts_with('_'))
            .cloned()
            .collect();
        let filtered_user_tags: Vec<String> = user_tags
            .into_iter()
            .filter(|t| !t.starts_with('_'))
            .collect();

        let mut merged = system_tags;
        merged.extend(filtered_user_tags);

        let updated = VfsNoteRepo::update_note(
            &self.vfs_db,
            note_id,
            VfsUpdateNoteParams {
                tags: Some(merged),
                expected_updated_at: Some(expected_updated_at.trim().to_string()),
                ..Default::default()
            },
        )?;
        info!(
            "[Memory] Updated user tags for note {} (system tags preserved)",
            note_id
        );

        self.audit_logger.log(&super::audit_log::MemoryAuditEntry {
            source,
            operation: MemoryOpType::UpdateTags,
            success: true,
            note_id: Some(note_id.to_string()),
            title: None,
            content_preview: None,
            folder: None,
            event: None,
            confidence: None,
            reason: None,
            session_id: session_id.map(str::to_string),
            duration_ms: None,
            extra_json: None,
        });

        Ok((note, updated))
    }

    /// 获取记忆的标签列表
    pub fn get_tags(&self, note_id: &str) -> VfsResult<Vec<String>> {
        let note = self.ensure_note_in_memory_root(note_id)?;
        Ok(note.tags)
    }

    /// 移动记忆到指定文件夹路径（在记忆根目录内）
    pub fn move_to_folder(&self, note_id: &str, target_folder_path: &str) -> VfsResult<()> {
        let note = self.ensure_note_in_memory_root(note_id)?;
        self.move_to_folder_with_occ(
            note_id,
            &note.updated_at,
            target_folder_path,
            MemoryOpSource::Handler,
            None,
        )
        .map(|_| ())
    }

    /// 使用调用方读取到的 `updated_at` 移动记忆，并原子推进笔记版本。
    /// 返回写后快照与移动前文件夹路径。
    pub fn move_to_folder_with_occ(
        &self,
        note_id: &str,
        expected_updated_at: &str,
        target_folder_path: &str,
        source: MemoryOpSource,
        session_id: Option<&str>,
    ) -> VfsResult<(VfsNote, String)> {
        Self::validate_user_writable_folder_path(Some(target_folder_path))?;
        let root_id = self.ensure_root_folder_id()?;
        let note = self.ensure_note_in_memory_root(note_id)?;
        Self::validate_expected_note_version(&note, expected_updated_at)?;
        let previous_folder_path = self.get_note_relative_folder_path(note_id)?;

        let target_folder_id = if target_folder_path.is_empty() {
            root_id
        } else {
            self.ensure_folder(&root_id, target_folder_path)?
        };

        let conn = self.vfs_db.get_conn_safe()?;
        let current_note =
            VfsNoteRepo::get_note_with_conn(&conn, note_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "MemoryNote".to_string(),
                id: note_id.to_string(),
            })?;
        Self::validate_expected_note_version(&current_note, expected_updated_at)?;
        conn.execute("SAVEPOINT memory_move_to_folder", [])?;
        let tx_result: VfsResult<VfsNote> = (|| {
            let updated = VfsNoteRepo::update_note_with_conn(
                &conn,
                note_id,
                VfsUpdateNoteParams {
                    expected_updated_at: Some(expected_updated_at.trim().to_string()),
                    ..Default::default()
                },
            )?;
            VfsFolderRepo::move_item_by_item_id_with_conn(
                &conn,
                "note",
                note_id,
                Some(&target_folder_id),
            )?;
            Ok(updated)
        })();
        let updated = match tx_result {
            Ok(updated) => {
                conn.execute("RELEASE memory_move_to_folder", [])?;
                updated
            }
            Err(error) => {
                let _ = conn.execute("ROLLBACK TO memory_move_to_folder", []);
                let _ = conn.execute("RELEASE memory_move_to_folder", []);
                return Err(error);
            }
        };

        self.invalidate_folder_cache();
        info!(
            "[Memory] Moved note {} to folder path '{}'",
            note_id, target_folder_path
        );

        self.audit_logger.log(&super::audit_log::MemoryAuditEntry {
            source,
            operation: MemoryOpType::Move,
            success: true,
            note_id: Some(note_id.to_string()),
            title: None,
            content_preview: None,
            folder: Some(target_folder_path.to_string()),
            event: None,
            confidence: None,
            reason: None,
            session_id: session_id.map(str::to_string),
            duration_ms: None,
            extra_json: None,
        });

        Ok((updated, previous_folder_path))
    }

    fn sync_note_system_tags(
        &self,
        note_id: &str,
        memory_type: MemoryType,
        purpose: Option<MemoryPurpose>,
    ) -> VfsResult<()> {
        let note = self.ensure_note_in_memory_root(note_id)?;
        let mut merged: Vec<String> = note
            .tags
            .iter()
            .filter(|tag| !tag.starts_with(TAG_TYPE_PREFIX) && !tag.starts_with(TAG_PURPOSE_PREFIX))
            .cloned()
            .collect();
        if let Some(tag) = Self::non_fact_type_tag(memory_type) {
            merged.push(tag);
        }
        if let Some(p) = purpose {
            merged.push(p.to_tag());
        }
        VfsNoteRepo::update_note(
            &self.vfs_db,
            note_id,
            VfsUpdateNoteParams {
                tags: Some(merged),
                expected_updated_at: Some(note.updated_at),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    fn ensure_note_in_memory_root(&self, note_id: &str) -> VfsResult<VfsNote> {
        let root_id = self.ensure_root_folder_id()?;

        let note =
            VfsNoteRepo::get_note(&self.vfs_db, note_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "Note".to_string(),
                id: note_id.to_string(),
            })?;

        if !self.is_note_in_memory_root(note_id, &root_id)? {
            return Err(VfsError::NotFound {
                resource_type: "MemoryNote".to_string(),
                id: note_id.to_string(),
            });
        }

        Ok(note)
    }

    fn is_note_in_memory_root(&self, note_id: &str, root_id: &str) -> VfsResult<bool> {
        let location = VfsNoteRepo::get_note_location(&self.vfs_db, note_id)?;
        let folder_id = match location.and_then(|loc| loc.folder_id) {
            Some(id) => id,
            None => return Ok(false),
        };

        if folder_id == root_id {
            return Ok(true);
        }

        let folder_ids = self.get_memory_folder_ids(root_id)?;
        Ok(folder_ids.contains(&folder_id))
    }

    /// 根据记忆标签计算搜索分数权重（含 purpose 加权）
    fn compute_tag_weight(tags: &[String]) -> f32 {
        let mut weight = 1.0f32;
        for tag in tags {
            if tag == "_important" {
                weight *= 1.25;
            } else if tag == "_stale" {
                weight *= 0.6;
            }
        }
        weight *= MemoryPurpose::from_tags(tags).search_weight();
        weight
    }

    // ========================================================================
    // 用户画像摘要
    // ========================================================================

    /// 获取用户画像摘要（从特殊笔记读取，不存在时返回 None）
    ///
    /// 查找顺序：__system__ 子文件夹 → 根文件夹（向后兼容）
    pub fn get_profile_summary(&self) -> VfsResult<Option<String>> {
        let root_id = match self.config.get_root_folder_id()? {
            Some(id) => id,
            None => return Ok(None),
        };
        if let Some(sys_id) = self.find_system_folder_id(&root_id)? {
            if let Some(note) = self.find_note_by_title(Some(&sys_id), PROFILE_NOTE_TITLE)? {
                let content =
                    VfsNoteRepo::get_note_content(&self.vfs_db, &note.id)?.unwrap_or_default();
                if !content.is_empty() {
                    return Ok(Some(content));
                }
            }
        }
        match self.find_note_by_title(Some(&root_id), PROFILE_NOTE_TITLE)? {
            Some(note) => {
                let content =
                    VfsNoteRepo::get_note_content(&self.vfs_db, &note.id)?.unwrap_or_default();
                if content.is_empty() {
                    Ok(None)
                } else {
                    Ok(Some(content))
                }
            }
            None => Ok(None),
        }
    }

    /// 获取记忆根文件夹 ID（公开接口，供外部调用方获取记忆文件夹 ID 以排除全局搜索）
    pub fn get_root_folder_id(&self) -> VfsResult<Option<String>> {
        self.config.get_root_folder_id()
    }

    /// 刷新用户画像摘要笔记（LLM 结构化生成版本）
    ///
    /// 受 memU 自进化理念启发：用 LLM 将原子事实聚合为结构化画像，
    /// 而非简单的列表拼接。
    pub fn refresh_profile_summary(&self) -> VfsResult<()> {
        let sys_folder_id = self.get_or_create_system_folder_id()?;
        let all_memories = self.list(None, PROFILE_MAX_ITEMS as u32, 0)?;

        if all_memories.is_empty() {
            return Ok(());
        }

        let mut facts: Vec<(&str, String)> = Vec::new();
        for mem in &all_memories {
            if mem.title.starts_with("__") {
                continue;
            }
            if mem.memory_type == "note" {
                facts.push((&mem.folder_path, format!("[经验笔记] {}", mem.title)));
                continue;
            }
            if mem.memory_type == "study" {
                facts.push((&mem.folder_path, format!("[学习记忆] {}", mem.title)));
                continue;
            }
            let content = VfsNoteRepo::get_note_content(&self.vfs_db, &mem.id)?.unwrap_or_default();
            let text = if !content.is_empty() {
                content
            } else {
                mem.title.clone()
            };
            facts.push((&mem.folder_path, text));
        }

        if facts.is_empty() {
            return Ok(());
        }

        let profile_content = Self::generate_structured_profile(&facts);

        match self.find_note_by_title(Some(&sys_folder_id), PROFILE_NOTE_TITLE)? {
            Some(note) => {
                VfsNoteRepo::update_note(
                    &self.vfs_db,
                    &note.id,
                    VfsUpdateNoteParams {
                        title: None,
                        content: Some(profile_content),
                        tags: None,
                        expected_updated_at: None,
                    },
                )?;
                debug!("[Memory] Profile summary updated ({} facts)", facts.len());
            }
            None => {
                let profile_note = VfsNoteRepo::create_note_in_folder(
                    &self.vfs_db,
                    VfsCreateNoteParams {
                        title: PROFILE_NOTE_TITLE.to_string(),
                        content: profile_content,
                        tags: vec!["_system".to_string()],
                    },
                    Some(&sys_folder_id),
                )?;
                if let Err(e) = VfsIndexStateRepo::mark_disabled_with_reason(
                    &self.vfs_db,
                    &profile_note.resource_id,
                    "system profile note",
                ) {
                    warn!(
                        "[Memory] Failed to disable indexing for profile note: {}",
                        e
                    );
                }
                debug!("[Memory] Profile summary created ({} facts)", facts.len());
            }
        }

        Ok(())
    }

    /// 从原子事实生成结构化画像（纯同步，无 LLM 调用）
    ///
    /// LLM 结构化聚合由 CategoryManager 负责（生成 __cat_*__ 分类文件）。
    /// 此方法按记忆自身的 folder_path 分组，作为 system prompt 注入的回退。
    fn generate_structured_profile(facts: &[(&str, String)]) -> String {
        let mut grouped: std::collections::BTreeMap<&str, Vec<&str>> =
            std::collections::BTreeMap::new();
        for (folder, text) in facts {
            let key = if folder.is_empty() { "其他" } else { folder };
            grouped.entry(key).or_default().push(text);
        }

        let mut sections = Vec::new();
        for (folder, items) in &grouped {
            let lines: Vec<String> = items.iter().map(|f| format!("- {}", f)).collect();
            sections.push(format!("## {}\n{}", folder, lines.join("\n")));
        }

        sections.join("\n\n")
    }

    // ========================================================================
    // 访问追踪 + 时间衰减
    // ========================================================================

    /// 记录搜索命中（直接 SQL 更新 tags，不触发 updated_at 变更以免重置时间衰减）
    pub fn record_search_hits(&self, note_ids: &[String]) {
        let now_ms = chrono::Utc::now().timestamp_millis().to_string();
        let conn = match self.vfs_db.get_conn_safe() {
            Ok(c) => c,
            Err(_) => return,
        };
        if let Err(e) = conn.execute_batch("BEGIN IMMEDIATE") {
            warn!(
                "[Memory] Failed to begin transaction for search hits: {}",
                e
            );
            return;
        }
        let tx_result = {
            for note_id in note_ids {
                let tags_json: Option<String> = conn
                    .query_row(
                        "SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                        params![note_id],
                        |row| row.get(0),
                    )
                    .ok();
                let Some(tags_json) = tags_json else { continue };
                let mut tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();

                let mut hits: u32 = 1;
                tags.retain(|t| {
                    if let Some(val) = t.strip_prefix(TAG_HITS_PREFIX) {
                        hits = val.parse::<u32>().unwrap_or(0) + 1;
                        false
                    } else if t.starts_with(TAG_LAST_HIT_PREFIX) {
                        false
                    } else {
                        t != "_stale"
                    }
                });
                tags.push(format!("{}{}", TAG_HITS_PREFIX, hits));
                tags.push(format!("{}{}", TAG_LAST_HIT_PREFIX, now_ms));

                let new_tags_json = serde_json::to_string(&tags).unwrap_or_default();
                if let Err(e) = conn.execute(
                    "UPDATE notes SET tags = ?1 WHERE id = ?2",
                    params![new_tags_json, note_id],
                ) {
                    warn!(
                        "[Memory] Failed to record search hit for {}: {}",
                        note_id, e
                    );
                }
            }
            conn.execute_batch("COMMIT")
        };
        if let Err(e) = tx_result {
            let _ = conn.execute_batch("ROLLBACK");
            warn!("[Memory] Failed to commit search hits transaction: {}", e);
        }
    }

    /// 对搜索结果应用时间衰减（利用结果中携带的 updated_at，无额外查询）
    pub fn apply_time_decay(&self, results: &mut [MemorySearchResult]) {
        let now = chrono::Utc::now();
        let now_ms = now.timestamp_millis() as f64;
        for r in results.iter_mut() {
            let age_days = if let Some(ref ts) = r.updated_at {
                if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
                    (now - dt.with_timezone(&chrono::Utc)).num_seconds().max(0) as f64 / 86400.0
                } else if let Ok(ms) = ts.parse::<f64>() {
                    ((now_ms - ms) / (1000.0 * 86400.0)).max(0.0)
                } else {
                    0.0
                }
            } else {
                0.0
            };
            let decay = (0.5_f64).powf(age_days / TIME_DECAY_HALF_LIFE_DAYS);
            r.score *= decay as f32;
        }
        results.sort_by(|a, b| {
            b.score
                .partial_cmp(&a.score)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn memory_search_uses_lexical_route_without_te_and_ignores_bare_vector() {
        let (_temp_dir, vfs_db, service) = crate::memory::test_support::setup_memory_service();
        let written = service
            .write(
                None,
                "Lexical memory",
                "profile planner lexical fallback",
                WriteMode::Create,
            )
            .expect("create memory");
        let conn = vfs_db.get_conn_safe().expect("open vfs");
        crate::vfs::repos::index_unit_repo::create(
            &conn,
            crate::vfs::repos::index_unit_repo::CreateUnitInput {
                resource_id: written.resource_id,
                unit_index: 0,
                image_blob_hash: None,
                image_mime_type: None,
                text_content: Some("profile planner lexical fallback".to_string()),
                text_source: Some("native".to_string()),
            },
        )
        .expect("create lexical unit");
        drop(conn);

        let lexical = service
            .search_for_purpose("planner lexical fallback", 5, SearchPurpose::InternalDedup)
            .await
            .expect("lexical search without TE");
        assert_eq!(lexical.len(), 1);
        assert_eq!(lexical[0].note_id, written.note_id);

        let incompatible_bare_vector = [1.0_f32, 2.0, 3.0];
        let compatibility = service
            .search_with_embedding_for_purpose(
                "planner lexical fallback",
                &incompatible_bare_vector,
                5,
                SearchPurpose::InternalDedup,
            )
            .await
            .expect("bare vector must not select a VFS profile");
        assert_eq!(compatibility.len(), 1);
        assert_eq!(compatibility[0].note_id, written.note_id);
    }

    #[test]
    fn test_write_mode_from_str() {
        assert_eq!(WriteMode::from_str("create"), WriteMode::Create);
        assert_eq!(WriteMode::from_str("update"), WriteMode::Update);
        assert_eq!(WriteMode::from_str("append"), WriteMode::Append);
        assert_eq!(WriteMode::from_str("CREATE"), WriteMode::Create);
        assert_eq!(WriteMode::from_str("UPDATE"), WriteMode::Update);
        assert_eq!(WriteMode::from_str("APPEND"), WriteMode::Append);
        // P1-05: 无效值默认为 Create 并输出警告日志
        assert_eq!(WriteMode::from_str("unknown"), WriteMode::Create);
        assert_eq!(WriteMode::from_str("invalid"), WriteMode::Create);
    }

    #[test]
    fn test_should_downgrade_smart_mutation() {
        assert!(should_downgrade_smart_mutation(&MemoryEvent::UPDATE, 0.5));
        assert!(should_downgrade_smart_mutation(&MemoryEvent::APPEND, 0.64));
        assert!(should_downgrade_smart_mutation(&MemoryEvent::DELETE, 0.5));
        assert!(!should_downgrade_smart_mutation(&MemoryEvent::UPDATE, 0.8));
        assert!(!should_downgrade_smart_mutation(&MemoryEvent::DELETE, 0.8));
        assert!(!should_downgrade_smart_mutation(&MemoryEvent::ADD, 0.1));
        assert!(!should_downgrade_smart_mutation(&MemoryEvent::NONE, 0.1));
    }

    #[test]
    fn relation_occ_is_atomic_and_advances_both_versions() {
        let (_temp_dir, _vfs_db, service) = crate::memory::test_support::setup_memory_service();
        let note_a = service
            .write(None, "Relation A", "alpha", WriteMode::Create)
            .expect("create relation A");
        let note_b = service
            .write(None, "Relation B", "beta", WriteMode::Create)
            .expect("create relation B");
        let version_a = service
            .read(&note_a.note_id)
            .expect("read A")
            .expect("A exists")
            .0
            .updated_at;
        let version_b = service
            .read(&note_b.note_id)
            .expect("read B")
            .expect("B exists")
            .0
            .updated_at;

        let (updated_a, updated_b, changed) = service
            .add_relation_with_occ(
                &note_a.note_id,
                &version_a,
                &note_b.note_id,
                &version_b,
                MemoryOpSource::ToolCall,
                Some("session-relation"),
            )
            .expect("add relation with OCC");
        assert!(changed);
        assert_ne!(updated_a.updated_at, version_a);
        assert_ne!(updated_b.updated_at, version_b);
        assert_eq!(
            service
                .get_related_ids(&note_a.note_id)
                .expect("read A relations"),
            vec![note_b.note_id.clone()]
        );
        assert_eq!(
            service
                .get_related_ids(&note_b.note_id)
                .expect("read B relations"),
            vec![note_a.note_id.clone()]
        );

        let stale_remove = service.remove_relation_with_occ(
            &note_a.note_id,
            &version_a,
            &note_b.note_id,
            &updated_b.updated_at,
            MemoryOpSource::ToolCall,
            Some("session-relation"),
        );
        assert!(matches!(stale_remove, Err(VfsError::Conflict { .. })));
        assert_eq!(
            service
                .get_related_ids(&note_a.note_id)
                .expect("relation survives stale remove"),
            vec![note_b.note_id.clone()]
        );

        let (_, _, removed) = service
            .remove_relation_with_occ(
                &note_a.note_id,
                &updated_a.updated_at,
                &note_b.note_id,
                &updated_b.updated_at,
                MemoryOpSource::ToolCall,
                Some("session-relation"),
            )
            .expect("remove relation with current versions");
        assert!(removed);
        assert!(service
            .get_related_ids(&note_a.note_id)
            .expect("A relations cleared")
            .is_empty());
        assert!(service
            .get_related_ids(&note_b.note_id)
            .expect("B relations cleared")
            .is_empty());
    }

    #[test]
    fn tag_and_move_occ_preserve_system_boundary_and_advance_versions() {
        let (_temp_dir, _vfs_db, service) = crate::memory::test_support::setup_memory_service();
        let output = service
            .write(None, "Mutable memory", "content", WriteMode::Create)
            .expect("create memory");
        let initial = service
            .read(&output.note_id)
            .expect("read memory")
            .expect("memory exists")
            .0;
        let initial_folder = service
            .get_note_relative_folder_path(&output.note_id)
            .expect("read initial path");

        let (_, tagged) = service
            .update_tags_with_occ(
                &output.note_id,
                &initial.updated_at,
                vec!["exam".to_string(), "_important".to_string()],
                MemoryOpSource::ToolCall,
                Some("session-tags"),
            )
            .expect("update tags with OCC");
        assert_ne!(tagged.updated_at, initial.updated_at);
        assert_eq!(tagged.tags, vec!["exam"]);

        let stale_tags = service.update_tags_with_occ(
            &output.note_id,
            &initial.updated_at,
            vec!["stale".to_string()],
            MemoryOpSource::ToolCall,
            Some("session-tags"),
        );
        assert!(matches!(stale_tags, Err(VfsError::Conflict { .. })));

        let (moved, previous_folder) = service
            .move_to_folder_with_occ(
                &output.note_id,
                &tagged.updated_at,
                "Archive/2026",
                MemoryOpSource::ToolCall,
                Some("session-move"),
            )
            .expect("move with OCC");
        assert_eq!(previous_folder, initial_folder);
        assert_ne!(moved.updated_at, tagged.updated_at);
        assert_eq!(
            service
                .get_note_relative_folder_path(&output.note_id)
                .expect("read moved path"),
            "Archive/2026"
        );

        let stale_move = service.move_to_folder_with_occ(
            &output.note_id,
            &tagged.updated_at,
            "Wrong",
            MemoryOpSource::ToolCall,
            Some("session-move"),
        );
        assert!(matches!(stale_move, Err(VfsError::Conflict { .. })));
        assert_eq!(
            service
                .get_note_relative_folder_path(&output.note_id)
                .expect("path unchanged after stale move"),
            "Archive/2026"
        );
    }

    #[test]
    fn stale_idempotency_lease_is_reclaimed_and_fences_previous_owner() {
        let (_temp_dir, vfs_db, service) = crate::memory::test_support::setup_memory_service();
        let key = "stale-lease-fencing";
        let first = service
            .try_reserve_smart_write_key(key)
            .expect("reserve first owner")
            .expect("first owner should acquire");

        let conn = vfs_db.get_conn_safe().expect("open VFS database");
        conn.execute(
            "UPDATE memory_write_idempotency SET created_at = ?1 WHERE idempotency_key = ?2",
            params![
                chrono::Utc::now().timestamp_millis() - SMART_WRITE_IDEMPOTENCY_LEASE_MS - 1,
                key
            ],
        )
        .expect("expire first lease");
        drop(conn);

        let second = service
            .try_reserve_smart_write_key(key)
            .expect("reclaim stale lease")
            .expect("second owner should acquire stale lease");
        assert_ne!(first.owner_token, second.owner_token);
        assert!(matches!(
            service.renew_smart_write_reservation(Some(&first)),
            Err(VfsError::Conflict { key, .. }) if key == "memory.idempotency.lease_lost"
        ));

        // A fenced owner cannot delete the replacement owner's reservation.
        service
            .clear_smart_write_reservation(&first)
            .expect("stale clear is a harmless no-op");
        service
            .renew_smart_write_reservation(Some(&second))
            .expect("new owner remains active");

        let output = SmartWriteOutput {
            note_id: "note-fenced".to_string(),
            event: "ADD".to_string(),
            is_new: true,
            confidence: 1.0,
            reason: "committed by current owner".to_string(),
            resource_id: Some("resource-fenced".to_string()),
            downgraded: false,
        };
        assert!(matches!(
            service.finalize_idempotency_result(Some(&first), &output),
            Err(VfsError::Conflict { key, .. }) if key == "memory.idempotency.lease_lost"
        ));
        service
            .finalize_idempotency_result(Some(&second), &output)
            .expect("current owner finalizes result");
        assert_eq!(
            service
                .get_cached_smart_write_result(key)
                .expect("read cached result"),
            Some(output)
        );
    }

    #[test]
    fn idempotent_note_mutation_rolls_back_when_receipt_write_is_interrupted() {
        let (_temp_dir, vfs_db, service) = crate::memory::test_support::setup_memory_service();
        let key = "fault-before-receipt";
        let reservation = service
            .try_reserve_smart_write_key(key)
            .expect("reserve idempotency key")
            .expect("reservation should be acquired");
        MemoryService::fail_next_idempotent_write_before_receipt(key);

        let first = service.create_smart_memory(
            None,
            "Atomic receipt test",
            "The note and receipt must commit together.",
            MemoryType::Fact,
            None,
            Some(&reservation),
            "ADD",
            1.0,
            "test write".to_string(),
        );
        assert!(matches!(first, Err(VfsError::Other(message)) if message.contains("injected")));

        let conn = vfs_db.get_conn_safe().expect("open VFS database");
        let note_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL",
                params!["Atomic receipt test"],
                |row| row.get(0),
            )
            .expect("count rolled back notes");
        assert_eq!(note_count, 0, "note mutation must roll back with receipt");
        drop(conn);
        assert!(service
            .get_cached_smart_write_result(key)
            .expect("read receipt after rollback")
            .is_none());

        let output = service
            .create_smart_memory(
                None,
                "Atomic receipt test",
                "The note and receipt must commit together.",
                MemoryType::Fact,
                None,
                Some(&reservation),
                "ADD",
                1.0,
                "test write".to_string(),
            )
            .expect("retry should atomically commit");
        let conn = vfs_db.get_conn_safe().expect("reopen VFS database");
        let note_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL",
                params!["Atomic receipt test"],
                |row| row.get(0),
            )
            .expect("count committed notes");
        assert_eq!(note_count, 1, "retry must create exactly one note");
        assert_eq!(
            service
                .get_cached_smart_write_result(key)
                .expect("read committed receipt"),
            Some(output)
        );
    }

    #[test]
    fn compaction_receipts_survive_normal_ttl_until_ledger_cleanup() {
        let (_temp_dir, vfs_db, service) = crate::memory::test_support::setup_memory_service();
        let compaction_key = "compaction_flush:segment-hash:fact:0";
        let ordinary_key = "ordinary-expired-receipt";
        let output = SmartWriteOutput {
            note_id: "note-retained".to_string(),
            event: "ADD".to_string(),
            is_new: true,
            confidence: 1.0,
            reason: "retention test".to_string(),
            resource_id: Some("resource-retained".to_string()),
            downgraded: false,
        };
        for key in [compaction_key, ordinary_key] {
            let reservation = service
                .try_reserve_smart_write_key(key)
                .expect("reserve key")
                .expect("key should be available");
            service
                .finalize_idempotency_result(Some(&reservation), &output)
                .expect("finalize receipt");
        }

        let expired_at = chrono::Utc::now().timestamp_millis()
            - SMART_WRITE_IDEMPOTENCY_RETENTION_HOURS * 60 * 60 * 1000
            - 1;
        let conn = vfs_db.get_conn_safe().expect("open VFS database");
        conn.execute(
            "UPDATE memory_write_idempotency SET created_at = ?1 WHERE idempotency_key IN (?2, ?3)",
            params![expired_at, compaction_key, ordinary_key],
        )
        .expect("expire receipts");
        drop(conn);

        assert!(service
            .get_cached_smart_write_result(ordinary_key)
            .expect("run normal receipt GC")
            .is_none());
        assert_eq!(
            service
                .get_cached_smart_write_result(compaction_key)
                .expect("compaction receipt remains"),
            Some(output)
        );

        let prefix = "compaction_flush:segment-hash:";
        assert_eq!(
            service
                .clear_completed_idempotency_receipts_with_prefix(prefix)
                .expect("ledger cleanup receipts"),
            1
        );
        assert!(service
            .get_cached_smart_write_result(compaction_key)
            .expect("receipt removed after ledger completion")
            .is_none());
    }
}
