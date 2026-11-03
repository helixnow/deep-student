import React, { lazy, Suspense, useCallback, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { CircleNotch } from '@phosphor-icons/react';
import { dispatchAppEvent, APP_EVENTS } from '@/events';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { getErrorMessage } from '@/utils/errorUtils';
import { useReferenceToChat } from '@/features/learning-hub';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/utils/cn';
import { renderInkSnapshot } from './api';
import type { InkEditorProps } from './InkEditor';

const InkEditor = lazy(() => import('./InkEditor').then(({ InkEditor: component }) => ({ default: component })));

export function LazyInkEditor({ onAskAi, onExport, ...props }: InkEditorProps) {
  const { t } = useTranslation(['dstu', 'ink']);
  const { referenceToChat } = useReferenceToChat();
  const [exportFormat, setExportFormat] = useState<'png' | 'pdf'>('png');

  const handleAskAi = useCallback(async (documentId: string, pageId: string, revision: string) => {
    try {
      const artifact = await renderInkSnapshot({
        document_id: documentId,
        expected_revision: revision,
        page_id: pageId,
      });
      await referenceToChat({
        sourceType: 'image',
        sourceId: artifact.file_id,
        metadata: {
          title: `${documentId}-${pageId}.png`,
          mimeType: 'image/png',
          width: artifact.width_px,
          height: artifact.height_px,
        },
      });
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [referenceToChat]);

  const handleExport = useCallback(async (documentId: string, pageId: string, revision: string) => {
    try {
      const document = await invoke<{ pages: Array<{ page_id: string }> }>('vfs_ink_get', {
        request: { document_id: documentId },
      });
      const pageIds = exportFormat === 'pdf'
        ? document.pages.map((page) => page.page_id)
        : [pageId];
      const artifact = await invoke<{ file_id: string }>('vfs_ink_export', {
        request: {
          document_id: documentId,
          expected_revision: revision,
          page_ids: pageIds,
          format: exportFormat,
          operation_id: crypto.randomUUID(),
        },
      });
      dispatchAppEvent(APP_EVENTS.LEARNING_HUB_OPEN_RESOURCE, { dstuPath: `/${artifact.file_id}` });
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [exportFormat]);


  return (
    <Suspense fallback={
      <div className="flex h-full items-center justify-center gap-2" role="status">
        <CircleNotch size={20} className="animate-spin text-muted-foreground" aria-hidden="true" />
        <span>{t('preview.loading')}</span>
      </div>
    }>
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex items-center gap-2 border-b border-border/50 px-2 py-1">
          <DsButton size="sm" variant={exportFormat === 'png' ? 'outline' : 'ghost'} aria-pressed={exportFormat === 'png'} onClick={() => setExportFormat('png')}>PNG</DsButton>
          <DsButton size="sm" variant={exportFormat === 'pdf' ? 'outline' : 'ghost'} aria-pressed={exportFormat === 'pdf'} onClick={() => setExportFormat('pdf')}>PDF</DsButton>
        </div>
        <InkEditor
          {...props}
          className={cn('min-h-0 flex-1', props.className)}
          onAskAi={onAskAi ?? handleAskAi}
          onExport={onExport ?? handleExport}
        />
      </div>
    </Suspense>
  );
}
