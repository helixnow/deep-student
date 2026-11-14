/**
 * `dstu-docs/src/document_parser.rs:998-1446` `extract_docx_with_images`.
 *
 * The Rust implementation reads the package with docx-rs 0.4.19 (`read_docx`) and
 * walks `document.children`. This module reproduces the subset of the docx-rs
 * reader that the extraction observes:
 *
 * - element dispatch is by XML local name (`XMLElement::from_str(&name.local_name)`),
 *   except inside `w:r`, where docx-rs only reacts to the literal `w:` / `mc:` / `v:`
 *   prefixes (`reader/run.rs`);
 * - unknown elements are descended into, so runs under `w:smartTag`, `w:fldSimple`,
 *   `w:customXml`, an in-paragraph `w:sdt`, etc. are still read;
 * - `w:sdt` at body/cell level, `w:sectPr`, property blocks, `mc:Fallback`, `v:shape`
 *   and `wps:txbx` are consumed by their own readers and contribute no text;
 * - a drawing's last `pic:pic` (or text box) wins (`Drawing::pic`/`text_box`);
 * - text is xml-rs-decoded and then passed through `replace_escaped`.
 *
 * Known reader differences (documented in SPEC.md): docx-rs also parses styles,
 * numbering, comments, headers and attribute values (`?` on malformed integers);
 * those failure paths are not reproduced, only the package/document ones below.
 */
import { rustTrim } from '../../../platform/util/portable.ts';
import { ParsingError } from './document-errors.ts';
import { type XmlToken, xmlTokens } from './document-xml.ts';
import { zipDirectory, zipEntryData, type ZipDirectoryEntry } from './zip.ts';

export const MAX_DOCX_IMAGE_RELATIONSHIPS = 512;
export const MAX_DOCX_IMAGE_REFERENCES = 2_048;
export const MAX_DOCX_TOTAL_IMAGE_BYTES = 200 * 1024 * 1024;
export const MAX_DOCX_RELS_BYTES = 4 * 1024 * 1024;
export const MAX_DOCX_TEXT_BYTES = 16 * 1024 * 1024;
const MAX_SINGLE_ENTRY_SIZE = 100 * 1024 * 1024;

const DOC_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

export interface DocxTextWithImages {
  /** Text with `<<IMG:N>>` markers; `images[N]` holds the N-th image bytes. */
  text: string;
  images: Uint8Array[];
}

/** docx-rs `escape::replace_escaped`, applied after xml-rs entity decoding. */
export function replaceEscaped(text: string): string {
  return text.replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&apos;', "'")
    .replaceAll('&nbsp;', ' ');
}

const byteLen = (value: string): number => Buffer.byteLength(value, 'utf8');
const mb = (bytes: number): number => Math.trunc(bytes / (1024 * 1024));

// ------------------------------------------------------------------ docx-rs model subset

type RunChild =
  | { kind: 'text'; text: string }
  | { kind: 'deleteText'; text: string }
  | { kind: 'tab' }
  | { kind: 'break' }
  | { kind: 'drawingPic'; id: string };

interface Run { children: RunChild[] }

type ParagraphChild =
  | { kind: 'run'; run: Run }
  | { kind: 'hyperlink'; runs: Run[] }
  | { kind: 'insert'; runs: Run[] }
  | { kind: 'delete'; runs: Run[] };

interface Paragraph { children: ParagraphChild[] }
interface TableCell { paragraphs: Paragraph[] }
interface TableRow { cells: TableCell[] }
interface Table { rows: TableRow[] }

type DocumentChild = { kind: 'paragraph'; p: Paragraph } | { kind: 'table'; t: Table };

class Reader {
  private index = 0;
  private readonly tokens: readonly XmlToken[];
  constructor(tokens: readonly XmlToken[]) { this.tokens = tokens; }
  next(): XmlToken | null { return this.index < this.tokens.length ? this.tokens[this.index++]! : null; }
}

function prefixOf(token: XmlToken): string | null {
  const name = token.qname ?? '';
  const colon = name.indexOf(':');
  return colon >= 0 ? name.slice(0, colon) : null;
}

/** Consume through the end of the element whose start was just read (depth aware). */
function skipElement(r: Reader, local: string): void {
  let depth = 1;
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'start' && t.local === local) depth += 1;
    else if (t.kind === 'end' && t.local === local) {
      depth -= 1;
      if (depth === 0) return;
    }
  }
  throw xmlReadError();
}

