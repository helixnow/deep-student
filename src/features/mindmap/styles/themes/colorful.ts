import type { IStyleTheme } from '../../registry/types';
import { COLORFUL_LIGHT_PALETTE } from './palettes';

/**
 * 彩色主题（亮色）
 *
 * 根节点渐变与阴影跟随项目品牌 token（--brand-gradient / --primary），
 * 随 data-theme-palette 强调色联动；结构色走 --mm-* 变量。
 */
export const colorfulTheme: IStyleTheme = {
  id: 'colorful',
  name: 'themes.colorful',
  node: {
    root: {
      background: 'var(--brand-gradient)',
      foreground: 'hsl(var(--primary-foreground))',
      border: 'transparent',
      borderRadius: 8,
      fontSize: 18,
      fontWeight: '600',
      padding: '12px 24px',
      shadow: '0 4px 15px hsl(var(--primary) / 0.4)',
    },
    branch: {
      background: 'var(--mm-bg-elevated)',
      foreground: 'var(--mm-text)',
      border: '1px solid var(--mm-border)',
      borderRadius: 6,
      fontSize: 14,
      padding: '8px 14px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'var(--mm-text-secondary)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 13,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'var(--mm-edge)',
    strokeWidth: 2,
  },
  palette: COLORFUL_LIGHT_PALETTE,
  canvas: {
    background: 'var(--mm-bg)',
  },
};
