//! # 生成后 Grounded judge / LLM critic pass（opt-in，默认关闭）
//!
//! Round 4 #2：任务级批量 critic。流式制卡任务收尾（`Ok(stats)`）后，
//! 对该任务已入库的全部非错误卡做**一次** JSON 裁决（Round 5 #6 起模型经
//! Sidekick 分层路由取 Critic 槽，缺槽/失败自动回退旧 model2 路径），
//! 以任务的 `content_segment`（源材料）为对照，判定三类问题：
//!
//! 1. **事实性**（grounded）：卡片答案与源材料矛盾 / 无中生有；
//! 2. **最小信息原则**：一卡多事实、front 过载、空泛提问；
//! 3. **重复**：同批语义重复卡。
//!
//! ## 裁决协议（verdict）
//!
//! 模型对每张卡输出 `keep | revise | flag`：
//!
//! - `keep`：不动；
//! - `revise`：用模型给出的 `revised` 字段重写卡片，走既有
//!   `Database::update_anki_card_rows` 持久化（id/task_id 永不变更），
//!   并写入 `_qa_flags` 审计条目 `llm_critic_revised`；
//! - `flag`：仅在 `extra_fields["_qa_flags"]` 追加 `llm_critic` 条目留痕，
//!   卡片内容不动（与 `anki_qa_lint` 的 Flag 语义一致，绝不丢卡）。
//!
//! ## 设计硬约束
//!
//! - **默认关闭**：`CriticOptions::from_options_json` 解析同一份
//!   `anki_generation_options_json`（serde-default 二次解析，模式与
//!   `anki_protocol::StructuredOutputOptions` 相同——不能给
//!   `AnkiGenerationOptions` 加字段，禁改文件以穷举字面量构造它）。
//!   `enable_critic_pass` / `enable_llm_critic`（别名）缺省即 false。
//! - **LLM 失败必须降级**：模型调用失败/超时/JSON 解析失败时，
//!   `run_critic_pass` 返回 `degraded` 摘要，全部卡片视同 keep，
//!   **绝不**让 critic 失败拖垮整批制卡（编排器永不向上抛错）。
//! - **越权改 id 拒绝**：裁决中出现不属于本任务的 card_id 一律丢弃并计数；
//!   `revised` 载荷中的 id/task_id 字段被解析层直接忽略。
//! - **token 预算**：prompt 按字符预算裁剪（源材料截断、单字段截断、
//!   超预算卡片跳过并计数），预算可经 `critic_token_budget` 从 options JSON 下发。
//! - **最多修订轮 1**：critic 每任务只跑一轮，revise 后的卡不再复审；
//!   `CriticConfig::max_revision_rounds` 被硬钳位到 1。
//! - **grounded 同源金标（Round 5 #4）**：[`collect_gold_references`] 经
//!   `anki_gold_set` 挖掘同文档兄弟卡的用户修正记录（改前 = 劣化、
//!   改后 = 金标），注入 0-N 对 [`ReferenceCard`]；有金标时 prompt 切换为
//!   对照金标评审（金标区受独立字符预算与对数上限截断，绝不挤占待评审卡），
//!   无金标时保持内置规则 rubric（事实性/最小信息/重复，对齐
//!   agents/card-qa.md 维度）。收集失败退化为空列表，绝不拖垮制卡收尾。

use crate::anki_qa_lint::{self, LintIssue, LintSeverity};
use crate::database::Database;
use crate::llm_manager::LLMManager;
use crate::models::{AnkiCard, DocumentTask};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashSet;
use std::time::Duration;
use tracing::{info, warn};

/// critic 裁决的 `_qa_flags` 条目 code（flag 裁决留痕）。
pub const CRITIC_FLAG_CODE: &str = "llm_critic";
/// revise 裁决写入的审计条目 code（前端 QA 面板可按码过滤）。
pub const CRITIC_REVISED_CODE: &str = "llm_critic_revised";
/// 修订轮硬上限：revise 后的卡不再复审（成本与收敛性约束）。
pub const MAX_REVISION_ROUNDS_HARD_CAP: u32 = 1;
/// 模型调用防悬挂超时（秒）：超时按降级处理，不阻塞任务收尾。
const CRITIC_MODEL_TIMEOUT_SECS: u64 = 180;

// ============================================================================
// 选项（对 options JSON 做 serde-default 二次解析，默认关闭）
// ============================================================================

/// critic 的 wire 选项。与 `StructuredOutputOptions` 同模式：
/// 对 `anki_generation_options_json` 做独立的 serde-default 解析，
/// 未知字段忽略、解析失败视同全默认（= 关闭）。
#[derive(Debug, Clone, Default, Deserialize)]
pub struct CriticOptions {
    /// 主开关名（与 `enable_qa_pass` 命名对齐）。缺省 false = 关闭。
    #[serde(default)]
    pub enable_critic_pass: Option<bool>,
    /// 别名开关（容忍前端/技能层用另一命名透出；任一为 true 即启用）。
    #[serde(default)]
    pub enable_llm_critic: Option<bool>,
    /// token 预算（估算值，内部换算为字符预算）。缺省用 `CriticConfig` 默认。
    #[serde(default)]
    pub critic_token_budget: Option<u32>,
}

impl CriticOptions {
    /// 从 options JSON 解析；解析失败返回全默认（critic 关闭），不报错。
    pub fn from_options_json(options_json: &str) -> Self {
        serde_json::from_str(options_json).unwrap_or_default()
    }

    /// 是否启用 critic。**默认 false（opt-in）**。
    pub fn critic_enabled(&self) -> bool {
        self.enable_critic_pass.unwrap_or(false) || self.enable_llm_critic.unwrap_or(false)
    }

    /// 折算出本次运行的配置（应用 token 预算覆盖）。
    pub fn to_config(&self) -> CriticConfig {
        let mut cfg = CriticConfig::default();
        if let Some(budget) = self.critic_token_budget {
            // 粗粒度换算：1 token ≈ 2 字符（中英混排偏保守），下限防止预算过小饿死 prompt
            cfg.max_prompt_chars = (budget as usize).saturating_mul(2).max(2_000);
        }
        cfg
    }
}

// ============================================================================
// 配置
// ============================================================================

/// critic 运行配置（全部有默认值；`max_revision_rounds` 硬钳位到 1）。
#[derive(Debug, Clone)]
pub struct CriticConfig {
    /// prompt 总字符预算（源材料 + 卡片清单 + rubric 固定文案）。
    pub max_prompt_chars: usize,
    /// 源材料 `content_segment` 摘录上限（字符）。
    pub max_segment_chars: usize,
    /// 单字段（front/back/text）进入 prompt 的截断长度（字符）。
    pub max_field_chars: usize,
    /// 单次 critic 调用最多评审的卡片数（超出者跳过并计数）。
    pub max_cards_per_call: usize,
    /// 修订轮数（请求值；实际生效值经 [`CriticConfig::effective_revision_rounds`] 钳位）。
    pub max_revision_rounds: u32,
    /// 注入 prompt 的同源金标修正对上限（超出者截断并计数）。
    pub max_reference_pairs: usize,
    /// 金标参照区的字符预算。实际生效值还会被钳位到
    /// `max_prompt_chars / 3`——金标绝不允许把待评审卡片挤出预算。
    pub max_reference_chars: usize,
}

impl Default for CriticConfig {
    fn default() -> Self {
        Self {
            max_prompt_chars: 24_000,
            max_segment_chars: 8_000,
            max_field_chars: 600,
            max_cards_per_call: 40,
            max_revision_rounds: 1,
            max_reference_pairs: 6,
            max_reference_chars: 6_000,
        }
    }
}

impl CriticConfig {
    /// 实际生效的修订轮数：`min(请求值, 硬上限 1)`。0 表示 critic 空转（不调模型）。
    pub fn effective_revision_rounds(&self) -> u32 {
        self.max_revision_rounds.min(MAX_REVISION_ROUNDS_HARD_CAP)
    }
}

// ============================================================================
// Grounded 参照卡（Round 5 #4：接通 anki_gold_set 挖掘出的同源修正对）
// ============================================================================

