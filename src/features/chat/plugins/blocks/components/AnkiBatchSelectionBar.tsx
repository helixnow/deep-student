/**
 * Chat V2 - Anki 卡片块多选批量操作条子组件
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { DownloadSimple, FloppyDisk, Trash } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { PulseDot } from '@/components/ui/PulseDot';

export interface AnkiBatchSelectionBarProps {
  selectedCount: number;
  batchAction: 'save' | 'export' | null;
  isGenerating: boolean;
  onInvertSelection: () => void;
  onDeleteSelected: () => void;
  onSaveSelected: () => void;
  onExportSelected: () => void;
}

export const AnkiBatchSelectionBar: React.FC<AnkiBatchSelectionBarProps> = ({
  selectedCount,
  batchAction,
  isGenerating,
  onInvertSelection,
  onDeleteSelected,
  onSaveSelected,
  onExportSelected,
}) => {
  const { t } = useTranslation('chatV2');

  if (selectedCount <= 0) return null;

  return (
    <div
      className="ui-drop-in mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border/60 bg-muted/30 px-3 py-2"
      data-testid="chatanki-batch-bar"
    >
      <span className="text-xs font-medium text-foreground">
        {t('blocks.ankiCards.selectedCount', { count: selectedCount })}
      </span>
      <span className="ml-auto flex flex-wrap items-center gap-1">
        <DsButton
          type="button"
          size="sm"
          variant="ghost"
          onClick={onInvertSelection}
          className="min-h-8 text-xs"
        >
          {t('blocks.ankiCards.invertSelection')}
        </DsButton>
        <DsButton
          type="button"
          size="sm"
          variant="ghost"
          onClick={onDeleteSelected}
          disabled={batchAction !== null}
          className="min-h-8 text-xs text-destructive hover:text-destructive"
        >
          <Trash size={13} />
          {t('blocks.ankiCards.deleteSelected')}
        </DsButton>
        <DsButton
          type="button"
          size="sm"
          variant="ghost"
          onClick={onSaveSelected}
          disabled={batchAction !== null || isGenerating}
          aria-busy={batchAction === 'save'}
          className="min-h-8 text-xs"
        >
          {batchAction === 'save' ? (
            <PulseDot className="h-1.5 w-1.5 text-current" />
          ) : (
            <FloppyDisk size={13} />
          )}
          {t('blocks.ankiCards.saveSelected')}
        </DsButton>
        <DsButton
          type="button"
          size="sm"
          variant="ghost"
          onClick={onExportSelected}
          disabled={batchAction !== null || isGenerating}
          aria-busy={batchAction === 'export'}
          className="min-h-8 text-xs"
        >
          {batchAction === 'export' ? (
            <PulseDot className="h-1.5 w-1.5 text-current" />
          ) : (
            <DownloadSimple size={13} />
          )}
          {t('blocks.ankiCards.exportSelected')}
        </DsButton>
      </span>
    </div>
  );
};
