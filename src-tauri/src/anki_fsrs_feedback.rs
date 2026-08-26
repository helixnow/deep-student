//! FSRS 复习数据回流到制卡生成（Round 3 #5）
//!
//! 把本地 FSRS 复习库的统计信号（高 lapse 模板、易混淆标签、平均可提取性、
//! 高遗忘卡片）在制卡开始前回流进生成 prompt，让模型：
//! 1. 避开与库内高遗忘卡语义重复的卡片（同批次语义干扰预警）；
//! 2. 对用户历史薄弱的模板/标签生成更小的原子卡；
//! 3. 对确实相邻易混的知识点生成对比卡。
//!
//! ## 隐私（0824 收口）
//! 统计查询与聚合只读本地 SQLite（`fsrs_card_states` / `anki_cards`），
//! 但**注入的画像文本会进入制卡 prompt 并随生成请求发送到所配置的模型端点**——
//! 配置远端模型时数据会离开本机。因此：
//! 1. 回流必须显式授权：`AnkiGenerationOptions::fsrs_feedback == Some(true)`
//!    才注入，`None` / `Some(false)` 一律跳过（见 `EnhancedAnkiService`）；
//! 2. 默认只注入匿名聚合统计（库规模 / 可提取性 / 模板与标签维度 lapse），
//!    历史卡片正面摘要与同批次干扰预警属卡片原文，仅在
//!    [`FsrsFeedbackConfig::include_card_excerpts`] 显式开启时注入；
//! 3. 渲染文案不得声称“数据不上传”。
//!
//! ## 降级
//! 任何查询失败（表缺失、连接失败、空库）都降级为「无反馈」（返回 `None` /
//! 空画像），绝不让制卡流程失败。
//!
//! ## 结构
//! - SQL 只读行由 [`crate::fsrs_review_service::FsrsReviewService::list_feedback_rows`] 提供；
//! - 本模块全部为纯函数（输入行 → 画像/文本），便于无 DB 单测；
//! - [`build_feedback_injection`] 是唯一的编排入口（含降级）。

use crate::database::Database;
use crate::fsrs_review_service::{FsrsFeedbackRow, FsrsReviewService};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use tracing::warn;

const MS_PER_DAY: f64 = 86_400_000.0;

/// 回流注入的预算/阈值配置。
///
/// 字符预算是对 token 预算的保守近似（中文 1 字 ≈ 1 token，英文约 4 字符 ≈ 1 token），
/// 默认画像 + 干扰两个 section 合计约 1200 token 以内。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsrsFeedbackConfig {
    /// 从 FSRS 库最多扫描的行数（按 lapses 降序取前 N）
    pub scan_limit: u32,
    /// 进入「高遗忘」名单的最小 lapse 次数
    pub min_lapses_for_hint: i32,
    /// 画像中最多列出的高 lapse 模板数
    pub max_templates: usize,
    /// 画像中最多列出的易混淆标签数
    pub max_tags: usize,
    /// 画像中最多列出的高遗忘卡片示例数
    pub max_high_lapse_cards: usize,
    /// 干扰预警最多列出的近义高 lapse 卡数
    pub max_interference_cards: usize,
    /// 每张卡 front 摘要的最大字符数
    pub front_excerpt_chars: usize,
    /// 画像 section 渲染后的最大字符数（超出截断）
    pub max_profile_chars: usize,
    /// 干扰 section 渲染后的最大字符数（超出停止追加条目）
    pub max_interference_chars: usize,
    /// 是否在注入内容中包含历史卡片正面摘要（高遗忘卡示例、同批次干扰预警）。
    ///
    /// 默认 **false**（0824 隐私收口）：注入文本会随生成请求发送到所配置的
    /// 模型端点，默认只允许匿名聚合统计外送，不允许历史卡片原文外送。
    #[serde(default)]
    pub include_card_excerpts: bool,
}

impl Default for FsrsFeedbackConfig {
    fn default() -> Self {
        Self {
            scan_limit: 500,
            min_lapses_for_hint: 2,
            max_templates: 5,
            max_tags: 8,
            max_high_lapse_cards: 6,
            max_interference_cards: 8,
            front_excerpt_chars: 60,
            max_profile_chars: 1400,
            max_interference_chars: 1600,
            include_card_excerpts: false,
        }
    }
}

/// 模板维度的 lapse 统计（"due/lapse 高的模板"）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TemplateLapseStat {
    /// 模板 ID；无模板的基础卡归入 `"basic"`
    pub template_id: String,
    pub cards: usize,
    pub due_cards: usize,
    pub total_lapses: i64,
    pub avg_lapses: f64,
}

/// 标签维度的 lapse 统计（"易混淆标签"）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TagLapseStat {
    pub tag: String,
    pub cards: usize,
    pub total_lapses: i64,
    pub avg_lapses: f64,
}

/// 高遗忘卡片摘要（只含 front 摘要，不含答案，控制注入体积）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HighLapseCard {
    pub anki_card_id: String,
    pub front_excerpt: String,
    pub lapses: i32,
    pub template_id: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
}

/// 用户复习画像：制卡生成前从 FSRS 库聚合出的本地统计。
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct UserReviewProfile {
    pub generated_at_ms: i64,
    /// 已入队 FSRS 的卡片总数
    pub total_cards: usize,
    /// 至少复习过一次的卡数
    pub reviewed_cards: usize,
    /// 当前已到期（due_ms <= now）的卡数
    pub due_cards: usize,
    /// 已复习卡的平均可提取性（FSRS 遗忘曲线），空库/无复习为 None
    pub avg_retrievability: Option<f64>,
    pub high_lapse_templates: Vec<TemplateLapseStat>,
    pub confusable_tags: Vec<TagLapseStat>,
    pub high_lapse_cards: Vec<HighLapseCard>,
}

