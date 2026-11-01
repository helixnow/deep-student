//! # AI 图像遮挡制卡（Image Occlusion，Round 4 #5）
//!
//! 纯函数模块：不调用任何 LLM、无 I/O。VlmFull 调用点会优先解析
//! `[OCCLUSION_BOXES]` 归一化坐标，失败才把已有 `[IMAGE_DESC: ...]`
//! 转成启发式网格草稿 marker；流式生成层消费 marker 后把 `_occlusion`
//! 写入该分段首张成功卡。这里只负责确定性变换：
//!
//! 1. **校验**：`validate_spec` 把外部（LLM / 前端编辑器）产出的
//!    [`OcclusionSpec`] 收敛为 [`ValidatedOcclusionSpec`]（越界 / 过度重叠 /
//!    空盒 / 非法 cloze 序号一律结构化拒绝，绝不静默修剪语义）。
//! 2. **草稿字段**：`build_card_fields` 生成候选 Cloze `Text`（含
//!    `<img src>`）与 `extra_fields["_occlusion"]` spec。生产入库
//!    （`streaming_anki_service::parse_and_save_card`）现已消费该 text
//!    （仅在模型未产出非空 text 时补入）并把 `_occlusion.imageRef` 写入
//!    `AnkiCard.images`（`vlm://` 占位引用被过滤，不入 images）；
//!    导出转换仍未接通。
//! 3. **启发式建议**：`propose_boxes_from_image_desc` 从 VlmFull/VlmLight
//!    已产出的 `[IMAGE_DESC: ...]` 条目文本中提取标签并按网格布局出候选盒，
//!    作为「无坐标 VLM → 有坐标遮挡」的零成本首版桥（无图测试不碰模型）。
//!
//! ## 坐标约定（安全边界）
//!
//! - 模块内一律使用 **归一化坐标**：`x/y/w/h ∈ [0,1]`，原点左上角。
//!   归一化让 spec 与图片实际分辨率解耦——同一 spec 可套用缩略图与原图。
//! - 像素换算只发生在渲染/字段构造边界（`to_pixel_boxes`），带
//!   四舍五入 + 边界收敛 + 最小 1px 保证，有测试锁定。
//! - Anki 原生 IO cloze 语法（[`format_anki_io_cloze`]）**同样输出 0–1
//!   归一化小数**，对齐 Anki 官方 `to-cloze.ts` 的文档示例
//!   `{{c1::image-occlusion:rect:top=.1:left=.23:width=.4:height=.5}}`。
//!   **禁止再写 ×100 百分数**：百分数会让 Anki 遮罩放大 100 倍。
//!
//! ## 当前产品边界
//!
//! Anki 23.10+ 原生 Image Occlusion note type 的 `Occlusion` 字段本质是
//! cloze 语法包裹的矩形描述（字符串构造见 [`format_anki_io_cloze`]）。
//! 生产入库已把草稿 `text`（`<img>` + cloze）与 `_occlusion.imageRef`
//! 写入卡片的 text / images 字段；但 APKG/AnkiConnect 导出侧尚未把这些
//! 字段转换为 Anki 官方 IO note。在导出侧接线与端到端测试打通前，
//! 不得宣称已与 Anki 官方图像遮挡完全兼容。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ============================================================================
// 常量与配置
// ============================================================================

/// `extra_fields` 中存放归一化遮挡 spec JSON 的键名。
/// 与 `_qa_flags` 同风格：下划线前缀表示机器协议字段，非用户内容。
pub const OCCLUSION_FIELD: &str = "_occlusion";

/// 自动生成卡片附带的 tag，前端及后续转换侧可按此识别遮挡草稿。
pub const OCCLUSION_TAG: &str = "image-occlusion";

/// VlmFull → 流式生成之间传递遮挡草稿的内部行协议。
///
/// marker 会在制卡 prompt 构建前被剥离，模型看不到这段机器元数据。
pub const OCCLUSION_DRAFT_PREFIX: &str = "[ANKI_OCCLUSION_DRAFT:";

/// VLM 输出中归一化坐标 JSON 的块边界。
pub const OCCLUSION_BOXES_OPEN: &str = "[OCCLUSION_BOXES]";
pub const OCCLUSION_BOXES_CLOSE: &str = "[/OCCLUSION_BOXES]";

/// 浮点比较容差（归一化坐标场景下 1e-6 远小于 1px）。
const EPS: f32 = 1e-6;

/// 校验配置。所有阈值可调，默认值面向「LLM 产出轻微越界很常见」的现实。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcclusionConfig {
    /// 单卡最大遮挡盒数（Anki 实践上超过这个数复习体验急剧下降）。
    pub max_boxes: usize,
    /// 盒最小边长（归一化）。低于此值视为「空盒/退化盒」拒绝。
    pub min_box_size: f32,
    /// 任意两盒 IoU 超过此阈值视为「重叠过多」拒绝
    /// （允许小幅相邻重叠，如表格相邻单元格的描边容差）。
    pub max_pairwise_iou: f32,
    /// 标签最大字符数（超长截断，不拒绝）。
    pub max_label_chars: usize,
}

impl Default for OcclusionConfig {
    fn default() -> Self {
        Self {
            max_boxes: 12,
            min_box_size: 0.01,
            max_pairwise_iou: 0.35,
            max_label_chars: 48,
        }
    }
}

// ============================================================================
// 数据结构
// ============================================================================

/// 单个遮挡矩形（归一化坐标，原点左上角）。
///
/// `cloze_index` 为 1-based Anki cloze 序号；`None` 时由校验器顺序补齐。
/// 允许多个盒共享同一序号（Anki 语义：同组一起隐藏）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcclusionBox {
    pub x: f32,
    pub y: f32,
    pub w: f32,
    pub h: f32,
    /// 遮挡区域的答案标签（揭开后显示的内容）。空标签由校验器自动补
    /// `区域 N`，不拒绝——遮挡卡的信息在图上，标签只是辅助。
    #[serde(default)]
    pub label: String,
    /// 1-based cloze 序号；0 非法。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cloze_index: Option<u32>,
}

/// 图像遮挡制卡输入：一张图 + 一组遮挡盒。
///
/// `image_ref` 是调用方语境下的图片引用（VFS 资源 id / 本地路径 /
/// 导出时的媒体文件名），本模块只做非空校验，不解引用。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OcclusionSpec {
    pub image_ref: String,
    pub boxes: Vec<OcclusionBox>,
}

/// 校验通过后的 spec：所有盒都有合法 cloze 序号与非空标签。
/// 只能通过 [`validate_spec`] 构造，是后续字段构造/渲染 API 的唯一输入类型。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidatedOcclusionSpec {
    pub image_ref: String,
    pub boxes: Vec<OcclusionBox>,
}

/// 结构化校验违规，风格对齐 `anki_qa_lint::LintIssue`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OcclusionIssue {
    /// 机器可读违规码，snake_case，稳定不变。
    pub code: String,
    /// 涉事盒下标（spec 级违规为 None）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub box_index: Option<usize>,
    /// 人类可读中文说明。
    pub message: String,
}

impl OcclusionIssue {
    fn spec(code: &str, message: String) -> Self {
        Self {
            code: code.to_string(),
            box_index: None,
            message,
        }
    }

    fn boxed(code: &str, idx: usize, message: String) -> Self {
        Self {
            code: code.to_string(),
            box_index: Some(idx),
            message,
        }
    }
}

/// 像素坐标盒（渲染/导出边界产物）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelBox {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
    pub label: String,
    pub cloze_index: u32,
}

/// 遮挡草稿字段约定产物；后续接通转换器时可据此填充 `AnkiCard`。
///
/// - `text` → `AnkiCard.text`（Cloze note type 的 `Text` 字段）；
/// - `extra_fields` → 合并进 `AnkiCard.extra_fields`
///   （含 `_occlusion` 协议字段与 `Extra` 提示字段）；
/// - `tags` → 追加进 `AnkiCard.tags`。
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcclusionCardFields {
    pub text: String,
    pub extra_fields: HashMap<String, String>,
    pub tags: Vec<String>,
}

// ============================================================================
// 校验
// ============================================================================

