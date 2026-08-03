//! 增量 UTF-8 流式解码器
//!
//! `reqwest::bytes_stream()` 的 chunk 边界由 TCP/HTTP 分帧决定，
//! 完全可能把一个多字节 UTF-8 字符（中文 3 字节 / emoji 4 字节）切在两个 chunk 之间。
//! 直接对每个 chunk 做 `String::from_utf8_lossy` 会把被切断的字符替换为 U+FFFD（`�`），
//! 造成流式回复乱码，甚至破坏 SSE 数据行的 JSON 结构。
//!
//! 本解码器在 chunk 之间保留末尾不完整的字节序列（最多 3 字节），
//! 与下一个 chunk 拼接后再解码，彻底消除跨 chunk 边界的乱码。
//! 真正非法的字节（非"不完整"而是"无效"）仍替换为 U+FFFD 并继续。

/// 跨 chunk 增量 UTF-8 解码器。
///
/// 用法：
/// ```ignore
/// let mut decoder = Utf8StreamDecoder::new();
/// while let Some(chunk) = stream.next().await {
///     let text = decoder.decode(&chunk?);
///     // ... 处理 text
/// }
/// let tail = decoder.flush(); // 流结束后冲刷残留（若有）
/// ```
#[derive(Debug, Default)]
pub struct Utf8StreamDecoder {
    /// 上一个 chunk 末尾的不完整 UTF-8 序列（长度 0-3，由 UTF-8 编码规则保证）
    pending: Vec<u8>,
}

impl Utf8StreamDecoder {
    pub fn new() -> Self {
        Self {
            pending: Vec::new(),
        }
    }

    /// 解码一个新到达的字节 chunk。
    ///
    /// - 与上次残留的不完整序列拼接后解码；
    /// - 末尾若是被切断的多字节字符，保留到下一次调用；
    /// - 中途遇到真正非法的字节序列替换为 U+FFFD 并继续。
    pub fn decode(&mut self, chunk: &[u8]) -> String {
        // 无残留时直接借用 chunk，避免拷贝
        let owned;
        let bytes: &[u8] = if self.pending.is_empty() {
            chunk
        } else {
            let mut combined = std::mem::take(&mut self.pending);
            combined.extend_from_slice(chunk);
            owned = combined;
            &owned
        };

        let mut out = String::with_capacity(bytes.len());
        let mut pos = 0usize;
        loop {
            match std::str::from_utf8(&bytes[pos..]) {
                Ok(s) => {
                    out.push_str(s);
                    break;
                }
                Err(e) => {
                    let valid = e.valid_up_to();
                    // valid 之前的部分保证是合法 UTF-8
                    out.push_str(std::str::from_utf8(&bytes[pos..pos + valid]).unwrap_or(""));
                    match e.error_len() {
                        Some(invalid_len) => {
                            // 真正非法的字节：替换并跳过，继续解析后续内容
                            out.push('\u{FFFD}');
                            pos += valid + invalid_len;
                        }
                        None => {
                            // 末尾不完整的多字节序列：保留到下一个 chunk
                            self.pending = bytes[pos + valid..].to_vec();
                            break;
                        }
                    }
                }
            }
        }
        out
    }

    /// 流结束后冲刷残留字节。
    ///
    /// 若仍有不完整序列（说明流在字符中间被截断），按 lossy 语义返回 U+FFFD。
    pub fn flush(&mut self) -> String {
        if self.pending.is_empty() {
            String::new()
        } else {
            self.pending.clear();
            "\u{FFFD}".to_string()
        }
    }

    /// 是否有未消费的残留字节
    #[allow(dead_code)]
    pub fn has_pending(&self) -> bool {
        !self.pending.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_ascii_passthrough() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.decode(b"hello"), "hello");
        assert_eq!(d.decode(b" world"), " world");
        assert_eq!(d.flush(), "");
    }

    #[test]
    fn test_chinese_char_split_across_chunks() {
        // "中" = E4 B8 AD，切成 [E4] + [B8 AD]
        let bytes = "中".as_bytes();
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.decode(&bytes[..1]), "");
        assert!(d.has_pending());
        assert_eq!(d.decode(&bytes[1..]), "中");
        assert!(!d.has_pending());
        assert_eq!(d.flush(), "");
    }

    #[test]
    fn test_chinese_text_split_at_every_position() {
        // 对一段中文在每个字节位置切分，验证任意切分点都不产生乱码
        let text = "流式回复中文测试：你好，世界！🌍";
        let bytes = text.as_bytes();
        for split in 1..bytes.len() {
            let mut d = Utf8StreamDecoder::new();
            let mut result = String::new();
            result.push_str(&d.decode(&bytes[..split]));
            result.push_str(&d.decode(&bytes[split..]));
            result.push_str(&d.flush());
            assert_eq!(result, text, "切分点 {} 处解码结果不一致", split);
        }
    }

    #[test]
    fn test_four_byte_emoji_split_three_ways() {
        // "🚀" = F0 9F 9A 80，按 1 字节逐个喂
        let bytes = "🚀".as_bytes();
        let mut d = Utf8StreamDecoder::new();
        let mut result = String::new();
        for b in bytes {
            result.push_str(&d.decode(std::slice::from_ref(b)));
        }
        result.push_str(&d.flush());
        assert_eq!(result, "🚀");
    }

    #[test]
    fn test_sse_line_split_mid_char() {
        // 模拟 SSE 数据行中 JSON 字符串里的中文被切断
        let full = "data: {\"content\":\"数学题\"}\n";
        let bytes = full.as_bytes();
        // 在"学"字（3 字节）中间切
        let idx = full.find('学').unwrap() + 1;
        let mut d = Utf8StreamDecoder::new();
        let mut result = String::new();
        result.push_str(&d.decode(&bytes[..idx]));
        result.push_str(&d.decode(&bytes[idx..]));
        assert_eq!(result, full);
    }

    #[test]
    fn test_truly_invalid_bytes_replaced() {
        // 0xFF 永远不是合法 UTF-8 起始字节
        let mut d = Utf8StreamDecoder::new();
        let out = d.decode(&[b'a', 0xFF, b'b']);
        assert_eq!(out, "a\u{FFFD}b");
        assert!(!d.has_pending());
    }

    #[test]
    fn test_flush_incomplete_tail_becomes_replacement() {
        let mut d = Utf8StreamDecoder::new();
        // 只喂"中"的第一个字节然后结束流
        assert_eq!(d.decode(&"中".as_bytes()[..1]), "");
        assert_eq!(d.flush(), "\u{FFFD}");
        assert!(!d.has_pending());
    }

    #[test]
    fn test_empty_chunk() {
        let mut d = Utf8StreamDecoder::new();
        assert_eq!(d.decode(b""), "");
        // 残留状态下的空 chunk 不应破坏残留
        let _ = d.decode(&"中".as_bytes()[..2]);
        assert_eq!(d.decode(b""), "");
        assert_eq!(d.decode(&"中".as_bytes()[2..]), "中");
    }
}
