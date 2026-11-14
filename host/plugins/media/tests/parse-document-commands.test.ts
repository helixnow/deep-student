/**
 * `commands.rs:4093-4148` parse_document_from_path / parse_document_from_base64 through
 * `host.invoke`, with the real F7 nativeOffice / nativeOfficeText / nativePdfium engines.
 * Rust has no tests for these commands; these are contract tests.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { pdfium } from '../../../platform/native/pdfium/index.ts';
import { office } from '../../../platform/native/office/extract.ts';
import { officeText } from '../../../platform/native/office/text.ts';
import { createOfficeWriter } from '../../../platform/native/office/writer.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { zipPackage } from './helpers/zip-fixture.ts';

let dir: string;
let host: TestHost;
const writer = createOfficeWriter(() => {});
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'parse-document-'));
  host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings: { get: () => null, save: () => undefined }, paths: { appDataDir: dir },
      nativePdfium: pdfium, nativeOffice: office, nativeOfficeText: officeText,
    },
  });
});
afterEach(async () => {
  await host?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

it('docx through both commands (bytes version gates as document.docx, path as the real name)', async () => {
  const docx = await writer.generateDocx({ blocks: [{ type: 'paragraph', text: 'Hello DOCX' }] });
  expect(await host.invoke('parse_document_from_base64', { fileName: 'a.docx', base64Content: b64(docx) }))
    .toContain('Hello DOCX');
  const file = join(dir, 'Report.docx');
  writeFileSync(file, docx);
  expect(await host.invoke('parse_document_from_path', { filePath: file })).toContain('Hello DOCX');
  // Corrupt OOXML: the DocxParsingError from the engine is wrapped by the command layer.
  const broken = Buffer.from('not a zip');
  await expect(host.invoke('parse_document_from_base64', { fileName: 'b.docx', base64Content: b64(broken) }))
    .rejects.toMatch(/^Base64文档解析失败: DOCX解析错误: /u);
});

it('pptx and rtf are extracted by nativeOffice', async () => {
  const pptx = await writer.generatePptx({ slides: [{ type: 'content', title: 'Deck Title', bullets: ['point one'] }] });
  const text = await host.invoke<string>('parse_document_from_base64', { fileName: 'd.pptx', base64Content: b64(pptx) });
  expect(text).toContain('Deck Title');
  expect(text).toContain('point one');
  const rtf = Buffer.from('{\\rtf1\\ansi Hello RTF}');
  expect(await host.invoke('parse_document_from_base64', { fileName: 'n.rtf', base64Content: b64(rtf) }))
    .toBe('Hello RTF');
});

it('xlsx and html run on the F7 calamine / html2text engines; Excel path errors use the open_workbook_auto prefix', async () => {
  const xlsx = await writer.generateXlsx({ sheets: [{ name: 'Words', headers: ['词', '义'], rows: [['apple', '苹果']] }] });
  const fromBase64 = await host.invoke<string>('parse_document_from_base64', { fileName: 'b.xlsx', base64Content: b64(xlsx) });
  for (const part of ['Words', '词', '义', 'apple', '苹果']) expect(fromBase64).toContain(part);
  const file = join(dir, 'Book.xlsx');
  writeFileSync(file, xlsx);
  expect(await host.invoke('parse_document_from_path', { filePath: file })).toBe(fromBase64);

  // A ZIP that passes the L18 gates but is not a workbook: calamine fails at the library call.
  const notWorkbook = zipPackage([['[Content_Types].xml', '<Types/>'], ['xl/other.xml', '<x/>']]);
  const bytesError = await host.invoke('parse_document_from_base64', { fileName: 'c.xlsx', base64Content: b64(notWorkbook) })
    .then(() => null, (error: unknown) => String(error));
  expect(bytesError).toMatch(/^Base64文档解析失败: Excel解析错误: 无法解析Excel数据: /u);
  const broken = join(dir, 'Broken.xlsx');
  writeFileSync(broken, notWorkbook);
  const pathError = await host.invoke('parse_document_from_path', { filePath: broken })
    .then(() => null, (error: unknown) => String(error));
  expect(pathError).toBe(bytesError!.replace('Base64文档解析失败: Excel解析错误: 无法解析Excel数据: ', '文档解析失败: Excel解析错误: 无法打开Excel文件: '));

  const html = await host.invoke<string>('parse_document_from_base64', {
    fileName: 'p.HTM', base64Content: b64(Buffer.from('<html><body><h1>Title</h1><p>para text</p></body></html>')),
  });
  expect(html).toContain('Title');
  expect(html).toContain('para text');
  expect(html).not.toContain('<p>');
});

it('docs.extractPagedTextFromBytes: pptx per slide behind presentation.pptx gates, epub per chapter, else null', async () => {
  const deck = await writer.generatePptx({ title: 'T', slides: [
    { type: 'title', title: '标题', subtitle: '副标题' },
    { type: 'content', title: '要点', bullets: ['甲'] },
  ] });
  const pages = await host.ctx.docs.extractPagedTextFromBytes('Deck.PPTX', deck);
  expect(pages).toEqual(['<!-- Slide 1 -->\n\n**标题**\n\n1. 副标题', '<!-- Slide 2 -->\n\n**要点**\n\n1. 甲']);
  expect(await host.invoke('parse_document_from_base64', { fileName: 'deck.pptx', base64Content: b64(deck) }))
    .toBe(pages!.join('\n\n'));
  const encrypted = zipPackage([['EncryptedPackage', 'secret']]);
  await expect(host.ctx.docs.extractPagedTextFromBytes('x.pptx', encrypted)).rejects.toMatchObject({
    message: "文档已加密: 文件 'presentation.pptx' 是加密的 Office 文档，请先解除密码保护后再上传",
  });
  expect(await host.ctx.docs.extractPagedTextFromBytes('notes.txt', Buffer.from('x'))).toBeNull();
  expect(await host.ctx.docs.extractPagedTextFromBytes('noext', Buffer.from('x'))).toBeNull();
});

it('plain formats, data URLs and command-level error wrapping', async () => {
  expect(await host.invoke('parse_document_from_base64', {
    fileName: 'n.txt', base64Content: `data:text/plain;base64,${b64(Buffer.from('  hi  '))}`,
  })).toBe('hi');
  expect(await host.invoke('parse_document_from_base64', {
    fileName: 'd.json', base64Content: b64(Buffer.from('{"a":[]}')),
  })).toBe('{\n  "a": []\n}');
  const missing = join(dir, 'absent.pdf');
  await expect(host.invoke('parse_document_from_path', { filePath: missing }))
    .rejects.toBe(`文档解析失败: 文件未找到: ${missing}`);
  await expect(host.invoke('parse_document_from_base64', { fileName: 'x.txt', base64Content: 'data:abc' }))
    .rejects.toBe('Base64文档解析失败: Base64解码错误: Invalid data URL format: missing base64 content after comma');
  await expect(host.invoke('parse_document_from_base64', { fileName: 'x.zzz', base64Content: b64(Buffer.from('x')) }))
    .rejects.toBe('Base64文档解析失败: 不支持的文件格式: 不支持的文件格式: .zzz');
});
