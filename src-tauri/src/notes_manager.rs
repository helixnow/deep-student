use chrono::Utc;
use regex::Regex;
use rusqlite::{params, OptionalExtension, Transaction};
use std::collections::HashSet;
use std::path::Path;
use std::sync::Arc;

use crate::database::Database;
use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::note_repo::VfsNoteRepo;
use crate::vfs::types::{VfsCreateNoteParams, VfsNote, VfsUpdateNoteParams};
use log::warn;

/// 从笔记内容中提取纯文本（支持 ProseMirror JSON 和 Markdown）
fn extract_clean_text_from_note_content(content: &str) -> String {
    // 尝试解析为 ProseMirror JSON；失败则按原样返回（Markdown/纯文本）
    if let Ok(json) = serde_json::from_str::<serde_json::Value>(content) {
        let mut blocks: Vec<String> = Vec::new();
        if let Some(arr) = json.get("content").and_then(|v| v.as_array()) {
            for block in arr {
                let t = block.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if t == "paragraph" || t == "heading" || t == "blockquote" || t == "listItem" {
                    if let Some(children) = block.get("content").and_then(|v| v.as_array()) {
                        let text = children
                            .iter()
                            .filter_map(|n| n.get("text").and_then(|v| v.as_str()))
                            .collect::<Vec<_>>()
                            .join("");
                        let text = text.trim();
                        if !text.is_empty() {
                            blocks.push(text.to_string());
                        }
                    }
                }
            }
        }
        if !blocks.is_empty() {
            return blocks.join("\n");
        }
    }
    // 返回原始内容（已去除首尾空白）
    content.trim().to_string()
}

#[cfg(feature = "lance")]
use crate::lance_vector_store::default_lance_root_from_db_path;
#[cfg(feature = "lance")]
use crate::lance_vector_store::ensure_mobile_tmpdir_within;
#[cfg(feature = "lance")]
use arrow_array::Array;
#[cfg(feature = "lance")]
use arrow_array::{ArrayRef, Float32Array, RecordBatch, RecordBatchIterator, StringArray};
#[cfg(feature = "lance")]
use arrow_schema::{DataType, Field, Schema};
#[cfg(feature = "lance")]
use lancedb::index::scalar::FtsIndexBuilder;
#[cfg(feature = "lance")]
use lancedb::index::scalar::FullTextSearchQuery;
#[cfg(feature = "lance")]
use lancedb::query::{ExecutableQuery, QueryBase};
#[cfg(feature = "lance")]
use lancedb::{index::Index, Table};
#[cfg(feature = "lance")]
use std::fs;
#[cfg(feature = "lance")]
use std::path::PathBuf;
#[cfg(feature = "lance")]
use tauri::async_runtime;

