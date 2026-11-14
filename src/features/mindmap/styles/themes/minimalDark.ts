import type { IStyleTheme } from '../../registry/types';
import { MINIMAL_DARK_PALETTE } from './palettes';

/**
 * Stone 冷灰石韵 - 暗色变体
 *
 * 结构参数（fontSize / padding / borderRadius / 边宽）与 minimal 亮色严格镜像。
 */
export const minimalDarkTheme: IStyleTheme = {
  id: 'minimal-dark',
  name: 'themes.minimalDark',
  hidden: true,
  node: {
    root: {
      background: '#262B35',
      foreground: '#F1F5F9',
      border: '1px solid rgba(255, 255, 255, 0.12)',
      borderRadius: 10,
      fontSize: 17,
      fontWeight: '600',
      padding: '10px 20px',
      shadow: '0 4px 14px -2px rgba(0, 0, 0, 0.34)',
    },
    branch: {
      background: '#1A1D24',
      foreground: '#E2E8F0',
      border: '1px solid rgba(255, 255, 255, 0.08)',
      borderRadius: 8,
      fontSize: 15,
      fontWeight: '500',
      padding: '7px 14px',
      shadow: '0 1px 3px 0 rgba(0, 0, 0, 0.22)',
    },
    leaf: {
      background: 'transparent',
      foreground: '#94A3B8',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: '#333945',
    strokeActive: '#6B9EBD',
    strokeWidth: 1.35,
  },
  palette: MINIMAL_DARK_PALETTE,
  canvas: {
    background: '#121316',
  },
};
