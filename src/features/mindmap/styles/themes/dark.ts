import type { IStyleTheme } from '../../registry/types';
import { DARK_SAFE_PALETTE } from './palettes';

/**
 * 显式暗色主题（简洁风格深色）
 *
 * 与 hidden 的 default-dark 是两套不同视觉：
 * - dark：用户主动选择的独立主题，主色根节点（primary 底），任何模式下都是深色视觉；
 * - default-dark：default 主题在应用暗色模式下的自动映射变体，结构与 default 镜像。
 * 两者的彩虹 palette 对齐为同一套暗色安全色板（DARK_SAFE_PALETTE）。
 */
export const darkTheme: IStyleTheme = {
  id: 'dark',
  name: 'themes.dark',
  node: {
    root: {
      background: 'hsl(var(--primary))',
      foreground: 'hsl(var(--primary-foreground))',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 16,
      fontWeight: '600',
      padding: '10px 20px',
    },
    branch: {
      background: 'hsl(var(--secondary))',
      foreground: 'hsl(var(--foreground) / 0.9)',
      border: 'hsl(var(--foreground) / 0.09)',
      borderRadius: 4,
      fontSize: 14,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'hsl(var(--foreground) / 0.9)',
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
  palette: DARK_SAFE_PALETTE,
  canvas: {
    background: 'var(--mm-bg)',
  },
};