type Result<T> = std::result::Result<T, AppError>;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct NoteItem {
    pub id: String,
    pub title: String,
    pub content_md: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
    pub is_favorite: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NoteOutgoingLink {
    pub target: String,
    pub target_note_id: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NoteBacklinkHit {
    pub id: String,
    pub title: String,
    pub snippet: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct NoteLinksResult {
    pub outgoing: Vec<NoteOutgoingLink>,
    pub external: Vec<String>,
    pub backlinks: Vec<NoteBacklinkHit>,
    pub outgoing_truncated: bool,
    pub external_truncated: bool,
    pub backlinks_truncated: bool,
}


// 新增：将 ListOptions 移到模块级并公开
#[derive(Debug, Clone)]
pub struct ListOptions {
    pub tags: Option<Vec<String>>, // AND 关系
    pub date_start: Option<String>,
    pub date_end: Option<String>,
    pub has_assets: Option<bool>,
    pub sort_by: Option<String>,  // updated_at|created_at|title
    pub sort_dir: Option<String>, // asc|desc
    pub page: i64,
    pub page_size: i64,
    pub keyword: Option<String>, // 按标题 LIKE
    pub include_deleted: bool,
    pub only_deleted: bool,
}

pub struct NotesManager {
    db: Arc<Database>,
    /// VFS 数据库（可选），用于 VFS 适配层方法
    vfs_db: Option<Arc<VfsDatabase>>,
}

impl NotesManager {
    pub fn new(db: Arc<Database>) -> Result<Self> {
        let mgr = Self { db, vfs_db: None };
        #[cfg(feature = "lance")]
        {
            mgr.ensure_notes_lance_migrated()?;
        }
        Ok(mgr)
    }

    /// 创建带 VFS 数据库的 NotesManager
    pub fn new_with_vfs(db: Arc<Database>, vfs_db: Arc<VfsDatabase>) -> Result<Self> {
        let mgr = Self {
            db,
            vfs_db: Some(vfs_db),
        };
        #[cfg(feature = "lance")]
        {
            mgr.ensure_notes_lance_migrated()?;
        }
        Ok(mgr)
    }

    /// 设置 VFS 数据库
    pub fn set_vfs_db(&mut self, vfs_db: Arc<VfsDatabase>) {
        self.vfs_db = Some(vfs_db);
    }

    /// 获取 VFS 数据库引用
    pub fn get_vfs_db(&self) -> Option<&Arc<VfsDatabase>> {
        self.vfs_db.as_ref()
    }

    /// 检查是否启用了 VFS
    pub fn has_vfs(&self) -> bool {
        self.vfs_db.is_some()
    }

    #[cfg(feature = "lance")]
    fn lance_notes_dir(&self) -> Result<PathBuf> {
        let root = default_lance_root_from_db_path(self.db.db_path())?;
        let notes_dir = root.join("notes");
        fs::create_dir_all(&notes_dir).map_err(|e| {
            AppError::file_system(format!(
                "创建 Lance Notes 索引目录失败: {} (路径: {})",
                e,
                notes_dir.to_string_lossy()
            ))
        })?;
        Ok(notes_dir)
    }

    #[cfg(feature = "lance")]
    fn lance_notes_table(&self) -> Result<Table> {
        let base = self.lance_notes_dir()?;
        // 移动端：强制将 TMP 定位在 Lance Notes 目录所在的沙盒内，避免跨挂载点 rename 失败
        let _ = ensure_mobile_tmpdir_within(&base);
        // 额外的可写性检测：尝试在目录内创建/删除一个临时文件，提前捕获权限/占用问题
        #[cfg(feature = "lance")]
        {
            use std::io::Write as _;
            let probe_path = base.join(".write_probe");
            match std::fs::File::create(&probe_path)
                .and_then(|mut f| f.write_all(b"ok"))
                .and_then(|_| std::fs::remove_file(&probe_path))
            {
                Ok(_) => {}
                Err(e) => {
                    return Err(AppError::file_system(format!(
                        "Lance Notes 目录不可写: {} (路径: {})",
                        e,
                        base.to_string_lossy()
                    )));
                }
            }
        }
        let path = base.to_string_lossy().to_string();
        async_runtime::block_on(async move {
            let db = lancedb::connect(&path)
                .execute()
                .await
                .map_err(|e| AppError::database(format!("连接 Lance Notes 索引失败: {}", e)))?;
            let tbl = match db.open_table("notes_search").execute().await {
                Ok(tbl) => tbl,
                Err(_) => {
                    let schema = Schema::new(vec![
                        Field::new("note_id", DataType::Utf8, false),
                        Field::new("title", DataType::Utf8, false),
                        Field::new("content", DataType::Utf8, false),
                        Field::new("updated_at", DataType::Utf8, false),
                    ]);
                    let empty: Vec<std::result::Result<RecordBatch, arrow_schema::ArrowError>> =
                        Vec::new();
                    let iter =
                        RecordBatchIterator::new(empty.into_iter(), Arc::new(schema.clone()));
                    db.create_table("notes_search", iter)
                        .execute()
                        .await
                        .map_err(|e| {
                            // 对错误信息进行路径脱敏，避免泄露编译机源路径
                            AppError::database(format!(
                                "创建 Lance Notes 索引表失败: {}",
                                Self::sanitize_backend_error(&e.to_string())
                            ))
                        })?
                }
            };
            if let Err(err) = tbl
                .create_index(&["content"], Index::FTS(FtsIndexBuilder::default()))
                .replace(false)
                .execute()
                .await
            {
                let msg = Self::sanitize_backend_error(&err.to_string());
                if !msg.contains("already exists") {
                    println!("⚠️ [NotesIndex] FTS ensure failed on notes_search: {}", msg);
                }
            }
            Ok(tbl)
        })
    }

    #[cfg(feature = "lance")]
    fn sanitize_backend_error(raw: &str) -> String {
        // Redact absolute paths to crates source and user home
        let mut out = raw.to_string();
        out = out
            .replace("/Users/", "/Users/[redacted]/")
            .replace("C\\\\Users\\\\", "C\\\\Users\\\\[redacted]\\\\");
        let re = regex::Regex::new(r"/?[A-Za-z]:?[^\s]*?index\.crates\.io[^\s]*").ok();
        if let Some(r) = re {
            out = r.replace_all(&out, "[crates-src]").to_string();
        }
        out
    }

    #[cfg(feature = "lance")]
    fn migrate_all_notes_to_lance(&self) -> Result<()> {
        let vfs_db = match self.vfs_db.as_ref() {
            Some(db) => db,
            None => return Ok(()),
        };

        let batch_size = 50;
        let mut offset: u32 = 0;
        loop {
            let notes = VfsNoteRepo::list_notes(vfs_db, None, batch_size, offset)
                .map_err(|e| AppError::database(format!("VFS list_notes failed: {}", e)))?;

            if notes.is_empty() {
                break;
            }

            for note in notes {
                let content = VfsNoteRepo::get_note_content(vfs_db, &note.id).map_err(|e| {
                    AppError::database(format!("VFS get_note_content failed: {}", e))
                })?;
                let item = Self::vfs_note_to_note_item(note, content.unwrap_or_default());
                self.sync_note_to_lance(&item)?;
            }
            offset = offset.saturating_add(batch_size);
        }
        Ok(())
    }

    #[cfg(feature = "lance")]
    fn ensure_notes_lance_migrated(&self) -> Result<()> {
        if let Ok(Some(flag)) = self.db.get_setting("notes.lance.migrated") {
            if flag == "1" {
                return Ok(());
            }
        }
        self.migrate_all_notes_to_lance()?;
        self.db
            .save_setting("notes.lance.migrated", "1")
            .map_err(|e| {
                AppError::database(format!(
                    "Failed to save Lance Notes migration status: {}",
                    e
                ))
            })?;
        Ok(())
    }

    #[cfg(feature = "lance")]
    fn sync_note_to_lance(&self, note: &NoteItem) -> Result<()> {
        let table = self.lance_notes_table()?;
        let note_clone = note.clone();
        async_runtime::block_on(async move {
            // Batch delete (even for single item, use IN syntax for consistency)
            let expr = format!("note_id IN ('{}')", note_clone.id.replace("'", "''"));
            let _ = table.delete(expr.as_str()).await;

            let schema = table.schema().await.map_err(|e| {
                AppError::database(format!("Failed to get Lance Notes schema: {}", e))
            })?;
            let clean_body = extract_clean_text_from_note_content(&note_clone.content_md);
            let content = if clean_body.trim().is_empty() {
                note_clone.title.clone()
            } else {
                format!("{}\n{}", note_clone.title, clean_body)
            };
            let arrays: Vec<ArrayRef> = vec![
                Arc::new(StringArray::from(vec![note_clone.id])) as ArrayRef,
                Arc::new(StringArray::from(vec![note_clone.title])) as ArrayRef,
                Arc::new(StringArray::from(vec![content])) as ArrayRef,
                Arc::new(StringArray::from(vec![note_clone.updated_at])) as ArrayRef,
            ];
            let batch = RecordBatch::try_new(schema.clone(), arrays).map_err(|e| {
                AppError::database(format!("Failed to assemble Lance Notes record: {}", e))
            })?;
            let iter = RecordBatchIterator::new(vec![Ok(batch)].into_iter(), schema);
            table.add(iter).execute().await.map_err(|e| {
                AppError::database(format!("Failed to write to Lance Notes index: {}", e))
            })?;
            Ok(())
        })
    }

    #[cfg(feature = "lance")]
    fn remove_note_from_lance(&self, note_id: &str) -> Result<()> {
        let table = self.lance_notes_table()?;
        let id = note_id.to_string();
        async_runtime::block_on(async move {
            let expr = format!("note_id = '{}'", id.replace("'", "''"));
            let _ = table.delete(expr.as_str()).await;
            Ok(())
        })
    }

    fn normalize_link_target(input: &str) -> String {
        input.trim().to_lowercase()
    }

    fn extract_note_links(content: &str) -> (Vec<String>, Vec<String>) {
        let mut internal: HashSet<String> = HashSet::new();
        let mut external: HashSet<String> = HashSet::new();

        let wiki = Regex::new(r"\[\[([^\]]+)\]\]").unwrap();
        for cap in wiki.captures_iter(content) {
            if let Some(m) = cap.get(1) {
                let t = m.as_str().trim();
                if !t.is_empty() {
                    internal.insert(t.to_string());
                }
            }
        }

        let markdown_links = Regex::new(r"\[[^\]]*\]\(([^)]+)\)").unwrap();
        for cap in markdown_links.captures_iter(content) {
            if let Some(m) = cap.get(1) {
                let url = m.as_str().trim();
                if url.is_empty() {
                    continue;
                }
                if url.to_lowercase().starts_with("notes://") {
                    let target = url.replacen("notes://", "", 1).trim().to_string();
                    if !target.is_empty() {
                        internal.insert(target);
                    }
                } else if url.to_lowercase().starts_with("http://")
                    || url.to_lowercase().starts_with("https://")
                {
                    external.insert(url.to_string());
                }
            }
        }

        let notes_scheme = Regex::new(r"notes://([^\s\]\)]+)").unwrap();
        for cap in notes_scheme.captures_iter(content) {
            if let Some(m) = cap.get(1) {
                let t = m.as_str().trim();
                if !t.is_empty() {
                    internal.insert(t.to_string());
                }
            }
        }

        // 允许 http/https 链接，排除空白、尖括号、方括号、右括号、引号等
        let plain_http = Regex::new(r##"https?://[^\s<>\]\)"']+"##).unwrap();
        for cap in plain_http.captures_iter(content) {
            if let Some(m) = cap.get(0) {
                external.insert(m.as_str().to_string());
            }
        }

        let mut internal_vec: Vec<String> = internal.into_iter().collect();
        internal_vec.sort();
        let mut external_vec: Vec<String> = external.into_iter().collect();
        external_vec.sort();
        (internal_vec, external_vec)
    }

    fn resolve_note_id_by_title_tx(tx: &Transaction<'_>, title: &str) -> Result<Option<String>> {
        let mut stmt = tx
            .prepare(
                "SELECT id FROM notes
                 WHERE deleted_at IS NULL AND lower(trim(title)) = lower(trim(?1))
                 ORDER BY datetime(updated_at) DESC
                 LIMIT 1",
            )
            .map_err(|e| AppError::database(format!("准备解析笔记链接失败: {}", e)))?;
        let row = stmt
            .query_row(params![title], |row| row.get::<_, String>(0))
            .optional()
            .map_err(|e| AppError::database(format!("解析笔记链接失败: {}", e)))?;
        Ok(row)
    }

    fn resolve_note_id_by_scheme(&self, tx: &Transaction<'_>, raw: &str) -> Result<Option<String>> {
        let trimmed = raw.trim();
        if trimmed.len() == 36 && trimmed.contains('-') {
            let mut stmt = tx
                .prepare("SELECT id FROM notes WHERE id = ?1 AND deleted_at IS NULL LIMIT 1")
                .map_err(|e| AppError::database(format!("准备 note_id 解析失败: {}", e)))?;
            let row = stmt
                .query_row(params![trimmed], |row| row.get::<_, String>(0))
                .optional()
                .map_err(|e| AppError::database(format!("解析 note_id 失败: {}", e)))?;
            return Ok(row);
        }
        Ok(None)
    }

    fn rebuild_note_links_tx(
        &self,
        tx: &Transaction<'_>,
        note_id: &str,
        content_md: &str,
    ) -> Result<()> {
        tx.execute(
            "DELETE FROM note_links WHERE from_id = ?1",
            params![note_id],
        )
        .map_err(|e| AppError::database(format!("清理旧的笔记链接失败: {}", e)))?;

        let (internals, externals) = Self::extract_note_links(content_md);
        let now = Utc::now().to_rfc3339();

        for target in internals {
            let resolved = self.resolve_note_id_by_scheme(tx, &target)?.or_else(|| {
                Self::resolve_note_id_by_title_tx(tx, &target)
                    .ok()
                    .flatten()
            });
            tx.execute(
                "INSERT OR REPLACE INTO note_links (from_id, target, target_note_id, kind, created_at, updated_at)
                 VALUES (?1, ?2, ?3, 'internal', ?4, ?4)",
                params![note_id, target, resolved, now],
            )
            .map_err(|e| AppError::database(format!("写入笔记内部链接失败: {}", e)))?;
        }

        for url in externals {
            tx.execute(
                "INSERT OR REPLACE INTO note_links (from_id, target, target_note_id, kind, created_at, updated_at)
                 VALUES (?1, ?2, NULL, 'external', ?3, ?3)",
                params![note_id, url, now],
            )
            .map_err(|e| AppError::database(format!("写入笔记外链失败: {}", e)))?;
        }

        Ok(())
    }

    fn update_inbound_link_targets_tx(
        &self,
        tx: &Transaction<'_>,
        note_id: &str,
        titles: &[&str],
    ) -> Result<()> {
        let now = Utc::now().to_rfc3339();
        for t in titles {
            let trimmed = t.trim();
            if trimmed.is_empty() {
                continue;
            }
            if let Err(err) = tx.execute(
                "UPDATE note_links
                 SET target_note_id = ?1, updated_at = ?3
                 WHERE kind = 'internal' AND lower(trim(target)) = lower(trim(?2))",
                params![note_id, trimmed, now],
            ) {
                warn!("更新指向笔记的链接失败 ({}): {}", trimmed, err);
            }
        }
        Ok(())
    }

    fn build_simple_snippet(content: &str, needle: &str) -> Option<String> {
        let trimmed = content.trim();
        if trimmed.is_empty() {
            return None;
        }
        let lower = trimmed.to_lowercase();
        let target = needle.trim().to_lowercase();
        if target.is_empty() {
            return None;
        }
        if let Some(idx) = lower.find(&target) {
            let chars: Vec<char> = trimmed.chars().collect();
            let start = idx.saturating_sub(60);
            let end = ((idx + target.len() + 60).min(chars.len())).max(start);
            let mut snippet: String = chars[start..end].iter().collect();
            if start > 0 {
                snippet.insert(0, '…');
            }
            if end < chars.len() {
                snippet.push('…');
            }
            return Some(snippet);
        }
        None
    }

    pub fn get_note_links(&self, note_id: &str) -> Result<NoteLinksResult> {
        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        const LIMIT: i64 = 200;

        let title: Option<String> = conn
            .query_row(
                "SELECT title FROM notes WHERE id=?1 AND deleted_at IS NULL",
                params![note_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|e| AppError::database(format!("读取笔记标题失败: {}", e)))?;
        let note_title = title.ok_or_else(|| AppError::not_found("Note not found"))?;
        let normalized = Self::normalize_link_target(&note_title);

        let mut outgoing: Vec<NoteOutgoingLink> = Vec::new();
        let mut outgoing_truncated = false;
        {
            let mut stmt = conn
                .prepare(
                    "SELECT target, target_note_id FROM note_links
                     WHERE from_id = ?1 AND kind = 'internal'
                     ORDER BY target ASC
                     LIMIT ?2",
                )
                .map_err(|e| AppError::database(format!("查询出链失败: {}", e)))?;
            let rows = stmt
                .query_map(params![note_id, LIMIT + 1], |row| {
                    let target: String = row.get(0)?;
                    let target_note_id: Option<String> = row.get(1)?;
                    Ok(NoteOutgoingLink {
                        target,
                        target_note_id,
                    })
                })
                .map_err(|e| AppError::database(format!("读取出链失败: {}", e)))?;
            for (idx, r) in rows.enumerate() {
                if (idx as i64) >= LIMIT {
                    outgoing_truncated = true;
                    break;
                }
                outgoing.push(r.map_err(|e| AppError::database(e.to_string()))?);
            }
        }

        let mut external: Vec<String> = Vec::new();
        let mut external_truncated = false;
        {
            let mut stmt = conn
                .prepare(
                    "SELECT target FROM note_links
                     WHERE from_id = ?1 AND kind = 'external'
                     ORDER BY target ASC
                     LIMIT ?2",
                )
                .map_err(|e| AppError::database(format!("查询外链失败: {}", e)))?;
            let rows = stmt
                .query_map(params![note_id, LIMIT + 1], |row| row.get::<_, String>(0))
                .map_err(|e| AppError::database(format!("读取外链失败: {}", e)))?;
            for (idx, r) in rows.enumerate() {
                if (idx as i64) >= LIMIT {
                    external_truncated = true;
                    break;
                }
                external.push(r.map_err(|e| AppError::database(e.to_string()))?);
            }
        }

        let mut backlinks: Vec<NoteBacklinkHit> = Vec::new();
        let mut backlinks_truncated = false;
        {
            let mut stmt = conn
                .prepare(
                    "SELECT nl.from_id, n.title, n.content_md
                     FROM note_links nl
                     JOIN notes n ON nl.from_id = n.id
                     WHERE nl.kind = 'internal'
                       AND n.deleted_at IS NULL
                       AND (nl.target_note_id = ?1 OR (nl.target_note_id IS NULL AND lower(trim(nl.target)) = ?2))
                     ORDER BY datetime(n.updated_at) DESC
                     LIMIT ?3",
                )
                .map_err(|e| AppError::database(format!("查询反向链接失败: {}", e)))?;
            let rows = stmt
                .query_map(params![note_id, normalized.clone(), LIMIT + 1], |row| {
                    let id: String = row.get(0)?;
                    let title: String = row.get(1)?;
                    let content_md: String = row.get(2)?;
                    Ok((id, title, content_md))
                })
                .map_err(|e| AppError::database(format!("读取反向链接失败: {}", e)))?;
            for (idx, r) in rows.enumerate() {
                if (idx as i64) >= LIMIT {
                    backlinks_truncated = true;
                    break;
                }
                let (id, title, content_md) =
                    r.map_err(|e| AppError::database(format!("解析反向链接失败: {}", e)))?;
                let snippet = Self::build_simple_snippet(&content_md, &note_title)
                    .or_else(|| Self::build_simple_snippet(&content_md, &normalized));
                backlinks.push(NoteBacklinkHit { id, title, snippet });
            }
        }

        Ok(NoteLinksResult {
            outgoing,
            external,
            backlinks,
            outgoing_truncated,
            external_truncated,
            backlinks_truncated,
        })
    }

    #[cfg(feature = "lance")]
    fn tokenize_keyword(input: &str) -> Vec<String> {
        let mut tokens: Vec<String> = Vec::new();
        let mut current = String::new();
        for ch in input.chars() {
            if ch.is_alphanumeric() || (ch as u32) >= 0x80 {
                current.push(ch);
            } else if !current.is_empty() {
                tokens.push(current.clone());
                current.clear();
            }
        }
        if !current.is_empty() {
            tokens.push(current);
        }
        tokens.truncate(8);
        tokens
    }

    #[cfg(feature = "lance")]
    fn build_note_snippet(&self, text: &str, tokens: &[String]) -> Option<String> {
        let trimmed = text.trim();
        if trimmed.is_empty() {
            return None;
        }
        if tokens.is_empty() {
            return Some(Self::truncate_snippet(trimmed, 120));
        }
        let lower = trimmed.to_lowercase();
        let mut best_idx: Option<usize> = None;
        for token in tokens {
            let t = token.to_lowercase();
            if let Some(idx) = lower.find(&t) {
                best_idx = Some(match best_idx {
                    Some(current) if idx >= current => current,
                    _ => idx,
                });
                if idx == 0 {
                    break;
                }
            }
        }
        let idx = best_idx.unwrap_or(0);
        Some(Self::extract_window(trimmed, idx, 120))
    }

    #[cfg(feature = "lance")]
    fn truncate_snippet(text: &str, max_len: usize) -> String {
        if text.chars().count() <= max_len {
            return text.to_string();
        }
        let mut out = String::new();
        for (i, ch) in text.chars().enumerate() {
            if i >= max_len {
                out.push('…');
                break;
            }
            out.push(ch);
        }
        out
    }

    #[cfg(feature = "lance")]
    fn extract_window(text: &str, center: usize, width: usize) -> String {
        let chars: Vec<char> = text.chars().collect();
        let len = chars.len();
        let start = center.saturating_sub((width / 2).min(center));
        let end = ((start + width).min(len)).max(start);
        let mut snippet: String = chars[start..end].iter().collect();
        if start > 0 {
            snippet.insert(0, '…');
        }
        if end < len {
            snippet.push('…');
        }
        snippet
    }

    #[cfg(feature = "lance")]
    pub fn search_notes_lance(
        &self,
        keyword: &str,
        limit: usize,
    ) -> Result<Vec<(String, String, Option<String>)>> {
        let trimmed = keyword.trim();
        if trimmed.is_empty() {
            return Ok(vec![]);
        }
        let table = self.lance_notes_table()?;
        let limit = limit.max(1);
        let tokens = Self::tokenize_keyword(trimmed);
        let tokens_lower: Vec<String> = tokens.iter().map(|t| t.to_lowercase()).collect();

        let rows = async_runtime::block_on(async move {
            use futures_util::TryStreamExt;

            let builder = table.query();

            let fetch_limit = limit.saturating_mul(4);
            let mut stream = builder
                .full_text_search(FullTextSearchQuery::new(trimmed.to_owned()))
                .limit(fetch_limit)
                .execute()
                .await
                .map_err(|e| {
                    AppError::database(format!("Failed to execute Lance Notes search: {}", e))
                })?;

            let mut results: Vec<(String, String, String, f32)> = Vec::new();
            while let Some(batch) = stream.try_next().await.map_err(|e| {
                AppError::database(format!("Failed to read Lance Notes search results: {}", e))
            })? {
                let schema = batch.schema();
                let idx_id = schema
                    .index_of("note_id")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let idx_title = schema
                    .index_of("title")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let idx_content = schema
                    .index_of("content")
                    .map_err(|e| AppError::database(e.to_string()))?;
                let idx_score = schema.index_of(LANCE_FTS_SCORE_COL).ok();

                let id_arr = batch
                    .column(idx_id)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| AppError::database("note_id column type error".to_string()))?;
                let title_arr = batch
                    .column(idx_title)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| AppError::database("title column type error".to_string()))?;
                let content_arr = batch
                    .column(idx_content)
                    .as_any()
                    .downcast_ref::<StringArray>()
                    .ok_or_else(|| AppError::database("content column type error".to_string()))?;

                let mut score_vec: Option<Vec<f32>> = None;
                if let Some(idx) = idx_score {
                    if let Some(arr) = batch.column(idx).as_any().downcast_ref::<Float32Array>() {
                        score_vec = Some((0..arr.len()).map(|i| arr.value(i)).collect());
                    }
                }

                for i in 0..id_arr.len() {
                    let note_id = id_arr.value(i).to_string();
                    let title = title_arr.value(i).to_string();
                    let content = content_arr.value(i).to_string();
                    let score = score_vec.as_ref().map(|v| v[i]).unwrap_or(1.0);
                    results.push((note_id, title, content, score));
                }
            }

            results.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
            results.truncate(limit);
            Ok::<Vec<(String, String, String, f32)>, AppError>(results)
        })?;

        let mut out: Vec<(String, String, Option<String>)> = Vec::with_capacity(rows.len());
        for (id, title, content, _) in rows {
            let snippet = self.build_note_snippet(&content, &tokens_lower);
            out.push((id, title, snippet));
        }
        if out.is_empty() {
            return self.search_notes_sqlite(trimmed, limit, &tokens_lower);
        }
        Ok(out)
    }

    #[cfg(feature = "lance")]
    fn search_notes_sqlite(
        &self,
        keyword: &str,
        limit: usize,
        tokens_lower: &[String],
    ) -> Result<Vec<(String, String, Option<String>)>> {
        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("Failed to get db connection: {}", e)))?;
        let pattern = format!("%{}%", keyword);
        let mut stmt = conn
            .prepare(
                "SELECT id, title, content_md
                   FROM notes
                  WHERE deleted_at IS NULL
                    AND (title LIKE ?1 OR content_md LIKE ?2)
                  ORDER BY datetime(updated_at) DESC
                  LIMIT ?3",
            )
            .map_err(|e| {
                AppError::database(format!("Failed to prepare note LIKE search: {}", e))
            })?;
        let rows = stmt
            .query_map(params![pattern, pattern, limit as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|e| {
                AppError::database(format!("Failed to execute note LIKE search: {}", e))
            })?;
        let mut out = Vec::new();
        for row in rows {
            let (id, title, content) = row.map_err(|e| {
                AppError::database(format!("Failed to parse note LIKE result: {}", e))
            })?;
            let snippet = self.build_note_snippet(&content, tokens_lower);
            out.push((id, title, snippet));
        }
        Ok(out)
    }

    pub fn list_notes(&self) -> Result<Vec<NoteItem>> {
        if let Some(vfs_db) = self.vfs_db.as_ref() {
            let conn = vfs_db
                .get_conn_safe()
                .map_err(|e| AppError::database(format!("Failed to get VFS connection: {}", e)))?;
            let mut stmt = conn
                .prepare(
                    "SELECT n.id, n.title, COALESCE(r.data, ''), n.tags, n.created_at, n.updated_at, COALESCE(n.is_favorite, 0)
                     FROM notes n
                     LEFT JOIN resources r ON r.id = n.resource_id
                     WHERE n.deleted_at IS NULL
                     ORDER BY datetime(n.updated_at) DESC",
                )
                .map_err(|e| AppError::database(format!("Failed to prepare VFS query: {}", e)))?;
            let rows = stmt
                .query_map([], |row| {
                    let tags_json: String = row.get(3)?;
                    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                    Ok(NoteItem {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        content_md: row.get(2)?,
                        tags,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                        is_favorite: row.get::<_, i64>(6)? != 0,
                    })
                })
                .map_err(|e| AppError::database(format!("Failed to execute VFS query: {}", e)))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| AppError::database(e.to_string()))?);
            }
            return Ok(out);
        }

        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("Failed to get db connection: {}", e)))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, title, content_md, tags, created_at, updated_at, COALESCE(is_favorite, 0)
             FROM notes WHERE (deleted_at IS NULL) ORDER BY datetime(updated_at) DESC",
            )
            .map_err(|e| AppError::database(format!("Failed to prepare query: {}", e)))?;
        let rows = stmt
            .query_map([], |row| {
                let tags_json: String = row.get(3)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok(NoteItem {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content_md: row.get(2)?,
                    tags,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    is_favorite: row.get::<_, i64>(6)? != 0,
                })
            })
            .map_err(|e| AppError::database(format!("Failed to execute query: {}", e)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| AppError::database(e.to_string()))?);
        }
        Ok(out)
    }

    /// Lightweight list: no content_md
    pub fn list_notes_meta(&self) -> Result<Vec<NoteItem>> {
        if let Some(vfs_db) = self.vfs_db.as_ref() {
            let conn = vfs_db
                .get_conn_safe()
                .map_err(|e| AppError::database(format!("Failed to get VFS connection: {}", e)))?;
            let mut stmt = conn
                .prepare(
                    "SELECT n.id, n.title, n.tags, n.created_at, n.updated_at, COALESCE(n.is_favorite, 0)
                     FROM notes n
                     WHERE n.deleted_at IS NULL
                     ORDER BY datetime(n.updated_at) DESC",
                )
                .map_err(|e| AppError::database(format!("Failed to prepare VFS query: {}", e)))?;
            let rows = stmt
                .query_map([], |row| {
                    let tags_json: String = row.get(2)?;
                    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                    Ok(NoteItem {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        content_md: String::new(),
                        tags,
                        created_at: row.get(3)?,
                        updated_at: row.get(4)?,
                        is_favorite: row.get::<_, i64>(5)? != 0,
                    })
                })
                .map_err(|e| AppError::database(format!("Failed to execute VFS query: {}", e)))?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| AppError::database(e.to_string()))?);
            }
            return Ok(out);
        }

        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("Failed to get db connection: {}", e)))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, title, tags, created_at, updated_at, COALESCE(is_favorite, 0)
                 FROM notes WHERE (deleted_at IS NULL)
                 ORDER BY datetime(updated_at) DESC",
            )
            .map_err(|e| AppError::database(format!("Failed to prepare query: {}", e)))?;
        let rows = stmt
            .query_map([], |row| {
                let tags_json: String = row.get(2)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok(NoteItem {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content_md: String::new(),
                    tags,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    is_favorite: row.get::<_, i64>(5)? != 0,
                })
            })
            .map_err(|e| AppError::database(format!("Failed to execute query: {}", e)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| AppError::database(e.to_string()))?);
        }
        Ok(out)
    }

    /// Get single note (with content_md)
    pub fn get_note(&self, id: &str) -> Result<NoteItem> {
        if self.vfs_db.is_some() {
            return self.get_note_vfs(id);
        }

        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("Failed to get db connection: {}", e)))?;
        let mut stmt = conn
            .prepare(
                "SELECT id, title, content_md, tags, created_at, updated_at, COALESCE(is_favorite, 0)
                 FROM notes WHERE id=?1 AND (deleted_at IS NULL)",
            )
            .map_err(|e| AppError::database(format!("Failed to prepare query: {}", e)))?;
        let row = stmt
            .query_row(params![id], |row| {
                let tags_json: String = row.get(3)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok(NoteItem {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content_md: row.get(2)?,
                    tags,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    is_favorite: row.get::<_, i64>(6)? != 0,
                })
            })
            .optional()
            .map_err(|e| AppError::database(format!("Failed to execute query: {}", e)))?;
        row.ok_or_else(|| AppError::not_found("Note not found or deleted"))
    }

    pub fn list_notes_advanced(&self, opt: ListOptions) -> Result<(Vec<NoteItem>, i64)> {
        if let Some(vfs_db) = self.vfs_db.as_ref() {
            let conn = vfs_db
                .get_conn_safe()
                .map_err(|e| AppError::database(format!("Failed to get VFS connection: {}", e)))?;

            let mut where_clauses: Vec<String> = Vec::new();
            let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
            let mut param_idx = 1;

            let escape_like = |s: &str| -> String {
                s.replace('\\', r"\\")
                    .replace('%', r"\%")
                    .replace('_', r"\_")
            };

            match (opt.include_deleted, opt.only_deleted) {
                (_, true) => where_clauses.push("n.deleted_at IS NOT NULL".to_string()),
                (false, _) => where_clauses.push("n.deleted_at IS NULL".to_string()),
                (true, false) => {}
            }

            if let Some(keyword) = opt.keyword.as_deref() {
                let escaped = escape_like(keyword);
                where_clauses.push(format!(
                    "(n.title LIKE ?{} ESCAPE '\\' OR r.data LIKE ?{} ESCAPE '\\')",
                    param_idx,
                    param_idx + 1
                ));
                let pattern = format!("%{}%", escaped);
                params_vec.push(Box::new(pattern.clone()));
                params_vec.push(Box::new(pattern));
                param_idx += 2;
            }

            if let Some(tags) = opt.tags.as_ref() {
                for tag in tags.iter().filter(|t| !t.trim().is_empty()) {
                    let escaped = escape_like(tag.trim());
                    where_clauses.push(format!("n.tags LIKE ?{} ESCAPE '\\'", param_idx));
                    params_vec.push(Box::new(format!("%\"{}\"%", escaped)));
                    param_idx += 1;
                }
            }

            if let Some(date_start) = opt.date_start.as_deref() {
                where_clauses.push(format!(
                    "datetime(n.updated_at) >= datetime(?{})",
                    param_idx
                ));
                params_vec.push(Box::new(date_start.to_string()));
                param_idx += 1;
            }
            if let Some(date_end) = opt.date_end.as_deref() {
                where_clauses.push(format!(
                    "datetime(n.updated_at) <= datetime(?{})",
                    param_idx
                ));
                params_vec.push(Box::new(date_end.to_string()));
                param_idx += 1;
            }

            let where_sql = if where_clauses.is_empty() {
                String::new()
            } else {
                format!(" WHERE {}", where_clauses.join(" AND "))
            };

            let sort_col = match opt.sort_by.as_deref() {
                Some("created_at") => "n.created_at",
                Some("title") => "n.title",
                _ => "n.updated_at",
            };
            let sort_dir = match opt.sort_dir.as_deref() {
                Some("asc") => "ASC",
                _ => "DESC",
            };

            let page = opt.page.max(0);
            let page_size = opt.page_size.max(1);
            let limit = page_size as i64;
            let offset = (page * page_size) as i64;

            let count_sql = format!(
                "SELECT COUNT(*) FROM notes n LEFT JOIN resources r ON r.id = n.resource_id{}",
                where_sql
            );
            let mut count_stmt = conn.prepare(&count_sql).map_err(|e| {
                AppError::database(format!("Failed to prepare VFS count query: {}", e))
            })?;
            let count_params: Vec<&dyn rusqlite::ToSql> =
                params_vec.iter().map(|p| p.as_ref()).collect();
            let total: i64 = count_stmt
                .query_row(count_params.as_slice(), |row| row.get(0))
                .map_err(|e| {
                    AppError::database(format!("Failed to execute VFS count query: {}", e))
                })?;

            let sql = format!(
                "SELECT n.id, n.title, COALESCE(r.data, ''), n.tags, n.created_at, n.updated_at, COALESCE(n.is_favorite, 0)
                 FROM notes n
                 LEFT JOIN resources r ON r.id = n.resource_id
                 {} ORDER BY {} {} LIMIT ?{} OFFSET ?{}",
                where_sql,
                sort_col,
                sort_dir,
                param_idx,
                param_idx + 1
            );
            params_vec.push(Box::new(limit));
            params_vec.push(Box::new(offset));

            let mut stmt = conn.prepare(&sql).map_err(|e| {
                AppError::database(format!("Failed to prepare VFS list query: {}", e))
            })?;
            let params_refs: Vec<&dyn rusqlite::ToSql> =
                params_vec.iter().map(|p| p.as_ref()).collect();
            let rows = stmt
                .query_map(params_refs.as_slice(), |row| {
                    let tags_json: String = row.get(3)?;
                    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                    Ok(NoteItem {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        content_md: row.get(2)?,
                        tags,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                        is_favorite: row.get::<_, i64>(6)? != 0,
                    })
                })
                .map_err(|e| {
                    AppError::database(format!("Failed to execute VFS list query: {}", e))
                })?;
            let mut out = Vec::new();
            for r in rows {
                out.push(r.map_err(|e| AppError::database(e.to_string()))?);
            }
            return Ok((out, total));
        }

        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("Failed to get db connection: {}", e)))?;

        // Build WHERE clause
        let mut where_clauses: Vec<String> = Vec::new();
        let mut filter_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut join_clauses: Vec<String> = Vec::new();
        let mut join_params: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        match (opt.include_deleted, opt.only_deleted) {
            (false, _) => where_clauses.push("(notes.deleted_at IS NULL)".to_string()),
            (true, true) => where_clauses.push("(notes.deleted_at IS NOT NULL)".to_string()),
            _ => {}
        }
        if let Some(ref kw) = opt.keyword {
            where_clauses.push("(notes.title LIKE ?)".to_string());
            filter_params.push(Box::new(format!("%{}%", kw)));
        }
        if let Some(ref start) = opt.date_start {
            where_clauses.push("datetime(notes.updated_at) >= datetime(?)".to_string());
            filter_params.push(Box::new(start.clone()));
        }
        if let Some(ref end) = opt.date_end {
            where_clauses.push("datetime(notes.updated_at) <= datetime(?)".to_string());
            filter_params.push(Box::new(end.clone()));
        }
        if opt.has_assets.unwrap_or(false) {
            where_clauses
                .push("EXISTS (SELECT 1 FROM assets a WHERE a.note_id = notes.id)".to_string());
        }
        // Tag AND filter
        if let Some(ref tags) = opt.tags {
            if !tags.is_empty() {
                let placeholders = (0..tags.len()).map(|_| "?").collect::<Vec<_>>().join(", ");
                let tag_join = format!(
                    "JOIN (\
                        SELECT note_id FROM note_tags\
                         WHERE tag IN ({})\
                         GROUP BY note_id\
                         HAVING COUNT(DISTINCT tag) = ?\
                    ) tag_filter ON tag_filter.note_id = notes.id",
                    placeholders
                );
                join_clauses.push(tag_join);
                for tag in tags {
                    join_params.push(Box::new(tag.clone()));
                }
                join_params.push(Box::new(tags.len() as i64));
            }
        }

        // Sort
        let sort_by = match opt.sort_by.as_deref() {
            Some("created_at") => "notes.created_at",
            Some("title") => "notes.title",
            _ => "notes.updated_at",
        };
        let sort_dir = match opt.sort_dir.as_deref() {
            Some("asc") => "ASC",
            _ => "DESC",
        };

        // Pagination
        let page = opt.page.max(0);
        let page_size = opt.page_size.clamp(1, 200);
        let offset = page * page_size;

        // SQL Assembly
        let where_sql = if where_clauses.is_empty() {
            String::new()
        } else {
            format!(" WHERE {}", where_clauses.join(" AND "))
        };
        let joins_sql = if join_clauses.is_empty() {
            String::new()
        } else {
            format!(" {}", join_clauses.join(" "))
        };
        let base_sql = format!(
            "SELECT notes.id, notes.title, notes.content_md, notes.tags, notes.created_at, notes.updated_at, COALESCE(notes.is_favorite, 0) \
             FROM notes{}{} \
             ORDER BY {sort_by} {sort_dir} \
             LIMIT ?, ?",
            joins_sql,
            where_sql,
            sort_by = sort_by,
            sort_dir = sort_dir
        );
        // Count SQL
        let count_sql = format!("SELECT COUNT(*) FROM notes{}{}", joins_sql, where_sql);

        // Execute Count
        let mut count_stmt = conn
            .prepare(&count_sql)
            .map_err(|e| AppError::database(format!("Failed to prepare count query: {}", e)))?;
        let mut params_count: Vec<&dyn rusqlite::ToSql> = Vec::new();
        for p in &join_params {
            params_count.push(&**p as &dyn rusqlite::ToSql);
        }
        for p in &filter_params {
            params_count.push(&**p as &dyn rusqlite::ToSql);
        }
        let total: i64 = count_stmt
            .query_row(&params_count[..], |row| row.get(0))
            .map_err(|e| AppError::database(format!("Failed to execute count: {}", e)))?;

        // Execute Query
        let mut stmt = conn
            .prepare(&base_sql)
            .map_err(|e| AppError::database(format!("Failed to prepare query: {}", e)))?;
        let mut params_all: Vec<&dyn rusqlite::ToSql> = Vec::new();
        for p in &join_params {
            params_all.push(&**p as &dyn rusqlite::ToSql);
        }
        for p in &filter_params {
            params_all.push(&**p as &dyn rusqlite::ToSql);
        }
        // OFFSET/LIMIT placeholders
        let offset_param = offset;
        let page_size_param = page_size;
        params_all.push(&offset_param);
        params_all.push(&page_size_param);
        let rows = stmt
            .query_map(&params_all[..], |row| {
                let tags_json: String = row.get(3)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok(NoteItem {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content_md: row.get(2)?,
                    tags,
                    created_at: row.get(4)?,
                    updated_at: row.get(5)?,
                    is_favorite: row.get::<_, i64>(6)? != 0,
                })
            })
            .map_err(|e| AppError::database(format!("Failed to execute query: {}", e)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| AppError::database(e.to_string()))?);
        }
        Ok((out, total))
    }

    pub fn create_note(&self, title: &str, content_md: &str, tags: &[String]) -> Result<NoteItem> {
        if self.vfs_db.is_some() {
            return self.create_note_vfs(title, content_md, tags);
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.create_note_with_id(&id, title, content_md, tags)
    }

    pub fn create_note_with_id(
        &self,
        id: &str,
        title: &str,
        content_md: &str,
        tags: &[String],
    ) -> Result<NoteItem> {
        if self.vfs_db.is_some() {
            return Err(AppError::validation(
                "VFS mode does not support create_note_with_id".to_string(),
            ));
        }
        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("Failed to get db connection: {}", e)))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::database(format!("Failed to start transaction: {}", e)))?;
        let now = Utc::now().to_rfc3339();
        let tags_json = serde_json::to_string(tags).unwrap_or("[]".to_string());
        tx.execute(
            "INSERT INTO notes (id, title, content_md, tags, created_at, updated_at, is_favorite)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
            params![id, title, content_md, tags_json, now, now],
        )
        .map_err(|e| AppError::database(format!("Failed to create note: {}", e)))?;
        self.sync_note_tags(&tx, id, tags)?;
        self.rebuild_note_links_tx(&tx, id, content_md)?;
        self.update_inbound_link_targets_tx(&tx, id, &[title])?;
        let note = NoteItem {
            id: id.to_string(),
            title: title.to_string(),
            content_md: content_md.to_string(),
            tags: tags.to_vec(),
            created_at: now.clone(),
            updated_at: now,
            is_favorite: false,
        };
        #[cfg(feature = "lance")]
        {
            self.sync_note_to_lance(&note)?;
        }
        tx.commit()
            .map_err(|e| AppError::database(format!("Failed to commit transaction: {}", e)))?;
        Ok(note)
    }

    pub fn update_note(
        &self,
        id: &str,
        title: Option<&str>,
        content_md: Option<&str>,
        tags: Option<&[String]>,
        expected_updated_at: Option<&str>,
    ) -> Result<NoteItem> {
        if self.vfs_db.is_some() {
            return self.update_note_vfs(id, title, content_md, tags, expected_updated_at);
        }

        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("Failed to get db connection: {}", e)))?;
        let tx = conn
            .unchecked_transaction()
            .map_err(|e| AppError::database(format!("Failed to start transaction: {}", e)))?;
        let mut existing = tx
            .prepare("SELECT id, title, content_md, tags, created_at, updated_at, COALESCE(is_favorite, 0) FROM notes WHERE id=?1 AND deleted_at IS NULL")
            .map_err(|e| AppError::database(format!("Failed to prepare query: {}", e)))?;
        let row = existing
            .query_row(params![id], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .optional()
            .map_err(|e| AppError::database(format!("Query failed: {}", e)))?;
        let (
            _id,
            old_title,
            old_content,
            old_tags_json,
            created_at,
            current_updated_at,
            is_favorite_raw,
        ) = row.ok_or_else(|| AppError::not_found("Note not found"))?;
        drop(existing);

        if let Some(expected) = expected_updated_at {
            let expected_trimmed = expected.trim();
            if !expected_trimmed.is_empty() && expected_trimmed != current_updated_at {
                return Err(AppError::conflict(
                    "notes.conflict:The note has been updated elsewhere, please refresh.",
                ));
            }
        }

        let new_title = title.unwrap_or(&old_title);
        let new_content = content_md.unwrap_or(&old_content);
        let new_tags_json = match tags {
            Some(ts) => serde_json::to_string(ts).unwrap_or(old_tags_json.clone()),
            None => old_tags_json.clone(),
        };

        let now = Utc::now().to_rfc3339();
        let updated_rows = tx
            .execute(
                "UPDATE notes SET title=?1, content_md=?2, tags=?3, updated_at=?4 WHERE id=?5 AND deleted_at IS NULL",
                params![new_title, new_content, new_tags_json, now, id],
            )
            .map_err(|e| AppError::database(format!("Failed to update note: {}", e)))?;
        if updated_rows == 0 {
            return Err(AppError::not_found("Note not found or deleted"));
        }
        let tags_vec: Vec<String> = serde_json::from_str(&new_tags_json).unwrap_or_default();
        self.sync_note_tags(&tx, id, &tags_vec)?;
        self.rebuild_note_links_tx(&tx, id, new_content)?;
        // 更新指向本笔记的未解析链接（旧标题、新标题都尝试绑定）
        self.update_inbound_link_targets_tx(&tx, id, &[&old_title, new_title])?;

        let updated_note = NoteItem {
            id: id.to_string(),
            title: new_title.to_string(),
            content_md: new_content.to_string(),
            tags: tags_vec,
            created_at: created_at,
            updated_at: now.clone(),
            is_favorite: is_favorite_raw != 0,
        };
        #[cfg(feature = "lance")]
        {
            self.sync_note_to_lance(&updated_note)?;
        }
        tx.commit()
            .map_err(|e| AppError::database(format!("Failed to commit transaction: {}", e)))?;
        drop(conn);
        Ok(updated_note)
    }

    pub fn set_favorite(&self, id: &str, favorite: bool) -> Result<NoteItem> {
        if self.vfs_db.is_some() {
            return self.set_favorite_vfs(id, favorite);
        }
        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("Failed to get db connection: {}", e)))?;
        let now = Utc::now().to_rfc3339();
        let changed = conn
            .execute(
                "UPDATE notes SET is_favorite=?1, updated_at=?2 WHERE id=?3 AND deleted_at IS NULL",
                params![if favorite { 1 } else { 0 }, now, id],
            )
            .map_err(|e| AppError::database(format!("Failed to update favorite status: {}", e)))?;
        if changed == 0 {
            return Err(AppError::not_found("Note not found or deleted"));
        }
        drop(conn);
        self.get_note(id)
    }


    pub fn delete_note(&self, id: &str) -> Result<bool> {
        if self.vfs_db.is_some() {
            return self.delete_note_vfs(id);
        }
        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("Failed to get db connection: {}", e)))?;
        // soft delete
        let now = Utc::now().to_rfc3339();
        let changed = conn
            .execute(
                "UPDATE notes SET deleted_at=?1 WHERE id=?2 AND (deleted_at IS NULL)",
                params![now, id],
            )
            .map_err(|e| AppError::database(format!("Failed to soft delete note: {}", e)))?;
        if changed > 0 {
            let _ = conn.execute(
                "DELETE FROM note_links WHERE from_id=?1 OR target_note_id=?1",
                params![id],
            );
            #[cfg(feature = "lance")]
            {
                self.remove_note_from_lance(id)?;
            }
        }
        Ok(changed > 0)
    }

    pub fn restore_note(&self, id: &str) -> Result<bool> {
        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("Failed to get db connection: {}", e)))?;
        let changed = conn
            .execute("UPDATE notes SET deleted_at=NULL WHERE id=?1", params![id])
            .map_err(|e| AppError::database(format!("Failed to restore note: {}", e)))?;
        if changed > 0 {
            let mut stmt = conn
                .prepare("SELECT id, title, content_md, tags, created_at, updated_at, COALESCE(is_favorite,0) FROM notes WHERE id=?1 AND deleted_at IS NULL")
                .map_err(|e| AppError::database(format!("Failed to read restored note: {}", e)))?;
            let restored: NoteItem = stmt
                .query_row(params![id], |row| {
                    let tags_json: String = row.get(3)?;
                    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                    Ok(NoteItem {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        content_md: row.get(2)?,
                        tags,
                        created_at: row.get(4)?,
                        updated_at: row.get(5)?,
                        is_favorite: row.get::<_, i64>(6)? != 0,
                    })
                })
                .map_err(|e| AppError::database(format!("Failed to parse restored note: {}", e)))?;
            if let Ok(tx) = conn.unchecked_transaction() {
                let _ = self.rebuild_note_links_tx(&tx, id, &restored.content_md);
                let _ = tx.commit();
            }
            #[cfg(feature = "lance")]
            {
                self.sync_note_to_lance(&restored)?;
            }
            return Ok(true);
        }
        Ok(false)
    }


    pub(crate) fn sync_note_tags(
        &self,
        conn: &rusqlite::Connection,
        note_id: &str,
        tags: &[String],
    ) -> Result<()> {
        // replace mapping for note_id
        conn.execute("DELETE FROM note_tags WHERE note_id=?1", params![note_id])
            .map_err(|e| AppError::database(format!("Failed to clean tag mapping: {}", e)))?;
        for t in tags {
            if t.trim().is_empty() {
                continue;
            }
            conn.execute(
                "INSERT OR IGNORE INTO note_tags(note_id, tag) VALUES (?1, ?2)",
                params![note_id, t.trim()],
            )
            .map_err(|e| AppError::database(format!("Failed to write tag mapping: {}", e)))?;
        }
        Ok(())
    }

}

