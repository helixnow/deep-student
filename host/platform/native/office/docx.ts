import {
  AlignmentType, Document, ImageRun, LineRuleType, Packer, PageBreak, Paragraph,
  Table, TableCell, TableRow, TextRun, WidthType, type IParagraphOptions, type IRunOptions,
} from 'docx';
import { rustTrim } from '../../util/index.ts';
import { image } from '../image/index.ts';
import type { RgbaImage } from '../image/api.ts';

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
const str = (value: unknown): string => typeof value === 'string' ? value : '';
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const fonts = (cn: string): IRunOptions['font'] => ({ ascii: 'Times New Roman', hAnsi: 'Times New Roman', eastAsia: cn, cs: 'Times New Roman' });
const exact = { line: 560, lineRule: LineRuleType.EXACT };
const headingLevel = (value: unknown): number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 1;

function text(value: string, options: IRunOptions = {}): TextRun { return new TextRun({ text: value, ...options }); }
function paragraph(value: string, run: IRunOptions = {}, options: IParagraphOptions = {}): Paragraph {
  return new Paragraph({ children: [text(value, run)], ...options });
}
function body(value: string, cn = '仿宋', bold = false, options: IParagraphOptions = {}): Paragraph {
  return paragraph(value, { size: 32, font: fonts(cn), bold }, {
    spacing: exact, indent: { firstLine: 640 }, alignment: AlignmentType.BOTH, ...options,
  });
}
function centered(value: string, cn: string, size: number, keepNext = false): Paragraph {
  return paragraph(value, { font: fonts(cn), size }, { alignment: AlignmentType.CENTER, spacing: exact, keepNext });
}

