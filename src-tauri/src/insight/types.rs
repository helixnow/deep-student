//! Insight Recall v2 —— 灵感卡领域类型
//!
//! 设计规格：docs/dev/insight-recall/README.md
//! 命名纪律：统一 `insight_card` / `ic_` 前缀，避开已废弃的 irec 残留。

use serde::{Deserialize, Serialize};

// ============================================================================
// ID 生成
// ============================================================================

pub fn generate_insight_id() -> String {
    format!("ic_{}", nanoid::nanoid!(10))
}
pub fn generate_revision_id() -> String {
    format!("icr_{}", nanoid::nanoid!(10))
}
pub fn generate_evidence_id() -> String {
    format!("ice_{}", nanoid::nanoid!(10))
}
pub fn generate_relation_id() -> String {
    format!("icx_{}", nanoid::nanoid!(10))
}
pub fn generate_event_id() -> String {
    format!("iev_{}", nanoid::nanoid!(10))
}
pub fn generate_job_id() -> String {
    format!("icj_{}", nanoid::nanoid!(10))
}

// ============================================================================
// 枚举
// ============================================================================

/// 来源分级：用户自述 > 引导提取 > 自动草稿。进入召回排序权重，不伪装。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InsightOwnership {
    SelfReported,
    Guided,
    AiDraft,
}

impl InsightOwnership {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SelfReported => "self_reported",
            Self::Guided => "guided",
            Self::AiDraft => "ai_draft",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "guided" => Self::Guided,
            "ai_draft" => Self::AiDraft,
            _ => Self::SelfReported,
        }
    }
}

/// 正确性核验状态：与所有权解耦。"已认领、正确性待核验"是正常状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerificationState {
    Unverified,
    Verified,
    Contradicted,
}

impl VerificationState {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Unverified => "unverified",
            Self::Verified => "verified",
            Self::Contradicted => "contradicted",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "verified" => Self::Verified,
            "contradicted" => Self::Contradicted,
            _ => Self::Unverified,
        }
    }
}

/// 生命周期状态。cold = 低实时提示优先级（内化退场，非删除）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InsightStatus {
    Active,
    Cold,
    Archived,
}

impl InsightStatus {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Cold => "cold",
            Self::Archived => "archived",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "cold" => Self::Cold,
            "archived" => Self::Archived,
            _ => Self::Active,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    ChatMessage,
    Resource,
    Note,
    Manual,
}

impl EvidenceKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ChatMessage => "chat_message",
            Self::Resource => "resource",
            Self::Note => "note",
            Self::Manual => "manual",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "resource" => Self::Resource,
            "note" => Self::Note,
            "manual" => Self::Manual,
            _ => Self::ChatMessage,
        }
    }
}

/// 生命周期关系类型。supersede = 当前使用偏好（不删历史）；
/// contradict 必须带 scope+evidence。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelationType {
    SameMethod,
    SameTrap,
    Counterexample,
    AbstractOf,
    Supersede,
    Contradict,
    ExampleOf,
}

impl RelationType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::SameMethod => "same_method",
            Self::SameTrap => "same_trap",
            Self::Counterexample => "counterexample",
            Self::AbstractOf => "abstract_of",
            Self::Supersede => "supersede",
            Self::Contradict => "contradict",
            Self::ExampleOf => "example_of",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "same_method" => Some(Self::SameMethod),
            "same_trap" => Some(Self::SameTrap),
            "counterexample" => Some(Self::Counterexample),
            "abstract_of" => Some(Self::AbstractOf),
            "supersede" => Some(Self::Supersede),
            "contradict" => Some(Self::Contradict),
            "example_of" => Some(Self::ExampleOf),
            _ => None,
        }
    }
}

/// 学习事件类型。沉默事件（silence_*）必须记录——否则漏召回不可见。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InsightEventType {
    RecallCandidate,
    ShownExistence,
    RecallAttempt,
    ShownHint,
    ShownFull,
    Skipped,
    DirectAnswer,
    SilenceNoMatch,
    SilenceLowConfidence,
    SilenceBudget,
    SilenceUserDisabled,
    FeedbackUseful,
    FeedbackNotUseful,
    FeedbackNotApplicable,
    Confirmed,
    Corrected,
}

impl InsightEventType {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::RecallCandidate => "recall_candidate",
            Self::ShownExistence => "shown_existence",
            Self::RecallAttempt => "recall_attempt",
            Self::ShownHint => "shown_hint",
            Self::ShownFull => "shown_full",
            Self::Skipped => "skipped",
            Self::DirectAnswer => "direct_answer",
            Self::SilenceNoMatch => "silence_no_match",
            Self::SilenceLowConfidence => "silence_low_confidence",
            Self::SilenceBudget => "silence_budget",
            Self::SilenceUserDisabled => "silence_user_disabled",
            Self::FeedbackUseful => "feedback_useful",
            Self::FeedbackNotUseful => "feedback_not_useful",
            Self::FeedbackNotApplicable => "feedback_not_applicable",
            Self::Confirmed => "confirmed",
            Self::Corrected => "corrected",
        }
    }
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "recall_candidate" => Self::RecallCandidate,
            "shown_existence" => Self::ShownExistence,
            "recall_attempt" => Self::RecallAttempt,
            "shown_hint" => Self::ShownHint,
            "shown_full" => Self::ShownFull,
            "skipped" => Self::Skipped,
            "direct_answer" => Self::DirectAnswer,
            "silence_no_match" => Self::SilenceNoMatch,
            "silence_low_confidence" => Self::SilenceLowConfidence,
            "silence_budget" => Self::SilenceBudget,
            "silence_user_disabled" => Self::SilenceUserDisabled,
            "feedback_useful" => Self::FeedbackUseful,
            "feedback_not_useful" => Self::FeedbackNotUseful,
            "feedback_not_applicable" => Self::FeedbackNotApplicable,
            "confirmed" => Self::Confirmed,
            "corrected" => Self::Corrected,
            _ => return None,
        })
    }
}

