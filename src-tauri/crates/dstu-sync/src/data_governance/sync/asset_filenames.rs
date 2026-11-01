//! [R11-names2] 资产云 key 的可逆、跨平台文件名映射。
//!
//! 新 key 采用与 rclone 相同的基本思路：Windows 非法字符映射到全角字符，
//! 控制字符映射到 Control Pictures，并用 `‛` 引用原本就存在的替代字符。
//! 发生映射的段带 `‛er` 标记；非 NFC 输入使用 `‛eh<utf8-hex>`，因此编码结果
//! 始终是 NFC，同时仍能逐字节恢复 NFD 原名。
//!
//! `encode_segment` / `decode_segment` 是新代码应使用的无歧义 API。旧
//! `sanitize_*` 名称仅保留给读取混合代际清单的兼容入口：它识别已经带标记的新
//! key，未带标记的值则按旧云端原名编码。旧版把非法字符替换成 `_` 的 key 本身
//! 无法反推原名；[`legacy_sanitized_asset_key`] 为同步器提供双 key 查找候选，
//! 内容更新时再由同步器把清单迁移到可逆 key，因而旧 key 不会成为孤儿。
//!
//! 所有入口同时限制 UTF-8 字节数和 Windows UTF-16 code unit 数。超限、结构异常
//! 或非规范编码一律返回失败，不截断、不哈希改名，避免不同名字静默碰撞。

use std::fmt;

use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

/// 所有文件名冲突类失败消息的稳定机器标记。
pub const FILENAME_CONFLICT_MARKER: &str = "[filename-conflict]";

/// 可移植文件系统通常允许的单段上限。字节与 UTF-16 两项都必须满足。
pub const MAX_PORTABLE_SEGMENT_UNITS: usize = 255;

/// 包含 `root/top/rel` 的资产 key 上限。
///
/// 240 留出本地应用数据根目录余量，避免默认 Win32 `MAX_PATH` 下明知无法物化
/// 仍把条目写入云端。实际根目录仍可能更长，落盘前的路径结构校验继续 fail-close。
pub const MAX_PORTABLE_ASSET_KEY_UNITS: usize = 240;

const QUOTE: char = '\u{201b}'; // rclone QuoteRune: SINGLE HIGH-REVERSED-9 QUOTATION MARK
const ENCODED_PREFIX: &str = "\u{201b}e";
const RCLONE_MODE: char = 'r';
const HEX_MODE: char = 'h';

