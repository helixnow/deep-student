//! 笔记自定义属性（notes.props）共享键语法与读侧解析
//!
//! ## 为什么单独成模块
//! props 的「键语法」被三方消费，且必须保持一致：
//! 1. 写侧校验：`VfsNoteRepo::validate_note_props`（本模块 [`validate_prop_key`]）；
//! 2. 搜索过滤：`dstu::handler_utils::search_helpers::normalize_prop_filters`
//!    （本模块 [`normalize_prop_key`]）；
//! 3. 搜索 overlay 的 `key:value` 操作符（前端 `parseTagQuery.ts` 的
//!    `parseSearchOperators` 正则；本模块 [`is_operator_searchable_key`] 是其
//!    Rust 镜像，仅用于测试与文档对齐，不参与运行时逻辑）。
//!
//! 三方共享同一组测试向量（见 [`test_vectors`]，前端镜像在
//! `src/features/workbench/apps/notes/__tests__/parseTagQuery.test.ts`）。
//!
//! ## 读侧畸形 props 观测
//! `row_to_note` 读 props 列时，畸形数据（JSON 解析失败 / 非 object /
//! 空 object——写侧应把空对象规范化为 SQL NULL，落库 `{}` 说明有旁路写入）
//! 一律 `tracing::warn` + 原子计数（[`malformed_props_total`]），
//! 不允许静默退化为 `None` 而无任何痕迹。
//! 注意：查询未选出 props 列（rusqlite `InvalidColumnName`）不是畸形，
//! 属正常投影路径，保持静默回退 None（在 `row_to_note` 中处理）。

use std::sync::atomic::{AtomicU64, Ordering};

// ============================================================================
// 键语法常量（canonical；VfsNoteRepo 上的同名常量是本处的别名）
// ============================================================================

/// 单条笔记自定义属性数量上限（与前端 NOTE_PROPS_MAX_COUNT 一致）
pub const MAX_PROPS: usize = 32;
/// 属性键长度上限（字符数，与前端 NOTE_PROP_KEY_MAX_CHARS 一致）
pub const MAX_PROP_KEY_CHARS: usize = 64;
/// 属性值长度上限（字符数，与前端 NOTE_PROP_VALUE_MAX_CHARS 一致）
pub const MAX_PROP_VALUE_CHARS: usize = 512;
/// 与内建元数据/搜索操作符冲突的保留键（小写比较，
/// 与前端 NOTE_PROPS_RESERVED_KEYS 一致）
pub const PROPS_RESERVED_KEYS: [&str; 7] = [
    "tags",
    "tag",
    "path",
    "title",
    "isfavorite",
    "snippet",
    "props",
];

// ============================================================================
// 键校验 / 规范化
// ============================================================================

/// 写侧键校验失败原因（reason 文案与历史 `validate_note_props` 保持一致）
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PropKeyError {
    Empty,
    TooLong,
    Reserved,
    ControlChar,
}

impl PropKeyError {
    /// 用户可见的失败原因（沿用 validate_note_props 的既有文案）
    pub fn reason(&self, trimmed_key: &str) -> String {
        match self {
            PropKeyError::Empty => "属性名不能为空".to_string(),
            PropKeyError::TooLong => {
                format!("属性名过长（最多 {MAX_PROP_KEY_CHARS} 个字符）")
            }
            PropKeyError::Reserved => format!("属性名 {trimmed_key:?} 为保留字"),
            PropKeyError::ControlChar => "属性名不能包含控制字符".to_string(),
        }
    }
}

/// 写侧键校验：trim 后非空 / 长度上限 / 非保留字 / 无控制字符。
///
/// 成功时返回 trim 后的键（调用方用它做小写去重与落库）。
/// 跨键约束（重复键、数量上限）由调用方负责——那需要整个对象的状态。
pub fn validate_prop_key(key: &str) -> Result<&str, PropKeyError> {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return Err(PropKeyError::Empty);
    }
    if trimmed.chars().count() > MAX_PROP_KEY_CHARS {
        return Err(PropKeyError::TooLong);
    }
    if PROPS_RESERVED_KEYS.contains(&trimmed.to_lowercase().as_str()) {
        return Err(PropKeyError::Reserved);
    }
    if trimmed.chars().any(|c| c.is_control()) {
        return Err(PropKeyError::ControlChar);
    }
    Ok(trimmed)
}

