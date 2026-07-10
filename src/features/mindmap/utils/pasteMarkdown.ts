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
    if (/^\s*[-*+]\s+\S/.test(line) || /^\s*#{1,6}\s+\S/.test(line)) {
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

  return false;
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

    const listMatch = trimmed.match(/^(\s*)[-*+]\s+(.+)$/);
    if (listMatch) {
      const indent = listMatch[1].length;
      const level = lastHeadingLevel + 1 + indentToLevel(indent);
      parsed.push({ level, text: listMatch[2] });
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
