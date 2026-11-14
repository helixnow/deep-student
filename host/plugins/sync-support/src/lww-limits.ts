/**
 * LWW 时间戳容忍窗口。
 *
 * Rust 来源：`hlc.rs:14` `pub const MAX_DRIFT_MS: i64 = 60_000`（经 `sync/mod.rs` 重导出）。
 * 用于两处：
 * - `validate_tombstone_timestamp` / `tombstone_deleted_at_usable`：未来漂移超窗口即判定时钟可疑；
 * - `compare_lww_timestamps`：两侧时间差在该窗口内视为相同时间，改用设备 ID 决胜。
 */
export const MAX_DRIFT_MS = 60_000;
