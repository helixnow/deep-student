import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { useTranslation } from 'react-i18next';
import { ArrowSquareOut, ArrowCounterClockwise, WarningCircle } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import type { BlockComponentProps } from '../../registry';

interface InkPageOutput {
  pageId: string;
  artifactId?: string;
  resourceId?: string;
  fileId?: string;
}

interface InkToolOutput {
  status?: string;
  documentId?: string;
  revision?: string;
  operationId?: string;
  undoAvailable?: boolean;
  affectedPageIds?: string[];
  pages?: InkPageOutput[];
  error?: { code?: string; message?: string; hint?: string };
}

function parseInkOutput(value: unknown): InkToolOutput | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const result = data.result && typeof data.result === 'object' && !Array.isArray(data.result)
    ? data.result as Record<string, unknown>
    : data;
  const nestedError = result.error && typeof result.error === 'object' && !Array.isArray(result.error)
    ? result.error as Record<string, unknown>
    : undefined;
  const errorValue = nestedError ?? (
    typeof result.code === 'string' || typeof result.message === 'string' ? result : undefined
  );
  const documentId = typeof result.document_id === 'string' ? result.document_id : result.documentId;
  const revision = typeof result.revision === 'string' ? result.revision : undefined;
  const isUndoReceipt = typeof documentId === 'string'
    && typeof revision === 'string'
    && result.undo_available === true
    && Array.isArray(result.affected_page_ids)
    && result.affected_page_ids.every((pageId) => typeof pageId === 'string');
  if (!Array.isArray(result.pages) && !errorValue && !isUndoReceipt) return null;
  const pages = (Array.isArray(result.pages) ? result.pages : []).flatMap((raw): InkPageOutput[] => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const page = raw as Record<string, unknown>;
    const artifact = page.artifact && typeof page.artifact === 'object' && !Array.isArray(page.artifact)
      ? page.artifact as Record<string, unknown>
      : {};
    const artifactId = typeof page.artifact_id === 'string'
      ? page.artifact_id
      : typeof page.artifactId === 'string' ? page.artifactId
      : typeof artifact.artifact_id === 'string' ? artifact.artifact_id
      : typeof artifact.artifactId === 'string' ? artifact.artifactId : undefined;
    const resourceId = typeof page.resource_id === 'string' ? page.resource_id
      : typeof page.resourceId === 'string' ? page.resourceId
      : typeof artifact.resource_id === 'string' ? artifact.resource_id
      : typeof artifact.resourceId === 'string' ? artifact.resourceId : undefined;
    const pageId = typeof page.page_id === 'string' ? page.page_id : page.pageId;
    const fileId = typeof page.file_id === 'string' ? page.file_id
      : typeof page.fileId === 'string' ? page.fileId
      : typeof artifact.file_id === 'string' ? artifact.file_id
      : typeof artifact.fileId === 'string' ? artifact.fileId : undefined;
    if (typeof pageId !== 'string') return [];
    return [{
      pageId,
      ...(typeof artifactId === 'string' ? { artifactId } : {}),
      ...(typeof resourceId === 'string' ? { resourceId } : {}),
      ...(typeof fileId === 'string' ? { fileId } : {}),
    }];
  });
  return {
    status: typeof result.status === 'string' ? result.status : undefined,
    documentId: typeof documentId === 'string' ? documentId : undefined,
    revision,
    operationId: typeof result.operation_id === 'string' ? result.operation_id
      : typeof result.operationId === 'string' ? result.operationId : undefined,
    undoAvailable: result.undo_available === true,
    affectedPageIds: Array.isArray(result.affected_page_ids)
      ? result.affected_page_ids.filter((pageId): pageId is string => typeof pageId === 'string')
      : undefined,
    pages,
    error: errorValue ? {
      code: typeof errorValue.code === 'string' ? errorValue.code : undefined,
      message: typeof errorValue.message === 'string' ? errorValue.message : undefined,
      hint: typeof errorValue.hint === 'string' ? errorValue.hint : undefined,
    } : undefined,
  };
}

