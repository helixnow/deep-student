import React, { useCallback, useState } from 'react';
import { DsButton } from '@/components/ui/DsButton';
import type { ActionBarProps } from '../schema';
import type { GenerativeActionDefinition, GenerativeUIAction } from '../types';

export interface ActionBarBlockProps extends ActionBarProps {
  actionHandlers?: Record<string, GenerativeActionDefinition>;
  onAction?: (action: GenerativeUIAction) => void;
}

export function ActionBarBlock({ actions, actionHandlers, onAction }: ActionBarBlockProps) {
  const [pendingConfirm, setPendingConfirm] = useState<string | null>(null);

  const handleClick = useCallback(
    async (actionId: string, riskLevel: 'low' | 'medium' | 'high') => {
      if (riskLevel === 'high' && pendingConfirm !== actionId) {
        setPendingConfirm(actionId);
        return;
      }
      setPendingConfirm(null);
      onAction?.({ type: 'execute', actionId });
      const handler = actionHandlers?.[actionId];
      if (handler) {
        await handler.handler();
      }
    },
    [actionHandlers, onAction, pendingConfirm],
  );

  return (
    <div className="flex flex-wrap gap-2">
      {actions.map((action) => {
        const isConfirming = pendingConfirm === action.id;
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
            onClick={() => handleClick(action.id, action.riskLevel ?? 'low')}
          >
            {isConfirming ? `确认：${action.label}` : action.label}
          </DsButton>
        );
      })}
    </div>
  );
}
