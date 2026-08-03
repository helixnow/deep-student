/**
 * splitMarkdownBlocks.ts
 *
 * 将 markdown 文本按块级元素拆分，用于流式增量渲染。
 * 已完成的块可被 React.memo 缓存，只有最后一个活跃块需要每帧重渲染。
 *
 * ★ 性能（流式 O(n²) 修复）：
 * 流式期间每次 chunk flush 都会以全量累计文本调用本模块。旧实现每次
 * 对全文 split('\n') + 逐行扫描，随回复变长成本线性上升（整条流 O(n²)）。
 * 现在拆成 coreParse（纯解析，带字符偏移）+ finalize（ID/isComplete 标注），
 * 并提供 createMarkdownBlockSplitter()：内容 append-only 时复用前缀块，
 * 只重解析最后两个块之后的尾部增量。
 *
 * 为什么保留"最后两个块"重解析而不是只重解析最后一个：
 * 追加的文本只能改写旧内容的最后一行，但列表块的"空行 + 下一行是否列表项"
 * 前瞻规则允许倒数第二个块被追加内容追溯合并（如 `- a\n\n-` + ` b`
 * 会把段落 `-` 变成列表项并并入前面的列表块）。该前瞻只有一行深度，
 * 追溯影响不会越过倒数第二个块的起始行，因此保留 n-2 个前缀块是安全的。
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

/** 解析中间产物：未标注 ID 的块（含在源文本中的字符起始偏移） */
interface CoreBlock {
  type: MarkdownBlockType;
  raw: string;
  /** 围栏块（code/math）是否已闭合；其余类型恒为 true */
  closed: boolean;
  /** 块首行在被解析文本中的字符偏移（用于增量重解析定位） */
  startOffset: number;
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

interface CodeFenceInfo {
  /** 围栏字符：` 或 ~ */
  char: string;
  /** 围栏长度（>=3） */
  length: number;
}

/** 解析开栏行，返回围栏字符与长度 */
function parseCodeFenceOpen(line: string): CodeFenceInfo | null {
  const m = /^\s*(`{3,}|~{3,})/.exec(line);
  if (!m) return null;
  return { char: m[1][0], length: m[1].length };
}

/**
 * 检测行是否为对应开栏的合法闭栏。
 * CommonMark 规则：闭栏必须使用相同字符、长度不小于开栏、且后面只能有空白。
 * 这样 ```` ```` ```` 包裹的示例代码里嵌套的 ``` 不会提前闭合外层围栏。
 */
function isCodeFenceClose(line: string, open: CodeFenceInfo): boolean {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  if (!m) return false;
  return m[1][0] === open.char && m[1].length >= open.length;
}

/** 检测行是否为数学块分隔符 $$ */
function isMathFence(line: string): boolean {
  return line.trim().startsWith('$$');
}

/** 检测 $$ 开头的行是否在同一行内自闭合（如 `$$E=mc^2$$`） */
function isSelfClosedMathLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length >= 4 && trimmed.startsWith('$$') && trimmed.endsWith('$$');
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
 * 核心解析：将 markdown 文本拆为 CoreBlock 数组（贪心、单向扫描）。
 *
 * 设计原则：
 * - 贪心匹配：尽可能将连续的同类行归入同一个块
 * - 记录每个块的字符起始偏移，供增量重解析使用
 */
function coreParse(content: string): CoreBlock[] {
  if (!content) return [];

  const lines = content.split('\n');
  // 每行的字符起始偏移（行长 + 1 个换行符累加）
  const lineOffsets = new Array<number>(lines.length);
  {
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      lineOffsets[i] = offset;
      offset += lines[i].length + 1;
    }
  }

  const blocks: CoreBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // --- 代码块（围栏） ---
    if (isCodeFence(line)) {
      const openFence = parseCodeFenceOpen(line);
      const startLine = i;
      i++;
      // 寻找闭合围栏（必须与开栏字符相同且长度不小于开栏）
      let closed = false;
      while (i < lines.length) {
        if (openFence && isCodeFenceClose(lines[i], openFence)) {
          i++;
          closed = true;
          break;
        }
        i++;
      }
      blocks.push({
        type: 'code',
        raw: lines.slice(startLine, i).join('\n'),
        closed,
        startOffset: lineOffsets[startLine],
      });
      continue;
    }

    // --- 数学块（$$） ---
    if (isMathFence(line)) {
      const startLine = i;
      // 单行自闭合：`$$E=mc^2$$` 不能吞掉后续行
      if (isSelfClosedMathLine(line)) {
        i++;
        blocks.push({
          type: 'math',
          raw: line,
          closed: true,
          startOffset: lineOffsets[startLine],
        });
        continue;
      }
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
      blocks.push({
        type: 'math',
        raw: lines.slice(startLine, i).join('\n'),
        closed,
        startOffset: lineOffsets[startLine],
      });
      continue;
    }

    // --- 标题 ---
    if (isHeading(line)) {
      blocks.push({ type: 'heading', raw: line, closed: true, startOffset: lineOffsets[i] });
      i++;
      continue;
    }

    // --- 水平线 ---
    if (isHorizontalRule(line)) {
      blocks.push({ type: 'hr', raw: line, closed: true, startOffset: lineOffsets[i] });
      i++;
      continue;
    }

    // --- 表格（连续的表格行） ---
    if (isTableRow(line) || isTableSeparator(line)) {
      const startLine = i;
      while (i < lines.length && (isTableRow(lines[i]) || isTableSeparator(lines[i]))) {
        i++;
      }
      blocks.push({
        type: 'table',
        raw: lines.slice(startLine, i).join('\n'),
        closed: true,
        startOffset: lineOffsets[startLine],
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
      blocks.push({
        type: 'list',
        raw: lines.slice(startLine, i).join('\n'),
        closed: true,
        startOffset: lineOffsets[startLine],
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
      blocks.push({
        type: 'blockquote',
        raw: lines.slice(startLine, i).join('\n'),
        closed: true,
        startOffset: lineOffsets[startLine],
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
      blocks.push({
        type: 'html',
        raw: lines.slice(startLine, i).join('\n'),
        closed: true,
        startOffset: lineOffsets[startLine],
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
      blocks.push({
        type: 'paragraph',
        raw: lines.slice(startLine, i).join('\n'),
        closed: true,
        startOffset: lineOffsets[startLine],
      });
    }
  }

  return blocks;
}

/**
 * 标注阶段：分配稳定 ID 并落定 isComplete。
 *
 * 流式期间，最后一个活跃块使用不随 raw 变化的稳定 key，
 * 避免每个 chunk 都触发 React remount，打断内部动画 / diff 状态。
 */
function finalizeBlocks(coreBlocks: CoreBlock[], isStreaming: boolean): MarkdownBlock[] {
  const lastIndex = coreBlocks.length - 1;
  return coreBlocks.map((block, idx) => {
    const isActiveStreamingBlock = isStreaming && idx === lastIndex;
    return {
      id: isActiveStreamingBlock
        ? `b${idx}-${block.type[0]}-streaming`
        : `b${idx}-${block.type[0]}-${hashStr(block.raw)}`,
      type: block.type,
      raw: block.raw,
      isComplete: isActiveStreamingBlock ? false : block.closed,
    };
  });
}

/**
 * 将 markdown 内容拆分为块级元素数组（一次性、无缓存）。
 * 流式高频调用场景请使用 createMarkdownBlockSplitter()。
 */
export function splitMarkdownBlocks(content: string, isStreaming: boolean): MarkdownBlock[] {
  if (!content) return [];
  return finalizeBlocks(coreParse(content), isStreaming);
}

/** 前缀块少于该数量时直接全量解析（增量收益可忽略） */
const MIN_BLOCKS_FOR_INCREMENTAL = 3;

/**
 * 创建带增量缓存的拆分器（每个渲染组件实例持有一个）。
 *
 * 内容为 append-only 增长（流式典型场景）时，复用除最后两个块之外的
 * 前缀解析结果，只对尾部增量重跑 coreParse；输出与全量
 * splitMarkdownBlocks 完全一致（含块 ID 编号）。
 * 内容非追加式变化（重试、切换消息）时自动退回全量解析。
 */
export function createMarkdownBlockSplitter(): (
  content: string,
  isStreaming: boolean,
) => MarkdownBlock[] {
  let cachedContent = '';
  let cachedCore: CoreBlock[] = [];

  return function split(content: string, isStreaming: boolean): MarkdownBlock[] {
    if (!content) {
      cachedContent = '';
      cachedCore = [];
      return [];
    }

    let coreBlocks: CoreBlock[];
    if (
      cachedCore.length >= MIN_BLOCKS_FOR_INCREMENTAL &&
      content.length >= cachedContent.length &&
      content.startsWith(cachedContent)
    ) {
      // 追加式增长：保留前 n-2 个块，从倒数第二个块的起始偏移重解析尾部
      const keepCount = cachedCore.length - 2;
      const reparseStart = cachedCore[keepCount].startOffset;
      const tailBlocks = coreParse(content.slice(reparseStart));
      coreBlocks = cachedCore.slice(0, keepCount);
      for (const block of tailBlocks) {
        coreBlocks.push({ ...block, startOffset: block.startOffset + reparseStart });
      }
    } else {
      coreBlocks = coreParse(content);
    }

    cachedContent = content;
    cachedCore = coreBlocks;
    return finalizeBlocks(coreBlocks, isStreaming);
  };
}
