//! VFS 笔记表 CRUD 操作
//!
//! 笔记内容存储在 `resources.data`，本模块只管理笔记元数据。
//!
//! ## 核心方法
//! - `create_note`: 创建笔记（同时创建关联资源）
//! - `update_note`: 更新笔记（内容变化时创建新资源）
//! - `get_note`: 获取笔记元数据
//! - `get_note_content`: 获取笔记内容

use std::collections::HashSet;

use rusqlite::{params, Connection, OptionalExtension};
use tracing::{debug, info, warn};

use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};
use crate::vfs::note_props;
use crate::vfs::repos::embedding_repo::VfsIndexStateRepo;
use crate::vfs::repos::folder_repo::VfsFolderRepo;
use crate::vfs::repos::resource_repo::VfsResourceRepo;
use crate::vfs::types::{
    ResourceLocation, VfsCreateNoteParams, VfsFolderItem, VfsNote, VfsResourceType,
    VfsUpdateNoteParams,
};

fn next_updated_at(current: &str) -> String {
    let now = chrono::Utc::now();
    let next = chrono::DateTime::parse_from_rfc3339(current)
        .map(|value| value.with_timezone(&chrono::Utc) + chrono::Duration::milliseconds(1))
        .map(|minimum| if now > minimum { now } else { minimum })
        .unwrap_or(now);
    next.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

/// VFS 笔记表 Repo
pub struct VfsNoteRepo;

/// 一次性更新 notes 行上的用户元数据。
///
/// `None` 表示保留原值；`props: Some({})` 表示清空并规范化为 SQL NULL。
/// 所有字段在同一条 CAS UPDATE 中提交，避免 DSTU 多字段写入部分成功。
#[derive(Debug, Clone, Default)]
pub struct VfsNoteMetadataUpdate {
    pub title: Option<String>,
    pub tags: Option<Vec<String>>,
    pub is_favorite: Option<bool>,
    pub props: Option<serde_json::Value>,
    pub expected_updated_at: Option<String>,
}

// ============================================================================
// 笔记链接图（note_links，见迁移 V20260725__note_links.sql）
// ============================================================================

/// 链接语法类型
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoteLinkKind {
    /// `[[target|alias]]` / `[[target#heading]]` wiki 链接
    Wikilink,
    /// `note://id` 直接引用
    NoteRef,
}

impl NoteLinkKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            NoteLinkKind::Wikilink => "wikilink",
            NoteLinkKind::NoteRef => "noteref",
        }
    }
}

/// 从正文解析出的一条链接（尚未解析目标笔记）
#[derive(Debug, Clone)]
pub struct ParsedNoteLink {
    /// `[[...]]` 中的目标原文（标题或 note id），或 `note://` 后的 id
    pub raw_target: String,
    /// `[[target#heading]]` 的锚点部分
    pub heading: Option<String>,
    /// `[[target|alias]]` 的别名部分
    pub alias: Option<String>,
    /// 链接起始处在正文中的 UTF-8 字节偏移
    pub position: i64,
    pub kind: NoteLinkKind,
}

/// 反链条目（谁链接到本笔记）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteBacklink {
    pub source_id: String,
    pub source_title: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
    /// 链接在来源正文中的 UTF-8 字节偏移
    pub position: i64,
    pub source_updated_at: String,
}

/// 出链条目（本笔记链接到谁）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteOutgoingLink {
    /// 解析成功时的目标笔记 id；未解析（目标不存在/已软删除）为 None
    pub target_id: Option<String>,
    /// 展示标题：解析成功用目标笔记当前标题，否则用链接书写原文
    pub target_title: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
    /// 链接在正文中的 UTF-8 字节偏移
    pub position: i64,
    /// wikilink | noteref
    pub link_type: String,
    pub resolved: bool,
}

/// 未解析链接条目（目标笔记不存在）
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteUnresolvedLink {
    pub source_id: String,
    pub source_title: String,
    /// 链接书写的目标标题原文
    pub target_title: String,
    pub heading: Option<String>,
    pub alias: Option<String>,
    pub position: i64,
    pub link_type: String,
}

/// Markdown 代码区域（围栏代码块 + 行内代码）的字节区间集合，半开区间 `[start, end)`。
///
/// 静态、保守的行级解析（不做完整 CommonMark 解析）：
/// - 围栏代码块：行首缩进 <= 3 空格、以 >=3 个连续 `` ` `` 或 `~` 开头的行开栏；
///   由同字符、长度 >= 开栏长度、且整行仅含该字符的行闭合；
///   未闭合的围栏延伸到文末（与 CommonMark 一致）。
/// - 行内代码：围栏外的行内，长度相同的反引号串就近配对（`` `code` ``、``` ``a`b`` ```）。
/// - 已知取舍：4 空格缩进式代码块不识别（无法与深层嵌套列表的续行区分，
///   前端编辑器序列化代码块时统一使用围栏语法）。
///
/// 反引号/波浪线均为单字节 ASCII，按字节扫描对 UTF-8 安全。
fn markdown_code_ranges(content: &str) -> Vec<(usize, usize)> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    // (围栏字符, 开栏长度, 区块起始字节)
    let mut open_fence: Option<(u8, usize, usize)> = None;
    let mut line_start = 0usize;

    for line in content.split_inclusive('\n') {
        let line_end = line_start + line.len();
        let trimmed = line.trim_start_matches(' ');
        let indent = line.len() - trimmed.len();
        let trimmed = trimmed.trim_end_matches(|c: char| matches!(c, '\n' | '\r' | ' ' | '\t'));

        if let Some((fence_ch, fence_len, block_start)) = open_fence {
            // 闭栏：缩进 <= 3、整行仅含围栏字符、长度不小于开栏
            let is_close = indent <= 3
                && !trimmed.is_empty()
                && trimmed.as_bytes().iter().all(|&b| b == fence_ch)
                && trimmed.len() >= fence_len;
            if is_close {
                ranges.push((block_start, line_end));
                open_fence = None;
            }
            line_start = line_end;
            continue;
        }

        // 开栏检测
        if indent <= 3 && !trimmed.is_empty() {
            let first = trimmed.as_bytes()[0];
            if first == b'`' || first == b'~' {
                let run = trimmed.bytes().take_while(|&b| b == first).count();
                // CommonMark：反引号围栏的 info string 不得再含反引号
                let info_ok = first == b'~' || !trimmed[run..].contains('`');
                if run >= 3 && info_ok {
                    open_fence = Some((first, run, line_start));
                    line_start = line_end;
                    continue;
                }
            }
        }

        // 行内代码：同长度反引号串就近配对
        let bytes = line.as_bytes();
        let mut i = 0usize;
        while i < bytes.len() {
            if bytes[i] != b'`' {
                i += 1;
                continue;
            }
            let run_start = i;
            while i < bytes.len() && bytes[i] == b'`' {
                i += 1;
            }
            let run_len = i - run_start;
            // 向后找长度恰好相同的关闭串
            let mut j = i;
            let mut close_end: Option<usize> = None;
            while j < bytes.len() {
                if bytes[j] != b'`' {
                    j += 1;
                    continue;
                }
                let c_start = j;
                while j < bytes.len() && bytes[j] == b'`' {
                    j += 1;
                }
                if j - c_start == run_len {
                    close_end = Some(j);
                    break;
                }
            }
            if let Some(end) = close_end {
                ranges.push((line_start + run_start, line_start + end));
                i = end;
            }
            // 未闭合：跳过本 run，继续扫描行内剩余部分
        }

        line_start = line_end;
    }

    if let Some((_, _, block_start)) = open_fence {
        ranges.push((block_start, content.len()));
    }
    ranges
}

/// 从 Markdown 正文提取 wiki 链接与 note:// 引用。
///
/// 支持的语法（与前端 Crepe wikilink 插件对齐）：
/// - `[[target]]`、`[[target|alias]]`、`[[target#heading]]`、`[[target#heading|alias]]`
///   （target 可以是笔记标题，也可以是 `note_xxx` 形式的笔记 id）
/// - `note://<id>`（常见于 `[label](note://id)` Markdown 链接）
///
/// 限制（静态解析的已知取舍）：
/// - 围栏代码块与行内代码中的 `[[..]]` / `note://` 不算链接
///   （见 [`markdown_code_ranges`]；4 空格缩进式代码块除外）。
/// - `[[#heading]]`（无 target 的本页锚点）不产生链接。
/// - position 为 UTF-8 字节偏移（`[[` 或 `note://` 的起始处）。
pub fn extract_note_links(content: &str) -> Vec<ParsedNoteLink> {
    const SCHEME: &str = "note://";
    let mut links: Vec<ParsedNoteLink> = Vec::new();
    // 代码区域内的链接样文本不算链接（围栏代码块 + 行内代码）
    let code_ranges = markdown_code_ranges(content);
    let in_code = |pos: usize| code_ranges.iter().any(|&(s, e)| pos >= s && pos < e);
    // 已识别的 [[...]] 字节区间，用于避免 note:// 扫描器重复捕获 wiki 链接内部的 URI
    let mut wiki_ranges: Vec<(usize, usize)> = Vec::new();

    // ---- [[...]] wiki 链接 ----
    let mut cursor = 0usize;
    while let Some(rel) = content[cursor..].find("[[") {
        let start = cursor + rel;
        let inner_start = start + 2;
        let Some(end_rel) = content[inner_start..].find("]]") else {
            break;
        };
        let inner_end = inner_start + end_rel;
        let inner = &content[inner_start..inner_end];
        cursor = inner_end + 2;

        // 跨行的 [[ ... ]] 视为普通文本（编辑器不会产出跨行链接）
        if inner.contains('\n') {
            continue;
        }
        wiki_ranges.push((start, inner_end + 2));
        // 代码块/行内代码中的 [[..]] 是字面文本，不算链接
        if in_code(start) {
            continue;
        }

        let (target_part, alias) = match inner.find('|') {
            Some(p) => (
                &inner[..p],
                Some(inner[p + 1..].trim().to_string()).filter(|s| !s.is_empty()),
            ),
            None => (inner, None),
        };
        let (target_raw, heading) = match target_part.find('#') {
            Some(p) => (
                &target_part[..p],
                Some(target_part[p + 1..].trim().to_string()).filter(|s| !s.is_empty()),
            ),
            None => (target_part, None),
        };
        let target = target_raw.trim();
        if target.is_empty() {
            // [[#heading]]：本笔记内锚点，无跨笔记目标
            continue;
        }
        // [[note://id]]：按 id 引用处理（剥掉 scheme）
        let (raw_target, kind) = match target.strip_prefix(SCHEME) {
            Some(id) if !id.trim().is_empty() => (id.trim().to_string(), NoteLinkKind::NoteRef),
            Some(_) => continue,
            None => (target.to_string(), NoteLinkKind::Wikilink),
        };
        links.push(ParsedNoteLink {
            raw_target,
            heading,
            alias,
            position: start as i64,
            kind,
        });
    }

    // ---- note://id 引用（wiki 链接之外的裸 URI / Markdown 链接目标） ----
    let mut cursor = 0usize;
    while let Some(rel) = content[cursor..].find(SCHEME) {
        let start = cursor + rel;
        let id_start = start + SCHEME.len();
        let id_end = content[id_start..]
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .map(|p| id_start + p)
            .unwrap_or(content.len());
        cursor = id_end.max(id_start);
        if wiki_ranges.iter().any(|(s, e)| start >= *s && start < *e) {
            continue;
        }
        // 代码块/行内代码中的 note:// 是字面文本，不算链接
        if in_code(start) {
            continue;
        }
        let id = &content[id_start..id_end];
        if id.is_empty() {
            continue;
        }
        links.push(ParsedNoteLink {
            raw_target: id.to_string(),
            heading: None,
            alias: None,
            position: start as i64,
            kind: NoteLinkKind::NoteRef,
        });
    }

    links.sort_by_key(|l| l.position);
    links
}

impl VfsNoteRepo {
    /// 标题最大字符数（防御性上限，正常 UI/导入路径远低于此值）
    const MAX_TITLE_CHARS: usize = 500;
    /// 单条笔记最大标签数
    const MAX_TAGS: usize = 100;
    /// 单个标签最大字符数
    const MAX_TAG_CHARS: usize = 100;

    /// 校验笔记标题：非空、长度上限、不含换行等控制字符（制表符除外，
    /// Markdown H1 导入的标题可能合法地包含 Tab）。
    fn validate_title(title: &str) -> VfsResult<()> {
        if title.trim().is_empty() {
            return Err(VfsError::InvalidArgument {
                param: "title".to_string(),
                reason: "标题不能为空".to_string(),
            });
        }
        if title.chars().count() > Self::MAX_TITLE_CHARS {
            return Err(VfsError::InvalidArgument {
                param: "title".to_string(),
                reason: format!("标题过长（最多 {} 个字符）", Self::MAX_TITLE_CHARS),
            });
        }
        if title.chars().any(|c| c.is_control() && c != '\t') {
            return Err(VfsError::InvalidArgument {
                param: "title".to_string(),
                reason: "标题不能包含换行等控制字符".to_string(),
            });
        }
        Ok(())
    }

    /// 校验标签形状：数量上限、单个标签长度上限、不含控制字符。
    /// 空白标签不报错（历史行为允许，展示层会过滤）。
    fn validate_tags(tags: &[String]) -> VfsResult<()> {
        if tags.len() > Self::MAX_TAGS {
            return Err(VfsError::InvalidArgument {
                param: "tags".to_string(),
                reason: format!("标签数量超出上限（最多 {} 个）", Self::MAX_TAGS),
            });
        }
        for tag in tags {
            if tag.chars().count() > Self::MAX_TAG_CHARS {
                return Err(VfsError::InvalidArgument {
                    param: "tags".to_string(),
                    reason: format!("标签过长（最多 {} 个字符）", Self::MAX_TAG_CHARS),
                });
            }
            if tag.chars().any(|c| c.is_control()) {
                return Err(VfsError::InvalidArgument {
                    param: "tags".to_string(),
                    reason: "标签不能包含控制字符".to_string(),
                });
            }
        }
        Ok(())
    }

