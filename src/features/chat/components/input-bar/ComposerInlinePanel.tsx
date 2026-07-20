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
 *   保证键盘弹起时面板不被顶出屏幕。
 * - 视觉沿用 --composer-panel-* token 体系，圆角由外层输入壳（rounded-[22px]
 *   + overflow-hidden）裁切。
 */
import React from 'react';
import { cn } from '@/lib/utils';
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
  // 85vh 基于布局视口：Android adjustResize 下随键盘缩小，--keyboard-inset≈0；
  // iOS overlay 键盘下布局视口不变，用 --keyboard-inset 扣除被遮挡部分。
  // 再预留 ~180px 给输入区自身，最低保 160px 可用高度。
  const heightValue = `clamp(160px, calc(85vh - var(--keyboard-inset, 0px) - 180px), ${maxHeight}px)`;

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
      {/* 0fr→1fr 动画要求直接子元素 min-h-0 + overflow-hidden 才能被裁切 */}
      <div className="min-h-0 overflow-hidden">
        <div
          role="region"
          aria-label={ariaLabel ?? panelKey}
          className={cn(
            'flex min-h-0 flex-col text-[color:var(--composer-panel-foreground)]',
            heightMode === 'available'
              ? 'overflow-hidden'
              : 'overflow-y-auto overscroll-contain',
            bodyClassName
          )}
          style={
            heightMode === 'available'
              ? { height: heightValue }
              : { maxHeight: heightValue }
          }
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export default ComposerInlinePanel;
