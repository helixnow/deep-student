//! # 金标卡集（Gold Set）挖掘纯函数（Round 4 #10）
//!
//! 实现 `docs/research/anki-ai-native/eval/gold-set-plan.md` 第 3 节挖掘管线的
//! 标注/抽取层：**「改前 = 劣化样本、改后 = 金标」**。从"编辑前原文 +
//! 编辑后现状 + 留存信号"三元组中提取：
//!
//! - **金标正例**（`KeptUnedited`）：生成后未编辑、复习达标且 again 率低；
//! - **修正对**（`EditedMinor` / `EditedMajor` / `ErrorCardRepaired`）：
//!   `{original, edited}` 对子，original 预期被 lint 命中、edited 预期零命中
//!   （plan §5.2 的修正对回归契约）；
//! - **负例**（`DeletedEarly`）：生成后早删且从未复习（噪声较大，仅弱信号）。
//!
//! ## 纯函数边界（刻意不做的事）
//!
//! 本模块**不读 SQLite、不写文件、不接管线**。调用方（离线挖掘脚本 / 未来的
//! Tauri 命令）负责把 `anki_cards` / FSRS 复习日志组装成 [`GoldCandidate`]，
//! 本模块只做确定性标注、编辑距离度量、lint 契约校验与脱敏导出整形。
//! chatanki 管线主路径零改动。
//!
//! ## 编辑前原文的来源
//!
//! plan §2 缺口中推荐的 P0 方案：生成时在 `extra_fields_json` 写入一次
//! `_original_generation: {front, back, text}`，永不更新。
//! [`insert_original_generation_once`] 提供有界、幂等的写入端，
//! [`extract_original_generation`] 负责从落库 JSON 中解出快照。
//!
//! ## 与 `anki_qa_lint` 的契约
//!
//! [`LINT_CONTRACT_CODES`] 固化 `anki_qa_lint` 全部稳定 code 字符串，
//! 是跨语言对齐的唯一事实来源：
//! - Rust 侧：本模块测试用正则扫描 `anki_qa_lint.rs` 源码，断言两者集合相等
//!   （新增/改名 lint 码若不同步更新此清单，测试即红）；
//! - JS 侧：eval harness（`scripts/anki-eval/lib/cardLint.mjs`）的对齐测试
//!   解析本常量，断言其 Rust-aligned 码全部落在契约内、eval-only 码不与契约冲突。

use crate::anki_qa_lint::{lint_card, CardLintInput, LintConfig, LintSeverity, QA_FLAGS_FIELD};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

/// `extra_fields_json` 中保存"生成时原文快照"的键名（plan §2 P0 方案）。
pub const ORIGINAL_GENERATION_FIELD: &str = "_original_generation";
/// critic 自动修订写入 `_qa_flags` 的稳定来源码。
///
/// 带该标记的内容不是用户修改，必须从用户金标挖掘中排除。
pub const CRITIC_REVISED_QA_CODE: &str = "llm_critic_revised";
/// `extra_fields_json` 中保存"最后一次内容写入者"溯源的键名（Wave2-E R2 P0-2）。
///
/// 与 `_qa_flags` **刻意解耦**：provenance 是事实记录而非 QA 留痕，不受
/// `enable_qa_pass` 门控——`anki_critic::sanitize_plan_for_disabled_qa_pass`
/// 只剥 `QA_FLAGS_FIELD`，本字段必须存活。gold 挖掘据此实施
/// "无用户证明不进修正对"（[`classify_candidate`] 编辑通道的编辑者闸门）。
pub const CONTENT_PROVENANCE_FIELD: &str = "_content_provenance";
/// provenance `actor` 的 wire 值（小写）：用户编辑。
pub const PROVENANCE_ACTOR_USER: &str = "user";
/// provenance `actor` 的 wire 值（小写）：LLM critic 自动修订。
pub const PROVENANCE_ACTOR_LLM_CRITIC: &str = "llm_critic";
/// provenance `actor` 的 wire 值（小写）：APKG 等外部导入。
pub const PROVENANCE_ACTOR_IMPORT: &str = "import";
/// provenance `actor` 的 wire 值（小写）：同步合并写入。
pub const PROVENANCE_ACTOR_SYNC: &str = "sync";

/// `_original_generation` 值本身的 UTF-8 字节硬上限。
///
/// 普通卡通常只有数百字节；16 KiB 足以容纳长公式/代码，同时避免异常模型输出
/// 让每张卡额外复制接近流缓冲硬上限的正文。超限时跳过快照，卡片本身仍须入库。
pub const ORIGINAL_GENERATION_MAX_BYTES: usize = 16 * 1024;

/// `anki_qa_lint` 全部稳定 lint code 字符串（跨语言契约清单）。
///
/// 顺序无语义；集合内容由测试与 `anki_qa_lint.rs` 源码互相锁定。
/// eval harness 的 JS lint 只复刻其中的内容级子集（tags/mcq/field_rule 等
/// 依赖模板与文档上下文的规则仅在 Rust 生产侧运行），但**凡是两侧都实现的
/// 规则，code 字符串必须逐字节一致**。
pub const LINT_CONTRACT_CODES: &[&str] = &[
    "front_back_identical",
    "empty_front",
    "empty_back",
    "cloze_unclosed",
    "cloze_empty_answer",
    "cloze_bad_index",
    "cloze_missing",
    "answer_leak",
    "multi_concept",
    "front_too_long",
    "placeholder_residue",
    "todo_residue",
    "xxx_residue",
    "empty_brackets",
    "tags_empty",
    "duplicate_in_document",
    "near_duplicate",
    "mixed_language",
    "mcq_too_few_options",
    "mcq_answer_not_in_options",
    "mcq_missing_answer",
    "field_rule_min_length",
    "field_rule_max_length",
    "field_rule_allowed_values",
    "field_rule_pattern",
    "legacy_flags_unparsed",
];

// ============================================================================
// 输入/输出结构
// ============================================================================

/// 卡片内容快照（编辑前或编辑后的某一时刻）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct CardSnapshot {
    #[serde(default)]
    pub front: String,
    #[serde(default)]
    pub back: String,
    /// Cloze 模板的 Text 字段（问答卡为 None）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

impl CardSnapshot {
    /// front/back/text 拼接为编辑距离度量用的单一字符串。
    fn combined(&self) -> String {
        let mut s = String::new();
        s.push_str(&self.front);
        s.push('\n');
        s.push_str(&self.back);
        if let Some(t) = &self.text {
            s.push('\n');
            s.push_str(t);
        }
        s
    }

    fn is_blank(&self) -> bool {
        self.front.trim().is_empty()
            && self.back.trim().is_empty()
            && self.text.as_deref().map(str::trim).unwrap_or("").is_empty()
    }
}

/// 挖掘候选：调用方从 `anki_cards` + FSRS 复习日志组装的单卡切面。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoldCandidate {
    pub card_id: String,
    /// 当前（编辑后）内容。
    pub current: CardSnapshot,
    /// 生成时原文（来自 `_original_generation`，用 [`extract_original_generation`]
    /// 解出）。None = 埋点缺失，只能走留存信号路径。
    pub original: Option<CardSnapshot>,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    /// 卡片已被删除时的删除时刻（软删/审计日志提供）。
    pub deleted_at_ms: Option<i64>,
    /// FSRS 复习总次数。
    pub review_count: u32,
    /// 复习中评分为 again 的次数（review_count 的子集）。
    pub again_count: u32,
    /// 生成时即为错误卡（is_error_card=1 的历史态，由修订记录派生）。
    pub was_error_card: bool,
    /// 当前仍是错误卡。
    pub is_error_card: bool,
    /// 当前内容由 critic 自动修订，而非用户编辑。
    #[serde(default)]
    pub critic_revised: bool,
    /// 最后一次内容写入的 actor（来自 `_content_provenance`，见
    /// `PROVENANCE_ACTOR_*`）。None = 旧数据 / 埋点缺失——编辑通道将保守地
    /// 视为"缺编辑者证明"，不产出修正对。`#[serde(default)]` 保证旧
    /// fixture / 离线脚本 JSON 零迁移。
    #[serde(default)]
    pub edit_actor: Option<String>,
}

/// 标注结果（plan §3 label 步骤 + 错误卡修复通道）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoldLabel {
    /// 强正例：未编辑 + 留存达标 → 金标正例（lint 零误报校准集）。
    KeptUnedited,
    /// 弱正例 + 修正对：小幅编辑（编辑距离比 < 阈值）。
    EditedMinor,
    /// 强负例 + 修正对：大幅重写。
    EditedMajor,
    /// 负例（噪声较大）：早删且从未复习。
    DeletedEarly,
    /// 错误卡被用户修好：解析失败样本 + 人工修复答案。
    ErrorCardRepaired,
    /// 信号不足，不入任何金标桶（reason 字段说明原因）。
    Unlabeled,
}

/// 修正对：`original` 应劣化（lint 命中）、`edited` 应为金标（lint 零命中）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RepairPair {
    pub original: CardSnapshot,
    pub edited: CardSnapshot,
    /// 字符级编辑距离 / 原文长度（0.0 = 未变，1.0+ = 面目全非）。
    pub distance_ratio: f64,
}

