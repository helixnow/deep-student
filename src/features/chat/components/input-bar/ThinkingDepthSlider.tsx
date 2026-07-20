/**
 * ThinkingDepthSlider - 思考深度滑动条
 *
 * 将离散的思考深度选项（"关闭" + low/medium/high/xhigh/max 的任意子集）映射为
 * 一条可拖拽 / 点击 / 键盘操作的粗滑动条。Canvas 只在填充区域绘制
 * 低对比度纹理，避免脉冲、辉光、弹跳等装饰性动效干扰频繁调节。
 *
 * 兼容不同思考深度控制类型（openai-effort / v4-effort / v32-budget-effort）：
 * 选项集合变化后，当前值若不在新集合内，按深度等级（rank）就近吸附，
 * 平局取更高档，与后端 normalizeDeepSeekV4Effort 等归一化方向一致。
 */

import * as React from 'react';
import { cn } from '@/lib/utils';
import type {
  DeepSeekReasoningOption,
  DeepSeekReasoningOptionValue,
} from '@/utils/deepseekReasoningControls';
import './ThinkingDepthSlider.css';

const DEPTH_RANK: Record<DeepSeekReasoningOptionValue, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
};

const LONG_PRESS_DELAY_MS = 180;
const THUMB_HOLD_MOVE_TOLERANCE_PX = 6;
const MAGNETIC_PULL_RADIUS = 0.48;
const MAGNETIC_PULL_CURVE = 2.2;

export interface ThinkingDepthSliderProps {
  /** 当前模型支持的深度选项（不含"关闭"，由组件补在最左档） */
  options: DeepSeekReasoningOption[];
  /** 当前归一化后的深度值 */
  value?: DeepSeekReasoningOptionValue;
  /** 推理是否开启；false 时滑块停在"关闭"档 */
  enabled: boolean;
  /** 档位变化回调；最左档回调 'off' */
  onChange: (value: DeepSeekReasoningOptionValue | 'off') => void;
  /** "关闭"档文案 */
  offLabel: string;
  /** 左端方向提示 */
  efficientLabel: string;
  /** 右端方向提示 */
  smartLabel: string;
  /** 选项文案解析；默认使用 defaultLabel */
  resolveOptionLabel?: (option: DeepSeekReasoningOption) => string;
  ariaLabel?: string;
  className?: string;
}

/** 当前值不在选项集合内时，按 rank 就近吸附（平局取更高档） */
function nearestOptionIndex(
  options: DeepSeekReasoningOption[],
  value: DeepSeekReasoningOptionValue
): number {
  const direct = options.findIndex((option) => option.value === value);
  if (direct >= 0) return direct;

  const targetRank = DEPTH_RANK[value] ?? DEPTH_RANK.medium;
  let bestIndex = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  let bestRank = Number.NEGATIVE_INFINITY;
  options.forEach((option, index) => {
    const rank = DEPTH_RANK[option.value] ?? DEPTH_RANK.medium;
    const distance = Math.abs(rank - targetRank);
    if (distance < bestDistance || (distance === bestDistance && rank > bestRank)) {
      bestDistance = distance;
      bestRank = rank;
      bestIndex = index;
    }
  });
  return bestIndex;
}

/** 靠近离散档位时以非线性曲线增加吸力，档位中点保持连续、不突跳。 */
function magnetizeRatio(rawRatio: number, stopCount: number): number {
  if (stopCount < 2) return rawRatio;
  const step = 1 / (stopCount - 1);
  const nearestStop = Math.round(rawRatio / step) * step;
  const pullRadius = step * MAGNETIC_PULL_RADIUS;
  const distance = Math.abs(rawRatio - nearestStop);
  if (distance === 0 || distance >= pullRadius) return rawRatio;

  const closeness = 1 - distance / pullRadius;
  const attraction = Math.pow(closeness, MAGNETIC_PULL_CURVE);
  return rawRatio + (nearestStop - rawRatio) * attraction;
}

