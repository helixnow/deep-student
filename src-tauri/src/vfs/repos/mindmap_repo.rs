//! VFS 知识导图表 CRUD 操作
//!
//! 知识导图内容存储在 `resources.data`，本模块只管理知识导图元数据。
//!
//! ## 核心方法
//! - `create_mindmap`: 创建知识导图
//! - `update_mindmap`: 更新知识导图
//! - `get_mindmap`: 获取知识导图元数据
//! - `get_mindmap_content`: 获取知识导图内容
//! - `list_mindmaps`: 列出所有知识导图
//! - `delete_mindmap`: 软删除知识导图

use std::sync::atomic::{AtomicU32, Ordering};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tracing::{debug, error, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::resource_repo::VfsResourceRepo;
use crate::vfs::types::{
    VfsCreateMindMapParams, VfsFolderItem, VfsMindMap, VfsMindMapVersion, VfsResourceType,
    VfsUpdateMindMapParams,
};

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::MindMapRepo] Row parse error (skipped): {}", e);
            None
        }
    }
}

/// 解析 settings JSON 列，解析失败时记录警告（带 mindmap id 上下文）而非静默丢弃
fn parse_settings_json(mindmap_id: &str, settings_str: Option<String>) -> Option<Value> {
    settings_str.and_then(|s| match serde_json::from_str(&s) {
        Ok(v) => Some(v),
        Err(e) => {
            warn!(
                "[VFS::MindMapRepo] Invalid settings JSON for mindmap {} (ignored): {}",
                mindmap_id, e
            );
            None
        }
    })
}

/// 版本快照连续失败计数（进程级）：用于日志提级，连续失败达到阈值时升为 error
static VERSION_SNAPSHOT_CONSECUTIVE_FAILURES: AtomicU32 = AtomicU32::new(0);

/// VFS 知识导图表 Repo
pub struct VfsMindMapRepo;

impl VfsMindMapRepo {
    /// 最大思维导图深度限制
    const MAX_MINDMAP_DEPTH: usize = 100;
    /// 最大思维导图节点数量限制
    const MAX_MINDMAP_NODES: usize = 10000;

    /// 规范化思维导图内容（修复字段 + 校验结构 + 限制深度/节点数）
    fn normalize_mindmap_content(content: &str) -> VfsResult<String> {
        let mut doc: Value =
            serde_json::from_str(content).map_err(|e| VfsError::InvalidArgument {
                param: "content".to_string(),
                reason: format!("Invalid JSON: {}", e),
            })?;

        if !doc.is_object() {
            return Err(VfsError::InvalidArgument {
                param: "content".to_string(),
                reason: "MindMapDocument must be a JSON object".to_string(),
            });
        }

        // 兼容：LLM 可能直接传 root 节点（无 version/meta/root）
        let is_node_like = {
            let obj = doc.as_object().unwrap();
            !obj.contains_key("root") && (obj.contains_key("text") || obj.contains_key("children"))
        };
        if is_node_like {
            doc = serde_json::json!({
                "version": "1.0",
                "root": doc,
                "meta": { "createdAt": "" }
            });
        }

        let doc_obj = doc
            .as_object_mut()
            .ok_or_else(|| VfsError::InvalidArgument {
                param: "content".to_string(),
                reason: "MindMapDocument must be a JSON object".to_string(),
            })?;

        // version
        let version_valid = doc_obj
            .get("version")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        if !version_valid {
            doc_obj.insert("version".to_string(), Value::String("1.0".to_string()));
        }

        // meta
        let meta = doc_obj
            .entry("meta")
            .or_insert_with(|| serde_json::json!({}));
        if !meta.is_object() {
            *meta = serde_json::json!({});
        }
        if let Some(meta_obj) = meta.as_object_mut() {
            let created_at_valid = meta_obj
                .get("createdAt")
                .and_then(|v| v.as_str())
                .map(|v| !v.trim().is_empty())
                .unwrap_or(false);
            if !created_at_valid {
                // ★ 2026-02 修复：使用当前时间戳而非空字符串，防止前端 Date.parse("") 返回 NaN
                let now = chrono::Utc::now()
                    .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                    .to_string();
                meta_obj.insert("createdAt".to_string(), Value::String(now));
            }
        }

        // root
        if !doc_obj.contains_key("root") {
            doc_obj.insert(
                "root".to_string(),
                serde_json::json!({
                    "id": "root",
                    "text": "根节点",
                    "children": []
                }),
            );
        }
        let root = doc_obj
            .get_mut("root")
            .ok_or_else(|| VfsError::InvalidArgument {
                param: "content".to_string(),
                reason: "Missing root node".to_string(),
            })?;

        let mut node_count = 0usize;
        // ★ 2026-07（B9）：节点 ID 唯一性校验——重复 ID 会导致前端树操作
        // （定位/移动/删除按 id 寻址）静默作用到错误节点。发现重复时重新
        // 生成新 ID 并记录 warn，而非拒绝整份文档（保持 normalize 的修复语义）。
        //
        // 环检测说明（防御性）：文档经 serde_json 解析为值树，JSON 文本本身
        // 无法表达引用环，物理上不可能成环；深度上限（MAX_MINDMAP_DEPTH）
        // 已作为遍历深度的防御性护栏。
        let mut seen_ids: std::collections::HashSet<String> = std::collections::HashSet::new();
        Self::normalize_mindmap_node(root, 0, &mut node_count, &mut seen_ids)?;

        serde_json::to_string(&doc).map_err(|e| VfsError::Serialization(e.to_string()))
    }

    fn normalize_mindmap_node(
        node: &mut Value,
        depth: usize,
        node_count: &mut usize,
        seen_ids: &mut std::collections::HashSet<String>,
    ) -> VfsResult<()> {
        if depth > Self::MAX_MINDMAP_DEPTH {
            return Err(VfsError::InvalidArgument {
                param: "content".to_string(),
                reason: format!("Mindmap depth exceeds limit ({})", Self::MAX_MINDMAP_DEPTH),
            });
        }

        let obj = node
            .as_object_mut()
            .ok_or_else(|| VfsError::InvalidArgument {
                param: "content".to_string(),
                reason: "Mindmap node must be an object".to_string(),
            })?;

        *node_count += 1;
        if *node_count > Self::MAX_MINDMAP_NODES {
            return Err(VfsError::InvalidArgument {
                param: "content".to_string(),
                reason: format!(
                    "Mindmap node count exceeds limit ({})",
                    Self::MAX_MINDMAP_NODES
                ),
            });
        }

        // id（缺失/空白 → 生成；重复 → 重新生成并 warn，保证全树唯一）
        let current_id = obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty());
        let unique_id = match current_id {
            Some(id) if !seen_ids.contains(&id) => id,
            Some(dup_id) => {
                let mut new_id = nanoid::nanoid!(10);
                while seen_ids.contains(&new_id) {
                    new_id = nanoid::nanoid!(10);
                }
                warn!(
                    "[VFS::MindMapRepo] Duplicate node id {:?} detected (depth={}), regenerated as {:?}",
                    dup_id, depth, new_id
                );
                new_id
            }
            None => {
                if depth == 0 && !seen_ids.contains("root") {
                    "root".to_string()
                } else {
                    let mut new_id = nanoid::nanoid!(10);
                    while seen_ids.contains(&new_id) {
                        new_id = nanoid::nanoid!(10);
                    }
                    new_id
                }
            }
        };
        seen_ids.insert(unique_id.clone());
        obj.insert("id".to_string(), Value::String(unique_id));

        // text
        // ★ 性能优化：text 已是非空字符串时跳过重写，避免每节点一次 String 分配
        // （自动保存路径每 1.5s 全量规范化一次，万节点导图收益明显；行为不变）
        let text_already_valid = obj
            .get("text")
            .and_then(|v| v.as_str())
            .map(|s| !s.trim().is_empty())
            .unwrap_or(false);
        if !text_already_valid {
            let value_to_string = |v: &Value| match v {
                Value::String(s) => Some(s.to_string()),
                Value::Number(n) => Some(n.to_string()),
                Value::Bool(b) => Some(b.to_string()),
                _ => None,
            };
            let mut text_value = obj.get("text").and_then(value_to_string);
            if text_value
                .as_deref()
                .map(|s| s.trim().is_empty())
                .unwrap_or(true)
            {
                let fallback = obj
                    .get("name")
                    .or_else(|| obj.get("label"))
                    .or_else(|| obj.get("title"))
                    .or_else(|| obj.get("value"))
                    .or_else(|| obj.get("content"))
                    .and_then(value_to_string);
                text_value = fallback.or_else(|| Some("未命名".to_string()));
            }
            obj.insert(
                "text".to_string(),
                Value::String(text_value.unwrap_or_default()),
            );
        }

