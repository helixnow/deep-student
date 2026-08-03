/**
 * ChatWindowSkeleton — Chat 窗口的会话加载骨架屏（O16）
 *
 * 用途（替代空白/转圈）：
 * 1. ChatWindowFrame：chat 重 chunk（ChatAppWindow → ChatContainer 全家桶）
 *    React.lazy 加载期间的 Suspense fallback；
 * 2. ChatAppWindow：Dock 无 instanceKey 启动时自动建会话的等待态。
 *
 * 结构刻意与 legacy ChatContainer 的冷启动骨架（chat-loading-shell）对齐
 * （顶对齐消息流：用户右气泡 / 助手头像+行、底部输入栏面板），
 * 使「本骨架 → legacy 骨架 → 真实内容」的接力在视觉上连续无跳变。
 *
 * 动效纪律（§1.5）：仅 opacity 动画；挂载后延迟 ~120ms 才淡入
 * （快速加载在可见前即被真实内容替换，等效不显示）；
 * prefers-reduced-motion 与 minimal 材质档下静态呈现。
 *
 * 本组件必须保持轻量（不 import 任何 chat 核心代码），
 * 它随 ChatWindowFrame 进入先导小 chunk。
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import './ChatWindowSkeleton.css';

export interface ChatWindowSkeletonProps {
  /** 屏幕阅读器播报文案；缺省“正在加载会话…” */
  statusText?: string;
  className?: string;
}

/** 骨架行（气泡/文本行）；--wb-chat-bone-i 驱动脉冲动画的错峰延迟 */
const Bone: React.FC<{ index: number; className?: string }> = ({ index, className }) => (
  <div
    className={cn('wb-chat-skeleton__bone', className)}
    style={{ '--wb-chat-bone-i': index } as React.CSSProperties}
  />
);

export const ChatWindowSkeleton: React.FC<ChatWindowSkeletonProps> = ({
  statusText,
  className,
}) => {
  const { t } = useTranslation('workbench');
  const label = statusText ?? t('apps.chat.loading');

  return (
    <div
      className={cn('wb-chat-skeleton', className)}
      data-wb-chat-skeleton
      role="status"
      aria-live="polite"
      aria-label={label}
    >
      <span className="sr-only">{label}</span>

      {/* inner 承载排版（padding/flex），root 作为容器查询锚：
          窄窗时留白跟随真实内容的紧凑档（1rem / 0.75rem）同节奏收缩，
          骨架 → 真实内容切换不发生边缘跳变 */}
      <div className="wb-chat-skeleton__inner">
        <div className="wb-chat-skeleton__thread" aria-hidden="true">
          {/* 用户消息 */}
          <div className="wb-chat-skeleton__row wb-chat-skeleton__row--user">
            <Bone index={0} className="wb-chat-skeleton__bubble wb-chat-skeleton__bubble--lg" />
          </div>
          {/* 助手消息 */}
          <div className="wb-chat-skeleton__row wb-chat-skeleton__row--assistant">
            <Bone index={1} className="wb-chat-skeleton__avatar" />
            <div className="wb-chat-skeleton__lines">
              <Bone index={2} className="wb-chat-skeleton__line" />
              <Bone index={3} className="wb-chat-skeleton__line wb-chat-skeleton__line--w75" />
              <Bone index={4} className="wb-chat-skeleton__line wb-chat-skeleton__line--w50" />
            </div>
          </div>
          {/* 用户消息 */}
          <div className="wb-chat-skeleton__row wb-chat-skeleton__row--user">
            <Bone index={5} className="wb-chat-skeleton__bubble wb-chat-skeleton__bubble--sm" />
          </div>
          {/* 助手消息 */}
          <div className="wb-chat-skeleton__row wb-chat-skeleton__row--assistant">
            <Bone index={6} className="wb-chat-skeleton__avatar" />
            <div className="wb-chat-skeleton__lines">
              <Bone index={7} className="wb-chat-skeleton__line" />
              <Bone index={8} className="wb-chat-skeleton__line wb-chat-skeleton__line--w66" />
            </div>
          </div>
        </div>

        {/* 输入栏骨架（与 legacy chat-loading-composer 面板等位） */}
        <div className="wb-chat-skeleton__composer" aria-hidden="true">
          <div className="wb-chat-skeleton__composer-toolbar">
            <Bone index={9} className="wb-chat-skeleton__chip" />
            <Bone index={10} className="wb-chat-skeleton__chip wb-chat-skeleton__chip--wide" />
            <Bone index={11} className="wb-chat-skeleton__chip" />
          </div>
          <div className="wb-chat-skeleton__lines">
            <Bone index={12} className="wb-chat-skeleton__line wb-chat-skeleton__line--w83" />
            <Bone index={13} className="wb-chat-skeleton__line wb-chat-skeleton__line--w40" />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatWindowSkeleton;
