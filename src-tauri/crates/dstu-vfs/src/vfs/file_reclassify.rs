//! A3: 既有文件条目的受控内容重识别。
//!
//! 只读取 blob 的有界头部用于格式检测，再流式校验整个文件 SHA-256。
//! inline 路径由调用方提供受控的有界字节，复用同一检测与结构校验。
//! 不把文件整体读入内存，也不在 SQLite 写事务内做 PDF 渲染/重量解析。

use std::fs::File;
use std::io::{ErrorKind, Read, Seek, SeekFrom};
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::vfs::error::{VfsError, VfsResult};

/// 检测用的有界头部大小（与导入检测保持一致）。
pub const RECLASSIFY_HEADER_BYTES: u64 = 64 * 1024;

/// 重识别结果状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum FileReclassifyStatus {
    /// 已从受控内容中识别出可靠格式。
    Recognized,
    /// 内容存在且 hash 一致，但格式仍未知。
    Unknown,
    /// 文件记录或 blob 内容缺失。
    Missing,
    /// blob 内容读取失败或与记录的 SHA-256 不一致。
    Corrupt,
}

impl FileReclassifyStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Recognized => "recognized",
            Self::Unknown => "unknown",
            Self::Missing => "missing",
            Self::Corrupt => "corrupt",
        }
    }
}

/// 可靠识别出的 MIME 与文件类别。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DetectedFileIdentity {
    pub extension: String,
    pub mime_type: String,
    pub file_type: String,
}

/// 从有界头部检测可靠格式；未知/畸形返回 `None`，不猜测。
pub fn detect_file_identity(header: &[u8]) -> Option<DetectedFileIdentity> {
    let extension = dstu_storage::unified_file_manager::detect_import_extension(header)?;
    let mime_type = dstu_storage::unified_file_manager::import_mime_type(Some(&extension));
    if mime_type == "application/octet-stream" || !mime_type.contains('/') {
        return None;
    }
    Some(DetectedFileIdentity {
        extension,
        mime_type: mime_type.to_string(),
        file_type: file_type_for_mime(mime_type).to_string(),
    })
}

fn file_type_for_mime(mime_type: &str) -> &'static str {
    if mime_type.starts_with("image/") {
        "image"
    } else if mime_type.starts_with("audio/") {
        "audio"
    } else if mime_type.starts_with("video/") {
        "video"
    } else {
        "document"
    }
}

/// MIME essence：去参数、trim、小写；空输入返回空串。
pub fn mime_essence(mime: Option<&str>) -> String {
    mime.unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

/// 通用占位 MIME（缺失、空、octet-stream）。
pub fn mime_is_generic(mime: Option<&str>) -> bool {
    let essence = mime_essence(mime);
    essence.is_empty() || essence == "application/octet-stream" || essence == "binary/octet-stream"
}

/// 只有魔数/容器类强格式才允许覆盖具体的声明 MIME；文本/XML/JSON 等弱
/// 启发式不得把 SVG、代码或其他具体类型降级。
pub fn detected_extension_is_strong(extension: &str) -> bool {
    matches!(
        extension,
        "pdf"
            | "docx"
            | "xlsx"
            | "pptx"
            | "epub"
            | "ods"
            | "rtf"
            | "png"
            | "jpg"
            | "gif"
            | "webp"
            | "bmp"
            | "heic"
            | "heif"
    )
}

/// 共享的最终身份解析结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedFileIdentity {
    pub mime_type: String,
    pub file_type: String,
    pub extension: Option<String>,
    /// 强魔数/容器检测被采用。
    pub strong: bool,
    /// 任一内容检测（强或弱）被采用。
    pub from_content: bool,
}

fn extension_from_name(file_name: &str) -> Option<String> {
    let name = file_name.trim();
    let index = name.rfind('.')?;
    if index == 0 || index + 1 >= name.len() {
        return None;
    }
    let extension = name[index + 1..].to_ascii_lowercase();
    if !extension.is_empty() && extension.chars().all(|ch| ch.is_ascii_alphanumeric()) {
        Some(extension)
    } else {
        None
    }
}