/** docx-rs `ignore::ignore_element`: skip to the first matching end tag. */
function ignoreUntilEnd(r: Reader, local: string): void {
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'end' && t.local === local) return;
  }
}

function xmlReadError(): ParsingError {
  return new ParsingError('DocxParsingError', 'Failed to read xml.');
}

/** `reader/pic.rs`: the last `a:blip/@embed` is the relationship id. */
function readPic(r: Reader): string {
  let id = '';
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'start' && t.local === 'blip' && t.attrs.embed !== undefined) id = t.attrs.embed;
    else if (t.kind === 'end' && t.local === 'pic') return id;
  }
  throw xmlReadError();
}

/** `reader/drawing.rs`: returns the pic id when the final drawing data is a picture. */
function readDrawing(r: Reader): { id: string } | null {
  let data: { id: string } | null = null;
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'start') {
      if (t.local === 'positionH' || t.local === 'positionV') { skipElement(r, t.local); continue; }
      if (t.local === 'pic') { data = { id: readPic(r) }; continue; }
      if (t.local === 'txbx') { skipElement(r, 'txbx'); data = null; continue; }
    } else if (t.kind === 'end' && t.local === 'drawing') {
      return data;
    }
  }
  throw xmlReadError();
}

/** `reader/run.rs`. */
function readRun(r: Reader): Run {
  const run: Run = { children: [] };
  let state: 'idle' | 'text' | 'delete' = 'idle';
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'start') {
      const prefix = prefixOf(t);
      if (prefix === 'w') {
        switch (t.local) {
          case 'rPrChange': ignoreUntilEnd(r, 'rPrChange'); break;
          case 'tab': run.children.push({ kind: 'tab' }); break;
          case 'ptab': skipElement(r, 'ptab'); break;
          case 'rPr': skipElement(r, 'rPr'); break;
          case 't': state = 'text'; break;
          case 'delText': state = 'delete'; break;
          case 'br': run.children.push({ kind: 'break' }); break;
          case 'drawing': {
            const drawing = readDrawing(r);
            if (drawing !== null) run.children.push({ kind: 'drawingPic', id: drawing.id });
            break;
          }
          case 'instrText':
            // Reads the next non-whitespace character event, or returns at `</w:r>`.
            for (let n = r.next(); n !== null; n = r.next()) {
              if (n.kind === 'text' && n.cdata !== true && rustTrim(n.text) !== '') break;
              if (n.kind === 'end' && n.local === 'r') return run;
            }
            break;
          default: break;
        }
      } else if (prefix === 'mc') {
        if (t.local === 'Fallback') skipElement(r, 'Fallback');
      } else if (prefix === 'v') {
        if (t.local === 'shape') skipElement(r, 'shape');
      }
    } else if (t.kind === 'text') {
      if (t.cdata === true) continue;
      if (state === 'text') run.children.push({ kind: 'text', text: replaceEscaped(t.text) });
      else if (state === 'delete') run.children.push({ kind: 'deleteText', text: replaceEscaped(t.text) });
    } else if (t.local === 'r') {
      return run;
    } else if (t.local === 'delText' || t.local === 't') {
      state = 'idle';
    }
  }
  throw xmlReadError();
}

/** `reader/insert.rs` / `reader/delete.rs`: runs only (nested deletes are kept out). */
function readRevision(r: Reader, local: 'ins' | 'del'): Run[] {
  const runs: Run[] = [];
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'start') {
      if (t.local === 'r') runs.push(readRun(r));
      else if (local === 'ins' && t.local === 'del') readRevision(r, 'del');
    } else if (t.kind === 'end' && t.local === local) {
      return runs;
    }
  }
  throw xmlReadError();
}

/** `reader/hyperlink.rs`. */
function readHyperlink(r: Reader): Run[] {
  const runs: Run[] = [];
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'start') {
      switch (t.local) {
        case 'r': runs.push(readRun(r)); break;
        case 'ins': readRevision(r, 'ins'); break;
        case 'del': readRevision(r, 'del'); break;
        case 'bookmarkStart': case 'bookmarkEnd': skipElement(r, t.local); break;
        default: break;
      }
    } else if (t.kind === 'end' && t.local === 'hyperlink') {
      return runs;
    }
  }
  throw xmlReadError();
}

