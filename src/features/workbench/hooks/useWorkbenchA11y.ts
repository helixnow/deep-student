/**
 * useWorkbenchA11y（O19）— 无障碍横切基建
 * ---------------------------------------------------------------------------
 * 规范文档：docs/dev/workbench-a11y-checklist.md（各组件代理 / O20 落实）。
 * 本文件只提供 hook / 工具，不改任何他人组件。
 *
 * 能力：
 *   1. getWindowA11yProps — 窗口壳 role/aria 属性规范的唯一生成器
 *      （role="dialog" 非模态 + aria-label + roledescription + 最小化隐藏）。
 *   2. announceWorkbench / useWorkbenchAnnouncer — 屏幕阅读器公告
 *      （aria-live 双缓冲区，同文案连续公告也能重新播报；单例直写 DOM）。
 *   3. useRovingFocus — 通用 roving tabindex（Dock 已自带；供 TileMenu 九宫格、
 *      Expose 网格、Dock 弹层等复合部件复用）。
 *   4. useFocusReturn — 瞬态浮层（切换器/俯瞰/菜单）关闭后焦点归还。
 *   5. useHighContrast / usePrefersReducedMotion — 系统偏好订阅
 *      （forced-colors / prefers-contrast / prefers-reduced-motion）。
 *
 * 焦点环视觉统一：styles/a11y-cursor.css 的 `wb-focus-ring` 类
 * （:focus-visible 驱动，token --wb-focus-ring-*，高对比模式自动增强）。
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { resolveGestureTarget, type WorkbenchGestureTarget } from './useWorkbenchGestures';

// ============================================================================
// 1. 窗口 role/aria 规范
// ============================================================================

export interface WindowA11yInput {
  /** 窗口标题（win.title；空标题时退回 appName） */
  title: string;
  /** 应用显示名（t(def.nameKey)），拼入 aria-label 消歧多窗 */
  appName?: string;
  focused?: boolean;
  minimized?: boolean;
  /**
   * 角色描述（i18n：workbench:a11y.windowRole，建议文案「窗口」/"window"）。
   * 屏幕阅读器将播报「<标题>, 窗口」而非「对话框」。
   */
  roleDescription?: string;
}

export interface WindowA11yProps {
  role: 'dialog';
  'aria-label': string;
  'aria-roledescription'?: string;
  /** 最小化的窗口对辅助技术整体隐藏 */
  'aria-hidden'?: true;
  /** 可编程聚焦（窗口切换器 / 点击聚焦时把 DOM 焦点带进窗口） */
  tabIndex: -1;
  'data-wb-a11y-window': true;
}

/**
 * 窗口壳（WindowShell 根元素）aria 属性生成器。
 * 非模态 dialog：不设 aria-modal，桌面上多窗并存、焦点自由移动。
 */
export function getWindowA11yProps(input: WindowA11yInput): WindowA11yProps {
  const label =
    input.title && input.appName && input.title !== input.appName
      ? `${input.title} — ${input.appName}`
      : input.title || input.appName || '';
  const props: WindowA11yProps = {
    role: 'dialog',
    'aria-label': label,
    tabIndex: -1,
    'data-wb-a11y-window': true,
  };
  if (input.roleDescription) props['aria-roledescription'] = input.roleDescription;
  if (input.minimized) props['aria-hidden'] = true;
  return props;
}

// ============================================================================
// 2. 屏幕阅读器公告（aria-live 双缓冲单例）
// ============================================================================

export type AnnouncePoliteness = 'polite' | 'assertive';

const ANNOUNCER_ID = 'wb-a11y-announcer';

interface AnnouncerRegion {
  buffers: [HTMLElement, HTMLElement];
  activeIndex: number;
}

let announcerRoot: HTMLElement | null = null;
const announcerRegions = new Map<AnnouncePoliteness, AnnouncerRegion>();
let announcerRefCount = 0;

function ensureAnnouncer(): void {
  if (typeof document === 'undefined') return;
  if (announcerRoot && document.body.contains(announcerRoot)) return;

  const root = document.createElement('div');
  root.id = ANNOUNCER_ID;
  root.setAttribute('data-wb-a11y-announcer', '');
  // 视觉隐藏但对 AT 可达（与 a11y-cursor.css 的 .wb-focus-sr-only 同规则，
  // 这里内联以保证 CSS 未接线时公告仍然可用）
  Object.assign(root.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: '0',
    border: '0',
    clip: 'rect(0 0 0 0)',
    clipPath: 'inset(50%)',
    overflow: 'hidden',
    whiteSpace: 'nowrap',
  } satisfies Partial<CSSStyleDeclaration>);

  announcerRegions.clear();
  for (const politeness of ['polite', 'assertive'] as const) {
    const buffers = [document.createElement('div'), document.createElement('div')] as [
      HTMLElement,
      HTMLElement,
    ];
    for (const buffer of buffers) {
      buffer.setAttribute('aria-live', politeness);
      buffer.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status');
      buffer.setAttribute('aria-atomic', 'true');
      root.appendChild(buffer);
    }
    announcerRegions.set(politeness, { buffers, activeIndex: 0 });
  }
  document.body.appendChild(root);
  announcerRoot = root;
}