/// 校验并归一化 [`OcclusionSpec`]。
///
/// 拒绝规则（返回全部违规而非首个，便于前端一次性展示）：
/// - `empty_image_ref`：图片引用为空/纯空白；
/// - `empty_boxes`：盒列表为空；
/// - `too_many_boxes`：盒数超过 `max_boxes`；
/// - `box_out_of_bounds`：任一坐标越出 `[0,1]`（含 x+w / y+h 越界）；
/// - `box_too_small`：宽或高小于 `min_box_size`（空盒/退化盒）；
/// - `box_not_finite`：坐标含 NaN/Inf；
/// - `excessive_overlap`：任意两盒 IoU 超过 `max_pairwise_iou`；
/// - `cloze_index_zero`：显式给出的 cloze 序号为 0（Anki 1-based）。
///
/// 归一化行为（不拒绝）：
/// - 缺失 `cloze_index` 的盒按出现顺序补 `已用最大序号+1`；
/// - 空标签补 `区域 N`（N 为该盒 cloze 序号）；
/// - 超长标签按字符截断到 `max_label_chars`。
pub fn validate_spec(
    spec: &OcclusionSpec,
    cfg: &OcclusionConfig,
) -> Result<ValidatedOcclusionSpec, Vec<OcclusionIssue>> {
    let mut issues: Vec<OcclusionIssue> = Vec::new();

    if spec.image_ref.trim().is_empty() {
        issues.push(OcclusionIssue::spec(
            "empty_image_ref",
            "图片引用为空：遮挡卡必须绑定一张图片".to_string(),
        ));
    }

    if spec.boxes.is_empty() {
        issues.push(OcclusionIssue::spec(
            "empty_boxes",
            "遮挡盒列表为空：至少需要 1 个遮挡区域".to_string(),
        ));
        return Err(issues);
    }

    if spec.boxes.len() > cfg.max_boxes {
        issues.push(OcclusionIssue::spec(
            "too_many_boxes",
            format!(
                "遮挡盒数量 {} 超过上限 {}：请拆分为多张卡",
                spec.boxes.len(),
                cfg.max_boxes
            ),
        ));
    }

    for (i, b) in spec.boxes.iter().enumerate() {
        if ![b.x, b.y, b.w, b.h].iter().all(|v| v.is_finite()) {
            issues.push(OcclusionIssue::boxed(
                "box_not_finite",
                i,
                format!("盒 #{i} 坐标含 NaN/Inf"),
            ));
            continue;
        }
        let out_of_bounds = b.x < -EPS
            || b.y < -EPS
            || b.w <= 0.0
            || b.h <= 0.0
            || b.x + b.w > 1.0 + EPS
            || b.y + b.h > 1.0 + EPS;
        if out_of_bounds {
            issues.push(OcclusionIssue::boxed(
                "box_out_of_bounds",
                i,
                format!(
                    "盒 #{i} 越界：x={} y={} w={} h={}（要求归一化 0-1 且 x+w/y+h ≤ 1）",
                    b.x, b.y, b.w, b.h
                ),
            ));
        } else if b.w < cfg.min_box_size || b.h < cfg.min_box_size {
            issues.push(OcclusionIssue::boxed(
                "box_too_small",
                i,
                format!(
                    "盒 #{i} 过小（w={} h={}，最小边长 {}）：疑似空盒",
                    b.w, b.h, cfg.min_box_size
                ),
            ));
        }
        if b.cloze_index == Some(0) {
            issues.push(OcclusionIssue::boxed(
                "cloze_index_zero",
                i,
                format!("盒 #{i} cloze 序号为 0：Anki cloze 序号从 1 开始"),
            ));
        }
    }

    // 仅对几何合法的盒做两两 IoU（越界盒的 IoU 无意义且已被拒绝）。
    let geometry_ok: Vec<usize> = (0..spec.boxes.len())
        .filter(|&i| {
            !issues.iter().any(|iss| {
                iss.box_index == Some(i)
                    && (iss.code == "box_out_of_bounds" || iss.code == "box_not_finite")
            })
        })
        .collect();
    for (a_pos, &a) in geometry_ok.iter().enumerate() {
        for &b in geometry_ok.iter().skip(a_pos + 1) {
            let iou = pairwise_iou(&spec.boxes[a], &spec.boxes[b]);
            if iou > cfg.max_pairwise_iou {
                issues.push(OcclusionIssue::boxed(
                    "excessive_overlap",
                    b,
                    format!(
                        "盒 #{a} 与盒 #{b} 重叠过多（IoU={iou:.2} > {}）：遮挡区域应互不覆盖",
                        cfg.max_pairwise_iou
                    ),
                ));
            }
        }
    }

    if !issues.is_empty() {
        return Err(issues);
    }

    // ---- 归一化：补 cloze 序号 / 补空标签 / 截断超长标签 ----
    let mut next_index: u32 = spec
        .boxes
        .iter()
        .filter_map(|b| b.cloze_index)
        .max()
        .unwrap_or(0);
    let boxes = spec
        .boxes
        .iter()
        .map(|b| {
            let cloze_index = b.cloze_index.unwrap_or_else(|| {
                next_index += 1;
                next_index
            });
            let trimmed = b.label.trim();
            let label = if trimmed.is_empty() {
                format!("区域 {cloze_index}")
            } else {
                truncate_chars(trimmed, cfg.max_label_chars)
            };
            OcclusionBox {
                x: b.x,
                y: b.y,
                w: b.w,
                h: b.h,
                label,
                cloze_index: Some(cloze_index),
            }
        })
        .collect();

    Ok(ValidatedOcclusionSpec {
        image_ref: spec.image_ref.trim().to_string(),
        boxes,
    })
}

/// 两盒 IoU（交并比）。退化盒（w/h ≤ 0）返回 0。
pub fn pairwise_iou(a: &OcclusionBox, b: &OcclusionBox) -> f32 {
    if a.w <= 0.0 || a.h <= 0.0 || b.w <= 0.0 || b.h <= 0.0 {
        return 0.0;
    }
    let ix = (a.x + a.w).min(b.x + b.w) - a.x.max(b.x);
    let iy = (a.y + a.h).min(b.y + b.h) - a.y.max(b.y);
    if ix <= 0.0 || iy <= 0.0 {
        return 0.0;
    }
    let inter = ix * iy;
    let union = a.w * a.h + b.w * b.h - inter;
    if union <= 0.0 {
        0.0
    } else {
        inter / union
    }
}

fn truncate_chars(s: &str, max_chars: usize) -> String {
    if s.chars().count() <= max_chars {
        s.to_string()
    } else {
        s.chars().take(max_chars).collect()
    }
}

// ============================================================================
// 像素换算（渲染/字段构造边界）
// ============================================================================

/// 把归一化盒换算为像素盒。
///
/// 保证（有测试锁定）：
/// - 四舍五入到最近整数像素；
/// - 结果永不越出 `img_w × img_h`（右/下边贴边收敛）；
/// - 宽高最小 1px（防止极小盒四舍五入为 0 导致渲染消失）。
///
/// 图片尺寸为 0 时返回空列表（无意义输入不 panic）。
pub fn to_pixel_boxes(spec: &ValidatedOcclusionSpec, img_w: u32, img_h: u32) -> Vec<PixelBox> {
    if img_w == 0 || img_h == 0 {
        return Vec::new();
    }
    spec.boxes
        .iter()
        .map(|b| {
            let x = ((b.x * img_w as f32).round() as i64).clamp(0, img_w as i64 - 1) as u32;
            let y = ((b.y * img_h as f32).round() as i64).clamp(0, img_h as i64 - 1) as u32;
            let w_raw = (b.w * img_w as f32).round() as i64;
            let h_raw = (b.h * img_h as f32).round() as i64;
            let w = w_raw.max(1).min(img_w as i64 - x as i64) as u32;
            let h = h_raw.max(1).min(img_h as i64 - y as i64) as u32;
            PixelBox {
                x,
                y,
                w,
                h,
                label: b.label.clone(),
                cloze_index: b.cloze_index.unwrap_or(1),
            }
        })
        .collect()
}

// ============================================================================
// 草稿字段约定
// ============================================================================

