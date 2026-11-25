import React from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { useWindowStore } from '../core/windowStore';
import { recomputeLifecycles } from '../core/scheduler';
import {
  clampTilingRatio,
  computeTiledFrame,
  MAX_TILING_RATIO,
  MIN_TILING_RATIO,
  tilingPairKey,
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
  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      e.preventDefault();
      e.stopPropagation();
      const delta = e.key === 'ArrowRight' ? 0.08 : -0.08;
      const store = useWindowStore.getState();
      const pairKey = tilingPairKey(leftId, rightId);
      const ratioKey =
        store.tilingRatios[pairKey] !== undefined
          ? pairKey
          : store.tilingRatios.v !== undefined
            ? 'v'
            : pairKey;
      store.setTilingRatio(ratioKey, clampTilingRatio(divider.ratio + delta));
      return;
    }
    divider.onKeyDown(e);
  };
  const handleRestoreFloating = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const store = useWindowStore.getState();
    if (store.windows[leftId] && store.windows[leftId].displayMode !== 'floating') {
      store.setDisplayMode(leftId, 'floating');
    }
    if (store.windows[rightId] && store.windows[rightId].displayMode !== 'floating') {
      store.setDisplayMode(rightId, 'floating');
    }
    recomputeLifecycles();
  };
  return (
    <div
      data-wb-tiling-divider
      data-split-ratio={valueNow}
      className="flex flex-col items-center justify-center"
      role="separator"
      aria-orientation="vertical"
      aria-label={t('a11y.tilingDivider')}
      aria-valuemin={Math.round(MIN_TILING_RATIO * 100)}
      aria-valuemax={Math.round(MAX_TILING_RATIO * 100)}
      aria-valuenow={valueNow}
      aria-hidden={occluded || undefined}
      tabIndex={occluded ? -1 : 0}
      onPointerDown={divider.onPointerDown}
      onKeyDown={handleKeyDown}
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
    >
      <div
        aria-hidden="true"
        data-testid="wb-tiling-split-indicator"
        className="pointer-events-none flex flex-col items-center gap-1"
      >
        <span className="h-7 w-1 rounded-full bg-border/80 shadow-xs transition-colors" />
        <span className="rounded bg-background/85 px-1 py-0.5 text-2xs font-medium tabular-nums text-muted-foreground shadow-xs backdrop-blur-xs">
          {valueNow}%
        </span>
      </div>
      <DsButton
        type="button"
        variant="ghost"
        size="icon"
        iconOnly
        data-testid="wb-tiling-restore-button"
        tabIndex={occluded ? -1 : 0}
        aria-label={t('a11y.restoreFloating')}
        title={t('a11y.restoreFloating')}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={handleRestoreFloating}
        className="mt-1.5 !h-6 !w-6 !p-0 rounded-full border border-border/60 bg-background/90 text-xs text-muted-foreground shadow-sm backdrop-blur-xs transition-colors hover:bg-accent hover:text-foreground"
        style={{ pointerEvents: occluded ? 'none' : 'auto' }}
      >
        <span aria-hidden="true">◫</span>
      </DsButton>
    </div>
  );
};
