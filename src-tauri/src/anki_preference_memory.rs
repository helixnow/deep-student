//! 用户制卡偏好记忆（Mem0 风格，ADD-only 简化版）
//!
//! 目标：从用户在制卡会话中的真实行为（编辑前后 diff、删卡、extraRequirements
//! 显式要求）确定性地抽取长期偏好，并在下一次制卡时以极短的 prompt 片段注入，
//! 让生成结果逐次贴近用户习惯。
//!
//! # 设计取舍
//!
//! - **纯逻辑、零 I/O、零 LLM**：本模块只做「观察 → 候选偏好 → 合并 → 检索」
//!   的纯函数变换。生产持久化由 ChatAnki executor 负责：从本地主库 settings key
//!   `chatanki_preference_memory_store` 读取，调用 [`consolidate_observation`] 后写回。
//!   settings 读取、解析或写入失败时，executor 只记录告警，不回滚或阻断制卡操作。
//! - **ADD-only**：与 Mem0 的 ADD/UPDATE/DELETE 操作集不同，本版抽取器只产出
//!   ADD 语义——[`consolidate`] 对已有条目绝不改写语句、绝不删除；重复观察
//!   只累计证据数并小幅提升置信度。互相矛盾的偏好（如先偏好中文后偏好英文）
//!   会以两条独立条目共存，由检索层按分数择一注入，避免误删仍然有效的记忆。
//!   （唯一例外是容量维护：条目超过 [`MAX_STORE_ENTRIES`] 时淘汰最低分条目，
//!   这是存储层策略，不属于抽取语义。）
//! - **token 预算**：注入 prompt 必须极短。[`retrieve_preference_prompt`] 接受
//!   预算参数，按「每 kind 取最高分一条 → 按分数降序装箱」的方式裁剪，
//!   估算规则见 [`estimate_tokens`]。
//!
//! # 典型调用序列
//!
//! ```text
//! 会话结束时：
//!   consolidate_observation(&mut store, &observation, now_ms);
//!   persist(store); // 调用方持久化到本地 settings
//! 下次 chatanki_run 时：
//!   let hint = retrieve_preference_prompt(&store, &goal, &template_names, 120);
//!   if !hint.is_empty() { requirements.push(hint); }
//! ```

use serde::{Deserialize, Serialize};

/// 偏好条目上限。超过后淘汰得分最低的条目（容量维护，非抽取语义）。
pub const MAX_STORE_ENTRIES: usize = 64;

/// 检索注入的默认 token 预算（约 3-4 行短句）。
pub const DEFAULT_PROMPT_TOKEN_BUDGET: usize = 120;

/// 置信度上限：证据再多也不允许把启发式抽取的偏好当成绝对事实。
const CONFIDENCE_CAP: f32 = 0.95;

/// 判定「编辑显著改变语言」的 CJK 占比变化阈值。
const LANGUAGE_SHIFT_THRESHOLD: f32 = 0.25;

/// 判定「删卡比例高 → 用户嫌卡太密」的删除比例阈值。
const DELETION_DENSITY_THRESHOLD: f32 = 0.3;

/// 删卡密度信号要求的最小生成卡数（样本太小不足以下结论）。
const DELETION_MIN_GENERATED: usize = 5;

// ---------------------------------------------------------------------------
// 输入：会话观察
// ---------------------------------------------------------------------------

/// 一次字段编辑观察（用户把某张卡的某个字段从 before 改成 after）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardEditObservation {
    /// 字段名（"front" / "back" / 模板扩展字段名）。
    pub field: String,
    pub before: String,
    pub after: String,
}

/// 一次删卡观察（记录被删卡的正反面，用于后续密度/内容信号）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CardDeleteObservation {
    pub front: String,
    pub back: String,
}

/// 一个制卡会话结束后收集到的全部行为观察。
///
/// 全部字段可为空/零值；抽取器对缺失信号一律保守（不产出候选）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SessionObservation {
    /// 用户在 run/start 时传入的显式补充要求（最强信号）。
    pub extra_requirements: Option<String>,
    /// 用户对生成卡片的编辑（before/after diff）。
    pub edits: Vec<CardEditObservation>,
    /// 用户删除的生成卡。
    pub deletions: Vec<CardDeleteObservation>,
    /// 本会话生成的卡片总数（删除比例的分母）。
    pub generated_count: usize,
    /// 用户主动选择/换到的模板名（None 表示未表达模板意愿）。
    pub template_used: Option<String>,
}

// ---------------------------------------------------------------------------
// 偏好模型
// ---------------------------------------------------------------------------

/// 偏好类别。检索时每类最多注入一条，保证 prompt 极短且无内部矛盾。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PreferenceKind {
    /// 卡片正文/答案语言（subject: "zh" / "en"）。
    Language,
    /// 卡片密度（subject: 数字上限或 None 表示定性「少而精」）。
    CardDensity,
    /// 禁止翻译 / 保留术语原文。
    NoTranslation,
    /// 模板偏好（subject: 模板名）。
    TemplatePreference,
}

/// 抽取阶段产出的候选偏好（尚未进入存储）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreferenceCandidate {
    pub kind: PreferenceKind,
    /// 可直接注入 prompt 的一句话偏好描述（中文短句）。
    pub statement: String,
    /// 结构化主体：语言代码 / 数量 / 模板名，供检索匹配用。
    pub subject: Option<String>,
    /// 抽取置信度 [0,1]：显式要求 > 重复编辑行为 > 单次统计信号。
    pub confidence: f32,
    /// 人可读的证据说明，用于审计与调试。
    pub evidence: String,
}

