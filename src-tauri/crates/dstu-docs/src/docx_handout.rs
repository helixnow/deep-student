//! DOCX 生成扩展：图片块 + "讲义/公文"版式（`spec.template = "handout"`）。
//!
//! `DocumentParser::generate_docx_from_spec` 的默认版式保持不变；仅当 spec 带
//! `"template": "handout"` 时整份文档走本模块（GB/T 9704 风格页面与段落样式），
//! 默认版式只额外认识 `image` 块（旧版本会把它当未知块丢弃）。
//!
//! 版式常量思路参考 wangke-agent `src/handout/styles.ts`
//! （https://github.com/BA7MLV/wangke-agent，MIT, Copyright (c) 2026 BA7MLV）。
//!
//! 图片块：
//! ```json
//! { "type": "image", "data": "<base64 或 data:image/...;base64,...>", "caption": "图 1 …" }
//! ```
//! 解码失败时退化为图注/占位文字，绝不 panic（docx-rs 的 `Pic::new` 对坏图会 panic，
//! 因此这里先用 `image` crate 解码，再按 PNG 重编码交给 `Pic::new_with_dimensions`——
//! docx-rs 0.4 打包时一律写成 `media/*.png`）。

use base64::{engine::general_purpose, Engine};
use docx_rs::{
    AlignmentType, BreakType, Docx, LineSpacing, LineSpacingType, PageMargin, Paragraph, Pic, Run,
    RunFonts, SpecialIndentType, Table, TableCell, TableRow, WidthType,
};
use std::io::Cursor;

// ---------------------------------------------------------------------------
// 版式常量（docx-rs 单位：字号 = 半磅，行距/缩进/页边距 = 缇）
// ---------------------------------------------------------------------------

/// A4
pub const PAGE_W: u32 = 11906;
pub const PAGE_H: u32 = 16838;
/// GB/T 9704：上 3.7cm / 下 3.5cm / 左 2.8cm / 右 2.6cm
pub const MARGIN_TOP: i32 = 2098;
pub const MARGIN_BOTTOM: i32 = 1984;
pub const MARGIN_LEFT: i32 = 1587;
pub const MARGIN_RIGHT: i32 = 1474;
/// 版心宽（缇）
pub const HANDOUT_CONTENT_W: i32 = PAGE_W as i32 - MARGIN_LEFT - MARGIN_RIGHT;
/// docx-rs 默认页面（A4，左右 1701 缇）版心宽
pub const DEFAULT_CONTENT_W: i32 = 11906 - 1701 * 2;
/// 固定行距 28 磅（公文版心每页 22 行）
pub const LINE_EXACT_28: i32 = 560;

/// 二号 44 / 三号 32 / 小四 24 / 五号 21
pub const SIZE_TITLE: usize = 44;
pub const SIZE_BODY: usize = 32;
pub const SIZE_CAPTION: usize = 24;
pub const SIZE_TABLE: usize = 21;
pub const SIZE_CODE: usize = 20;
/// 首行缩进 2 字符（三号字 16pt × 2 = 640 缇）
pub const INDENT_2CH: i32 = 640;

/// 西文统一 Times New Roman；中文用系统普遍自带的仿宋/黑体/楷体/宋体
/// （GB/T 9704 原文为仿宋_GB2312 / 楷体_GB2312 / 方正小标宋，新系统多不自带，
/// 这里直接使用 Windows / WPS / Office for Mac 都能映射的通用名，作为可用的降级方案）。
const LATIN: &str = "Times New Roman";
const CN_BODY: &str = "仿宋";
const CN_H1: &str = "黑体";
const CN_H2: &str = "楷体";
const CN_TITLE: &str = "宋体";
const CN_CAPTION: &str = "楷体";

/// 单张图片最长边上限（px），防止超大图把 docx 撑爆
const IMAGE_MAX_EDGE: u32 = 2000;
/// 1 缇 = 635 EMU；1 px(96dpi) = 9525 EMU
const EMU_PER_TWIP: u32 = 635;
const EMU_PER_PX: u32 = 9525;

fn fonts(cn: &str) -> RunFonts {
    RunFonts::new()
        .ascii(LATIN)
        .hi_ansi(LATIN)
        .east_asia(cn)
        .cs(LATIN)
}

fn exact_28() -> LineSpacing {
    LineSpacing::new()
        .line_rule(LineSpacingType::Exact)
        .line(LINE_EXACT_28)
}

fn str_field<'a>(v: &'a serde_json::Value, key: &str) -> &'a str {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("")
}

// ---------------------------------------------------------------------------
// 图片
// ---------------------------------------------------------------------------

