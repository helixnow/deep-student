//! # Anki 卡片确定性质检 lint 引擎（零 LLM 成本）
//!
//! Round 3 #3：SOTA 确定性质检模块。对 LLM 生成的 Anki 卡片做纯规则质检，
//! 不调用任何模型、不产生任何 token 成本，单卡 lint 耗时微秒级。
//!
//! ## 设计原则
//!
//! 1. **默认 flag 入库不丢卡**（`LintLevel::Flag`）：LLM 输出轻微越界很常见，
//!    毙卡会损失内容。lint 结果以结构化 JSON 写入 `extra_fields["_qa_flags"]`
//!    留痕，供前端 QA 面板复查/批量修复。
//! 2. **`LintLevel::Reject` 可选**：调用方可将 `Error` 级违规升级为拒绝入库
//!    （`should_reject`），Flag/Warn/Info 永不拒绝。
//! 3. **规则可配置**：`LintConfig` 暴露阈值（front 最大长度、答案泄露最小长度等），
//!    每条规则可独立关闭。
//! 4. **与既有 `_qa_flags` 协议兼容**：`merge_flags` 会解析 `extra_fields` 中
//!    已有的 JSON 数组（字段规则校验写入的 `{field, rule, message}` 条目），
//!    追加 lint 条目并按 `(code, field)` 去重，绝不覆盖丢失既有标记。
//!
//! ## 失败模式覆盖（参考 Memory Machines / arXiv 2507.05629）
//!
//! | # | 规则 | code | 默认严重度 |
//! |---|------|------|-----------|
//! | 1 | front == back | `front_back_identical` | Error |
//! | 2 | front/back 空或纯空白 | `empty_front` / `empty_back` | Error |
//! | 3 | cloze 未配对/空挖空/非法序号 | `cloze_*` | Error |
//! | 4 | 答案泄露（front 含 back 关键片段） | `answer_leak` | Warn |
//! | 5 | 双概念（一卡问两件事启发式） | `multi_concept` | Warn |
//! | 6 | 最小信息原则（front 过长） | `front_too_long` | Warn |
//! | 7 | 占位符残留 | `placeholder_residue` | Error |
//! | 8 | tags 空 | `tags_empty` | Info |
//! | 9 | 同文档重复卡（归一化 front 指纹） | `duplicate_in_document` | Warn |
//! | 9b | 同文档近重复卡（字符 bigram Jaccard） | `near_duplicate` | Warn |
//! | 10 | 字段 min/max/allowed/regex | `field_rule_*` | Warn |
//! | 11 | 选择题缺选项/答案不在选项中 | `mcq_*` | Error/Warn |
//! | 12 | 语言混杂（低置信启发式） | `mixed_language` | Info（永不拒绝） |
//!
//! ## 生成管线接入点
//!
//! `StreamingAnkiService::parse_and_save_card` 在字段提取+占位符清理之后、
//! 卡片入库之前调用：
//!
//! ```ignore
//! let issues = anki_qa_lint::lint_card(&CardLintInput { .. }, &LintConfig::default());
//! anki_qa_lint::merge_flags(&mut cleaned_extra_fields, &issues);
//! // extra_fields 含 _qa_flags 时，流式循环已有逻辑自动累计 StreamStats::flagged_cards
//! ```
//!
//! 文档级重复/近重复检测（规则 9/9b，Round 4 #3 接入真实生成路径）由
//! `FingerprintTracker` 提供，有两种持有方式：
//!
//! 1. **显式持有**：调用方在文档/任务生命周期内持有一个 tracker，逐卡调用
//!    `lint_card_with_tracker`；
//! 2. **文档级 registry**（生产路径）：`observe_document_card(document_id, key)`
//!    从进程级 registry 按 document_id 取共享 tracker——同一文档的所有 segment
//!    task（含统一重试任务、暂停后 resume 的任务）天然共享同一份指纹状态，
//!    不会每个 task 重置。文档完成/取消/删除时由调度层调用
//!    `release_document_tracker` 释放。
//!
//! 重复/近重复只打 flag（Warn）不丢卡；落库层的 DB 唯一索引仍是最终防线，
//! tracker 的价值是在 flag 里显式留下 `duplicate_in_document` / `near_duplicate`
//! 语义。registry 内部所有锁异常均被吞掉（poison 恢复），检测失败最坏结果是
//! 少打一个 flag，绝不影响卡片入库。

use crate::models::FieldExtractionRule;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};

/// 与 `streaming_anki_service::QA_FLAGS_FIELD` 保持一致的键名。
/// 此处独立声明避免模块间循环依赖；两处均有编译期断言测试守护。
pub const QA_FLAGS_FIELD: &str = "_qa_flags";

/// 全部稳定 lint code 的具名常量导出（Round 5 #10，跨语言契约的 Rust 侧锚点）。
///
/// 规则实现内部仍以字符串字面量产出 code（保持 `anki_gold_set.rs` 的源码扫描
/// 契约测试不变），本模块的价值是给下游一个**稳定、可枚举、带名字**的出口：
///
/// - 常量名与 eval harness（`scripts/anki-eval/lib/cardLint.mjs`）中
///   `RUST_ALIGNED_CODES` / `RUST_ONLY_CODES` 的键名逐字节一致，
///   `tests/vitest/anki/eval/lintContract.test.ts` 解析本模块源码断言
///   「名字 + 值」双重对齐；
/// - 常量值与 `anki_gold_set::LINT_CONTRACT_CODES` 及规则实现实际产出的
///   字面量三方相等，由本文件测试 `codes_module_matches_emitted_literals` /
///   `codes_module_matches_contract_list` 锁定。
///
/// 新增/改名 lint 码的完整步骤：规则实现 → 本模块常量 →
/// `LINT_CONTRACT_CODES` → `cardLint.mjs` 分区表 → eval README 对照表，
/// 漏任何一步都有测试红灯。
pub mod codes {
    pub const FRONT_BACK_IDENTICAL: &str = "front_back_identical";
    pub const EMPTY_FRONT: &str = "empty_front";
    pub const EMPTY_BACK: &str = "empty_back";
    pub const CLOZE_UNCLOSED: &str = "cloze_unclosed";
    pub const CLOZE_EMPTY_ANSWER: &str = "cloze_empty_answer";
    pub const CLOZE_BAD_INDEX: &str = "cloze_bad_index";
    pub const CLOZE_MISSING: &str = "cloze_missing";
    pub const ANSWER_LEAK: &str = "answer_leak";
    pub const MULTI_CONCEPT: &str = "multi_concept";
    pub const FRONT_TOO_LONG: &str = "front_too_long";
    pub const PLACEHOLDER_RESIDUE: &str = "placeholder_residue";
    pub const TODO_RESIDUE: &str = "todo_residue";
    pub const XXX_RESIDUE: &str = "xxx_residue";
    pub const EMPTY_BRACKETS: &str = "empty_brackets";
    pub const TAGS_EMPTY: &str = "tags_empty";
    pub const DUPLICATE_IN_DOCUMENT: &str = "duplicate_in_document";
    pub const NEAR_DUPLICATE: &str = "near_duplicate";
    pub const MIXED_LANGUAGE: &str = "mixed_language";
    pub const MCQ_TOO_FEW_OPTIONS: &str = "mcq_too_few_options";
    pub const MCQ_ANSWER_NOT_IN_OPTIONS: &str = "mcq_answer_not_in_options";
    pub const MCQ_MISSING_ANSWER: &str = "mcq_missing_answer";
    pub const FIELD_RULE_MIN_LENGTH: &str = "field_rule_min_length";
    pub const FIELD_RULE_MAX_LENGTH: &str = "field_rule_max_length";
    pub const FIELD_RULE_ALLOWED_VALUES: &str = "field_rule_allowed_values";
    pub const FIELD_RULE_PATTERN: &str = "field_rule_pattern";
    pub const LEGACY_FLAGS_UNPARSED: &str = "legacy_flags_unparsed";

    /// 全部 code 常量的集合（顺序无语义），供契约测试与调用方枚举。
    pub const ALL: &[&str] = &[
        FRONT_BACK_IDENTICAL,
        EMPTY_FRONT,
        EMPTY_BACK,
        CLOZE_UNCLOSED,
        CLOZE_EMPTY_ANSWER,
        CLOZE_BAD_INDEX,
        CLOZE_MISSING,
        ANSWER_LEAK,
        MULTI_CONCEPT,
        FRONT_TOO_LONG,
        PLACEHOLDER_RESIDUE,
        TODO_RESIDUE,
        XXX_RESIDUE,
        EMPTY_BRACKETS,
        TAGS_EMPTY,
        DUPLICATE_IN_DOCUMENT,
        NEAR_DUPLICATE,
        MIXED_LANGUAGE,
        MCQ_TOO_FEW_OPTIONS,
        MCQ_ANSWER_NOT_IN_OPTIONS,
        MCQ_MISSING_ANSWER,
        FIELD_RULE_MIN_LENGTH,
        FIELD_RULE_MAX_LENGTH,
        FIELD_RULE_ALLOWED_VALUES,
        FIELD_RULE_PATTERN,
        LEGACY_FLAGS_UNPARSED,
    ];
}

// ============================================================================
// 输出结构
// ============================================================================

/// lint 违规严重度。
///
/// - `Info`：仅提示，永不参与拒绝决策（如 tags 空、语言混杂）。
/// - `Warn`：质量问题但内容仍可用（如答案泄露、front 过长）。
/// - `Error`：卡片大概率不可用（如 front==back、占位符残留、cloze 破损）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LintSeverity {
    Info,
    Warn,
    Error,
}

/// lint 行为级别。
///
/// - `Flag`（默认）：所有违规仅标记入 `_qa_flags`，卡片照常入库。
/// - `Reject`：`Error` 级违规触发拒绝（`should_reject` 返回 true），
///   `Warn`/`Info` 仍仅标记。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LintLevel {
    Flag,
    Reject,
}

impl Default for LintLevel {
    fn default() -> Self {
        LintLevel::Flag
    }
}

