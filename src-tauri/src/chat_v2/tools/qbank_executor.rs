use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::time::Instant;

use async_trait::async_trait;
use serde_json::{json, Value};
use std::sync::LazyLock;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

use super::arg_utils::{ensure_localized_error, with_localized_message};
use super::executor::{ExecutionContext, ToolConcurrency, ToolExecutor, ToolSensitivity};
use super::strip_tool_namespace;
use crate::chat_v2::types::{ToolCall, ToolResultInfo};
use crate::models::{
    ExamCardPreview, ExamSheetPreviewPage, ExamSheetPreviewResult, QuestionBankStats,
    QuestionStatus as ModelsQuestionStatus, QuestionType, SourceType,
};
use crate::qbank_grading::events::QbankGradingEmitter;
use crate::qbank_grading::pipeline::{run_qbank_grading, QbankGradingDeps};
use crate::qbank_grading::types::{QbankGradingMode, QbankGradingRequest};
use crate::question_bank_service::{
    GeneratedPaper, MockExamConfig, MockExamSession, PaperConfig, PaperExportFormat,
    QuestionBankService,
};
use crate::vfs::repos::{
    CreateQuestionParams, Difficulty, Question, QuestionFilters, QuestionImage, QuestionOption,
    QuestionSearchFilters, QuestionStatus, QuestionType as RepoQuestionType, SearchSortBy,
    SourceType as RepoSourceType, UpdateQuestionParams, VfsExamRepo, VfsQuestionRepo,
};

static QBANK_WRITE_LOCK: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));

fn qbank_error(code: &str, message: impl Into<String>, hint: &str) -> String {
    let message = message.into();
    with_localized_message(
        json!({
            "code": code,
            "hint": hint,
            "hintFallback": {
                "zh-CN": hint,
                "en-US": "Review the structured error code and correct the request before retrying."
            },
            "retryable": false,
        }),
        "chat.tools.qbank.error",
        json!({ "code": code, "detail": message }),
        message,
        format!("Question bank operation failed ({code})."),
    )
    .to_string()
}

fn qbank_conflict_error(
    message: impl Into<String>,
    hint: impl Into<String>,
    current: Value,
) -> String {
    let message = message.into();
    let hint = hint.into();
    with_localized_message(
        json!({
            "code": "QBANK_CONFLICT",
            "hint": hint,
            "hintFallback": {
                "zh-CN": hint,
                "en-US": "Read the current question state and plan the change again; do not retry with a guessed revision."
            },
            "retryable": false,
            "current": current,
        }),
        "chat.tools.qbank.error",
        json!({ "code": "QBANK_CONFLICT", "detail": message }),
        message,
        "Question bank conflict. Read the current value before retrying.",
    )
    .to_string()
}

fn localized_qbank_failure(error: impl Into<String>) -> String {
    ensure_localized_error(
        error,
        "QBANK_OPERATION_FAILED",
        "chat.tools.qbank.error",
        "题库操作失败",
        "The question-bank operation failed.",
    )
}

fn expected_qbank_revision(args: &Value) -> Result<String, String> {
    args.get("expected_updated_at")
        .or_else(|| args.get("expectedUpdatedAt"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            qbank_error(
                "QBANK_OCC_REQUIRED",
                "更新题目前必须提供 expected_updated_at",
                "先调用 qbank_get_question，原样传入其 updated_at 后再更新",
            )
        })
}

fn required_non_empty_string(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            qbank_error(
                "INVALID_ARGS",
                format!("{key} 必须是非空字符串"),
                "修正参数后重试",
            )
        })
}

fn optional_string(args: &Value, key: &str, max_chars: usize) -> Result<Option<String>, String> {
    let Some(value) = args.get(key) else {
        return Ok(None);
    };
    let value = value.as_str().ok_or_else(|| {
        qbank_error(
            "INVALID_ARGS",
            format!("{key} 必须是字符串"),
            "修正参数后重试",
        )
    })?;
    if value.chars().count() > max_chars {
        return Err(qbank_error(
            "INVALID_ARGS",
            format!("{key} 超过 {max_chars} 字符上限"),
            "缩短内容后重试",
        ));
    }
    Ok(Some(value.to_string()))
}

fn parse_string_array(
    value: &Value,
    field: &str,
    max_items: usize,
    max_chars: usize,
) -> Result<Vec<String>, String> {
    let items = value.as_array().ok_or_else(|| {
        qbank_error(
            "INVALID_ARGS",
            format!("{field} 必须是字符串数组"),
            "修正参数后重试",
        )
    })?;
    if items.len() > max_items {
        return Err(qbank_error(
            "INVALID_ARGS",
            format!("{field} 最多包含 {max_items} 项"),
            "缩小批次后重试",
        ));
    }

    let mut result = Vec::with_capacity(items.len());
    let mut seen = HashSet::new();
    for (index, item) in items.iter().enumerate() {
        let item = item
            .as_str()
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    format!("{field}[{index}] 必须是非空字符串"),
                    "修正参数后重试",
                )
            })?;
        if item.chars().count() > max_chars {
            return Err(qbank_error(
                "INVALID_ARGS",
                format!("{field}[{index}] 超过 {max_chars} 字符上限"),
                "缩短该项后重试",
            ));
        }
        if seen.insert(item.to_string()) {
            result.push(item.to_string());
        }
    }
    Ok(result)
}

fn parse_question_options(value: &Value) -> Result<Vec<QuestionOption>, String> {
    let options = value.as_array().ok_or_else(|| {
        qbank_error(
            "INVALID_ARGS",
            "options 必须是结构化数组",
            "每项格式为 {key,content}",
        )
    })?;
    if options.len() > 26 {
        return Err(qbank_error(
            "INVALID_ARGS",
            "options 最多包含 26 项",
            "缩减选项后重试",
        ));
    }

    let mut parsed = Vec::with_capacity(options.len());
    let mut keys = HashSet::new();
    for (index, option) in options.iter().enumerate() {
        let object = option.as_object().ok_or_else(|| {
            qbank_error(
                "INVALID_ARGS",
                format!("options[{index}] 必须是对象"),
                "每项格式为 {key,content}",
            )
        })?;
        let key = object
            .get("key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    format!("options[{index}].key 必须是非空字符串"),
                    "修正选项后重试",
                )
            })?;
        let content = object
            .get("content")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    format!("options[{index}].content 必须是非空字符串"),
                    "修正选项后重试",
                )
            })?;
        if !keys.insert(key.to_string()) {
            return Err(qbank_error(
                "INVALID_ARGS",
                format!("options 包含重复 key: {key}"),
                "每个选项 key 必须唯一",
            ));
        }
        parsed.push(QuestionOption {
            key: key.to_string(),
            content: content.to_string(),
        });
    }
    Ok(parsed)
}

fn parse_repo_question_type(value: &Value, field: &str) -> Result<RepoQuestionType, String> {
    serde_json::from_value(value.clone()).map_err(|_| {
        qbank_error(
            "INVALID_ARGS",
            format!("{field} 是不支持的题型"),
            "使用 single_choice/multiple_choice/indefinite_choice/fill_blank/true_false/matching/ordering/numeric/short_answer/essay/calculation/proof/other",
        )
    })
}

/// 题型是否支持 structured_data（新题型契约，见 question_repo.rs）
fn question_type_supports_structured_data(question_type: &RepoQuestionType) -> bool {
    matches!(
        question_type,
        RepoQuestionType::FillBlank
            | RepoQuestionType::Matching
            | RepoQuestionType::Ordering
            | RepoQuestionType::Numeric
    )
}

/// 题型是否必须携带 structured_data（matching/ordering/numeric 没有它无法判分）
fn question_type_requires_structured_data(question_type: &RepoQuestionType) -> bool {
    matches!(
        question_type,
        RepoQuestionType::Matching | RepoQuestionType::Ordering | RepoQuestionType::Numeric
    )
}

fn structured_key_content_entries(
    value: &Value,
    field: &str,
    max_items: usize,
) -> Result<Vec<String>, String> {
    let items = value.as_array().ok_or_else(|| {
        qbank_error(
            "INVALID_ARGS",
            format!("{field} 必须是 {{key,content}} 对象数组"),
            "修正 structured_data 后重试",
        )
    })?;
    if items.is_empty() || items.len() > max_items {
        return Err(qbank_error(
            "INVALID_ARGS",
            format!("{field} 必须包含 1..={max_items} 项"),
            "修正 structured_data 后重试",
        ));
    }
    let mut keys = Vec::with_capacity(items.len());
    let mut seen = HashSet::new();
    for (index, item) in items.iter().enumerate() {
        let object = item.as_object().ok_or_else(|| {
            qbank_error(
                "INVALID_ARGS",
                format!("{field}[{index}] 必须是对象"),
                "每项格式为 {key,content}",
            )
        })?;
        let key = object
            .get("key")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|key| !key.is_empty())
            .ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    format!("{field}[{index}].key 必须是非空字符串"),
                    "修正 structured_data 后重试",
                )
            })?;
        let content_valid = object
            .get("content")
            .and_then(Value::as_str)
            .map(str::trim)
            .is_some_and(|content| !content.is_empty());
        if !content_valid {
            return Err(qbank_error(
                "INVALID_ARGS",
                format!("{field}[{index}].content 必须是非空字符串"),
                "修正 structured_data 后重试",
            ));
        }
        if !seen.insert(key.to_string()) {
            return Err(qbank_error(
                "INVALID_ARGS",
                format!("{field} 包含重复 key: {key}"),
                "每项 key 必须唯一",
            ));
        }
        keys.push(key.to_string());
    }
    Ok(keys)
}

/// 校验 structured_data 与 question_type 的匹配性（只校验形状，判分逻辑在 question_bank_service）。
/// 错误信息面向 LLM：指出具体字段与期望格式。
fn validate_structured_data(
    question_type: &RepoQuestionType,
    data: &Value,
) -> Result<(), String> {
    if !question_type_supports_structured_data(question_type) {
        return Err(qbank_error(
            "INVALID_ARGS",
            format!(
                "题型 {} 不支持 structured_data",
                serde_json::to_value(question_type)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_string))
                    .unwrap_or_else(|| "unknown".to_string())
            ),
            "只有 fill_blank/matching/ordering/numeric 支持 structured_data；其他题型请移除该字段",
        ));
    }
    let serialized_len = serde_json::to_string(data)
        .map(|text| text.chars().count())
        .unwrap_or(usize::MAX);
    if serialized_len > 20_000 {
        return Err(qbank_error(
            "INVALID_ARGS",
            "structured_data 序列化后超过 20000 字符上限",
            "缩减 structured_data 内容后重试",
        ));
    }
    let object = data.as_object().ok_or_else(|| {
        qbank_error(
            "INVALID_ARGS",
            "structured_data 必须是 JSON 对象",
            "按对应题型格式传入对象",
        )
    })?;

    match question_type {
        RepoQuestionType::FillBlank => {
            let blanks = object
                .get("blanks")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    qbank_error(
                        "INVALID_ARGS",
                        "fill_blank 的 structured_data 缺少 blanks 数组",
                        r#"格式：{"blanks":[{"answers":["答案1","答案2"],"case_sensitive":false,"trim":true}]}，blanks 顺序与题干 ____ 空位一一对应"#,
                    )
                })?;
            if blanks.is_empty() || blanks.len() > 50 {
                return Err(qbank_error(
                    "INVALID_ARGS",
                    "blanks 必须包含 1..=50 个空位",
                    "修正 blanks 后重试",
                ));
            }
            for (index, blank) in blanks.iter().enumerate() {
                let blank = blank.as_object().ok_or_else(|| {
                    qbank_error(
                        "INVALID_ARGS",
                        format!("blanks[{index}] 必须是对象"),
                        r#"每个空位格式：{"answers":[...],"case_sensitive"?:bool,"trim"?:bool}"#,
                    )
                })?;
                let answers = blank
                    .get("answers")
                    .and_then(Value::as_array)
                    .filter(|answers| !answers.is_empty() && answers.len() <= 20)
                    .ok_or_else(|| {
                        qbank_error(
                            "INVALID_ARGS",
                            format!("blanks[{index}].answers 必须是 1..=20 项的非空数组"),
                            "answers 列出该空位所有可接受答案",
                        )
                    })?;
                for (answer_index, answer) in answers.iter().enumerate() {
                    let valid = answer
                        .as_str()
                        .map(str::trim)
                        .is_some_and(|text| !text.is_empty() && text.chars().count() <= 500);
                    if !valid {
                        return Err(qbank_error(
                            "INVALID_ARGS",
                            format!(
                                "blanks[{index}].answers[{answer_index}] 必须是 1..=500 字符的非空字符串"
                            ),
                            "修正答案文本后重试",
                        ));
                    }
                }
                for key in ["case_sensitive", "trim"] {
                    if let Some(flag) = blank.get(key) {
                        if !flag.is_boolean() {
                            return Err(qbank_error(
                                "INVALID_ARGS",
                                format!("blanks[{index}].{key} 必须是布尔值"),
                                "修正后重试",
                            ));
                        }
                    }
                }
            }
        }
        RepoQuestionType::Matching => {
            let left_keys = structured_key_content_entries(
                object.get("left").unwrap_or(&Value::Null),
                "structured_data.left",
                26,
            )?;
            let right_keys = structured_key_content_entries(
                object.get("right").unwrap_or(&Value::Null),
                "structured_data.right",
                26,
            )?;
            let pairs = object
                .get("pairs")
                .and_then(Value::as_array)
                .filter(|pairs| !pairs.is_empty())
                .ok_or_else(|| {
                    qbank_error(
                        "INVALID_ARGS",
                        "matching 的 structured_data 缺少非空 pairs 数组",
                        r#"格式：{"left":[{"key","content"}],"right":[...],"pairs":[{"left":"L1","right":"R2"}]}"#,
                    )
                })?;
            let left_set: HashSet<&str> = left_keys.iter().map(String::as_str).collect();
            let right_set: HashSet<&str> = right_keys.iter().map(String::as_str).collect();
            let mut paired_left = HashSet::new();
            for (index, pair) in pairs.iter().enumerate() {
                let pair = pair.as_object().ok_or_else(|| {
                    qbank_error(
                        "INVALID_ARGS",
                        format!("pairs[{index}] 必须是对象"),
                        r#"每项格式：{"left":"左侧key","right":"右侧key"}"#,
                    )
                })?;
                let left = pair.get("left").and_then(Value::as_str).unwrap_or("");
                let right = pair.get("right").and_then(Value::as_str).unwrap_or("");
                if !left_set.contains(left) {
                    return Err(qbank_error(
                        "INVALID_ARGS",
                        format!("pairs[{index}].left 引用了不存在的左侧 key: {left}"),
                        "pairs 中的 left/right 必须引用 left/right 数组中的 key",
                    ));
                }
                if !right_set.contains(right) {
                    return Err(qbank_error(
                        "INVALID_ARGS",
                        format!("pairs[{index}].right 引用了不存在的右侧 key: {right}"),
                        "pairs 中的 left/right 必须引用 left/right 数组中的 key",
                    ));
                }
                if !paired_left.insert(left.to_string()) {
                    return Err(qbank_error(
                        "INVALID_ARGS",
                        format!("pairs 中左侧 key {left} 出现多次"),
                        "每个左侧 key 至多配对一次",
                    ));
                }
            }
        }
        RepoQuestionType::Ordering => {
            let item_keys = structured_key_content_entries(
                object.get("items").unwrap_or(&Value::Null),
                "structured_data.items",
                50,
            )?;
            let correct_order = object
                .get("correct_order")
                .and_then(Value::as_array)
                .ok_or_else(|| {
                    qbank_error(
                        "INVALID_ARGS",
                        "ordering 的 structured_data 缺少 correct_order 数组",
                        r#"格式：{"items":[{"key","content"}],"correct_order":["K2","K1",...]}，correct_order 必须是 items key 的一个排列"#,
                    )
                })?;
            let order_keys: Vec<&str> = correct_order
                .iter()
                .filter_map(Value::as_str)
                .collect();
            if order_keys.len() != correct_order.len() {
                return Err(qbank_error(
                    "INVALID_ARGS",
                    "correct_order 必须全部是字符串 key",
                    "修正 correct_order 后重试",
                ));
            }
            let mut expected: Vec<&str> = item_keys.iter().map(String::as_str).collect();
            let mut actual = order_keys.clone();
            expected.sort_unstable();
            actual.sort_unstable();
            if expected != actual {
                return Err(qbank_error(
                    "INVALID_ARGS",
                    "correct_order 必须恰好是 items 中所有 key 的一个排列",
                    "检查 correct_order 是否遗漏、重复或引用了不存在的 key",
                ));
            }
        }
        RepoQuestionType::Numeric => {
            if !object
                .get("answer_value")
                .map(Value::is_number)
                .unwrap_or(false)
            {
                return Err(qbank_error(
                    "INVALID_ARGS",
                    "numeric 的 structured_data 缺少数值 answer_value",
                    r#"格式：{"answer_value":3.14,"tolerance":0.01,"unit":"m","tolerance_mode":"absolute"}"#,
                ));
            }
            if let Some(tolerance) = object.get("tolerance") {
                let valid = tolerance.as_f64().is_some_and(|value| value >= 0.0);
                if !valid {
                    return Err(qbank_error(
                        "INVALID_ARGS",
                        "tolerance 必须是 >= 0 的数值",
                        "修正容差后重试",
                    ));
                }
            }
            if let Some(mode) = object.get("tolerance_mode") {
                if !matches!(mode.as_str(), Some("absolute") | Some("relative")) {
                    return Err(qbank_error(
                        "INVALID_ARGS",
                        "tolerance_mode 只能是 absolute 或 relative",
                        "修正容差模式后重试",
                    ));
                }
            }
            if let Some(unit) = object.get("unit") {
                let valid = unit
                    .as_str()
                    .is_some_and(|text| text.chars().count() <= 50);
                if !valid {
                    return Err(qbank_error(
                        "INVALID_ARGS",
                        "unit 必须是不超过 50 字符的字符串",
                        "修正单位后重试",
                    ));
                }
            }
        }
        _ => unreachable!("guarded by question_type_supports_structured_data"),
    }
    Ok(())
}

/// 读取并校验可选的 structured_data 参数；matching/ordering/numeric 缺失时给出必填错误。
fn parse_structured_data_arg(
    args: &Value,
    question_type: &RepoQuestionType,
    required_when_missing: bool,
) -> Result<Option<Value>, String> {
    match args.get("structured_data") {
        Some(Value::Null) | None => {
            if required_when_missing && question_type_requires_structured_data(question_type) {
                return Err(qbank_error(
                    "INVALID_ARGS",
                    "matching/ordering/numeric 题型必须提供 structured_data",
                    r#"matching 需 {"left","right","pairs"}；ordering 需 {"items","correct_order"}；numeric 需 {"answer_value","tolerance"?,"unit"?,"tolerance_mode"?}"#,
                ));
            }
            Ok(None)
        }
        Some(data) => {
            validate_structured_data(question_type, data)?;
            Ok(Some(data.clone()))
        }
    }
}

/// true_false 题的标准答案必须是 "true"/"false"（user_answer 亦同）。
fn validate_true_false_answer(answer: &str) -> Result<(), String> {
    if matches!(answer.trim(), "true" | "false") {
        Ok(())
    } else {
        Err(qbank_error(
            "INVALID_ARGS",
            format!("true_false 题的答案必须是 \"true\" 或 \"false\"，收到: {answer}"),
            "使用小写字符串 true/false 表示判断题答案",
        ))
    }
}

fn parse_difficulty(value: &Value, field: &str) -> Result<Difficulty, String> {
    serde_json::from_value(value.clone()).map_err(|_| {
        qbank_error(
            "INVALID_ARGS",
            format!("{field} 是不支持的难度"),
            "使用 easy/medium/hard/very_hard",
        )
    })
}

fn parse_status(value: &Value, field: &str) -> Result<QuestionStatus, String> {
    serde_json::from_value(value.clone()).map_err(|_| {
        qbank_error(
            "INVALID_ARGS",
            format!("{field} 是不支持的学习状态"),
            "使用 new/in_progress/mastered/review",
        )
    })
}

