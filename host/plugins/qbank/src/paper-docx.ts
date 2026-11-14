/**
 * `qbank_practice/export.rs`：把试卷块渲染为 DOCX。
 *
 * 版式与 Rust `build_docx` 一致：A4 11906×16838 twip、页边距 960/960/1000/1000、
 * 默认字体 Noto Sans CJK SC、默认字号 22 半磅、页脚“当前页 / 总页数”。图片沿用
 * `docx_handout` 的语义：base64 解码 → 50MB 上限 → 解码/缩放（最长边 2000）→ PNG。
 * `docx@9.15.2` 是 D9 批准的生产依赖；图片解码/缩放/PNG 编码经 F7
 * `nativeImage` 正式能力，业务层不直接使用 sharp。
 */
import {
  AlignmentType, BorderStyle, Document, Footer, HeadingLevel, ImageRun, PageNumber,
  Packer, Paragraph, ShadingType, Table, TableCell, TableRow, TextRun, VerticalAlign,
  WidthType,
} from 'docx';
import { toBase64 } from '../../../platform/crypto/encoding.ts';
import { AppError } from '../../../platform/errors/api.ts';
import { decodeBase64Standard, isRustWhitespace } from '../../../platform/util/portable.ts';
import { QbankServiceError } from './question-service.ts';
import type { PaperImageCodec, RgbaImage } from './native-image.ts';

export interface PaperRunInput {
  text?: string | null;
  image?: string | null;
  width?: number | null;
  height?: number | null;
  bold?: boolean | null;
  italic?: boolean | null;
}

export interface PaperBlockInput {
  kind: string;
  runs?: PaperRunInput[] | null;
  level?: number | null;
  rows?: PaperRunInput[][][] | null;
  image?: string | null;
  width?: number | null;
  height?: number | null;
  lines?: number | null;
  page_break?: boolean | null;
}

const FONT = 'Noto Sans CJK SC';
const FONT_ATTRIBUTES = { ascii: FONT, hAnsi: FONT, eastAsia: FONT } as const;
const PAGE_W = 11906;
const PAGE_H = 16838;
const IMAGE_MAX_EDGE = 2000;
const IMAGE_MAX_BYTES = 50 * 1024 * 1024;
const EMU_PER_POINT = 12700;
const EMU_PER_PIXEL = 9525;
function validation(message: string): never {
  throw new QbankServiceError(AppError.validation(message));
}

function internal(message: string): never {
  throw new QbankServiceError(AppError.internal(message));
}

interface PreparedImage {
  png: Uint8Array;
  width: number;
  height: number;
}

/**
 * Rust `decode_image_data`：仅当以 `data:` 开头且含 `base64,` 时剥离前缀，去掉 `char::is_whitespace`
 * 字符后按 `STANDARD` 严格解码（填充与尾位都要规范）。
 */
function decodeBase64(data: string): Uint8Array | null {
  const marker = data.indexOf('base64,');
  const raw = data.startsWith('data:') && marker >= 0
    ? data.slice(marker + 'base64,'.length)
    : data;
  let compact = '';
  for (const char of raw) if (!isRustWhitespace(char.codePointAt(0)!)) compact += char;
  return decodeBase64Standard(compact).bytes ?? null;
}

/** Rust `prepare_png`：解码、最长边限制到 2000、按原尺寸重编码为 PNG。 */
async function preparePng(bytes: Uint8Array, codec: PaperImageCodec | null): Promise<PreparedImage | null> {
  if (codec === null) return null;
  try {
    let image: RgbaImage = await codec.decodeRgba(bytes);
    if (image.width === 0 || image.height === 0) return null;
    if (Math.max(image.width, image.height) > IMAGE_MAX_EDGE) {
      const size = codec.resizeDimensions(image.width, image.height, IMAGE_MAX_EDGE, IMAGE_MAX_EDGE);
      image = codec.resizeRgba(image, size.width, size.height, 'triangle');
    }
    if (image.width === 0 || image.height === 0) return null;
    const png = await codec.encode(image, { format: 'png' });
    return { png, width: image.width, height: image.height };
  } catch {
    return null;
  }
}

function decodePaperImage(data: string): Uint8Array {
  const bytes = decodeBase64(data);
  if (bytes === null) validation('Invalid paper image');
  if (bytes.length > IMAGE_MAX_BYTES) validation('Paper image exceeds size limit');
  return bytes;
}

