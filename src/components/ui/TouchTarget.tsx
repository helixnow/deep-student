import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cn } from '@/lib/utils';

/**
 * TouchTarget —— 非 button 热区的实体触控保证（0824 Wave2-C R3）
 *
 * 定位（与 DsButton 的分工）：
 * - 渲染 <button> 的场景一律走 DsButton：coarse 尺寸保证由
 *   buttonPrimitiveContract 在 primitive 层下沉（Wave2-C 批 2），
 *   不要用 TouchTarget 包 DsButton，双机制叠加没有意义。
 * - TouchTarget 覆盖其余可交互热区：充当 Radix/AppMenu trigger 的
 *   span、链接、第三方组件外壳、复合行内触发器等。
 *
 * 机制：coarse 指针下用真实盒（min-h/min-w = --touch-target-size，44px）
 * 撑出 ≥44×44 命中区，而不是伪元素 after:-inset 扩区——伪元素扩区在
 * 密排行内会互相覆盖（见 wave2-C-r1/09-touch-44.md §2），只保留为
 * 逃生舱（@/components/ui/coarseHit）。
 * 用 min-* 而非 h-* / w-* 或 !important：min-height/min-width 在 CSS 求值
 * 层面天然赢过调用方的 height/width（h-6/h-7/h-9 等视觉尺寸类可原样
 * 保留），细指针（桌面鼠标）下整组类不生效，视觉不被撑大。
 * 图标视觉尺寸（24/28/36）由 children 自己控制，本组件不干预。
 */

/**
 * 仅 coarse 门控的实体最小尺寸，不含布局类。
 * 给已经自带 inline-flex 布局的交互元素（asChild 场景的 button/a）用。
 */
export const touchTargetCoarseClassName =
  '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]';

/**
 * 完整 TouchTarget 类：flex 居中盒 + coarse 实体最小尺寸。
 * shrink-0 防止密排 flex 行在空间不足时把命中区压回 44 以下。
 */
export const touchTargetClassName = cn(
  'inline-flex shrink-0 items-center justify-center',
  touchTargetCoarseClassName
);

export interface TouchTargetProps extends React.HTMLAttributes<HTMLSpanElement> {
  /**
   * true 时不额外渲染节点，把类合并到唯一子元素上（Radix Slot 范式，
   * 与 shad/Button 同款）。子元素本身是交互元素（a、第三方组件的
   * 根节点等）时优先用这种形态：真实盒长在交互元素自己身上，
   * 命中区与事件目标天然一致。
   */
  asChild?: boolean;
}

/**
 * 默认形态渲染 span 包裹盒：span 自身就是命中面，事件处理器与
 * aria 属性应放在 TouchTarget 上（会被 spread 到 span），children
 * 只做视觉。若 children 自己是可交互元素，请改用 asChild，
 * 避免「span 撑到 44 但内部 28px 按钮才接事件」的假命中区。
 */
export const TouchTarget = React.forwardRef<HTMLSpanElement, TouchTargetProps>(
  ({ asChild = false, className, ...props }, ref) => {
    const Comp = asChild ? Slot : 'span';
    return <Comp ref={ref} className={cn(touchTargetClassName, className)} {...props} />;
  }
);

TouchTarget.displayName = 'TouchTarget';

export default TouchTarget;
