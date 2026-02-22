//! 间隔重复算法模块 - SM-2 实现
//!
//! 本模块实现 SuperMemo 2 (SM-2) 算法，用于计算复习计划的下次复习时间。
//!
//! ## SM-2 算法简介
//! SM-2 是一种被广泛使用的间隔重复算法，由 Piotr Wozniak 于 1987 年提出。
//! 它根据用户对学习材料的记忆质量评分来动态调整复习间隔。
//!
//! ## 算法公式
//! - 易度因子更新：EF' = EF + (0.1 - (5 - q) × (0.08 + (5 - q) × 0.02))
//! - 最小易度因子：1.3
//! - 间隔计算：
//!   - 首次学习：1 天
//!   - 第二次：6 天
//!   - 之后：前一间隔 × 易度因子
//!
//! ## 评分标准
//! - 0: 完全不记得（blackout）
//! - 1: 错误答案，但看到正确答案后有印象
//! - 2: 错误答案，但正确答案感觉容易记住
//! - 3: 正确答案，但需要很大努力回忆（勉强通过）
//! - 4: 正确答案，稍有犹豫（良好）
//! - 5: 完美回忆（完美）

use serde::{Deserialize, Serialize};
use tracing::debug;

// ============================================================================
// 常量定义
// ============================================================================

/// 最小易度因子
pub const MIN_EASE_FACTOR: f64 = 1.3;

/// 默认易度因子（新卡片初始值）
pub const DEFAULT_EASE_FACTOR: f64 = 2.5;

/// 首次复习间隔（天）
pub const FIRST_INTERVAL: u32 = 1;

/// 第二次复习间隔（天）
pub const SECOND_INTERVAL: u32 = 6;

/// 评分及格线（>= 3 表示通过）
pub const PASSING_GRADE: u8 = 3;

/// 最大间隔天数（约 2 年，防止溢出）
pub const MAX_INTERVAL: u32 = 730;

// ============================================================================
// 数据类型定义
// ============================================================================

/// 复习质量评分
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewQuality {
    /// 完全不记得（blackout）
    Blackout = 0,
    /// 错误答案，但看到正确答案后有印象
    WrongButFamiliar = 1,
    /// 错误答案，但正确答案感觉容易记住
    WrongButEasy = 2,
    /// 正确答案，但需要很大努力回忆（勉强通过）
    Difficult = 3,
    /// 正确答案，稍有犹豫（良好）
    Good = 4,
    /// 完美回忆（完美）
    Perfect = 5,
}

impl ReviewQuality {
    /// 从 u8 转换
    pub fn from_u8(value: u8) -> Option<Self> {
        match value {
            0 => Some(ReviewQuality::Blackout),
            1 => Some(ReviewQuality::WrongButFamiliar),
            2 => Some(ReviewQuality::WrongButEasy),
            3 => Some(ReviewQuality::Difficult),
            4 => Some(ReviewQuality::Good),
            5 => Some(ReviewQuality::Perfect),
            _ => None,
        }
    }

    /// 转换为 u8
    pub fn as_u8(&self) -> u8 {
        *self as u8
    }

    /// 是否及格（>= 3）
    pub fn is_passing(&self) -> bool {
        self.as_u8() >= PASSING_GRADE
    }
}

impl From<u8> for ReviewQuality {
    fn from(value: u8) -> Self {
        ReviewQuality::from_u8(value.min(5)).unwrap_or(ReviewQuality::Blackout)
    }
}

/// SM-2 计算结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SM2Result {
    /// 新的复习间隔（天）
    pub new_interval: u32,
    /// 新的易度因子
    pub new_ease_factor: f64,
    /// 新的重复次数
    pub new_repetitions: u32,
    /// 是否通过本次复习
    pub passed: bool,
}

// ============================================================================
// SM-2 算法实现
// ============================================================================

