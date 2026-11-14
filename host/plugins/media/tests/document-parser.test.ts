import { expect, it } from 'vitest';
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BoundedCursor, DocumentParser, MAX_DOCUMENT_SIZE, ParsingError, type ParsingErrorKind,
} from '../src/document-parser.ts';
import { zipPackage } from './helpers/zip-fixture.ts';
import { createTestHost } from '../../../kernel/testing.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';

async function errorOf(run: () => unknown): Promise<ParsingError> {
  try { await run(); }
  catch (error) {
    if (error instanceof ParsingError) return error;
    throw error;
  }
  throw new Error('expected a ParsingError');
}

async function kindOf(run: () => unknown): Promise<ParsingErrorKind> {
  return (await errorOf(run)).kind;
}

it('test_document_parser_creation', async () => {
  const parser = new DocumentParser();
  // Rust 侧断言 size_of_val == 0（零大小类型）；TS 侧对应“实例不持有任何状态”。
  expect(Object.keys(parser)).toEqual([]);
});

it('test_txt_support', async () => {
  const parser = new DocumentParser();
  const testContent = Buffer.from('Hello, World!', 'utf8');
  expect(await parser.extractTextFromBytes('test.txt', testContent)).toBe('Hello, World!');
});

it('test_txt_with_unicode', async () => {
  const parser = new DocumentParser();
  const testContent = Buffer.from('中文测试 English Test 123', 'utf8');
  expect(await parser.extractTextFromBytes('test.txt', testContent)).toBe('中文测试 English Test 123');
});

it('test_md_support', async () => {
  const parser = new DocumentParser();
  const testContent = Buffer.from('# 标题\n\n这是**Markdown**内容。', 'utf8');
  expect(await parser.extractTextFromBytes('test.md', testContent)).toBe('# 标题\n\n这是**Markdown**内容。');
});

it('test_txt_gbk_decoding', async () => {
  // ★ 审阅问题 M6：GBK 编码文本不应退化为 U+FFFD 乱码
  const parser = new DocumentParser();
  // "中文测试" 的 GBK 编码
  const gbkBytes = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0xb2, 0xe2, 0xca, 0xd4]);
  const result = await parser.extractTextFromBytes('test.txt', gbkBytes);
  expect(result).toBe('中文测试');
  expect(result.includes('\uFFFD')).toBe(false);
});

it('test_txt_utf8_bom_decoding', async () => {
  const parser = new DocumentParser();
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('BOM 文本', 'utf8')]);
  expect(await parser.extractTextFromBytes('test.txt', bytes)).toBe('BOM 文本');
});

it('test_markdown_extension_alias', async () => {
  // ★ 审阅问题 R2：.markdown 扩展名应与 .md 同等支持
  const parser = new DocumentParser();
  expect(await parser.extractTextFromBytes('readme.markdown', Buffer.from('# Title', 'utf8'))).toBe('# Title');
});

it('test_base64_decoding_error', async () => {
  const parser = new DocumentParser();
  const error = await errorOf(() => parser.extractTextFromBase64('test.docx', 'invalid_base64!'));
  expect(error.kind).toBe('Base64DecodingError');
  expect(error.message).toBe('Base64解码错误: Invalid byte 95, offset 7.');
});

it('test_base64_size_is_checked_before_decode', async () => {
  expect(() => DocumentParser.checkBase64DecodedSize('SGVsbG8=', 5)).not.toThrow();
  expect(await kindOf(() => DocumentParser.checkBase64DecodedSize('SGVsbG8=', 4))).toBe('FileTooLarge');
});

it('test_bounded_xlsx_writer_rejects_growth_past_limit', async () => {
  const writer = new BoundedCursor(4);
  expect(() => writer.writeAll(Buffer.from('1234', 'utf8'))).not.toThrow();
  expect(() => writer.writeAll(Buffer.from('5', 'utf8'))).toThrow();
  expect(writer.position).toBe(4);
  expect(writer.intoInner().toString('utf8')).toBe('1234');
});

it('rejects formats that need native adapters instead of faking them', async () => {
  const parser = new DocumentParser();
  expect(await kindOf(() => parser.extractTextFromBytes('a.docx', Buffer.from('x')))).toBe('DocxParsingError');
  expect(await kindOf(() => parser.extractTextFromBytes('noext', Buffer.from('x')))).toBe('UnsupportedFormat');
  const code = await parser.extractTextFromBytes('main.rs', Buffer.from('fn main() {}', 'utf8'));
  expect(code).toBe('fn main() {}');
  expect(await parser.extractTextFromBytes('.gitignore', Buffer.from('target/\n', 'utf8'))).toBe('target/');
});

