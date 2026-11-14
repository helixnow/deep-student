import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeZip } from '../../util/node.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import native from '../index.ts';
import { OfficeParsingError } from '../office/api.ts';

type Host = Awaited<ReturnType<typeof createTestHost>>;
let host: Host;
beforeAll(async () => { host = await createTestHost({ plugins: [native] }); });
afterAll(async () => { await host.dispose(); });

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const NS = `${W} xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" xmlns:v="urn:schemas-microsoft-com:vml" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>';
const PACKAGE_RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
const EMPTY_RELS = '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

function docx(body: string, extra: Record<string, string> = {}, rels = EMPTY_RELS): Uint8Array {
  const files: Record<string, string> = {
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': PACKAGE_RELS,
    'word/_rels/document.xml.rels': rels,
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${body}</w:body></w:document>`,
    ...extra,
  };
  return writeZip(Object.entries(files).map(([name, data]) => ({ name, data })));
}
const extract = (name: string, bytes: Uint8Array): Promise<string> => host.ctx.nativeOffice.extractText(name, bytes);
async function failure(name: string, bytes: Uint8Array): Promise<OfficeParsingError> {
  const error = await extract(name, bytes).then(() => null, (e: unknown) => e);
  expect(error).toBeInstanceOf(OfficeParsingError);
  return error as OfficeParsingError;
}

