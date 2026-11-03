import React from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import type { InkRuling } from './types';
import type { InkSaveStatus } from './useInkDocument';

export interface InkToolbarProps {
  status: InkSaveStatus;
  pageIndex: number;
  pageCount: number;
  pageTitle: string;
  canUndo: boolean;
  canRedo: boolean;
  tool: 'pen' | 'highlighter';
  color: 'black' | 'red' | 'blue';
  width: 'small' | 'medium' | 'large';
  erasing: boolean;
  touchDrawing: boolean;
  zoom: number;
  renameValue: string;
  onRenameValue(value: string): void;
  onReloadRemote(): void;
  onKeepDraft(): void;
  onRetrySave(): void;
  onRetryStorage(): void;
  onAskAi?(): void;
  onExport?(): void;
  onSelectTool(tool: 'pen' | 'highlighter'): void;
  onSelectColor(color: 'black' | 'red' | 'blue'): void;
  onSelectWidth(width: 'small' | 'medium' | 'large'): void;
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
  status, pageIndex, pageCount, pageTitle, canUndo, canRedo, tool, color, width, erasing, touchDrawing, zoom,
  renameValue, onRenameValue, onReloadRemote, onKeepDraft, onRetrySave, onRetryStorage, onAskAi, onExport, onSelectTool, onSelectColor, onSelectWidth,
  onToggleEraser, onUndo, onRedo, onPreviousPage, onNextPage, onAppendPage, onRename, onZoomIn, onZoomOut,
  onPanLeft, onPanRight, onPanUp, onPanDown, onToggleTouchDrawing, translate,
}: InkToolbarProps) {
  return (
    <div className="flex flex-wrap items-center gap-1" role="toolbar" aria-label={translate('toolbar.label')}>
      <output data-testid="ink-editor-save-state" data-state={status} role={status === 'storage-error' ? 'alert' : 'status'} aria-live={status === 'storage-error' ? 'assertive' : 'polite'}>
        {translate(`status.${status}`)}
      </output>
      <span data-testid="ink-editor-title">{pageTitle}</span>
      <DsButton data-testid="ink-tool-pen" aria-pressed={tool === 'pen'} onClick={() => onSelectTool('pen')}>{translate('tools.pen')}</DsButton>
      <DsButton data-testid="ink-tool-highlighter" aria-pressed={tool === 'highlighter'} onClick={() => onSelectTool('highlighter')}>{translate('tools.highlighter')}</DsButton>
      <DsButton data-testid="ink-color-black" aria-pressed={color === 'black'} onClick={() => onSelectColor('black')}>{translate('colors.black')}</DsButton>
      <DsButton data-testid="ink-color-red" aria-pressed={color === 'red'} onClick={() => onSelectColor('red')}>{translate('colors.red')}</DsButton>
      <DsButton data-testid="ink-color-blue" aria-pressed={color === 'blue'} onClick={() => onSelectColor('blue')}>{translate('colors.blue')}</DsButton>
      <DsButton data-testid="ink-width-small" aria-pressed={width === 'small'} onClick={() => onSelectWidth('small')}>{translate('width.small')}</DsButton>
      <DsButton data-testid="ink-width-medium" aria-pressed={width === 'medium'} onClick={() => onSelectWidth('medium')}>{translate('width.medium')}</DsButton>
      <DsButton data-testid="ink-width-large" aria-pressed={width === 'large'} onClick={() => onSelectWidth('large')}>{translate('width.large')}</DsButton>
      <DsButton data-testid="ink-eraser-tool" aria-pressed={erasing} onClick={onToggleEraser}>{translate('tools.eraser')}</DsButton>
      <DsButton data-testid="ink-undo" disabled={!canUndo} onClick={onUndo}>{translate('actions.undo')}</DsButton>
      <DsButton data-testid="ink-redo" disabled={!canRedo} onClick={onRedo}>{translate('actions.redo')}</DsButton>
      <DsButton data-testid="ink-page-previous" disabled={pageIndex <= 0} onClick={onPreviousPage}>{translate('actions.previousPage')}</DsButton>
      <span data-testid="ink-page-count">{pageIndex + 1}/{pageCount}</span>
      <DsButton data-testid="ink-page-next" disabled={pageIndex >= pageCount - 1} onClick={onNextPage}>{translate('actions.nextPage')}</DsButton>
      <DsButton data-testid="ink-page-append" onClick={() => onAppendPage('blank')}>{translate('actions.appendPage')}</DsButton>
      <Input data-testid="ink-rename-title" aria-label={translate('actions.rename')} value={renameValue} onChange={(event) => onRenameValue(event.target.value)} />
      <DsButton data-testid="ink-rename-submit" onClick={onRename}>{translate('actions.rename')}</DsButton>
      <DsButton data-testid="ink-zoom-out" onClick={onZoomOut}>{translate('actions.zoomOut')}</DsButton>
      <output data-testid="ink-zoom-level">{Math.round(zoom * 100)}%</output>
      <DsButton data-testid="ink-zoom-in" onClick={onZoomIn}>{translate('actions.zoomIn')}</DsButton>
      <DsButton data-testid="ink-pan-left" onClick={onPanLeft}>{translate('actions.panLeft')}</DsButton>
      <DsButton data-testid="ink-pan-right" onClick={onPanRight}>{translate('actions.panRight')}</DsButton>
      <DsButton data-testid="ink-pan-up" onClick={onPanUp}>{translate('actions.panUp')}</DsButton>
      <DsButton data-testid="ink-pan-down" onClick={onPanDown}>{translate('actions.panDown')}</DsButton>
      <DsButton data-testid="ink-touch-draw-toggle" aria-pressed={touchDrawing} onClick={onToggleTouchDrawing}>{translate(touchDrawing ? 'actions.touchDrawOn' : 'actions.touchDrawOff')}</DsButton>
      <DsButton data-testid="ink-ask-ai" onClick={onAskAi}>{translate('actions.askAi')}</DsButton>
      <DsButton data-testid="ink-export" onClick={onExport}>{translate('actions.export')}</DsButton>
      {status === 'storage-error' && <DsButton size="sm" onClick={onRetryStorage}>{translate('actions.retryStorage')}</DsButton>}
      {(status === 'conflict' || status === 'offline') && <>
        {status === 'conflict' && <DsButton size="sm" onClick={onKeepDraft}>{translate('actions.keepDraft')}</DsButton>}
        {status === 'conflict' ? <DsButton size="sm" onClick={onReloadRemote}>{translate('actions.reloadRemote')}</DsButton>
          : <DsButton size="sm" onClick={onRetrySave}>{translate('actions.retrySave')}</DsButton>}
      </>}
    </div>
  );
}
