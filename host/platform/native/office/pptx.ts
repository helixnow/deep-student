import { createRequire } from 'node:module';

// pptxgenjs 4.0.1's CJS `export default` declaration is a namespace under NodeNext.
// Require the actual CJS constructor, retaining the small API surface used here.
interface Presentation {
  layout: string; title: string;
  addSlide(): {
    addText(text: string | Array<{ text: string; options: { bullet: boolean; breakLine: boolean } }>, options: Record<string, unknown>): void;
    addTable(rows: string[][], options: Record<string, unknown>): void;
  };
  write(options: { outputType: 'uint8array' }): Promise<Uint8Array>;
}
const PptxGenJS = createRequire(import.meta.url)('pptxgenjs') as new () => Presentation;

const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const str = (value: unknown, fallback = ''): string => typeof value === 'string' ? value : fallback;
const inch = (emu: number): number => emu / 914400;

/** document_parser.rs:2773–2887; ppt-rs 0.2.14 constants, 10×7.5in. */
export async function generatePptx(value: unknown): Promise<Uint8Array> {
  const spec = object(value), title = str(spec.title, 'Presentation');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_4x3';
  pptx.title = title;
  const slides = array(spec.slides);
  for (const raw of slides.length === 0 ? [{ title }] : slides) {
    const data = object(raw), slide = pptx.addSlide(), type = str(data.type, 'content');
    slide.addText(str(data.title), { x: inch(457200), y: inch(274638), w: inch(8230200), h: inch(1143000), fontSize: 44, bold: true });
    const bullets = type === 'title' ? (str(data.subtitle) === '' ? [] : [str(data.subtitle)])
      : type === 'content' ? array(data.bullets).filter((v): v is string => typeof v === 'string') : [];
    if (bullets.length !== 0) slide.addText(bullets.map(text => ({ text, options: { bullet: true, breakLine: true } })), {
      x: inch(457200), y: inch(1600200), w: inch(8230200), h: inch(4572000), fontSize: 28, valign: 'top',
    });
    if (type === 'table') {
      const headers = array(data.headers), rows = array(data.rows);
      const columns = Math.max(headers.length, array(rows[0]).length, 1);
      const width = Math.floor(8_000_000 / columns);
      const table: string[][] = [];
      if (headers.length > 0) table.push(headers.map(v => str(v)));
      for (const row of rows) if (Array.isArray(row)) table.push(row.map(v => str(v)));
      if (table.length > 0) slide.addTable(table, {
        x: inch(457200), y: inch(1600200), w: inch(width * columns),
        colW: Array.from({ length: columns }, () => inch(width)), autoPage: false,
        border: { type: 'solid', color: '000000', pt: 1 },
      });
    }
  }
  try {
    return new Uint8Array(await pptx.write({ outputType: 'uint8array' }) as Uint8Array);
  } catch (error) { throw new Error(`PPTX解析错误: PPTX 生成失败: ${error instanceof Error ? error.message : String(error)}`); }
}
