use base64::{engine::general_purpose, Engine};
use calamine::{open_workbook_auto, open_workbook_auto_from_rs, Data, Reader, Sheets};
use html2text::from_read;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Cursor;
use std::path::Path;

// PPTX 解析
use pptx_to_md::{ParserConfig, PptxContainer};
// EPUB 解析
use epub::doc::EpubDoc;
// RTF 解析
use rtf_parser::lexer::Lexer as RtfLexer;
use rtf_parser::parser::Parser as RtfParser;

/// 文档文件大小限制 (200MB)
const MAX_DOCUMENT_SIZE: usize = 200 * 1024 * 1024;

/// 流式处理时的缓冲区大小 (1MB)
const BUFFER_SIZE: usize = 1024 * 1024;

/// ★ M-11 修复：ZIP Bomb 防护常量
/// 最大解压后大小 (500MB)
const MAX_DECOMPRESSED_SIZE: u64 = 500 * 1024 * 1024;

/// 最大压缩比 (100:1)
/// 正常文档压缩比通常在 2:1 到 20:1 之间
const MAX_COMPRESSION_RATIO: f64 = 100.0;

/// 单个 ZIP 条目最大解压大小 (100MB)
const MAX_SINGLE_ENTRY_SIZE: u64 = 100 * 1024 * 1024;

/// 最大文件数量 (10000)
/// 防止通过大量小文件耗尽系统资源
const MAX_FILES_IN_ARCHIVE: usize = 10000;

/// ★ 嵌套 ZIP 检测：最大嵌套深度
/// 防止通过多层嵌套的 ZIP 文件绕过检测
const MAX_NESTED_ZIP_DEPTH: u32 = 3;

/// 文档解析错误枚举
#[derive(Debug, Serialize, Deserialize)]
pub enum ParsingError {
    /// 文件不存在或无法访问
    FileNotFound(String),
    /// IO错误
    IoError(String),
    /// 不支持的文件格式
    UnsupportedFormat(String),
    /// DOCX解析错误
    DocxParsingError(String),
    /// PDF解析错误
    PdfParsingError(String),
    /// PPTX解析错误
    PptxParsingError(String),
    /// EPUB解析错误
    EpubParsingError(String),
    /// RTF解析错误
    RtfParsingError(String),
    /// Excel解析错误
    ExcelParsingError(String),
    /// Base64解码错误
    Base64DecodingError(String),
    /// 文件过大错误
    FileTooLarge(String),
    /// ★ M-11 修复：ZIP Bomb 检测
    ZipBombDetected(String),
    /// ★ M-1 修复：加密文档检测
    EncryptedDocument(String),
    /// 其他错误
    Other(String),
}

impl std::fmt::Display for ParsingError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParsingError::FileNotFound(msg) => write!(f, "文件未找到: {}", msg),
            ParsingError::IoError(msg) => write!(f, "IO错误: {}", msg),
            ParsingError::UnsupportedFormat(msg) => write!(f, "不支持的文件格式: {}", msg),
            ParsingError::DocxParsingError(msg) => write!(f, "DOCX解析错误: {}", msg),
            ParsingError::PdfParsingError(msg) => write!(f, "PDF解析错误: {}", msg),
            ParsingError::PptxParsingError(msg) => write!(f, "PPTX解析错误: {}", msg),
            ParsingError::EpubParsingError(msg) => write!(f, "EPUB解析错误: {}", msg),
            ParsingError::RtfParsingError(msg) => write!(f, "RTF解析错误: {}", msg),
            ParsingError::ExcelParsingError(msg) => write!(f, "Excel解析错误: {}", msg),
            ParsingError::Base64DecodingError(msg) => write!(f, "Base64解码错误: {}", msg),
            ParsingError::FileTooLarge(msg) => write!(f, "文件过大: {}", msg),
            ParsingError::ZipBombDetected(msg) => write!(f, "ZIP Bomb检测: {}", msg),
            ParsingError::EncryptedDocument(msg) => write!(f, "文档已加密: {}", msg),
            ParsingError::Other(msg) => write!(f, "其他错误: {}", msg),
        }
    }
}

impl std::error::Error for ParsingError {}

/// 从IO错误转换
impl From<std::io::Error> for ParsingError {
    fn from(error: std::io::Error) -> Self {
        ParsingError::IoError(error.to_string())
    }
}

/// 从Base64解码错误转换
impl From<base64::DecodeError> for ParsingError {
    fn from(error: base64::DecodeError) -> Self {
        ParsingError::Base64DecodingError(error.to_string())
    }
}

/// 文档解析器结构体
pub struct DocumentParser;

impl DocumentParser {
    /// 创建新的文档解析器实例
    pub fn new() -> Self {
        DocumentParser
    }

    /// 检查文件大小是否超出限制
    fn check_file_size(&self, size: usize) -> Result<(), ParsingError> {
        if size > MAX_DOCUMENT_SIZE {
            return Err(ParsingError::FileTooLarge(format!(
                "文件大小 {}MB 超过限制 {}MB",
                size / (1024 * 1024),
                MAX_DOCUMENT_SIZE / (1024 * 1024)
            )));
        }
        Ok(())
    }

    /// ★ M-11 修复：检测 ZIP Bomb 攻击
    ///
    /// DOCX/XLSX/PPTX 本质上是 ZIP 文件，恶意构造的文件可能有极高的压缩比，
    /// 解压后消耗大量内存/磁盘空间。
    ///
    /// 检测策略：
    /// 1. 检查文件数量是否超过 10000
    /// 2. 检查总解压大小是否超过 500MB
    /// 3. 检查单个条目的压缩比是否超过 100:1
    /// 4. 检查单个条目解压大小是否超过 100MB
    /// 5. ★ 递归检测嵌套的 ZIP 文件（最大深度 3 层）
    fn check_zip_bomb(&self, bytes: &[u8], file_name: &str) -> Result<(), ParsingError> {
        self.check_zip_bomb_recursive(bytes, file_name, 0)
    }

    /// ★ 嵌套 ZIP 检测：判断文件扩展名是否为 ZIP 格式
    ///
    /// 支持的 ZIP 格式包括：
    /// - .zip: 标准 ZIP 文件
    /// - .docx, .xlsx, .pptx: Microsoft Office Open XML 格式
    /// - .xlsb: Excel 二进制格式
    /// - .odt, .odp, .odg, .ods: OpenDocument 格式
    /// - .epub: 电子书格式
    /// - .jar, .war, .ear: Java 打包格式
    /// - .apk: Android 应用包
    /// - .cbz: 漫画书 ZIP 格式
    /// - .kmz: Google Earth KML 压缩格式
    /// - .xpi: Firefox 扩展包
    /// - .crx: Chrome 扩展包
    /// - .aar: Android Archive
    /// - .appx, .msix: Windows 应用包
    /// - .nupkg: NuGet 包
    fn is_zip_like_extension(entry_name: &str) -> bool {
        let lower_name = entry_name.to_lowercase();
        lower_name.ends_with(".zip")
            || lower_name.ends_with(".docx")
            || lower_name.ends_with(".xlsx")
            || lower_name.ends_with(".pptx")
            || lower_name.ends_with(".xlsb")
            // OpenDocument 格式
            || lower_name.ends_with(".odt")
            || lower_name.ends_with(".odp")
            || lower_name.ends_with(".odg")
            || lower_name.ends_with(".ods")
            || lower_name.ends_with(".epub")
            // Java 打包格式
            || lower_name.ends_with(".jar")
            || lower_name.ends_with(".war")
            || lower_name.ends_with(".ear")
            || lower_name.ends_with(".apk")
            // 其他 ZIP 格式
            || lower_name.ends_with(".cbz")
            || lower_name.ends_with(".kmz")
            || lower_name.ends_with(".xpi")
            || lower_name.ends_with(".crx")
            || lower_name.ends_with(".aar")
            || lower_name.ends_with(".appx")
            || lower_name.ends_with(".msix")
            || lower_name.ends_with(".nupkg")
    }

    /// ★ 嵌套 ZIP 检测：通过魔数（magic bytes）检测是否为 ZIP 文件
    ///
    /// ZIP 文件的魔数：
    /// - `PK\x03\x04` (0x504B0304): 正常 ZIP 文件头
    /// - `PK\x05\x06` (0x504B0506): 空 ZIP 或分卷 ZIP 末尾标记
    ///
    /// 此函数用于检测攻击者通过修改扩展名绕过检测的情况
    fn is_zip_magic_bytes(data: &[u8]) -> bool {
        if data.len() < 4 {
            return false;
        }
        // 正常 ZIP 文件头: PK\x03\x04
        let normal_zip_magic: [u8; 4] = [0x50, 0x4B, 0x03, 0x04];
        // 空 ZIP 或分卷 ZIP: PK\x05\x06
        let empty_zip_magic: [u8; 4] = [0x50, 0x4B, 0x05, 0x06];

        data[..4] == normal_zip_magic || data[..4] == empty_zip_magic
    }

    /// ★ 嵌套 ZIP 检测：递归检测 ZIP Bomb
    ///
    /// 参数：
    /// - bytes: ZIP 文件的字节内容
    /// - file_name: 文件名（用于错误消息）
    /// - depth: 当前嵌套深度（0 = 第一层）
    fn check_zip_bomb_recursive(
        &self,
        bytes: &[u8],
        file_name: &str,
        depth: u32,
    ) -> Result<(), ParsingError> {
        use std::io::{Cursor, Read};

        // ★ 检查嵌套深度限制
        // 使用 >= 确保 depth=3 时（第4层）被正确拦截
        // MAX_NESTED_ZIP_DEPTH=3 表示允许最多3层嵌套（depth 0, 1, 2）
        if depth >= MAX_NESTED_ZIP_DEPTH {
            return Err(ParsingError::ZipBombDetected(format!(
                "文件 '{}' 嵌套深度超过限制 {} 层，可能是 ZIP Bomb 攻击",
                file_name, MAX_NESTED_ZIP_DEPTH
            )));
        }

        let cursor = Cursor::new(bytes);
        let mut archive = match zip::ZipArchive::new(cursor) {
            Ok(a) => a,
            Err(e) => {
                // ZIP 解析失败，让后续的具体解析器处理
                log::warn!("ZIP bomb check: failed to open as ZIP: {}", e);
                return Ok(());
            }
        };

        // ★ 新增：检查文件数量（防止通过大量小文件耗尽资源）
        let file_count = archive.len();
        if file_count > MAX_FILES_IN_ARCHIVE {
            return Err(ParsingError::ZipBombDetected(format!(
                "文件 '{}' 包含 {} 个条目，超过安全限制 {} 个",
                file_name, file_count, MAX_FILES_IN_ARCHIVE
            )));
        }

        let mut total_uncompressed: u64 = 0;
        let compressed_size = bytes.len() as u64;

        // ★ 收集需要递归检测的嵌套 ZIP 条目
        // 由于 ZipArchive 借用规则，需要先收集索引和名称，再分别处理
        // 元组: (索引, 名称, 是否已通过扩展名识别为ZIP)
        let mut nested_zip_indices: Vec<(usize, String, bool)> = Vec::new();

        for i in 0..file_count {
            let entry = match archive.by_index(i) {
                Ok(e) => e,
                Err(_) => continue,
            };

            let entry_size = entry.size();
            let entry_compressed = entry.compressed_size();
            let entry_name = entry.name().to_string();

            // 检查单个条目大小
            if entry_size > MAX_SINGLE_ENTRY_SIZE {
                return Err(ParsingError::ZipBombDetected(format!(
                    "文件 '{}' 中的条目 '{}' 解压后大小 {:.1}MB 超过限制 {:.1}MB",
                    file_name,
                    entry_name,
                    entry_size as f64 / (1024.0 * 1024.0),
                    MAX_SINGLE_ENTRY_SIZE as f64 / (1024.0 * 1024.0)
                )));
            }

            // 检查单个条目压缩比
            if entry_compressed > 0 {
                let ratio = entry_size as f64 / entry_compressed as f64;
                if ratio > MAX_COMPRESSION_RATIO {
                    return Err(ParsingError::ZipBombDetected(format!(
                        "文件 '{}' 中的条目 '{}' 压缩比 {:.1}:1 超过安全阈值 {:.0}:1",
                        file_name, entry_name, ratio, MAX_COMPRESSION_RATIO
                    )));
                }
            }

            total_uncompressed += entry_size;

            // ★ 新增：提前检查总解压大小（避免遍历所有条目才发现超限）
            if total_uncompressed > MAX_DECOMPRESSED_SIZE {
                return Err(ParsingError::ZipBombDetected(format!(
                    "文件 '{}' 解压后总大小超过限制 {:.0}MB（已累计 {:.1}MB）",
                    file_name,
                    MAX_DECOMPRESSED_SIZE as f64 / (1024.0 * 1024.0),
                    total_uncompressed as f64 / (1024.0 * 1024.0)
                )));
            }

            // ★ 嵌套 ZIP 检测：标记需要递归检测的条目
            // 只对合理大小的条目进行递归（避免读取过大的嵌套文件）
            // 使用扩展名预筛选；魔数检测在读取内容后进行（防止扩展名绕过）
            if entry_size > 0 && entry_size <= MAX_SINGLE_ENTRY_SIZE {
                // 通过扩展名标记为已知 ZIP 类型，或标记为需要魔数检测
                let is_known_zip_ext = Self::is_zip_like_extension(&entry_name);
                nested_zip_indices.push((i, entry_name, is_known_zip_ext));
            }
        }

        // 检查整体压缩比
        if compressed_size > 0 {
            let overall_ratio = total_uncompressed as f64 / compressed_size as f64;
            if overall_ratio > MAX_COMPRESSION_RATIO {
                return Err(ParsingError::ZipBombDetected(format!(
                    "文件 '{}' 整体压缩比 {:.1}:1 超过安全阈值 {:.0}:1",
                    file_name, overall_ratio, MAX_COMPRESSION_RATIO
                )));
            }
        }

        // ★ 嵌套 ZIP 检测：递归检查嵌套的 ZIP 文件
        for (index, nested_name, is_known_zip_ext) in nested_zip_indices {
            // 重新打开 archive（因为之前的迭代已经结束）
            let cursor = Cursor::new(bytes);
            let mut archive = match zip::ZipArchive::new(cursor) {
                Ok(a) => a,
                Err(_) => continue,
            };

            let mut entry = match archive.by_index(index) {
                Ok(e) => e,
                Err(_) => continue,
            };

            // 读取嵌套 ZIP 的内容
            let mut nested_bytes = Vec::with_capacity(entry.size() as usize);
            if entry.read_to_end(&mut nested_bytes).is_ok() && !nested_bytes.is_empty() {
                // ★ 安全增强：同时使用扩展名和魔数检测
                // 条件1: 扩展名匹配已知 ZIP 格式
                // 条件2: 文件头匹配 ZIP 魔数（防止扩展名绕过攻击）
                let is_zip_by_magic = Self::is_zip_magic_bytes(&nested_bytes);

                // 只有扩展名或魔数至少匹配一个时才递归检测
                if is_known_zip_ext || is_zip_by_magic {
                    // 构造嵌套文件的完整路径用于错误消息
                    let nested_path = format!("{} -> {}", file_name, nested_name);

                    let detection_method = match (is_known_zip_ext, is_zip_by_magic) {
                        (true, true) => "extension+magic",
                        (true, false) => "extension",
                        (false, true) => "magic-bytes",
                        (false, false) => "none", // 不应该到达这里
                    };

                    log::debug!(
                        "ZIP bomb check: recursively checking nested ZIP '{}' at depth {} (detected by: {})",
                        nested_path,
                        depth + 1,
                        detection_method
                    );

                    // 递归检测嵌套 ZIP
                    self.check_zip_bomb_recursive(&nested_bytes, &nested_path, depth + 1)?;
                }
            }
        }

        log::debug!(
            "ZIP bomb check passed for '{}' (depth {}): {} entries, {:.1}MB uncompressed",
            file_name,
            depth,
            file_count,
            total_uncompressed as f64 / (1024.0 * 1024.0)
        );

        Ok(())
    }

