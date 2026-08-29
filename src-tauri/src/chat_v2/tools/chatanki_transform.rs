//! `builtin-chatanki_transform` 声明式变换引擎（ops 模式，纯 Rust）。
//!
//! 参考 `docs/research/anki-ai-native/round1/04-shell-script-integration.md`
//! 的方案 B/C 组合：
//! - **ops 声明式子集**（`regex_replace` / `tag_add` / `tag_remove`）：纯 Rust 执行
//!   （regex crate，无回溯灾难），移动端可用，本文件完整实现；
//! - **script（沙箱脚本）模式**：Round 3 已生产化，参数归一化 / I/O 合同 /
//!   解释器探测 / 沙箱执行 / 输出校验在 `chatanki_transform_script.rs`，
//!   实现说明见 `docs/research/anki-ai-native/round3/01-transform-script.md`。
//!
//! 本模块只承载「参数解析/归一化 + 纯函数变换引擎 + 逐卡计划（`TransformCardPlan`）
//! + expectedVersions 校验」，不触达数据库；DB 全文快照读取（无 2000 字符截断）、
//! 逐卡 CAS 写回与预览块 UI 同步在 `chatanki_executor.rs` 的 `execute_transform`
//! 中复用既有原语完成——ops 与 script 两种模式共用同一条 CAS 写回路径。

use std::collections::{HashMap, HashSet};

use regex::Regex;
use serde::Deserialize;

use super::chatanki_transform_script::{NormalizedTransformScript, TransformScriptSpec};

/// 一次变换最多允许的声明式操作数。
pub const CHATANKI_TRANSFORM_OPS_LIMIT: usize = 20;
/// 一次变换最多允许选中的卡片数（快照上限，对齐调研报告 §6 资源边界）。
pub const CHATANKI_TRANSFORM_CARD_LIMIT: usize = 500;
/// 正则 pattern 长度上限。
pub const CHATANKI_TRANSFORM_PATTERN_MAX_LEN: usize = 1024;
/// 正则替换串长度上限。
pub const CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN: usize = 4096;
/// 单个 op 携带的标签数上限。
pub const CHATANKI_TRANSFORM_TAGS_LIMIT: usize = 50;
/// 单个 tag 的字符数上限（Round 4 安全复审；与 APKG 导入 MAX_TAG_BYTES 同量级）。
pub const CHATANKI_TRANSFORM_TAG_MAX_CHARS: usize = 4_096;
/// regex_replace 单字段输出的字节数上限（Round 4 安全复审）。
///
/// pattern=`(?s).` 配 4096 字符替换串可把字段每 op 放大 ~4096 倍，20 个 op
/// 级联时第二个 op 就会试图物化 >100GB 的字符串（内存 DoS）。每次替换前
/// 精确预检展开后的字节数：结果超过本上限**且比输入更大**（= 真的在膨胀，
/// 而非存量超长字段的原样保留/收缩）→ 该卡整体拒绝，不分配结果、不写库。
pub const CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES: usize = 1024 * 1024;

// ============================================================================
// 参数（wire 形态）
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransformMode {
    #[default]
    DryRun,
    Apply,
}

