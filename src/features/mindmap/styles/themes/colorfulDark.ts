import type { IStyleTheme } from '../../registry/types';
import { COLORFUL_DARK_PALETTE } from './palettes';

/**
 * 矿彩微光主题 - 暗色变体
 *
 * 结构参数（fontSize / padding / borderRadius / 边宽）与 colorful 亮色严格镜像。
 */
export const colorfulDarkTheme: IStyleTheme = {
  id: 'colorful-dark',
  name: 'themes.colorfulDark',
  hidden: true,
  node: {
    root: {
      background: 'var(--brand-gradient)',
      foreground: 'hsl(var(--primary-foreground))',
      border: 'transparent',
      borderRadius: 10,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
      shadow: '0 6px 18px hsl(var(--primary) / 0.25)',
    },
    branch: {
      background: 'hsl(var(--muted))',
      foreground: 'hsl(var(--foreground) / 0.9)',
      border: '1px solid hsl(var(--foreground) / 0.1)',
      borderRadius: 8,
      fontSize: 15,
      fontWeight: '500',
      padding: '7px 14px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'hsl(var(--foreground) / 0.8)',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'hsl(var(--foreground) / 0.18)',
    strokeWidth: 1.5,
  },
  palette: COLORFUL_DARK_PALETTE,
  canvas: {
    background: 'var(--mm-bg)',
  },
};