/// 披露级别（披露状态机）：hidden → existence → recall_prompt → hint → full。
/// direct_answer 是用户主动切换的旁路。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DisclosureLevel {
    Hidden = 0,
    Existence = 1,
    RecallPrompt = 2,
    Hint = 3,
    Full = 4,
    DirectAnswer = 5,
}

impl DisclosureLevel {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Hidden => "hidden",
            Self::Existence => "existence",
            Self::RecallPrompt => "recall_prompt",
            Self::Hint => "hint",
            Self::Full => "full",
            Self::DirectAnswer => "direct_answer",
        }
    }
    pub fn parse(s: &str) -> Self {
        match s {
            "existence" => Self::Existence,
            "recall_prompt" => Self::RecallPrompt,
            "hint" => Self::Hint,
            "full" => Self::Full,
            "direct_answer" => Self::DirectAnswer,
            _ => Self::Hidden,
        }
    }
    /// 该级别允许暴露的字段是否包含方法内容（rule/turning_point）
    pub fn exposes_method(&self) -> bool {
        matches!(self, Self::Hint | Self::Full | Self::DirectAnswer)
    }
}

// ============================================================================
// 实体
// ============================================================================

/// 灵感卡主表行 + 当前修订（联查视图）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightCard {
    pub id: String,
    pub title: String,
    pub ownership: InsightOwnership,
    pub verification_state: VerificationState,
    pub status: InsightStatus,
    pub recall_count: i64,
    pub shown_count: i64,
    pub useful_count: i64,
    pub last_recalled_at: Option<String>,
    pub created_at: String,
    pub updated_at: Option<String>,
    pub current_revision: Option<InsightRevision>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightRevision {
    pub id: String,
    pub insight_id: String,
    pub resource_id: Option<String>,
    pub situation: String,
    pub stuck_point: String,
    pub turning_point: String,
    pub rule: String,
    pub validity_conditions: String,
    pub hypothetical_queries: Vec<String>,
    pub edit_note: Option<String>,
    pub created_at: String,
}

impl InsightRevision {
    /// 渲染为正文快照文本（存 resources，供索引/FTS）
    pub fn render_content(&self) -> String {
        let mut out = String::new();
        if !self.situation.is_empty() {
            out.push_str(&format!("## 情境\n{}\n\n", self.situation));
        }
        if !self.stuck_point.is_empty() {
            out.push_str(&format!("## 卡点\n{}\n\n", self.stuck_point));
        }
        if !self.turning_point.is_empty() {
            out.push_str(&format!("## 转折\n{}\n\n", self.turning_point));
        }
        if !self.rule.is_empty() {
            out.push_str(&format!("## 规则\n{}\n\n", self.rule));
        }
        if !self.validity_conditions.is_empty() {
            out.push_str(&format!("## 成立条件\n{}\n", self.validity_conditions));
        }
        out
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightEvidence {
    pub id: String,
    pub insight_id: String,
    pub revision_id: Option<String>,
    pub kind: EvidenceKind,
    pub session_id: Option<String>,
    pub message_id: Option<String>,
    pub variant_id: Option<String>,
    pub block_id: Option<String>,
    pub text_start: Option<i64>,
    pub text_end: Option<i64>,
    pub speaker: Option<String>,
    pub resource_id: Option<String>,
    pub quote_snapshot: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightRelation {
    pub id: String,
    pub from_id: String,
    pub to_id: String,
    pub relation_type: RelationType,
    pub scope: Option<String>,
    pub evidence: Option<String>,
    pub status: String,
    pub created_by: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightEvent {
    pub id: String,
    pub insight_id: Option<String>,
    pub session_id: Option<String>,
    pub message_id: Option<String>,
    pub event_type: InsightEventType,
    pub help_level: String,
    pub quality_signal: Option<f64>,
    pub need_signal: Option<f64>,
    pub benefit_signal: Option<f64>,
    pub payload_json: Option<String>,
    pub created_at: String,
}

// ============================================================================
// 输入 DTO
// ============================================================================

/// 创建草稿输入（采集闭环的落点）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightDraftInput {
    pub title: String,
    pub situation: String,
    pub stuck_point: String,
    pub turning_point: String,
    pub rule: String,
    pub validity_conditions: String,
    pub ownership: InsightOwnership,
    /// 证据（至少一条；quote_snapshot 必填）
    pub evidence: Vec<InsightEvidenceInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightEvidenceInput {
    pub kind: EvidenceKind,
    pub session_id: Option<String>,
    pub message_id: Option<String>,
    pub variant_id: Option<String>,
    pub block_id: Option<String>,
    pub text_start: Option<i64>,
    pub text_end: Option<i64>,
    pub speaker: Option<String>,
    pub resource_id: Option<String>,
    pub quote_snapshot: String,
}

/// 纠正输入（产生新 revision）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InsightCorrectInput {
    pub title: Option<String>,
    pub situation: Option<String>,
    pub stuck_point: Option<String>,
    pub turning_point: Option<String>,
    pub rule: Option<String>,
    pub validity_conditions: Option<String>,
    pub edit_note: Option<String>,
}
