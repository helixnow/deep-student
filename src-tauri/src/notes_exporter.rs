use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use zip::write::FileOptions;

use crate::database::Database;
use crate::file_manager::FileManager;
use crate::models::AppError;
use crate::vfs::{
    VfsCreateNoteParams, VfsDatabase, VfsNoteRepo, VfsUpdateNoteParams,
};

type Result<T> = std::result::Result<T, AppError>;

const SCHEMA_VERSION: u32 = 2;

/// 统一的 ZIP 格式：Markdown 文件 + 完整元数据（版本历史、偏好设置）
/// 其他软件可以直接读取 .md 文件，忽略 _versions 和 _preferences 目录

pub struct NotesExporter {
    db: Arc<Database>,
    file_manager: Arc<FileManager>,
    vfs_db: Option<Arc<VfsDatabase>>,
}

#[derive(Debug, Clone)]
pub struct ExportOptions {
    pub include_versions: bool,
    pub output_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct SingleNoteExportOptions {
    pub note_id: String,
    pub include_versions: bool,
    pub output_path: Option<PathBuf>,
}

#[derive(Debug, Serialize)]
pub struct ExportSummary {
    pub output_path: String,
    pub note_count: usize,
    pub attachment_count: usize,
}

#[derive(Serialize, Deserialize)]
struct Manifest {
    schema_version: u32,
    exported_at: String,
    app_version: String,
    note_count: usize,
    attachment_count: usize,
    version_count: usize,
    preferences: Vec<ManifestPreference>,
    // subject 已废弃，但为了向后兼容保留该字段（用于导入旧备份）
    #[serde(default)]
    subjects: Vec<ManifestSubject>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ManifestSubject {
    subject: String,
    slug: String,
    note_count: usize,
    /// 向后兼容：旧备份可能包含 preferences
    #[serde(default)]
    preferences: Vec<ManifestPreference>,
    /// 向后兼容：旧备份可能包含 notes_file 路径
    #[serde(default)]
    notes_file: Option<String>,
    /// 向后兼容：旧备份可能包含 attachments_root 路径
    #[serde(default)]
    attachments_root: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
struct ManifestPreference {
    key: String,
    file: String,
    bytes: usize,
}

#[derive(Serialize, Deserialize)]
struct ExportNote {
    id: String,
    title: String,
    content_md: String,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
    is_favorite: bool,
    attachments: Vec<ExportAttachment>,
}

#[derive(Serialize, Deserialize)]
struct ExportAttachment {
    relative_path: String,
    mime: Option<String>,
    size: Option<i64>,
}

#[derive(Serialize, Deserialize)]
struct ExportVersion {
    version_id: String,
    note_id: String,
    title: String,
    content_md: String,
    tags: Vec<String>,
    label: Option<String>,
    created_at: String,
}

impl NotesExporter {
    pub fn new(db: Arc<Database>, file_manager: Arc<FileManager>) -> Self {
        Self {
            db,
            file_manager,
            vfs_db: None,
        }
    }

    pub fn new_with_vfs(
        db: Arc<Database>,
        file_manager: Arc<FileManager>,
        vfs_db: Option<Arc<VfsDatabase>>,
    ) -> Self {
        Self {
            db,
            file_manager,
            vfs_db,
        }
    }

    pub fn export(&self, options: ExportOptions) -> Result<ExportSummary> {
        log::info!("开始导出笔记，选项：{:?}", options);
        self.export_unified_zip(options)
    }

    pub fn export_single(&self, options: SingleNoteExportOptions) -> Result<ExportSummary> {
        log::info!("开始导出单条笔记，选项：{:?}", options);
        self.export_single_zip(options)
    }

    /// 统一的 ZIP 格式导出：Markdown 文件 + 完整元数据
    /// 结构：
    /// archive.zip
    /// ├── manifest.json              # 完整元数据
    /// ├── notes/
    /// │   ├── {folder}/{title}_{id}.md   # 可读 Markdown（YAML frontmatter）
    /// ├── _versions/                  # 版本历史（其他软件可忽略）
    /// │   └── {note_id}_{version_id}.md
    /// ├── _preferences/               # 偏好设置
    /// │   └── {key}.json
    /// ├── assets/                     # 附件
    /// └── README.md
    fn export_unified_zip(&self, options: ExportOptions) -> Result<ExportSummary> {
        log::info!("使用统一 ZIP 格式导出");

        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        log::info!("数据库连接获取成功");

        let output_path = self.resolve_output_path(options.output_path)?;
        log::info!("导出文件路径：{}", output_path.display());
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                AppError::file_system(format!(
                    "创建导出目录失败: {} ({})",
                    e,
                    parent.to_string_lossy()
                ))
            })?;
        }
        let file = fs::File::create(&output_path).map_err(|e| {
            AppError::file_system(format!(
                "创建导出文件失败: {} ({})",
                e,
                output_path.to_string_lossy()
            ))
        })?;
        let mut zip = zip::ZipWriter::new(file);
        let file_options = FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);

        // 收集所有笔记（不按 subject 分组）
        let bundle = self.collect_all_notes_bundle(&conn, options.include_versions, None)?;
        if bundle.notes.is_empty() {
            log::warn!("没有找到可导出的笔记");
            return Err(AppError::validation("没有可导出的笔记"));
        }

        log::info!(
            "找到 {} 条笔记，{} 个附件，{} 个版本",
            bundle.notes.len(),
            bundle.attachments.len(),
            bundle.versions.len()
        );

        let note_id_set: HashSet<String> = bundle.notes.iter().map(|n| n.id.clone()).collect();
        let folder_paths = build_folder_paths_flat(&note_id_set, &bundle.preferences);

        // 导出笔记为 Markdown 文件（主体内容，跨软件可读）
        for note in bundle.notes.iter() {
            let safe_title = sanitize_filename(&note.title);
            let id_prefix = &note.id;
            let md_filename =
                build_md_path_flat(folder_paths.get(&note.id), &safe_title, id_prefix);

            let md_content = self.render_markdown_note_flat(note, folder_paths.get(&note.id));

            zip.start_file(&md_filename, file_options).map_err(|e| {
                AppError::file_system(format!("写入笔记 {} 失败: {}", md_filename, e))
            })?;
            zip.write_all(md_content.as_bytes()).map_err(|e| {
                AppError::file_system(format!("写入笔记 {} 失败: {}", md_filename, e))
            })?;
        }

        let mut version_total = 0usize;
        // 导出版本历史（_versions 目录，其他软件可忽略）
        if options.include_versions && !bundle.versions.is_empty() {
            for version in bundle.versions.iter() {
                let version_filename =
                    format!("_versions/{}_{}.md", version.note_id, version.version_id);
                let version_content = self.render_version_markdown_flat(version);
                zip.start_file(&version_filename, file_options)
                    .map_err(|e| {
                        AppError::file_system(format!("写入版本 {} 失败: {}", version_filename, e))
                    })?;
                zip.write_all(version_content.as_bytes()).map_err(|e| {
                    AppError::file_system(format!("写入版本 {} 失败: {}", version_filename, e))
                })?;
            }
            version_total = bundle.versions.len();
        }

        // 导出偏好设置（_preferences 目录）
        let mut preferences_entries: Vec<ManifestPreference> = Vec::new();
        if !bundle.preferences.is_empty() {
            for (key, value) in bundle.preferences.iter() {
                let pref_file = format!("_preferences/{}.json", sanitize_pref_key(key));
                let json_bytes = serde_json::to_vec_pretty(value)
                    .map_err(|e| AppError::internal(format!("序列化偏好 {} 失败: {}", key, e)))?;
                zip.start_file(&pref_file, file_options).map_err(|e| {
                    AppError::file_system(format!("写入偏好 {} 失败: {}", pref_file, e))
                })?;
                zip.write_all(&json_bytes).map_err(|e| {
                    AppError::file_system(format!("写入偏好 {} 失败: {}", pref_file, e))
                })?;
                preferences_entries.push(ManifestPreference {
                    key: key.clone(),
                    file: pref_file.clone(),
                    bytes: json_bytes.len(),
                });
            }
        }

        // 导出附件
        if !bundle.attachments.is_empty() {
            for attachment in bundle.attachments.iter() {
                let relative = attachment
                    .relative_path
                    .iter()
                    .map(|component| component.to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                if relative.is_empty() {
                    continue;
                }
                let zip_entry = format!("assets/{}", relative);
                zip.start_file(&zip_entry, file_options).map_err(|e| {
                    AppError::file_system(format!("写入附件 {} 失败: {}", zip_entry, e))
                })?;
                zip.write_all(&attachment.bytes).map_err(|e| {
                    AppError::file_system(format!("写入附件 {} 失败: {}", zip_entry, e))
                })?;
            }
        }

        // 写入 manifest.json（完整元数据）
        let manifest = Manifest {
            schema_version: SCHEMA_VERSION,
            exported_at: Utc::now().to_rfc3339(),
            app_version: env!("CARGO_PKG_VERSION").to_string(),
            note_count: bundle.notes.len(),
            attachment_count: bundle.attachments.len(),
            version_count: version_total,
            preferences: preferences_entries,
            subjects: Vec::new(), // subject 已废弃，导出时不再包含
        };

        let manifest_bytes = serde_json::to_vec_pretty(&manifest)
            .map_err(|e| AppError::internal(format!("生成 manifest 失败: {}", e)))?;
        zip.start_file("manifest.json", file_options)
            .map_err(|e| AppError::file_system(format!("写入 manifest 失败: {}", e)))?;
        zip.write_all(&manifest_bytes)
            .map_err(|e| AppError::file_system(format!("写入 manifest 失败: {}", e)))?;

        // 写入 README.md（说明文件）
        let readme = format!(
            "# 笔记导出\n\n\
            导出时间：{}\n\
            导出格式：统一 ZIP 格式（Markdown + 元数据）\n\
            笔记数量：{}\n\
            版本数量：{}\n\
            附件数量：{}\n\n\
            ## 目录结构\n\n\
            - 根目录包含 `.md` 笔记文件\n\
            - `_versions/` 目录：版本历史（可选，其他软件可忽略）\n\
            - `_preferences/` 目录：偏好设置（可选）\n\
            - `assets/` 目录：附件文件\n\n\
            ## 跨软件兼容性\n\n\
            本备份格式兼容常见 Markdown 编辑器。\n\
            解压后即可查看笔记内容。\n\
            以下划线 `_` 开头的目录为应用专用元数据，可安全忽略。\n\
            ",
            Utc::now().format("%Y-%m-%d %H:%M:%S"),
            bundle.notes.len(),
            version_total,
            bundle.attachments.len()
        );

        zip.start_file("README.md", file_options)
            .map_err(|e| AppError::file_system(format!("写入 README 失败: {}", e)))?;
        zip.write_all(readme.as_bytes())
            .map_err(|e| AppError::file_system(format!("写入 README 失败: {}", e)))?;

        log::info!("开始完成ZIP文件写入");
        zip.finish()
            .map_err(|e| AppError::file_system(format!("完成导出文件失败: {}", e)))?;

        log::info!(
            "导出成功完成！路径：{}，笔记数：{}，附件数：{}",
            output_path.display(),
            bundle.notes.len(),
            bundle.attachments.len()
        );

        Ok(ExportSummary {
            output_path: output_path.to_string_lossy().to_string(),
            note_count: bundle.notes.len(),
            attachment_count: bundle.attachments.len(),
        })
    }