/** `reader/paragraph.rs`. */
function readParagraph(r: Reader): Paragraph {
  const p: Paragraph = { children: [] };
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'start') {
      switch (t.local) {
        case 'r': p.children.push({ kind: 'run', run: readRun(r) }); break;
        case 'hyperlink': p.children.push({ kind: 'hyperlink', runs: readHyperlink(r) }); break;
        case 'ins': p.children.push({ kind: 'insert', runs: readRevision(r, 'ins') }); break;
        case 'del': p.children.push({ kind: 'delete', runs: readRevision(r, 'del') }); break;
        case 'bookmarkStart': case 'bookmarkEnd': case 'pPr': skipElement(r, t.local); break;
        default: break;
      }
    } else if (t.kind === 'end' && t.local === 'p') {
      return p;
    }
  }
  throw xmlReadError();
}

/** `reader/table_cell.rs`: nested tables and cell-level `w:sdt` are not cell paragraphs. */
function readTableCell(r: Reader): TableCell {
  const cell: TableCell = { paragraphs: [] };
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'start') {
      switch (t.local) {
        case 'p': cell.paragraphs.push(readParagraph(r)); break;
        case 'sdt': case 'tcPr': skipElement(r, t.local); break;
        case 'tbl': readTable(r); break;
        default: break;
      }
    } else if (t.kind === 'end' && t.local === 'tc') {
      return cell;
    }
  }
  throw xmlReadError();
}

/** `reader/table_row.rs`. */
function readTableRow(r: Reader): TableRow {
  const row: TableRow = { cells: [] };
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'start') {
      switch (t.local) {
        case 'trPrChange': ignoreUntilEnd(r, 'trPrChange'); break;
        case 'tc': row.cells.push(readTableCell(r)); break;
        case 'ins': readRevision(r, 'ins'); break;
        case 'del': readRevision(r, 'del'); break;
        default: break;
      }
    } else if (t.kind === 'end' && t.local === 'tr') {
      return row;
    }
  }
  throw xmlReadError();
}

/** `reader/table.rs`. */
function readTable(r: Reader): Table {
  const table: Table = { rows: [] };
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind === 'start') {
      switch (t.local) {
        case 'tblPrChange': case 'tblGridChange': ignoreUntilEnd(r, t.local); break;
        case 'tr': table.rows.push(readTableRow(r)); break;
        case 'tblPr': case 'tblBorders': case 'tblCellMar': skipElement(r, t.local); break;
        default: break;
      }
    } else if (t.kind === 'end' && t.local === 'tbl') {
      return table;
    }
  }
  throw xmlReadError();
}

/** `reader/document.rs`: body-level `w:sdt` is kept as a StructuredDataTag (no text). */
function readDocument(xml: string): DocumentChild[] {
  const r = new Reader([...xmlTokens(xml)]);
  const children: DocumentChild[] = [];
  for (let t = r.next(); t !== null; t = r.next()) {
    if (t.kind !== 'start') continue;
    switch (t.local) {
      case 'p': children.push({ kind: 'paragraph', p: readParagraph(r) }); break;
      case 'tbl': children.push({ kind: 'table', t: readTable(r) }); break;
      case 'bookmarkStart': case 'bookmarkEnd': case 'sectPr': case 'sdt': skipElement(r, t.local); break;
      default: break;
    }
  }
  return children;
}

// ------------------------------------------------------------------ package access

class DocxPackage {
  private readonly entries: Map<string, ZipDirectoryEntry>;
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array, entries: ZipDirectoryEntry[]) {
    this.bytes = bytes;
    this.entries = new Map(entries.map(entry => [entry.name, entry]));
  }

  has(name: string): boolean { return this.entries.has(name); }

  /** `read_zip_entry_bounded`: cap + 1 read, ZipBomb error above cap. */
  readBounded(name: string, cap: number): Buffer | null {
    const entry = this.entries.get(name);
    if (entry === undefined) return null;
    let data: Buffer | null;
    try { data = zipEntryData(this.bytes, entry, cap + 1); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
        throw new ParsingError('ZipBombDetected',
          `ZIP 条目 '${name}' 实际解压大小超过 ${(cap / (1024 * 1024)).toFixed(0)}MB 上限（声明大小可能被伪造）`);
      }
      throw new ParsingError('IoError', `读取 ZIP 条目 '${name}' 失败: ${(error as Error).message}`);
    }
    if (data === null) {
      throw new ParsingError('IoError', `读取 ZIP 条目 '${name}' 失败: invalid Zip archive`);
    }
    if (data.length > cap) {
      throw new ParsingError('ZipBombDetected',
        `ZIP 条目 '${name}' 实际解压大小超过 ${(cap / (1024 * 1024)).toFixed(0)}MB 上限（声明大小可能被伪造）`);
    }
    return data;
  }
}

