/**
 * SmilesText 组件 - SMILES 分子结构式渲染
 *
 * 使用 smiles-drawer（本地 npm 依赖）把 SMILES 串渲染为 SVG 骨架式。
 * 设计约定（docs/dev/chemistry-formula-rendering-support-2026-09-08.md）：
 * - SMILES 走独立字段（不嵌入题干文本），渲染失败不影响内容展示
 * - 渲染失败降级为「名称 + SMILES 文本」，绝不吞掉内容
 */

import React, { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

// smiles-drawer 是 UMD/mjs 混合包，类型自带（dist/types）。
// 默认导出为命名空间类 SmilesDrawerNS，其静态成员 SmiDrawer 提供
// draw(smiles, target, theme, onSuccess, onError) —— 失败经回调而非异常。
import SmilesDrawer from 'smiles-drawer';

interface SmilesTextProps {
  smiles: string;
  /** 结构名称/说明（如 "乙醇"），显示在结构图下方 */
  caption?: string;
  /** 画布宽度（px），默认 260 */
  width?: number;
  /** 画布高度（px），默认 180 */
  height?: number;
  className?: string;
}

/**
 * 单条 SMILES → SVG 骨架式渲染。
 * 懒初始化一个 SvgDrawer 实例（复用）；解析失败返回 false 由调用方降级。
 */
export const SmilesText: React.FC<SmilesTextProps> = ({
  smiles,
  caption,
  width = 260,
  height = 180,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const drawerRef = useRef<any>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !smiles.trim()) return;

    let cancelled = false;
    setFailed(false);
    container.innerHTML = '';

    const drawer = new (SmilesDrawer as any).SmiDrawer({
      width,
      height,
      bondThickness: 1.2,
      bondLength: 28,
      shortBondLength: 18,
      padding: 12,
      terminalCarbons: false,
    });
    drawerRef.current = drawer;

    // SmiDrawer.draw：解析/布局失败走 errorCallback 而非抛异常
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    container.appendChild(svg);
    drawer.draw(smiles.trim(), svg, 'light', undefined, (error: unknown) => {
      debugLog.warn('[SmilesText] SMILES 渲染失败，降级为文本:', smiles, error);
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
    };
  }, [smiles, width, height]);

  if (failed) {
    // 降级：显示名称 + SMILES 原文（等宽字体），不丢内容
    return (
      <div className={cn('inline-flex flex-col gap-0.5 rounded-md bg-muted/40 px-2.5 py-1.5', className)}>
        {caption && <span className="text-xs font-medium text-foreground">{caption}</span>}
        <code className="text-xs text-muted-foreground break-all">{smiles}</code>
      </div>
    );
  }

  return (
    <figure className={cn('inline-flex flex-col items-center gap-1', className)}>
      <div ref={containerRef} className="flex items-center justify-center" />
      {caption && (
        <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
      )}
    </figure>
  );
};

export default SmilesText;
