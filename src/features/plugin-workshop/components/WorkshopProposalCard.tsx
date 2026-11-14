import React from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { WorkshopConfirmationCard, type WorkshopConfirmationCardProps } from '../WorkshopConfirmationCard';
import { actionLabels } from '../copy';
import { workshopActions } from '../types';

export interface WorkshopProposalCardProps extends WorkshopConfirmationCardProps {
  /** Opens the paired workshop session; never silently resubmits an installation. */
  onRepair: () => void;
  exportPath?: string;
}

export function WorkshopProposalCard({ onRepair, exportPath, ...props }: WorkshopProposalCardProps) {
  const { item, busy, embedded, onAction } = props;
  const recovered = item.rollback === 'restored' || item.rollback === 'not-needed';
  const postInstallActions = embedded ? workshopActions(item.phase).filter(action => action !== 'confirm') : [];
  const showInlineManageBar = Boolean(embedded && ['installed', 'disabled', 'undone'].includes(item.phase));
  return <div className="space-y-2.5">
    <WorkshopConfirmationCard {...props} />
    {item.phase === 'installed' && <p role="status" className="text-sm text-success">
      已生效（支持立即使用，重启应用后同样自动加载）
    </p>}
    {showInlineManageBar && (
      <div className="flex flex-wrap items-center gap-2 pt-0.5">
        {postInstallActions.map(action => (
          <DsButton
            key={action}
            size="sm"
            variant={action === 'try' || action === 'restore' ? 'primary' : 'outline'}
            disabled={busy}
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={() => onAction(action)}
          >
            {actionLabels[action]}
          </DsButton>
        ))}
        <DsButton
          size="sm"
          variant="ghost"
          disabled={busy}
          className="[@media(pointer:coarse)]:!min-h-11"
          onClick={onRepair}
        >
          让 AI 修改
        </DsButton>
      </div>
    )}
    {exportPath && <p role="status" className="break-all text-xs text-muted-foreground">已导出：{exportPath}</p>}
    {item.phase === 'failed' && <div className="space-y-2 text-sm">
      <p role="status" className={recovered ? 'text-muted-foreground' : 'text-destructive'}>
        {recovered ? '已自动回退至安全状态' : '插件未生效，尚未确认安全回退，请检查插件状态'}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <DsButton size="sm" variant="outline" disabled={busy} className="[@media(pointer:coarse)]:!min-h-11" onClick={onRepair}>让 AI 继续修复</DsButton>
        {item.previousVersion && item.rollback !== 'restored' && (
          <DsButton size="sm" variant="outline" disabled={busy} className="[@media(pointer:coarse)]:!min-h-11" onClick={() => onAction('restore')}>
            恢复上一版本 ({item.previousVersion})
          </DsButton>
        )}
      </div>
    </div>}
  </div>;
}
