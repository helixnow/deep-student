//! 分层分类文件管理器（Memory Category Layer）
//!
//! 受 memU 三层架构启发：
//! - Resource Layer：对话记录（ChatV2 已有）
//! - Memory Item Layer：原子记忆笔记（已有）
//! - Memory Category Layer：分类聚合文件（本模块实现）
//!
//! 通过 `__cat_*__` 前缀笔记存储分类摘要，
//! 这些笔记在 list/search 中被过滤（标题以 `__` 开头）。

use std::sync::Arc;

use tracing::{debug, info, warn};

use crate::llm_manager::LLMManager;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::VfsResult;
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::note_repo::VfsNoteRepo;
use crate::vfs::types::{VfsCreateNoteParams, VfsUpdateNoteParams};

use super::service::{MemoryListItem, MemoryService};

const CATEGORY_NOTE_PREFIX: &str = "__cat_";
const CATEGORY_NOTE_SUFFIX: &str = "__";

/// 预定义的种子分类（首次使用时自动创建，后续通过数据库发现实际分类）
const SEED_CATEGORIES: &[(&str, &str)] = &[
    ("偏好", "偏好"),
    ("个人背景", "偏好/个人背景"),
    ("学科状态", "经历/学科状态"),
    ("时间节点", "经历/时间节点"),
    ("经历与计划", "经历"),
];

pub struct MemoryCategoryManager {
    vfs_db: Arc<VfsDatabase>,
    llm_manager: Arc<LLMManager>,
}

impl MemoryCategoryManager {
    pub fn new(vfs_db: Arc<VfsDatabase>, llm_manager: Arc<LLMManager>) -> Self {
        Self {
            vfs_db,
            llm_manager,
        }
    }

    fn category_note_title(category_name: &str) -> String {
        format!("{}{}{}", CATEGORY_NOTE_PREFIX, category_name, CATEGORY_NOTE_SUFFIX)
    }

    /// 刷新所有分类摘要文件
    ///
    /// 合并两个来源的分类：
    /// 1. 预定义种子分类（保证基础结构存在）
    /// 2. 记忆根文件夹下的实际子文件夹（捕获 LLM 自动创建的新分类）
    pub async fn refresh_all_categories(&self, memory_service: &MemoryService) -> VfsResult<()> {
        let mut categories: Vec<(String, String)> = SEED_CATEGORIES
            .iter()
            .map(|(name, path)| (name.to_string(), path.to_string()))
            .collect();

        if let Ok(Some(tree)) = memory_service.get_tree() {
            Self::collect_folder_categories(&tree.children, "", &mut categories);
        }

        categories.dedup_by(|a, b| a.1 == b.1);

        for (cat_name, folder_path) in &categories {
            if let Err(e) = self
                .refresh_category(memory_service, cat_name, folder_path)
                .await
            {
                warn!(
                    "[CategoryManager] Failed to refresh category '{}': {}",
                    cat_name, e
                );
            }
        }
        Ok(())
    }

    fn collect_folder_categories(
        children: &[crate::vfs::types::FolderTreeNode],
        parent_path: &str,
        out: &mut Vec<(String, String)>,
    ) {
        for child in children {
            let title = &child.folder.title;
            if title.starts_with("__") {
                continue;
            }
            let path = if parent_path.is_empty() {
                title.clone()
            } else {
                format!("{}/{}", parent_path, title)
            };
            if !out.iter().any(|(_, p)| p == &path) {
                out.push((title.clone(), path.clone()));
            }
            if !child.children.is_empty() {
                Self::collect_folder_categories(&child.children, &path, out);
            }
        }
    }

    /// 刷新单个分类摘要
    async fn refresh_category(
        &self,
        memory_service: &MemoryService,
        category_name: &str,
        folder_path: &str,
    ) -> VfsResult<()> {
        let memories = memory_service.list(Some(folder_path), 50, 0)?;

        let memories: Vec<&MemoryListItem> = memories
            .iter()
            .filter(|m| !m.title.starts_with("__"))
            .collect();

        if memories.is_empty() {
            debug!(
                "[CategoryManager] No memories in '{}', skipping category file",
                folder_path
            );
            return Ok(());
        }

        let mut memory_contents: Vec<String> = Vec::new();
        for mem in &memories {
            let content = VfsNoteRepo::get_note_content(&self.vfs_db, &mem.id)?
                .unwrap_or_default();
            if content.is_empty() {
                memory_contents.push(mem.title.clone());
            } else {
                memory_contents.push(content);
            }
        }

        let summary = self
            .generate_category_summary(category_name, &memory_contents)
            .await?;

        let sys_folder_id = memory_service.get_or_create_system_folder_id()?;

        let cat_title = Self::category_note_title(category_name);
        self.upsert_category_note(&sys_folder_id, &cat_title, &summary)?;

        info!(
            "[CategoryManager] Refreshed category '{}' with {} memories",
            category_name,
            memories.len()
        );

        Ok(())
    }