/// 搜索侧键规范化：trim + 小写；空键返回 None（过滤条件被丢弃）。
///
/// 搜索侧刻意比写侧宽松：对保留字/超长键过滤只是永不命中，不需要报错。
pub fn normalize_prop_key(key: &str) -> Option<String> {
    let normalized = key.trim().to_lowercase();
    if normalized.is_empty() {
        None
    } else {
        Some(normalized)
    }
}

/// 前端搜索 `key:value` 操作符键正则的 Rust 镜像：
/// `[\p{L}\p{N}_][\p{L}\p{N}_-]*`（见 parseTagQuery.ts `parseSearchOperators`）。
///
/// `char::is_alphanumeric` 覆盖 Unicode L* 与 N* 类别，与 `\p{L}\p{N}` 对齐。
/// 返回 false 的键仍可合法存储（如含空格），只是无法用操作符语法检索——
/// 这一「可存不可搜」缝隙由共享测试向量显式钉住。
pub fn is_operator_searchable_key(key: &str) -> bool {
    let mut chars = key.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !(first.is_alphanumeric() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_alphanumeric() || c == '_' || c == '-')
}

// ============================================================================
// 读侧畸形 props 观测（warn + 原子计数）
// ============================================================================

/// 进程级畸形 props 累计计数（跨库/跨连接共享；只增不减）。
/// Relaxed 足够：计数仅用于观测，不参与任何同步决策。
static MALFORMED_PROPS_TOTAL: AtomicU64 = AtomicU64::new(0);

/// 畸形 props 累计条数（进程级观测口径，可挂到诊断面板/日志导出）
pub fn malformed_props_total() -> u64 {
    MALFORMED_PROPS_TOTAL.load(Ordering::Relaxed)
}

/// 畸形类别（进 warn 日志的稳定标签）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MalformedPropsKind {
    /// props 列内容不是合法 JSON
    InvalidJson,
    /// 合法 JSON 但不是 object（数组/标量等）
    NotAnObject,
    /// 空 object `{}`：写侧应规范化为 SQL NULL，落库说明有旁路写入
    EmptyObject,
    /// props 列取值失败（列存在但类型/转换错误；不含 InvalidColumnName）
    ColumnRead,
}

impl MalformedPropsKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            MalformedPropsKind::InvalidJson => "invalid_json",
            MalformedPropsKind::NotAnObject => "not_an_object",
            MalformedPropsKind::EmptyObject => "empty_object",
            MalformedPropsKind::ColumnRead => "column_read",
        }
    }
}

/// 记录一次畸形 props：warn 日志 + 原子计数。detail 建议含截断后的原始值。
pub fn record_malformed_props(note_id: &str, kind: MalformedPropsKind, detail: &str) {
    let total = MALFORMED_PROPS_TOTAL.fetch_add(1, Ordering::Relaxed) + 1;
    tracing::warn!(
        "[VFS::NoteProps] Malformed props for note {} (kind={}, total={}): {}",
        note_id,
        kind.as_str(),
        total,
        detail
    );
}

/// 日志里原始值的截断长度（字符），避免把整段用户数据刷进日志
const RAW_SNIPPET_CHARS: usize = 120;

fn snippet(raw: &str) -> String {
    if raw.chars().count() <= RAW_SNIPPET_CHARS {
        raw.to_string()
    } else {
        let cut: String = raw.chars().take(RAW_SNIPPET_CHARS).collect();
        format!("{cut}…")
    }
}

