/**
 * 移动端软键盘检测基建（Android + iOS 统一，对应社区 issue/PR #113 的三个键盘 bug）
 *
 * 背景：
 * - Android Activity 默认 adjustResize 行为下，键盘弹出会压缩整个 WebView：
 *   居中定位的 Dialog 被压到极小；键盘引发的 resize/focus/blur 连锁可能误触全局导航。
 * - iOS WKWebView 的键盘是 overlay 行为：布局视口不变、仅 visualViewport 缩小，
 *   docked 输入栏需要额外的 bottom inset 才能浮在键盘上方。
 *
 * 本模块用 visualViewport 维护一个模块级键盘状态单例：
 * - React 组件用 useKeyboardHeight() / useIsKeyboardShown() / useKeyboardInset() 订阅；
 * - 普通事件处理器（如 App.tsx 的导航守卫）用 getKeyboardHeight() /
 *   shouldBlockMobileNavigation() 同步读取，无需 hook。
 *
 * 两个核心值的区别：
 * - keyboardHeight：键盘占用的视觉高度（基线高度 - 当前 visualViewport 高度），
 *   用于「键盘是否弹出」的判定与 Dialog 压缩补偿；
 * - keyboardInset：布局视口被键盘遮挡的高度（layout viewport - visualViewport），
 *   用于 docked 输入栏的 bottom 避让。Android adjustResize 下布局视口随键盘
 *   收缩，inset ≈ 0（容器本身已避开键盘，避免双重抬升）；iOS overlay 键盘下
 *   inset ≈ 键盘高度。调用方无需区分平台。
 *
 * 实现要点：
 * - Android + iOS 都走 visualViewport 通用路径（桌面端不启用，避免窗口缩放误判）；
 * - 基线取"当前宽度下观测到的最大视口高度"，宽度变化（旋转/分屏）时重置基线，
 *   避免把旋转产生的高度差误判为键盘弹出；
 * - 高度差回落到阈值内时归零，键盘收起后状态不会卡在"弹出"。
 */
import { useSyncExternalStore } from 'react';
import { isAndroid } from '@/utils/platform';

/** 键盘判定阈值（px）：视口高度差超过该值视为键盘弹出 */
const KEYBOARD_THRESHOLD = 150;

type Listener = () => void;

/** 写入 document root 的键盘 inset CSS 变量名（契约见 transitions-dev.css） */
export const KEYBOARD_INSET_CSS_VAR = '--keyboard-inset';

let trackingStarted = false;
let keyboardHeight = 0;
let keyboardInset = 0;
let baselineHeight = 0;
let baselineWidth = 0;
const listeners = new Set<Listener>();

/** 把当前 inset 同步到 document root，供纯 CSS 消费（面板 max-height 等） */
function writeInsetCssVar(): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.setProperty(KEYBOARD_INSET_CSS_VAR, `${keyboardInset}px`);
}

/** iOS / iPadOS 检测（含桌面 UA 的 iPad：MacIntel + 多点触控） */
function isIOSLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = (navigator.userAgent || '').toLowerCase();
  if (/iphone|ipad|ipod/.test(ua)) return true;
  return (
    (navigator.platform || '') === 'MacIntel' &&
    typeof navigator.maxTouchPoints === 'number' &&
    navigator.maxTouchPoints > 1
  );
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