/// SM-2 算法核心：计算下次复习参数
///
/// # 参数
/// * `quality` - 复习质量评分 (0-5)
/// * `repetitions` - 当前连续正确次数
/// * `ease_factor` - 当前易度因子
/// * `interval` - 当前复习间隔（天）
///
/// # 返回
/// * `(new_interval, new_ease_factor, new_repetitions)` - 新的间隔、易度因子、重复次数
///
/// # 算法说明
/// 1. 如果评分 < 3（失败）：重置重复次数为 0，间隔重置为 1 天
/// 2. 如果评分 >= 3（及格）：
///    - 更新易度因子：EF' = EF + (0.1 - (5 - q) × (0.08 + (5 - q) × 0.02))
///    - 根据重复次数计算新间隔：
///      - repetitions = 0: interval = 1
///      - repetitions = 1: interval = 6
///      - repetitions > 1: interval = 前一间隔 × 易度因子
pub fn calculate_next_review(
    quality: u8,
    repetitions: u32,
    ease_factor: f64,
    interval: u32,
) -> (u32, f64, u32) {
    // 验证并限制 quality 范围
    let q = quality.min(5) as f64;

    // 当前易度因子（确保不低于最小值）
    let current_ef = ease_factor.max(MIN_EASE_FACTOR);

    if quality < PASSING_GRADE {
        // 失败：重置复习进度，但保留易度因子
        // 易度因子仍然需要更新，但间隔和重复次数重置
        let new_ef = calculate_ease_factor(current_ef, q);

        debug!(
            "[SM2] Failed review: quality={}, resetting to interval=1, repetitions=0, EF={:.2}",
            quality, new_ef
        );

        (FIRST_INTERVAL, new_ef, 0)
    } else {
        // 及格：增加重复次数，更新易度因子，计算新间隔
        let new_ef = calculate_ease_factor(current_ef, q);
        let new_reps = repetitions + 1;

        let new_interval = match new_reps {
            1 => FIRST_INTERVAL,
            2 => SECOND_INTERVAL,
            _ => {
                // 使用上一次的间隔乘以易度因子
                let calculated = (interval as f64 * new_ef).round() as u32;
                // 确保间隔至少增加 1 天，且不超过最大值
                calculated.max(interval + 1).min(MAX_INTERVAL)
            }
        };

        debug!(
            "[SM2] Passed review: quality={}, interval={} -> {}, EF={:.2} -> {:.2}, reps={} -> {}",
            quality, interval, new_interval, current_ef, new_ef, repetitions, new_reps
        );

        (new_interval, new_ef, new_reps)
    }
}

/// 计算新的易度因子
///
/// SM-2 公式：EF' = EF + (0.1 - (5 - q) × (0.08 + (5 - q) × 0.02))
///
/// # 参数
/// * `ease_factor` - 当前易度因子
/// * `quality` - 复习质量评分 (0.0 - 5.0)
///
/// # 返回
/// * 新的易度因子（最小为 1.3）
fn calculate_ease_factor(ease_factor: f64, quality: f64) -> f64 {
    let delta = 0.1 - (5.0 - quality) * (0.08 + (5.0 - quality) * 0.02);
    let new_ef = ease_factor + delta;

    // 确保不低于最小值
    new_ef.max(MIN_EASE_FACTOR)
}

/// 高级 API：使用 ReviewQuality 枚举计算下次复习参数
pub fn calculate_next_review_advanced(
    quality: ReviewQuality,
    repetitions: u32,
    ease_factor: f64,
    interval: u32,
) -> SM2Result {
    let (new_interval, new_ease_factor, new_repetitions) =
        calculate_next_review(quality.as_u8(), repetitions, ease_factor, interval);

    SM2Result {
        new_interval,
        new_ease_factor,
        new_repetitions,
        passed: quality.is_passing(),
    }
}

/// 计算预计复习日期（相对于今天）
///
/// # 参数
/// * `interval` - 间隔天数
///
/// # 返回
/// * ISO 8601 格式的日期字符串（YYYY-MM-DD）
pub fn calculate_next_review_date(interval: u32) -> String {
    let now = chrono::Utc::now();
    let next_date = now + chrono::Duration::days(interval as i64);
    next_date.format("%Y-%m-%d").to_string()
}

