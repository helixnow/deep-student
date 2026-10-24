//! VFS 智能题目集表 CRUD 操作
//!
//! 题目实体管理，与 OCR 预览解耦，支持增量更新、历史追溯。
//!
//! ## 核心方法
//! - `list_questions`: 列出题目（分页+筛选）
//! - `search_questions`: 全文搜索题目（FTS5）
//! - `get_question`: 获取单题详情
//! - `create_question`: 创建题目
//! - `update_question`: 更新题目
//! - `delete_question`: 软删除题目
//!
//! ## FTS5 全文检索
//! - 支持中英文混合搜索
//! - 支持搜索高亮（返回匹配片段）
//! - 支持相关性排序（BM25 算法）
//! - 搜索词长度限制（最大 200 字符）
//! - 特殊字符自动转义

use std::collections::HashMap;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use tracing::{debug, info, warn};

use crate::question_sync_service::QuestionSyncService;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};

/// 从 `questions.provenance_json` 解析题干/答案来源定位。
///
/// provenance 是只读来源证据快照，不是可写题目内容；解析失败按"无定位"处理，
/// 不阻断题目读取（旧数据本来就没有 provenance）。
fn parse_provenance_refs(
    provenance_json: Option<&str>,
) -> (
    Vec<crate::qbank_document::SourceRef>,
    Vec<crate::qbank_document::SourceRef>,
) {
    let Some(raw) = provenance_json.filter(|s| !s.trim().is_empty()) else {
        return (Vec::new(), Vec::new());
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(raw) else {
        warn!("[VFS::QuestionRepo] provenance_json 不是合法 JSON，按无来源处理");
        return (Vec::new(), Vec::new());
    };
    let parse = |key: &str| -> Vec<crate::qbank_document::SourceRef> {
        value
            .get(key)
            .cloned()
            .and_then(|v| serde_json::from_value(v).ok())
            .unwrap_or_default()
    };
    (parse("source_refs"), parse("answer_source_refs"))
}

/// 表是否存在于当前连接（兼容迁移前后的测试库）。
fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        params![table],
        |row| row.get::<_, bool>(0),
    )
    .unwrap_or(false)
}

/// Log row-parse errors instead of silently discarding them.
fn log_and_skip_err<T>(result: Result<T, rusqlite::Error>) -> Option<T> {
    match result {
        Ok(v) => Some(v),
        Err(e) => {
            warn!("[VFS::QuestionRepo] Row parse error (skipped): {}", e);
            None
        }
    }
}

// ============================================================================
// 数据类型定义
// ============================================================================

/// 题目类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum QuestionType {
    SingleChoice,
    MultipleChoice,
    IndefiniteChoice,
    FillBlank,
    ShortAnswer,
    Essay,
    Calculation,
    Proof,
    /// 判断题：answer 为 "true"|"false"，不使用 structured_data
    TrueFalse,
    /// 匹配/连线题：structured_data.pairs 为标准答案
    Matching,
    /// 排序题：structured_data.correct_order 为标准答案
    Ordering,
    /// 数值题：structured_data 携带 answer_value/tolerance/unit/tolerance_mode
    Numeric,
    #[default]
    Other,
}

impl QuestionType {
    pub fn as_str(&self) -> &'static str {
        match self {
            QuestionType::SingleChoice => "single_choice",
            QuestionType::MultipleChoice => "multiple_choice",
            QuestionType::IndefiniteChoice => "indefinite_choice",
            QuestionType::FillBlank => "fill_blank",
            QuestionType::ShortAnswer => "short_answer",
            QuestionType::Essay => "essay",
            QuestionType::Calculation => "calculation",
            QuestionType::Proof => "proof",
            QuestionType::TrueFalse => "true_false",
            QuestionType::Matching => "matching",
            QuestionType::Ordering => "ordering",
            QuestionType::Numeric => "numeric",
            QuestionType::Other => "other",
        }
    }

    pub fn from_str(s: &str) -> Self {
        // 宽松归一化：DB 内始终是 snake_case，但 mock exam / paper 配置里的题型键
        // 可能来自前端 Debug 格式（"SingleChoice"）或 camelCase。去掉分隔符并统一
        // 小写后再匹配，避免这些入口被静默映射为 Other。
        let compact: String = s
            .chars()
            .filter(|c| *c != '_' && *c != '-' && !c.is_whitespace())
            .collect::<String>()
            .to_lowercase();
        match compact.as_str() {
            "singlechoice" => QuestionType::SingleChoice,
            "multiplechoice" => QuestionType::MultipleChoice,
            "indefinitechoice" => QuestionType::IndefiniteChoice,
            "fillblank" => QuestionType::FillBlank,
            "shortanswer" => QuestionType::ShortAnswer,
            "essay" => QuestionType::Essay,
            "calculation" => QuestionType::Calculation,
            "proof" => QuestionType::Proof,
            "truefalse" => QuestionType::TrueFalse,
            "matching" => QuestionType::Matching,
            "ordering" => QuestionType::Ordering,
            "numeric" => QuestionType::Numeric,
            _ => QuestionType::Other,
        }
    }
}

/// 难度
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum Difficulty {
    Easy,
    #[default]
    Medium,
    Hard,
    VeryHard,
}

impl Difficulty {
    pub fn as_str(&self) -> &'static str {
        match self {
            Difficulty::Easy => "easy",
            Difficulty::Medium => "medium",
            Difficulty::Hard => "hard",
            Difficulty::VeryHard => "very_hard",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "easy" => Difficulty::Easy,
            "medium" => Difficulty::Medium,
            "hard" => Difficulty::Hard,
            "very_hard" => Difficulty::VeryHard,
            _ => Difficulty::Medium,
        }
    }
}

/// 学习状态
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum QuestionStatus {
    #[default]
    New,
    InProgress,
    Mastered,
    Review,
}

impl QuestionStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            QuestionStatus::New => "new",
            QuestionStatus::InProgress => "in_progress",
            QuestionStatus::Mastered => "mastered",
            QuestionStatus::Review => "review",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "new" => QuestionStatus::New,
            "in_progress" => QuestionStatus::InProgress,
            "mastered" => QuestionStatus::Mastered,
            "review" => QuestionStatus::Review,
            _ => QuestionStatus::New,
        }
    }
}

/// 来源类型
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    #[default]
    Ocr,
    Imported,
    AiGenerated,
    Manual,
}

impl SourceType {
    pub fn as_str(&self) -> &'static str {
        match self {
            SourceType::Ocr => "ocr",
            SourceType::Imported => "imported",
            SourceType::AiGenerated => "ai_generated",
            SourceType::Manual => "manual",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "ocr" => SourceType::Ocr,
            "imported" => SourceType::Imported,
            "ai_generated" => SourceType::AiGenerated,
            "manual" => SourceType::Manual,
            _ => SourceType::Ocr,
        }
    }
}

/// 选项
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QuestionOption {
    pub key: String,
    pub content: String,
}

/// 题目关联图片
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct QuestionImage {
    /// VFS 附件 ID
    pub id: String,
    /// 原始文件名
    pub name: String,
    /// MIME 类型
    pub mime: String,
    /// 内容哈希 (SHA-256)
    pub hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
}

/// 题目实体
///
/// 题组/材料字段（`group_id`/`group_position`/`group_label`/`materials`）是
/// 读取期投影：成员关系只以 `questions.group_id/group_position` 为权威，
/// `materials` 由 `qbank_group_materials` + `qbank_materials` 派生，
/// 不在题目行里重复存一份可写副本。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Question {
    pub id: String,
    pub exam_id: String,
    pub card_id: Option<String>,
    pub question_label: Option<String>,
    pub content: String,
    pub options: Option<Vec<QuestionOption>>,
    pub answer: Option<String>,
    pub explanation: Option<String>,
    /// 结构化题目数据（新题型契约）。DB 中以 JSON 文本存储于 questions.structured_data。
    /// 各题型 schema 见迁移 V20260807__question_structured_data.sql 头注释。
    #[serde(default)]
    pub structured_data: Option<serde_json::Value>,
    pub question_type: QuestionType,
    pub difficulty: Option<Difficulty>,
    pub tags: Vec<String>,
    pub status: QuestionStatus,
    pub user_answer: Option<String>,
    pub is_correct: Option<bool>,
    pub attempt_count: i32,
    pub correct_count: i32,
    pub last_attempt_at: Option<String>,
    pub user_note: Option<String>,
    pub is_favorite: bool,
    pub is_bookmarked: bool,
    pub source_type: SourceType,
    pub source_ref: Option<String>,
    pub images: Vec<QuestionImage>,
    pub parent_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    // AI 评判缓存（最新一次）
    pub ai_feedback: Option<String>,
    pub ai_score: Option<i32>,
    pub ai_graded_at: Option<String>,
    /// 所属题组（issue 491）。普通独立题为 None。
    #[serde(default)]
    pub group_id: Option<String>,
    /// 题组内稳定顺序（0 起）。
    #[serde(default)]
    pub group_position: Option<i32>,
    /// 题组展示标题（读取期从 qbank_groups 派生）。
    #[serde(default)]
    pub group_label: Option<String>,
    /// 该题所需的共享材料（读取期从 qbank_group_materials 派生，去重、按 position 排序）。
    #[serde(default)]
    pub materials: Vec<crate::qbank_document::QuestionMaterial>,
    /// 答案来源：source | generated | manual | unknown。
    #[serde(default)]
    pub answer_origin: Option<String>,
    /// 题干来源定位（来自 provenance_json.source_refs）。
    #[serde(default)]
    pub source_refs: Vec<crate::qbank_document::SourceRef>,
    /// 答案来源定位（来自 provenance_json.answer_source_refs）。
    #[serde(default)]
    pub answer_source_refs: Vec<crate::qbank_document::SourceRef>,
    /// 原始来源键（同一来源+题位稳定标识，用于重解析去重/冲突识别）。
    #[serde(default)]
    pub source_key: Option<String>,
}

/// 作答历史记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnswerSubmission {
    pub id: String,
    pub question_id: String,
    pub user_answer: String,
    pub is_correct: Option<bool>,
    pub grading_method: String,
    pub submitted_at: String,
}

/// 作答时冻结的题目/材料快照（历史复核用）。
///
/// 单独成结构而不是给 `AnswerSubmission` 加字段：旧调用点按位置构造
/// `AnswerSubmission` 的代码不受影响，快照只在需要复核的路径显式读取。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SubmissionSnapshot {
    pub submission_id: String,
    /// 提交当时的题目投影（题干/选项/答案/结构化数据/题组与材料 id）。
    pub question_snapshot_json: Option<String>,
    /// 提交当时题目所依赖共享材料的完整快照（含版本）。
    pub material_snapshot_json: Option<String>,
}

/// 题目筛选参数
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QuestionFilters {
    pub status: Option<Vec<QuestionStatus>>,
    pub difficulty: Option<Vec<Difficulty>>,
    pub question_type: Option<Vec<QuestionType>>,
    pub tags: Option<Vec<String>>,
    pub search: Option<String>,
    pub is_favorite: Option<bool>,
    pub is_bookmarked: Option<bool>,
}

/// 题目列表结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionListResult {
    pub questions: Vec<Question>,
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
    pub has_more: bool,
}

/// 跨题目集错题本筛选（错题 = status 'review'，与题目集内「错题本」同口径）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MistakeListFilters {
    pub exam_id: Option<String>,
    /// 题干 / 答案 / 解析 / 标签 模糊匹配
    pub search: Option<String>,
    /// recent（默认，最近做错在前）| errors（错得多的在前）
    pub sort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MistakeQuestion {
    #[serde(flatten)]
    pub question: Question,
    pub exam_name: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MistakeExamCount {
    pub exam_id: String,
    pub exam_name: Option<String>,
    pub count: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MistakeListResult {
    pub items: Vec<MistakeQuestion>,
    /// 筛选后的总数（分页依据）
    pub total: i64,
    pub page: u32,
    pub page_size: u32,
    pub has_more: bool,
    /// 各题目集错题数（不受题目集 / 搜索筛选影响），多的在前
    pub exams: Vec<MistakeExamCount>,
}

// ============================================================================
// FTS5 全文搜索相关类型
// ============================================================================

/// 搜索词最大长度限制
pub const MAX_SEARCH_KEYWORD_LENGTH: usize = 200;

/// FTS5 搜索结果项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionSearchResult {
    /// 题目实体
    pub question: Question,
    /// 匹配高亮片段（content 字段的匹配部分）
    pub highlight_content: Option<String>,
    /// 匹配高亮片段（answer 字段的匹配部分）
    pub highlight_answer: Option<String>,
    /// 匹配高亮片段（explanation 字段的匹配部分）
    pub highlight_explanation: Option<String>,
    /// BM25 相关性分数（越小越相关，负数）
    pub relevance_score: f64,
}

/// 搜索结果列表
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionSearchListResult {
    /// 搜索结果列表
    pub results: Vec<QuestionSearchResult>,
    /// 匹配总数
    pub total: i64,
    /// 当前页码
    pub page: u32,
    /// 每页大小
    pub page_size: u32,
    /// 是否有更多结果
    pub has_more: bool,
    /// 搜索耗时（毫秒）
    pub search_time_ms: u64,
}

/// 搜索筛选参数（扩展 QuestionFilters）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct QuestionSearchFilters {
    /// 基础筛选条件
    #[serde(flatten)]
    pub base: QuestionFilters,
    /// 搜索排序方式
    pub sort_by: Option<SearchSortBy>,
}

/// 搜索排序方式
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SearchSortBy {
    /// 按相关性排序（默认）
    #[default]
    Relevance,
    /// 按创建时间倒序
    CreatedDesc,
    /// 按创建时间正序
    CreatedAsc,
    /// 按更新时间倒序
    UpdatedDesc,
}

/// 题目创建参数
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CreateQuestionParams {
    pub exam_id: String,
    pub card_id: Option<String>,
    pub question_label: Option<String>,
    pub content: String,
    pub options: Option<Vec<QuestionOption>>,
    pub answer: Option<String>,
    pub explanation: Option<String>,
    /// 结构化题目数据（JSON），按题型契约存储；None 时不写入
    #[serde(default)]
    pub structured_data: Option<serde_json::Value>,
    pub question_type: Option<QuestionType>,
    pub difficulty: Option<Difficulty>,
    pub tags: Option<Vec<String>>,
    pub source_type: Option<SourceType>,
    pub source_ref: Option<String>,
    pub images: Option<Vec<QuestionImage>>,
    pub parent_id: Option<String>,
}

/// 题目更新参数（增量更新）
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateQuestionParams {
    pub question_label: Option<String>,
    pub content: Option<String>,
    pub options: Option<Vec<QuestionOption>>,
    pub answer: Option<String>,
    pub explanation: Option<String>,
    /// 结构化题目数据。None = 不更新；Some(Value::Null) = 清空该列
    /// （JSON 载荷传 null 会被 serde 解析为 None，前端如需清空请传 JSON null 字面量
    /// 的包装对象，或由 Rust 调用方显式传 Some(Value::Null)）。
    /// 例外：question_type 切换到不使用 structured_data 的题型且本字段为 None 时，
    /// 更新会自动把该列清为 NULL（见 should_clear_stale_structured_data）。
    #[serde(default)]
    pub structured_data: Option<serde_json::Value>,
    pub question_type: Option<QuestionType>,
    pub difficulty: Option<Difficulty>,
    pub tags: Option<Vec<String>>,
    pub status: Option<QuestionStatus>,
    pub user_answer: Option<String>,
    pub is_correct: Option<bool>,
    pub user_note: Option<String>,
    pub is_favorite: Option<bool>,
    pub is_bookmarked: Option<bool>,
    pub images: Option<Vec<QuestionImage>>,
    /// ACR R2-01：可选乐观锁基线；None 时保持旧行为（兼容存量调用）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_updated_at: Option<String>,
}

impl UpdateQuestionParams {
    /// 题型切换后是否需要清空残留的 structured_data。
    ///
    /// 前端传 JSON null 会被 serde 解析为 None（=不更新），因此把 matching
    /// 等结构化题型改成简答题时旧 {left,right,pairs} 会永远残留在 DB。规则：
    /// 显式指定了新题型（question_type 为 Some）、新题型不使用 structured_data
    /// （非 fill_blank/matching/ordering/numeric）、且本次未显式携带
    /// structured_data 时，更新需把该列清为 NULL。question_type 为 None 的
    /// 普通更新（如只改难度）绝不触发清空。
    pub fn should_clear_stale_structured_data(&self) -> bool {
        match (&self.question_type, &self.structured_data) {
            (Some(next_type), None) => !matches!(
                next_type,
                QuestionType::FillBlank
                    | QuestionType::Matching
                    | QuestionType::Ordering
                    | QuestionType::Numeric
            ),
            _ => false,
        }
    }
}