/** Rust `picture`：请求宽度缺省按 0.75 px/point，高度缺省按宽高比，最高 600pt。 */
async function pictureRun(data: string, width: number | null | undefined,
  height: number | null | undefined, maxWidth: number,
  codec: PaperImageCodec | null): Promise<ImageRun> {
  const bytes = decodePaperImage(data);
  const image = await preparePng(bytes, codec);
  if (image === null) validation('Cannot decode paper image');
  const requestedWidth = Math.max(width ?? image.width * 0.75, 1);
  const intended = Math.min(requestedWidth, maxWidth);
  const intendedHeight = height != null
    ? height * intended / requestedWidth
    : intended * image.height / image.width;
  const scale = Math.min(600 / intendedHeight, 1);
  const emu = (value: number) => Math.trunc(value * scale * EMU_PER_POINT);
  return new ImageRun({
    type: 'png',
    data: image.png,
    transformation: {
      width: emu(intended) / EMU_PER_PIXEL,
      height: emu(intendedHeight) / EMU_PER_PIXEL,
    },
  });
}

function runProperties(item: PaperRunInput, size: number, bold: boolean) {
  return {
    size,
    font: FONT_ATTRIBUTES,
    color: '000000',
    bold: bold || item.bold === true ? true : undefined,
    italics: item.italic === true ? true : undefined,
  };
}

/** Rust `paragraph`：每个 item 一个 run；图片优先于文本，换行写成 run 内 break。 */
async function paragraphRuns(runs: readonly PaperRunInput[], size: number, bold: boolean,
  maxWidth: number, codec: PaperImageCodec | null): Promise<Array<TextRun | ImageRun>> {
  const children: Array<TextRun | ImageRun> = [];
  for (const item of runs) {
    const properties = runProperties(item, size, bold);
    if (item.image != null) {
      children.push(await pictureRun(item.image, item.width, item.height, maxWidth, codec));
      continue;
    }
    if (item.text == null) {
      children.push(new TextRun({ text: '', ...properties }));
      continue;
    }
    item.text.split('\n').forEach((line, index) => {
      children.push(new TextRun({ text: line, ...(index > 0 ? { break: 1 } : {}), ...properties }));
    });
  }
  return children;
}

type HeadingValue = (typeof HeadingLevel)[keyof typeof HeadingLevel];

interface ParagraphSpec {
  kind: 'paragraph';
  runs: readonly PaperRunInput[];
  size: number;
  bold: boolean;
  maxWidth: number;
  heading?: HeadingValue;
  keepNext?: boolean;
  pageBreakBefore?: boolean;
  spacingAfter: number;
}

interface TextParagraphSpec {
  kind: 'text';
  text: string;
  size: number;
}

interface TableSpec {
  kind: 'table';
  rows: readonly (readonly (readonly PaperRunInput[])[])[];
}

type ChildSpec = ParagraphSpec | TextParagraphSpec | TableSpec;

function paragraphSpec(runs: readonly PaperRunInput[], size: number, bold: boolean,
  maxWidth: number): ParagraphSpec {
  return { kind: 'paragraph', runs, size, bold, maxWidth, spacingAfter: 120 };
}

async function renderParagraph(spec: ParagraphSpec,
  codec: PaperImageCodec | null): Promise<Paragraph> {
  const children = await paragraphRuns(spec.runs, spec.size, spec.bold, spec.maxWidth, codec);
  return new Paragraph({
    heading: spec.heading,
    children,
    widowControl: true,
    spacing: { after: spec.spacingAfter, line: 320 },
    alignment: spec.runs.some(run => run.image != null) ? AlignmentType.CENTER : undefined,
    keepNext: spec.keepNext,
    pageBreakBefore: spec.pageBreakBefore,
  });
}

async function renderTableCell(cell: readonly PaperRunInput[], size: number, bold: boolean,
  columns: number, header: boolean, codec: PaperImageCodec | null): Promise<TableCell> {
  return new TableCell({
    width: { size: Math.trunc(9800 / columns), type: WidthType.DXA },
    verticalAlign: VerticalAlign.CENTER,
    children: [await renderParagraph(paragraphSpec(cell, size, bold, 480 / columns), codec)],
    ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'EEEEEE', color: 'auto' } } : {}),
  });
}

