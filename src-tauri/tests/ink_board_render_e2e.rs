//! Native Wry E2E for production Ink board rendering and PDF/image/DOCX/PPTX preparation.
//!
//! The isolated page registers the production job and render bridges. Real
//! attachment uploads and real `VfsTextbookRepo::create_textbook_with_preview`
//! imports (blob-backed source bytes plus extracted text in `resources.data`)
//! are prepared through `vfs_ink_prepare`, edited through the page commands,
//! reopened, and rendered into checked immutable artifacts. Document fixtures
//! are small but real OOXML packages with an in-package marker image. No mock
//! converter/renderer, pre-encoded converted PNG, or main-app bootstrap.
//!
//! From the project root, build `npm run build:ink-e2e`; then from `src-tauri`,
//! export `TAURI_CONFIG=$(cat tauri.ink-e2e.conf.json)` and run
//! `xvfb-run -a cargo test --locked -j2 --no-default-features --features sqlite,data_governance --test ink_board_render_e2e`.
//! TAURI_CONFIG is required at compile time. Assets come from the ignored
//! `src-tauri/target/ink-e2e-client/`; HOME/XDG and the migrated VFS are temporary.

use std::io::{Cursor, Write};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::Arc;
use std::time::{Duration, Instant};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use deep_student_lib::ink_bridge::{
    InkBoardRenderSpec, InkRenderSpec, PendingFlushBus, PendingRenderBus,
};
use deep_student_lib::ink_jobs::PendingInkJobBus;
use deep_student_lib::vfs::database::setup_migrated_test_db;
use deep_student_lib::vfs::ink::{
    InkAuthor, InkBackground, InkBoardChunk, InkBoardObject, InkBoardSurface, InkManifest,
    InkObject, InkObjectContent, InkPage, InkPageRef, InkRect, InkRuling, InkSample, InkSource,
    InkStrokeStyle, InkTool, INK_BOARD_SCHEMA_VERSION, INK_SCHEMA_VERSION,
};
use deep_student_lib::vfs::repos::ink_board_repo::VfsInkBoardRepo;
use deep_student_lib::vfs::repos::{
    VfsAttachmentRepo, VfsBlobRepo, VfsFileRepo, VfsInkArtifactRepo, VfsInkRepo, VfsResourceRepo,
    VfsTextbookRepo,
};
use deep_student_lib::vfs::types::VfsUploadAttachmentParams;
use deep_student_lib::vfs::VfsDatabase;
use image::ImageEncoder;
use rusqlite::params;
use serde_json::{json, Value};
use tauri::{Emitter, Listener, Manager};

const TEST_APP_LABEL: &str = "main";
const POSITIVE_PHASE: &str = "positive";
const POSITIVE_SCALED_PHASE: &str = "positive_scaled";
const INVALID_PHASE: &str = "invalid_crop";
const STALE_PHASE: &str = "stale_revision";
const PDF_PREPARE_PHASE: &str = "prepare_inline_pdf";
const IMAGE_PREPARE_PHASE: &str = "prepare_inline_image";
const TEXTBOOK_PDF_PHASE: &str = "prepare_textbook_pdf";
const TEXTBOOK_DOCX_PHASE: &str = "prepare_textbook_docx";
const TEXTBOOK_PPTX_PHASE: &str = "prepare_textbook_pptx";
const TEXTBOOK_IMAGE_PHASE: &str = "prepare_textbook_image";
const LIFECYCLE_PDF_PHASE: &str = "prepare_lifecycle_textbook_pdf";
const PDF_MIME: &str = "application/pdf";
const DOCX_MIME: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const PPTX_MIME: &str = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const SOURCE_RENDER_WIDTH: u32 = 160;
const SOURCE_RENDER_HEIGHT: u32 = 120;
const BLUE_MARKER: [u8; 4] = [0, 0, 255, 255];
const WHITE: [u8; 4] = [255, 255, 255, 255];
const EVENT_READY: &str = "ink-e2e-ready";
const EVENT_RESULT: &str = "ink-e2e-result";
const EVENT_LIFECYCLE_REQUEST: &str = "ink-e2e-lifecycle-request";
const EVENT_LIFECYCLE_RESULT: &str = "ink-e2e-lifecycle-result";
const EVENT_DONE: &str = "ink-e2e-done";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceFormat {
    Pdf,
    Docx,
    Pptx,
    Image,
}

impl SourceFormat {
    fn label(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Pptx => "pptx",
            Self::Image => "image",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Pptx => "pptx",
            Self::Image => "png",
        }
    }

    fn mime_type(self) -> &'static str {
        match self {
            Self::Pdf => PDF_MIME,
            Self::Docx => DOCX_MIME,
            Self::Pptx => PPTX_MIME,
            Self::Image => "image/png",
        }
    }

    fn file_type(self) -> &'static str {
        match self {
            Self::Pdf => "pdf",
            Self::Docx => "docx",
            Self::Pptx => "pptx",
            Self::Image => "image",
        }
    }

    fn conversion_prefix(self) -> &'static str {
        match self {
            Self::Pdf => "ink-pdf-pages-v1-",
            Self::Image => "ink-image-pages-v1-",
            Self::Docx | Self::Pptx => "ink-office-pages-v1-",
        }
    }

    fn is_office(self) -> bool {
        matches!(self, Self::Docx | Self::Pptx)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SourceStorage {
    InlineAttachment,
    TextbookBlob,
}

struct PrepareSourceFixture {
    phase: &'static str,
    format: SourceFormat,
    storage: SourceStorage,
    resource_id: String,
    file_id: String,
    source_hash: String,
    bytes: Vec<u8>,
    extracted_text: Option<String>,
    snapshot: Value,
    metadata: Value,
}

fn inline_pdf_bytes(variant: &str) -> Vec<u8> {
    let drawing =
        format!("% {variant}\nq\n1 1 1 rg\n0 0 160 120 re f\n0 0 1 rg\n96 72 32 24 re f\nQ\n");
    let objects = [
        "<< /Type /Catalog /Pages 2 0 R >>".to_owned(),
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>".to_owned(),
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 160 120] /Resources << >> /Contents 4 0 R >>"
            .to_owned(),
        format!(
            "<< /Length {} >>\nstream\n{}endstream",
            drawing.len(),
            drawing
        ),
    ];
    let mut pdf = b"%PDF-1.4\n".to_vec();
    let mut offsets = Vec::new();
    for (index, object) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf.extend_from_slice(format!("{} 0 obj\n{}\nendobj\n", index + 1, object).as_bytes());
    }
    let xref = pdf.len();
    pdf.extend_from_slice(
        format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1).as_bytes(),
    );
    for offset in offsets {
        pdf.extend_from_slice(format!("{offset:010} 00000 n \n").as_bytes());
    }
    pdf.extend_from_slice(
        format!(
            "trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n",
            objects.len() + 1,
        )
        .as_bytes(),
    );
    pdf
}

fn inline_pdf() -> Vec<u8> {
    inline_pdf_bytes("inline attachment")
}

fn textbook_pdf() -> Vec<u8> {
    inline_pdf_bytes("textbook import")
}

fn lifecycle_pdf() -> Vec<u8> {
    inline_pdf_bytes("textbook lifecycle import")
}

fn source_png_with_variant(variant: bool) -> Vec<u8> {
    let mut image = image::RgbaImage::from_pixel(
        SOURCE_RENDER_WIDTH,
        SOURCE_RENDER_HEIGHT,
        image::Rgba([255, 255, 255, 255]),
    );
    for y in 24..48 {
        for x in 96..128 {
            image.put_pixel(x, y, image::Rgba([0, 0, 255, 255]));
        }
    }
    if variant {
        // Keep the attachment and textbook imports content-distinct without
        // changing the checked white paper or marker pixels.
        image.put_pixel(0, 0, image::Rgba([254, 255, 255, 255]));
    }
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ColorType::Rgba8,
        )
        .expect("encode generated source image, not a converted page");
    bytes
}

fn inline_source_png() -> Vec<u8> {
    source_png_with_variant(false)
}

fn textbook_source_png() -> Vec<u8> {
    source_png_with_variant(true)
}

fn ooxml_zip(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut writer = zip::ZipWriter::new(Cursor::new(Vec::new()));
    let options =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, contents) in entries {
        writer
            .start_file(*name, options)
            .expect("start generated OOXML part");
        writer
            .write_all(contents)
            .expect("write generated OOXML part");
    }
    writer
        .finish()
        .expect("finish generated OOXML package")
        .into_inner()
}

fn blue_marker_png() -> Vec<u8> {
    let marker = image::RgbaImage::from_pixel(120, 30, image::Rgba([0, 0, 255, 255]));
    let mut bytes = Vec::new();
    image::codecs::png::PngEncoder::new(&mut bytes)
        .write_image(
            marker.as_raw(),
            marker.width(),
            marker.height(),
            image::ColorType::Rgba8,
        )
        .expect("encode in-package marker image, not a converted page");
    bytes
}

/// A real single-page DOCX with an embedded blue marker image. The source stays
/// an OOXML ZIP; `docx-preview` must render the page inside the real job bridge.
fn minimal_docx(marker_png: &[u8]) -> Vec<u8> {
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;
    let relationships = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>"#;
    let document_xml = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body><w:p><w:r><w:t>Ink DOCX textbook</w:t></w:r></w:p><w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="1143000" cy="285750"/><wp:docPr id="1" name="Blue DOCX marker"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="marker.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdImage1"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="1143000" cy="285750"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="360" w:footer="360" w:gutter="0"/></w:sectPr></w:body></w:document>"#;
    let document_relationships = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/marker1.png"/></Relationships>"#;
    ooxml_zip(&[
        ("[Content_Types].xml", content_types.as_bytes().to_vec()),
        ("_rels/.rels", relationships.as_bytes().to_vec()),
        ("word/document.xml", document_xml.as_bytes().to_vec()),
        (
            "word/_rels/document.xml.rels",
            document_relationships.as_bytes().to_vec(),
        ),
        ("word/media/marker1.png", marker_png.to_vec()),
    ])
}

/// A real single-slide PPTX with the same blue marker. Master/layout/theme are
/// present because the production `pptx-preview` renderer resolves them.
fn minimal_pptx(marker_png: &[u8]) -> Vec<u8> {
    let content_types = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>"#;
    let relationships = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>"#;
    let presentation = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rIdMaster"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rIdSlide1"/></p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="wide"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle/></p:presentation>"#;
    let presentation_relationships = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rIdSlide1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>"#;
    let slide_master = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Master"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="1" r:id="rIdLayout"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle/><p:bodyStyle/><p:otherStyle/></p:txStyles></p:sldMaster>"#;
    let slide_master_relationships = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdTheme" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>"#;
    let slide_layout = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>"#;
    let slide_layout_relationships = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdMaster" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>"#;
    let theme = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Fixture"><a:themeElements><a:clrScheme name="Fixture"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="404040"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Fixture"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme><a:fmtScheme name="Fixture"><a:fillStyleLst/><a:lnStyleLst/><a:effectStyleLst/><a:bgFillStyleLst/></a:fmtScheme></a:themeElements></a:theme>"#;
    let slide = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld name="Ink PPTX textbook"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="228600"/><a:ext cx="5000000" cy="600000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Ink PPTX textbook</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp><p:pic><p:nvPicPr><p:cNvPr id="3" name="Blue PPTX marker"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rIdImage1"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="457200" y="1200000"/><a:ext cx="1828800" cy="457200"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>"#;
    let slide_relationships = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdLayout" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rIdImage1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/></Relationships>"#;
    ooxml_zip(&[
        ("[Content_Types].xml", content_types.as_bytes().to_vec()),
        ("_rels/.rels", relationships.as_bytes().to_vec()),
        ("ppt/presentation.xml", presentation.as_bytes().to_vec()),
        (
            "ppt/_rels/presentation.xml.rels",
            presentation_relationships.as_bytes().to_vec(),
        ),
        (
            "ppt/slideMasters/slideMaster1.xml",
            slide_master.as_bytes().to_vec(),
        ),
        (
            "ppt/slideMasters/_rels/slideMaster1.xml.rels",
            slide_master_relationships.as_bytes().to_vec(),
        ),
        (
            "ppt/slideLayouts/slideLayout1.xml",
            slide_layout.as_bytes().to_vec(),
        ),
        (
            "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
            slide_layout_relationships.as_bytes().to_vec(),
        ),
        ("ppt/theme/theme1.xml", theme.as_bytes().to_vec()),
        ("ppt/slides/slide1.xml", slide.as_bytes().to_vec()),
        (
            "ppt/slides/_rels/slide1.xml.rels",
            slide_relationships.as_bytes().to_vec(),
        ),
        ("ppt/media/image1.png", marker_png.to_vec()),
    ])
}

