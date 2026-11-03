//! `.dsink` 手写/批注文档的序列化域类型。
//!
//! 序列化约定：
//! - 全部 snake_case，与 `src/features/ink/types.ts` 的 wire JSON 完全一致；
//!   TS/Rust 消费同一份 `tests/fixtures/ink/*.json`。
//! - 判别联合使用内部标签 `kind`（`InkSource` / `InkBackground` /
//!   `InkObjectContent`），标签值 snake_case。
//! - 域结构体和 internally tagged enum 都使用 serde `deny_unknown_fields`；
//!   对 tagged enum，serde derive 将 enum 的容器属性应用到其结构变体。
//! - 可选字段（`last_operation` / `previous_revision` / `elapsed_ms`）序列化时
//!   `skip_serializing_if = "Option::is_none"`，缺省即字段不存在，与 TS 的
//!   `?:` 保持一致。
//! - 稳定 ID 是不透明字符串，不是文件路径；哈希一律 SHA-256 小写 hex64；
//!   PDF 页索引从 0 开始。

use serde::{Deserialize, Serialize};

fn present_non_null<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    T::deserialize(deserializer).map(Some)
}

/// `.dsink` 文档 MIME 类型（契约常量）。
pub const INK_MIME: &str = "application/vnd.deepstudent.ink+json";
/// `.dsink` 文件扩展名（契约常量，不含点号）。
pub const INK_EXTENSION: &str = "dsink";
/// 当前唯一支持的 schema_version。
pub const INK_SCHEMA_VERSION: u32 = 1;

/// 结构化错误码，序列化为 SCREAMING_SNAKE_CASE。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum InkErrorCode {
    InvalidArgument,
    LimitExceeded,
    UnsupportedSchema,
}

/// 域级结构化错误：稳定 `code` + 小型 `message`。
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error, Serialize, Deserialize)]
#[error("ink error [{code:?}]: {message}")]
pub struct InkError {
    pub code: InkErrorCode,
    pub message: String,
}

/// 对象作者。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InkAuthor {
    User,
    Ai,
}

/// 空白背景的行距样式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InkRuling {
    Blank,
    Lined,
    Grid,
}

/// 笔迹工具。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InkTool {
    Pen,
    Highlighter,
}

/// 文档来源：空白新建，或指向某个既有 VFS 资源（不含可变的源版本快照）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InkSource {
    Blank {},
    Resource {
        resource_id: String,
        /// SHA-256 hex64：转换时冻结的源 blob。
        source_hash: String,
        conversion_revision: String,
    },
}

/// 页面背景。blob 冻结字节内容，不接受任意 URL/路径。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InkBackground {
    Blank {
        ruling: InkRuling,
    },
    Image {
        blob_hash: String,
    },
    PdfPage {
        blob_hash: String,
        /// 零基页索引。
        source_page_index: u32,
    },
}

/// manifest 内对一页的引用（页正文存独立 blob）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkPageRef {
    pub page_id: String,
    /// 逻辑页尺寸（与 `InkRect` 同一坐标系，非归一化）。
    pub width: f64,
    pub height: f64,
    pub background: InkBackground,
    /// 页正文 JSON blob 的 SHA-256 hex64。
    pub page_blob_hash: String,
}

/// 一次操作的成功回执。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkOperationReceipt {
    pub operation_id: String,
    /// hex64：操作输入的内容哈希。
    pub input_hash: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub previous_revision: Option<String>,
    /// 必须等于 manifest.revision。
    pub result_revision: String,
}

/// `.dsink` manifest（文档头，独立 blob）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkManifest {
    pub schema_version: u32,
    pub document_id: String,
    /// 非空修订标识；每次保存换代。
    pub revision: String,
    pub title: String,
    pub source: InkSource,
    pub pages: Vec<InkPageRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_operation: Option<InkOperationReceipt>,
}

/// 采样点：坐标为逻辑页坐标，全部有限且落在页内。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkSample {
    pub x: f64,
    pub y: f64,
    /// 0..=1。
    pub pressure: f64,
    /// 相对笔迹起点毫秒数，有限、>=0、笔内单调不减。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<f64>,
}