describe('nativeOffice docx (document_parser.rs extract_docx_text, docx-rs 0.4.19 via WASI)', () => {
  it('paragraph runs keep Text / DeleteText / Tab / Break, hyperlink / ins / del runs, and skip blank lines', async () => {
    const text = await extract('a.DOCX', docx([
      '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">Hello </w:t></w:r><w:r><w:rPr><w:sz w:val="24"/></w:rPr><w:t>World</w:t><w:tab/><w:t>x</w:t><w:br/><w:t>y</w:t></w:r></w:p>',
      '<w:p><w:r><w:t xml:space="preserve">   </w:t></w:r></w:p>',
      '<w:p><w:hyperlink r:id="rId9"><w:r><w:t>link</w:t></w:r><w:ins w:id="1"><w:r><w:t>LOST</w:t></w:r></w:ins></w:hyperlink><w:ins w:id="2" w:author="a"><w:r><w:t>+ins</w:t></w:r></w:ins><w:del w:id="3"><w:r><w:delText>-del</w:delText></w:r></w:del></w:p>',
      '<w:p><w:bookmarkStart w:id="0" w:name="b"/><w:r><w:t>A&amp;lt;B &amp;amp; &amp;nbsp;C</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>',
    ].join('')));
    expect(text).toBe('Hello World\tx\ny\nlink+ins-del\nA<B &  C');
  });

  it('tables become Markdown with a header separator; cell paragraphs are trimmed and space-joined', async () => {
    const cell = (...ps: string[]) => `<w:tc><w:tcPr><w:tcW w:w="100" w:type="dxa"/></w:tcPr>${ps.map(p => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join('')}</w:tc>`;
    const text = await extract('t.docx', docx(
      `<w:p><w:r><w:t>before</w:t></w:r></w:p><w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>`
      + `<w:tr>${cell(' 名称 ', 'x')}${cell('值')}</w:tr><w:tr>${cell('a')}</w:tr>`
      + `<w:tr><w:tc><w:tbl><w:tr>${cell('nested')}</w:tr></w:tbl><w:p><w:r><w:t>outer</w:t></w:r></w:p></w:tc>${cell('')}</w:tr></w:tbl><w:p><w:r><w:t>after</w:t></w:r></w:p>`,
    ));
    expect(text).toBe('before\n| 名称 x | 值 |\n| --- | --- |\n| a |  |\n| outer |  |\n\nafter');
  });

  it('keeps the docx-rs streaming quirks: inline sdt/smartTag runs kept, body sdt, math, fallback and textbox text dropped', async () => {
    const text = await extract('q.docx', docx([
      '<w:sdt><w:sdtContent><w:p><w:r><w:t>SDT-BODY</w:t></w:r></w:p></w:sdtContent></w:sdt>',
      '<w:p><w:sdt><w:sdtContent><w:r><w:t>inline-sdt</w:t></w:r></w:sdtContent></w:sdt><w:smartTag><w:r><w:t>+tag</w:t></w:r></w:smartTag></w:p>',
      '<w:p><w:r><w:t>E=</w:t></w:r><m:oMath><m:r><m:t>mc2</m:t></m:r></m:oMath><w:r><w:t>!</w:t></w:r></w:p>',
      '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing><wp:anchor><wps:txbx><w:txbxContent><w:p><w:r><w:t>TEXTBOX</w:t></w:r></w:p></w:txbxContent></wps:txbx></wp:anchor></w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><w:t>FALLBACK</w:t></v:shape></w:pict></mc:Fallback></mc:AlternateContent><w:t>shape-run</w:t></w:r></w:p>',
      '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:t>7</w:t></w:r></w:p>',
      '<w:p><w:r><w:instrText/><w:t>eaten-by-instrText</w:t><w:t>kept</w:t></w:r></w:p>',
      '<w:p><w:r><w:t><![CDATA[cdata]]>plain</w:t></w:r></w:p>',
    ].join('')));
    expect(text).toBe('inline-sdt+tag\nE=!\nshape-run\n7\nkept\nplain');
  });

  it('round-trips text written by the production DOCX generator', async () => {
    const bytes = await host.ctx.nativeOfficeWriter.generateDocx({ title: '标题', blocks: [
      { type: 'paragraph', text: '第一段' }, { type: 'list', items: ['甲', '乙'] },
      { type: 'table', rows: [['h1', 'h2'], ['c1', 'c2']] },
    ] });
    expect(await extract('gen.docx', bytes)).toBe('标题\n第一段\n• 甲\n• 乙\n| h1 | h2 |\n| --- | --- |\n| c1 | c2 |');
  });

  it('reports ReaderError Display text inside DocxParsingError', async () => {
    expect((await failure('x.docx', Buffer.from('not a zip'))).message).toBe('DOCX解析错误: Failed to read from zip.');
    const noRels = writeZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES }, { name: '_rels/.rels', data: PACKAGE_RELS },
      { name: 'word/document.xml', data: `<w:document ${W}><w:body/></w:document>` }]);
    expect((await failure('x.docx', noRels)).message).toBe('DOCX解析错误: Failed to read from zip.');
    expect((await failure('x.docx', docx('<w:p><w:r><w:t>unclosed</w:r></w:p>'))).message).toBe('DOCX解析错误: Failed to read xml.');
    expect((await failure('x.docx', docx('<w:p><w:r><x:t>unbound</x:t></w:r></w:p>'))).message).toBe('DOCX解析错误: Failed to read xml.');
    expect((await failure('x.docx', docx('<w:p><w:bookmarkStart w:id="-1" w:name="n"/></w:p>'))).message).toBe('DOCX解析错误: Failed to parse int.');
    expect((await failure('x.docx', docx('<w:p><w:r><w:rPr><w:sz w:val="big"/></w:rPr><w:t>a</w:t></w:r></w:p>'))).detail).toBe('Failed to parse float.');
    const stylesRel = EMPTY_RELS.replace('</Relationships>', '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>');
    const missingStyles = await failure('x.docx', docx('<w:p><w:r><w:t>a</w:t></w:r></w:p>', {}, stylesRel));
    expect(missingStyles.kind).toBe('DocxParsingError');
    expect(missingStyles.detail).toBe('Failed to read from zip.');
    expect(await extract('x.docx', docx('<w:p><w:r><w:t>a</w:t></w:r></w:p>', { 'word/styles.xml': `<w:styles ${W}/>` }, stylesRel))).toBe('a');
    // Swallowed by Hyperlink::read (`if let Ok`) instead of failing the document.
    expect(await extract('x.docx', docx('<w:p><w:hyperlink><w:bookmarkStart w:id="x" w:name="n"/><w:r><w:t>ok</w:t></w:r></w:hyperlink></w:p>'))).toBe('ok');
  });
});

