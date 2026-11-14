import { afterEach, expect, it } from 'vitest';
import { escapeXmlAttr, escapeXmlContent } from '../api.ts';
import {
  ResolvedContent, buildExamQuestionsSsotBlock,
  getTextbookTextBlocks, inferMediaTypeFromName, resolveExamMultimodal, resolveImageInjectModes,
  resolvePdfInjectModes, resolveQuestionImageBlob, type ResourceInjectModes, type VfsResourceRef,
} from '../src/vfs-resolver.ts';
import { inMemoryVfsDb, type VfsTestDb } from './vfs-support.ts';

const openDbs: VfsTestDb[] = [];
afterEach(() => { for (const db of openDbs.splice(0)) db.close(); });

function mediaRef(injectModes: ResourceInjectModes | null): VfsResourceRef {
  return {
    sourceId: 'source-1',
    resourceHash: 'hash-1',
    type: 'textbook',
    name: 'book',
    resourceId: 'resource-1',
    snippet: null,
    injectModes,
  };
}

function testDb(): VfsTestDb {
  const value = inMemoryVfsDb();
  openDbs.push(value);
  return value;
}

it('test_escape_xml_attr', () => {
  expect(escapeXmlAttr('hello')).toBe('hello');
  expect(escapeXmlAttr('a < b')).toBe('a &lt; b');
  expect(escapeXmlAttr('a & b')).toBe('a &amp; b');
  expect(escapeXmlAttr('"quoted"')).toBe('&quot;quoted&quot;');
});

it('test_escape_xml_content', () => {
  expect(escapeXmlContent('hello')).toBe('hello');
  expect(escapeXmlContent('<tag>')).toBe('&lt;tag&gt;');
  expect(escapeXmlContent('a & b')).toBe('a &amp; b');
});

it('test_infer_media_type', () => {
  expect(inferMediaTypeFromName('test.png')).toBe('image/png');
  expect(inferMediaTypeFromName('test.JPG')).toBe('image/jpeg');
  expect(inferMediaTypeFromName('test.jpeg')).toBe('image/jpeg');
  expect(inferMediaTypeFromName('test.gif')).toBe('image/gif');
  expect(inferMediaTypeFromName('test.webp')).toBe('image/webp');
  expect(inferMediaTypeFromName('test.unknown')).toBe('image/png');
});

it('test_resolved_content', () => {
  const content = new ResolvedContent();
  expect(content.isEmpty()).toBe(true);

  content.addText('hello');
  expect(content.isEmpty()).toBe(false);
  expect(content.textContents.length).toBe(1);

  content.addImage('base64data');
  expect(content.imageBase64List.length).toBe(1);

  const formatted = content.toFormattedText('user input');
  expect(formatted).toContain('hello');
  expect(formatted).toContain('user input');
});

it('test_default_image_mode_keeps_source_without_implicit_ocr', () => {
  const [includeImage, includeOcr, downgraded] = resolveImageInjectModes(null, true);
  expect(includeImage).toBe(true);
  expect(includeOcr).toBe(false);
  expect(downgraded).toBe(false);
});

it('test_non_multimodal_image_request_downgrades_to_ocr', () => {
  const [includeImage, includeOcr, downgraded] = resolveImageInjectModes(['image'], false);
  expect(includeImage).toBe(false);
  expect(includeOcr).toBe(true);
  expect(downgraded).toBe(true);
});

it('test_default_pdf_mode_is_text_only', () => {
  const [text, ocr, image, downgraded] = resolvePdfInjectModes(null, true);
  expect(text).toBe(true);
  expect(ocr || image || downgraded).toBe(false);

  const [text2, ocr2, image2, downgraded2] = resolvePdfInjectModes(null, false);
  expect(text2).toBe(true);
  expect(ocr2 || image2 || downgraded2).toBe(false);
});

it('test_non_multimodal_pdf_image_request_downgrades_to_ocr', () => {
  const [text, ocr, image, downgraded] = resolvePdfInjectModes(['image'], false);
  expect(text).toBe(false);
  expect(ocr).toBe(true);
  expect(image).toBe(false);
  expect(downgraded).toBe(true);
});

it('textbook_default_keeps_native_text_without_ocr_duplicate', () => {
  const vfsRef = mediaRef(null);
  const ocr = '["ocr-derived"]';
  const native = 'native extracted text';

  const defaultText = getTextbookTextBlocks(ocr, native, vfsRef, false, true)
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n');
  expect(defaultText).toContain('native extracted text');
  expect(defaultText).not.toContain('ocr-derived');
  expect(defaultText).not.toContain('textbook_ocr');

  const explicitText = getTextbookTextBlocks(ocr, native, vfsRef, true, true)
    .filter(block => block.type === 'text')
    .map(block => block.type === 'text' ? block.text : '')
    .join('\n');
  expect(explicitText).toContain('ocr-derived');
  expect(explicitText).toContain('native extracted text');
});

it('exam_default_omits_card_ocr_but_explicit_ocr_includes_it', () => {
  const { executor } = testDb();
  const vfsRef = mediaRef(null);
  const preview = '{"pages":[{"cards":[{"questionLabel":"1","ocrText":"derived answer"}]}]}';

  const defaultBlocks = resolveExamMultimodal(executor, '.', vfsRef, preview, false, false);
  expect(defaultBlocks.some(block => block.type === 'text' && block.text.includes('derived answer'))).toBe(false);

  const explicitBlocks = resolveExamMultimodal(executor, '.', vfsRef, preview, false, true);
  expect(explicitBlocks.some(block => block.type === 'text' && block.text.includes('derived answer'))).toBe(true);
  // 空库没有 questions 表：SSOT 查询返回 None，回退到 preview OCR。
  expect(buildExamQuestionsSsotBlock(executor, vfsRef)).toBeNull();
});

it('test_resolve_question_image_blob_from_hash_field', () => {
  const { executor } = testDb();
  const value = { hash: 'blob_hash_1', mime: 'image/jpeg' };
  const resolved = resolveQuestionImageBlob(executor, value);
  expect(resolved).toEqual(['blob_hash_1', 'image/jpeg']);
});

it('test_resolve_question_image_blob_from_file_id', () => {
  const { executor } = testDb();
  executor.exec(`
    CREATE TABLE files (
      id TEXT PRIMARY KEY,
      resource_id TEXT,
      blob_hash TEXT,
      compressed_blob_hash TEXT
    )
  `);
  executor.run(
    'INSERT INTO files (id, resource_id, blob_hash, compressed_blob_hash) VALUES (?1, ?2, ?3, ?4)',
    ['file_manual_1', 'res_manual_1', 'blob_ori', 'blob_cmp'],
  );

  const value = { id: 'file_manual_1' };
  const resolved = resolveQuestionImageBlob(executor, value);
  expect(resolved).toEqual(['blob_cmp', 'image/png']);
});
