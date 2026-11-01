//! Unit Builder Trait 定义

use crate::vfs::repos::index_unit_repo::CreateUnitInput;

/// Unit 构建输入
#[derive(Debug, Clone)]
pub struct UnitBuildInput {
    /// 资源 ID
    pub resource_id: String,
    /// 资源类型
    pub resource_type: String,
    /// 资源的原始数据（JSON 或其他格式）
    pub data: Option<String>,
    /// OCR 文本（单页资源）
    pub ocr_text: Option<String>,
    /// OCR 页面 JSON（多页资源）
    pub ocr_pages_json: Option<String>,
    /// 关联的 blob hash（PDF 等外部存储）
    pub blob_hash: Option<String>,
    /// 页数（多页资源）
    pub page_count: Option<i32>,
    /// 提取的文本（PDF 原生文本等）
    pub extracted_text: Option<String>,
    /// 预览 JSON（包含页面图片 hash）
    pub preview_json: Option<String>,
}

/// Unit 构建输出
#[derive(Debug, Clone)]
pub struct UnitBuildOutput {
    /// 生成的 Unit 列表
    pub units: Vec<CreateUnitInput>,
}

/// Unit Builder Trait
///
/// 将资源转换为 Unit 列表的抽象接口
pub trait UnitBuilder: Send + Sync {
    /// 返回此 Builder 支持的资源类型
    fn resource_type(&self) -> &'static str;

    /// 将资源转换为 Unit 列表
    fn build(&self, input: &UnitBuildInput) -> UnitBuildOutput;
}
