import React from 'react';
import { useTranslation } from 'react-i18next';
import { useWindowStore } from '../core/windowStore';
import {
  computeTiledFrame,
  MAX_TILING_RATIO,
  MIN_TILING_RATIO,
} from '../core/tiling';
import { useTilingDivider } from './window-shell/useTilingDivider';
import { getWorkbenchDesktopOffset } from './window-shell/workbenchPointerAdapter';

export const TilingDivider: React.FC<{ leftId: string; rightId: string; margin: number }> = ({
  leftId,
  rightId,
  margin,
}) => {
  const { t } = useTranslation('workbench');
  const divider = useTilingDivider(leftId, rightId, {
    margin,
    // ANTI-REGRESSION：与窗口拖拽共用缓存快照，禁止在此 getBoundingClientRect。
    getDesktopOffset: getWorkbenchDesktopOffset,
  });
  const desktopSize = useWindowStore((s) => s.desktopSize);
  const leftWin = useWindowStore((s) => s.windows[leftId]);
  const rightWin = useWindowStore((s) => s.windows[rightId]);
  const pairMaxZ = Math.max(leftWin?.zIndex ?? 10, rightWin?.zIndex ?? 10);
  const occluded = useWindowStore((s) =>
    Object.values(s.windows).some(
      (w) =>
        !w.minimized &&
        w.id !== leftId &&
        w.id !== rightId &&
        (w.zIndex > pairMaxZ || w.displayMode === 'maximized'),
    ),
  );
  const leftFrame = computeTiledFrame('tiled-left', { desktopSize, margin, ratio: divider.ratio });
  if (!leftFrame) return null;
  const centerX = leftFrame.x + leftFrame.w + margin / 2;
  const valueNow = Math.round(divider.ratio * 100);
  return (
    <div
      data-wb-tiling-divider
      role="separator"
      aria-orientation="vertical"
      aria-label={t('a11y.tilingDivider')}
      aria-valuemin={Math.round(MIN_TILING_RATIO * 100)}
      aria-valuemax={Math.round(MAX_TILING_RATIO * 100)}
      aria-valuenow={valueNow}
      aria-hidden={occluded || undefined}
      tabIndex={occluded ? -1 : 0}
      onPointerDown={divider.onPointerDown}
      onKeyDown={divider.onKeyDown}
      style={{
        position: 'absolute',
        left: centerX - 4,
        top: 0,
        bottom: 0,
        width: 8,
        cursor: 'col-resize',
        zIndex: pairMaxZ,
        touchAction: 'none',
        pointerEvents: occluded ? 'none' : 'auto',
      }}
    />
  );
};