const WINDOWS_ILLEGAL_CHARS: [char; 9] = ['\\', '/', ':', '*', '?', '"', '<', '>', '|'];
const WINDOWS_RESERVED_STEMS: [&str; 24] = [
    "CON", "PRN", "AUX", "NUL", "COM0", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7",
    "COM8", "COM9", "LPT0", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilenameCodecError(String);

impl FilenameCodecError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for FilenameCodecError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for FilenameCodecError {}

/// 把一个原始文件名段编码为跨平台安全的云 key 段。
pub fn encode_segment(raw: &str) -> Result<String, FilenameCodecError> {
    validate_decoded_segment_length(raw)?;

    let normalized: String = raw.nfc().collect();
    let requires_hex = normalized != raw
        || raw
            .chars()
            .any(|character| character.is_control() && character as u32 > 0x7f);

    let encoded = if requires_hex {
        format!("{ENCODED_PREFIX}{HEX_MODE}{}", hex::encode(raw.as_bytes()))
    } else {
        let (body, body_changed) = encode_rclone_body(raw);
        if body_changed || is_windows_reserved_name(raw) {
            format!("{ENCODED_PREFIX}{RCLONE_MODE}{body}")
        } else {
            raw.to_string()
        }
    };

    validate_encoded_segment(&encoded)?;
    Ok(encoded)
}

/// 还原 [`encode_segment`] 产生的段；未带版本标记的旧安全名原样返回。
pub fn decode_segment(encoded: &str) -> Result<String, FilenameCodecError> {
    if !encoded.starts_with(ENCODED_PREFIX) {
        validate_decoded_segment_length(encoded)?;
        return Ok(encoded.to_string());
    }

    let tagged = encoded
        .strip_prefix(ENCODED_PREFIX)
        .ok_or_else(|| FilenameCodecError::new("文件名编码标记损坏"))?;
    let mut tagged_chars = tagged.chars();
    let mode = tagged_chars
        .next()
        .ok_or_else(|| FilenameCodecError::new("文件名编码缺少模式"))?;
    let body = tagged_chars.as_str();
    if body.is_empty() {
        return Err(FilenameCodecError::new("文件名编码内容为空"));
    }

    let decoded = match mode {
        RCLONE_MODE => decode_rclone_body(body)?,
        HEX_MODE => {
            if body.len() % 2 != 0
                || !body
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            {
                return Err(FilenameCodecError::new("文件名 UTF-8 十六进制编码非法"));
            }
            let bytes = hex::decode(body)
                .map_err(|_| FilenameCodecError::new("文件名 UTF-8 十六进制编码非法"))?;
            String::from_utf8(bytes)
                .map_err(|_| FilenameCodecError::new("文件名编码还原后不是有效 UTF-8"))?
        }
        _ => return Err(FilenameCodecError::new("未知文件名编码模式")),
    };
    validate_decoded_segment_length(&decoded)?;

    // 拒绝可解码但不是编码器唯一输出的变体，避免同一原名拥有多个云 key。
    if encode_segment(&decoded)? != encoded {
        return Err(FilenameCodecError::new("文件名编码不是规范形式"));
    }
    Ok(decoded)
}

/// 兼容入口：规范的新编码保持不变，未编码的旧原名升级为可逆映射。
///
/// 新建 key 必须调用 [`encode_segment`]；原始文件名若恰好以内部标记开头，只有
/// 显式编码 API 才能无歧义地把它当作用户数据。
pub fn sanitize_segment(raw_or_encoded: &str) -> Option<String> {
    if raw_or_encoded.starts_with(ENCODED_PREFIX) {
        decode_segment(raw_or_encoded).ok()?;
        validate_encoded_segment(raw_or_encoded).ok()?;
        Some(raw_or_encoded.to_string())
    } else {
        encode_segment(raw_or_encoded).ok()
    }
}

/// 编码 `/` 分隔的相对路径。空段、`.`、`..` 与总长超限均失败。
pub fn encode_rel_path(raw_rel: &str) -> Result<String, FilenameCodecError> {
    let segments: Vec<&str> = raw_rel.split('/').collect();
    encode_rel_segments(&segments)
}

/// 解码新 key 的相对路径，主要用于迁移与诊断；段分隔符本身不参与编码。
pub fn decode_rel_path(encoded_rel: &str) -> Result<String, FilenameCodecError> {
    let mut decoded = Vec::new();
    for segment in split_structural_segments(encoded_rel)? {
        decoded.push(decode_segment(segment)?);
    }
    Ok(decoded.join("/"))
}

/// 兼容入口：逐段识别新编码或升级旧原名。
pub fn sanitize_rel_path(raw_or_encoded_rel: &str) -> Option<String> {
    let mut encoded = Vec::new();
    for segment in split_structural_segments(raw_or_encoded_rel).ok()? {
        encoded.push(sanitize_segment(segment)?);
    }
    let rel = encoded.join("/");
    validate_path_units(&rel, MAX_PORTABLE_ASSET_KEY_UNITS, "资产相对路径").ok()?;
    Some(rel)
}

/// 从操作系统路径已经拆出的原始段生成新资产 key。
pub fn encode_asset_key_segments(
    root: &str,
    top: &str,
    raw_segments: &[&str],
) -> Result<String, FilenameCodecError> {
    validate_root_and_top(root, top)?;
    let rel = encode_rel_segments(raw_segments)?;
    assemble_asset_key(root, top, &rel)
}

/// 扫描本地资产目录时使用的幂等入口：下载后已物化的新编码段保持不变，其余段
/// 作为原名编码。这样第二轮扫描不会产生双重编码；显式处理用户原名仍应调用
/// [`encode_asset_key_segments`]。
pub fn sanitize_asset_key_segments(
    root: &str,
    top: &str,
    raw_or_encoded_segments: &[&str],
) -> Result<String, FilenameCodecError> {
    validate_root_and_top(root, top)?;
    if raw_or_encoded_segments.is_empty() {
        return Err(FilenameCodecError::new("资产相对路径为空"));
    }
    let mut encoded = Vec::with_capacity(raw_or_encoded_segments.len());
    for segment in raw_or_encoded_segments {
        if segment.is_empty() || matches!(*segment, "." | "..") {
            return Err(FilenameCodecError::new("资产相对路径包含空段或遍历段"));
        }
        encoded.push(
            sanitize_segment(segment)
                .ok_or_else(|| FilenameCodecError::new("文件名段编码损坏或超长"))?,
        );
    }
    assemble_asset_key(root, top, &encoded.join("/"))
}

/// 读取混合代际清单时，把旧原名 key 或新编码 key 规范到新 key 视图。
pub fn sanitize_asset_key(key: &str) -> Option<String> {
    let (root, top, rel) = split_asset_key(key).ok()?;
    validate_root_and_top(root, top).ok()?;
    let rel = sanitize_rel_path(rel)?;
    assemble_asset_key(root, top, &rel).ok()
}

/// 无损还原完整资产 key 的用户命名段。
pub fn decode_asset_key(key: &str) -> Result<String, FilenameCodecError> {
    let (root, top, rel) = split_asset_key(key)?;
    validate_root_and_top(root, top)?;
    validate_path_units(key, MAX_PORTABLE_ASSET_KEY_UNITS, "资产 key")?;
    Ok(format!("{root}/{top}/{}", decode_rel_path(rel)?))
}

/// 为新可逆 key 计算 R09 `_` 净化算法曾写出的兼容候选。
///
/// 同步器按「新 key exact → 旧 `_` key」双查找；若旧 key 与另一个本地文件的新
/// key exact 相同，则 exact 拥有者优先。内容更新后清单写入新 key 并移除旧别名。
pub fn legacy_sanitized_asset_key(encoded_key: &str) -> Option<String> {
    let (root, top, rel) = split_asset_key(encoded_key).ok()?;
    validate_root_and_top(root, top).ok()?;
    let mut legacy = Vec::new();
    for segment in split_structural_segments(rel).ok()? {
        legacy.push(legacy_sanitize_segment(&decode_segment(segment).ok()?));
    }
    assemble_asset_key(root, top, &legacy.join("/")).ok()
}

/// 大小写不敏感文件系统的占位视图。新编码本身为 NFC。
pub fn casefold_key(key: &str) -> String {
    key.nfc().flat_map(char::to_lowercase).collect()
}

fn encode_rel_segments(raw_segments: &[&str]) -> Result<String, FilenameCodecError> {
    if raw_segments.is_empty() {
        return Err(FilenameCodecError::new("资产相对路径为空"));
    }
    let mut encoded = Vec::with_capacity(raw_segments.len());
    for segment in raw_segments {
        if segment.is_empty() || matches!(*segment, "." | "..") {
            return Err(FilenameCodecError::new("资产相对路径包含空段或遍历段"));
        }
        encoded.push(encode_segment(segment)?);
    }
    let rel = encoded.join("/");
    validate_path_units(&rel, MAX_PORTABLE_ASSET_KEY_UNITS, "资产相对路径")?;
    Ok(rel)
}

fn assemble_asset_key(
    root: &str,
    top: &str,
    encoded_rel: &str,
) -> Result<String, FilenameCodecError> {
    let key = format!("{root}/{top}/{encoded_rel}");
    validate_path_units(&key, MAX_PORTABLE_ASSET_KEY_UNITS, "资产 key")?;
    Ok(key)
}

fn split_asset_key(key: &str) -> Result<(&str, &str, &str), FilenameCodecError> {
    let mut parts = key.splitn(3, '/');
    let root = parts
        .next()
        .ok_or_else(|| FilenameCodecError::new("资产 key 缺少 root"))?;
    let top = parts
        .next()
        .ok_or_else(|| FilenameCodecError::new("资产 key 缺少顶层目录"))?;
    let rel = parts
        .next()
        .ok_or_else(|| FilenameCodecError::new("资产 key 缺少相对路径"))?;
    if root.is_empty() || top.is_empty() || rel.is_empty() {
        return Err(FilenameCodecError::new("资产 key 含空结构段"));
    }
    Ok((root, top, rel))
}

fn split_structural_segments(path: &str) -> Result<Vec<&str>, FilenameCodecError> {
    let segments: Vec<&str> = path.split('/').collect();
    if segments.is_empty()
        || segments
            .iter()
            .any(|segment| segment.is_empty() || matches!(*segment, "." | ".."))
    {
        return Err(FilenameCodecError::new("路径包含空段或遍历段"));
    }
    Ok(segments)
}

fn validate_root_and_top(root: &str, top: &str) -> Result<(), FilenameCodecError> {
    if !matches!(root, "active" | "app_data")
        || top.is_empty()
        || matches!(top, "." | "..")
        || top.contains('/')
        || top.contains('\\')
        || top.chars().any(char::is_control)
    {
        return Err(FilenameCodecError::new("资产 root 或顶层目录非法"));
    }
    validate_path_units(top, MAX_PORTABLE_SEGMENT_UNITS, "资产顶层目录")
}

fn validate_decoded_segment_length(raw: &str) -> Result<(), FilenameCodecError> {
    if raw.is_empty() {
        return Err(FilenameCodecError::new("文件名段为空"));
    }
    validate_path_units(raw, MAX_PORTABLE_SEGMENT_UNITS, "原始文件名段")
}

fn validate_encoded_segment(encoded: &str) -> Result<(), FilenameCodecError> {
    validate_path_units(encoded, MAX_PORTABLE_SEGMENT_UNITS, "编码后文件名段")?;
    if encoded.is_empty()
        || matches!(encoded, "." | "..")
        || encoded.ends_with('.')
        || encoded.ends_with(' ')
        || encoded
            .chars()
            .any(|character| WINDOWS_ILLEGAL_CHARS.contains(&character) || character.is_control())
        || is_windows_reserved_name(encoded)
    {
        return Err(FilenameCodecError::new(
            "编码后文件名仍不满足跨平台安全约束",
        ));
    }
    Ok(())
}

fn validate_path_units(value: &str, limit: usize, label: &str) -> Result<(), FilenameCodecError> {
    let utf8_bytes = value.len();
    let utf16_units = value.encode_utf16().count();
    if utf8_bytes > limit || utf16_units > limit {
        return Err(FilenameCodecError::new(format!(
            "{label}超长（UTF-8 {utf8_bytes} 字节，UTF-16 {utf16_units} 单元，上限 {limit}）"
        )));
    }
    Ok(())
}

fn encode_rclone_body(raw: &str) -> (String, bool) {
    let characters: Vec<char> = raw.chars().collect();
    let trailing_start = characters
        .iter()
        .rposition(|character| !matches!(character, '.' | ' '))
        .map_or(0, |index| index + 1);
    let mut output = String::new();
    let mut changed = false;

    for (index, character) in characters.into_iter().enumerate() {
        let replacement = if index >= trailing_start {
            match character {
                '.' => Some('\u{ff0e}'), // FULLWIDTH FULL STOP
                ' ' => Some('\u{2420}'), // SYMBOL FOR SPACE
                _ => replacement_for_unsafe(character),
            }
        } else {
            replacement_for_unsafe(character)
        };
        if let Some(replacement) = replacement {
            output.push(replacement);
            changed = true;
        } else if character == QUOTE || decoded_replacement(character).is_some() {
            output.push(QUOTE);
            output.push(character);
            changed = true;
        } else {
            output.push(character);
        }
    }
    (output, changed)
}

fn decode_rclone_body(body: &str) -> Result<String, FilenameCodecError> {
    let mut output = String::new();
    let mut quoted = false;
    for character in body.chars() {
        if quoted {
            output.push(character);
            quoted = false;
        } else if character == QUOTE {
            quoted = true;
        } else if let Some(decoded) = decoded_replacement(character) {
            output.push(decoded);
        } else {
            output.push(character);
        }
    }
    if quoted {
        return Err(FilenameCodecError::new("文件名引用符缺少后续字符"));
    }
    Ok(output)
}

fn replacement_for_unsafe(character: char) -> Option<char> {
    match character {
        '"' | '*' | ':' | '<' | '>' | '?' | '\\' | '|' | '/' => {
            char::from_u32(character as u32 + 0xfee0)
        }
        '\0'..='\u{1f}' => char::from_u32(0x2400 + character as u32),
        '\u{7f}' => Some('\u{2421}'),
        _ => None,
    }
}

fn decoded_replacement(character: char) -> Option<char> {
    match character {
        '\u{ff02}' | '\u{ff0a}' | '\u{ff1a}' | '\u{ff1c}' | '\u{ff1e}' | '\u{ff1f}'
        | '\u{ff3c}' | '\u{ff5c}' | '\u{ff0f}' => char::from_u32(character as u32 - 0xfee0),
        '\u{2400}'..='\u{241f}' => char::from_u32(character as u32 - 0x2400),
        '\u{2420}' => Some(' '),
        '\u{2421}' => Some('\u{7f}'),
        '\u{ff0e}' => Some('.'),
        _ => None,
    }
}

fn is_windows_reserved_name(name: &str) -> bool {
    let trimmed = name.trim_end_matches(|character| character == ' ' || character == '.');
    let stem = trimmed
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end_matches(' ');
    WINDOWS_RESERVED_STEMS
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(stem))
}

