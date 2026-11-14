import type { IStyleTheme } from '../../registry/types';
import { DARK_SAFE_PALETTE } from './palettes';

/**
 * 默认主打主题：Mineral 青瓷微染 - 暗色变体（玄青夜石）
 *
 * 与 defaultTheme 严格结构镜像：fontSize / padding / borderRadius /
 * fontWeight / 边宽 / 边类型完全一致，只允许颜色不同。
 */
export const defaultDarkTheme: IStyleTheme = {
  id: 'default-dark',
  name: 'themes.defaultDark',
  hidden: true,
  node: {
    root: {
      background: '#23453E',
      foreground: '#EAF2EF',
      border: '1px solid rgba(138, 184, 172, 0.22)',
      borderRadius: 10,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
      shadow: '0 6px 20px -4px rgba(0, 0, 0, 0.36)',
    },
    branch: {
      background: '#19211F',
      foreground: '#DCE5E2',
      border: '1px solid rgba(220, 229, 226, 0.10)',
      borderRadius: 8,
      fontSize: 15,
      fontWeight: '500',
      padding: '7px 14px',
      shadow: '0 2px 6px -1px rgba(0, 0, 0, 0.24)',
    },
    leaf: {
      background: 'transparent',
      foreground: '#9BAFA9',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: '#2F3E3A',
    strokeActive: '#5EA893',
    strokeWidth: 1.5,
  },
  palette: DARK_SAFE_PALETTE,
  canvas: {
    background: '#111615',
  },
};
