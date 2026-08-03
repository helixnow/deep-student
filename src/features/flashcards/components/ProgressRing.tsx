/** 纯 SVG 进度环（今日完成度等）；过渡动画由 CSS 负责并尊重 reduced-motion。 */
import React from 'react';

export interface ProgressRingProps {
  /** 0..1 */
  value: number;
  size?: number;
  strokeWidth?: number;
  /** 环中心内容 */
  children?: React.ReactNode;
  'aria-label'?: string;
}

export const ProgressRing: React.FC<ProgressRingProps> = ({
  value,
  size = 96,
  strokeWidth = 8,
  children,
  'aria-label': ariaLabel,
}) => {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;

  return (
    <div
      className="wb-fcx-ring"
      style={{ width: size, height: size }}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          className="wb-fcx-ring-track"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
        />
        <circle
          className="wb-fcx-ring-value"
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - clamped)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className="wb-fcx-ring-center">{children}</div>
    </div>
  );
};
