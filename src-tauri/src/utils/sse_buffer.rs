//! SSE 行/事件缓冲工具
//!
//! 注：本文件包含 issue #122 定位探针（invalid/lossy 分支的 log::warn，仅记录
//! 长度类元数据，不记录任何 chunk/用户文本内容），不声称修复 #122。

use crate::llm_manager::utf8_stream::Utf8StreamDecoder;

/// SSE行缓冲工具
/// 用于处理跨chunk的不完整SSE行，确保数据完整性
pub struct SseLineBuffer {
    buffer: String,
    max_buffer_size: usize,
}

/// 默认缓冲区上限：10 MB。正常SSE单行不会超过几KB，
/// 超过此阈值说明上游异常（恶意服务端或协议错误）。
const DEFAULT_MAX_BUFFER_SIZE: usize = 10 * 1024 * 1024;

impl SseLineBuffer {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
            max_buffer_size: DEFAULT_MAX_BUFFER_SIZE,
        }
    }

    #[cfg(test)]
    fn with_max_size(max_buffer_size: usize) -> Self {
        Self {
            buffer: String::new(),
            max_buffer_size,
        }
    }

    /// 处理新到达的chunk数据，返回完整的行
    pub fn process_chunk(&mut self, chunk: &str) -> Vec<String> {
        let mut lines = Vec::new();

        if self.buffer.len().saturating_add(chunk.len()) > self.max_buffer_size {
            tracing::error!(
                buffer_len = self.buffer.len(),
                chunk_len = chunk.len(),
                max = self.max_buffer_size,
                "SSE缓冲区超过大小上限，丢弃数据以防OOM"
            );
            self.buffer.clear();
            return lines;
        }

        // 将新数据追加到缓冲区
        self.buffer.push_str(chunk);

        // 按行分割，最后一行可能不完整
        let split_lines: Vec<&str> = self.buffer.lines().collect();

        if split_lines.is_empty() {
            return lines;
        }

        // 检查最后一行是否完整（以换行符结尾）
        let last_line_complete = self.buffer.ends_with('\n') || self.buffer.ends_with("\r\n");

        if last_line_complete {
            // 所有行都完整，返回所有行并清空缓冲区
            lines.extend(split_lines.iter().map(|s| s.to_string()));
            self.buffer.clear();
        } else {
            // 最后一行不完整，保留在缓冲区中
            if split_lines.len() > 1 {
                // 返回除最后一行外的所有完整行
                lines.extend(
                    split_lines[..split_lines.len() - 1]
                        .iter()
                        .map(|s| s.to_string()),
                );
                // 保留最后一行作为下次的缓冲
                self.buffer = split_lines[split_lines.len() - 1].to_string();
            }
            // 如果只有一行且不完整，保持缓冲区不变，等待更多数据
        }

        lines
    }

    /// 检查缓冲区是否有剩余数据
    pub fn has_remaining(&self) -> bool {
        !self.buffer.is_empty()
    }

    /// 获取剩余的不完整行（用于最终处理）
    pub fn flush(&mut self) -> Option<String> {
        if self.buffer.is_empty() {
            None
        } else {
            let remaining = self.buffer.clone();
            self.buffer.clear();
            Some(remaining)
        }
    }

    /// 检查是否遇到结束标记
    ///
    /// 🔧 兼容 "data:[DONE]"（无空格变体，SSE 规范允许，部分中转站使用）
    pub fn check_done_marker(line: &str) -> bool {
        let trimmed = line.trim();
        matches!(trimmed, "data: [DONE]" | "data:[DONE]")
    }

    /// 清空缓冲区
    pub fn clear(&mut self) {
        self.buffer.clear();
    }
}

impl Default for SseLineBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Byte-oriented SSE event buffer for LLM streams.
///
/// Unlike `SseLineBuffer`, this keeps `event:` metadata attached to its `data:`
/// payload. Raw network bytes are fed through an incremental UTF-8 decoder
/// (`Utf8StreamDecoder`), so a multi-byte character split across chunk
/// boundaries is held back until its remaining bytes arrive instead of being
/// lossy-decoded into U+FFFD (`�`). A complete JSON data line is emitted
/// immediately so data-only OpenAI streams retain their existing low-latency
/// behavior.
pub struct SseEventBuffer {
    /// 跨 chunk 增量 UTF-8 解码器：chunk 末尾被切断的多字节字符（中文/emoji）
    /// 暂存在这里等待后续字节，绝不对半截序列做 lossy 替换（issue #122）。
    decoder: Utf8StreamDecoder,
    /// 已解码、但尚未凑满一整行的文本
    text_buffer: String,
    pending_lines: Vec<String>,
    max_buffer_size: usize,
}