    /// 检查基于路径的 ZIP 文件是否为 ZIP Bomb
    fn check_zip_bomb_from_path(&self, file_path: &str) -> Result<(), ParsingError> {
        let bytes = self.read_file_safely(file_path)?;
        let file_name = std::path::Path::new(file_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(file_path);
        self.check_zip_bomb(&bytes, file_name)
    }

    /// ★ M-1 修复：检测 Office 文档（DOCX/XLSX/PPTX）是否加密
    ///
    /// Office Open XML 格式加密后的特征：
    /// 1. 存在 `EncryptedPackage` 文件（标准 Office 加密）
    /// 2. 缺少 `[Content_Types].xml` 文件（未加密文档必有此文件）
    fn check_office_encryption(&self, bytes: &[u8], file_name: &str) -> Result<(), ParsingError> {
        use std::io::Cursor;

        let cursor = Cursor::new(bytes);
        let mut archive = match zip::ZipArchive::new(cursor) {
            Ok(a) => a,
            Err(_) => {
                // 无法作为 ZIP 打开，让后续解析器处理具体错误
                return Ok(());
            }
        };

        // 检查是否存在 EncryptedPackage（Office 标准加密标记）
        if archive.by_name("EncryptedPackage").is_ok() {
            return Err(ParsingError::EncryptedDocument(format!(
                "文件 '{}' 是加密的 Office 文档，请先解除密码保护后再上传",
                file_name
            )));
        }

        // 检查 [Content_Types].xml 是否存在（未加密的 Office Open XML 必有此文件）
        if archive.by_name("[Content_Types].xml").is_err() {
            // 可能是加密或损坏的文档
            // 进一步检查是否有任何 Office 相关结构
            let has_office_structure = archive.file_names().any(|name| {
                name.starts_with("word/")
                    || name.starts_with("xl/")
                    || name.starts_with("ppt/")
                    || name == "docProps/core.xml"
                    || name == "docProps/app.xml"
            });

            if !has_office_structure {
                return Err(ParsingError::EncryptedDocument(format!(
                    "文件 '{}' 可能是加密的或已损坏，请检查文件完整性",
                    file_name
                )));
            }
        }

        log::debug!("Office encryption check passed for '{}'", file_name);
        Ok(())
    }

    /// 从路径检查 Office 文档加密
    fn check_office_encryption_from_path(&self, file_path: &str) -> Result<(), ParsingError> {
        let bytes = self.read_file_safely(file_path)?;
        let file_name = std::path::Path::new(file_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(file_path);
        self.check_office_encryption(&bytes, file_name)
    }

    /// ★ M-1 修复：检测 PDF 文档是否加密
    ///
    /// PDF 加密标记通常在文件中包含 `/Encrypt` 字典
    fn check_pdf_encryption(&self, bytes: &[u8], file_name: &str) -> Result<(), ParsingError> {
        // 检查文件头部和尾部区域中是否有加密标记
        // PDF 的 /Encrypt 字典通常在文件的 trailer 或 xref 区域附近

        // 检查前 4KB
        let check_size = std::cmp::min(bytes.len(), 4096);
        let header = String::from_utf8_lossy(&bytes[..check_size]);

        if header.contains("/Encrypt") {
            return Err(ParsingError::EncryptedDocument(format!(
                "文件 '{}' 是加密的 PDF 文档，请先解除密码保护后再上传",
                file_name
            )));
        }

        // 检查最后 4KB（trailer 区域）
        if bytes.len() > 4096 {
            let tail_start = bytes.len().saturating_sub(4096);
            let trailer = String::from_utf8_lossy(&bytes[tail_start..]);

            if trailer.contains("/Encrypt") {
                return Err(ParsingError::EncryptedDocument(format!(
                    "文件 '{}' 是加密的 PDF 文档，请先解除密码保护后再上传",
                    file_name
                )));
            }
        }

        // 对于大文件，检查中间部分（某些 PDF 工具可能将 Encrypt 放在中间）
        if bytes.len() > 8192 {
            // 检查中间 8KB
            let mid_start = bytes.len() / 2 - 4096;
            let mid_end = std::cmp::min(mid_start + 8192, bytes.len());
            let middle = String::from_utf8_lossy(&bytes[mid_start..mid_end]);

            if middle.contains("/Encrypt") {
                return Err(ParsingError::EncryptedDocument(format!(
                    "文件 '{}' 是加密的 PDF 文档，请先解除密码保护后再上传",
                    file_name
                )));
            }
        }

        log::debug!("PDF encryption check passed for '{}'", file_name);
        Ok(())
    }

    /// 从路径检查 PDF 文档加密
    fn check_pdf_encryption_from_path(&self, file_path: &str) -> Result<(), ParsingError> {
        let bytes = self.read_file_safely(file_path)?;
        let file_name = std::path::Path::new(file_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(file_path);
        self.check_pdf_encryption(&bytes, file_name)
    }

    /// 安全地检查并读取文件
    fn read_file_safely(&self, file_path: &str) -> Result<Vec<u8>, ParsingError> {
        let metadata = fs::metadata(file_path)?;
        let file_size = metadata.len() as usize;

        self.check_file_size(file_size)?;

        let bytes = fs::read(file_path)?;
        Ok(bytes)
    }

    /// 从文件路径提取文本
    pub fn extract_text_from_path(&self, file_path: &str) -> Result<String, ParsingError> {
        let path = Path::new(file_path);

        // 检查文件是否存在
        if !path.exists() {
            return Err(ParsingError::FileNotFound(file_path.to_string()));
        }

        // 根据文件扩展名确定处理方式
        let extension = path
            .extension()
            .and_then(|ext| ext.to_str())
            .ok_or_else(|| ParsingError::UnsupportedFormat("无法确定文件扩展名".to_string()))?
            .to_lowercase();

        match extension.as_str() {
            "docx" => self.extract_docx_from_path(file_path),
            "pdf" => self.extract_pdf_from_path(file_path),
            "txt" => self.extract_txt_from_path(file_path),
            "md" => self.extract_md_from_path(file_path),
            "html" | "htm" => self.extract_html_from_path(file_path),
            "xlsx" | "xls" | "xlsb" | "ods" => self.extract_excel_from_path(file_path),
            "pptx" => self.extract_pptx_from_path(file_path),
            "epub" => self.extract_epub_from_path(file_path),
            "rtf" => self.extract_rtf_from_path(file_path),
            // ★ P0 修复：csv/json/xml 支持（复用 bytes 版本）
            "csv" | "json" | "xml" => {
                let bytes = self.read_file_safely(file_path)?;
                self.extract_text_from_bytes(
                    path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or(file_path),
                    bytes,
                )
            }
            _ => Err(ParsingError::UnsupportedFormat(format!(
                "不支持的文件格式: .{}",
                extension
            ))),
        }
    }

    /// 从字节流提取文本
    pub fn extract_text_from_bytes(
        &self,
        file_name: &str,
        bytes: Vec<u8>,
    ) -> Result<String, ParsingError> {
        // 检查文件大小
        self.check_file_size(bytes.len())?;

        // 从文件名确定文件类型
        let extension = Path::new(file_name)
            .extension()
            .and_then(|ext| ext.to_str())
            .ok_or_else(|| ParsingError::UnsupportedFormat("无法确定文件扩展名".to_string()))?
            .to_lowercase();

        match extension.as_str() {
            "docx" => self.extract_docx_from_bytes(bytes),
            "pdf" => self.extract_pdf_from_bytes(bytes),
            "txt" => self.extract_txt_from_bytes(bytes),
            "md" => self.extract_md_from_bytes(bytes),
            "html" | "htm" => self.extract_html_from_bytes(bytes),
            "xlsx" | "xls" | "xlsb" | "ods" => self.extract_excel_from_bytes(file_name, bytes),
            "pptx" => self.extract_pptx_from_bytes(bytes),
            "epub" => self.extract_epub_from_bytes(bytes),
            "rtf" => self.extract_rtf_from_bytes(bytes),
            "csv" => self.extract_csv_from_bytes(bytes),
            "json" => self.extract_json_from_bytes(bytes),
            "xml" => self.extract_xml_from_bytes(bytes),
            _ => Err(ParsingError::UnsupportedFormat(format!(
                "不支持的文件格式: .{}",
                extension
            ))),
        }
    }

    /// 从Base64编码内容提取文本
    ///
    /// ★ 2026-01-26 修复：支持 Data URL 格式（如 `data:application/pdf;base64,...`）
    pub fn extract_text_from_base64(
        &self,
        file_name: &str,
        base64_content: &str,
    ) -> Result<String, ParsingError> {
        // 处理 Data URL 格式
        let base64_str = if base64_content.starts_with("data:") {
            base64_content.split(',').nth(1).ok_or_else(|| {
                ParsingError::Base64DecodingError(
                    "Invalid data URL format: missing base64 content after comma".to_string(),
                )
            })?
        } else {
            base64_content
        };

        // 解码Base64内容
        let bytes = general_purpose::STANDARD.decode(base64_str)?;

        // 调用字节流处理方法
        self.extract_text_from_bytes(file_name, bytes)
    }

    /// 从DOCX文件路径提取文本
    fn extract_docx_from_path(&self, file_path: &str) -> Result<String, ParsingError> {
        let bytes = self.read_file_safely(file_path)?;
        let file_name = std::path::Path::new(file_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(file_path);

        // ★ M-1 修复：加密文档检测（在 ZIP Bomb 检测之前，因为加密检测更快）
        self.check_office_encryption(&bytes, file_name)?;
        // ★ M-11 修复：ZIP Bomb 检测
        self.check_zip_bomb(&bytes, file_name)?;

        self.extract_docx_from_bytes_internal(bytes)
    }

    /// 从DOCX字节流提取文本
    fn extract_docx_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        // ★ M-1 修复：加密文档检测
        self.check_office_encryption(&bytes, "document.docx")?;
        // ★ M-11 修复：ZIP Bomb 检测
        self.check_zip_bomb(&bytes, "document.docx")?;
        self.extract_docx_from_bytes_internal(bytes)
    }

    /// 从DOCX字节流提取文本（内部实现，跳过 ZIP Bomb 检测）
    fn extract_docx_from_bytes_internal(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        let docx = docx_rs::read_docx(&bytes)
            .map_err(|e| ParsingError::DocxParsingError(e.to_string()))?;

        Ok(self.extract_docx_text(&docx))
    }

    /// 从 DOCX 字节流提取文本 + 嵌入图片
    ///
    /// 在文本中图片出现位置插入 `<<IMG:N>>` 标记（N 为从 0 开始的图片索引），
    /// 同时返回所有提取的图片原始字节数据。
    ///
    /// 返回 `(text_with_markers, images_bytes)` — images_bytes[N] 对应 `<<IMG:N>>`。
    pub fn extract_docx_with_images(&self, bytes: &[u8]) -> Result<(String, Vec<Vec<u8>>), ParsingError> {
        self.check_office_encryption(bytes, "document.docx")?;
        self.check_zip_bomb(bytes, "document.docx")?;

        let docx = docx_rs::read_docx(bytes)
            .map_err(|e| ParsingError::DocxParsingError(e.to_string()))?;

        let mut text_content = String::with_capacity(8192);
        let mut images: Vec<Vec<u8>> = Vec::new();

        for child in &docx.document.children {
            match child {
                docx_rs::DocumentChild::Paragraph(para) => {
                    let line = Self::extract_paragraph_text_with_images(para, &mut images);
                    if !line.trim().is_empty() {
                        text_content.push_str(&line);
                        text_content.push('\n');
                    }
                }
                docx_rs::DocumentChild::Table(table) => {
                    Self::extract_table_text_with_images(table, &mut text_content, &mut images);
                    text_content.push('\n');
                }
                docx_rs::DocumentChild::TableOfContents(toc) => {
                    for item in &toc.items {
                        if !item.text.is_empty() {
                            text_content.push_str(&format!("{}\n", item.text));
                        }
                    }
                }
                _ => {}
            }
        }

        Ok((text_content, images))
    }

    /// 从段落中提取文本 + 图片标记
    fn extract_paragraph_text_with_images(
        para: &docx_rs::Paragraph,
        images: &mut Vec<Vec<u8>>,
    ) -> String {
        let mut line = String::new();
        for child in &para.children {
            match child {
                docx_rs::ParagraphChild::Run(run) => {
                    Self::extract_run_text_with_images(run, &mut line, images);
                }
                docx_rs::ParagraphChild::Hyperlink(hyperlink) => {
                    for run in &hyperlink.children {
                        if let docx_rs::ParagraphChild::Run(r) = run {
                            Self::extract_run_text_with_images(r, &mut line, images);
                        }
                    }
                }
                docx_rs::ParagraphChild::Insert(ins) => {
                    for ic in &ins.children {
                        if let docx_rs::InsertChild::Run(r) = ic {
                            Self::extract_run_text_with_images(r, &mut line, images);
                        }
                    }
                }
                docx_rs::ParagraphChild::Delete(del) => {
                    for dc in &del.children {
                        if let docx_rs::DeleteChild::Run(r) = dc {
                            Self::extract_run_text_with_images(r, &mut line, images);
                        }
                    }
                }
                _ => {}
            }
        }
        line
    }

    /// 从 Run 中提取文本 + 图片标记
    fn extract_run_text_with_images(
        run: &docx_rs::Run,
        out: &mut String,
        images: &mut Vec<Vec<u8>>,
    ) {
        for rc in &run.children {
            match rc {
                docx_rs::RunChild::Text(t) => {
                    out.push_str(&t.text);
                }
                docx_rs::RunChild::DeleteText(dt) => {
                    if let Ok(v) = serde_json::to_value(dt) {
                        if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                            out.push_str(t);
                        }
                    }
                }
                docx_rs::RunChild::Tab(_) => {
                    out.push('\t');
                }
                docx_rs::RunChild::Break(_) => {
                    out.push('\n');
                }
                docx_rs::RunChild::Drawing(drawing) => {
                    if let Some(docx_rs::DrawingData::Pic(pic)) = &drawing.data {
                        if !pic.image.is_empty() {
                            let idx = images.len();
                            images.push(pic.image.clone());
                            out.push_str(&format!("<<IMG:{}>>", idx));
                        }
                    }
                }
                _ => {}
            }
        }
    }

    /// 从表格中提取文本 + 图片标记
    fn extract_table_text_with_images(
        table: &docx_rs::Table,
        out: &mut String,
        images: &mut Vec<Vec<u8>>,
    ) {
        for tc in &table.rows {
            if let docx_rs::TableChild::TableRow(row) = tc {
                let mut cells: Vec<String> = Vec::new();
                for rc in &row.cells {
                    if let docx_rs::TableRowChild::TableCell(cell) = rc {
                        let mut cell_text = String::new();
                        for cc in &cell.children {
                            if let docx_rs::TableCellContent::Paragraph(para) = cc {
                                let t = Self::extract_paragraph_text_with_images(para, images);
                                if !t.trim().is_empty() {
                                    if !cell_text.is_empty() {
                                        cell_text.push(' ');
                                    }
                                    cell_text.push_str(t.trim());
                                }
                            }
                        }
                        cells.push(cell_text);
                    }
                }
                if cells.iter().any(|c| !c.is_empty()) {
                    out.push_str(&format!("| {} |\n", cells.join(" | ")));
                }
            }
        }
    }

    /// 从DOCX文档对象提取文本内容（增强版：支持表格/超链接/标题/列表）
    fn extract_docx_text(&self, docx: &docx_rs::Docx) -> String {
        let mut text_content = String::with_capacity(8192);

        for child in &docx.document.children {
            match child {
                docx_rs::DocumentChild::Paragraph(para) => {
                    let line = Self::extract_paragraph_text(para);
                    if !line.trim().is_empty() {
                        text_content.push_str(&line);
                        text_content.push('\n');
                    }
                }
                docx_rs::DocumentChild::Table(table) => {
                    Self::extract_table_text(table, &mut text_content);
                    text_content.push('\n');
                }
                docx_rs::DocumentChild::BookmarkStart(_)
                | docx_rs::DocumentChild::BookmarkEnd(_) => {}
                docx_rs::DocumentChild::TableOfContents(toc) => {
                    for item in &toc.items {
                        if !item.text.is_empty() {
                            text_content.push_str(&format!("{}\n", item.text));
                        }
                    }
                }
                _ => {}
            }
        }

        text_content.trim().to_string()
    }

    /// 从段落中提取纯文本（包括 Run / Hyperlink / Insert / Delete 子元素）
    fn extract_paragraph_text(para: &docx_rs::Paragraph) -> String {
        let mut line = String::new();
        for child in &para.children {
            match child {
                docx_rs::ParagraphChild::Run(run) => {
                    Self::extract_run_text(run, &mut line);
                }
                docx_rs::ParagraphChild::Hyperlink(hyperlink) => {
                    for run in &hyperlink.children {
                        if let docx_rs::ParagraphChild::Run(r) = run {
                            Self::extract_run_text(r, &mut line);
                        }
                    }
                }
                docx_rs::ParagraphChild::Insert(ins) => {
                    for ic in &ins.children {
                        if let docx_rs::InsertChild::Run(r) = ic {
                            Self::extract_run_text(r, &mut line);
                        }
                    }
                }
                docx_rs::ParagraphChild::Delete(del) => {
                    for dc in &del.children {
                        if let docx_rs::DeleteChild::Run(r) = dc {
                            Self::extract_run_text(r, &mut line);
                        }
                    }
                }
                _ => {}
            }
        }
        line
    }

    /// 从 Run 中提取文本（Text / Tab / Break / DeleteText）
    fn extract_run_text(run: &docx_rs::Run, out: &mut String) {
        for rc in &run.children {
            match rc {
                docx_rs::RunChild::Text(t) => {
                    out.push_str(&t.text);
                }
                docx_rs::RunChild::DeleteText(dt) => {
                    if let Ok(v) = serde_json::to_value(dt) {
                        if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                            out.push_str(t);
                        }
                    }
                }
                docx_rs::RunChild::Tab(_) => {
                    out.push('\t');
                }
                docx_rs::RunChild::Break(_) => {
                    out.push('\n');
                }
                _ => {}
            }
        }
    }

    /// 从表格中提取文本（Markdown 表格格式）
    fn extract_table_text(table: &docx_rs::Table, out: &mut String) {
        let mut rows: Vec<Vec<String>> = Vec::new();

        for tc in &table.rows {
            if let docx_rs::TableChild::TableRow(row) = tc {
                let mut cells: Vec<String> = Vec::new();
                for rc in &row.cells {
                    if let docx_rs::TableRowChild::TableCell(cell) = rc {
                        let mut cell_text = String::new();
                        for cc in &cell.children {
                            if let docx_rs::TableCellContent::Paragraph(para) = cc {
                                let t = Self::extract_paragraph_text(para);
                                if !t.trim().is_empty() {
                                    if !cell_text.is_empty() {
                                        cell_text.push(' ');
                                    }
                                    cell_text.push_str(t.trim());
                                }
                            }
                        }
                        cells.push(cell_text);
                    }
                }
                rows.push(cells);
            }
        }

        if rows.is_empty() {
            return;
        }

        // 计算列数
        let col_count = rows.iter().map(|r| r.len()).max().unwrap_or(0);
        if col_count == 0 {
            return;
        }

        // 输出 Markdown 表格
        for (i, row) in rows.iter().enumerate() {
            out.push('|');
            for j in 0..col_count {
                let cell = row.get(j).map(|s| s.as_str()).unwrap_or("");
                out.push_str(&format!(" {} |", cell));
            }
            out.push('\n');

            // 在第一行后添加分隔行
            if i == 0 {
                out.push('|');
                for _ in 0..col_count {
                    out.push_str(" --- |");
                }
                out.push('\n');
            }
        }
    }

    /// ★ 结构化 DOCX 提取：输出富 Markdown（保留标题/表格/列表/超链接/格式/图片占位）
    ///
    /// 与 `extract_docx_text` 不同，此方法保留文档结构信息，
    /// 供 LLM 工具 `docx_read_structured` 使用。
    pub fn extract_docx_structured(&self, bytes: &[u8]) -> Result<String, ParsingError> {
        let docx = docx_rs::read_docx(bytes)
            .map_err(|e| ParsingError::DocxParsingError(e.to_string()))?;

        let mut md = String::with_capacity(16384);

        for child in &docx.document.children {
            match child {
                docx_rs::DocumentChild::Paragraph(para) => {
                    Self::paragraph_to_markdown(para, &docx, &mut md);
                }
                docx_rs::DocumentChild::Table(table) => {
                    Self::extract_table_text(table, &mut md);
                    md.push('\n');
                }
                docx_rs::DocumentChild::TableOfContents(toc) => {
                    md.push_str("**[目录]**\n");
                    for item in &toc.items {
                        if !item.text.is_empty() {
                            md.push_str(&format!("- {}\n", item.text));
                        }
                    }
                    md.push('\n');
                }
                _ => {}
            }
        }

        Ok(md.trim().to_string())
    }

    /// 将段落转换为 Markdown（含标题/列表/超链接/粗体/斜体/图片占位）
    fn paragraph_to_markdown(
        para: &docx_rs::Paragraph,
        docx: &docx_rs::Docx,
        out: &mut String,
    ) {
        // 检测标题样式
        let heading_level = Self::detect_heading_level(para, docx);

        // 检测列表（编号属性）
        let list_prefix = Self::detect_list_prefix(para);

        // 构建段落内容（含格式标记）
        let mut line = String::new();
        for child in &para.children {
            match child {
                docx_rs::ParagraphChild::Run(run) => {
                    Self::run_to_markdown(run, &mut line);
                }
                docx_rs::ParagraphChild::Hyperlink(hyperlink) => {
                    let mut link_text = String::new();
                    for hc in &hyperlink.children {
                        if let docx_rs::ParagraphChild::Run(r) = hc {
                            Self::extract_run_text(r, &mut link_text);
                        }
                    }
                    if !link_text.is_empty() {
                        // 从 HyperlinkData 提取 URL
                        let url_opt = match &hyperlink.link {
                            docx_rs::HyperlinkData::External { rid, .. } => Some(rid.clone()),
                            docx_rs::HyperlinkData::Anchor { anchor, .. } => Some(format!("#{}", anchor)),
                        };
                        if let Some(url) = url_opt {
                            line.push_str(&format!("[{}]({})", link_text, url));
                        } else {
                            line.push_str(&link_text);
                        }
                    }
                }
                docx_rs::ParagraphChild::Insert(ins) => {
                    for ic in &ins.children {
                        if let docx_rs::InsertChild::Run(r) = ic {
                            Self::run_to_markdown(r, &mut line);
                        }
                    }
                }
                docx_rs::ParagraphChild::Delete(del) => {
                    for dc in &del.children {
                        if let docx_rs::DeleteChild::Run(r) = dc {
                            line.push_str("~~");
                            Self::extract_run_text(r, &mut line);
                            line.push_str("~~");
                        }
                    }
                }
                _ => {}
            }
        }

        if line.trim().is_empty() {
            return;
        }

        // 组装输出
        if let Some(level) = heading_level {
            let hashes = "#".repeat(level as usize);
            out.push_str(&format!("{} {}\n\n", hashes, line.trim()));
        } else if let Some(ref prefix) = list_prefix {
            out.push_str(&format!("{}{}\n", prefix, line.trim()));
        } else {
            out.push_str(line.trim());
            out.push_str("\n\n");
        }
    }

    /// Run 转 Markdown（含粗体/斜体/删除线/图片占位）
    fn run_to_markdown(run: &docx_rs::Run, out: &mut String) {
        // Bold/Italic .val is private in docx-rs 0.4;
        // Bold::Serialize 输出裸 bool（serialize_bool(self.val)），
        // 因此 to_value(&bold) → Value::Bool(true/false)
        let is_bold = run.run_property.bold.as_ref().map_or(false, |b| {
            serde_json::to_value(b).ok().and_then(|v| v.as_bool()).unwrap_or(true)
        });
        let is_italic = run.run_property.italic.as_ref().map_or(false, |i| {
            serde_json::to_value(i).ok().and_then(|v| v.as_bool()).unwrap_or(true)
        });
        let is_strike = run.run_property.strike.as_ref().map(|s| s.val).unwrap_or(false);

        for rc in &run.children {
            match rc {
                docx_rs::RunChild::Text(t) => {
                    let text = &t.text;
                    if text.trim().is_empty() && text.contains(' ') {
                        out.push(' ');
                        continue;
                    }
                    if is_bold && is_italic {
                        out.push_str(&format!("***{}***", text));
                    } else if is_bold {
                        out.push_str(&format!("**{}**", text));
                    } else if is_italic {
                        out.push_str(&format!("*{}*", text));
                    } else if is_strike {
                        out.push_str(&format!("~~{}~~", text));
                    } else {
                        out.push_str(text);
                    }
                }
                docx_rs::RunChild::DeleteText(dt) => {
                    if let Ok(v) = serde_json::to_value(dt) {
                        if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
                            out.push_str(&format!("~~{}~~", t));
                        }
                    }
                }
                docx_rs::RunChild::Tab(_) => {
                    out.push('\t');
                }
                docx_rs::RunChild::Break(_) => {
                    out.push_str("  \n");
                }
                docx_rs::RunChild::Drawing(_) => {
                    out.push_str("![图片](embedded-image)");
                }
                _ => {}
            }
        }
    }

