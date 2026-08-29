import React, { useCallback, useEffect, useRef, useState } from 'react';
import { WarningCircle } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';
import { DsAlertDialog } from '@/components/ui/DsDialog';

export interface ContentCloseConfirmationRequest {
  description: string;
  /**
   * 提供「保存并关闭」选项。仅当调用方能真正执行保存
   * （registerContentSaveHandler 已注册）时才传 true。
   */
  offerSave?: boolean;
}

/** 关窗确认的三态结果：保存并关闭 / 丢弃并关闭 / 取消关闭 */
export type ContentCloseDecision = 'save' | 'discard' | 'cancel';

/**
 * 处理函数兼容两种返回：布尔（旧协议：true=丢弃关闭 / false=取消）
 * 或三态 decision（新协议，支持「保存并关闭」）。
 */
type ConfirmationHandler = (
  request: ContentCloseConfirmationRequest,
) => Promise<boolean | ContentCloseDecision>;

let confirmationHandler: ConfirmationHandler | null = null;

function normalizeDecision(result: boolean | ContentCloseDecision): ContentCloseDecision {
  if (result === true) return 'discard';
  if (result === false) return 'cancel';
  return result;
}

/**
 * 三态版本：返回用户的关窗决定（保存 / 丢弃 / 取消）。
 * Returning 'cancel' without a mounted host is intentional: losing edits is
 * never an acceptable fallback when the desktop UI is unavailable.
 */
export async function requestContentCloseDecision(
  request: ContentCloseConfirmationRequest,
): Promise<ContentCloseDecision> {
  if (!confirmationHandler) return 'cancel';
  return normalizeDecision(await confirmationHandler(request));
}

/**
 * Lets synchronous window-shell callers await the Workbench-owned alert dialog.
 * 布尔兼容版本：true = 丢弃并关闭。不提供保存选项的调用方继续使用本函数。
 */
export async function requestContentCloseConfirmation(
  request: ContentCloseConfirmationRequest,
): Promise<boolean> {
  return (await requestContentCloseDecision(request)) === 'discard';
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
  resolve: (decision: ContentCloseDecision) => void;
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
    new Promise<ContentCloseDecision>((resolve) => {
      queueRef.current.push({ request, resolve });
      showNext();
    })
  ), [showNext]);

  const settle = useCallback((decision: ContentCloseDecision) => {
    const active = activeRef.current;
    if (!active) return;
    activeRef.current = null;
    setPending(null);
    active.resolve(decision);
    void Promise.resolve().then(showNext);
  }, [showNext]);

  useEffect(() => registerContentCloseConfirmationHandler(requestConfirmation), [requestConfirmation]);

  useEffect(() => () => {
    activeRef.current?.resolve('cancel');
    activeRef.current = null;
    for (const queued of queueRef.current) queued.resolve('cancel');
    queueRef.current = [];
  }, []);

  return (
    <DsAlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) settle('cancel');
      }}
      icon={<WarningCircle size={20} className="text-warning" />}
      title={t('content.unsavedTitle')}
      description={pending?.request.description}
      confirmText={t('resourceWorkspace.discard')}
      cancelText={t('resourceWorkspace.cancel')}
      confirmVariant="danger"
      onConfirm={() => settle('discard')}
      secondaryText={pending?.request.offerSave ? t('content.saveAndClose') : undefined}
      secondaryVariant="primary"
      onSecondary={() => settle('save')}
    />
  );
};
