/**
 * 讲义 IR → 笔记 Markdown。每节以 `[媒体@<resource_id>:<mm:ss>]` 锚点开头（契约 §2），
 * 配图写成 `![图注](notes_assets/...)` + 图注行。
 */
import { formatClock, type Block, type HandoutSection } from './ir';
import type { HandoutLang } from './prompts';

const CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

export interface HandoutMarkdownInput {
  resourceId: string;
  title: string;
  summary: string;
  sections: HandoutSection[];
  lang: HandoutLang;
  /** 配图时间（秒）→ 笔记资产相对路径；缺失的配图被省略 */
  images?: Map<number, string>;
}

export function mediaAnchor(resourceId: string, sec: number): string {
  return `[媒体@${resourceId}:${formatClock(sec)}]`;
}

/** 单行化 + 转义会破坏 Markdown 结构的字符 */
function inline(text: string): string {
  return text.replace(/\s*\n\s*/g, ' ').trim();
}

function cell(text: string): string {
  return inline(text).replace(/\|/g, '\\|');
}

function sectionHeading(i: number, heading: string, lang: HandoutLang): string {
  return lang === 'zh' ? `${CN_NUM[i] ?? String(i + 1)}、${heading}` : `${i + 1}. ${heading}`;
}

function figureLabel(n: number, lang: HandoutLang): string {
  return lang === 'zh' ? `图 ${n}` : `Figure ${n}`;
}

function tableLabel(n: number, lang: HandoutLang): string {
  return lang === 'zh' ? `表 ${n}` : `Table ${n}`;
}

function renderBlocks(
  blocks: Block[],
  ctx: { lang: HandoutLang; images?: Map<number, string>; fig: { n: number }; tbl: { n: number } },
): string[] {
  const out: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'lead':
      case 'para':
        out.push(inline(b.text));
        break;
      case 'h2':
        out.push(`### ${inline(b.text)}`);
        break;
      case 'note':
        out.push(`> ${inline(b.text)}`);
        break;
      case 'list':
        out.push(b.items.map((it, i) => (b.ordered ? `${i + 1}. ${inline(it)}` : `- ${inline(it)}`)).join('\n'));
        break;
      case 'table': {
        ctx.tbl.n++;
        const caption = `${tableLabel(ctx.tbl.n, ctx.lang)}${b.caption ? ` ${inline(b.caption)}` : ''}`;
        const head = `| ${b.header.map(cell).join(' | ')} |`;
        const sep = `| ${b.header.map(() => '---').join(' | ')} |`;
        const rows = b.rows.map((r) => `| ${r.map(cell).join(' | ')} |`);
        out.push(`**${caption}**`);
        out.push([head, sep, ...rows].join('\n'));
        break;
      }
      case 'figure': {
        const src = ctx.images?.get(b.ts);
        if (!src) break;
        ctx.fig.n++;
        const caption = `${figureLabel(ctx.fig.n, ctx.lang)}${b.caption ? ` ${inline(b.caption)}` : ''}`;
        out.push(`![${caption.replace(/[[\]]/g, '')}](${src})`);
        out.push(`*${caption}*`);
        break;
      }
    }
  }
  return out;
}

export function handoutToMarkdown(input: HandoutMarkdownInput): string {
  const { resourceId, title, summary, sections, lang, images } = input;
  const parts: string[] = [`# ${inline(title)}`];
  if (summary.trim()) parts.push(inline(summary));
  const fig = { n: 0 };
  const tbl = { n: 0 };
  sections.forEach((s, i) => {
    parts.push(`## ${sectionHeading(i, inline(s.heading), lang)}`);
    parts.push(mediaAnchor(resourceId, s.startSec));
    parts.push(...renderBlocks(s.blocks, { lang, images, fig, tbl }));
  });
  return `${parts.join('\n\n')}\n`;
}
