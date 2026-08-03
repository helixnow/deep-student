//! FSRS 应用层掌握度调度偏置（A-P1）
//!
//! **不修改** rs-fsrs 内部稳定性/难度；只在 `schedule_review` 产出的 `due_ms`
//! 上做有界平移，并可选用于到期队列优先级排序。

/// 中性掌握度（无偏置）
pub const MASTERY_NEUTRAL_SCORE: f64 = 0.5;

/// 低掌握区间：score < 此值 → due 提前
pub const MASTERY_LOW_THRESHOLD: f64 = 0.5;

/// 高掌握区间：score > 此值 → due 轻微延后
pub const MASTERY_HIGH_THRESHOLD: f64 = 0.5;

/// 薄弱侧：interval 最多提前比例（防过拟合硬顶）
pub const MAX_ADVANCE_FRAC: f64 = 0.40;

/// 精通侧：interval 最多延后比例（小于提前，避免「学得好反而拖太久」）
pub const MAX_DELAY_FRAC: f64 = 0.15;

/// 薄弱侧：绝对提前上限（毫秒）= 3 天
pub const MAX_ADVANCE_MS: i64 = 3 * 86_400_000;

/// 精通侧：绝对延后上限（毫秒）= 1 天
pub const MAX_DELAY_MS: i64 = 86_400_000;

/// 学习步长（interval < 此值）不做比例偏置，避免把 10min 步长拉成负数/过短
pub const MIN_BIASABLE_INTERVAL_MS: i64 = 60 * 60 * 1000; // 1h

///
/// # 偏置公式（可解释）
///
/// 设 FSRS 算出的间隔 `I = max(0, fsrs_due_ms − now_ms)`，掌握度 `s ∈ [0,1]`。
///
/// ```text
/// deficit = max(0, 0.5 − s)     // 薄弱程度
/// surplus = max(0, s − 0.5)     // 精通程度
///
/// // 薄弱：提前，比例 = min(MAX_ADVANCE_FRAC, deficit × 0.80)
/// //   s=0.0 → frac=0.40；s=0.25 → frac=0.20；s=0.5 → 0
/// advance_ms = min(I × advance_frac, MAX_ADVANCE_MS)
/// due' = fsrs_due − advance_ms
///
/// // 精通：延后，比例 = min(MAX_DELAY_FRAC, surplus × 0.30)
/// //   s=1.0 → frac=0.15；s=0.75 → frac=0.075；s=0.5 → 0
/// delay_ms = min(I × delay_frac, MAX_DELAY_MS)
/// due' = fsrs_due + delay_ms
///
/// // 守卫：I < MIN_BIASABLE_INTERVAL_MS → 不偏置（学习/重学短步长）
/// //       due' ≥ now_ms（不允许偏到过去）
/// ```
///
/// 返回值：应写入的 `due_ms`（已夹紧）。
pub fn apply_mastery_due_bias(score: f64, now_ms: i64, fsrs_due_ms: i64) -> i64 {
    let score = score.clamp(0.0, 1.0);
    let interval = fsrs_due_ms.saturating_sub(now_ms);
    if interval < MIN_BIASABLE_INTERVAL_MS {
        return fsrs_due_ms;
    }

    let delta = mastery_due_bias_delta_ms(score, interval);
    let biased = fsrs_due_ms.saturating_add(delta);
    biased.max(now_ms)
}

/// 纯函数：相对 FSRS due 的毫秒偏移（负=提前，正=延后）。
///
/// `interval_ms` 为 FSRS 间隔；已含比例与绝对上限夹紧。
pub fn mastery_due_bias_delta_ms(score: f64, interval_ms: i64) -> i64 {
    let score = score.clamp(0.0, 1.0);
    if interval_ms < MIN_BIASABLE_INTERVAL_MS {
        return 0;
    }
    let i = interval_ms as f64;

    if score < MASTERY_LOW_THRESHOLD {
        let deficit = MASTERY_NEUTRAL_SCORE - score;
        let frac = (deficit * 0.80).min(MAX_ADVANCE_FRAC);
        let advance = (i * frac).round() as i64;
        -advance.min(MAX_ADVANCE_MS)
    } else if score > MASTERY_HIGH_THRESHOLD {
        let surplus = score - MASTERY_NEUTRAL_SCORE;
        let frac = (surplus * 0.30).min(MAX_DELAY_FRAC);
        let delay = (i * frac).round() as i64;
        delay.min(MAX_DELAY_MS)
    } else {
        0
    }
}

/// 到期队列优先级分：越小越优先。结合 due_ms 与掌握度薄弱程度。
///
/// ```text
/// priority = due_ms − weakness_boost
/// weakness_boost = min(2d, deficit × 4d)   // s=0 → 提前等价 2 天排序权重
/// ```
pub fn mastery_queue_priority_key(score: Option<f64>, due_ms: i64) -> i64 {
    let Some(score) = score else {
        return due_ms;
    };
    let score = score.clamp(0.0, 1.0);
    if score >= MASTERY_LOW_THRESHOLD {
        return due_ms;
    }
    let deficit = MASTERY_NEUTRAL_SCORE - score;
    let boost = ((deficit * 4.0) * 86_400_000.0)
        .round()
        .clamp(0.0, 2.0 * 86_400_000.0) as i64;
    due_ms.saturating_sub(boost)
}

#[cfg(test)]
mod tests {
    use super::*;

    const DAY: i64 = 86_400_000;

    #[test]
    fn low_mastery_advances_due_by_assertable_fraction() {
        let now = 1_700_000_000_000_i64;
        // 5d interval：比例 40% → 2d，未触达绝对上限 3d
        let interval = 5 * DAY;
        let fsrs_due = now + interval;
        // s=0 → advance_frac = min(0.40, 0.5*0.8) = 0.40 → 2 days
        let biased = apply_mastery_due_bias(0.0, now, fsrs_due);
        assert_eq!(biased, fsrs_due - 2 * DAY);
        assert_eq!(mastery_due_bias_delta_ms(0.0, interval), -2 * DAY);
    }

    #[test]
    fn high_mastery_is_not_advanced() {
        let now = 1_700_000_000_000_i64;
        let interval = 10 * DAY;
        let fsrs_due = now + interval;
        let biased = apply_mastery_due_bias(0.9, now, fsrs_due);
        assert!(biased >= fsrs_due, "high mastery must not pull due earlier");
        // s=0.9 → surplus=0.4 → frac=min(0.15, 0.12)=0.12 → +1.2d
        let delta = mastery_due_bias_delta_ms(0.9, interval);
        assert!(delta > 0);
        assert_eq!(biased, fsrs_due + delta);
    }

    #[test]
    fn bias_has_hard_cap_not_unbounded() {
        let huge = 100 * DAY;
        // Even at s=0, advance ≤ MAX_ADVANCE_MS (3d), not 40% of 100d (=40d)
        let delta = mastery_due_bias_delta_ms(0.0, huge);
        assert_eq!(delta, -MAX_ADVANCE_MS);
        assert!(delta.abs() < (huge as f64 * MAX_ADVANCE_FRAC) as i64);
    }

    #[test]
    fn short_learning_steps_unbiased() {
        let interval = 10 * 60_000; // 10 min
        assert_eq!(mastery_due_bias_delta_ms(0.0, interval), 0);
        let now = 1_000_i64;
        assert_eq!(
            apply_mastery_due_bias(0.0, now, now + interval),
            now + interval
        );
    }

    #[test]
    fn neutral_score_no_bias() {
        assert_eq!(mastery_due_bias_delta_ms(0.5, 10 * DAY), 0);
    }
}
