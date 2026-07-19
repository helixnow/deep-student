/**
 * Chat V2 - BlockingInteractionBar
 *
 * 阻塞交互栏：当 LLM 被阻塞等待用户操作时，替换输入栏内容。
 * 根据 interaction.kind 分发到对应的子组件。
 */

import React from 'react';
import type { BlockingInteraction } from '../../core/types/store';
import { cn } from '@/lib/utils';
import { BlockingApprovalBar } from './BlockingApprovalBar';
import { BlockingAskUserBar } from './BlockingAskUserBar';
import { BlockingToolLimitBar } from './BlockingToolLimitBar';
import { PlanGateCard } from '../PlanGateCard';

interface BlockingInteractionBarProps {
  interaction: BlockingInteraction;
  sessionId: string;
  restoreFocusRef?: React.RefObject<HTMLElement | null>;
}

function renderContent(
  interaction: BlockingInteraction,
  sessionId: string,
  restoreFocusRef?: React.RefObject<HTMLElement | null>,
) {
  switch (interaction.kind) {
    case 'tool_approval':
      return <BlockingApprovalBar interaction={interaction} sessionId={sessionId} />;
    case 'ask_user':
      return <BlockingAskUserBar interaction={interaction} />;
    case 'tool_limit':
      return <BlockingToolLimitBar interaction={interaction} />;
    case 'plan_gate':
      return (
        <PlanGateCard
          sessionId={sessionId}
          request={{
            planId: interaction.planId,
            toolCallId: interaction.toolCallId,
            toolName: interaction.toolName,
            summary: interaction.summary,
            timeoutSeconds: interaction.timeoutSeconds,
            arguments: interaction.arguments,
          }}
          restoreFocusRef={restoreFocusRef}
        />
      );
    default:
      return null;
  }
}

export const BlockingInteractionBar: React.FC<BlockingInteractionBarProps> = React.memo(({ interaction, sessionId, restoreFocusRef }) => {
  return (
    <div className={cn(
      'ui-rise-in',
      'py-1'
    )}>
      {renderContent(interaction, sessionId, restoreFocusRef)}
    </div>
  );
});

BlockingInteractionBar.displayName = 'BlockingInteractionBar';