/// 金标参照卡。`front`/`back` 是金标（改后）内容；`degraded_front`/
/// `degraded_back` 可选携带同一张卡被用户修掉的劣化（改前）版本——
/// 「改前 = 劣化、改后 = 金标」正是 `anki_gold_set` 修正对的语义。
///
/// 来源两路：
/// - 生产收尾路径：[`collect_gold_references`] 从同一文档的**同源**兄弟卡
///   （其他任务已生成、被用户编辑过、带 `_original_generation` 快照）挖掘；
/// - 评测 harness / 教师标注：直接构造注入。
///
/// 注入 0 对时 critic 保持内置规则 rubric（行为与接通前完全一致）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceCard {
    /// 金标（改后）问题面。
    pub front: String,
    /// 金标（改后）答案面。
    pub back: String,
    /// 劣化（改前）问题面；None = 纯金标示例（无对照劣化版本）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degraded_front: Option<String>,
    /// 劣化（改前）答案面。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub degraded_back: Option<String>,
}

/// Cloze 快照的 text 字段并入答案面展示（prompt 里不单列 text 行）。
fn snapshot_back_for_prompt(s: &crate::anki_gold_set::CardSnapshot) -> String {
    match s.text.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) if s.back.trim().is_empty() => t.to_string(),
        Some(t) => format!("{}（Cloze: {}）", s.back, t),
        None => s.back.clone(),
    }
}

impl ReferenceCard {
    /// 由 `anki_gold_set` 修正对构造：`edited` → 金标面，`original` → 劣化面。
    /// original 为全空快照时不携带劣化面（退化为纯金标示例）。
    pub fn from_repair_pair(pair: &crate::anki_gold_set::RepairPair) -> Self {
        let degraded_front = Some(pair.original.front.clone())
            .filter(|_| !snapshot_is_blank(&pair.original));
        let degraded_back = Some(snapshot_back_for_prompt(&pair.original))
            .filter(|_| !snapshot_is_blank(&pair.original));
        Self {
            front: pair.edited.front.clone(),
            back: snapshot_back_for_prompt(&pair.edited),
            degraded_front,
            degraded_back,
        }
    }
}

fn snapshot_is_blank(s: &crate::anki_gold_set::CardSnapshot) -> bool {
    s.front.trim().is_empty()
        && s.back.trim().is_empty()
        && s.text.as_deref().map(str::trim).unwrap_or("").is_empty()
}

// ============================================================================
// 裁决结构
// ============================================================================

/// 单卡裁决动作。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Verdict {
    Keep,
    Revise,
    Flag,
}

/// revise 裁决的字段载荷。**不含 id/task_id**——模型没有改主键的权限，
/// 响应里即便夹带也会被 serde 忽略（`deny_unknown_fields` 故意不开：
/// 忽略而非报错，避免模型多吐一个无害字段就废掉整批裁决）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct RevisedFields {
    #[serde(default)]
    pub front: Option<String>,
    #[serde(default)]
    pub back: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
}

impl RevisedFields {
    /// 是否携带至少一个非空修订字段。
    fn has_content(&self) -> bool {
        [&self.front, &self.back, &self.text]
            .iter()
            .any(|f| f.as_deref().map(str::trim).is_some_and(|s| !s.is_empty()))
    }
}

/// 单卡裁决（解析并通过 id 白名单校验后的形态）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardVerdict {
    pub card_id: String,
    pub verdict: Verdict,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub revised: Option<RevisedFields>,
}

/// 解析结果：合法裁决 + 越权/非法条目计数。
#[derive(Debug, Clone, Default)]
pub struct ParsedVerdicts {
    pub verdicts: Vec<CardVerdict>,
    /// card_id 不在本任务白名单内、被拒绝的裁决数（越权改 id 拒绝）。
    pub rejected_unknown_ids: u32,
    /// verdict 值非法（非 keep/revise/flag）被丢弃的条目数。
    pub rejected_invalid: u32,
}

/// 任务级 critic 摘要（发给前端的事件载荷，同时用于日志）。
#[derive(Debug, Clone, Default, Serialize)]
pub struct CriticSummary {
    /// 进入 prompt 被评审的卡片数。
    pub examined: u32,
    pub kept: u32,
    pub revised: u32,
    pub flagged: u32,
    /// 越权 card_id 被拒绝的裁决数。
    pub rejected_unknown_ids: u32,
    /// 因 token 预算 / 单次上限被跳过未评审的卡片数。
    pub skipped_over_budget: u32,
    /// 实际注入 prompt 的同源金标参照对数（0 = 规则 rubric 模式）。
    pub gold_references: u32,
    /// 因预算/上限被截断未注入的金标参照对数。
    pub gold_references_truncated: u32,
    /// 持久化失败（update 未命中行等）的卡片数。
    pub persist_failures: u32,
    /// 非 None 表示本次 critic 降级（模型失败/超时/解析失败），全部卡片视同 keep。
    pub degraded: Option<String>,
    // ---- Sidekick 模型分层路由观测（Round 5 #6，None 时不序列化保持旧 wire 格式） ----
    /// critic 路由到的模型配置 id（None = 路由不可用，走旧 model2 路径）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routed_config_id: Option<String>,
    /// critic 路由到的模型名。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routed_model: Option<String>,
    /// 路由决策是否为降级（首选主模型槽缺失，落到了其他槽位的同一模型）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routed_degraded: Option<bool>,
}

/// 将 Sidekick 路由决策写入摘要（纯函数便于单测；`None` 时字段保持缺省，
/// 序列化结果与路由接通前完全一致）。
pub fn note_routing_decision(
    summary: &mut CriticSummary,
    decision: Option<&crate::anki_model_routing::RoleDecision>,
) {
    if let Some(d) = decision {
        summary.routed_config_id = Some(d.config_id.clone());
        summary.routed_model = Some(d.model.clone());
        summary.routed_degraded = Some(d.degraded);
    }
}

// ============================================================================
// Prompt 构建（token 预算在这里落地）
// ============================================================================

/// prompt 构建产物：文本 + 实际纳入评审的卡片 + 预算裁剪计数。
#[derive(Debug)]
pub struct CriticPrompt {
    pub text: String,
    /// 按纳入顺序排列的卡片 id（= 白名单）。
    pub included_ids: Vec<String>,
    pub skipped_over_budget: u32,
    /// 实际注入 prompt 的同源金标参照对数（0 = 规则 rubric 模式）。
    pub included_references: u32,
    /// 因对数上限 / 参照区字符预算被截断的金标对数。
    pub skipped_references: u32,
}

fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let head: String = s.chars().take(max).collect();
    format!("{}…(截断)", head)
}

/// 规则 rubric（无金标时使用）。维度对齐 `agents/card-qa.md` 的 D/G 系列
/// 与本仓 `anki_qa_lint` 的最小信息原则规则。
const RULE_RUBRIC: &str = "\
评审 rubric（无金标参照，按以下规则裁决）：\n\
1. 事实性：卡片答案与【源材料】矛盾、或包含源材料中不存在且无法从中推出的断言 → revise（能依据源材料修正时）或 flag（无法确证时，不要凭空改写）。\n\
2. 最小信息原则：一卡同时考察多个独立事实、front 空泛（\"简述/谈谈 X\"）、back 明显过载 → revise 收窄为单一可判定问题；无法安全收窄时 flag。\n\
3. 重复：同批内两张卡考察同一事实（措辞不同也算）→ 保留信息更完整的一张 keep，另一张 flag（理由注明与哪张重复）。不要用 revise 合并卡片。\n\
4. 拿不准时一律 keep。宁可漏报，不可误改。";