/// 解析 props 列的文本值（SQL NULL 已在上游转成 `None`，正常路径静默）。
///
/// 返回 `Some(object)` 仅当值是非空 JSON object；其余情况（解析失败 /
/// 非 object / 空 object）warn + 计数后返回 `None`——绝不静默丢数据痕迹。
pub fn parse_props_cell(note_id: &str, raw: Option<&str>) -> Option<serde_json::Value> {
    let raw = raw?;
    match serde_json::from_str::<serde_json::Value>(raw) {
        Err(error) => {
            record_malformed_props(
                note_id,
                MalformedPropsKind::InvalidJson,
                &format!("{error}; raw={}", snippet(raw)),
            );
            None
        }
        Ok(value) => match value.as_object() {
            None => {
                record_malformed_props(
                    note_id,
                    MalformedPropsKind::NotAnObject,
                    &format!("JSON 不是对象; raw={}", snippet(raw)),
                );
                None
            }
            Some(map) if map.is_empty() => {
                record_malformed_props(
                    note_id,
                    MalformedPropsKind::EmptyObject,
                    "空对象落库（写侧应规范化为 SQL NULL），疑似旁路写入",
                );
                None
            }
            Some(_) => Some(value),
        },
    }
}

// ============================================================================
// 共享测试向量：键语法（写侧） × 搜索语法（后端过滤 + 前端操作符）
// 前端镜像：src/features/workbench/apps/notes/__tests__/parseTagQuery.test.ts
// 改动任一侧语法时，必须同步更新两处向量。
// ============================================================================

#[cfg(test)]
pub mod test_vectors {
    /// 合法键：写侧可存，且搜索 `key:value` 操作符语法可表达
    pub const VALID_OPERATOR_KEYS: &[&str] = &[
        "status",
        "Status",
        "优先级",
        "due_date",
        "sprint-42",
        "p0",
        "_internal",
        "k",
    ];

    /// 写侧可存、但搜索操作符语法无法表达的键（可存不可搜缝隙，显式钉住）
    pub const STORABLE_BUT_NOT_OPERATOR_SEARCHABLE_KEYS: &[&str] = &[
        "my key",  // 含空格：操作符按空白分词
        "a:b",     // 含冒号：会被解析成 key=a value=b…
        "emoji🙂", // 🙂 不属于 \p{L}\p{N}_-
        "-lead",   // 首字符不允许连字符
        "得 分",   // CJK + 空格
    ];

    /// 非法键（写侧拒绝）与预期失败类别标签
    /// （标签对应 super::PropKeyError：empty / too_long / reserved / control）
    pub const INVALID_KEYS: &[(&str, &str)] = &[
        ("", "empty"),
        ("   ", "empty"),
        ("tags", "reserved"),
        ("TAGS", "reserved"),
        ("Tag", "reserved"),
        ("path", "reserved"),
        ("title", "reserved"),
        ("isFavorite", "reserved"),
        ("snippet", "reserved"),
        ("props", "reserved"),
        ("bad\u{0007}key", "control"),
        ("tab\tkey", "control"),
    ];

    /// 超长键（65 字符，超出 MAX_PROP_KEY_CHARS=64）——const 无法 repeat，用函数
    pub fn overlong_key() -> String {
        "k".repeat(super::MAX_PROP_KEY_CHARS + 1)
    }