fn identity_from_extension(extension: &str) -> Option<DetectedFileIdentity> {
    let mime_type = dstu_storage::unified_file_manager::import_mime_type(Some(extension));
    if mime_type == "application/octet-stream" || !mime_type.contains('/') {
        return None;
    }
    Some(DetectedFileIdentity {
        extension: extension.to_string(),
        mime_type: mime_type.to_string(),
        file_type: file_type_for_mime(mime_type).to_string(),
    })
}

/// 统一的 MIME/category 纠正规则，供导入、重识别、附件升级共用。
///
/// - 强内容检测优先，可纠正具体 MIME/category；
/// - 弱文本/XML 不得覆盖具体声明 MIME（如 image/svg+xml、代码）；
/// - 声明为 generic 时可按名称映射具体类型（如 .svg），否则弱检测可兜底；
/// - .dsink / INK_MIME 保持 Ink authority，内容不得改写。
pub fn resolve_file_identity(
    declared_mime: Option<&str>,
    declared_file_type: &str,
    file_name: &str,
    detected: Option<&DetectedFileIdentity>,
) -> ResolvedFileIdentity {
    let declared_essence = mime_essence(declared_mime);
    let name_extension = extension_from_name(file_name);
    let ink_authority = declared_essence.eq_ignore_ascii_case(crate::vfs::ink::INK_MIME)
        || name_extension
            .as_deref()
            .is_some_and(|extension| extension == crate::vfs::ink::INK_EXTENSION);
    if ink_authority {
        let mime_type = if declared_essence.is_empty() {
            "application/octet-stream".to_string()
        } else {
            declared_essence
        };
        let file_type = if declared_file_type.is_empty() {
            file_type_for_mime(&mime_type).to_string()
        } else {
            declared_file_type.to_string()
        };
        return ResolvedFileIdentity {
            mime_type,
            file_type,
            extension: name_extension,
            strong: false,
            from_content: false,
        };
    }

    if let Some(identity) =
        detected.filter(|identity| detected_extension_is_strong(&identity.extension))
    {
        return ResolvedFileIdentity {
            mime_type: identity.mime_type.clone(),
            file_type: identity.file_type.clone(),
            extension: Some(identity.extension.clone()),
            strong: true,
            from_content: true,
        };
    }

    if !mime_is_generic(Some(&declared_essence)) {
        return ResolvedFileIdentity {
            file_type: file_type_for_mime(&declared_essence).to_string(),
            extension: name_extension,
            mime_type: declared_essence,
            strong: false,
            from_content: false,
        };
    }

    if let Some(extension) = name_extension.as_deref() {
        if let Some(identity) = identity_from_extension(extension) {
            return ResolvedFileIdentity {
                mime_type: identity.mime_type,
                file_type: identity.file_type,
                extension: Some(identity.extension),
                strong: false,
                from_content: false,
            };
        }
    }

    if let Some(identity) = detected {
        return ResolvedFileIdentity {
            mime_type: identity.mime_type.clone(),
            file_type: identity.file_type.clone(),
            extension: Some(identity.extension.clone()),
            strong: false,
            from_content: true,
        };
    }

    let mime_type = if declared_essence.is_empty() {
        "application/octet-stream".to_string()
    } else {
        declared_essence
    };
    let file_type = if declared_file_type.is_empty() {
        "file".to_string()
    } else {
        declared_file_type.to_string()
    };
    ResolvedFileIdentity {
        mime_type,
        file_type,
        extension: name_extension,
        strong: false,
        from_content: false,
    }
}