impl SseEventBuffer {
    pub fn new() -> Self {
        Self {
            decoder: Utf8StreamDecoder::new(),
            text_buffer: String::new(),
            pending_lines: Vec::new(),
            max_buffer_size: DEFAULT_MAX_BUFFER_SIZE,
        }
    }

    #[cfg(test)]
    fn with_max_size(max_buffer_size: usize) -> Self {
        Self {
            decoder: Utf8StreamDecoder::new(),
            text_buffer: String::new(),
            pending_lines: Vec::new(),
            max_buffer_size,
        }
    }

    /// Add an arbitrary network byte chunk and return complete SSE event blocks.
    pub fn process_bytes(&mut self, chunk: &[u8]) -> Vec<String> {
        let pending_size = self
            .pending_lines
            .iter()
            .map(|line| line.len().saturating_add(1))
            .sum::<usize>();
        if self
            .text_buffer
            .len()
            .saturating_add(pending_size)
            .saturating_add(chunk.len())
            > self.max_buffer_size
        {
            tracing::error!(
                text_buffer_len = self.text_buffer.len(),
                pending_size,
                chunk_len = chunk.len(),
                max = self.max_buffer_size,
                "SSE event buffer exceeded size limit; dropping buffered data"
            );
            self.clear();
            return Vec::new();
        }

        // 增量解码：跨 chunk 被切断的多字节字符保留在 decoder 内部，
        // 待下一个 chunk 补齐后再输出，保证行内容永远是完整字符。
        self.text_buffer.push_str(&self.decoder.decode(chunk));
        let mut events = Vec::new();

        while let Some(newline) = self.text_buffer.find('\n') {
            let mut line: String = self.text_buffer.drain(..=newline).collect();
            line.pop();
            if line.ends_with('\r') {
                line.pop();
            }
            self.push_line(line, &mut events);
        }

        events
    }

    /// Flush a stream that closed without a trailing blank line.
    ///
    /// 若流恰好在一个多字节字符中间被截断（网络中断），残留的半截字符
    /// 按 lossy 语义补一个 U+FFFD —— 此时确实丢了数据，不是解码错误。
    pub fn flush(&mut self) -> Vec<String> {
        let tail = self.decoder.flush();
        if !tail.is_empty() {
            // issue #122 定位探针（不声称修复）：流关闭时解码器仍有半截多字节
            // 字符，说明连接在字符中间被截断。只记录长度元数据。
            log::warn!(
                "[sse_buffer][issue#122 探针] 流结束时残留不完整 UTF-8 序列，已按 lossy 语义补 U+FFFD：tail_len={}, text_buffer_len={}, pending_lines={}",
                tail.len(),
                self.text_buffer.len(),
                self.pending_lines.len()
            );
        }
        self.text_buffer.push_str(&tail);
        let mut events = Vec::new();
        if !self.text_buffer.is_empty() {
            let mut line = std::mem::take(&mut self.text_buffer);
            if line.ends_with('\r') {
                line.pop();
            }
            self.push_line(line, &mut events);
        }
        self.flush_pending(&mut events);
        events
    }

    pub fn check_done_marker(block: &str) -> bool {
        block
            .lines()
            .any(|line| matches!(line.trim(), "[DONE]" | "data: [DONE]" | "data:[DONE]"))
    }

    pub fn clear(&mut self) {
        let _ = self.decoder.flush();
        self.text_buffer.clear();
        self.pending_lines.clear();
    }

