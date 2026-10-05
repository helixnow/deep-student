//! 媒体转写 → 制卡 / 出题的材料预处理（docs/dev/media-learning/README.md §3）
//!
//! 音视频的 `files.extracted_text` 是逐段 `[mm:ss] 文本` 的转写字幕。直接整段丢给
//! 制卡/出题流水线有两个问题：
//! 1. 段与段之间只有单换行，段落切分器（按 `\n\n`）会把整节课当成一段；
//! 2. 分片后的后续片段里看不到资源 ID，模型无法给出可跳转的 `[媒体@id:mm:ss]` 出处。
//!
//! 这里按 ~600 秒切片，每片带 `[媒体@id:起点]` 锚点标题，并附上一片末尾 3 段作为
//! 「上文回顾」（只帮助理解语境，不针对它制卡）。切片 + 上文回顾 + 一卡一事实 + 去重
//! 的思路借鉴 BA7MLV/wangke-agent（src/pipelines/cards.ts、src/harness/prompts.ts，
//! MIT License, Copyright (c) 2026 BA7MLV）。

use rusqlite::{params, Connection, OptionalExtension};

/// 每个切片覆盖的时长（秒）
pub const MEDIA_CHUNK_SPAN_SECS: u32 = 600;
/// 上文回顾取上一片末尾的段数
pub const MEDIA_RECAP_LINES: usize = 3;
/// 少于该段数不视为转写字幕（避免把偶然以 `[01:02]` 开头的普通文本误切）
const MIN_TIMESTAMPED_LINES: usize = 3;

/// 制卡（chatanki）附加要求：材料含媒体锚点时追加到 custom_requirements
pub const MEDIA_CARD_REQUIREMENTS: &str = "材料来自音视频课程转写（每行 [mm:ss] 为该句开始时间，标题含 [媒体@资源ID:时间] 锚点）：\n\
- 每张卡背面末尾另起一行写出处 [媒体@资源ID:mm:ss]，资源 ID 取所在片段标题，时间取该知识点讲到的那一行（≥1 小时写 h:mm:ss），不得编造。\n\
- 一卡一事实；问题自包含，带上必要的课程语境，脱离视频也能看懂。\n\
- 只针对值得长期记忆的内容（定义、结论、公式、步骤、对比、易错点）；口头禅、寒暄、课程安排不制卡。\n\
- 「上文回顾」引用块只帮助理解语境，不要针对它制卡；跨片段重复讲到的知识点只制一张。";

/// 出题（qbank）附加要求：参考资料含媒体锚点时追加到用户 prompt
pub const MEDIA_QUESTION_REQUIREMENTS: &str = "## 音视频课程出处要求\n\
参考资料含音视频转写（每行 [mm:ss] 为该句开始时间，片段标题含 [媒体@资源ID:时间] 锚点）：\n\
- 每题 explanation 末尾另起一行写依据出处 [媒体@资源ID:mm:ss]（资源 ID 取所在片段标题，时间取依据所在行，≥1 小时写 h:mm:ss），不得编造。\n\
- 题目必须基于课程实际讲到的内容；「上文回顾」引用块只帮助理解语境，不要单独据此出题；不同片段重复讲到的知识点只出一次。\n\n";

/// 秒 → `mm:ss`（≥ 1 小时为 `h:mm:ss`），与前端 formatMediaRefTimestamp 一致
pub fn format_media_clock(total_seconds: u32) -> String {
    let h = total_seconds / 3600;
    let m = (total_seconds % 3600) / 60;
    let s = total_seconds % 60;
    if h > 0 {
        format!("{h}:{m:02}:{s:02}")
    } else {
        format!("{m:02}:{s:02}")
    }
}

/// `[媒体@{resource_id}:{mm:ss}]`
pub fn media_citation(resource_id: &str, seconds: u32) -> String {
    format!("[媒体@{}:{}]", resource_id, format_media_clock(seconds))
}