    /// 自定义属性限额（canonical 定义在 vfs::note_props，与前端
    /// NoteCustomPropsEditor 常量一致；此处保留别名以维持既有 API）
    pub const MAX_PROPS: usize = note_props::MAX_PROPS;
    pub const MAX_PROP_KEY_CHARS: usize = note_props::MAX_PROP_KEY_CHARS;
    pub const MAX_PROP_VALUE_CHARS: usize = note_props::MAX_PROP_VALUE_CHARS;
    /// 与内建元数据/搜索操作符冲突的保留键（小写比较）
    pub const PROPS_RESERVED_KEYS: [&'static str; 7] = note_props::PROPS_RESERVED_KEYS;

    /// 校验自定义属性对象：键非空/不保留/长度上限/无控制字符
    /// （单键规则委托给共享键语法模块 [`note_props::validate_prop_key`]，
    /// 与搜索侧共用同一套测试向量）；跨键约束（重复/数量上限）在此处理；
    /// 值仅允许标量（字符串/数字/布尔），字符串有长度上限。
    fn validate_note_props(props: &serde_json::Map<String, serde_json::Value>) -> VfsResult<()> {
        if props.len() > Self::MAX_PROPS {
            return Err(VfsError::InvalidArgument {
                param: "props".to_string(),
                reason: format!("属性数量超出上限（最多 {} 个）", Self::MAX_PROPS),
            });
        }
        let mut normalized_keys = HashSet::with_capacity(props.len());
        for (key, value) in props {
            let trimmed = note_props::validate_prop_key(key).map_err(|key_error| {
                VfsError::InvalidArgument {
                    param: "props".to_string(),
                    reason: key_error.reason(key.trim()),
                }
            })?;
            if !normalized_keys.insert(trimmed.to_lowercase()) {
                return Err(VfsError::InvalidArgument {
                    param: "props".to_string(),
                    reason: format!("属性名 {trimmed:?} 与已有属性重复"),
                });
            }
            match value {
                serde_json::Value::String(s) => {
                    if s.chars().count() > Self::MAX_PROP_VALUE_CHARS {
                        return Err(VfsError::InvalidArgument {
                            param: "props".to_string(),
                            reason: format!(
                                "属性值过长（最多 {} 个字符）",
                                Self::MAX_PROP_VALUE_CHARS
                            ),
                        });
                    }
                    if s.chars().any(|c| c.is_control()) {
                        return Err(VfsError::InvalidArgument {
                            param: "props".to_string(),
                            reason: "属性值不能包含控制字符".to_string(),
                        });
                    }
                }
                serde_json::Value::Number(_) | serde_json::Value::Bool(_) => {}
                _ => {
                    return Err(VfsError::InvalidArgument {
                        param: "props".to_string(),
                        reason: "属性值只支持字符串、数字或布尔".to_string(),
                    });
                }
            }
        }
        Ok(())
    }

    // ========================================================================
    // 创建笔记
    // ========================================================================

    /// 创建笔记
    ///
    /// ## 流程
    /// 1. 创建或复用资源（基于内容 hash 去重）
    /// 2. 创建笔记元数据记录
    pub fn create_note(db: &VfsDatabase, params: VfsCreateNoteParams) -> VfsResult<VfsNote> {
        let conn = db.get_conn_safe()?;
        Self::create_note_with_conn(&conn, params)
    }

    /// 创建笔记（使用现有连接）
    ///
    /// ★ 2026-02-08 修复：使用 SAVEPOINT 事务保护，确保 3 步操作的原子性。
    /// SAVEPOINT 可安全嵌套在外层 BEGIN IMMEDIATE 事务内（如 create_note_in_folder_with_conn）。
    pub fn create_note_with_conn(
        conn: &Connection,
        params: VfsCreateNoteParams,
    ) -> VfsResult<VfsNote> {
        // ★ M-011 修复 + 2026-07 防御性校验：空标题/超长/控制字符、tags 形状
        Self::validate_title(&params.title)?;
        Self::validate_tags(&params.tags)?;
        let final_title = params.title.clone();

        // 1. 预生成 note_id（用于资源 hash 盐值，避免跨笔记资源复用）
        let note_id = VfsNote::generate_id();
        let resource_hash = VfsResourceRepo::compute_hash_with_salt(&params.content, &note_id);

        // ★ SAVEPOINT 事务保护：包裹 create_or_reuse / INSERT notes / UPDATE resources 三步操作
        conn.execute("SAVEPOINT create_note", []).map_err(|e| {
            tracing::error!(
                "[VFS::NoteRepo] Failed to create savepoint for create_note: {}",
                e
            );
            VfsError::Database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> VfsResult<VfsNote> {
            // 2. 创建或复用资源（note_id 作为盐值，确保资源仅在本笔记内复用）
            let resource_result = VfsResourceRepo::create_or_reuse_with_conn_and_hash(
                conn,
                VfsResourceType::Note,
                &params.content,
                &resource_hash,
                Some(&note_id),
                Some("notes"),
                None,
            )?;

            // 3. 创建笔记记录
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let tags_json = serde_json::to_string(&params.tags)
                .map_err(|e| VfsError::Serialization(e.to_string()))?;

            conn.execute(
                r#"
                INSERT INTO notes (id, resource_id, title, tags, is_favorite, created_at, updated_at)
                VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
                "#,
                params![
                    note_id,
                    resource_result.resource_id,
                    final_title,
                    tags_json,
                    now,
                    now,
                ],
            )?;

            // 4. 更新资源的 source_id（确保复用场景下 source_id 一致）
            conn.execute(
                "UPDATE resources SET source_id = ?1 WHERE id = ?2",
                params![note_id, resource_result.resource_id],
            )?;

            // 5. ★ 2026-07-20：链接图维护收敛到 repo 层 —— 正文落库即在
            //    同一 SAVEPOINT 内写出链（note_links 为派生数据，见
            //    V20260725__note_links.sql），所有调用方（DSTU/VFS/legacy/canvas）
            //    自动受益。新建笔记无存量出链行，无链接时跳过。
            let parsed_links = extract_note_links(&params.content);
            if !parsed_links.is_empty() {
                Self::replace_note_links_with_conn(conn, &note_id, &parsed_links)?;
            }

            info!(
                "[VFS::NoteRepo] Created note: {} (resource: {})",
                note_id, resource_result.resource_id
            );

            Ok(VfsNote {
                id: note_id,
                resource_id: resource_result.resource_id,
                title: final_title,
                tags: params.tags,
                is_favorite: false,
                created_at: now.clone(),
                updated_at: now,
                deleted_at: None,
                props: None,
            })
        })();

        match result {
            Ok(note) => {
                conn.execute("RELEASE create_note", []).map_err(|e| {
                    tracing::error!(
                        "[VFS::NoteRepo] Failed to release savepoint create_note: {}",
                        e
                    );
                    VfsError::Database(format!("Failed to release savepoint: {}", e))
                })?;
                Ok(note)
            }
            Err(e) => {
                // 回滚到 savepoint，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO create_note", []);
                // 释放 savepoint（即使回滚后也需要释放，否则 savepoint 会残留）
                let _ = conn.execute("RELEASE create_note", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 更新笔记
    // ========================================================================

    /// 更新笔记
    ///
    /// ## 资源管理逻辑
    /// 1. 如果内容变化，计算新 hash
    /// 2. 若 hash 不同，创建新 resource
    /// 3. 更新笔记的 resource_id 指向新资源
    pub fn update_note(
        db: &VfsDatabase,
        note_id: &str,
        params: VfsUpdateNoteParams,
    ) -> VfsResult<VfsNote> {
        let conn = db.get_conn_safe()?;
        Self::update_note_with_conn(&conn, note_id, params)
    }

    /// 更新笔记（使用现有连接）
    ///
    /// ★ 2026-02-09 修复：使用 SAVEPOINT 事务保护，确保 3 步操作（创建新资源、保存旧版本、更新 notes 表）的原子性。
    /// SAVEPOINT 可安全嵌套在外层事务内。
    pub fn update_note_with_conn(
        conn: &Connection,
        note_id: &str,
        params: VfsUpdateNoteParams,
    ) -> VfsResult<VfsNote> {
        // 1. 获取当前笔记（在 SAVEPOINT 外获取，减少事务持有时间）
        let current_note =
            Self::get_note_with_conn(conn, note_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "Note".to_string(),
                id: note_id.to_string(),
            })?;

        // ★ S-002 修复：乐观锁冲突检测
        // 如果调用方提供了 expected_updated_at，则与当前记录的 updated_at 比较。
        // 不匹配说明记录在读取后被其他操作修改过，返回 Conflict 错误。
        if let Some(ref expected) = params.expected_updated_at {
            if !expected.is_empty() && *expected != current_note.updated_at {
                warn!(
                    "[VFS::NoteRepo] Optimistic lock conflict for note {}: expected updated_at='{}', actual='{}'",
                    note_id, expected, current_note.updated_at
                );
                return Err(VfsError::Conflict {
                    key: "notes.conflict".to_string(),
                    message: "The note has been updated elsewhere, please refresh.".to_string(),
                });
            }
        }

        // ★ M-011 修复 + 2026-07 防御性校验：空标题/超长/控制字符、tags 形状
        // （在 SAVEPOINT 外提前校验，避免先建新资源再回滚的无谓开销）
        if let Some(ref title) = params.title {
            Self::validate_title(title)?;
        }
        if let Some(ref tags) = params.tags {
            Self::validate_tags(tags)?;
        }

        // ★ SAVEPOINT 事务保护：包裹 create_or_reuse / create_version / UPDATE notes 三步操作
        conn.execute("SAVEPOINT update_note", []).map_err(|e| {
            tracing::error!(
                "[VFS::NoteRepo] Failed to create savepoint for update_note: {}",
                e
            );
            VfsError::Database(format!("Failed to create savepoint: {}", e))
        })?;

        let result = (|| -> VfsResult<VfsNote> {
            // CAS tokens must advance even when two writes land in the same
            // millisecond; otherwise a stale expected_updated_at can still
            // match after the first writer commits.
            let now = next_updated_at(&current_note.updated_at);

            // 2. 处理内容更新（版本管理）
            let new_resource_id = if let Some(new_content) = &params.content {
                // 计算新 hash（使用 note_id 作为盐值，避免跨笔记资源复用）
                let new_hash = VfsResourceRepo::compute_hash_with_salt(new_content, note_id);
                let current_resource =
                    VfsResourceRepo::get_resource_with_conn(conn, &current_note.resource_id)?
                        .ok_or_else(|| VfsError::NotFound {
                            resource_type: "Resource".to_string(),
                            id: current_note.resource_id.clone(),
                        })?;

                // 兼容历史无盐 hash 的存量资源：仅当盐化 hash 不匹配时才
                // 计算 legacy hash（大笔记自动保存路径少一次全量 SHA）
                if new_hash != current_resource.hash
                    && VfsResourceRepo::compute_hash(new_content) != current_resource.hash
                {
                    // 内容变化，创建新资源
                    let new_resource_result = VfsResourceRepo::create_or_reuse_with_conn_and_hash(
                        conn,
                        VfsResourceType::Note,
                        new_content,
                        &new_hash,
                        Some(note_id),
                        Some("notes"),
                        None,
                    )?;

                    debug!(
                        "[VFS::NoteRepo] Updated note resource {}: {} -> {}",
                        note_id, current_note.resource_id, new_resource_result.resource_id
                    );

                    Some(new_resource_result.resource_id)
                } else {
                    None // hash 相同，无需创建新资源
                }
            } else {
                None
            };

            // 3. 构建更新 SQL
            let new_title = params.title.as_ref().unwrap_or(&current_note.title);
            let new_tags = params.tags.as_ref().unwrap_or(&current_note.tags);
            let tags_json = serde_json::to_string(new_tags)
                .map_err(|e| VfsError::Serialization(e.to_string()))?;

            let final_resource_id = new_resource_id
                .as_ref()
                .unwrap_or(&current_note.resource_id);

            let expected_updated_at = params
                .expected_updated_at
                .as_ref()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty());

            let updated_rows = if let Some(expected) = expected_updated_at {
                conn.execute(
                    r#"
                    UPDATE notes
                    SET resource_id = ?1, title = ?2, tags = ?3, updated_at = ?4
                    WHERE id = ?5 AND deleted_at IS NULL AND updated_at = ?6
                    "#,
                    params![
                        final_resource_id,
                        new_title,
                        tags_json,
                        now,
                        note_id,
                        expected
                    ],
                )?
            } else {
                conn.execute(
                    r#"
                    UPDATE notes
                    SET resource_id = ?1, title = ?2, tags = ?3, updated_at = ?4
                    WHERE id = ?5 AND deleted_at IS NULL
                    "#,
                    params![final_resource_id, new_title, tags_json, now, note_id],
                )?
            };

            if updated_rows == 0 {
                if expected_updated_at.is_some() {
                    return Err(VfsError::Conflict {
                        key: "notes.conflict".to_string(),
                        message: "The note has been updated elsewhere, please refresh.".to_string(),
                    });
                }

                return Err(VfsError::NotFound {
                    resource_type: "Note".to_string(),
                    id: note_id.to_string(),
                });
            }

            // ★ 2026-06-12 修复（审阅问题 S5）：resource_id 切换成功后，清理旧资源。
            // 笔记没有版本表，旧资源切换后即无人引用；不清理会在每次内容编辑时
            // 泄漏一行 resources（含完整笔记内容）+ 残留向量索引单元。
            // 仅当确实无其他笔记引用时删除（防御历史无盐共享数据）。
            if new_resource_id.is_some() && current_note.resource_id != *final_resource_id {
                let old_rid = &current_note.resource_id;
                let note_refs: i64 = conn.query_row(
                    "SELECT COUNT(*) FROM notes WHERE resource_id = ?1",
                    params![old_rid],
                    |row| row.get(0),
                )?;
                if note_refs == 0 {
                    // ★ 2026-06-12（第二轮审阅）：经统一入口清理索引产物（含 Lance 向量入列）
                    super::index_unit_repo::purge_index_artifacts_by_resource(conn, old_rid)?;
                    conn.execute("DELETE FROM resources WHERE id = ?1", params![old_rid])?;
                    debug!(
                        "[VFS::NoteRepo] Deleted superseded resource {} for note {}",
                        old_rid, note_id
                    );
                }
            }

            // ★ 2026-07-20：链接图维护收敛到 repo 层 —— 正文变化时在同一
            // SAVEPOINT 内重写出链（原子：正文与 note_links 一起提交/回滚）。
            // new_resource_id 为 Some 当且仅当携带正文且 hash 变化；
            // 内容未变（hash 相同复用资源）时跳过，节省热路径自动保存开销。
            if new_resource_id.is_some() {
                if let Some(new_content) = &params.content {
                    Self::replace_note_links_with_conn(
                        conn,
                        note_id,
                        &extract_note_links(new_content),
                    )?;
                }
            }

            info!("[VFS::NoteRepo] Updated note: {}", note_id);

            // 4. 返回更新后的笔记
            Ok(VfsNote {
                id: note_id.to_string(),
                resource_id: final_resource_id.clone(),
                title: new_title.clone(),
                tags: new_tags.clone(),
                is_favorite: current_note.is_favorite,
                created_at: current_note.created_at,
                updated_at: now,
                deleted_at: None,
                props: current_note.props,
            })
        })();

        match result {
            Ok(note) => {
                conn.execute("RELEASE update_note", []).map_err(|e| {
                    tracing::error!(
                        "[VFS::NoteRepo] Failed to release savepoint update_note: {}",
                        e
                    );
                    VfsError::Database(format!("Failed to release savepoint: {}", e))
                })?;
                Ok(note)
            }
            Err(e) => {
                // 回滚到 savepoint，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK TO update_note", []);
                // 释放 savepoint（即使回滚后也需要释放，否则 savepoint 会残留）
                let _ = conn.execute("RELEASE update_note", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 查询笔记
    // ========================================================================

    /// 获取笔记元数据（排除软删除）
    pub fn get_note(db: &VfsDatabase, note_id: &str) -> VfsResult<Option<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::get_note_with_conn(&conn, note_id)
    }

    /// 获取笔记元数据（使用现有连接，排除软删除）
    ///
    /// ★ M-008 修复：添加 `deleted_at IS NULL` 过滤，防止读取/更新软删除的笔记。
    /// 如需读取已删除笔记（恢复/清理场景），请使用 `get_note_including_deleted_with_conn`。
    pub fn get_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<Option<VfsNote>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props
            FROM notes
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
        )?;

        let note = stmt
            .query_row(params![note_id], Self::row_to_note)
            .optional()?;

        Ok(note)
    }

    /// 获取笔记元数据（包含软删除的笔记）
    ///
    /// ★ M-008：专用方法，用于恢复（restore）和永久删除（purge）等需要访问已删除笔记的场景。
    pub fn get_note_including_deleted(
        db: &VfsDatabase,
        note_id: &str,
    ) -> VfsResult<Option<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::get_note_including_deleted_with_conn(&conn, note_id)
    }

    /// 获取笔记元数据（使用现有连接，包含软删除的笔记）
    ///
    /// ★ M-008：专用方法，用于恢复（restore）和永久删除（purge）等需要访问已删除笔记的场景。
    pub fn get_note_including_deleted_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<Option<VfsNote>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props
            FROM notes
            WHERE id = ?1
            "#,
        )?;

        let note = stmt
            .query_row(params![note_id], Self::row_to_note)
            .optional()?;

        Ok(note)
    }

    /// 获取笔记内容
    ///
    /// 从关联的 resource.data 获取内容
    pub fn get_note_content(db: &VfsDatabase, note_id: &str) -> VfsResult<Option<String>> {
        let conn = db.get_conn_safe()?;
        Self::get_note_content_with_conn(&conn, note_id)
    }

    /// 获取笔记内容（使用现有连接，排除软删除）
    ///
    /// ★ M-008 修复：添加 `deleted_at IS NULL` 过滤，防止读取软删除笔记的内容。
    /// 如果笔记存在但关联的资源不存在，会自动修复数据（创建空资源）
    pub fn get_note_content_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<Option<String>> {
        // 首先尝试通过 JOIN 获取内容（排除软删除）
        let content: Option<String> = conn
            .query_row(
                r#"
                SELECT r.data
                FROM notes n
                JOIN resources r ON n.resource_id = r.id
                WHERE n.id = ?1 AND n.deleted_at IS NULL
                "#,
                params![note_id],
                |row| row.get(0),
            )
            .optional()?;

        if content.is_some() {
            return Ok(content);
        }

        // JOIN 失败，检查笔记是否存在（用于诊断和自动修复，排除软删除）
        let note_info: Option<(String, String)> = conn
            .query_row(
                "SELECT id, resource_id FROM notes WHERE id = ?1 AND deleted_at IS NULL",
                params![note_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;

        if let Some((_id, resource_id)) = note_info {
            // 笔记存在，检查资源是否存在
            let resource_exists: bool = conn
                .query_row(
                    "SELECT 1 FROM resources WHERE id = ?1",
                    params![resource_id],
                    |_| Ok(true),
                )
                .unwrap_or(false);

            if !resource_exists {
                warn!(
                    "[VFS::NoteRepo] Missing resource for note {} (resource_id: {})",
                    note_id, resource_id
                );
                return Err(VfsError::Database(format!(
                    "Missing resource for note {}",
                    note_id
                )));
            }
        }

        // 笔记不存在，返回 None
        Ok(None)
    }

    /// 获取笔记及其内容
    pub fn get_note_with_content(
        db: &VfsDatabase,
        note_id: &str,
    ) -> VfsResult<Option<(VfsNote, String)>> {
        let conn = db.get_conn_safe()?;
        Self::get_note_with_content_with_conn(&conn, note_id)
    }

    /// 获取笔记及其内容（使用现有连接）
    pub fn get_note_with_content_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<Option<(VfsNote, String)>> {
        let note = Self::get_note_with_conn(conn, note_id)?;
        if let Some(n) = note {
            let content = Self::get_note_content_with_conn(conn, note_id)?.unwrap_or_default();
            Ok(Some((n, content)))
        } else {
            Ok(None)
        }
    }

    // ========================================================================
    // 列表查询
    // ========================================================================

    /// 转义 SQL LIKE 模式中的特殊字符
    ///
    /// CRITICAL-001修复: 防止SQL LIKE通配符注入
    /// 转义 `%` 和 `_` 字符，防止用户输入被误解为通配符
    fn escape_like_pattern(s: &str) -> String {
        s.replace('\\', r"\\") // 先转义反斜杠
            .replace('%', r"\%") // 转义百分号通配符
            .replace('_', r"\_") // 转义下划线通配符
    }

    // ========================================================================
    // 全文检索（notes_fts，见迁移 V20260724__notes_fts.sql）
    // ========================================================================

    /// 将用户关键词构造成 FTS5 MATCH 查询。
    ///
    /// notes_fts 使用 trigram tokenizer：整个关键词作为一个带引号的 phrase
    /// （内部 `"` 双写转义），子串匹配语义与 `LIKE '%kw%'` 对齐。
    /// trigram 要求查询至少 3 个字符才能命中索引，不足时返回 None，
    /// 由调用方回退到 LIKE 路径。
    fn build_fts_match_query(keyword: &str) -> Option<String> {
        let trimmed = keyword.trim();
        if trimmed.chars().count() < 3 {
            return None;
        }
        Some(format!("\"{}\"", trimmed.replace('"', "\"\"")))
    }

    /// FTS5 检索笔记元数据（bm25 相关度排序，标题权重 5:1 高于正文）。
    ///
    /// 返回空结果或出错时由调用方回退 LIKE；本函数不做回退。
    fn search_notes_fts_with_conn(
        conn: &Connection,
        keyword: &str,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let Some(match_query) = Self::build_fts_match_query(keyword) else {
            return Ok(Vec::new());
        };

        let mut stmt = conn.prepare(
            r#"
            SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at, n.props
            FROM notes_fts
            JOIN notes n ON n.rowid = notes_fts.rowid
            WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
            ORDER BY bm25(notes_fts, 5.0, 1.0), n.updated_at DESC, n.id ASC
            LIMIT ?2 OFFSET ?3
            "#,
        )?;

        let rows = stmt.query_map(params![match_query, limit, offset], Self::row_to_note)?;
        let notes: Vec<VfsNote> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(notes)
    }

    /// 围绕关键词首次出现位置生成正文摘要（字符窗口，前后加省略号）。
    ///
    /// notes_fts 是 contentless 表，snippet() 不可用；正文已在同一查询中
    /// JOIN resources 取回，这里在 Rust 侧生成摘要，避免 N+1。
    fn make_search_snippet(text: &str, keyword: &str, max_chars: usize) -> Option<String> {
        let trimmed_text = text.trim();
        if trimmed_text.is_empty() {
            return None;
        }
        let lower_text = trimmed_text.to_lowercase();
        let lower_keyword = keyword.trim().to_lowercase();
        // 在 lowercase 文本中定位，再换算为字符偏移；大小写转换极少数字符会
        // 改变长度，偏移可能漂移 1-2 个字符，对摘要窗口无实质影响。
        let char_index = if lower_keyword.is_empty() {
            0
        } else {
            match lower_text.find(&lower_keyword) {
                Some(byte_index) => lower_text[..byte_index].chars().count(),
                None => 0,
            }
        };

        // 单趟 char_indices 定位窗口的字节边界，避免为整篇正文分配 Vec<char>
        // （接近 1MB 的笔记每个命中会额外拷贝 ~4MB）；切片天然落在字符边界上，
        // 不会在多字节字符中间截断。
        let half = max_chars / 2;
        let start_char = char_index.saturating_sub(half);
        let end_char = start_char + max_chars;
        let mut start_byte: Option<usize> = None;
        let mut end_byte = trimmed_text.len();
        let mut truncated_tail = false;
        for (count, (byte_idx, _)) in trimmed_text.char_indices().enumerate() {
            if count == start_char {
                start_byte = Some(byte_idx);
            }
            if count == end_char {
                end_byte = byte_idx;
                truncated_tail = true;
                break;
            }
        }
        let start_byte = start_byte.unwrap_or(trimmed_text.len());
        let mut snippet = trimmed_text[start_byte..end_byte].to_string();
        if start_byte > 0 {
            snippet.insert(0, '…');
        }
        if truncated_tail {
            snippet.push('…');
        }
        Some(snippet)
    }

    /// 搜索笔记并附带正文摘要（单查询，消灭 N+1）。
    ///
    /// 优先 FTS5（bm25 排序），FTS 无结果或失败时回退到 LIKE 子串匹配。
    /// 返回 `(笔记元数据, 摘要)` 列表；摘要基于正文，正文为空时为 None。
    pub fn search_notes_with_snippets(
        db: &VfsDatabase,
        keyword: &str,
        limit: u32,
    ) -> VfsResult<Vec<(VfsNote, Option<String>)>> {
        let conn = db.get_conn_safe()?;
        Self::search_notes_with_snippets_with_conn(&conn, keyword, limit)
    }

    /// 搜索笔记并附带正文摘要（使用现有连接）
    pub fn search_notes_with_snippets_with_conn(
        conn: &Connection,
        keyword: &str,
        limit: u32,
    ) -> VfsResult<Vec<(VfsNote, Option<String>)>> {
        let trimmed = keyword.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }

        if let Some(match_query) = Self::build_fts_match_query(trimmed) {
            let fts_sql = r#"
                SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite,
                       n.created_at, n.updated_at, n.deleted_at,
                       COALESCE(r.data, ''), n.props
                FROM notes_fts
                JOIN notes n ON n.rowid = notes_fts.rowid
                LEFT JOIN resources r ON r.id = n.resource_id
                WHERE notes_fts MATCH ?1 AND n.deleted_at IS NULL
                ORDER BY bm25(notes_fts, 5.0, 1.0), n.updated_at DESC, n.id ASC
                LIMIT ?2
            "#;
            match Self::query_note_hits(conn, fts_sql, params![match_query, limit], trimmed) {
                Ok(hits) if !hits.is_empty() => return Ok(hits),
                Ok(_) => {
                    debug!(
                        "[VFS::NoteRepo] FTS search returned no hits for {:?}, falling back to LIKE",
                        trimmed
                    );
                }
                Err(e) => {
                    warn!(
                        "[VFS::NoteRepo] FTS search failed ({}), falling back to LIKE",
                        e
                    );
                }
            }
        }

        let pattern = format!("%{}%", Self::escape_like_pattern(trimmed));
        let like_sql = r#"
            SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite,
                   n.created_at, n.updated_at, n.deleted_at,
                   COALESCE(r.data, ''), n.props
            FROM notes n
            LEFT JOIN resources r ON r.id = n.resource_id
            WHERE n.deleted_at IS NULL
              AND (n.title LIKE ?1 ESCAPE '\' OR COALESCE(r.data, '') LIKE ?1 ESCAPE '\')
            ORDER BY n.updated_at DESC
            LIMIT ?2
        "#;
        Self::query_note_hits(conn, like_sql, params![pattern, limit], trimmed)
    }

    /// 执行"元数据 8 列 + 正文"查询并组装 (VfsNote, snippet) 结果
    fn query_note_hits(
        conn: &Connection,
        sql: &str,
        query_params: &[&dyn rusqlite::ToSql],
        keyword: &str,
    ) -> VfsResult<Vec<(VfsNote, Option<String>)>> {
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(query_params, |row| {
            let note = Self::row_to_note(row)?;
            let body: String = row.get(8)?;
            Ok((note, body))
        })?;

        let mut hits = Vec::new();
        for row in rows {
            let (note, body) = row?;
            let snippet = Self::make_search_snippet(&body, keyword, 160);
            hits.push((note, snippet));
        }
        Ok(hits)
    }

    /// 列出笔记
    pub fn list_notes(
        db: &VfsDatabase,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::list_notes_with_conn(&conn, search, limit, offset)
    }

    /// 列出笔记（使用现有连接）
    ///
    /// 带关键词时优先走 notes_fts 全文检索（bm25 相关度排序）；
    /// FTS 无结果（如关键词 <3 字符）或查询失败时回退到原 LIKE 路径，
    /// 保证行为不弱于历史实现。返回结构不变，上层调用方无感知。
    pub fn list_notes_with_conn(
        conn: &Connection,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        if let Some(q) = search {
            if !q.trim().is_empty() {
                match Self::search_notes_fts_with_conn(conn, q, limit, offset) {
                    Ok(notes) if !notes.is_empty() => return Ok(notes),
                    Ok(_) => {
                        debug!(
                            "[VFS::NoteRepo] FTS list search empty for {:?}, falling back to LIKE",
                            q
                        );
                    }
                    Err(e) => {
                        warn!(
                            "[VFS::NoteRepo] FTS list search failed ({}), falling back to LIKE",
                            e
                        );
                    }
                }
            }
        }

        let mut sql = String::from(
            r#"
            SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at, n.props
            FROM notes n
            WHERE n.deleted_at IS NULL
            "#,
        );

        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut param_idx = 1;

        // 搜索过滤 - CRITICAL-001修复: 转义LIKE通配符
        if let Some(q) = search {
            sql.push_str(&format!(
                " AND (n.title LIKE ?{} ESCAPE '\\' OR EXISTS (SELECT 1 FROM resources r WHERE r.id = n.resource_id AND r.data LIKE ?{} ESCAPE '\\'))",
                param_idx, param_idx + 1
            ));
            let escaped = Self::escape_like_pattern(q);
            let search_pattern = format!("%{}%", escaped);
            params_vec.push(Box::new(search_pattern.clone()));
            params_vec.push(Box::new(search_pattern));
            param_idx += 2;
        }

        sql.push_str(&format!(
            " ORDER BY n.updated_at DESC LIMIT ?{} OFFSET ?{}",
            param_idx,
            param_idx + 1
        ));
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_note)?;
        let notes: Vec<VfsNote> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(notes)
    }

    /// 列出所有标签（按使用频次排序）
    pub fn list_tags(db: &VfsDatabase, limit: u32) -> VfsResult<Vec<String>> {
        let conn = db.get_conn_safe()?;
        Self::list_tags_with_conn(&conn, limit)
    }

    /// 列出所有标签（使用现有连接）
    ///
    /// 优先查询规范化 note_tags 表（触发器维护，见 V20260722__note_tags.sql），
    /// 按使用笔记数降序、标签名升序排列。规范化表查询失败或为空时，
    /// 回退到历史的全表 tags JSON 扫描，保证健壮性。
    pub fn list_tags_with_conn(conn: &Connection, limit: u32) -> VfsResult<Vec<String>> {
        match Self::list_tags_normalized_with_conn(conn, limit) {
            Ok(tags) if !tags.is_empty() => return Ok(tags),
            Ok(_) => {}
            Err(e) => {
                warn!(
                    "[VFS::NoteRepo] note_tags query failed ({}), falling back to JSON scan",
                    e
                );
            }
        }
        Self::list_tags_json_scan_with_conn(conn, limit)
    }

    /// 通过规范化 note_tags 表统计标签（count 降序）
    fn list_tags_normalized_with_conn(conn: &Connection, limit: u32) -> VfsResult<Vec<String>> {
        // JOIN notes 双重保险：即使 note_tags 中残留了软删除笔记的映射
        //（理论上触发器已清理），也不会统计进来。
        let mut stmt = conn.prepare(
            r#"
            SELECT nt.tag
            FROM note_tags nt
            JOIN notes n ON n.id = nt.note_id AND n.deleted_at IS NULL
            GROUP BY nt.tag
            ORDER BY COUNT(*) DESC, nt.tag ASC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map(params![limit], |row| row.get::<_, String>(0))?;
        let tags: Vec<String> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(tags)
    }

    /// 历史实现：全表扫描 notes.tags JSON（仅作为规范化表的回退路径）
    fn list_tags_json_scan_with_conn(conn: &Connection, limit: u32) -> VfsResult<Vec<String>> {
        let mut stmt = conn.prepare("SELECT tags FROM notes WHERE deleted_at IS NULL")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;

        let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
        for row in rows {
            let tags_json = row?;
            let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
            for tag in tags {
                let trimmed = tag.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let entry = counts.entry(trimmed.to_string()).or_insert(0);
                *entry += 1;
            }
        }

        let mut entries: Vec<(String, usize)> = counts.into_iter().collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));

        Ok(entries
            .into_iter()
            .take(limit as usize)
            .map(|(tag, _)| tag)
            .collect())
    }

    // ========================================================================
    // 删除笔记
    // ========================================================================

    /// 软删除笔记
    pub fn delete_note(db: &VfsDatabase, note_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_note_with_conn(&conn, note_id)
    }

    /// Soft-delete a note only when the caller's OCC baseline is current.
    pub fn delete_note_if_version(
        db: &VfsDatabase,
        note_id: &str,
        expected_updated_at: &str,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let now = next_updated_at(expected_updated_at);
        let updated = conn.execute(
            "UPDATE notes SET deleted_at = ?1, updated_at = ?1 \
             WHERE id = ?2 AND deleted_at IS NULL AND updated_at = ?3",
            params![now, note_id, expected_updated_at],
        )?;
        if updated == 1 {
            info!("[VFS::NoteRepo] OCC soft deleted note: {}", note_id);
            return Ok(());
        }

        let state: Option<(String, Option<String>)> = conn
            .query_row(
                "SELECT updated_at, deleted_at FROM notes WHERE id = ?1",
                params![note_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        match state {
            None => Err(VfsError::NotFound {
                resource_type: "Note".to_string(),
                id: note_id.to_string(),
            }),
            Some((_actual, Some(_))) => Ok(()),
            Some((actual, None)) => Err(VfsError::Conflict {
                key: "notes.conflict".to_string(),
                message: format!(
                    "The note changed before deletion (expected {}, actual {}).",
                    expected_updated_at, actual
                ),
            }),
        }
    }

    /// 软删除笔记（使用现有连接）
    ///
    /// ★ M-009 修复：软删除操作为幂等的。
    /// - 记录不存在 → 返回 NotFound
    /// - 记录存在但已删除 → 返回 Ok（幂等）
    /// - 记录存在且未删除 → 执行软删除
    pub fn delete_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        let updated = conn.execute(
            "UPDATE notes SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, note_id],
        )?;

        if updated == 0 {
            // M-009 fix: 区分「记录不存在」和「已删除（幂等）」
            let exists: bool = conn
                .query_row(
                    "SELECT 1 FROM notes WHERE id = ?1",
                    params![note_id],
                    |_| Ok(true),
                )
                .optional()?
                .unwrap_or(false);

            if exists {
                // 记录存在但 deleted_at IS NOT NULL —— 已删除，幂等成功
                info!(
                    "[VFS::NoteRepo] Note already soft-deleted (idempotent): {}",
                    note_id
                );
                return Ok(());
            } else {
                // 记录在 notes 表中不存在
                return Err(VfsError::NotFound {
                    resource_type: "Note".to_string(),
                    id: note_id.to_string(),
                });
            }
        }

        info!("[VFS::NoteRepo] Soft deleted note: {}", note_id);
        Ok(())
    }

    /// 恢复软删除的笔记
    ///
    /// ★ P1-04 修复：恢复笔记后标记资源需要重新索引
    pub fn restore_note(db: &VfsDatabase, note_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;

        // 1. 获取笔记的 resource_id（在恢复前获取，需要读取已删除笔记）
        let note =
            Self::get_note_including_deleted_with_conn(&conn, note_id)?.ok_or_else(|| {
                VfsError::NotFound {
                    resource_type: "Note".to_string(),
                    id: note_id.to_string(),
                }
            })?;

        // 2. 执行恢复操作
        Self::restore_note_with_conn(&conn, note_id)?;

        // 3. 标记资源需要重新索引
        if let Err(e) = VfsIndexStateRepo::mark_pending(db, &note.resource_id) {
            warn!(
                "[VfsNoteRepo] Failed to mark note for re-indexing after restore: {}",
                e
            );
        }

        Ok(())
    }

    /// 恢复软删除的笔记（使用现有连接）
    ///
    /// 如果恢复位置存在同名笔记，会自动重命名为 "原名 (1)", "原名 (2)" 等
    ///
    /// ★ CONC-02 修复：恢复笔记时同步恢复 folder_items 记录，
    /// 确保恢复后的笔记在 Learning Hub 中可见
    pub fn restore_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<()> {
        conn.execute("SAVEPOINT restore_note", [])?;
        let tx_result: VfsResult<(String, String, usize)> = (|| {
            let now = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let now_ms = chrono::Utc::now().timestamp_millis();

            // 1. 获取要恢复的笔记信息（需要读取已删除笔记）
            let note =
                Self::get_note_including_deleted_with_conn(conn, note_id)?.ok_or_else(|| {
                    VfsError::NotFound {
                        resource_type: "Note".to_string(),
                        id: note_id.to_string(),
                    }
                })?;

            // 2. 原子化重命名恢复：避免「先查重后更新」并发 TOCTOU
            let mut restored_title: Option<String> = None;
            for idx in 0..1000usize {
                let candidate = if idx == 0 {
                    note.title.clone()
                } else {
                    format!("{} ({})", note.title, idx)
                };
                let updated = conn.execute(
                    r#"
                    UPDATE notes
                    SET deleted_at = NULL, title = ?1, updated_at = ?2
                    WHERE id = ?3
                      AND deleted_at IS NOT NULL
                      AND NOT EXISTS (
                        SELECT 1 FROM notes
                        WHERE title = ?1 AND deleted_at IS NULL AND id != ?3
                      )
                    "#,
                    params![candidate, now, note_id],
                )?;

                if updated == 1 {
                    restored_title = Some(candidate);
                    break;
                }

                // 不是重名冲突，而是记录已不存在/已恢复
                let still_deleted: Option<i32> = conn
                    .query_row(
                        "SELECT 1 FROM notes WHERE id = ?1 AND deleted_at IS NOT NULL",
                        params![note_id],
                        |row| row.get(0),
                    )
                    .optional()?;
                if still_deleted.is_none() {
                    return Err(VfsError::NotFound {
                        resource_type: "Note".to_string(),
                        id: note_id.to_string(),
                    });
                }
            }
            let new_title = restored_title.ok_or_else(|| VfsError::Conflict {
                key: "note.restore.title_conflict".to_string(),
                message: format!("恢复笔记失败：标题冲突重试次数过多 ({})", note_id),
            })?;

            // 4. ★ CONC-02 修复：恢复 folder_items 记录
            let restored_folder_item_id: Option<String> = conn
                .query_row(
                    r#"
                    SELECT id FROM folder_items
                    WHERE item_type = 'note' AND item_id = ?1 AND deleted_at IS NOT NULL
                    ORDER BY COALESCE(updated_at, created_at) DESC, created_at DESC
                    LIMIT 1
                    "#,
                    params![note_id],
                    |row| row.get(0),
                )
                .optional()?;
            let folder_items_restored = if let Some(fi_id) = restored_folder_item_id {
                conn.execute(
                    "UPDATE folder_items SET deleted_at = NULL, updated_at = ?1 WHERE id = ?2",
                    params![now_ms, fi_id],
                )?
            } else {
                0
            };

            Ok((note.title, new_title, folder_items_restored))
        })();

        match tx_result {
            Ok((old_title, new_title, folder_items_restored)) => {
                conn.execute("RELEASE restore_note", [])?;
                if new_title != old_title {
                    info!(
                        "[VFS::NoteRepo] Restored note with rename: {} -> {} ({}), folder_items restored: {}",
                        old_title, new_title, note_id, folder_items_restored
                    );
                } else {
                    info!(
                        "[VFS::NoteRepo] Restored note: {}, folder_items restored: {}",
                        note_id, folder_items_restored
                    );
                }
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO restore_note", []);
                let _ = conn.execute("RELEASE restore_note", []);
                Err(e)
            }
        }
    }

    /// 生成唯一的笔记标题（避免同名冲突）
    ///
    /// 如果 base_title 已存在，会尝试 "base_title (1)", "base_title (2)" 等
    ///
    pub fn generate_unique_note_title_with_conn(
        conn: &Connection,
        base_title: &str,
        exclude_id: Option<&str>,
    ) -> VfsResult<String> {
        // 检查原始标题是否可用
        if !Self::note_title_exists_with_conn(conn, base_title, exclude_id)? {
            return Ok(base_title.to_string());
        }

        // 尝试添加后缀
        for i in 1..100 {
            let new_title = format!("{} ({})", base_title, i);
            if !Self::note_title_exists_with_conn(conn, &new_title, exclude_id)? {
                return Ok(new_title);
            }
        }

        // 极端情况：使用时间戳
        let timestamp = chrono::Utc::now().timestamp_millis();
        Ok(format!("{} ({})", base_title, timestamp))
    }

    /// 检查笔记标题是否已存在
    ///
    fn note_title_exists_with_conn(
        conn: &Connection,
        title: &str,
        exclude_id: Option<&str>,
    ) -> VfsResult<bool> {
        let count: i64 = if let Some(eid) = exclude_id {
            conn.query_row(
                "SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL AND id != ?2",
                params![title, eid],
                |row| row.get(0),
            )?
        } else {
            conn.query_row(
                "SELECT COUNT(*) FROM notes WHERE title = ?1 AND deleted_at IS NULL",
                params![title],
                |row| row.get(0),
            )?
        };
        Ok(count > 0)
    }

    /// 永久删除笔记
    pub fn purge_note(db: &VfsDatabase, note_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_note_with_conn(&conn, note_id)
    }

    /// 永久删除笔记（带事务保护）
    ///
    /// ★ 2026-02-01 修复：删除关联的 folder_items 和 resources 记录
    /// 使用事务确保所有删除操作的原子性，防止数据不一致
    pub fn purge_note_with_conn(conn: &Connection, note_id: &str) -> VfsResult<()> {
        info!("[VFS::NoteRepo] Purging note: {}", note_id);

        // 先获取笔记信息，确认存在（在事务外检查，减少事务持有时间）
        // ★ M-008：使用 including_deleted 版本，因为 purge 操作需要读取已软删除的笔记
        let note = match Self::get_note_including_deleted_with_conn(conn, note_id)? {
            Some(n) => {
                debug!(
                    "[VFS::NoteRepo] Found note: id={}, title={}, resource_id={}",
                    n.id, n.title, n.resource_id
                );
                n
            }
            None => {
                // ★ 笔记在 notes 表中不存在，但可能在 folder_items 中有记录
                // 尝试删除 folder_items 中的记录（兼容旧数据）
                warn!(
                    "[VFS::NoteRepo] Note not found in notes table: {}, trying folder_items cleanup",
                    note_id
                );
                let fi_deleted = conn.execute(
                    "DELETE FROM folder_items WHERE item_type = 'note' AND item_id = ?1",
                    params![note_id],
                )?;
                if fi_deleted > 0 {
                    info!(
                        "[VFS::NoteRepo] Deleted {} orphan folder_items for: {}",
                        fi_deleted, note_id
                    );
                    return Ok(());
                }
                return Err(VfsError::NotFound {
                    resource_type: "Note".to_string(),
                    id: note_id.to_string(),
                });
            }
        };

        // 保存主 resource_id
        let main_resource_id = note.resource_id.clone();

        // ★ 使用 SAVEPOINT 包装所有删除操作，确保原子性
        // ★ 2026-06-10 修复（审阅问题 A2 关联）：改 BEGIN IMMEDIATE 为 SAVEPOINT，
        // 支持在外层事务（如文件夹树 purge）内嵌套调用。
        conn.execute("SAVEPOINT vfs_note_purge_tx", [])
            .map_err(|e| {
                tracing::error!("[VFS::NoteRepo] Failed to begin savepoint for purge: {}", e);
                VfsError::Database(format!("Failed to begin savepoint: {}", e))
            })?;

        // 定义回滚宏
        macro_rules! rollback_on_error {
            ($result:expr, $msg:expr) => {
                match $result {
                    Ok(v) => v,
                    Err(e) => {
                        tracing::error!("[VFS::NoteRepo] {}: {}", $msg, e);
                        let _ = conn.execute_batch(
                            "ROLLBACK TO SAVEPOINT vfs_note_purge_tx; RELEASE SAVEPOINT vfs_note_purge_tx;",
                        );
                        return Err(VfsError::Database(format!("{}: {}", $msg, e)));
                    }
                }
            };
        }

        // ★ 删除 folder_items 中的关联记录（必须先删除，否则前端仍会显示）
        let fi_deleted = rollback_on_error!(
            conn.execute(
                "DELETE FROM folder_items WHERE item_type = 'note' AND item_id = ?1",
                params![note_id]
            ),
            "Failed to delete folder_items"
        );
        info!(
            "[VFS::NoteRepo] Deleted {} folder_items for note: {}",
            fi_deleted, note_id
        );

        // ★ 删除笔记记录
        let deleted = rollback_on_error!(
            conn.execute("DELETE FROM notes WHERE id = ?1", params![note_id]),
            "Failed to delete note"
        );

        if deleted == 0 {
            // ★ 如果没有删除任何记录，回滚并返回错误
            tracing::error!(
                "[VFS::NoteRepo] CRITICAL: Note record disappeared during deletion: {}",
                note_id
            );
            let _ = conn.execute_batch(
                "ROLLBACK TO SAVEPOINT vfs_note_purge_tx; RELEASE SAVEPOINT vfs_note_purge_tx;",
            );
            return Err(VfsError::Other(format!(
                "Note record disappeared during deletion: {}. This may indicate a race condition.",
                note_id
            )));
        }

        info!(
            "[VFS::NoteRepo] Successfully deleted note record: {} (deleted {} record(s))",
            note_id, deleted
        );

        // ★ 删除资源前检查是否仍被其他笔记引用，避免误删共享资源
        // ★ 2026-06-12 修复（审阅问题 S5）：除当前 resource_id 外，一并收集
        // 该笔记历史编辑遗留的旧版本资源（source_id = note_id），防止泄漏。
        let mut resource_ids: HashSet<String> = HashSet::new();
        resource_ids.insert(main_resource_id.clone());
        {
            let mut stmt = rollback_on_error!(
                conn.prepare(
                    "SELECT id FROM resources WHERE source_id = ?1 AND source_table = 'notes'"
                ),
                "Failed to prepare superseded resources query"
            );
            let rows = rollback_on_error!(
                stmt.query_map(params![note_id], |row| row.get::<_, String>(0)),
                "Failed to query superseded resources"
            );
            for row in rows.flatten() {
                resource_ids.insert(row);
            }
        }

        let mut deleted_resources = 0usize;
        for resource_id in resource_ids {
            let note_refs: i64 = rollback_on_error!(
                conn.query_row(
                    "SELECT COUNT(*) FROM notes WHERE resource_id = ?1",
                    params![&resource_id],
                    |row| row.get(0)
                ),
                "Failed to query notes resource refs"
            );
            if note_refs > 0 {
                debug!(
                    "[VFS::NoteRepo] Skip deleting resource {} (refs: notes={})",
                    resource_id, note_refs
                );
                continue;
            }

            // ★ 2026-06-12（审阅问题 S5 / 第二轮）：统一入口清理索引产物（含 Lance 向量入列）
            rollback_on_error!(
                super::index_unit_repo::purge_index_artifacts_by_resource(conn, &resource_id),
                "Failed to delete index artifacts"
            );
            let res_deleted = rollback_on_error!(
                conn.execute("DELETE FROM resources WHERE id = ?1", params![&resource_id]),
                "Failed to delete resource"
            );
            if res_deleted > 0 {
                deleted_resources += res_deleted as usize;
                debug!("[VFS::NoteRepo] Deleted resource: {}", resource_id);
            }
        }

        info!(
            "[VFS::NoteRepo] Deleted {} resource(s) for note: {}",
            deleted_resources, note_id
        );

        // ★ 提交（释放保存点；若存在外层事务则随外层一起提交）
        conn.execute_batch("RELEASE SAVEPOINT vfs_note_purge_tx")
            .map_err(|e| {
                tracing::error!("[VFS::NoteRepo] Failed to release purge savepoint: {}", e);
                let _ = conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT vfs_note_purge_tx; RELEASE SAVEPOINT vfs_note_purge_tx;",
                );
                VfsError::Database(format!("Failed to release savepoint: {}", e))
            })?;

        info!(
            "[VFS::NoteRepo] Successfully completed note deletion: {}",
            note_id
        );

        Ok(())
    }

    /// 收藏/取消收藏笔记
    pub fn set_favorite(db: &VfsDatabase, note_id: &str, is_favorite: bool) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::set_favorite_with_conn(&conn, note_id, is_favorite)
    }

    /// 收藏/取消收藏笔记（使用现有连接）
    pub fn set_favorite_with_conn(
        conn: &Connection,
        note_id: &str,
        is_favorite: bool,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now()
            .format("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string();

        conn.execute(
            "UPDATE notes SET is_favorite = ?1, updated_at = ?2 WHERE id = ?3",
            params![is_favorite as i32, now, note_id],
        )?;

        Ok(())
    }

    fn normalize_note_props(
        props: serde_json::Value,
    ) -> VfsResult<(Option<String>, Option<serde_json::Value>)> {
        let map = props.as_object().ok_or_else(|| VfsError::InvalidArgument {
            param: "props".to_string(),
            reason: "props 必须是键值对象".to_string(),
        })?;
        Self::validate_note_props(map)?;

        // 键统一去两侧空白；validate_note_props 已按 trim + 小写拒绝歧义重复键。
        let normalized: serde_json::Map<String, serde_json::Value> = map
            .iter()
            .map(|(key, value)| (key.trim().to_string(), value.clone()))
            .collect();
        if normalized.is_empty() {
            return Ok((None, None));
        }

        let value = serde_json::Value::Object(normalized);
        let raw = serde_json::to_string(&value)
            .map_err(|error| VfsError::Serialization(error.to_string()))?;
        Ok((Some(raw), Some(value)))
    }

    /// 原子更新笔记元数据（title/tags/is_favorite/props）。
    pub fn update_note_metadata(
        db: &VfsDatabase,
        note_id: &str,
        update: VfsNoteMetadataUpdate,
    ) -> VfsResult<VfsNote> {
        let conn = db.get_conn_safe()?;
        Self::update_note_metadata_with_conn(&conn, note_id, update)
    }

    /// 原子更新笔记元数据（使用现有连接）。
    ///
    /// 所有校验先于写入完成，最终只发出一条 UPDATE；若提供
    /// `expected_updated_at`，同一条 UPDATE 同时执行 CAS。
    pub fn update_note_metadata_with_conn(
        conn: &Connection,
        note_id: &str,
        update: VfsNoteMetadataUpdate,
    ) -> VfsResult<VfsNote> {
        let VfsNoteMetadataUpdate {
            title,
            tags,
            is_favorite,
            props,
            expected_updated_at,
        } = update;

        if let Some(ref title) = title {
            Self::validate_title(title)?;
        }
        if let Some(ref tags) = tags {
            Self::validate_tags(tags)?;
        }
        let normalized_props = props.map(Self::normalize_note_props).transpose()?;

        let current =
            Self::get_note_with_conn(conn, note_id)?.ok_or_else(|| VfsError::NotFound {
                resource_type: "Note".to_string(),
                id: note_id.to_string(),
            })?;
        let expected = expected_updated_at
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string);
        if let Some(ref expected) = expected {
            if expected.as_str() != current.updated_at.as_str() {
                return Err(VfsError::Conflict {
                    key: "notes.conflict".to_string(),
                    message: "The note has been updated elsewhere, please refresh.".to_string(),
                });
            }
        }

        if title.is_none() && tags.is_none() && is_favorite.is_none() && normalized_props.is_none()
        {
            return Ok(current);
        }

        let now = next_updated_at(&current.updated_at);
        let mut assignments = Vec::new();
        let mut values: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        let mut push_assignment = |column: &str, value: Box<dyn rusqlite::ToSql>| {
            assignments.push(format!("{column} = ?{}", values.len() + 1));
            values.push(value);
        };
        if let Some(title) = title {
            push_assignment("title", Box::new(title));
        }
        if let Some(tags) = tags {
            let tags_json = serde_json::to_string(&tags)
                .map_err(|error| VfsError::Serialization(error.to_string()))?;
            push_assignment("tags", Box::new(tags_json));
        }
        if let Some(is_favorite) = is_favorite {
            push_assignment("is_favorite", Box::new(is_favorite as i32));
        }
        if let Some((props_json, _normalized_value)) = normalized_props {
            // None binds SQL NULL, which is the canonical representation for
            // both an absent property object and an explicitly empty object.
            push_assignment("props", Box::new(props_json));
        }
        push_assignment("updated_at", Box::new(now));
        drop(push_assignment);

        let id_param = values.len() + 1;
        values.push(Box::new(note_id.to_string()));
        let mut sql = format!(
            "UPDATE notes SET {} WHERE id = ?{} AND deleted_at IS NULL",
            assignments.join(", "),
            id_param
        );
        if let Some(expected) = expected.as_ref() {
            let expected_param = values.len() + 1;
            values.push(Box::new(expected.clone()));
            sql.push_str(&format!(" AND updated_at = ?{expected_param}"));
        }
        let value_refs: Vec<&dyn rusqlite::ToSql> =
            values.iter().map(|value| value.as_ref()).collect();
        let updated_rows = conn.execute(&sql, value_refs.as_slice())?;
        if updated_rows == 0 {
            return Err(if expected.is_some() {
                VfsError::Conflict {
                    key: "notes.conflict".to_string(),
                    message: "The note has been updated elsewhere, please refresh.".to_string(),
                }
            } else {
                VfsError::NotFound {
                    resource_type: "Note".to_string(),
                    id: note_id.to_string(),
                }
            });
        }

        info!("[VFS::NoteRepo] Updated note metadata: {}", note_id);
        Self::get_note_with_conn(conn, note_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "Note".to_string(),
            id: note_id.to_string(),
        })
    }

