//! Anki 语义的 FSRS 调度层（纯函数，无 I/O）。
//!
//! 记忆模型（稳定度 / 难度 / 可提取率）交给 fsrs-rs（与 Anki 同一实现，FSRS-6）；
//! 本模块只实现 Anki 在记忆模型之外的调度规则：
//! - 学习步 / 重学步：Again 回首步；Hard 在首步取前两步均值（只有一步时取 1.5 倍、
//!   最多多 1 天），其余步重复当前步；Good 进下一步或毕业；Easy 直接毕业；
//! - 复习间隔：取整、`hard < good < easy`、最大间隔，Again 走重学步（重学步为空时
//!   直接按 FSRS 给出的天数复习）；
//! - fuzz：Anki 的分段累加公式（2.5–7 天 15%、7–20 天 10%、20 天以上 5%，外加 1 天）；
//! - 逻辑日：本地时间过了日切小时才算新的一天；间隔天数按逻辑日差计算，
//!   到期当天任何时刻复习都计满间隔（与 Anki 一致）。
//!
//! 预览与评分共用 [`schedule`]：同一张卡、同一时刻、同一 fuzz 因子必然得到同一结果。

use chrono::{Duration, NaiveDate, TimeZone};
use fsrs::{MemoryState, NextStates, FSRS};

pub const DEFAULT_LEARNING_STEPS_MINUTES: [f64; 2] = [1.0, 10.0];
pub const DEFAULT_RELEARNING_STEPS_MINUTES: [f64; 1] = [10.0];
pub const DEFAULT_MAXIMUM_INTERVAL_DAYS: u32 = 36_500;
pub const DEFAULT_DAY_ROLLOVER_HOUR: u32 = 4;
/// 单个学习步的上限（分钟，365 天）。
pub const MAX_STEP_MINUTES: f64 = 525_600.0;
/// 学习步 / 重学步的最大个数。
pub const MAX_STEPS: usize = 16;
pub const MINUTES_PER_DAY: f64 = 1440.0;
/// FSRS-6 遗忘曲线衰减的合法区间（fsrs-rs 参数裁剪同一区间）。
const DECAY_RANGE: (f32, f32) = (0.1, 0.8);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CardPhase {
    New,
    Learning,
    Review,
    Relearning,
}

/// 评分前的卡片调度快照。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CardSnapshot {
    pub phase: CardPhase,
    /// 记忆状态；新卡或历史数据缺失时为 None（按新卡初始化）。
    pub memory: Option<MemoryState>,
    /// 当前所处的学习 / 重学步序号（0 起）。
    pub learning_step: u32,
    /// 距上次复习的逻辑日数（同一逻辑日内为 0，走 FSRS 短期公式）。
    pub days_elapsed: u32,
    pub reps: i32,
    pub lapses: i32,
}

