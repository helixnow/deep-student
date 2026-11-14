/**
 * `DocumentParser::extract_docx_with_images` (document_parser.rs:998-1446) has no
 * Rust unit test; these contract tests go through the provided `docs` service.
 * Expected strings follow the Rust extraction over docx-rs 0.4.19's reader model.
 */
import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import type { DocsService } from '../api.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { replaceEscaped } from '../src/docx-images.ts';
import { zipPackage } from './helpers/zip-fixture.ts';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const CONTENT_TYPES = '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>';
const ROOT_RELS = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
  + '</Relationships>';
const IMAGE_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

function drawing(rid: string): string {
  return `<w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic><pic:blipFill><a:blip r:embed="${rid}"/></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>`;
}

function docx(body: string, rels: string | null, extra: Array<[string, Uint8Array]> = []): Buffer {
  const parts: Array<[string, string | Uint8Array]> = [
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', ROOT_RELS],
    ['word/document.xml', `<?xml version="1.0"?><w:document ${W}><w:body>${body}</w:body></w:document>`],
  ];
  if (rels !== null) parts.push(['word/_rels/document.xml.rels', rels]);
  parts.push(...extra);
  return zipPackage(parts);
}

function rels(entries: Array<[string, string, string]>): string {
  return '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + entries.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type}" Target="${target}"/>`).join('')
    + '</Relationships>';
}

async function withDocs<T>(run: (docs: DocsService) => Promise<T>): Promise<T> {
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: { get: () => null, save: () => undefined }, paths: { appDataDir: process.cwd() } },
  });
  try { return await run(host.ctx.docs as DocsService); }
  finally { await host.dispose(); }
}

const IMG_A = Uint8Array.from([1, 2, 3]);
const IMG_B = Uint8Array.from([4, 5]);

it('extracts paragraph text, revisions, tables and image markers in document order', async () => {
  const body = [
    '<w:p><w:pPr><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>第一题</w:t><w:tab/><w:t xml:space="preserve"> A</w:t></w:r></w:p>',
    `<w:p><w:r><w:t>图:</w:t></w:r><w:r>${drawing('rId5')}</w:r><w:r><w:br/><w:t>见上</w:t></w:r></w:p>`,
    '<w:p><w:hyperlink r:id="rId9"><w:r><w:t>链接</w:t></w:r></w:hyperlink>'
      + '<w:ins><w:r><w:t>插入</w:t></w:r></w:ins><w:del><w:r><w:delText>删除</w:delText></w:r></w:del>'
      + '<w:smartTag><w:r><w:t>标签</w:t></w:r></w:smartTag></w:p>',
    '<w:p><w:r><w:t>   </w:t></w:r></w:p>',
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tr><w:tc><w:p><w:r><w:t> a </w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc><w:tc><w:p/></w:tc></w:tr>'
      + `<w:tr><w:tc><w:p/></w:tc><w:tc><w:p/></w:tc></w:tr><w:tr><w:tc><w:p><w:r>${drawing('rId5')}</w:r></w:p></w:tc><w:tc><w:p><w:r>${drawing('rId6')}</w:r></w:p></w:tc></w:tr></w:tbl>`,
    '<w:sdt><w:sdtContent><w:p><w:r><w:t>目录项</w:t></w:r></w:p></w:sdtContent></w:sdt>',
    '<w:p><w:r><w:t>&amp;lt;x&amp;gt;</w:t></w:r></w:p>',
    '<w:sectPr/>',
  ].join('');
  const bytes = docx(body, rels([
    ['rId5', IMAGE_TYPE, 'media/image1.png'],
    ['rId6', IMAGE_TYPE, '/word/media/image2.jpeg'],
    ['rId7', IMAGE_TYPE, 'media/missing.png'],
    ['rId9', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', 'https://x'],
  ]), [['word/media/image1.png', IMG_A], ['word/media/image2.jpeg', IMG_B]]);

  const result = await withDocs(docs => docs.extractDocxWithImages(bytes));
  expect(result.text).toBe([
    '第一题\t A',
    '图:<<IMG:0>>\n见上',
    '链接插入删除标签',
    '| a b |  |',
    '| <<IMG:0>> | <<IMG:1>> |',
    '',
    '<x>',
    '',
  ].join('\n'));
  expect(result.images.map(image => [...image])).toEqual([[1, 2, 3], [4, 5]]);
});

it('drops drawings without a known image relationship and ignores mc:Fallback / text boxes', async () => {
  const body = '<w:p><w:r><w:t>前</w:t>'
    + '<mc:AlternateContent><mc:Choice>' + drawing('rId5') + '</mc:Choice>'
    + `<mc:Fallback>${drawing('rId5')}</mc:Fallback></mc:AlternateContent>`
    + `</w:r><w:r>${drawing('rId7')}</w:r>`
    + '<w:r><w:drawing><wp:anchor><a:graphic><a:graphicData><wps:wsp><wps:txbx><w:txbxContent><w:p><w:r><w:t>框内</w:t></w:r></w:p></w:txbxContent></wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
    + '<w:r><w:t>后</w:t></w:r></w:p>';
  const bytes = docx(body, rels([['rId5', IMAGE_TYPE, 'media/a.png'], ['rId7', IMAGE_TYPE, 'media/none.png']]),
    [['word/media/a.png', IMG_A]]);
  const result = await withDocs(docs => docs.extractDocxWithImages(bytes));
  expect(result.text).toBe('前<<IMG:0>>后\n');
  expect(result.images).toHaveLength(1);
});

it('instrText field codes and w:sym do not contribute text', async () => {
  const body = '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r>'
    + '<w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>3</w:t></w:r><w:r><w:sym w:font="Symbol" w:char="F0B7"/></w:r></w:p>';
  const result = await withDocs(docs => docs.extractDocxWithImages(docx(body, null)));
  expect(result).toEqual({ text: '3\n', images: [] });
});

it('reports docx-rs package failures and the image relationship limit', async () => {
  await withDocs(async docs => {
    await expect(docs.extractDocxWithImages(zipPackage([
      ['[Content_Types].xml', CONTENT_TYPES], ['word/document.xml', `<w:document ${W}/>`]])))
      .rejects.toThrow('DOCX解析错误: Failed to read from zip.');
    await expect(docs.extractDocxWithImages(zipPackage([['[Content_Types].xml', CONTENT_TYPES], ['_rels/.rels', ROOT_RELS]])))
      .rejects.toThrow('DOCX解析错误: Failed to read from zip.');
    const many = Array.from({ length: 513 }, (_, i) => [`rId${i}`, IMAGE_TYPE, `media/${i}.png`] as [string, string, string]);
    await expect(docs.extractDocxWithImages(docx('<w:p/>', rels(many))))
      .rejects.toThrow('DOCX解析错误: DOCX 图片 relationship 数量超过上限 512');
    await expect(docs.extractDocxWithImages(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0])))
      .rejects.toThrow("文档已加密: 文件 'document.docx' 是加密的 Office 文档，请先解除密码保护后再上传");
  });
});

it('replace_escaped decodes a second entity layer like docx-rs', () => {
  expect(replaceEscaped('&lt;a&gt; &amp;amp; &quot;&#39;&apos;&nbsp;')).toBe('<a> &amp; "\'\' ');
});
