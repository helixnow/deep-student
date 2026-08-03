/**
 * 文件树折叠的行退场动画（WAAPI）。
 *
 * 模式源自 src/features/mindmap/views/outline/collapseMotion.ts（大纲折叠的
 * 高度收拢 + 淡出方案）；因 eslint boundaries 禁止 feature→feature import，
 * 在 workbench notes tree 下独立实现——两者同为扁平列表渲染，子树行是兄弟
 * DOM 节点而非嵌套容器，无法用单一容器的 height 过渡，故在提交折叠之前对
 * 即将消失的行统一播一段高度收拢 + 淡出，动画结束后再执行 commit（提交后
 * React 移除这些行）。
 *
 * - prefers-reduced-motion / WAAPI 缺失 / 行数过多（> MAX_ANIMATED_ROWS）时
 *   直接瞬时提交，不做动画；
 * - commit 后取消所有 fill:forwards 动画并恢复内联样式，防止未被移除的行
 *   （极端竞态下）残留在高度 0 的状态。
 */

import type { FlattenedTreeRow } from './types';

const MAX_ANIMATED_ROWS = 40;
const COLLAPSE_DURATION_MS = 150;
const COLLAPSE_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)';

function escapeRowId(id: string): string {
  return typeof globalThis.CSS?.escape === 'function'
    ? globalThis.CSS.escape(id)
    : id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * 折叠 folderId 时将要消失的可见后代行 id。
 * 利用扁平行序：folder 行之后 depth 更深的连续行即其可见子树。
 */
export function collectVisibleSubtreeRowIds(
  rows: readonly FlattenedTreeRow[],
  folderId: string,
): string[] {
  const index = rows.findIndex((row) => row.id === folderId);
  if (index < 0) return [];
  const baseDepth = rows[index].depth;
  const ids: string[] = [];
  for (let i = index + 1; i < rows.length; i += 1) {
    if (rows[i].depth <= baseDepth) break;
    ids.push(rows[i].id);
  }
  return ids;
}

/**
 * 对 ids 对应的树行播高度收拢退场动画，结束后执行 commit。
 * @param container 行所在容器（树根元素，行通过 [data-nwt-id] 定位）
 */
export function animateTreeRowsExit(
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
      container.querySelector<HTMLElement>(`[data-nwt-id="${escapeRowId(id)}"]`),
    )
    .filter((el): el is HTMLElement => !!el);
  // jsdom 无 Element.animate：测试环境自动走瞬时提交
  if (rows.length === 0 || typeof rows[0].animate !== 'function') {
    commit();
    return;
  }

  const animations = rows.map((el) => {
    const height = el.offsetHeight;
    const previousOverflow = el.style.overflow;
    // .nwt-row 有 min-height:30px，会钳住 height 关键帧，动画期间临时归零
    const previousMinHeight = el.style.minHeight;
    el.style.overflow = 'hidden';
    el.style.minHeight = '0';
    const animation = el.animate(
      [
        { height: `${height}px`, opacity: 1 },
        { height: '0px', opacity: 0 },
      ],
      { duration: COLLAPSE_DURATION_MS, easing: COLLAPSE_EASING, fill: 'forwards' },
    );
    return { animation, el, previousOverflow, previousMinHeight };
  });

  let committed = false;
  const finish = () => {
    if (committed) return;
    committed = true;
    commit();
    // commit 后清理 fill:forwards：被移除的行已不在 DOM，无副作用；
    // 未被移除的行（预测未命中等极端情况）恢复正常布局。
    requestAnimationFrame(() => {
      for (const { animation, el, previousOverflow, previousMinHeight } of animations) {
        try {
          animation.cancel();
        } catch {
          // ignore
        }
        el.style.overflow = previousOverflow;
        el.style.minHeight = previousMinHeight;
      }
    });
  };

  void Promise.allSettled(animations.map(({ animation }) => animation.finished)).then(
    finish,
  );
  // WAAPI finished 在个别环境可能既不 resolve 也不 reject（如被暂停），兜底定时提交
  window.setTimeout(finish, COLLAPSE_DURATION_MS + 80);
}