/// 读取文件头部（最多 `RECLASSIFY_HEADER_BYTES`）。
///
/// 返回 `Ok(None)` 表示文件不存在。
pub fn read_bounded_header(path: &Path) -> VfsResult<Option<Vec<u8>>> {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(VfsError::Io(format!(
                "Failed to open blob for reclassify {}: {}",
                path.display(),
                e
            )))
        }
    };

    let mut header = Vec::with_capacity(RECLASSIFY_HEADER_BYTES as usize);
    file.take(RECLASSIFY_HEADER_BYTES)
        .read_to_end(&mut header)
        .map_err(|e| {
            VfsError::Io(format!(
                "Failed to read blob header for reclassify {}: {}",
                path.display(),
                e
            ))
        })?;
    Ok(Some(header))
}

/// 读取文件尾部（最多 `bytes`）。
pub fn read_bounded_tail(path: &Path, bytes: u64) -> VfsResult<Option<Vec<u8>>> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => {
            return Err(VfsError::Io(format!(
                "Failed to open blob tail for reclassify {}: {}",
                path.display(),
                e
            )))
        }
    };
    let len = file
        .metadata()
        .map_err(|e| {
            VfsError::Io(format!(
                "Failed to stat blob for reclassify {}: {}",
                path.display(),
                e
            ))
        })?
        .len();
    let offset = len.saturating_sub(bytes);
    file.seek(SeekFrom::Start(offset)).map_err(|e| {
        VfsError::Io(format!(
            "Failed to seek blob for reclassify {}: {}",
            path.display(),
            e
        ))
    })?;
    let mut tail = Vec::with_capacity((len - offset) as usize);
    file.take(len - offset)
        .read_to_end(&mut tail)
        .map_err(|e| {
            VfsError::Io(format!(
                "Failed to read blob tail for reclassify {}: {}",
                path.display(),
                e
            ))
        })?;
    Ok(Some(tail))
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

/// PNG 签名与关键 chunk 类型。
const PNG_SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
const PNG_IHDR: [u8; 4] = [b'I', b'H', b'D', b'R'];
const PNG_IDAT: [u8; 4] = [b'I', b'D', b'A', b'T'];
const PNG_IEND: [u8; 4] = [b'I', b'E', b'N', b'D'];
/// 结构筛查的显式预算：最多 65536 个 chunk，单个 chunk 长度 <= 2^31-1。
const PNG_MAX_CHUNKS: usize = 65_536;
const PNG_MAX_CHUNK_BYTES: u64 = i32::MAX as u64;

fn read_exact_png<R: Read>(reader: &mut R, buf: &mut [u8]) -> VfsResult<bool> {
    match reader.read_exact(buf) {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => Ok(false),
        Err(e) => Err(VfsError::Io(format!("Failed to read PNG structure: {}", e))),
    }
}

fn is_valid_png_ihdr(ihdr: &[u8; 13]) -> bool {
    let width = u32::from_be_bytes([ihdr[0], ihdr[1], ihdr[2], ihdr[3]]);
    let height = u32::from_be_bytes([ihdr[4], ihdr[5], ihdr[6], ihdr[7]]);
    if width == 0 || height == 0 || width > i32::MAX as u32 || height > i32::MAX as u32 {
        return false;
    }
    let bit_depth = ihdr[8];
    let color_type = ihdr[9];
    let color_depth_ok = match color_type {
        0 => matches!(bit_depth, 1 | 2 | 4 | 8 | 16),
        2 => matches!(bit_depth, 8 | 16),
        3 => matches!(bit_depth, 1 | 2 | 4 | 8),
        4 => matches!(bit_depth, 8 | 16),
        6 => matches!(bit_depth, 8 | 16),
        _ => false,
    };
    color_depth_ok
        && ihdr[10] == 0 // compression method
        && ihdr[11] == 0 // filter method
        && ihdr[12] <= 1 // interlace: none / Adam7
}