fn source_snapshot(db: &VfsDatabase, resource_id: &str, file_id: &str) -> Value {
    let conn = db.get_conn_safe().expect("source snapshot connection");
    let resource = conn
        .query_row(
            "SELECT hash, type, source_id, source_table, storage_mode, data, external_hash, deleted_at FROM resources WHERE id = ?1",
            [resource_id],
            |row| {
                Ok(json!({
                    "hash": row.get::<_, String>(0)?,
                    "type": row.get::<_, String>(1)?,
                    "source_id": row.get::<_, Option<String>>(2)?,
                    "source_table": row.get::<_, Option<String>>(3)?,
                    "storage_mode": row.get::<_, String>(4)?,
                    "data": row.get::<_, Option<String>>(5)?,
                    "external_hash": row.get::<_, Option<String>>(6)?,
                    "deleted_at": row.get::<_, Option<i64>>(7)?,
                }))
            },
        )
        .expect("read inline source identity and bytes");
    let file = VfsFileRepo::get_file_with_conn(&conn, file_id)
        .expect("read source file")
        .expect("source file exists");
    json!({ "resource": resource, "file": file })
}

fn source_metadata(db: &VfsDatabase, resource_id: &str) -> Value {
    let conn = db.get_conn_safe().expect("source metadata connection");
    let raw: Option<String> = conn
        .query_row(
            "SELECT metadata_json FROM resources WHERE id = ?1",
            [resource_id],
            |row| row.get(0),
        )
        .expect("read source metadata");
    serde_json::from_str(raw.as_deref().unwrap_or("{}")).expect("source metadata is JSON")
}

/// Test-only fixture metadata. Lifecycle actions below still use production
/// repositories; this only supplies a non-Ink metadata key that the recovery
/// path must preserve.
fn seed_source_metadata(db: &VfsDatabase, resource_id: &str, metadata: &Value) {
    let conn = db.get_conn_safe().expect("seed source metadata connection");
    let changed = conn
        .execute(
            "UPDATE resources SET metadata_json = ?1 WHERE id = ?2",
            params![metadata.to_string(), resource_id],
        )
        .expect("seed source metadata");
    assert_eq!(changed, 1, "source metadata fixture row must exist");
}

// The E2E capability only allowlists production commands. Keep the lifecycle
// fixture bridge test-local instead of editing permissions: the event handlers
// below still perform delete/re-import exclusively through production repos.
#[derive(serde::Deserialize)]
struct LifecycleRemoveRequest {
    source_resource_id: String,
    #[serde(default)]
    purge_target: bool,
}

#[derive(serde::Deserialize)]
struct LifecycleReimportRequest {
    source_resource_id: String,
}

/// Delete the source file and its default `.dsink` through the same production
/// repository used by trash/file deletion. `purge_target` additionally runs the
/// production permanent-delete path to cover a missing (purged) target row.
fn lifecycle_remove_source_and_default(
    db: &VfsDatabase,
    request: LifecycleRemoveRequest,
) -> Result<Value, String> {
    let source_resource_id = request.source_resource_id;
    let purge_target = request.purge_target;
    let metadata = source_metadata(db, &source_resource_id);
    let conn = db.get_conn_safe().map_err(|error| error.to_string())?;
    let resource = VfsResourceRepo::get_resource_with_conn(&conn, &source_resource_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("lifecycle source resource is missing: {source_resource_id}"))?;
    let source_file_id = resource
        .source_id
        .clone()
        .ok_or_else(|| "lifecycle source file id is missing".to_owned())?;
    let target_document_id = metadata
        .get("default_ink_document_id")
        .and_then(Value::as_str)
        .ok_or_else(|| "lifecycle source has no default Ink document".to_owned())?
        .to_owned();

    VfsFileRepo::delete_file_with_conn(&conn, &source_file_id)
        .map_err(|error| error.to_string())?;
    VfsFileRepo::delete_file_with_conn(&conn, &target_document_id)
        .map_err(|error| error.to_string())?;

    let source_after = VfsFileRepo::get_file_with_conn(&conn, &source_file_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "lifecycle source disappeared after soft delete".to_owned())?;
    let target_after = VfsFileRepo::get_file_with_conn(&conn, &target_document_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "lifecycle default Ink document disappeared after soft delete".to_owned())?;
    let target_deleted_at = target_after.deleted_at.clone();
    let mut target_status = target_after.status.clone();
    if purge_target {
        VfsFileRepo::purge_file_with_conn(&conn, db.blobs_dir(), &target_document_id)
            .map_err(|error| error.to_string())?;
        if VfsFileRepo::get_file_with_conn(&conn, &target_document_id)
            .map_err(|error| error.to_string())?
            .is_some()
        {
            return Err("lifecycle default Ink document survived purge".to_owned());
        }
        target_status = "purged".to_owned();
    }

    Ok(json!({
        "source_file_id": source_file_id,
        "source_status": source_after.status,
        "source_deleted_at": source_after.deleted_at,
        "target_document_id": target_document_id,
        "target_status": target_status,
        "target_deleted_at": if purge_target { Value::Null } else { json!(target_deleted_at) },
        "target_purged": purge_target,
    }))
}

/// Re-import the deleted textbook through the production dedup/restore path.
/// This mirrors the real import boundary's existing-sha branch without running
/// the unrelated PDF conversion pipeline.
fn lifecycle_reimport_textbook(
    db: &VfsDatabase,
    request: LifecycleReimportRequest,
) -> Result<Value, String> {
    let source_resource_id = request.source_resource_id;
    let default_before_prepare = source_metadata(db, &source_resource_id)
        .get("default_ink_document_id")
        .cloned()
        .unwrap_or(Value::Null);
    let conn = db.get_conn_safe().map_err(|error| error.to_string())?;
    let resource = VfsResourceRepo::get_resource_with_conn(&conn, &source_resource_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("lifecycle source resource is missing: {source_resource_id}"))?;
    let file_id = resource
        .source_id
        .clone()
        .ok_or_else(|| "lifecycle source file id is missing".to_owned())?;
    let file = VfsFileRepo::get_file_with_conn(&conn, &file_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "lifecycle source file is missing before re-import".to_owned())?;
    let textbook = VfsTextbookRepo::create_textbook_with_preview(
        &conn,
        &file.sha256,
        &file.file_name,
        file.size,
        file.blob_hash.as_deref(),
        file.original_path.as_deref(),
        None,
        resource.data.as_deref(),
        file.page_count,
    )
    .map_err(|error| error.to_string())?;
    if textbook.id != file_id
        || textbook.resource_id.as_deref() != Some(source_resource_id.as_str())
    {
        return Err("textbook dedup restore did not restore the original source row".to_owned());
    }
    let restored = VfsFileRepo::get_file_with_conn(&conn, &file_id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "lifecycle source file is missing after re-import".to_owned())?;
    Ok(json!({
        "file_id": restored.id,
        "resource_id": textbook.resource_id,
        "file_name": restored.file_name,
        "sha256": restored.sha256,
        "status": restored.status,
        "deleted_at": restored.deleted_at,
        "default_ink_document_id_before_prepare": default_before_prepare,
    }))
}

fn upload_prepare_source(
    db: &VfsDatabase,
    phase: &'static str,
    format: SourceFormat,
    name: &str,
    bytes: Vec<u8>,
) -> PrepareSourceFixture {
    let source_hash = VfsBlobRepo::compute_hash(&bytes);
    let uploaded = {
        let conn = db.get_conn_safe().expect("attachment upload connection");
        VfsAttachmentRepo::upload_bytes_with_conn(
            &conn,
            db.blobs_dir(),
            &VfsUploadAttachmentParams {
                name: name.to_owned(),
                mime_type: format.mime_type().to_owned(),
                base64_content: String::new(),
                attachment_type: Some(
                    if format == SourceFormat::Image {
                        "image"
                    } else {
                        "file"
                    }
                    .to_owned(),
                ),
            },
            &bytes,
        )
        .expect("upload generated source through the real attachment repository")
    };
    assert!(uploaded.is_new);
    assert_eq!(uploaded.attachment.content_hash, source_hash);
    assert!(
        uploaded.attachment.blob_hash.is_none(),
        "fixture must use inline storage"
    );
    let resource_id = uploaded
        .attachment
        .resource_id
        .expect("inline upload resource");
    let file_id = uploaded.source_id;
    let snapshot = source_snapshot(db, &resource_id, &file_id);
    assert_eq!(snapshot["resource"]["storage_mode"], "inline");
    assert_eq!(
        snapshot["resource"]["type"],
        if format == SourceFormat::Image {
            "image"
        } else {
            "file"
        }
    );
    assert_ne!(
        snapshot["resource"]["hash"].as_str(),
        Some(source_hash.as_str())
    );
    let stored = STANDARD
        .decode(
            snapshot["resource"]["data"]
                .as_str()
                .expect("inline base64 source"),
        )
        .expect("decode uploaded source");
    assert_eq!(stored, bytes);
    let metadata = source_metadata(db, &resource_id);
    assert!(metadata.get("default_ink_document_id").is_none());
    PrepareSourceFixture {
        phase,
        format,
        storage: SourceStorage::InlineAttachment,
        resource_id,
        file_id,
        source_hash,
        bytes,
        extracted_text: None,
        snapshot,
        metadata,
    }
}

