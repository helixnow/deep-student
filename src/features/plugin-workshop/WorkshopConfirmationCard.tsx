// RUST-FIX(RF-P4-plugin-workshop-ui): explicit workshop capability/trust/version confirmation.
import React from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { Badge } from '@/components/ui/shad/Badge';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/shad/Card';
import { actionLabels, fullTrustNotice, phaseLabels } from './copy';
import { workshopActions, type WorkshopAction, type WorkshopItem } from './types';

export interface WorkshopConfirmationCardProps {
  item: WorkshopItem;
  busy?: boolean;
  error?: string;
  /** True when mounted inside an outer chat tool card (`mcpTool` output slot) to avoid nested card borders. */
  embedded?: boolean;
  onAction: (action: WorkshopAction) => void;
}

export function WorkshopConfirmationCard({ item, busy, error, embedded = false, onAction }: WorkshopConfirmationCardProps) {
  const actions = workshopActions(item.phase).filter(action => action === 'confirm' || action === 'cancel');
  const titleText = `${item.name} · ${item.version}`;
  const badges = (
    <div className="flex flex-wrap gap-2">
      <Badge variant="secondary">{phaseLabels[item.phase]}</Badge>
      <Badge variant="outline">{item.trust === 'full' ? '完全信任' : '受限'}</Badge>
    </div>
  );
  const body = (
    <>
      {item.description && <p className="break-words">{item.description}</p>}
      <p className="text-muted-foreground">{item.trust === 'full' ? fullTrustNotice : '受限插件依照已同意的能力运行；仍与应用在同一进程，并非隔离环境。'}</p>
      <div><h4 className="font-medium">要用的能力</h4>
        {item.capabilities.length ? <ul className="list-inside list-disc break-words">{item.capabilities.map(capability => <li key={capability}>{capability}</li>)}</ul> : <p className="text-muted-foreground">未声明额外服务能力</p>}
      </div>
      <div><h4 className="font-medium">{item.previousVersion ? `相对 ${item.previousVersion} 的变化` : '本次创建内容'}</h4>
        {item.changes.length ? <ul className="list-inside list-disc break-words">{item.changes.map((change, index) => <li key={index}>{change}</li>)}</ul> : <p className="text-muted-foreground">未提供变化说明</p>}
      </div>
      <div role="status" aria-live="polite" className="space-y-1 break-words">
        {item.progress && <p>{item.progress}</p>}
        {item.phase === 'installing' && <p>安装已接纳，请等待结果。</p>}
        {item.phase === 'failed' && <p className="text-destructive">{item.error || '创建/安装失败'}</p>}
        {item.phase === 'disabled' && item.error && <p className="text-destructive">{item.error}</p>}
        {item.rollback === 'restored' && <p>已回到上一个可用版本。此恢复不撤回插件已写入的业务数据。</p>}
        {item.rollback === 'failed' && <p className="text-destructive">恢复上一个版本失败，请在插件管理中检查状态。</p>}
        {!item.visualVerified && <p className="text-muted-foreground">视觉未验证</p>}
        {item.phase === 'cancelled' && <p>已取消生成。</p>}
      </div>
      {error && <p role="alert" className="break-words text-destructive">{error}</p>}
    </>
  );
  const actionButtons = actions.map(action => (
    <DsButton
      key={action}
      size="sm"
      variant={action === 'confirm' ? 'primary' : 'outline'}
      disabled={busy}
      className="[@media(pointer:coarse)]:!min-h-11"
      onClick={() => onAction(action)}
    >
      {actionLabels[action]}
    </DsButton>
  ));

  if (embedded) {
    return (
      <div className="min-w-0 space-y-3" aria-label="插件工坊确认">
        <div className="space-y-2">
          <h3 className="font-semibold leading-none tracking-tight break-words text-sm">{titleText}</h3>
          {badges}
        </div>
        <div className="space-y-3 text-sm">{body}</div>
        {actions.length > 0 && <div className="flex flex-wrap gap-2">{actionButtons}</div>}
      </div>
    );
  }

  return <Card className="min-w-0 shadow-none" aria-label="插件工坊确认">
    <CardHeader className="space-y-2">
      <CardTitle className="break-words text-sm">{titleText}</CardTitle>
      {badges}
    </CardHeader>
    <CardContent className="space-y-3 text-sm">{body}</CardContent>
    {actions.length > 0 && <CardFooter className="flex flex-wrap gap-2">{actionButtons}</CardFooter>}
  </Card>;
}
