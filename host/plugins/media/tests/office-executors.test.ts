import { expect, it } from 'vitest';
import {
  DOCX_EDIT_GATE_WORDING, PPTX_EDIT_GATE_WORDING, XLSX_EDIT_GATE_WORDING,
  canHandle, sensitivityLevel,
} from '../src/office-executors.ts';
import {
  buildEditFidelityWarning, enforceEditPreflight, hasCritical, preflightForEdit,
} from '../src/office-fidelity.ts';
import { collectOverwrittenFormulaCells } from '../src/xlsx-formulas.ts';
import { zipPackage } from './helpers/zip-fixture.ts';

function formulaXlsx(): Buffer {
  return zipPackage([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml',
      '<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>'],
    ['xl/worksheets/sheet1.xml',
      '<worksheet><sheetData>'
      + '<row r="1"><c r="A1"><v>1</v></c><c r="B1"><f>SUM(A1:A2)</f><v>3</v></c></row>'
      + '<row r="2"><c r="A2"><v>2</v></c></row>'
      + '</sheetData></worksheet>'],
  ]);
}

function plainXlsx(): Buffer {
  return zipPackage([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml',
      '<workbook><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'],
    ['xl/_rels/workbook.xml.rels',
      '<Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>'
      + '</Relationships>'],
    ['xl/worksheets/sheet1.xml',
      '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>hello</t></is></c>'
      + '</row></sheetData></worksheet>'],
  ]);
}

function gateError(bytes: Buffer, wording: typeof DOCX_EDIT_GATE_WORDING): string {
  const preflight = preflightForEdit(bytes);
  try { enforceEditPreflight(preflight, wording); }
  catch (error) { return (error as Error).message; }
  throw new Error('expected the edit gate to block');
}

it('test_can_handle (docx_executor)', () => {
  for (const name of [
    'docx_read_structured', 'docx_extract_tables', 'docx_get_metadata',
    'docx_create', 'docx_to_spec', 'docx_replace_text',
  ]) {
    expect(canHandle('docx', `builtin-${name}`), name).toBe(true);
  }
  expect(canHandle('docx', 'builtin-rag_search')).toBe(false);
  expect(canHandle('docx', 'builtin-attachment_read')).toBe(false);
});

it('test_can_handle (xlsx_executor)', () => {
  for (const name of [
    'xlsx_read_structured', 'xlsx_extract_tables', 'xlsx_get_metadata',
    'xlsx_create', 'xlsx_to_spec', 'xlsx_edit_cells', 'xlsx_replace_text',
  ]) {
    expect(canHandle('xlsx', `builtin-${name}`), name).toBe(true);
  }
  expect(canHandle('xlsx', 'builtin-docx_create')).toBe(false);
  expect(canHandle('xlsx', 'builtin-pptx_create')).toBe(false);
});

it('test_can_handle (pptx_executor)', () => {
  for (const name of [
    'pptx_read_structured', 'pptx_get_metadata', 'pptx_extract_tables',
    'pptx_create', 'pptx_to_spec', 'pptx_replace_text',
  ]) {
    expect(canHandle('pptx', `builtin-${name}`), name).toBe(true);
  }
  expect(canHandle('pptx', 'builtin-docx_create')).toBe(false);
  expect(canHandle('pptx', 'builtin-rag_search')).toBe(false);
});

it('test_sensitivity_level (docx_executor)', () => {
  for (const name of [
    'docx_read_structured', 'docx_to_spec', 'docx_extract_tables', 'docx_get_metadata',
  ]) {
    expect(sensitivityLevel('docx', `builtin-${name}`), name).toBe('low');
  }
  for (const name of ['docx_create', 'docx_replace_text']) {
    expect(sensitivityLevel('docx', `builtin-${name}`), name).toBe('medium');
  }
});

it('test_sensitivity_level (xlsx_executor)', () => {
  for (const name of [
    'xlsx_read_structured', 'xlsx_to_spec', 'xlsx_get_metadata', 'xlsx_extract_tables',
  ]) {
    expect(sensitivityLevel('xlsx', `builtin-${name}`), name).toBe('low');
  }
  for (const name of ['xlsx_create', 'xlsx_edit_cells', 'xlsx_replace_text']) {
    expect(sensitivityLevel('xlsx', `builtin-${name}`), name).toBe('medium');
  }
});

