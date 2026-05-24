//! # Hybrid Logical Clock (HLC)
//!
//! 业界共识解决 wall-clock LWW 致命缺陷的方案：
//! - 单纯 wall clock LWW 易受**恶意超前时间戳**攻击（一个故障设备可以永久压制所有其他端）
//! - Lamport 时钟有因果序但没物理时间（调试/老化困难）
//! - **HLC** 结合两者：wall clock 作为主干、logical counter 作为 tie-break，并拒绝大漂移
//!
//! 论文：[Kulkarni et al. 2014 "Logical Physical Clocks"](https://cse.buffalo.edu/tech-reports/2014-04.pdf)
//!
//! ## 本实现设计
//!
//! - **64 位打包表示**：高 48 位 = 毫秒 wall time，低 16 位 = logical counter
//! - **最大漂移窗口**：`MAX_DRIFT_MS = 60_000`（1 分钟）—— 超过则拒绝这个事件
//! - **Logical counter 溢出**：当 counter 达到 `u16::MAX` 时推动 wall time +1 ms 并重置 counter
//! - **线程安全**：持久化状态用 `Arc<Mutex<HlcState>>`
//!
//! ## 与现有 `updated_at` 的兼容
//!
//! HLC 时间戳可作为 `updated_at` 的**增强**，不替换。调用方：
//! 1. 在写入一条记录时调用 `HlcClock::tick()` 生成 HLC，编码为字符串存入 `updated_at`
//! 2. 在回放远端变更时调用 `HlcClock::receive(remote_hlc)` 推进本地时钟
//! 3. LWW 比较时用 HLC 的字典序（等价于时间序）
//!
//! ## 格式：`"<millis>-<counter>"`
//!
//! 采用字符串形式（而非纯 u64）是为了**人类可读 + 保序**。`"1700000000001-0000"` 这样的形式
//! 在字典序下与数值排序等价，且能直接存进 `updated_at` TEXT 列。

use std::cmp::{max, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

/// 最大允许的物理时钟漂移（毫秒）。远端时间戳超过"本地 + 该值"视为恶意或严重故障。
/// 参考 CockroachDB、YugabyteDB 选用 250ms-500ms。本项目面向笔记/AI 客户端，
/// NTP 同步不如数据中心可靠，放宽到 **60 秒**，在安全与可用性间取平衡。
pub const MAX_DRIFT_MS: i64 = 60_000;

/// HLC 时间戳
///
/// 保序不变量：`(millis, counter)` 的 tuple 序等于 HLC 的自然序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hlc {
    /// 毫秒级 UTC 时间
    pub millis: u64,
    /// 在同一毫秒内单调递增的逻辑计数器
    pub counter: u16,
}

impl Hlc {
    pub const ZERO: Hlc = Hlc {
        millis: 0,
        counter: 0,
    };

    pub fn new(millis: u64, counter: u16) -> Self {
        Self { millis, counter }
    }

    /// 编码为字符串：`"01700000000001-00000"`
    ///
    /// 固定宽度 millis (15 位补零) + `-` + counter (5 位补零)
    /// 这个格式保证**字典序 = 自然序**，可以直接存进 TEXT 列作为 `updated_at`。
    pub fn to_string(&self) -> String {
        format!("{:015}-{:05}", self.millis, self.counter)
    }

    /// 从字符串解析
    pub fn parse(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.splitn(2, '-').collect();
        if parts.len() != 2 {
            return None;
        }
        let millis = parts[0].parse::<u64>().ok()?;
        let counter = parts[1].parse::<u16>().ok()?;
        Some(Hlc { millis, counter })
    }

    /// 打包成 u64（高 48 位 millis，低 16 位 counter）
    /// millis 如果 > 2^48 会被截断（现实中 2^48 ms ≈ 8925 年，不必担心）
    pub fn to_u64(&self) -> u64 {
        (self.millis << 16) | (self.counter as u64)
    }

    pub fn from_u64(v: u64) -> Self {
        Hlc {
            millis: v >> 16,
            counter: (v & 0xFFFF) as u16,
        }
    }
}

/// HLC 驱动错误
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum HlcError {
    #[error(
        "HLC 时钟漂移过大：远端 {remote_ms}ms，本地 {local_ms}ms，差值 {drift_ms}ms 超过阈值 {max_drift_ms}ms"
    )]
    ClockDriftTooLarge {
        remote_ms: u64,
        local_ms: u64,
        drift_ms: i64,
        max_drift_ms: i64,
    },
    #[error("HLC 计数器溢出：同一毫秒内超过 {} 次事件", u16::MAX)]
    CounterOverflow,
}

/// HLC 核心状态
#[derive(Debug, Clone, Copy)]
struct HlcState {
    /// 最近一次生成/接收的 HLC
    last: Hlc,
}

