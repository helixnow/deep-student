/**
 * 单块槽位：grid span + 错误边界 + data-block-type / data-generative-block。
 * React.memo 只比较 type / props / span / blockId（及决定 span class 的 layoutMode）。
 * `data-generative-block="<type>"` 是 18 种块的稳定选择器（未知/校验失败块同样挂上）。
 */
import React from 'react';
import { layoutSpanClassName } from '../schema';
import type { GenerativeLayoutMode, GenerativeLayoutUnit } from '../types';
import { GenerativeUIErrorBoundary } from './GenerativeUIErrorBoundary';

export interface GenerativeBlockSlotProps {
  type: string;
  props?: Record<string, unknown>;
  span?: GenerativeLayoutUnit;
  layoutMode: GenerativeLayoutMode;
  blockId?: string;
  children: React.ReactNode;
}

function shallowEqualProps(
  a?: Record<string, unknown>,
  b?: Record<string, unknown>,
): boolean {
  if (a === b) return true;
  const aKeys = a ? Object.keys(a) : [];
  const bKeys = b ? Object.keys(b) : [];
  if (aKeys.length !== bKeys.length) return false;
  if (!a || !b) return aKeys.length === 0 && bKeys.length === 0;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!Object.is(a[key], b[key])) return false;
  }
  return true;
}

/** 供测试与 memo 共用：type + props + span + blockId（layoutMode 影响 span class） */
export function areGenerativeBlockSlotPropsEqual(
  prev: GenerativeBlockSlotProps,
  next: GenerativeBlockSlotProps,
): boolean {
  return (
    prev.type === next.type &&
    prev.span === next.span &&
    prev.layoutMode === next.layoutMode &&
    prev.blockId === next.blockId &&
    shallowEqualProps(prev.props, next.props)
  );
}

function GenerativeBlockSlotInner({
  type,
  span,
  layoutMode,
  blockId,
  children,
}: GenerativeBlockSlotProps) {
  const spanClass = layoutSpanClassName(layoutMode, span);
  return (
    <div
      className={spanClass}
      data-layout-span={span}
      data-block-type={type}
      data-generative-block={type}
      data-block-id={typeof blockId === 'string' && blockId.length > 0 ? blockId : undefined}
    >
      <GenerativeUIErrorBoundary resetKey={type}>{children}</GenerativeUIErrorBoundary>
    </div>
  );
}

export const GenerativeBlockSlot = React.memo(
  GenerativeBlockSlotInner,
  areGenerativeBlockSlotPropsEqual,
);

GenerativeBlockSlot.displayName = 'GenerativeBlockSlot';