/// 解析 `mm:ss` / `h:mm:ss` → 秒（秒位须 < 60）
fn parse_clock(raw: &str) -> Option<u32> {
    let parts: Vec<&str> = raw.trim().split(':').collect();
    let nums: Option<Vec<u32>> = parts
        .iter()
        .map(|p| {
            if p.is_empty() || p.len() > 3 || !p.bytes().all(|b| b.is_ascii_digit()) {
                None
            } else {
                p.parse::<u32>().ok()
            }
        })
        .collect();
    let nums = nums?;
    match nums.as_slice() {
        [m, s] if *s < 60 => Some(m * 60 + s),
        [h, m, s] if *s < 60 && *m < 60 => Some(h * 3600 + m * 60 + s),
        _ => None,
    }
}

/// 行首 `[mm:ss]`（容忍 `[mm:ss - mm:ss]` / `[mm:ss→mm:ss]` 区间，取起点）→ (秒, 正文)
pub fn parse_timestamped_line(line: &str) -> Option<(u32, &str)> {
    let trimmed = line.trim_start();
    let rest = trimmed.strip_prefix('[')?;
    let close = rest.find(']')?;
    let inside = &rest[..close];
    let start = inside.split(['-', '–', '~', '→']).next()?;
    let seconds = parse_clock(start)?;
    Some((seconds, rest[close + 1..].trim_start()))
}

/// 从文本里找第一个 `[媒体@id:时间]` 引用 → (resource_id, 秒)
pub fn first_media_citation(text: &str) -> Option<(String, u32)> {
    let mut cursor = text;
    while let Some(pos) = cursor.find("[媒体@") {
        let after = &cursor[pos + "[媒体@".len()..];
        if let Some(end) = after.find(']') {
            let body = &after[..end];
            if let Some(colon) = body.find(':') {
                let id = body[..colon].trim();
                if !id.is_empty() && !id.contains(char::is_whitespace) {
                    if let Some(seconds) = parse_clock(&body[colon + 1..]) {
                        return Some((id.to_string(), seconds));
                    }
                }
            }
        }
        cursor = after;
    }
    None
}

/// 文本里第一个指向 `resource_id` 的 `[媒体@id:时间]` 引用 → 秒
pub fn media_citation_seconds_for(text: &str, resource_id: &str) -> Option<u32> {
    let needle = format!("[媒体@{}:", resource_id);
    let mut cursor = text;
    while let Some(pos) = cursor.find(&needle) {
        let after = &cursor[pos + needle.len()..];
        if let Some(end) = after.find(']') {
            if let Some(seconds) = parse_clock(&after[..end]) {
                return Some(seconds);
            }
        }
        cursor = after;
    }
    None
}

/// 文本是否带媒体锚点（由 [`chunk_transcript_for_generation`] 注入）
pub fn contains_media_anchor(text: &str) -> bool {
    first_media_citation(text).is_some()
}

