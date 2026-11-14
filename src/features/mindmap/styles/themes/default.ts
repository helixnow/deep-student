import type { IStyleTheme } from '../../registry/types';
import { DEFAULT_LIGHT_PALETTE } from './palettes';

/**
 * 默认主打主题：Mineral 青瓷微染（Mineral Zen - 亮色）
 *
 * 用户钦定首选高定主题：
 * - 画布：#F4F6F5（带 2% 灰绿冷调的青瓷雾白，沉静护眼）
 * - 根节点：#1E3A34 深松烟青 + #F2F7F5 浅青白字，圆角 10px
 * - 一级分支：#FBFCFC 纯净微暖白卡片 + 1px solid rgba(30, 58, 52, 0.11)，圆角 8px
 * - 枝叶节点：透明无框排版流
 * - 连线：#BCCBC6 青灰石色，激活态 #2A6F5E 青瓷主色
 */
export const defaultTheme: IStyleTheme = {
  id: 'default',
  name: 'themes.default',
  node: {
    root: {
      background: '#1E3A34',
      foreground: '#F2F7F5',
      border: '1px solid #1E3A34',
      borderRadius: 10,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
      shadow: '0 6px 20px -4px rgba(20, 40, 36, 0.14), 0 2px 6px -1px rgba(20, 40, 36, 0.06)',
    },
    branch: {
      background: '#FBFCFC',
      foreground: '#182220',
      border: '1px solid rgba(30, 58, 52, 0.11)',
      borderRadius: 8,
      fontSize: 15,
      fontWeight: '500',
      padding: '7px 14px',
      shadow: '0 2px 5px -1px rgba(20, 40, 36, 0.05), 0 1px 2px 0 rgba(20, 40, 36, 0.03)',
    },
    leaf: {
      background: 'transparent',
      foreground: '#41524E',
      border: 'transparent',
      borderRadius: 6,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: '#BCCBC6',
    strokeActive: '#2A6F5E',
    strokeWidth: 1.5,
  },
  palette: DEFAULT_LIGHT_PALETTE,
  canvas: {
    background: '#F4F6F5',
  },
};
