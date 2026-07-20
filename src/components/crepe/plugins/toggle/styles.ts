/**
 * Toggle 块样式（注入一次）。不能改 CrepeEditor.css，故自管 stylesheet。
 */

const STYLE_ID = 'milkdown-toggle-styles'

export const TOGGLE_STYLE = `
.milkdown-toggle {
  margin: 0.5em 0;
  border-radius: var(--notes-radius-control, 8px);
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
  border-radius: var(--notes-radius-control, 0.35rem);
  background: transparent;
  color: hsl(var(--muted-foreground, 215 16% 47%));
  cursor: pointer;
  line-height: 1;
  transform: rotate(0deg);
  transition:
    transform 150ms var(--dropdown-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    background-color var(--notes-hover-transition, 120ms ease);
}
.milkdown-toggle__arrow:hover {
  background: hsl(var(--foreground) / 0.06);
  color: hsl(var(--foreground));
}
.milkdown-toggle__arrow:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 1px;
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
  transition:
    grid-template-rows 200ms var(--dropdown-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    opacity 200ms var(--dropdown-ease, cubic-bezier(0.22, 1, 0.36, 1));
}
.milkdown-toggle[data-open="true"] .milkdown-toggle__body {
  grid-template-rows: 1fr;
  opacity: 1;
}
.milkdown-toggle__body-inner {
  position: relative;
  /* clip 而非 hidden：拖选跨块文本时 WebKit reveal-selection 会滚动 hidden 容器，
     造成折叠块内文字错位重影 */
  overflow: clip;
  min-height: 0;
}
.milkdown-toggle[data-open="false"] .milkdown-toggle__body-inner {
  pointer-events: none;
}
/* 空 toggle：展开且内容为单个空块时提示可输入 */
.milkdown-toggle[data-open="true"][data-empty="true"] .milkdown-toggle__body-inner::before {
  content: attr(data-empty-placeholder);
  position: absolute;
  inset: 0 auto auto 0;
  color: hsl(var(--muted-foreground, 215 16% 47%) / 0.75);
  pointer-events: none;
}
/* 聚焦空段落时编辑器自带 crepe-placeholder（"输入 /"）会出现在同一位置，
   此时让位给它，避免两条提示文字重叠 */
.milkdown-toggle[data-open="true"][data-empty="true"] .milkdown-toggle__body-inner:has(.crepe-placeholder)::before {
  content: none;
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
