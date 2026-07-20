/**
 * InlineCollapse — 工具栏下方内联条/面板的展开收起动画容器。
 *
 * 统一外壳内联面板（搜索条、版本历史、确认横幅、导出进度等）的
 * 进出场节奏：高度 0 ↔ auto + 透明度，配合 AnimatePresence 支持退场。
 * 遵循项目动画规范：framer-motion + motion-springs 预设，
 * prefers-reduced-motion 下退化为瞬时完成（motionSafe）。
 */

import React from 'react';
import { motion } from 'framer-motion';
import { motionSafe, tweenFast } from '@/styles/motion-springs';

export interface InlineCollapseProps {
  children: React.ReactNode;
  className?: string;
  /** 透传给 motion.div 的 role（如 'alert' / 'search' / 'status'） */
  role?: string;
  'aria-label'?: string;
  'aria-live'?: 'polite' | 'assertive' | 'off';
}

export const InlineCollapse: React.FC<InlineCollapseProps> = ({
  children,
  className,
  role,
  'aria-label': ariaLabel,
  'aria-live': ariaLive,
}) => (
  <motion.div
    initial={{ height: 0, opacity: 0 }}
    animate={{ height: 'auto', opacity: 1 }}
    exit={{ height: 0, opacity: 0 }}
    transition={motionSafe(tweenFast)}
    // 高度动画期间裁掉内容溢出，避免面板内容在收起时露出
    style={{ overflow: 'hidden' }}
    className={className}
    role={role}
    aria-label={ariaLabel}
    aria-live={ariaLive}
  >
    {children}
  </motion.div>
);

export default InlineCollapse;