export const InkToolOutputCard: React.FC<BlockComponentProps> = ({ block, store }) => {
  const { t } = useTranslation('chatV2');
  const [undoing, setUndoing] = useState(false);
  const [undoError, setUndoError] = useState<string | null>(null);
  const output = parseInkOutput(block.toolOutput);
  const sessionId = store?.getState().sessionId;
  const pages = output?.pages?.map((page) => {
    const ref = block.inkArtifacts?.find((artifact) => artifact.pageId === page.pageId);
    return {
      ...page,
      artifactId: page.artifactId ?? ref?.artifactId,
      resourceId: page.resourceId ?? ref?.resourceId,
      fileId: page.fileId,
    };
  }) ?? [];

  const undo = async () => {
    if (!sessionId || !block.messageId || !output?.documentId || !output.undoAvailable || !output.operationId) return;
    setUndoing(true);
    setUndoError(null);
    try {
      const currentManifest = await invoke<{ revision: string }>('vfs_ink_get', {
        request: { document_id: output.documentId },
      });
      await invoke('vfs_ink_undo_tool_operation', {
        sessionId,
        messageId: block.messageId,
        blockId: block.id,
        expectedRevision: currentManifest.revision,
        operationId: crypto.randomUUID(),
      });
    } catch {
      setUndoError(t('blocks.ink.undoFailed'));
    } finally {
      setUndoing(false);
    }
  };

  return (
    <section className="rounded-lg border border-border/50 bg-card p-3" data-testid="ink-tool-output-card">
      <h4 className="text-sm font-medium">{t('blocks.ink.title')}</h4>
      {output ? (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <p><span>{t('blocks.ink.document')}: </span><span data-testid="ink-document-id">{output.documentId}</span></p>
            {output.documentId && /^[A-Za-z0-9_-]{1,128}$/.test(output.documentId) && (
              <DsButton variant="outline" size="sm" onClick={() => window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
                detail: { id: output.documentId, type: 'file', title: output.documentId },
              }))}>
                <ArrowSquareOut size={14} />{t('blocks.ink.openDocument')}
              </DsButton>
            )}
          </div>
          {output.revision && <p>{t('blocks.ink.revision')}: <span data-testid="ink-revision">{output.revision}</span></p>}
          {pages.map((page) => (
            <div key={page.pageId} className="flex flex-wrap items-center gap-2 rounded border border-border/40 p-2">
              <span>{t('blocks.ink.page')}: <span data-testid="ink-page-id">{page.pageId}</span></span>
              {page.artifactId && <span>{t('blocks.ink.artifact')}: {page.artifactId}</span>}
              {page.fileId && <span>{t('blocks.ink.resource')}: <span data-testid="ink-artifact-resource">{page.fileId}</span></span>}
              {page.fileId && /^[A-Za-z0-9_-]{1,128}$/.test(page.fileId) && (
                <DsButton variant="outline" size="sm" onClick={() => window.dispatchEvent(new CustomEvent('CHAT_OPEN_ATTACHMENT_PREVIEW', {
                  detail: { id: page.fileId, type: 'file', title: page.artifactId ?? output.documentId ?? t('blocks.ink.title') },
                }))}>
                  <ArrowSquareOut size={14} />{t('blocks.ink.openArtifact')}
                </DsButton>
              )}
            </div>
          ))}
          {output.error && (
            <div role="alert" className="flex items-start gap-2 text-destructive">
              <WarningCircle size={16} />
              <div>
                {output.error.code && <p data-testid="ink-error-code">{output.error.code}</p>}
                {output.error.message && <p data-testid="ink-error-message">{output.error.message}</p>}
                {output.error.hint && <p data-testid="ink-error-hint">{output.error.hint}</p>}
              </div>
            </div>
          )}
          {output.undoAvailable && output.status === 'committed' && output.operationId && output.revision && output.documentId && output.affectedPageIds?.length && (
            <DsButton variant="outline" size="sm" disabled={undoing || !sessionId || !block.messageId} onClick={() => void undo()}>
              <ArrowCounterClockwise size={14} />{undoing ? t('blocks.ink.undoing') : t('blocks.ink.undo')}
            </DsButton>
          )}
        </div>
      ) : (
        <p role="alert" className="mt-2 text-sm text-muted-foreground">
          {block.error || t('blocks.ink.invalidOutput')}
        </p>
      )}
      {undoError && <p role="alert" className="mt-2 text-sm text-destructive">{undoError}</p>}
    </section>
  );
};
