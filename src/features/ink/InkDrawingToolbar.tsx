import React from 'react';
import {
  ArrowClockwise, ArrowCounterClockwise, Eraser, HandPalm, Highlighter,
  PenNib, Polygon, Selection, SlidersHorizontal,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/shad/Sheet';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { cn } from '@/lib/utils';
import { InkDiagnosticsControls } from './InkDiagnosticsControls';
import type { InkSelectionMode } from './InkPageView';
import {
  INK_COLOR_PRESETS, INK_ERASER_SIZES, INK_ERASER_SIZE_MAX, INK_ERASER_SIZE_MIN,
  inkWidthBounds, normalizeHexColor, widthPresetsFor, type InkToolName,
} from './toolSettings';

export interface InkDrawingToolbarProps {
  variant?: 'paged' | 'board';
  canUndo: boolean;
  canRedo: boolean;
  tool: InkToolName;
  color: string;
  width: number;
  opacity: number;
  eraserSize: number;
  erasing: boolean;
  touchDrawing: boolean;
  selectionMode: InkSelectionMode;
  selectionActive: boolean;
  selectionCanCopy: boolean;
  onSelectSelectionMode(mode: InkSelectionMode): void;
  onSelectionAskAi?(): void;
  onSelectionCopy?(): void;
  onSelectionPaste?(): void;
  onSelectTool(tool: InkToolName): void;
  onSelectColor(color: string): void;
  onSelectWidth(width: number): void;
  onSelectOpacity(opacity: number): void;
  onSelectEraserSize(size: number): void;
  onToggleEraser(): void;
  onUndo(): void;
  onRedo(): void;
  onToggleTouchDrawing(): void;
  translate(key: string): string;
}

function useEditableField(value: string) {
  const [draft, setDraft] = React.useState<string | null>(null);
  return {
    value: draft ?? value,
    change: setDraft,
    end: () => setDraft(null),
  };
}

const parseNumericInput = (value: string) => value.trim() === '' ? Number.NaN : Number(value);
export const inkToolButtonClass = 'min-h-[var(--touch-target-size)] min-w-[var(--touch-target-size)] aria-pressed:bg-accent aria-pressed:text-accent-foreground';
const colorButtonClass = '!h-[var(--touch-target-size)] !w-[var(--touch-target-size)] !min-h-[var(--touch-target-size)] !min-w-[var(--touch-target-size)] !p-0 relative box-border rounded-full border border-border/60';

export function InkDrawingToolbar({
  variant = 'paged', canUndo, canRedo, tool, color, width, opacity, eraserSize,
  erasing, touchDrawing, selectionMode, selectionActive, selectionCanCopy,
  onSelectSelectionMode, onSelectionAskAi, onSelectionCopy, onSelectionPaste,
  onSelectTool, onSelectColor, onSelectWidth, onSelectOpacity, onSelectEraserSize,
  onToggleEraser, onUndo, onRedo, onToggleTouchDrawing, translate,
}: InkDrawingToolbarProps) {
  const board = variant === 'board';
  const id = (name: string) => `${board ? 'ink-board' : 'ink'}-${name}`;
  const colorField = useEditableField(color);
  const widthField = useEditableField(String(width));
  const opacityField = useEditableField(String(opacity));
  const eraserSizeField = useEditableField(String(eraserSize));
  const widthPresets = widthPresetsFor(tool);
  const bounds = inkWidthBounds(tool);
  const isMobile = useIsMobile();
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  const settingsPanel = (
    <div data-testid={id('style-panel')} className="flex w-full min-w-0 max-w-full flex-col gap-3 overflow-x-hidden">
      <div role="group" aria-label={translate('colors.label')} className="flex w-full min-w-0 flex-wrap gap-2">
        {INK_COLOR_PRESETS.map((preset) => (
          <DsButton key={preset.id} data-testid={board ? id(`color-${preset.id}`) : id(`settings-color-${preset.id}`)}
            aria-label={translate(preset.labelKey)} aria-pressed={preset.value === color} title={translate(preset.labelKey)}
            size="sm" iconOnly className={cn(colorButtonClass, preset.id === 'white' && 'border-border')}
            style={{ backgroundColor: preset.value }} onClick={() => onSelectColor(preset.value)}>
            <span className="sr-only">{translate(preset.labelKey)}</span>
          </DsButton>
        ))}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input type="color" data-testid={id('custom-color-picker')} aria-label={translate('colors.picker')}
          value={color} onChange={(event) => onSelectColor(event.target.value)}
          className="h-11 w-11 shrink-0 cursor-pointer rounded border border-border/60 bg-transparent p-0" />
        <Input data-testid={id('custom-color')} aria-label={translate('colors.customHex')} value={colorField.value}
          onChange={(event) => {
            colorField.change(event.target.value);
            const normalized = normalizeHexColor(event.target.value);
            if (normalized) onSelectColor(normalized);
          }} onBlur={colorField.end}
          spellCheck={false} autoComplete="off" className="w-24 max-w-full min-w-0 font-mono text-xs" />
      </div>
      <div role="group" aria-label={translate('width.label')} className="flex min-w-0 flex-wrap items-center gap-1">
        {widthPresets.map((preset) => (
          <DsButton key={preset.value} size="sm" data-testid={board ? id(`width-${preset.value}`) : id(`settings-width-${preset.value}`)}
            aria-pressed={width === preset.value} aria-label={`${translate('width.valueLabel')} ${preset.value}`}
            title={`${translate('width.valueLabel')} ${preset.value}`} onClick={() => onSelectWidth(preset.value)}>
            <span aria-hidden className="inline-block rounded-full bg-current" style={{ width: 14, height: Math.max(1, Math.min(8, preset.value / 3)) }} />
            <span className="ml-1 tabular-nums">{preset.value}</span>
          </DsButton>
        ))}
        <Input data-testid={id('width-value')} type="number" inputMode="decimal" min={bounds.min} max={bounds.max} step={0.5}
          aria-label={translate('width.valueLabel')} value={widthField.value}
          onChange={(event) => {
            widthField.change(event.target.value);
            const parsed = parseNumericInput(event.target.value);
            if (Number.isFinite(parsed)) onSelectWidth(parsed);
          }} onBlur={widthField.end} className="w-16 max-w-full min-w-0" />
      </div>
      {tool === 'highlighter' && (
        <div role="group" aria-label={translate('opacity.label')} className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="text-muted-foreground">{translate('opacity.valueLabel')}</span>
          <Input data-testid={id('opacity')} type="number" inputMode="decimal" min={0.05} max={1} step={0.05}
            aria-label={translate('opacity.valueLabel')} value={opacityField.value}
            onChange={(event) => {
              opacityField.change(event.target.value);
              const parsed = parseNumericInput(event.target.value);
              if (Number.isFinite(parsed)) onSelectOpacity(parsed);
            }} onBlur={opacityField.end} className="w-16 max-w-full min-w-0" />
        </div>
      )}
      <div role="group" aria-label={translate('eraser.label')} className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="text-muted-foreground">{translate('eraser.sizeLabel')}</span>
        <Input data-testid={id('eraser-size')} type="number" inputMode="numeric" min={INK_ERASER_SIZE_MIN} max={INK_ERASER_SIZE_MAX} step={1}
          aria-label={translate('eraser.sizeValue')} value={eraserSizeField.value}
          onChange={(event) => {
            eraserSizeField.change(event.target.value);
            const parsed = parseNumericInput(event.target.value);
            if (Number.isFinite(parsed)) onSelectEraserSize(parsed);
          }} onBlur={eraserSizeField.end} className="w-16 max-w-full min-w-0" />
        {INK_ERASER_SIZES.map((size) => (
          <DsButton key={size} size="sm" data-testid={id(`eraser-size-${size}`)} aria-pressed={eraserSize === size}
            aria-label={`${translate('eraser.sizeValue')} ${size}`} onClick={() => onSelectEraserSize(size)}>{size}</DsButton>
        ))}
      </div>
      <InkDiagnosticsControls />
    </div>
  );
  const settingsTrigger = (
    <DsButton data-testid={board ? id('settings-toggle') : id('tool-settings')} aria-haspopup="dialog"
      aria-expanded={settingsOpen} aria-label={translate('styleSettings.open')} title={translate('styleSettings.open')}
      size="sm" iconOnly className={inkToolButtonClass}><SlidersHorizontal size={20} aria-hidden /></DsButton>
  );
  const panelId = board ? id('settings') : id('tool-settings-panel');
  const settingsControl = isMobile ? (
    <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
      <SheetTrigger asChild>{settingsTrigger}</SheetTrigger>
      <SheetContent side="bottom" data-testid={panelId} aria-label={translate('styleSettings.title')} className="!p-0 max-h-[85dvh] overflow-x-hidden overflow-y-auto">
        <div className="p-4 pt-16">{settingsPanel}</div>
      </SheetContent>
    </Sheet>
  ) : (
    <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
      <PopoverTrigger asChild>{settingsTrigger}</PopoverTrigger>
      <PopoverContent data-testid={panelId} aria-label={translate('styleSettings.title')} align="start" side="bottom" sideOffset={6}
        className="w-[min(92vw,22rem)] max-w-[calc(100vw-1rem)] overflow-x-hidden !p-3">{settingsPanel}</PopoverContent>
    </Popover>
  );

  return (
    <div data-testid={id('drawing-tools')} className="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain px-2 py-1 [scrollbar-width:thin]" role="toolbar" aria-label={translate('toolbar.label')}>
      <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid={id('tool-pen')} aria-label={translate('tools.pen')} title={translate('tools.pen')} aria-pressed={tool === 'pen' && !erasing && selectionMode === 'none'} onClick={() => onSelectTool('pen')}><PenNib size={20} aria-hidden /></DsButton>
      <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid={id('tool-highlighter')} aria-label={translate('tools.highlighter')} title={translate('tools.highlighter')} aria-pressed={tool === 'highlighter' && !erasing && selectionMode === 'none'} onClick={() => onSelectTool('highlighter')}><Highlighter size={20} aria-hidden /></DsButton>
      <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid={id('eraser-tool')} aria-label={translate('tools.eraser')} title={translate('tools.eraser')} aria-pressed={erasing} onClick={onToggleEraser}><Eraser size={20} aria-hidden /></DsButton>
      <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid={id('undo')} aria-label={translate('actions.undo')} title={translate('actions.undo')} disabled={!canUndo} onClick={onUndo}><ArrowCounterClockwise size={20} aria-hidden /></DsButton>
      <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid={id('redo')} aria-label={translate('actions.redo')} title={translate('actions.redo')} disabled={!canRedo} onClick={onRedo}><ArrowClockwise size={20} aria-hidden /></DsButton>
      {settingsControl}
      <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid={id('touch-draw-toggle')} aria-label={translate(touchDrawing ? 'actions.touchDrawOn' : 'actions.touchDrawOff')} title={translate(touchDrawing ? 'actions.touchDrawOn' : 'actions.touchDrawOff')} aria-pressed={touchDrawing} onClick={onToggleTouchDrawing}><HandPalm size={20} aria-hidden /></DsButton>
      <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid={id('select-rectangle')} aria-label={translate('actions.selectRectangle')} title={translate('actions.selectRectangle')} aria-pressed={selectionMode === 'rectangle'} onClick={() => onSelectSelectionMode('rectangle')}><Selection size={20} aria-hidden /></DsButton>
      <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid={id('select-lasso')} aria-label={translate('actions.selectLasso')} title={translate('actions.selectLasso')} aria-pressed={selectionMode === 'lasso'} onClick={() => onSelectSelectionMode('lasso')}><Polygon size={20} aria-hidden /></DsButton>
      {(board || selectionMode !== 'none') && <DsButton size="sm" data-testid={id('selection-paste')} onClick={onSelectionPaste}>{translate('actions.pasteSelection')}</DsButton>}
      {(board || selectionActive) && <DsButton size="sm" data-testid={id('selection-copy')} disabled={!selectionCanCopy} onClick={onSelectionCopy}>{translate('actions.copySelection')}</DsButton>}
      {selectionActive && onSelectionAskAi && <DsButton size="sm" data-testid={id('selection-ask-ai')} onClick={onSelectionAskAi}>{translate('actions.askSelectionAi')}</DsButton>}
      <div data-testid={id('quick-style')} className="flex shrink-0 items-center gap-1 border-l border-border/60 pl-2">
        {INK_COLOR_PRESETS.filter((preset) => preset.legacyTestId).map((preset) => (
          <DsButton key={preset.id} data-testid={board ? id(`quick-color-${preset.id}`) : preset.legacyTestId}
            aria-label={translate(preset.labelKey)} aria-pressed={preset.value === color} title={translate(preset.labelKey)}
            size="sm" iconOnly className={cn(colorButtonClass, preset.id === 'white' && 'border-border')}
            style={{ backgroundColor: preset.value }} onClick={() => onSelectColor(preset.value)}><span className="sr-only">{translate(preset.labelKey)}</span></DsButton>
        ))}
        {widthPresets.filter((preset) => preset.legacyTestId).map((preset) => (
          <DsButton key={preset.value} size="sm" className="min-h-11 min-w-11" data-testid={board ? id(`quick-width-${preset.value}`) : preset.legacyTestId}
            aria-pressed={width === preset.value} aria-label={`${translate('width.valueLabel')} ${preset.value}`}
            title={`${translate('width.valueLabel')} ${preset.value}`} onClick={() => onSelectWidth(preset.value)}>{preset.value}</DsButton>
        ))}
      </div>
    </div>
  );
}