/// Import through the production textbook repository. The original bytes live
/// in `blobs`, while `resources.data` stores extracted text and `files.type`
/// stores the real `pdf`/`docx`/`pptx`/`image` category.
fn import_textbook_prepare_source(
    db: &VfsDatabase,
    phase: &'static str,
    format: SourceFormat,
    name: &str,
    bytes: Vec<u8>,
    extracted_text: String,
) -> PrepareSourceFixture {
    let source_hash = VfsBlobRepo::compute_hash(&bytes);
    let (resource_id, file_id) = {
        let conn = db.get_conn_safe().expect("textbook import connection");
        let blob = VfsBlobRepo::store_blob_with_conn(
            &conn,
            db.blobs_dir(),
            &bytes,
            Some(format.mime_type()),
            Some(format.extension()),
        )
        .expect("store imported textbook source blob");
        assert_eq!(blob.hash, source_hash);
        let textbook = VfsTextbookRepo::create_textbook_with_preview(
            &conn,
            &source_hash,
            name,
            bytes.len() as i64,
            Some(&blob.hash),
            Some("/imports/native-ink-e2e"),
            None,
            Some(&extracted_text),
            Some(1),
        )
        .expect("create textbook through the real preview import path");
        (
            textbook.resource_id.expect("textbook resource id"),
            textbook.id,
        )
    };
    let snapshot = source_snapshot(db, &resource_id, &file_id);
    assert_eq!(snapshot["resource"]["storage_mode"], "inline");
    assert_eq!(snapshot["resource"]["type"], "file");
    assert_eq!(
        snapshot["resource"]["hash"].as_str(),
        Some(source_hash.as_str())
    );
    assert_eq!(
        snapshot["resource"]["data"].as_str(),
        Some(extracted_text.as_str()),
        "textbook import must keep extracted text in resources.data"
    );
    assert_eq!(
        snapshot["file"]["blobHash"].as_str(),
        Some(source_hash.as_str()),
        "textbook import must be blob-backed"
    );
    assert_eq!(
        snapshot["file"]["fileType"].as_str(),
        Some(format.file_type()),
        "textbook import must persist the real source category"
    );
    assert_eq!(
        snapshot["file"]["mimeType"].as_str(),
        Some(format.mime_type())
    );
    assert_eq!(snapshot["file"]["size"].as_i64(), Some(bytes.len() as i64));
    if format.is_office() {
        assert_eq!(
            &bytes[..2],
            b"PK",
            "Office fixture must be a real OOXML ZIP"
        );
        assert_ne!(
            &bytes[..4],
            b"\x89PNG",
            "Office fixture must not be a pre-encoded converted page"
        );
    }
    let metadata = source_metadata(db, &resource_id);
    assert!(metadata.get("default_ink_document_id").is_none());
    PrepareSourceFixture {
        phase,
        format,
        storage: SourceStorage::TextbookBlob,
        resource_id,
        file_id,
        source_hash,
        bytes,
        extracted_text: Some(extracted_text),
        snapshot,
        metadata,
    }
}

fn prepared_stroke(phase: &str, page_ref: &InkPageRef) -> InkObject {
    InkObject {
        id: format!("e2e-{phase}-stroke"),
        author: InkAuthor::User,
        created_at: 3,
        content: InkObjectContent::Stroke {
            samples: vec![
                InkSample {
                    x: page_ref.width / 4.0,
                    y: page_ref.height * 0.75,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
                InkSample {
                    x: page_ref.width / 2.0,
                    y: page_ref.height * 0.75,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
            ],
            style: InkStrokeStyle {
                tool: InkTool::Pen,
                color: "#000000".to_owned(),
                width: page_ref.width / 32.0,
                pressure_enabled: false,
            },
        },
    }
}

fn board_crop() -> InkRect {
    InkRect {
        x: -100.0,
        y: -80.0,
        width: 200.0,
        height: 160.0,
    }
}

fn stroke_object() -> InkBoardObject {
    InkBoardObject {
        id: "e2e-negative-origin-stroke".to_owned(),
        author: InkAuthor::User,
        created_at: 1,
        z_index: 1,
        content: InkObjectContent::Stroke {
            samples: vec![
                InkSample {
                    x: -45.0,
                    y: -35.0,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
                InkSample {
                    x: -20.0,
                    y: -35.0,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
            ],
            style: InkStrokeStyle {
                tool: InkTool::Pen,
                color: "#000000".to_owned(),
                width: 4.0,
                pressure_enabled: false,
            },
        },
    }
}

fn ai_region_object() -> InkBoardObject {
    InkBoardObject {
        id: "e2e-ai-red-region".to_owned(),
        author: InkAuthor::Ai,
        created_at: 2,
        z_index: 2,
        content: InkObjectContent::RegionHighlight {
            rect: InkRect {
                x: 40.0,
                y: 30.0,
                width: 20.0,
                height: 20.0,
            },
            color: "#ff0000ff".to_owned(),
            width: 2.0,
        },
    }
}

fn highlighter_object() -> InkBoardObject {
    InkBoardObject {
        id: "e2e-green-highlighter".to_owned(),
        author: InkAuthor::User,
        created_at: 3,
        z_index: 3,
        content: InkObjectContent::Stroke {
            samples: vec![
                InkSample {
                    x: 40.0,
                    y: 70.0,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
                InkSample {
                    x: 60.0,
                    y: 70.0,
                    pressure: 0.5,
                    elapsed_ms: None,
                },
            ],
            style: InkStrokeStyle {
                tool: InkTool::Highlighter,
                color: "#00ff0080".to_owned(),
                width: 12.0,
                pressure_enabled: false,
            },
        },
    }
}

fn board_chunks() -> Vec<InkBoardChunk> {
    vec![
        InkBoardChunk {
            schema_version: INK_BOARD_SCHEMA_VERSION,
            chunk_id: "e2e-chunk-negative-origin".to_owned(),
            objects: vec![stroke_object()],
        },
        InkBoardChunk {
            schema_version: INK_BOARD_SCHEMA_VERSION,
            chunk_id: "e2e-chunk-ai-and-highlighter".to_owned(),
            objects: vec![ai_region_object(), highlighter_object()],
        },
    ]
}

fn save_board_fixture(db: &VfsDatabase) -> (String, String) {
    let conn = db.get_conn_safe().expect("migrated VFS connection");
    let created = VfsInkBoardRepo::create_blank_with_conn(
        &conn,
        db.blobs_dir(),
        "Native Ink E2E board",
        InkRuling::Blank,
        "e2e-board-create",
        None,
    )
    .expect("create board through migrated repository");
    let saved = VfsInkBoardRepo::save_chunks_with_conn(
        &conn,
        db.blobs_dir(),
        &created.document_id,
        &created.revision,
        "e2e-board-save",
        &board_chunks(),
        &[],
    )
    .expect("save board chunks through migrated repository");
    assert_ne!(saved.revision, created.revision);
    (created.document_id, saved.revision)
}

fn board_page_id(db: &VfsDatabase, document_id: &str, revision: &str) -> String {
    let conn = db.get_conn_safe().expect("migrated VFS connection");
    let manifest = VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), document_id)
        .expect("re-read saved board manifest");
    assert_eq!(manifest.revision, revision);
    match manifest.surface.expect("saved board surface") {
        InkBoardSurface::Board { page_id, .. } => page_id,
    }
}

fn render_spec(
    document_id: &str,
    revision: &str,
    page_id: &str,
    crop: InkRect,
    long_edge: u32,
) -> InkRenderSpec {
    InkRenderSpec {
        document_id: document_id.to_owned(),
        expected_revision: revision.to_owned(),
        page_id: page_id.to_owned(),
        crop: None,
        board: Some(InkBoardRenderSpec {
            crop,
            chunk_ids: Vec::new(),
        }),
        long_edge: Some(long_edge),
    }
}

fn render_script(
    positive: &InkRenderSpec,
    positive_scaled: &InkRenderSpec,
    invalid: &InkRenderSpec,
    stale: &InkRenderSpec,
    sources: &[PrepareSourceFixture],
    lifecycle_source: &PrepareSourceFixture,
) -> String {
    let positive = serde_json::to_string(positive).expect("encode positive spec");
    let positive_scaled =
        serde_json::to_string(positive_scaled).expect("encode positive scaled spec");
    let invalid = serde_json::to_string(invalid).expect("encode invalid spec");
    let stale = serde_json::to_string(stale).expect("encode stale spec");
    let sources = serde_json::to_string(
        &sources
            .iter()
            .map(|source| {
                json!({
                    "phase": source.phase,
                    "source_resource_id": source.resource_id,
                })
            })
            .collect::<Vec<_>>(),
    )
    .expect("encode uploaded prepare source identities");
    let lifecycle_source = serde_json::to_string(&json!({
        "phase": lifecycle_source.phase,
        "source_resource_id": lifecycle_source.resource_id,
    }))
    .expect("encode lifecycle prepare source identity");
    format!(
        r##"
(async () => {{
  const invoke = (command, request) =>
    window.__TAURI_INTERNALS__.invoke(command, {{ request }});
  const emit = (event, payload) =>
    window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{ event, payload }});
  const lifecycleWaiters = new Map();
  let lifecycleSequence = 0;
  const lifecycleResultHandler = window.__TAURI_INTERNALS__.transformCallback((event) => {{
    const rawPayload = event && event.payload !== undefined ? event.payload : event;
    const payload = typeof rawPayload === 'string' ? JSON.parse(rawPayload) : rawPayload;
    const waiter = lifecycleWaiters.get(payload.request_id);
    if (waiter) {{
      lifecycleWaiters.delete(payload.request_id);
      waiter(payload);
    }}
  }});
  await window.__TAURI_INTERNALS__.invoke('plugin:event|listen', {{
    event: '{lifecycle_result}',
    target: {{ kind: 'Any' }},
    handler: lifecycleResultHandler,
  }});
  const lifecycleRequest = async (operation, request) => {{
    const request_id = 'lifecycle-' + (++lifecycleSequence);
    const response = new Promise((resolve) => lifecycleWaiters.set(request_id, resolve));
    await emit('{lifecycle_request}', {{ request_id, operation, request }});
    const payload = await response;
    if (!payload.ok) throw new Error(payload.error || 'lifecycle helper failed');
    return payload.result;
  }};
  const run = async (phase, request) => {{
    try {{
      const result = await invoke('vfs_ink_render', request);
      await emit('{result}', {{ phase, ok: true, result }});
    }} catch (error) {{
      await emit('{result}', {{ phase, ok: false, error }});
    }}
  }};
  const prepare = async (source) => {{
    const phase = source.phase;
    let step = 'prepare';
    try {{
      const prepared = await invoke('vfs_ink_prepare', {{
        source_resource_id: source.source_resource_id,
        operation_id: phase + '-prepare',
      }});
      const document_id = prepared.document_id;
      step = 'get_prepared_manifest';
      const opened = await invoke('vfs_ink_get', {{ document_id }});
      const pageRef = opened.pages[0];
      if (!pageRef) throw new Error('Prepared source has no canonical page');
      const page_id = pageRef.page_id;
      step = 'get_prepared_page';
      const empty_page = await invoke('vfs_ink_get_page', {{ document_id, page_id }});
      step = 'render_background_control';
      const before_artifact = await invoke('vfs_ink_render', {{
        document_id, page_id, expected_revision: opened.revision, long_edge: {source_width},
      }});
      const stroke = {{
        id: 'e2e-' + phase + '-stroke', author: 'user', created_at: 3,
        content: {{
          kind: 'stroke',
          samples: [
            {{ x: pageRef.width / 4, y: pageRef.height * 0.75, pressure: 0.5 }},
            {{ x: pageRef.width / 2, y: pageRef.height * 0.75, pressure: 0.5 }},
          ],
          style: {{ tool: 'pen', color: '#000000', width: pageRef.width / 32, pressure_enabled: false }},
        }},
      }};
      step = 'save_page_stroke';
      const saved = await invoke('vfs_ink_save_page', {{
        document_id, expected_revision: opened.revision, operation_id: phase + '-save',
        page: {{ ...empty_page, objects: [...empty_page.objects, stroke] }},
      }});
      step = 'reopen_manifest';
      const reopened = await invoke('vfs_ink_get', {{ document_id }});
      step = 'reopen_page';
      const page = await invoke('vfs_ink_get_page', {{ document_id, page_id }});
      step = 'prepare_reuses_saved_document';
      const reused = await invoke('vfs_ink_prepare', {{
        source_resource_id: source.source_resource_id,
        operation_id: phase + '-reuse',
      }});
      step = 'render_saved_page';
      const artifact = await invoke('vfs_ink_render', {{
        document_id, page_id, expected_revision: reopened.revision, long_edge: {source_width},
      }});
      step = 'reopen_after_render';
      const after_render = await invoke('vfs_ink_get', {{ document_id }});
      const after_page = await invoke('vfs_ink_get_page', {{ document_id, page_id }});
      await emit('{result}', {{ phase, ok: true, result: {{
        prepared, opened, empty_page, before_artifact, saved, reopened, page,
        reused, artifact, after_render, after_page,
      }} }});
    }} catch (error) {{
      await emit('{result}', {{
        phase, ok: false, step,
        error: error instanceof Error ? {{ message: error.message, stack: error.stack }} : error,
      }});
    }}
  }};
  const lifecycle = async (source) => {{
    const phase = source.phase;
    const source_resource_id = source.source_resource_id;
    let step = 'lifecycle_prepare';
    try {{
      const prepared = await invoke('vfs_ink_prepare', {{
        source_resource_id,
        operation_id: phase + '-prepare',
      }});
      const document_id = prepared.document_id;
      const opened = await invoke('vfs_ink_get', {{ document_id }});
      const pageRef = opened.pages[0];
      if (!pageRef) throw new Error('Lifecycle source has no canonical page');
      const page_id = pageRef.page_id;
      const empty_page = await invoke('vfs_ink_get_page', {{ document_id, page_id }});
      const stroke = {{
        id: 'e2e-' + phase + '-stroke', author: 'user', created_at: 3,
        content: {{
          kind: 'stroke',
          samples: [
            {{ x: pageRef.width / 4, y: pageRef.height * 0.75, pressure: 0.5 }},
            {{ x: pageRef.width / 2, y: pageRef.height * 0.75, pressure: 0.5 }},
          ],
          style: {{ tool: 'pen', color: '#000000', width: pageRef.width / 32, pressure_enabled: false }},
        }},
      }};
      step = 'lifecycle_save_initial_stroke';
      const saved = await invoke('vfs_ink_save_page', {{
        document_id, expected_revision: opened.revision, operation_id: phase + '-save',
        page: {{ ...empty_page, objects: [...empty_page.objects, stroke] }},
      }});
      step = 'lifecycle_reopen_initial';
      const reopened = await invoke('vfs_ink_get', {{ document_id }});
      const page = await invoke('vfs_ink_get_page', {{ document_id, page_id }});
      step = 'lifecycle_remove_source_and_default';
      const removed = await lifecycleRequest('delete_source_and_default', {{
        source_resource_id, purge_target: false,
      }});
      step = 'lifecycle_reimport';
      const reimported = await lifecycleRequest('reimport_textbook', {{
        source_resource_id,
      }});
      step = 'lifecycle_prepare_after_restore';
      const prepared_after_restore = await invoke('vfs_ink_prepare', {{
        source_resource_id,
        operation_id: phase + '-prepare',
      }});
      const recovered_document_id = prepared_after_restore.document_id;
      if (recovered_document_id === document_id) {{
        throw new Error('prepare reused a soft-deleted default Ink document');
      }}
      const opened_after_restore = await invoke('vfs_ink_get', {{
        document_id: recovered_document_id,
      }});
      const recovered_pageRef = opened_after_restore.pages[0];
      if (!recovered_pageRef) throw new Error('Recovered source has no canonical page');
      const recovered_page_id = recovered_pageRef.page_id;
      const empty_page_after_restore = await invoke('vfs_ink_get_page', {{
        document_id: recovered_document_id, page_id: recovered_page_id,
      }});
      const recovered_stroke = {{
        id: 'e2e-' + phase + '-stroke', author: 'user', created_at: 3,
        content: {{
          kind: 'stroke',
          samples: [
            {{ x: recovered_pageRef.width / 4, y: recovered_pageRef.height * 0.75, pressure: 0.5 }},
            {{ x: recovered_pageRef.width / 2, y: recovered_pageRef.height * 0.75, pressure: 0.5 }},
          ],
          style: {{ tool: 'pen', color: '#000000', width: recovered_pageRef.width / 32, pressure_enabled: false }},
        }},
      }};
      step = 'lifecycle_save_recovered_stroke';
      const saved_after_restore = await invoke('vfs_ink_save_page', {{
        document_id: recovered_document_id,
        expected_revision: opened_after_restore.revision,
        operation_id: phase + '-recovered-save',
        page: {{
          ...empty_page_after_restore,
          objects: [...empty_page_after_restore.objects, recovered_stroke],
        }},
      }});
      step = 'lifecycle_reopen_recovered';
      const reopened_after_restore = await invoke('vfs_ink_get', {{
        document_id: recovered_document_id,
      }});
      const page_after_restore = await invoke('vfs_ink_get_page', {{
        document_id: recovered_document_id, page_id: recovered_page_id,
      }});
      step = 'lifecycle_reuse_recovered';
      const reused_new = await invoke('vfs_ink_prepare', {{
        source_resource_id,
        operation_id: phase + '-reuse',
      }});
      const reused_same_operation = await invoke('vfs_ink_prepare', {{
        source_resource_id,
        operation_id: phase + '-prepare',
      }});
      step = 'lifecycle_remove_recovered_for_purge';
      const removed_for_purge = await lifecycleRequest('delete_source_and_default', {{
        source_resource_id, purge_target: true,
      }});
      step = 'lifecycle_reimport_after_purge';
      const reimported_for_purge = await lifecycleRequest('reimport_textbook', {{
        source_resource_id,
      }});
      step = 'lifecycle_prepare_after_purge';
      const prepared_after_purge = await invoke('vfs_ink_prepare', {{
        source_resource_id,
        operation_id: phase + '-prepare',
      }});
      const opened_after_purge = await invoke('vfs_ink_get', {{
        document_id: prepared_after_purge.document_id,
      }});
      await emit('{result}', {{ phase, ok: true, result: {{
        prepared, opened, empty_page, saved, reopened, page,
        removed, reimported,
        prepared_after_restore, opened_after_restore, empty_page_after_restore,
        saved_after_restore, reopened_after_restore, page_after_restore,
        reused_new, reused_same_operation,
        removed_for_purge, reimported_for_purge,
        prepared_after_purge, opened_after_purge,
      }} }});
    }} catch (error) {{
      await emit('{result}', {{
        phase, ok: false, step,
        error: error instanceof Error ? {{ message: error.message, stack: error.stack }} : error,
      }});
    }}
  }};
  await run('{positive_phase}', {positive});
  await run('{positive_scaled_phase}', {positive_scaled});
  await run('{invalid_phase}', {invalid});
  await run('{stale_phase}', {stale});
  for (const source of {sources}) await prepare(source);
  await lifecycle({lifecycle_source});
  await emit('{done}', {{}});
}})().catch(async (error) => {{
  try {{
    await window.__TAURI_INTERNALS__.invoke('plugin:event|emit', {{
      event: 'ink-e2e-boot-error',
      payload: {{ error: String((error && error.stack) || error) }},
    }});
  }} catch (_) {{}}
}});
"##,
        result = EVENT_RESULT,
        done = EVENT_DONE,
        positive_phase = POSITIVE_PHASE,
        positive_scaled_phase = POSITIVE_SCALED_PHASE,
        invalid_phase = INVALID_PHASE,
        stale_phase = STALE_PHASE,
        positive = positive,
        positive_scaled = positive_scaled,
        invalid = invalid,
        stale = stale,
        sources = sources,
        lifecycle_source = lifecycle_source,
        lifecycle_request = EVENT_LIFECYCLE_REQUEST,
        lifecycle_result = EVENT_LIFECYCLE_RESULT,
        source_width = SOURCE_RENDER_WIDTH,
    )
}

fn artifact_count_for_document(db: &VfsDatabase, document_id: &str) -> usize {
    let conn = db.get_conn_safe().expect("migrated VFS connection");
    let mut statement = conn
        .prepare("SELECT metadata_json FROM ink_render_artifacts")
        .expect("prepare artifact count");
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query artifact rows");
    rows.filter_map(Result::ok)
        .filter(|raw| {
            serde_json::from_str::<Value>(raw)
                .ok()
                .and_then(|value| value["document_id"].as_str().map(str::to_owned))
                .is_some_and(|id| id == document_id)
        })
        .count()
}

fn phase_result(messages: &[Value], requested: &str) -> Value {
    messages
        .iter()
        .find(|message| {
            message["kind"] == "result" && message["payload"]["phase"].as_str() == Some(requested)
        })
        .cloned()
        .unwrap_or_else(|| panic!("missing native render phase {requested}: {messages:?}"))
}

fn error_code(error: &Value) -> String {
    error
        .get("code")
        .and_then(Value::as_str)
        .or_else(|| error.as_str())
        .unwrap_or_default()
        .to_owned()
}

fn assert_source_unchanged(db: &VfsDatabase, document_id: &str, revision: &str) {
    let conn = db.get_conn_safe().expect("migrated VFS connection");
    let manifest = VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), document_id)
        .expect("re-read source board after render");
    assert_eq!(
        manifest.revision, revision,
        "render must not rewrite the board"
    );
    assert_eq!(manifest.chunks.len(), 2, "render must not detach chunks");
    for chunk_ref in &manifest.chunks {
        let blob = VfsBlobRepo::get_blob_with_conn(&conn, &chunk_ref.blob_hash)
            .expect("read chunk blob metadata")
            .expect("chunk blob remains readable");
        assert_eq!(blob.size, chunk_ref.byte_length as i64);
    }
}

