//! # 生成后 Grounded judge / LLM critic pass（opt-in，默认关闭）
//!
//! Round 4 #2：任务级批量 critic。流式制卡任务收尾（`Ok(stats)`）后，
//! 对该任务已入库的全部非错误卡做**一次** `call_model2_raw_prompt` JSON 裁决，
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
//! - **grounded 参照卡接口预留**：`ReferenceCard`（金标卡）可选注入，
//!   有金标时 prompt 切换为对照金标评审；无金标（当前所有调用方）时
//!   使用内置规则 rubric（事实性/最小信息/重复，对齐 agents/card-qa.md 维度）。

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
}

impl Default for CriticConfig {
    fn default() -> Self {
        Self {
            max_prompt_chars: 24_000,
            max_segment_chars: 8_000,
            max_field_chars: 600,
            max_cards_per_call: 40,
            max_revision_rounds: 1,
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
// Grounded 参照卡接口（预留）
// ============================================================================

/// 金标参照卡。上游（评测 harness / 教师标注）可注入一组参照卡，
/// critic prompt 将切换为"对照金标评审"模式。当前生产调用方传空列表，
/// 走内置规则 rubric。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReferenceCard {
    pub front: String,
    pub back: String,
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
    /// 持久化失败（update 未命中行等）的卡片数。
    pub persist_failures: u32,
    /// 非 None 表示本次 critic 降级（模型失败/超时/解析失败），全部卡片视同 keep。
    pub degraded: Option<String>,
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

    if references.is_empty() {
        text.push_str(RULE_RUBRIC);
    } else {
        text.push_str(
            "评审模式：对照金标参照卡。以下【金标参照卡】是同一材料的高质量标准卡，\
             以其事实与粒度为基准裁决待评审卡片；与金标矛盾的卡片必须 revise 或 flag。\n\n【金标参照卡】\n",
        );
        for (i, r) in references.iter().enumerate() {
            text.push_str(&format!(
                "{}. Q: {}\n   A: {}\n",
                i + 1,
                truncate_chars(&r.front, cfg.max_field_chars),
                truncate_chars(&r.back, cfg.max_field_chars)
            ));
        }
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
// 编排器（任务收尾调用；永不向上抛错）
// ============================================================================

/// 任务收尾后的批量 critic pass。**永不返回 Err**：任何失败（模型/解析/DB）
/// 都折叠为 `CriticSummary`（`degraded` / `persist_failures`），
/// 保证 critic 不影响整批制卡结果。
///
/// `references`：grounded 金标参照卡（预留接口）。生产收尾路径传空切片
/// （无金标 → 规则 rubric）；评测 harness 可注入金标。
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

    // 单轮模型调用（最多修订轮 1，见 effective_revision_rounds 钳位）
    let model_output: Result<String, String> = match tokio::time::timeout(
        Duration::from_secs(CRITIC_MODEL_TIMEOUT_SECS),
        llm.call_model2_raw_prompt(&prompt.text, None, crate::llm_usage::CallerType::Anki),
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
        "[ANKI_CRITIC] 任务 {} critic 完成: examined={} kept={} revised={} flagged={} rejected_ids={} skipped={} persist_failures={} degraded={:?}",
        task.id,
        summary.examined,
        summary.kept,
        summary.revised,
        summary.flagged,
        summary.rejected_unknown_ids,
        summary.skipped_over_budget,
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

    #[test]
    fn prompt_switches_to_grounded_mode_with_reference_cards() {
        let cards = vec![make_card("c1", "Q", "A")];
        let refs = vec![ReferenceCard {
            front: "金标问题".to_string(),
            back: "金标答案".to_string(),
        }];
        let prompt = build_critic_prompt("源材料", &cards, &refs, &CriticConfig::default());
        assert!(prompt.text.contains("金标参照卡"), "有金标必须切换 grounded 模式");
        assert!(prompt.text.contains("金标问题"));
        assert!(!prompt.text.contains("最小信息原则"), "grounded 模式不再附规则 rubric");
    }

    #[test]
    fn prompt_truncates_segment_and_skips_cards_over_budget() {
        let cfg = CriticConfig {
            max_prompt_chars: 1_600,
            max_segment_chars: 200,
            max_field_chars: 50,
            max_cards_per_call: 40,
            max_revision_rounds: 1,
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