const BORDER = { style: BorderStyle.SINGLE, size: 4, color: 'D9D9D9' } as const;

async function renderTable(spec: TableSpec, codec: PaperImageCodec | null): Promise<Table> {
  const columns = Math.max(1, ...spec.rows.map(row => row.length));
  const rows: TableRow[] = [];
  for (const [index, row] of spec.rows.entries()) {
    const cells: TableCell[] = [];
    for (const cell of row) {
      cells.push(await renderTableCell(cell, 21, index === 0, columns, index === 0, codec));
    }
    rows.push(new TableRow({ children: cells }));
  }
  return new Table({
    rows,
    width: { size: 9800, type: WidthType.DXA },
    borders: {
      top: BORDER, bottom: BORDER, left: BORDER, right: BORDER,
      insideHorizontal: BORDER, insideVertical: BORDER,
    },
  });
}

async function renderChildren(specs: readonly ChildSpec[],
  codec: PaperImageCodec | null): Promise<Array<Paragraph | Table>> {
  const children: Array<Paragraph | Table> = [];
  for (const spec of specs) {
    if (spec.kind === 'table') {
      children.push(await renderTable(spec, codec));
    } else if (spec.kind === 'text') {
      children.push(new Paragraph({
        heading: HeadingLevel.TITLE,
        children: [new TextRun({ text: spec.text, size: spec.size })],
      }));
    } else {
      children.push(await renderParagraph(spec, codec));
    }
  }
  return children;
}

function blocksToChildren(title: string, blocks: readonly PaperBlockInput[]): ChildSpec[] {
  const children: ChildSpec[] = [];
  if (blocks.length === 0) {
    children.push({ kind: 'text', text: title, size: 36 });
  }
  for (const block of blocks) {
    switch (block.kind) {
      case 'heading': {
        const level = block.level ?? 1;
        children.push({
          ...paragraphSpec(block.runs ?? [], level === 0 ? 36 : 24, true, 490),
          heading: level === 0 ? HeadingLevel.TITLE : HeadingLevel.HEADING_2,
          keepNext: true,
          pageBreakBefore: block.page_break === true,
        });
        break;
      }
      case 'paragraph':
        children.push(paragraphSpec(block.runs ?? [], 22, false, 490));
        break;
      case 'image':
        if (block.image != null) {
          children.push(paragraphSpec([{
            image: block.image, width: block.width, height: block.height,
          }], 22, false, 490));
        }
        break;
      case 'space': {
        const spacing = Math.min(block.lines ?? 1, 20) * 360;
        const previous = children.at(-1);
        if (previous !== undefined && previous.kind === 'paragraph') {
          previous.spacingAfter = spacing;
        } else {
          const empty = paragraphSpec([], 22, false, 490);
          empty.spacingAfter = spacing;
          children.push(empty);
        }
        break;
      }
      case 'table': {
        const source = block.rows ?? [];
        children.push({ kind: 'table', rows: source });
        break;
      }
      default:
        validation('Invalid paper block type');
    }
  }
  return children;
}

/** Rust `build_docx`：返回 DOCX 字节（命令层再 base64）。 */
export async function buildPaperDocx(title: string,
  blocks: readonly PaperBlockInput[], codec: PaperImageCodec | null = null): Promise<Uint8Array> {
  if (blocks.length > 50_000) validation('Paper has too many blocks');
  const children = await renderChildren(blocksToChildren(title, blocks), codec);
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: FONT_ATTRIBUTES, size: 22 },
        },
      },
    },
    sections: [{
      properties: {
        page: {
          size: { width: PAGE_W, height: PAGE_H },
          margin: { top: 960, bottom: 960, left: 1000, right: 1000 },
        },
      },
      footers: {
        default: new Footer({
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [
              new TextRun({ children: [PageNumber.CURRENT] }),
              new TextRun({ text: ' / ', size: 18 }),
              new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
            ],
          })],
        }),
      },
      children,
    }],
  });
  try {
    return new Uint8Array(await Packer.toArrayBuffer(doc));
  } catch (error) {
    internal(`DOCX export failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Rust `qbank_export_paper_docx`：标准 base64 编码。 */
export async function exportPaperDocx(title: string,
  blocks: readonly PaperBlockInput[], codec: PaperImageCodec | null = null): Promise<string> {
  return toBase64(await buildPaperDocx(title, blocks, codec));
}
