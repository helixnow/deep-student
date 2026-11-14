import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeZip } from '../../util/node.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { OfficeParsingError } from '../office/api.ts';

/**
 * document_parser.rs structured DOCX/PPTX readers (`extract_docx_structured` / `_tables` /
 * `_metadata` / `_as_spec`, `extract_pptx_metadata`) through `ctx.nativeOffice`, running the
 * copied Rust over docx-rs 0.4.19 / pptx-to-md 0.2.0 in the F7 WASI engine. document_parser.rs
 * has no tests for these readers; these are contract tests on the production entry.
 */
type Host = Awaited<ReturnType<typeof createTestHost>>;
let host: Host;
beforeAll(async () => { host = await createTestHost({ plugins: [native] }); });
afterAll(async () => { await host.dispose(); });

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const DOC_REL = '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>';
const CORE_REL = '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>';
const rels = (body: string) => `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`;
const CORE = '<?xml version="1.0" encoding="UTF-8"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
  + '<dc:title>讲义</dc:title><dc:subject>数学</dc:subject><dc:creator>张三</dc:creator><cp:lastModifiedBy>李四</cp:lastModifiedBy>'
  + '<dcterms:created xsi:type="dcterms:W3CDTF">2026-01-02T03:04:05Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-02-03T04:05:06Z</dcterms:modified></cp:coreProperties>';

function docx(body: string, withCore = false): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': rels(DOC_REL + (withCore ? CORE_REL : '')),
    'word/_rels/document.xml.rels': rels(''),
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
  };
  if (withCore) files['docProps/core.xml'] = CORE;
  return writeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
}

const cell = (text: string) => `<w:tc><w:p><w:r><w:t xml:space="preserve">${text}</w:t></w:r></w:p></w:tc>`;
const BODY = [
  '<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Intro</w:t></w:r></w:p>',
  '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bold</w:t></w:r><w:r><w:t xml:space="preserve"> plain</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>it</w:t></w:r></w:p>',
  '<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="3"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>',
  '<w:p><w:hyperlink r:id="rId9"><w:r><w:t>link</w:t></w:r></w:hyperlink><w:hyperlink w:anchor="sec"><w:r><w:t>jump</w:t></w:r></w:hyperlink></w:p>',
  '<w:p><w:del w:id="1"><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>',
  '<w:p><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:r><w:t>Outline</w:t></w:r></w:p>',
  '<w:p><w:r><w:t xml:space="preserve">  </w:t></w:r></w:p>',
  `<w:tbl><w:tr>${cell(' a ')}${cell('b')}</w:tr><w:tr>${cell('c')}${cell('')}</w:tr></w:tbl>`,
].join('');