/// 存储中的偏好条目（候选 + 证据计数 + 时间戳）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PreferenceEntry {
    pub kind: PreferenceKind,
    pub statement: String,
    pub subject: Option<String>,
    pub confidence: f32,
    /// 该偏好被独立观察到的次数（重复观察 → 强化）。
    pub evidence_count: u32,
    /// 最近一次证据说明（ADD-only：语句不改写，证据允许刷新）。
    pub last_evidence: String,
    pub first_seen_ms: i64,
    pub last_seen_ms: i64,
}

/// 偏好存储。调用方负责序列化到磁盘/DB（`serde` 直接可用）。
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct PreferenceStore {
    pub entries: Vec<PreferenceEntry>,
}

/// [`consolidate`] 的结果摘要。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ConsolidateOutcome {
    /// 新增条目的语句。
    pub added: Vec<String>,
    /// 被强化（证据 +1）条目的语句。
    pub reinforced: Vec<String>,
    /// 因容量维护被淘汰条目的语句。
    pub evicted: Vec<String>,
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x4E00..=0x9FFF     // CJK 统一表意
        | 0x3400..=0x4DBF   // 扩展 A
        | 0xF900..=0xFAFF   // 兼容表意
        | 0x3040..=0x30FF   // 日文假名（同属「非拉丁」信号）
    )
}

/// 非空白字符中 CJK 的占比；空串返回 0。
fn cjk_ratio(text: &str) -> f32 {
    let mut cjk = 0usize;
    let mut total = 0usize;
    for c in text.chars() {
        if c.is_whitespace() {
            continue;
        }
        total += 1;
        if is_cjk(c) {
            cjk += 1;
        }
    }
    if total == 0 {
        0.0
    } else {
        cjk as f32 / total as f32
    }
}

/// 粗略 token 估算：CJK 每字 1 token，其余字符按 4 字符 ≈ 1 token。
///
/// 刻意偏保守（高估）：预算裁剪宁可少注入一行，也不要挤占正文预算。
pub fn estimate_tokens(text: &str) -> usize {
    let mut cjk = 0usize;
    let mut other = 0usize;
    for c in text.chars() {
        if c.is_whitespace() {
            continue;
        }
        if is_cjk(c) {
            cjk += 1;
        } else {
            other += 1;
        }
    }
    cjk + (other + 3) / 4
}

/// 归一化去重键：小写 + 去空白/常见标点，避免同义句因标点差异重复入库。
fn normalized_key(kind: PreferenceKind, statement: &str, subject: Option<&str>) -> String {
    let normalize = |s: &str| -> String {
        s.chars()
            .filter(|c| !c.is_whitespace() && !"，。、；;：:！!？?「」“”\"'（）()".contains(*c))
            .flat_map(char::to_lowercase)
            .collect()
    };
    format!(
        "{:?}|{}|{}",
        kind,
        normalize(statement),
        subject.map(normalize).unwrap_or_default()
    )
}

/// 提取 ASCII 术语（≥3 个字母的单词），转小写；过滤常见英文虚词。
fn ascii_terms(text: &str) -> Vec<String> {
    const STOPWORDS: &[&str] = &[
        "the", "and", "for", "with", "that", "this", "are", "was", "were", "have", "has", "not",
        "you", "can", "will", "from", "into", "when", "what", "which",
    ];
    let mut out = Vec::new();
    let mut current = String::new();
    for c in text.chars() {
        if c.is_ascii_alphabetic() {
            current.push(c.to_ascii_lowercase());
        } else {
            if current.len() >= 3 && !STOPWORDS.contains(&current.as_str()) {
                out.push(std::mem::take(&mut current));
            } else {
                current.clear();
            }
        }
    }
    if current.len() >= 3 && !STOPWORDS.contains(&current.as_str()) {
        out.push(current);
    }
    out
}

// ---------------------------------------------------------------------------
// 抽取：extraRequirements 显式信号
// ---------------------------------------------------------------------------

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|n| haystack.contains(n))
}