describe('nativeOffice rtf (document_parser.rs extract_rtf_from_bytes, rtf-parser 0.3.0 via WASI)', () => {
  const rtf = (source: string): Promise<string> => extract('doc.rtf', Buffer.from(source));
  // esbuild cooks `\uXXXX` inside String.raw templates, so these RTF sources spell the backslash as §.
  const bs = (source: string): string => source.replaceAll('§', '\\');
  it('document.rs get_text_from_document', async () => {
    expect(await rtf(String.raw`{ \rtf1\ansi{\fonttbl\f0\fswiss Helvetica;}\f0\pard Voici du texte en {\b gras}.\par }`)).toBe('Voici du texte en gras.');
  });
  it('parser.rs parse_header_and_body (body texts concatenated, then trimmed)', async () => {
    const source = String.raw`{\rtf1\ansi\ansicpg1252\cocoartf2639
\cocoatextscaling0\cocoaplatform0{\fonttbl\f0\froman\fcharset0 Times-Bold;\f1\froman\fcharset0 Times-Roman;\f2\froman\fcharset0 Times-Italic;
\f3\fswiss\fcharset0 Helvetica;}
{\colortbl;\red255\green255\blue255;\red0\green0\blue10;\red0\green0\blue1;\red191\green191\blue191;
}
\f0\b\fs21 \cf2 Lorem ipsum
\fs56 \
\pard\pardeftab709\sl288\slmult1\sa225\qj\partightenfactor0

\f1\b0\fs21 \cf0 \
\pard\pardeftab709\fi-432\ri-1\sb240\sa120\partightenfactor0
\ls1\ilvl0
\f0\b\fs36\cf2\plain Lorem ipsum dolor sit amet, consectetur adipiscing elit. Nunc ac faucibus odio. \
\pard\pardeftab709\sl288\slmult1\sa225\qj\partightenfactor0
}`;
    expect(await rtf(source)).toBe('Lorem ipsum\n\nLorem ipsum dolor sit amet, consectetur adipiscing elit. Nunc ac faucibus odio.');
  });
  it('parser.rs escaped char / unicode / compound unicode / fallback', async () => {
    expect(await rtf(String.raw`{\rtf1\ansi\deff0 {\fonttbl {\f0 Times;}}je suis une b\'eate}`)).toBe('je suis une bête');
    expect(await rtf(bs(`{§rtf1§ansi§ansicpg936§cocoartf2761
            §cocoatextscaling0§cocoaplatform0{§fonttbl§f0§fswiss§fcharset0 Helvetica;}
            §f0§fs24 §cf0 §uc0§u21834  §u21834 }`))).toBe('啊 啊');
    expect(await rtf(bs(`{§rtf1§ansi
            §f0 a§u55357 §u56447 1 §u21834}`))).toBe('a👿1 啊');
    expect(await rtf(bs(`{§rtf1§ansi
            {§f0 §u-10179§'5f§u-9089§'5f}
            {§f1 §uc2§u32767§'c2§'52}
            {§f2 §uc2§u26789§'97§'73}
            {§f3 b§'eate}
            {§f4 §uc0 b§'ea§'eate}
           }`))).toBe('👿翿梥bêtebêête');
  });
  it('parser.rs parse_ignore_group_with_crlf consumes the whole group', async () => {
    expect(await rtf('{\\\n        \\\n        \\*\\expandedcolortbl;;}')).toBe('');
  });
  it('reports lexer/parser failures with the Rust Debug payloads', async () => {
    expect((await failure('a.rtf', Buffer.from('plain text'))).message).toBe('RTF解析错误: RTF词法分析失败: InvalidLastChar');
    expect((await failure('a.rtf', Buffer.from('x{}'))).message)
      .toBe('RTF解析错误: RTF语法分析失败: InvalidToken("Invalid first token : PlainText : \\"x\\" not a \'{\'")');
    expect((await failure('a.rtf', Buffer.from(String.raw`{\rtf1{\fonttbl\f}x}`))).message).toBe('RTF解析错误: RTF语法分析失败: InvalidFontIdentifier(None)');
    expect((await failure('a.rtf', Buffer.from(String.raw`{\rtf1\fs70000 x}`))).message).toBe('RTF解析错误: RTF语法分析失败: ValueCastError("u16")');
    expect((await failure('a.rtf', Buffer.from(String.raw`{\rtf1\pard\*\x y}`))).message).toBe('RTF解析错误: RTF语法分析失败: IgnorableDestinationParsingError');
    expect((await failure('a.rtf', Buffer.from(String.raw`{\rtf1\f99999999999 x}`))).message)
      .toBe('RTF解析错误: RTF词法分析失败: Error("[Lexer] Unable to parse 99999999999 as integer")');
  });
});

const PPTX_NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const slide = (tree: string): string => `<?xml version="1.0" encoding="UTF-8"?><p:sld ${PPTX_NS}><p:cSld><p:spTree><p:nvGrpSpPr/><p:grpSpPr/>${tree}</p:spTree></p:cSld></p:sld>`;
const pptx = (slides: Record<string, string>): Uint8Array =>
  writeZip([{ name: '[Content_Types].xml', data: CONTENT_TYPES }, ...Object.entries(slides).map(([name, data]) => ({ name, data }))]);
