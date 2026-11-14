/** 讲义内容契约；模型负责内容，编号与排版由确定性渲染器负责。 */
export type HandoutBlock =
  | { type: 'lead' | 'para' | 'h2' | 'note'; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; caption?: string; header: string[]; rows: string[][] }
  | { type: 'figure'; ts: number; caption?: string };
export interface SectionRange { startSec: number; endSec: number }
export interface HandoutSection { heading: string; blocks: HandoutBlock[] }
export type HandoutImages = Map<number, { data: Uint8Array; width: number; height: number; caption: string; mimeType?: 'image/png' | 'image/jpeg' }>;
export interface HandoutDoc {
  title: string; courseName: string; date: string; summary: string;
  sections: HandoutSection[]; images?: HandoutImages;
}

export const FONT = {
  title: '黑体', h1: '黑体', h2: '楷体_GB2312', body: '仿宋_GB2312',
  caption: '楷体_GB2312', tableHead: '黑体', tableBody: '仿宋_GB2312', pageNum: '宋体',
} as const;
/** OOXML 字号为半磅；正文按四号、一级标题按三号。 */
export const SIZE = { title: 32, h1: 32, h2: 28, body: 28, caption: 24, tableBody: 21, pageNum: 28 } as const;
export const LINE_EXACT_28 = { line: 560, lineRule: 'exact' } as const;
export const INDENT_2CH = { firstLineChars: 200 } as const;
export const FIRSTLINE_CHARS_XML = '<w:ind w:firstLineChars="200"/>';
export const PAGE_SETUP = {
  size: { width: 11906, height: 16838 },
  margin: { top: 2098, bottom: 1984, left: 1587, right: 1474 },
} as const;
export const CONTENT_WIDTH_DXA = 8845;
export const FIGURE_MAX_WIDTH = 560;
export const TABLE_BORDERS = { top: 12, bottom: 12, headerBottom: 4, vertical: 0, bodyHorizontal: 0 } as const;
const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];
export const h1Num = (i: number): string => CN_NUM[i] ?? String(i + 1);
export const h2Num = (i: number): string => `（${h1Num(i)}）`;