/// 单卡挖掘结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GoldSample {
    pub card_id: String,
    pub label: GoldLabel,
    /// 人类可读的标注依据（Unlabeled 时为不入桶原因）。
    pub reason: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repair_pair: Option<RepairPair>,
}

/// 挖掘阈值（默认值即 plan §3 伪代码中的数字）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct GoldMiningConfig {
    /// updated_at - created_at 小于该值视为"从未编辑"（默认 5 分钟：
    /// 生成流水线本身的多次写入会产生秒级时间差）。
    pub edit_grace_ms: i64,
    /// 金标正例的最少复习次数。
    pub min_review_count: u32,
    /// 金标正例允许的最大 again 率（again_count / review_count）。
    pub max_lapse_rate: f64,
    /// 编辑距离比低于该值判为小幅编辑（EditedMinor）。
    pub minor_edit_max_ratio: f64,
    /// 创建后多久内删除才算"早删"负例（默认 24h）。
    pub early_delete_window_ms: i64,
}

impl Default for GoldMiningConfig {
    fn default() -> Self {
        Self {
            edit_grace_ms: 5 * 60 * 1000,
            min_review_count: 3,
            max_lapse_rate: 0.4,
            minor_edit_max_ratio: 0.25,
            early_delete_window_ms: 24 * 60 * 60 * 1000,
        }
    }
}

// ============================================================================
// 编辑前原文提取
// ============================================================================

/// 首次写入 `_original_generation` 时可能发生的非致命错误。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OriginalGenerationSnapshotError {
    Serialization(String),
    TooLarge {
        actual_bytes: usize,
        max_bytes: usize,
    },
}

impl std::fmt::Display for OriginalGenerationSnapshotError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Serialization(message) => write!(f, "快照序列化失败: {message}"),
            Self::TooLarge {
                actual_bytes,
                max_bytes,
            } => write!(f, "快照大小 {actual_bytes} 字节超过上限 {max_bytes} 字节"),
        }
    }
}

impl std::error::Error for OriginalGenerationSnapshotError {}

/// 把生成完成、清理后的卡片正文写入 `extra_fields`，供后续用户编辑后挖掘修正对。
///
/// 返回 `Ok(true)` 表示本次写入；键已存在时返回 `Ok(false)`，并逐字节保留既有值。
/// 该幂等语义是硬约束：无论既有值是否合法，都不能覆盖用户或历史版本写下的
/// `_original_generation`。序列化或体积校验失败只返回错误，由入库调用方降级跳过。
pub fn insert_original_generation_once(
    extras: &mut HashMap<String, String>,
    front: &str,
    back: &str,
    text: Option<&str>,
) -> Result<bool, OriginalGenerationSnapshotError> {
    if extras.contains_key(ORIGINAL_GENERATION_FIELD) {
        return Ok(false);
    }

    let snapshot = CardSnapshot {
        front: front.to_string(),
        back: back.to_string(),
        text: text.map(str::to_string),
    };
    let serialized = serde_json::to_string(&snapshot)
        .map_err(|error| OriginalGenerationSnapshotError::Serialization(error.to_string()))?;
    if serialized.len() > ORIGINAL_GENERATION_MAX_BYTES {
        return Err(OriginalGenerationSnapshotError::TooLarge {
            actual_bytes: serialized.len(),
            max_bytes: ORIGINAL_GENERATION_MAX_BYTES,
        });
    }

    extras.insert(ORIGINAL_GENERATION_FIELD.to_string(), serialized);
    Ok(true)
}

/// 从 `extra_fields_json`（`anki_cards.extra_fields_json` 原文）中解出
/// `_original_generation` 快照。键缺失 / JSON 非法 / 形状不符均返回 None。
///
/// 兼容两种存储形态：值直接是对象，或值是二次编码的 JSON 字符串
/// （extra_fields 以 `HashMap<String, String>` 落库时的必然形态）。
pub fn extract_original_generation(extra_fields_json: &str) -> Option<CardSnapshot> {
    let root: Value = serde_json::from_str(extra_fields_json).ok()?;
    let raw = root.get(ORIGINAL_GENERATION_FIELD)?;
    let obj = match raw {
        Value::Object(_) => raw.clone(),
        Value::String(s) => serde_json::from_str::<Value>(s).ok()?,
        _ => return None,
    };
    if !obj.is_object() {
        return None;
    }
    serde_json::from_value::<CardSnapshot>(obj).ok()
}

/// [`extract_original_generation`] 的内存态变体：直接查已反序列化的
/// `extra_fields: HashMap<String, String>`（`AnkiCard` 在进程内的形态）。
/// 值必然是二次编码的 JSON 字符串。查询 helper，不改挖掘语义。
pub fn extract_original_from_extras(extras: &HashMap<String, String>) -> Option<CardSnapshot> {
    let raw = extras.get(ORIGINAL_GENERATION_FIELD)?;
    let obj: Value = serde_json::from_str(raw).ok()?;
    if !obj.is_object() {
        return None;
    }
    serde_json::from_value::<CardSnapshot>(obj).ok()
}

/// 判断内存态卡片是否带 critic 自动修订来源标记。
///
/// `_qa_flags` 非法或不是数组时保守地视为未命中；只有结构化稳定 code
/// `llm_critic_revised` 能触发排除。
pub fn has_critic_revision_marker(extras: &HashMap<String, String>) -> bool {
    let Some(raw) = extras.get(QA_FLAGS_FIELD) else {
        return false;
    };
    let Ok(Value::Array(flags)) = serde_json::from_str::<Value>(raw) else {
        return false;
    };
    flags
        .iter()
        .any(|flag| flag.get("code").and_then(Value::as_str) == Some(CRITIC_REVISED_QA_CODE))
}

// ============================================================================
// 内容溯源（_content_provenance，Wave2-E R2）
// ============================================================================

/// `_content_provenance` 的结构化值：最后一次内容写入的编辑者证明。
///
/// wire 形态（camelCase，未知字段忽略——旧/新版本互读不炸）：
/// `{"actor":"user"|"llm_critic"|"import"|"sync","code":"...","at":"<rfc3339>"}`。
///
/// `actor` 用 String 而非 enum：未来新增写入方（未知 actor）在旧版本上
/// 必须仍可解析，且**保守地不算用户证明**（fail-closed）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentProvenance {
    /// 写入者（见 `PROVENANCE_ACTOR_*` 常量）。
    pub actor: String,
    /// 写入路径 / 来源码（审计用，如 `llm_critic_revised`）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
    /// 写入时刻（RFC3339）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

impl ContentProvenance {
    /// 用户编辑戳。`code` 标记写入路径（空串省略）。
    pub fn user(code: &str) -> Self {
        Self {
            actor: PROVENANCE_ACTOR_USER.to_string(),
            code: Some(code.to_string()).filter(|c| !c.is_empty()),
            at: Some(chrono::Utc::now().to_rfc3339()),
        }
    }

    /// critic 自动修订戳（actor=llm_critic, code=llm_critic_revised）。
    pub fn llm_critic_revision() -> Self {
        Self {
            actor: PROVENANCE_ACTOR_LLM_CRITIC.to_string(),
            code: Some(CRITIC_REVISED_QA_CODE.to_string()),
            at: Some(chrono::Utc::now().to_rfc3339()),
        }
    }
}

/// 写入（覆盖）`_content_provenance`。
///
/// 与 [`insert_original_generation_once`] 的首写幂等语义相反，provenance 记录
/// 的是**最后一次**内容写入者，last-writer-wins 是刻意的：critic 修订后用户
/// 再编辑，戳应变回 user（该卡因 `_qa_flags` marker 或 diff 混入 critic 手笔
/// 仍会被挖掘侧保守排除，见 `gold_references_from_cards`）。
pub fn insert_content_provenance(
    extras: &mut HashMap<String, String>,
    provenance: &ContentProvenance,
) {
    let serialized =
        serde_json::to_string(provenance).expect("纯字符串字段的 provenance 序列化不会失败");
    extras.insert(CONTENT_PROVENANCE_FIELD.to_string(), serialized);
}

/// 从内存态 `extra_fields` 解出 `_content_provenance`。
/// 键缺失 / JSON 非法 / 形状不符均返回 None（视为无证明，保守方向）。
pub fn parse_content_provenance(extras: &HashMap<String, String>) -> Option<ContentProvenance> {
    let raw = extras.get(CONTENT_PROVENANCE_FIELD)?;
    let value: Value = serde_json::from_str(raw).ok()?;
    if !value.is_object() {
        return None;
    }
    serde_json::from_value::<ContentProvenance>(value).ok()
}

/// 卡片是否带**可证明的用户编辑**戳（actor=user）。
/// 无 provenance / 解析失败 / 其它 actor 一律 false（无证明不进 gold 修正对）。
pub fn is_user_proven_edit(extras: &HashMap<String, String>) -> bool {
    parse_content_provenance(extras)
        .map(|p| p.actor == PROVENANCE_ACTOR_USER)
        .unwrap_or(false)
}