impl UserReviewProfile {
    /// 画像是否没有任何值得注入的信号
    pub fn is_empty(&self) -> bool {
        self.total_cards == 0
    }
}

/// 同批次语义干扰候选：库内与本次材料主题相近的高 lapse 卡。
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InterferenceHint {
    pub anki_card_id: String,
    pub front_excerpt: String,
    pub lapses: i32,
    /// 与本次材料的关键词重叠个数（越大越相关）
    pub overlap_score: usize,
}

/// 高 lapse 卡拆分建议（`suggest_splits` 的输出）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SplitSuggestion {
    pub front: String,
    pub back: String,
    /// 启发式依据（人可读，用于 UI/日志展示）
    pub rationale: String,
}

// ============================================================
// 纯函数：画像构建
// ============================================================

/// 按 FSRS-5 遗忘曲线计算单卡当前可提取性；无复习记录返回 None。
fn card_retrievability(row: &FsrsFeedbackRow, now_ms: i64) -> Option<f64> {
    let stability = row.stability.filter(|s| *s > 0.0)?;
    let last_review_ms = row.last_review_ms?;
    let elapsed_days = ((now_ms - last_review_ms) as f64 / MS_PER_DAY).max(0.0);
    Some(rs_fsrs::Parameters::forgetting_curve(
        elapsed_days,
        stability,
    ))
}

/// 多字节安全的 front 摘要（超长追加省略号）
fn excerpt(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim().replace(['\n', '\r'], " ");
    if trimmed.chars().count() <= max_chars {
        trimmed
    } else {
        let mut cut: String = trimmed.chars().take(max_chars).collect();
        cut.push('…');
        cut
    }
}

/// 从只读行聚合用户复习画像（纯函数，空输入产出空画像）。
pub fn build_profile(
    rows: &[FsrsFeedbackRow],
    now_ms: i64,
    cfg: &FsrsFeedbackConfig,
) -> UserReviewProfile {
    let mut profile = UserReviewProfile {
        generated_at_ms: now_ms,
        total_cards: rows.len(),
        ..Default::default()
    };
    if rows.is_empty() {
        return profile;
    }

    let mut retrievability_sum = 0.0_f64;
    let mut retrievability_count = 0_usize;
    // key -> (cards, due_cards, total_lapses)
    let mut by_template: HashMap<String, (usize, usize, i64)> = HashMap::new();
    let mut by_tag: HashMap<String, (usize, i64)> = HashMap::new();

    for row in rows {
        if row.reps > 0 {
            profile.reviewed_cards += 1;
        }
        let is_due = row.due_ms <= now_ms;
        if is_due {
            profile.due_cards += 1;
        }
        if let Some(r) = card_retrievability(row, now_ms) {
            retrievability_sum += r;
            retrievability_count += 1;
        }

        let template_key = row
            .template_id
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
            .unwrap_or("basic")
            .to_string();
        let entry = by_template.entry(template_key).or_insert((0, 0, 0));
        entry.0 += 1;
        if is_due {
            entry.1 += 1;
        }
        entry.2 += row.lapses.max(0) as i64;

        for tag in &row.tags {
            let tag = tag.trim();
            if tag.is_empty() {
                continue;
            }
            let entry = by_tag.entry(tag.to_string()).or_insert((0, 0));
            entry.0 += 1;
            entry.1 += row.lapses.max(0) as i64;
        }
    }

    if retrievability_count > 0 {
        profile.avg_retrievability = Some(retrievability_sum / retrievability_count as f64);
    }

    // 高 lapse / 高 due 模板：只保留有遗忘信号的，按 total_lapses 降序、due 次序打破平局
    let mut templates: Vec<TemplateLapseStat> = by_template
        .into_iter()
        .filter(|(_, (_, _, total_lapses))| *total_lapses > 0)
        .map(
            |(template_id, (cards, due_cards, total_lapses))| TemplateLapseStat {
                template_id,
                cards,
                due_cards,
                total_lapses,
                avg_lapses: total_lapses as f64 / cards.max(1) as f64,
            },
        )
        .collect();
    templates.sort_by(|a, b| {
        b.total_lapses
            .cmp(&a.total_lapses)
            .then(b.due_cards.cmp(&a.due_cards))
            .then(a.template_id.cmp(&b.template_id))
    });
    templates.truncate(cfg.max_templates);
    profile.high_lapse_templates = templates;

    // 易混淆标签：≥2 张卡且平均 lapse ≥ 1 才视为混淆信号
    let mut tags: Vec<TagLapseStat> = by_tag
        .into_iter()
        .filter(|(_, (cards, total_lapses))| {
            *cards >= 2 && (*total_lapses as f64 / *cards as f64) >= 1.0
        })
        .map(|(tag, (cards, total_lapses))| TagLapseStat {
            tag,
            cards,
            total_lapses,
            avg_lapses: total_lapses as f64 / cards.max(1) as f64,
        })
        .collect();
    tags.sort_by(|a, b| b.total_lapses.cmp(&a.total_lapses).then(a.tag.cmp(&b.tag)));
    tags.truncate(cfg.max_tags);
    profile.confusable_tags = tags;

    // 高遗忘卡片示例（rows 已按 lapses 降序，这里再排序一次以不依赖调用方顺序）
    let mut high_lapse: Vec<&FsrsFeedbackRow> = rows
        .iter()
        .filter(|r| r.lapses >= cfg.min_lapses_for_hint)
        .collect();
    high_lapse.sort_by(|a, b| {
        b.lapses
            .cmp(&a.lapses)
            .then(a.anki_card_id.cmp(&b.anki_card_id))
    });
    profile.high_lapse_cards = high_lapse
        .into_iter()
        .take(cfg.max_high_lapse_cards)
        .map(|r| HighLapseCard {
            anki_card_id: r.anki_card_id.clone(),
            front_excerpt: excerpt(&r.front, cfg.front_excerpt_chars),
            lapses: r.lapses,
            template_id: r.template_id.clone(),
            tags: r.tags.clone(),
        })
        .collect();

    profile
}

