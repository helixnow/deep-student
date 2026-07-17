import type { IStyleTheme } from '../../registry/types';

/**
 * 极简主题 - 暗色变体
 *
 * 保持极简风格（纯色、无装饰）。根节点使用半透明主题色底 + 浅字，
 * 避免旧版白底黑字在暗色模式下突兀。
 */
export const minimalDarkTheme: IStyleTheme = {
  id: 'minimal-dark',
  name: 'themes.minimalDark',
  hidden: true,
  node: {
    root: {
      background: 'hsl(var(--primary) / 0.22)',
      foreground: 'hsl(var(--foreground))',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 16,
      fontWeight: '600',
      padding: '8px 16px',
    },
    branch: {
      background: 'hsl(var(--secondary))',
      foreground: 'hsl(var(--foreground) / 0.9)',
      border: '1px solid hsl(var(--foreground) / 0.12)',
      borderRadius: 4,
      fontSize: 14,
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
    stroke: 'hsl(var(--foreground) / 0.12)',
    strokeWidth: 1,
  },
  canvas: {
    background: 'var(--mm-bg)',
  },
};
