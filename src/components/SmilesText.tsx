/**
 * SmilesText 组件 - SMILES 分子结构式渲染
 *
 * 按需加载 OpenChemLib 把 SMILES 串渲染为 SVG 骨架式，经 DOMPurify 净化后挂载。
 * 设计约定（docs/dev/chemistry-formula-rendering-support-2026-09-08.md）：
 * - SMILES 走独立字段（不嵌入题干文本），渲染失败不影响内容展示
 * - 渲染失败降级为「名称 + SMILES 文本」，绝不吞掉内容
 */

import React, { useEffect, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { cn } from '@/lib/utils';
import { debugLog } from '@/debug-panel/debugMasterSwitch';

const sanitizeSvg = (svg: string) =>
  DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'foreignObject', 'iframe', 'embed', 'object'],
    FORBID_ATTR: ['xlink:href'],
  });

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
 * 与聊天内联分子式共用按需加载的 OpenChemLib；解析或渲染失败时降级为文本。
 */
export const SmilesText: React.FC<SmilesTextProps> = ({
  smiles,
  caption,
  width = 260,
  height = 180,
  className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    const trimmed = smiles.trim();
    if (!container || !trimmed) return;

    let cancelled = false;
    setFailed(false);
    container.replaceChildren();

    void import('openchemlib')
      .then((ocl: any) => {
        if (cancelled || !containerRef.current) return;
        const molecule = ocl.Molecule.fromSmiles(trimmed);
        if (!molecule || (typeof molecule.getAllAtoms === 'function' && molecule.getAllAtoms() === 0)) {
          throw new Error('Empty SMILES structure');
        }
        const rawSvg = molecule.toSVG(width, height, undefined, {
          autoCrop: true,
          autoCropMargin: 10,
        });
        containerRef.current.innerHTML = sanitizeSvg(rawSvg);
      })
      .catch((error: unknown) => {
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
      <div
        ref={containerRef}
        className="flex items-center justify-center dark:[&_svg]:[filter:invert(0.88)_hue-rotate(180deg)]"
      />
      {caption && (
        <figcaption className="text-xs text-muted-foreground">{caption}</figcaption>
      )}
    </figure>
  );
};

export default SmilesText;
