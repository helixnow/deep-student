/**
 * StreamingSkeleton — 流式响应等待骨架态
 *
 * 在首个 token 到达前显示三条 shimmer 骨架线，比单行文字提示提供
 * 更丰富的"内容即将到达"暗示（对齐 Claude / ChatGPT 的等待视觉）。
 *
 * 实现（2026-07 二轮改造 · 分区 A）：迁移到 motion.css 的 .chat-shimmer
 * 共享类（muted 底 + translateX 扫光，合成器动画；inline animation-delay
 * 由 ::after 继承实现三线错峰；自带 prefers-reduced-motion 降级）。
 * 无障碍语义由上方的 ThinkingIndicator（role="status"）承担，骨架本身纯装饰。
 */

import React from 'react';
import { cn } from '@/utils/cn';

const SKELETON_LINES: Array<{ width: string; delay?: string }> = [
  { width: '82%' },
  { width: '60%', delay: '0.12s' },
  { width: '40%', delay: '0.24s' },
];

export const StreamingSkeleton: React.FC<{ className?: string }> = ({ className }) => (
  <div
    className={cn('flex select-none flex-col gap-2.5 py-1.5', className)}
    aria-hidden="true"
    data-slot="streaming-skeleton"
  >
    {SKELETON_LINES.map((line, index) => (
      <div
        key={index}
        className="chat-shimmer h-[13px]"
        style={{ width: line.width, animationDelay: line.delay }}
      />
    ))}
  </div>
);