/// 构建任务级批量 critic prompt。
///
/// 预算策略（字符近似 token）：先放固定 rubric 与源材料摘录
/// （`max_segment_chars` 截断），再逐卡追加（单字段 `max_field_chars` 截断），
/// 超过 `max_prompt_chars` 或 `max_cards_per_call` 即停止并计数跳过。
pub fn build_critic_prompt(
    content_segment: &str,
    cards: &[AnkiCard],
    references: &[ReferenceCard],
    cfg: &CriticConfig,
) -> CriticPrompt {
    let mut text = String::new();
    text.push_str("你是 Anki 卡片质检裁判（grounded judge）。对下列已生成的卡片逐张裁决。\n\n");

    // 金标参照区先在独立缓冲里按预算构建：全部被截断时干净地退回规则 rubric，
    // 不会留下一个空的"对照金标"段落。
    let mut ref_section = String::new();
    let mut included_references: u32 = 0;
    let mut skipped_references: u32 = 0;
    if !references.is_empty() {
        // 金标区预算：显式配置与总预算 1/3 取小——金标绝不挤占待评审卡片
        let ref_budget = cfg.max_reference_chars.min(cfg.max_prompt_chars / 3);
        for r in references {
            if (included_references as usize) >= cfg.max_reference_pairs {
                skipped_references += 1;
                continue;
            }
            let mut entry = String::new();
            let idx = included_references + 1;
            match (r.degraded_front.as_deref(), r.degraded_back.as_deref()) {
                (Some(df), db) => {
                    entry.push_str(&format!(
                        "{}. 改前(劣化) Q: {}\n   改前(劣化) A: {}\n",
                        idx,
                        truncate_chars(df, cfg.max_field_chars),
                        truncate_chars(db.unwrap_or(""), cfg.max_field_chars)
                    ));
                    entry.push_str(&format!(
                        "   改后(金标) Q: {}\n   改后(金标) A: {}\n",
                        truncate_chars(&r.front, cfg.max_field_chars),
                        truncate_chars(&r.back, cfg.max_field_chars)
                    ));
                }
                (None, _) => {
                    entry.push_str(&format!(
                        "{}. 金标 Q: {}\n   金标 A: {}\n",
                        idx,
                        truncate_chars(&r.front, cfg.max_field_chars),
                        truncate_chars(&r.back, cfg.max_field_chars)
                    ));
                }
            }
            if ref_section.chars().count() + entry.chars().count() > ref_budget {
                skipped_references += 1;
                continue;
            }
            ref_section.push_str(&entry);
            included_references += 1;
        }
    }

    if included_references > 0 {
        text.push_str(
            "评审模式：对照同源金标。以下【同源金标参照】来自同一文档的真实用户修正记录：\
             「改前(劣化)」是曾被生成、后被用户修掉的劣化版本；「改后(金标)」是用户留下的标准卡。\
             以金标的事实与粒度为基准裁决待评审卡片：出现与「改前(劣化)」同类缺陷的卡片，\
             或与金标事实矛盾的卡片，必须 revise（能依据源材料与金标修正时）或 flag（无法确证时）。\
             同批语义重复卡保留信息更完整的一张，另一张 flag。拿不准时一律 keep，宁可漏报，不可误改。\n\n【同源金标参照】\n",
        );
        text.push_str(&ref_section);
    } else {
        text.push_str(RULE_RUBRIC);
    }

    text.push_str("\n\n【源材料】\n");
    text.push_str(&truncate_chars(content_segment, cfg.max_segment_chars));

    text.push_str(
        "\n\n【输出格式】只输出一个 JSON 对象，不要任何其他文字：\n\
         {\"verdicts\":[{\"card_id\":\"<必须原样复制下方卡片的 id，禁止编造>\",\
         \"verdict\":\"keep|revise|flag\",\"reasons\":[\"简短理由\"],\
         \"revised\":{\"front\":\"...\",\"back\":\"...\",\"text\":\"...\"}}]}\n\
         规则：verdict=revise 时必须给 revised（只含需要改的字段）；\
         keep/flag 不给 revised；每张卡恰好一条裁决；不得输出列表之外的 card_id。\n\n【待评审卡片】\n",
    );

    let mut included_ids: Vec<String> = Vec::new();
    let mut skipped: u32 = 0;
    for card in cards {
        if included_ids.len() >= cfg.max_cards_per_call {
            skipped += 1;
            continue;
        }
        let mut entry = format!(
            "- id: {}\n  front: {}\n  back: {}\n",
            card.id,
            truncate_chars(&card.front, cfg.max_field_chars),
            truncate_chars(&card.back, cfg.max_field_chars)
        );
        if let Some(t) = card.text.as_deref().filter(|t| !t.trim().is_empty()) {
            entry.push_str(&format!("  text: {}\n", truncate_chars(t, cfg.max_field_chars)));
        }
        if text.chars().count() + entry.chars().count() > cfg.max_prompt_chars {
            skipped += 1;
            continue;
        }
        text.push_str(&entry);
        included_ids.push(card.id.clone());
    }

    CriticPrompt {
        text,
        included_ids,
        skipped_over_budget: skipped,
        included_references,
        skipped_references,
    }
}

// ============================================================================
// 响应解析（含越权 id 拒绝）
// ============================================================================

/// 从模型输出中剥离 markdown 代码围栏并定位首个 JSON 对象。
fn extract_json_object(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let end = raw.rfind('}')?;
    if end <= start {
        return None;
    }
    Some(&raw[start..=end])
}

/// 解析 critic JSON 响应。
///
/// - `allowed_ids`：本任务实际送审的卡片 id 白名单。白名单外的裁决
///   （模型越权/幻觉 id）一律拒绝并计入 `rejected_unknown_ids`；
/// - verdict 值非法的条目丢弃计入 `rejected_invalid`；
/// - `revise` 但 `revised` 缺失/全空 → **降级为 flag**（有问题的信号仍保留，
///   但绝不用空载荷覆盖卡片内容）；
/// - 同一 card_id 出现多条裁决时只取第一条（后续按非法条目计数）；
/// - 整体不是合法 JSON / 缺 `verdicts` 数组 → `Err`（调用方走降级路径）。
pub fn parse_critic_response(
    raw: &str,
    allowed_ids: &HashSet<String>,
) -> Result<ParsedVerdicts, String> {
    let json_str = extract_json_object(raw).ok_or_else(|| "响应中未找到 JSON 对象".to_string())?;
    let value: Value =
        serde_json::from_str(json_str).map_err(|e| format!("JSON 解析失败: {}", e))?;
    let items = value
        .get("verdicts")
        .and_then(Value::as_array)
        .ok_or_else(|| "缺少 verdicts 数组".to_string())?;

    let mut out = ParsedVerdicts::default();
    let mut seen: HashSet<String> = HashSet::new();
    for item in items {
        let mut verdict: CardVerdict = match serde_json::from_value(item.clone()) {
            Ok(v) => v,
            Err(_) => {
                out.rejected_invalid += 1;
                continue;
            }
        };
        if !allowed_ids.contains(&verdict.card_id) {
            out.rejected_unknown_ids += 1;
            continue;
        }
        if !seen.insert(verdict.card_id.clone()) {
            out.rejected_invalid += 1;
            continue;
        }
        // revise 无有效载荷 → 降级 flag，理由留痕
        if verdict.verdict == Verdict::Revise
            && !verdict.revised.as_ref().is_some_and(RevisedFields::has_content)
        {
            verdict.verdict = Verdict::Flag;
            verdict.revised = None;
            verdict
                .reasons
                .push("critic 给出 revise 但未提供有效修订内容，降级为 flag".to_string());
        }
        out.verdicts.push(verdict);
    }
    Ok(out)
}

// ============================================================================
// 裁决落地计划（纯函数，DB 写入由编排器执行）
// ============================================================================

/// 落地计划：待持久化的卡片 + 统计。
#[derive(Debug, Default)]
pub struct CriticPlan {
    /// 需要写回 DB 的卡片（revise 重写 / flag 留痕），id/task_id 与原卡一致。
    pub updates: Vec<AnkiCard>,
    pub kept: u32,
    pub revised: u32,
    pub flagged: u32,
}

fn critic_issue(code: &str, message: String, severity: LintSeverity) -> LintIssue {
    LintIssue {
        code: code.to_string(),
        field: "card".to_string(),
        message,
        severity,
    }
}