const sp = (body: string): string => `<p:sp><p:nvSpPr/><p:txBody><a:bodyPr/>${body}</p:txBody></p:sp>`;
const run = (text: string, rPr = ''): string => `<a:r>${rPr}<a:t>${text}</a:t></a:r>`;
const tc = (text: string): string => `<a:tc><a:txBody><a:p>${run(text)}</a:p></a:txBody></a:tc>`;

describe('nativeOffice pptx (document_parser.rs extract_pptx_*, pptx-to-md 0.2.0 via WASI, extract_images(false))', () => {
  const deck = pptx({
    'ppt/slides/slide2.xml': slide(sp(`<a:p>${run('it', '<a:rPr i="true" u="sng"/>')}${run('x')}</a:p>`)),
    'ppt/slides/slide1.xml': slide([
      sp(`<a:p>${run('Title', '<a:rPr b="1"/>')}</a:p>`),
      sp(`<a:p><a:pPr lvl="0"><a:buChar char="•"/></a:pPr>${run('one')}</a:p><a:p><a:pPr lvl="1"><a:buAutoNum type="arabicPeriod"/></a:pPr>${run('sub')}</a:p><a:p><a:pPr lvl="1"/>${run('sub2')}</a:p>`),
      `<p:graphicFrame><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tr>${tc('h1')}${tc('h2')}</a:tr><a:tr>${tc('c1')}<a:tc/></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`,
      '<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill></p:pic>',
      '<p:grpSp/>',
    ].join('')),
    'ppt/slides/slide10.xml': slide(''),
    'ppt/slides/_rels/slide1.xml.rels': EMPTY_RELS,
    'ppt/slideLayouts/slideLayout1.xml': '<broken',
  });
  const page1 = '<!-- Slide 1 -->\n\n**Title**\n\n1. one\n\n\t1. sub\n\n\t- sub2\n\n| h1 | h2 |\n| --- | --- |\n| c1 |  |';

  it('renders slides in byte-sorted path order with Markdown runs, lists, tables and the image newline', async () => {
    expect(await host.ctx.nativeOffice.extractPptxPages(deck)).toEqual([page1, '<!-- Slide 10 -->', '<!-- Slide 2 -->\n\n<u>_it_</u>x']);
    expect(await extract('deck.pptx', deck)).toBe(`${page1}\n\n<!-- Slide 10 -->\n\n<!-- Slide 2 -->\n\n<u>_it_</u>x`);
  });

  it('reads decks written by the production PPTX generator', async () => {
    const bytes = await host.ctx.nativeOfficeWriter.generatePptx({ title: 'T', slides: [
      { type: 'title', title: '标题', subtitle: '副标题' },
      { type: 'content', title: '要点', bullets: ['甲', '乙'] },
      { type: 'table', title: '表', headers: ['a', 'b'], rows: [['1', '2']] },
    ] });
    expect(await extract('g.pptx', bytes)).toBe('<!-- Slide 1 -->\n\n**标题**\n\n1. 副标题\n\n<!-- Slide 2 -->\n\n**要点**\n\n1. 甲\n\n2. 乙'
      + '\n\n<!-- Slide 3 -->\n\n**表**\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
  });

  it('fails the whole deck where pptx-to-md does', async () => {
    const noTxBody = await failure('d.pptx', pptx({ 'ppt/slides/slide1.xml': slide('<p:sp><p:nvSpPr/></p:sp>') }));
    expect(noTxBody.message).toBe('PPTX解析错误: 解析PPTX失败: Unknown');
    expect((await failure('d.pptx', pptx({ 'ppt/slides/slide1.xml': slide('<p:pic><p:blipFill/></p:pic>') }))).message)
      .toBe('PPTX解析错误: 解析PPTX失败: ImageNotFound');
    expect((await failure('d.pptx', pptx({ 'ppt/slides/slide1.xml': `<p:sld ${PPTX_NS}/>` }))).message).toBe('PPTX解析错误: 解析PPTX失败: Unknown');
    expect((await failure('d.pptx', pptx({ 'ppt/slides/slide1.xml': '<p:sld><p:cSld/></p:sld>' }))).message).toMatch(/^PPTX解析错误: 解析PPTX失败: Xml\(/u);
    expect((await failure('d.pptx', Buffer.from('nope'))).message).toMatch(/^PPTX解析错误: 无法打开PPTX: Zip\(/u);
    expect(await extract('empty.pptx', pptx({}))).toBe('');
  });
});

describe('nativeOffice spreadsheets (document_parser.rs extract_excel_text, calamine 0.26.1 via WASI)', () => {
  it('xlsx from the production generator: header detection, row counts, sheet order, numbers', async () => {
    const bytes = await host.ctx.nativeOfficeWriter.generateXlsx({ sheets: [
      { name: '词表', headers: ['单词', '释义'], rows: [['apple', '苹果'], ['pear', '梨']] },
      { name: 'Nums', headers: ['n'], rows: [['1'], ['2.5']] },
    ] });
    const text = await extract('w.xlsx', bytes);
    expect(text.startsWith('=== 词表 · 表头 1 行 + 数据 2 行 ===\n单词\t释义\napple\t苹果\npear\t梨')).toBe(true);
    expect(text).toContain('\n\n=== Nums · ');
  });

  it('ods via open_workbook_auto_from_rs', async () => {
    const content = '<?xml version="1.0" encoding="UTF-8"?><office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" office:version="1.2"><office:body><office:spreadsheet>'
      + '<table:table table:name="表一"><table:table-row><table:table-cell office:value-type="string"><text:p>名称</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>数量</text:p></table:table-cell></table:table-row>'
      + '<table:table-row><table:table-cell office:value-type="string"><text:p>苹果</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="3"><text:p>3</text:p></table:table-cell></table:table-row>'
      + '<table:table-row><table:table-cell office:value-type="string"><text:p>梨</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="1.5"><text:p>1.5</text:p></table:table-cell></table:table-row></table:table>'
      + '</office:spreadsheet></office:body></office:document-content>';
    const manifest = '<?xml version="1.0" encoding="UTF-8"?><manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.spreadsheet"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml"/></manifest:manifest>';
    const ods = writeZip([
      { name: 'mimetype', data: 'application/vnd.oasis.opendocument.spreadsheet', options: { compression: 'stored' } },
      { name: 'META-INF/manifest.xml', data: manifest }, { name: 'content.xml', data: content },
    ]);
    expect(await extract('s.ods', ods)).toBe('=== 表一 · 表头 1 行 + 数据 2 行 ===\n名称\t数量\n苹果\t3\n梨\t1.5');
  });

  it('unrecognised bytes report the calamine detection error', async () => {
    expect((await failure('x.xls', Buffer.from('not a workbook'))).message).toBe('Excel解析错误: 无法解析Excel数据: Cannot detect file format');
  });
});

describe('nativeOffice html (document_parser.rs extract_html_from_bytes, html2text 0.16.7 from_read(.., 80) via WASI)', () => {
  it('renders headings, emphasis, lists and links, wraps at 80 columns and trims', async () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
    const text = await extract('page.HTM', Buffer.from(`<html><head><title>t</title><style>p{}</style></head><body><h1>Title</h1><p>Hello <b>world</b> and <a href="https://example.com/">link</a></p><ul><li>a</li><li>b</li></ul><p>${words}</p></body></html>`));
    expect(text.startsWith('# Title')).toBe(true);
    expect(text).toContain('Hello **world** and [link][1]');
    expect(text).toContain('* a\n* b');
    expect(text).toContain('[1]: https://example.com/');
    expect(text.split('\n').every(line => [...line].length <= 80)).toBe(true);
    expect(text).toBe(text.trim());
  });
  it('decodes invalid UTF-8 lossily instead of failing', async () => {
    expect(await extract('x.html', Uint8Array.from([0x3c, 0x70, 0x3e, 0x61, 0xff, 0x62, 0x3c, 0x2f, 0x70, 0x3e]))).toBe('a'+String.fromCharCode(0xfffd)+'b');
  });
});

describe('nativeOffice dispatch', () => {
  it('selects the engine by Rust Path::extension', async () => {
    expect([...host.ctx.nativeOffice.formats].sort()).toEqual(['docx', 'html', 'ods', 'pptx', 'rtf', 'xls', 'xlsb', 'xlsx']);
    const unsupported = await failure('notes.txt', new Uint8Array());
    expect(unsupported.kind).toBe('UnsupportedFormat');
    expect(unsupported.message).toBe('不支持的文件格式: 不支持的文件格式: .txt');
    expect((await failure('.docx', new Uint8Array())).message).toBe('不支持的文件格式: 无法确定文件扩展名');
  });
});
