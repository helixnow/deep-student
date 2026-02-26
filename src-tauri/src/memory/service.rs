use rusqlite::params;
use std::collections::HashSet;
use std::sync::{Arc, RwLock};
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

use super::config::MemoryConfig;
use super::llm_decision::{MemoryDecisionResponse, MemoryEvent, MemoryLLMDecision, SimilarMemorySummary};
use super::query_rewriter::MemoryQueryRewriter;
use super::reranker::MemoryReranker;

const SMART_WRITE_MUTATION_CONFIDENCE_THRESHOLD: f32 = 0.65;

/// 用户画像摘要笔记的保留标题
const PROFILE_NOTE_TITLE: &str = "__user_profile__";
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListItem {
    pub id: String,
    pub title: String,
    pub folder_path: String,
    pub updated_at: String,
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
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWriteOutput {
    pub note_id: String,
    pub is_new: bool,
    /// 写入资源的 resource_id，用于触发即时索引以保证 write-then-search SLA
    pub resource_id: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
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
}

impl MemoryService {
    pub fn new(
        vfs_db: Arc<VfsDatabase>,
        lance_store: Arc<VfsLanceStore>,
        llm_manager: Arc<LLMManager>,
    ) -> Self {
        Self {
            config: MemoryConfig::new(vfs_db.clone()),
            vfs_db,
            lance_store,
            llm_manager,
            folder_cache: Arc::new(RwLock::new(None)),
        }
    }

    /// 获取记忆文件夹 ID 列表（带缓存）
    fn get_memory_folder_ids(&self, root_id: &str) -> VfsResult<Vec<String>> {
        {
            let cache = self.folder_cache.read().unwrap();
            if let Some(ref c) = *cache {
                if c.root_id == root_id {
                    return Ok(c.folder_ids.clone());
                }
            }
        }
        let folder_ids = VfsFolderRepo::get_folder_ids_recursive(&self.vfs_db, root_id)?;
        {
            let mut cache = self.folder_cache.write().unwrap();
            *cache = Some(FolderIdCache {
                root_id: root_id.to_string(),
                folder_ids: folder_ids.clone(),
            });
        }
        debug!("[Memory] Folder cache populated: {} folders", folder_ids.len());
        Ok(folder_ids)
    }

    /// 使文件夹缓存失效（在文件夹结构变更后调用）
    fn invalidate_folder_cache(&self) {
        let mut cache = self.folder_cache.write().unwrap();
        *cache = None;
    }

    pub fn get_config(&self) -> VfsResult<MemoryConfigOutput> {
        let root_id = self.config.get_root_folder_id()?;
        let root_title = if let Some(ref id) = root_id {
            VfsFolderRepo::get_folder(&self.vfs_db, id)?.map(|f| f.title)
        } else {
            None
        };

        Ok(MemoryConfigOutput {
            memory_root_folder_id: root_id,
            memory_root_folder_title: root_title,
            auto_create_subfolders: self.config.is_auto_create_subfolders()?,
            default_category: self.config.get_default_category()?,
            privacy_mode: self.config.is_privacy_mode()?,
        })
    }

    pub fn set_root_folder(&self, folder_id: &str) -> VfsResult<()> {
        if !VfsFolderRepo::folder_exists(&self.vfs_db, folder_id)? {
            return Err(VfsError::NotFound {
                resource_type: "Folder".to_string(),
                id: folder_id.to_string(),
            });
        }
        self.config.set_root_folder_id(folder_id)?;
        info!("[Memory] Set root folder: {}", folder_id);
        Ok(())
    }

    /// 立即索引资源（同步生成嵌入 + 写入 LanceDB），确保后续向量搜索能找到。
    /// 索引成功后标记为 indexed，防止批量 worker 和 handler 重复处理。
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
                        warn!("[Memory] Failed to mark indexed after immediate indexing: {}", e);
                    }
                    info!("[Memory] Immediate indexing succeeded: resource={}, chunks={}", resource_id, chunks);
                }
                Err(e) => {
                    warn!("[Memory] Immediate indexing failed (will retry via pending): {}", e);
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
        self.config.get_or_create_root_folder()
    }

    fn ensure_root_folder_id(&self) -> VfsResult<String> {
        self.config.get_or_create_root_folder()
    }

    pub async fn search(&self, query: &str, top_k: usize) -> VfsResult<Vec<MemorySearchResult>> {
        if top_k == 0 {
            return Ok(vec![]);
        }

        if self.config.is_privacy_mode()? {
            warn!("[Memory] Privacy mode enabled, skipping embedding API call for search");
            return Ok(vec![]);
        }

        let embedding = self
            .llm_manager
            .generate_embedding(query)
            .await
            .map_err(|e| VfsError::Other(format!("Embedding failed: {}", e)))?;

        self.search_with_embedding(query, &embedding, top_k).await
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
        if top_k == 0 {
            return Ok(vec![]);
        }

        if self.config.is_privacy_mode()? {
            warn!("[Memory] Privacy mode enabled, skipping search_with_embedding");
            return Ok(vec![]);
        }

        let root_id = self.ensure_root_folder_id()?;

        let folder_ids = self.get_memory_folder_ids(&root_id)?;
        if folder_ids.is_empty() {
            return Ok(vec![]);
        }

        let retrieval_k = top_k.saturating_mul(3);
        let lance_results = self
            .lance_store
            .hybrid_search(
                "text",
                query,
                query_embedding,
                retrieval_k,
                Some(&folder_ids),
                Some(&["note".to_string()]),
            )
            .await?;

        let mut results = Vec::new();
        let mut seen_note_ids: HashSet<String> = HashSet::new();
        for r in lance_results {
            let note = self.get_note_by_resource_id(&r.resource_id)?;
            if let Some(note) = note {
                if !seen_note_ids.insert(note.id.clone()) {
                    continue;
                }

                let folder_path = self.get_note_folder_path(&note.id)?;
                results.push(MemorySearchResult {
                    note_id: note.id,
                    note_title: note.title,
                    folder_path,
                    chunk_text: r.text,
                    score: r.score,
                    updated_at: Some(note.updated_at),
                });

                if results.len() >= top_k {
                    break;
                }
            }
        }

        // 应用时间衰减
        self.apply_time_decay(&mut results);

        // 异步记录命中（不阻塞搜索返回）
        let hit_ids: Vec<String> = results.iter().map(|r| r.note_id.clone()).collect();
        if !hit_ids.is_empty() {
            let svc = self.clone();
            tokio::task::spawn_blocking(move || svc.record_search_hits(&hit_ids));
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
        let root_id = self.ensure_root_folder_id()?;

        let auto_create_subfolders = self.config.is_auto_create_subfolders()?;
        let default_category = self.config.get_default_category()?;
        let has_default_category = !default_category.trim().is_empty();

        let target_folder_id = if let Some(path) = folder_path {
            if path.is_empty() {
                if auto_create_subfolders && has_default_category {
                    Some(self.ensure_folder(&root_id, &default_category)?)
                } else {
                    Some(root_id.clone())
                }
            } else if auto_create_subfolders {
                Some(self.ensure_folder(&root_id, path)?)
            } else {
                let folder_id =
                    self.resolve_path_to_folder_id(&root_id, path)?
                        .ok_or_else(|| VfsError::NotFound {
                            resource_type: "Folder".to_string(),
                            id: path.to_string(),
                        })?;
                Some(folder_id)
            }
        } else if auto_create_subfolders && has_default_category {
            Some(self.ensure_folder(&root_id, &default_category)?)
        } else {
            Some(root_id.clone())
        };

        match mode {
            WriteMode::Create => {
                let note = VfsNoteRepo::create_note_in_folder(
                    &self.vfs_db,
                    VfsCreateNoteParams {
                        title: title.to_string(),
                        content: content.to_string(),
                        tags: vec![],
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
                            expected_updated_at: None,
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
                            tags: vec![],
                        },
                        target_folder_id.as_deref(),
                    )?;
                    // ★ P2-2 修复：创建后触发索引入队
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

    /// 智能写入记忆（使用 LLM 决策）
    ///
    /// 自动判断应该新增、更新还是追加到现有记忆
    pub async fn write_smart(
        &self,
        folder_path: Option<&str>,
        title: &str,
        content: &str,
    ) -> VfsResult<SmartWriteOutput> {
        self.ensure_root_folder_id()?;

        if self.config.is_privacy_mode()? {
            let result = self.write(folder_path, title, content, WriteMode::Create)?;
            return Ok(SmartWriteOutput {
                note_id: result.note_id,
                event: "ADD".to_string(),
                is_new: true,
                confidence: 1.0,
                reason: "隐私模式已启用，跳过 LLM 决策并安全降级为新增".to_string(),
                resource_id: Some(result.resource_id),
                downgraded: false,
            });
        }

        // 1. 先搜索相似记忆（扩大范围以提高冲突检测覆盖率）
        let similar_results = self.search(content, 15).await?;

        // 2. 转换为 LLM 决策需要的格式
        let similar_summaries: Vec<SimilarMemorySummary> = similar_results
            .iter()
            .map(|r| SimilarMemorySummary {
                note_id: r.note_id.clone(),
                title: r.note_title.clone(),
                content_preview: r.chunk_text.clone(),
            })
            .collect();

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
            return Ok(SmartWriteOutput {
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
            });
        }

        // 4. 根据决策执行操作
        let result = match decision.event {
            MemoryEvent::ADD => {
                let result = self.write(folder_path, title, content, WriteMode::Create)?;
                self.index_immediately(&result.resource_id).await;
                Ok(SmartWriteOutput {
                    note_id: result.note_id,
                    event: "ADD".to_string(),
                    is_new: true,
                    confidence: decision.confidence,
                    reason: decision.reason,
                    resource_id: Some(result.resource_id),
                    downgraded: false,
                })
            }
            MemoryEvent::UPDATE => {
                if let Some(target_id) = decision.target_note_id {
                    match self.update_by_id(&target_id, Some(title), Some(content)) {
                        Ok(result) => {
                            self.index_immediately(&result.resource_id).await;
                            Ok(SmartWriteOutput {
                                note_id: result.note_id,
                                event: "UPDATE".to_string(),
                                is_new: false,
                                confidence: decision.confidence,
                                reason: decision.reason,
                                resource_id: Some(result.resource_id),
                                downgraded: false,
                            })
                        }
                        Err(VfsError::NotFound { .. }) => {
                            let result =
                                self.write(folder_path, title, content, WriteMode::Create)?;
                            self.index_immediately(&result.resource_id).await;
                            Ok(SmartWriteOutput {
                                note_id: result.note_id,
                                event: "ADD".to_string(),
                                is_new: true,
                                confidence: decision.confidence,
                                reason: format!(
                                    "{}（target_note_id 无效，降级为 ADD）",
                                    decision.reason
                                ),
                                resource_id: Some(result.resource_id),
                                downgraded: false,
                            })
                        }
                        Err(e) => Err(e),
                    }
                } else {
                    let result = self.write(folder_path, title, content, WriteMode::Create)?;
                    self.index_immediately(&result.resource_id).await;
                    Ok(SmartWriteOutput {
                        note_id: result.note_id,
                        event: "ADD".to_string(),
                        is_new: true,
                        confidence: decision.confidence,
                        reason: "UPDATE 决策但无目标 ID，降级为 ADD".to_string(),
                        resource_id: Some(result.resource_id),
                        downgraded: false,
                    })
                }
            }
            MemoryEvent::APPEND => {
                if let Some(target_id) = decision.target_note_id {
                    let append_result: VfsResult<MemoryWriteOutput> = (|| {
                        self.ensure_note_in_memory_root(&target_id)?;
                        let current = VfsNoteRepo::get_note_content(&self.vfs_db, &target_id)?
                            .unwrap_or_default();
                        let final_content = format!("{}\n\n{}", current, content);
                        self.update_by_id(&target_id, None, Some(&final_content))
                    })();

                    match append_result {
                        Ok(result) => {
                            self.index_immediately(&result.resource_id).await;
                            Ok(SmartWriteOutput {
                                note_id: result.note_id,
                                event: "APPEND".to_string(),
                                is_new: false,
                                confidence: decision.confidence,
                                reason: decision.reason,
                                resource_id: Some(result.resource_id),
                                downgraded: false,
                            })
                        }
                        Err(VfsError::NotFound { .. }) => {
                            let result =
                                self.write(folder_path, title, content, WriteMode::Create)?;
                            self.index_immediately(&result.resource_id).await;
                            Ok(SmartWriteOutput {
                                note_id: result.note_id,
                                event: "ADD".to_string(),
                                is_new: true,
                                confidence: decision.confidence,
                                reason: format!(
                                    "{}（target_note_id 无效，降级为 ADD）",
                                    decision.reason
                                ),
                                resource_id: Some(result.resource_id),
                                downgraded: false,
                            })
                        }
                        Err(e) => Err(e),
                    }
                } else {
                    let result = self.write(folder_path, title, content, WriteMode::Create)?;
                    self.index_immediately(&result.resource_id).await;
                    Ok(SmartWriteOutput {
                        note_id: result.note_id,
                        event: "ADD".to_string(),
                        is_new: true,
                        confidence: decision.confidence,
                        reason: "APPEND 决策但无目标 ID，降级为 ADD".to_string(),
                        resource_id: Some(result.resource_id),
                        downgraded: false,
                    })
                }
            }
            MemoryEvent::DELETE => {
                if let Some(target_id) = decision.target_note_id {
                    if let Err(e) = self.delete(&target_id).await {
                        warn!("[Memory] DELETE target {} failed: {}, proceeding with ADD", target_id, e);
                    } else {
                        info!("[Memory] DELETE conflicting memory: {}", target_id);
                    }
                    let result = self.write(folder_path, title, content, WriteMode::Create)?;
                    self.index_immediately(&result.resource_id).await;
                    Ok(SmartWriteOutput {
                        note_id: result.note_id,
                        event: "DELETE".to_string(),
                        is_new: true,
                        confidence: decision.confidence,
                        reason: format!("{}（已删除矛盾记忆 {}）", decision.reason, target_id),
                        resource_id: Some(result.resource_id),
                        downgraded: false,
                    })
                } else {
                    let result = self.write(folder_path, title, content, WriteMode::Create)?;
                    self.index_immediately(&result.resource_id).await;
                    Ok(SmartWriteOutput {
                        note_id: result.note_id,
                        event: "ADD".to_string(),
                        is_new: true,
                        confidence: decision.confidence,
                        reason: "DELETE 决策但无目标 ID，降级为 ADD".to_string(),
                        resource_id: Some(result.resource_id),
                        downgraded: false,
                    })
                }
            }
            MemoryEvent::NONE => {
                let existing_id = similar_results
                    .first()
                    .map(|r| r.note_id.clone())
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
        };

        // 实际发生写入时，异步刷新用户画像摘要
        if let Ok(ref out) = result {
            if out.resource_id.is_some() {
                let svc = self.clone();
                tokio::task::spawn_blocking(move || {
                    if let Err(e) = svc.refresh_profile_summary() {
                        warn!("[Memory] Profile refresh failed: {}", e);
                    }
                });
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

        // 1. 可选的查询重写
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

        // 2. 执行搜索
        let results = self.search(&final_query, top_k * 2).await?; // 多取一些用于重排序

        // 3. 重排序
        let reranker = MemoryReranker::new_auto(self.llm_manager.clone()).await;
        let reranked = reranker
            .rerank(query, results)
            .await
            .map_err(|e| VfsError::Other(format!("Rerank failed: {}", e)))?;

        // 4. 截取 top_k
        Ok(reranked.into_iter().take(top_k).collect())
    }

    pub fn list(
        &self,
        folder_path: Option<&str>,
        limit: u32,
        offset: u32,
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

        // 列表语义采用“递归列出目录下全部记忆”，避免默认分类子目录中的记忆不可见。
        let folder_ids = self.get_memory_folder_ids(&target_root_id)?;
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
            WHERE fi.folder_id IN ({}) AND n.deleted_at IS NULL
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
                items.push(MemoryListItem {
                    id: note.id,
                    title: note.title,
                    folder_path,
                    updated_at: note.updated_at,
                });
            }
        }

        Ok(items)
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

        nodes.sort_by(|a, b| a.folder.sort_order.cmp(&b.folder.sort_order));
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
                WHERE n.title = ?1 AND fi.folder_id = ?2 AND n.deleted_at IS NULL
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
            conn.query_row(
                r#"
                SELECT id, resource_id, title, tags, is_favorite,
                       created_at, updated_at, deleted_at
                FROM notes
                WHERE title = ?1 AND deleted_at IS NULL
                LIMIT 1
                "#,
                params![title],
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
        let note = self.ensure_note_in_memory_root(note_id)?;

        let updated_note = VfsNoteRepo::update_note(
            &self.vfs_db,
            note_id,
            VfsUpdateNoteParams {
                title: title.map(|s| s.to_string()),
                content: content.map(|s| s.to_string()),
                tags: None,
                expected_updated_at: None,
            },
        )?;

        // ★ P2-2 修复：更新后触发索引入队
        if let Err(e) = VfsIndexStateRepo::mark_pending(&self.vfs_db, &updated_note.resource_id) {
            warn!("[Memory] Failed to mark pending for indexing: {}", e);
        }

        info!(
            "[Memory] Updated note by ID: {} (resource_id={}) — marked pending for immediate indexing",
            note_id, updated_note.resource_id
        );
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
        let note = self.ensure_note_in_memory_root(note_id)?;

        // 先删除向量索引，避免数据库先删除后向量残留导致敏感记忆仍可检索。
        self.lance_store
            .delete_by_resource("text", &note.resource_id)
            .await
            .map_err(|e| {
                VfsError::Other(format!(
                    "Failed to delete lance index for {}: {}",
                    note.resource_id, e
                ))
            })?;

        VfsNoteRepo::delete_note_with_folder_item(&self.vfs_db, note_id)?;
        // 使用新架构删除 units（segments 级联删除）
        if let Ok(conn) = self.vfs_db.get_conn() {
            if let Err(e) = index_unit_repo::delete_by_resource(&conn, &note.resource_id) {
                warn!(
                    "[Memory] Failed to delete index units for {}: {}",
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

    // ========================================================================
    // 用户画像摘要
    // ========================================================================

    /// 获取用户画像摘要（从特殊笔记读取，不存在时返回 None）
    pub fn get_profile_summary(&self) -> VfsResult<Option<String>> {
        let root_id = match self.config.get_root_folder_id()? {
            Some(id) => id,
            None => return Ok(None),
        };
        match self.find_note_by_title(Some(&root_id), PROFILE_NOTE_TITLE)? {
            Some(note) => {
                let content = VfsNoteRepo::get_note_content(&self.vfs_db, &note.id)?
                    .unwrap_or_default();
                if content.is_empty() { Ok(None) } else { Ok(Some(content)) }
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
    /// 对齐 memU 自进化理念：用 LLM 将原子事实聚合为结构化画像，
    /// 而非简单的列表拼接。
    pub fn refresh_profile_summary(&self) -> VfsResult<()> {
        let root_id = self.ensure_root_folder_id()?;
        let all_memories = self.list(None, PROFILE_MAX_ITEMS as u32, 0)?;

        if all_memories.is_empty() {
            return Ok(());
        }

        let mut facts = Vec::new();
        for mem in &all_memories {
            if mem.title.starts_with("__") {
                continue;
            }
            let content = VfsNoteRepo::get_note_content(&self.vfs_db, &mem.id)?
                .unwrap_or_default();
            if !content.is_empty() {
                facts.push(content);
            } else {
                facts.push(mem.title.clone());
            }
        }

        if facts.is_empty() {
            return Ok(());
        }

        let profile_content = self.generate_structured_profile(&facts);

        match self.find_note_by_title(Some(&root_id), PROFILE_NOTE_TITLE)? {
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
                    Some(&root_id),
                )?;
                if let Err(e) = VfsIndexStateRepo::mark_disabled_with_reason(
                    &self.vfs_db,
                    &profile_note.resource_id,
                    "system profile note",
                ) {
                    warn!("[Memory] Failed to disable indexing for profile note: {}", e);
                }
                debug!("[Memory] Profile summary created ({} facts)", facts.len());
            }
        }

        Ok(())
    }

    /// 从原子事实生成结构化画像（纯同步，无 LLM 调用）
    ///
    /// LLM 结构化聚合由 CategoryManager 负责（生成 __cat_*__ 分类文件）。
    /// 此方法仅做简单的分组格式化作为 system prompt 注入的回退。
    fn generate_structured_profile(&self, facts: &[String]) -> String {
        let mut grouped: std::collections::HashMap<&str, Vec<&str>> = std::collections::HashMap::new();
        for fact in facts {
            let category = if fact.contains("偏好") || fact.contains("格式偏好") || fact.contains("风格偏好") || fact.contains("喜欢") {
                "偏好"
            } else if fact.contains("年级") || fact.contains("学校") || fact.contains("理科生") || fact.contains("文科生") || fact.contains("专业") {
                "基本信息"
            } else if fact.contains("弱项") || fact.contains("强项") || fact.contains("成绩") || fact.contains("得分") || fact.contains("薄弱") {
                "学科状态"
            } else if fact.contains("高考") || fact.contains("模考") || fact.contains("考试") || fact.contains("截止") || fact.contains("月日") {
                "时间节点"
            } else {
                "其他"
            };
            grouped.entry(category).or_default().push(fact);
        }

        let order = ["基本信息", "学科状态", "偏好", "时间节点", "其他"];
        let mut sections = Vec::new();
        for key in &order {
            if let Some(items) = grouped.get(key) {
                let lines: Vec<String> = items.iter().map(|f| format!("- {}", f)).collect();
                sections.push(format!("## {}\n{}", key, lines.join("\n")));
            }
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
        for note_id in note_ids {
            let tags_json: Option<String> = conn
                .query_row(
                    "SELECT tags FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                    params![note_id],
                    |row| row.get(0),
                )
                .ok();
            let Some(tags_json) = tags_json else { continue };
            let mut tags: Vec<String> =
                serde_json::from_str(&tags_json).unwrap_or_default();

            let mut hits: u32 = 1;
            tags.retain(|t| {
                if let Some(val) = t.strip_prefix(TAG_HITS_PREFIX) {
                    hits = val.parse::<u32>().unwrap_or(0) + 1;
                    false
                } else if t.starts_with(TAG_LAST_HIT_PREFIX) {
                    false
                } else {
                    true
                }
            });
            tags.push(format!("{}{}", TAG_HITS_PREFIX, hits));
            tags.push(format!("{}{}", TAG_LAST_HIT_PREFIX, now_ms));

            let new_tags_json = serde_json::to_string(&tags).unwrap_or_default();
            if let Err(e) = conn.execute(
                "UPDATE notes SET tags = ?1 WHERE id = ?2",
                params![new_tags_json, note_id],
            ) {
                warn!("[Memory] Failed to record search hit for {}: {}", note_id, e);
            }
        }
    }

    /// 对搜索结果应用时间衰减（利用结果中携带的 updated_at，无额外查询）
    pub fn apply_time_decay(&self, results: &mut Vec<MemorySearchResult>) {
        let now = chrono::Utc::now();
        let now_ms = now.timestamp_millis() as f64;
        for r in results.iter_mut() {
            let age_days = if let Some(ref ts) = r.updated_at {
                if let Ok(dt) = chrono::DateTime::parse_from_rfc3339(ts) {
                    (now - dt.with_timezone(&chrono::Utc))
                        .num_seconds()
                        .max(0) as f64
                        / 86400.0
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
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
