//! Inbound rate limiting for iLink Bot.

use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub fn is_bound_user(bound_user_id: &str, peer_id: &str) -> bool {
    !bound_user_id.is_empty() && bound_user_id == peer_id
}

/// Simple per-peer sliding window rate limiter.
pub struct RateLimiter {
    per_min: usize,
    windows: Mutex<HashMap<String, VecDeque<Instant>>>,
}

impl RateLimiter {
    pub fn new(per_min: usize) -> Self {
        Self {
            per_min: per_min.max(1),
            windows: Mutex::new(HashMap::new()),
        }
    }

    pub fn check_and_record(&self, peer_id: &str) -> bool {
        let now = Instant::now();
        let window = Duration::from_secs(60);
        let mut map = self.windows.lock().unwrap_or_else(|e| e.into_inner());
        let q = map.entry(peer_id.to_string()).or_default();
        while let Some(front) = q.front() {
            if now.duration_since(*front) > window {
                q.pop_front();
            } else {
                break;
            }
        }
        if q.len() >= self.per_min {
            return false;
        }
        q.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_scanning_user_is_allowed() {
        assert!(is_bound_user("owner@im.wechat", "owner@im.wechat"));
        assert!(!is_bound_user("owner@im.wechat", "other@im.wechat"));
        assert!(!is_bound_user("", "owner@im.wechat"));
    }

    #[test]
    fn rate_limit_blocks() {
        let r = RateLimiter::new(2);
        assert!(r.check_and_record("p"));
        assert!(r.check_and_record("p"));
        assert!(!r.check_and_record("p"));
    }
}