fn assert_artifact(
    db: &VfsDatabase,
    document_id: &str,
    revision: &str,
    page_id: &str,
    render_id: &str,
    scale: u32,
) {
    let conn = db.get_conn_safe().expect("migrated VFS connection");
    let (artifact, bytes) = VfsInkArtifactRepo::load_with_conn(&conn, db.blobs_dir(), render_id)
        .expect("load and hash-check published artifact");
    assert_eq!(artifact.document_id, document_id);
    assert_eq!(artifact.revision, revision);
    assert_eq!(artifact.page_id, page_id);
    assert_eq!(artifact.crop, Some(board_crop()));
    assert_eq!(
        (artifact.width_px, artifact.height_px),
        (200 * scale, 160 * scale)
    );
    assert_eq!(artifact.mime_type, "image/png");
    assert_eq!(artifact.blob_hash, artifact.content_hash);
    assert_eq!(
        VfsBlobRepo::compute_hash(&bytes),
        artifact.content_hash,
        "stored immutable PNG hash must match"
    );

    let rgba = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .expect("decode published PNG")
        .to_rgba8();
    let pixel = |x: u32, y: u32| rgba.get_pixel(x * scale, y * scale).0;
    assert_eq!(
        pixel(10, 10),
        [255, 255, 255, 255],
        "blank board background"
    );
    assert_eq!(
        pixel(65, 45),
        [0, 0, 0, 255],
        "negative-origin crop translation"
    );
    assert_eq!(
        pixel(150, 120),
        [255, 0, 0, 255],
        "AI region inside the crop"
    );
    let highlighter = pixel(150, 150);
    assert_eq!(highlighter[1], 255);
    assert_eq!(highlighter[0], highlighter[2]);
    assert!(
        (120..=135).contains(&highlighter[0]),
        "highlighter must blend over white, got {highlighter:?}"
    );
    assert_eq!(highlighter[3], 255);
}

fn expected_prepared_artifact_size(page: &InkPageRef) -> (u32, u32) {
    let scale = SOURCE_RENDER_WIDTH as f64 / page.width.max(page.height);
    (
        (page.width * scale).floor().max(1.0) as u32,
        (page.height * scale).floor().max(1.0) as u32,
    )
}

