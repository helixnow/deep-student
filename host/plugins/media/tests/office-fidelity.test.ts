import { expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import {
  buildEditFidelityWarning, enforceEditPreflight, inspectBytes, preflightForEdit,
  type EditGateWording, type EditPreflight,
} from '../src/office-fidelity.ts';

/** 与 Rust 测试相同的手工拼包（默认 deflate 压缩条目）。 */
function zipOf(parts: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, compressed);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x0605_4b50, 0);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

const CONTENT_TYPES: [string, string] = ['[Content_Types].xml', '<Types/>'];

it('docx_inventory_detects_macro_signature_and_revision_without_executing', () => {
  const bytes = zipOf([
    CONTENT_TYPES,
    ['word/document.xml', '<w:document><w:ins/></w:document>'],
    ['word/vbaProject.bin', 'not executable by inspector'],
    ['_xmlsignatures/sig1.xml', '<Signature/>'],
  ]);
  const result = inspectBytes(bytes) as Record<string, any>;
  expect(result.format).toBe('docx');
  expect(result.risk).toBe('critical');
  expect(result.requiresHumanReview).toBe(true);
  expect(result.completionGate.automatedEditAllowed).toBe(false);
  expect(result.completionGate.defaultMacroOrSignatureAction).toBe('refuse');
  expect((result.unsupported as string[])).toContain('macros');
});

it('xlsx_inventory_hashes_formula_validation_chart_pivot_and_external_link_evidence', () => {
  const bytes = zipOf([
    CONTENT_TYPES,
    ['xl/workbook.xml', '<definedNames><definedName/></definedNames>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><f>A1+1</f><dataValidations/></worksheet>'],
    ['xl/charts/chart1.xml', '<chart/>'],
    ['xl/pivotTables/pivotTable1.xml', '<pivot/>'],
    ['xl/externalLinks/externalLink1.xml', '<externalLink/>'],
  ]);
  const result = inspectBytes(bytes) as Record<string, any>;
  expect(result.format).toBe('xlsx');
  expect((result.featureSetHash as string).length).toBe(64);
  const present = (result.features as Array<Record<string, any>>).filter(feature => feature.present);
  for (const feature of present) {
    expect(typeof feature.featureHash).toBe('string');
    expect((feature.featureHash as string).length).toBe(64);
  }
});

it('pdf_inventory_reports_forms_signatures_attachments_and_encryption', () => {
  const bytes = Buffer.from(
    '%PDF-1.7\n1 0 obj << /AcroForm 2 0 R /Type /Sig /EmbeddedFiles 3 0 R /Encrypt 4 0 R >>', 'utf8');
  const result = inspectBytes(bytes) as Record<string, any>;
  expect(result.format).toBe('pdf');
  expect(result.risk).toBe('critical');
  expect(result.requires_human_review).toBe(true);
  expect(result.inspectionCoverage).toBe('partial_lexical_or_encrypted_container_detection');
  expect(result.secretPrompt.supported).toBe(false);
  expect(result.secretPrompt.reasonCode).toBe('DECRYPTOR_INTEGRATION_UNAVAILABLE');
});

it('preflight_for_edit_separates_critical_from_high_features', () => {
  const bytes = zipOf([
    CONTENT_TYPES,
    ['xl/workbook.xml', '<workbook/>'],
    ['xl/worksheets/sheet1.xml', '<worksheet><f>A1+1</f></worksheet>'],
    ['xl/charts/chart1.xml', '<chart/>'],
    ['xl/vbaProject.bin', 'macro payload'],
    ['xl/externalLinks/externalLink1.xml', '<externalLink/>'],
  ]);
  const preflight = preflightForEdit(bytes);
  expect(preflight.format).toBe('xlsx');
  expect(preflight.risk).toBe('critical');
  expect(preflight.criticalFeatures.length > 0).toBe(true);
  expect(preflight.criticalFeatures).toContain('macros');
  expect(preflight.criticalFeatures).toContain('external_links');
  expect(preflight.highFeatures).toContain('charts');
  expect(preflight.highFeatures).toContain('formulas');
  expect(preflight.highFeatures).not.toContain('macros');
  expect(preflight.sourceSha256.length).toBe(64);
  expect(preflight.featureSetHash.length).toBe(64);
});

it('preflight_for_edit_plain_xlsx_has_no_gate_features', () => {
  const bytes = zipOf([
    CONTENT_TYPES,
    ['xl/workbook.xml', '<workbook/>'],
    ['xl/worksheets/sheet1.xml', '<worksheet/>'],
  ]);
  const preflight = preflightForEdit(bytes);
  expect(preflight.format).toBe('xlsx');
  expect(preflight.criticalFeatures.length).toBe(0);
  expect(preflight.highFeatures.length).toBe(0);
});

