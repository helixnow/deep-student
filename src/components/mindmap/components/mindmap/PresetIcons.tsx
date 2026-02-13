/**
 * 预设图标组件
 *
 * 为不同布局类型提供 SVG 预览图标
 */

import React from 'react';
import type { LayoutDirection, PresetCategory } from '../../registry/types';

interface IconProps {
  direction?: LayoutDirection;
  className?: string;
}

/**
 * 思维导图图标
 * - both: 双向展开
 * - left: 向左展开
 * - right: 向右展开（默认）
 */
export const MindMapIcon: React.FC<IconProps> = ({ direction = 'right', className }) => (
  <svg
    width="40"
    height="28"
    viewBox="0 0 40 28"
    className={className}
    fill="none"
  >
    {direction === 'both' ? (
      <>
        {/* 中心节点 */}
        <rect x="15" y="10" width="10" height="8" rx="2" fill="currentColor" />
        {/* 左侧分支 */}
        <path
          d="M15 14H10C8.5 14 8 12 8 10V8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M15 14H10C8.5 14 8 16 8 18V20"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <rect x="2" y="5" width="6" height="5" rx="1.5" fill="currentColor" opacity="0.7" />
        <rect x="2" y="18" width="6" height="5" rx="1.5" fill="currentColor" opacity="0.7" />
        {/* 右侧分支 */}
        <path
          d="M25 14H30C31.5 14 32 12 32 10V8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M25 14H30C31.5 14 32 16 32 18V20"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <rect x="32" y="5" width="6" height="5" rx="1.5" fill="currentColor" opacity="0.7" />
        <rect x="32" y="18" width="6" height="5" rx="1.5" fill="currentColor" opacity="0.7" />
      </>
    ) : direction === 'left' ? (
      <>
        {/* 根节点在右侧 */}
        <rect x="28" y="10" width="10" height="8" rx="2" fill="currentColor" />
        {/* 向左分支 */}
        <path
          d="M28 14H22C20 14 19 11 19 8V6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M28 14H22C20 14 19 14 19 14H16"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M28 14H22C20 14 19 17 19 20V22"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <rect x="2" y="3" width="8" height="5" rx="1.5" fill="currentColor" opacity="0.7" />
        <rect x="2" y="11" width="8" height="5" rx="1.5" fill="currentColor" opacity="0.7" />
        <rect x="2" y="19" width="8" height="5" rx="1.5" fill="currentColor" opacity="0.7" />
      </>
    ) : (
      <>
        {/* 根节点在左侧（默认向右） */}
        <rect x="2" y="10" width="10" height="8" rx="2" fill="currentColor" />
        {/* 向右分支 */}
        <path
          d="M12 14H18C20 14 21 11 21 8V6"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M12 14H18C20 14 21 14 21 14H24"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <path
          d="M12 14H18C20 14 21 17 21 20V22"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          fill="none"
        />
        <rect x="30" y="3" width="8" height="5" rx="1.5" fill="currentColor" opacity="0.7" />
        <rect x="30" y="11" width="8" height="5" rx="1.5" fill="currentColor" opacity="0.7" />
        <rect x="30" y="19" width="8" height="5" rx="1.5" fill="currentColor" opacity="0.7" />
      </>
    )}
  </svg>
);

/**
 * 逻辑图图标
 * - both: 双向展开
 * - left: 向左展开
 * - right: 向右展开（默认）
 */
