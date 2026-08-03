import type { IStyleTheme } from '../../registry/types';
import { MINIMAL_LIGHT_PALETTE } from './palettes';

/**
 * 极简主题（亮色）
 *
 * 原先硬编码 #FFFFFF / #000000，已 token 化为 --mm-* 变量，
 * 跟随应用主题背景（自定义浅色调色板下不再突兀）。
 * "黑底白字根节点"的极简视觉通过反转 token（--mm-text 作底、--mm-bg 作字）保留。
 */
export const minimalTheme: IStyleTheme = {
  id: 'minimal',
  name: 'themes.minimal',
  node: {
    root: {
      // 反转 token：亮色模式下等效于旧版黑底白字
      background: 'var(--mm-text)',
      foreground: 'var(--mm-bg)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 16,
      fontWeight: '600',
      padding: '8px 16px',
    },
    branch: {
      background: 'var(--mm-bg-elevated)',
      foreground: 'var(--mm-text)',
      border: '1px solid var(--mm-border)',
      borderRadius: 4,
      fontSize: 14,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'var(--mm-text)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'var(--mm-border)',
    strokeWidth: 1,
  },
  palette: MINIMAL_LIGHT_PALETTE,
  canvas: {
    background: 'var(--mm-bg)',
  },
};