/// 卡片最后一次写入是否为 LLM critic（actor=llm_critic）。
///
/// 这是 [`has_critic_revision_marker`] 之外的**第二道**排除闸：marker 住在
/// `_qa_flags`（enable_qa_pass=false 时被剥、前端重建可冲掉），provenance
/// 独立存活，两者任一命中都必须把卡排除在用户金标之外。
pub fn is_llm_critic_actor(extras: &HashMap<String, String>) -> bool {
    parse_content_provenance(extras)
        .map(|p| p.actor == PROVENANCE_ACTOR_LLM_CRITIC)
        .unwrap_or(false)
}

// ============================================================================
// 编辑距离
// ============================================================================

/// 字符级 Levenshtein 距离（两行滚动数组，O(min(m,n)) 空间）。
/// 按 Unicode 标量值计，中文一字一距离。
pub fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    // 让 b 是较短的一侧，压缩滚动数组宽度
    let (long, short) = if a.len() >= b.len() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    let mut prev: Vec<usize> = (0..=short.len()).collect();
    let mut cur = vec![0usize; short.len() + 1];
    for (i, lc) in long.iter().enumerate() {
        cur[0] = i + 1;
        for (j, sc) in short.iter().enumerate() {
            let cost = if lc == sc { 0 } else { 1 };
            cur[j + 1] = (prev[j] + cost).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[short.len()]
}

/// 编辑距离比：`edit_distance(original, edited) / len(original)`。
/// 原文为空时返回 1.0（凭空长出内容视为大改）。
pub fn edit_ratio(original: &CardSnapshot, edited: &CardSnapshot) -> f64 {
    // `combined()` always contains the front/back separator, so testing its
    // length cannot detect an otherwise empty snapshot.
    if original.is_blank() {
        return if edited.is_blank() { 0.0 } else { 1.0 };
    }

    let orig = original.combined();
    let edit = edited.combined();
    let orig_len = orig.chars().count();
    edit_distance(&orig, &edit) as f64 / orig_len as f64
}

// ============================================================================
// 标注（plan §3 label 步骤）
// ============================================================================

/// 对单个候选做确定性标注。决策树：
///
/// 1. critic 自动修订（`_qa_flags` marker 派生的 `critic_revised`，**或**
///    `_content_provenance` actor=llm_critic）→ `Unlabeled`
///    （模型自改不能充当用户金标；provenance 是 marker 之外的第二道闸，
///    不依赖 `_qa_flags` 存活）；
/// 2. 已删除 → 早删且零复习 = `DeletedEarly`，否则 `Unlabeled`（删除动机不明）；
/// 3. 当前仍是错误卡 → `Unlabeled`（没有可用的"修复后"内容）；
/// 4. 曾是错误卡且已修好 → `ErrorCardRepaired`（需 original 才能构成修正对）；
/// 5. 有 original 且内容有变 → 先过**编辑者闸门**：只有
///    `edit_actor == Some("user")`（可证明的用户编辑）才按编辑距离比分
///    `EditedMinor` / `EditedMajor`；无 actor（旧卡）或非用户 actor →
///    `Unlabeled`（无证明不进 gold 修正对，宁可漏挖不可污染）；
/// 6. 内容未变（或无 original 且时间戳未超宽限）→ 复习信号达标 = `KeptUnedited`；
/// 7. 其余 → `Unlabeled`，reason 说明缺哪路信号。
pub fn classify_candidate(c: &GoldCandidate, cfg: &GoldMiningConfig) -> GoldSample {
    let sample = |label, reason: String, pair| GoldSample {
        card_id: c.card_id.clone(),
        label,
        reason,
        repair_pair: pair,
    };

    // 1. 来源通道：critic 自改不能伪装成用户编辑或用户认可的未编辑正例。
    //    marker（_qa_flags 派生）与 provenance actor 任一命中即排除——marker
    //    在 enable_qa_pass=false 下会被剥离，provenance 是独立存活的第二道闸。
    if c.critic_revised || c.edit_actor.as_deref() == Some(PROVENANCE_ACTOR_LLM_CRITIC) {
        return sample(
            GoldLabel::Unlabeled,
            "带 llm_critic_revised 来源标记，模型自动修订不得进入用户金标".to_string(),
            None,
        );
    }

    // 2. 删除通道
    if let Some(deleted_at) = c.deleted_at_ms {
        let age = deleted_at - c.created_at_ms;
        if c.review_count == 0 && age <= cfg.early_delete_window_ms {
            return sample(
                GoldLabel::DeletedEarly,
                format!("创建后 {} 分钟内删除且从未复习", age / 60_000),
                None,
            );
        }
        return sample(
            GoldLabel::Unlabeled,
            "已删除但曾被复习或超出早删窗口，删除动机不明（可能是内容重复）".to_string(),
            None,
        );
    }

    // 3. 当前仍是错误卡
    if c.is_error_card {
        return sample(
            GoldLabel::Unlabeled,
            "当前仍是错误卡，无可用的修复后内容".to_string(),
            None,
        );
    }

    // 4. 错误卡修复通道
    if c.was_error_card {
        if c.current.is_blank() {
            return sample(
                GoldLabel::Unlabeled,
                "错误卡标记已清除但内容为空，疑似清空而非修复".to_string(),
                None,
            );
        }
        return match &c.original {
            Some(orig) => {
                let ratio = edit_ratio(orig, &c.current);
                sample(
                    GoldLabel::ErrorCardRepaired,
                    "解析失败样本被用户手工修好（原始坏输出 + 人工正确答案）".to_string(),
                    Some(RepairPair {
                        original: orig.clone(),
                        edited: c.current.clone(),
                        distance_ratio: ratio,
                    }),
                )
            }
            None => sample(
                GoldLabel::Unlabeled,
                "错误卡已修复但缺 _original_generation 原文，无法构成修正对".to_string(),
                None,
            ),
        };
    }

    // 5. 编辑通道（original 在场时以内容 diff 为准，时间戳仅作后备信号）
    if let Some(orig) = &c.original {
        if *orig != c.current {
            // 编辑者闸门：内容相对生成快照有变，但"是谁改的"必须有正向证明。
            // 旧卡（无 provenance）与非用户写入（import/sync/未知 actor）一律
            // 保守 Unlabeled——无证明不进 gold 修正对。
            if c.edit_actor.as_deref() != Some(PROVENANCE_ACTOR_USER) {
                return sample(
                    GoldLabel::Unlabeled,
                    "内容相对生成快照有变但缺编辑者证明（_content_provenance 非 actor=user），保守不进金标修正对"
                        .to_string(),
                    None,
                );
            }
            let ratio = edit_ratio(orig, &c.current);
            let pair = RepairPair {
                original: orig.clone(),
                edited: c.current.clone(),
                distance_ratio: ratio,
            };
            return if ratio < cfg.minor_edit_max_ratio {
                sample(
                    GoldLabel::EditedMinor,
                    format!(
                        "小幅编辑（距离比 {:.3} < {:.2}）",
                        ratio, cfg.minor_edit_max_ratio
                    ),
                    Some(pair),
                )
            } else {
                sample(
                    GoldLabel::EditedMajor,
                    format!(
                        "大幅重写（距离比 {:.3} ≥ {:.2}）",
                        ratio, cfg.minor_edit_max_ratio
                    ),
                    Some(pair),
                )
            };
        }
    } else if c.updated_at_ms - c.created_at_ms >= cfg.edit_grace_ms {
        return sample(
            GoldLabel::Unlabeled,
            "时间戳显示有编辑但缺 _original_generation 原文，无法构建修正对".to_string(),
            None,
        );
    }

    // 6. 未编辑：留存信号定夺
    let lapse_rate = if c.review_count == 0 {
        0.0
    } else {
        c.again_count as f64 / c.review_count as f64
    };
    if c.review_count >= cfg.min_review_count && lapse_rate < cfg.max_lapse_rate {
        return sample(
            GoldLabel::KeptUnedited,
            format!(
                "未编辑且留存达标（复习 {} 次，again 率 {:.0}%）",
                c.review_count,
                lapse_rate * 100.0
            ),
            None,
        );
    }
    sample(
        GoldLabel::Unlabeled,
        format!(
            "未编辑但留存信号不足（复习 {} 次 < {}，或 again 率 {:.0}% ≥ {:.0}%）",
            c.review_count,
            cfg.min_review_count,
            lapse_rate * 100.0,
            cfg.max_lapse_rate * 100.0
        ),
        None,
    )
}

/// 批量挖掘：逐候选标注，返回全部样本（含 Unlabeled，供审计）。
pub fn mine_gold_set(candidates: &[GoldCandidate], cfg: &GoldMiningConfig) -> Vec<GoldSample> {
    candidates
        .iter()
        .map(|c| classify_candidate(c, cfg))
        .collect()
}

/// 各标签计数（挖掘报告 / 分层抽样前的分布检查）。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct GoldSetStats {
    pub kept_unedited: usize,
    pub edited_minor: usize,
    pub edited_major: usize,
    pub deleted_early: usize,
    pub error_card_repaired: usize,
    pub unlabeled: usize,
}