/**
 * 向屏幕阅读器播报一条消息（窗口平铺落位、最小化、Dock 启动等状态变化）。
 * 双缓冲交替写入：同一文案连续两次也会被 AT 视作变更重新播报。
 * 可在非 React 上下文（store / 引擎）直接调用。
 */
export function announceWorkbench(
  message: string,
  politeness: AnnouncePoliteness = 'polite',
): void {
  if (!message || typeof document === 'undefined') return;
  ensureAnnouncer();
  const region = announcerRegions.get(politeness);
  if (!region) return;
  const next = (region.activeIndex + 1) % 2;
  region.buffers[region.activeIndex].textContent = '';
  region.buffers[next].textContent = message;
  region.activeIndex = next;
}

/** 仅供单元测试：移除公告单例 */
export function disposeWorkbenchAnnouncerForTests(): void {
  announcerRoot?.remove();
  announcerRoot = null;
  announcerRegions.clear();
  announcerRefCount = 0;
}

export interface WorkbenchAnnouncer {
  announce: (message: string, politeness?: AnnouncePoliteness) => void;
}

/**
 * React 组件内使用的公告 hook（引用计数：最后一个消费者卸载时移除 live region）。
 * 返回的 announce 引用终身稳定。
 */
export function useWorkbenchAnnouncer(): WorkbenchAnnouncer {
  useEffect(() => {
    ensureAnnouncer();
    announcerRefCount += 1;
    return () => {
      announcerRefCount -= 1;
      if (announcerRefCount <= 0) {
        announcerRefCount = 0;
        announcerRoot?.remove();
        announcerRoot = null;
        announcerRegions.clear();
      }
    };
  }, []);

  const stable = useRef<WorkbenchAnnouncer>({ announce: announceWorkbench });
  return stable.current;
}

// ============================================================================
// 3. 通用 roving tabindex
// ============================================================================

export interface UseRovingFocusOptions {
  container: WorkbenchGestureTarget;
  /** 参与巡航的子项选择器，默认 '[data-wb-roving]' */
  itemSelector?: string;
  /** 方向键轴向：horizontal=←/→，vertical=↑/↓，both=全部，默认 'both' */
  orientation?: 'horizontal' | 'vertical' | 'both';
  /** 到边界后回卷，默认 true */
  wrap?: boolean;
  disabled?: boolean;
}

const DEFAULT_ROVING_SELECTOR = '[data-wb-roving]';

function collectRovingItems(container: HTMLElement, selector: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(selector)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-disabled') !== 'true',
  );
}

/**
 * roving tabindex：容器内仅一个子项 tabIndex=0（Tab 进入组），
 * 方向键 / Home / End 在组内巡航（直写 tabIndex，不进 state）。
 * 子项打 `data-wb-roving` 标记（或传自定义 selector）。
 */
export function useRovingFocus(options: UseRovingFocusOptions): void {
  const optionsRef = useRef(options);
  optionsRef.current = options;

  useEffect(() => {
    const container = resolveGestureTarget(optionsRef.current.container);
    if (!container || optionsRef.current.disabled) return undefined;

    const selector = optionsRef.current.itemSelector ?? DEFAULT_ROVING_SELECTOR;

    const syncTabIndices = (activeEl: HTMLElement | null) => {
      const items = collectRovingItems(container, selector);
      if (items.length === 0) return;
      const active = activeEl && items.includes(activeEl) ? activeEl : items[0];
      for (const item of items) {
        item.tabIndex = item === active ? 0 : -1;
      }
    };

    // 初始：第一项可 Tab 达，其余 -1
    syncTabIndices(null);

    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && target.matches(selector)) syncTabIndices(target);
    };

    const onKeyDown = (event: KeyboardEvent) => {
      const opts = optionsRef.current;
      const orientation = opts.orientation ?? 'both';
      const horizontal = orientation !== 'vertical';
      const vertical = orientation !== 'horizontal';

      let step = 0;
      if (event.key === 'ArrowRight' && horizontal) step = 1;
      else if (event.key === 'ArrowLeft' && horizontal) step = -1;
      else if (event.key === 'ArrowDown' && vertical) step = 1;
      else if (event.key === 'ArrowUp' && vertical) step = -1;
      else if (event.key !== 'Home' && event.key !== 'End') return;

      const items = collectRovingItems(container, selector);
      if (items.length === 0) return;
      const current = document.activeElement as HTMLElement | null;
      const currentIndex = current ? items.indexOf(current) : -1;
      if (currentIndex === -1 && event.key !== 'Home' && event.key !== 'End') return;

      event.preventDefault();
      event.stopPropagation();

      let nextIndex: number;
      if (event.key === 'Home') nextIndex = 0;
      else if (event.key === 'End') nextIndex = items.length - 1;
      else if (opts.wrap === false) {
        nextIndex = Math.min(Math.max(currentIndex + step, 0), items.length - 1);
      } else {
        nextIndex = (currentIndex + step + items.length) % items.length;
      }

      const next = items[nextIndex];
      syncTabIndices(next);
      next.focus();
    };

    container.addEventListener('focusin', onFocusIn);
    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('focusin', onFocusIn);
      container.removeEventListener('keydown', onKeyDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options.disabled, options.container]);
}

