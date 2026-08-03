import type { IStyleTheme } from '../../registry/types';
import { DARK_SAFE_PALETTE } from './palettes';

/**
 * 默认主题 - 暗色变体
 *
 * 与 defaultTheme 严格结构镜像：fontSize / padding / borderRadius /
 * fontWeight / 边宽 / 边类型完全一致，只允许颜色不同。
 * 结构色全部走全局 CSS 变量，随 html.dark / 调色板自动适配。
 * palette 与显式 dark 主题共用同一套暗色安全色板（DARK_SAFE_PALETTE）。
 */
export const defaultDarkTheme: IStyleTheme = {
  id: 'default-dark',
  name: 'themes.defaultDark',
  hidden: true,
  node: {
    root: {
      background: 'var(--mm-bg-elevated)',
      foreground: 'hsl(var(--foreground) / 0.9)',
      border: '1px solid var(--mm-border-strong)',
      borderRadius: 4,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
    },
    branch: {
      background: 'hsl(var(--secondary))',
      foreground: 'hsl(var(--foreground) / 0.9)',
      border: '1px solid hsl(var(--foreground) / 0.12)',
      borderRadius: 4,
      fontSize: 15,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'hsl(var(--foreground) / 0.85)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'hsl(var(--foreground) / 0.15)',
    strokeWidth: 1.5,
  },
  palette: DARK_SAFE_PALETTE,
  canvas: {
    background: 'var(--mm-bg)',
  },
};
