/**
 * 光标感知的 Markdown 实时预览语法显隐与 Agent 单步撤销共编辑引擎
 *
 * 核心不变量：
 * 1. 文档模型永远保持 100% 纯 Markdown 文本，语法隐藏纯属视图层装饰，不侵入文档内容。
 * 2. 当光标或选区（cursorRanges）与语法节点相交（from <= sel.to && to >= sel.from，双端闭区间）时，
 *    自动显露原始 Markdown 语法符号供用户编辑；光标移开后立即隐藏语法符号。
 * 3. 围栏代码块（```）的首尾两行标记为 `blockLineCollapse: true`（折叠为零高度行，而非仅抹掉反引号保留空行高），
 *    代码正文保持原样直接可编辑。
 * 4. 块级语法符号（如 `# `、`> `、无序列表 `- `）隐藏时连带吞掉其后的水平空白 `[ \t]`，但绝不往前扩（保留列表缩进层级）；
 *    行内样式先定、整行容器样式挖洞让开（subtract），保证装饰区间严格升序且零重叠。
 * 5. 一次 Agent 工具调用内的多处非重叠 `edits` 合并为单一撤销事务单元（`isolateHistory: true`），
 *    产出新文档坐标系下的绿色 Diff 高亮区间 `highlightRanges`；按一次撤销即可按 `from` 降序一步还原全部改动，
 *    并在保存/撤销后自动触发重新分块回调 `onRechunkMaterialBlocks(nextMarkdown)`。
 */

export interface DocRange {
  from: number;
  to: number;
}

export type MarkdownSyntaxNodeKind =
  | 'HeaderMark'
  | 'QuoteMark'
  | 'ListMark'
  | 'EmphasisMark'
  | 'CodeMark'
  | 'LinkMark'
  | 'FencedCode'
  | 'InlineCode'
  | 'Emphasis'
  | 'StrongEmphasis'
  | 'ATXHeading1'
  | 'ATXHeading2'
  | 'ATXHeading3'
  | 'ATXHeading4'
  | 'ATXHeading5'
  | 'ATXHeading6'
  | 'heading'
  | 'bold'
  | 'italic'
  | 'inline_code'
  | 'link'
  | 'fenced_code'
  | 'blockquote'
  | 'bullet_list'
  | 'ordered_list';

export interface MarkdownSyntaxNode {
  /** 语法节点类型 */
  type: MarkdownSyntaxNodeKind | string;
  /** 节点在 Markdown 纯文本中的起始偏移（含） */
  from: number;
  /** 节点在 Markdown 纯文本中的结束偏移（不含） */
  to: number;
  /**
   * 可选：该语法标记所属外层结构的触发显露范围（如 `**bold**` 整体区间或标题整行区间）。
   * 若未显式传入，块级标记自动取所在行，行内节点取 `[from, to]`。
   */
  scopeFrom?: number;
  scopeTo?: number;
  /** 可选：列表类型（有序列表序号属于信息，不隐藏；无序列表符号隐藏） */
  listKind?: 'bullet' | 'ordered';
  /** 可选：显式指定语法符号区间（如 `[link](url)` 或 `**bold**` 的前后标记区间） */
  syntaxRanges?: readonly DocRange[];
}

export type LivePreviewDecorationSpec =
  | {
      kind: 'hide';
      from: number;
      to: number;
      blockLineCollapse: false;
    }
  | {
      kind: 'collapse';
      from: number;
      to: number;
      blockLineCollapse: true;
    }
  | {
      kind: 'mark';
      from: number;
      to: number;
      cls: string;
      blockLineCollapse: false;
    };

export interface SyntaxVisibilityItem {
  node: MarkdownSyntaxNode;
  /** 光标/选区是否与该语法节点的触发范围相交 */
  cursorIntersects: boolean;
  /** 原始 Markdown 语法符号当前是否显露可见 */
  syntaxVisible: boolean;
  /** 原始 Markdown 语法符号当前是否被隐藏/折叠 */
  hidden: boolean;
  /** 是否将首尾围栏行折叠为零高度行（围栏代码块专用） */
  blockLineCollapse: boolean;
  /** 围栏代码块的首尾折叠行区间（仅围栏代码块存在） */
  fenceCollapseRanges?: DocRange[];
  /** 围栏代码块内直接可编辑的代码正文区间（仅围栏代码块存在） */
  codeBodyRange?: DocRange;
  /** 代码正文是否直接可编辑 */
  codeBodyEditable?: boolean;
  /** 当前节点实际生效的隐藏或折叠区间（当 syntaxVisible 为 true 时为空数组） */
  activeHiddenRanges: DocRange[];
}