fn count_pixels_near(
    image: &image::RgbaImage,
    target: [u8; 3],
    tolerance: u8,
    y_start: f64,
    y_end: f64,
) -> usize {
    let start = ((image.height() as f64) * y_start).floor() as u32;
    let end = ((image.height() as f64) * y_end).ceil() as u32;
    let mut count = 0;
    for y in start.min(image.height())..end.min(image.height()) {
        for x in 0..image.width() {
            let pixel = image.get_pixel(x, y).0;
            if pixel[3] > 240
                && pixel[..3]
                    .iter()
                    .zip(target)
                    .all(|(actual, expected)| (*actual).abs_diff(expected) <= tolerance)
            {
                count += 1;
            }
        }
    }
    count
}

fn is_near_white(pixel: [u8; 4]) -> bool {
    pixel[3] > 240 && pixel[..3].iter().all(|channel| *channel >= 245)
}

fn white_fraction(image: &image::RgbaImage) -> f64 {
    let white = image
        .pixels()
        .filter(|pixel| is_near_white(pixel.0))
        .count();
    white as f64 / (image.width() as f64 * image.height() as f64)
}

fn assert_prepared_background(image: &image::RgbaImage, source: &PrepareSourceFixture) {
    let width = image.width();
    let height = image.height();
    match source.format {
        SourceFormat::Pdf | SourceFormat::Image => {
            assert_eq!(
                image.get_pixel(width * 11 / 16, height * 7 / 24).0,
                BLUE_MARKER,
                "{} source marker survives conversion",
                source.format.label()
            );
            assert_eq!(
                image.get_pixel(width * 3 / 8, height * 3 / 4).0,
                WHITE,
                "{} converted paper outside the marker is white",
                source.format.label()
            );
        }
        SourceFormat::Docx | SourceFormat::Pptx => {
            let markers = count_pixels_near(image, [0, 0, 255], 24, 0.0, 1.0);
            assert!(
                markers > 20,
                "{} real page must contain the in-package blue marker, found {markers} pixels",
                source.format.label()
            );
            assert!(
                count_pixels_near(image, [0, 0, 255], 24, 0.0, 0.6) > 20,
                "{} marker must be rendered on the upper page area",
                source.format.label()
            );
            assert!(
                white_fraction(image) > 0.5,
                "{} rendered page must retain a white paper background",
                source.format.label()
            );
            assert!(
                is_near_white(image.get_pixel(1, 1).0),
                "{} page corner must be white paper",
                source.format.label()
            );
        }
    }
}

fn stroke_band_dark_pixels(image: &image::RgbaImage, page_ref: &InkPageRef) -> usize {
    let scale_x = image.width() as f64 / page_ref.width;
    let scale_y = image.height() as f64 / page_ref.height;
    let x_start = ((page_ref.width * 0.20) * scale_x).floor() as u32;
    let x_end = ((page_ref.width * 0.55) * scale_x).ceil() as u32;
    let y_start = ((page_ref.height * 0.70) * scale_y).floor() as u32;
    let y_end = ((page_ref.height * 0.80) * scale_y).ceil() as u32;
    let mut count = 0;
    for y in y_start.min(image.height())..y_end.min(image.height()) {
        for x in x_start.min(image.width())..x_end.min(image.width()) {
            let pixel = image.get_pixel(x, y).0;
            if pixel[3] > 240 && pixel[..3].iter().all(|channel| *channel < 60) {
                count += 1;
            }
        }
    }
    count
}

fn assert_prepared_artifacts(
    source: &PrepareSourceFixture,
    page_ref: &InkPageRef,
    before: &image::RgbaImage,
    after: &image::RgbaImage,
) {
    for image in [before, after] {
        match source.format {
            SourceFormat::Pdf | SourceFormat::Image => {
                assert_eq!(
                    image.get_pixel(10, 10).0,
                    WHITE,
                    "white {} source paper",
                    source.format.label()
                );
                assert_eq!(
                    image.get_pixel(110, 35).0,
                    BLUE_MARKER,
                    "{} source marker survives conversion/render",
                    source.format.label()
                );
                assert_eq!(
                    image.get_pixel(60, 100).0,
                    WHITE,
                    "outside the saved {} stroke",
                    source.format.label()
                );
            }
            SourceFormat::Docx | SourceFormat::Pptx => {
                assert!(
                    is_near_white(image.get_pixel(2, 2).0),
                    "{} rendered artifact must keep white paper",
                    source.format.label()
                );
                assert!(
                    white_fraction(image) > 0.5,
                    "{} rendered artifact must be mostly white paper",
                    source.format.label()
                );
                assert!(
                    count_pixels_near(image, [0, 0, 255], 24, 0.0, 1.0) > 5,
                    "{} in-package marker must survive conversion/render",
                    source.format.label()
                );
            }
        }
    }
    match source.format {
        SourceFormat::Pdf | SourceFormat::Image => {
            assert_eq!(before.get_pixel(60, 90).0, WHITE, "background-only control");
            assert_eq!(
                after.get_pixel(60, 90).0,
                [0, 0, 0, 255],
                "real saved stroke over the frozen background"
            );
        }
        SourceFormat::Docx | SourceFormat::Pptx => {
            let background_only = stroke_band_dark_pixels(before, page_ref);
            let annotated = stroke_band_dark_pixels(after, page_ref);
            assert!(
                background_only <= 20,
                "{} paper around the saved stroke must start unmarked, found {background_only} dark pixels",
                source.format.label()
            );
            assert!(
                annotated > background_only + 40,
                "{} real saved stroke must add dark pixels in the expected band: before={background_only}, after={annotated}",
                source.format.label()
            );
        }
    }
}

fn assert_source_content_unchanged(db: &VfsDatabase, source: &PrepareSourceFixture) {
    match source.storage {
        SourceStorage::InlineAttachment => {
            let unchanged = source_snapshot(db, &source.resource_id, &source.file_id);
            assert_eq!(
                STANDARD
                    .decode(
                        unchanged["resource"]["data"]
                            .as_str()
                            .expect("inline source data")
                    )
                    .expect("decode unchanged inline source"),
                source.bytes
            );
        }
        SourceStorage::TextbookBlob => {
            let unchanged = source_snapshot(db, &source.resource_id, &source.file_id);
            assert_eq!(
                unchanged["resource"]["data"].as_str(),
                source.extracted_text.as_deref(),
                "textbook extracted text must remain untouched"
            );
            assert_eq!(
                unchanged["file"]["blobHash"].as_str(),
                Some(source.source_hash.as_str())
            );
            let conn = db.get_conn_safe().expect("textbook source blob connection");
            let blob = VfsBlobRepo::get_blob_with_conn(&conn, &source.source_hash)
                .expect("read textbook source blob metadata")
                .expect("textbook source blob remains readable");
            assert!(blob.ref_count > 0);
            let path =
                VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &source.source_hash)
                    .expect("resolve textbook source blob")
                    .expect("textbook source blob path");
            let stored = std::fs::read(path).expect("read unchanged textbook source bytes");
            assert_eq!(
                VfsBlobRepo::compute_hash(&stored),
                source.source_hash,
                "textbook source bytes must keep their imported hash"
            );
            assert_eq!(
                stored, source.bytes,
                "textbook source bytes must remain byte-for-byte unchanged"
            );
        }
    }
}

fn load_prepared_artifact(
    db: &VfsDatabase,
    wire: &Value,
    manifest: &InkManifest,
    source: &PrepareSourceFixture,
) -> (String, image::RgbaImage) {
    let render_id = wire["render_id"].as_str().expect("native paged render ID");
    let conn = db.get_conn_safe().expect("prepared artifact connection");
    let (artifact, bytes) = VfsInkArtifactRepo::load_with_conn(&conn, db.blobs_dir(), render_id)
        .expect("load and hash-check immutable prepared-page artifact");
    assert_eq!(serde_json::to_value(&artifact).unwrap(), *wire);
    assert_eq!(artifact.document_id, manifest.document_id);
    assert_eq!(artifact.revision, manifest.revision);
    assert_eq!(artifact.page_id, manifest.pages[0].page_id);
    assert_eq!(
        artifact.source_hash.as_deref(),
        Some(source.source_hash.as_str())
    );
    let conversion_revision = match &manifest.source {
        InkSource::Resource {
            conversion_revision,
            ..
        } => conversion_revision,
        other => panic!("prepared source must retain its provenance: {other:?}"),
    };
    assert_eq!(
        artifact.conversion_revision.as_ref(),
        Some(conversion_revision)
    );
    assert_eq!(artifact.crop, None);
    let expected_size = expected_prepared_artifact_size(&manifest.pages[0]);
    assert_eq!(
        (artifact.width_px, artifact.height_px),
        expected_size,
        "prepared {} render must preserve the canonical page aspect",
        source.format.label()
    );
    assert_eq!(artifact.mime_type, "image/png");
    assert_eq!(artifact.blob_hash, artifact.content_hash);
    assert_eq!(VfsBlobRepo::compute_hash(&bytes), artifact.content_hash);
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
        .expect("decode real prepared-page render")
        .to_rgba8();
    assert_eq!(image.dimensions(), expected_size);
    (artifact.content_hash, image)
}

