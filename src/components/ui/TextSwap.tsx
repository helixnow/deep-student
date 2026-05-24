import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

/**
 * 读取 CSS 自定义属性的时长（ms 或 s），用于和样式中的 --text-swap-dur 保持同步。
 * 失败时回退到 fallback。
 */
function readCssDurationMs(varName: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return fallback;
  const num = parseFloat(raw);
  if (Number.isNaN(num)) return fallback;
  if (raw.endsWith('ms')) return num;
  if (raw.endsWith('s')) return num * 1000;
  return num;
}

export interface TextSwapProps {
  /** 当前要展示的文本；变化时触发 swap 动画。 */
  text: string;
  /** 包裹元素 className（继承字号/字重/截断等）。 */
  className?: string;
  /** 强制使用的渲染元素类型，默认 span。 */
  as?: 'span' | 'div';
}

/**
 * 文本状态切换（transitions-dev: text-states-swap）。
 *
 * 旧文本向上模糊淡出 → 新文本从下方模糊淡入。三段式：
 *   1. 加 .is-exit            旧文本退出
 *   2. dur 之后切 textContent + .is-enter-start （瞬时跳到下方，无 transition）
 *   3. 强制 reflow 后去掉 .is-enter-start，新文本回到 0
 *
 * 注意：
 * - 首次挂载不播动画，避免出现"刚打开就有元素飞进来"的视觉噪音。
 * - text 没有真实变化时跳过整段动画。
 * - 内部用 textContent 直接写入 DOM，绕开 React diff，避免 React 在动画过程中
 *   覆盖我们临时设置的 class。组件保留单个根节点，可叠加任何排版样式。
 */
export const TextSwap: React.FC<TextSwapProps> = ({ text, className, as = 'span' }) => {
  const ref = useRef<HTMLElement | null>(null);
  const previousTextRef = useRef<string>(text);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [mounted, setMounted] = useState(false);

  // 首次挂载：直接落字，不播动画
  useLayoutEffect(() => {
    if (ref.current) {
      ref.current.textContent = text;
    }
    setMounted(true);
    // 仅首次挂载执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const el = ref.current;
    if (!el) return;
    if (text === previousTextRef.current) return;

    const next = text;
    previousTextRef.current = next;

    // 取消上一次未完成的 swap
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
      el.classList.remove('is-exit', 'is-enter-start');
    }

    const dur = readCssDurationMs('--text-swap-dur', 200);

    // Phase 1：旧文字退出
    el.classList.add('is-exit');

    timeoutRef.current = setTimeout(() => {
      timeoutRef.current = null;
      if (!ref.current) return;
      const node = ref.current;

      // Phase 2：替换文本，瞬时跳到下方
      node.textContent = next;
      node.classList.remove('is-exit');
      node.classList.add('is-enter-start');

      // 强制 reflow，让下一次类移除产生 transition
      // eslint-disable-next-line @typescript-eslint/no-unused-expressions
      void node.offsetHeight;

      // Phase 3：新文字进入
      node.classList.remove('is-enter-start');
    }, dur);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      el.classList.remove('is-exit', 'is-enter-start');
    };
  }, [text, mounted]);

  const Tag = as as 'span';
  return (
    <Tag
      ref={ref as React.RefObject<HTMLSpanElement>}
      className={cn('t-text-swap', className)}
      // 文字内容由 effect 直接写入，避免 React 在动画过程中覆盖我们临时加的 class
    />
  );
};

export default TextSwap;
