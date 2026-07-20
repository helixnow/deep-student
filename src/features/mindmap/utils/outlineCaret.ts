/**
 * 大纲拆分/合并后恢复光标位置（跨节点 remount 时由聚焦 effect 消费）
 * 以及 ↑↓ 导航的 goal column（目标列）状态。
 *
 * E01 B1：状态按 scope（通常传 store api 对象）隔离，避免多份思维导图
 * 同时打开时 ↑↓ 目标列 / 拆分光标串到错误实例。scope 缺省时落到共享的
 * 默认 scope —— 供无法拿到 store 的调用方（如视图切换的 resume 逻辑）；
 * takeOutlineCaret 在 scoped 未命中时回落默认 scope 消费这类跨边界写入。
 */

import type { MindMapNode } from '../types';

/** 状态隔离的 key：任意稳定对象（大纲组件传 store api）。 */
export type OutlineCaretScope = object;

interface OutlineCaretState {
  pending: { nodeId: string; offset: number } | null;
  /** 连续 ↑↓ 时沿用的水平字符列；←→ / 输入后清空 */
  goalColumn: number | null;
  /** 视觉 goal column：起跳行的像素列 + 测量字体；CJK 混排时比字符列更准 */
  goalVisual: { px: number; font: string | null } | null;
}

function createState(): OutlineCaretState {
  return { pending: null, goalColumn: null, goalVisual: null };
}

const scopedStates = new WeakMap<OutlineCaretScope, OutlineCaretState>();
/** scope 缺省时的兜底状态（单实例路径 / 测试 / 跨边界写入方） */
const defaultState = createState();

function resolveState(scope?: OutlineCaretScope | null): OutlineCaretState {
  if (!scope) return defaultState;
  let state = scopedStates.get(scope);
  if (!state) {
    state = createState();
    scopedStates.set(scope, state);
  }
  return state;
}

export function requestOutlineCaret(
  nodeId: string,
  offset: number,
  scope?: OutlineCaretScope | null,
): void {
  resolveState(scope).pending = { nodeId, offset };
}

function takeFromState(state: OutlineCaretState, nodeId: string): number | null {
  if (!state.pending || state.pending.nodeId !== nodeId) return null;
  const offset = state.pending.offset;
  state.pending = null;
  return offset;
}

export function takeOutlineCaret(
  nodeId: string,
  scope?: OutlineCaretScope | null,
): number | null {
  const scoped = takeFromState(resolveState(scope), nodeId);
  if (scoped !== null) return scoped;
  // 无 scope 的写入方（viewContinuity 等）落在默认 scope；nodeId 全局唯一，
  // 命中即可安全消费。
  if (scope) return takeFromState(defaultState, nodeId);
  return null;
}

export function setOutlineGoalColumn(
  column: number | null,
  scope?: OutlineCaretScope | null,
): void {
  resolveState(scope).goalColumn =
    column == null ? null : Math.max(0, Math.floor(column));
}

export function getOutlineGoalColumn(scope?: OutlineCaretScope | null): number | null {
  return resolveState(scope).goalColumn;
}

export function setOutlineGoalVisual(
  px: number,
  font?: string | null,
  scope?: OutlineCaretScope | null,
): void {
  resolveState(scope).goalVisual = Number.isFinite(px)
    ? { px: Math.max(0, px), font: font ?? null }
    : null;
}

export function getOutlineGoalVisual(
  scope?: OutlineCaretScope | null,
): { px: number; font: string | null } | null {
  return resolveState(scope).goalVisual;
}

export function clearOutlineGoalColumn(scope?: OutlineCaretScope | null): void {
  const state = resolveState(scope);
  state.goalColumn = null;
  state.goalVisual = null;
}

export interface OutlineCaretController {
  requestOutlineCaret: (nodeId: string, offset: number) => void;
  takeOutlineCaret: (nodeId: string) => number | null;
  setOutlineGoalColumn: (column: number | null) => void;
  getOutlineGoalColumn: () => number | null;
  setOutlineGoalVisual: (px: number, font?: string | null) => void;
  getOutlineGoalVisual: () => { px: number; font: string | null } | null;
  clearOutlineGoalColumn: () => void;
}