fn read_strict_u32(
    args: &Value,
    key: &str,
    default: u32,
    min: u32,
    max: u32,
) -> Result<u32, String> {
    let Some(value) = args.get(key) else {
        return Ok(default);
    };
    let raw = value.as_u64().ok_or_else(|| {
        qbank_error(
            "INVALID_ARGS",
            format!("{key} 必须是整数"),
            "修正参数后重试",
        )
    })?;
    if raw < min as u64 || raw > max as u64 {
        return Err(qbank_error(
            "INVALID_ARGS",
            format!("{key} 必须在 {min}..={max} 范围内"),
            "修正参数后重试",
        ));
    }
    Ok(raw as u32)
}

fn read_bool(args: &Value, key: &str, default: bool) -> Result<bool, String> {
    match args.get(key) {
        None => Ok(default),
        Some(value) => value.as_bool().ok_or_else(|| {
            qbank_error(
                "INVALID_ARGS",
                format!("{key} 必须是布尔值"),
                "修正参数后重试",
            )
        }),
    }
}

fn parse_count_map(
    value: Option<&Value>,
    field: &str,
    allowed_keys: &[&str],
    max_total: u32,
) -> Result<HashMap<String, u32>, String> {
    let Some(value) = value else {
        return Ok(HashMap::new());
    };
    let object = value.as_object().ok_or_else(|| {
        qbank_error(
            "INVALID_ARGS",
            format!("{field} 必须是对象"),
            "使用名称到题数的映射",
        )
    })?;
    let mut result = HashMap::new();
    let mut total = 0u32;
    for (key, value) in object {
        if !allowed_keys.contains(&key.as_str()) {
            return Err(qbank_error(
                "INVALID_ARGS",
                format!("{field} 包含不支持的键: {key}"),
                "修正分布配置后重试",
            ));
        }
        let count = value.as_u64().filter(|count| *count > 0).ok_or_else(|| {
            qbank_error(
                "INVALID_ARGS",
                format!("{field}.{key} 必须是正整数"),
                "修正分布配置后重试",
            )
        })?;
        let count = u32::try_from(count).map_err(|_| {
            qbank_error(
                "INVALID_ARGS",
                format!("{field}.{key} 数值过大"),
                "缩小题数后重试",
            )
        })?;
        total = total.checked_add(count).ok_or_else(|| {
            qbank_error(
                "INVALID_ARGS",
                format!("{field} 总题数溢出"),
                "缩小题数后重试",
            )
        })?;
        if total > max_total {
            return Err(qbank_error(
                "INVALID_ARGS",
                format!("{field} 总题数不能超过 {max_total}"),
                "缩小题数后重试",
            ));
        }
        result.insert(key.clone(), count);
    }
    Ok(result)
}

fn parse_iso_date(args: &Value, key: &str) -> Result<chrono::NaiveDate, String> {
    let raw = required_non_empty_string(args, key)?;
    chrono::NaiveDate::parse_from_str(&raw, "%Y-%m-%d").map_err(|_| {
        qbank_error(
            "INVALID_ARGS",
            format!("{key} 必须使用 YYYY-MM-DD 格式"),
            "修正日期后重试",
        )
    })
}

fn safe_file_component(value: &str) -> String {
    let mut result = String::new();
    let mut previous_separator = false;
    for ch in value.chars().take(80) {
        if ch.is_alphanumeric() || matches!(ch, '-' | '_') {
            result.push(ch);
            previous_separator = false;
        } else if !previous_separator {
            result.push('_');
            previous_separator = true;
        }
    }
    let result = result.trim_matches('_');
    if result.is_empty() {
        "qbank-paper".to_string()
    } else {
        result.to_string()
    }
}

fn bounded_text(value: &str, max_chars: usize) -> (String, bool) {
    let mut chars = value.chars();
    let bounded: String = chars.by_ref().take(max_chars).collect();
    let truncated = chars.next().is_some();
    (bounded, truncated)
}

fn truncate_json_strings(value: &mut Value, path: &str, fields_truncated: &mut Vec<String>) {
    match value {
        Value::String(text) => {
            let (bounded, truncated) = bounded_text(text, 2_000);
            if truncated {
                *text = bounded;
                fields_truncated.push(path.to_string());
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter_mut().enumerate() {
                let item_path = format!("{path}[{index}]");
                truncate_json_strings(item, &item_path, fields_truncated);
            }
        }
        Value::Object(object) => {
            for (key, child) in object.iter_mut() {
                let child_path = if path.is_empty() {
                    key.clone()
                } else {
                    format!("{path}.{key}")
                };
                truncate_json_strings(child, &child_path, fields_truncated);
            }
        }
        _ => {}
    }
}

fn question_to_bounded_value(question: &Question) -> Value {
    let mut value = serde_json::to_value(question).unwrap_or_else(|_| {
        json!({
            "id": question.id,
            "exam_id": question.exam_id,
        })
    });
    let Some(object) = value.as_object_mut() else {
        return value;
    };
    let mut fields_truncated = Vec::new();

    for field in [
        "content",
        "answer",
        "explanation",
        "user_note",
        "ai_feedback",
    ] {
        let Some(text) = object.get(field).and_then(Value::as_str) else {
            continue;
        };
        let (bounded, truncated) = bounded_text(text, 2_000);
        if truncated {
            object.insert(field.to_string(), Value::String(bounded));
            object.insert(format!("{field}_truncated"), Value::Bool(true));
            fields_truncated.push(field.to_string());
        }
    }

    if let Some(options) = object.get_mut("options").and_then(Value::as_array_mut) {
        for (index, option) in options.iter_mut().enumerate() {
            let Some(option) = option.as_object_mut() else {
                continue;
            };
            let Some(content) = option.get("content").and_then(Value::as_str) else {
                continue;
            };
            let (bounded, truncated) = bounded_text(content, 2_000);
            if truncated {
                option.insert("content".to_string(), Value::String(bounded));
                option.insert("content_truncated".to_string(), Value::Bool(true));
                fields_truncated.push(format!("options[{index}].content"));
            }
        }
    }
    truncate_json_strings(&mut value, "", &mut fields_truncated);
    fields_truncated.sort();
    fields_truncated.dedup();
    let Some(object) = value.as_object_mut() else {
        return value;
    };
    object.insert("fieldsTruncated".to_string(), json!(fields_truncated));
    value
}

fn bounded_optional_text(value: Option<&str>) -> Value {
    match value {
        Some(value) => {
            let (text, truncated) = bounded_text(value, 2_000);
            json!({ "text": text, "truncated": truncated })
        }
        None => Value::Null,
    }
}

fn render_paper_markdown(paper: &GeneratedPaper) -> String {
    let mut output = String::new();
    output.push_str("# ");
    output.push_str(&paper.title);
    output.push_str("\n\n");
    output.push_str(&format!(
        "> 题目集：{}  |  题数：{}  |  生成时间：{}\n\n",
        paper.exam_id,
        paper.questions.len(),
        paper.created_at
    ));

    for (index, question) in paper.questions.iter().enumerate() {
        output.push_str(&format!("## {}. {}\n\n", index + 1, question.content));
        if let Some(options) = &question.options {
            for option in options {
                output.push_str(&format!("- **{}**. {}\n", option.key, option.content));
            }
            if !options.is_empty() {
                output.push('\n');
            }
        }
        if let Some(answer) = &question.answer {
            output.push_str(&format!("**答案：** {}\n\n", answer));
        }
        if let Some(explanation) = &question.explanation {
            output.push_str(&format!("**解析：** {}\n\n", explanation));
        }
    }
    output
}

fn write_markdown_paper(paper: &GeneratedPaper, export_dir: &Path) -> Result<String, String> {
    std::fs::create_dir_all(export_dir).map_err(|error| {
        qbank_error(
            "QBANK_EXPORT_FAILED",
            format!("无法创建题库导出目录: {error}"),
            "检查应用数据目录权限后重试",
        )
    })?;
    let filename = format!(
        "{}-{}.md",
        safe_file_component(&paper.title),
        safe_file_component(&paper.id)
    );
    let path = export_dir.join(filename);
    let temporary_path = path.with_extension("md.tmp");
    std::fs::write(&temporary_path, render_paper_markdown(paper)).map_err(|error| {
        qbank_error(
            "QBANK_EXPORT_FAILED",
            format!("写入 Markdown 试卷失败: {error}"),
            "检查磁盘空间和应用数据目录权限后重试",
        )
    })?;
    std::fs::rename(&temporary_path, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary_path);
        qbank_error(
            "QBANK_EXPORT_FAILED",
            format!("提交 Markdown 试卷文件失败: {error}"),
            "检查应用数据目录权限后重试",
        )
    })?;
    Ok(path.to_string_lossy().into_owned())
}

/// Persist an export before reporting it to the Agent. Tool results contain only a bounded
/// preview so a large question bank never becomes chat context.
fn write_qbank_export(
    ctx: &ExecutionContext,
    name: &str,
    extension: &str,
    bytes: &[u8],
) -> Result<String, String> {
    let app_data_dir = ctx
        .window_ref()
        .app_handle()
        .path()
        .app_data_dir()
        .map_err(|error| {
            qbank_error(
                "QBANK_EXPORT_FAILED",
                format!("无法解析应用数据目录: {error}"),
                "重新打开应用后重试",
            )
        })?;
    let export_dir = app_data_dir.join("exports").join("qbank");
    std::fs::create_dir_all(&export_dir).map_err(|error| {
        qbank_error(
            "QBANK_EXPORT_FAILED",
            format!("无法创建题库导出目录: {error}"),
            "检查应用数据目录权限后重试",
        )
    })?;
    let filename = format!(
        "{}-{}.{}",
        safe_file_component(name),
        uuid::Uuid::new_v4(),
        extension
    );
    let path = export_dir.join(filename);
    let temporary_path = path.with_extension(format!("{extension}.tmp"));
    std::fs::write(&temporary_path, bytes).map_err(|error| {
        qbank_error(
            "QBANK_EXPORT_FAILED",
            format!("写入题库导出文件失败: {error}"),
            "检查磁盘空间和应用数据目录权限后重试",
        )
    })?;
    std::fs::rename(&temporary_path, &path).map_err(|error| {
        let _ = std::fs::remove_file(&temporary_path);
        qbank_error(
            "QBANK_EXPORT_FAILED",
            format!("提交题库导出文件失败: {error}"),
            "检查应用数据目录权限后重试",
        )
    })?;
    Ok(path.to_string_lossy().into_owned())
}

fn bounded_export_preview(questions: &[Value]) -> Vec<Value> {
    questions
        .iter()
        .take(20)
        .cloned()
        .map(|mut question| {
            let mut fields_truncated = Vec::new();
            truncate_json_strings(&mut question, "", &mut fields_truncated);
            if let Some(object) = question.as_object_mut() {
                object.insert("fieldsTruncated".to_string(), json!(fields_truncated));
            }
            question
        })
        .collect()
}

fn render_question_export_markdown(name: &str, questions: &[Value]) -> String {
    let mut markdown = format!("# {name}\n\n");
    for (index, question) in questions.iter().enumerate() {
        markdown.push_str(&format!("## 题目 {}\n\n", index + 1));
        markdown.push_str(&format!(
            "**题干**\n{}\n\n",
            question
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("")
        ));
        if let Some(answer) = question.get("answer").and_then(Value::as_str) {
            markdown.push_str(&format!("**答案**\n{answer}\n\n"));
        }
        if let Some(explanation) = question.get("explanation").and_then(Value::as_str) {
            markdown.push_str(&format!("**解析**\n{explanation}\n\n"));
        }
        markdown.push_str("---\n\n");
    }
    markdown
}

fn render_question_export_docx(name: &str, questions: &[Value]) -> Result<Vec<u8>, String> {
    use crate::document_parser::DocumentParser;

    let mut blocks = Vec::new();
    for (index, question) in questions.iter().enumerate() {
        blocks
            .push(json!({ "type": "heading", "level": 2, "text": format!("题目 {}", index + 1) }));
        if let Some(content) = question.get("content").and_then(Value::as_str) {
            blocks.push(json!({ "type": "paragraph", "text": content }));
        }
        if let Some(answer) = question.get("answer").and_then(Value::as_str) {
            blocks.push(
                json!({ "type": "paragraph", "text": format!("答案：{answer}"), "bold": true }),
            );
        }
        if let Some(explanation) = question.get("explanation").and_then(Value::as_str) {
            blocks.push(json!({ "type": "paragraph", "text": format!("解析：{explanation}"), "italic": true }));
        }
    }
    DocumentParser::generate_docx_from_spec(&json!({ "title": name, "blocks": blocks }))
        .map_err(|error| format!("DOCX 生成失败: {error}"))
}

fn parse_question_images(value: &Value) -> Result<Vec<QuestionImage>, String> {
    let images = value.as_array().ok_or_else(|| {
        qbank_error(
            "INVALID_ARGS",
            "images 必须是结构化附件数组",
            "每项至少包含非空字符串 id；只有显式空数组才表示清空图片",
        )
    })?;

    images
        .iter()
        .enumerate()
        .map(|(index, image)| {
            let object = image.as_object().ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    format!("images[{index}] 必须是对象"),
                    "每项格式为 {id,name?,mime?,hash?}",
                )
            })?;
            if let Some(unknown) = object
                .keys()
                .find(|key| !matches!(key.as_str(), "id" | "name" | "mime" | "hash"))
            {
                return Err(qbank_error(
                    "INVALID_ARGS",
                    format!("images[{index}] 包含未知字段 {unknown}"),
                    "每项仅允许 {id,name?,mime?,hash?}",
                ));
            }
            let id = object
                .get("id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|id| !id.is_empty())
                .ok_or_else(|| {
                    qbank_error(
                        "INVALID_ARGS",
                        format!("images[{index}].id 必须是非空字符串"),
                        "修正附件描述后重试；无效项不会被忽略或用于清空图片",
                    )
                })?
                .to_string();
            let optional_string = |key: &str, default: &str| -> Result<String, String> {
                match object.get(key) {
                    None => Ok(default.to_string()),
                    Some(value) => value.as_str().map(str::to_string).ok_or_else(|| {
                        qbank_error(
                            "INVALID_ARGS",
                            format!("images[{index}].{key} 必须是字符串"),
                            "修正附件描述后重试；无效项不会被忽略或用于清空图片",
                        )
                    }),
                }
            };
            Ok(QuestionImage {
                id,
                name: optional_string("name", "")?,
                mime: optional_string("mime", "image/png")?,
                hash: optional_string("hash", "")?,
            })
        })
        .collect()
}

fn parse_qbank_grading_mode(args: &Value) -> Result<QbankGradingMode, String> {
    match args.get("mode").and_then(Value::as_str).unwrap_or("grade") {
        "grade" => Ok(QbankGradingMode::Grade),
        "analyze" => Ok(QbankGradingMode::Analyze),
        other => Err(qbank_error(
            "INVALID_ARGS",
            format!("不支持的 AI 评判模式: {other}"),
            "mode 只能是 grade 或 analyze",
        )),
    }
}

/// R1-04 / R2-01 / docs/dev/acr/DESIGN.md §5.6：题库写操作成功后通知前端刷新。
fn emit_qbank_changed(ctx: &ExecutionContext, action: &str, entity_ids: &[String]) {
    // ACR 4.0：域事件 source 统一为 "agent"（前端 normalize 仍双认 "ai" 兼容旧持久化事件）
    let payload = json!({
        "source": "agent",
        "action": action,
        "entityIds": entity_ids,
        "runId": ctx.run_id(),
    });
    if let Err(e) = ctx.window_ref().emit("qbank://changed", payload) {
        log::debug!("[QBankExecutor] Failed to emit qbank://changed: {}", e);
    }
}

/// 🆕 2026-01 改造：优先使用 QuestionBankService 查询 questions 表
/// 如果服务不可用或迁移未完成，回退到解析 preview_json
fn check_answer_correctness(
    user_answer: &str,
    correct_answer: &str,
    question_type: &Option<QuestionType>,
) -> bool {
    let normalize = |s: &str| {
        s.trim()
            .to_lowercase()
            .chars()
            .filter(|c| !c.is_whitespace())
            .collect::<String>()
    };
    let normalize_choice = |s: &str| {
        s.to_uppercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>()
    };

    match question_type {
        Some(QuestionType::MultipleChoice) => {
            let mut user_chars: Vec<char> = normalize_choice(user_answer).chars().collect();
            let mut correct_chars: Vec<char> = normalize_choice(correct_answer).chars().collect();
            user_chars.sort();
            correct_chars.sort();
            user_chars == correct_chars
        }
        Some(QuestionType::SingleChoice) => {
            normalize_choice(user_answer) == normalize_choice(correct_answer)
        }
        _ => normalize(user_answer) == normalize(correct_answer),
    }
}

pub struct QBankExecutor;

impl QBankExecutor {
    pub fn new() -> Self {
        Self
    }

    fn read_bounded_u32(args: &Value, key: &str, default: u32, min: u32, max: u32) -> u32 {
        let raw = args
            .get(key)
            .and_then(|v| v.as_i64())
            .unwrap_or(default as i64);
        let normalized = if raw < min as i64 { min } else { raw as u32 };
        normalized.clamp(min, max)
    }

    fn read_non_negative_u32(args: &Value, key: &str, default: u32) -> u32 {
        let raw = args
            .get(key)
            .and_then(|v| v.as_i64())
            .unwrap_or(default as i64);
        if raw < 0 {
            default
        } else {
            raw as u32
        }
    }