    fn resolve_output_path(&self, output_path: Option<PathBuf>) -> Result<PathBuf> {
        if let Some(path) = output_path {
            if path.as_os_str().is_empty() {
                return Err(AppError::validation("导出路径不能为空"));
            }
            if path.is_dir() {
                let filename = format!("notes_export_{}.zip", Utc::now().format("%Y%m%d_%H%M%S"));
                return Ok(path.join(filename));
            }
            return Ok(path);
        }
        let default_dir = self.file_manager.get_app_data_dir().join("exports");
        let filename = format!("notes_export_{}.zip", Utc::now().format("%Y%m%d_%H%M%S"));
        Ok(default_dir.join(filename))
    }

    /// 渲染版本历史为 Markdown
    fn render_version_markdown(&self, version: &ExportVersion, subject: &str) -> String {
        let mut md_content = String::new();

        md_content.push_str("---\n");
        md_content.push_str(&format!("version_id: {}\n", version.version_id));
        md_content.push_str(&format!("note_id: {}\n", version.note_id));
        md_content.push_str(&format!("title: {}\n", version.title));
        md_content.push_str(&format!("subject: {}\n", subject));
        md_content.push_str(&format!("created: {}\n", version.created_at));
        if let Some(ref label) = version.label {
            md_content.push_str(&format!("label: {}\n", label));
        }
        if !version.tags.is_empty() {
            md_content.push_str("tags:\n");
            for tag in version.tags.iter() {
                md_content.push_str(&format!("  - {}\n", tag));
            }
        }
        md_content.push_str("---\n\n");

        md_content.push_str(&version.content_md);

        md_content
    }

    fn resolve_single_output_path(
        &self,
        output_path: Option<PathBuf>,
        note: &ExportNote,
    ) -> Result<PathBuf> {
        if let Some(path) = output_path {
            if path.as_os_str().is_empty() {
                return Err(AppError::validation("导出路径不能为空"));
            }
            if path.is_dir() {
                let filename = format!(
                    "note_export_{}_{}.zip",
                    sanitize_filename(&note.title),
                    note.id
                );
                return Ok(path.join(filename));
            }
            return Ok(path);
        }

        let default_dir = self.file_manager.get_app_data_dir().join("exports");
        let filename = format!(
            "note_export_{}_{}.zip",
            sanitize_filename(&note.title),
            note.id
        );
        std::fs::create_dir_all(&default_dir)?;
        Ok(default_dir.join(filename))
    }

    fn render_markdown_note_flat(&self, note: &ExportNote, folder_path: Option<&String>) -> String {
        let mut md_content = String::new();

        md_content.push_str("---\n");
        md_content.push_str(&format!("id: {}\n", note.id));
        md_content.push_str(&format!("title: {}\n", note.title));
        md_content.push_str(&format!("created: {}\n", note.created_at));
        md_content.push_str(&format!("updated: {}\n", note.updated_at));
        if note.is_favorite {
            md_content.push_str("favorite: true\n");
        }
        if let Some(fp) = folder_path {
            md_content.push_str(&format!("folder: {}\n", fp));
        }
        if !note.tags.is_empty() {
            md_content.push_str("tags:\n");
            for tag in note.tags.iter() {
                md_content.push_str(&format!("  - {}\n", tag));
            }
        }
        md_content.push_str("---\n\n");
        md_content.push_str(&note.content_md);
        md_content
    }

    fn render_version_markdown_flat(&self, version: &ExportVersion) -> String {
        let mut md_content = String::new();

        md_content.push_str("---\n");
        md_content.push_str(&format!("version_id: {}\n", version.version_id));
        md_content.push_str(&format!("note_id: {}\n", version.note_id));
        md_content.push_str(&format!("title: {}\n", version.title));
        md_content.push_str(&format!("created: {}\n", version.created_at));
        if let Some(ref label) = version.label {
            md_content.push_str(&format!("label: {}\n", label));
        }
        if !version.tags.is_empty() {
            md_content.push_str("tags:\n");
            for tag in version.tags.iter() {
                md_content.push_str(&format!("  - {}\n", tag));
            }
        }
        md_content.push_str("---\n\n");
        md_content.push_str(&version.content_md);
        md_content
    }