describe('nativeOffice structured DOCX readers (document_parser.rs:1601-2041, docx-rs 0.4.19 via WASI)', () => {
  it('extract_docx_structured: headings, run formatting, lists, hyperlink rid/anchor, deletions, tables', async () => {
    // heading (Heading2) / bold+plain+italic runs / numbered list ilvl=1 (no blank line) /
    // hyperlink rid (not the target URL) and #anchor / ~~deleted~~ / outlineLvl 0 -> h1 /
    // whitespace-only paragraph dropped / Markdown table, then the whole output trimmed.
    expect(await host.ctx.nativeOffice.extractDocxStructured(docx(BODY))).toBe(
      '## Intro\n\n**Bold** plain*it*\n\n  1. item\n[link](rId9)[jump](#sec)\n\n~~gone~~\n\n# Outline\n\n'
      + '| a | b |\n| --- | --- |\n| c |  |');
  });

  it('extract_docx_tables: top-level tables with trimmed cell text', async () => {
    expect(await host.ctx.nativeOffice.extractDocxTables(docx(BODY))).toEqual([[['a', 'b'], ['c', '']]]);
  });

  it('extract_docx_as_spec: heading/paragraph/table blocks with Run-level bold/italic flags', async () => {
    // docx-rs 0.4.19 `read_docx` never parses docProps/core.xml (reader/mod.rs), so the
    // title is "" even when the part exists.
    expect(await host.ctx.nativeOffice.extractDocxAsSpec(docx(BODY, true))).toEqual({
      title: '',
      blocks: [
        { type: 'heading', level: 2, text: 'Intro' },
        { type: 'paragraph', text: 'Bold plainit', bold: true, italic: true },
        { type: 'paragraph', text: 'item', bold: false, italic: false },
        { type: 'paragraph', text: 'linkjump', bold: false, italic: false },
        { type: 'paragraph', text: 'gone', bold: false, italic: false },
        { type: 'heading', level: 1, text: 'Outline' },
        { type: 'table', rows: [['a', 'b'], ['c', '']] },
      ],
      block_count: 7,
    });
  });

  it('extract_docx_metadata: docx-rs leaves core properties unread, so every field is ""', async () => {
    const empty = { title: '', subject: '', creator: '', description: '', lastModifiedBy: '', created: '', modified: '' };
    // Same reader limitation: core.xml present or not, every field falls back to "".
    expect(await host.ctx.nativeOffice.extractDocxMetadata(docx(BODY, true))).toEqual(empty);
    expect(await host.ctx.nativeOffice.extractDocxMetadata(docx(BODY))).toEqual(empty);
  });

  it('reads documents written by the production DOCX generator', async () => {
    const bytes = await host.ctx.nativeOfficeWriter.generateDocx({ title: '标题', blocks: [
      { type: 'paragraph', text: '第一段' }, { type: 'table', rows: [['h1', 'h2'], ['c1', 'c2']] },
    ] });
    expect(await host.ctx.nativeOffice.extractDocxTables(bytes)).toEqual([[['h1', 'h2'], ['c1', 'c2']]]);
  });

  it('reports DocxParsingError like extract_docx_text', async () => {
    const error = await host.ctx.nativeOffice.extractDocxAsSpec(Buffer.from('not a zip')).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OfficeParsingError);
    expect((error as OfficeParsingError).message).toBe('DOCX解析错误: Failed to read from zip.');
  });
});

const PPTX_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const EMPTY_SLIDE = `<?xml version="1.0" encoding="UTF-8"?><p:sld ${PPTX_NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/></p:spTree></p:cSld></p:sld>`;

describe('nativeOffice.extractPptxMetadata (document_parser.rs:3046, pptx-to-md 0.2.0 via WASI)', () => {
  it('counts slides and sums md.len() of the untrimmed convert_to_md output', async () => {
    // convert_to_md of a slide without elements is exactly "<!-- Slide N -->\n\n" (slide.rs:58).
    const deck = writeZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES },
      { name: 'ppt/slides/slide1.xml', data: EMPTY_SLIDE }, { name: 'ppt/slides/slide12.xml', data: EMPTY_SLIDE }]);
    expect(await host.ctx.nativeOffice.extractPptxMetadata(deck)).toEqual({
      slide_count: 2, total_text_length: '<!-- Slide 1 -->\n\n'.length + '<!-- Slide 12 -->\n\n'.length, format: 'pptx',
    });
  });

  it('reads decks written by the production PPTX generator (UTF-8 byte lengths, untrimmed)', async () => {
    const deck = await host.ctx.nativeOfficeWriter.generatePptx({ title: 'T', slides: [
      { type: 'title', title: '标题', subtitle: '副标题' },
      { type: 'content', title: '要点', bullets: ['甲', '乙'] },
    ] });
    const metadata = await host.ctx.nativeOffice.extractPptxMetadata(deck);
    const trimmed = (await host.ctx.nativeOffice.extractPptxPages(deck)).reduce((sum, page) => sum + Buffer.byteLength(page, 'utf8'), 0);
    expect(metadata.slide_count).toBe(2);
    expect(metadata.format).toBe('pptx');
    // Every page ends in at least one newline that extract_pptx_pages trims away.
    expect(metadata.total_text_length).toBeGreaterThan(trimmed);
  });

  it('fails the whole deck where pptx-to-md does', async () => {
    const error = await host.ctx.nativeOffice.extractPptxMetadata(Buffer.from('nope')).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(OfficeParsingError);
    expect((error as OfficeParsingError).message).toMatch(/^PPTX解析错误: 无法打开PPTX: /u);
  });
});