/// 解码 base64（容忍 data URL 前缀与空白）
pub fn decode_image_data(data: &str) -> Option<Vec<u8>> {
    let raw = match data.find("base64,") {
        Some(i) if data.starts_with("data:") => &data[i + "base64,".len()..],
        _ => data,
    };
    let compact: String = raw.chars().filter(|c| !c.is_whitespace()).collect();
    general_purpose::STANDARD.decode(compact).ok()
}

/// 解码 → 限制尺寸 → PNG 重编码。返回 (png, width_px, height_px)
pub fn prepare_png(bytes: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory(bytes).ok()?;
    let (w, h) = (img.width(), img.height());
    if w == 0 || h == 0 {
        return None;
    }
    let img = if w.max(h) > IMAGE_MAX_EDGE {
        img.resize(
            IMAGE_MAX_EDGE,
            IMAGE_MAX_EDGE,
            image::imageops::FilterType::Triangle,
        )
    } else {
        img
    };
    let (w, h) = (img.width(), img.height());
    let mut out = Cursor::new(Vec::new());
    img.write_to(&mut out, image::ImageOutputFormat::Png).ok()?;
    Some((out.into_inner(), w, h))
}

/// 按版心宽等比缩放后的显示尺寸（EMU）
pub fn fit_emu(width_px: u32, height_px: u32, content_w_twips: i32) -> (u32, u32) {
    let max_w = (content_w_twips.max(1) as u32) * EMU_PER_TWIP;
    let w = width_px.max(1) * EMU_PER_PX;
    let h = height_px.max(1) * EMU_PER_PX;
    if w <= max_w {
        (w, h)
    } else {
        let scaled_h = (h as u64 * max_w as u64 / w as u64) as u32;
        (max_w, scaled_h.max(1))
    }
}

/// 渲染图片块：居中图片段 + 可选图注段。坏图退化为占位文字。
fn image_paragraphs(block: &serde_json::Value, handout: bool) -> Vec<Paragraph> {
    let caption = str_field(block, "caption").trim();
    let content_w = if handout {
        HANDOUT_CONTENT_W
    } else {
        DEFAULT_CONTENT_W
    };
    let mut out = Vec::new();

    let prepared = decode_image_data(str_field(block, "data"))
        .as_deref()
        .and_then(prepare_png);
    match prepared {
        Some((png, w, h)) => {
            let (ew, eh) = fit_emu(w, h, content_w);
            let pic = Pic::new_with_dimensions(png, w, h).size(ew, eh);
            out.push(
                Paragraph::new()
                    .add_run(Run::new().add_image(pic))
                    .align(AlignmentType::Center)
                    .keep_next(!caption.is_empty()),
            );
        }
        None => {
            let alt = str_field(block, "alt").trim();
            let placeholder = if alt.is_empty() {
                "[image]".to_string()
            } else {
                format!("[{}]", alt)
            };
            out.push(
                Paragraph::new()
                    .add_run(Run::new().add_text(placeholder).size(SIZE_CAPTION))
                    .align(AlignmentType::Center),
            );
        }
    }

    if !caption.is_empty() {
        let run = if handout {
            Run::new()
                .add_text(caption)
                .size(SIZE_CAPTION)
                .fonts(fonts(CN_CAPTION))
        } else {
            Run::new().add_text(caption).size(21).italic()
        };
        out.push(Paragraph::new().add_run(run).align(AlignmentType::Center));
    }
    out
}

/// 默认版式下的图片块（`generate_docx_from_spec` 调用）
pub fn add_default_image(docx: Docx, block: &serde_json::Value) -> Docx {
    image_paragraphs(block, false)
        .into_iter()
        .fold(docx, |d, p| d.add_paragraph(p))
}

// ---------------------------------------------------------------------------
// 讲义/公文版式
// ---------------------------------------------------------------------------

pub fn is_handout_template(spec: &serde_json::Value) -> bool {
    matches!(
        spec.get("template").and_then(|v| v.as_str()),
        Some("handout") | Some("official")
    )
}

fn body_paragraph(text: &str, cn_font: &str, bold: bool) -> Paragraph {
    let mut run = Run::new()
        .add_text(text)
        .size(SIZE_BODY)
        .fonts(fonts(cn_font));
    if bold {
        run = run.bold();
    }
    Paragraph::new()
        .add_run(run)
        .line_spacing(exact_28())
        .indent(
            None,
            Some(SpecialIndentType::FirstLine(INDENT_2CH)),
            None,
            None,
        )
        .align(AlignmentType::Both)
}

fn centered_line(text: &str, cn_font: &str, size: usize) -> Paragraph {
    Paragraph::new()
        .add_run(Run::new().add_text(text).size(size).fonts(fonts(cn_font)))
        .line_spacing(exact_28())
        .align(AlignmentType::Center)
}