    fn require_service<'a>(
        &self,
        ctx: &'a ExecutionContext,
    ) -> Result<&'a QuestionBankService, String> {
        ctx.question_bank_service.as_deref().ok_or_else(|| {
            qbank_error(
                "QBANK_SERVICE_UNAVAILABLE",
                "QuestionBankService 未初始化",
                "重新打开应用后重试",
            )
        })
    }

    /// 用 question_id 或 session_id+card_id 定位一道 questions 表题目
    fn resolve_question(
        &self,
        service: &QuestionBankService,
        args: &Value,
    ) -> Result<Question, String> {
        let question = if let Some(question_id) = args
            .get("question_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            service
                .get_question(question_id)
                .map_err(|error| error.to_string())?
        } else {
            let exam_id = required_non_empty_string(args, "session_id")?;
            let card_id = required_non_empty_string(args, "card_id")?;
            service
                .get_question_by_card_id(&exam_id, &card_id)
                .map_err(|error| error.to_string())?
        };
        question.ok_or_else(|| {
            qbank_error(
                "QBANK_QUESTION_NOT_FOUND",
                "找不到指定题目",
                "传 question_id，或同时传 session_id 与 card_id；先用 qbank_list_questions 确认题目存在",
            )
        })
    }

    fn page_bounds(args: &Value, total: usize) -> Result<(u32, u32, usize, usize), String> {
        let page = read_strict_u32(args, "page", 1, 1, u32::MAX)?;
        let page_size = read_strict_u32(args, "page_size", 20, 1, 20)?;
        let start = (page as usize - 1).saturating_mul(page_size as usize);
        let end = start.saturating_add(page_size as usize).min(total);
        Ok((page, page_size, start.min(total), end))
    }

    fn practice_handoff(exam_id: &str, mode: &str, session: Value) -> Result<Value, String> {
        if !matches!(mode, "timed" | "mock_exam" | "daily") {
            return Err(qbank_error(
                "INVALID_ARGS",
                format!("不支持的练习 handoff mode: {mode}"),
                "mode 仅支持 timed、mock_exam 或 daily",
            ));
        }
        let handoff_id = session
            .get("id")
            .or_else(|| session.get("date"))
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .ok_or_else(|| {
                qbank_error(
                    "QBANK_HANDOFF_INVALID",
                    "练习会话缺少稳定 id/date",
                    "重新生成练习会话后再打开题库 UI",
                )
            })?;
        Ok(json!({
            "version": 1,
            "kind": "qbank_practice_session",
            "handoff_id": handoff_id,
            "exam_id": exam_id,
            "mode": mode,
            "session": session,
            "agentCanAnswer": false,
        }))
    }

    fn practice_workbench_action(exam_id: &str, handoff: &Value) -> Value {
        json!({
            "tool": "builtin-workbench_app_command",
            "executed": false,
            "payloadHydrationSupported": true,
            "arguments": {
                "typeId": "exam",
                "instanceKey": exam_id,
                "action": "hydratePracticeSession",
                "payload": { "handoff": handoff },
            },
        })
    }

    /// 读取全部题目（自动分页）
    fn list_all_questions(
        &self,
        service: &QuestionBankService,
        session_id: &str,
        filters: &QuestionFilters,
    ) -> Result<Vec<Question>, String> {
        let mut page = 1;
        let page_size = 200;
        let mut all = Vec::new();

        loop {
            let result = service
                .list_questions(session_id, filters, page, page_size)
                .map_err(|e| format!("Failed to list questions: {}", e))?;
            all.extend(result.questions);
            if !result.has_more {
                break;
            }
            page = page.saturating_add(1);
            if page > 10_000 {
                log::warn!(
                    "[QBankExecutor] list_all_questions exceeded page limit, session_id={}",
                    session_id
                );
                break;
            }
        }

        Ok(all)
    }

    /// 列出所有题目集（不需要 session_id）
    async fn execute_list(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<Value, String> {
        let limit = Self::read_bounded_u32(&call.arguments, "limit", 20, 1, 20);
        let offset = Self::read_non_negative_u32(&call.arguments, "offset", 0);
        let search = call.arguments.get("search").and_then(|v| v.as_str());
        let include_stats = call
            .arguments
            .get("include_stats")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let total = VfsExamRepo::count_exam_sheets(vfs_db, search)
            .map_err(|e| format!("Failed to count exam sheets: {}", e))?;
        let exams = VfsExamRepo::list_exam_sheets(vfs_db, search, limit, offset)
            .map_err(|e| format!("Failed to list exam sheets: {}", e))?;

        let question_banks: Vec<Value> = exams
            .iter()
            .map(|exam| {
                let mut bank = json!({
                    "session_id": exam.id,
                    "name": exam.exam_name.clone().unwrap_or_else(|| "未命名题目集".to_string()),
                    "status": exam.status,
                    "created_at": exam.created_at,
                    "updated_at": exam.updated_at,
                    "is_favorite": exam.is_favorite,
                });

                if include_stats {
                    let mut stats_set = false;

                    if let Some(service) = &ctx.question_bank_service {
                        match service.get_stats(&exam.id) {
                            Ok(Some(stats)) => {
                                bank["stats"] = json!({
                                    "total": stats.total_count,
                                    "mastered": stats.mastered_count,
                                    "review": stats.review_count,
                                    "in_progress": stats.in_progress_count,
                                    "new": stats.new_count,
                                    "correct_rate": stats.correct_rate,
                                });
                                stats_set = true;
                            }
                            _ => {
                                if let Ok(stats) = service.refresh_stats(&exam.id) {
                                    bank["stats"] = json!({
                                        "total": stats.total_count,
                                        "mastered": stats.mastered_count,
                                        "review": stats.review_count,
                                        "in_progress": stats.in_progress_count,
                                        "new": stats.new_count,
                                        "correct_rate": stats.correct_rate,
                                    });
                                    stats_set = true;
                                }
                            }
                        }
                    }

                    if !stats_set {
                        if let Ok(preview) = serde_json::from_value::<ExamSheetPreviewResult>(
                            exam.preview_json.clone(),
                        ) {
                            let mut total = 0;
                            let mut mastered = 0;
                            let mut review = 0;
                            let mut in_progress = 0;
                            let mut new_count = 0;
                            let mut total_attempts = 0;
                            let mut total_correct = 0;

                            for page in &preview.pages {
                                for card in &page.cards {
                                    total += 1;
                                    match &card.status {
                                        ModelsQuestionStatus::Mastered => mastered += 1,
                                        ModelsQuestionStatus::Review => review += 1,
                                        ModelsQuestionStatus::InProgress => in_progress += 1,
                                        ModelsQuestionStatus::New => new_count += 1,
                                    }
                                    total_attempts += card.attempt_count;
                                    total_correct += card.correct_count;
                                }
                            }

                            let correct_rate = if total_attempts > 0 {
                                (total_correct as f64) / (total_attempts as f64)
                            } else {
                                0.0
                            };

                            bank["stats"] = json!({
                                "total": total,
                                "mastered": mastered,
                                "review": review,
                                "in_progress": in_progress,
                                "new": new_count,
                                "correct_rate": correct_rate,
                                "source": "preview_json",
                                "degraded": true
                            });
                        }
                    }
                }

                bank
            })
            .collect();

        let returned = question_banks.len();
        let has_more = offset.saturating_add(returned as u32) < total;
        Ok(json!({
            "total": total,
            "question_banks": question_banks,
            "limit": limit,
            "offset": offset,
            "has_more": has_more,
            "truncated": has_more,
        }))
    }

    /// 🆕 2026-01 改造：优先使用 QuestionBankService 查询 questions 表
    async fn execute_list_questions(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;

        let status_filter = call.arguments.get("status").and_then(|v| v.as_str());
        let difficulty_filter = call.arguments.get("difficulty").and_then(|v| v.as_str());
        let tags_filter: Option<Vec<String>> = call
            .arguments
            .get("tags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(String::from))
                    .collect()
            });
        let page = Self::read_bounded_u32(&call.arguments, "page", 1, 1, u32::MAX);
        let page_size = Self::read_bounded_u32(&call.arguments, "page_size", 20, 1, 20);

        // 🆕 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            // 将字符串转换为枚举类型
            let status_enum: Option<Vec<QuestionStatus>> = status_filter.and_then(|s| {
                serde_json::from_value(serde_json::json!(s))
                    .ok()
                    .map(|v| vec![v])
            });
            let difficulty_enum: Option<Vec<Difficulty>> = difficulty_filter.and_then(|d| {
                serde_json::from_value(serde_json::json!(d))
                    .ok()
                    .map(|v| vec![v])
            });

            let filters = QuestionFilters {
                status: status_enum,
                difficulty: difficulty_enum,
                tags: tags_filter.clone(),
                ..Default::default()
            };

            match service.list_questions(session_id, &filters, page, page_size) {
                Ok(result) => {
                    let questions: Vec<Value> = result
                        .questions
                        .iter()
                        .map(|q| {
                            json!({
                                "card_id": q.card_id.clone().unwrap_or_else(|| q.id.clone()),
                                "label": q.question_label,
                                "content_preview": q.content.chars().take(100).collect::<String>(),
                                "status": q.status,
                                "difficulty": q.difficulty,
                                "tags": q.tags,
                                "attempt_count": q.attempt_count,
                                "correct_count": q.correct_count,
                                "has_images": !q.images.is_empty(),
                            })
                        })
                        .collect();

                    return Ok(json!({
                        "total": result.total,
                        "page": page,
                        "page_size": page_size,
                        "questions": questions,
                        "has_more": result.has_more,
                        "truncated": result.has_more,
                        "source": "questions_table"
                    }));
                }
                Err(e) => {
                    log::warn!(
                        "[QBankExecutor] QuestionBankService failed, falling back to preview: {}",
                        e
                    );
                }
            }
        }

        // 回退：解析 preview_json
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut all_cards: Vec<&ExamCardPreview> =
            preview.pages.iter().flat_map(|p| p.cards.iter()).collect();

        if let Some(status) = status_filter {
            all_cards.retain(|c| {
                let card_status = serde_json::to_value(&c.status)
                    .ok()
                    .and_then(|v| v.as_str().map(String::from))
                    .unwrap_or_else(|| "new".to_string());
                card_status == status
            });
        }

        if let Some(diff) = difficulty_filter {
            all_cards.retain(|c| {
                c.difficulty
                    .as_ref()
                    .map(|d| {
                        serde_json::to_value(d)
                            .ok()
                            .and_then(|v| v.as_str().map(String::from))
                            .unwrap_or_default()
                    })
                    .unwrap_or_default()
                    == diff
            });
        }

        if let Some(tags) = &tags_filter {
            all_cards.retain(|c| tags.iter().any(|t| c.tags.contains(t)));
        }

        let total = all_cards.len();
        // u32 乘法在大页码下会溢出（debug panic / release 回绕），改用 usize saturating 运算
        let start = (page as usize)
            .saturating_sub(1)
            .saturating_mul(page_size as usize);
        let questions: Vec<Value> = all_cards
            .iter()
            .skip(start)
            .take(page_size as usize)
            .map(|c| {
                json!({
                    "card_id": c.card_id,
                    "label": c.question_label,
                    "content_preview": c.ocr_text.chars().take(100).collect::<String>(),
                    "status": c.status,
                    "difficulty": c.difficulty,
                    "tags": c.tags,
                    "attempt_count": c.attempt_count,
                    "correct_count": c.correct_count,
                })
            })
            .collect();

        let has_more = start.saturating_add(questions.len()) < total;
        Ok(json!({
            "total": total,
            "page": page,
            "page_size": page_size,
            "questions": questions,
            "has_more": has_more,
            "truncated": has_more,
            "source": "preview_json"
        }))
    }

    /// 🆕 2026-01 改造：优先使用 QuestionBankService
    async fn execute_get_question(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let card_id = call
            .arguments
            .get("card_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'card_id' parameter")?;

        // 🆕 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            if let Ok(Some(q)) = service.get_question_by_card_id(session_id, card_id) {
                // 获取最近 5 条作答历史
                let submissions = service.get_submissions(&q.id, 5).unwrap_or_default();
                let submissions_json: Vec<Value> = submissions
                    .iter()
                    .map(|s| {
                        json!({
                            "answer": s.user_answer,
                            "is_correct": s.is_correct,
                            "method": s.grading_method,
                            "at": s.submitted_at,
                        })
                    })
                    .collect();
                let updated_at = q.updated_at.clone();

                return Ok(json!({
                    // questions 表主键：delete/batch_update/toggle_* 的 OCC 版本映射都以它为键
                    "question_id": q.id,
                    "card_id": q.card_id.clone().unwrap_or_else(|| q.id.clone()),
                    "label": q.question_label,
                    "content": q.content,
                    "question_type": q.question_type,
                    "structured_data": q.structured_data,
                    "answer": q.answer,
                    "explanation": q.explanation,
                    "difficulty": q.difficulty,
                    "status": q.status,
                    "tags": q.tags,
                    "user_answer": q.user_answer,
                    "is_correct": q.is_correct,
                    "attempt_count": q.attempt_count,
                    "correct_count": q.correct_count,
                    "last_attempt_at": q.last_attempt_at,
                    "user_note": q.user_note,
                    "is_favorite": q.is_favorite,
                    "is_bookmarked": q.is_bookmarked,
                    "images": q.images,
                    "updated_at": updated_at.clone(),
                    "updatedAt": updated_at,
                    "occ_supported": true,
                    "recent_submissions": submissions_json,
                    "source": "questions_table"
                }));
            }
        }

        // 回退：解析 preview_json
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview_updated_at = exam.updated_at.clone();
        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let card = preview
            .pages
            .iter()
            .flat_map(|p| p.cards.iter())
            .find(|c| c.card_id == card_id)
            .ok_or("Question not found")?;

        Ok(json!({
            "card_id": card.card_id,
            "label": card.question_label,
            "content": card.ocr_text,
            "question_type": card.question_type,
            "answer": card.answer,
            "explanation": card.explanation,
            "difficulty": card.difficulty,
            "status": card.status,
            "tags": card.tags,
            "user_answer": card.user_answer,
            "is_correct": card.is_correct,
            "attempt_count": card.attempt_count,
            "correct_count": card.correct_count,
            "last_attempt_at": card.last_attempt_at,
            "user_note": card.user_note,
            "updated_at": preview_updated_at.clone(),
            "updatedAt": preview_updated_at,
            "occ_supported": false,
            "source": "preview_json"
        }))
    }

    async fn execute_create_question(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let _write_guard = QBANK_WRITE_LOCK.lock().await;
        let service = self.require_service(ctx)?;
        let exam_id = required_non_empty_string(&call.arguments, "session_id")?;
        let content = required_non_empty_string(&call.arguments, "content")?;
        if content.chars().count() > 50_000 {
            return Err(qbank_error(
                "INVALID_ARGS",
                "content 超过 50000 字符上限",
                "缩短题干后重试",
            ));
        }

        let question_type = call
            .arguments
            .get("question_type")
            .map(|value| parse_repo_question_type(value, "question_type"))
            .transpose()?
            .unwrap_or(RepoQuestionType::Other);
        let options = call
            .arguments
            .get("options")
            .map(parse_question_options)
            .transpose()?;
        if matches!(
            question_type,
            RepoQuestionType::SingleChoice
                | RepoQuestionType::MultipleChoice
                | RepoQuestionType::IndefiniteChoice
        ) && options.as_ref().map(Vec::is_empty).unwrap_or(true)
        {
            return Err(qbank_error(
                "INVALID_ARGS",
                "选择题必须提供非空 options",
                "把选项作为 {key,content} 数组传入",
            ));
        }
        let structured_data = parse_structured_data_arg(&call.arguments, &question_type, true)?;
        let answer = optional_string(&call.arguments, "answer", 50_000)?;
        if matches!(question_type, RepoQuestionType::TrueFalse) {
            if let Some(answer) = &answer {
                validate_true_false_answer(answer)?;
            }
        }

        let tags = call
            .arguments
            .get("tags")
            .map(|value| parse_string_array(value, "tags", 50, 100))
            .transpose()?;
        let images = call
            .arguments
            .get("images")
            .map(parse_question_images)
            .transpose()?;
        let difficulty = call
            .arguments
            .get("difficulty")
            .map(|value| parse_difficulty(value, "difficulty"))
            .transpose()?;
        let parent_id = if let Some(parent_id) = optional_string(&call.arguments, "parent_id", 200)?
        {
            Some(parent_id)
        } else if let Some(parent_card_id) =
            optional_string(&call.arguments, "parent_card_id", 200)?
        {
            Some(
                service
                    .get_question_by_card_id(&exam_id, &parent_card_id)
                    .map_err(|error| error.to_string())?
                    .ok_or_else(|| {
                        qbank_error(
                            "QBANK_QUESTION_NOT_FOUND",
                            format!("找不到父题 card_id={parent_card_id}"),
                            "重新读取题目后重试",
                        )
                    })?
                    .id,
            )
        } else {
            None
        };
        let card_id = optional_string(&call.arguments, "card_id", 200)?.unwrap_or_else(|| {
            format!("card_{}", &uuid::Uuid::new_v4().simple().to_string()[..12])
        });

        let params = CreateQuestionParams {
            exam_id: exam_id.clone(),
            card_id: Some(card_id),
            question_label: optional_string(&call.arguments, "question_label", 120)?,
            content,
            options,
            answer,
            explanation: optional_string(&call.arguments, "explanation", 100_000)?,
            question_type: Some(question_type),
            difficulty,
            tags,
            source_type: Some(RepoSourceType::Manual),
            source_ref: optional_string(&call.arguments, "source_ref", 1_000)?,
            images,
            parent_id,
            structured_data,
        };
        let created = service
            .create_question(&params)
            .map_err(|error| error.to_string())?;
        emit_qbank_changed(ctx, "create_question", std::slice::from_ref(&created.id));
        let undo_versions = HashMap::from([(created.id.clone(), created.updated_at.clone())]);
        let created_value = question_to_bounded_value(&created);

        Ok(json!({
            "success": true,
            "question": created_value,
            "previous": null,
            "reversible": false,
            "reversibleWithApproval": true,
            "undo": {
                "tool": "builtin-qbank_delete_questions",
                "requiresApproval": true,
                "question_ids": [created.id],
                "expected_updated_at_by_id": undo_versions,
            },
        }))
    }

    fn parse_delete_versions(&self, args: &Value) -> Result<Vec<(String, String)>, String> {
        let question_ids = parse_string_array(
            args.get("question_ids").ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    "缺少 question_ids",
                    "传入要删除的 questions 表题目 ID",
                )
            })?,
            "question_ids",
            20,
            200,
        )?;
        if question_ids.is_empty() {
            return Err(qbank_error(
                "INVALID_ARGS",
                "question_ids 不能为空",
                "传入至少一个题目 ID",
            ));
        }

        let version_map = args
            .get("expected_updated_at_by_id")
            .or_else(|| args.get("expected_updated_at"))
            .and_then(Value::as_object);
        if let Some(version_map) = version_map {
            return question_ids
                .into_iter()
                .map(|question_id| {
                    let version = version_map
                        .get(&question_id)
                        .and_then(Value::as_str)
                        .map(str::trim)
                        .filter(|value| !value.is_empty())
                        .ok_or_else(|| {
                            qbank_error(
                                "QBANK_OCC_REQUIRED",
                                format!("缺少 {question_id} 的 expected_updated_at"),
                                "逐题调用 qbank_get_question 后传入精确版本映射",
                            )
                        })?;
                    Ok((question_id, version.to_string()))
                })
                .collect();
        }

        if question_ids.len() == 1 {
            if let Some(version) = args
                .get("expected_updated_at")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                return Ok(vec![(question_ids[0].clone(), version.to_string())]);
            }
        }

        Err(qbank_error(
            "QBANK_OCC_REQUIRED",
            "批量删除必须提供 expected_updated_at_by_id",
            "逐题调用 qbank_get_question，并以 question_id 为键传入最新 updated_at",
        ))
    }

    async fn execute_delete_questions(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let expected_versions = self.parse_delete_versions(&call.arguments)?;
        let _write_guard = QBANK_WRITE_LOCK.lock().await;
        let service = self.require_service(ctx)?;
        let previous = match service.batch_delete_questions_if_versions(&expected_versions) {
            Ok(previous) => previous,
            Err(error) => {
                let message = error.to_string();
                if message.contains("QBANK_CONFLICT") {
                    let current = expected_versions
                        .iter()
                        .filter_map(|(question_id, _)| {
                            service
                                .get_question(question_id)
                                .ok()
                                .flatten()
                                .map(|question| question_to_bounded_value(&question))
                        })
                        .collect::<Vec<_>>();
                    return Err(qbank_conflict_error(
                        message,
                        "批次未发生任何删除；使用 current 重新确认全部题目版本后再请求用户确认",
                        json!(current),
                    ));
                }
                return Err(message);
            }
        };
        let entity_ids: Vec<String> = previous
            .iter()
            .map(|question| question.id.clone())
            .collect();
        emit_qbank_changed(ctx, "delete_questions", &entity_ids);
        let deleted: Vec<Value> = previous
            .iter()
            .map(|question| {
                json!({
                    "question_id": question.id,
                    "card_id": question.card_id,
                    "session_id": question.exam_id,
                    "content_preview": question.content.chars().take(120).collect::<String>(),
                    "previous_updated_at": question.updated_at,
                })
            })
            .collect();

        Ok(json!({
            "success": true,
            "deleted_count": deleted.len(),
            "deleted": deleted,
            "soft_deleted": true,
            "reversible": false,
            "recovery": {
                "availableToAgent": false,
                "reason": "当前未暴露题目恢复工具；不得宣称已提供撤销",
            },
        }))
    }

    async fn execute_toggle_favorite(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let expected_updated_at = expected_qbank_revision(&call.arguments)?;
        let _write_guard = QBANK_WRITE_LOCK.lock().await;
        let service = self.require_service(ctx)?;
        let question = if let Some(question_id) = call
            .arguments
            .get("question_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            service
                .get_question(question_id)
                .map_err(|error| error.to_string())?
        } else {
            let exam_id = required_non_empty_string(&call.arguments, "session_id")?;
            let card_id = required_non_empty_string(&call.arguments, "card_id")?;
            service
                .get_question_by_card_id(&exam_id, &card_id)
                .map_err(|error| error.to_string())?
        }
        .ok_or_else(|| {
            qbank_error(
                "QBANK_QUESTION_NOT_FOUND",
                "找不到要收藏的题目",
                "重新读取题目后重试",
            )
        })?;
        let previous_favorite = question.is_favorite;
        let updated = match service.update_question(
            &question.id,
            &UpdateQuestionParams {
                is_favorite: Some(!previous_favorite),
                expected_updated_at: Some(expected_updated_at),
                ..Default::default()
            },
            false,
        ) {
            Ok(updated) => updated,
            Err(error) => {
                let message = error.to_string();
                if message.contains("QBANK_CONFLICT") {
                    let current = service
                        .get_question(&question.id)
                        .ok()
                        .flatten()
                        .map(|current| question_to_bounded_value(&current))
                        .unwrap_or(Value::Null);
                    return Err(qbank_conflict_error(
                        message,
                        "使用 current.updated_at 重新规划收藏变更，禁止盲重试",
                        current,
                    ));
                }
                return Err(message);
            }
        };
        emit_qbank_changed(ctx, "toggle_favorite", std::slice::from_ref(&updated.id));
        let updated_value = question_to_bounded_value(&updated);

        Ok(json!({
            "success": true,
            "question": updated_value,
            "previous": { "is_favorite": previous_favorite },
            "reversible": true,
            "undo": {
                "tool": "builtin-qbank_toggle_favorite",
                "question_id": updated.id,
                "expected_updated_at": updated.updated_at,
            },
        }))
    }

    /// 🆕 完备性补齐：切换书签状态（与收藏独立的第二个标记位）
    async fn execute_toggle_bookmark(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let expected_updated_at = expected_qbank_revision(&call.arguments)?;
        let _write_guard = QBANK_WRITE_LOCK.lock().await;
        let service = self.require_service(ctx)?;
        let question = self.resolve_question(service, &call.arguments)?;
        let previous_bookmarked = question.is_bookmarked;
        let updated = match service.update_question(
            &question.id,
            &UpdateQuestionParams {
                is_bookmarked: Some(!previous_bookmarked),
                expected_updated_at: Some(expected_updated_at),
                ..Default::default()
            },
            false,
        ) {
            Ok(updated) => updated,
            Err(error) => {
                let message = error.to_string();
                if message.contains("QBANK_CONFLICT") {
                    let current = service
                        .get_question(&question.id)
                        .ok()
                        .flatten()
                        .map(|current| question_to_bounded_value(&current))
                        .unwrap_or(Value::Null);
                    return Err(qbank_conflict_error(
                        message,
                        "使用 current.updated_at 重新规划书签变更，禁止盲重试",
                        current,
                    ));
                }
                return Err(message);
            }
        };
        emit_qbank_changed(ctx, "toggle_bookmark", std::slice::from_ref(&updated.id));
        let updated_value = question_to_bounded_value(&updated);

        Ok(json!({
            "success": true,
            "question": updated_value,
            "previous": { "is_bookmarked": previous_bookmarked },
            "reversible": true,
            "undo": {
                "tool": "builtin-qbank_toggle_bookmark",
                "question_id": updated.id,
                "expected_updated_at": updated.updated_at,
            },
        }))
    }

    /// 🆕 完备性补齐：完整作答历史（get_question 只带最近 5 条）
    async fn execute_get_submissions(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let question = self.resolve_question(service, &call.arguments)?;
        let limit = read_strict_u32(&call.arguments, "limit", 10, 1, 20)?;
        let submissions = service
            .get_submissions(&question.id, limit)
            .map_err(|error| error.to_string())?;
        let items: Vec<Value> = submissions
            .iter()
            .map(|submission| {
                let (user_answer, truncated) = bounded_text(&submission.user_answer, 2_000);
                json!({
                    "submission_id": submission.id,
                    "user_answer": user_answer,
                    "user_answer_truncated": truncated,
                    "is_correct": submission.is_correct,
                    "grading_method": submission.grading_method,
                    "submitted_at": submission.submitted_at,
                })
            })
            .collect();
        let count = items.len();
        Ok(json!({
            "question_id": question.id,
            "card_id": question.card_id,
            "session_id": question.exam_id,
            "submissions": items,
            "count": count,
            "limit": limit,
            "has_more": count as u32 == limit,
            "truncated": count as u32 == limit,
        }))
    }

    /// 🆕 完备性补齐：题目字段变更历史（谁在何时改了什么）
    async fn execute_get_question_history(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let question = self.resolve_question(service, &call.arguments)?;
        let limit = read_strict_u32(&call.arguments, "limit", 10, 1, 20)?;
        let history = service
            .get_history(&question.id, Some(limit))
            .map_err(|error| error.to_string())?;
        let items: Vec<Value> = history
            .iter()
            .map(|entry| {
                json!({
                    "field_name": entry.field_name,
                    "old_value": bounded_optional_text(entry.old_value.as_deref()),
                    "new_value": bounded_optional_text(entry.new_value.as_deref()),
                    "operator": entry.operator,
                    "reason": entry.reason,
                    "changed_at": entry.created_at,
                })
            })
            .collect();
        let count = items.len();
        Ok(json!({
            "question_id": question.id,
            "card_id": question.card_id,
            "session_id": question.exam_id,
            "history": items,
            "count": count,
            "limit": limit,
            "has_more": count as u32 == limit,
            "truncated": count as u32 == limit,
        }))
    }

    /// 🆕 完备性补齐：批量更新学习元数据（难度/状态/标签），逐题 OCC、逐题上报结果
    async fn execute_batch_update_questions(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let question_ids = parse_string_array(
            call.arguments.get("question_ids").ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    "缺少 question_ids",
                    "传入要更新的 questions 表题目 ID（1-20 个）",
                )
            })?,
            "question_ids",
            20,
            200,
        )?;
        if question_ids.is_empty() {
            return Err(qbank_error(
                "INVALID_ARGS",
                "question_ids 不能为空",
                "传入至少一个题目 ID",
            ));
        }
        let version_map = call
            .arguments
            .get("expected_updated_at_by_id")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                qbank_error(
                    "QBANK_OCC_REQUIRED",
                    "批量更新必须提供 expected_updated_at_by_id",
                    "逐题调用 qbank_get_question，并以 question_id 为键传入最新 updated_at",
                )
            })?;

        let updates = call
            .arguments
            .get("updates")
            .and_then(Value::as_object)
            .ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    "缺少 updates 对象",
                    "在 updates 中提供 difficulty/status/tags 至少一项",
                )
            })?;
        let mut template = UpdateQuestionParams::default();
        let mut changed_fields: Vec<&str> = Vec::new();
        if let Some(value) = updates.get("difficulty") {
            template.difficulty = Some(parse_difficulty(value, "updates.difficulty")?);
            changed_fields.push("difficulty");
        }
        if let Some(value) = updates.get("status") {
            template.status = Some(parse_status(value, "updates.status")?);
            changed_fields.push("status");
        }
        if let Some(value) = updates.get("tags") {
            template.tags = Some(parse_string_array(value, "updates.tags", 50, 100)?);
            changed_fields.push("tags");
        }
        if let Some(unknown) = updates
            .keys()
            .find(|key| !matches!(key.as_str(), "difficulty" | "status" | "tags"))
        {
            return Err(qbank_error(
                "INVALID_ARGS",
                format!("updates 包含不支持的字段: {unknown}"),
                "批量更新只支持 difficulty/status/tags；题干/答案等内容请逐题用 qbank_update_question",
            ));
        }
        if changed_fields.is_empty() {
            return Err(qbank_error(
                "INVALID_ARGS",
                "updates 没有提供任何可更新字段",
                "在 updates 中提供 difficulty/status/tags 至少一项",
            ));
        }

        // 先校验版本映射完整性，再获取写锁逐题提交
        let mut planned: Vec<(String, String)> = Vec::with_capacity(question_ids.len());
        for question_id in &question_ids {
            let version = version_map
                .get(question_id)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or_else(|| {
                    qbank_error(
                        "QBANK_OCC_REQUIRED",
                        format!("缺少 {question_id} 的 expected_updated_at"),
                        "逐题调用 qbank_get_question 后传入精确版本映射",
                    )
                })?;
            planned.push((question_id.clone(), version.to_string()));
        }

        let _write_guard = QBANK_WRITE_LOCK.lock().await;
        let service = self.require_service(ctx)?;
        let mut results: Vec<Value> = Vec::with_capacity(planned.len());
        let mut updated_ids: Vec<String> = Vec::new();
        let mut conflict_count = 0usize;
        let mut failed_count = 0usize;
        for (question_id, version) in planned {
            let mut params = template.clone();
            params.expected_updated_at = Some(version);
            match service.update_question(&question_id, &params, true) {
                Ok(updated) => {
                    results.push(json!({
                        "question_id": question_id,
                        "outcome": "updated",
                        "updated_at": updated.updated_at,
                    }));
                    updated_ids.push(question_id);
                }
                Err(error) => {
                    let message = error.to_string();
                    if message.contains("QBANK_CONFLICT") {
                        conflict_count += 1;
                        let current = service
                            .get_question(&question_id)
                            .ok()
                            .flatten()
                            .map(|current| question_to_bounded_value(&current))
                            .unwrap_or(Value::Null);
                        results.push(json!({
                            "question_id": question_id,
                            "outcome": "conflict",
                            "current": current,
                        }));
                    } else {
                        failed_count += 1;
                        let (bounded_message, _) = bounded_text(&message, 500);
                        results.push(json!({
                            "question_id": question_id,
                            "outcome": "failed",
                            "error": bounded_message,
                        }));
                    }
                }
            }
        }
        if !updated_ids.is_empty() {
            emit_qbank_changed(ctx, "batch_update", &updated_ids);
        }

        Ok(json!({
            "success": conflict_count == 0 && failed_count == 0,
            "changed_fields": changed_fields,
            "updated_count": updated_ids.len(),
            "conflict_count": conflict_count,
            "failed_count": failed_count,
            "results": results,
            "atomic": false,
            "reversible": false,
            "note": "逐题独立提交：冲突/失败的题目未被修改，需按 results 中的 current 重新规划",
        }))
    }

    /// 🆕 完备性补齐：列出题目集源图片元数据（不含 base64，正文请在题库 UI 查看）
    async fn execute_list_source_images(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = required_non_empty_string(&call.arguments, "session_id")?;
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, &session_id)
            .map_err(|error| format!("Failed to get exam sheet: {error}"))?
            .ok_or("Exam sheet not found")?;

        let mut source_hashes: Vec<String> = exam
            .metadata_json
            .get("source_image_hashes")
            .and_then(|value| serde_json::from_value::<Vec<String>>(value.clone()).ok())
            .unwrap_or_default();
        // 回退：OCR 上传流程不写 source_image_hashes，图片在 preview_json pages 的 blob_hash 中
        if source_hashes.is_empty() {
            if let Some(pages) = exam.preview_json.get("pages").and_then(Value::as_array) {
                for page in pages {
                    if let Some(hash) = page.get("blob_hash").and_then(Value::as_str) {
                        if !hash.is_empty() {
                            source_hashes.push(hash.to_string());
                        }
                    }
                }
            }
        }

        let (page, page_size, start, end) = Self::page_bounds(&call.arguments, source_hashes.len())?;
        let images: Vec<Value> = source_hashes[start..end]
            .iter()
            .enumerate()
            .map(|(offset, hash)| {
                json!({
                    "page_index": start + offset,
                    "blob_hash": hash,
                })
            })
            .collect();
        Ok(json!({
            "session_id": session_id,
            "images": images,
            "total": source_hashes.len(),
            "page": page,
            "page_size": page_size,
            "has_more": end < source_hashes.len(),
            "truncated": end < source_hashes.len(),
            "data_included": false,
            "note": "仅返回元数据；图片正文请让用户在题库 UI 查看，Agent 不应请求 base64 数据",
        }))
    }

    async fn execute_search_questions(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let keyword = required_non_empty_string(&call.arguments, "keyword")?;
        if keyword.chars().count() > 200 {
            return Err(qbank_error(
                "INVALID_ARGS",
                "keyword 超过 200 字符上限",
                "缩短关键词后重试",
            ));
        }
        let page = read_strict_u32(&call.arguments, "page", 1, 1, u32::MAX)?;
        let page_size = read_strict_u32(&call.arguments, "page_size", 20, 1, 20)?;
        let mut base = QuestionFilters::default();
        if let Some(value) = call.arguments.get("status") {
            base.status = Some(vec![parse_status(value, "status")?]);
        }
        if let Some(value) = call.arguments.get("difficulty") {
            base.difficulty = Some(vec![parse_difficulty(value, "difficulty")?]);
        }
        if let Some(value) = call.arguments.get("question_type") {
            base.question_type = Some(vec![parse_repo_question_type(value, "question_type")?]);
        }
        if let Some(value) = call.arguments.get("tags") {
            base.tags = Some(parse_string_array(value, "tags", 20, 100)?);
        }
        if let Some(value) = call.arguments.get("is_favorite") {
            base.is_favorite = Some(value.as_bool().ok_or_else(|| {
                qbank_error("INVALID_ARGS", "is_favorite 必须是布尔值", "修正参数后重试")
            })?);
        }
        let sort_by = call
            .arguments
            .get("sort_by")
            .map(|value| {
                serde_json::from_value::<SearchSortBy>(value.clone()).map_err(|_| {
                    qbank_error(
                        "INVALID_ARGS",
                        "sort_by 不受支持",
                        "使用 relevance/created_desc/created_asc/updated_desc",
                    )
                })
            })
            .transpose()?;
        let result = service
            .search_questions(
                &keyword,
                call.arguments.get("session_id").and_then(Value::as_str),
                &QuestionSearchFilters { base, sort_by },
                page,
                page_size,
            )
            .map_err(|error| error.to_string())?;
        let results: Vec<Value> = result
            .results
            .iter()
            .map(|item| {
                json!({
                    "question": question_to_bounded_value(&item.question),
                    "highlight_content": bounded_optional_text(item.highlight_content.as_deref()),
                    "highlight_answer": bounded_optional_text(item.highlight_answer.as_deref()),
                    "highlight_explanation": bounded_optional_text(item.highlight_explanation.as_deref()),
                    "relevance_score": item.relevance_score,
                })
            })
            .collect();
        Ok(json!({
            "results": results,
            "total": result.total,
            "page": result.page,
            "page_size": result.page_size,
            "has_more": result.has_more,
            "search_time_ms": result.search_time_ms,
            "truncated": result.has_more,
        }))
    }

    /// 🆕 2026-01 改造：优先使用 QuestionBankService
    async fn execute_submit_answer(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let _write_guard = QBANK_WRITE_LOCK.lock().await;

        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let card_id = call
            .arguments
            .get("card_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'card_id' parameter")?;
        // 新题型契约：user_answer 统一为序列化字符串——
        // true_false "true"/"false"；numeric 数字串；fill_blank 多空 JSON 数组；
        // matching {"pairs":[...]}；ordering JSON 数组。
        // 容错：模型直接传 JSON 数组/对象/数字/布尔时按规范序列化为字符串透传。
        let user_answer: String = match call.arguments.get("user_answer") {
            Some(Value::String(text)) => text.clone(),
            Some(value @ (Value::Array(_) | Value::Object(_) | Value::Number(_) | Value::Bool(_))) => {
                serde_json::to_string(value)
                    .map_err(|error| format!("user_answer 序列化失败: {error}"))?
            }
            _ => return Err("Missing 'user_answer' parameter".to_string()),
        };
        let user_answer = user_answer.as_str();
        // M-065: user_answer 长度校验
        if user_answer.len() > 50000 {
            return Err("答案内容过长（上限 50000 字符）".to_string());
        }
        let is_correct_override = call.arguments.get("is_correct").and_then(|v| v.as_bool());

        // 🆕 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            // 先通过 card_id 获取 question_id
            if let Ok(Some(question)) = service.get_question_by_card_id(session_id, card_id) {
                match service.submit_answer(&question.id, user_answer, is_correct_override, None) {
                    Ok(result) => {
                        emit_qbank_changed(
                            ctx,
                            "submit_answer",
                            &[question
                                .card_id
                                .clone()
                                .unwrap_or_else(|| question.id.clone())],
                        );
                        let (message_key, zh_cn, en_us) = if result.needs_manual_grading {
                            (
                                "chat.tools.qbank.answer_needs_manual_grading",
                                "需要手动批改",
                                "This answer requires manual grading.",
                            )
                        } else if result.is_correct == Some(true) {
                            (
                                "chat.tools.qbank.answer_correct",
                                "回答正确！",
                                "The answer is correct.",
                            )
                        } else {
                            (
                                "chat.tools.qbank.answer_incorrect",
                                "回答错误",
                                "The answer is incorrect.",
                            )
                        };
                        return Ok(with_localized_message(
                            json!({
                                "is_correct": result.is_correct,
                                "correct_answer": result.correct_answer,
                                "needs_manual_grading": result.needs_manual_grading,
                                "submission_id": result.submission_id,
                                "source": "questions_table"
                            }),
                            message_key,
                            json!({
                                "isCorrect": result.is_correct,
                                "needsManualGrading": result.needs_manual_grading,
                            }),
                            zh_cn,
                            en_us,
                        ));
                    }
                    Err(e) => {
                        // 题目已在 questions 表中：判分/写入失败时必须直接报错。
                        // 若继续回退到 preview_json 会造成双写发散且把真实错误吞掉。
                        log::warn!(
                            "[QBankExecutor] QuestionBankService submit_answer failed: {}",
                            e
                        );
                        return Err(e.to_string());
                    }
                }
            }
        }

        // 回退：使用 preview_json
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;
        // ACR 4.0 P1：preview_json 回落写路径补 OCC——以读取时的 updated_at 为基线
        let preview_revision = exam.updated_at.clone();

        let mut preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut found = false;
        let mut is_correct: Option<bool> = Some(false);
        let mut correct_answer = String::new();
        let mut _question_type: Option<QuestionType> = None;
        let mut needs_manual_grading = false;

        for page in &mut preview.pages {
            for card in &mut page.cards {
                if card.card_id == card_id {
                    found = true;
                    card.user_answer = Some(user_answer.to_string());
                    card.attempt_count += 1;
                    card.last_attempt_at = Some(chrono::Utc::now().to_rfc3339());
                    _question_type = card.question_type.clone();

                    let is_subjective = matches!(
                        card.question_type,
                        Some(QuestionType::Essay)
                            | Some(QuestionType::ShortAnswer)
                            | Some(QuestionType::Calculation)
                            | Some(QuestionType::Proof)
                    );

                    if is_subjective && is_correct_override.is_none() {
                        // M-063: 主观题 is_correct 设为 None，避免工具调用方误判为"错误"
                        needs_manual_grading = true;
                        is_correct = None;
                        card.status = ModelsQuestionStatus::InProgress;
                        card.is_correct = None;
                    } else {
                        let correct = is_correct_override.unwrap_or_else(|| {
                            card.answer
                                .as_ref()
                                .map(|a| {
                                    check_answer_correctness(user_answer, a, &card.question_type)
                                })
                                .unwrap_or(false)
                        });
                        is_correct = Some(correct);

                        card.is_correct = Some(correct);
                        if correct {
                            card.correct_count += 1;
                            if card.correct_count >= 2 {
                                card.status = ModelsQuestionStatus::Mastered;
                            } else {
                                card.status = ModelsQuestionStatus::InProgress;
                            }
                        } else {
                            card.status = ModelsQuestionStatus::Review;
                        }
                    }

                    correct_answer = card.answer.clone().unwrap_or_default();
                    break;
                }
            }
            if found {
                break;
            }
        }

        if !found {
            return Err("Question not found".to_string());
        }

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| format!("Failed to serialize preview: {}", e))?;

        let occ_ok = VfsExamRepo::update_preview_json_if_unchanged(
            vfs_db,
            session_id,
            preview_json,
            &preview_revision,
        )
        .map_err(|e| format!("Failed to update exam sheet: {}", e))?;
        if !occ_ok {
            return Err(qbank_conflict_error(
                "题目集在读取后已被并发修改，本次作答未写入",
                "重新读取题目集最新状态后再提交作答；不要凭旧状态重试",
                json!({ "session_id": session_id, "expected_updated_at": preview_revision }),
            ));
        }

        emit_qbank_changed(ctx, "submit_answer", &[card_id.to_string()]);

        let (message_key, zh_cn, en_us) = if needs_manual_grading {
            (
                "chat.tools.qbank.answer_needs_manual_grading",
                "主观题已提交，请参考答案自行判断。",
                "The subjective answer was submitted; compare it with the reference answer manually.",
            )
        } else if is_correct == Some(true) {
            (
                "chat.tools.qbank.answer_correct",
                "回答正确！",
                "The answer is correct.",
            )
        } else {
            (
                "chat.tools.qbank.answer_incorrect",
                "回答错误，请查看正确答案。",
                "The answer is incorrect; review the correct answer.",
            )
        };
        Ok(with_localized_message(
            json!({
                "is_correct": is_correct,
                "correct_answer": correct_answer,
                "needs_manual_grading": needs_manual_grading,
                "source": "preview_json",
                "degraded": true
            }),
            message_key,
            json!({
                "isCorrect": is_correct,
                "needsManualGrading": needs_manual_grading,
            }),
            zh_cn,
            en_us,
        ))
    }

    async fn execute_update_question(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let _write_guard = QBANK_WRITE_LOCK.lock().await;
        let session_id = required_non_empty_string(&call.arguments, "session_id")?;
        let card_id = required_non_empty_string(&call.arguments, "card_id")?;
        let expected_updated_at = expected_qbank_revision(&call.arguments)?;
        let service = self.require_service(ctx)?;
        let question = service
            .get_question_by_card_id(&session_id, &card_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                qbank_error(
                    "QBANK_OCC_UNAVAILABLE",
                    "题目不在支持 OCC 的 questions_table 中",
                    "重新读取或先迁移题目数据后再更新",
                )
            })?;

        let mut params = UpdateQuestionParams {
            expected_updated_at: Some(expected_updated_at),
            ..Default::default()
        };
        let mut changed_fields = Vec::new();
        if let Some(value) = optional_string(&call.arguments, "content", 50_000)? {
            if value.trim().is_empty() {
                return Err(qbank_error(
                    "INVALID_ARGS",
                    "content 不能为空",
                    "传入非空题干",
                ));
            }
            params.content = Some(value);
            changed_fields.push("content");
        }
        if let Some(value) = call.arguments.get("options") {
            params.options = Some(parse_question_options(value)?);
            changed_fields.push("options");
        }
        if let Some(value) = call.arguments.get("question_type") {
            params.question_type = Some(parse_repo_question_type(value, "question_type")?);
            changed_fields.push("question_type");
        }
        if let Some(value) = optional_string(&call.arguments, "answer", 50_000)? {
            params.answer = Some(value);
            changed_fields.push("answer");
        }
        if let Some(value) = optional_string(&call.arguments, "explanation", 100_000)? {
            params.explanation = Some(value);
            changed_fields.push("explanation");
        }
        if let Some(value) = call.arguments.get("difficulty") {
            params.difficulty = Some(parse_difficulty(value, "difficulty")?);
            changed_fields.push("difficulty");
        }
        if let Some(value) = call.arguments.get("tags") {
            params.tags = Some(parse_string_array(value, "tags", 50, 100)?);
            changed_fields.push("tags");
        }
        if let Some(value) = optional_string(&call.arguments, "user_note", 50_000)? {
            params.user_note = Some(value);
            changed_fields.push("user_note");
        }
        if let Some(value) = call.arguments.get("status") {
            params.status = Some(parse_status(value, "status")?);
            changed_fields.push("status");
        }
        if let Some(value) = call.arguments.get("images") {
            params.images = Some(parse_question_images(value)?);
            changed_fields.push("images");
        }
        if call
            .arguments
            .get("structured_data")
            .is_some_and(|value| !value.is_null())
        {
            changed_fields.push("structured_data");
        }
        if changed_fields.is_empty() {
            return Err(qbank_error(
                "INVALID_ARGS",
                "没有提供任何可更新字段",
                "传入 content/options/question_type/structured_data 或其他更新字段",
            ));
        }
        // 拷出最终题型，避免后续对 params 的可变写入与不可变借用冲突
        let final_question_type = params
            .question_type
            .clone()
            .unwrap_or_else(|| question.question_type.clone());
        let final_options = params.options.as_ref().or(question.options.as_ref());
        if matches!(
            final_question_type,
            RepoQuestionType::SingleChoice
                | RepoQuestionType::MultipleChoice
                | RepoQuestionType::IndefiniteChoice
        ) && final_options.map(Vec::is_empty).unwrap_or(true)
        {
            return Err(qbank_error(
                "INVALID_ARGS",
                "更新后的选择题必须保留非空 options",
                "同时传入至少一个 {key,content} 选项，或改为非选择题题型",
            ));
        }
        // structured_data 与最终题型的匹配校验：
        // 切换到 matching/ordering/numeric 时必须同调用携带对应格式的 structured_data，
        // 否则新题型没有可判分的数据结构。
        let switching_to_structured_type = params
            .question_type
            .as_ref()
            .is_some_and(|next_type| {
                question_type_requires_structured_data(next_type)
                    && *next_type != question.question_type
            });
        params.structured_data = parse_structured_data_arg(
            &call.arguments,
            &final_question_type,
            switching_to_structured_type,
        )?;
        if matches!(final_question_type, RepoQuestionType::TrueFalse) {
            if let Some(answer) = &params.answer {
                validate_true_false_answer(answer)?;
            }
        }

        let updated = match service.update_question(&question.id, &params, true) {
            Ok(updated) => updated,
            Err(error) => {
                let message = error.to_string();
                if message.contains("QBANK_CONFLICT") {
                    let current = service
                        .get_question(&question.id)
                        .ok()
                        .flatten()
                        .map(|current| question_to_bounded_value(&current))
                        .unwrap_or(Value::Null);
                    return Err(qbank_conflict_error(
                        message,
                        "题目已被其他写入更新；使用 current 重新规划后再改，勿盲目重试",
                        current,
                    ));
                }
                return Err(message);
            }
        };
        emit_qbank_changed(ctx, "update_question", std::slice::from_ref(&updated.id));
        let previous_value = question_to_bounded_value(&question);
        let updated_value = question_to_bounded_value(&updated);

        Ok(json!({
            "success": true,
            "question": updated_value,
            "previous": previous_value,
            "changed_fields": changed_fields,
            "source": "questions_table",
            "updatedAt": updated.updated_at,
            "updated_at": updated.updated_at,
            "reversible": false,
            "reversibleWithOcc": true,
            "undo": {
                "tool": "builtin-qbank_update_question",
                "expected_updated_at": updated.updated_at,
                "restore_from": "previous",
                "note": "使用 previous 中对应字段构造反向更新；可空字段无法统一自动清空时需人工确认",
            },
        }))
    }

    async fn execute_ai_grade(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let vfs_db = ctx
            .vfs_db
            .as_ref()
            .ok_or("VFS database not available")?
            .clone();
        let llm = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM manager not available")?
            .clone();

        let submission_id = call
            .arguments
            .get("submission_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    "缺少 submission_id",
                    "先调用 qbank_submit_answer，并传入其返回的 submission_id",
                )
            })?
            .to_string();

        let question_id = if let Some(question_id) = call
            .arguments
            .get("question_id")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            question_id.to_string()
        } else {
            let session_id = call
                .arguments
                .get("session_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    qbank_error(
                        "INVALID_ARGS",
                        "缺少 question_id，且未提供 session_id",
                        "传 question_id，或同时传 session_id 与 card_id",
                    )
                })?;
            let card_id = call
                .arguments
                .get("card_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    qbank_error(
                        "INVALID_ARGS",
                        "缺少 question_id，且未提供 card_id",
                        "传 question_id，或同时传 session_id 与 card_id",
                    )
                })?;

            let question = if let Some(service) = &ctx.question_bank_service {
                service
                    .get_question_by_card_id(session_id, card_id)
                    .map_err(|error| error.to_string())?
            } else {
                VfsQuestionRepo::get_question_by_card_id(&vfs_db, session_id, card_id)
                    .map_err(|error| error.to_string())?
            }
            .ok_or_else(|| {
                qbank_error(
                    "NOT_FOUND",
                    format!("题目不存在: {session_id}/{card_id}"),
                    "重新调用 qbank_get_question 获取有效题目",
                )
            })?;
            question.id
        };

        let mode = parse_qbank_grading_mode(&call.arguments)?;
        let stream_session_id = format!("agent-{}-{}", ctx.session_id, call.id);
        let stream_event = format!("qbank_grading_stream_{stream_session_id}");
        let request = QbankGradingRequest {
            question_id: question_id.clone(),
            submission_id,
            stream_session_id,
            mode,
            model_config_id: call
                .arguments
                .get("model_config_id")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string),
        };
        let deps = QbankGradingDeps {
            llm: llm.clone(),
            vfs_db,
            emitter: QbankGradingEmitter::new(ctx.window_ref().clone()),
        };

        let grading = run_qbank_grading(request, deps);
        tokio::pin!(grading);
        let response = if let Some(token) = ctx.cancellation_token() {
            tokio::select! {
                result = &mut grading => result,
                _ = token.cancelled() => {
                    llm.request_cancel_stream(&stream_event).await;
                    grading.await
                }
            }
        } else {
            grading.await
        }
        .map_err(|error| error.to_string())?;

        match response {
            Some(response) => {
                emit_qbank_changed(ctx, "ai_grade", &[question_id]);
                serde_json::to_value(response).map_err(|error| error.to_string())
            }
            None => Ok(json!({
                "cancelled": true,
                "messageKey": "agentTools.qbank.aiGradeCancelled"
            })),
        }
    }

    async fn execute_get_stats(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;

        // 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            if let Ok(Some(stats)) = service.get_stats(session_id) {
                return Ok(json!({
                    "total": stats.total_count,
                    "new": stats.new_count,
                    "in_progress": stats.in_progress_count,
                    "mastered": stats.mastered_count,
                    "review": stats.review_count,
                    "correct_rate": stats.correct_rate,
                    "total_attempts": stats.total_attempts,
                    "total_correct": stats.total_correct,
                    "source": "questions_table"
                }));
            }
            if let Ok(stats) = service.refresh_stats(session_id) {
                return Ok(json!({
                    "total": stats.total_count,
                    "new": stats.new_count,
                    "in_progress": stats.in_progress_count,
                    "mastered": stats.mastered_count,
                    "review": stats.review_count,
                    "correct_rate": stats.correct_rate,
                    "total_attempts": stats.total_attempts,
                    "total_correct": stats.total_correct,
                    "source": "questions_table"
                }));
            }
        }

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut stats = QuestionBankStats::default();
        let mut total_attempts = 0;
        let mut total_correct = 0;

        for page in &preview.pages {
            for card in &page.cards {
                stats.total_count += 1;
                match card.status {
                    ModelsQuestionStatus::New => stats.new_count += 1,
                    ModelsQuestionStatus::InProgress => stats.in_progress_count += 1,
                    ModelsQuestionStatus::Mastered => stats.mastered_count += 1,
                    ModelsQuestionStatus::Review => stats.review_count += 1,
                }
                total_attempts += card.attempt_count;
                total_correct += card.correct_count;
            }
        }

        if total_attempts > 0 {
            stats.correct_rate = Some(total_correct as f64 / total_attempts as f64);
        }

        Ok(json!({
            "total": stats.total_count,
            "new": stats.new_count,
            "in_progress": stats.in_progress_count,
            "mastered": stats.mastered_count,
            "review": stats.review_count,
            "correct_rate": stats.correct_rate,
            "total_attempts": total_attempts,
            "total_correct": total_correct,
            "source": "preview_json",
            "degraded": true
        }))
    }

    async fn execute_get_next_question(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let mode = call
            .arguments
            .get("mode")
            .and_then(|v| v.as_str())
            .unwrap_or("sequential");
        let tag_filter = call.arguments.get("tag").and_then(|v| v.as_str());
        let current_card_id = call
            .arguments
            .get("current_card_id")
            .and_then(|v| v.as_str());
        let review_only = read_bool(&call.arguments, "review_only", false)?;

        // 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            let mut questions =
                self.list_all_questions(service, session_id, &QuestionFilters::default())?;
            if review_only {
                questions.retain(|question| matches!(question.status, QuestionStatus::Review));
            }
            if questions.is_empty() {
                return Ok(with_localized_message(
                    json!({ "found": false }),
                    "chat.tools.qbank.no_matching_questions",
                    json!({}),
                    "没有符合条件的题目",
                    "No questions match the requested filters.",
                ));
            }

            let next_question: Option<&Question> = match mode {
                "random" => {
                    use rand::seq::SliceRandom;
                    questions.choose(&mut rand::thread_rng())
                }
                "review_first" => questions
                    .iter()
                    .find(|q| matches!(q.status, QuestionStatus::Review))
                    .or_else(|| {
                        questions
                            .iter()
                            .find(|q| matches!(q.status, QuestionStatus::New))
                    })
                    .or_else(|| {
                        questions
                            .iter()
                            .find(|q| matches!(q.status, QuestionStatus::InProgress))
                    }),
                "by_tag" => {
                    if let Some(tag) = tag_filter {
                        questions.iter().find(|q| {
                            q.tags.contains(&tag.to_string())
                                && !matches!(q.status, QuestionStatus::Mastered)
                        })
                    } else {
                        questions.first()
                    }
                }
                _ => {
                    if let Some(current_id) = current_card_id {
                        let current_idx = questions
                            .iter()
                            .position(|q| q.card_id.as_deref().unwrap_or(&q.id) == current_id);
                        if let Some(idx) = current_idx {
                            questions.get(idx + 1)
                        } else {
                            questions.first()
                        }
                    } else {
                        questions.first()
                    }
                }
            };

            return match next_question {
                Some(q) => Ok(json!({
                    "card_id": q.card_id.clone().unwrap_or_else(|| q.id.clone()),
                    "label": q.question_label,
                    "content": q.content,
                    "question_type": q.question_type,
                    "difficulty": q.difficulty,
                    "status": q.status,
                    "tags": q.tags,
                    "images": q.images,
                    "source": "questions_table"
                })),
                None => Ok(with_localized_message(
                    json!({ "found": false }),
                    "chat.tools.qbank.no_more_questions",
                    json!({}),
                    "没有更多题目",
                    "There are no more questions.",
                )),
            };
        }

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut all_cards: Vec<&ExamCardPreview> =
            preview.pages.iter().flat_map(|p| p.cards.iter()).collect();

        if review_only {
            all_cards.retain(|card| matches!(card.status, ModelsQuestionStatus::Review));
        }

        if all_cards.is_empty() {
            return Ok(with_localized_message(
                json!({ "found": false }),
                "chat.tools.qbank.no_matching_questions",
                json!({}),
                "没有符合条件的题目",
                "No questions match the requested filters.",
            ));
        }

        let next_card: Option<&ExamCardPreview> = match mode {
            "random" => {
                use rand::seq::SliceRandom;
                all_cards.choose(&mut rand::thread_rng()).copied()
            }
            "review_first" => all_cards
                .iter()
                .find(|c| matches!(c.status, ModelsQuestionStatus::Review))
                .or_else(|| {
                    all_cards
                        .iter()
                        .find(|c| matches!(c.status, ModelsQuestionStatus::New))
                })
                .or_else(|| {
                    all_cards
                        .iter()
                        .find(|c| matches!(c.status, ModelsQuestionStatus::InProgress))
                })
                .copied(),
            "by_tag" => {
                if let Some(tag) = tag_filter {
                    all_cards
                        .iter()
                        .find(|c| {
                            c.tags.contains(&tag.to_string())
                                && !matches!(c.status, ModelsQuestionStatus::Mastered)
                        })
                        .copied()
                } else {
                    all_cards.first().copied()
                }
            }
            _ => {
                if let Some(current_id) = current_card_id {
                    let current_idx = all_cards.iter().position(|c| c.card_id == current_id);
                    if let Some(idx) = current_idx {
                        all_cards.get(idx + 1).copied()
                    } else {
                        all_cards.first().copied()
                    }
                } else {
                    all_cards.first().copied()
                }
            }
        };

        match next_card {
            Some(card) => Ok(json!({
                "card_id": card.card_id,
                "label": card.question_label,
                "content": card.ocr_text,
                "question_type": card.question_type,
                "difficulty": card.difficulty,
                "status": card.status,
                "tags": card.tags,
                "source": "preview_json",
                "degraded": true
            })),
            None => Ok(with_localized_message(
                json!({ "found": false }),
                "chat.tools.qbank.no_more_questions",
                json!({}),
                "没有更多题目",
                "There are no more questions.",
            )),
        }
    }

    async fn execute_start_timed_practice(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let exam_id = required_non_empty_string(&call.arguments, "session_id")?;
        let duration_minutes = read_strict_u32(&call.arguments, "duration_minutes", 30, 1, 480)?;
        let question_count = read_strict_u32(&call.arguments, "question_count", 20, 1, 100)?;
        let session = service
            .start_timed_practice(&exam_id, duration_minutes, question_count)
            .map_err(|error| error.to_string())?;
        let session_value = serde_json::to_value(&session).map_err(|error| {
            qbank_error(
                "QBANK_HANDOFF_INVALID",
                format!("限时练习会话序列化失败: {error}"),
                "重新生成限时练习",
            )
        })?;
        let handoff = Self::practice_handoff(&exam_id, "timed", session_value)?;
        let workbench_action = Self::practice_workbench_action(&exam_id, &handoff);

        Ok(with_localized_message(
            json!({
                "success": true,
                "session": session,
                "handoff": handoff,
                "session_state": "handoff_ready",
                "handoff_persisted": true,
                "handoff_durability": "chat_tool_result",
                "session_persisted": false,
                "session_hydrated": false,
                "requires_user_interaction": true,
                "agentCanAnswer": false,
                "workbenchAction": workbench_action,
            }),
            "chat.tools.qbank.timed_practice_ready",
            json!({ "durationMinutes": duration_minutes, "questionCount": question_count }),
            "已创建可重放的限时练习交接；执行 workbenchAction 后可在题库 UI 继续作答",
            "A replayable timed-practice handoff is ready. Execute workbenchAction to continue answering in the question bank UI.",
        ))
    }

    async fn execute_generate_mock_exam(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let exam_id = required_non_empty_string(&call.arguments, "session_id")?;
        let source = call.arguments.get("config").unwrap_or(&call.arguments);
        let duration_minutes = read_strict_u32(source, "duration_minutes", 60, 1, 480)?;
        let total_count = read_strict_u32(source, "total_count", 20, 1, 100)?;
        let type_distribution = parse_count_map(
            source.get("type_distribution"),
            "type_distribution",
            &[
                "single_choice",
                "multiple_choice",
                "indefinite_choice",
                "fill_blank",
                "true_false",
                "matching",
                "ordering",
                "numeric",
                "short_answer",
                "essay",
                "calculation",
                "proof",
                "other",
            ],
            100,
        )?;
        let difficulty_distribution = parse_count_map(
            source.get("difficulty_distribution"),
            "difficulty_distribution",
            &["easy", "medium", "hard", "very_hard"],
            100,
        )?;
        let tags = source
            .get("tags")
            .map(|value| parse_string_array(value, "tags", 20, 100))
            .transpose()?;
        let config = MockExamConfig {
            duration_minutes,
            type_distribution,
            difficulty_distribution,
            total_count: Some(total_count),
            shuffle: read_bool(source, "shuffle", true)?,
            include_mistakes: read_bool(source, "include_mistakes", true)?,
            tags,
        };
        let session = service
            .generate_mock_exam(&exam_id, config)
            .map_err(|error| error.to_string())?;
        let session_value = serde_json::to_value(&session).map_err(|error| {
            qbank_error(
                "QBANK_HANDOFF_INVALID",
                format!("模拟考会话序列化失败: {error}"),
                "重新生成模拟考",
            )
        })?;
        let handoff = Self::practice_handoff(&exam_id, "mock_exam", session_value)?;
        let workbench_action = Self::practice_workbench_action(&exam_id, &handoff);

        Ok(with_localized_message(
            json!({
                "success": true,
                "session": session,
                "handoff": handoff,
                "session_state": "handoff_ready",
                "handoff_persisted": true,
                "handoff_durability": "chat_tool_result",
                "session_persisted": false,
                "session_hydrated": false,
                "requires_user_interaction": true,
                "agentCanAnswer": false,
                "workbenchAction": workbench_action,
            }),
            "chat.tools.qbank.mock_exam_ready",
            json!({ "durationMinutes": duration_minutes, "questionCount": total_count }),
            "已创建可重放的模拟考交接；执行 workbenchAction 后必须由用户在题库 UI 作答",
            "A replayable mock-exam handoff is ready. Execute workbenchAction, then the user must answer in the question bank UI.",
        ))
    }

    async fn execute_submit_mock_exam(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        if call
            .arguments
            .get("submission_source")
            .and_then(Value::as_str)
            != Some("qbank_ui")
        {
            return Err(qbank_error(
                "QBANK_UI_RESULTS_REQUIRED",
                "模拟考交卷只接受 qbank_ui 产生的作答结果",
                "让用户先在题库 UI 完成作答；Agent 不得代填 answers/results",
            ));
        }
        let session_value = call.arguments.get("session").ok_or_else(|| {
            qbank_error(
                "INVALID_ARGS",
                "缺少 UI 返回的 session",
                "从题库 UI 取得完整模拟考会话后重试",
            )
        })?;
        let session: MockExamSession =
            serde_json::from_value(session_value.clone()).map_err(|e| {
                qbank_error(
                    "INVALID_ARGS",
                    format!("session 格式无效: {e}"),
                    "必须原样传入题库 UI 产生的完整模拟考会话",
                )
            })?;
        if !session.is_submitted || session.ended_at.is_none() || session.answers.is_empty() {
            return Err(qbank_error(
                "QBANK_UI_RESULTS_REQUIRED",
                "模拟考尚无已提交且已结束的用户作答",
                "让用户在题库 UI 作答并交卷后重试",
            ));
        }
        let answer_ids: HashSet<&String> = session.answers.keys().collect();
        let result_ids: HashSet<&String> = session.results.keys().collect();
        if answer_ids != result_ids {
            return Err(qbank_error(
                "QBANK_INVALID_UI_RESULTS",
                "session.answers 与 session.results 的题目集合不一致",
                "重新从题库 UI 读取完整交卷结果",
            ));
        }
        let question_ids: HashSet<&String> = session.question_ids.iter().collect();
        if answer_ids.iter().any(|id| !question_ids.contains(*id)) {
            return Err(qbank_error(
                "QBANK_INVALID_UI_RESULTS",
                "作答结果包含不属于本次模拟考的题目",
                "重新从题库 UI 读取完整交卷结果",
            ));
        }
        let service = self.require_service(ctx)?;
        for question_id in &session.question_ids {
            let question = service
                .get_question(question_id)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| {
                    qbank_error(
                        "QBANK_QUESTION_NOT_FOUND",
                        format!("模拟考题目不存在: {question_id}"),
                        "重新生成模拟考后再作答",
                    )
                })?;
            if question.exam_id != session.exam_id {
                return Err(qbank_error(
                    "QBANK_INVALID_UI_RESULTS",
                    format!("题目 {question_id} 不属于会话题目集"),
                    "重新从题库 UI 读取完整交卷结果",
                ));
            }
        }
        let score_card = service
            .submit_mock_exam(&session)
            .map_err(|error| error.to_string())?;

        Ok(with_localized_message(
            json!({
                "success": true,
                "score_card": score_card,
                "submission_source": "qbank_ui",
                "persisted": false,
                "requires_user_interaction": false,
                "agentCanAnswer": false,
            }),
            "chat.tools.qbank.mock_exam_scored",
            json!({ "persisted": false }),
            "已汇总用户在题库 UI 中产生的交卷结果；本服务当前不持久化模拟考会话",
            "The score card was calculated from the user's question bank UI submission. This service does not currently persist mock-exam sessions.",
        ))
    }

    async fn execute_get_daily_practice(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let exam_id = required_non_empty_string(&call.arguments, "session_id")?;
        let count = read_strict_u32(&call.arguments, "count", 10, 1, 20)?;
        let practice = service
            .get_daily_practice(&exam_id, count)
            .map_err(|error| error.to_string())?;
        let practice_value = serde_json::to_value(&practice).map_err(|error| {
            qbank_error(
                "QBANK_HANDOFF_INVALID",
                format!("每日一练序列化失败: {error}"),
                "重新生成每日一练",
            )
        })?;
        let handoff = Self::practice_handoff(&exam_id, "daily", practice_value)?;
        let workbench_action = Self::practice_workbench_action(&exam_id, &handoff);
        Ok(json!({
            "success": true,
            "practice": practice,
            "handoff": handoff,
            "session_state": "handoff_ready",
            "handoff_persisted": true,
            "handoff_durability": "chat_tool_result",
            "session_persisted": false,
            "session_hydrated": false,
            "requires_user_interaction": true,
            "agentCanAnswer": false,
            "workbenchAction": workbench_action,
        }))
    }

    async fn execute_get_check_in_calendar(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let year = call
            .arguments
            .get("year")
            .and_then(Value::as_i64)
            .filter(|year| (1970..=9999).contains(year))
            .ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    "year 必须是 1970..=9999 的整数",
                    "修正年份后重试",
                )
            })? as i32;
        let month = read_strict_u32(&call.arguments, "month", 1, 1, 12)?;
        let calendar = service
            .get_check_in_calendar(
                call.arguments.get("session_id").and_then(Value::as_str),
                year,
                month,
            )
            .map_err(|error| error.to_string())?;
        let (page, page_size, start, end) =
            Self::page_bounds(&call.arguments, calendar.days.len())?;
        Ok(json!({
            "session_id": calendar.exam_id,
            "year": calendar.year,
            "month": calendar.month,
            "days": &calendar.days[start..end],
            "streak_days": calendar.streak_days,
            "month_check_in_days": calendar.month_check_in_days,
            "month_total_questions": calendar.month_total_questions,
            "total": calendar.days.len(),
            "page": page,
            "page_size": page_size,
            "has_more": end < calendar.days.len(),
            "truncated": end < calendar.days.len(),
        }))
    }

    async fn execute_get_learning_trend(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let start_date = parse_iso_date(&call.arguments, "start_date")?;
        let end_date = parse_iso_date(&call.arguments, "end_date")?;
        if end_date < start_date || (end_date - start_date).num_days() > 366 {
            return Err(qbank_error(
                "INVALID_ARGS",
                "日期范围必须正序且不超过 367 天",
                "缩短日期范围后重试",
            ));
        }
        let points = service
            .get_learning_trend(
                call.arguments.get("session_id").and_then(Value::as_str),
                &start_date.format("%Y-%m-%d").to_string(),
                &end_date.format("%Y-%m-%d").to_string(),
            )
            .map_err(|error| error.to_string())?;
        let (page, page_size, start, end) = Self::page_bounds(&call.arguments, points.len())?;
        Ok(json!({
            "points": &points[start..end],
            "total": points.len(),
            "page": page,
            "page_size": page_size,
            "has_more": end < points.len(),
            "truncated": end < points.len(),
        }))
    }

    async fn execute_get_activity_heatmap(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let year = call
            .arguments
            .get("year")
            .and_then(Value::as_i64)
            .filter(|year| (1970..=9999).contains(year))
            .ok_or_else(|| {
                qbank_error(
                    "INVALID_ARGS",
                    "year 必须是 1970..=9999 的整数",
                    "修正年份后重试",
                )
            })? as i32;
        let points = service
            .get_activity_heatmap(
                call.arguments.get("session_id").and_then(Value::as_str),
                year,
            )
            .map_err(|error| error.to_string())?;
        let (page, page_size, start, end) = Self::page_bounds(&call.arguments, points.len())?;
        Ok(json!({
            "year": year,
            "points": &points[start..end],
            "total": points.len(),
            "page": page,
            "page_size": page_size,
            "has_more": end < points.len(),
            "truncated": end < points.len(),
        }))
    }

    async fn execute_get_knowledge_stats(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let points = service
            .get_knowledge_stats(call.arguments.get("session_id").and_then(Value::as_str))
            .map_err(|error| error.to_string())?;
        let (page, page_size, start, end) = Self::page_bounds(&call.arguments, points.len())?;
        Ok(json!({
            "knowledge_points": &points[start..end],
            "total": points.len(),
            "page": page,
            "page_size": page_size,
            "has_more": end < points.len(),
            "truncated": end < points.len(),
        }))
    }

    async fn execute_generate_paper(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let service = self.require_service(ctx)?;
        let exam_id = required_non_empty_string(&call.arguments, "session_id")?;
        let source = call.arguments.get("config").unwrap_or(&call.arguments);
        let title =
            optional_string(source, "title", 120)?.unwrap_or_else(|| "练习试卷".to_string());
        let type_selection = parse_count_map(
            source.get("type_selection"),
            "type_selection",
            &[
                "single_choice",
                "multiple_choice",
                "indefinite_choice",
                "fill_blank",
                "true_false",
                "matching",
                "ordering",
                "numeric",
                "short_answer",
                "essay",
                "calculation",
                "proof",
                "other",
            ],
            100,
        )?;
        let requested_count = read_strict_u32(source, "question_count", 20, 1, 100)?;
        let difficulty_filter = source
            .get("difficulty_filter")
            .map(|value| parse_string_array(value, "difficulty_filter", 4, 20))
            .transpose()?;
        if let Some(difficulties) = &difficulty_filter {
            for difficulty in difficulties {
                parse_difficulty(&json!(difficulty), "difficulty_filter")?;
            }
        }
        let tags_filter = source
            .get("tags_filter")
            .map(|value| parse_string_array(value, "tags_filter", 20, 100))
            .transpose()?;
        let export_format = source
            .get("export_format")
            .map(|value| {
                serde_json::from_value::<PaperExportFormat>(value.clone()).map_err(|_| {
                    qbank_error(
                        "INVALID_ARGS",
                        "export_format 不受支持",
                        "仅支持 preview 或 markdown",
                    )
                })
            })
            .transpose()?
            .unwrap_or(PaperExportFormat::Preview);
        if matches!(
            export_format,
            PaperExportFormat::Pdf | PaperExportFormat::Word
        ) {
            return Err(qbank_error(
                "QBANK_EXPORT_FORMAT_UNSUPPORTED",
                "组卷工具当前未实现 PDF/Word 文件导出",
                "使用 preview 或 markdown；不得把无路径结果当作已生成文件",
            ));
        }
        let config = PaperConfig {
            title,
            type_selection: type_selection.clone(),
            difficulty_filter,
            tags_filter,
            shuffle: read_bool(source, "shuffle", true)?,
            include_answers: read_bool(source, "include_answers", true)?,
            include_explanations: read_bool(source, "include_explanations", true)?,
            export_format: export_format.clone(),
        };
        let mut paper = service
            .generate_paper(&exam_id, config)
            .map_err(|error| error.to_string())?;
        if type_selection.is_empty() && paper.questions.len() > requested_count as usize {
            paper.questions.truncate(requested_count as usize);
            paper.total_score = paper.questions.len() as u32;
        }
        let file_created = export_format == PaperExportFormat::Markdown;
        if file_created {
            let app_data_dir = ctx
                .window_ref()
                .app_handle()
                .path()
                .app_data_dir()
                .map_err(|error| {
                    qbank_error(
                        "QBANK_EXPORT_FAILED",
                        format!("无法解析应用数据目录: {error}"),
                        "重新打开应用后重试",
                    )
                })?;
            let export_path =
                write_markdown_paper(&paper, &app_data_dir.join("exports").join("qbank"))?;
            paper.export_path = Some(export_path);
        }
        let preview_count = paper.questions.len().min(20);
        let question_previews: Vec<Value> = paper.questions[..preview_count]
            .iter()
            .map(question_to_bounded_value)
            .collect();

        let (message_key, zh_cn, en_us) = if file_created {
            (
                "chat.tools.qbank.paper_markdown_created",
                "Markdown 试卷已真实写入应用数据导出目录",
                "The Markdown paper was written to the application export directory.",
            )
        } else {
            (
                "chat.tools.qbank.paper_preview_created",
                "仅生成内存预览，未创建任何文件",
                "Only an in-memory preview was generated; no file was created.",
            )
        };
        Ok(with_localized_message(
            json!({
                "success": true,
                "paper_id": paper.id,
                "title": paper.title,
                "session_id": paper.exam_id,
                "total_score": paper.total_score,
                "question_count": paper.questions.len(),
                "questions": question_previews,
                "questions_truncated": preview_count < paper.questions.len(),
                "created_at": paper.created_at,
                "export_format": paper.config.export_format,
                "export_path": paper.export_path,
                "file_created": file_created,
                "requires_user_interaction": export_format == PaperExportFormat::Preview,
            }),
            message_key,
            json!({ "fileCreated": file_created, "format": export_format }),
            zh_cn,
            en_us,
        ))
    }

    async fn execute_reset_progress(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let _write_guard = QBANK_WRITE_LOCK.lock().await;

        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let card_ids: Option<Vec<&str>> = call
            .arguments
            .get("card_ids")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect());

        // 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            if let Some(card_ids) = &card_ids {
                let mut question_ids = Vec::new();
                let mut found_card_ids: Vec<String> = Vec::new();
                let mut missing_card_ids: Vec<String> = Vec::new();
                for card_id in card_ids {
                    match service.get_question_by_card_id(session_id, card_id) {
                        Ok(Some(q)) => {
                            question_ids.push(q.id);
                            found_card_ids.push((*card_id).to_string());
                        }
                        Ok(None) => missing_card_ids.push((*card_id).to_string()),
                        Err(e) => return Err(format!("Failed to resolve card_id {card_id}: {e}")),
                    }
                }
                // 之前的实现会静默跳过不存在的 card_id，让调用方误以为全部重置成功
                if question_ids.is_empty() {
                    return Err(qbank_error(
                        "QBANK_QUESTION_NOT_FOUND",
                        format!("card_ids 均不存在于题目集 {session_id}"),
                        "先用 qbank_list_questions 确认有效的 card_id 后重试",
                    ));
                }
                let result = service
                    .reset_questions_progress(&question_ids)
                    .map_err(|e| format!("Failed to reset progress: {}", e))?;
                emit_qbank_changed(ctx, "reset_progress", &found_card_ids);
                return Ok(with_localized_message(
                    json!({
                        "success": true,
                        "reset_count": result.success_count,
                        "missing_card_ids": missing_card_ids,
                        "source": "questions_table"
                    }),
                    "chat.tools.qbank.progress_reset",
                    json!({ "count": result.success_count }),
                    format!("已重置 {} 道题目的学习进度", result.success_count),
                    format!(
                        "Reset learning progress for {} questions.",
                        result.success_count
                    ),
                ));
            } else {
                let stats = service
                    .reset_progress(session_id)
                    .map_err(|e| format!("Failed to reset progress: {}", e))?;
                // 全量重置：entityIds 用 session_id 作为集合级标识
                emit_qbank_changed(ctx, "reset_progress", &[session_id.to_string()]);
                return Ok(with_localized_message(
                    json!({
                        "success": true,
                        "reset_count": stats.total_count,
                        "source": "questions_table"
                    }),
                    "chat.tools.qbank.progress_reset",
                    json!({ "count": stats.total_count }),
                    format!("已重置 {} 道题目的学习进度", stats.total_count),
                    format!(
                        "Reset learning progress for {} questions.",
                        stats.total_count
                    ),
                ));
            }
        }

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;
        // ACR 4.0 P1：preview_json 回落写路径补 OCC
        let preview_revision = exam.updated_at.clone();

        let mut preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let mut reset_count = 0;
        for page in &mut preview.pages {
            for card in &mut page.cards {
                let should_reset = card_ids
                    .as_ref()
                    .map(|ids| ids.contains(&card.card_id.as_str()))
                    .unwrap_or(true);

                if should_reset {
                    card.status = ModelsQuestionStatus::New;
                    card.user_answer = None;
                    card.is_correct = None;
                    card.attempt_count = 0;
                    card.correct_count = 0;
                    card.last_attempt_at = None;
                    reset_count += 1;
                }
            }
        }

        let preview_json = serde_json::to_value(&preview)
            .map_err(|e| format!("Failed to serialize preview: {}", e))?;

        let occ_ok = VfsExamRepo::update_preview_json_if_unchanged(
            vfs_db,
            session_id,
            preview_json,
            &preview_revision,
        )
        .map_err(|e| format!("Failed to update exam sheet: {}", e))?;
        if !occ_ok {
            return Err(qbank_conflict_error(
                "题目集在读取后已被并发修改，进度重置未写入",
                "重新读取题目集最新状态后再重置进度；不要凭旧状态重试",
                json!({ "session_id": session_id, "expected_updated_at": preview_revision }),
            ));
        }

        let entity_ids: Vec<String> = if let Some(ids) = &card_ids {
            ids.iter().map(|id| (*id).to_string()).collect()
        } else {
            vec![session_id.to_string()]
        };
        emit_qbank_changed(ctx, "reset_progress", &entity_ids);

        Ok(with_localized_message(
            json!({
                "success": true,
                "reset_count": reset_count,
                "source": "preview_json",
                "degraded": true
            }),
            "chat.tools.qbank.progress_reset",
            json!({ "count": reset_count }),
            format!("已重置 {} 道题目的学习进度", reset_count),
            format!("Reset learning progress for {} questions.", reset_count),
        ))
    }

    async fn execute_export(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let format = call
            .arguments
            .get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("json");
        let include_stats = call
            .arguments
            .get("include_stats")
            .and_then(|v| v.as_bool())
            .unwrap_or(true);
        let filter_status = call.arguments.get("filter_status").and_then(|v| v.as_str());

        if !matches!(format, "json" | "markdown" | "docx") {
            return Err(qbank_error(
                "INVALID_ARGS",
                "format 仅支持 json、markdown 或 docx",
                "修正导出格式后重试",
            ));
        }

        let (name, questions, source, degraded) = if let Some(service) = &ctx.question_bank_service
        {
            let name = ctx
                .vfs_db
                .as_ref()
                .and_then(|db| VfsExamRepo::get_exam_sheet(db, session_id).ok().flatten())
                .and_then(|exam| exam.exam_name)
                .unwrap_or_else(|| "题目集".to_string());
            let status = filter_status
                .and_then(|value| serde_json::from_value(json!(value)).ok())
                .map(|value| vec![value]);
            let questions = self
                .list_all_questions(
                    service,
                    session_id,
                    &QuestionFilters {
                        status,
                        ..Default::default()
                    },
                )?
                .iter()
                .map(|question| {
                    json!({
                        "label": question.question_label,
                        "content": question.content,
                        "question_type": question.question_type,
                        "options": question.options,
                        "answer": question.answer,
                        "explanation": question.explanation,
                        // 新题型判分数据随导出携带，保证 JSON 导出→batch_import 回灌可判分
                        "structured_data": question.structured_data,
                        "difficulty": question.difficulty,
                        "tags": question.tags,
                        "status": question.status,
                        "attempt_count": question.attempt_count,
                        "correct_count": question.correct_count,
                        "user_note": question.user_note,
                        "images": question.images,
                    })
                })
                .collect::<Vec<Value>>();
            (name, questions, "questions_table", false)
        } else {
            let db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
            let exam = VfsExamRepo::get_exam_sheet(db, session_id)
                .map_err(|error| format!("Failed to get exam sheet: {error}"))?
                .ok_or("Exam sheet not found")?;
            let name = exam.exam_name.unwrap_or_else(|| "题目集".to_string());
            let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
                .map_err(|error| format!("Failed to parse preview: {error}"))?;
            let questions = preview
                .pages
                .iter()
                .flat_map(|page| &page.cards)
                .filter_map(|card| {
                    let card_status = serde_json::to_value(&card.status).ok()?;
                    if filter_status.is_some_and(|status| card_status.as_str() != Some(status)) {
                        return None;
                    }
                    Some(json!({
                        "label": card.question_label,
                        "content": card.ocr_text,
                        "question_type": card.question_type,
                        "answer": card.answer,
                        "explanation": card.explanation,
                        "difficulty": card.difficulty,
                        "tags": card.tags,
                        "status": card.status,
                        "attempt_count": card.attempt_count,
                        "correct_count": card.correct_count,
                        "user_note": card.user_note,
                    }))
                })
                .collect::<Vec<Value>>();
            (name, questions, "preview_json", true)
        };

        let (extension, bytes) = match format {
            "markdown" => (
                "md",
                render_question_export_markdown(&name, &questions).into_bytes(),
            ),
            "docx" => ("docx", render_question_export_docx(&name, &questions)?),
            _ => (
                "json",
                serde_json::to_vec_pretty(&json!({ "name": name, "questions": questions }))
                    .map_err(|error| {
                        qbank_error(
                            "QBANK_EXPORT_FAILED",
                            format!("JSON 序列化失败: {error}"),
                            "重新导出",
                        )
                    })?,
            ),
        };
        let export_path = write_qbank_export(ctx, &name, extension, &bytes)?;
        let mut result = json!({
            "success": true,
            "format": format,
            "exportPath": export_path,
            "fileSize": bytes.len(),
            "questionCount": questions.len(),
            "questions": bounded_export_preview(&questions),
            "questionsTruncated": questions.len() > 20,
            "source": source,
            "degraded": degraded,
        });
        if include_stats {
            result["stats"] = self.execute_get_stats(call, ctx).await?;
        }
        Ok(result)
    }

    /// P2-1: 变式生成 - 返回原题信息，由 AI 在对话中生成变式题
    async fn execute_generate_variant(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'session_id' parameter")?;
        let card_id = call
            .arguments
            .get("card_id")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'card_id' parameter")?;
        let variant_type = call
            .arguments
            .get("variant_type")
            .and_then(|v| v.as_str())
            .unwrap_or("similar");

        // 优先使用 QuestionBankService
        if let Some(service) = &ctx.question_bank_service {
            if let Ok(Some(q)) = service.get_question_by_card_id(session_id, card_id) {
                let variant_prompt = match variant_type {
                    "harder" => "请基于以下原题生成一道**更难**的变式题。保持相同的知识点和题型，但增加难度（如增加步骤、引入更复杂的条件）。",
                    "easier" => "请基于以下原题生成一道**更简单**的变式题。保持相同的知识点和题型，但降低难度（如简化条件、减少步骤）。",
                    "different_context" => "请基于以下原题生成一道**不同情境**的变式题。保持相同的知识点和解题方法，但更换题目背景（如换个应用场景）。",
                    _ => "请基于以下原题生成一道**相似难度**的变式题。保持相同的知识点、题型和难度，但改变具体数值或细节。",
                };

                return Ok(json!({
                    "action": "generate_variant",
                    "original_question": {
                        "card_id": q.card_id.clone().unwrap_or_else(|| q.id.clone()),
                        "label": q.question_label,
                        "content": q.content,
                        "question_type": q.question_type,
                        "answer": q.answer,
                        "explanation": q.explanation,
                        "difficulty": q.difficulty,
                        "tags": q.tags,
                        "images": q.images,
                    },
                    "variant_type": variant_type,
                    "prompt": variant_prompt,
                    "instruction": format!(
                        "{}\n\n**原题**：\n{}\n\n**原题答案**：{}\n\n请生成变式题，包含：1) 新的题干 2) 正确答案 3) 解析",
                        variant_prompt,
                        q.content,
                        q.answer.clone().unwrap_or_else(|| "未提供".to_string())
                    ),
                    "session_id": session_id,
                    "hint": "AI 将基于原题生成变式题。生成后可使用 qbank_batch_import 将新题目导入题目集。",
                    "source": "questions_table"
                }));
            }
        }

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let exam = VfsExamRepo::get_exam_sheet(vfs_db, session_id)
            .map_err(|e| format!("Failed to get exam sheet: {}", e))?
            .ok_or("Exam sheet not found")?;

        let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
            .map_err(|e| format!("Failed to parse preview: {}", e))?;

        let card = preview
            .pages
            .iter()
            .flat_map(|p| p.cards.iter())
            .find(|c| c.card_id == card_id)
            .ok_or("Question not found")?;

        let variant_prompt = match variant_type {
            "harder" => "请基于以下原题生成一道**更难**的变式题。保持相同的知识点和题型，但增加难度（如增加步骤、引入更复杂的条件）。",
            "easier" => "请基于以下原题生成一道**更简单**的变式题。保持相同的知识点和题型，但降低难度（如简化条件、减少步骤）。",
            "different_context" => "请基于以下原题生成一道**不同情境**的变式题。保持相同的知识点和解题方法，但更换题目背景（如换个应用场景）。",
            _ => "请基于以下原题生成一道**相似难度**的变式题。保持相同的知识点、题型和难度，但改变具体数值或细节。",
        };

        Ok(json!({
            "action": "generate_variant",
            "original_question": {
                "card_id": card.card_id,
                "label": card.question_label,
                "content": card.ocr_text,
                "question_type": card.question_type,
                "answer": card.answer,
                "explanation": card.explanation,
                "difficulty": card.difficulty,
                "tags": card.tags,
            },
            "variant_type": variant_type,
            "prompt": variant_prompt,
            "instruction": format!(
                "{}\n\n**原题**：\n{}\n\n**原题答案**：{}\n\n请生成变式题，包含：1) 新的题干 2) 正确答案 3) 解析",
                variant_prompt,
                card.ocr_text,
                card.answer.clone().unwrap_or_else(|| "未提供".to_string())
            ),
            "session_id": session_id,
            "hint": "AI 将基于原题生成变式题。生成后可使用 qbank_batch_import 将新题目导入题目集。",
            "source": "preview_json",
            "degraded": true
        }))
    }

    /// P2-4: 文档导入 - 使用统一的 QuestionImportService
    ///
    /// 与 Tauri 命令 `import_question_bank` 使用相同的实现
    async fn execute_import_document(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        use crate::question_import_service::{ImportRequest, QuestionImportService};

        let _write_guard = QBANK_WRITE_LOCK.lock().await;

        let content = call
            .arguments
            .get("content")
            .and_then(|v| v.as_str())
            .ok_or("Missing 'content' parameter")?;
        let format = call
            .arguments
            .get("format")
            .and_then(|v| v.as_str())
            .unwrap_or("txt");
        let name = call.arguments.get("name").and_then(|v| v.as_str());
        let session_id = call.arguments.get("session_id").and_then(|v| v.as_str());
        let folder_id = call.arguments.get("folder_id").and_then(|v| v.as_str());

        let llm_manager = ctx
            .llm_manager
            .as_ref()
            .ok_or("LLM Manager not available")?;
        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;

        // 使用统一的 QuestionImportService
        let import_service = QuestionImportService::new_without_file_manager(llm_manager.clone());

        let import_request = ImportRequest {
            content: content.to_string(),
            format: format.to_string(),
            name: name.map(String::from),
            session_id: session_id.map(String::from),
            folder_id: folder_id.map(String::from),
            model_config_id: None,
            pdf_prefer_ocr: None,
        };

        let result = import_service
            .import_document(vfs_db, import_request)
            .await
            .map_err(|e| format!("导入失败: {}", e))?;

        emit_qbank_changed(
            ctx,
            "import_document",
            std::slice::from_ref(&result.session_id),
        );

        Ok(with_localized_message(
            json!({
                "success": true,
                "session_id": result.session_id,
                "name": result.name,
                "imported_count": result.imported_count,
                "total_questions": result.total_questions,
            }),
            "chat.tools.qbank.questions_imported",
            json!({ "count": result.imported_count }),
            format!("成功导入 {} 道题目", result.imported_count),
            format!("Imported {} questions successfully.", result.imported_count),
        ))
    }

    /// P2-3: 批量导入 - 解析 AI 生成的题目并添加到题目集
    async fn execute_batch_import(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<Value, String> {
        use crate::vfs::types::VfsCreateExamSheetParams;

        let _write_guard = QBANK_WRITE_LOCK.lock().await;

        let session_id = call
            .arguments
            .get("session_id")
            .and_then(|v| v.as_str())
            .map(|v| v.to_string());
        let name = call
            .arguments
            .get("name")
            .and_then(|v| v.as_str())
            .map(String::from);
        // ★ 容错处理：部分模型可能将 questions 序列化为 JSON 字符串而非数组
        let questions_value = call.arguments.get("questions");
        let parsed_questions: Option<Vec<Value>>;
        let questions: &Vec<Value> = if let Some(arr) = questions_value.and_then(|v| v.as_array()) {
            arr
        } else if let Some(s) = questions_value.and_then(|v| v.as_str()) {
            parsed_questions = serde_json::from_str(s).ok();
            parsed_questions
                .as_ref()
                .ok_or("'questions' parameter is a string but not valid JSON array")?
        } else {
            return Err("Missing 'questions' parameter".to_string());
        };
        if questions.is_empty() {
            return Err(qbank_error(
                "INVALID_ARGS",
                "questions 不能为空",
                "传入至少一道题目",
            ));
        }
        if questions.len() > 200 {
            return Err(qbank_error(
                "INVALID_ARGS",
                format!("questions 单次最多 200 道，收到 {}", questions.len()),
                "分批调用 qbank_batch_import 导入",
            ));
        }
        let top_parent_card_id = call
            .arguments
            .get("parent_card_id")
            .and_then(|v| v.as_str());

        let vfs_db = ctx.vfs_db.as_ref().ok_or("VFS database not available")?;
        let mut is_new_session = false;
        // ACR 4.0 P1：既有会话的 preview_json 回写带 OCC 基线（新会话无需）
        let (mut session_id, exam_name, mut preview, preview_revision) =
            if let Some(sid) = session_id {
                let exam = VfsExamRepo::get_exam_sheet(vfs_db, &sid)
                    .map_err(|e| format!("Failed to get exam sheet: {}", e))?
                    .ok_or("Exam sheet not found")?;
                let revision = exam.updated_at.clone();
                let preview: ExamSheetPreviewResult = serde_json::from_value(exam.preview_json)
                    .map_err(|e| format!("Failed to parse preview: {}", e))?;
                (
                    sid,
                    exam.exam_name.unwrap_or_else(|| "未命名题目集".to_string()),
                    preview,
                    Some(revision),
                )
            } else {
                let new_session_id = uuid::Uuid::new_v4().to_string();
                let exam_name = name.clone().unwrap_or_else(|| "导入的题目集".to_string());
                let preview = ExamSheetPreviewResult {
                    temp_id: new_session_id.clone(),
                    exam_name: Some(exam_name.clone()),
                    pages: Vec::new(),
                    raw_model_response: None,
                    instructions: None,
                    session_id: Some(new_session_id.clone()),
                };
                is_new_session = true;
                (new_session_id, exam_name, preview, None)
            };

        let mut imported_count = 0;
        let mut new_card_ids: Vec<String> = Vec::new();
        let mut question_params_list: Vec<CreateQuestionParams> = Vec::new();

        if preview.pages.is_empty() {
            preview.pages.push(ExamSheetPreviewPage {
                page_index: 0,
                cards: Vec::new(),
                blob_hash: None,
                width: None,
                height: None,
                original_image_path: String::new(),
                raw_ocr_text: None,
                ocr_completed: false,
                parse_completed: false,
            });
        }

        for (question_index, q) in questions.iter().enumerate() {
            let content = q
                .get("content")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .unwrap_or("");
            if content.is_empty() {
                // 之前静默 continue 会让模型误以为全部导入成功
                return Err(qbank_error(
                    "INVALID_ARGS",
                    format!("questions[{question_index}].content 必须是非空字符串"),
                    "修正该题后重新导入；本批次未写入任何题目",
                ));
            }

            let existing_count = preview.pages.iter().map(|p| p.cards.len()).sum::<usize>();
            let question_label = format!("Q{}", existing_count + 1);
            let card_id = format!(
                "card_{}",
                &uuid::Uuid::new_v4().to_string().replace("-", "")[..12]
            );
            let question_type = q.get("question_type").and_then(|v| v.as_str());
            // 之前无效题型/难度会被静默降级为 Other/None；改为结构化报错
            let repo_question_type = q
                .get("question_type")
                .map(|value| {
                    parse_repo_question_type(
                        value,
                        &format!("questions[{question_index}].question_type"),
                    )
                })
                .transpose()?;
            let repo_difficulty = q
                .get("difficulty")
                .map(|value| {
                    parse_difficulty(value, &format!("questions[{question_index}].difficulty"))
                })
                .transpose()?;
            let effective_type = repo_question_type.clone().unwrap_or_default();
            let structured_data = match q.get("structured_data") {
                Some(Value::Null) | None => {
                    if question_type_requires_structured_data(&effective_type) {
                        return Err(qbank_error(
                            "INVALID_ARGS",
                            format!(
                                "questions[{question_index}] 为 matching/ordering/numeric 题型，必须提供 structured_data"
                            ),
                            r#"matching 需 {"left","right","pairs"}；ordering 需 {"items","correct_order"}；numeric 需 {"answer_value",...}"#,
                        ));
                    }
                    None
                }
                Some(data) => {
                    validate_structured_data(&effective_type, data)?;
                    Some(data.clone())
                }
            };
            let answer = q.get("answer").and_then(|v| v.as_str()).map(String::from);
            if matches!(effective_type, RepoQuestionType::TrueFalse) {
                if let Some(answer) = &answer {
                    validate_true_false_answer(answer)?;
                }
            }
            let explanation = q
                .get("explanation")
                .and_then(|v| v.as_str())
                .map(String::from);
            let difficulty = q.get("difficulty").and_then(|v| v.as_str());
            let tags: Vec<String> = q
                .get("tags")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|t| t.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            let parent_card_id = q
                .get("parent_card_id")
                .and_then(|v| v.as_str())
                .or(top_parent_card_id);
            let parent_question_id = if let (Some(parent_card_id), Some(service)) =
                (parent_card_id, &ctx.question_bank_service)
            {
                service
                    .get_question_by_card_id(&session_id, parent_card_id)
                    .ok()
                    .flatten()
                    .map(|existing| existing.id)
            } else {
                None
            };

            let new_card = ExamCardPreview {
                card_id: card_id.clone(),
                page_index: 0,
                question_label: question_label.clone(),
                ocr_text: content.to_string(),
                tags,
                question_type: question_type
                    .and_then(|t| serde_json::from_str(&format!("\"{}\"", t)).ok()),
                answer,
                explanation,
                difficulty: difficulty
                    .and_then(|d| serde_json::from_str(&format!("\"{}\"", d)).ok()),
                status: ModelsQuestionStatus::New,
                source_type: SourceType::AiGenerated,
                parent_card_id: parent_card_id.map(String::from),
                ..Default::default()
            };

            preview.pages[0].cards.push(new_card);
            new_card_ids.push(card_id.clone());
            imported_count += 1;

            // 解析选项（仅 questions 表需要）
            let options: Option<Vec<QuestionOption>> =
                q.get("options").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|opt| {
                            let key = opt
                                .get("key")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            let content = opt
                                .get("content")
                                .and_then(|v| v.as_str())
                                .unwrap_or("")
                                .to_string();
                            if key.is_empty() && content.is_empty() {
                                None
                            } else {
                                Some(QuestionOption { key, content })
                            }
                        })
                        .collect()
                });
            // 与 create_question 一致：选择题必须携带非空 options，
            // 否则导入后 UI 无法作答（此前会静默写入无选项的选择题）
            if matches!(
                effective_type,
                RepoQuestionType::SingleChoice
                    | RepoQuestionType::MultipleChoice
                    | RepoQuestionType::IndefiniteChoice
            ) && options.as_ref().map(Vec::is_empty).unwrap_or(true)
            {
                return Err(qbank_error(
                    "INVALID_ARGS",
                    format!("questions[{question_index}] 是选择题但缺少非空 options"),
                    "把选项作为 {key,content} 数组传入；本批次未写入任何题目",
                ));
            }

            let question_params = CreateQuestionParams {
                exam_id: session_id.clone(),
                card_id: Some(card_id.clone()),
                question_label: Some(question_label),
                content: content.to_string(),
                options,
                answer: q.get("answer").and_then(|v| v.as_str()).map(String::from),
                explanation: q
                    .get("explanation")
                    .and_then(|v| v.as_str())
                    .map(String::from),
                question_type: repo_question_type,
                difficulty: repo_difficulty,
                tags: Some(
                    q.get("tags")
                        .and_then(|v| v.as_array())
                        .map(|arr| {
                            arr.iter()
                                .filter_map(|t| t.as_str().map(String::from))
                                .collect()
                        })
                        .unwrap_or_default(),
                ),
                source_type: Some(RepoSourceType::AiGenerated),
                source_ref: None,
                images: None,
                parent_id: parent_question_id.clone(),
                structured_data,
            };
            question_params_list.push(question_params);
        }

        if imported_count == 0 {
            return Err("未能导入题目：内容为空或格式不完整".to_string());
        }

        if imported_count > 0 {
            // 如果有 parent_card_id，更新父题的 variant_ids
            if let Some(parent_id) = top_parent_card_id {
                for page in &mut preview.pages {
                    for card in &mut page.cards {
                        if card.card_id == parent_id {
                            let mut variants = card.variant_ids.clone().unwrap_or_default();
                            variants.extend(new_card_ids.clone());
                            card.variant_ids = Some(variants);
                            break;
                        }
                    }
                }
            }

            let preview_json = serde_json::to_value(&preview)
                .map_err(|e| format!("Failed to serialize preview: {}", e))?;

            // S-009: 获取单一连接 + SAVEPOINT 事务保护，确保 preview_json 与 questions 原子写入
            let conn = vfs_db
                .get_conn_safe()
                .map_err(|e| format!("Failed to get db connection: {}", e))?;

            conn.execute("SAVEPOINT batch_import", [])
                .map_err(|e| format!("Failed to create savepoint: {}", e))?;

            // S-009-fix: 使用 actual_exam_id 追踪真实的 exam_sheets.id
            let mut actual_exam_id = session_id.clone();

            let sp_result = (|| -> Result<(), String> {
                if is_new_session {
                    let params = VfsCreateExamSheetParams {
                        exam_name: Some(exam_name.clone()),
                        temp_id: session_id.clone(),
                        metadata_json: json!({}),
                        preview_json,
                        status: "completed".to_string(),
                        folder_id: None,
                    };
                    let created_exam = VfsExamRepo::create_exam_sheet_with_conn(&conn, params)
                        .map_err(|e| format!("Failed to create exam sheet: {}", e))?;
                    // ★ 关键修复：使用 VfsExamSheet::generate_id() 生成的真实 ID
                    // 而非 uuid::Uuid 格式的 temp_id，否则 questions.exam_id FK 会违反约束
                    actual_exam_id = created_exam.id.clone();
                } else {
                    // ACR 4.0 P1：OCC 校验读取基线；冲突走 SAVEPOINT 回滚并返回结构化错误
                    let expected = preview_revision
                        .as_deref()
                        .ok_or("Missing preview revision for existing session")?;
                    let occ_ok = VfsExamRepo::update_preview_json_with_conn_if_unchanged(
                        &conn,
                        &session_id,
                        preview_json,
                        expected,
                    )
                    .map_err(|e| format!("Failed to update exam sheet: {}", e))?;
                    if !occ_ok {
                        return Err(qbank_conflict_error(
                            "题目集在读取后已被并发修改，批量导入未写入",
                            "重新读取题目集最新状态后再导入；不要凭旧状态重试",
                            json!({ "session_id": session_id, "expected_updated_at": expected }),
                        ));
                    }
                }

                // 逐条写入 questions 表（不使用 batch 版本，因其内部有独立事务）
                for params in &mut question_params_list {
                    // ★ 将每条题目的 exam_id 修正为真实的 exam_sheets.id
                    params.exam_id = actual_exam_id.clone();
                    VfsQuestionRepo::create_question_with_conn(&conn, params)
                        .map_err(|e| format!("Failed to write question: {}", e))?;
                }

                Ok(())
            })();

            match sp_result {
                Ok(()) => {
                    conn.execute("RELEASE batch_import", [])
                        .map_err(|e| format!("Failed to release savepoint: {}", e))?;
                }
                Err(e) => {
                    let _ = conn.execute("ROLLBACK TO batch_import", []);
                    let _ = conn.execute("RELEASE batch_import", []);
                    log::warn!(
                        "[QBankExecutor] S-009: batch_import SAVEPOINT rolled back: {}",
                        e
                    );
                    return Err(e);
                }
            }

            // 刷新统计（非关键，在 SAVEPOINT 外执行）
            if !question_params_list.is_empty() {
                if let Err(e) = VfsQuestionRepo::refresh_stats_with_conn(&conn, &actual_exam_id) {
                    log::warn!("[QuestionBank] 统计刷新失败: {}", e);
                }
            }

            // ★ 使用真实 exam_id 覆盖 session_id，确保返回值正确
            session_id = actual_exam_id;
        }

        emit_qbank_changed(ctx, "batch_import", &new_card_ids);

        Ok(with_localized_message(
            json!({
                "success": true,
                "session_id": session_id,
                "name": exam_name,
                "imported_count": imported_count,
                "total_questions": preview.pages.iter().map(|p| p.cards.len()).sum::<usize>(),
                "new_card_ids": new_card_ids,
            }),
            "chat.tools.qbank.questions_imported",
            json!({ "count": imported_count }),
            format!("成功导入 {} 道题目", imported_count),
            format!("Imported {} questions successfully.", imported_count),
        ))
    }
}

