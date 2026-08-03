use chrono::Utc;
use regex::Regex;
use rusqlite::{params, OptionalExtension, Transaction};
use std::collections::HashSet;
use std::sync::{Arc, LazyLock};

use crate::database::Database;
use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::note_repo::VfsNoteRepo;
use crate::vfs::types::{VfsCreateNoteParams, VfsNote, VfsUpdateNoteParams};
use log::warn;

// ==================== 笔记链接提取用静态正则 ====================
// 模式均为编译期字面量，编译失败属程序缺陷，expect 携带定位说明；
// LazyLock 避免每次 extract_note_links 调用重复编译正则。
static WIKI_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[\[([^\]]+)\]\]").expect("wiki 链接正则字面量非法"));
static MARKDOWN_LINK_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\[[^\]]*\]\(([^)]+)\)").expect("markdown 链接正则字面量非法"));
static NOTES_SCHEME_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"notes://([^\s\]\)]+)").expect("notes:// 正则字面量非法"));
// 允许 http/https 链接，排除空白、尖括号、方括号、右括号、引号等
static PLAIN_HTTP_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r##"https?://[^\s<>\]\)"']+"##).expect("http 链接正则字面量非法"));

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
    /// ⚠️ DEPRECATED（legacy 非 VFS 构造器）：不带 VFS 数据库时所有读写都会
    /// 落到主库旧 `notes` 表（生产已迁移 VFS，见 lib.rs 统一使用
    /// [`Self::new_with_vfs`]）。仅为旧调用方/测试保留，请勿在新代码中使用。
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
                .create_index(
                    &["content"],
                    Index::FTS(
                        FtsIndexBuilder::default()
                            .base_tokenizer("ngram".to_string())
                            .ngram_min_length(2)
                            .ngram_max_length(4)
                            .ngram_prefix_only(false)
                            .max_token_length(Some(64))
                            .lower_case(true)
                            .stem(false)
                            .remove_stop_words(false)
                            .ascii_folding(true),
                    ),
                )
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
        // ★ 2026-07-19（P3-1）：VFS 模式下 Lance `notes_search` 表已停写停读
        // （search_notes_lance 直接短路到 VFS FTS 检索），启动时把全部笔记
        // 灌入 Lance 纯属浪费，且 lance_notes_table 内部的
        // async_runtime::block_on 存在启动阻塞风险，直接跳过。
        if self.vfs_db.is_some() {
            return Ok(());
        }
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
        // ★ 2026-07-19（P3-1）：VFS 模式下 Lance notes_search 已废弃，
        // 门禁防止误用（内部含 block_on，误调用会阻塞调用线程）。
        if self.vfs_db.is_some() {
            return Ok(());
        }
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
        // ★ 2026-07-19（P3-1）：同 sync_note_to_lance，VFS 模式下直接短路。
        if self.vfs_db.is_some() {
            return Ok(());
        }
        let table = self.lance_notes_table()?;
        let id = note_id.to_string();
        async_runtime::block_on(async move {
            let expr = format!("note_id = '{}'", id.replace("'", "''"));
            let _ = table.delete(expr.as_str()).await;
            Ok(())
        })
    }

    fn extract_note_links(content: &str) -> (Vec<String>, Vec<String>) {
        let mut internal: HashSet<String> = HashSet::new();
        let mut external: HashSet<String> = HashSet::new();

        for cap in WIKI_LINK_RE.captures_iter(content) {
            if let Some(m) = cap.get(1) {
                let t = m.as_str().trim();
                if !t.is_empty() {
                    internal.insert(t.to_string());
                }
            }
        }

        for cap in MARKDOWN_LINK_RE.captures_iter(content) {
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

        for cap in NOTES_SCHEME_RE.captures_iter(content) {
            if let Some(m) = cap.get(1) {
                let t = m.as_str().trim();
                if !t.is_empty() {
                    internal.insert(t.to_string());
                }
            }
        }

        for cap in PLAIN_HTTP_RE.captures_iter(content) {
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

    /// ⚠️ legacy 非 VFS 死路径专用（查询主库旧 `notes` 表），仅被
    /// [`Self::rebuild_note_links_tx`] 调用。VFS 模式下不可达。
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

    /// ⚠️ DEPRECATED（legacy 非 VFS 死路径）：维护主库旧 `note_links` 表。
    /// VFS 模式（生产默认）不维护反向链接，此函数仅被同样已 VFS 门禁的
    /// legacy create/update/restore 路径调用。请勿在新代码中使用。
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

    /// ⚠️ legacy 非 VFS 死路径专用（维护主库旧 `note_links` 表）。
    /// VFS 模式下不可达；VFS 链接图由 L 代理在 vfs.db 侧另行建设。
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
        // ★ A6-22：VFS 模式下 lance notes_search 表与旧 notes 表都不再被写入
        // （sync_note_to_lance 仅旧 SQLite 路径调用），继续查询只会拿到陈旧/空结果。
        // 直接走 VFS 检索（标题+正文 LIKE），保证 canvas AI 笔记搜索工具拿到新鲜数据。
        if self.vfs_db.is_some() {
            return self.search_notes_vfs(trimmed, limit);
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

    /// ★ A6-22：VFS 模式下的笔记搜索（供 canvas AI 工具使用）
    ///
    /// ★ 2026-07-19（P1-1/P1-2）：改走 `VfsNoteRepo::search_notes_with_snippets`，
    /// FTS5（bm25 排序）优先、LIKE 兜底，元数据 + 正文摘要单查询取回，
    /// 消灭原先"每条命中单独 get_note_content"的 N+1。
    #[cfg(feature = "lance")]
    fn search_notes_vfs(
        &self,
        keyword: &str,
        limit: usize,
    ) -> Result<Vec<(String, String, Option<String>)>> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;
        let hits = VfsNoteRepo::search_notes_with_snippets(vfs_db, keyword, limit.max(1) as u32)
            .map_err(|e| AppError::database(format!("VFS 搜索笔记失败: {}", e)))?;
        Ok(hits
            .into_iter()
            .map(|(note, snippet)| (note.id, note.title, snippet))
            .collect())
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
                .map_err(|e| AppError::database(format!("获取 VFS 数据库连接失败: {}", e)))?;
            let mut stmt = conn
                .prepare(
                    "SELECT n.id, n.title, COALESCE(r.data, ''), n.tags, n.created_at, n.updated_at, COALESCE(n.is_favorite, 0)
                     FROM notes n
                     LEFT JOIN resources r ON r.id = n.resource_id
                     WHERE n.deleted_at IS NULL
                     ORDER BY datetime(n.updated_at) DESC",
                )
                .map_err(|e| AppError::database(format!("准备 VFS 笔记查询失败: {}", e)))?;
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
                .map_err(|e| AppError::database(format!("执行 VFS 笔记查询失败: {}", e)))?;
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
    ///
    /// ★ 2026-07-19（P2-1）：为防止超大笔记库一次性载入全部元数据，
    /// 默认上限 [`Self::DEFAULT_LIST_META_LIMIT`]；需要自定义上限时使用
    /// [`Self::list_notes_meta_limited`]。无参调用行为向后兼容。
    pub fn list_notes_meta(&self) -> Result<Vec<NoteItem>> {
        self.list_notes_meta_limited(Self::DEFAULT_LIST_META_LIMIT)
    }

    /// list_notes_meta 的默认返回上限（P2-1）
    pub const DEFAULT_LIST_META_LIMIT: u32 = 5000;

    /// Lightweight list with an explicit row cap (no content_md)
    pub fn list_notes_meta_limited(&self, limit: u32) -> Result<Vec<NoteItem>> {
        let limit = limit.max(1) as i64;
        if let Some(vfs_db) = self.vfs_db.as_ref() {
            let conn = vfs_db
                .get_conn_safe()
                .map_err(|e| AppError::database(format!("获取 VFS 数据库连接失败: {}", e)))?;
            // ★ 2026-07 性能：VFS 的 updated_at 恒为固定格式 UTC ISO8601，
            // 字典序即时间序；去掉 datetime() 包装让排序命中
            // idx_notes_updated_not_deleted 部分索引，避免全表排序。
            let mut stmt = conn
                .prepare(
                    "SELECT n.id, n.title, n.tags, n.created_at, n.updated_at, COALESCE(n.is_favorite, 0)
                     FROM notes n
                     WHERE n.deleted_at IS NULL
                     ORDER BY n.updated_at DESC
                     LIMIT ?1",
                )
                .map_err(|e| AppError::database(format!("准备 VFS 笔记查询失败: {}", e)))?;
            let rows = stmt
                .query_map(params![limit], |row| {
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
                .map_err(|e| AppError::database(format!("执行 VFS 笔记查询失败: {}", e)))?;
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
                 ORDER BY datetime(updated_at) DESC
                 LIMIT ?1",
            )
            .map_err(|e| AppError::database(format!("Failed to prepare query: {}", e)))?;
        let rows = stmt
            .query_map(params![limit], |row| {
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

    /// 将用户关键词构造成 notes_fts（trigram tokenizer）的 MATCH 查询。
    ///
    /// 与 `VfsNoteRepo::build_fts_match_query` 保持一致：整个关键词作为一个
    /// 带引号的 phrase（内部 `"` 双写转义），子串匹配语义与 `LIKE '%kw%'` 对齐；
    /// trigram 要求 >= 3 字符才能命中索引，不足时返回 None，由调用方回退 LIKE。
    fn build_notes_fts_match_query(keyword: &str) -> Option<String> {
        let trimmed = keyword.trim();
        if trimmed.chars().count() < 3 {
            return None;
        }
        Some(format!("\"{}\"", trimmed.replace('"', "\"\"")))
    }

    /// list_notes_advanced 的 VFS 实现。
    ///
    /// `fts_match` 为 Some 时关键词走 notes_fts JOIN（bm25 相关度排序，标题
    /// 权重 5:1 高于正文，与 VfsNoteRepo 一致）；为 None 时关键词走
    /// title/正文 LIKE。其余过滤条件（标签、时间、附件、软删除）两种模式共用。
    fn list_notes_advanced_vfs(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        opt: &ListOptions,
        fts_match: Option<&str>,
    ) -> Result<(Vec<NoteItem>, i64)> {
        let conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 数据库连接失败: {}", e)))?;

        let mut join_sql = String::from(" LEFT JOIN resources r ON r.id = n.resource_id");
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

        let mut order_by_relevance = false;
        if let Some(match_query) = fts_match {
            // FTS 路径：notes_fts.rowid 与 notes.rowid 对齐（见迁移触发器）
            join_sql.push_str(" JOIN notes_fts ON notes_fts.rowid = n.rowid");
            where_clauses.push(format!("notes_fts MATCH ?{}", param_idx));
            params_vec.push(Box::new(match_query.to_string()));
            param_idx += 1;
            // 用户未显式指定排序字段时，按 bm25 相关度排序
            order_by_relevance = opt.sort_by.is_none();
        } else if let Some(keyword) = opt.keyword.as_deref() {
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

        // ★ 2026-07-19：标签过滤精确匹配（历史 `tags LIKE %"tag"%` 有假阳性）。
        // 活跃笔记查询走规范化 note_tags 表（触发器维护 + idx_note_tags_tag
        // 索引，见 V20260722__note_tags.sql）；include_deleted / only_deleted
        // 查询仍走 json_each（note_tags 不含软删除笔记），json_valid 守卫
        // 防止历史非法 JSON 中断查询。
        let tags_via_note_tags = !opt.include_deleted && !opt.only_deleted;
        if let Some(tags) = opt.tags.as_ref() {
            for tag in tags.iter().filter(|t| !t.trim().is_empty()) {
                if tags_via_note_tags {
                    where_clauses.push(format!(
                        "EXISTS (SELECT 1 FROM note_tags nt WHERE nt.note_id = n.id AND nt.tag = ?{})",
                        param_idx
                    ));
                } else {
                    where_clauses.push(format!(
                        "EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(COALESCE(n.tags, '[]')) THEN COALESCE(n.tags, '[]') ELSE '[]' END) je WHERE TRIM(je.value) = ?{})",
                        param_idx
                    ));
                }
                params_vec.push(Box::new(tag.trim().to_string()));
                param_idx += 1;
            }
        }

        // ★ 2026-07-19（P1-5）：实现 VFS 路径的 has_assets 过滤。
        // 笔记附件存放在文件系统 notes_assets/{subject}/{note_id}/ 下，
        // 数据库中无附件登记表；正文引用附件时必然包含 "notes_assets/"
        // 相对路径（imageUpload/资产解析均以此为约定），据此用正文
        // LIKE 判断，代价与本查询已有的 r.data JOIN 同量级。
        if let Some(want_assets) = opt.has_assets {
            let cond = "COALESCE(r.data, '') LIKE '%notes_assets/%'";
            where_clauses.push(if want_assets {
                cond.to_string()
            } else {
                format!("NOT ({})", cond)
            });
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
        let order_sql = if order_by_relevance {
            // 标题权重 5:1 高于正文，与 VfsNoteRepo::search_notes_fts_* 一致
            "bm25(notes_fts, 5.0, 1.0), n.updated_at DESC, n.id ASC".to_string()
        } else {
            format!("{} {}", sort_col, sort_dir)
        };

        let page = opt.page.max(0);
        let page_size = opt.page_size.max(1);
        let limit = page_size;
        let offset = page * page_size;

        let count_sql = format!("SELECT COUNT(*) FROM notes n{}{}", join_sql, where_sql);
        let mut count_stmt = conn
            .prepare(&count_sql)
            .map_err(|e| AppError::database(format!("准备 VFS 笔记计数查询失败: {}", e)))?;
        let count_params: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let total: i64 = count_stmt
            .query_row(count_params.as_slice(), |row| row.get(0))
            .map_err(|e| AppError::database(format!("执行 VFS 笔记计数查询失败: {}", e)))?;

        let sql = format!(
            "SELECT n.id, n.title, COALESCE(r.data, ''), n.tags, n.created_at, n.updated_at, COALESCE(n.is_favorite, 0)
             FROM notes n{}
             {} ORDER BY {} LIMIT ?{} OFFSET ?{}",
            join_sql,
            where_sql,
            order_sql,
            param_idx,
            param_idx + 1
        );
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| AppError::database(format!("准备 VFS 笔记列表查询失败: {}", e)))?;
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
            .map_err(|e| AppError::database(format!("执行 VFS 笔记列表查询失败: {}", e)))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| AppError::database(e.to_string()))?);
        }
        Ok((out, total))
    }

    pub fn list_notes_advanced(&self, opt: ListOptions) -> Result<(Vec<NoteItem>, i64)> {
        if let Some(vfs_db) = self.vfs_db.as_ref() {
            // ★ 2026-07-19：VFS 分支关键词检索优先走 notes_fts（trigram 索引，
            // 见 V20260721__notes_fts.sql），与 VfsNoteRepo::search_notes_* 同一
            // 套索引与查询构造语义：
            //   - >= 3 字符：FTS MATCH（子串语义与 LIKE '%kw%' 对齐）+ bm25 排序；
            //   - < 3 字符 / FTS 查询失败 / FTS 无命中：回退到原 LIKE 路径，
            //     保证结果不弱于历史实现（回收站笔记等仍可被 LIKE 命中，
            //     因为 notes_fts 不索引软删除行）。
            let fts_usable = !opt.include_deleted && !opt.only_deleted;
            let fts_query = if fts_usable {
                opt.keyword
                    .as_deref()
                    .and_then(Self::build_notes_fts_match_query)
            } else {
                None
            };
            if let Some(match_query) = fts_query.as_deref() {
                match self.list_notes_advanced_vfs(vfs_db, &opt, Some(match_query)) {
                    Ok((items, total)) if total > 0 => return Ok((items, total)),
                    Ok(_) => {
                        log::debug!(
                            "[NotesManager] list_notes_advanced FTS 无命中，回退 LIKE：{:?}",
                            opt.keyword
                        );
                    }
                    Err(e) => {
                        warn!(
                            "[NotesManager] list_notes_advanced FTS 查询失败（{}），回退 LIKE",
                            e
                        );
                    }
                }
            }
            return self.list_notes_advanced_vfs(vfs_db, &opt, None);
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

    /// ⚠️ DEPRECATED（legacy 非 VFS 死路径）：直接写主库旧 `notes` 表。
    /// VFS 模式下调用直接报错（见函数体首行门禁）。请勿在新代码中使用。
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
            created_at,
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
        // ★ 2026-07-19（P3-1）：与 create/update/delete 对齐，VFS 模式下委托
        // VFS 恢复路径（含标题冲突重命名 + folder_items 联动 + 重索引标记）。
        // 此前该函数会误写主库旧 notes 表（VFS 模式下的死数据）。
        if self.vfs_db.is_some() {
            return self.restore_note_vfs(id);
        }
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

    /// ⚠️ DEPRECATED（legacy 非 VFS 死路径）：维护主库旧 `note_tags` 表。
    /// VFS 模式下的规范化标签表位于 vfs.db（V20260722__note_tags.sql），
    /// 由触发器随 notes 表写入自动维护，与本函数无关。请勿在新代码中使用。
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
    /// 规范化章节查询串：允许调用方传 "Section"、"## Section"、"##Section"
    /// 等形式。返回（期望的标题层级，规范化后的小写标题文本）；
    /// 无 `#` 前缀时层级为 None（任意层级均可匹配）。
    fn normalize_heading_query(query: &str) -> (Option<usize>, String) {
        let trimmed = query.trim();
        let level = trimmed.chars().take_while(|&c| c == '#').count();
        if level > 0 && level <= 6 {
            (Some(level), trimmed[level..].trim().to_lowercase())
        } else {
            (None, trimmed.to_lowercase())
        }
    }

    /// 去掉 ATX 标题的关闭井号序列（`## Title ##` -> `Title`）。
    /// 仅当尾部 `#` 前有空白时才视为关闭序列（`## C#` 中的 `#` 属于正文）。
    fn strip_atx_closing(text: &str) -> &str {
        let trimmed = text.trim_end();
        let stripped = trimmed.trim_end_matches('#');
        if stripped.len() != trimmed.len() {
            let before_hashes = stripped.trim_end();
            if before_hashes.len() < stripped.len() && !before_hashes.is_empty() {
                return before_hashes;
            }
        }
        trimmed
    }

    /// 判断某行是否为代码围栏（``` 或 ~~~）开/闭行，返回围栏标记
    fn fence_marker(line: &str) -> Option<&'static str> {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            Some("```")
        } else if trimmed.starts_with("~~~") {
            Some("~~~")
        } else {
            None
        }
    }

    /// 定位章节边界：返回 (标题行下标, 标题层级, 章节结束行下标（不含）)。
    ///
    /// 鲁棒性约定（Canvas AI 工具共享）：
    /// - 标题匹配忽略大小写、忽略 ATX 关闭井号（`## Title ##`）；
    /// - 查询带 `#` 前缀时要求层级一致，不带则任意层级均可命中；
    /// - 代码围栏（```/~~~）内的 `#` 行不视为标题（无论定位还是判定章节结束）。
    fn find_section_bounds(lines: &[&str], section_title: &str) -> Option<(usize, usize, usize)> {
        let (want_level, want_text) = Self::normalize_heading_query(section_title);
        if want_text.is_empty() {
            return None;
        }

        let mut fence: Option<&str> = None;
        let mut start_idx: Option<usize> = None;
        let mut section_level = 0usize;

        for (i, line) in lines.iter().enumerate() {
            if let Some(marker) = Self::fence_marker(line) {
                match fence {
                    Some(open) if open == marker => fence = None,
                    None => fence = Some(marker),
                    _ => {}
                }
                continue;
            }
            if fence.is_some() {
                continue;
            }
            let trimmed = line.trim();
            if let Some(level) = Self::get_heading_level(trimmed) {
                if let Some(start) = start_idx {
                    // 已定位到章节，遇到同级或更高级标题即为结束
                    if level <= section_level {
                        return Some((start, section_level, i));
                    }
                    continue;
                }
                if want_level.is_some() && want_level != Some(level) {
                    continue;
                }
                let heading_text = Self::strip_atx_closing(trimmed[level..].trim()).to_lowercase();
                if heading_text == want_text {
                    start_idx = Some(i);
                    section_level = level;
                }
            }
        }

        start_idx.map(|start| (start, section_level, lines.len()))
    }

    /// 从 Markdown 内容中提取指定章节
    /// 章节由标题行（#、##、###等）界定
    fn extract_section_content(content: &str, section_title: &str) -> Option<String> {
        let lines: Vec<&str> = content.lines().collect();
        let (start, _level, end_idx) = Self::find_section_bounds(&lines, section_title)?;

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
        let (_start, _level, end_idx) = Self::find_section_bounds(&lines, section_title)?;

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

        // ★ 2026-07-19：空搜索串守卫。空字符串 / 空正则会在每个字符间隙命中
        // （`"ab".matches("")` 计数为 3），替换结果等同于在全文插入 replace，
        // 且计数完全失真，直接拒绝。
        if search.is_empty() {
            return Err(AppError::validation("搜索内容不能为空"));
        }

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
            .map_err(|e| AppError::database(format!("VFS 列出笔记失败: {}", e)))?;

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
            .map_err(|e| AppError::database(format!("VFS 创建笔记失败: {}", e)))?;

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

        // ★ A6-20：乐观锁冲突必须保留 conflict 错误码（含 "notes.conflict" 标识），
        // 与旧 SQLite 路径(update_note)一致；一律包装成 database 会让前端无法识别冲突
        let vfs_note = VfsNoteRepo::update_note(vfs_db, note_id, params).map_err(|e| match &e {
            crate::vfs::error::VfsError::Conflict { .. } => AppError::conflict(e.to_string()),
            _ => AppError::database(format!("VFS 更新笔记失败: {}", e)),
        })?;

        // 获取更新后的内容。
        // ★ 2026-07 性能：本次调用已携带正文时，更新成功后的内容必然等于
        // 传入值（repo 内 hash 相同则复用旧资源，内容不变），无需再整篇回读
        //（大笔记每次自动保存省一次全量 DB 读取 + 拷贝）。
        let content = match content_md {
            Some(c) => c.to_string(),
            None => VfsNoteRepo::get_note_content(vfs_db, note_id)
                .map_err(|e| AppError::database(format!("VFS 读取笔记内容失败: {}", e)))?
                .unwrap_or_default(),
        };

        log::info!("[NotesManager::VFS] Updated note: {}", note_id);

        Ok(Self::vfs_note_to_note_item(vfs_note, content))
    }

    pub fn get_note_vfs(&self, note_id: &str) -> Result<NoteItem> {
        let vfs_db = self
            .vfs_db
            .as_ref()
            .ok_or_else(|| AppError::configuration("VFS database not configured"))?;

        let (vfs_note, content) = VfsNoteRepo::get_note_with_content(vfs_db, note_id)
            .map_err(|e| AppError::database(format!("VFS 读取笔记失败: {}", e)))?
            .ok_or_else(|| AppError::not_found("笔记不存在或已被删除"))?;

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

        VfsNoteRepo::delete_note_with_folder_item(vfs_db, note_id)
            .map_err(|e| AppError::database(format!("VFS 删除笔记失败: {}", e)))?;

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
            .map_err(|e| AppError::database(format!("VFS 恢复笔记失败: {}", e)))?;

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
            .map_err(|e| AppError::database(format!("VFS 设置收藏状态失败: {}", e)))?;

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
    fn test_extract_section_ignores_headings_inside_code_fence() {
        let content = r#"# Title

## Shell
```bash
# 这是注释，不是标题
echo hi
```
tail text

## Next
other"#;

        // 围栏内的 "# 这是注释" 不应被当成标题（否则 Shell 章节会被提前截断）
        let section = NotesManager::extract_section_content(content, "## Shell");
        assert!(section.is_some());
        let s = section.unwrap();
        assert!(s.contains("echo hi"));
        assert!(s.contains("tail text"));
        assert!(!s.contains("other"));

        // 围栏内注释行不可作为章节被定位
        assert!(NotesManager::extract_section_content(content, "这是注释，不是标题").is_none());
    }

    #[test]
    fn test_extract_section_with_atx_closing_hashes() {
        let content = "# Doc\n\n## Closed ##\nbody line\n\n## C#\ncsharp line\n";

        let closed = NotesManager::extract_section_content(content, "Closed");
        assert_eq!(closed.as_deref(), Some("body line"));

        // "C#" 的尾部 # 属于正文，不是关闭序列
        let csharp = NotesManager::extract_section_content(content, "C#");
        assert_eq!(csharp.as_deref(), Some("csharp line"));
    }

    #[test]
    fn test_section_query_level_must_match_when_specified() {
        let content = "# Root\n\n## Sub\nlevel2 body\n";
        // 显式指定错误层级时不命中
        assert!(NotesManager::extract_section_content(content, "### Sub").is_none());
        // 层级正确 / 不指定层级均命中
        assert!(NotesManager::extract_section_content(content, "## Sub").is_some());
        assert!(NotesManager::extract_section_content(content, "Sub").is_some());
    }

    #[test]
    fn test_build_notes_fts_match_query() {
        // < 3 字符（trigram 无法命中索引）返回 None，由调用方回退 LIKE
        assert_eq!(NotesManager::build_notes_fts_match_query("ab"), None);
        assert_eq!(NotesManager::build_notes_fts_match_query("  a "), None);
        // >= 3 字符：整体作为带引号 phrase，内部引号双写
        assert_eq!(
            NotesManager::build_notes_fts_match_query("微积分"),
            Some("\"微积分\"".to_string())
        );
        assert_eq!(
            NotesManager::build_notes_fts_match_query(r#"say "hi""#),
            Some("\"say \"\"hi\"\"\"".to_string())
        );
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
