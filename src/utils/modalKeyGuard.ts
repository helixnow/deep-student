/**
 * 键盘事件来自某个模态层（`aria-modal="true"`）内部时，背景视图挂在 window 上的单键快捷键应让行。
 *
 * 例：跨题目集的错题复习浮层盖在「做题」页上时，浮层里按 A / 1 / 回车，
 * 不能同时在背后的做题页里选项、提交。`ownRoot` 在该模态层内部时不让行（自己就在模态里）。
 */
export function isKeyEventFromOtherModal(event: Event, ownRoot?: Element | null): boolean {
  const target = event.target;
  if (!(target instanceof Element)) return false;
  const modal = target.closest('[aria-modal="true"]');
  if (!modal) return false;
  return !(ownRoot && modal.contains(ownRoot));
}