// ==================== Canvas AI 工具方法 ====================
impl NotesManager {
    /// 从 Markdown 内容中提取指定章节
    /// 章节由标题行（#、##、###等）界定
    fn extract_section_content(content: &str, section_title: &str) -> Option<String> {
        let lines: Vec<&str> = content.lines().collect();
        let section_lower = section_title.trim().to_lowercase();

        // 查找章节标题
        let mut start_idx: Option<usize> = None;
        let mut section_level: Option<usize> = None;

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();
            if let Some(level) = Self::get_heading_level(trimmed) {
                let heading_text = trimmed.trim_start_matches('#').trim().to_lowercase();
                if heading_text == section_lower || trimmed.to_lowercase() == section_lower {
                    start_idx = Some(i);
                    section_level = Some(level);
                    break;
                }
            }
        }

        let start = start_idx?;
        let level = section_level?;

        // 查找章节结束（遇到同级或更高级标题）
        let mut end_idx = lines.len();
        for (i, line) in lines.iter().enumerate().skip(start + 1) {
            let trimmed = line.trim();
            if let Some(next_level) = Self::get_heading_level(trimmed) {
                if next_level <= level {
                    end_idx = i;
                    break;
                }
            }
        }

        // 提取章节内容（不包含标题行本身）
        let section_lines: Vec<&str> = lines[start + 1..end_idx].to_vec();
        Some(section_lines.join("\n").trim().to_string())
    }

    /// 获取 Markdown 标题级别（# = 1, ## = 2, etc.）
    fn get_heading_level(line: &str) -> Option<usize> {
        let trimmed = line.trim();
        if !trimmed.starts_with('#') {
            return None;
        }
        let level = trimmed.chars().take_while(|&c| c == '#').count();
        if level > 0 && level <= 6 {
            // 确保 # 后有空格或内容
            let rest = &trimmed[level..];
            if rest.is_empty() || rest.starts_with(' ') {
                return Some(level);
            }
        }
        None
    }

    /// 在指定章节末尾追加内容
    fn append_to_section(
        content: &str,
        section_title: &str,
        append_content: &str,
    ) -> Option<String> {
        let lines: Vec<&str> = content.lines().collect();
        let section_lower = section_title.trim().to_lowercase();

        // 查找章节标题
        let mut start_idx: Option<usize> = None;
        let mut section_level: Option<usize> = None;

        for (i, line) in lines.iter().enumerate() {
            let trimmed = line.trim();
            if let Some(level) = Self::get_heading_level(trimmed) {
                let heading_text = trimmed.trim_start_matches('#').trim().to_lowercase();
                if heading_text == section_lower || trimmed.to_lowercase() == section_lower {
                    start_idx = Some(i);
                    section_level = Some(level);
                    break;
                }
            }
        }

        let start = start_idx?;
        let level = section_level?;

        // 查找章节结束位置
        let mut end_idx = lines.len();
        for (i, line) in lines.iter().enumerate().skip(start + 1) {
            let trimmed = line.trim();
            if let Some(next_level) = Self::get_heading_level(trimmed) {
                if next_level <= level {
                    end_idx = i;
                    break;
                }
            }
        }

        // 在章节末尾插入内容
        let mut result_lines: Vec<String> =
            lines[..end_idx].iter().map(|s| s.to_string()).collect();
        result_lines.push(String::new()); // 空行
        result_lines.push(append_content.to_string());
        result_lines.extend(lines[end_idx..].iter().map(|s| s.to_string()));

        Some(result_lines.join("\n"))
    }

    /// Canvas AI 工具：读取笔记内容
    /// 支持读取完整内容或指定章节
    ///
    /// 使用 VFS 系统获取笔记
    pub fn canvas_read_content(&self, note_id: &str, section: Option<&str>) -> Result<String> {
        log::info!(
            "[Canvas::NotesManager] canvas_read_content: note_id={}, section={:?}",
            note_id,
            section
        );

        // 使用 VFS 系统获取笔记
        let note = self.get_note_vfs(note_id)?;

        match section {
            Some(sec) if !sec.trim().is_empty() => {
                Self::extract_section_content(&note.content_md, sec)
                    .ok_or_else(|| AppError::not_found(format!("章节 '{}' 未找到", sec)))
            }
            _ => Ok(note.content_md),
        }
    }

    /// Canvas AI 工具：追加内容到笔记
    /// 可指定追加到特定章节末尾，否则追加到文档末尾
    ///
    /// 使用 VFS 系统
    pub fn canvas_append_content(
        &self,
        note_id: &str,
        content: &str,
        section: Option<&str>,
    ) -> Result<()> {
        log::info!(
            "[Canvas::NotesManager] canvas_append_content: note_id={}, section={:?}, content_len={}",
            note_id,
            section,
            content.len()
        );

        // 使用 VFS 系统获取笔记
        let note = self.get_note_vfs(note_id)?;

        let new_content = match section {
            Some(sec) if !sec.trim().is_empty() => {
                Self::append_to_section(&note.content_md, sec, content)
                    .ok_or_else(|| AppError::not_found(format!("章节 '{}' 未找到", sec)))?
            }
            _ => {
                // 追加到文档末尾
                if note.content_md.trim().is_empty() {
                    content.to_string()
                } else {
                    format!("{}\n\n{}", note.content_md.trim_end(), content)
                }
            }
        };

        // 使用 VFS 版本的 update_note 保存
        self.update_note_vfs(note_id, None, Some(&new_content), None, None)?;

        Ok(())
    }

    /// Canvas AI 工具：替换笔记内容
    /// 支持普通字符串替换和正则表达式替换
    ///
    /// 使用 VFS 系统
    pub fn canvas_replace_content(
        &self,
        note_id: &str,
        search: &str,
        replace: &str,
        is_regex: bool,
    ) -> Result<u32> {
        log::info!(
            "[Canvas::NotesManager] canvas_replace_content: note_id={}, search_len={}, is_regex={}",
            note_id,
            search.len(),
            is_regex
        );

        // 使用 VFS 系统获取笔记
        let note = self.get_note_vfs(note_id)?;

        let (new_content, count) = if is_regex {
            // 正则替换
            let re = Regex::new(search)
                .map_err(|e| AppError::validation(format!("无效的正则表达式: {}", e)))?;
            let matches: Vec<_> = re.find_iter(&note.content_md).collect();
            let count = matches.len() as u32;
            let new_content = re.replace_all(&note.content_md, replace).to_string();
            (new_content, count)
        } else {
            // 普通字符串替换
            let count = note.content_md.matches(search).count() as u32;
            let new_content = note.content_md.replace(search, replace);
            (new_content, count)
        };

        if count > 0 {
            // 使用 VFS 版本的 update_note 保存
            self.update_note_vfs(note_id, None, Some(&new_content), None, None)?;
        }

        log::info!(
            "[Canvas::NotesManager] canvas_replace_content: replaced {} occurrences",
            count
        );

        Ok(count)
    }

    /// Canvas AI 工具：设置笔记完整内容
    /// 完全覆盖现有内容，谨慎使用
    ///
    /// 使用 VFS 系统
    pub fn canvas_set_content(&self, note_id: &str, content: &str) -> Result<()> {
        log::info!(
            "[Canvas::NotesManager] canvas_set_content: note_id={}, content_len={}",
            note_id,
            content.len()
        );

        // 确保笔记存在（使用 VFS 系统）
        let _ = self.get_note_vfs(note_id)?;

        // 使用 VFS 版本的 update_note 保存
        self.update_note_vfs(note_id, None, Some(content), None, None)?;

        Ok(())
    }
}