function cleanInline(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1').replace(/`([^`]+)`/g, '$1').trim() : '';
}
function stripMarker(text: string): string {
  return text.replace(/^[（(][一二三四五六七八九十百\d]+[)）]\s*/, '').replace(/^\d+[.、)）]\s*/, '').replace(/^[-*•●]\s*/, '').trim();
}
function strings(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.length || value.some(v => typeof v !== 'string')) throw new Error(`IR 校验失败：${name} 必须是非空字符串数组`);
  return value.map(cleanInline);
}
function json(raw: string): Record<string, unknown> {
  const text = raw.replace(/```(?:json)?/g, '').trim();
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('模型未返回有效的 JSON');
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}
function timeToSec(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d+:\d{2}(?::\d{2})?$/.test(value.trim())) return null;
  const parts = value.trim().split(':').map(Number);
  if (parts.slice(1).some(n => n >= 60)) return null;
  const sec = parts.reduce((total, n) => total * 60 + n, 0);
  return Number.isFinite(sec) ? sec : null;
}
export function parseHandoutSectionBlocks(raw: string, range: SectionRange): HandoutBlock[] {
  const obj = json(raw);
  if (!Array.isArray(obj.blocks)) throw new Error('IR 校验失败：缺 blocks 数组');
  const blocks: HandoutBlock[] = [];
  for (const value of obj.blocks) {
    const b = value as Record<string, unknown> | null;
    switch (b?.type) {
      case 'lead': case 'para': case 'h2': case 'note': {
        const text = stripMarker(cleanInline(b.text));
        if (text) blocks.push({ type: b.type, text });
        break;
      }
      case 'list': {
        const items = strings(b.items, 'list.items').map(stripMarker).filter(Boolean);
        if (items.length) blocks.push({ type: 'list', ordered: b.ordered === true, items });
        break;
      }
      case 'table': {
        const header = strings(b.header, 'table.header');
        if (header.some(c => !c)) throw new Error('IR 校验失败：table.header 为空');
        if (!Array.isArray(b.rows) || !b.rows.length) throw new Error('IR 校验失败：table.rows 为空');
        const rows = b.rows.map(row => {
          const cells = strings(row, 'table.rows[]');
          if (cells.length !== header.length) throw new Error('IR 校验失败：table 行列数不一致');
          if (cells.some(c => !c)) throw new Error('IR 校验失败：table 单元格为空');
          return cells;
        });
        const caption = cleanInline(b.caption);
        blocks.push({ type: 'table', header, rows, ...(caption ? { caption } : {}) });
        break;
      }
      case 'figure': {
        const ts = timeToSec(b.time);
        if (ts === null || ts < range.startSec || ts > range.endSec) break;
        const caption = cleanInline(b.caption);
        blocks.push({ type: 'figure', ts, ...(caption ? { caption } : {}) });
        break;
      }
      default: throw new Error(`IR 校验失败：未知块类型 ${String(b?.type)}`);
    }
  }
  if (!blocks.length) throw new Error('IR 校验失败：无有效块');
  return blocks;
}

export function parseRewrittenBlock(raw: string, original: HandoutBlock): HandoutBlock {
  const obj = json(raw);
  if (obj.type !== undefined && obj.type !== original.type) throw new Error('改写不得改变块类型');
  if (original.type === 'figure') {
    const caption = cleanInline(obj.caption);
    if (!caption) throw new Error('图注改写结果为空');
    return { ...original, caption };
  }
  const [block] = parseHandoutSectionBlocks(JSON.stringify({ blocks: [{ ...obj, type: original.type }] }), { startSec: 0, endSec: Infinity });
  // parseHandoutSectionBlocks 无有效块时已经抛错；这里收窄判别式，避免联合类型逐个索引。
  if (block === undefined) throw new Error('IR 校验失败：改写结果无有效块');
  if (original.type === 'table' && block.type === 'table' && (block.header.length !== original.header.length || block.rows.length !== original.rows.length)) throw new Error('改写必须保持表格行列维度');
  return original.type === 'list' && block.type === 'list' ? { ...block, ordered: original.ordered } : block;
}
export interface RewriteContext { title: string; heading?: string; prev?: string; next?: string }
/** 注入模型调用，保持宿主与具体模型供应商解耦；失败最多重试一次。 */
export async function rewriteHandoutSection(
  section: HandoutSection, instruction: string,
  generate: (prompt: string, signal?: AbortSignal) => Promise<string>,
  context: RewriteContext, signal?: AbortSignal,
): Promise<HandoutSection> {
  const blocks: HandoutBlock[] = [];
  for (const block of section.blocks) {
    const prompt = `改写讲义单块，只返回 JSON。保持块类型、列表结构、表格行列数；配图只改图注，不改时间。\n上下文：${JSON.stringify(context)}\n要求：${instruction}\n原文：${JSON.stringify(block)}`;
    for (let attempt = 0; attempt < 2; attempt++) {
      signal?.throwIfAborted();
      try {
        blocks.push(parseRewrittenBlock(await generate(prompt, signal), block));
        break;
      } catch (error) {
        signal?.throwIfAborted();
        if (attempt || [400, 401, 403].includes((error as { status?: number })?.status ?? 0)) throw error;
      }
    }
  }
  return { ...section, blocks };
}

export function escapeHandoutXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
/** 可直接嵌入 OOXML 页脚；奇页右对齐、偶页左对齐。 */
export function renderHandoutPageNumberXml(odd: boolean): string {
  const run = (text: string) => `<w:r><w:rPr><w:rFonts w:eastAsia="宋体"/><w:sz w:val="28"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r>`;
  return `<w:p><w:pPr><w:jc w:val="${odd ? 'right' : 'left'}"/></w:pPr>${odd ? '' : run('　')}${run('— ')}<w:fldSimple w:instr="PAGE"/>${run(' —')}${odd ? run('　') : ''}</w:p>`;
}

/** 自包含 HTML，封面与目录不编号，正文页码从 1 起。 */
export function renderHandoutDocumentHtml(doc: HandoutDoc): string {
  const e = escapeHandoutXml;
  const sections = doc.sections.map((section, index) => {
    let sub = 0, figure = 0, table = 0;
    const content = section.blocks.map(block => {
      switch (block.type) {
        case 'lead': case 'para': case 'note': return `<p class="${block.type}">${e(block.text)}</p>`;
        case 'h2': return `<h3>${h2Num(sub++)}${e(block.text)}</h3>`;
        case 'list': {
          const tag = block.ordered ? 'ol' : 'ul';
          return `<${tag}>${block.items.map(item => `<li>${e(item)}</li>`).join('')}</${tag}>`;
        }
        case 'table': return `<table><caption>表 ${index + 1}-${++table} ${e(block.caption ?? '数据对比')}</caption><thead><tr>${block.header.map(c => `<th scope="col">${e(c)}</th>`).join('')}</tr></thead><tbody>${block.rows.map(row => `<tr>${row.map(c => `<td>${e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
        case 'figure': {
          const image = doc.images?.get(block.ts);
          if (!image) return '';
          const mime = image.mimeType ?? (image.data[0] === 0xff && image.data[1] === 0xd8 ? 'image/jpeg' : 'image/png');
          const width = Math.min(image.width, FIGURE_MAX_WIDTH);
          const caption = `图 ${index + 1}-${++figure} ${block.caption ?? image.caption}`;
          return `<figure><img src="data:${mime};base64,${Buffer.from(image.data).toString('base64')}" width="${width}" height="${Math.round(image.height * width / image.width)}" alt="${e(caption)}"/><figcaption>${e(caption)}</figcaption></figure>`;
        }
      }
    }).join('');
    return `<section id="section-${index + 1}"><h2>${h1Num(index)}、${e(section.heading)}</h2>${content}</section>`;
  }).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${e(doc.title)}</title><style>
