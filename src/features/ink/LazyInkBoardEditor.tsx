import React, { lazy, Suspense, useCallback } from 'react';
import { CircleNotch } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { dispatchAppEvent, APP_EVENTS } from '@/events';
import { useReferenceToChat } from '@/features/learning-hub';
import { getErrorMessage } from '@/utils/errorUtils';
import { exportInkDocument, renderInkBoardSnapshot } from './api';
import type { InkBoardCropRequest, InkBoardEditorProps, InkBoardExportRequest } from './InkBoardEditor';

const InkBoardEditorHost = lazy(() => import('./InkBoardEditor').then((module) => ({
  default: module.InkBoardEditor,
})));

/**
 * Lazy entry for schema-v2 `.dsink` documents.
 *
 * AskAI gets the post-flush explicit board-world crop from the editor host and
 * renders through the real `vfs_ink_render` board branch. It references the
 * immutable artifact through the existing Chat flow; it never sends a message
 * or calls a model itself. External `onAskAi` still overrides this handler.
 */
export function LazyInkBoardEditor({
  onAskAi: onAskAiOverride,
  onExport: onExportOverride,
  ...props
}: InkBoardEditorProps) {
  const { t } = useTranslation('ink');
  const { referenceToChat } = useReferenceToChat();

  const handleAskAi = useCallback(async (request: InkBoardCropRequest) => {
    try {
      const artifact = await renderInkBoardSnapshot({
        document_id: request.documentId,
        expected_revision: request.revision,
        page_id: request.pageId,
        board: { crop: request.crop },
      });
      await referenceToChat({
        sourceType: 'image',
        sourceId: artifact.file_id,
        metadata: {
          title: `${request.documentId}-${request.pageId}-${artifact.render_id}.png`,
          mimeType: artifact.mime_type,
          width: artifact.width_px,
          height: artifact.height_px,
          revision: artifact.revision,
          immutableRevision: artifact.revision,
          renderId: artifact.render_id,
          crop: request.crop,
        },
      });
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
    }
  }, [referenceToChat]);

  const handleExport = useCallback(async (request: InkBoardExportRequest) => {
    try {
      const operationId = globalThis.crypto?.randomUUID?.()
        ?? `ink-board-export-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const artifact = await exportInkDocument({
        document_id: request.documentId,
        expected_revision: request.revision,
        page_ids: [request.pageId],
        format: request.format,
        operation_id: operationId,
        board: {
          region: request.crop,
          page_width: request.pageWidth,
          page_height: request.pageHeight,
          paginate: request.paginate,
        },
      });
      dispatchAppEvent(APP_EVENTS.LEARNING_HUB_OPEN_RESOURCE, { dstuPath: `/${artifact.file_id}` });
      return true;
    } catch (error: unknown) {
      showGlobalNotification('error', getErrorMessage(error));
      return false;
    }
  }, []);

  return (
    <Suspense fallback={
      <div className="flex h-full items-center justify-center gap-2" role="status">
        <CircleNotch size={20} className="animate-spin text-muted-foreground" aria-hidden />
        <span>{t('status.loading')}</span>
      </div>
    }>
      <InkBoardEditorHost
        {...props}
        onAskAi={onAskAiOverride ?? handleAskAi}
        onExport={onExportOverride ?? handleExport}
      />
    </Suspense>
  );
}
