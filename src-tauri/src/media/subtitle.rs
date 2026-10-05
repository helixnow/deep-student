//! 字幕导入（`.srt` / `.vtt` / B 站 BCC JSON）与导出（srt / vtt / txt）
//!
//! 解析用户自己的字幕文件，以及 [`super::bilibili`] 从 B 站接口取回的 BCC JSON（不下载平台音视频）。
//! 编码：UTF-8（含 BOM）优先，UTF-16 BOM 与 GB18030 兜底（国内字幕常见 GBK）。

use crate::vfs::repos::media_transcript_repo::{MediaSegmentRow, PlannedSpan, SEGMENT_STATUS_DONE};

use super::transcript::build_transcript_text;
use super::MediaError;

/// 字幕文件大小上限
pub const MAX_SUBTITLE_BYTES: u64 = 20 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubtitleFormat {
    Srt,
    Vtt,
    Bcc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExportFormat {
    Srt,
    Vtt,
    Txt,
}

impl ExportFormat {
    pub fn parse(s: &str) -> Result<Self, MediaError> {
        match s
            .trim()
            .trim_start_matches('.')
            .to_ascii_lowercase()
            .as_str()
        {
            "srt" => Ok(ExportFormat::Srt),
            "vtt" | "webvtt" => Ok(ExportFormat::Vtt),
            "txt" | "text" => Ok(ExportFormat::Txt),
            other => Err(MediaError::InvalidInput(format!(
                "不支持的导出格式: {}（可选 srt / vtt / txt）",
                other
            ))),
        }
    }

    pub fn extension(&self) -> &'static str {
        match self {
            ExportFormat::Srt => "srt",
            ExportFormat::Vtt => "vtt",
            ExportFormat::Txt => "txt",
        }
    }
}

/// 字节 → 文本（BOM / UTF-8 / GB18030）
pub fn decode_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return String::from_utf8_lossy(rest).into_owned();
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return encoding_rs::UTF_16LE.decode(bytes).0.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return encoding_rs::UTF_16BE.decode(bytes).0.into_owned();
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => s.to_string(),
        Err(_) => encoding_rs::GB18030.decode(bytes).0.into_owned(),
    }
}

/// 依据扩展名与内容判断格式
pub fn detect_format(file_name: &str, text: &str) -> Option<SubtitleFormat> {
    let lower = file_name.to_ascii_lowercase();
    let head = text.trim_start_matches('\u{feff}').trim_start();
    if lower.ends_with(".vtt") || head.starts_with("WEBVTT") {
        return Some(SubtitleFormat::Vtt);
    }
    if lower.ends_with(".json") || lower.ends_with(".bcc") || head.starts_with('{') {
        return Some(SubtitleFormat::Bcc);
    }
    if lower.ends_with(".srt") || head.contains("-->") {
        return Some(SubtitleFormat::Srt);
    }
    None
}

/// 解析字幕为（时间段, 文本），按开始时间排序，丢弃空文本
pub fn parse_subtitle(
    file_name: &str,
    bytes: &[u8],
) -> Result<Vec<(PlannedSpan, String)>, MediaError> {
    let text = decode_text(bytes);
    let format = detect_format(file_name, &text).ok_or_else(|| {
        MediaError::InvalidInput("无法识别的字幕格式（支持 .srt / .vtt / B 站 BCC .json）".into())
    })?;
    let mut cues = match format {
        SubtitleFormat::Srt | SubtitleFormat::Vtt => parse_cues(&text),
        SubtitleFormat::Bcc => parse_bcc(&text)?,
    };
    cues.retain(|(_, t)| !t.trim().is_empty());
    cues.sort_by_key(|(span, _)| (span.start_ms, span.end_ms));
    if cues.is_empty() {
        return Err(MediaError::InvalidInput(
            "字幕文件中没有可用的字幕条目".into(),
        ));
    }
    Ok(cues)
}

/// `hh:mm:ss,mmm` / `mm:ss.mmm` / `hh:mm:ss.mmm` → 毫秒
pub fn parse_cue_time(raw: &str) -> Option<i64> {
    let raw = raw.trim().replace(',', ".");
    let (hms, frac) = match raw.split_once('.') {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (raw.clone(), String::new()),
    };
    let parts: Vec<i64> = hms
        .split(':')
        .map(|p| p.trim().parse::<i64>().ok())
        .collect::<Option<Vec<_>>>()?;
    let secs = match parts.as_slice() {
        [h, m, s] => h * 3600 + m * 60 + s,
        [m, s] => m * 60 + s,
        [s] => *s,
        _ => return None,
    };
    let frac_digits: String = frac
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .take(3)
        .collect();
    let ms = if frac_digits.is_empty() {
        0
    } else {
        let n: i64 = frac_digits.parse().ok()?;
        n * 10i64.pow(3 - frac_digits.len() as u32)
    };
    Some(secs * 1000 + ms)
}