    fn collect_all_notes_bundle(
        &self,
        conn: &rusqlite::Connection,
        include_versions: bool,
        note_filter: Option<&HashSet<String>>,
    ) -> Result<SubjectBundle> {
        if let Some(vfs_db) = self.vfs_db.as_ref() {
            return self.collect_all_notes_bundle_vfs(vfs_db, include_versions, note_filter);
        }

        log::info!("collect_all_notes_bundle 开始查询所有笔记");

        let mut notes_stmt = conn.prepare(
            "SELECT id, title, content_md, tags, created_at, updated_at, COALESCE(is_favorite, 0)
             FROM notes
             WHERE deleted_at IS NULL
             ORDER BY datetime(updated_at) DESC",
        ).map_err(|e| AppError::database(format!("准备笔记查询失败: {}", e)))?;

        let rows = notes_stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let title: String = row.get(1)?;
                let content_md: String = row.get(2)?;
                let tags_json: String = row.get(3)?;
                let created_at: String = row.get(4)?;
                let updated_at: String = row.get(5)?;
                let is_favorite: i64 = row.get(6)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok((
                    id,
                    title,
                    content_md,
                    tags,
                    created_at,
                    updated_at,
                    is_favorite != 0,
                ))
            })
            .map_err(|e| AppError::database(format!("遍历笔记失败: {}", e)))?;

        let mut notes: Vec<ExportNote> = Vec::new();
        let mut note_ids: HashSet<String> = HashSet::new();
        for row in rows {
            let (id, title, content_md, tags, created_at, updated_at, is_favorite) =
                row.map_err(|e| AppError::database(e.to_string()))?;
            if let Some(filter) = note_filter {
                if !filter.contains(&id) {
                    continue;
                }
            }
            note_ids.insert(id.clone());
            notes.push(ExportNote {
                id,
                title,
                content_md,
                tags,
                created_at,
                updated_at,
                is_favorite,
                attachments: Vec::new(),
            });
        }

        log::info!("笔记遍历完成，共 {} 条", notes.len());

        if notes.is_empty() {
            return Ok(SubjectBundle::default());
        }

        // 查询附件
        let mut asset_stmt = conn
            .prepare("SELECT note_id, path, size, mime FROM assets")
            .map_err(|e| AppError::database(format!("准备附件查询失败: {}", e)))?;

        let asset_rows = asset_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| AppError::database(format!("遍历附件失败: {}", e)))?;

        let mut attachments: Vec<ExportAttachmentInternal> = Vec::new();
        for row in asset_rows {
            let (note_id, path_str, _size, _mime) =
                row.map_err(|e| AppError::database(e.to_string()))?;
            if !note_ids.contains(&note_id) {
                continue;
            }
            let abs_path = self.file_manager.get_app_data_dir().join(&path_str);
            if abs_path.exists() {
                if let Ok(bytes) = std::fs::read(&abs_path) {
                    attachments.push(ExportAttachmentInternal {
                        relative_path: PathBuf::from(&path_str),
                        bytes,
                    });
                }
            }
        }

        // 版本历史已移除，返回空列表
        let versions: Vec<ExportVersion> = Vec::new();

        // 查询偏好设置
        let preferences = self.collect_all_preferences(conn)?;

        Ok(SubjectBundle {
            notes,
            attachments,
            versions,
            preferences,
        })
    }

    fn collect_all_preferences(
        &self,
        conn: &rusqlite::Connection,
    ) -> Result<BTreeMap<String, Value>> {
        let mut prefs: BTreeMap<String, Value> = BTreeMap::new();
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings WHERE key LIKE 'notes.pref.%'")
            .map_err(|e| AppError::database(format!("准备偏好查询失败: {}", e)))?;

        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| AppError::database(format!("遍历偏好失败: {}", e)))?;

        for row in rows {
            let (key, value_str) = row.map_err(|e| AppError::database(e.to_string()))?;
            if let Ok(value) = serde_json::from_str::<Value>(&value_str) {
                prefs.insert(key, value);
            }
        }
        Ok(prefs)
    }

    fn render_markdown_note(
        &self,
        note: &ExportNote,
        subject: &str,
        subject_slug: &str,
        folder_path: Option<&String>,
    ) -> String {
        let mut md_content = String::new();

        md_content.push_str("---\n");
        md_content.push_str(&format!("id: {}\n", note.id));
        md_content.push_str(&format!("title: {}\n", note.title));
        md_content.push_str(&format!("subject: {}\n", subject));
        md_content.push_str(&format!("created: {}\n", note.created_at));
        md_content.push_str(&format!("updated: {}\n", note.updated_at));
        if note.is_favorite {
            md_content.push_str("favorite: true\n");
        }
        if let Some(path) = folder_path {
            if !path.is_empty() {
                md_content.push_str(&format!("folder_path: {}\n", path));
            }
        }
        if !note.tags.is_empty() {
            md_content.push_str("tags:\n");
            for tag in note.tags.iter() {
                md_content.push_str(&format!("  - {}\n", tag));
            }
        }
        md_content.push_str("---\n\n");

        let content_trimmed = note.content_md.trim();
        if !content_trimmed.starts_with('#') {
            md_content.push_str(&format!("# {}\n\n", note.title));
        }

        let rewritten_content =
            rewrite_content_paths_for_export(&note.content_md, subject, subject_slug);
        md_content.push_str(&rewritten_content);

        md_content
    }

    fn export_single_zip(&self, options: SingleNoteExportOptions) -> Result<ExportSummary> {
        log::info!("使用统一 ZIP 格式导出单条笔记");

        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        let mut note_filter: HashSet<String> = HashSet::new();
        note_filter.insert(options.note_id.clone());

        let bundle =
            self.collect_all_notes_bundle(&conn, options.include_versions, Some(&note_filter))?;

        if bundle.notes.is_empty() {
            return Err(AppError::validation("未找到要导出的笔记"));
        }

        let note = &bundle.notes[0];
        let output_path = self.resolve_single_output_path(options.output_path.clone(), note)?;

        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent).map_err(|e| {
                AppError::file_system(format!(
                    "创建导出目录失败: {} ({})",
                    e,
                    parent.to_string_lossy()
                ))
            })?;
        }

        let file = fs::File::create(&output_path).map_err(|e| {
            AppError::file_system(format!(
                "创建导出文件失败: {} ({})",
                e,
                output_path.to_string_lossy()
            ))
        })?;
        let mut zip = zip::ZipWriter::new(file);
        let file_options = FileOptions::default()
            .compression_method(zip::CompressionMethod::Deflated)
            .unix_permissions(0o644);

        for attachment in bundle.attachments.iter() {
            let relative = attachment.relative_path.to_string_lossy().to_string();
            if relative.is_empty() {
                continue;
            }
            let zip_entry = format!("assets/{}", relative);
            zip.start_file(&zip_entry, file_options.clone())
                .map_err(|e| {
                    AppError::file_system(format!("写入附件 {} 失败: {}", zip_entry, e))
                })?;
            zip.write_all(&attachment.bytes).map_err(|e| {
                AppError::file_system(format!("写入附件 {} 失败: {}", zip_entry, e))
            })?;
        }

        let note_id_set: HashSet<String> = bundle.notes.iter().map(|n| n.id.clone()).collect();
        let folder_paths = build_folder_paths_flat(&note_id_set, &bundle.preferences);

        // 笔记
        let safe_title = sanitize_filename(&note.title);
        let id_prefix = &note.id;
        let md_filename = build_md_path_flat(folder_paths.get(&note.id), &safe_title, id_prefix);
        let md_content = self.render_markdown_note_flat(note, folder_paths.get(&note.id));
        zip.start_file(&md_filename, file_options.clone())
            .map_err(|e| AppError::file_system(format!("写入笔记 {} 失败: {}", md_filename, e)))?;
        zip.write_all(md_content.as_bytes())
            .map_err(|e| AppError::file_system(format!("写入笔记 {} 失败: {}", md_filename, e)))?;

        // 版本历史（_versions 目录）
        if options.include_versions && !bundle.versions.is_empty() {
            for version in bundle.versions.iter() {
                let version_filename =
                    format!("_versions/{}_{}.md", version.note_id, version.version_id);
                let version_content = self.render_version_markdown_flat(version);
                zip.start_file(&version_filename, file_options.clone())
                    .map_err(|e| {
                        AppError::file_system(format!("写入版本 {} 失败: {}", version_filename, e))
                    })?;
                zip.write_all(version_content.as_bytes()).map_err(|e| {
                    AppError::file_system(format!("写入版本 {} 失败: {}", version_filename, e))
                })?;
            }
        }

        let readme = format!(
            "# 笔记导出\n\n\
            导出时间：{}\n\
            导出格式：统一 ZIP 格式（单条笔记）\n\
            笔记标题：{}\n\
            版本数量：{}\n\
            附件数量：{}\n\n\
            ## 目录结构\n\n\
            - `notes/` 目录：笔记文件\n\
            - `_versions/` 目录：版本历史（可选）\n\
            - `assets/` 目录：附件文件\n\n\
            ## 跨软件兼容性\n\n\
            本备份格式兼容常见 Markdown 编辑器。\n\
            ",
            Utc::now().format("%Y-%m-%d %H:%M:%S"),
            note.title,
            bundle.versions.len(),
            bundle.attachments.len(),
        );
        zip.start_file("README.md", file_options)
            .map_err(|e| AppError::file_system(format!("写入 README 失败: {}", e)))?;
        zip.write_all(readme.as_bytes())
            .map_err(|e| AppError::file_system(format!("写入 README 失败: {}", e)))?;

        zip.finish()
            .map_err(|e| AppError::file_system(format!("完成导出文件失败: {}", e)))?;

        Ok(ExportSummary {
            output_path: output_path.to_string_lossy().to_string(),
            note_count: 1,
            attachment_count: bundle.attachments.len(),
        })
    }

    fn collect_subject_bundle(
        &self,
        conn: &rusqlite::Connection,
        subject: &str,
        _include_versions: bool,
        note_filter: Option<&HashSet<String>>,
    ) -> Result<SubjectBundle> {
        log::info!("collect_subject_bundle 开始查询学科 {} 的笔记", subject);

        let mut notes_stmt = conn.prepare(
            "SELECT id, title, content_md, tags, created_at, updated_at, COALESCE(is_favorite, 0)
             FROM notes
             WHERE subject = ?1 AND deleted_at IS NULL
             ORDER BY datetime(updated_at) DESC",
        ).map_err(|e| AppError::database(format!("准备笔记查询失败: {}", e)))?;

        log::info!("笔记查询SQL准备完成");

        let rows = notes_stmt
            .query_map([subject], |row| {
                let id: String = row.get(0)?;
                let title: String = row.get(1)?;
                let content_md: String = row.get(2)?;
                let tags_json: String = row.get(3)?;
                let created_at: String = row.get(4)?;
                let updated_at: String = row.get(5)?;
                let is_favorite: i64 = row.get(6)?;
                let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
                Ok((
                    id,
                    title,
                    content_md,
                    tags,
                    created_at,
                    updated_at,
                    is_favorite != 0,
                ))
            })
            .map_err(|e| AppError::database(format!("遍历笔记失败: {}", e)))?;

        log::info!("开始遍历笔记查询结果");

        let mut notes: Vec<ExportNote> = Vec::new();
        let mut note_ids: HashSet<String> = HashSet::new();
        for (idx, row) in rows.enumerate() {
            let (id, title, content_md, tags, created_at, updated_at, is_favorite) =
                row.map_err(|e| AppError::database(e.to_string()))?;
            if let Some(filter) = note_filter {
                if !filter.contains(&id) {
                    continue;
                }
            }
            note_ids.insert(id.clone());
            notes.push(ExportNote {
                id: id.clone(),
                title: title.clone(),
                content_md,
                tags,
                created_at,
                updated_at,
                is_favorite,
                attachments: Vec::new(),
            });
            if (idx + 1) % 10 == 0 {
                log::info!("已读取 {} 条笔记", idx + 1);
            }
        }

        log::info!("笔记遍历完成，共 {} 条", notes.len());

        if notes.is_empty() {
            log::info!("学科 {} 没有笔记，返回空bundle", subject);
            return Ok(SubjectBundle::default());
        }

        log::info!("开始查询附件");

        let mut asset_stmt = conn
            .prepare(
                "SELECT note_id, path, size, mime
             FROM assets
             WHERE subject = ?1",
            )
            .map_err(|e| AppError::database(format!("准备附件查询失败: {}", e)))?;

        log::info!("附件查询SQL准备完成");

        let asset_rows = asset_stmt
            .query_map([subject], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| AppError::database(format!("遍历附件失败: {}", e)))?;
        let mut attachments_per_note: HashMap<String, Vec<ExportAttachment>> = HashMap::new();
        let mut attachment_payloads: Vec<ExportAttachmentInternal> = Vec::new();
        let assets_root = self.file_manager.get_writable_app_data_dir();

        log::info!("开始遍历附件记录，资源根目录：{}", assets_root.display());
        let mut attachment_count = 0;
        for (idx, row) in asset_rows.enumerate() {
            let (note_id, stored_path, size, mime) =
                row.map_err(|e| AppError::database(e.to_string()))?;
            if !note_ids.contains(&note_id) {
                continue;
            }
            if stored_path.trim().is_empty() {
                continue;
            }
            let relative_path = Path::new(&stored_path);
            if is_path_traversal(relative_path) {
                log::warn!("跳过可能越界的附件路径: {}", stored_path);
                continue;
            }
            let disk_path = assets_root.join(relative_path);

            if (idx + 1) % 5 == 0 {
                log::info!("正在读取第 {} 个附件: {}", idx + 1, disk_path.display());
            }

            let bytes = match fs::read(&disk_path) {
                Ok(buf) => {
                    log::info!(
                        "成功读取附件 ({} bytes): {}",
                        buf.len(),
                        disk_path.display()
                    );
                    buf
                }
                Err(err) => {
                    log::warn!("读取附件失败 ({}): {}", disk_path.to_string_lossy(), err);
                    continue;
                }
            };
            attachment_count += 1;
            let normalized_path = strip_notes_assets_prefix(relative_path)
                .unwrap_or_else(|| relative_path.to_path_buf());
            let relative_string = normalized_path
                .iter()
                .map(|c| c.to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let record = ExportAttachment {
                relative_path: relative_string,
                mime: mime.clone(),
                size,
            };
            attachments_per_note
                .entry(note_id.clone())
                .or_default()
                .push(record);
            attachment_payloads.push(ExportAttachmentInternal {
                relative_path: normalized_path,
                bytes,
            });
        }
        log::info!("附件处理完成，共读取 {} 个附件文件", attachment_count);

        // 写附件信息回笔记
        for note in notes.iter_mut() {
            if let Some(list) = attachments_per_note.remove(&note.id) {
                note.attachments = list;
            }
        }

        log::info!("附件信息已关联到笔记");

        // 版本历史已移除，返回空列表
        let versions: Vec<ExportVersion> = Vec::new();

        log::info!("开始收集偏好设置");
        let preferences = self.collect_preferences(conn, subject)?;
        log::info!("偏好设置收集完成，共 {} 项", preferences.len());

        log::info!("SubjectBundle 构建完成");
        Ok(SubjectBundle {
            notes,
            attachments: attachment_payloads,
            versions,
            preferences,
        })
    }

    fn collect_preferences(
        &self,
        conn: &rusqlite::Connection,
        subject: &str,
    ) -> Result<BTreeMap<String, Value>> {
        const PREF_PREFIXES: &[&str] = &[
            "notes_folders",
            "notes_tree_state",
            "notes_tabs",
            "notes_find_flags",
        ];
        log::info!("collect_preferences 开始，学科：{}", subject);
        let mut out: BTreeMap<String, Value> = BTreeMap::new();
        for (idx, prefix) in PREF_PREFIXES.iter().enumerate() {
            let key = format!("{}:{}", prefix, subject);
            let full_key = format!("notes.pref.{}", key);
            log::info!(
                "正在读取偏好 {}/{}: {}",
                idx + 1,
                PREF_PREFIXES.len(),
                full_key
            );

            // 直接使用传入的连接，避免再次获取锁导致死锁
            use rusqlite::OptionalExtension;
            let stored = match conn
                .query_row(
                    "SELECT value FROM settings WHERE key = ?1",
                    [&full_key],
                    |row| row.get::<_, String>(0),
                )
                .optional()
            {
                Ok(Some(v)) => {
                    log::info!("成功读取偏好 {}，长度：{} 字符", key, v.len());
                    v
                }
                Ok(None) => {
                    log::info!("偏好 {} 不存在，跳过", key);
                    continue;
                }
                Err(e) => {
                    log::warn!("查询偏好 {} 失败: {}", key, e);
                    continue;
                }
            };
            if stored.trim().is_empty() {
                log::info!("偏好 {} 为空，跳过", key);
                continue;
            }
            log::info!("解析偏好 {} 的JSON数据", key);
            match serde_json::from_str::<Value>(&stored) {
                Ok(value) => {
                    log::info!("成功解析偏好 {} 为JSON", key);
                    out.insert(key, value);
                }
                Err(err) => {
                    log::warn!("解析偏好 {} 的JSON失败: {}，存储原始数据", key, err);
                    out.insert(key, json!({ "raw": stored }));
                }
            }
        }
        log::info!("collect_preferences 完成，共收集 {} 个偏好", out.len());
        Ok(out)
    }

    fn collect_all_notes_bundle_vfs(
        &self,
        vfs_db: &Arc<VfsDatabase>,
        _include_versions: bool,
        note_filter: Option<&HashSet<String>>,
    ) -> Result<SubjectBundle> {
        log::info!("collect_all_notes_bundle_vfs 开始查询所有笔记");

        let vfs_conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        let notes = VfsNoteRepo::list_notes_with_conn(&vfs_conn, None, 1_000_000, 0)
            .map_err(|e| AppError::database(format!("VFS 查询笔记失败: {}", e)))?;

        let mut export_notes: Vec<ExportNote> = Vec::new();
        let mut note_ids: HashSet<String> = HashSet::new();
        for note in notes {
            if let Some(filter) = note_filter {
                if !filter.contains(&note.id) {
                    continue;
                }
            }
            let content_md = VfsNoteRepo::get_note_content_with_conn(&vfs_conn, &note.id)
                .ok()
                .flatten()
                .unwrap_or_default();
            note_ids.insert(note.id.clone());
            export_notes.push(ExportNote {
                id: note.id,
                title: note.title,
                content_md,
                tags: note.tags,
                created_at: note.created_at,
                updated_at: note.updated_at,
                is_favorite: note.is_favorite,
                attachments: Vec::new(),
            });
        }

        if export_notes.is_empty() {
            return Ok(SubjectBundle::default());
        }

        // 读取附件（仍使用旧 assets 表，避免破坏现有资产存储）
        let conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;
        let mut asset_stmt = conn
            .prepare("SELECT note_id, path, size, mime FROM assets")
            .map_err(|e| AppError::database(format!("准备附件查询失败: {}", e)))?;
        let asset_rows = asset_stmt
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| AppError::database(format!("遍历附件失败: {}", e)))?;

        let mut attachments: Vec<ExportAttachmentInternal> = Vec::new();
        for row in asset_rows {
            let (note_id, path_str, _size, _mime) =
                row.map_err(|e| AppError::database(e.to_string()))?;
            if !note_ids.contains(&note_id) {
                continue;
            }
            let abs_path = self.file_manager.get_app_data_dir().join(&path_str);
            if abs_path.exists() {
                if let Ok(bytes) = std::fs::read(&abs_path) {
                    attachments.push(ExportAttachmentInternal {
                        relative_path: PathBuf::from(&path_str),
                        bytes,
                    });
                }
            }
        }

        // 版本历史已移除，返回空列表
        let versions: Vec<ExportVersion> = Vec::new();

        let preferences = self.collect_all_preferences(&conn)?;

        Ok(SubjectBundle {
            notes: export_notes,
            attachments,
            versions,
            preferences,
        })
    }
}

