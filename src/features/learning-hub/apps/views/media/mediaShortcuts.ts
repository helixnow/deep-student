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

/** 快进/快退步长（秒） */
export const SKIP_SECONDS = 10;
