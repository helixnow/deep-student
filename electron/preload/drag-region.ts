/**
 * `data-tauri-drag-region` 在 Electron 中的等价实现。
 *
 * Tauri（tauri-2.11.5 `src/window/scripts/drag.js`）在 mousedown 时沿 composedPath 判断：
 * - 属性为空或 `"true"`：只有直接点在该元素本身才拖动（子元素不拖动）；
 * - `"deep"`：子树内任意位置都拖动；
 * - `"false"`：禁止拖动（并阻断祖先）；
 * - 路径上先遇到可点击元素（a/button/input/select/textarea/label/summary、contenteditable、
 *   tabindex≠-1、交互 role）且它没有该属性时，不拖动。
 * 双击（Windows/Linux 按下时，macOS 抬起时）切换最大化。
 *
 * Electron 只能用静态的 `-webkit-app-region` 声明可拖动区域（Chromium 会把拖动与双击最大化交给系统），
 * 因此把上述规则翻译成 CSS：拖动区域本身 `drag`，"self" 区域的直接子元素与 "deep" 区域内的可点击元素
 * `no-drag`，嵌套的拖动区域重新 `drag`。`no-drag` 的矩形覆盖其整个子树，与"路径上被阻断"的效果一致。
 */
const ATTR = 'data-tauri-drag-region';

const CLICKABLE =
  'a,button,input,select,textarea,label,summary,' +
  '[contenteditable]:not([contenteditable="false"]),' +
  '[tabindex]:not([tabindex="-1"]),' +
  '[role="button"],[role="link"],[role="menuitem"],[role="tab"],[role="checkbox"],[role="radio"],[role="switch"],[role="option"]';

export function dragRegionCss(): string {
  const enabled = `[${ATTR}]:not([${ATTR}="false"])`;
  return [
    `${enabled}{-webkit-app-region:drag;}`,
    `[${ATTR}=""]>*,[${ATTR}="true"]>*{-webkit-app-region:no-drag;}`,
    `[${ATTR}="deep"] :is(${CLICKABLE}):not([${ATTR}]){-webkit-app-region:no-drag;}`,
    `[${ATTR}="false"]{-webkit-app-region:no-drag;}`,
    `[${ATTR}] ${enabled}{-webkit-app-region:drag;}`,
  ].join('\n');
}