    /// 检测段落标题级别（通过样式名或 outline_lvl）
    fn detect_heading_level(
        para: &docx_rs::Paragraph,
        _docx: &docx_rs::Docx,
    ) -> Option<u8> {
        // 方式1：通过样式名检测（Heading1-9, 标题 1-9）
        if let Some(ref style) = para.property.style {
            let style_id = &style.val;
            // 英文: Heading1, Heading2 ...
            if style_id.starts_with("Heading") || style_id.starts_with("heading") {
                if let Ok(lvl) = style_id.trim_start_matches(|c: char| !c.is_ascii_digit()).parse::<u8>() {
                    if (1..=6).contains(&lvl) {
                        return Some(lvl);
                    }
                }
            }
            // 中文样式：标题 1, 标题 2 ...
            if style_id.contains("标题") || style_id.contains("Title") {
                // 提取数字
                let digits: String = style_id.chars().filter(|c| c.is_ascii_digit()).collect();
                if let Ok(lvl) = digits.parse::<u8>() {
                    if (1..=6).contains(&lvl) {
                        return Some(lvl);
                    }
                }
                // "Title" 没有数字 → 视为 h1
                if style_id == "Title" {
                    return Some(1);
                }
            }
            // Subtitle → h2
            if style_id == "Subtitle" {
                return Some(2);
            }
        }

        // 方式2：通过 outline_lvl
        if let Some(ref outline) = para.property.outline_lvl {
            let lvl = outline.v + 1; // outline_lvl 0-based
            if (1..=6).contains(&(lvl as u8)) {
                return Some(lvl as u8);
            }
        }

        None
    }

