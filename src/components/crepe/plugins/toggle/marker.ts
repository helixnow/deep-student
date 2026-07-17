/**
 * Obsidian 风格折叠 callout 标记解析/序列化。
 *
 * 语法：
 *   > [!toggle]- 标题   → open: false（默认折叠）
 *   > [!toggle]+ 标题   → open: true
 *   > [!toggle] 标题    → open: true（无后缀默认展开）
 */

export const TOGGLE_TYPE = 'toggle' as const
export const TOGGLE_CALL_OUT = 'toggle' as const

export interface ToggleMarker {
  open: boolean
  title: string
}

/** 匹配行首 `[!toggle]` / `[!toggle]-` / `[!toggle]+` */
const TOGGLE_MARKER_RE = /^\[!toggle\]([+-]?)\s*(.*)$/i

export function parseToggleMarker(text: string): ToggleMarker | null {
  const trimmed = text.replace(/^\uFEFF/, '').trimStart()
  const match = TOGGLE_MARKER_RE.exec(trimmed)
  if (!match) return null
  const flag = match[1] ?? ''
  const title = (match[2] ?? '').trimEnd()
  // `-` → 折叠；`+` 或无后缀 → 展开
  const open = flag !== '-'
  return { open, title }
}

export function formatToggleMarker(title: string, open: boolean): string {
  const suffix = open ? '' : '-'
  const normalized = title.replace(/\s+/g, ' ').trim()
  return `[!toggle]${suffix}${normalized ? ` ${normalized}` : ''}`
}

export function isToggleMarkerText(text: string): boolean {
  return parseToggleMarker(text) != null
}