impl Default for QBankExecutor {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ToolExecutor for QBankExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        let name = strip_tool_namespace(tool_name);
        matches!(
            name,
            "qbank_list"
                | "qbank_list_questions"
                | "qbank_get_question"
                | "qbank_create_question"
                | "qbank_delete_questions"
                | "qbank_toggle_favorite"
                | "qbank_toggle_bookmark"
                | "qbank_get_submissions"
                | "qbank_get_question_history"
                | "qbank_batch_update_questions"
                | "qbank_list_source_images"
                | "qbank_search_questions"
                | "qbank_submit_answer"
                | "qbank_update_question"
                | "qbank_get_stats"
                | "qbank_get_next_question"
                | "qbank_start_timed_practice"
                | "qbank_generate_mock_exam"
                | "qbank_submit_mock_exam"
                | "qbank_get_daily_practice"
                | "qbank_get_check_in_calendar"
                | "qbank_generate_paper"
                | "qbank_get_learning_trend"
                | "qbank_get_activity_heatmap"
                | "qbank_get_knowledge_stats"
                | "qbank_generate_variant"
                | "qbank_batch_import"
                | "qbank_import_document"
                | "qbank_reset_progress"
                | "qbank_export"
                | "qbank_ai_grade"
        )
    }

    async fn execute(
        &self,
        call: &ToolCall,
        ctx: &ExecutionContext,
    ) -> Result<ToolResultInfo, String> {
        let start_time = Instant::now();
        let tool_name = strip_tool_namespace(&call.name);

        log::debug!("[QBankExecutor] Executing tool: {}", tool_name);

        ctx.emit_tool_call_start(&call.name, call.arguments.clone(), Some(&call.id));

        let result = match tool_name {
            "qbank_list" => self.execute_list(call, ctx).await,
            "qbank_list_questions" => self.execute_list_questions(call, ctx).await,
            "qbank_get_question" => self.execute_get_question(call, ctx).await,
            "qbank_create_question" => self.execute_create_question(call, ctx).await,
            "qbank_delete_questions" => self.execute_delete_questions(call, ctx).await,
            "qbank_toggle_favorite" => self.execute_toggle_favorite(call, ctx).await,
            "qbank_toggle_bookmark" => self.execute_toggle_bookmark(call, ctx).await,
            "qbank_get_submissions" => self.execute_get_submissions(call, ctx).await,
            "qbank_get_question_history" => self.execute_get_question_history(call, ctx).await,
            "qbank_batch_update_questions" => {
                self.execute_batch_update_questions(call, ctx).await
            }
            "qbank_list_source_images" => self.execute_list_source_images(call, ctx).await,
            "qbank_search_questions" => self.execute_search_questions(call, ctx).await,
            "qbank_submit_answer" => self.execute_submit_answer(call, ctx).await,
            "qbank_update_question" => self.execute_update_question(call, ctx).await,
            "qbank_get_stats" => self.execute_get_stats(call, ctx).await,
            "qbank_get_next_question" => self.execute_get_next_question(call, ctx).await,
            "qbank_start_timed_practice" => self.execute_start_timed_practice(call, ctx).await,
            "qbank_generate_mock_exam" => self.execute_generate_mock_exam(call, ctx).await,
            "qbank_submit_mock_exam" => self.execute_submit_mock_exam(call, ctx).await,
            "qbank_get_daily_practice" => self.execute_get_daily_practice(call, ctx).await,
            "qbank_get_check_in_calendar" => self.execute_get_check_in_calendar(call, ctx).await,
            "qbank_generate_paper" => self.execute_generate_paper(call, ctx).await,
            "qbank_get_learning_trend" => self.execute_get_learning_trend(call, ctx).await,
            "qbank_get_activity_heatmap" => self.execute_get_activity_heatmap(call, ctx).await,
            "qbank_get_knowledge_stats" => self.execute_get_knowledge_stats(call, ctx).await,
            "qbank_reset_progress" => self.execute_reset_progress(call, ctx).await,
            "qbank_export" => self.execute_export(call, ctx).await,
            "qbank_generate_variant" => self.execute_generate_variant(call, ctx).await,
            "qbank_batch_import" => self.execute_batch_import(call, ctx).await,
            "qbank_import_document" => self.execute_import_document(call, ctx).await,
            "qbank_ai_grade" => self.execute_ai_grade(call, ctx).await,
            _ => Err(format!("Unknown qbank tool: {}", tool_name)),
        };

        let elapsed_ms = start_time.elapsed().as_millis() as u64;

        match result {
            Ok(value) => {
                log::debug!(
                    "[QBankExecutor] Tool {} completed in {}ms",
                    tool_name,
                    elapsed_ms
                );

                // 🔧 修复：发射工具调用结束事件
                ctx.emit_tool_call_end(Some(json!({
                    "result": value,
                    "durationMs": elapsed_ms,
                })));

                let result = ToolResultInfo::success(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    value,
                    elapsed_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[QBankExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
            Err(e) => {
                let e = localized_qbank_failure(e);
                log::error!("[QBankExecutor] Tool {} failed: {}", tool_name, e);

                // 🔧 修复：发射工具调用错误事件
                ctx.emit_tool_call_error(&e);

                let result = ToolResultInfo::failure(
                    Some(call.id.clone()),
                    Some(ctx.block_id.clone()),
                    call.name.clone(),
                    call.arguments.clone(),
                    e,
                    elapsed_ms,
                );

                if let Err(e) = ctx.save_tool_block(&result) {
                    log::warn!("[QBankExecutor] Failed to save tool block: {}", e);
                }

                Ok(result)
            }
        }
    }

    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            "qbank_delete_questions" => ToolSensitivity::High,
            "qbank_create_question"
            | "qbank_toggle_favorite"
            | "qbank_toggle_bookmark"
            | "qbank_submit_answer"
            | "qbank_update_question"
            | "qbank_batch_update_questions"
            | "qbank_generate_paper"
            | "qbank_batch_import"
            | "qbank_import_document"
            | "qbank_reset_progress"
            | "qbank_export"
            | "qbank_ai_grade" => ToolSensitivity::Medium,
            _ => ToolSensitivity::Low,
        }
    }

    fn concurrency_class(&self, tool_name: &str) -> ToolConcurrency {
        let stripped = strip_tool_namespace(tool_name);
        match stripped {
            // 只读子集：列表/查询/统计，可并行 + 自动重试
            // （qbank_get_next_question 有推荐状态语义，不视为纯只读）
            "qbank_list"
            | "qbank_list_questions"
            | "qbank_get_question"
            | "qbank_get_submissions"
            | "qbank_get_question_history"
            | "qbank_list_source_images"
            | "qbank_search_questions"
            | "qbank_get_stats"
            | "qbank_get_learning_trend"
            | "qbank_get_activity_heatmap"
            | "qbank_get_knowledge_stats"
            | "qbank_get_check_in_calendar" => ToolConcurrency::ReadOnly,
            // 提交答案/更新/导入/重置/变式生成等写操作，保持串行（默认）
            _ => ToolConcurrency::Serial,
        }
    }

    fn name(&self) -> &'static str {
        "QBankExecutor"
    }
}

