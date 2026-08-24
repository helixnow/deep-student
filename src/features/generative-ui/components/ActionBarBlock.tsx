import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import type { ActionBarProps } from '../schema';
import type { GenerativeActionDefinition, GenerativeUIAction, RiskLevel } from '../types';
import { resolveEffectiveRiskLevel } from '../actions';

export interface ActionBarBlockProps extends ActionBarProps {
  actionHandlers?: Record<string, GenerativeActionDefinition>;
  onAction?: (action: GenerativeUIAction) => void;
}

function trustedLabel(
  actionId: string,
  modelLabel: string,
  actionHandlers?: Record<string, GenerativeActionDefinition>,
): string {
  return actionHandlers?.[actionId]?.label ?? modelLabel;
}

export function ActionBarBlock({ actions, actionHandlers, onAction }: ActionBarBlockProps) {
  const { t } = useTranslation('generativeUi');
  const [pendingMediumId, setPendingMediumId] = useState<string | null>(null);
  const [dialogActionId, setDialogActionId] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const executingRef = useRef(false);
  const enforceHandlerRegistry = actionHandlers != null;

  const runAction = useCallback(
    async (actionId: string) => {
      if (executingRef.current) return;
      if (enforceHandlerRegistry && !actionHandlers?.[actionId]) return;
      executingRef.current = true;
      setExecuting(true);
      try {
        const handler = actionHandlers?.[actionId];
        if (handler) {
          await handler.handler();
          onAction?.({ type: 'execute', actionId });
        }
      } finally {
        executingRef.current = false;
        setExecuting(false);
        setPendingMediumId(null);
        setDialogActionId(null);
      }
    },
    [actionHandlers, enforceHandlerRegistry, onAction],
  );

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

  return (
    <>
      <div className="flex flex-wrap gap-2">
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
          return (
            <DsButton
              key={action.id}
              variant={variant}
              size="sm"
              disabled={executing || !isRegistered}
              title={!isRegistered ? t('action.unregistered_hint') : undefined}
              onClick={() => handleClick(action.id, effectiveRisk)}
            >
              {isConfirmingMedium
                ? t('action.confirm_inline', { label: displayLabel })
                : action.label}
            </DsButton>
          );
        })}
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