    /// 检测段落列表前缀（编号/项目符号）
    fn detect_list_prefix(para: &docx_rs::Paragraph) -> Option<String> {
        if let Some(ref numbering) = para.property.numbering_property {
            let indent_level = numbering
                .level
                .as_ref()
                .map(|l| l.val as usize)
                .unwrap_or(0);
            let indent = "  ".repeat(indent_level);

            // 有编号 ID → 有序列表；否则 → 无序列表
            if numbering.id.is_some() {
                return Some(format!("{}1. ", indent));
            }
            return Some(format!("{}- ", indent));
        }
        None
    }

    /// ★ 提取 DOCX 文档中的所有表格为结构化 JSON
    pub fn extract_docx_tables(&self, bytes: &[u8]) -> Result<Vec<Vec<Vec<String>>>, ParsingError> {
        let docx = docx_rs::read_docx(bytes)
            .map_err(|e| ParsingError::DocxParsingError(e.to_string()))?;

        let mut tables = Vec::new();
        for child in &docx.document.children {
            if let docx_rs::DocumentChild::Table(table) = child {
                let mut rows: Vec<Vec<String>> = Vec::new();
                for tc in &table.rows {
                    if let docx_rs::TableChild::TableRow(row) = tc {
                        let mut cells: Vec<String> = Vec::new();
                        for rc in &row.cells {
                            if let docx_rs::TableRowChild::TableCell(cell) = rc {
                                let mut cell_text = String::new();
                                for cc in &cell.children {
                                    if let docx_rs::TableCellContent::Paragraph(para) = cc {
                                        let t = Self::extract_paragraph_text(para);
                                        if !t.trim().is_empty() {
                                            if !cell_text.is_empty() {
                                                cell_text.push(' ');
                                            }
                                            cell_text.push_str(t.trim());
                                        }
                                    }
                                }
                                cells.push(cell_text);
                            }
                        }
                        rows.push(cells);
                    }
                }
                tables.push(rows);
            }
        }

        Ok(tables)
    }

    /// ★ 提取 DOCX 文档属性（标题/作者/描述/关键词/创建时间/修改时间）
    pub fn extract_docx_metadata(&self, bytes: &[u8]) -> Result<serde_json::Value, ParsingError> {
        let docx = docx_rs::read_docx(bytes)
            .map_err(|e| ParsingError::DocxParsingError(e.to_string()))?;

        // DocProps.core.config is private; serialize to JSON to access fields
        let props_json = serde_json::to_value(&docx.doc_props)
            .unwrap_or_else(|_| serde_json::json!({}));
        let core = props_json.get("core").and_then(|c| c.get("config")).cloned()
            .unwrap_or_else(|| serde_json::json!({}));

        Ok(serde_json::json!({
            "title": core.get("title").and_then(|v| v.as_str()).unwrap_or(""),
            "subject": core.get("subject").and_then(|v| v.as_str()).unwrap_or(""),
            "creator": core.get("creator").and_then(|v| v.as_str()).unwrap_or(""),
            "description": core.get("description").and_then(|v| v.as_str()).unwrap_or(""),
            "lastModifiedBy": core.get("lastModifiedBy").and_then(|v| v.as_str()).unwrap_or(""),
            "created": core.get("created").and_then(|v| v.as_str()).unwrap_or(""),
            "modified": core.get("modified").and_then(|v| v.as_str()).unwrap_or(""),
        }))
    }