#[cfg(test)]
mod occ_contract_tests {
    use super::*;

    #[test]
    fn update_revision_is_required_and_structured() {
        let missing = json!({});
        let error: Value = serde_json::from_str(
            &expected_qbank_revision(&missing).expect_err("missing baseline must fail"),
        )
        .expect("structured error");
        assert_eq!(error["code"], "QBANK_OCC_REQUIRED");
        assert_eq!(error["retryable"], false);

        assert_eq!(
            expected_qbank_revision(&json!({"expected_updated_at": " rev-1 "})).expect("baseline"),
            "rev-1"
        );
    }

    #[test]
    fn image_input_is_all_or_nothing() {
        let valid = parse_question_images(&json!([
            {"id": "asset-1", "name": "figure.png", "mime": "image/png", "hash": "abc"}
        ]))
        .expect("valid images");
        assert_eq!(valid.len(), 1);
        assert_eq!(valid[0].id, "asset-1");

        assert!(parse_question_images(&json!([]))
            .expect("explicit empty array clears")
            .is_empty());
        for invalid in [
            json!(null),
            json!([{}]),
            json!([{"id": "   "}]),
            json!([{"id": "asset-1", "mime": 42}]),
            json!([{"id": "asset-1", "url": "https://invalid.example"}]),
        ] {
            let error = parse_question_images(&invalid).expect_err("invalid image must fail");
            let structured: Value = serde_json::from_str(&error).expect("structured error");
            assert_eq!(structured["code"], "INVALID_ARGS");
        }
    }

