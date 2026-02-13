import type { IStyleTheme } from '../../registry/types';

/**
 * 极简主题 - 暗色变体
 *
 * 保持极简风格（纯色、无装饰），将黑白反转以适配暗色模式。
 */
export const minimalDarkTheme: IStyleTheme = {
  id: 'minimal-dark',
  name: 'themes.minimalDark',
  hidden: true,
  node: {
    root: {
      background: '#FFFFFF',
      foreground: '#000000',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 16,
      fontWeight: '600',
      padding: '8px 16px',
    },
    branch: {
      background: '#252525',
      foreground: 'rgba(255, 255, 255, 0.9)',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      borderRadius: 4,
      fontSize: 14,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'rgba(255, 255, 255, 0.85)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'rgba(255, 255, 255, 0.12)',
    strokeWidth: 1,
  },
  canvas: {
    background: '#1a1a1a',
  },
};