function ThinkingDepthCanvas({ ratio }: { ratio: number }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const renderedRatioRef = React.useRef(ratio);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext('2d');
    if (!canvas || !context) return;

    const reduceMotion = typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let animationFrame = 0;

    const draw = (timestamp: number) => {
      const rect = canvas.getBoundingClientRect();
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const pixelWidth = Math.round(width * pixelRatio);
      const pixelHeight = Math.round(height * pixelRatio);

      if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
        canvas.width = pixelWidth;
        canvas.height = pixelHeight;
      }

      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      context.clearRect(0, 0, width, height);

      const nextRatio = reduceMotion
        ? ratio
        : renderedRatioRef.current + (ratio - renderedRatioRef.current) * 0.16;
      renderedRatioRef.current = Math.abs(ratio - nextRatio) < 0.001 ? ratio : nextRatio;
      const activeWidth = width * renderedRatioRef.current;

      if (activeWidth > 0.5) {
        context.save();
        context.beginPath();
        context.rect(0, 0, activeWidth, height);
        context.clip();

        const phase = reduceMotion ? 0.35 : (timestamp * (0.000018 + ratio * 0.00001)) % 1;
        const shimmerAlpha = 0.018 + ratio * 0.012;
        const shimmerWidth = Math.max(42, width * 0.3);

        for (let index = 0; index < 2; index += 1) {
          const center = ((phase + index / 2) % 1) * (width + shimmerWidth) - shimmerWidth / 2;
          const gradient = context.createLinearGradient(center - shimmerWidth / 2, 0, center + shimmerWidth / 2, 0);
          gradient.addColorStop(0, 'rgba(255, 255, 255, 0)');
          gradient.addColorStop(0.5, `rgba(255, 255, 255, ${shimmerAlpha})`);
          gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
          context.fillStyle = gradient;
          context.fillRect(center - shimmerWidth / 2, 0, shimmerWidth, height);
        }
        context.restore();
      }

      if (!reduceMotion && (ratio > 0 || renderedRatioRef.current > 0.001)) {
        animationFrame = window.requestAnimationFrame(draw);
      }
    };

    draw(0);

    return () => {
      if (animationFrame) window.cancelAnimationFrame(animationFrame);
    };
  }, [ratio]);

  return <canvas ref={canvasRef} className="tds-canvas" aria-hidden="true" />;
}

