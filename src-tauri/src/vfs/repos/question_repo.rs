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

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::borrow::Cow;
use tracing::{debug, info, warn};

use crate::question_sync_service::QuestionSyncService;
use crate::vfs::database::VfsDatabase;
use crate::vfs::error::{VfsError, VfsResult};

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
            QuestionType::Other => "other",
        }
    }

    pub fn from_str(s: &str) -> Self {
        match s {
            "single_choice" => QuestionType::SingleChoice,
            "multiple_choice" => QuestionType::MultipleChoice,
            "indefinite_choice" => QuestionType::IndefiniteChoice,
            "fill_blank" => QuestionType::FillBlank,
            "short_answer" => QuestionType::ShortAnswer,
            "essay" => QuestionType::Essay,
            "calculation" => QuestionType::Calculation,
            "proof" => QuestionType::Proof,
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
}

/// 题目实体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    pub id: String,
    pub exam_id: String,
    pub card_id: Option<String>,
    pub question_label: Option<String>,
    pub content: String,
    pub options: Option<Vec<QuestionOption>>,
    pub answer: Option<String>,
    pub explanation: Option<String>,
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
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateQuestionParams {
    pub exam_id: String,
    pub card_id: Option<String>,
    pub question_label: Option<String>,
    pub content: String,
    pub options: Option<Vec<QuestionOption>>,
    pub answer: Option<String>,
    pub explanation: Option<String>,
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
    /// FTS5 使用以下特殊字符：
    /// - 双引号 (") 用于短语搜索
    /// - 星号 (*) 用于前缀搜索
    /// - 括号 () 用于分组
    /// - AND, OR, NOT 作为布尔运算符
    /// - 连字符 (-) 用于排除
    /// - 冒号 (:) 用于列限定
    fn escape_fts5_query(keyword: &str) -> Cow<'_, str> {
        // 检查是否需要转义
        let needs_escape = keyword
            .chars()
            .any(|c| matches!(c, '"' | '*' | '(' | ')' | '-' | ':' | '^' | '+' | '~'))
            || keyword.contains("AND")
            || keyword.contains("OR")
            || keyword.contains("NOT");

        if !needs_escape {
            return Cow::Borrowed(keyword);
        }

        // 用双引号包围整个搜索词，并转义内部的双引号
        let escaped = keyword.replace('"', "\"\"");
        Cow::Owned(format!("\"{}\"", escaped))
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

        // DRY: 复用已构建的 params_vec（添加 FTS keyword 前缀），避免 3 次重复构建
        let build_fts_params = |keyword: &str,
                                filters: &QuestionSearchFilters,
                                exam_id: Option<&str>|
         -> Vec<Box<dyn rusqlite::ToSql>> {
            let mut p: Vec<Box<dyn rusqlite::ToSql>> = vec![Box::new(keyword.to_string())];
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
            if let Some(is_fav) = filters.base.is_favorite {
                p.push(Box::new(if is_fav { 1 } else { 0 }));
            }
            if let Some(is_bm) = filters.base.is_bookmarked {
                p.push(Box::new(if is_bm { 1 } else { 0 }));
            }
            p
        };

        let count_params_vec = build_fts_params(&escaped_keyword, filters, exam_id);
        let count_refs: Vec<&dyn rusqlite::ToSql> =
            count_params_vec.iter().map(|p| p.as_ref()).collect();
        let total: i64 = conn
            .query_row(&count_sql, count_refs.as_slice(), |row| row.get(0))
            .unwrap_or(0);

        // 8. 查询数据（带高亮和相关性分数）
        let query_sql = format!(
            r#"
            SELECT
                q.id, q.exam_id, q.card_id, q.question_label, q.content, q.options_json,
                q.answer, q.explanation, q.question_type, q.difficulty, q.tags,
                q.status, q.user_answer, q.is_correct, q.attempt_count, q.correct_count,
                q.last_attempt_at, q.user_note, q.is_favorite, q.is_bookmarked,
                q.source_type, q.source_ref, q.images_json, q.parent_id, q.created_at, q.updated_at,
                q.ai_feedback, q.ai_score, q.ai_graded_at,
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

            // 解析高亮和分数字段（索引 29-32，ai_feedback/ai_score/ai_graded_at 在 26-28）
            let hl_content: Option<String> = row.get(29)?;
            let hl_answer: Option<String> = row.get(30)?;
            let hl_explanation: Option<String> = row.get(31)?;
            let relevance: f64 = row.get(32)?;

            Ok(QuestionSearchResult {
                question,
                highlight_content: hl_content,
                highlight_answer: hl_answer,
                highlight_explanation: hl_explanation,
                relevance_score: relevance,
            })
        })?;

        let results: Vec<QuestionSearchResult> = rows.filter_map(log_and_skip_err).collect();
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
        let like_pattern = format!("%{}%", keyword);

        // 构建 WHERE 子句
        let mut conditions = vec![
            "deleted_at IS NULL".to_string(),
            "(content LIKE ?1 OR answer LIKE ?1 OR explanation LIKE ?1 OR tags LIKE ?1)"
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
                   ai_feedback, ai_score, ai_graded_at
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

        let results: Vec<QuestionSearchResult> = rows.filter_map(log_and_skip_err).collect();
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
    pub fn rebuild_fts_index_with_conn(conn: &Connection) -> VfsResult<u64> {
        info!("[VFS::QuestionRepo] Rebuilding FTS5 index...");

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

        info!(
            "[VFS::QuestionRepo] FTS5 index rebuilt, {} records indexed",
            count
        );

        Ok(count as u64)
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
            if !search.is_empty() {
                if use_fts5 {
                    // FTS5 搜索：通过 rowid 关联
                    let sanitized =
                        Self::sanitize_search_keyword(search).unwrap_or_else(|| search.to_string());
                    let escaped = Self::escape_fts5_query(&sanitized);
                    conditions.push(format!(
                        "rowid IN (SELECT rowid FROM questions_fts WHERE questions_fts MATCH ?{})",
                        param_idx
                    ));
                    params_vec.push(Box::new(escaped.into_owned()));
                    param_idx += 1;
                } else {
                    // 回退到 LIKE 搜索（搜索 content, answer, explanation, tags）
                    conditions.push(format!(
                        "(content LIKE ?{} OR answer LIKE ?{} OR explanation LIKE ?{} OR tags LIKE ?{})",
                        param_idx, param_idx, param_idx, param_idx
                    ));
                    params_vec.push(Box::new(format!("%{}%", search)));
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
                   ai_feedback, ai_score, ai_graded_at
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

        let questions: Vec<Question> = rows.filter_map(log_and_skip_err).collect();
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
                   ai_feedback, ai_score, ai_graded_at
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
        let questions: Vec<Question> = rows.filter_map(log_and_skip_err).collect();

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
                   ai_feedback, ai_score, ai_graded_at
            FROM questions
            WHERE id = ?1 AND deleted_at IS NULL
            "#,
        )?;

        let question = stmt
            .query_row(params![question_id], Self::row_to_question)
            .optional()?;

        Ok(question)
    }

    /// 根据 card_id 获取题目
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
                   ai_feedback, ai_score, ai_graded_at
            FROM questions
            WHERE exam_id = ?1 AND card_id = ?2 AND deleted_at IS NULL
            "#,
        )?;

        let question = stmt
            .query_row(params![exam_id, card_id], Self::row_to_question)
            .optional()?;

        Ok(question)
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

        conn.execute(
            r#"
            INSERT INTO questions (
                id, exam_id, card_id, question_label, content, options_json,
                answer, explanation, question_type, difficulty, tags,
                status, source_type, source_ref, images_json, parent_id, created_at, updated_at
            ) VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18
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
            ],
        )?;

        info!("[VFS::QuestionRepo] Created question id={}", id);

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
        let mut set_clauses = vec!["updated_at = ?1".to_string()];
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

        let sql = format!(
            "UPDATE questions SET {} WHERE id = ?{}",
            set_clauses.join(", "),
            param_idx
        );
        param_values.push(Box::new(question_id.to_string()));

        let params_refs: Vec<&dyn rusqlite::ToSql> =
            param_values.iter().map(|p| p.as_ref()).collect();
        let affected = conn.execute(&sql, params_refs.as_slice())?;

        if affected == 0 {
            return Err(VfsError::NotFound {
                resource_type: "question".to_string(),
                id: question_id.to_string(),
            });
        }

        debug!("[VFS::QuestionRepo] Updated question id={}", question_id);

        // ★ S-030: 标记为已修改，更新同步状态
        QuestionSyncService::mark_as_modified_with_conn(conn, question_id)?;

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
        conn.execute(
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

        debug!(
            "[VFS::QuestionRepo] Submitted answer for question id={}, is_correct={:?}, manual={}",
            question_id, is_correct, needs_manual_grading
        );

        // ★ S-030: 答题记录变更也触发同步标记
        QuestionSyncService::mark_as_modified_with_conn(conn, question_id)?;

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
            for id in question_ids {
                let affected = conn.execute(
                    "UPDATE questions SET deleted_at = ?1, updated_at = ?1 WHERE id = ?2 AND deleted_at IS NULL",
                    params![now, id],
                )?;
                deleted += affected;
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
        let stats: (i32, i32, i32, i32, i32, i32, i32) = conn.query_row(
            r#"
            SELECT
                COUNT(*) as total,
                SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as new_count,
                SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) as in_progress,
                SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) as mastered,
                SUM(CASE WHEN status = 'review' THEN 1 ELSE 0 END) as review,
                SUM(attempt_count) as total_attempts,
                SUM(correct_count) as total_correct
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
                    row.get::<_, i32>(5).unwrap_or(0),
                    row.get::<_, i32>(6).unwrap_or(0),
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
    ) -> VfsResult<String> {
        let conn = db.get_conn_safe()?;
        Self::insert_submission_with_conn(
            &conn,
            question_id,
            user_answer,
            is_correct,
            grading_method,
        )
    }

    /// 记录一条作答提交（使用现有连接）
    pub fn insert_submission_with_conn(
        conn: &Connection,
        question_id: &str,
        user_answer: &str,
        is_correct: Option<bool>,
        grading_method: &str,
    ) -> VfsResult<String> {
        let id = format!("as_{}", nanoid::nanoid!(10));
        let now = chrono::Utc::now().to_rfc3339();
        let is_correct_val = is_correct.map(|v| if v { 1 } else { 0 });

        conn.execute(
            r#"
            INSERT INTO answer_submissions (id, question_id, user_answer, is_correct, grading_method, submitted_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            "#,
            params![id, question_id, user_answer, is_correct_val, grading_method, now],
        )?;

        debug!(
            "[VFS::QuestionRepo] Inserted submission id={} for question={}",
            id, question_id
        );

        Ok(id)
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
        let deleted = conn.execute(
            "DELETE FROM answer_submissions WHERE question_id = ?1",
            params![question_id],
        )?;
        Ok(deleted)
    }

    /// 删除某题目集下所有题目的作答记录（重置整个题目集进度时调用）
    pub fn delete_submissions_by_exam(db: &VfsDatabase, exam_id: &str) -> VfsResult<usize> {
        let conn = db.get_conn_safe()?;
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

        Ok(Question {
            id: row.get(0)?,
            exam_id: row.get(1)?,
            card_id: row.get(2)?,
            question_label: row.get(3)?,
            content: row.get(4)?,
            options,
            answer: row.get(6)?,
            explanation: row.get(7)?,
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
        })
    }
}
