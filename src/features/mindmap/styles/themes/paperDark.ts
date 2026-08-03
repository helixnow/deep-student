import type { IStyleTheme } from '../../registry/types';
import { PAPER_DARK_PALETTE } from './palettes';

/**
 * 纸墨主题 - 暗色变体（"夜墨"）
 *
 * 暖褐暗色画布 + 宣纸色文字，根节点反转为宣纸底浓墨字。
 * 与 paper 亮色严格结构镜像（fontSize / padding / borderRadius / 边宽一致，只差颜色）。
 *
 * 注意：与其他 *-dark 主题不同，纸墨的暖色调画布是主题 identity，
 * 有意不走 --mm-* token（token 会跟随应用中性色背景，破坏纸感），
 * 因此本主题在 token 测试中按 identity 主题单独断言（暖暗色、无纯白闪底）。
 * i18n key：themes.paperDark（由外壳子代理补充翻译）。
 */
export const paperDarkTheme: IStyleTheme = {
  id: 'paper-dark',
  name: 'themes.paperDark',
  hidden: true,
  node: {
    root: {
      // 宣纸底、浓墨字（亮色根节点的反转）
      background: '#EFE6D2',
      foreground: '#26221B',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 18,
      fontWeight: '600',
      padding: '10px 20px',
    },
    branch: {
      background: '#2B261E',
      foreground: 'rgba(240, 234, 220, 0.92)',
      border: '1px solid rgba(240, 234, 220, 0.16)',
      borderRadius: 4,
      fontSize: 15,
      padding: '6px 12px',
    },
    leaf: {
      background: 'transparent',
      foreground: 'rgba(240, 234, 220, 0.78)',
      border: 'transparent',
      borderRadius: 4,
      fontSize: 14,
      padding: '4px 8px',
    },
  },
  edge: {
    type: 'bezier',
    stroke: 'rgba(240, 234, 220, 0.22)',
    strokeWidth: 1.5,
  },
  palette: PAPER_DARK_PALETTE,
  canvas: {
    background: '#201C15',
  },
};