fn assert_prepared_source(db: &VfsDatabase, source: &PrepareSourceFixture, messages: &[Value]) {
    let message = phase_result(messages, source.phase);
    assert_eq!(
        message["payload"]["ok"].as_bool(),
        Some(true),
        "native prepare/page scenario failed: {message:?}"
    );
    let result = &message["payload"]["result"];
    let prepared: InkManifest =
        serde_json::from_value(result["prepared"].clone()).expect("typed native prepare result");
    let opened: InkManifest =
        serde_json::from_value(result["opened"].clone()).expect("typed reopened prepared manifest");
    let empty_page: InkPage =
        serde_json::from_value(result["empty_page"].clone()).expect("typed initial prepared page");
    let saved: InkManifest =
        serde_json::from_value(result["saved"].clone()).expect("typed native save result");
    let reopened: InkManifest = serde_json::from_value(result["reopened"].clone())
        .expect("typed saved manifest reopened through IPC");
    let page: InkPage = serde_json::from_value(result["page"].clone())
        .expect("typed saved page reopened through IPC");
    assert_eq!(prepared, opened);
    assert_eq!(prepared.schema_version, INK_SCHEMA_VERSION);
    assert_eq!(prepared.pages.len(), 1);
    assert_ne!(prepared.document_id, source.file_id);
    assert_ne!(prepared.document_id, source.resource_id);
    let expected_prefix = source.format.conversion_prefix();
    match &prepared.source {
        InkSource::Resource {
            resource_id,
            source_hash,
            conversion_revision,
        } => {
            assert_eq!(resource_id, &source.resource_id);
            assert_eq!(source_hash, &source.source_hash);
            assert!(conversion_revision.starts_with(expected_prefix));
        }
        other => panic!("prepared manifest lost source identity: {other:?}"),
    }
    let initial_ref = &prepared.pages[0];
    assert!(initial_ref.width > 0.0 && initial_ref.height > 0.0);
    let background_hash = match (&initial_ref.background, source.format) {
        (
            InkBackground::PdfPage {
                blob_hash,
                source_page_index,
            },
            SourceFormat::Pdf,
        ) => {
            assert_eq!(*source_page_index, 0);
            assert_eq!((initial_ref.width, initial_ref.height), (2048.0, 1536.0));
            blob_hash
        }
        (InkBackground::Image { blob_hash }, SourceFormat::Image) => {
            assert_eq!((initial_ref.width, initial_ref.height), (160.0, 120.0));
            blob_hash
        }
        (InkBackground::Image { blob_hash }, SourceFormat::Docx | SourceFormat::Pptx) => {
            assert!(
                (0.4..=4.0).contains(&(initial_ref.width / initial_ref.height)),
                "{} renderer produced an implausible page aspect: {}x{}",
                source.format.label(),
                initial_ref.width,
                initial_ref.height
            );
            blob_hash
        }
        (other, format) => panic!(
            "{} prepared source must own the expected converted PNG background, got {other:?}",
            format.label()
        ),
    };
    assert_eq!(empty_page.page_id, initial_ref.page_id);
    assert_eq!(empty_page.schema_version, INK_SCHEMA_VERSION);
    assert!(empty_page.objects.is_empty());
    assert_eq!(saved.document_id, prepared.document_id);
    assert_ne!(
        saved.revision, prepared.revision,
        "real page save must advance CAS revision"
    );
    assert_eq!(saved, reopened);
    assert_eq!(saved.pages.len(), 1);
    assert_eq!(saved.source, prepared.source);
    let saved_ref = &saved.pages[0];
    assert_eq!(saved_ref.page_id, initial_ref.page_id);
    assert_eq!(
        (saved_ref.width, saved_ref.height),
        (initial_ref.width, initial_ref.height)
    );
    assert_eq!(saved_ref.background, initial_ref.background);
    assert_ne!(saved_ref.page_blob_hash, initial_ref.page_blob_hash);
    assert_eq!(page.page_id, saved_ref.page_id);
    assert_eq!(page.schema_version, INK_SCHEMA_VERSION);
    assert_eq!(
        page.objects,
        vec![prepared_stroke(source.phase, initial_ref)]
    );
    for key in ["reused", "after_render"] {
        let manifest: InkManifest = serde_json::from_value(result[key].clone())
            .expect("typed reused/post-render canonical manifest");
        assert_eq!(
            manifest, saved,
            "{key} must preserve the saved page revision and background"
        );
    }
    assert_eq!(result["after_page"], result["page"]);

    {
        let conn = db.get_conn_safe().expect("prepared page repository reopen");
        let manifest =
            VfsInkRepo::get_manifest_with_conn(&conn, db.blobs_dir(), &saved.document_id)
                .expect("reopen canonical manifest from migrated VFS");
        let stored_page = VfsInkRepo::get_page_with_conn(
            &conn,
            db.blobs_dir(),
            &saved.document_id,
            &saved_ref.page_id,
        )
        .expect("reopen canonical saved page from migrated VFS");
        assert_eq!(manifest, saved);
        assert_eq!(stored_page, page);
        let page_path =
            VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), &saved_ref.page_blob_hash)
                .unwrap()
                .expect("saved page body blob");
        let page_bytes = std::fs::read(page_path).expect("read saved page body bytes");
        assert_eq!(
            VfsBlobRepo::compute_hash(&page_bytes),
            saved_ref.page_blob_hash
        );
        assert_eq!(
            serde_json::from_slice::<InkPage>(&page_bytes).unwrap(),
            page
        );
        let blob = VfsBlobRepo::get_blob_with_conn(&conn, background_hash)
            .unwrap()
            .expect("converted background blob");
        assert!(
            blob.ref_count > 0,
            "canonical manifest must own the converted PNG"
        );
        assert_eq!(blob.mime_type.as_deref(), Some("image/png"));
        let path = VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), background_hash)
            .unwrap()
            .expect("converted background path");
        let bytes = std::fs::read(path).expect("read converted PNG bytes");
        assert_eq!(bytes.len() as i64, blob.size);
        assert_eq!(VfsBlobRepo::compute_hash(&bytes), *background_hash);
        let background = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png)
            .expect("decode PNG actually converted by job bridge")
            .to_rgba8();
        assert_eq!(
            background.dimensions(),
            (initial_ref.width as u32, initial_ref.height as u32)
        );
        assert_prepared_background(&background, source);
    }

    let (before_hash, before) =
        load_prepared_artifact(db, &result["before_artifact"], &prepared, source);
    let (after_hash, after) = load_prepared_artifact(db, &result["artifact"], &saved, source);
    assert_ne!(
        before_hash, after_hash,
        "render bytes must change when the real stroke is saved"
    );
    assert_ne!(
        result["before_artifact"]["render_id"],
        result["artifact"]["render_id"]
    );
    assert_prepared_artifacts(source, &prepared.pages[0], &before, &after);
    assert_eq!(artifact_count_for_document(db, &saved.document_id), 2);

    let jobs = messages
        .iter()
        .filter(|message| {
            message["kind"] == "job"
                && message["payload"]["source_resource_id"].as_str()
                    == Some(source.resource_id.as_str())
        })
        .collect::<Vec<_>>();
    assert_eq!(
        jobs.len(),
        1,
        "first prepare must dispatch exactly one real job; reuse must dispatch none"
    );
    assert_eq!(jobs[0]["payload"]["kind"], "prepare");
    assert_eq!(
        jobs[0]["payload"]["operation_id"],
        format!("{}-prepare", source.phase)
    );
    assert_eq!(
        jobs[0]["payload"]["source_hash"].as_str(),
        Some(source.source_hash.as_str())
    );

    let unchanged = source_snapshot(db, &source.resource_id, &source.file_id);
    assert_eq!(
        unchanged, source.snapshot,
        "source bytes, text hash, type, linkage, and file row must remain unchanged"
    );
    assert_source_content_unchanged(db, source);
    let mut metadata = source_metadata(db, &source.resource_id);
    assert_eq!(
        metadata["default_ink_document_id"].as_str(),
        Some(saved.document_id.as_str())
    );
    let converter_version = metadata["ink_prepare_info"]["converter_version"]
        .as_str()
        .expect("production prepare converter metadata");
    assert_eq!(
        converter_version,
        jobs[0]["payload"]["expected_converter_version"]
            .as_str()
            .unwrap()
    );
    let warnings = metadata["ink_prepare_info"]["warnings"]
        .as_array()
        .expect("prepare warnings metadata");
    if source.format.is_office() {
        assert_eq!(
            warnings.len(),
            1,
            "{} conversion must report the production Office warning",
            source.format.label()
        );
        assert!(
            warnings[0]
                .as_str()
                .is_some_and(|warning| warning.contains("Browser rendering may differ")),
            "{} Office warning changed: {warnings:?}",
            source.format.label()
        );
    } else {
        assert_eq!(
            metadata["ink_prepare_info"]["warnings"],
            json!([]),
            "{} conversion must not invent warnings",
            source.format.label()
        );
    }
    let fields = metadata.as_object_mut().expect("source metadata object");
    fields.remove("default_ink_document_id");
    fields.remove("ink_prepare_info");
    assert_eq!(
        metadata, source.metadata,
        "preparation may only add its own pointer/converter metadata"
    );
}

fn assert_lifecycle_metadata_preserved(
    db: &VfsDatabase,
    source: &PrepareSourceFixture,
    expected_pointer: &str,
) {
    let mut metadata = source_metadata(db, &source.resource_id);
    assert_eq!(
        metadata["default_ink_document_id"].as_str(),
        Some(expected_pointer),
        "source default pointer must be replaced with the recovered active document"
    );
    let fields = metadata
        .as_object_mut()
        .expect("lifecycle source metadata object");
    fields.remove("default_ink_document_id");
    fields.remove("ink_prepare_info");
    assert_eq!(
        metadata, source.metadata,
        "stale recovery may only replace its own pointer/converter metadata"
    );
}