it('docx_preflight_blocks_revisions_sdt_images_and_ole', () => {
  const bytes = zipOf([
    CONTENT_TYPES,
    ['word/document.xml', '<w:document><w:ins w:id="1" w:author="a"><w:r><w:t>x</w:t></w:r></w:ins>'
      + '<w:sdt><w:sdtContent/></w:sdt></w:document>'],
    ['word/media/image1.png', 'png-bytes'],
    ['word/embeddings/oleObject1.xlsx', 'ole-payload'],
  ]);
  const preflight = preflightForEdit(bytes);
  expect(preflight.format).toBe('docx');
  expect(preflight.criticalFeatures.length > 0).toBe(true);
  for (const expected of ['tracked_revisions', 'content_controls', 'images', 'embedded_ole']) {
    expect(preflight.criticalFeatures, expected).toContain(expected);
  }
});

it('docx_preflight_table_borders_are_not_revisions', () => {
  const bytes = zipOf([
    CONTENT_TYPES,
    ['word/document.xml', '<w:document><w:tbl><w:tblBorders><w:insideH w:val="single"/>'
      + '<w:insideV w:val="single"/></w:tblBorders></w:tbl></w:document>'],
  ]);
  const preflight = preflightForEdit(bytes);
  expect(preflight.criticalFeatures.length).toBe(0);
  expect(preflight.criticalFeatures).not.toContain('tracked_revisions');
});

it('docx_preflight_plain_header_warns_but_complex_header_blocks', () => {
  const plain = zipOf([
    CONTENT_TYPES,
    ['word/document.xml', '<w:document/>'],
    ['word/header1.xml', '<w:hdr/>'],
    ['word/footer1.xml', '<w:ftr/>'],
  ]);
  const plainPreflight = preflightForEdit(plain);
  expect(plainPreflight.criticalFeatures.length).toBe(0);
  expect(plainPreflight.highFeatures).toContain('headers_footers');

  const complex = zipOf([
    CONTENT_TYPES,
    ['word/document.xml', '<w:document><w:sectPr><w:titlePg/></w:sectPr></w:document>'],
    ['word/header1.xml', '<w:hdr/>'],
    ['word/header2.xml', '<w:hdr/>'],
  ]);
  const complexPreflight = preflightForEdit(complex);
  expect(complexPreflight.criticalFeatures.length > 0).toBe(true);
  expect(complexPreflight.criticalFeatures).toContain('complex_headers_footers');
});

it('RF-W04-docx-onoff-false-headers: docx_preflight_explicitly_disabled_on_off_header_switches_are_not_complex_headers', () => {
  // The F7 docx writer (npm `docx`) emits `<w:evenAndOddHeaders w:val="false"/>` in
  // settings.xml; ST_OnOff false/0/off means the switch is off, so the docx_create →
  // docx_replace_text round trip must not be blocked.
  for (const value of ['false', '0', 'off']) {
    const disabled = zipOf([
      CONTENT_TYPES,
      ['word/document.xml', `<w:document><w:sectPr><w:titlePg w:val="${value}"/></w:sectPr></w:document>`],
      ['word/settings.xml', `<w:settings><w:evenAndOddHeaders w:val="${value}"/></w:settings>`],
    ]);
    expect(preflightForEdit(disabled).criticalFeatures).not.toContain('complex_headers_footers');
  }
  for (const element of ['<w:evenAndOddHeaders/>', '<w:evenAndOddHeaders w:val="true"/>',
    '<w:evenAndOddHeaders w:val="1"/>', '<w:evenAndOddHeaders w:val="on" />']) {
    const enabled = zipOf([
      CONTENT_TYPES,
      ['word/document.xml', '<w:document/>'],
      ['word/settings.xml', `<w:settings>${element}</w:settings>`],
    ]);
    expect(preflightForEdit(enabled).criticalFeatures).toContain('complex_headers_footers');
  }
});

it('docx_preflight_toc_and_crossref_fields_are_critical_but_plain_fields_not', () => {
  const toc = zipOf([
    CONTENT_TYPES,
    ['word/document.xml', '<w:document><w:p><w:instrText xml:space="preserve"> TOC \\o "1-3" \\h </w:instrText></w:p></w:document>'],
  ]);
  const tocPreflight = preflightForEdit(toc);
  expect(tocPreflight.criticalFeatures).toContain('toc_crossref_fields');

  const pageField = zipOf([
    CONTENT_TYPES,
    ['word/footer1.xml', '<w:ftr><w:p><w:instrText xml:space="preserve"> PAGE </w:instrText></w:p></w:ftr>'],
    ['word/document.xml', '<w:document/>'],
  ]);
  const pagePreflight = preflightForEdit(pageField);
  expect(pagePreflight.criticalFeatures).not.toContain('toc_crossref_fields');
  expect(pagePreflight.criticalFeatures.length).toBe(0);
});

it('docx_preflight_footnotes_and_comments_warn_without_blocking', () => {
  const bytes = zipOf([
    CONTENT_TYPES,
    ['word/document.xml', '<w:document/>'],
    ['word/footnotes.xml', '<w:footnotes><w:footnote w:type="separator" w:id="-1"/>'
      + '<w:footnote w:id="1"><w:p/></w:footnote></w:footnotes>'],
    ['word/comments.xml', '<w:comments><w:comment w:id="0" w:author="a"><w:p/></w:comment></w:comments>'],
  ]);
  const preflight = preflightForEdit(bytes);
  expect(preflight.criticalFeatures.length).toBe(0);
  expect(preflight.highFeatures).toContain('footnotes_endnotes');
  expect(preflight.highFeatures).toContain('comments');
});