    /// ★ 将 DOCX 转换为 JSON spec（与 generate_docx_from_spec 互逆，支持 round-trip 编辑）
    ///
    /// LLM 可通过 docx_to_spec → 修改 spec → docx_create 完成编辑闭环。
    pub fn extract_docx_as_spec(&self, bytes: &[u8]) -> Result<serde_json::Value, ParsingError> {
        let docx = docx_rs::read_docx(bytes)
            .map_err(|e| ParsingError::DocxParsingError(e.to_string()))?;

        let mut blocks: Vec<serde_json::Value> = Vec::new();

        for child in &docx.document.children {
            match child {
                docx_rs::DocumentChild::Paragraph(para) => {
                    // 检测标题
                    let heading_level = Self::detect_heading_level(para, &docx);
                    let list_prefix = Self::detect_list_prefix(para);

                    // 提取完整文本（含 Hyperlink / Insert / Delete 子元素）
                    let text = Self::extract_paragraph_text(para);

                    // 仅从 Run 子元素检测 bold/italic 格式
                    let mut has_bold = false;
                    let mut has_italic = false;
                    for pc in &para.children {
                        if let docx_rs::ParagraphChild::Run(run) = pc {
                            if run.run_property.bold.as_ref().map_or(false, |b| {
                                serde_json::to_value(b).ok().and_then(|v| v.as_bool()).unwrap_or(true)
                            }) {
                                has_bold = true;
                            }
                            if run.run_property.italic.as_ref().map_or(false, |i| {
                                serde_json::to_value(i).ok().and_then(|v| v.as_bool()).unwrap_or(true)
                            }) {
                                has_italic = true;
                            }
                        }
                    }

                    let text = text.trim().to_string();
                    if text.is_empty() {
                        continue;
                    }

                    if let Some(level) = heading_level {
                        blocks.push(serde_json::json!({
                            "type": "heading",
                            "level": level,
                            "text": text,
                        }));
                    } else if list_prefix.is_some() {
                        // 收集连续列表项时，单条作为 paragraph 输出
                        // （完整列表合并在 LLM 侧处理更灵活）
                        blocks.push(serde_json::json!({
                            "type": "paragraph",
                            "text": text,
                            "bold": has_bold,
                            "italic": has_italic,
                        }));
                    } else {
                        blocks.push(serde_json::json!({
                            "type": "paragraph",
                            "text": text,
                            "bold": has_bold,
                            "italic": has_italic,
                        }));
                    }
                }
                docx_rs::DocumentChild::Table(table) => {
                    let mut rows_data: Vec<Vec<String>> = Vec::new();
                    for tc in &table.rows {
                        if let docx_rs::TableChild::TableRow(row) = tc {
                            let mut cells: Vec<String> = Vec::new();
                            for rc in &row.cells {
                                if let docx_rs::TableRowChild::TableCell(cell) = rc {
                                    let mut cell_text = String::new();
                                    for cc in &cell.children {
                                        if let docx_rs::TableCellContent::Paragraph(para) = cc {
                                            let t = Self::extract_paragraph_text(para);
                                            if !t.trim().is_empty() {
                                                if !cell_text.is_empty() {
                                                    cell_text.push(' ');
                                                }
                                                cell_text.push_str(t.trim());
                                            }
                                        }
                                    }
                                    cells.push(cell_text);
                                }
                            }
                            rows_data.push(cells);
                        }
                    }
                    if !rows_data.is_empty() {
                        blocks.push(serde_json::json!({
                            "type": "table",
                            "rows": rows_data,
                        }));
                    }
                }
                _ => {}
            }
        }

        // 提取标题（从 CoreProps）
        let props_json = serde_json::to_value(&docx.doc_props).unwrap_or_default();
        let title = props_json
            .get("core")
            .and_then(|c| c.get("config"))
            .and_then(|c| c.get("title"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        Ok(serde_json::json!({
            "title": title,
            "blocks": blocks,
            "block_count": blocks.len(),
        }))
    }

    /// ★ 在 DOCX 中执行文本替换（返回新的 DOCX 字节）
    ///
    /// 通过 read → extract_as_spec → 修改 spec → generate 实现原地替换。
    /// 适用于简单的文本查找替换场景。
    pub fn replace_text_in_docx(
        &self,
        bytes: &[u8],
        replacements: &[(String, String)],
    ) -> Result<(Vec<u8>, usize), ParsingError> {
        let mut spec = self.extract_docx_as_spec(bytes)?;
        let mut total_replacements = 0usize;

        // 过滤掉空的 find 字符串（防止无限匹配）
        let replacements: Vec<&(String, String)> = replacements
            .iter()
            .filter(|(find, _)| !find.is_empty())
            .collect();

        if replacements.is_empty() {
            let new_bytes = Self::generate_docx_from_spec(&spec)?;
            return Ok((new_bytes, 0));
        }

        // 在 blocks 中执行替换
        if let Some(blocks) = spec.get_mut("blocks").and_then(|b| b.as_array_mut()) {
            for block in blocks.iter_mut() {
                // 替换 text 字段
                if let Some(text) = block.get("text").and_then(|v| v.as_str()).map(|s| s.to_string()) {
                    let mut new_text = text.clone();
                    for (find, replace) in &replacements {
                        let count = new_text.matches(find.as_str()).count();
                        if count > 0 {
                            new_text = new_text.replace(find.as_str(), replace.as_str());
                            total_replacements += count;
                        }
                    }
                    if new_text != text {
                        block["text"] = serde_json::Value::String(new_text);
                    }
                }
                // 替换 table rows 中的文本
                if let Some(rows) = block.get_mut("rows").and_then(|r| r.as_array_mut()) {
                    for row in rows.iter_mut() {
                        if let Some(cells) = row.as_array_mut() {
                            for cell in cells.iter_mut() {
                                if let Some(cell_text) = cell.as_str().map(|s| s.to_string()) {
                                    let mut new_text = cell_text.clone();
                                    for (find, replace) in &replacements {
                                        let count = new_text.matches(find.as_str()).count();
                                        if count > 0 {
                                            new_text = new_text.replace(find.as_str(), replace.as_str());
                                            total_replacements += count;
                                        }
                                    }
                                    if new_text != cell_text {
                                        *cell = serde_json::Value::String(new_text);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // 替换 title
        if let Some(title) = spec.get("title").and_then(|v| v.as_str()).map(|s| s.to_string()) {
            let mut new_title = title.clone();
            for (find, replace) in &replacements {
                let count = new_title.matches(find.as_str()).count();
                if count > 0 {
                    new_title = new_title.replace(find.as_str(), replace.as_str());
                    total_replacements += count;
                }
            }
            if new_title != title {
                spec["title"] = serde_json::Value::String(new_title);
            }
        }

        let new_bytes = Self::generate_docx_from_spec(&spec)?;
        Ok((new_bytes, total_replacements))
    }

    /// ★ 从 JSON spec 生成 DOCX 文件（docx-rs 写入 API）
    ///
    /// spec 格式：
    /// ```json
    /// {
    ///   "title": "文档标题",
    ///   "blocks": [
    ///     { "type": "heading", "level": 1, "text": "标题" },
    ///     { "type": "paragraph", "text": "正文", "bold": false, "italic": false },
    ///     { "type": "table", "rows": [["A1","B1"],["A2","B2"]] },
    ///     { "type": "list", "ordered": true, "items": ["项1","项2"] },
    ///     { "type": "code", "text": "代码块" },
    ///     { "type": "pagebreak" }
    ///   ]
    /// }
    /// ```
    pub fn generate_docx_from_spec(spec: &serde_json::Value) -> Result<Vec<u8>, ParsingError> {
        let mut docx = docx_rs::Docx::new();

        // 设置文档标题
        if let Some(title) = spec.get("title").and_then(|v| v.as_str()) {
            docx = docx.add_paragraph(
                docx_rs::Paragraph::new()
                    .add_run(
                        docx_rs::Run::new()
                            .add_text(title)
                            .bold()
                            .size(48) // 24pt = 48 half-points
                    )
                    .style("Heading1"),
            );
        }

        let blocks = spec
            .get("blocks")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        for block in &blocks {
            let block_type = block.get("type").and_then(|v| v.as_str()).unwrap_or("");

            match block_type {
                "heading" => {
                    let level = block
                        .get("level")
                        .and_then(|v| v.as_u64())
                        .unwrap_or(1) as usize;
                    let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let style_name = format!("Heading{}", level.min(6));
                    let font_size = match level {
                        1 => 48, // 24pt
                        2 => 36, // 18pt
                        3 => 32, // 16pt
                        4 => 28, // 14pt
                        _ => 24, // 12pt
                    };
                    docx = docx.add_paragraph(
                        docx_rs::Paragraph::new()
                            .add_run(
                                docx_rs::Run::new()
                                    .add_text(text)
                                    .bold()
                                    .size(font_size),
                            )
                            .style(&style_name),
                    );
                }
                "paragraph" => {
                    let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    let is_bold = block
                        .get("bold")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let is_italic = block
                        .get("italic")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let alignment = block.get("alignment").and_then(|v| v.as_str());

                    let mut run = docx_rs::Run::new().add_text(text).size(24); // 12pt
                    if is_bold {
                        run = run.bold();
                    }
                    if is_italic {
                        run = run.italic();
                    }

                    let mut para = docx_rs::Paragraph::new().add_run(run);
                    if let Some(align) = alignment {
                        para = para.align(match align {
                            "center" => docx_rs::AlignmentType::Center,
                            "right" => docx_rs::AlignmentType::Right,
                            "both" | "justify" => docx_rs::AlignmentType::Both,
                            _ => docx_rs::AlignmentType::Left,
                        });
                    }

                    docx = docx.add_paragraph(para);
                }
                "table" => {
                    let rows_data = block
                        .get("rows")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();

                    let mut table_rows = Vec::new();
                    for row_data in &rows_data {
                        let cells_data = row_data.as_array().cloned().unwrap_or_default();
                        let mut cells = Vec::new();
                        for cell_data in &cells_data {
                            let cell_text = cell_data.as_str().unwrap_or("");
                            let cell = docx_rs::TableCell::new().add_paragraph(
                                docx_rs::Paragraph::new()
                                    .add_run(docx_rs::Run::new().add_text(cell_text).size(24)),
                            );
                            cells.push(cell);
                        }
                        table_rows.push(docx_rs::TableRow::new(cells));
                    }

                    let table = docx_rs::Table::new(table_rows);
                    docx = docx.add_table(table);
                }
                "list" => {
                    let ordered = block
                        .get("ordered")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false);
                    let items = block
                        .get("items")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();

                    for (i, item) in items.iter().enumerate() {
                        let text = item.as_str().unwrap_or("");
                        let prefix = if ordered {
                            format!("{}. ", i + 1)
                        } else {
                            "• ".to_string()
                        };
                        docx = docx.add_paragraph(
                            docx_rs::Paragraph::new().add_run(
                                docx_rs::Run::new()
                                    .add_text(&format!("{}{}", prefix, text))
                                    .size(24),
                            ),
                        );
                    }
                }
                "code" => {
                    let text = block.get("text").and_then(|v| v.as_str()).unwrap_or("");
                    docx = docx.add_paragraph(
                        docx_rs::Paragraph::new()
                            .add_run(
                                docx_rs::Run::new()
                                    .add_text(text)
                                    .size(20) // 10pt
                                    .fonts(docx_rs::RunFonts::new().ascii("Courier New")),
                            ),
                    );
                }
                "pagebreak" => {
                    docx = docx.add_paragraph(
                        docx_rs::Paragraph::new().add_run(
                            docx_rs::Run::new().add_break(docx_rs::BreakType::Page),
                        ),
                    );
                }
                _ => {
                    // 未知类型，当段落处理
                    if let Some(text) = block.get("text").and_then(|v| v.as_str()) {
                        docx = docx.add_paragraph(
                            docx_rs::Paragraph::new()
                                .add_run(docx_rs::Run::new().add_text(text).size(24)),
                        );
                    }
                }
            }
        }

        // 序列化为 DOCX 字节
        let mut buf = Cursor::new(Vec::new());
        docx.build()
            .pack(&mut buf)
            .map_err(|e| ParsingError::DocxParsingError(format!("DOCX 生成失败: {}", e)))?;

        Ok(buf.into_inner())
    }

    /// 从PDF文件路径提取文本（使用 pdfium 引擎，直接从路径加载，避免大文件内存压力）
    fn extract_pdf_from_path(&self, file_path: &str) -> Result<String, ParsingError> {
        // 先检查文件大小
        let metadata = fs::metadata(file_path)?;
        let file_size = metadata.len() as usize;
        self.check_file_size(file_size)?;

        // ★ M-1 修复：加密文档检测
        self.check_pdf_encryption_from_path(file_path)?;

        // 使用全局 pdfium 单例 + 从文件路径直接加载（不读入内存）
        let pdfium =
            crate::pdfium_utils::load_pdfium().map_err(|e| ParsingError::PdfParsingError(e))?;

        let text = crate::pdfium_utils::extract_text_from_pdf_file(
            pdfium,
            std::path::Path::new(file_path),
        )
        .map_err(|e| ParsingError::PdfParsingError(e))?;

        Ok(text.trim().to_string())
    }

    /// 从PDF字节流提取文本（使用 pdfium 引擎）
    ///
    /// 替代原 pdf-extract 实现：
    /// - 中文/CJK 字体编码支持完整（pdf-extract 遇到非 Identity-H 编码会 panic）
    /// - 基于 Google Chromium PDFium 引擎，兼容性好
    /// - 全平台一致行为（Windows/macOS/Linux/Android）
    fn extract_pdf_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        // ★ M-1 修复：加密文档检测
        self.check_pdf_encryption(&bytes, "document.pdf")?;

        // 使用全局 pdfium 单例
        let pdfium =
            crate::pdfium_utils::load_pdfium().map_err(|e| ParsingError::PdfParsingError(e))?;

        let text = crate::pdfium_utils::extract_text_from_pdf_bytes(pdfium, &bytes)
            .map_err(|e| ParsingError::PdfParsingError(e))?;

        Ok(text.trim().to_string())
    }

    /// 从TXT文件路径提取文本
    fn extract_txt_from_path(&self, file_path: &str) -> Result<String, ParsingError> {
        let bytes = self.read_file_safely(file_path)?;
        self.extract_txt_from_bytes(bytes)
    }

    /// 从TXT字节流提取文本
    fn extract_txt_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        // 尝试UTF-8解码，先不消费bytes
        match std::str::from_utf8(&bytes) {
            Ok(text) => Ok(text.trim().to_string()),
            Err(_) => {
                // 如果UTF-8失败，使用lossy转换
                let text = String::from_utf8_lossy(&bytes);
                Ok(text.trim().to_string())
            }
        }
    }

    /// 从MD文件路径提取文本
    fn extract_md_from_path(&self, file_path: &str) -> Result<String, ParsingError> {
        let bytes = self.read_file_safely(file_path)?;
        self.extract_md_from_bytes(bytes)
    }

    /// 从MD字节流提取文本
    fn extract_md_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        // Markdown文件本质上也是文本文件，使用相同的处理方式
        // 未来可以考虑解析Markdown语法，但目前保持简单
        self.extract_txt_from_bytes(bytes)
    }

    /// 从HTML文件路径提取文本
    fn extract_html_from_path(&self, file_path: &str) -> Result<String, ParsingError> {
        let bytes = self.read_file_safely(file_path)?;
        self.extract_html_from_bytes(bytes)
    }

    /// 从HTML字节流提取文本
    fn extract_html_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        // 优先尝试按UTF-8解码，失败则使用损耗式转换
        let html_string = match String::from_utf8(bytes.clone()) {
            Ok(html) => html,
            Err(err) => {
                let fallback = err.into_bytes();
                String::from_utf8_lossy(&fallback).into_owned()
            }
        };
        let rendered = from_read(html_string.as_bytes(), 80)
            .map_err(|e| ParsingError::Other(format!("HTML 转文本失败: {}", e)))?;
        Ok(rendered.trim().to_string())
    }

    /// 从Excel文件路径提取文本（支持xlsx/xls/xlsb/ods）
    fn extract_excel_from_path(&self, file_path: &str) -> Result<String, ParsingError> {
        // 先检查文件大小
        let metadata = fs::metadata(file_path)?;
        let file_size = metadata.len() as usize;
        self.check_file_size(file_size)?;

        let ext = std::path::Path::new(file_path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // xlsx/xlsb/ods 是 ZIP 格式，需要加密和 ZIP Bomb 检测
        if ext == "xlsx" || ext == "xlsb" || ext == "ods" {
            let bytes = self.read_file_safely(file_path)?;
            let file_name = std::path::Path::new(file_path)
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or(file_path);

            // ★ M-1 修复：加密文档检测
            self.check_office_encryption(&bytes, file_name)?;
            // ★ M-11 修复：ZIP Bomb 检测
            self.check_zip_bomb(&bytes, file_name)?;
        }

        // 使用 calamine 自动检测格式并打开
        let mut workbook = open_workbook_auto(file_path)
            .map_err(|e| ParsingError::ExcelParsingError(format!("无法打开Excel文件: {}", e)))?;

        self.extract_excel_text(&mut workbook)
    }

    /// 从Excel字节流提取文本
    fn extract_excel_from_bytes(
        &self,
        file_name: &str,
        bytes: Vec<u8>,
    ) -> Result<String, ParsingError> {
        let ext = std::path::Path::new(file_name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        // xlsx/xlsb/ods 是 ZIP 格式，需要加密和 ZIP Bomb 检测
        if ext == "xlsx" || ext == "xlsb" || ext == "ods" {
            // ★ M-1 修复：加密文档检测
            self.check_office_encryption(&bytes, file_name)?;
            // ★ M-11 修复：ZIP Bomb 检测
            self.check_zip_bomb(&bytes, file_name)?;
        }

        // 使用 Cursor 包装字节流
        let cursor = Cursor::new(bytes);

        // 使用 calamine 从内存读取
        let mut workbook = open_workbook_auto_from_rs(cursor)
            .map_err(|e| ParsingError::ExcelParsingError(format!("无法解析Excel数据: {}", e)))?;

        self.extract_excel_text(&mut workbook)
    }

    /// 从工作簿提取所有工作表的文本内容
    fn extract_excel_text<RS>(&self, workbook: &mut Sheets<RS>) -> Result<String, ParsingError>
    where
        RS: std::io::Read + std::io::Seek,
    {
        let mut text_content = String::with_capacity(8192);
        let sheet_names = workbook.sheet_names().to_vec();

        for (idx, sheet_name) in sheet_names.iter().enumerate() {
            // 添加工作表名称作为标题
            if idx > 0 {
                text_content.push_str("\n\n");
            }
            text_content.push_str(&format!("=== {} ===\n", sheet_name));

            // 获取工作表范围
            if let Ok(range) = workbook.worksheet_range(sheet_name) {
                for row in range.rows() {
                    let row_text: Vec<String> =
                        row.iter().map(|cell| self.data_to_string(cell)).collect();

                    // 只添加非空行
                    let line = row_text.join("\t");
                    if !line.trim().is_empty() {
                        text_content.push_str(&line);
                        text_content.push('\n');
                    }
                }
            }
        }

        Ok(text_content.trim().to_string())
    }

    /// 将单元格数据转换为字符串
    fn data_to_string(&self, cell: &Data) -> String {
        match cell {
            Data::Empty => String::new(),
            Data::String(s) => s.clone(),
            Data::Int(i) => i.to_string(),
            Data::Float(f) => {
                // 避免浮点数精度问题，如果是整数则不显示小数点
                if f.fract() == 0.0 {
                    format!("{:.0}", f)
                } else {
                    f.to_string()
                }
            }
            Data::Bool(b) => b.to_string(),
            Data::DateTime(dt) => {
                // Excel日期时间格式转换
                format!("{:.6}", dt)
            }
            Data::DateTimeIso(s) => s.clone(),
            Data::DurationIso(s) => s.clone(),
            Data::Error(e) => format!("#ERR:{:?}", e),
        }
    }

    // ========================================================================
    // PPTX 解析（纯 Rust，使用 pptx-to-md）
    // ========================================================================

    /// 从PPTX文件路径提取文本（Markdown格式）
    fn extract_pptx_from_path(&self, file_path: &str) -> Result<String, ParsingError> {
        // 检查文件大小
        let metadata = fs::metadata(file_path)?;
        let file_size = metadata.len() as usize;
        self.check_file_size(file_size)?;

        let bytes = self.read_file_safely(file_path)?;
        let file_name = std::path::Path::new(file_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(file_path);

        // ★ M-1 修复：加密文档检测
        self.check_office_encryption(&bytes, file_name)?;
        // ★ M-11 修复：ZIP Bomb 检测
        self.check_zip_bomb(&bytes, file_name)?;

        // 使用 pptx-to-md 解析（只支持从路径打开）
        let config = ParserConfig::builder()
            .extract_images(false) // 不提取图片，只要文本
            .build();

        let mut container = PptxContainer::open(Path::new(file_path), config)
            .map_err(|e| ParsingError::PptxParsingError(format!("无法打开PPTX: {:?}", e)))?;

        // 解析所有幻灯片
        let slides = container
            .parse_all()
            .map_err(|e| ParsingError::PptxParsingError(format!("解析PPTX失败: {:?}", e)))?;

        // 转换为 Markdown
        let mut markdown = String::with_capacity(8192);
        for slide in slides {
            if let Some(md_content) = slide.convert_to_md() {
                markdown.push_str(&md_content);
                markdown.push_str("\n\n");
            }
        }

        Ok(markdown.trim().to_string())
    }

    /// 从PPTX字节流提取文本（Markdown格式）
    fn extract_pptx_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        // 检查文件大小
        self.check_file_size(bytes.len())?;

        // ★ M-1 修复：加密文档检测
        self.check_office_encryption(&bytes, "presentation.pptx")?;
        // ★ M-11 修复：ZIP Bomb 检测
        self.check_zip_bomb(&bytes, "presentation.pptx")?;

        // pptx-to-md 只支持从路径打开，需要写入临时文件
        let temp_file = tempfile::Builder::new()
            .suffix(".pptx")
            .tempfile()
            .map_err(|e| ParsingError::IoError(format!("创建临时文件失败: {}", e)))?;

        fs::write(temp_file.path(), &bytes)?;

        // 由于已经检查过 ZIP Bomb 和加密，这里调用内部方法跳过重复检查
        self.extract_pptx_from_path_internal(temp_file.path().to_str().unwrap_or(""))
    }

    /// 从PPTX文件路径提取文本（内部实现，跳过 ZIP Bomb 检测）
    fn extract_pptx_from_path_internal(&self, file_path: &str) -> Result<String, ParsingError> {
        // 使用 pptx-to-md 解析
        let config = ParserConfig::builder().extract_images(false).build();

        let mut container = PptxContainer::open(Path::new(file_path), config)
            .map_err(|e| ParsingError::PptxParsingError(format!("无法打开PPTX: {:?}", e)))?;

        let slides = container
            .parse_all()
            .map_err(|e| ParsingError::PptxParsingError(format!("解析PPTX失败: {:?}", e)))?;

        let mut markdown = String::with_capacity(8192);
        for slide in slides {
            if let Some(md_content) = slide.convert_to_md() {
                markdown.push_str(&md_content);
                markdown.push_str("\n\n");
            }
        }

        Ok(markdown.trim().to_string())
    }

    // ========================================================================
    // PPTX 写入/编辑（使用 ppt-rs）
    // ========================================================================

    /// 从 JSON spec 生成 PPTX 文件
    ///
    /// spec 格式：
    /// ```json
    /// {
    ///   "title": "演示文稿标题",
    ///   "theme": "corporate",
    ///   "slides": [
    ///     { "type": "title", "title": "标题", "subtitle": "副标题" },
    ///     { "type": "content", "title": "内容页标题", "bullets": ["要点1","要点2"] },
    ///     { "type": "table", "title": "表格页", "headers": ["列1","列2"], "rows": [["a","b"],["c","d"]] },
    ///     { "type": "blank", "title": "自由页" }
    ///   ]
    /// }
    /// ```
    pub fn generate_pptx_from_spec(spec: &serde_json::Value) -> Result<Vec<u8>, ParsingError> {
        use ppt_rs::generator::{
            create_pptx_with_content, SlideContent, TableBuilder,
        };

        let title = spec
            .get("title")
            .and_then(|v| v.as_str())
            .unwrap_or("Presentation");

        let slides_data = spec
            .get("slides")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut slides: Vec<SlideContent> = Vec::new();

        for slide_data in &slides_data {
            let slide_type = slide_data
                .get("type")
                .and_then(|v| v.as_str())
                .unwrap_or("content");
            let slide_title = slide_data
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("");

            match slide_type {
                "title" => {
                    let subtitle = slide_data
                        .get("subtitle")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let mut sc = SlideContent::new(slide_title);
                    if !subtitle.is_empty() {
                        sc = sc.add_bullet(subtitle);
                    }
                    slides.push(sc);
                }
                "content" => {
                    let bullets = slide_data
                        .get("bullets")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let mut sc = SlideContent::new(slide_title);
                    for bullet in &bullets {
                        if let Some(text) = bullet.as_str() {
                            sc = sc.add_bullet(text);
                        }
                    }
                    slides.push(sc);
                }
                "table" => {
                    let headers = slide_data
                        .get("headers")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();
                    let rows = slide_data
                        .get("rows")
                        .and_then(|v| v.as_array())
                        .cloned()
                        .unwrap_or_default();

                    // 计算列数和列宽
                    let col_count = headers.len().max(
                        rows.first()
                            .and_then(|r| r.as_array())
                            .map(|a| a.len())
                            .unwrap_or(0),
                    )
                    .max(1);
                    let col_width = 8000000u32 / col_count as u32; // 平分幻灯片宽度
                    let col_widths: Vec<u32> = vec![col_width; col_count];

                    let mut tb = TableBuilder::new(col_widths);

                    // 添加表头行
                    if !headers.is_empty() {
                        let header_strs: Vec<&str> = headers
                            .iter()
                            .map(|h| h.as_str().unwrap_or(""))
                            .collect();
                        tb = tb.add_simple_row(header_strs);
                    }

                    // 添加数据行
                    for row in &rows {
                        if let Some(cells) = row.as_array() {
                            let cell_strs: Vec<&str> = cells
                                .iter()
                                .map(|c| c.as_str().unwrap_or(""))
                                .collect();
                            tb = tb.add_simple_row(cell_strs);
                        }
                    }

                    let table = tb.build();
                    let sc = SlideContent::new(slide_title).table(table);
                    slides.push(sc);
                }
                // "blank" or unknown → 空白幻灯片
                _ => {
                    slides.push(SlideContent::new(slide_title));
                }
            }
        }

        // 如果没有任何幻灯片，添加一张标题页
        if slides.is_empty() {
            slides.push(SlideContent::new(title));
        }

        let pptx_bytes = create_pptx_with_content(title, slides)
            .map_err(|e| ParsingError::PptxParsingError(format!("PPTX 生成失败: {}", e)))?;

        Ok(pptx_bytes)
    }

    /// 从 PPTX 字节提取结构化 JSON spec（用于 round-trip 编辑）
    ///
    /// 读取现有 PPTX → 提取幻灯片结构 → 输出 JSON spec
    /// LLM 可修改 spec 后使用 generate_pptx_from_spec 重新生成
    ///
    /// ★ GAP-5 修复：正确检测 subtitle / table / title 类型幻灯片
    pub fn extract_pptx_as_spec(&self, bytes: &[u8]) -> Result<serde_json::Value, ParsingError> {
        let markdown = self.extract_pptx_from_bytes(bytes.to_vec())?;

        // 按幻灯片分割：每遇到 # 或 ## 开头表示新幻灯片
        let mut slides: Vec<serde_json::Value> = Vec::new();
        let mut current_title = String::new();
        let mut current_bullets: Vec<String> = Vec::new();
        let mut current_table_headers: Vec<String> = Vec::new();
        let mut current_table_rows: Vec<Vec<String>> = Vec::new();
        let mut in_table = false;

        let flush_slide = |title: &str,
                           bullets: &[String],
                           table_headers: &[String],
                           table_rows: &[Vec<String>],
                           slides: &mut Vec<serde_json::Value>| {
            if title.is_empty() && bullets.is_empty() && table_headers.is_empty() {
                return;
            }

            let has_table = !table_headers.is_empty() || !table_rows.is_empty();
            let has_bullets = !bullets.is_empty();

            if has_table && has_bullets {
                // ★ 同一幻灯片同时有文本要点和表格 → 拆为两张：content + table
                slides.push(serde_json::json!({
                    "type": "content",
                    "title": title,
                    "bullets": bullets,
                }));
                slides.push(serde_json::json!({
                    "type": "table",
                    "title": format!("{} - 表格", title),
                    "headers": table_headers,
                    "rows": table_rows,
                }));
            } else if has_table {
                slides.push(serde_json::json!({
                    "type": "table",
                    "title": title,
                    "headers": table_headers,
                    "rows": table_rows,
                }));
            } else if !has_bullets {
                // 无要点 → blank 页
                slides.push(serde_json::json!({
                    "type": "blank",
                    "title": title,
                }));
            } else if slides.is_empty() && bullets.len() == 1 {
                // 第一张幻灯片且只有一行文字 → 视为 title 页（title + subtitle）
                slides.push(serde_json::json!({
                    "type": "title",
                    "title": title,
                    "subtitle": bullets[0],
                }));
            } else {
                slides.push(serde_json::json!({
                    "type": "content",
                    "title": title,
                    "bullets": bullets,
                }));
            }
        };

        for line in markdown.lines() {
            let trimmed = line.trim();

            // 检测 Markdown 表格行（| col1 | col2 |）
            // ★ 安全守卫：至少需要 "| x |"（5 字符），避免 "|" 或 "||" 导致切片越界
            if trimmed.len() >= 5 && trimmed.starts_with('|') && trimmed.ends_with('|') {
                let inner = &trimmed[1..trimmed.len() - 1];
                // 跳过分隔行（|---|---|）
                let is_separator = inner.chars().all(|c| c == '-' || c == '|' || c == ':' || c == ' ');
                if is_separator {
                    continue;
                }

                let cells: Vec<String> = inner
                    .split('|')
                    .map(|c| c.trim().to_string())
                    .collect();

                if !in_table {
                    // 首次遇到表格行 → 作为表头
                    in_table = true;
                    current_table_headers = cells;
                } else {
                    current_table_rows.push(cells);
                }
                continue;
            }

            // 非表格行时，如果之前在表格中，保持表格状态（后续 flush 处理）
            if in_table && !trimmed.is_empty() && !trimmed.starts_with('#') {
                // 表格后的非标题非空行，视为当前幻灯片的 bullet
                in_table = false;
            }

            if trimmed.is_empty() {
                continue;
            }

            if trimmed.starts_with("# ") || trimmed.starts_with("## ") {
                // 保存前一张幻灯片
                flush_slide(
                    &current_title,
                    &current_bullets,
                    &current_table_headers,
                    &current_table_rows,
                    &mut slides,
                );
                current_title = trimmed.trim_start_matches('#').trim().to_string();
                current_bullets = Vec::new();
                current_table_headers = Vec::new();
                current_table_rows = Vec::new();
                in_table = false;
            } else if trimmed.starts_with("- ")
                || trimmed.starts_with("* ")
                || trimmed.starts_with("• ")
            {
                let bullet_text = trimmed
                    .trim_start_matches("- ")
                    .trim_start_matches("* ")
                    .trim_start_matches("• ")
                    .to_string();
                current_bullets.push(bullet_text);
            } else if !in_table {
                current_bullets.push(trimmed.to_string());
            }
        }

        // 保存最后一张幻灯片
        flush_slide(
            &current_title,
            &current_bullets,
            &current_table_headers,
            &current_table_rows,
            &mut slides,
        );

        Ok(serde_json::json!({
            "title": slides.first()
                .and_then(|s| s.get("title"))
                .and_then(|t| t.as_str())
                .unwrap_or("Presentation"),
            "slides": slides,
        }))
    }

    /// ★ GAP-1 修复：精确获取 PPTX 元数据（幻灯片数量通过 pptx-to-md parse_all 精确计数）
    pub fn extract_pptx_metadata(&self, bytes: &[u8]) -> Result<serde_json::Value, ParsingError> {
        self.check_file_size(bytes.len())?;
        self.check_office_encryption(bytes, "presentation.pptx")?;
        self.check_zip_bomb(bytes, "presentation.pptx")?;

        let temp_file = tempfile::Builder::new()
            .suffix(".pptx")
            .tempfile()
            .map_err(|e| ParsingError::IoError(format!("创建临时文件失败: {}", e)))?;
        fs::write(temp_file.path(), bytes)?;

        let config = ParserConfig::builder().extract_images(false).build();
        let mut container = PptxContainer::open(temp_file.path(), config)
            .map_err(|e| ParsingError::PptxParsingError(format!("无法打开PPTX: {:?}", e)))?;

        let slides = container
            .parse_all()
            .map_err(|e| ParsingError::PptxParsingError(format!("解析PPTX失败: {:?}", e)))?;

        let slide_count = slides.len();
        let mut total_text_len = 0usize;
        for slide in &slides {
            if let Some(md) = slide.convert_to_md() {
                total_text_len += md.len();
            }
        }

        Ok(serde_json::json!({
            "slide_count": slide_count,
            "total_text_length": total_text_len,
            "format": "pptx",
        }))
    }

    /// ★ GAP-3 修复：从 PPTX 中提取所有表格为结构化 JSON
    pub fn extract_pptx_tables(&self, bytes: &[u8]) -> Result<Vec<serde_json::Value>, ParsingError> {
        let markdown = self.extract_pptx_from_bytes(bytes.to_vec())?;

        let mut tables: Vec<serde_json::Value> = Vec::new();
        let mut current_slide_title = String::new();
        let mut current_headers: Vec<String> = Vec::new();
        let mut current_rows: Vec<Vec<String>> = Vec::new();
        let mut in_table = false;

        let flush_table = |title: &str,
                           headers: &[String],
                           rows: &[Vec<String>],
                           tables: &mut Vec<serde_json::Value>| {
            if headers.is_empty() && rows.is_empty() {
                return;
            }
            tables.push(serde_json::json!({
                "slide_title": title,
                "headers": headers,
                "rows": rows,
                "row_count": rows.len(),
                "col_count": headers.len().max(rows.first().map(|r| r.len()).unwrap_or(0)),
            }));
        };

        for line in markdown.lines() {
            let trimmed = line.trim();

            if trimmed.starts_with("# ") || trimmed.starts_with("## ") {
                // 新幻灯片 → 保存之前的表格
                flush_table(&current_slide_title, &current_headers, &current_rows, &mut tables);
                current_slide_title = trimmed.trim_start_matches('#').trim().to_string();
                current_headers = Vec::new();
                current_rows = Vec::new();
                in_table = false;
            } else if trimmed.len() >= 5 && trimmed.starts_with('|') && trimmed.ends_with('|') {
                let inner = &trimmed[1..trimmed.len() - 1];
                let is_separator = inner.chars().all(|c| c == '-' || c == '|' || c == ':' || c == ' ');
                if is_separator {
                    continue;
                }
                let cells: Vec<String> = inner.split('|').map(|c| c.trim().to_string()).collect();
                if !in_table {
                    in_table = true;
                    current_headers = cells;
                } else {
                    current_rows.push(cells);
                }
            } else if in_table && (trimmed.is_empty() || !trimmed.starts_with('|')) {
                // 表格结束
                flush_table(&current_slide_title, &current_headers, &current_rows, &mut tables);
                current_headers = Vec::new();
                current_rows = Vec::new();
                in_table = false;
            }
        }

        // 保存最后一个表格
        flush_table(&current_slide_title, &current_headers, &current_rows, &mut tables);

        Ok(tables)
    }

    // ========================================================================
    // XLSX 写入/编辑（使用 umya-spreadsheet）
    // ========================================================================

    /// 从 JSON spec 生成 XLSX 文件
    ///
    /// spec 格式：
    /// ```json
    /// {
    ///   "sheets": [
    ///     {
    ///       "name": "Sheet1",
    ///       "headers": ["姓名", "年龄", "城市"],
    ///       "rows": [
    ///         ["张三", "25", "北京"],
    ///         ["李四", "30", "上海"]
    ///       ]
    ///     }
    ///   ]
    /// }
    /// ```
    pub fn generate_xlsx_from_spec(spec: &serde_json::Value) -> Result<Vec<u8>, ParsingError> {
        let mut book = umya_spreadsheet::new_file();

        let sheets_data = spec
            .get("sheets")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        // 如果没有 sheets，尝试顶层 headers/rows（单工作表简写）
        let sheets_to_process = if sheets_data.is_empty() {
            vec![spec.clone()]
        } else {
            sheets_data
        };

        for (sheet_idx, sheet_data) in sheets_to_process.iter().enumerate() {
            let sheet_name = sheet_data
                .get("name")
                .and_then(|v| v.as_str())
                .unwrap_or(if sheet_idx == 0 { "Sheet1" } else { "" });

            // 获取或创建工作表
            let sheet = if sheet_idx == 0 {
                // 第一个工作表：重命名默认的 Sheet1
                let ws = book.get_sheet_mut(&0)
                    .ok_or_else(|| ParsingError::ExcelParsingError("默认工作表不存在".to_string()))?;
                ws.set_name(sheet_name);
                ws
            } else {
                let name = if sheet_name.is_empty() {
                    format!("Sheet{}", sheet_idx + 1)
                } else {
                    sheet_name.to_string()
                };
                book.new_sheet(&name)
                    .map_err(|e| ParsingError::ExcelParsingError(format!("创建工作表失败: {}", e)))?
            };

            let mut row_num: u32 = 1;

            // 写入表头
            if let Some(headers) = sheet_data.get("headers").and_then(|v| v.as_array()) {
                for (col_idx, header) in headers.iter().enumerate() {
                    let cell_text = header.as_str().unwrap_or("");
                    let cell = sheet.get_cell_mut(((col_idx as u32) + 1, row_num));
                    cell.set_value(cell_text);
                    // 表头加粗
                    cell.get_style_mut().get_font_mut().set_bold(true);
                }
                row_num += 1;
            }

            // 写入数据行
            if let Some(rows) = sheet_data.get("rows").and_then(|v| v.as_array()) {
                for row_data in rows {
                    if let Some(cells) = row_data.as_array() {
                        for (col_idx, cell_val) in cells.iter().enumerate() {
                            let fallback = cell_val.to_string().trim_matches('"').to_string();
                            let cell_text = cell_val.as_str().unwrap_or(&fallback);
                            let cell = sheet.get_cell_mut(((col_idx as u32) + 1, row_num));
                            // 尝试作为数字写入
                            if let Ok(num) = cell_text.parse::<f64>() {
                                cell.set_value_number(num);
                            } else {
                                cell.set_value(cell_text);
                            }
                        }
                    }
                    row_num += 1;
                }
            }
        }

        // 序列化为 XLSX 字节
        let mut buf = Cursor::new(Vec::new());
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut buf)
            .map_err(|e| ParsingError::ExcelParsingError(format!("XLSX 生成失败: {}", e)))?;

        Ok(buf.into_inner())
    }

    /// 从 XLSX 字节提取结构化 JSON spec（用于 round-trip 编辑）
    pub fn extract_xlsx_as_spec(&self, bytes: &[u8]) -> Result<serde_json::Value, ParsingError> {
        let cursor = Cursor::new(bytes.to_vec());
        let book = umya_spreadsheet::reader::xlsx::read_reader(cursor, true)
            .map_err(|e| ParsingError::ExcelParsingError(format!("XLSX 读取失败: {}", e)))?;

        let mut sheets_json = Vec::new();

        for sheet in book.get_sheet_collection() {
            let ws_name = sheet.get_name().to_string();

            let (max_col, max_row) = sheet.get_highest_column_and_row();
            if max_row == 0 || max_col == 0 {
                sheets_json.push(serde_json::json!({
                    "name": ws_name,
                    "headers": [],
                    "rows": [],
                }));
                continue;
            }

            // 第一行作为表头
            let mut headers = Vec::new();
            for col in 1..=max_col {
                let val = sheet
                    .get_cell((col, 1))
                    .map(|c| c.get_value().to_string())
                    .unwrap_or_default();
                headers.push(val);
            }

            // 其余行作为数据
            let mut rows = Vec::new();
            for row in 2..=max_row {
                let mut row_data = Vec::new();
                for col in 1..=max_col {
                    let val = sheet
                        .get_cell((col, row))
                        .map(|c| c.get_value().to_string())
                        .unwrap_or_default();
                    row_data.push(val);
                }
                rows.push(row_data);
            }

            sheets_json.push(serde_json::json!({
                "name": ws_name,
                "headers": headers,
                "rows": rows,
            }));
        }

        Ok(serde_json::json!({
            "sheets": sheets_json,
        }))
    }

    /// 在 XLSX 中编辑指定单元格，保存为新文件
    ///
    /// edits 格式：[{sheet: "Sheet1", cell: "A1", value: "新值"}, ...]
    pub fn edit_xlsx_cells(
        &self,
        bytes: &[u8],
        edits: &[(String, String, String)], // (sheet_name, cell_ref, value)
    ) -> Result<(Vec<u8>, usize), ParsingError> {
        let cursor = Cursor::new(bytes.to_vec());
        let mut book = umya_spreadsheet::reader::xlsx::read_reader(cursor, true)
            .map_err(|e| ParsingError::ExcelParsingError(format!("XLSX 读取失败: {}", e)))?;

        let mut edit_count = 0usize;

        for (sheet_name, cell_ref, value) in edits {
            let Some(ws) = book.get_sheet_by_name_mut(sheet_name) else {
                log::warn!("[DocumentParser] XLSX 编辑：工作表 '{}' 不存在，跳过", sheet_name);
                continue;
            };
            let cell = ws.get_cell_mut(cell_ref.as_str());
            // 尝试作为数字写入
            if let Ok(num) = value.parse::<f64>() {
                cell.set_value_number(num);
            } else {
                cell.set_value(value.as_str());
            }
            edit_count += 1;
        }

        // 序列化为新 XLSX
        let mut buf = Cursor::new(Vec::new());
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut buf)
            .map_err(|e| ParsingError::ExcelParsingError(format!("XLSX 保存失败: {}", e)))?;

        Ok((buf.into_inner(), edit_count))
    }

    /// 在 XLSX 中执行文本查找替换
    pub fn replace_text_in_xlsx(
        &self,
        bytes: &[u8],
        replacements: &[(String, String)],
    ) -> Result<(Vec<u8>, usize), ParsingError> {
        let cursor = Cursor::new(bytes.to_vec());
        let mut book = umya_spreadsheet::reader::xlsx::read_reader(cursor, true)
            .map_err(|e| ParsingError::ExcelParsingError(format!("XLSX 读取失败: {}", e)))?;

        let mut total_count = 0usize;

        // 收集工作表名称
        let sheet_names: Vec<String> = book
            .get_sheet_collection()
            .iter()
            .map(|ws| ws.get_name().to_string())
            .collect();

        for sheet_name in &sheet_names {
            let Some(ws) = book.get_sheet_by_name_mut(sheet_name) else {
                continue;
            };
            let (max_col, max_row) = ws.get_highest_column_and_row();

            for row in 1..=max_row {
                for col in 1..=max_col {
                    if let Some(cell) = ws.get_cell((col, row)) {
                        let old_val = cell.get_value().to_string();
                        let mut new_val = old_val.clone();
                        for (find, replace) in replacements {
                            if new_val.contains(find.as_str()) {
                                new_val = new_val.replace(find.as_str(), replace.as_str());
                            }
                        }
                        if new_val != old_val {
                            let cell_mut = ws.get_cell_mut((col, row));
                            cell_mut.set_value(new_val.as_str());
                            total_count += 1;
                        }
                    }
                }
            }
        }

        // 序列化
        let mut buf = Cursor::new(Vec::new());
        umya_spreadsheet::writer::xlsx::write_writer(&book, &mut buf)
            .map_err(|e| ParsingError::ExcelParsingError(format!("XLSX 保存失败: {}", e)))?;

        Ok((buf.into_inner(), total_count))
    }

    /// 从 XLSX 字节提取所有工作表的结构化表格数据
    pub fn extract_xlsx_tables(
        &self,
        bytes: &[u8],
    ) -> Result<Vec<serde_json::Value>, ParsingError> {
        let cursor = Cursor::new(bytes.to_vec());
        let book = umya_spreadsheet::reader::xlsx::read_reader(cursor, true)
            .map_err(|e| ParsingError::ExcelParsingError(format!("XLSX 读取失败: {}", e)))?;

        let mut tables = Vec::new();

        for sheet in book.get_sheet_collection() {
            let ws_name = sheet.get_name().to_string();
            let (max_col, max_row) = sheet.get_highest_column_and_row();
            if max_row == 0 || max_col == 0 {
                continue;
            }

            let mut rows_data = Vec::new();
            for row in 1..=max_row {
                let mut row_data = Vec::new();
                for col in 1..=max_col {
                    let val = sheet
                        .get_cell((col, row))
                        .map(|c| c.get_value().to_string())
                        .unwrap_or_default();
                    row_data.push(val);
                }
                rows_data.push(row_data);
            }

            tables.push(serde_json::json!({
                "sheet_name": ws_name,
                "row_count": max_row,
                "col_count": max_col,
                "rows": rows_data,
            }));
        }

        Ok(tables)
    }

    /// ★ GAP-4 修复：提取 XLSX 文件元数据（工作表数量/名称/行列数）
    pub fn extract_xlsx_metadata(&self, bytes: &[u8]) -> Result<serde_json::Value, ParsingError> {
        let cursor = Cursor::new(bytes.to_vec());
        let book = umya_spreadsheet::reader::xlsx::read_reader(cursor, true)
            .map_err(|e| ParsingError::ExcelParsingError(format!("XLSX 读取失败: {}", e)))?;

        let sheets = book.get_sheet_collection();
        let sheet_count = sheets.len();
        let mut sheet_details: Vec<serde_json::Value> = Vec::new();
        let mut total_rows = 0u32;
        let mut total_cols = 0u32;

        for sheet in sheets {
            let name = sheet.get_name().to_string();
            let (max_col, max_row) = sheet.get_highest_column_and_row();
            total_rows += max_row;
            total_cols = total_cols.max(max_col);
            sheet_details.push(serde_json::json!({
                "name": name,
                "row_count": max_row,
                "col_count": max_col,
            }));
        }

        Ok(serde_json::json!({
            "sheet_count": sheet_count,
            "total_rows": total_rows,
            "total_cols": total_cols,
            "sheets": sheet_details,
            "format": "xlsx",
        }))
    }

    // ========================================================================
    // EPUB 解析（纯 Rust，使用 epub crate）
    // ========================================================================

    /// 从EPUB文件路径提取文本
    fn extract_epub_from_path(&self, file_path: &str) -> Result<String, ParsingError> {
        let bytes = self.read_file_safely(file_path)?;
        self.extract_epub_from_bytes(bytes)
    }

    /// 从EPUB字节流提取文本
    fn extract_epub_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        let cursor = Cursor::new(bytes);

        let mut doc = EpubDoc::from_reader(cursor)
            .map_err(|e| ParsingError::EpubParsingError(format!("无法解析EPUB: {}", e)))?;

        let mut text_content = String::with_capacity(8192);

        // 提取元数据
        if let Some(title) = doc.mdata("title") {
            // MetadataItem 可能是 String 或 Vec<String>，使用 to_string() 获取文本
            let title_str = format!("{:?}", title)
                .trim_matches('"')
                .trim_matches('[')
                .trim_matches(']')
                .to_string();
            if !title_str.is_empty() {
                text_content.push_str(&format!("# {}\n\n", title_str));
            }
        }
        if let Some(author) = doc.mdata("creator") {
            let author_str = format!("{:?}", author)
                .trim_matches('"')
                .trim_matches('[')
                .trim_matches(']')
                .to_string();
            if !author_str.is_empty() {
                text_content.push_str(&format!("作者: {}\n\n", author_str));
            }
        }

        // 遍历所有章节提取文本
        let spine_count = doc.get_num_pages();
        for i in 0..spine_count {
            doc.set_current_page(i);
            if let Some((content, _mime)) = doc.get_current_str() {
                // EPUB 内容是 XHTML，使用 html2text 转换
                let plain_text = match from_read(content.as_bytes(), 80) {
                    Ok(text) => text,
                    Err(e) => {
                        log::warn!("[DocumentParser] EPUB 页面 HTML 转文本失败: {}", e);
                        continue;
                    }
                };
                if !plain_text.trim().is_empty() {
                    text_content.push_str(&plain_text);
                    text_content.push_str("\n\n");
                }
            }
        }

        Ok(text_content.trim().to_string())
    }

    // ========================================================================
    // RTF 解析（纯 Rust，使用 rtf-parser）
    // ========================================================================

    /// 从RTF文件路径提取文本
    fn extract_rtf_from_path(&self, file_path: &str) -> Result<String, ParsingError> {
        let bytes = self.read_file_safely(file_path)?;
        self.extract_rtf_from_bytes(bytes)
    }

    /// 从RTF字节流提取文本
    fn extract_rtf_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        let content = String::from_utf8_lossy(&bytes);

        // 使用 rtf-parser: Lexer 扫描 -> Parser.parse() -> RtfDocument.get_text()
        let tokens = RtfLexer::scan(&content)
            .map_err(|e| ParsingError::RtfParsingError(format!("RTF词法分析失败: {:?}", e)))?;

        let document = RtfParser::new(tokens)
            .parse()
            .map_err(|e| ParsingError::RtfParsingError(format!("RTF语法分析失败: {:?}", e)))?;

        let text = document.get_text();

        Ok(text.trim().to_string())
    }

    // ========================================================================
    // CSV/JSON/XML 解析（纯文本格式，直接提取内容）
    // ========================================================================

    /// 从CSV字节流提取文本
    ///
    /// 将 CSV 转换为制表符分隔的纯文本，便于 LLM 理解
    fn extract_csv_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        self.check_file_size(bytes.len())?;

        let mut reader = csv::ReaderBuilder::new()
            .flexible(true) // 允许不规则行
            .has_headers(true)
            .from_reader(Cursor::new(bytes));

        let mut output = String::with_capacity(8192);

        // 提取表头
        if let Ok(headers) = reader.headers() {
            let header_row: Vec<&str> = headers.iter().collect();
            output.push_str(&header_row.join("\t"));
            output.push('\n');
        }

        // 提取数据行
        for result in reader.records() {
            match result {
                Ok(record) => {
                    let row: Vec<&str> = record.iter().collect();
                    output.push_str(&row.join("\t"));
                    output.push('\n');
                }
                Err(e) => {
                    // 跳过解析错误的行，继续处理
                    log::warn!("CSV行解析跳过: {}", e);
                }
            }
        }

        Ok(output.trim().to_string())
    }

    /// 从JSON字节流提取文本
    ///
    /// 将 JSON 格式化为可读的纯文本
    fn extract_json_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        self.check_file_size(bytes.len())?;

        let content = String::from_utf8_lossy(&bytes);

        // 尝试解析为 JSON Value
        match serde_json::from_str::<serde_json::Value>(&content) {
            Ok(value) => {
                // 格式化输出（带缩进）
                let formatted =
                    serde_json::to_string_pretty(&value).unwrap_or_else(|_| content.to_string());
                Ok(formatted)
            }
            Err(_) => {
                // 如果解析失败，直接返回原始内容
                Ok(content.trim().to_string())
            }
        }
    }

    /// 从XML字节流提取文本
    ///
    /// 提取 XML 中的所有文本内容，忽略标签
    fn extract_xml_from_bytes(&self, bytes: Vec<u8>) -> Result<String, ParsingError> {
        self.check_file_size(bytes.len())?;

        use quick_xml::events::Event;
        use quick_xml::Reader;

        let mut reader = Reader::from_reader(Cursor::new(bytes));
        reader.config_mut().trim_text(true);

        let mut output = String::with_capacity(8192);
        let mut buf = Vec::new();

        loop {
            match reader.read_event_into(&mut buf) {
                Ok(Event::Text(e)) => {
                    if let Ok(text) = e.unescape() {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            if !output.is_empty() {
                                output.push(' ');
                            }
                            output.push_str(trimmed);
                        }
                    }
                }
                Ok(Event::CData(e)) => {
                    // CDATA 部分也作为文本提取
                    if let Ok(text) = std::str::from_utf8(&e) {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            if !output.is_empty() {
                                output.push(' ');
                            }
                            output.push_str(trimmed);
                        }
                    }
                }
                Ok(Event::Eof) => break,
                Err(e) => {
                    log::warn!("XML解析错误: {}", e);
                    // 解析失败时，尝试返回原始内容
                    break;
                }
                _ => {}
            }
            buf.clear();
        }

