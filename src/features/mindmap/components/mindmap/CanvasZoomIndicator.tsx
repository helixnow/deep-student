/**
 * 画布缩放百分比指示器（画布内控件，非工具栏）。
 *
 * - 实时显示当前缩放（取整百分比，仅百分比变化时重渲染）
 * - 点击恢复 100%（尊重 prefers-reduced-motion：直接就位不做动画）
 * - 须渲染在 <ReactFlow> 子树内（依赖 RF store 读取 transform）
 */
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useReactFlow, useStore } from '@xyflow/react';
import { DsButton } from '@/components/ui/DsButton';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { prefersReducedMotion } from '@/styles/motion-springs';

export const CanvasZoomIndicator: React.FC = () => {
  const { t } = useTranslation('mindmap');
  // 只订阅取整百分比：平移不触发重渲染，缩放也只在整数百分比跳变时更新
  const zoomPercent = useStore((s) => Math.round(s.transform[2] * 100));
  const { zoomTo } = useReactFlow();

  const resetZoom = useCallback(() => {
    zoomTo(1, { duration: prefersReducedMotion() ? 0 : 200 });
  }, [zoomTo]);

  return (
    <CommonTooltip
      content={t('canvasV2.zoomResetTooltip', { defaultValue: '当前缩放；点击恢复 100%' })}
      position="top"
    >
      <DsButton
        variant="ghost"
        size="sm"
        className="mm-canvas-mode-button mm-canvas-zoom-indicator"
        onClick={resetZoom}
        aria-label={t('canvasV2.zoomLevel', {
          defaultValue: '缩放 {{percent}}%，点击恢复 100%',
          percent: zoomPercent,
        })}
      >
        <span>{zoomPercent}%</span>
      </DsButton>
    </CommonTooltip>
  );
};
