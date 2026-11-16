/**
 * 事件来源所在的学习桌面窗口 id（WindowShell 根节点带 data-window-id）。
 * 引用跳转（pdf-ref:open / media-ref:open）把它带给 WorkbenchEventBridge，
 * 资源窗才能开在来源窗旁边而不是盖住它（UX 审计 L1）。经典壳 / 不在窗口内 → undefined。
 */
export function resolveSourceWindowId(target: EventTarget | null | undefined): string | undefined {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return undefined;
  const id = target.closest('[data-window-id]')?.getAttribute('data-window-id');
  return id || undefined;
}