    fn push_line(&mut self, line: String, events: &mut Vec<String>) {
        if line.is_empty() {
            self.flush_pending(events);
            return;
        }

        // Preserve legacy JSONL/NDJSON behavior. These lines are not SSE fields
        // and must not be joined into one invalid payload while waiting for EOF.
        if self.pending_lines.is_empty() && !line.contains(':') && line.trim() == "[DONE]" {
            events.push(line);
            return;
        }
        if self.pending_lines.is_empty()
            && !matches!(
                line.split_once(':').map(|(field, _)| field),
                Some("event" | "data" | "id" | "retry")
            )
            && serde_json::from_str::<serde_json::Value>(line.trim()).is_ok()
        {
            events.push(line);
            return;
        }

        // A new explicit event starts a new block even when a non-conforming
        // upstream omitted the blank separator after the previous event.
        if line.starts_with("event:") && !self.pending_lines.is_empty() {
            self.flush_pending(events);
        }
        self.pending_lines.push(line);

        // OpenAI-compatible streams put one complete JSON value in data. Emit
        // as soon as it is complete while retaining any preceding event field.
        if self.pending_data_is_complete() {
            self.flush_pending(events);
        }
    }

    fn pending_data_is_complete(&self) -> bool {
        let data = self
            .pending_lines
            .iter()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(|value| value.strip_prefix(' ').unwrap_or(value))
            .collect::<Vec<_>>();
        if data.is_empty() {
            return false;
        }
        let payload = data.join("\n");
        payload.trim() == "[DONE]" || serde_json::from_str::<serde_json::Value>(&payload).is_ok()
    }

    fn flush_pending(&mut self, events: &mut Vec<String>) {
        if !self.pending_lines.is_empty() {
            events.push(std::mem::take(&mut self.pending_lines).join("\n"));
        }
    }
}

impl Default for SseEventBuffer {
    fn default() -> Self {
        Self::new()
    }
}

