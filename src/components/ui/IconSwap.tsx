import * as React from 'react';
import { cn } from '@/lib/utils';

export interface IconSwapProps {
  /** 当前是否处于"切换后"状态：false 显示 `a`，true 显示 `b`。 */
  active: boolean;
  /** 默认状态（active=false）时显示的图标。 */
  a: React.ReactNode;
  /** 切换后状态（active=true）时显示的图标。 */
  b: React.ReactNode;
  /** 包裹元素 className（通常用于尺寸或对齐微调）。 */
  className?: string;
}

/**
 * 同槽位双图标交叉切换（transitions-dev: icon-swap）。
 *
 * 两枚图标始终同时存在 DOM，仅通过 opacity/blur/scale 的 CSS 过渡完成交替。
 * 纯 CSS 驱动，无 JS 编排；继承 `:root` 的 `--icon-swap-*` 与 prefers-reduced-motion。
 */
export const IconSwap: React.FC<IconSwapProps> = ({ active, a, b, className }) => (
  <span className={cn('t-icon-swap', className)} data-state={active ? 'b' : 'a'}>
    <span className="t-icon" data-icon="a">{a}</span>
    <span className="t-icon" data-icon="b">{b}</span>
  </span>
);

export default IconSwap;