// ============================================================
// 纯函数：section 渲染（含字符预算截断）
// ============================================================

/// 渲染「用户复习画像」section；空画像返回 None。
///
/// 隐私（0824 收口）：渲染结果会随生成请求发送到所配置的模型端点，
/// 因此不得声称“数据不上传”；高遗忘卡片正面摘要属历史卡片原文，
/// 仅在 `cfg.include_card_excerpts` 显式开启时渲染。
pub fn render_profile_section(
    profile: &UserReviewProfile,
    cfg: &FsrsFeedbackConfig,
) -> Option<String> {
    if profile.is_empty() {
        return None;
    }
    let mut out = String::new();
    out.push_str("【用户复习画像 · FSRS 统计】\n");
    out.push_str(&format!(
        "- 复习库规模：{} 张已入队，其中 {} 张已复习，{} 张当前到期\n",
        profile.total_cards, profile.reviewed_cards, profile.due_cards
    ));
    if let Some(r) = profile.avg_retrievability {
        out.push_str(&format!("- 平均可提取性（retrievability）：{:.2}\n", r));
    }
    if !profile.high_lapse_templates.is_empty() {
        let items: Vec<String> = profile
            .high_lapse_templates
            .iter()
            .map(|t| {
                format!(
                    "{}（{} 卡 / {} 次遗忘 / {} 张到期，平均 {:.1}）",
                    t.template_id, t.cards, t.total_lapses, t.due_cards, t.avg_lapses
                )
            })
            .collect();
        out.push_str(&format!("- 高遗忘模板：{}\n", items.join("；")));
    }
    if !profile.confusable_tags.is_empty() {
        let items: Vec<String> = profile
            .confusable_tags
            .iter()
            .map(|t| format!("{}（{} 卡 / {} 次遗忘）", t.tag, t.cards, t.total_lapses))
            .collect();
        out.push_str(&format!("- 易混淆标签：{}\n", items.join("；")));
    }
    if cfg.include_card_excerpts && !profile.high_lapse_cards.is_empty() {
        out.push_str("- 高遗忘卡片示例：\n");
        for card in &profile.high_lapse_cards {
            out.push_str(&format!(
                "  · 「{}」（lapses={}）\n",
                card.front_excerpt, card.lapses
            ));
        }
    }
    out.push_str(
        "制卡建议（基于以上画像）：\n\
         - 涉及上述易混淆标签/高遗忘模板的知识点，请拆成更小的原子卡（一卡一问）。\n\
         - 对高遗忘卡对应的概念，优先生成角度不同的强化卡（举例、反例、应用场景），而非重复原表述。\n",
    );

    // 字符预算截断（多字节安全）
    if out.chars().count() > cfg.max_profile_chars {
        let mut cut: String = out
            .chars()
            .take(cfg.max_profile_chars.saturating_sub(1))
            .collect();
        cut.push('…');
        out = cut;
    }
    Some(out)
}

// ============================================================
// 纯函数：同批次语义干扰
// ============================================================

fn is_cjk(ch: char) -> bool {
    matches!(ch,
        '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}'
    )
}

/// 从文本提取关键词集合：拉丁词（≥3 字符，小写）+ CJK 连续段的 bigram。
/// 纯词法启发式，不依赖分词器/embedding，保证零外部依赖与确定性。
pub fn extract_keywords(text: &str, max: usize) -> Vec<String> {
    let mut freq: HashMap<String, usize> = HashMap::new();
    let mut latin = String::new();
    let mut cjk_run: Vec<char> = Vec::new();

    let mut flush_latin = |buf: &mut String, freq: &mut HashMap<String, usize>| {
        if buf.chars().count() >= 3 {
            *freq.entry(buf.to_lowercase()).or_insert(0) += 1;
        }
        buf.clear();
    };
    let mut flush_cjk = |run: &mut Vec<char>, freq: &mut HashMap<String, usize>| {
        if run.len() >= 2 {
            for pair in run.windows(2) {
                let bigram: String = pair.iter().collect();
                *freq.entry(bigram).or_insert(0) += 1;
            }
        }
        run.clear();
    };

    for ch in text.chars() {
        if ch.is_ascii_alphanumeric() {
            flush_cjk(&mut cjk_run, &mut freq);
            latin.push(ch);
        } else if is_cjk(ch) {
            flush_latin(&mut latin, &mut freq);
            cjk_run.push(ch);
        } else {
            flush_latin(&mut latin, &mut freq);
            flush_cjk(&mut cjk_run, &mut freq);
        }
    }
    flush_latin(&mut latin, &mut freq);
    flush_cjk(&mut cjk_run, &mut freq);

    let mut keywords: Vec<(String, usize)> = freq.into_iter().collect();
    keywords.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    keywords.into_iter().take(max).map(|(k, _)| k).collect()
}