/// 从校验后的 spec 生成候选 Cloze 字段。
///
/// 生产入库（`parse_and_save_card`）已消费 `text` / `extra_fields` / `tags`；
/// 导出转换仍未接通，本函数本身不代表导出闭环已接通。
///
/// `Text` 字段形如（`image_file_name` 是 APKG 包内媒体文件名，
/// 由调用方从 `image_ref` 解析后传入；为 `None` 时省略 `<img>`，
/// 适用于图片走 `AnkiCard.images` + 前端原生渲染的场景）：
///
/// ```text
/// <img src="diagram.png"><br>{{c1::左心房}} {{c2::右心室}}
/// ```
///
/// `extra_fields`：
/// - `_occlusion`：归一化 spec 的 JSON（前端原生遮挡渲染与再编辑的数据源）；
/// - `Extra`：可选补充说明（Anki 揭底后显示）。
pub fn build_card_fields(
    spec: &ValidatedOcclusionSpec,
    image_file_name: Option<&str>,
    extra_note: Option<&str>,
) -> OcclusionCardFields {
    let cloze_parts: Vec<String> = spec
        .boxes
        .iter()
        .map(|b| {
            format!(
                "{{{{c{}::{}}}}}",
                b.cloze_index.unwrap_or(1),
                escape_cloze_label(&b.label)
            )
        })
        .collect();
    let cloze_text = cloze_parts.join(" ");
    let text = match image_file_name {
        Some(name) if !name.trim().is_empty() => {
            format!(
                "<img src=\"{}\"><br>{}",
                escape_html_attr(name.trim()),
                cloze_text
            )
        }
        _ => cloze_text,
    };

    let mut extra_fields = HashMap::new();
    // ValidatedOcclusionSpec 字段全部可序列化，to_string 不会失败。
    extra_fields.insert(
        OCCLUSION_FIELD.to_string(),
        serde_json::to_string(&spec).unwrap_or_default(),
    );
    if let Some(note) = extra_note.map(str::trim).filter(|s| !s.is_empty()) {
        extra_fields.insert("Extra".to_string(), note.to_string());
    }

    OcclusionCardFields {
        text,
        extra_fields,
        tags: vec![OCCLUSION_TAG.to_string()],
    }
}

/// 从 `extra_fields` 解析回遮挡 spec（前端/后续转换回读路径）。
/// 返回 `None` 表示无 `_occlusion` 字段或 JSON 不合法。
pub fn parse_occlusion_field(extra_fields: &HashMap<String, String>) -> Option<OcclusionSpec> {
    let raw = extra_fields.get(OCCLUSION_FIELD)?;
    serde_json::from_str::<OcclusionSpec>(raw).ok()
}

/// VLM 坐标块不负责选图时使用的占位引用 scheme（完整占位为
/// `vlm://pending-image`，见 [`parse_occlusion_boxes_from_vlm`]）。
/// 与 apkg / AnkiConnect 导出侧的 `vlm://` 无图降级约定一致。
const VLM_PENDING_IMAGE_SCHEME: &str = "vlm://";

/// 从卡片 `extra_fields` 解析遮挡图片引用（入库侧填充 `AnkiCard.images` 用）。
///
/// 读取 `_occlusion` JSON 的 `imageRef`（serde camelCase 契约），并容忍
/// 手写/旧数据的 `image_ref` snake_case 键。以下情况返回 `None`：
/// 无 `_occlusion` 字段、JSON 不合法、引用为空/纯空白，以及引用为
/// `vlm://` 占位（未被生产接线替换的 `vlm://pending-image` 不是可解析
/// 媒体，r2 契约 §2.1 要求不入 images；导出两侧同样过滤该 scheme）。
pub fn occlusion_image_ref_from_fields(extra: &HashMap<String, String>) -> Option<String> {
    let raw = extra.get(OCCLUSION_FIELD)?;
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let image_ref = value
        .get("imageRef")
        .or_else(|| value.get("image_ref"))
        .and_then(serde_json::Value::as_str)?
        .trim();
    (!image_ref.is_empty() && !image_ref.starts_with(VLM_PENDING_IMAGE_SCHEME))
        .then(|| image_ref.to_string())
}

/// 把校验后的 spec 渲染为 Anki 23.10+ 原生 Image Occlusion 的
/// `Occlusion` 字段 cloze 语法。每个盒形如：
///
/// ```text
/// {{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.15}}
/// ```
///
/// `left/top/width/height` 为 **0–1 归一化小数**（对齐 Anki 官方
/// `to-cloze.ts` 文档示例
/// `{{c1::image-occlusion:rect:top=.1:left=.23:width=.4:height=.5}}`），
/// 最多保留 4 位小数并去尾零；本实现选用官方示例的**前导点风格**
/// （`0.125` → `.125`，见 [`format_io_coord`]）。**禁止写 ×100 百分数**：
/// 百分数会让 Anki 遮罩放大 100 倍。多盒按 Anki 官方编辑器惯例直接拼接
/// （无分隔符）。本函数只负责字符串构造；导出侧尚未消费该格式
/// （见模块头「当前产品边界」）。
pub fn format_anki_io_cloze(spec: &ValidatedOcclusionSpec) -> String {
    spec.boxes
        .iter()
        .map(|b| {
            format!(
                "{{{{c{}::image-occlusion:rect:left={}:top={}:width={}:height={}}}}}",
                b.cloze_index.unwrap_or(1),
                format_io_coord(b.x),
                format_io_coord(b.y),
                format_io_coord(b.w),
                format_io_coord(b.h),
            )
        })
        .collect::<Vec<_>>()
        .concat()
}

/// 归一化坐标 → 0–1 小数字符串：夹取 [0,1]、最多 4 位小数、去尾零，
/// 并按官方 `to-cloze.ts` 示例采用前导点风格（`0.125` → `.125`；
/// 整数值 `0` / `1` 原样输出）。
fn format_io_coord(v: f32) -> String {
    let norm = f64::from(v).clamp(0.0, 1.0);
    let s = format!("{norm:.4}");
    let s = s.trim_end_matches('0').trim_end_matches('.');
    match s.strip_prefix("0.") {
        Some(frac) => format!(".{frac}"),
        None => s.to_string(),
    }
}

/// 取图片引用的 basename（剥离 `/` 与 `\` 路径段），供 `<img src>` 使用。
/// 引用以分隔符结尾（无文件名部分）时返回 `None`，调用方省略 `<img>`。
fn image_ref_basename(image_ref: &str) -> Option<&str> {
    let name = image_ref.rsplit(['/', '\\']).next()?.trim();
    (!name.is_empty()).then_some(name)
}

/// cloze 标签内 `}}` 会破坏 cloze 语法，`::` 会被 Anki 解析为 hint 分隔符。
fn escape_cloze_label(label: &str) -> String {
    label.replace("}}", "} }").replace("::", "：：")
}

fn escape_html_attr(s: &str) -> String {
    s.replace('&', "&amp;").replace('"', "&quot;")
}

// ============================================================================
// VLM 归一化坐标解析
// ============================================================================

/// 从 VLM 文本的 `[OCCLUSION_BOXES]` 块解析归一化遮挡坐标。
///
/// 块内契约是 [`OcclusionBox`] JSON 数组。解析器容忍 Markdown 代码围栏、
/// 块内数组前后的少量说明文字，以及数组/对象末尾多余逗号。每个候选块都必须
/// 通过默认配置的 [`validate_spec`]；空块、坏 JSON、越界、过小、过度重叠或
/// 超量盒均返回 `None`（存在多个块时会继续尝试后续块）。
///
/// VLM 块不负责选择图片，因此返回 spec 的 `image_ref` 是内部占位引用；
/// 生产调用点在生成草稿 marker 前必须替换为实际图片引用。
pub fn parse_occlusion_boxes_from_vlm(text: &str) -> Option<OcclusionSpec> {
    for block in occlusion_box_blocks(text) {
        let Some(json) = extract_first_json_array(block) else {
            continue;
        };
        let sanitized = strip_json_trailing_commas(json);
        let Ok(boxes) = serde_json::from_str::<Vec<OcclusionBox>>(&sanitized) else {
            continue;
        };
        let candidate = OcclusionSpec {
            image_ref: "vlm://pending-image".to_string(),
            boxes,
        };
        let Ok(validated) = validate_spec(&candidate, &OcclusionConfig::default()) else {
            continue;
        };
        return Some(OcclusionSpec {
            image_ref: validated.image_ref,
            boxes: validated.boxes,
        });
    }
    None
}

