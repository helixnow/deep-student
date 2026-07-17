/**
 * 外壳滚动保护：把「永远不该滚动」的壳层容器上出现的滚动立即复位。
 *
 * 背景：本应用是桌面壳布局，html/body/#root、app-shell、main-content、
 * page-container 等全部 overflow:hidden 且内容恰好一屏。但 overflow:hidden
 * 只隐藏滚动条，元素仍可被程序化滚动——以下场景都会把壳层滚出偏移：
 * - focus()/scrollIntoView()（编辑器聚焦光标、可访问性焦点管理）会滚动
 *   沿途所有可滚动祖先，包括 overflow:hidden 的
 * - 原生 HTML5 拖拽靠近窗口边缘时 WebView 的自动滚动
 * - 查找（Cmd+F）、IME 候选框定位等浏览器内建行为
 *
 * 壳层一旦滚出偏移就不会自愈：fixed 元素（顶栏/底栏）留在原地，其余内容
 * 整体上移，视觉上「整页滚走 / 渲染断成两半」。本 hook 在 document 捕获阶段
 * 监听 scroll，命中壳层容器时同步复位到 0。
 *
 * 正常业务滚动（overflow:auto/scroll 的列表、编辑器视口）不受影响。
 */

import { useEventRegistry } from './useEventRegistry';

/** 永不滚动的壳层容器选择器（page-container.scrollable 是刻意可滚动的，排除） */
const SHELL_GUARD_SELECTOR = [
  '[data-shell-role="app-shell"]',
  '#main-content',
  '.content-body',
  '.page-container:not(.scrollable)',
].join(', ');

function resetScroll(el: Element): void {
  if (el.scrollTop !== 0) el.scrollTop = 0;
  if (el.scrollLeft !== 0) el.scrollLeft = 0;
}

export function handleShellScrollEvent(event: Event): void {
  const target = event.target;

  // 文档根滚动：scroll 事件的 target 是 document
  if (target === document) {
    const rootEl = document.scrollingElement ?? document.documentElement;
    resetScroll(rootEl);
    resetScroll(document.documentElement);
    if (document.body) resetScroll(document.body);
    return;
  }

  if (target instanceof Element && target.matches(SHELL_GUARD_SELECTOR)) {
    resetScroll(target);
  }
}

export function useShellScrollGuard(): void {
  useEventRegistry(
    [
      {
        target: 'document',
        type: 'scroll',
        // 元素 scroll 不冒泡，但捕获阶段监听器能收到所有后代元素的 scroll
        listener: handleShellScrollEvent,
        options: { capture: true, passive: true },
      },
    ],
    [],
  );
}