    /// 整对象替换笔记自定义属性（notes.props，见 V20260824__note_props.sql）。
    ///
    /// - `props` 必须是 JSON 对象；键去两侧空白后写入；空对象落库为 NULL。
    /// - 校验规则见 [`Self::validate_note_props`]（与前端编辑器一致）。
    /// - 与 tags 替换同语义：调用方（属性页编辑器）持有完整对象。
    pub fn set_note_props(
        db: &VfsDatabase,
        note_id: &str,
        props: serde_json::Value,
    ) -> VfsResult<VfsNote> {
        let conn = db.get_conn_safe()?;
        Self::set_note_props_with_conn(&conn, note_id, props)
    }

    /// 整对象替换笔记自定义属性（使用现有连接）
    pub fn set_note_props_with_conn(
        conn: &Connection,
        note_id: &str,
        props: serde_json::Value,
    ) -> VfsResult<VfsNote> {
        Self::update_note_metadata_with_conn(
            conn,
            note_id,
            VfsNoteMetadataUpdate {
                props: Some(props),
                ..Default::default()
            },
        )
    }

    /// 列出已删除的笔记（回收站）
    ///
    pub fn list_deleted_notes(
        db: &VfsDatabase,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::list_deleted_notes_with_conn(&conn, limit, offset)
    }