/// 将裁决映射为具体的卡片更新（纯函数，不触 DB）。
///
/// - `keep` / 无裁决：不产生写入；
/// - `flag`：仅向 `_qa_flags` 追加 `llm_critic` 条目（Warn）；
/// - `revise`：套用 `revised` 中的非空字段（id/task_id/created_at 等元数据
///   一律保持原值），追加 `llm_critic_revised` 审计条目（Info），
///   并对修订后的内容重跑一遍确定性 lint（revise 也可能引入占位符等问题）。
///
/// 修订轮约束在此不体现——本函数只被每任务的**单轮** critic 调用一次，
/// 轮数由 [`CriticConfig::effective_revision_rounds`] 在编排器处钳位。
pub fn plan_updates(cards: &[AnkiCard], verdicts: &[CardVerdict]) -> CriticPlan {
    let mut plan = CriticPlan::default();
    for card in cards {
        let Some(v) = verdicts.iter().find(|v| v.card_id == card.id) else {
            plan.kept += 1;
            continue;
        };
        match v.verdict {
            Verdict::Keep => plan.kept += 1,
            Verdict::Flag => {
                let mut updated = card.clone();
                let issue = critic_issue(
                    CRITIC_FLAG_CODE,
                    format!("LLM critic 标记：{}", join_reasons(&v.reasons)),
                    LintSeverity::Warn,
                );
                anki_qa_lint::merge_flags(&mut updated.extra_fields, &[issue]);
                plan.updates.push(updated);
                plan.flagged += 1;
            }
            Verdict::Revise => {
                let Some(revised) = v.revised.as_ref() else {
                    // parse 层已降级，这里理论上不可达；防御性按 keep 处理
                    plan.kept += 1;
                    continue;
                };
                let mut updated = card.clone();
                if let Some(front) = revised.front.as_deref().map(str::trim).filter(|s| !s.is_empty())
                {
                    updated.front = front.to_string();
                }
                if let Some(back) = revised.back.as_deref().map(str::trim).filter(|s| !s.is_empty())
                {
                    updated.back = back.to_string();
                }
                if let Some(text) = revised.text.as_deref().map(str::trim).filter(|s| !s.is_empty())
                {
                    updated.text = Some(text.to_string());
                    updated
                        .extra_fields
                        .insert("text".to_string(), text.to_string());
                }
                let audit = critic_issue(
                    CRITIC_REVISED_CODE,
                    format!("LLM critic 修订：{}", join_reasons(&v.reasons)),
                    LintSeverity::Info,
                );
                anki_qa_lint::merge_flags(&mut updated.extra_fields, &[audit]);
                // 修订内容重跑确定性 lint（revise 也可能引入占位符/空字段等问题）
                let relint = anki_qa_lint::lint_card(
                    &anki_qa_lint::CardLintInput {
                        front: &updated.front,
                        back: &updated.back,
                        text: updated.text.as_deref(),
                        tags: &updated.tags,
                        extra_fields: &updated.extra_fields,
                    },
                    &anki_qa_lint::LintConfig::default(),
                );
                anki_qa_lint::merge_flags(&mut updated.extra_fields, &relint);
                plan.updates.push(updated);
                plan.revised += 1;
            }
        }
    }
    plan
}

fn join_reasons(reasons: &[String]) -> String {
    let joined = reasons
        .iter()
        .map(|r| r.trim())
        .filter(|r| !r.is_empty())
        .collect::<Vec<_>>()
        .join("；");
    if joined.is_empty() {
        "（模型未给出理由）".to_string()
    } else {
        joined
    }
}

/// 由模型输出（或失败）直接推导落地计划：`Err` → 降级（全 keep，零写入）。
/// 独立成纯函数以便单测降级路径。
pub fn plan_from_model_output(
    model_output: Result<String, String>,
    cards: &[AnkiCard],
    allowed_ids: &HashSet<String>,
) -> (CriticPlan, u32, Option<String>) {
    let raw = match model_output {
        Ok(raw) => raw,
        Err(e) => {
            let mut plan = CriticPlan::default();
            plan.kept = cards.len() as u32;
            return (plan, 0, Some(format!("模型调用失败: {}", e)));
        }
    };
    match parse_critic_response(&raw, allowed_ids) {
        Ok(parsed) => {
            let plan = plan_updates(cards, &parsed.verdicts);
            (plan, parsed.rejected_unknown_ids, None)
        }
        Err(e) => {
            let mut plan = CriticPlan::default();
            plan.kept = cards.len() as u32;
            (plan, 0, Some(format!("裁决解析失败: {}", e)))
        }
    }
}

// ============================================================================
// 同源金标收集（anki_gold_set → critic 的接线层）
// ============================================================================

/// RFC3339 时间戳 → epoch 毫秒；解析失败返回 0（挖掘层对 original 在场的
/// 候选以内容 diff 为准，时间戳仅是后备信号，0 是安全默认）。
fn timestamp_ms(rfc3339: &str) -> i64 {
    chrono::DateTime::parse_from_rfc3339(rfc3339)
        .map(|dt| dt.timestamp_millis())
        .unwrap_or(0)
}

/// 纯函数：从一批同文档卡片行挖掘 grounded 参照对。
///
/// - `exclude_task_id`：当前收尾任务的卡片剔除——它们刚生成、尚无用户编辑
///   信号，且正是待评审对象，不能既当裁判参照又当被告；
/// - 只有携带 `_original_generation` 快照且被用户实际编辑过的兄弟卡才可能
///   产出修正对（挖掘语义完全复用 `anki_gold_set::classify_candidate`）；
/// - 金标端过 `select_grounded_reference_pairs` 的 lint 门槛（脏金标不注入）。
///
/// 无 FSRS 复习信号可用（此路径不 join 复习日志），`review_count` 置 0——
/// 这只影响 `KeptUnedited` 正例桶，修正对挖掘不依赖留存信号。
pub fn gold_references_from_cards(
    cards: &[AnkiCard],
    exclude_task_id: &str,
    cfg: &CriticConfig,
) -> Vec<ReferenceCard> {
    use crate::anki_gold_set as gold;

    let candidates: Vec<gold::GoldCandidate> = cards
        .iter()
        .filter(|card| card.task_id != exclude_task_id && !card.is_error_card)
        .filter_map(|card| {
            let original = gold::extract_original_from_extras(&card.extra_fields)?;
            Some(gold::GoldCandidate {
                card_id: card.id.clone(),
                current: gold::CardSnapshot {
                    front: card.front.clone(),
                    back: card.back.clone(),
                    text: card.text.clone(),
                },
                original: Some(original),
                created_at_ms: timestamp_ms(&card.created_at),
                updated_at_ms: timestamp_ms(&card.updated_at),
                deleted_at_ms: None,
                review_count: 0,
                again_count: 0,
                was_error_card: false,
                is_error_card: card.is_error_card,
            })
        })
        .collect();
    if candidates.is_empty() {
        return Vec::new();
    }

    let samples = gold::mine_gold_set(&candidates, &gold::GoldMiningConfig::default());
    gold::select_grounded_reference_pairs(
        &samples,
        &gold::gold_lint_config(),
        cfg.max_reference_pairs,
    )
    .into_iter()
    .map(ReferenceCard::from_repair_pair)
    .collect()
}

/// 生产收尾路径的金标收集入口：查同文档全部卡片行，挖同源修正对。
/// **任何失败（DB 错误等）都退化为空列表**——critic 回到规则 rubric，
/// 收集层绝不拖垮制卡收尾（与 critic 本体的降级哲学一致）。
pub fn collect_gold_references(
    db: &Database,
    task: &DocumentTask,
    cfg: &CriticConfig,
) -> Vec<ReferenceCard> {
    match db.get_cards_for_document(&task.document_id) {
        Ok(cards) => {
            let refs = gold_references_from_cards(&cards, &task.id, cfg);
            if !refs.is_empty() {
                info!(
                    "[ANKI_CRITIC] 任务 {} 挖得 {} 对同源金标参照（文档 {}）",
                    task.id,
                    refs.len(),
                    task.document_id
                );
            }
            refs
        }
        Err(e) => {
            warn!(
                "[ANKI_CRITIC] 收集同源金标失败（退回规则 rubric）: {}",
                e
            );
            Vec::new()
        }
    }
}

// ============================================================================
// 编排器（任务收尾调用；永不向上抛错）
// ============================================================================