/// 有界流式 PNG 结构筛查：只遍历 chunk header 并 seek 跳过 payload，
/// 不读取/分配整图。要求 IHDR 首块且字段合法、至少一个 IDAT、
/// IEND 为 12 字节 terminal chunk（之后不得有数据）。
fn validate_png_chunks<R: Read + Seek>(reader: &mut R, total_len: u64) -> VfsResult<bool> {
    if total_len < 33 {
        return Ok(false);
    }
    let mut signature = [0u8; 8];
    if !read_exact_png(reader, &mut signature)? || signature != PNG_SIGNATURE {
        return Ok(false);
    }

    let mut offset = 8u64;
    let mut chunk_count = 0usize;
    let mut seen_ihdr = false;
    let mut seen_idat = false;
    let mut seen_iend = false;

    while offset < total_len {
        chunk_count += 1;
        if chunk_count > PNG_MAX_CHUNKS {
            return Ok(false);
        }
        if total_len - offset < 12 {
            return Ok(false);
        }
        let mut header = [0u8; 8];
        if !read_exact_png(reader, &mut header)? {
            return Ok(false);
        }
        let length = u32::from_be_bytes([header[0], header[1], header[2], header[3]]) as u64;
        if length > PNG_MAX_CHUNK_BYTES {
            return Ok(false);
        }
        let chunk_type = &header[4..8];
        let Some(chunk_total) = length.checked_add(12) else {
            return Ok(false);
        };
        if total_len - offset < chunk_total {
            return Ok(false);
        }

        if !seen_ihdr {
            if chunk_type != &PNG_IHDR[..] || length != 13 {
                return Ok(false);
            }
            let mut ihdr = [0u8; 13];
            if !read_exact_png(reader, &mut ihdr)? {
                return Ok(false);
            }
            if !is_valid_png_ihdr(&ihdr) {
                return Ok(false);
            }
            reader
                .seek(SeekFrom::Current(4))
                .map_err(|e| VfsError::Io(format!("Failed to skip PNG CRC: {}", e)))?;
            seen_ihdr = true;
        } else {
            if chunk_type == &PNG_IHDR[..] {
                return Ok(false);
            }
            if chunk_type == &PNG_IDAT[..] && length > 0 {
                seen_idat = true;
            }
            if chunk_type == &PNG_IEND[..] {
                if length != 0 || offset + chunk_total != total_len {
                    return Ok(false);
                }
                reader
                    .seek(SeekFrom::Current(4))
                    .map_err(|e| VfsError::Io(format!("Failed to skip PNG IEND CRC: {}", e)))?;
                seen_iend = true;
                offset += chunk_total;
                break;
            }
            reader
                .seek(SeekFrom::Current((length + 4) as i64))
                .map_err(|e| VfsError::Io(format!("Failed to skip PNG payload: {}", e)))?;
        }
        offset += chunk_total;
    }

    Ok(seen_ihdr && seen_idat && seen_iend)
}

/// 对文件路径做有界 PNG chunk 结构校验（不读整图）。
pub fn validate_png_structure(path: &Path) -> VfsResult<bool> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(VfsError::Io(format!(
                "Failed to open PNG for structure check {}: {}",
                path.display(),
                e
            )))
        }
    };
    let total_len = file
        .metadata()
        .map_err(|e| {
            VfsError::Io(format!(
                "Failed to stat PNG for structure check {}: {}",
                path.display(),
                e
            ))
        })?
        .len();
    validate_png_chunks(&mut file, total_len)
}

/// 对内存字节做与路径版完全一致的 PNG chunk 结构校验。
pub fn validate_png_structure_bytes(bytes: &[u8]) -> VfsResult<bool> {
    let mut cursor = std::io::Cursor::new(bytes);
    validate_png_chunks(&mut cursor, bytes.len() as u64)
}

/// 结构校验需要读取的尾部字节数；`0` 表示该格式不需要尾部校验。
pub fn structure_tail_bytes(extension: &str) -> usize {
    match extension.to_ascii_lowercase().as_str() {
        "pdf" | "docx" | "xlsx" | "pptx" | "epub" | "ods" | "zip" => 8 * 1024,
        "jpg" | "jpeg" => 64,
        _ => 0,
    }
}

