use rusqlite::params;
use std::collections::HashSet;
use std::sync::Arc;
use tracing::{debug, info, warn};

use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::lance_store::VfsLanceStore;
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::index_unit_repo;
use crate::vfs::repos::note_repo::VfsNoteRepo;
use crate::vfs::types::{
    FolderTreeNode, VfsCreateNoteParams, VfsFolder, VfsNote, VfsUpdateNoteParams,
};

use super::config::MemoryConfig;
use super::llm_decision::{MemoryEvent, MemoryLLMDecision, SimilarMemorySummary};
use super::query_rewriter::MemoryQueryRewriter;
use super::reranker::MemoryReranker;

const SMART_WRITE_MUTATION_CONFIDENCE_THRESHOLD: f32 = 0.65;

fn should_downgrade_smart_mutation(event: &MemoryEvent, confidence: f32) -> bool {
    matches!(event, MemoryEvent::UPDATE | MemoryEvent::APPEND)
        && confidence < SMART_WRITE_MUTATION_CONFIDENCE_THRESHOLD
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResult {
    pub note_id: String,
    pub note_title: String,
    pub folder_path: String,
    pub chunk_text: String,
    pub score: f32,
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
}

#[derive(Clone)]
pub struct MemoryService {
    config: MemoryConfig,
    vfs_db: Arc<VfsDatabase>,
    lance_store: Arc<VfsLanceStore>,
    llm_manager: Arc<LLMManager>,
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
        }
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

        let root_id = self.ensure_root_folder_id()?;

        let folder_ids = VfsFolderRepo::get_folder_ids_recursive(&self.vfs_db, &root_id)?;
        if folder_ids.is_empty() {
            return Ok(vec![]);
        }

        let embedding = self
            .llm_manager
            .generate_embedding(query)
            .await
            .map_err(|e| VfsError::Other(format!("Embedding failed: {}", e)))?;

        // 先多取一些候选，再按 note_id 去重，避免单一笔记占满结果集。
        let retrieval_k = top_k.saturating_mul(3);
        let lance_results = self
            .lance_store
            .hybrid_search(
                "text",
                query,
                &embedding,
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
                });

                if results.len() >= top_k {
                    break;
                }
            }
        }

        debug!(
            "[Memory] Search '{}' returned {} deduplicated results",
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
            });
        }

        // 1. 先搜索相似记忆
        let similar_results = self.search(content, 5).await?;

        // 2. 转换为 LLM 决策需要的格式
        let similar_summaries: Vec<SimilarMemorySummary> = similar_results
            .iter()
            .map(|r| SimilarMemorySummary {
                note_id: r.note_id.clone(),
                title: r.note_title.clone(),
                content_preview: r.chunk_text.clone(),
            })
            .collect();

        // 3. 调用 LLM 决策
        let llm_decision = MemoryLLMDecision::new(self.llm_manager.clone());
        let decision = llm_decision
            .decide(content, Some(title), &similar_summaries)
            .await
            .map_err(|e| VfsError::Other(format!("LLM decision failed: {}", e)))?;

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
            });
        }

        // 4. 根据决策执行操作
        match decision.event {
            MemoryEvent::ADD => {
                let result = self.write(folder_path, title, content, WriteMode::Create)?;
                Ok(SmartWriteOutput {
                    note_id: result.note_id,
                    event: "ADD".to_string(),
                    is_new: true,
                    confidence: decision.confidence,
                    reason: decision.reason,
                    resource_id: Some(result.resource_id),
                })
            }
            MemoryEvent::UPDATE => {
                if let Some(target_id) = decision.target_note_id {
                    // 按 ID 更新（包含记忆根目录边界校验）
                    match self.update_by_id(&target_id, Some(title), Some(content)) {
                        Ok(result) => Ok(SmartWriteOutput {
                            note_id: result.note_id,
                            event: "UPDATE".to_string(),
                            is_new: false,
                            confidence: decision.confidence,
                            reason: decision.reason,
                            resource_id: Some(result.resource_id),
                        }),
                        Err(VfsError::NotFound { .. }) => {
                            // LLM 可能返回已失效/越界的 target_note_id，安全降级为新增。
                            let result =
                                self.write(folder_path, title, content, WriteMode::Create)?;
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
                            })
                        }
                        Err(e) => Err(e),
                    }
                } else {
                    // 没有目标 ID，降级为新增
                    let result = self.write(folder_path, title, content, WriteMode::Create)?;
                    Ok(SmartWriteOutput {
                        note_id: result.note_id,
                        event: "ADD".to_string(),
                        is_new: true,
                        confidence: decision.confidence,
                        reason: "UPDATE 决策但无目标 ID，降级为 ADD".to_string(),
                        resource_id: Some(result.resource_id),
                    })
                }
            }
            MemoryEvent::APPEND => {
                if let Some(target_id) = decision.target_note_id {
                    // 追加到目标笔记
                    let append_result: VfsResult<MemoryWriteOutput> = (|| {
                        self.ensure_note_in_memory_root(&target_id)?;
                        let current = VfsNoteRepo::get_note_content(&self.vfs_db, &target_id)?
                            .unwrap_or_default();
                        let final_content = format!("{}\n\n{}", current, content);
                        self.update_by_id(&target_id, None, Some(&final_content))
                    })();

                    match append_result {
                        Ok(result) => Ok(SmartWriteOutput {
                            note_id: result.note_id,
                            event: "APPEND".to_string(),
                            is_new: false,
                            confidence: decision.confidence,
                            reason: decision.reason,
                            resource_id: Some(result.resource_id),
                        }),
                        Err(VfsError::NotFound { .. }) => {
                            // target_note_id 无效时，降级为新增，避免写入失败中断记忆流程。
                            let result =
                                self.write(folder_path, title, content, WriteMode::Create)?;
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
                            })
                        }
                        Err(e) => Err(e),
                    }
                } else {
                    // 没有目标 ID，降级为新增
                    let result = self.write(folder_path, title, content, WriteMode::Create)?;
                    Ok(SmartWriteOutput {
                        note_id: result.note_id,
                        event: "ADD".to_string(),
                        is_new: true,
                        confidence: decision.confidence,
                        reason: "APPEND 决策但无目标 ID，降级为 ADD".to_string(),
                        resource_id: Some(result.resource_id),
                    })
                }
            }
            MemoryEvent::NONE => {
                // 无需操作，返回最相似的记忆 ID
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
                })
            }
        }
    }

    /// 带重排序的增强搜索
    pub async fn search_with_rerank(
        &self,
        query: &str,
        top_k: usize,
        use_query_rewrite: bool,
    ) -> VfsResult<Vec<MemorySearchResult>> {
        if self.config.is_privacy_mode()? {
            // 隐私模式下禁止 query rewrite 与 rerank，避免将原始查询发送到外部模型。
            return self.search(query, top_k).await;
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
        let folder_ids = VfsFolderRepo::get_folder_ids_recursive(&self.vfs_db, &target_root_id)?;
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
        let notes = VfsNoteRepo::list_notes_by_folder(&self.vfs_db, folder_id, 1000, 0)?;
        Ok(notes.into_iter().find(|n| n.title == title))
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

        let folder_ids = VfsFolderRepo::get_folder_ids_recursive(&self.vfs_db, root_id)?;
        Ok(folder_ids.contains(&folder_id))
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
        assert!(!should_downgrade_smart_mutation(&MemoryEvent::UPDATE, 0.8));
        assert!(!should_downgrade_smart_mutation(&MemoryEvent::ADD, 0.1));
    }
}
