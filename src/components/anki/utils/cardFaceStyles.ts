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
  /**
   * 卡面文档的显式背景色（resolveCardFaceSurfaceColor 的解析值）。
   *
   * 为什么需要：桌面 Chromium 的 iframe 画布透明，卡面透显父级主题表面
   * （iframe 元素自身有 background: hsl(var(--background))）；但移动端
   * WebView 的 iframe 画布恒为不透明白色——深色模式下"白画布 + 暗色兜底的
   * 浅色文字"会让卡面全白不可见。显式写入同一表面色后两端一致：
   * 桌面视觉零变化（本来就透显这个色），移动端修复白底。
   * 模板若自带背景（.card 等内层元素）不受影响，仍可覆盖。
   */
  surfaceColor?: string | null;
}

/**
 * 组合卡面最终 CSS：辅助样式 + 归一化后的模板样式 +（可选）显式背景 +（可选）暗色兜底。
 * 纯函数，可重复调用，结果幂等。
 */
export function buildCardFaceCss(
  templateCss: string | null | undefined,
  options: BuildCardFaceCssOptions = {},
): string {
  const parts = [CARD_FACE_HELPER_CSS, normalizeCssForRender(templateCss || '')];
  if (options.surfaceColor) {
    // 与基础样式 html,body{background:transparent} 等特异性（0-0-1），
    // 靠级联顺序（模板 CSS 注入在基础样式之后）覆盖；在暗色兜底之前声明，
    // 不影响其 :where() 前景色兜底。
    parts.push(`html, body { background: ${options.surfaceColor}; }`);
  }
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

// ============================================================================
// 卡面文档背景色解析（移动端 WebView iframe 白底修复）
// ============================================================================

/**
 * 解析应用主题表面色（hsl(var(--background))）为具体颜色值。
 *
 * 用途：把该颜色显式写进卡面 iframe 文档（buildCardFaceCss 的 surfaceColor）。
 * 桌面 Chromium 的 iframe 画布透明、透显父级该表面色；移动端 WebView 的
 * iframe 画布恒为不透明白——显式背景让两端一致（桌面视觉零变化）。
 *
 * 结果按主题签名缓存（主题切换时 MutationObserver 触发订阅方重取）。
 */
let surfaceColorCache: { key: string; value: string | null } | null = null;

export function resolveCardFaceSurfaceColor(): string | null {
  if (typeof document === 'undefined') return null;
  const root = document.documentElement;
  const key = `${root.className}|${root.getAttribute('data-theme') ?? ''}`;
  if (surfaceColorCache?.key === key) return surfaceColorCache.value;
  if (!document.body) return null;

  // 探针元素：把主题变量表达式交给浏览器求值，读出 rgb() 具体值
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:absolute;visibility:hidden;pointer-events:none;background:hsl(var(--background))';
  document.body.appendChild(probe);
  const value = getComputedStyle(probe).backgroundColor || null;
  probe.remove();

  surfaceColorCache = { key, value };
  return value;
}

/** 订阅主题变化并返回当前卡面文档应使用的表面色（未解析到时为 null） */
export function useCardFaceSurfaceColor(): string | null {
  return useSyncExternalStore(subscribeToThemeChanges, resolveCardFaceSurfaceColor, () => null);
}
