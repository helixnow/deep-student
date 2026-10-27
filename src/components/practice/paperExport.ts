import { invoke } from '@tauri-apps/api/core';
import i18n from '@/i18n';
import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { GeneratedPaper } from '@/stores/questionBankStore';
import {
  buildPaperSections,
  sectionsToMarkdown,
  type PaperDocumentOptions,
  type PaperSection,
} from './paperDocument';
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { Root, RootContent, PhrasingContent } from 'mdast';
import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';

export interface PaperExportOptions extends PaperDocumentOptions {
  format: 'pdf' | 'word' | 'markdown';
}
export interface PaperRun {
  text?: string;
  image?: string;
  width?: number;
  height?: number;
  bold?: boolean;
  italic?: boolean;
}
export interface PaperBlock {
  kind: 'paragraph' | 'heading' | 'table' | 'image' | 'space';
  runs?: PaperRun[];
  level?: number;
  rows?: PaperRun[][][];
  image?: string;
  width?: number;
  height?: number;
  lines?: number;
  page_break?: boolean;
  pdf_images?: PaperRun[];
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function attachment(id: string, mime?: string): Promise<string> {
  const result = await invoke<{ found: boolean; content: string | null }>(
    'vfs_get_attachment_content',
    { attachmentId: id },
  );
  if (!result.found || !result.content)
    throw new Error(i18n.t('practice:batch.imageMissing') + ` (${id})`);
  return `data:${mime || 'image/png'};base64,${result.content}`;
}

async function imageData(src: string): Promise<string> {
  if (src.startsWith('data:image/')) return src;
  if (src.startsWith('attachment://')) return attachment(src.slice('attachment://'.length));
  // Export only readable assets; do not silently produce an incomplete paper.
  const response = await fetch(src);
  if (!response.ok) throw new Error(`${i18n.t('practice:batch.imageMissing')}: ${src}`);
  return blobDataUrl(await response.blob());
}

async function portableMarkdown(markdown: string): Promise<string> {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as Root;
  const replacements: { start: number; end: number; text: string }[] = [];
  const visit = async (node: Root | RootContent | PhrasingContent): Promise<void> => {
    if (node.type === 'image' && node.position?.start.offset != null && node.position.end.offset != null) {
      const data = await imageData(node.url);
      const alt = node.alt?.replace(/[[\]\\]/g, '\\$&') ?? '';
      replacements.push({ start: node.position.start.offset, end: node.position.end.offset, text: `![${alt}](${data})` });
    } else if (node.type === 'definition' && node.position?.start.offset != null && node.position.end.offset != null) {
      const usedAsImage = (candidate: Root | RootContent | PhrasingContent): boolean =>
        (candidate.type === 'imageReference' && candidate.identifier === node.identifier)
        || ('children' in candidate && candidate.children.some(child => usedAsImage(child as RootContent)));
      if (usedAsImage(tree)) replacements.push({ start: node.position.start.offset, end: node.position.end.offset, text: `[${node.identifier}]: ${await imageData(node.url)}` });
    }
    if ('children' in node) for (const child of node.children) await visit(child as RootContent);
  };
  await visit(tree);
  for (const replacement of replacements.sort((a, b) => b.start - a.start))
    markdown = markdown.slice(0, replacement.start) + replacement.text + markdown.slice(replacement.end);
  return markdown;
}

export async function formulaImage(latex: string, display: boolean): Promise<PaperRun> {
  const [{ default: katex }, { snapdom }] = await Promise.all([
    import('katex'),
    import('@zumer/snapdom'),
  ]);
  await import('katex/contrib/mhchem');
  await import('katex/dist/katex.min.css');
  const element = document.createElement('div');
  element.style.cssText =
    'position:fixed;left:0;top:0;z-index:-1;display:inline-block;width:max-content;max-width:650px;padding:4px;color:#000;background:#fff;font-size:16px;line-height:1.5;';
  element.innerHTML = katex.renderToString(latex, {
    output: 'html',
    displayMode: display,
    throwOnError: true,
    trust: false,
    strict: 'ignore',
  });
  document.body.appendChild(element);
  try {
    await document.fonts.ready;
    const bounds = element.getBoundingClientRect();
    const capture = await snapdom(element, {
      scale: 3,
      dpr: 1,
      embedFonts: true,
      backgroundColor: '#ffffff',
    });
    const blob = await capture.toBlob({ type: 'png' });
    return {
      image: await blobDataUrl(blob),
      width: Math.min(490, bounds.width * 0.75),
      height: bounds.height * 0.75,
    };
  } finally {
    element.remove();
  }
}

async function runs(
  nodes: PhrasingContent[],
  style: Pick<PaperRun, 'bold' | 'italic'> = {},
): Promise<PaperRun[]> {
  const output: PaperRun[] = [];
  for (const node of nodes) {
    if (node.type === 'inlineMath')
      output.push({ ...(await formulaImage(node.value, false)), ...style });
    else if (node.type === 'image')
      output.push({ image: await imageData(node.url), width: 240, ...style });
    else if (node.type === 'break') output.push({ text: '\n' });
    else if (node.type === 'html')
      output.push({ text: node.value.replace(/<[^>]*>/g, ''), ...style });
    else if ('children' in node)
      output.push(
        ...(await runs(node.children as PhrasingContent[], {
          ...style,
          ...(node.type === 'strong' ? { bold: true } : {}),
          ...(node.type === 'emphasis' ? { italic: true } : {}),
        })),
      );
    else if ('value' in node) output.push({ text: String(node.value), ...style });
  }
  return output;
}

async function markdownBlocks(markdown: string): Promise<PaperBlock[]> {
  const root = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(markdown) as Root;
  const output: PaperBlock[] = [];
  const visit = async (node: RootContent): Promise<void> => {
    if (node.type === 'paragraph' || node.type === 'heading')
      output.push({
        kind: node.type === 'heading' ? 'heading' : 'paragraph',
        level: node.type === 'heading' ? node.depth : undefined,
        runs: await runs(node.children),
      });
    else if (node.type === 'math')
      output.push({ kind: 'image', ...(await formulaImage(node.value, true)) });
    else if (node.type === 'table') {
      const rows: PaperRun[][][] = [];
      for (const row of node.children) {
        const cells: PaperRun[][] = [];
        for (const cell of row.children) cells.push(await runs(cell.children));
        rows.push(cells);
      }
      output.push({ kind: 'table', rows });
    } else if (node.type === 'list') {
      for (const [index, item] of node.children.entries()) {
        output.push({
          kind: 'paragraph',
          runs: [{ text: node.ordered ? `${index + 1}. ` : '• ' }],
        });
        for (const child of item.children) await visit(child as RootContent);
      }
    } else if (node.type === 'blockquote') {
      for (const child of node.children) await visit(child);
    } else if ('value' in node)
      output.push({ kind: 'paragraph', runs: [{ text: String(node.value) }] });
  };
  for (const child of root.children) await visit(child);
  return output;
}

export async function preparePaperBlocks(sections: PaperSection[]): Promise<PaperBlock[]> {
  const blocks: PaperBlock[] = [];
  for (const section of sections) {
    if (section.kind === 'heading')
      blocks.push({
        kind: 'heading',
        level: section.level,
        runs: [{ text: section.text }],
        page_break: section.pageBreak,
      });
    else if (section.kind === 'space') blocks.push({ kind: 'space', lines: section.lines });
    else if (section.kind === 'image')
      blocks.push({
        kind: 'image',
        image: await attachment(section.image.id, section.image.mime),
        width: 450,
      });
    else blocks.push(...(await markdownBlocks(section.text)));
  }
  for (const block of blocks) {
    if (block.kind === 'paragraph' && block.runs?.some(run => run.image)) {
      block.pdf_images = await rasterParagraph(block.runs);
    }
  }
  return blocks;
}

let browserFonts: Promise<void> | null = null;
async function loadBrowserFont(): Promise<void> {
  browserFonts ??= Promise.all([['400', 'Regular'], ['700', 'Bold']].map(async ([weight, name]) => {
    const face = new FontFace('PaperExport', `url(/fonts/paper-export/NotoSansSC-${name}.ttf)`, { weight });
    document.fonts.add(await face.load());
  })).then(() => {});
  return browserFonts;
}

/** Only PDF mixed paragraphs are rasterized; DOCX keeps editable text runs. */
async function rasterParagraph(items: PaperRun[]): Promise<PaperRun[]> {
  await loadBrowserFont();
  const { snapdom } = await import('@zumer/snapdom');
  const root = document.createElement('div');
  root.style.cssText = 'position:fixed;left:0;top:0;z-index:-1;width:650px;padding:2px;color:#000;background:#fff;font-family:PaperExport;font-size:15px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;';
  for (const item of items) {
    if (item.image) {
      const image = document.createElement('img'); image.src = item.image;
      image.style.cssText = `display:inline-block;vertical-align:middle;max-width:100%;width:${(item.width ?? 240) / 0.75}px;height:auto;`;
      root.append(image);
    } else {
      const span = document.createElement('span'); span.textContent = item.text ?? '';
      if (item.bold) span.style.fontWeight = '700';
      if (item.italic) span.style.fontStyle = 'italic';
      root.append(span);
    }
  }
  document.body.append(root);
  try {
    await Promise.all([...root.querySelectorAll('img')].map(img => img.decode()));
    const canvas = await (await snapdom(root, { scale: 3, dpr: 1, embedFonts: true, backgroundColor: '#ffffff' })).toCanvas();
    const base = root.getBoundingClientRect();
    const boxes = [...root.childNodes].flatMap(node => {
      if (node instanceof HTMLImageElement) return [node.getBoundingClientRect()];
      const range = document.createRange(); range.selectNodeContents(node); return [...range.getClientRects()];
    }).map(rect => ({ top: rect.top - base.top, bottom: rect.bottom - base.top }));
    const output: PaperRun[] = []; let start = 0;
    while (start < base.height) {
      const max = Math.min(base.height, start + 750);
      let end = max;
      if (max < base.height) {
        const candidates = boxes.map(box => box.bottom + 2).filter(y => y > start && y <= max && !boxes.some(box => box.top < y && box.bottom > y));
        end = candidates.length ? Math.max(...candidates) : max;
      }
      const slice = document.createElement('canvas');
      slice.width = canvas.width; slice.height = Math.max(1, Math.ceil((end - start) * canvas.height / base.height));
      slice.getContext('2d')!.drawImage(canvas, 0, start * canvas.height / base.height, canvas.width, slice.height, 0, 0, slice.width, slice.height);
      output.push({ image: slice.toDataURL('image/png'), width: base.width * 0.75, height: (end - start) * 0.75 });
      start = end;
    }
    return output;
  } finally { root.remove(); }
}

function runContent(run: PaperRun): Content {
  return run.image
    ? { image: run.image, fit: [run.width ?? 450, run.height ?? 480], margin: [0, 3, 0, 5] }
    : { text: run.text ?? '', bold: run.bold, italics: run.italic };
}

export function blocksToPdfContent(blocks: PaperBlock[]): Content[] {
  return blocks.flatMap((block): Content[] => {
    if (block.kind === 'image') return [runContent(block)];
    if (block.kind === 'space') return [{ text: '\n'.repeat(block.lines ?? 1), fontSize: 12 }];
    if (block.kind === 'table')
      return [
        {
          table: {
            headerRows: 1,
            widths: (block.rows?.[0] ?? []).map(() => '*'),
            body: (block.rows ?? []).map((row, index) =>
              row.map((cell) => ({
                stack: splitRuns(cell),
                fillColor: index === 0 ? '#eeeeee' : undefined,
                margin: [4, 4, 4, 4],
              })),
            ),
          },
          layout: {
            hLineColor: () => '#d9d9d9',
            vLineColor: () => '#d9d9d9',
            hLineWidth: () => 0.5,
            vLineWidth: () => 0.5,
          },
          margin: [0, 4, 0, 8],
        },
      ];
    const text = block.pdf_images?.map(runContent) ?? splitRuns(block.runs ?? []);
    if (block.kind === 'heading')
      return [
        {
          stack: text,
          fontSize: block.level === 0 ? 18 : 12,
          bold: true,
          pageBreak: block.page_break ? 'before' : undefined,
          margin: [0, block.level === 0 ? 0 : 12, 0, 8],
          unbreakable: true,
        },
      ];
    return [{ stack: text, margin: [0, 0, 0, 7] }];
  });
}

function splitRuns(items: PaperRun[]): Content[] {
  const output: Content[] = [];
  let text: Content[] = [];
  const flush = () => {
    if (text.length) output.push({ text });
    text = [];
  };
  for (const run of items) {
    if (run.image) {
      flush();
      output.push(runContent(run));
    } else text.push(runContent(run));
  }
  flush();
  return output.length ? output : [{ text: '' }];
}

let fontPromise: Promise<Record<string, string>> | null = null;
export async function paperPdfBytes(blocks: PaperBlock[], title: string): Promise<Uint8Array> {
  const { default: pdfMake } = await import('pdfmake/build/pdfmake');
  fontPromise ??= Promise.all(['Regular', 'Bold'].map(async name => {
      const response = await fetch(`/fonts/paper-export/NotoSansSC-${name}.ttf`);
      if (!response.ok) throw new Error('Paper font unavailable');
      return [`NotoSansSC-${name}.ttf`, (await blobDataUrl(await response.blob())).split(',')[1]];
    })).then(entries => Object.fromEntries(entries))
    .catch((error) => {
      fontPromise = null;
      throw error;
    });
  pdfMake.addVirtualFileSystem(await fontPromise);
  pdfMake.addFonts({
    Paper: {
      normal: 'NotoSansSC-Regular.ttf',
      bold: 'NotoSansSC-Bold.ttf',
      italics: 'NotoSansSC-Regular.ttf',
      bolditalics: 'NotoSansSC-Bold.ttf',
    },
  });
  const spec: TDocumentDefinitions = {
    pageSize: 'A4',
    pageMargins: [50, 48, 50, 48],
    defaultStyle: { font: 'Paper', fontSize: 11, lineHeight: 1.35, color: '#000000' },
    info: { title },
    content: blocksToPdfContent(blocks),
    footer: (page, count) => ({
      text: `${page} / ${count}`,
      alignment: 'center',
      fontSize: 9,
      margin: [0, 12, 0, 0],
    }),
  };
  return new Uint8Array(await pdfMake.createPdf(spec).getBuffer());
}

export async function buildPaperFile(
  paper: GeneratedPaper,
  options: PaperExportOptions,
): Promise<Uint8Array> {
  const t = i18n.getFixedT(null, 'practice');
  const sections = buildPaperSections(paper, options, {
    material: t('batch.material'),
    appendix: t('batch.appendix'),
    answer: t('paper.answer'),
    explanation: t('paper.explanation'),
    questions: t('paper.questions'),
  });
  if (options.format === 'markdown') {
    const markdown = await portableMarkdown(sectionsToMarkdown(sections));
    return new TextEncoder().encode(markdown);
  }
  const blocks = await preparePaperBlocks(sections);
  let data: Uint8Array;
  if (options.format === 'pdf') data = await paperPdfBytes(blocks, paper.title);
  else {
    const base64 = await invoke<string>('qbank_export_paper_docx', { title: paper.title, blocks });
    data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  }
  return data;
}

export async function exportPaperToFile(
  paper: GeneratedPaper,
  options: PaperExportOptions,
): Promise<void> {
  const t = i18n.getFixedT(null, 'practice');
  const filename =
    paper.title
      .replace(/[\\/:*?"<>|\r\n]/g, ' ')
      .trim()
      .slice(0, 80) || 'paper';
  showGlobalNotification('info', t('batch.exporting'));
  const data = await buildPaperFile(paper, options);
  const extension =
    options.format === 'word' ? 'docx' : options.format === 'markdown' ? 'md' : 'pdf';
  const result = await fileManager.saveBinaryFile({
    data,
    defaultFileName: `${filename}.${extension}`,
    title: t('paper.exportTitle'),
    filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
  });
  if (!result.canceled) showGlobalNotification('success', t('paper.exportSuccess'));
}