/// 单条 lint 违规，结构化输出 `{code, field, message, severity}`。
///
/// 序列化后与既有字段规则校验条目（`{field, rule, message}`）共存于
/// `_qa_flags` JSON 数组中；lint 条目以 `code` 键区分来源。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LintIssue {
    /// 机器可读违规码，snake_case，稳定不变（前端按码分类展示/过滤，
    /// 并按 `qaFlags.lint.<code>` 查本地化词条渲染用户可见文案）。
    pub code: String,
    /// 违规字段名；卡片级违规（如 duplicate_in_document）用 `"card"`。
    pub field: String,
    /// 人类可读中文说明。定位是诊断/日志与前端兜底展示（词条缺失时回退），
    /// 用户可见文案由前端按 `code` 走 i18n。
    ///
    /// 软契约：前端会按 message 中数字出现的**顺序**抽取插值参数
    /// （计数/阈值/百分比，见 `AnkiQaFlagBadge.tsx` 的
    /// `LINT_NUMERIC_PARAM_NAMES`），调整文案时勿改变数字的顺序语义。
    pub message: String,
    pub severity: LintSeverity,
}

impl LintIssue {
    fn new(code: &str, field: &str, message: String, severity: LintSeverity) -> Self {
        Self {
            code: code.to_string(),
            field: field.to_string(),
            message,
            severity,
        }
    }
}

// ============================================================================
// 配置
// ============================================================================

/// lint 引擎配置。所有阈值可调，所有规则可独立关闭。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LintConfig {
    /// 行为级别：Flag（默认，只标记）或 Reject（Error 级违规拒绝入库）。
    pub level: LintLevel,
    /// 最小信息原则：front 超过该 Unicode 字符数即 flag。
    /// 默认 220：中文问题 60~120 字常见，>220 通常是整段粘贴。
    pub max_front_chars: usize,
    /// 答案泄露检测：back 归一化后至少多少字符才参与子串匹配
    /// （过短的 back 如 "是"/"3" 子串命中率过高，属噪声）。
    pub answer_leak_min_chars: usize,
    /// 语言混杂检测：参与统计的最少字母字符数（低于该值不判断）。
    pub mixed_language_min_letters: usize,
    pub check_front_back_identical: bool,
    pub check_empty_fields: bool,
    pub check_cloze: bool,
    pub check_answer_leak: bool,
    pub check_multi_concept: bool,
    pub check_front_length: bool,
    pub check_placeholder: bool,
    pub check_tags_empty: bool,
    pub check_mcq: bool,
    /// 语言混杂启发式（低置信）：默认开启但仅产出 Info，永不拒绝。
    pub check_mixed_language: bool,
}

impl Default for LintConfig {
    fn default() -> Self {
        Self {
            level: LintLevel::Flag,
            max_front_chars: 220,
            answer_leak_min_chars: 4,
            mixed_language_min_letters: 24,
            check_front_back_identical: true,
            check_empty_fields: true,
            check_cloze: true,
            check_answer_leak: true,
            check_multi_concept: true,
            check_front_length: true,
            check_placeholder: true,
            check_tags_empty: true,
            check_mcq: true,
            check_mixed_language: true,
        }
    }
}

// ============================================================================
// 输入
// ============================================================================

/// 待 lint 的卡片切面（借用调用方已有数据，零拷贝）。
#[derive(Debug, Clone, Copy)]
pub struct CardLintInput<'a> {
    pub front: &'a str,
    pub back: &'a str,
    /// Cloze 模板的 Text 字段（若存在，cloze 规则优先检查它）。
    pub text: Option<&'a str>,
    pub tags: &'a [String],
    /// 扩展字段（选择题 optionA-D / correct 等从这里读取）。
    pub extra_fields: &'a HashMap<String, String>,
}

// ============================================================================
// 主入口
// ============================================================================

/// 对单张卡片执行全部启用的确定性规则，返回违规列表（空 = 通过）。
///
/// 无状态版本：不含文档级重复检测。需要重复检测时用
/// [`lint_card_with_tracker`]。
pub fn lint_card(input: &CardLintInput, cfg: &LintConfig) -> Vec<LintIssue> {
    let mut issues = Vec::new();

    if cfg.check_empty_fields {
        check_empty_fields(input, &mut issues);
    }
    if cfg.check_front_back_identical {
        check_front_back_identical(input, &mut issues);
    }
    if cfg.check_cloze {
        check_cloze(input, &mut issues);
    }
    if cfg.check_answer_leak {
        check_answer_leak(input, cfg, &mut issues);
    }
    if cfg.check_multi_concept {
        check_multi_concept(input, &mut issues);
    }
    if cfg.check_front_length {
        check_front_length(input, cfg, &mut issues);
    }
    if cfg.check_placeholder {
        check_placeholder(input, &mut issues);
    }
    if cfg.check_tags_empty {
        check_tags_empty(input, &mut issues);
    }
    if cfg.check_mcq {
        check_mcq(input, &mut issues);
    }
    if cfg.check_mixed_language {
        check_mixed_language(input, cfg, &mut issues);
    }

    issues
}

/// 带文档级重复/近重复检测的 lint：先跑无状态规则，再查/登记 front 指纹。
///
/// `tracker` 应与文档/任务同生命周期（每个文档一个实例）。
pub fn lint_card_with_tracker(
    input: &CardLintInput,
    cfg: &LintConfig,
    tracker: &mut FingerprintTracker,
) -> Vec<LintIssue> {
    let mut issues = lint_card(input, cfg);
    let observation = tracker.observe(duplicate_key_source(input));
    issues.extend(issues_from_observation(&observation));
    issues
}

/// 指纹 key 的选取规则：cloze 卡优先用 Text 字段（front 可能为空或为渲染视图），
/// 否则用 front。与 `lint_card_with_tracker` / 生产路径保持同一语义。
pub fn duplicate_key_source<'a>(input: &CardLintInput<'a>) -> &'a str {
    match input.text {
        Some(t) if !t.trim().is_empty() => t,
        _ => input.front,
    }
}

/// 把指纹观察结果转换为结构化 lint 违规。
///
/// - 精确重复 → `duplicate_in_document`（Warn，不丢卡）；
/// - 近重复 → `near_duplicate`（Warn，不丢卡），message 携带相似度百分比。
///
/// 精确重复时不再叠加 near_duplicate（相似度恒为 1.0，属重复信息）。
pub fn issues_from_observation(observation: &FingerprintObservation) -> Vec<LintIssue> {
    let mut issues = Vec::new();
    if observation.exact_duplicate {
        issues.push(LintIssue::new(
            "duplicate_in_document",
            "card",
            "同文档内已存在归一化 front 相同的卡片".to_string(),
            LintSeverity::Warn,
        ));
    } else if let Some(similarity) = observation.near_duplicate {
        issues.push(LintIssue::new(
            "near_duplicate",
            "card",
            format!(
                "与同文档已有卡片高度相似（字符 bigram Jaccard {:.0}%），疑似近重复",
                similarity * 100.0
            ),
            LintSeverity::Warn,
        ));
    }
    issues
}

/// 拒绝决策：仅当配置为 `Reject` 且存在 `Error` 级违规时返回 true。
///
/// `Warn`/`Info` 永不触发拒绝——这是"低置信只 flag 不拒绝"的硬保证。
pub fn should_reject(issues: &[LintIssue], cfg: &LintConfig) -> bool {
    cfg.level == LintLevel::Reject && issues.iter().any(|i| i.severity == LintSeverity::Error)
}

/// 将 lint 违规合并进 `extra_fields[_qa_flags]`（JSON 数组字符串）。
///
/// - 保留既有条目（字段规则校验写入的 `{field, rule, message}`）。
/// - lint 条目序列化为 `{code, field, message, severity}`。
/// - 按 `(code, field)` 去重，重复调用幂等。
/// - `issues` 为空且原本无 flags 时不写入键（不污染干净卡片）。
/// - 既有值不是合法 JSON 数组时不丢弃：包装为 `{code: "legacy_flags_unparsed"}` 条目保留原文。
pub fn merge_flags(extra_fields: &mut HashMap<String, String>, issues: &[LintIssue]) {
    if issues.is_empty() && !extra_fields.contains_key(QA_FLAGS_FIELD) {
        return;
    }

    let mut merged: Vec<Value> = Vec::new();
    if let Some(existing_raw) = extra_fields.get(QA_FLAGS_FIELD) {
        match serde_json::from_str::<Value>(existing_raw) {
            Ok(Value::Array(items)) => merged.extend(items),
            Ok(other) => merged.push(json!({
                "code": "legacy_flags_unparsed",
                "field": "card",
                "message": other.to_string(),
                "severity": "info",
            })),
            Err(_) => merged.push(json!({
                "code": "legacy_flags_unparsed",
                "field": "card",
                "message": existing_raw.clone(),
                "severity": "info",
            })),
        }
    }

    let mut seen: HashSet<(String, String)> = merged
        .iter()
        .filter_map(|v| {
            let code = v.get("code").and_then(Value::as_str)?;
            let field = v.get("field").and_then(Value::as_str)?;
            Some((code.to_string(), field.to_string()))
        })
        .collect();

    for issue in issues {
        let key = (issue.code.clone(), issue.field.clone());
        if seen.insert(key) {
            // LintIssue 的 Serialize 派生不会失败
            merged.push(serde_json::to_value(issue).unwrap_or_else(|_| json!(null)));
        }
    }

    if merged.is_empty() {
        return;
    }
    extra_fields.insert(QA_FLAGS_FIELD.to_string(), Value::Array(merged).to_string());
}

// ============================================================================
// 规则 10：字段 min/max/allowed_values/regex（包装 FieldExtractionRule）
// ============================================================================