#[derive(Default)]
struct SubjectBundle {
    notes: Vec<ExportNote>,
    attachments: Vec<ExportAttachmentInternal>,
    versions: Vec<ExportVersion>,
    preferences: BTreeMap<String, Value>,
}

#[derive(Clone)]
struct ExportAttachmentInternal {
    relative_path: PathBuf,
    bytes: Vec<u8>,
}

#[derive(Clone)]
struct BundleAttachment {
    relative_path: PathBuf,
    absolute_path: PathBuf,
    size: Option<i64>,
    mime: Option<String>,
}

fn serialize_ndjson<T: Serialize>(items: &[T]) -> Result<Vec<u8>> {
    let mut buffer = Vec::new();
    for item in items {
        serde_json::to_writer(&mut buffer, item)
            .map_err(|e| AppError::internal(format!("序列化导出数据失败: {}", e)))?;
        buffer.push(b'\n');
    }
    Ok(buffer)
}

fn slugify_subject(subject: &str) -> String {
    let mut out = String::with_capacity(subject.len());
    for ch in subject.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
        } else if ch == ' ' || ch == '-' || ch == '_' {
            if !out.ends_with('_') {
                out.push('_');
            }
        } else if ch.is_ascii() {
            if !out.ends_with('_') {
                out.push('_');
            }
        } else {
            out.push('_');
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.is_empty() {
        "subject".to_string()
    } else {
        trimmed
    }
}

fn sanitize_pref_key(key: &str) -> String {
    key.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect::<String>()
}

fn sanitize_filename(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for ch in name.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == ' ' {
            out.push(ch);
        } else if ch.is_whitespace() {
            if !out.ends_with('_') {
                out.push('_');
            }
        } else if !ch.is_ascii() {
            out.push(ch); // 保留非 ASCII 字符（中文等）
        } else {
            if !out.ends_with('_') {
                out.push('_');
            }
        }
    }
    let trimmed = out.trim_matches('_').to_string();
    if trimmed.len() > 100 {
        trimmed[..100].to_string()
    } else {
        trimmed
    }
}

fn strip_notes_assets_prefix(path: &Path) -> Option<PathBuf> {
    let mut components = path.components();
    match (components.next(), components.next()) {
        (Some(Component::Normal(first)), Some(Component::Normal(_second)))
            if first == "notes_assets" =>
        {
            Some(components.collect())
        }
        _ => None,
    }
}

fn is_path_traversal(path: &Path) -> bool {
    path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
}

fn rewrite_content_paths_for_export(content: &str, subject: &str, subject_slug: &str) -> String {
    let mut result = content.replace(
        &format!("notes_assets/{}/", subject),
        &format!("assets/{}/", subject_slug),
    );
    let backslash_prefix = format!("notes_assets\\{}\\", subject);
    if result.contains(&backslash_prefix) {
        result = result.replace(
            &backslash_prefix,
            &format!("assets/{}{}", subject_slug, "/"),
        );
    }
    result
}

fn rewrite_content_paths_for_import(content: &str, subject: &str, subject_slug: &str) -> String {
    let mut result = content.replace(
        &format!("assets/{}/", subject_slug),
        &format!("notes_assets/{}/", subject),
    );
    let backslash_prefix = format!("assets\\{}\\", subject_slug);
    if result.contains(&backslash_prefix) {
        result = result.replace(
            &backslash_prefix,
            &format!("notes_assets/{}{}", subject, "/"),
        );
    }
    result
}

fn build_folder_paths(
    subject: &str,
    note_ids: &HashSet<String>,
    preferences: &BTreeMap<String, Value>,
) -> HashMap<String, String> {
    let pref_key = format!("notes_folders:{}", subject);
    let pref_value = preferences.get(&pref_key).or_else(|| {
        preferences
            .iter()
            .find(|(k, _)| k.starts_with("notes_folders"))
            .map(|(_, v)| v)
    });

    let mut result: HashMap<String, String> = HashMap::new();
    let Some(Value::Object(obj)) = pref_value else {
        return result;
    };

    let folders_value = obj.get("folders").and_then(|v| v.as_object());
    let root_children = obj
        .get("rootChildren")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut folders: HashMap<String, (String, Vec<String>)> = HashMap::new();
    if let Some(folders_obj) = folders_value {
        for (folder_id, raw_folder) in folders_obj.iter() {
            if let Value::Object(folder_obj) = raw_folder {
                let title = folder_obj
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名文件夹")
                    .to_string();
                let children = folder_obj
                    .get("children")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect::<Vec<String>>()
                    })
                    .unwrap_or_default();
                folders.insert(folder_id.clone(), (title, children));
            }
        }
    }

    fn dfs(
        current: &str,
        prefix: &[String],
        folders: &HashMap<String, (String, Vec<String>)>,
        note_ids: &HashSet<String>,
        visited: &mut HashSet<String>,
        out: &mut HashMap<String, String>,
    ) {
        if !visited.insert(current.to_string()) {
            return;
        }

        if let Some((title, children)) = folders.get(current) {
            let mut new_prefix = prefix.to_vec();
            let sanitized = sanitize_filename(title);
            if !sanitized.is_empty() {
                new_prefix.push(sanitized);
            }
            for child in children {
                dfs(child, &new_prefix, folders, note_ids, visited, out);
            }
        } else if note_ids.contains(current) {
            let path = prefix.join("/");
            if !path.is_empty() {
                out.insert(current.to_string(), path);
            }
        }
    }

    let mut visited: HashSet<String> = HashSet::new();
    for child in root_children.iter().filter_map(|v| v.as_str()) {
        dfs(child, &[], &folders, note_ids, &mut visited, &mut result);
    }

    result
}

fn build_md_path(
    subject_slug: &str,
    folder_path: Option<&String>,
    safe_title: &str,
    id_prefix: &str,
) -> String {
    let mut segments: Vec<String> = Vec::new();
    segments.push(subject_slug.to_string());

    if let Some(path) = folder_path {
        if !path.is_empty() {
            for segment in path.split('/') {
                let sanitized = sanitize_filename(segment);
                if !sanitized.is_empty() {
                    segments.push(sanitized);
                }
            }
        }
    }

    let filename = if safe_title.is_empty() {
        format!("{}.md", id_prefix)
    } else {
        format!("{}_{}.md", safe_title, id_prefix)
    };
    segments.push(filename);

    segments.join("/")
}

fn build_folder_paths_flat(
    note_ids: &HashSet<String>,
    preferences: &BTreeMap<String, Value>,
) -> HashMap<String, String> {
    // 尝试找到任意 notes_folders 偏好设置
    let pref_value = preferences
        .iter()
        .find(|(k, _)| k.contains("notes_folders") || k.contains("notes.pref"))
        .map(|(_, v)| v);

    let mut result: HashMap<String, String> = HashMap::new();
    let Some(Value::Object(obj)) = pref_value else {
        return result;
    };

    let folders_value = obj.get("folders").and_then(|v| v.as_object());
    let root_children = obj
        .get("rootChildren")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut folders: HashMap<String, (String, Vec<String>)> = HashMap::new();
    if let Some(folders_obj) = folders_value {
        for (folder_id, raw_folder) in folders_obj.iter() {
            if let Value::Object(folder_obj) = raw_folder {
                let title = folder_obj
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("未命名文件夹")
                    .to_string();
                let children = folder_obj
                    .get("children")
                    .and_then(|v| v.as_array())
                    .map(|arr| {
                        arr.iter()
                            .filter_map(|v| v.as_str().map(|s| s.to_string()))
                            .collect::<Vec<String>>()
                    })
                    .unwrap_or_default();
                folders.insert(folder_id.clone(), (title, children));
            }
        }
    }

    fn dfs_flat(
        current: &str,
        prefix: &[String],
        folders: &HashMap<String, (String, Vec<String>)>,
        note_ids: &HashSet<String>,
        visited: &mut HashSet<String>,
        out: &mut HashMap<String, String>,
    ) {
        if !visited.insert(current.to_string()) {
            return;
        }

        if let Some((title, children)) = folders.get(current) {
            let mut new_prefix = prefix.to_vec();
            let sanitized = sanitize_filename(title);
            if !sanitized.is_empty() {
                new_prefix.push(sanitized);
            }
            for child in children {
                dfs_flat(child, &new_prefix, folders, note_ids, visited, out);
            }
        } else if note_ids.contains(current) {
            let path = prefix.join("/");
            if !path.is_empty() {
                out.insert(current.to_string(), path);
            }
        }
    }

    let mut visited: HashSet<String> = HashSet::new();
    for child in root_children.iter().filter_map(|v| v.as_str()) {
        dfs_flat(child, &[], &folders, note_ids, &mut visited, &mut result);
    }

    result
}

fn build_md_path_flat(folder_path: Option<&String>, safe_title: &str, id_prefix: &str) -> String {
    let mut segments: Vec<String> = vec!["notes".to_string()];

    if let Some(path) = folder_path {
        if !path.is_empty() {
            for segment in path.split('/') {
                let sanitized = sanitize_filename(segment);
                if !sanitized.is_empty() {
                    segments.push(sanitized);
                }
            }
        }
    }

    let filename = if safe_title.is_empty() {
        format!("{}.md", id_prefix)
    } else {
        format!("{}_{}.md", safe_title, id_prefix)
    };
    segments.push(filename);

    segments.join("/")
}

fn build_folder_pref(note_folder_map: &HashMap<String, Option<String>>) -> Value {
    #[derive(Clone)]
    struct Folder {
        title: String,
    }

    let mut folders: HashMap<String, Folder> = HashMap::new();
    let mut children_map: HashMap<String, Vec<String>> = HashMap::new();

    for (note_id, folder_path) in note_folder_map.iter() {
        let mut parent_key = "root".to_string();
        if let Some(path) = folder_path {
            let segments: Vec<&str> = path
                .split('/')
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect();
            let mut accum: Vec<String> = Vec::new();
            for segment in segments {
                accum.push(segment.to_string());
                let folder_key = format!("folder_{}", accum.join("_").replace(' ', "_"));
                folders.entry(folder_key.clone()).or_insert(Folder {
                    title: segment.to_string(),
                });
                let siblings = children_map.entry(parent_key.clone()).or_default();
                if !siblings.contains(&folder_key) {
                    siblings.push(folder_key.clone());
                }
                parent_key = folder_key;
            }
        }
        let siblings = children_map.entry(parent_key).or_default();
        if !siblings.contains(note_id) {
            siblings.push(note_id.clone());
        }
    }

    let folders_value = folders
        .iter()
        .map(|(id, folder)| {
            let children = children_map.get(id).cloned().unwrap_or_default();
            (
                id.clone(),
                json!({
                    "title": folder.title,
                    "children": children
                }),
            )
        })
        .collect::<serde_json::Map<String, Value>>();

    let root_children = children_map.get("root").cloned().unwrap_or_default();

    json!({
        "folders": folders_value,
        "rootChildren": root_children
    })
}

// ==================== 导入功能 ====================

/// 导入冲突策略
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportConflictStrategy {
    /// 跳过已存在的笔记（默认）
    #[default]
    Skip,
    /// 覆盖已存在的笔记
    Overwrite,
    /// 合并：保留本地更新时间更新的内容
    MergeKeepNewer,
}

