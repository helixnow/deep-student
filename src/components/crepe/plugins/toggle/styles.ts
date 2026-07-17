/**
 * Toggle 块样式（注入一次）。不能改 CrepeEditor.css，故自管 stylesheet。
 */

const STYLE_ID = 'milkdown-toggle-styles'

export const TOGGLE_STYLE = `
.milkdown-toggle {
  margin: 0.5em 0;
  border-radius: var(--notes-radius-popup, 0.5rem);
}
.milkdown-toggle__header {
  display: flex;
  align-items: flex-start;
  gap: 0.35em;
  padding: 0.15em 0;
  user-select: none;
}
.milkdown-toggle__arrow {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.25em;
  height: 1.5em;
  margin: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: hsl(var(--muted-foreground, 215 16% 47%));
  cursor: pointer;
  line-height: 1;
  transform: rotate(0deg);
  /* 与文件树 .nwt-caret 一致：150ms ease */
  transition: transform 150ms ease;
}
.milkdown-toggle[data-open="true"] .milkdown-toggle__arrow {
  transform: rotate(90deg);
}
.milkdown-toggle__title {
  flex: 1 1 auto;
  min-width: 0;
  outline: none;
  font-weight: 600;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.milkdown-toggle__title:empty::before {
  content: attr(data-placeholder);
  color: hsl(var(--muted-foreground, 215 16% 47%));
  font-weight: 500;
  pointer-events: none;
}
.milkdown-toggle__body {
  display: grid;
  grid-template-rows: 0fr;
  opacity: 0;
  /* 内容展开：grid 行高 + opacity 200ms（等效 max-height 折叠节奏） */
  transition: grid-template-rows 200ms ease, opacity 200ms ease;
}
.milkdown-toggle[data-open="true"] .milkdown-toggle__body {
  grid-template-rows: 1fr;
  opacity: 1;
}
.milkdown-toggle__body-inner {
  overflow: hidden;
  min-height: 0;
}
.milkdown-toggle[data-open="false"] .milkdown-toggle__body-inner {
  pointer-events: none;
}
@media (prefers-reduced-motion: reduce) {
  .milkdown-toggle__arrow,
  .milkdown-toggle__body {
    transition: none;
  }
}
`.trim()

export function ensureToggleStyles(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const style = document.createElement('style')
  style.id = STYLE_ID
  style.textContent = TOGGLE_STYLE
  document.head.appendChild(style)
}