async function picture(block: JsonObject, handout: boolean): Promise<Paragraph[]> {
  const caption = rustTrim(str(block.caption));
  // Rust decode_image_data(..).and_then(prepare_png): invalid base64 and
  // image::load_from_memory failures are `.ok()?` — no warning, caption kept.
  let decoded: RgbaImage | null = null;
  try {
    let raw = str(block.data);
    const index = raw.indexOf('base64,');
    if (raw.startsWith('data:') && index !== -1) raw = raw.slice(index + 7);
    raw = raw.replace(/\p{White_Space}/gu, '');
    const data = Buffer.from(raw, 'base64');
    if (data.toString('base64') !== raw) throw new Error('Invalid image base64');
    decoded = await image.decodeRgba(data);
  } catch {
    decoded = null;
  }
  let prepared: { data: Uint8Array; width: number; height: number } | null = null;
  if (decoded !== null) {
    if (Math.max(decoded.width, decoded.height) > 2000) {
      const size = image.resizeDimensions(decoded.width, decoded.height, 2000, 2000);
      decoded = image.resizeRgba(decoded, size.width, size.height, 'triangle');
    }
    // DynamicImage::write_to(Png) into a Vec cannot fail for a decoded RGBA8 image, so an
    // encoder failure is a Host engine fault (e.g. a missing codec module): surface it instead
    // of silently turning every picture into "[image]".
    try {
      prepared = { data: await image.encode(decoded, { format: 'png' }), width: decoded.width, height: decoded.height };
    } catch (error) {
      throw new Error(`DOCX 图片 PNG 编码失败: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
  const paragraphs: Paragraph[] = [];
  if (prepared === null) {
    const alt = rustTrim(str(block.alt));
    paragraphs.push(paragraph(alt === '' ? '[image]' : `[${alt}]`, { size: 24 }, { alignment: AlignmentType.CENTER }));
  } else {
    const max = (handout ? 8845 : 8504) * 635;
    const ew = Math.min(prepared.width * 9525, max);
    const eh = prepared.width * 9525 <= max ? prepared.height * 9525
      : Math.max(1, Math.floor(prepared.height * 9525 * max / (prepared.width * 9525)));
    paragraphs.push(new Paragraph({ alignment: AlignmentType.CENTER, keepNext: caption !== '', children: [new ImageRun({
      type: 'png', data: prepared.data, transformation: { width: ew / 9525, height: eh / 9525 },
    })] }));
  }
  if (caption !== '') paragraphs.push(paragraph(caption, handout
    ? { size: 24, font: fonts('楷体') } : { size: 21, italics: true }, { alignment: AlignmentType.CENTER }));
  return paragraphs;
}

export async function generateDocx(value: unknown): Promise<Uint8Array> {
  const spec = object(value);
  const handout = spec.template === 'handout' || spec.template === 'official';
  const children: Array<Paragraph | Table> = [];
  const title = handout ? rustTrim(str(spec.title)) : str(spec.title);
  if (handout ? title !== '' : typeof spec.title === 'string') {
    children.push(paragraph(title, handout ? { size: 44, bold: true, font: fonts('宋体') } : { size: 48, bold: true },
      handout ? { style: 'Title', alignment: AlignmentType.CENTER, spacing: { before: 240, after: 480 } } : { style: 'Heading1' }));
  }
  if (handout) for (const key of ['subtitle', 'date']) {
    const line = rustTrim(str(spec[key]));
    if (line !== '') children.push(centered(line, '楷体', 32));
  }
  for (const raw of array(spec.blocks)) {
    const block = object(raw), content = str(block.text);
    switch (block.type) {
      case 'heading': {
        const level = headingLevel(block.level);
        children.push(handout ? body(content, level <= 1 ? '黑体' : level === 2 ? '楷体' : '仿宋', level > 2, {
          style: `Heading${Math.min(6, Math.max(1, level))}`, keepNext: true, alignment: AlignmentType.LEFT,
        }) : paragraph(content, { bold: true, size: [24, 48, 36, 32, 28][level] ?? 24 }, { style: `Heading${Math.min(6, level)}` }));
        break;
      }
      case 'paragraph': {
        if (handout) children.push(block.role === 'caption' ? centered(content, '楷体', 24)
          : body(content, block.role === 'note' ? '楷体' : '仿宋', block.role === 'note' ? false : block.bold === true));
        else {
          const alignment = block.alignment === undefined ? undefined : ({ center: AlignmentType.CENTER, right: AlignmentType.RIGHT,
            both: AlignmentType.BOTH, justify: AlignmentType.BOTH }[str(block.alignment)] ?? AlignmentType.LEFT);
          children.push(paragraph(content, { size: 24, bold: block.bold === true, italics: block.italic === true }, { alignment }));
        }
        break;
      }
      case 'image': children.push(...await picture(block, handout)); break;
      case 'table': {
        const caption = rustTrim(str(block.caption));
        if (handout && caption !== '') children.push(centered(caption, '黑体', 24, true));
        const rows = array(block.rows).map((row, i) => {
          const header = handout && block.header === true && i === 0;
          const cells = array(row).map(cell => new TableCell({ children: [paragraph(str(cell), handout
            ? { size: 21, font: fonts(header ? '黑体' : '仿宋'), bold: header } : { size: 24 },
          { ...(header ? { alignment: AlignmentType.CENTER } : {}) })] }));
          return cells.length === 0 && handout ? null : new TableRow({ children: cells });
        }).filter((row): row is TableRow => row !== null);
        children.push(new Table({ rows, ...(handout ? { width: { size: 8845, type: WidthType.DXA } } : {}) }));
        break;
      }
      case 'list': array(block.items).forEach((item, index) => {
        const line = `${block.ordered === true ? `${index + 1}. ` : handout ? '● ' : '• '}${str(item)}`;
        children.push(handout ? body(line) : paragraph(line, { size: 24 }));
      }); break;
      case 'code': {
        const lines = handout ? content.split(/\r?\n/u) : [content];
        if (handout && lines.at(-1) === '') lines.pop();
        for (const line of lines) children.push(paragraph(line, { size: 20, font: handout
          ? { ascii: 'Courier New', hAnsi: 'Courier New' } : { ascii: 'Courier New' } }));
        break;
      }
      case 'pagebreak': children.push(new Paragraph({ children: [new TextRun({ children: [new PageBreak()] })] })); break;
      default: if (handout ? content !== '' : typeof block.text === 'string') children.push(handout ? body(content) : paragraph(content, { size: 24 }));
    }
  }
  const document = new Document({
    ...(handout ? { styles: { default: { document: { run: { size: 32, font: fonts('仿宋') } } } } } : {}),
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: handout
      ? { top: 2098, bottom: 1984, left: 1587, right: 1474, header: 851, footer: 992, gutter: 0 }
      : { top: 1985, bottom: 1701, left: 1701, right: 1701, header: 851, footer: 992, gutter: 0 } } }, children }],
  });
  // docx-rs writes <w:evenAndOddHeaders/> only when enabled; npm docx always emits it (w:val="false").
  const settings = (document.Settings as unknown as { root: Array<{ rootKey?: string }> }).root;
  const evenAndOdd = settings.findIndex(child => child.rootKey === 'w:evenAndOddHeaders');
  if (evenAndOdd >= 0) settings.splice(evenAndOdd, 1);
  try { return await Packer.toBuffer(document); }
  catch (error) { throw new Error(`DOCX解析错误: DOCX 生成失败: ${error instanceof Error ? error.message : String(error)}`); }
}
