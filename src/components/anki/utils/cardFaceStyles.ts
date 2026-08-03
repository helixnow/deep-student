/**
 * 卡面渲染期样式工具
 *
 * 该模块只在渲染时对模板 CSS 做安全、幂等的归一化处理，
 * 绝不回写/持久化模板数据（历史上启动时静默改写模板 CSS 的逻辑已移除）。
 */

import { useSyncExternalStore } from 'react';

/**
 * 渲染期 CSS 归一化（纯函数、幂等）：
 * 将 overflow: hidden 放宽为 auto，让卡面内容溢出时滚动而不是被裁剪。
 * 仅影响本次渲染注入 iframe 的 CSS，不修改模板本身。
 */
export function normalizeCssForRender(css: string): string {
  if (!css) return '';
  return css.replace(/\boverflow(-x|-y)?(\s*:\s*)hidden\b/gi, 'overflow$1$2auto');
}

/**
 * 卡面辅助样式：hint 展开、type 输入占位、音频徽标、媒体自适应。
 * 使用 :where() 保持零特异性，模板自带样式始终优先。
 */
export const CARD_FACE_HELPER_CSS = `
:where(img) { max-width: 100%; height: auto; }
:where(audio) { display: block; width: 100%; max-width: 320px; margin: 6px auto; }
:where(video) { max-width: 100%; height: auto; }
.anki-hint { display: inline-block; margin: 2px 0; }
.anki-hint > .anki-hint-summary {
  cursor: pointer;
  color: #2563eb;
  text-decoration: underline dotted;
  list-style: none;
  display: inline;
  user-select: none;
}
.anki-hint > .anki-hint-summary::-webkit-details-marker { display: none; }
.anki-hint[open] > .anki-hint-summary { opacity: 0.65; }
.anki-hint > .anki-hint-content { display: inline-block; margin-left: 0.4em; }
.anki-sound {
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
  padding: 0.1em 0.55em;
  border: 1px solid currentColor;
  border-radius: 999px;
  font-size: 0.85em;
  line-height: 1.4;
  opacity: 0.75;
  vertical-align: baseline;
}
.anki-sound-name { max-width: 14em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.anki-type-input {
  display: inline-block;
  min-width: 10em;
  min-height: 1.2em;
  border-bottom: 1.5px dashed currentColor;
  opacity: 0.6;
  vertical-align: baseline;
}
.anki-type-answer { font-weight: 600; border-bottom: 1.5px solid currentColor; }
`;

/**
 * 暗色模式兼容样式：零特异性兜底，模板自带的颜色声明始终覆盖这里。
 * 只为“未声明任何颜色”的模板提供可读的默认前景色。
 */
export const CARD_FACE_DARK_CSS = `
:where(html) { color-scheme: dark; }
:where(body) { color: #e5e7eb; }
:where(a) { color: #93c5fd; }
:where(hr) { border-color: rgba(255, 255, 255, 0.18); }
.anki-hint > .anki-hint-summary { color: #93c5fd; }
`;

export interface BuildCardFaceCssOptions {
  darkMode?: boolean;
}

/**
 * 组合卡面最终 CSS：辅助样式 + 归一化后的模板样式 +（可选）暗色兜底。
 * 纯函数，可重复调用，结果幂等。
 */
export function buildCardFaceCss(
  templateCss: string | null | undefined,
  options: BuildCardFaceCssOptions = {},
): string {
  const parts = [CARD_FACE_HELPER_CSS, normalizeCssForRender(templateCss || '')];
  if (options.darkMode) {
    parts.push(CARD_FACE_DARK_CSS);
  }
  return parts.join('\n');
}

const subscribeToThemeChanges = (onChange: () => void): (() => void) => {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {};
  }
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'data-theme'],
  });
  return () => observer.disconnect();
};

const getDarkModeSnapshot = (): boolean => {
  if (typeof document === 'undefined') return false;
  const root = document.documentElement;
  return root.classList.contains('dark') || root.getAttribute('data-theme') === 'dark';
};

/**
 * 订阅应用级暗色模式（:root.dark / [data-theme="dark"]）。
 */
export function useDocumentDarkMode(): boolean {
  return useSyncExternalStore(subscribeToThemeChanges, getDarkModeSnapshot, () => false);
}