pub fn gold_set_stats(samples: &[GoldSample]) -> GoldSetStats {
    let mut s = GoldSetStats::default();
    for sample in samples {
        match sample.label {
            GoldLabel::KeptUnedited => s.kept_unedited += 1,
            GoldLabel::EditedMinor => s.edited_minor += 1,
            GoldLabel::EditedMajor => s.edited_major += 1,
            GoldLabel::DeletedEarly => s.deleted_early += 1,
            GoldLabel::ErrorCardRepaired => s.error_card_repaired += 1,
            GoldLabel::Unlabeled => s.unlabeled += 1,
        }
    }
    s
}

/// plan §3 export 步骤的目录路由：标签 → fixture 子目录（Unlabeled 不导出）。
pub fn fixture_export_bucket(label: GoldLabel) -> Option<&'static str> {
    match label {
        GoldLabel::KeptUnedited => Some("gold/positive"),
        GoldLabel::EditedMinor | GoldLabel::EditedMajor | GoldLabel::ErrorCardRepaired => {
            Some("gold/repair-pairs")
        }
        GoldLabel::DeletedEarly => Some("gold/negative"),
        GoldLabel::Unlabeled => None,
    }
}

// ============================================================================
// lint 契约校验（plan §5.2：original 应命中、edited 应零命中）
// ============================================================================

/// 修正对的 lint 契约校验结果。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepairPairLintReport {
    /// original 命中的 lint 码（去重排序，仅 Warn 及以上）。
    pub original_codes: Vec<String>,
    /// edited 命中的 lint 码（同上）。
    pub edited_codes: Vec<String>,
    /// original 至少命中一条 Warn+ 规则（= 劣化被 lint 捕获）。
    pub original_flagged: bool,
    /// edited 零 Warn+ 命中（= 修复后是金标）。
    pub edited_clean: bool,
    /// 两端都干净：用户明明改了但 lint 两侧都不报 → lint 盲区，
    /// 是新规则的第一素材来源（plan §5.2）。
    pub lint_blind_spot: bool,
}

/// 金标校验用 lint 配置：关闭 Info 级噪声规则（tags_empty / mixed_language）——
/// 快照不携带 tags 且语言混杂永不定劣化，避免把每个 edited 都误判为不干净。
pub fn gold_lint_config() -> LintConfig {
    LintConfig {
        check_tags_empty: false,
        check_mixed_language: false,
        ..LintConfig::default()
    }
}

fn lint_snapshot_codes(snapshot: &CardSnapshot, cfg: &LintConfig) -> Vec<String> {
    let extras: HashMap<String, String> = HashMap::new();
    let tags: Vec<String> = Vec::new();
    let input = CardLintInput {
        front: &snapshot.front,
        back: &snapshot.back,
        text: snapshot.text.as_deref(),
        tags: &tags,
        extra_fields: &extras,
    };
    let mut codes: Vec<String> = lint_card(&input, cfg)
        .into_iter()
        .filter(|i| i.severity >= LintSeverity::Warn)
        .map(|i| i.code)
        .collect();
    codes.sort();
    codes.dedup();
    codes
}

/// 用生产 lint 引擎（`anki_qa_lint::lint_card`）校验一个修正对是否满足
/// 「改前 = 劣化（lint 命中）、改后 = 金标（lint 零命中）」契约。
pub fn lint_repair_pair(pair: &RepairPair, cfg: &LintConfig) -> RepairPairLintReport {
    let original_codes = lint_snapshot_codes(&pair.original, cfg);
    let edited_codes = lint_snapshot_codes(&pair.edited, cfg);
    let original_flagged = !original_codes.is_empty();
    let edited_clean = edited_codes.is_empty();
    RepairPairLintReport {
        lint_blind_spot: !original_flagged && edited_clean && pair.original != pair.edited,
        original_codes,
        edited_codes,
        original_flagged,
        edited_clean,
    }
}

// ============================================================================
// Grounded critic 参照对选取（Round 5 #4：金标集 → critic 的查询层）
// ============================================================================

/// 从挖掘结果中选出可注入 `anki_critic` grounded prompt 的同源修正对。
/// 纯查询/过滤 helper，不改任何挖掘语义：
///
/// - 只取携带 [`RepairPair`] 的标签（`EditedMinor` / `EditedMajor` /
///   `ErrorCardRepaired`）；
/// - **金标端必须干净**：`edited` 经生产 lint（Warn+）零命中且非空——
///   脏金标喂给 critic 会教坏裁决基准；
/// - 刻意**不要求** `original` 被 lint 命中：lint 盲区对（规则抓不到、
///   用户却动手改了的语义劣化）恰是 LLM critic 相对规则 rubric 的增量价值；
/// - 按 `edited.front` 去重（同一金标问题不重复注入）；
/// - 保持输入顺序（确定性），最多返回 `max` 对。
pub fn select_grounded_reference_pairs<'a>(
    samples: &'a [GoldSample],
    lint_cfg: &LintConfig,
    max: usize,
) -> Vec<&'a RepairPair> {
    let mut out: Vec<&'a RepairPair> = Vec::new();
    let mut seen_fronts: std::collections::HashSet<String> = std::collections::HashSet::new();
    for sample in samples {
        if out.len() >= max {
            break;
        }
        if !matches!(
            sample.label,
            GoldLabel::EditedMinor | GoldLabel::EditedMajor | GoldLabel::ErrorCardRepaired
        ) {
            continue;
        }
        let Some(pair) = &sample.repair_pair else {
            continue;
        };
        if pair.edited.is_blank() {
            continue;
        }
        if !lint_repair_pair(pair, lint_cfg).edited_clean {
            continue;
        }
        if !seen_fronts.insert(pair.edited.front.trim().to_string()) {
            continue;
        }
        out.push(pair);
    }
    out
}

// ============================================================================
// 脱敏与导出整形（plan §4）
// ============================================================================

/// 剥离邮箱 / 中国大陆手机号 / 18 位身份证号样式片段，返回（脱敏文本, 替换次数）。
/// 仅做样式级替换，主题白名单与人审仍是入仓 fixture 的硬前置（plan §4）。
pub fn scrub_pii(text: &str) -> (String, usize) {
    let patterns: [(&str, &str); 3] = [
        (
            r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}",
            "[已脱敏邮箱]",
        ),
        (
            r"(?:^|[^0-9])((?:\+?86[- ]?)?1[3-9]\d{9})(?:[^0-9]|$)",
            "[已脱敏手机号]",
        ),
        (r"\d{17}[0-9Xx]", "[已脱敏证件号]"),
    ];
    let mut out = text.to_string();
    let mut count = 0usize;
    for (pat, replacement) in patterns {
        let re = regex::Regex::new(pat).expect("static regex must compile");
        // 手机号模式带边界捕获组：只替换组 1，保留边界字符
        if pat.contains("(?:^|[^0-9])") {
            loop {
                let Some(caps) = re.captures(&out) else { break };
                let m = caps.get(1).expect("group 1 exists");
                out.replace_range(m.range(), replacement);
                count += 1;
            }
        } else {
            let replaced = re.replace_all(&out, replacement);
            count += re.find_iter(&out).count();
            out = replaced.into_owned();
        }
    }
    (out, count)
}

fn scrub_snapshot(snapshot: &CardSnapshot) -> (CardSnapshot, usize) {
    let (front, c1) = scrub_pii(&snapshot.front);
    let (back, c2) = scrub_pii(&snapshot.back);
    let (text, c3) = match &snapshot.text {
        Some(t) => {
            let (s, c) = scrub_pii(t);
            (Some(s), c)
        }
        None => (None, 0),
    };
    (CardSnapshot { front, back, text }, c1 + c2 + c3)
}