    #[test]
    fn unsafe_preview_update_error_is_fail_closed() {
        let error: Value = serde_json::from_str(&qbank_error(
            "QBANK_OCC_UNAVAILABLE",
            "preview update rejected",
            "migrate first",
        ))
        .expect("structured error");
        assert_eq!(error["code"], "QBANK_OCC_UNAVAILABLE");
        assert_eq!(error["retryable"], false);
        assert_eq!(error["messageKey"], "chat.tools.qbank.error");
        assert!(error["messageFallback"]["zh-CN"].is_string());
        assert!(error["messageFallback"]["en-US"].is_string());
    }

    #[test]
    fn conflict_error_returns_bounded_current_entity() {
        let current = json!({
            "id": "question-1",
            "updated_at": "revision-2",
            "content": "current question",
        });
        let error: Value = serde_json::from_str(&qbank_conflict_error(
            "QBANK_CONFLICT: stale revision",
            "use current",
            current.clone(),
        ))
        .expect("structured conflict");

        assert_eq!(error["code"], "QBANK_CONFLICT");
        assert_eq!(error["retryable"], false);
        assert_eq!(error["current"], current);
        assert_eq!(error["messageParams"]["code"], "QBANK_CONFLICT");
    }

    #[test]
    fn executor_failure_boundary_localizes_plain_errors_and_preserves_qbank_errors() {
        let plain: Value = serde_json::from_str(&localized_qbank_failure("答案内容过长"))
            .expect("localized plain error");
        assert_eq!(plain["code"], "QBANK_OPERATION_FAILED");
        assert_eq!(plain["messageKey"], "chat.tools.qbank.error");

        let domain: Value = serde_json::from_str(&localized_qbank_failure(qbank_error(
            "QBANK_CONFLICT",
            "题目已经变化",
            "重新读取后再试",
        )))
        .expect("localized qbank error");
        assert_eq!(domain["code"], "QBANK_CONFLICT");
        assert_eq!(domain["messageKey"], "chat.tools.qbank.error");
        assert_eq!(domain["messageParams"]["code"], "QBANK_CONFLICT");
    }

