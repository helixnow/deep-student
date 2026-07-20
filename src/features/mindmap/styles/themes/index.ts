import type { IStyleTheme } from '../../registry/types';

export { defaultTheme } from './default';
export { darkTheme } from './dark';
export { minimalTheme } from './minimal';
export { colorfulTheme } from './colorful';
export { paperTheme } from './paper';
export { defaultDarkTheme } from './defaultDark';
export { minimalDarkTheme } from './minimalDark';
export { colorfulDarkTheme } from './colorfulDark';
export { paperDarkTheme } from './paperDark';
export * from './palettes';

import { defaultTheme } from './default';
import { darkTheme } from './dark';
import { minimalTheme } from './minimal';
import { colorfulTheme } from './colorful';
import { paperTheme } from './paper';
import { defaultDarkTheme } from './defaultDark';
import { minimalDarkTheme } from './minimalDark';
import { colorfulDarkTheme } from './colorfulDark';
import { paperDarkTheme } from './paperDark';

export const builtinThemes = [
  defaultTheme,
  darkTheme,
  minimalTheme,
  colorfulTheme,
  paperTheme,
  // 暗色变体（hidden: true，不会出现在主题选择列表中，
  // 由 StyleRegistry.get() 在暗色模式下自动解析）
  defaultDarkTheme,
  minimalDarkTheme,
  colorfulDarkTheme,
  paperDarkTheme,
];

// ============================================================================
// 主题字号 / padding 单一数据源
// ============================================================================

/** 节点文本行高系数（与节点渲染 CSS line-height 1.5 对齐） */
export const MM_NODE_LINE_HEIGHT_RATIO = 1.5;

/**
 * 主题字体度量：布局估算（宽高计算）与节点渲染 fallback 的权威数据源。
 *
 * 接入方（其他子代理负责）：
 * - utils/layout/helpers.ts 的 estimateNodeWidth/Height（替换硬编码 root 18 / branch 14-15）
 * - nodes/BranchNode.tsx 等节点组件的 fallback 值（替换硬编码 '14px' / '6px 12px'）
 */
export interface ThemeFontMetrics {
  /** 字号（px） */
  fontSize: number;
  /** 行高（px，fontSize * MM_NODE_LINE_HEIGHT_RATIO 向上取整） */
  lineHeight: number;
  /** 字重（如 '600'，未指定时 undefined） */
  fontWeight?: string;
  /** 水平内边距合计（左 + 右，px） */
  paddingX: number;
  /** 垂直内边距合计（上 + 下，px） */
  paddingY: number;
}

/** 解析 CSS padding 简写（1-4 值，仅支持 px），返回水平/垂直合计 */
function parsePaddingSums(padding: string | undefined): { x: number; y: number } | undefined {
  if (!padding) return undefined;
  const parts = padding
    .trim()
    .split(/\s+/)
    .map(p => Number.parseFloat(p));
  if (parts.length === 0 || parts.some(Number.isNaN)) return undefined;
  const [top, right = top, bottom = top, left = right] = parts;
  return { x: left + right, y: top + bottom };
}

/**
 * 获取主题的权威字体度量。
 *
 * @param theme  样式主题（缺省或字段缺失时回退到 defaultTheme 对应级别的值）
 * @param isRoot true 取根节点度量，false 取分支节点度量
 */
export function getThemeFontMetrics(
  theme: IStyleTheme | null | undefined,
  isRoot: boolean,
): ThemeFontMetrics {
  const level = isRoot ? 'root' : 'branch';
  const fallback = defaultTheme.node![level];
  const style = theme?.node?.[level] ?? fallback;

  const fontSize = style.fontSize ?? fallback.fontSize;
  const padding = parsePaddingSums(style.padding) ?? parsePaddingSums(fallback.padding)!;

  return {
    fontSize,
    lineHeight: Math.ceil(fontSize * MM_NODE_LINE_HEIGHT_RATIO),
    fontWeight: style.fontWeight,
    paddingX: padding.x,
    paddingY: padding.y,
  };
}