// ==================== VFS 适配层方法 ====================
impl NotesManager {
    /// VFS 版本：列出笔记
    ///
    /// 从 VFS 数据库读取笔记列表，返回与旧接口兼容的 NoteItem。
    /// 注意：VFS 版本不返回 content_md，需要单独调用 get_note_vfs 获取。
    pub fn list_notes_vfs(
        &self,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> Result<Vec<NoteItem>> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
        let notes = VfsNoteRepo::list_notes(vfs_db, search, limit, offset)
            .map_err(|e| AppError::database(format!("VFS list_notes failed: {}", e)))?;

        // 转换为 NoteItem（不含内容）
        let items: Vec<NoteItem> = notes
            .into_iter()
            .map(|n| Self::vfs_note_to_note_item(n, String::new()))
            .collect();

        Ok(items)
    }

    /// VFS 版本：创建笔记
    ///
    /// 在 VFS 数据库中创建笔记，内容存储在 resources 表。
    pub fn create_note_vfs(
        &self,
        title: &str,
        content_md: &str,
        tags: &[String],
    ) -> Result<NoteItem> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

        let params = VfsCreateNoteParams {
            title: title.to_string(),
            content: content_md.to_string(),
            tags: tags.to_vec(),
        };

        let vfs_note = VfsNoteRepo::create_note(vfs_db, params)
            .map_err(|e| AppError::database(format!("VFS create_note failed: {}", e)))?;