    /// 列出已删除的笔记（使用现有连接）
    pub fn list_deleted_notes_with_conn(
        conn: &Connection,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props
            FROM notes
            WHERE deleted_at IS NOT NULL
            ORDER BY deleted_at DESC
            LIMIT ?1 OFFSET ?2
            "#,
        )?;

        let rows = stmt.query_map(params![limit, offset], Self::row_to_note)?;
        let notes: Vec<VfsNote> = rows
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[NoteRepo] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();
        Ok(notes)
    }

    /// 统计已删除的笔记数量
    pub fn count_deleted_notes(db: &VfsDatabase) -> VfsResult<i64> {
        let conn = db.get_conn_safe()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM notes WHERE deleted_at IS NOT NULL",
            [],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    /// 清空回收站（永久删除所有已删除的笔记）
    ///
    pub fn purge_deleted_notes(db: &VfsDatabase) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::purge_deleted_notes_with_conn(&conn)
    }

    /// 清空回收站（使用现有连接）
    ///
    /// ★ 2026-07 修复：整个清空操作包在一个 SAVEPOINT 里（原实现逐条自提交，
    /// 中途失败会留下"删了一半"的回收站，且大回收站逐条 fsync 极慢）。
    /// SAVEPOINT 可安全嵌套在调用方的外层事务内。
    pub fn purge_deleted_notes_with_conn(conn: &Connection) -> VfsResult<usize> {
        let note_ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM notes WHERE deleted_at IS NOT NULL")?;
            let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        if note_ids.is_empty() {
            return Ok(0);
        }

        conn.execute("SAVEPOINT purge_deleted_notes", [])?;
        let result = (|| -> VfsResult<usize> {
            let mut deleted_count = 0usize;
            for note_id in &note_ids {
                Self::purge_note_with_conn(conn, note_id)?;
                deleted_count += 1;
            }
            Ok(deleted_count)
        })();

        match result {
            Ok(deleted_count) => {
                conn.execute("RELEASE purge_deleted_notes", [])?;
                info!("[VFS::NoteRepo] Purged {} deleted notes", deleted_count);
                Ok(deleted_count)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO purge_deleted_notes", []);
                let _ = conn.execute("RELEASE purge_deleted_notes", []);
                Err(e)
            }
        }
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 从行数据构建 VfsNote
    ///
    /// 列顺序（位置索引 0-7）：id, resource_id, title, tags, is_favorite,
    /// created_at, updated_at, deleted_at；props 按列名读取（可缺省）
    fn row_to_note(row: &rusqlite::Row) -> rusqlite::Result<VfsNote> {
        let tags_json: String = row.get(3)?;
        let note_id: String = row.get(0)?;
        let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_else(|e| {
            tracing::warn!(
                "[VFS::NoteRepo] Failed to parse tags JSON for note {}: {}, using empty array. Raw JSON: {}",
                note_id, e, tags_json
            );
            Vec::new()
        });

        // props 按列名读取（而非位置索引）：部分查询在第 8 列放正文
        // （query_note_hits），props 统一追加在列清单末尾；未选出该列的
        // 查询（InvalidColumnName）优雅回退为 None，避免逐查询硬编码索引。
        //
        // 回退语义分两类，不可混淆：
        // - InvalidColumnName = 「查询没选这列」，正常投影路径，静默 None；
        // - 其余取值错误与畸形内容（JSON 解析失败 / 非 object / 空 object）
        //   = 数据异常，warn + 原子计数后 None（见 vfs::note_props）。
        let props: Option<serde_json::Value> = match row.get::<_, Option<String>>("props") {
            Ok(raw) => note_props::parse_props_cell(&note_id, raw.as_deref()),
            Err(rusqlite::Error::InvalidColumnName(_)) => None,
            Err(read_error) => {
                note_props::record_malformed_props(
                    &note_id,
                    note_props::MalformedPropsKind::ColumnRead,
                    &read_error.to_string(),
                );
                None
            }
        };

        Ok(VfsNote {
            id: note_id,
            resource_id: row.get(1)?,
            title: row.get(2)?,
            tags,
            is_favorite: row.get::<_, i32>(4)? != 0,
            created_at: row.get(5)?,
            updated_at: row.get(6)?,
            deleted_at: row.get(7)?,
            props,
        })
    }

    // ========================================================================
    // ★ Prompt 4: 不依赖 subject 的新方法
    // ========================================================================

    /// 在指定文件夹中创建笔记
    ///
    /// ★ Prompt 4: 新增方法，创建笔记同时自动创建 folder_items 记录
    ///
    /// ## 参数
    /// - `params`: 创建笔记的参数
    /// - `folder_id`: 目标文件夹 ID（None 表示根目录）
    pub fn create_note_in_folder(
        db: &VfsDatabase,
        params: VfsCreateNoteParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsNote> {
        let conn = db.get_conn_safe()?;
        Self::create_note_in_folder_with_conn(&conn, params, folder_id)
    }

    /// 在指定文件夹中创建笔记（使用现有连接）
    ///
    /// ★ CONC-01 修复：使用事务保护，防止步骤 2 成功但步骤 3 失败导致"孤儿资源"
    pub fn create_note_in_folder_with_conn(
        conn: &Connection,
        params: VfsCreateNoteParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsNote> {
        // 开始事务
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = Self::create_note_in_folder_uncommitted(conn, params, folder_id);

        match result {
            Ok(note) => {
                conn.execute("COMMIT", [])?;
                Ok(note)
            }
            Err(e) => {
                // 回滚事务，忽略回滚本身的错误
                let _ = conn.execute("ROLLBACK", []);
                Err(e)
            }
        }
    }

    /// Create a note and its folder membership inside a transaction owned by
    /// the caller. This is used when another durable record (for example an
    /// idempotency receipt) must commit atomically with the note mutation.
    pub(crate) fn create_note_in_folder_uncommitted(
        conn: &Connection,
        params: VfsCreateNoteParams,
        folder_id: Option<&str>,
    ) -> VfsResult<VfsNote> {
        if let Some(fid) = folder_id {
            if !VfsFolderRepo::folder_exists_with_conn(conn, fid)? {
                return Err(VfsError::NotFound {
                    resource_type: "Folder".to_string(),
                    id: fid.to_string(),
                });
            }
        }

        let note = Self::create_note_with_conn(conn, params)?;
        let folder_item = VfsFolderItem::new(
            folder_id.map(|s| s.to_string()),
            "note".to_string(),
            note.id.clone(),
        );
        VfsFolderRepo::add_item_to_folder_with_conn(conn, &folder_item)?;
        debug!(
            "[VFS::NoteRepo] Created note {} in folder {:?}",
            note.id, folder_id
        );
        Ok(note)
    }

    /// 删除笔记（同时删除 folder_items 记录）
    ///
    /// ★ Prompt 4: 新增方法，删除笔记时自动清理 folder_items
    pub fn delete_note_with_folder_item(db: &VfsDatabase, note_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_note_with_folder_item_with_conn(&conn, note_id)
    }

    /// 删除笔记（使用现有连接，同时软删除 folder_items 记录）
    ///
    /// ★ CONC-02 修复：将 folder_items 的硬删除改为软删除，
    /// 确保恢复笔记时可以同步恢复 folder_items 记录
    pub fn delete_note_with_folder_item_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<()> {
        conn.execute("SAVEPOINT delete_note_with_folder_item", [])?;
        let tx_result: VfsResult<()> = (|| {
            // 1. 软删除笔记
            Self::delete_note_with_conn(conn, note_id)?;

            // 2. 软删除 folder_items 记录（而不是硬删除）
            // ★ P0 修复：deleted_at 是 TEXT 列，updated_at 是 INTEGER 列，必须分开处理
            let now_str = chrono::Utc::now()
                .format("%Y-%m-%dT%H:%M:%S%.3fZ")
                .to_string();
            let now_ms = chrono::Utc::now().timestamp_millis();
            conn.execute(
                "UPDATE folder_items SET deleted_at = ?1, updated_at = ?2 WHERE item_type = 'note' AND item_id = ?3 AND deleted_at IS NULL",
                params![now_str, now_ms, note_id],
            )?;

            // 3. 标记索引为 disabled，防止搜索命中已删除内容
            let resource_id: Option<String> = conn
                .query_row(
                    "SELECT resource_id FROM notes WHERE id = ?1",
                    params![note_id],
                    |row| row.get(0),
                )
                .optional()?;
            if let Some(ref rid) = resource_id {
                let disabled_count = conn.execute(
                    "UPDATE vfs_index_units SET text_state = 'disabled', mm_state = 'disabled' WHERE resource_id = ?1",
                    params![rid],
                )?;
                if disabled_count > 0 {
                    info!(
                        "[VFS::NoteRepo] Disabled {} index units for soft-deleted note {} (resource={})",
                        disabled_count, note_id, rid
                    );
                }
            }

            debug!(
                "[VFS::NoteRepo] Soft deleted note {} and its folder_items",
                note_id
            );
            Ok(())
        })();
        match tx_result {
            Ok(()) => {
                conn.execute("RELEASE delete_note_with_folder_item", [])?;
                Ok(())
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO delete_note_with_folder_item", []);
                let _ = conn.execute("RELEASE delete_note_with_folder_item", []);
                Err(e)
            }
        }
    }

    /// 永久删除笔记（同时删除 folder_items 记录）
    ///
    /// ★ Prompt 4: 新增方法，永久删除笔记时自动清理 folder_items
    pub fn purge_note_with_folder_item(db: &VfsDatabase, note_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::purge_note_with_folder_item_with_conn(&conn, note_id)
    }

    /// 永久删除笔记（使用现有连接，同时删除 folder_items 记录）
    pub fn purge_note_with_folder_item_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<()> {
        // 1. 永久删除笔记
        Self::purge_note_with_conn(conn, note_id)?;

        // 2. 删除 folder_items 记录
        VfsFolderRepo::remove_item_by_item_id_with_conn(conn, "note", note_id)?;

        Ok(())
    }

    /// 按文件夹列出笔记
    ///
    /// ★ Prompt 4: 新增方法，通过 folder_items 查询笔记，不依赖 subject
    pub fn list_notes_by_folder(
        db: &VfsDatabase,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::list_notes_by_folder_with_conn(&conn, folder_id, limit, offset)
    }

    /// 按文件夹列出笔记（使用现有连接）
    pub fn list_notes_by_folder_with_conn(
        conn: &Connection,
        folder_id: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let sql = r#"
            SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite, n.created_at, n.updated_at, n.deleted_at, n.props
            FROM notes n
            JOIN folder_items fi ON fi.item_type = 'note' AND fi.item_id = n.id
            WHERE fi.folder_id IS ?1 AND n.deleted_at IS NULL AND fi.deleted_at IS NULL
            GROUP BY n.id
            ORDER BY MIN(fi.sort_order) ASC, n.updated_at DESC
            LIMIT ?2 OFFSET ?3
        "#;

        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map(params![folder_id, limit, offset], Self::row_to_note)?;

        let notes: Vec<VfsNote> = rows
            .filter_map(|r| match r {
                Ok(val) => Some(val),
                Err(e) => {
                    log::warn!("[NoteRepo] Skipping malformed row: {}", e);
                    None
                }
            })
            .collect();
        debug!(
            "[VFS::NoteRepo] list_notes_by_folder({:?}): {} notes",
            folder_id,
            notes.len()
        );
        Ok(notes)
    }

    /// 获取笔记的 ResourceLocation
    ///
    /// ★ Prompt 4: 新增方法，获取笔记在 VFS 中的完整路径信息
    pub fn get_note_location(
        db: &VfsDatabase,
        note_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        let conn = db.get_conn_safe()?;
        Self::get_note_location_with_conn(&conn, note_id)
    }

    /// 获取笔记的 ResourceLocation（使用现有连接）
    pub fn get_note_location_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<Option<ResourceLocation>> {
        VfsFolderRepo::get_resource_location_with_conn(conn, "note", note_id)
    }

    /// 列出所有笔记（不按 subject 过滤）
    ///
    /// ★ Prompt 4: 新增方法，替代 list_notes 中按 subject 过滤的场景
    pub fn list_all_notes(
        db: &VfsDatabase,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::list_all_notes_with_conn(&conn, search, limit, offset)
    }

    /// 列出所有笔记（使用现有连接）
    pub fn list_all_notes_with_conn(
        conn: &Connection,
        search: Option<&str>,
        limit: u32,
        offset: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        Self::list_notes_with_conn(conn, search, limit, offset)
    }

    // ========================================================================
    // 标签检索（note_tags 规范化表，见 V20260722__note_tags.sql）
    // ========================================================================

    /// 按标签（AND 语义）+ 可选关键词搜索笔记，附带正文摘要。
    ///
    /// - 标签匹配走规范化 note_tags 表（触发器维护），大小写不敏感
    ///   （ASCII 范围；CJK 无大小写概念），消除历史 `tags LIKE '%"tag"%'` 假阳性。
    /// - 关键词 >= 3 字符时叠加 notes_fts 子查询过滤，< 3 字符回退 LIKE。
    /// - 排序：updated_at 降序（标签过滤场景以最近编辑优先）。
    pub fn search_notes_by_tags_with_snippets(
        db: &VfsDatabase,
        keyword: Option<&str>,
        tags: &[String],
        limit: u32,
    ) -> VfsResult<Vec<(VfsNote, Option<String>)>> {
        let conn = db.get_conn_safe()?;
        Self::search_notes_by_tags_with_snippets_with_conn(&conn, keyword, tags, limit)
    }

    /// 按标签 + 可选关键词搜索笔记（使用现有连接）
    pub fn search_notes_by_tags_with_snippets_with_conn(
        conn: &Connection,
        keyword: Option<&str>,
        tags: &[String],
        limit: u32,
    ) -> VfsResult<Vec<(VfsNote, Option<String>)>> {
        let mut lowered: Vec<String> = tags
            .iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        lowered.sort();
        lowered.dedup();
        if lowered.is_empty() {
            return match keyword {
                Some(kw) if !kw.trim().is_empty() => {
                    Self::search_notes_with_snippets_with_conn(conn, kw, limit)
                }
                _ => Ok(Vec::new()),
            };
        }

        let trimmed_kw = keyword.map(|k| k.trim()).filter(|k| !k.is_empty());

        let tag_placeholders = vec!["?"; lowered.len()].join(",");
        let mut sql = format!(
            r#"
            SELECT n.id, n.resource_id, n.title, n.tags, n.is_favorite,
                   n.created_at, n.updated_at, n.deleted_at,
                   COALESCE(r.data, ''), n.props
            FROM notes n
            JOIN note_tags nt ON nt.note_id = n.id
            LEFT JOIN resources r ON r.id = n.resource_id
            WHERE n.deleted_at IS NULL
              AND LOWER(nt.tag) IN ({})
            "#,
            tag_placeholders
        );

        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        for tag in &lowered {
            params_vec.push(Box::new(tag.clone()));
        }

        if let Some(kw) = trimmed_kw {
            if let Some(match_query) = Self::build_fts_match_query(kw) {
                sql.push_str(
                    " AND n.rowid IN (SELECT rowid FROM notes_fts WHERE notes_fts MATCH ?)",
                );
                params_vec.push(Box::new(match_query));
            } else {
                let pattern = format!("%{}%", Self::escape_like_pattern(kw));
                sql.push_str(
                    r#" AND (n.title LIKE ? ESCAPE '\' OR COALESCE(r.data, '') LIKE ? ESCAPE '\')"#,
                );
                params_vec.push(Box::new(pattern.clone()));
                params_vec.push(Box::new(pattern));
            }
        }

        sql.push_str(
            " GROUP BY n.id HAVING COUNT(DISTINCT LOWER(nt.tag)) = ? \
             ORDER BY n.updated_at DESC, n.id ASC LIMIT ?",
        );
        params_vec.push(Box::new(lowered.len() as i64));
        params_vec.push(Box::new(limit));

        let snippet_kw = trimmed_kw.unwrap_or("");
        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            let note = Self::row_to_note(row)?;
            let body: String = row.get(8)?;
            Ok((note, body))
        })?;

        let mut hits = Vec::new();
        for row in rows {
            let (note, body) = row?;
            let snippet = Self::make_search_snippet(&body, snippet_kw, 160);
            hits.push((note, snippet));
        }
        Ok(hits)
    }

    /// 返回同时拥有全部给定标签的笔记 id（AND 语义，大小写不敏感）。
    ///
    /// 供高级列表过滤（notes_manager::list_notes_advanced 等）接线使用；
    /// 旧的 JSON 过滤路径保持不变，本函数为新增，不改任何既有签名。
    pub fn note_ids_with_all_tags_with_conn(
        conn: &Connection,
        tags: &[String],
    ) -> VfsResult<Vec<String>> {
        let mut lowered: Vec<String> = tags
            .iter()
            .map(|t| t.trim().to_lowercase())
            .filter(|t| !t.is_empty())
            .collect();
        lowered.sort();
        lowered.dedup();
        if lowered.is_empty() {
            return Ok(Vec::new());
        }

        let placeholders = vec!["?"; lowered.len()].join(",");
        let sql = format!(
            "SELECT nt.note_id
             FROM note_tags nt
             JOIN notes n ON n.id = nt.note_id AND n.deleted_at IS NULL
             WHERE LOWER(nt.tag) IN ({})
             GROUP BY nt.note_id
             HAVING COUNT(DISTINCT LOWER(nt.tag)) = ?",
            placeholders
        );
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        for tag in &lowered {
            params_vec.push(Box::new(tag.clone()));
        }
        params_vec.push(Box::new(lowered.len() as i64));

        let mut stmt = conn.prepare(&sql)?;
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let rows = stmt.query_map(params_refs.as_slice(), |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ========================================================================
    // 标题检索（mention 自动补全）
    // ========================================================================

    /// 按标题子串搜索笔记（前缀命中优先、短标题优先、最近编辑次之）。
    ///
    /// 用于 `[[` / `@` mention 自动补全场景：标题是首要匹配维度，
    /// LIKE 通配符已转义。
    pub fn search_note_titles(
        db: &VfsDatabase,
        keyword: &str,
        limit: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let conn = db.get_conn_safe()?;
        Self::search_note_titles_with_conn(&conn, keyword, limit)
    }

    /// 按标题子串搜索笔记（使用现有连接）
    pub fn search_note_titles_with_conn(
        conn: &Connection,
        keyword: &str,
        limit: u32,
    ) -> VfsResult<Vec<VfsNote>> {
        let trimmed = keyword.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let escaped = Self::escape_like_pattern(trimmed);
        let contains = format!("%{}%", escaped);
        let prefix = format!("{}%", escaped);

        let mut stmt = conn.prepare(
            r#"
            SELECT id, resource_id, title, tags, is_favorite, created_at, updated_at, deleted_at, props
            FROM notes
            WHERE deleted_at IS NULL AND title LIKE ?1 ESCAPE '\'
            ORDER BY CASE WHEN title LIKE ?2 ESCAPE '\' THEN 0 ELSE 1 END,
                     LENGTH(title) ASC, updated_at DESC
            LIMIT ?3
            "#,
        )?;
        let rows = stmt.query_map(params![contains, prefix, limit], Self::row_to_note)?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    // ========================================================================
    // 链接图（note_links，见 V20260725__note_links.sql）
    // ========================================================================

    /// 重写某笔记的全部出链（先删后插，SAVEPOINT 事务保护）。
    ///
    /// 目标解析规则（大小写不敏感；ASCII 由 COLLATE NOCASE 覆盖，CJK 无大小写）：
    /// 1. `note://id` 与形如 `note_xxx` 的 target 先按笔记 id 解析（精确匹配）；
    /// 2. wiki 链接按标题解析；同名冲突取字典序最小的 note id
    ///    （与前端 wikilinks.ts 的确定性解析规则一致）；
    /// 3. 都未命中则落库为未解析链接（target_id = NULL），等待
    ///    新建/重命名触发器或全量重建补解析。
    ///
    /// 返回写入的链接行数。
    pub fn replace_note_links_with_conn(
        conn: &Connection,
        source_id: &str,
        parsed: &[ParsedNoteLink],
    ) -> VfsResult<usize> {
        conn.execute("SAVEPOINT replace_note_links", [])?;
        let result = (|| -> VfsResult<usize> {
            conn.execute(
                "DELETE FROM note_links WHERE source_id = ?1",
                params![source_id],
            )?;

            let mut written = 0usize;
            let mut resolve_by_id =
                conn.prepare("SELECT id, title FROM notes WHERE id = ?1 AND deleted_at IS NULL")?;
            let mut resolve_by_title = conn.prepare(
                "SELECT id, title FROM notes
                 WHERE deleted_at IS NULL AND title = ?1 COLLATE NOCASE
                 ORDER BY id ASC LIMIT 1",
            )?;
            let mut insert = conn.prepare(
                "INSERT OR REPLACE INTO note_links
                 (source_id, position, target_id, target_title, target_title_norm,
                  heading, alias, link_type)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;

            for link in parsed {
                let target = link.raw_target.trim();
                if target.is_empty() {
                    continue;
                }

                let mut resolved: Option<(String, String)> = None;
                if link.kind == NoteLinkKind::NoteRef || target.starts_with("note_") {
                    resolved = resolve_by_id
                        .query_row(params![target], |r| Ok((r.get(0)?, r.get(1)?)))
                        .optional()?;
                }
                if resolved.is_none() && link.kind == NoteLinkKind::Wikilink {
                    resolved = resolve_by_title
                        .query_row(params![target], |r| Ok((r.get(0)?, r.get(1)?)))
                        .optional()?;
                }

                let (target_id, display_title) = match resolved {
                    Some((id, title)) => (Some(id), title),
                    None => (None, target.to_string()),
                };
                let norm = display_title.trim().to_lowercase();

                insert.execute(params![
                    source_id,
                    link.position,
                    target_id,
                    display_title,
                    norm,
                    link.heading,
                    link.alias,
                    link.kind.as_str(),
                ])?;
                written += 1;
            }
            Ok(written)
        })();

        match result {
            Ok(written) => {
                conn.execute("RELEASE replace_note_links", [])?;
                Ok(written)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK TO replace_note_links", []);
                let _ = conn.execute("RELEASE replace_note_links", []);
                Err(e)
            }
        }
    }

    /// 从正文重建某笔记的出链（提取 + 重写）
    pub fn replace_note_links_from_content(
        db: &VfsDatabase,
        source_id: &str,
        content: &str,
    ) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::replace_note_links_with_conn(&conn, source_id, &extract_note_links(content))
    }

    /// 反链查询：谁链接到该笔记。
    ///
    /// 同时命中按 id 解析成功的链接与"标题恰好等于本笔记标题"的未解析链接
    /// （容忍重建滞后）；排除自链与软删除来源。
    pub fn backlinks_for(db: &VfsDatabase, note_id: &str) -> VfsResult<Vec<NoteBacklink>> {
        let conn = db.get_conn_safe()?;
        Self::backlinks_for_with_conn(&conn, note_id)
    }

    /// 反链查询（使用现有连接）
    pub fn backlinks_for_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<Vec<NoteBacklink>> {
        let note = Self::get_note_with_conn(conn, note_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "Note".to_string(),
            id: note_id.to_string(),
        })?;
        let title_norm = note.title.trim().to_lowercase();

        let mut stmt = conn.prepare(
            r#"
            SELECT l.source_id, n.title, l.heading, l.alias, l.position, n.updated_at
            FROM note_links l
            JOIN notes n ON n.id = l.source_id AND n.deleted_at IS NULL
            WHERE l.source_id != ?1
              AND (l.target_id = ?1
                   OR (l.target_id IS NULL AND l.target_title_norm = ?2))
            ORDER BY n.updated_at DESC, l.source_id ASC, l.position ASC
            "#,
        )?;
        let rows = stmt.query_map(params![note_id, title_norm], |row| {
            Ok(NoteBacklink {
                source_id: row.get(0)?,
                source_title: row.get(1)?,
                heading: row.get(2)?,
                alias: row.get(3)?,
                position: row.get(4)?,
                source_updated_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 出链查询：该笔记链接到谁（含未解析链接）
    pub fn outgoing_links_for(db: &VfsDatabase, note_id: &str) -> VfsResult<Vec<NoteOutgoingLink>> {
        let conn = db.get_conn_safe()?;
        Self::outgoing_links_for_with_conn(&conn, note_id)
    }

    /// 出链查询（使用现有连接）
    pub fn outgoing_links_for_with_conn(
        conn: &Connection,
        note_id: &str,
    ) -> VfsResult<Vec<NoteOutgoingLink>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT l.target_id, COALESCE(t.title, l.target_title), l.heading, l.alias,
                   l.position, l.link_type, (t.id IS NOT NULL)
            FROM note_links l
            LEFT JOIN notes t ON t.id = l.target_id AND t.deleted_at IS NULL
            WHERE l.source_id = ?1
            ORDER BY l.position ASC
            "#,
        )?;
        let rows = stmt.query_map(params![note_id], |row| {
            Ok(NoteOutgoingLink {
                target_id: row.get(0)?,
                target_title: row.get(1)?,
                heading: row.get(2)?,
                alias: row.get(3)?,
                position: row.get(4)?,
                link_type: row.get(5)?,
                resolved: row.get::<_, i64>(6)? != 0,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 全库未解析链接（目标笔记不存在），供"悬空链接"面板使用
    pub fn unresolved_links(db: &VfsDatabase, limit: u32) -> VfsResult<Vec<NoteUnresolvedLink>> {
        let conn = db.get_conn_safe()?;
        Self::unresolved_links_with_conn(&conn, limit)
    }

    /// 全库未解析链接（使用现有连接）
    pub fn unresolved_links_with_conn(
        conn: &Connection,
        limit: u32,
    ) -> VfsResult<Vec<NoteUnresolvedLink>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT l.source_id, n.title, l.target_title, l.heading, l.alias,
                   l.position, l.link_type
            FROM note_links l
            JOIN notes n ON n.id = l.source_id AND n.deleted_at IS NULL
            WHERE l.target_id IS NULL
            ORDER BY l.target_title_norm ASC, n.updated_at DESC, l.position ASC
            LIMIT ?1
            "#,
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(NoteUnresolvedLink {
                source_id: row.get(0)?,
                source_title: row.get(1)?,
                target_title: row.get(2)?,
                heading: row.get(3)?,
                alias: row.get(4)?,
                position: row.get(5)?,
                link_type: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    /// 未链接提及：正文/标题中出现了本笔记标题、但尚未链接到本笔记的候选笔记。
    ///
    /// 走 notes_fts（标题作为 phrase 查询，<3 字符回退 LIKE），
    /// 排除自身与已链接来源；返回 (笔记, 摘要)。
    pub fn unlinked_mention_candidates(
        db: &VfsDatabase,
        note_id: &str,
        limit: u32,
    ) -> VfsResult<Vec<(VfsNote, Option<String>)>> {
        let conn = db.get_conn_safe()?;
        Self::unlinked_mention_candidates_with_conn(&conn, note_id, limit)
    }

    /// 未链接提及（使用现有连接）
    pub fn unlinked_mention_candidates_with_conn(
        conn: &Connection,
        note_id: &str,
        limit: u32,
    ) -> VfsResult<Vec<(VfsNote, Option<String>)>> {
        let note = Self::get_note_with_conn(conn, note_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "Note".to_string(),
            id: note_id.to_string(),
        })?;
        let title = note.title.trim().to_string();
        // ★ 2026-07：过短标题误报限制——单字符标题（如 "数"）在任意正文中
        // 命中率过高，候选几乎全是噪音，直接返回空集。
        if title.is_empty() || title.chars().count() < 2 {
            return Ok(Vec::new());
        }
        let title_norm = title.to_lowercase();

        // 已链接到本笔记的来源集合（含标题匹配的未解析链接）
        let linked: HashSet<String> = {
            let mut stmt = conn.prepare(
                "SELECT DISTINCT source_id FROM note_links
                 WHERE target_id = ?1
                    OR (target_id IS NULL AND target_title_norm = ?2)",
            )?;
            let rows =
                stmt.query_map(params![note_id, title_norm], |row| row.get::<_, String>(0))?;
            rows.collect::<rusqlite::Result<HashSet<_>>>()?
        };

        // 多取一些再过滤，避免过滤后不足 limit
        let fetch = limit.saturating_mul(3).clamp(limit, 200);
        let hits = Self::search_notes_with_snippets_with_conn(conn, &title, fetch)?;
        Ok(hits
            .into_iter()
            .filter(|(n, _)| n.id != note_id && !linked.contains(&n.id))
            .take(limit as usize)
            .collect())
    }

    /// 全库重建链接图（分批事务）。
    ///
    /// 逐批（按 id 升序游标）读取活跃笔记正文，解析并重写出链；
    /// 每批一个 IMMEDIATE 事务，失败即回滚当前批并返回错误。
    /// 软删除笔记的存量链接行保留（恢复后仍有效），硬删除由触发器清理。
    ///
    /// 返回 (处理的笔记数, 写入的链接数)。
    pub fn rebuild_note_links(db: &VfsDatabase, batch_size: usize) -> VfsResult<(usize, usize)> {
        let conn = db.get_conn_safe()?;
        let batch_size = batch_size.clamp(1, 2000) as i64;

        let mut last_id = String::new();
        let mut notes_total = 0usize;
        let mut links_total = 0usize;

        loop {
            let batch: Vec<(String, String)> = {
                let mut stmt = conn.prepare(
                    "SELECT n.id, COALESCE(r.data, '')
                     FROM notes n
                     LEFT JOIN resources r ON r.id = n.resource_id
                     WHERE n.deleted_at IS NULL AND n.id > ?1
                     ORDER BY n.id ASC
                     LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![last_id, batch_size], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()?
            };
            if batch.is_empty() {
                break;
            }

            conn.execute("BEGIN IMMEDIATE", [])?;
            let tx_result: VfsResult<usize> = (|| {
                let mut written = 0usize;
                for (id, content) in &batch {
                    written += Self::replace_note_links_with_conn(
                        &conn,
                        id,
                        &extract_note_links(content),
                    )?;
                }
                Ok(written)
            })();
            match tx_result {
                Ok(written) => {
                    conn.execute("COMMIT", [])?;
                    links_total += written;
                }
                Err(e) => {
                    let _ = conn.execute("ROLLBACK", []);
                    return Err(e);
                }
            }

            notes_total += batch.len();
            if let Some((id, _)) = batch.last() {
                last_id = id.clone();
            }
        }

        info!(
            "[VFS::NoteRepo] Rebuilt note links: {} notes, {} links",
            notes_total, links_total
        );
        Ok((notes_total, links_total))
    }

    /// 一次性链接图回填标志（存于 vfs_indexing_config KV 表；BackupOnly，
    /// 不进 __change_log 行级同步，与 note_links 派生数据的备份语义一致）。
    const NOTE_LINKS_BACKFILL_KEY: &'static str = "maintenance.note_links_backfill_done";

    /// 启动期一次性全量回填链接图（修复 DSTU 时期写路径不维护 note_links
    /// 的存量缺口）。
    ///
    /// - 幂等：成功后写入 KV 标志，后续启动直接跳过（返回 `Ok(false)`）；
    /// - 失败可重试：重建报错时不写标志，下次启动自动重试；
    /// - 分批：复用 [`Self::rebuild_note_links`]（每批独立 IMMEDIATE 事务）。
    ///
    /// 注意：标志直接写 `vfs_indexing_config`（不走
    /// `VfsIndexStateRepo::set_config`，后者对 key 做白名单校验，维护标志
    /// 不属于可由前端设置的索引配置项）。
    ///
    /// 返回 `Ok(true)` 表示本次执行了回填，`Ok(false)` 表示已回填过、跳过。
    pub fn backfill_note_links_once(db: &VfsDatabase, batch_size: usize) -> VfsResult<bool> {
        // 作用域内借出连接检查标志后立即归还，避免与 rebuild 内部再次取连接冲突
        {
            let conn = db.get_conn_safe()?;
            let done: Option<String> = conn
                .query_row(
                    "SELECT value FROM vfs_indexing_config WHERE key = ?1",
                    params![Self::NOTE_LINKS_BACKFILL_KEY],
                    |row| row.get(0),
                )
                .optional()?;
            if done.as_deref() == Some("true") {
                return Ok(false);
            }
        }

        let (notes, links) = Self::rebuild_note_links(db, batch_size)?;

        let conn = db.get_conn_safe()?;
        conn.execute(
            "INSERT OR REPLACE INTO vfs_indexing_config (key, value, updated_at)
             VALUES (?1, 'true', ?2)",
            params![
                Self::NOTE_LINKS_BACKFILL_KEY,
                chrono::Utc::now().timestamp_millis()
            ],
        )?;
        info!(
            "[VFS::NoteRepo] One-time note links backfill done: {} notes, {} links",
            notes, links
        );
        Ok(true)
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn setup_test_db() -> (TempDir, VfsDatabase) {
        crate::vfs::database::setup_migrated_test_db()
    }

    #[test]
    fn test_create_note() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "测试笔记".to_string(),
                content: "# 测试内容\n\n这是一个测试笔记。".to_string(),
                tags: vec!["测试".to_string(), "数学".to_string()],
            },
        )
        .expect("Create note should succeed");

        assert!(!note.id.is_empty());
        assert_eq!(note.title, "测试笔记");
        assert_eq!(note.tags, vec!["测试", "数学"]);
        assert!(!note.is_favorite);
    }

    #[test]
    fn test_get_note_content() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "测试笔记".to_string(),
                content: "# 测试内容".to_string(),
                tags: vec![],
            },
        )
        .expect("Create note should succeed");

        let content = VfsNoteRepo::get_note_content(&db, &note.id)
            .expect("Get content should succeed")
            .expect("Content should exist");

        assert_eq!(content, "# 测试内容");
    }

    #[test]
    fn test_update_note_changes_resource_on_content_change() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "原始标题".to_string(),
                content: "原始内容".to_string(),
                tags: vec!["v1".to_string()],
            },
        )
        .expect("Create note should succeed");

        let original_resource_id = note.resource_id.clone();

        let updated_note = VfsNoteRepo::update_note(
            &db,
            &note.id,
            VfsUpdateNoteParams {
                content: Some("新内容".to_string()),
                title: Some("新标题".to_string()),
                tags: Some(vec!["v2".to_string()]),
                expected_updated_at: None,
            },
        )
        .expect("Update note should succeed");

        assert_ne!(
            updated_note.resource_id, original_resource_id,
            "Resource ID should change when content changes"
        );
        assert_eq!(updated_note.title, "新标题");
        assert_eq!(updated_note.tags, vec!["v2"]);

        let content = VfsNoteRepo::get_note_content(&db, &note.id)
            .expect("Get content should succeed")
            .expect("Content should exist");
        assert_eq!(content, "新内容");
    }

    #[test]
    fn test_update_note_keeps_resource_when_content_unchanged() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "标题".to_string(),
                content: "内容".to_string(),
                tags: vec![],
            },
        )
        .expect("Create note should succeed");

        let original_resource_id = note.resource_id.clone();

        let updated_note = VfsNoteRepo::update_note(
            &db,
            &note.id,
            VfsUpdateNoteParams {
                content: None,
                title: Some("新标题".to_string()),
                tags: None,
                expected_updated_at: None,
            },
        )
        .expect("Update note should succeed");

        assert_eq!(
            updated_note.resource_id, original_resource_id,
            "Resource ID should NOT change when only title changes"
        );
        assert_eq!(updated_note.title, "新标题");

        let content = VfsNoteRepo::get_note_content(&db, &note.id)
            .expect("Get content should succeed")
            .expect("Content should exist");
        assert_eq!(content, "内容", "Content should remain unchanged");
    }

    #[test]
    fn test_soft_delete_and_restore() {
        let (_temp_dir, db) = setup_test_db();

        // 创建笔记
        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "测试笔记".to_string(),
                content: "内容".to_string(),
                tags: vec![],
            },
        )
        .expect("Create note should succeed");

        // 软删除
        VfsNoteRepo::delete_note(&db, &note.id).expect("Delete should succeed");

        // ★ M-008: get_note 应该过滤软删除的笔记，返回 None
        let filtered_note = VfsNoteRepo::get_note(&db, &note.id).expect("Get should succeed");
        assert!(
            filtered_note.is_none(),
            "get_note should return None for soft-deleted notes"
        );

        // ★ M-008: get_note_including_deleted 应该仍能读取已删除笔记
        let deleted_note = VfsNoteRepo::get_note_including_deleted(&db, &note.id)
            .expect("Get including deleted should succeed")
            .expect("Note should exist when including deleted");
        assert!(deleted_note.deleted_at.is_some());

        // 恢复
        VfsNoteRepo::restore_note(&db, &note.id).expect("Restore should succeed");

        // 验证已恢复（get_note 应该能找到）
        let restored_note = VfsNoteRepo::get_note(&db, &note.id)
            .expect("Get should succeed")
            .expect("Restored note should be visible via get_note");
        assert!(restored_note.deleted_at.is_none());
    }

    #[test]
    fn test_list_all_notes() {
        let (_temp_dir, db) = setup_test_db();

        // 创建多个笔记
        VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "数学笔记".to_string(),
                content: "数学内容".to_string(),
                tags: vec![],
            },
        )
        .unwrap();

        VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "物理笔记".to_string(),
                content: "物理内容".to_string(),
                tags: vec![],
            },
        )
        .unwrap();

        // 查询所有笔记
        let all_notes = VfsNoteRepo::list_all_notes(&db, None, 10, 0).expect("List should succeed");
        assert_eq!(all_notes.len(), 2);
    }

    // ★ 2026-06-12（审阅问题 S5）回归测试：更新/删除不得泄漏历史资源

    fn count_note_resources(db: &VfsDatabase) -> i64 {
        let conn = db.get_conn_safe().unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM resources WHERE type = 'note'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    }

    /// 内容多次更新后，旧版本资源必须被即时回收（不堆积）
    #[test]
    fn test_update_note_reclaims_old_resources() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "演进笔记".to_string(),
                content: "v1".to_string(),
                tags: vec![],
            },
        )
        .unwrap();

        for v in ["v2", "v3", "v4", "v5"] {
            VfsNoteRepo::update_note(
                &db,
                &note.id,
                VfsUpdateNoteParams {
                    content: Some(v.to_string()),
                    title: None,
                    tags: None,
                    expected_updated_at: None,
                },
            )
            .unwrap();
        }

        assert_eq!(
            count_note_resources(&db),
            1,
            "old note resources must be reclaimed on each content switch"
        );
    }

    // ★ 2026-07-19（P1-1 / P1-3）：FTS 全文检索与规范化标签回归测试

    /// FTS 检索（>=3 字符走 notes_fts）与短关键词回退 LIKE 都必须命中
    #[test]
    fn test_search_notes_fts_and_like_fallback() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "Calculus Notes".to_string(),
                content: "The derivative measures instantaneous change. 微积分基础。".to_string(),
                tags: vec![],
            },
        )
        .unwrap();
        VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "Unrelated".to_string(),
                content: "nothing to see here".to_string(),
                tags: vec![],
            },
        )
        .unwrap();

        // >=3 字符：应命中 FTS（trigram 子串匹配）
        let hits = VfsNoteRepo::search_notes_with_snippets(&db, "derivative", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.id, note.id);
        let snippet = hits[0].1.as_deref().unwrap_or_default();
        assert!(snippet.contains("derivative"));

        // 中文子串（>=3 字符走 FTS）
        let hits = VfsNoteRepo::search_notes_with_snippets(&db, "微积分", 10).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.id, note.id);

        // <3 字符：FTS 直接放弃，回退 LIKE 仍应命中
        let hits = VfsNoteRepo::search_notes_with_snippets(&db, "微积", 10).unwrap();
        assert_eq!(hits.len(), 1);

        // list_notes 搜索路径同样受益且行为一致
        let notes = VfsNoteRepo::list_notes(&db, Some("derivative"), 10, 0).unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, note.id);
    }

    /// 软删除的笔记必须从 FTS 索引移除，恢复后重新可搜
    #[test]
    fn test_fts_index_follows_soft_delete_and_restore() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "Quantum".to_string(),
                content: "superposition entanglement".to_string(),
                tags: vec![],
            },
        )
        .unwrap();

        VfsNoteRepo::delete_note(&db, &note.id).unwrap();
        let hits = VfsNoteRepo::search_notes_with_snippets(&db, "entanglement", 10).unwrap();
        assert!(hits.is_empty(), "soft-deleted note must not be searchable");

        VfsNoteRepo::restore_note(&db, &note.id).unwrap();
        let hits = VfsNoteRepo::search_notes_with_snippets(&db, "entanglement", 10).unwrap();
        assert_eq!(hits.len(), 1, "restored note must be searchable again");
    }

    /// 内容更新（resource 切换）后 FTS 必须索引新正文、放弃旧正文
    #[test]
    fn test_fts_index_follows_content_update() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "Draft".to_string(),
                content: "original wording".to_string(),
                tags: vec![],
            },
        )
        .unwrap();

        VfsNoteRepo::update_note(
            &db,
            &note.id,
            VfsUpdateNoteParams {
                content: Some("revised phrasing".to_string()),
                title: None,
                tags: None,
                expected_updated_at: None,
            },
        )
        .unwrap();

        let hits = VfsNoteRepo::search_notes_with_snippets(&db, "revised", 10).unwrap();
        assert_eq!(hits.len(), 1);
        let hits = VfsNoteRepo::search_notes_with_snippets(&db, "original wording", 10).unwrap();
        assert!(hits.is_empty(), "stale body must not be searchable");
    }

    /// 规范化标签表：按使用频次排序，软删除笔记不参与统计
    #[test]
    fn test_list_tags_uses_normalized_table() {
        let (_temp_dir, db) = setup_test_db();

        for i in 0..3 {
            VfsNoteRepo::create_note(
                &db,
                VfsCreateNoteParams {
                    title: format!("math {}", i),
                    content: "x".to_string(),
                    tags: vec!["数学".to_string()],
                },
            )
            .unwrap();
        }
        let physics = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "physics".to_string(),
                content: "y".to_string(),
                tags: vec!["物理".to_string(), " 数学 ".to_string()],
            },
        )
        .unwrap();

        let tags = VfsNoteRepo::list_tags(&db, 10).unwrap();
        assert_eq!(tags[0], "数学", "most used tag must rank first");
        assert!(tags.contains(&"物理".to_string()));

        // 软删除后其标签不再计入
        VfsNoteRepo::delete_note(&db, &physics.id).unwrap();
        let tags = VfsNoteRepo::list_tags(&db, 10).unwrap();
        assert!(!tags.contains(&"物理".to_string()));
    }

    /// purge 笔记后，包括历史版本在内的所有专属资源必须清空
    #[test]
    fn test_purge_note_removes_all_owned_resources() {
        let (_temp_dir, db) = setup_test_db();

        let note = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "购物清单".to_string(),
                content: "牛奶".to_string(),
                tags: vec![],
            },
        )
        .unwrap();

        VfsNoteRepo::update_note(
            &db,
            &note.id,
            VfsUpdateNoteParams {
                content: Some("牛奶+面包".to_string()),
                title: None,
                tags: None,
                expected_updated_at: None,
            },
        )
        .unwrap();

        VfsNoteRepo::purge_note(&db, &note.id).unwrap();

        assert_eq!(
            count_note_resources(&db),
            0,
            "purge must remove main and historical note resources"
        );
    }

    // ★ 2026-07-25：链接图（note_links）与标签/标题检索回归测试

    fn create_simple_note(db: &VfsDatabase, title: &str, content: &str) -> VfsNote {
        VfsNoteRepo::create_note(
            db,
            VfsCreateNoteParams {
                title: title.to_string(),
                content: content.to_string(),
                tags: vec![],
            },
        )
        .unwrap()
    }

    #[test]
    fn test_extract_note_links_syntax_matrix() {
        let content = "前言 [[目标笔记]] 中段 [[Target#Section|别名]]\n\
                       还有 [标签](note://note_abc123) 与空锚点 [[#local]] 结尾";
        let links = extract_note_links(content);
        assert_eq!(links.len(), 3);

        assert_eq!(links[0].raw_target, "目标笔记");
        assert_eq!(links[0].kind, NoteLinkKind::Wikilink);
        assert!(links[0].heading.is_none() && links[0].alias.is_none());

        assert_eq!(links[1].raw_target, "Target");
        assert_eq!(links[1].heading.as_deref(), Some("Section"));
        assert_eq!(links[1].alias.as_deref(), Some("别名"));

        assert_eq!(links[2].raw_target, "note_abc123");
        assert_eq!(links[2].kind, NoteLinkKind::NoteRef);

        // position 按出现顺序递增
        assert!(links.windows(2).all(|w| w[0].position < w[1].position));
    }

    /// ★ 2026-07：代码围栏 / 行内代码中的链接样文本不算链接
    #[test]
    fn test_extract_note_links_skips_code_regions() {
        let content = "正文 [[真实链接]]\n\
                       ```rust\n\
                       let a = \"[[代码里的假链接]]\"; // note://note_fake1\n\
                       ```\n\
                       行内 `[[行内代码假链接]]` 与 `note://note_fake2` 之后\n\
                       又一个 [[结尾链接]] 和 note://note_real9";
        let links = extract_note_links(content);
        let targets: Vec<&str> = links.iter().map(|l| l.raw_target.as_str()).collect();
        assert_eq!(targets, vec!["真实链接", "结尾链接", "note_real9"]);

        // 未闭合围栏延伸到文末：其中的链接同样不提取
        let unclosed = "开头 [[可见]]\n```\n[[被吞的]] note://note_x\n";
        let links = extract_note_links(unclosed);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].raw_target, "可见");

        // ~~~ 围栏、以及围栏关闭后恢复提取
        let tilde = "~~~\n[[假]]\n~~~\n[[真]]";
        let links = extract_note_links(tilde);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].raw_target, "真");

        // 未配对的单个反引号不构成行内代码
        let dangling = "一个 ` 反引号 [[仍是链接]]";
        let links = extract_note_links(dangling);
        assert_eq!(links.len(), 1);
        assert_eq!(links[0].raw_target, "仍是链接");
    }

    /// ★ 2026-07：snippet 的 UTF-8 边界与省略号行为（多字节字符窗口不 panic）
    #[test]
    fn test_make_search_snippet_utf8_boundaries() {
        // 关键词位于长中文正文中段：前后都应截断并带省略号
        let body: String = "汉".repeat(300) + "目标关键词" + &"字".repeat(300);
        let snippet = VfsNoteRepo::make_search_snippet(&body, "目标关键词", 40)
            .expect("snippet should exist");
        assert!(snippet.contains("目标关键词"));
        assert!(snippet.starts_with('…') && snippet.ends_with('…'));
        // 窗口 40 字符 + 两个省略号
        assert!(snippet.chars().count() <= 42);

        // 短正文：不加省略号，原样返回
        let snippet = VfsNoteRepo::make_search_snippet("短正文 emoji 🎯 结尾", "🎯", 160)
            .expect("snippet should exist");
        assert_eq!(snippet, "短正文 emoji 🎯 结尾");

        // 关键词未命中（如仅命中标题）：从开头截取
        let snippet =
            VfsNoteRepo::make_search_snippet(&"a".repeat(500), "不存在", 10).expect("snippet");
        assert!(snippet.ends_with('…'));
        assert!(!snippet.starts_with('…'));
    }

    /// ★ 2026-07：标题/标签防御性校验
    #[test]
    fn test_title_and_tags_validation() {
        let (_temp_dir, db) = setup_test_db();

        // 超长标题拒绝
        let err = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "长".repeat(501),
                content: "x".to_string(),
                tags: vec![],
            },
        );
        assert!(err.is_err());

        // 标题含换行拒绝
        let err = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "第一行\n第二行".to_string(),
                content: "x".to_string(),
                tags: vec![],
            },
        );
        assert!(err.is_err());

        // 含 Tab 的标题允许（Markdown H1 导入场景）
        let ok = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "a\tb".to_string(),
                content: "x".to_string(),
                tags: vec![],
            },
        );
        assert!(ok.is_ok());

        // 超长标签拒绝
        let err = VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "正常标题".to_string(),
                content: "x".to_string(),
                tags: vec!["t".repeat(101)],
            },
        );
        assert!(err.is_err());
    }

    #[test]
    fn test_note_links_resolution_backlinks_and_unresolved() {
        let (_temp_dir, db) = setup_test_db();

        let target = create_simple_note(&db, "微积分基础", "目标正文");
        let source_content = format!(
            "先看 [[微积分基础]]，再看 [[note://占位]] 之外的 note://{}，最后 [[尚未创建的笔记]]",
            target.id
        );
        let source = create_simple_note(&db, "复习计划", &source_content);
        // create_note 已在 repo 层同事务维护链接；这里再显式触发一次，
        // 同时验证 replace_note_links_from_content 的幂等性
        VfsNoteRepo::replace_note_links_from_content(&db, &source.id, &source_content).unwrap();

        let outgoing = VfsNoteRepo::outgoing_links_for(&db, &source.id).unwrap();
        // [[微积分基础]] + note://<target.id> + [[尚未创建的笔记]]
        // （"[[note://占位]]" 里的 wiki 目标 "note://占位" 解析失败 → 未解析链接）
        assert!(outgoing.len() >= 3);
        let resolved: Vec<_> = outgoing.iter().filter(|l| l.resolved).collect();
        assert_eq!(resolved.len(), 2, "标题与 id 两条链接都应解析成功");
        assert!(resolved
            .iter()
            .all(|l| l.target_id.as_deref() == Some(target.id.as_str())));

        let backlinks = VfsNoteRepo::backlinks_for(&db, &target.id).unwrap();
        assert_eq!(backlinks.len(), 2);
        assert!(backlinks.iter().all(|b| b.source_id == source.id));

        let unresolved = VfsNoteRepo::unresolved_links(&db, 50).unwrap();
        assert!(unresolved
            .iter()
            .any(|u| u.source_id == source.id && u.target_title == "尚未创建的笔记"));

        // 创建同名笔记后，触发器应自动补解析
        let late = create_simple_note(&db, "尚未创建的笔记", "later");
        let outgoing = VfsNoteRepo::outgoing_links_for(&db, &source.id).unwrap();
        assert!(outgoing
            .iter()
            .any(|l| l.target_id.as_deref() == Some(late.id.as_str())));
    }

    #[test]
    fn test_note_links_purge_target_downgrades_to_unresolved() {
        let (_temp_dir, db) = setup_test_db();

        let target = create_simple_note(&db, "Quantum", "body");
        let source = create_simple_note(&db, "Index", "see [[Quantum]]");
        VfsNoteRepo::replace_note_links_from_content(&db, &source.id, "see [[Quantum]]").unwrap();

        VfsNoteRepo::purge_note(&db, &target.id).unwrap();

        let outgoing = VfsNoteRepo::outgoing_links_for(&db, &source.id).unwrap();
        assert_eq!(outgoing.len(), 1);
        assert!(!outgoing[0].resolved, "硬删除目标后链接应降级为未解析");
        assert!(outgoing[0].target_id.is_none());

        // 来源被硬删除后，其出链行应被触发器清理
        VfsNoteRepo::purge_note(&db, &source.id).unwrap();
        let conn = db.get_conn_safe().unwrap();
        let remaining: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM note_links WHERE source_id = ?1",
                params![source.id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(remaining, 0);
    }

    #[test]
    fn test_rebuild_note_links_and_unlinked_mentions() {
        let (_temp_dir, db) = setup_test_db();

        let hub = create_simple_note(&db, "知识中枢", "hub body");
        let linked = create_simple_note(&db, "已链接", "指向 [[知识中枢]] 的笔记");
        let mentioning = create_simple_note(&db, "只提及", "正文提到了知识中枢但没有加链接");
        let _bystander = create_simple_note(&db, "无关", "nothing here");

        let (notes, links) = VfsNoteRepo::rebuild_note_links(&db, 2).unwrap();
        assert_eq!(notes, 4);
        assert!(links >= 1);

        let backlinks = VfsNoteRepo::backlinks_for(&db, &hub.id).unwrap();
        assert_eq!(backlinks.len(), 1);
        assert_eq!(backlinks[0].source_id, linked.id);

        let mentions = VfsNoteRepo::unlinked_mention_candidates(&db, &hub.id, 10).unwrap();
        let ids: Vec<_> = mentions.iter().map(|(n, _)| n.id.clone()).collect();
        assert!(ids.contains(&mentioning.id), "提及未链接的笔记应成为候选");
        assert!(!ids.contains(&linked.id), "已链接来源应被排除");
        assert!(!ids.contains(&hub.id), "自身应被排除");
    }

    #[test]
    fn test_create_note_maintains_links_in_repo_layer() {
        let (_temp_dir, db) = setup_test_db();

        let target = create_simple_note(&db, "目标笔记", "target body");
        // 不做任何显式链接维护调用 —— create_note 应在同一事务内写出链
        let source = create_simple_note(
            &db,
            "来源笔记",
            &format!("参考 [[目标笔记]] 与 note://{}", target.id),
        );

        let outgoing = VfsNoteRepo::outgoing_links_for(&db, &source.id).unwrap();
        assert_eq!(outgoing.len(), 2, "创建即应产生两条出链");
        assert!(
            outgoing
                .iter()
                .all(|l| l.resolved && l.target_id.as_deref() == Some(target.id.as_str())),
            "标题与 id 链接都应解析到目标笔记"
        );

        let backlinks = VfsNoteRepo::backlinks_for(&db, &target.id).unwrap();
        assert_eq!(backlinks.len(), 2);
        assert!(backlinks.iter().all(|b| b.source_id == source.id));
    }

    #[test]
    fn test_update_note_refreshes_links_in_repo_layer() {
        let (_temp_dir, db) = setup_test_db();

        let alpha = create_simple_note(&db, "Alpha", "a");
        let beta = create_simple_note(&db, "Beta", "b");
        let source = create_simple_note(&db, "来源", "见 [[Alpha]]");

        // 不做任何显式链接维护调用 —— update_note 应在同一事务内重写出链
        VfsNoteRepo::update_note(
            &db,
            &source.id,
            VfsUpdateNoteParams {
                title: None,
                content: Some("改为 [[Beta]]".to_string()),
                tags: None,
                expected_updated_at: None,
            },
        )
        .unwrap();

        let outgoing = VfsNoteRepo::outgoing_links_for(&db, &source.id).unwrap();
        assert_eq!(outgoing.len(), 1, "旧出链应被替换而非累加");
        assert_eq!(outgoing[0].target_id.as_deref(), Some(beta.id.as_str()));
        assert!(VfsNoteRepo::backlinks_for(&db, &alpha.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_update_note_unchanged_content_and_title_only_skip_link_refresh() {
        let (_temp_dir, db) = setup_test_db();

        create_simple_note(&db, "Alpha", "a");
        let content = "见 [[Alpha]]";
        let source = create_simple_note(&db, "来源", content);

        // 人工清空出链行，用于探测"是否发生了刷新"
        let clear_links = || {
            let conn = db.get_conn_safe().unwrap();
            conn.execute(
                "DELETE FROM note_links WHERE source_id = ?1",
                params![source.id],
            )
            .unwrap();
        };

        // 1. 内容未变（hash 相同复用资源）→ 跳过链接刷新
        clear_links();
        VfsNoteRepo::update_note(
            &db,
            &source.id,
            VfsUpdateNoteParams {
                title: None,
                content: Some(content.to_string()),
                tags: None,
                expected_updated_at: None,
            },
        )
        .unwrap();
        assert!(
            VfsNoteRepo::outgoing_links_for(&db, &source.id)
                .unwrap()
                .is_empty(),
            "内容未变时不应刷新链接图（热路径跳过）"
        );

        // 2. 仅改标题（不携带正文）→ 同样跳过
        VfsNoteRepo::update_note(
            &db,
            &source.id,
            VfsUpdateNoteParams {
                title: Some("来源改名".to_string()),
                content: None,
                tags: None,
                expected_updated_at: None,
            },
        )
        .unwrap();
        assert!(VfsNoteRepo::outgoing_links_for(&db, &source.id)
            .unwrap()
            .is_empty());

        // 3. 内容真正变化 → 刷新
        VfsNoteRepo::update_note(
            &db,
            &source.id,
            VfsUpdateNoteParams {
                title: None,
                content: Some("还是见 [[Alpha]] 但内容变了".to_string()),
                tags: None,
                expected_updated_at: None,
            },
        )
        .unwrap();
        assert_eq!(
            VfsNoteRepo::outgoing_links_for(&db, &source.id)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn test_soft_delete_and_restore_preserve_outgoing_links() {
        let (_temp_dir, db) = setup_test_db();

        let target = create_simple_note(&db, "被引用", "t");
        let source = create_simple_note(&db, "引用者", "见 [[被引用]]");

        // 软删除不触发 trg_note_links_on_note_delete（仅硬删除触发），出链行保留
        VfsNoteRepo::delete_note(&db, &source.id).unwrap();
        {
            let conn = db.get_conn_safe().unwrap();
            let rows: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM note_links WHERE source_id = ?1",
                    params![source.id],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(rows, 1, "软删除应保留出链行（供恢复复用）");
        }

        // 恢复后出链立即可查，无需重建
        VfsNoteRepo::restore_note(&db, &source.id).unwrap();
        let outgoing = VfsNoteRepo::outgoing_links_for(&db, &source.id).unwrap();
        assert_eq!(outgoing.len(), 1);
        assert_eq!(outgoing[0].target_id.as_deref(), Some(target.id.as_str()));
    }

    #[test]
    fn test_backfill_note_links_once_flag_and_retry_semantics() {
        let (_temp_dir, db) = setup_test_db();

        create_simple_note(&db, "枢纽", "hub");
        let source = create_simple_note(&db, "来源", "见 [[枢纽]]");

        // 模拟 DSTU 时期漏维护的存量库：人工清空链接图
        {
            let conn = db.get_conn_safe().unwrap();
            conn.execute("DELETE FROM note_links", []).unwrap();
        }

        // 首次执行：回填并写标志
        let ran = VfsNoteRepo::backfill_note_links_once(&db, 100).unwrap();
        assert!(ran, "标志缺失时应执行回填");
        assert_eq!(
            VfsNoteRepo::outgoing_links_for(&db, &source.id)
                .unwrap()
                .len(),
            1
        );

        // 再次执行：标志已置位，直接跳过（不再重建）
        {
            let conn = db.get_conn_safe().unwrap();
            conn.execute("DELETE FROM note_links", []).unwrap();
        }
        let ran = VfsNoteRepo::backfill_note_links_once(&db, 100).unwrap();
        assert!(!ran, "标志已置位时应跳过");
        assert!(VfsNoteRepo::outgoing_links_for(&db, &source.id)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn test_search_notes_by_tags_with_snippets_exact_and_keyword() {
        let (_temp_dir, db) = setup_test_db();

        VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "math note".to_string(),
                content: "derivative rules".to_string(),
                tags: vec!["math".to_string(), "study".to_string()],
            },
        )
        .unwrap();
        VfsNoteRepo::create_note(
            &db,
            VfsCreateNoteParams {
                title: "math2 note".to_string(),
                content: "unrelated".to_string(),
                tags: vec!["math2".to_string()],
            },
        )
        .unwrap();

        // 精确标签匹配：不得出现历史 LIKE '%"math"%' 命中 "math2" 的假阳性
        let hits =
            VfsNoteRepo::search_notes_by_tags_with_snippets(&db, None, &["math".to_string()], 10)
                .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.title, "math note");

        // 多标签 AND 语义 + 关键词过滤
        let hits = VfsNoteRepo::search_notes_by_tags_with_snippets(
            &db,
            Some("derivative"),
            &["math".to_string(), "study".to_string()],
            10,
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0]
            .1
            .as_deref()
            .unwrap_or_default()
            .contains("derivative"));

        // 关键词不命中时无结果
        let hits = VfsNoteRepo::search_notes_by_tags_with_snippets(
            &db,
            Some("nonexistent"),
            &["math".to_string()],
            10,
        )
        .unwrap();
        assert!(hits.is_empty());

        // note_ids_with_all_tags：AND 语义
        let conn = db.get_conn_safe().unwrap();
        let ids = VfsNoteRepo::note_ids_with_all_tags_with_conn(
            &conn,
            &["math".to_string(), "study".to_string()],
        )
        .unwrap();
        assert_eq!(ids.len(), 1);
    }

    #[test]
    fn test_search_note_titles_prefers_prefix() {
        let (_temp_dir, db) = setup_test_db();

        create_simple_note(&db, "线性代数", "a");
        create_simple_note(&db, "高等线性代数进阶", "b");
        create_simple_note(&db, "别的", "c");

        let hits = VfsNoteRepo::search_note_titles(&db, "线性代数", 10).unwrap();
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].title, "线性代数", "前缀（此处为全等）命中应排最前");
    }

    // ========================================================================
    // 自定义属性（notes.props，V20260824）
    // ========================================================================

    #[test]
    fn test_set_note_props_roundtrip_and_updated_at() {
        let (_temp_dir, db) = setup_test_db();
        let note = create_simple_note(&db, "属性宿主", "正文");
        assert!(note.props.is_none(), "新建笔记不应有自定义属性");

        let updated = VfsNoteRepo::set_note_props(
            &db,
            &note.id,
            serde_json::json!({ " status ": "in progress", "priority": 2, "pinned": true }),
        )
        .expect("Set props should succeed");

        // 键去两侧空白；标量值原样保留
        let props = updated.props.as_ref().expect("Props should be stored");
        assert_eq!(props["status"], serde_json::json!("in progress"));
        assert_eq!(props["priority"], serde_json::json!(2));
        assert_eq!(props["pinned"], serde_json::json!(true));
        assert!(
            updated.updated_at > note.updated_at,
            "写属性应推进 updated_at（{} -> {}）",
            note.updated_at,
            updated.updated_at
        );

        // 重新读出（含各查询路径的 row_to_note 列名读取）
        let fetched = VfsNoteRepo::get_note(&db, &note.id).unwrap().unwrap();
        assert_eq!(fetched.props, updated.props);
        let listed = VfsNoteRepo::list_notes(&db, None, 10, 0).unwrap();
        assert_eq!(listed[0].props, updated.props);

        // 整对象替换语义：删除键 = 写回不含该键的对象
        let replaced =
            VfsNoteRepo::set_note_props(&db, &note.id, serde_json::json!({ "status": "done" }))
                .unwrap();
        let props = replaced.props.as_ref().unwrap();
        assert!(props.get("priority").is_none());

        // 空对象落库为 NULL（props 回到 None）
        let cleared = VfsNoteRepo::set_note_props(&db, &note.id, serde_json::json!({})).unwrap();
        assert!(cleared.props.is_none());
        let fetched = VfsNoteRepo::get_note(&db, &note.id).unwrap().unwrap();
        assert!(fetched.props.is_none());
    }

    #[test]
    fn test_set_note_props_validation() {
        let (_temp_dir, db) = setup_test_db();
        let note = create_simple_note(&db, "属性校验", "正文");

        // 非对象
        assert!(VfsNoteRepo::set_note_props(&db, &note.id, serde_json::json!([1, 2])).is_err());
        // 保留键（大小写不敏感）
        assert!(
            VfsNoteRepo::set_note_props(&db, &note.id, serde_json::json!({ "Tags": "x" })).is_err()
        );
        // 空键
        assert!(
            VfsNoteRepo::set_note_props(&db, &note.id, serde_json::json!({ "  ": "x" })).is_err()
        );
        // 嵌套值（只允许标量）
        assert!(VfsNoteRepo::set_note_props(
            &db,
            &note.id,
            serde_json::json!({ "meta": { "nested": true } })
        )
        .is_err());
        // trim + 大小写后重复的键会导致搜索命中不确定，必须拒绝而非静默覆盖
        assert!(VfsNoteRepo::set_note_props(
            &db,
            &note.id,
            serde_json::json!({ " Status ": "draft", "status": "done" })
        )
        .is_err());
        // 值超长
        let long_value = "v".repeat(VfsNoteRepo::MAX_PROP_VALUE_CHARS + 1);
        assert!(VfsNoteRepo::set_note_props(
            &db,
            &note.id,
            serde_json::json!({ "key": long_value })
        )
        .is_err());
        // 数量超限
        let mut too_many = serde_json::Map::new();
        for index in 0..=VfsNoteRepo::MAX_PROPS {
            too_many.insert(format!("k{index}"), serde_json::json!("v"));
        }
        assert!(
            VfsNoteRepo::set_note_props(&db, &note.id, serde_json::Value::Object(too_many))
                .is_err()
        );

        // 校验失败不落库
        let fetched = VfsNoteRepo::get_note(&db, &note.id).unwrap().unwrap();
        assert!(fetched.props.is_none());
    }

    #[test]
    fn test_update_note_metadata_is_atomic_and_honors_occ() {
        let (_temp_dir, db) = setup_test_db();
        let note = create_simple_note(&db, "原标题", "正文");

        let updated = VfsNoteRepo::update_note_metadata(
            &db,
            &note.id,
            VfsNoteMetadataUpdate {
                title: Some("新标题".to_string()),
                tags: Some(vec!["math".to_string()]),
                is_favorite: Some(true),
                props: Some(serde_json::json!({ "status": "done" })),
                expected_updated_at: Some(note.updated_at.clone()),
            },
        )
        .unwrap();
        assert_eq!(updated.title, "新标题");
        assert_eq!(updated.tags, vec!["math"]);
        assert!(updated.is_favorite);
        assert_eq!(
            updated.props.as_ref().and_then(|value| value.get("status")),
            Some(&serde_json::json!("done"))
        );

        let stale = VfsNoteRepo::update_note_metadata(
            &db,
            &note.id,
            VfsNoteMetadataUpdate {
                title: Some("不应写入".to_string()),
                expected_updated_at: Some(note.updated_at),
                ..Default::default()
            },
        );
        assert!(matches!(stale, Err(VfsError::Conflict { .. })));
        assert_eq!(
            VfsNoteRepo::get_note(&db, &note.id).unwrap().unwrap().title,
            "新标题"
        );

        // 任一字段校验失败时，其他字段也不能部分落库。
        let invalid = VfsNoteRepo::update_note_metadata(
            &db,
            &note.id,
            VfsNoteMetadataUpdate {
                title: Some("半成品标题".to_string()),
                props: Some(serde_json::json!({ "nested": { "bad": true } })),
                ..Default::default()
            },
        );
        assert!(invalid.is_err());
        assert_eq!(
            VfsNoteRepo::get_note(&db, &note.id).unwrap().unwrap().title,
            "新标题"
        );

        // 未提供的列不能出现在 UPDATE 的赋值清单中。除了避免无谓触发
        // note_tags/change-log trigger，这也保证无 OCC 的部分更新不会把读取
        // current 之后由另一连接写入的字段覆盖回旧快照。
        let conn = db.get_conn_safe().unwrap();
        conn.execute_batch(&format!(
            "CREATE TRIGGER reject_unprovided_note_metadata
             BEFORE UPDATE OF tags, is_favorite, props ON notes
             WHEN OLD.id = '{}'
             BEGIN
               SELECT RAISE(ABORT, 'omitted metadata column was assigned');
             END;",
            note.id.replace('\'', "''")
        ))
        .unwrap();
        drop(conn);
        let title_only = VfsNoteRepo::update_note_metadata(
            &db,
            &note.id,
            VfsNoteMetadataUpdate {
                title: Some("仅标题更新".to_string()),
                ..Default::default()
            },
        )
        .expect("partial update must not assign omitted metadata columns");
        assert_eq!(title_only.title, "仅标题更新");
        assert_eq!(title_only.tags, vec!["math"]);
        assert!(title_only.is_favorite);
        assert_eq!(
            title_only
                .props
                .as_ref()
                .and_then(|value| value.get("status")),
            Some(&serde_json::json!("done"))
        );
    }

    #[test]
    fn test_props_survive_metadata_and_content_updates() {
        let (_temp_dir, db) = setup_test_db();
        let note = create_simple_note(&db, "属性保持", "旧内容");
        VfsNoteRepo::set_note_props(&db, &note.id, serde_json::json!({ "status": "done" }))
            .unwrap();

        // update_note（改标题 + 内容）不应清掉 props
        let updated = VfsNoteRepo::update_note(
            &db,
            &note.id,
            VfsUpdateNoteParams {
                content: Some("新内容".to_string()),
                title: Some("新标题".to_string()),
                tags: Some(vec!["t".to_string()]),
                expected_updated_at: None,
            },
        )
        .unwrap();
        assert_eq!(
            updated.props.as_ref().and_then(|p| p.get("status")),
            Some(&serde_json::json!("done"))
        );
        let fetched = VfsNoteRepo::get_note(&db, &note.id).unwrap().unwrap();
        assert_eq!(fetched.props, updated.props);
    }

    /// 畸形 props（旁路写入的坏数据）读取时必须回退 None 且留下观测痕迹
    /// （warn 日志 + 原子计数），不允许静默丢失。
    #[test]
    fn test_row_to_note_malformed_props_fall_back_with_trace() {
        use crate::vfs::note_props;

        let (_temp_dir, db) = setup_test_db();
        let note = create_simple_note(&db, "畸形属性宿主", "正文");

        // 绕过写侧校验，直接向 props 列注入畸形数据（模拟旁路写入/损坏）
        let inject = |raw: &str| {
            db.get_conn_safe()
                .unwrap()
                .execute(
                    "UPDATE notes SET props = ?1 WHERE id = ?2",
                    rusqlite::params![raw, note.id],
                )
                .unwrap();
        };

        for raw in ["not-json{", "[1,2]", "\"scalar\"", "{}"] {
            inject(raw);
            let before = note_props::malformed_props_total();
            let fetched = VfsNoteRepo::get_note(&db, &note.id).unwrap().unwrap();
            assert!(fetched.props.is_none(), "畸形 props {raw:?} 应回退 None");
            assert!(
                note_props::malformed_props_total() > before,
                "畸形 props {raw:?} 必须计入原子计数（不允许静默）"
            );
        }

        // 对照组：合法非空对象正常读出，且不增加畸形计数
        inject(r#"{"status":"done","priority":2}"#);
        let before = note_props::malformed_props_total();
        let fetched = VfsNoteRepo::get_note(&db, &note.id).unwrap().unwrap();
        let props = fetched.props.expect("合法 props 应读出");
        assert_eq!(
            props["priority"],
            serde_json::json!(2),
            "读侧保留 JSON 类型"
        );
        assert_eq!(note_props::malformed_props_total(), before);
    }

    /// 共享键语法向量（vfs::note_props::test_vectors）在写侧的落库口径：
    /// 合法向量全部可存；非法向量全部被拒。
    #[test]
    fn test_note_props_shared_key_vectors_round_trip_write_side() {
        use crate::vfs::note_props::test_vectors;

        let (_temp_dir, db) = setup_test_db();
        let note = create_simple_note(&db, "共享向量宿主", "正文");

        let mut valid = serde_json::Map::new();
        for key in test_vectors::VALID_OPERATOR_KEYS {
            valid.insert((*key).to_string(), serde_json::json!("v"));
        }
        for key in test_vectors::STORABLE_BUT_NOT_OPERATOR_SEARCHABLE_KEYS {
            valid.insert((*key).to_string(), serde_json::json!("v"));
        }
        // "status"/"Status" 在向量里同为合法键，但 trim+小写去重会拒绝共存，
        // 移除大小写变体后整体落库
        valid.remove("Status");
        VfsNoteRepo::set_note_props(&db, &note.id, serde_json::Value::Object(valid))
            .expect("共享向量中的合法键应全部可存");

        for (key, _expected_tag) in test_vectors::INVALID_KEYS {
            let result =
                VfsNoteRepo::set_note_props(&db, &note.id, serde_json::json!({ (*key): "v" }));
            assert!(result.is_err(), "共享向量中的非法键 {key:?} 应被写侧拒绝");
        }
        assert!(
            VfsNoteRepo::set_note_props(
                &db,
                &note.id,
                serde_json::json!({ (test_vectors::overlong_key()): "v" }),
            )
            .is_err(),
            "超长键应被写侧拒绝"
        );
    }
}
