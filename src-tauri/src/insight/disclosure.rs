//! 披露控制器（D2）：策略门控 → 披露决策。
//!
//! 设计纪律（规格 §2 披露状态机 + 审阅修正）：
//! - 状态机 hidden → existence → recall_prompt → hint → full（direct_answer 旁路）；
//! - 沉默不是"没发生"：四种沉默（no_match / low_confidence / budget / user_disabled）
//!   必须分开记账，否则漏召回不可见（三本账 D7）；
//! - 方法内容（rule/turning_point）只在 hint 及以上级别暴露（`exposes_method`）；
//! - 本模块是纯策略层：不碰数据库、不发事件——事件由调用方按决策结果写入，
//!   保证"决策"与"记账"可分别测试。

use super::types::DisclosureLevel;

/// 沉默原因（与 InsightEventType::Silence* 一一对应）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SilenceReason {
    NoMatch,
    LowConfidence,
    Budget,
    UserDisabled,
}

/// 单条候选的披露决策
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum DisclosureOutcome {
    /// 披露到指定级别
    Disclose(DisclosureLevel),
    /// 沉默，并记录原因
    Silence(SilenceReason),
}

/// 披露策略（每轮对话生效）
#[derive(Debug, Clone, Copy)]
pub struct DisclosurePolicy {
    /// 用户是否启用灵感召回（设置项）
    pub enabled: bool,
    /// 单轮最多披露几张卡（预算）
    pub max_per_turn: usize,
    /// 存在级披露的最低置信度（bm25 归一化分数，见 recall.rs）
    pub min_confidence: f64,
    /// 被动注入允许的最高级别（工具调用可升级突破）
    pub passive_max_level: DisclosureLevel,
}

impl Default for DisclosurePolicy {
    fn default() -> Self {
        Self {
            enabled: true,
            max_per_turn: 2,
            min_confidence: 0.35,
            passive_max_level: DisclosureLevel::Existence,
        }
    }
}

/// 从主库 settings 表加载策略（执行器与被动注入共用收口）。
/// 设置项缺失/读取失败一律回退默认值——召回是增强功能，绝不可因配置读取失败而炸掉主流程。
pub fn load_policy(main_db: Option<&crate::database::Database>) -> DisclosurePolicy {
    let default = DisclosurePolicy::default();
    let Some(db) = main_db else {
        return default;
    };
    let read = |key: &str| -> Option<String> {
        let conn = db.get_conn_safe().ok()?;
        conn.query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [key],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };
    DisclosurePolicy {
        enabled: read("insight.recall.enabled")
            .map(|v| v != "false" && v != "0")
            .unwrap_or(default.enabled),
        max_per_turn: read("insight.recall.max_per_turn")
            .and_then(|v| v.parse().ok())
            .unwrap_or(default.max_per_turn),
        min_confidence: read("insight.recall.min_confidence")
            .and_then(|v| v.parse().ok())
            .unwrap_or(default.min_confidence),
        passive_max_level: default.passive_max_level,
    }
}

/// 一条带置信度的候选（recall.rs 产出，控制器只读分数）
#[derive(Debug, Clone, Copy)]
pub struct ScoredRef {
    pub confidence: f64,
}

/// 被动注入决策：对候选列表整体给出逐卡决策。
///
/// 规则（顺序即优先级）：
/// 1. 用户禁用 → 全部 Silence(UserDisabled)；
/// 2. 无候选 → 调用方应记一条 SilenceNoMatch（候选为空时本函数返回空 vec，
///    由调用方补记——因为沉默事件 insight_id 为 NULL，不属于任何卡）；
/// 3. 低置信 → Silence(LowConfidence)；
/// 4. 超出预算 → Silence(Budget)；
/// 5. 其余 → Disclose(passive_max_level)。
pub fn decide_passive(
    policy: &DisclosurePolicy,
    candidates: &[ScoredRef],
) -> Vec<DisclosureOutcome> {
    if !policy.enabled {
        return vec![DisclosureOutcome::Silence(SilenceReason::UserDisabled); candidates.len()];
    }
    let mut shown = 0usize;
    candidates
        .iter()
        .map(|c| {
            if c.confidence < policy.min_confidence {
                DisclosureOutcome::Silence(SilenceReason::LowConfidence)
            } else if shown >= policy.max_per_turn {
                DisclosureOutcome::Silence(SilenceReason::Budget)
            } else {
                shown += 1;
                DisclosureOutcome::Disclose(policy.passive_max_level)
            }
        })
        .collect()
}