/// 用模板字段规则 lint 单个字段值，输出结构化 `LintIssue`
/// （与 `streaming_anki_service::validate_field_against_rule` 语义一致，
/// 但输出统一的 lint 结构，供 lint 管线外的调用方复用）。
///
/// 长度按 Unicode 字符数计；`validation_pattern` 编译失败视为模板配置
/// 问题，跳过该项不惩罚卡片。
pub fn lint_field_against_rule(
    field_name: &str,
    value: &str,
    rule: &FieldExtractionRule,
) -> Vec<LintIssue> {
    let mut issues = Vec::new();
    let char_count = value.chars().count() as u32;

    if let Some(min) = rule.min_length {
        if char_count < min {
            issues.push(LintIssue::new(
                "field_rule_min_length",
                field_name,
                format!("长度 {} 小于最小长度 {}", char_count, min),
                LintSeverity::Warn,
            ));
        }
    }
    if let Some(max) = rule.max_length {
        if char_count > max {
            issues.push(LintIssue::new(
                "field_rule_max_length",
                field_name,
                format!("长度 {} 超过最大长度 {}", char_count, max),
                LintSeverity::Warn,
            ));
        }
    }
    if let Some(allowed) = rule.allowed_values.as_deref().filter(|v| !v.is_empty()) {
        let matched = allowed.iter().any(|candidate| match candidate {
            Value::String(s) => s == value,
            other => other.to_string() == value,
        });
        if !matched {
            let preview: String = value.chars().take(40).collect();
            issues.push(LintIssue::new(
                "field_rule_allowed_values",
                field_name,
                format!("值 \"{}\" 不在允许值列表中", preview),
                LintSeverity::Warn,
            ));
        }
    }
    if let Some(pattern) = rule
        .validation_pattern
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty())
    {
        if let Ok(re) = regex::Regex::new(pattern) {
            if !re.is_match(value) {
                issues.push(LintIssue::new(
                    "field_rule_pattern",
                    field_name,
                    format!("值不匹配校验模式 {}", pattern),
                    LintSeverity::Warn,
                ));
            }
        }
        // 模式编译失败：模板配置问题，静默跳过（与既有行为一致）
    }

    issues
}

// ============================================================================
// 规则 9/9b：文档级重复卡指纹 + 近重复检测
// ============================================================================

/// 近重复判定默认阈值：归一化字符 bigram 集合的 Jaccard 相似度 ≥ 0.82 视为近重复。
///
/// 取值依据：小编辑（增删两三个字、加语气词）后的问句相似度普遍落在 0.85+；
/// 而问同类不同对象的卡（"什么是TCP" vs "什么是UDP"）在 0.3 以下，
/// 0.82 在两簇之间留有余量。
pub const DEFAULT_NEAR_DUPLICATE_THRESHOLD: f64 = 0.82;

/// 近重复扫描登记的指纹上限：超过后新卡不再加入 bigram 索引
/// （精确重复检测不受影响），把单卡近重复检测成本封顶在
/// O(max_near_tracked × 平均 bigram 数)，防止超大文档退化为 O(n²) 长尾。
pub const DEFAULT_MAX_NEAR_TRACKED: usize = 2048;

/// 单次指纹观察的结果。
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct FingerprintObservation {
    /// 归一化指纹与同文档已登记卡完全相同。
    pub exact_duplicate: bool,
    /// 非精确重复但与某张已登记卡的 bigram Jaccard 相似度达到阈值时为
    /// `Some(最高相似度)`；精确重复时恒为 `None`（不重复报告）。
    pub near_duplicate: Option<f64>,
}

/// 同文档归一化 front 指纹去重器 + 近重复检测器。每个文档持有一个实例
/// （显式持有或经 `document_tracker` registry 跨 segment task 共享）。
///
/// 指纹 = front（或 cloze Text）经 `normalize_for_compare` 后的字符串。
/// 归一化会剥离 HTML 标签、折叠空白、去标点、转小写，
/// 因此 "什么是TCP？" 与 "<b>什么是 tcp</b>" 视为同一张卡。
///
/// 近重复 = 归一化指纹的字符 bigram 集合与任一已登记指纹的 Jaccard
/// 相似度 ≥ 阈值。字符 bigram 对中文（无空格分词）与英文同样适用。
#[derive(Debug)]
pub struct FingerprintTracker {
    seen: HashSet<String>,
    /// 已登记指纹的 bigram 集合（近重复扫描索引，长度受 max_near_tracked 封顶）。
    shingle_sets: Vec<HashSet<String>>,
    near_duplicate_threshold: f64,
    max_near_tracked: usize,
}

impl Default for FingerprintTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl FingerprintTracker {
    pub fn new() -> Self {
        Self {
            seen: HashSet::new(),
            shingle_sets: Vec::new(),
            near_duplicate_threshold: DEFAULT_NEAR_DUPLICATE_THRESHOLD,
            max_near_tracked: DEFAULT_MAX_NEAR_TRACKED,
        }
    }

    /// 自定义近重复阈值（clamp 到 (0, 1]；1.0 等价于只做精确重复检测）。
    pub fn with_near_duplicate_threshold(threshold: f64) -> Self {
        let mut tracker = Self::new();
        tracker.near_duplicate_threshold = threshold.clamp(f64::EPSILON, 1.0);
        tracker
    }

    /// 观察一张卡的指纹 key（front 或 cloze Text）：
    /// 返回精确重复/近重复判定，并把新指纹登记进索引。
    ///
    /// - 空白/空指纹永远返回全 false（空卡由 empty_front 规则处理，不算重复）；
    /// - 精确重复不重复登记（首次登记时 bigram 已入索引）；
    /// - 近重复卡照常登记（后续与它相似的卡也应被 flag）。
    pub fn observe(&mut self, key_source: &str) -> FingerprintObservation {
        let fp = normalize_for_compare(key_source);
        if fp.is_empty() {
            return FingerprintObservation::default();
        }
        if !self.seen.insert(fp.clone()) {
            return FingerprintObservation {
                exact_duplicate: true,
                near_duplicate: None,
            };
        }

        let shingles = char_bigrams(&fp);
        let mut best_similarity = 0.0_f64;
        for prev in &self.shingle_sets {
            let similarity = jaccard(&shingles, prev);
            if similarity > best_similarity {
                best_similarity = similarity;
            }
        }
        if self.shingle_sets.len() < self.max_near_tracked {
            self.shingle_sets.push(shingles);
        }

        FingerprintObservation {
            exact_duplicate: false,
            near_duplicate: (best_similarity >= self.near_duplicate_threshold)
                .then_some(best_similarity),
        }
    }

    /// 登记指纹；若之前已见过相同指纹则返回 true（= 精确重复）。
    /// 兼容旧调用方的薄封装，内部走 [`FingerprintTracker::observe`]。
    pub fn check_and_insert(&mut self, front: &str) -> bool {
        self.observe(front).exact_duplicate
    }

    pub fn len(&self) -> usize {
        self.seen.len()
    }

    pub fn is_empty(&self) -> bool {
        self.seen.is_empty()
    }
}

/// 归一化指纹的字符 bigram 集合；不足 2 字符时以整串为单一 shingle，
/// 避免单字卡产生空集合（空集合 Jaccard 恒 0，会漏检单字重复的近邻）。
fn char_bigrams(fp: &str) -> HashSet<String> {
    let chars: Vec<char> = fp.chars().collect();
    if chars.len() < 2 {
        return std::iter::once(fp.to_string()).collect();
    }
    chars.windows(2).map(|w| w.iter().collect()).collect()
}

/// 两个 shingle 集合的 Jaccard 相似度（|A∩B| / |A∪B|）。空集合恒 0。
fn jaccard(a: &HashSet<String>, b: &HashSet<String>) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let intersection = a.intersection(b).count();
    let union = a.len() + b.len() - intersection;
    intersection as f64 / union as f64
}

// ============================================================================
// 文档级 tracker registry（生产路径：跨 segment task 共享指纹状态）
// ============================================================================

/// 进程级文档 tracker 注册表。key = document_id。
///
/// 同一文档的所有 segment task 并发生成时（EnhancedAnkiService 并发度 5）
/// 经此共享同一个 tracker，暂停/恢复与统一重试任务也命中同一实例。
/// 文档完成/取消/删除时由调度层调用 `release_document_tracker` 释放。
static DOCUMENT_TRACKERS: LazyLock<Mutex<HashMap<String, Arc<Mutex<FingerprintTracker>>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// 拿 registry 锁；poison（持锁线程 panic）时恢复内部数据继续用——
/// tracker 只是 flag 辅助状态，宁可带着可能不完整的状态继续，也不放大故障。
fn registry_lock() -> MutexGuard<'static, HashMap<String, Arc<Mutex<FingerprintTracker>>>> {
    DOCUMENT_TRACKERS
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// 取（或懒创建）document_id 对应的共享 tracker。
pub fn document_tracker(document_id: &str) -> Arc<Mutex<FingerprintTracker>> {
    registry_lock()
        .entry(document_id.to_string())
        .or_insert_with(|| Arc::new(Mutex::new(FingerprintTracker::new())))
        .clone()
}

/// 释放 document_id 对应的 tracker（文档完成/取消/删除时调用，防泄漏）。
pub fn release_document_tracker(document_id: &str) {
    registry_lock().remove(document_id);
}

/// 生产路径入口：对一张卡的指纹 key 做文档级重复/近重复检测，
/// 返回应打的 lint flag 列表（空 = 干净）。
///
/// 失败隔离保证：本函数**永不返回错误、永不 panic 传播锁异常**
/// （registry 与 tracker 两级锁的 poison 均被恢复），
/// document_id 或 key 为空白时为 no-op。检测失败最坏结果是少打 flag，
/// 调用方无需任何错误处理，卡片入库路径完全不受影响。
pub fn observe_document_card(document_id: &str, key_source: &str) -> Vec<LintIssue> {
    if document_id.trim().is_empty() || key_source.trim().is_empty() {
        return Vec::new();
    }
    let tracker = document_tracker(document_id);
    let observation = {
        let mut guard = tracker
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        guard.observe(key_source)
    };
    issues_from_observation(&observation)
}

// ============================================================================
// 文本工具
// ============================================================================

/// 剥离 HTML 标签（简单状态机，不解析实体；对 lint 用途足够）。
fn strip_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out
}

