import type { IStyleTheme } from '../../registry/types';

/**
 * 彩色主题 - 暗色变体
 *
 * 保持彩色渐变、阴影等装饰性风格，结构底色适配暗色模式全局 token。
 */
export const colorfulDarkTheme: IStyleTheme = {
  id: 'colorful-dark',
  name: 'themes.colorfulDark',
  hidden: true,
  node: {
    root: {
      // 品牌渐变保留（与亮色 colorful 同源），阴影透明度改走 primary token
      background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
      foreground: 'hsl(var(--primary-foreground))',
      border: 'transparent',
      borderRadius: 8,
      fontSize: 18,
      fontWeight: '600',
      padding: '12px 24px',
      shadow: '0 4px 15px hsl(var(--primary) / 0.4)',
    },
    branch: {
      background: 'hsl(var(--muted))',
      foreground: 'hsl(var(--foreground) / 0.9)',
      border: '1px solid hsl(var(--foreground) / 0.1)',
      borderRadius: 6,
      fontSize: 14,
      padding: '8px 14px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'hsl(var(--foreground) / 0.8)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 13,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'hsl(var(--foreground) / 0.18)',
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
    background: 'var(--mm-bg)',
  },
};