/// 按 ~600 秒切片转写字幕，返回带锚点标题与上文回顾的材料文本。
///
/// 不是转写形态（带时间戳的行少于 3 行）时返回 `None`，调用方保留原文。
/// 无时间戳的行（续行）归入当前片段。
pub fn chunk_transcript_for_generation(resource_id: &str, text: &str) -> Option<String> {
    let lines: Vec<&str> = text
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.trim().is_empty())
        .collect();
    let stamped = lines
        .iter()
        .filter(|l| parse_timestamped_line(l).is_some())
        .count();
    if stamped < MIN_TIMESTAMPED_LINES {
        return None;
    }

    // (片段起点秒, 行)
    let mut chunks: Vec<(u32, Vec<&str>)> = Vec::new();
    for line in lines {
        let ts = parse_timestamped_line(line).map(|(s, _)| s);
        let start_new = match (chunks.last(), ts) {
            (None, _) => true,
            (Some((chunk_start, _)), Some(t)) => t >= chunk_start + MEDIA_CHUNK_SPAN_SECS,
            (Some(_), None) => false,
        };
        if start_new {
            chunks.push((ts.unwrap_or(0), Vec::new()));
        }
        if let Some(last) = chunks.last_mut() {
            last.1.push(line);
        }
    }

    let total = chunks.len();
    let mut out = String::with_capacity(text.len() + total * 96);
    for (i, (start, body)) in chunks.iter().enumerate() {
        if i > 0 {
            out.push_str("\n\n");
        }
        out.push_str(&format!(
            "## 片段 {}/{} · {} 起\n",
            i + 1,
            total,
            media_citation(resource_id, *start)
        ));
        if i > 0 {
            let prev = &chunks[i - 1].1;
            let recap = &prev[prev.len().saturating_sub(MEDIA_RECAP_LINES)..];
            out.push_str("> 上文回顾（仅帮助理解语境，不要针对它制卡/出题）：\n");
            for line in recap {
                out.push_str("> ");
                out.push_str(line.trim());
                out.push('\n');
            }
        }
        for line in body {
            out.push_str(line);
            out.push('\n');
        }
    }
    Some(out.trim_end().to_string())
}

