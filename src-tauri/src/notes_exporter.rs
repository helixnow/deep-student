use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use zip::write::FileOptions;

use crate::database::Database;
use crate::file_manager::FileManager;
use crate::models::AppError;
use crate::vfs::{VfsCreateNoteParams, VfsDatabase, VfsNoteRepo, VfsUpdateNoteParams};

type Result<T> = std::result::Result<T, AppError>;

const SCHEMA_VERSION: u32 = 2;

/// ★ 2026-07-19 硬化：导入时会整体读入内存的文本条目（.md 笔记、偏好 JSON、
/// manifest）单条上限。附件走流式落盘不受此限制；正常笔记远小于该值，
/// 超限条目视为异常归档（解压炸弹/损坏文件），跳过并告警。
const MAX_IMPORT_TEXT_BYTES: u64 = 64 * 1024 * 1024;

/// 导入进度事件的最大报告次数（每阶段）。超大归档按百分比步进上报，
/// 避免每个条目一条事件把前端事件通道打爆；小归档仍逐条上报。
const IMPORT_PROGRESS_MAX_REPORTS: usize = 200;

/// 进度节流：total 较小时逐条上报；较大时按步长上报（首条与末条必报）。
fn should_report_progress(processed: usize, total: usize) -> bool {
    if total <= IMPORT_PROGRESS_MAX_REPORTS {
        return true;
    }
    let step = total.div_ceil(IMPORT_PROGRESS_MAX_REPORTS).max(1);
    processed == 1 || processed == total || processed % step == 0
}

/// 统一的 ZIP 格式：Markdown 文件 + 完整元数据（版本历史、偏好设置）
/// 其他软件可以直接读取 .md 文件，忽略 _versions 和 _preferences 目录

pub struct NotesExporter {
    db: Arc<Database>,
    file_manager: Arc<FileManager>,
    vfs_db: Option<Arc<VfsDatabase>>,
}