    #[test]
    fn ai_grading_mode_is_strict_and_write_is_medium() {
        assert_eq!(
            parse_qbank_grading_mode(&json!({})).unwrap(),
            QbankGradingMode::Grade
        );
        assert_eq!(
            parse_qbank_grading_mode(&json!({"mode": "analyze"})).unwrap(),
            QbankGradingMode::Analyze
        );
        let error: Value = serde_json::from_str(
            &parse_qbank_grading_mode(&json!({"mode": "invalid"})).unwrap_err(),
        )
        .expect("structured invalid mode");
        assert_eq!(error["code"], "INVALID_ARGS");
        assert_eq!(
            QBankExecutor::new().sensitivity_level("builtin-qbank_ai_grade"),
            ToolSensitivity::Medium
        );
    }

    #[test]
    fn bounded_question_output_truncates_unicode_on_character_boundaries() {
        let long = "题".repeat(2_001);
        let question = Question {
            id: "q-1".to_string(),
            exam_id: "exam-1".to_string(),
            card_id: Some("card-1".to_string()),
            question_label: Some("Q1".to_string()),
            content: long.clone(),
            options: Some(vec![QuestionOption {
                key: "A".to_string(),
                content: long.clone(),
            }]),
            answer: Some(long.clone()),
            explanation: Some(long),
            structured_data: None,
            question_type: RepoQuestionType::SingleChoice,
            difficulty: Some(Difficulty::Medium),
            tags: vec!["标".repeat(2_001)],
            status: QuestionStatus::New,
            user_answer: None,
            is_correct: None,
            attempt_count: 0,
            correct_count: 0,
            last_attempt_at: None,
            user_note: None,
            is_favorite: false,
            is_bookmarked: false,
            source_type: RepoSourceType::Manual,
            source_ref: Some("源".repeat(2_001)),
            images: vec![QuestionImage {
                id: "asset-1".to_string(),
                name: "图".repeat(2_001),
                mime: "image/png".to_string(),
                hash: "a".repeat(2_001),
            }],
            parent_id: None,
            created_at: "2026-07-13T00:00:00Z".to_string(),
            updated_at: "2026-07-13T00:00:00Z".to_string(),
            ai_feedback: None,
            ai_score: None,
            ai_graded_at: None,
        };

        let bounded = question_to_bounded_value(&question);
        assert_eq!(bounded["content"].as_str().unwrap().chars().count(), 2_000);
        assert_eq!(bounded["content_truncated"], true);
        assert_eq!(
            bounded["options"][0]["content"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            2_000
        );
        assert_eq!(bounded["options"][0]["content_truncated"], true);
        assert_eq!(
            bounded["source_ref"].as_str().unwrap().chars().count(),
            2_000
        );
        assert_eq!(bounded["tags"][0].as_str().unwrap().chars().count(), 2_000);
        assert_eq!(
            bounded["images"][0]["name"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            2_000
        );
        assert_eq!(
            bounded["images"][0]["hash"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            2_000
        );
        assert!(bounded["fieldsTruncated"]
            .as_array()
            .unwrap()
            .iter()
            .any(|field| field == "options[0].content"));
    }

    #[test]
    fn phase_four_tools_are_registered_and_risk_classified() {
        let executor = QBankExecutor::new();
        for tool in [
            "qbank_create_question",
            "qbank_delete_questions",
            "qbank_toggle_favorite",
            "qbank_toggle_bookmark",
            "qbank_get_submissions",
            "qbank_get_question_history",
            "qbank_batch_update_questions",
            "qbank_list_source_images",
            "qbank_search_questions",
            "qbank_start_timed_practice",
            "qbank_generate_mock_exam",
            "qbank_submit_mock_exam",
            "qbank_get_daily_practice",
            "qbank_get_check_in_calendar",
            "qbank_generate_paper",
            "qbank_get_learning_trend",
            "qbank_get_activity_heatmap",
            "qbank_get_knowledge_stats",
        ] {
            assert!(executor.can_handle(&format!("builtin-{tool}")), "{tool}");
        }
        assert_eq!(
            executor.sensitivity_level("builtin-qbank_delete_questions"),
            ToolSensitivity::High
        );
        for tool in [
            "qbank_create_question",
            "qbank_toggle_favorite",
            "qbank_toggle_bookmark",
            "qbank_update_question",
            "qbank_batch_update_questions",
            "qbank_generate_paper",
        ] {
            assert_eq!(
                executor.sensitivity_level(&format!("builtin-{tool}")),
                ToolSensitivity::Medium,
                "{tool}"
            );
        }
        assert_eq!(
            executor.sensitivity_level("builtin-qbank_search_questions"),
            ToolSensitivity::Low
        );
    }

    #[test]
    fn practice_handoff_builds_a_replayable_ui_hydration_action() {
        for (mode, session) in [
            (
                "timed",
                json!({"id": "timed-1", "exam_id": "exam-1", "question_ids": ["q-1"]}),
            ),
            (
                "mock_exam",
                json!({"id": "mock-1", "exam_id": "exam-1", "question_ids": ["q-1"]}),
            ),
            (
                "daily",
                json!({"date": "2026-07-14", "exam_id": "exam-1", "question_ids": ["q-1"]}),
            ),
        ] {
            let handoff = QBankExecutor::practice_handoff("exam-1", mode, session)
                .expect("valid practice handoff");
            assert_eq!(handoff["version"], 1);
            assert_eq!(handoff["kind"], "qbank_practice_session");
            assert_eq!(handoff["mode"], mode);
            assert_eq!(handoff["exam_id"], "exam-1");
            assert_eq!(handoff["agentCanAnswer"], false);

            let action = QBankExecutor::practice_workbench_action("exam-1", &handoff);
            assert_eq!(action["tool"], "builtin-workbench_app_command");
            assert_eq!(action["executed"], false);
            assert_eq!(action["payloadHydrationSupported"], true);
            assert_eq!(action["arguments"]["typeId"], "exam");
            assert_eq!(action["arguments"]["instanceKey"], "exam-1");
            assert_eq!(action["arguments"]["action"], "hydratePracticeSession");
            assert_eq!(action["arguments"]["payload"]["handoff"], handoff);
        }
    }

    #[test]
    fn practice_handoff_rejects_unknown_modes_and_unstable_identity() {
        for (mode, session) in [
            ("paper", json!({"id": "paper-1"})),
            ("timed", json!({"exam_id": "exam-1"})),
        ] {
            let error = QBankExecutor::practice_handoff("exam-1", mode, session)
                .expect_err("invalid handoff must fail closed");
            let structured: Value = serde_json::from_str(&error).expect("structured error");
            assert!(matches!(
                structured["code"].as_str(),
                Some("INVALID_ARGS" | "QBANK_HANDOFF_INVALID")
            ));
            assert_eq!(structured["retryable"], false);
        }
    }

    #[test]
    fn structured_data_shapes_are_validated_per_question_type() {
        // fill_blank：合法多空
        validate_structured_data(
            &RepoQuestionType::FillBlank,
            &json!({"blanks": [{"answers": ["答案A", "答案B"], "case_sensitive": false, "trim": true}]}),
        )
        .expect("valid fill_blank");
        // matching：pairs 引用不存在的 key 必须报错
        let error = validate_structured_data(
            &RepoQuestionType::Matching,
            &json!({
                "left": [{"key": "L1", "content": "左1"}],
                "right": [{"key": "R1", "content": "右1"}],
                "pairs": [{"left": "L1", "right": "R9"}],
            }),
        )
        .expect_err("dangling pair ref must fail");
        let structured: Value = serde_json::from_str(&error).expect("structured error");
        assert_eq!(structured["code"], "INVALID_ARGS");
        // ordering：correct_order 必须是 items key 的排列
        assert!(validate_structured_data(
            &RepoQuestionType::Ordering,
            &json!({
                "items": [{"key": "S1", "content": "步骤1"}, {"key": "S2", "content": "步骤2"}],
                "correct_order": ["S2", "S1"],
            }),
        )
        .is_ok());
        assert!(validate_structured_data(
            &RepoQuestionType::Ordering,
            &json!({
                "items": [{"key": "S1", "content": "步骤1"}, {"key": "S2", "content": "步骤2"}],
                "correct_order": ["S1"],
            }),
        )
        .is_err());
        // numeric：answer_value 必填且 tolerance_mode 枚举受限
        assert!(validate_structured_data(
            &RepoQuestionType::Numeric,
            &json!({"answer_value": 3.14, "tolerance": 0.01, "unit": "m", "tolerance_mode": "absolute"}),
        )
        .is_ok());
        assert!(validate_structured_data(
            &RepoQuestionType::Numeric,
            &json!({"answer_value": "3.14"}),
        )
        .is_err());
        // 不支持 structured_data 的题型必须拒绝
        assert!(
            validate_structured_data(&RepoQuestionType::SingleChoice, &json!({"blanks": []}))
                .is_err()
        );
    }

    #[test]
    fn true_false_answers_are_normalized_strings() {
        assert!(validate_true_false_answer("true").is_ok());
        assert!(validate_true_false_answer(" false ").is_ok());
        for invalid in ["True", "对", "1", ""] {
            let error = validate_true_false_answer(invalid).expect_err("invalid must fail");
            let structured: Value = serde_json::from_str(&error).expect("structured error");
            assert_eq!(structured["code"], "INVALID_ARGS");
        }
    }

    #[test]
    fn delete_versions_require_complete_occ_map() {
        let executor = QBankExecutor::new();
        let parsed = executor
            .parse_delete_versions(&json!({
                "question_ids": ["q-2", "q-1"],
                "expected_updated_at_by_id": {"q-1": "v1", "q-2": "v2"}
            }))
            .expect("complete versions");
        assert_eq!(parsed.len(), 2);

        let error = executor
            .parse_delete_versions(&json!({
                "question_ids": ["q-1", "q-2"],
                "expected_updated_at_by_id": {"q-1": "v1"}
            }))
            .expect_err("missing version must fail");
        let structured: Value = serde_json::from_str(&error).expect("structured error");
        assert_eq!(structured["code"], "QBANK_OCC_REQUIRED");
    }
}
