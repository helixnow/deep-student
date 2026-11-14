import type { IStyleTheme } from '../../registry/types';
import { COLORFUL_LIGHT_PALETTE } from './palettes';

/**
 * 矿彩微光主题（亮色）
 *
 * 根节点渐变与阴影跟随项目品牌 token（--brand-gradient / --primary），
 * 几何比例对齐高定规范（Root 圆角 10px、Branch 圆角 8px、Leaf 圆角 6px）。
 */
export const colorfulTheme: IStyleTheme = {
  id: 'colorful',
  name: 'themes.colorful',
  node: {
    root: {
      background: 'var(--brand-gradient)',
      foreground: 'hsl(var(--primary-foreground))',
      border: 'transparent',
      borderRadius: 10,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
      shadow: '0 6px 18px hsl(var(--primary) / 0.22)',
    },
    branch: {
      background: 'var(--mm-bg-elevated)',
      foreground: 'var(--mm-text)',
      border: '1px solid var(--mm-border)',
      borderRadius: 8,
      fontSize: 15,
      fontWeight: '500',
      padding: '7px 14px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'var(--mm-text-secondary)',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'var(--mm-edge)',
    strokeWidth: 1.5,
  },
  palette: COLORFUL_LIGHT_PALETTE,
  canvas: {
    background: 'var(--mm-bg)',
  },
};
