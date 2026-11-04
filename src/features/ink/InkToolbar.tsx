import React from 'react';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CaretLeft,
  CaretRight,
  Eraser,
  HandPalm,
  Highlighter,
  Minus,
  PenNib,
  Plus,
  Polygon,
  Selection,
  SlidersHorizontal,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shad/Popover';
import { Sheet, SheetContent, SheetTrigger } from '@/components/ui/shad/Sheet';
import { useIsMobile } from '@/hooks/useBreakpoint';
import { cn } from '@/lib/utils';
import type { InkRuling } from './types';
import type { InkSelectionMode } from './InkPageView';
import type { InkSaveStatus } from './useInkDocument';
import {
  INK_COLOR_PRESETS,
  INK_ERASER_SIZES,
  INK_ERASER_SIZE_MAX,
  INK_ERASER_SIZE_MIN,
  inkWidthBounds,
  normalizeHexColor,
  widthPresetsFor,
  type InkToolName,
} from './toolSettings';

export interface InkToolbarProps {
  status: InkSaveStatus;
  pageIndex: number;
  pageCount: number;
  pageTitle: string;
  canUndo: boolean;
  canRedo: boolean;
  tool: InkToolName;
  color: string;
  width: number;
  opacity: number;
  eraserSize: number;
  erasing: boolean;
  touchDrawing: boolean;
  zoom: number;
  selectionMode: InkSelectionMode;
  selectionActive: boolean;
  selectionCanCopy: boolean;
  renameValue: string;
  onRenameValue(value: string): void;
  onReloadRemote(): void;
  onKeepDraft(): void;
  onRetrySave(): void;
  onRetryStorage(): void;
  onAskAi?(): void;
  onExport?(): void;
  exportControls?: React.ReactNode;
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
  onPreviousPage(): void;
  onNextPage(): void;
  onAppendPage(ruling: InkRuling): void;
  onRename(): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onPanLeft(): void;
  onPanRight(): void;
  onPanUp(): void;
  onPanDown(): void;
  onToggleTouchDrawing(): void;
  translate(key: string): string;
}

function useEditableField(value: string) {
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(value);
  const displayed = editing ? draft : value;
  return {
    value: displayed,
    begin: React.useCallback(() => {
      setEditing(true);
      setDraft(value);
    }, [value]),
    change: React.useCallback((next: string) => {
      setEditing(true);
      setDraft(next);
    }, []),
    end: React.useCallback((nextValue: string = value) => {
      setEditing(false);
      setDraft(nextValue);
    }, [value]),
  };
}

function parseNumericInput(value: string): number {
  return value.trim() === '' ? Number.NaN : Number(value);
}

const QUICK_COLOR_PRESETS = INK_COLOR_PRESETS.filter((preset) => Boolean(preset.legacyTestId));
const toolButtonClass = 'min-h-11 min-w-11 aria-pressed:bg-accent aria-pressed:text-accent-foreground';

