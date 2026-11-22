import type { IStyleTheme } from '../../registry/types';
import { DARK_SAFE_PALETTE } from './palettes';

/**
 * 显式暗色主题（深邃暗夜）
 *
 * 与 hidden 的 default-dark 是两套不同视觉：
 * - dark：用户主动选择的独立深色主题，无论全局应用是亮色还是暗色模式，
 *   均以固定低眩光暗夜护眼灰（#17191C 画布 / #22262B 节点底 / #E4E7EC 文字 / #3C434D 边线）渲染，
 *   绝不随亮色模式退化为浅灰白底；
 * - default-dark：default 主题在应用暗色模式下的自动映射变体，结构与 default 镜像。
 * 两者的彩虹 palette 对齐为同一套暗色安全色板（DARK_SAFE_PALETTE）。
 */
export const darkTheme: IStyleTheme = {
  id: 'dark',
  name: 'themes.dark',
  node: {
    root: {
      background: '#2A3340',
      foreground: '#F0F3F6',
      border: '1px solid rgba(228, 231, 236, 0.16)',
      borderRadius: 10,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
      shadow: '0 6px 20px -4px rgba(0, 0, 0, 0.42)',
    },
    branch: {
      background: '#22262B',
      foreground: '#E4E7EC',
      border: '1px solid rgba(228, 231, 236, 0.12)',
      borderRadius: 8,
      fontSize: 15,
      fontWeight: '500',
      padding: '7px 14px',
      shadow: '0 2px 6px -1px rgba(0, 0, 0, 0.28)',
    },
    leaf: {
      background: 'transparent',
      foreground: '#B6BEC9',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: '#3C434D',
    strokeActive: '#6B9EBD',
    strokeWidth: 1.5,
  },
  palette: DARK_SAFE_PALETTE,
  useBranchPalette: false,
  canvas: {
    background: '#17191C',
  },
};