    /// 用 LLM 生成分类摘要
    async fn generate_category_summary(
        &self,
        category_name: &str,
        memory_contents: &[String],
    ) -> VfsResult<String> {
        let facts_list = memory_contents
            .iter()
            .enumerate()
            .map(|(i, c)| format!("{}. {}", i + 1, c))
            .collect::<Vec<_>>()
            .join("\n");

        let prompt = format!(
            r#"你是一个用户画像聚合器。请将以下关于用户的原子事实聚合为**结构化的分类摘要**。

## 分类: {category_name}

## 原子事实列表
{facts_list}

## 要求
1. 生成 Markdown 格式的结构化摘要
2. 合并相关事实，消除冗余
3. 如果事实之间有矛盾，以编号较大（较新）的为准
4. 保持简洁，每条不超过一行
5. 不要添加原子事实中没有的信息

## 输出格式
直接输出 Markdown 内容，不要包裹代码块。"#,
            category_name = category_name,
            facts_list = facts_list,
        );

        let output = self
            .llm_manager
            .call_memory_decision_raw_prompt(&prompt)
            .await
            .map_err(|e| {
                crate::vfs::error::VfsError::Other(format!(
                    "Category summary LLM call failed: {}",
                    e
                ))
            })?;

        Ok(output.assistant_message)
    }

    /// 创建或更新分类摘要笔记
    fn upsert_category_note(
        &self,
        root_folder_id: &str,
        title: &str,
        content: &str,
    ) -> VfsResult<()> {
        use rusqlite::params;

        let conn = self.vfs_db.get_conn_safe()?;
        let existing: Option<String> = conn
            .query_row(
                r#"
                SELECT n.id FROM notes n
                JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
                WHERE n.title = ?1 AND fi.folder_id = ?2 AND n.deleted_at IS NULL
                LIMIT 1
                "#,
                params![title, root_folder_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(note_id) = existing {
            VfsNoteRepo::update_note(
                &self.vfs_db,
                &note_id,
                VfsUpdateNoteParams {
                    title: None,
                    content: Some(content.to_string()),
                    tags: None,
                    expected_updated_at: None,
                },
            )?;
            debug!("[CategoryManager] Updated category note: {}", title);
        } else {
            let note = VfsNoteRepo::create_note_in_folder(
                &self.vfs_db,
                VfsCreateNoteParams {
                    title: title.to_string(),
                    content: content.to_string(),
                    tags: vec!["_system".to_string()],
                },
                Some(root_folder_id),
            )?;
            if let Err(e) = VfsIndexStateRepo::mark_disabled_with_reason(
                &self.vfs_db,
                &note.resource_id,
                "system category note",
            ) {
                warn!(
                    "[CategoryManager] Failed to disable indexing for category note: {}",
                    e
                );
            }
            debug!("[CategoryManager] Created category note: {}", title);
        }

        Ok(())
    }

    /// 加载所有分类摘要文件内容（用于注入 system prompt）
    ///
    /// 查找顺序：__system__ 子文件夹 → 根文件夹（向后兼容）
    pub fn load_all_category_summaries(
        &self,
        root_folder_id: &str,
    ) -> VfsResult<Vec<(String, String)>> {
        use rusqlite::params;

        let sys_folder_id = self.find_system_folder(root_folder_id)?;
        let target_folder_id = sys_folder_id.as_deref().unwrap_or(root_folder_id);

        let conn = self.vfs_db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT n.id, n.title FROM notes n
            JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
            WHERE fi.folder_id = ?1 AND n.deleted_at IS NULL
              AND n.title LIKE '!_!_cat!_%!_!_' ESCAPE '!'
            ORDER BY n.title
            "#,
        )?;

        let notes: Vec<(String, String)> = stmt
            .query_map(params![target_folder_id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?
            .filter_map(|r| r.ok())
            .collect();

        let mut results = Vec::new();
        for (note_id, title) in notes {
            let content = VfsNoteRepo::get_note_content(&self.vfs_db, &note_id)?
                .unwrap_or_default();
            if !content.is_empty() {
                let cat_name = title
                    .strip_prefix(CATEGORY_NOTE_PREFIX)
                    .and_then(|s| s.strip_suffix(CATEGORY_NOTE_SUFFIX))
                    .unwrap_or(&title);
                results.push((cat_name.to_string(), content));
            }
        }

        Ok(results)
    }

    fn find_system_folder(&self, root_folder_id: &str) -> VfsResult<Option<String>> {
        use crate::vfs::repos::folder_repo::VfsFolderRepo;
        let children = VfsFolderRepo::list_folders_by_parent(&self.vfs_db, Some(root_folder_id))?;
        Ok(children
            .iter()
            .find(|f| f.title == "__system__")
            .map(|f| f.id.clone()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_category_note_title() {
        assert_eq!(
            MemoryCategoryManager::category_note_title("偏好"),
            "__cat_偏好__"
        );
        assert_eq!(
            MemoryCategoryManager::category_note_title("学科状态"),
            "__cat_学科状态__"
        );
    }
}
