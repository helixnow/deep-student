/**
 * `dstu-docs/src/document_parser.rs`: document extraction that does not need the
 * Rust-only OOXML/PDF crates — plain text, code extensions, encoding sniffing,
 * size/Base64/encryption guards, ZIP-bomb detection and EPUB (ZIP + XML + a
 * simplified HTML text renderer).
 *
 * DOCX / PDF / XLSX / PPTX / RTF / HTML extraction, OOXML generation and xlsx
 * round-trip editing run on the F7 native engines (`nativePdfium`,
 * `nativeOffice`, `nativeOfficeWriter`) after this parser's gates; a missing
 * engine is reported with the Rust error variant instead of pretending to parse.
 */
import { readFileSync, statSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename } from '../../../platform/util/path.ts';
import { Base64DecodeError, decodeBase64Standard } from './base64.ts';
import { rustTrim } from './transcript.ts';
import { extractDocxWithImagesUnchecked, type DocxTextWithImages } from './docx-images.ts';
import { extractJsonText, extractXmlText } from './text-formats.ts';
import { DISPLAY_PREFIX, ParsingError } from './document-errors.ts';
import * as guards from './document-guards.ts';
import { MAX_DOCUMENT_SIZE } from './document-guards.ts';
import { extractEpubPagesFromBytes as extractEpubPages } from './document-epub.ts';
import { validateXlsxEdits, validateXlsxReplacements } from './xlsx-bounds.ts';
import type { NativePdfium } from '../../../platform/native/pdfium/api.ts';
import {
  OfficeParsingError, type DocxMetadata, type DocxSpec, type NativeOffice, type NativeOfficeText,
  type NativeOfficeWriter, type PptxMetadata, type XlsxMetadata, type XlsxSpec, type XlsxTable,
} from '../../../platform/native/office/api.ts';

export { ParsingError, type ParsingErrorKind } from './document-errors.ts';
export {
  MAX_COMPRESSION_RATIO, MAX_DECOMPRESSED_SIZE, MAX_DOCUMENT_SIZE, MAX_FILES_IN_ARCHIVE,
  MAX_NESTED_ZIP_DEPTH, MAX_SINGLE_ENTRY_SIZE, isZipLikeExtension, isZipMagicBytes,
} from './document-guards.ts';
export { decodeXmlEntities, htmlToText, type XmlToken, xmlTokens } from './document-xml.ts';
export {
  MAX_XLSX_CELL_EDITS, MAX_XLSX_CELL_TEXT_BYTES, MAX_XLSX_EDITED_TEXT_BYTES,
  MAX_XLSX_REPLACEMENT_TERM_BYTES, MAX_XLSX_REPLACEMENTS, replaceXlsxTextBounded,
  validateXlsxEdits, validateXlsxReplacements,
} from './xlsx-bounds.ts';

export const PLAIN_TEXT_CODE_EXTENSIONS: readonly string[] = [
  'py', 'pyw', 'ipynb', 'rs', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'java', 'c', 'cpp',
  'cc', 'cxx', 'h', 'hpp', 'hh', 'cs', 'go', 'rb', 'php', 'swift', 'kt', 'kts', 'scala',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'properties', 'env', 'log',
  'tex', 'bib', 'rst', 'adoc',
  'vue', 'svelte', 'astro',
  'lua', 'pl', 'pm', 'r', 'jl', 'dart',
  'gradle', 'cmake', 'makefile', 'mk', 'dockerfile', 'gitignore', 'editorconfig',
  'proto', 'graphql', 'gql', 'prisma', 'sol',
  'asm', 's', 'vb', 'fs', 'fsx', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs', 'hs', 'elm',
  'nim', 'zig',
];

/** `BoundedCursor`（:164）：拒绝写/seek 超过上限的 XLSX 输出。 */
export class BoundedCursor {
  readonly maxLen: number;
  position = 0;
  private readonly chunks: Buffer[] = [];

  constructor(maxLen: number) { this.maxLen = maxLen; }

  writeAll(buf: Uint8Array): void {
    const end = this.position + buf.length;
    if (!Number.isSafeInteger(end)) throw new Error('XLSX output position overflow');
    if (end > this.maxLen) {
      throw new Error(`XLSX output exceeds ${Math.trunc(this.maxLen / (1024 * 1024))}MB limit`);
    }
    this.chunks.push(Buffer.from(buf));
    this.position = end;
  }

  intoInner(): Buffer { return Buffer.concat(this.chunks); }
}

/** ★ 代码/纯文本扩展名（与前端 `ATTACHMENT_CODE_TEXT_EXTENSIONS` 同一清单） */
export function isPlainTextCodeExtension(ext: string): boolean {
  return PLAIN_TEXT_CODE_EXTENSIONS.includes(ext.trim().toLowerCase());
}

function replaceLossyUtf8(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('utf8');
}

function tryDecode(bytes: Uint8Array, encoding: string): string | null {
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { return null; }
}

