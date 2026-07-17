import type { IStyleTheme } from '../../registry/types';

/**
 * 默认主题 - 暗色变体
 *
 * 与 defaultTheme 保持相同的结构和风格感觉，
 * 但将颜色反转为适合暗色模式的配色。
 * 结构色全部走全局 CSS 变量，随 html.dark / 调色板自动适配。
 */
export const defaultDarkTheme: IStyleTheme = {
  id: 'default-dark',
  name: 'themes.defaultDark',
  hidden: true,
  node: {
    root: {
      background: 'var(--mm-bg-elevated)',
      foreground: 'hsl(var(--foreground) / 0.9)',
      border: '2px solid hsl(var(--foreground) / 0.8)',
      borderRadius: 6,
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
  palette: [
    '#E05252', // Red
    '#E69038', // Orange
    '#EBCB4B', // Yellow
    '#5BB98C', // Green
    '#2EAADC', // Blue (Primary)
    '#6C63FF', // Purple
    '#F2668B', // Pink
  ],
  canvas: {
    background: 'var(--mm-bg)',
  },
};
