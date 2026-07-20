/**
 * 将简单 Markdown 列表/标题解析为节点森林（供粘贴为子树）
 *
 * 支持：
 * - 无序（- * + • ‣ ◦）/ 有序（1. 1)）列表与 # 标题层级；
 * - 任务列表 `- [ ]` / `- [x]`（解析为节点 completed 状态）；
 * - tab 缩进与 2/3/4 空格等任意缩进步长（按整篇文本的缩进公约数自适应）；
 * - 无标记的缩进续行并入上一节点（`> ` 前缀会被剥离，成为备注）。
 */

import { nanoid } from 'nanoid';
import type { MindMapNode } from '../types';

const MAX_PASTE_DEPTH = 100;
const MAX_PASTE_NODES = 10000;

/** 判断剪贴板文本是否像 Markdown 列表/标题层级 */
export function looksLikeMarkdownList(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, '    '))
    .filter((l) => l.trim().length > 0);
  if (lines.length === 0) return false;

  // 单行也识别显式列表项 / 标题（如 `- item`），粘贴为单个节点
  if (lines.length === 1) {
    return /^\s*(?:[-*+•‣◦]|#{1,6}|\d+[.)])\s+\S/.test(lines[0]);
  }

  let bulletOrHeading = 0;
  let ordered = 0;
  for (const line of lines) {
    if (/^\s*[-*+•‣◦]\s+\S/.test(line) || /^\s*#{1,6}\s+\S/.test(line)) {
      bulletOrHeading += 1;
    } else if (/^\s*\d+[.)]\s+\S/.test(line)) {
      ordered += 1;
    }
  }

  // 无序/标题：≥2 行，或 1 行 + 缩进续行
  if (bulletOrHeading >= 2) return true;
  if (bulletOrHeading >= 1 && lines.some((l) => /^\s{2,}\S/.test(l))) return true;

  // 有序：要求每一行都是列表项（避免「1. 散文\n2. 散文\n续写」误判）
  if (ordered >= 2 && ordered === lines.length) return true;

  // 纯文本大纲常只有缩进，没有项目符号；要求至少一行顶格、一行缩进。
  const hasRootLine = lines.some((line) => /^\S/.test(line));
  const hasIndentedLine = lines.some((line) => /^\s{2,}\S/.test(line));
  if (bulletOrHeading === 0 && ordered === 0 && hasRootLine && hasIndentedLine) return true;

  return false;
}

/**
 * 从办公文档/网页剪贴板 HTML 中提取标题与列表，转换成现有 Markdown 树解析器可读的文本。
 * 返回 null 表示 HTML 不包含可识别的结构，调用方应保留普通行内粘贴。
 */
export function htmlOutlineToMarkdown(html: string): string | null {
  if (!html.trim() || typeof DOMParser === 'undefined') return null;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const lines: string[] = [];

  const cleanText = (value: string | null | undefined) =>
    (value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();

  const appendList = (list: Element, depth: number) => {
    const ordered = list.tagName.toLowerCase() === 'ol';
    const items = Array.from(list.children).filter(
      (child) => child.tagName.toLowerCase() === 'li',
    );
    items.forEach((item, index) => {
      const clone = item.cloneNode(true) as Element;
      clone.querySelectorAll('ul, ol').forEach((nested) => nested.remove());
      const text = cleanText(clone.textContent);
      if (text) {
        const marker = ordered ? `${index + 1}.` : '-';
        lines.push(`${'  '.repeat(depth)}${marker} ${text}`);
      }
      Array.from(item.children)
        .filter((child) => /^(UL|OL)$/i.test(child.tagName))
        .forEach((nested) => appendList(nested, depth + 1));
    });
  };

  const appendElement = (element: Element) => {
    const heading = element.tagName.match(/^H([1-6])$/i);
    if (heading) {
      const text = cleanText(element.textContent);
      if (text) lines.push(`${'#'.repeat(Number(heading[1]))} ${text}`);
      return;
    }
    if (/^(UL|OL)$/i.test(element.tagName)) {
      appendList(element, 0);
      return;
    }

    // 办公文档可能会把列表复制成带 mso-list/MsoListParagraph 的段落。
    if (element.tagName.toLowerCase() === 'p') {
      const className = element.getAttribute('class') ?? '';
      const style = element.getAttribute('style') ?? '';
      if (/MsoListParagraph/i.test(className) || /mso-list/i.test(style)) {
        const margin = Number(style.match(/margin-left:\s*([\d.]+)pt/i)?.[1] ?? 0);
        const depth = Math.max(0, Math.round(margin / 36) - 1);
        const text = cleanText(element.textContent).replace(/^[-*+•‣◦]\s*/, '');
        if (text) lines.push(`${'  '.repeat(depth)}- ${text}`);
      }
      return;
    }

    Array.from(element.children).forEach(appendElement);
  };

  Array.from(doc.body.children).forEach(appendElement);

  return lines.length > 0 ? lines.join('\n') : null;
}

interface ParsedLine {
  level: number;
  text: string;
  /** 任务列表项：`- [ ]` → false，`- [x]` → true；非任务项为 undefined */
  completed?: boolean;
}

/**
 * 根据整篇文本实际出现的缩进宽度推断缩进步长（公约数）。
 * 兼容 2/3/4 空格与 tab（tab 已预先展开为 4 空格）；无缩进时默认 2。
 */
function computeIndentUnit(indents: number[]): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let unit = 0;
  for (const indent of indents) {
    if (indent > 0) unit = gcd(unit, indent);
  }
  return unit > 0 ? unit : 2;
}

