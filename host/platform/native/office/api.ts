/** Binary/markup formats with a dedicated engine; csv/txt/md/json/xml use `nativeOfficeText`. */
export type OfficeFormat = 'docx' | 'xlsx' | 'xls' | 'xlsb' | 'ods' | 'pptx' | 'rtf' | 'html';
/**
 * Text extraction only (`DocumentParser::extract_text_from_bytes` engines, run from the same Rust
 * crates compiled to WASI); document editing, command ownership and the size/encryption/ZIP-bomb
 * gates stay with L18 and run first.
 */
export interface NativeOffice {
  /** Formats with an engine (all eight). */
  readonly formats: readonly OfficeFormat[];
  /**
   * Engine chosen by Rust `Path::extension()` (lowercased); xlsx/xls/xlsb/ods all go through
   * calamine `open_workbook_auto_from_rs`. Errors are `OfficeParsingError` whose `message` is the
   * Rust `ParsingError` Display text (e.g. `DOCX解析错误: Failed to read xml.`).
   */
  extractText(fileName: string, bytes: Uint8Array): Promise<string>;
  /**
   * `extract_paged_text_from_bytes` for pptx: one trimmed Markdown page per slide (empty pages kept so
   * slide numbers stay aligned). Same gates as `extractText` must run first.
   */
  extractPptxPages(bytes: Uint8Array): Promise<string[]>;
  /**
   * `extract_docx_structured` (document_parser.rs:1601): rich Markdown (headings, lists, links,
   * bold/italic/strike runs, `![图片](embedded-image)`, tables, TOC). Gates run first in L18.
   */
  extractDocxStructured(bytes: Uint8Array): Promise<string>;
  /** `extract_docx_tables` (:1838): top-level tables -> rows -> trimmed, space-joined cell text. */
  extractDocxTables(bytes: Uint8Array): Promise<string[][][]>;
  /** `extract_docx_metadata` (:1882): core properties, missing values as `""`. */
  extractDocxMetadata(bytes: Uint8Array): Promise<DocxMetadata>;
  /** `extract_docx_as_spec` (:1914): the JSON spec consumed by the DOCX generator. */
  extractDocxAsSpec(bytes: Uint8Array): Promise<DocxSpec>;
  /** `extract_pptx_metadata` (:3046): `total_text_length` is the UTF-8 byte sum of untrimmed slide Markdown. */
  extractPptxMetadata(bytes: Uint8Array): Promise<PptxMetadata>;
}
/** Keys exactly as Rust `json!` emits them. */
export interface DocxMetadata {
  title: string; subject: string; creator: string; description: string;
  lastModifiedBy: string; created: string; modified: string;
}
export type DocxSpecBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string; bold: boolean; italic: boolean }
  | { type: 'table'; rows: string[][] };
export interface DocxSpec { title: string; blocks: DocxSpecBlock[]; block_count: number }
export interface PptxMetadata { slide_count: number; total_text_length: number; format: 'pptx' }
/** `dstu_docs::document_parser::ParsingError` variants produced by the engines. */
export type OfficeParsingErrorKind = 'UnsupportedFormat' | 'IoError' | 'DocxParsingError' | 'PptxParsingError' | 'RtfParsingError' | 'ExcelParsingError' | 'Other';
const PARSING_ERROR_PREFIX: Readonly<Record<OfficeParsingErrorKind, string>> = {
  UnsupportedFormat: '不支持的文件格式', IoError: 'IO错误', DocxParsingError: 'DOCX解析错误', PptxParsingError: 'PPTX解析错误',
  RtfParsingError: 'RTF解析错误', ExcelParsingError: 'Excel解析错误', Other: '其他错误',
};
export class OfficeParsingError extends Error {
  readonly kind: OfficeParsingErrorKind;
  /** The variant payload (`ParsingError::X(detail)`). */
  readonly detail: string;
  constructor(kind: OfficeParsingErrorKind, detail: string) {
    super(`${PARSING_ERROR_PREFIX[kind]}: ${detail}`);
    this.name = 'OfficeParsingError';
    this.kind = kind;
    this.detail = detail;
  }
}
/** Complete plain-text/CSV extraction; separately injectable from binary Office engines. */
export interface NativeOfficeText {
  decodeTextBytes(bytes: Uint8Array): string;
  extractPlainText(bytes: Uint8Array): string;
  extractCsv(bytes: Uint8Array): string;
}
/** OOXML generation; VFS delivery and edit fidelity gates remain in L18. */
export interface NativeOfficeWriter {
  generateDocx(spec: unknown): Promise<Uint8Array>;
  generatePptx(spec: unknown): Promise<Uint8Array>;
  generateXlsx(spec: unknown): Promise<Uint8Array>;
  /** Caller must run L18's file-size/encryption/ZIP-bomb and fidelity gates first. */
  editXlsxCells(bytes: Uint8Array, edits: readonly (readonly [string, string, string])[]): Promise<{ bytes: Uint8Array; editCount: number }>;
  /** All byte-reading codec methods require the same L18 container/fidelity preflight. */
  readXlsxSpec(bytes: Uint8Array): Promise<XlsxSpec>;
  readXlsxTables(bytes: Uint8Array): Promise<XlsxTable[]>;
  readXlsxMetadata(bytes: Uint8Array): Promise<XlsxMetadata>;
  replaceXlsxText(bytes: Uint8Array, replacements: readonly (readonly [string, string])[]): Promise<{ bytes: Uint8Array; replacementCount: number }>;
}
export interface XlsxSpec { sheets: Array<{ name: string; headers: string[]; rows: string[][] }> }
export interface XlsxTable { sheet_name: string; row_count: number; col_count: number; rows: string[][] }
export interface XlsxMetadata {
  sheet_count: number; total_rows: number; total_cols: number; format: 'xlsx';
  sheets: Array<{ name: string; row_count: number; col_count: number }>;
}
export { parseCsvRecords } from './text.ts';
declare module '@deepseek-ai/cordis' {
  interface Context { nativeOffice: NativeOffice; nativeOfficeText: NativeOfficeText; nativeOfficeWriter: NativeOfficeWriter }
}