it('test_sensitivity_level (pptx_executor)', () => {
  for (const name of [
    'pptx_read_structured', 'pptx_to_spec', 'pptx_extract_tables', 'pptx_get_metadata',
  ]) {
    expect(sensitivityLevel('pptx', `builtin-${name}`), name).toBe('low');
  }
  for (const name of ['pptx_create', 'pptx_replace_text']) {
    expect(sensitivityLevel('pptx', `builtin-${name}`), name).toBe('medium');
  }
});

it('g06_docx_replace_blocks_tracked_revisions', () => {
  const bytes = zipPackage([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', '<w:document><w:ins w:id="7" w:author="a"><w:r><w:t>x</w:t></w:r></w:ins></w:document>'],
  ]);
  const message = gateError(bytes, DOCX_EDIT_GATE_WORDING);
  expect(message).toContain('OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES');
  expect(message).toContain('tracked_revisions');
  expect(message).toContain('Word/WPS');
  expect(message).toContain('docx-rs 文本重建');
});

it('g06_docx_replace_blocks_images_sdt_ole_and_complex_headers', () => {
  const cases: Array<[string, Uint8Array, string]> = [
    ['word/media/image1.png', Buffer.from('img'), 'images'],
    ['word/embeddings/oleObject1.bin', Buffer.from('ole'), 'embedded_ole'],
    ['word/document.xml',
      Buffer.from('<w:document><w:sdt><w:sdtContent/></w:sdt></w:document>'), 'content_controls'],
    ['word/document.xml',
      Buffer.from('<w:document><w:sectPr><w:titlePg/></w:sectPr></w:document>'),
      'complex_headers_footers'],
  ];
  for (const [partName, partBytes, expectedFeature] of cases) {
    const parts: Array<[string, Uint8Array | string]> = [['[Content_Types].xml', '<Types/>']];
    // document.xml 类用例直接以内容为准，其余补一个空 document.xml
    if (partName !== 'word/document.xml') {
      parts.push(['word/document.xml', '<w:document/>']);
    }
    parts.push([partName, partBytes]);
    const message = gateError(zipPackage(parts), DOCX_EDIT_GATE_WORDING);
    expect(message, expectedFeature).toContain(expectedFeature);
  }
});

it('g06_docx_replace_comments_document_passes_with_warning', () => {
  const bytes = zipPackage([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', '<w:document/>'],
    ['word/comments.xml',
      '<w:comments><w:comment w:id="0" w:author="a"><w:p/></w:comment></w:comments>'],
  ]);
  const preflight = preflightForEdit(bytes);
  // 批注是 high 而非 critical：放行
  expect(() => enforceEditPreflight(preflight, DOCX_EDIT_GATE_WORDING)).not.toThrow();
  // 但交付结果必须附 fidelity warning（文本重建会丢弃批注）
  const warning = buildEditFidelityWarning(preflight, DOCX_EDIT_GATE_WORDING, [])!;
  expect(warning).not.toBeNull();
  expect(warning.preserved_at_risk_features).toEqual(['comments']);
  expect(warning.write_path_semantics).toBe('text_only_rebuild_drops_listed_features');
  expect(warning.post_edit_comparison).toBe('not_performed');
  expect(warning.message as string).toContain('Word/WPS');
});

it('g06_pptx_replace_blocks_media_and_embedded_ole', () => {
  const cases: Array<[string, Uint8Array, string]> = [
    ['ppt/media/image1.png', Buffer.from('img'), 'media'],
    ['ppt/media/video1.mp4', Buffer.from('vid'), 'media'],
    ['ppt/embeddings/oleObject1.bin', Buffer.from('ole'), 'embedded_ole'],
  ];
  for (const [partName, partBytes, expectedFeature] of cases) {
    const bytes = zipPackage([
      ['[Content_Types].xml', '<Types/>'],
      ['ppt/presentation.xml', '<p:presentation/>'],
      [partName, partBytes],
    ]);
    const message = gateError(bytes, PPTX_EDIT_GATE_WORDING);
    expect(message).toContain('OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES');
    expect(message, expectedFeature).toContain(expectedFeature);
    expect(message).toContain('PowerPoint/WPS');
    expect(message).toContain('pptx spec 文本重建');
  }
});