/**
 * 生成绑定到某个 scope 的 caret 控制器（大纲组件按 store api 各持一份），
 * 调用侧签名与模块级函数一致，便于多实例隔离而不改动每个调用点。
 */
export function createOutlineCaretController(
  scope: OutlineCaretScope,
): OutlineCaretController {
  return {
    requestOutlineCaret: (nodeId, offset) => requestOutlineCaret(nodeId, offset, scope),
    takeOutlineCaret: (nodeId) => takeOutlineCaret(nodeId, scope),
    setOutlineGoalColumn: (column) => setOutlineGoalColumn(column, scope),
    getOutlineGoalColumn: () => getOutlineGoalColumn(scope),
    setOutlineGoalVisual: (px, font) => setOutlineGoalVisual(px, font, scope),
    getOutlineGoalVisual: () => getOutlineGoalVisual(scope),
    clearOutlineGoalColumn: () => clearOutlineGoalColumn(scope),
  };
}

/**
 * 解析垂直导航落到目标行的光标 offset。
 * goal 优先；缺失时用 fallbackOffset（通常为起跳列）。
 */
export function resolveGoalColumnOffset(
  goal: number | null | undefined,
  textLength: number,
  fallbackOffset = 0,
): number {
  const len = Math.max(0, textLength);
  const raw = goal == null ? fallbackOffset : goal;
  return Math.max(0, Math.min(Math.floor(raw), len));
}

/* ---------- 视觉列测量（canvas measureText，环境缺失时退化为估宽） ---------- */

const DEFAULT_OUTLINE_FONT_SIZE = 15; // 对齐 .node-input 的 15px

let measureCtx: CanvasRenderingContext2D | null | undefined;

function getMeasureContext(): CanvasRenderingContext2D | null {
  if (measureCtx === undefined) {
    try {
      measureCtx =
        typeof document !== 'undefined'
          ? document.createElement('canvas').getContext('2d')
          : null;
    } catch {
      measureCtx = null;
    }
  }
  return measureCtx ?? null;
}

function parseFontSizePx(font: string | null | undefined): number {
  const match = font?.match(/(\d+(?:\.\d+)?)px/);
  const size = match ? Number.parseFloat(match[1]) : NaN;
  return Number.isFinite(size) && size > 0 ? size : DEFAULT_OUTLINE_FONT_SIZE;
}

/** East Asian Wide/Fullwidth 的粗粒度判定，够用即可 */
function isWideCodePoint(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK 部首/汉字/假名等
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容汉字
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // 扩展汉字
  );
}

/** canvas 不可用（如测试环境）时的近似估宽：宽字符记 1em，其余 0.55em */
export function estimateOutlineTextWidth(text: string, font?: string | null): number {
  const em = parseFontSizePx(font);
  let width = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    width += isWideCodePoint(cp) ? em : em * 0.55;
  }
  return width;
}

export function measureOutlineTextWidth(text: string, font?: string | null): number {
  if (!text) return 0;
  const ctx = getMeasureContext();
  if (ctx) {
    try {
      ctx.font = font || `${DEFAULT_OUTLINE_FONT_SIZE}px sans-serif`;
      const width = ctx.measureText(text).width;
      if (Number.isFinite(width) && width > 0) return width;
    } catch {
      // 忽略，走估宽
    }
  }
  return estimateOutlineTextWidth(text, font);
}