it('test_check_pdf_encryption_with_encrypt_marker', async () => {
  const parser = new DocumentParser();
  const dir = mkdtempSync(join(tmpdir(), 'doc-parser-'));
  try {
    const file = join(dir, 'encrypted.pdf');
    writeFileSync(file, Buffer.from('%PDF-1.4\n/Encrypt', 'utf8'));
    const error = await errorOf(() => parser.checkPdfEncryptionFromPath(file));
    expect(error.kind).toBe('EncryptedDocument');
    expect(error.message).toContain('加密');
    expect(error.message).toContain('PDF');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('test_check_pdf_encryption_normal_pdf', async () => {
  const parser = new DocumentParser();
  const dir = mkdtempSync(join(tmpdir(), 'doc-parser-'));
  try {
    const file = join(dir, 'normal.pdf');
    writeFileSync(file, Buffer.from('%PDF-1.4\n/Root 1 0 R\n%%EOF', 'utf8'));
    expect(() => parser.checkPdfEncryptionFromPath(file)).not.toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

it('test_check_pdf_encryption_encrypt_in_trailer', async () => {
  const parser = new DocumentParser();
  const content = Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'utf8'),
    Buffer.alloc(5000, 0x25),
    Buffer.from('\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF', 'utf8'),
  ]);
  expect(await kindOf(() => parser.checkPdfEncryption(content, 'encrypted_trailer.pdf')))
    .toBe('EncryptedDocument');
});

it('test_check_pdf_encryption_from_bytes', async () => {
  const parser = new DocumentParser();
  expect(await kindOf(() => parser.checkPdfEncryption(
    Buffer.from('%PDF-1.7\n/Encrypt 1 0 obj\n<<>>\nendobj', 'utf8'), 'test.pdf')))
    .toBe('EncryptedDocument');
  expect(() => parser.checkPdfEncryption(
    Buffer.from('%PDF-1.7\n/Root 1 0 obj\n<<>>\nendobj\n%%EOF', 'utf8'), 'normal.pdf'))
    .not.toThrow();
});

it('test_check_pdf_encryption_small_file', async () => {
  const parser = new DocumentParser();
  expect(() => parser.checkPdfEncryption(Buffer.from('%PDF-1.4\n%%EOF', 'utf8'), 'small.pdf'))
    .not.toThrow();
});

it('test_check_pdf_encryption_large_file_encrypt_in_middle', async () => {
  const parser = new DocumentParser();
  const content = Buffer.concat([
    Buffer.from('%PDF-1.4\n', 'utf8'),
    Buffer.alloc(5000, 0x25),
    Buffer.from('\n/Encrypt 1 0 R\n', 'utf8'),
    Buffer.alloc(5000, 0x25),
    Buffer.from('\n%%EOF', 'utf8'),
  ]);
  expect(await kindOf(() => parser.checkPdfEncryption(content, 'large_encrypted.pdf')))
    .toBe('EncryptedDocument');
});

it('test_check_pdf_encryption_encrypt_as_content', async () => {
  // 当前实现会误报这种情况，这是已知限制
  const parser = new DocumentParser();
  expect(await kindOf(() => parser.checkPdfEncryption(
    Buffer.from('%PDF-1.4\n(Text about /Encrypt feature)\n%%EOF', 'utf8'),
    'text_with_encrypt.pdf'))).toBe('EncryptedDocument');
});

/** 仅用 stored 条目拼一个 ZIP（中央目录足够让加密检查读取条目名）。 */
function zipOf(parts: Array<[string, string]>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of parts) {
    const nameBytes = Buffer.from(name, 'utf8');
    const data = Buffer.from(content, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x0403_4b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x0201_4b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(0, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x0605_4b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(parts.length, 8);
  eocd.writeUInt16LE(parts.length, 10);
  eocd.writeUInt32LE(centralBytes.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBytes, eocd]);
}

it('test_check_office_encryption_with_encrypted_package', async () => {
  const parser = new DocumentParser();
  const zip = zipOf([['EncryptedPackage', 'encrypted content placeholder']]);
  const error = await errorOf(() => parser.checkOfficeEncryption(zip, 'encrypted.docx'));
  expect(error.kind).toBe('EncryptedDocument');
  expect(error.message).toContain('encrypted.docx');
  expect(error.message).toContain('加密');
});

it('test_check_office_encryption_missing_content_types', async () => {
  const parser = new DocumentParser();
  const zip = zipOf([['random/file.txt', 'some random content']]);
  const error = await errorOf(() => parser.checkOfficeEncryption(zip, 'suspicious.docx'));
  expect(error.kind).toBe('EncryptedDocument');
  expect(error.message).toContain('suspicious.docx');
});

it('test_check_office_encryption_valid_document', async () => {
  const parser = new DocumentParser();
  const zip = zipOf([
    ['[Content_Types].xml', '<Types/>'],
    ['word/document.xml', '<document>content</document>'],
  ]);
  expect(() => parser.checkOfficeEncryption(zip, 'valid.docx')).not.toThrow();
});

it('test_check_office_encryption_has_office_structure_but_missing_content_types', async () => {
  const parser = new DocumentParser();
  const zip = zipOf([
    ['word/document.xml', '<document>content</document>'],
    ['docProps/core.xml', '<core>metadata</core>'],
  ]);
  expect(() => parser.checkOfficeEncryption(zip, 'partial.docx')).not.toThrow();
});

it('test_check_office_encryption_empty_zip', async () => {
  const parser = new DocumentParser();
  expect(await kindOf(() => parser.checkOfficeEncryption(zipOf([]), 'empty.docx')))
    .toBe('EncryptedDocument');
});

it('test_check_office_encryption_invalid_zip', async () => {
  const parser = new DocumentParser();
  expect(() => parser.checkOfficeEncryption(
    Buffer.from('This is not a valid ZIP file', 'utf8'), 'invalid.docx')).not.toThrow();
});

/** 构造一个最小的合法 EPUB（zip 容器 + container.xml + OPF + 单章 xhtml）。 */
function buildMinimalEpub(): Buffer {
  return zipOf([
    ['mimetype', 'application/epub+zip'],
    ['META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`],
    ['OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">test-epub-58</dc:identifier>
    <dc:title>高数错题本</dc:title>
    <dc:creator>测试作者</dc:creator>
    <dc:language>zh</dc:language>
  </metadata>
  <manifest>
    <item id="ch1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
  </spine>
</package>`],
    ['OEBPS/chapter1.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>第一章</title></head>
  <body><h1>第一章 极限</h1><p>当 x 趋近于 0 时 sin(x)/x 的极限为 1。</p></body>
</html>`],
  ]);
}

it('test_epub_extract_text_from_bytes', async () => {
  const parser = new DocumentParser();
  const epubBytes = buildMinimalEpub();

  let text: string;
  try { text = await parser.extractTextFromBytes('book.epub', epubBytes); }
  catch (error) { throw new Error(`EPUB 解析失败: ${String(error)}`); }

  expect(text).toContain('高数错题本');
  expect(text).toContain('极限');
  expect(text).toContain('sin(x)/x');
});

it('test_epub_invalid_zip_reports_epub_error', async () => {
  const parser = new DocumentParser();
  expect(await kindOf(() => parser.extractTextFromBytes('broken.epub', Buffer.alloc(64))))
    .toBe('EpubParsingError');
});

it('test_epub_extension_case_insensitive', async () => {
  const parser = new DocumentParser();
  // 大写扩展名同样应路由到 EPUB 解析器
  const text = await parser.extractTextFromBytes('BOOK.EPUB', buildMinimalEpub());
  expect(text).toContain('极限');
});

it('test_integration_extract_encrypted_docx', async () => {
  const parser = new DocumentParser();
  // 创建一个带 EncryptedPackage 的 ZIP
  const zip = zipOf([['EncryptedPackage', 'encrypted content']]);
  expect(await kindOf(() => parser.extractTextFromBytes('encrypted.docx', zip)))
    .toBe('EncryptedDocument');
});

it('zip_bomb_guard_rejects_extreme_ratio_and_accepts_reference_package', async () => {
  const parser = new DocumentParser();
  // 2MB 零字节 deflate 后压缩比远超 100:1
  const bomb = zipPackage([
    ['[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['xl/worksheets/sheet1.xml', Buffer.alloc(2 * 1024 * 1024)],
  ], { deflate: true });
  expect(await kindOf(() => parser.checkZipBomb(bomb, 'bomb.xlsx'))).toBe('ZipBombDetected');
  expect(() => parser.checkZipBomb(buildMinimalEpub(), 'book.epub')).not.toThrow();
});

it('test_file_too_large', async () => {
  const parser = new DocumentParser();
  const largeContent = new Uint8Array(MAX_DOCUMENT_SIZE + 1);

  expect(await kindOf(() => parser.editXlsxCells(largeContent, []))).toBe('FileTooLarge');
  expect(await kindOf(() => parser.replaceTextInXlsx(largeContent, []))).toBe('FileTooLarge');
  expect(await kindOf(() => parser.extractTextFromBytes('test.txt', largeContent)))
    .toBe('FileTooLarge');
});

it('test_office_encryption_rejects_real_cfb_container_signature', async () => {
  const parser = new DocumentParser();
  const cfb = Buffer.alloc(512);
  cfb.set([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1], 0);

  expect(await kindOf(() => parser.checkOfficeEncryption(cfb, 'encrypted.xlsx')))
    .toBe('EncryptedDocument');
  expect(await kindOf(() => parser.editXlsxCells(cfb, []))).toBe('EncryptedDocument');
  expect(await kindOf(() => parser.replaceTextInXlsx(cfb, []))).toBe('EncryptedDocument');
});

it('test_integration_extract_encrypted_xlsx', async () => {
  const parser = new DocumentParser();
  const zip = zipOf([['EncryptedPackage', 'encrypted content']]);

  expect(await kindOf(() => parser.editXlsxCells(zip, []))).toBe('EncryptedDocument');
  expect(await kindOf(() => parser.replaceTextInXlsx(zip, []))).toBe('EncryptedDocument');
  expect(await kindOf(() => parser.extractTextFromBytes('encrypted.xlsx', zip)))
    .toBe('EncryptedDocument');
});

it('test_xlsx_edit_paths_reject_zip_bombs_before_parsing', async () => {
  const parser = new DocumentParser();
  const bomb = zipPackage([
    ['[Content_Types].xml',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
    ['xl/worksheets/sheet1.xml', Buffer.alloc(2 * 1024 * 1024)],
  ], { deflate: true });

  expect(await kindOf(() => parser.editXlsxCells(bomb, []))).toBe('ZipBombDetected');
  expect(await kindOf(() => parser.replaceTextInXlsx(bomb, []))).toBe('ZipBombDetected');
});

it('test_xlsx_replace_rejects_empty_find_term', async () => {
  const parser = new DocumentParser();
  const workbook = zipOf([
    ['[Content_Types].xml', '<Types/>'],
    ['xl/workbook.xml', '<workbook/>'],
  ]);
  expect(await kindOf(() => parser.replaceTextInXlsx(workbook, [['', 'unbounded insertion']])))
    .toBe('ExcelParsingError');
});

it('R1-MD-05 docs.extractTextFromPath follows extract_text_from_path (:814-854) and read_file_safely (:803)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'docs-path-'));
  const host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(), settings: { get: () => null, save: () => undefined }, paths: { appDataDir: dir } },
  });
  const rejected = (filePath: string) => host.ctx.docs.extractTextFromPath(filePath)
    .then(() => null, (error: unknown) => error as ParsingError);
  try {
    const txt = join(dir, 'Notes.TXT');
    writeFileSync(txt, '  你好 world \n');
    expect(await host.ctx.docs.extractTextFromPath(txt)).toBe('你好 world');

    const missing = join(dir, 'absent.txt');
    expect(await rejected(missing)).toMatchObject({ kind: 'FileNotFound', message: `文件未找到: ${missing}` });

    const bare = join(dir, 'README');
    writeFileSync(bare, 'x');
    expect(await rejected(bare)).toMatchObject({
      kind: 'UnsupportedFormat', message: '不支持的文件格式: 无法确定文件扩展名',
    });

    const unknown = join(dir, 'data.zzz');
    writeFileSync(unknown, 'x');
    expect(await rejected(unknown)).toMatchObject({
      kind: 'UnsupportedFormat', message: '不支持的文件格式: 不支持的文件格式: .zzz',
    });

    // 大小在读取前按 metadata 检查：稀疏文件不需要真实读入 200MB
    const huge = join(dir, 'huge.txt');
    writeFileSync(huge, '');
    truncateSync(huge, MAX_DOCUMENT_SIZE + 1);
    expect(await rejected(huge)).toMatchObject({
      kind: 'FileTooLarge', message: '文件过大: 文件大小 200MB 超过限制 200MB',
    });
  } finally {
    await host.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});