/// 导入选项
#[derive(Clone, Default)]
pub struct ImportOptions {
    /// 冲突策略
    pub conflict_strategy: ImportConflictStrategy,
    /// 进度回调
    pub progress_callback: Option<Arc<dyn Fn(ImportProgress) + Send + Sync>>,
}

impl std::fmt::Debug for ImportOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ImportOptions")
            .field("conflict_strategy", &self.conflict_strategy)
            .field(
                "progress_callback",
                &self.progress_callback.as_ref().map(|_| "<callback>"),
            )
            .finish()
    }
}

/// 导入进度
#[derive(Debug, Clone, Serialize)]
pub struct ImportProgress {
    /// 当前阶段
    pub stage: ImportStage,
    /// 当前进度 (0-100)
    pub progress: u8,
    /// 当前处理的项目描述
    pub current_item: Option<String>,
    /// 已处理数量
    pub processed: usize,
    /// 总数量
    pub total: usize,
}

/// 导入阶段
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportStage {
    /// 解析归档文件
    Parsing,
    /// 导入笔记
    ImportingNotes,
    /// 导入附件
    ImportingAttachments,
    /// 导入偏好设置
    ImportingPreferences,
    /// 完成
    Done,
}

pub struct NotesImporter {
    db: Arc<Database>,
    file_manager: Arc<FileManager>,
    vfs_db: Option<Arc<VfsDatabase>>,
}

#[derive(Debug, Serialize)]
pub struct ImportSummary {
    pub subject_count: usize,
    pub note_count: usize,
    pub attachment_count: usize,
    pub skipped_count: usize,
    pub overwritten_count: usize,
}

impl NotesImporter {
    pub fn new(db: Arc<Database>, file_manager: Arc<FileManager>) -> Self {
        Self {
            db,
            file_manager,
            vfs_db: None,
        }
    }

    pub fn new_with_vfs(
        db: Arc<Database>,
        file_manager: Arc<FileManager>,
        vfs_db: Option<Arc<VfsDatabase>>,
    ) -> Self {
        Self {
            db,
            file_manager,
            vfs_db,
        }
    }

    /// 使用默认选项导入
    pub fn import(&self, file_path: PathBuf) -> Result<ImportSummary> {
        self.import_with_options(file_path, ImportOptions::default())
    }

    /// 使用指定选项导入
    pub fn import_with_options(
        &self,
        file_path: PathBuf,
        options: ImportOptions,
    ) -> Result<ImportSummary> {
        log::info!(
            "开始导入笔记库，文件：{}，冲突策略：{:?}",
            file_path.display(),
            options.conflict_strategy
        );

        if !file_path.exists() {
            return Err(AppError::validation("导入文件不存在"));
        }

        // 报告解析阶段
        Self::report_progress(
            &options,
            ImportProgress {
                stage: ImportStage::Parsing,
                progress: 0,
                current_item: Some("正在解析归档文件...".to_string()),
                processed: 0,
                total: 0,
            },
        );

        let file = fs::File::open(&file_path)
            .map_err(|e| AppError::file_system(format!("打开导入文件失败: {}", e)))?;

        let mut zip = zip::ZipArchive::new(file)
            .map_err(|e| AppError::file_system(format!("读取归档文件失败: {}", e)))?;

        log::info!("ZIP归档打开成功，共 {} 个文件", zip.len());

        // 检测导入格式：尝试读取 manifest.json 并检查 schema_version
        let manifest_result: Option<(u32, Manifest)> =
            zip.by_name("manifest.json").ok().and_then(|mut f| {
                let mut content = String::new();
                f.read_to_string(&mut content).ok()?;
                let manifest: Manifest = serde_json::from_str(&content).ok()?;
                Some((manifest.schema_version, manifest))
            });

        match manifest_result {
            Some((version, manifest)) if version >= 2 => {
                // 新的统一 ZIP 格式（schema_version >= 2）
                log::info!("检测到统一 ZIP 格式备份（schema_version: {}）", version);
                self.import_unified_zip_with_options(zip, manifest, options)
            }
            Some((version, _)) => {
                // 旧版格式不再支持（subject 概念已废弃）
                Err(AppError::validation(format!(
                    "不支持的备份格式版本: {}，请使用新版本导出后重新导入",
                    version
                )))
            }
            None => {
                // 无 manifest.json，尝试作为纯 Markdown 格式导入
                log::info!("未找到 manifest.json，尝试作为 Markdown 格式导入");
                self.import_markdown_with_options(zip, options)
            }
        }
    }

    /// 报告进度
    fn report_progress(options: &ImportOptions, progress: ImportProgress) {
        if let Some(ref callback) = options.progress_callback {
            callback(progress);
        }
    }

    /// 导入统一 ZIP 格式（schema_version >= 2）
    fn import_unified_zip_with_options(
        &self,
        mut zip: zip::ZipArchive<fs::File>,
        manifest: Manifest,
        options: ImportOptions,
    ) -> Result<ImportSummary> {
        log::info!("开始导入统一 ZIP 格式备份");

        // ★ P0 修复：VFS 模式下使用 VFS 写入路径，确保导入的笔记在 UI 中可见
        if let Some(ref vfs_db) = self.vfs_db {
            return self.import_unified_zip_vfs(zip, manifest, options, vfs_db);
        }

        log::info!("Manifest 解析成功，备份包含 {} 条笔记", manifest.note_count);

        let mut conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        // 使用事务保证原子性
        let tx = conn
            .transaction()
            .map_err(|e| AppError::database(format!("创建事务失败: {}", e)))?;

        let mut total_notes = 0usize;
        let mut total_attachments = 0usize;
        let mut skipped = 0usize;
        let mut overwritten = 0usize;

        // 用于附件回滚清理的路径列表
        let mut written_attachment_paths: Vec<PathBuf> = Vec::new();

        // subject 已废弃，不再按学科分组
        let mut note_ids: HashSet<String> = HashSet::new();
        let mut folder_paths: HashMap<String, Option<String>> = HashMap::new();

        // 用于跟踪导入的学科数量（现已废弃，始终为 0）
        let _subjects_count = 0usize;

        // 先统计需要导入的笔记数量
        let mut md_file_indices: Vec<usize> = Vec::new();
        for i in 0..zip.len() {
            if let Ok(file) = zip.by_index(i) {
                let file_name = file.name().to_string();
                if !file_name.ends_with(".md")
                    || file_name == "README.md"
                    || file_name.contains("/_versions/")
                    || file.is_dir()
                {
                    continue;
                }
                let path_parts: Vec<&str> = file_name.split('/').collect();
                if path_parts.len() >= 2 {
                    md_file_indices.push(i);
                }
            }
        }
        let total_md_files = md_file_indices.len();
        let mut processed_notes = 0usize;

        Self::report_progress(
            &options,
            ImportProgress {
                stage: ImportStage::ImportingNotes,
                progress: 0,
                current_item: Some(format!("准备导入 {} 条笔记...", total_md_files)),
                processed: 0,
                total: total_md_files,
            },
        );

        for i in 0..zip.len() {
            let mut file = match zip.by_index(i) {
                Ok(f) => f,
                Err(e) => {
                    log::warn!("读取归档文件索引 {} 失败: {}", i, e);
                    continue;
                }
            };

            let file_name = file.name().to_string();

            // 跳过特殊目录和非 .md 文件
            if file_name == "README.md"
                || !file_name.ends_with(".md")
                || file_name.contains("/_versions/")
                || file.is_dir()
            {
                continue;
            }

            // 解析路径：notes/folder/title_id.md (subject 已废弃)
            let path_parts: Vec<&str> = file_name.split('/').collect();
            if path_parts.len() < 2 {
                continue;
            }

            let path_slug = path_parts[0];

            // 读取文件内容
            let mut content = String::new();
            if let Err(e) = file.read_to_string(&mut content) {
                log::warn!("读取文件 {} 失败: {}", file_name, e);
                continue;
            }

            // 解析 Markdown 文件
            let (mut metadata, note_content) = self.parse_markdown_export(&content)?;

            // subject 已废弃，设置为空字符串
            metadata.subject = String::new();

            let normalized_content = rewrite_content_paths_for_import(&note_content, "", path_slug);

            // 报告进度
            processed_notes += 1;
            Self::report_progress(
                &options,
                ImportProgress {
                    stage: ImportStage::ImportingNotes,
                    progress: ((processed_notes as f64 / total_md_files.max(1) as f64) * 50.0)
                        as u8,
                    current_item: Some(metadata.title.clone()),
                    processed: processed_notes,
                    total: total_md_files,
                },
            );

            // 检查笔记是否存在及其状态
            let existing_note: Option<(bool, String)> = tx
                .query_row(
                    "SELECT deleted_at IS NULL, updated_at FROM notes WHERE id = ?1",
                    [&metadata.id],
                    |row| Ok((row.get::<_, bool>(0)?, row.get::<_, String>(1)?)),
                )
                .ok();

            match existing_note {
                Some((is_active, local_updated_at)) => {
                    if is_active {
                        // 笔记存在且未被删除，根据冲突策略处理
                        match options.conflict_strategy {
                            ImportConflictStrategy::Skip => {
                                log::info!("笔记 {} 已存在且未被删除，跳过", metadata.id);
                                skipped += 1;
                                continue;
                            }
                            ImportConflictStrategy::Overwrite => {
                                log::info!("笔记 {} 已存在，覆盖", metadata.id);
                                tx.execute(
                                    "UPDATE notes SET subject = ?2, title = ?3, content_md = ?4, tags = ?5,
                                     created_at = ?6, updated_at = ?7, is_favorite = ?8
                                     WHERE id = ?1",
                                    rusqlite::params![
                                        &metadata.id,
                                        &metadata.subject,
                                        &metadata.title,
                                        &normalized_content,
                                        serde_json::to_string(&metadata.tags).unwrap_or_else(|_| "[]".to_string()),
                                        &metadata.created_at,
                                        &metadata.updated_at,
                                        if metadata.is_favorite { 1 } else { 0 },
                                    ],
                                ).map_err(|e| AppError::database(format!("覆盖笔记失败: {}", e)))?;
                                overwritten += 1;
                                total_notes += 1;
                            }
                            ImportConflictStrategy::MergeKeepNewer => {
                                // 比较更新时间，保留更新的版本
                                if metadata.updated_at > local_updated_at {
                                    log::info!("笔记 {} 导入版本更新，覆盖本地", metadata.id);
                                    tx.execute(
                                        "UPDATE notes SET subject = ?2, title = ?3, content_md = ?4, tags = ?5,
                                         created_at = ?6, updated_at = ?7, is_favorite = ?8
                                         WHERE id = ?1",
                                        rusqlite::params![
                                            &metadata.id,
                                            &metadata.subject,
                                            &metadata.title,
                                            &normalized_content,
                                            serde_json::to_string(&metadata.tags).unwrap_or_else(|_| "[]".to_string()),
                                            &metadata.created_at,
                                            &metadata.updated_at,
                                            if metadata.is_favorite { 1 } else { 0 },
                                        ],
                                    ).map_err(|e| AppError::database(format!("合并笔记失败: {}", e)))?;
                                    overwritten += 1;
                                    total_notes += 1;
                                } else {
                                    log::info!("笔记 {} 本地版本更新，跳过", metadata.id);
                                    skipped += 1;
                                    continue;
                                }
                            }
                        }
                    } else {
                        // 笔记已被删除，恢复它
                        log::info!("笔记 {} 已被删除，正在恢复", metadata.id);
                        tx.execute(
                            "UPDATE notes SET subject = ?2, title = ?3, content_md = ?4, tags = ?5,
                             created_at = ?6, updated_at = ?7, is_favorite = ?8, deleted_at = NULL
                             WHERE id = ?1",
                            rusqlite::params![
                                &metadata.id,
                                &metadata.subject,
                                &metadata.title,
                                &normalized_content,
                                serde_json::to_string(&metadata.tags)
                                    .unwrap_or_else(|_| "[]".to_string()),
                                &metadata.created_at,
                                &metadata.updated_at,
                                if metadata.is_favorite { 1 } else { 0 },
                            ],
                        )
                        .map_err(|e| AppError::database(format!("恢复笔记失败: {}", e)))?;
                        total_notes += 1;
                    }
                }
                None => {
                    tx.execute(
                        "INSERT INTO notes (id, subject, title, content_md, tags, created_at, updated_at, is_favorite, deleted_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)",
                        rusqlite::params![
                            &metadata.id,
                            &metadata.subject,
                            &metadata.title,
                            &normalized_content,
                            serde_json::to_string(&metadata.tags).unwrap_or_else(|_| "[]".to_string()),
                            &metadata.created_at,
                            &metadata.updated_at,
                            if metadata.is_favorite { 1 } else { 0 },
                        ],
                    ).map_err(|e| AppError::database(format!("插入笔记失败: {}", e)))?;
                    total_notes += 1;
                }
            }

            // 记录笔记 ID 和文件夹路径（不再按学科分组）
            note_ids.insert(metadata.id.clone());
            folder_paths.insert(metadata.id.clone(), metadata.folder_path.clone());
        }

        // 导入附件
        let assets_base_dir = self.file_manager.get_writable_app_data_dir();
        // 统计附件数量
        let mut asset_file_count = 0usize;
        for i in 0..zip.len() {
            if let Ok(file) = zip.by_index(i) {
                let file_name = file.name().to_string();
                if file_name.starts_with("assets/") && !file.is_dir() {
                    asset_file_count += 1;
                }
            }
        }
        let mut processed_attachments = 0usize;

        Self::report_progress(
            &options,
            ImportProgress {
                stage: ImportStage::ImportingAttachments,
                progress: 50,
                current_item: Some(format!("准备导入 {} 个附件...", asset_file_count)),
                processed: 0,
                total: asset_file_count,
            },
        );

        for i in 0..zip.len() {
            let mut file = match zip.by_index(i) {
                Ok(f) => f,
                Err(_) => continue,
            };

            let file_name = file.name().to_string();

            if !file_name.starts_with("assets/") || file.is_dir() {
                continue;
            }

            let path_after_assets = file_name.strip_prefix("assets/").unwrap_or("");
            let parts: Vec<&str> = path_after_assets.split('/').collect();
            if parts.len() < 2 {
                continue;
            }

            let subject_slug = parts[0];
            let relative_in_subject = parts[1..].join("/");

            // subject 已废弃，使用空字符串
            let subject = String::new();

            let mut bytes = Vec::new();
            if let Err(e) = file.read_to_end(&mut bytes) {
                log::warn!("读取附件 {} 失败: {}", file_name, e);
                continue;
            }

            let relative_path = format!("notes_assets/{}/{}", subject_slug, relative_in_subject);
            let disk_path = assets_base_dir.join(&relative_path);

            if let Some(parent) = disk_path.parent() {
                fs::create_dir_all(parent).ok();
            }

            if fs::write(&disk_path, &bytes).is_ok() {
                // 记录已写入的附件路径，用于错误回滚
                written_attachment_paths.push(disk_path.clone());

                // 尝试关联到笔记（不再按学科分组）
                let guessed_note_id = relative_in_subject.split('/').next().map(|s| s.to_string());
                if let Some(note_id) = guessed_note_id.as_ref().and_then(|id| {
                    if note_ids.contains(id) {
                        Some(id.clone())
                    } else {
                        None
                    }
                }) {
                    tx.execute(
                        "INSERT OR IGNORE INTO assets (subject, note_id, path, size, mime, created_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                        rusqlite::params![
                            &subject,
                            &note_id,
                            &relative_path,
                            bytes.len() as i64,
                            Option::<String>::None,
                            Utc::now().to_rfc3339(),
                        ],
                    ).ok();
                }
                total_attachments += 1;
            }

            // 报告进度
            processed_attachments += 1;
            Self::report_progress(
                &options,
                ImportProgress {
                    stage: ImportStage::ImportingAttachments,
                    progress: 50
                        + ((processed_attachments as f64 / asset_file_count.max(1) as f64) * 40.0)
                            as u8,
                    current_item: Some(relative_in_subject.clone()),
                    processed: processed_attachments,
                    total: asset_file_count,
                },
            );
        }

