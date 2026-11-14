/**
 * `nativeOffice`: the binary/markup text engines behind
 * `DocumentParser::extract_text_from_bytes` (document_parser.rs:859-910), run from the
 * same Rust crates (docx-rs 0.4.19, calamine 0.26.1, pptx-to-md 0.2.0, rtf-parser 0.3.0,
 * html2text 0.16.7) compiled into the prebuilt F7 WASI module (`office` engine).
 * Container gates (file size, encryption, ZIP bomb) stay with the L18 caller,
 * exactly as Rust runs them before the `*_internal` engines.
 */
import {
  OfficeParsingError, type DocxMetadata, type DocxSpec, type NativeOffice, type OfficeFormat, type OfficeParsingErrorKind,
  type PptxMetadata,
} from './api.ts';
import { removeRun, runWasm } from '../wasm/loader.ts';

/** Rust `Path::extension()` (last `.` of the final component, not a leading dot), lowercased. */
export function rustPathExtension(fileName: string): string | null {
  const name = fileName.replace(/\/+$/u, '').split('/').pop() ?? '';
  if (name === '' || name === '..') return null;
  const dot = name.lastIndexOf('.');
  return dot <= 0 ? null : name.slice(dot + 1).toLowerCase();
}

const FORMAT_BY_EXTENSION: Readonly<Record<string, OfficeFormat>> = {
  docx: 'docx', rtf: 'rtf', pptx: 'pptx', html: 'html', htm: 'html', xlsx: 'xlsx', xls: 'xls', xlsb: 'xlsb', ods: 'ods',
};
/** Engine request format: the four spreadsheet extensions share `open_workbook_auto_from_rs`. */
const ENGINE_FORMAT: Readonly<Record<OfficeFormat, string>> = {
  docx: 'docx', rtf: 'rtf', pptx: 'pptx', html: 'html', xlsx: 'excel', xls: 'excel', xlsb: 'excel', ods: 'excel',
};
const KINDS = new Set<OfficeParsingErrorKind>(['IoError', 'DocxParsingError', 'PptxParsingError', 'RtfParsingError', 'ExcelParsingError', 'Other']);

interface OfficeResponse { ok?: boolean; text?: unknown; pages?: unknown; value?: unknown; kind?: unknown; detail?: unknown }

type OfficeOp = 'extract_text' | 'pptx_pages' | 'pptx_metadata' | 'docx_structured' | 'docx_tables' | 'docx_metadata' | 'docx_as_spec';

async function invoke(op: OfficeOp, format: string, bytes: Uint8Array): Promise<OfficeResponse> {
  const run = await runWasm({ engine: 'office', op, format, input: '/out/input' }, { files: { input: bytes } });
  try {
    const response = run.response as OfficeResponse;
    if (response.ok === true) return response;
    const kind = response.kind as OfficeParsingErrorKind;
    if (!KINDS.has(kind) || typeof response.detail !== 'string') throw new Error(`office engine returned an invalid response: ${JSON.stringify(response)}`);
    throw new OfficeParsingError(kind, response.detail);
  } finally {
    await removeRun(run);
  }
}

export const office: NativeOffice = {
  formats: Object.keys(ENGINE_FORMAT) as OfficeFormat[],
  async extractText(fileName, bytes) {
    const extension = rustPathExtension(fileName);
    const format = extension === null ? undefined : FORMAT_BY_EXTENSION[extension];
    if (format === undefined) {
      throw new OfficeParsingError('UnsupportedFormat', extension === null ? '无法确定文件扩展名' : `不支持的文件格式: .${extension}`);
    }
    const response = await invoke('extract_text', ENGINE_FORMAT[format], bytes);
    if (typeof response.text !== 'string') throw new Error('office engine returned no text');
    return response.text;
  },
  async extractPptxPages(bytes) {
    const response = await invoke('pptx_pages', 'pptx', bytes);
    if (!Array.isArray(response.pages) || !response.pages.every(page => typeof page === 'string')) {
      throw new Error('office engine returned no pages');
    }
    return response.pages as string[];
  },
  async extractDocxStructured(bytes) {
    return structuredValue<string>('docx_structured', 'docx', bytes, value => typeof value === 'string');
  },
  async extractDocxTables(bytes) {
    return structuredValue<string[][][]>('docx_tables', 'docx', bytes, Array.isArray);
  },
  async extractDocxMetadata(bytes) {
    return structuredValue<DocxMetadata>('docx_metadata', 'docx', bytes, isObject);
  },
  async extractDocxAsSpec(bytes) {
    return structuredValue<DocxSpec>('docx_as_spec', 'docx', bytes, isObject);
  },
  async extractPptxMetadata(bytes) {
    return structuredValue<PptxMetadata>('pptx_metadata', 'pptx', bytes, isObject);
  },
};

function isObject(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function structuredValue<T>(op: OfficeOp, format: string, bytes: Uint8Array, valid: (value: unknown) => boolean): Promise<T> {
  const response = await invoke(op, format, bytes);
  if (!valid(response.value)) throw new Error(`office engine returned no ${op} value`);
  return response.value as T;
}