/// 对即将生成的材料，从库内高 lapse 卡中挑出语义相近（关键词重叠）的候选。
/// 结果按（重叠分降序，lapses 降序）排序并截断至 `max_interference_cards`。
pub fn build_interference_hints(
    rows: &[FsrsFeedbackRow],
    document_content: &str,
    cfg: &FsrsFeedbackConfig,
) -> Vec<InterferenceHint> {
    if rows.is_empty() || document_content.trim().is_empty() {
        return Vec::new();
    }
    let keywords: HashSet<String> = extract_keywords(document_content, 128)
        .into_iter()
        .collect();
    if keywords.is_empty() {
        return Vec::new();
    }

    let mut hints: Vec<InterferenceHint> = rows
        .iter()
        .filter(|r| r.lapses >= cfg.min_lapses_for_hint)
        .filter_map(|r| {
            let front_keywords: HashSet<String> =
                extract_keywords(&r.front, 64).into_iter().collect();
            let overlap = front_keywords.intersection(&keywords).count();
            if overlap == 0 {
                return None;
            }
            Some(InterferenceHint {
                anki_card_id: r.anki_card_id.clone(),
                front_excerpt: excerpt(&r.front, cfg.front_excerpt_chars),
                lapses: r.lapses,
                overlap_score: overlap,
            })
        })
        .collect();
    hints.sort_by(|a, b| {
        b.overlap_score
            .cmp(&a.overlap_score)
            .then(b.lapses.cmp(&a.lapses))
            .then(a.anki_card_id.cmp(&b.anki_card_id))
    });
    hints.truncate(cfg.max_interference_cards);
    hints
}

/// 渲染「同批次语义干扰预警」section；无候选返回 None。
/// 逐条追加并遵守 `max_interference_chars`：超预算即停止追加后续条目。
///
/// 隐私（0824 收口）：每条条目都是历史卡片正面摘要（卡片原文），
/// 编排入口只在 `cfg.include_card_excerpts` 显式开启时调用本函数。
pub fn render_interference_section(
    hints: &[InterferenceHint],
    cfg: &FsrsFeedbackConfig,
) -> Option<String> {
    if hints.is_empty() {
        return None;
    }
    let header = "【同批次语义干扰预警 · 库内已有的高遗忘近义卡】\n\
         以下卡片与本次材料主题相近且历史遗忘率高：\n\
         - 不要生成与其重复或仅换措辞的卡片；\n\
         - 若新内容与其确实相邻易混，请生成「对比卡」：正面同时呈现两个易混概念并要求区分。\n";
    let mut out = String::from(header);
    for (idx, hint) in hints.iter().enumerate() {
        let line = format!(
            "{}. 「{}」（lapses={}）\n",
            idx + 1,
            hint.front_excerpt,
            hint.lapses
        );
        if out.chars().count() + line.chars().count() > cfg.max_interference_chars {
            break;
        }
        out.push_str(&line);
    }
    Some(out)
}

// ============================================================
// 纯函数：高 lapse 卡拆分建议
// ============================================================

/// 把一张高 lapse 卡启发式拆成更小的原子卡建议。
///
/// 启发式（按优先级）：
/// 1. 答案含枚举列表（`1.`/`1、`/`(1)`/`①`/`-`/`·` 等行首标记，或 ≥3 个分号段）
///    → 每个要点一张卡；
/// 2. 正面是「A 与/和 B 的区别/异同/对比」→ 建议 A、B 各出一张单点卡（对比卡保留原卡）；
/// 3. 答案是 ≥3 句的长段落（>120 字符）→ 拆成「核心结论」+「补充细节」两张卡。
///
/// 无法拆分（已是原子卡）时返回空 Vec。结果截断至 `max_suggestions`。
pub fn suggest_splits(front: &str, back: &str, max_suggestions: usize) -> Vec<SplitSuggestion> {
    let front = front.trim();
    let back = back.trim();
    if front.is_empty() || back.is_empty() || max_suggestions == 0 {
        return Vec::new();
    }

    // --- 启发式 1：枚举列表 ---
    let items = split_enumerated_items(back);
    if items.len() >= 2 {
        let n = items.len();
        let mut out: Vec<SplitSuggestion> = items
            .into_iter()
            .enumerate()
            .map(|(i, item)| SplitSuggestion {
                front: format!("{}（要点 {}/{}）", front, i + 1, n),
                back: item,
                rationale: format!("答案含 {} 个并列要点，逐点拆分可降低单卡记忆负担", n),
            })
            .collect();
        out.truncate(max_suggestions);
        return out;
    }

    // --- 启发式 2：对比型正面 ---
    if let Some((a, b)) = parse_comparison_front(front) {
        let mut out = vec![
            SplitSuggestion {
                front: format!("{} 的关键特征是什么？", a),
                back: back.to_string(),
                rationale: "对比问句先拆成单概念卡，掌握后再复习原对比卡".to_string(),
            },
            SplitSuggestion {
                front: format!("{} 的关键特征是什么？", b),
                back: back.to_string(),
                rationale: "对比问句先拆成单概念卡，掌握后再复习原对比卡".to_string(),
            },
        ];
        out.truncate(max_suggestions);
        return out;
    }

    // --- 启发式 3：长多句答案 ---
    let sentences = split_sentences(back);
    if sentences.len() >= 3 && back.chars().count() > 120 {
        let core = sentences[0].clone();
        let rest = sentences[1..].join("");
        let mut out = vec![
            SplitSuggestion {
                front: format!("{}（核心结论）", front),
                back: core,
                rationale: "长答案先记核心结论".to_string(),
            },
            SplitSuggestion {
                front: format!("{}（补充细节）", front),
                back: rest,
                rationale: "细节独立成卡，避免一次回忆整段".to_string(),
            },
        ];
        out.truncate(max_suggestions);
        return out;
    }

    Vec::new()
}