        // 如果没有提取到文本，返回原始内容
        if output.is_empty() {
            let inner_bytes = reader.into_inner().into_inner();
            let content = String::from_utf8_lossy(&inner_bytes);
            return Ok(content.trim().to_string());
        }

        Ok(output.trim().to_string())
    }
}

/// 默认实例化
impl Default for DocumentParser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn test_document_parser_creation() {
        let parser = DocumentParser::new();
        assert_eq!(std::mem::size_of_val(&parser), 0); // 零大小类型
    }

    #[test]
    fn test_txt_support() {
        let parser = DocumentParser::new();
        let test_content = "Hello, World!".as_bytes().to_vec();
        let result = parser.extract_text_from_bytes("test.txt", test_content);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "Hello, World!");
    }

    #[test]
    fn test_txt_with_unicode() {
        let parser = DocumentParser::new();
        let test_content = "中文测试 English Test 123".as_bytes().to_vec();
        let result = parser.extract_text_from_bytes("test.txt", test_content);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "中文测试 English Test 123");
    }

    #[test]
    fn test_md_support() {
        let parser = DocumentParser::new();
        let test_content = "# 标题\n\n这是**Markdown**内容。".as_bytes().to_vec();
        let result = parser.extract_text_from_bytes("test.md", test_content);
        assert!(result.is_ok());
        assert_eq!(result.unwrap(), "# 标题\n\n这是**Markdown**内容。");
    }

    #[test]
    fn test_file_too_large() {
        let parser = DocumentParser::new();
        let large_content = vec![0u8; MAX_DOCUMENT_SIZE + 1];
        let result = parser.extract_text_from_bytes("test.txt", large_content);
        assert!(matches!(result, Err(ParsingError::FileTooLarge(_))));
    }

    #[test]
    fn test_base64_decoding_error() {
        let parser = DocumentParser::new();
        let result = parser.extract_text_from_base64("test.docx", "invalid_base64!");
        assert!(matches!(result, Err(ParsingError::Base64DecodingError(_))));
    }

    // ========================================================================
    // CORE-02: Office 加密检测测试
    // ========================================================================

    #[test]
    fn test_check_office_encryption_with_encrypted_package() {
        // 模拟包含 EncryptedPackage 的加密 Office 文档
        let parser = DocumentParser::new();

        // 创建一个内存中的 ZIP，包含 EncryptedPackage 条目
        let mut zip_buffer = Vec::new();
        {
            let mut zip_writer = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_buffer));
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            // 添加 EncryptedPackage 条目（Office 标准加密标记）
            zip_writer.start_file("EncryptedPackage", options).unwrap();
            zip_writer
                .write_all(b"encrypted content placeholder")
                .unwrap();

            zip_writer.finish().unwrap();
        }

        let result = parser.check_office_encryption(&zip_buffer, "encrypted.docx");
        assert!(matches!(result, Err(ParsingError::EncryptedDocument(_))));

        // 验证错误消息包含文件名
        if let Err(ParsingError::EncryptedDocument(msg)) = result {
            assert!(msg.contains("encrypted.docx"));
            assert!(msg.contains("加密"));
        }
    }

    #[test]
    fn test_check_office_encryption_missing_content_types() {
        // 模拟缺少 [Content_Types].xml 且无 Office 结构的情况
        let parser = DocumentParser::new();

        // 创建一个 ZIP，不包含 [Content_Types].xml 也不包含 Office 目录结构
        let mut zip_buffer = Vec::new();
        {
            let mut zip_writer = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_buffer));
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            // 只添加一个无关文件，没有 [Content_Types].xml
            zip_writer.start_file("random/file.txt", options).unwrap();
            zip_writer.write_all(b"some random content").unwrap();

            zip_writer.finish().unwrap();
        }

        let result = parser.check_office_encryption(&zip_buffer, "suspicious.docx");
        assert!(matches!(result, Err(ParsingError::EncryptedDocument(_))));

        // 验证错误消息
        if let Err(ParsingError::EncryptedDocument(msg)) = result {
            assert!(msg.contains("suspicious.docx"));
        }
    }

    #[test]
    fn test_check_office_encryption_valid_document() {
        // 模拟正常未加密的 Office 文档
        let parser = DocumentParser::new();

        // 创建一个有效的 Office Open XML 结构
        let mut zip_buffer = Vec::new();
        {
            let mut zip_writer = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_buffer));
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            // 添加 [Content_Types].xml（未加密 Office 文档必有此文件）
            zip_writer
                .start_file("[Content_Types].xml", options)
                .unwrap();
            zip_writer
                .write_all(
                    br#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="xml" ContentType="application/xml"/>
</Types>"#,
                )
                .unwrap();

            // 添加一些 Office 结构文件
            zip_writer.start_file("word/document.xml", options).unwrap();
            zip_writer
                .write_all(b"<document>content</document>")
                .unwrap();

            zip_writer.finish().unwrap();
        }

        let result = parser.check_office_encryption(&zip_buffer, "valid.docx");
        assert!(
            result.is_ok(),
            "Valid Office document should pass encryption check"
        );
    }

    #[test]
    fn test_check_office_encryption_has_office_structure_but_missing_content_types() {
        // 有 Office 结构但缺少 [Content_Types].xml（应该通过，因为有 Office 结构）
        let parser = DocumentParser::new();

        let mut zip_buffer = Vec::new();
        {
            let mut zip_writer = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_buffer));
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            // 添加 Office 目录结构，但没有 [Content_Types].xml
            zip_writer.start_file("word/document.xml", options).unwrap();
            zip_writer
                .write_all(b"<document>content</document>")
                .unwrap();

            zip_writer.start_file("docProps/core.xml", options).unwrap();
            zip_writer.write_all(b"<core>metadata</core>").unwrap();

            zip_writer.finish().unwrap();
        }

        let result = parser.check_office_encryption(&zip_buffer, "partial.docx");
        // 有 Office 结构，应该通过检测
        assert!(
            result.is_ok(),
            "Document with Office structure should pass even without [Content_Types].xml"
        );
    }

    // ========================================================================
    // CORE-02: PDF 加密检测测试
    // ========================================================================

    #[test]
    fn test_check_pdf_encryption_with_encrypt_marker() {
        // 测试包含 /Encrypt 标记的 PDF
        use std::io::Write;
        use tempfile::NamedTempFile;

        let parser = DocumentParser::new();

        let mut file = NamedTempFile::new().unwrap();
        // 写入包含 /Encrypt 的 PDF 头
        file.write_all(b"%PDF-1.4\n/Encrypt").unwrap();
        file.flush().unwrap();

        let result = parser.check_pdf_encryption_from_path(file.path().to_str().unwrap());
        assert!(matches!(result, Err(ParsingError::EncryptedDocument(_))));

        // 验证错误消息
        if let Err(ParsingError::EncryptedDocument(msg)) = result {
            assert!(msg.contains("加密"));
            assert!(msg.contains("PDF"));
        }
    }

    #[test]
    fn test_check_pdf_encryption_normal_pdf() {
        // 测试正常 PDF（无 /Encrypt）
        use std::io::Write;
        use tempfile::NamedTempFile;

        let parser = DocumentParser::new();

        let mut file = NamedTempFile::new().unwrap();
        file.write_all(b"%PDF-1.4\n/Root 1 0 R\n%%EOF").unwrap();
        file.flush().unwrap();

        let result = parser.check_pdf_encryption_from_path(file.path().to_str().unwrap());
        assert!(result.is_ok(), "Normal PDF should pass encryption check");
    }

    #[test]
    fn test_check_pdf_encryption_encrypt_in_trailer() {
        // /Encrypt 在文件末尾 trailer 区域
        let parser = DocumentParser::new();

        // 创建一个大于 4KB 的 PDF，/Encrypt 在 trailer 区域
        let mut pdf_content = Vec::new();
        pdf_content.extend_from_slice(b"%PDF-1.4\n");
        // 添加填充内容使文件大于 4KB
        pdf_content.extend_from_slice(&vec![b'%'; 5000]);
        // 在 trailer 区域添加 /Encrypt
        pdf_content.extend_from_slice(b"\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF");

        let result = parser.check_pdf_encryption(&pdf_content, "encrypted_trailer.pdf");
        assert!(matches!(result, Err(ParsingError::EncryptedDocument(_))));
    }

    #[test]
    fn test_check_pdf_encryption_from_bytes() {
        // 测试字节流版本的 PDF 加密检测
        let parser = DocumentParser::new();

        // 加密的 PDF
        let encrypted_pdf = b"%PDF-1.7\n/Encrypt 1 0 obj\n<<>>\nendobj";
        let result = parser.check_pdf_encryption(encrypted_pdf, "test.pdf");
        assert!(matches!(result, Err(ParsingError::EncryptedDocument(_))));

        // 未加密的 PDF
        let normal_pdf = b"%PDF-1.7\n/Root 1 0 obj\n<<>>\nendobj\n%%EOF";
        let result = parser.check_pdf_encryption(normal_pdf, "normal.pdf");
        assert!(result.is_ok());
    }

    // ========================================================================
    // CORE-02: 边界情况测试
    // ========================================================================

    #[test]
    fn test_check_office_encryption_empty_zip() {
        // 空 ZIP 文件（应判定为可能加密或损坏）
        let parser = DocumentParser::new();

        // 创建一个空的 ZIP 文件
        let mut zip_buffer = Vec::new();
        {
            let mut zip_writer = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_buffer));
            zip_writer.finish().unwrap();
        }

        let result = parser.check_office_encryption(&zip_buffer, "empty.docx");
        // 空 ZIP 没有 [Content_Types].xml 也没有 Office 结构，应该报错
        assert!(matches!(result, Err(ParsingError::EncryptedDocument(_))));
    }

    #[test]
    fn test_check_office_encryption_invalid_zip() {
        // 无效的 ZIP 数据（无法作为 ZIP 打开，应让后续解析器处理）
        let parser = DocumentParser::new();

        let invalid_data = b"This is not a valid ZIP file";
        let result = parser.check_office_encryption(invalid_data, "invalid.docx");
        // 无法作为 ZIP 打开时，check_office_encryption 返回 Ok 让后续解析器处理
        assert!(result.is_ok());
    }

    #[test]
    fn test_check_pdf_encryption_small_file() {
        // 非常小的 PDF 文件（小于 4KB）
        let parser = DocumentParser::new();

        let small_pdf = b"%PDF-1.4\n%%EOF";
        let result = parser.check_pdf_encryption(small_pdf, "small.pdf");
        assert!(result.is_ok(), "Small PDF without /Encrypt should pass");
    }

    #[test]
    fn test_check_pdf_encryption_large_file_encrypt_in_middle() {
        // 大文件，/Encrypt 在中间区域
        let parser = DocumentParser::new();

        // 创建一个大于 8KB 的 PDF
        let mut pdf_content = Vec::new();
        pdf_content.extend_from_slice(b"%PDF-1.4\n");
        // 前半部分填充（约 5KB）
        pdf_content.extend_from_slice(&vec![b'%'; 5000]);
        // 在中间添加 /Encrypt
        pdf_content.extend_from_slice(b"\n/Encrypt 1 0 R\n");
        // 后半部分填充（约 5KB）
        pdf_content.extend_from_slice(&vec![b'%'; 5000]);
        pdf_content.extend_from_slice(b"\n%%EOF");

        let result = parser.check_pdf_encryption(&pdf_content, "large_encrypted.pdf");
        assert!(matches!(result, Err(ParsingError::EncryptedDocument(_))));
    }

    #[test]
    fn test_check_pdf_encryption_encrypt_as_content() {
        // /Encrypt 作为内容文本出现（非加密标记）
        // 注意：当前实现会误报这种情况，这是已知限制
        let parser = DocumentParser::new();

        // 这个测试文档了当前行为：包含 "/Encrypt" 字符串会被检测为加密
        let pdf_with_encrypt_text = b"%PDF-1.4\n(Text about /Encrypt feature)\n%%EOF";
        let result = parser.check_pdf_encryption(pdf_with_encrypt_text, "text_with_encrypt.pdf");
        // 当前实现会将此视为加密文档（这是已知限制）
        assert!(matches!(result, Err(ParsingError::EncryptedDocument(_))));
    }

    #[test]
    fn test_integration_extract_encrypted_docx() {
        // 集成测试：尝试解析加密的 DOCX 应该返回加密错误
        let parser = DocumentParser::new();

        // 创建一个带 EncryptedPackage 的 ZIP
        let mut zip_buffer = Vec::new();
        {
            let mut zip_writer = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_buffer));
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            zip_writer.start_file("EncryptedPackage", options).unwrap();
            zip_writer.write_all(b"encrypted content").unwrap();
            zip_writer.finish().unwrap();
        }

        let result = parser.extract_text_from_bytes("encrypted.docx", zip_buffer);
        assert!(matches!(result, Err(ParsingError::EncryptedDocument(_))));
    }

    #[test]
    fn test_integration_extract_encrypted_xlsx() {
        // 集成测试：尝试解析加密的 XLSX 应该返回加密错误
        let parser = DocumentParser::new();

        // 创建一个带 EncryptedPackage 的 ZIP
        let mut zip_buffer = Vec::new();
        {
            let mut zip_writer = zip::ZipWriter::new(std::io::Cursor::new(&mut zip_buffer));
            let options = zip::write::FileOptions::default()
                .compression_method(zip::CompressionMethod::Stored);

            zip_writer.start_file("EncryptedPackage", options).unwrap();
            zip_writer.write_all(b"encrypted content").unwrap();
            zip_writer.finish().unwrap();
        }

        let result = parser.extract_text_from_bytes("encrypted.xlsx", zip_buffer);
        assert!(matches!(result, Err(ParsingError::EncryptedDocument(_))));
    }
}