        log::info!("[NotesManager::VFS] Created note: {}", vfs_note.id);

        Ok(Self::vfs_note_to_note_item(
            vfs_note,
            content_md.to_string(),
        ))
    }

    /// VFS 版本：更新笔记
    ///
    /// 更新 VFS 数据库中的笔记，自动处理版本管理。
    pub fn update_note_vfs(
        &self,
        note_id: &str,
        title: Option<&str>,
        content_md: Option<&str>,
        tags: Option<&[String]>,
        expected_updated_at: Option<&str>,
    ) -> Result<NoteItem> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

        let params = VfsUpdateNoteParams {
            title: title.map(|s| s.to_string()),
            content: content_md.map(|s| s.to_string()),
            tags: tags.map(|t| t.to_vec()),
            expected_updated_at: expected_updated_at.map(|s| s.to_string()),
        };

        let vfs_note = VfsNoteRepo::update_note(vfs_db, note_id, params)
            .map_err(|e| AppError::database(format!("VFS update_note failed: {}", e)))?;

        // 获取更新后的内容
        let content = VfsNoteRepo::get_note_content(vfs_db, note_id)
            .map_err(|e| AppError::database(format!("VFS get_note_content failed: {}", e)))?
            .unwrap_or_default();

        log::info!("[NotesManager::VFS] Updated note: {}", note_id);

        Ok(Self::vfs_note_to_note_item(vfs_note, content))
    }

    pub fn get_note_vfs(&self, note_id: &str) -> Result<NoteItem> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

        let (vfs_note, content) = VfsNoteRepo::get_note_with_content(vfs_db, note_id)
            .map_err(|e| AppError::database(format!("VFS get_note_with_content failed: {}", e)))?
            .ok_or_else(|| AppError::not_found("Note not found in VFS"))?;

        Ok(Self::vfs_note_to_note_item(vfs_note, content))
    }

    /// VFS 版本：删除笔记（软删除）
    ///
    /// 在 VFS 数据库中软删除笔记。
    pub fn delete_note_vfs(&self, note_id: &str) -> Result<bool> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

        VfsNoteRepo::delete_note(vfs_db, note_id)
            .map_err(|e| AppError::database(format!("VFS delete_note failed: {}", e)))?;

        log::info!("[NotesManager::VFS] Deleted note: {}", note_id);

        Ok(true)
    }

    /// VFS 版本：恢复软删除的笔记
    pub fn restore_note_vfs(&self, note_id: &str) -> Result<bool> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

        VfsNoteRepo::restore_note(vfs_db, note_id)
            .map_err(|e| AppError::database(format!("VFS restore_note failed: {}", e)))?;

        log::info!("[NotesManager::VFS] Restored note: {}", note_id);

        Ok(true)
    }

    /// VFS 版本：设置收藏状态
    pub fn set_favorite_vfs(&self, note_id: &str, favorite: bool) -> Result<NoteItem> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

        VfsNoteRepo::set_favorite(vfs_db, note_id, favorite)
            .map_err(|e| AppError::database(format!("VFS set_favorite failed: {}", e)))?;

        // 返回更新后的笔记
        self.get_note_vfs(note_id)
    }

    /// 将 VfsNote 转换为 NoteItem
    fn vfs_note_to_note_item(vfs_note: VfsNote, content_md: String) -> NoteItem {
        NoteItem {
            id: vfs_note.id,
            title: vfs_note.title,
            content_md,
            tags: vfs_note.tags,
            created_at: vfs_note.created_at,
            updated_at: vfs_note.updated_at,
            is_favorite: vfs_note.is_favorite,
        }
    }
}

