import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpenText,
  Cards,
  CaretDown,
  Columns,
  Notebook,
  SidebarSimple,
  SquaresFour,
} from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { useActiveSpaceContextStore } from '../core/spaceSnapshots';
import {
  applyStudyFlowStagePreset,
  useStagePresetStore,
  type StudyFlowSidecarKind,
  type StudyFlowStagePresetId,
} from '../core/stagePresets';
import './StudyFlowStageSwitcher.css';

// ============================================================================
// Props 定义
// ============================================================================

export interface StudyFlowStageSwitcherProps {
  onOpenChange?: (open: boolean) => void;
}

interface StageItemMeta {
  id: StudyFlowStagePresetId;
  labelKey:
    | 'stagePresets.deepReadingMap'
    | 'stagePresets.noteCocreation'
    | 'stagePresets.practiceCorrection'
    | 'stagePresets.freeformDesktop';
  hintKey:
    | 'stagePresets.deepReadingMapHint'
    | 'stagePresets.noteCocreationHint'
    | 'stagePresets.practiceCorrectionHint'
    | 'stagePresets.freeformDesktopHint';
  Icon: typeof BookOpenText;
}

const COMPACT_VIEWPORT_WIDTH = 960;

const STAGE_ITEMS: readonly StageItemMeta[] = [
  {
    id: 'deep-reading-map',
    labelKey: 'stagePresets.deepReadingMap',
    hintKey: 'stagePresets.deepReadingMapHint',
    Icon: BookOpenText,
  },
  {
    id: 'note-cocreation',
    labelKey: 'stagePresets.noteCocreation',
    hintKey: 'stagePresets.noteCocreationHint',
    Icon: Notebook,
  },
  {
    id: 'practice-correction',
    labelKey: 'stagePresets.practiceCorrection',
    hintKey: 'stagePresets.practiceCorrectionHint',
    Icon: Cards,
  },
  {
    id: 'freeform-desktop',
    labelKey: 'stagePresets.freeformDesktop',
    hintKey: 'stagePresets.freeformDesktopHint',
    Icon: SquaresFour,
  },
] as const;

function readIsCompactViewport(): boolean {
  if (typeof window === 'undefined') return false;
  return window.innerWidth > 0 && window.innerWidth < COMPACT_VIEWPORT_WIDTH;
}

// ============================================================================
// 组件实现
// ============================================================================