/// 拆出答案中的枚举要点；识别行首编号/项目符号与「≥3 段分号列表」。
fn split_enumerated_items(back: &str) -> Vec<String> {
    let bullet_items: Vec<String> = back
        .lines()
        .filter_map(|line| {
            let trimmed = line.trim();
            strip_enumeration_marker(trimmed).map(|s| s.to_string())
        })
        .filter(|s| !s.is_empty())
        .collect();
    if bullet_items.len() >= 2 {
        return bullet_items;
    }

    // 分号列表（；或 ;），要求 ≥3 段避免误伤普通复句
    let semi_items: Vec<String> = back
        .split(['；', ';'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if semi_items.len() >= 3 {
        return semi_items;
    }
    Vec::new()
}

/// 去除行首枚举标记；不是枚举行返回 None。
fn strip_enumeration_marker(line: &str) -> Option<&str> {
    const CIRCLED: [char; 10] = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧', '⑨', '⑩'];
    let line = line.trim_start();
    if let Some(first) = line.chars().next() {
        if CIRCLED.contains(&first) {
            return Some(line[first.len_utf8()..].trim_start_matches(['.', '、', '．', ' ']));
        }
        if matches!(first, '-' | '*' | '•' | '·') {
            let rest = line[first.len_utf8()..].trim_start();
            return if rest.is_empty() { None } else { Some(rest) };
        }
    }
    // "1." / "1、" / "1）" / "(1)" 形式
    let unwrapped = line
        .strip_prefix('(')
        .or_else(|| line.strip_prefix('（'))
        .unwrap_or(line);
    let digits: String = unwrapped
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        return None;
    }
    let after = &unwrapped[digits.len()..];
    let mut chars = after.chars();
    match chars.next() {
        Some(sep) if matches!(sep, '.' | '、' | '．' | ')' | '）' | '：' | ':') => {
            let rest = after[sep.len_utf8()..].trim_start();
            if rest.is_empty() {
                None
            } else {
                Some(rest)
            }
        }
        _ => None,
    }
}

/// 识别「A 与/和 B 的区别/异同/对比」型正面，返回 (A, B)。
fn parse_comparison_front(front: &str) -> Option<(String, String)> {
    let marker_pos = ["的区别", "的异同", "的对比", "有什么区别", "有何区别"]
        .iter()
        .filter_map(|m| front.find(m))
        .min()?;
    let head = &front[..marker_pos];
    for conj in ["与", "和", "跟", " vs ", " VS "] {
        if let Some(pos) = head.find(conj) {
            let a = head[..pos].trim().trim_start_matches(['「', '"']);
            let b = head[pos + conj.len()..]
                .trim()
                .trim_end_matches(['」', '"']);
            if !a.is_empty() && !b.is_empty() {
                return Some((a.to_string(), b.to_string()));
            }
        }
    }
    None
}

/// 按中英文句末标点切句（保留标点）。
fn split_sentences(text: &str) -> Vec<String> {
    let mut sentences = Vec::new();
    let mut current = String::new();
    for ch in text.chars() {
        current.push(ch);
        if matches!(ch, '。' | '！' | '？' | '.' | '!' | '?') {
            if !current.trim().is_empty() {
                sentences.push(current.clone());
            }
            current.clear();
        }
    }
    if !current.trim().is_empty() {
        sentences.push(current);
    }
    sentences
}

// ============================================================
// 编排入口（含降级）
// ============================================================

/// 从 FSRS 库构建用户复习画像；任何查询失败降级为空画像（绝不报错）。
pub fn build_user_review_profile(
    db: &Arc<Database>,
    cfg: &FsrsFeedbackConfig,
) -> UserReviewProfile {
    let now_ms = chrono::Utc::now().timestamp_millis();
    match FsrsReviewService::new(db.clone()).list_feedback_rows(cfg.scan_limit) {
        Ok(rows) => build_profile(&rows, now_ms, cfg),
        Err(e) => {
            warn!("FSRS 反馈回流查询失败，降级为空画像: {}", e);
            UserReviewProfile {
                generated_at_ms: now_ms,
                ..Default::default()
            }
        }
    }
}

/// 制卡生成前的唯一编排入口：查询 → 画像 + 干扰预警 → 渲染合并。
///
/// 返回 `None` 表示无可注入内容（空库 / 查询失败 / 无信号），调用方直接跳过注入。
pub fn build_feedback_injection(
    db: &Arc<Database>,
    document_content: &str,
    cfg: &FsrsFeedbackConfig,
) -> Option<String> {
    let rows = match FsrsReviewService::new(db.clone()).list_feedback_rows(cfg.scan_limit) {
        Ok(rows) => rows,
        Err(e) => {
            warn!("FSRS 反馈回流查询失败，本次制卡不注入复习画像: {}", e);
            return None;
        }
    };
    if rows.is_empty() {
        return None;
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    let profile = build_profile(&rows, now_ms, cfg);

    let mut sections: Vec<String> = Vec::new();
    if let Some(section) = render_profile_section(&profile, cfg) {
        sections.push(section);
    }
    // 干扰预警条目全部是历史卡片正面摘要（卡片原文），默认不外送；
    // 仅在调用方显式开启 include_card_excerpts 时构建并注入。
    if cfg.include_card_excerpts {
        let hints = build_interference_hints(&rows, document_content, cfg);
        if let Some(section) = render_interference_section(&hints, cfg) {
            sections.push(section);
        }
    }
    if sections.is_empty() {
        None
    } else {
        Some(sections.join("\n"))
    }
}

// ============================================================
// 单元测试（纯函数，无 DB）
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[allow(clippy::too_many_arguments)]
    fn make_row(
        id: &str,
        front: &str,
        template_id: Option<&str>,
        tags: &[&str],
        lapses: i32,
        reps: i32,
        stability: Option<f64>,
        due_ms: i64,
        last_review_ms: Option<i64>,
    ) -> FsrsFeedbackRow {
        FsrsFeedbackRow {
            anki_card_id: id.to_string(),
            front: front.to_string(),
            template_id: template_id.map(|s| s.to_string()),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            state: if reps > 0 { 2 } else { 0 },
            stability,
            lapses,
            reps,
            due_ms,
            last_review_ms,
        }
    }

    fn cfg() -> FsrsFeedbackConfig {
        FsrsFeedbackConfig::default()
    }

    // 1. 画像序列化：camelCase 键 + roundtrip
    #[test]
    fn profile_serialization_roundtrip_camel_case() {
        let rows = vec![make_row(
            "c1",
            "牛顿第二定律的内容是什么？",
            Some("basic-choice"),
            &["力学", "牛顿定律"],
            4,
            6,
            Some(3.0),
            0,
            Some(0),
        )];
        let profile = build_profile(&rows, 1_000_000, &cfg());
        let json = serde_json::to_string(&profile).expect("serialize");
        assert!(json.contains("avgRetrievability"), "camelCase 键: {json}");
        assert!(json.contains("highLapseTemplates"));
        assert!(json.contains("confusableTags"));
        let back: UserReviewProfile = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, profile);
    }

    // 2. 空库 → 空画像，渲染为 None
    #[test]
    fn empty_rows_yield_empty_profile_and_no_section() {
        let profile = build_profile(&[], 123, &cfg());
        assert!(profile.is_empty());
        assert_eq!(profile.total_cards, 0);
        assert_eq!(profile.avg_retrievability, None);
        assert_eq!(render_profile_section(&profile, &cfg()), None);
    }

    // 3. 平均可提取性：stability=5 且 5 天前复习 → FSRS-5 曲线精确 0.9
    #[test]
    fn avg_retrievability_matches_fsrs_forgetting_curve() {
        let now_ms = 10 * 86_400_000_i64;
        let five_days_ago = now_ms - 5 * 86_400_000;
        let rows = vec![make_row(
            "c1",
            "front",
            None,
            &[],
            0,
            3,
            Some(5.0),
            now_ms + 1,
            Some(five_days_ago),
        )];
        let profile = build_profile(&rows, now_ms, &cfg());
        let r = profile.avg_retrievability.expect("retrievability");
        assert!((r - 0.9).abs() < 1e-9, "expected 0.9, got {r}");
        // 未复习的卡不计入平均
        let rows2 = vec![
            rows[0].clone(),
            make_row("c2", "new", None, &[], 0, 0, None, 0, None),
        ];
        let profile2 = build_profile(&rows2, now_ms, &cfg());
        assert!((profile2.avg_retrievability.unwrap() - 0.9).abs() < 1e-9);
    }

    // 4. 高 lapse 模板：排序 + max_templates 截断，无模板归入 basic
    #[test]
    fn template_stats_sorted_and_capped() {
        let mut rows = Vec::new();
        for i in 0..4 {
            rows.push(make_row(
                &format!("a{i}"),
                "f",
                Some("tmpl-heavy"),
                &[],
                5,
                6,
                Some(2.0),
                0,
                Some(0),
            ));
        }
        rows.push(make_row(
            "b1",
            "f",
            Some("tmpl-light"),
            &[],
            1,
            2,
            Some(2.0),
            0,
            Some(0),
        ));
        rows.push(make_row("c1", "f", None, &[], 2, 3, Some(2.0), 0, Some(0)));

        let mut config = cfg();
        config.max_templates = 2;
        let profile = build_profile(&rows, 1, &config);
        assert_eq!(profile.high_lapse_templates.len(), 2);
        assert_eq!(profile.high_lapse_templates[0].template_id, "tmpl-heavy");
        assert_eq!(profile.high_lapse_templates[0].total_lapses, 20);
        assert_eq!(profile.high_lapse_templates[0].cards, 4);
        // basic(2) > tmpl-light(1)
        assert_eq!(profile.high_lapse_templates[1].template_id, "basic");
    }

    // 5. 易混淆标签：需 ≥2 卡且平均 lapse ≥1；排序 + 截断
    #[test]
    fn confusable_tags_filtered_sorted_capped() {
        let rows = vec![
            make_row(
                "c1",
                "f",
                None,
                &["三角函数", "数学"],
                4,
                5,
                Some(2.0),
                0,
                Some(0),
            ),
            make_row("c2", "f", None, &["三角函数"], 3, 4, Some(2.0), 0, Some(0)),
            make_row("c3", "f", None, &["数学"], 0, 1, Some(2.0), 0, Some(0)),
            // 单卡标签不足以构成"混淆"
            make_row("c4", "f", None, &["孤儿标签"], 9, 9, Some(2.0), 0, Some(0)),
        ];
        let profile = build_profile(&rows, 1, &cfg());
        let tags: Vec<&str> = profile
            .confusable_tags
            .iter()
            .map(|t| t.tag.as_str())
            .collect();
        assert_eq!(tags, vec!["三角函数", "数学"]);
        assert_eq!(profile.confusable_tags[0].total_lapses, 7);
        assert_eq!(profile.confusable_tags[0].cards, 2);

        let mut config = cfg();
        config.max_tags = 1;
        let capped = build_profile(&rows, 1, &config);
        assert_eq!(capped.confusable_tags.len(), 1);
    }

    // 6. 画像渲染遵守字符预算（token 预算截断）
    #[test]
    fn profile_section_respects_char_budget() {
        let rows: Vec<FsrsFeedbackRow> = (0..20)
            .map(|i| {
                make_row(
                    &format!("c{i}"),
                    &format!(
                        "这是一张非常长的高遗忘卡片正面内容，编号 {i}，用于测试字符预算截断行为"
                    ),
                    Some(&format!("tmpl-{i}")),
                    &["标签A", "标签B"],
                    5,
                    6,
                    Some(2.0),
                    0,
                    Some(0),
                )
            })
            .collect();
        let mut config = cfg();
        config.max_profile_chars = 200;
        config.include_card_excerpts = true;
        let profile = build_profile(&rows, 1, &config);
        let section = render_profile_section(&profile, &config).expect("section");
        assert!(
            section.chars().count() <= 200,
            "len={}",
            section.chars().count()
        );
        assert!(section.ends_with('…'));
        // 预算充足时不截断
        let mut wide = cfg();
        wide.max_profile_chars = 100_000;
        wide.include_card_excerpts = true;
        let full = render_profile_section(&profile, &wide).expect("full");
        assert!(!full.ends_with('…'));
        assert!(full.contains("易混淆标签"));
    }

    // 6b. 隐私默认（0824 收口）：默认配置不渲染历史卡片正面摘要，
    //     只有显式开启 include_card_excerpts 才包含；且渲染文案不再声称「不上传」。
    #[test]
    fn profile_section_excludes_card_excerpts_by_default() {
        let rows = vec![make_row(
            "c1",
            "线粒体是细胞的能量工厂吗？",
            Some("basic"),
            &["生物"],
            5,
            6,
            Some(2.0),
            0,
            Some(0),
        )];
        let profile = build_profile(&rows, 1, &cfg());
        assert!(!profile.high_lapse_cards.is_empty(), "画像数据本身仍聚合");

        // 默认：匿名聚合可渲染，但卡片原文摘要不出现
        let default_cfg = cfg();
        assert!(!default_cfg.include_card_excerpts, "默认必须不含卡片原文");
        let section = render_profile_section(&profile, &default_cfg).expect("section");
        assert!(!section.contains("高遗忘卡片示例"), "{section}");
        assert!(!section.contains("线粒体"), "{section}");
        assert!(!section.contains("不上传"), "不得虚假承诺: {section}");
        assert!(!section.contains("仅本地"), "不得虚假承诺: {section}");

        // 显式开启后才包含摘要
        let mut opted_in = cfg();
        opted_in.include_card_excerpts = true;
        let full = render_profile_section(&profile, &opted_in).expect("full");
        assert!(full.contains("高遗忘卡片示例"));
        assert!(full.contains("线粒体"));

        // 干扰预警文案同样不得声称「仅本地」
        let hints = build_interference_hints(&rows, "线粒体与能量代谢", &opted_in);
        let interference = render_interference_section(&hints, &opted_in).expect("interference");
        assert!(!interference.contains("仅本地"), "{interference}");
        assert!(!interference.contains("不上传"), "{interference}");
    }

    // 7. front 摘要多字节安全截断
    #[test]
    fn front_excerpt_is_multibyte_safe() {
        let long_front = "微积分基本定理说明了导数与积分之间的互逆关系，且适用于连续函数".repeat(3);
        let e = excerpt(&long_front, 10);
        assert_eq!(e.chars().count(), 11); // 10 字 + 省略号
        assert!(e.ends_with('…'));
        assert_eq!(excerpt("短", 10), "短");
    }

    // 8. 关键词提取：CJK bigram + 拉丁词
    #[test]
    fn extract_keywords_handles_cjk_and_latin() {
        let kws = extract_keywords("牛顿第二定律 Newton force 定律", 50);
        assert!(kws.contains(&"牛顿".to_string()));
        assert!(kws.contains(&"定律".to_string()));
        assert!(kws.contains(&"newton".to_string()));
        assert!(kws.contains(&"force".to_string()));
        // 短拉丁词（<3 字符）不收
        assert!(!extract_keywords("a an of", 50).iter().any(|k| k == "an"));
        // 空文本
        assert!(extract_keywords("", 50).is_empty());
    }

    // 9. 干扰候选：关键词重叠命中高 lapse 卡，低 lapse 卡排除
    #[test]
    fn interference_hints_match_by_keyword_overlap() {
        let rows = vec![
            make_row(
                "hit",
                "牛顿第二定律的表达式是什么？",
                None,
                &[],
                5,
                6,
                Some(2.0),
                0,
                Some(0),
            ),
            make_row(
                "low",
                "牛顿第二定律适用条件？",
                None,
                &[],
                0,
                1,
                Some(2.0),
                0,
                Some(0),
            ),
            make_row(
                "miss",
                "光合作用的暗反应发生在哪里？",
                None,
                &[],
                7,
                8,
                Some(2.0),
                0,
                Some(0),
            ),
        ];
        let hints = build_interference_hints(&rows, "本章讲解牛顿第二定律及其应用", &cfg());
        let ids: Vec<&str> = hints.iter().map(|h| h.anki_card_id.as_str()).collect();
        assert_eq!(ids, vec!["hit"], "只命中高 lapse 且语义相近的卡: {ids:?}");
        assert!(hints[0].overlap_score > 0);
        // 空文档内容 → 无候选
        assert!(build_interference_hints(&rows, "  ", &cfg()).is_empty());
    }

    // 10. 干扰列表上限（max_interference_cards）
    #[test]
    fn interference_hints_capped_at_limit() {
        let rows: Vec<FsrsFeedbackRow> = (0..20)
            .map(|i| {
                make_row(
                    &format!("c{i:02}"),
                    "细胞呼吸的三个阶段分别是什么？",
                    None,
                    &[],
                    3 + i,
                    5,
                    Some(2.0),
                    0,
                    Some(0),
                )
            })
            .collect();
        let mut config = cfg();
        config.max_interference_cards = 4;
        let hints = build_interference_hints(&rows, "细胞呼吸与能量代谢", &config);
        assert_eq!(hints.len(), 4);
        // lapses 高的排前面（overlap 相同）
        assert_eq!(hints[0].anki_card_id, "c19");
    }

    // 11. 干扰渲染遵守字符预算：超预算停止追加条目
    #[test]
    fn interference_section_respects_char_budget() {
        let hints: Vec<InterferenceHint> = (0..10)
            .map(|i| InterferenceHint {
                anki_card_id: format!("c{i}"),
                front_excerpt: "这是一条比较长的高遗忘卡片正面摘要用于测试预算".to_string(),
                lapses: 5,
                overlap_score: 3,
            })
            .collect();
        let mut config = cfg();
        config.max_interference_chars = 260;
        let section = render_interference_section(&hints, &config).expect("section");
        assert!(section.chars().count() <= 260);
        // 至少保留 header，且不是全部 10 条
        assert!(section.contains("同批次语义干扰预警"));
        assert!(section.matches("lapses=").count() < 10);
        // 空候选 → None
        assert_eq!(render_interference_section(&[], &config), None);
    }

    // 12. suggest_splits：枚举答案拆成原子卡
    #[test]
    fn suggest_splits_enumerated_back() {
        let back = "1. 糖酵解发生在细胞质基质\n2. 丙酮酸氧化脱羧发生在线粒体基质\n3. 三羧酸循环也在线粒体基质";
        let out = suggest_splits("细胞呼吸的三个阶段及场所？", back, 10);
        assert_eq!(out.len(), 3);
        assert!(out[0].front.contains("要点 1/3"));
        assert_eq!(out[1].back, "丙酮酸氧化脱羧发生在线粒体基质");
        assert!(out[0].rationale.contains("并列要点"));
        // max_suggestions 截断
        assert_eq!(suggest_splits("q", back, 2).len(), 2);
    }

    // 13. suggest_splits：分号列表 + 对比型正面
    #[test]
    fn suggest_splits_semicolons_and_comparison() {
        let semi = suggest_splits("酶的特性？", "高效性；专一性；作用条件温和", 10);
        assert_eq!(semi.len(), 3);
        assert_eq!(semi[2].back, "作用条件温和");

        let cmp = suggest_splits("有丝分裂与减数分裂的区别？", "染色体行为不同等等", 10);
        assert_eq!(cmp.len(), 2);
        assert!(cmp[0].front.contains("有丝分裂"));
        assert!(cmp[1].front.contains("减数分裂"));
    }

    // 14. suggest_splits：长多句答案拆两卡；原子卡不拆
    #[test]
    fn suggest_splits_long_back_and_atomic_noop() {
        let long_back = "细胞膜主要由磷脂双分子层构成，磷脂分子的疏水尾部相对、亲水头部朝外，构成了膜的基本骨架结构。膜上镶嵌、贯穿或附着多种蛋白质，这些蛋白质承担物质运输、信号转导以及细胞间信息交流等重要功能。此外细胞膜还含有少量糖类，以糖蛋白或糖脂的形式存在于细胞膜外表面，参与细胞识别和免疫应答等过程。";
        let out = suggest_splits("细胞膜的组成？", long_back, 10);
        assert_eq!(out.len(), 2);
        assert!(out[0].front.contains("核心结论"));
        assert!(out[1].front.contains("补充细节"));

        // 原子卡：单句短答案 → 无建议
        assert!(suggest_splits("水的化学式？", "H2O。", 10).is_empty());
        // 空输入
        assert!(suggest_splits("", "back", 10).is_empty());
        assert!(suggest_splits("front", "", 10).is_empty());
    }

    // 15. 枚举标记解析边界
    #[test]
    fn enumeration_marker_variants() {
        assert_eq!(strip_enumeration_marker("1. 第一点"), Some("第一点"));
        assert_eq!(strip_enumeration_marker("2、第二点"), Some("第二点"));
        assert_eq!(strip_enumeration_marker("(3) 第三点"), Some("第三点"));
        assert_eq!(strip_enumeration_marker("① 圈号"), Some("圈号"));
        assert_eq!(strip_enumeration_marker("- 短横"), Some("短横"));
        assert_eq!(strip_enumeration_marker("普通句子"), None);
        assert_eq!(strip_enumeration_marker("2026年"), None);
    }

    // 16. 配置默认值 + 序列化
    #[test]
    fn config_defaults_are_sane_and_serializable() {
        let c = FsrsFeedbackConfig::default();
        assert!(c.scan_limit >= 100);
        assert!(c.min_lapses_for_hint >= 1);
        assert!(c.max_interference_cards > 0 && c.max_interference_cards <= 20);
        assert!(c.max_profile_chars >= 200);
        let json = serde_json::to_string(&c).expect("serialize config");
        assert!(json.contains("maxInterferenceCards"));
        let back: FsrsFeedbackConfig = serde_json::from_str(&json).expect("roundtrip");
        assert_eq!(back.scan_limit, c.scan_limit);
    }

    // 17. due 统计与 reviewed 统计
    #[test]
    fn due_and_reviewed_counters() {
        let now = 1_000_000_i64;
        let rows = vec![
            make_row("due1", "f", None, &[], 0, 2, Some(2.0), now - 1, Some(0)),
            make_row("due2", "f", None, &[], 0, 2, Some(2.0), now, Some(0)),
            make_row("future", "f", None, &[], 0, 2, Some(2.0), now + 1, Some(0)),
            make_row("new", "f", None, &[], 0, 0, None, now - 1, None),
        ];
        let profile = build_profile(&rows, now, &cfg());
        assert_eq!(profile.total_cards, 4);
        assert_eq!(profile.due_cards, 3);
        assert_eq!(profile.reviewed_cards, 3);
    }
}