it('pptx_preflight_blocks_media_and_ole', () => {
  const bytes = zipOf([
    CONTENT_TYPES,
    ['ppt/presentation.xml', '<p:presentation/>'],
    ['ppt/media/image1.png', 'png-bytes'],
    ['ppt/embeddings/oleObject1.bin', 'ole-payload'],
  ]);
  const preflight = preflightForEdit(bytes);
  expect(preflight.format).toBe('pptx');
  expect(preflight.criticalFeatures.length > 0).toBe(true);
  expect(preflight.criticalFeatures).toContain('media');
  expect(preflight.criticalFeatures).toContain('embedded_ole');
});

it('pptx_preflight_masters_notes_charts_warn_without_blocking', () => {
  const bytes = zipOf([
    CONTENT_TYPES,
    ['ppt/presentation.xml', '<p:presentation/>'],
    ['ppt/slideMasters/slideMaster1.xml', '<p:sldMaster/>'],
    ['ppt/slideLayouts/slideLayout1.xml', '<p:sldLayout/>'],
    ['ppt/notesSlides/notesSlide1.xml', '<p:notes/>'],
    ['ppt/charts/chart1.xml', '<c:chart/>'],
    ['ppt/diagrams/data1.xml', '<dgm/>'],
    ['ppt/slides/slide1.xml', '<p:sld><p:timing/></p:sld>'],
  ]);
  const preflight = preflightForEdit(bytes);
  expect(preflight.criticalFeatures.length).toBe(0);
  for (const expected of [
    'slide_masters', 'speaker_notes', 'charts', 'diagrams', 'animations_timing',
  ]) {
    expect(preflight.highFeatures, expected).toContain(expected);
  }
});

function preflightFixture(critical: string[], high: string[]): EditPreflight {
  return {
    format: 'docx',
    risk: critical.length === 0 ? 'high' : 'critical',
    sourceSha256: 'a'.repeat(64),
    featureSetHash: 'b'.repeat(64),
    criticalFeatures: critical,
    highFeatures: high,
  };
}

const DOCX_WORDING: EditGateWording = {
  writePath: 'docx-rs 文本重建',
  officeApps: 'Word/WPS',
  highFeaturesDropped: true,
};

it('shared_gate_error_carries_format_specific_wording', () => {
  const preflight = preflightFixture(['images'], []);
  let message = '';
  try { enforceEditPreflight(preflight, DOCX_WORDING); }
  catch (error) { message = (error as Error).message; }
  expect(message).toContain('OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES');
  expect(message).toContain('images');
  expect(message).toContain('docx-rs 文本重建');
  expect(message).toContain('Word/WPS');
  expect(message).toContain('副本');

  const xlsxWording: EditGateWording = {
    writePath: 'umya-spreadsheet round-trip 编辑',
    officeApps: 'Excel/WPS',
    highFeaturesDropped: false,
  };
  let xlsxMessage = '';
  try { enforceEditPreflight(preflight, xlsxWording); }
  catch (error) { xlsxMessage = (error as Error).message; }
  expect(xlsxMessage).toContain('umya-spreadsheet round-trip 编辑会静默丢失这些特征');
  expect(xlsxMessage).toContain('Excel/WPS');

  const clean = preflightFixture([], ['comments']);
  expect(() => enforceEditPreflight(clean, DOCX_WORDING)).not.toThrow();
});

it('shared_warning_switches_semantics_by_write_path', () => {
  const preflight = preflightFixture([], ['comments']);
  const rebuildWording: EditGateWording = {
    writePath: 'pptx spec 文本重建',
    officeApps: 'PowerPoint/WPS',
    highFeaturesDropped: true,
  };
  const warning = buildEditFidelityWarning(preflight, rebuildWording, [])!;
  expect(warning.preserved_at_risk_features).toEqual(['comments']);
  expect(warning.post_edit_comparison).toBe('not_performed');
  expect(warning.write_path_semantics).toBe('text_only_rebuild_drops_listed_features');
  expect(warning.message as string).toContain('PowerPoint/WPS');

  const roundtripWording: EditGateWording = {
    writePath: 'umya-spreadsheet round-trip 编辑',
    officeApps: 'Excel/WPS',
    highFeaturesDropped: false,
  };
  const roundtrip = buildEditFidelityWarning(
    preflight, roundtripWording, [['overwritten_formula_cells', []]])!;
  expect(roundtrip).not.toHaveProperty('write_path_semantics');
  expect(roundtrip.message).toBe(
    '源文件包含高保真风险特征，本次编辑未做编辑后结构对比，建议在 Excel/WPS 中打开产物核对');
  expect(roundtrip.overwritten_formula_cells).toEqual([]);

  const clean = preflightFixture([], []);
  expect(buildEditFidelityWarning(clean, roundtripWording, [])).toBeNull();
  expect(buildEditFidelityWarning(
    clean, roundtripWording, [['overwritten_formula_cells', ['Sheet1!B1']]])).not.toBeNull();
});
