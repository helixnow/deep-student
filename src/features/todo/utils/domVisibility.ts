/**
 * 保活层可见性 / workbench 窗口聚焦守卫（共享 util）
 *
 * 背景：todo / 模板管理等视图在 ViewLayerRenderer 的隐藏保活层里保持挂载
 * （visibility:hidden），滞留的浮层、勾选模式、日历等仍在消费全局事件
 * （Android 返回键、window 级快捷键）。此前同一段三行守卫在 9+ 处手工复制
 * （评审见 docs/0824-quality-review/todo-templates.md「变乱的地方」），
 * 且与 todoShellNav 的 isElementVisible 存在两套判定标准。本模块把两套
 * 判定合并为一个超集实现，作为唯一出口逐步收敛各复制点。
 */

/**
 * 元素当前是否「实际可见」：
 * - 已连接到 document（卸载中的 ref 残留不算）；
 * - 有布局盒（display:none 的祖先链使 getClientRects 为空）；
 * - computed visibility 不为 hidden（★ visibility:hidden 不清除布局盒，
 *   getClientRects 仍有返回值，必须单独查——这正是保活离场层的形态）。
 *
 * getComputedStyle 的 display 检查与 getClientRects 判定重叠，仍保留
 * 以对齐 todoShellNav 旧 isElementVisible 的语义（合并前的严格并集）。
 */
export function isEffectivelyVisible(el: HTMLElement | null | undefined): boolean {
  if (!el || !el.isConnected) return false;
  if (el.getClientRects().length === 0) return false;
  if (typeof window.getComputedStyle === 'function') {
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return false;
  }
  return true;
}

/**
 * workbench 窗口承载时的聚焦门禁：元素在 data-wb-window 壳内则要求该窗
 * 持有 data-focused（WindowShell 仅给焦点窗写该属性）；legacy 承载
 * （无窗壳祖先）不受影响，恒为 true。
 */
export function isHostWindowFocused(el: HTMLElement): boolean {
  const windowShell = el.closest<HTMLElement>('[data-wb-window]');
  return !windowShell || windowShell.hasAttribute('data-focused');
}
