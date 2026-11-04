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
/// v2 无限画布 board 文档的 schema_version。
pub const INK_BOARD_SCHEMA_VERSION: u32 = 2;

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

/// v2 board 世界坐标包围范围；允许负原点，由域验证器限制在数值安全范围内。
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkBoardBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// v2 board surface：稳定 page_id 用于 artifact 定位，bounds 仅描述浏览范围。
///
/// Deserialize 手写而非 `#[serde(tag = "kind")]` 派生：internally tagged enum
/// 会先把整个对象缓冲进 serde 私有的 `Content`，而本 crate 打开了 serde_json
/// 的 `arbitrary_precision`，此时十进制浮点（如 `-100.0`）以私有 Number 结构
/// 进入 `Content`，再按 f64 读取必然失败（表现为 InvalidJSON）。与
/// `InkObjectContent` 相同，先按普通结构体流式读取字段，再按 `kind` 分派，
/// 让 `bounds` 的 f64 直接由 serde_json 解析。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum InkBoardSurface {
    Board {
        page_id: String,
        ruling: InkRuling,
        bounds: InkBoardBounds,
    },
}

impl<'de> Deserialize<'de> for InkBoardSurface {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Fields {
            kind: String,
            page_id: String,
            ruling: InkRuling,
            bounds: InkBoardBounds,
        }

        let fields = Fields::deserialize(deserializer)?;
        match fields.kind.as_str() {
            "board" => Ok(Self::Board {
                page_id: fields.page_id,
                ruling: fields.ruling,
                bounds: fields.bounds,
            }),
            _ => Err(<D::Error as serde::de::Error>::custom(
                "Invalid Ink board surface",
            )),
        }
    }
}

/// manifest 对一个不可变 board chunk blob 的引用与预算元数据。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkBoardChunkRef {
    pub chunk_id: String,
    /// chunk 正文 JSON blob 的 SHA-256 hex64。
    pub blob_hash: String,
    /// chunk blob 的精确字节数（JSON 编码后）。
    pub byte_length: u64,
    pub object_count: u32,
    pub sample_count: u32,
    pub bounds: InkBoardBounds,
}

/// v2 board 对象；`z_index` 为非负整数绘制顺序。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkBoardObject {
    pub id: String,
    pub author: InkAuthor,
    pub created_at: i64,
    pub z_index: i64,
    pub content: InkObjectContent,
}

/// v2 board chunk blob。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InkBoardChunk {
    pub schema_version: u32,
    pub chunk_id: String,
    pub objects: Vec<InkBoardObject>,
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
#[derive(Debug, Clone, PartialEq)]
pub struct InkManifest {
    pub schema_version: u32,
    pub document_id: String,
    /// 非空修订标识；每次保存换代。
    pub revision: String,
    pub title: String,
    pub source: InkSource,
    pub pages: Vec<InkPageRef>,
    pub last_operation: Option<InkOperationReceipt>,
    /// 仅 v2 board 使用；v1 序列化时完全省略。
    pub surface: Option<InkBoardSurface>,
    /// 仅 v2 board 使用；v1 序列化时完全省略，v2 即使为空也显式输出。
    pub chunks: Vec<InkBoardChunkRef>,
}

impl Serialize for InkManifest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        #[derive(Serialize)]
        struct Wire<'a> {
            schema_version: u32,
            document_id: &'a str,
            revision: &'a str,
            title: &'a str,
            source: &'a InkSource,
            pages: &'a [InkPageRef],
            #[serde(skip_serializing_if = "Option::is_none")]
            last_operation: Option<&'a InkOperationReceipt>,
            #[serde(skip_serializing_if = "Option::is_none")]
            surface: Option<&'a InkBoardSurface>,
            #[serde(skip_serializing_if = "Option::is_none")]
            chunks: Option<&'a [InkBoardChunkRef]>,
        }

        let is_board = self.schema_version == INK_BOARD_SCHEMA_VERSION;
        let surface = if is_board {
            Some(self.surface.as_ref().ok_or_else(|| {
                <S::Error as serde::ser::Error>::custom("Ink board manifest requires a surface")
            })?)
        } else if self.schema_version == INK_SCHEMA_VERSION {
            None
        } else {
            self.surface.as_ref()
        };
        let chunks = if is_board {
            Some(self.chunks.as_slice())
        } else if self.schema_version == INK_SCHEMA_VERSION || self.chunks.is_empty() {
            None
        } else {
            Some(self.chunks.as_slice())
        };

        Wire {
            schema_version: self.schema_version,
            document_id: &self.document_id,
            revision: &self.revision,
            title: &self.title,
            source: &self.source,
            pages: self.pages.as_slice(),
            last_operation: self.last_operation.as_ref(),
            surface,
            chunks,
        }
        .serialize(serializer)
    }
}

