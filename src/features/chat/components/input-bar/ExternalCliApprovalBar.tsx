/**
 * ExternalCliApprovalBar - 外部编程 CLI 工具调用 Composer 内联审批栏
 *
 * 在外部 CLI 线程处于待审批状态时展示于 Composer 壳体内部上方，
 * 使用原生 Composer 语义 Token 与 DsButton 原语。
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ShieldWarning, TerminalWindow } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import {
  agentMeshHost,
  resolveAgentDisplayName,
  type MeshApprovalDecision,
  type MeshPendingApproval,
  type MeshThreadState,
} from '@/features/agent-mesh';

export interface ExternalCliApprovalBarProps {
  thread: MeshThreadState;
  approval?: MeshPendingApproval | null;
  className?: string;
}

export const ExternalCliApprovalBar: React.FC<ExternalCliApprovalBarProps> = ({
  thread,
  approval,
  className,
}) => {
  const { t } = useTranslation(['agentMesh', 'common']);
  const [submitting, setSubmitting] = useState(false);

  const effectiveApproval = approval ?? thread.pendingApproval;
  const agentDisplayName = useMemo(
    () => resolveAgentDisplayName(thread.agentId, thread.agentName),
    [thread.agentId, thread.agentName],
  );

  const handleDecision = useCallback(
    async (decision: MeshApprovalDecision) => {
      if (!effectiveApproval || submitting) return;
      setSubmitting(true);
      try {
        await agentMeshHost.respondApproval({
          threadId: thread.threadId,
          requestId: effectiveApproval.requestId,
          decision,
        });
      } finally {
        setSubmitting(false);
      }
    },
    [effectiveApproval, submitting, thread.threadId],
  );

  if (!effectiveApproval) {
    return null;
  }

  const targetSnippet = effectiveApproval.command || effectiveApproval.targetPath;

  return (
    <div
      role="region"
      aria-label={t('agentMesh:approval.ariaLabel', {
        agent: agentDisplayName,
        defaultValue: `${agentDisplayName} 工具审批请求`,
      })}
      data-testid="external-cli-approval-bar"
      className={cn(
        'flex flex-col gap-2 rounded-xl border border-border/45 bg-muted/40 px-3 py-2.5 text-xs',
        className,
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <ShieldWarning size={14} weight="duotone" className="shrink-0 text-warning" aria-hidden="true" />
          <TerminalWindow size={13} weight="duotone" className="shrink-0 text-primary" aria-hidden="true" />
          <span className="truncate font-medium text-foreground">{agentDisplayName}</span>
          <span className="text-muted-foreground/60" aria-hidden="true">·</span>
          <span
            data-testid="external-cli-approval-tool"
            className="rounded border border-border/45 bg-background/60 px-1.5 py-0.5 font-mono text-2xs font-medium text-foreground"
          >
            {effectiveApproval.toolName}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <DsButton
            variant="primary"
            size="sm"
            disabled={submitting}
            data-testid="external-cli-approval-allow-once"
            onClick={() => void handleDecision('allow_once')}
            className="!h-7 !px-2.5 !text-xs"
          >
            {t('agentMesh:approval.allowOnce', { defaultValue: '允许一次' })}
          </DsButton>
          <DsButton
            variant="outline"
            size="sm"
            disabled={submitting}
            data-testid="external-cli-approval-allow-session"
            onClick={() => void handleDecision('allow_session')}
            className="!h-7 !px-2.5 !text-xs"
          >
            {t('agentMesh:approval.allowSession', { defaultValue: '本会话允许' })}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            disabled={submitting}
            data-testid="external-cli-approval-deny"
            onClick={() => void handleDecision('deny')}
            className="!h-7 !px-2.5 !text-xs text-muted-foreground hover:text-destructive"
          >
            {t('agentMesh:approval.deny', { defaultValue: '拒绝' })}
          </DsButton>
        </div>
      </div>

      {targetSnippet && (
        <div
          data-testid="external-cli-approval-target"
          className="overflow-x-auto rounded-md border border-border/35 bg-background/60 px-2 py-1 font-mono text-2xs text-foreground/90"
        >
          {targetSnippet}
        </div>
      )}

      {effectiveApproval.reason && (
        <div
          data-testid="external-cli-approval-reason"
          className="text-2xs leading-relaxed text-muted-foreground"
        >
          {effectiveApproval.reason}
        </div>
      )}
    </div>
  );
};

ExternalCliApprovalBar.displayName = 'ExternalCliApprovalBar';

export default ExternalCliApprovalBar;