/** 读取元素的 canvas font 字符串，供跨节点等宽测量 */
export function getOutlineElementFont(el: Element | null): string | null {
  if (!el || typeof window === 'undefined') return null;
  try {
    const cs = window.getComputedStyle(el);
    if (cs.font) return cs.font;
    const composed = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`.trim();
    return composed || null;
  } catch {
    return null;
  }
}

/**
 * 把像素目标列换算成行内字符 offset：逐字符累计宽度，
 * 超过目标列一半宽度即落在该字符左侧（贴近浏览器原生行为）。
 */
export function resolveVisualColumnOffset(
  lineText: string,
  goalPx: number,
  font?: string | null,
): number {
  if (!lineText || goalPx <= 0) return 0;
  const ctx = getMeasureContext();
  if (ctx) {
    try {
      ctx.font = font || `${DEFAULT_OUTLINE_FONT_SIZE}px sans-serif`;
    } catch {
      // 字体设置失败仍可测量（沿用旧 font）
    }
  }
  const measureChar = (ch: string): number => {
    if (ctx) {
      const width = ctx.measureText(ch).width;
      if (Number.isFinite(width) && width > 0) return width;
    }
    return estimateOutlineTextWidth(ch, font);
  };
  let width = 0;
  let offset = 0;
  for (const ch of lineText) {
    const chWidth = measureChar(ch);
    if (width + chWidth / 2 > goalPx) break;
    width += chWidth;
    offset += ch.length; // 代理对按 UTF-16 长度推进
  }
  return offset;
}

/**
 * 垂直导航进入目标节点时的落点：
 * ↓ 落在第一个逻辑行、↑ 落在最后一个逻辑行；
 * 视觉列（px）优先，缺失时退化为字符列。
 */
export function resolveGoalEntryOffset(
  text: string,
  edge: 'first-line' | 'last-line',
  goal: { column?: number | null; px?: number | null; font?: string | null },
): number {
  const value = text ?? '';
  let lineStart = 0;
  let line = value;
  if (edge === 'first-line') {
    const nl = value.indexOf('\n');
    if (nl !== -1) line = value.slice(0, nl);
  } else {
    const nl = value.lastIndexOf('\n');
    if (nl !== -1) {
      lineStart = nl + 1;
      line = value.slice(lineStart);
    }
  }
  if (goal.px != null) {
    return lineStart + resolveVisualColumnOffset(line, goal.px, goal.font);
  }
  return lineStart + resolveGoalColumnOffset(goal.column ?? null, line.length);
}

/**
 * 多行标题的 ↑/↓ 先交给 textarea；只有位于第一/最后一个逻辑行时才跨节点。
 * 这里按换行符判断，软换行仍由浏览器原生光标移动处理。
 */
export function shouldNavigateAcrossOutlineNode(
  text: string,
  caretOffset: number,
  direction: 'up' | 'down',
): boolean {
  const offset = Math.max(0, Math.min(Math.floor(caretOffset), text.length));
  if (direction === 'up') return !text.slice(0, offset).includes('\n');
  return !text.slice(offset).includes('\n');
}

/** React KeyboardEvent/native KeyboardEvent 均可映射到该最小形状。 */
export function isOutlineCompositionActive(event: {
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return event.isComposing === true || event.keyCode === 229;
}

/** 统计后代节点数（不含自身） */
export function countDescendants(node: Pick<MindMapNode, 'children'>): number {
  let count = 0;
  const walk = (n: Pick<MindMapNode, 'children'>) => {
    const children = n.children ?? [];
    for (const child of children) {
      count += 1;
      walk(child);
    }
  };
  walk(node);
  return count;
}

/**
 * 收集 viewRoot 子树内需折叠/展开的节点 id。
 * viewRoot 自身不折叠（对齐 store.collapseAll 对文档根的处理）。
 */
export function collectSubtreeCollapseTargets(
  root: MindMapNode,
  mode: 'collapse' | 'expand',
): string[] {
  const ids: string[] = [];
  const walk = (node: MindMapNode, isSubtreeRoot: boolean) => {
    const children = node.children ?? [];
    if (!isSubtreeRoot && children.length > 0) {
      const collapsed = !!node.collapsed;
      if (mode === 'collapse' && !collapsed) ids.push(node.id);
      if (mode === 'expand' && collapsed) ids.push(node.id);
    }
    for (const child of children) walk(child, false);
  };
  walk(root, true);
  return ids;
}
