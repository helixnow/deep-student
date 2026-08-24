import React, { useCallback, useRef, useState } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import type { ActionBarProps } from '../schema';
import type { GenerativeActionDefinition, GenerativeUIAction, RiskLevel } from '../types';
import { resolveEffectiveRiskLevel } from '../actions';

export interface ActionBarBlockProps extends ActionBarProps {
  actionHandlers?: Record<string, GenerativeActionDefinition>;
  onAction?: (action: GenerativeUIAction) => void;
}

export function ActionBarBlock({ actions, actionHandlers, onAction }: ActionBarBlockProps) {
  const [pendingMediumId, setPendingMediumId] = useState<string | null>(null);
  const [dialogActionId, setDialogActionId] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const executingRef = useRef(false);

  const runAction = useCallback(
    async (actionId: string) => {
      if (executingRef.current) return;
      executingRef.current = true;
      setExecuting(true);
      try {
        onAction?.({ type: 'execute', actionId });
        const handler = actionHandlers?.[actionId];
        if (handler) {
          await handler.handler();
        }
      } finally {
        executingRef.current = false;
        setExecuting(false);
        setPendingMediumId(null);
        setDialogActionId(null);
      }
    },
    [actionHandlers, onAction],
  );

  const handleClick = useCallback(
    (actionId: string, label: string, effectiveRisk: RiskLevel) => {
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
    [pendingMediumId, runAction],
  );

  const dialogAction = dialogActionId
    ? actions.find((a) => a.id === dialogActionId)
    : undefined;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const handlerRisk = actionHandlers?.[action.id]?.riskLevel;
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
              disabled={executing}
              onClick={() => handleClick(action.id, action.label, effectiveRisk)}
            >
              {isConfirmingMedium ? `确认：${action.label}` : action.label}
            </DsButton>
          );
        })}
      </div>

      <DsAlertDialog
        open={dialogActionId != null}
        onOpenChange={(open) => {
          if (!open) setDialogActionId(null);
        }}
        title={dialogAction ? `确认：${dialogAction.label}` : '确认操作'}
        description="此操作可能产生不可逆影响，请确认后继续。"
        confirmText="确认执行"
        loading={executing}
        disabled={executing}
        onConfirm={() => {
          if (dialogActionId) void runAction(dialogActionId);
        }}
      />
    </>
  );
}
