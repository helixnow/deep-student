//! # Legacy HLC Timestamp Parser
//!
//! The production sync write path never adopted a writable Hybrid Logical
//! Clock. Current LWW decisions are made by the canonical comparator in
//! `sync::mod`, which can still parse old HLC-looking `updated_at` strings as a
//! compatibility signal. This module intentionally exposes only parsing and
//! representation helpers.
//!
//! Format: `"<millis:015>-<counter:05>"`.

/// 最大允许的物理时钟漂移（毫秒）。远端时间戳超过"本地 + 该值"视为恶意或严重故障。
/// 参考 CockroachDB、YugabyteDB 选用 250ms-500ms。本项目面向笔记/AI 客户端，
/// NTP 同步不如数据中心可靠，放宽到 **60 秒**，在安全与可用性间取平衡。
pub const MAX_DRIFT_MS: i64 = 60_000;

/// Legacy HLC timestamp. Ordering is `(millis, counter)`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Hlc {
    /// 毫秒级 UTC 时间
    pub millis: u64,
    /// 同一毫秒内的 legacy logical counter
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

    /// 编码为字符串：`"01700000000001-00000"`。
    pub fn to_string(&self) -> String {
        format!("{:015}-{:05}", self.millis, self.counter)
    }

    /// 从 legacy HLC 字符串解析。
    pub fn parse(s: &str) -> Option<Self> {
        let parts: Vec<&str> = s.splitn(2, '-').collect();
        if parts.len() != 2 {
            return None;
        }
        let millis = parts[0].parse::<u64>().ok()?;
        let counter = parts[1].parse::<u16>().ok()?;
        Some(Hlc { millis, counter })
    }

    /// 打包成 u64（高 48 位 millis，低 16 位 counter）。
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
    fn test_lex_order_matches_hlc_order_for_sequence() {
        let xs: Vec<_> = (0..10)
            .flat_map(|i| {
                [
                    Hlc::new(1_700_000_000_000 + i, 0),
                    Hlc::new(1_700_000_000_000 + i, 1),
                ]
            })
            .collect();
        let mut by_struct = xs.clone();
        by_struct.sort();
        let mut by_str: Vec<String> = xs.iter().map(|x| x.to_string()).collect();
        by_str.sort();
        let by_str_back: Vec<Hlc> = by_str.iter().filter_map(|s| Hlc::parse(s)).collect();
        assert_eq!(by_struct, by_str_back);
    }
}
