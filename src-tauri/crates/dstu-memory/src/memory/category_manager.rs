//! 分层分类文件管理器（Memory Category Layer）
//!
//! 受 memU 三层架构启发：
//! - Resource Layer：对话记录（ChatV2 已有）
//! - Memory Item Layer：原子记忆笔记（已有）
//! - Memory Category Layer：分类聚合文件（本模块实现）
//!
//! 通过 `__cat_*__` 前缀笔记存储分类摘要，
//! 这些笔记在 list/search 中被过滤（标题以 `__` 开头）。

use std::collections::HashSet;
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
/// 聚合笔记成员清单的 tag 前缀（`_member:<note_id>`）
///
/// 分类摘要注入 system prompt 后，据此批量回写成员记忆的注入在场信号
/// （见 `MemoryService::record_injection_presence`），与 `_hits:`/`_ref:`
/// 等既有 tag 编码风格一致，读取时随 notes.tags 一并取出、无额外查询。
const MEMBER_TAG_PREFIX: &str = "_member:";

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

    fn category_note_title(category_key: &str) -> String {
        format!(
            "{}{}{}",
            CATEGORY_NOTE_PREFIX, category_key, CATEGORY_NOTE_SUFFIX
        )
    }

    fn encode_category_key(category_name: &str, folder_path: &str) -> String {
        if folder_path.is_empty() {
            return category_name.to_string();
        }
        format!("path:{}", urlencoding::encode(folder_path))
    }

    fn decode_category_key(category_key: &str) -> String {
        if let Some(encoded) = category_key.strip_prefix("path:") {
            return urlencoding::decode(encoded)
                .map(|s| s.into_owned())
                .unwrap_or_else(|_| encoded.to_string());
        }
        // 兼容历史 key：曾使用全角斜杠替换分隔符
        category_key.replace('／', "/")
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

        let mut seen_paths = HashSet::new();
        categories.retain(|(_, path)| seen_paths.insert(path.clone()));

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
        let memories = memory_service.list_shallow(Some(folder_path), 50, 0)?;

        // 排除系统笔记、过时（_stale）与已归档（_archived）的记忆：
        // 归档记忆已移出检索索引，若仍参与聚合会经 `_member:` 清单被每轮注入
        // 刷新 `_last_injected`，休眠语义即失效
        let memories: Vec<&MemoryListItem> = memories
            .iter()
            .filter(|m| !m.title.starts_with("__") && !m.is_stale && !m.is_archived)
            .collect();

        if memories.is_empty() {
            debug!(
                "[CategoryManager] No memories in '{}', deleting stale category file if exists",
                folder_path
            );
            let sys_folder_id = memory_service.get_or_create_system_folder_id()?;
            let category_key = Self::encode_category_key(category_name, folder_path);
            let cat_title = Self::category_note_title(&category_key);
            self.delete_category_note_if_exists(&sys_folder_id, &cat_title)?;
            return Ok(());
        }

        let mut memory_contents: Vec<String> = Vec::new();
        for mem in &memories {
            if mem.memory_type == "note" {
                memory_contents.push(format!("[经验笔记] {}", mem.title));
                continue;
            }
            if mem.memory_type == "study" {
                memory_contents.push(format!("[学习记忆] {}", mem.title));
                continue;
            }
            let content = VfsNoteRepo::get_note_content(&self.vfs_db, &mem.id)?.unwrap_or_default();
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

        // 使用可逆编码保存路径 key，避免路径分隔符与原始字符碰撞。
        let category_key = Self::encode_category_key(category_name, folder_path);
        let cat_title = Self::category_note_title(&category_key);
        // 成员 note_id 清单随聚合笔记持久化，供注入在场信号回写底层记忆
        let member_ids: Vec<String> = memories.iter().map(|m| m.id.clone()).collect();
        self.upsert_category_note(&sys_folder_id, &cat_title, &summary, &member_ids)?;

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

    /// 构建聚合笔记的 tags：`_system` + 成员清单（`_member:<note_id>`）
    fn build_category_note_tags(member_ids: &[String]) -> Vec<String> {
        let mut tags = Vec::with_capacity(member_ids.len() + 1);
        tags.push("_system".to_string());
        for id in member_ids {
            tags.push(format!("{}{}", MEMBER_TAG_PREFIX, id));
        }
        tags
    }

    /// 从聚合笔记 tags 中解析成员 note_id 清单
    fn extract_member_ids(tags: &[String]) -> Vec<String> {
        tags.iter()
            .filter_map(|t| t.strip_prefix(MEMBER_TAG_PREFIX))
            .map(|s| s.to_string())
            .collect()
    }

    /// 创建或更新分类摘要笔记（tags 中同步重写成员清单）
    fn upsert_category_note(
        &self,
        root_folder_id: &str,
        title: &str,
        content: &str,
        member_ids: &[String],
    ) -> VfsResult<()> {
        use rusqlite::params;

        let conn = self.vfs_db.get_conn_safe()?;
        let existing: Option<String> = conn
            .query_row(
                r#"
                SELECT n.id FROM notes n
                JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
                WHERE n.title = ?1 AND fi.folder_id = ?2
                  AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
                LIMIT 1
                "#,
                params![title, root_folder_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(note_id) = existing {
            let updated = VfsNoteRepo::update_note(
                &self.vfs_db,
                &note_id,
                VfsUpdateNoteParams {
                    title: None,
                    content: Some(content.to_string()),
                    // 每次刷新整体重写成员清单，自动淘汰已删除/已 stale 的旧成员
                    tags: Some(Self::build_category_note_tags(member_ids)),
                    expected_updated_at: None,
                },
            )?;
            if let Err(e) = VfsIndexStateRepo::mark_disabled_with_reason(
                &self.vfs_db,
                &updated.resource_id,
                "system category note",
            ) {
                warn!(
                    "[CategoryManager] Failed to disable indexing for category note update: {}",
                    e
                );
            }
            debug!("[CategoryManager] Updated category note: {}", title);
        } else {
            let note = VfsNoteRepo::create_note_in_folder(
                &self.vfs_db,
                VfsCreateNoteParams {
                    title: title.to_string(),
                    content: content.to_string(),
                    tags: Self::build_category_note_tags(member_ids),
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

    fn delete_category_note_if_exists(&self, root_folder_id: &str, title: &str) -> VfsResult<()> {
        use rusqlite::params;

        let conn = self.vfs_db.get_conn_safe()?;
        let existing: Option<String> = conn
            .query_row(
                r#"
                SELECT n.id FROM notes n
                JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
                WHERE n.title = ?1 AND fi.folder_id = ?2
                  AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
                LIMIT 1
                "#,
                params![title, root_folder_id],
                |row| row.get(0),
            )
            .ok();

        if let Some(note_id) = existing {
            VfsNoteRepo::delete_note_with_folder_item(&self.vfs_db, &note_id)?;
            debug!("[CategoryManager] Deleted empty category note: {}", title);
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
        Ok(self
            .load_all_category_summaries_with_members(root_folder_id)?
            .into_iter()
            .map(|(name, content, _)| (name, content))
            .collect())
    }

    /// 同 `load_all_category_summaries`，额外返回每个分类的成员 note_id 清单
    /// （从聚合笔记 tags 的 `_member:` 前缀解析，供注入在场信号回写）
    pub fn load_all_category_summaries_with_members(
        &self,
        root_folder_id: &str,
    ) -> VfsResult<Vec<(String, String, Vec<String>)>> {
        let sys_folder_id = self.find_system_folder(root_folder_id)?;
        let mut folder_ids = Vec::new();
        if let Some(sys_id) = sys_folder_id {
            folder_ids.push(sys_id);
        }
        folder_ids.push(root_folder_id.to_string());

        let mut dedup_keys = HashSet::new();
        let mut results = Vec::new();
        for folder_id in folder_ids {
            for (note_id, title, tags) in self.list_category_notes_in_folder(&folder_id)? {
                let cat_name = title
                    .strip_prefix(CATEGORY_NOTE_PREFIX)
                    .and_then(|s| s.strip_suffix(CATEGORY_NOTE_SUFFIX))
                    .unwrap_or(&title);
                let decoded = Self::decode_category_key(cat_name);
                if !dedup_keys.insert(decoded.clone()) {
                    continue;
                }
                let content =
                    VfsNoteRepo::get_note_content(&self.vfs_db, &note_id)?.unwrap_or_default();
                if !content.is_empty() {
                    results.push((decoded, content, Self::extract_member_ids(&tags)));
                }
            }
        }

        Ok(results)
    }

    fn list_category_notes_in_folder(
        &self,
        folder_id: &str,
    ) -> VfsResult<Vec<(String, String, Vec<String>)>> {
        use rusqlite::params;
        let conn = self.vfs_db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            r#"
            SELECT n.id, n.title, n.tags FROM notes n
            JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
            WHERE fi.folder_id = ?1 AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
              AND n.title LIKE '!_!_cat!_%!_!_' ESCAPE '!'
            ORDER BY n.title
            "#,
        )?;
        let notes: Vec<(String, String, Vec<String>)> = stmt
            .query_map(params![folder_id], |row| {
                let tags_json: Option<String> = row.get(2)?;
                let tags: Vec<String> = tags_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok())
                    .unwrap_or_default();
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, tags))
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(notes)
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
            MemoryCategoryManager::category_note_title("经历／学科状态"),
            "__cat_经历／学科状态__"
        );
    }

    #[test]
    fn test_category_key_roundtrip_normal_path() {
        let key = MemoryCategoryManager::encode_category_key("学科状态", "经历/学科状态");
        assert_eq!(
            MemoryCategoryManager::decode_category_key(&key),
            "经历/学科状态"
        );
    }

    #[test]
    fn test_category_key_roundtrip_with_fullwidth_slash() {
        let key = MemoryCategoryManager::encode_category_key("学科状态", "经历／学科状态");
        assert_eq!(
            MemoryCategoryManager::decode_category_key(&key),
            "经历／学科状态"
        );
    }

    #[test]
    fn test_category_key_legacy_compatibility() {
        assert_eq!(
            MemoryCategoryManager::decode_category_key("经历／学科状态"),
            "经历/学科状态"
        );
    }

    #[test]
    fn test_member_tags_roundtrip() {
        let member_ids = vec!["note_a".to_string(), "note_b".to_string()];
        let tags = MemoryCategoryManager::build_category_note_tags(&member_ids);
        assert_eq!(tags[0], "_system");
        assert_eq!(MemoryCategoryManager::extract_member_ids(&tags), member_ids);
        // 无成员标签的历史聚合笔记解析为空清单
        assert!(MemoryCategoryManager::extract_member_ids(&["_system".to_string()]).is_empty());
    }
}
