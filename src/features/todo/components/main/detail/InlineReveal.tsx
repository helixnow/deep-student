/**
 * InlineReveal — 内联展开/收合容器（grid-rows [0fr]→[1fr]）
 *
 * 详情面板内一切「条件出现」的内容（提示条、快捷 chip 行、内联日历等）统一走此容器，
 * 保证 200ms cubic-bezier(0.22,1,0.36,1) 的展开质感；motion-reduce 退化为瞬时切换。
 *
 * 收起态的不可交互性用 DOM `inert` 保证（visibility:hidden 会被子元素显式
 * visible 覆盖——嵌套 InlineReveal 展开时其内容虽被裁剪仍可 Tab 聚焦；
 * inert 对整棵子树生效且不可被子级覆盖，同时移除指针命中与可聚焦性）。
 * visibility/opacity 类保留用于渐隐渐显：收起在动画结束时才隐藏，不打断高度动画。
 */

import React, { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';

export const InlineReveal: React.FC<{
  open: boolean;
  children: React.ReactNode;
  className?: string;
}> = ({ open, children, className }) => {
  const ref = useRef<HTMLDivElement>(null);

  // 经 DOM property 设置（React 18 的 JSX 属性表尚不识别 inert）
  useEffect(() => {
    const el = ref.current as (HTMLDivElement & { inert: boolean }) | null;
    if (el) el.inert = !open;
  }, [open]);

  return (
    <div
      ref={ref}
      aria-hidden={!open}
      className={cn(
        'grid transition-[grid-template-rows,opacity,visibility] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none',
        open
          ? 'visible grid-rows-[1fr] opacity-100'
          : 'invisible pointer-events-none grid-rows-[0fr] opacity-0',
        className,
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
};

export default InlineReveal;
