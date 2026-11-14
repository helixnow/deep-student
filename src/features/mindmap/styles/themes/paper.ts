import type { IStyleTheme } from '../../registry/types';
import { PAPER_LIGHT_PALETTE } from './palettes';

/**
 * Paper 日光亚麻（Heptabase / Craft 书卷风 - 亮色）
 *
 * 温润蛋壳暖灰画布（#F5F4EE）+ 深焙咖啡炭墨根节点（#2C2825）+
 * 暖白亚麻边一级卡片（#FDFCFB / #E4DFD5），彻底告别发黄陈旧感。
 */
export const paperTheme: IStyleTheme = {
  id: 'paper',
  name: 'themes.paper',
  node: {
    root: {
      background: '#2C2825',
      foreground: '#F7F5F0',
      border: 'transparent',
      borderRadius: 10,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
      shadow: '0 4px 14px -2px rgba(44, 40, 37, 0.12)',
    },
    branch: {
      background: '#FDFCFB',
      foreground: '#332F2B',
      border: '1px solid #E4DFD5',
      borderRadius: 8,
      fontSize: 15,
      fontWeight: '500',
      padding: '7px 14px',
      shadow: '0 1px 3px 0 rgba(44, 40, 37, 0.04)',
    },
    leaf: {
      background: 'transparent',
      foreground: '#575049',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: '#CFC8B8',
    strokeActive: '#8C6239',
    strokeWidth: 1.5,
  },
  palette: PAPER_LIGHT_PALETTE,
  canvas: {
    background: '#F5F4EE',
  },
};
