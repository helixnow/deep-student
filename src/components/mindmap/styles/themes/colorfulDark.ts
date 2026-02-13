import type { IStyleTheme } from '../../registry/types';

/**
 * 彩色主题 - 暗色变体
 *
 * 保持彩色渐变、阴影等装饰性风格，将底色适配暗色模式。
 */
export const colorfulDarkTheme: IStyleTheme = {
  id: 'colorful-dark',
  name: 'themes.colorfulDark',
  hidden: true,
  node: {
    root: {
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      foreground: '#FFFFFF',
      border: 'transparent',
      borderRadius: 8,
      fontSize: 18,
      fontWeight: '600',
      padding: '12px 24px',
      shadow: '0 4px 15px rgba(102, 126, 234, 0.4)',
    },
    branch: {
      background: '#2D3748',
      foreground: 'rgba(255, 255, 255, 0.9)',
      border: '1px solid rgba(255, 255, 255, 0.1)',
      borderRadius: 6,
      fontSize: 14,
      padding: '8px 14px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'rgba(255, 255, 255, 0.8)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 13,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'rgba(255, 255, 255, 0.18)',
    strokeWidth: 2,
  },
  palette: [
    '#F56565', // Red
    '#ED8936', // Orange
    '#ECC94B', // Yellow
    '#48BB78', // Green
    '#4299E1', // Blue
    '#9F7AEA', // Purple
    '#ED64A6', // Pink
  ],
  canvas: {
    background: '#1A202C',
  },
};