/// 计算预计复习日期时间戳（毫秒）
///
/// # 参数
/// * `interval` - 间隔天数
///
/// # 返回
/// * Unix 时间戳（毫秒）
pub fn calculate_next_review_timestamp(interval: u32) -> i64 {
    let now = chrono::Utc::now();
    let next_date = now + chrono::Duration::days(interval as i64);
    next_date.timestamp_millis()
}

/// 从上次复习日期计算下次复习日期
///
/// # 参数
/// * `last_review_date` - 上次复习日期（ISO 8601）
/// * `interval` - 间隔天数
///
/// # 返回
/// * ISO 8601 格式的日期字符串（YYYY-MM-DD）
pub fn calculate_next_review_date_from_last(
    last_review_date: &str,
    interval: u32,
) -> Option<String> {
    use chrono::NaiveDate;

    let last_date = NaiveDate::parse_from_str(last_review_date, "%Y-%m-%d").ok()?;
    let next_date = last_date + chrono::Duration::days(interval as i64);
    Some(next_date.format("%Y-%m-%d").to_string())
}

/// 判断是否到期需要复习
///
/// # 参数
/// * `next_review_date` - 下次复习日期（ISO 8601）
///
/// # 返回
/// * true 表示已到期或已过期
pub fn is_due_for_review(next_review_date: &str) -> bool {
    use chrono::NaiveDate;

    let today = chrono::Utc::now().date_naive();

    if let Ok(review_date) = NaiveDate::parse_from_str(next_review_date, "%Y-%m-%d") {
        review_date <= today
    } else {
        // 解析失败，保守起见认为需要复习
        true
    }
}

/// 计算过期天数（负数表示未到期）
///
/// # 参数
/// * `next_review_date` - 下次复习日期（ISO 8601）
///
/// # 返回
/// * 过期天数（正数表示过期，负数表示还有几天）
pub fn days_overdue(next_review_date: &str) -> i64 {
    use chrono::NaiveDate;

    let today = chrono::Utc::now().date_naive();

    if let Ok(review_date) = NaiveDate::parse_from_str(next_review_date, "%Y-%m-%d") {
        (today - review_date).num_days()
    } else {
        0
    }
}

