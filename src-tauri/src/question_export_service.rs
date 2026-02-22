//! 题目导出服务 - CSV 导出功能
//!
//! 此模块提供题目集的 CSV 导出功能，包括：
//! - 基础导出：指定字段导出
//! - 筛选导出：按条件筛选后导出
//! - 含答题记录导出：包含学习进度数据
//!
//! ## 功能特性
//! - 支持 UTF-8 和 GBK 编码输出
//! - 流式写入支持大文件
//! - 可选字段导出

use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::{BufWriter, Write};

use crate::models::AppError;
use crate::vfs::database::VfsDatabase;
use crate::vfs::repos::{
    Difficulty, Question, QuestionFilters, QuestionStatus, QuestionType, VfsQuestionRepo,
};

/// 导出编码
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ExportEncoding {
    #[default]
    Utf8,
    Gbk,
    Utf8Bom,
}

/// 导出请求参数
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvExportRequest {
    /// 题目集 ID
    pub exam_id: String,
    /// 导出文件路径
    pub file_path: String,
    /// 要导出的字段列表（为空则导出所有）
    #[serde(default)]
    pub fields: Vec<String>,
    /// 筛选条件
    #[serde(default)]
    pub filters: QuestionFilters,
    /// 是否包含答题记录
    #[serde(default)]
    pub include_answers: bool,
    /// 输出编码
    #[serde(default)]
    pub encoding: ExportEncoding,
}

/// 导出结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CsvExportResult {
    /// 导出题目数
    pub exported_count: u32,
    /// 文件路径
    pub file_path: String,
    /// 文件大小（字节）
    pub file_size: u64,
}

/// 可导出的字段定义
pub const EXPORTABLE_FIELDS: &[(&str, &str)] = &[
    ("content", "题干内容"),
    ("question_type", "题目类型"),
    ("options", "选项"),
    ("answer", "答案"),
    ("explanation", "解析"),
    ("difficulty", "难度"),
    ("tags", "标签"),
    ("images", "关联图片"),
    ("question_label", "题号"),
    ("user_answer", "用户答案"),
    ("is_correct", "是否正确"),
    ("attempt_count", "答题次数"),
    ("correct_count", "正确次数"),
    ("status", "学习状态"),
    ("is_favorite", "收藏"),
    ("user_note", "笔记"),
    ("created_at", "创建时间"),
    ("updated_at", "更新时间"),
];

/// CSV 导出服务
pub struct CsvExportService;

impl CsvExportService {
    /// M-038: 校验文件路径，防止目录遍历攻击
    fn validate_file_path(path: &str) -> Result<(), AppError> {
        let p = std::path::Path::new(path);
        for component in p.components() {
            if component == std::path::Component::ParentDir {
                return Err(AppError::validation(
                    "路径不允许包含 '..' 目录遍历".to_string(),
                ));
            }
        }
        Ok(())
    }

