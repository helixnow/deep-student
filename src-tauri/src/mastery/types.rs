//! Mastery 中间层类型（A-P0 / A-P1）

use serde::{Deserialize, Serialize};

/// 事件来源：题库 / FSRS 闪卡
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MasterySource {
    Qbank,
    Fsrs,
}

impl MasterySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Qbank => "qbank",
            Self::Fsrs => "fsrs",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw {
            "qbank" => Some(Self::Qbank),
            "fsrs" => Some(Self::Fsrs),
            _ => None,
        }
    }
}

/// 事件结果：客观对错，或 FSRS 评分（1–4）
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MasteryOutcome {
    Correct,
    Wrong,
    /// FSRS rating 1=Again … 4=Easy；持久化时 outcome 列为 `"rating"`，
    /// 目标强度写入可选列 `signal`（见 [`Self::target_signal`]）。
    Rating(u8),
}

impl MasteryOutcome {
    pub fn as_db_str(&self) -> &'static str {
        match self {
            Self::Correct => "correct",
            Self::Wrong => "wrong",
            Self::Rating(_) => "rating",
        }
    }

    /// 映射为 [0,1] 目标掌握信号（A-P1 区分度）
    ///
    /// ```text
    /// Again = 0.0
    /// Hard  ≈ 0.3
    /// Good  ≈ 0.8
    /// Easy  = 1.0
    /// correct = 1.0 / wrong = 0.0
    /// ```
    pub fn target_signal(&self) -> f64 {
        match self {
            Self::Correct => 1.0,
            Self::Wrong => 0.0,
            Self::Rating(1) => 0.0, // Again
            Self::Rating(2) => 0.3, // Hard
            Self::Rating(3) => 0.8, // Good
            Self::Rating(4) => 1.0, // Easy
            Self::Rating(_) => 0.5,
        }
    }

    pub fn is_positive(&self) -> bool {
        self.target_signal() >= 0.5
    }
}

/// append-only 掌握度事件
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasteryEvent {
    pub id: String,
    pub created_at: String,
    pub source: MasterySource,
    pub concept_key: String,
    pub item_id: String,
    pub outcome: String,
    pub weight: f64,
    /// A-P1：目标信号强度；旧行可能为 None（回退见 recompute）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<f64>,
}

/// 概念级聚合状态
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasteryState {
    pub concept_key: String,
    /// 0–1，指数滑动平均（见 service 注释）
    pub score: f64,
    pub streak: i32,
    pub total: i32,
    pub wrong_count: i32,
    pub last_signal_at: Option<String>,
}

/// 回流画像时的证据载荷
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasteryWeakEvidence {
    pub concept_key: String,
    pub score: f64,
    pub total: i32,
    pub wrong_count: i32,
    /// 近期错误摘要（确定性拼接，不经 LLM）
    pub recent_wrong_summary: String,
}

/// 掌握度驱动的今日优先复习条目
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasteryPriorityReviewItem {
    pub concept_key: String,
    pub score: f64,
    pub total: i32,
    pub wrong_count: i32,
    /// 建议优先级（1=最高）
    pub priority: u32,
    /// 简短理由（确定性模板）
    pub reason: String,
    /// 今日到期队列中同 concept 的卡片数（由 overview 填充，可无）
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_card_count: Option<u32>,
}

/// learning_overview 用的掌握度摘要
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MasteryOverviewSummary {
    pub concept_count: i64,
    pub weak_count: i64,
    pub avg_score: f64,
    pub weakest: Vec<MasteryState>,
    /// A-P1：掌握度驱动的今日优先复习
    #[serde(default)]
    pub today_priority_review: Vec<MasteryPriorityReviewItem>,
}