// ============================================================================
// 单元测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_review_quality_from_u8() {
        assert_eq!(ReviewQuality::from_u8(0), Some(ReviewQuality::Blackout));
        assert_eq!(ReviewQuality::from_u8(3), Some(ReviewQuality::Difficult));
        assert_eq!(ReviewQuality::from_u8(5), Some(ReviewQuality::Perfect));
        assert_eq!(ReviewQuality::from_u8(6), None);
    }

    #[test]
    fn test_review_quality_is_passing() {
        assert!(!ReviewQuality::Blackout.is_passing());
        assert!(!ReviewQuality::WrongButFamiliar.is_passing());
        assert!(!ReviewQuality::WrongButEasy.is_passing());
        assert!(ReviewQuality::Difficult.is_passing());
        assert!(ReviewQuality::Good.is_passing());
        assert!(ReviewQuality::Perfect.is_passing());
    }

    #[test]
    fn test_first_review_passed() {
        // 首次复习，质量为 4（良好）
        let (interval, ef, reps) = calculate_next_review(4, 0, DEFAULT_EASE_FACTOR, 0);

        assert_eq!(interval, FIRST_INTERVAL);
        assert_eq!(reps, 1);
        assert!(ef >= MIN_EASE_FACTOR);
    }

    #[test]
    fn test_second_review_passed() {
        // 第二次复习，质量为 4（良好）
        let (interval, ef, reps) = calculate_next_review(4, 1, DEFAULT_EASE_FACTOR, FIRST_INTERVAL);

        assert_eq!(interval, SECOND_INTERVAL);
        assert_eq!(reps, 2);
        assert!(ef >= MIN_EASE_FACTOR);
    }

    #[test]
    fn test_third_review_passed() {
        // 第三次复习，质量为 5（完美）
        let (interval, ef, reps) =
            calculate_next_review(5, 2, DEFAULT_EASE_FACTOR, SECOND_INTERVAL);

        // 间隔应该是 6 * 2.6 ≈ 15.6 -> 16
        assert!(interval > SECOND_INTERVAL);
        assert_eq!(reps, 3);
        assert!(ef >= MIN_EASE_FACTOR);
    }

    #[test]
    fn test_review_failed() {
        // 复习失败（质量 2）
        let (interval, ef, reps) = calculate_next_review(2, 5, 2.0, 30);

        assert_eq!(interval, FIRST_INTERVAL);
        assert_eq!(reps, 0);
        assert!(ef >= MIN_EASE_FACTOR);
    }

    #[test]
    fn test_ease_factor_decrease() {
        // 连续低分（质量 3）会降低易度因子
        let (_, ef1, _) = calculate_next_review(3, 0, DEFAULT_EASE_FACTOR, 0);
        let (_, ef2, _) = calculate_next_review(3, 1, ef1, 1);

        // 质量 3 应该降低易度因子
        assert!(ef1 < DEFAULT_EASE_FACTOR);
        assert!(ef2 < ef1);
    }

    #[test]
    fn test_ease_factor_increase() {
        // 高分（质量 5）会增加易度因子
        let (_, ef1, _) = calculate_next_review(5, 0, DEFAULT_EASE_FACTOR, 0);

        // 质量 5 应该增加易度因子
        assert!(ef1 > DEFAULT_EASE_FACTOR);
    }

    #[test]
    fn test_ease_factor_minimum() {
        // 即使连续低分，易度因子也不会低于 1.3
        let mut ef = 1.5;
        for _ in 0..10 {
            let (_, new_ef, _) = calculate_next_review(0, 0, ef, 1);
            ef = new_ef;
        }
        assert!(ef >= MIN_EASE_FACTOR);
    }

    #[test]
    fn test_interval_maximum() {
        // 测试最大间隔限制
        let (interval, _, _) = calculate_next_review(5, 100, 3.0, 500);

        assert!(interval <= MAX_INTERVAL);
    }

    #[test]
    fn test_calculate_next_review_date() {
        let date = calculate_next_review_date(1);

        // 验证日期格式
        assert!(date.len() == 10);
        assert!(date.contains('-'));
    }

    #[test]
    fn test_is_due_for_review() {
        // 昨天应该到期
        let yesterday = (chrono::Utc::now() - chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        assert!(is_due_for_review(&yesterday));

        // 今天应该到期
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        assert!(is_due_for_review(&today));

        // 明天不应该到期
        let tomorrow = (chrono::Utc::now() + chrono::Duration::days(1))
            .format("%Y-%m-%d")
            .to_string();
        assert!(!is_due_for_review(&tomorrow));
    }

    #[test]
    fn test_days_overdue() {
        let yesterday = (chrono::Utc::now() - chrono::Duration::days(3))
            .format("%Y-%m-%d")
            .to_string();
        assert_eq!(days_overdue(&yesterday), 3);

        let tomorrow = (chrono::Utc::now() + chrono::Duration::days(2))
            .format("%Y-%m-%d")
            .to_string();
        assert_eq!(days_overdue(&tomorrow), -2);
    }

    #[test]
    fn test_advanced_api() {
        let result = calculate_next_review_advanced(ReviewQuality::Good, 0, DEFAULT_EASE_FACTOR, 0);

        assert!(result.passed);
        assert_eq!(result.new_interval, FIRST_INTERVAL);
        assert_eq!(result.new_repetitions, 1);
    }

    #[test]
    fn test_calculate_ease_factor() {
        // 质量 5 应该增加 EF
        let ef5 = calculate_ease_factor(2.5, 5.0);
        assert!(ef5 > 2.5);

        // 质量 4 应该稍微增加 EF
        let ef4 = calculate_ease_factor(2.5, 4.0);
        assert!(ef4 > 2.5);

        // 质量 3 应该降低 EF
        let ef3 = calculate_ease_factor(2.5, 3.0);
        assert!(ef3 < 2.5);

        // 质量 0 应该大幅降低 EF
        let ef0 = calculate_ease_factor(2.5, 0.0);
        assert!(ef0 < 2.0);
    }
}
