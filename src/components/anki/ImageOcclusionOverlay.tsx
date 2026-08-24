/**
 * 图像遮挡卡最小渲染层（Round 4 #5）。
 *
 * 用法：外层容器 `position: relative` 并放置图片，本组件铺满容器，
 * 按 `_occlusion` spec 以百分比定位渲染遮挡矩形（随图片响应式缩放）。
 * 点击矩形揭开（受控/非受控皆可）；已揭开的盒显示答案标签。
 *
 * 刻意不做的事（首版边界）：不加载图片、不做拖拽编辑、不接管复习调度。
 */
import React, { useCallback, useState } from 'react';
import type { OcclusionSpec } from './utils/imageOcclusion';
import { occlusionBoxPercentStyle } from './utils/imageOcclusion';

export interface ImageOcclusionOverlayProps {
  spec: OcclusionSpec;
  /** 已揭开的 cloze 序号集合（受控模式）；缺省时组件内部管理。 */
  revealedIndices?: ReadonlySet<number>;
  /** 揭开某组时回调（同 clozeIndex 的盒作为一组一起揭开，与 Anki 语义一致）。 */
  onReveal?: (clozeIndex: number) => void;
  /** true 时全部揭开（复习「显示答案」阶段）。 */
  revealAll?: boolean;
}

const maskStyle: React.CSSProperties = {
  position: 'absolute',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  backgroundColor: 'rgba(59, 130, 246, 0.92)',
  border: '1.5px solid rgba(29, 78, 216, 0.9)',
  borderRadius: 4,
  cursor: 'pointer',
  overflow: 'hidden',
  padding: 0,
};

const revealedStyle: React.CSSProperties = {
  ...maskStyle,
  backgroundColor: 'rgba(255, 255, 255, 0.85)',
  border: '1.5px dashed rgba(29, 78, 216, 0.6)',
  cursor: 'default',
  color: '#1e3a5f',
  fontSize: 12,
  lineHeight: 1.3,
};

export const ImageOcclusionOverlay: React.FC<ImageOcclusionOverlayProps> = ({
  spec,
  revealedIndices,
  onReveal,
  revealAll = false,
}) => {
  const [internalRevealed, setInternalRevealed] = useState<Set<number>>(new Set());
  const revealed = revealedIndices ?? internalRevealed;

  const handleReveal = useCallback(
    (clozeIndex: number) => {
      if (revealedIndices === undefined) {
        setInternalRevealed((prev) => {
          if (prev.has(clozeIndex)) return prev;
          const next = new Set(prev);
          next.add(clozeIndex);
          return next;
        });
      }
      onReveal?.(clozeIndex);
    },
    [onReveal, revealedIndices],
  );

  return (
    <div
      data-testid="image-occlusion-overlay"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    >
      {spec.boxes.map((box, i) => {
        const isRevealed = revealAll || revealed.has(box.clozeIndex);
        const positionStyle = occlusionBoxPercentStyle(box);
        if (isRevealed) {
          return (
            <div
              key={`${box.clozeIndex}-${i}`}
              data-testid="occlusion-box-revealed"
              style={{ ...revealedStyle, ...positionStyle, pointerEvents: 'auto' }}
            >
              <span>{box.label}</span>
            </div>
          );
        }
        return (
          <button
            key={`${box.clozeIndex}-${i}`}
            type="button"
            data-testid="occlusion-box-masked"
            aria-label={`揭开遮挡区域 ${box.clozeIndex}`}
            style={{ ...maskStyle, ...positionStyle, pointerEvents: 'auto' }}
            onClick={() => handleReveal(box.clozeIndex)}
          />
        );
      })}
    </div>
  );
};

export default ImageOcclusionOverlay;
