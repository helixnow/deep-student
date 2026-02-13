/// SSE行缓冲工具
/// 用于处理跨chunk的不完整SSE行，确保数据完整性
pub struct SseLineBuffer {
    buffer: String,
}

impl SseLineBuffer {
    pub fn new() -> Self {
        Self {
            buffer: String::new(),
        }
    }

    /// 处理新到达的chunk数据，返回完整的行
    pub fn process_chunk(&mut self, chunk: &str) -> Vec<String> {
        let mut lines = Vec::new();

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
    pub fn check_done_marker(line: &str) -> bool {
        line.trim() == "data: [DONE]"
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
}