export function InkToolbar({
  status, pageIndex, pageCount, pageTitle, canUndo, canRedo, tool, color, width, opacity, eraserSize,
  erasing, touchDrawing, zoom, selectionMode, selectionActive, selectionCanCopy,
  renameValue, onRenameValue, onReloadRemote, onKeepDraft, onRetrySave, onRetryStorage, onAskAi, onExport, exportControls,
  onSelectSelectionMode, onSelectionAskAi, onSelectionCopy, onSelectionPaste,
  onSelectTool, onSelectColor, onSelectWidth, onSelectOpacity, onSelectEraserSize,
  onToggleEraser, onUndo, onRedo, onPreviousPage, onNextPage, onAppendPage, onRename, onZoomIn, onZoomOut,
  onPanLeft, onPanRight, onPanUp, onPanDown, onToggleTouchDrawing, translate,
}: InkToolbarProps) {
  const colorField = useEditableField(color);
  const widthField = useEditableField(String(width));
  const opacityField = useEditableField(String(opacity));
  const eraserSizeField = useEditableField(String(eraserSize));
  const widthPresets = widthPresetsFor(tool);
  const quickWidthPresets = widthPresets.filter((preset) => Boolean(preset.legacyTestId));
  const bounds = inkWidthBounds(tool);
  const isMobile = useIsMobile();
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  const settingsPanel = (
    <div data-testid="ink-style-panel" className="flex w-full min-w-0 max-w-full flex-col gap-3 overflow-x-hidden">
      <div role="group" aria-label={translate('colors.label')} className="flex w-full min-w-0 flex-wrap gap-2">
        {INK_COLOR_PRESETS.map((preset) => (
          <DsButton
            key={preset.id}
            data-testid={`ink-settings-color-${preset.id}`}
            aria-label={translate(preset.labelKey)}
            aria-pressed={preset.value === color}
            title={translate(preset.labelKey)}
            size="sm"
            iconOnly
            className={cn(
              '!h-[var(--touch-target-size)] !w-[var(--touch-target-size)] !min-h-[var(--touch-target-size)] !min-w-[var(--touch-target-size)] !p-0 relative box-border rounded-full border border-border/60',
              preset.id === 'white' && 'border-border',
            )}
            style={{ backgroundColor: preset.value }}
            onClick={() => onSelectColor(preset.value)}
          >
            <span className="sr-only">{translate(preset.labelKey)}</span>
          </DsButton>
        ))}
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          type="color"
          data-testid="ink-custom-color-picker"
          aria-label={translate('colors.picker')}
          value={color}
          onChange={(event) => onSelectColor(event.target.value)}
          className="h-11 w-11 shrink-0 cursor-pointer rounded border border-border/60 bg-transparent p-0"
        />
        <Input
          data-testid="ink-custom-color"
          aria-label={translate('colors.customHex')}
          value={colorField.value}
          onFocus={colorField.begin}
          onChange={(event) => {
            colorField.change(event.target.value);
            const normalized = normalizeHexColor(event.target.value);
            if (normalized) onSelectColor(normalized);
          }}
          onBlur={() => colorField.end(normalizeHexColor(colorField.value) ?? color)}
          spellCheck={false}
          autoComplete="off"
          className="w-24 max-w-full min-w-0 font-mono text-xs"
        />
      </div>

      <div role="group" aria-label={translate('width.label')} className="flex min-w-0 flex-wrap items-center gap-1">
        {widthPresets.map((preset) => (
          <DsButton
            key={preset.value}
            size="sm"
            data-testid={`ink-settings-width-${preset.value}`}
            aria-pressed={width === preset.value}
            aria-label={`${translate('width.valueLabel')} ${preset.value}`}
            title={`${translate('width.valueLabel')} ${preset.value}`}
            onClick={() => onSelectWidth(preset.value)}
          >
            <span
              aria-hidden
              className="inline-block rounded-full bg-current"
              style={{ width: 14, height: Math.max(1, Math.min(8, preset.value / 3)) }}
            />
            <span className="ml-1 tabular-nums">{preset.value}</span>
          </DsButton>
        ))}
        <Input
          data-testid="ink-width-value"
          type="number"
          inputMode="decimal"
          min={bounds.min}
          max={bounds.max}
          step={0.5}
          aria-label={translate('width.valueLabel')}
          value={widthField.value}
          onFocus={widthField.begin}
          onChange={(event) => {
            widthField.change(event.target.value);
            const parsed = parseNumericInput(event.target.value);
            if (Number.isFinite(parsed)) onSelectWidth(parsed);
          }}
          onBlur={() => widthField.end(String(width))}
          className="w-16 max-w-full min-w-0"
        />
      </div>

      {tool === 'highlighter' && (
        <div role="group" aria-label={translate('opacity.label')} className="flex min-w-0 flex-wrap items-center gap-1">
          <span className="text-muted-foreground">{translate('opacity.valueLabel')}</span>
          <Input
            data-testid="ink-opacity"
            type="number"
            inputMode="decimal"
            min={0.05}
            max={1}
            step={0.05}
            aria-label={translate('opacity.valueLabel')}
            value={opacityField.value}
            onFocus={opacityField.begin}
            onChange={(event) => {
              opacityField.change(event.target.value);
              const parsed = parseNumericInput(event.target.value);
              if (Number.isFinite(parsed)) onSelectOpacity(parsed);
            }}
            onBlur={() => opacityField.end(String(opacity))}
            className="w-16 max-w-full min-w-0"
          />
        </div>
      )}

      <div role="group" aria-label={translate('eraser.label')} className="flex min-w-0 flex-wrap items-center gap-1">
        <span className="text-muted-foreground">{translate('eraser.sizeLabel')}</span>
        <Input
          data-testid="ink-eraser-size"
          type="number"
          inputMode="numeric"
          min={INK_ERASER_SIZE_MIN}
          max={INK_ERASER_SIZE_MAX}
          step={1}
          aria-label={translate('eraser.sizeValue')}
          value={eraserSizeField.value}
          onFocus={eraserSizeField.begin}
          onChange={(event) => {
            eraserSizeField.change(event.target.value);
            const parsed = parseNumericInput(event.target.value);
            if (Number.isFinite(parsed)) onSelectEraserSize(parsed);
          }}
          onBlur={() => eraserSizeField.end(String(eraserSize))}
          className="w-16 max-w-full min-w-0"
        />
        {INK_ERASER_SIZES.map((size) => (
          <DsButton
            key={size}
            size="sm"
            data-testid={`ink-eraser-size-${size}`}
            aria-pressed={eraserSize === size}
            aria-label={`${translate('eraser.sizeValue')} ${size}`}
            onClick={() => onSelectEraserSize(size)}
          >
            {size}
          </DsButton>
        ))}
      </div>
    </div>
  );

  const settingsTrigger = (
    <DsButton
      data-testid="ink-tool-settings"
      aria-haspopup="dialog"
      aria-label={translate('styleSettings.open')}
      title={translate('styleSettings.open')}
      size="sm"
      iconOnly
      className={toolButtonClass}
    >
      <SlidersHorizontal size={20} aria-hidden />
    </DsButton>
  );

  const settingsControl = isMobile ? (
    <Sheet open={settingsOpen} onOpenChange={setSettingsOpen}>
      <SheetTrigger asChild>{settingsTrigger}</SheetTrigger>
      <SheetContent
        side="bottom"
        data-testid="ink-tool-settings-panel"
        aria-label={translate('styleSettings.title')}
        className="!p-0 max-h-[85dvh] overflow-x-hidden overflow-y-auto"
      >
        <div className="p-4 pt-16">{settingsPanel}</div>
      </SheetContent>
    </Sheet>
  ) : (
    <Popover open={settingsOpen} onOpenChange={setSettingsOpen}>
      <PopoverTrigger asChild>{settingsTrigger}</PopoverTrigger>
      <PopoverContent
        data-testid="ink-tool-settings-panel"
        aria-label={translate('styleSettings.title')}
        align="start"
        side="bottom"
        sideOffset={6}
        className="w-[min(92vw,22rem)] max-w-[calc(100vw-1rem)] overflow-x-hidden !p-3"
      >
        {settingsPanel}
      </PopoverContent>
    </Popover>
  );

  return (
    <div data-testid="ink-toolbar" className="z-10 flex w-full min-w-0 max-w-full shrink-0 flex-col border-b border-border/60 bg-background">
      <div className="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain px-2 py-1 [scrollbar-width:thin]" role="toolbar" aria-label={translate('toolbar.label')}>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-tool-pen" aria-label={translate('tools.pen')} title={translate('tools.pen')} aria-pressed={tool === 'pen' && !erasing && selectionMode === 'none'} onClick={() => onSelectTool('pen')}><PenNib size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-tool-highlighter" aria-label={translate('tools.highlighter')} title={translate('tools.highlighter')} aria-pressed={tool === 'highlighter' && !erasing && selectionMode === 'none'} onClick={() => onSelectTool('highlighter')}><Highlighter size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-eraser-tool" aria-label={translate('tools.eraser')} title={translate('tools.eraser')} aria-pressed={erasing} onClick={onToggleEraser}><Eraser size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-undo" aria-label={translate('actions.undo')} title={translate('actions.undo')} disabled={!canUndo} onClick={onUndo}><ArrowCounterClockwise size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-redo" aria-label={translate('actions.redo')} title={translate('actions.redo')} disabled={!canRedo} onClick={onRedo}><ArrowClockwise size={20} aria-hidden /></DsButton>
        {settingsControl}
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-touch-draw-toggle" aria-label={translate(touchDrawing ? 'actions.touchDrawOn' : 'actions.touchDrawOff')} title={translate(touchDrawing ? 'actions.touchDrawOn' : 'actions.touchDrawOff')} aria-pressed={touchDrawing} onClick={onToggleTouchDrawing}><HandPalm size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-select-rectangle" aria-label={translate('actions.selectRectangle')} title={translate('actions.selectRectangle')} aria-pressed={selectionMode === 'rectangle'} onClick={() => onSelectSelectionMode('rectangle')}><Selection size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-select-lasso" aria-label={translate('actions.selectLasso')} title={translate('actions.selectLasso')} aria-pressed={selectionMode === 'lasso'} onClick={() => onSelectSelectionMode('lasso')}><Polygon size={20} aria-hidden /></DsButton>
        {selectionMode !== 'none' && <DsButton size="sm" data-testid="ink-selection-paste" onClick={onSelectionPaste}>{translate('actions.pasteSelection')}</DsButton>}
        {selectionActive && <DsButton size="sm" data-testid="ink-selection-copy" disabled={!selectionCanCopy} onClick={onSelectionCopy}>{translate('actions.copySelection')}</DsButton>}
        {selectionActive && onSelectionAskAi && <DsButton size="sm" data-testid="ink-selection-ask-ai" onClick={onSelectionAskAi}>{translate('actions.askSelectionAi')}</DsButton>}
        <div data-testid="ink-quick-style" className="flex shrink-0 items-center gap-1 border-l border-border/60 pl-2">
          {QUICK_COLOR_PRESETS.map((preset) => (
            <DsButton
              key={preset.id}
              data-testid={preset.legacyTestId}
              aria-label={translate(preset.labelKey)}
              aria-pressed={preset.value === color}
              title={translate(preset.labelKey)}
              size="sm"
              iconOnly
              className={cn(
                '!h-[var(--touch-target-size)] !w-[var(--touch-target-size)] !min-h-[var(--touch-target-size)] !min-w-[var(--touch-target-size)] !p-0 relative box-border rounded-full border border-border/60',
                preset.id === 'white' && 'border-border',
              )}
              style={{ backgroundColor: preset.value }}
              onClick={() => onSelectColor(preset.value)}
            >
              <span className="sr-only">{translate(preset.labelKey)}</span>
            </DsButton>
          ))}
          {quickWidthPresets.map((preset) => (
            <DsButton
              key={preset.value}
              size="sm"
              className="min-h-11 min-w-11"
              data-testid={preset.legacyTestId}
              aria-pressed={width === preset.value}
              aria-label={`${translate('width.valueLabel')} ${preset.value}`}
              title={`${translate('width.valueLabel')} ${preset.value}`}
              onClick={() => onSelectWidth(preset.value)}
            >
              {preset.value}
            </DsButton>
          ))}
        </div>
      </div>

      <div data-testid="ink-page-controls" className="flex min-w-0 items-center gap-1 overflow-x-auto overscroll-x-contain border-t border-border/40 px-2 py-1 [scrollbar-width:thin]">
        <div className="flex w-24 min-w-0 shrink-0 flex-col px-1">
          <span data-testid="ink-editor-title" className="truncate text-xs font-medium" title={pageTitle}>{pageTitle}</span>
          <output data-testid="ink-editor-save-state" data-state={status} className="truncate text-xs text-muted-foreground" title={translate(`status.${status}`)} role={status === 'storage-error' ? 'alert' : 'status'} aria-live={status === 'storage-error' ? 'assertive' : 'polite'}>
            {translate(`status.${status}`)}
          </output>
        </div>
        {status === 'storage-error' && <DsButton size="sm" onClick={onRetryStorage}>{translate('actions.retryStorage')}</DsButton>}
        {(status === 'conflict' || status === 'offline') && <>
          {status === 'conflict' && <DsButton size="sm" onClick={onKeepDraft}>{translate('actions.keepDraft')}</DsButton>}
          {status === 'conflict' ? <DsButton size="sm" onClick={onReloadRemote}>{translate('actions.reloadRemote')}</DsButton>
            : <DsButton size="sm" onClick={onRetrySave}>{translate('actions.retrySave')}</DsButton>}
        </>}
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-page-previous" aria-label={translate('actions.previousPage')} title={translate('actions.previousPage')} disabled={pageIndex <= 0} onClick={onPreviousPage}><CaretLeft size={20} aria-hidden /></DsButton>
        <span data-testid="ink-page-count" className="min-w-8 shrink-0 text-center text-xs tabular-nums">{pageIndex + 1}/{pageCount}</span>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-page-next" aria-label={translate('actions.nextPage')} title={translate('actions.nextPage')} disabled={pageIndex >= pageCount - 1} onClick={onNextPage}><CaretRight size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-page-append" aria-label={translate('actions.appendPage')} title={translate('actions.appendPage')} onClick={() => onAppendPage('blank')}><Plus size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-zoom-out" aria-label={translate('actions.zoomOut')} title={translate('actions.zoomOut')} onClick={onZoomOut}><Minus size={20} aria-hidden /></DsButton>
        <output data-testid="ink-zoom-level" className="min-w-12 shrink-0 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</output>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-zoom-in" aria-label={translate('actions.zoomIn')} title={translate('actions.zoomIn')} onClick={onZoomIn}><Plus size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-pan-left" aria-label={translate('actions.panLeft')} title={translate('actions.panLeft')} onClick={onPanLeft}><ArrowLeft size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-pan-right" aria-label={translate('actions.panRight')} title={translate('actions.panRight')} onClick={onPanRight}><ArrowRight size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-pan-up" aria-label={translate('actions.panUp')} title={translate('actions.panUp')} onClick={onPanUp}><ArrowUp size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={toolButtonClass} data-testid="ink-pan-down" aria-label={translate('actions.panDown')} title={translate('actions.panDown')} onClick={onPanDown}><ArrowDown size={20} aria-hidden /></DsButton>
        <Input data-testid="ink-rename-title" aria-label={translate('actions.rename')} value={renameValue} onChange={(event) => onRenameValue(event.target.value)} className="w-40 min-w-0 shrink-0" />
        <DsButton size="sm" data-testid="ink-rename-submit" onClick={onRename}>{translate('actions.rename')}</DsButton>
        {onAskAi && <DsButton size="sm" data-testid="ink-ask-ai" onClick={onAskAi}>{translate('actions.askAi')}</DsButton>}
        {exportControls}
        {onExport && <DsButton size="sm" data-testid="ink-export" onClick={onExport}>{translate('actions.export')}</DsButton>}
      </div>
    </div>
  );
}