/// 历史记录
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionHistory {
    pub id: String,
    pub question_id: String,
    pub field_name: String,
    pub old_value: Option<String>,
    pub new_value: Option<String>,
    pub operator: String,
    pub reason: Option<String>,
    pub created_at: String,
}

/// 统计数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuestionBankStats {
    pub exam_id: String,
    pub total_count: i32,
    pub new_count: i32,
    pub in_progress_count: i32,
    pub mastered_count: i32,
    pub review_count: i32,
    pub total_attempts: i32,
    pub total_correct: i32,
    pub correct_rate: f64,
    pub updated_at: String,
}

// ============================================================================
// VFS 题目表 Repo
// ============================================================================

/// VFS 题目表 Repo
pub struct VfsQuestionRepo;

impl VfsQuestionRepo {
    // ========================================================================
    // FTS5 辅助方法
    // ========================================================================

    /// 转义 FTS5 搜索词中的特殊字符
    ///
    /// FTS5 查询语法中裸词只允许字母数字等有限字符，`"` `*` `(` `)` `-` `:` `^`
    /// `+` `~` `.` `?` `'` `/` 以及 AND/OR/NOT 关键字都会改变语义或直接导致
    /// `MATCH` 语法错误。黑名单式检测无法穷举，因此这里无条件按空白分词并对
    /// 每个词加双引号（词内 `"` 双写转义），词间保持 FTS5 隐式 AND 语义。
    fn escape_fts5_query(keyword: &str) -> String {
        keyword
            .split_whitespace()
            .map(|token| format!("\"{}\"", token.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" ")
    }

    /// 验证并清理搜索关键词
    ///
    /// - 限制长度不超过 MAX_SEARCH_KEYWORD_LENGTH
    /// - 移除首尾空白
    /// - 返回 None 如果关键词为空
    fn sanitize_search_keyword(keyword: &str) -> Option<String> {
        let trimmed = keyword.trim();
        if trimmed.is_empty() {
            return None;
        }

        // 限制长度
        let truncated: String = trimmed.chars().take(MAX_SEARCH_KEYWORD_LENGTH).collect();
        Some(truncated)
    }

    /// 检查 FTS5 表是否存在
    fn fts_table_exists(conn: &Connection) -> bool {
        conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='questions_fts'",
            [],
            |_| Ok(()),
        )
        .is_ok()
    }

    // ========================================================================
    // 全文搜索
    // ========================================================================

    /// 全文搜索题目（FTS5）
    ///
    /// # Arguments
    /// * `db` - VFS 数据库实例
    /// * `keyword` - 搜索关键词
    /// * `exam_id` - 可选，限定题目集
    /// * `filters` - 搜索筛选条件
    /// * `page` - 页码（从 1 开始）
    /// * `page_size` - 每页大小
    ///
    /// # Returns
    /// * 搜索结果列表，包含高亮片段和相关性分数
    pub fn search_questions(
        db: &VfsDatabase,
        keyword: &str,
        exam_id: Option<&str>,
        filters: &QuestionSearchFilters,
        page: u32,
        page_size: u32,
    ) -> VfsResult<QuestionSearchListResult> {
        let conn = db.get_conn_safe()?;
        Self::search_questions_with_conn(&conn, keyword, exam_id, filters, page, page_size)
    }

    /// 全文搜索题目（使用现有连接）
    pub fn search_questions_with_conn(
        conn: &Connection,
        keyword: &str,
        exam_id: Option<&str>,
        filters: &QuestionSearchFilters,
        page: u32,
        page_size: u32,
    ) -> VfsResult<QuestionSearchListResult> {
        let start_time = std::time::Instant::now();

        // 1. 验证并清理搜索词
        let sanitized_keyword = match Self::sanitize_search_keyword(keyword) {
            Some(k) => k,
            None => {
                // 空搜索词，返回空结果
                return Ok(QuestionSearchListResult {
                    results: vec![],
                    total: 0,
                    page,
                    page_size,
                    has_more: false,
                    search_time_ms: 0,
                });
            }
        };

        // 2. 检查 FTS5 表是否存在
        if !Self::fts_table_exists(conn) {
            warn!("[VFS::QuestionRepo] FTS5 table not found, falling back to LIKE search");
            return Self::fallback_like_search(
                conn,
                &sanitized_keyword,
                exam_id,
                filters,
                page,
                page_size,
                start_time,
            );
        }

        // 3. 转义搜索词
        let escaped_keyword = Self::escape_fts5_query(&sanitized_keyword);

        // 4. 分页边界检查
        let page = page.max(1);
        let page_size = page_size.clamp(1, 100); // 限制每页最大 100 条
        let offset = (page.saturating_sub(1)) * page_size;

        // 5. 构建筛选条件
        let mut where_clauses = vec!["q.deleted_at IS NULL".to_string()];
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![];
        let mut param_idx = 1;

        // exam_id 筛选
        if let Some(eid) = exam_id {
            where_clauses.push(format!("q.exam_id = ?{}", param_idx));
            params_vec.push(Box::new(eid.to_string()));
            param_idx += 1;
        }

        // 状态筛选
        if let Some(statuses) = &filters.base.status {
            if !statuses.is_empty() {
                let placeholders: Vec<String> = statuses
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                where_clauses.push(format!("q.status IN ({})", placeholders.join(", ")));
                for s in statuses {
                    params_vec.push(Box::new(s.as_str().to_string()));
                }
                param_idx += statuses.len();
            }
        }

        // 难度筛选
        if let Some(difficulties) = &filters.base.difficulty {
            if !difficulties.is_empty() {
                let placeholders: Vec<String> = difficulties
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                where_clauses.push(format!("q.difficulty IN ({})", placeholders.join(", ")));
                for d in difficulties {
                    params_vec.push(Box::new(d.as_str().to_string()));
                }
                param_idx += difficulties.len();
            }
        }

        // 题型筛选
        if let Some(types) = &filters.base.question_type {
            if !types.is_empty() {
                let placeholders: Vec<String> = types
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                where_clauses.push(format!("q.question_type IN ({})", placeholders.join(", ")));
                for t in types {
                    params_vec.push(Box::new(t.as_str().to_string()));
                }
                param_idx += types.len();
            }
        }

        // 标签筛选（与 list_questions 口径一致；此前 FTS 搜索静默忽略 tags 筛选）
        if let Some(tags) = &filters.base.tags {
            if !tags.is_empty() {
                let placeholders: Vec<String> = tags
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                where_clauses.push(format!(
                    "EXISTS (SELECT 1 FROM json_each(q.tags) WHERE value IN ({}))",
                    placeholders.join(", ")
                ));
                for tag in tags {
                    params_vec.push(Box::new(tag.to_string()));
                }
                param_idx += tags.len();
            }
        }

        // 收藏筛选
        if let Some(is_fav) = filters.base.is_favorite {
            where_clauses.push(format!("q.is_favorite = ?{}", param_idx));
            params_vec.push(Box::new(if is_fav { 1 } else { 0 }));
            param_idx += 1;
        }

        // 书签筛选
        if let Some(is_bm) = filters.base.is_bookmarked {
            where_clauses.push(format!("q.is_bookmarked = ?{}", param_idx));
            params_vec.push(Box::new(if is_bm { 1 } else { 0 }));
            param_idx += 1;
        }

        let where_clause = where_clauses.join(" AND ");

        // 6. 排序方式
        let order_clause = match filters.sort_by.as_ref().unwrap_or(&SearchSortBy::Relevance) {
            SearchSortBy::Relevance => "bm25(questions_fts) ASC", // BM25 分数越小越相关
            SearchSortBy::CreatedDesc => "q.created_at DESC",
            SearchSortBy::CreatedAsc => "q.created_at ASC",
            SearchSortBy::UpdatedDesc => "q.updated_at DESC",
        };

        // 7. 查询总数
        let count_sql = format!(
            r#"
            SELECT COUNT(*)
            FROM questions_fts fts
            JOIN questions q ON fts.rowid = q.rowid
            WHERE fts.questions_fts MATCH ?{} AND {}
            "#,
            param_idx, where_clause
        );

        // DRY: 复用已构建的 params_vec 构建逻辑，避免 count/query 两次重复构建。
        //
        // ⚠️ 绑定顺序契约：rusqlite 按切片位置绑定（params[i] → ?i+1），而 WHERE
        // 子句里的筛选占位符是 ?1..?N、MATCH 占位符是 ?{N+1}（最大编号）。因此
        // keyword 必须放在参数列表**末尾**——此前 keyword 被放在开头，导致
        // `q.exam_id = ?1` 实际绑定到了转义后的搜索词、MATCH 绑定到最后一个筛选值，
        // 任何带筛选条件的 FTS 搜索都会返回错误结果。
        let build_fts_params = |keyword: &str,
                                filters: &QuestionSearchFilters,
                                exam_id: Option<&str>|
         -> Vec<Box<dyn rusqlite::ToSql>> {
            let mut p: Vec<Box<dyn rusqlite::ToSql>> = vec![];
            if let Some(eid) = exam_id {
                p.push(Box::new(eid.to_string()));
            }
            if let Some(statuses) = &filters.base.status {
                for s in statuses {
                    p.push(Box::new(s.as_str().to_string()));
                }
            }
            if let Some(difficulties) = &filters.base.difficulty {
                for d in difficulties {
                    p.push(Box::new(d.as_str().to_string()));
                }
            }
            if let Some(types) = &filters.base.question_type {
                for t in types {
                    p.push(Box::new(t.as_str().to_string()));
                }
            }
            if let Some(tags) = &filters.base.tags {
                for tag in tags {
                    p.push(Box::new(tag.to_string()));
                }
            }
            if let Some(is_fav) = filters.base.is_favorite {
                p.push(Box::new(if is_fav { 1 } else { 0 }));
            }
            if let Some(is_bm) = filters.base.is_bookmarked {
                p.push(Box::new(if is_bm { 1 } else { 0 }));
            }
            p.push(Box::new(keyword.to_string()));
            p
        };

        let count_params_vec = build_fts_params(&escaped_keyword, filters, exam_id);
        let count_refs: Vec<&dyn rusqlite::ToSql> =
            count_params_vec.iter().map(|p| p.as_ref()).collect();
        // 转义后不会再出现 MATCH 语法错误，此处的失败是真实数据库错误，应当上抛
        // 而不是静默返回 0（否则前端会把查询故障误显示为"无结果"）。
        let total: i64 = conn.query_row(&count_sql, count_refs.as_slice(), |row| row.get(0))?;

        // 8. 查询数据（带高亮和相关性分数）
        let query_sql = format!(
            r#"
            SELECT
                q.id, q.exam_id, q.card_id, q.question_label, q.content, q.options_json,
                q.answer, q.explanation, q.question_type, q.difficulty, q.tags,
                q.status, q.user_answer, q.is_correct, q.attempt_count, q.correct_count,
                q.last_attempt_at, q.user_note, q.is_favorite, q.is_bookmarked,
                q.source_type, q.source_ref, q.images_json, q.parent_id, q.created_at, q.updated_at,
                q.ai_feedback, q.ai_score, q.ai_graded_at, q.structured_data,
                q.group_id, q.group_position, q.source_key, q.provenance_json, q.answer_origin,
                highlight(questions_fts, 0, '<mark>', '</mark>') as hl_content,
                highlight(questions_fts, 1, '<mark>', '</mark>') as hl_answer,
                highlight(questions_fts, 2, '<mark>', '</mark>') as hl_explanation,
                bm25(questions_fts) as relevance
            FROM questions_fts fts
            JOIN questions q ON fts.rowid = q.rowid
            WHERE fts.questions_fts MATCH ?{} AND {}
            ORDER BY {}
            LIMIT ?{} OFFSET ?{}
            "#,
            param_idx,
            where_clause,
            order_clause,
            param_idx + 1,
            param_idx + 2
        );

        // 构建查询参数（复用 DRY helper）
        let mut query_params_vec = build_fts_params(&escaped_keyword, filters, exam_id);
        query_params_vec.push(Box::new(page_size));
        query_params_vec.push(Box::new(offset));

        let query_refs: Vec<&dyn rusqlite::ToSql> =
            query_params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&query_sql)?;

        let rows = stmt.query_map(query_refs.as_slice(), |row| {
            // 解析基础 Question 字段
            let question = Self::row_to_question(row)?;

            // 解析高亮和分数字段（索引 35-38；基础列 0-34，structured_data 在 29，
            // 题组/来源投影列 30-34 与 row_to_question 保持一致）
            let hl_content: Option<String> = row.get(35)?;
            let hl_answer: Option<String> = row.get(36)?;
            let hl_explanation: Option<String> = row.get(37)?;
            let relevance: f64 = row.get(38)?;

            Ok(QuestionSearchResult {
                question,
                highlight_content: hl_content,
                highlight_answer: hl_answer,
                highlight_explanation: hl_explanation,
                relevance_score: relevance,
            })
        })?;

        let mut results: Vec<QuestionSearchResult> = rows.filter_map(log_and_skip_err).collect();
        {
            let mut questions: Vec<Question> = results.iter().map(|r| r.question.clone()).collect();
            Self::hydrate_question_context_with_conn(conn, &mut questions)?;
            for (result, question) in results.iter_mut().zip(questions) {
                result.question = question;
            }
        }
        let has_more = (offset + page_size) < total as u32;
        let search_time_ms = start_time.elapsed().as_millis() as u64;

        debug!(
            "[VFS::QuestionRepo] FTS5 search completed: keyword='{}', found={}, total={}, time={}ms",
            sanitized_keyword, results.len(), total, search_time_ms
        );

