import { expect, it } from 'vitest';
import { UnitBuilderRegistry, parsePreviewPages, type UnitBuildInput } from '../src/unit-builders.ts';

const registry = new UnitBuilderRegistry();
const build = (resourceType: string, input: Partial<UnitBuildInput> = {}) =>
  registry.build({ resourceId: 'res_123', resourceType, ...input })!.units;
const pdf = (
  extractedText: string | null,
  ocrText: string | null,
  ocrPagesJson: string | null,
  pageCount: number,
): Partial<UnitBuildInput> => ({
  resourceId: 'res_pdf',
  blobHash: 'pdfbytes',
  extractedText,
  ocrText,
  ocrPagesJson,
  pageCount,
  previewJson: JSON.stringify({
    pages: Array.from({ length: pageCount }, (_, index) => ({
      pageIndex: index,
      blobHash: `page${index}`,
      mimeType: 'image/jpeg',
    })),
  }),
});

it('test_registry_creation', () => {
  expect(registry.get('note')).toBeDefined();
  expect(registry.get('textbook')).toBeDefined();
  expect(registry.get('image')).toBeDefined();
  expect(registry.get('unknown')).toBeUndefined();
});

it('pdf_file_is_indexed_one_unit_per_page_with_page_images', () => {
  const whole = '第一章 柯西\f第二章 泰勒\f第三章 暗号';
  for (const type of ['file', 'textbook', 'attachment']) {
    const units = build(type, pdf(whole, whole, null, 3));
    expect(units).toHaveLength(3);
    expect(units[2]!.unitIndex).toBe(2);
    expect(units[2]!.textContent).toBe('第三章 暗号');
    expect(units[1]!.imageBlobHash).toBe('page1');
    expect(units[0]!.textSource).toBe('native');
  }
});

it('scanned_pages_fall_back_to_page_ocr', () => {
  const units = build('file', pdf('\f', null, '["OCR 第一页", "OCR 第二页"]', 2));
  expect(units).toHaveLength(2);
  expect(units[1]).toMatchObject({ textContent: 'OCR 第二页', textSource: 'ocr' });
});

it('unsplittable_legacy_text_keeps_whole_document_unit', () => {
  const units = build('file', pdf('整本书的文字', '整本书的文字', null, 3));
  expect(units).toHaveLength(1);
  expect(units[0]!.textContent).toBe('整本书的文字');
});

it('test_note_builder', () => {
  const units = build('note', { data: 'Hello world' });
  expect(units).toHaveLength(1);
  expect(units[0]).toMatchObject({ textContent: 'Hello world', textSource: 'native' });
});

it('test_mindmap_builder_extracts_root_and_notes', () => {
  const units = build('mindmap', {
    data: '{"version":"1.0","root":{"id":"root","text":"主题","note":"根备注","children":[{"id":"n1","text":"子节点","note":"第一行\\n第二行","children":[]}]}}',
  });
  expect(units).toHaveLength(1);
  for (const text of ['主题', '子节点', '根备注', '第一行', '第二行']) {
    expect(units[0]!.textContent).toContain(text);
  }
  expect(units[0]!.textSource).toBe('native');
});

it('test_textbook_builder', () => {
  const units = build('textbook', { ocrPagesJson: '["Page 1 text", null, "Page 3 text"]', pageCount: 3 });
  expect(units).toHaveLength(3);
  expect(units.map((unit) => unit.textContent)).toEqual(['Page 1 text', null, 'Page 3 text']);
});

it('file_builder_never_writes_file_blob_into_image_field', () => {
  const units = build('file', { blobHash: '8445c67bpdf-file-blob', extractedText: 'native text' });
  expect(units).toHaveLength(1);
  expect(units[0]!.imageBlobHash).toBeNull();
});

it('single_page_attachment_never_writes_file_blob_into_image_field', () => {
  const units = build('attachment', {
    blobHash: '8445c67bpdf-file-blob',
    pageCount: 1,
    extractedText: 'native text',
  });
  expect(units).toHaveLength(1);
  expect(units[0]!.imageBlobHash).toBeNull();
});

it('parse_preview_pages_reads_camel_case_hashes_and_mime', () => {
  const preview = JSON.stringify({
    pages: [
      { pageIndex: 0, blobHash: '5e26aaaa', compressedBlobHash: 'd47abbbb', mimeType: 'image/jpeg' },
      { pageIndex: 1, blobHash: 'aa11', mimeType: 'image/png' },
    ],
  });
  expect(parsePreviewPages(preview, 2)).toEqual([
    ['d47abbbb', 'image/jpeg'],
    ['aa11', 'image/png'],
  ]);
});

it('attachment_builder_uses_preview_page_hashes_not_file_blob', () => {
  const units = build('attachment', {
    blobHash: '8445c67bpdf-file-blob',
    pageCount: 2,
    previewJson: '{"pages":[{"pageIndex":0,"blobHash":"5e26page0","mimeType":"image/jpeg"},{"pageIndex":1,"blobHash":"5e26page1","mimeType":"image/jpeg"}]}',
  });
  expect(units).toHaveLength(2);
  expect(units[0]).toMatchObject({ imageBlobHash: '5e26page0', imageMimeType: 'image/jpeg' });
  expect(units[1]!.imageBlobHash).toBe('5e26page1');
});
