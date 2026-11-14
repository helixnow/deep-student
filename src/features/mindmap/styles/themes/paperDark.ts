import type { IStyleTheme } from '../../registry/types';
import { PAPER_DARK_PALETTE } from './palettes';

/**
 * Paper 日光亚麻 - 暗色变体（"夜墨"）
 *
 * 暖褐暗色画布 + 亚麻暖白文字，根节点反转为暖亚麻底浓墨字。
 * 与 paper 亮色严格结构镜像（fontSize / padding / borderRadius / 边宽一致，只差颜色）。
 */
export const paperDarkTheme: IStyleTheme = {
  id: 'paper-dark',
  name: 'themes.paperDark',
  hidden: true,
  node: {
    root: {
      background: '#EAE3D5',
      foreground: '#26221E',
      border: 'transparent',
      borderRadius: 10,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
      shadow: '0 4px 14px -2px rgba(0, 0, 0, 0.36)',
    },
    branch: {
      background: '#25221D',
      foreground: 'rgba(242, 237, 228, 0.92)',
      border: '1px solid rgba(242, 237, 228, 0.12)',
      borderRadius: 8,
      fontSize: 15,
      fontWeight: '500',
      padding: '7px 14px',
      shadow: '0 1px 3px 0 rgba(0, 0, 0, 0.24)',
    },
    leaf: {
      background: 'transparent',
      foreground: 'rgba(242, 237, 228, 0.76)',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: '#3D372F',
    strokeActive: '#C89D6C',
    strokeWidth: 1.5,
  },
  palette: PAPER_DARK_PALETTE,
  canvas: {
    background: '#1A1815',
  },
};