fn legacy_sanitize_segment(raw: &str) -> String {
    let normalized: String = raw.nfc().collect();
    let mut cleaned: String = normalized
        .chars()
        .map(|character| {
            if WINDOWS_ILLEGAL_CHARS.contains(&character) || character.is_control() {
                '_'
            } else {
                character
            }
        })
        .collect();
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    if cleaned.is_empty() {
        let digest = Sha256::digest(raw.as_bytes());
        return format!("unnamed-{}", hex::encode(&digest[..4]));
    }
    let stem_end = cleaned.find('.').unwrap_or(cleaned.len());
    let stem = cleaned[..stem_end].trim_end_matches(' ');
    if WINDOWS_RESERVED_STEMS
        .iter()
        .any(|reserved| reserved.eq_ignore_ascii_case(stem))
    {
        cleaned.insert(stem_end, '_');
    }
    cleaned
}

// ============================================================================
// 冲突文案
// ============================================================================

pub fn local_duplicate_message(key: &str, kept: &str, skipped: &str) -> String {
    format!(
        "{FILENAME_CONFLICT_MARKER} {key}: 本地文件 {skipped} 与 {kept} 映射到同一云端名称，\
         本次仅同步 {kept}；请重命名其中一个文件后重新同步"
    )
}

pub fn local_case_conflict_message(skipped_key: &str, kept_key: &str) -> String {
    format!(
        "{FILENAME_CONFLICT_MARKER} {skipped_key}: 与本地 {kept_key} 仅文件名大小写不同，\
         在不区分大小写的系统（Windows/macOS 默认）上会互相覆盖，已跳过上传；\
         请重命名其中一个文件后重新同步"
    )
}

