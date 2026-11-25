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
:where(img:not([data-anki-media-pending="1"])) { cursor: zoom-in; }
img[data-anki-media-pending="1"] { opacity: 0.35; cursor: default; }
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
.anki-sound-player {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  max-width: 100%;
  margin: 6px auto;
  vertical-align: middle;
}
.anki-sound-player > audio.anki-audio {
  margin: 0;
  flex: 1 1 auto;
  min-width: 180px;
}
.anki-sound,
.anki-sound-play,
.anki-sound-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35em;
  min-height: 32px;
  padding: 0.25em 0.7em;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: rgba(128, 128, 128, 0.14);
  color: inherit;
  font: inherit;
  font-size: 0.85em;
  line-height: 1.3;
  cursor: pointer;
  vertical-align: baseline;
  flex-shrink: 0;
}
.anki-sound-play {
  min-width: 34px;
  padding: 0.25em 0.55em;
}
.anki-sound-play:hover,
.anki-sound-btn:hover:not(:disabled) {
  background: rgba(128, 128, 128, 0.26);
}
.anki-sound-btn:disabled {
  opacity: 0.72;
  cursor: progress;
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
 * 暗色模式兼容样式：
 * 1. 零特异性兜底，为“未声明任何颜色”的自定义模板提供可读的默认前景色与高对比 Cloze 遮罩；
 * 2. 针对旧库中已持久化的内置模板（design-glass / design-redaction / design-exam / design-lab 等）
 *    在 `.nightMode` 下硬编码白底与低对比 `#e9e9e7` 透明挖空的遗留规则做定向暗色覆盖，
 *    确保无论新库还是既有种子库在暗色模式下都不会出现刺眼白卡面或不可见挖空。
 */
export const CARD_FACE_DARK_CSS = `
:where(html) { color-scheme: dark; }
:where(body) { color: #e5e7eb; }
:where(a) { color: #93c5fd; }
:where(hr) { border-color: rgba(255, 255, 255, 0.18); }
.anki-hint > .anki-hint-summary { color: #93c5fd; }
:where(body.nightMode .cloze, body.night_mode .cloze) {
  background: #1e3a5f;
  color: #bfdbfe;
  border: 1px solid #3b82f6;
  border-radius: 4px;
  padding: 1px 6px;
  font-weight: 600;
}
body.card.nightMode:has(.glass-panel, .lab-card, .redact-card, .exam-paper, .mono-page, .fn-page, .mg-sheet, .sem-sheet, .nom-sheet),
body.card.night_mode:has(.glass-panel, .lab-card, .redact-card, .exam-paper, .mono-page, .fn-page, .mg-sheet, .sem-sheet, .nom-sheet) {
  background: #14161a !important;
  color: #f3f4f6 !important;
}
body.card.nightMode .glass-panel,
body.card.night_mode .glass-panel,
body.card.nightMode .lab-card,
body.card.night_mode .lab-card {
  background: #1e222a !important;
  color: #f3f4f6 !important;
  border-color: #333a47 !important;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45) !important;
}
body.card.nightMode .glass-sub,
body.card.night_mode .glass-sub,
body.card.nightMode .lab-tag,
body.card.night_mode .lab-tag {
  color: #9ca3af !important;
}
body.card.nightMode .glass-text,
body.card.night_mode .glass-text,
body.card.nightMode .lab-q,
body.card.night_mode .lab-q {
  color: #f3f4f6 !important;
  border-bottom-color: #333a47 !important;
}
body.card.nightMode .glass-extra,
body.card.night_mode .glass-extra {
  color: #9ca3af !important;
  border-top-color: #333a47 !important;
}
body.card.nightMode .glass-panel .cloze,
body.card.night_mode .glass-panel .cloze,
body.card.nightMode .glass-panel .cloze b,
body.card.night_mode .glass-panel .cloze b {
  background: #1e3a5f !important;
  color: #bfdbfe !important;
  border: 1px solid #3b82f6 !important;
  font-weight: 600 !important;
}
body.card.nightMode .glass-panel.revealed .cloze,
body.card.night_mode .glass-panel.revealed .cloze,
body.card.nightMode .glass-panel.revealed .cloze b,
body.card.night_mode .glass-panel.revealed .cloze b {
  background: #14532d !important;
  color: #86efac !important;
  border-color: #22c55e !important;
  font-weight: 600 !important;
}
body.card.nightMode .redact-card,
body.card.night_mode .redact-card {
  background: #1b1f27 !important;
  color: #f3f4f6 !important;
  border-color: #374151 !important;
}
body.card.nightMode .redact-header,
body.card.night_mode .redact-header {
  color: #9ca3af !important;
}
body.card.nightMode .redact-text,
body.card.night_mode .redact-text {
  color: #f3f4f6 !important;
}
body.card.nightMode .redact-card .cloze,
body.card.night_mode .redact-card .cloze,
body.card.nightMode .redact-card .cloze b,
body.card.night_mode .redact-card .cloze b {
  background: #334155 !important;
  color: #f8fafc !important;
  border: 1px solid #64748b !important;
  font-weight: 600 !important;
}
body.card.nightMode .redact-card.revealed .cloze,
body.card.night_mode .redact-card.revealed .cloze,
body.card.nightMode .redact-card.revealed .cloze b,
body.card.night_mode .redact-card.revealed .cloze b {
  background: rgba(248, 113, 113, 0.14) !important;
  color: #fca5a5 !important;
  border-color: transparent !important;
  border-bottom: 2px solid #f87171 !important;
}
body.card.nightMode .exam-paper,
body.card.night_mode .exam-paper {
  background: #211f1c !important;
  color: #edeae2 !important;
  border: 1px solid #38332c !important;
  box-shadow: 0 8px 26px rgba(0, 0, 0, 0.45) !important;
}
body.card.nightMode .exam-head,
body.card.night_mode .exam-head {
  color: #b5aa97 !important;
}
body.card.nightMode .exam-rule,
body.card.night_mode .exam-rule {
  border-color: #6b6356 !important;
}
body.card.nightMode .exam-front .cloze,
body.card.night_mode .exam-front .cloze {
  color: #93c5fd !important;
  background: rgba(59, 130, 246, 0.16) !important;
  border-bottom: 1.5px solid #60a5fa !important;
  border-radius: 3px;
}
body.card.nightMode .exam-front .cloze-hint,
body.card.night_mode .exam-front .cloze-hint {
  color: #cbd5e1 !important;
}
body.card.nightMode .exam-back .cloze,
body.card.night_mode .exam-back .cloze,
body.card.nightMode .exam-back .cloze-revealed,
body.card.night_mode .exam-back .cloze-revealed {
  color: #fda4af !important;
  border-bottom-color: rgba(253, 164, 175, 0.65) !important;
}
body.card.nightMode .exam-remark-sep,
body.card.night_mode .exam-remark-sep {
  border-top-color: #575046 !important;
}
body.card.nightMode .exam-remark-body,
body.card.night_mode .exam-remark-body {
  color: #c7bfb1 !important;
}
body.card.nightMode .exam-remark-body .exam-remark-label,
body.card.night_mode .exam-remark-body .exam-remark-label {
  color: #fda4af !important;
}
body.card.nightMode .lab-opt,
body.card.night_mode .lab-opt {
  color: #e5e7eb !important;
  background: #262b36 !important;
  border-color: #3a4252 !important;
}
body.card.nightMode .lab-opt:hover:not(.answered),
body.card.night_mode .lab-opt:hover:not(.answered) {
  background: #303746 !important;
}
body.card.nightMode .lab-opt.correct,
body.card.night_mode .lab-opt.correct {
  background: #14532d !important;
  border-color: #22c55e !important;
  color: #bbf7d0 !important;
}
body.card.nightMode .lab-opt.wrong,
body.card.night_mode .lab-opt.wrong {
  background: #7f1d1d !important;
  border-color: #f87171 !important;
  color: #fecaca !important;
}
body.card.nightMode .explanation-box,
body.card.night_mode .explanation-box {
  background: #252a34 !important;
  color: #d1d5db !important;
}
body.card.nightMode .mono-page,
body.card.night_mode .mono-page,
body.card.nightMode .fn-page,
body.card.night_mode .fn-page,
body.card.nightMode .mg-sheet,
body.card.night_mode .mg-sheet,
body.card.nightMode .sem-sheet,
body.card.night_mode .sem-sheet,
body.card.nightMode .nom-sheet,
body.card.night_mode .nom-sheet {
  background: #211f1c !important;
  color: #edeae2 !important;
  border: 1px solid #38332c;
}
body.card.nightMode .mono-a,
body.card.night_mode .mono-a,
body.card.nightMode .fn-note,
body.card.night_mode .fn-note,
body.card.nightMode .mg-def,
body.card.night_mode .mg-def,
body.card.nightMode .sem-text,
body.card.night_mode .sem-text,
body.card.nightMode .nom-def-body,
body.card.night_mode .nom-def-body,
body.card.nightMode .nom-name,
body.card.night_mode .nom-name {
  color: #d6d0c4 !important;
}
`;

/**
 * 舞台模式（复习卡面）：body（即模板的 .card 背景）至少铺满 iframe 视口，内容纵向居中。
 *
 * 关键：body 必须保持块级布局，纵向居中只用 align-content（块容器对齐，
 * Chromium 123+ / Safari 17.4+ / Firefox 125+；更旧的内核退化为顶部对齐，无其他副作用）。
 * 曾用 `body { display:flex; flex-direction:column; justify-content:center }`——
 * 内置 design-* 模板全都用 `max-width:Npx; margin:0 auto` 的「纸张」容器，
 * 在 flex 列里横向 auto margin 会让子项不再拉伸、退化为 fit-content 宽度：
 * 卡片缩成正文最长一行的宽度（The Architect 约 320px、glass 仅 185px），
 * 再叠加 overflow 归一化（hidden→auto）后正文换行、溢出，卡片内出现纵横两条滚动条。
 * 块级布局下 auto margin 才是 Anki 的语义：宽度 = min(可用宽度, max-width) 并水平居中。
 *
 * `safe center`：内容高于视口（自适应高度测量前的过渡帧）时退为顶部对齐，
 * 不把内容顶端推出可滚动区；不支持 safe 关键字的内核沿用前一条 `center`。
 */
export const CARD_FACE_STAGE_CSS = `
html, body { min-height: 100vh; scrollbar-gutter: auto; }
body { box-sizing: border-box; margin: 0; align-content: center; align-content: safe center; }
`;

export interface BuildCardFaceCssOptions {
  darkMode?: boolean;
  /** 舞台模式：.card 背景铺满 iframe 视口、内容纵向居中（见 CARD_FACE_STAGE_CSS） */
  stage?: boolean;
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
  if (options.stage) {
    parts.push(CARD_FACE_STAGE_CSS);
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
