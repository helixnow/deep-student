/**
 * 笔记 Markdown → DOCX spec（后端 `generate_docx_from_spec` 的输入）。纯函数，便于单测。
 *
 * - 标题 / 段落 / 列表 / 表格 / 代码 / 引用（→ note 段）/ 图片（→ image 块，图注取紧随其后的
 *   整段斜体，或图片 alt）；表格前的整段加粗视为表名。
 * - 图片 src 原样下发：`notes_assets/…` 由后端在应用数据目录内解析，`data:` 直接内嵌，
 *   远程图片后端不联网，退化为占位文字。
 * - `[媒体@id:mm:ss]` 时间戳锚点在 Word 中渲染为「[mm:ss]」（资源 ID 对读者无意义）。
 */
import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import type { RootContent as Content, Root, PhrasingContent, Paragraph, List, Table, Image } from 'mdast';

export type DocxTemplate = 'default' | 'handout';

export type DocxBlock =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string; role?: 'note' | 'caption'; bold?: boolean }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'table'; rows: string[][]; header?: boolean; caption?: string }
  | { type: 'code'; text: string }
  | { type: 'image'; src?: string; data?: string; caption?: string; alt?: string };

export interface DocxSpec {
  title: string;
  template?: 'handout';
  subtitle?: string;
  date?: string;
  blocks: DocxBlock[];
}

const MEDIA_ANCHOR_RE = /\[媒体@[^\]:\s]+:((?:\d+:)?\d{1,2}:\d{2})\]/g;
const FRONT_MATTER_RE = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;

export function stripFrontMatter(markdown: string): string {
  return markdown.replace(FRONT_MATTER_RE, '');
}

function cleanText(text: string): string {
  return text.replace(MEDIA_ANCHOR_RE, '[$1]').replace(/[ \t]+\n/g, '\n').trim();
}

function phrasingText(nodes: PhrasingContent[]): string {
  let out = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text':
      case 'inlineCode':
        out += n.value;
        break;
      case 'break':
        out += '\n';
        break;
      case 'image':
        break; // 图片单独成块
      case 'html':
        out += n.value.replace(/<[^>]+>/g, '');
        break;
      default:
        if ('value' in n && typeof (n as { value?: unknown }).value === 'string') {
          out += (n as { value: string }).value; // inlineMath 等
        } else if ('children' in n) {
          out += phrasingText((n as { children: PhrasingContent[] }).children);
        }
    }
  }
  return out;
}

function nodeText(node: Content): string {
  if ('children' in node && Array.isArray(node.children)) {
    const children = node.children as Content[];
    if (node.type === 'paragraph' || node.type === 'heading' || node.type === 'tableCell') {
      return phrasingText(children as PhrasingContent[]);
    }
    return children.map(nodeText).filter(Boolean).join('\n');
  }
  return 'value' in node && typeof node.value === 'string' ? node.value : '';
}

function collectImages(nodes: PhrasingContent[], out: Image[] = []): Image[] {
  for (const n of nodes) {
    if (n.type === 'image') out.push(n);
    else if ('children' in n) collectImages((n as { children: PhrasingContent[] }).children, out);
  }
  return out;
}

/** 整段只有一个强调/加粗子节点（允许首尾空白文本） */
function soleWrapped(p: Paragraph, type: 'emphasis' | 'strong'): string | null {
  const meaningful = p.children.filter((c) => !(c.type === 'text' && !c.value.trim()));
  if (meaningful.length !== 1 || meaningful[0].type !== type) return null;
  return cleanText(phrasingText(meaningful[0].children));
}

function imageBlock(img: Image): DocxBlock {
  const src = img.url ?? '';
  const alt = (img.alt ?? '').trim();
  const base = src.startsWith('data:') ? { data: src } : { src };
  return { type: 'image', ...base, ...(alt ? { alt } : {}) };
}