fn extract_from_extra_requirements(raw: &str, out: &mut Vec<PreferenceCandidate>) {
    let text = raw.trim();
    if text.is_empty() {
        return;
    }
    let lower = text.to_lowercase();

    // 语言偏好：中英信号同时出现视为歧义，保守放弃。
    let wants_zh = contains_any(
        &lower,
        &[
            "用中文",
            "中文回答",
            "中文作答",
            "答案用中文",
            "中文解释",
            "in chinese",
        ],
    );
    let wants_en = contains_any(
        &lower,
        &["用英文", "英文回答", "英文作答", "全英文", "in english"],
    );
    if wants_zh != wants_en {
        let (subject, statement) = if wants_zh {
            ("zh", "卡片正文与答案使用中文书写")
        } else {
            ("en", "卡片正文与答案使用英文书写")
        };
        out.push(PreferenceCandidate {
            kind: PreferenceKind::Language,
            statement: statement.to_string(),
            subject: Some(subject.to_string()),
            confidence: 0.9,
            evidence: "extraRequirements 显式指定语言".to_string(),
        });
    }

    // 禁止翻译 / 保留原文。
    if contains_any(
        &lower,
        &[
            "不要翻译",
            "不翻译",
            "禁止翻译",
            "保留英文",
            "保留原文",
            "保留术语",
            "术语不译",
            "do not translate",
            "don't translate",
            "keep the original",
            "keep original",
        ],
    ) {
        out.push(PreferenceCandidate {
            kind: PreferenceKind::NoTranslation,
            statement: "专业术语保留原文，不要翻译".to_string(),
            subject: None,
            confidence: 0.9,
            evidence: "extraRequirements 显式要求不翻译/保留原文".to_string(),
        });
    }

    // 卡密度：数字上限优先，其次定性「少而精」。
    let numeric_limit = regex::Regex::new(r"(?:最多|不超过)\s*(\d{1,3})\s*张")
        .ok()
        .and_then(|re| {
            re.captures(&lower)
                .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
        })
        .or_else(|| {
            regex::Regex::new(r"(?:at most|no more than|max(?:imum)?(?: of)?)\s*(\d{1,3})\s*cards?")
                .ok()
                .and_then(|re| {
                    re.captures(&lower)
                        .and_then(|c| c.get(1).map(|m| m.as_str().to_string()))
                })
        });
    if let Some(limit) = numeric_limit {
        out.push(PreferenceCandidate {
            kind: PreferenceKind::CardDensity,
            statement: format!("控制卡片数量：每份材料不超过 {} 张", limit),
            subject: Some(limit),
            confidence: 0.9,
            evidence: "extraRequirements 显式限制卡片数量".to_string(),
        });
    } else if contains_any(
        &lower,
        &[
            "少而精",
            "宁缺毋滥",
            "不要太多卡",
            "卡片少一点",
            "fewer cards",
        ],
    ) {
        out.push(PreferenceCandidate {
            kind: PreferenceKind::CardDensity,
            statement: "控制卡片密度：少而精，避免把同一知识点拆成大量浅层卡片".to_string(),
            subject: None,
            confidence: 0.85,
            evidence: "extraRequirements 表达了少而精的密度倾向".to_string(),
        });
    }

    // 模板偏好：匹配「用/使用 X 模板」，带否定前缀（不/别/勿/免）时跳过。
    if let Ok(re) = regex::Regex::new(
        r#"(?:请用|使用|用)\s*[「“"']?([^「」“”"'\s，。,；;.!？?]{1,24}?)[」”"']?\s*模板"#,
    ) {
        if let Some(caps) = re.captures(text) {
            let matched = caps.get(0).unwrap();
            let prefix: String = text[..matched.start()].chars().rev().take(2).collect();
            let negated = prefix
                .chars()
                .any(|c| matches!(c, '不' | '别' | '勿' | '免'));
            if !negated {
                if let Some(name) = caps.get(1).map(|m| m.as_str().trim()) {
                    if !name.is_empty() {
                        out.push(PreferenceCandidate {
                            kind: PreferenceKind::TemplatePreference,
                            statement: format!("优先使用「{}」模板", name),
                            subject: Some(name.to_string()),
                            confidence: 0.9,
                            evidence: "extraRequirements 显式指定模板".to_string(),
                        });
                    }
                }
            }
        }
    }
    if let Ok(re) = regex::Regex::new(r#"(?i)use\s+(?:the\s+)?"?([a-z0-9 _-]{1,32}?)"?\s+template"#)
    {
        if let Some(caps) = re.captures(text) {
            if let Some(name) = caps.get(1).map(|m| m.as_str().trim()) {
                if !name.is_empty()
                    && !out
                        .iter()
                        .any(|c| c.kind == PreferenceKind::TemplatePreference)
                {
                    out.push(PreferenceCandidate {
                        kind: PreferenceKind::TemplatePreference,
                        statement: format!("优先使用「{}」模板", name),
                        subject: Some(name.to_string()),
                        confidence: 0.9,
                        evidence: "extraRequirements 显式指定模板".to_string(),
                    });
                }
            }
        }
    }
}

// ---------------------------------------------------------------------------
// 抽取：编辑 diff 信号
// ---------------------------------------------------------------------------

fn extract_from_edits(edits: &[CardEditObservation], out: &mut Vec<PreferenceCandidate>) {
    let mut to_zh = 0usize;
    let mut to_en = 0usize;
    let mut reinstated_terms: Vec<String> = Vec::new();
    let mut reinstating_edits = 0usize;

    for edit in edits {
        let before = edit.before.trim();
        let after = edit.after.trim();
        if before.is_empty() || after.is_empty() || before == after {
            continue;
        }

        // 语言迁移：CJK 占比显著变化。
        let delta = cjk_ratio(after) - cjk_ratio(before);
        if delta >= LANGUAGE_SHIFT_THRESHOLD {
            to_zh += 1;
        } else if delta <= -LANGUAGE_SHIFT_THRESHOLD {
            to_en += 1;
        }

        // 术语回写：混排文本（CJK ≥ 20%）里，after 新增了 before 没有的 ASCII 术语，
        // 说明用户把被翻译掉的原文术语改了回来。
        if cjk_ratio(after) >= 0.2 {
            let before_terms = ascii_terms(before);
            let mut edit_added = false;
            for term in ascii_terms(after) {
                if !before_terms.contains(&term) && !reinstated_terms.contains(&term) {
                    reinstated_terms.push(term);
                    edit_added = true;
                }
            }
            if edit_added {
                reinstating_edits += 1;
            }
        }
    }

    // 语言偏好：至少 2 次同向改写，且方向占优。
    if to_zh >= 2 && to_zh > to_en {
        out.push(PreferenceCandidate {
            kind: PreferenceKind::Language,
            statement: "卡片正文与答案使用中文书写".to_string(),
            subject: Some("zh".to_string()),
            confidence: (0.55 + 0.05 * (to_zh as f32 - 2.0)).min(0.75),
            evidence: format!("用户 {} 次将卡片内容改写为中文", to_zh),
        });
    } else if to_en >= 2 && to_en > to_zh {
        out.push(PreferenceCandidate {
            kind: PreferenceKind::Language,
            statement: "卡片正文与答案使用英文书写".to_string(),
            subject: Some("en".to_string()),
            confidence: (0.55 + 0.05 * (to_en as f32 - 2.0)).min(0.75),
            evidence: format!("用户 {} 次将卡片内容改写为英文", to_en),
        });
    }

    // 禁止翻译：跨编辑累计回写 ≥ 2 个不同术语。
    if reinstated_terms.len() >= 2 {
        let examples: Vec<&str> = reinstated_terms
            .iter()
            .take(3)
            .map(String::as_str)
            .collect();
        out.push(PreferenceCandidate {
            kind: PreferenceKind::NoTranslation,
            statement: format!("专业术语保留原文，不要翻译（如 {}）", examples.join("、")),
            subject: None,
            confidence: (0.55 + 0.05 * (reinstated_terms.len() as f32 - 2.0)).min(0.75),
            evidence: format!(
                "用户在 {} 处编辑中写回术语原文：{}",
                reinstating_edits,
                examples.join("、")
            ),
        });
    }
}

// ---------------------------------------------------------------------------
// 抽取：删卡密度信号 + 模板选择信号
// ---------------------------------------------------------------------------

fn extract_from_deletions(
    deletions: &[CardDeleteObservation],
    generated_count: usize,
    out: &mut Vec<PreferenceCandidate>,
) {
    if generated_count < DELETION_MIN_GENERATED || deletions.is_empty() {
        return;
    }
    let ratio = deletions.len() as f32 / generated_count as f32;
    if ratio < DELETION_DENSITY_THRESHOLD {
        return;
    }
    out.push(PreferenceCandidate {
        kind: PreferenceKind::CardDensity,
        statement: "控制卡片密度：少而精，避免把同一知识点拆成大量浅层卡片".to_string(),
        subject: None,
        confidence: (0.5 + ratio * 0.3).min(0.85),
        evidence: format!(
            "用户删除了 {}/{} 张生成卡（{:.0}%）",
            deletions.len(),
            generated_count,
            ratio * 100.0
        ),
    });
}

fn extract_template_choice(template_used: &Option<String>, out: &mut Vec<PreferenceCandidate>) {
    let Some(name) = template_used
        .as_deref()
        .map(str::trim)
        .filter(|n| !n.is_empty())
    else {
        return;
    };
    // 显式 extraRequirements 模板信号优先；行为信号仅在没有显式信号时补充。
    if out
        .iter()
        .any(|c| c.kind == PreferenceKind::TemplatePreference)
    {
        return;
    }
    out.push(PreferenceCandidate {
        kind: PreferenceKind::TemplatePreference,
        statement: format!("优先使用「{}」模板", name),
        subject: Some(name.to_string()),
        confidence: 0.6,
        evidence: "用户在本会话主动选用了该模板".to_string(),
    });
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/// 从一个会话的行为观察中抽取候选偏好（纯函数，确定性）。
///
/// 信号强度排序：extraRequirements 显式要求（0.9）> 重复编辑行为（0.55-0.75）
/// > 单次统计信号（删卡密度，0.5-0.85 随比例）。缺失信号一律不产出候选。
pub fn extract_preferences(observation: &SessionObservation) -> Vec<PreferenceCandidate> {
    let mut out = Vec::new();
    if let Some(raw) = observation.extra_requirements.as_deref() {
        extract_from_extra_requirements(raw, &mut out);
    }
    extract_from_edits(&observation.edits, &mut out);
    extract_from_deletions(
        &observation.deletions,
        observation.generated_count,
        &mut out,
    );
    extract_template_choice(&observation.template_used, &mut out);
    out
}

/// 对一次观察执行完整的「extract → consolidate」写入变换。
///
/// 即使观察没有达到保守抽取阈值，也会执行 [`consolidate`] 并返回空摘要；
/// 调用方仍可把 store 持久化，以保持生产写入闭环单一且可审计。
pub fn consolidate_observation(
    store: &mut PreferenceStore,
    observation: &SessionObservation,
    now_ms: i64,
) -> ConsolidateOutcome {
    let candidates = extract_preferences(observation);
    consolidate(store, &candidates, now_ms)
}

/// 把候选偏好合并进存储（ADD-only）。
///
/// - 同 kind + 归一化语句 + 主体完全相同 → 强化：`evidence_count + 1`，
///   置信度取 `max(旧, 新) + 0.05`（上限 [`CONFIDENCE_CAP`]），刷新时间与证据。
/// - 其余一律新增，绝不改写/删除既有条目（矛盾条目共存，检索时择优）。
/// - 超出 [`MAX_STORE_ENTRIES`] 时按 `置信度 × ln(1+证据数)`（同分比 `last_seen_ms`）
///   淘汰最低分条目——容量维护，不属于抽取语义。
pub fn consolidate(
    store: &mut PreferenceStore,
    candidates: &[PreferenceCandidate],
    now_ms: i64,
) -> ConsolidateOutcome {
    let mut outcome = ConsolidateOutcome::default();

    for candidate in candidates {
        let key = normalized_key(
            candidate.kind,
            &candidate.statement,
            candidate.subject.as_deref(),
        );
        if let Some(entry) = store
            .entries
            .iter_mut()
            .find(|e| normalized_key(e.kind, &e.statement, e.subject.as_deref()) == key)
        {
            entry.evidence_count = entry.evidence_count.saturating_add(1);
            entry.confidence =
                (entry.confidence.max(candidate.confidence) + 0.05).min(CONFIDENCE_CAP);
            entry.last_evidence = candidate.evidence.clone();
            entry.last_seen_ms = now_ms;
            outcome.reinforced.push(entry.statement.clone());
        } else {
            store.entries.push(PreferenceEntry {
                kind: candidate.kind,
                statement: candidate.statement.clone(),
                subject: candidate.subject.clone(),
                confidence: candidate.confidence.min(CONFIDENCE_CAP),
                evidence_count: 1,
                last_evidence: candidate.evidence.clone(),
                first_seen_ms: now_ms,
                last_seen_ms: now_ms,
            });
            outcome.added.push(candidate.statement.clone());
        }
    }

    while store.entries.len() > MAX_STORE_ENTRIES {
        let (idx, _) = store
            .entries
            .iter()
            .enumerate()
            .min_by(|(_, a), (_, b)| {
                entry_score(a)
                    .partial_cmp(&entry_score(b))
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .then(a.last_seen_ms.cmp(&b.last_seen_ms))
            })
            .expect("entries 非空");
        let removed = store.entries.remove(idx);
        outcome.evicted.push(removed.statement);
    }

    outcome
}

fn entry_score(entry: &PreferenceEntry) -> f32 {
    entry.confidence * (1.0 + (entry.evidence_count as f32).ln_1p())
}

/// 模板名匹配：忽略大小写的双向包含（"填空" 可命中 "学术填空题"）。
fn template_available(subject: &str, available_templates: &[String]) -> bool {
    let s = subject.to_lowercase();
    available_templates.iter().any(|t| {
        let t = t.to_lowercase();
        t.contains(&s) || s.contains(&t)
    })
}

/// 按 goal + 可用模板检索偏好，装配为可直接注入的短 prompt（有 token 预算）。
///
/// 规则：
/// - 每个 [`PreferenceKind`] 只取得分最高的一条，避免注入互相矛盾的偏好；
/// - `TemplatePreference` 的模板必须出现在 `available_templates` 中，否则跳过
///   （模板可能已被删除/改名，注入无效指令只会浪费预算）;
/// - 主体命中 `goal` 关键词的条目获得加权；
/// - 按 [`estimate_tokens`] 估算，超预算的行整行丢弃；一行都放不下时返回空串。
///
/// 空存储或全部被过滤时返回空串，调用方据此决定是否注入。
pub fn retrieve_preference_prompt(
    store: &PreferenceStore,
    goal: &str,
    available_templates: &[String],
    max_tokens: usize,
) -> String {
    if store.entries.is_empty() || max_tokens == 0 {
        return String::new();
    }
    let goal_lower = goal.to_lowercase();

    // 打分 + 过滤不可用模板。
    let mut scored: Vec<(f32, &PreferenceEntry)> = store
        .entries
        .iter()
        .filter(|e| match (e.kind, e.subject.as_deref()) {
            (PreferenceKind::TemplatePreference, Some(subject)) => {
                template_available(subject, available_templates)
            }
            (PreferenceKind::TemplatePreference, None) => false,
            _ => true,
        })
        .map(|e| {
            let mut score = entry_score(e);
            if let Some(subject) = e.subject.as_deref() {
                if !subject.is_empty() && goal_lower.contains(&subject.to_lowercase()) {
                    score += 0.5;
                }
            }
            (score, e)
        })
        .collect();
    scored.sort_by(|(a, ea), (b, eb)| {
        b.partial_cmp(a)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(eb.last_seen_ms.cmp(&ea.last_seen_ms))
    });

    // 每 kind 择一。
    let mut picked: Vec<&PreferenceEntry> = Vec::new();
    for (_, entry) in &scored {
        if picked.iter().any(|p| p.kind == entry.kind) {
            continue;
        }
        picked.push(entry);
    }

    // 预算装箱：header + 按分数降序尽量多装行。
    let header = "【用户制卡偏好】来自历史制卡行为，若与本次要求冲突，以本次要求为准：";
    let mut used = estimate_tokens(header);
    let mut lines: Vec<String> = Vec::new();
    for entry in picked {
        let line = format!("- {}", entry.statement);
        let cost = estimate_tokens(&line);
        if used + cost > max_tokens {
            continue;
        }
        used += cost;
        lines.push(line);
    }
    if lines.is_empty() {
        return String::new();
    }
    let mut prompt = String::from(header);
    for line in lines {
        prompt.push('\n');
        prompt.push_str(&line);
    }
    prompt
}

// ---------------------------------------------------------------------------
// 测试
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn edit(field: &str, before: &str, after: &str) -> CardEditObservation {
        CardEditObservation {
            field: field.to_string(),
            before: before.to_string(),
            after: after.to_string(),
        }
    }

    fn find<'a>(
        candidates: &'a [PreferenceCandidate],
        kind: PreferenceKind,
    ) -> Option<&'a PreferenceCandidate> {
        candidates.iter().find(|c| c.kind == kind)
    }

    // ---- extract：extraRequirements 显式信号 ----

    #[test]
    fn extract_language_zh_from_extra_requirements() {
        let obs = SessionObservation {
            extra_requirements: Some("请用中文回答，答案要包含推导过程".to_string()),
            ..Default::default()
        };
        let cands = extract_preferences(&obs);
        let lang = find(&cands, PreferenceKind::Language).expect("应产出语言偏好");
        assert_eq!(lang.subject.as_deref(), Some("zh"));
        assert!(lang.confidence >= 0.9);
        assert!(lang.statement.contains("中文"));
    }

    #[test]
    fn extract_language_en_and_ambiguity_guard() {
        let obs = SessionObservation {
            extra_requirements: Some("Please write all cards in English".to_string()),
            ..Default::default()
        };
        let cands = extract_preferences(&obs);
        assert_eq!(
            find(&cands, PreferenceKind::Language).and_then(|c| c.subject.clone()),
            Some("en".to_string())
        );

        // 中英信号同时出现 → 歧义，保守不产出。
        let ambiguous = SessionObservation {
            extra_requirements: Some("正面用中文回答，背面 in English".to_string()),
            ..Default::default()
        };
        assert!(find(&extract_preferences(&ambiguous), PreferenceKind::Language).is_none());
    }

    #[test]
    fn extract_no_translation_from_extra_requirements() {
        let obs = SessionObservation {
            extra_requirements: Some("专业术语保留英文，不要翻译成中文".to_string()),
            ..Default::default()
        };
        let cands = extract_preferences(&obs);
        let pref = find(&cands, PreferenceKind::NoTranslation).expect("应产出禁止翻译偏好");
        assert!(pref.confidence >= 0.9);
    }

    #[test]
    fn extract_density_numeric_limit() {
        let obs = SessionObservation {
            extra_requirements: Some("重点做概念卡，每段最多 6 张卡".to_string()),
            ..Default::default()
        };
        let cands = extract_preferences(&obs);
        let density = find(&cands, PreferenceKind::CardDensity).expect("应产出密度偏好");
        assert_eq!(density.subject.as_deref(), Some("6"));
        assert!(density.statement.contains('6'));
    }

    #[test]
    fn extract_template_preference_with_negation_guard() {
        let obs = SessionObservation {
            extra_requirements: Some("请用学术填空题模板，覆盖第 3 章".to_string()),
            ..Default::default()
        };
        let cands = extract_preferences(&obs);
        let tpl = find(&cands, PreferenceKind::TemplatePreference).expect("应产出模板偏好");
        assert_eq!(tpl.subject.as_deref(), Some("学术填空题"));
        assert!(tpl.statement.contains("学术填空题"));

        // 否定前缀不得误判为偏好。
        let negated = SessionObservation {
            extra_requirements: Some("不要用填空模板".to_string()),
            ..Default::default()
        };
        assert!(
            find(
                &extract_preferences(&negated),
                PreferenceKind::TemplatePreference
            )
            .is_none(),
            "否定语境不应抽出模板偏好"
        );
    }

    // ---- extract：编辑 diff 信号 ----

    #[test]
    fn extract_language_shift_from_edits() {
        let obs = SessionObservation {
            edits: vec![
                edit(
                    "back",
                    "Mitochondria are the powerhouse of the cell.",
                    "线粒体是细胞的能量工厂，通过氧化磷酸化合成 ATP。",
                ),
                edit(
                    "back",
                    "Osmosis is the diffusion of water across a membrane.",
                    "渗透是水分子经半透膜从低浓度溶液向高浓度溶液的扩散。",
                ),
            ],
            ..Default::default()
        };
        let cands = extract_preferences(&obs);
        let lang = find(&cands, PreferenceKind::Language).expect("两次改写为中文应产出语言偏好");
        assert_eq!(lang.subject.as_deref(), Some("zh"));
        assert!(lang.confidence < 0.9, "行为信号置信度应低于显式要求");

        // 单次改写不足以下结论。
        let single = SessionObservation {
            edits: vec![edit("back", "The cell.", "细胞是生命的基本单位。")],
            ..Default::default()
        };
        assert!(find(&extract_preferences(&single), PreferenceKind::Language).is_none());
    }

    #[test]
    fn extract_no_translation_from_reinstated_terms() {
        let obs = SessionObservation {
            edits: vec![
                edit(
                    "back",
                    "注意力机制会计算查询与键的相似度。",
                    "注意力机制（attention）会计算 query 与 key 的相似度。",
                ),
                edit("front", "什么是分词？", "什么是分词（tokenize）？"),
            ],
            ..Default::default()
        };
        let cands = extract_preferences(&obs);
        let pref =
            find(&cands, PreferenceKind::NoTranslation).expect("回写多个术语应产出禁止翻译偏好");
        assert!(pref.statement.contains("attention") || pref.statement.contains("tokenize"));
        assert!(pref.evidence.contains("术语原文"));
    }

    // ---- extract：删卡密度信号 ----

    #[test]
    fn extract_density_from_heavy_deletion_only() {
        let deleted = |n: usize| -> Vec<CardDeleteObservation> {
            (0..n)
                .map(|i| CardDeleteObservation {
                    front: format!("Q{}", i),
                    back: format!("A{}", i),
                })
                .collect()
        };

        // 10 张删 4 张（40%）→ 产出。
        let heavy = SessionObservation {
            deletions: deleted(4),
            generated_count: 10,
            ..Default::default()
        };
        let cands = extract_preferences(&heavy);
        let density = find(&cands, PreferenceKind::CardDensity).expect("高删除率应产出密度偏好");
        assert!(density.evidence.contains("4/10"));

        // 10 张删 1 张（10%）→ 不产出。
        let light = SessionObservation {
            deletions: deleted(1),
            generated_count: 10,
            ..Default::default()
        };
        assert!(find(&extract_preferences(&light), PreferenceKind::CardDensity).is_none());

        // 样本太小（3 张删 2 张）→ 不产出。
        let tiny = SessionObservation {
            deletions: deleted(2),
            generated_count: 3,
            ..Default::default()
        };
        assert!(find(&extract_preferences(&tiny), PreferenceKind::CardDensity).is_none());
    }

    #[test]
    fn extract_empty_observation_yields_nothing() {
        assert!(extract_preferences(&SessionObservation::default()).is_empty());
        let blank = SessionObservation {
            extra_requirements: Some("   ".to_string()),
            ..Default::default()
        };
        assert!(extract_preferences(&blank).is_empty());
    }

    // ---- consolidate：ADD-only 语义 ----

    #[test]
    fn consolidate_adds_new_entries() {
        let mut store = PreferenceStore::default();
        let cands = extract_preferences(&SessionObservation {
            extra_requirements: Some("请用中文回答，不要翻译术语".to_string()),
            ..Default::default()
        });
        assert_eq!(cands.len(), 2);
        let outcome = consolidate(&mut store, &cands, 1_000);
        assert_eq!(outcome.added.len(), 2);
        assert!(outcome.reinforced.is_empty());
        assert_eq!(store.entries.len(), 2);
        assert!(store.entries.iter().all(|e| e.evidence_count == 1));
        assert!(store.entries.iter().all(|e| e.first_seen_ms == 1_000));
    }

    #[test]
    fn consolidate_observation_runs_extract_and_add() {
        let mut store = PreferenceStore::default();
        let observation = SessionObservation {
            extra_requirements: Some("请用中文回答，不要翻译术语".to_string()),
            ..Default::default()
        };

        let outcome = consolidate_observation(&mut store, &observation, 1_234);

        assert_eq!(outcome.added.len(), 2);
        assert!(outcome.reinforced.is_empty());
        assert_eq!(store.entries.len(), 2);
        assert!(store
            .entries
            .iter()
            .all(|entry| entry.first_seen_ms == 1_234));
    }

    #[test]
    fn consolidate_observation_without_signal_is_noop() {
        let mut store = PreferenceStore::default();

        let outcome = consolidate_observation(&mut store, &SessionObservation::default(), 1_234);

        assert_eq!(outcome, ConsolidateOutcome::default());
        assert!(store.entries.is_empty());
    }

    #[test]
    fn consolidate_observation_preserves_add_only_conflicts() {
        let mut store = PreferenceStore::default();
        for requirement in ["请用中文回答", "Please write cards in English"] {
            consolidate_observation(
                &mut store,
                &SessionObservation {
                    extra_requirements: Some(requirement.to_string()),
                    ..Default::default()
                },
                1_234,
            );
        }

        assert_eq!(store.entries.len(), 2);
        assert!(store
            .entries
            .iter()
            .any(|entry| entry.subject.as_deref() == Some("zh")));
        assert!(store
            .entries
            .iter()
            .any(|entry| entry.subject.as_deref() == Some("en")));
    }

    #[test]
    fn consolidate_reinforces_duplicates_and_keeps_conflicts() {
        let mut store = PreferenceStore::default();
        let zh = extract_preferences(&SessionObservation {
            extra_requirements: Some("请用中文回答".to_string()),
            ..Default::default()
        });
        consolidate(&mut store, &zh, 1_000);
        let outcome = consolidate(&mut store, &zh, 2_000);

        // 重复观察 → 强化而非新增。
        assert_eq!(outcome.reinforced.len(), 1);
        assert!(outcome.added.is_empty());
        assert_eq!(store.entries.len(), 1);
        assert_eq!(store.entries[0].evidence_count, 2);
        assert!(store.entries[0].confidence <= CONFIDENCE_CAP);
        assert_eq!(store.entries[0].last_seen_ms, 2_000);
        assert_eq!(store.entries[0].first_seen_ms, 1_000);

        // 矛盾偏好（改偏好英文）→ ADD-only：新增共存，绝不改写/删除旧条目。
        let en = extract_preferences(&SessionObservation {
            extra_requirements: Some("please write cards in English".to_string()),
            ..Default::default()
        });
        let outcome = consolidate(&mut store, &en, 3_000);
        assert_eq!(outcome.added.len(), 1);
        assert_eq!(store.entries.len(), 2);
        assert!(store
            .entries
            .iter()
            .any(|e| e.subject.as_deref() == Some("zh")));
        assert!(store
            .entries
            .iter()
            .any(|e| e.subject.as_deref() == Some("en")));
    }

    #[test]
    fn consolidate_confidence_capped() {
        let mut store = PreferenceStore::default();
        let cands = extract_preferences(&SessionObservation {
            extra_requirements: Some("请用中文回答".to_string()),
            ..Default::default()
        });
        for i in 0..20 {
            consolidate(&mut store, &cands, i);
        }
        assert_eq!(store.entries.len(), 1);
        assert!(store.entries[0].confidence <= CONFIDENCE_CAP);
        assert_eq!(store.entries[0].evidence_count, 20);
    }

    #[test]
    fn consolidate_evicts_lowest_score_beyond_capacity() {
        let mut store = PreferenceStore::default();
        // 先塞满：用不同模板名生成 MAX 个不同条目。
        for i in 0..MAX_STORE_ENTRIES {
            let cand = PreferenceCandidate {
                kind: PreferenceKind::TemplatePreference,
                statement: format!("优先使用「模板{}」模板", i),
                subject: Some(format!("模板{}", i)),
                confidence: 0.9,
                evidence: "test".to_string(),
            };
            consolidate(&mut store, &[cand], i as i64);
        }
        assert_eq!(store.entries.len(), MAX_STORE_ENTRIES);

        // 再加入一条低置信度条目 → 容量维护会淘汰全库最低分（即它自己）。
        let weak = PreferenceCandidate {
            kind: PreferenceKind::CardDensity,
            statement: "控制卡片密度：少而精".to_string(),
            subject: None,
            confidence: 0.1,
            evidence: "test".to_string(),
        };
        let outcome = consolidate(&mut store, &[weak], 99_999);
        assert_eq!(store.entries.len(), MAX_STORE_ENTRIES);
        assert_eq!(outcome.evicted.len(), 1);
    }

    // ---- retrieve：检索与预算 ----

    #[test]
    fn retrieve_empty_store_returns_empty() {
        let store = PreferenceStore::default();
        assert_eq!(
            retrieve_preference_prompt(&store, "复习细胞呼吸", &[], DEFAULT_PROMPT_TOKEN_BUDGET),
            ""
        );
    }

    #[test]
    fn retrieve_picks_one_per_kind_and_filters_unavailable_templates() {
        let mut store = PreferenceStore::default();
        // 两条矛盾语言偏好：zh 证据更多 → 检索只取 zh。
        let zh = extract_preferences(&SessionObservation {
            extra_requirements: Some("请用中文回答".to_string()),
            ..Default::default()
        });
        consolidate(&mut store, &zh, 1_000);
        consolidate(&mut store, &zh, 2_000);
        let en = extract_preferences(&SessionObservation {
            extra_requirements: Some("please write cards in English".to_string()),
            ..Default::default()
        });
        consolidate(&mut store, &en, 3_000);
        // 模板偏好：目标模板不在可用列表 → 应被过滤。
        let tpl = extract_preferences(&SessionObservation {
            extra_requirements: Some("请用手稿风格模板".to_string()),
            ..Default::default()
        });
        consolidate(&mut store, &tpl, 4_000);

        let available = vec!["学术选择题".to_string(), "学术填空题".to_string()];
        let prompt = retrieve_preference_prompt(&store, "整理讲义", &available, 200);
        assert!(
            prompt.contains("中文"),
            "应选中证据更多的中文偏好: {}",
            prompt
        );
        assert!(!prompt.contains("英文"), "每 kind 只取一条: {}", prompt);
        assert!(
            !prompt.contains("手稿风格"),
            "不可用模板应被过滤: {}",
            prompt
        );

        // 模板在可用列表中时应注入（双向包含匹配）。
        let available2 = vec!["手稿风格".to_string()];
        let prompt2 = retrieve_preference_prompt(&store, "整理讲义", &available2, 200);
        assert!(prompt2.contains("手稿风格"), "可用模板应注入: {}", prompt2);
    }

    #[test]
    fn retrieve_respects_token_budget() {
        let mut store = PreferenceStore::default();
        let cands = extract_preferences(&SessionObservation {
            extra_requirements: Some(
                "请用中文回答，不要翻译术语，每段最多 5 张卡，请用学术填空题模板".to_string(),
            ),
            ..Default::default()
        });
        assert_eq!(cands.len(), 4, "四类偏好应全部抽出");
        consolidate(&mut store, &cands, 1_000);
        let available = vec!["学术填空题".to_string()];

        // 充足预算：4 行全部注入，且实际 token 不超预算。
        let full = retrieve_preference_prompt(&store, "goal", &available, 200);
        assert_eq!(full.lines().count(), 5, "header + 4 行: {}", full);
        assert!(estimate_tokens(&full) <= 200);

        // 紧预算：只装得下部分行。
        let tight = retrieve_preference_prompt(&store, "goal", &available, 60);
        assert!(!tight.is_empty());
        assert!(tight.lines().count() < 5, "紧预算应丢行: {}", tight);
        assert!(estimate_tokens(&tight) <= 60);

        // 预算过小：一行都放不下 → 空串。
        assert_eq!(
            retrieve_preference_prompt(&store, "goal", &available, 10),
            ""
        );
        assert_eq!(
            retrieve_preference_prompt(&store, "goal", &available, 0),
            ""
        );
    }

    #[test]
    fn retrieve_goal_keyword_boost() {
        let mut store = PreferenceStore::default();
        for name in ["学术选择题", "学术填空题"] {
            let cand = PreferenceCandidate {
                kind: PreferenceKind::TemplatePreference,
                statement: format!("优先使用「{}」模板", name),
                subject: Some(name.to_string()),
                confidence: 0.6,
                evidence: "test".to_string(),
            };
            consolidate(&mut store, &[cand], 1_000);
        }
        let available = vec!["学术选择题".to_string(), "学术填空题".to_string()];
        // goal 提到填空 → 填空模板条目应因关键词加权胜出。
        let prompt =
            retrieve_preference_prompt(&store, "把讲义做成学术填空题练习", &available, 200);
        assert!(
            prompt.contains("学术填空题"),
            "goal 关键词应加权: {}",
            prompt
        );
        assert!(!prompt.contains("学术选择题"));
    }

    // ---- 工具函数与序列化 ----

    #[test]
    fn estimate_tokens_sanity() {
        assert_eq!(estimate_tokens(""), 0);
        assert_eq!(estimate_tokens("   "), 0);
        // 4 个 CJK 字 = 4 tokens。
        assert_eq!(estimate_tokens("细胞呼吸"), 4);
        // 8 个 ASCII 字符 = 2 tokens（4 字符 ≈ 1 token，向上取整）。
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert_eq!(estimate_tokens("abcde"), 2);
        // 混排：2 CJK + 4 ASCII = 2 + 1 = 3。
        assert_eq!(estimate_tokens("细胞 cell"), 3);
    }

    #[test]
    fn store_serde_round_trip() {
        let mut store = PreferenceStore::default();
        let cands = extract_preferences(&SessionObservation {
            extra_requirements: Some("请用中文回答，每段最多 5 张卡".to_string()),
            ..Default::default()
        });
        consolidate(&mut store, &cands, 42);

        let json = serde_json::to_string(&store).expect("序列化应成功");
        let restored: PreferenceStore = serde_json::from_str(&json).expect("反序列化应成功");
        assert_eq!(restored.entries.len(), store.entries.len());
        assert_eq!(restored.entries[0].statement, store.entries[0].statement);
        assert_eq!(restored.entries[0].evidence_count, 1);
        assert_eq!(restored.entries[0].first_seen_ms, 42);

        // kind 序列化为 snake_case，便于跨端消费。
        assert!(json.contains("\"language\"") || json.contains("\"card_density\""));
    }
}
