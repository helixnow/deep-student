//! 转写文本的稳定行格式：`[mm:ss] 文本`（≥ 1 小时为 `[h:mm:ss]`）
//!
//! 媒体资源的 `files.extracted_text` 即按本格式逐段一行写入，使 chatanki / qbank
//! 等读取 extracted_text 的既有消费方直接可用；引用格式 `[媒体@id:mm:ss]`
//! 与此处的时间戳写法一致（设计契约 §2）。

use crate::vfs::repos::media_transcript_repo::{MediaSegmentRow, SEGMENT_STATUS_DONE};

/// 毫秒 → `mm:ss` / `h:mm:ss`（向下取整到秒）
pub fn format_timestamp(ms: i64) -> String {
    let total = ms.max(0) / 1000;
    let h = total / 3600;
    let m = (total % 3600) / 60;
    let s = total % 60;
    if h > 0 {
        format!("{}:{:02}:{:02}", h, m, s)
    } else {
        format!("{:02}:{:02}", m, s)
    }
}

/// 解析 `mm:ss` / `h:mm:ss` / `m:ss` → 毫秒
pub fn parse_timestamp(input: &str) -> Option<i64> {
    let parts: Vec<&str> = input.trim().split(':').collect();
    let nums: Option<Vec<i64>> = parts.iter().map(|p| p.parse::<i64>().ok()).collect();
    let nums = nums?;
    let secs = match nums.as_slice() {
        [m, s] if *s < 60 => m * 60 + s,
        [h, m, s] if *m < 60 && *s < 60 => h * 3600 + m * 60 + s,
        _ => return None,
    };
    Some(secs * 1000)
}

/// 单段一行（文本内换行折叠为空格）
pub fn format_line(start_ms: i64, text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("[{}] {}", format_timestamp(start_ms), flat)
}

/// 已完成且非空的段 → 多行转写文本
pub fn build_transcript_text(segments: &[MediaSegmentRow]) -> String {
    segments
        .iter()
        .filter(|s| s.status == SEGMENT_STATUS_DONE && !s.text.trim().is_empty())
        .map(|s| format_line(s.start_ms, &s.text))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(idx: i64, start: i64, text: &str, status: i64) -> MediaSegmentRow {
        MediaSegmentRow {
            idx,
            start_ms: start,
            end_ms: start + 1000,
            text: text.to_string(),
            status,
            source: "asr".into(),
            plan_version: 1,
        }
    }

    #[test]
    fn timestamps_roundtrip() {
        assert_eq!(format_timestamp(0), "00:00");
        assert_eq!(format_timestamp(65_999), "01:05");
        assert_eq!(format_timestamp(3_600_000 + 61_000), "1:01:01");
        assert_eq!(parse_timestamp("01:05"), Some(65_000));
        assert_eq!(parse_timestamp("1:01:01"), Some(3_661_000));
        assert_eq!(parse_timestamp("1:61"), None);
        assert_eq!(parse_timestamp("abc"), None);
    }

    #[test]
    fn transcript_text_skips_pending_and_empty() {
        let text = build_transcript_text(&[
            seg(0, 0, "你好\n世界", 1),
            seg(1, 5_000, "", 1),
            seg(2, 9_000, "pending", 0),
            seg(3, 3_725_000, "late", 1),
        ]);
        assert_eq!(text, "[00:00] 你好 世界\n[1:02:05] late");
    }
}