/// `files` 中的音视频文件 → 文件名；非媒体 / 不存在返回 None
pub fn media_file_name(conn: &Connection, file_id: &str) -> Option<String> {
    let row: Option<(String, Option<String>, String)> = conn
        .query_row(
            "SELECT COALESCE(type, ''), mime_type, file_name FROM files WHERE id = ?1",
            params![file_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()
        .ok()
        .flatten();
    let (file_type, mime, name) = row?;
    let mime = mime.unwrap_or_default().to_ascii_lowercase();
    let is_media = matches!(file_type.as_str(), "audio" | "video")
        || mime.starts_with("audio/")
        || mime.starts_with("video/");
    is_media.then_some(name)
}

/// 媒体文件的提取文本 → 带锚点切片；非媒体或非转写形态原样返回
pub fn prepare_media_text_for_generation(conn: &Connection, file_id: &str, text: String) -> String {
    if media_file_name(conn, file_id).is_none() {
        return text;
    }
    chunk_transcript_for_generation(file_id, &text).unwrap_or(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn transcript(lines: &[(u32, &str)]) -> String {
        lines
            .iter()
            .map(|(s, t)| format!("[{}] {}", format_media_clock(*s), t))
            .collect::<Vec<_>>()
            .join("\n")
    }

    #[test]
    fn clock_round_trips_and_switches_to_hours() {
        assert_eq!(format_media_clock(0), "00:00");
        assert_eq!(format_media_clock(605), "10:05");
        assert_eq!(format_media_clock(3725), "1:02:05");
        assert_eq!(parse_clock("10:05"), Some(605));
        assert_eq!(parse_clock("1:02:05"), Some(3725));
        assert_eq!(parse_clock("75:00"), Some(4500));
        assert_eq!(parse_clock("10:60"), None);
        assert_eq!(parse_clock("a:05"), None);
    }

    #[test]
    fn parses_line_timestamps_and_ranges() {
        assert_eq!(
            parse_timestamped_line("[03:25] 正则化"),
            Some((205, "正则化"))
        );
        assert_eq!(
            parse_timestamped_line("  [1:00:01 - 1:00:09] 小结"),
            Some((3601, "小结"))
        );
        assert_eq!(parse_timestamped_line("[知识库-1] 不是时间"), None);
        assert_eq!(parse_timestamped_line("没有时间戳"), None);
    }

    #[test]
    fn finds_first_media_citation() {
        let text = "见 [知识库-1] 与 [媒体@file_abc:12:30] 以及 [媒体@file_def:1:00:00]";
        assert_eq!(
            first_media_citation(text),
            Some(("file_abc".to_string(), 750))
        );
        assert!(first_media_citation("[媒体@:12:30]").is_none());
        assert!(!contains_media_anchor("普通文本 [12:30]"));
    }

    #[test]
    fn finds_citation_seconds_for_one_resource() {
        let text = "见 [媒体@file_abc:12:30] 与 [媒体@file_def:99:99] [媒体@file_def:1:00:00]";
        assert_eq!(media_citation_seconds_for(text, "file_def"), Some(3600));
        assert_eq!(media_citation_seconds_for(text, "file_abc"), Some(750));
        assert_eq!(media_citation_seconds_for(text, "file_ab"), None);
    }

    #[test]
    fn non_transcript_text_is_left_alone() {
        assert!(chunk_transcript_for_generation("file_x", "第一段\n\n第二段").is_none());
        assert!(chunk_transcript_for_generation("file_x", "[00:01] 只有一行\n普通").is_none());
    }

    #[test]
    fn chunks_by_600_seconds_with_anchor_and_recap() {
        let text = transcript(&[
            (0, "开场"),
            (120, "定义 A"),
            (300, "定义 B"),
            (550, "例题一"),
            (590, "例题二"),
            (610, "第二节开始"),
            (900, "公式 C"),
            (1250, "第三节"),
        ]);
        let out = chunk_transcript_for_generation("file_x", &text).unwrap();
        // 0 / 610 / 1250 三片（1250 ≥ 610 + 600）
        assert!(out.contains("## 片段 1/3 · [媒体@file_x:00:00] 起"));
        assert!(out.contains("## 片段 2/3 · [媒体@file_x:10:10] 起"));
        assert!(out.contains("## 片段 3/3 · [媒体@file_x:20:50] 起"));
        // 段落切分器按空行切：每片一个段落
        assert_eq!(out.split("\n\n").count(), 3);
        // 第二片回顾上一片末尾 3 段
        let second = out.split("\n\n").nth(1).unwrap();
        assert!(second.contains("> [05:00] 定义 B"));
        assert!(second.contains("> [09:50] 例题二"));
        assert!(!second.contains("> [02:00] 定义 A"));
        // 首片没有回顾
        assert!(!out.split("\n\n").next().unwrap().contains("上文回顾"));
        assert!(contains_media_anchor(&out));
    }

    #[test]
    fn continuation_lines_stay_in_current_chunk() {
        let text = "[00:00] 甲\n续行\n[00:10] 乙\n[00:20] 丙";
        let out = chunk_transcript_for_generation("file_y", text).unwrap();
        assert!(out.contains("[00:00] 甲\n续行\n[00:10] 乙"));
        assert_eq!(out.matches("## 片段").count(), 1);
    }

    #[test]
    fn media_detection_reads_files_type_and_mime() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE files (id TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'document',
                mime_type TEXT, file_name TEXT NOT NULL);
             INSERT INTO files VALUES ('file_a', 'audio', 'audio/mpeg', '第1讲.mp3');
             INSERT INTO files VALUES ('file_v', 'document', 'video/mp4', '第2讲.mp4');
             INSERT INTO files VALUES ('file_d', 'document', 'application/pdf', '讲义.pdf');",
        )
        .unwrap();
        assert_eq!(
            media_file_name(&conn, "file_a").as_deref(),
            Some("第1讲.mp3")
        );
        assert_eq!(
            media_file_name(&conn, "file_v").as_deref(),
            Some("第2讲.mp4")
        );
        assert_eq!(media_file_name(&conn, "file_d"), None);
        assert_eq!(media_file_name(&conn, "file_missing"), None);

        let text = transcript(&[(0, "一"), (5, "二"), (9, "三")]);
        let prepared = prepare_media_text_for_generation(&conn, "file_a", text.clone());
        assert!(prepared.starts_with("## 片段 1/1 · [媒体@file_a:00:00] 起"));
        let untouched = prepare_media_text_for_generation(&conn, "file_d", text.clone());
        assert_eq!(untouched, text);
    }
}