export type LivePreviewSyntaxVisibilityResult = SyntaxVisibilityItem[] & {
  /** 保持 100% 纯 Markdown 文本不变 */
  markdown: string;
  /** 每个语法节点的显隐计算明细 */
  nodes: SyntaxVisibilityItem[];
  /** 按 from 严格升序且互不重叠的装饰指令列表 */
  decorations: LivePreviewDecorationSpec[];
  /** 当前处于隐藏状态的语法符号区间 */
  hiddenRanges: DocRange[];
  /** 当前处于零高度整行折叠状态的围栏首尾行区间 */
  collapsedFenceLines: DocRange[];
};

const BLOCK_LINE_TYPES = new Set([
  'HeaderMark',
  'QuoteMark',
  'ListMark',
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'heading',
  'blockquote',
  'bullet_list',
]);

const FENCED_CODE_TYPES = new Set(['FencedCode', 'fenced_code', 'code_fence']);

function clampOffset(doc: string, pos: number): number {
  return Math.max(0, Math.min(pos, doc.length));
}

/**
 * 获取覆盖 `pos` 所在行的起止范围（不含行尾 `\n`）。
 */
export function getLineRangeAt(doc: string, pos: number): DocRange {
  const clamped = clampOffset(doc, pos);
  const from = clamped === 0 ? 0 : doc.lastIndexOf('\n', clamped - 1) + 1;
  const nextNewline = doc.indexOf('\n', clamped);
  return {
    from,
    to: nextNewline < 0 ? doc.length : nextNewline,
  };
}

/**
 * 获取 `[from, to)` 覆盖的所有整行区间。
 */
export function getLinesInRange(
  doc: string,
  from: number,
  to: number,
): DocRange[] {
  const start = clampOffset(doc, from);
  const end = clampOffset(doc, to);
  if (end <= start) return [];

  const lines: DocRange[] = [];
  let cursor = start;
  while (cursor <= doc.length) {
    const line = getLineRangeAt(doc, cursor);
    if (lines.length > 0 && line.from >= end) break;
    lines.push(line);
    if (line.to >= end || line.to >= doc.length) break;
    cursor = line.to + 1;
  }
  return lines;
}

/**
 * 块级标记向后吞掉紧随其后的水平空白 `[ \t]`，绝不向前扩展以免吞掉列表层级缩进。
 */
function expandTrailingHorizontalBlank(doc: string, range: DocRange): DocRange {
  let to = clampOffset(doc, range.to);
  while (to < doc.length && (doc[to] === ' ' || doc[to] === '\t')) {
    to += 1;
  }
  return { from: clampOffset(doc, range.from), to };
}

/**
 * 判定语法范围与任意光标/选区是否相交（双端闭区间：`from <= sel.to && to >= sel.from`）。
 * 零宽光标（`sel.from === sel.to`）紧贴语法边界时同样视为相交并露出语法。
 */
export function isRangeIntersectedByCursor(
  scope: DocRange,
  cursorRanges: readonly DocRange[],
): boolean {
  return cursorRanges.some(
    (sel) => scope.from <= sel.to && scope.to >= sel.from,
  );
}

/**
 * 从容器区间 `line` 中挖掉所有 `holes`（要求 `holes` 已按 `from` 升序排列）。
 */
function subtractRanges(
  container: DocRange,
  holes: readonly DocRange[],
): DocRange[] {
  const segments: DocRange[] = [];
  let current = container.from;
  for (const hole of holes) {
    if (hole.to <= current || hole.from >= container.to) continue;
    if (hole.from > current) {
      segments.push({
        from: current,
        to: Math.min(hole.from, container.to),
      });
    }
    current = Math.max(current, hole.to);
  }
  if (current < container.to) {
    segments.push({ from: current, to: container.to });
  }
  return segments;
}

/**
 * 推导节点内部需要隐藏的具体语法符号区间（当调用方传入完整结构节点如 `**bold**`、`# heading`、`` `code` ``、`[link](url)` 时自动识别前后端标记）。
 */
