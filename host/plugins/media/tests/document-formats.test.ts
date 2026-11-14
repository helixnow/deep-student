/**
 * `document_parser.rs` PDF / CSV / JSON / XML extraction and the path-vs-bytes
 * differences, through the production `docs` service with real F7 natives.
 * Rust has no unit tests for these branches; these are contract tests.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createTestHost, type TestHost } from '../../../kernel/testing.ts';
import { pdfium } from '../../../platform/native/pdfium/index.ts';
import { officeText } from '../../../platform/native/office/text.ts';
import media from '../index.ts';
import { unusedStorage } from './helpers/storage-double.ts';
import { zipPackage } from './helpers/zip-fixture.ts';

let dir: string;
let host: TestHost;

const settings = { get: () => null, save: () => undefined };

/** Two-page PDF with Helvetica text and a correct xref table. */
function textPdf(pages: readonly string[]): Buffer {
  const objects: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  const fontId = 3 + pages.length * 2;
  objects.push('<</Type/Catalog/Pages 2 0 R>>');
  objects.push(`<</Type/Pages/Kids[${kids}]/Count ${pages.length}>>`);
  pages.forEach((text, i) => {
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents ${4 + i * 2} 0 R`
      + `/Resources<</Font<</F1 ${fontId} 0 R>>>>>>`);
    const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
    objects.push(`<</Length ${stream.length}>>stream\n${stream}\nendstream`);
  });
  objects.push('<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>');
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

function encryptedOfficeZip(): Buffer {
  return zipPackage([['EncryptedPackage', 'x'], ['[Content_Types].xml', '<Types/>']]);
}

async function failure(run: () => Promise<unknown>): Promise<{ kind: string; message: string }> {
  try { await run(); }
  catch (error) { return error as { kind: string; message: string }; }
  throw new Error('expected rejection');
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'docs-formats-'));
  host = await createTestHost({
    plugins: [media],
    provide: { storage: unusedStorage(),
      settings, paths: { appDataDir: dir },
      nativePdfium: pdfium, nativeOfficeText: officeText,
    },
  });
});
afterEach(async () => {
  await host?.dispose();
  rmSync(dir, { recursive: true, force: true });
});

it('pdf bytes and path extract per-page text joined by form feed, trimmed', async () => {
  const pdf = textPdf(['Hello PDF', 'Second page']);
  expect(await host.ctx.docs.extractTextFromBytes('a.PDF', pdf)).toBe('Hello PDF\fSecond page');
  const file = join(dir, 'doc.pdf');
  writeFileSync(file, pdf);
  expect(await host.ctx.docs.extractTextFromPath(file)).toBe('Hello PDF\fSecond page');
});

it('pdf encryption check runs before pdfium; bytes uses document.pdf, path the real name', async () => {
  const encrypted = Buffer.from('%PDF-1.4\n1 0 obj<</Encrypt 2 0 R>>endobj\n%%EOF');
  expect(await failure(() => host.ctx.docs.extractTextFromBytes('x.pdf', encrypted))).toMatchObject({
    kind: 'EncryptedDocument',
    message: "文档已加密: 文件 'document.pdf' 是加密的 PDF 文档，请先解除密码保护后再上传",
  });
  const file = join(dir, 'Secret.pdf');
  writeFileSync(file, encrypted);
  expect(await failure(() => host.ctx.docs.extractTextFromPath(file))).toMatchObject({
    kind: 'EncryptedDocument',
    message: "文档已加密: 文件 'Secret.pdf' 是加密的 PDF 文档，请先解除密码保护后再上传",
  });
});

it('pdf load failures are PdfParsingError with the Rust prefix', async () => {
  const error = await failure(() => host.ctx.docs.extractTextFromBytes('x.pdf', Buffer.from('not a pdf')));
  expect(error.kind).toBe('PdfParsingError');
  expect(error.message.startsWith('PDF解析错误: PDF文档加载失败: ')).toBe(true);
});

it('pdf load failures print pdfium-render Debug of FPDF_GetLastError (pdfium_utils.rs:150, pdfium.rs:520-543)', async () => {
  // G3 docs.parse_b64.pdf step 3, Rust A side.
  const error = await failure(() => host.ctx.docs.extractTextFromBytes('x.pdf', Buffer.from('not a pdf')));
  expect(error.message).toBe('PDF解析错误: PDF文档加载失败: PdfiumLibraryInternalError(FormatError)');
});

it('pdf without the native engine reports PdfParsingError instead of pretending', async () => {
  const bare = await createTestHost({ plugins: [media], provide: { storage: unusedStorage(), settings, paths: { appDataDir: dir } } });
  try {
    const error = await failure(() => bare.ctx.docs.extractTextFromBytes('x.pdf', textPdf(['x'])));
    expect(error.kind).toBe('PdfParsingError');
  } finally { await bare.dispose(); }
});

it('csv goes through nativeOfficeText (headers + flexible records, tab separated, trimmed)', async () => {
  const csv = Buffer.from('name,value\r\n"a,b","a""b"\r\nlast\n', 'utf8');
  expect(await host.ctx.docs.extractTextFromBytes('t.csv', csv)).toBe('name\tvalue\na,b\ta"b\nlast');
});

it('json is to_string_pretty with preserve_order, last-wins duplicates and serde Value number text', async () => {
  // Production app feature unification enables serde_json/arbitrary_precision (dstu-vision/media
  // Cargo.toml), and locked serde_json-1.0.149 de.rs:1027-1050 stores lowercase `e` with an
  // explicit `+`; number.rs:350-366 Display writes that raw string; de.rs:938-1000 stores `-0`
  // as i64(0). Hence Value `1e2` prints `1e+2`, not ryu `100.0`, and `-0` prints `0`.
  const input = '{"b":1,"a":[1.0,1e2,0.1,-0,18446744073709551615,-9223372036854775808],'
    + '"b":{"x":"q\\"\\\\\\n\\u0001/é","e":[],"o":{}},"n":null,"t":true}';
  expect(await host.ctx.docs.extractTextFromBytes('d.json', Buffer.from(input, 'utf8'))).toBe([
    '{',
    '  "b": {',
    '    "x": "q\\"\\\\\\n\\u0001/é",',
    '    "e": [],',
    '    "o": {}',
    '  },',
    '  "a": [',
    '    1.0,',
    '    1e+2,',
    '    0.1,',
    '    0,',
    '    18446744073709551615,',
    '    -9223372036854775808',
    '  ],',
    '  "n": null,',
    '  "t": true',
    '}',
  ].join('\n'));
  // Parse failures (including trailing characters) return the raw text trimmed.
  expect(await host.ctx.docs.extractTextFromBytes('d.json', Buffer.from('  {"a":1} x \n'))).toBe('{"a":1} x');
  // The Ok branch is not trimmed: a top-level string keeps its spaces.
  expect(await host.ctx.docs.extractTextFromBytes('d.json', Buffer.from(' " a " '))).toBe('" a "');
});

it('xml joins trimmed Text/CDATA, skips unescape failures, stops at the first error', async () => {
  const xml = '﻿<?xml version="1.0"?><!DOCTYPE note><root a=">">  Hello &amp; world <b> x </b>'
    + '<![CDATA[ raw <cdata> ]]><!-- c --> tail &unknown; ok <c>&#x41;&#66;</c><d>&#0;</d>'
    + '<e/></root> after ';
  expect(await host.ctx.docs.extractTextFromBytes('n.xml', Buffer.from(xml, 'utf8')))
    .toBe('Hello & world x raw <cdata> AB after');
  // Mismatched end tag: text before the error survives.
  expect(await host.ctx.docs.extractTextFromBytes('n.xml', Buffer.from('<a>one</b>two')))
    .toBe('one');
  // Unmatched close tag before any text: nothing collected → original trimmed.
  expect(await host.ctx.docs.extractTextFromBytes('n.xml', Buffer.from('  </a>two ')))
    .toBe('</a>two');
  // Unclosed constructs are errors; unclosed elements at EOF are not.
  expect(await host.ctx.docs.extractTextFromBytes('n.xml', Buffer.from('<a>x<!-- y')))
    .toBe('x');
  expect(await host.ctx.docs.extractTextFromBytes('n.xml', Buffer.from('<a><b>deep')))
    .toBe('deep');
  expect(await host.ctx.docs.extractTextFromBytes('n.xml', Buffer.from('<a>x<?>y</a>')))
    .toBe('x');
  expect(await host.ctx.docs.extractTextFromBytes('n.xml', Buffer.from(' <a><b/></a> ')))
    .toBe('<a><b/></a>');
});

it('office checks use fixed names for bytes and the real file name for paths', async () => {
  const zip = encryptedOfficeZip();
  const encrypted = (name: string) =>
    `文档已加密: 文件 '${name}' 是加密的 Office 文档，请先解除密码保护后再上传`;
  expect(await failure(() => host.ctx.docs.extractTextFromBytes('Report.docx', zip)))
    .toMatchObject({ kind: 'EncryptedDocument', message: encrypted('document.docx') });
  expect(await failure(() => host.ctx.docs.extractTextFromBytes('Deck.pptx', zip)))
    .toMatchObject({ kind: 'EncryptedDocument', message: encrypted('presentation.pptx') });
  expect(await failure(() => host.ctx.docs.extractTextFromBytes('Book.xlsx', zip)))
    .toMatchObject({ kind: 'EncryptedDocument', message: encrypted('Book.xlsx') });
  for (const name of ['Report.docx', 'Deck.pptx', 'Book.ods']) {
    const file = join(dir, name);
    writeFileSync(file, zip);
    expect(await failure(() => host.ctx.docs.extractTextFromPath(file)))
      .toMatchObject({ kind: 'EncryptedDocument', message: encrypted(name) });
  }
  // .xls is not a ZIP container: no encryption/ZIP checks; the engine call site is reached.
  expect(await failure(() => host.ctx.docs.extractTextFromBytes('old.xls', zip))).toMatchObject({
    kind: 'ExcelParsingError', message: 'Excel解析错误: 无法解析Excel数据: 宿主未提供 nativeOffice',
  });
});

it('path csv/json/xml reuse the bytes branch with the file name', async () => {
  const file = join(dir, 'Data.JSON');
  writeFileSync(file, '[1]');
  expect(await host.ctx.docs.extractTextFromPath(file)).toBe('[\n  1\n]');
  const xml = join(dir, 'n.xml');
  writeFileSync(xml, '<a> hi </a>');
  expect(await host.ctx.docs.extractTextFromPath(xml)).toBe('hi');
});