/// 从面向制卡模型的正文中剥离 VLM 坐标块。
///
/// 完整块连同内部代码围栏一起删除；若模型输出了开始标记却遗漏结束标记，
/// 从开始标记到文本末尾一并删除，避免协议 JSON 被误制成垃圾卡。
pub fn strip_occlusion_boxes_blocks(text: &str) -> String {
    let Some(_) = text.find(OCCLUSION_BOXES_OPEN) else {
        return text.to_string();
    };

    let mut out = String::with_capacity(text.len());
    let mut remaining = text;
    while let Some(open_rel) = remaining.find(OCCLUSION_BOXES_OPEN) {
        out.push_str(&remaining[..open_rel]);
        let after_open = &remaining[open_rel + OCCLUSION_BOXES_OPEN.len()..];
        let Some(close_rel) = after_open.find(OCCLUSION_BOXES_CLOSE) else {
            remaining = "";
            break;
        };
        remaining = &after_open[close_rel + OCCLUSION_BOXES_CLOSE.len()..];
    }
    out.push_str(remaining);
    out.trim().to_string()
}

fn occlusion_box_blocks(text: &str) -> Vec<&str> {
    let mut blocks = Vec::new();
    let mut remaining = text;
    while let Some(open_rel) = remaining.find(OCCLUSION_BOXES_OPEN) {
        let after_open = &remaining[open_rel + OCCLUSION_BOXES_OPEN.len()..];
        let Some(close_rel) = after_open.find(OCCLUSION_BOXES_CLOSE) else {
            break;
        };
        blocks.push(&after_open[..close_rel]);
        remaining = &after_open[close_rel + OCCLUSION_BOXES_CLOSE.len()..];
    }
    blocks
}

/// 找出块内第一个完整 JSON 数组，忽略围栏与数组前后 Markdown。
fn extract_first_json_array(text: &str) -> Option<&str> {
    let mut start = None;
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;

    for (idx, ch) in text.char_indices() {
        if start.is_none() {
            if ch == '[' {
                start = Some(idx);
                depth = 1;
            }
            continue;
        }
        if in_string {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => in_string = true,
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&text[start.unwrap_or(0)..idx + ch.len_utf8()]);
                }
            }
            _ => {}
        }
    }
    None
}

/// 删除 JSON 数组/对象闭合符前的尾随逗号，不改动字符串内的逗号。
fn strip_json_trailing_commas(json: &str) -> String {
    let chars: Vec<char> = json.chars().collect();
    let mut out = String::with_capacity(json.len());
    let mut in_string = false;
    let mut escaped = false;

    for (idx, &ch) in chars.iter().enumerate() {
        if in_string {
            out.push(ch);
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_string = false;
            }
            continue;
        }
        if ch == '"' {
            in_string = true;
            out.push(ch);
            continue;
        }
        if ch == ',' {
            let next_non_whitespace = chars[idx + 1..].iter().find(|c| !c.is_whitespace());
            if matches!(next_non_whitespace, Some(']' | '}')) {
                continue;
            }
        }
        out.push(ch);
    }
    out
}

// ============================================================================
// IMAGE_DESC 启发式盒建议（零 LLM 成本首版桥）
// ============================================================================

/// 从 VLM 产出的 `[IMAGE_DESC: ...]` 条目文本启发式提出遮挡盒。
///
/// **定位**：现有 VlmFull/VlmLight 提示词要求模型对图表输出条目式
/// `[IMAGE_DESC: ...]`，但**没有坐标**。本函数把条目拆成标签，按
/// 近方形网格布局出归一化候选盒——首版价值是打通「描述 → 可编辑遮挡卡」
/// 数据流，坐标精度交给前端拖拽微调与后续 VLM grounding（见 round4 文档）。
///
/// 规则：
/// - 优先取全部 `[IMAGE_DESC: ...]` 标记内的内容；无标记时退化为全文；
/// - 按条目分隔符（`；` `;` 换行 bullet `→` 等）切分，去重、去空、
///   截断超长，取前 `max_boxes` 条；
/// - 网格布局：`cols = ceil(sqrt(n))`，每盒占单元格的 72%（居中），
///   保证任意两盒不相交、全部盒在 `[0,1]` 内；
/// - 输出盒 cloze 序号从 1 顺序编号，直接可过 `validate_spec`。
///
/// 输入为空/无有效条目时返回空 Vec（调用方据此回退为普通卡）。
pub fn propose_boxes_from_image_desc(desc: &str, max_boxes: usize) -> Vec<OcclusionBox> {
    if max_boxes == 0 {
        return Vec::new();
    }
    let labels = extract_desc_labels(desc, max_boxes);
    layout_grid_boxes(&labels)
}

/// 把 VLM 的 IMAGE_DESC 与图片引用封装成内部草稿 marker。
///
/// 这是当前最小生产接线的唯一入口：无图片引用、无有效标签或校验失败时返回
/// `None`，调用方继续走普通卡路径。marker 只携带可编辑的启发式网格草稿，
/// 不宣称是真实图像坐标。
pub fn build_occlusion_draft_marker(
    image_ref: &str,
    image_desc: &str,
    cfg: &OcclusionConfig,
) -> Option<String> {
    let boxes = propose_boxes_from_image_desc(image_desc, cfg.max_boxes);
    if boxes.is_empty() {
        return None;
    }
    build_occlusion_draft_marker_from_spec(
        &OcclusionSpec {
            image_ref: image_ref.to_string(),
            boxes,
        },
        cfg,
    )
}

/// 校验真实坐标 spec 并封装成内部草稿 marker。
///
/// 与 [`build_occlusion_draft_marker`] 共用同一校验与序列化边界，调用方可先把
/// [`parse_occlusion_boxes_from_vlm`] 返回值的占位 `image_ref` 替换为真实引用。
pub fn build_occlusion_draft_marker_from_spec(
    spec: &OcclusionSpec,
    cfg: &OcclusionConfig,
) -> Option<String> {
    let validated = validate_spec(spec, cfg).ok()?;
    let json = serde_json::to_string(&validated).ok()?;
    Some(format!("{OCCLUSION_DRAFT_PREFIX}{json}]"))
}

/// 从包含内部草稿 marker 的分段内容构建待合并的卡片字段。
///
/// `text` 以 `image_ref` 的 basename（剥离路径后的文件名）构造 `<img src>`
/// 前缀，使入库卡携带可渲染的图片引用 + cloze 正文。
///
/// 解析/校验失败返回 `None`，绝不阻断普通卡生成。调用方只应把返回值合并到
/// 一张成功卡，避免同一图片草稿被复制到分段内所有卡片。
pub fn extract_occlusion_draft_fields(content: &str) -> Option<OcclusionCardFields> {
    let raw = content.lines().find_map(|line| {
        line.trim()
            .strip_prefix(OCCLUSION_DRAFT_PREFIX)?
            .strip_suffix(']')
    })?;
    let spec: OcclusionSpec = serde_json::from_str(raw).ok()?;
    let validated = validate_spec(&spec, &OcclusionConfig::default()).ok()?;
    let image_file_name = image_ref_basename(&validated.image_ref);
    Some(build_card_fields(&validated, image_file_name, None))
}

