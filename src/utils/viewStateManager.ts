/**
 * 视图状态管理器
 * 用于保存和恢复列表页的滚动位置、筛选条件等
 */

import type { CurrentView } from '../types/navigation';

interface ViewState {
  /** 滚动位置 */
  scrollTop?: number;
  scrollLeft?: number;
  /** 筛选条件 */
  filters?: Record<string, any>;
  /** 其他自定义状态 */
  [key: string]: any;
}

const viewStates = new Map<CurrentView, ViewState>();

/**
 * 保存视图状态
 */
export function saveViewState(view: CurrentView, state: ViewState): void {
  viewStates.set(view, { ...state });
  console.log('[ViewState] 保存:', { view, state });
}

/**
 * 恢复视图状态
 */
export function restoreViewState(view: CurrentView): ViewState | null {
  const state = viewStates.get(view);
  if (state) {
    console.log('[ViewState] 恢复:', { view, state });
  }
  return state || null;
}

/**
 * 清除视图状态
 */
export function clearViewState(view: CurrentView): void {
  viewStates.delete(view);
  console.log('[ViewState] 清除:', { view });
}

/**
 * 清除所有状态
 */
export function clearAllViewStates(): void {
  viewStates.clear();
  console.log('[ViewState] 清除所有状态');
}

/**
 * 查找当前可见的页面容器
 */
function findVisiblePageContainer(): HTMLElement | null {
  // 查找所有 page-container
  const containers = document.querySelectorAll('.page-container');
  for (const el of Array.from(containers)) {
    const computed = window.getComputedStyle(el);
    // 检查是否可见（z-index > 0 且 opacity > 0）
    const zIndex = parseInt(computed.zIndex, 10);
    const opacity = parseFloat(computed.opacity);
    if (zIndex > 0 && opacity > 0) {
      return el as HTMLElement;
    }
  }
  return null;
}

/**
 * 自动保存滚动位置
 * @param view 视图
 * @param container 容器元素（可选，默认查找可见容器）
 */
export function autoSaveScrollPosition(
  view: CurrentView,
  container?: HTMLElement | null
): () => void {
  const element = container || findVisiblePageContainer();
  
  if (!element) {
    console.warn('[ViewState] 未找到容器元素:', view);
    return () => {};
  }

  const saveScroll = () => {
    const scrollTop = element.scrollTop;
    const scrollLeft = element.scrollLeft;
    
    if (scrollTop > 0 || scrollLeft > 0) {
      const existing = viewStates.get(view) || {};
      saveViewState(view, {
        ...existing,
        scrollTop,
        scrollLeft,
      });
    }
  };

  // 防抖保存
  let timer: number | null = null;
  const debouncedSave = () => {
    if (timer) clearTimeout(timer);
    timer = window.setTimeout(saveScroll, 300);
  };

  element.addEventListener('scroll', debouncedSave, { passive: true });

  return () => {
    if (timer) clearTimeout(timer);
    element.removeEventListener('scroll', debouncedSave as any);
  };
}

/**
 * 自动恢复滚动位置
 * @param view 视图
 * @param container 容器元素（可选）
 */
export function autoRestoreScrollPosition(
  view: CurrentView,
  container?: HTMLElement | null
): void {
  const state = restoreViewState(view);
  if (!state || (!state.scrollTop && !state.scrollLeft)) return;

  const tryRestore = () => {
    const element = container || findVisiblePageContainer();
    if (!element) {
      console.warn('[ViewState] 未找到容器元素，无法恢复滚动:', view);
      return false;
    }

    // 检查元素是否已完成渲染（有实际内容高度）
    if (element.scrollHeight <= element.clientHeight && state.scrollTop && state.scrollTop > 0) {
      // 内容还没渲染完，无法滚动
      return false;
    }

    if (state.scrollTop) element.scrollTop = state.scrollTop;
    if (state.scrollLeft) element.scrollLeft = state.scrollLeft;
    console.log('[ViewState] 滚动位置已恢复:', { view, scrollTop: state.scrollTop, scrollLeft: state.scrollLeft });
    return true;
  };

  // 多次尝试恢复，等待 DOM 完全渲染
  let attempts = 0;
  const maxAttempts = 5;
  
  const attemptRestore = () => {
    attempts++;
    if (tryRestore()) {
      return; // 恢复成功
    }
    
    if (attempts < maxAttempts) {
      requestAnimationFrame(attemptRestore);
    } else {
      console.warn('[ViewState] 滚动恢复超时，可能内容尚未加载完成:', view);
    }
  };
  
  requestAnimationFrame(attemptRestore);
}