/// 对已取出的头部/尾部字节做结构收尾校验，供 blob 与 inline 路径共享。
///
/// PNG 需要完整 chunk 表，不能只靠 header/tail 判断；调用方必须改用
/// `validate_png_structure_bytes` / `validate_png_structure`。
pub fn validate_detected_structure_bytes(extension: &str, header: &[u8], tail: &[u8]) -> bool {
    let ext = extension.to_ascii_lowercase();
    match ext.as_str() {
        "pdf" => header.starts_with(b"%PDF-") && contains_bytes(tail, b"%%EOF"),
        "docx" | "xlsx" | "pptx" | "epub" | "ods" | "zip" => {
            header.starts_with(b"PK\x03\x04")
                && (contains_bytes(tail, b"PK\x05\x06")
                    || contains_bytes(tail, b"PK\x06\x06")
                    || contains_bytes(tail, b"PK\x06\x07"))
        }
        // fail-closed：没有完整字节时不能弱判 PNG。
        "png" => false,
        "jpg" | "jpeg" => {
            let trimmed_len = tail
                .iter()
                .rposition(|b| !b.is_ascii_whitespace())
                .map(|idx| idx + 1)
                .unwrap_or(0);
            header.starts_with(&[0xFF, 0xD8, 0xFF])
                && trimmed_len >= 2
                && tail[trimmed_len - 2..trimmed_len] == [0xFF, 0xD9]
        }
        _ => true,
    }
}

/// 在头部检测之后做有界的结构收尾校验（不是完整格式解析）。
///
/// 只读取校验所需的尾部字节；PNG 走完整 chunk 表遍历；未知格式不触发
/// 任何额外 IO。
pub fn validate_detected_structure(path: &Path, extension: &str, header: &[u8]) -> VfsResult<bool> {
    if extension.eq_ignore_ascii_case("png") {
        return validate_png_structure(path);
    }
    let tail_bytes = structure_tail_bytes(extension);
    if tail_bytes == 0 {
        return Ok(true);
    }
    let Some(tail) = read_bounded_tail(path, tail_bytes as u64)? else {
        return Ok(false);
    };
    Ok(validate_detected_structure_bytes(extension, header, &tail))
}

/// files.sha256 是否与 blob 指针一致。
///
/// 副本使用 `{blob_hash}_copy_{nanoid}` 的伪 SHA；非 64 位十六进制历史值
/// 无法校验，不因此误判为损坏。
pub fn sha256_matches_blob_pointer(file_sha256: &str, blob_hash: &str) -> bool {
    if file_sha256.eq_ignore_ascii_case(blob_hash) {
        return true;
    }
    if file_sha256.starts_with(&format!("{blob_hash}_copy_")) {
        return true;
    }
    let is_hex_sha256 =
        file_sha256.len() == 64 && file_sha256.bytes().all(|byte| byte.is_ascii_hexdigit());
    !is_hex_sha256
}