export const StudyFlowStageSwitcher: React.FC<StudyFlowStageSwitcherProps> = ({
  onOpenChange,
}) => {
  const { t } = useTranslation('workbench');
  const activeStagePreset = useStagePresetStore((s) => s.activeStagePreset);
  const sidecarMode = useStagePresetStore((s) => s.sidecarMode);
  const spaceContext = useActiveSpaceContextStore((s) => s.context);

  const [isCompact, setIsCompact] = useState<boolean>(readIsCompactViewport);
  const [menuOpen, setMenuOpen] = useState(false);
  const compactWrapRef = useRef<HTMLDivElement | null>(null);

  const updateMenuOpen = useCallback(
    (next: boolean) => {
      setMenuOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const syncViewport = () => {
      const compact = readIsCompactViewport();
      setIsCompact(compact);
      if (!compact) {
        setMenuOpen(false);
        onOpenChange?.(false);
      }
    };
    window.addEventListener('resize', syncViewport);
    return () => {
      window.removeEventListener('resize', syncViewport);
    };
  }, [onOpenChange]);

  useEffect(() => {
    if (!menuOpen) return undefined;
    const handlePointerDown = (event: MouseEvent | PointerEvent) => {
      const target = event.target as Node | null;
      if (target && compactWrapRef.current?.contains(target)) return;
      updateMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        updateMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [menuOpen, updateMenuOpen]);

  const supportsSidecar =
    activeStagePreset === 'deep-reading-map' || activeStagePreset === 'note-cocreation';
  const supportsDualReader = activeStagePreset === 'deep-reading-map';
  const dualReaderActive =
    activeStagePreset === 'deep-reading-map' && sidecarMode === 'dual_reader';
  const sidecarActive =
    (activeStagePreset === 'deep-reading-map' &&
      (sidecarMode === 'chat' || sidecarMode === 'flashcards')) ||
    (activeStagePreset === 'note-cocreation' && sidecarMode === 'flashcards');

  const handleToggleDualReader = useCallback(() => {
    if (!supportsDualReader) return;
    const nextSidecar: StudyFlowSidecarKind = dualReaderActive ? null : 'dual_reader';
    updateMenuOpen(false);
    void applyStudyFlowStagePreset('deep-reading-map', {
      spaceId: spaceContext.spaceId,
      rootFolderId: spaceContext.rootFolderId,
      defaultDeckId: spaceContext.defaultDeckId,
      sidecar: nextSidecar,
    });
  }, [
    dualReaderActive,
    spaceContext.defaultDeckId,
    spaceContext.rootFolderId,
    spaceContext.spaceId,
    supportsDualReader,
    updateMenuOpen,
  ]);

  const handleSelectStage = useCallback(
    (presetId: StudyFlowStagePresetId) => {
      updateMenuOpen(false);
      void applyStudyFlowStagePreset(presetId, {
        spaceId: spaceContext.spaceId,
        rootFolderId: spaceContext.rootFolderId,
        defaultDeckId: spaceContext.defaultDeckId,
      });
    },
    [spaceContext.defaultDeckId, spaceContext.rootFolderId, spaceContext.spaceId, updateMenuOpen],
  );

  const handleToggleSidecar = useCallback(() => {
    if (!supportsSidecar) return;
    const nextSidecar: StudyFlowSidecarKind =
      activeStagePreset === 'deep-reading-map'
        ? sidecarActive
          ? null
          : 'chat'
        : sidecarActive
          ? null
          : 'flashcards';
    updateMenuOpen(false);
    void applyStudyFlowStagePreset(activeStagePreset, {
      spaceId: spaceContext.spaceId,
      rootFolderId: spaceContext.rootFolderId,
      defaultDeckId: spaceContext.defaultDeckId,
      sidecar: nextSidecar,
    });
  }, [
    activeStagePreset,
    sidecarActive,
    spaceContext.defaultDeckId,
    spaceContext.rootFolderId,
    spaceContext.spaceId,
    supportsSidecar,
    updateMenuOpen,
  ]);

  if (isCompact) {
    const currentItem =
      STAGE_ITEMS.find((item) => item.id === activeStagePreset) ?? STAGE_ITEMS[3];
    return (
      <div ref={compactWrapRef} className="wb-stage-compact-wrap">
        <button
          type="button"
          data-testid="wb-stage-compact-trigger"
          aria-label={t('stagePresets.groupLabel')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t(currentItem.hintKey)}
          onClick={() => updateMenuOpen(!menuOpen)}
          className={cn(
            'wb-stage-compact-trigger rounded-full border border-border/35 bg-background/45 px-2.5 backdrop-blur-sm inline-flex items-center gap-1.5 text-[11px] leading-none font-medium text-foreground hover:bg-background/65',
          )}
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
            aria-hidden="true"
          />
          <span>{t(currentItem.labelKey)}</span>
          <CaretDown size={11} className="shrink-0 opacity-75" aria-hidden="true" />
        </button>

        {menuOpen ? (
          <div
            role="menu"
            aria-label={t('stagePresets.groupLabel')}
            data-testid="wb-stage-compact-menu"
            className="wb-stage-compact-menu rounded-xl border border-border/35 bg-popover p-1 text-popover-foreground"
          >
            {STAGE_ITEMS.map((stage) => {
              const isActive = stage.id === activeStagePreset;
              const Icon = stage.Icon;
              return (
                <button
                  key={stage.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={isActive}
                  data-testid={`wb-stage-compact-item-${stage.id}`}
                  title={t(stage.hintKey)}
                  onClick={() => handleSelectStage(stage.id)}
                  className={cn(
                    'wb-stage-compact-item flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] font-medium',
                    isActive
                      ? 'bg-primary/14 text-foreground'
                      : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                  )}
                >
                  {isActive ? (
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                      aria-hidden="true"
                    />
                  ) : (
                    <Icon size={13} className="shrink-0 opacity-80" aria-hidden="true" />
                  )}
                  <span>{t(stage.labelKey)}</span>
                </button>
              );
            })}
            {supportsSidecar ? (
              <div className="mt-1 border-t border-border/35 pt-1">
                {supportsDualReader ? (
                  <button
                    type="button"
                    role="menuitemcheckbox"
                    aria-checked={dualReaderActive}
                    data-testid="wb-stage-compact-dual-reader"
                    onClick={handleToggleDualReader}
                    className={cn(
                      'wb-stage-compact-item flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] font-medium',
                      dualReaderActive
                        ? 'bg-primary/14 text-foreground'
                        : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                    )}
                  >
                    <Columns
                      size={13}
                      weight={dualReaderActive ? 'fill' : 'regular'}
                      className="shrink-0"
                      aria-hidden="true"
                    />
                    <span>{t('stagePresets.toggleDualReader')}</span>
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={sidecarActive}
                  data-testid="wb-stage-compact-sidecar"
                  onClick={handleToggleSidecar}
                  className={cn(
                    'wb-stage-compact-item flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[12px] font-medium',
                    sidecarActive
                      ? 'bg-primary/14 text-foreground'
                      : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground',
                  )}
                >
                  <SidebarSimple
                    size={13}
                    weight={sidecarActive ? 'fill' : 'regular'}
                    className="shrink-0"
                    aria-hidden="true"
                  />
                  <span>{t('stagePresets.toggleSidecar')}</span>
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label={t('stagePresets.groupLabel')}
      data-testid="wb-stage-switcher"
      className={cn(
        'wb-stage-switcher rounded-full border border-border/35 bg-background/45 px-0.5 py-0.5 backdrop-blur-sm inline-flex items-center gap-0.5',
      )}
    >
      {STAGE_ITEMS.map((stage) => {
        const isActive = stage.id === activeStagePreset;
        const Icon = stage.Icon;
        return (
          <button
            key={stage.id}
            type="button"
            data-testid={`wb-stage-preset-${stage.id}`}
            aria-pressed={isActive}
            title={t(stage.hintKey)}
            onClick={() => handleSelectStage(stage.id)}
            className={cn(
              'wb-stage-pill px-2 text-[11px] leading-none font-medium rounded-full inline-flex items-center gap-1.5',
              isActive
                ? 'bg-primary/14 text-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
            )}
          >
            {isActive ? (
              <span
                data-testid={`wb-stage-dot-${stage.id}`}
                className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                aria-hidden="true"
              />
            ) : (
              <Icon size={13} weight="regular" className="shrink-0 opacity-80" aria-hidden="true" />
            )}
            <span>{t(stage.labelKey)}</span>
          </button>
        );
      })}

      {supportsSidecar ? (
        <>
          <span
            className="mx-0.5 h-3 w-0 shrink-0 border-l border-border/35"
            aria-hidden="true"
          />
          {supportsDualReader ? (
            <button
              type="button"
              data-testid="wb-stage-dual-reader-toggle"
              aria-label={t('stagePresets.toggleDualReader')}
              aria-pressed={dualReaderActive}
              title={t('stagePresets.toggleDualReader')}
              onClick={handleToggleDualReader}
              className={cn(
                'wb-stage-sidecar-btn rounded-full inline-flex items-center justify-center',
                dualReaderActive
                  ? 'bg-primary/14 text-primary'
                  : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
              )}
            >
              <Columns
                size={13}
                weight={dualReaderActive ? 'fill' : 'regular'}
                aria-hidden="true"
              />
            </button>
          ) : null}
          <button
            type="button"
            data-testid="wb-stage-sidecar-toggle"
            aria-label={t('stagePresets.toggleSidecar')}
            aria-pressed={sidecarActive}
            title={t('stagePresets.toggleSidecar')}
            onClick={handleToggleSidecar}
            className={cn(
              'wb-stage-sidecar-btn rounded-full inline-flex items-center justify-center',
              sidecarActive
                ? 'bg-primary/14 text-primary'
                : 'text-muted-foreground hover:text-foreground hover:bg-foreground/5',
            )}
          >
            <SidebarSimple
              size={13}
              weight={sidecarActive ? 'fill' : 'regular'}
              aria-hidden="true"
            />
          </button>
        </>
      ) : null}
    </div>
  );
};

export default StudyFlowStageSwitcher;