/// 比较用归一化：去 HTML → 小写 → 仅保留字母/数字（含 CJK），丢弃空白与标点。
fn normalize_for_compare(s: &str) -> String {
    strip_html(s)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

fn is_cjk(c: char) -> bool {
    matches!(c,
        '\u{4E00}'..='\u{9FFF}'   // CJK 统一表意
        | '\u{3400}'..='\u{4DBF}' // 扩展 A
        | '\u{3040}'..='\u{30FF}' // 日文假名
        | '\u{AC00}'..='\u{D7AF}' // 韩文音节
    )
}

// ============================================================================
// 各规则实现
// ============================================================================

/// 规则 2：front/back 空或纯空白。
/// cloze 卡（Text 字段含 `{{c` 挖空）允许 back 为空——答案在挖空里。
fn check_empty_fields(input: &CardLintInput, issues: &mut Vec<LintIssue>) {
    let has_cloze_text = input
        .text
        .map(|t| t.contains("{{c") && !t.trim().is_empty())
        .unwrap_or(false);

    if input.front.trim().is_empty() && !has_cloze_text {
        issues.push(LintIssue::new(
            "empty_front",
            "front",
            "front 为空或纯空白".to_string(),
            LintSeverity::Error,
        ));
    }
    if input.back.trim().is_empty() && !has_cloze_text && !input.front.contains("{{c") {
        issues.push(LintIssue::new(
            "empty_back",
            "back",
            "back 为空或纯空白".to_string(),
            LintSeverity::Error,
        ));
    }
}

/// 规则 1：front == back（归一化后完全相同）。
fn check_front_back_identical(input: &CardLintInput, issues: &mut Vec<LintIssue>) {
    let f = normalize_for_compare(input.front);
    let b = normalize_for_compare(input.back);
    if !f.is_empty() && f == b {
        issues.push(LintIssue::new(
            "front_back_identical",
            "card",
            "front 与 back 归一化后完全相同".to_string(),
            LintSeverity::Error,
        ));
    }
}

/// cloze 语法扫描结果。
struct ClozeScan {
    /// 合法挖空数（`{{cN::非空内容}}`）
    valid: usize,
    /// 空挖空（`{{c1::}}` 或 `{{c1::   }}`）
    empty: usize,
    /// 非法序号（`{{c0::x}}`、`{{cabc::x}}`）
    bad_index: usize,
    /// `{{c` 开头但没有配对 `}}` 收尾
    unclosed: usize,
}

/// 手写扫描器（不用 regex 以精确处理嵌套 `}}` 边界）：
/// 逐个定位 `{{c`，解析 `数字::内容}}`。
fn scan_cloze(s: &str) -> ClozeScan {
    let mut scan = ClozeScan {
        valid: 0,
        empty: 0,
        bad_index: 0,
        unclosed: 0,
    };
    // 用 find 跳转到下一个 "{{c"，所有中间偏移都落在 ASCII 序列上，
    // 保证字节索引始终在 UTF-8 字符边界（front 多为中文，逐字节步进会 panic）
    let mut i = 0;
    while let Some(rel) = s[i..].find("{{c") {
        let start = i + rel;
        let body_start = start + 3;
        // 解析数字序号
        let digits_end = s[body_start..]
            .find(|c: char| !c.is_ascii_digit())
            .map(|off| body_start + off)
            .unwrap_or(s.len());
        let digits = &s[body_start..digits_end];
        // 序号后必须紧跟 "::"
        if !s[digits_end..].starts_with("::") {
            // 不是 cloze 语法（如 {{correct}} 模板变量），跳过这个 "{{c"
            i = body_start;
            continue;
        }
        let content_start = digits_end + 2;
        match s[content_start..].find("}}") {
            Some(off) => {
                let content = &s[content_start..content_start + off];
                let index_ok =
                    !digits.is_empty() && digits.parse::<u32>().map(|n| n >= 1).unwrap_or(false);
                if !index_ok {
                    scan.bad_index += 1;
                } else if content.trim().is_empty() {
                    scan.empty += 1;
                } else {
                    scan.valid += 1;
                }
                i = content_start + off + 2;
            }
            None => {
                scan.unclosed += 1;
                i = content_start;
            }
        }
    }
    scan
}

/// 规则 3：cloze `{{cN::...}}` 未配对 / 空挖空 / 非法序号。
/// 检查对象：Text 字段（优先）+ front（有些模型把 cloze 写进 front）。
fn check_cloze(input: &CardLintInput, issues: &mut Vec<LintIssue>) {
    let targets: [(&str, &str); 2] = [("text", input.text.unwrap_or("")), ("front", input.front)];
    for (field, content) in targets {
        if !content.contains("{{c") {
            continue;
        }
        let scan = scan_cloze(content);
        if scan.unclosed > 0 {
            issues.push(LintIssue::new(
                "cloze_unclosed",
                field,
                format!("{} 处 cloze 挖空缺少配对的 }}}}", scan.unclosed),
                LintSeverity::Error,
            ));
        }
        if scan.empty > 0 {
            issues.push(LintIssue::new(
                "cloze_empty_answer",
                field,
                format!("{} 处 cloze 挖空内容为空", scan.empty),
                LintSeverity::Error,
            ));
        }
        if scan.bad_index > 0 {
            issues.push(LintIssue::new(
                "cloze_bad_index",
                field,
                format!("{} 处 cloze 序号非法（必须为 c1 及以上）", scan.bad_index),
                LintSeverity::Error,
            ));
        }
        if scan.valid == 0 && scan.unclosed == 0 && scan.empty == 0 && scan.bad_index == 0 {
            // 含 "{{c" 但完全解析不出 cloze（如 "{{correct}}" 模板变量残留），
            // 交由占位符规则处理，这里不报
        }
    }
    // Text 字段存在但没有任何合法挖空 → cloze 卡不可复习
    if let Some(text) = input.text {
        if !text.trim().is_empty() && !text.contains("{{c") {
            issues.push(LintIssue::new(
                "cloze_missing",
                "text",
                "Text 字段存在但不含任何 {{cN::...}} 挖空".to_string(),
                LintSeverity::Warn,
            ));
        }
    }
}

/// 规则 4：答案泄露——back 的归一化内容整体出现在 front 中。
/// back 过短（低于 `answer_leak_min_chars`）时跳过，避免 "是"/"A" 之类噪声。
fn check_answer_leak(input: &CardLintInput, cfg: &LintConfig, issues: &mut Vec<LintIssue>) {
    let f = normalize_for_compare(input.front);
    let b = normalize_for_compare(input.back);
    if b.chars().count() < cfg.answer_leak_min_chars || f.is_empty() {
        return;
    }
    // front==back 已由规则 1 报告，避免双报
    if f == b {
        return;
    }
    if f.contains(&b) {
        issues.push(LintIssue::new(
            "answer_leak",
            "front",
            "front 已包含 back 的完整答案内容".to_string(),
            LintSeverity::Warn,
        ));
    }
}

/// 规则 5：双概念启发式——一张卡同时问两件独立事实。
///
/// 命中任一信号即 flag（Warn，低置信不拒绝）：
/// - front 含 ≥2 个问号（中英文）；
/// - front 同时含"分别"与并列连词（和/及/与/、）；
/// - 英文 front 含 " and " 连接的两个疑问词从句。
fn check_multi_concept(input: &CardLintInput, issues: &mut Vec<LintIssue>) {
    let front = strip_html(input.front);
    let question_marks = front.chars().filter(|&c| c == '?' || c == '？').count();
    let has_fenbie =
        front.contains("分别") && ['和', '及', '与', '、'].iter().any(|&c| front.contains(c));
    let lower = front.to_lowercase();
    let interrogatives = ["what", "why", "how", "when", "where", "which", "who"];
    let english_double = lower.contains(" and ")
        && interrogatives
            .iter()
            .filter(|w| lower.matches(*w).count() > 0)
            .map(|w| lower.matches(w).count())
            .sum::<usize>()
            >= 2;

    if question_marks >= 2 || has_fenbie || english_double {
        issues.push(LintIssue::new(
            "multi_concept",
            "front",
            "front 疑似同时提问多个独立概念（建议拆分为多张卡）".to_string(),
            LintSeverity::Warn,
        ));
    }
}

/// 规则 6：最小信息原则——front 超长（阈值可配置）。
fn check_front_length(input: &CardLintInput, cfg: &LintConfig, issues: &mut Vec<LintIssue>) {
    let count = strip_html(input.front).chars().count();
    if count > cfg.max_front_chars {
        issues.push(LintIssue::new(
            "front_too_long",
            "front",
            format!(
                "front 长度 {} 超过最小信息原则阈值 {}（疑似整段粘贴）",
                count, cfg.max_front_chars
            ),
            LintSeverity::Warn,
        ));
    }
}

/// 规则 7：占位符/生成残留。
///
/// 检测（所有可见字段）：
/// - `{{UPPER_SNAKE}}` 形态的模板占位符（`{{DOCUMENT_CONTENT}}` 等）—— Error；
/// - TODO / FIXME 标记 —— Warn；
/// - 独立 token "xxx"（大小写不敏感、前后无字母数字）—— Warn；
/// - 空括号对 `【】`、`（）`、`()`（空挖空痕迹）—— Warn。
fn check_placeholder(input: &CardLintInput, issues: &mut Vec<LintIssue>) {
    let mut fields: Vec<(&str, &str)> = vec![("front", input.front), ("back", input.back)];
    if let Some(t) = input.text {
        fields.push(("text", t));
    }
    for (k, v) in input.extra_fields {
        if k == QA_FLAGS_FIELD {
            continue;
        }
        fields.push((k.as_str(), v.as_str()));
    }

    // {{UPPER_SNAKE}}：至少 2 个字符、全大写字母/下划线/数字
    let template_placeholder =
        regex::Regex::new(r"\{\{[A-Z][A-Z0-9_]+\}\}").expect("static regex must compile");
    // 独立 xxx token（3 个及以上 x，两侧非字母数字）
    let xxx_token = regex::Regex::new(r"(?i)(^|[^a-z0-9])x{3,}([^a-z0-9]|$)")
        .expect("static regex must compile");

    for (field, content) in fields {
        if content.is_empty() {
            continue;
        }
        if let Some(m) = template_placeholder.find(content) {
            issues.push(LintIssue::new(
                "placeholder_residue",
                field,
                format!("残留模板占位符 {}", m.as_str()),
                LintSeverity::Error,
            ));
        }
        if content.contains("TODO") || content.contains("FIXME") {
            issues.push(LintIssue::new(
                "todo_residue",
                field,
                "残留 TODO/FIXME 标记".to_string(),
                LintSeverity::Warn,
            ));
        }
        if xxx_token.is_match(content) {
            issues.push(LintIssue::new(
                "xxx_residue",
                field,
                "残留占位 token \"xxx\"".to_string(),
                LintSeverity::Warn,
            ));
        }
        for pair in ["【】", "（）", "()"] {
            if content.contains(pair) {
                issues.push(LintIssue::new(
                    "empty_brackets",
                    field,
                    format!("含空括号对 \"{}\"（疑似漏填内容）", pair),
                    LintSeverity::Warn,
                ));
                break; // 同字段只报一次
            }
        }
    }
}

/// 规则 8：tags 为空（或全是空白 tag）。仅 Info——不影响可复习性。
fn check_tags_empty(input: &CardLintInput, issues: &mut Vec<LintIssue>) {
    if input.tags.iter().all(|t| t.trim().is_empty()) {
        issues.push(LintIssue::new(
            "tags_empty",
            "tags",
            "卡片没有任何标签（影响检索与组卡）".to_string(),
            LintSeverity::Info,
        ));
    }
}

/// 规则 11：选择题结构检查。
///
/// 通过 extra_fields 中的 optionA/optionB/...（大小写与 option_a 变体不敏感）
/// 识别选择题。识别到后检查：
/// - 非空选项 < 2 → `mcq_too_few_options`（Error，无法作答）；
/// - correct/answer 字段为选项字母但对应选项缺失/为空 → `mcq_answer_not_in_options`（Error）；
/// - correct 字段存在但为空 → `mcq_missing_answer`（Warn）。
fn check_mcq(input: &CardLintInput, issues: &mut Vec<LintIssue>) {
    // 收集 option 槽位：letter -> 值
    let mut options: HashMap<char, String> = HashMap::new();
    for (k, v) in input.extra_fields {
        let norm: String = k
            .chars()
            .filter(|c| c.is_ascii_alphanumeric())
            .flat_map(|c| c.to_lowercase())
            .collect();
        if let Some(letter) = norm.strip_prefix("option").and_then(|rest| {
            let mut chars = rest.chars();
            match (chars.next(), chars.next()) {
                (Some(c @ 'a'..='z'), None) => Some(c),
                _ => None,
            }
        }) {
            options.insert(letter, v.clone());
        }
    }
    if options.is_empty() {
        return; // 不是选择题
    }

    let non_empty = options.values().filter(|v| !v.trim().is_empty()).count();
    if non_empty < 2 {
        issues.push(LintIssue::new(
            "mcq_too_few_options",
            "options",
            format!("选择题仅 {} 个非空选项（至少需要 2 个）", non_empty),
            LintSeverity::Error,
        ));
    }

    // 查找答案字段
    let answer = input
        .extra_fields
        .iter()
        .find(|(k, _)| {
            let lower = k.to_lowercase();
            lower == "correct"
                || lower == "answer"
                || lower == "correct_answer"
                || lower == "correctanswer"
        })
        .map(|(_, v)| v.trim());

    match answer {
        Some("") => {
            issues.push(LintIssue::new(
                "mcq_missing_answer",
                "correct",
                "选择题缺少答案字段内容".to_string(),
                LintSeverity::Warn,
            ));
        }
        Some(ans) => {
            // 单字母答案（含 "A."、"a）" 等修饰）→ 检查对应选项存在且非空
            let letters: Vec<char> = ans
                .chars()
                .filter(|c| c.is_ascii_alphabetic())
                .flat_map(|c| c.to_lowercase())
                .collect();
            let is_letter_answer = !letters.is_empty()
                && letters.len() <= 4
                && ans.chars().filter(|c| c.is_alphanumeric()).count() == letters.len();
            if is_letter_answer {
                for letter in letters {
                    let ok = options
                        .get(&letter)
                        .map(|v| !v.trim().is_empty())
                        .unwrap_or(false);
                    if !ok {
                        issues.push(LintIssue::new(
                            "mcq_answer_not_in_options",
                            "correct",
                            format!(
                                "答案 \"{}\" 对应的选项 {} 缺失或为空",
                                ans,
                                letter.to_uppercase()
                            ),
                            LintSeverity::Error,
                        ));
                    }
                }
            } else {
                // 全文答案：应与某个选项内容归一化后一致
                let ans_norm = normalize_for_compare(ans);
                let matched = options
                    .values()
                    .any(|v| !ans_norm.is_empty() && normalize_for_compare(v) == ans_norm);
                if !matched {
                    issues.push(LintIssue::new(
                        "mcq_answer_not_in_options",
                        "correct",
                        "答案内容与任何选项都不匹配".to_string(),
                        LintSeverity::Error,
                    ));
                }
            }
        }
        None => {
            issues.push(LintIssue::new(
                "mcq_missing_answer",
                "correct",
                "选择题缺少 correct/answer 字段".to_string(),
                LintSeverity::Warn,
            ));
        }
    }
}

/// 规则 12：语言混杂启发式（低置信，仅 Info，永不拒绝）。
///
/// 统计 back 中 CJK 与拉丁字母的占比：两种文字各占字母总量 ≥30%
/// 且字母总量达到 `mixed_language_min_letters` 时 flag。
/// 中英夹杂在术语卡中常见（如 "TCP 三次握手"），因此仅提示。
fn check_mixed_language(input: &CardLintInput, cfg: &LintConfig, issues: &mut Vec<LintIssue>) {
    let text = strip_html(input.back);
    let mut cjk = 0usize;
    let mut latin = 0usize;
    for c in text.chars() {
        if is_cjk(c) {
            cjk += 1;
        } else if c.is_ascii_alphabetic() {
            latin += 1;
        }
    }
    let total = cjk + latin;
    if total < cfg.mixed_language_min_letters {
        return;
    }
    let cjk_ratio = cjk as f64 / total as f64;
    if cjk_ratio >= 0.30 && (1.0 - cjk_ratio) >= 0.30 {
        issues.push(LintIssue::new(
            "mixed_language",
            "back",
            format!(
                "back 中日韩文字与拉丁字母大量混杂（CJK {:.0}% / Latin {:.0}%），请人工确认是否符合预期",
                cjk_ratio * 100.0,
                (1.0 - cjk_ratio) * 100.0
            ),
            LintSeverity::Info,
        ));
    }
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::FieldType;

    fn empty_extras() -> HashMap<String, String> {
        HashMap::new()
    }

    fn basic_input<'a>(
        front: &'a str,
        back: &'a str,
        tags: &'a [String],
        extras: &'a HashMap<String, String>,
    ) -> CardLintInput<'a> {
        CardLintInput {
            front,
            back,
            text: None,
            tags,
            extra_fields: extras,
        }
    }

    fn codes(issues: &[LintIssue]) -> Vec<&str> {
        issues.iter().map(|i| i.code.as_str()).collect()
    }

    fn tags(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // -------- 规则 1：front == back --------

    #[test]
    fn identical_front_back_is_error() {
        let extras = empty_extras();
        let t = tags(&["物理"]);
        let input = basic_input("牛顿第一定律", "牛顿第一定律", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"front_back_identical"));
        assert!(issues
            .iter()
            .any(|i| i.code == "front_back_identical" && i.severity == LintSeverity::Error));
    }

    #[test]
    fn identical_after_html_and_whitespace_normalization() {
        let extras = empty_extras();
        let t = tags(&["物理"]);
        let input = basic_input("<b>什么是 TCP？</b>", "什么是TCP", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"front_back_identical"));
    }

    #[test]
    fn different_front_back_passes() {
        let extras = empty_extras();
        let t = tags(&["网络"]);
        let input = basic_input("TCP 的全称是什么？", "传输控制协议", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(!codes(&issues).contains(&"front_back_identical"));
    }

    // -------- 规则 2：空字段 --------

    #[test]
    fn empty_front_and_back_are_errors() {
        let extras = empty_extras();
        let t = tags(&["x"]);
        let input = basic_input("   ", "\t\n", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        let c = codes(&issues);
        assert!(c.contains(&"empty_front"));
        assert!(c.contains(&"empty_back"));
    }

    #[test]
    fn cloze_card_with_text_allows_empty_back() {
        let extras = empty_extras();
        let t = tags(&["化学"]);
        let input = CardLintInput {
            front: "水的沸点是{{c1::100}}摄氏度",
            back: "",
            text: Some("水的沸点是{{c1::100}}摄氏度"),
            tags: &t,
            extra_fields: &extras,
        };
        let issues = lint_card(&input, &LintConfig::default());
        let c = codes(&issues);
        assert!(!c.contains(&"empty_back"), "cloze 卡允许空 back: {:?}", c);
        assert!(!c.contains(&"empty_front"));
    }

    // -------- 规则 3：cloze --------

    #[test]
    fn valid_cloze_passes() {
        let extras = empty_extras();
        let t = tags(&["化学"]);
        let input = CardLintInput {
            front: "",
            back: "",
            text: Some("水在标准大气压下的沸点是{{c1::100}}摄氏度，冰点是{{c2::0}}摄氏度"),
            tags: &t,
            extra_fields: &extras,
        };
        let issues = lint_card(&input, &LintConfig::default());
        assert!(
            !codes(&issues).iter().any(|c| c.starts_with("cloze_")),
            "合法 cloze 不应报 cloze 违规: {:?}",
            issues
        );
    }

    #[test]
    fn unclosed_cloze_is_error() {
        let extras = empty_extras();
        let t = tags(&["化学"]);
        let input = CardLintInput {
            front: "",
            back: "",
            text: Some("沸点是{{c1::100 摄氏度"),
            tags: &t,
            extra_fields: &extras,
        };
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"cloze_unclosed"));
    }

    #[test]
    fn empty_cloze_answer_is_error() {
        let extras = empty_extras();
        let t = tags(&["化学"]);
        let input = CardLintInput {
            front: "",
            back: "",
            text: Some("沸点是{{c1::}}摄氏度"),
            tags: &t,
            extra_fields: &extras,
        };
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"cloze_empty_answer"));
    }

    #[test]
    fn cloze_index_zero_is_error() {
        let extras = empty_extras();
        let t = tags(&["化学"]);
        let input = CardLintInput {
            front: "",
            back: "",
            text: Some("沸点是{{c0::100}}摄氏度"),
            tags: &t,
            extra_fields: &extras,
        };
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"cloze_bad_index"));
    }

    #[test]
    fn text_field_without_any_cloze_is_flagged() {
        let extras = empty_extras();
        let t = tags(&["化学"]);
        let input = CardLintInput {
            front: "沸点",
            back: "100 摄氏度",
            text: Some("水的沸点是 100 摄氏度"),
            tags: &t,
            extra_fields: &extras,
        };
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"cloze_missing"));
    }

    #[test]
    fn cloze_in_front_is_also_scanned() {
        let extras = empty_extras();
        let t = tags(&["化学"]);
        let input = basic_input("沸点是{{c1::}}摄氏度", "100", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(issues
            .iter()
            .any(|i| i.code == "cloze_empty_answer" && i.field == "front"));
    }

    // -------- 规则 4：答案泄露 --------

    #[test]
    fn answer_leak_detected() {
        let extras = empty_extras();
        let t = tags(&["网络"]);
        let input = basic_input(
            "TCP 全称是传输控制协议，请问 TCP 的全称是什么？",
            "传输控制协议",
            &t,
            &extras,
        );
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"answer_leak"));
    }

    #[test]
    fn short_back_does_not_trigger_leak() {
        let extras = empty_extras();
        let t = tags(&["判断"]);
        // back 仅 1 字符，低于 answer_leak_min_chars，不判泄露
        let input = basic_input("地球是行星吗？答案是或否。", "是", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(!codes(&issues).contains(&"answer_leak"));
    }

    // -------- 规则 5：双概念 --------

    #[test]
    fn double_question_marks_flag_multi_concept() {
        let extras = empty_extras();
        let t = tags(&["物理"]);
        let input = basic_input("什么是惯性？什么是加速度？", "……", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"multi_concept"));
    }

    #[test]
    fn fenbie_conjunction_flags_multi_concept() {
        let extras = empty_extras();
        let t = tags(&["生物"]);
        let input = basic_input(
            "线粒体和叶绿体的功能分别是什么",
            "线粒体供能；叶绿体光合作用",
            &t,
            &extras,
        );
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"multi_concept"));
    }

    #[test]
    fn single_question_passes_multi_concept() {
        let extras = empty_extras();
        let t = tags(&["物理"]);
        let input = basic_input("什么是惯性？", "物体保持原有运动状态的性质", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(!codes(&issues).contains(&"multi_concept"));
    }

    // -------- 规则 6：front 过长 --------

    #[test]
    fn overlong_front_is_flagged_with_configurable_threshold() {
        let extras = empty_extras();
        let t = tags(&["历史"]);
        let long_front = "问".repeat(50);
        let input = basic_input(&long_front, "答案", &t, &extras);

        let mut cfg = LintConfig::default();
        cfg.max_front_chars = 40;
        let issues = lint_card(&input, &cfg);
        assert!(codes(&issues).contains(&"front_too_long"));

        cfg.max_front_chars = 60;
        let issues = lint_card(&input, &cfg);
        assert!(!codes(&issues).contains(&"front_too_long"));
    }

    #[test]
    fn front_length_counts_visible_chars_not_html() {
        let extras = empty_extras();
        let t = tags(&["x"]);
        // 大量 HTML 标签但可见文本很短 → 不 flag
        let front = format!("<div class=\"very-long-class-name\">{}</div>", "短问题");
        let input = basic_input(&front, "答", &t, &extras);
        let mut cfg = LintConfig::default();
        cfg.max_front_chars = 10;
        let issues = lint_card(&input, &cfg);
        assert!(!codes(&issues).contains(&"front_too_long"));
    }

    // -------- 规则 7：占位符 --------

    #[test]
    fn document_content_placeholder_is_error() {
        let extras = empty_extras();
        let t = tags(&["x"]);
        let input = basic_input("请总结 {{DOCUMENT_CONTENT}}", "内容", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(issues
            .iter()
            .any(|i| i.code == "placeholder_residue" && i.severity == LintSeverity::Error));
    }

    #[test]
    fn todo_and_xxx_residue_flagged() {
        let extras = empty_extras();
        let t = tags(&["x"]);
        let input = basic_input("什么是惯性？", "TODO: 补充答案 xxx", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        let c = codes(&issues);
        assert!(c.contains(&"todo_residue"));
        assert!(c.contains(&"xxx_residue"));
    }

    #[test]
    fn empty_cjk_brackets_flagged() {
        let extras = empty_extras();
        let t = tags(&["x"]);
        let input = basic_input("填空：中国的首都是【】", "北京", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"empty_brackets"));
    }

    #[test]
    fn cloze_syntax_is_not_mistaken_for_placeholder() {
        let extras = empty_extras();
        let t = tags(&["化学"]);
        let input = CardLintInput {
            front: "",
            back: "",
            text: Some("沸点是{{c1::100}}摄氏度"),
            tags: &t,
            extra_fields: &extras,
        };
        let issues = lint_card(&input, &LintConfig::default());
        assert!(!codes(&issues).contains(&"placeholder_residue"));
    }

    #[test]
    fn normal_word_with_xx_inside_not_flagged() {
        let extras = empty_extras();
        let t = tags(&["math"]);
        // "maxxx" 内嵌于字母上下文，不应命中独立 xxx token…… 实际上
        // 正则要求两侧非字母数字，"maxxxi" 不命中
        let input = basic_input("What is maxxxi?", "a name", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(!codes(&issues).contains(&"xxx_residue"));
    }

    // -------- 规则 8：tags --------

    #[test]
    fn empty_tags_is_info_only() {
        let extras = empty_extras();
        let t: Vec<String> = vec![];
        let input = basic_input("什么是惯性？", "保持运动状态的性质", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        let tag_issue = issues
            .iter()
            .find(|i| i.code == "tags_empty")
            .expect("must flag");
        assert_eq!(tag_issue.severity, LintSeverity::Info);
        // Info 永不导致拒绝
        let mut cfg = LintConfig::default();
        cfg.level = LintLevel::Reject;
        assert!(!should_reject(&issues, &cfg));
    }

    #[test]
    fn whitespace_only_tags_count_as_empty() {
        let extras = empty_extras();
        let t = tags(&["  ", "\t"]);
        let input = basic_input("什么是惯性？", "保持运动状态的性质", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"tags_empty"));
    }

    // -------- 规则 9/9b：重复卡 + 近重复 --------

    #[test]
    fn duplicate_front_detected_by_tracker() {
        let extras = empty_extras();
        let t = tags(&["网络"]);
        let cfg = LintConfig::default();
        let mut tracker = FingerprintTracker::new();

        let first = basic_input("什么是 TCP？", "传输控制协议", &t, &extras);
        let issues1 = lint_card_with_tracker(&first, &cfg, &mut tracker);
        assert!(!codes(&issues1).contains(&"duplicate_in_document"));

        // HTML/空白/大小写差异不影响指纹
        let second = basic_input("<b>什么是TCP</b>", "传输控制协议", &t, &extras);
        let issues2 = lint_card_with_tracker(&second, &cfg, &mut tracker);
        assert!(codes(&issues2).contains(&"duplicate_in_document"));
        assert_eq!(tracker.len(), 1);
    }

    #[test]
    fn distinct_fronts_not_flagged_as_duplicate() {
        let extras = empty_extras();
        let t = tags(&["网络"]);
        let cfg = LintConfig::default();
        let mut tracker = FingerprintTracker::new();
        let a = basic_input("什么是 TCP？", "传输控制协议", &t, &extras);
        let b = basic_input("什么是 UDP？", "用户数据报协议", &t, &extras);
        lint_card_with_tracker(&a, &cfg, &mut tracker);
        let issues = lint_card_with_tracker(&b, &cfg, &mut tracker);
        assert!(!codes(&issues).contains(&"duplicate_in_document"));
        assert!(!codes(&issues).contains(&"near_duplicate"));
        assert_eq!(tracker.len(), 2);
    }

    #[test]
    fn observe_first_sighting_is_clean() {
        let mut tracker = FingerprintTracker::new();
        let obs = tracker.observe("细胞膜的主要成分是什么？");
        assert!(!obs.exact_duplicate);
        assert!(obs.near_duplicate.is_none());
        assert_eq!(tracker.len(), 1);
    }

    #[test]
    fn near_duplicate_small_edit_flagged_with_similarity() {
        let mut tracker = FingerprintTracker::new();
        tracker.observe("细胞膜的主要成分是磷脂双分子层");
        // 小编辑（追加两字）→ bigram Jaccard 13/15 ≈ 0.87 ≥ 0.82
        let obs = tracker.observe("细胞膜的主要成分是磷脂双分子层结构");
        assert!(!obs.exact_duplicate);
        let sim = obs.near_duplicate.expect("小编辑必须判为近重复");
        assert!(
            sim >= DEFAULT_NEAR_DUPLICATE_THRESHOLD && sim < 1.0,
            "sim={}",
            sim
        );

        // 经 lint 输出为 near_duplicate flag（Warn，不丢卡）
        let issues = issues_from_observation(&obs);
        assert_eq!(issues.len(), 1);
        assert_eq!(issues[0].code, "near_duplicate");
        assert_eq!(issues[0].severity, LintSeverity::Warn);
        assert!(
            issues[0].message.contains('%'),
            "message 应携带相似度百分比"
        );
    }

    #[test]
    fn exact_duplicate_not_double_flagged_as_near_duplicate() {
        let mut tracker = FingerprintTracker::new();
        tracker.observe("什么是操作系统？");
        let obs = tracker.observe("什么是操作系统？");
        assert!(obs.exact_duplicate);
        assert!(
            obs.near_duplicate.is_none(),
            "精确重复不叠加 near_duplicate"
        );
        let issues = issues_from_observation(&obs);
        assert_eq!(codes(&issues), vec!["duplicate_in_document"]);
    }

    #[test]
    fn near_duplicate_threshold_is_configurable() {
        // 阈值拉满到 1.0：小编辑不再判近重复
        let mut strict = FingerprintTracker::with_near_duplicate_threshold(1.0);
        strict.observe("细胞膜的主要成分是磷脂双分子层");
        let obs = strict.observe("细胞膜的主要成分是磷脂双分子层结构");
        assert!(obs.near_duplicate.is_none());

        // 阈值放宽到 0.4：语序调整也会被捕获
        let mut loose = FingerprintTracker::with_near_duplicate_threshold(0.4);
        loose.observe("什么是tcp协议");
        let obs = loose.observe("tcp协议是什么");
        assert!(obs.near_duplicate.is_some(), "低阈值应捕获语序调整");
    }

    #[test]
    fn empty_or_whitespace_front_never_flagged_as_duplicate() {
        let mut tracker = FingerprintTracker::new();
        assert_eq!(tracker.observe(""), FingerprintObservation::default());
        assert_eq!(tracker.observe("   "), FingerprintObservation::default());
        assert_eq!(
            tracker.observe("<b> </b>"),
            FingerprintObservation::default()
        );
        assert!(tracker.is_empty(), "空指纹不得登记");
    }

    #[test]
    fn cloze_text_field_preferred_as_duplicate_key() {
        let extras = empty_extras();
        let t = tags(&["化学"]);
        let cfg = LintConfig::default();
        let mut tracker = FingerprintTracker::new();
        // 两张卡 front 不同但 cloze Text 相同 → 判重复
        let a = CardLintInput {
            front: "渲染视图A",
            back: "",
            text: Some("水的沸点是{{c1::100}}摄氏度"),
            tags: &t,
            extra_fields: &extras,
        };
        let b = CardLintInput {
            front: "渲染视图B",
            back: "",
            text: Some("水的沸点是{{c1::100}}摄氏度"),
            tags: &t,
            extra_fields: &extras,
        };
        lint_card_with_tracker(&a, &cfg, &mut tracker);
        let issues = lint_card_with_tracker(&b, &cfg, &mut tracker);
        assert!(codes(&issues).contains(&"duplicate_in_document"));
    }

    #[test]
    fn near_tracked_cap_bounds_index_but_exact_dedup_survives() {
        let mut tracker = FingerprintTracker::new();
        tracker.max_near_tracked = 1;
        tracker.observe("第一张完全不同的卡片内容");
        tracker.observe("第二张也完全不同的另一内容");
        // 超过 cap 后：与第二张近似的卡不再判近重复（第二张未入 bigram 索引）
        let obs = tracker.observe("第二张也完全不同的另一内容啊");
        assert!(obs.near_duplicate.is_none(), "cap 之外不做近重复扫描");
        // 但精确重复检测不受 cap 影响
        let obs = tracker.observe("第二张也完全不同的另一内容");
        assert!(obs.exact_duplicate);
    }

    #[test]
    fn duplicate_flags_are_warn_and_never_reject() {
        let mut cfg = LintConfig::default();
        cfg.level = LintLevel::Reject;
        let dup = issues_from_observation(&FingerprintObservation {
            exact_duplicate: true,
            near_duplicate: None,
        });
        let near = issues_from_observation(&FingerprintObservation {
            exact_duplicate: false,
            near_duplicate: Some(0.9),
        });
        assert!(!should_reject(&dup, &cfg), "重复只 flag 不丢卡");
        assert!(!should_reject(&near, &cfg), "近重复只 flag 不丢卡");
    }

    // -------- 文档级 tracker registry --------

    #[test]
    fn document_tracker_registry_shares_state_across_handles() {
        let doc_id = format!("doc-registry-share-{}", std::process::id());
        release_document_tracker(&doc_id);

        // 模拟两个 segment task 各自取 handle（生产路径的并发形态）
        let handle_a = document_tracker(&doc_id);
        let handle_b = document_tracker(&doc_id);
        assert!(
            Arc::ptr_eq(&handle_a, &handle_b),
            "同一文档必须共享同一 tracker"
        );

        handle_a.lock().unwrap().observe("跨segment共享的front");
        let obs = handle_b.lock().unwrap().observe("跨segment共享的front");
        assert!(
            obs.exact_duplicate,
            "另一 segment 的 handle 必须看到已登记指纹"
        );

        release_document_tracker(&doc_id);
    }

    #[test]
    fn document_tracker_registry_isolates_documents() {
        let doc_a = format!("doc-registry-iso-a-{}", std::process::id());
        let doc_b = format!("doc-registry-iso-b-{}", std::process::id());
        release_document_tracker(&doc_a);
        release_document_tracker(&doc_b);

        let issues_a = observe_document_card(&doc_a, "同一个front");
        assert!(issues_a.is_empty());
        // 不同文档看不到彼此的指纹
        let issues_b = observe_document_card(&doc_b, "同一个front");
        assert!(issues_b.is_empty(), "不同文档必须相互隔离: {:?}", issues_b);
        // 同文档第二次 → 重复
        let issues_a2 = observe_document_card(&doc_a, "同一个front");
        assert_eq!(codes(&issues_a2), vec!["duplicate_in_document"]);

        release_document_tracker(&doc_a);
        release_document_tracker(&doc_b);
    }

    #[test]
    fn release_document_tracker_resets_state() {
        let doc_id = format!("doc-registry-release-{}", std::process::id());
        release_document_tracker(&doc_id);

        assert!(observe_document_card(&doc_id, "释放前的front").is_empty());
        assert_eq!(
            codes(&observe_document_card(&doc_id, "释放前的front")),
            vec!["duplicate_in_document"]
        );

        release_document_tracker(&doc_id);
        // 释放后重新懒创建，状态清零
        assert!(
            observe_document_card(&doc_id, "释放前的front").is_empty(),
            "释放后不得残留旧指纹"
        );
        release_document_tracker(&doc_id);
    }

    #[test]
    fn observe_document_card_blank_inputs_are_noop() {
        assert!(observe_document_card("", "有内容的front").is_empty());
        assert!(observe_document_card("   ", "有内容的front").is_empty());
        let doc_id = format!("doc-registry-blank-{}", std::process::id());
        release_document_tracker(&doc_id);
        assert!(observe_document_card(&doc_id, "").is_empty());
        assert!(observe_document_card(&doc_id, "  ").is_empty());
        // 空 key 不得登记指纹：随后真实 front 首次出现仍是干净的
        assert!(observe_document_card(&doc_id, "真实front").is_empty());
        release_document_tracker(&doc_id);
    }

    #[test]
    fn observe_document_card_emits_near_duplicate() {
        let doc_id = format!("doc-registry-near-{}", std::process::id());
        release_document_tracker(&doc_id);
        assert!(observe_document_card(&doc_id, "细胞膜的主要成分是磷脂双分子层").is_empty());
        let issues = observe_document_card(&doc_id, "细胞膜的主要成分是磷脂双分子层结构");
        assert_eq!(codes(&issues), vec!["near_duplicate"]);
        assert_eq!(issues[0].severity, LintSeverity::Warn);
        release_document_tracker(&doc_id);
    }

    #[test]
    fn check_and_insert_back_compat_wrapper() {
        let mut tracker = FingerprintTracker::new();
        assert!(!tracker.check_and_insert("什么是 TCP？"));
        assert!(tracker.check_and_insert("<b>什么是TCP</b>"));
        assert!(!tracker.check_and_insert(""));
    }

    // -------- 规则 10：字段规则 --------

    #[test]
    fn field_rule_min_max_allowed_pattern() {
        let rule = FieldExtractionRule {
            field_type: FieldType::Text,
            is_required: true,
            default_value: None,
            validation_pattern: Some("^[A-D]$".to_string()),
            description: "正确选项".to_string(),
            validation: None,
            transform: None,
            schema: None,
            item_schema: None,
            display_format: None,
            ai_hint: None,
            max_length: Some(1),
            min_length: Some(1),
            allowed_values: Some(vec![json!("A"), json!("B"), json!("C"), json!("D")]),
            depends_on: None,
            compute_function: None,
        };
        // "E" 长度合法但 allowed_values 与 pattern 双违规
        let issues = lint_field_against_rule("correct", "E", &rule);
        let c = codes(&issues);
        assert!(c.contains(&"field_rule_allowed_values"));
        assert!(c.contains(&"field_rule_pattern"));
        // "AB" 超长
        let issues = lint_field_against_rule("correct", "AB", &rule);
        assert!(codes(&issues).contains(&"field_rule_max_length"));
        // "" 过短
        let issues = lint_field_against_rule("correct", "", &rule);
        assert!(codes(&issues).contains(&"field_rule_min_length"));
        // "A" 全部通过
        let issues = lint_field_against_rule("correct", "A", &rule);
        assert!(issues.is_empty());
    }

    // -------- 规则 11：选择题 --------

    fn mcq_extras(
        options: &[(&str, &str)],
        answer: Option<(&str, &str)>,
    ) -> HashMap<String, String> {
        let mut m = HashMap::new();
        for (k, v) in options {
            m.insert(k.to_string(), v.to_string());
        }
        if let Some((k, v)) = answer {
            m.insert(k.to_string(), v.to_string());
        }
        m
    }

    #[test]
    fn mcq_valid_card_passes() {
        let extras = mcq_extras(
            &[
                ("optionA", "地球"),
                ("optionB", "火星"),
                ("optionC", "金星"),
                ("optionD", "木星"),
            ],
            Some(("correct", "A")),
        );
        let t = tags(&["天文"]);
        let input = basic_input("太阳系中密度最大的行星？", "地球", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(
            !codes(&issues).iter().any(|c| c.starts_with("mcq_")),
            "{:?}",
            issues
        );
    }

    #[test]
    fn mcq_too_few_options_is_error() {
        let extras = mcq_extras(
            &[("optionA", "地球"), ("optionB", "  ")],
            Some(("correct", "A")),
        );
        let t = tags(&["天文"]);
        let input = basic_input("哪个是行星？", "地球", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(issues
            .iter()
            .any(|i| i.code == "mcq_too_few_options" && i.severity == LintSeverity::Error));
    }

    #[test]
    fn mcq_answer_letter_without_matching_option_is_error() {
        let extras = mcq_extras(
            &[("optionA", "地球"), ("optionB", "火星")],
            Some(("correct", "C")),
        );
        let t = tags(&["天文"]);
        let input = basic_input("哪个是行星？", "金星", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(codes(&issues).contains(&"mcq_answer_not_in_options"));
    }

    #[test]
    fn mcq_full_text_answer_matching_option_passes() {
        let extras = mcq_extras(
            &[("option_a", "地球"), ("option_b", "火星")],
            Some(("answer", "火星")),
        );
        let t = tags(&["天文"]);
        let input = basic_input("哪个是红色行星？", "火星", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(!codes(&issues).contains(&"mcq_answer_not_in_options"));
    }

    #[test]
    fn mcq_missing_answer_field_is_warn() {
        let extras = mcq_extras(&[("optionA", "地球"), ("optionB", "火星")], None);
        let t = tags(&["天文"]);
        let input = basic_input("哪个是行星？", "地球", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(issues
            .iter()
            .any(|i| i.code == "mcq_missing_answer" && i.severity == LintSeverity::Warn));
    }

    #[test]
    fn non_mcq_card_skips_mcq_rules() {
        let mut extras = empty_extras();
        extras.insert("note".to_string(), "补充说明".to_string());
        let t = tags(&["x"]);
        let input = basic_input("什么是惯性？", "保持运动状态的性质", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(!codes(&issues).iter().any(|c| c.starts_with("mcq_")));
    }

    // -------- 规则 12：语言混杂 --------

    #[test]
    fn heavily_mixed_language_is_info_and_never_rejects() {
        let extras = empty_extras();
        let t = tags(&["cs"]);
        let input = basic_input(
            "什么是操作系统调度？",
            "操作系统进程调度指的就是 the process of selecting which ready process runs next 这样一个由内核负责完成的核心决策过程",
            &t,
            &extras,
        );
        let issues = lint_card(&input, &LintConfig::default());
        let issue = issues
            .iter()
            .find(|i| i.code == "mixed_language")
            .expect("must flag");
        assert_eq!(issue.severity, LintSeverity::Info);
        let mut cfg = LintConfig::default();
        cfg.level = LintLevel::Reject;
        assert!(!should_reject(&[issue.clone()], &cfg), "语言混杂永不拒绝");
    }

    #[test]
    fn pure_chinese_back_not_flagged_as_mixed() {
        let extras = empty_extras();
        let t = tags(&["物理"]);
        let input = basic_input(
            "什么是惯性？",
            "惯性是物体保持原有运动状态不变的性质，是物体的固有属性，与外力无关",
            &t,
            &extras,
        );
        let issues = lint_card(&input, &LintConfig::default());
        assert!(!codes(&issues).contains(&"mixed_language"));
    }

    #[test]
    fn short_terminology_mix_below_threshold_not_flagged() {
        let extras = empty_extras();
        let t = tags(&["cs"]);
        // "TCP 协议" 之类短术语混排：字母总量低于阈值，不 flag
        let input = basic_input("TCP 是什么？", "TCP 协议", &t, &extras);
        let issues = lint_card(&input, &LintConfig::default());
        assert!(!codes(&issues).contains(&"mixed_language"));
    }

    // -------- LintLevel / should_reject --------

    #[test]
    fn default_flag_level_never_rejects_even_errors() {
        let extras = empty_extras();
        let t = tags(&["x"]);
        let input = basic_input("同一句话", "同一句话", &t, &extras);
        let cfg = LintConfig::default();
        let issues = lint_card(&input, &cfg);
        assert!(issues.iter().any(|i| i.severity == LintSeverity::Error));
        assert!(!should_reject(&issues, &cfg), "默认 Flag 级别不丢卡");
    }

    #[test]
    fn reject_level_rejects_only_on_error() {
        let mut cfg = LintConfig::default();
        cfg.level = LintLevel::Reject;

        let error_issue = LintIssue::new("empty_front", "front", "x".into(), LintSeverity::Error);
        let warn_issue = LintIssue::new("answer_leak", "front", "x".into(), LintSeverity::Warn);

        assert!(should_reject(&[error_issue], &cfg));
        assert!(!should_reject(&[warn_issue.clone()], &cfg));
        assert!(!should_reject(&[], &cfg));

        cfg.level = LintLevel::Flag;
        let error_issue = LintIssue::new("empty_front", "front", "x".into(), LintSeverity::Error);
        assert!(!should_reject(&[error_issue, warn_issue], &cfg));
    }

    // -------- merge_flags --------

    #[test]
    fn merge_flags_preserves_existing_field_rule_entries() {
        let mut extras = empty_extras();
        // 模拟 extract_fields_with_rules 已写入的字段规则违规
        extras.insert(
            QA_FLAGS_FIELD.to_string(),
            r#"[{"field":"front","rule":"min_length","message":"长度 3 小于最小长度 20"}]"#
                .to_string(),
        );
        let issues = vec![LintIssue::new(
            "answer_leak",
            "front",
            "泄露".into(),
            LintSeverity::Warn,
        )];
        merge_flags(&mut extras, &issues);

        let merged: Vec<Value> = serde_json::from_str(extras.get(QA_FLAGS_FIELD).unwrap()).unwrap();
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0]["rule"], "min_length", "既有条目必须保留在前");
        assert_eq!(merged[1]["code"], "answer_leak");
        assert_eq!(merged[1]["severity"], "warn");
    }

    #[test]
    fn merge_flags_is_idempotent_by_code_and_field() {
        let mut extras = empty_extras();
        let issues = vec![LintIssue::new(
            "tags_empty",
            "tags",
            "无标签".into(),
            LintSeverity::Info,
        )];
        merge_flags(&mut extras, &issues);
        merge_flags(&mut extras, &issues); // 重复 merge
        let merged: Vec<Value> = serde_json::from_str(extras.get(QA_FLAGS_FIELD).unwrap()).unwrap();
        assert_eq!(merged.len(), 1, "重复 merge 不产生重复条目");
    }

    #[test]
    fn merge_flags_no_issues_no_key() {
        let mut extras = empty_extras();
        merge_flags(&mut extras, &[]);
        assert!(
            !extras.contains_key(QA_FLAGS_FIELD),
            "干净卡片不写 _qa_flags"
        );
    }

    #[test]
    fn merge_flags_wraps_unparseable_legacy_value() {
        let mut extras = empty_extras();
        extras.insert(QA_FLAGS_FIELD.to_string(), "not-json".to_string());
        let issues = vec![LintIssue::new(
            "tags_empty",
            "tags",
            "无标签".into(),
            LintSeverity::Info,
        )];
        merge_flags(&mut extras, &issues);
        let merged: Vec<Value> = serde_json::from_str(extras.get(QA_FLAGS_FIELD).unwrap()).unwrap();
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0]["code"], "legacy_flags_unparsed");
        assert_eq!(merged[0]["message"], "not-json");
    }

    // -------- 组合与序列化 --------

    #[test]
    fn clean_card_produces_zero_issues() {
        let mut extras = empty_extras();
        extras.insert("note".to_string(), "牛顿力学基础".to_string());
        let t = tags(&["物理", "力学"]);
        let input = basic_input(
            "什么是惯性？",
            "物体保持原有运动状态不变的性质",
            &t,
            &extras,
        );
        let issues = lint_card(&input, &LintConfig::default());
        assert!(issues.is_empty(), "干净卡片必须零违规: {:?}", issues);
    }

    #[test]
    fn issue_serializes_to_expected_shape() {
        let issue = LintIssue::new("answer_leak", "front", "泄露".into(), LintSeverity::Warn);
        let v = serde_json::to_value(&issue).unwrap();
        assert_eq!(v["code"], "answer_leak");
        assert_eq!(v["field"], "front");
        assert_eq!(v["message"], "泄露");
        assert_eq!(v["severity"], "warn");
    }

    #[test]
    fn config_rules_can_be_disabled_individually() {
        let extras = empty_extras();
        let t: Vec<String> = vec![];
        let input = basic_input("同一句话？同一句话？", "同一句话", &t, &extras);
        let cfg = LintConfig {
            check_front_back_identical: false,
            check_multi_concept: false,
            check_tags_empty: false,
            check_answer_leak: false,
            ..LintConfig::default()
        };
        let issues = lint_card(&input, &cfg);
        assert!(issues.is_empty(), "关闭的规则不得产出违规: {:?}", issues);
    }

    #[test]
    fn qa_flags_field_name_matches_streaming_service() {
        // 两个模块独立声明同名常量以避免耦合；此断言守护两者不漂移
        assert_eq!(
            QA_FLAGS_FIELD,
            crate::streaming_anki_service::QA_FLAGS_FIELD
        );
    }

    #[test]
    fn lint_config_deserializes_with_serde_defaults() {
        // 前端只传部分字段时其余用默认值（serde(default)）
        let cfg: LintConfig =
            serde_json::from_str(r#"{"level":"reject","max_front_chars":100}"#).unwrap();
        assert_eq!(cfg.level, LintLevel::Reject);
        assert_eq!(cfg.max_front_chars, 100);
        assert!(cfg.check_cloze);
        assert_eq!(cfg.answer_leak_min_chars, 4);
    }

    // -------- codes 模块（稳定常量导出）契约守护（Round 5 #10） --------

    #[test]
    fn codes_module_matches_emitted_literals() {
        // codes::ALL 必须与规则实现实际产出的 code 字面量集合完全一致：
        // 新增规则忘了补常量、或常量拼错值，此测试即红。
        use std::collections::BTreeSet;
        let source = include_str!("anki_qa_lint.rs");
        let ctor = regex::Regex::new(r#"LintIssue::new\(\s*"([a-z_]+)""#).unwrap();
        let json_code = regex::Regex::new(r#""code":\s*"([a-z_]+)""#).unwrap();
        let mut emitted: BTreeSet<String> = BTreeSet::new();
        for caps in ctor.captures_iter(source) {
            emitted.insert(caps[1].to_string());
        }
        for caps in json_code.captures_iter(source) {
            emitted.insert(caps[1].to_string());
        }
        let declared: BTreeSet<String> = codes::ALL.iter().map(|s| s.to_string()).collect();
        assert_eq!(
            declared,
            emitted,
            "codes 模块与实际产出的 code 漂移：\n仅常量有: {:?}\n仅产出有: {:?}",
            declared.difference(&emitted).collect::<Vec<_>>(),
            emitted.difference(&declared).collect::<Vec<_>>()
        );
    }

    #[test]
    fn codes_module_matches_contract_list() {
        use std::collections::BTreeSet;
        let from_codes: BTreeSet<&str> = codes::ALL.iter().copied().collect();
        let from_contract: BTreeSet<&str> = crate::anki_gold_set::LINT_CONTRACT_CODES
            .iter()
            .copied()
            .collect();
        assert_eq!(
            from_codes, from_contract,
            "codes::ALL 与 LINT_CONTRACT_CODES 漂移"
        );
    }

    #[test]
    fn codes_module_all_is_exhaustive_and_unique() {
        use std::collections::HashSet;
        // ALL 无重复
        let set: HashSet<&str> = codes::ALL.iter().copied().collect();
        assert_eq!(set.len(), codes::ALL.len(), "codes::ALL 含重复项");
        // ALL 覆盖模块内声明的每个 &str 常量（漏列即红）
        let source = include_str!("anki_qa_lint.rs");
        let decl =
            regex::Regex::new(r#"pub const [A-Z][A-Z0-9_]*: &str = "([a-z][a-z0-9_]*)";"#).unwrap();
        let declared: HashSet<String> = decl
            .captures_iter(source)
            .map(|caps| caps[1].to_string())
            .collect();
        let listed: HashSet<String> = codes::ALL.iter().map(|s| s.to_string()).collect();
        assert_eq!(declared, listed, "codes 模块声明的常量与 ALL 清单不一致");
    }
}
