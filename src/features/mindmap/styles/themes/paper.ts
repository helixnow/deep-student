import type { IStyleTheme } from '../../registry/types';
import { PAPER_LIGHT_PALETTE } from './palettes';

/**
 * 纸墨主题（亮色）
 *
 * 宣纸底 + 墨色文字的书卷气主题。
 * 暖米色画布 / 浓墨根节点 / 纸白分支卡片是主题 identity，
 * 有意不跟随应用背景（与 colorful 渐变同理），因此保留硬编码色值。
 * i18n key：themes.paper（由外壳子代理补充翻译）。
 */
export const paperTheme: IStyleTheme = {
  id: 'paper',
  name: 'themes.paper',
  node: {
    root: {
      // 浓墨底、宣纸字（identity 色）
      background: '#2F2A24',
      foreground: '#F7F2E7',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
    },
    branch: {
      background: '#FFFDF7',
      foreground: '#3B3630',
      border: '1px solid #D8CFBC',
      borderRadius: 4,
      fontSize: 15,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: '#5A5243',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: '#C4B99F',
    strokeWidth: 1.5,
  },
  palette: PAPER_LIGHT_PALETTE,
  canvas: {
    background: '#F6F1E4',
  },
};
