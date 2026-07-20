/**
 * 大纲折叠/隐藏的行退场动画（WAAPI）。
 *
 * 大纲是扁平列表渲染，子树行是兄弟 DOM 节点而非嵌套容器，无法用单一容器的
 * height 过渡；这里在提交 store 变更之前，对即将消失的行统一播一段
 * 高度收拢 + 淡出，动画结束后再执行 commit（store 提交后 React 移除这些行）。
 *
 * - prefers-reduced-motion / WAAPI 缺失 / 行数过多（> MAX_ANIMATED_ROWS）时
 *   直接瞬时提交，不做动画；
 * - commit 后取消所有 fill:forwards 动画，防止未被移除的行（如 hideCompleted
 *   判定未命中）残留在高度 0 的状态。
 */

import type { MindMapNode } from '../../types';

const MAX_ANIMATED_ROWS = 40;
const COLLAPSE_DURATION_MS = 150;
const COLLAPSE_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';

function escapeNodeId(id: string): string {
  return typeof globalThis.CSS?.escape === 'function'
    ? globalThis.CSS.escape(id)
    : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 收集节点当前可见（未被折叠遮挡）的后代 id，可选包含自身 */
export function collectVisibleSubtreeIds(
  node: MindMapNode,
  options?: { includeSelf?: boolean },
): string[] {
  const ids: string[] = [];
  if (options?.includeSelf) ids.push(node.id);
  const walk = (current: MindMapNode) => {
    if (current.collapsed) return;
    for (const child of current.children ?? []) {
      ids.push(child.id);
      walk(child);
    }
  };
  walk(node);
  return ids;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * 对 ids 对应的行播高度收拢退场动画，结束后执行 commit。
 * @param container 行所在容器（行组件可传 rowEl.parentElement）
 */
export function animateOutlineRowsExit(
  container: HTMLElement | null,
  ids: readonly string[],
  commit: () => void,
): void {
  if (
    !container ||
    ids.length === 0 ||
    ids.length > MAX_ANIMATED_ROWS ||
    prefersReducedMotion()
  ) {
    commit();
    return;
  }

  const rows = ids
    .map((id) =>
      container.querySelector<HTMLElement>(`[data-node-id="${escapeNodeId(id)}"]`),
    )
    .filter((el): el is HTMLElement => !!el);
  if (rows.length === 0 || typeof rows[0].animate !== 'function') {
    commit();
    return;
  }

  const animations = rows.map((el) => {
    const height = el.offsetHeight;
    const previousOverflow = el.style.overflow;
    el.style.overflow = 'hidden';
    const animation = el.animate(
      [
        { height: `${height}px`, opacity: 1 },
        { height: '0px', opacity: 0 },
      ],
      { duration: COLLAPSE_DURATION_MS, easing: COLLAPSE_EASING, fill: 'forwards' },
    );
    return { animation, el, previousOverflow };
  });

  let committed = false;
  const finish = () => {
    if (committed) return;
    committed = true;
    commit();
    // commit 后清理 fill:forwards：被移除的行已不在 DOM，无副作用；
    // 未被移除的行（预测隐藏未命中等）恢复正常布局。
    requestAnimationFrame(() => {
      for (const { animation, el, previousOverflow } of animations) {
        try {
          animation.cancel();
        } catch {
          // ignore
        }
        el.style.overflow = previousOverflow;
      }
    });
  };

  void Promise.allSettled(animations.map(({ animation }) => animation.finished)).then(
    finish,
  );
  // WAAPI finished 在个别环境可能既不 resolve 也不 reject（如被暂停），兜底定时提交
  window.setTimeout(finish, COLLAPSE_DURATION_MS + 80);
}

/**
 * 折叠某节点：先对其可见后代行播退场动画，再提交折叠。
 * rowEl 传该节点自己的行元素（用于定位共同容器）。
 */
export function animateOutlineCollapse(
  rowEl: HTMLElement | null,
  node: MindMapNode,
  commit: () => void,
): void {
  animateOutlineRowsExit(
    rowEl?.parentElement ?? null,
    collectVisibleSubtreeIds(node),
    commit,
  );
}