function resolveNodeSyntaxMarkRanges(
  doc: string,
  node: MarkdownSyntaxNode,
): DocRange[] {
  if (node.syntaxRanges && node.syntaxRanges.length > 0) {
    return node.syntaxRanges.map((r) => ({
      from: clampOffset(doc, r.from),
      to: clampOffset(doc, r.to),
    }));
  }

  const from = clampOffset(doc, node.from);
  const to = clampOffset(doc, node.to);
  const slice = doc.slice(from, to);
  const type = node.type;

  // 若本身就是纯标记节点
  if (
    type === 'HeaderMark' ||
    type === 'QuoteMark' ||
    type === 'ListMark'
  ) {
    return [expandTrailingHorizontalBlank(doc, { from, to })];
  }
  if (type === 'EmphasisMark' || type === 'CodeMark' || type === 'LinkMark') {
    return [{ from, to }];
  }

  // 完整标题节点（如 `# Heading`）
  if (type === 'heading' || /^ATXHeading[1-6]$/.test(type)) {
    const match = /^(#{1,6}[ \t]*)/.exec(slice);
    if (match) {
      return [{ from, to: from + match[1].length }];
    }
    return [{ from, to }];
  }

  // 引用节点（如 `> quote`）
  if (type === 'blockquote') {
    const match = /^(>[ \t]*)/.exec(slice);
    if (match) {
      return [{ from, to: from + match[1].length }];
    }
    return [{ from, to }];
  }

  // 无序列表项（如 `- item`）
  if (type === 'bullet_list') {
    const match = /^([ \t]*[-*+][ \t]+)/.exec(slice);
    if (match) {
      const leadingSpaces = /^([ \t]*)/.exec(slice)?.[1].length ?? 0;
      return [{ from: from + leadingSpaces, to: from + match[1].length }];
    }
    return [expandTrailingHorizontalBlank(doc, { from, to })];
  }

  // 粗体 `**bold**` 或 `__bold__`
  if (type === 'StrongEmphasis' || type === 'bold') {
    if (
      (slice.startsWith('**') && slice.endsWith('**') && slice.length >= 4) ||
      (slice.startsWith('__') && slice.endsWith('__') && slice.length >= 4)
    ) {
      return [
        { from, to: from + 2 },
        { from: to - 2, to },
      ];
    }
    return [{ from, to }];
  }

  // 斜体 `*italic*` 或 `_italic_`
  if (type === 'Emphasis' || type === 'italic') {
    if (
      (slice.startsWith('*') && slice.endsWith('*') && slice.length >= 2) ||
      (slice.startsWith('_') && slice.endsWith('_') && slice.length >= 2)
    ) {
      return [
        { from, to: from + 1 },
        { from: to - 1, to },
      ];
    }
    return [{ from, to }];
  }

  // 行内代码 `` `code` ``
  if (type === 'InlineCode' || type === 'inline_code') {
    const openMatch = /^(`+)/.exec(slice);
    const closeMatch = /(`+)$/.exec(slice);
    if (
      openMatch &&
      closeMatch &&
      slice.length > openMatch[1].length + closeMatch[1].length
    ) {
      return [
        { from, to: from + openMatch[1].length },
        { from: to - closeMatch[1].length, to },
      ];
    }
    return [{ from, to }];
  }

  // 链接 `[text](url)`
  if (type === 'link') {
    const closeBracketIdx = slice.indexOf('](');
    if (slice.startsWith('[') && closeBracketIdx > 0 && slice.endsWith(')')) {
      return [
        { from, to: from + 1 },
        { from: from + closeBracketIdx, to },
      ];
    }
    return [{ from, to }];
  }

  return [{ from, to }];
}

function headingClassOf(
  doc: string,
  node: MarkdownSyntaxNode,
): string | null {
  const atx = /^ATXHeading([1-6])$/.exec(node.type);
  if (atx) return `cm-md-h${atx[1]}`;
  if (node.type === 'heading') {
    const line = doc.slice(node.from, node.to);
    const match = /^(#{1,6})/.exec(line);
    const level = match ? match[1].length : 1;
    return `cm-md-h${level}`;
  }
  return null;
}

/**
 * 光标感知的语法隐藏与显露计算器：
 * - 文档模型保持 100% 纯 Markdown 文本；
 * - 当用户的光标或选区（`cursorRanges`）与某个语法节点（如 `**bold**`、`# heading`、`` `code` ``、`[link](url)` 或代码块围栏）
 *   相交（`from <= sel.to && to >= sel.from`）时，自动露出原始 Markdown 语法符号供用户编辑；光标移开后立即隐藏语法符号；
 * - 围栏代码块（```` ``` ````）的首尾两行标记为 `blockLineCollapse: true`（折成零高度行，而非仅抹掉 3 个反引号保留空行高），
 *   代码正文保持原样直接可编辑。
 */
export function computeLivePreviewSyntaxVisibility(
  markdown: string,
  syntaxNodes: readonly MarkdownSyntaxNode[],
  cursorRanges: readonly DocRange[],
): LivePreviewSyntaxVisibilityResult {
  const items: SyntaxVisibilityItem[] = [];
  const holes: Array<{
    kind: 'hide' | 'collapse';
    from: number;
    to: number;
    blockLineCollapse: boolean;
  }> = [];
  const inlineStyles: Array<{ range: DocRange; cls: string }> = [];
  const lineStyles: Array<{ range: DocRange; cls: string }> = [];
  const hiddenRanges: DocRange[] = [];
  const collapsedFenceLines: DocRange[] = [];

  for (const node of syntaxNodes) {
    const from = clampOffset(markdown, node.from);
    const to = clampOffset(markdown, node.to);
    const type = node.type;

    // 1. 围栏代码块处理：首尾行整行折叠（blockLineCollapse: true），代码正文保持原样可编辑
    if (FENCED_CODE_TYPES.has(type)) {
      const openLine = getLineRangeAt(markdown, from);
      const closeLine = getLineRangeAt(markdown, Math.max(from, to - 1));
      const fenceScope: DocRange = {
        from: node.scopeFrom ?? openLine.from,
        to: node.scopeTo ?? closeLine.to,
      };
      const cursorIntersects = isRangeIntersectedByCursor(
        fenceScope,
        cursorRanges,
      );

      const fenceLines: DocRange[] = [openLine];
      if (closeLine.from !== openLine.from) {
        fenceLines.push(closeLine);
      }

      const bodyStart = Math.min(openLine.to + 1, closeLine.from);
      const bodyEnd = Math.max(bodyStart, closeLine.from);
      const codeBodyRange: DocRange = { from: bodyStart, to: bodyEnd };

      for (const bodyLine of getLinesInRange(markdown, bodyStart, bodyEnd)) {
        if (bodyLine.to > bodyLine.from) {
          lineStyles.push({ range: bodyLine, cls: 'cm-md-codeblock' });
        }
      }

      const activeHidden: DocRange[] = [];
      if (!cursorIntersects) {
        for (const fenceLine of fenceLines) {
          holes.push({
            kind: 'collapse',
            from: fenceLine.from,
            to: fenceLine.to,
            blockLineCollapse: true,
          });
          collapsedFenceLines.push(fenceLine);
          activeHidden.push(fenceLine);
        }
      }

      items.push({
        node,
        cursorIntersects,
        syntaxVisible: cursorIntersects,
        hidden: !cursorIntersects,
        blockLineCollapse: true,
        fenceCollapseRanges: fenceLines,
        codeBodyRange,
        codeBodyEditable: true,
        activeHiddenRanges: activeHidden,
      });
      continue;
    }

    // 2. 有序列表序号属于信息而非纯装饰语法，始终保持可见
    const slice = markdown.slice(from, to);
    const isOrderedList =
      type === 'ordered_list' ||
      node.listKind === 'ordered' ||
      (type === 'ListMark' && /^\d+[.)]/.test(slice.trim()));

    if (isOrderedList) {
      const lineScope = getLineRangeAt(markdown, from);
      const cursorIntersects = isRangeIntersectedByCursor(
        lineScope,
        cursorRanges,
      );
      items.push({
        node,
        cursorIntersects,
        syntaxVisible: true,
        hidden: false,
        blockLineCollapse: false,
        activeHiddenRanges: [],
      });
      continue;
    }

    // 3. 确定触发显露的作用域范围（块级标记按所在行，行内标记按外层结构或自身区间）
    const isBlockMark = BLOCK_LINE_TYPES.has(type);
    const revealScope: DocRange =
      node.scopeFrom !== undefined && node.scopeTo !== undefined
        ? {
            from: clampOffset(markdown, node.scopeFrom),
            to: clampOffset(markdown, node.scopeTo),
          }
        : isBlockMark
          ? getLineRangeAt(markdown, from)
          : { from, to };

    const cursorIntersects = isRangeIntersectedByCursor(
      revealScope,
      cursorRanges,
    );

    // 收集样式装饰（行内代码与标题行）
    if (type === 'InlineCode' || type === 'inline_code') {
      inlineStyles.push({ range: { from, to }, cls: 'cm-md-inlinecode' });
    }
    const headingCls = headingClassOf(markdown, node);
    if (headingCls) {
      for (const line of getLinesInRange(markdown, from, to)) {
        if (line.to > line.from) {
          lineStyles.push({ range: line, cls: headingCls });
        }
      }
    }

    const markRanges = resolveNodeSyntaxMarkRanges(markdown, node);
    const activeHidden: DocRange[] = [];

    if (!cursorIntersects) {
      for (const r of markRanges) {
        if (r.to > r.from) {
          holes.push({
            kind: 'hide',
            from: r.from,
            to: r.to,
            blockLineCollapse: false,
          });
          hiddenRanges.push(r);
          activeHidden.push(r);
        }
      }
    }

    items.push({
      node,
      cursorIntersects,
      syntaxVisible: cursorIntersects,
      hidden: !cursorIntersects,
      blockLineCollapse: false,
      activeHiddenRanges: activeHidden,
    });
  }

  // 先定叶子（语法隐藏/折叠孔洞 + 行内样式），再让整行容器样式挖洞让开（subtract），保证严格升序无重叠
  const sortByPos = (a: DocRange, b: DocRange) =>
    a.from - b.from || a.to - b.to;
  holes.sort(sortByPos);
  hiddenRanges.sort(sortByPos);
  collapsedFenceLines.sort(sortByPos);

  const inlineSpecs: LivePreviewDecorationSpec[] = [];
  for (const style of inlineStyles) {
    for (const seg of subtractRanges(style.range, holes)) {
      if (seg.to > seg.from) {
        inlineSpecs.push({
          kind: 'mark',
          from: seg.from,
          to: seg.to,
          cls: style.cls,
          blockLineCollapse: false,
        });
      }
    }
  }

  const lineHoles: DocRange[] = [
    ...holes.map((h) => ({ from: h.from, to: h.to })),
    ...inlineSpecs.map((s) => ({ from: s.from, to: s.to })),
  ].sort(sortByPos);

  const rawDecorations: LivePreviewDecorationSpec[] = [
    ...holes.map((h): LivePreviewDecorationSpec =>
      h.kind === 'collapse'
        ? {
            kind: 'collapse',
            from: h.from,
            to: h.to,
            blockLineCollapse: true,
          }
        : {
            kind: 'hide',
            from: h.from,
            to: h.to,
            blockLineCollapse: false,
          },
    ),
    ...inlineSpecs,
  ];

  for (const style of lineStyles) {
    for (const seg of subtractRanges(style.range, lineHoles)) {
      if (seg.to > seg.from) {
        rawDecorations.push({
          kind: 'mark',
          from: seg.from,
          to: seg.to,
          cls: style.cls,
          blockLineCollapse: false,
        });
      }
    }
  }

  rawDecorations.sort((a, b) => a.from - b.from || a.to - b.to);

  // 最终去重防重叠兜底
  const decorations: LivePreviewDecorationSpec[] = [];
  for (const spec of rawDecorations) {
    const prev = decorations[decorations.length - 1];
    if (prev && spec.from < prev.to) continue;
    decorations.push(spec);
  }

  const result = Object.assign([...items], {
    markdown,
    nodes: items,
    decorations,
    hiddenRanges,
    collapsedFenceLines,
  });

  return result;
}

// ============================================================================
// Agent 共编辑精确字符串替换与单步撤销隔离器
// ============================================================================

export interface AgentMarkdownEdit {
  old_string: string;
  new_string: string;
  /** 同一文本出现多处时是否全部替换，默认 false（要求唯一命中） */
  replace_all?: boolean;
}

export interface AgentMarkdownEditPayload {
  edits: readonly AgentMarkdownEdit[];
}

export interface AgentEditChange {
  /** 基于编辑前旧文档的起始偏移 */
  from: number;
  /** 基于编辑前旧文档的结束偏移 */
  to: number;
  /** 替换插入的新文本 */
  insert: string;
  /** 对应的 edit 索引 */
  editIndex: number;
}

export interface AgentHighlightRange {
  /** 基于编辑后新文档的起始偏移 */
  from: number;
  /** 基于编辑后新文档的结束偏移 */
  to: number;
  /** 被替换或删除的原文本（用于支持含纯删除在内的逆向还原） */
  removed: string;
}

export interface UndoEditSpec {
  /** 基于编辑后新文档的起始偏移 */
  from: number;
  /** 基于编辑后新文档的结束偏移 */
  to: number;
  /** 还原时应写回的旧文本 */
  insert: string;
  /** 撤销前校验该区间当前仍应保持的 Agent 写入文本 */
  expect: string;
  leftAnchor?: string;
  rightAnchor?: string;
}

export interface AgentEditSuccessResult {
  ok: true;
  /** 替换后的最新纯 Markdown 文本 */
  markdown: string;
  /** 本次实际生效的替换区间数 */
  changedCount: number;
  /** 基于旧文档坐标的变更指令集（升序排列） */
  changes: AgentEditChange[];
  /** 基于新文档坐标的绿色 Diff 高亮区间集 */
  highlightRanges: AgentHighlightRange[];
  /** 是否作为单一隔离撤销事务单元 */
  isolateHistory: true;
  /** 按 `from` 降序排列的逆向撤销规格（供单步撤销直接应用） */
  inverseChanges: UndoEditSpec[];
  matchCount: number;
  matchedLines: number[];
}

export interface AgentEditFailureResult {
  ok: false;
  /** 原样保留、未被盲改的 Markdown 文本 */
  markdown: string;
  /** 带行号与上下文的详细诊断信息 */
  error: string;
  /** 匹配到的精确或相似文本处数 */
  matchCount: number;
  /** 匹配到的精确或相似文本所在的 1-based 行号列表 */
  matchedLines: number[];
  isolateHistory: false;
  changes: [];
  highlightRanges: [];
}

export type AgentEditApplyResult =
  | AgentEditSuccessResult
  | AgentEditFailureResult;

export interface ApplyAgentEditsOptions {
  /** 编辑保存后自动触发重新分块回调 */
  onRechunkMaterialBlocks?: (nextMarkdown: string) => void;
}

function findNonOverlappingOccurrences(
  source: string,
  needle: string,
): number[] {
  const positions: number[] = [];
  if (needle.length === 0) return positions;
  let idx = source.indexOf(needle);
  while (idx >= 0) {
    positions.push(idx);
    idx = source.indexOf(needle, idx + needle.length);
  }
  return positions;
}

/**
 * 计算字符偏移对应的 1-based 行号。
 */
export function offsetToLineNumber(source: string, offset: number): number {
  const limit = clampOffset(source, offset);
  let line = 1;
  for (let i = 0; i < limit; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }
  return line;
}

/**
 * 当精确匹配未找到时，在文档中检索包含相似片段的候选行号与上下文，辅助诊断。
 */
function findSimilarCandidateLines(
  source: string,
  needle: string,
): Array<{ lineNumber: number; preview: string }> {
  const trimmed = needle.trim();
  if (!trimmed) return [];

  const rawTokens = trimmed
    .split(/[\s，。、；：！？,.!?;:]+/)
    .filter((token) => token.length >= 2);
  const firstToken = rawTokens[0] ?? trimmed;
  const firstAnchor = firstToken.slice(0, Math.min(4, firstToken.length));

  if (!firstAnchor) return [];

  const lines = source.split('\n');
  const candidates: Array<{ lineNumber: number; preview: string }> = [];
  const lowerAnchor = firstAnchor.toLowerCase();

  for (let i = 0; i < lines.length; i += 1) {
    const lineText = lines[i];
    if (
      lineText.toLowerCase().includes(lowerAnchor) ||
      trimmed.toLowerCase().includes(lineText.trim().toLowerCase()) && lineText.trim().length >= 3
    ) {
      candidates.push({
        lineNumber: i + 1,
        preview: lineText.trim().slice(0, 60),
      });
    }
  }

  return candidates;
}

function quoteSnippet(text: string, maxLen = 80): string {
  const singleLine = text.replace(/\r?\n/g, '\\n');
  return singleLine.length > maxLen
    ? `「${singleLine.slice(0, maxLen)}…」`
    : `「${singleLine}」`;
}

/**
 * 撤销派发顺序：按 `from` 降序，`from` 相同时按 `to` 降序。
 * 避免先还原前段时把后段坐标顶歪，导致已还原文本被后续操作切掉。
 */
export function compareUndoOrder(a: UndoEditSpec, b: UndoEditSpec): number {
  return b.from - a.from || b.to - a.to;
}

/**
 * 按升序变更集在纯文本上合成新文本。
 */
function applyOrderedChangesToText(
  source: string,
  changes: readonly { from: number; to: number; insert: string }[],
): string {
  const sorted = [...changes].sort(
    (a, b) => a.from - b.from || a.to - b.to,
  );
  let cursor = 0;
  const parts: string[] = [];
  for (const change of sorted) {
    parts.push(source.slice(cursor, change.from));
    parts.push(change.insert);
    cursor = change.to;
  }
  parts.push(source.slice(cursor));
  return parts.join('');
}

/**
 * 按降序逆向变更集在纯文本上逐步还原（与编辑器按 `from` 降序派发语义完全一致）。
 */
function applyDescendingUndoSpecsToText(
  currentDoc: string,
  undoSpecs: readonly UndoEditSpec[],
): string {
  const ordered = [...undoSpecs].sort(compareUndoOrder);
  let doc = currentDoc;
  for (const spec of ordered) {
    doc = doc.slice(0, spec.from) + spec.insert + doc.slice(spec.to);
  }
  return doc;
}

/**
 * Agent 共编辑精确字符串替换器：
 * - 接收 `{ edits: Array<{ old_string, new_string, replace_all? }> }` 或直接接收数组；
 * - 当 `old_string` 未找到或存在多处匹配时，返回带上下文与行号诊断的失败结果，绝不盲改；
 * - 一次调用内的多处非重叠 `edits` 合并为单一撤销事务单元（`isolateHistory: true`），
 *   并产出新文档坐标系下的绿色 Diff 高亮区间 `highlightRanges`。
 */
export function applyAgentMarkdownEdits(
  source: string,
  editsInput: AgentMarkdownEditPayload | readonly AgentMarkdownEdit[],
  options?: ApplyAgentEditsOptions,
): AgentEditApplyResult {
  const edits: readonly AgentMarkdownEdit[] | null = Array.isArray(editsInput)
    ? editsInput
    : editsInput &&
        typeof editsInput === 'object' &&
        Array.isArray((editsInput as AgentMarkdownEditPayload).edits)
      ? (editsInput as AgentMarkdownEditPayload).edits
      : null;

  const makeFailure = (
    error: string,
    matchCount = 0,
    matchedLines: number[] = [],
  ): AgentEditFailureResult => ({
    ok: false,
    markdown: source,
    error,
    matchCount,
    matchedLines,
    isolateHistory: false,
    changes: [],
    highlightRanges: [],
  });

  if (!edits || edits.length === 0) {
    return makeFailure(
      '没有可执行的改动：edits 为空。请传入至少一条包含 old_string 与 new_string 的编辑指令。',
    );
  }

  const resolvedChanges: AgentEditChange[] = [];
  const allMatchedLines: number[] = [];

  for (let i = 0; i < edits.length; i += 1) {
    const edit = edits[i];
    const editNum = i + 1;

    if (!edit || typeof edit !== 'object') {
      return makeFailure(`第 ${editNum} 条 edit 格式无效，必须为对象。`);
    }

    const { old_string: oldStr, new_string: newStr, replace_all: replaceAll } =
      edit;

    if (typeof oldStr !== 'string' || typeof newStr !== 'string') {
      return makeFailure(
        `第 ${editNum} 条 edit 字段类型无效：old_string 与 new_string 均必须为字符串。`,
      );
    }

    if (oldStr.length === 0) {
      return makeFailure(
        `第 ${editNum} 条 edit 的 old_string 为空字符串，拒绝执行以防误改整篇文档。`,
      );
    }

    const hitOffsets = findNonOverlappingOccurrences(source, oldStr);

    if (hitOffsets.length === 0) {
      const candidates = findSimilarCandidateLines(source, oldStr);
      const candidateLines = candidates.map((c) => c.lineNumber);
      const candidateHint =
        candidates.length > 0
          ? `检测到 ${candidates.length} 处相似文本，位于第 ${candidateLines.join('、')} 行（${candidates.map((c) => `L${c.lineNumber}: ${quoteSnippet(c.preview, 40)}`).join('；')}）。`
          : '在文档中匹配到了 0 处相似文本。';

      return makeFailure(
        `第 ${editNum} 条 edit 未命中：old_string ${quoteSnippet(oldStr)} 在当前文档中未找到。${candidateHint}请核对原文后重试。`,
        candidates.length,
        candidateLines,
      );
    }

    const lineNumbers = hitOffsets.map((offset) =>
      offsetToLineNumber(source, offset),
    );

    if (hitOffsets.length > 1 && replaceAll !== true) {
      return makeFailure(
        `第 ${editNum} 条 edit 的 old_string ${quoteSnippet(oldStr)} 在文档中匹配到了 ${hitOffsets.length} 处相似文本（行号：第 ${lineNumbers.join('、')} 行），无法确定修改哪一处。请补充相邻上下文使其唯一，或显式设置 replace_all: true。`,
        hitOffsets.length,
        lineNumbers,
      );
    }

    for (let h = 0; h < hitOffsets.length; h += 1) {
      const from = hitOffsets[h];
      resolvedChanges.push({
        from,
        to: from + oldStr.length,
        insert: newStr,
        editIndex: i,
      });
      allMatchedLines.push(lineNumbers[h]);
    }
  }

  // 按文档起始位置升序排列，检查是否存在重叠区间
  resolvedChanges.sort((a, b) => a.from - b.from || a.to - b.to);

  for (let i = 1; i < resolvedChanges.length; i += 1) {
    const prev = resolvedChanges[i - 1];
    const curr = resolvedChanges[i];
    if (curr.from < prev.to) {
      const conflictLine = offsetToLineNumber(source, curr.from);
      return makeFailure(
        `第 ${prev.editIndex + 1} 条与第 ${curr.editIndex + 1} 条 edit 的替换区间在第 ${conflictLine} 行发生重叠（[${prev.from}, ${prev.to}) 与 [${curr.from}, ${curr.to})），拒绝执行。请合并重叠改动后重试。`,
        2,
        [offsetToLineNumber(source, prev.from), conflictLine],
      );
    }
  }

  // 计算新文档坐标系下的绿色 Diff 高亮区间与单步逆向还原规格
  let cumulativeShift = 0;
  const highlightRanges: AgentHighlightRange[] = [];
  const rawUndoSpecs: UndoEditSpec[] = [];

  for (const change of resolvedChanges) {
    const newFrom = change.from + cumulativeShift;
    const newTo = newFrom + change.insert.length;
    const removedText = source.slice(change.from, change.to);

    highlightRanges.push({
      from: newFrom,
      to: newTo,
      removed: removedText,
    });

    rawUndoSpecs.push({
      from: newFrom,
      to: newTo,
      insert: removedText,
      expect: change.insert,
    });

    cumulativeShift += change.insert.length - (change.to - change.from);
  }

  const nextMarkdown = applyOrderedChangesToText(source, resolvedChanges);
  for (const spec of rawUndoSpecs) {
    if (spec.from === spec.to) {
      spec.leftAnchor = nextMarkdown.slice(Math.max(0, spec.from - 32), spec.from);
      spec.rightAnchor = nextMarkdown.slice(spec.to, spec.to + 32);
    }
  }
  const inverseChanges = [...rawUndoSpecs].sort(compareUndoOrder);

  options?.onRechunkMaterialBlocks?.(nextMarkdown);

  return {
    ok: true,
    markdown: nextMarkdown,
    changedCount: resolvedChanges.length,
    changes: resolvedChanges,
    highlightRanges,
    isolateHistory: true,
    inverseChanges,
    matchCount: resolvedChanges.length,
    matchedLines: allMatchedLines,
  };
}

export type AgentUndoResult =
  | {
      ok: true;
      markdown: string;
      restoredCount: number;
      isolateHistory: true;
    }
  | {
      ok: false;
      markdown: string;
      error: string;
    };

export interface AgentCoEditHistoryOptions {
  /** 文档保存或撤销后自动触发重新分块入库 */
  onRechunkMaterialBlocks?: (nextMarkdown: string) => void;
}

/**
 * Agent 共编辑单步撤销历史隔离管理器：
 * - 将单次 Agent 工具调用内的多处改动隔离为单一撤销事务（`isolateHistory: true`）；
 * - 支持一键将最近一次 Agent 批量改动一步退回（按 `from` 降序还原）；
 * - 撤销前执行完整性校验（`stillIntact`）：若用户在 Agent 改动区间或其前方插入/修改了文字导致坐标漂移，
 *   拒绝盲目覆盖用户改动并返回明确原因；
 * - 每次编辑落盘或撤销成功后自动调用 `onRechunkMaterialBlocks(nextMarkdown)`。
 */
export class AgentCoEditHistoryManager {
  private currentMarkdown: string;
  private lastAgentBatch: UndoEditSpec[] | null = null;
  private activeHighlights: AgentHighlightRange[] = [];
  private readonly onRechunkMaterialBlocks?: (nextMarkdown: string) => void;

  constructor(
    initialMarkdown: string,
    options?: AgentCoEditHistoryOptions,
  ) {
    this.currentMarkdown = initialMarkdown;
    this.onRechunkMaterialBlocks = options?.onRechunkMaterialBlocks;
  }

  public getMarkdown(): string {
    return this.currentMarkdown;
  }

  public getHighlightRanges(): AgentHighlightRange[] {
    return [...this.activeHighlights];
  }

  public hasAgentBatch(): boolean {
    return this.lastAgentBatch !== null && this.lastAgentBatch.length > 0;
  }

  /**
   * 用户手动编辑文档并保存，触发重新分块回调。
   */
  public applyUserEdit(nextMarkdown: string): void {
    this.currentMarkdown = nextMarkdown;
    this.onRechunkMaterialBlocks?.(nextMarkdown);
  }

  /**
   * 应用一次 Agent 批量编辑工具调用，合并为单一撤销单元并触发重新分块。
   */
  public applyAgentEdits(
    editsInput: AgentMarkdownEditPayload | readonly AgentMarkdownEdit[],
  ): AgentEditApplyResult {
    const result = applyAgentMarkdownEdits(this.currentMarkdown, editsInput);

    if (!result.ok) {
      return result;
    }

    this.currentMarkdown = result.markdown;
    this.activeHighlights = result.highlightRanges;
    this.lastAgentBatch = result.inverseChanges;
    this.onRechunkMaterialBlocks?.(this.currentMarkdown);
    return result;
  }

  /**
   * 校验当前文档中 Agent 写入的各区间是否完好未漂移。
   */
  public isLastAgentBatchIntact(): boolean {
    if (!this.lastAgentBatch || this.lastAgentBatch.length === 0) {
      return false;
    }
    return this.lastAgentBatch.every(
      (spec) =>
        spec.from >= 0 &&
        spec.to <= this.currentMarkdown.length &&
        this.currentMarkdown.slice(spec.from, spec.to) === spec.expect &&
        (spec.leftAnchor !== '' || spec.from === 0) &&
        (spec.rightAnchor !== '' || spec.to === this.currentMarkdown.length) &&
        (spec.leftAnchor === undefined || this.currentMarkdown.slice(Math.max(0, spec.from - spec.leftAnchor.length), spec.from) === spec.leftAnchor) &&
        (spec.rightAnchor === undefined || this.currentMarkdown.slice(spec.to, spec.to + spec.rightAnchor.length) === spec.rightAnchor),
    );
  }

  /**
   * 单步撤销最近一次 Agent 工具调用的全部改动，并触发重新分块回调。
   */
  public undoLastAgentEdit(): AgentUndoResult {
    if (!this.lastAgentBatch || this.lastAgentBatch.length === 0) {
      return {
        ok: false,
        markdown: this.currentMarkdown,
        error: '当前没有可撤销的 Agent 改动。',
      };
    }

    if (!this.isLastAgentBatchIntact()) {
      return {
        ok: false,
        markdown: this.currentMarkdown,
        error:
          '无法自动撤销：Agent 修改的段落或其前方内容已被手动编辑，为防止覆盖用户输入已中止撤销。',
      };
    }

    const restoredCount = this.lastAgentBatch.length;
    const restoredMarkdown = applyDescendingUndoSpecsToText(
      this.currentMarkdown,
      this.lastAgentBatch,
    );

    this.currentMarkdown = restoredMarkdown;
    this.lastAgentBatch = null;
    this.activeHighlights = [];
    this.onRechunkMaterialBlocks?.(restoredMarkdown);

    return {
      ok: true,
      markdown: restoredMarkdown,
      restoredCount,
      isolateHistory: true,
    };
  }
}
