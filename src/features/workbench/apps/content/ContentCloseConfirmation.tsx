import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WarningCircle } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsAlertDialog } from '@/components/ui/DsDialog';

export interface ContentCloseConfirmationRequest {
  description: string;
}

type ConfirmationHandler = (request: ContentCloseConfirmationRequest) => Promise<boolean>;

let confirmationHandler: ConfirmationHandler | null = null;

/**
 * Lets synchronous window-shell callers await the Workbench-owned alert dialog.
 * Returning false without a mounted host is intentional: losing edits is never
 * an acceptable fallback when the desktop UI is unavailable.
 */
export function requestContentCloseConfirmation(
  request: ContentCloseConfirmationRequest,
): Promise<boolean> {
  return confirmationHandler?.(request) ?? Promise.resolve(false);
}

export function registerContentCloseConfirmationHandler(
  handler: ConfirmationHandler,
): () => void {
  const previous = confirmationHandler;
  confirmationHandler = handler;
  return () => {
    if (confirmationHandler === handler) confirmationHandler = previous;
  };
}

interface PendingConfirmation {
  request: ContentCloseConfirmationRequest;
  resolve: (confirmed: boolean) => void;
}

/** Mounted once by WorkbenchDesktop so content apps never need native dialogs. */
export const ContentCloseConfirmationHost: React.FC = () => {
  const { t } = useTranslation('workbench');
  const queueRef = useRef<PendingConfirmation[]>([]);
  const activeRef = useRef<PendingConfirmation | null>(null);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);

  const showNext = useCallback(() => {
    if (activeRef.current) return;
    const next = queueRef.current.shift() ?? null;
    if (!next) return;
    activeRef.current = next;
    setPending(next);
  }, []);

  const requestConfirmation = useCallback((request: ContentCloseConfirmationRequest) => (
    new Promise<boolean>((resolve) => {
      queueRef.current.push({ request, resolve });
      showNext();
    })
  ), [showNext]);

  const settle = useCallback((confirmed: boolean) => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    setPending(null);
    active.resolve(confirmed);
    void Promise.resolve().then(showNext);
  }, [showNext]);

  useEffect(() => registerContentCloseConfirmationHandler(requestConfirmation), [requestConfirmation]);

  useEffect(() => () => {
    activeRef.current?.resolve(false);
    activeRef.current = null;
    for (const queued of queueRef.current) queued.resolve(false);
    queueRef.current = [];
  }, []);

  return (
    <DsAlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settle(false);
      }}
      icon={<WarningCircle size={20} className="text-warning" />}
      title={t('content.unsavedTitle')}
      description={pending?.request.description}
      confirmText={t('resourceWorkspace.discard')}
      cancelText={t('resourceWorkspace.cancel')}
      confirmVariant="danger"
      onConfirm={() => settle(true)}
    />
  );
};
