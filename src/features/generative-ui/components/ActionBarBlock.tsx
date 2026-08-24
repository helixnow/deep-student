import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import type { ActionBarProps } from '../schema';
import type { GenerativeActionDefinition, GenerativeUIAction, RiskLevel } from '../types';
import { resolveEffectiveRiskLevel } from '../actions';
import {
  getDefaultGenerativeActionUndoStack,
  resolveGenerativeActionUndo,
  type GenerativeActionUndoStack,
} from '../handlers/actionUndoStack';

export interface ActionBarBlockProps extends ActionBarProps {
  actionHandlers?: Record<string, GenerativeActionDefinition>;
  onAction?: (action: GenerativeUIAction) => void;
  /** 可注入撤销栈；默认模块单例。不改变 HITL risk 确认行为。 */
  undoStack?: GenerativeActionUndoStack;
}

const UNDO_TOOLBAR_ID = '__generative-undo__';

function trustedLabel(
  actionId: string,
  modelLabel: string,
  actionHandlers?: Record<string, GenerativeActionDefinition>,
): string {
  return actionHandlers?.[actionId]?.label ?? modelLabel;
}

export function ActionBarBlock({
  actions,
  actionHandlers,
  onAction,
  undoStack = getDefaultGenerativeActionUndoStack(),
}: ActionBarBlockProps) {
  const { t } = useTranslation('generativeUi');
  const [pendingMediumId, setPendingMediumId] = useState<string | null>(null);
  const [dialogActionId, setDialogActionId] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [showUndoControl, setShowUndoControl] = useState(() => undoStack.canUndo());
  const [undoAvailable, setUndoAvailable] = useState(() => undoStack.canUndo());
  const executingRef = useRef(false);
  const itemRefs = useRef(new Map<string, HTMLButtonElement | null>());
  const [tabStopId, setTabStopId] = useState<string | null>(null);
  const enforceHandlerRegistry = actionHandlers != null;

  const focusableItemIds = useMemo(() => {
    if (executing) return [];
    const ids: string[] = [];
    for (const action of actions) {
      const registered = !enforceHandlerRegistry || actionHandlers?.[action.id] != null;
      if (registered) ids.push(action.id);
    }
    if (showUndoControl && undoAvailable) ids.push(UNDO_TOOLBAR_ID);
    return ids;
  }, [
    actionHandlers,
    actions,
    enforceHandlerRegistry,
    executing,
    showUndoControl,
    undoAvailable,
  ]);

  const resolvedTabStop =
    tabStopId && focusableItemIds.includes(tabStopId)
      ? tabStopId
      : (focusableItemIds[0] ?? null);

  const setItemRef = useCallback(
    (id: string) => (el: HTMLButtonElement | null) => {
      if (el) itemRefs.current.set(id, el);
      else itemRefs.current.delete(id);
    },
    [],
  );

  const cancelPendingConfirmation = useCallback(() => {
    setPendingMediumId(null);
    setDialogActionId(null);
  }, []);

  const handleToolbarKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        if (pendingMediumId == null && dialogActionId == null) return;
        event.preventDefault();
        event.stopPropagation();
        cancelPendingConfirmation();
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      if (focusableItemIds.length === 0) return;
      event.preventDefault();
      const currentIndex = resolvedTabStop
        ? focusableItemIds.indexOf(resolvedTabStop)
        : 0;
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const nextIndex =
        currentIndex < 0
          ? 0
          : (currentIndex + delta + focusableItemIds.length) % focusableItemIds.length;
      const nextId = focusableItemIds[nextIndex];
      setTabStopId(nextId);
      itemRefs.current.get(nextId)?.focus();
    },
    [
      cancelPendingConfirmation,
      dialogActionId,
      focusableItemIds,
      pendingMediumId,
      resolvedTabStop,
    ],
  );

  const runAction = useCallback(
    async (actionId: string) => {
      if (executingRef.current) return;
      if (enforceHandlerRegistry && !actionHandlers?.[actionId]) return;
      executingRef.current = true;
      setExecuting(true);
      try {
        const handler = actionHandlers?.[actionId];
        if (handler) {
          const result = await handler.handler();
          const undoFn = resolveGenerativeActionUndo(handler, result);
          if (undoFn) {
            undoStack.push({
              actionId,
              riskLevel: handler.riskLevel,
              undo: undoFn,
            });
            setShowUndoControl(true);
            setUndoAvailable(undoStack.canUndo());
          }
          onAction?.({ type: 'execute', actionId });
        }
      } finally {
        executingRef.current = false;
        setExecuting(false);
        setPendingMediumId(null);
        setDialogActionId(null);
      }
    },
    [actionHandlers, enforceHandlerRegistry, onAction, undoStack],
  );

  const runUndo = useCallback(async () => {
    if (executingRef.current || !undoStack.canUndo()) return;
    executingRef.current = true;
    setExecuting(true);
    try {
      await undoStack.undo();
    } finally {
      executingRef.current = false;
      setExecuting(false);
      setUndoAvailable(undoStack.canUndo());
    }
  }, [undoStack]);

  const handleClick = useCallback(
    (actionId: string, effectiveRisk: RiskLevel) => {
      if (enforceHandlerRegistry && !actionHandlers?.[actionId]) return;
      if (effectiveRisk === 'high') {
        setDialogActionId(actionId);
        return;
      }
      if (effectiveRisk === 'medium') {
        if (pendingMediumId !== actionId) {
          setPendingMediumId(actionId);
          return;
        }
        void runAction(actionId);
        return;
      }
      void runAction(actionId);
    },
    [actionHandlers, enforceHandlerRegistry, pendingMediumId, runAction],
  );

  const dialogAction = dialogActionId
    ? actions.find((a) => a.id === dialogActionId)
    : undefined;
  const dialogTrustedLabel = dialogActionId
    ? trustedLabel(dialogActionId, dialogAction?.label ?? '', actionHandlers)
    : '';
  const lastTriggerRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (dialogActionId == null) return;
    lastTriggerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const dialog = document.querySelector('[role="alertdialog"]');
      if (!(dialog instanceof HTMLElement)) return;
      const buttons = dialog.querySelectorAll('button');
      const confirm = buttons[buttons.length - 1];
      if (confirm instanceof HTMLElement) {
        confirm.focus();
        return;
      }
      dialog.setAttribute('tabindex', '-1');
      dialog.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      lastTriggerRef.current?.focus?.();
    };
  }, [dialogActionId]);

  useEffect(() => {
    if (pendingMediumId == null && dialogActionId == null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      cancelPendingConfirmation();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [cancelPendingConfirmation, dialogActionId, pendingMediumId]);

  return (
    <>
      <div
        className="flex flex-wrap gap-2"
        role="toolbar"
        aria-label={t('a11y.action_bar_label')}
        aria-busy={executing || undefined}
        onKeyDown={handleToolbarKeyDown}
      >
        {actions.map((action) => {
          const handlerDef = actionHandlers?.[action.id];
          const isRegistered = !enforceHandlerRegistry || handlerDef != null;
          const displayLabel = trustedLabel(action.id, action.label, actionHandlers);
          const handlerRisk = handlerDef?.riskLevel;
          const effectiveRisk = resolveEffectiveRiskLevel(action.riskLevel, handlerRisk);
          const isConfirmingMedium = pendingMediumId === action.id;
          const variant =
            action.variant === 'destructive'
              ? 'destructive'
              : action.variant === 'primary'
                ? 'default'
                : 'outline';
          const itemEnabled = !executing && isRegistered;
          return (
            <DsButton
              key={action.id}
              ref={setItemRef(action.id)}
              variant={variant}
              size="sm"
              disabled={!itemEnabled}
              tabIndex={itemEnabled && resolvedTabStop === action.id ? 0 : -1}
              title={!isRegistered ? t('action.unregistered_hint') : undefined}
              onFocus={() => {
                if (itemEnabled) setTabStopId(action.id);
              }}
              onClick={() => handleClick(action.id, effectiveRisk)}
            >
              {isConfirmingMedium
                ? t('action.confirm_inline', { label: displayLabel })
                : action.label}
            </DsButton>
          );
        })}
        {showUndoControl ? (
          <DsButton
            ref={setItemRef(UNDO_TOOLBAR_ID)}
            variant="outline"
            size="sm"
            disabled={executing || !undoAvailable}
            tabIndex={
              !executing && undoAvailable && resolvedTabStop === UNDO_TOOLBAR_ID ? 0 : -1
            }
            aria-label={t('action.undo')}
            title={undoAvailable ? t('action.undo') : t('action.undo_empty')}
            onFocus={() => {
              if (!executing && undoAvailable) setTabStopId(UNDO_TOOLBAR_ID);
            }}
            onClick={() => {
              void runUndo();
            }}
          >
            {t('action.undo')}
          </DsButton>
        ) : null}
      </div>

      <DsAlertDialog
        open={dialogActionId != null}
        onOpenChange={(open) => {
          if (!open) setDialogActionId(null);
        }}
        title={
          dialogActionId
            ? t('action.confirm_title', { label: dialogTrustedLabel })
            : t('action.confirm_execute')
        }
        description={t('action.confirm_desc')}
        confirmText={t('action.confirm_execute')}
        loading={executing}
        disabled={executing}
        onConfirm={() => {
          if (dialogActionId) void runAction(dialogActionId);
        }}
      />
    </>
  );
}