function handleViewportChange(): void {
  const vv = window.visualViewport;
  if (!vv) return;

  let changed = false;

  // 宽度变化 = 旋转/分屏/窗口尺寸调整，重置基线，不视为键盘
  if (vv.width !== baselineWidth) {
    baselineWidth = vv.width;
    baselineHeight = vv.height;
    if (keyboardHeight !== 0 || keyboardInset !== 0) {
      keyboardHeight = 0;
      keyboardInset = 0;
      writeInsetCssVar();
      emit();
    }
    return;
  }

  if (vv.height > baselineHeight) {
    baselineHeight = vv.height;
  }

  const diff = baselineHeight - vv.height;
  const nextHeight = diff > KEYBOARD_THRESHOLD ? Math.round(diff) : 0;
  if (nextHeight !== keyboardHeight) {
    keyboardHeight = nextHeight;
    changed = true;
  }

  // 布局视口被遮挡的实时 inset（键盘未判定弹出时归零，避免地址栏收缩等噪声）
  const nextInset = nextHeight > 0 ? computeLayoutViewportObscuredHeight(vv) : 0;
  if (nextInset !== keyboardInset) {
    keyboardInset = nextInset;
    writeInsetCssVar();
    changed = true;
  }

  if (changed) emit();
}

function computeLayoutViewportObscuredHeight(vv: VisualViewport): number {
  const layoutHeight = document.documentElement.clientHeight;
  return Math.max(0, Math.round(layoutHeight - vv.height - vv.offsetTop));
}

function ensureTracking(): void {
  if (trackingStarted || typeof window === 'undefined') return;
  trackingStarted = true;

  // 无论平台先写一次 0px，保证 CSS 消费方的 var() 始终有定义
  writeInsetCssVar();

  const vv = window.visualViewport;
  // 仅移动端平台启用：桌面端窗口高度变化不应被判定为键盘
  if (!vv || (!isAndroid() && !isIOSLike())) return;

  baselineWidth = vv.width;
  baselineHeight = vv.height;
  vv.addEventListener('resize', handleViewportChange);
  // iOS 键盘弹出时 visualViewport 可能只触发 scroll（offsetTop 变化），一并监听
  vv.addEventListener('scroll', handleViewportChange);
}

function subscribe(listener: Listener): () => void {
  ensureTracking();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getHeightSnapshot(): number {
  return keyboardHeight;
}

function getInsetSnapshot(): number {
  return keyboardInset;
}

function getServerSnapshot(): number {
  return 0;
}

/** 当前软键盘占用的视觉高度（px），键盘收起 / 非移动端时为 0 */
export function useKeyboardHeight(): number {
  return useSyncExternalStore(subscribe, getHeightSnapshot, getServerSnapshot);
}

/**
 * docked 输入栏应补偿的实时键盘 inset（px）。
 *
 * Android adjustResize：布局视口已随键盘收缩 → 返回 0（避免双重抬升）；
 * iOS overlay 键盘：布局视口不变 → 返回被遮挡高度（≈ 键盘高度）。
 */
export function useKeyboardInset(): number {
  return useSyncExternalStore(subscribe, getInsetSnapshot, getServerSnapshot);
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

/** 非 hook 版本：同步读取当前键盘 inset（语义同 useKeyboardInset） */
export function getKeyboardInset(): number {
  ensureTracking();
  return keyboardInset;
}

/**
 * 布局视口被键盘遮挡的高度（px）。
 *
 * adjustResize 生效时 WebView 布局视口随键盘缩小，返回 0（fixed inset-0 容器
 * 本身已避开键盘）；若 softInputMode 为非 resize 模式（布局视口不变、
 * 仅 visualViewport 缩小，如 iOS），返回被遮挡的差值，供 Dialog 等 fixed 容器补偿
 * paddingBottom。两种模式下调用方无需区分。
 */
export function getLayoutViewportObscuredHeight(): number {
  if (typeof window === 'undefined') return 0;
  const vv = window.visualViewport;
  if (!vv) return 0;
  const layoutHeight = document.documentElement.clientHeight;
  return Math.max(0, Math.round(layoutHeight - vv.height));
}

/** 判断元素是否可编辑（input/textarea/select/contenteditable） */
export function isEditableElement(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el instanceof HTMLElement && el.isContentEditable;
}

/** 当前焦点是否在可编辑元素上（input/textarea/contenteditable） */
export function isEditableElementFocused(): boolean {
  if (typeof document === 'undefined') return false;
  return isEditableElement(document.activeElement);
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