    /// 获取可导出的字段列表
    pub fn get_exportable_fields() -> Vec<(String, String)> {
        EXPORTABLE_FIELDS
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    /// 导出 CSV
    pub fn export_csv(
        vfs_db: &VfsDatabase,
        request: &CsvExportRequest,
    ) -> Result<CsvExportResult, AppError> {
        log::info!(
            "[CsvExport] 开始导出 exam_id={} -> {}",
            request.exam_id,
            request.file_path
        );

        // 1. 获取题目列表
        let questions = Self::fetch_questions(vfs_db, &request.exam_id, &request.filters)?;

        if questions.is_empty() {
            return Err(AppError::validation("没有可导出的题目"));
        }

        // 2. 确定导出字段
        let fields = if request.fields.is_empty() {
            Self::get_default_fields(request.include_answers)
        } else {
            request.fields.clone()
        };

        // M-038: 校验路径，防止目录遍历
        Self::validate_file_path(&request.file_path)?;

        // 3. 创建文件并写入
        let file = File::create(&request.file_path)
            .map_err(|e| AppError::internal(format!("创建文件失败: {}", e)))?;
        let mut writer = BufWriter::new(file);

        // 写入 BOM（如果需要）
        if matches!(request.encoding, ExportEncoding::Utf8Bom) {
            writer
                .write_all(&[0xEF, 0xBB, 0xBF])
                .map_err(|e| AppError::internal(format!("写入 BOM 失败: {}", e)))?;
        }

        // 4. 写入表头
        let headers: Vec<String> = fields
            .iter()
            .map(|f| Self::get_field_display_name(f))
            .collect();
        Self::write_csv_row(&mut writer, &headers, &request.encoding)?;

        // 5. 写入数据行
        let mut exported_count = 0u32;
        for question in &questions {
            let row = Self::question_to_row(question, &fields);
            Self::write_csv_row(&mut writer, &row, &request.encoding)?;
            exported_count += 1;
        }

        // 6. 刷新缓冲区
        writer
            .flush()
            .map_err(|e| AppError::internal(format!("刷新文件缓冲区失败: {}", e)))?;

        // 7. 获取文件大小
        let file_size = std::fs::metadata(&request.file_path)
            .map(|m| m.len())
            .unwrap_or(0);

        log::info!(
            "[CsvExport] 导出完成: {} 道题目, {} 字节",
            exported_count,
            file_size
        );

        Ok(CsvExportResult {
            exported_count,
            file_path: request.file_path.clone(),
            file_size,
        })
    }

    /// 导出含答题记录的 CSV（便捷方法）
    pub fn export_csv_with_answers(
        vfs_db: &VfsDatabase,
        exam_id: &str,
        file_path: &str,
    ) -> Result<CsvExportResult, AppError> {
        let request = CsvExportRequest {
            exam_id: exam_id.to_string(),
            file_path: file_path.to_string(),
            fields: Self::get_default_fields(true),
            filters: QuestionFilters::default(),
            include_answers: true,
            encoding: ExportEncoding::Utf8Bom,
        };
        Self::export_csv(vfs_db, &request)
    }

    /// 获取默认导出字段
    fn get_default_fields(include_answers: bool) -> Vec<String> {
        let mut fields = vec![
            "content".to_string(),
            "question_type".to_string(),
            "options".to_string(),
            "answer".to_string(),
            "explanation".to_string(),
            "difficulty".to_string(),
            "tags".to_string(),
            "question_label".to_string(),
        ];

        if include_answers {
            fields.extend([
                "user_answer".to_string(),
                "is_correct".to_string(),
                "attempt_count".to_string(),
                "correct_count".to_string(),
                "status".to_string(),
            ]);
        }

        fields
    }

    /// 获取字段显示名称
    fn get_field_display_name(field: &str) -> String {
        EXPORTABLE_FIELDS
            .iter()
            .find(|(k, _)| *k == field)
            .map(|(_, v)| v.to_string())
            .unwrap_or_else(|| field.to_string())
    }

    /// 获取题目列表
    fn fetch_questions(
        vfs_db: &VfsDatabase,
        exam_id: &str,
        filters: &QuestionFilters,
    ) -> Result<Vec<Question>, AppError> {
        let mut all_questions = Vec::new();
        let page_size = 100u32;
        let mut page = 1u32;

        loop {
            let result = VfsQuestionRepo::list_questions(vfs_db, exam_id, filters, page, page_size)
                .map_err(|e| AppError::database(format!("获取题目失败: {}", e)))?;

            all_questions.extend(result.questions);

            if !result.has_more {
                break;
            }
            page += 1;
        }

        Ok(all_questions)
    }

    /// 将题目转换为 CSV 行
    fn question_to_row(question: &Question, fields: &[String]) -> Vec<String> {
        fields
            .iter()
            .map(|field| Self::get_field_value(question, field))
            .collect()
    }

    /// 获取题目字段值
    fn get_field_value(question: &Question, field: &str) -> String {
        match field {
            "content" => question.content.clone(),
            "question_type" => Self::format_question_type(&question.question_type),
            "options" => Self::format_options(&question.options),
            "answer" => question.answer.clone().unwrap_or_default(),
            "explanation" => question.explanation.clone().unwrap_or_default(),
            "difficulty" => question
                .difficulty
                .as_ref()
                .map(|d| Self::format_difficulty(d))
                .unwrap_or_default(),
            "tags" => question.tags.join(","),
            "question_label" => question.question_label.clone().unwrap_or_default(),
            "user_answer" => question.user_answer.clone().unwrap_or_default(),
            "is_correct" => question
                .is_correct
                .map(|b| if b { "正确" } else { "错误" }.to_string())
                .unwrap_or_default(),
            "attempt_count" => question.attempt_count.to_string(),
            "correct_count" => question.correct_count.to_string(),
            "status" => Self::format_status(&question.status),
            "is_favorite" => if question.is_favorite { "是" } else { "否" }.to_string(),
            "user_note" => question.user_note.clone().unwrap_or_default(),
            "created_at" => question.created_at.clone(),
            "updated_at" => question.updated_at.clone(),
            "images" => {
                if question.images.is_empty() {
                    String::new()
                } else {
                    question
                        .images
                        .iter()
                        .map(|img| img.name.clone())
                        .collect::<Vec<_>>()
                        .join("; ")
                }
            }
            _ => String::new(),
        }
    }

    /// 格式化题目类型
    fn format_question_type(qt: &QuestionType) -> String {
        match qt {
            QuestionType::SingleChoice => "单选题",
            QuestionType::MultipleChoice => "多选题",
            QuestionType::IndefiniteChoice => "不定项选择题",
            QuestionType::FillBlank => "填空题",
            QuestionType::ShortAnswer => "简答题",
            QuestionType::Essay => "论述题",
            QuestionType::Calculation => "计算题",
            QuestionType::Proof => "证明题",
            QuestionType::Other => "其他",
        }
        .to_string()
    }

    /// 格式化难度
    fn format_difficulty(d: &Difficulty) -> String {
        match d {
            Difficulty::Easy => "简单",
            Difficulty::Medium => "中等",
            Difficulty::Hard => "困难",
            Difficulty::VeryHard => "极难",
        }
        .to_string()
    }

    /// 格式化状态
    fn format_status(s: &QuestionStatus) -> String {
        match s {
            QuestionStatus::New => "新题",
            QuestionStatus::InProgress => "学习中",
            QuestionStatus::Mastered => "已掌握",
            QuestionStatus::Review => "需复习",
        }
        .to_string()
    }

    /// 格式化选项
    fn format_options(options: &Option<Vec<crate::vfs::repos::QuestionOption>>) -> String {
        match options {
            Some(opts) if !opts.is_empty() => opts
                .iter()
                .map(|o| format!("{}. {}", o.key, o.content))
                .collect::<Vec<_>>()
                .join("; "),
            _ => String::new(),
        }
    }

    /// 写入 CSV 行
    fn write_csv_row<W: Write>(
        writer: &mut W,
        row: &[String],
        encoding: &ExportEncoding,
    ) -> Result<(), AppError> {
        let csv_line = row
            .iter()
            .map(|cell| Self::escape_csv_cell(cell))
            .collect::<Vec<_>>()
            .join(",")
            + "\n";

        let bytes = match encoding {
            ExportEncoding::Utf8 | ExportEncoding::Utf8Bom => csv_line.into_bytes(),
            ExportEncoding::Gbk => {
                let (encoded, _, _) = encoding_rs::GBK.encode(&csv_line);
                encoded.into_owned()
            }
        };

        writer
            .write_all(&bytes)
            .map_err(|e| AppError::internal(format!("写入 CSV 行失败: {}", e)))
    }

    /// 转义 CSV 单元格（含 OWASP 公式注入防护）
    fn escape_csv_cell(cell: &str) -> String {
        let mut value = cell.to_string();

        // OWASP CSV Injection: 以危险前缀开头的单元格需要前缀 tab 字符中和公式解析
        // 覆盖半角和全角变体: = + - @ \t \r \n ＝ ＋ － ＠
        let first_char = value.chars().next();
        let is_formula_prefix = matches!(
            first_char,
            Some('=' | '+' | '-' | '@' | '\t' | '\r' | '\n'
                | '\u{FF1D}' | '\u{FF0B}' | '\u{FF0D}' | '\u{FF20}')
        );
        if is_formula_prefix {
            value = format!("\t{}", value);
        }

        let needs_quote = value.contains(',')
            || value.contains('"')
            || value.contains('\n')
            || value.contains('\r')
            || is_formula_prefix;

        if needs_quote {
            format!("\"{}\"", value.replace('"', "\"\""))
        } else {
            value
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_escape_csv_cell() {
        assert_eq!(CsvExportService::escape_csv_cell("hello"), "hello");
        assert_eq!(
            CsvExportService::escape_csv_cell("hello,world"),
            "\"hello,world\""
        );
        assert_eq!(
            CsvExportService::escape_csv_cell("say \"hi\""),
            "\"say \"\"hi\"\"\""
        );
        assert_eq!(
            CsvExportService::escape_csv_cell("line1\nline2"),
            "\"line1\nline2\""
        );
    }

    #[test]
    fn test_escape_csv_formula_injection() {
        // OWASP CSV Injection: dangerous prefixes get tab-prefixed and quoted
        assert_eq!(CsvExportService::escape_csv_cell("=1+2"), "\"\t=1+2\"");
        assert_eq!(CsvExportService::escape_csv_cell("+1+2"), "\"\t+1+2\"");
        assert_eq!(CsvExportService::escape_csv_cell("-1+2"), "\"\t-1+2\"");
        assert_eq!(CsvExportService::escape_csv_cell("@SUM(A1)"), "\"\t@SUM(A1)\"");
        // Fullwidth variants
        assert_eq!(CsvExportService::escape_csv_cell("\u{FF1D}CMD"), "\"\t\u{FF1D}CMD\"");
        // Safe content stays unchanged
        assert_eq!(CsvExportService::escape_csv_cell("normal text"), "normal text");
        assert_eq!(CsvExportService::escape_csv_cell("100"), "100");
    }

    #[test]
    fn test_format_options() {
        use crate::vfs::repos::QuestionOption;

        let options = Some(vec![
            QuestionOption {
                key: "A".to_string(),
                content: "选项A".to_string(),
            },
            QuestionOption {
                key: "B".to_string(),
                content: "选项B".to_string(),
            },
        ]);

        let formatted = CsvExportService::format_options(&options);
        assert_eq!(formatted, "A. 选项A; B. 选项B");
    }
}
