use base64::Engine;
use docx_rs::*;
use serde::Deserialize;

use crate::models::AppError;

#[derive(Debug, Deserialize, Default)]
pub struct PaperRun {
    pub text: Option<String>,
    pub image: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
}

#[derive(Debug, Deserialize)]
pub struct PaperBlock {
    pub kind: String,
    pub runs: Option<Vec<PaperRun>>,
    pub level: Option<u32>,
    pub rows: Option<Vec<Vec<Vec<PaperRun>>>>,
    pub image: Option<String>,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub lines: Option<u32>,
    pub page_break: Option<bool>,
}

fn fonts() -> RunFonts {
    RunFonts::new()
        .ascii("Noto Sans CJK SC")
        .hi_ansi("Noto Sans CJK SC")
        .east_asia("Noto Sans CJK SC")
}

fn picture(
    data: &str,
    width: Option<f64>,
    height: Option<f64>,
    max_width: f64,
) -> Result<Pic, AppError> {
    let bytes = crate::docx_handout::decode_image_data(data)
        .ok_or_else(|| AppError::validation("Invalid paper image"))?;
    if bytes.len() > 50 * 1024 * 1024 {
        return Err(AppError::validation("Paper image exceeds size limit"));
    }
    let (png, w, h) = crate::docx_handout::prepare_png(&bytes)
        .ok_or_else(|| AppError::validation("Cannot decode paper image"))?;
    let requested_width = width.unwrap_or(f64::from(w) * 0.75).max(1.0);
    let intended = requested_width.min(max_width);
    let intended_height = height
        .map(|height| height * intended / requested_width)
        .unwrap_or(intended * f64::from(h) / f64::from(w));
    let scale = (600.0 / intended_height).min(1.0);
    Ok(Pic::new_with_dimensions(png, w, h).size(
        (intended * scale * 12700.0) as u32,
        (intended_height * scale * 12700.0) as u32,
    ))
}

fn paragraph(
    runs: &[PaperRun],
    size: usize,
    bold: bool,
    max_width: f64,
) -> Result<Paragraph, AppError> {
    let mut paragraph = Paragraph::new()
        .widow_control(true)
        .line_spacing(LineSpacing::new().after(120).line(320));
    if runs.iter().any(|run| run.image.is_some()) {
        paragraph.property.text_alignment = Some(TextAlignment::new(TextAlignmentType::Center));
    }
    for item in runs {
        let mut run = Run::new().size(size).fonts(fonts()).color("000000");
        if let Some(image) = &item.image {
            run = run.add_image(picture(image, item.width, item.height, max_width)?);
        } else if let Some(text) = &item.text {
            for (index, line) in text.split('\n').enumerate() {
                if index > 0 {
                    run = run.add_break(BreakType::TextWrapping);
                }
                run = run.add_text(line);
            }
        }
        if bold || item.bold == Some(true) {
            run = run.bold();
        }
        if item.italic == Some(true) {
            run = run.italic();
        }
        paragraph = paragraph.add_run(run);
    }
    Ok(paragraph)
}