// ============================================================================
// 4. 焦点归还（瞬态浮层）
// ============================================================================

export interface UseFocusReturnControls {
  /**
   * 跳过下一次关闭 / 卸载时的焦点归还。
   * 选中开窗等路径自行把焦点落到目标窗壳时调用，避免与归还竞态。
   * Esc / backdrop 等未调用本方法的关闭路径仍会正常归还。
   */
  skipNextReturn: () => void;
}

/**
 * active 变 true 时记录当前焦点元素；变 false / 卸载时归还焦点
 * （元素已不在文档中则放弃）。切换器 / 俯瞰 / 右键菜单等浮层消费。
 * 返回值可忽略（AppsPanel / Cheatsheet 等现有用法不变）。
 */
export function useFocusReturn(active: boolean): UseFocusReturnControls {
  const previousRef = useRef<HTMLElement | null>(null);
  const wasActiveRef = useRef(false);
  const skipNextRef = useRef(false);

  const skipNextReturn = useCallback(() => {
    skipNextRef.current = true;
  }, []);

  useEffect(() => {
    if (active && !wasActiveRef.current) {
      wasActiveRef.current = true;
      skipNextRef.current = false;
      previousRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
    } else if (!active && wasActiveRef.current) {
      wasActiveRef.current = false;
      const prev = previousRef.current;
      previousRef.current = null;
      const skip = skipNextRef.current;
      skipNextRef.current = false;
      if (!skip && prev && document.contains(prev)) prev.focus();
    }
  }, [active]);

  useEffect(() => {
    return () => {
      if (!wasActiveRef.current) return;
      const prev = previousRef.current;
      const skip = skipNextRef.current;
      skipNextRef.current = false;
      if (!skip && prev && document.contains(prev)) prev.focus();
    };
  }, []);

  return { skipNextReturn };
}

// ============================================================================
// 5. 系统偏好订阅（高对比 / 减动效）
// ============================================================================

function subscribeMediaQuery(query: string, callback: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return () => {};
  }
  const mql = window.matchMedia(query);
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', callback);
    return () => mql.removeEventListener('change', callback);
  }
  if (typeof mql.addListener === 'function') {
    // 旧 WebKit 兼容
    mql.addListener(callback);
    return () => mql.removeListener(callback);
  }
  return () => {};
}

function matchesMediaQuery(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(query).matches;
}

const FORCED_COLORS_QUERY = '(forced-colors: active)';
const PREFERS_CONTRAST_QUERY = '(prefers-contrast: more)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * 高对比模式（Windows 高对比主题 forced-colors，或系统「增强对比度」偏好）。
 * a11y-cursor.css 已对 forced-colors 做焦点环 / 拖放高亮的自动适配；
 * 组件可用本 hook 做进一步逻辑降级（如禁用玻璃质感依赖的语义色）。
 */
export function useHighContrast(): boolean {
  return useSyncExternalStore(
    (callback) => {
      const a = subscribeMediaQuery(FORCED_COLORS_QUERY, callback);
      const b = subscribeMediaQuery(PREFERS_CONTRAST_QUERY, callback);
      return () => {
        a();
        b();
      };
    },
    () => matchesMediaQuery(FORCED_COLORS_QUERY) || matchesMediaQuery(PREFERS_CONTRAST_QUERY),
    () => false,
  );
}

/** 系统减动效偏好（与 materialTier 的 minimal 档联动之外的细粒度判断） */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (callback) => subscribeMediaQuery(REDUCED_MOTION_QUERY, callback),
    () => matchesMediaQuery(REDUCED_MOTION_QUERY),
    () => false,
  );
}