impl TransformMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::DryRun => "dry_run",
            Self::Apply => "apply",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransformFilter {
    All,
    EditedOnly,
    ErrorOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransformField {
    Front,
    Back,
    Text,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum TransformOpKind {
    RegexReplace,
    TagAdd,
    TagRemove,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransformOpSpec {
    op: TransformOpKind,
    field: Option<TransformField>,
    pattern: Option<String>,
    replacement: Option<String>,
    tags: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransformSelectionArgs {
    #[serde(alias = "cardIds")]
    card_ids: Option<Vec<String>>,
    filter: Option<TransformFilter>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TransformSpecArgs {
    /// 沙箱脚本变换（python/node，网络恒禁，I/O 走 CHATANKI_INPUT/OUTPUT 合同）。
    script: Option<TransformScriptSpec>,
    ops: Option<Vec<TransformOpSpec>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChatAnkiTransformArgs {
    #[serde(alias = "documentId")]
    document_id: String,
    selection: Option<TransformSelectionArgs>,
    #[serde(default)]
    mode: TransformMode,
    transform: TransformSpecArgs,
    #[serde(alias = "expectedVersions", default)]
    expected_versions: Option<HashMap<String, String>>,
    purpose: Option<String>,
}

// ============================================================================
// 归一化结果
// ============================================================================

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizedTransformOp {
    RegexReplace {
        field: TransformField,
        pattern: String,
        replacement: String,
    },
    TagAdd {
        tags: Vec<String>,
    },
    TagRemove {
        tags: Vec<String>,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub enum NormalizedTransformKind {
    /// 沙箱脚本变换（High 敏感度；移动端/无沙箱环境结构化拒绝）。
    Script(NormalizedTransformScript),
    Ops(Vec<NormalizedTransformOp>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NormalizedTransformSelection {
    /// 缺省：文档全部 live 非诊断卡（排除 is_error_card）。
    DefaultLive,
    Filter(TransformFilter),
    Cards(Vec<String>),
}

#[derive(Debug)]
pub struct NormalizedTransformRequest {
    pub document_id: String,
    pub selection: NormalizedTransformSelection,
    pub mode: TransformMode,
    pub kind: NormalizedTransformKind,
    /// apply 模式必填（cardId -> version）；dry_run 忽略并保持为空。
    pub expected_versions: HashMap<String, String>,
    #[allow(dead_code)] // 审计/审批展示用途；执行路径暂不消费。
    pub purpose: Option<String>,
}

impl ChatAnkiTransformArgs {
    pub fn normalize(self) -> Result<NormalizedTransformRequest, String> {
        let document_id = self.document_id.trim().to_string();
        if document_id.is_empty() {
            return Err("documentId is required".to_string());
        }

        let kind = match (self.transform.script, self.transform.ops) {
            (Some(_), Some(_)) => {
                return Err("transform.script and transform.ops are mutually exclusive".to_string());
            }
            (None, None) => {
                return Err("transform requires exactly one of script or ops".to_string());
            }
            (Some(script), None) => NormalizedTransformKind::Script(script.normalize()?),
            (None, Some(ops)) => NormalizedTransformKind::Ops(normalize_transform_ops(ops)?),
        };

        let selection = match self.selection {
            None => NormalizedTransformSelection::DefaultLive,
            Some(selection) => match (selection.card_ids, selection.filter) {
                (Some(_), Some(_)) => {
                    return Err(
                        "selection.cardIds and selection.filter are mutually exclusive".to_string(),
                    );
                }
                (None, None) => {
                    return Err("selection requires cardIds or filter".to_string());
                }
                (None, Some(filter)) => NormalizedTransformSelection::Filter(filter),
                (Some(card_ids), None) => {
                    let mut seen = HashSet::new();
                    let mut normalized = Vec::with_capacity(card_ids.len());
                    for card_id in card_ids {
                        let card_id = card_id.trim().to_string();
                        if card_id.is_empty() {
                            return Err("selection.cardIds must not contain empty IDs".to_string());
                        }
                        if !seen.insert(card_id.clone()) {
                            return Err(
                                "selection.cardIds must not contain duplicate IDs".to_string()
                            );
                        }
                        normalized.push(card_id);
                    }
                    if normalized.is_empty() || normalized.len() > CHATANKI_TRANSFORM_CARD_LIMIT {
                        return Err(format!(
                            "selection.cardIds must contain 1..={} unique entries",
                            CHATANKI_TRANSFORM_CARD_LIMIT
                        ));
                    }
                    NormalizedTransformSelection::Cards(normalized)
                }
            },
        };

        // apply 必须携带完整 expectedVersions（与 retemplate 相同 CAS 语义）；
        // dry_run 不写库，忽略传入的映射。
        let expected_versions = match self.mode {
            TransformMode::DryRun => HashMap::new(),
            TransformMode::Apply => {
                let raw = self
                    .expected_versions
                    .filter(|map| !map.is_empty())
                    .ok_or_else(|| {
                        "mode=apply requires expectedVersions (cardId -> version from the latest get_cards)"
                            .to_string()
                    })?;
                let mut normalized = HashMap::with_capacity(raw.len());
                for (card_id, version) in raw {
                    let card_id = card_id.trim().to_string();
                    let version = version.trim().to_string();
                    if card_id.is_empty() || version.is_empty() {
                        return Err(
                            "expectedVersions keys and values must not be empty".to_string()
                        );
                    }
                    if normalized.insert(card_id, version).is_some() {
                        return Err(
                            "expectedVersions contains duplicate normalized card IDs".to_string()
                        );
                    }
                }
                normalized
            }
        };

        Ok(NormalizedTransformRequest {
            document_id,
            selection,
            mode: self.mode,
            kind,
            expected_versions,
            purpose: self
                .purpose
                .map(|value| value.trim().to_string())
                .filter(|value| !value.is_empty()),
        })
    }
}

fn normalize_transform_ops(
    ops: Vec<TransformOpSpec>,
) -> Result<Vec<NormalizedTransformOp>, String> {
    if ops.is_empty() || ops.len() > CHATANKI_TRANSFORM_OPS_LIMIT {
        return Err(format!(
            "transform.ops must contain 1..={} operations",
            CHATANKI_TRANSFORM_OPS_LIMIT
        ));
    }
    let mut normalized = Vec::with_capacity(ops.len());
    for (index, op) in ops.into_iter().enumerate() {
        let normalized_op = match op.op {
            TransformOpKind::RegexReplace => {
                let field = op.field.ok_or_else(|| {
                    format!("ops[{index}]: regex_replace requires field (front/back/text)")
                })?;
                let pattern = op
                    .pattern
                    .as_deref()
                    .map(str::trim)
                    .filter(|pattern| !pattern.is_empty())
                    .ok_or_else(|| {
                        format!("ops[{index}]: regex_replace requires a non-empty pattern")
                    })?
                    .to_string();
                if pattern.chars().count() > CHATANKI_TRANSFORM_PATTERN_MAX_LEN {
                    return Err(format!(
                        "ops[{index}]: pattern exceeds {} characters",
                        CHATANKI_TRANSFORM_PATTERN_MAX_LEN
                    ));
                }
                let replacement = op.replacement.unwrap_or_default();
                if replacement.chars().count() > CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN {
                    return Err(format!(
                        "ops[{index}]: replacement exceeds {} characters",
                        CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN
                    ));
                }
                if op.tags.is_some() {
                    return Err(format!("ops[{index}]: regex_replace does not accept tags"));
                }
                NormalizedTransformOp::RegexReplace {
                    field,
                    pattern,
                    replacement,
                }
            }
            TransformOpKind::TagAdd | TransformOpKind::TagRemove => {
                if op.field.is_some() || op.pattern.is_some() || op.replacement.is_some() {
                    return Err(format!(
                        "ops[{index}]: tag_add/tag_remove only accept the tags parameter"
                    ));
                }
                let raw_tags = op.tags.ok_or_else(|| {
                    format!("ops[{index}]: tag_add/tag_remove require a non-empty tags list")
                })?;
                let mut seen = HashSet::new();
                let mut tags = Vec::with_capacity(raw_tags.len());
                for tag in raw_tags {
                    let tag = tag.trim().to_string();
                    if tag.is_empty() {
                        return Err(format!("ops[{index}]: tags must not contain empty entries"));
                    }
                    if tag.chars().count() > CHATANKI_TRANSFORM_TAG_MAX_CHARS {
                        return Err(format!(
                            "ops[{index}]: tags must not exceed {} characters",
                            CHATANKI_TRANSFORM_TAG_MAX_CHARS
                        ));
                    }
                    if seen.insert(tag.clone()) {
                        tags.push(tag);
                    }
                }
                if tags.is_empty() || tags.len() > CHATANKI_TRANSFORM_TAGS_LIMIT {
                    return Err(format!(
                        "ops[{index}]: tags must contain 1..={} unique entries",
                        CHATANKI_TRANSFORM_TAGS_LIMIT
                    ));
                }
                match op.op {
                    TransformOpKind::TagAdd => NormalizedTransformOp::TagAdd { tags },
                    _ => NormalizedTransformOp::TagRemove { tags },
                }
            }
        };
        normalized.push(normalized_op);
    }
    Ok(normalized)
}

// ============================================================================
// ops 编译与应用（纯函数）
// ============================================================================

#[derive(Debug)]
pub enum CompiledTransformOp {
    RegexReplace {
        field: TransformField,
        regex: Regex,
        replacement: String,
    },
    TagAdd {
        tags: Vec<String>,
    },
    TagRemove {
        tags: Vec<String>,
    },
}

#[derive(Debug, PartialEq, Eq)]
pub struct InvalidPatternError {
    pub op_index: usize,
    pub pattern: String,
    pub error: String,
}

/// 一次性编译全部正则；任一 pattern 编译失败即整批拒绝（不写库）。
pub fn compile_transform_ops(
    ops: &[NormalizedTransformOp],
) -> Result<Vec<CompiledTransformOp>, InvalidPatternError> {
    let mut compiled = Vec::with_capacity(ops.len());
    for (index, op) in ops.iter().enumerate() {
        let compiled_op = match op {
            NormalizedTransformOp::RegexReplace {
                field,
                pattern,
                replacement,
            } => {
                let regex = Regex::new(pattern).map_err(|error| InvalidPatternError {
                    op_index: index,
                    pattern: pattern.clone(),
                    error: error.to_string(),
                })?;
                CompiledTransformOp::RegexReplace {
                    field: *field,
                    regex,
                    replacement: replacement.clone(),
                }
            }
            NormalizedTransformOp::TagAdd { tags } => {
                CompiledTransformOp::TagAdd { tags: tags.clone() }
            }
            NormalizedTransformOp::TagRemove { tags } => {
                CompiledTransformOp::TagRemove { tags: tags.clone() }
            }
        };
        compiled.push(compiled_op);
    }
    Ok(compiled)
}

/// 变换作用面：卡片的可变换字段快照（全文，不经任何截断视图）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransformFields {
    pub front: String,
    pub back: String,
    pub text: Option<String>,
    pub tags: Vec<String>,
}

impl TransformFields {
    pub fn from_card(card: &crate::models::AnkiCard) -> Self {
        Self {
            front: card.front.clone(),
            back: card.back.clone(),
            text: card.text.clone(),
            tags: card.tags.clone(),
        }
    }
}

/// regex_replace 输出膨胀超限（Round 4 安全复审）：该卡计划非法，逐卡拒绝。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TransformFieldGrowthError {
    /// 触发膨胀的 op 序号（0 基）。
    pub op_index: usize,
    /// 被膨胀的字段名。
    pub field: &'static str,
    /// 预检时已确认至少会达到的字节数。
    pub bytes: usize,
}

impl TransformFieldGrowthError {
    pub fn detail(&self) -> String {
        format!(
            "ops[{}] would grow field '{}' to at least {} bytes, exceeding the {} byte limit",
            self.op_index, self.field, self.bytes, CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES
        )
    }
}

fn capture_reference_len(captures: &regex::Captures<'_>, reference: &str) -> usize {
    match reference.parse::<usize>() {
        Ok(index) => captures
            .get(index)
            .map_or(0, |matched| matched.as_str().len()),
        Err(_) => captures
            .name(reference)
            .map_or(0, |matched| matched.as_str().len()),
    }
}

/// 精确计算 regex crate 替换串在一组 captures 上的展开字节数，语义覆盖
/// `$name` / `$1` / `${name}` / `${1}` / `$$`。只做整数运算，不物化展开串。
fn expanded_replacement_len(captures: &regex::Captures<'_>, replacement: &str) -> usize {
    let bytes = replacement.as_bytes();
    let mut cursor = 0usize;
    let mut expanded = 0usize;

    while cursor < bytes.len() {
        let Some(relative_dollar) = bytes[cursor..].iter().position(|byte| *byte == b'$') else {
            return expanded.saturating_add(bytes.len() - cursor);
        };
        expanded = expanded.saturating_add(relative_dollar);
        let dollar = cursor + relative_dollar;

        match bytes.get(dollar + 1).copied() {
            Some(b'$') => {
                expanded = expanded.saturating_add(1);
                cursor = dollar + 2;
            }
            Some(b'{') => {
                let reference_start = dollar + 2;
                let Some(relative_end) = bytes[reference_start..]
                    .iter()
                    .position(|byte| *byte == b'}')
                else {
                    expanded = expanded.saturating_add(1);
                    cursor = dollar + 1;
                    continue;
                };
                let reference_end = reference_start + relative_end;
                expanded = expanded.saturating_add(capture_reference_len(
                    captures,
                    &replacement[reference_start..reference_end],
                ));
                cursor = reference_end + 1;
            }
            Some(next) if next.is_ascii_alphanumeric() || next == b'_' => {
                let reference_start = dollar + 1;
                let mut reference_end = reference_start;
                while bytes
                    .get(reference_end)
                    .is_some_and(|byte| byte.is_ascii_alphanumeric() || *byte == b'_')
                {
                    reference_end += 1;
                }
                expanded = expanded.saturating_add(capture_reference_len(
                    captures,
                    &replacement[reference_start..reference_end],
                ));
                cursor = reference_end;
            }
            _ => {
                expanded = expanded.saturating_add(1);
                cursor = dollar + 1;
            }
        }
    }
    expanded
}

fn add_projected_bytes(
    projected: &mut usize,
    additional: usize,
    limit: usize,
) -> Result<(), usize> {
    *projected = projected.saturating_add(additional);
    if *projected > limit {
        Err(*projected)
    } else {
        Ok(())
    }
}

/// 单次 regex_replace 的分配前膨胀闸门。结果超限且比输入更大才拒绝；
/// 存量超长字段的原样保留或收缩仍可通过。
fn bounded_regex_replace(
    op_index: usize,
    field: &'static str,
    regex: &Regex,
    before: &str,
    replacement: &str,
) -> Result<String, TransformFieldGrowthError> {
    let allocation_limit = CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES.max(before.len());
    let mut projected = 0usize;
    let mut previous_end = 0usize;
    for captures in regex.captures_iter(before) {
        let matched = captures
            .get(0)
            .expect("regex captures always include the full match");
        for additional in [
            matched.start().saturating_sub(previous_end),
            expanded_replacement_len(&captures, replacement),
        ] {
            if let Err(bytes) = add_projected_bytes(&mut projected, additional, allocation_limit) {
                return Err(TransformFieldGrowthError {
                    op_index,
                    field,
                    bytes,
                });
            }
        }
        previous_end = matched.end();
    }
    if let Err(bytes) = add_projected_bytes(
        &mut projected,
        before.len().saturating_sub(previous_end),
        allocation_limit,
    ) {
        return Err(TransformFieldGrowthError {
            op_index,
            field,
            bytes,
        });
    }

    let after = regex.replace_all(before, replacement).into_owned();
    debug_assert_eq!(after.len(), projected);
    Ok(after)
}

/// 按序应用全部 ops，返回变换后的字段快照（纯函数，不修改输入）。
///
/// 每次 regex_replace 先做精确字节数预检（见
/// [`CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES`]），在级联放大分配内存前
/// 提前终止；触发时该卡整体拒绝（`Err`），不写库。
pub fn apply_transform_ops(
    ops: &[CompiledTransformOp],
    fields: &TransformFields,
) -> Result<TransformFields, TransformFieldGrowthError> {
    let mut result = fields.clone();
    for (op_index, op) in ops.iter().enumerate() {
        match op {
            CompiledTransformOp::RegexReplace {
                field,
                regex,
                replacement,
            } => match field {
                TransformField::Front => {
                    result.front = bounded_regex_replace(
                        op_index,
                        "front",
                        regex,
                        &result.front,
                        replacement,
                    )?;
                }
                TransformField::Back => {
                    result.back =
                        bounded_regex_replace(op_index, "back", regex, &result.back, replacement)?;
                }
                TransformField::Text => {
                    // text 为 null 的卡（非 Cloze 卡）自动跳过，不视为错误。
                    if let Some(text) = result.text.as_ref() {
                        result.text = Some(bounded_regex_replace(
                            op_index,
                            "text",
                            regex,
                            text,
                            replacement,
                        )?);
                    }
                }
            },
            CompiledTransformOp::TagAdd { tags } => {
                for tag in tags {
                    if !result.tags.iter().any(|existing| existing == tag) {
                        result.tags.push(tag.clone());
                    }
                }
            }
            CompiledTransformOp::TagRemove { tags } => {
                result.tags.retain(|existing| !tags.contains(existing));
            }
        }
    }
    Ok(result)
}

/// 变换前后字段级 diff（稳定顺序：front/back/text/tags）。
pub fn changed_field_names(before: &TransformFields, after: &TransformFields) -> Vec<&'static str> {
    let mut changed = Vec::new();
    if before.front != after.front {
        changed.push("front");
    }
    if before.back != after.back {
        changed.push("back");
    }
    if before.text != after.text {
        changed.push("text");
    }
    if before.tags != after.tags {
        changed.push("tags");
    }
    changed
}

/// 逐卡执行计划：ops 与 script 两种模式归一化后的公共形态。
/// 执行器据此走同一套 dry_run diff 与 apply CAS 写回路径。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransformCardPlan {
    /// 变换后的字段快照（可能与 before 相同 = 未变更）。
    After(TransformFields),
    /// 该卡计划非法（如脚本输出条目违反合同），apply 时逐卡拒绝、不整批失败。
    Invalid { code: &'static str, detail: String },
}

/// ops 模式：把编译后的操作序列应用到选择集，产出与 script 模式同构的逐卡计划。
/// 输出膨胀超限的卡产出 `Invalid`（逐卡拒绝，不整批失败，与 script 模式同构）。
pub fn plan_transform_ops(
    ops: &[CompiledTransformOp],
    selected: &[crate::models::AnkiCard],
) -> Vec<TransformCardPlan> {
    selected
        .iter()
        .map(
            |card| match apply_transform_ops(ops, &TransformFields::from_card(card)) {
                Ok(after) => TransformCardPlan::After(after),
                Err(growth) => TransformCardPlan::Invalid {
                    code: "field_growth_exceeded",
                    detail: growth.detail(),
                },
            },
        )
        .collect()
}

/// 与 `card_content_is_valid` 同语义：非空 Cloze text，或非空 front+back。
pub fn transform_fields_are_valid(fields: &TransformFields) -> bool {
    fields
        .text
        .as_deref()
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .is_some()
        || (!fields.front.trim().is_empty() && !fields.back.trim().is_empty())
}

// ============================================================================
// 选择集与 expectedVersions 校验
// ============================================================================

#[derive(Debug, PartialEq, Eq)]
pub enum TransformSelectionError {
    /// selection.cardIds 中存在文档快照里不存在（或已删除）的 ID。
    MissingCards(Vec<String>),
    /// 选择集超出快照上限。
    TooLarge { selected: usize, limit: usize },
}

/// 从文档全量卡片中解析选择集（保持文档内顺序）。
pub fn select_transform_cards(
    cards: Vec<crate::models::AnkiCard>,
    selection: &NormalizedTransformSelection,
) -> Result<Vec<crate::models::AnkiCard>, TransformSelectionError> {
    let selected: Vec<crate::models::AnkiCard> = match selection {
        NormalizedTransformSelection::DefaultLive => cards
            .into_iter()
            .filter(|card| !card.is_error_card)
            .collect(),
        NormalizedTransformSelection::Filter(filter) => cards
            .into_iter()
            .filter(|card| match filter {
                TransformFilter::All => true,
                TransformFilter::EditedOnly => card.updated_at != card.created_at,
                TransformFilter::ErrorOnly => card.is_error_card,
            })
            .collect(),
        NormalizedTransformSelection::Cards(card_ids) => {
            let wanted: HashSet<&str> = card_ids.iter().map(String::as_str).collect();
            let selected: Vec<crate::models::AnkiCard> = cards
                .into_iter()
                .filter(|card| wanted.contains(card.id.as_str()))
                .collect();
            let found: HashSet<&str> = selected.iter().map(|card| card.id.as_str()).collect();
            let mut missing: Vec<String> = card_ids
                .iter()
                .filter(|card_id| !found.contains(card_id.as_str()))
                .cloned()
                .collect();
            if !missing.is_empty() {
                missing.sort();
                return Err(TransformSelectionError::MissingCards(missing));
            }
            selected
        }
    };
    if selected.len() > CHATANKI_TRANSFORM_CARD_LIMIT {
        return Err(TransformSelectionError::TooLarge {
            selected: selected.len(),
            limit: CHATANKI_TRANSFORM_CARD_LIMIT,
        });
    }
    Ok(selected)
}

#[derive(Debug, PartialEq, Eq)]
pub struct ExpectedVersionsMismatch {
    /// 选择集中有卡但 expectedVersions 缺失。
    pub missing_version_ids: Vec<String>,
    /// expectedVersions 中有但不在选择集内。
    pub unexpected_version_ids: Vec<String>,
}

/// apply 模式的双保险校验：expectedVersions 必须与选择集精确一致
///（对齐 `retemplate` 的 `expected_versions_mismatch` 语义）。
pub fn check_expected_versions(
    selected_card_ids: &[String],
    expected_versions: &HashMap<String, String>,
) -> Result<(), ExpectedVersionsMismatch> {
    let selected: HashSet<&str> = selected_card_ids.iter().map(String::as_str).collect();
    let mut missing: Vec<String> = selected_card_ids
        .iter()
        .filter(|card_id| !expected_versions.contains_key(card_id.as_str()))
        .cloned()
        .collect();
    let mut unexpected: Vec<String> = expected_versions
        .keys()
        .filter(|card_id| !selected.contains(card_id.as_str()))
        .cloned()
        .collect();
    if missing.is_empty() && unexpected.is_empty() {
        return Ok(());
    }
    missing.sort();
    unexpected.sort();
    Err(ExpectedVersionsMismatch {
        missing_version_ids: missing,
        unexpected_version_ids: unexpected,
    })
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn parse(args: serde_json::Value) -> Result<NormalizedTransformRequest, String> {
        serde_json::from_value::<ChatAnkiTransformArgs>(args)
            .map_err(|error| error.to_string())
            .and_then(ChatAnkiTransformArgs::normalize)
    }

    fn fields(front: &str, back: &str, text: Option<&str>, tags: &[&str]) -> TransformFields {
        TransformFields {
            front: front.to_string(),
            back: back.to_string(),
            text: text.map(str::to_string),
            tags: tags.iter().map(|tag| tag.to_string()).collect(),
        }
    }

    fn make_card(id: &str, is_error: bool, edited: bool) -> crate::models::AnkiCard {
        let mut card = crate::models::AnkiCard {
            front: format!("front-{id}"),
            back: format!("back-{id}"),
            text: None,
            tags: vec![],
            images: vec![],
            id: id.to_string(),
            task_id: "task-1".to_string(),
            is_error_card: is_error,
            error_content: None,
            created_at: "2026-08-24T00:00:00Z".to_string(),
            updated_at: "2026-08-24T00:00:00Z".to_string(),
            extra_fields: Default::default(),
            template_id: None,
        };
        if edited {
            card.updated_at = "2026-08-24T01:00:00Z".to_string();
        }
        card
    }

    // ------------------------------------------------------------------
    // 参数归一化
    // ------------------------------------------------------------------

    #[test]
    fn normalize_rejects_script_and_ops_together() {
        let error = parse(json!({
            "documentId": "doc-1",
            "transform": {
                "script": { "language": "python", "code": "print(1)" },
                "ops": [{ "op": "tag_add", "tags": ["x"] }],
            },
        }))
        .unwrap_err();
        assert!(error.contains("mutually exclusive"), "{error}");
    }

    #[test]
    fn normalize_requires_script_or_ops() {
        let error = parse(json!({
            "documentId": "doc-1",
            "transform": {},
        }))
        .unwrap_err();
        assert!(error.contains("exactly one of script or ops"), "{error}");
    }

    #[test]
    fn normalize_script_mode_carries_language_code_and_default_timeout() {
        let request = parse(json!({
            "documentId": "doc-1",
            "transform": { "script": { "language": "python", "code": "print(1)" } },
        }))
        .unwrap();
        match &request.kind {
            NormalizedTransformKind::Script(script) => {
                assert_eq!(script.language.as_str(), "python");
                assert_eq!(script.code, "print(1)");
                assert_eq!(script.timeout, std::time::Duration::from_millis(30_000));
            }
            other => panic!("unexpected kind: {other:?}"),
        }
        assert_eq!(request.mode, TransformMode::DryRun);
    }

    #[test]
    fn normalize_script_mode_propagates_script_contract_errors() {
        let error = parse(json!({
            "documentId": "doc-1",
            "transform": { "script": { "language": "python", "code": "  " } },
        }))
        .unwrap_err();
        assert!(error.contains("must not be empty"), "{error}");

        let error = parse(json!({
            "documentId": "doc-1",
            "transform": { "script": { "language": "python", "code": "1", "timeoutMs": 500 } },
        }))
        .unwrap_err();
        assert!(error.contains("1000..=120000"), "{error}");
    }

    #[test]
    fn plan_transform_ops_produces_after_plans_in_selection_order() {
        let ops = vec![NormalizedTransformOp::TagAdd {
            tags: vec!["新".to_string()],
        }];
        let compiled = compile_transform_ops(&ops).unwrap();
        let cards = vec![
            make_card("card-1", false, false),
            make_card("card-2", false, false),
        ];
        let plans = plan_transform_ops(&compiled, &cards);
        assert_eq!(plans.len(), 2);
        for plan in &plans {
            match plan {
                TransformCardPlan::After(after) => {
                    assert_eq!(after.tags, vec!["新".to_string()]);
                }
                other => panic!("unexpected plan: {other:?}"),
            }
        }
    }

    #[test]
    fn normalize_defaults_to_dry_run_and_default_live_selection() {
        let request = parse(json!({
            "documentId": " doc-1 ",
            "transform": { "ops": [{ "op": "tag_add", "tags": [" 复习 ", "复习"] }] },
        }))
        .unwrap();
        assert_eq!(request.document_id, "doc-1");
        assert_eq!(request.mode, TransformMode::DryRun);
        assert_eq!(request.selection, NormalizedTransformSelection::DefaultLive);
        assert!(request.expected_versions.is_empty());
        match &request.kind {
            NormalizedTransformKind::Ops(ops) => {
                assert_eq!(
                    ops,
                    &vec![NormalizedTransformOp::TagAdd {
                        tags: vec!["复习".to_string()],
                    }]
                );
            }
            other => panic!("unexpected kind: {other:?}"),
        }
    }

    #[test]
    fn normalize_apply_requires_expected_versions() {
        let error = parse(json!({
            "documentId": "doc-1",
            "mode": "apply",
            "transform": { "ops": [{ "op": "tag_add", "tags": ["x"] }] },
        }))
        .unwrap_err();
        assert!(error.contains("requires expectedVersions"), "{error}");

        let error = parse(json!({
            "documentId": "doc-1",
            "mode": "apply",
            "expectedVersions": {},
            "transform": { "ops": [{ "op": "tag_add", "tags": ["x"] }] },
        }))
        .unwrap_err();
        assert!(error.contains("requires expectedVersions"), "{error}");
    }

    #[test]
    fn normalize_apply_trims_expected_versions_and_rejects_duplicates() {
        let request = parse(json!({
            "documentId": "doc-1",
            "mode": "apply",
            "expectedVersions": { " card-1 ": " v1 " },
            "transform": { "ops": [{ "op": "tag_add", "tags": ["x"] }] },
        }))
        .unwrap();
        assert_eq!(
            request.expected_versions.get("card-1"),
            Some(&"v1".to_string())
        );

        let error = parse(json!({
            "documentId": "doc-1",
            "mode": "apply",
            "expectedVersions": { "card-1": "v1", " card-1 ": "v2" },
            "transform": { "ops": [{ "op": "tag_add", "tags": ["x"] }] },
        }))
        .unwrap_err();
        assert!(error.contains("duplicate normalized card IDs"), "{error}");
    }

    #[test]
    fn normalize_selection_card_ids_and_filter_are_exclusive() {
        let error = parse(json!({
            "documentId": "doc-1",
            "selection": { "cardIds": ["card-1"], "filter": "all" },
            "transform": { "ops": [{ "op": "tag_add", "tags": ["x"] }] },
        }))
        .unwrap_err();
        assert!(error.contains("mutually exclusive"), "{error}");

        let error = parse(json!({
            "documentId": "doc-1",
            "selection": {},
            "transform": { "ops": [{ "op": "tag_add", "tags": ["x"] }] },
        }))
        .unwrap_err();
        assert!(error.contains("selection requires"), "{error}");
    }

    #[test]
    fn normalize_selection_rejects_duplicate_card_ids() {
        let error = parse(json!({
            "documentId": "doc-1",
            "selection": { "cardIds": ["card-1", " card-1 "] },
            "transform": { "ops": [{ "op": "tag_add", "tags": ["x"] }] },
        }))
        .unwrap_err();
        assert!(error.contains("duplicate IDs"), "{error}");
    }

    #[test]
    fn normalize_rejects_unknown_op() {
        let result = serde_json::from_value::<ChatAnkiTransformArgs>(json!({
            "documentId": "doc-1",
            "transform": { "ops": [{ "op": "cloze_wrap", "field": "text", "pattern": "x" }] },
        }));
        let error = result.unwrap_err().to_string();
        assert!(error.contains("unknown variant"), "{error}");
    }

    #[test]
    fn normalize_regex_replace_requires_field_and_pattern() {
        let error = parse(json!({
            "documentId": "doc-1",
            "transform": { "ops": [{ "op": "regex_replace", "pattern": "x" }] },
        }))
        .unwrap_err();
        assert!(error.contains("requires field"), "{error}");

        let error = parse(json!({
            "documentId": "doc-1",
            "transform": { "ops": [{ "op": "regex_replace", "field": "front" }] },
        }))
        .unwrap_err();
        assert!(error.contains("non-empty pattern"), "{error}");
    }

    #[test]
    fn normalize_tag_ops_reject_regex_parameters() {
        let error = parse(json!({
            "documentId": "doc-1",
            "transform": { "ops": [{ "op": "tag_remove", "tags": ["x"], "pattern": "y" }] },
        }))
        .unwrap_err();
        assert!(error.contains("only accept the tags parameter"), "{error}");
    }

    #[test]
    fn normalize_enforces_ops_limit() {
        let ops: Vec<_> = (0..(CHATANKI_TRANSFORM_OPS_LIMIT + 1))
            .map(|index| json!({ "op": "tag_add", "tags": [format!("tag-{index}")] }))
            .collect();
        let error = parse(json!({
            "documentId": "doc-1",
            "transform": { "ops": ops },
        }))
        .unwrap_err();
        assert!(error.contains("1..=20"), "{error}");
    }

    // ------------------------------------------------------------------
    // ops 引擎
    // ------------------------------------------------------------------

    #[test]
    fn regex_replace_supports_capture_groups() {
        let ops = vec![NormalizedTransformOp::RegexReplace {
            field: TransformField::Back,
            pattern: r"(\d+)ms".to_string(),
            replacement: "$1 毫秒".to_string(),
        }];
        let compiled = compile_transform_ops(&ops).unwrap();
        let before = fields("Q", "耗时 30ms 与 45ms", None, &[]);
        let after = apply_transform_ops(&compiled, &before).unwrap();
        assert_eq!(after.back, "耗时 30 毫秒 与 45 毫秒");
        assert_eq!(changed_field_names(&before, &after), vec!["back"]);
    }

    #[test]
    fn regex_replace_on_null_text_is_noop() {
        let ops = vec![NormalizedTransformOp::RegexReplace {
            field: TransformField::Text,
            pattern: "term".to_string(),
            replacement: "{{c1::term}}".to_string(),
        }];
        let compiled = compile_transform_ops(&ops).unwrap();
        let before = fields("Q", "A", None, &[]);
        let after = apply_transform_ops(&compiled, &before).unwrap();
        assert_eq!(before, after);
        assert!(changed_field_names(&before, &after).is_empty());
    }

    #[test]
    fn invalid_pattern_reports_op_index() {
        let ops = vec![
            NormalizedTransformOp::TagAdd {
                tags: vec!["ok".to_string()],
            },
            NormalizedTransformOp::RegexReplace {
                field: TransformField::Front,
                pattern: "(unclosed".to_string(),
                replacement: String::new(),
            },
        ];
        let error = compile_transform_ops(&ops).unwrap_err();
        assert_eq!(error.op_index, 1);
        assert_eq!(error.pattern, "(unclosed");
        assert!(!error.error.is_empty());
    }

    #[test]
    fn tag_add_deduplicates_and_tag_remove_deletes() {
        let ops = vec![
            NormalizedTransformOp::TagAdd {
                tags: vec!["生物".to_string(), "重点".to_string()],
            },
            NormalizedTransformOp::TagRemove {
                tags: vec!["草稿".to_string()],
            },
        ];
        let compiled = compile_transform_ops(&ops).unwrap();
        let before = fields("Q", "A", None, &["生物", "草稿"]);
        let after = apply_transform_ops(&compiled, &before).unwrap();
        assert_eq!(after.tags, vec!["生物".to_string(), "重点".to_string()]);
        assert_eq!(changed_field_names(&before, &after), vec!["tags"]);
    }

    #[test]
    fn ops_apply_in_declared_order() {
        let ops = vec![
            NormalizedTransformOp::RegexReplace {
                field: TransformField::Front,
                pattern: "cat".to_string(),
                replacement: "dog".to_string(),
            },
            NormalizedTransformOp::RegexReplace {
                field: TransformField::Front,
                pattern: "dog".to_string(),
                replacement: "wolf".to_string(),
            },
        ];
        let compiled = compile_transform_ops(&ops).unwrap();
        let before = fields("cat", "A", None, &[]);
        let after = apply_transform_ops(&compiled, &before).unwrap();
        assert_eq!(after.front, "wolf");
    }

    #[test]
    fn bounded_replace_preserves_regex_capture_expansion_semantics() {
        let ops = vec![NormalizedTransformOp::RegexReplace {
            field: TransformField::Front,
            pattern: "(?P<letter>[a-z])|(?P<number>[0-9])".to_string(),
            replacement: "${letter}${number}$$".to_string(),
        }];
        let compiled = compile_transform_ops(&ops).unwrap();
        let before = fields("ab12", "A", None, &[]);
        let after = apply_transform_ops(&compiled, &before).unwrap();
        assert_eq!(after.front, "a$b$1$2$");
    }

    // ------------------------------------------------------------------
    // Round 4 安全复审：regex 输出膨胀炸弹与 tag 资源边界
    // ------------------------------------------------------------------

    /// 安全回归：必须在 `replace_all` 分配结果前拒绝。旧实现会先尝试物化
    /// 1 MiB × 4096（约 4 GiB）的字符串，事后检查来不及阻止 OOM。
    #[test]
    fn security_regex_growth_is_rejected_before_result_allocation() {
        let ops = vec![NormalizedTransformOp::RegexReplace {
            field: TransformField::Front,
            pattern: "(?s).".to_string(),
            replacement: "x".repeat(CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN),
        }];
        let compiled = compile_transform_ops(&ops).unwrap();
        let before = fields(
            &"a".repeat(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES),
            "A",
            None,
            &[],
        );
        let error = apply_transform_ops(&compiled, &before).unwrap_err();
        assert_eq!(error.op_index, 0);
        assert_eq!(error.field, "front");
        assert!(error.bytes > CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES);
    }

    /// 安全回归：`(?s).` + 长替换串的级联放大在第一次超限时逐卡拦截，
    /// 不物化天文数字大小的字符串（内存 DoS）。
    #[test]
    fn security_regex_growth_bomb_is_blocked_per_card() {
        let ops = vec![
            NormalizedTransformOp::RegexReplace {
                field: TransformField::Front,
                pattern: "(?s).".to_string(),
                replacement: "y".repeat(CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN),
            },
            // 若第一个 op 未被拦截，此 op 会试图物化 ~4096^2 倍的字符串
            NormalizedTransformOp::RegexReplace {
                field: TransformField::Front,
                pattern: "(?s).".to_string(),
                replacement: "z".repeat(CHATANKI_TRANSFORM_REPLACEMENT_MAX_LEN),
            },
        ];
        let compiled = compile_transform_ops(&ops).unwrap();
        let mut bomb_card = make_card("card-bomb", false, false);
        bomb_card.front = "x".repeat(4096);
        let mut tiny_card = make_card("card-tiny", false, false);
        tiny_card.front = "ok".to_string();

        let plans = plan_transform_ops(&compiled, &[bomb_card, tiny_card]);
        match &plans[0] {
            TransformCardPlan::Invalid { code, detail } => {
                assert_eq!(*code, "field_growth_exceeded");
                assert!(detail.contains("ops[0]"), "{detail}");
                assert!(detail.contains("front"), "{detail}");
            }
            other => panic!("expected Invalid plan, got {other:?}"),
        }
        // 小卡第一次放大后未超限，第二次放大（2*4096*4096 字节）超限 → ops[1] 拦截
        match &plans[1] {
            TransformCardPlan::Invalid { code, detail } => {
                assert_eq!(*code, "field_growth_exceeded");
                assert!(detail.contains("ops[1]"), "{detail}");
            }
            other => panic!("expected Invalid plan, got {other:?}"),
        }
    }

    /// 安全回归：存量超长字段的收缩/未膨胀改写不受膨胀闸门误伤。
    #[test]
    fn security_shrinking_or_keeping_oversized_field_is_allowed() {
        let ops = vec![NormalizedTransformOp::RegexReplace {
            field: TransformField::Back,
            pattern: "x{100}".to_string(),
            replacement: "x".to_string(),
        }];
        let compiled = compile_transform_ops(&ops).unwrap();
        let oversized = "x".repeat(CHATANKI_TRANSFORM_FIELD_GROWTH_MAX_BYTES + 4096);
        let before = fields("Q", &oversized, None, &[]);
        let after = apply_transform_ops(&compiled, &before).unwrap();
        assert!(after.back.len() < before.back.len(), "shrink must apply");

        // 未命中 pattern（结果与输入等长）也不触发闸门
        let noop_ops = vec![NormalizedTransformOp::RegexReplace {
            field: TransformField::Back,
            pattern: "never-matches-9f8e7d".to_string(),
            replacement: "y".to_string(),
        }];
        let compiled = compile_transform_ops(&noop_ops).unwrap();
        let after = apply_transform_ops(&compiled, &before).unwrap();
        assert_eq!(after.back, before.back);
    }

    /// 安全回归：单个超长 tag 在参数归一化层拒绝。
    #[test]
    fn security_normalize_rejects_overlong_tag() {
        let overlong = "t".repeat(CHATANKI_TRANSFORM_TAG_MAX_CHARS + 1);
        let error = parse(json!({
            "documentId": "doc-1",
            "transform": { "ops": [{ "op": "tag_add", "tags": [overlong] }] },
        }))
        .unwrap_err();
        assert!(error.contains("must not exceed"), "{error}");
    }

    #[test]
    fn transform_fields_validity_matches_card_content_rules() {
        assert!(transform_fields_are_valid(&fields("Q", "A", None, &[])));
        assert!(transform_fields_are_valid(&fields(
            "",
            "",
            Some("{{c1::x}}"),
            &[]
        )));
        assert!(!transform_fields_are_valid(&fields("Q", "", None, &[])));
        assert!(!transform_fields_are_valid(&fields(
            "",
            "",
            Some("  "),
            &[]
        )));
    }

    // ------------------------------------------------------------------
    // 选择集与 expectedVersions
    // ------------------------------------------------------------------

    #[test]
    fn default_selection_excludes_error_cards() {
        let cards = vec![
            make_card("card-1", false, false),
            make_card("card-2", true, false),
        ];
        let selected =
            select_transform_cards(cards, &NormalizedTransformSelection::DefaultLive).unwrap();
        assert_eq!(selected.len(), 1);
        assert_eq!(selected[0].id, "card-1");
    }

    #[test]
    fn filter_selection_matches_get_cards_semantics() {
        let cards = vec![
            make_card("card-1", false, false),
            make_card("card-2", true, false),
            make_card("card-3", false, true),
        ];
        let all = select_transform_cards(
            cards.clone(),
            &NormalizedTransformSelection::Filter(TransformFilter::All),
        )
        .unwrap();
        assert_eq!(all.len(), 3);

        let edited = select_transform_cards(
            cards.clone(),
            &NormalizedTransformSelection::Filter(TransformFilter::EditedOnly),
        )
        .unwrap();
        assert_eq!(edited.len(), 1);
        assert_eq!(edited[0].id, "card-3");

        let errors = select_transform_cards(
            cards,
            &NormalizedTransformSelection::Filter(TransformFilter::ErrorOnly),
        )
        .unwrap();
        assert_eq!(errors.len(), 1);
        assert_eq!(errors[0].id, "card-2");
    }

    #[test]
    fn card_ids_selection_reports_missing_ids() {
        let cards = vec![make_card("card-1", false, false)];
        let error = select_transform_cards(
            cards,
            &NormalizedTransformSelection::Cards(vec![
                "card-1".to_string(),
                "card-ghost".to_string(),
            ]),
        )
        .unwrap_err();
        assert_eq!(
            error,
            TransformSelectionError::MissingCards(vec!["card-ghost".to_string()])
        );
    }

    #[test]
    fn expected_versions_must_match_selection_exactly() {
        let selected = vec!["card-1".to_string(), "card-2".to_string()];
        let mut expected = HashMap::new();
        expected.insert("card-2".to_string(), "v1".to_string());
        expected.insert("card-3".to_string(), "v1".to_string());
        let mismatch = check_expected_versions(&selected, &expected).unwrap_err();
        assert_eq!(mismatch.missing_version_ids, vec!["card-1".to_string()]);
        assert_eq!(mismatch.unexpected_version_ids, vec!["card-3".to_string()]);

        let mut exact = HashMap::new();
        exact.insert("card-1".to_string(), "v1".to_string());
        exact.insert("card-2".to_string(), "v2".to_string());
        assert!(check_expected_versions(&selected, &exact).is_ok());
    }
}