function listItems(list: List, depth = 0): string[] {
  const items: string[] = [];
  for (const item of list.children) {
    const parts: string[] = [];
    for (const child of item.children) {
      if (child.type === 'list') continue;
      const text = cleanText(nodeText(child));
      if (text) parts.push(text);
    }
    const checkbox = item.checked === true ? '☑ ' : item.checked === false ? '☐ ' : '';
    if (parts.length) items.push(`${'    '.repeat(depth)}${depth > 0 ? '– ' : ''}${checkbox}${parts.join(' ')}`);
    for (const child of item.children) {
      if (child.type === 'list') items.push(...listItems(child, depth + 1));
    }
  }
  return items;
}

function tableRows(table: Table): string[][] {
  return table.children.map((row) => row.children.map((cell) => cleanText(nodeText(cell))));
}

export function markdownToDocxBlocks(markdown: string): DocxBlock[] {
  const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(stripFrontMatter(markdown)) as Root;
  const blocks: DocxBlock[] = [];
  const nodes = tree.children as Content[];

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    switch (node.type) {
      case 'heading': {
        const text = cleanText(nodeText(node));
        if (text) blocks.push({ type: 'heading', level: node.depth, text });
        break;
      }
      case 'paragraph': {
        const images = collectImages(node.children);
        const next = nodes[i + 1];
        // 表名：整段加粗 + 紧跟表格
        const strong = soleWrapped(node, 'strong');
        if (strong && next?.type === 'table') {
          blocks.push({ type: 'table', rows: tableRows(next), header: true, caption: strong });
          i++;
          break;
        }
        const text = cleanText(phrasingText(node.children));
        if (text) blocks.push({ type: 'paragraph', text });
        if (images.length) {
          const imgBlocks = images.map(imageBlock);
          // 图注：紧随其后的整段斜体
          const caption = next?.type === 'paragraph' ? soleWrapped(next, 'emphasis') : null;
          if (caption) {
            const last = imgBlocks[imgBlocks.length - 1] as Extract<DocxBlock, { type: 'image' }>;
            last.caption = caption;
            i++;
          }
          blocks.push(...imgBlocks);
        }
        break;
      }
      case 'blockquote': {
        const text = cleanText(nodeText(node));
        if (text) blocks.push({ type: 'paragraph', role: 'note', text });
        break;
      }
      case 'list': {
        const items = listItems(node);
        if (items.length) blocks.push({ type: 'list', ordered: node.ordered === true, items });
        break;
      }
      case 'table':
        blocks.push({ type: 'table', rows: tableRows(node), header: true });
        break;
      case 'code':
        blocks.push({ type: 'code', text: node.value });
        break;
      case 'math':
        blocks.push({ type: 'code', text: node.value });
        break;
      case 'html': {
        const text = cleanText(node.value.replace(/<[^>]+>/g, ''));
        if (text) blocks.push({ type: 'paragraph', text });
        break;
      }
      default: {
        const text = cleanText(nodeText(node));
        if (text) blocks.push({ type: 'paragraph', text });
      }
    }
  }
  return blocks;
}

/**
 * 组装 spec。文档标题优先用笔记标题；正文首个一级标题与之相同则去重。
 */
export function markdownToDocxSpec(
  markdown: string,
  opts: { title: string; template: DocxTemplate; date?: string },
): DocxSpec {
  let blocks = markdownToDocxBlocks(markdown);
  const title = opts.title.trim();
  const first = blocks[0];
  if (first?.type === 'heading' && first.level === 1 && (first.text === title || !title)) {
    blocks = blocks.slice(1);
  }
  const resolvedTitle = title || (first?.type === 'heading' ? first.text : '');
  if (opts.template === 'handout') {
    // 讲义版式：Markdown 一级标题被文档标题占用，正文标题整体上提一级
    const minLevel = Math.min(
      ...blocks.filter((b): b is Extract<DocxBlock, { type: 'heading' }> => b.type === 'heading').map((b) => b.level),
    );
    if (Number.isFinite(minLevel) && minLevel > 1) {
      const shift = minLevel - 1;
      blocks = blocks.map((b) => (b.type === 'heading' ? { ...b, level: b.level - shift } : b));
    }
    return { title: resolvedTitle, template: 'handout', ...(opts.date ? { date: opts.date } : {}), blocks };
  }
  return { title: resolvedTitle, blocks };
}
