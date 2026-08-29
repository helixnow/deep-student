/**
 * 单块槽位：grid span + 错误边界 + data-block-type / data-generative-block。
 * React.memo 比较块内容与影响 children 的外部 renderContext。
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
  /** skip-to-actions 落点；仅第一个可达 ActionBar 槽位使用。 */
  focusTargetId?: string;
  /** 非块 props 的外部渲染依赖（例如 ActionBar handler 注册表）。 */
  renderContext?: unknown;
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

/** 供测试与 memo 共用；children 本身由块内容与 renderContext 决定。 */
export function areGenerativeBlockSlotPropsEqual(
  prev: GenerativeBlockSlotProps,
  next: GenerativeBlockSlotProps,
): boolean {
  return (
    prev.type === next.type &&
    prev.span === next.span &&
    prev.layoutMode === next.layoutMode &&
    prev.blockId === next.blockId &&
    prev.focusTargetId === next.focusTargetId &&
    Object.is(prev.renderContext, next.renderContext) &&
    shallowEqualProps(prev.props, next.props)
  );
}

function GenerativeBlockSlotInner({
  type,
  span,
  layoutMode,
  blockId,
  focusTargetId,
  children,
}: GenerativeBlockSlotProps) {
  const spanClass = layoutSpanClassName(layoutMode, span);
  const skipTarget = typeof focusTargetId === 'string' && focusTargetId.length > 0;
  return (
    <div
      id={skipTarget ? focusTargetId : undefined}
      tabIndex={skipTarget ? -1 : undefined}
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
