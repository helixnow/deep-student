/**
 * InputBar 配置常量（从 InputBarUI.tsx 拆出，供 ComposerTextarea / ComposerToolbar 等共享）
 *
 * 集中管理输入栏的各种硬编码值，便于维护和调整。
 */

import { MOBILE_LAYOUT } from '@/config/mobileLayout';

export const INPUT_BAR_CONFIG = {
  /** 延迟时间配置 */
  delays: {
    /** 副作用延迟初始化时间 */
    idle: 100,
    /** 重 UI/重计算延迟挂载时间 */
    heavyUI: 400,
  },
  /** 高度相关配置 */
  heights: {
    /** 首帧固定高度占位，避免布局抖动 */
    placeholder: MOBILE_LAYOUT.inputBar.placeholderHeight,
    /** ResizeObserver 高度变化阈值（小于此值不更新状态） */
    changeThreshold: MOBILE_LAYOUT.inputBar.heightChangeThreshold,
    /** textarea 最小高度 */
    textareaMin: 40,
    /** textarea 最大高度（超出后才允许内部滚动）；220px ≈ 8 行，长草稿编辑不憋屈 */
    textareaMax: 220,
  },
  /** 粘贴策略 */
  paste: {
    /** 超过该字符数时，粘贴后提供「转为附件」内联建议（文本默认进输入框） */
    longTextSuggestChars: 1000,
    /** 超过该字符数时，直接转为 .txt 附件（避免超长文本拖垮输入框） */
    longTextAutoAttachChars: 50000,
  },
  /** 响应式断点 */
  breakpoints: {
    /** 移动端断点 */
    mobile: 768,
  },
  /** 间距配置 */
  gaps: {
    /** 桌面端底部间距 */
    desktop: 0,
    /** 移动端底部间距：应用导航已进入侧边栏，只保留系统安全区 */
    mobile: 0,
  },
};

export function getFileExtension(fileName: string): string {
  const parts = fileName.split('.');
  return parts.length > 1 ? parts.pop()!.toLowerCase() : '';
}