/// 区分字段缺失、显式 null 与有值，供版本相关的严格反序列化使用。
enum Present<T> {
    Missing,
    Null,
    Value(T),
}

impl<T> Default for Present<T> {
    fn default() -> Self {
        Self::Missing
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for Present<T> {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        match Option::<T>::deserialize(deserializer)? {
            Some(value) => Ok(Self::Value(value)),
            None => Ok(Self::Null),
        }
    }
}

impl<'de> Deserialize<'de> for InkManifest {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Wire {
            schema_version: u32,
            document_id: String,
            revision: String,
            title: String,
            source: InkSource,
            #[serde(default)]
            pages: Present<Vec<InkPageRef>>,
            #[serde(default)]
            last_operation: Option<InkOperationReceipt>,
            #[serde(default)]
            surface: Present<InkBoardSurface>,
            #[serde(default)]
            chunks: Present<Vec<InkBoardChunkRef>>,
        }

        let wire = Wire::deserialize(deserializer)?;
        let invalid = |message: &str| <D::Error as serde::de::Error>::custom(message);

        match wire.schema_version {
            INK_SCHEMA_VERSION => {
                // v1 必须完全不含 board 字段，显式 null / 空数组同样拒绝。
                if !matches!(&wire.surface, Present::Missing) {
                    return Err(invalid("Ink v1 manifest must not contain a board surface"));
                }
                if !matches!(&wire.chunks, Present::Missing) {
                    return Err(invalid("Ink v1 manifest must not contain board chunks"));
                }
                let pages = match wire.pages {
                    Present::Value(pages) => pages,
                    Present::Missing | Present::Null => {
                        return Err(invalid("Invalid Ink manifest pages"))
                    }
                };
                Ok(Self {
                    schema_version: wire.schema_version,
                    document_id: wire.document_id,
                    revision: wire.revision,
                    title: wire.title,
                    source: wire.source,
                    pages,
                    last_operation: wire.last_operation,
                    surface: None,
                    chunks: Vec::new(),
                })
            }
            INK_BOARD_SCHEMA_VERSION => {
                let pages = match wire.pages {
                    Present::Value(pages) => pages,
                    Present::Missing | Present::Null => {
                        return Err(invalid("Ink board manifest requires pages"))
                    }
                };
                if !pages.is_empty() {
                    return Err(invalid("Ink board manifest must not contain fixed pages"));
                }
                if matches!(&wire.source, InkSource::Resource { .. }) {
                    return Err(invalid("Ink board manifest must use a blank source"));
                }
                let surface = match wire.surface {
                    Present::Value(surface) => surface,
                    Present::Missing | Present::Null => {
                        return Err(invalid("Ink board manifest requires a surface"))
                    }
                };
                let chunks = match wire.chunks {
                    Present::Value(chunks) => chunks,
                    Present::Missing | Present::Null => {
                        return Err(invalid("Ink board manifest requires chunks"))
                    }
                };
                Ok(Self {
                    schema_version: wire.schema_version,
                    document_id: wire.document_id,
                    revision: wire.revision,
                    title: wire.title,
                    source: wire.source,
                    pages,
                    last_operation: wire.last_operation,
                    surface: Some(surface),
                    chunks,
                })
            }
            _ => Ok(Self {
                schema_version: wire.schema_version,
                document_id: wire.document_id,
                revision: wire.revision,
                title: wire.title,
                source: wire.source,
                pages: match wire.pages {
                    Present::Value(pages) => pages,
                    Present::Missing | Present::Null => Vec::new(),
                },
                last_operation: wire.last_operation,
                surface: match wire.surface {
                    Present::Value(surface) => Some(surface),
                    Present::Missing | Present::Null => None,
                },
                chunks: match wire.chunks {
                    Present::Value(chunks) => chunks,
                    Present::Missing | Present::Null => Vec::new(),
                },
            }),
        }
    }
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
