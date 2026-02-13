import type { IStyleTheme } from '../../registry/types';

/**
 * 默认主题 - 暗色变体
 *
 * 与 defaultTheme 保持相同的结构和风格感觉，
 * 但将颜色反转为适合暗色模式的配色。
 */
export const defaultDarkTheme: IStyleTheme = {
  id: 'default-dark',
  name: 'themes.defaultDark',
  hidden: true,
  node: {
    root: {
      background: '#2a2a2a',
      foreground: 'rgba(255, 255, 255, 0.9)',
      border: '2px solid rgba(255, 255, 255, 0.8)',
      borderRadius: 6,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
    },
    branch: {
      background: '#252525',
      foreground: 'rgba(255, 255, 255, 0.9)',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      borderRadius: 4,
      fontSize: 15,
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
    stroke: 'rgba(255, 255, 255, 0.15)',
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
    background: '#191919',
  },
};