export const ThinkingDepthSlider: React.FC<ThinkingDepthSliderProps> = ({
  options,
  value,
  enabled,
  onChange,
  offLabel,
  efficientLabel,
  smartLabel,
  resolveOptionLabel,
  ariaLabel,
  className,
}) => {
  const trackRef = React.useRef<HTMLDivElement>(null);
  const railRef = React.useRef<HTMLDivElement>(null);
  const thumbRef = React.useRef<HTMLDivElement>(null);
  const draggingRef = React.useRef(false);
  const lastCommittedRef = React.useRef<number | null>(null);
  const thumbHoldTimerRef = React.useRef<number | null>(null);
  const thumbHoldOriginRef = React.useRef<{ x: number; y: number } | null>(null);
  const [dragIndex, setDragIndex] = React.useState<number | null>(null);
  const [dragRatio, setDragRatio] = React.useState<number | null>(null);
  const [thumbHeld, setThumbHeld] = React.useState(false);

  const clearThumbHoldTimer = React.useCallback(() => {
    if (thumbHoldTimerRef.current === null) return;
    window.clearTimeout(thumbHoldTimerRef.current);
    thumbHoldTimerRef.current = null;
  }, []);

  const resetThumbHold = React.useCallback(() => {
    clearThumbHoldTimer();
    thumbHoldOriginRef.current = null;
    setThumbHeld(false);
  }, [clearThumbHoldTimer]);

  const isPointInsideThumb = React.useCallback((clientX: number, clientY: number) => {
    const thumb = thumbRef.current;
    if (!thumb) return false;
    const rect = thumb.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const radius = Math.min(rect.width, rect.height) / 2;
    return Math.hypot(clientX - centerX, clientY - centerY) <= radius;
  }, []);

  const stopCount = options.length + 1;
  const maxIndex = Math.max(1, stopCount - 1);
  const optionSignature = options.map((option) => option.value).join('|');
  const previousOptionSignatureRef = React.useRef(optionSignature);

  React.useEffect(() => {
    if (previousOptionSignatureRef.current === optionSignature) return;
    previousOptionSignatureRef.current = optionSignature;
    resetThumbHold();
    draggingRef.current = false;
    lastCommittedRef.current = null;
    setDragIndex(null);
    setDragRatio(null);
  }, [optionSignature, resetThumbHold]);

  React.useEffect(() => () => {
    clearThumbHoldTimer();
  }, [clearThumbHoldTimer]);

  const controlledIndex = React.useMemo(() => {
    if (!enabled || options.length === 0) return 0;
    if (!value) return 1;
    return nearestOptionIndex(options, value) + 1;
  }, [enabled, options, value]);

  const activeDragIndex = previousOptionSignatureRef.current === optionSignature ? dragIndex : null;
  const activeIndex = activeDragIndex ?? controlledIndex;
  const isOff = activeIndex === 0;
  const ratio = activeIndex / maxIndex;
  const visualRatio = dragRatio === null ? ratio : magnetizeRatio(dragRatio, stopCount);

  const labels = React.useMemo(
    () => [offLabel, ...options.map((option) => (resolveOptionLabel ? resolveOptionLabel(option) : option.defaultLabel))],
    [offLabel, options, resolveOptionLabel]
  );
  const activeLabel = labels[activeIndex] ?? offLabel;

  const commitIndex = React.useCallback(
    (index: number) => {
      const clamped = Math.max(0, Math.min(stopCount - 1, index));
      if (clamped === 0) {
        onChange('off');
        return;
      }
      const option = options[clamped - 1];
      if (option) onChange(option.value);
    },
    [onChange, options, stopCount]
  );

  const ratioFromClientX = React.useCallback(
    (clientX: number): number | null => {
      const rail = railRef.current;
      if (!rail) return null;
      const rect = rail.getBoundingClientRect();
      if (rect.width <= 0) return null;
      const thumbInset = Math.min(
        rect.width / 2,
        thumbRef.current?.getBoundingClientRect().width / 2 || 15
      );
      const usableWidth = Math.max(1, rect.width - thumbInset * 2);
      return Math.min(1, Math.max(0, (clientX - rect.left - thumbInset) / usableWidth));
    },
    []
  );

  const moveToClientX = React.useCallback(
    (clientX: number) => {
      const rawRatio = ratioFromClientX(clientX);
      if (rawRatio === null) return;
      setDragRatio(rawRatio);
      const index = Math.round(rawRatio * (stopCount - 1));
      setDragIndex(index);
      if (lastCommittedRef.current !== index) {
        lastCommittedRef.current = index;
        commitIndex(index);
      }
    },
    [commitIndex, ratioFromClientX, stopCount]
  );

  const handlePointerDown = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        trackRef.current?.setPointerCapture(event.pointerId);
      } catch {
        // jsdom / 部分环境不支持 pointer capture
      }
      trackRef.current?.focus({ preventScroll: true });
      draggingRef.current = true;
      lastCommittedRef.current = null;
      resetThumbHold();
      if (isPointInsideThumb(event.clientX, event.clientY)) {
        thumbHoldOriginRef.current = { x: event.clientX, y: event.clientY };
        thumbHoldTimerRef.current = window.setTimeout(() => {
          thumbHoldTimerRef.current = null;
          if (draggingRef.current && thumbHoldOriginRef.current) setThumbHeld(true);
        }, LONG_PRESS_DELAY_MS);
      }
      moveToClientX(event.clientX);
    },
    [isPointInsideThumb, moveToClientX, resetThumbHold]
  );

  const handlePointerMove = React.useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      event.stopPropagation();
      const thumbHoldOrigin = thumbHoldOriginRef.current;
      if (
        thumbHoldTimerRef.current !== null
        && thumbHoldOrigin
        && Math.hypot(event.clientX - thumbHoldOrigin.x, event.clientY - thumbHoldOrigin.y)
          > THUMB_HOLD_MOVE_TOLERANCE_PX
      ) {
        clearThumbHoldTimer();
        thumbHoldOriginRef.current = null;
      }
      moveToClientX(event.clientX);
    },
    [clearThumbHoldTimer, moveToClientX]
  );

  const handlePointerEnd = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    resetThumbHold();
    draggingRef.current = false;
    lastCommittedRef.current = null;
    setDragIndex(null);
    setDragRatio(null);
  }, [resetThumbHold]);

  const handleKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      let next: number | null = null;
      if (event.key === 'ArrowRight' || event.key === 'ArrowUp') next = activeIndex + 1;
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') next = activeIndex - 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = stopCount - 1;
      if (next === null) return;
      event.preventDefault();
      event.stopPropagation();
      const clamped = Math.max(0, Math.min(stopCount - 1, next));
      if (clamped === activeIndex) return;
      commitIndex(clamped);
    },
    [activeIndex, commitIndex, stopCount]
  );

  return (
    <div
      className={cn('tds-root', className)}
      data-off={isOff || undefined}
      data-dragging={dragRatio !== null || undefined}
      data-thumb-held={thumbHeld || undefined}
      data-no-drag
      data-testid="thinking-depth-slider"
      style={{ '--tds-ratio': visualRatio, '--tds-pct': `${visualRatio * 100}%` } as React.CSSProperties}
    >
      <div
        ref={trackRef}
        className="tds-track"
        role="slider"
        tabIndex={0}
        aria-label={ariaLabel}
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={stopCount - 1}
        aria-valuenow={activeIndex}
        aria-valuetext={activeLabel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerEnd}
        onMouseDown={(event) => event.stopPropagation()}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
        onKeyDown={handleKeyDown}
      >
        <div ref={railRef} className="tds-rail">
          <div className="tds-rail-inner">
            <div className="tds-fill" />
            <ThinkingDepthCanvas ratio={visualRatio} />
          </div>
          <div className="tds-range">
            {labels.map((label, index) => (
              <span
                key={`${index}-${label}`}
                className="tds-tick"
                data-lit={!isOff && index < activeIndex ? 'true' : 'false'}
                style={{ left: `${(index / maxIndex) * 100}%` }}
                aria-hidden
              />
            ))}
            <div className="tds-thumb-positioner">
              <div ref={thumbRef} className="tds-thumb">
                <span className="tds-thumb-core" />
              </div>
            </div>
          </div>
        </div>
      </div>
      {thumbHeld && (
        <div className="tds-drag-label-slot" aria-hidden="true">
          <span className="tds-scale-label tds-scale-label-efficient">{efficientLabel}</span>
          <span className="tds-scale-label tds-scale-label-smart">{smartLabel}</span>
        </div>
      )}
    </div>
  );
};

export default ThinkingDepthSlider;
