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

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};

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
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::resource_repo::VfsResourceRepo;
use crate::vfs::types::{
    VfsCreateMindMapParams, VfsFolderItem, VfsMindMap, VfsMindMapVersion, VfsResourceType,
    VfsUpdateMindMapParams,
};

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
        Self::normalize_mindmap_node(root, 0, &mut node_count)?;

        serde_json::to_string(&doc).map_err(|e| VfsError::Serialization(e.to_string()))
    }

    fn normalize_mindmap_node(
        node: &mut Value,
        depth: usize,
        node_count: &mut usize,
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

        // id
        let id_valid = obj
            .get("id")
            .and_then(|v| v.as_str())
            .map(|v| !v.trim().is_empty())
            .unwrap_or(false);
        if !id_valid {
            let new_id = if depth == 0 {
                "root".to_string()
            } else {
                nanoid::nanoid!(10)
            };
            obj.insert("id".to_string(), Value::String(new_id));
        }

        // text
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
                Self::normalize_mindmap_node(child, depth + 1, node_count)?;
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
    pub fn create_mindmap_with_conn(
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

        // 2. 创建知识导图记录
        conn.execute(
            r#"
            INSERT INTO mindmaps (id, resource_id, title, description, is_favorite, default_view, theme, settings, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, NULL, ?7, ?8)
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
            updated_at: now,
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
    ///
    /// ★ 2026-02 修复：添加事务保护，防止乐观锁检查与 UPDATE 之间的 TOCTOU 竞态
    pub fn update_mindmap_with_conn(
        conn: &Connection,
        mindmap_id: &str,
        params: VfsUpdateMindMapParams,
    ) -> VfsResult<VfsMindMap> {
        // 开始事务，保护 read-check-write 的原子性
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<VfsMindMap> {
            // 1. 获取当前知识导图
            let current = Self::get_mindmap_with_conn(conn, mindmap_id)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "MindMap".to_string(),
                    id: mindmap_id.to_string(),
                }
            })?;

            if let Some(expected_updated_at) = params.expected_updated_at.as_ref() {
                if current.updated_at != *expected_updated_at {
                    return Err(VfsError::InvalidOperation {
                        operation: "mindmap_update_conflict".to_string(),
                        reason: format!(
                            "MINDMAP_UPDATE_CONFLICT: expected_updated_at={}, actual_updated_at={}",
                            expected_updated_at, current.updated_at
                        ),
                    });
                }
            }

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
            let content_changed = if let Some(new_content) = &params.content {
                let normalized_content = Self::normalize_mindmap_content(new_content)?;
                let current_resource =
                    VfsResourceRepo::get_resource_with_conn(conn, &current.resource_id)?
                        .ok_or_else(|| VfsError::NotFound {
                            resource_type: "Resource".to_string(),
                            id: current.resource_id.clone(),
                        })?;
                let new_hash = VfsResourceRepo::compute_hash(&normalized_content);
                if new_hash == current_resource.hash {
                    false
                } else {
                    // ★ 2026-02-12：内容变化前，保存旧版本快照到 mindmap_versions
                    if let Some(old_data) = &current_resource.data {
                        if let Err(e) = Self::create_version_with_conn(
                            conn,
                            mindmap_id,
                            old_data,
                            &current.title,
                            None,
                            params.version_source.as_deref(),
                        ) {
                            warn!(
                                "[VFS::MindMapRepo] Failed to save version snapshot for mindmap {}: {}",
                                mindmap_id, e
                            );
                            // 版本保存失败不阻塞更新操作
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
                }
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

            conn.execute(
                r#"
                UPDATE mindmaps
                SET resource_id = ?1, title = ?2, description = ?3, default_view = ?4, theme = ?5, settings = ?6, updated_at = ?7
                WHERE id = ?8
                "#,
                params![
                    final_resource_id,
                    final_title,
                    final_description,
                    final_default_view,
                    final_theme,
                    settings_json,
                    now,
                    mindmap_id,
                ],
            )?;

            info!("[VFS::MindMapRepo] Updated mindmap: {}", mindmap_id);

            Ok(VfsMindMap {
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
                deleted_at: current.deleted_at,
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
                SELECT id, resource_id, title, description, is_favorite, default_view, theme, settings, created_at, updated_at, deleted_at
                FROM mindmaps
                WHERE id = ?1 AND deleted_at IS NULL
                "#,
                params![mindmap_id],
                |row| {
                    let settings_str: Option<String> = row.get(7)?;
                    let settings: Option<Value> = settings_str
                        .and_then(|s| serde_json::from_str(&s).ok());

                    Ok(VfsMindMap {
                        id: row.get(0)?,
                        resource_id: row.get(1)?,
                        title: row.get(2)?,
                        description: row.get(3)?,
                        is_favorite: row.get::<_, i32>(4)? != 0,
                        default_view: row.get(5)?,
                        theme: row.get(6)?,
                        settings,
                        created_at: row.get(8)?,
                        updated_at: row.get(9)?,
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
            SELECT m.id, m.resource_id, m.title, m.description, m.is_favorite, m.default_view, m.theme, m.settings, m.created_at, m.updated_at, m.deleted_at
            FROM mindmaps m
            INNER JOIN folder_items fi ON m.id = fi.item_id AND fi.item_type = 'mindmap'
            WHERE m.deleted_at IS NULL AND fi.deleted_at IS NULL AND fi.folder_id IS ?1
            ORDER BY m.updated_at DESC
            LIMIT ?2 OFFSET ?3
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![folder_id, limit, offset], |row| {
            let settings_str: Option<String> = row.get(7)?;
            let settings: Option<Value> = settings_str.and_then(|s| serde_json::from_str(&s).ok());

            Ok(VfsMindMap {
                id: row.get(0)?,
                resource_id: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                is_favorite: row.get::<_, i32>(4)? != 0,
                default_view: row.get(5)?,
                theme: row.get(6)?,
                settings,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
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
            SELECT id, resource_id, title, description, is_favorite, default_view, theme, settings, created_at, updated_at, deleted_at
            FROM mindmaps
            WHERE deleted_at IS NULL
            ORDER BY updated_at DESC
            "#,
        )?;

        let rows = stmt.query_map([], |row| {
            let settings_str: Option<String> = row.get(7)?;
            let settings: Option<Value> = settings_str.and_then(|s| serde_json::from_str(&s).ok());

            Ok(VfsMindMap {
                id: row.get(0)?,
                resource_id: row.get(1)?,
                title: row.get(2)?,
                description: row.get(3)?,
                is_favorite: row.get::<_, i32>(4)? != 0,
                default_view: row.get(5)?,
                theme: row.get(6)?,
                settings,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
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
    pub fn purge_mindmap_with_conn(conn: &Connection, mindmap_id: &str) -> VfsResult<()> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = Self::purge_mindmap_inner(conn, mindmap_id);

        match result {
            Ok(_) => {
                // 修复：COMMIT 失败时也需要回滚
                if let Err(commit_err) = conn.execute("COMMIT", []) {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(commit_err.into());
                }
                info!("[VFS::MindMapRepo] Purged mindmap: {}", mindmap_id);
                Ok(())
            }
            Err(e) => {
                // 回滚事务，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK", []);
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
        if let Some(rid) = resource_id {
            VfsResourceRepo::decrement_ref_with_conn(conn, &rid)?;
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
    pub fn set_favorite_with_conn(
        conn: &Connection,
        mindmap_id: &str,
        is_favorite: bool,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();
        let favorite_val = if is_favorite { 1 } else { 0 };

        let affected = conn.execute(
            "UPDATE mindmaps SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3 AND deleted_at IS NULL",
            params![favorite_val, now, mindmap_id],
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
            SELECT id, resource_id, title, description, is_favorite, default_view, theme, settings, created_at, updated_at, deleted_at
            FROM mindmaps
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], |row| {
            let settings_str: Option<String> = row.get(7)?;
            let settings = settings_str.and_then(|s| serde_json::from_str(&s).ok());

            Ok(VfsMindMap {
                id: row.get(0)?,
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
                deleted_at: row.get(10)?,
            })
        })?;

        let mindmaps: Vec<VfsMindMap> = rows.collect::<Result<Vec<_>, _>>()?;

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

    /// 创建版本快照记录
    ///
    /// 将旧内容保存为一个新的 resource，并在 mindmap_versions 表中记录关联。
    /// 这样旧版本内容不会被原地更新覆盖。
    pub fn create_version_with_conn(
        conn: &Connection,
        mindmap_id: &str,
        old_content: &str,
        title: &str,
        label: Option<&str>,
        source: Option<&str>,
    ) -> VfsResult<VfsMindMapVersion> {
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

    /// 获取思维导图的版本历史
    pub fn get_versions(db: &VfsDatabase, mindmap_id: &str) -> VfsResult<Vec<VfsMindMapVersion>> {
        let conn = db.get_conn_safe()?;
        Self::get_versions_with_conn(&conn, mindmap_id)
    }

    /// 获取思维导图的版本历史（使用现有连接）
    ///
    /// 默认返回最近 100 个版本，按时间倒序排列。
    pub fn get_versions_with_conn(
        conn: &Connection,
        mindmap_id: &str,
    ) -> VfsResult<Vec<VfsMindMapVersion>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT version_id, mindmap_id, resource_id, title, label, source, created_at
            FROM mindmap_versions
            WHERE mindmap_id = ?1
            ORDER BY created_at DESC
            LIMIT 100
            "#,
        )?;

        let rows = stmt.query_map(params![mindmap_id], |row| {
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
}