/** 解码文本字节流：BOM → 严格 UTF-8 → GB18030 → Big5 → Shift_JIS → lossy UTF-8（:2377） */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes);
  }
  const utf8 = tryDecode(bytes, 'utf-8');
  if (utf8 !== null) return utf8;
  for (const encoding of ['gb18030', 'big5', 'shift_jis']) {
    const text = tryDecode(bytes, encoding);
    if (text !== null) return text;
  }
  return replaceLossyUtf8(bytes);
}

/** Rust `Path::extension()` on a file name (leading dot alone is not an extension). */
function pathExtension(fileName: string): string | null {
  const base = fileName.slice(fileName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return base.slice(dot + 1);
}

function extensionFor(fileName: string): string {
  const ext = pathExtension(fileName);
  if (ext !== null) return ext.toLowerCase();
  const fallback = rustTrim(fileName).replace(/^\.+/, '').toLowerCase();
  if (isPlainTextCodeExtension(fallback)) return fallback;
  throw new ParsingError('UnsupportedFormat', '无法确定文件扩展名');
}

export interface DocumentParserOptions {
  /** 对应 Rust `log::warn!`（ZIP 探测失败等诊断）；生产由 `ctx.logger` 注入。 */
  warn?: (message: string) => void;
  /** F7 `nativePdfium`（= `pdfium_utils::load_pdfium` + `extract_text_from_pdf_*`）。 */
  pdfium?: () => NativePdfium | undefined;
  /** F7 `nativeOfficeText`（CSV：编码探测 + csv crate flexible/has_headers）。 */
  officeText?: () => NativeOfficeText | undefined;
  /** F7 `nativeOffice`（docx-rs / pptx-to-md / rtf-parser / calamine / html2text 文本引擎）。 */
  office?: () => NativeOffice | undefined;
  /** F7 `nativeOfficeWriter`（docx-rs / ppt-rs / umya-spreadsheet 生成与 xlsx 读写）。 */
  officeWriter?: () => NativeOfficeWriter | undefined;
}

/** `document_parser.rs` docx spec 文本替换：返回替换后的文本与命中次数。 */
function replaceAllCounting(
  text: string, replacements: ReadonlyArray<readonly [string, string]>,
): [string, number] {
  let current = text;
  let total = 0;
  for (const [find, replace] of replacements) {
    const parts = current.split(find);
    if (parts.length > 1) {
      total += parts.length - 1;
      current = parts.join(replace);
    }
  }
  return [current, total];
}

/**
 * pptx Markdown 表格行（`| a | b |`，至少 5 字节）：分隔行返回 `'separator'`，
 * 否则返回 `trimmed[1..len-1]` 按 `|` 切分并逐格 trim 的单元格。
 */
function pptxTableRow(trimmed: string): string[] | 'separator' | null {
  if (Buffer.byteLength(trimmed, 'utf8') < 5 || !trimmed.startsWith('|') || !trimmed.endsWith('|')) return null;
  const inner = trimmed.slice(1, -1);
  if ([...inner].every(c => c === '-' || c === '|' || c === ':' || c === ' ')) return 'separator';
  return inner.split('|').map(cell => rustTrim(cell));
}

/** Rust `str::trim_start_matches(pattern)`：重复剥离同一前缀。 */
function trimStartMatches(value: string, prefix: string): string {
  let current = value;
  while (current.startsWith(prefix)) current = current.slice(prefix.length);
  return current;
}

/** Rust `str::lines()`：按 `\n` 切分并去掉行尾 `\r`，末尾空行不计。 */
function rustLines(text: string): string[] {
  const lines = text.split('\n').map(line => (line.endsWith('\r') ? line.slice(0, -1) : line));
  if (lines.length > 0 && lines[lines.length - 1] === '' && text.endsWith('\n')) lines.pop();
  if (text === '') return [];
  return lines;
}

/** F7 writer 的错误文案已是 `ParsingError` Display（`Excel解析错误: …`），还原成同一变体。 */
function excelEngineError(error: unknown): ParsingError {
  const message = error instanceof Error ? error.message : String(error);
  const prefix = `${DISPLAY_PREFIX.ExcelParsingError}: `;
  return new ParsingError('ExcelParsingError', message.startsWith(prefix) ? message.slice(prefix.length) : message);
}

/** 引擎缺失时的错误（落在 Rust 对应库调用失败的位置，带同样的前缀）。 */
type EngineUnavailable = (message: string) => ParsingError;

/** xlsx/xlsb/ods 是 ZIP 格式，需要加密和 ZIP Bomb 检测（xls 不做）。 */
const ZIP_EXCEL_EXTENSIONS = ['xlsx', 'xlsb', 'ods'];
/** `docx_rs::read_docx` 失败位置。 */
const docxUnavailable: EngineUnavailable = message => new ParsingError('DocxParsingError', message);
/** `PptxContainer::open` 失败位置。 */
const pptxUnavailable: EngineUnavailable = message => new ParsingError('PptxParsingError', `无法打开PPTX: ${message}`);
/** `RtfLexer::scan` 失败位置。 */
const rtfUnavailable: EngineUnavailable = message => new ParsingError('RtfParsingError', `RTF词法分析失败: ${message}`);
/** `html2text::from_read` 失败位置。 */
const htmlUnavailable: EngineUnavailable = message => new ParsingError('Other', `HTML 转文本失败: ${message}`);

export class DocumentParser {
  readonly #warn: (message: string) => void;
  readonly #pdfium: () => NativePdfium | undefined;
  readonly #officeText: () => NativeOfficeText | undefined;
  readonly #office: () => NativeOffice | undefined;
  readonly #officeWriter: () => NativeOfficeWriter | undefined;

  constructor(options: DocumentParserOptions = {}) {
    this.#warn = options.warn ?? (() => undefined);
    this.#pdfium = options.pdfium ?? (() => undefined);
    this.#officeText = options.officeText ?? (() => undefined);
    this.#office = options.office ?? (() => undefined);
    this.#officeWriter = options.officeWriter ?? (() => undefined);
  }

  /** ★ M-1：检查 PDF 是否加密：头部 4KB、尾部 4KB、大文件中间 8KB 的 `/Encrypt` 标记。 */
  checkPdfEncryption(bytes: Uint8Array, fileName: string): void {
    guards.checkPdfEncryption(bytes, fileName);
  }

  /** 从路径检查 PDF 加密（读取前先检查大小）。 */
  checkPdfEncryptionFromPath(filePath: string): void {
    const size = statSync(filePath).size;
    guards.checkFileSize(size);
    const computed = basename(filePath);
    const fileName = computed === '' ? filePath : computed;
    this.checkPdfEncryption(readFileSync(filePath), fileName);
  }

  /** ★ M-1：检测 Office 文档加密：CFB 魔数、EncryptedPackage、缺失 [Content_Types].xml。 */
  checkOfficeEncryption(bytes: Uint8Array, fileName: string): void {
    guards.checkOfficeEncryption(bytes, fileName);
  }

  /** ★ M-11：检测 ZIP Bomb（文件数量 / 单条目 / 真实解压字节 / 压缩比 / 嵌套）。 */
  checkZipBomb(bytes: Uint8Array, fileName: string): void {
    guards.checkZipBomb(bytes, fileName, this.#warn);
  }

  /** `extract_epub_from_bytes`：章节拼接后 trim。 */
  private extractEpubFromBytes(bytes: Uint8Array): string {
    return rustTrim(this.extractEpubPagesFromBytes(bytes).join('\n\n'));
  }

  /** `extract_epub_pages_from_bytes`：第一页为元信息（标题/作者），其后每个 spine 条目一页。 */
  extractEpubPagesFromBytes(bytes: Uint8Array): string[] {
    return extractEpubPages(bytes, this.#warn);
  }

  /** 在解码分配前按编码长度计算上界（:345） */
  static checkBase64DecodedSize(encoded: string, maxBytes: number): void {
    const encodedLen = Buffer.byteLength(encoded, 'utf8');
    const groups = Math.trunc((encodedLen + 3) / 4);
    let padding = 0;
    for (let i = encoded.length - 1; i >= 0 && padding < 2 && encoded[i] === '='; i--) padding += 1;
    const decodedUpperBound = groups * 3 - padding;
    if (decodedUpperBound > maxBytes) {
      throw new ParsingError('FileTooLarge',
        `Base64 解码后可能达到 ${Math.trunc(decodedUpperBound / (1024 * 1024))}MB，`
        + `超过限制 ${Math.trunc(maxBytes / (1024 * 1024))}MB`);
    }
  }

  /** `extract_txt_from_bytes`（:2406）：多编码解码后再 trim。 */
  private extractTxtFromBytes(bytes: Uint8Array): string {
    return rustTrim(decodeTextBytes(bytes));
  }

  /** `fs::metadata(path)?.len()`：失败映射为 `ParsingError::IoError`。 */
  private async statSize(filePath: string): Promise<number> {
    try { return (await stat(filePath)).size; }
    catch (error) { throw new ParsingError('IoError', (error as Error).message); }
  }

  /** `read_file_safely`（:803）：先按 metadata 检查大小，再读取。 */
  private async readFileSafely(filePath: string): Promise<Uint8Array> {
    guards.checkFileSize(await this.statSize(filePath));
    try { return await readFile(filePath); }
    catch (error) { throw new ParsingError('IoError', (error as Error).message); }
  }

  /** `pdfium_utils::extract_text_from_pdf_*`（:127/:147）：加载失败 → `PDF文档加载失败: …`。 */
  private async pdfText(bytes: Uint8Array): Promise<string> {
    const engine = this.#pdfium();
    if (engine === undefined) {
      // `load_pdfium()` 失败同样映射为 PdfParsingError。
      throw new ParsingError('PdfParsingError', 'Pdfium 未加载：宿主未提供 nativePdfium');
    }
    try { return await engine.extractText(bytes); }
    catch (error) {
      throw new ParsingError('PdfParsingError', `PDF文档加载失败: ${pdfiumErrorDebug(error)}`);
    }
  }

  /** `extract_pdf_from_path`（:2325）：metadata 大小 → 加密检查（读文件）→ 提取 → trim。 */
  private async extractPdfFromPath(filePath: string, fileName: string): Promise<string> {
    guards.checkFileSize(await this.statSize(filePath));
    const bytes = await this.readFileSafely(filePath);
    this.checkPdfEncryption(bytes, fileName);
    return rustTrim(await this.pdfText(bytes));
  }

  /** `extract_pdf_from_bytes`（:2352）：加密检查（固定名 document.pdf）→ 提取 → trim。 */
  private async extractPdfFromBytes(bytes: Uint8Array): Promise<string> {
    this.checkPdfEncryption(bytes, 'document.pdf');
    return rustTrim(await this.pdfText(bytes));
  }

  /** `extract_csv_from_bytes`（:4035）：F7 `nativeOfficeText.extractCsv`（大小检查在前）。 */
  private extractCsvFromBytes(bytes: Uint8Array): string {
    guards.checkFileSize(bytes.length);
    const officeText = this.#officeText();
    if (officeText === undefined) {
      throw new ParsingError('Other', 'CSV 解析不可用：宿主未提供 nativeOfficeText');
    }
    return officeText.extractCsv(bytes);
  }

  /**
   * F7 `nativeOffice.extractText`：引擎错误保持 Rust ParsingError 的变体与文案；
   * 宿主未提供 nativeOffice 时按 `unavailable` 在 Rust 库调用位置报错，绝不空成功。
   * `mapDetail`：同一库在 path 入口的错误前缀不同（Excel `open_workbook_auto(path)`）。
   */
  private async officeExtract(fileName: string, bytes: Uint8Array, unavailable: EngineUnavailable,
    mapDetail: (detail: string) => string = detail => detail): Promise<string> {
    const engine = this.#office();
    if (engine === undefined) throw unavailable('宿主未提供 nativeOffice');
    try { return await engine.extractText(fileName, bytes); }
    catch (error) {
      if (error instanceof OfficeParsingError) throw new ParsingError(error.kind, mapDetail(error.detail));
      throw error;
    }
  }

  /**
   * `extract_paged_text_from_bytes`（:913）：pptx 按幻灯片、epub 按章节；其他格式 `null`。
   * 扩展名只取 `Path::extension()`（无回退）。
   */
  async extractPagedTextFromBytes(fileName: string, bytes: Uint8Array): Promise<string[] | null> {
    const extension = pathExtension(fileName)?.toLowerCase() ?? null;
    if (extension === 'pptx') {
      // `extract_pptx_pages_from_bytes`（:2711）
      guards.checkFileSize(bytes.length);
      this.checkOfficeEncryption(bytes, 'presentation.pptx');
      this.checkZipBomb(bytes, 'presentation.pptx');
      const engine = this.#office();
      if (engine === undefined) throw pptxUnavailable('宿主未提供 nativeOffice');
      try { return await engine.extractPptxPages(bytes); }
      catch (error) {
        if (error instanceof OfficeParsingError) throw new ParsingError(error.kind, error.detail);
        throw error;
      }
    }
    if (extension === 'epub') return this.extractEpubPagesFromBytes(bytes);
    return null;
  }

  /**
   * `extract_text_from_path`（:814）：存在 → 扩展名（无回退）→ 按格式的 path 版本。
   * Office 类检查用真实文件名；Office 解析器接入前在检查之后报不支持。
   */
  async extractTextFromPath(filePath: string): Promise<string> {
    let exists = true;
    try { await stat(filePath); }
    catch { exists = false; }
    if (!exists) throw new ParsingError('FileNotFound', filePath);
    const computed = basename(filePath);
    const raw = pathExtension(computed);
    if (raw === null) throw new ParsingError('UnsupportedFormat', '无法确定文件扩展名');
    const extension = raw.toLowerCase();
    // `path.file_name().and_then(to_str).unwrap_or(file_path)`
    const fileName = computed === '' ? filePath : computed;
    switch (extension) {
      case 'docx': {
        // `extract_docx_from_path`（:960）
        const bytes = await this.readFileSafely(filePath);
        this.checkOfficeEncryption(bytes, fileName);
        this.checkZipBomb(bytes, fileName);
        return this.officeExtract(fileName, bytes, docxUnavailable);
      }
      case 'pdf':
        return this.extractPdfFromPath(filePath, fileName);
      case 'txt':
      case 'md':
      case 'markdown':
        return this.extractTxtFromBytes(await this.readFileSafely(filePath));
      case 'html':
      case 'htm':
        // `extract_html_from_path` → `extract_html_from_bytes`
        return this.officeExtract(fileName, await this.readFileSafely(filePath), htmlUnavailable);
      case 'rtf':
        // `extract_rtf_from_path` → `extract_rtf_from_bytes`
        return this.officeExtract(fileName, await this.readFileSafely(filePath), rtfUnavailable);
      case 'xlsx':
      case 'xls':
      case 'xlsb':
      case 'ods': {
        // `extract_excel_from_path`（:2445）；calamine 打开失败前缀为「无法打开Excel文件」。
        guards.checkFileSize(await this.statSize(filePath));
        const bytes = await this.readFileSafely(filePath);
        if (ZIP_EXCEL_EXTENSIONS.includes(extension)) {
          this.checkOfficeEncryption(bytes, fileName);
          this.checkZipBomb(bytes, fileName);
        }
        // `open_workbook_auto(path)` 失败：`无法打开Excel文件: {e}`
        return this.officeExtract(fileName, bytes,
          message => new ParsingError('ExcelParsingError', `无法打开Excel文件: ${message}`),
          detail => (detail.startsWith('无法解析Excel数据: ')
            ? `无法打开Excel文件: ${detail.slice('无法解析Excel数据: '.length)}` : detail));
      }
      case 'pptx': {
        // `extract_pptx_from_path`（:2640）
        guards.checkFileSize(await this.statSize(filePath));
        const bytes = await this.readFileSafely(filePath);
        this.checkOfficeEncryption(bytes, fileName);
        this.checkZipBomb(bytes, fileName);
        // pptx-to-md 从路径打开；F7 只有字节入口，结果按 bytes 版拼接（见 SPEC 差异说明）。
        return this.officeExtract(fileName, bytes, pptxUnavailable);
      }
      case 'epub':
        return this.extractEpubFromBytes(await this.readFileSafely(filePath));
      case 'csv':
      case 'json':
      case 'xml':
        return this.extractTextFromBytes(fileName, await this.readFileSafely(filePath));
      default:
        if (isPlainTextCodeExtension(extension)) {
          return this.extractTxtFromBytes(await this.readFileSafely(filePath));
        }
        throw new ParsingError('UnsupportedFormat', `不支持的文件格式: .${extension}`);
    }
  }

  /**
   * `extract_text_from_bytes`（:859）。Office 类检查用固定文件名（document.docx /
   * presentation.pptx），Excel 用调用方文件名；Office 解析器接入前在检查之后报不支持。
   */
  async extractTextFromBytes(fileName: string, bytes: Uint8Array): Promise<string> {
    guards.checkFileSize(bytes.length);
    const extension = extensionFor(fileName);
    switch (extension) {
      case 'docx':
        // `extract_docx_from_bytes`（:976）
        this.checkOfficeEncryption(bytes, 'document.docx');
        this.checkZipBomb(bytes, 'document.docx');
        return this.officeExtract('document.docx', bytes, docxUnavailable);
      case 'pdf':
        return this.extractPdfFromBytes(bytes);
      case 'txt':
      case 'md':
      case 'markdown':
        return this.extractTxtFromBytes(bytes);
      case 'html':
      case 'htm':
        return this.officeExtract(fileName, bytes, htmlUnavailable);
      case 'rtf':
        return this.officeExtract(fileName, bytes, rtfUnavailable);
      case 'xlsx':
      case 'xls':
      case 'xlsb':
      case 'ods':
        // `extract_excel_from_bytes`（:2479）；calamine 解析失败前缀为「无法解析Excel数据」。
        if (ZIP_EXCEL_EXTENSIONS.includes(extension)) {
          this.checkOfficeEncryption(bytes, fileName);
          this.checkZipBomb(bytes, fileName);
        }
        // `open_workbook_auto_from_rs(cursor)` 失败：`无法解析Excel数据: {e}`
        return this.officeExtract(fileName, bytes,
          message => new ParsingError('ExcelParsingError', `无法解析Excel数据: ${message}`));
      case 'pptx':
        // `extract_pptx_from_bytes`（:2683）
        guards.checkFileSize(bytes.length);
        this.checkOfficeEncryption(bytes, 'presentation.pptx');
        this.checkZipBomb(bytes, 'presentation.pptx');
        return this.officeExtract('presentation.pptx', bytes, pptxUnavailable);
      case 'epub':
        return this.extractEpubFromBytes(bytes);
      case 'csv':
        return this.extractCsvFromBytes(bytes);
      case 'json':
        // `extract_json_from_bytes`（:4075）
        guards.checkFileSize(bytes.length);
        return extractJsonText(bytes);
      case 'xml':
        // `extract_xml_from_bytes`（:4098）
        guards.checkFileSize(bytes.length);
        return extractXmlText(bytes, this.#warn);
      default:
        if (isPlainTextCodeExtension(extension)) return this.extractTxtFromBytes(bytes);
        throw new ParsingError('UnsupportedFormat', `不支持的文件格式: .${extension}`);
    }
  }

  /** Office 包读取三道门禁：大小 / 加密 / ZIP Bomb（Rust 各方法体首部）。 */
  private checkOfficePackage(bytes: Uint8Array, fileName: string): void {
    guards.checkFileSize(bytes.length);
    this.checkOfficeEncryption(bytes, fileName);
    this.checkZipBomb(bytes, fileName);
  }

  private officeEngine(unavailable: EngineUnavailable): NativeOffice {
    const engine = this.#office();
    if (engine === undefined) throw unavailable('宿主未提供 nativeOffice');
    return engine;
  }

  private officeWriterEngine(unavailable: EngineUnavailable): NativeOfficeWriter {
    const engine = this.#officeWriter();
    if (engine === undefined) throw unavailable('宿主未提供 nativeOfficeWriter');
    return engine;
  }

  private async officeCall<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) {
      if (error instanceof OfficeParsingError) throw new ParsingError(error.kind, error.detail);
      throw error;
    }
  }

  private async excelCall<T>(run: () => Promise<T>): Promise<T> {
    try { return await run(); }
    catch (error) { throw excelEngineError(error); }
  }

  /** `extract_docx_structured`（:1601）：富 Markdown。 */
  async extractDocxStructured(bytes: Uint8Array): Promise<string> {
    this.checkOfficePackage(bytes, 'document.docx');
    const engine = this.officeEngine(docxUnavailable);
    return this.officeCall(() => engine.extractDocxStructured(bytes));
  }

  /** `extract_docx_tables`（:1838）。 */
  async extractDocxTables(bytes: Uint8Array): Promise<string[][][]> {
    this.checkOfficePackage(bytes, 'document.docx');
    const engine = this.officeEngine(docxUnavailable);
    return this.officeCall(() => engine.extractDocxTables(bytes));
  }

  /** `extract_docx_metadata`（:1882）。 */
  async extractDocxMetadata(bytes: Uint8Array): Promise<DocxMetadata> {
    this.checkOfficePackage(bytes, 'document.docx');
    const engine = this.officeEngine(docxUnavailable);
    return this.officeCall(() => engine.extractDocxMetadata(bytes));
  }

  /** `extract_docx_as_spec`（:1914）。 */
  async extractDocxAsSpec(bytes: Uint8Array): Promise<DocxSpec> {
    this.checkOfficePackage(bytes, 'document.docx');
    const engine = this.officeEngine(docxUnavailable);
    return this.officeCall(() => engine.extractDocxAsSpec(bytes));
  }

  /** `generate_docx_from_spec`（:2151）。 */
  async generateDocxFromSpec(spec: unknown): Promise<Uint8Array> {
    const writer = this.officeWriterEngine(docxUnavailable);
    return this.officeCall(() => writer.generateDocx(spec));
  }

  /**
   * `replace_text_in_docx`（:2045）：spec round-trip。空查找串被过滤；没有有效替换对
   * 时仍重新生成并返回 0。替换覆盖 blocks 的 `text`、表格 `rows` 与顶层 `title`。
   */
  async replaceTextInDocx(
    bytes: Uint8Array,
    replacements: ReadonlyArray<readonly [string, string]>,
  ): Promise<[Uint8Array, number]> {
    const spec = await this.extractDocxAsSpec(bytes) as unknown as Record<string, unknown>;
    const active = replacements.filter(([find]) => find !== '');
    if (active.length === 0) return [await this.generateDocxFromSpec(spec), 0];
    let total = 0;
    const blocks = spec.blocks;
    if (Array.isArray(blocks)) {
      for (const block of blocks as Array<Record<string, unknown>>) {
        if (block === null || typeof block !== 'object') continue;
        if (typeof block.text === 'string') {
          const [next, count] = replaceAllCounting(block.text, active);
          total += count;
          if (next !== block.text) block.text = next;
        }
        if (Array.isArray(block.rows)) {
          for (const row of block.rows as unknown[]) {
            if (!Array.isArray(row)) continue;
            row.forEach((cell: unknown, index: number) => {
              if (typeof cell !== 'string') return;
              const [next, count] = replaceAllCounting(cell, active);
              total += count;
              if (next !== cell) row[index] = next;
            });
          }
        }
      }
    }
    if (typeof spec.title === 'string') {
      const [next, count] = replaceAllCounting(spec.title, active);
      total += count;
      if (next !== spec.title) spec.title = next;
    }
    return [await this.generateDocxFromSpec(spec), total];
  }

  /** `extract_pptx_from_bytes`（:2683）：门禁 + pptx-to-md Markdown。 */
  private async extractPptxMarkdown(bytes: Uint8Array): Promise<string> {
    this.checkOfficePackage(bytes, 'presentation.pptx');
    return this.officeExtract('presentation.pptx', bytes, pptxUnavailable);
  }

  /** `generate_pptx_from_spec`（:2773）。 */
  async generatePptxFromSpec(spec: unknown): Promise<Uint8Array> {
    const writer = this.officeWriterEngine(pptxUnavailable);
    return this.officeCall(() => writer.generatePptx(spec));
  }

  /**
   * `extract_pptx_as_spec`（:2896）：按 `#`/`##` 切幻灯片；首个表格行作表头；
   * 同页要点+表格拆成 content + table 两页；首页仅一行时视为 title 页。
   */
  async extractPptxAsSpec(bytes: Uint8Array): Promise<Record<string, unknown>> {
    const markdown = await this.extractPptxMarkdown(bytes);
    const slides: Array<Record<string, unknown>> = [];
    let title = '';
    let bullets: string[] = [];
    let headers: string[] = [];
    let rows: string[][] = [];
    let inTable = false;
    const flush = (): void => {
      if (title === '' && bullets.length === 0 && headers.length === 0) return;
      const hasTable = headers.length > 0 || rows.length > 0;
      const hasBullets = bullets.length > 0;
      if (hasTable && hasBullets) {
        slides.push({ type: 'content', title, bullets });
        slides.push({ type: 'table', title: `${title} - 表格`, headers, rows });
      } else if (hasTable) {
        slides.push({ type: 'table', title, headers, rows });
      } else if (!hasBullets) {
        slides.push({ type: 'blank', title });
      } else if (slides.length === 0 && bullets.length === 1) {
        slides.push({ type: 'title', title, subtitle: bullets[0] });
      } else {
        slides.push({ type: 'content', title, bullets });
      }
    };
    for (const line of rustLines(markdown)) {
      const trimmed = rustTrim(line);
      const row = pptxTableRow(trimmed);
      if (row === 'separator') continue;
      if (row !== null) {
        if (!inTable) {
          inTable = true;
          headers = row;
        } else {
          rows.push(row);
        }
        continue;
      }
      if (inTable && trimmed !== '' && !trimmed.startsWith('#')) inTable = false;
      if (trimmed === '') continue;
      if (trimmed.startsWith('# ') || trimmed.startsWith('## ')) {
        flush();
        title = rustTrim(trimmed.replace(/^#+/, ''));
        bullets = [];
        headers = [];
        rows = [];
        inTable = false;
      } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ') || trimmed.startsWith('• ')) {
        bullets.push(trimStartMatches(trimStartMatches(trimStartMatches(trimmed, '- '), '* '), '• '));
      } else if (!inTable) {
        bullets.push(trimmed);
      }
    }
    flush();
    const first = slides[0]?.title;
    return { title: typeof first === 'string' ? first : 'Presentation', slides };
  }

  /** `extract_pptx_metadata`（:3046）。 */
  async extractPptxMetadata(bytes: Uint8Array): Promise<PptxMetadata> {
    this.checkOfficePackage(bytes, 'presentation.pptx');
    const engine = this.officeEngine(pptxUnavailable);
    return this.officeCall(() => engine.extractPptxMetadata(bytes));
  }

  /** `extract_pptx_tables`（:3081）：表格遇空行/非表格行或新幻灯片即结束。 */
  async extractPptxTables(bytes: Uint8Array): Promise<Array<Record<string, unknown>>> {
    const markdown = await this.extractPptxMarkdown(bytes);
    const tables: Array<Record<string, unknown>> = [];
    let slideTitle = '';
    let headers: string[] = [];
    let rows: string[][] = [];
    let inTable = false;
    const flush = (): void => {
      if (headers.length === 0 && rows.length === 0) return;
      tables.push({
        slide_title: slideTitle,
        headers,
        rows,
        row_count: rows.length,
        col_count: Math.max(headers.length, rows[0]?.length ?? 0),
      });
    };
    for (const line of rustLines(markdown)) {
      const trimmed = rustTrim(line);
      if (trimmed.startsWith('# ') || trimmed.startsWith('## ')) {
        flush();
        slideTitle = rustTrim(trimmed.replace(/^#+/, ''));
        headers = [];
        rows = [];
        inTable = false;
        continue;
      }
      const row = pptxTableRow(trimmed);
      if (row === 'separator') continue;
      if (row !== null) {
        if (!inTable) {
          inTable = true;
          headers = row;
        } else {
          rows.push(row);
        }
      } else if (inTable && (trimmed === '' || !trimmed.startsWith('|'))) {
        flush();
        headers = [];
        rows = [];
        inTable = false;
      }
    }
    flush();
    return tables;
  }

  /** `generate_xlsx_from_spec`（:3229）。 */
  async generateXlsxFromSpec(spec: unknown): Promise<Uint8Array> {
    const writer = this.officeWriterEngine(message => new ParsingError('ExcelParsingError', message));
    return this.excelCall(() => writer.generateXlsx(spec));
  }

  /** `extract_xlsx_as_spec`（:3383）。 */
  async extractXlsxAsSpec(bytes: Uint8Array): Promise<XlsxSpec> {
    this.checkOfficePackage(bytes, 'spreadsheet.xlsx');
    const writer = this.officeWriterEngine(message => new ParsingError('ExcelParsingError', message));
    return this.excelCall(() => writer.readXlsxSpec(bytes));
  }

  /** `extract_xlsx_tables`（:3668）。 */
  async extractXlsxTables(bytes: Uint8Array): Promise<XlsxTable[]> {
    this.checkOfficePackage(bytes, 'spreadsheet.xlsx');
    const writer = this.officeWriterEngine(message => new ParsingError('ExcelParsingError', message));
    return this.excelCall(() => writer.readXlsxTables(bytes));
  }

  /** `extract_xlsx_metadata`（:3719）。 */
  async extractXlsxMetadata(bytes: Uint8Array): Promise<XlsxMetadata> {
    this.checkOfficePackage(bytes, 'spreadsheet.xlsx');
    const writer = this.officeWriterEngine(message => new ParsingError('ExcelParsingError', message));
    return this.excelCall(() => writer.readXlsxMetadata(bytes));
  }

  /**
   * `edit_xlsx_cells`（:3559）：门禁与编辑参数校验先于读取工作簿；F7 umya 兼容写入器
   * 完成编辑，不存在的工作表跳过并告警。返回 `[新字节, 实际编辑数]`。
   */
  async editXlsxCells(
    bytes: Uint8Array,
    edits: ReadonlyArray<readonly [string, string, string]>,
  ): Promise<[Uint8Array, number]> {
    this.checkOfficePackage(bytes, 'spreadsheet.xlsx');
    validateXlsxEdits(edits);
    const writer = this.officeWriterEngine(message => new ParsingError('ExcelParsingError', message));
    const result = await this.excelCall(() => writer.editXlsxCells(bytes, edits));
    return [result.bytes, result.editCount];
  }

  /**
   * `replace_text_in_xlsx`（:3602）：空查找串等参数错误在读取工作簿之前就被拒绝。
   * 返回 `[新字节, 被修改的单元格数]`。
   */
  async replaceTextInXlsx(
    bytes: Uint8Array,
    replacements: ReadonlyArray<readonly [string, string]>,
  ): Promise<[Uint8Array, number]> {
    this.checkOfficePackage(bytes, 'spreadsheet.xlsx');
    validateXlsxReplacements(replacements);
    const writer = this.officeWriterEngine(message => new ParsingError('ExcelParsingError', message));
    const result = await this.excelCall(() => writer.replaceXlsxText(bytes, replacements));
    return [result.bytes, result.replacementCount];
  }

  /**
   * `extract_docx_with_images`（:998）：加密检查 → ZIP Bomb 检查 → rId 图片表 →
   * docx-rs 文档遍历。文本中 `<<IMG:N>>` 对应 `images[N]`。
   */
  extractDocxWithImages(bytes: Uint8Array): DocxTextWithImages {
    this.checkOfficeEncryption(bytes, 'document.docx');
    this.checkZipBomb(bytes, 'document.docx');
    return extractDocxWithImagesUnchecked(bytes);
  }

  /** `extract_text_from_base64`（:933）：Data URL、解码上界、STANDARD 解码。 */
  async extractTextFromBase64(fileName: string, base64Content: string): Promise<string> {
    let base64Str = base64Content;
    if (base64Content.startsWith('data:')) {
      const comma = base64Content.indexOf(',');
      if (comma < 0) {
        throw new ParsingError('Base64DecodingError',
          'Invalid data URL format: missing base64 content after comma');
      }
      base64Str = base64Content.slice(comma + 1);
    }
    DocumentParser.checkBase64DecodedSize(base64Str, MAX_DOCUMENT_SIZE);
    let bytes: Uint8Array;
    try { bytes = decodeBase64Standard(base64Str); }
    catch (error) {
      const message = error instanceof Base64DecodeError ? error.message : String(error);
      throw new ParsingError('Base64DecodingError', message);
    }
    return this.extractTextFromBytes(fileName, bytes);
  }
}

const PDFIUM_INTERNAL_ERRORS: Readonly<Record<number, string>> = {
  1: 'Unknown', 2: 'FileError', 3: 'FormatError', 4: 'PasswordError', 5: 'SecurityError', 6: 'PageError',
};

/**
 * `{:?}` of the pdfium-render load error (pdfium.rs:520-543): F7 reports the `FPDF_GetLastError` code on
 * `PdfiumError.code`; any other code (including 0) is `PdfiumInternalError::Unknown`.
 */
function pdfiumErrorDebug(error: unknown): string {
  if (error instanceof Error && error.name === 'PdfiumError') {
    const code = (error as Error & { code?: unknown }).code;
    if (typeof code === 'number') return `PdfiumLibraryInternalError(${PDFIUM_INTERNAL_ERRORS[code] ?? 'Unknown'})`;
  }
  return error instanceof Error ? error.message : String(error);
}
