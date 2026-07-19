/**
 * 将简单 Markdown 列表/标题解析为节点森林（供粘贴为子树）
 */

import { nanoid } from 'nanoid';
import type { MindMapNode } from '../types';

const MAX_PASTE_DEPTH = 100;
const MAX_PASTE_NODES = 10000;

/** 判断剪贴板文本是否像 Markdown 列表/标题层级（多行） */
export function looksLikeMarkdownList(text: string): boolean {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.replace(/\t/g, '    '))
    .filter((l) => l.trim().length > 0);
  if (lines.length < 2) return false;

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

  // 幕布/纯文本导出常只有缩进，没有项目符号；要求至少一行顶格、一行缩进。
  const hasRootLine = lines.some((line) => /^\S/.test(line));
  const hasIndentedLine = lines.some((line) => /^\s{2,}\S/.test(line));
  if (bulletOrHeading === 0 && ordered === 0 && hasRootLine && hasIndentedLine) return true;

  return false;
}

/**
 * 从 Word/网页剪贴板 HTML 中提取标题与列表，转换成现有 Markdown 树解析器可读的文本。
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

    // Word 会把列表复制成带 mso-list/MsoListParagraph 的段落。
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
}

/** 缩进 → 层级：2 空格或 4 空格一档（取常见缩进步长） */
function indentToLevel(indent: number): number {
  if (indent <= 0) return 0;
  // 优先按 2 空格；若全是 4 的倍数也正确（4→2, 8→4）
  return Math.floor(indent / 2);
}

function parseMarkdownLines(markdown: string): ParsedLine[] {
  const lines = markdown.split('\n');
  const parsed: ParsedLine[] = [];
  let lastHeadingLevel = 0;
  const hasExplicitMarkers = lines.some((line) =>
    /^\s*(?:#{1,6}\s+|[-*+•‣◦]\s+|\d+[.)]\s+)/.test(line.replace(/\t/g, '    ')),
  );

  for (const rawLine of lines) {
    const trimmed = rawLine.replace(/\t/g, '    ').trimEnd();
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
      parsed.push({ level, text: listMatch[2] });
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
      parsed.push({ level, text: orderedMatch[2] });
      continue;
    }

    // 无标记的续行：并入上一节点文本
    if (parsed.length > 0) {
      const indentMatch = trimmed.match(/^(\s*)(.+)$/);
      if (indentMatch) {
        parsed[parsed.length - 1].text += '\n' + indentMatch[2].replace(/^>\s*/, '');
      }
    }
  }

  return parsed;
}

function createNodeFromText(text: string): MindMapNode {
  const parts = text.split('\n');
  return {
    id: `node_${nanoid(10)}`,
    text: parts[0] ?? '',
    note: parts.length > 1 ? parts.slice(1).join('\n') : undefined,
    children: [],
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

    const newNode = createNodeFromText(line.text);

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