pub fn build_docx(title: &str, blocks: &[PaperBlock]) -> Result<Vec<u8>, AppError> {
    if blocks.len() > 50000 {
        return Err(AppError::validation("Paper has too many blocks"));
    }
    let mut docx = Docx::new()
        .page_size(11906, 16838)
        .page_margin(
            PageMargin::new()
                .top(960)
                .bottom(960)
                .left(1000)
                .right(1000),
        )
        .default_fonts(fonts())
        .default_size(22)
        .footer(
            Footer::new().add_paragraph(
                Paragraph::new()
                    .align(AlignmentType::Center)
                    .add_page_num(PageNum::new())
                    .add_run(Run::new().add_text(" / ").size(18))
                    .add_num_pages(NumPages::new()),
            ),
        );
    if blocks.is_empty() {
        docx = docx.add_paragraph(
            Paragraph::new()
                .style("Title")
                .add_run(Run::new().add_text(title).size(36)),
        );
    }
    for block in blocks {
        match block.kind.as_str() {
            "heading" => {
                let level = block.level.unwrap_or(1);
                let paragraph = paragraph(
                    block.runs.as_deref().unwrap_or_default(),
                    if level == 0 { 36 } else { 24 },
                    true,
                    490.0,
                )?
                .keep_next(true)
                .page_break_before(block.page_break.unwrap_or(false))
                .style(if level == 0 { "Title" } else { "Heading2" });
                docx = docx.add_paragraph(paragraph);
            }
            "paragraph" => {
                docx = docx.add_paragraph(paragraph(
                    block.runs.as_deref().unwrap_or_default(),
                    22,
                    false,
                    490.0,
                )?)
            }
            "image" => {
                if let Some(data) = &block.image {
                    docx = docx.add_paragraph(Paragraph::new().add_run(
                        Run::new().add_image(picture(data, block.width, block.height, 490.0)?),
                    ));
                }
            }
            "space" => {
                // Paragraph spacing collapses at page boundaries; empty paragraphs
                // can spill onto an otherwise blank page before the answer appendix.
                let spacing = block.lines.unwrap_or(1).min(20) * 360;
                if let Some(DocumentChild::Paragraph(previous)) = docx.document.children.last_mut()
                {
                    previous.property = previous
                        .property
                        .clone()
                        .line_spacing(LineSpacing::new().line(320).after(spacing));
                } else {
                    docx = docx.add_paragraph(
                        Paragraph::new().line_spacing(LineSpacing::new().line(320).after(spacing)),
                    );
                }
            }
            "table" => {
                let mut rows = Vec::new();
                let source = block.rows.as_deref().unwrap_or_default();
                let columns = source.iter().map(Vec::len).max().unwrap_or(1).max(1);
                for (index, row) in source.iter().enumerate() {
                    let mut cells = Vec::new();
                    for cell in row {
                        let mut result = TableCell::new()
                            .width(9800 / columns, WidthType::Dxa)
                            .vertical_align(VAlignType::Center)
                            .add_paragraph(paragraph(
                                cell,
                                21,
                                index == 0,
                                480.0 / columns as f64,
                            )?);
                        if index == 0 {
                            result = result.shading(Shading::new().fill("EEEEEE"));
                        }
                        cells.push(result);
                    }
                    rows.push(TableRow::new(cells));
                }
                let borders = TableBorders::new();
                let mut table = Table::new(rows)
                    .width(9800, WidthType::Dxa)
                    .set_borders(borders);
                for position in [
                    TableBorderPosition::Top,
                    TableBorderPosition::Bottom,
                    TableBorderPosition::Left,
                    TableBorderPosition::Right,
                    TableBorderPosition::InsideH,
                    TableBorderPosition::InsideV,
                ] {
                    table = table.set_border(
                        TableBorder::new(position)
                            .border_type(BorderType::Single)
                            .size(4)
                            .color("D9D9D9"),
                    );
                }
                docx = docx.add_table(table);
            }
            _ => return Err(AppError::validation("Invalid paper block type")),
        }
    }
    let mut output = std::io::Cursor::new(Vec::new());
    docx.build()
        .pack(&mut output)
        .map_err(|error| AppError::internal(format!("DOCX export failed: {error}")))?;
    Ok(output.into_inner())
}

#[tauri::command]
pub fn qbank_export_paper_docx(title: String, blocks: Vec<PaperBlock>) -> Result<String, AppError> {
    Ok(base64::engine::general_purpose::STANDARD.encode(build_docx(&title, &blocks)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;

    #[test]
    fn docx_has_editable_text_table_and_a4_layout() {
        let fallback = r#"[{"kind":"heading","level":0,"runs":[{"text":"数学综合练习"}]},{"kind":"paragraph","runs":[{"text":"普通文字可以编辑"}]},{"kind":"table","rows":[[[{"text":"题号"}],[{"text":"分值"}]],[[{"text":"1"}],[{"text":"10"}]]]}]"#;
        let input = std::env::var("QBANK_EXPORT_QA_DIR").ok().map(|dir| {
            std::fs::read_to_string(std::path::Path::new(&dir).join("sample-blocks.json")).unwrap()
        });
        let blocks: Vec<PaperBlock> =
            serde_json::from_str(input.as_deref().unwrap_or(fallback)).unwrap();
        let bytes = build_docx("数学综合练习", &blocks).unwrap();
        let mut zip = zip::ZipArchive::new(std::io::Cursor::new(&bytes)).unwrap();
        let mut xml = String::new();
        zip.by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("数学综合练习"));
        assert!(xml.contains("w:tbl"));
        assert!(xml.contains("11906"));
        assert!(xml.contains("16838"));
        assert!(xml.contains("D9D9D9"));
        if let Ok(dir) = std::env::var("QBANK_EXPORT_QA_DIR") {
            assert!(zip.file_names().any(|name| name.starts_with("word/media/")));
            std::fs::write(std::path::Path::new(&dir).join("sample.docx"), bytes).unwrap();
        }
    }
}