/// 从送给制卡模型的学习材料中剥离内部草稿 marker。
///
/// marker 只供后端字段接线使用，不应成为模型可见内容或被制成“协议卡”。
pub fn strip_occlusion_draft_markers(content: &str) -> String {
    content
        .lines()
        .filter(|line| {
            let trimmed = line.trim();
            !(trimmed.starts_with(OCCLUSION_DRAFT_PREFIX) && trimmed.ends_with(']'))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 从文本中提取候选标签（拆条目 + 清洗 + 去重 + 截断数量）。
fn extract_desc_labels(desc: &str, max_labels: usize) -> Vec<String> {
    let mut source_segments: Vec<String> = Vec::new();
    let mut search_from = 0usize;
    let bytes = desc.as_bytes();
    // 手工扫描 [IMAGE_DESC: ...]，容忍同一文本多处标记。
    while let Some(rel) = desc[search_from..].find("[IMAGE_DESC:") {
        let start = search_from + rel + "[IMAGE_DESC:".len();
        let end = desc[start..]
            .find(']')
            .map(|e| start + e)
            .unwrap_or(bytes.len());
        source_segments.push(desc[start..end].to_string());
        search_from = end.min(bytes.len());
        if search_from >= bytes.len() {
            break;
        }
    }
    if source_segments.is_empty() {
        source_segments.push(desc.to_string());
    }

    let mut labels: Vec<String> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for segment in source_segments {
        for item in split_desc_items(&segment) {
            let cleaned = clean_label_text(&item);
            // 过短条目（如序号残渣）没有遮挡价值。
            if cleaned.chars().count() < 2 {
                continue;
            }
            let key = cleaned.to_lowercase();
            if seen.insert(key) {
                labels.push(cleaned);
                if labels.len() >= max_labels {
                    return labels;
                }
            }
        }
    }
    labels
}

/// 条目切分：换行、分号、冒号、箭头、顿号均视为条目边界。
fn split_desc_items(segment: &str) -> Vec<String> {
    segment
        .split(['\n', ';', '；', '、', '：'])
        .flat_map(|part| part.split("→"))
        .flat_map(|part| part.split("->"))
        .map(|s| s.to_string())
        .collect()
}

/// 去 bullet 前缀 / 序号前缀 / 首尾空白与标点。
fn clean_label_text(raw: &str) -> String {
    let mut s = raw.trim();
    for prefix in ["-", "*", "•", "·"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.trim_start();
        }
    }
    // 去 "1." / "2、" / "(3)" 式序号前缀
    let chars: Vec<char> = s.chars().collect();
    let mut idx = 0;
    while idx < chars.len() && (chars[idx].is_ascii_digit() || "().、. ".contains(chars[idx])) {
        idx += 1;
    }
    // 序号前缀最多吃掉 4 个字符，避免误伤 "2023年营收" 这类正文。
    let stripped: String = if idx > 0 && idx <= 4 && idx < chars.len() {
        chars[idx..].iter().collect()
    } else {
        s.to_string()
    };
    stripped
        .trim()
        .trim_end_matches(['。', '.', '，', ','])
        .trim()
        .to_string()
}

/// 近方形网格布局：n 个标签 → n 个互不相交的归一化盒。
fn layout_grid_boxes(labels: &[String]) -> Vec<OcclusionBox> {
    let n = labels.len();
    if n == 0 {
        return Vec::new();
    }
    let cols = (n as f32).sqrt().ceil() as usize;
    let rows = n.div_ceil(cols);
    let cell_w = 1.0 / cols as f32;
    let cell_h = 1.0 / rows as f32;
    // 盒占单元格 72%，居中；剩余 28% 是格间距，保证两两不相交。
    const FILL: f32 = 0.72;
    labels
        .iter()
        .enumerate()
        .map(|(i, label)| {
            let col = i % cols;
            let row = i / cols;
            let w = cell_w * FILL;
            let h = cell_h * FILL;
            let x = col as f32 * cell_w + (cell_w - w) / 2.0;
            let y = row as f32 * cell_h + (cell_h - h) / 2.0;
            OcclusionBox {
                x,
                y,
                w,
                h,
                label: label.clone(),
                cloze_index: Some(i as u32 + 1),
            }
        })
        .collect()
}

// ============================================================================
// 测试
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn make_box(x: f32, y: f32, w: f32, h: f32) -> OcclusionBox {
        OcclusionBox {
            x,
            y,
            w,
            h,
            label: "测试标签".to_string(),
            cloze_index: None,
        }
    }

    fn make_spec(boxes: Vec<OcclusionBox>) -> OcclusionSpec {
        OcclusionSpec {
            image_ref: "vfs://images/diagram.png".to_string(),
            boxes,
        }
    }

    fn codes(err: &[OcclusionIssue]) -> Vec<&str> {
        err.iter().map(|i| i.code.as_str()).collect()
    }

    // ---- 校验：拒绝路径 ----

    #[test]
    fn test_reject_empty_boxes() {
        let err = validate_spec(&make_spec(vec![]), &OcclusionConfig::default()).unwrap_err();
        assert_eq!(codes(&err), vec!["empty_boxes"]);
    }

    #[test]
    fn test_reject_empty_image_ref() {
        let spec = OcclusionSpec {
            image_ref: "   ".to_string(),
            boxes: vec![make_box(0.1, 0.1, 0.2, 0.2)],
        };
        let err = validate_spec(&spec, &OcclusionConfig::default()).unwrap_err();
        assert_eq!(codes(&err), vec!["empty_image_ref"]);
    }

    #[test]
    fn test_reject_out_of_bounds() {
        // 三种越界形态：负坐标 / x+w>1 / 零宽
        for (i, b) in [
            make_box(-0.1, 0.1, 0.2, 0.2),
            make_box(0.9, 0.1, 0.2, 0.2),
            make_box(0.1, 0.1, 0.0, 0.2),
        ]
        .into_iter()
        .enumerate()
        {
            let err = validate_spec(&make_spec(vec![b]), &OcclusionConfig::default()).unwrap_err();
            assert_eq!(codes(&err), vec!["box_out_of_bounds"], "case {i}");
            assert_eq!(err[0].box_index, Some(0), "case {i}");
        }
        // 恰好贴边（x+w == 1.0）不算越界
        let ok = validate_spec(
            &make_spec(vec![make_box(0.8, 0.8, 0.2, 0.2)]),
            &OcclusionConfig::default(),
        );
        assert!(ok.is_ok());
    }

    #[test]
    fn test_reject_too_small_and_nan() {
        let err = validate_spec(
            &make_spec(vec![make_box(0.1, 0.1, 0.005, 0.2)]),
            &OcclusionConfig::default(),
        )
        .unwrap_err();
        assert_eq!(codes(&err), vec!["box_too_small"]);

        let err = validate_spec(
            &make_spec(vec![make_box(f32::NAN, 0.1, 0.2, 0.2)]),
            &OcclusionConfig::default(),
        )
        .unwrap_err();
        assert_eq!(codes(&err), vec!["box_not_finite"]);
    }

    #[test]
    fn test_reject_excessive_overlap_but_allow_touching() {
        // 两盒几乎重合 → IoU ≈ 0.68 > 0.35 拒绝
        let err = validate_spec(
            &make_spec(vec![
                make_box(0.1, 0.1, 0.3, 0.3),
                make_box(0.15, 0.15, 0.3, 0.3),
            ]),
            &OcclusionConfig::default(),
        )
        .unwrap_err();
        assert_eq!(codes(&err), vec!["excessive_overlap"]);

        // 相邻贴边（IoU = 0）通过
        let ok = validate_spec(
            &make_spec(vec![
                make_box(0.0, 0.0, 0.5, 0.5),
                make_box(0.5, 0.0, 0.5, 0.5),
            ]),
            &OcclusionConfig::default(),
        );
        assert!(ok.is_ok());
    }

    #[test]
    fn test_reject_too_many_boxes_and_zero_cloze_index() {
        let cfg = OcclusionConfig::default();
        let boxes: Vec<OcclusionBox> = (0..13)
            .map(|i| make_box((i % 4) as f32 * 0.25, (i / 4) as f32 * 0.25, 0.1, 0.1))
            .collect();
        let err = validate_spec(&make_spec(boxes), &cfg).unwrap_err();
        assert!(codes(&err).contains(&"too_many_boxes"));

        let mut b = make_box(0.1, 0.1, 0.2, 0.2);
        b.cloze_index = Some(0);
        let err = validate_spec(&make_spec(vec![b]), &cfg).unwrap_err();
        assert_eq!(codes(&err), vec!["cloze_index_zero"]);
    }

    #[test]
    fn test_multiple_issues_reported_together() {
        // 越界盒 + 空 image_ref：两条违规一次性返回
        let spec = OcclusionSpec {
            image_ref: String::new(),
            boxes: vec![make_box(0.9, 0.9, 0.5, 0.5)],
        };
        let err = validate_spec(&spec, &OcclusionConfig::default()).unwrap_err();
        let cs = codes(&err);
        assert!(cs.contains(&"empty_image_ref"));
        assert!(cs.contains(&"box_out_of_bounds"));
    }

    // ---- 校验：归一化路径 ----

    #[test]
    fn test_auto_assign_cloze_index_and_label() {
        let mut b1 = make_box(0.0, 0.0, 0.3, 0.3);
        b1.label = String::new(); // 空标签自动补
        let mut b2 = make_box(0.5, 0.0, 0.3, 0.3);
        b2.cloze_index = Some(5); // 显式序号保留
        let b3 = make_box(0.0, 0.5, 0.3, 0.3); // 缺序号 → 从已用最大值 +1

        let v = validate_spec(&make_spec(vec![b1, b2, b3]), &OcclusionConfig::default())
            .expect("should pass");
        assert_eq!(v.boxes[0].cloze_index, Some(6));
        assert_eq!(v.boxes[0].label, "区域 6");
        assert_eq!(v.boxes[1].cloze_index, Some(5));
        assert_eq!(v.boxes[2].cloze_index, Some(7));
    }

    #[test]
    fn test_duplicate_cloze_index_allowed_and_label_truncated() {
        // Anki 语义：同序号盒同组隐藏，合法
        let mut b1 = make_box(0.0, 0.0, 0.3, 0.3);
        b1.cloze_index = Some(1);
        let mut b2 = make_box(0.5, 0.0, 0.3, 0.3);
        b2.cloze_index = Some(1);
        b2.label = "长".repeat(100);
        let v = validate_spec(&make_spec(vec![b1, b2]), &OcclusionConfig::default())
            .expect("duplicate index should pass");
        assert_eq!(v.boxes[0].cloze_index, Some(1));
        assert_eq!(v.boxes[1].cloze_index, Some(1));
        assert_eq!(v.boxes[1].label.chars().count(), 48);
    }

    // ---- IoU ----

    #[test]
    fn test_pairwise_iou_values() {
        // 完全重合 → 1.0
        let a = make_box(0.1, 0.1, 0.4, 0.4);
        assert!((pairwise_iou(&a, &a) - 1.0).abs() < 1e-6);
        // 不相交 → 0.0
        let b = make_box(0.6, 0.6, 0.2, 0.2);
        assert_eq!(pairwise_iou(&a, &b), 0.0);
        // 半重叠：交 0.2×0.4，并 2×(0.4×0.4)−0.08 → IoU = 1/3
        let c = make_box(0.3, 0.1, 0.4, 0.4);
        assert!((pairwise_iou(&a, &c) - 1.0 / 3.0).abs() < 1e-5);
    }

    // ---- 像素换算 ----

    #[test]
    fn test_to_pixel_boxes_exact_conversion() {
        let v = validate_spec(
            &make_spec(vec![make_box(0.25, 0.5, 0.5, 0.25)]),
            &OcclusionConfig::default(),
        )
        .unwrap();
        let px = to_pixel_boxes(&v, 800, 600);
        assert_eq!(px.len(), 1);
        assert_eq!((px[0].x, px[0].y, px[0].w, px[0].h), (200, 300, 400, 150));
        assert_eq!(px[0].cloze_index, 1);
    }

    #[test]
    fn test_to_pixel_boxes_clamp_and_min_size() {
        // 贴右下边 + 极小盒：四舍五入后不得越界、不得为 0
        let v = validate_spec(
            &make_spec(vec![
                make_box(0.9, 0.9, 0.1, 0.1),     // 贴边
                make_box(0.5, 0.5, 0.011, 0.011), // 刚过 min_box_size，3px 图上会取整为 0
            ]),
            &OcclusionConfig::default(),
        )
        .unwrap();
        let px = to_pixel_boxes(&v, 3, 3);
        for p in &px {
            assert!(p.w >= 1 && p.h >= 1, "min 1px: {p:?}");
            assert!(p.x + p.w <= 3 && p.y + p.h <= 3, "in bounds: {p:?}");
        }
        // 尺寸为 0 的图返回空
        assert!(to_pixel_boxes(&v, 0, 100).is_empty());
    }

    // ---- 导出字段约定 ----

    #[test]
    fn test_build_card_fields_cloze_text_and_occlusion_json() {
        let mut b1 = make_box(0.0, 0.0, 0.3, 0.3);
        b1.label = "左心房".to_string();
        let mut b2 = make_box(0.5, 0.0, 0.3, 0.3);
        b2.label = "右心室".to_string();
        let v = validate_spec(&make_spec(vec![b1, b2]), &OcclusionConfig::default()).unwrap();

        let fields = build_card_fields(&v, Some("diagram.png"), Some("心脏解剖图"));
        assert_eq!(
            fields.text,
            "<img src=\"diagram.png\"><br>{{c1::左心房}} {{c2::右心室}}"
        );
        assert_eq!(
            fields.extra_fields.get("Extra").map(String::as_str),
            Some("心脏解剖图")
        );
        assert_eq!(fields.tags, vec![OCCLUSION_TAG.to_string()]);

        // _occlusion JSON 可解析回 spec（round-trip），供前端原生渲染
        let parsed = parse_occlusion_field(&fields.extra_fields).expect("_occlusion parseable");
        assert_eq!(parsed.image_ref, "vfs://images/diagram.png");
        assert_eq!(parsed.boxes.len(), 2);
        assert_eq!(parsed.boxes[0].label, "左心房");
        assert_eq!(parsed.boxes[0].cloze_index, Some(1));
    }

    #[test]
    fn test_build_card_fields_without_image_and_label_escaping() {
        let mut b = make_box(0.1, 0.1, 0.3, 0.3);
        b.label = "A::B}}C".to_string();
        let v = validate_spec(&make_spec(vec![b]), &OcclusionConfig::default()).unwrap();
        let fields = build_card_fields(&v, None, None);
        // 无 img；:: 与 }} 已被转义，不破坏 cloze 语法
        assert_eq!(fields.text, "{{c1::A：：B} }C}}");
        assert!(!fields.extra_fields.contains_key("Extra"));
    }

    #[test]
    fn test_parse_occlusion_field_invalid_json() {
        let mut fields = HashMap::new();
        assert!(parse_occlusion_field(&fields).is_none());
        fields.insert(OCCLUSION_FIELD.to_string(), "not json".to_string());
        assert!(parse_occlusion_field(&fields).is_none());
    }

    #[test]
    fn test_occlusion_image_ref_from_fields_camel_and_snake_case() {
        // camelCase：build_card_fields 产出的 _occlusion round-trip
        let v = validate_spec(
            &make_spec(vec![make_box(0.1, 0.1, 0.2, 0.2)]),
            &OcclusionConfig::default(),
        )
        .unwrap();
        let fields = build_card_fields(&v, None, None);
        assert_eq!(
            occlusion_image_ref_from_fields(&fields.extra_fields).as_deref(),
            Some("vfs://images/diagram.png")
        );

        // snake_case：容忍手写/旧数据
        let mut snake = HashMap::new();
        snake.insert(
            OCCLUSION_FIELD.to_string(),
            r#"{"image_ref":"legacy.png","boxes":[]}"#.to_string(),
        );
        assert_eq!(
            occlusion_image_ref_from_fields(&snake).as_deref(),
            Some("legacy.png")
        );
    }

    #[test]
    fn test_occlusion_image_ref_from_fields_missing_or_invalid() {
        let mut fields: HashMap<String, String> = HashMap::new();
        assert!(occlusion_image_ref_from_fields(&fields).is_none());
        fields.insert(OCCLUSION_FIELD.to_string(), "not json".to_string());
        assert!(occlusion_image_ref_from_fields(&fields).is_none());
        fields.insert(
            OCCLUSION_FIELD.to_string(),
            r#"{"imageRef":"   ","boxes":[]}"#.to_string(),
        );
        assert!(occlusion_image_ref_from_fields(&fields).is_none());
    }

    #[test]
    fn test_occlusion_image_ref_from_fields_rejects_vlm_pending_placeholder() {
        // r2 契约 §2.1：未被生产接线替换的 vlm:// 占位不入 images。
        let mut fields: HashMap<String, String> = HashMap::new();
        fields.insert(
            OCCLUSION_FIELD.to_string(),
            r#"{"imageRef":"vlm://pending-image","boxes":[]}"#.to_string(),
        );
        assert!(occlusion_image_ref_from_fields(&fields).is_none());
        // 前后空白不影响占位判定
        fields.insert(
            OCCLUSION_FIELD.to_string(),
            r#"{"imageRef":"  vlm://pending-image  ","boxes":[]}"#.to_string(),
        );
        assert!(occlusion_image_ref_from_fields(&fields).is_none());
        // 真实引用（含 vfs:// scheme）不受影响
        fields.insert(
            OCCLUSION_FIELD.to_string(),
            r#"{"imageRef":"vfs://images/diagram.png","boxes":[]}"#.to_string(),
        );
        assert_eq!(
            occlusion_image_ref_from_fields(&fields).as_deref(),
            Some("vfs://images/diagram.png")
        );
    }

    // ---- Anki 原生 IO cloze 语法 ----

    #[test]
    fn test_format_anki_io_cloze_normalized_coordinates() {
        let mut b1 = make_box(0.1, 0.2, 0.3, 0.15);
        b1.cloze_index = Some(1);
        let mut b2 = make_box(0.5, 0.625, 0.125, 0.25);
        b2.cloze_index = Some(2);
        let v = validate_spec(&make_spec(vec![b1, b2]), &OcclusionConfig::default()).unwrap();
        // 0–1 归一化小数 + 前导点风格（对齐官方 to-cloze.ts），不是 ×100 百分数
        assert_eq!(
            format_anki_io_cloze(&v),
            "{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.15}}\
             {{c2::image-occlusion:rect:left=.5:top=.625:width=.125:height=.25}}"
        );
    }

    #[test]
    fn test_format_anki_io_cloze_rounds_to_four_decimals_and_trims_zeros() {
        // 0.3333 → ".3333"（f32 精度经 4 位小数舍入吸收）；0 → "0"；
        // 0.125/0.0625 二进制精确 → ".125" / ".0625"，无尾零残留
        let mut b = make_box(0.3333, 0.0, 0.125, 0.0625);
        b.cloze_index = Some(7);
        let v = validate_spec(&make_spec(vec![b]), &OcclusionConfig::default()).unwrap();
        assert_eq!(
            format_anki_io_cloze(&v),
            "{{c7::image-occlusion:rect:left=.3333:top=0:width=.125:height=.0625}}"
        );
    }

    // ---- VLM 归一化坐标 ----

    #[test]
    fn test_parse_vlm_occlusion_boxes_valid_json() {
        let text = r#"[OCCLUSION_BOXES]
[{"x":0.1,"y":0.2,"w":0.3,"h":0.15,"label":"左心房"}]
[/OCCLUSION_BOXES]"#;
        let spec = parse_occlusion_boxes_from_vlm(text).expect("合法坐标应解析");
        assert_eq!(spec.image_ref, "vlm://pending-image");
        assert_eq!(spec.boxes.len(), 1);
        assert_eq!(spec.boxes[0].label, "左心房");
        assert_eq!(spec.boxes[0].cloze_index, Some(1));
        assert!((spec.boxes[0].x - 0.1).abs() < EPS);
        assert!((spec.boxes[0].h - 0.15).abs() < EPS);
    }

    #[test]
    fn test_parse_vlm_occlusion_boxes_amid_markdown_and_fence() {
        let text = r#"# 心脏结构
[IMAGE_DESC: 左心房；右心室]

[OCCLUSION_BOXES]
```json
[
  {"x":0.05,"y":0.1,"w":0.2,"h":0.2,"label":"左心房"},
  {"x":0.65,"y":0.6,"w":0.2,"h":0.2,"label":"右心室"}
]
```
[/OCCLUSION_BOXES]

后续 Markdown。"#;
        let spec = parse_occlusion_boxes_from_vlm(text).expect("围栏不应影响解析");
        assert_eq!(spec.boxes.len(), 2);
        assert_eq!(spec.boxes[1].label, "右心室");
    }

    #[test]
    fn test_parse_vlm_occlusion_boxes_tolerates_trailing_commas() {
        let text = r#"[OCCLUSION_BOXES]
[
  {"x":0.1,"y":0.2,"w":0.3,"h":0.15,"label":"A, B",},
]
[/OCCLUSION_BOXES]"#;
        let spec = parse_occlusion_boxes_from_vlm(text).expect("尾随逗号应被清理");
        assert_eq!(spec.boxes[0].label, "A, B");
    }

    #[test]
    fn test_parse_vlm_occlusion_boxes_rejects_empty_block() {
        assert!(
            parse_occlusion_boxes_from_vlm("正文\n[OCCLUSION_BOXES]\n\n[/OCCLUSION_BOXES]")
                .is_none()
        );
    }

    #[test]
    fn test_parse_vlm_occlusion_boxes_rejects_malformed_json() {
        assert!(parse_occlusion_boxes_from_vlm(
            "[OCCLUSION_BOXES]\n[{x: 0.1}]\n[/OCCLUSION_BOXES]"
        )
        .is_none());
    }

    #[test]
    fn test_parse_vlm_occlusion_boxes_rejects_negative_coordinate() {
        let text = r#"[OCCLUSION_BOXES]
[{"x":-0.01,"y":0.2,"w":0.3,"h":0.15,"label":"越界"}]
[/OCCLUSION_BOXES]"#;
        assert!(parse_occlusion_boxes_from_vlm(text).is_none());
    }

    #[test]
    fn test_parse_vlm_occlusion_boxes_rejects_extent_past_one() {
        let text = r#"[OCCLUSION_BOXES]
[{"x":0.8,"y":0.2,"w":0.3,"h":0.15,"label":"越界"}]
[/OCCLUSION_BOXES]"#;
        assert!(parse_occlusion_boxes_from_vlm(text).is_none());
    }

    #[test]
    fn test_parse_vlm_occlusion_boxes_rejects_too_small_box() {
        let text = r#"[OCCLUSION_BOXES]
[{"x":0.1,"y":0.2,"w":0.001,"h":0.15,"label":"过小"}]
[/OCCLUSION_BOXES]"#;
        assert!(parse_occlusion_boxes_from_vlm(text).is_none());
    }

    #[test]
    fn test_parse_vlm_occlusion_boxes_rejects_excessive_overlap() {
        let text = r#"[OCCLUSION_BOXES]
[
  {"x":0.1,"y":0.1,"w":0.4,"h":0.4,"label":"A"},
  {"x":0.12,"y":0.12,"w":0.4,"h":0.4,"label":"B"}
]
[/OCCLUSION_BOXES]"#;
        assert!(parse_occlusion_boxes_from_vlm(text).is_none());
    }

    #[test]
    fn test_parse_vlm_occlusion_boxes_rejects_more_than_default_limit() {
        let boxes = (0..13)
            .map(|i| {
                format!(
                    r#"{{"x":{},"y":{},"w":0.02,"h":0.02,"label":"B{i}"}}"#,
                    (i % 4) as f32 * 0.24,
                    (i / 4) as f32 * 0.24
                )
            })
            .collect::<Vec<_>>()
            .join(",");
        let text = format!("{OCCLUSION_BOXES_OPEN}\n[{boxes}]\n{OCCLUSION_BOXES_CLOSE}");
        assert!(parse_occlusion_boxes_from_vlm(&text).is_none());
    }

    #[test]
    fn test_parse_vlm_occlusion_boxes_uses_later_valid_block() {
        let text = r#"[OCCLUSION_BOXES]
[{"x":1.1,"y":0.2,"w":0.3,"h":0.15,"label":"坏"}]
[/OCCLUSION_BOXES]
[OCCLUSION_BOXES]
[{"x":0.1,"y":0.2,"w":0.3,"h":0.15,"label":"好"}]
[/OCCLUSION_BOXES]"#;
        let spec = parse_occlusion_boxes_from_vlm(text).expect("应继续尝试后续块");
        assert_eq!(spec.boxes[0].label, "好");
    }

    #[test]
    fn test_strip_vlm_occlusion_boxes_block_from_markdown() {
        let text = r#"# 标题
正文

[OCCLUSION_BOXES]
```json
[{"x":0.1,"y":0.2,"w":0.3,"h":0.15,"label":"垃圾协议"}]
```
[/OCCLUSION_BOXES]

结尾"#;
        let stripped = strip_occlusion_boxes_blocks(text);
        assert_eq!(stripped, "# 标题\n正文\n\n\n\n结尾");
        assert!(!stripped.contains("垃圾协议"));
        assert!(!stripped.contains(OCCLUSION_BOXES_OPEN));
    }

    #[test]
    fn test_strip_vlm_occlusion_boxes_unclosed_block_to_eof() {
        let text = "保留正文\n[OCCLUSION_BOXES]\n[{\"x\":0.1";
        assert_eq!(strip_occlusion_boxes_blocks(text), "保留正文");
    }

    #[test]
    fn test_build_draft_marker_from_vlm_spec_binds_real_image() {
        let text = r#"[OCCLUSION_BOXES]
[{"x":0.1,"y":0.2,"w":0.3,"h":0.15,"label":"真实框"}]
[/OCCLUSION_BOXES]"#;
        let mut spec = parse_occlusion_boxes_from_vlm(text).unwrap();
        spec.image_ref = "image-source-42".to_string();
        let marker =
            build_occlusion_draft_marker_from_spec(&spec, &OcclusionConfig::default()).unwrap();
        let fields = extract_occlusion_draft_fields(&marker).unwrap();
        let parsed = parse_occlusion_field(&fields.extra_fields).unwrap();
        assert_eq!(parsed.image_ref, "image-source-42");
        assert!((parsed.boxes[0].x - 0.1).abs() < EPS);
        assert_eq!(parsed.boxes[0].label, "真实框");
    }

    // ---- serde 契约 ----

    #[test]
    fn test_serde_camel_case_contract() {
        let json = r#"{
            "imageRef": "vfs://img/1.png",
            "boxes": [
                {"x": 0.1, "y": 0.2, "w": 0.3, "h": 0.4, "label": "标签", "clozeIndex": 2}
            ]
        }"#;
        let spec: OcclusionSpec = serde_json::from_str(json).expect("camelCase parse");
        assert_eq!(spec.image_ref, "vfs://img/1.png");
        assert_eq!(spec.boxes[0].cloze_index, Some(2));

        // 序列化输出同为 camelCase（imageRef / clozeIndex）
        let out = serde_json::to_string(&spec).unwrap();
        assert!(out.contains("\"imageRef\""));
        assert!(out.contains("\"clozeIndex\""));
        assert!(!out.contains("image_ref"));
    }

    // ---- IMAGE_DESC 启发式 ----

    #[test]
    fn test_propose_boxes_from_image_desc_basic() {
        let desc = "## 图 1\n[IMAGE_DESC: 心脏血流：右心房 → 右心室；肺动脉；左心房、左心室]";
        let boxes = propose_boxes_from_image_desc(desc, 12);
        let labels: Vec<&str> = boxes.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(
            labels,
            vec!["心脏血流", "右心房", "右心室", "肺动脉", "左心房", "左心室"]
        );
        // 直接可过校验（盒互不相交、全部在界内、序号顺延）
        let spec = OcclusionSpec {
            image_ref: "img.png".to_string(),
            boxes: boxes.clone(),
        };
        let v = validate_spec(&spec, &OcclusionConfig::default()).expect("proposal must validate");
        assert_eq!(v.boxes[0].cloze_index, Some(1));
        assert_eq!(v.boxes[5].cloze_index, Some(6));
        // 两两不相交
        for i in 0..boxes.len() {
            for j in (i + 1)..boxes.len() {
                assert_eq!(pairwise_iou(&boxes[i], &boxes[j]), 0.0, "boxes {i},{j}");
            }
        }
    }

    #[test]
    fn test_propose_boxes_fallback_dedupe_and_caps() {
        // 无 [IMAGE_DESC:] 标记 → 全文退化；bullet/序号前缀清洗；去重
        let desc = "- 线粒体\n- 线粒体\n1. 细胞核。\n2、高尔基体";
        let boxes = propose_boxes_from_image_desc(desc, 2);
        let labels: Vec<&str> = boxes.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(labels, vec!["线粒体", "细胞核"]); // 去重 + max_boxes=2 截断

        // 空输入/纯噪声 → 空
        assert!(propose_boxes_from_image_desc("", 12).is_empty());
        assert!(propose_boxes_from_image_desc("；；\n- \n1.", 12).is_empty());
        assert!(propose_boxes_from_image_desc("有内容", 0).is_empty());
    }

    #[test]
    fn test_propose_boxes_multiple_image_desc_markers() {
        let desc = "## 图 1\n[IMAGE_DESC: 输入层；隐藏层]\n## 图 2\n[IMAGE_DESC: 输出层]";
        let boxes = propose_boxes_from_image_desc(desc, 12);
        let labels: Vec<&str> = boxes.iter().map(|b| b.label.as_str()).collect();
        assert_eq!(labels, vec!["输入层", "隐藏层", "输出层"]);
        // 网格布局：3 个 → 2 列 2 行，坐标在 [0,1] 内
        for b in &boxes {
            assert!(b.x >= 0.0 && b.x + b.w <= 1.0 + 1e-6);
            assert!(b.y >= 0.0 && b.y + b.h <= 1.0 + 1e-6);
        }
    }

    #[test]
    fn test_vlm_draft_marker_round_trip_to_extra_fields_and_strip() {
        let desc = "## 图 1\n[IMAGE_DESC: 输入层；隐藏层；输出层]";
        let marker =
            build_occlusion_draft_marker("image-source-1", desc, &OcclusionConfig::default())
                .expect("有效 IMAGE_DESC 应生成草稿 marker");
        let content = format!("视觉正文\n{marker}\n后续正文");

        let fields =
            extract_occlusion_draft_fields(&content).expect("marker 应转成卡片 extra_fields");
        assert!(fields.extra_fields.contains_key(OCCLUSION_FIELD));
        assert_eq!(fields.tags, vec![OCCLUSION_TAG.to_string()]);
        let parsed =
            parse_occlusion_field(&fields.extra_fields).expect("_occlusion 应可回读为 spec");
        assert_eq!(parsed.image_ref, "image-source-1");
        assert_eq!(parsed.boxes.len(), 3);

        let stripped = strip_occlusion_draft_markers(&content);
        assert_eq!(stripped, "视觉正文\n后续正文");
        assert!(!stripped.contains(OCCLUSION_DRAFT_PREFIX));
    }

    #[test]
    fn test_extract_occlusion_draft_fields_uses_image_basename_in_text() {
        let spec = OcclusionSpec {
            image_ref: "vfs://images/heart-anatomy.png".to_string(),
            boxes: vec![make_box(0.1, 0.1, 0.2, 0.2)],
        };
        let marker =
            build_occlusion_draft_marker_from_spec(&spec, &OcclusionConfig::default()).unwrap();
        let fields = extract_occlusion_draft_fields(&marker).unwrap();
        assert!(
            fields
                .text
                .starts_with("<img src=\"heart-anatomy.png\"><br>"),
            "text 应以图片 basename 的 <img> 开头: {}",
            fields.text
        );
        assert!(fields.text.contains("{{c1::测试标签}}"));
        // _occlusion 里仍保留完整 image_ref（basename 只用于 <img src>）
        let parsed = parse_occlusion_field(&fields.extra_fields).unwrap();
        assert_eq!(parsed.image_ref, "vfs://images/heart-anatomy.png");
    }

    #[test]
    fn test_extract_occlusion_draft_fields_basename_handles_backslash_and_plain_ref() {
        for (image_ref, expected) in [
            (r"C:\pics\diagram.png", "diagram.png"),
            ("image-source-42", "image-source-42"),
        ] {
            let spec = OcclusionSpec {
                image_ref: image_ref.to_string(),
                boxes: vec![make_box(0.1, 0.1, 0.2, 0.2)],
            };
            let marker =
                build_occlusion_draft_marker_from_spec(&spec, &OcclusionConfig::default()).unwrap();
            let fields = extract_occlusion_draft_fields(&marker).unwrap();
            assert!(
                fields
                    .text
                    .starts_with(&format!("<img src=\"{expected}\">")),
                "ref={image_ref} text={}",
                fields.text
            );
        }
    }

    #[test]
    fn test_vlm_draft_marker_invalid_inputs_degrade_to_none() {
        assert!(build_occlusion_draft_marker(
            "",
            "[IMAGE_DESC: 输入层；输出层]",
            &OcclusionConfig::default()
        )
        .is_none());
        assert!(
            build_occlusion_draft_marker("image-source-1", "", &OcclusionConfig::default())
                .is_none()
        );
        assert!(extract_occlusion_draft_fields(
            "[ANKI_OCCLUSION_DRAFT:{\"imageRef\":\"x\",\"boxes\":[]}]"
        )
        .is_none());
    }
}
