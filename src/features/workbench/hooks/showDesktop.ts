/**
 * 显示桌面（stash 语义）— 快捷键 / 桌面双击 / 右键菜单共用
 *
 * 有可见窗 → 按 zIndex 暂存后全部最小化；再触发 → 只恢复暂存且仍最小化的窗口，
 * 并聚焦原栈顶。stash 仅会话内有效，不进快照/store。
 *
 * 再「显示桌面」且 stash 非空时：合并当前可见窗到既有 stash（追加未收录的 id，
 * 并剔除已关窗），避免整表覆盖导致先前仍最小化的窗永远回不来。
 */
import i18n from 'i18next';
import { useWindowStore } from '../core/windowStore';
import { requestMinimizeAnimated } from './useWindowLifecycleAnim';
import { announceWorkbench } from './useWorkbenchA11y';

/** show desktop 批量最小化的窗口 id（仅本次会话往返） */
let showDesktopStash: string[] = [];

/** 测试用：清空 stash */
export function resetShowDesktopStashForTests(): void {
  showDesktopStash = [];
}

/** 测试用：读取当前 stash（只读副本） */
export function getShowDesktopStashForTests(): readonly string[] {
  return showDesktopStash.slice();
}

/**
 * 把当前可见窗并入 stash：保留仍存在于 store 的旧项，再按 z 序追加尚未收录的可见 id。
 */
function mergeVisibleIntoStash(visibleIds: string[]): void {
  const windows = useWindowStore.getState().windows;
  const kept = showDesktopStash.filter((id) => Boolean(windows[id]));
  const merged = [...kept];
  for (const id of visibleIds) {
    if (!merged.includes(id)) merged.push(id);
  }
  showDesktopStash = merged;
}

/**
 * 显示桌面往返：有可见窗 → 全部最小化（动画编排）；
 * 否则 → 恢复上次批量最小化的窗口（非「恢复全部 minimized」）。
 * 正在 minimizing 的窗口视为已进入「显示桌面」，避免动画未完成时二次触发再压一层。
 */
export function toggleShowDesktop(): void {
  const store = useWindowStore.getState();
  const phases = store.transientPhases ?? {};
  const visible = Object.values(store.windows).filter(
    (w) => !w.minimized && phases[w.id] !== 'minimizing',
  );
  if (visible.length > 0) {
    const visibleIds = visible
      .sort((a, b) => a.zIndex - b.zIndex)
      .map((w) => w.id);
    if (showDesktopStash.length === 0) {
      showDesktopStash = visibleIds;
    } else {
      mergeVisibleIntoStash(visibleIds);
    }
    for (const win of visible) requestMinimizeAnimated(win.id);
    announceWorkbench(
      i18n.t('workbench:a11y.showDesktop', {
        defaultValue: '已显示桌面',
      }),
    );
    return;
  }
  // 只恢复仍处于最小化 / 正在最小化的暂存窗口（期间被关闭/手动恢复的跳过）
  const restorable = showDesktopStash.filter((id) => {
    const win = useWindowStore.getState().windows[id];
    if (!win) return false;
    const phase = useWindowStore.getState().transientPhases?.[id];
    return Boolean(win.minimized || phase === 'minimizing');
  });
  showDesktopStash = [];
  for (const id of restorable) {
    const fresh = useWindowStore.getState();
    // 动画未完成时先强制提交最小化，再反最小化
    if (fresh.transientPhases?.[id] === 'minimizing') {
      fresh.minimizeWindow(id, true);
    }
    useWindowStore.getState().minimizeWindow(id, false);
  }
  // 反最小化不抢焦点（store 语义）；恢复后把原栈顶重新聚焦
  const top = restorable[restorable.length - 1];
  if (top && useWindowStore.getState().windows[top]) {
    useWindowStore.getState().focusWindow(top);
  }
}