export const LogicIcon: React.FC<IconProps> = ({ direction = 'right', className }) => (
  <svg
    width="40"
    height="28"
    viewBox="0 0 40 28"
    className={className}
    fill="none"
  >
    {direction === 'both' ? (
      <>
        {/* 中心节点 */}
        <rect x="16" y="11" width="8" height="6" rx="1" fill="currentColor" />
        {/* 左侧正交连接 */}
        <path
          d="M16 14H12V6H8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M16 14H12V22H8"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <rect x="2" y="3" width="6" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="2" y="20" width="6" height="5" rx="1" fill="currentColor" opacity="0.7" />
        {/* 右侧正交连接 */}
        <path
          d="M24 14H28V6H32"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M24 14H28V22H32"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <rect x="32" y="3" width="6" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="32" y="20" width="6" height="5" rx="1" fill="currentColor" opacity="0.7" />
      </>
    ) : direction === 'left' ? (
      <>
        {/* 根节点在右侧 */}
        <rect x="30" y="11" width="8" height="6" rx="1" fill="currentColor" />
        {/* 向左正交连接 */}
        <path
          d="M30 14H24V5H18"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M30 14H24V14H18"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M30 14H24V23H18"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <rect x="2" y="2" width="7" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="2" y="11" width="7" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="2" y="20" width="7" height="5" rx="1" fill="currentColor" opacity="0.7" />
      </>
    ) : (
      <>
        {/* 根节点在左侧（默认向右） */}
        <rect x="2" y="11" width="8" height="6" rx="1" fill="currentColor" />
        {/* 向右正交连接 */}
        <path
          d="M10 14H16V5H22"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M10 14H16V14H22"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M10 14H16V23H22"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <rect x="31" y="2" width="7" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="31" y="11" width="7" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="31" y="20" width="7" height="5" rx="1" fill="currentColor" opacity="0.7" />
      </>
    )}
  </svg>
);

/**
 * 组织结构图图标
 * - down: 向下展开（默认）
 * - up: 向上展开
 * - left: 向左展开
 * - right: 向右展开
 */
export const OrgChartIcon: React.FC<IconProps> = ({ direction = 'down', className }) => (
  <svg
    width="40"
    height="28"
    viewBox="0 0 40 28"
    className={className}
    fill="none"
  >
    {direction === 'up' ? (
      <>
        {/* 根节点在下方 */}
        <rect x="14" y="20" width="12" height="6" rx="1.5" fill="currentColor" />
        {/* 向上阶梯连接 */}
        <path
          d="M20 20V16H8V10"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M20 20V16V10"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M20 20V16H32V10"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <rect x="4" y="2" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="16" y="2" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="28" y="2" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
      </>
    ) : direction === 'left' ? (
      <>
        {/* 根节点在右侧 */}
        <rect x="28" y="10" width="10" height="8" rx="1.5" fill="currentColor" />
        {/* 向左阶梯连接 */}
        <path
          d="M28 14H22V5H16"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M28 14H22H16"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M28 14H22V23H16"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <rect x="2" y="2" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="2" y="11" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="2" y="20" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
      </>
    ) : direction === 'right' ? (
      <>
        {/* 根节点在左侧 */}
        <rect x="2" y="10" width="10" height="8" rx="1.5" fill="currentColor" />
        {/* 向右阶梯连接 */}
        <path
          d="M12 14H18V5H24"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M12 14H18H24"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M12 14H18V23H24"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <rect x="30" y="2" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="30" y="11" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="30" y="20" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
      </>
    ) : (
      <>
        {/* 根节点在上方（默认向下） */}
        <rect x="14" y="2" width="12" height="6" rx="1.5" fill="currentColor" />
        {/* 向下阶梯连接 */}
        <path
          d="M20 8V12H8V18"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M20 8V12V18"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <path
          d="M20 8V12H32V18"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="square"
          fill="none"
        />
        <rect x="4" y="21" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="16" y="21" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
        <rect x="28" y="21" width="8" height="5" rx="1" fill="currentColor" opacity="0.7" />
      </>
    )}
  </svg>
);

/**
 * 根据预设类别和方向获取对应图标
 */
export const PresetIcon: React.FC<{
  category: PresetCategory;
  direction: LayoutDirection;
  className?: string;
}> = ({ category, direction, className }) => {
  const iconClass = className || 'text-gray-600 dark:text-gray-300';

  switch (category) {
    case 'mindmap':
      return <MindMapIcon direction={direction} className={iconClass} />;
    case 'logic':
      return <LogicIcon direction={direction} className={iconClass} />;
    case 'orgchart':
      return <OrgChartIcon direction={direction} className={iconClass} />;
    default:
      return <MindMapIcon direction={direction} className={iconClass} />;
  }
};

export default PresetIcon;