/// 去掉字幕内联标签：`<i>`、`<c.x>`、`<v 讲者>`、`<00:00:01.000>`、`{\an8}`
fn strip_markup(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut depth_angle = false;
    let mut depth_brace = false;
    for ch in line.chars() {
        match ch {
            '<' => depth_angle = true,
            '>' if depth_angle => depth_angle = false,
            '{' => depth_brace = true,
            '}' if depth_brace => depth_brace = false,
            _ if depth_angle || depth_brace => {}
            _ => out.push(ch),
        }
    }
    out.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .trim()
        .to_string()
}

/// SRT 与 WebVTT 共用的 cue 解析（按 `-->` 行定位）
fn parse_cues(text: &str) -> Vec<(PlannedSpan, String)> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut cues = Vec::new();
    let mut lines = normalized.lines().peekable();
    let mut in_skip_block = false;
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            in_skip_block = false;
            continue;
        }
        // WebVTT NOTE / STYLE / REGION 块整体跳过
        if trimmed.starts_with("NOTE") || trimmed == "STYLE" || trimmed == "REGION" {
            in_skip_block = true;
            continue;
        }
        if in_skip_block || !trimmed.contains("-->") {
            continue;
        }
        let Some((a, b)) = trimmed.split_once("-->") else {
            continue;
        };
        // vtt 时间后可能跟 cue settings（"align:start position:10%"）
        let end_raw = b.split_whitespace().next().unwrap_or("");
        let (Some(start), Some(end)) = (parse_cue_time(a), parse_cue_time(end_raw)) else {
            continue;
        };
        let mut body = Vec::new();
        while let Some(next) = lines.peek() {
            // 空行结束本 cue；缺空行的畸形文件遇到下一条时间行也结束（不消费，留给外层）
            if next.trim().is_empty() || next.contains("-->") {
                break;
            }
            let next = lines.next().unwrap_or_default();
            let cleaned = strip_markup(next);
            if !cleaned.is_empty() {
                body.push(cleaned);
            }
        }
        cues.push((
            PlannedSpan {
                start_ms: start,
                end_ms: end.max(start),
            },
            body.join(" "),
        ));
    }
    cues
}

#[derive(serde::Deserialize)]
struct BccBody {
    body: Vec<BccItem>,
}

#[derive(serde::Deserialize)]
struct BccItem {
    from: f64,
    to: f64,
    content: String,
}

/// B 站 BCC JSON：`{"body":[{"from":秒,"to":秒,"content":"…"}]}`
fn parse_bcc(text: &str) -> Result<Vec<(PlannedSpan, String)>, MediaError> {
    let parsed: BccBody = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|e| MediaError::InvalidInput(format!("BCC 字幕 JSON 解析失败: {}", e)))?;
    Ok(parsed
        .body
        .into_iter()
        .filter(|item| item.from.is_finite() && item.to.is_finite() && item.from >= 0.0)
        .map(|item| {
            let start = (item.from * 1000.0).round() as i64;
            let end = ((item.to * 1000.0).round() as i64).max(start);
            (
                PlannedSpan {
                    start_ms: start,
                    end_ms: end,
                },
                item.content.replace('\n', " ").trim().to_string(),
            )
        })
        .collect())
}

fn format_cue_time(ms: i64, sep: char) -> String {
    let ms = ms.max(0);
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1000;
    let milli = ms % 1000;
    format!("{:02}:{:02}:{:02}{}{:03}", h, m, s, sep, milli)
}

