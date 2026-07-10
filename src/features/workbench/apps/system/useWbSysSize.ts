/**
 * useWbSysSize（O18）— 窗口内容区尺寸分级 hook
 *
 * legacy 页面的响应式全部基于 viewport media query / useBreakpoint（视口断点），
 * 在 workbench 窗口里恒等于"桌面大屏"——窗口再窄也拿不到紧凑布局。
 * 本 hook 用 ResizeObserver 观察**窗口内容区自身**的宽高，产出离散分级：
 *
 * - 宽度：wide（≥880）/ medium（≥640）/ compact（<640）
 * - 高度：tall（≥520）/ short（<520）
 *
 * 分级同时写成宿主元素的 data 属性（data-wb-sys-size / data-wb-sys-h，
 * 供纯 CSS 布局消费，直写 DOM 不进 React state），仅当**分级跳变**时才
 * setState 触发重渲染（拖拽缩放过程中 0 额外 React 渲染）。
 *
 * jsdom / 老 WebView 无 ResizeObserver 时安全兜底为 wide/tall。
 */
import { useEffect, useRef, useState } from 'react';

export type WbSysSizeClass = 'compact' | 'medium' | 'wide';
export type WbSysHeightClass = 'short' | 'tall';

export const WB_SYS_WIDTH_MEDIUM = 640;
export const WB_SYS_WIDTH_WIDE = 880;
export const WB_SYS_HEIGHT_TALL = 520;

/** 宽度 → 分级（纯函数，供测试直接断言阈值） */
export function classifyWbSysWidth(width: number): WbSysSizeClass {
  if (width >= WB_SYS_WIDTH_WIDE) return 'wide';
  if (width >= WB_SYS_WIDTH_MEDIUM) return 'medium';
  return 'compact';
}

/** 高度 → 分级（纯函数） */
export function classifyWbSysHeight(height: number): WbSysHeightClass {
  return height >= WB_SYS_HEIGHT_TALL ? 'tall' : 'short';
}

export interface WbSysSize {
  /** 挂到窗口内容区根元素 */
  ref: React.RefObject<HTMLDivElement>;
  sizeClass: WbSysSizeClass;
  heightClass: WbSysHeightClass;
}

export function useWbSysSize(): WbSysSize {
  const ref = useRef<HTMLDivElement>(null);
  const [sizeClass, setSizeClass] = useState<WbSysSizeClass>('wide');
  const [heightClass, setHeightClass] = useState<WbSysHeightClass>('tall');
  // 最近一次分级缓存在 ref 上，避免 observer 回调闭包读到陈旧 state
  const lastRef = useRef<{ size: WbSysSizeClass; height: WbSysHeightClass }>({
    size: 'wide',
    height: 'tall',
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = (width: number, height: number) => {
      const size = classifyWbSysWidth(width);
      const h = classifyWbSysHeight(height);
      // data 属性直写 DOM：CSS 布局零 React 参与
      if (el.getAttribute('data-wb-sys-size') !== size) {
        el.setAttribute('data-wb-sys-size', size);
      }
      if (el.getAttribute('data-wb-sys-h') !== h) {
        el.setAttribute('data-wb-sys-h', h);
      }
      if (lastRef.current.size !== size) {
        lastRef.current.size = size;
        setSizeClass(size);
      }
      if (lastRef.current.height !== h) {
        lastRef.current.height = h;
        setHeightClass(h);
      }
    };

    // 首帧同步一次（ResizeObserver 首次回调是异步的，避免布局闪变）
    const rect = el.getBoundingClientRect();
    apply(rect.width || el.clientWidth, rect.height || el.clientHeight);

    if (typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const box = entry.contentBoxSize?.[0];
      const width = box ? box.inlineSize : entry.contentRect.width;
      const height = box ? box.blockSize : entry.contentRect.height;
      apply(width, height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, sizeClass, heightClass };
}