impl Default for HlcState {
    fn default() -> Self {
        Self { last: Hlc::ZERO }
    }
}

/// HLC 时钟实例，线程安全
#[derive(Debug, Clone, Default)]
pub struct HlcClock {
    state: Arc<Mutex<HlcState>>,
}

/// 获取当前 wall time 毫秒
fn wall_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl HlcClock {
    pub fn new() -> Self {
        Self::default()
    }

    /// 显式从某个状态启动（重启后恢复持久化状态用）
    pub fn from_last(last: Hlc) -> Self {
        Self {
            state: Arc::new(Mutex::new(HlcState { last })),
        }
    }

    /// 产生一个新的本地事件 HLC（Send 或 Local Event）
    ///
    /// 算法（Kulkarni et al.）：
    /// - `now = wall_now()`
    /// - 如果 `now > last.millis`: new = (now, 0)
    /// - 否则: new = (last.millis, last.counter + 1)
    pub fn tick(&self) -> Result<Hlc, HlcError> {
        self.tick_with_now(wall_now_ms())
    }

    pub fn tick_with_now(&self, now_ms: u64) -> Result<Hlc, HlcError> {
        let mut state = self.state.lock().unwrap();
        let new = if now_ms > state.last.millis {
            Hlc::new(now_ms, 0)
        } else {
            // same or earlier wall time → 增 counter
            if state.last.counter == u16::MAX {
                // counter 溢出 → 物理时间 +1ms，counter 重置
                Hlc::new(state.last.millis.saturating_add(1), 0)
            } else {
                Hlc::new(state.last.millis, state.last.counter + 1)
            }
        };
        state.last = new;
        Ok(new)
    }

    /// 接收一个远端事件 HLC（Receive）
    ///
    /// 算法：
    /// - `now = wall_now()`
    /// - **先做 drift check**：如果 |remote.millis - now| > MAX_DRIFT_MS → 拒绝
    /// - `new_millis = max(last.millis, remote.millis, now)`
    /// - counter 规则：
    ///   - 如果 new_millis == last.millis == remote.millis: counter = max(last.counter, remote.counter) + 1
    ///   - 如果 new_millis == last.millis: counter = last.counter + 1
    ///   - 如果 new_millis == remote.millis: counter = remote.counter + 1
    ///   - 否则: counter = 0
    pub fn receive(&self, remote: Hlc) -> Result<Hlc, HlcError> {
        self.receive_with_now(remote, wall_now_ms())
    }

    pub fn receive_with_now(&self, remote: Hlc, now_ms: u64) -> Result<Hlc, HlcError> {
        // Drift check — 关键安全保护
        let drift = remote.millis as i64 - now_ms as i64;
        if drift > MAX_DRIFT_MS {
            return Err(HlcError::ClockDriftTooLarge {
                remote_ms: remote.millis,
                local_ms: now_ms,
                drift_ms: drift,
                max_drift_ms: MAX_DRIFT_MS,
            });
        }

        let mut state = self.state.lock().unwrap();
        let last = state.last;

        let new_millis = max(max(last.millis, remote.millis), now_ms);

        let new_counter = if new_millis == last.millis && new_millis == remote.millis {
            // 三个相等 → max counter + 1
            let m = max(last.counter, remote.counter);
            if m == u16::MAX {
                return Err(HlcError::CounterOverflow);
            }
            m + 1
        } else if new_millis == last.millis {
            if last.counter == u16::MAX {
                return Err(HlcError::CounterOverflow);
            }
            last.counter + 1
        } else if new_millis == remote.millis {
            if remote.counter == u16::MAX {
                return Err(HlcError::CounterOverflow);
            }
            remote.counter + 1
        } else {
            // new_millis == now_ms
            0
        };

        let new = Hlc::new(new_millis, new_counter);
        state.last = new;
        Ok(new)
    }

    /// 获取当前的 last HLC（不推进）
    pub fn peek(&self) -> Hlc {
        self.state.lock().unwrap().last
    }
}