/// 导出（仅已完成且非空的段）
pub fn export_segments(segments: &[MediaSegmentRow], format: ExportFormat) -> String {
    let done: Vec<&MediaSegmentRow> = segments
        .iter()
        .filter(|s| s.status == SEGMENT_STATUS_DONE && !s.text.trim().is_empty())
        .collect();
    match format {
        ExportFormat::Txt => {
            let mut text = build_transcript_text(segments);
            if !text.is_empty() {
                text.push('\n');
            }
            text
        }
        ExportFormat::Srt => {
            let mut out = String::new();
            for (i, s) in done.iter().enumerate() {
                out.push_str(&format!(
                    "{}\n{} --> {}\n{}\n\n",
                    i + 1,
                    format_cue_time(s.start_ms, ','),
                    format_cue_time(s.end_ms, ','),
                    // 正文中的 "-->" 会被播放器误判为时间行
                    s.text.trim().replace("-->", "→")
                ));
            }
            out
        }
        ExportFormat::Vtt => {
            let mut out = String::from("WEBVTT\n\n");
            for s in done {
                out.push_str(&format!(
                    "{} --> {}\n{}\n\n",
                    format_cue_time(s.start_ms, '.'),
                    format_cue_time(s.end_ms, '.'),
                    // "-->" 在 cue 正文中非法
                    s.text.trim().replace("-->", "→")
                ));
            }
            out
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(idx: i64, start: i64, end: i64, text: &str) -> MediaSegmentRow {
        MediaSegmentRow {
            idx,
            start_ms: start,
            end_ms: end,
            text: text.into(),
            status: SEGMENT_STATUS_DONE,
            source: "asr".into(),
            plan_version: 1,
        }
    }

    #[test]
    fn cue_time_variants() {
        assert_eq!(parse_cue_time("00:00:01,500"), Some(1_500));
        assert_eq!(parse_cue_time("01:02:03.004"), Some(3_723_004));
        assert_eq!(parse_cue_time("02:03.4"), Some(123_400));
        assert_eq!(parse_cue_time("bad"), None);
    }

    #[test]
    fn parses_srt_with_markup_and_crlf() {
        let srt = "1\r\n00:00:01,000 --> 00:00:03,500\r\n<i>你好</i>\r\n世界\r\n\r\n2\r\n00:00:04,000 --> 00:00:06,000\r\n{\\an8}第二句\r\n\r\n3\r\n00:00:07,000 --> 00:00:08,000\r\n\r\n";
        let cues = parse_subtitle("a.srt", srt.as_bytes()).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(
            cues[0].0,
            PlannedSpan {
                start_ms: 1000,
                end_ms: 3500
            }
        );
        assert_eq!(cues[0].1, "你好 世界");
        assert_eq!(cues[1].1, "第二句");
    }

    #[test]
    fn parses_vtt_with_settings_notes_and_voice_tags() {
        let vtt = "WEBVTT - lecture\n\nNOTE this is a comment\nspanning lines\n\nSTYLE\n::cue { color: red }\n\nintro\n00:01.000 --> 00:03.000 align:start position:10%\n<v 老师>今天讲<c.hl>傅里叶</c></v>\n\n00:00:04.250 --> 00:00:05.000\nA &amp; B <00:00:04.500>next\n";
        let cues = parse_subtitle("x.vtt", vtt.as_bytes()).unwrap();
        assert_eq!(cues.len(), 2, "{:?}", cues);
        assert_eq!(
            cues[0].0,
            PlannedSpan {
                start_ms: 1000,
                end_ms: 3000
            }
        );
        assert_eq!(cues[0].1, "今天讲傅里叶");
        assert_eq!(cues[1].0.start_ms, 4250);
        assert_eq!(cues[1].1, "A & B next");
    }

    #[test]
    fn parses_bilibili_bcc_json() {
        let bcc = r#"{"font_size":0.4,"body":[{"from":2.5,"to":4.0,"location":2,"content":"第二条"},{"from":0.0,"to":2.1,"location":2,"content":"第一条\n换行"}]}"#;
        let cues = parse_subtitle("sub.json", bcc.as_bytes()).unwrap();
        assert_eq!(cues.len(), 2);
        assert_eq!(cues[0].1, "第一条 换行");
        assert_eq!(
            cues[0].0,
            PlannedSpan {
                start_ms: 0,
                end_ms: 2100
            }
        );
        assert_eq!(cues[1].0.start_ms, 2500);
    }

    #[test]
    fn decodes_gbk_and_rejects_garbage() {
        let (gbk, _, _) = encoding_rs::GBK.encode("1\n00:00:01,000 --> 00:00:02,000\n中文字幕\n");
        let cues = parse_subtitle("gbk.srt", &gbk).unwrap();
        assert_eq!(cues[0].1, "中文字幕");
        assert!(parse_subtitle("x.txt", b"hello world").is_err());
        assert!(parse_subtitle("x.json", b"{\"nope\":1}").is_err());
    }

    #[test]
    fn export_roundtrips_through_parsers() {
        let segs = vec![
            seg(0, 1_000, 2_500, "第一句"),
            seg(1, 3_000, 3_725_004, "跨 --> 小时"),
            MediaSegmentRow {
                status: 0,
                ..seg(2, 4_000, 5_000, "pending")
            },
        ];
        let srt = export_segments(&segs, ExportFormat::Srt);
        assert!(srt.starts_with("1\n00:00:01,000 --> 00:00:02,500\n第一句\n\n2\n"));
        let back = parse_subtitle("e.srt", srt.as_bytes()).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[1].0.end_ms, 3_725_004);
        assert_eq!(back[1].1, "跨 → 小时");

        let vtt = export_segments(&segs, ExportFormat::Vtt);
        assert!(vtt.starts_with("WEBVTT\n\n00:00:01.000 --> 00:00:02.500\n"));
        let back = parse_subtitle("e.vtt", vtt.as_bytes()).unwrap();
        assert_eq!(back.len(), 2);
        assert_eq!(back[1].1, "跨 → 小时");

        let txt = export_segments(&segs, ExportFormat::Txt);
        assert_eq!(txt, "[00:01] 第一句\n[00:03] 跨 --> 小时\n");
        assert_eq!(ExportFormat::parse("WebVTT").unwrap(), ExportFormat::Vtt);
        assert!(ExportFormat::parse("docx").is_err());
    }
}
