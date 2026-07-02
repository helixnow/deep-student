/**
 * Android 软键盘检测基建（移动端键盘适配，对应社区 issue/PR #113 的三个键盘 bug）
 *
 * 背景：Android Activity 默认 adjustResize 行为下，键盘弹出会压缩整个 WebView：
 * - 居中定位的 Dialog 被压到极小（"被键盘压缩到 1/5 窗口"）；
 * - 键盘引发的 resize/focus/blur 连锁可能误触全局导航（"输入中被跳转"）。
 *
 * 本模块用 visualViewport 维护一个模块级键盘状态单例：
 * - React 组件用 useKeyboardHeight() / useIsKeyboardShown() 订阅；
 * - 普通事件处理器（如 App.tsx 的导航守卫）用 getKeyboardHeight() /
 *   shouldBlockMobileNavigation() 同步读取，无需 hook。
 *
 * 实现要点：
 * - 仅在 Android 启用（iOS 键盘为 overlay 行为，WKWebView 有独立适配，见 ios-safe-area.css）；
 * - 基线取"当前宽度下观测到的最大视口高度"，宽度变化（旋转/分屏）时重置基线，
 *   避免把旋转产生的高度差误判为键盘弹出；
 * - 高度差回落到阈值内时归零，键盘收起后状态不会卡在"弹出"。
 */
import { useSyncExternalStore } from 'react';
import { isAndroid } from '@/utils/platform';

/** 键盘判定阈值（px）：视口高度差超过该值视为键盘弹出 */
const KEYBOARD_THRESHOLD = 150;

type Listener = () => void;

let trackingStarted = false;
let keyboardHeight = 0;
let baselineHeight = 0;
let baselineWidth = 0;
const listeners = new Set<Listener>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

function handleViewportResize(): void {
  const vv = window.visualViewport;
  if (!vv) return;

  // 宽度变化 = 旋转/分屏/窗口尺寸调整，重置基线，不视为键盘
  if (vv.width !== baselineWidth) {
    baselineWidth = vv.width;
    baselineHeight = vv.height;
    if (keyboardHeight !== 0) {
      keyboardHeight = 0;
      emit();
    }
    return;
  }

  if (vv.height > baselineHeight) {
    baselineHeight = vv.height;
  }

  const diff = baselineHeight - vv.height;
  const next = diff > KEYBOARD_THRESHOLD ? Math.round(diff) : 0;
  if (next !== keyboardHeight) {
    keyboardHeight = next;
    emit();
  }
}

function ensureTracking(): void {
  if (trackingStarted || typeof window === 'undefined') return;
  trackingStarted = true;

  const vv = window.visualViewport;
  if (!vv || !isAndroid()) return;

  baselineWidth = vv.width;
  baselineHeight = vv.height;
  vv.addEventListener('resize', handleViewportResize);
}

function subscribe(listener: Listener): () => void {
  ensureTracking();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot(): number {
  return keyboardHeight;
}

function getServerSnapshot(): number {
  return 0;
}

/** 当前 Android 软键盘占用高度（px），键盘收起 / 非 Android 时为 0 */
export function useKeyboardHeight(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 键盘是否弹出的快捷 Hook */
export function useIsKeyboardShown(): boolean {
  return useKeyboardHeight() > 0;
}

/** 非 hook 版本：供普通事件处理器同步读取键盘高度 */
export function getKeyboardHeight(): number {
  ensureTracking();
  return keyboardHeight;
}

/**
 * 布局视口被键盘遮挡的高度（px）。
 *
 * adjustResize 生效时 WebView 布局视口随键盘缩小，返回 0（fixed inset-0 容器
 * 本身已避开键盘）；若未来 softInputMode 变为非 resize 模式（布局视口不变、
 * 仅 visualViewport 缩小），返回被遮挡的差值，供 Dialog 等 fixed 容器补偿
 * paddingBottom。两种模式下调用方无需区分。
 */
export function getLayoutViewportObscuredHeight(): number {
  if (typeof window === 'undefined') return 0;
  const vv = window.visualViewport;
  if (!vv) return 0;
  const layoutHeight = document.documentElement.clientHeight;
  return Math.max(0, Math.round(layoutHeight - vv.height));
}

/** 当前焦点是否在可编辑元素上（input/textarea/contenteditable） */
export function isEditableElementFocused(): boolean {
  if (typeof document === 'undefined') return false;
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

/**
 * 移动端全局导航守卫（App.tsx 侧边栏导航事件用）：
 * Android 键盘弹出/输入框聚焦期间，键盘引发的 WebView resize 会让焦点与点击
 * 落点错位，产生"正在输入却被跳转到其他页面"的误导航（#113 bug 1/3）。
 * 正常通过侧边栏导航时输入框必然已失焦，不会被误拦。
 */
export function shouldBlockMobileNavigation(): boolean {
  if (!isAndroid()) return false;
  return isEditableElementFocused() || getKeyboardHeight() > 0;
}