function openPackage(bytes: Uint8Array): DocxPackage {
  const entries = zipDirectory(bytes);
  if (entries === null) {
    throw new ParsingError('DocxParsingError', '无法打开 DOCX ZIP: invalid Zip archive');
  }
  return new DocxPackage(bytes, entries);
}

/** `build_docx_image_map`: rId → image bytes for `/image` relationships. */
function buildDocxImageMap(pkg: DocxPackage): Map<string, Uint8Array> {
  const ridToTarget = new Map<string, string>();
  const relsBytes = pkg.readBounded('word/_rels/document.xml.rels', MAX_DOCX_RELS_BYTES);
  if (relsBytes !== null) {
    let relsXml: string;
    try { relsXml = new TextDecoder('utf-8', { fatal: true }).decode(relsBytes); }
    catch {
      throw new ParsingError('DocxParsingError', 'rels 不是有效 UTF-8: invalid utf-8 sequence');
    }
    for (const token of xmlTokens(relsXml)) {
      // quick-xml compares the qualified name: only an unprefixed `Relationship` matches.
      if (token.kind !== 'start' || token.qname !== 'Relationship') continue;
      const id = token.attrs.Id;
      const target = token.attrs.Target;
      if (id === undefined || target === undefined) continue;
      if (!(token.attrs.Type ?? '').includes('/image')) continue;
      if (ridToTarget.size >= MAX_DOCX_IMAGE_RELATIONSHIPS) {
        throw new ParsingError('DocxParsingError',
          `DOCX 图片 relationship 数量超过上限 ${MAX_DOCX_IMAGE_RELATIONSHIPS}`);
      }
      ridToTarget.set(id, target);
    }
  }

  const ridToBytes = new Map<string, Uint8Array>();
  let totalImageBytes = 0;
  for (const [rid, target] of ridToTarget) {
    const zipPath = target.startsWith('/') ? target.slice(1) : `word/${target}`;
    if (!pkg.has(zipPath)) continue;
    const buf = pkg.readBounded(zipPath, MAX_SINGLE_ENTRY_SIZE);
    if (buf === null || buf.length === 0) continue;
    totalImageBytes += buf.length;
    if (totalImageBytes > MAX_DOCX_TOTAL_IMAGE_BYTES) {
      throw new ParsingError('DocxParsingError',
        `DOCX 图片总字节数超过 ${mb(MAX_DOCX_TOTAL_IMAGE_BYTES)}MB 上限`);
    }
    ridToBytes.set(rid, new Uint8Array(buf));
  }
  return ridToBytes;
}

/** `docx_rs::read_docx` package/document steps observed by the extraction. */
function readDocxDocument(pkg: DocxPackage): DocumentChild[] {
  const zipError = (): ParsingError => new ParsingError('DocxParsingError', 'Failed to read from zip.');
  if (!pkg.has('[Content_Types].xml')) throw zipError();
  const rootRels = pkg.readBounded('_rels/.rels', MAX_SINGLE_ENTRY_SIZE);
  if (rootRels === null) throw zipError();
  let documentPath = 'word/document.xml';
  for (const token of xmlTokens(Buffer.from(rootRels).toString('utf8'))) {
    if (token.kind === 'start' && token.local === 'Relationship'
      && token.attrs.Type === DOC_RELATIONSHIP_TYPE && token.attrs.Target !== undefined) {
      documentPath = token.attrs.Target.startsWith('/') ? token.attrs.Target.slice(1) : token.attrs.Target;
      break;
    }
  }
  const documentBytes = pkg.readBounded(documentPath, MAX_SINGLE_ENTRY_SIZE);
  if (documentBytes === null) throw zipError();
  return readDocument(Buffer.from(documentBytes).toString('utf8'));
}

// ------------------------------------------------------------------ extraction

class ImageState {
  readonly images: Uint8Array[] = [];
  readonly indexByRid = new Map<string, number>();
  referenceCount = 0;
  outputImageBytes = 0;
  readonly ridMap: Map<string, Uint8Array>;
  constructor(ridMap: Map<string, Uint8Array>) { this.ridMap = ridMap; }