pub fn upload_case_conflict_message(local_key: &str, cloud_key: &str) -> String {
    format!(
        "{FILENAME_CONFLICT_MARKER} {local_key}: 与云端 {cloud_key} 仅文件名大小写不同，\
         在不区分大小写的系统（Windows/macOS 默认）上会互相覆盖，已跳过上传；\
         请重命名本地文件后重新同步"
    )
}

pub fn download_case_conflict_message(cloud_key: &str, occupied_by: &str) -> String {
    format!(
        "{FILENAME_CONFLICT_MARKER} {cloud_key}: 与 {occupied_by} 仅文件名大小写不同，\
         为避免在不区分大小写的系统上互相覆盖已跳过下载；\
         请在源设备重命名该文件后重新同步"
    )
}

pub fn shadowed_divergent_message(skipped_key: &str, kept_key: &str) -> String {
    format!(
        "{FILENAME_CONFLICT_MARKER} {skipped_key}: 与 {kept_key} 映射到同一本地名称但内容不同，\
         本地按 {kept_key} 物化；请在源设备重命名后重新同步"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_roundtrip(raw: &str) -> String {
        let encoded = encode_segment(raw).expect("测试名应可编码");
        assert_eq!(decode_segment(&encoded).unwrap(), raw);
        assert_eq!(
            sanitize_segment(&encoded).as_deref(),
            Some(encoded.as_str())
        );
        encoded
    }

    #[test]
    fn rclone_style_unsafe_characters_roundtrip_without_collisions() {
        let encoded = assert_roundtrip("a:b?c*d\"e<f>g|h\\i\t.txt");
        assert!(encoded.starts_with("\u{201b}er"));
        for illegal in WINDOWS_ILLEGAL_CHARS {
            assert!(!encoded.contains(illegal));
        }
        assert!(!encoded.chars().any(char::is_control));

        let literal = assert_roundtrip("a：b？c＊d＂e＜f＞g｜h＼i␉.txt");
        assert_ne!(encoded, literal, "替代字符原文必须引用，不能与非法字符碰撞");
    }

    #[test]
    fn reserved_trailing_and_dot_names_are_safe_and_reversible() {
        for raw in [
            "CON", "con.txt", "COM1.pdf", "LPT9", "report.", "draft ", ".", "..",
        ] {
            let encoded = assert_roundtrip(raw);
            validate_encoded_segment(&encoded).unwrap();
            assert_ne!(encoded, raw);
        }
        assert_eq!(encode_segment("console.log").unwrap(), "console.log");
    }

    #[test]
    fn nfc_and_nfd_remain_distinct_nfc_safe_keys_and_roundtrip() {
        let nfc = "caf\u{e9}.png";
        let nfd = "cafe\u{301}.png";
        let encoded_nfc = assert_roundtrip(nfc);
        let encoded_nfd = assert_roundtrip(nfd);
        assert_ne!(encoded_nfc, encoded_nfd);
        assert_eq!(encoded_nfc.nfc().collect::<String>(), encoded_nfc);
        assert_eq!(encoded_nfd.nfc().collect::<String>(), encoded_nfd);
        assert!(encoded_nfd.starts_with("\u{201b}eh"));
    }

    #[test]
    fn marker_and_quote_in_user_name_are_data_not_protocol() {
        for raw in ["\u{201b}erCON", "\u{201b}eh616263", "literal\u{201b}quote"] {
            assert_roundtrip(raw);
        }
    }

    #[test]
    fn malformed_or_noncanonical_encodings_fail_closed() {
        for encoded in [
            "\u{201b}e",
            "\u{201b}exabc",
            "\u{201b}eh0",
            "\u{201b}ehzz",
            "\u{201b}erabc\u{201b}",
            "\u{201b}erplain",
        ] {
            assert!(decode_segment(encoded).is_err(), "{encoded:?} 必须拒绝");
            assert_eq!(sanitize_segment(encoded), None);
        }
    }

    #[test]
    fn segment_and_total_path_limits_fail_closed_without_truncation() {
        assert!(encode_segment(&"a".repeat(MAX_PORTABLE_SEGMENT_UNITS)).is_ok());
        assert!(encode_segment(&"a".repeat(MAX_PORTABLE_SEGMENT_UNITS + 1)).is_err());
        assert!(encode_segment(&format!("{}:", "a".repeat(250))).is_err());

        let long_rel = ["a".repeat(120), "b".repeat(120)];
        assert!(encode_asset_key_segments(
            "active",
            "images",
            &[long_rel[0].as_str(), long_rel[1].as_str()]
        )
        .is_err());
        assert_eq!(
            sanitize_asset_key(&format!("active/images/{}", "a".repeat(300))),
            None
        );
    }

    #[test]
    fn paths_roundtrip_and_traversal_fails_closed() {
        let key = encode_asset_key_segments(
            "active",
            "images",
            &["sub:dir", "CON.txt", "cafe\u{301}.png"],
        )
        .unwrap();
        assert_eq!(
            decode_asset_key(&key).unwrap(),
            "active/images/sub:dir/CON.txt/cafe\u{301}.png"
        );
        assert_eq!(sanitize_asset_key(&key).as_deref(), Some(key.as_str()));
        for invalid in [
            "active/images",
            "active//x",
            "active/images/../x",
            "active/images//x",
            "evil/images/x",
        ] {
            assert_eq!(sanitize_asset_key(invalid), None, "{invalid:?}");
        }
    }

    #[test]
    fn legacy_lossy_alias_is_available_beside_new_key() {
        let key = encode_asset_key_segments("active", "images", &["pic:1?.png"]).expect("可编码");
        assert_ne!(key, "active/images/pic_1_.png");
        assert_eq!(
            legacy_sanitized_asset_key(&key).as_deref(),
            Some("active/images/pic_1_.png")
        );
        assert_eq!(
            legacy_sanitized_asset_key("active/images/plain_name.png").as_deref(),
            Some("active/images/plain_name.png")
        );
    }

    #[test]
    fn casefold_keeps_case_conflicts_but_not_nfc_nfd_collision() {
        assert_eq!(
            casefold_key("active/images/Logo.png"),
            casefold_key("active/images/logo.png")
        );
        let nfc = encode_asset_key_segments("active", "images", &["caf\u{e9}.png"]).unwrap();
        let nfd = encode_asset_key_segments("active", "images", &["cafe\u{301}.png"]).unwrap();
        assert_ne!(casefold_key(&nfc), casefold_key(&nfd));
    }

    #[test]
    fn conflict_messages_carry_stable_marker() {
        for message in [
            local_duplicate_message("k", "a", "b"),
            local_case_conflict_message("a", "b"),
            upload_case_conflict_message("a", "b"),
            download_case_conflict_message("a", "b"),
            shadowed_divergent_message("a", "b"),
        ] {
            assert!(message.starts_with(FILENAME_CONFLICT_MARKER));
        }
    }
}