/// 样本 → 仓库 fixture JSON（`tests/fixtures/anki-eval/gold/**/*.json` 的形状）。
/// 默认执行 PII 脱敏；Unlabeled 样本不可导出，返回 None。
pub fn to_fixture_json(sample: &GoldSample) -> Option<Value> {
    fixture_export_bucket(sample.label)?;
    let label = serde_json::to_value(sample.label).expect("label serializes");
    let mut obj = json!({
        "id": sample.card_id,
        "label": label,
        "reason": sample.reason,
    });
    match &sample.repair_pair {
        Some(pair) => {
            let (orig, _) = scrub_snapshot(&pair.original);
            let (edit, _) = scrub_snapshot(&pair.edited);
            obj["original"] = serde_json::to_value(orig).expect("snapshot serializes");
            obj["edited"] = serde_json::to_value(edit).expect("snapshot serializes");
            obj["distanceRatio"] = json!((pair.distance_ratio * 1000.0).round() / 1000.0);
        }
        None => {
            // 正例/负例导出当前内容单卡
        }
    }
    Some(obj)
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(front: &str, back: &str) -> CardSnapshot {
        CardSnapshot {
            front: front.to_string(),
            back: back.to_string(),
            text: None,
        }
    }

    fn base_candidate(id: &str) -> GoldCandidate {
        GoldCandidate {
            card_id: id.to_string(),
            current: snap("什么是惯性？", "物体保持原有运动状态不变的性质"),
            original: None,
            created_at_ms: 1_000_000,
            updated_at_ms: 1_000_000,
            deleted_at_ms: None,
            review_count: 0,
            again_count: 0,
            was_error_card: false,
            is_error_card: false,
            critic_revised: false,
            edit_actor: None,
        }
    }

    // -------- extract_original_generation --------

    #[test]
    fn insert_original_generation_captures_front_back_and_text() {
        let mut extras = HashMap::new();
        let inserted = insert_original_generation_once(
            &mut extras,
            "什么是惯性？",
            "保持原有运动状态的性质",
            Some("物体具有 {{c1::惯性}}"),
        )
        .expect("snapshot");

        assert!(inserted);
        let snapshot = extract_original_from_extras(&extras).expect("round trip");
        assert_eq!(snapshot.front, "什么是惯性？");
        assert_eq!(snapshot.back, "保持原有运动状态的性质");
        assert_eq!(snapshot.text.as_deref(), Some("物体具有 {{c1::惯性}}"));
    }

    #[test]
    fn insert_original_generation_omits_absent_text() {
        let mut extras = HashMap::new();
        insert_original_generation_once(&mut extras, "Q", "A", None).expect("snapshot");

        let raw = extras.get(ORIGINAL_GENERATION_FIELD).expect("stored");
        let value: Value = serde_json::from_str(raw).expect("json object");
        assert_eq!(value, json!({"front": "Q", "back": "A"}));
        assert!(value.get("text").is_none());
    }

    #[test]
    fn insert_original_generation_preserves_explicit_empty_text() {
        let mut extras = HashMap::new();
        insert_original_generation_once(&mut extras, "Q", "A", Some("")).expect("snapshot");

        let snapshot = extract_original_from_extras(&extras).expect("round trip");
        assert_eq!(snapshot.text.as_deref(), Some(""));
    }

    #[test]
    fn insert_original_generation_is_first_write_only() {
        let mut extras = HashMap::new();
        assert!(
            insert_original_generation_once(&mut extras, "original Q", "original A", None)
                .expect("first write")
        );
        let original_raw = extras[ORIGINAL_GENERATION_FIELD].clone();

        let inserted =
            insert_original_generation_once(&mut extras, "edited Q", "edited A", Some("edited"))
                .expect("existing value is a no-op");
        assert!(!inserted);
        assert_eq!(extras[ORIGINAL_GENERATION_FIELD], original_raw);
    }

    #[test]
    fn insert_original_generation_never_replaces_malformed_existing_value() {
        let mut extras = HashMap::from([(
            ORIGINAL_GENERATION_FIELD.to_string(),
            "user-controlled-non-json".to_string(),
        )]);

        let inserted = insert_original_generation_once(
            &mut extras,
            &"x".repeat(ORIGINAL_GENERATION_MAX_BYTES * 2),
            "A",
            None,
        )
        .expect("existing key is checked before size");
        assert!(!inserted);
        assert_eq!(
            extras[ORIGINAL_GENERATION_FIELD],
            "user-controlled-non-json"
        );
    }

    #[test]
    fn insert_original_generation_accepts_exact_byte_limit() {
        let overhead = serde_json::to_string(&CardSnapshot::default())
            .expect("snapshot")
            .len();
        assert!(overhead < ORIGINAL_GENERATION_MAX_BYTES);
        let front = "x".repeat(ORIGINAL_GENERATION_MAX_BYTES - overhead);
        let mut extras = HashMap::new();

        insert_original_generation_once(&mut extras, &front, "", None).expect("exact limit");
        assert_eq!(
            extras[ORIGINAL_GENERATION_FIELD].len(),
            ORIGINAL_GENERATION_MAX_BYTES
        );
    }

    #[test]
    fn insert_original_generation_rejects_over_limit_without_mutation() {
        let overhead = serde_json::to_string(&CardSnapshot::default())
            .expect("snapshot")
            .len();
        let front = "x".repeat(ORIGINAL_GENERATION_MAX_BYTES - overhead + 1);
        let mut extras = HashMap::from([("keep".to_string(), "value".to_string())]);
        let before = extras.clone();

        let error = insert_original_generation_once(&mut extras, &front, "", None)
            .expect_err("one byte over must fail");
        assert_eq!(
            error,
            OriginalGenerationSnapshotError::TooLarge {
                actual_bytes: ORIGINAL_GENERATION_MAX_BYTES + 1,
                max_bytes: ORIGINAL_GENERATION_MAX_BYTES,
            }
        );
        assert_eq!(extras, before);
    }

    #[test]
    fn insert_original_generation_limit_counts_utf8_bytes() {
        let overhead = serde_json::to_string(&CardSnapshot::default())
            .expect("snapshot")
            .len();
        let front = "界".repeat((ORIGINAL_GENERATION_MAX_BYTES - overhead) / 3 + 1);
        assert!(front.chars().count() < ORIGINAL_GENERATION_MAX_BYTES);
        let mut extras = HashMap::new();

        let error = insert_original_generation_once(&mut extras, &front, "", None)
            .expect_err("multibyte payload must use byte limit");
        assert!(matches!(
            error,
            OriginalGenerationSnapshotError::TooLarge { .. }
        ));
        assert!(!extras.contains_key(ORIGINAL_GENERATION_FIELD));
    }

    #[test]
    fn extracts_original_generation_object_form() {
        let raw = r#"{"note":"x","_original_generation":{"front":"Q","back":"A"}}"#;
        let snap = extract_original_generation(raw).expect("must parse");
        assert_eq!(snap.front, "Q");
        assert_eq!(snap.back, "A");
        assert_eq!(snap.text, None);
    }

    #[test]
    fn extracts_original_generation_double_encoded_string_form() {
        // extra_fields 以 HashMap<String,String> 落库时值是二次编码的 JSON 字符串
        let raw = r#"{"_original_generation":"{\"front\":\"Q\",\"back\":\"A\",\"text\":\"T {{c1::x}}\"}"}"#;
        let snap = extract_original_generation(raw).expect("must parse");
        assert_eq!(snap.front, "Q");
        assert_eq!(snap.text.as_deref(), Some("T {{c1::x}}"));
    }

    #[test]
    fn extract_returns_none_for_missing_or_invalid() {
        assert!(extract_original_generation(r#"{"other":1}"#).is_none());
        assert!(extract_original_generation("not-json").is_none());
        assert!(extract_original_generation(r#"{"_original_generation":42}"#).is_none());
        assert!(extract_original_generation(r#"{"_original_generation":"not-json"}"#).is_none());
    }

    #[test]
    fn critic_revision_marker_requires_structured_stable_code() {
        let marked = HashMap::from([(
            QA_FLAGS_FIELD.to_string(),
            json!([
                {"code": "answer_leak", "field": "front"},
                {"code": CRITIC_REVISED_QA_CODE, "field": "card"}
            ])
            .to_string(),
        )]);
        assert!(has_critic_revision_marker(&marked));

        let unrelated = HashMap::from([(
            QA_FLAGS_FIELD.to_string(),
            json!([{"message": CRITIC_REVISED_QA_CODE}]).to_string(),
        )]);
        assert!(!has_critic_revision_marker(&unrelated));
        assert!(!has_critic_revision_marker(&HashMap::from([(
            QA_FLAGS_FIELD.to_string(),
            "not-json".to_string(),
        )])));
    }

    // -------- edit_distance / edit_ratio --------

    #[test]
    fn edit_distance_counts_unicode_chars() {
        assert_eq!(edit_distance("", ""), 0);
        assert_eq!(edit_distance("abc", "abc"), 0);
        assert_eq!(edit_distance("kitten", "sitting"), 3);
        // 中文一字一距离，不按字节
        assert_eq!(edit_distance("牛顿第一定律", "牛顿第二定律"), 1);
        assert_eq!(edit_distance("惯性", ""), 2);
    }

    #[test]
    fn edit_ratio_boundaries() {
        let orig = snap("0123456789", ""); // combined = "0123456789\n"（11 字符）
        let same = orig.clone();
        assert_eq!(edit_ratio(&orig, &same), 0.0);

        // 空原文长出内容 = 1.0
        let empty = CardSnapshot::default();
        assert_eq!(edit_ratio(&empty, &snap("x", "y")), 1.0);
        assert_eq!(edit_ratio(&empty, &empty), 0.0);

        // 改 2/11 个字符 ≈ 0.18
        let minor = snap("01234567AB", "");
        let r = edit_ratio(&orig, &minor);
        assert!(r > 0.17 && r < 0.19, "ratio={}", r);
    }

    // -------- classify：kept_unedited 正例 --------

    #[test]
    fn kept_unedited_requires_retention_signals() {
        let mut c = base_candidate("c1");
        c.review_count = 5;
        c.again_count = 1; // 20% < 40%
        let s = classify_candidate(&c, &GoldMiningConfig::default());
        assert_eq!(s.label, GoldLabel::KeptUnedited);
        assert!(s.repair_pair.is_none());
    }

    #[test]
    fn unedited_with_weak_retention_is_unlabeled() {
        let cfg = GoldMiningConfig::default();
        // 复习次数不足
        let mut c = base_candidate("c2");
        c.review_count = 2;
        assert_eq!(classify_candidate(&c, &cfg).label, GoldLabel::Unlabeled);
        // again 率过高
        let mut c = base_candidate("c3");
        c.review_count = 10;
        c.again_count = 5; // 50% ≥ 40%
        assert_eq!(classify_candidate(&c, &cfg).label, GoldLabel::Unlabeled);
    }

    #[test]
    fn original_equal_to_current_goes_through_unedited_path_despite_timestamps() {
        // 重新保存（updated_at 变大）但内容未变：original 在场时以内容 diff 为准
        let mut c = base_candidate("c4");
        c.original = Some(c.current.clone());
        c.updated_at_ms = c.created_at_ms + 3 * 60 * 60 * 1000;
        c.review_count = 4;
        let s = classify_candidate(&c, &GoldMiningConfig::default());
        assert_eq!(s.label, GoldLabel::KeptUnedited);
    }

    // -------- classify：修正对 --------

    #[test]
    fn minor_edit_yields_repair_pair_with_ratio() {
        let mut c = base_candidate("c5");
        c.original = Some(snap("什么是惯性？？", "物体保持原有运动状态不变的性质"));
        c.updated_at_ms = c.created_at_ms + 10 * 60 * 1000;
        c.edit_actor = Some(PROVENANCE_ACTOR_USER.to_string());
        let s = classify_candidate(&c, &GoldMiningConfig::default());
        assert_eq!(s.label, GoldLabel::EditedMinor);
        let pair = s.repair_pair.expect("must carry pair");
        assert!(pair.distance_ratio > 0.0 && pair.distance_ratio < 0.25);
        assert_eq!(pair.edited, c.current);
    }

    #[test]
    fn major_rewrite_yields_edited_major() {
        let mut c = base_candidate("c6");
        c.original = Some(snap(
            "好的，以下是卡片：惯性是什么以及加速度是什么？",
            "TODO",
        ));
        c.edit_actor = Some(PROVENANCE_ACTOR_USER.to_string());
        let s = classify_candidate(&c, &GoldMiningConfig::default());
        assert_eq!(s.label, GoldLabel::EditedMajor);
        assert!(s.repair_pair.expect("pair").distance_ratio >= 0.25);
    }

    #[test]
    fn critic_revised_content_is_never_mined_as_user_gold() {
        let mut c = base_candidate("critic-revised");
        c.original = Some(snap("模型原问题（答案泄露）", "模型原答案"));
        c.critic_revised = true;
        c.review_count = 10;

        let sample = classify_candidate(&c, &GoldMiningConfig::default());
        assert_eq!(sample.label, GoldLabel::Unlabeled);
        assert!(sample.repair_pair.is_none());
        assert!(sample.reason.contains(CRITIC_REVISED_QA_CODE));
    }

    #[test]
    fn llm_critic_actor_is_excluded_even_without_qa_flags_marker() {
        // 路径 A 复现（enable_qa_pass=false 剥掉 marker 后的落库形态）：
        // marker 丢失（critic_revised=false）但 provenance actor=llm_critic 仍在
        // → 第二道闸必须排除，即便内容相对快照有变、用户 actor 缺席。
        let mut c = base_candidate("critic-provenance");
        c.original = Some(snap("模型原问题（答案泄露）", "模型原答案"));
        c.critic_revised = false;
        c.edit_actor = Some(PROVENANCE_ACTOR_LLM_CRITIC.to_string());
        c.review_count = 10;

        let sample = classify_candidate(&c, &GoldMiningConfig::default());
        assert_eq!(sample.label, GoldLabel::Unlabeled);
        assert!(sample.repair_pair.is_none());
        assert!(sample.reason.contains(CRITIC_REVISED_QA_CODE));
    }

    #[test]
    fn edited_content_without_actor_proof_is_unlabeled() {
        // 旧卡：内容 ≠ 快照但无任何 provenance → 保守不进修正对（含路径 A
        // 已污染卡与真实历史用户编辑，两者不可区分，一律不挖）。
        let mut c = base_candidate("legacy-edited");
        c.original = Some(snap("什么是惯性？？", "物体保持原有运动状态不变的性质"));
        c.edit_actor = None;
        let s = classify_candidate(&c, &GoldMiningConfig::default());
        assert_eq!(s.label, GoldLabel::Unlabeled);
        assert!(s.repair_pair.is_none());
        assert!(s.reason.contains("缺编辑者证明"), "reason={}", s.reason);
    }

    #[test]
    fn non_user_actors_never_enter_edited_buckets() {
        // import / sync / 未知 actor：有 provenance 但不是用户证明 → Unlabeled
        for actor in [
            PROVENANCE_ACTOR_IMPORT,
            PROVENANCE_ACTOR_SYNC,
            "future_agent",
        ] {
            let mut c = base_candidate(&format!("actor-{}", actor));
            c.original = Some(snap("什么是惯性？？", "物体保持原有运动状态不变的性质"));
            c.edit_actor = Some(actor.to_string());
            let s = classify_candidate(&c, &GoldMiningConfig::default());
            assert_eq!(s.label, GoldLabel::Unlabeled, "actor={}", actor);
            assert!(s.repair_pair.is_none());
        }
    }

    #[test]
    fn user_actor_proof_keeps_kept_unedited_channel_untouched() {
        // 编辑者闸门只作用于"内容有变"的编辑通道：original == current 时
        // KeptUnedited 桶不看 actor（无归因问题），红线回归。
        let mut c = base_candidate("kept-no-actor");
        c.original = Some(c.current.clone());
        c.review_count = 5;
        c.again_count = 1;
        assert_eq!(
            classify_candidate(&c, &GoldMiningConfig::default()).label,
            GoldLabel::KeptUnedited
        );
    }

    #[test]
    fn gold_candidate_old_json_without_edit_actor_deserializes() {
        // 旧 fixture / 离线脚本 JSON（无 edit_actor、无 critic_revised 字段）
        // 必须零迁移反序列化，默认 None / false。
        let raw = json!({
            "card_id": "legacy",
            "current": {"front": "Q", "back": "A"},
            "original": null,
            "created_at_ms": 0,
            "updated_at_ms": 0,
            "deleted_at_ms": null,
            "review_count": 0,
            "again_count": 0,
            "was_error_card": false,
            "is_error_card": false
        });
        let c: GoldCandidate = serde_json::from_value(raw).expect("旧 JSON 必须兼容");
        assert!(c.edit_actor.is_none());
        assert!(!c.critic_revised);
    }

    // -------- _content_provenance 读写 helper --------

    #[test]
    fn content_provenance_round_trips_via_extras() {
        let mut extras = HashMap::new();
        insert_content_provenance(&mut extras, &ContentProvenance::user("update_library_card"));

        let parsed = parse_content_provenance(&extras).expect("round trip");
        assert_eq!(parsed.actor, PROVENANCE_ACTOR_USER);
        assert_eq!(parsed.code.as_deref(), Some("update_library_card"));
        assert!(parsed.at.is_some(), "写入戳必须带时间");
        assert!(is_user_proven_edit(&extras));
        assert!(!is_llm_critic_actor(&extras));
    }

    #[test]
    fn content_provenance_is_last_writer_wins() {
        // 与 _original_generation 的首写幂等相反：provenance 记录最后写入者
        let mut extras = HashMap::new();
        insert_content_provenance(&mut extras, &ContentProvenance::llm_critic_revision());
        assert!(is_llm_critic_actor(&extras));

        insert_content_provenance(&mut extras, &ContentProvenance::user(""));
        let parsed = parse_content_provenance(&extras).expect("parse");
        assert_eq!(parsed.actor, PROVENANCE_ACTOR_USER);
        assert!(parsed.code.is_none(), "空串 code 必须省略");
        assert!(is_user_proven_edit(&extras));
        assert!(!is_llm_critic_actor(&extras));
    }

    #[test]
    fn content_provenance_uses_camel_case_and_ignores_unknown_fields() {
        // wire 契约：camelCase 序列化；未知字段（未来版本新增）必须被忽略
        let raw = serde_json::to_string(&ContentProvenance {
            actor: PROVENANCE_ACTOR_LLM_CRITIC.to_string(),
            code: Some(CRITIC_REVISED_QA_CODE.to_string()),
            at: Some("2026-08-24T00:00:00Z".to_string()),
        })
        .unwrap();
        assert!(raw.contains("\"actor\":\"llm_critic\""));
        assert!(raw.contains("\"code\":\"llm_critic_revised\""));
        assert!(raw.contains("\"at\":"));

        let mut extras = HashMap::new();
        extras.insert(
            CONTENT_PROVENANCE_FIELD.to_string(),
            r#"{"actor":"user","code":"x","at":"2026-01-01T00:00:00Z","futureField":123}"#
                .to_string(),
        );
        let parsed = parse_content_provenance(&extras).expect("未知字段必须被忽略");
        assert_eq!(parsed.actor, PROVENANCE_ACTOR_USER);
        assert!(is_user_proven_edit(&extras));
    }

    #[test]
    fn content_provenance_malformed_values_are_fail_closed() {
        // 非法 JSON / 非对象 / 缺 actor → None，且不算任何一方的证明
        for bad in ["not-json", "42", r#"{"code":"x"}"#, r#"["user"]"#] {
            let extras = HashMap::from([(CONTENT_PROVENANCE_FIELD.to_string(), bad.to_string())]);
            assert!(parse_content_provenance(&extras).is_none(), "bad={}", bad);
            assert!(!is_user_proven_edit(&extras));
            assert!(!is_llm_critic_actor(&extras));
        }
        assert!(parse_content_provenance(&HashMap::new()).is_none());
    }

    #[test]
    fn provenance_detection_does_not_depend_on_qa_flags() {
        // provenance 是第二道闸：_qa_flags 完全缺席时 llm_critic actor 仍可识别
        let mut extras = HashMap::new();
        insert_content_provenance(&mut extras, &ContentProvenance::llm_critic_revision());
        assert!(!extras.contains_key(QA_FLAGS_FIELD));
        assert!(is_llm_critic_actor(&extras));
        assert!(
            !has_critic_revision_marker(&extras),
            "marker 与 provenance 是相互独立的两道闸"
        );
    }

    #[test]
    fn edited_by_timestamp_without_original_is_unlabeled_with_reason() {
        let mut c = base_candidate("c7");
        c.updated_at_ms = c.created_at_ms + 60 * 60 * 1000; // 1h 后编辑
        let s = classify_candidate(&c, &GoldMiningConfig::default());
        assert_eq!(s.label, GoldLabel::Unlabeled);
        assert!(
            s.reason.contains("_original_generation"),
            "reason={}",
            s.reason
        );
    }

    // -------- classify：删除通道 --------

    #[test]
    fn early_delete_without_reviews_is_negative() {
        let mut c = base_candidate("c8");
        c.deleted_at_ms = Some(c.created_at_ms + 2 * 60 * 60 * 1000);
        let s = classify_candidate(&c, &GoldMiningConfig::default());
        assert_eq!(s.label, GoldLabel::DeletedEarly);
    }

    #[test]
    fn reviewed_or_late_delete_is_unlabeled() {
        let cfg = GoldMiningConfig::default();
        // 复习过再删：动机不明
        let mut c = base_candidate("c9");
        c.deleted_at_ms = Some(c.created_at_ms + 60 * 1000);
        c.review_count = 2;
        assert_eq!(classify_candidate(&c, &cfg).label, GoldLabel::Unlabeled);
        // 超过 24h 窗口
        let mut c = base_candidate("c10");
        c.deleted_at_ms = Some(c.created_at_ms + 48 * 60 * 60 * 1000);
        assert_eq!(classify_candidate(&c, &cfg).label, GoldLabel::Unlabeled);
    }

    // -------- classify：错误卡修复 --------

    #[test]
    fn repaired_error_card_becomes_repair_pair() {
        let mut c = base_candidate("c11");
        c.was_error_card = true;
        c.original = Some(snap("{'front': '什么是纯函数？'", ""));
        let s = classify_candidate(&c, &GoldMiningConfig::default());
        assert_eq!(s.label, GoldLabel::ErrorCardRepaired);
        let pair = s.repair_pair.expect("pair");
        assert_eq!(pair.edited.front, "什么是惯性？");
    }

    #[test]
    fn still_broken_or_blank_error_card_is_unlabeled() {
        let cfg = GoldMiningConfig::default();
        let mut c = base_candidate("c12");
        c.is_error_card = true;
        assert_eq!(classify_candidate(&c, &cfg).label, GoldLabel::Unlabeled);

        let mut c = base_candidate("c13");
        c.was_error_card = true;
        c.current = CardSnapshot::default();
        assert_eq!(classify_candidate(&c, &cfg).label, GoldLabel::Unlabeled);
    }

    // -------- mine_gold_set / stats / bucket --------

    #[test]
    fn mine_gold_set_buckets_and_stats() {
        let cfg = GoldMiningConfig::default();
        let mut kept = base_candidate("k");
        kept.review_count = 3;
        let mut minor = base_candidate("m");
        minor.original = Some(snap("什么是惯性？？", "物体保持原有运动状态不变的性质"));
        minor.edit_actor = Some(PROVENANCE_ACTOR_USER.to_string());
        let mut deleted = base_candidate("d");
        deleted.deleted_at_ms = Some(deleted.created_at_ms + 1000);
        let unlabeled = base_candidate("u"); // 零复习未编辑

        let samples = mine_gold_set(&[kept, minor, deleted, unlabeled], &cfg);
        let stats = gold_set_stats(&samples);
        assert_eq!(
            stats,
            GoldSetStats {
                kept_unedited: 1,
                edited_minor: 1,
                edited_major: 0,
                deleted_early: 1,
                error_card_repaired: 0,
                unlabeled: 1,
            }
        );

        assert_eq!(
            fixture_export_bucket(GoldLabel::KeptUnedited),
            Some("gold/positive")
        );
        assert_eq!(
            fixture_export_bucket(GoldLabel::EditedMinor),
            Some("gold/repair-pairs")
        );
        assert_eq!(
            fixture_export_bucket(GoldLabel::ErrorCardRepaired),
            Some("gold/repair-pairs")
        );
        assert_eq!(
            fixture_export_bucket(GoldLabel::DeletedEarly),
            Some("gold/negative")
        );
        assert_eq!(fixture_export_bucket(GoldLabel::Unlabeled), None);
    }

    // -------- lint 契约校验 --------

    #[test]
    fn lint_repair_pair_degraded_original_and_clean_edited() {
        let pair = RepairPair {
            // 劣化：front 泄露答案原文
            original: snap(
                "快速排序的平均时间复杂度是多少？答案是 O(n log n)。",
                "O(n log n)",
            ),
            edited: snap("快速排序的平均时间复杂度是多少？", "O(n log n)"),
            distance_ratio: 0.3,
        };
        let report = lint_repair_pair(&pair, &gold_lint_config());
        assert!(report.original_flagged);
        assert!(report.original_codes.contains(&"answer_leak".to_string()));
        assert!(
            report.edited_clean,
            "edited codes: {:?}",
            report.edited_codes
        );
        assert!(!report.lint_blind_spot);
    }

    #[test]
    fn lint_repair_pair_detects_blind_spot() {
        // 用户改了措辞但两端 lint 都不报 → 盲区
        let pair = RepairPair {
            original: snap("什么是惯性？", "物体保持运动状态的性质"),
            edited: snap("什么是惯性？", "物体保持原有运动状态不变的固有属性"),
            distance_ratio: 0.4,
        };
        let report = lint_repair_pair(&pair, &gold_lint_config());
        assert!(!report.original_flagged);
        assert!(report.edited_clean);
        assert!(report.lint_blind_spot);
    }

    #[test]
    fn gold_lint_config_suppresses_info_noise() {
        // 快照不带 tags：默认配置会命中 tags_empty(Info)，
        // gold 配置 + Warn 过滤后必须为空
        let clean = snap("什么是哈希冲突？", "不同键映射到同一槽位的现象");
        let codes = lint_snapshot_codes(&clean, &gold_lint_config());
        assert!(codes.is_empty(), "codes={:?}", codes);
    }

    // -------- grounded critic 参照对选取（Round 5 #4） --------

    fn pair_sample(
        id: &str,
        label: GoldLabel,
        original: CardSnapshot,
        edited: CardSnapshot,
    ) -> GoldSample {
        let ratio = edit_ratio(&original, &edited);
        GoldSample {
            card_id: id.to_string(),
            label,
            reason: "测试样本".to_string(),
            repair_pair: Some(RepairPair {
                original,
                edited,
                distance_ratio: ratio,
            }),
        }
    }

    #[test]
    fn extract_original_from_extras_string_form() {
        let mut extras: HashMap<String, String> = HashMap::new();
        extras.insert(
            ORIGINAL_GENERATION_FIELD.to_string(),
            r#"{"front":"Q","back":"A"}"#.to_string(),
        );
        let snap = extract_original_from_extras(&extras).expect("must parse");
        assert_eq!(snap.front, "Q");
        assert_eq!(snap.back, "A");

        // 缺键 / 非法 JSON / 非对象形状 → None
        assert!(extract_original_from_extras(&HashMap::new()).is_none());
        let mut bad: HashMap<String, String> = HashMap::new();
        bad.insert(
            ORIGINAL_GENERATION_FIELD.to_string(),
            "not-json".to_string(),
        );
        assert!(extract_original_from_extras(&bad).is_none());
        let mut num: HashMap<String, String> = HashMap::new();
        num.insert(ORIGINAL_GENERATION_FIELD.to_string(), "42".to_string());
        assert!(extract_original_from_extras(&num).is_none());
    }

    #[test]
    fn select_reference_pairs_requires_clean_gold_side() {
        let cfg = gold_lint_config();
        let clean = pair_sample(
            "good",
            GoldLabel::EditedMinor,
            snap("什么是惯性？答案是保持运动状态。", "保持运动状态"),
            snap("什么是惯性？", "物体保持原有运动状态不变的性质"),
        );
        // 金标端仍残留占位符 → 必须被过滤（脏金标不得进入 critic prompt）
        let dirty_gold = pair_sample(
            "dirty",
            GoldLabel::EditedMajor,
            snap("TODO 问题", "TODO"),
            snap("什么是加速度？", "请参考 {{DOCUMENT_CONTENT}}"),
        );
        let samples = [clean, dirty_gold];
        let picked = select_grounded_reference_pairs(&samples, &cfg, 10);
        assert_eq!(picked.len(), 1);
        assert_eq!(picked[0].edited.front, "什么是惯性？");
    }

    #[test]
    fn select_reference_pairs_keeps_lint_blind_spot_pairs() {
        // 两端 lint 都不报的语义修正对（盲区）恰是 LLM critic 的增量价值，必须保留
        let cfg = gold_lint_config();
        let blind = pair_sample(
            "blind",
            GoldLabel::EditedMinor,
            snap("什么是惯性？", "物体保持运动状态的性质"),
            snap("什么是惯性？", "物体保持原有运动状态不变的固有属性"),
        );
        let samples = [blind];
        let picked = select_grounded_reference_pairs(&samples, &cfg, 10);
        assert_eq!(
            picked.len(),
            1,
            "lint 盲区对不得被 original_flagged 门槛挡掉"
        );
    }

    #[test]
    fn select_reference_pairs_filters_labels_blanks_and_duplicates() {
        let cfg = gold_lint_config();
        // 非修正对标签：即便带 pair 也不选
        let mut wrong_label = pair_sample(
            "kept",
            GoldLabel::KeptUnedited,
            snap("Q", "A"),
            snap("什么是熵？", "系统混乱程度的度量"),
        );
        wrong_label.label = GoldLabel::KeptUnedited;
        // 金标端为空
        let blank_gold = pair_sample(
            "blank",
            GoldLabel::EditedMajor,
            snap("坏问题", "坏答案"),
            CardSnapshot::default(),
        );
        // 有效对 + 同 front 重复对
        let valid = pair_sample(
            "v1",
            GoldLabel::EditedMinor,
            snap("什么是熵？？", "混乱度"),
            snap("什么是熵？", "系统混乱程度的度量"),
        );
        let dup_front = pair_sample(
            "v2",
            GoldLabel::EditedMajor,
            snap("什么是熵", "TODO"),
            snap("什么是熵？", "另一种表述的答案"),
        );
        // 无 pair 的样本
        let no_pair = GoldSample {
            card_id: "np".to_string(),
            label: GoldLabel::EditedMinor,
            reason: "x".to_string(),
            repair_pair: None,
        };
        let samples = [wrong_label, blank_gold, valid, dup_front, no_pair];
        let picked = select_grounded_reference_pairs(&samples, &cfg, 10);
        assert_eq!(picked.len(), 1, "只有首个干净且不重复的修正对入选");
        assert_eq!(picked[0].edited.back, "系统混乱程度的度量");
    }

    #[test]
    fn select_reference_pairs_caps_at_max_preserving_order() {
        let cfg = gold_lint_config();
        let samples: Vec<GoldSample> = (0..5)
            .map(|i| {
                pair_sample(
                    &format!("s{}", i),
                    GoldLabel::EditedMinor,
                    snap(&format!("旧问题{}？？", i), "旧答案"),
                    snap(&format!("问题{}是什么？", i), &format!("答案{}", i)),
                )
            })
            .collect();
        let picked = select_grounded_reference_pairs(&samples, &cfg, 2);
        assert_eq!(picked.len(), 2);
        assert_eq!(picked[0].edited.front, "问题0是什么？");
        assert_eq!(picked[1].edited.front, "问题1是什么？", "必须保持输入顺序");
    }

    // -------- 脱敏 --------

    #[test]
    fn scrub_pii_strips_email_phone_and_id() {
        let (out, n) = scrub_pii("联系 alice@example.com 或 13812345678，证件 11010119900307867X");
        assert!(!out.contains("alice@example.com"));
        assert!(!out.contains("13812345678"));
        assert!(!out.contains("11010119900307867X"));
        assert!(out.contains("[已脱敏邮箱]"));
        assert!(out.contains("[已脱敏手机号]"));
        assert!(out.contains("[已脱敏证件号]"));
        assert_eq!(n, 3);
    }

    #[test]
    fn scrub_pii_preserves_normal_content() {
        let text = "TCP 三次握手：SYN、SYN-ACK、ACK；速度 299792458 m/s 不是手机号";
        let (out, n) = scrub_pii(text);
        assert_eq!(out, text);
        assert_eq!(n, 0);
    }

    // -------- 导出整形 --------

    #[test]
    fn fixture_json_scrubs_and_shapes_repair_pair() {
        let sample = GoldSample {
            card_id: "rp-x".to_string(),
            label: GoldLabel::EditedMinor,
            reason: "小幅编辑".to_string(),
            repair_pair: Some(RepairPair {
                original: snap("联系 bob@example.com 咨询答案", "42"),
                edited: snap("生命、宇宙及一切的终极答案是？", "42"),
                distance_ratio: 0.123456,
            }),
        };
        let v = to_fixture_json(&sample).expect("exportable");
        assert_eq!(v["id"], "rp-x");
        assert_eq!(v["label"], "edited_minor");
        assert_eq!(v["original"]["front"], "联系 [已脱敏邮箱] 咨询答案");
        assert_eq!(v["edited"]["front"], "生命、宇宙及一切的终极答案是？");
        assert_eq!(v["distanceRatio"], 0.123);

        let unlabeled = GoldSample {
            card_id: "u".to_string(),
            label: GoldLabel::Unlabeled,
            reason: "x".to_string(),
            repair_pair: None,
        };
        assert!(to_fixture_json(&unlabeled).is_none());
    }

    // -------- 跨语言 lint 契约守护 --------

    #[test]
    fn lint_contract_codes_match_anki_qa_lint_source() {
        use std::collections::BTreeSet;
        let source = include_str!("anki_qa_lint.rs");
        let ctor = regex::Regex::new(r#"LintIssue::new\(\s*"([a-z_]+)""#).unwrap();
        let json_code = regex::Regex::new(r#""code":\s*"([a-z_]+)""#).unwrap();
        let mut found: BTreeSet<String> = BTreeSet::new();
        for caps in ctor.captures_iter(source) {
            found.insert(caps[1].to_string());
        }
        for caps in json_code.captures_iter(source) {
            found.insert(caps[1].to_string());
        }
        let declared: BTreeSet<String> =
            LINT_CONTRACT_CODES.iter().map(|s| s.to_string()).collect();
        assert_eq!(
            declared, found,
            "LINT_CONTRACT_CODES 与 anki_qa_lint.rs 实际产出的 code 漂移：\n仅契约有: {:?}\n仅源码有: {:?}",
            declared.difference(&found).collect::<Vec<_>>(),
            found.difference(&declared).collect::<Vec<_>>()
        );
    }

    #[test]
    fn lint_contract_codes_have_no_duplicates() {
        use std::collections::HashSet;
        let set: HashSet<&str> = LINT_CONTRACT_CODES.iter().copied().collect();
        assert_eq!(set.len(), LINT_CONTRACT_CODES.len());
    }

    // -------- 仓库内金标修正对 fixture 消费（plan §5.2 落地） --------

    #[test]
    fn repo_repair_pair_fixtures_satisfy_lint_contract() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tests/fixtures/anki-eval/gold/repair-pairs");
        let mut checked = 0usize;
        let cfg = gold_lint_config();
        let mut entries: Vec<_> = std::fs::read_dir(&dir)
            .expect("gold/repair-pairs 目录必须存在")
            .filter_map(Result::ok)
            .filter(|e| e.path().extension().map(|x| x == "json").unwrap_or(false))
            .collect();
        entries.sort_by_key(|e| e.path());
        for entry in entries {
            let raw = std::fs::read_to_string(entry.path()).expect("readable");
            let v: Value = serde_json::from_str(&raw).expect("valid json");
            let original: CardSnapshot =
                serde_json::from_value(v["original"].clone()).expect("original snapshot");
            let edited: CardSnapshot =
                serde_json::from_value(v["edited"].clone()).expect("edited snapshot");
            let pair = RepairPair {
                distance_ratio: edit_ratio(&original, &edited),
                original,
                edited,
            };
            let report = lint_repair_pair(&pair, &cfg);
            assert!(
                report.original_flagged,
                "{:?}: original 必须被 lint 命中（改前=劣化），实际 codes={:?}",
                entry.path(),
                report.original_codes
            );
            assert!(
                report.edited_clean,
                "{:?}: edited 必须零 lint 命中（改后=金标），实际 codes={:?}",
                entry.path(),
                report.edited_codes
            );
            checked += 1;
        }
        assert!(checked >= 3, "至少 3 个修正对 fixture，实际 {}", checked);
    }
}