        Self::report_progress(
            &options,
            ImportProgress {
                stage: ImportStage::ImportingPreferences,
                progress: 90,
                current_item: Some("正在导入偏好设置...".to_string()),
                processed: 0,
                total: 0,
            },
        );

        // 导入偏好设置（从 manifest.preferences）
        for pref in manifest.preferences.iter() {
            if let Ok(mut file) = zip.by_name(&pref.file) {
                let mut content = String::new();
                if file.read_to_string(&mut content).is_ok() {
                    let full_key = format!("notes.pref.{}", pref.key);
                    tx.execute(
                        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                        rusqlite::params![full_key, content, Utc::now().to_rfc3339()],
                    ).ok();
                    log::info!("导入偏好设置：{}", pref.key);
                }
            }
        }

        // 重建文件夹偏好设置（subject 已废弃，使用全局设置）
        if !folder_paths.is_empty() {
            let pref_value = build_folder_pref(&folder_paths);
            let key = "notes.pref.notes_folders".to_string();
            let serialized = serde_json::to_string(&pref_value).unwrap_or_default();
            tx.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![key, serialized, Utc::now().to_rfc3339()],
            )
            .ok();
        }

        // 提交事务
        if let Err(e) = tx.commit() {
            // 事务失败，清理已写入的附件文件
            log::error!("提交事务失败: {}，开始清理已写入的附件文件", e);
            Self::cleanup_written_attachments(&written_attachment_paths);
            return Err(AppError::database(format!("提交事务失败: {}", e)));
        }

        Self::report_progress(
            &options,
            ImportProgress {
                stage: ImportStage::Done,
                progress: 100,
                current_item: None,
                processed: total_notes,
                total: total_notes,
            },
        );

        log::info!(
            "统一 ZIP 格式导入完成！笔记数：{}，附件数：{}，跳过：{}，覆盖：{}",
            total_notes,
            total_attachments,
            skipped,
            overwritten
        );

        Ok(ImportSummary {
            subject_count: 0, // subject 已废弃
            note_count: total_notes,
            attachment_count: total_attachments,
            skipped_count: skipped,
            overwritten_count: overwritten,
        })
    }

    /// 清理已写入的附件文件（用于事务回滚时）
    fn cleanup_written_attachments(paths: &[PathBuf]) {
        for path in paths {
            if path.exists() {
                if let Err(e) = fs::remove_file(path) {
                    log::warn!("清理附件文件失败: {} - {}", path.display(), e);
                } else {
                    log::info!("已清理附件文件: {}", path.display());
                }
            }
        }
    }

    // 旧版 AIMN 格式导入已删除（subject 概念已废弃，严禁向后兼容）

    /// ★ P0 修复：VFS 模式下的统一 ZIP 导入
    ///
    /// 将笔记写入 VFS 数据库（notes 表 + resources 表），确保导入的笔记在 UI 中可见。
    /// 旧版导入仅写入旧版 notes 表，但读取链路已迁移到 VFS，导致导入数据不可见。
    fn import_unified_zip_vfs(
        &self,
        mut zip: zip::ZipArchive<fs::File>,
        manifest: Manifest,
        options: ImportOptions,
        vfs_db: &Arc<VfsDatabase>,
    ) -> Result<ImportSummary> {
        log::info!(
            "[VFS Import] 开始 VFS 模式导入，备份包含 {} 条笔记",
            manifest.note_count
        );

        let vfs_conn = vfs_db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取 VFS 连接失败: {}", e)))?;

        let mut total_notes = 0usize;
        let mut total_attachments = 0usize;
        let mut skipped = 0usize;
        let mut overwritten = 0usize;
        let mut written_attachment_paths: Vec<PathBuf> = Vec::new();
        let mut note_ids: HashSet<String> = HashSet::new();
        let mut folder_paths: HashMap<String, Option<String>> = HashMap::new();

        // 统计 MD 文件数量
        let mut total_md_files = 0usize;
        for i in 0..zip.len() {
            if let Ok(file) = zip.by_index(i) {
                let file_name = file.name().to_string();
                if !file_name.ends_with(".md")
                    || file_name == "README.md"
                    || file_name.contains("/_versions/")
                    || file.is_dir()
                {
                    continue;
                }
                let path_parts: Vec<&str> = file_name.split('/').collect();
                if path_parts.len() >= 2 {
                    total_md_files += 1;
                }
            }
        }
        let mut processed_notes = 0usize;

        Self::report_progress(
            &options,
            ImportProgress {
                stage: ImportStage::ImportingNotes,
                progress: 0,
                current_item: Some(format!("准备导入 {} 条笔记（VFS 模式）...", total_md_files)),
                processed: 0,
                total: total_md_files,
            },
        );

        for i in 0..zip.len() {
            let mut file = match zip.by_index(i) {
                Ok(f) => f,
                Err(e) => {
                    log::warn!("读取归档文件索引 {} 失败: {}", i, e);
                    continue;
                }
            };

            let file_name = file.name().to_string();

            if file_name == "README.md"
                || !file_name.ends_with(".md")
                || file_name.contains("/_versions/")
                || file.is_dir()
            {
                continue;
            }

            let path_parts: Vec<&str> = file_name.split('/').collect();
            if path_parts.len() < 2 {
                continue;
            }

            let path_slug = path_parts[0];

            let mut content = String::new();
            if let Err(e) = file.read_to_string(&mut content) {
                log::warn!("读取文件 {} 失败: {}", file_name, e);
                continue;
            }

            let (metadata, note_content) = self.parse_markdown_export(&content)?;
            let normalized_content = rewrite_content_paths_for_import(&note_content, "", path_slug);

            processed_notes += 1;
            Self::report_progress(
                &options,
                ImportProgress {
                    stage: ImportStage::ImportingNotes,
                    progress: ((processed_notes as f64 / total_md_files.max(1) as f64) * 50.0)
                        as u8,
                    current_item: Some(metadata.title.clone()),
                    processed: processed_notes,
                    total: total_md_files,
                },
            );

            // 检查 VFS 中是否已存在该笔记
            let existing_vfs_note = VfsNoteRepo::get_note_with_conn(&vfs_conn, &metadata.id)
                .ok()
                .flatten();

            // 跟踪实际使用的笔记 ID（新建时 VFS 会生成新 ID）
            let final_note_id: String;

            match existing_vfs_note {
                Some(_existing) => {
                    // 笔记已存在，根据冲突策略处理
                    match options.conflict_strategy {
                        ImportConflictStrategy::Skip => {
                            log::info!("[VFS Import] 笔记 {} 已存在，跳过", metadata.id);
                            skipped += 1;
                            continue;
                        }
                        ImportConflictStrategy::Overwrite
                        | ImportConflictStrategy::MergeKeepNewer => {
                            // 覆盖或合并：更新 VFS 笔记
                            log::info!("[VFS Import] 笔记 {} 已存在，覆盖", metadata.id);
                            let update_params = VfsUpdateNoteParams {
                                title: Some(metadata.title.clone()),
                                content: Some(normalized_content.clone()),
                                tags: Some(metadata.tags.clone()),
                                expected_updated_at: None,
                            };
                            match VfsNoteRepo::update_note_with_conn(
                                &vfs_conn,
                                &metadata.id,
                                update_params,
                            ) {
                                Ok(_) => {
                                    overwritten += 1;
                                    total_notes += 1;
                                    final_note_id = metadata.id.clone();
                                }
                                Err(e) => {
                                    log::warn!("[VFS Import] 更新笔记 {} 失败: {}", metadata.id, e);
                                    continue;
                                }
                            }
                        }
                    }
                }
                None => {
                    // 笔记不存在，创建新笔记
                    let create_params = VfsCreateNoteParams {
                        title: metadata.title.clone(),
                        content: normalized_content.clone(),
                        tags: metadata.tags.clone(),
                    };
                    match VfsNoteRepo::create_note_with_conn(&vfs_conn, create_params) {
                        Ok(vfs_note) => {
                            log::info!("[VFS Import] 创建笔记: {} -> {}", metadata.id, vfs_note.id);
                            total_notes += 1;
                            final_note_id = vfs_note.id;
                        }
                        Err(e) => {
                            log::warn!("[VFS Import] 创建笔记 {} 失败: {}", metadata.id, e);
                            continue;
                        }
                    }
                }
            }

            note_ids.insert(final_note_id.clone());
            folder_paths.insert(final_note_id, metadata.folder_path.clone());
        }

        // 导入附件到磁盘（附件存储路径与 VFS/Legacy 无关，都是文件系统）
        let assets_base_dir = self.file_manager.get_writable_app_data_dir();
        let mut asset_file_count = 0usize;
        for i in 0..zip.len() {
            if let Ok(file) = zip.by_index(i) {
                let file_name = file.name().to_string();
                if file_name.starts_with("assets/") && !file.is_dir() {
                    asset_file_count += 1;
                }
            }
        }
        let mut processed_attachments = 0usize;

        Self::report_progress(
            &options,
            ImportProgress {
                stage: ImportStage::ImportingAttachments,
                progress: 50,
                current_item: Some(format!("准备导入 {} 个附件...", asset_file_count)),
                processed: 0,
                total: asset_file_count,
            },
        );

        for i in 0..zip.len() {
            let mut file = match zip.by_index(i) {
                Ok(f) => f,
                Err(_) => continue,
            };

            let file_name = file.name().to_string();

            if !file_name.starts_with("assets/") || file.is_dir() {
                continue;
            }

            let path_after_assets = file_name.strip_prefix("assets/").unwrap_or("");
            let parts: Vec<&str> = path_after_assets.split('/').collect();
            if parts.len() < 2 {
                continue;
            }

            let subject_slug = parts[0];
            let relative_in_subject = parts[1..].join("/");

            let mut bytes = Vec::new();
            if let Err(e) = file.read_to_end(&mut bytes) {
                log::warn!("读取附件 {} 失败: {}", file_name, e);
                continue;
            }

            let relative_path = format!("notes_assets/{}/{}", subject_slug, relative_in_subject);
            let disk_path = assets_base_dir.join(&relative_path);

            if let Some(parent) = disk_path.parent() {
                fs::create_dir_all(parent).ok();
            }

            if fs::write(&disk_path, &bytes).is_ok() {
                written_attachment_paths.push(disk_path.clone());
                total_attachments += 1;
            }

            processed_attachments += 1;
            Self::report_progress(
                &options,
                ImportProgress {
                    stage: ImportStage::ImportingAttachments,
                    progress: 50
                        + ((processed_attachments as f64 / asset_file_count.max(1) as f64) * 40.0)
                            as u8,
                    current_item: Some(relative_in_subject.clone()),
                    processed: processed_attachments,
                    total: asset_file_count,
                },
            );
        }

        // 导入偏好设置（写入旧 DB 的 settings 表，偏好设置不在 VFS 中）
        if let Ok(legacy_conn) = self.db.get_conn_safe() {
            for pref in manifest.preferences.iter() {
                if let Ok(mut file) = zip.by_name(&pref.file) {
                    let mut pref_content = String::new();
                    if file.read_to_string(&mut pref_content).is_ok() {
                        let full_key = format!("notes.pref.{}", pref.key);
                        legacy_conn
                            .execute(
                                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                                rusqlite::params![full_key, pref_content, Utc::now().to_rfc3339()],
                            )
                            .ok();
                        log::info!("[VFS Import] 导入偏好设置：{}", pref.key);
                    }
                }
            }

            // 重建文件夹偏好设置
            if !folder_paths.is_empty() {
                let pref_value = build_folder_pref(&folder_paths);
                let key = "notes.pref.notes_folders".to_string();
                let serialized = serde_json::to_string(&pref_value).unwrap_or_default();
                legacy_conn
                    .execute(
                        "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                        rusqlite::params![key, serialized, Utc::now().to_rfc3339()],
                    )
                    .ok();
            }
        }

        Self::report_progress(
            &options,
            ImportProgress {
                stage: ImportStage::Done,
                progress: 100,
                current_item: None,
                processed: total_notes,
                total: total_notes,
            },
        );

        log::info!(
            "[VFS Import] 导入完成！笔记数：{}，附件数：{}，跳过：{}，覆盖：{}",
            total_notes,
            total_attachments,
            skipped,
            overwritten
        );

        Ok(ImportSummary {
            subject_count: 0,
            note_count: total_notes,
            attachment_count: total_attachments,
            skipped_count: skipped,
            overwritten_count: overwritten,
        })
    }

    fn import_markdown_with_options(
        &self,
        mut zip: zip::ZipArchive<fs::File>,
        _options: ImportOptions,
    ) -> Result<ImportSummary> {
        log::info!("开始导入 Markdown 格式备份");

        let mut conn = self
            .db
            .get_conn_safe()
            .map_err(|e| AppError::database(format!("获取数据库连接失败: {}", e)))?;

        // 使用事务保证原子性
        let tx = conn
            .transaction()
            .map_err(|e| AppError::database(format!("创建事务失败: {}", e)))?;

        let mut total_notes = 0usize;
        let mut total_attachments = 0usize;
        let mut skipped = 0usize;
        let mut subjects_found: HashSet<String> = HashSet::new();
        let mut note_ids_by_subject: HashMap<String, HashSet<String>> = HashMap::new();
        let mut folder_paths_by_subject: HashMap<String, HashMap<String, Option<String>>> =
            HashMap::new();

        // 第一遍：收集所有学科 slug 到真实学科名的映射
        let mut slug_to_subject: HashMap<String, String> = HashMap::new();

        for i in 0..zip.len() {
            let mut file = zip.by_index(i).map_err(|e| {
                AppError::file_system(format!("读取归档文件索引 {} 失败: {}", i, e))
            })?;

            let file_name = file.name().to_string();

            // 只处理 .md 文件
            if !file_name.ends_with(".md") || file_name == "README.md" || file.is_dir() {
                continue;
            }

            let path_parts: Vec<&str> = file_name.split('/').collect();
            if path_parts.len() < 2 {
                continue;
            }

            let subject_slug = path_parts[0];

            // 如果已经处理过这个 slug，跳过
            if slug_to_subject.contains_key(subject_slug) {
                continue;
            }

            // 读取文件内容并解析学科名
            let mut content = String::new();
            file.read_to_string(&mut content).map_err(|e| {
                AppError::file_system(format!("读取文件 {} 失败: {}", file_name, e))
            })?;

            // 从文件名推断学科名：尝试从已有数据库中查找匹配的学科
            // 如果找不到，就使用 slug 本身
            let real_subject = self
                .try_resolve_subject_from_slug(&tx, subject_slug)?
                .unwrap_or_else(|| subject_slug.to_string());

            slug_to_subject.insert(subject_slug.to_string(), real_subject);
        }

        log::info!("学科映射表：{:?}", slug_to_subject);

        // 第二遍：导入笔记
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).map_err(|e| {
                AppError::file_system(format!("读取归档文件索引 {} 失败: {}", i, e))
            })?;

            let file_name = file.name().to_string();

            // 跳过 README.md 和非 .md 文件
            if file_name == "README.md" || !file_name.ends_with(".md") {
                continue;
            }

            // 跳过目录
            if file.is_dir() {
                continue;
            }

            log::info!("处理 Markdown 文件: {}", file_name);

            // 解析路径：应该是 subject_slug/filename.md 格式
            let path_parts: Vec<&str> = file_name.split('/').collect();
            if path_parts.len() < 2 {
                log::warn!("跳过格式不正确的文件: {}", file_name);
                continue;
            }

            let subject_slug = path_parts[0];

            // 读取文件内容
            let mut content = String::new();
            file.read_to_string(&mut content).map_err(|e| {
                AppError::file_system(format!("读取文件 {} 失败: {}", file_name, e))
            })?;

            // 解析 Markdown 文件，提取元数据和内容
            let (mut metadata, note_content) = self.parse_markdown_export(&content)?;

            // 使用映射表获取真实的学科名
            metadata.subject = slug_to_subject
                .get(subject_slug)
                .cloned()
                .unwrap_or_else(|| subject_slug.to_string());

            subjects_found.insert(metadata.subject.clone());
            let normalized_content =
                rewrite_content_paths_for_import(&note_content, &metadata.subject, subject_slug);

            // 检查笔记是否存在且未被删除
            let note_status: Option<bool> = tx
                .query_row(
                    "SELECT deleted_at IS NULL FROM notes WHERE id = ?1",
                    [&metadata.id],
                    |row| row.get(0),
                )
                .ok();

            match note_status {
                Some(true) => {
                    // 笔记存在且未被删除，跳过
                    log::info!("笔记 {} 已存在且未被删除，跳过", metadata.id);
                    skipped += 1;
                    continue;
                }
                Some(false) => {
                    // 笔记存在但已被删除，恢复它
                    log::info!("笔记 {} 已被删除，正在恢复", metadata.id);
                    tx.execute(
                        "UPDATE notes SET subject = ?2, title = ?3, content_md = ?4, tags = ?5,
                         created_at = ?6, updated_at = ?7, is_favorite = ?8, deleted_at = NULL
                         WHERE id = ?1",
                        rusqlite::params![
                            &metadata.id,
                            &metadata.subject,
                            &metadata.title,
                            &normalized_content,
                            serde_json::to_string(&metadata.tags)
                                .unwrap_or_else(|_| "[]".to_string()),
                            &metadata.created_at,
                            &metadata.updated_at,
                            if metadata.is_favorite { 1 } else { 0 },
                        ],
                    )
                    .map_err(|e| AppError::database(format!("恢复笔记失败: {}", e)))?;
                    total_notes += 1;
                    log::info!(
                        "成功恢复笔记: {} ({}) 到学科: {}",
                        metadata.title,
                        metadata.id,
                        metadata.subject
                    );
                }
                None => {
                    // 笔记不存在，插入新笔记
                    tx.execute(
                        "INSERT INTO notes (id, subject, title, content_md, tags, created_at, updated_at, is_favorite, deleted_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL)",
                        rusqlite::params![
                            &metadata.id,
                            &metadata.subject,
                            &metadata.title,
                            &normalized_content,
                            serde_json::to_string(&metadata.tags).unwrap_or_else(|_| "[]".to_string()),
                            &metadata.created_at,
                            &metadata.updated_at,
                            if metadata.is_favorite { 1 } else { 0 },
                        ],
                    ).map_err(|e| AppError::database(format!("插入笔记失败: {}", e)))?;
                    total_notes += 1;
                    log::info!(
                        "成功导入笔记: {} ({}) 到学科: {}",
                        metadata.title,
                        metadata.id,
                        metadata.subject
                    );
                }
            }

            note_ids_by_subject
                .entry(metadata.subject.clone())
                .or_default()
                .insert(metadata.id.clone());

            folder_paths_by_subject
                .entry(metadata.subject.clone())
                .or_default()
                .insert(metadata.id.clone(), metadata.folder_path.clone());
        }

        // 导入附件
        let assets_base_dir = self.file_manager.get_writable_app_data_dir();
        for i in 0..zip.len() {
            let mut file = zip.by_index(i).map_err(|e| {
                AppError::file_system(format!("读取归档文件索引 {} 失败: {}", i, e))
            })?;

            let file_name = file.name().to_string();

            // 只处理 assets/ 目录下的文件
            if !file_name.starts_with("assets/") || file.is_dir() {
                continue;
            }

            log::info!("处理附件: {}", file_name);

            // 解析路径：assets/subject_slug/...
            let path_after_assets = file_name.strip_prefix("assets/").unwrap_or("");
            let parts: Vec<&str> = path_after_assets.split('/').collect();
            if parts.len() < 2 {
                log::warn!("跳过格式不正确的附件: {}", file_name);
                continue;
            }

            let subject_slug = parts[0];
            let relative_in_subject = parts[1..].join("/");

            // 尝试从 subject_slug 恢复 subject 名称
            // 这里我们需要从已知的 subjects_found 中匹配
            let subject = subjects_found
                .iter()
                .find(|s| slugify_subject(s) == subject_slug)
                .cloned()
                .unwrap_or_else(|| subject_slug.to_string());

            // 读取附件内容
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).map_err(|e| {
                AppError::file_system(format!("读取附件 {} 失败: {}", file_name, e))
            })?;

            // 保存附件到磁盘
            let relative_path = format!("notes_assets/{}/{}", subject, relative_in_subject);
            let disk_path = assets_base_dir.join(&relative_path);

            if let Some(parent) = disk_path.parent() {
                fs::create_dir_all(parent)
                    .map_err(|e| AppError::file_system(format!("创建附件目录失败: {}", e)))?;
            }

            fs::write(&disk_path, &bytes)
                .map_err(|e| AppError::file_system(format!("写入附件失败: {}", e)))?;

            // 记录数据库 assets（最佳努力推断 note_id）
            let guessed_note_id = relative_in_subject.split('/').next().map(|s| s.to_string());
            if let Some(note_id) = guessed_note_id.as_ref().and_then(|id| {
                note_ids_by_subject.get(&subject).and_then(|set| {
                    if set.contains(id) {
                        Some(id.clone())
                    } else {
                        None
                    }
                })
            }) {
                tx.execute(
                    "INSERT OR IGNORE INTO assets (subject, note_id, path, size, mime, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    rusqlite::params![
                        &subject,
                        &note_id,
                        &relative_path,
                        bytes.len() as i64,
                        Option::<String>::None,
                        Utc::now().to_rfc3339(),
                    ],
                )
                .map_err(|e| AppError::database(format!("插入附件记录失败: {}", e)))?;
            } else {
                log::info!(
                    "附件未能关联到具体笔记（已写入文件系统）：{}",
                    relative_path
                );
            }

            total_attachments += 1;
            log::info!("成功保存附件: {}", relative_path);
        }

        // 重建文件夹偏好设置（基于 folder_path）
        for (subject, map) in folder_paths_by_subject.iter() {
            let pref_value = build_folder_pref(map);
            let key = format!("notes.pref.notes_folders:{}", subject);
            let serialized = serde_json::to_string(&pref_value)
                .map_err(|e| AppError::internal(e.to_string()))?;
            tx.execute(
                "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                rusqlite::params![key, serialized, Utc::now().to_rfc3339()],
            )
            .map_err(|e| AppError::database(format!("保存文件夹偏好失败: {}", e)))?;
        }

        // 提交事务
        tx.commit()
            .map_err(|e| AppError::database(format!("提交事务失败: {}", e)))?;

        log::info!(
            "Markdown 导入完成！学科数：{}，笔记数：{}，附件数：{}，跳过：{}",
            subjects_found.len(),
            total_notes,
            total_attachments,
            skipped
        );

        Ok(ImportSummary {
            subject_count: subjects_found.len(),
            note_count: total_notes,
            attachment_count: total_attachments,
            skipped_count: skipped,
            overwritten_count: 0, // Markdown 格式尚未实现冲突策略
        })
    }

    fn parse_markdown_export(&self, content: &str) -> Result<(MarkdownMetadata, String)> {
        // 规整化内容，去掉可能存在的 UTF-8 BOM
        let normalized_content = if let Some(rest) = content.strip_prefix('\u{feff}') {
            rest
        } else {
            content
        };

        let mut id = String::new();
        let mut created_at = String::new();
        let mut updated_at = String::new();
        let mut is_favorite = false;
        let mut tags: Vec<String> = Vec::new();
        let mut title = String::from("未命名笔记");
        let mut folder_path: Option<String> = None;

        let lines: Vec<&str> = normalized_content.lines().collect();
        let mut content_start_idx = 0;

        // 首先尝试解析 YAML Front Matter 格式（新格式）
        if lines.first().map(|l| l.trim()) == Some("---") {
            let mut in_frontmatter = true;
            let mut frontmatter_end_idx = 0;
            let mut in_tags_block = false;

            for (idx, line) in lines.iter().enumerate().skip(1) {
                let trimmed = line.trim();

                if trimmed == "---" {
                    // Front matter 结束
                    in_frontmatter = false;
                    frontmatter_end_idx = idx;
                    break;
                }

                // 解析 YAML 键值对或 tags 数组项
                if in_tags_block {
                    // 处理 tags:
                    if trimmed.starts_with('-') {
                        let mut value = trimmed.trim_start_matches('-').trim();
                        // 去除包裹引号
                        if (value.starts_with('"') && value.ends_with('"'))
                            || (value.starts_with('\'') && value.ends_with('\''))
                        {
                            value = &value[1..value.len().saturating_sub(1)];
                        }
                        if !value.is_empty() {
                            tags.push(value.to_string());
                        }
                        continue;
                    }
                    // 如果遇到非 '-' 开头，说明 tags 块结束，继续按键值解析
                    in_tags_block = false;
                }

                if let Some(colon_pos) = trimmed.find(':') {
                    let key = trimmed[..colon_pos].trim();
                    let mut value = trimmed[colon_pos + 1..].trim();
                    // 去除包裹引号
                    if (value.starts_with('"') && value.ends_with('"'))
                        || (value.starts_with('\'') && value.ends_with('\''))
                    {
                        value = &value[1..value.len().saturating_sub(1)];
                    }

                    match key {
                        "id" => id = value.to_string(),
                        "title" => title = value.to_string(),
                        "created" => created_at = value.to_string(),
                        "updated" => updated_at = value.to_string(),
                        "folder_path" => {
                            if !value.is_empty() {
                                folder_path = Some(value.to_string());
                            }
                        }
                        "favorite" => is_favorite = value == "true",
                        "tags" => {
                            // 进入多行数组块，后续以 '-' 开头的行作为 tag
                            in_tags_block = true;
                        }
                        _ => {
                            // 处理 tags 数组项
                            if key == "-" && !value.is_empty() {
                                tags.push(value.to_string());
                            }
                        }
                    }
                }
            }

            if !in_frontmatter {
                // 成功解析了 front matter，跳过它和后面的空行
                content_start_idx = frontmatter_end_idx + 1;

                // 跳过 front matter 后的空行
                while content_start_idx < lines.len() && lines[content_start_idx].trim().is_empty()
                {
                    content_start_idx += 1;
                }

                // 不再跳过后续的 H1 行，保留正文中的标题显示
            }
        } else {
            // 如果没有 YAML Front Matter，尝试解析旧格式的 HTML 注释
            for (idx, line) in lines.iter().enumerate() {
                let trimmed = line.trim();

                if trimmed.starts_with("<!-- Note ID:") {
                    id = trimmed
                        .strip_prefix("<!-- Note ID:")
                        .and_then(|s| s.strip_suffix("-->"))
                        .unwrap_or("")
                        .trim()
                        .to_string();
                } else if trimmed.starts_with("<!-- Created:") {
                    created_at = trimmed
                        .strip_prefix("<!-- Created:")
                        .and_then(|s| s.strip_suffix("-->"))
                        .unwrap_or("")
                        .trim()
                        .to_string();
                } else if trimmed.starts_with("<!-- Updated:") {
                    updated_at = trimmed
                        .strip_prefix("<!-- Updated:")
                        .and_then(|s| s.strip_suffix("-->"))
                        .unwrap_or("")
                        .trim()
                        .to_string();
                } else if trimmed.starts_with("<!-- Favorite:") {
                    let fav_str = trimmed
                        .strip_prefix("<!-- Favorite:")
                        .and_then(|s| s.strip_suffix("-->"))
                        .unwrap_or("")
                        .trim();
                    is_favorite = fav_str == "true";
                } else if trimmed.starts_with("<!-- Tags:") {
                    let tags_str = trimmed
                        .strip_prefix("<!-- Tags:")
                        .and_then(|s| s.strip_suffix("-->"))
                        .unwrap_or("")
                        .trim();
                    tags = tags_str
                        .split(',')
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty())
                        .collect();
                } else if trimmed.starts_with("# ") && !trimmed.starts_with("<!--") {
                    // 找到标题行，但不从正文中移除它
                    title = trimmed.strip_prefix("# ").unwrap_or(&title).to_string();
                    content_start_idx = idx; // 保留标题行
                    break;
                } else if !trimmed.starts_with("<!--") && !trimmed.is_empty() {
                    // 如果遇到非注释且非空行，停止解析元数据
                    content_start_idx = idx;
                    break;
                }
            }
        }

        // 验证必需字段
        if id.is_empty() {
            id = uuid::Uuid::new_v4().to_string();
            log::warn!("Markdown 文件缺少 Note ID，生成新 ID: {}", id);
        }

        if created_at.is_empty() {
            created_at = Utc::now().to_rfc3339();
        }

        if updated_at.is_empty() {
            updated_at = created_at.clone();
        }

        // 提取实际内容
        let note_content = if content_start_idx < lines.len() {
            lines[content_start_idx..].join("\n")
        } else {
            String::new()
        };

        // 从文件路径或内容推断 subject
        // 由于我们在调用处知道文件路径，这里暂时使用空字符串，调用处需要设置
        let subject = String::new();

        Ok((
            MarkdownMetadata {
                id,
                subject,
                title,
                tags,
                created_at,
                updated_at,
                is_favorite,
                folder_path,
            },
            note_content.trim().to_string(),
        ))
    }

    fn try_resolve_subject_from_slug(
        &self,
        conn: &rusqlite::Connection,
        slug: &str,
    ) -> Result<Option<String>> {
        // 尝试从数据库中找到匹配的学科
        // 1. 先查找完全匹配的学科
        let exact_match: Option<String> = conn
            .query_row(
                "SELECT DISTINCT subject FROM notes WHERE subject = ?1 LIMIT 1",
                [slug],
                |row| row.get(0),
            )
            .ok();

        if exact_match.is_some() {
            return Ok(exact_match);
        }

        // 2. 尝试查找 slugified 后匹配的学科
        let mut stmt = conn
            .prepare("SELECT DISTINCT subject FROM notes WHERE deleted_at IS NULL")
            .map_err(|e| AppError::database(format!("查询学科列表失败: {}", e)))?;

        let subjects = stmt
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|e| AppError::database(format!("遍历学科失败: {}", e)))?;

        for subject_result in subjects {
            let subject = subject_result.map_err(|e| AppError::database(e.to_string()))?;
            if slugify_subject(&subject) == slug {
                return Ok(Some(subject));
            }
        }

        Ok(None)
    }
}

#[derive(Debug)]
struct MarkdownMetadata {
    id: String,
    subject: String,
    title: String,
    tags: Vec<String>,
    created_at: String,
    updated_at: String,
    is_favorite: bool,
    folder_path: Option<String>,
}
