import React from 'react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  CaretLeft,
  CaretRight,
  Minus,
  Plus,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { InkDrawingToolbar, inkToolButtonClass } from './InkDrawingToolbar';
import type { InkRuling } from './types';
import type { InkSelectionMode } from './InkPageView';
import type { InkSaveStatus } from './useInkDocument';
import type { InkToolName } from './toolSettings';

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

export function InkToolbar({
  status, pageIndex, pageCount, pageTitle, canUndo, canRedo, tool, color, width, opacity, eraserSize,
  erasing, touchDrawing, zoom, selectionMode, selectionActive, selectionCanCopy,
  renameValue, onRenameValue, onReloadRemote, onKeepDraft, onRetrySave, onRetryStorage, onAskAi, onExport, exportControls,
  onSelectSelectionMode, onSelectionAskAi, onSelectionCopy, onSelectionPaste,
  onSelectTool, onSelectColor, onSelectWidth, onSelectOpacity, onSelectEraserSize,
  onToggleEraser, onUndo, onRedo, onPreviousPage, onNextPage, onAppendPage, onRename, onZoomIn, onZoomOut,
  onPanLeft, onPanRight, onPanUp, onPanDown, onToggleTouchDrawing, translate,
}: InkToolbarProps) {
  return (
    <div data-testid="ink-toolbar" className="z-10 flex w-full min-w-0 max-w-full shrink-0 flex-col border-b border-border/60 bg-background">
      <InkDrawingToolbar
        canUndo={canUndo} canRedo={canRedo} tool={tool} color={color} width={width} opacity={opacity}
        eraserSize={eraserSize} erasing={erasing} touchDrawing={touchDrawing}
        selectionMode={selectionMode} selectionActive={selectionActive} selectionCanCopy={selectionCanCopy}
        onSelectSelectionMode={onSelectSelectionMode} onSelectionAskAi={onSelectionAskAi}
        onSelectionCopy={onSelectionCopy} onSelectionPaste={onSelectionPaste}
        onSelectTool={onSelectTool} onSelectColor={onSelectColor} onSelectWidth={onSelectWidth}
        onSelectOpacity={onSelectOpacity} onSelectEraserSize={onSelectEraserSize}
        onToggleEraser={onToggleEraser} onUndo={onUndo} onRedo={onRedo}
        onToggleTouchDrawing={onToggleTouchDrawing} translate={translate}
      />
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
        <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid="ink-page-previous" aria-label={translate('actions.previousPage')} title={translate('actions.previousPage')} disabled={pageIndex <= 0} onClick={onPreviousPage}><CaretLeft size={20} aria-hidden /></DsButton>
        <span data-testid="ink-page-count" className="min-w-8 shrink-0 text-center text-xs tabular-nums">{pageIndex + 1}/{pageCount}</span>
        <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid="ink-page-next" aria-label={translate('actions.nextPage')} title={translate('actions.nextPage')} disabled={pageIndex >= pageCount - 1} onClick={onNextPage}><CaretRight size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid="ink-page-append" aria-label={translate('actions.appendPage')} title={translate('actions.appendPage')} onClick={() => onAppendPage('blank')}><Plus size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid="ink-zoom-out" aria-label={translate('actions.zoomOut')} title={translate('actions.zoomOut')} onClick={onZoomOut}><Minus size={20} aria-hidden /></DsButton>
        <output data-testid="ink-zoom-level" className="min-w-12 shrink-0 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</output>
        <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid="ink-zoom-in" aria-label={translate('actions.zoomIn')} title={translate('actions.zoomIn')} onClick={onZoomIn}><Plus size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid="ink-pan-left" aria-label={translate('actions.panLeft')} title={translate('actions.panLeft')} onClick={onPanLeft}><ArrowLeft size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid="ink-pan-right" aria-label={translate('actions.panRight')} title={translate('actions.panRight')} onClick={onPanRight}><ArrowRight size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid="ink-pan-up" aria-label={translate('actions.panUp')} title={translate('actions.panUp')} onClick={onPanUp}><ArrowUp size={20} aria-hidden /></DsButton>
        <DsButton size="sm" iconOnly className={inkToolButtonClass} data-testid="ink-pan-down" aria-label={translate('actions.panDown')} title={translate('actions.panDown')} onClick={onPanDown}><ArrowDown size={20} aria-hidden /></DsButton>
        <Input data-testid="ink-rename-title" aria-label={translate('actions.rename')} value={renameValue} onChange={(event) => onRenameValue(event.target.value)} className="w-40 min-w-0 shrink-0" />
        <DsButton size="sm" data-testid="ink-rename-submit" onClick={onRename}>{translate('actions.rename')}</DsButton>
        {onAskAi && <DsButton size="sm" data-testid="ink-ask-ai" onClick={onAskAi}>{translate('actions.askAi')}</DsButton>}
        {exportControls}
        {onExport && <DsButton size="sm" data-testid="ink-export" onClick={onExport}>{translate('actions.export')}</DsButton>}
      </div>
    </div>
  );
}