/// 流式校验文件内容 SHA-256，不整文件读入内存。
pub fn verify_file_sha256(path: &Path, expected_sha256: &str) -> VfsResult<bool> {
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(false),
        Err(e) => {
            return Err(VfsError::Io(format!(
                "Failed to open blob for hash verification {}: {}",
                path.display(),
                e
            )))
        }
    };

    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|e| {
            VfsError::Io(format!(
                "Failed to read blob for hash verification {}: {}",
                path.display(),
                e
            ))
        })?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }

    let actual = hex::encode(hasher.finalize());
    Ok(actual.eq_ignore_ascii_case(expected_sha256))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 纯结构性的合法零长 ancillary chunk 类型：ancillary/private/reserved/safe
    /// 位正确；内容为空，CRC 覆盖类型字节。
    const EMPTY_ANCILLARY_TYPE: [u8; 4] = [b'z', b'z', b'Z', b'z'];
    /// 显式 chunk 预算探测值：超过 65536。
    const OVER_BUDGET_CHUNKS: usize = 65_537;

    fn test_crc32(bytes: &[u8]) -> u32 {
        let mut crc = 0xFFFF_FFFFu32;
        for &byte in bytes {
            crc ^= byte as u32;
            for _ in 0..8 {
                let mask = (crc & 1).wrapping_neg();
                crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
            }
        }
        !crc
    }

    /// 真实可解码 1x1 PNG（IHDR/IDAT/IEND 及 CRC 由 encoder 生成）。
    fn encode_real_png() -> Vec<u8> {
        use image::{ColorType, ImageEncoder};

        let mut bytes = Vec::new();
        image::codecs::png::PngEncoder::new(&mut bytes)
            .write_image(&[12, 34, 56, 255], 1, 1, ColorType::Rgba8)
            .expect("encode real PNG fixture");
        bytes
    }

    fn png_with_empty_ancillary_chunks(count: usize) -> Vec<u8> {
        let base = encode_real_png();
        assert_eq!(
            &base[..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..]
        );
        assert_eq!(&base[12..16], &b"IHDR"[..]);
        let ihdr_len = u32::from_be_bytes([base[8], base[9], base[10], base[11]]) as usize;
        assert_eq!(ihdr_len, 13);
        let ihdr_end = 8 + 12 + ihdr_len;

        let chunk_crc = test_crc32(&EMPTY_ANCILLARY_TYPE);
        let mut out = base[..ihdr_end].to_vec();
        for _ in 0..count {
            out.extend_from_slice(&0u32.to_be_bytes());
            out.extend_from_slice(&EMPTY_ANCILLARY_TYPE[..]);
            out.extend_from_slice(&chunk_crc.to_be_bytes());
        }
        out.extend_from_slice(&base[ihdr_end..]);
        out
    }

    /// 结构 fixture：IHDR 尺寸改为指定值并重算 IHDR CRC；后续 IDAT/IEND 来自
    /// 真实 1x1 PNG。只用于结构筛查，像素数据与声明尺寸不一致，不声称可解码。
    fn png_with_ihdr_dimensions(width: u32, height: u32) -> Vec<u8> {
        let base = encode_real_png();
        assert_eq!(
            &base[..8],
            &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A][..]
        );
        let mut ihdr = [0u8; 13];
        ihdr[0..4].copy_from_slice(&width.to_be_bytes());
        ihdr[4..8].copy_from_slice(&height.to_be_bytes());
        ihdr[8] = 8; // bit depth
        ihdr[9] = 6; // RGBA
        ihdr[10] = 0; // compression
        ihdr[11] = 0; // filter
        ihdr[12] = 0; // interlace

        let mut crc_input = Vec::with_capacity(4 + ihdr.len());
        crc_input.extend_from_slice(&b"IHDR"[..]);
        crc_input.extend_from_slice(&ihdr);

        let mut out = base[..8].to_vec();
        out.extend_from_slice(&13u32.to_be_bytes());
        out.extend_from_slice(&b"IHDR"[..]);
        out.extend_from_slice(&ihdr);
        out.extend_from_slice(&test_crc32(&crc_input).to_be_bytes());
        out.extend_from_slice(&base[33..]);
        out
    }

    #[test]
    fn png_structure_rejects_chunk_count_over_budget() {
        let png = png_with_empty_ancillary_chunks(OVER_BUDGET_CHUNKS);
        assert!(png.len() > 64 * 1024);
        assert!(
            !validate_png_structure_bytes(&png).unwrap(),
            "PNG with more than the explicit chunk budget must be rejected"
        );
    }

    #[test]
    fn png_structure_rejects_ihdr_dimensions_above_i32_max() {
        let png = png_with_ihdr_dimensions(i32::MAX as u32 + 1, 1);
        assert!(
            !validate_png_structure_bytes(&png).unwrap(),
            "IHDR width above i32::MAX must be rejected by the structural limit"
        );
    }
}