/// 两个 HLC 字符串的比较（供业务代码在 LWW 决策时使用）
///
/// 遵循：先按 millis 后按 counter。`None` 视为最早。
pub fn compare_hlc_strings(a: &str, b: &str) -> Ordering {
    match (Hlc::parse(a), Hlc::parse(b)) {
        (Some(ha), Some(hb)) => ha.cmp(&hb),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => a.cmp(b),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hlc_encoding_is_lex_sortable() {
        let a = Hlc::new(1_700_000_000_000, 0);
        let b = Hlc::new(1_700_000_000_001, 0);
        let c = Hlc::new(1_700_000_000_000, 1);
        assert!(a.to_string() < b.to_string());
        assert!(a.to_string() < c.to_string());
        assert!(c.to_string() < b.to_string());
    }

    #[test]
    fn test_hlc_parse_roundtrip() {
        let h = Hlc::new(1_700_000_000_123, 42);
        let s = h.to_string();
        assert_eq!(Hlc::parse(&s), Some(h));
    }

    #[test]
    fn test_hlc_u64_roundtrip() {
        let h = Hlc::new(1_700_000_000_123, 42);
        let u = h.to_u64();
        assert_eq!(Hlc::from_u64(u), h);
    }

    #[test]
    fn test_tick_advances_with_wall_time() {
        let clock = HlcClock::new();
        let a = clock.tick_with_now(1000).unwrap();
        let b = clock.tick_with_now(2000).unwrap();
        assert_eq!(a, Hlc::new(1000, 0));
        assert_eq!(b, Hlc::new(2000, 0));
    }

    #[test]
    fn test_tick_same_millis_increments_counter() {
        let clock = HlcClock::new();
        let a = clock.tick_with_now(1000).unwrap();
        let b = clock.tick_with_now(1000).unwrap();
        let c = clock.tick_with_now(1000).unwrap();
        assert_eq!(a, Hlc::new(1000, 0));
        assert_eq!(b, Hlc::new(1000, 1));
        assert_eq!(c, Hlc::new(1000, 2));
    }

    #[test]
    fn test_tick_when_wall_goes_backward_keeps_max() {
        let clock = HlcClock::new();
        let _ = clock.tick_with_now(2000).unwrap();
        // 时钟回退到 1000
        let b = clock.tick_with_now(1000).unwrap();
        // 必须仍然推进 counter，不使用过去的 wall time
        assert_eq!(b, Hlc::new(2000, 1));
    }

    #[test]
    fn test_receive_rejects_far_future_drift() {
        let clock = HlcClock::new();
        let malicious = Hlc::new(1_800_000_000_000, 0); // 未来
        let now = 1_700_000_000_000u64;
        let r = clock.receive_with_now(malicious, now);
        assert!(r.is_err());
        match r {
            Err(HlcError::ClockDriftTooLarge { .. }) => {}
            _ => panic!("should be drift error"),
        }
    }

    #[test]
    fn test_receive_accepts_small_drift() {
        let clock = HlcClock::new();
        let remote = Hlc::new(1_700_000_000_500, 0);
        let now = 1_700_000_000_000u64;
        // 500ms 漂移 < 60s 阈值 → 可接受
        let r = clock.receive_with_now(remote, now).unwrap();
        assert_eq!(r.millis, 1_700_000_000_500);
        assert_eq!(r.counter, 1);
    }

    #[test]
    fn test_receive_three_way_max_counter() {
        let clock = HlcClock::from_last(Hlc::new(1_700_000_000_000, 3));
        let remote = Hlc::new(1_700_000_000_000, 7);
        let r = clock.receive_with_now(remote, 1_700_000_000_000).unwrap();
        assert_eq!(r, Hlc::new(1_700_000_000_000, 8)); // max(3,7) + 1
    }

    #[test]
    fn test_receive_past_remote_uses_local_plus_one() {
        let clock = HlcClock::from_last(Hlc::new(2000, 5));
        let remote = Hlc::new(1000, 100);
        let r = clock.receive_with_now(remote, 2000).unwrap();
        assert_eq!(r, Hlc::new(2000, 6));
    }

    #[test]
    fn test_counter_overflow_rolls_wall_time() {
        let clock = HlcClock::from_last(Hlc::new(1000, u16::MAX));
        let r = clock.tick_with_now(1000).unwrap();
        // wall 没进，counter 溢出 → wall+1, counter 重置
        assert_eq!(r, Hlc::new(1001, 0));
    }

    #[test]
    fn test_compare_hlc_strings() {
        let a = Hlc::new(1000, 0).to_string();
        let b = Hlc::new(2000, 0).to_string();
        let c = Hlc::new(1000, 5).to_string();
        assert_eq!(compare_hlc_strings(&a, &b), Ordering::Less);
        assert_eq!(compare_hlc_strings(&c, &a), Ordering::Greater);
        assert_eq!(compare_hlc_strings(&a, &a), Ordering::Equal);
    }

    #[test]
    fn test_multiple_nodes_converge_on_causal_order() {
        // 模拟两个设备交换 HLC
        let a = HlcClock::new();
        let b = HlcClock::new();

        let now = 1_700_000_000_000u64;

        // A 在 t=now 发出事件
        let e1 = a.tick_with_now(now).unwrap();
        // B 在 t=now+10 收到 e1
        let e2 = b.receive_with_now(e1, now + 10).unwrap();
        // B 生成新事件
        let e3 = b.tick_with_now(now + 20).unwrap();
        // A 收到 e3
        let e4 = a.receive_with_now(e3, now + 30).unwrap();

        // 因果序验证：e1 < e2 < e3 < e4
        assert!(e1 < e2);
        assert!(e2 < e3);
        assert!(e3 < e4);
    }
}