#[derive(Debug, Clone)]
pub struct ExportOptions {
    /// ⚠️ 语义对齐（2026-07-19）：笔记版本历史表已在 VFS 迁移
    /// `V20260214__drop_notes_versions.sql` 中移除，此开关目前恒为空操作，
    /// 仅为前端契约向后兼容保留。manifest 的 `version_count` 恒为 0，
    /// README 不再宣称包含版本历史。
    pub include_versions: bool,
    pub output_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct SingleNoteExportOptions {
    pub note_id: String,
    /// ⚠️ 同 [`ExportOptions::include_versions`]：版本历史已移除，恒为空操作。
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
    /// 版本历史已移除（V20260214），新导出恒为 0；
    /// 字段保留用于反序列化旧备份的 manifest（default 兜底缺失字段）。
    #[serde(default)]
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
    /// ├── _preferences/               # 偏好设置
    /// │   └── {key}.json
    /// ├── assets/                     # 附件
    /// └── README.md
    ///
    /// 注：`_versions/` 目录已随版本历史功能移除（V20260214）不再产出，
    /// 导入侧仍会忽略旧备份中的该目录。
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
            "找到 {} 条笔记，{} 个附件",
            bundle.notes.len(),
            bundle.attachments.len()
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

        // 版本历史已随 V20260214 迁移移除：options.include_versions 恒为空操作
        // （见 ExportOptions 字段注释），不再产出 _versions/ 目录。

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
                // A6-23 + 2026-07-19 硬化：附件以 io::copy 流式写入 zip，
                // 单个大附件也不会整体驻留内存。
                let mut src = match fs::File::open(&attachment.absolute_path) {
                    Ok(f) => f,
                    Err(err) => {
                        log::warn!("读取附件失败，跳过 {}: {}", zip_entry, err);
                        continue;
                    }
                };
                zip.start_file(&zip_entry, file_options).map_err(|e| {
                    AppError::file_system(format!("写入附件 {} 失败: {}", zip_entry, e))
                })?;
                io::copy(&mut src, &mut zip).map_err(|e| {
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
            version_count: 0, // 版本历史已移除（V20260214），恒为 0
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
        // ★ 2026-07-19：版本历史功能已移除（V20260214），README 不再提及 `_versions/`。
        let readme = format!(
            "# 笔记导出\n\n\
            导出时间：{}\n\
            导出格式：统一 ZIP 格式（Markdown + 元数据）\n\
            笔记数量：{}\n\
            附件数量：{}\n\n\
            ## 目录结构\n\n\
            - `notes/` 目录：`.md` 笔记文件（YAML frontmatter + 正文）\n\
            - `_preferences/` 目录：偏好设置（可选）\n\
            - `assets/` 目录：附件文件（笔记正文中的 `notes_assets/<x>` 对应归档内 `assets/<x>`）\n\n\
            ## 跨软件兼容性\n\n\
            本备份格式兼容常见 Markdown 编辑器。\n\
            解压后即可查看笔记内容。\n\
            以下划线 `_` 开头的目录为应用专用元数据，可安全忽略。\n\
            ",
            Utc::now().format("%Y-%m-%d %H:%M:%S"),
            bundle.notes.len(),
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
        md_content.push_str(&format!("title: {}\n", yaml_quote(&note.title)));
        md_content.push_str(&format!("created: {}\n", note.created_at));
        md_content.push_str(&format!("updated: {}\n", note.updated_at));
        if note.is_favorite {
            md_content.push_str("favorite: true\n");
        }
        if let Some(fp) = folder_path {
            md_content.push_str(&format!("folder: {}\n", yaml_quote(fp)));
        }
        if !note.tags.is_empty() {
            md_content.push_str("tags:\n");
            for tag in note.tags.iter() {
                md_content.push_str(&format!("  - {}\n", yaml_quote(tag)));
            }
        }
        md_content.push_str("---\n\n");
        md_content.push_str(&note.content_md);
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
            let stored_path = Path::new(&path_str);
            if is_path_traversal(stored_path) {
                log::warn!("跳过可能越界的附件路径: {}", path_str);
                continue;
            }
            let abs_path = self.file_manager.get_app_data_dir().join(stored_path);
            if abs_path.exists() {
                // ★ 2026-07-19：剥离 notes_assets/ 前缀。此前 zip 条目为
                // assets/notes_assets/<subject>/...，导入侧会把 "notes_assets"
                // 误判为 subject slug，落盘成 notes_assets/notes_assets/...，
                // 导致附件引用断链。剥离后条目为 assets/<subject>/...，
                // 与 import_unified_zip* 的解析约定一致（round-trip 无损）。
                let normalized_path = strip_notes_assets_prefix(stored_path)
                    .unwrap_or_else(|| stored_path.to_path_buf());
                // A6-23: 不再在此读盘，改为 zip 写入时逐个流式读取
                attachments.push(ExportAttachmentInternal {
                    relative_path: normalized_path,
                    absolute_path: abs_path,
                });
            }
        }

        // 查询偏好设置
        let preferences = self.collect_all_preferences(conn)?;

        Ok(SubjectBundle {
            notes,
            attachments,
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

    // ★ 2026-07-19 遗留清理：render_markdown_note / render_version_markdown /
    // collect_subject_bundle / collect_preferences / build_folder_paths /
    // build_md_path / serialize_ndjson / rewrite_content_paths_for_export 等
    // 按 subject 分组的旧导出格式（schema_version < 2）产出链已整体删除，
    // 静态确认仓库内无调用方；导入侧仍保留对旧归档路径格式的解析兼容。

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
            // A6-23 + 2026-07-19 硬化：附件以 io::copy 流式写入 zip
            let mut src = match fs::File::open(&attachment.absolute_path) {
                Ok(f) => f,
                Err(err) => {
                    log::warn!("读取附件失败，跳过 {}: {}", zip_entry, err);
                    continue;
                }
            };
            zip.start_file(&zip_entry, file_options).map_err(|e| {
                AppError::file_system(format!("写入附件 {} 失败: {}", zip_entry, e))
            })?;
            io::copy(&mut src, &mut zip).map_err(|e| {
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
        zip.start_file(&md_filename, file_options)
            .map_err(|e| AppError::file_system(format!("写入笔记 {} 失败: {}", md_filename, e)))?;
        zip.write_all(md_content.as_bytes())
            .map_err(|e| AppError::file_system(format!("写入笔记 {} 失败: {}", md_filename, e)))?;

        // ★ 2026-07-19：版本历史已移除（V20260214），options.include_versions
        // 恒为空操作，不再产出 `_versions/` 目录。
        let readme = format!(
            "# 笔记导出\n\n\
            导出时间：{}\n\
            导出格式：统一 ZIP 格式（单条笔记）\n\
            笔记标题：{}\n\
            附件数量：{}\n\n\
            ## 目录结构\n\n\
            - `notes/` 目录：笔记文件\n\
            - `assets/` 目录：附件文件（笔记正文中的 `notes_assets/<x>` 对应归档内 `assets/<x>`）\n\n\
            ## 跨软件兼容性\n\n\
            本备份格式兼容常见 Markdown 编辑器。\n\
            ",
            Utc::now().format("%Y-%m-%d %H:%M:%S"),
            note.title,
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
            let stored_path = Path::new(&path_str);
            if is_path_traversal(stored_path) {
                log::warn!("跳过可能越界的附件路径: {}", path_str);
                continue;
            }
            let abs_path = self.file_manager.get_app_data_dir().join(stored_path);
            if abs_path.exists() {
                // ★ 2026-07-19：剥离 notes_assets/ 前缀，保证 zip 条目为
                // assets/<subject>/...，与导入侧解析约定一致（见
                // collect_all_notes_bundle 同款修复的详细说明）。
                let normalized_path = strip_notes_assets_prefix(stored_path)
                    .unwrap_or_else(|| stored_path.to_path_buf());
                // A6-23: 不再在此读盘，改为 zip 写入时逐个流式读取
                attachments.push(ExportAttachmentInternal {
                    relative_path: normalized_path,
                    absolute_path: abs_path,
                });
            }
        }

        let preferences = self.collect_all_preferences(&conn)?;

        Ok(SubjectBundle {
            notes: export_notes,
            attachments,
            preferences,
        })
    }
}

#[derive(Default)]
struct SubjectBundle {
    notes: Vec<ExportNote>,
    attachments: Vec<ExportAttachmentInternal>,
    preferences: BTreeMap<String, Value>,
}

#[derive(Clone)]
struct ExportAttachmentInternal {
    relative_path: PathBuf,
    /// A6-23: 只保存附件磁盘绝对路径，写入 zip 时再逐个读盘，避免一次性把所有附件字节载入内存。
    absolute_path: PathBuf,
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

fn yaml_quote(value: &str) -> String {
    if value.is_empty() {
        return "\"\"".to_string();
    }
    let needs_quoting = value.contains(':')
        || value.contains('#')
        || value.contains('{')
        || value.contains('}')
        || value.contains('[')
        || value.contains(']')
        || value.contains('\'')
        || value.contains('"')
        || value.contains('&')
        || value.contains('*')
        || value.contains('!')
        || value.contains('|')
        || value.contains('>')
        || value.contains('%')
        || value.contains('@')
        || value.contains('`')
        || value.starts_with(' ')
        || value.ends_with(' ')
        || value.starts_with('-')
        || value.starts_with('?');
    if needs_quoting {
        let escaped = value.replace('\\', r"\\").replace('"', r#"\""#);
        format!("\"{}\"", escaped)
    } else {
        value.to_string()
    }
}

fn strip_yaml_quotes(s: &str) -> String {
    let trimmed = s.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        let inner = &trimmed[1..trimmed.len() - 1];
        return inner.replace(r#"\""#, "\"").replace(r"\\", "\\");
    }
    trimmed.to_string()
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
        let mut end = 100;
        while !trimmed.is_char_boundary(end) && end > 0 {
            end -= 1;
        }
        trimmed[..end].to_string()
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
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}

/// ★ 审阅 14 P0-1：归档相对路径穿越检测（导入侧）。
/// 统一 `/` 与 `\`，拒绝绝对路径、盘符前缀、`..` 分段与空段。
fn is_unsafe_archive_relative(path: &str) -> bool {
    let normalized = path.replace('\\', "/");
    if normalized.is_empty() {
        return true;
    }
    // Windows 盘符（C:/...）或 UNC 风格（//server/...）
    if normalized.starts_with('/') || normalized.starts_with("//") {
        return true;
    }
    if let Some(first) = normalized.split('/').next() {
        if first.len() >= 2 && first.as_bytes().get(1) == Some(&b':') {
            return true;
        }
    }
    let as_path = Path::new(&normalized);
    if is_path_traversal(as_path) {
        return true;
    }
    // 显式拒绝空段（`a//b`）与纯 `.` 段以外的异常
    for segment in normalized.split('/') {
        if segment.is_empty() || segment == ".." {
            return true;
        }
    }
    false
}

/// ★ 审阅 14 P0-1：在 `base` 下安全拼接相对路径；越界返回 None。
/// 落盘前用组件归一化保证结果位于 base 内（不依赖 canonicalize，因目标可能尚不存在）。
fn resolve_safe_path_under(base: &Path, relative: &str) -> Option<PathBuf> {
    if is_unsafe_archive_relative(relative) {
        return None;
    }
    let mut resolved = base.to_path_buf();
    for component in Path::new(&relative.replace('\\', "/")).components() {
        match component {
            Component::Normal(part) => resolved.push(part),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return None;
            }
        }
    }
    // 组件拼接后必须仍以 base 为前缀（防止 join 行为异常）
    if !resolved.starts_with(base) {
        return None;
    }
    Some(resolved)
}

/// ★ 审阅 14 P0-1：导入附件写盘前的统一校验入口。
fn resolve_import_attachment_disk_path(
    assets_base_dir: &Path,
    relative_path: &str,
) -> Option<PathBuf> {
    let notes_assets_root = assets_base_dir.join("notes_assets");
    // relative_path 形如 notes_assets/<subject>/...
    let under_notes = relative_path
        .strip_prefix("notes_assets/")
        .or_else(|| relative_path.strip_prefix("notes_assets\\"))?;
    if is_unsafe_archive_relative(under_notes) {
        return None;
    }
    let disk_path = resolve_safe_path_under(&notes_assets_root, under_notes)?;
    // 再校验完整路径仍在 app data 根内
    if !disk_path.starts_with(assets_base_dir) {
        return None;
    }
    Some(disk_path)
}

/// ★ 2026-07-19 硬化：把 zip 条目流式写入磁盘（io::copy），返回写入字节数。
/// 大附件不再整体读入内存；写入失败时尽力清理半成品文件。
fn write_zip_entry_to_disk<R: Read>(entry: &mut R, disk_path: &Path) -> io::Result<u64> {
    if let Some(parent) = disk_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut out = fs::File::create(disk_path)?;
    match io::copy(entry, &mut out) {
        Ok(written) => Ok(written),
        Err(e) => {
            drop(out);
            let _ = fs::remove_file(disk_path);
            Err(e)
        }
    }
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

fn build_folder_paths_flat(
    note_ids: &HashSet<String>,
    preferences: &BTreeMap<String, Value>,
) -> HashMap<String, String> {
    build_folder_paths_core(note_ids, preferences)
}

fn build_folder_paths_core(
    note_ids: &HashSet<String>,
    preferences: &BTreeMap<String, Value>,
) -> HashMap<String, String> {
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
                // ★ 2026-07-19 硬化：manifest 声明尺寸超限视为损坏/恶意归档
                if f.size() > MAX_IMPORT_TEXT_BYTES {
                    log::warn!("manifest.json 声明尺寸异常（{} 字节），忽略", f.size());
                    return None;
                }
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

            // ★ 2026-07-19 硬化：.md 条目整体读入内存，声明尺寸超限直接跳过
            if file.size() > MAX_IMPORT_TEXT_BYTES {
                log::warn!(
                    "跳过异常大笔记条目 {}（声明 {} 字节）",
                    file_name,
                    file.size()
                );
                continue;
            }

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

            // 报告进度（大归档按百分比步进节流，避免事件风暴）
            processed_notes += 1;
            if should_report_progress(processed_notes, total_md_files) {
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
            }

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
            // ★ 审阅 14 P0-1：条目名穿越校验（拒绝 ../、绝对路径、盘符、反斜杠变体）
            if is_unsafe_archive_relative(path_after_assets) {
                log::warn!("[notes_import] 跳过越界附件条目: {}", file_name);
                continue;
            }
            let mut parts: Vec<&str> = path_after_assets.split('/').collect();
            // ★ 2026-07-19 向后兼容：历史版本导出的条目为
            // assets/notes_assets/<subject>/...（双前缀，未剥离 notes_assets），
            // 此处去掉多余的 notes_assets 段，恢复正确的磁盘相对路径。
            if parts.first() == Some(&"notes_assets") && parts.len() >= 3 {
                parts.remove(0);
            }
            if parts.len() < 2 {
                continue;
            }

            let subject_slug = parts[0];
            let relative_in_subject = parts[1..].join("/");

            // subject 已废弃，使用空字符串
            let subject = String::new();

            let relative_path = format!("notes_assets/{}/{}", subject_slug, relative_in_subject);
            let Some(disk_path) =
                resolve_import_attachment_disk_path(&assets_base_dir, &relative_path)
            else {
                log::warn!(
                    "[notes_import] 跳过越界附件落盘路径: {} -> {}",
                    file_name,
                    relative_path
                );
                continue;
            };

            // ★ 2026-07-19 硬化：附件流式落盘（io::copy），大附件不再整体读入内存
            match write_zip_entry_to_disk(&mut file, &disk_path) {
                Ok(written_bytes) => {
                    // 记录已写入的附件路径，用于错误回滚
                    written_attachment_paths.push(disk_path.clone());

                    // 尝试关联到笔记（不再按学科分组）
                    let guessed_note_id =
                        relative_in_subject.split('/').next().map(|s| s.to_string());
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
                                written_bytes as i64,
                                Option::<String>::None,
                                Utc::now().to_rfc3339(),
                            ],
                        ).ok();
                    }
                    total_attachments += 1;
                }
                Err(e) => {
                    log::warn!("写入附件 {} 失败: {}", file_name, e);
                }
            }

            // 报告进度（节流）
            processed_attachments += 1;
            if should_report_progress(processed_attachments, asset_file_count) {
                Self::report_progress(
                    &options,
                    ImportProgress {
                        stage: ImportStage::ImportingAttachments,
                        progress: 50
                            + ((processed_attachments as f64 / asset_file_count.max(1) as f64)
                                * 40.0) as u8,
                        current_item: Some(relative_in_subject.clone()),
                        processed: processed_attachments,
                        total: asset_file_count,
                    },
                );
            }
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
                if file.size() > MAX_IMPORT_TEXT_BYTES {
                    log::warn!(
                        "跳过异常大偏好条目 {}（声明 {} 字节）",
                        pref.file,
                        file.size()
                    );
                    continue;
                }
                let mut content = String::new();
                if file.read_to_string(&mut content).is_ok() {
                    let full_key = format!("notes.pref.{}", pref.key);
                    tx.execute(
                        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
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
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
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

            // ★ 2026-07-19 硬化：.md 条目整体读入内存，声明尺寸超限直接跳过
            if file.size() > MAX_IMPORT_TEXT_BYTES {
                log::warn!(
                    "[VFS Import] 跳过异常大笔记条目 {}（声明 {} 字节）",
                    file_name,
                    file.size()
                );
                continue;
            }

            let mut content = String::new();
            if let Err(e) = file.read_to_string(&mut content) {
                log::warn!("读取文件 {} 失败: {}", file_name, e);
                continue;
            }

            let (metadata, note_content) = self.parse_markdown_export(&content)?;
            let normalized_content = rewrite_content_paths_for_import(&note_content, "", path_slug);

            processed_notes += 1;
            if should_report_progress(processed_notes, total_md_files) {
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
            }

            // 检查 VFS 中是否已存在该笔记
            let existing_vfs_note = VfsNoteRepo::get_note_with_conn(&vfs_conn, &metadata.id)
                .ok()
                .flatten();

            // 跟踪实际使用的笔记 ID（新建时 VFS 会生成新 ID）
            let final_note_id: String;
            // ★ 2026-07-19 元数据完整性：frontmatter 的 favorite 此前在 VFS
            // 导入中被丢弃（VfsCreate/UpdateNoteParams 不含该字段）。记录
            // 期望值，写入成功后用既有 set_favorite_with_conn 补齐（仅在与
            // 现状不一致时调用，避免无谓刷新 updated_at）。
            let mut favorite_sync: Option<bool> = None;

            match existing_vfs_note {
                Some(existing) => {
                    let existing_favorite = existing.is_favorite;
                    match options.conflict_strategy {
                        ImportConflictStrategy::Skip => {
                            log::info!("[VFS Import] 笔记 {} 已存在，跳过", metadata.id);
                            skipped += 1;
                            continue;
                        }
                        ImportConflictStrategy::MergeKeepNewer => {
                            if metadata.updated_at <= existing.updated_at {
                                log::info!(
                                    "[VFS Import] 笔记 {} 本地版本更新（local={}, import={}），跳过",
                                    metadata.id, existing.updated_at, metadata.updated_at
                                );
                                skipped += 1;
                                continue;
                            }
                            log::info!("[VFS Import] 笔记 {} 导入版本更新，覆盖本地", metadata.id);
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
                                    if existing_favorite != metadata.is_favorite {
                                        favorite_sync = Some(metadata.is_favorite);
                                    }
                                }
                                Err(e) => {
                                    log::warn!("[VFS Import] 合并笔记 {} 失败: {}", metadata.id, e);
                                    continue;
                                }
                            }
                        }
                        ImportConflictStrategy::Overwrite => {
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
                                    if existing_favorite != metadata.is_favorite {
                                        favorite_sync = Some(metadata.is_favorite);
                                    }
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
                            if metadata.is_favorite {
                                favorite_sync = Some(true);
                            }
                        }
                        Err(e) => {
                            log::warn!("[VFS Import] 创建笔记 {} 失败: {}", metadata.id, e);
                            continue;
                        }
                    }
                }
            }

            if let Some(want_favorite) = favorite_sync {
                if let Err(e) =
                    VfsNoteRepo::set_favorite_with_conn(&vfs_conn, &final_note_id, want_favorite)
                {
                    log::warn!("[VFS Import] 同步收藏状态失败 {}: {}", final_note_id, e);
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
            // ★ 审阅 14 P0-1：条目名穿越校验
            if is_unsafe_archive_relative(path_after_assets) {
                log::warn!("[notes_import] 跳过越界附件条目: {}", file_name);
                continue;
            }
            let mut parts: Vec<&str> = path_after_assets.split('/').collect();
            // ★ 2026-07-19 向后兼容：历史版本导出的条目为
            // assets/notes_assets/<subject>/...（双前缀），去掉多余段。
            if parts.first() == Some(&"notes_assets") && parts.len() >= 3 {
                parts.remove(0);
            }
            if parts.len() < 2 {
                continue;
            }

            let subject_slug = parts[0];
            let relative_in_subject = parts[1..].join("/");

            let relative_path = format!("notes_assets/{}/{}", subject_slug, relative_in_subject);
            let Some(disk_path) =
                resolve_import_attachment_disk_path(&assets_base_dir, &relative_path)
            else {
                log::warn!(
                    "[notes_import] 跳过越界附件落盘路径: {} -> {}",
                    file_name,
                    relative_path
                );
                continue;
            };

            // ★ 2026-07-19 硬化：附件流式落盘，大附件不再整体读入内存
            match write_zip_entry_to_disk(&mut file, &disk_path) {
                Ok(_written) => {
                    written_attachment_paths.push(disk_path.clone());
                    total_attachments += 1;
                }
                Err(e) => {
                    log::warn!("写入附件 {} 失败: {}", file_name, e);
                }
            }

            processed_attachments += 1;
            if should_report_progress(processed_attachments, asset_file_count) {
                Self::report_progress(
                    &options,
                    ImportProgress {
                        stage: ImportStage::ImportingAttachments,
                        progress: 50
                            + ((processed_attachments as f64 / asset_file_count.max(1) as f64)
                                * 40.0) as u8,
                        current_item: Some(relative_in_subject.clone()),
                        processed: processed_attachments,
                        total: asset_file_count,
                    },
                );
            }
        }

        // 导入偏好设置（写入旧 DB 的 settings 表，偏好设置不在 VFS 中）
        if let Ok(legacy_conn) = self.db.get_conn_safe() {
            for pref in manifest.preferences.iter() {
                if let Ok(mut file) = zip.by_name(&pref.file) {
                    if file.size() > MAX_IMPORT_TEXT_BYTES {
                        log::warn!(
                            "[VFS Import] 跳过异常大偏好条目 {}（声明 {} 字节）",
                            pref.file,
                            file.size()
                        );
                        continue;
                    }
                    let mut pref_content = String::new();
                    if file.read_to_string(&mut pref_content).is_ok() {
                        let full_key = format!("notes.pref.{}", pref.key);
                        legacy_conn
                            .execute(
                                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
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
                        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
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
            let file = zip.by_index(i).map_err(|e| {
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

            // ★ 2026-07-19：学科名仅由路径 slug 推断，此前这里会把整个 .md
            // 条目读入内存后丢弃，纯属浪费，已移除该读取。
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

            // ★ 2026-07-19 硬化：.md 条目整体读入内存，声明尺寸超限直接跳过
            if file.size() > MAX_IMPORT_TEXT_BYTES {
                log::warn!(
                    "跳过异常大笔记条目 {}（声明 {} 字节）",
                    file_name,
                    file.size()
                );
                continue;
            }

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
            // ★ 审阅 14 P0-1：条目名穿越校验
            if is_unsafe_archive_relative(path_after_assets) {
                log::warn!("[notes_import] 跳过越界附件条目: {}", file_name);
                continue;
            }
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

            // 保存附件到磁盘
            let relative_path = format!("notes_assets/{}/{}", subject, relative_in_subject);
            let Some(disk_path) =
                resolve_import_attachment_disk_path(&assets_base_dir, &relative_path)
            else {
                log::warn!(
                    "[notes_import] 跳过越界附件落盘路径: {} -> {}",
                    file_name,
                    relative_path
                );
                continue;
            };

            // ★ 2026-07-19 硬化：附件流式落盘，大附件不再整体读入内存
            let written_bytes = write_zip_entry_to_disk(&mut file, &disk_path)
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
                        written_bytes as i64,
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
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
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
                    if trimmed.starts_with('-') {
                        let raw = trimmed.trim_start_matches('-').trim();
                        let value = strip_yaml_quotes(raw);
                        if !value.is_empty() {
                            tags.push(value);
                        }
                        continue;
                    }
                    in_tags_block = false;
                }

                if let Some(colon_pos) = trimmed.find(':') {
                    let key = trimmed[..colon_pos].trim();
                    let raw_value = trimmed[colon_pos + 1..].trim();
                    let value = strip_yaml_quotes(raw_value);

                    match key {
                        "id" => id = value,
                        "title" => title = value,
                        "created" => created_at = value,
                        "updated" => updated_at = value,
                        "folder" | "folder_path" => {
                            if !value.is_empty() {
                                folder_path = Some(value);
                            }
                        }
                        "favorite" => is_favorite = value == "true",
                        "tags" => {
                            // 进入多行数组块，后续以 '-' 开头的行作为 tag
                            in_tags_block = true;
                        }
                        _ => {
                            if key == "-" && !value.is_empty() {
                                tags.push(value);
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

#[cfg(test)]
mod zip_slip_tests {
    use super::*;
    use std::io::Write;
    use tempfile::TempDir;
    use zip::write::FileOptions;
    use zip::ZipWriter;

    fn write_zip_entry(zip: &mut ZipWriter<fs::File>, name: &str, data: &[u8]) {
        zip.start_file(name, FileOptions::default()).unwrap();
        zip.write_all(data).unwrap();
    }

    /// 模拟三条导入路径共用的落盘逻辑：校验后写文件。
    fn try_import_asset_entry(base: &Path, entry_after_assets: &str, bytes: &[u8]) -> bool {
        if is_unsafe_archive_relative(entry_after_assets) {
            return false;
        }
        let parts: Vec<&str> = entry_after_assets.split('/').collect();
        if parts.len() < 2 {
            return false;
        }
        let subject_slug = parts[0];
        let relative_in_subject = parts[1..].join("/");
        let relative_path = format!("notes_assets/{}/{}", subject_slug, relative_in_subject);
        let Some(disk_path) = resolve_import_attachment_disk_path(base, &relative_path) else {
            return false;
        };
        if let Some(parent) = disk_path.parent() {
            fs::create_dir_all(parent).ok();
        }
        fs::write(&disk_path, bytes).is_ok()
    }

    #[test]
    fn rejects_parent_dir_traversal() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path();
        assert!(!try_import_asset_entry(
            base,
            "../evil/payload.txt",
            b"evil"
        ));
        assert!(!try_import_asset_entry(
            base,
            "math/../../../evil.txt",
            b"evil"
        ));
        assert!(!base.join("evil").exists());
        assert!(!base.join("evil.txt").exists());
    }

    #[test]
    fn rejects_windows_drive_and_absolute() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path();
        assert!(!try_import_asset_entry(base, "C:/evil/x.txt", b"evil"));
        assert!(!try_import_asset_entry(base, "C:\\evil\\x.txt", b"evil"));
        assert!(!try_import_asset_entry(base, "/etc/passwd", b"evil"));
        assert!(!try_import_asset_entry(base, "//server/share/x", b"evil"));
    }

    #[test]
    fn rejects_mixed_separator_traversal() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path();
        assert!(!try_import_asset_entry(
            base,
            "math\\..\\..\\evil.txt",
            b"evil"
        ));
        assert!(!try_import_asset_entry(
            base,
            "math/..\\../outside.bin",
            b"evil"
        ));
    }

    #[test]
    fn accepts_legitimate_asset_entry() {
        let tmp = TempDir::new().unwrap();
        let base = tmp.path();
        assert!(try_import_asset_entry(
            base,
            "math/note-uuid/img.png",
            b"pngdata"
        ));
        let expected = base
            .join("notes_assets")
            .join("math")
            .join("note-uuid")
            .join("img.png");
        assert!(expected.exists());
        assert_eq!(fs::read(&expected).unwrap(), b"pngdata");
    }

    #[test]
    fn is_unsafe_archive_relative_covers_variants() {
        assert!(is_unsafe_archive_relative("../evil"));
        assert!(is_unsafe_archive_relative("a/../../b"));
        assert!(is_unsafe_archive_relative("C:\\evil"));
        assert!(is_unsafe_archive_relative("/abs"));
        assert!(is_unsafe_archive_relative("a\\..\\b"));
        assert!(!is_unsafe_archive_relative("math/note/img.png"));
        assert!(!is_unsafe_archive_relative("math/note/sub/img.png"));
    }

    #[test]
    fn zip_with_malicious_entries_does_not_escape_base() {
        let tmp = TempDir::new().unwrap();
        let zip_path = tmp.path().join("payload.zip");
        {
            let file = fs::File::create(&zip_path).unwrap();
            let mut zip = ZipWriter::new(file);
            write_zip_entry(&mut zip, "assets/math/note1/ok.png", b"ok");
            write_zip_entry(&mut zip, "assets/../evil.txt", b"evil");
            write_zip_entry(&mut zip, "assets/math/../../outside.bin", b"out");
            zip.finish().unwrap();
        }

        let base = tmp.path().join("appdata");
        fs::create_dir_all(&base).unwrap();

        let archive = fs::File::open(&zip_path).unwrap();
        let mut archive = zip::ZipArchive::new(archive).unwrap();
        for i in 0..archive.len() {
            let mut file = archive.by_index(i).unwrap();
            let name = file.name().to_string();
            if !name.starts_with("assets/") || file.is_dir() {
                continue;
            }
            let after = name.strip_prefix("assets/").unwrap_or("");
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes).unwrap();
            let _ = try_import_asset_entry(&base, after, &bytes);
        }

        assert!(base
            .join("notes_assets")
            .join("math")
            .join("note1")
            .join("ok.png")
            .exists());
        assert!(!base.join("evil.txt").exists());
        assert!(!tmp.path().join("evil.txt").exists());
        assert!(!base.join("outside.bin").exists());
    }
}