const LANCE_FTS_SCORE_COL: &str = "_score";

// ==================== Canvas AI 工具单元测试 ====================
#[cfg(test)]
mod canvas_tests {
    use super::*;

    #[test]
    fn test_get_heading_level() {
        // 一级标题
        assert_eq!(NotesManager::get_heading_level("# Title"), Some(1));
        assert_eq!(NotesManager::get_heading_level("  # Title  "), Some(1));

        // 二级标题
        assert_eq!(NotesManager::get_heading_level("## Section"), Some(2));

        // 三级标题
        assert_eq!(NotesManager::get_heading_level("### Subsection"), Some(3));

        // 六级标题（最大）
        assert_eq!(NotesManager::get_heading_level("###### Deep"), Some(6));

        // 非标题
        assert_eq!(NotesManager::get_heading_level("Normal text"), None);
        assert_eq!(NotesManager::get_heading_level("#NoSpace"), None);
        assert_eq!(NotesManager::get_heading_level("####### Too many"), None);
        assert_eq!(NotesManager::get_heading_level(""), None);
    }

    #[test]
    fn test_extract_section_content() {
        let content = r#"# Title
Introduction paragraph.

## Section 1
Content of section 1.
More content.

### Subsection 1.1
Nested content.

## Section 2
Content of section 2.

## End"#;

        // 提取 Section 1（应包含子章节内容）
        let section1 = NotesManager::extract_section_content(content, "## Section 1");
        assert!(section1.is_some());
        let s1 = section1.unwrap();
        assert!(s1.contains("Content of section 1"));
        assert!(s1.contains("Subsection 1.1"));
        assert!(s1.contains("Nested content"));
        // 不应包含 Section 2 的内容
        assert!(!s1.contains("Content of section 2"));

        // 提取 Section 2
        let section2 = NotesManager::extract_section_content(content, "## Section 2");
        assert!(section2.is_some());
        let s2 = section2.unwrap();
        assert!(s2.contains("Content of section 2"));
        // 不应包含 Section 1 的内容
        assert!(!s2.contains("Content of section 1"));

        // 提取子章节
        let subsection = NotesManager::extract_section_content(content, "### Subsection 1.1");
        assert!(subsection.is_some());
        let sub = subsection.unwrap();
        assert!(sub.contains("Nested content"));

        // 不存在的章节
        let not_found = NotesManager::extract_section_content(content, "## Not Found");
        assert!(not_found.is_none());

        // 忽略大小写
        let case_insensitive = NotesManager::extract_section_content(content, "## section 1");
        assert!(case_insensitive.is_some());
    }

