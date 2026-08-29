/**
 * 媒体播放器键盘快捷键的公共判定逻辑
 */

/**
 * 判断快捷键事件目标是否为自带键盘语义的交互控件
 * （按钮的空格/回车、滑杆的方向键应交给控件本身处理，避免双触发）
 */
export function isInteractiveShortcutTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.getAttribute !== 'function') return false;
  const tag = el.tagName;
  return (
    tag === 'BUTTON' ||
    tag === 'INPUT' ||
    tag === 'SELECT' ||
    tag === 'TEXTAREA' ||
    el.getAttribute('role') === 'slider'
  );
}

/**
 * 判断事件是否带 Cmd/Ctrl/Alt 修饰键。
 * 媒体/图片查看器的单键快捷键（F/M/R/±/方向键等）必须放行组合键，
 * 否则 ⌘F（搜索）会触发全屏、⌘M（最小化）会静音、⌘R（刷新）会旋转图片。
 */
export function hasShortcutModifier(event: {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}): boolean {
  return event.metaKey || event.ctrlKey || event.altKey;
}

/** 快进/快退步长（秒） */
export const SKIP_SECONDS = 10;