/// 任务收尾后的批量 critic pass。**永不返回 Err**：任何失败（模型/解析/DB）
/// 都折叠为 `CriticSummary`（`degraded` / `persist_failures`），
/// 保证 critic 不影响整批制卡结果。
///
/// `references`：grounded 同源金标参照（0-N 对）。生产收尾路径由
/// [`collect_gold_references`] 从同文档兄弟卡的用户修正记录挖掘；
/// 评测 harness 可直接注入。空切片 → 规则 rubric（与接通前行为一致）。
pub async fn run_critic_pass(
    db: &Database,
    llm: &LLMManager,
    task: &DocumentTask,
    references: &[ReferenceCard],
    cfg: &CriticConfig,
) -> CriticSummary {
    let mut summary = CriticSummary::default();

    if cfg.effective_revision_rounds() == 0 {
        summary.degraded = Some("修订轮数为 0，critic 空转".to_string());
        return summary;
    }

    // 只评审本任务成功入库的非错误卡
    let cards: Vec<AnkiCard> = match db.get_cards_for_task(&task.id) {
        Ok(cards) => cards.into_iter().filter(|c| !c.is_error_card).collect(),
        Err(e) => {
            summary.degraded = Some(format!("读取任务卡片失败: {}", e));
            return summary;
        }
    };
    if cards.is_empty() {
        // 空列表：无事可做，静默成功（不算降级）
        return summary;
    }

    let prompt = build_critic_prompt(&task.content_segment, &cards, references, cfg);
    summary.skipped_over_budget = prompt.skipped_over_budget;
    summary.gold_references = prompt.included_references;
    summary.gold_references_truncated = prompt.skipped_references;
    let allowed_ids: HashSet<String> = prompt.included_ids.iter().cloned().collect();
    let examined: Vec<AnkiCard> = cards
        .iter()
        .filter(|c| allowed_ids.contains(&c.id))
        .cloned()
        .collect();
    summary.examined = examined.len() as u32;
    if examined.is_empty() {
        summary.degraded = Some("预算内无可评审卡片".to_string());
        return summary;
    }

    // Round 5 #6：终审属 Critic 角色（低频、高价值）——经 Sidekick 模型分层
    // 路由取主模型槽（缺槽位降级到制卡槽同一模型）。决策写入摘要可观测；
    // 路由不可用（decision=None）时 call_anki_routed_raw_prompt 自动回退
    // 旧 model2 路径，路由失败绝不影响制卡收尾。
    let routing_mode =
        crate::anki_model_routing::parse_routing_mode(&task.anki_generation_options_json);
    let critic_decision = llm
        .resolve_anki_role_decision(
            crate::anki_model_routing::AnkiModelRole::Critic,
            routing_mode,
        )
        .await;
    note_routing_decision(&mut summary, critic_decision.as_ref());

    // 单轮模型调用（最多修订轮 1，见 effective_revision_rounds 钳位）
    let model_output: Result<String, String> = match tokio::time::timeout(
        Duration::from_secs(CRITIC_MODEL_TIMEOUT_SECS),
        llm.call_anki_routed_raw_prompt(
            critic_decision.as_ref(),
            "anki_critic.run_critic_pass",
            &prompt.text,
            None,
        ),
    )
    .await
    {
        Ok(Ok(output)) => Ok(output.assistant_message),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!("超过 {} 秒未返回", CRITIC_MODEL_TIMEOUT_SECS)),
    };

    let (plan, rejected_unknown_ids, degraded) =
        plan_from_model_output(model_output, &examined, &allowed_ids);
    summary.kept = plan.kept;
    summary.revised = plan.revised;
    summary.flagged = plan.flagged;
    summary.rejected_unknown_ids = rejected_unknown_ids;
    summary.degraded = degraded;

    // 持久化：走既有 update_anki_card_rows（WHERE id 命中 + 任务未删除双保险）
    for card in &plan.updates {
        match db.update_anki_card_rows(card) {
            Ok(1) => {}
            Ok(rows) => {
                warn!(
                    "[ANKI_CRITIC] 卡片 {} 更新命中 {} 行（预期 1），跳过",
                    card.id, rows
                );
                summary.persist_failures += 1;
            }
            Err(e) => {
                warn!("[ANKI_CRITIC] 卡片 {} 更新失败: {}", card.id, e);
                summary.persist_failures += 1;
            }
        }
    }

    info!(
        "[ANKI_CRITIC] 任务 {} critic 完成: routed_model={:?} routed_degraded={:?} examined={} kept={} revised={} flagged={} rejected_ids={} skipped={} gold_refs={} gold_refs_truncated={} persist_failures={} degraded={:?}",
        task.id,
        summary.routed_model,
        summary.routed_degraded,
        summary.examined,
        summary.kept,
        summary.revised,
        summary.flagged,
        summary.rejected_unknown_ids,
        summary.skipped_over_budget,
        summary.gold_references,
        summary.gold_references_truncated,
        summary.persist_failures,
        summary.degraded
    );
    summary
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn make_card(id: &str, front: &str, back: &str) -> AnkiCard {
        AnkiCard {
            id: id.to_string(),
            task_id: "task-1".to_string(),
            front: front.to_string(),
            back: back.to_string(),
            text: None,
            tags: vec!["测试".to_string()],
            images: vec![],
            is_error_card: false,
            error_content: None,
            created_at: "2026-08-24T00:00:00Z".to_string(),
            updated_at: "2026-08-24T00:00:00Z".to_string(),
            extra_fields: HashMap::new(),
            template_id: None,
        }
    }

    fn ids(v: &[&str]) -> HashSet<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    fn qa_flags(card: &AnkiCard) -> Vec<Value> {
        card.extra_fields
            .get(anki_qa_lint::QA_FLAGS_FIELD)
            .map(|raw| serde_json::from_str(raw).unwrap())
            .unwrap_or_default()
    }

    // -------- 选项解析（默认关闭 / serde default） --------

    #[test]
    fn options_default_disabled() {
        let opts = CriticOptions::from_options_json(r#"{"deck_name":"d","note_type":"Basic"}"#);
        assert!(!opts.critic_enabled(), "critic 必须默认关闭（opt-in）");
    }

    #[test]
    fn options_enabled_via_primary_flag() {
        let opts = CriticOptions::from_options_json(r#"{"enable_critic_pass":true}"#);
        assert!(opts.critic_enabled());
    }

    #[test]
    fn options_enabled_via_alias_flag_and_budget_applied() {
        let opts = CriticOptions::from_options_json(
            r#"{"enable_llm_critic":true,"critic_token_budget":5000}"#,
        );
        assert!(opts.critic_enabled());
        assert_eq!(opts.to_config().max_prompt_chars, 10_000);
    }

    #[test]
    fn options_invalid_json_falls_back_to_disabled() {
        let opts = CriticOptions::from_options_json("not-json-at-all");
        assert!(!opts.critic_enabled(), "解析失败必须视同关闭，不得报错");
    }

    #[test]
    fn options_tiny_budget_clamped_to_floor() {
        let opts =
            CriticOptions::from_options_json(r#"{"enable_critic_pass":true,"critic_token_budget":1}"#);
        assert_eq!(opts.to_config().max_prompt_chars, 2_000, "预算下限保护");
    }

    // -------- 响应解析 --------

    #[test]
    fn parse_valid_response_all_verdict_kinds() {
        let raw = r#"{"verdicts":[
            {"card_id":"c1","verdict":"keep"},
            {"card_id":"c2","verdict":"revise","reasons":["答案与源材料矛盾"],
             "revised":{"back":"修正后的答案"}},
            {"card_id":"c3","verdict":"flag","reasons":["与 c1 重复"]}
        ]}"#;
        let parsed = parse_critic_response(raw, &ids(&["c1", "c2", "c3"])).unwrap();
        assert_eq!(parsed.verdicts.len(), 3);
        assert_eq!(parsed.rejected_unknown_ids, 0);
        assert_eq!(parsed.verdicts[0].verdict, Verdict::Keep);
        assert_eq!(parsed.verdicts[1].verdict, Verdict::Revise);
        assert_eq!(
            parsed.verdicts[1].revised.as_ref().unwrap().back.as_deref(),
            Some("修正后的答案")
        );
        assert_eq!(parsed.verdicts[2].verdict, Verdict::Flag);
    }

    #[test]
    fn parse_tolerates_markdown_fence_and_prose() {
        let raw = "好的，以下是裁决结果：\n```json\n{\"verdicts\":[{\"card_id\":\"c1\",\"verdict\":\"keep\"}]}\n```\n希望有帮助。";
        let parsed = parse_critic_response(raw, &ids(&["c1"])).unwrap();
        assert_eq!(parsed.verdicts.len(), 1);
    }

    #[test]
    fn parse_rejects_unknown_card_id() {
        // 模型幻觉/越权 id：裁决必须被拒绝，绝不能落到任何卡上
        let raw = r#"{"verdicts":[
            {"card_id":"evil-id","verdict":"revise","revised":{"front":"被篡改"}},
            {"card_id":"c1","verdict":"keep"}
        ]}"#;
        let parsed = parse_critic_response(raw, &ids(&["c1"])).unwrap();
        assert_eq!(parsed.rejected_unknown_ids, 1);
        assert_eq!(parsed.verdicts.len(), 1);
        assert_eq!(parsed.verdicts[0].card_id, "c1");
    }

    #[test]
    fn parse_revise_without_payload_downgrades_to_flag() {
        let raw = r#"{"verdicts":[
            {"card_id":"c1","verdict":"revise"},
            {"card_id":"c2","verdict":"revise","revised":{"front":"   "}}
        ]}"#;
        let parsed = parse_critic_response(raw, &ids(&["c1", "c2"])).unwrap();
        assert_eq!(parsed.verdicts.len(), 2);
        for v in &parsed.verdicts {
            assert_eq!(v.verdict, Verdict::Flag, "空载荷 revise 必须降级为 flag");
            assert!(v.revised.is_none());
        }
    }

    #[test]
    fn parse_invalid_json_is_error() {
        assert!(parse_critic_response("完全不是 JSON", &ids(&["c1"])).is_err());
        assert!(parse_critic_response("{\"foo\": 1}", &ids(&["c1"])).is_err(), "缺 verdicts 数组");
        assert!(parse_critic_response("{broken", &ids(&["c1"])).is_err());
    }

    #[test]
    fn parse_empty_verdict_list_is_ok() {
        let parsed = parse_critic_response(r#"{"verdicts":[]}"#, &ids(&["c1"])).unwrap();
        assert!(parsed.verdicts.is_empty());
        assert_eq!(parsed.rejected_unknown_ids, 0);
    }

    #[test]
    fn parse_duplicate_verdicts_keep_first_only() {
        let raw = r#"{"verdicts":[
            {"card_id":"c1","verdict":"keep"},
            {"card_id":"c1","verdict":"flag","reasons":["重复裁决"]}
        ]}"#;
        let parsed = parse_critic_response(raw, &ids(&["c1"])).unwrap();
        assert_eq!(parsed.verdicts.len(), 1);
        assert_eq!(parsed.verdicts[0].verdict, Verdict::Keep);
        assert_eq!(parsed.rejected_invalid, 1);
    }

    #[test]
    fn parse_invalid_verdict_value_rejected_without_failing_batch() {
        let raw = r#"{"verdicts":[
            {"card_id":"c1","verdict":"delete"},
            {"card_id":"c2","verdict":"keep"}
        ]}"#;
        let parsed = parse_critic_response(raw, &ids(&["c1", "c2"])).unwrap();
        assert_eq!(parsed.rejected_invalid, 1, "非法 verdict 单条丢弃");
        assert_eq!(parsed.verdicts.len(), 1);
    }

    // -------- 落地计划 --------

    #[test]
    fn plan_empty_cards_produces_no_updates() {
        let plan = plan_updates(&[], &[]);
        assert!(plan.updates.is_empty());
        assert_eq!(plan.kept + plan.revised + plan.flagged, 0);
    }

    #[test]
    fn plan_keep_and_missing_verdict_produce_no_write() {
        let cards = vec![make_card("c1", "Q1", "A1"), make_card("c2", "Q2", "A2")];
        let verdicts = vec![CardVerdict {
            card_id: "c1".to_string(),
            verdict: Verdict::Keep,
            reasons: vec![],
            revised: None,
        }];
        let plan = plan_updates(&cards, &verdicts);
        assert!(plan.updates.is_empty(), "keep 与无裁决都不得产生写入");
        assert_eq!(plan.kept, 2);
    }

    #[test]
    fn plan_revise_applies_fields_but_never_touches_identity() {
        let cards = vec![make_card("c1", "旧问题", "旧答案")];
        let verdicts = vec![CardVerdict {
            card_id: "c1".to_string(),
            verdict: Verdict::Revise,
            reasons: vec!["答案与源材料矛盾".to_string()],
            revised: Some(RevisedFields {
                front: Some("新问题？".to_string()),
                back: Some("新答案".to_string()),
                text: None,
            }),
        }];
        let plan = plan_updates(&cards, &verdicts);
        assert_eq!(plan.revised, 1);
        let updated = &plan.updates[0];
        assert_eq!(updated.front, "新问题？");
        assert_eq!(updated.back, "新答案");
        // 主键与归属元数据必须原封不动
        assert_eq!(updated.id, "c1");
        assert_eq!(updated.task_id, "task-1");
        assert_eq!(updated.created_at, cards[0].created_at);
        // 审计条目落入 _qa_flags
        let flags = qa_flags(updated);
        assert!(flags.iter().any(|f| f["code"] == CRITIC_REVISED_CODE));
    }

    #[test]
    fn plan_revise_partial_fields_keeps_untouched_ones() {
        let cards = vec![make_card("c1", "问题", "旧答案")];
        let verdicts = vec![CardVerdict {
            card_id: "c1".to_string(),
            verdict: Verdict::Revise,
            reasons: vec![],
            revised: Some(RevisedFields {
                front: None,
                back: Some("新答案".to_string()),
                text: None,
            }),
        }];
        let plan = plan_updates(&cards, &verdicts);
        assert_eq!(plan.updates[0].front, "问题", "未修订字段保持原值");
        assert_eq!(plan.updates[0].back, "新答案");
    }

    #[test]
    fn plan_flag_merges_qa_flags_preserving_existing_entries() {
        let mut card = make_card("c1", "Q", "A");
        card.extra_fields.insert(
            anki_qa_lint::QA_FLAGS_FIELD.to_string(),
            r#"[{"code":"answer_leak","field":"front","message":"泄露","severity":"warn"}]"#
                .to_string(),
        );
        let verdicts = vec![CardVerdict {
            card_id: "c1".to_string(),
            verdict: Verdict::Flag,
            reasons: vec!["与另一张卡重复".to_string()],
            revised: None,
        }];
        let plan = plan_updates(&[card], &verdicts);
        assert_eq!(plan.flagged, 1);
        let flags = qa_flags(&plan.updates[0]);
        assert_eq!(flags.len(), 2, "既有 lint 条目必须保留");
        assert!(flags.iter().any(|f| f["code"] == "answer_leak"));
        assert!(flags
            .iter()
            .any(|f| f["code"] == CRITIC_FLAG_CODE && f["severity"] == "warn"));
        // flag 不改内容
        assert_eq!(plan.updates[0].front, "Q");
        assert_eq!(plan.updates[0].back, "A");
    }

    #[test]
    fn plan_revised_content_is_relinted() {
        // revise 引入占位符 → 确定性 lint 必须在 _qa_flags 里留痕
        let cards = vec![make_card("c1", "问题", "答案")];
        let verdicts = vec![CardVerdict {
            card_id: "c1".to_string(),
            verdict: Verdict::Revise,
            reasons: vec![],
            revised: Some(RevisedFields {
                back: Some("请参考 {{DOCUMENT_CONTENT}}".to_string()),
                ..Default::default()
            }),
        }];
        let plan = plan_updates(&cards, &verdicts);
        let flags = qa_flags(&plan.updates[0]);
        assert!(
            flags.iter().any(|f| f["code"] == "placeholder_residue"),
            "修订内容必须重跑确定性 lint: {:?}",
            flags
        );
    }

    // -------- 降级路径 --------

    #[test]
    fn model_failure_degrades_to_all_keep() {
        let cards = vec![make_card("c1", "Q", "A"), make_card("c2", "Q2", "A2")];
        let allowed = ids(&["c1", "c2"]);
        let (plan, rejected, degraded) =
            plan_from_model_output(Err("网络超时".to_string()), &cards, &allowed);
        assert!(degraded.is_some(), "模型失败必须标记降级");
        assert_eq!(plan.kept, 2, "降级时全部卡片视同 keep");
        assert!(plan.updates.is_empty(), "降级绝不产生任何写入");
        assert_eq!(rejected, 0);
    }

    #[test]
    fn unparseable_output_degrades_to_all_keep() {
        let cards = vec![make_card("c1", "Q", "A")];
        let allowed = ids(&["c1"]);
        let (plan, _, degraded) =
            plan_from_model_output(Ok("抱歉我无法完成该任务".to_string()), &cards, &allowed);
        assert!(degraded.is_some());
        assert_eq!(plan.kept, 1);
        assert!(plan.updates.is_empty());
    }

    #[test]
    fn successful_output_flows_into_plan() {
        let cards = vec![make_card("c1", "Q", "A")];
        let allowed = ids(&["c1"]);
        let raw = r#"{"verdicts":[{"card_id":"c1","verdict":"flag","reasons":["空泛提问"]}]}"#;
        let (plan, rejected, degraded) =
            plan_from_model_output(Ok(raw.to_string()), &cards, &allowed);
        assert!(degraded.is_none());
        assert_eq!(rejected, 0);
        assert_eq!(plan.flagged, 1);
        assert_eq!(plan.updates.len(), 1);
    }

    // -------- prompt 与 token 预算 --------

    #[test]
    fn prompt_uses_rule_rubric_without_references() {
        let cards = vec![make_card("c1", "Q", "A")];
        let prompt = build_critic_prompt("源材料内容", &cards, &[], &CriticConfig::default());
        assert!(prompt.text.contains("最小信息原则"), "无金标必须启用规则 rubric");
        assert!(prompt.text.contains("源材料内容"));
        assert!(prompt.text.contains("- id: c1"));
        assert_eq!(prompt.included_ids, vec!["c1".to_string()]);
        assert_eq!(prompt.skipped_over_budget, 0);
    }

    fn gold_ref(degraded: Option<(&str, &str)>, gold: (&str, &str)) -> ReferenceCard {
        ReferenceCard {
            front: gold.0.to_string(),
            back: gold.1.to_string(),
            degraded_front: degraded.map(|(f, _)| f.to_string()),
            degraded_back: degraded.map(|(_, b)| b.to_string()),
        }
    }

    #[test]
    fn prompt_switches_to_grounded_mode_with_reference_cards() {
        let cards = vec![make_card("c1", "Q", "A")];
        let refs = vec![gold_ref(None, ("金标问题", "金标答案"))];
        let prompt = build_critic_prompt("源材料", &cards, &refs, &CriticConfig::default());
        assert!(prompt.text.contains("同源金标参照"), "有金标必须切换 grounded 模式");
        assert!(prompt.text.contains("金标问题"));
        assert!(!prompt.text.contains("最小信息原则"), "grounded 模式不再附规则 rubric");
        assert_eq!(prompt.included_references, 1);
        assert_eq!(prompt.skipped_references, 0);
    }

    #[test]
    fn prompt_renders_degraded_and_gold_sides_of_pair() {
        let cards = vec![make_card("c1", "Q", "A")];
        let refs = vec![gold_ref(
            Some(("劣化问题？答案泄露了", "泄露")),
            ("修好的问题？", "修好的答案"),
        )];
        let prompt = build_critic_prompt("源材料", &cards, &refs, &CriticConfig::default());
        assert!(prompt.text.contains("改前(劣化) Q: 劣化问题？答案泄露了"));
        assert!(prompt.text.contains("改前(劣化) A: 泄露"));
        assert!(prompt.text.contains("改后(金标) Q: 修好的问题？"));
        assert!(prompt.text.contains("改后(金标) A: 修好的答案"));
    }

    #[test]
    fn prompt_reference_pairs_capped_at_max_pairs() {
        let cfg = CriticConfig {
            max_reference_pairs: 2,
            ..CriticConfig::default()
        };
        let refs: Vec<ReferenceCard> = (0..5)
            .map(|i| gold_ref(Some(("坏Q", "坏A")), (&format!("好Q{}", i), "好A")))
            .collect();
        let cards = vec![make_card("c1", "Q", "A")];
        let prompt = build_critic_prompt("源材料", &cards, &refs, &cfg);
        assert_eq!(prompt.included_references, 2);
        assert_eq!(prompt.skipped_references, 3);
        assert!(prompt.text.contains("好Q0"));
        assert!(prompt.text.contains("好Q1"));
        assert!(!prompt.text.contains("好Q2"), "超上限金标必须截断");
    }

    #[test]
    fn prompt_reference_budget_truncates_but_never_starves_cards() {
        // 金标区预算被钳位到 max_prompt_chars/3：巨型金标不得把待评审卡挤出预算
        let cfg = CriticConfig {
            max_prompt_chars: 3_000,
            max_segment_chars: 100,
            max_field_chars: 400,
            max_reference_pairs: 20,
            max_reference_chars: 100_000, // 显式配置故意给大，验证 1/3 钳位兜底
            ..CriticConfig::default()
        };
        let refs: Vec<ReferenceCard> = (0..10)
            .map(|i| {
                gold_ref(
                    Some((&"坏".repeat(100), &"错".repeat(100))),
                    (&format!("{}{}", "好".repeat(100), i), &"对".repeat(100)),
                )
            })
            .collect();
        let cards = vec![make_card("c1", "问题？", "答案")];
        let prompt = build_critic_prompt("源材料", &cards, &refs, &cfg);
        assert!(prompt.included_references >= 1, "预算内的头部金标必须入选");
        assert!(prompt.skipped_references > 0, "超预算金标必须截断计数");
        assert_eq!(
            prompt.included_references as usize + prompt.skipped_references as usize,
            refs.len()
        );
        assert_eq!(
            prompt.included_ids,
            vec!["c1".to_string()],
            "待评审卡必须仍在 prompt 内"
        );
        assert!(
            prompt.text.chars().count() <= cfg.max_prompt_chars + 200,
            "总预算仍需贴近上限，实际 {}",
            prompt.text.chars().count()
        );
    }

    #[test]
    fn prompt_all_references_over_budget_falls_back_to_rule_rubric() {
        // 单对金标就超出金标区预算 → 一对都进不来 → 必须干净退回规则 rubric
        let cfg = CriticConfig {
            max_prompt_chars: 3_000,
            max_reference_chars: 10, // 任何条目都放不下
            ..CriticConfig::default()
        };
        let refs = vec![gold_ref(Some(("坏Q", "坏A")), ("好Q", "好A"))];
        let cards = vec![make_card("c1", "Q", "A")];
        let prompt = build_critic_prompt("源材料", &cards, &refs, &cfg);
        assert_eq!(prompt.included_references, 0);
        assert_eq!(prompt.skipped_references, 1);
        assert!(prompt.text.contains("最小信息原则"), "零金标入选必须回退规则 rubric");
        assert!(!prompt.text.contains("同源金标参照"), "不得留下空的金标段落");
    }

    #[test]
    fn reference_card_from_repair_pair_maps_gold_and_degraded_sides() {
        use crate::anki_gold_set::{CardSnapshot, RepairPair};
        let pair = RepairPair {
            original: CardSnapshot {
                front: "什么是惯性？答案是保持运动状态。".to_string(),
                back: "保持运动状态".to_string(),
                text: None,
            },
            edited: CardSnapshot {
                front: "什么是惯性？".to_string(),
                back: String::new(),
                text: Some("物体具有{{c1::保持原有运动状态}}的性质".to_string()),
            },
            distance_ratio: 0.3,
        };
        let r = ReferenceCard::from_repair_pair(&pair);
        assert_eq!(r.front, "什么是惯性？");
        assert_eq!(
            r.back, "物体具有{{c1::保持原有运动状态}}的性质",
            "back 为空时 Cloze text 顶上答案面"
        );
        assert_eq!(r.degraded_front.as_deref(), Some("什么是惯性？答案是保持运动状态。"));
        assert_eq!(r.degraded_back.as_deref(), Some("保持运动状态"));

        // original 全空 → 退化为纯金标示例，不携带劣化面
        let no_degraded = RepairPair {
            original: CardSnapshot::default(),
            edited: pair.edited.clone(),
            distance_ratio: 1.0,
        };
        let r2 = ReferenceCard::from_repair_pair(&no_degraded);
        assert!(r2.degraded_front.is_none());
        assert!(r2.degraded_back.is_none());
    }

    // -------- 同源金标收集（gold_set → critic 接线） --------

    fn card_with_original(
        id: &str,
        task_id: &str,
        front: &str,
        back: &str,
        original_front: &str,
        original_back: &str,
    ) -> AnkiCard {
        let mut card = make_card(id, front, back);
        card.task_id = task_id.to_string();
        card.extra_fields.insert(
            crate::anki_gold_set::ORIGINAL_GENERATION_FIELD.to_string(),
            serde_json::json!({ "front": original_front, "back": original_back }).to_string(),
        );
        card
    }

    #[test]
    fn gold_references_from_cards_mines_sibling_edits() {
        let cfg = CriticConfig::default();
        // 兄弟任务的卡：用户修掉了答案泄露 → 应产出一对劣化/金标
        let edited_sibling = card_with_original(
            "s1",
            "task-old",
            "快速排序的平均时间复杂度是多少？",
            "O(n log n)",
            "快速排序的平均时间复杂度是多少？答案是 O(n log n)。",
            "O(n log n)",
        );
        // 兄弟任务未编辑的卡（original == current）：无修正对信号
        let untouched_sibling = card_with_original(
            "s2",
            "task-old",
            "什么是栈？",
            "后进先出的线性表",
            "什么是栈？",
            "后进先出的线性表",
        );
        // 无 _original_generation 快照的卡：无法构成修正对
        let mut no_snapshot = make_card("s3", "什么是队列？", "先进先出");
        no_snapshot.task_id = "task-old".to_string();
        let refs = gold_references_from_cards(
            &[edited_sibling, untouched_sibling, no_snapshot],
            "task-current",
            &cfg,
        );
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].front, "快速排序的平均时间复杂度是多少？");
        assert_eq!(
            refs[0].degraded_front.as_deref(),
            Some("快速排序的平均时间复杂度是多少？答案是 O(n log n)。")
        );
    }

    #[test]
    fn gold_references_exclude_current_task_and_error_cards() {
        let cfg = CriticConfig::default();
        // 当前任务自己的卡即便带编辑痕迹也不能当参照（既当裁判又当被告）
        let self_card = card_with_original(
            "c1",
            "task-current",
            "修好的问题？",
            "修好的答案",
            "坏问题？答案泄露",
            "泄露",
        );
        let mut error_card = card_with_original(
            "c2",
            "task-old",
            "修好的问题2？",
            "修好的答案2",
            "坏问题2",
            "TODO",
        );
        error_card.is_error_card = true;
        let refs = gold_references_from_cards(&[self_card, error_card], "task-current", &cfg);
        assert!(refs.is_empty(), "当前任务卡与错误卡都不得进入参照集");
    }

    #[test]
    fn gold_references_reject_dirty_gold_side() {
        let cfg = CriticConfig::default();
        // 用户"修改后"仍残留占位符 → 金标端 lint 不干净，不得注入
        let dirty = card_with_original(
            "d1",
            "task-old",
            "什么是熵？",
            "请参考 {{DOCUMENT_CONTENT}}",
            "熵？？",
            "混乱",
        );
        let refs = gold_references_from_cards(&[dirty], "task-current", &cfg);
        assert!(refs.is_empty(), "脏金标必须被 lint 门槛拒绝");
    }

    #[test]
    fn gold_references_capped_by_config() {
        let cfg = CriticConfig {
            max_reference_pairs: 1,
            ..CriticConfig::default()
        };
        let cards: Vec<AnkiCard> = (0..4)
            .map(|i| {
                card_with_original(
                    &format!("g{}", i),
                    "task-old",
                    &format!("问题{}是什么？", i),
                    &format!("答案{}", i),
                    &format!("问题{}是什么？答案是答案{}。", i, i),
                    &format!("答案{}", i),
                )
            })
            .collect();
        let refs = gold_references_from_cards(&cards, "task-current", &cfg);
        assert_eq!(refs.len(), 1, "收集层同样遵守 max_reference_pairs 上限");
    }

    #[test]
    fn prompt_truncates_segment_and_skips_cards_over_budget() {
        let cfg = CriticConfig {
            max_prompt_chars: 1_600,
            max_segment_chars: 200,
            max_field_chars: 50,
            ..CriticConfig::default()
        };
        let long_segment = "材".repeat(5_000);
        let cards: Vec<AnkiCard> = (0..30)
            .map(|i| make_card(&format!("c{}", i), &"问".repeat(120), &"答".repeat(120)))
            .collect();
        let prompt = build_critic_prompt(&long_segment, &cards, &[], &cfg);
        assert!(
            prompt.text.chars().count() <= cfg.max_prompt_chars + 200,
            "prompt 必须贴近字符预算, 实际 {}",
            prompt.text.chars().count()
        );
        assert!(prompt.skipped_over_budget > 0, "超预算卡片必须跳过并计数");
        assert_eq!(
            prompt.included_ids.len() + prompt.skipped_over_budget as usize,
            cards.len()
        );
    }

    #[test]
    fn prompt_caps_cards_per_call() {
        let cfg = CriticConfig {
            max_cards_per_call: 3,
            ..CriticConfig::default()
        };
        let cards: Vec<AnkiCard> = (0..10)
            .map(|i| make_card(&format!("c{}", i), "Q", "A"))
            .collect();
        let prompt = build_critic_prompt("材料", &cards, &[], &cfg);
        assert_eq!(prompt.included_ids.len(), 3);
        assert_eq!(prompt.skipped_over_budget, 7);
    }

    // -------- 修订轮钳位 --------

    #[test]
    fn revision_rounds_hard_capped_at_one() {
        let cfg = CriticConfig {
            max_revision_rounds: 5,
            ..CriticConfig::default()
        };
        assert_eq!(cfg.effective_revision_rounds(), 1, "修订轮硬上限 1");
        let zero = CriticConfig {
            max_revision_rounds: 0,
            ..CriticConfig::default()
        };
        assert_eq!(zero.effective_revision_rounds(), 0);
    }

    // -------- Sidekick 路由观测（Round 5 #6） --------

    fn sample_decision(degraded: bool) -> crate::anki_model_routing::RoleDecision {
        crate::anki_model_routing::RoleDecision {
            role: crate::anki_model_routing::AnkiModelRole::Critic,
            config_id: "cfg-strong".to_string(),
            model: "strong-pro".to_string(),
            slot: crate::anki_model_routing::SlotKind::MainModel,
            degraded,
            is_multimodal: false,
            reason: "主模型槽（较强模型）".to_string(),
        }
    }

    #[test]
    fn note_routing_decision_populates_summary() {
        let mut summary = CriticSummary::default();
        let decision = sample_decision(true);
        note_routing_decision(&mut summary, Some(&decision));
        assert_eq!(summary.routed_config_id.as_deref(), Some("cfg-strong"));
        assert_eq!(summary.routed_model.as_deref(), Some("strong-pro"));
        assert_eq!(summary.routed_degraded, Some(true));
    }

    #[test]
    fn note_routing_decision_none_keeps_summary_untouched() {
        let mut summary = CriticSummary::default();
        note_routing_decision(&mut summary, None);
        assert!(summary.routed_config_id.is_none());
        assert!(summary.routed_model.is_none());
        assert!(summary.routed_degraded.is_none());
    }

    #[test]
    fn summary_wire_format_unchanged_without_routing() {
        // 路由不可用（旧 model2 路径）时序列化结果不得出现任何 routed_* 字段，
        // 与路由接通前的 wire 格式逐字节兼容
        let raw = serde_json::to_string(&CriticSummary::default()).unwrap();
        assert!(!raw.contains("routed_"), "None 字段必须跳过序列化: {}", raw);
    }

    #[test]
    fn summary_serializes_routing_fields_when_present() {
        let mut summary = CriticSummary::default();
        note_routing_decision(&mut summary, Some(&sample_decision(false)));
        let raw = serde_json::to_string(&summary).unwrap();
        assert!(raw.contains("\"routed_config_id\":\"cfg-strong\""));
        assert!(raw.contains("\"routed_model\":\"strong-pro\""));
        assert!(raw.contains("\"routed_degraded\":false"));
    }

    #[test]
    fn critic_routing_mode_parses_from_same_options_json() {
        // critic 开关与路由模式共用同一份 anki_generation_options_json
        let json = r#"{"enable_critic_pass":true,"sidekick_model_routing":"single"}"#;
        assert!(CriticOptions::from_options_json(json).critic_enabled());
        assert_eq!(
            crate::anki_model_routing::parse_routing_mode(json),
            crate::anki_model_routing::RoutingMode::Single
        );
        // 缺省 auto：与 streaming get_configurations 的解析口径一致
        assert_eq!(
            crate::anki_model_routing::parse_routing_mode(r#"{"enable_critic_pass":true}"#),
            crate::anki_model_routing::RoutingMode::Auto
        );
    }

    // -------- verdict serde 契约 --------

    #[test]
    fn verdict_serde_uses_lowercase_wire_format() {
        assert_eq!(serde_json::to_string(&Verdict::Keep).unwrap(), "\"keep\"");
        assert_eq!(serde_json::to_string(&Verdict::Revise).unwrap(), "\"revise\"");
        assert_eq!(serde_json::to_string(&Verdict::Flag).unwrap(), "\"flag\"");
        let v: Verdict = serde_json::from_str("\"revise\"").unwrap();
        assert_eq!(v, Verdict::Revise);
    }
}