/**
 * 续行反转义：还原导出侧（exporters.escapeMarkdownNoteLine）为防止备注行
 * 被误判为子节点 / 被 `>` 前缀剥离逻辑破坏而添加的 `\` 前缀。
 * 文件导入与剪贴板粘贴共用本解析器，因此在这里做对称还原。
 */
function unescapeContinuationLine(line: string): string {
  return line.replace(/^\\(?=[-*+•‣◦]\s|\d+[.)]\s|>)/, '');
}

/** 提取任务列表标记：`[ ] 文本` / `[x] 文本` → { completed, text } */
function extractTaskMarker(text: string): { text: string; completed?: boolean } {
  const taskMatch = text.match(/^\[([ xX])\]\s+(.+)$/);
  if (!taskMatch) return { text };
  return { text: taskMatch[2], completed: taskMatch[1] !== ' ' };
}

function parseMarkdownLines(markdown: string): ParsedLine[] {
  const lines = markdown.split('\n').map((line) => line.replace(/\t/g, '    ').trimEnd());
  const parsed: ParsedLine[] = [];
  let lastHeadingLevel = 0;
  const hasExplicitMarkers = lines.some((line) =>
    /^\s*(?:#{1,6}\s+|[-*+•‣◦]\s+|\d+[.)]\s+)/.test(line),
  );

  // 预扫描所有会生成节点的行的缩进宽度，推断缩进步长（tab / 3 空格等容错）
  const indentSamples: number[] = [];
  for (const line of lines) {
    if (!line) continue;
    const marked = line.match(/^(\s*)(?:[-*+•‣◦]|\d+[.)])\s+\S/);
    if (marked) {
      indentSamples.push(marked[1].length);
    } else if (!hasExplicitMarkers) {
      const plain = line.match(/^(\s*)\S/);
      if (plain) indentSamples.push(plain[1].length);
    }
  }
  const indentUnit = computeIndentUnit(indentSamples);
  const indentToLevel = (indent: number): number =>
    indent <= 0 ? 0 : Math.round(indent / indentUnit);

  for (const trimmed of lines) {
    if (!trimmed) continue;

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      const level = headingMatch[1].length - 1;
      lastHeadingLevel = level;
      parsed.push({ level, text: headingMatch[2] });
      continue;
    }

    const listMatch = trimmed.match(/^(\s*)[-*+•‣◦]\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1].length;
      const level = lastHeadingLevel + 1 + indentToLevel(indent);
      const { text, completed } = extractTaskMarker(listMatch[2]);
      parsed.push({ level, text, completed });
      continue;
    }

    if (!hasExplicitMarkers) {
      const indentMatch = trimmed.match(/^(\s*)(.+)$/);
      if (indentMatch) {
        parsed.push({
          level: indentToLevel(indentMatch[1].length),
          text: indentMatch[2],
        });
      }
      continue;
    }

    const orderedMatch = trimmed.match(/^(\s*)\d+[.)]\s+(.+)$/);
    if (orderedMatch) {
      const indent = orderedMatch[1].length;
      const level = lastHeadingLevel + 1 + indentToLevel(indent);
      const { text, completed } = extractTaskMarker(orderedMatch[2]);
      parsed.push({ level, text, completed });
      continue;
    }

    // 无标记的续行：并入上一节点文本（`> ` 前缀剥离、`\` 转义还原后成为备注行）
    if (parsed.length > 0) {
      const indentMatch = trimmed.match(/^(\s*)(.+)$/);
      if (indentMatch) {
        parsed[parsed.length - 1].text +=
          '\n' + unescapeContinuationLine(indentMatch[2].replace(/^>\s*/, ''));
      }
    }
  }

  return parsed;
}

function createNodeFromLine(line: ParsedLine): MindMapNode {
  const parts = line.text.split('\n');
  return {
    id: `node_${nanoid(10)}`,
    text: parts[0] ?? '',
    note: parts.length > 1 ? parts.slice(1).join('\n') : undefined,
    children: [],
    ...(line.completed !== undefined ? { completed: line.completed } : {}),
  };
}

/**
 * 解析 Markdown 列表/标题为节点森林（相对最小缩进归一化）。
 * 不创建虚拟根；返回的数组可直接作为某节点的 children 追加。
 */
export function markdownListToNodes(md: string): MindMapNode[] {
  const parsed = parseMarkdownLines(md);
  if (parsed.length === 0) return [];

  const minLevel = Math.min(...parsed.map((line) => line.level));
  const roots: MindMapNode[] = [];
  const stack: { node: MindMapNode; level: number }[] = [];
  let nodeCount = 0;

  for (const line of parsed) {
    const level = line.level - minLevel;
    if (level > MAX_PASTE_DEPTH) {
      throw new Error(`Markdown depth exceeds maximum limit (${MAX_PASTE_DEPTH})`);
    }

    nodeCount += 1;
    if (nodeCount > MAX_PASTE_NODES) {
      throw new Error(`Node count exceeds maximum limit (${MAX_PASTE_NODES})`);
    }

    const newNode = createNodeFromLine(line);

    while (stack.length > 0 && stack[stack.length - 1].level >= level) {
      stack.pop();
    }

    if (stack.length === 0) {
      roots.push(newNode);
    } else {
      stack[stack.length - 1].node.children.push(newNode);
    }

    stack.push({ node: newNode, level });
  }

  return roots;
}