fn handout_table(block: &serde_json::Value) -> Table {
    let rows = block
        .get("rows")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let header = block
        .get("header")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mut table_rows = Vec::new();
    for (ri, row) in rows.iter().enumerate() {
        let is_head = header && ri == 0;
        let cells = row
            .as_array()
            .map(|cells| {
                cells
                    .iter()
                    .map(|c| {
                        let mut run = Run::new()
                            .add_text(c.as_str().unwrap_or(""))
                            .size(SIZE_TABLE)
                            .fonts(fonts(if is_head { CN_H1 } else { CN_BODY }));
                        if is_head {
                            run = run.bold();
                        }
                        let mut p = Paragraph::new().add_run(run);
                        if is_head {
                            p = p.align(AlignmentType::Center);
                        }
                        TableCell::new().add_paragraph(p)
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if !cells.is_empty() {
            table_rows.push(TableRow::new(cells));
        }
    }
    Table::new(table_rows).width(HANDOUT_CONTENT_W as usize, WidthType::Dxa)
}

/// 整份文档按讲义/公文版式生成
pub fn build_handout_docx(spec: &serde_json::Value) -> Docx {
    let mut docx = Docx::new()
        .page_size(PAGE_W, PAGE_H)
        .page_margin(
            PageMargin::new()
                .top(MARGIN_TOP)
                .bottom(MARGIN_BOTTOM)
                .left(MARGIN_LEFT)
                .right(MARGIN_RIGHT),
        )
        .default_fonts(fonts(CN_BODY))
        .default_size(SIZE_BODY);

    let title = str_field(spec, "title").trim();
    if !title.is_empty() {
        docx = docx.add_paragraph(
            Paragraph::new()
                .add_run(
                    Run::new()
                        .add_text(title)
                        .size(SIZE_TITLE)
                        .bold()
                        .fonts(fonts(CN_TITLE)),
                )
                .style("Title")
                .align(AlignmentType::Center)
                .line_spacing(LineSpacing::new().before(240).after(480)),
        );
    }
    for key in ["subtitle", "date"] {
        let line = str_field(spec, key).trim();
        if !line.is_empty() {
            docx = docx.add_paragraph(centered_line(line, CN_CAPTION, SIZE_BODY));
        }
    }

    let blocks = spec
        .get("blocks")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    for block in &blocks {
        let text = str_field(block, "text");
        match str_field(block, "type") {
            "heading" => {
                let level = block.get("level").and_then(|v| v.as_u64()).unwrap_or(1);
                let (cn, bold) = match level {
                    0 | 1 => (CN_H1, false),
                    2 => (CN_H2, false),
                    _ => (CN_BODY, true),
                };
                let para = body_paragraph(text, cn, bold)
                    .style(&format!("Heading{}", level.clamp(1, 6)))
                    .keep_next(true)
                    .align(AlignmentType::Left);
                docx = docx.add_paragraph(para);
            }
            "paragraph" => {
                let role = str_field(block, "role");
                let para = match role {
                    "note" => body_paragraph(text, CN_CAPTION, false),
                    "caption" => centered_line(text, CN_CAPTION, SIZE_CAPTION),
                    _ => {
                        let bold = block.get("bold").and_then(|v| v.as_bool()) == Some(true);
                        body_paragraph(text, CN_BODY, bold)
                    }
                };
                docx = docx.add_paragraph(para);
            }
            "list" => {
                let ordered = block.get("ordered").and_then(|v| v.as_bool()) == Some(true);
                let items = block
                    .get("items")
                    .and_then(|v| v.as_array())
                    .cloned()
                    .unwrap_or_default();
                for (i, item) in items.iter().enumerate() {
                    let prefix = if ordered {
                        format!("{}. ", i + 1)
                    } else {
                        "● ".to_string()
                    };
                    let line = format!("{}{}", prefix, item.as_str().unwrap_or(""));
                    docx = docx.add_paragraph(body_paragraph(&line, CN_BODY, false));
                }
            }
            "table" => {
                let caption = str_field(block, "caption").trim();
                if !caption.is_empty() {
                    docx = docx
                        .add_paragraph(centered_line(caption, CN_H1, SIZE_CAPTION).keep_next(true));
                }
                docx = docx.add_table(handout_table(block));
            }
            "image" => {
                for p in image_paragraphs(block, true) {
                    docx = docx.add_paragraph(p);
                }
            }
            "code" => {
                for line in text.lines() {
                    docx = docx.add_paragraph(
                        Paragraph::new().add_run(
                            Run::new()
                                .add_text(line)
                                .size(SIZE_CODE)
                                .fonts(RunFonts::new().ascii("Courier New").hi_ansi("Courier New")),
                        ),
                    );
                }
            }
            "pagebreak" => {
                docx = docx
                    .add_paragraph(Paragraph::new().add_run(Run::new().add_break(BreakType::Page)));
            }
            _ => {
                if !text.is_empty() {
                    docx = docx.add_paragraph(body_paragraph(text, CN_BODY, false));
                }
            }
        }
    }
    docx
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::document_parser::DocumentParser;
    use std::io::Read;

    fn tiny_png(w: u32, h: u32) -> String {
        let img = image::RgbImage::from_fn(w, h, |x, y| {
            image::Rgb([(x % 255) as u8, (y % 255) as u8, 128])
        });
        let mut out = Cursor::new(Vec::new());
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut out, image::ImageOutputFormat::Jpeg(80))
            .unwrap();
        format!(
            "data:image/jpeg;base64,{}",
            general_purpose::STANDARD.encode(out.into_inner())
        )
    }

    fn unzip(bytes: &[u8]) -> (String, Vec<String>) {
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        let mut xml = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        (xml, names)
    }

    #[test]
    fn decode_accepts_data_url_and_raw() {
        let raw = general_purpose::STANDARD.encode(b"abc");
        assert_eq!(decode_image_data(&raw).unwrap(), b"abc");
        assert_eq!(
            decode_image_data(&format!("data:image/png;base64,{}", raw)).unwrap(),
            b"abc"
        );
        assert!(decode_image_data("%%%").is_none());
    }

    #[test]
    fn fit_emu_scales_wide_images_to_content_width() {
        let (w, h) = fit_emu(100, 50, HANDOUT_CONTENT_W);
        assert_eq!((w, h), (100 * EMU_PER_PX, 50 * EMU_PER_PX));
        let (w, h) = fit_emu(4000, 2000, HANDOUT_CONTENT_W);
        assert_eq!(w, HANDOUT_CONTENT_W as u32 * EMU_PER_TWIP);
        assert_eq!(h, w / 2);
    }

    #[test]
    fn default_spec_renders_image_block() {
        let spec = serde_json::json!({
            "title": "T",
            "blocks": [
                { "type": "paragraph", "text": "hello" },
                { "type": "image", "data": tiny_png(32, 16), "caption": "Figure 1" }
            ]
        });
        let bytes = DocumentParser::generate_docx_from_spec(&spec).unwrap();
        let (xml, names) = unzip(&bytes);
        assert!(names
            .iter()
            .any(|n| n.starts_with("word/media/") && n.ends_with(".png")));
        assert!(xml.contains("<w:drawing>") || xml.contains("<w:drawing"));
        assert!(xml.contains("Figure 1"));
        // 默认版式不受讲义样式影响
        assert!(!xml.contains("仿宋"));
        assert!(!xml.contains("w:lineRule=\"exact\""));
    }

    #[test]
    fn broken_image_degrades_to_placeholder() {
        let spec = serde_json::json!({
            "blocks": [{ "type": "image", "data": "bm90LWFuLWltYWdl", "alt": "slide" }]
        });
        let bytes = DocumentParser::generate_docx_from_spec(&spec).unwrap();
        let (xml, names) = unzip(&bytes);
        assert!(xml.contains("[slide]"));
        assert!(!names
            .iter()
            .any(|n| n.starts_with("word/media/") && n.ends_with(".png")));
    }

    #[test]
    fn handout_template_applies_official_layout() {
        let spec = serde_json::json!({
            "title": "讲义",
            "template": "handout",
            "subtitle": "课程：测试",
            "blocks": [
                { "type": "heading", "level": 1, "text": "一、概述" },
                { "type": "paragraph", "text": "正文" },
                { "type": "paragraph", "role": "note", "text": "注意" },
                { "type": "table", "header": true, "caption": "表 1", "rows": [["A","B"],["1","2"]] },
                { "type": "image", "data": tiny_png(2400, 1200), "caption": "图 1 课件" }
            ]
        });
        let bytes = DocumentParser::generate_docx_from_spec(&spec).unwrap();
        let (xml, names) = unzip(&bytes);
        assert!(names.iter().any(|n| n.starts_with("word/media/")));
        assert!(xml.contains("w:lineRule=\"exact\""));
        assert!(xml.contains("w:line=\"560\""));
        assert!(xml.contains("w:eastAsia=\"仿宋\""));
        assert!(xml.contains("w:eastAsia=\"黑体\""));
        assert!(xml.contains("w:firstLine=\"640\""));
        assert!(xml.contains("w:left=\"1587\""));
        assert!(xml.contains("w:top=\"2098\""));
        assert!(xml.contains("图 1 课件"));
        // 大图被约束在版心宽内
        let max_emu = (HANDOUT_CONTENT_W as u32 * EMU_PER_TWIP).to_string();
        assert!(xml.contains(&format!("cx=\"{}\"", max_emu)));
    }
}