fn assert_lifecycle_source(db: &VfsDatabase, source: &PrepareSourceFixture, messages: &[Value]) {
    let message = phase_result(messages, source.phase);
    assert_eq!(
        message["payload"]["ok"].as_bool(),
        Some(true),
        "lifecycle prepare/save/delete/re-import/recover failed: {message:?}"
    );
    let result = &message["payload"]["result"];

    let initial: InkManifest =
        serde_json::from_value(result["prepared"].clone()).expect("initial lifecycle manifest");
    let initial_opened: InkManifest = serde_json::from_value(result["opened"].clone())
        .expect("initial lifecycle manifest reopened through IPC");
    let initial_saved: InkManifest = serde_json::from_value(result["reopened"].clone())
        .expect("initial saved lifecycle manifest");
    let initial_saved_return: InkManifest = serde_json::from_value(result["saved"].clone())
        .expect("initial saved lifecycle save return");
    let initial_page: InkPage =
        serde_json::from_value(result["page"].clone()).expect("initial saved lifecycle page");
    assert_eq!(initial, initial_opened);
    assert_eq!(initial_saved_return, initial_saved);
    assert_eq!(initial.pages.len(), 1);
    assert_eq!(initial_saved.document_id, initial.document_id);
    assert_eq!(initial_saved.pages.len(), 1);
    assert_ne!(initial_saved.revision, initial.revision);
    assert_ne!(initial.document_id, source.file_id);
    assert_ne!(initial.document_id, source.resource_id);
    match &initial.source {
        InkSource::Resource {
            resource_id,
            source_hash,
            conversion_revision,
        } => {
            assert_eq!(resource_id, &source.resource_id);
            assert_eq!(source_hash, &source.source_hash);
            assert!(conversion_revision.starts_with("ink-pdf-pages-v1-"));
        }
        other => panic!("lifecycle source lost its prepared provenance: {other:?}"),
    }
    assert!(matches!(
        &initial.pages[0].background,
        InkBackground::PdfPage {
            source_page_index: 0,
            ..
        }
    ));
    assert_eq!(
        initial_page.objects,
        vec![prepared_stroke(source.phase, &initial.pages[0])],
        "the first lifecycle document must contain the real saved user stroke"
    );

    let removed = &result["removed"];
    assert_eq!(
        removed["target_document_id"].as_str(),
        Some(initial.document_id.as_str())
    );
    assert_eq!(removed["target_status"].as_str(), Some("deleted"));
    let old_deleted_at = removed["target_deleted_at"]
        .as_str()
        .expect("soft-deleted lifecycle target must expose deleted_at")
        .to_owned();
    assert_eq!(removed["source_status"].as_str(), Some("deleted"));
    assert!(
        removed["source_deleted_at"].as_str().is_some(),
        "real source soft delete must stamp deleted_at: {removed:?}"
    );
    assert_eq!(removed["target_purged"].as_bool(), Some(false));

    let reimported = &result["reimported"];
    assert_eq!(
        reimported["file_id"].as_str(),
        Some(source.file_id.as_str())
    );
    assert_eq!(
        reimported["resource_id"].as_str(),
        Some(source.resource_id.as_str())
    );
    assert_eq!(reimported["status"].as_str(), Some("active"));
    assert_eq!(
        reimported["sha256"].as_str(),
        Some(source.source_hash.as_str())
    );
    assert!(reimported["deleted_at"].is_null());
    assert_eq!(
        reimported["default_ink_document_id_before_prepare"].as_str(),
        Some(initial.document_id.as_str()),
        "trash + textbook dedup restore must leave the stale default pointer untouched"
    );

    let recovered: InkManifest = serde_json::from_value(result["prepared_after_restore"].clone())
        .expect("prepare result after textbook dedup restore");
    let recovered_opened: InkManifest =
        serde_json::from_value(result["opened_after_restore"].clone())
            .expect("recovered active manifest reopened through IPC");
    assert_eq!(recovered, recovered_opened);
    assert_ne!(
        recovered.document_id, initial.document_id,
        "a soft-deleted default Ink document must never be reused"
    );
    assert_eq!(recovered.pages.len(), 1);
    match &recovered.source {
        InkSource::Resource {
            resource_id,
            source_hash,
            ..
        } => {
            assert_eq!(resource_id, &source.resource_id);
            assert_eq!(source_hash, &source.source_hash);
        }
        other => panic!("recovered lifecycle source lost its provenance: {other:?}"),
    }

    let saved_recovered: InkManifest =
        serde_json::from_value(result["saved_after_restore"].clone())
            .expect("saved recovered lifecycle manifest");
    let reopened_recovered: InkManifest =
        serde_json::from_value(result["reopened_after_restore"].clone())
            .expect("reopened recovered lifecycle manifest");
    assert_eq!(saved_recovered, reopened_recovered);
    assert_ne!(
        saved_recovered.revision, recovered.revision,
        "saving into the recovered document must advance CAS revision"
    );
    let recovered_page: InkPage = serde_json::from_value(result["page_after_restore"].clone())
        .expect("saved recovered lifecycle page");
    assert_eq!(
        recovered_page.objects,
        vec![prepared_stroke(source.phase, &recovered.pages[0])],
        "the recovered active document must accept and reopen a real user stroke"
    );
    let reused: InkManifest = serde_json::from_value(result["reused_new"].clone())
        .expect("prepare reuse of recovered manifest");
    assert_eq!(reused, reopened_recovered);
    assert_eq!(
        reused.document_id, recovered.document_id,
        "a valid active default document must be reused"
    );
    let reused_same_operation: InkManifest =
        serde_json::from_value(result["reused_same_operation"].clone())
            .expect("prepare with the original operation id after stale recovery");
    assert_eq!(
        reused_same_operation, reopened_recovered,
        "reusing the original operation id must not attach stale-recovery work to the deleted document"
    );

    let conn = db.get_conn_safe().expect("lifecycle repository connection");
    let old_file = VfsFileRepo::get_file_with_conn(&conn, &initial.document_id)
        .expect("read deleted old Ink file")
        .expect("soft-deleted old Ink file must remain in the trash");
    assert_eq!(old_file.status, "deleted");
    assert_eq!(
        old_file.deleted_at.as_deref(),
        Some(old_deleted_at.as_str())
    );
    let old_manifest_hash = old_file
        .blob_hash
        .as_deref()
        .expect("old Ink file manifest hash");
    let old_manifest_path =
        VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), old_manifest_hash)
            .expect("resolve deleted old manifest")
            .expect("deleted old manifest blob remains readable");
    let old_manifest_bytes = std::fs::read(&old_manifest_path).expect("read deleted old manifest");
    assert_eq!(
        VfsBlobRepo::compute_hash(&old_manifest_bytes),
        old_manifest_hash
    );
    let old_manifest: InkManifest =
        serde_json::from_slice(&old_manifest_bytes).expect("decode deleted old manifest");
    assert_eq!(old_manifest, initial_saved);
    let old_page_hash = &initial_saved.pages[0].page_blob_hash;
    let old_page_path = VfsBlobRepo::get_blob_path_with_conn(&conn, db.blobs_dir(), old_page_hash)
        .expect("resolve deleted old page")
        .expect("deleted old page blob remains readable");
    let old_page_bytes = std::fs::read(&old_page_path).expect("read deleted old page");
    assert_eq!(
        VfsBlobRepo::compute_hash(&old_page_bytes),
        old_page_hash.as_str()
    );
    let stored_old_page: InkPage =
        serde_json::from_slice(&old_page_bytes).expect("decode deleted old page");
    assert_eq!(
        stored_old_page, initial_page,
        "soft delete and stale recovery must not rewrite the old user stroke blob"
    );

    // The explicit purge scenario below runs inside the same Wry session after
    // this recovery. The recovered document is therefore already gone by the
    // time this thread joins: its active state, saved revision, and page are
    // proven by the real IPC reopen snapshots above, while the purge result
    // below proves it was active immediately before the explicit purge.
    assert!(
        VfsFileRepo::get_file_with_conn(&conn, &recovered.document_id)
            .expect("read purged recovered Ink file")
            .is_none(),
        "the recovered default document must not survive the explicit purge"
    );
    let recovered_source = source_snapshot(db, &source.resource_id, &source.file_id);
    assert_eq!(
        recovered_source["resource"], source.snapshot["resource"],
        "source bytes, hash, type, linkage, and storage mode must survive trash + restore"
    );
    assert_eq!(recovered_source["file"]["status"].as_str(), Some("active"));
    assert!(recovered_source["file"]["deletedAt"].is_null());
    for key in [
        "id",
        "sha256",
        "blobHash",
        "fileName",
        "size",
        "fileType",
        "mimeType",
        "pageCount",
        "originalPath",
    ] {
        assert_eq!(
            recovered_source["file"][key], source.snapshot["file"][key],
            "source file field {key} must survive textbook dedup restore"
        );
    }
    assert_source_content_unchanged(db, source);

    let removed_for_purge = &result["removed_for_purge"];
    assert_eq!(
        removed_for_purge["target_document_id"].as_str(),
        Some(recovered.document_id.as_str())
    );
    assert_eq!(removed_for_purge["target_status"].as_str(), Some("purged"));
    assert_eq!(removed_for_purge["target_purged"].as_bool(), Some(true));
    let reimported_for_purge = &result["reimported_for_purge"];
    assert_eq!(
        reimported_for_purge["file_id"].as_str(),
        Some(source.file_id.as_str())
    );
    assert_eq!(
        reimported_for_purge["resource_id"].as_str(),
        Some(source.resource_id.as_str())
    );
    assert_eq!(reimported_for_purge["status"].as_str(), Some("active"));

    let recovered_after_purge: InkManifest =
        serde_json::from_value(result["prepared_after_purge"].clone())
            .expect("prepare result after purged default target");
    let opened_after_purge: InkManifest =
        serde_json::from_value(result["opened_after_purge"].clone())
            .expect("manifest after purged default target reopened through IPC");
    assert_eq!(recovered_after_purge, opened_after_purge);
    assert_ne!(
        recovered_after_purge.document_id, recovered.document_id,
        "a purged (missing) default target must produce a new active document"
    );
    match &recovered_after_purge.source {
        InkSource::Resource {
            resource_id,
            source_hash,
            ..
        } => {
            assert_eq!(resource_id, &source.resource_id);
            assert_eq!(source_hash, &source.source_hash);
        }
        other => panic!("purged-target recovery lost source provenance: {other:?}"),
    }
    assert!(
        VfsFileRepo::get_file_with_conn(&conn, &recovered.document_id)
            .expect("read purged recovered document row")
            .is_none(),
        "purged target must not be resurrected"
    );
    let after_purge_file =
        VfsFileRepo::get_file_with_conn(&conn, &recovered_after_purge.document_id)
            .expect("read active document created after purge")
            .expect("new active document after purge must exist");
    assert_eq!(after_purge_file.status, "active");
    assert!(after_purge_file.deleted_at.is_none());
    assert_lifecycle_metadata_preserved(db, source, &recovered_after_purge.document_id);
    let final_source = source_snapshot(db, &source.resource_id, &source.file_id);
    assert_eq!(final_source["resource"], source.snapshot["resource"]);
    assert_eq!(final_source["file"]["status"].as_str(), Some("active"));
    assert_source_content_unchanged(db, source);

    let old_file_after_purge = VfsFileRepo::get_file_with_conn(&conn, &initial.document_id)
        .expect("read old Ink file after purge of recovered target")
        .expect("purging the recovered target must not purge the older deleted Ink file");
    assert_eq!(old_file_after_purge.status, "deleted");
    assert_eq!(
        old_file_after_purge.deleted_at.as_deref(),
        Some(old_deleted_at.as_str()),
        "stale recovery must not auto-restore the old deleted Ink file"
    );
    let old_page_after_purge =
        std::fs::read(&old_page_path).expect("read old user stroke blob after later purge");
    assert_eq!(
        old_page_after_purge, old_page_bytes,
        "purging a different target must not touch the old user stroke blob"
    );
}