/// Extract the payload from either an SSE event block or a bare JSON/NDJSON
/// record. Bare fallback is deliberately limited to valid JSON and `[DONE]`
/// so SSE metadata, comments, and keep-alive lines are never treated as data.
pub fn extract_stream_data_payload(block: &str) -> Option<String> {
    let data = block
        .lines()
        .filter_map(|line| line.trim_end_matches('\r').strip_prefix("data:"))
        .map(|value| value.strip_prefix(' ').unwrap_or(value))
        .collect::<Vec<_>>();
    if !data.is_empty() {
        return Some(data.join("\n"));
    }

    let bare = block.trim();
    if bare == "[DONE]" || serde_json::from_str::<serde_json::Value>(bare).is_ok() {
        Some(bare.to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_complete_lines() {
        let mut buffer = SseLineBuffer::new();
        let lines =
            buffer.process_chunk("data: {\"test\": \"value1\"}\ndata: {\"test\": \"value2\"}\n");
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0], "data: {\"test\": \"value1\"}");
        assert_eq!(lines[1], "data: {\"test\": \"value2\"}");
        assert!(!buffer.has_remaining());
    }

    #[test]
    fn test_incomplete_line() {
        let mut buffer = SseLineBuffer::new();
        let lines1 = buffer.process_chunk("data: {\"test\": \"val");
        assert_eq!(lines1.len(), 0);
        assert!(buffer.has_remaining());

        let lines2 = buffer.process_chunk("ue1\"}\ndata: {\"test\": \"value2\"}\n");
        assert_eq!(lines2.len(), 2);
        assert_eq!(lines2[0], "data: {\"test\": \"value1\"}");
        assert_eq!(lines2[1], "data: {\"test\": \"value2\"}");
        assert!(!buffer.has_remaining());
    }

    #[test]
    fn test_mixed_complete_and_incomplete() {
        let mut buffer = SseLineBuffer::new();
        let lines = buffer.process_chunk("data: {\"test\": \"value1\"}\ndata: {\"test\": \"par");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "data: {\"test\": \"value1\"}");
        assert!(buffer.has_remaining());

        let lines2 = buffer.process_chunk("tial\"}\n");
        assert_eq!(lines2.len(), 1);
        assert_eq!(lines2[0], "data: {\"test\": \"partial\"}");
        assert!(!buffer.has_remaining());
    }

    #[test]
    fn test_flush_remaining() {
        let mut buffer = SseLineBuffer::new();
        buffer.process_chunk("incomplete line without newline");
        assert!(buffer.has_remaining());

        let remaining = buffer.flush();
        assert_eq!(
            remaining,
            Some("incomplete line without newline".to_string())
        );
        assert!(!buffer.has_remaining());
    }

    #[test]
    fn test_done_marker() {
        assert!(SseLineBuffer::check_done_marker("data: [DONE]"));
        assert!(SseLineBuffer::check_done_marker("  data: [DONE]  "));
        assert!(!SseLineBuffer::check_done_marker("data: {\"done\": true}"));
    }

    #[test]
    fn test_empty_chunk() {
        let mut buffer = SseLineBuffer::new();
        let lines = buffer.process_chunk("");
        assert_eq!(lines.len(), 0);
        assert!(!buffer.has_remaining());
    }

    #[test]
    fn test_buffer_overflow_protection() {
        let mut buffer = SseLineBuffer::with_max_size(32);

        // 第一次写入在限额内
        let lines = buffer.process_chunk("data: ok\n");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "data: ok");

        // 写入超长数据（无换行），累积到缓冲区
        let lines = buffer.process_chunk("data: short");
        assert_eq!(lines.len(), 0);
        assert!(buffer.has_remaining());

        // 再追加一块，总长超过上限 → 触发保护
        let lines = buffer.process_chunk("_this_is_way_too_long_for_limit!");
        assert_eq!(lines.len(), 0);
        assert!(!buffer.has_remaining()); // 缓冲区已被清空

        // 后续正常数据不受影响
        let lines = buffer.process_chunk("data: recovered\n");
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0], "data: recovered");
    }

    #[test]
    fn test_buffer_exactly_at_limit() {
        let mut buffer = SseLineBuffer::with_max_size(16);
        // 恰好等于上限不应触发保护
        let lines = buffer.process_chunk("1234567890123456");
        assert_eq!(lines.len(), 0);
        assert!(buffer.has_remaining());

        // 再多一字节触发
        let lines = buffer.process_chunk("X");
        assert_eq!(lines.len(), 0);
        assert!(!buffer.has_remaining());
    }

    #[test]
    fn test_multiple_chunks_with_fragmentation() {
        let mut buffer = SseLineBuffer::new();

        // 模拟严重分片的情况
        let chunks = vec![
            "data: {\"",
            "test\": \"",
            "value1\"}\n",
            "data: {\"test2",
            "\": \"value2\"}\nda",
            "ta: [DONE]\n",
        ];

        let mut all_lines = Vec::new();
        for chunk in chunks {
            let lines = buffer.process_chunk(chunk);
            all_lines.extend(lines);
        }

        // 处理最后的剩余数据
        if let Some(remaining) = buffer.flush() {
            all_lines.push(remaining);
        }

        assert_eq!(all_lines.len(), 3);
        assert_eq!(all_lines[0], "data: {\"test\": \"value1\"}");
        assert_eq!(all_lines[1], "data: {\"test2\": \"value2\"}");
        assert_eq!(all_lines[2], "data: [DONE]");
    }

    #[test]
    fn event_buffer_keeps_event_name_with_data_payload() {
        let mut buffer = SseEventBuffer::new();
        let events = buffer
            .process_bytes(b"event: response.output_text.delta\ndata: {\"delta\":\"framed\"}\n\n");

        assert_eq!(events.len(), 1);
        assert_eq!(
            events[0],
            "event: response.output_text.delta\ndata: {\"delta\":\"framed\"}"
        );
    }

    #[test]
    fn event_buffer_preserves_utf8_split_across_byte_chunks() {
        let mut buffer = SseEventBuffer::new();
        let source = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"中文\"}\n\n";
        let chinese_start = source.find('中').unwrap();
        let split = chinese_start + 1;

        assert!(buffer.process_bytes(&source.as_bytes()[..split]).is_empty());
        let events = buffer.process_bytes(&source.as_bytes()[split..]);

        assert_eq!(events, vec![source.trim().to_string()]);
        assert!(!events[0].contains('\u{fffd}'));
    }

    #[test]
    fn event_buffer_no_replacement_char_when_chinese_split_in_two_chunks() {
        // issue #122 锚点：一个汉字（3 字节）拆成两个 byte chunk，
        // 中间不得出现 �，拼起来必须正确。
        let source = "data: {\"choices\":[{\"delta\":{\"content\":\"中\"}}]}\n";
        let bytes = source.as_bytes();
        let split = source.find('中').unwrap() + 1; // “中”= E4 B8 AD，切成 [E4] + [B8 AD]

        let mut buffer = SseEventBuffer::new();
        let first = buffer.process_bytes(&bytes[..split]);
        assert!(first.is_empty(), "半截 UTF-8 不应产出任何事件");

        let second = buffer.process_bytes(&bytes[split..]);
        assert_eq!(second, vec![source.trim().to_string()]);
        assert!(!second[0].contains('\u{fffd}'));
        assert!(buffer.flush().is_empty());
    }

    #[test]
    fn event_buffer_reassembles_multibyte_content_split_at_every_byte_boundary() {
        // 对含中文与 4 字节 emoji 的完整 SSE 事件在每个字节位置切分，
        // 任意 TCP 分帧点都不得产生 U+FFFD。
        let source = "data: {\"choices\":[{\"delta\":{\"content\":\"中文乱码测试🚀\"}}]}\n\n";
        let bytes = source.as_bytes();
        for split in 1..bytes.len() {
            let mut buffer = SseEventBuffer::new();
            let mut events = buffer.process_bytes(&bytes[..split]);
            for event in &events {
                assert!(
                    !event.contains('\u{fffd}'),
                    "切分点 {split} 处提前产生 U+FFFD"
                );
            }
            events.extend(buffer.process_bytes(&bytes[split..]));
            events.extend(buffer.flush());
            assert_eq!(
                events,
                vec![source.trim().to_string()],
                "切分点 {split} 处事件重组失败"
            );
        }
    }

    #[test]
    fn event_buffer_flush_marks_stream_truncated_mid_character() {
        // 流在字符中间被截断（网络中断）：数据确实丢了，
        // flush 按 lossy 语义补一个 U+FFFD，而不是丢弃残留。
        let mut buffer = SseEventBuffer::new();
        let bytes = "data: 中".as_bytes();
        assert!(buffer.process_bytes(&bytes[..bytes.len() - 1]).is_empty());
        assert_eq!(buffer.flush(), vec!["data: \u{fffd}".to_string()]);
    }

    #[test]
    fn event_buffer_emits_single_newline_done_tail() {
        let mut buffer = SseEventBuffer::new();
        let events = buffer.process_bytes(b"data:[DONE]\n");

        assert_eq!(events, vec!["data:[DONE]".to_string()]);
        assert!(SseEventBuffer::check_done_marker(&events[0]));
        assert!(buffer.flush().is_empty());
    }

    #[test]
    fn event_buffer_flushes_unterminated_event_block() {
        let mut buffer = SseEventBuffer::new();
        assert!(buffer
            .process_bytes(b"event: response.output_text.delta\ndata: {\"delta\":\"tail\"}")
            .is_empty());

        assert_eq!(
            buffer.flush(),
            vec!["event: response.output_text.delta\ndata: {\"delta\":\"tail\"}".to_string()]
        );
    }

    #[test]
    fn event_buffer_preserves_jsonl_lines() {
        let mut buffer = SseEventBuffer::new();
        let events = buffer.process_bytes(b"{\"message\":1}\n{\"message\":2}\n");

        assert_eq!(
            events,
            vec!["{\"message\":1}".to_string(), "{\"message\":2}".to_string()]
        );
        assert!(buffer.flush().is_empty());
    }

    #[test]
    fn stream_payload_accepts_bare_json_without_misreading_sse_metadata() {
        assert_eq!(
            extract_stream_data_payload(r#"{"message":1}"#),
            Some(r#"{"message":1}"#.to_string())
        );
        assert_eq!(
            extract_stream_data_payload("event: message\n: keep-alive"),
            None
        );
        assert_eq!(extract_stream_data_payload(": keep-alive"), None);
    }

    #[test]
    fn event_buffer_enforces_combined_size_limit() {
        let mut buffer = SseEventBuffer::with_max_size(24);
        assert!(buffer.process_bytes(b"event: response.test\n").is_empty());
        assert!(buffer
            .process_bytes(b"data: {\"too\":\"large\"}")
            .is_empty());
        assert!(buffer.flush().is_empty());
    }
}
