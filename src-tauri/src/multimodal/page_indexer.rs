//! 文档/教材预览结构（preview_json 反序列化）
//!
//! 仅承载被 `crate::vfs::multimodal_service` 依赖的预览数据结构。
//!
//! ★ 2026-06-13（代理 3 round2 · G1 死代码清理）：
//!   原 `PageIndexer` 索引器及其 `vector_store` / `reranker_service` / `retriever` 依赖链
//!   均为死代码（`PageIndexer::new`/`with_progress` 全仓无调用方，真实索引在
//!   `crate::vfs::multimodal_service`），已整体移除；本文件现仅保留 preview_json 的反序列化结构。

/// PDF 附件/教材预览结构
///
/// 支持两种命名格式：
/// - snake_case: dpi, page_count（旧格式）
/// - camelCase: renderDpi, totalPages（PdfPreviewJson 使用）
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AttachmentPreview {
    pub pages: Vec<AttachmentPreviewPage>,
    #[serde(default, alias = "renderDpi")]
    pub dpi: Option<u32>,
    #[serde(default, alias = "totalPages")]
    pub page_count: Option<usize>,
    #[serde(default, alias = "renderedAt")]
    pub rendered_at: Option<String>,
}

/// PDF 附件/教材的单页预览数据
///
/// 支持两种命名格式：
/// - snake_case: page_index, blob_hash, mime_type（旧格式）
/// - camelCase: pageIndex, blobHash, mimeType（PdfPagePreview 使用）
#[derive(Debug, Clone, serde::Deserialize)]
pub struct AttachmentPreviewPage {
    #[serde(alias = "pageIndex")]
    pub page_index: usize,
    #[serde(alias = "blobHash")]
    pub blob_hash: Option<String>,
    #[serde(default, alias = "width")]
    pub width: Option<u32>,
    #[serde(default, alias = "height")]
    pub height: Option<u32>,
    #[serde(default, alias = "mimeType")]
    pub mime_type: Option<String>,
}

/// 教材预览结构（与 PDF 附件结构一致）
pub type TextbookPreview = AttachmentPreview;
pub type TextbookPreviewPage = AttachmentPreviewPage;

#[cfg(test)]
mod tests {
    use super::*;

    /// 测试 TextbookPreview 能正确解析 camelCase 格式的 JSON（PdfPreviewJson 格式）
    #[test]
    fn test_textbook_preview_camel_case_parsing() {
        // 这是 PdfPreviewJson 序列化出来的实际格式
        let json = r#"{
            "pages": [
                {"pageIndex": 0, "blobHash": "abc123", "width": 100, "height": 200, "mimeType": "image/png"},
                {"pageIndex": 1, "blobHash": "def456", "width": 100, "height": 200, "mimeType": "image/png"}
            ],
            "renderDpi": 150,
            "totalPages": 2,
            "renderedAt": "2026-01-16T12:00:00Z"
        }"#;

        let result: std::result::Result<TextbookPreview, serde_json::Error> =
            serde_json::from_str(json);
        assert!(
            result.is_ok(),
            "Failed to parse camelCase JSON: {:?}",
            result.err()
        );

        let preview = result.unwrap();
        assert_eq!(preview.pages.len(), 2);
        assert_eq!(preview.pages[0].page_index, 0);
        assert_eq!(preview.pages[0].blob_hash, Some("abc123".to_string()));
        assert_eq!(preview.pages[1].page_index, 1);
        assert_eq!(preview.dpi, Some(150));
        assert_eq!(preview.page_count, Some(2));
    }
}
