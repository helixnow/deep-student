/**
 * splitMarkdownBlocks.ts
 *
 * 将 markdown 文本按块级元素拆分，用于流式增量渲染。
 * 已完成的块可被 React.memo 缓存，只有最后一个活跃块需要每帧重渲染。
 */

export type MarkdownBlockType =
  | 'paragraph'
  | 'heading'
  | 'code'
  | 'math'
  | 'list'
  | 'table'
  | 'blockquote'
  | 'hr'
  | 'html';

export interface MarkdownBlock {
  /** 稳定 ID：基于块索引 + 内容前缀 hash，确保已完成块的 key 不变 */
  id: string;
  /** 块类型 */
  type: MarkdownBlockType;
  /** 原始 markdown 文本 */
  raw: string;
  /** 是否已闭合（流式期间最后一个块为 false） */
  isComplete: boolean;
}

/**
 * 简单字符串 hash（FNV-1a 变体），用于生成稳定 block ID
 */
function hashStr(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < Math.min(str.length, 64); i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 检测行是否为代码围栏开始/结束 */
function isCodeFence(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('```') || trimmed.startsWith('~~~');
}

/** 检测行是否为数学块分隔符 $$ */
function isMathFence(line: string): boolean {
  return line.trim().startsWith('$$');
}

/** 检测行是否为标题 */
function isHeading(line: string): boolean {
  return /^#{1,6}\s/.test(line);
}

/** 检测行是否为水平线 */
function isHorizontalRule(line: string): boolean {
  const trimmed = line.trim();
  return /^[-*_]{3,}$/.test(trimmed) && !/\S/.test(trimmed.replace(/[-*_]/g, ''));
}

/** 检测行是否为列表项开始 */
function isListItem(line: string): boolean {
  return /^(\s*)([-*+]|\d+[.)]) /.test(line);
}

/** 检测行是否为表格行 */
function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('|') && trimmed.endsWith('|');
}

/** 检测行是否为表格分隔行 */
function isTableSeparator(line: string): boolean {
  return /^\|?[\s:-]+\|[\s|:-]*$/.test(line.trim());
}

/** 检测行是否为 blockquote */
function isBlockquote(line: string): boolean {
  return /^\s*>/.test(line);
}

/** 检测行是否为 HTML 块 */
function isHtmlBlock(line: string): boolean {
  const trimmed = line.trim();
  return /^<\/?[a-zA-Z][\s\S]*?>/.test(trimmed);
}

/**
 * 将 markdown 内容拆分为块级元素数组。
 *
 * 设计原则：
 * - 贪心匹配：尽可能将连续的同类行归入同一个块
 * - 流式友好：最后一个块标记为 isComplete: false（当 isStreaming=true）
 * - 稳定 ID：已完成块的 ID 不随后续内容追加而改变
 */
