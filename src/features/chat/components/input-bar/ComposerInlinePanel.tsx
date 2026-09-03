/**
 * ComposerInlinePanel - 移动端组合面板的内联展开容器
 *
 * 与桌面端的 ComposerPanelOverlay（createPortal + fixed 锚定浮层）互补：
 * 移动端面板在输入壳内部、输入区上方随文档流"长出"，把消息区顶起来，
 * 对齐 ChatGPT / Claude 移动 App 的组合面板心智（无模态、无抽屉）。
 *
 * 实现要点：
 * - grid-template-rows 0fr→1fr 做 200ms 展开/收起动画（内容高度自适应，
 *   无 max-height 跳变）；prefers-reduced-motion 时禁用过渡。
 * - 面板内容内部滚动；最大高度用 clamp() 同时受视口高度与键盘 inset
 *  （document root 上的 --keyboard-inset，由 useKeyboardInset 单例维护）约束，
 *   保证键盘弹起时面板不被顶出屏幕。160px 下限是二段式的：可用空间充足时
 *   保底 160px；短横屏 + 键盘等极端场景可用空间不足 160px 时退化为可用空间
 *   本身（最低 0px），内容靠内部滚动消化，绝不把输入区撑出屏幕。
 * - closing/closed 时内容容器 inert + aria-hidden：grid-rows 0fr 收起后 children
 *   仍挂载（overflow-hidden 只裁视觉，不裁 Tab 焦点与读屏树），必须显式移除
 *   可聚焦性与无障碍暴露。inert 经 DOM property 设置（React 18 的 JSX 属性表
 *   尚不识别 inert；与 InlineReveal 同一模式，对整棵子树生效且不可被子级覆盖）。
 * - 视觉沿用 --composer-panel-* token 体系，圆角由外层输入壳（rounded-[22px]
 *   + overflow-hidden）裁切。
 */
import React from 'react';
import { cn } from '@/lib/utils';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import type { ComposerPanelMotion } from './ComposerPanelOverlay';

export interface ComposerInlinePanelProps {
  panelKey: string;
  motionState: ComposerPanelMotion;
  /** 面板内容最大高度（px），实际生效值还会被视口与键盘 inset 进一步压缩 */
  maxHeight?: number;
  /**
   * content: 内容自然高度 + 超出后内部滚动（附件/对话控制）
   * available: 撑满可用高度（模型/技能/MCP 等内部依赖 h-full 布局的面板）
   */
  heightMode?: 'content' | 'available';
  /** 无障碍标签（面板标题） */
  ariaLabel?: string;
  className?: string;
  /** 面板内容容器 className（承载分隔线/内边距等宿主侧间距） */
  bodyClassName?: string;
  children: React.ReactNode;
}

export function ComposerInlinePanel({
  panelKey,
  motionState,
  maxHeight = 420,
  heightMode = 'content',
  ariaLabel,
  className,
  bodyClassName,
  children,
}: ComposerInlinePanelProps) {
  const expanded = motionState === 'open' || motionState === 'opening';

  // closing/closed：children 仍挂载（0fr 只裁视觉），整棵子树 inert 化移除
  // Tab 焦点与指针命中。经 DOM property 设置（React 18 JSX 不识别 inert 属性，
  // 且 inert={false} 会被序列化为 truthy 的 inert="false"）。
  const contentRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    const el = contentRef.current as (HTMLDivElement & { inert: boolean }) | null;
    if (el) el.inert = !expanded;
  }, [expanded]);


  // 85vh 基于布局视口：Android adjustResize 下随键盘缩小，--keyboard-inset≈0；
  // iOS overlay 键盘下布局视口不变，用 --keyboard-inset 扣除被遮挡部分。
  // 再预留 ~180px 给输入区自身。
  const availableSpace = `calc(85vh - var(--keyboard-inset, 0px) - 180px)`;
  // 二段式下限：可用空间 ≥160px 才保底 160px；不足（短横屏 + 键盘）时下限退化
  // 为可用空间本身并靠内部滚动消化，max(0px, ...) 兜底防止负值。
  // 禁止把 160px 写成无条件的 clamp 下限——那会在极端视口把面板撑出屏幕。
  const minHeightFloor = `max(0px, min(160px, ${availableSpace}))`;
  const heightValue = `clamp(${minHeightFloor}, ${availableSpace}, ${maxHeight}px)`;

  return (
    <div
      data-composer-panel-inline={panelKey}
      data-panel-motion={motionState}
      className={cn(
        // P2-4 动效 token 统一：时长/缓动消费 --chat-composer-motion-* 与 --panel-ease
        //（fallback 与 useDeferredOpen 的 220ms 收起兜底保持兼容）
        'grid transition-[grid-template-rows,opacity] duration-[var(--chat-composer-motion-duration,200ms)] ease-[var(--panel-ease,cubic-bezier(0.22,1,0.36,1))] will-change-[grid-template-rows]',
        'motion-reduce:transition-none motion-reduce:duration-0',
        expanded ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        className
      )}
    >
      {/* 0fr→1fr 动画要求直接子元素 min-h-0 + overflow-hidden 才能被裁切；
          收起态（closing/closed）同时 inert（effect 维护）+ aria-hidden，
          两种 heightMode 的内容都经此容器，统一在此隔离 */}
      <div
        ref={contentRef}
        aria-hidden={!expanded || undefined}
        className="min-h-0 overflow-hidden"
      >
        {heightMode === 'available' ? (
          <div
            role="region"
            aria-label={ariaLabel ?? panelKey}
            className={cn(
              'flex min-h-0 flex-col overflow-hidden text-[color:var(--composer-panel-foreground)]',
              bodyClassName
            )}
            style={{ height: heightValue }}
          >
            {children}
          </div>
        ) : (
          <CustomScrollArea
            role="region"
            aria-label={ariaLabel ?? panelKey}
            fullHeight={false}
            className="text-[color:var(--composer-panel-foreground)]"
            viewportClassName={cn('flex min-h-0 flex-col', bodyClassName)}
            viewportProps={{ style: { maxHeight: heightValue } }}
            style={{ maxHeight: heightValue }}
          >
            {children}
          </CustomScrollArea>
        )}
      </div>
    </div>
  );
}

export default ComposerInlinePanel;