@page{size:A4;margin:3.7cm 2.6cm 3.5cm 2.8cm}
@page body:right{@bottom-right{content:"— " counter(page) " —　";font:14pt "宋体"}}
@page body:left{@bottom-left{content:"　— " counter(page) " —";font:14pt "宋体"}}
body{font:14pt "${FONT.body}",serif;line-height:28pt;color:#000;background:#fff}
.cover,.toc{break-after:page}.cover{text-align:center;padding-top:112pt}.cover p{text-indent:0;font-family:"楷体_GB2312"}
h1,h2{font:16pt "黑体";line-height:28pt}h1{text-align:center}h2,h3{break-after:avoid}
h3,.note{font:14pt "楷体_GB2312";line-height:28pt}p,h2,h3{text-indent:2em;orphans:2;widows:2}
main{page:body;counter-reset:page 1}.toc a{color:inherit;text-decoration:none}
table{width:100%;border-collapse:collapse;border-top:1.5pt solid;border-bottom:1.5pt solid;font-size:10.5pt;break-inside:avoid}
thead{border-bottom:.5pt solid;font-family:"黑体"}th,td{border:0;padding:4pt;text-align:left}th{text-align:center}
caption,figcaption{font:12pt "楷体_GB2312";line-height:28pt;text-align:center}figure{text-align:center;break-inside:avoid}img{max-width:100%;height:auto}.date{text-align:right;padding-right:4em}
</style></head><body><section class="cover"><h1>${e(doc.title)}</h1><p>课程：${e(doc.courseName)}</p><p>${e(doc.date)}</p></section><nav class="toc"><h1>目　录</h1>${doc.sections.map((s, i) => `<p><a href="#section-${i + 1}">${h1Num(i)}、${e(s.heading)}</a></p>`).join('')}</nav><main><header>${e(doc.title)}</header>${doc.summary.trim() ? `<p class="summary">${e(doc.summary.trim())}</p>` : ''}${sections}<p class="date">${e(doc.date)}</p></main></body></html>`;
}
