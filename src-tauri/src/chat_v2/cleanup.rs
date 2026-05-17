//! Cleanup safety controls (Audit 7)
//!
//! Defense-in-depth for orphan-cleanup paths. Provides:
//! - `CleanupOptions::dry_run`: log-only, never DELETE
//! - `CleanupOptions::force`: bypass threshold gate
//! - `evaluate_threshold`: rejects suspiciously large orphan sets
//!
//! Threshold formula: `MAX(MIN_ABSOLUTE_THRESHOLD, total * RELATIVE_THRESHOLD)`.
//! On small databases the absolute floor (100) keeps cleanup usable; on large
//! ones the 5% relative cap catches schema/ID-mismatch bugs before they purge
//! legitimate rows.

use log::{error, info};

/// Absolute floor for the orphan-count gate. Below this, cleanup is always
/// considered safe regardless of total size.
pub const MIN_ABSOLUTE_THRESHOLD: u64 = 100;

/// Relative gate: orphans exceeding 5% of the total population are treated as
/// suspicious (likely a bug, not a legitimate orphan set).
pub const RELATIVE_THRESHOLD: f64 = 0.05;

/// Safety knobs for `cleanup_orphan_*` operations.
///
/// Defaults (`dry_run=false, force=false`) preserve historical behaviour while
/// keeping the threshold gate active — an unexpected spike in orphan count
/// will abort instead of silently destroying data.
#[derive(Debug, Clone, Copy, Default)]
pub struct CleanupOptions {
    /// When true, log candidate IDs but do not execute DELETE.
    pub dry_run: bool,
    /// When true, bypass the safety threshold check. Reserve for explicit
    /// admin / migration paths after manual inspection.
    pub force: bool,
}

impl CleanupOptions {
    /// Default safe options: gate active, deletions allowed.
    pub const fn safe() -> Self {
        Self {
            dry_run: false,
            force: false,
        }
    }

    /// Inspection-only — logs intent, performs no writes.
    pub const fn dry_run() -> Self {
        Self {
            dry_run: true,
            force: false,
        }
    }

    /// Bypass the threshold gate. Caller asserts the orphan count is
    /// legitimate (e.g. one-off migration after audit).
    pub const fn forced() -> Self {
        Self {
            dry_run: false,
            force: true,
        }
    }
}

/// Compute the maximum orphan count tolerated for `total` records.
#[inline]
pub fn threshold_for(total: u64) -> u64 {
    let relative = (total as f64 * RELATIVE_THRESHOLD).ceil() as u64;
    MIN_ABSOLUTE_THRESHOLD.max(relative)
}

/// Outcome of a threshold gate check.
#[derive(Debug, PartialEq, Eq)]
pub enum ThresholdDecision {
    /// Orphan count is within tolerance — proceed with cleanup.
    Proceed,
    /// Orphan count exceeds threshold — refuse to delete (likely a bug).
    Abort { threshold: u64 },
}

/// Evaluate whether the observed orphan count is safe to delete.
///
/// `force=true` always returns `Proceed` (with a warning logged by the
/// caller's wrapper). Otherwise, compares `orphan_count` against
/// `threshold_for(total_count)`.
pub fn evaluate_threshold(
    orphan_count: u64,
    total_count: u64,
    force: bool,
) -> ThresholdDecision {
    if force {
        return ThresholdDecision::Proceed;
    }
    let threshold = threshold_for(total_count);
    if orphan_count > threshold {
        ThresholdDecision::Abort { threshold }
    } else {
        ThresholdDecision::Proceed
    }
}

/// Common logging wrapper. Returns `Ok(orphan_count)` if the gate allows
/// cleanup to proceed; `Err(message)` if the threshold tripped.
pub fn check_threshold_or_abort(
    label: &str,
    orphan_count: u64,
    total_count: u64,
    options: CleanupOptions,
) -> Result<(), String> {
    match evaluate_threshold(orphan_count, total_count, options.force) {
        ThresholdDecision::Proceed => {
            if options.force && orphan_count > threshold_for(total_count) {
                info!(
                    "[{}] threshold bypassed via force=true: orphans={}, total={}, threshold={}",
                    label,
                    orphan_count,
                    total_count,
                    threshold_for(total_count)
                );
            }
            Ok(())
        }
        ThresholdDecision::Abort { threshold } => {
            let msg = format!(
                "[{}] orphan cleanup ABORTED — count {} exceeds safety threshold {} (total={}). \
                 This likely indicates a bug or schema mismatch rather than legitimate orphans. \
                 Pass force=true to bypass after manual inspection.",
                label, orphan_count, threshold, total_count
            );
            error!("{}", msg);
            Err(msg)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn threshold_uses_absolute_floor_on_small_db() {
        assert_eq!(threshold_for(0), 100);
        assert_eq!(threshold_for(50), 100);
        assert_eq!(threshold_for(1_000), 100);
        // 1999 * 0.05 = 99.95 → ceil = 100, still equals floor
        assert_eq!(threshold_for(1_999), 100);
    }

    #[test]
    fn threshold_scales_above_floor() {
        // 2001 * 0.05 = 100.05 → ceil = 101
        assert_eq!(threshold_for(2_001), 101);
        // 100_000 * 0.05 = 5000
        assert_eq!(threshold_for(100_000), 5_000);
    }

    #[test]
    fn evaluate_proceeds_when_below_threshold() {
        assert_eq!(
            evaluate_threshold(50, 10_000, false),
            ThresholdDecision::Proceed
        );
        // exactly at threshold — proceed
        assert_eq!(
            evaluate_threshold(500, 10_000, false),
            ThresholdDecision::Proceed
        );
    }

    #[test]
    fn evaluate_aborts_when_over_threshold() {
        // 10_000 * 0.05 = 500; 600 > 500 → abort
        assert_eq!(
            evaluate_threshold(600, 10_000, false),
            ThresholdDecision::Abort { threshold: 500 }
        );
        // small DB, 200 > 100 floor
        assert_eq!(
            evaluate_threshold(200, 50, false),
            ThresholdDecision::Abort { threshold: 100 }
        );
    }

    #[test]
    fn force_always_proceeds() {
        assert_eq!(
            evaluate_threshold(10_000, 100, true),
            ThresholdDecision::Proceed
        );
    }

    #[test]
    fn check_threshold_returns_err_on_abort() {
        let opts = CleanupOptions::safe();
        let res = check_threshold_or_abort("Test", 1_000, 100, opts);
        assert!(res.is_err());
        let msg = res.unwrap_err();
        assert!(msg.contains("ABORTED"));
        assert!(msg.contains("1000"));
        assert!(msg.contains("force=true"));
    }

    #[test]
    fn check_threshold_returns_ok_on_proceed() {
        let opts = CleanupOptions::safe();
        assert!(check_threshold_or_abort("Test", 50, 10_000, opts).is_ok());
    }

    #[test]
    fn check_threshold_returns_ok_when_forced_over_threshold() {
        let opts = CleanupOptions::forced();
        assert!(check_threshold_or_abort("Test", 1_000, 100, opts).is_ok());
    }
}