/// 笔迹样式。`color` 为 `#RRGGBB` 或 `#RRGGBBAA`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkStrokeStyle {
    pub tool: InkTool,
    pub color: String,
    /// >0 且 <=256。
    pub width: f64,
    pub pressure_enabled: bool,
}

/// 逻辑页矩形（非归一化；与工具归一化坐标系有意区分，防混用）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 逻辑页点。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkPoint {
    pub x: f64,
    pub y: f64,
}

/// Page object content tagged by `kind`. Text is plain content, not markup.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InkObjectContent {
    Stroke {
        samples: Vec<InkSample>,
        style: InkStrokeStyle,
    },
    Text {
        rect: InkRect,
        text: String,
        font_size: f64,
        color: String,
    },
    Rect {
        rect: InkRect,
        color: String,
        width: f64,
    },
    Ellipse {
        rect: InkRect,
        color: String,
        width: f64,
    },
    RegionHighlight {
        rect: InkRect,
        color: String,
        width: f64,
    },
    Arrow {
        from: InkPoint,
        to: InkPoint,
        color: String,
        width: f64,
    },
}

impl<'de> Deserialize<'de> for InkObjectContent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            kind: String,
            #[serde(default, deserialize_with = "present_non_null")]
            samples: Option<Vec<InkSample>>,
            #[serde(default, deserialize_with = "present_non_null")]
            style: Option<InkStrokeStyle>,
            #[serde(default, deserialize_with = "present_non_null")]
            rect: Option<InkRect>,
            #[serde(default, deserialize_with = "present_non_null")]
            text: Option<String>,
            #[serde(default, deserialize_with = "present_non_null")]
            font_size: Option<f64>,
            #[serde(default, deserialize_with = "present_non_null")]
            color: Option<String>,
            #[serde(default, deserialize_with = "present_non_null")]
            width: Option<f64>,
            #[serde(default, deserialize_with = "present_non_null")]
            from: Option<InkPoint>,
            #[serde(default, deserialize_with = "present_non_null")]
            to: Option<InkPoint>,
        }

        let fields = Fields::deserialize(deserializer)?;
        let count = [
            fields.samples.is_some(),
            fields.style.is_some(),
            fields.rect.is_some(),
            fields.text.is_some(),
            fields.font_size.is_some(),
            fields.color.is_some(),
            fields.width.is_some(),
            fields.from.is_some(),
            fields.to.is_some(),
        ]
        .into_iter()
        .filter(|present| *present)
        .count();

        match fields.kind.as_str() {
            "stroke" if count == 2 => Ok(Self::Stroke {
                samples: fields.samples.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                style: fields.style.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
            }),
            "text" if count == 4 => Ok(Self::Text {
                rect: fields.rect.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                text: fields.text.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                font_size: fields.font_size.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                color: fields.color.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
            }),
            "rect" if count == 3 => Ok(Self::Rect {
                rect: fields.rect.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                color: fields.color.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                width: fields.width.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
            }),
            "ellipse" if count == 3 => Ok(Self::Ellipse {
                rect: fields.rect.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                color: fields.color.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                width: fields.width.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
            }),
            "region_highlight" if count == 3 => Ok(Self::RegionHighlight {
                rect: fields.rect.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                color: fields.color.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                width: fields.width.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
            }),
            "arrow" if count == 4 => Ok(Self::Arrow {
                from: fields.from.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                to: fields.to.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                color: fields.color.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
                width: fields.width.ok_or_else(|| {
                    <D::Error as serde::de::Error>::custom("Invalid Ink object content")
                })?,
            }),
            _ => Err(<D::Error as serde::de::Error>::custom(
                "Invalid Ink object content",
            )),
        }
    }
}

/// 页内一个批注/笔迹对象。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkObject {
    pub id: String,
    pub author: InkAuthor,
    /// epoch 毫秒，>=0。
    pub created_at: i64,
    pub content: InkObjectContent,
}

/// 单页正文 blob。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkPage {
    pub schema_version: u32,
    pub page_id: String,
    pub objects: Vec<InkObject>,
}