    #[test]
    fn test_extract_section_content_without_hash() {
        let content = r#"# Title
Intro.

## Code
```js
const x = 1;
```

## End"#;

        // 使用不带 # 的章节名
        let section = NotesManager::extract_section_content(content, "Code");
        assert!(section.is_some());
        let s = section.unwrap();
        assert!(s.contains("const x = 1"));
    }

    #[test]
    fn test_append_to_section() {
        let content = r#"# Title

## Intro
Hello world.

## Code
```rust
fn main() {}
```

## End
Goodbye."#;

        // 追加到 Code 章节
        let result = NotesManager::append_to_section(content, "## Code", "// New line added");
        assert!(result.is_some());
        let new_content = result.unwrap();

        // 验证新内容在 Code 章节末尾、End 章节之前
        let code_pos = new_content.find("## Code").unwrap();
        let new_line_pos = new_content.find("// New line added").unwrap();
        let end_pos = new_content.find("## End").unwrap();

        assert!(code_pos < new_line_pos);
        assert!(new_line_pos < end_pos);

        // 原始内容应该保留
        assert!(new_content.contains("fn main() {}"));
        assert!(new_content.contains("Goodbye"));
    }

    #[test]
    fn test_append_to_last_section() {
        let content = r#"# Title

## Last Section
Some content."#;

        // 追加到最后一个章节
        let result = NotesManager::append_to_section(content, "## Last Section", "Appended text");
        assert!(result.is_some());
        let new_content = result.unwrap();

        assert!(new_content.contains("Some content"));
        assert!(new_content.contains("Appended text"));

        // 验证顺序
        let some_pos = new_content.find("Some content").unwrap();
        let appended_pos = new_content.find("Appended text").unwrap();
        assert!(some_pos < appended_pos);
    }

    #[test]
    fn test_regex_replace() {
        // 测试正则表达式匹配
        let content = "Log: error123 and error456 occurred";
        let re = Regex::new(r"error\d+").unwrap();
        let matches: Vec<_> = re.find_iter(content).collect();
        assert_eq!(matches.len(), 2);

        let replaced = re.replace_all(content, "ERROR").to_string();
        assert_eq!(replaced, "Log: ERROR and ERROR occurred");
    }

    #[test]
    fn test_string_replace() {
        // 测试普通字符串替换
        let content = "Hello World, Hello Universe";
        let count = content.matches("Hello").count();
        assert_eq!(count, 2);

        let replaced = content.replace("Hello", "Hi");
        assert_eq!(replaced, "Hi World, Hi Universe");
    }
}

