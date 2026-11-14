import type { IStyleTheme } from '../../registry/types';
import { MINIMAL_LIGHT_PALETTE } from './palettes';

/**
 * Stone 冷灰石韵（Linear / Nordic Slate 风 - 亮色）
 *
 * 精密、冷静、现代建筑感：
 * - 画布：#F6F7F9 微冷雾灰底，衬托纯白一级节点卡片
 * - 根节点：#1E232B 深石墨岩石色 + #F8FAFC 冰雪白字，圆角 10px
 * - 一级分支：#FFFFFF 纯白卡片 + 1px solid rgba(15, 23, 42, 0.09)，圆角 8px
 * - 枝叶节点：透明无框排版流
 */
export const minimalTheme: IStyleTheme = {
  id: 'minimal',
  name: 'themes.minimal',
  node: {
    root: {
      background: '#1E232B',
      foreground: '#F8FAFC',
      border: '1px solid #1E232B',
      borderRadius: 10,
      fontSize: 17,
      fontWeight: '600',
      padding: '10px 20px',
      shadow: '0 4px 14px -2px rgba(15, 23, 42, 0.10), 0 1px 3px 0 rgba(15, 23, 42, 0.05)',
    },
    branch: {
      background: '#FFFFFF',
      foreground: '#1E293B',
      border: '1px solid rgba(15, 23, 42, 0.09)',
      borderRadius: 8,
      fontSize: 15,
      fontWeight: '500',
      padding: '7px 14px',
      shadow: '0 1px 3px 0 rgba(15, 23, 42, 0.04), 0 1px 2px -1px rgba(15, 23, 42, 0.02)',
    },
    leaf: {
      background: 'transparent',
      foreground: '#475569',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: '#CBD5E1',
    strokeActive: '#3B6E8C',
    strokeWidth: 1.35,
  },
  palette: MINIMAL_LIGHT_PALETTE,
  canvas: {
    background: '#F6F7F9',
  },
};