        // note — 规范化为字符串，非字符串类型（如 {} 空对象）转为空字符串
        if let Some(note) = obj.get("note") {
            if !note.is_string() {
                obj.insert("note".to_string(), Value::String(String::new()));
            }
        }

        // children
        let children = obj
            .entry("children")
            .or_insert_with(|| serde_json::json!([]));
        if !children.is_array() {
            *children = serde_json::json!([]);
        }

        if let Some(arr) = children.as_array_mut() {
            for child in arr.iter_mut() {
                Self::normalize_mindmap_node(child, depth + 1, node_count, seen_ids)?;
            }
        }

        Ok(())
    }

    // ========================================================================
    // 创建知识导图
    // ========================================================================

    /// 创建知识导图
    ///
    /// ## 流程
    /// 1. 创建或复用资源（基于内容 hash 去重）
    /// 2. 创建知识导图元数据记录
    pub fn create_mindmap(
        db: &VfsDatabase,
        params: VfsCreateMindMapParams,
    ) -> VfsResult<VfsMindMap> {
        let conn = db.get_conn_safe()?;
        Self::create_mindmap_with_conn(&conn, params)
    }

    /// 创建知识导图（使用现有连接）
    ///
    /// ★ 2026-07 修复（B13）：裸 create 路径原先无事务，资源创建成功但
    /// mindmaps INSERT 失败会残留孤儿 resource。改用 SAVEPOINT 保护
    /// （可安全嵌套在 create_mindmap_in_folder 的 BEGIN IMMEDIATE 内）。
    pub fn create_mindmap_with_conn(
        conn: &Connection,
        params: VfsCreateMindMapParams,
    ) -> VfsResult<VfsMindMap> {
        conn.execute("SAVEPOINT vfs_mindmap_create_tx", [])?;

        let result = Self::create_mindmap_inner(conn, params);

        match result {
            Ok(mindmap) => {
                if let Err(release_err) = conn.execute("RELEASE SAVEPOINT vfs_mindmap_create_tx", [])
                {
                    let _ = conn.execute_batch(
                        "ROLLBACK TO SAVEPOINT vfs_mindmap_create_tx; RELEASE SAVEPOINT vfs_mindmap_create_tx;",
                    );
                    return Err(release_err.into());
                }
                Ok(mindmap)
            }
            Err(e) => {
                let _ = conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT vfs_mindmap_create_tx; RELEASE SAVEPOINT vfs_mindmap_create_tx;",
                );
                Err(e)
            }
        }
    }

    /// 创建知识导图的内部逻辑（不含事务管理）
    fn create_mindmap_inner(
        conn: &Connection,
        params: VfsCreateMindMapParams,
    ) -> VfsResult<VfsMindMap> {
        let final_title = if params.title.trim().is_empty() {
            warn!("[VFS::MindMapRepo] create_mindmap: 标题为空，使用默认标题");
            "无标题导图".to_string()
        } else {
            params.title.clone()
        };

        let mindmap_id = VfsMindMap::generate_id();
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        // 1. 规范化内容并创建资源
        let normalized_content = Self::normalize_mindmap_content(&params.content)?;
        let resource_result = VfsResourceRepo::create_or_reuse_with_conn(
            conn,
            VfsResourceType::MindMap,
            &normalized_content,
            Some(&mindmap_id),
            Some("mindmaps"),
            None,
        )?;

        // 2. 创建知识导图记录（content_updated_at 初始 = updated_at）
        conn.execute(
            r#"
            INSERT INTO mindmaps (id, resource_id, title, description, is_favorite, default_view, theme, settings, created_at, updated_at, content_updated_at)
            VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, NULL, ?7, ?8, ?9)
            "#,
            params![
                mindmap_id,
                resource_result.resource_id,
                final_title,
                params.description,
                params.default_view,
                params.theme,
                now,
                now,
                now,
            ],
        )?;

        info!(
            "[VFS::MindMapRepo] Created mindmap: {} (resource: {})",
            mindmap_id, resource_result.resource_id
        );

        Ok(VfsMindMap {
            id: mindmap_id,
            resource_id: resource_result.resource_id,
            title: final_title,
            description: params.description,
            is_favorite: false,
            default_view: params.default_view,
            theme: params.theme,
            settings: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            content_updated_at: now,
            deleted_at: None,
        })
    }

    /// 在指定文件夹中创建知识导图
    pub fn create_mindmap_in_folder(
        db: &VfsDatabase,
        params: VfsCreateMindMapParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsMindMap> {
        let conn = db.get_conn_safe()?;
        Self::create_mindmap_in_folder_with_conn(&conn, params, folder_id)
    }

    /// 在指定文件夹中创建知识导图（使用现有连接）
    ///
    /// ★ CONC-01 修复：使用事务保护，防止导图创建成功但 folder_items 失败导致"孤儿资源"
    pub fn create_mindmap_in_folder_with_conn(
        conn: &Connection,
        params: VfsCreateMindMapParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsMindMap> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsMindMap> {
            // 1. 检查文件夹存在性
            if let Some(fid) = folder_id {
                if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                    return Err(VfsError::NotFound {
                        resource_type: "Folder".to_string(),
                        id: fid.to_string(),
                    });
                }
            }

            // 2. 创建知识导图
            let mindmap = Self::create_mindmap_with_conn(conn, params)?;

            // 3. 创建 folder_items 记录
            let folder_item = VfsFolderItem::new(
                folder_id.map(|s| s.to_string()),
                "mindmap".to_string(),
                mindmap.id.clone(),
            );
            VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;

            debug!(
                "[VFS::MindMapRepo] Created mindmap {} in folder {:?}",
                mindmap.id, folder_id
            );

            Ok(mindmap)
        })();

        match result {
            Ok(mindmap) => {
                conn.execute("COMMIT", [])?;
                Ok(mindmap)
            }
            Err(e) => {
                // 回滚事务，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 更新知识导图
    // ========================================================================

    /// 更新知识导图
    pub fn update_mindmap(
        db: &VfsDatabase,
        mindmap_id: &str,
        params: VfsUpdateMindMapParams,
    ) -> VfsResult<VfsMindMap> {
        let conn = db.get_conn_safe()?;
        Self::update_mindmap_with_conn(&conn, mindmap_id, params)
    }

    /// 更新知识导图（使用现有连接）
    pub fn update_mindmap_with_conn(
        conn: &Connection,
        mindmap_id: &str,
        params: VfsUpdateMindMapParams,
    ) -> VfsResult<VfsMindMap> {
        Self::update_mindmap_returning_version_with_conn(conn, mindmap_id, params, false)
            .map(|(mindmap, _)| mindmap)
    }

    /// 更新知识导图并返回本次更新产生的内容版本（供 Chat 引用复用）
    ///
    /// `snapshot_after = true` 时（Chat 工具链路）：
    /// - 不再对旧内容做 `version_source` 来源的更新前快照（消除双快照，B4）；
    ///   仅当旧内容未被任何已有版本捕获（hash 比对）时，补一条
    ///   `pre_chat_backup` 备份（可剪枝），保证聊天改写前的用户状态可回溯；
    /// - 更新落库后在**同一事务内**为最终内容创建 `version_source` 来源的
    ///   版本快照并随元组返回——citation `mv_*` 指向更新后的内容；
    /// - 版本写入失败 fail-closed：整个更新回滚并返回错误（B3）。
    ///
    /// `snapshot_after = false` 时（编辑器/DSTU 路径）：保持原行为——
    /// 内容变化前快照旧内容；快照失败 fail-open（warn/连续失败提级 error），
    /// 但 `version_source` 为 chat% 时同样 fail-closed（聊天引用不可缺快照）。
    pub fn update_mindmap_returning_version(
        db: &VfsDatabase,
        mindmap_id: &str,
        params: VfsUpdateMindMapParams,
        snapshot_after: bool,
    ) -> VfsResult<(VfsMindMap, Option<VfsMindMapVersion>)> {
        let conn = db.get_conn_safe()?;
        Self::update_mindmap_returning_version_with_conn(&conn, mindmap_id, params, snapshot_after)
    }

    /// 更新知识导图（使用现有连接，返回更新后内容版本）
    ///
    /// ★ 2026-02 修复：添加事务保护，防止乐观锁检查与 UPDATE 之间的 TOCTOU 竞态
    pub fn update_mindmap_returning_version_with_conn(
        conn: &Connection,
        mindmap_id: &str,
        params: VfsUpdateMindMapParams,
        snapshot_after: bool,
    ) -> VfsResult<(VfsMindMap, Option<VfsMindMapVersion>)> {
        // 开始事务，保护 read-check-write 的原子性
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<(VfsMindMap, Option<VfsMindMapVersion>)> {
            // 1. 获取当前知识导图
            let current = Self::get_mindmap_with_conn(conn, mindmap_id)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "MindMap".to_string(),
                    id: mindmap_id.to_string(),
                }
            })?;

            // ★ 2026-07（B5）：OCC 基线切换为 content_updated_at（内容锁）。
            // 过渡策略：expected 与 content_updated_at 或 updated_at 任一匹配即放行——
            // 存量前端仍携带 metadata.updatedAt，切换期不产生伪失败；
            // 纯元数据操作（收藏/重命名）只推进 updated_at，不再制造内容伪冲突。
            if let Some(expected_updated_at) = params.expected_updated_at.as_ref() {
                let matches_content = current.content_updated_at == *expected_updated_at;
                let matches_meta = current.updated_at == *expected_updated_at;
                if !matches_content && !matches_meta {
                    return Err(VfsError::InvalidOperation {
                        operation: "mindmap_update_conflict".to_string(),
                        reason: format!(
                            "MINDMAP_UPDATE_CONFLICT: expected_updated_at={}, actual_content_updated_at={}, actual_updated_at={}",
                            expected_updated_at, current.content_updated_at, current.updated_at
                        ),
                    });
                }
            }

            let is_chat_source = params
                .version_source
                .as_deref()
                .map(|s| s.starts_with("chat"))
                .unwrap_or(false);

            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();

            // 2. 处理内容更新（共享资源 -> 写时复制）
            //
            // ★ 2026-01 修复：导图是 1:1 关系，每次编辑创建新资源会导致：
            //   - 旧资源残留在索引中
            //   - 向量化状态页面出现大量重复导图
            //
            // 改为原地更新资源的 data 字段，保持 resource_id 不变；
            // 若资源被多个导图共享，则写时复制，避免跨导图污染。
            let mut final_resource_id = current.resource_id.clone();
            let mut final_normalized_content: Option<String> = None;
            let content_changed = if let Some(new_content) = &params.content {
                let normalized_content = Self::normalize_mindmap_content(new_content)?;
                let current_resource =
                    VfsResourceRepo::get_resource_with_conn(conn, &current.resource_id)?
                        .ok_or_else(|| VfsError::NotFound {
                            resource_type: "Resource".to_string(),
                            id: current.resource_id.clone(),
                        })?;
                let new_hash = VfsResourceRepo::compute_hash(&normalized_content);
                let changed = if new_hash == current_resource.hash {
                    false
                } else {
                    // ★ 2026-02-12：内容变化前，保存旧版本快照到 mindmap_versions
                    if let Some(old_data) = &current_resource.data {
                        if snapshot_after {
                            // Chat 双快照消除（B4）：更新后会为新内容建版本，
                            // 这里只在旧内容尚未被任何版本捕获时补 pre_chat_backup。
                            Self::snapshot_old_content_if_uncaptured(
                                conn,
                                mindmap_id,
                                old_data,
                                &current_resource.hash,
                                &current.title,
                            )?;
                        } else {
                            match Self::create_version_with_conn(
                                conn,
                                mindmap_id,
                                old_data,
                                &current.title,
                                None,
                                params.version_source.as_deref(),
                            ) {
                                Ok(_) => {
                                    VERSION_SNAPSHOT_CONSECUTIVE_FAILURES
                                        .store(0, Ordering::Relaxed);
                                }
                                Err(e) => {
                                    // ★ 2026-07（B3）：chat 来源 fail-closed——聊天引用
                                    // （mv_*）依赖版本快照，缺失即中止并回滚整个更新；
                                    // 编辑器自动保存保持 fail-open（warn/连续失败提级 error）。
                                    if is_chat_source {
                                        error!(
                                            "[VFS::MindMapRepo] MINDMAP_VERSION_SNAPSHOT_FAILED (chat source, fail-closed): mindmap {}: {}",
                                            mindmap_id, e
                                        );
                                        return Err(e);
                                    }
                                    let failures = VERSION_SNAPSHOT_CONSECUTIVE_FAILURES
                                        .fetch_add(1, Ordering::Relaxed)
                                        + 1;
                                    if failures >= 3 {
                                        error!(
                                            "[VFS::MindMapRepo] MINDMAP_VERSION_SNAPSHOT_FAILED (consecutive={}): mindmap {}: {}",
                                            failures, mindmap_id, e
                                        );
                                    } else {
                                        warn!(
                                            "[VFS::MindMapRepo] MINDMAP_VERSION_SNAPSHOT_FAILED: mindmap {}: {}",
                                            mindmap_id, e
                                        );
                                    }
                                }
                            }
                        }
                    }

                    let shared_count = Self::count_active_mindmaps_by_resource_id_with_conn(
                        conn,
                        &current.resource_id,
                    )?;
                    if shared_count > 1 {
                        let resource_result = VfsResourceRepo::create_or_reuse_with_conn(
                            conn,
                            VfsResourceType::MindMap,
                            &normalized_content,
                            Some(mindmap_id),
                            Some("mindmaps"),
                            None,
                        )?;
                        final_resource_id = resource_result.resource_id;
                        true
                    } else {
                        VfsResourceRepo::update_resource_data_with_conn(
                            conn,
                            &current.resource_id,
                            &normalized_content,
                        )?
                    }
                };
                final_normalized_content = Some(normalized_content);
                changed
            } else {
                false
            };

            if content_changed {
                debug!(
                    "[VFS::MindMapRepo] Content changed for mindmap {}, resource {} will be re-indexed",
                    mindmap_id, current.resource_id
                );
            }

            // 3. 构建更新 SQL（resource_id 保持不变）
            // ★ 2026-07（B5）：仅内容实际变化时推进 content_updated_at
            let final_resource_id = &final_resource_id;
            let final_title = params.title.as_ref().unwrap_or(&current.title);
            let final_description = params.description.clone().or(current.description.clone());
            let final_default_view = params
                .default_view
                .as_ref()
                .unwrap_or(&current.default_view);
            let final_theme = params.theme.clone().or(current.theme.clone());
            let final_settings = params.settings.clone().or(current.settings.clone());
            let settings_json = final_settings.as_ref().map(|v| v.to_string());
            let final_content_updated_at = if content_changed {
                now.clone()
            } else {
                current.content_updated_at.clone()
            };

            conn.execute(
                r#"
                UPDATE mindmaps
                SET resource_id = ?1, title = ?2, description = ?3, default_view = ?4, theme = ?5, settings = ?6, updated_at = ?7, content_updated_at = ?8
                WHERE id = ?9
                "#,
                params![
                    final_resource_id,
                    final_title,
                    final_description,
                    final_default_view,
                    final_theme,
                    settings_json,
                    now,
                    final_content_updated_at,
                    mindmap_id,
                ],
            )?;

            // 4. snapshot_after：同一事务内为最终内容创建版本（Chat 引用复用）。
            // 失败 fail-closed——回滚整个更新，保证「更新成功 ⇔ 引用版本存在」。
            let after_version = if snapshot_after {
                let final_content = match final_normalized_content {
                    Some(c) => Some(c),
                    // 元数据-only 更新（如仅改标题）：为当前内容 + 新标题建引用版本
                    None => VfsResourceRepo::get_resource_with_conn(conn, final_resource_id)?
                        .and_then(|r| r.data),
                };
                match final_content {
                    Some(content) => Some(Self::create_version_with_conn(
                        conn,
                        mindmap_id,
                        &content,
                        final_title,
                        None,
                        params.version_source.as_deref(),
                    )?),
                    None => {
                        warn!(
                            "[VFS::MindMapRepo] snapshot_after requested but resource {} has no data (mindmap {})",
                            final_resource_id, mindmap_id
                        );
                        None
                    }
                }
            } else {
                None
            };

            info!("[VFS::MindMapRepo] Updated mindmap: {}", mindmap_id);

            Ok((
                VfsMindMap {
                    id: mindmap_id.to_string(),
                    resource_id: final_resource_id.clone(),
                    title: final_title.clone(),
                    description: final_description,
                    is_favorite: current.is_favorite,
                    default_view: final_default_view.clone(),
                    theme: final_theme,
                    settings: final_settings,
                    created_at: current.created_at,
                    updated_at: now,
                    content_updated_at: final_content_updated_at,
                    deleted_at: current.deleted_at,
                },
                after_version,
            ))
        })();

        match result {
            Ok(output) => {
                if let Err(commit_err) = conn.execute("COMMIT", []) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(commit_err.into());
                }
                Ok(output)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 旧内容若未被任何已有版本捕获（按 resource hash 比对），补一条
    /// `pre_chat_backup` 备份版本；已捕获则跳过（消除 Chat 双快照的同时
    /// 保证聊天改写前的用户状态可回溯）。失败向上传播（Chat 链路 fail-closed）。
    fn snapshot_old_content_if_uncaptured(
        conn: &Connection,
        mindmap_id: &str,
        old_content: &str,
        old_hash: &str,
        title: &str,
    ) -> VfsResult<()> {
        let captured: i64 = conn.query_row(
            r#"
            SELECT COUNT(*)
            FROM mindmap_versions v
            JOIN resources r ON v.resource_id = r.id
            WHERE v.mindmap_id = ?1 AND r.hash = ?2
            "#,
            params![mindmap_id, old_hash],
            |row| row.get(0),
        )?;

        if captured > 0 {
            debug!(
                "[VFS::MindMapRepo] Old content of mindmap {} already captured by an existing version, skip pre_chat_backup",
                mindmap_id
            );
            return Ok(());
        }

        Self::create_version_with_conn(
            conn,
            mindmap_id,
            old_content,
            title,
            None,
            Some("pre_chat_backup"),
        )?;
        Ok(())
    }

    /// 统计使用指定 resource_id 的所有导图数量（含已删除）
    ///
    /// ★ S-016 修复：计入已删除的导图，使写时复制决策更保守。
    /// 若已删除导图仍共享同一 resource_id，更新活跃导图时也执行写时复制，
    /// 防止恢复已删除导图时发现内容已被覆盖。
    pub fn count_active_mindmaps_by_resource_id(
        db: &VfsDatabase,
        resource_id: &str,
    ) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::count_active_mindmaps_by_resource_id_with_conn(&conn, resource_id)
    }

    /// 统计使用指定 resource_id 的所有导图数量（含已删除，使用现有连接）
    ///
    /// ★ S-016 修复：移除 `deleted_at IS NULL` 条件，计入所有导图（含软删除），
    /// 确保写时复制在有任何共享者（包括已删除的）时都执行。
    pub fn count_active_mindmaps_by_resource_id_with_conn(
        conn: &Connection,
        resource_id: &str,
    ) -> VfsResult<usize> {
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1",
            params![resource_id],
            |row| row.get(0),
        )?;
        Ok(count as usize)
    }

    // ========================================================================
    // 查询知识导图
    // ========================================================================

    /// 获取知识导图元数据
    pub fn get_mindmap(db: &VfsDatabase, mindmap_id: &str) -> VfsResult<Option<VfsMindMap>> {
        let conn = db.get_conn_safe()?;
        Self::get_mindmap_with_conn(&conn, mindmap_id)
    }

    /// 获取知识导图元数据（使用现有连接）
    pub fn get_mindmap_with_conn(
        conn: &Connection,
        mindmap_id: &str,
    ) -> VfsResult<Option<VfsMindMap>> {
        let result = conn
            .query_row(
                r#"
                SELECT id, resource_id, title, description, is_favorite, default_view, theme, settings, created_at, updated_at, deleted_at, COALESCE(content_updated_at, updated_at)
                FROM mindmaps
                WHERE id = ?1 AND deleted_at IS NULL
                "#,
                params![mindmap_id],
                |row| {
                    let id: String = row.get(0)?;
                    let settings_str: Option<String> = row.get(7)?;
                    let settings: Option<Value> = parse_settings_json(&id, settings_str);

                    Ok(VfsMindMap {
                        id,
                        resource_id: row.get(1)?,
                        title: row.get(2)?,
                        description: row.get(3)?,
                        is_favorite: row.get::<_, i32>(4)? != 0,
                        default_view: row.get(5)?,
                        theme: row.get(6)?,
                        settings,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
                        content_updated_at: row.get(11)?,
                        deleted_at: row.get(10)?,
                    })
                },
            )
            .optional()?;

        Ok(result)
    }

    /// 获取知识导图内容
    pub fn get_mindmap_content(db: &VfsDatabase, mindmap_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_mindmap_content_with_conn(&conn, mindmap_id)
    }

    /// 获取知识导图内容（使用现有连接）
    pub fn get_mindmap_content_with_conn(
        conn: &Connection,
        mindmap_id: &str,
    ) -> VfsResult<Option<String>> {
        let mindmap = Self::get_mindmap_with_conn(conn, mindmap_id)?;
        if let Some(m) = mindmap {
            let resource = VfsResourceRepo::get_resource_with_conn(conn, &m.resource_id)?;
            Ok(resource.and_then(|r| r.data))
        } else {
            Ok(None)
        }
    }

    /// 列出所有知识导图（不含软删除）
    pub fn list_mindmaps(db: &VfsDatabase) -> VfsResult<Vec<VfsMindMap>> {
        let conn = db.get_conn_safe()?;
        Self::list_mindmaps_with_conn(&conn)
    }

    /// 按文件夹列出知识导图
    ///
    /// ★ 2026-01-26 新增：支持 builtin-resource_list 工具的 folder_id 参数
    pub fn list_mindmaps_by_folder(
        db: &VfsDatabase,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsMindMap>> {
        let conn = db.get_conn_safe()?;
        Self::list_mindmaps_by_folder_with_conn(&conn, folder_id, limit, offset)
    }

    /// 按文件夹列出知识导图（使用现有连接）
    pub fn list_mindmaps_by_folder_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsMindMap>> {
        let sql = r#"
            SELECT m.id, m.resource_id, m.title, m.description, m.is_favorite, m.default_view, m.theme, m.settings, m.created_at, m.updated_at, m.deleted_at, COALESCE(m.content_updated_at, m.updated_at)
            FROM mindmaps m
            INNER JOIN folder_items fi ON m.id = fi.item_id AND fi.item_type = 'mindmap'
            WHERE m.deleted_at IS NULL AND fi.deleted_at IS NULL AND fi.folder_id IS ?1
            ORDER BY m.updated_at DESC
            LIMIT ?2 OFFSET ?3
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![folder_id, limit, offset], |row| {
            let id: String = row.get(0)?;
            let settings_str: Option<String> = row.get(7)?;
            let settings: Option<Value> = parse_settings_json(&id, settings_str);

            Ok(VfsMindMap {
                id,
                resource_id: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                is_favorite: row.get::<_, i32>(4)? != 0,
                default_view: row.get(5)?,
                theme: row.get(6)?,
                settings,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                content_updated_at: row.get(11)?,
                deleted_at: row.get(10)?,
            })
        })?;

        let mindmaps: Vec<VfsMindMap> = rows.filter_map(log_and_skip_err).collect();
        debug!(
            "[VFS::MindMapRepo] list_mindmaps_by_folder({:?}): {} mindmaps",
            folder_id,
            mindmaps.len()
        );
        Ok(mindmaps)
    }

    /// 列出所有知识导图（使用现有连接）
    pub fn list_mindmaps_with_conn(conn: &Connection) -> VfsResult<Vec<VfsMindMap>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, description, is_favorite, default_view, theme, settings, created_at, updated_at, deleted_at, COALESCE(content_updated_at, updated_at)
            FROM mindmaps
            WHERE deleted_at IS NULL
            ORDER BY updated_at DESC
            "#,
        )?;

        let rows = stmt.query_map([], |row| {
            let id: String = row.get(0)?;
            let settings_str: Option<String> = row.get(7)?;
            let settings: Option<Value> = parse_settings_json(&id, settings_str);

            Ok(VfsMindMap {
                id,
                resource_id: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                is_favorite: row.get::<_, i32>(4)? != 0,
                default_view: row.get(5)?,
                theme: row.get(6)?,
                settings,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                content_updated_at: row.get(11)?,
                deleted_at: row.get(10)?,
            })
        })?;

        let mut result = Vec::new();
        for row in rows {
            result.push(row?);
        }

        Ok(result)
    }

    // ========================================================================
    // 删除知识导图
    // ========================================================================

    /// 软删除知识导图
    pub fn delete_mindmap(db: &VfsDatabase, mindmap_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_mindmap_with_conn(&conn, mindmap_id)
    }

    /// 软删除知识导图（使用现有连接）
    ///
    /// ★ P0 修复：使用事务保护，防止 mindmaps 删除成功但 folder_items 删除失败导致数据不一致
    pub fn delete_mindmap_with_conn(conn: &Connection, mindmap_id: &str) -> VfsResult<()> {
        // ★ P0 修复：使用 SAVEPOINT 替代 BEGIN IMMEDIATE，支持在外层事务中嵌套调用
        // （如 dstu_delete_many 批量删除场景）
        conn.execute("SAVEPOINT delete_mindmap", [])?;

        let result = (|| -> VfsResult<()> {
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();

            let affected = conn.execute(
                "UPDATE mindmaps SET deleted_at = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
                params![now, now, mindmap_id],
            )?;

            if affected == 0 {
                // M-080 fix: 幂等删除——区分"已删除"与"完全不存在"
                let exists: bool = conn.query_row(
                    "SELECT EXISTS(SELECT 1 FROM mindmaps WHERE id = ?1)",
                    params![mindmap_id],
                    |row| row.get(0),
                )?;
                if exists {
                    // 记录存在但 deleted_at 已设置 → 已删除，幂等返回 Ok
                    info!(
                        "[VFS::MindMapRepo] Mindmap already deleted (idempotent): {}",
                        mindmap_id
                    );
                    return Ok(());
                } else {
                    // 记录完全不存在 → 返回 NotFound
                    return Err(VfsError::NotFound {
                        resource_type: "MindMap".to_string(),
                        id: mindmap_id.to_string(),
                    });
                }
            }

            // 同时软删除 folder_items 记录
            // ★ P0 修复：deleted_at 是 TEXT 列（用 now），updated_at 是 INTEGER 列（用毫秒时间戳）
            let now_ms = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "UPDATE folder_items SET deleted_at = ?1, updated_at = ?2 WHERE item_id = ?3 AND item_type = 'mindmap' AND deleted_at IS NULL",
                params![now, now_ms, mindmap_id],
            )?;

            Ok(())
        })();

        match result {
            Ok(_) => {
                if let Err(commit_err) = conn.execute("RELEASE SAVEPOINT delete_mindmap", []) {
                    let _ = conn.execute("ROLLBACK TO SAVEPOINT delete_mindmap", []);
                    return Err(commit_err.into());
                }
                info!("[VFS::MindMapRepo] Soft deleted mindmap: {}", mindmap_id);
                Ok(())
            }
            Err(e) => {
                // 回滚 SAVEPOINT，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO SAVEPOINT delete_mindmap", []);
                let _ = conn.execute("RELEASE SAVEPOINT delete_mindmap", []);
                Err(e)
            }
        }
    }

    /// 恢复软删除的知识导图
    ///
    /// ★ 2026-01-31 修复：恢复后标记资源需要重新索引（与 note_repo 保持一致）
    pub fn restore_mindmap(db: &VfsDatabase, mindmap_id: &str) -> VfsResult<VfsMindMap> {
        let conn = db.get_conn_safe()?;
        let mindmap = Self::restore_mindmap_with_conn(&conn, mindmap_id)?;

        // 标记资源需要重新索引
        if let Err(e) = VfsIndexStateRepo::mark_pending(db, &mindmap.resource_id) {
            warn!(
                "[VfsMindMapRepo] Failed to mark mindmap for re-indexing after restore: {}",
                e
            );
        }

        Ok(mindmap)
    }

    /// 恢复软删除的知识导图（使用现有连接）
    ///
    /// ★ P0 修复：使用事务保护，防止部分恢复导致数据不一致
    pub fn restore_mindmap_with_conn(conn: &Connection, mindmap_id: &str) -> VfsResult<VfsMindMap> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<()> {
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();

            let affected = conn.execute(
                "UPDATE mindmaps SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NOT NULL",
                params![now, mindmap_id],
            )?;

            if affected == 0 {
                return Err(VfsError::NotFound {
                    resource_type: "MindMap (deleted)".to_string(),
                    id: mindmap_id.to_string(),
                });
            }

            // 同时恢复 folder_items 记录
            // ★ P0 修复：folder_items.updated_at 是 INTEGER 列，必须用 i64 毫秒时间戳
            let now_ms = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE item_id = ?2 AND item_type = 'mindmap'",
                params![now_ms, mindmap_id],
            )?;

            Ok(())
        })();

        match result {
            Ok(_) => {
                if let Err(commit_err) = conn.execute("COMMIT", []) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(commit_err.into());
                }
                info!("[VFS::MindMapRepo] Restored mindmap: {}", mindmap_id);
                Self::get_mindmap_with_conn(conn, mindmap_id)?.ok_or_else(|| VfsError::NotFound {
                    resource_type: "MindMap".to_string(),
                    id: mindmap_id.to_string(),
                })
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// 永久删除知识导图
    pub fn purge_mindmap(db: &VfsDatabase, mindmap_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_mindmap_with_conn(&conn, mindmap_id)
    }

    /// 永久删除知识导图（使用现有连接）
    ///
    /// ★ P0 修复：使用事务保护，防止多步操作部分失败导致数据不一致
    /// ★ 2026-06-10 修复（审阅问题 A2 关联）：改 BEGIN IMMEDIATE 为 SAVEPOINT，
    /// 支持在外层事务（如文件夹树 purge）内嵌套调用。
    pub fn purge_mindmap_with_conn(conn: &Connection, mindmap_id: &str) -> VfsResult<()> {
        conn.execute_batch("SAVEPOINT vfs_mindmap_purge_tx")?;

        let result = Self::purge_mindmap_inner(conn, mindmap_id);

        match result {
            Ok(_) => {
                if let Err(release_err) =
                    conn.execute_batch("RELEASE SAVEPOINT vfs_mindmap_purge_tx")
                {
                    let _ = conn.execute_batch(
                        "ROLLBACK TO SAVEPOINT vfs_mindmap_purge_tx; RELEASE SAVEPOINT vfs_mindmap_purge_tx;",
                    );
                    return Err(release_err.into());
                }
                info!("[VFS::MindMapRepo] Purged mindmap: {}", mindmap_id);
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT vfs_mindmap_purge_tx; RELEASE SAVEPOINT vfs_mindmap_purge_tx;",
                );
                Err(e)
            }
        }
    }

    /// 永久删除知识导图的内部逻辑（不含事务管理，供批量操作复用）
    ///
    /// ★ 2026-02-12 修复：在 CASCADE 删除 mindmap_versions 行之前，
    /// 先收集版本关联的 resource_id，删除后逐个递减引用计数并清理孤儿资源。
    fn purge_mindmap_inner(conn: &Connection, mindmap_id: &str) -> VfsResult<()> {
        // 1. 获取主 resource_id
        let resource_id: Option<String> = conn
            .query_row(
                "SELECT resource_id FROM mindmaps WHERE id = ?1",
                params![mindmap_id],
                |row| row.get(0),
            )
            .optional()?;

        // 2. 收集所有版本关联的 resource_id（必须在 CASCADE 删除前完成）
        let version_resource_ids: Vec<String> = {
            let mut stmt =
                conn.prepare("SELECT resource_id FROM mindmap_versions WHERE mindmap_id = ?1")?;
            let rows = stmt.query_map(params![mindmap_id], |row| row.get(0))?;
            rows.filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    warn!(
                        "[VFS::MindMapRepo] Failed to read version resource_id during purge: {}",
                        e
                    );
                    None
                }
            })
            .collect()
        };

        // 3. 显式删除 mindmap_versions 行（不依赖 CASCADE，确保可控）
        conn.execute(
            "DELETE FROM mindmap_versions WHERE mindmap_id = ?1",
            params![mindmap_id],
        )?;

        // 4. 删除知识导图记录
        conn.execute("DELETE FROM mindmaps WHERE id = ?1", params![mindmap_id])?;

        // 5. 删除 folder_items 记录
        conn.execute(
            "DELETE FROM folder_items WHERE item_id = ?1 AND item_type = 'mindmap'",
            params![mindmap_id],
        )?;

        // 6. 减少主资源引用计数
        // ★ 2026-06-12 修复（审阅问题 S5）：decrement 后若无任何导图/版本引用，
        // 删除资源行与关联索引单元。旧实现只递减计数，资源行永久泄漏。
        if let Some(rid) = resource_id {
            VfsResourceRepo::decrement_ref_with_conn(conn, &rid)?;

            let mindmap_refs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1",
                    params![&rid],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let version_refs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mindmap_versions WHERE resource_id = ?1",
                    params![&rid],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            if mindmap_refs == 0 && version_refs == 0 {
                // ★ 2026-06-12（第二轮审阅）：统一入口清理索引产物（含 Lance 向量入列）
                super::index_unit_repo::purge_index_artifacts_by_resource(conn, &rid)?;
                conn.execute("DELETE FROM resources WHERE id = ?1", params![&rid])?;
                debug!("[VFS::MindMapRepo] Purged main resource: {}", rid);
            }
        }

        // 7. 清理版本资源：递减引用计数，孤儿资源直接删除
        for version_rid in &version_resource_ids {
            let new_count = VfsResourceRepo::decrement_ref_with_conn(conn, version_rid)?;

            if new_count <= 0 {
                // 检查是否还有其他版本或导图引用此资源
                let mindmap_refs: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1",
                        params![version_rid],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                let version_refs: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM mindmap_versions WHERE resource_id = ?1",
                        params![version_rid],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);

                if mindmap_refs == 0 && version_refs == 0 {
                    // ★ 2026-06-12（第二轮审阅）：统一入口清理索引产物（含 Lance 向量入列）
                    super::index_unit_repo::purge_index_artifacts_by_resource(conn, version_rid)?;
                    conn.execute("DELETE FROM resources WHERE id = ?1", params![version_rid])?;
                    debug!(
                        "[VFS::MindMapRepo] Purged orphan version resource: {}",
                        version_rid
                    );
                }
            }
        }

        Ok(())
    }

    // ========================================================================
    // 收藏功能
    // ========================================================================

    /// 设置收藏状态
    pub fn set_favorite(db: &VfsDatabase, mindmap_id: &str, is_favorite: bool) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_favorite_with_conn(&conn, mindmap_id, is_favorite)
    }

    /// 设置收藏状态（使用现有连接）
    ///
    /// ★ 2026-07 修复（D7）：收藏只写 is_favorite，不再 bump updated_at。
    /// updated_at 参与编辑端乐观锁（expected_updated_at），收藏这类元数据操作
    /// 若改动 updated_at 会让正在编辑的客户端产生无意义的 OCC 冲突。
    pub fn set_favorite_with_conn(
        conn: &Connection,
        mindmap_id: &str,
        is_favorite: bool,
    ) -> VfsResult<()> {
        let favorite_val = if is_favorite { 1 } else { 0 };

        let affected = conn.execute(
            "UPDATE mindmaps SET is_favorite = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![favorite_val, mindmap_id],
        )?;

        if affected == 0 {
            return Err(VfsError::NotFound {
                resource_type: "MindMap".to_string(),
                id: mindmap_id.to_string(),
            });
        }

        debug!(
            "[VFS::MindMapRepo] Set favorite for mindmap {}: {}",
            mindmap_id, is_favorite
        );

        Ok(())
    }

    // ========================================================================
    // 回收站功能
    // ========================================================================

    /// 列出已删除的知识导图
    pub fn list_deleted_mindmaps(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsMindMap>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_mindmaps_with_conn(&conn, limit, offset)
    }

    /// 列出已删除的知识导图（使用现有连接）
    pub fn list_deleted_mindmaps_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsMindMap>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, description, is_favorite, default_view, theme, settings, created_at, updated_at, deleted_at, COALESCE(content_updated_at, updated_at)
            FROM mindmaps
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], |row| {
            let id: String = row.get(0)?;
            let settings_str: Option<String> = row.get(7)?;
            let settings = parse_settings_json(&id, settings_str);

            Ok(VfsMindMap {
                id,
                resource_id: row.get::<_, Option<String>>(1)?.unwrap_or_default(),
                title: row.get(2)?,
                description: row.get(3)?,
                is_favorite: row.get::<_, i32>(4)? != 0,
                default_view: row
                    .get::<_, Option<String>>(5)?
                    .unwrap_or_else(|| "mindmap".to_string()),
                theme: row.get(6)?,
                settings,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
                content_updated_at: row.get(11)?,
                deleted_at: row.get(10)?,
            })
        })?;

        // 单行解析失败不影响整个回收站列表（错误会记录 warn 日志）
        let mindmaps: Vec<VfsMindMap> = rows.filter_map(log_and_skip_err).collect();

        debug!(
            "[VFS::MindMapRepo] Listed {} deleted mindmaps",
            mindmaps.len()
        );

        Ok(mindmaps)
    }

    /// 永久删除所有已删除的知识导图
    pub fn purge_deleted_mindmaps(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::purge_deleted_mindmaps_with_conn(&conn)
    }

    /// 永久删除所有已删除的知识导图（使用现有连接）
    ///
    /// ★ 2026-02 修复：使用单个事务包裹批量操作，避免嵌套事务错误
    pub fn purge_deleted_mindmaps_with_conn(conn: &Connection) -> VfsResult<usize> {
        // 获取所有已删除的知识导图 ID
        let mut stmt = conn.prepare("SELECT id FROM mindmaps WHERE deleted_at IS NOT NULL")?;

        let ids: Vec<String> = stmt
            .query_map([], |row| row.get(0))?
            .collect::<Result<Vec<_>, _>>()?;

        let count = ids.len();
        if count == 0 {
            return Ok(0);
        }

        // 使用单个事务包裹所有删除操作
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<()> {
            for id in &ids {
                Self::purge_mindmap_inner(conn, id)?;
            }
            Ok(())
        })();

        match result {
            Ok(_) => {
                if let Err(commit_err) = conn.execute("COMMIT", []) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(commit_err.into());
                }
                info!("[VFS::MindMapRepo] Purged {} deleted mindmaps", count);
                Ok(count)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 版本管理
    // ========================================================================

    /// 自动保存版本合并窗口（分钟）：窗口内同来源的连续编辑不再新建快照
    const AUTOSAVE_MERGE_WINDOW_MINUTES: i64 = 30;

    /// 创建版本快照记录
    ///
    /// 将旧内容保存为一个新的 resource，并在 mindmap_versions 表中记录关联。
    /// 这样旧版本内容不会被原地更新覆盖。
    ///
    /// ## 版本降噪：自动保存合并窗口（★ 2026-07）
    /// 编辑器自动保存约 1.5s debounce 一次，逐次快照会导致版本表暴涨。
    /// 对 manual/auto 来源（含 NULL，视为 manual）采用滚动合并窗口：
    /// - 同 mindmap 最近一条版本来源相同、且距今 < 30 分钟时，跳过新建，
    ///   直接返回该已有版本（版本粒度 = 编辑会话，类似主流笔记应用）；
    /// - 窗口外、来源变化（如 chat → manual）、或带显式 label 的快照始终新建；
    /// - chat% 来源被聊天引用（mv_*）永久指向，永远逐条新建、不合并不清理。
    pub fn create_version_with_conn(
        conn: &Connection,
        mindmap_id: &str,
        old_content: &str,
        title: &str,
        label: Option<&str>,
        source: Option<&str>,
    ) -> VfsResult<VfsMindMapVersion> {
        let is_chat_source = source.map(|s| s.starts_with("chat")).unwrap_or(false);
        // 合并窗口仅适用于编辑器保存类来源（manual/auto/NULL）；
        // pre_chat_backup / restore_backup 等备份快照必须逐条落盘，不可被合并吞掉。
        let is_mergeable_source = matches!(source, None | Some("manual") | Some("auto"));

        // 合并窗口检查：chat 来源、备份来源与显式 label 快照不参与合并
        if is_mergeable_source && label.is_none() {
            if let Some(latest) = Self::latest_version_in_merge_window(conn, mindmap_id, source)? {
                debug!(
                    "[VFS::MindMapRepo] Autosave merged into version {} for mindmap {} (within {}min window)",
                    latest.version_id,
                    mindmap_id,
                    Self::AUTOSAVE_MERGE_WINDOW_MINUTES
                );
                return Ok(latest);
            }
        }

        let version_id = VfsMindMapVersion::generate_id();
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        // 为旧内容创建独立的 resource 记录（基于 hash 去重）
        let snapshot_resource = VfsResourceRepo::create_or_reuse_with_conn(
            conn,
            VfsResourceType::MindMap,
            old_content,
            Some(&version_id),
            Some("mindmap_versions"),
            None,
        )?;

        conn.execute(
            r#"
            INSERT INTO mindmap_versions (version_id, mindmap_id, resource_id, title, label, source, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                version_id,
                mindmap_id,
                snapshot_resource.resource_id,
                title,
                label,
                source,
                now
            ],
        )?;

        // ★ 版本保留策略：仅保留最近 N 个非 chat 来源版本
        // （manual/NULL/auto/pre_chat_backup/restore_backup）；
        // chat_* 来源的版本被聊天消息中的 mv_* 引用永久指向，不参与清理。
        // ★ 2026-07 修复：清理版本行的同时回收其独占的快照 resource
        // （快照 resource 按 hash 去重可能被其它版本/导图共享，仅无引用时删除）。
        const MAX_AUTOSAVE_VERSIONS: usize = 20;
        if !is_chat_source {
            if let Err(e) = Self::prune_autosave_versions(conn, mindmap_id, MAX_AUTOSAVE_VERSIONS) {
                warn!(
                    "[VFS::MindMapRepo] Failed to prune autosave versions for {}: {}",
                    mindmap_id, e
                );
            }
        }

        debug!(
            "[VFS::MindMapRepo] Created version {} for mindmap {}",
            version_id, mindmap_id
        );

        Ok(VfsMindMapVersion {
            version_id,
            mindmap_id: mindmap_id.to_string(),
            resource_id: snapshot_resource.resource_id,
            title: title.to_string(),
            label: label.map(|s| s.to_string()),
            source: source.map(|s| s.to_string()),
            created_at: now,
        })
    }

    /// 查找可合并的最近版本：同 mindmap 最近一条版本来源相同（NULL 视为 manual）、
    /// 无显式 label、且创建时间在合并窗口内时返回该版本，否则返回 None。
    ///
    /// 注意：比较对象是"最近一条版本"（任意来源），若最近一条是 chat% 来源
    /// 则视为来源变化，正常新建快照，保证 chat 编辑前后的用户手动状态可回溯。
    fn latest_version_in_merge_window(
        conn: &Connection,
        mindmap_id: &str,
        source: Option<&str>,
    ) -> VfsResult<Option<VfsMindMapVersion>> {
        let latest = conn
            .query_row(
                r#"
                SELECT version_id, mindmap_id, resource_id, title, label, source, created_at
                FROM mindmap_versions
                WHERE mindmap_id = ?1
                ORDER BY created_at DESC, version_id DESC
                LIMIT 1
                "#,
                params![mindmap_id],
                |row| {
                    Ok(VfsMindMapVersion {
                        version_id: row.get(0)?,
                        mindmap_id: row.get(1)?,
                        resource_id: row.get(2)?,
                        title: row.get(3)?,
                        label: row.get(4)?,
                        source: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
            )
            .optional()?;

        let Some(latest) = latest else {
            return Ok(None);
        };

        // 带显式 label 的版本是用户检查点，不作为合并目标
        if latest.label.is_some() {
            return Ok(None);
        }

        // 来源必须一致（NULL 视为 manual）
        let normalize = |s: Option<&str>| s.unwrap_or("manual").to_string();
        if normalize(latest.source.as_deref()) != normalize(source) {
            return Ok(None);
        }

        // 时间必须在合并窗口内；created_at 解析失败时保守新建快照
        let Ok(created_at) = chrono::DateTime::parse_from_rfc3339(&latest.created_at) else {
            warn!(
                "[VFS::MindMapRepo] Unparseable created_at for version {} (mindmap {}): {:?}",
                latest.version_id, mindmap_id, latest.created_at
            );
            return Ok(None);
        };
        let age = chrono::Utc::now().signed_duration_since(created_at.with_timezone(&chrono::Utc));
        if age >= chrono::Duration::minutes(Self::AUTOSAVE_MERGE_WINDOW_MINUTES) || age < chrono::Duration::zero() {
            return Ok(None);
        }

        Ok(Some(latest))
    }

    /// 清理超出保留数量的自动保存版本行，并回收其独占的快照 resource。
    ///
    /// ★ 2026-07 修复：旧实现只删 mindmap_versions 行，快照 resource 永久泄漏。
    /// 现在先收集待删版本的 resource_id，删除版本行后逐个递减引用计数，
    /// 仅当该 resource 不再被任何导图（含软删除）或版本引用时才删除资源行
    /// 与索引产物（兼容 CoW/hash 去重导致的跨记录共享）。
    fn prune_autosave_versions(
        conn: &Connection,
        mindmap_id: &str,
        keep_count: usize,
    ) -> VfsResult<()> {
        // 1. 收集待删版本及其 resource_id
        let pruned: Vec<(String, String)> = {
            let mut stmt = conn.prepare(
                r#"
                SELECT version_id, resource_id FROM mindmap_versions
                WHERE mindmap_id = ?1
                  AND (source IS NULL OR source NOT LIKE 'chat%')
                  AND version_id NOT IN (
                    SELECT version_id FROM mindmap_versions
                    WHERE mindmap_id = ?1 AND (source IS NULL OR source NOT LIKE 'chat%')
                    ORDER BY created_at DESC, version_id DESC
                    LIMIT ?2
                  )
                "#,
            )?;
            let rows = stmt.query_map(params![mindmap_id, keep_count as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            rows.filter_map(log_and_skip_err).collect()
        };

        if pruned.is_empty() {
            return Ok(());
        }

        // 2. 删除版本行
        for (version_id, _) in &pruned {
            conn.execute(
                "DELETE FROM mindmap_versions WHERE version_id = ?1",
                params![version_id],
            )?;
        }

        // 3. 回收孤儿快照 resource（去重后逐个检查引用）
        let mut resource_ids: Vec<String> = pruned.into_iter().map(|(_, rid)| rid).collect();
        resource_ids.sort();
        resource_ids.dedup();

        for rid in &resource_ids {
            VfsResourceRepo::decrement_ref_with_conn(conn, rid)?;

            // 与 purge_mindmap_inner 一致：以实际引用计数为准（ref_count 不完全可靠）
            let mindmap_refs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mindmaps WHERE resource_id = ?1",
                    params![rid],
                    |row| row.get(0),
                )
                .unwrap_or(0);
            let version_refs: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM mindmap_versions WHERE resource_id = ?1",
                    params![rid],
                    |row| row.get(0),
                )
                .unwrap_or(0);

            if mindmap_refs == 0 && version_refs == 0 {
                super::index_unit_repo::purge_index_artifacts_by_resource(conn, rid)?;
                conn.execute("DELETE FROM resources WHERE id = ?1", params![rid])?;
                debug!(
                    "[VFS::MindMapRepo] Pruned orphan version resource: {}",
                    rid
                );
            }
        }

        Ok(())
    }

    /// 创建版本快照记录（便捷方法，自动获取连接）
    ///
    /// ★ 2026-02-13 新增：供 executor 在创建/更新后为当前内容生成不可变版本引用
    pub fn create_version(
        db: &VfsDatabase,
        mindmap_id: &str,
        content: &str,
        title: &str,
        label: Option<&str>,
        source: Option<&str>,
    ) -> VfsResult<VfsMindMapVersion> {
        let conn = db.get_conn_safe()?;
        Self::create_version_with_conn(&conn, mindmap_id, content, title, label, source)
    }

    /// 获取思维导图的版本历史（默认最近 100 条，兼容旧调用方）
    pub fn get_versions(db: &VfsDatabase, mindmap_id: &str) -> VfsResult<Vec<VfsMindMapVersion>> {
        Self::get_versions_paged(db, mindmap_id, Self::DEFAULT_VERSION_PAGE_SIZE)
    }

    /// 获取思维导图的版本历史（使用现有连接，默认最近 100 条）
    pub fn get_versions_with_conn(
        conn: &Connection,
        mindmap_id: &str,
    ) -> VfsResult<Vec<VfsMindMapVersion>> {
        Self::get_versions_paged_with_conn(conn, mindmap_id, Self::DEFAULT_VERSION_PAGE_SIZE)
    }

    /// 版本列表默认页大小
    pub const DEFAULT_VERSION_PAGE_SIZE: u32 = 100;

    /// 获取思维导图的版本历史（可指定条数上限）
    pub fn get_versions_paged(
        db: &VfsDatabase,
        mindmap_id: &str,
        limit: u32,
    ) -> VfsResult<Vec<VfsMindMapVersion>> {
        let conn = db.get_conn_safe()?;
        Self::get_versions_paged_with_conn(&conn, mindmap_id, limit)
    }

    /// 获取思维导图的版本历史（使用现有连接，可指定条数上限）
    ///
    /// 按时间倒序排列；limit 为 0 时按默认页大小处理。
    pub fn get_versions_paged_with_conn(
        conn: &Connection,
        mindmap_id: &str,
        limit: u32,
    ) -> VfsResult<Vec<VfsMindMapVersion>> {
        let effective_limit = if limit == 0 {
            Self::DEFAULT_VERSION_PAGE_SIZE
        } else {
            limit
        };
        let mut stmt = conn.prepare(
            r#"
            SELECT version_id, mindmap_id, resource_id, title, label, source, created_at
            FROM mindmap_versions
            WHERE mindmap_id = ?1
            ORDER BY created_at DESC, version_id DESC
            LIMIT ?2
            "#,
        )?;

        let rows = stmt.query_map(params![mindmap_id, effective_limit], |row| {
            Ok(VfsMindMapVersion {
                version_id: row.get(0)?,
                mindmap_id: row.get(1)?,
                resource_id: row.get(2)?,
                title: row.get(3)?,
                label: row.get(4)?,
                source: row.get(5)?,
                created_at: row.get(6)?,
            })
        })?;

        let versions: Vec<VfsMindMapVersion> = rows.filter_map(log_and_skip_err).collect();

        Ok(versions)
    }

    /// 获取指定版本的内容
    pub fn get_version_content(db: &VfsDatabase, version_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_version_content_with_conn(&conn, version_id)
    }

    /// 获取指定版本元数据
    pub fn get_version(db: &VfsDatabase, version_id: &str) -> VfsResult<Option<VfsMindMapVersion>> {
        let conn = db.get_conn_safe()?;
        Self::get_version_with_conn(&conn, version_id)
    }

    /// 获取指定版本元数据（使用现有连接）
    pub fn get_version_with_conn(
        conn: &Connection,
        version_id: &str,
    ) -> VfsResult<Option<VfsMindMapVersion>> {
        let version = conn
            .query_row(
                r#"
                SELECT version_id, mindmap_id, resource_id, title, label, source, created_at
                FROM mindmap_versions
                WHERE version_id = ?1
                "#,
                params![version_id],
                |row| {
                    Ok(VfsMindMapVersion {
                        version_id: row.get(0)?,
                        mindmap_id: row.get(1)?,
                        resource_id: row.get(2)?,
                        title: row.get(3)?,
                        label: row.get(4)?,
                        source: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
            )
            .optional()?;

        Ok(version)
    }

    /// 获取指定版本的内容（使用现有连接）
    pub fn get_version_content_with_conn(
        conn: &Connection,
        version_id: &str,
    ) -> VfsResult<Option<String>> {
        let result: Option<String> = conn
            .query_row(
                r#"
                SELECT r.data
                FROM mindmap_versions v
                JOIN resources r ON v.resource_id = r.id
                WHERE v.version_id = ?1
                "#,
                params![version_id],
                |row| row.get(0),
            )
            .optional()?;

        Ok(result)
    }

    /// 恢复思维导图到指定历史版本
    ///
    /// ★ 2026-07 新增（B6）：单事务内完成——
    /// 1. 将当前内容快照为 `restore_backup` 版本（fail-closed：备份失败则中止恢复）
    /// 2. 用目标版本内容覆盖主 resource（走与 update 相同的 COW 判定）
    /// 3. 推进 updated_at 与 content_updated_at
    /// 4. 返回恢复后的 VfsMindMap
    ///
    /// 恢复的内容本身不再额外建版本——目标版本行即其不可变引用。
    /// 目标内容与当前内容相同（hash 相等）时为幂等 no-op，直接返回当前元数据。
    pub fn restore_version(db: &VfsDatabase, version_id: &str) -> VfsResult<VfsMindMap> {
        let conn = db.get_conn_safe()?;
        let mindmap = Self::restore_version_with_conn(&conn, version_id)?;

        // 内容已变化，标记资源等待重新索引（与 restore_mindmap 行为一致）
        if let Err(e) = VfsIndexStateRepo::mark_pending(db, &mindmap.resource_id) {
            warn!(
                "[VfsMindMapRepo] Failed to mark mindmap for re-indexing after version restore: {}",
                e
            );
        }

        Ok(mindmap)
    }

    /// 恢复思维导图到指定历史版本（使用现有连接）
    pub fn restore_version_with_conn(
        conn: &Connection,
        version_id: &str,
    ) -> VfsResult<VfsMindMap> {
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsMindMap> {
            // 1. 目标版本及其内容
            let version = Self::get_version_with_conn(conn, version_id)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "MindMapVersion".to_string(),
                    id: version_id.to_string(),
                }
            })?;
            let target_content =
                Self::get_version_content_with_conn(conn, version_id)?.ok_or_else(|| {
                    VfsError::NotFound {
                        resource_type: "MindMapVersionContent".to_string(),
                        id: version_id.to_string(),
                    }
                })?;

            // 2. 当前导图（软删除导图不可恢复版本，需先从回收站还原）
            let current = Self::get_mindmap_with_conn(conn, &version.mindmap_id)?.ok_or_else(
                || VfsError::NotFound {
                    resource_type: "MindMap".to_string(),
                    id: version.mindmap_id.clone(),
                },
            )?;

            let current_resource =
                VfsResourceRepo::get_resource_with_conn(conn, &current.resource_id)?.ok_or_else(
                    || VfsError::NotFound {
                        resource_type: "Resource".to_string(),
                        id: current.resource_id.clone(),
                    },
                )?;

            // 3. 目标内容与当前内容一致 → 幂等 no-op
            let normalized_content = Self::normalize_mindmap_content(&target_content)?;
            let new_hash = VfsResourceRepo::compute_hash(&normalized_content);
            if new_hash == current_resource.hash {
                info!(
                    "[VFS::MindMapRepo] restore_version {} is a no-op for mindmap {} (content identical)",
                    version_id, version.mindmap_id
                );
                return Ok(current);
            }

            // 4. 快照当前内容为 restore_backup（fail-closed：无备份不恢复）
            if let Some(current_data) = &current_resource.data {
                Self::create_version_with_conn(
                    conn,
                    &version.mindmap_id,
                    current_data,
                    &current.title,
                    None,
                    Some("restore_backup"),
                )?;
            }

            // 5. 覆盖主 resource（与 update 相同的 COW 判定）
            let mut final_resource_id = current.resource_id.clone();
            let shared_count =
                Self::count_active_mindmaps_by_resource_id_with_conn(conn, &current.resource_id)?;
            if shared_count > 1 {
                let resource_result = VfsResourceRepo::create_or_reuse_with_conn(
                    conn,
                    VfsResourceType::MindMap,
                    &normalized_content,
                    Some(&version.mindmap_id),
                    Some("mindmaps"),
                    None,
                )?;
                final_resource_id = resource_result.resource_id;
            } else {
                VfsResourceRepo::update_resource_data_with_conn(
                    conn,
                    &current.resource_id,
                    &normalized_content,
                )?;
            }

            // 6. 推进时间戳（内容实际变化，双时间戳一起推进）
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            conn.execute(
                r#"
                UPDATE mindmaps
                SET resource_id = ?1, updated_at = ?2, content_updated_at = ?2
                WHERE id = ?3
                "#,
                params![final_resource_id, now, version.mindmap_id],
            )?;

            info!(
                "[VFS::MindMapRepo] Restored mindmap {} to version {} (resource: {})",
                version.mindmap_id, version_id, final_resource_id
            );

            Ok(VfsMindMap {
                resource_id: final_resource_id,
                updated_at: now.clone(),
                content_updated_at: now,
                ..current
            })
        })();

        match result {
            Ok(mindmap) => {
                if let Err(commit_err) = conn.execute("COMMIT", []) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(commit_err.into());
                }
                Ok(mindmap)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }
}