        Ok(QuestionSearchListResult {
            results,
            total,
            page,
            page_size,
            has_more,
            search_time_ms,
        })
    }

    /// 回退到 LIKE 搜索（当 FTS5 表不存在时使用）
    fn fallback_like_search(
        conn: &Connection,
        keyword: &str,
        exam_id: Option<&str>,
        filters: &QuestionSearchFilters,
        page: u32,
        page_size: u32,
        start_time: std::time::Instant,
    ) -> VfsResult<QuestionSearchListResult> {
        let offset = (page.saturating_sub(1)) * page_size;
        let like_pattern = format!("%{}%", crate::vfs::repos::escape_like_pattern(keyword));

        // 构建 WHERE 子句
        let mut conditions = vec![
            "deleted_at IS NULL".to_string(),
            r"(content LIKE ?1 ESCAPE '\' OR answer LIKE ?1 ESCAPE '\' OR explanation LIKE ?1 ESCAPE '\' OR tags LIKE ?1 ESCAPE '\')"
                .to_string(),
        ];
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(like_pattern.clone())];
        let mut param_idx = 2;

        if let Some(eid) = exam_id {
            conditions.push(format!("exam_id = ?{}", param_idx));
            params_vec.push(Box::new(eid.to_string()));
            param_idx += 1;
        }

        // 状态筛选
        if let Some(statuses) = &filters.base.status {
            if !statuses.is_empty() {
                let placeholders: Vec<String> = statuses
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!("status IN ({})", placeholders.join(", ")));
                for s in statuses {
                    params_vec.push(Box::new(s.as_str().to_string()));
                }
                param_idx += statuses.len();
            }
        }

        // 难度筛选（与 FTS5 路径保持一致，避免回退搜索忽略筛选条件）
        if let Some(difficulties) = &filters.base.difficulty {
            if !difficulties.is_empty() {
                let placeholders: Vec<String> = difficulties
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!("difficulty IN ({})", placeholders.join(", ")));
                for d in difficulties {
                    params_vec.push(Box::new(d.as_str().to_string()));
                }
                param_idx += difficulties.len();
            }
        }

        // 题型筛选
        if let Some(types) = &filters.base.question_type {
            if !types.is_empty() {
                let placeholders: Vec<String> = types
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!("question_type IN ({})", placeholders.join(", ")));
                for t in types {
                    params_vec.push(Box::new(t.as_str().to_string()));
                }
                param_idx += types.len();
            }
        }

        // 标签筛选（与 FTS5 路径口径一致）
        if let Some(tags) = &filters.base.tags {
            if !tags.is_empty() {
                let placeholders: Vec<String> = tags
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM json_each(questions.tags) WHERE value IN ({}))",
                    placeholders.join(", ")
                ));
                for tag in tags {
                    params_vec.push(Box::new(tag.to_string()));
                }
                param_idx += tags.len();
            }
        }

        // 收藏/书签筛选
        if let Some(is_fav) = filters.base.is_favorite {
            conditions.push(format!("is_favorite = ?{}", param_idx));
            params_vec.push(Box::new(if is_fav { 1 } else { 0 }));
            param_idx += 1;
        }
        if let Some(is_bm) = filters.base.is_bookmarked {
            conditions.push(format!("is_bookmarked = ?{}", param_idx));
            params_vec.push(Box::new(if is_bm { 1 } else { 0 }));
            param_idx += 1;
        }

        let where_clause = conditions.join(" AND ");

        // 查询总数
        let count_sql = format!("SELECT COUNT(*) FROM questions WHERE {}", where_clause);
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let total: i64 = conn.query_row(&count_sql, params_refs.as_slice(), |row| row.get(0))?;

        // 查询数据
        let query_sql = format!(
            r#"
            SELECT id, exam_id, card_id, question_label, content, options_json,
                   answer, explanation, question_type, difficulty, tags,
                   status, user_answer, is_correct, attempt_count, correct_count,
                   last_attempt_at, user_note, is_favorite, is_bookmarked,
                   source_type, source_ref, images_json, parent_id, created_at, updated_at,
                   ai_feedback, ai_score, ai_graded_at, structured_data,
                   group_id, group_position, source_key, provenance_json, answer_origin
            FROM questions
            WHERE {}
            ORDER BY created_at ASC, id ASC
            LIMIT ?{} OFFSET ?{}
            "#,
            where_clause,
            param_idx,
            param_idx + 1
        );

        params_vec.push(Box::new(page_size));
        params_vec.push(Box::new(offset));

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&query_sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), |row| {
            let question = Self::row_to_question(row)?;
            Ok(QuestionSearchResult {
                question,
                highlight_content: None,
                highlight_answer: None,
                highlight_explanation: None,
                relevance_score: 0.0,
            })
        })?;

        let mut results: Vec<QuestionSearchResult> = rows.filter_map(log_and_skip_err).collect();
        {
            let mut questions: Vec<Question> = results.iter().map(|r| r.question.clone()).collect();
            Self::hydrate_question_context_with_conn(conn, &mut questions)?;
            for (result, question) in results.iter_mut().zip(questions) {
                result.question = question;
            }
        }
        let has_more = (offset + page_size) < total as u32;
        let search_time_ms = start_time.elapsed().as_millis() as u64;

        Ok(QuestionSearchListResult {
            results,
            total,
            page,
            page_size,
            has_more,
            search_time_ms,
        })
    }

    /// 重建 FTS5 索引（用于数据修复）
    pub fn rebuild_fts_index(db: &VfsDatabase) -> VfsResult<u64> {
        let conn = db.get_conn_safe()?;
        Self::rebuild_fts_index_with_conn(&conn)
    }

    /// 重建 FTS5 索引（使用现有连接）
    ///
    /// DELETE + INSERT 包在同一 SAVEPOINT 中：任一步失败都回滚，
    /// 避免中断后留下"已清空但未重建"的空索引。
    pub fn rebuild_fts_index_with_conn(conn: &Connection) -> VfsResult<u64> {
        info!("[VFS::QuestionRepo] Rebuilding FTS5 index...");

        conn.execute_batch("SAVEPOINT qbank_rebuild_fts")?;

        let rebuild_result = (|| -> VfsResult<u64> {
            // 1. 清空 FTS 表
            conn.execute("DELETE FROM questions_fts", [])?;

            // 2. 重新插入所有数据
            let count = conn.execute(
                r#"
                INSERT INTO questions_fts(rowid, content, answer, explanation, tags)
                SELECT rowid, content, COALESCE(answer, ''), COALESCE(explanation, ''), COALESCE(tags, '[]')
                FROM questions
                WHERE deleted_at IS NULL
                "#,
                [],
            )?;

            // 3. 优化 FTS 表
            conn.execute(
                "INSERT INTO questions_fts(questions_fts) VALUES('optimize')",
                [],
            )?;

            Ok(count as u64)
        })();

        match rebuild_result {
            Ok(count) => {
                conn.execute_batch("RELEASE SAVEPOINT qbank_rebuild_fts")?;
                info!(
                    "[VFS::QuestionRepo] FTS5 index rebuilt, {} records indexed",
                    count
                );
                Ok(count)
            }
            Err(e) => {
                let _ = conn.execute_batch(
                    "ROLLBACK TO SAVEPOINT qbank_rebuild_fts; RELEASE SAVEPOINT qbank_rebuild_fts;",
                );
                warn!(
                    "[VFS::QuestionRepo] FTS5 rebuild failed, rolled back: {}",
                    e
                );
                Err(e)
            }
        }
    }

    // ========================================================================
    // 列表查询
    // ========================================================================

    /// 列出题目（分页+筛选）
    pub fn list_questions(
        db: &VfsDatabase,
        exam_id: &str,
        filters: &QuestionFilters,
        page: u32,
        page_size: u32,
    ) -> VfsResult<QuestionListResult> {
        let conn = db.get_conn_safe()?;
        Self::list_questions_with_conn(&conn, exam_id, filters, page, page_size)
    }

    /// 列出题目（使用现有连接）
    pub fn list_questions_with_conn(
        conn: &Connection,
        exam_id: &str,
        filters: &QuestionFilters,
        page: u32,
        page_size: u32,
    ) -> VfsResult<QuestionListResult> {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 100);
        let offset = (page.saturating_sub(1)) * page_size;

        // 构建 WHERE 子句
        let mut conditions = vec!["exam_id = ?1".to_string(), "deleted_at IS NULL".to_string()];
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(exam_id.to_string())];
        let mut param_idx = 2;

        // 状态筛选
        if let Some(statuses) = &filters.status {
            if !statuses.is_empty() {
                let placeholders: Vec<String> = statuses
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!("status IN ({})", placeholders.join(", ")));
                for s in statuses {
                    params_vec.push(Box::new(s.as_str().to_string()));
                }
                param_idx += statuses.len();
            }
        }

        // 难度筛选
        if let Some(difficulties) = &filters.difficulty {
            if !difficulties.is_empty() {
                let placeholders: Vec<String> = difficulties
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!("difficulty IN ({})", placeholders.join(", ")));
                for d in difficulties {
                    params_vec.push(Box::new(d.as_str().to_string()));
                }
                param_idx += difficulties.len();
            }
        }

        // 题型筛选
        if let Some(types) = &filters.question_type {
            if !types.is_empty() {
                let placeholders: Vec<String> = types
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!("question_type IN ({})", placeholders.join(", ")));
                for t in types {
                    params_vec.push(Box::new(t.as_str().to_string()));
                }
                param_idx += types.len();
            }
        }

        // 标签筛选（JSON 数组包含任一标签）
        if let Some(tags) = &filters.tags {
            if !tags.is_empty() {
                let placeholders: Vec<String> = tags
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN ({}))",
                    placeholders.join(", ")
                ));
                for tag in tags {
                    params_vec.push(Box::new(tag.to_string()));
                }
                param_idx += tags.len();
            }
        }

        // 搜索：优先使用 FTS5，回退到 LIKE
        let use_fts5 = filters
            .search
            .as_ref()
            .map(|s| !s.is_empty() && Self::fts_table_exists(conn))
            .unwrap_or(false);

        if let Some(search) = &filters.search {
            // 纯空白搜索词会生成空 MATCH 表达式（FTS5 语法错误），直接跳过搜索条件
            if !search.trim().is_empty() {
                if use_fts5 {
                    // FTS5 搜索：通过 rowid 关联
                    let sanitized =
                        Self::sanitize_search_keyword(search).unwrap_or_else(|| search.to_string());
                    let escaped = Self::escape_fts5_query(&sanitized);
                    conditions.push(format!(
                        "rowid IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH ?{})",
                        param_idx
                    ));
                    params_vec.push(Box::new(escaped));
                    param_idx += 1;
                } else {
                    // 回退到 LIKE 搜索（搜索 content, answer, explanation, tags）
                    conditions.push(format!(
                        r"(content LIKE ?{} ESCAPE '\' OR answer LIKE ?{} ESCAPE '\' OR explanation LIKE ?{} ESCAPE '\' OR tags LIKE ?{} ESCAPE '\')",
                        param_idx, param_idx, param_idx, param_idx
                    ));
                    params_vec.push(Box::new(format!(
                        "%{}%",
                        crate::vfs::repos::escape_like_pattern(search)
                    )));
                    param_idx += 1;
                }
            }
        }

        // 收藏筛选
        if let Some(is_fav) = filters.is_favorite {
            conditions.push(format!("is_favorite = ?{}", param_idx));
            params_vec.push(Box::new(if is_fav { 1 } else { 0 }));
            param_idx += 1;
        }

        // 书签筛选
        if let Some(is_bm) = filters.is_bookmarked {
            conditions.push(format!("is_bookmarked = ?{}", param_idx));
            params_vec.push(Box::new(if is_bm { 1 } else { 0 }));
            param_idx += 1;
        }

        let where_clause = conditions.join(" AND ");

        // 查询总数
        let count_sql = format!("SELECT COUNT(*) FROM questions WHERE {}", where_clause);
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let total: i64 = conn.query_row(&count_sql, params_refs.as_slice(), |row| row.get(0))?;

        // 查询数据
        let query_sql = format!(
            r#"
            SELECT id, exam_id, card_id, question_label, content, options_json,
                   answer, explanation, question_type, difficulty, tags,
                   status, user_answer, is_correct, attempt_count, correct_count,
                   last_attempt_at, user_note, is_favorite, is_bookmarked,
                   source_type, source_ref, images_json, parent_id, created_at, updated_at,
                   ai_feedback, ai_score, ai_graded_at, structured_data,
                   group_id, group_position, source_key, provenance_json, answer_origin
            FROM questions
            WHERE {}
            ORDER BY created_at ASC, id ASC
            LIMIT ?{} OFFSET ?{}
            "#,
            where_clause,
            param_idx,
            param_idx + 1
        );

        params_vec.push(Box::new(page_size));
        params_vec.push(Box::new(offset));

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&query_sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_question)?;

        let mut questions: Vec<Question> = rows.filter_map(log_and_skip_err).collect();
        Self::hydrate_question_context_with_conn(conn, &mut questions)?;
        let has_more = (offset + page_size) < total as u32;

        debug!(
            "[VFS::QuestionRepo] Listed {} questions for exam_id={}, total={}",
            questions.len(),
            exam_id,
            total
        );

        Ok(QuestionListResult {
            questions,
            total,
            page,
            page_size,
            has_more,
        })
    }

    /// 跨题目集列出错题（分页），只含未删除题目集里的未删除题目
    pub fn list_mistakes(
        db: &VfsDatabase,
        filters: &MistakeListFilters,
        page: u32,
        page_size: u32,
    ) -> VfsResult<MistakeListResult> {
        let conn = db.get_conn_safe()?;
        Self::list_mistakes_with_conn(&conn, filters, page, page_size)
    }

    pub fn list_mistakes_with_conn(
        conn: &Connection,
        filters: &MistakeListFilters,
        page: u32,
        page_size: u32,
    ) -> VfsResult<MistakeListResult> {
        let page = page.max(1);
        let page_size = page_size.clamp(1, 200);
        let offset = (page.saturating_sub(1)) * page_size;
        const BASE: &str = "FROM questions q
             INNER JOIN exam_sheets e ON e.id = q.exam_id AND e.deleted_at IS NULL
             WHERE q.deleted_at IS NULL AND q.status = 'review'";

        let mut exams_stmt = conn.prepare(&format!(
            "SELECT q.exam_id, e.exam_name, COUNT(*) AS n {BASE}
             GROUP BY q.exam_id ORDER BY n DESC, e.exam_name COLLATE NOCASE ASC"
        ))?;
        let exams = exams_stmt
            .query_map([], |row| {
                Ok(MistakeExamCount {
                    exam_id: row.get(0)?,
                    exam_name: row.get(1)?,
                    count: row.get(2)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        let mut conditions: Vec<String> = Vec::new();
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(exam_id) = filters
            .exam_id
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            params_vec.push(Box::new(exam_id.to_string()));
            conditions.push(format!("q.exam_id = ?{}", params_vec.len()));
        }
        if let Some(search) = filters
            .search
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            params_vec.push(Box::new(format!(
                "%{}%",
                crate::vfs::repos::escape_like_pattern(search)
            )));
            let idx = params_vec.len();
            conditions.push(format!(
                r"(q.content LIKE ?{idx} ESCAPE '\' OR q.answer LIKE ?{idx} ESCAPE '\' OR q.explanation LIKE ?{idx} ESCAPE '\' OR q.tags LIKE ?{idx} ESCAPE '\')"
            ));
        }
        let extra = conditions
            .iter()
            .map(|condition| format!(" AND {condition}"))
            .collect::<String>();

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let total: i64 = conn.query_row(
            &format!("SELECT COUNT(*) {BASE}{extra}"),
            params_refs.as_slice(),
            |row| row.get(0),
        )?;

        let order_by = match filters.sort.as_deref().map(str::trim) {
            Some("errors") => {
                "(q.attempt_count - q.correct_count) DESC, COALESCE(q.last_attempt_at, q.updated_at) DESC, q.id ASC"
            }
            _ => "COALESCE(q.last_attempt_at, q.updated_at) DESC, q.id ASC",
        };
        params_vec.push(Box::new(page_size));
        params_vec.push(Box::new(offset));
        let limit_idx = params_vec.len() - 1;
        let query_sql = format!(
            r#"
            SELECT q.id, q.exam_id, q.card_id, q.question_label, q.content, q.options_json,
                   q.answer, q.explanation, q.question_type, q.difficulty, q.tags,
                   q.status, q.user_answer, q.is_correct, q.attempt_count, q.correct_count,
                   q.last_attempt_at, q.user_note, q.is_favorite, q.is_bookmarked,
                   q.source_type, q.source_ref, q.images_json, q.parent_id, q.created_at, q.updated_at,
                   q.ai_feedback, q.ai_score, q.ai_graded_at, q.structured_data,
                   q.group_id, q.group_position, q.source_key, q.provenance_json, q.answer_origin,
                   e.exam_name
            {BASE}{extra}
            ORDER BY {order_by}
            LIMIT ?{limit_idx} OFFSET ?{}
            "#,
            limit_idx + 1
        );
        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&query_sql)?;
        let mut items: Vec<MistakeQuestion> = stmt
            .query_map(params_refs.as_slice(), |row| {
                Ok(MistakeQuestion {
                    question: Self::row_to_question(row)?,
                    exam_name: row.get(35)?,
                })
            })?
            .filter_map(log_and_skip_err)
            .collect();
        {
            let mut questions: Vec<Question> =
                items.iter().map(|item| item.question.clone()).collect();
            Self::hydrate_question_context_with_conn(conn, &mut questions)?;
            for (item, question) in items.iter_mut().zip(questions) {
                item.question = question;
            }
        }
        let has_more = (offset as i64 + page_size as i64) < total;

        Ok(MistakeListResult {
            items,
            total,
            page,
            page_size,
            has_more,
            exams,
        })
    }

    // ========================================================================
    // 随机抽取（M-031 优化：SQL 层随机，避免全量加载）
    // ========================================================================

    /// 构建筛选条件的 WHERE 子句和参数（内部复用）
    ///
    /// 返回 `(conditions, params, next_param_idx)`
    fn build_filter_conditions(
        exam_id: &str,
        filters: &QuestionFilters,
        exclude_ids: &[String],
        last_attempt_before: Option<&str>,
    ) -> (Vec<String>, Vec<Box<dyn rusqlite::ToSql>>, usize) {
        let mut conditions = vec!["exam_id = ?1".to_string(), "deleted_at IS NULL".to_string()];
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(exam_id.to_string())];
        let mut param_idx = 2;

        // 状态筛选
        if let Some(statuses) = &filters.status {
            if !statuses.is_empty() {
                let placeholders: Vec<String> = statuses
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!("status IN ({})", placeholders.join(", ")));
                for s in statuses {
                    params_vec.push(Box::new(s.as_str().to_string()));
                }
                param_idx += statuses.len();
            }
        }

        // 难度筛选
        if let Some(difficulties) = &filters.difficulty {
            if !difficulties.is_empty() {
                let placeholders: Vec<String> = difficulties
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!("difficulty IN ({})", placeholders.join(", ")));
                for d in difficulties {
                    params_vec.push(Box::new(d.as_str().to_string()));
                }
                param_idx += difficulties.len();
            }
        }

        // 题型筛选
        if let Some(types) = &filters.question_type {
            if !types.is_empty() {
                let placeholders: Vec<String> = types
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!("question_type IN ({})", placeholders.join(", ")));
                for t in types {
                    params_vec.push(Box::new(t.as_str().to_string()));
                }
                param_idx += types.len();
            }
        }

        // 标签筛选
        if let Some(tags) = &filters.tags {
            if !tags.is_empty() {
                let placeholders: Vec<String> = tags
                    .iter()
                    .enumerate()
                    .map(|(i, _)| format!("?{}", param_idx + i))
                    .collect();
                conditions.push(format!(
                    "EXISTS (SELECT 1 FROM json_each(tags) WHERE value IN ({}))",
                    placeholders.join(", ")
                ));
                for tag in tags {
                    params_vec.push(Box::new(tag.to_string()));
                }
                param_idx += tags.len();
            }
        }

        // 收藏筛选
        if let Some(is_fav) = filters.is_favorite {
            conditions.push(format!("is_favorite = ?{}", param_idx));
            params_vec.push(Box::new(if is_fav { 1 } else { 0 }));
            param_idx += 1;
        }

        // 书签筛选
        if let Some(is_bm) = filters.is_bookmarked {
            conditions.push(format!("is_bookmarked = ?{}", param_idx));
            params_vec.push(Box::new(if is_bm { 1 } else { 0 }));
            param_idx += 1;
        }

        // 排除指定 ID
        if !exclude_ids.is_empty() {
            let placeholders: Vec<String> = exclude_ids
                .iter()
                .enumerate()
                .map(|(i, _)| format!("?{}", param_idx + i))
                .collect();
            conditions.push(format!("id NOT IN ({})", placeholders.join(", ")));
            for id in exclude_ids {
                params_vec.push(Box::new(id.clone()));
            }
            param_idx += exclude_ids.len();
        }

        // 最后练习时间上界（用于每日一练：已掌握但长时间未练习）
        if let Some(before) = last_attempt_before {
            conditions.push(format!(
                "(last_attempt_at IS NULL OR last_attempt_at < ?{})",
                param_idx
            ));
            params_vec.push(Box::new(before.to_string()));
            param_idx += 1;
        }

        (conditions, params_vec, param_idx)
    }

    /// 随机抽取题目 ID（SQL 层 `ORDER BY RANDOM() LIMIT`，避免全量加载）
    ///
    /// 适用于限时练习、每日一练、模拟考试等需要随机选题的场景。
    ///
    /// # Arguments
    /// * `db` - VFS 数据库实例
    /// * `exam_id` - 题目集 ID
    /// * `filters` - 筛选条件（状态、难度、题型、标签等）
    /// * `exclude_ids` - 需要排除的题目 ID 列表
    /// * `last_attempt_before` - 最后练习时间上界（ISO 8601），用于选择长时间未练习的题目
    /// * `limit` - 最多返回数量
    pub fn random_question_ids(
        db: &VfsDatabase,
        exam_id: &str,
        filters: &QuestionFilters,
        exclude_ids: &[String],
        last_attempt_before: Option<&str>,
        limit: u32,
    ) -> VfsResult<Vec<String>> {
        let conn = db.get_conn_safe()?;
        Self::random_question_ids_with_conn(
            &conn,
            exam_id,
            filters,
            exclude_ids,
            last_attempt_before,
            limit,
        )
    }

    /// 随机抽取题目 ID（使用现有连接）
    pub fn random_question_ids_with_conn(
        conn: &Connection,
        exam_id: &str,
        filters: &QuestionFilters,
        exclude_ids: &[String],
        last_attempt_before: Option<&str>,
        limit: u32,
    ) -> VfsResult<Vec<String>> {
        let (conditions, mut params_vec, param_idx) =
            Self::build_filter_conditions(exam_id, filters, exclude_ids, last_attempt_before);

        let where_clause = conditions.join(" AND ");
        let sql = format!(
            "SELECT id FROM questions WHERE {} ORDER BY RANDOM() LIMIT ?{}",
            where_clause, param_idx
        );
        params_vec.push(Box::new(limit));

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), |row| row.get::<_, String>(0))?;
        let ids: Vec<String> = rows.filter_map(log_and_skip_err).collect();

        debug!(
            "[VFS::QuestionRepo] Random selected {} IDs for exam_id={}, limit={}",
            ids.len(),
            exam_id,
            limit
        );

        Ok(ids)
    }

    /// 随机抽取完整题目（SQL 层随机，避免全量加载）
    ///
    /// 与 `random_question_ids` 类似，但返回完整 `Question` 对象。
    /// 适用于组卷等需要题目完整信息的场景。
    pub fn random_questions(
        db: &VfsDatabase,
        exam_id: &str,
        filters: &QuestionFilters,
        exclude_ids: &[String],
        limit: u32,
    ) -> VfsResult<Vec<Question>> {
        let conn = db.get_conn_safe()?;
        Self::random_questions_with_conn(&conn, exam_id, filters, exclude_ids, limit)
    }

    /// 随机抽取完整题目（使用现有连接）
    pub fn random_questions_with_conn(
        conn: &Connection,
        exam_id: &str,
        filters: &QuestionFilters,
        exclude_ids: &[String],
        limit: u32,
    ) -> VfsResult<Vec<Question>> {
        let (conditions, mut params_vec, param_idx) =
            Self::build_filter_conditions(exam_id, filters, exclude_ids, None);

        let where_clause = conditions.join(" AND ");
        let sql = format!(
            r#"
            SELECT id, exam_id, card_id, question_label, content, options_json,
                   answer, explanation, question_type, difficulty, tags,
                   status, user_answer, is_correct, attempt_count, correct_count,
                   last_attempt_at, user_note, is_favorite, is_bookmarked,
                   source_type, source_ref, images_json, parent_id, created_at, updated_at,
                   ai_feedback, ai_score, ai_graded_at, structured_data,
                   group_id, group_position, source_key, provenance_json, answer_origin
            FROM questions
            WHERE {}
            ORDER BY RANDOM()
            LIMIT ?{}
            "#,
            where_clause, param_idx
        );
        params_vec.push(Box::new(limit));

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|p| p.as_ref()).collect();
        let mut stmt = conn.prepare(&sql)?;
        let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_question)?;
        let mut questions: Vec<Question> = rows.filter_map(log_and_skip_err).collect();
        Self::hydrate_question_context_with_conn(conn, &mut questions)?;

        debug!(
            "[VFS::QuestionRepo] Random selected {} questions for exam_id={}, limit={}",
            questions.len(),
            exam_id,
            limit
        );

        Ok(questions)
    }

    /// 统计题目数量
    pub fn count_questions(db: &VfsDatabase, exam_id: &str) -> VfsResult<i64> {
        let conn = db.get_conn_safe()?;
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM questions WHERE exam_id = ?1 AND deleted_at IS NULL",
            params![exam_id],
            |row| row.get(0),
        )?;
        Ok(count)
    }

    // ========================================================================
    // 题组 / 共享材料读取期投影（issue 491）
    // ========================================================================

    /// 批量补齐题组标题与共享材料，避免逐题 N+1。
    ///
    /// 权威关系只有 `questions.group_id/group_position` + `qbank_group_materials`；
    /// 这里只做读取投影，不写入第二份成员关系。
    pub fn hydrate_question_context_with_conn(
        conn: &Connection,
        questions: &mut [Question],
    ) -> VfsResult<()> {
        if questions.is_empty() {
            return Ok(());
        }
        if !table_exists(conn, "qbank_groups") || !table_exists(conn, "qbank_materials") {
            return Ok(());
        }

        let group_ids: Vec<String> = {
            let mut ids: Vec<String> = questions
                .iter()
                .filter_map(|q| q.group_id.clone())
                .collect();
            ids.sort();
            ids.dedup();
            ids
        };
        if group_ids.is_empty() {
            return Ok(());
        }

        // 1. 题组标题
        let mut labels: HashMap<String, String> = HashMap::new();
        for chunk in group_ids.chunks(500) {
            let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{}", i)).collect();
            let sql = format!(
                "SELECT id, label FROM qbank_groups WHERE id IN ({}) AND deleted_at IS NULL",
                placeholders.join(", ")
            );
            let params_refs: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_refs.as_slice(), |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows.filter_map(log_and_skip_err) {
                labels.insert(row.0, row.1);
            }
        }

        // 2. 组内共享材料（按组 + position 排序，去重）
        let mut materials_by_group: HashMap<String, Vec<crate::qbank_document::QuestionMaterial>> =
            HashMap::new();
        if table_exists(conn, "qbank_group_materials") {
            for chunk in group_ids.chunks(500) {
                let placeholders: Vec<String> =
                    (1..=chunk.len()).map(|i| format!("?{}", i)).collect();
                let sql = format!(
                    r#"
                    SELECT gm.group_id, m.id, m.content, m.images_json,
                           m.source_refs_json, m.local_version
                    FROM qbank_group_materials gm
                    JOIN qbank_materials m
                      ON m.id = gm.material_id AND m.exam_id = gm.exam_id
                    WHERE gm.group_id IN ({}) AND gm.deleted_at IS NULL AND m.deleted_at IS NULL
                    ORDER BY gm.group_id ASC, gm.position ASC, gm.id ASC
                    "#,
                    placeholders.join(", ")
                );
                let params_refs: Vec<&dyn rusqlite::ToSql> =
                    chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
                let mut stmt = conn.prepare(&sql)?;
                let rows = stmt.query_map(params_refs.as_slice(), |row| {
                    let group_id: String = row.get(0)?;
                    let id: String = row.get(1)?;
                    let content: String = row.get(2)?;
                    let images_json: Option<String> = row.get(3)?;
                    let source_refs_json: Option<String> = row.get(4)?;
                    let version: i64 = row.get(5)?;
                    Ok((
                        group_id,
                        id,
                        content,
                        images_json,
                        source_refs_json,
                        version,
                    ))
                })?;
                for (group_id, id, content, images_json, source_refs_json, version) in
                    rows.filter_map(log_and_skip_err)
                {
                    let bucket = materials_by_group.entry(group_id).or_default();
                    if bucket.iter().any(|m| m.id == id) {
                        continue;
                    }
                    bucket.push(crate::qbank_document::QuestionMaterial {
                        id,
                        content,
                        images: images_json
                            .as_deref()
                            .and_then(|s| serde_json::from_str(s).ok())
                            .unwrap_or_default(),
                        source_refs: source_refs_json
                            .as_deref()
                            .and_then(|s| serde_json::from_str(s).ok())
                            .unwrap_or_default(),
                        version,
                    });
                }
            }
        }

        for question in questions.iter_mut() {
            let Some(group_id) = question.group_id.as_deref() else {
                continue;
            };
            question.group_label = labels.get(group_id).cloned();
            if let Some(materials) = materials_by_group.get(group_id) {
                question.materials = materials.clone();
            }
        }
        Ok(())
    }

    /// 读取题目集全部正式题目（显式翻页，不再用超大 page_size 假装全量）。
    ///
    /// 供 canonical 读取（预览投影、聊天上下文、导出、检索）复用，避免各处
    /// 自行传 `page_size=10000` 被 repo 夹到 100 而静默丢题。
    pub fn canonical_questions_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<Vec<Question>> {
        const PAGE_SIZE: u32 = 100;
        let mut page = 1u32;
        let mut all: Vec<Question> = Vec::new();
        loop {
            let result = Self::list_questions_with_conn(
                conn,
                exam_id,
                &QuestionFilters::default(),
                page,
                PAGE_SIZE,
            )?;
            let fetched = result.questions.len();
            all.extend(result.questions);
            if !result.has_more || fetched == 0 {
                break;
            }
            page = page.saturating_add(1);
            if page > 10_000 {
                return Err(VfsError::InvalidArgument {
                    param: "exam_id".to_string(),
                    reason: "题目集分页超出安全上限".to_string(),
                });
            }
        }
        Ok(all)
    }

    /// 题目集 canonical 纯文本投影：共享材料按题组输出一次，再输出子题。
    ///
    /// 仅用于展示/索引/导出的文本形态，不承担无损往返；无损契约是 v2 JSON。
    pub fn canonical_text_with_conn(conn: &Connection, exam_id: &str) -> VfsResult<String> {
        let questions = Self::canonical_questions_with_conn(conn, exam_id)?;
        let mut out = String::new();
        let mut emitted_materials: std::collections::HashSet<String> =
            std::collections::HashSet::new();
        let mut last_group: Option<String> = None;

        for (index, question) in questions.iter().enumerate() {
            if question.group_id != last_group {
                if let Some(group_id) = question.group_id.clone() {
                    if let Some(label) = question.group_label.as_deref() {
                        out.push_str(&format!("\n## {}\n", label));
                    }
                    for material in &question.materials {
                        if emitted_materials.insert(material.id.clone()) {
                            out.push_str(&format!("\n[共享材料]\n{}\n", material.content));
                        }
                    }
                    let _ = group_id;
                }
                last_group = question.group_id.clone();
            }
            let label = question
                .question_label
                .clone()
                .unwrap_or_else(|| format!("{}", index + 1));
            out.push_str(&format!("\n{}. {}\n", label, question.content));
            if let Some(options) = &question.options {
                for option in options {
                    out.push_str(&format!("   {}. {}\n", option.key, option.content));
                }
            }
            if let Some(answer) = &question.answer {
                out.push_str(&format!("   答案：{}\n", answer));
            }
            if let Some(explanation) = &question.explanation {
                out.push_str(&format!("   解析：{}\n", explanation));
            }
        }
        Ok(out.trim_start().to_string())
    }

    /// 题目/材料内容变更后，把题目集关联资源的文本索引标记为待重建。
    ///
    /// 只把 `index_state` 从 indexed 抬回 pending（已 pending/disabled 时不重复写），
    /// 由索引 worker 按 canonical 内容重建；不在这里直接重算向量，避免读路径
    /// 阻塞或半途失败留下新旧混合索引。
    pub fn invalidate_exam_content_index_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<()> {
        if !table_exists(conn, "resources") || !table_exists(conn, "exam_sheets") {
            return Ok(());
        }
        let resource_id: Option<String> = conn
            .query_row(
                "SELECT resource_id FROM exam_sheets WHERE id = ?1",
                params![exam_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten();
        let Some(resource_id) = resource_id.filter(|id| !id.trim().is_empty()) else {
            return Ok(());
        };
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "UPDATE resources SET index_state = 'pending', indexed_at = NULL, updated_at = ?1 \
             WHERE id = ?2 AND index_state NOT IN ('pending', 'disabled')",
            params![now, resource_id],
        )?;
        debug!(
            "[VFS::QuestionRepo] Invalidated content index for exam={} resource={}",
            exam_id, resource_id
        );
        Ok(())
    }

    /// 查题目所属题目集（含已软删题，删除后仍需要失效其索引）。
    pub fn exam_id_for_question_with_conn(
        conn: &Connection,
        question_id: &str,
    ) -> VfsResult<Option<String>> {
        let exam_id = conn
            .query_row(
                "SELECT exam_id FROM questions WHERE id = ?1",
                params![question_id],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(exam_id)
    }

    // ========================================================================
    // 查询单个
    // ========================================================================

    /// 根据 ID 获取题目
    pub fn get_question(db: &VfsDatabase, question_id: &str) -> VfsResult<Option<Question>> {
        let conn = db.get_conn_safe()?;
        Self::get_question_with_conn(&conn, question_id)
    }

    /// 根据 ID 获取题目（使用现有连接）
    pub fn get_question_with_conn(
        conn: &Connection,
        question_id: &str,
    ) -> VfsResult<Option<Question>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, exam_id, card_id, question_label, content, options_json,
                   answer, explanation, question_type, difficulty, tags,
                   status, user_answer, is_correct, attempt_count, correct_count,
                   last_attempt_at, user_note, is_favorite, is_bookmarked,
                   source_type, source_ref, images_json, parent_id, created_at, updated_at,
                   ai_feedback, ai_score, ai_graded_at, structured_data,
                   group_id, group_position, source_key, provenance_json, answer_origin
            FROM questions
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
        )?;

        let mut question = stmt
            .query_row(params![question_id], Self::row_to_question)
            .optional()?;
        if let Some(question) = question.as_mut() {
            Self::hydrate_question_context_with_conn(conn, std::slice::from_mut(question))?;
        }

        Ok(question)
    }

    /// 根据 card_id 获取题目
    ///
    /// card_id 允许直接传 question id：AI 生成题没有 card_id（列为 NULL），
    /// 而 qbank_list_questions 等工具会把 question id 作为 card_id 回传给调用方，
    /// 若严格只匹配 card_id，这类题目永远查不到（QBANK_OPERATION_FAILED: Question not found）。
    pub fn get_question_by_card_id(
        db: &VfsDatabase,
        exam_id: &str,
        card_id: &str,
    ) -> VfsResult<Option<Question>> {
        let conn = db.get_conn_safe()?;
        Self::get_question_by_card_id_with_conn(&conn, exam_id, card_id)
    }

    /// 根据 card_id 获取题目（使用现有连接）
    pub fn get_question_by_card_id_with_conn(
        conn: &Connection,
        exam_id: &str,
        card_id: &str,
    ) -> VfsResult<Option<Question>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, exam_id, card_id, question_label, content, options_json,
                   answer, explanation, question_type, difficulty, tags,
                   status, user_answer, is_correct, attempt_count, correct_count,
                   last_attempt_at, user_note, is_favorite, is_bookmarked,
                   source_type, source_ref, images_json, parent_id, created_at, updated_at,
                   ai_feedback, ai_score, ai_graded_at, structured_data,
                   group_id, group_position, source_key, provenance_json, answer_origin
            FROM questions
            WHERE exam_id = ?1 AND (card_id = ?2 OR id = ?2) AND deleted_at IS NULL
            "#,
        )?;

        let mut question = stmt
            .query_row(params![exam_id, card_id], Self::row_to_question)
            .optional()?;
        if let Some(question) = question.as_mut() {
            Self::hydrate_question_context_with_conn(conn, std::slice::from_mut(question))?;
        }

        Ok(question)
    }

    /// 按 ID 批量获取题目（单次 IN 查询，替代逐题 get_question 的 N+1）
    ///
    /// 返回顺序不保证与入参一致；未找到（含已删除）的 ID 会被跳过。
    pub fn get_questions_by_ids(db: &VfsDatabase, ids: &[String]) -> VfsResult<Vec<Question>> {
        let conn = db.get_conn_safe()?;
        Self::get_questions_by_ids_with_conn(&conn, ids)
    }

    /// 按 ID 批量获取题目（使用现有连接）
    pub fn get_questions_by_ids_with_conn(
        conn: &Connection,
        ids: &[String],
    ) -> VfsResult<Vec<Question>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }

        // 分块避免超过 SQLite 绑定参数上限
        const CHUNK_SIZE: usize = 500;
        let mut questions = Vec::with_capacity(ids.len());

        for chunk in ids.chunks(CHUNK_SIZE) {
            let placeholders: Vec<String> = (1..=chunk.len()).map(|i| format!("?{}", i)).collect();
            let sql = format!(
                r#"
                SELECT id, exam_id, card_id, question_label, content, options_json,
                       answer, explanation, question_type, difficulty, tags,
                       status, user_answer, is_correct, attempt_count, correct_count,
                       last_attempt_at, user_note, is_favorite, is_bookmarked,
                       source_type, source_ref, images_json, parent_id, created_at, updated_at,
                       ai_feedback, ai_score, ai_graded_at, structured_data,
                       group_id, group_position, source_key, provenance_json, answer_origin
                FROM questions
                WHERE id IN ({}) AND deleted_at IS NULL
                "#,
                placeholders.join(", ")
            );

            let params_refs: Vec<&dyn rusqlite::ToSql> =
                chunk.iter().map(|id| id as &dyn rusqlite::ToSql).collect();
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_refs.as_slice(), Self::row_to_question)?;
            questions.extend(rows.filter_map(log_and_skip_err));
        }

        Self::hydrate_question_context_with_conn(conn, &mut questions)?;
        Ok(questions)
    }

    // ========================================================================
    // 创建
    // ========================================================================

    /// 创建题目
    pub fn create_question(db: &VfsDatabase, params: &CreateQuestionParams) -> VfsResult<Question> {
        let conn = db.get_conn_safe()?;
        Self::create_question_with_conn(&conn, params)
    }

    /// 创建题目（使用现有连接）
    pub fn create_question_with_conn(
        conn: &Connection,
        params: &CreateQuestionParams,
    ) -> VfsResult<Question> {
        let id = format!("q_{}", nanoid::nanoid!(10));
        let now = chrono::Utc::now().to_rfc3339();

        let options_json = params
            .options
            .as_ref()
            .map(|opts| serde_json::to_string(opts).unwrap_or_default());
        let tags_json = serde_json::to_string(&params.tags.clone().unwrap_or_default())
            .unwrap_or_else(|_| "[]".to_string());
        let question_type = params
            .question_type
            .as_ref()
            .map(|t| t.as_str())
            .unwrap_or("other");
        let difficulty = params.difficulty.as_ref().map(|d| d.as_str());
        let source_type = params
            .source_type
            .as_ref()
            .map(|s| s.as_str())
            .unwrap_or("ocr");
        let images_json = params
            .images
            .as_ref()
            .map(|imgs| serde_json::to_string(imgs).unwrap_or_else(|_| "[]".to_string()))
            .unwrap_or_else(|| "[]".to_string());
        // Value::Null 视为未提供，避免列里存 "null" 字符串
        let structured_data_json = params
            .structured_data
            .as_ref()
            .filter(|v| !v.is_null())
            .map(|v| v.to_string());

        conn.execute(
            r#"
            INSERT INTO questions (
                id, exam_id, card_id, question_label, content, options_json,
                answer, explanation, question_type, difficulty, tags,
                status, source_type, source_ref, images_json, parent_id, created_at, updated_at,
                structured_data
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18,
                ?19
            )
            "#,
            params![
                id,
                params.exam_id,
                params.card_id,
                params.question_label,
                params.content,
                options_json,
                params.answer,
                params.explanation,
                question_type,
                difficulty,
                tags_json,
                "new",
                source_type,
                params.source_ref,
                images_json,
                params.parent_id,
                now,
                now,
                structured_data_json,
            ],
        )?;

        info!("[VFS::QuestionRepo] Created question id={}", id);

        Self::invalidate_exam_content_index_with_conn(conn, &params.exam_id)?;
        Self::get_question_with_conn(conn, &id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "question".to_string(),
            id: id.clone(),
        })
    }

    /// 批量创建题目
    pub fn batch_create_questions(
        db: &VfsDatabase,
        params_list: &[CreateQuestionParams],
    ) -> VfsResult<Vec<Question>> {
        let conn = db.get_conn_safe()?;
        Self::batch_create_questions_with_conn(&conn, params_list)
    }

    /// 批量创建题目（使用现有连接，带事务保护）
    pub fn batch_create_questions_with_conn(
        conn: &Connection,
        params_list: &[CreateQuestionParams],
    ) -> VfsResult<Vec<Question>> {
        // 开始事务以确保原子性
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<Vec<Question>> {
            let mut questions = Vec::with_capacity(params_list.len());
            for params in params_list {
                let q = Self::create_question_with_conn(conn, params)?;
                questions.push(q);
            }
            Ok(questions)
        })();

        match result {
            Ok(questions) => {
                conn.execute("COMMIT", [])?;
                info!(
                    "[VFS::QuestionRepo] Batch created {} questions (committed)",
                    questions.len()
                );
                Ok(questions)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                warn!(
                    "[VFS::QuestionRepo] Batch create failed, rolled back: {}",
                    e
                );
                Err(e)
            }
        }
    }

    // ========================================================================
    // 更新
    // ========================================================================

    /// 更新题目
    pub fn update_question(
        db: &VfsDatabase,
        question_id: &str,
        params: &UpdateQuestionParams,
    ) -> VfsResult<Question> {
        let conn = db.get_conn_safe()?;
        Self::update_question_with_conn(&conn, question_id, params)
    }

    /// 更新题目（使用现有连接）
    pub fn update_question_with_conn(
        conn: &Connection,
        question_id: &str,
        params: &UpdateQuestionParams,
    ) -> VfsResult<Question> {
        let now = chrono::Utc::now().to_rfc3339();
        let mut set_clauses = vec![
            "updated_at = ?1".to_string(),
            "sync_status = CASE WHEN sync_status = 'synced' THEN 'modified' ELSE sync_status END"
                .to_string(),
        ];
        let mut param_values: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(now.clone())];
        let mut param_idx = 2;

        // 动态构建 SET 子句
        if let Some(label) = &params.question_label {
            set_clauses.push(format!("question_label = ?{}", param_idx));
            param_values.push(Box::new(label.clone()));
            param_idx += 1;
        }
        if let Some(content) = &params.content {
            set_clauses.push(format!("content = ?{}", param_idx));
            param_values.push(Box::new(content.clone()));
            param_idx += 1;
        }
        if let Some(options) = &params.options {
            set_clauses.push(format!("options_json = ?{}", param_idx));
            param_values.push(Box::new(serde_json::to_string(options).unwrap_or_default()));
            param_idx += 1;
        }
        if let Some(answer) = &params.answer {
            set_clauses.push(format!("answer = ?{}", param_idx));
            param_values.push(Box::new(answer.clone()));
            param_idx += 1;
        }
        if let Some(explanation) = &params.explanation {
            set_clauses.push(format!("explanation = ?{}", param_idx));
            param_values.push(Box::new(explanation.clone()));
            param_idx += 1;
        }
        if let Some(qt) = &params.question_type {
            set_clauses.push(format!("question_type = ?{}", param_idx));
            param_values.push(Box::new(qt.as_str().to_string()));
            param_idx += 1;
        }
        if let Some(diff) = &params.difficulty {
            set_clauses.push(format!("difficulty = ?{}", param_idx));
            param_values.push(Box::new(diff.as_str().to_string()));
            param_idx += 1;
        }
        if let Some(tags) = &params.tags {
            set_clauses.push(format!("tags = ?{}", param_idx));
            param_values.push(Box::new(
                serde_json::to_string(tags).unwrap_or_else(|_| "[]".to_string()),
            ));
            param_idx += 1;
        }
        if let Some(status) = &params.status {
            set_clauses.push(format!("status = ?{}", param_idx));
            param_values.push(Box::new(status.as_str().to_string()));
            param_idx += 1;
        }
        if let Some(user_answer) = &params.user_answer {
            set_clauses.push(format!("user_answer = ?{}", param_idx));
            param_values.push(Box::new(user_answer.clone()));
            param_idx += 1;
        }
        if let Some(is_correct) = params.is_correct {
            set_clauses.push(format!("is_correct = ?{}", param_idx));
            param_values.push(Box::new(if is_correct { 1 } else { 0 }));
            param_idx += 1;
        }
        if let Some(note) = &params.user_note {
            set_clauses.push(format!("user_note = ?{}", param_idx));
            param_values.push(Box::new(note.clone()));
            param_idx += 1;
        }
        if let Some(is_fav) = params.is_favorite {
            set_clauses.push(format!("is_favorite = ?{}", param_idx));
            param_values.push(Box::new(if is_fav { 1 } else { 0 }));
            param_idx += 1;
        }
        if let Some(is_bm) = params.is_bookmarked {
            set_clauses.push(format!("is_bookmarked = ?{}", param_idx));
            param_values.push(Box::new(if is_bm { 1 } else { 0 }));
            param_idx += 1;
        }
        if let Some(images) = &params.images {
            set_clauses.push(format!("images_json = ?{}", param_idx));
            param_values.push(Box::new(
                serde_json::to_string(images).unwrap_or_else(|_| "[]".to_string()),
            ));
            param_idx += 1;
        }
        // Some(Value::Null) 显式清空该列（存 NULL 而非 "null" 文本）；
        // 题型切换到不使用 structured_data 的类型且未显式携带时，同样清为 NULL，
        // 避免 matching→short_answer 等切换后旧结构化数据永久残留
        let structured_update: Option<Option<String>> =
            if let Some(structured_data) = &params.structured_data {
                Some(if structured_data.is_null() {
                    None
                } else {
                    Some(structured_data.to_string())
                })
            } else if params.should_clear_stale_structured_data() {
                Some(None)
            } else {
                None
            };
        if let Some(value) = structured_update {
            set_clauses.push(format!("structured_data = ?{}", param_idx));
            param_values.push(Box::new(value));
            param_idx += 1;
        }

        let question_id_param = param_idx;
        param_values.push(Box::new(question_id.to_string()));
        param_idx += 1;

        let expected_updated_at = params
            .expected_updated_at
            .as_deref()
            .filter(|expected| !expected.is_empty());
        let occ_predicate = if let Some(expected) = expected_updated_at {
            let predicate = format!(" AND updated_at = ?{}", param_idx);
            param_values.push(Box::new(expected.to_string()));
            predicate
        } else {
            String::new()
        };

        // The optimistic-lock comparison is part of the write itself. A separate
        // SELECT pre-check leaves a race window in which another writer can win
        // between validation and UPDATE.
        let sql = format!(
            "UPDATE questions SET {} WHERE id = ?{} AND deleted_at IS NULL{}",
            set_clauses.join(", "),
            question_id_param,
            occ_predicate
        );

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        let affected = conn.execute(&sql, params_refs.as_slice())?;

        if affected == 0 {
            if let (Some(expected), Some(current)) = (
                expected_updated_at,
                Self::get_question_with_conn(conn, question_id)?,
            ) {
                warn!(
                    "[VFS::QuestionRepo] Optimistic lock conflict for question {}: expected updated_at='{}', actual='{}'",
                    question_id, expected, current.updated_at
                );
                return Err(VfsError::Other(format!(
                    "QBANK_CONFLICT: expected_updated_at={}, actual_updated_at={}",
                    expected, current.updated_at
                )));
            }
            return Err(VfsError::NotFound {
                resource_type: "question".to_string(),
                id: question_id.to_string(),
            });
        }

        // 内容/元数据更新后标记本地修改并立即重算 hash，避免同步冲突判断使用过期值
        // （与 submit_answer_with_conn 的 S-030 口径一致；否则本地编辑在同步时会被远程静默覆盖）
        QuestionSyncService::mark_as_modified_with_conn(conn, question_id)?;
        QuestionSyncService::update_content_hash_with_conn(conn, question_id)?;

        debug!("[VFS::QuestionRepo] Updated question id={}", question_id);

        if let Some(exam_id) = Self::exam_id_for_question_with_conn(conn, question_id)? {
            Self::invalidate_exam_content_index_with_conn(conn, &exam_id)?;
        }
        Self::get_question_with_conn(conn, question_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "question".to_string(),
            id: question_id.to_string(),
        })
    }

    /// 增量更新答题状态
    pub fn submit_answer(
        db: &VfsDatabase,
        question_id: &str,
        user_answer: &str,
        is_correct: Option<bool>,
        needs_manual_grading: bool,
    ) -> VfsResult<Question> {
        let conn = db.get_conn_safe()?;
        Self::submit_answer_with_conn(
            &conn,
            question_id,
            user_answer,
            is_correct,
            needs_manual_grading,
        )
    }

    /// 增量更新答题状态（使用现有连接）
    ///
    /// 状态转换规则：
    /// - 答对：correct_count + 1，若 correct_count >= 2 则 mastered，否则 in_progress
    /// - 答错：status = review
    pub fn submit_answer_with_conn(
        conn: &Connection,
        question_id: &str,
        user_answer: &str,
        is_correct: Option<bool>,
        needs_manual_grading: bool,
    ) -> VfsResult<Question> {
        let now = chrono::Utc::now().to_rfc3339();
        let is_correct_value = is_correct.map(|v| if v { 1 } else { 0 });
        let correct_increment = if is_correct == Some(true) { 1 } else { 0 };
        let manual_flag = if needs_manual_grading { 1 } else { 0 };

        // 🔧 修复：根据 correct_count 判断状态，不是简单的答对就 mastered
        // 使用 CASE 表达式在 SQL 层实现状态转换逻辑
        let affected = conn.execute(
            r#"
            UPDATE questions SET
                user_answer = ?1,
                is_correct = ?2,
                attempt_count = attempt_count + 1,
                correct_count = correct_count + ?3,
                last_attempt_at = ?4,
                status = CASE
                    WHEN ?5 = 1 THEN 'in_progress'
                    WHEN ?2 = 0 THEN 'review'
                    WHEN correct_count + ?3 >= 2 THEN 'mastered'
                    ELSE 'in_progress'
                END,
                updated_at = ?6
            WHERE id = ?7 AND deleted_at IS NULL
            "#,
            params![
                user_answer,
                is_correct_value,
                correct_increment,
                now,
                manual_flag,
                now,
                question_id,
            ],
        )?;
        if affected == 0 {
            return Err(VfsError::NotFound {
                resource_type: "question".to_string(),
                id: question_id.to_string(),
            });
        }

        debug!(
            "[VFS::QuestionRepo] Submitted answer for question id={}, is_correct={:?}, manual={}",
            question_id, is_correct, needs_manual_grading
        );

        // ★ S-030: 答题记录变更也触发同步标记
        QuestionSyncService::mark_as_modified_with_conn(conn, question_id)?;
        QuestionSyncService::update_content_hash_with_conn(conn, question_id)?;

        Self::get_question_with_conn(conn, question_id)?.ok_or_else(|| VfsError::NotFound {
            resource_type: "question".to_string(),
            id: question_id.to_string(),
        })
    }

    // ========================================================================
    // 删除
    // ========================================================================

    /// 软删除题目
    pub fn delete_question(db: &VfsDatabase, question_id: &str) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        Self::delete_question_with_conn(&conn, question_id)
    }

    /// 软删除题目（使用现有连接）
    pub fn delete_question_with_conn(conn: &Connection, question_id: &str) -> VfsResult<()> {
        let exam_id = Self::exam_id_for_question_with_conn(conn, question_id)?;
        let now = chrono::Utc::now().to_rfc3339();
        let affected = conn.execute(
            "UPDATE questions SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
            params![now, question_id],
        )?;

        if affected == 0 {
            return Err(VfsError::NotFound {
                resource_type: "question".to_string(),
                id: question_id.to_string(),
            });
        }

        info!(
            "[VFS::QuestionRepo] Soft deleted question id={}",
            question_id
        );
        if let Some(exam_id) = exam_id {
            Self::invalidate_exam_content_index_with_conn(conn, &exam_id)?;
        }
        Ok(())
    }

    /// Soft-delete one question while atomically checking its optimistic-lock baseline.
    ///
    /// Callers that delete more than one question should wrap repeated calls in a single
    /// transaction so a conflict leaves the whole batch untouched.
    pub fn delete_question_if_version_with_conn(
        conn: &Connection,
        question_id: &str,
        expected_updated_at: &str,
    ) -> VfsResult<()> {
        let now = chrono::Utc::now().to_rfc3339();
        let affected = conn.execute(
            "UPDATE questions SET deleted_at = ?1, updated_at = ?1 \
             WHERE id = ?2 AND deleted_at IS NULL AND updated_at = ?3",
            params![now, question_id, expected_updated_at],
        )?;

        if affected == 0 {
            if let Some(current) = Self::get_question_with_conn(conn, question_id)? {
                return Err(VfsError::Other(format!(
                    "QBANK_CONFLICT: question_id={}, expected_updated_at={}, actual_updated_at={}",
                    question_id, expected_updated_at, current.updated_at
                )));
            }
            return Err(VfsError::NotFound {
                resource_type: "question".to_string(),
                id: question_id.to_string(),
            });
        }

        info!(
            "[VFS::QuestionRepo] OCC soft deleted question id={}",
            question_id
        );
        Ok(())
    }

    /// 批量软删除题目
    pub fn batch_delete_questions(db: &VfsDatabase, question_ids: &[String]) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::batch_delete_questions_with_conn(&conn, question_ids)
    }

    /// 批量软删除题目（使用现有连接，带事务保护）
    pub fn batch_delete_questions_with_conn(
        conn: &Connection,
        question_ids: &[String],
    ) -> VfsResult<usize> {
        // 开始事务以确保原子性
        conn.execute("BEGIN IMMEDIATE", [])?;

        let result = (|| -> VfsResult<usize> {
            let now = chrono::Utc::now().to_rfc3339();
            let mut deleted = 0;
            let mut exam_ids: Vec<String> = Vec::new();
            for id in question_ids {
                if let Some(exam_id) = Self::exam_id_for_question_with_conn(conn, id)? {
                    if !exam_ids.contains(&exam_id) {
                        exam_ids.push(exam_id);
                    }
                }
                let affected = conn.execute(
                    "UPDATE questions SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                    params![now, id],
                )?;
                deleted += affected;
            }
            for exam_id in &exam_ids {
                Self::invalidate_exam_content_index_with_conn(conn, exam_id)?;
            }
            Ok(deleted)
        })();

        match result {
            Ok(deleted) => {
                conn.execute("COMMIT", [])?;
                info!(
                    "[VFS::QuestionRepo] Batch soft deleted {} questions (committed)",
                    deleted
                );
                Ok(deleted)
            }
            Err(e) => {
                let _ = conn.execute("ROLLBACK", []);
                warn!(
                    "[VFS::QuestionRepo] Batch delete failed, rolled back: {}",
                    e
                );
                Err(e)
            }
        }
    }

    // ========================================================================
    // 历史记录
    // ========================================================================

    /// 记录历史
    pub fn record_history(
        db: &VfsDatabase,
        question_id: &str,
        field_name: &str,
        old_value: Option<&str>,
        new_value: Option<&str>,
        operator: &str,
        reason: Option<&str>,
    ) -> VfsResult<QuestionHistory> {
        let conn = db.get_conn_safe()?;
        Self::record_history_with_conn(
            &conn,
            question_id,
            field_name,
            old_value,
            new_value,
            operator,
            reason,
        )
    }

    /// 记录历史（使用现有连接）
    pub fn record_history_with_conn(
        conn: &Connection,
        question_id: &str,
        field_name: &str,
        old_value: Option<&str>,
        new_value: Option<&str>,
        operator: &str,
        reason: Option<&str>,
    ) -> VfsResult<QuestionHistory> {
        let id = format!("qh_{}", nanoid::nanoid!(10));
        let now = chrono::Utc::now().to_rfc3339();

        conn.execute(
            r#"
            INSERT INTO question_history (id, question_id, field_name, old_value, new_value, operator, reason, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
            "#,
            params![id, question_id, field_name, old_value, new_value, operator, reason, now],
        )?;

        debug!(
            "[VFS::QuestionRepo] Recorded history for question id={}, field={}",
            question_id, field_name
        );

        Ok(QuestionHistory {
            id,
            question_id: question_id.to_string(),
            field_name: field_name.to_string(),
            old_value: old_value.map(|s| s.to_string()),
            new_value: new_value.map(|s| s.to_string()),
            operator: operator.to_string(),
            reason: reason.map(|s| s.to_string()),
            created_at: now,
        })
    }

    /// 获取历史记录
    pub fn get_history(
        db: &VfsDatabase,
        question_id: &str,
        limit: Option<u32>,
    ) -> VfsResult<Vec<QuestionHistory>> {
        let conn = db.get_conn_safe()?;
        Self::get_history_with_conn(&conn, question_id, limit)
    }

    /// 获取历史记录（使用现有连接）
    pub fn get_history_with_conn(
        conn: &Connection,
        question_id: &str,
        limit: Option<u32>,
    ) -> VfsResult<Vec<QuestionHistory>> {
        let limit_val = limit.unwrap_or(100);
        let mut stmt = conn.prepare(
            r#"
            SELECT id, question_id, field_name, old_value, new_value, operator, reason, created_at
            FROM question_history
            WHERE question_id = ?1
            ORDER BY created_at DESC, id ASC
            LIMIT ?2
            "#,
        )?;

        let rows = stmt.query_map(params![question_id, limit_val], |row| {
            Ok(QuestionHistory {
                id: row.get(0)?,
                question_id: row.get(1)?,
                field_name: row.get(2)?,
                old_value: row.get(3)?,
                new_value: row.get(4)?,
                operator: row.get(5)?,
                reason: row.get(6)?,
                created_at: row.get(7)?,
            })
        })?;

        let history: Vec<QuestionHistory> = rows.filter_map(log_and_skip_err).collect();
        Ok(history)
    }

    // ========================================================================
    // 统计
    // ========================================================================

    /// 按题型统计题目数量（组卷配置的前端余量校验用）
    ///
    /// 口径与列表/统计一致：只统计未删除题目，避免软删题把余量算大。
    pub fn count_by_type(db: &VfsDatabase, exam_id: &str) -> VfsResult<HashMap<String, u32>> {
        let conn = db.get_conn_safe()?;
        let mut stmt = conn.prepare(
            "SELECT question_type, COUNT(*) FROM questions \
             WHERE exam_id = ?1 AND deleted_at IS NULL GROUP BY question_type",
        )?;
        let rows = stmt.query_map(params![exam_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?;
        let mut counts = HashMap::new();
        for row in rows {
            let (question_type, n) = row?;
            counts.insert(question_type, n.max(0) as u32);
        }
        Ok(counts)
    }

    /// 获取统计（优先读缓存）
    pub fn get_stats(db: &VfsDatabase, exam_id: &str) -> VfsResult<Option<QuestionBankStats>> {
        let conn = db.get_conn_safe()?;
        Self::get_stats_with_conn(&conn, exam_id)
    }

    /// 获取统计（使用现有连接）
    pub fn get_stats_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<Option<QuestionBankStats>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT exam_id, total_count, new_count, in_progress_count, mastered_count,
                   review_count, total_attempts, total_correct, correct_rate, updated_at
            FROM question_bank_stats
            WHERE exam_id = ?1
            "#,
        )?;

        let stats = stmt
            .query_row(params![exam_id], |row| {
                Ok(QuestionBankStats {
                    exam_id: row.get(0)?,
                    total_count: row.get(1)?,
                    new_count: row.get(2)?,
                    in_progress_count: row.get(3)?,
                    mastered_count: row.get(4)?,
                    review_count: row.get(5)?,
                    total_attempts: row.get(6)?,
                    total_correct: row.get(7)?,
                    correct_rate: row.get(8)?,
                    updated_at: row.get(9)?,
                })
            })
            .optional()?;

        Ok(stats)
    }

    /// 刷新统计（重新计算）
    pub fn refresh_stats(db: &VfsDatabase, exam_id: &str) -> VfsResult<QuestionBankStats> {
        let conn = db.get_conn_safe()?;
        Self::refresh_stats_with_conn(&conn, exam_id)
    }

    /// 刷新统计（使用现有连接）
    pub fn refresh_stats_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<QuestionBankStats> {
        let now = chrono::Utc::now().to_rfc3339();

        // 计算各项统计
        // COALESCE：exam 下没有任何题目时 SUM(...) 为 NULL，直接 row.get::<i32>
        // 会报 InvalidColumnType，导致"删空题目集后刷新统计必失败"。
        let stats: (i32, i32, i32, i32, i32, i32, i32) = conn.query_row(
            r#"
            SELECT
                COUNT(*) as total,
                COALESCE(SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END), 0) as new_count,
                COALESCE(SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END), 0) as in_progress,
                COALESCE(SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END), 0) as mastered,
                COALESCE(SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END), 0) as review,
                COALESCE(SUM(attempt_count), 0) as total_attempts,
                COALESCE(SUM(correct_count), 0) as total_correct
            FROM questions
            WHERE exam_id = ?1 AND deleted_at IS NULL
            "#,
            params![exam_id],
            |row| {
                Ok((
                    row.get::<_, i32>(0)?,
                    row.get::<_, i32>(1)?,
                    row.get::<_, i32>(2)?,
                    row.get::<_, i32>(3)?,
                    row.get::<_, i32>(4)?,
                    row.get::<_, i32>(5)?,
                    row.get::<_, i32>(6)?,
                ))
            },
        )?;

        let correct_rate = if stats.5 > 0 {
            stats.6 as f64 / stats.5 as f64
        } else {
            0.0
        };

        // Upsert 统计
        conn.execute(
            r#"
            INSERT INTO question_bank_stats (
                exam_id, total_count, new_count, in_progress_count, mastered_count,
                review_count, total_attempts, total_correct, correct_rate, updated_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(exam_id) DO UPDATE SET
                total_count = excluded.total_count,
                new_count = excluded.new_count,
                in_progress_count = excluded.in_progress_count,
                mastered_count = excluded.mastered_count,
                review_count = excluded.review_count,
                total_attempts = excluded.total_attempts,
                total_correct = excluded.total_correct,
                correct_rate = excluded.correct_rate,
                updated_at = excluded.updated_at
            "#,
            params![
                exam_id,
                stats.0,
                stats.1,
                stats.2,
                stats.3,
                stats.4,
                stats.5,
                stats.6,
                correct_rate,
                now,
            ],
        )?;

        debug!(
            "[VFS::QuestionRepo] Refreshed stats for exam_id={}, total={}",
            exam_id, stats.0
        );

        Ok(QuestionBankStats {
            exam_id: exam_id.to_string(),
            total_count: stats.0,
            new_count: stats.1,
            in_progress_count: stats.2,
            mastered_count: stats.3,
            review_count: stats.4,
            total_attempts: stats.5,
            total_correct: stats.6,
            correct_rate,
            updated_at: now,
        })
    }

    // ========================================================================
    // 作答历史（answer_submissions）
    // ========================================================================

    /// 记录一条作答提交
    pub fn insert_submission(
        db: &VfsDatabase,
        question_id: &str,
        user_answer: &str,
        is_correct: Option<bool>,
        grading_method: &str,
        client_request_id: Option<&str>,
    ) -> VfsResult<String> {
        let conn = db.get_conn_safe()?;
        Self::insert_submission_with_conn(
            &conn,
            question_id,
            user_answer,
            is_correct,
            grading_method,
            client_request_id,
        )
    }

    /// 记录一条作答提交（使用现有连接）
    pub fn insert_submission_with_conn(
        conn: &Connection,
        question_id: &str,
        user_answer: &str,
        is_correct: Option<bool>,
        grading_method: &str,
        client_request_id: Option<&str>,
    ) -> VfsResult<String> {
        Self::insert_submission_with_snapshot_with_conn(
            conn,
            question_id,
            user_answer,
            is_correct,
            grading_method,
            client_request_id,
            None,
            None,
        )
    }

    /// 记录一条作答提交，并冻结题目/材料快照（历史判分复核）。
    ///
    /// 快照在建档时一次性拷贝题目投影与所需材料全文：此后编辑题目或材料、
    /// 或删除材料关联，都不会改变这次作答当时被评判的内容。
    #[allow(clippy::too_many_arguments)]
    pub fn insert_submission_with_snapshot_with_conn(
        conn: &Connection,
        question_id: &str,
        user_answer: &str,
        is_correct: Option<bool>,
        grading_method: &str,
        client_request_id: Option<&str>,
        question_snapshot_json: Option<&str>,
        material_snapshot_json: Option<&str>,
    ) -> VfsResult<String> {
        let normalized_request_id = client_request_id.map(str::trim).filter(|s| !s.is_empty());
        if let Some(req_id) = normalized_request_id {
            if let Some(existing) =
                Self::get_submission_by_client_request_with_conn(conn, question_id, req_id)?
            {
                return Ok(existing.id);
            }
        }

        // 所有作答入口（手动作答、工具批量练习、AI 判分）都冻结同一份快照：
        // 调用方不需要理解快照格式，也不可能忘记传；历史复核永远看到提交当时的
        // 题干/选项/答案与所需材料，而不是被后续编辑覆盖的当前内容。
        // 快照生成失败必须上抛（VfsResult）：历史复核不能静默丢掉材料快照，
        // 否则旧判分在材料被编辑后无法复原当时的条件。
        let (question_snapshot_json, material_snapshot_json) =
            if question_snapshot_json.is_none() && material_snapshot_json.is_none() {
                Self::build_submission_snapshots_with_conn(conn, question_id)?
            } else {
                (
                    question_snapshot_json.map(str::to_string),
                    material_snapshot_json.map(str::to_string),
                )
            };

        let id = format!("as_{}", nanoid::nanoid!(10));
        let now = chrono::Utc::now().to_rfc3339();
        let is_correct_val = is_correct.map(|v| if v { 1 } else { 0 });

        conn.execute(
            r#"
            INSERT INTO answer_submissions (
                id, question_id, user_answer, is_correct, grading_method, submitted_at,
                client_request_id, question_snapshot_json, material_snapshot_json
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
            "#,
            params![
                id,
                question_id,
                user_answer,
                is_correct_val,
                grading_method,
                now,
                normalized_request_id,
                question_snapshot_json,
                material_snapshot_json,
            ],
        )?;

        debug!(
            "[VFS::QuestionRepo] Inserted submission id={} for question={}",
            id, question_id
        );

        Ok(id)
    }

    /// 读取单次作答冻结的题目/材料快照。
    pub fn get_submission_snapshot_with_conn(
        conn: &Connection,
        submission_id: &str,
    ) -> VfsResult<Option<SubmissionSnapshot>> {
        let snapshot = conn
            .query_row(
                r#"
                SELECT id, question_snapshot_json, material_snapshot_json
                FROM answer_submissions
                WHERE id = ?1
                "#,
                params![submission_id],
                |row| {
                    Ok(SubmissionSnapshot {
                        submission_id: row.get(0)?,
                        question_snapshot_json: row.get(1)?,
                        material_snapshot_json: row.get(2)?,
                    })
                },
            )
            .optional()?;
        Ok(snapshot)
    }

    /// 生成作答时冻结的题目/材料快照。
    ///
    /// 题目快照只包含判分与复核需要的内容（不含学习状态/计数），材料快照按
    /// 组的 `qbank_group_materials` 投影一次性写全，附 `local_version` 以便
    /// 复核界面提示"材料已更新"。
    pub fn build_submission_snapshots_with_conn(
        conn: &Connection,
        question_id: &str,
    ) -> VfsResult<(Option<String>, Option<String>)> {
        let Some(question) = Self::get_question_with_conn(conn, question_id)? else {
            return Ok((None, None));
        };
        let material_ids: Vec<String> = question.materials.iter().map(|m| m.id.clone()).collect();
        let question_snapshot = serde_json::json!({
            "id": question.id,
            "exam_id": question.exam_id,
            "question_label": question.question_label,
            "content": question.content,
            "options": question.options,
            "answer": question.answer,
            "explanation": question.explanation,
            "structured_data": question.structured_data,
            "question_type": question.question_type.as_str(),
            "difficulty": question.difficulty.as_ref().map(|d| d.as_str()),
            "tags": question.tags,
            "images": question.images,
            "group_id": question.group_id,
            "group_position": question.group_position,
            "group_label": question.group_label,
            "material_ids": material_ids,
            "answer_origin": question.answer_origin,
            "question_updated_at": question.updated_at,
        });
        let material_snapshot = serde_json::json!({
            "materials": question.materials,
        });
        Ok((
            Some(serde_json::to_string(&question_snapshot).unwrap_or_default()),
            Some(serde_json::to_string(&material_snapshot).unwrap_or_default()),
        ))
    }

    /// 读取某题历次作答及其冻结快照（新的在前）。
    pub fn get_submissions_with_snapshots_with_conn(
        conn: &Connection,
        question_id: &str,
        limit: u32,
    ) -> VfsResult<Vec<(AnswerSubmission, SubmissionSnapshot)>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, question_id, user_answer, is_correct, grading_method, submitted_at,
                   question_snapshot_json, material_snapshot_json
            FROM answer_submissions
            WHERE question_id = ?1
            ORDER BY submitted_at DESC
            LIMIT ?2
            "#,
        )?;
        let rows = stmt.query_map(params![question_id, limit], |row| {
            let is_correct: Option<i32> = row.get(3)?;
            let id: String = row.get(0)?;
            Ok((
                AnswerSubmission {
                    id: id.clone(),
                    question_id: row.get(1)?,
                    user_answer: row.get(2)?,
                    is_correct: is_correct.map(|v| v != 0),
                    grading_method: row.get(4)?,
                    submitted_at: row.get(5)?,
                },
                SubmissionSnapshot {
                    submission_id: id,
                    question_snapshot_json: row.get(6)?,
                    material_snapshot_json: row.get(7)?,
                },
            ))
        })?;
        Ok(rows.filter_map(log_and_skip_err).collect())
    }

    /// 按客户端请求 ID 查询已存在的提交（用于幂等）
    pub fn get_submission_by_client_request_with_conn(
        conn: &Connection,
        question_id: &str,
        client_request_id: &str,
    ) -> VfsResult<Option<AnswerSubmission>> {
        let submission = conn
            .query_row(
                r#"
                SELECT id, question_id, user_answer, is_correct, grading_method, submitted_at
                FROM answer_submissions
                WHERE question_id = ?1 AND client_request_id = ?2
                ORDER BY submitted_at DESC
                LIMIT 1
                "#,
                params![question_id, client_request_id],
                |row| {
                    Ok(AnswerSubmission {
                        id: row.get(0)?,
                        question_id: row.get(1)?,
                        user_answer: row.get(2)?,
                        is_correct: row.get::<_, Option<i32>>(3)?.map(|v| v != 0),
                        grading_method: row.get(4)?,
                        submitted_at: row.get(5)?,
                    })
                },
            )
            .optional()?;
        Ok(submission)
    }

    /// AI 评判完成后更新 submission 的 is_correct
    pub fn update_submission_correct(
        db: &VfsDatabase,
        submission_id: &str,
        is_correct: bool,
        grading_method: &str,
    ) -> VfsResult<()> {
        let conn = db.get_conn_safe()?;
        let is_correct_val = if is_correct { 1 } else { 0 };

        conn.execute(
            "UPDATE answer_submissions SET is_correct = ?1, grading_method = ?2 WHERE id = ?3",
            params![is_correct_val, grading_method, submission_id],
        )?;

        Ok(())
    }

    /// 查询某题的历次作答记录
    pub fn get_submissions(
        db: &VfsDatabase,
        question_id: &str,
        limit: u32,
    ) -> VfsResult<Vec<AnswerSubmission>> {
        let conn = db.get_conn_safe()?;
        Self::get_submissions_with_conn(&conn, question_id, limit)
    }

    /// 查询某题的历次作答记录（使用现有连接）
    pub fn get_submissions_with_conn(
        conn: &Connection,
        question_id: &str,
        limit: u32,
    ) -> VfsResult<Vec<AnswerSubmission>> {
        let mut stmt = conn.prepare(
            r#"
            SELECT id, question_id, user_answer, is_correct, grading_method, submitted_at
            FROM answer_submissions
            WHERE question_id = ?1
            ORDER BY submitted_at DESC
            LIMIT ?2
            "#,
        )?;

        let submissions = stmt
            .query_map(params![question_id, limit], |row| {
                let is_correct: Option<i32> = row.get(3)?;
                Ok(AnswerSubmission {
                    id: row.get(0)?,
                    question_id: row.get(1)?,
                    user_answer: row.get(2)?,
                    is_correct: is_correct.map(|v| v != 0),
                    grading_method: row.get(4)?,
                    submitted_at: row.get(5)?,
                })
            })?
            .filter_map(log_and_skip_err)
            .collect();

        Ok(submissions)
    }

    /// 删除某题的所有作答记录（重置进度时调用）
    pub fn delete_submissions_by_question(db: &VfsDatabase, question_id: &str) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::delete_submissions_by_question_with_conn(&conn, question_id)
    }

    pub fn delete_submissions_by_question_with_conn(
        conn: &Connection,
        question_id: &str,
    ) -> VfsResult<usize> {
        let deleted = conn.execute(
            "DELETE FROM answer_submissions WHERE question_id = ?1",
            params![question_id],
        )?;
        Ok(deleted)
    }

    /// 删除某题目集下所有题目的作答记录（重置整个题目集进度时调用）
    pub fn delete_submissions_by_exam(db: &VfsDatabase, exam_id: &str) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
        Self::delete_submissions_by_exam_with_conn(&conn, exam_id)
    }

    pub fn delete_submissions_by_exam_with_conn(
        conn: &Connection,
        exam_id: &str,
    ) -> VfsResult<usize> {
        let deleted = conn.execute(
            r#"
            DELETE FROM answer_submissions
            WHERE question_id IN (SELECT id FROM questions WHERE exam_id = ?1)
            "#,
            params![exam_id],
        )?;
        Ok(deleted)
    }

    // ========================================================================
    // 辅助方法
    // ========================================================================

    /// 行转换为 Question
    fn row_to_question(row: &Row) -> rusqlite::Result<Question> {
        let options_json: Option<String> = row.get(5)?;
        let options: Option<Vec<QuestionOption>> = options_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        let tags_json: Option<String> = row.get(10)?;
        let tags: Vec<String> = tags_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();

        let question_type_str: Option<String> = row.get(8)?;
        let question_type = question_type_str
            .map(|s| QuestionType::from_str(&s))
            .unwrap_or_default();

        let difficulty_str: Option<String> = row.get(9)?;
        let difficulty = difficulty_str.map(|s| Difficulty::from_str(&s));

        let status_str: Option<String> = row.get(11)?;
        let status = status_str
            .map(|s| QuestionStatus::from_str(&s))
            .unwrap_or_default();

        let source_type_str: Option<String> = row.get(20)?;
        let source_type = source_type_str
            .map(|s| SourceType::from_str(&s))
            .unwrap_or_default();

        let images_json_str: Option<String> = row.get(22)?;
        let images: Vec<QuestionImage> = images_json_str
            .as_ref()
            .and_then(|s| match serde_json::from_str(s) {
                Ok(v) => Some(v),
                Err(e) => {
                    log::warn!("[VFS::QuestionRepo] Failed to parse images_json: {}", e);
                    None
                }
            })
            .unwrap_or_default();

        let is_correct: Option<i32> = row.get(13)?;
        let is_favorite: i32 = row.get(18)?;
        let is_bookmarked: i32 = row.get(19)?;

        let ai_score: Option<i32> = row.get(27)?;

        let structured_data_json: Option<String> = row.get(29)?;
        let structured_data: Option<serde_json::Value> =
            structured_data_json
                .as_ref()
                .and_then(|s| match serde_json::from_str(s) {
                    Ok(serde_json::Value::Null) => None,
                    Ok(v) => Some(v),
                    Err(e) => {
                        log::warn!("[VFS::QuestionRepo] Failed to parse structured_data: {}", e);
                        None
                    }
                });

        // 题组/来源投影：列在 V20261023 后存在；旧测试库若尚未迁移则为 NULL。
        let group_id: Option<String> = row.get(30)?;
        let group_position: Option<i32> = row.get(31)?;
        let source_key: Option<String> = row.get(32)?;
        let provenance_json: Option<String> = row.get(33)?;
        let answer_origin: Option<String> = row.get(34)?;
        let (source_refs, answer_source_refs) = parse_provenance_refs(provenance_json.as_deref());

        Ok(Question {
            id: row.get(0)?,
            exam_id: row.get(1)?,
            card_id: row.get(2)?,
            question_label: row.get(3)?,
            content: row.get(4)?,
            options,
            answer: row.get(6)?,
            explanation: row.get(7)?,
            structured_data,
            question_type,
            difficulty,
            tags,
            status,
            user_answer: row.get(12)?,
            is_correct: is_correct.map(|v| v != 0),
            attempt_count: row.get(14)?,
            correct_count: row.get(15)?,
            last_attempt_at: row.get(16)?,
            user_note: row.get(17)?,
            is_favorite: is_favorite != 0,
            is_bookmarked: is_bookmarked != 0,
            source_type,
            source_ref: row.get(21)?,
            images,
            parent_id: row.get(23)?,
            created_at: row.get(24)?,
            updated_at: row.get(25)?,
            ai_feedback: row.get(26)?,
            ai_score,
            ai_graded_at: row.get(28)?,
            group_id,
            group_position,
            group_label: None,
            materials: Vec::new(),
            answer_origin,
            source_refs,
            answer_source_refs,
            source_key,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escape_fts5_query_quotes_every_token() {
        // 普通词也统一加引号（与裸词匹配语义等价）
        assert_eq!(VfsQuestionRepo::escape_fts5_query("hello"), "\"hello\"");
        // 多词保持隐式 AND
        assert_eq!(
            VfsQuestionRepo::escape_fts5_query("foo bar"),
            "\"foo\" \"bar\""
        );
        // FTS5 特殊字符不再产生语法错误
        assert_eq!(
            VfsQuestionRepo::escape_fts5_query("C++ 是什么?"),
            "\"C++\" \"是什么?\""
        );
        assert_eq!(VfsQuestionRepo::escape_fts5_query("a.b"), "\"a.b\"");
        assert_eq!(VfsQuestionRepo::escape_fts5_query("NOT"), "\"NOT\"");
        // 内部双引号双写转义："hi" → """hi"""
        assert_eq!(
            VfsQuestionRepo::escape_fts5_query(r#"say "hi""#),
            r#""say" """hi""""#
        );
    }

    #[test]
    fn sanitize_search_keyword_trims_and_limits() {
        assert_eq!(
            VfsQuestionRepo::sanitize_search_keyword("  abc  "),
            Some("abc".to_string())
        );
        assert_eq!(VfsQuestionRepo::sanitize_search_keyword("   "), None);
        let long: String = "字".repeat(MAX_SEARCH_KEYWORD_LENGTH + 50);
        let sanitized = VfsQuestionRepo::sanitize_search_keyword(&long).unwrap();
        assert_eq!(sanitized.chars().count(), MAX_SEARCH_KEYWORD_LENGTH);
    }

    fn create_test_question(db: &VfsDatabase, id: &str) -> Question {
        let conn = db.get_conn_safe().expect("open migrated VFS test database");
        conn.execute(
            "INSERT INTO exam_sheets (
                id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at
             ) VALUES (?1, 'OCC test', 'completed', ?2, '{}', '{}', ?3, ?3)",
            params![
                format!("exam-{id}"),
                format!("temp-{id}"),
                "2020-01-01T00:00:00Z"
            ],
        )
        .expect("insert parent exam");
        drop(conn);

        let question = VfsQuestionRepo::create_question(
            db,
            &CreateQuestionParams {
                exam_id: format!("exam-{id}"),
                card_id: None,
                question_label: None,
                content: "original".to_string(),
                options: None,
                answer: None,
                explanation: None,
                structured_data: None,
                question_type: None,
                difficulty: None,
                tags: None,
                source_type: None,
                source_ref: None,
                images: None,
                parent_id: None,
            },
        )
        .expect("create question");

        let conn = db.get_conn_safe().expect("reopen VFS test database");
        conn.execute(
            "UPDATE questions SET updated_at = '2020-01-01T00:00:00Z' WHERE id = ?1",
            params![question.id],
        )
        .expect("set deterministic OCC baseline");
        VfsQuestionRepo::get_question_with_conn(&conn, &question.id)
            .expect("load question")
            .expect("question should exist")
    }

    #[test]
    fn list_mistakes_spans_live_exams_with_names_counts_and_sorting() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        {
            let conn = db.get_conn_safe().expect("open conn");
            for (id, name, deleted) in [
                ("exam-a", "高数", None),
                ("exam-b", "英语", None),
                ("exam-gone", "已删", Some("2026-10-02T00:00:00Z")),
            ] {
                conn.execute(
                    "INSERT INTO exam_sheets (
                        id, exam_name, status, temp_id, metadata_json, preview_json, created_at, updated_at, deleted_at
                     ) VALUES (?1, ?2, 'completed', ?3, '{}', '{}', ?4, ?4, ?5)",
                    params![id, name, format!("temp-{id}"), "2026-10-01T00:00:00Z", deleted],
                )
                .expect("insert exam");
            }
        }
        let make = |exam_id: &str,
                    content: &str,
                    status: &str,
                    attempts: i32,
                    correct: i32,
                    last: &str| {
            let question = VfsQuestionRepo::create_question(
                &db,
                &CreateQuestionParams {
                    exam_id: exam_id.to_string(),
                    card_id: None,
                    question_label: None,
                    content: content.to_string(),
                    options: None,
                    answer: None,
                    explanation: None,
                    structured_data: None,
                    question_type: None,
                    difficulty: None,
                    tags: None,
                    source_type: None,
                    source_ref: None,
                    images: None,
                    parent_id: None,
                },
            )
            .expect("create question");
            db.get_conn_safe()
                .expect("open conn")
                .execute(
                    "UPDATE questions SET status = ?1, attempt_count = ?2, correct_count = ?3, last_attempt_at = ?4
                     WHERE id = ?5",
                    params![status, attempts, correct, last, question.id],
                )
                .expect("set progress");
            question.id
        };
        let qa1 = make("exam-a", "极限定义", "review", 3, 0, "2026-10-03T00:00:00Z");
        let qa2 = make("exam-a", "导数", "review", 5, 1, "2026-10-01T00:00:00Z");
        make("exam-a", "已掌握", "mastered", 2, 1, "2026-10-04T00:00:00Z");
        let qa_deleted = make(
            "exam-a",
            "删掉的错题",
            "review",
            1,
            0,
            "2026-10-04T00:00:00Z",
        );
        let qb1 = make("exam-b", "完形填空", "review", 1, 0, "2026-10-04T00:00:00Z");
        make(
            "exam-gone",
            "题目集已删",
            "review",
            1,
            0,
            "2026-10-04T00:00:00Z",
        );
        {
            let conn = db.get_conn_safe().expect("open conn");
            conn.execute(
                "UPDATE questions SET deleted_at = '2026-10-04T00:00:00Z' WHERE id = ?1",
                params![qa_deleted],
            )
            .expect("delete question");
            conn.execute(
                "UPDATE questions SET tags = '[\"链式法则\"]' WHERE id = ?1",
                params![qa2],
            )
            .expect("tag question");
        }

        let ids = |result: &MistakeListResult| -> Vec<String> {
            result
                .items
                .iter()
                .map(|item| item.question.id.clone())
                .collect()
        };
        let list = |filters: MistakeListFilters, page: u32, page_size: u32| {
            VfsQuestionRepo::list_mistakes(&db, &filters, page, page_size).expect("list mistakes")
        };

        let recent = list(MistakeListFilters::default(), 1, 50);
        assert_eq!(ids(&recent), vec![qb1.clone(), qa1.clone(), qa2.clone()]);
        assert_eq!(recent.total, 3);
        assert_eq!(recent.items[0].exam_name.as_deref(), Some("英语"));
        assert_eq!(
            recent.exams,
            vec![
                MistakeExamCount {
                    exam_id: "exam-a".into(),
                    exam_name: Some("高数".into()),
                    count: 2
                },
                MistakeExamCount {
                    exam_id: "exam-b".into(),
                    exam_name: Some("英语".into()),
                    count: 1
                },
            ]
        );

        let by_errors = list(
            MistakeListFilters {
                sort: Some("errors".into()),
                ..Default::default()
            },
            1,
            50,
        );
        assert_eq!(ids(&by_errors), vec![qa2.clone(), qa1.clone(), qb1.clone()]);

        let only_a = list(
            MistakeListFilters {
                exam_id: Some("exam-a".into()),
                ..Default::default()
            },
            1,
            50,
        );
        assert_eq!(ids(&only_a), vec![qa1.clone(), qa2.clone()]);
        assert_eq!(only_a.exams.len(), 2, "exam counts ignore the exam filter");

        let by_tag = list(
            MistakeListFilters {
                search: Some("链式".into()),
                ..Default::default()
            },
            1,
            50,
        );
        assert_eq!(ids(&by_tag), vec![qa2.clone()]);

        let first = list(MistakeListFilters::default(), 1, 2);
        assert!(first.has_more);
        let second = list(MistakeListFilters::default(), 2, 2);
        assert_eq!(ids(&second), vec![qa2]);
        assert!(!second.has_more);
    }

    #[test]
    fn get_question_by_card_id_accepts_question_id_fallback() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();

        // AI 生成题没有 card_id，工具层会把 question id 当 card_id 回传
        let orphan = create_test_question(&db, "cardless");
        assert!(orphan.card_id.is_none());
        let found = VfsQuestionRepo::get_question_by_card_id(&db, &orphan.exam_id, &orphan.id)
            .expect("query by question id")
            .expect("card_id lookup should fall back to question id");
        assert_eq!(found.id, orphan.id);

        // 真实 card_id 查询行为保持不变
        let conn = db.get_conn_safe().expect("open conn");
        conn.execute(
            "UPDATE questions SET card_id = 'card-real' WHERE id = ?1",
            params![orphan.id],
        )
        .expect("assign card_id");
        drop(conn);
        let by_card = VfsQuestionRepo::get_question_by_card_id(&db, &orphan.exam_id, "card-real")
            .expect("query by card id")
            .expect("card_id lookup should still match real card_id");
        assert_eq!(by_card.id, orphan.id);

        // 跨题目集隔离：其他 exam 查不到
        let other = create_test_question(&db, "other-exam");
        assert!(
            VfsQuestionRepo::get_question_by_card_id(&db, &other.exam_id, &orphan.id)
                .expect("cross exam query")
                .is_none(),
            "question id from another exam must not resolve"
        );

        // 软删后不可查
        let conn = db.get_conn_safe().expect("open conn");
        conn.execute(
            "UPDATE questions SET deleted_at = '2021-01-01T00:00:00Z' WHERE id = ?1",
            params![orphan.id],
        )
        .expect("soft delete");
        drop(conn);
        assert!(
            VfsQuestionRepo::get_question_by_card_id(&db, &orphan.exam_id, &orphan.id)
                .expect("deleted query")
                .is_none(),
            "soft-deleted question must not resolve"
        );
    }

    #[test]
    fn update_question_occ_is_atomic_and_rejects_stale_writes() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let question = create_test_question(&db, "atomic");
        let baseline = question.updated_at.clone();

        let first = VfsQuestionRepo::update_question(
            &db,
            &question.id,
            &UpdateQuestionParams {
                content: Some("newer content".to_string()),
                expected_updated_at: Some(baseline.clone()),
                ..Default::default()
            },
        )
        .expect("matching OCC baseline should update");
        assert_eq!(first.content, "newer content");
        assert_ne!(first.updated_at, baseline);

        let stale_error = VfsQuestionRepo::update_question(
            &db,
            &question.id,
            &UpdateQuestionParams {
                content: Some("stale overwrite".to_string()),
                expected_updated_at: Some(baseline),
                ..Default::default()
            },
        )
        .expect_err("stale OCC baseline must conflict");
        assert!(stale_error.to_string().contains("QBANK_CONFLICT"));
        assert!(stale_error
            .to_string()
            .contains(&format!("actual_updated_at={}", first.updated_at)));

        let persisted = VfsQuestionRepo::get_question(&db, &question.id)
            .expect("reload question")
            .expect("question should remain live");
        assert_eq!(persisted.content, "newer content");
        assert_eq!(persisted.updated_at, first.updated_at);
    }

    #[test]
    fn concurrent_question_updates_allow_exactly_one_occ_winner() {
        use std::sync::{Arc, Barrier};

        let (temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        let question = create_test_question(&db, "concurrent");
        let db_path = temp_dir.path().join("databases").join("vfs.db");
        let barrier = Arc::new(Barrier::new(2));

        let handles: Vec<_> = ["writer-a", "writer-b"]
            .into_iter()
            .map(|content| {
                let db_path = db_path.clone();
                let question_id = question.id.clone();
                let expected = question.updated_at.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let conn = Connection::open(db_path).expect("open concurrent VFS connection");
                    conn.busy_timeout(std::time::Duration::from_secs(5))
                        .expect("configure SQLite busy timeout");
                    barrier.wait();
                    VfsQuestionRepo::update_question_with_conn(
                        &conn,
                        &question_id,
                        &UpdateQuestionParams {
                            content: Some(content.to_string()),
                            expected_updated_at: Some(expected),
                            ..Default::default()
                        },
                    )
                    .map(|updated| updated.content)
                    .map_err(|error| error.to_string())
                })
            })
            .collect();

        let outcomes: Vec<_> = handles
            .into_iter()
            .map(|handle| handle.join().expect("join concurrent writer"))
            .collect();
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        assert_eq!(
            outcomes
                .iter()
                .filter(|outcome| outcome
                    .as_ref()
                    .is_err_and(|error| error.contains("QBANK_CONFLICT")))
                .count(),
            1
        );

        let persisted = VfsQuestionRepo::get_question(&db, &question.id)
            .expect("reload concurrent question")
            .expect("concurrent question should exist");
        assert!(persisted.content == "writer-a" || persisted.content == "writer-b");
    }
    // ========================================================================
    // 题目导入 v2（issue 489/491）：题组/材料读取投影、作答快照、统计口径
    // ========================================================================

    fn insert_exam(conn: &Connection, exam_id: &str, resource_id: Option<&str>) {
        conn.execute(
            "INSERT INTO exam_sheets (
                id, resource_id, exam_name, status, temp_id, metadata_json, preview_json,
                created_at, updated_at
             ) VALUES (?1, ?2, ?1, 'completed', ?1, '{}', '{}', ?3, ?3)",
            params![exam_id, resource_id, "2026-10-23T00:00:00Z"],
        )
        .expect("insert exam");
    }

    fn seed_group_and_material(conn: &Connection, exam_id: &str) {
        let now = "2026-10-23T00:00:00Z";
        conn.execute(
            "INSERT INTO qbank_groups (id, exam_id, label, position, created_at, updated_at)
             VALUES ('g1', ?1, '阅读一', 0, ?2, ?2)",
            params![exam_id, now],
        )
        .expect("insert group");
        conn.execute(
            "INSERT INTO qbank_materials (
                id, exam_id, content, images_json, source_refs_json,
                local_version, created_at, updated_at
             ) VALUES ('m1', ?1, '共享文章正文', '[]', '[]', 3, ?2, ?2)",
            params![exam_id, now],
        )
        .expect("insert material");
        conn.execute(
            "INSERT INTO qbank_group_materials (
                id, exam_id, group_id, material_id, position, created_at, updated_at
             ) VALUES ('gm1', ?1, 'g1', 'm1', 0, ?2, ?2)",
            params![exam_id, now],
        )
        .expect("insert group material");
    }

    fn create_grouped_question(db: &VfsDatabase, exam_id: &str, content: &str) -> Question {
        let conn = db.get_conn_safe().expect("open conn");
        let question = VfsQuestionRepo::create_question_with_conn(
            &conn,
            &CreateQuestionParams {
                exam_id: exam_id.to_string(),
                content: content.to_string(),
                question_type: Some(QuestionType::ShortAnswer),
                ..Default::default()
            },
        )
        .expect("create question");
        conn.execute(
            "UPDATE questions SET group_id = 'g1', group_position = 0 WHERE id = ?1",
            params![question.id],
        )
        .expect("attach group");
        question
    }

    #[test]
    fn list_and_single_reads_hydrate_group_materials_without_duplicating_membership() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        {
            let conn = db.get_conn_safe().expect("open conn");
            insert_exam(&conn, "exam-hydrate", None);
            seed_group_and_material(&conn, "exam-hydrate");
        }
        create_grouped_question(&db, "exam-hydrate", "子题一");
        let created = VfsQuestionRepo::create_question_with_conn(
            &db.get_conn_safe().expect("open conn"),
            &CreateQuestionParams {
                exam_id: "exam-hydrate".to_string(),
                content: "子题二".to_string(),
                question_type: Some(QuestionType::ShortAnswer),
                ..Default::default()
            },
        )
        .expect("second question");
        db.get_conn_safe()
            .expect("open group connection")
            .execute(
                "UPDATE questions SET group_id='g1',group_position=1 WHERE id=?1",
                params![created.id],
            )
            .expect("attach second group member");

        let list = VfsQuestionRepo::list_questions(
            &db,
            "exam-hydrate",
            &QuestionFilters::default(),
            1,
            50,
        )
        .expect("list questions");
        assert_eq!(list.questions.len(), 2);
        let hydrated = list
            .questions
            .iter()
            .find(|q| q.id == created.id)
            .expect("second question in list");
        assert_eq!(hydrated.group_id.as_deref(), Some("g1"));
        assert_eq!(hydrated.group_label.as_deref(), Some("阅读一"));
        assert_eq!(hydrated.materials.len(), 1);
        assert_eq!(hydrated.materials[0].id, "m1");
        assert_eq!(hydrated.materials[0].version, 3);
        assert_eq!(hydrated.materials[0].content, "共享文章正文");

        let single = VfsQuestionRepo::get_question(&db, &created.id)
            .expect("get question")
            .expect("question exists");
        assert_eq!(
            single.materials.len(),
            1,
            "single read must hydrate materials"
        );
        assert_eq!(single.group_position, Some(1));

        // 成员关系只有 questions.group_id 一份权威：题组表没有 question_ids 列。
        let columns: Vec<String> = {
            let conn = db.get_conn_safe().expect("open conn");
            let mut stmt = conn
                .prepare("SELECT name FROM pragma_table_info('qbank_groups')")
                .expect("pragma");
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(0))
                .expect("rows");
            rows.filter_map(Result::ok).collect()
        };
        assert!(!columns.iter().any(|c| c == "question_ids"));
    }

    #[test]
    fn canonical_read_returns_all_questions_beyond_repo_page_cap() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        {
            let conn = db.get_conn_safe().expect("open conn");
            insert_exam(&conn, "exam-canonical", None);
            for index in 0..105 {
                conn.execute(
                    "INSERT INTO questions (
                        id, exam_id, content, question_type, tags, created_at, updated_at
                     ) VALUES (?1, 'exam-canonical', ?2, 'short_answer', '[]', ?3, ?3)",
                    params![
                        format!("q-canonical-{index:03}"),
                        format!("题目 {index}"),
                        "2026-10-23T00:00:00Z"
                    ],
                )
                .expect("insert question");
            }
        }
        let conn = db.get_conn_safe().expect("open conn");
        let questions = VfsQuestionRepo::canonical_questions_with_conn(&conn, "exam-canonical")
            .expect("canonical read");
        assert_eq!(
            questions.len(),
            105,
            "canonical read must paginate internally"
        );

        let text = VfsQuestionRepo::canonical_text_with_conn(&conn, "exam-canonical")
            .expect("canonical text");
        assert!(text.contains("题目 0"));
        assert!(text.contains("题目 104"));
    }

    #[test]
    fn count_by_type_excludes_soft_deleted_questions() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        {
            let conn = db.get_conn_safe().expect("open conn");
            insert_exam(&conn, "exam-count", None);
        }
        let question = VfsQuestionRepo::create_question(
            &db,
            &CreateQuestionParams {
                exam_id: "exam-count".to_string(),
                content: "选择题".to_string(),
                question_type: Some(QuestionType::SingleChoice),
                options: Some(vec![
                    QuestionOption {
                        key: "A".to_string(),
                        content: "甲".to_string(),
                    },
                    QuestionOption {
                        key: "B".to_string(),
                        content: "乙".to_string(),
                    },
                ]),
                ..Default::default()
            },
        )
        .expect("create question");

        let counts = VfsQuestionRepo::count_by_type(&db, "exam-count").expect("count");
        assert_eq!(counts.get("single_choice"), Some(&1));

        VfsQuestionRepo::delete_question(&db, &question.id).expect("soft delete");
        let counts = VfsQuestionRepo::count_by_type(&db, "exam-count").expect("count again");
        assert_eq!(
            counts.get("single_choice"),
            None,
            "soft-deleted questions must not inflate组卷余量"
        );
    }

    #[test]
    fn submission_freezes_question_and_material_snapshot_for_historical_review() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        {
            let conn = db.get_conn_safe().expect("open conn");
            insert_exam(&conn, "exam-snapshot", None);
            seed_group_and_material(&conn, "exam-snapshot");
        }
        let question = create_grouped_question(&db, "exam-snapshot", "子题快照");

        let submission_id = {
            let conn = db.get_conn_safe().expect("open conn");
            VfsQuestionRepo::insert_submission_with_conn(
                &conn,
                &question.id,
                "原文答案",
                Some(true),
                "auto",
                None,
            )
            .expect("insert submission")
        };

        let conn = db.get_conn_safe().expect("open conn");
        let snapshot = VfsQuestionRepo::get_submission_snapshot_with_conn(&conn, &submission_id)
            .expect("read snapshot")
            .expect("snapshot exists");
        let question_snapshot = snapshot
            .question_snapshot_json
            .expect("question snapshot auto-populated");
        assert!(question_snapshot.contains("子题快照"));
        assert!(question_snapshot.contains("\"material_ids\":[\"m1\"]"));
        let material_snapshot = snapshot
            .material_snapshot_json
            .expect("material snapshot auto-populated");
        assert!(material_snapshot.contains("共享文章正文"));

        // 材料之后被编辑，快照保持不变（历史判分可复核当时的条件）。
        conn.execute(
            "UPDATE qbank_materials SET content = '修订后的文章', local_version = 4 WHERE id = 'm1'",
            [],
        )
        .expect("edit material");
        let snapshot = VfsQuestionRepo::get_submission_snapshot_with_conn(&conn, &submission_id)
            .expect("read snapshot again")
            .expect("snapshot exists");
        assert!(snapshot
            .material_snapshot_json
            .expect("material snapshot")
            .contains("共享文章正文"));
    }

    #[test]
    fn question_mutation_marks_linked_resource_index_pending() {
        let (_temp_dir, db) = crate::vfs::database::setup_migrated_test_db();
        {
            let conn = db.get_conn_safe().expect("open conn");
            conn.execute(
                "INSERT INTO resources (
                    id, hash, type, storage_mode, ref_count, created_at, updated_at, index_state
                 ) VALUES ('res-index', 'hash-index', 'exam', 'managed', 1, 0, 0, 'indexed')",
                [],
            )
            .expect("insert resource");
            insert_exam(&conn, "exam-index", Some("res-index"));
        }
        let question = VfsQuestionRepo::create_question(
            &db,
            &CreateQuestionParams {
                exam_id: "exam-index".to_string(),
                content: "索引失效题目".to_string(),
                ..Default::default()
            },
        )
        .expect("create question");

        let conn = db.get_conn_safe().expect("open conn");
        let state: String = conn
            .query_row(
                "SELECT index_state FROM resources WHERE id = 'res-index'",
                [],
                |row| row.get(0),
            )
            .expect("read index state");
        assert_eq!(state, "pending");

        conn.execute(
            "UPDATE resources SET index_state = 'indexed' WHERE id = 'res-index'",
            [],
        )
        .expect("reset state");
        VfsQuestionRepo::delete_question_with_conn(&conn, &question.id).expect("delete question");
        let state: String = conn
            .query_row(
                "SELECT index_state FROM resources WHERE id = 'res-index'",
                [],
                |row| row.get(0),
            )
            .expect("read index state");
        assert_eq!(
            state, "pending",
            "deletion must invalidate canonical index too"
        );
    }
}
