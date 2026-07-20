/**
 * RollingTime — 计时数字的逐位滚动过渡
 *
 * 每个字符占一个独立槽位（overflow-hidden），字符变化时旧数字上滚淡出、
 * 新数字自下滚入（AnimatePresence popLayout，纯 transform/opacity，无重排）。
 * 每秒仅个位秒数字动画，60fps 开销可忽略；reduced-motion 下瞬时切换。
 *
 * 依赖 tabular-nums（调用方样式）保证槽位定宽，冒号等分隔符不参与动画。
 */

import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { cn } from '@/lib/utils';
import { motionSafe, tweenFast } from '@/styles/motion-springs';

export const RollingTime: React.FC<{
  /** 已格式化的时间文本，如 "24:59" */
  text: string;
  className?: string;
}> = ({ text, className }) => {
  const transition = motionSafe(tweenFast);
  return (
    <span
      className={cn('inline-flex', className)}
      role="timer"
      aria-label={text}
    >
      {text.split('').map((ch, i) => (
        <span
          // 槽位按位置固定；位数变化（正计时跨 100 分钟）时整体重排一次
          key={i}
          className="relative inline-flex justify-center overflow-hidden"
          aria-hidden="true"
        >
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.span
              key={ch}
              initial={{ y: '0.55em', opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: '-0.55em', opacity: 0 }}
              transition={transition}
              className="inline-block"
            >
              {ch}
            </motion.span>
          </AnimatePresence>
        </span>
      ))}
    </span>
  );
};

export default RollingTime;