/// 升级决策（工具调用路径）：用户/模型请求把某卡从 current 升到 requested。
///
/// 纪律：
/// - 只允许升不允许降（同轮内降级无意义）；
/// - 一次最多升一级（阶梯不可跳级——direct_answer 除外，那是用户显式旁路）；
/// - 升级同样受用户禁用门控。
pub fn decide_escalation(
    policy: &DisclosurePolicy,
    current: DisclosureLevel,
    requested: DisclosureLevel,
) -> DisclosureOutcome {
    if !policy.enabled {
        return DisclosureOutcome::Silence(SilenceReason::UserDisabled);
    }
    if requested <= current {
        return DisclosureOutcome::Disclose(current);
    }
    let granted = if requested == DisclosureLevel::DirectAnswer {
        DisclosureLevel::DirectAnswer
    } else {
        // 升一级
        match current {
            DisclosureLevel::Hidden => DisclosureLevel::Existence,
            DisclosureLevel::Existence => DisclosureLevel::RecallPrompt,
            DisclosureLevel::RecallPrompt => DisclosureLevel::Hint,
            DisclosureLevel::Hint => DisclosureLevel::Full,
            DisclosureLevel::Full => DisclosureLevel::Full,
            DisclosureLevel::DirectAnswer => DisclosureLevel::DirectAnswer,
        }
    };
    DisclosureOutcome::Disclose(granted)
}

/// 按披露级别过滤卡片内容——**这是"存在级不泄露方法"的唯一收口**。
///
/// 返回 (title, situation_opt, rule_opt)：
/// - Existence：只有标题（"你曾在类似情境卡住过"）；
/// - RecallPrompt：标题 + 情境（不给方法，引导用户自己回忆）；
/// - Hint/Full/DirectAnswer：全部字段（exposes_method）。
///
/// 执行器出口与块持久化两处都必须经此函数过滤（D2）。
pub fn filter_content<'a>(
    level: DisclosureLevel,
    title: &'a str,
    situation: &'a str,
    rule: &'a str,
) -> (&'a str, Option<&'a str>, Option<&'a str>) {
    match level {
        DisclosureLevel::Hidden => (title, None, None),
        DisclosureLevel::Existence => (title, None, None),
        DisclosureLevel::RecallPrompt => (title, Some(situation), None),
        DisclosureLevel::Hint | DisclosureLevel::Full | DisclosureLevel::DirectAnswer => {
            (title, Some(situation), Some(rule))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn c(score: f64) -> ScoredRef {
        ScoredRef { confidence: score }
    }

    #[test]
    fn passive_silence_when_disabled() {
        let policy = DisclosurePolicy { enabled: false, ..Default::default() };
        let out = decide_passive(&policy, &[c(0.9)]);
        assert_eq!(out, vec![DisclosureOutcome::Silence(SilenceReason::UserDisabled)]);
    }

    #[test]
    fn passive_low_confidence_silence() {
        let policy = DisclosurePolicy::default();
        let out = decide_passive(&policy, &[c(0.1)]);
        assert_eq!(out, vec![DisclosureOutcome::Silence(SilenceReason::LowConfidence)]);
    }

    #[test]
    fn passive_budget_enforced() {
        let policy = DisclosurePolicy { max_per_turn: 1, ..Default::default() };
        let out = decide_passive(&policy, &[c(0.9), c(0.8)]);
        assert_eq!(out[0], DisclosureOutcome::Disclose(DisclosureLevel::Existence));
        assert_eq!(out[1], DisclosureOutcome::Silence(SilenceReason::Budget));
    }

    #[test]
    fn existence_never_exposes_method() {
        let (t, s, r) = filter_content(DisclosureLevel::Existence, "换元法", "积分题", "识别导数结构");
        assert_eq!(t, "换元法");
        assert!(s.is_none());
        assert!(r.is_none(), "存在级泄露方法是红线");
        let (_, s2, r2) = filter_content(DisclosureLevel::RecallPrompt, "t", "s", "r");
        assert!(s2.is_some() && r2.is_none(), "回忆提示级给情境但不给方法");
        let (_, _, r3) = filter_content(DisclosureLevel::Hint, "t", "s", "r");
        assert!(r3.is_some());
    }

    #[test]
    fn escalation_one_rung_at_a_time() {
        let policy = DisclosurePolicy::default();
        assert_eq!(
            decide_escalation(&policy, DisclosureLevel::Existence, DisclosureLevel::Full),
            DisclosureOutcome::Disclose(DisclosureLevel::RecallPrompt),
            "不许跳级"
        );
        assert_eq!(
            decide_escalation(&policy, DisclosureLevel::Hint, DisclosureLevel::DirectAnswer),
            DisclosureOutcome::Disclose(DisclosureLevel::DirectAnswer),
            "direct_answer 是显式旁路"
        );
        assert_eq!(
            decide_escalation(&policy, DisclosureLevel::Full, DisclosureLevel::Hint),
            DisclosureOutcome::Disclose(DisclosureLevel::Full),
            "不降级"
        );
    }
}