it('g06_pptx_replace_masters_and_notes_pass_with_warning', () => {
  const bytes = zipPackage([
    ['[Content_Types].xml', '<Types/>'],
    ['ppt/presentation.xml', '<p:presentation/>'],
    ['ppt/slideMasters/slideMaster1.xml', '<p:sldMaster/>'],
    ['ppt/notesSlides/notesSlide1.xml', '<p:notes/>'],
  ]);
  const preflight = preflightForEdit(bytes);
  // 母版/备注是 high 而非 critical（词法无法区分默认与自定义母版，保守放行）
  expect(() => enforceEditPreflight(preflight, PPTX_EDIT_GATE_WORDING)).not.toThrow();
  // 但交付结果必须附 fidelity warning（文本重建会重新生成默认母版、丢弃备注）
  const warning = buildEditFidelityWarning(preflight, PPTX_EDIT_GATE_WORDING, [])!;
  expect(warning).not.toBeNull();
  const atRisk = warning.preserved_at_risk_features as string[];
  expect(atRisk).toContain('slide_masters');
  expect(atRisk).toContain('speaker_notes');
  expect(warning.write_path_semantics).toBe('text_only_rebuild_drops_listed_features');
  expect(warning.message as string).toContain('PowerPoint/WPS');
});

it('g06_edit_cells_preflight_blocks_macro_workbook', () => {
  const bytes = zipPackage([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml', '<workbook/>'],
    ['xl/vbaProject.bin', 'macro payload'],
  ]);
  const message = gateError(bytes, XLSX_EDIT_GATE_WORDING);
  expect(message).toContain('OFFICE_EDIT_BLOCKED_CRITICAL_FEATURES');
  expect(message).toContain('macros');
  expect(message).toContain('副本');
});

it('g06_edit_cells_formula_workbook_allows_edit_with_warning', () => {
  const bytes = formulaXlsx();
  const preflight = preflightForEdit(bytes);
  // 公式是 high 而非 critical：门禁放行
  expect(hasCritical(preflight)).toBe(false);
  expect(preflight.highFeatures).toContain('formulas');
  expect(() => enforceEditPreflight(preflight, XLSX_EDIT_GATE_WORDING)).not.toThrow();
  // 编辑非公式单元格：无公式被覆盖
  const overwritten = collectOverwrittenFormulaCells(bytes, [['Sheet1', 'C1', '42']]);
  expect(overwritten).toEqual([]);
  // 但交付结果必须附 fidelity warning（源文件含 formulas 高风险特征）
  const warning = buildEditFidelityWarning(preflight, XLSX_EDIT_GATE_WORDING,
    [['overwritten_formula_cells', overwritten]]);
  expect(warning).not.toBeNull();
  expect(warning!.preserved_at_risk_features).toEqual(['formulas']);
  expect(warning!.post_edit_comparison).toBe('not_performed');
});

it('g06_edit_cells_overwritten_formula_cells_are_listed', () => {
  const bytes = formulaXlsx();
  const edits: Array<[string, string, string]> = [
    ['Sheet1', 'B1', '99'], // 公式单元格
    ['Sheet1', 'A1', '5'], // 普通值
    ['Sheet1', 'Z9', 'x'], // 空单元格
  ];
  const overwritten = collectOverwrittenFormulaCells(bytes, edits);
  expect(overwritten).toEqual(['Sheet1!B1']);
  const preflight = preflightForEdit(bytes);
  const warning = buildEditFidelityWarning(preflight, XLSX_EDIT_GATE_WORDING,
    [['overwritten_formula_cells', overwritten]]);
  expect(warning!.overwritten_formula_cells).toEqual(['Sheet1!B1']);
});

it('g06_edit_cells_plain_workbook_has_no_warning', () => {
  const bytes = plainXlsx();
  const preflight = preflightForEdit(bytes);
  expect(hasCritical(preflight)).toBe(false);
  expect(preflight.highFeatures).toEqual([]);
  expect(() => enforceEditPreflight(preflight, XLSX_EDIT_GATE_WORDING)).not.toThrow();
  const overwritten = collectOverwrittenFormulaCells(bytes, [['Sheet1', 'A1', 'world']]);
  expect(overwritten).toEqual([]);
  expect(buildEditFidelityWarning(preflight, XLSX_EDIT_GATE_WORDING,
    [['overwritten_formula_cells', overwritten]])).toBeNull();
});