    /// 恰好到上限的键（64 字符）——合法边界
    pub fn max_len_key() -> String {
        "k".repeat(super::MAX_PROP_KEY_CHARS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn error_tag(error: &PropKeyError) -> &'static str {
        match error {
            PropKeyError::Empty => "empty",
            PropKeyError::TooLong => "too_long",
            PropKeyError::Reserved => "reserved",
            PropKeyError::ControlChar => "control",
        }
    }

    #[test]
    fn valid_operator_keys_pass_all_three_syntaxes() {
        for key in test_vectors::VALID_OPERATOR_KEYS {
            assert!(validate_prop_key(key).is_ok(), "写侧应接受合法键 {key:?}");
            assert!(
                normalize_prop_key(key).is_some(),
                "搜索侧规范化不应丢弃合法键 {key:?}"
            );
            assert!(
                is_operator_searchable_key(key),
                "操作符语法应能表达合法键 {key:?}"
            );
        }
    }

    #[test]
    fn storable_keys_outside_operator_syntax_are_pinned() {
        for key in test_vectors::STORABLE_BUT_NOT_OPERATOR_SEARCHABLE_KEYS {
            assert!(
                validate_prop_key(key).is_ok(),
                "写侧应接受键 {key:?}（可存）"
            );
            assert!(
                !is_operator_searchable_key(key),
                "键 {key:?} 不应被操作符语法表达（不可搜）"
            );
        }
    }

    #[test]
    fn invalid_keys_are_rejected_with_expected_category() {
        for (key, expected_tag) in test_vectors::INVALID_KEYS {
            let error = validate_prop_key(key).expect_err(&format!("写侧应拒绝非法键 {key:?}"));
            assert_eq!(
                error_tag(&error),
                *expected_tag,
                "键 {key:?} 的失败类别不符"
            );
        }
        let overlong = test_vectors::overlong_key();
        assert_eq!(
            validate_prop_key(&overlong),
            Err(PropKeyError::TooLong),
            "超长键应按 too_long 拒绝"
        );
        assert!(
            validate_prop_key(&test_vectors::max_len_key()).is_ok(),
            "64 字符边界键应合法"
        );
    }

    #[test]
    fn normalize_drops_only_empty_keys() {
        assert_eq!(normalize_prop_key("  Status "), Some("status".to_string()));
        assert_eq!(normalize_prop_key("   "), None);
        assert_eq!(normalize_prop_key(""), None);
        // 搜索侧刻意宽松：保留字/超长键规范化后保留（过滤时永不命中即可）
        assert_eq!(normalize_prop_key("tags"), Some("tags".to_string()));
    }

    #[test]
    fn parse_props_cell_accepts_nonempty_object_and_preserves_json_types() {
        let parsed = parse_props_cell(
            "note_ok",
            Some(r#"{"status":"done","priority":2,"pinned":true}"#),
        )
        .expect("非空对象应解析成功");
        assert_eq!(parsed["status"], serde_json::json!("done"));
        // 读侧保留 JSON 原生类型：number/bool 不得退化为字符串
        assert_eq!(parsed["priority"], serde_json::json!(2));
        assert_eq!(parsed["pinned"], serde_json::json!(true));
    }

    #[test]
    fn parse_props_cell_null_is_silent_and_uncounted() {
        let before = malformed_props_total();
        assert_eq!(parse_props_cell("note_null", None), None);
        assert_eq!(
            malformed_props_total(),
            before,
            "SQL NULL 是正常路径，不应计入畸形计数"
        );
    }

    #[test]
    fn parse_props_cell_counts_invalid_json() {
        let before = malformed_props_total();
        assert_eq!(parse_props_cell("note_bad_json", Some("not-json{")), None);
        assert!(
            malformed_props_total() > before,
            "JSON 解析失败必须计数（不允许静默 None）"
        );
    }

    #[test]
    fn parse_props_cell_counts_non_object() {
        let before = malformed_props_total();
        assert_eq!(parse_props_cell("note_array", Some("[1,2]")), None);
        assert_eq!(parse_props_cell("note_scalar", Some("\"str\"")), None);
        assert!(
            malformed_props_total() >= before + 2,
            "非 object 的 JSON 必须逐条计数"
        );
    }

    #[test]
    fn parse_props_cell_counts_empty_object() {
        let before = malformed_props_total();
        assert_eq!(parse_props_cell("note_empty_obj", Some("{}")), None);
        assert!(
            malformed_props_total() > before,
            "空对象落库违反写侧规范化约定，必须计数"
        );
    }

    #[test]
    fn snippet_truncates_long_raw_on_char_boundary() {
        let long = "属".repeat(RAW_SNIPPET_CHARS + 10);
        let cut = snippet(&long);
        assert!(cut.ends_with('…'));
        assert_eq!(cut.chars().count(), RAW_SNIPPET_CHARS + 1);
        assert_eq!(snippet("short"), "short");
    }
}