pub struct SchedulerContext<'a> {
    pub fsrs: &'a FSRS,
    pub desired_retention: f32,
    pub learning_steps: &'a [f64],
    pub relearning_steps: &'a [f64],
    pub maximum_interval: u32,
    /// `Some(x)`（x ∈ [0, 1)）时启用 fuzz。同一张卡同一次复习必须给同一个因子，
    /// 预览与评分才会一致（见 [`fuzz_factor_for`]）。
    pub fuzz_factor: Option<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ScheduledDelay {
    /// 学习 / 重学步，单位分钟；跨日步长由调用方按逻辑日换算到期时间。
    Minutes(f64),
    /// 复习间隔，单位天。
    Days(u32),
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScheduledAnswer {
    pub phase: CardPhase,
    pub memory: MemoryState,
    pub learning_step: u32,
    pub delay: ScheduledDelay,
    pub reps: i32,
    pub lapses: i32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ScheduledAnswers {
    pub again: ScheduledAnswer,
    pub hard: ScheduledAnswer,
    pub good: ScheduledAnswer,
    pub easy: ScheduledAnswer,
}

impl ScheduledAnswers {
    /// 按评分（1=Again … 4=Easy）取结果；越界按 Good 处理由调用方先行校验。
    pub fn for_rating(&self, rating: u8) -> &ScheduledAnswer {
        match rating {
            1 => &self.again,
            2 => &self.hard,
            4 => &self.easy,
            _ => &self.good,
        }
    }
}

/// 计算四档评分的下一状态。
pub fn schedule(
    card: &CardSnapshot,
    ctx: &SchedulerContext<'_>,
) -> Result<ScheduledAnswers, fsrs::FSRSError> {
    let memory = match card.phase {
        CardPhase::New => None,
        _ => card
            .memory
            .filter(|m| m.stability > 0.0 && m.difficulty > 0.0),
    };
    let days_elapsed = if memory.is_some() {
        card.days_elapsed
    } else {
        0
    };
    let next = ctx
        .fsrs
        .next_states(memory, ctx.desired_retention, days_elapsed)?;
    let reps = card.reps.saturating_add(1);
    let answers = match (card.phase, memory) {
        (CardPhase::Review, Some(_)) => review_answers(card, ctx, &next, reps),
        (CardPhase::Relearning, Some(_)) => stepped_answers(
            card,
            ctx,
            &next,
            reps,
            ctx.relearning_steps,
            CardPhase::Relearning,
        ),
        _ => stepped_answers(
            card,
            ctx,
            &next,
            reps,
            ctx.learning_steps,
            CardPhase::Learning,
        ),
    };
    Ok(answers)
}

/// New / Learning / Relearning：按（重）学习步推进，走完后毕业为 Review。
fn stepped_answers(
    card: &CardSnapshot,
    ctx: &SchedulerContext<'_>,
    next: &NextStates,
    reps: i32,
    steps: &[f64],
    stepping_phase: CardPhase,
) -> ScheduledAnswers {
    let is_new = card.phase == CardPhase::New || card.memory.is_none();
    let index = if is_new {
        0
    } else {
        (card.learning_step as usize).min(steps.len().saturating_sub(1))
    };
    let lapses = card.lapses;
    let stepping = |memory: MemoryState, step: usize, minutes: f64| ScheduledAnswer {
        phase: stepping_phase,
        memory,
        learning_step: step as u32,
        delay: ScheduledDelay::Minutes(minutes),
        reps,
        lapses,
    };
    let review = |memory: MemoryState, days: u32| ScheduledAnswer {
        phase: CardPhase::Review,
        memory,
        learning_step: 0,
        delay: ScheduledDelay::Days(days),
        reps,
        lapses,
    };

    let (good_days, easy_days) = graduation_intervals(ctx, next);
    let easy = review(next.easy.memory, easy_days);

    if steps.is_empty() {
        // 没有学习步：短于 1 天的 FSRS 间隔按分钟留在学习阶段（Anki「留空交给 FSRS」），
        // 否则直接进入复习。
        let short_or_review = |memory: MemoryState, interval: f32, minimum_days: u32| {
            if interval < 1.0 {
                stepping(memory, 0, (f64::from(interval) * MINUTES_PER_DAY).max(1.0))
            } else {
                review(memory, constrain_interval(ctx, interval, minimum_days, 0))
            }
        };
        let again = short_or_review(next.again.memory, next.again.interval, 1);
        let mut hard = short_or_review(next.hard.memory, next.hard.interval, 1);
        if let ScheduledDelay::Days(days) = hard.delay {
            hard.delay = ScheduledDelay::Days(days.min(good_days));
        }
        return ScheduledAnswers {
            again,
            hard,
            good: review(next.good.memory, good_days),
            easy,
        };
    }

    let again = stepping(next.again.memory, 0, steps[0]);
    let hard = stepping(next.hard.memory, index, hard_delay(steps, index));
    let good_step = if is_new { 1 } else { index + 1 };
    let good = match steps.get(good_step) {
        Some(minutes) => stepping(next.good.memory, good_step, *minutes),
        None => review(next.good.memory, good_days),
    };
    ScheduledAnswers {
        again,
        hard,
        good,
        easy,
    }
}

/// Review：Again 进入重学步（或直接按天复习），其余三档按天复习。
fn review_answers(
    card: &CardSnapshot,
    ctx: &SchedulerContext<'_>,
    next: &NextStates,
    reps: i32,
) -> ScheduledAnswers {
    let lapses = card.lapses.saturating_add(1);
    let again = match ctx.relearning_steps.first() {
        Some(minutes) => ScheduledAnswer {
            phase: CardPhase::Relearning,
            memory: next.again.memory,
            learning_step: 0,
            delay: ScheduledDelay::Minutes(*minutes),
            reps,
            lapses,
        },
        None => ScheduledAnswer {
            phase: CardPhase::Review,
            memory: next.again.memory,
            learning_step: 0,
            delay: ScheduledDelay::Days(constrain_interval(ctx, next.again.interval, 1, 0)),
            reps,
            lapses,
        },
    };

    let elapsed = card.days_elapsed;
    let hard_days = constrain_interval(ctx, next.hard.interval, 1, elapsed);
    let good_days = constrain_interval(ctx, next.good.interval, hard_days + 1, elapsed);
    let easy_days = constrain_interval(ctx, next.easy.interval, good_days + 1, elapsed);
    let passing = |memory: MemoryState, days: u32| ScheduledAnswer {
        phase: CardPhase::Review,
        memory,
        learning_step: 0,
        delay: ScheduledDelay::Days(days),
        reps,
        lapses: card.lapses,
    };
    ScheduledAnswers {
        again,
        hard: passing(next.hard.memory, hard_days),
        good: passing(next.good.memory, good_days),
        easy: passing(next.easy.memory, easy_days),
    }
}

/// 毕业间隔：Good 至少 1 天，Easy 至少比 Good 多 1 天。
fn graduation_intervals(ctx: &SchedulerContext<'_>, next: &NextStates) -> (u32, u32) {
    let good = constrain_interval(ctx, next.good.interval, 1, 0);
    let easy = constrain_interval(ctx, next.easy.interval, good + 1, 0);
    (good, easy)
}

/// Hard 的学习步延迟（Anki `LearningSteps::hard_delay_secs`）。
fn hard_delay(steps: &[f64], index: usize) -> f64 {
    let current = steps[index.min(steps.len() - 1)];
    if index > 0 {
        return current;
    }
    match steps.get(1) {
        Some(next) => (current + next) / 2.0,
        None => (current * 1.5).min(current + MINUTES_PER_DAY),
    }
}

/// 把 FSRS 给出的天数约束到 `[minimum, maximum_interval]` 并按需 fuzz。
///
/// `days_elapsed` 用于避免 fuzz 把间隔压回已经过去的天数以内（FSRS 想要更长时）。
fn constrain_interval(
    ctx: &SchedulerContext<'_>,
    interval: f32,
    minimum: u32,
    days_elapsed: u32,
) -> u32 {
    let maximum = ctx.maximum_interval.max(1);
    let mut minimum = minimum.max(1);
    if ctx.fuzz_factor.is_some() && interval > days_elapsed as f32 {
        minimum = minimum.max(days_elapsed.saturating_add(1));
    }
    with_review_fuzz(ctx.fuzz_factor, interval, minimum.min(maximum), maximum)
}

struct FuzzRange {
    start: f32,
    end: f32,
    factor: f32,
}

const FUZZ_RANGES: [FuzzRange; 3] = [
    FuzzRange {
        start: 2.5,
        end: 7.0,
        factor: 0.15,
    },
    FuzzRange {
        start: 7.0,
        end: 20.0,
        factor: 0.1,
    },
    FuzzRange {
        start: 20.0,
        end: f32::MAX,
        factor: 0.05,
    },
];

fn fuzz_delta(interval: f32) -> f32 {
    if interval < 2.5 {
        return 0.0;
    }
    FUZZ_RANGES.iter().fold(1.0, |delta, range| {
        delta + range.factor * (interval.min(range.end) - range.start).max(0.0)
    })
}

/// Anki `constrained_fuzz_bounds`：fuzz 区间与 `[minimum, maximum]` 取交集。
fn constrained_fuzz_bounds(interval: f32, minimum: u32, maximum: u32) -> (u32, u32) {
    let minimum = minimum.min(maximum);
    let interval = interval.clamp(minimum as f32, maximum as f32);
    let delta = fuzz_delta(interval);
    let mut lower = ((interval - delta).round().max(0.0) as u32).clamp(minimum, maximum);
    let mut upper = ((interval + delta).round().max(0.0) as u32).clamp(minimum, maximum);
    if upper == lower && upper > 2 && upper < maximum {
        upper = lower + 1;
    }
    if lower > upper {
        std::mem::swap(&mut lower, &mut upper);
    }
    (lower, upper)
}

/// Anki `with_review_fuzz`。
pub fn with_review_fuzz(
    fuzz_factor: Option<f32>,
    interval: f32,
    minimum: u32,
    maximum: u32,
) -> u32 {
    let interval = if interval.is_finite() {
        interval
    } else {
        minimum as f32
    };
    match fuzz_factor {
        Some(factor) => {
            let (lower, upper) = constrained_fuzz_bounds(interval, minimum, maximum);
            let factor = factor.clamp(0.0, 0.999_999);
            let span = (upper - lower + 1) as f32;
            (lower as f32 + factor * span).floor() as u32
        }
        None => (interval.round().max(0.0) as u32).clamp(minimum.min(maximum), maximum),
    }
}

/// 确定性 fuzz 因子 ∈ [0, 1)：只依赖 `(card_state_id, reps)`，跨进程、跨 Rust 版本稳定
/// （FNV-1a + splitmix64 收尾；`DefaultHasher` 不保证跨版本稳定）。
pub fn fuzz_factor_for(card_state_id: &str, reps: i32) -> f32 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in card_state_id
        .as_bytes()
        .iter()
        .chain(reps.to_le_bytes().iter())
    {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash ^= hash >> 30;
    hash = hash.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    hash ^= hash >> 27;
    hash = hash.wrapping_mul(0x94d0_49bb_1331_11eb);
    hash ^= hash >> 31;
    (hash >> 40) as f32 / (1u64 << 24) as f32
}

/// 规范化学习步：去掉非有限值 / 非正值，限制单步时长与步数。
pub fn sanitize_steps(steps: &[f64]) -> Vec<f64> {
    steps
        .iter()
        .copied()
        .filter(|m| m.is_finite() && *m > 0.0)
        .map(|m| m.min(MAX_STEP_MINUTES))
        .take(MAX_STEPS)
        .collect()
}

/// 校验并补全 FSRS 参数（17 / 19 / 21 个）；非法时回退默认参数。
pub fn effective_parameters(params: &[f32]) -> Vec<f32> {
    fsrs::check_and_fill_parameters(params).unwrap_or_else(|_| fsrs::DEFAULT_PARAMETERS.to_vec())
}

pub fn build_fsrs(params: &[f32]) -> FSRS {
    FSRS::new(&effective_parameters(params)).unwrap_or_default()
}

/// 遗忘曲线常数 `(decay, factor)`：`R(t, S) = (1 + factor · t / S)^decay`，
/// decay 取负值，`t = S` 时 R = 90%。
pub fn forgetting_curve_constants(params: &[f32]) -> (f64, f64) {
    let w = effective_parameters(params);
    let decay = -f64::from(w[20].clamp(DECAY_RANGE.0, DECAY_RANGE.1));
    let factor = 0.9f64.powf(1.0 / decay) - 1.0;
    (decay, factor)
}

pub fn retrievability(elapsed_days: f64, stability: f64, decay: f64, factor: f64) -> f64 {
    if stability <= 0.0 || !stability.is_finite() {
        return 0.0;
    }
    (1.0 + factor * elapsed_days.max(0.0) / stability).powf(decay)
}

/// 逻辑日：本地时间减去日切小时后的日期（Anki「下一天开始于」）。
pub fn logical_day<Tz: TimeZone>(ms: i64, tz: &Tz, rollover_hour: u32) -> NaiveDate {
    let local = tz
        .timestamp_millis_opt(ms)
        .earliest()
        .map(|dt| dt.naive_local())
        .unwrap_or_else(|| {
            chrono::DateTime::from_timestamp_millis(ms)
                .map(|dt| dt.naive_utc())
                .unwrap_or_default()
        });
    (local - Duration::hours(i64::from(rollover_hour.min(23)))).date()
}

/// 两个时刻之间相差的逻辑日数（`to` 早于 `from` 时为 0）。
pub fn logical_days_between<Tz: TimeZone>(
    from_ms: i64,
    to_ms: i64,
    tz: &Tz,
    rollover_hour: u32,
) -> u32 {
    let days = (logical_day(to_ms, tz, rollover_hour) - logical_day(from_ms, tz, rollover_hour))
        .num_days();
    days.clamp(0, i64::from(u32::MAX)) as u32
}

/// 逻辑日 `date` 的起点（本地 `date` 的日切小时）。夏令时跳过该小时时顺延到下一个有效时刻。
pub fn logical_day_start_ms<Tz: TimeZone>(date: NaiveDate, tz: &Tz, rollover_hour: u32) -> i64 {
    let hour = rollover_hour.min(23);
    for offset in 0..4 {
        let Some(naive) = date.and_hms_opt(0, 0, 0) else {
            break;
        };
        let candidate = naive + Duration::hours(i64::from(hour + offset));
        if let Some(dt) = tz.from_local_datetime(&candidate).earliest() {
            return dt.timestamp_millis();
        }
    }
    let naive = date.and_hms_opt(0, 0, 0).unwrap_or_default() + Duration::hours(i64::from(hour));
    naive.and_utc().timestamp_millis()
}

/// 当前逻辑日的毫秒边界 `[start, next_start)`。
pub fn logical_day_bounds_ms<Tz: TimeZone>(now_ms: i64, tz: &Tz, rollover_hour: u32) -> (i64, i64) {
    let today = logical_day(now_ms, tz, rollover_hour);
    let start = logical_day_start_ms(today, tz, rollover_hour);
    let next = today
        .succ_opt()
        .map(|d| logical_day_start_ms(d, tz, rollover_hour))
        .unwrap_or(start + 86_400_000);
    (start, next.max(start + 1))
}

/// 学习步到期时间：不跨日按分钟计；跨过日切时按 Anki 换算为若干天后的逻辑日起点。
pub fn learning_due_ms<Tz: TimeZone>(
    now_ms: i64,
    minutes: f64,
    tz: &Tz,
    rollover_hour: u32,
) -> i64 {
    let delay_ms = (minutes.max(0.0) * 60_000.0).round() as i64;
    let due = now_ms.saturating_add(delay_ms);
    let (_, next_day_start) = logical_day_bounds_ms(now_ms, tz, rollover_hour);
    if due < next_day_start {
        return due;
    }
    let due_day = logical_day(due, tz, rollover_hour);
    logical_day_start_ms(due_day, tz, rollover_hour)
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn shanghai() -> FixedOffset {
        FixedOffset::east_opt(8 * 3600).unwrap()
    }

    fn ms(tz: &FixedOffset, y: i32, mo: u32, d: u32, h: u32, mi: u32) -> i64 {
        tz.with_ymd_and_hms(y, mo, d, h, mi, 0)
            .single()
            .unwrap()
            .timestamp_millis()
    }

    fn ctx<'a>(fsrs: &'a FSRS, fuzz: Option<f32>) -> SchedulerContext<'a> {
        SchedulerContext {
            fsrs,
            desired_retention: 0.9,
            learning_steps: &DEFAULT_LEARNING_STEPS_MINUTES,
            relearning_steps: &DEFAULT_RELEARNING_STEPS_MINUTES,
            maximum_interval: DEFAULT_MAXIMUM_INTERVAL_DAYS,
            fuzz_factor: fuzz,
        }
    }

    fn new_card() -> CardSnapshot {
        CardSnapshot {
            phase: CardPhase::New,
            memory: None,
            learning_step: 0,
            days_elapsed: 0,
            reps: 0,
            lapses: 0,
        }
    }

    fn review_card(stability: f32, days_elapsed: u32) -> CardSnapshot {
        CardSnapshot {
            phase: CardPhase::Review,
            memory: Some(MemoryState {
                stability,
                difficulty: 5.0,
            }),
            learning_step: 0,
            days_elapsed,
            reps: 3,
            lapses: 0,
        }
    }

    #[test]
    fn new_card_follows_default_learning_steps() {
        let fsrs = FSRS::default();
        let out = schedule(&new_card(), &ctx(&fsrs, None)).unwrap();
        assert_eq!(out.again.delay, ScheduledDelay::Minutes(1.0));
        assert_eq!(out.hard.delay, ScheduledDelay::Minutes(5.5));
        assert_eq!(out.good.delay, ScheduledDelay::Minutes(10.0));
        assert_eq!(out.good.learning_step, 1);
        assert_eq!(out.good.phase, CardPhase::Learning);
        // FSRS-6 默认参数：Easy 初始稳定度 8.2956 天，期望保持率 0.9 时间隔≈S
        assert_eq!(out.easy.phase, CardPhase::Review);
        assert_eq!(out.easy.delay, ScheduledDelay::Days(8));
        assert!((out.easy.memory.stability - 8.2956).abs() < 1e-3);
        assert_eq!(out.good.reps, 1);
    }

    #[test]
    fn last_learning_step_good_graduates_with_fsrs_interval() {
        let fsrs = FSRS::default();
        let ctx = ctx(&fsrs, None);
        let after_new_good = schedule(&new_card(), &ctx).unwrap().good;
        let learning = CardSnapshot {
            phase: CardPhase::Learning,
            memory: Some(after_new_good.memory),
            learning_step: after_new_good.learning_step,
            days_elapsed: 0,
            reps: after_new_good.reps,
            lapses: 0,
        };
        let out = schedule(&learning, &ctx).unwrap();
        assert_eq!(out.good.phase, CardPhase::Review);
        // 同日 Good 不降低稳定度（FSRS-6 SInc ≥ 1）→ 2.3065 天 → 2 天
        assert_eq!(out.good.delay, ScheduledDelay::Days(2));
        assert_eq!(out.again.delay, ScheduledDelay::Minutes(1.0));
        assert_eq!(out.again.learning_step, 0);
        // 非首步的 Hard 重复当前步
        assert_eq!(out.hard.delay, ScheduledDelay::Minutes(10.0));
        match (out.good.delay, out.easy.delay) {
            (ScheduledDelay::Days(good), ScheduledDelay::Days(easy)) => assert!(easy > good),
            other => panic!("unexpected delays {other:?}"),
        }
    }

    #[test]
    fn single_step_hard_is_one_and_a_half_times_capped_at_one_extra_day() {
        assert_eq!(hard_delay(&[10.0], 0), 15.0);
        assert_eq!(hard_delay(&[2880.0], 0), 2880.0 + MINUTES_PER_DAY);
        assert_eq!(hard_delay(&[1.0, 10.0, 60.0], 2), 60.0);
    }

    #[test]
    fn single_learning_step_good_on_new_card_graduates() {
        let fsrs = FSRS::default();
        let steps = [10.0];
        let ctx = SchedulerContext {
            learning_steps: &steps,
            ..ctx(&fsrs, None)
        };
        let out = schedule(&new_card(), &ctx).unwrap();
        assert_eq!(out.good.phase, CardPhase::Review);
        assert_eq!(out.again.delay, ScheduledDelay::Minutes(10.0));
    }

    #[test]
    fn review_again_enters_relearning_and_counts_a_lapse() {
        let fsrs = FSRS::default();
        let out = schedule(&review_card(10.0, 10), &ctx(&fsrs, None)).unwrap();
        assert_eq!(out.again.phase, CardPhase::Relearning);
        assert_eq!(out.again.delay, ScheduledDelay::Minutes(10.0));
        assert_eq!(out.again.lapses, 1);
        assert_eq!(out.good.lapses, 0);
    }

    #[test]
    fn empty_relearning_steps_reschedule_lapse_in_days() {
        let fsrs = FSRS::default();
        let ctx = SchedulerContext {
            relearning_steps: &[],
            ..ctx(&fsrs, None)
        };
        let out = schedule(&review_card(10.0, 10), &ctx).unwrap();
        assert_eq!(out.again.phase, CardPhase::Review);
        assert!(matches!(out.again.delay, ScheduledDelay::Days(d) if d >= 1));
    }

    #[test]
    fn relearning_good_graduates_back_to_review() {
        let fsrs = FSRS::default();
        let ctx = ctx(&fsrs, None);
        let lapse = schedule(&review_card(10.0, 10), &ctx).unwrap().again;
        let relearning = CardSnapshot {
            phase: CardPhase::Relearning,
            memory: Some(lapse.memory),
            learning_step: lapse.learning_step,
            days_elapsed: 0,
            reps: lapse.reps,
            lapses: lapse.lapses,
        };
        let out = schedule(&relearning, &ctx).unwrap();
        assert_eq!(out.good.phase, CardPhase::Review);
        assert!(matches!(out.good.delay, ScheduledDelay::Days(d) if d >= 1));
        assert_eq!(out.good.lapses, 1);
        assert_eq!(out.again.phase, CardPhase::Relearning);
    }

    #[test]
    fn review_intervals_are_strictly_increasing() {
        let fsrs = FSRS::default();
        for stability in [0.5f32, 1.0, 3.0, 12.0, 80.0] {
            for fuzz in [None, Some(0.0), Some(0.5), Some(0.99)] {
                let out = schedule(
                    &review_card(stability, stability.round() as u32),
                    &ctx(&fsrs, fuzz),
                )
                .unwrap();
                let days = |a: &ScheduledAnswer| match a.delay {
                    ScheduledDelay::Days(d) => d,
                    other => panic!("expected days, got {other:?}"),
                };
                assert!(days(&out.hard) >= 1);
                assert!(
                    days(&out.good) > days(&out.hard),
                    "S={stability} fuzz={fuzz:?}"
                );
                assert!(
                    days(&out.easy) > days(&out.good),
                    "S={stability} fuzz={fuzz:?}"
                );
            }
        }
    }

    #[test]
    fn maximum_interval_caps_every_passing_answer() {
        let fsrs = FSRS::default();
        let ctx = SchedulerContext {
            maximum_interval: 30,
            ..ctx(&fsrs, None)
        };
        let out = schedule(&review_card(400.0, 400), &ctx).unwrap();
        for answer in [out.hard, out.good, out.easy] {
            assert_eq!(answer.delay, ScheduledDelay::Days(30));
        }
    }

    /// 回归（/tmp 实测缺陷）：到期日当天早于整 24 小时复习也必须按满间隔计算。
    /// 旧实现按整 24 小时截断，S=1 的卡在 14–23 小时后评 Good 稳定度不涨。
    #[test]
    fn review_on_due_day_counts_full_logical_days() {
        let tz = shanghai();
        let last = ms(&tz, 2026, 10, 1, 21, 0);
        let next_morning = ms(&tz, 2026, 10, 2, 8, 0);
        let elapsed = logical_days_between(last, next_morning, &tz, DEFAULT_DAY_ROLLOVER_HOUR);
        assert_eq!(elapsed, 1, "21:00 → 次日 08:00 跨过 04:00 日切，应计 1 天");

        let fsrs = FSRS::default();
        let ctx = ctx(&fsrs, None);
        let on_due_day = schedule(&review_card(1.0, elapsed), &ctx).unwrap();
        let same_day = schedule(&review_card(1.0, 0), &ctx).unwrap();
        assert!(
            on_due_day.good.memory.stability > 2.0,
            "到期日复习应正常增长稳定度，实际 {}",
            on_due_day.good.memory.stability
        );
        assert!(on_due_day.good.memory.stability > same_day.good.memory.stability);
    }

    #[test]
    fn same_logical_day_reviews_use_short_term_stability() {
        let fsrs = FSRS::default();
        let out = schedule(&review_card(5.0, 0), &ctx(&fsrs, None)).unwrap();
        // 同日复习走短期公式：Good 不降低稳定度，也不会出现长期复习的大幅增长
        assert!(out.good.memory.stability >= 5.0);
        assert!(out.good.memory.stability < 6.0);
    }

    #[test]
    fn rollover_hour_moves_the_day_boundary() {
        let tz = shanghai();
        let before_rollover = ms(&tz, 2026, 10, 2, 3, 30);
        let after_rollover = ms(&tz, 2026, 10, 2, 4, 30);
        assert_eq!(
            logical_day(before_rollover, &tz, 4),
            NaiveDate::from_ymd_opt(2026, 10, 1).unwrap()
        );
        assert_eq!(
            logical_day(after_rollover, &tz, 4),
            NaiveDate::from_ymd_opt(2026, 10, 2).unwrap()
        );
        assert_eq!(
            logical_day(before_rollover, &tz, 0),
            NaiveDate::from_ymd_opt(2026, 10, 2).unwrap()
        );
        let (start, next) = logical_day_bounds_ms(before_rollover, &tz, 4);
        assert_eq!(start, ms(&tz, 2026, 10, 1, 4, 0));
        assert_eq!(next, ms(&tz, 2026, 10, 2, 4, 0));
    }

    #[test]
    fn learning_step_crossing_rollover_is_due_at_next_logical_day_start() {
        let tz = shanghai();
        let now = ms(&tz, 2026, 10, 1, 23, 0);
        assert_eq!(learning_due_ms(now, 10.0, &tz, 4), now + 10 * 60_000);
        // 6 小时后越过 04:00 日切 → 次日逻辑日起点
        assert_eq!(
            learning_due_ms(now, 360.0, &tz, 4),
            ms(&tz, 2026, 10, 2, 4, 0)
        );
        // 1 天步长 → 次日逻辑日起点
        assert_eq!(
            learning_due_ms(now, 1440.0, &tz, 4),
            ms(&tz, 2026, 10, 2, 4, 0)
        );
    }

    #[test]
    fn fuzz_matches_anki_ranges() {
        assert_eq!(fuzz_delta(2.0), 0.0);
        assert!((fuzz_delta(3.0) - 1.075).abs() < 1e-6);
        assert!((fuzz_delta(10.0) - (1.0 + 0.15 * 4.5 + 0.1 * 3.0)).abs() < 1e-5);
        assert_eq!(constrained_fuzz_bounds(3.0, 1, 36_500), (2, 4));
        assert_eq!(with_review_fuzz(Some(0.0), 3.0, 1, 36_500), 2);
        assert_eq!(with_review_fuzz(Some(0.999), 3.0, 1, 36_500), 4);
        assert_eq!(with_review_fuzz(None, 3.4, 1, 36_500), 3);
        // 不足 2.5 天不抖动
        assert_eq!(with_review_fuzz(Some(0.99), 2.0, 1, 36_500), 2);
    }

    #[test]
    fn fuzz_factor_is_deterministic_and_bounded() {
        let a = fuzz_factor_for("card-1", 3);
        assert_eq!(a, fuzz_factor_for("card-1", 3));
        assert_ne!(a, fuzz_factor_for("card-1", 4));
        for reps in 0..200 {
            let f = fuzz_factor_for("card-x", reps);
            assert!((0.0..1.0).contains(&f));
        }
    }

    #[test]
    fn fuzz_does_not_regress_below_elapsed_days() {
        let fsrs = FSRS::default();
        // 过期很久的卡：FSRS 给出的 Good 间隔远大于已过天数时，fuzz 下限不得低于已过天数 + 1
        let out = schedule(&review_card(30.0, 30), &ctx(&fsrs, Some(0.0))).unwrap();
        match out.good.delay {
            ScheduledDelay::Days(d) => assert!(d > 30),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn sanitize_steps_drops_invalid_entries() {
        assert_eq!(
            sanitize_steps(&[1.0, -2.0, f64::NAN, 0.0, 10.0, 1e9]),
            vec![1.0, 10.0, MAX_STEP_MINUTES]
        );
    }

    #[test]
    fn forgetting_curve_constants_follow_fsrs6_decay() {
        let (decay, factor) = forgetting_curve_constants(&[]);
        assert!((decay + 0.1542).abs() < 1e-6);
        // t = S 时 R = 90%
        assert!((retrievability(7.0, 7.0, decay, factor) - 0.9).abs() < 1e-9);
        let (decay5, _) = forgetting_curve_constants(&fsrs::DEFAULT_PARAMETERS[..19]);
        assert!((decay5 + 0.5).abs() < 1e-6);
    }

    #[test]
    fn missing_memory_on_learning_card_reinitializes_like_new() {
        let fsrs = FSRS::default();
        let broken = CardSnapshot {
            phase: CardPhase::Review,
            memory: None,
            ..review_card(1.0, 3)
        };
        let out = schedule(&broken, &ctx(&fsrs, None)).unwrap();
        assert_eq!(out.good.phase, CardPhase::Learning);
        assert_eq!(out.again.lapses, 0);
    }
}