  /** `record_docx_image` (docx-rs read mode never fills `Pic.image`). */
  record(id: string): number | null {
    this.referenceCount += 1;
    if (this.referenceCount > MAX_DOCX_IMAGE_REFERENCES) {
      throw new ParsingError('DocxParsingError', `DOCX 图片引用数量超过上限 ${MAX_DOCX_IMAGE_REFERENCES}`);
    }
    if (id !== '') {
      const existing = this.indexByRid.get(id);
      if (existing !== undefined) return existing;
    }
    if (id === '') return null;
    const bytes = this.ridMap.get(id);
    if (bytes === undefined) return null;
    this.ridMap.delete(id);
    if (this.images.length >= MAX_DOCX_IMAGE_RELATIONSHIPS) {
      throw new ParsingError('DocxParsingError', `DOCX 提取图片数量超过上限 ${MAX_DOCX_IMAGE_RELATIONSHIPS}`);
    }
    this.outputImageBytes += bytes.length;
    if (this.outputImageBytes > MAX_DOCX_TOTAL_IMAGE_BYTES) {
      throw new ParsingError('DocxParsingError',
        `DOCX 输出图片总字节数超过 ${mb(MAX_DOCX_TOTAL_IMAGE_BYTES)}MB 上限`);
    }
    const index = this.images.length;
    this.images.push(bytes);
    this.indexByRid.set(id, index);
    return index;
  }
}

/** String buffer that tracks the UTF-8 length like Rust `String::len`. */
class ByteString {
  value = '';
  bytes = 0;
  /** `push_docx_fragment`. */
  pushFragment(fragment: string): void {
    const next = this.bytes + byteLen(fragment);
    if (next > MAX_DOCX_TEXT_BYTES) {
      throw new ParsingError('DocxParsingError', `DOCX 单段提取文本超过 ${mb(MAX_DOCX_TEXT_BYTES)}MB 上限`);
    }
    this.value += fragment;
    this.bytes = next;
  }
  pushRaw(fragment: string): void { this.value += fragment; this.bytes += byteLen(fragment); }
}

function runText(run: Run, out: ByteString, state: ImageState): void {
  for (const child of run.children) {
    switch (child.kind) {
      case 'text': case 'deleteText': out.pushFragment(child.text); break;
      case 'tab': out.pushFragment('\t'); break;
      case 'break': out.pushFragment('\n'); break;
      case 'drawingPic': {
        const index = state.record(child.id);
        if (index !== null) out.pushFragment(`<<IMG:${index}>>`);
        break;
      }
    }
  }
}

function paragraphText(p: Paragraph, state: ImageState): string {
  const line = new ByteString();
  for (const child of p.children) {
    if (child.kind === 'run') runText(child.run, line, state);
    else for (const run of child.runs) runText(run, line, state);
  }
  return line.value;
}

function tableText(table: Table, out: ByteString, state: ImageState): void {
  for (const row of table.rows) {
    const cells: string[] = [];
    for (const cell of row.cells) {
      const cellText = new ByteString();
      for (const p of cell.paragraphs) {
        const t = paragraphText(p, state);
        if (rustTrim(t) !== '') {
          if (cellText.value !== '') cellText.pushFragment(' ');
          cellText.pushFragment(rustTrim(t));
        }
      }
      cells.push(cellText.value);
    }
    if (cells.some(cell => cell !== '')) {
      out.pushFragment('| ');
      cells.forEach((cell, index) => {
        if (index > 0) out.pushFragment(' | ');
        out.pushFragment(cell);
      });
      out.pushFragment(' |\n');
    }
  }
}

/**
 * Body of `extract_docx_with_images` after the encryption / ZIP-bomb guards,
 * which the caller (`DocumentParser.extractDocxWithImages`) runs first.
 */
export function extractDocxWithImagesUnchecked(bytes: Uint8Array): DocxTextWithImages {
  const pkg = openPackage(bytes);
  const state = new ImageState(buildDocxImageMap(pkg));
  const children = readDocxDocument(pkg);
  const text = new ByteString();
  const tooLong = (): ParsingError => new ParsingError('DocxParsingError',
    `DOCX 提取文本超过 ${mb(MAX_DOCX_TEXT_BYTES)}MB 上限`);
  for (const child of children) {
    if (child.kind === 'paragraph') {
      const line = paragraphText(child.p, state);
      if (rustTrim(line) !== '') {
        if (text.bytes + byteLen(line) + 1 > MAX_DOCX_TEXT_BYTES) throw tooLong();
        text.pushRaw(line);
        text.pushRaw('\n');
      }
    } else {
      tableText(child.t, text, state);
      if (text.bytes >= MAX_DOCX_TEXT_BYTES) throw tooLong();
      text.pushRaw('\n');
    }
  }
  return { text: text.value, images: state.images };
}
