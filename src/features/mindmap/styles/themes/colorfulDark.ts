import type { IStyleTheme } from '../../registry/types';
import { COLORFUL_DARK_PALETTE } from './palettes';

/**
 * 彩色主题 - 暗色变体
 *
 * 根节点渐变与亮色 colorful 同走 --brand-gradient（暗色下 primary 族自动变浅），
 * 结构底色适配暗色模式全局 token。
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
  palette: COLORFUL_DARK_PALETTE,
  canvas: {
    background: 'var(--mm-bg)',
  },
};