fn main() {
    let isolated = tempfile::tempdir().expect("create isolated XDG root");
    let home = isolated.path().join("home");
    let data = isolated.path().join("data");
    let config = isolated.path().join("config");
    let cache = isolated.path().join("cache");
    for directory in [&home, &data, &config, &cache] {
        std::fs::create_dir_all(directory).expect("create isolated XDG directory");
    }
    std::env::set_var("HOME", &home);
    std::env::set_var("XDG_DATA_HOME", &data);
    std::env::set_var("XDG_CONFIG_HOME", &config);
    std::env::set_var("XDG_CACHE_HOME", &cache);

    let (db_dir, db) = setup_migrated_test_db();
    let db = Arc::new(db);
    let marker = blue_marker_png();
    let sources = [
        upload_prepare_source(
            &db,
            PDF_PREPARE_PHASE,
            SourceFormat::Pdf,
            "inline-native-source.pdf",
            inline_pdf(),
        ),
        upload_prepare_source(
            &db,
            IMAGE_PREPARE_PHASE,
            SourceFormat::Image,
            "inline-native-source.png",
            inline_source_png(),
        ),
        import_textbook_prepare_source(
            &db,
            TEXTBOOK_PDF_PHASE,
            SourceFormat::Pdf,
            "textbook-native-source.pdf",
            textbook_pdf(),
            "PDF textbook extracted text".to_owned(),
        ),
        import_textbook_prepare_source(
            &db,
            TEXTBOOK_DOCX_PHASE,
            SourceFormat::Docx,
            "textbook-native-source.docx",
            minimal_docx(&marker),
            "DOCX textbook extracted text".to_owned(),
        ),
        import_textbook_prepare_source(
            &db,
            TEXTBOOK_PPTX_PHASE,
            SourceFormat::Pptx,
            "textbook-native-source.pptx",
            minimal_pptx(&marker),
            "PPTX textbook extracted text".to_owned(),
        ),
        import_textbook_prepare_source(
            &db,
            TEXTBOOK_IMAGE_PHASE,
            SourceFormat::Image,
            "textbook-native-source.png",
            textbook_source_png(),
            "PNG textbook extracted text".to_owned(),
        ),
    ];
    let mut lifecycle_source = import_textbook_prepare_source(
        &db,
        LIFECYCLE_PDF_PHASE,
        SourceFormat::Pdf,
        "textbook-lifecycle-source.pdf",
        lifecycle_pdf(),
        "PDF lifecycle extracted text".to_owned(),
    );
    seed_source_metadata(
        &db,
        &lifecycle_source.resource_id,
        &json!({
            "e2e_lifecycle_keep": true,
            "e2e_lifecycle_tag": "preserve-through-stale-pointer",
        }),
    );
    lifecycle_source.metadata = source_metadata(&db, &lifecycle_source.resource_id);
    let (document_id, revision) = save_board_fixture(&db);
    let page_id = board_page_id(&db, &document_id, &revision);
    let positive = render_spec(&document_id, &revision, &page_id, board_crop(), 200);
    let positive_scaled = render_spec(&document_id, &revision, &page_id, board_crop(), 400);
    let invalid = render_spec(
        &document_id,
        &revision,
        &page_id,
        InkRect {
            x: -10_000_001.0,
            y: 0.0,
            width: 10.0,
            height: 10.0,
        },
        200,
    );
    let stale = render_spec(
        &document_id,
        "e2e-revision-before-save",
        &page_id,
        board_crop(),
        200,
    );

    let render_script = render_script(
        &positive,
        &positive_scaled,
        &invalid,
        &stale,
        &sources,
        &lifecycle_source,
    );
    let (sender, receiver) = std::sync::mpsc::channel::<Value>();

    // tauri-codegen reads the default tauri.conf.json next to the crate and only
    // overlays TAURI_CONFIG; the file name passed to the macro is not read as a
    // replacement config. Fail loudly here instead of letting the main dev config
    // (devUrl 1422 / empty assets) drive the test into a silent no-message timeout.
    let context = tauri::generate_context!("tauri.ink-e2e.conf.json");
    assert_eq!(
        context.config().identifier, "com.deepstudent.app.ink-e2e",
        "ink E2E context is not the e2e config: build with TAURI_CONFIG=$(cat src-tauri/tauri.ink-e2e.conf.json) exported at compile time"
    );
    assert!(
        context.config().build.dev_url.is_none(),
        "ink E2E context kept the main devUrl; the TAURI_CONFIG overlay must set build.devUrl=null"
    );
    match context.config().build.frontend_dist.as_ref() {
        Some(tauri::utils::config::FrontendDist::Directory(path)) => assert!(
            path.ends_with("target/ink-e2e-client"),
            "ink E2E frontendDist must be target/ink-e2e-client, got {path:?}"
        ),
        other => panic!(
            "ink E2E frontendDist must be the target/ink-e2e-client directory, got {other:?}; run with TAURI_CONFIG=$(cat src-tauri/tauri.ink-e2e.conf.json)"
        ),
    }
    assert!(
        context
            .assets()
            .get(&tauri::utils::assets::AssetKey::from("index.html"))
            .is_some(),
        "ink E2E context embeds no index.html; run with TAURI_CONFIG=$(cat src-tauri/tauri.ink-e2e.conf.json) and npm run build:ink-e2e"
    );

    let app = tauri::Builder::default()
        .manage(db.clone())
        .manage(PendingRenderBus::default())
        .manage(PendingFlushBus::default())
        .manage(PendingInkJobBus::default())
        .invoke_handler(tauri::generate_handler![
            deep_student_lib::ink_jobs::vfs_ink_prepare,
            deep_student_lib::ink_jobs::vfs_ink_job_result,
            deep_student_lib::vfs::ink_commands::vfs_ink_get,
            deep_student_lib::vfs::ink_commands::vfs_ink_get_page,
            deep_student_lib::vfs::ink_commands::vfs_ink_save_page,
            deep_student_lib::vfs::handlers::vfs_get_blob_base64,
            deep_student_lib::ink_bridge::vfs_ink_render,
            deep_student_lib::ink_bridge::vfs_ink_render_result,
            deep_student_lib::ink_bridge::vfs_ink_flush_result,
            deep_student_lib::staged_upload::staged_upload_begin,
            deep_student_lib::staged_upload::staged_upload_append,
            deep_student_lib::staged_upload::staged_upload_abort,
        ])
        .build(context)
        .expect("build real Wry ink E2E app");

    let ready_sender = sender.clone();
    app.listen(EVENT_READY, move |event| {
        let _ = ready_sender.send(event_message("ready", event.payload()));
    });
    let result_sender = sender.clone();
    app.listen(EVENT_RESULT, move |event| {
        let _ = result_sender.send(event_message("result", event.payload()));
    });
    let done_sender = sender.clone();
    app.listen(EVENT_DONE, move |event| {
        let _ = done_sender.send(event_message("done", event.payload()));
    });
    let boot_sender = sender.clone();
    app.listen("ink-e2e-boot-error", move |event| {
        let _ = boot_sender.send(event_message("boot-error", event.payload()));
    });
    let job_sender = sender.clone();
    app.listen("ink:job-request", move |event| {
        let request: Value =
            serde_json::from_str(event.payload()).expect("real Ink job event JSON");
        let _ = job_sender.send(json!({
            "kind": "job",
            "payload": {
                "request_id": request["request_id"],
                "operation_id": request["operation_id"],
                "kind": request["kind"],
                "source_resource_id": request["payload"]["source_resource_id"],
                "source_hash": request["payload"]["source_hash"],
                "expected_converter_version": request["payload"]["expected_converter_version"],
            },
        }));
    });

    let app_handle = app.handle().clone();
    let lifecycle_db = db.clone();
    let lifecycle_app = app_handle.clone();
    app.listen(EVENT_LIFECYCLE_REQUEST, move |event| {
        let request: Value = match serde_json::from_str(event.payload()) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("[ink-e2e] invalid lifecycle request JSON: {error}");
                return;
            }
        };
        let request_id = request["request_id"].clone();
        let operation = request["operation"].as_str().unwrap_or_default();
        let request_payload = request["request"].clone();
        let result = match operation {
            "delete_source_and_default" => {
                serde_json::from_value::<LifecycleRemoveRequest>(request_payload)
                    .map_err(|error| error.to_string())
                    .and_then(|request| {
                        lifecycle_remove_source_and_default(lifecycle_db.as_ref(), request)
                    })
            }
            "reimport_textbook" => {
                serde_json::from_value::<LifecycleReimportRequest>(request_payload)
                    .map_err(|error| error.to_string())
                    .and_then(|request| lifecycle_reimport_textbook(lifecycle_db.as_ref(), request))
            }
            other => Err(format!("unknown lifecycle operation: {other}")),
        };
        let response = match result {
            Ok(value) => json!({
                "request_id": request_id,
                "ok": true,
                "result": value,
            }),
            Err(error) => json!({
                "request_id": request_id,
                "ok": false,
                "error": error,
            }),
        };
        if let Err(error) = lifecycle_app.emit(EVENT_LIFECYCLE_RESULT, response) {
            eprintln!("[ink-e2e] failed to emit lifecycle result: {error}");
        }
    });
    let watchdog = app_handle.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(300));
        watchdog.exit(2);
    });

    let scenario = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(270);
        let mut messages = Vec::new();
        let mut injected = false;
        while Instant::now() < deadline {
            match receiver.recv_timeout(Duration::from_millis(500)) {
                Ok(message) => {
                    let kind = message["kind"].as_str().unwrap_or_default().to_owned();
                    let done = kind == "done";
                    messages.push(message);
                    if kind == "ready" && !injected {
                        injected = true;
                        let window = app_handle
                            .get_webview_window(TEST_APP_LABEL)
                            .expect("configured main webview");
                        let eval_window = window.clone();
                        let script = render_script.clone();
                        window
                            .run_on_main_thread(move || {
                                if let Err(error) = eval_window.eval(script) {
                                    eprintln!(
                                        "[ink-e2e] failed to inject real prepare/page/render requests: {error}"
                                    );
                                }
                            })
                            .expect("schedule real prepare/page/render request injection");
                    }
                    if done || kind == "boot-error" {
                        break;
                    }
                }
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
        app_handle.exit(0);
        messages
    });

    let exit_code = app.run_return(|_, _| {});
    assert_eq!(
        exit_code, 0,
        "native E2E event loop exited non-zero (watchdog fired or scenario aborted)"
    );
    let messages = scenario.join().expect("native E2E scenario thread");

    let ready = messages.iter().any(|message| message["kind"] == "ready");
    let boot_error = messages
        .iter()
        .find(|message| message["kind"] == "boot-error")
        .cloned();
    assert!(
        ready,
        "real frontend renderBridge never registered: {messages:?}"
    );
    assert!(
        boot_error.is_none(),
        "real frontend bridge boot failed: {boot_error:?}"
    );
    let ready_payload = &messages
        .iter()
        .find(|message| message["kind"] == "ready")
        .unwrap()["payload"];
    assert_eq!(
        ready_payload["prepare"], "production-registerInkJobBridge",
        "rebuild the E2E client with the production job bridge"
    );
    assert_eq!(ready_payload["pdfjsVersion"], "5.4.296");
    assert!(
        messages.iter().any(|message| message["kind"] == "done"),
        "native prepare/page/render scenario did not finish: {messages:?}"
    );

    let positive = phase_result(&messages, POSITIVE_PHASE);
    assert_eq!(
        positive["payload"]["ok"].as_bool(),
        Some(true),
        "real native render failed: {positive:?}"
    );
    let artifact = &positive["payload"]["result"];
    let render_id = artifact["render_id"]
        .as_str()
        .expect("positive render returns render_id");
    assert_eq!(artifact["document_id"].as_str(), Some(document_id.as_str()));
    assert_eq!(artifact["revision"].as_str(), Some(revision.as_str()));
    assert_eq!(artifact["width_px"].as_u64(), Some(200));
    assert_eq!(artifact["height_px"].as_u64(), Some(160));
    assert_artifact(&db, &document_id, &revision, &page_id, render_id, 1);
    assert_source_unchanged(&db, &document_id, &revision);
    assert_eq!(
        artifact_count_for_document(&db, &document_id),
        2,
        "all phases have finished by the time the scenario joins on done, so both the 200 and 400 artifacts exist"
    );

    let positive_scaled = phase_result(&messages, POSITIVE_SCALED_PHASE);
    assert_eq!(
        positive_scaled["payload"]["ok"].as_bool(),
        Some(true),
        "real native scaled render failed: {positive_scaled:?}"
    );
    let scaled_artifact = &positive_scaled["payload"]["result"];
    let scaled_render_id = scaled_artifact["render_id"]
        .as_str()
        .expect("scaled render returns render_id");
    assert_ne!(
        scaled_render_id, render_id,
        "the same crop at a different long edge must not reuse the render id"
    );
    assert_eq!(
        scaled_artifact["document_id"].as_str(),
        Some(document_id.as_str())
    );
    assert_eq!(
        scaled_artifact["revision"].as_str(),
        Some(revision.as_str())
    );
    assert_eq!(scaled_artifact["width_px"].as_u64(), Some(400));
    assert_eq!(scaled_artifact["height_px"].as_u64(), Some(320));
    assert_artifact(&db, &document_id, &revision, &page_id, scaled_render_id, 2);
    assert_source_unchanged(&db, &document_id, &revision);
    assert_eq!(
        artifact_count_for_document(&db, &document_id),
        2,
        "the same crop at another long edge must publish a second artifact"
    );

    let invalid = phase_result(&messages, INVALID_PHASE);
    assert_eq!(
        invalid["payload"]["ok"].as_bool(),
        Some(false),
        "{invalid:?}"
    );
    assert_eq!(
        error_code(&invalid["payload"]["error"]),
        "INVALID_ARGUMENT",
        "{invalid:?}"
    );

    let stale = phase_result(&messages, STALE_PHASE);
    assert_eq!(stale["payload"]["ok"].as_bool(), Some(false), "{stale:?}");
    assert_eq!(
        error_code(&stale["payload"]["error"]),
        "REVISION_CONFLICT",
        "{stale:?}"
    );

    assert_eq!(
        artifact_count_for_document(&db, &document_id),
        2,
        "invalid/stale crops must not publish another artifact"
    );
    assert_source_unchanged(&db, &document_id, &revision);
    for source in &sources {
        assert_prepared_source(&db, source, &messages);
    }
    assert_lifecycle_source(&db, &lifecycle_source, &messages);

    drop(db_dir);
    println!(
        "ink_board_render_e2e: board render plus inline PDF/image attachments and blob-backed PDF/DOCX/PPTX/image textbook imports -> real prepare/job conversion/staging -> page save/reopen -> checked background/ink artifacts; stale soft-deleted and purged default .dsink recovery preserves old strokes/metadata PASSED"
    );
}

fn event_message(kind: &str, raw_payload: &str) -> Value {
    let payload = serde_json::from_str::<Value>(raw_payload)
        .unwrap_or_else(|_| Value::String(raw_payload.to_owned()));
    json!({ "kind": kind, "payload": payload })
}