export function splitMarkdownBlocks(content: string, isStreaming: boolean): MarkdownBlock[] {
  if (!content) return [];

  const lines = content.split('\n');
  const blocks: MarkdownBlock[] = [];

  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- 代码块（围栏） ---
    if (isCodeFence(line)) {
      const startLine = i;
      i++;
      // 寻找闭合围栏
      let closed = false;
      while (i < lines.length) {
        if (isCodeFence(lines[i])) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      const raw = lines.slice(startLine, i).join('\n');
      blocks.push({
        id: '', // 稍后填充
        type: 'code',
        raw,
        isComplete: closed,
      });
      continue;
    }

    // --- 数学块（$$） ---
    if (isMathFence(line)) {
      const startLine = i;
      i++;
      let closed = false;
      while (i < lines.length) {
        if (isMathFence(lines[i])) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      const raw = lines.slice(startLine, i).join('\n');
      blocks.push({
        id: '',
        type: 'math',
        raw,
        isComplete: closed,
      });
      continue;
    }

    // --- 标题 ---
    if (isHeading(line)) {
      blocks.push({
        id: '',
        type: 'heading',
        raw: line,
        isComplete: true,
      });
      i++;
      continue;
    }

    // --- 水平线 ---
    if (isHorizontalRule(line)) {
      blocks.push({
        id: '',
        type: 'hr',
        raw: line,
        isComplete: true,
      });
      i++;
      continue;
    }

    // --- 表格（连续的表格行） ---
    if (isTableRow(line) || isTableSeparator(line)) {
      const startLine = i;
      while (i < lines.length && (isTableRow(lines[i]) || isTableSeparator(lines[i]))) {
        i++;
      }
      const raw = lines.slice(startLine, i).join('\n');
      blocks.push({
        id: '',
        type: 'table',
        raw,
        isComplete: true,
      });
      continue;
    }

    // --- 列表（连续的列表项 + 缩进续行） ---
    if (isListItem(line)) {
      const startLine = i;
      while (i < lines.length) {
        const curr = lines[i];
        // 列表项、缩进续行、或空行（列表内空行）
        if (isListItem(curr) || /^\s{2,}/.test(curr) || (curr.trim() === '' && i + 1 < lines.length && (isListItem(lines[i + 1]) || /^\s{2,}/.test(lines[i + 1])))) {
          i++;
        } else {
          break;
        }
      }
      const raw = lines.slice(startLine, i).join('\n');
      blocks.push({
        id: '',
        type: 'list',
        raw,
        isComplete: true,
      });
      continue;
    }

    // --- Blockquote（连续的 > 行） ---
    if (isBlockquote(line)) {
      const startLine = i;
      while (i < lines.length && (isBlockquote(lines[i]) || (lines[i].trim() !== '' && !isHeading(lines[i]) && !isCodeFence(lines[i]) && !isListItem(lines[i])))) {
        // 贪心：blockquote 内可以有非 > 开头的续行
        if (!isBlockquote(lines[i]) && lines[i].trim() === '') break;
        i++;
      }
      const raw = lines.slice(startLine, i).join('\n');
      blocks.push({
        id: '',
        type: 'blockquote',
        raw,
        isComplete: true,
      });
      continue;
    }

    // --- HTML 块 ---
    if (isHtmlBlock(line)) {
      const startLine = i;
      i++;
      // HTML 块持续到空行
      while (i < lines.length && lines[i].trim() !== '') {
        i++;
      }
      const raw = lines.slice(startLine, i).join('\n');
      blocks.push({
        id: '',
        type: 'html',
        raw,
        isComplete: true,
      });
      continue;
    }

    // --- 空行：跳过（作为块间分隔） ---
    if (line.trim() === '') {
      i++;
      continue;
    }

    // --- 段落（默认：连续非空行） ---
    {
      const startLine = i;
      while (i < lines.length) {
        const curr = lines[i];
        if (curr.trim() === '') break;
        if (isHeading(curr) || isCodeFence(curr) || isMathFence(curr) || isHorizontalRule(curr) || isListItem(curr) || isTableRow(curr) || isBlockquote(curr) || isHtmlBlock(curr)) break;
        i++;
      }
      const raw = lines.slice(startLine, i).join('\n');
      blocks.push({
        id: '',
        type: 'paragraph',
        raw,
        isComplete: true,
      });
    }
  }

  // 填充 ID 并标记流式状态
  for (let idx = 0; idx < blocks.length; idx++) {
    const block = blocks[idx];
    const isActiveStreamingBlock = isStreaming && idx === blocks.length - 1;

    // 流式期间，最后一个活跃块使用不随 raw 变化的稳定 key，
    // 避免每个 chunk 都触发 React remount，打断内部动画 / diff 状态。
    block.id = isActiveStreamingBlock
      ? `b${idx}-${block.type[0]}-streaming`
      : `b${idx}-${block.type[0]}-${hashStr(block.raw)}`;

    // 流式期间，最后一个块标记为未完成
    if (isActiveStreamingBlock) {
      block.isComplete = false;
    }
  }

  return blocks;
}
